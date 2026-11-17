import type { Address, Hex } from "viem";
import {
  act,
  assertNoCode,
  type BridgeWork,
  type Delivery,
  type Done,
  deliver,
  type KeeperActions,
  type KeeperDeps,
  type KeeperState,
  type KeeperTarget,
  messageIdFrom,
  type QueuedDelivery,
  type Rails,
  type Rewards,
  recordSafely,
  type Rolled,
  roll,
} from "./actions.ts";
import { checkDelivery, explainDeliveryRevert, THIN_POOL_WAIT, thinnedBeforeLanding, thinPool } from "./delivery.ts";
import { type Action, actionKey, type DueDelivery, decideNext } from "./due.ts";
import { chainLabel, ReceiptTimeout, RevertedOnChain, SendRefused, SpendCapRefused } from "./errors.ts";
import {
  classifyFailure,
  DeliveryReverted,
  type FailureKind,
  FinalRefusal,
  HeldRefusal,
  inWords,
  nextWaitMs,
  NotNow,
  oneLine,
  PayoutListRescan,
  RevertUnread,
  scrubSecrets,
  Waits,
} from "./failures.ts";
import { freshMemory, type KeeperMemory, type Racing, recordMap, revertOf, saveRevert, type Unreceipted } from "./memory.ts";
import { type ClaimPolicy, decideClaim } from "./rewards.ts";
import type { CallRequest, ChainName, Replacement, Sent } from "./types.ts";

// The keeper's round (design-keeper-worker.md §1): today's run loop body, one round per call, everything it kept
// between rounds in a KeeperMemory (memory.ts). runLoop is the PC's loop over it; the Worker (Task 50b) runs one round
// a minute, saving the memory between.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Logs whether a reward claim is due when that changes; run never claims, and a failed read only waits. */
async function reportClaim(deps: KeeperDeps, policy: ClaimPolicy, live: boolean, last: boolean | undefined): Promise<boolean | undefined> {
  try {
    const d = decideClaim(await deps.readRewards(), policy);
    if (d.claim !== last) {
      deps.log(
        d.claim
          ? `Rewards: a claim is due (${d.reason}). run never claims: claim by hand with pnpm ops claim${live ? " --live" : ""}`
          : `Rewards: no claim due (${d.reason})`,
      );
    }
    return d.claim;
  } catch (e) {
    deps.log(`Could not read the rewards (${(e as Error).message}); trying again later`);
    return last;
  }
}

/** How a run ended: it stopped itself, on a failure classifyFailure says must stop it (or one that kept
 * repeating), or its rounds ran out (`maxTicks`, which only tests set). */
export type LoopEnd = { stopped: false } | { stopped: true; kind: FailureKind; reason: string };

/** What an action is doing, for a log line. */
function doing(a: Action): string {
  switch (a.kind) {
    case "close":
      return "closing the batch";
    case "roll":
      return "rolling the empty batch";
    case "stake":
      return "staking";
    case "payouts":
      return `paying out batch ${a.key.slice(0, 10)}…`;
    case "deliver":
      return `delivering to ${a.user}`;
    case "convertPark":
      return `converting token park ${a.key.slice(0, 10)}…`;
    case "flush":
      return `closing batch ${a.id} once (ForeverMoney's migration notice)`;
    case "park":
      return a.job === "deliver" ? `delivering park ${a.key.slice(0, 10)}…` : a.job === "refund" ? `refunding park ${a.key.slice(0, 10)}… to its door` : `dropping the empty park ${a.key.slice(0, 10)}…`;
    case "reexec":
      return `re-executing bridge message ${a.id.slice(0, 10)}… (${a.direction})`;
    case "claim":
      return `claiming the rewards on hotkey ${a.hotkey.slice(0, 10)}…`;
    case "adopt":
      return "adopting the surplus stake";
    case "free":
      return `freeing hotkey ${a.hotkey.slice(0, 10)}…'s slot`;
  }
}

/** Why a close, roll, payout or stake that reverted on chain lost a race, from the chains as read after
 * it (`before`: the round's read): a pause, another close or an entry landing first, another caller
 * paying the batch out (processPayouts and closeBatch are anyone's), or the idle TAO gone. Undefined when
 * nothing explains it: the revert, with its transaction hash, then stops the keeper. */
export function explainRace(a: Racing, before: KeeperState, after: KeeperState): string | undefined {
  // v3.2's park conversion, claims and adoption, park jobs, notice close and re-executions (never decided on v3-launch)
  if (a.kind === "convertPark" || a.kind === "claim" || a.kind === "adopt" || a.kind === "park" || a.kind === "flush" || a.kind === "reexec" || a.kind === "free") return undefined;
  if (a.kind === "close" || a.kind === "roll") {
    const fd = after.frontDoor;
    if (fd.paused) return "the front door was paused";
    if (!after.alphaVault.healthy) return "AlphaVault was paused or began migrating";
    const moved = fd.openStart !== before.frontDoor.openStart || !fd.canClose;
    if (a.kind === "roll") return moved || fd.nDeposits + fd.nRedeems > 0 ? "an entry or another close landed first" : undefined;
    return moved || fd.nDeposits + fd.nRedeems === 0 ? "another close landed first" : undefined;
  }
  if (after.vault.paused) return "the vault was paused";
  if (a.kind === "payouts") {
    if (!after.alphaVault.healthy) return "AlphaVault was paused or began migrating";
    const batch = (s: KeeperState) => s.vault.batches.find((b) => b.key.toLowerCase() === a.key.toLowerCase());
    const was = batch(before);
    const now = batch(after);
    if (!now || now.cursor >= now.count || (was && now.cursor !== was.cursor)) return "another caller paid this batch out first";
    return undefined;
  }
  if (after.vault.available < after.vault.minStakeWei) return "the idle TAO is no longer above the staking floor";
  return undefined;
}

/** How long a held delivery waits at most before it is tried again on the same facts. */
export const HOLD_MS = 30 * 60_000;
/** A user's revert budget: this many of their deliveries reverted on chain within REVERT_WINDOW_MS,
 * explained (a price race, a preference they changed under the send) or not, and that user's delivery
 * is held for REVERT_HOLD_MS, whatever their facts do; each time the budget runs out again within the
 * window the hold doubles, up to REVERT_HOLD_MAX_MS. Each reverted delivery costs the keeper a Base
 * transaction's gas, so a floor that sits at the market price, or a user changing their preference once
 * a round, is allowed two a day and then waits; the user can claim by hand at any time. One user's
 * reverts never stop the keeper, whose other work goes on. */
export const REVERT_BUDGET = 2;
export const REVERT_WINDOW_MS = 24 * 3600_000;
export const REVERT_HOLD_MS = 6 * 3600_000;
export const REVERT_HOLD_MAX_MS = 48 * 3600_000;
/** The circuit breaker: a close, stake or payout refused this many rounds in a row (by its simulation,
 * or by its own re-read of the chain) is skipped, so the actions behind it (other payouts, deliveries,
 * the stake, the close) go ahead, and it is tried again SKIP_MS later, doubling each time it is refused
 * again, up to SKIP_MAX_MS. A refused simulation sends nothing, so skipping it can never send twice. A v3.2 close its
 * own reads refuse (NotNow's `onRead`, R12e: the batch changed since the round read it; R12f: BatchNotReady with the batch
 * read again no longer closable, refused by its simulation) is not counted: it is that round's quiet skip, tried again next
 * round, so a holder's cancels can't trip the breaker on a batch they then fill. Nor is a close or the notice's close the
 * chain reverted when its block explains it (R12h, v32/actions.ts minedClose: the replay naming the door's WrongBatch,
 * BatchTooSmall or BatchNotReady at its block or the one before, or naming no reason with a deposit of the batch cancelled
 * from the read it was sent on through its block), or when the batch read again moved or shrank (R12g). Only a close, the
 * notice's close or a roll the chain reverted with nothing to explain it (still closable as it was sent, or unread) is a
 * wait this counts, never a stop. */
export const MAX_REFUSALS = 3;
export const SKIP_MS = 5 * 60_000;
export const SKIP_MAX_MS = 60 * 60_000;

const hours = (ms: number) => `${Number((ms / 3600_000).toFixed(1))} hour${ms === 3600_000 ? "" : "s"}`;
/** A clock time for the log: "2027-01-18 14:05 UTC". */
const at = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
/** How long a transaction with no receipt is watched for (from when the keeper stopped waiting for its
 * receipt) before it is reported as probably dropped: long after its last replacement would have gone. */
export const LATE_RECEIPT_MS = 6 * 3600_000;
/** How long after the keeper stopped waiting for its receipt (a 5-minute wait at the send) the keeper's
 * own transaction stays pending before it is replaced at the same nonce with a higher fee (deps.replace):
 * a slow block is not a stuck transaction. A replacement that is stuck in turn is replaced after twice as
 * long, and so on, MAX_REPLACEMENTS times; each is said loudly (REPLACING). Until then the wallet's
 * guard holds the chain's sends, as before. */
export const REPLACE_AFTER_MS = 15 * 60_000;
export const MAX_REPLACEMENTS = 3;

export interface RunOptions {
  intervalMs: number;
  maxTicks?: number;
  /** The claim policy `run` reports by (the host passes it: config.ts CLAIM_POLICY by default) */
  policy?: ClaimPolicy;
  rewardsEveryTicks?: number;
  live?: boolean;
  /** The longest wait between failed rounds (default 5 minutes; never less than the interval) */
  maxBackoffMs?: number;
  /** Failed rounds, or skips of one action, in a row after which each line starts STILL FAILING (default 10) */
  stillFailingAfter?: number;
  /** Rounds in a row failed on something unexpected after which the run stops (default 30) */
  maxUnexpectedRounds?: number;
  /** For tests: how the run waits between rounds, and its clock (ms) */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Does the next due thing every `intervalMs` until it stops itself. A delivery goes ahead only when its
 * simulation passes; one that would revert waits (its reason logged once) without holding up anything
 * else. A delivery that isn't sent (its re-check, its estimate or the wallet's guard refuses it), or that
 * reverts on chain, never ends the round: the round's payout, stake or close still goes ahead. One whose
 * estimate refuses it, or that reverted, is held, not retried, until the user's claimable amount,
 * preference, or the quote against the floors changes, or for 30 minutes (HOLD_MS). A reverted delivery
 * is explained by its decoded revert (a price race, the user's own change) or by re-checking the user;
 * one its simulation still passes on, on the same facts, with nothing to explain it, fails the round (the
 * log shows it) and is held too. Every reverted delivery counts against that user's revert budget
 * (REVERT_BUDGET within REVERT_WINDOW_MS): over it, that user is held for hours, said loudly, whatever
 * their facts do. No delivery ever stops the run: only states unsafe for everyone do. Reward claims are
 * only reported, every `rewardsEveryTicks` rounds. Each round starts by re-reading the record
 * (`deps.refresh`, onto `rec`, the record the deps were made with), so a read-back that failed since the
 * run started stops its sends.
 *
 * A failure inside a round ends that round, never the run, unless classifyFailure says it must stop it
 * (a keeper wallet found with code at any send, a delivery's too; a wrong key; the record not ready or
 * replaced; a payout list that doesn't match the vault's; a revert nothing explains), or 30 rounds in a
 * row fail on something unexpected: then the run logs "Stopped: <why>" and returns. Any other failure (a
 * race lost to another caller or a user, a pending transaction, an RPC fault) is logged on one line and
 * the next round decides again, after a wait that doubles with each failed round in a row (nextWaitMs);
 * from `stillFailingAfter` failed rounds in a row the line starts STILL FAILING, as does a skip of one
 * action (a lost race, a delivery the wallet's guard refuses) that many rounds in a row. A close, stake
 * or payout refused MAX_REFUSALS rounds in a row (its simulation, or its own re-read, saying no) trips
 * the circuit breaker: it is skipped, said loudly (SKIPPING), the round moves on to the next due action,
 * and it is tried again on a back-off (SKIP_MS, doubling to SKIP_MAX_MS), so one refused action never
 * starves the ones behind it. Nothing is ever
 * retried within the round that failed: a transaction with no receipt may still be pending, and the next
 * round's send guard refuses every send until it is mined or dropped; its receipt is looked up each
 * round, and a bridge message it sent is recorded once it lands. One still pending REPLACE_AFTER_MS after
 * it was sent is replaced at the same nonce with a higher fee (the same call if it still passes, else a
 * cancel), said loudly (REPLACING), at most MAX_REPLACEMENTS times with doubling waits: two transactions
 * at one nonce can't both be mined, so that never doubles a send. A close, roll, payout or stake that
 * reverts on chain is re-read first: a lost race is a skip; when that read fails, the next round's read
 * decides. Every line is logged with any URL's secrets stripped (scrubSecrets). */
export async function runLoop(deps: KeeperDeps, rec: KeeperTarget, opts: RoundOptions, memory: KeeperMemory = freshMemory()): Promise<LoopEnd> {
  const pause = opts.sleep ?? sleep;
  let m = memory;
  for (;;) {
    const r = await runRound(deps, rec, m, opts);
    m = r.memory;
    if (r.end) return r.end;
    if (opts.maxTicks && m.tick >= opts.maxTicks) return { stopped: false };
    await pause(r.waitMs);
  }
}

/** runRound's options: runLoop's, with the claim policy the host gives. */
export type RoundOptions = RunOptions & { policy: ClaimPolicy };

/** What one round leaves: the memory (the same object, updated: it is all the next round needs), and either how long
 * to wait before the next round (also in memory.nextAt, by the clock) or the end of the run when it stopped itself. */
export interface RoundResult {
  memory: KeeperMemory;
  waitMs: number;
  end?: Extract<LoopEnd, { stopped: true }>;
}

/** One round of runLoop (see it), from `memory` and onto it: every hold, budget, breaker count, watched transaction
 * and back-off the loop keeps between rounds is in the memory, so a run split across invocations, the memory saved
 * and loaded between them (encodeMemory, loadMemory), does what one loop does. The round number and the back-off's
 * next round time are in it too (memory.tick, memory.nextAt). */
export async function runRound(deps: KeeperDeps, rec: KeeperTarget, memory: KeeperMemory, opts: RoundOptions): Promise<RoundResult> {
  const m = memory;
  /** The deployment's actions: v3.2's when its target brings them, else v3-launch's */
  const A: KeeperActions = rec.actions ?? { act, roll, deliver, explainRace };
  const log = (line: string) => deps.log(scrubSecrets(line));
  const clock = opts.now ?? Date.now;
  const stillFailingAfter = opts.stillFailingAfter ?? 10;
  /** The memory's records, read and written as the Maps they were (memory.ts recordMap). */
  const waiting = recordMap(m.waiting);
  const held = recordMap(m.held);
  const reverts = recordMap(m.reverts);
  const skipRuns = recordMap(m.skipRuns);
  const refusals = recordMap(m.refusals);
  /** The skips, and the refusals of a close, stake or payout, of this round. */
  const skippedNow = new Set<string>();
  const refusedNow = new Set<string>();
  /** Whether the rails stopped this round (v3.2): neither a failure nor a recovery */
  let heldNow = false;
  /** The payouts whose list passed its check this round, and the open batches the round read (v3.2's rescan flag) */
  const listChecked = new Set<string>();
  let openKeys: Set<string> | undefined;
  /** v3.2 (R12d, M-1): what the one send path's spend cap refused this round: a chain it found at its cap (its sends wait
   * for the rest of the round, as a chain the rails read capped does), and the actions whose own worst case would cross
   * what is left of it (each passed over for the rest of the round: a smaller send still goes); what of it was said in
   * earlier rounds (memory.noRoom: each said once while it lasts); the actions tried this round; whether the round got to
   * its end (nothing else due). */
  const cappedNow = new Set<ChainName>();
  const roomless = new Set<string>();
  const roomSaid = new Set(m.noRoom ?? []);
  const roomNow = new Set<string>();
  const triedNow = new Set<string>();
  let reachedEnd = false;
  /** v3.2 (R12e): the actions refused this round by their own read of the chain, nothing sent (NotNow's `onRead`: a close
   * whose batch changed since the round read it; R12f: or one reverted BatchNotReady on chain, the batch read again no
   * longer closable; R12g: or any close or notice's close reverted on chain whose batch, read again, moved or shrank; R12h:
   * or one whose block explains it, its replay naming a door reason or a cancel of the batch's logged up to its block,
   * whatever a later read shows). Each is that round's quiet skip: said, passed over for the rest of the
   * round, never a failed round, and its breaker count neither grows nor starts again (so refusals of it that nothing
   * explains, between such skips, still trip the breaker); the next round decides again from its own read. */
  const readRefused = new Set<string>();
  /** A send of `a` the spend cap refused (R12d, M-1): a wait, never a failed round, said once while it lasts. Its chain at
   * the cap: nothing more is tried on that chain this round (the next round's rails read it and say SPEND CAP); only its
   * own worst case over what is left: that one action is passed over, and everything else goes on, on both chains. Before
   * R12d the refusal failed the round, every round, and the work behind it starved on both chains for up to 24 hours. */
  function noRoom(a: Action, e: SendRefused): void {
    const capped = e instanceof SpendCapRefused && e.atCap ? e.chain : undefined;
    const key = capped ? `chain:${capped}` : actionKey(a);
    if (capped) cappedNow.add(capped);
    // R12e: the action itself too, in both cases: a capped chain stops only what decideNext gates by the cap, and a token
    // park's conversion during the migration notice isn't (it passes the cap while the notice runs), so one refused at the
    // cap (the notice ended under it) was offered again and again within the one round
    roomless.add(actionKey(a));
    roomNow.add(key);
    if (roomSaid.has(key)) return;
    roomSaid.add(key);
    log(
      capped
        ? `SPEND CAP: ${oneLine(e.message)}: nothing more is sent on ${chainLabel(capped)} this round; the keeper's other work goes on`
        : `SPEND CAP ROOM: ${doing(a)} waits: ${oneLine(e.message)}; the keeper's other work goes on, on both chains (a smaller send that fits still goes), and it is tried again each round until the 24-hour sum leaves room for it`,
    );
  }

  const waits = (user: Address, reason: string) => {
    const key = user.toLowerCase();
    if (waiting.get(key) === reason) return;
    log(`Delivery to ${user} waits: ${reason}`);
    waiting.set(key, reason);
  };
  /** A skip of `key` this round, said as `line` (or by `quietly`); from `stillFailingAfter` rounds in a
   * row, loudly, every round. */
  const skipped = (key: string, what: string, line: string, quietly: () => void = () => log(line)) => {
    if (!skippedNow.has(key)) {
      skippedNow.add(key);
      skipRuns.set(key, (skipRuns.get(key) ?? 0) + 1);
    }
    const n = skipRuns.get(key) ?? 1;
    if (n >= stillFailingAfter) log(`STILL FAILING (${n} rounds; ${what}): ${line}`);
    else quietly();
  };
  const notDone = (a: Racing, why: string, hash: Hex) =>
    skipped(`not-done:${a.kind}`, doing(a), `Not done: ${why}; the transaction reverted on chain (transaction ${hash}); the next round decides again`);
  /** Holds a user's delivery for `forMs` (HOLD_MS), or until their `facts` change when those are given. */
  const hold = (key: string, reason: string, facts?: string, forMs = HOLD_MS) => held.set(key, { reason, facts, until: clock() + forMs });
  /** Counts a reverted delivery of `key`'s against the user's budget: how many fell within the window,
   * and the hold that costs (0 while within budget). Each hold within a window of the last one's end
   * doubles the one before; a window with no hold starts them again at REVERT_HOLD_MS. */
  function overBudget(key: string): { within: number; holdMs: number } {
    const now = clock();
    const r = reverts.get(key) ?? { at: [], strikes: 0 };
    r.at = [...r.at.filter((t) => now - t < REVERT_WINDOW_MS), now];
    reverts.set(key, r);
    if (r.at.length < REVERT_BUDGET) return { within: r.at.length, holdMs: 0 };
    if (r.holdEnd === undefined || now >= r.holdEnd + REVERT_WINDOW_MS) r.strikes = 0;
    r.strikes++;
    const holdMs = Math.min(REVERT_HOLD_MS * 2 ** (r.strikes - 1), REVERT_HOLD_MAX_MS);
    r.holdEnd = now + holdMs;
    return { within: r.at.length, holdMs };
  }
  /** Holds `user`'s delivery for the budget's hold, whatever their facts do, and says so loudly. */
  function heldLoudly(user: Address, budget: { within: number; holdMs: number }, last: string) {
    const until = clock() + budget.holdMs;
    hold(user.toLowerCase(), `held until ${at(until)}: ${budget.within} of this user's deliveries reverted on chain within ${hours(REVERT_WINDOW_MS)}`, undefined, budget.holdMs);
    log(
      `DELIVERY HELD: deliver to ${user} reverted on chain ${budget.within} times within ${hours(REVERT_WINDOW_MS)} (the last: ${last}); held ${hours(budget.holdMs)}, until ${at(until)}, whatever the price or the preference does; the user can claim by hand meanwhile, and the keeper's other work goes on`,
    );
  }

  /** A refusal of `a` (its simulation, or its own re-read, said no): counted; from MAX_REFUSALS in a row,
   * the breaker trips and returns true: `a` is skipped for a back-off (said loudly) and the round moves on
   * to the next due action. Before that, false: the round fails on it as before. */
  function tripped(a: Racing, e: SendRefused | NotNow): boolean {
    const key = actionKey(a);
    refusedNow.add(key);
    const r = refusals.get(key) ?? { n: 0, backoffMs: 0, until: 0 };
    r.n++;
    refusals.set(key, r);
    if (r.n < MAX_REFUSALS) return false;
    r.backoffMs = Math.min(Math.max(r.backoffMs * 2, SKIP_MS), SKIP_MAX_MS);
    r.until = clock() + r.backoffMs;
    // "times", not rounds: from the third on, the tries are a back-off apart
    log(
      `${r.backoffMs >= SKIP_MAX_MS ? "STILL SKIPPING" : "SKIPPING"} ${doing(a)}: refused ${r.n} times in a row (${classifyFailure(e).label}: ${oneLine(e.message)}); the keeper's other actions go ahead; tried again in ${inWords(r.backoffMs)}, at ${at(r.until)}`,
    );
    return true;
  }
  /** The actions the breaker holds back now (their back-off still running). */
  const skippedKeys = () => new Set(refusals.entries().filter(([, r]) => r.n >= MAX_REFUSALS && clock() < r.until).map(([k]) => k));
  /** The chain, or the keeper's own re-read of it, saying no to a send: its simulation, a gas price over
   * the cap, or NotNow. */
  const refused = (e: unknown): e is SendRefused | NotNow => (e instanceof SendRefused && (e.reason === "estimate" || e.reason === "fee")) || e instanceof NotNow;

  /** A close, roll, payout or stake that reverted on chain: true when the chains, read again, show it lost
   * a race (a skip). Nothing explaining it throws the revert (which stops the run); a read that fails
   * throws RevertUnread, and the next round's read decides. Anything else: false. */
  async function raced(e: unknown, a: Racing, before: KeeperState): Promise<boolean> {
    if (!(e instanceof RevertedOnChain)) return false;
    let after: KeeperState;
    try {
      after = await deps.readState();
    } catch (readError) {
      m.unread = { action: a, before, revert: saveRevert(e) };
      throw new RevertUnread(e, readError);
    }
    const why = A.explainRace(a, before, after);
    if (!why) throw e;
    notDone(a, why, e.hash);
    return true;
  }

  /** A transaction sent with no receipt: its receipt is looked up in later rounds. */
  function watch(a: Action, e: ReceiptTimeout) {
    if (!e.hash) return;
    const message =
      a.kind === "close" || a.kind === "roll" || a.kind === "flush"
        ? { adapter: rec.plan.addresses.baseAdapter, direction: "Base → Bittensor" as const }
        : a.kind === "payouts" || (a.kind === "park" && a.job === "refund")
          ? { adapter: (a.kind === "park" ? a.adapter : undefined) ?? rec.plan.addresses.bitAdapter, direction: "Bittensor → Base" as const }
          : undefined;
    const now = clock();
    m.unreceipted.push({ hashes: [e.hash], chain: e.chain, what: doing(a), message, request: e.request, since: now, replacements: 0, replaceAt: now + REPLACE_AFTER_MS, passed: 0 });
  }

  /** Reports a transaction of the keeper's that went through late (a late receipt, a replacement), and
   * records its bridge message. */
  function landed(u: Unreceipted, hash: Hex, logs: Sent["logs"], how: string) {
    // the watch's adapter first, then every listed pair's on that side (R4-O's fix round, Minor 5)
    const id = u.message ? [u.message.adapter, ...(rec.messageAdapters?.[u.message.direction] ?? [])].map((x) => messageIdFrom(logs, x)).find((x) => x !== undefined) : undefined;
    if (id && u.message) recordSafely(deps, { id, direction: u.message.direction, hash });
    log(`${how}: ${u.what} went through (transaction ${hash}${id ? `, bridge message ${id}` : ""})`);
  }

  /** Reports a transaction of the keeper's that reverted on chain late (a late receipt, a replacement).
   * A delivery's counts against that user's revert budget, as a revert at the send does (the facts it
   * was sent on are gone, so within budget it is held on time alone). A claim's (v3.2) is taken as one
   * reverted at its send (R8, M-A: A.claimRevertedLate): a wait, or that hotkey's claims held, said HELD
   * (CLAIM REVERTED AGAIN on a repeat), so the next reading doesn't send it again; never a cancel that took
   * its nonce (`cancelled`), which carried none of the call. */
  async function revertedLate(u: Unreceipted, hash: Hex, how: string, reason?: string, cancelled = false) {
    const said = `${how}: ${u.what} reverted on chain (transaction ${hash}${reason ? `, ${reason}` : ""})`;
    const req = u.request;
    if (req?.functionName === "claimRewards" && !cancelled && A.claimRevertedLate) {
      log(said);
      try {
        // R9 (L-2): when the keeper stopped waiting for it, and the hotkey's last claim read before the send, so another
        // caller's claim first is told from the keeper's own
        const r = await A.claimRevertedLate(deps, m, {
          hotkey: req.args[0] as Hex,
          hash,
          ...(reason ? { reason } : {}),
          now: clock(),
          since: u.since,
          ...(req.claimLast !== undefined ? { last: req.claimLast } : {}),
        });
        log("held" in r ? `HELD: ${u.what}: ${r.held}` : `Not done: ${r.wait}`);
      } catch (e) {
        log(`The late revert of ${u.what} could not be taken (${oneLine((e as Error).message)}); its next claim decides again`);
      }
      return;
    }
    if (req?.functionName !== "deliver") {
      log(said);
      return;
    }
    const user = req.args[0] as Address;
    // a pool that thinned before it landed (v3.2's ThinPool): a skip, never a strike (SE-4, R3 C-L1)
    const thinned = thinnedBeforeLanding(reason);
    if (thinned) {
      log(`${said}: ${thinned}`);
      return;
    }
    const budget = overBudget(user.toLowerCase());
    const why = explainDeliveryRevert(reason);
    if (budget.holdMs) {
      heldLoudly(user, budget, `transaction ${hash}${reason ? `, ${reason}` : ""}${why ? `: ${why}` : ""}`);
      return;
    }
    hold(user.toLowerCase(), `${said}; held for 30 minutes`);
    log(`${said}${why ? `: ${why}` : ""}; held for 30 minutes (${budget.within} of ${REVERT_BUDGET} in this user's revert budget)`);
  }

  /** Replaces `u`, pending for REPLACE_AFTER_MS with no receipt, at its nonce with a higher fee (the same
   * call if it still passes, else a cancel): said loudly, and through the guards every send passes
   * first (the record still ready, the wallet still without code: a failure of those stops the run, as
   * at any send). A replacement that lands ends the watch on `u` (nothing else can be mined at that
   * nonce); one with no receipt in its turn is watched with the original, and replaced again after twice
   * as long; one the node refuses leaves `u` watched. */
  async function replacePending(u: Unreceipted, still: Unreceipted[], cancel?: string) {
    const req = u.request as CallRequest;
    const latest = u.hashes.at(-1) as Hex;
    const nth = u.replacements ? `; replacement ${u.replacements + 1} of ${MAX_REPLACEMENTS}` : "";
    log(
      cancel
        ? `CANCELLING transaction ${latest} (${u.what}, nonce ${req.nonce}): no receipt ${inWords(clock() - u.since)} after the keeper stopped waiting for one, so its nonce is taken by a cancel (a transfer of nothing to the keeper itself, 21,000 gas, at the lowest fee a node takes as its replacement): ${cancel}${nth}`
        : `REPLACING transaction ${latest} (${u.what}, nonce ${req.nonce}): no receipt ${inWords(clock() - u.since)} after the keeper stopped waiting for one, so it is sent again at the same nonce with a higher fee (the same call if it still passes, else a cancel that only frees the nonce)${nth}`,
    );
    let r: Replacement;
    try {
      rec.requireReady(deps.signer, deps);
      await assertNoCode(deps, req.chain);
      // every hash: the pool may have evicted a later replacement and still hold the original
      const replace = deps.replace as NonNullable<KeeperDeps["replace"]>;
      r = cancel ? await replace(req, [...u.hashes], { cancel: true }) : await replace(req, [...u.hashes]);
    } catch (e) {
      if (e instanceof ReceiptTimeout && e.hash) {
        log(`Replacement sent, no receipt yet: transaction ${e.hash} (${u.what}, nonce ${req.nonce}) is watched with the original: whichever lands ends the watch`);
        u.hashes.push(e.hash);
        u.replacements++;
        u.replaceAt = clock() + REPLACE_AFTER_MS * 2 ** u.replacements;
        still.push(u);
        return;
      }
      if (e instanceof RevertedOnChain) {
        // its estimate passed seconds before: a race, and nonce req.nonce is free; the next round decides
        await revertedLate(u, e.hash, "Replacement", e.reason, cancel !== undefined);
        return;
      }
      // v3.2 (Task 52 fix round 1, review M3): a replacement refused at its chain's spend cap (a token park's conversion
      // during the notice passes the cap only while its park is still a token park: another caller's conversion meanwhile
      // ends that) takes the nonce with a cancel instead, which passes the cap (T51 re-review R1)
      if (!cancel && e instanceof SendRefused && e.reason === "spend-cap") {
        await replacePending(u, still, `the replacement was refused at the spend cap (${oneLine(e.message)}), where only a cancel goes`);
        return;
      }
      // a keeper wallet with code, a record no longer ready, a wrong key or chain: the round fails on it, and stops
      if (classifyFailure(e).stop) throw e;
      log(`Replacement not sent (${oneLine((e as Error).message)}); the watch goes on, tried again in ${inWords(REPLACE_AFTER_MS)}`);
      u.replaceAt = clock() + REPLACE_AFTER_MS;
      still.push(u);
      return;
    }
    if (!r.replaced) {
      log(`Not replaced: ${r.reason}; the watch goes on (a receipt, or the wallet's nonce passing it, ends it), tried again in ${inWords(REPLACE_AFTER_MS)}`);
      u.replaceAt = clock() + REPLACE_AFTER_MS;
      still.push(u);
      return;
    }
    if (r.cancelled) log(`Replaced: ${u.what} was cancelled at nonce ${req.nonce} (transaction ${r.hash}); the next round decides again`);
    else landed(u, r.hash, r.logs, "Replaced");
  }

  /** Looks up each transaction still with no receipt, by every hash it has (the original's and each
   * replacement's): one that landed is reported (its bridge message recorded) and ends the watch; so
   * does the wallet's mined nonce passing the call's, two rounds in a row, with none of them mined
   * (something else took the nonce); one pending REPLACE_AFTER_MS whose call is known is replaced
   * (replacePending); one with none after LATE_RECEIPT_MS is reported as probably dropped. A failure
   * that must stop the run (a replacement's guards) comes back as the round's. */
  async function lookUpReceipts(rails?: Rails): Promise<{ error: unknown; doing: string } | undefined> {
    if (!deps.receipt) {
      m.unreceipted = [];
      return undefined;
    }
    const still: Unreceipted[] = [];
    let failure: { error: unknown; doing: string } | undefined;
    for (const u of m.unreceipted) {
      if (failure) {
        still.push(u);
        continue;
      }
      let found: { hash: Hex; reverted: boolean; logs: Sent["logs"]; reason?: string } | undefined;
      let unread = false;
      for (const hash of u.hashes) {
        try {
          const r = await deps.receipt(u.chain, hash);
          if (r) {
            found = { hash, ...r };
            break;
          }
        } catch {
          unread = true;
        }
      }
      if (found) {
        if (found.reverted) await revertedLate(u, found.hash, "Late receipt", found.reason);
        else landed(u, found.hash, found.logs, "Late receipt");
        continue;
      }
      if (unread) {
        still.push(u);
        continue;
      }
      if (u.request && deps.minedNonce) {
        // twice in a row: a node a block behind the one that answered the receipts can't end a watch early
        let mined: number | undefined;
        try {
          mined = await deps.minedNonce(u.chain);
        } catch {
          // the next round asks again
        }
        u.passed = mined !== undefined && mined > u.request.nonce ? u.passed + 1 : 0;
        if (u.passed >= 2) {
          log(
            `Watch ended: something else was mined at nonce ${u.request.nonce} on ${chainLabel(u.chain)} (the wallet's mined nonce is ${mined}), and none of transaction${u.hashes.length === 1 ? "" : "s"} ${u.hashes.join(", ")} (${u.what}) has a receipt: check them on the chain's explorer${u.message ? "; if one went through, find its bridge message with pnpm ops status" : ""}`,
          );
          continue;
        }
      }
      // a replacement is a send: none while the rails stop the round (but a token park's conversion during ForeverMoney's
      // migration notice, the founder's one exception; the watch goes on). A claim is never sent again at a higher fee, and
      // on a chain at its spend cap only a cancel goes (it can only lower the sum): each is cancelled (T51 re-review R1)
      const conversion = rails?.migrationConversions === true && u.request?.rail === "migration-conversion";
      const railsAllow = !rails?.stop || conversion;
      // a token park's conversion during the notice passes the spend cap (the controller's ruling for Task 52): a stuck one
      // on a capped chain is sent again at a higher fee, not cancelled (T51 re-review's Minor)
      const noticeConversion = rails?.migrationNotice === true && u.request?.rail === "migration-conversion";
      const cancel =
        u.request?.replaceBy === "cancel"
          ? "a claim is never sent again at a higher fee (its worst case is most of the chain's spend cap)"
          : rails?.capped?.has(u.chain) && !noticeConversion
            ? `${chainLabel(u.chain)} is at its 24 h spend cap, where only a cancel goes (it can only lower the sum)`
            : undefined;
      if (deps.replace && u.request && u.replacements < MAX_REPLACEMENTS && clock() >= u.replaceAt && railsAllow) {
        try {
          await replacePending(u, still, cancel);
        } catch (e) {
          failure = { error: e, doing: `replacing ${u.what}` };
          still.push(u);
        }
        continue;
      }
      if (clock() - u.since < LATE_RECEIPT_MS) still.push(u);
      else {
        log(
          `NO RECEIPT ${hours(LATE_RECEIPT_MS)} after the keeper stopped waiting for one: transaction${u.hashes.length === 1 ? "" : "s"} ${u.hashes.join(", ")} (${u.what}) probably dropped, or sit on a node this one can't see. Check them on the chain's explorer${u.message ? "; if one went through, find its bridge message with pnpm ops status" : ""}`,
        );
      }
    }
    m.unreceipted = still;
    return failure;
  }

  /** One round. A failure comes back, with what the round was doing then (and, for a refusal of a close,
   * stake or payout that didn't trip the breaker, that action's key), instead of being thrown; an
   * unexplained delivery revert comes back once the round's other action is done. */
  async function round(tick: number): Promise<{ error: unknown; doing: string; refusal?: string } | undefined> {
    // the record as it is now: a read-back that failed since the run started stops its sends
    try {
      deps.refresh();
    } catch (e) {
      return { error: e, doing: "re-reading the record" };
    }
    // the deployment's own checks (v3.2's live readiness), before anything is looked up, replaced or sent
    if (A.beforeRound) {
      try {
        await A.beforeRound(deps, m, clock());
      } catch (e) {
        return { error: e, doing: "checking the deployment" };
      }
    }
    // the deployment's rails (v3.2: the monitor's hold, the spend cap, the deliveries switch), before anything is
    // looked up, replaced or sent
    let rails: Rails | undefined;
    if (A.rails) {
      try {
        rails = await A.rails(deps, m, clock());
      } catch (e) {
        return { error: e, doing: "reading the monitor and the rails" };
      }
    }
    // the transactions still waited on, before the chains are read for the round: a stuck one is looked
    // up and replaced whether or not the round's read goes through
    const looked = await lookUpReceipts(rails);
    if (looked) return looked;
    // a hold, or a monitor that can't see: nothing at all is sent this round (the rails said why, once per change).
    // Every action the round decides comes after this, so each one the round ever gains waits too. The founder's one
    // exception: while ForeverMoney's migration notice runs, the round reads on and offers token-park conversions only.
    const onlyConversions = rails?.stop !== undefined && rails.migrationConversions === true;
    if (rails?.stop) {
      heldNow = true;
      if (!onlyConversions) return undefined;
    }
    let s: KeeperState;
    try {
      s = await deps.readState({ economics: true });
    } catch (e) {
      // a revert the last round couldn't explain, and the chains still can't be read: the revert stops it
      if (m.unread) return { error: revertOf(m.unread.revert), doing: `${doing(m.unread.action)}, read again` };
      return { error: e, doing: "reading the chains" };
    }
    openKeys = new Set(s.vault.batches.filter((b) => b.cursor < b.count).map((b) => b.key.toLowerCase()));
    if (m.unread) {
      const u = m.unread;
      m.unread = undefined;
      const why = A.explainRace(u.action, u.before as KeeperState, s);
      if (!why) return { error: revertOf(u.revert), doing: `${doing(u.action)}, read again` };
      notDone(u.action, why, u.revert.hash);
    }
    // v3.2 (Task 52): the park job and the FAILURE re-executions, once a round after the state; a failed read only puts
    // them off (said), never fails the round. Under a hold during the migration notice, the conversions only. While the
    // notice runs (bridgeFirst) they are read before the deliveries, and a round with a token park's conversion due reads
    // no delivery: the conversion goes first this round, so the deliveries' reads never take a run's subrequests from it
    // (Task 52w). Otherwise after the deliveries, as before.
    let bridge: BridgeWork | undefined;
    const readBridge = async () => {
      if (!A.bridgeWork) return;
      try {
        bridge = await A.bridgeWork(deps, m, s, { now: clock(), onlyConversions });
      } catch (e) {
        log(`Could not read the parks and the bridge messages (${oneLine((e as Error).message)}); trying again later`);
      }
    };
    const bridgeFirst = A.bridgeWork !== undefined && A.bridgeFirst?.(s) === true;
    if (bridgeFirst) await readBridge();
    const converting = bridgeFirst && (bridge?.conversions ?? []).some((p) => !skippedKeys().has(actionKey({ kind: "convertPark", ...p })));
    let deliveries: DueDelivery[] = [];
    const facts = new Map<string, string | undefined>();
    // deliveries off (v3.2: usdcDelivery or the keeper's switch), or Base at its spend cap, or held (conversions only), or a
    // conversion due first this round: no candidate is even read
    const deliveriesOn = !rails?.noDeliveries && !rails?.capped?.has("base") && !onlyConversions && !converting;
    const queue: QueuedDelivery[] = [];
    /** v3.2 (Task 52w fix): the candidates read this round, at most A.deliveriesPerRound of them, in turn */
    const cap = A.deliveriesPerRound;
    const unread: string[] = [];
    let candidates: Address[] = [];
    let readNow: Address[] = [];
    try {
      candidates = deliveriesOn ? await deps.deliveryCandidates() : [];
      readNow = cap === undefined ? candidates : deliveryTurn(m, candidates, cap);
      for (const user of readNow) {
        let c: Awaited<ReturnType<typeof checkDelivery>>;
        try {
          c = await checkDelivery(deps, user);
        } catch (e) {
          if (cap === undefined) throw e;
          // v3.2: said and skipped for this round. It counts as read for its turn and is read again on its next one (the
          // Task 52w re-review's R1): put back at the front, candidates whose reads keep failing would take every place
          unread.push(oneLine((e as Error).message, 160));
          continue;
        }
        const key = c.user.toLowerCase();
        facts.set(key, c.facts);
        const h = held.get(key);
        if (h && ((h.facts !== undefined && c.facts !== undefined && h.facts !== c.facts) || clock() >= h.until)) held.delete(key);
        if (c.claimable === 0n) {
          waiting.delete(key);
          continue;
        }
        const hold = held.get(key);
        const due = c.deliver && c.keeperMinOut !== undefined && !hold;
        queue.push({ user: c.user, claimable: c.claimable, due });
        if (due) deliveries.push({ user: c.user, keeperMinOut: c.keeperMinOut as bigint });
        else waits(c.user, c.deliver && hold ? hold.reason : c.reason);
      }
    } catch (e) {
      return { error: e, doing: "reading the chains" };
    }
    if (cap !== undefined) {
      const said = unread.length ? `DELIVERIES READ IN PART: ${unread.length} of the ${readNow.length} users read this round could not be read (${unread[0]}); each is read again on its next turn, and the keeper's other work goes on` : undefined;
      if (said && said !== m.deliveriesUnreadSaid) log(said);
      m.deliveriesUnreadSaid = said;
    }
    if (A.queued && deliveriesOn) A.queued(deps, m, queue, cap === undefined ? undefined : candidates);
    if (!bridgeFirst) await readBridge();
    // v3-launch's run only reports a claim due (it never claims); v3.2 claims (A.rewards, below)
    if (!A.rewards && !onlyConversions && (tick === 1 || tick % (opts.rewardsEveryTicks ?? 30) === 0)) {
      m.claimDue = await reportClaim(deps, opts.policy, opts.live ?? false, m.claimDue);
    }
    /** v3.2's claims and adoption: read once nothing else is due this round (undefined until then) */
    let rewards: Rewards | undefined;
    let rewardsRead = false;
    /** An unexplained delivery revert: the round fails once its other action is done. */
    let soft: { error: unknown; doing: string } | undefined;
    let step = "deciding what is due";
    let current: Action | undefined;
    /** The action whose refusal, short of tripping the breaker, fails this round */
    let refusalOf: string | undefined;
    /** What the breaker holds back this round, and whatever trips it during the round. */
    const skip = skippedKeys();
    /** What will never be tried again (a final refusal, v3.2) */
    const final = new Set(Object.keys(m.final));
    try {
      for (;;) {
        // R12d (M-1): a chain the send path found at its cap this round counts as capped, and an action it refused for want of
        // room is passed over, for the rest of the round
        const capped = rails && cappedNow.size ? new Set([...(rails.capped ?? []), ...cappedNow]) : rails?.capped;
        const next = decideNext({
          ...s,
          deliveries,
          skipped: skip,
          final,
          ...(roomless.size ? { noRoom: roomless } : {}),
          ...(readRefused.size ? { readRefused } : {}),
          ...(rails ? { capped, confirmed: rails.confirmed, onlyConversions } : {}),
          ...(bridge ?? {}),
          ...(rewards ?? {}),
        });
        const action = next.action;
        if (!action) {
          // nothing else is due: v3.2's adoption and claims come last, so they are read only now (spec §3.8: payouts, then
          // stake or unstake, then claims; Task 51). A failed read waits for a later round, as v3-launch's report does
          if (A.rewards && !rewardsRead && !onlyConversions) {
            rewardsRead = true;
            step = "reading the claims and the adoption";
            try {
              rewards = await A.rewards(deps, m, { policy: opts.policy, now: clock(), every: opts.rewardsEveryTicks ?? 30, state: s });
            } catch (e) {
              log(`Could not read the claims and the adoption (${oneLine((e as Error).message)}); trying again later`);
            }
            if (rewards) continue;
          }
          reachedEnd = true;
          log(next.reason);
          break;
        }
        current = action;
        step = doing(action);
        triedNow.add(actionKey(action));
        if (action.kind === "roll") {
          // a roll that can't go ahead now is only a skip: the round ends, the next one decides again
          let r: Rolled;
          try {
            r = await A.roll(deps, rec);
          } catch (e) {
            if (await raced(e, action, s)) break;
            // R12d (M-1): the spend cap refused it: a wait, and the round goes on
            if (e instanceof SendRefused && e.reason === "spend-cap") {
              noRoom(action, e);
              continue;
            }
            // R12g: v3.2's roll reverted on chain with nothing to explain it (rollV32: a wait, never a stop) is counted by the
            // breaker as a close's wait is, so a roll that keeps reverting is passed over on a back-off rather than sent, and
            // its gas spent, every round
            if (e instanceof Waits) {
              if (tripped(action, e)) {
                skip.add(actionKey(action));
                continue;
              }
              refusalOf = actionKey(action);
            }
            throw e;
          }
          if (!r.rolled) skipped("not-rolled", step, `Not rolled: ${r.reason}`);
          else if (r.messageId) {
            log(
              `Done: the open batch closed instead of rolling: an entry landed first and its fee pot paid the bridge (transaction ${r.hash}, bridge message ${r.messageId})`,
            );
          } else log(`Done: ${next.reason} (transaction ${r.hash})`);
          break;
        }
        if (action.kind !== "deliver") {
          let done: Done;
          try {
            const key = action.kind === "payouts" ? action.key.toLowerCase() : undefined;
            done = await A.act(deps, rec, action, {
              rescanned: key !== undefined && m.rescannedPayout === key,
              policy: opts.policy,
              memory: m,
              now: clock(),
              listChecked: () => key !== undefined && listChecked.add(key),
            });
          } catch (e) {
            if (await raced(e, action, s)) break;
            // nothing will change it: said loudly once, and never tried again by this run; the round goes on
            if (e instanceof FinalRefusal) {
              m.final[e.key] = oneLine(e.message);
              final.add(e.key);
              log(`FINAL: ${doing(action)}: ${oneLine(e.message)}; it is not tried again`);
              continue;
            }
            // reverted with nothing to explain it, but nothing a fund's safety needs (a claim): its own job holds it for a
            // while, said loudly, and the round goes on, never a stop
            if (e instanceof HeldRefusal) {
              skip.add(e.key);
              log(`HELD: ${doing(action)}: ${oneLine(e.message)}`);
              continue;
            }
            // R12d (M-1): the spend cap refused it (its chain at the cap, or its own worst case over what is left: a close's
            // quoted fee in the band under the cap): a wait said once, never a failed round; the rest of the round goes on
            if (e instanceof SendRefused && e.reason === "spend-cap") {
              noRoom(action, e);
              continue;
            }
            // R12e: refused by its own read of the chain, nothing sent (a close whose batch changed since the round read it):
            // that round's quiet skip, said, never a failed round nor a breaker count, and the rest of the round goes on; the
            // next round decides again from its own read. Before R12e three such refusals in a row (a holder's cancel-downs
            // between the two reads) tripped the breaker, and a full batch then waited out its back-off
            if (e instanceof NotNow && e.onRead) {
              readRefused.add(actionKey(action));
              skipped(`read:${actionKey(action)}`, step, `Skipped this round (${step}): ${oneLine(e.message)}`);
              continue;
            }
            // refused MAX_REFUSALS times in a row: skipped, and the round moves on to the next due action
            // (nothing was sent, so nothing can be sent twice); before that, the round fails on it
            if (refused(e)) {
              if (tripped(action, e)) {
                skip.add(actionKey(action));
                continue;
              }
              refusalOf = actionKey(action);
            }
            throw e;
          }
          refusals.delete(actionKey(action));
          log(`Done: ${next.reason} (transaction ${done.hash}${done.messageId ? `, bridge message ${done.messageId}` : ""})`);
          break;
        }
        // whatever becomes of this delivery, the round's next action comes after it, never instead
        deliveries = deliveries.filter((d) => d.user !== action.user);
        const key = action.user.toLowerCase();
        const f = facts.get(key);
        let d: Delivery;
        try {
          d = await A.deliver(deps, rec, action.user);
        } catch (e) {
          // a pool that thinned between the simulation and the block it landed in (v3.2's ThinPool): a skip tried
          // again every round, never held and never a strike (SE-4, R3 C-L1). Not blind: the next round simulates
          // first, which refuses while the pool's mean stays under its floor
          const thinned = e instanceof RevertedOnChain ? thinnedBeforeLanding(e.reason) : undefined;
          if (thinned) {
            waits(action.user, `${(e as RevertedOnChain).message}: ${thinned}`);
            continue;
          }
          if (e instanceof RevertedOnChain) {
            // mined and reverted, so nothing is pending. Held at once, whatever the re-check finds (or if
            // it fails): a reverted delivery is never sent again blindly
            hold(key, `${e.message}; held while it is checked again`, f ?? "");
            const budget = overBudget(key);
            // the decoded revert first (a price race, the user's own change); else the user re-read
            let why = explainDeliveryRevert(e.reason);
            if (!why) {
              const again = await checkDelivery(deps, action.user);
              if (!again.deliver) why = again.reason;
              else if (again.facts !== f) why = "the user's claimable amount, preference or quote changed";
            }
            if (budget.holdMs) {
              // over budget, explained or not: this user waits, whatever the price or their preference
              // does, and the keeper's other work goes on. Said loudly every time
              heldLoudly(action.user, budget, `transaction ${e.hash}${e.reason ? `, ${e.reason}` : ""}${why ? `: ${why}` : ", and nothing explains it"}`);
              continue;
            }
            if (why) {
              const reason = `${e.message}: ${why}; not retried until the claimable amount, the preference or the quote against the floors changes, or for 30 minutes`;
              hold(key, reason, f ?? "");
              waits(action.user, reason);
              continue;
            }
            // its simulation still passes on the same facts, and the revert decodes to nothing that
            // explains it: the round fails on it (so the log shows it), and this user is held; never a stop
            hold(key, `${e.message}, while its simulation still passes on the same facts; held for 30 minutes, or until the user's facts change`, f ?? "");
            soft = { error: new DeliveryReverted(action.user, e), doing: step };
            continue;
          }
          if (e instanceof SendRefused && !classifyFailure(e).stop) {
            // R12d (M-1): Base found at its spend cap here: nothing more is tried on Base this round
            if (e instanceof SpendCapRefused && e.atCap) cappedNow.add(e.chain);
            // the wallet's guard (an earlier transaction pending, the nonce): not this user's facts, so
            // tried again next round. A wrong key or chain stops the run, as at any send
            const said = `${e.message}; it is tried again next round`;
            skipped(`deliver:${key}`, step, said, () => waits(action.user, said));
            continue;
          }
          throw e;
        }
        if (d.delivered) {
          waiting.delete(key);
          reverts.delete(key);
          const got = d.usdcOut === undefined ? "" : `, ${Number(d.usdcOut) / 1e6} USDC`;
          log(`Done: ${next.reason} (transaction ${d.hash}${got})`);
          break;
        }
        const thin = thinPool(d.refused);
        if (thin) {
          // refused by the send's own estimate for a thin pool: tried again next round, not held (SE-4)
          waits(action.user, `${thin}: ${THIN_POOL_WAIT}`);
        } else if (d.refused !== undefined && f !== undefined) {
          const reason = `${d.refused}; not retried until the claimable amount, the preference or the quote against the floors changes, or for 30 minutes`;
          hold(key, reason, f);
          waits(action.user, reason);
        } else {
          waits(action.user, d.reason);
        }
      }
    } catch (e) {
      if (e instanceof ReceiptTimeout && current) watch(current, e);
      return { error: e, doing: step, refusal: refusalOf };
    }
    return soft;
  }

  const maxUnexpected = opts.maxUnexpectedRounds ?? 30;
  const tick = ++m.tick;
  const failure = await round(tick);
  // the payout whose list a rescan is rebuilding: on v3.2 kept until a payout of that batch gets past its list check, or
  // the batch is gone, since a rescan may now span runs (T51 review I1); on v3-launch for the next round, as it always was
  if (failure?.error instanceof PayoutListRescan) m.rescannedPayout = failure.error.key.toLowerCase();
  else if (!A.rescanSpansRuns) m.rescannedPayout = undefined;
  else if (m.rescannedPayout !== undefined && (listChecked.has(m.rescannedPayout) || (openKeys !== undefined && !openKeys.has(m.rescannedPayout)))) m.rescannedPayout = undefined;
  // a skip that didn't happen this round starts its count again
  for (const key of skipRuns.keys()) if (!skippedNow.has(key)) skipRuns.delete(key);
  // R12d (M-1): what the spend cap refused stays said while it lasts: an action until it is tried and not refused for room,
  // or a round gets to its end without it (no longer due); a chain until a round in which the send path didn't find it at
  // the cap (the rails' own SPEND CAP line takes it from there)
  const roomKept = [...roomSaid].filter((k) => roomNow.has(k) || (!k.startsWith("chain:") && !triedNow.has(k) && !reachedEnd));
  if (roomKept.length) m.noRoom = roomKept;
  else delete m.noRoom;
  // an action neither refused this round nor still held back by the breaker (it went through, or is no
  // longer due) starts its refusals again; one its own read refused this round (R12e) keeps its count as it was
  for (const [key, r] of refusals.entries()) if (!refusedNow.has(key) && !readRefused.has(key) && !(r.n >= MAX_REFUSALS && clock() < r.until)) refusals.delete(key);
  const f = failure && classifyFailure(failure.error);
  m.unexpected = f?.kind === "unexpected" ? m.unexpected + 1 : 0;
  if (f && (f.stop || m.unexpected >= maxUnexpected)) {
    const reason = f.stop ? f.message : `${m.unexpected} rounds in a row failed on something unexpected; the last: ${f.message}`;
    log(`Stopped: ${oneLine(reason)}`);
    return { memory: m, waitMs: 0, end: { stopped: true, kind: f.kind, reason } };
  }
  if (f) {
    m.failing++;
    if (failure?.refusal) {
      if (!m.streak.keys.includes(failure.refusal)) m.streak.keys.push(failure.refusal);
    } else m.streak.refusalsOnly = false;
  } else if (m.failing && !heldNow) {
    // rounds that failed only on refusals of an action the breaker has since skipped: SKIPPING said
    // what happened, and nothing recovered
    const skippedSince = m.streak.refusalsOnly && m.streak.keys.every((k) => (refusals.get(k)?.n ?? 0) >= MAX_REFUSALS);
    if (!skippedSince) log(`Recovered after ${m.failing} failed round${m.failing === 1 ? "" : "s"}`);
    m.failing = 0;
    m.streak = { refusalsOnly: true, keys: [] };
  }
  const wait = nextWaitMs(opts.intervalMs, m.failing, opts.maxBackoffMs);
  if (failure && f) {
    const head = m.failing >= stillFailingAfter ? `STILL FAILING (${m.failing} rounds; ` : "Failed this round (";
    log(`${head}${f.label}, ${failure.doing}): ${oneLine(f.message)}; next round in ${inWords(wait)}`);
  }
  m.nextAt = clock() + wait;
  return { memory: m, waitMs: wait };
}

/** Whether the next round is due by the clock (`now`, ms): a host that is woken more often than the back-off allows
 * (the Worker's cron, each minute) skips the round until memory.nextAt. */
export const roundDue = (memory: KeeperMemory, now: number): boolean => now >= memory.nextAt;

/** `pnpm ops run`'s exit code when the keeper stops itself (classifyFailure) or refuses to start. The
 * supervisor (ops/scripts/keeper-supervised.ps1) restarts the keeper after any other non-zero exit, never
 * after this one with STOPPED_BANNER printed: what stopped it needs a person. */
export const KEEPER_STOPPED = 3;

/** How the line `run` prints with exit code 3 starts: the supervisor's proof that the 3 is the keeper's
 * own stop, not a code cmd or pnpm returned. */
export const STOPPED_BANNER = "THE KEEPER STOPPED ITSELF";

const stoppedBanner = (reason: string) =>
  `${STOPPED_BANNER}: ${oneLine(reason, 240)} (exit code ${KEEPER_STOPPED}: the supervisor won't restart it). Fix that, then start it again.`;

/** `pnpm ops run`: `start` loads the record, takes the deployment's run lock and checks the keeper's key
 * (and may log), then the loop runs until it stops itself. A start it refuses (no record, another keeper
 * running, a bad setting, a wrong key) and every stop the loop makes are deliberate: said loudly, exit
 * KEEPER_STOPPED. Anything else thrown (a crash) goes to the caller, a plain failure the supervisor
 * restarts. */
export async function runCommand(
  start: () => Promise<{ deps: KeeperDeps; rec: KeeperTarget; policy?: ClaimPolicy }>,
  log: (line: string) => void,
  opts: RoundOptions,
): Promise<number> {
  let s: Awaited<ReturnType<typeof start>>;
  try {
    s = await start();
  } catch (e) {
    const reason = scrubSecrets(oneLine(e instanceof Error ? e.message : String(e)));
    log(`Stopped: ${reason}`);
    log(stoppedBanner(reason));
    return KEEPER_STOPPED;
  }
  const end = await runLoop(s.deps, s.rec, { ...opts, ...(s.policy ? { policy: s.policy } : {}) });
  if (!end.stopped) return 0;
  log(stoppedBanner(end.reason));
  return KEEPER_STOPPED;
}

/** v3.2 (Task 52w fix): the delivery candidates this round reads, at most `cap`: the oldest (in `all`'s order, oldest credit
 * first) not read since the turn began; once fewer than `cap` are left, the turn ends and the next begins with the oldest,
 * filling the round. So every candidate is read within ceil(candidates / cap) rounds. The turn is kept in the memory. */
export function deliveryTurn(m: Pick<KeeperMemory, "deliveriesRead">, all: readonly Address[], cap: number): Address[] {
  const key = (u: Address) => u.toLowerCase();
  const present = new Set(all.map(key));
  const read = new Set((m.deliveriesRead ?? []).filter((u) => present.has(u)));
  let pick = all.filter((u) => !read.has(key(u))).slice(0, cap);
  if (pick.length < cap) {
    // the turn is over: the next one begins with the oldest, and the users this round reads count as its first
    const taken = new Set(pick.map(key));
    pick = [...pick, ...all.filter((u) => !taken.has(key(u))).slice(0, cap - pick.length)];
    read.clear();
  }
  for (const u of pick) read.add(key(u));
  m.deliveriesRead = [...read];
  const at = new Map(all.map((u, i) => [key(u), i]));
  return [...pick].sort((x, y) => (at.get(key(x)) ?? 0) - (at.get(key(y)) ?? 0));
}
