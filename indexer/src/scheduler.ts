import { decodeFunctionData, encodeFunctionData, formatUnits, type Hex, stringToHex } from "viem";
import { EXECUTE_WINDOW_S, instrumentOf, limitSetterOf, schedulableOf } from "./abi.ts";
import type { ChainName } from "./config.ts";
import type { StoredLog } from "./logs.ts";
import type { BaseState, BitState, ChainReading, Exits, ScheduledItem } from "./snapshot.ts";

// v3.2's scheduler as the monitor follows it (spec §3.6). One source for the admin rules (src/rules/admin.ts) and the
// security page (src/flow.ts): the record of the items scheduled and not yet closed, which admin.scheduled keeps in
// meta (ITEMS_KEY), each item decoded once from its Scheduled's calldata; and itemStatus, which judges an item by the
// lens's scheduled(id) and the clocks. An item the lens hasn't read is unknown, never "nothing pending".

/** The contracts with a scheduler: the vault (Bittensor) and the front door (Base). */
export type SchedulerRole = "vault" | "frontDoor";

/** The meta key of the record. */
export const ITEMS_KEY = "scheduled_items";

/** CascadeConstants.sol GUARDIAN_DELAY (8 days), the longest of the scheduler's delays: an item's readyBlock is at most
 * half of it in its chain's calibrated blocks past the block it was scheduled in. */
export const LONGEST_DELAY_S = 8 * 86_400;

/** Half of `secs` in blocks of `msPerBlock` milliseconds, rounded up: CascadeBase._halfInBlocks (Revision 28). */
export function halfInBlocks(secs: number, msPerBlock: number): bigint {
  const two = 2n * BigInt(msPerBlock);
  return (BigInt(secs) * 1_000n + two - 1n) / two;
}

/** The last block of an item's window in blocks: its readyBlock plus half EXECUTE_WINDOW in calibrated blocks. */
export const windowEndBlock = (readyBlock: bigint, msPerBlock: number): bigint => readyBlock + halfInBlocks(EXECUTE_WINDOW_S, msPerBlock);

/** Whether an item has lapsed at `at` (a reading's block and time), as CascadeBase._lapsed decides (Revision 28): past
 * readyAt + EXECUTE_WINDOW and past its window in blocks, both. Never while its window in time runs; undefined past it
 * while its window in blocks can't be told (MS_PER_BLOCK unread): never called lapsed while the contract may still run it. */
export function lapsedAt(readyAt: number, readyBlock: bigint, msPerBlock: number | undefined, at: { block: bigint; time: number }): boolean | undefined {
  if (at.time <= readyAt + EXECUTE_WINDOW_S) return false;
  if (msPerBlock === undefined) return undefined;
  return at.block > windowEndBlock(readyBlock, msPerBlock);
}

/** The last block an item scheduled in block `scheduledIn` can still run in: its readyBlock is at most half the longest
 * delay in calibrated blocks past it, and its window in blocks half EXECUTE_WINDOW more. */
export const lastWindowBlock = (scheduledIn: bigint, msPerBlock: number): bigint => scheduledIn + halfInBlocks(LONGEST_DELAY_S, msPerBlock) + halfInBlocks(EXECUTE_WINDOW_S, msPerBlock);

/** Whether an item can no longer run once the stored logs reach `settled`: past its window in time, and past the last block
 * its window in blocks can end at (lastWindowBlock). False while MS_PER_BLOCK is unread. The record forgets an item, and a
 * refused one stops counting, only then. */
export function pastBothWindows(item: Pick<TrackedItem, "readyAt" | "block">, settled: { block: bigint; time: number }, msPerBlock: number | undefined): boolean {
  if (settled.time <= item.readyAt + EXECUTE_WINDOW_S || msPerBlock === undefined) return false;
  return settled.block > lastWindowBlock(BigInt(item.block), msPerBlock);
}
/** At most this many recorded items are read each tick (the newest first): a key scheduling hundreds can't make the
 * reading's multicall unbounded. */
export const MAX_ITEMS_READ = 64;
/** The live items the record holds at most: four times the read slots, so the record outlasts a burst the reads take
 * a few ticks over, and about 256 KB at most (an item is under 1 KB: its calldata is at most three words), an eighth of
 * D1's 2 MB value, so the tick's commit can't fail on it. Honest use has a handful pending. Past it a Scheduled is still
 * emailed but refused (kept apart, REFUSED_KEY), and admin.record_full (critical) says how many. */
export const MAX_LIVE_ITEMS = 256;
/** The finished items (`lapsed`: past their window, killed, or reverting at execute) kept until their window passes,
 * at most: beyond it the soonest forgotten go first. They take no live slot and are read by nothing. */
export const MAX_FINISHED_ITEMS = 256;

/** The meta key of the items refused at the live cap: each still counts (admin.record_full) until it is finished
 * (executed, cancelled, pruned, or past its window by the stored logs) or taken into the record. */
export const REFUSED_KEY = "scheduled_refused";
/** The refused items kept in full at most (the oldest; about 256 KB, a separate value from the record's): each is
 * taken into the record, oldest first, on a later tick with room. Past it only a count and the last window's end are
 * kept per chain, which clear by time alone (such an item can't be matched by its id, nor taken in). */
export const MAX_REFUSED_ITEMS = 256;

/** The items refused at the live cap, as meta REFUSED_KEY keeps them. */
export interface Refused {
  /** in full, oldest first, at most MAX_REFUSED_ITEMS */
  items: TrackedItem[];
  /** those past MAX_REFUSED_ITEMS, per chain: how many, when the last one's window in time ends (readyAt +
   * EXECUTE_WINDOW_S), and the latest block one was scheduled in (its window in blocks ends by lastWindowBlock of it) */
  more: Partial<Record<ChainName, { n: number; until: number; lastBlock?: string }>>;
}

/** CascadeTypes.sol's Kind, by its uint8. */
export const KINDS = ["Ordinary", "GuardianSwap", "Reopen"] as const;
export const kindName = (k: number): string => KINDS[k] ?? `kind ${k}`;

/** A scheduled item as the record keeps it, from its Scheduled log: where it is, its id, kind, selector, readyAt and
 * calldata, the setter and arguments decoded from that calldata (the arguments as plain strings: decimal integers,
 * lowercase hex), and what the rules have reported of it. */
export interface TrackedItem {
  chain: ChainName;
  role: SchedulerRole;
  id: Hex;
  kind: number;
  selector: Hex;
  readyAt: number;
  data: Hex;
  /** absent when the calldata names no setter this contract schedules */
  setter?: string;
  /** absent when the calldata doesn't decode */
  args?: Record<string, string>;
  /** false: the calldata isn't the canonical encoding of its arguments (dirty bits), so it can't run */
  canonical?: boolean;
  /** the Scheduled log's uid, block and transaction */
  uid: Hex;
  block: string;
  tx: Hex;
  /** finished: it can no longer run (past its window, killed by a closure or stamp, or reverting at execute), and
   * admin.lapsed has said so. Read by nothing, judged by nothing, shown nowhere; forgotten once its window passes */
  lapsed?: boolean;
  /** whether it would loosen a limit at execute, as last confirmed (admin.item_loosens) */
  loosens?: boolean;
}

/** The record, read back: [] when there is none. A record that isn't the list this module writes throws (a rule
 * reading it fails loudly, never as "nothing pending"). */
export function parseItems(json: string | undefined): TrackedItem[] {
  if (json === undefined || json === "") return [];
  const x = JSON.parse(json) as unknown;
  if (!Array.isArray(x) || !x.every(isItem)) throw new Error(`meta ${ITEMS_KEY} isn't a list of scheduled items`);
  return x;
}

function isItem(i: unknown): i is TrackedItem {
  const o = i as TrackedItem | null;
  return !!o && typeof o.id === "string" && (o.chain === "base" || o.chain === "bittensor") && (o.role === "vault" || o.role === "frontDoor") && Number.isSafeInteger(o.readyAt) && Number.isSafeInteger(o.kind);
}

/** The refused items, read back: none when there are none. Anything else this module doesn't write throws (a rule
 * reading it fails loudly, never as "nothing refused"). */
export function parseRefused(json: string | undefined): Refused {
  if (json === undefined || json === "") return { items: [], more: {} };
  const x = JSON.parse(json) as Refused | null;
  const count = (m: unknown) => {
    const o = m as { n: number; until: number; lastBlock?: string } | undefined;
    return o === undefined || (!!o && Number.isSafeInteger(o.n) && o.n > 0 && Number.isSafeInteger(o.until) && (o.lastBlock === undefined || /^\d+$/.test(o.lastBlock)));
  };
  const ok =
    !!x && typeof x === "object" && Array.isArray(x.items) && x.items.every(isItem) && !!x.more && typeof x.more === "object" && Object.keys(x.more).every((k) => k === "base" || k === "bittensor") && count(x.more.base) && count(x.more.bittensor);
  if (!ok) throw new Error(`meta ${REFUSED_KEY} isn't the refused items`);
  return x;
}

/** The ids to read through the lenses this tick: this tick's new Scheduled, then the record's live items (never a
 * finished one), the newest first, each once, at most MAX_ITEMS_READ. A record that doesn't read is left out here
 * (admin.scheduled reports it). */
export function scheduledIdsOf(json: string | undefined, newLogs: readonly StoredLog[]): { chain: ChainName; id: Hex }[] {
  let items: TrackedItem[] = [];
  try {
    items = parseItems(json);
  } catch {
    items = [];
  }
  const fresh = newLogs.filter((l) => (l.contract === "vault" || l.contract === "frontDoor") && l.event === "Scheduled").map((l) => ({ chain: l.chain, id: String(l.args.id).toLowerCase() as Hex }));
  const seen = new Set<string>();
  const out: { chain: ChainName; id: Hex }[] = [];
  const live = items.filter((i) => !i.lapsed);
  for (const x of [...fresh.reverse(), ...[...live].reverse().map((i) => ({ chain: i.chain, id: i.id }))]) {
    const k = `${x.chain}:${x.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out.slice(0, MAX_ITEMS_READ);
}

const plain = (v: unknown): string => (typeof v === "string" ? v.toLowerCase() : String(v));

/** A Scheduled's calldata decoded with the contract's setter ABI (abi.ts SCHEDULABLE): the setter, its arguments as
 * plain strings, and whether the calldata is exactly their canonical encoding (re-encoded and compared, so a dirty
 * sub-word argument, which the setter's decoder refuses at execute, is caught). Undefined for a selector the contract
 * doesn't schedule. */
export function decodeItem(role: SchedulerRole, data: Hex): { setter: string; args?: Record<string, string>; canonical: boolean } | undefined {
  const fn = schedulableOf(role, data);
  if (!fn) return undefined;
  let values: readonly unknown[];
  try {
    values = (decodeFunctionData({ abi: [fn], data }).args ?? []) as readonly unknown[];
  } catch {
    return { setter: fn.name, canonical: false };
  }
  const args = Object.fromEntries(fn.inputs.map((p, i) => [p.name ?? `argument ${i}`, plain(values[i])]));
  let canonical = false;
  try {
    canonical = encodeFunctionData({ abi: [fn], functionName: fn.name, args: values } as never).toLowerCase() === data.toLowerCase();
  } catch {
    canonical = false;
  }
  return { setter: fn.name, args, canonical };
}

type Unit = "wei" | "rao" | "s" | "bps";

/** The unit of each setter argument that has one, keyed `setter.parameter`. */
const UNITS: Readonly<Record<string, Unit>> = {
  "setMaxTotalAssets.amount": "wei",
  "setOutflowLimits.bps": "bps",
  "setOutflowLimits.minDaily": "wei",
  "setOutflowLimits.globalBps": "bps",
  "setMessageLimits.maxEntryValue_": "wei",
  "setMessageLimits.maxMessageValue_": "wei",
  "setFeeLimits.bps": "bps",
  "setFeeLimits.abs_": "wei",
  "setPayoutDelay.delay": "s",
  "setRewardVesting.period": "s",
  "setIdleBuffer.bps": "bps",
  "setRewardCut.bps": "bps",
  "moveStake.rao": "rao",
  "writeOffMissingStake.rao": "rao",
  "setMaxDeliverySlippage.bps": "bps",
  "setBatchInterval.interval": "s",
  "setMaxBatchValue.value": "wei",
};

const isInt = (s: string) => /^\d+$/.test(s);
const hours = (s: string) => `${Number((Number(s) / 3600).toFixed(2))} h`;

/** A value as a direction line shows it: TAO for wei and rao, seconds with hours, bps; anything else as it is. */
function short(unit: Unit | undefined, v: string): string {
  if (!unit || !isInt(v)) return v;
  if (unit === "wei") return `${formatUnits(BigInt(v), 18)} TAO`;
  if (unit === "rao") return `${formatUnits(BigInt(v), 9)} TAO`;
  if (unit === "s") return `${v} s (${hours(v)})`;
  return `${v} bps`;
}

/** An argument as an email shows it: with its unit, and the raw integer beside a TAO amount. */
export function formatArg(setter: string, name: string, v: string): string {
  const unit = UNITS[`${setter}.${name}`];
  if (!unit || !isInt(v)) return v;
  if (unit === "wei") return `${formatUnits(BigInt(v), 18)} TAO (${v} wei)`;
  if (unit === "rao") return `${formatUnits(BigInt(v), 9)} TAO (${v} rao)`;
  if (unit === "bps") return `${v} bps (${Number(v) / 100}%)`;
  return short(unit, v);
}

/** One limit a setter writes: the argument, the reading's current value, and which way loosens it (spec §3.6's
 * table; "change": any new value does). */
interface Field<S> {
  label: string | ((args: Record<string, string>) => string);
  param: string;
  unit?: Unit;
  dir: "up" | "down" | "change";
  now: (s: S, args: Record<string, string>) => bigint | number | string | undefined;
}

const VAULT_DIRECTIONS: Readonly<Record<string, Field<BitState>[]>> = {
  setOutflowLimits: [
    { label: "maxDailyOutflowBps", param: "bps", unit: "bps", dir: "up", now: (s) => s.maxDailyOutflowBps },
    { label: "minDailyOutflow", param: "minDaily", unit: "wei", dir: "up", now: (s) => s.minDailyOutflow },
    { label: "globalOutflowBps", param: "globalBps", unit: "bps", dir: "up", now: (s) => s.globalOutflowBps },
  ],
  setMessageLimits: [
    { label: "maxEntryValue", param: "maxEntryValue_", unit: "wei", dir: "up", now: (s) => s.maxEntryValue },
    { label: "maxMessageValue", param: "maxMessageValue_", unit: "wei", dir: "up", now: (s) => s.maxMessageValue },
    { label: "minChunk", param: "minChunk_", dir: "down", now: (s) => s.minChunk },
  ],
  setFeeLimits: [
    { label: "maxFeeBps", param: "bps", unit: "bps", dir: "up", now: (s) => s.maxFeeBps },
    { label: "maxFeeAbs", param: "abs_", unit: "wei", dir: "up", now: (s) => s.maxFeeAbs },
  ],
  setPayoutDelay: [{ label: "payoutDelay", param: "delay", unit: "s", dir: "down", now: (s) => s.payoutDelay }],
  setRewardCut: [
    { label: "treasury", param: "treasury_", dir: "change", now: (s) => s.treasury },
    { label: "rewardCutBps", param: "bps", unit: "bps", dir: "up", now: (s) => s.rewardCutBps },
  ],
  setRewardVesting: [{ label: "rewardVesting", param: "period", unit: "s", dir: "down", now: (s) => s.rewardVesting }],
  setMaxTotalAssets: [{ label: "maxTotalAssets", param: "amount", unit: "wei", dir: "up", now: (s) => s.maxTotalAssets }],
  setIdleBuffer: [{ label: "idleBufferBps", param: "bps", unit: "bps", dir: "down", now: (s) => s.idleBufferBps }],
};

const DOOR_DIRECTIONS: Readonly<Record<string, Field<BaseState>[]>> = {
  setMaxDeliverySlippage: [{ label: "maxDeliverySlippageBps", param: "bps", unit: "bps", dir: "up", now: (s) => s.maxDeliverySlippageBps }],
  setBatchInterval: [{ label: "batchInterval", param: "interval", unit: "s", dir: "down", now: (s) => s.batchInterval }],
  setMaxBatchValue: [{ label: "maxBatchValue", param: "value", unit: "wei", dir: "up", now: (s) => s.maxBatchValue }],
  setMinPoolLiquidity: [
    {
      label: (a) => `minPoolLiquidity(${a.index})`,
      param: "value",
      dir: "down",
      now: (s, a) => (a.index === "0" ? s.minPoolLiquidity?.taoWeth : a.index === "1" ? s.minPoolLiquidity?.wethUsdc : undefined),
    },
  ],
};

/** Whether an item's setter would loosen a limit at execute against the reading's current values (a multi-field setter
 * loosens if any field does; spec §3.6), with a "now, at execute" line per field: true, false, or undefined while a
 * field it needs is unread (`unread` names them) and none loosens. Undefined for a setter with no direction (always
 * scheduled: the activations, the guardian, the owner, the oracle and swapper, the stake hotkey, moveStake, the
 * write-off). */
export function directionOf(
  item: Pick<TrackedItem, "role" | "setter" | "args">,
  state: BitState | BaseState | undefined,
): { loosens: boolean | undefined; lines: [string, string][]; unread: string[]; reverts?: string } | undefined {
  if (!item.setter || !item.args) return undefined;
  // setMinPoolLiquidity names a pool by index (0 TAO/WETH, 1 WETH/USDC) and reverts InvalidParameter for any other,
  // directly or at execute: such an item can never run
  if (item.role === "frontDoor" && item.setter === "setMinPoolLiquidity" && item.args.index !== "0" && item.args.index !== "1") {
    return { loosens: undefined, lines: [], unread: [], reverts: `index ${item.args.index} names no pool` };
  }
  const fields = (item.role === "vault" ? VAULT_DIRECTIONS : DOOR_DIRECTIONS)[item.setter] as Field<BitState | BaseState>[] | undefined;
  if (!fields) return undefined;
  const args = item.args;
  let loosens = false;
  const lines: [string, string][] = [];
  const unread: string[] = [];
  for (const f of fields) {
    const label = typeof f.label === "function" ? f.label(args) : f.label;
    const then = args[f.param];
    const cur = state === undefined ? undefined : f.now(state, args);
    if (cur === undefined || then === undefined) {
      unread.push(label);
      continue;
    }
    const now = typeof cur === "string" ? cur.toLowerCase() : String(cur);
    const l = f.dir === "change" ? now !== then.toLowerCase() : isInt(now) && isInt(then) ? (f.dir === "up" ? BigInt(then) > BigInt(now) : BigInt(then) < BigInt(now)) : true;
    if (l) loosens = true;
    lines.push([label, `${short(f.unit, now)} now, ${short(f.unit, then)} at execute${l ? ` (loosens: ${f.dir === "change" ? "a change" : f.dir})` : ""}`]);
  }
  return { loosens: loosens ? true : unread.length ? undefined : false, lines, unread };
}

/** What becomes of an item, by its chain's reading (none, or a stale one, is unknown):
 * - unknown: the lens didn't read it, or reads another scheduling of the same calldata (whose Scheduled isn't stored
 *   yet), or a clock it needs is unread;
 * - gone: the lens holds nothing under its id (executed, cancelled or pruned: its event closes the record);
 * - dead: its kind's clock (an Ordinary item's both, the others' the owner's) reached its scheduledAt, so it can never
 *   run (spec §3.6: a closure, or an owner stamp, since it was scheduled);
 * - lapsed: past both its windows at the reading, unexecuted: readyAt + EXECUTE_WINDOW in time, and its readyBlock plus
 *   half EXECUTE_WINDOW in its chain's calibrated blocks (MS_PER_BLOCK) in blocks (CascadeBase._lapsed, Revision 28);
 *   past its window in time with MS_PER_BLOCK unread, unknown (`blocksUnread`);
 * - pending: held, alive and not lapsed, `read` being the lens's answer. */
export function itemStatus(
  item: Pick<TrackedItem, "id" | "kind" | "readyAt">,
  r: ChainReading<{ scheduled?: Record<Hex, ScheduledItem>; exits?: Exits; msPerBlock?: number }> | undefined,
):
  | { status: "gone" }
  | { status: "unknown"; blocksUnread?: true }
  | { status: "lapsed"; endBlock: bigint }
  | { status: "dead"; clock: number; scheduledAt: number }
  | { status: "pending"; read: ScheduledItem } {
  const read = r?.state.scheduled?.[item.id];
  if (!r || read === undefined) return { status: "unknown" };
  if (read.readyAt === 0) return { status: "gone" };
  if (read.readyAt !== item.readyAt) return { status: "unknown" };
  const e = r.state.exits;
  const owner = e?.lastOwnerClose;
  const guardian = e?.lastGuardianClose;
  const clock = item.kind === 0 ? (owner === undefined || guardian === undefined ? undefined : Math.max(owner, guardian)) : owner;
  if (clock !== undefined && clock >= read.scheduledAt) return { status: "dead", clock, scheduledAt: read.scheduledAt };
  const ms = r.state.msPerBlock;
  const lapsed = lapsedAt(item.readyAt, read.readyBlock, ms, r);
  if (lapsed === true) return { status: "lapsed", endBlock: windowEndBlock(read.readyBlock, ms as number) };
  // past its window in time with its window in blocks unreadable (MS_PER_BLOCK unread): admin.scheduled says so
  if (lapsed === undefined) return { status: "unknown", blocksUnread: true };
  if (clock === undefined) return { status: "unknown" };
  return { status: "pending", read };
}

const same = (a: unknown, b: string | undefined) => b !== undefined && String(a).toLowerCase() === b.toLowerCase();
/** The name the front door's LimitSet logs (a bytes32) for each of its scheduled limit setters. */
const DOOR_LIMIT_NAMES: Readonly<Record<string, string>> = { setBatchInterval: "batchInterval", setMaxBatchValue: "maxBatchValue", setMinPoolLiquidity: "minPoolLiquidity" };

/** Whether an admin event is one the item's own execute logs: of its contract, an event its setter emits, naming what
 * the item's arguments name (the guardian, owner, bridge, door, hotkey, oracle or swapper; a LimitSet's setter or name;
 * an ExitsReopened's instrument). Anything else in the transaction (a direct change batched beside it) is not. */
export function isEffectOf(item: Pick<TrackedItem, "role" | "setter" | "args">, l: Pick<StoredLog, "contract" | "event" | "args">): boolean {
  const s = item.setter;
  const a = item.args ?? {};
  if (!s || l.contract !== item.role) return false;
  switch (l.event) {
    case "GuardianSet":
      return s === "setGuardian" && same(l.args.guardian, a.newGuardian);
    case "OwnershipTransferStarted":
      return s === "transferOwnership" && same(l.args.newOwner, a.newOwner);
    case "BridgeActivated":
      return s === "activateBridge" && same(l.args.bridge, a.bridge);
    case "FrontDoorActivated":
      return s === "activateFrontDoor" && same(l.args.chain, a.chain) && same(l.args.addr, a.addr);
    case "ExitsReopened":
      return instrumentOf(String(l.args.instrument)) === s;
    // setStakeHotkey logs StakeHotkeySet alone: it needs the hotkey listed already, and never lists one (a HotkeyAdded
    // beside it is a direct addHotkey, emailed on its own)
    case "StakeHotkeySet":
      return s === "setStakeHotkey" && same(l.args.hotkey, a.h);
    case "StakeWrittenOff":
      return s === "writeOffMissingStake";
    case "OutflowLimitsSet":
      return s === "setOutflowLimits";
    case "RewardCutSet":
      return s === "setRewardCut" && same(l.args.treasury, a.treasury_);
    case "OracleSet":
      return s === "setOracle" && same(l.args.oracle, a.newOracle);
    case "SwapperSet":
      return s === "setSwapper" && same(l.args.swapper, a.newSwapper);
    case "MaxDeliverySlippageSet":
      return s === "setMaxDeliverySlippage" && same(l.args.bps, a.bps);
    case "LimitSet":
      return l.contract === "vault" ? limitSetterOf(String(l.args.selector)) === s : DOOR_LIMIT_NAMES[s] !== undefined && same(l.args.name, stringToHex(DOOR_LIMIT_NAMES[s], { size: 32 }));
    default:
      return false;
  }
}
