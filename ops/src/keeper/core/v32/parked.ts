import { type Address, decodeEventLog, formatEther, type Hex } from "viem";
import { PARK_EVENTS } from "../abi.ts";
import { type Done, type KeeperDeps, type KeeperTarget, keeperSend, withMessage } from "../actions.ts";
import { adapterPairs, pairOfBit } from "../deployment.ts";
import { type Action, actionKey, type ParkJob, type ParkRef, type State } from "../due.ts";
import { RevertedOnChain } from "../errors.ts";
import { HeldRefusal, NotNow, oneLine, Waits } from "../failures.ts";
import { MARGIN_FALLBACK_S } from "../blocktime.ts";
import { SETTLE_S } from "../logs.ts";
import type { KeeperMemory } from "../memory.ts";
import type { Sent } from "../types.ts";
import { laneOf, rebuildProblem } from "./ccip.ts";
import type { CascadeSent, KeeperDepsV32, KeeperStateV32 } from "./reads.ts";
import { convertParkRequest, deliverParkedRequest, dropParkedRequest, parkAdapter, parkKeyOf, refundParkedRequest } from "./requests.ts";

// Task 52's park job (plan Task 52; spec §3.2, M-7, §7's keeper changes; design-keeper-worker.md §8). The Bittensor
// adapter parks a delivery it can't complete (BatchParked): as tokens when ForeverMoney's conversion fails, as TAO when the
// vault refuses it. The job:
// - handles only the registered door's parks to the vault (A-L2): a stranger's park is never read, simulated, quoted,
//   touched or paid for, and is said once;
// - rebuilds each park's message from the Base OnRamp's CCIPMessageSent by its messageId (found through the Base adapter's
//   Sent, reads.ts cascadeSent, which keeps every open park's send whatever its age: the job pins them, fix round 1's I1;
//   one the index doesn't hold, after a fresh memory or a long outage, is looked up by its id in the PARK_SENT_LOOKBACK_S
//   before the park, chunk by chunk, resumably) and checks it byte for byte: the CCIP message's bytes hash to the
//   messageId, it runs on Cascade's lane between Cascade's adapters (ccip.ts rebuildProblem), and its payload hashes to
//   the park's own key (the adapter's _parkKey), whose record parked(key) is read live before anything is sent. A
//   mismatch, or a send not found, refuses, said once, loudly; that park waits;
// - delivers a park (deliverParked) when its eth_call succeeds, the vault neither paused nor missing stake; one the vault
//   refuses anyway (it stays parked as TAO, ParkedConverted) is held, 1 hour doubling to a day, its count kept until the
//   park's state changes, so a refusing vault costs about 18 sends over the 14 days, never one a round;
// - refunds a park to its door after PARK_TIMEOUT (14 days from its record's parkedAt) with quoteRefund's fee as its
//   value, under the deployment's cap (parkRefundFeeMax, PARK_REFUND_FEE_MAX by default); drops an empty one after it;
// - at ForeverMoney's migration notice (migrationReadyAt() != 0, the founder's rule; read with the round's state) converts
//   every token park at once, first of all, through Task 50a's tagged conversion (convertParkRequest: the founder's
//   exception lets it through a hold or an outage, and the controller's ruling lets it past the spend cap, counted); closes
//   the open batch once, by its id, whatever the close rule (spec M-7's flush: the batch is then converted while the notice
//   runs), only while FLUSH_MARGIN_S still parts it from migrationReadyAt (a batch that misses it stays on Base, safe,
//   until the migration ends), "once" read from the chain (the open batch opened before the notice began, by
//   ForeverMoney's MIGRATION_DELAY), never from the memory; and closes nothing afterwards (AlphaVault reads unhealthy
//   during the notice, which stops every other close).
// Every send goes through the one send path, so the rails apply to each (a hold stops all of them but the conversion).
// The job reads every PARK_EVERY_TICKS rounds, each round while its last reading found something to do, and every round
// while the notice runs.

/** The adapter's PARK_TIMEOUT: a park can be refunded (or dropped when empty) this long after its record's parkedAt. */
export const PARK_TIMEOUT_S = 14 * 86_400;
/** R4 (A-M1, C-M1): the gas a parked delivery and a token park's conversion carry above their estimate and their
 * requirement (the adapter's parkedDeliveryGas(message), merge 7b: the lane's inbound model for the message, the park
 * reserve inside it). The additive form stays (the R4-O review: an estimator that already honours the requirement counts
 * it twice, which costs nothing, until Task 61 shows Bittensor's does). The estimate covers the call's own work
 * before the vault's call (the key, the record, a token park's conversion), whatever the node's estimator; the margin
 * covers what can change between the estimate and the block the call is mined in: a conversion that costs more once
 * ForeverMoney's pool has moved, or storage written cold. 100,000 gas: a few cold writes and a conversion's longer path. */
export const PARK_GAS_MARGIN = 100_000n;
/** CcipAdapterBase.GAS_CAP: parkedDeliveryGas never answers more for any message (_gasModel caps at it, the park reserve
 * inside it), so it is the floor's requirement when the view can't be read (R4-O's fix round, Minor 3; held to the
 * contracts by keeper-r4.test.ts). */
export const INBOUND_GAS_CAP = 7_000_000n;
/** The most the keeper pays as a park refund's CCIP fee, when the deployment names no cap of its own (parkRefundFeeMax):
 * 0.05 TAO, a few times a payout's (the vault's maxFeeAbs is 0.01 to 0.015 TAO), and an eighth of Bittensor's spend cap. */
export const PARK_REFUND_FEE_MAX = 5n * 10n ** 16n;
/** How often the job reads when nothing is due: every 5 rounds (the Worker's: 5 minutes). */
export const PARK_EVERY_TICKS = 5;
/** A park whose delivery the vault refused anyway, or reverted with nothing to explain it, is held this long, doubling with
 * each refusal in a row, up to PARK_HOLD_MAX_MS. */
export const PARK_HOLD_MS = 3_600_000;
export const PARK_HOLD_MAX_MS = 24 * 3_600_000;
/** A park's send not in the index (a fresh memory, a long outage) is looked up by its id this far before the park's
 * parkedAt (and an hour after): its message arrives minutes after its send, or days after through a FAILURE re-run by
 * hand (review I1). */
export const PARK_SENT_LOOKBACK_S = 7 * 86_400;
/** The notice's one close goes only while now + FLUSH_MARGIN_S is before migrationReadyAt (review I2): a batch sent later
 * could land after executeMigration, when a token park is a claim ForeverMoney won't honour (M-7). */
export const FLUSH_MARGIN_S = 86_400;
/** ForeverMoney's MIGRATION_DELAY when the AlphaVault's own can't be read (7 days: migrationReadyAt is set to the
 * announcement's time plus it; the AlphaVault's constant, as the fidelity mock and contracts/README have it): the notice
 * began at migrationReadyAt less it. The round reads the AlphaVault's MIGRATION_DELAY() once and counts from that (the
 * re-review's N3: reads.ts alpha.migrationDelayS). */
export const FM_MIGRATION_DELAY_S = 7 * 86_400;

/** One of the adapter's park events, as the job folds them. */
export interface ParkLog {
  kind: "parked" | "delivered" | "converted" | "refunded" | "dropped";
  key: Hex;
  blockNumber: bigint;
  logIndex: number;
  /** BatchParked's: CCIP's message id, whose payload's recipient and sender it names, the amount, whether as TAO */
  messageId?: Hex;
  recipient?: Address;
  sender?: Address;
  amount?: bigint;
  converted?: boolean;
  /** The Bittensor adapter that logged it (R4, D-M2: any pair's); absent: the deploy's */
  adapter?: Address;
}

/** A park open by its logs: its key, its message id, its recipient and sender (as BatchParked names them), what it owes
 * and whether as TAO (a later ParkedConverted says so), and the block it parked in. */
export interface Park {
  key: Hex;
  messageId: Hex;
  recipient: Address;
  sender: Address;
  amount: bigint;
  converted: boolean;
  block: bigint;
  /** The Bittensor adapter that holds it (R4, D-M2); absent: the deploy's */
  adapter?: Address;
}

const order = (x: ParkLog, y: ParkLog) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1);
const lower = (a: string) => a.toLowerCase();
const same = (a: string, b: string) => lower(a) === lower(b);
const short = (k: Hex) => `${k.slice(0, 10)}…`;
const tao = (wei: bigint) => `${formatEther(wei)} TAO`;
const at = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** The parks open by `logs` (plan Task 52): BatchParked less ParkedDelivered, ParkedRefunded and ParkedDropped, a later
 * ParkedConverted marking it converted; folded in chain order (block, then log index), whatever order the logs come in.
 * Oldest first. */
export function openParks(logs: readonly ParkLog[]): Park[] {
  const open = new Map<string, Park>();
  for (const l of [...logs].sort(order)) {
    const k = lower(l.key);
    if (l.kind === "parked") {
      open.delete(k);
      open.set(k, {
        key: l.key,
        messageId: l.messageId as Hex,
        recipient: l.recipient as Address,
        sender: l.sender as Address,
        amount: l.amount ?? 0n,
        converted: l.converted === true,
        block: l.blockNumber,
        ...(l.adapter ? { adapter: l.adapter } : {}),
      });
    } else if (l.kind === "converted") {
      const p = open.get(k);
      if (p) p.converted = true;
    } else open.delete(k);
  }
  return [...open.values()];
}

/** The keys whose last log is a settled close (delivered, refunded or dropped, `settle` blocks deep at `head`: the scan's
 * settle margin, SETTLE_S of Bittensor's blocks at its measured block time, 10 of its 12 s ones): the job lets their logs
 * go. A close nearer the head is kept a while (a reorg could undo it). */
export function settledClosed(logs: readonly ParkLog[], head: bigint, settle: bigint = BigInt(Math.ceil(SETTLE_S.bittensor / MARGIN_FALLBACK_S.bittensor))): Hex[] {
  const last = new Map<string, ParkLog>();
  for (const l of [...logs].sort(order)) last.set(lower(l.key), l);
  return [...last.values()].filter((l) => (l.kind === "delivered" || l.kind === "refunded" || l.kind === "dropped") && l.blockNumber + settle <= head).map((l) => l.key);
}

/** What parkAction decides by: whether the park is the registered door's to the vault (`ours`), Bittensor's time (s), the
 * park's record (parked(key)), whether ForeverMoney's migration notice runs, and whether deliverParked's eth_call succeeded
 * now (undefined: not simulated). */
export interface ParkFacts {
  ours: boolean;
  now: number;
  record: { amount: bigint; parkedAt: bigint; converted: boolean };
  notice: boolean;
  deliverable?: boolean;
}

/** What the job does with a park (plan Task 52): nothing for a stranger's or one with no record; "deliver" for a token park
 * while the notice runs (its conversion, tagged), or when its eth_call succeeded; after PARK_TIMEOUT from the record's
 * parkedAt, "refund" what it owes, or "drop" it when empty; else nothing. A delivery that would succeed comes before a
 * refund. */
export function parkAction(park: Park, f: ParkFacts): "deliver" | "refund" | "drop" | null {
  void park;
  if (!f.ours || f.record.parkedAt === 0n) return null;
  const token = !f.record.converted && f.record.amount > 0n;
  if (f.notice && token) return "deliver";
  if (f.deliverable === true) return "deliver";
  if (BigInt(f.now) < f.record.parkedAt + BigInt(PARK_TIMEOUT_S)) return null;
  return f.record.amount > 0n ? "refund" : "drop";
}

/** `park`'s message, rebuilt from the Base OnRamp's CCIPMessageSent by its messageId and checked (plan Task 52), or why
 * not: its send among Cascade's on Base (the Base adapter's Sent from the door to the vault, which gives its block); the
 * OnRamp's log of it at that block; its bytes (ccip.ts rebuildProblem: they hash to the messageId, on Cascade's lane,
 * between Cascade's adapters, from the door to the vault); its payload naming the park's recipient and sender; and its
 * message hashing, with the adapter's remote chain, to the park's own key. A send the index doesn't hold is looked up by
 * its id (reads.ts sentById): in the PARK_SENT_LOOKBACK_S before the park's `parkedAt` when it is given, else from the
 * deployment's start; a lookup cut off part way says how far it read (`looking`), and reads on next time. */
export async function parkMessage(
  deps: KeeperDepsV32,
  park: Park,
  sends?: () => Promise<CascadeSent[]>,
  o: { parkedAt?: bigint } = {},
): Promise<{ ok: ParkRef } | { problem: string; looking?: true }> {
  // the lane through the park's own pair (R4, D-M2): its Base adapter sent it, its Bittensor adapter holds it
  const pair = pairOfBit(deps.deployment, park.adapter);
  if (!pair) return { problem: `its adapter ${park.adapter} is not one of the deployment's` };
  const lane = laneOf(deps.deployment, "Base → Bittensor", pair);
  if (typeof lane === "string") return { problem: lane };
  // a send of the deploy's pair carries no adapter (R4-O's fix round, Minor 4: so it matches only a park of that pair)
  const fromPair = (x: CascadeSent) => same(x.adapter ?? deps.deployment.addresses.baseAdapter, pair.baseAdapter);
  const all = sends ? await sends() : await deps.cascadeSent("Base → Bittensor");
  let sent = all.find((x) => x.direction === "Base → Bittensor" && same(x.id, park.messageId) && fromPair(x));
  if (!sent) {
    const around = o.parkedAt !== undefined ? { before: Number(o.parkedAt), lookbackS: PARK_SENT_LOOKBACK_S } : {};
    let got = await deps.sentById(park.messageId, { direction: "Base → Bittensor", ...around });
    // none in the days before it parked (its message sat in FAILURE longer, then was re-run by hand, say): looked up from
    // the deployment's start (the re-review's N5), a lookup of its own, as resumable
    const wide = "none" in got && o.parkedAt !== undefined;
    if (wide) got = await deps.sentById(park.messageId, { direction: "Base → Bittensor" });
    if ("partial" in got) {
      const p = got.partial;
      return { problem: `its send is looked up by its id in Base's blocks ${p.from} to ${p.to}, read to ${p.scannedTo} so far (${oneLine((p.error as Error)?.message ?? String(p.error), 120)}); it goes on next round`, looking: true };
    }
    if ("none" in got) {
      return {
        problem: `its send was not found among Cascade's on Base, in the index or by its id in Base's blocks ${got.none.from} to ${got.none.to}${wide ? " (from the deployment's start)" : o.parkedAt !== undefined ? ` (the ${PARK_SENT_LOOKBACK_S / 86_400} days before it parked)` : ""}`,
      };
    }
    sent = got.found;
    if (!fromPair(sent)) return { problem: `its send came through ${sent.adapter}, not its pair's Base adapter ${pair.baseAdapter}` };
  }
  const encoded = await deps.onRampMessage("Base → Bittensor", sent.block, park.messageId, sent.adapter ?? pair.baseAdapter);
  if (!encoded) return { problem: `the Base OnRamp logged no CCIPMessageSent for it at block ${sent.block}, where its send is` };
  const r = rebuildProblem(lane, park.messageId, encoded);
  if ("problem" in r) return r;
  const { recipient, sender, message } = r.ok.payload;
  if (!same(recipient, park.recipient) || !same(sender, park.sender)) return { problem: "its payload names another recipient or sender than its BatchParked" };
  const remote = await deps.parkRemoteChain(park.adapter);
  if (!same(parkKeyOf(remote, sender, recipient, message), park.key)) return { problem: `its message does not hash to park ${short(park.key)}'s key` };
  return { ok: { key: park.key, recipient, sender, message, ...(park.adapter ? { adapter: park.adapter } : {}) } };
}

/** The gas a parked delivery of `ref` (or a token park's conversion) carries above its estimate (R4, A-M1 and C-M1): what
 * the vault's call needs at the adapter (deps.parkGas: the park's own adapter's parkedDeliveryGas(message), merge 7b)
 * and PARK_GAS_MARGIN. So the vault is never starved into a re-park, whatever the node's estimator answers. */
export async function parkGasAbove(deps: KeeperDepsV32, ref: ParkRef): Promise<bigint> {
  try {
    return (await deps.parkGas(ref)) + PARK_GAS_MARGIN;
  } catch (e) {
    // R4-O's fix round (Minor 3): the view unread, the park still goes, with the most it can answer (GAS_CAP, the reserve
    // inside it): never starved, and the gas it doesn't use is not charged
    deps.log(
      `PARK GAS AT THE CAP: park ${short(ref.key)}'s gas requirement couldn't be read (${oneLine((e as Error).message ?? String(e), 120)}): it goes with the CCIP adapters' cap, ${INBOUND_GAS_CAP.toLocaleString("en-US")} gas, the most the adapter's parkedDeliveryGas can answer (CcipAdapterBase GAS_CAP, the park reserve inside it), plus the ${PARK_GAS_MARGIN.toLocaleString("en-US")} margin; unused gas is not charged`,
    );
    return INBOUND_GAS_CAP + PARK_GAS_MARGIN;
  }
}

interface ParkMemory {
  /** What was last said, by line (a park's key, the job's own) */
  said?: Record<string, string>;
  /** Strangers' parks already said once (their keys, the last 500) */
  strangers?: string[];
  /** Each of our open parks' message, rebuilt and checked (by lowercase key) */
  refs?: Record<string, ParkRef>;
  /** Parks whose delivery the vault refused anyway, or that reverted with nothing to explain it: until when (ms), how many
   * in a row (kept when a hold ends, so the next doubles: review I3), and the park's record as the hold first read it
   * (its state: a change ends the hold and its count) */
  held?: Record<string, { until: number; n: number; state?: string }>;
  /** The last reading found a job, a conversion or the flush that could go, or a lookup by id to read on: read again next
   * round */
  goable?: boolean;
}

const parkMemory = (memory: KeeperMemory): ParkMemory => (memory.reads.parks ??= {}) as ParkMemory;

const v32 = (deps: KeeperDeps): KeeperDepsV32 => {
  if (!("parkLogs" in deps) || !("railsSeen" in deps)) throw new Error("v3.2's park job needs the v3.2 deps (v32/reads.ts depsV32); nothing sent");
  return deps as KeeperDepsV32;
};

/** Holds `key`'s delivery after the vault refused it anyway (or it reverted, nothing explaining it): PARK_HOLD_MS, doubling
 * with each in a row, up to PARK_HOLD_MAX_MS. The count is kept when a hold ends (the job only lets the hold go when the
 * park's state changes, or the park is gone), and the state is read afresh at the next pass (what this send did to it is
 * the hold's own). Returns when it ends. */
export function holdPark(memory: KeeperMemory, key: Hex, now: number): number {
  const mem = parkMemory(memory);
  const held = (mem.held ??= {});
  const n = (held[lower(key)]?.n ?? 0) + 1;
  const until = now + Math.min(PARK_HOLD_MS * 2 ** (n - 1), PARK_HOLD_MAX_MS);
  held[lower(key)] = { until, n };
  return until;
}

/** A park record's state, as a hold keeps it. */
const stateOf = (r: { amount: bigint; parkedAt: bigint; converted: boolean }) => `${r.amount}:${r.parkedAt}:${r.converted}`;

/** Why the notice's one close can't go now (spec M-7; review I2), or undefined: ForeverMoney's migration has executed
 * (migrationFinished); the open batch opened after the notice began (migrationReadyAt less FM_MIGRATION_DELAY_S: the batch
 * open then has closed, by the keeper's flush or otherwise, so the one close is done; read from the chain, so a memory
 * lost changes nothing); or less than FLUSH_MARGIN_S is left before migrationReadyAt (a batch sent now could land after
 * the migration executes: it stays on Base, safe, until the migration ends). `missed` names that one. Or, before the
 * deadline, the vault would refuse the batch now (State.vaultRefuses: paused, the launch door not Active, stake missing):
 * it would park as ForeverMoney's token, which once converted can only wait for the vault, so the flush waits on Base
 * (Task 52w fix, Important 1). `waits` names that one. */
export function flushProblem(s: KeeperStateV32): { why: string; missed?: true; waits?: true } | undefined {
  const { migrationReadyAt: readyAt, migrationFinished, migrationDelayS } = s.v32.alpha;
  if (readyAt === 0n) return { why: "ForeverMoney's migration notice is over: the close rule decides the open batch again" };
  if (migrationFinished) return { why: "ForeverMoney's migration has executed: nothing is closed" };
  if (BigInt(s.frontDoor.openStart) >= readyAt - BigInt(migrationDelayS ?? FM_MIGRATION_DELAY_S)) {
    return { why: `batch ${s.v32.openId} opened after ForeverMoney's notice began, so the batch open then has closed: the notice's one close is done` };
  }
  if (BigInt(s.now) + BigInt(FLUSH_MARGIN_S) >= readyAt) {
    return {
      why: `ForeverMoney's migration can execute from ${at(Number(readyAt) * 1000)} (migrationReadyAt ${readyAt}), less than ${FLUSH_MARGIN_S / 3_600} hours from now: the open batch ${s.v32.openId} is not closed, and stays on Base, safe, until the migration ends`,
      missed: true,
    };
  }
  if (s.vaultRefuses) {
    return {
      why: `ForeverMoney's migration is announced (migrationReadyAt ${readyAt}): the open batch ${s.v32.openId} waits on Base while ${s.vaultRefuses}, since a batch sent now would park on Bittensor as ForeverMoney's token; it is closed once the vault takes batches again, by ${at((Number(readyAt) - FLUSH_MARGIN_S) * 1000)}, and after that it stays on Base, safe, until the migration ends`,
      waits: true,
    };
  }
  return undefined;
}

/** The round's park work (core/actions.ts KeeperActions.bridgeWork's parks): the token parks to convert while the notice
 * runs, the notice's one close, and the park jobs due. Read every PARK_EVERY_TICKS rounds, each round while the last
 * reading found something that could go, and every round while the notice runs; undefined when not read. Under a hold
 * during the notice (`onlyConversions`), only token parks are looked at. Each decision is said once when it changes. */
export async function parksV32(
  depsIn: KeeperDeps,
  memory: KeeperMemory,
  sIn: State,
  o: { now: number; onlyConversions: boolean },
): Promise<Pick<State, "conversions" | "flush" | "parkJobs"> | undefined> {
  const deps = v32(depsIn);
  const s = sIn as KeeperStateV32;
  const d = deps.deployment;
  const mem = parkMemory(memory);
  const said = (mem.said ??= {});
  const tell = (k: string, text: string | undefined) => {
    if (said[k] === text) return;
    if (text === undefined) delete said[k];
    else {
      said[k] = text;
      deps.log(text);
    }
  };
  const notice = s.v32.alpha.migrationReadyAt !== 0n;
  // R4 (S-H1): while the notice runs no payout is sent (its send would revert on ForeverMoney's closed depositLiquid) and
  // no batch closes but the notice's one close (the AlphaVault reads unhealthy: closeV32, payoutsV32): what waits, each
  // round, so a redeem request's wait is never silent
  if (notice) {
    const keys = s.vault.batches.filter((b) => b.cursor < b.count).map((b) => b.key);
    const queued = keys.length;
    const redeems = s.frontDoor.nRedeems;
    if (queued || redeems) {
      deps.log(
        `MIGRATION NOTICE: while it runs no payout is sent (its send would revert on ForeverMoney's closed depositLiquid; ${queued} payout batch${queued === 1 ? " waits" : "es wait"}) and no batch closes but the notice's one close (${redeems} redeem request${redeems === 1 ? " waits" : "s wait"} on Base)`,
      );
    }
    // merge 7b (the stuck review's S-H1, keeper part): the batches queued when the notice began can never be paid through
    // this rail: each named, once (again when another queues), to cancel before the replacement rail is scheduled (each
    // launch-door cancel stamps the owner's clock); a bounce-only batch has no cancel (NothingToCancel, S-L4)
    tell(
      "cancel",
      queued
        ? `MIGRATION NOTICE: cancel ${queued === 1 ? "this queued payout batch" : "these queued payout batches"}, which can never be paid through this rail (no payout goes through it while the notice runs or after the migration): ${keys.join(", ")}. Cancel each before the replacement rail is scheduled (pnpm ops cancel-payouts <key> --for-wallet --live; runbook 7.7 step 3); a batch of bounced deposits alone can't be cancelled, and waits for the replacement rail`
        : undefined,
    );
  } else tell("cancel", undefined);
  const flush = notice ? flushDue(s, tell) : undefined;
  if (!notice) tell("flush", undefined);
  if (!(notice || memory.tick === 1 || memory.tick % PARK_EVERY_TICKS === 0 || mem.goable)) return flush ? { flush } : undefined;
  const lane = laneOf(d, "Base → Bittensor");
  if (typeof lane === "string") {
    tell("job", `PARK JOB OFF: ${lane}: no park is rebuilt or handled; the keeper's other work goes on`);
    mem.goable = !!flush;
    return flush ? { flush } : {};
  }
  tell("job", undefined);
  // a live primary the deployment doesn't list (R4, D-M2: a switch whose pair wasn't added): said loudly, once
  const listed = (x: Address, side: "base" | "bit") => adapterPairs(d).some((p) => same(side === "base" ? p.baseAdapter : p.bitAdapter, x));
  const unlisted = [
    ...(s.v32.primary.bittensor && !listed(s.v32.primary.bittensor, "bit") ? [`the vault's primary bridge ${s.v32.primary.bittensor}`] : []),
    ...(s.v32.primary.base && !listed(s.v32.primary.base, "base") ? [`the front door's primary bridge ${s.v32.primary.base}`] : []),
  ];
  tell(
    "unlisted",
    unlisted.length
      ? `RAILS NOT LISTED: ${unlisted.join(" and ")} ${unlisted.length === 1 ? "is not one" : "are not"} of the keeper's adapter pairs: ${unlisted.length === 1 ? "its" : "their"} parks and CCIP FAILUREs are not watched. Add the pair (pnpm ops add-pair <bridge> <bridge> --live), print DEPLOYMENT again and deploy the keeper (runbook section 8)`
      : undefined,
  );

  const { logs, head, settle } = await deps.parkLogs();
  const parks = openParks(logs);
  const refs = (mem.refs ??= {});
  const held = (mem.held ??= {});
  const strangers = (mem.strangers ??= []);
  // what the logs no longer need: settled closes, and strangers' parks once said
  const gone = new Set<Hex>(settledClosed(logs, head, settle).map((k) => lower(k) as Hex));
  const conversions: ParkRef[] = [];
  const jobs: ParkJob[] = [];
  const cap = d.parkRefundFeeMax ?? PARK_REFUND_FEE_MAX;
  const isOurs = (p: Park) => same(p.sender, d.addresses.frontDoor) && same(p.recipient, d.addresses.vault);
  // every open park of ours keeps its send in the index whatever its age, pinned before the index is read (review I1)
  deps.pinParkSends(parks.filter(isOurs).map((p) => p.messageId));
  // Cascade's sends on Base, read once a pass, and only when a park of ours needs its message rebuilt
  let sentOnce: Promise<CascadeSent[]> | undefined;
  const sends = () => (sentOnce ??= deps.cascadeSent("Base → Bittensor"));
  let looking = false;
  /** Why each park that could not be read this round wasn't */
  const unread: string[] = [];
  // R4 (C-L2): whether each park's adapter is enabled on the vault, read once a pass
  const enabledOnce = new Map<string, Promise<boolean>>();
  const enabled = (adapter: Address) => {
    let e = enabledOnce.get(adapter.toLowerCase());
    if (!e) {
      e = deps.bridgeEnabled(adapter);
      enabledOnce.set(adapter.toLowerCase(), e);
    }
    return e;
  };
  for (const p of parks) {
    const k = lower(p.key);
    const ours = isOurs(p);
    if (!ours) {
      // A-L2: never read, simulated, quoted, touched or paid for; said once
      if (!strangers.includes(k)) {
        deps.log(`Park ${short(p.key)} is not Cascade's (from ${p.sender} to ${p.recipient}): the keeper never touches it or pays for it`);
        strangers.push(k);
        if (strangers.length > 500) strangers.splice(0, strangers.length - 500);
      }
      gone.add(k as Hex);
      continue;
    }
    // under a hold during the notice only a token park's conversion may go: nothing else is read
    if (o.onlyConversions && (p.converted || p.amount === 0n)) continue;
    // each park read on its own (Task 52w): one that can't be read now (a node's error, the run's subrequests spent) is
    // read again next round, and what the others found still goes this round (a conversion above all)
    try {
      const record = await deps.readPark(p.key, p.adapter);
      // delivered, refunded or dropped since: its log comes in a later scan
      if (record.parkedAt === 0n) continue;
      let ref = refs[k];
      if (!ref) {
        const r = await parkMessage(deps, p, sends, { parkedAt: record.parkedAt });
        if ("problem" in r) {
          if (r.looking) looking = true;
          tell(
            `rebuild:${k}`,
            r.looking
              ? `PARK SEND LOOKUP: park ${short(p.key)} (bridge message ${short(p.messageId)}): ${r.problem}`
              : `PARK NOT REBUILT: park ${short(p.key)} (bridge message ${short(p.messageId)}): ${r.problem}; nothing is sent for it`,
          );
          continue;
        }
        tell(`rebuild:${k}`, undefined);
        ref = r.ok;
        refs[k] = ref;
      }
      const token = !record.converted && record.amount > 0n;
      // a held park stays held, its count kept when the hold ends (so the next one doubles), until its state changes
      const h = held[k];
      if (h) {
        if (h.state === undefined) h.state = stateOf(record);
        else if (h.state !== stateOf(record)) delete held[k];
      }
      const isHeld = held[k] !== undefined && o.now < (held[k] as { until: number }).until;
      let deliverable: boolean | undefined;
      // R4 (C-L2): nor while the vault refuses batches (paused, its launch door not Active, stake missing) or the park's
      // adapter is not enabled on it: deliverParked's catch makes that refusal a "success" the simulation can't tell from
      // a delivery, and a token park would be converted for nothing
      const tryIt = !(notice && token) && !o.onlyConversions && !isHeld && !s.vault.paused && !s.vault.stakeMissing && !s.vaultRefuses;
      const adapterOn = tryIt ? await enabled((ref.adapter ?? d.addresses.bitAdapter)) : true;
      tell(
        `off:${k}`,
        adapterOn
          ? undefined
          : `Park ${short(p.key)} waits: its Bittensor adapter ${(ref.adapter ?? d.addresses.bitAdapter)} is not enabled on the vault, so a delivery would only park it again${record.amount > 0n ? `; it is refunded to its door ${PARK_TIMEOUT_S / 86_400} days after it parked` : ""}`,
      );
      if (tryIt && adapterOn) {
        const sim = await deps.simulateDeliverParked(ref);
        deliverable = sim.ok;
        tell(`sim:${k}`, sim.ok ? undefined : `Park ${short(p.key)}'s delivery would fail now (${sim.reason}): it waits${record.amount > 0n ? `, and is refunded to its door ${PARK_TIMEOUT_S / 86_400} days after it parked` : ""}`);
      }
      const act = parkAction(p, { ours, now: s.now, record, notice, deliverable });
      if (act === "deliver" && notice && token) conversions.push(ref);
      else if (o.onlyConversions) continue;
      else if (act === "deliver") jobs.push({ ...ref, job: "deliver", reason: `park ${short(p.key)} can be delivered to the vault (its simulation passes)` });
      else if (act === "refund") {
        const fee = await deps.quoteRefund(ref);
        if (fee > cap) {
          tell(`refund:${k}`, `PARK REFUND WAITS: park ${short(p.key)}'s refund would cost a ${tao(fee)} bridge fee (quoteRefund), above the keeper's ${tao(cap)} cap (OPS_PARK_REFUND_FEE_MAX): it waits for the fee to fall`);
          continue;
        }
        tell(`refund:${k}`, undefined);
        jobs.push({ ...ref, job: "refund", fee, reason: `park ${short(p.key)} is ${PARK_TIMEOUT_S / 86_400} days old: refunded to its door on Base` });
      } else if (act === "drop") jobs.push({ ...ref, job: "drop", reason: `the empty park ${short(p.key)} is ${PARK_TIMEOUT_S / 86_400} days old: dropped` });
    } catch (e) {
      unread.push(oneLine((e as Error).message, 160));
    }
  }
  tell(
    "unread",
    unread.length
      ? `PARKS READ IN PART: ${unread.length} of Cascade's open parks could not be read this round (${unread[0]}); they are read again next round, and the keeper's other work goes on`
      : undefined,
  );
  // let go of what is no longer open (its logs, its message, what was said of it)
  for (const k of Object.keys(refs)) if (!parks.some((p) => lower(p.key) === k)) gone.add(k as Hex);
  if (gone.size) {
    deps.forgetParks([...gone]);
    for (const k of gone) {
      delete refs[k];
      delete held[k];
      for (const x of [`rebuild:${k}`, `sim:${k}`, `refund:${k}`, `off:${k}`]) delete said[x];
    }
  }
  mem.goable = conversions.length + jobs.length > 0 || !!flush || looking || unread.length > 0;
  return { conversions, ...(flush ? { flush } : {}), ...(jobs.length ? { parkJobs: jobs } : {}) };
}

/** The notice's one close (spec M-7), when it is due: the open batch, when it opened before the notice began and the
 * deadline (FLUSH_MARGIN_S before migrationReadyAt) hasn't passed (flushProblem: read from the chain, never from the
 * memory), has entries and can close; never after the migration executed (migrationFinished). Each change of what it says
 * is said once. */
function flushDue(s: KeeperStateV32, tell: (k: string, text: string | undefined) => void): State["flush"] {
  const readyAt = s.v32.alpha.migrationReadyAt;
  const id = s.v32.openId;
  const entries = s.frontDoor.nDeposits + s.frontDoor.nRedeems;
  const no = flushProblem(s);
  // an empty batch has nothing to miss or to hold back: it is said empty below
  if (no && !((no.missed || no.waits) && entries === 0)) {
    tell("flush", `MIGRATION NOTICE FLUSH${no.missed ? " MISSED" : no.waits ? " WAITS" : ""}: ${no.why}`);
    return undefined;
  }
  if (no?.missed) {
    tell("flush", undefined);
    return undefined;
  }
  if (entries === 0) {
    tell("flush", `MIGRATION NOTICE FLUSH: ForeverMoney's migration is announced (migrationReadyAt ${readyAt}): the open batch ${id} is empty, so there is nothing to close`);
    return undefined;
  }
  tell(
    "flush",
    `MIGRATION NOTICE FLUSH: ForeverMoney's migration is announced (migrationReadyAt ${readyAt}): the open batch ${id} is closed once, at once (by ${at((Number(readyAt) - FLUSH_MARGIN_S) * 1000)}), and nothing is closed after it while the notice runs`,
  );
  if (!s.frontDoor.canClose) return undefined;
  // R12b: minValue 0, as flushV32 sends it (a 1-rao cancel must not void the notice's one close)
  return { id, minValue: 0n, reason: `ForeverMoney's migration notice: batch ${id} is closed once, at once (spec M-7)` };
}

/** Whether `sent`'s receipt has the adapter's `event` for park `key`. */
function parkEvent(sent: Sent, adapter: Address, event: "ParkedDelivered" | "ParkedConverted", key: Hex): boolean {
  for (const l of sent.logs ?? []) {
    if (!same(l.address, adapter)) continue;
    try {
      const e = decodeEventLog({ abi: PARK_EVENTS, topics: l.topics as [Hex, ...Hex[]], data: l.data });
      if (e.eventName === event && same((e.args as { key: Hex }).key, key)) return true;
    } catch {
      // another of the adapter's events
    }
  }
  return false;
}

/** Converts token park `park` during ForeverMoney's migration notice (deliverParked, tagged: convertParkRequest), when,
 * read again now, it is still a token park (not converted, not empty). Delivered (ParkedDelivered), or converted and kept as
 * TAO because the vault refused it (ParkedConverted): either way it is out of ForeverMoney's token, said. A revert another
 * caller's conversion explains is NotNow; any other a Waits (the next round tries again; the breaker counts it). */
export async function convertV32(depsIn: KeeperDeps, t: KeeperTarget, park: ParkRef): Promise<Done> {
  const deps = v32(depsIn);
  t.requireReady(deps.signer, deps);
  const before = await deps.readPark(park.key, park.adapter);
  if (before.parkedAt === 0n) throw new NotNow(`park ${short(park.key)} is gone (delivered or refunded since): nothing to convert`);
  if (before.converted || before.amount === 0n) throw new NotNow(`park ${short(park.key)} is no token park now (converted or empty): nothing to convert`);
  let sent: Sent;
  try {
    sent = await keeperSend(deps, convertParkRequest(t, park, await deps.nonce("bittensor"), await parkGasAbove(deps, park)));
  } catch (e) {
    if (!(e instanceof RevertedOnChain)) throw e;
    const after = await deps.readPark(park.key, park.adapter).catch(() => undefined);
    if (after && (after.parkedAt === 0n || after.converted)) throw new NotNow(`another caller converted or delivered park ${short(park.key)} first; transaction ${e.hash} reverted on chain`);
    throw new Waits(`the conversion of park ${short(park.key)} reverted on chain (${e.reason ?? "no reason replayed"}; transaction ${e.hash}); the next round tries again`);
  }
  const a = parkAdapter(t, park);
  if (parkEvent(sent, a, "ParkedConverted", park.key)) deps.log(`Park ${short(park.key)} converted to TAO, out of ForeverMoney's token; the vault refused it, so it stays parked as TAO and is delivered or refunded later`);
  else deps.log(`Park ${short(park.key)} converted and delivered to the vault`);
  return { ...sent };
}

/** One park job (Task 52), when, read again now, the park is still there: deliverParked (untagged); refundParked with the
 * quote read now as its value, under the cap (else Waits); dropParked of a park still empty. A delivery the vault refused
 * anyway (it stays parked as TAO: ParkedConverted) holds that park's delivery (holdPark), said loudly. A refund's bridge
 * message is recorded. A revert another caller's call explains (the park gone) is NotNow; one nothing explains holds the
 * park (HeldRefusal): never a stop, since a park is safe on the adapter (I-7). */
export async function parkJobV32(depsIn: KeeperDeps, t: KeeperTarget, a: Extract<Action, { kind: "park" }>, o: { memory?: KeeperMemory; now?: number } = {}): Promise<Done> {
  const deps = v32(depsIn);
  t.requireReady(deps.signer, deps);
  const ref: ParkRef = { key: a.key, recipient: a.recipient, sender: a.sender, message: a.message, ...(a.adapter ? { adapter: a.adapter } : {}) };
  const named = `park ${short(a.key)}`;
  const record = await deps.readPark(a.key, a.adapter);
  if (record.parkedAt === 0n) throw new NotNow(`${named} is gone (delivered, refunded or dropped since); nothing sent`);
  const nonce = await deps.nonce("bittensor");
  let req;
  if (a.job === "deliver") req = deliverParkedRequest(t, ref, nonce, await parkGasAbove(deps, ref));
  else if (a.job === "refund") {
    const fee = await deps.quoteRefund(ref);
    const cap = deps.deployment.parkRefundFeeMax ?? PARK_REFUND_FEE_MAX;
    if (fee > cap) throw new Waits(`the refund of ${named} waits: its bridge fee is ${tao(fee)} now, above the keeper's ${tao(cap)} cap (OPS_PARK_REFUND_FEE_MAX)`);
    req = refundParkedRequest(t, ref, fee, nonce);
  } else {
    if (record.amount !== 0n) throw new NotNow(`${named} is not empty: it is refunded, never dropped; nothing sent`);
    req = dropParkedRequest(t, ref, nonce);
  }
  const now = o.now ?? Date.now();
  let sent: Sent;
  try {
    sent = await keeperSend(deps, req);
  } catch (e) {
    if (!(e instanceof RevertedOnChain)) throw e;
    const after = await deps.readPark(a.key, a.adapter).catch(() => undefined);
    if (after && after.parkedAt === 0n) throw new NotNow(`another caller delivered, refunded or dropped ${named} first; transaction ${e.hash} reverted on chain`);
    const until = o.memory ? holdPark(o.memory, a.key, now) : now + PARK_HOLD_MS;
    throw new HeldRefusal(
      actionKey(a),
      `${req.label} reverted on chain with nothing to explain it (transaction ${e.hash}${e.reason ? `, ${e.reason}` : ""}): ${named} waits until ${at(until)}; the keeper's other work goes on`,
    );
  }
  const adapter = parkAdapter(t, ref);
  if (a.job === "refund") {
    const done = await withMessage(deps, sent, adapter, "Bittensor → Base");
    deps.log(`Park ${short(a.key)} refunded to its door on Base${done.messageId ? ` (bridge message ${done.messageId})` : ""}; the keeper paid its ${tao(req.value ?? 0n)} bridge fee`);
    return done;
  }
  if (a.job === "drop") {
    deps.log(`The empty park ${short(a.key)} is dropped (its redeems were never burned: their requesters keep their shares and request again)`);
    return { ...sent };
  }
  if (parkEvent(sent, adapter, "ParkedConverted", a.key)) {
    const until = o.memory ? holdPark(o.memory, a.key, now) : now + PARK_HOLD_MS;
    deps.log(`PARK HELD: the vault refused park ${short(a.key)} again (it stays parked as TAO): its delivery is tried again at ${at(until)}; it is refunded to its door after 14 days`);
  } else deps.log(`Park ${short(a.key)} delivered to the vault`);
  return { ...sent };
}
