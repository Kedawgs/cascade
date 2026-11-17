import { type Address, formatEther, type Hex } from "viem";
import {
  type BridgeWork,
  closeValue,
  type Delivery,
  type Done,
  deliver,
  type KeeperActions,
  type KeeperDeps,
  type KeeperState,
  type KeeperTarget,
  keeperSend,
  payoutsMatch,
  type Rolled,
  type ActOptions,
  withMessage,
} from "../actions.ts";
import { adapterPairs, type DeploymentV32 } from "../deployment.ts";
import { DELIVERY_CHECKS_PER_ROUND } from "../delivery.ts";
import { actionKey, atMaxWait, closeDefers, closeHold, payoutsHold } from "../due.ts";
import { RevertedOnChain, SendRefused } from "../errors.ts";
import { FinalRefusal, HeldRefusal, KeeperBug, KeeperNotReady, NotNow, oneLine, PayoutListRescan, Waits } from "../failures.ts";
import type { KeeperMemory, Racing } from "../memory.ts";
import { rebuildPayouts } from "../payouts.ts";
import { adoptionDue, type ClaimPolicy, claimFor, claimGasLimit } from "../rewards.ts";
import { errorName } from "../send.ts";
import type { Sent } from "../types.ts";
import { depositOutlook, outlookLine } from "./bounce.ts";
import { CLAIM_HOLD_MS, claimRoom, heldWords, holdClaim, rewardsV32 } from "./claims.ts";
import { freeV32 } from "./hotkeys.ts";
import { convertV32, flushProblem, parkJobV32, parksV32 } from "./parked.ts";
import { chunkOf, planPayout } from "./payout.ts";
import { queueLogV32, railsV32 } from "./rails.ts";
import { type KeeperDepsV32, type KeeperStateV32, chunkSentFrom } from "./reads.ts";
import { checkReadyV32 } from "./readiness.ts";
import { reexecActionV32, reexecV32 } from "./reexec.ts";
import { adoptRequest, claimRequest, closeKeeps, closeRequest, payoutsRequest, rollRequest, stakeRequest } from "./requests.ts";
import { classifyRevert, conversionFloorIn } from "./reverts.ts";

// v3.2's closes, payouts and stakes on the keeper's core (plan Task 50; spec §3.5, §3.3, §3.10.15): close by the id
// and the value read, a paused door's batch still closing; the carried rebuild; processPayouts with a top-up only
// within the operator's limit and its gas by the Task 20 rule; each new revert taken as reverts.ts says, whether the
// simulation refused the send or the chain reverted it after the simulation passed. Deliveries (Task 50a) are
// core/actions.ts deliver's, on the v3.2 reads (their candidates, the outside-price veto) and behind v3.2's rails
// (rails.ts: the monitor's hold, the spend cap, the deliveries switch); claims and the adoption (Task 51) below, decided
// by claims.ts; parks are Task 52's.

const v32 = (deps: KeeperDeps): KeeperDepsV32 => {
  if (!("readPayoutInputs" in deps)) throw new Error("a v3.2 target needs the v3.2 deps (v32/reads.ts depsV32); nothing sent");
  return deps as KeeperDepsV32;
};
const tao = (wei: bigint) => `${formatEther(wei)} TAO`;

/** A v3.2 send's revert, taken the same whether its simulation refused it (nothing sent) or the chain reverted it after
 * the simulation passed (the reason its replay names, send.ts revertReason; nothing is pending after a mined revert,
 * so waiting is safe): its class (reverts.ts), and for a mined one the words that end its line. Undefined for anything
 * else: another refusal (the gas price, the nonce), a mined revert whose reason the table doesn't name or that has
 * none. A payout's or a stake's goes to the round's race check (explainRaceV32), and stops the keeper when nothing
 * explains it; a close's, the notice's close's and a roll's never does (R12g: minedClose, rollV32). */
type Taken = { c: ReturnType<typeof classifyRevert>; mined?: RevertedOnChain };
function taken(e: unknown): Taken | undefined {
  if (e instanceof SendRefused && e.reason === "estimate") return { c: classifyRevert(e.message) };
  if (e instanceof RevertedOnChain) {
    const c = classifyRevert(e.reason);
    if (c.class) return { c, mined: e };
  }
  return undefined;
}
const minedWords = (t: Taken) => (t.mined ? `; transaction ${t.mined.hash} reverted on chain` : "");
/** What a refused simulation the action has no rule for is (a refusal: the breaker counts it, and the next round's
 * simulation decides), for a mined revert of the same reason: a Waits, which the breaker counts the same way. A refused
 * simulation is thrown as it is. */
const asRefusal = (e: unknown, what: string, t: Taken): Error =>
  t.mined ? new Waits(`${what} waits: ${t.c.why} (${t.c.name})${minedWords(t)}; the next round decides again`) : (e as Error);

/** R12f: why batch `id` can't close on read `s` (closed by another, emptied, or canClose() false: a cancel took it under
 * every line that let it close), or undefined when it still can. */
const cantClose = (s: KeeperStateV32, id: bigint): string | undefined =>
  s.v32.openId !== id ? `batch ${id} is closed already` : s.frontDoor.nDeposits + s.frontDoor.nRedeems === 0 ? "it is empty" : !s.frontDoor.canClose ? "it is not ready to close" : undefined;

/** R12g: a mined revert whose replay names no reason the revert table takes: the reason, or that it has none (the call
 * passes at the block it was mined in and at the one before, send.ts revertReason, or the replay's RPC failed). */
const unnamed = (e: RevertedOnChain): string =>
  e.reason
    ? `${oneLine(e.reason, 200)}, a reason the keeper's revert table doesn't name`
    : "its replay names no reason (the call passes at the block it was mined in and at the one before, or the replay couldn't be read)";

/** R12h: the front door's reasons a close's replay can name for the batch itself changing under it: another close first
 * (WrongBatch), less than its minValue (BatchTooSmall: a cancel), canClose() false (BatchNotReady: a cancel under every line
 * that let it close, or a roll). */
const DOOR_REASONS: ReadonlySet<string> = new Set(["WrongBatch", "BatchTooSmall", "BatchNotReady"]);

/** R12h (b): what the front door's DepositCancelled logs say of batch `id` from the read `before` that its close was sent
 * on through the block the close was mined in (`e.block`): a cancel there (`found`), or what the line says otherwise (none
 * in those blocks; or that they couldn't be read: the blocks unknown, the logs server behind, a window refused). */
async function cancelsUnder(deps: KeeperDepsV32, id: bigint, before: KeeperStateV32, e: RevertedOnChain): Promise<{ found: string } | { said: string }> {
  const from = before.v32.readBlock;
  const to = e.block;
  if (from === undefined || to === undefined) return { said: "; the blocks to read its cancels in aren't known (the read's or the receipt's)" };
  let cancels: Awaited<ReturnType<KeeperDepsV32["cancelsIn"]>>;
  try {
    cancels = await deps.cancelsIn(id, from, to);
  } catch (y) {
    return { said: `; its cancels from block ${from} (the read it was sent on) to block ${to} (the one it was mined in) couldn't be read (${oneLine((y as Error).message)})` };
  }
  const c = cancels.at(-1);
  if (!c) return { said: `; no deposit of it was cancelled from block ${from} (the read it was sent on) to block ${to} (the one it was mined in)` };
  const more = cancels.length > 1 ? ` (and ${cancels.length - 1} more)` : "";
  return { found: `a deposit of ${tao(c.amount)} was cancelled from it in block ${c.block}${more}, between the read it was sent on (block ${from}) and the block it was mined in (${to})` };
}

/** R12f, R12g, R12h (the keeper reviews of R12e-R12f and of R12g, M1): a close of batch `id` (`what`: "the close", "the
 * notice's close"), sent on read `before`, that the chain reverted after its simulation passed (`e`; `r`, its class when the
 * table names its reason). A reverted close moved nothing (nothing is pending after it, so waiting is safe), so it never
 * stops the keeper, whatever its replay names or fails to name. What explains it is the round's quiet skip (onRead: never a
 * failed round, nor a count for the breaker, nor its count started again, as a refusal by the close's own read), the next
 * round reading the batch again and deciding:
 * - (a) the replay at the block it was mined in or the one before names the door's own reason (DOOR_REASONS: WrongBatch,
 *   BatchTooSmall, BatchNotReady): the batch changed under it in the chain's own state there, whatever a later read finds
 *   (no read again: a holder's cancelled TAO put back by then explains nothing away);
 * - (b) the replay names no reason (it passes at both blocks, or couldn't be read): a deposit of the batch cancelled from
 *   the read it was sent on through the block it was mined in (the door's DepositCancelled logs, cancelsUnder: a holder's
 *   cancel just before the close with a higher tip and a deposit just after with a lower one, both block-end states
 *   closable, for about a cent);
 * - else, read again (a reason the table doesn't name, or (b) found no cancel or couldn't read them): closed by another,
 *   emptied, no longer closable, holding less than the read it was sent on, or refused by `refuses` (what the action's own
 *   read would refuse now).
 * What trips the breaker is only a wait nothing above explains: the replay naming no door reason, no cancel of the batch in
 * those blocks (or none readable), and the batch read again still closable as it was sent (the same batch, holding no less),
 * or the read failing: three such rounds in a row skip it for 5 minutes, doubling to an hour, never a stop. Before R12h the
 * re-read at "latest" a few seconds after the broadcast decided alone, so a tip-ordered cancel and deposit around each of
 * three closes, the TAO back by then, tripped the breaker and kept a full batch open through its back-off; before R12g a
 * revert with no reason went raw to the round's race check, which stopped the keeper until restarted. */
async function minedClose(
  deps: KeeperDepsV32,
  x: { e: RevertedOnChain; r?: Taken; id: bigint; what: string; before: KeeperStateV32; refuses?: (after: KeeperStateV32) => string | undefined },
): Promise<Waits> {
  const { e, r, id, what } = x;
  const tail = `; transaction ${e.hash} reverted on chain`;
  const name = r?.c.name;
  const cause = name !== undefined ? `${name}: ${r?.c.why}` : unnamed(e);
  const said = `${name !== undefined ? `${r?.c.why} (${name})` : unnamed(e)}${tail}`;
  const quiet = (why: string) => new Waits(`batch ${id} changed under ${what} after its simulation passed (${cause})${tail}; ${why}; the next round decides again`, { onRead: true });
  // (a) the chain's own state at its block, or the one before, says the batch changed under it
  if (name !== undefined && DOOR_REASONS.has(name)) return quiet("its replay names that at the block it was mined in or the one before, whatever the batch holds now");
  // (b) no reason replayed: a cancel of the batch's in the blocks the close was sent and mined over
  let cancels = "";
  if (!e.reason) {
    const c = await cancelsUnder(deps, id, x.before, e);
    if ("found" in c) return quiet(`${c.found}, whatever the batch holds now`);
    cancels = c.said;
  }
  let after: KeeperStateV32;
  try {
    after = await deps.readState();
  } catch (y) {
    return new Waits(`${what} of batch ${id} waits: ${said}${cancels}; the batch couldn't be read again (${oneLine((y as Error).message)}); the next round decides again`);
  }
  const was = x.before.v32.openTotal;
  const why =
    cantClose(after, id) ??
    (after.v32.openTotal < was ? `it holds less than the read it was sent on (${tao(after.v32.openTotal)} of ${tao(was)}: a deposit was cancelled)` : undefined) ??
    x.refuses?.(after);
  if (why) return quiet(`read again, ${why}`);
  return new Waits(`${what} of batch ${id} waits: ${said}${cancels}; read again, it can still close, so nothing explains it; the next round decides again`);
}

/** R12g: what the close's own read would refuse on the batch read again after a mined revert (AlphaVault no longer healthy,
 * the vault refusing batches): the round's quiet skip, as at the close's own read. */
const closeRefuses = (s: KeeperStateV32): string | undefined =>
  !s.alphaVault.healthy ? "AlphaVault is paused or migrating now" : s.vaultRefuses ? `the vault would refuse it now (${s.vaultRefuses})` : undefined;

/** Closes the open batch by the id and the deposits the keeper read (closeBatch(id, minValue): 0 at its max wait, R12c,
 * the least total still full for a batch full by its limits before it, R12b, else the fee rule's: the total less one
 * minimum deposit, R12g, or 0 when the pot covers the close's quote, R12h): AlphaVault must be healthy, the batch must have
 * entries and be able to close; a paused door's
 * batch closes all the same (a pause never
 * stops a close on v3.2: I-20, the web's sendGate). A batch with redeem requests waits while the vault's payouts are
 * closed (R7, L4: its primary bridge disabled on the vault, or its canSendPayouts() false), as the vault would defer each.
 * A batch with deposits waits so only until its max wait, then closes, saying its redeem requests will be deferred (R8,
 * L-C: due.ts payoutsHold, closeDefers). Before a batch with deposits the vault won't mint for, it says
 * what will become of them (bounce.ts). When the simulation answers WrongBatch or BatchTooSmall (the batch changed
 * since the read), the batch is read again once and, if it can still close and the close rule still closes it (a
 * cancelled deposit can leave a full batch not full, or its fees short of the bridge fee), sent once more with what
 * that read says; a second refusal waits for the next round (Waits). When the chain reverts the close for either after
 * its simulation passed, it waits, and the next round reads the batch again and decides: a mined revert has spent its
 * gas, so it is never sent again in the same round. Any other revert a reason explains waits too, as its refused
 * simulation is a refusal (the breaker counts both). The close rule (decideNext's) decides again on the close's own read
 * too, read with the fees it needs (R12d, L-1: a batch the round read as full and cancelled down before this read would
 * otherwise go as it is, at the keeper's cost), but `byHand` (pnpm ops close: the operator's own call there; its re-read
 * after a refusal still decides by the rule). The floors are the same either way. R12e: a refusal by the close's own
 * reads, nothing sent (each check of a read below, the hold by the close rule, and a second WrongBatch or BatchTooSmall
 * after the re-read), is marked `onRead`: the round's quiet skip, never a failed round nor a count for the breaker (a
 * holder's cancel-downs between the round's read and the close's, three in a row, tripped it before, and the full batch
 * they filled waited out its back-off). A mined revert, and a refused simulation no rule explains, the breaker still
 * counts. R12f: BatchNotReady (a cancel between the close's own read and its simulation took the batch under every line
 * that let it close) reads the batch again once: no longer closable there, that is the round's quiet skip too; still
 * closable, it is sent once more, and a second BatchNotReady is a refusal the breaker counts. Reverted BatchNotReady on
 * chain (the cancel landed after the simulation), the batch read again no longer closable is the round's quiet skip as
 * well; still closable, a wait the breaker counts, never a stop. R12g: every revert on chain is taken by minedClose, never
 * a stop. R12h: there a door reason the replay names (WrongBatch, BatchTooSmall, BatchNotReady) is the round's quiet skip
 * whatever a later read shows, as is a revert with no reason when a deposit of the batch was cancelled from the read it was
 * sent on through its block; else the batch read again decides (moved or shrank: a quiet skip; still closable as it was
 * sent, or unread: a wait the breaker counts). A close by the fee rule names the total less one minimum deposit (reads.ts
 * feeCloseFloor), so a holder's 1-rao cancel landing just before it no longer voids it, and 0 when the pot covers its quote
 * (R12h). */
export async function closeV32(depsIn: KeeperDeps, t: KeeperTarget, o: { byHand?: boolean } = {}): Promise<Done> {
  const deps = v32(depsIn);
  t.requireReady(deps.signer, deps);
  let s = await deps.readState(o.byHand ? {} : { economics: true });
  /** The error the first simulation refused the close with (WrongBatch, BatchTooSmall) */
  let refusedFor: string | undefined;
  /** R12e: refused by the close's own read, nothing sent */
  const onRead = { onRead: true };
  for (let attempt = 0; ; attempt++) {
    if (!s.alphaVault.healthy) throw new NotNow("AlphaVault is paused or migrating — not closing the batch", onRead);
    // a batch the vault would refuse would only park on Bittensor: it waits on Base (Task 52w; T57c m2)
    if (s.vaultRefuses) throw new NotNow(`not closing the batch: ${s.vaultRefuses}, so a batch sent now would park on Bittensor; it stays on Base until the vault takes it again`, onRead);
    if (s.frontDoor.nDeposits + s.frontDoor.nRedeems === 0) throw new NotNow("the open batch is empty", onRead);
    if (!s.frontDoor.canClose) throw new NotNow("the open batch is not ready to close yet", onRead);
    // R7 (L4), R8 (L-C): its redeem requests would only be deferred while the vault's payouts are closed: a batch of them
    // alone waits on Base; one with deposits only until its max wait, then closes and its redeem requests are deferred
    const paid = payoutsHold(s);
    if (paid) throw new NotNow(`not closing the batch: ${paid}`, onRead);
    // the close rule (decideNext's) decides again on this read: the batch the round read was due, this one may not be (a
    // cancel-down since: R12d, L-1); after a refusal, the hand close's re-read too
    const held = attempt > 0 || !o.byHand ? closeHold(s) : undefined;
    if (held) {
      throw new Waits(
        attempt > 0
          ? `batch ${s.v32.openId} changed under the close (${refusedFor}), and now ${held}; the next round decides again`
          : `batch ${s.v32.openId} changed since the round read it, and now ${held}; the next round decides again`,
        onRead,
      );
    }
    const outlook = outlookLine(depositOutlook(s.v32.vault), s.frontDoor.nDeposits);
    if (outlook && attempt === 0) deps.log(outlook);
    const defers = closeDefers(s, s.v32.openId);
    if (defers && attempt === 0) deps.log(defers);
    let sent: Sent;
    try {
      // the float, three quotes, and what of it the close keeps, its quote less the batch's pot (the door spends the pot
      // first): what the spend cap's check counts of it (R12a; R12d, L-2)
      const quote = await deps.quoteClose(s);
      const keeps = closeKeeps(quote, s.v32.feePot);
      // R12c: at its max wait the batch goes whatever its fees and its size, so minValue 0, and a holder's 1-rao cancel of
      // an aged entry before each send can't hold its deposits on Base past it (canClose() still guards the close, and an
      // emptied batch only rolls). R12b, R12d (L-1): before it a batch full by its limits names the least total still full
      // (fullFloor, before its interval too), for the same reason. R12g: a close by the fee rule names the total less one
      // minimum deposit (feeFloor: a cancel refunds none of the fees the rule weighed), so a 1-rao cancel can't void it and a
      // cancel-down still does. R12h: one whose pot covers its quote (it keeps none of the float: closeKeeps 0) names 0, as
      // the door pays its bridge fee from the pot whatever a cancel leaves (a smaller batch's fee is never higher), so junk
      // redeem requests that make a batch fee-covered buy no cancel that voids its close; the exact total only where the read
      // gives no floor (a mirror the door disagrees with)
      const feeRule = s.v32.feeFloor === undefined ? undefined : keeps === 0n ? 0n : s.v32.feeFloor;
      const minValue = atMaxWait(s) ? 0n : (s.v32.fullFloor ?? feeRule ?? s.v32.openTotal);
      sent = await keeperSend(deps, closeRequest(t, s.v32.openId, minValue, closeValue(quote), await deps.nonce("base"), keeps));
    } catch (e) {
      const r = taken(e);
      const mined = { id: s.v32.openId, what: "the close", before: s, refuses: closeRefuses };
      // R12g: reverted on chain for a reason the table doesn't name, or none its replay could read: never a stop (R12h: no
      // reason, its batch's cancels first, then read again)
      if (!r) throw e instanceof RevertedOnChain ? await minedClose(deps, { e, ...mined }) : e;
      const { c } = r;
      // R12f: BatchNotReady, a cancel since the close's own read took the batch under every line that let it close
      if (c.class === "not-closable") {
        if (r.mined) throw await minedClose(deps, { e: r.mined, r, ...mined });
        // refused again after a re-read that said it could close: something else is wrong, a refusal the breaker counts
        if (refusedFor === c.name) throw e;
        // read again once: the checks above decide on it (not closable: the round's quiet skip), else it is sent once more
        deps.log(`Not closed yet: ${c.why} (${c.name}); reading the open batch again`);
        refusedFor = c.name;
        s = await deps.readState({ economics: true });
        continue;
      }
      if (c.class !== "reread") throw asRefusal(e, `the close of batch ${s.v32.openId}`, r);
      // R12g, R12h: WrongBatch or BatchTooSmall on chain: the replay names the batch's change at its block, the round's
      // quiet skip (a mined revert has spent its gas, so it is never sent again in the same round)
      if (r.mined) throw await minedClose(deps, { e: r.mined, r, ...mined });
      // refused again with the re-read's own values: the batch moved under each read (R12e: a quiet skip, nothing sent)
      if (attempt > 0) throw new Waits(`batch ${s.v32.openId} changed under the close again (${c.name}: ${c.why}); the next round decides again`, onRead);
      deps.log(`Not closed yet: ${c.why} (${c.name}); reading the open batch again`);
      refusedFor = c.name;
      s = await deps.readState({ economics: true });
      continue;
    }
    return withMessage(deps, sent, s.v32.primary.base, "Base → Bittensor");
  }
}

/** The migration notice's one close (Task 52; spec M-7: flush the open batch at once, then close nothing): batch `id`,
 * read again now, while ForeverMoney's notice still runs, its migration has not executed, the batch opened before the
 * notice began, more than FLUSH_MARGIN_S is left before migrationReadyAt and the vault would take it (parked.ts
 * flushProblem: all read from the chain, so the one close survives a memory lost), the batch still open, with entries and able to close; closeBatch(id,
 * 0: R12b) whatever the close rule and AlphaVault's health. Once it has closed, the next batch opened during the
 * notice, and nothing more is closed. WrongBatch or BatchTooSmall waits for the next round's read, as a close's second
 * refusal does. R12e: a refusal by its own read, nothing sent, is the round's quiet skip, as a close's is (closeV32).
 * R12f: BatchNotReady is taken as a close's is: read again once, no longer closable the round's quiet skip, else sent once
 * more and a second one counted. R12g, R12h: every revert on chain is taken by minedClose, as a close's is, never a stop: a
 * door reason its replay names (WrongBatch: another close landed first, the notice's one close done; BatchNotReady), or no
 * reason and a deposit of the batch cancelled from the read it was sent on through its block, is the round's quiet skip;
 * else read again, a batch closed by another, emptied, no longer closable, holding less, or one flushProblem now refuses,
 * is the round's quiet skip too, and one still closable as it was sent (or unread) a wait the breaker counts. */
export async function flushV32(depsIn: KeeperDeps, t: KeeperTarget, id: bigint): Promise<Done> {
  const deps = v32(depsIn);
  t.requireReady(deps.signer, deps);
  let s = await deps.readState();
  const onRead = { onRead: true };
  /** R12f: the simulation refused it BatchNotReady once, and the batch was read again */
  let reread = false;
  for (;;) {
    const no = flushProblem(s);
    if (no) throw new NotNow(no.why, onRead);
    if (s.v32.openId !== id) throw new NotNow(`batch ${id} is closed already: the notice's one close is done`, onRead);
    if (s.frontDoor.nDeposits + s.frontDoor.nRedeems === 0) throw new NotNow("the open batch is empty: there is nothing to close", onRead);
    if (!s.frontDoor.canClose) throw new NotNow("the open batch is not ready to close yet", onRead);
    let sent: Sent;
    try {
      const quote = await deps.quoteClose(s);
      // R12b (the cooldown review): minValue 0. The notice's one close goes whatever the close rule, so the exact total
      // guarded nothing it needs, and let a holder's 1-rao cancel of an aged entry void it each round until its deadline;
      // canClose() still guards it, and a cancel-down costs at most this one close
      sent = await keeperSend(deps, closeRequest(t, id, 0n, closeValue(quote), await deps.nonce("base"), closeKeeps(quote, s.v32.feePot)));
    } catch (e) {
      const r = taken(e);
      const mined = { id, what: "the notice's close", before: s, refuses: (a: KeeperStateV32) => flushProblem(a)?.why };
      // R12g: reverted on chain for a reason the table doesn't name, or none its replay could read: never a stop (R12h: no
      // reason, its batch's cancels first, then read again)
      if (!r) throw e instanceof RevertedOnChain ? await minedClose(deps, { e, ...mined }) : e;
      if (r.c.class === "not-closable") {
        if (r.mined) throw await minedClose(deps, { e: r.mined, r, ...mined });
        if (reread) throw e;
        deps.log(`Not closed yet: ${r.c.why} (${r.c.name}); reading the open batch again`);
        reread = true;
        s = await deps.readState();
        continue;
      }
      // R12g, R12h: WrongBatch on chain (another close landed first) is the round's quiet skip; refused by its simulation,
      // the next round's read
      if (r.c.class === "reread") throw r.mined ? await minedClose(deps, { e: r.mined, r, ...mined }) : new Waits(`batch ${id} changed under the notice's close (${r.c.name}: ${r.c.why}); the next round reads it again`);
      throw asRefusal(e, `the notice's close of batch ${id}`, r);
    }
    return withMessage(deps, sent, s.v32.primary.base, "Base → Bittensor");
  }
}

/** Rolls the empty open batch by its id (closeBatch(id, 0), no value), as core/actions.ts roll does, a paused door
 * included. A roll its simulation refuses, or the chain reverted for a reason the table names, is not rolled (a skip);
 * one reverted otherwise is read again: an entry, another close or a roll landed first, the batch no longer able to roll,
 * or AlphaVault no longer healthy, not rolled (a skip). R12g: still empty and able to roll, or the read failing, nothing
 * explains it: a wait the breaker counts (round.ts), never a stop; before R12g the raw revert went to the round's race
 * check, which stopped the keeper. */
export async function rollV32(depsIn: KeeperDeps, t: KeeperTarget): Promise<Rolled> {
  const deps = v32(depsIn);
  t.requireReady(deps.signer, deps);
  const s = await deps.readState();
  const fd = s.frontDoor;
  const skip = (reason: string): Rolled => ({ rolled: false, reason });
  if (s.closeMaxWaitS === 0) return skip("the deployment has no max wait: an empty batch is left as it is");
  if (!s.alphaVault.healthy) return skip("AlphaVault is paused or migrating — not rolling the empty batch");
  // an entry landing first would make the roll a close the vault would refuse (Task 52w)
  if (s.vaultRefuses) return skip(`not rolling the empty batch: ${s.vaultRefuses}, so a batch sent now would park on Bittensor; it stays on Base until the vault takes it again`);
  if (fd.nDeposits + fd.nRedeems > 0) return skip("the open batch has entries now; the close rule decides it");
  if (!fd.canClose) return skip("the open batch can't close yet");
  let sent: Sent;
  try {
    sent = await keeperSend(deps, rollRequest(t, s.v32.openId, await deps.nonce("base")));
  } catch (e) {
    if (e instanceof SendRefused && e.reason === "estimate") return skip(`${e.message}; the next round decides again`);
    // the chain reverted it after its simulation passed, for a reason the table names: not rolled, as a refused
    // simulation is (another close or roll landed first: WrongBatch). R12f's BatchNotReady is the close's; a roll's is read
    // again below, as before (an entry, another close or a roll landing first)
    const r = taken(e);
    if (r?.mined && r.c.class !== "not-closable") return skip(`${r.c.why} (${r.c.name}); the roll reverted on chain (transaction ${r.mined.hash}); the next round decides again`);
    if (e instanceof RevertedOnChain) {
      const what = `the roll of batch ${s.v32.openId} waits: ${r?.c.name !== undefined ? `${r.c.why} (${r.c.name})` : unnamed(e)}; transaction ${e.hash} reverted on chain`;
      let after: KeeperStateV32;
      try {
        after = await deps.readState();
      } catch (y) {
        throw new Waits(`${what}; the batch couldn't be read again (${oneLine((y as Error).message)}); the next round decides again`);
      }
      const a = after.frontDoor;
      if (a.nDeposits + a.nRedeems > 0 || !a.canClose || after.v32.openId !== s.v32.openId || a.openStart !== fd.openStart) {
        return skip(`an entry or another close landed first; the roll reverted (transaction ${e.hash})`);
      }
      if (!after.alphaVault.healthy) return skip(`AlphaVault is paused or migrating now; the roll reverted (transaction ${e.hash}); the next round decides again`);
      throw new Waits(`${what}; read again, it is still empty and can still roll, so nothing explains it; the next round decides again`);
    }
    throw e;
  }
  return { rolled: true, ...(await withMessage(deps, sent, s.v32.primary.base, "Base → Bittensor")) };
}

/** stakeIdle, unless the vault is paused or its stake is missing: then staking waits, said loudly, and the keeper's
 * other work goes on (StakeMissing: "stop staking, report"), whether the read, the simulation or the chain says so. */
export async function stakeV32(depsIn: KeeperDeps, t: KeeperTarget): Promise<Done> {
  const deps = v32(depsIn);
  t.requireReady(deps.signer, deps);
  const s = await deps.readState();
  if (s.vault.paused) throw new NotNow("the vault is paused");
  const missing = "staking waits: some of the vault's stake is not on a listed hotkey (StakeMissing), which needs the owner or the guardian; the keeper's other work goes on";
  if (s.vault.stakeMissing) throw new Waits(missing);
  try {
    return await keeperSend(deps, stakeRequest(t, await deps.nonce("bittensor")));
  } catch (e) {
    const r = taken(e);
    if (!r) throw e;
    if (r.c.class === "stop-staking") throw new Waits(`${missing}${minedWords(r)}`);
    throw asRefusal(e, "staking", r);
  }
}

/** Pays out `key`'s next chunk: the list rebuilt from the vault's events (after the owner's cancel, the bounces it
 * carried: rebuildPayouts), held to the vault's hash (a mismatch rescans once, then refuses for good, as v3-launch);
 * the plan (payout.ts planPayout): the top-up only within the deployment's limit (OPS_PAYOUT_TOPUP_MAX), the stake at
 * face value covering the walk; then processPayouts(key, list, 50) with the top-up as its value and the estimate plus
 * EXIT_GAS_RESERVE (2,000,000 since Task 65, the deployed vault's own: the for-life list holds them equal) + listed
 * positions × unstakeGas as its gas. A plan that waits, or a simulation that answers
 * FeeTooHigh or UnstakeShort, waits (Waits); NothingToCancel, NotScheduled or AboveBridgeCap is final; BadValue stops
 * the keeper (KeeperBug). The chain reverting it after its simulation passed (the fee rose, a hold or another exit
 * took the stake) is taken the same way by the reason its replay names; only a revert nothing explains stops the
 * keeper. The chunk's charges are logged from its PayoutChunkSent. */
export async function payoutsV32(depsIn: KeeperDeps, t: KeeperTarget, key: Hex, o: ActOptions = {}): Promise<Done> {
  const deps = v32(depsIn);
  t.requireReady(deps.signer, deps);
  const s = await deps.readState();
  if (!s.alphaVault.healthy) throw new NotNow("AlphaVault is paused or migrating — not paying out");
  if (s.vault.paused) throw new NotNow("the vault is paused");
  const b = s.vault.batches.find((x) => x.key.toLowerCase() === key.toLowerCase());
  if (!b || b.cursor >= b.count) throw new NotNow(`no payout is pending for batch ${key.slice(0, 10)}…`);
  if (s.now < b.queuedAt + s.vault.payoutDelay) throw new NotNow(`batch ${key.slice(0, 10)}… is not due yet`);
  const list = rebuildPayouts(await deps.payoutLogs(), key, await deps.cancelOf(key));
  const stored = await deps.batchInfo(key);
  if (!payoutsMatch(list, stored) && !o.rescanned) {
    deps.rescanPayoutLogs();
    throw new PayoutListRescan(
      key,
      `the payout list rebuilt from the vault's events (${list.length} entries) does not match batch ${key.slice(0, 10)}… (${stored.count} entries): the vault's events are scanned again in full, and the next round decides; nothing sent`,
    );
  }
  // past its list check: a rescan's flag can go (the round keeps it until then, across runs: T51 review I1)
  if (payoutsMatch(list, stored)) o.listChecked?.();
  const inputs = await deps.readPayoutInputs(key);
  const chunk = chunkOf(key, list, inputs);
  const quote = await deps.quotePayout(inputs.batch.sourceChain, inputs.batch.frontDoor, chunk.message, chunk.sum);
  const plan = planPayout(list, inputs, quote, deps.deployment.payoutTopUpMax);
  if (!plan.go) throw new Waits(`payout batch ${key.slice(0, 10)}… waits: ${plan.reason}`);
  const what = `payout batch ${key.slice(0, 10)}…`;
  /** A send's refusal or mined revert, as the error the action throws for it. */
  /** The residual: a floor above the chunk's gross itself, which no top-up lifts (it waits for the floor or a new route). */
  const residual = (floor: bigint) =>
    new Waits(`${what} waits: the chain's conversion floor, ${tao(floor)}, is above even its chunk's gross, ${tao(plan.sum)} (BelowConversionFloor): no top-up helps; it waits for the floor to fall or for a new route`);
  /** A send's refusal or mined revert, as the error the action throws for it; `full` when the send was the full top-up. */
  const refusal = (e: unknown, full = false): unknown => {
    const r = taken(e);
    if (!r) return e;
    const { c } = r;
    const mined = minedWords(r);
    if (c.class === "stop") return new KeeperBug(`${(e as Error).message}: ${c.why} (${c.name}), a keeper bug; nothing more is sent`);
    if (c.class === "top-up") {
      return new Waits(
        plan.walk > 0n
          ? `${what} waits: its walk's cost would leave an entry nothing (FeeTooHigh; the leaver pays), so it is paid once liquid TAO covers it without a walk${mined}`
          : `${what} waits: its bridge fee rose above what its entries pay and the ${tao(deps.deployment.payoutTopUpMax)} the keeper may add (FeeTooHigh)${mined}`,
      );
    }
    // merge 7b: the floor rose after the simulation (mined); the full top-up refused too (review M5: by the floor now above
    // the gross, by a walk's cost the entries bear, or by the fee or the floor moving); or, refused for the floor with a
    // reason that names none, the full top-up never tried
    if (c.class === "full-top-up") {
      if (r.mined) return new Waits(`${what} waits: the chain's conversion floor rose above its net after the simulation (BelowConversionFloor)${mined}; the next round's simulation decides the full top-up`);
      if (!full) {
        return new Waits(`${what} waits: the chain's conversion floor refuses its net (BelowConversionFloor), but the reason names no floor to judge the full top-up by, so it isn't tried; the next round decides again`);
      }
      const again = conversionFloorIn((e as Error).message);
      if (again && plan.sum < again.floor) return residual(again.floor);
      if (again && plan.walk > 0n) {
        return new Waits(
          `${what} waits: even with the full top-up its net is under the chain's conversion floor, ${tao(again.floor)}: its walk's cost falls on its entries (the leaver pays, spec §3.3), so it is paid once liquid TAO covers it without a walk (BelowConversionFloor)`,
        );
      }
      return new Waits(`${what} waits: the chain's conversion floor refused it with the full top-up too (BelowConversionFloor): the fee or the floor moved since the quote; the next round decides again`);
    }
    if (c.name === "InsufficientGas") return new Waits(`${what} waits: ${c.why} (${c.name})${mined}; the next round estimates its gas again`);
    if (c.class === "wait") return new Waits(`${what} waits: ${c.why} (${c.name}); a deposit, a stake or a reward moves it (the buffer rule: an idleBufferBps that keeps the payouts liquid)${mined}`);
    if (c.class === "final" || c.class === "report") {
      return new FinalRefusal(actionKey({ kind: "payouts", key }), `${c.class === "report" ? "REPORT: " : ""}${what}: ${(e as Error).message}: ${c.why}`);
    }
    return asRefusal(e, what, r);
  };
  let sent: Sent;
  // merge 7b (spec §3.3, the R4-K review's Minor 6): the value is the top-up the quote asks, never more, since any value
  // that covers the whole fee pays all of it; the full top-up (the whole fee) only when the floor refuses the chunk's net
  let full = false;
  try {
    sent = await keeperSend(deps, payoutsRequest(t, key, list, stored, await deps.nonce("bittensor"), plan.topUp, plan.gasAbove));
  } catch (e) {
    const r = taken(e);
    const below = r?.c.class === "full-top-up" && !r.mined ? conversionFloorIn((e as Error).message) : undefined;
    if (!below) throw refusal(e);
    if (plan.sum < below.floor) throw residual(below.floor);
    deps.log(
      `Payout batch ${key.slice(0, 10)}…: its net after the entries' fee, ${tao(below.net)}, is under the chain's conversion floor, ${tao(below.floor)} (BelowConversionFloor): the keeper sends the full top-up, the whole ${tao(plan.fee)} bridge fee (${tao(plan.fee - plan.topUp)} more than the top-up the quote asks), so its entries are sent their gross, ${tao(plan.sum)}`,
    );
    full = true;
    try {
      sent = await keeperSend(deps, payoutsRequest(t, key, list, stored, await deps.nonce("bittensor"), plan.fee, plan.gasAbove, true));
    } catch (e2) {
      throw refusal(e2, true);
    }
  }
  const done = await withMessage(deps, sent, s.v32.primary.bittensor, "Bittensor → Base");
  const c = chunkSentFrom(sent.logs, t.plan.addresses.vault);
  if (c) {
    // what each paid, from the chunk's own event: a quote that fell to at or below the value sent made the keeper pay the
    // whole fee (never more than it sent: the vault refunds the rest), never the entries
    const keeper = c.fee - c.charged;
    const fell = !full && keeper > 0n && c.charged === 0n && plan.charged > 0n;
    deps.log(
      `Payout chunk of batch ${key.slice(0, 10)}…: ${tao(c.net)} sent; the entries paid ${tao(c.charged)} of the ${tao(c.fee)} bridge fee${c.unstakeCost ? ` and ${tao(c.unstakeCost)} of unstake cost` : ""}${keeper > 0n ? `, the keeper ${tao(keeper)}` : ""}${full ? " (the full top-up)" : fell ? ` (the quote fell to at or below the ${tao(plan.topUp)} top-up it sent, so the vault charged it the whole fee and refunded the rest)` : ""}`,
    );
  }
  return done;
}

/** The reverts a claim or an adoption can meet once it was decided (the chain moved under it): each a wait, the next
 * round deciding again. */
const REWARD_REVERTS: Record<string, string> = {
  UnknownHotkey: "the hotkey is no longer listed",
  // R6b (U1): only the keeper may claim while the claim schedule still vests
  NotKeeper: "the keeper's key isn't the vault's keeper() now, and only the keeper may claim while rewards still vest (a rotation: the next round's readiness says so)",
  InsufficientGas: "the call's gas fell short: a claim's of the vault's claimGasRequired (changed since it was read), an adoption's of its read of the chain's minimum (the gas guard)",
  AdoptTooSoon: "another adoption landed first (a day, STAKE_RAMP, must pass from it)",
  BelowMinAdoption: "the surplus is no longer at least the chain's minimum stake",
};

/** A claim's or an adoption's revert REWARD_REVERTS names, refused by its simulation or reverted on chain after it: a
 * Waits (a refusal the breaker counts; nothing is pending after a mined revert, so waiting is safe). Undefined for
 * anything else. */
function rewardWait(e: unknown, what: string): Waits | undefined {
  const reason = e instanceof SendRefused && e.reason === "estimate" ? e.message : e instanceof RevertedOnChain ? e.reason : undefined;
  const names = [...(reason ?? "").matchAll(/\b([A-Z][A-Za-z0-9]*)\(/g)].map((m) => m[1]);
  const name = names.reverse().find((n) => n in REWARD_REVERTS) ?? errorName(reason);
  if (!name || !(name in REWARD_REVERTS)) return undefined;
  const mined = e instanceof RevertedOnChain ? `; transaction ${e.hash} reverted on chain` : "";
  return new Waits(`${what} waits: ${REWARD_REVERTS[name]} (${name})${mined}; the next round decides again`);
}

/** Another caller's claim went first on `named` (hotkey 0x…): anyone may claim once the claim schedule has vested and
 * KEEPER_FALLBACK has passed since a hotkey's last claim (R6b, U1). */
const claimedFirst = (named: string) => `another caller claimed ${named}'s rewards first (anyone may once the claim schedule has vested and 7 days have passed since its last claim)`;

/** R9 (L-2): how far before `since` (when the keeper stopped waiting for a late claim's receipt: round.ts, the watch's
 * clock) a hotkey's last claim may be stamped and still be taken for another caller's claim first, when the claim's
 * request carries no last claim read before its send (a watch kept from before R9). The send was up to a receipt wait
 * earlier (the Worker's 40 s; 5 minutes by hand), and Bittensor's block time and the keeper's clock may run apart. A claim
 * that paid before the keeper's read would have left nothing due (its credits claimed), so none this close to the send
 * is a claim the keeper's read missed. */
export const LATE_CLAIM_SLACK_MS = 10 * 60_000;

/** Claims listed hotkey `hotkey`'s rewards (claimRewards(hotkey), Task 51) when, read again now, the claim policy (or, for
 * a hotkey being freed, A17) still says so, the wallet holds the claim's up-front fee and Bittensor's spend cap has room
 * for its worst case (claims.ts claimRoom); sent with the fixed gas limit the vault's claimGasRequired needs. Not listed,
 * or no longer due: NotNow; no room: Waits. A revert the chain moved under it explains (UnknownHotkey, InsufficientGas)
 * waits; one with no reason (the precompile refuses a claim by burning its gas) is explained by a fresh read: the hotkey
 * removed meanwhile, or another caller's claim first (its last claim moved since the read before the send: R8, L-B, never
 * its credits falling, which an unstake may do; anyone may claim once the claim schedule has vested and KEEPER_FALLBACK
 * has passed since a hotkey's last claim: R6b, U1), each a
 * wait. One nothing explains never stops the keeper (a claim is no fund's safety; the controller's ruling, Task 51 fix
 * round 1): claims on that one hotkey are held for CLAIM_HOLD_MS (24 h), doubling with each repeat since a claim last
 * paid, at most CLAIM_HOLD_MAX_MS (16 days; R7, M1), or until a claim on it pays or the vault's claimGasRequired changes
 * (R8, L-A, L-B), kept in `memory` (the round's), and HeldRefusal says so (a repeat loudly: CLAIM REVERTED AGAIN); the
 * round goes on. A claim whose receipt comes late is held the same way (claimRevertedLateV32). */
export async function claimV32(depsIn: KeeperDeps, t: KeeperTarget, hotkey: Hex, policy: ClaimPolicy | undefined, o: Pick<ActOptions, "memory" | "now"> = {}): Promise<Done> {
  const deps = v32(depsIn);
  t.requireReady(deps.signer, deps);
  if (!policy) throw new Error("a claim needs the claim policy to decide by, and none was given; nothing sent");
  const named = `hotkey ${hotkey.slice(0, 10)}…`;
  const r = await deps.readClaims();
  const h = r.hotkeys.find((x) => x.hotkey.toLowerCase() === hotkey.toLowerCase());
  if (!h) throw new NotNow(`${named} is no longer listed; nothing claimed`);
  const c = claimFor(h, r, policy);
  if (!c.claim) throw new NotNow(`not claiming on ${named}: ${c.reason}; nothing sent`);
  const room = await claimRoom(deps, r);
  if (room) throw new Waits(`the claim on ${named} waits: ${room}`);
  try {
    // R9 (L-2): the request carries the hotkey's last claim as read now, for a receipt that comes late
    return await keeperSend(deps, claimRequest(t, h.hotkey, claimGasLimit(r.claimGasRequired), await deps.nonce("bittensor"), r.feeCapWei, h.lastClaimAt));
  } catch (e) {
    const w = rewardWait(e, `the claim on ${named}`);
    if (w) throw w;
    if (e instanceof RevertedOnChain) {
      let after: Awaited<ReturnType<KeeperDepsV32["readClaims"]>> | undefined;
      try {
        after = await deps.readClaims();
      } catch {
        // unread: nothing explains it, and it is held as below on the credits it was sent on
      }
      const now = after?.hotkeys.find((x) => x.hotkey.toLowerCase() === hotkey.toLowerCase());
      if (after && !now) throw new Waits(`${named} was removed under the claim; transaction ${e.hash} reverted on chain; the next round decides again`);
      if (now && now.lastClaimAt > h.lastClaimAt) throw new Waits(`${claimedFirst(named)}; transaction ${e.hash} reverted on chain; the next round decides again`);
      const clock = o.now ?? Date.now();
      const held = o.memory
        ? holdClaim(o.memory, h.hotkey, { now: clock, credits: (now ?? h).waitingWei, hash: e.hash, gas: r.claimGasRequired, last: (now ?? h).lastClaimAt })
        : { until: clock + CLAIM_HOLD_MS, ms: CLAIM_HOLD_MS, strikes: 1 };
      throw new HeldRefusal(actionKey({ kind: "claim", hotkey: h.hotkey }), heldWords(named, e.hash, held));
    }
    throw e;
  }
}

/** R8 (M-A): a claim of the keeper's whose receipt came late (round.ts revertedLate: the Worker waits 40 s, about three
 * Bittensor blocks, and a ~57M-gas claim is the send likeliest to miss it), reverted on chain: taken as claimV32 takes a
 * revert at its send, so a claim that keeps reverting is never sent again every few rounds. A reason REWARD_REVERTS names
 * (replayed at its block: the late receipt replays a claim's) is a wait, and so is the hotkey gone from the list on a fresh
 * read; and (R9, L-2) so is another caller's claim first: the hotkey's lastClaimAt read now past `last`, the one read
 * before the send (one chain's clock against itself), or, without that, stamped no more than LATE_CLAIM_SLACK_MS before
 * `since`, when the keeper stopped waiting for the receipt. Else its claims are held (holdClaim: a day, doubling with each
 * repeat, on the strikes the memory keeps), the HELD line's words claimV32's (heldWords), keeping `last` when known (else
 * the read's), so a claim on it that pays since ends the hold at the next reading by Bittensor's clock (rewardsV32). A read
 * that fails holds it all the same. What the round says: a wait's why, or the hold's words. */
export async function claimRevertedLateV32(
  depsIn: KeeperDeps,
  memory: KeeperMemory,
  x: { hotkey: Hex; hash: Hex; reason?: string; now: number; since?: number; last?: number },
): Promise<{ wait: string } | { held: string }> {
  const deps = v32(depsIn);
  const named = `hotkey ${x.hotkey.slice(0, 10)}…`;
  const w = rewardWait(new RevertedOnChain("bittensor", "", x.hash, x.reason), `the claim on ${named}`);
  if (w) return { wait: w.message };
  let after: Awaited<ReturnType<KeeperDepsV32["readClaims"]>> | undefined;
  try {
    after = await deps.readClaims();
  } catch {
    // unread: nothing explains it, and it is held
  }
  if (after && !after.hotkeys.some((h) => h.hotkey.toLowerCase() === x.hotkey.toLowerCase())) {
    return { wait: `${named} was removed under the claim; the next round decides again` };
  }
  const now = after?.hotkeys.find((h) => h.hotkey.toLowerCase() === x.hotkey.toLowerCase());
  // R9 (L-2): another caller's claim landed between the keeper's read and its claim, which then reverted: a wait
  const moved =
    now !== undefined &&
    (x.last !== undefined ? now.lastClaimAt > x.last : x.since !== undefined && now.lastClaimAt * 1000 >= x.since - LATE_CLAIM_SLACK_MS);
  if (moved) return { wait: `${claimedFirst(named)}; the next round decides again` };
  const last = x.last ?? now?.lastClaimAt;
  const held = holdClaim(memory, x.hotkey, {
    now: x.now,
    ...(now ? { credits: now.waitingWei } : {}),
    ...(last !== undefined ? { last } : {}),
    hash: x.hash,
    ...(after ? { gas: after.claimGasRequired } : {}),
  });
  return { held: heldWords(named, x.hash, held) };
}

/** Adopts the vault's surplus (adoptStake, Task 51) when, read again now, it is due (core/rewards.ts adoptionDue: at
 * least the chain's minimum, the vault not paused, no stake missing, a STAKE_RAMP since the chain's lastAdoptAt); else
 * NotNow. AdoptTooSoon or BelowMinAdoption (the chain moved under it) waits; any other revert goes to the round's race
 * check. */
export async function adoptV32(depsIn: KeeperDeps, t: KeeperTarget): Promise<Done> {
  const deps = v32(depsIn);
  t.requireReady(deps.signer, deps);
  const a = adoptionDue(await deps.readAdoption());
  if (!a.adopt) throw new NotNow(`not adopting: ${a.reason}; nothing sent`);
  try {
    return await keeperSend(deps, adoptRequest(t, await deps.nonce("bittensor")));
  } catch (e) {
    const w = rewardWait(e, "the adoption");
    if (w) throw w;
    throw e;
  }
}

/** Why a v3.2 close, roll, payout or stake that reverted on chain, for a reason the revert table doesn't name or for
 * none its replay could read (a named one is taken by its class in the action itself), lost a race (round.ts's
 * explainRace on v3.2): the batch the close read is no longer the open one, or holds less (a cancel); AlphaVault
 * paused or migrating; another caller paid the batch out; the vault paused; the idle TAO gone or the stake gone
 * missing. A front door's pause explains nothing here: on v3.2 it never stops a close. R12g: a close's, the notice's
 * close's and a roll's revert no longer reach it (each action reads the batch again itself: minedClose, rollV32); their
 * branches stay for a revert a memory saved before R12g left unexplained (memory.unread). */
export function explainRaceV32(a: Racing, beforeIn: KeeperState, afterIn: KeeperState): string | undefined {
  const before = beforeIn as KeeperStateV32;
  const after = afterIn as KeeperStateV32;
  // a park conversion, a park job and a re-execution explain their own reverts (parked.ts, reexec.ts: a revert never
  // leaves them); a claim explains its own (claimV32; claims go on while the vault is paused, so a pause explains nothing
  // there)
  if (a.kind === "convertPark" || a.kind === "park" || a.kind === "reexec" || a.kind === "claim" || a.kind === "free") return undefined;
  // the notice's one close races as a close does (another close landing first), whatever AlphaVault's health
  if (a.kind === "flush") {
    const fd = after.frontDoor;
    const moved = after.v32.openId !== before.v32.openId || fd.openStart !== before.frontDoor.openStart || !fd.canClose;
    if (moved || fd.nDeposits + fd.nRedeems === 0) return "another close landed first";
    return after.v32.openTotal < before.v32.openTotal ? "a deposit was cancelled under the close" : undefined;
  }
  if (a.kind === "close" || a.kind === "roll") {
    const fd = after.frontDoor;
    if (!after.alphaVault.healthy) return "AlphaVault was paused or began migrating";
    const moved = after.v32.openId !== before.v32.openId || fd.openStart !== before.frontDoor.openStart || !fd.canClose;
    if (a.kind === "roll") return moved || fd.nDeposits + fd.nRedeems > 0 ? "an entry or another close landed first" : undefined;
    if (moved || fd.nDeposits + fd.nRedeems === 0) return "another close landed first";
    return after.v32.openTotal < before.v32.openTotal ? "a deposit was cancelled under the close" : undefined;
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
  if (after.vault.stakeMissing) return "the vault's stake went missing (StakeMissing)";
  if (a.kind === "adopt") return undefined;
  if (after.vault.available < after.vault.minStakeWei) return "the idle TAO is no longer above the staking floor";
  return undefined;
}

/** The round's bridge work (Task 52; core/actions.ts KeeperActions.bridgeWork): the park job's (parked.ts parksV32), then
 * the FAILURE watch's (reexec.ts reexecV32: its reports, the lanes that wait, and with OPS_REEXEC_AUTO on the re-executions),
 * each read on its own: one that can't be read puts only itself off,
 * said. Under a hold during the migration notice, only the parks' conversions. */
async function bridgeWork(deps: KeeperDeps, memory: KeeperMemory, s: KeeperState, o: { now: number; onlyConversions: boolean }): Promise<BridgeWork | undefined> {
  let parks: Awaited<ReturnType<typeof parksV32>>;
  let reexecs: Awaited<ReturnType<typeof reexecV32>>;
  try {
    parks = await parksV32(deps, memory, s, o);
  } catch (e) {
    deps.log(`Could not read the parks (${oneLine((e as Error).message)}); trying again later`);
  }
  if (!o.onlyConversions) {
    try {
      reexecs = await reexecV32(deps, memory, { now: o.now });
    } catch (e) {
      deps.log(`Could not read Cascade's bridge messages for FAILUREs (${oneLine((e as Error).message)}); trying again later`);
    }
  }
  return parks || reexecs ? { ...(parks ?? {}), ...(reexecs ?? {}) } : undefined;
}

/** v3.2's actions for the round (core/actions.ts KeeperActions), with its readiness before every round, then its rails
 * (Task 50a) before anything is looked up or sent, its delivery queue logged when it changes, and its claims and adoption
 * (Task 51) read once nothing else is due. */
export const V32_ACTIONS: KeeperActions = {
  act(deps, t, a, o) {
    switch (a.kind) {
      case "close":
        return closeV32(deps, t);
      case "stake":
        return stakeV32(deps, t);
      // Task 52's park job: a token park's conversion during the migration notice (convertParkRequest, the founder's
      // exception), the notice's one close, and the park jobs
      case "convertPark":
        return convertV32(deps, t, { key: a.key, recipient: a.recipient, sender: a.sender, message: a.message, ...(a.adapter ? { adapter: a.adapter } : {}) });
      case "flush":
        return flushV32(deps, t, a.id);
      case "park":
        return parkJobV32(deps, t, a, { memory: o?.memory, now: o?.now });
      // Task 52: a FAILURE of Cascade's own re-executed on its destination's OffRamp, only with OPS_REEXEC_AUTO on (the
      // founder's ruling: by hand at launch; reexecActionV32 refuses otherwise)
      case "reexec":
        return reexecActionV32(deps, t, a, { memory: o?.memory, now: o?.now });
      case "claim":
        return claimV32(deps, t, a.hotkey, o?.policy, { memory: o?.memory, now: o?.now });
      case "adopt":
        return adoptV32(deps, t);
      // Task 53: a swap's old hotkey's slot, freed once the owner's setStakeHotkey moved off it and its credits read 0
      case "free":
        return freeV32(deps, t, a.hotkey, { memory: o?.memory, now: o?.now });
      case "payouts":
        return payoutsV32(deps, t, a.key, o);
    }
  },
  roll: rollV32,
  deliver: (deps, t, user): Promise<Delivery> => deliver(deps, t, user),
  explainRace: explainRaceV32,
  beforeRound: (deps: KeeperDeps, memory: KeeperMemory, now: number) => checkReadyV32(v32(deps), memory, now),
  rails: railsV32,
  queued: queueLogV32,
  rewards: rewardsV32,
  claimRevertedLate: claimRevertedLateV32,
  bridgeWork,
  // at most this many delivery candidates read a round, in turn (Task 52w fix): their reads never take a run's budget
  deliveriesPerRound: DELIVERY_CHECKS_PER_ROUND,
  // while ForeverMoney's migration notice runs, its conversions come before the deliveries' reads (Task 52w)
  bridgeFirst: (s: KeeperState) => (s as KeeperStateV32).v32.alpha.migrationReadyAt !== 0n,
  rescanSpansRuns: true,
};

/** The v3.2 deployment as the round's target: its contracts, USDC delivery by the deployment's flag (the round's rails
 * stop every delivery first while it is off; this refuses a hand one), and v3.2's actions. Who it sends as is the key
 * keeper() names on both contracts, read live by its readiness (beforeRound; R4, D-M1: a rotation needs no new
 * deployment), never a stored verify, nor the deployment's keeper, which stays the plan's first. */
export function targetV32(d: DeploymentV32): KeeperTarget {
  const a = d.addresses;
  return {
    plan: { addresses: { frontDoor: a.frontDoor, vault: a.vault, baseAdapter: a.baseAdapter, bitAdapter: a.bitAdapter } },
    messageAdapters: { "Base → Bittensor": adapterPairs(d).map((p) => p.baseAdapter), "Bittensor → Base": adapterPairs(d).map((p) => p.bitAdapter) },
    requireReady(_signer: Address, deps: KeeperDeps) {
      // the core's entry points pass their deps: only depsV32's send through the rails (a mis-wiring never sends without);
      // none at all is refused too (T50a round-2 R2-3)
      if (typeof deps !== "object" || deps === null || !("railsSeen" in deps && "settleJournal" in deps)) {
        throw new KeeperNotReady("a v3.2 target needs the v3.2 deps (depsV32), whose sends pass the rails; nothing sent");
      }
    },
    deliveryPlan() {
      if (!d.usdcDelivery) throw new Error("USDC delivery is off for this deployment (deployments.json usdcDelivery): credits stay claimable; nothing sent");
      return { addresses: { frontDoor: a.frontDoor } };
    },
    actions: V32_ACTIONS,
  };
}
