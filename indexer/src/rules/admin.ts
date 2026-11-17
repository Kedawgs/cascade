import { encodeFunctionData, formatUnits, type Hex, keccak256 } from "viem";
import { ADMIN_EVENTS, EXECUTE_WINDOW_S, instrumentOf, limitSetterOf, MAX_HOTKEYS, SCHEDULABLE, SCHEDULER_EVENTS } from "../abi.ts";
import type { Finding } from "../alerts.ts";
import type { ChainName, Role } from "../config.ts";
import type { StoredLog } from "../logs.ts";
import {
  directionOf,
  decodeItem,
  formatArg,
  isEffectOf,
  ITEMS_KEY,
  itemStatus,
  kindName,
  lastWindowBlock,
  MAX_FINISHED_ITEMS,
  MAX_LIVE_ITEMS,
  MAX_REFUSED_ITEMS,
  parseItems,
  parseRefused,
  pastBothWindows,
  REFUSED_KEY,
  type Refused,
  type SchedulerRole,
  type TrackedItem,
  windowEndBlock,
} from "../scheduler.ts";
import { type Exits, isContractCode, type Snapshot } from "../snapshot.ts";
import type { NonceRow, TxRow } from "../store.ts";
import { addressLink, type Cond, CONTRACT_NAMES, isNew, type RuleCtx, twice, txLink, unjudged, utc } from "./context.ts";
import type { Rule } from "./index.ts";

// Spec 6.1: admin events and the admin keys' transactions; and v3.2's scheduler, exits machine and owner (spec §3.6,
// §7's monitor lines), on a v3.2 deployment only: v3-launch's admin rules are exactly as they were.

const CHAINS: readonly ChainName[] = ["base", "bittensor"];
const ZERO = "0x0000000000000000000000000000000000000000";
const lower = (a: Hex) => a.toLowerCase() as Hex;
const low = (x: unknown) => String(x).toLowerCase() as Hex;
const RAO = 10n ** 9n;
const E18 = 10n ** 18n;
const tao = (wei: bigint) => `${formatUnits(wei, 18)} TAO`;
const num = (s: string | undefined) => (s === undefined || s === "" || !Number.isFinite(Number(s)) ? undefined : Number(s));
const v32 = (ctx: RuleCtx) => ctx.cfg.deployment.version === "v3.2";
const afterBaseline = (ctx: RuleCtx, l: StoredLog) => l.block > ctx.cfg.deployment[l.chain].baselineBlock;
const isSchedulerRole = (r: Role): r is SchedulerRole => r === "vault" || r === "frontDoor";
const SCHEDULER: ReadonlySet<string> = new Set(SCHEDULER_EVENTS);

/** An address as an email names it on its chain: with "(the owner)", "(the guardian)" or "(the keeper)" when the
 * reading (or the one before) says it holds that role. */
export function whoIs(ctx: RuleCtx, chain: ChainName, a: unknown): string {
  if (typeof a !== "string" || a === "") return "not known yet";
  const x = a.toLowerCase();
  const s = ctx.snap[chain]?.state ?? ctx.previous[chain]?.state;
  const is = (r: Hex | undefined) => r !== undefined && r.toLowerCase() === x;
  const role = is(s?.owner) ? " (the owner)" : is(s?.guardian) ? " (the guardian)" : is(s?.keeper) ? " (the keeper)" : "";
  return `${x}${role}`;
}
const senderOf = (ctx: RuleCtx, l: StoredLog) => whoIs(ctx, l.chain, ctx.txs.get(`${l.chain}:${l.txHash}`)?.from);

/** v3.2: the first Executed after `l` in its transaction, of its contract: the one item whose self-call can have logged
 * `l` (an item's events come just before its own Executed). */
const executedAfter = (ctx: RuleCtx, l: StoredLog) => ctx.logs.inTx(l.chain, l.txHash).find((x) => x.contract === l.contract && x.event === "Executed" && x.logIndex > l.logIndex);

/** Each tick's decodes of its new Scheduled, by log uid: admin.scheduled and the items admin.event folds by share them,
 * so each is decoded once a tick (Task 55's re-review 2, Minor 2). */
const DECODED = new WeakMap<RuleCtx, Map<Hex, ReturnType<typeof decodeItem>>>();
/** How many Scheduled this tick has decoded (a test reads it). */
export const decodesOf = (ctx: RuleCtx): number => DECODED.get(ctx)?.size ?? 0;

/** The record entry a Scheduled log makes: its calldata decoded once (src/scheduler.ts), once a tick. */
function trackedOf(ctx: RuleCtx, l: StoredLog & { contract: SchedulerRole }): TrackedItem {
  const data = low(l.args.data);
  let cache = DECODED.get(ctx);
  if (!cache) DECODED.set(ctx, (cache = new Map()));
  if (!cache.has(l.uid)) cache.set(l.uid, decodeItem(l.contract, data));
  const dec = cache.get(l.uid);
  return {
    chain: l.chain,
    role: l.contract,
    id: low(l.args.id),
    kind: Number(l.args.kind),
    selector: low(l.args.selector).slice(0, 10) as Hex,
    readyAt: Number(l.args.readyAt),
    data,
    ...(dec ? { setter: dec.setter, ...(dec.args ? { args: dec.args } : {}), canonical: dec.canonical } : {}),
    uid: l.uid,
    block: String(l.block),
    tx: l.txHash,
  };
}

/** v3.2: the items known as this tick starts (the record's, and those refused at its cap, kept apart), with this tick's
 * new Scheduled, refused or not: what an Executed may close. The one map both admin.event (foldedInto) and
 * admin.executed (effectsOf) use, so each event an item logged is in exactly one email: folded into the item's
 * Executed, or on its own. A record or refused list that doesn't read counts as none here (every event is then emailed
 * on its own; admin.scheduled fails on it loudly). */
function knownItems(ctx: RuleCtx): Map<string, TrackedItem> {
  const read = (f: () => TrackedItem[]): TrackedItem[] => {
    try {
      return f();
    } catch {
      return [];
    }
  };
  const m = new Map<string, TrackedItem>();
  for (const x of [...read(() => parseItems(ctx.meta[ITEMS_KEY])), ...read(() => parseRefused(ctx.meta[REFUSED_KEY]).items)]) m.set(`${x.chain}:${x.id}`, x);
  for (const l of ctx.logs.all()) if (isSchedulerRole(l.contract) && l.event === "Scheduled" && isNew(ctx, l)) m.set(`${l.chain}:${low(l.args.id)}`, trackedOf(ctx, l as StoredLog & { contract: SchedulerRole }));
  return m;
}

/** v3.2: whether `l` is the own effect of the known item its transaction's next Executed closes (isEffectOf: the event
 * that item's setter logs, naming what its arguments name). A direct change batched beside an unrelated execute, or an
 * event before the Executed of an item not known (knownItems), is not: it is emailed on its own. */
function foldedInto(ctx: RuleCtx, l: StoredLog, known: () => ReadonlyMap<string, TrackedItem>): boolean {
  const ex = executedAfter(ctx, l);
  const item = ex ? known().get(`${l.chain}:${low(ex.args.id)}`) : undefined;
  return item !== undefined && isEffectOf(item, l);
}

/** v3.2: the admin events an Executed's item logged: its contract's, in its transaction, after the Executed before it,
 * and the item's own (isEffectOf); none for an item not known. `item` is knownItems' (the map foldedInto uses). */
function effectsOf(ctx: RuleCtx, ex: StoredLog, item: TrackedItem | undefined): StoredLog[] {
  if (!item) return [];
  const mine = ctx.logs.inTx(ex.chain, ex.txHash).filter((x) => x.contract === ex.contract);
  const from = Math.max(-1, ...mine.filter((x) => x.event === "Executed" && x.logIndex < ex.logIndex).map((x) => x.logIndex));
  return mine.filter((x) => x.logIndex > from && x.logIndex < ex.logIndex && ADMIN_EVENTS.has(`${x.contract}:${x.event}`) && !SCHEDULER.has(x.event) && isEffectOf(item, x));
}

/** v3.2: a StakeHotkeySet its own scheduled item ran: the transaction's next vault Executed has the id of
 * setStakeHotkey(hotkey), which is keccak256 of that call's calldata (CascadeBase.sol schedule and execute: id =
 * keccak256(data); one bytes32 argument has one canonical calldata). Any other is the immediate switch. */
function scheduledSwitch(ctx: RuleCtx, l: StoredLog): boolean {
  const ex = executedAfter(ctx, l);
  if (!ex) return false;
  const data = encodeFunctionData({ abi: SCHEDULABLE.vault, functionName: "setStakeHotkey", args: [low(l.args.hotkey)] } as never);
  return low(ex.args.id) === keccak256(data);
}

/** The event each instrument logs immediately before its ExitsClosed, its contract logging nothing between them (no
 * call between the two emits): CascadeVault.pause, Paused (OpenZeppelin's _pause) then ExitsClosed; CascadeBase's
 * disableBridge of the primary, BridgeDisabled then ExitsClosed; CascadeVault.removeFrontDoor of the launch chain's last
 * door, FrontDoorRemoved then ExitsClosed. A disable of another bridge, or the removal of another door, logs no
 * ExitsClosed. */
const INSTRUMENT_EVENT: Readonly<Record<string, string>> = { Paused: "pause", BridgeDisabled: "disableBridge", FrontDoorRemoved: "removeFrontDoor" };
/** v3.2: an ExitsClosed's own cause: the log just before it in its transaction (logIndex one less), of its contract,
 * its instrument's event. Any other is not, though it names the same instrument (a batched disable of a non-primary
 * bridge, or the removal of a door not the last). */
const causeOf = (ctx: RuleCtx, closed: StoredLog): StoredLog | undefined => {
  const ins = instrumentOf(String(closed.args.instrument));
  if (ins === undefined) return undefined;
  return ctx.logs.inTx(closed.chain, closed.txHash).find((x) => x.logIndex === closed.logIndex - 1 && x.contract === closed.contract && INSTRUMENT_EVENT[x.event] === ins);
};
/** v3.2: whether `l` is the own cause of the ExitsClosed just after it (causeOf): then it is named in that one email. */
const closedBy = (ctx: RuleCtx, l: StoredLog): boolean =>
  INSTRUMENT_EVENT[l.event] !== undefined &&
  ctx.logs.inTx(l.chain, l.txHash).some((x) => x.logIndex === l.logIndex + 1 && x.contract === l.contract && x.event === "ExitsClosed" && causeOf(ctx, x)?.uid === l.uid);
const named = (l: StoredLog) => {
  const a = Object.entries(l.args).map(([n, v]) => `${n} ${String(v)}`);
  return a.length ? `${l.event} (${a.join(", ")})` : l.event;
};

/** admin.event: an admin event (spec Facts) first stored this tick, after the deployment's baseline block (its setup,
 * v3.2's constructors' events included). On v3.2: the scheduler's events are their own rules'; an executed item's own
 * events (foldedInto) are listed in its admin.executed; an immediate StakeHotkeySet is admin.hotkey_switched; a pause,
 * a primary's disable or a launch door's removal (an ExitsClosed's own cause, the log just before it: causeOf) is named
 * in that ExitsClosed's email, not one of its own, and any other disable or removal is emailed on its own; a
 * StampedBySig emails once per asOf on its chain, and only when it moves the owner's clock (a replay, or an older stamp,
 * changes nothing and emails nothing: meta stamp_asof:{chain}), so replays can't bury a Scheduled; a LimitSet names its
 * setter, an ExitsClosed or ExitsReopened its instrument, and an owner's forfeit says so. */
export const adminEvent: Rule = {
  name: "admin.event",
  run(ctx) {
    const out: Finding[] = [];
    const isV32 = v32(ctx);
    // the items an Executed may close, built only once an event has an Executed after it (a flood of Scheduled alone
    // decodes nothing here: Task 55's re-review 2, Minor 2)
    let knownMap: Map<string, TrackedItem> | undefined;
    const known = () => (knownMap ??= knownItems(ctx));
    const stamped: Partial<Record<ChainName, number>> = {};
    for (const l of ctx.logs.all()) {
      if (!ADMIN_EVENTS.has(`${l.contract}:${l.event}`) || !isNew(ctx, l)) continue;
      if (l.block <= ctx.cfg.deployment[l.chain].baselineBlock) continue;
      const name = `${CONTRACT_NAMES[l.contract]} ${l.event}`;
      const sender = ctx.txs.get(`${l.chain}:${l.txHash}`)?.from;
      const args: Record<string, string> = Object.fromEntries(Object.entries(l.args).map(([k, v]) => [k, String(v)]));
      let key = `admin.event:${l.uid}`;
      if (isV32) {
        if (SCHEDULER.has(l.event) || foldedInto(ctx, l, known) || closedBy(ctx, l)) continue;
        // the immediate switch is admin.hotkey_switched's; a scheduled one the record didn't hold is emailed here
        if (l.contract === "vault" && l.event === "StakeHotkeySet" && !scheduledSwitch(ctx, l)) continue;
        if (l.event === "StampedBySig") {
          const asOf = Number(l.args.asOf);
          const k = `stamp_asof:${l.chain}`;
          if (!Number.isSafeInteger(asOf) || asOf <= (stamped[l.chain] ?? num(ctx.meta[k]) ?? -1)) continue;
          stamped[l.chain] = asOf;
          ctx.writes.meta.push({ k, v: String(asOf) });
          key = `admin.event:stamp:${l.chain}:${asOf}`;
          args["as of"] = utc(asOf);
          // lastOwnerClose = max(lastOwnerClose, asOf): every item scheduled at or before asOf dies
          args["what it does"] = "the owner's clock is now at least this time: no item scheduled at or before it can run";
        }
        if (l.contract === "vault" && l.event === "LimitSet") args.setter = limitSetterOf(String(l.args.selector)) ?? "an unknown setter";
        if (l.event === "ExitsClosed" || l.event === "ExitsReopened") {
          const sel = String(l.args.instrument);
          args.instrument = `${instrumentOf(sel) ?? "an unknown instrument"} (${sel})`;
          if (l.event === "ExitsClosed") {
            args.by = whoIs(ctx, l.chain, l.args.by);
            const own = causeOf(ctx, l);
            if (own) args.with = `${CONTRACT_NAMES[l.contract]} ${named(own)}`;
          }
        }
        if (l.contract === "vault" && l.event === "HotkeyRemoved" && String(l.args.forfeit) === "true") args["what it means"] = "the owner removed it and gave up its unclaimed rewards";
        // a cancel re-mints at its own price, min(the shares burned, what the entry's value buys then) (Task 34c): the
        // shares say little, the value is what the holder got back
        if (l.contract === "vault" && l.event === "RedeemReversed") args.returned = `${tao(BigInt(String(l.args.assets ?? "0")))} of value, as ${String(l.args.shares)} shares re-minted at the cancel's price (judge it by the TAO)`;
      }
      out.push({
        rule: "admin.event",
        key,
        subject: `Admin event: ${name}`,
        facts: { ...args, event: name, sender: sender ?? "not known yet", block: String(l.block), transaction: txLink(l.chain, l.txHash) },
      });
    }
    return out;
  },
};

// ---- v3.2: the scheduler ----

/** admin.record_full's floods (meta record_full_episodes): when each began, newest last, and the last refusal. A
 * refusal more than FLOOD_GAP_S after the last one begins a new flood; at most MAX_EPISODES have keys of their own. A
 * flood's key is never dropped while the record is full (an alert not found would resolve, with a "resolved" email,
 * though nothing cleared: Task 56's review, Minor 6), so a flood past the MAX_EPISODES-th is folded into the oldest kept
 * key, and `folded` counts them. */
const EPISODES_KEY = "record_full_episodes";
const FLOOD_GAP_S = 3600;
const MAX_EPISODES = 8;
interface Episodes {
  starts: number[];
  last: number;
  folded?: number;
}
const parseEpisodes = (v: string): Episodes | undefined => {
  if (!v) return undefined;
  try {
    const e = JSON.parse(v) as Episodes;
    const ok = Array.isArray(e.starts) && e.starts.length > 0 && e.starts.every(Number.isSafeInteger) && Number.isSafeInteger(e.last);
    return ok && (e.folded === undefined || (Number.isSafeInteger(e.folded) && e.folded >= 0)) ? e : undefined;
  } catch {
    return undefined;
  }
};

/** What each kind means for who may cancel it (spec §3.6's table). */
const KIND_MEANING = ["Ordinary (the owner or the guardian can cancel it)", "GuardianSwap (only the owner can cancel it)", "Reopen (only the owner can cancel it)"];
const changeOf = (item: TrackedItem | undefined) => (!item ? "an item not seen scheduled" : (item.setter ?? `an unknown setter (${item.selector})`));

/** An item's facts: where it is, the change (the setter, or what is known of it), each argument with its unit, the
 * kind and when it is ready. */
/** Until when an item can run, in words: the later of its window in time's end (readyAt + EXECUTE_WINDOW) and its window
 * in blocks' (its readyBlock plus half EXECUTE_WINDOW in calibrated blocks, Revision 28), that block's time told from
 * `at` (the chain's reading) at its block time as measured (`blockS`). With its block or the chain's block time unknown,
 * its time's end and what it waits on. */
function runsUntilText(readyAt: number, readyBlock: bigint | undefined, msPerBlock: number | undefined, at: { block: bigint; time: number } | undefined, blockS: number | undefined): string {
  const byTime = readyAt + EXECUTE_WINDOW_S;
  if (readyBlock === undefined || msPerBlock === undefined) return `${utc(byTime)}, or later while its blocks come slowly (its window in blocks unread)`;
  const end = windowEndBlock(readyBlock, msPerBlock);
  if (at === undefined || blockS === undefined) return `${utc(byTime)} or block ${end}, whichever is later`;
  const byBlocks = at.time + Math.ceil(Number(end - at.block) * blockS);
  return byBlocks > byTime ? `about ${utc(byBlocks)} (block ${end}: its blocks come slower than its time)` : utc(byTime);
}

function itemFacts(role: SchedulerRole, chain: ChainName, item: TrackedItem | undefined): Record<string, string> {
  const f: Record<string, string> = { contract: CONTRACT_NAMES[role], chain };
  if (!item) {
    f.change = "not known (its Scheduled wasn't seen)";
    return f;
  }
  f.change = changeOf(item);
  for (const [k, v] of Object.entries(item.args ?? {})) f[`argument ${k}`] = item.setter ? formatArg(item.setter, k, v) : v;
  f.kind = KIND_MEANING[item.kind] ?? kindName(item.kind);
  f["ready at"] = utc(item.readyAt);
  return f;
}

/** A direction's facts: whether the item loosens a limit, and a "now, at execute" line per field. */
function directionFacts(d: ReturnType<typeof directionOf>): Record<string, string> {
  if (!d) return {};
  if (d.reverts) return { direction: `it reverts at execute: ${d.reverts}` };
  const what = d.loosens === true ? "loosens" : d.loosens === false ? "doesn't loosen" : `unknown (${d.unread.join(", ")} ${d.unread.length === 1 ? "is" : "are"} unread)`;
  return { direction: what, ...Object.fromEntries(d.lines) };
}

const where = (l: StoredLog) => ({ block: String(l.block), transaction: txLink(l.chain, l.txHash) });

/** admin.scheduled, admin.executed and admin.cancelled (critical events, at once, on both chains: the single-key
 * mitigation, spec §5 and §7), admin.lapsed (a warning event) and admin.item_loosens (a critical event), on v3.2.
 * Every Scheduled after the baseline emails its kind, setter, arguments (decoded from its calldata with the contract's
 * ABI, and checked to be their canonical encoding), readyAt and the lens's readyBlock, and whether it loosens a limit
 * against the current value; every Executed and Cancelled emails the item it closes (an Executed lists the admin
 * events the item logged). The record of the items (meta scheduled_items, src/scheduler.ts) keeps each Scheduled until
 * its Executed, Cancelled or Lapsed, a setup's too (at or before the baseline: recorded, never emailed), and judges each
 * against this tick's lens reads: admin.lapsed once when it can no longer run (its window passed unexecuted, judged by
 * time; or a closure or owner stamp since its scheduling killed it; or it was pruned before either was seen), and
 * admin.item_loosens once when an item that didn't loosen at scheduling now would, on two readings in a row (a direct
 * tightening since moved the current value past it: spec §3.6 judges the direction at execute). An item the lens
 * hasn't read is judged by nothing; one it reads gone is forgotten once the logs are stored past its window. Past the
 * record's live cap a new item is refused (meta scheduled_refused): still emailed, closed by its own events like any
 * other, taken into the record on a later tick with room, and counted by admin.record_full (a critical condition)
 * until it is taken in or finished. */
export const schedulerItems: Rule = {
  name: "admin.scheduled",
  raises: ["admin.executed", "admin.cancelled", "admin.lapsed", "admin.item_loosens", "admin.record_full"],
  run(ctx) {
    if (!v32(ctx)) return [];
    const before = ctx.meta[ITEMS_KEY] ?? "";
    const refusedBefore = ctx.meta[REFUSED_KEY] ?? "";
    // A record or refused list that doesn't read (only this module writes them) is never read as nothing pending, and
    // never stops this tick's emails (Task 55's re-review 2, its residual): every Scheduled, Executed and Cancelled is
    // still emailed, nothing is written over the damaged value, what the record would judge is marked unjudged, and
    // monitor.unjudged names the damaged record at once (src/rules/ops.ts, damagedRecords)
    const attempt = <T>(f: () => T): T | undefined => {
      try {
        return f();
      } catch {
        return undefined;
      }
    };
    const parsedItems = attempt(() => parseItems(before));
    const parsedRefused = attempt(() => parseRefused(refusedBefore));
    const damaged = parsedItems === undefined || parsedRefused === undefined;
    const items = new Map((parsedItems ?? []).map((x) => [`${x.chain}:${x.id}`, x]));
    const liveCount = () => [...items.values()].filter((x) => !x.lapsed).length;
    // the items refused at the live cap (meta scheduled_refused): those refused on earlier ticks (oldest first) and
    // this tick's; each counts until it is finished or taken in
    const was: Refused = parsedRefused ?? { items: [], more: {} };
    const earlier = new Map(was.items.map((x) => [`${x.chain}:${x.id}`, x]));
    const refusedNow = new Map<string, TrackedItem>();
    const more: Refused["more"] = { ...was.more };
    const unrefuse = (k: string) => {
      earlier.delete(k);
      refusedNow.delete(k);
    };
    // the map admin.event folds an executed item's own events by: so each is in its Executed's email, or its own (built
    // at the first Executed: a flood of Scheduled alone isn't decoded again)
    let knownMap: Map<string, TrackedItem> | undefined;
    const known = () => (knownMap ??= knownItems(ctx));
    const out: Finding[] = [];
    // each chain's MS_PER_BLOCK, the last reading's (an immutable): an item's window in blocks is counted in it
    const msOf = (chain: ChainName): number | undefined => ctx.snap[chain]?.state.msPerBlock ?? ctx.previous[chain]?.state.msPerBlock;
    // an item can no longer run once the stored logs are past both its windows (Revision 28): only then is it forgotten
    const finished = (x: TrackedItem) => pastBothWindows(x, ctx.settled[x.chain], msOf(x.chain));
    const lapsed = (item: TrackedItem | undefined, role: SchedulerRole, chain: ChainName, id: Hex, why: string, at?: StoredLog): Finding => ({
      rule: "admin.lapsed",
      key: `admin.lapsed:${chain}:${id}:${item?.uid ?? at?.uid ?? ""}`,
      subject: `A scheduled owner change can no longer run on the ${CONTRACT_NAMES[role]}: ${changeOf(item)}`,
      facts: { ...itemFacts(role, chain, item), why, id, ...(item ? { "scheduled in": txLink(chain, item.tx) } : {}), ...(at ? where(at) : {}) },
    });

    for (const l of ctx.logs.all()) {
      if (!isSchedulerRole(l.contract) || !SCHEDULER.has(l.event) || !isNew(ctx, l)) continue;
      const role = l.contract;
      const id = low(l.args.id);
      const k = `${l.chain}:${id}`;
      const quiet = !afterBaseline(ctx, l);
      if (l.event === "Scheduled") {
        const item = trackedOf(ctx, l as StoredLog & { contract: SchedulerRole });
        const data = item.data;
        const dir = directionOf(item, ctx.snap[l.chain]?.state);
        if (dir?.loosens !== undefined) item.loosens = dir.loosens;
        // one that reverts at execute is finished at once (judged once, below), and takes no live slot
        if (dir?.reverts) item.lapsed = true;
        const replaces = items.get(k);
        // a new scheduling of a refused id supersedes it; past the live cap, a new item is refused (kept apart)
        unrefuse(k);
        if (!item.lapsed && (!replaces || replaces.lapsed) && liveCount() >= MAX_LIVE_ITEMS) refusedNow.set(k, item);
        else items.set(k, item);
        if (quiet) continue;
        const read = ctx.snap[l.chain]?.state.scheduled?.[id];
        out.push({
          rule: "admin.scheduled",
          key: `admin.scheduled:${l.uid}`,
          subject: `An owner change was scheduled on the ${CONTRACT_NAMES[role]}: ${changeOf(item)} (ready ${utc(item.readyAt)})`,
          facts: {
            ...itemFacts(role, l.chain, item),
            "ready from block": read && read.readyAt === item.readyAt ? String(read.readyBlock) : "not read yet",
            "can run until": runsUntilText(item.readyAt, read && read.readyAt === item.readyAt ? read.readyBlock : undefined, msOf(l.chain), ctx.snap[l.chain], ctx.blockS[l.chain]),
            ...directionFacts(dir),
            calldata: item.canonical === false ? `${data} (not the canonical encoding of its arguments: it can't run)` : data,
            id,
            sender: senderOf(ctx, l),
            ...where(l),
          },
        });
        if (dir?.reverts) out.push(lapsed(item, role, l.chain, id, `it reverts at execute: ${dir.reverts}`));
        continue;
      }
      // closed: recorded, or refused (finished, so it counts no more)
      const item = items.get(k) ?? earlier.get(k) ?? refusedNow.get(k);
      items.delete(k);
      unrefuse(k);
      if (quiet) continue;
      if (l.event === "Executed") {
        // named, with its effects, by the map admin.event folds by: one refused past the list's cap included
        const ran = item ?? known().get(k);
        const effects = effectsOf(ctx, l, known().get(k)).map(named);
        out.push({
          rule: "admin.executed",
          key: `admin.executed:${l.uid}`,
          subject: `A scheduled owner change ran on the ${CONTRACT_NAMES[role]}: ${changeOf(ran)}`,
          facts: { ...itemFacts(role, l.chain, ran), ...(ran ? { "scheduled in": txLink(l.chain, ran.tx) } : {}), ...(effects.length ? { effects: effects.join("; ") } : {}), id, sender: senderOf(ctx, l), ...where(l) },
        });
      } else if (l.event === "Cancelled") {
        out.push({
          rule: "admin.cancelled",
          key: `admin.cancelled:${l.uid}`,
          subject: `A scheduled owner change was cancelled on the ${CONTRACT_NAMES[role]}: ${changeOf(item)}`,
          facts: { ...itemFacts(role, l.chain, item), "cancelled by": whoIs(ctx, l.chain, l.args.by), ...(item ? { "scheduled in": txLink(l.chain, item.tx) } : {}), id, sender: senderOf(ctx, l), ...where(l) },
        });
      } else if (item && !item.lapsed) {
        // a prune of an item neither recorded nor refused (forgotten past its window, or never tracked) says nothing new
        out.push(lapsed(item, role, l.chain, id, "it was pruned past its window (Lapsed)", l));
      }
    }

    if (damaged) {
      // judged by nothing, written over by nothing: what the record judges is unjudged (monitor.unjudged names it)
      ctx.unjudged.push({ rule: "admin.item_loosens" }, { rule: "admin.record_full" });
      return out;
    }

    // the items still recorded, against this tick's reading of their chain
    for (const [k, item] of items) {
      // a finished item is judged by nothing, and forgotten once the logs are stored past its window
      if (item.lapsed) {
        if (finished(item)) items.delete(k);
        continue;
      }
      const r = ctx.snap[item.chain];
      const st = itemStatus(item, r);
      if (st.status === "gone") {
        // executed, cancelled or pruned: its event closes the record; once the logs are stored past both its windows, none can
        if (finished(item)) items.delete(k);
        continue;
      }
      if (st.status === "dead" || st.status === "lapsed") {
        if (!item.lapsed) {
          const why =
            st.status === "dead"
              ? `a closure or an owner stamp at ${utc(st.clock)} came after it was scheduled (${utc(st.scheduledAt)})`
              : `its window ended at ${utc(item.readyAt + EXECUTE_WINDOW_S)}, and in blocks at block ${st.endBlock}, without it running`;
          out.push(lapsed(item, item.role, item.chain, item.id, why));
          items.set(k, { ...item, lapsed: true });
        }
        continue;
      }
      if (st.status !== "pending" || !r) {
        // past its window in time, its window in blocks unreadable (MS_PER_BLOCK unread): whether it has lapsed can't be told,
        // so it is marked unjudged (review M-4; admin.lapsed is a warning: the daily digest lists it while it lasts)
        if (st.status === "unknown" && st.blocksUnread) ctx.unjudged.push({ rule: "admin.lapsed", key: `admin.lapsed:${item.chain}:${item.id}:${item.uid}` });
        // unread (or its clocks unread): whether a setter item now loosens can't be told
        if (directionOf(item, undefined)) ctx.unjudged.push({ rule: "admin.item_loosens" });
        continue;
      }
      const now = directionOf(item, r.state);
      if (!now) continue;
      if (now.loosens === undefined) {
        ctx.unjudged.push({ rule: "admin.item_loosens" });
        continue;
      }
      const prev = ctx.previous[item.chain];
      const was = prev && prev.block < r.block ? directionOf(item, prev.state)?.loosens : undefined;
      const confirmed = now.loosens === false ? false : was === true ? true : undefined;
      if (confirmed === true && item.loosens !== true) {
        out.push({
          rule: "admin.item_loosens",
          key: `admin.item_loosens:${item.chain}:${item.id}:${item.uid}`,
          subject: `A pending owner change would now loosen a limit on the ${CONTRACT_NAMES[item.role]}: ${changeOf(item)}`,
          facts: { ...itemFacts(item.role, item.chain, item), ...directionFacts(now), id: item.id, "scheduled in": txLink(item.chain, item.tx) },
        });
      }
      if (confirmed !== undefined && confirmed !== item.loosens) items.set(k, { ...item, loosens: confirmed });
    }
    // the finished items kept are bounded too: beyond MAX_FINISHED_ITEMS, the soonest forgotten (earliest readyAt) go
    const done = [...items.entries()].filter(([, x]) => x.lapsed).sort(([, a], [, b]) => a.readyAt - b.readyAt);
    for (const [k] of done.slice(0, Math.max(0, done.length - MAX_FINISHED_ITEMS))) items.delete(k);
    // the refused items: one past its window by the stored logs is finished (any Executed of it is stored, and closed
    // it above); then those refused on earlier ticks are taken in, oldest first, while the record has room (read from
    // the next tick, and shown on the security page, like any other). This tick's wait for the next, so every refusal
    // raises admin.record_full at least once. The oldest MAX_REFUSED_ITEMS are kept in full; the rest are counted.
    for (const [k, x] of [...earlier, ...refusedNow]) if (finished(x)) unrefuse(k);
    // a count clears once the stored logs are past the last one's window in time and in blocks (a count kept before
    // Revision 28, with no block, by time alone)
    for (const chain of CHAINS) {
      const m = more[chain];
      if (!m || ctx.settled[chain].time <= m.until) continue;
      const ms = msOf(chain);
      if (m.lastBlock === undefined || (ms !== undefined && ctx.settled[chain].block > lastWindowBlock(BigInt(m.lastBlock), ms))) delete more[chain];
    }
    for (const [k, x] of earlier) {
      if (liveCount() >= MAX_LIVE_ITEMS) break;
      items.set(k, x);
      earlier.delete(k);
    }
    const apart = [...earlier.values(), ...refusedNow.values()];
    for (const x of apart.slice(MAX_REFUSED_ITEMS)) {
      const m = more[x.chain];
      const lastBlock = m?.lastBlock !== undefined && BigInt(m.lastBlock) > BigInt(x.block) ? m.lastBlock : x.block;
      more[x.chain] = { n: (m?.n ?? 0) + 1, until: Math.max(m?.until ?? 0, x.readyAt + EXECUTE_WINDOW_S), lastBlock };
    }
    const kept = apart.slice(0, MAX_REFUSED_ITEMS);
    // admin.record_full: while any refused item may still be pending (it is judged by nothing, so it isn't finished),
    // one alert per flood (an episode: refusals with no gap of more than FLOOD_GAP_S between them, meta
    // record_full_episodes), so a fresh flood is a new alert and an email of its own though the first was acknowledged
    // (Task 55's re-review 2, Minor 1); the earlier floods' alerts stay found while it holds, and all clear together.
    // Past MAX_EPISODES floods a new one is folded into the oldest kept key: no key is dropped while it holds (Task 56's
    // review, Minor 6)
    const notTracked = kept.length + CHAINS.reduce((n, c) => n + (more[c]?.n ?? 0), 0);
    const live = liveCount();
    const episodesBefore = ctx.meta[EPISODES_KEY] ?? "";
    let episodes = parseEpisodes(episodesBefore);
    if (notTracked > 0) {
      if (!episodes) {
        episodes = { starts: [ctx.nowS], last: ctx.nowS };
      } else if (refusedNow.size > 0 && ctx.nowS - episodes.last > FLOOD_GAP_S) {
        episodes =
          episodes.starts.length < MAX_EPISODES
            ? { ...episodes, starts: [...episodes.starts, ctx.nowS], last: ctx.nowS }
            : { ...episodes, last: ctx.nowS, folded: (episodes.folded ?? 0) + 1 };
      } else if (refusedNow.size > 0) {
        episodes = { ...episodes, last: ctx.nowS };
      }
      const last = Math.max(...kept.map((x) => x.readyAt + EXECUTE_WINDOW_S), ...CHAINS.map((c) => more[c]?.until ?? 0));
      const folded = episodes.folded ?? 0;
      episodes.starts.forEach((start, i) => {
        out.push({
          rule: "admin.record_full",
          key: `admin.record_full:${start}`,
          subject: `Too many scheduled owner changes to track: ${notTracked} more beside the ${live} tracked`,
          facts: {
            tracked: String(live),
            "not tracked": String(notTracked),
            "the last can run until": utc(last),
            "this flood began": utc(start),
            ...(i === 0 && folded > 0 ? { "later floods counted here": `${folded} (the monitor keeps ${MAX_EPISODES} floods' alerts apart)` } : {}),
            "what still works": "every Scheduled, Executed and Cancelled is still emailed; those not tracked aren't judged, nor shown on the security page",
          },
        });
      });
    } else {
      episodes = undefined;
    }
    const episodesAfter = episodes ? JSON.stringify(episodes) : "";
    if (episodesAfter !== episodesBefore) ctx.writes.meta.push({ k: EPISODES_KEY, v: episodesAfter });
    const refusedAfter = notTracked > 0 ? JSON.stringify({ items: kept, more } satisfies Refused) : "";
    if (refusedAfter !== refusedBefore) ctx.writes.meta.push({ k: REFUSED_KEY, v: refusedAfter });
    const after = items.size ? JSON.stringify([...items.values()]) : "";
    if (after !== before) ctx.writes.meta.push({ k: ITEMS_KEY, v: after });
    return out;
  },
};

/** admin.hotkey_switched (critical event, v3.2): a StakeHotkeySet no scheduled item ran (spec §3.1: setStakeHotkey is
 * immediate when the new hotkey already holds more than the stake hotkey and at least half the booked stake, and gifts
 * count, so a stolen owner key can switch at once; the guardian treats any immediate switch as an alarm). One run by
 * its own item (scheduledSwitch: the next Executed's id is setStakeHotkey(hotkey)'s) is in that item's admin.executed;
 * an Executed of any other item in the same transaction leaves it raised. */
export const hotkeySwitched: Rule = {
  name: "admin.hotkey_switched",
  run(ctx) {
    if (!v32(ctx)) return [];
    const s = ctx.snap.bittensor?.state;
    return ctx.logs
      .range("bittensor", "vault", "StakeHotkeySet")
      .filter((l) => isNew(ctx, l) && afterBaseline(ctx, l) && !scheduledSwitch(ctx, l))
      .map((l): Finding => {
        const hotkey = low(l.args.hotkey);
        const stake = s?.stakes[hotkey];
        return {
          rule: "admin.hotkey_switched",
          key: `admin.hotkey_switched:${l.uid}`,
          subject: "The vault's stake hotkey was switched at once, with no scheduled item",
          facts: {
            hotkey,
            "stake on it": stake === undefined ? "not read yet" : `${formatUnits(stake, 9)} TAO`,
            "booked stake": s?.bookedStake === undefined ? "not read" : `${formatUnits(s.bookedStake, 9)} TAO`,
            sender: senderOf(ctx, l),
            ...where(l),
          },
        };
      });
  },
};

// ---- v3.2: the exits machine and the owner ----

const ACTORS = ["nobody", "the owner", "the guardian"];
const actor = (a: number) => ACTORS[a] ?? `actor ${a}`;

/** The holds a reading names: the vault's pause and launch door, and the primary bridge's disable on both. */
function holdsOf(e: Exits, vault: boolean): string[] {
  const out: string[] = [];
  if (vault && e.pausedBy) out.push(`paused by ${actor(e.pausedBy)}`);
  if (e.primaryDisabledBy) out.push(`the primary bridge disabled by ${actor(e.primaryDisabledBy)}`);
  if (vault && e.launchDoorRemovedBy) out.push(`the launch door removed by ${actor(e.launchDoorRemovedBy)}`);
  return out;
}
const stateOf = (e: Exits) => (e.ownerHold && e.guardianHold ? "OG: both holds" : e.ownerHold ? "O: the owner's hold" : e.guardianHold ? "G: the guardian's hold" : "closed");

interface LastClose {
  by: Hex;
  instrument: string;
  block: string;
  tx: Hex;
}

/** admin.exits_state (critical condition, v3.2): either chain's exits machine is not OPEN (the vault's read on
 * Bittensor, the front door's on Base, where a Base-side closure shows: spec §3.6), on two readings in a row, naming the
 * holds and who closed last with what (the last ExitsClosed, kept in meta exits_closed:{chain}); and, keyed apart, the
 * launch chain with no active front door, OPEN or not (activeDoors(launchChain) == 0: Base users have only a direct
 * exit; unknown unless launchChain reads Base's chain id). Unjudged without a reading or the state. */
export const exitsState: Rule = {
  name: "admin.exits_state",
  run(ctx) {
    if (!v32(ctx)) return [];
    const last: Partial<Record<ChainName, LastClose>> = {};
    for (const chain of CHAINS) {
      try {
        const m = ctx.meta[`exits_closed:${chain}`];
        if (m) last[chain] = JSON.parse(m) as LastClose;
      } catch {
        // a damaged record: named as not seen
      }
    }
    for (const l of ctx.logs.all()) {
      if (!isSchedulerRole(l.contract) || l.event !== "ExitsClosed" || !isNew(ctx, l)) continue;
      const rec: LastClose = { by: low(l.args.by), instrument: instrumentOf(String(l.args.instrument)) ?? String(l.args.instrument), block: String(l.block), tx: l.txHash };
      last[l.chain] = rec;
      ctx.writes.meta.push({ k: `exits_closed:${l.chain}`, v: JSON.stringify(rec) });
    }
    const out: Finding[] = [];
    for (const chain of CHAINS) {
      const key = `admin.exits_state:${chain}`;
      const vault = chain === "bittensor";
      const closed = twice(ctx, chain, (r) => {
        const open = r[chain]?.exits?.open;
        return open === undefined ? undefined : !open;
      });
      if (closed === undefined) {
        unjudged(ctx, "admin.exits_state", key);
        continue;
      }
      if (!closed) continue;
      const e = ctx.snap[chain]?.state.exits as Exits;
      const holds = holdsOf(e, vault);
      const lc = last[chain];
      out.push({
        rule: "admin.exits_state",
        key,
        subject: `Exits are closed on the ${vault ? "vault" : "front door"}: ${holds.join(", ") || "a hold the reading doesn't name"}`,
        facts: {
          chain,
          contract: vault ? "vault" : "front door",
          state: stateOf(e),
          holds: holds.join("; ") || "none named",
          "last closed by": lc ? whoIs(ctx, chain, lc.by) : "not seen",
          ...(lc ? { "last closed with": lc.instrument, "last closed at block": lc.block, transaction: txLink(chain, lc.tx) } : {}),
        },
      });
    }
    // the launch chain's doors: asked for Base (the vault keys doors by EVM chain id), so known only when the launch
    // chain is Base's
    const doors = "admin.exits_state:doors";
    const baseId = BigInt(ctx.cfg.deployment.base.chainId);
    const none = twice(ctx, "bittensor", (r) => {
      const s = r.bittensor;
      return s?.activeDoors === undefined || s.launchChain !== baseId ? undefined : s.activeDoors === 0n;
    });
    if (none === undefined) unjudged(ctx, "admin.exits_state", doors);
    else if (none) {
      out.push({
        rule: "admin.exits_state",
        key: doors,
        subject: "The vault has no active front door on Base: only direct exits on Bittensor work",
        facts: { "active doors on Base": "0", "launch chain": String(baseId), vault: addressLink("bittensor", ctx.cfg.deployment.vault) },
      });
    }
    return out;
  },
};

/** admin.owner_pending (critical condition, v3.2): pendingOwner() isn't zero on the vault or the front door, on two
 * readings, and the new owner can still accept: a scheduled transferOwnership has run, and acceptance is open until
 * pendingSince + EXECUTE_WINDOW (pendingSince from the lens) unless a closure or an owner stamp comes first (spec §3.6).
 * It clears once acceptance can't happen any more (pendingSince 0, the window passed, or either clock at or after
 * pendingSince); with pendingSince unread it is raised, since it can't be told to have expired. */
export const ownerPending: Rule = {
  name: "admin.owner_pending",
  run(ctx) {
    if (!v32(ctx)) return [];
    const out: Finding[] = [];
    for (const chain of CHAINS) {
      const key = `admin.owner_pending:${chain}`;
      const pending = twice(ctx, chain, (r) => {
        const p = r[chain]?.pendingOwner;
        return p === undefined ? undefined : lower(p) !== ZERO;
      });
      if (pending === undefined) {
        unjudged(ctx, "admin.owner_pending", key);
        continue;
      }
      if (!pending) continue;
      const r = ctx.snap[chain]!;
      const p = lower(r.state.pendingOwner as Hex);
      const e = r.state.exits;
      const since = e?.pendingSince;
      // acceptOwnership can no longer happen (CascadeBase.sol): pendingSince 0, past its window (LapsedItem), or a
      // closure or owner stamp at or after it (_gate(Ordinary, pendingSince): either clock at pendingSince or later)
      if (since !== undefined) {
        const clock = Math.max(e?.lastOwnerClose ?? 0, e?.lastGuardianClose ?? 0);
        if (since === 0 || r.time > since + EXECUTE_WINDOW_S || clock >= since) continue;
      }
      const name = chain === "bittensor" ? "vault" : "front door";
      out.push({
        rule: "admin.owner_pending",
        key,
        subject: `A new owner is pending on the ${name}: ${p}`,
        facts: {
          "pending owner": p,
          owner: r.state.owner ? lower(r.state.owner) : "not read",
          "transfer ran at": since === undefined ? "not read" : utc(since),
          ...(since !== undefined ? { "it can accept until": utc(since + EXECUTE_WINDOW_S) } : {}),
          contract: name,
          chain,
          explorer: addressLink(chain, p),
        },
      });
    }
    return out;
  },
};

/** The founder level of the caps (the plan's launch values): a deposit cap of 40 TAO on Base, 44 TAO in the vault. */
export const FOUNDER_DEPOSIT_CAP_WEI = 40n * E18;
export const FOUNDER_MAX_TOTAL_ASSETS_WEI = 44n * E18;

/** admin.owner_kind (warning condition, v3.2): an owner that isn't a Safe answering getThreshold() >= 2 with at least 3
 * signers (an account, or an EIP-7702 delegated account, counts as an account; so does a contract that answers neither,
 * on two readings), while Cascade is past the founder level: the stage above "early" (DEPLOYMENT.stage "live", or
 * "retired": a retiring deployment can still hold funds), or either cap above it (ruling A10). One per chain: the
 * owner's code, threshold and signers. Unjudged while the owner's code is unread, a contract has been asked on one
 * reading only, or the level can't be told (a cap unread). */
export const ownerKind: Rule = {
  name: "admin.owner_kind",
  run(ctx) {
    if (!v32(ctx)) return [];
    const stage = ctx.cfg.deployment.stage;
    const cap = ctx.snap.base?.state.depositCap;
    const max = ctx.snap.bittensor?.state.maxTotalAssets;
    const above =
      stage === "live" || stage === "retired" || (cap !== undefined && cap > FOUNDER_DEPOSIT_CAP_WEI) || (max !== undefined && max > FOUNDER_MAX_TOTAL_ASSETS_WEI)
        ? true
        : cap === undefined || max === undefined
          ? undefined
          : false;
    if (above === false) return [];
    const out: Finding[] = [];
    for (const chain of CHAINS) {
      const key = `admin.owner_kind:${chain}`;
      const s = ctx.snap[chain]?.state;
      const owner = s?.owner ? lower(s.owner) : undefined;
      const code = owner ? ctx.snap.codes?.[chain]?.[owner] : undefined;
      if (!s || !owner || code === undefined || above === undefined) {
        unjudged(ctx, "admin.owner_kind", key);
        continue;
      }
      const asked = s.ownerSafe && lower(s.ownerSafe.address) === owner ? s.ownerSafe : undefined;
      const read = asked && asked.threshold !== undefined && asked.signers !== undefined ? asked : undefined;
      // a contract asked as a Safe that answered neither getThreshold() nor getOwners(), on the reading before too, is
      // a contract but not a Safe; asked on this reading only (a new owner), it waits for the next
      const prev = ctx.previous[chain];
      const prevAsked = prev && prev.block < (ctx.snap[chain]?.block ?? 0n) ? prev.state.ownerSafe : undefined;
      const noAnswer = !!asked && !read && !!prevAsked && lower(prevAsked.address) === owner && (prevAsked.threshold === undefined || prevAsked.signers === undefined);
      if (isContractCode(code) && !read && !noAnswer) {
        unjudged(ctx, "admin.owner_kind", key);
        continue;
      }
      if (read && isContractCode(code) && (read.threshold as bigint) >= 2n && (read.signers as Hex[]).length >= 3) continue;
      const name = chain === "bittensor" ? "vault" : "front door";
      out.push({
        rule: "admin.owner_kind",
        key,
        subject: `The ${name}'s owner isn't a 2-of-3 Safe, and Cascade is past the founder level`,
        facts: {
          owner,
          "owner is": codeIs(code.toLowerCase() as Hex),
          threshold: read ? String(read.threshold) : noAnswer && isContractCode(code) ? "doesn't answer: a contract, not a Safe" : "none",
          signers: read ? String((read.signers as Hex[]).length) : noAnswer && isContractCode(code) ? "doesn't answer" : "none",
          stage: stage ?? "not set",
          "deposit cap": cap === undefined ? "not read" : tao(cap),
          "max total assets": max === undefined ? "not read" : tao(max),
          "the founder level": "a deposit cap of 40 TAO and 44 TAO in the vault",
          chain,
          explorer: addressLink(chain, owner),
        },
      });
    }
    return out;
  },
};

/** Stake is missing, the vault's hotkey set is full and no hotkey but the stake hotkey can be removed by anyone but the
 * owner: each holds stake, or unclaimed rewards beyond what a remover may leave (anyone: none; the keeper or the
 * guardian: the dust allowance, hotkeyDustRao in rao). Undefined while a part of that is unread. */
const slotBlocked: Cond = (r) => {
  const s = r.bittensor;
  if (!s || s.stakeMissing === undefined) return undefined;
  if (!s.stakeMissing) return false;
  if (!s.hotkeys || !s.stakeHotkey) return undefined;
  if (s.hotkeys.length < MAX_HOTKEYS) return false;
  let unknown = false;
  for (const h of s.hotkeys) {
    if (lower(h) === lower(s.stakeHotkey)) continue;
    const stake = s.stakes[lower(h)];
    const credit = s.unclaimedBy?.[lower(h)];
    if (stake === undefined || credit === undefined) {
      unknown = true;
      continue;
    }
    if (stake !== 0n) continue;
    if (credit === 0n) return false;
    if (s.hotkeyDustRao === undefined) unknown = true;
    else if (credit <= s.hotkeyDustRao * RAO) return false;
  }
  return unknown ? undefined : true;
};

/** stake.set_full (critical condition, v3.2; the T14b review's alert): stake is missing (a validator's hotkey swap,
 * most likely), the hotkey set is full and only the owner can free a slot for the swap's new hotkey (slotBlocked), on
 * two readings: until the owner's removeHotkey (immediate) frees one, the vault refuses every deposit and withdrawal
 * and the stake can't come back into the price (I-6's way back is shut). */
export const setFull: Rule = {
  name: "stake.set_full",
  run(ctx) {
    if (!v32(ctx)) return [];
    const held = twice(ctx, "bittensor", slotBlocked);
    if (held === undefined) return unjudged(ctx, "stake.set_full");
    if (!held) return [];
    const s = ctx.snap.bittensor!.state;
    const facts: Record<string, string> = { "stake hotkey": lower(s.stakeHotkey as Hex) };
    for (const h of s.hotkeys ?? []) {
      if (lower(h) === facts["stake hotkey"]) continue;
      facts[`hotkey ${lower(h)}`] = `${formatUnits(s.stakes[lower(h)] ?? 0n, 9)} TAO staked, ${formatUnits(s.unclaimedBy?.[lower(h)] ?? 0n, 18)} TAO unclaimed`;
    }
    facts.missing = s.missingStakeRao === undefined ? "not read" : `${formatUnits(s.missingStakeRao, 9)} TAO`;
    facts.vault = addressLink("bittensor", ctx.cfg.deployment.vault);
    return [{ rule: "stake.set_full", key: "stake.set_full", subject: "Stake is missing and only the owner can free a hotkey slot", facts }];
  },
};

/** Each chain's role holders now, as the readings name them (the zero address isn't a holder). */
export function watchedRoles(snap: Snapshot): { chain: ChainName; address: Hex; roles: string[] }[] {
  const out: { chain: ChainName; address: Hex; roles: string[] }[] = [];
  const add = (chain: ChainName, a: Hex | undefined, role: string) => {
    if (!a || lower(a) === ZERO) return;
    const w = out.find((x) => x.chain === chain && x.address === lower(a));
    if (w) w.roles.push(role);
    else out.push({ chain, address: lower(a), roles: [role] });
  };
  const b = snap.base?.state;
  if (b) {
    for (const r of ["owner", "pendingOwner", "guardian", "pendingGuardian", "keeper"] as const) add("base", b[r], `frontDoor.${r}`);
    add("base", b.stakerOwner, "staker.owner");
    add("base", b.stakerPendingOwner, "staker.pendingOwner");
  }
  const v = snap.bittensor?.state;
  if (v) for (const r of ["owner", "pendingOwner", "guardian", "pendingGuardian", "keeper"] as const) add("bittensor", v[r], `vault.${r}`);
  return out;
}

/** Every role wallet whose code keys.delegated watches: the role holders, and the staker's and the vault's
 * treasuries. */
export function roleWallets(snap: Snapshot): { chain: ChainName; address: Hex; roles: string[] }[] {
  const out = watchedRoles(snap);
  const add = (chain: ChainName, a: Hex | undefined, role: string) => {
    if (!a || lower(a) === ZERO) return;
    const w = out.find((x) => x.chain === chain && x.address === lower(a));
    if (w) w.roles.push(role);
    else out.push({ chain, address: lower(a), roles: [role] });
  };
  add("base", snap.base?.state.stakerTreasury, "staker.treasury");
  add("bittensor", snap.bittensor?.state.treasury, "vault.treasury");
  return out;
}

/** What a code is, as an email says it. */
function codeIs(code: Hex): string {
  if (code === "0x") return "no code (an account)";
  if (DELEGATION.test(code)) return `an EIP-7702 delegation to 0x${code.slice(8)}`;
  return `contract code (${(code.length - 2) / 2} bytes, hash ${keccak256(code).slice(0, 10)}…)`;
}
/** An EIP-7702 delegation designator: 0xef0100 and the delegate's 20-byte address. */
const DELEGATION = /^0xef0100[0-9a-f]{40}$/;

interface CodeSeen {
  /** the baseline: the code first seen, or since its last change (its hash, and what it was) */
  first?: { hash: Hex; what: string };
  /** the code read on the last tick, when it differed from the baseline (a change counts once the code differs on
   * two reads in a row, the same code or not) */
  pending?: { hash: Hex; what: string };
}

type CodeKind = "account" | "delegation" | "contract";
/** What kind of code an email's description (codeIs) names. */
const kindOf = (what: string): CodeKind => (what.startsWith("no code") ? "account" : what.startsWith("an EIP-7702") ? "delegation" : "contract");

/** keys.delegated (critical, holds) and keys.code_changed (warning): a role wallet's code (read every tick, in the
 * same batch as the transaction counts) differs from its baseline, the code first seen or since its last change,
 * on two readings in a row (the same differing code or not: the latest is reported). Critical: an EIP-7702 delegation designator appearing on an account, a delegation to
 * another target, a contract's code changing, and anything else unexpected; a wallet already delegated when first
 * seen too (the monitor may start after the delegation). Only a warning: plain contract code appearing on an
 * account (a counterfactual Safe deployed at a role address: no key can put contract code there), and a
 * delegation removed. Each confirmed change becomes the baseline, so it is one alert, open until acknowledged.
 * Kept in meta (code_seen:{chain}:{address}), written only when it changes. */
export const keysDelegated: Rule = {
  name: "keys.delegated",
  raises: ["keys.code_changed"],
  run(ctx) {
    const out: Finding[] = [];
    for (const w of roleWallets(ctx.snap)) {
      const read = ctx.snap.codes?.[w.chain]?.[w.address];
      if (read === undefined) continue;
      const code = read.toLowerCase() as Hex;
      const now = { hash: keccak256(code), what: codeIs(code) };
      const k = `code_seen:${w.chain}:${w.address}`;
      let s: CodeSeen = {};
      try {
        s = ctx.meta[k] ? (JSON.parse(ctx.meta[k]) as CodeSeen) : {};
      } catch {
        s = {};
      }
      const save = (next: CodeSeen) => ctx.writes.meta.push({ k, v: JSON.stringify(next) });
      // the confirming reading's block: each occurrence of a change has its own alert key and hold id (a change
      // undone and made again is a new occurrence: a cleared hold id is never raised again, and an open alert
      // would send nothing new)
      const at = String(ctx.snap[w.chain]?.block ?? ctx.nowS);
      const occurrence = (rule: string, before: Hex | undefined) => `${rule}:${w.chain}:${w.address}:${before === undefined ? "new" : before.slice(0, 10)}:${now.hash.slice(0, 10)}:${at}`;
      const facts = (before: string) => ({ address: w.address, chain: w.chain, roles: w.roles.join(", "), before, now: now.what, block: at, explorer: addressLink(w.chain, w.address) });
      const critical = (before: string, beforeHash?: Hex) => {
        const id = occurrence("keys.delegated", beforeHash);
        out.push({
          rule: "keys.delegated",
          key: id,
          subject: `A Cascade role wallet's code changed (${w.roles.join(", ")}): assume its key is compromised`,
          facts: facts(before),
          hold: { id, summary: `the role wallet ${w.address} (${w.roles.join(", ")}) was delegated or its code changed` },
        });
      };
      const warning = (before: string, beforeHash: Hex) =>
        out.push({ rule: "keys.code_changed", key: occurrence("keys.code_changed", beforeHash), subject: `A Cascade role wallet's code changed (${w.roles.join(", ")})`, facts: facts(before) });
      // confirmed when the code differed from the baseline on the last read too, whatever it was then: a target
      // switched every read (D1, D2, D1…) still confirms, and the latest code is the one reported
      const twice = s.pending !== undefined;
      if (!s.first) {
        // first sight: an account or a contract is the baseline; a delegation is confirmed on the next read
        if (!DELEGATION.test(code)) save({ first: now });
        else if (twice) {
          critical("not seen before");
          save({ first: now });
        } else save({ pending: now });
      } else if (now.hash === s.first.hash) {
        if (s.pending) save({ first: s.first });
      } else if (!twice) {
        save({ first: s.first, pending: now });
      } else {
        // a change, read twice: judged by what the code was and is, then taken as the baseline (one alert each)
        const was = kindOf(s.first.what);
        const is = kindOf(now.what);
        // benign: plain contract code on an account (a counterfactual Safe deployed: no key can put it there),
        // or a delegation removed; everything else (a delegation set or moved, a contract's code changed) is not
        if ((was === "account" && is === "contract") || (was === "delegation" && is === "account")) warning(s.first.what, s.first.hash);
        else critical(s.first.what, s.first.hash);
        save({ first: now });
      }
    }
    return out;
  },
};

const sameRoles = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const keeperOnly = (roles: readonly string[]) => roles.every((r) => r.endsWith(".keeper"));
/** The meta mark counting a watched address's count readings in a row that were provably stale. */
const behindKey = (chain: ChainName, address: Hex) => `nonce_behind:${chain}:${address}`;
/** Safe's execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes): the call that
 * moves its nonce() */
const EXEC_TRANSACTION = "0x6a761202";

/** keys.unexplained_tx (critical: an address holding an owner, pending-owner or guardian role) and
 * keys.keeper_unexplained_tx (warning: an address holding only the keeper role): the address's count
 * (an account's transaction count, or a Safe's nonce()) is ahead of the transactions Cascade's logs
 * explain, and has been for unexplainedTxGraceS. The excess is then absorbed, so each one is reported
 * once. A count read below what is already known of it (provably from an older head) is judged by what is
 * known, for at most nonceBehindTicks readings in a row (meta nonce_behind:{chain}:{address}); a current count
 * behind what the logs explain is a new start at once. A tick with no count (its batch failed) still counts the
 * address's own transactions settled on it, each new on that tick only, and judges nothing; countUnreadTicks such
 * ticks in a row on a chain is the warning keys.count_unread (meta count_unread:{chain}). A newly watched address
 * starts at its current count. Writes the watched rows that changed. */
export const keys: Rule = {
  name: "keys",
  raises: ["keys.unexplained_tx", "keys.keeper_unexplained_tx", "keys.safe_unread", "keys.count_unread"],
  run(ctx) {
    const out: Finding[] = [];
    const stored = new Map(ctx.nonces.map((r) => [`${r.chain}:${lower(r.address)}`, r]));
    const holders = watchedRoles(ctx.snap);
    for (const chain of CHAINS) {
      // roles from this tick's reading of the chain; without one, the roles last stored
      const now = ctx.snap[chain]
        ? holders.filter((h) => h.chain === chain)
        : ctx.nonces.filter((r) => r.chain === chain && r.roles.length > 0).map((r) => ({ chain, address: lower(r.address), roles: r.roles }));
      const counted = new Set(now.map((h) => h.address));
      // addresses that hold no role any more: stop watching (and drop a stale-read mark, which would outlive the watch)
      for (const r of ctx.nonces) {
        if (r.chain !== chain || r.roles.length === 0 || counted.has(lower(r.address))) continue;
        ctx.writes.nonces.push({ ...r, roles: [] });
        const mark = behindKey(chain, lower(r.address));
        if (ctx.meta[mark]) ctx.writes.meta.push({ k: mark, v: "" });
      }
      const counts = Object.fromEntries(Object.entries(ctx.snap.nonces[chain]).map(([a, n]) => [lower(a as Hex), n]));
      const safes = Object.fromEntries(Object.entries(ctx.snap.safeNonces[chain] ?? {}).map(([a, n]) => [lower(a as Hex), n]));
      // keys.count_unread: the tick asks for the count of every address watched here (a row holding a role) in one
      // batch with the role wallets' code. When it fails (an RPC rate limit: 2026-11-01) the accounts judged by their
      // count (not a Safe, judged by its nonce(): keys.safe_unread) are judged by nothing below, and keys.delegated is
      // blind. Ticks in a row of it are counted in meta, and countUnreadTicks of them is a warning, which resolves on
      // the next tick that reads the counts
      const accounts = now.filter((h) => {
        const r = stored.get(`${chain}:${h.address}`);
        return r !== undefined && r.roles.length > 0 && !r.safe && safes[h.address] === undefined;
      });
      const unreadAccounts = accounts.filter((h) => counts[h.address] === undefined).map((h) => h.address);
      const countKey = `count_unread:${chain}`;
      const countsUnread = Number(ctx.meta[countKey] || 0);
      if (unreadAccounts.length > 0) {
        const n = countsUnread + 1;
        ctx.writes.meta.push({ k: countKey, v: String(n) });
        if (n >= ctx.t.countUnreadTicks) {
          out.push({
            rule: "keys.count_unread",
            key: `keys.count_unread:${chain}`,
            subject: `The watched keys' transaction counts on ${chain} haven't been read for ${n} ticks`,
            facts: { chain, ticks: String(n), addresses: unreadAccounts.join(", ") },
          });
        }
      } else if (countsUnread > 0) {
        ctx.writes.meta.push({ k: countKey, v: "" });
      }
      for (const h of now) {
        const row = stored.get(`${chain}:${h.address}`);
        const isSafe = safes[h.address] !== undefined;
        // a row once read as a Safe is judged only by its nonce(): a tick without it (its code misread) judges nothing
        // (its own transactions are still counted below), is counted in meta, and safeUnreadTicks in a row of them is a warning (never skipped silently forever)
        const unreadKey = `safe_unread:${chain}:${h.address}`;
        const unread = Number(ctx.meta[unreadKey] || 0);
        if (row?.safe && !isSafe) {
          const n = unread + 1;
          ctx.writes.meta.push({ k: unreadKey, v: String(n) });
          if (n >= ctx.t.safeUnreadTicks) {
            out.push({
              rule: "keys.safe_unread",
              key: `keys.safe_unread:${chain}:${h.address}`,
              subject: `A watched Safe's nonce() hasn't answered for ${n} ticks`,
              facts: { address: h.address, chain, roles: h.roles.join(", "), ticks: String(n), explorer: addressLink(chain, h.address) },
            });
          }
        } else if (isSafe && unread > 0) {
          ctx.writes.meta.push({ k: unreadKey, v: "" });
        }
        // an account's count moves only for what it sends; a Safe's nonce for what it executes, which
        // arrives as a transaction sent to it (or names it as the caller in an event's args). A row once read as a
        // Safe is one on a tick without its nonce() too
        const asSafe = isSafe || row?.safe === true;
        const mine = (t: TxRow) => lower(t.from) === h.address || (asSafe && t.to !== undefined && lower(t.to) === h.address);
        const own = ctx.newTxs.filter((t) => t.chain === chain && mine(t));
        /** one past the nonce of each of an account's own transactions settled now: its count is at least each */
        const ownNext = asSafe ? [] : own.flatMap((t) => (lower(t.from) === h.address && t.nonce !== undefined ? [t.nonce + 1] : []));
        const read = isSafe ? safes[h.address] : row?.safe ? undefined : counts[h.address];
        if (read === undefined) {
          // No count this tick: its batch failed (2026-11-01: publicnode answered it HTTP 429 on the tick the keeper's
          // roll settled, and the roll, never counted, was reported 15 minutes on), or a Safe's nonce() is unread. A
          // transaction is new on one tick only, so the address's own ones settled now are counted now all the same,
          // with what their nonces prove of the count; nothing is judged until a tick reads a count
          if (row) {
            const next: NonceRow = { ...row, roles: h.roles, seen: row.seen + own.length, nonce: Math.max(row.nonce, ...ownNext) };
            // an excess those nonces show first starts the grace now, as a count showing it would
            if (next.nonce - next.baseline - next.seen > 0 && row.nonce - row.baseline - row.seen <= 0) next.changedAt = ctx.nowS;
            if (next.seen !== row.seen || next.nonce !== row.nonce || next.changedAt !== row.changedAt || !sameRoles(next.roles, row.roles)) ctx.writes.nonces.push(next);
          }
          continue;
        }
        const count = Number(read);
        const safe = isSafe || row?.safe ? ({ safe: true } as const) : {};
        if (!row) {
          ctx.writes.nonces.push({ chain, address: h.address, roles: h.roles, baseline: count, seen: 0, nonce: count, changedAt: ctx.nowS, ...safe });
          continue;
        }
        // The count is read at the head in a request of its own, so a load-balanced node can answer it from an older
        // head than the logs'. (The keeper's roll reported as unexplained on 2026-10-31, at count 12, was taken for
        // this when the floor was added; its real cause, and 2026-11-01's at count 31, was the roll settling on a tick
        // whose count batch failed, so the roll was never counted: handled above. The floor stays as the defence
        // against a stale count.) What the count is known to be at least: the highest count already read (counts only
        // rise; a row just turned Safe has no nonce() read yet), one past the nonce of each of the account's own
        // transactions settled now, and for a Safe, whose nonce() is read in the reading's multicall at its block, one
        // more than it for each execTransaction logged in a later block. Only execTransaction moves nonce(): a
        // module's execTransactionFromModule doesn't, and counting it would lift the floor over an attacker's
        // execution.
        const reading = ctx.snap[chain]?.block;
        const executes = (t: TxRow) => t.to !== undefined && lower(t.to) === h.address && t.selector?.toLowerCase() === EXEC_TRANSACTION;
        const later = isSafe && reading !== undefined ? own.filter((t) => executes(t) && ctx.logs.inTx(chain, t.hash).some((l) => l.block > reading)).length : 0;
        const floor = Math.max(isSafe && !row.safe ? 0 : row.nonce, count + later, ...ownNext);
        // A count below that is provably stale: judged by the floor, for at most nonceBehindTicks readings in a row
        // (more is a reorg past the settle depth: the count is taken). Only this is tolerated: an unbounded floor
        // would hide for good a transaction reusing a nonce a deep reorg dropped
        const mark = behindKey(chain, h.address);
        const behind = Number(ctx.meta[mark]) || 0;
        let known = count;
        if (count < floor) {
          const n = behind + 1;
          if (n < ctx.t.nonceBehindTicks) {
            known = floor;
            ctx.writes.meta.push({ k: mark, v: String(n) });
          } else if (behind > 0) {
            ctx.writes.meta.push({ k: mark, v: "" });
          }
        } else if (behind > 0) {
          ctx.writes.meta.push({ k: mark, v: "" });
        }
        const next: NonceRow = { ...row, roles: h.roles, seen: row.seen + own.length, nonce: known, ...safe };
        let excess = known - next.baseline - next.seen;
        if (excess < 0) {
          // a current count behind what the logs explain (a transaction counted twice: not settled yet when the address
          // was first watched; or a reorg): start again from it at once, so nothing unexplained can fill the gap
          next.baseline = known - next.seen;
          excess = 0;
        }
        const before = row.nonce - row.baseline - row.seen;
        if (excess > 0 && before <= 0) next.changedAt = ctx.nowS;
        if (excess > 0 && ctx.nowS - next.changedAt >= ctx.t.unexplainedTxGraceS) {
          const rule = keeperOnly(h.roles) ? "keys.keeper_unexplained_tx" : "keys.unexplained_tx";
          out.push({
            rule,
            key: `${rule}:${chain}:${h.address}:${known}`,
            subject: `${excess} transaction${excess === 1 ? "" : "s"} from a Cascade ${keeperOnly(h.roles) ? "keeper" : "admin"} key that Cascade's logs don't explain`,
            facts: { address: h.address, chain, roles: h.roles.join(", "), count: String(known), unexplained: String(excess), explorer: addressLink(chain, h.address) },
          });
          next.baseline += excess;
        }
        const changed =
          next.baseline !== row.baseline || next.seen !== row.seen || next.nonce !== row.nonce || next.changedAt !== row.changedAt || !sameRoles(next.roles, row.roles) || next.safe !== row.safe;
        if (changed) ctx.writes.nonces.push(next);
      }
    }
    return out;
  },
};

export const ADMIN_RULES: Rule[] = [adminEvent, schedulerItems, hotkeySwitched, exitsState, ownerPending, ownerKind, setFull, keys, keysDelegated];
