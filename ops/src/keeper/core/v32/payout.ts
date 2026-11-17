import { type Address, encodeAbiParameters, formatEther, type Hex, parseAbiParameters } from "viem";
import type { Payout } from "../payouts.ts";
import { BITTENSOR_BLOCK_GAS_LIMIT, underCeiling } from "../ceiling.ts";
import { CLAIM_GAS_REQUIRED_MAX, claimGasLimit } from "../rewards.ts";

export { BITTENSOR_BLOCK_GAS_LIMIT };

// v3.2's payout, as the keeper plans it before it sends (spec §3.3, the fee valve and the leaver pays): the chunk the
// vault will take (CascadePayoutMath.takeChunk), the fee split (feeSplit, deductFee), the caller's top-up, and whether
// the liquid TAO and the stake, at face value, cover what the chunk sends. Each is the contract's rule, restated so
// the keeper waits with a reason instead of sending what would revert; the simulation still decides.

/** 1 rao in wei; the vault's ED_RESERVE (1e12 wei) and SHORTFALL_TOLERANCE_RAO (1,000 rao) in wei. */
export const RAO = 10n ** 9n;
export const ED_RESERVE = 10n ** 12n;
export const SHORTFALL_TOLERANCE_WEI = 1_000n * RAO;
/** CascadeMessages.MAX_ENTRIES: the most entries in a PAYOUTS chunk, and in each list of a BATCH (50 since Task 18). */
export const MAX_ENTRIES = 50;
/** CascadeConstants.EXIT_GAS_RESERVE: what the walk leaves for the exit's work after it (Task 20; 2,000,000 since Task 65:
 * the fork measured that work at about 549,000 to 648,000, and a removal that burns its gas leaves the exit only the
 * reserve). The keeper's payout gas rule sends at least this above the estimate, so it must be the deployed vault's own:
 * the for-life list reads it (deployment-v32.ts FOR_LIFE) and stops the keeper if it differs, and pnpm ops verify checks
 * it. */
export const EXIT_GAS_RESERVE = 2_000_000n;
/** CascadeConstants.MAX_HOTKEYS and CascadeVault's MAX_UNSTAKE_GAS (Task 41a's Minor 6): the most positions the walk tries
 * and the most gas each removal is forwarded at least, so a payout's gas above its estimate is at most EXIT_GAS_RESERVE +
 * 4 × 5,000,000 = 22,000,000. */
export const MAX_HOTKEYS = 4;
export const MAX_UNSTAKE_GAS = 5_000_000n;
/** The most gas a keeper transaction carries (Task 41a's Minor 6): a claim's highest (claimGasLimit at the vault's
 * MAX_CLAIM_GAS, held to Bittensor's per-transaction ceiling, 64,900,000: ceiling.ts), which is the Worker's own proof
 * bound (keeper/src/proof.ts MAX_PROOF_GAS: a row whose raw carries more is never adopted again). A payout's gas (its
 * estimate plus EXIT_GAS_RESERVE and its positions' unstake gas) and a parked delivery's are held to it. */
export const MAX_KEEPER_GAS = underCeiling(claimGasLimit(CLAIM_GAS_REQUIRED_MAX));

const sub0 = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const tao = (wei: bigint) => `${formatEther(wei)} TAO`;

export interface Entry {
  user: Address;
  amount: bigint;
}

/** The keeper's chunk limit (CascadePayoutLib.prepare): its maxEntries raised to minChunk and capped at MAX_ENTRIES. */
export const keeperLimit = (maxEntries: number, minChunk: number): number => Math.min(Math.max(maxEntries, minChunk), MAX_ENTRIES);

/** CascadePayoutMath.takeChunk: from `start`, the next entry always (even above `cap`), then entries in order while
 * fewer than `limit` are taken and the sum stays within `cap`; a tail of fewer than `minChunk` that would be left
 * behind is taken too when the whole still fits within `cap` and MAX_ENTRIES. The entries at their gross value. */
export function takeChunk(payouts: readonly Payout[], start: number, limit: number, cap: bigint, minChunk: number): { entries: Entry[]; sum: bigint } {
  const n = payouts.length;
  const end = Math.min(start + limit, n);
  let sum = 0n;
  let i = start;
  do {
    sum += payouts[i].assets;
    i++;
  } while (i < end && sum + payouts[i].assets <= cap);
  if (i < n && n - i < minChunk && n - start <= MAX_ENTRIES) {
    let total = sum;
    for (let j = i; j < n; j++) total += payouts[j].assets;
    if (total <= cap) {
      sum = total;
      i = n;
    }
  }
  return { entries: payouts.slice(start, i).map((p) => ({ user: p.user, amount: p.assets })), sum };
}

/** CascadeMessages.encodePayouts: abi.encode(PAYOUTS = 2, batchKey, chunk, entries), the gross message the vault quotes
 * the bridge fee on. */
export const encodePayouts = (key: Hex, chunk: number, entries: readonly Entry[]): Hex =>
  encodeAbiParameters(parseAbiParameters("uint8, bytes32, uint32, (address user, uint256 amount)[]"), [2, key, chunk, entries]);

/** CascadePayoutMath.feeSplit: the fee, the bridge's quote rounded up to whole rao, and what the entries are charged,
 * at most the ceiling (the larger of maxFeeBps of the chunk's sum and maxFeeAbs), floored to rao. */
export function feeSplit(quote: bigint, sum: bigint, maxFeeBps: bigint, maxFeeAbs: bigint): { fee: bigint; charged: bigint; ceiling: bigint } {
  const fee = ceilDiv(quote, RAO) * RAO;
  const ceiling = max((sum * maxFeeBps) / 10_000n, maxFeeAbs);
  const c = min(fee, ceiling);
  return { fee, charged: c - (c % RAO), ceiling };
}

/** CascadePayoutMath.deductFee over the `taken` entries from `start`: each pays ceil(assets × charged / sum) and is
 * floored to rao; a bounce left with 0 is dust; an entry with shares left with 0 makes the chunk revert FeeTooHigh
 * (`zeroed`, its index). */
export function deductFee(payouts: readonly Payout[], start: number, taken: number, charged: bigint, sum: bigint): { net: bigint; dust: number; zeroed?: number } {
  let net = 0n;
  let dust = 0;
  for (let i = start; i < start + taken; i++) {
    const { shares, assets } = payouts[i];
    const fee = ceilDiv(assets * charged, sum);
    let a = sub0(assets, fee);
    a -= a % RAO;
    if (a === 0n) {
      if (shares !== 0n) return { net, dust, zeroed: i };
      dust++;
      continue;
    }
    net += a;
  }
  return { net, dust };
}

/** What a payout plan reads (all through the vault's lens but the balance): the batch, the queue's total, the vault's
 * TAO, its fee and message limits, the stake on its listed hotkeys, how many are listed, and each removal's gas. */
export interface PayoutInputs {
  batch: { sourceChain: bigint; frontDoor: Address; cursor: number; count: number; chunk: number; remaining: bigint; payoutsHash: Hex; queuedAt: bigint };
  pendingPayouts: bigint;
  balance: bigint;
  maxFeeBps: bigint;
  maxFeeAbs: bigint;
  minChunk: number;
  maxMessageValue: bigint;
  visibleStakeRao: bigint;
  hotkeyCount: number;
  unstakeGas: bigint;
}

/** The plan: send, with the top-up and the gas above the estimate (EXIT_GAS_RESERVE + listed positions × unstakeGas,
 * Task 20), or wait, and why. `walk` is what the chunk would unstake (0: the liquid TAO covers it). */
export type PayoutPlan =
  | { go: true; entries: Entry[]; sum: bigint; fee: bigint; charged: bigint; topUp: bigint; net: bigint; walk: bigint; gasAbove: bigint }
  | { go: false; why: "top-up" | "fee-too-high" | "unstake-short"; reason: string; walk: bigint; topUp: bigint };

/** The chunk the vault takes next for the keeper, and its gross message (what the bridge fee is quoted on). */
export function chunkOf(key: Hex, list: readonly Payout[], i: Pick<PayoutInputs, "batch" | "minChunk" | "maxMessageValue">): { entries: Entry[]; sum: bigint; message: Hex } {
  const c = takeChunk(list, i.batch.cursor, keeperLimit(MAX_ENTRIES, i.minChunk), i.maxMessageValue, i.minChunk);
  return { ...c, message: encodePayouts(key, i.batch.chunk, c.entries) };
}

/** The keeper's payout plan for batch `key`'s next chunk, from its full list, the reads, the bridge's quote for the
 * chunk, and the operator's top-up limit (OPS_PAYOUT_TOPUP_MAX, whole rao; 0 by default):
 * - the fee above what the entries pay (topUp = fee - charged, whole rao) goes only within the limit; above it the
 *   payout waits (the vault would refuse FeeTooHigh), for the fee to fall;
 * - an entry with shares the split would leave nothing waits (FeeTooHigh; unreachable under the bounds, B11);
 * - the leaver pays (spec §3.3): what is sent, net + charged, comes from the liquid TAO beyond ED_RESERVE and the
 *   other batches' reservations (the caller's value never counts), then from a walk of the listed stake, which the
 *   vault asks 1,000 rao more of, counts at face value and lets leave at most those 1,000 rao unmet; stake that can't
 *   cover the walk at face value within that tolerance waits (UnstakeShort). A walk's own cost (a removal fee: none today) falls on the chunk's entries and can still refuse
 *   it FeeTooHigh, which only the simulation can tell; it then waits for liquid TAO to cover it without a walk. */
export function planPayout(list: readonly Payout[], i: PayoutInputs, quote: bigint, topUpMax: bigint): PayoutPlan {
  const { entries, sum } = takeChunk(list, i.batch.cursor, keeperLimit(MAX_ENTRIES, i.minChunk), i.maxMessageValue, i.minChunk);
  const split = feeSplit(quote, sum, i.maxFeeBps, i.maxFeeAbs);
  const { fee, charged } = split;
  const d = deductFee(list, i.batch.cursor, entries.length, charged, sum);
  // the caller's value must cover it even when every entry is dust (the vault checks it before it zeroes the fee, and
  // then refunds the whole value)
  const topUp = fee - charged;
  if (topUp > topUpMax) {
    return {
      go: false,
      why: "top-up",
      walk: 0n,
      topUp,
      reason: `its bridge fee, ${tao(fee)}, is above what its ${entries.length} entr${entries.length === 1 ? "y pays" : "ies pay"} (at most ${tao(split.ceiling)}), and the keeper adds at most ${tao(topUpMax)} (OPS_PAYOUT_TOPUP_MAX), until the fee falls`,
    };
  }
  if (d.zeroed !== undefined) {
    return { go: false, why: "fee-too-high", walk: 0n, topUp, reason: `its fee share would leave entry ${d.zeroed} (${list[d.zeroed].user}) nothing (FeeTooHigh)` };
  }
  const free = sub0(sub0(i.balance, ED_RESERVE), sub0(i.pendingPayouts, i.batch.remaining));
  // nothing sent (every entry dust): no fee, nothing to fund
  const need = d.net === 0n ? 0n : d.net + charged;
  const walk = free < need ? need - free + SHORTFALL_TOLERANCE_WEI : 0n;
  const stake = i.visibleStakeRao * RAO;
  // the vault refuses only when more than the tolerance of the walk is left unmet (CascadeVault _unstake): so it pays
  // whenever the stake at face value covers need - free
  if (walk > 0n && stake + SHORTFALL_TOLERANCE_WEI < walk) {
    return {
      go: false,
      why: "unstake-short",
      walk,
      topUp,
      reason: `it sends ${tao(need)}, and the vault's free TAO (${tao(free)}) and its listed stake at face value (${tao(stake)}) can't cover the ${tao(walk)} its walk would take (UnstakeShort), until a deposit, a stake or a reward (the buffer rule: an idleBufferBps that keeps the payouts liquid)`,
    };
  }
  return { go: true, entries, sum, fee: d.net === 0n ? 0n : fee, charged: d.net === 0n ? 0n : charged, topUp, net: d.net, walk, gasAbove: EXIT_GAS_RESERVE + BigInt(i.hotkeyCount) * i.unstakeGas };
}
