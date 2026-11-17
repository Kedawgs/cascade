import { formatEther, type Hex } from "viem";
import type { KeeperDeps, KeeperState, Rewards } from "../actions.ts";
import type { DueClaim } from "../due.ts";
import type { KeeperMemory } from "../memory.ts";
import { adoptionDue, beingFreed, claimCeilingProblem, type ClaimPolicy, type ClaimsRead, claimFor, claimGasLimit } from "../rewards.ts";
import { LATE_RECEIPT_MS } from "../round.ts";
import { missingChanged, watchHotkeys } from "./hotkeys.ts";
import type { KeeperDepsV32 } from "./reads.ts";

// v3.2's claims and adoption for the round (plan Task 51; spec §3.1, §3.8, §3.10.2): every listed hotkey's rewards read
// from the claim source (abi.ts CLAIM_SOURCE) and claimed by one claim round (R6b, U1 and U2: rewards.ts claimFor): every
// hotkey with credits waiting goes together, 2 days before the claim schedule ends or sooner, the standby among them once
// it is listed, whatever its own claim costs; a hotkey with none of the vault's stake claimed until its credits read 0 (preflight A17); the vault's
// surplus adopted at most once per STAKE_RAMP, by the chain's lastAdoptAt. The round reads them only once nothing else is
// due, so they come last (payouts, then stake or unstake, then claims), and they wait while a Bittensor send of the
// keeper's is still unsettled (the round's memory watches it, and the journal, written ahead of every broadcast, keeps it
// across a run cut off before its memory was saved), so a claim never takes the nonce of, nor comes before, the round's
// payout or stake. They are sends like any other: the rails (a hold stops them), the spend cap, readiness and the one send
// path apply. A claim goes only while Bittensor's 24 h cap fits a claim at all (one claim's worst case at the fee cap now
// plus a day of payouts and stakes: the founder's sizing, 2026-11-08), the wallet holds its up-front fee, and the cap has
// room for its worst case now, so a claim is never what stops the payouts. A claim the chain reverts with nothing to
// explain it, at its send or in a receipt that came late (R8, M-A), holds that one hotkey's claims for a day, doubling
// with each repeat (up to CLAIM_HOLD_MAX_MS), never the keeper. Only time ends a hold, or a claim on that hotkey that
// paid (its last claim moved past the hold: R8, L-B; credits falling is no sign of one, an unstake may lower them), or
// the vault's claimGasRequired changing (the owner fixed the likeliest cause: R8, L-A); never credits rising, which root
// credits do every epoch (R7, M1).

/** A hotkey's claim the chain reverted with nothing to explain it (holdClaim): held until when (ms, the round's clock),
 * the credits read after the revert (wei; kept for the record, no longer what ends it), the transaction, how many in a row
 * (`strikes`, 1 for the first), when (ms), the vault's claimGasRequired it was held at (`gas`), and the hotkey's last
 * claim as the vault read then (`last`, Bittensor's seconds). Kept once the hold has run out, so a repeat holds longer,
 * until a claim pays (its last claim moves past `last`, or, for a hold kept without one, past `at`), claimGasRequired
 * moves off `gas`, or the hotkey is no longer listed. */
interface ClaimHold {
  until: number;
  credits?: bigint;
  hash: Hex;
  strikes?: number;
  at?: number;
  gas?: bigint;
  last?: number;
}

interface RewardsMemory {
  /** What was last said, by hotkey's claim, the adoption, and the wait */
  said?: Record<string, string>;
  /** The last reading found a claim or the adoption that could go: read again each quiet round until done */
  goable?: boolean;
  /** Hotkeys whose last claim reverted on chain with nothing to explain it (by lowercase hotkey) */
  refused?: Record<string, ClaimHold>;
}

const v32 = (deps: KeeperDeps): KeeperDepsV32 => {
  if (!("readClaims" in deps) || !("railsSeen" in deps)) throw new Error("v3.2's claims need the v3.2 deps (v32/reads.ts depsV32); nothing sent");
  return deps as KeeperDepsV32;
};
const tao = (wei: bigint) => `${formatEther(wei)} TAO`;
const gwei = (wei: bigint) => `${Number(wei) / 1e9} gwei`;
const at = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** How long a claim nothing explains holds its hotkey's claims (the controller's ruling, Task 51 fix round 1): a day, the
 * first time. */
export const CLAIM_HOLD_MS = 24 * 3_600_000;
/** R7 (M1): each repeat on the same hotkey, with no claim paying between, doubles its hold, to at most 16 days (a claim
 * costs up to the spend cap's day, so a claim that can never land costs a try every 16 days at most, not daily). */
export const CLAIM_HOLD_MAX_MS = 16 * CLAIM_HOLD_MS;

/** A day of Bittensor's other sends, in gas, the margin the cap must keep beside a claim (the founder's sizing,
 * 2026-11-08: one claim's worst case up front plus a day of payouts and stakes): four payout chunks at their gas rule's
 * limit with two listed hotkeys (about 3.6M each since Task 65: their own work, about 0.8M on the fork, EXIT_GAS_RESERVE's
 * 2.0M and 2 × 400,000 unstakeGas) and four stakes (about 0.25M each). At 5 gwei, a 57M claim and this fit the 0.4 TAO
 * default (deployment-v32.ts SPEND_CAP_DEFAULT; the controller's ruling, Task 51 fix round 2): up to about 5.5 gwei. A
 * claim at the vault's top (claimGasRequired 63.4M, a 64.9M limit) needs about 0.402 TAO at 5 gwei: raise the cap with it
 * (runbook). */
export const DAY_OF_SENDS_GAS = 15_500_000n;

/** Why Bittensor's 24 h spend cap can't fit a claim at all, or undefined: no transaction can carry a claim at the vault's
 * claimGasRequired (rewards.ts claimCeilingProblem: Bittensor's per-transaction ceiling, Task 65); else it must hold one
 * claim's worst case at the fee cap now (its fixed gas limit, claimGasRequired plus the margin held to the ceiling, at
 * `feeCapWei`) plus a day of payouts and stakes (DAY_OF_SENDS_GAS at the same fee), else the setting to raise and to
 * what. */
export function claimFitProblem(cap: bigint, claimGasRequired: bigint, feeCapWei: bigint): string | undefined {
  const ceiling = claimCeilingProblem(claimGasRequired);
  if (ceiling) return ceiling;
  const limit = claimGasLimit(claimGasRequired);
  const claim = limit * feeCapWei;
  const day = DAY_OF_SENDS_GAS * feeCapWei;
  if (cap >= claim + day) return undefined;
  return `Bittensor's 24 h spend cap (${tao(cap)}) can't fit a claim: one claim's worst case at the fee cap now (a ${limit.toLocaleString("en-US")} gas limit at ${gwei(feeCapWei)}: ${tao(claim)}) and a day of payouts and stakes (${DAY_OF_SENDS_GAS.toLocaleString("en-US")} gas: ${tao(day)}) need ${tao(claim + day)}; raise OPS_KEEPER_SPEND_CAP_BITTENSOR to at least ${tao(claim + day)}`;
}

/** Why a claim that is due can't go now, or undefined: Bittensor's cap can't fit a claim at all (claimFitProblem); the
 * keeper's wallet short of the up-front fee (Bittensor takes the whole gas limit's fee first, then refunds what is
 * unused); or no room under the cap now for that worst case, the sum reaching it (the cap reads at or over): sent anyway,
 * it would stop the payouts and the stake for up to a day. */
export async function claimRoom(deps: KeeperDepsV32, r: Pick<ClaimsRead, "claimGasRequired" | "feeCapWei" | "walletWei">): Promise<string | undefined> {
  const cap = deps.deployment.spendCap.bittensor;
  const fit = claimFitProblem(cap, r.claimGasRequired, r.feeCapWei);
  if (fit) return fit;
  const limit = claimGasLimit(r.claimGasRequired);
  const need = limit * r.feeCapWei;
  const gas = limit.toLocaleString("en-US");
  if (r.walletWei < need) return `a claim is sent with a ${gas} gas limit, so the wallet needs ${tao(need)} up front (unused gas is refunded): top it up on Bittensor`;
  if ((await deps.spent("bittensor")) + need >= cap) {
    return `its worst case, ${tao(need)} (a ${gas} gas limit at the fee cap now), would take Bittensor's 24 h spend over the keeper's ${tao(cap)} cap, which would stop the payouts: it waits until the cap has room for it (OPS_KEEPER_SPEND_CAP_BITTENSOR)`;
  }
  return undefined;
}

/** Readiness's word on the claims (the controller's ruling: at readiness and before each claim): why the cap can't fit a
 * claim now, read live (claimGasRequired, the fee cap), or undefined. */
export async function claimFitNow(deps: KeeperDepsV32): Promise<string | undefined> {
  const { claimGasRequired, feeCapWei } = await deps.claimGas();
  return claimFitProblem(deps.deployment.spendCap.bittensor, claimGasRequired, feeCapWei);
}

/** Holds `hotkey`'s claims after one that reverted on chain with nothing to explain it (claimV32, or its late receipt:
 * round.ts revertedLate), at `now` (ms): CLAIM_HOLD_MS for the first, doubling for each repeat since a claim last paid, at
 * most CLAIM_HOLD_MAX_MS (R7, M1). Its end (rewardsV32): the time, a claim on the hotkey that paid since (its lastClaimAt
 * past `last`, the one read with the hold: one chain's clock against itself; unset, past `now`), or the vault's
 * claimGasRequired moving off `gas` (the setting read with it; unset: only the first two). What it holds: until when, how
 * long, and how many in a row. */
export function holdClaim(memory: KeeperMemory, hotkey: Hex, h: { now: number; credits?: bigint; hash: Hex; gas?: bigint; last?: number }): { until: number; ms: number; strikes: number } {
  const mem = (memory.reads.rewards ??= {}) as RewardsMemory;
  const k = hotkey.toLowerCase();
  const strikes = (mem.refused?.[k]?.strikes ?? (mem.refused?.[k] ? 1 : 0)) + 1;
  const ms = Math.min(CLAIM_HOLD_MS * 2 ** (strikes - 1), CLAIM_HOLD_MAX_MS);
  (mem.refused ??= {})[k] = {
    until: h.now + ms,
    ...(h.credits !== undefined ? { credits: h.credits } : {}),
    hash: h.hash,
    strikes,
    at: h.now,
    ...(h.gas !== undefined ? { gas: h.gas } : {}),
    ...(h.last !== undefined ? { last: h.last } : {}),
  };
  return { until: h.now + ms, ms, strikes };
}

/** A hold's length in words: "24 hours" for the first, then "2 days", "4 days" … "16 days". */
export const holdWords = (ms: number): string => (ms <= CLAIM_HOLD_MS ? "24 hours" : `${Math.round(ms / CLAIM_HOLD_MS)} days`);

/** What ends a claim's hold early, in words (R8, L-A, L-B): the founder's claim by hand ignores it, and a claim that pays
 * ends it, as a change of the vault's claimGasRequired does. */
export const HOLD_ENDS = "or until a claim on it pays (pnpm ops claim <hotkey> --live --send ignores the hold) or the vault's claimGasRequired changes";

/** The words of a claim held after an unexplained revert (holdClaim's `held`), on `named` (hotkey 0x…), by transaction
 * `hash`: the first, or a repeat said loudly (CLAIM REVERTED AGAIN). claimV32's HeldRefusal and a late receipt's HELD line
 * (round.ts revertedLate) say the same. */
export function heldWords(named: string, hash: Hex, held: { until: number; ms: number; strikes: number }): string {
  const until = new Date(held.until).toISOString().slice(0, 16).replace("T", " ");
  return held.strikes > 1
    ? `CLAIM REVERTED AGAIN: the claim reverted on chain with no reason ${held.strikes} times in a row, and nothing read since explains it (transaction ${hash}): claims on ${named} wait ${holdWords(held.ms)}, until ${until} UTC (each repeat doubles the wait, up to ${holdWords(CLAIM_HOLD_MAX_MS)}), ${HOLD_ENDS}; check the hotkey and the vault's claimGasRequired (runbook section 5, claim); the keeper's other work goes on`
    : `the claim reverted on chain with no reason, and nothing read since explains it (transaction ${hash}): claims on ${named} wait 24 hours, until ${until} UTC, ${HOLD_ENDS}; a repeat doubles the wait; the keeper's other work goes on`;
}

/** A Bittensor send of the keeper's still unsettled, or undefined: one the round's memory watches (a send with no receipt
 * yet), else one the journal holds unsettled (signed or sent: a run cut off before its memory was saved leaves it there),
 * written within LATE_RECEIPT_MS (`now`, the round's clock), as long as the round's watch would follow it. */
export async function unsettledOnBittensor(deps: KeeperDepsV32, memory: KeeperMemory, now: number): Promise<string | undefined> {
  const watched = memory.unreceipted.find((u) => u.chain === "bittensor");
  if (watched) return `${watched.what} (transaction ${watched.hashes.at(-1)}) is still unsettled on Bittensor`;
  const row = (await deps.journal.pending()).find((j) => j.chain === "bittensor" && now - j.at < LATE_RECEIPT_MS);
  if (row) return `${row.request.label} (transaction ${row.hashes.at(-1)}) is still unsettled on Bittensor (the keeper's journal)`;
  return undefined;
}

/** The round's claims and adoption (core/actions.ts KeeperActions.rewards), read when the round asks, which is once
 * nothing else is due: on the first round, every `every` rounds, and each round while the last reading found one that
 * could go. Hotkeys with none of the vault's stake come first, then the rest in the vault's order; a hotkey held after an
 * unexplained revert waits out its hold, or until a claim on it pays or the vault's claimGasRequired changes. Each
 * decision is said once when it changes: each hotkey's claim, the adoption while there is a surplus, and CLAIMS WAIT
 * while a due one waits for the keeper's unsettled Bittensor send. */
export async function rewardsV32(depsIn: KeeperDeps, memory: KeeperMemory, o: { policy: ClaimPolicy; now: number; every: number; state?: KeeperState }): Promise<Rewards | undefined> {
  const deps = v32(depsIn);
  const mem = (memory.reads.rewards ??= {}) as RewardsMemory;
  const said = (mem.said ??= {});
  // the hotkey watch (Task 53) reads at once when the vault's stake went missing or came back since its last reading
  const changed = missingChanged(memory, o.state?.vault.stakeMissing);
  if (!(memory.tick === 1 || memory.tick % o.every === 0 || mem.goable || changed)) return undefined;
  const tell = (key: string, text: string | undefined) => {
    if (said[key] === text) return;
    if (text === undefined) delete said[key];
    else {
      said[key] = text;
      deps.log(text);
    }
  };

  const r = await deps.readClaims();
  const room = await claimRoom(deps, r);
  const claims: DueClaim[] = [];
  const order = [...r.hotkeys.filter(beingFreed), ...r.hotkeys.filter((h) => !beingFreed(h))];
  const refused = (mem.refused ??= {});
  for (const h of order) {
    const k = h.hotkey.toLowerCase();
    const named = `hotkey ${h.hotkey.slice(0, 10)}…`;
    // a hold after an unexplained revert ends after its time, or early once a claim on the hotkey has paid since it (its
    // last claim, the vault's stamp of a claim that went through, after the hold began: another caller's, or the founder's
    // by hand; R8, L-B), or once the vault's claimGasRequired is no longer the one it was held at (the owner changed the
    // likeliest cause: R8, L-A). Never on credits alone: rising, root credits do every epoch (R7, M1); falling, an unstake
    // may lower them. Either early end forgets its repeats; one only run out keeps them, so the next unexplained revert
    // holds twice as long.
    const held = refused[k];
    const paid = held?.last !== undefined ? h.lastClaimAt > held.last : held?.at !== undefined && h.lastClaimAt * 1000 > held.at;
    const regassed = held?.gas !== undefined && r.claimGasRequired !== held.gas;
    if (held && (paid || regassed)) {
      delete refused[k];
      if (!paid && o.now < held.until) deps.log(`Claims on ${named} go again: the vault's claimGasRequired is ${r.claimGasRequired.toLocaleString("en-US")} now, not the ${(held.gas as bigint).toLocaleString("en-US")} its claim reverted at, so its hold ends (a repeat holds a day again)`);
    }
    const active = refused[k] && o.now < refused[k].until ? refused[k] : undefined;
    const row = active && (active.strikes ?? 1) > 1 ? ` (${active.strikes} in a row)` : "";
    const hold = active ? `its last claim reverted on chain with nothing to explain it${row} (transaction ${active.hash}): it is tried again at ${at(active.until)}, or once a claim on it pays or the vault's claimGasRequired changes` : undefined;
    const c = claimFor(h, r, o.policy);
    const waits = hold ?? room;
    tell(`claim:${k}`, `Rewards on ${named}: ${c.claim ? `a claim is due (${c.reason})${waits ? `, but it waits: ${waits}` : ""}` : `no claim due (${c.reason})`}`);
    if (c.claim && !waits) claims.push({ hotkey: h.hotkey, reason: `${named}'s rewards are due their claim (${c.reason})` });
  }
  // a hotkey no longer listed is no longer said, nor held
  const keys = new Set(order.map((h) => h.hotkey.toLowerCase()));
  for (const k of Object.keys(said)) if (k.startsWith("claim:") && !keys.has(k.slice("claim:".length))) delete said[k];
  for (const k of Object.keys(refused)) if (!keys.has(k)) delete refused[k];

  const a = adoptionDue(await deps.readAdoption());
  tell("adopt", a.surplus ? `Adoption: ${a.adopt ? "due" : "not yet"} (${a.reason})` : undefined);

  // the hotkey watch and the buffer rule (Task 53, hotkeys.ts): stake missing, unlisted stake, a swap's old hotkey's slot,
  // the root hold
  const watch = watchHotkeys(deps, memory, r, await deps.readWatch(), o.now);

  const wait = await unsettledOnBittensor(deps, memory, o.now);
  const due = claims.length > 0 || a.adopt || watch.frees.length > 0;
  tell("wait", wait && due ? `CLAIMS WAIT: ${wait}: claims and the adoption come after the round's payouts and stake, so they wait until it settles` : undefined);
  mem.goable = due && (await deps.spent("bittensor")) < deps.deployment.spendCap.bittensor;
  return {
    claims,
    ...(a.adopt ? { adopt: { reason: a.reason } } : {}),
    ...(wait ? { rewardsWait: wait } : {}),
    ...(watch.frees.length ? { frees: watch.frees } : {}),
    ...(watch.rootHold !== undefined ? { rootHold: watch.rootHold } : {}),
  };
}
