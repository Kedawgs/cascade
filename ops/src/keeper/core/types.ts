import type { Abi, Address, Hex } from "viem";

// The keeper core's own types (design-keeper-worker.md §1): what a send asks for and what comes back. ops/src keeps
// re-exporting them from their old homes (config.ts, types.ts, send.ts), so every caller reads the same type.

export type ChainName = "base" | "bittensor";

/** A contract call: sent with `cast send` by the PC's v3-launch path, signed raw by the core's send path otherwise. */
export interface CallRequest {
  chain: ChainName;
  nonce: number;
  label: string;
  to: Address;
  abi: Abi;
  functionName: string;
  args: unknown[];
  value?: bigint;
  /** v3.2 (R12a): what of `value` the call is expected to keep, when that is less than all of it: a close's quoted bridge
   * fee less its batch's pot (the door spends the pot first: R12d, L-2), its float's rest sent back by the front door
   * (BatchClosed). An expectation, not a bound: a fee risen since the quote keeps more, up to the whole value. The spend
   * cap's check of the send counts its gas at its worst and this (its whole value when unset: a payout's top-up, a park
   * refund's fee are kept whole); its row, once mined, counts what it kept as the receipt says (journal.ts spentOf). Only
   * the core's raw send path reads it. */
  valueKept?: bigint;
  /** Send with exactly this gas limit (refused if the estimate is above it), instead of 1.25× the estimate. */
  gasLimit?: bigint;
  /** At least this much gas above the estimate, where 1.25× the estimate gives less: a call that catches an inner call's
   * failure (a capped precompile read, an OffRamp's receiver) can succeed on less gas by that inner call failing, so an
   * estimator that bisects for the least gas that succeeds (Bittensor's) under-gasses it. Only the core's raw send path
   * reads it. */
  gasFloor?: bigint;
  /** Send with the estimate plus this much gas instead (v3.2's payout gas rule, Task 20: EXIT_GAS_RESERVE, 2,000,000 since
   * Task 65, plus the listed positions × unstakeGas). Only the core's raw send path (core/send.ts) reads it; v3-launch
   * never sets it. */
  gasAbove?: bigint;
  /** The most gas it may go out with (R4, Task 41a's Minor 6: a payout's estimate plus gasAbove held to the keeper's
   * bound): the gas limit is at most this, and an estimate above it is refused. Only the core's raw send path reads it. */
  gasMax?: bigint;
  /** The whole of gasAbove is needed (R4-O's fix round, Minor 2: a parked delivery's floor, which the vault's call needs at
   * the adapter): an estimate plus gasAbove above gasMax is refused, never cut to gasMax (a cut floor starves the vault's
   * call into a re-park the adapter reports as a success). Only the core's raw send path reads it. */
  gasAboveWhole?: true;
  /** v3.2's rails (Task 50a): set only on the conversion of a token park during a ForeverMoney migration notice
   * (v32/requests.ts convertParkRequest), the one send a hold or an outage lets through while the notice runs. */
  rail?: "migration-conversion";
  /** v3.2 (T51 re-review R1): never sent again at a higher fee. When its watch says it must be replaced, it is cancelled
   * (a transfer of nothing to the keeper at its nonce). Set on a claim: never urgent, and its worst case is most of a
   * chain's spend cap, so a bump could take the chain to its cap and strand it there. */
  replaceBy?: "cancel";
  /** v3.2 (T51 re-review m1): the fee cap (wei a gas) this send's room was checked at: the raw send path refuses it ("fee")
   * when the price now would sign it higher, so the room checked is the room used. Set on a claim. */
  maxFeeCap?: bigint;
  /** v3.2 (R9, L-2): a claim's hotkey's lastClaimAt as the vault read it just before the send (Bittensor's seconds). A
   * claim whose receipt comes late and reverted compares the hotkey's lastClaimAt read after it with this, one chain's
   * clock against itself: moved past it, another caller's claim went first (a wait, never a hold). Only the late path
   * reads it (round.ts revertedLate); set on a claim. */
  claimLast?: number;
}

export interface Sent {
  hash: Hex;
  block: number;
  gasUsed: bigint;
  costWei: bigint;
  address?: Address;
  logs?: { address: Address; topics: Hex[]; data: Hex }[];
}

/** What replaceCall did: the pending transaction replaced (the same call again, or a cancel in its place)
 * with the replacement's receipt, or nothing (why). */
export type Replacement = { replaced: false; reason: string } | ({ replaced: true; cancelled: boolean } & Sent);
