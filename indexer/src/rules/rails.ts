import type { Hex } from "viem";
import type { Finding } from "../alerts.ts";
import type { ChainName, Config } from "../config.ts";
import { ITEMS_KEY, itemStatus, parseItems, type SchedulerRole, type TrackedItem } from "../scheduler.ts";
import type { BaseState, BitState, RailHalf } from "../snapshot.ts";
import { onset, type Readings, type RuleCtx, twice, unjudged, utc } from "./context.ts";
import type { Rule } from "./index.ts";

// v3.2 (spec §5, the residual beside row 4; Task 39b's finding, Task 57c): the rail between the chains is coherent only
// by operation. Each chain keeps its own bridges and primary in its scheduler, so after one side's primary is switched
// alone, or a guardian disables on the vault a non-primary bridge the front door still uses, both chains can read OPEN
// while every batch is refused at one end. Nothing is lost (the Bittensor adapter parks a refused batch, refunded after
// 14 days), but Base exits stop, and admin.exits_state doesn't fire.
//
// Two pairs, each read at one block per chain (each chain's one multicall, src/snapshot.ts RailHalf):
// - batches: the front door's primary A (a Base adapter) and A's Bittensor half A' (its remoteAdapter). A' must be
//   enabled on the vault (the vault takes a message only from a bridge it has enabled: CascadeBase._requireBridge).
// - payouts: the vault's primary B and B's Base half B'. B' must be known to the front door (it takes payouts from any
//   bridge it ever enabled, a disabled one too: CascadeFrontDoor._requireBridge, spec §3.2 H-2 i).
// And each pair's halves must name each other: the sender sends only to its remoteChainId (WrongDestination), and its
// half takes messages only from its own remoteAdapter (WrongSender) and names its remoteChainId as their source (an
// unknown peer to the vault or the front door otherwise).
//
// A primary disabled on its own side (Task 57c fix 1): while that chain's exits read closed, admin.exits_state reports
// it; once they read OPEN (a swap ended the guardian's hold, the primary still disabled until its Reopen) no other rule
// does, so it fires here, naming the bridge and its Reopen if one is pending: the front door's (no batch can close) and
// the vault's (no payout leaves). And the vault's disabled primary that the front door still sends through fires
// whatever the vault's exits: each batch closed parks in it, and only this rule can hold the keeper's closes (a hold
// rides only on an alert, src/alerts.ts reconcile). Where nothing parks (the front door's closes revert, the vault's
// payout sends revert), a closed chain stays admin.exits_state's alone.
//
// Not this rule's: the launch door not active on the vault (admin.exits_state's doors). A pending activation is never
// taken as enabled: while both sides' new halves are pending, the old rail still carries both ways (setPrimaryBridge
// needs the new bridge enabled), so a two-sided switch's window raises nothing; it fires once a switch leaves a pair
// refused now. A read that fails is unjudged (the rule can't see), never coherent.

const CHAINS: readonly ChainName[] = ["base", "bittensor"];
const lower = (a: Hex) => a.toLowerCase() as Hex;
/** CascadeTypes.sol's DoorState.Active */
const ACTIVE = 1;
const PARKS = (p: Hex) => `yes: each batch closed parks in ${p}, refunded to Base after 14 days`;

type Direction = "batches" | "payouts";

/** One way a pair is refused: the words that say why (after "the front door sends batches through A, "), and, for
 * batches, what happens to a batch closed (parked, or not, and why), first in the order a batch meets them. */
interface Refusal {
  why: string;
  effect: string;
  rank: number;
}

/** Where the scheduled activation that would fix a refused pair would sit: its chain's scheduler and the bridge (none:
 * nothing scheduled can fix it). */
interface Fix {
  chain: ChainName;
  role: SchedulerRole;
  bridge?: Hex;
}

/** A primary disabled on its own side, as a refusal of the pair: the bridge, its contract, and whether that chain's
 * exits read OPEN (undefined: unread). */
interface Disabled {
  bridge: Hex;
  on: "vault" | "front door";
  open?: boolean;
}

/** A pair refused (or carried: no refusals), with the activation that would fix it, and the disabled primary among its
 * refusals, if any. */
interface Judged {
  refused: Refusal[];
  sender: Hex;
  peer?: Hex;
  fix: Fix;
  disabled?: Disabled;
  /** R6 (ChatGPT R2 claim D): the batches are taken, but the vault's own primary is disabled: no payout rail */
  noPayoutRail?: true;
}

/** A pair judged: undefined when a read it needs failed (the rule can't see); moot when it carries nothing now, for a
 * reason other rules report; otherwise its refusals (none: it carries). */
type Verdict = undefined | { moot: true } | Judged;

const NO_CLOSE = "no: every close reverts, so no batch leaves Base";
/** A half not set up as the deploy's adapter on its chain (R4-O's fix round, Minor 8): fixed at deploy, nothing scheduled
 * fixes it */
const NOT_SET_UP_BATCHES = "no: the pair's settings are fixed at deploy, so its messages can't arrive as the deploy's rail's would; move both sides to a correct pair (runbook section 8)";
const NOT_SET_UP_PAYOUTS = "none as the deploy's rail's would: the pair's settings are fixed at deploy; move both sides to a correct pair (runbook section 8)";

/** The fields a bridge must share with the deploy's adapter on its chain: ops' rail check's (ops/src/v32/pairs.ts FIELDS,
 * C-L4), so the monitor refuses what ops refuses. */
const SETUP_FIELDS: Record<ChainName, readonly ("router" | "token" | "remoteSelector" | "alphaVault")[]> = {
  base: ["router", "token", "remoteSelector"],
  bittensor: ["router", "token", "remoteSelector", "alphaVault"],
};
const CHAIN_LABEL: Record<ChainName, string> = { base: "Base", bittensor: "Bittensor" };

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** How bridge `a`'s half on `chain` differs from the deploy's adapter there (its fields, said); [] for the deploy's
 * adapter itself or a half set up as it; undefined while a field of either is unread.
 *
 * One exception, as ops' pairFieldProblems has it (R4-O round 2, the coordinator's ruling): a Bittensor half may name
 * another AlphaVault than the deploy's adapter's only when it is the deploy's AlphaVault's announced migration target
 * (its migrationTarget(), not 0, which the snapshot reads each tick at the deploy adapter's own AlphaVault: deployAlpha,
 * R4-O round 4, so TOKENS may move to the new vault): ForeverMoney's vault after the migration. A reading of another vault
 * than the deploy adapter's, or the target unread, can't be judged. Any other address is refused, naming the target.
 *
 * Once the live target reads 0 (ForeverMoney's finishMigration may clear it; R4-O round 3), `recorded` is accepted
 * instead: the last non-zero target this rule read live (alphaTargetRecorded, the monitor's own record, kept in meta), so
 * no address that was not the live target when it was recorded is ever accepted; and only while the deploy's vault reads
 * its migration finished (R4-O round 4: cancelMigration clears the notice too, and then nothing moved). */
function setupDiffers(cfg: Config, r: Readings, chain: ChainName, a: Hex, recorded?: string): string[] | undefined {
  const ours = lower(chain === "base" ? cfg.deployment.baseAdapter : cfg.deployment.bitAdapter);
  if (a === ours) return [];
  const rails = (chain === "base" ? r.base : r.bittensor)?.rails;
  const out: string[] = [];
  for (const f of SETUP_FIELDS[chain]) {
    const got = rails?.[a]?.[f];
    const want = rails?.[ours]?.[f];
    if (got === undefined || want === undefined) return undefined;
    if (String(got).toLowerCase() === String(want).toLowerCase()) continue;
    const said = `its ${f}() is ${String(got)}, not ${String(want)} as the deploy's adapter's`;
    if (f !== "alphaVault") {
      out.push(said);
      continue;
    }
    const dep = r.bittensor?.deployAlpha;
    const target = dep?.migrationTarget;
    if (target === undefined || dep?.vault.toLowerCase() !== String(want).toLowerCase()) return undefined;
    if (target.toLowerCase() !== ZERO_ADDRESS && target.toLowerCase() === String(got).toLowerCase()) continue;
    const cleared = target.toLowerCase() === ZERO_ADDRESS;
    const matches = cleared && recorded !== undefined && recorded.toLowerCase() === String(got).toLowerCase();
    if (matches && dep.migrationFinished === undefined) return undefined;
    if (matches && dep.migrationFinished) continue;
    const said2 = recorded ? `; the last it announced was ${recorded}${matches ? ", but it reads no finished migration (a cancelled notice reads the same)" : ""}` : "";
    out.push(`${said}, nor the announced migration target of ${String(want)} (${cleared ? `none announced${said2}` : target})`);
  }
  return out;
}

/** A refusal for each of a pair's halves not set up as the deploy's adapter on its chain (`named` says the half);
 * whether a field was unread. */
function setupRefusals(cfg: Config, r: Readings, halves: readonly { chain: ChainName; a: Hex; named: string }[], effect: string, recorded?: string): { refused: Refusal[]; unread: boolean } {
  const refused: Refusal[] = [];
  let unread = false;
  for (const h of halves) {
    const d = setupDiffers(cfg, r, h.chain, h.a, recorded);
    if (d === undefined) unread = true;
    else if (d.length) refused.push({ why: `${h.named} is not set up as the deploy's adapter on ${CHAIN_LABEL[h.chain]} (${d.join(", ")})`, effect, rank: 1 });
  }
  return { refused, unread };
}
const NO_PAYOUT = "none: every payout send reverts, so none leaves Bittensor";

/** The sender's own primary disabled (PrimaryBridgeDisabled: nothing leaves through it). While that chain's exits read
 * closed it is admin.exits_state's, and nothing parks, so nothing to hold: moot. On an OPEN chain it is this rule's,
 * unless the launch door isn't active (moot: the door's state, not the bridge's). */
function senderDisabled(open: boolean | undefined, doorState: number | undefined, sender: Hex, on: Disabled["on"], fix: Fix, effect: string): Verdict {
  if (open === undefined) return undefined;
  if (!open) return { moot: true };
  if (doorState === undefined) return undefined;
  if (doorState !== ACTIVE) return { moot: true };
  return { sender, fix, disabled: { bridge: sender, on, open }, refused: [{ why: `which is disabled on the ${on}`, effect, rank: 0 }] };
}

/** Whether half `h` takes messages from `sender` on chain `chain` (its remoteAdapter and remoteChainId): true, what it
 * takes instead, or undefined while that can't be told. */
function takes(h: RailHalf | undefined, sender: Hex, chain: bigint): true | { remote: Hex; chain?: bigint } | undefined {
  if (h?.remote === undefined) return undefined;
  if (lower(h.remote) !== sender) return { remote: lower(h.remote), chain: h.remoteChainId };
  if (h.remoteChainId === undefined) return undefined;
  return h.remoteChainId === chain ? true : { remote: sender, chain: h.remoteChainId };
}
const takesOnly = (half: string, p: Hex, t: { remote: Hex; chain?: bigint }) => `its ${half} ${p} takes messages only from ${t.remote}${t.chain === undefined ? "" : ` on chain ${t.chain}`}`;

/** The batches pair: the front door's primary A and its Bittensor half A', which the vault must have enabled. */
function judgeBatches(cfg: Config, r: Readings, recorded?: string): Verdict {
  const { base, bittensor: bit } = r;
  if (!base || !bit || base.primaryBridge === undefined) return undefined;
  const a = lower(base.primaryBridge);
  const ha = base.rails?.[a];
  if (ha?.enabled === undefined) return undefined;
  // the front door's primary disabled: no batch closes; this rule's only while the front door's exits read OPEN
  if (!ha.enabled) return senderDisabled(base.exits?.open, bit.doorState, a, "front door", { chain: "base", role: "frontDoor", bridge: a }, NO_CLOSE);
  if (bit.doorState === undefined) return undefined;
  // the launch door not active on the vault: every batch is refused for the door, not the bridge
  if (bit.doorState !== ACTIVE) return { moot: true };
  const vaultChain = BigInt(cfg.deployment.bittensor.chainId);
  if (ha.remoteChainId !== undefined && ha.remoteChainId !== vaultChain) {
    return { sender: a, fix: { chain: "bittensor", role: "vault" }, refused: [{ why: `which sends to chain ${ha.remoteChainId}, not the vault's (${vaultChain})`, effect: NO_CLOSE, rank: 0 }] };
  }
  if (ha.remote === undefined) return undefined;
  let unread = ha.remoteChainId === undefined;
  const p = lower(ha.remote);
  const hp = bit.rails?.[p];
  const fix: Fix = { chain: "bittensor", role: "vault", bridge: p };
  const refused: Refusal[] = [];
  let disabled: Disabled | undefined;
  const back = takes(hp, a, BigInt(cfg.deployment.base.chainId));
  if (back === undefined) unread = true;
  else if (back !== true) {
    // another sender fails in CCIP at the half (WrongSender); another source chain is an unknown peer to the vault (parked)
    const ccip = back.remote !== a;
    refused.push({ why: takesOnly("Bittensor half", p, back), effect: ccip ? `no: each batch closed fails in CCIP at ${p}` : PARKS(p), rank: ccip ? 1 : 2 });
  }
  if (hp?.enabled === undefined) unread = true;
  else if (!hp.enabled) {
    // refused whoever's primary it is: the front door still sends every batch through it, and each parks. The vault's own
    // primary is named as such whatever its exits: while they read closed admin.exits_state reports the vault, but only
    // this alert holds the keeper's closes (Task 57c fix 1); never a moot return, so no refusal pushed above is dropped
    const own = bit.primaryBridge !== undefined && lower(bit.primaryBridge) === p;
    if (own) disabled = { bridge: p, on: "vault", open: bit.exits?.open };
    const not = hp.known === false ? "was never enabled" : hp.known ? "is disabled" : "is not enabled";
    refused.push({ why: own ? `its Bittensor half ${p}, the vault's primary, is disabled on the vault` : `its Bittensor half ${p} ${not} on the vault`, effect: PARKS(p), rank: 2 });
  }
  const setup = setupRefusals(cfg, r, [
    { chain: "base", a, named: a },
    { chain: "bittensor", a: p, named: `its Bittensor half ${p}` },
  ], NOT_SET_UP_BATCHES, recorded);
  if (setup.unread) unread = true;
  refused.push(...setup.refused);
  // R6 (ChatGPT R2 claim D): a pair the vault takes while its own primary is disabled (a switch made the front door's
  // side first): every batch is delivered, but the vault has no payout rail and defers each unstake in it. No activation
  // fixes it: the vault's setPrimaryBridge does. Fired whatever the vault's exits, for the hold, as a parking pair is
  if (!refused.length && !unread && bit.primaryBridge !== undefined && lower(bit.primaryBridge) !== p) {
    const vp = lower(bit.primaryBridge);
    const on = bit.rails?.[vp]?.enabled;
    if (on === undefined) unread = true;
    else if (!on) {
      const why = `the vault's primary ${vp} is disabled, so the vault has no payout rail and defers every unstake those batches carry`;
      refused.push({ why, effect: "no: each batch is delivered, but the vault defers its unstakes (no payout rail)", rank: 0 });
      return { sender: a, peer: p, fix: { chain: "bittensor", role: "vault" }, refused, disabled: { bridge: vp, on: "vault", open: bit.exits?.open }, noPayoutRail: true };
    }
  }
  // a pair refused for its setup alone: no activation fixes it
  const only = setup.refused.length > 0 && refused.length === setup.refused.length;
  const judged: Judged = { sender: a, peer: p, fix: only ? { chain: fix.chain, role: fix.role } : fix, refused, ...(disabled ? { disabled } : {}) };
  return refused.length || !unread ? judged : undefined;
}

/** The payouts pair: the vault's primary B and its Base half B', which the front door must know. */
function judgePayouts(cfg: Config, r: Readings, recorded?: string): Verdict {
  const { base, bittensor: bit } = r;
  if (!base || !bit || bit.primaryBridge === undefined) return undefined;
  const b = lower(bit.primaryBridge);
  const hb = bit.rails?.[b];
  if (hb?.enabled === undefined) return undefined;
  // the vault's primary disabled: no payout leaves; this rule's only while the vault's exits read OPEN
  if (!hb.enabled) return senderDisabled(bit.exits?.open, bit.doorState, b, "vault", { chain: "bittensor", role: "vault", bridge: b }, NO_PAYOUT);
  if (bit.doorState === undefined) return undefined;
  // the launch door not active: the vault sends it no payout (FrontDoorInactive)
  if (bit.doorState !== ACTIVE) return { moot: true };
  const doorChain = BigInt(cfg.deployment.base.chainId);
  if (hb.remoteChainId !== undefined && hb.remoteChainId !== doorChain) {
    return { sender: b, fix: { chain: "base", role: "frontDoor" }, refused: [{ why: `which sends to chain ${hb.remoteChainId}, not the front door's (${doorChain})`, effect: NO_PAYOUT, rank: 0 }] };
  }
  if (hb.remote === undefined) return undefined;
  let unread = hb.remoteChainId === undefined;
  const p = lower(hb.remote);
  const hp = base.rails?.[p];
  const refused: Refusal[] = [];
  const back = takes(hp, b, BigInt(cfg.deployment.bittensor.chainId));
  if (back === undefined) unread = true;
  else if (back !== true) refused.push({ why: takesOnly("Base half", p, back), effect: `fail in CCIP at ${p} until this is fixed (ccip.failure)`, rank: 1 });
  if (hp?.known === undefined) unread = true;
  else if (!hp.known) refused.push({ why: `its Base half ${p} was never enabled on the front door`, effect: `fail in CCIP at ${p} until this is fixed (ccip.failure)`, rank: 1 });
  const setup = setupRefusals(cfg, r, [
    { chain: "bittensor", a: b, named: b },
    { chain: "base", a: p, named: `its Base half ${p}` },
  ], NOT_SET_UP_PAYOUTS, recorded);
  if (setup.unread) unread = true;
  refused.push(...setup.refused);
  const only = setup.refused.length > 0 && refused.length === setup.refused.length;
  const judged: Judged = { sender: b, peer: p, fix: only ? { chain: "base", role: "frontDoor" } : { chain: "base", role: "frontDoor", bridge: p }, refused };
  return refused.length || !unread ? judged : undefined;
}

const JUDGE: Record<Direction, (cfg: Config, r: Readings, recorded?: string) => Verdict> = { batches: judgeBatches, payouts: judgePayouts };

/** The monitor's own record of the deploy's AlphaVault's migration target (R4-O round 3), kept in meta by that vault (the
 * deploy adapter's own: deployAlpha, R4-O round 4): each tick that reads a non-zero target writes it (when it changed),
 * so the record is always an address the monitor read as the live target, or one `pnpm alpha-target` read on chain.
 * What setupDiffers accepts once the live target reads 0 and the migration finished. */
export const alphaTargetKey = (vault: string) => `alpha_target_seen:${vault.toLowerCase()}`;
function alphaTargetRecorded(ctx: RuleCtx): string | undefined {
  const dep = ctx.snap.bittensor?.state.deployAlpha;
  if (!dep) return undefined;
  const key = alphaTargetKey(dep.vault);
  const live = dep.migrationTarget?.toLowerCase();
  if (live && live !== ZERO_ADDRESS) {
    if (ctx.meta[key] !== live) ctx.writes.meta.push({ k: key, v: live });
    return live;
  }
  return ctx.meta[key];
}

/** A half as an email says it stands on its chain's contract: the vault takes only an enabled bridge; the front door
 * also a disabled one it enabled before. */
function standing(h: RailHalf | undefined, on: "vault" | "front door"): string {
  if (h?.enabled === true) return "enabled";
  if (h?.known === false) return "never enabled";
  if (h?.enabled === false && h.known === true) return on === "vault" ? "disabled" : "disabled (it still takes payouts)";
  return "not read";
}

/** The pending activations (the lens reads them pending) of `half` on `role`'s scheduler: what would fix the pair (a
 * disabled primary's is its Reopen). */
function pendingFix(ctx: RuleCtx, { chain, role, bridge: half }: Fix): string {
  if (half === undefined) return "none scheduled";
  let items: TrackedItem[];
  try {
    items = parseItems(ctx.meta[ITEMS_KEY]);
  } catch {
    return "not known (the record of scheduled items doesn't read)";
  }
  const where = role === "vault" ? "the vault" : "the front door";
  const found = items
    .filter((i) => i.chain === chain && i.role === role && i.setter === "activateBridge" && i.args?.bridge?.toLowerCase() === half && !i.lapsed)
    .filter((i) => itemStatus(i, ctx.snap[chain]).status === "pending")
    .map((i) => `activateBridge(${half}) on ${where}, ready at ${utc(i.readyAt)}`);
  return found.length ? found.join("; ") : "none scheduled";
}

const CHAIN_OF: Record<Disabled["on"], string> = { vault: "Bittensor", "front door": "Base" };
const exitsAre = (open: boolean | undefined) => (open === undefined ? "not read" : open ? "OPEN" : "closed (admin.exits_state)");

function findingOf(ctx: RuleCtx, dir: Direction, v: Judged): Finding {
  const base = ctx.snap.base!;
  const bit = ctx.snap.bittensor!;
  const doorPrimary = base.state.primaryBridge === undefined ? undefined : lower(base.state.primaryBridge);
  const vaultPrimary = bit.state.primaryBridge === undefined ? undefined : lower(bit.state.primaryBridge);
  const doorHalf = doorPrimary === undefined ? undefined : base.state.rails?.[doorPrimary]?.remote;
  const vaultHalf = vaultPrimary === undefined ? undefined : bit.state.rails?.[vaultPrimary]?.remote;
  const refused = [...v.refused].sort((x, y) => x.rank - y.rank);
  const lead = dir === "batches" ? `the front door sends batches through ${v.sender}` : `the vault sends payouts through ${v.sender}`;
  const why = refused[0].why.startsWith("which") ? `${lead}, ${refused[0].why}` : `${lead}, and ${refused.map((x) => x.why).join(", and ")}`;
  const parks = dir === "batches" && refused[0].effect.startsWith("yes");
  const facts: Record<string, string> = {
    direction: dir,
    "the front door's primary bridge": doorPrimary ?? "not read",
    "its Bittensor half": doorHalf ? lower(doorHalf) : "not read",
    "on the vault": standing(doorHalf ? bit.state.rails?.[lower(doorHalf)] : undefined, "vault"),
    "the vault's primary bridge": vaultPrimary ?? "not read",
    "its Base half": vaultHalf ? lower(vaultHalf) : "not read",
    "on the front door": standing(vaultHalf ? base.state.rails?.[lower(vaultHalf)] : undefined, "front door"),
    why,
    // a primary disabled on its own side: the bridge, its chain, and that chain's exits
    ...(v.disabled ? { "disabled primary": `${v.disabled.bridge} on the ${v.disabled.on} (${CHAIN_OF[v.disabled.on]})`, "its exits": exitsAre(v.disabled.open) } : {}),
    ...(dir === "batches" ? { parked: refused[0].effect } : { "payouts sent": refused[0].effect }),
    "pending to fix it": pendingFix(ctx, v.fix),
    "Base block": String(base.block),
    "Bittensor block": String(bit.block),
  };
  const what = v.disabled ? `The ${v.disabled.on}'s primary bridge is disabled` : "The two chains disagree on the bridge";
  const effect = v.noPayoutRail ? "unstakes from Base are deferred" : dir === "batches" ? `deposits from Base are refused${parks ? " and parked" : ""}` : "payouts to Base are refused";
  return {
    rule: "rails.incoherent",
    key: `rails.incoherent:${dir}`,
    subject: `${what}: ${effect}`,
    facts,
  };
}

/** The hold's summary: how the pair is refused, in a few words. */
function holdSummary(dir: Direction, v: Judged, f: Finding): string {
  if (v.noPayoutRail) return `the front door sends batches through ${v.sender} while the vault's primary ${v.disabled?.bridge} is disabled`;
  const own = v.disabled?.bridge === v.sender ? `is disabled on the ${v.disabled.on}` : undefined;
  const refuser =
    own ?? (dir === "batches" ? (f.facts.parked.startsWith("yes") ? "the vault refuses" : "can't deliver them") : f.facts.why.includes("never enabled on the front door") ? "the front door refuses" : "can't deliver them");
  return `${dir === "batches" ? "the front door sends batches" : "the vault sends payouts"} through ${v.sender}, which ${refuser}`;
}

/** rails.incoherent (critical condition, v3.2; Task 57c): either pair is refused at one end now, on two readings of
 * both chains in a row, one alert per pair: the two chains disagree, or a primary is disabled on an OPEN chain, or the
 * vault's disabled primary still carries the front door's batches (whatever the vault's exits: fix 1). It holds the
 * keeper on its first tick (its closes would park batches into a refused rail for 14 days; under the founder's ruling
 * the hold stops the rest too). Unjudged while a read it needs is missing. */
export const railsIncoherent: Rule = {
  name: "rails.incoherent",
  run(ctx) {
    if (ctx.cfg.deployment.version !== "v3.2") return [];
    const out: Finding[] = [];
    const recorded = alphaTargetRecorded(ctx);
    for (const dir of ["batches", "payouts"] as const) {
      const key = `rails.incoherent:${dir}`;
      const cond = (r: Readings) => {
        const v = JUDGE[dir](ctx.cfg, r, recorded);
        return v === undefined ? undefined : "refused" in v && v.refused.length > 0;
      };
      const held = twice(ctx, CHAINS, cond);
      if (held === undefined) {
        unjudged(ctx, "rails.incoherent", key);
        continue;
      }
      if (!held) continue;
      const v = JUDGE[dir](ctx.cfg, { base: ctx.snap.base!.state as BaseState, bittensor: ctx.snap.bittensor!.state as BitState }, recorded) as Judged;
      const f = findingOf(ctx, dir, v);
      if (onset(ctx, CHAINS, cond)) f.hold = { id: `${key}:${ctx.previous.base!.block}:${ctx.previous.bittensor!.block}`, summary: holdSummary(dir, v, f) };
      out.push(f);
    }
    return out;
  },
};

export const RAIL_RULES: Rule[] = [railsIncoherent];
