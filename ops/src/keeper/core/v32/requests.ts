import { type Address, encodeAbiParameters, formatEther, type Hex, keccak256 } from "viem";
import { KEEPER_CALLS_V32, OFFRAMP_EXECUTE, PARK_CALLS, PARK_JOBS } from "../abi.ts";
import type { Lane } from "./ccip.ts";
import { closeValue, type KeeperContracts, payoutsMatch } from "../actions.ts";
import { PayoutListMismatch } from "../failures.ts";
import type { Payout } from "../payouts.ts";
import type { ParkRef } from "../due.ts";
import type { CallRequest } from "../types.ts";
import { MAX_ENTRIES, MAX_KEEPER_GAS, RAO } from "./payout.ts";

// v3.2's keeper calls (spec §3.5, §3.3, §3.1): closeBatch by the id and the value the keeper read, the empty roll by id,
// stakeIdle, processPayouts with its top-up and its gas by the Task 20 rule, and (Task 51) claimRewards per listed hotkey
// and adoptStake.

export { closeValue };

/** The gas above the estimate a Bittensor call that reads the chain's minimums sends at least (Bittensor's estimator bisects
 * for the least gas that succeeds, and CascadeFormulas' minStakeRao and minRemainRao each catch a read capped at 100,000
 * gas, falling back to a constant: two capped reads and as much again, erring high as the founder ruled). */
export const MIN_READ_GAS_FLOOR = 400_000n;
/** removeHotkey's: its unclaimed-rewards read has no cap and its failure is caught, besides the minimums' reads. */
export const REMOVE_HOTKEY_GAS_FLOOR = 1_000_000n;
/** An OffRamp re-execution's, above its own estimate (which already holds the receiver's gas limit): the OffRamp catches the
 * receiver's failure and the token pool's, each behind an exact-gas check; erring high. */
export const REEXEC_GAS_FLOOR = 1_000_000n;

/** addHotkey(h) (Task 53): the keeper lists a hotkey (a swap's new one, the standby): privileged, at any time; the vault
 * refuses a listed one (HotkeyKnown), a full set (TooManyHotkeys) and the last slot unless stake is missing and `h` holds
 * the chain's minimum (SlotReserved). */
export const addHotkeyRequest = (rec: KeeperContracts, hotkey: Hex, nonce: number): CallRequest => ({
  chain: "bittensor",
  nonce,
  label: `list hotkey ${hotkey.slice(0, 10)}… on the vault`,
  to: rec.plan.addresses.vault,
  abi: KEEPER_CALLS_V32,
  functionName: "addHotkey",
  args: [hotkey],
  gasFloor: MIN_READ_GAS_FLOOR,
});

/** removeHotkey(h, false) (Task 53): the keeper's removal, of a listed hotkey that is not the stake hotkey and holds none
 * of the vault's stake (else NotAuthorized: only the owner moves stake off a hotkey), its unclaimed rewards within the
 * dust allowance (the keeper itself waits for 0); never a forfeit. */
export const removeHotkeyRequest = (rec: KeeperContracts, hotkey: Hex, nonce: number): CallRequest => ({
  chain: "bittensor",
  nonce,
  label: `free hotkey ${hotkey.slice(0, 10)}…'s slot (removeHotkey)`,
  to: rec.plan.addresses.vault,
  abi: KEEPER_CALLS_V32,
  functionName: "removeHotkey",
  args: [hotkey, false],
  gasFloor: REMOVE_HOTKEY_GAS_FLOOR,
});

/** What of its float a close is expected to keep (R12d, L-2): the bridge fee quoted less the batch's pot read with it,
 * never below 0, since the front door spends the pot first and sends the float's rest back. Not a bound: a fee that rose
 * since the quote, or a pot the owner swept meanwhile (sweepPot), keeps more, up to the whole float, and the mined row
 * counts what it kept (journal.ts spentOf). */
export const closeKeeps = (quote: bigint, feePot: bigint): bigint => (quote > feePot ? quote - feePot : 0n);

/** closeBatch(id, minValue) for the batch the keeper read: `id` its id, `minValue` the least total the close still goes
 * at, as closeV32 chooses it (0 at the max wait, R12c; the least total still full for a batch full by its limits, R12b and
 * R12d; the total less one minimum deposit for the fee rule's, R12g, or 0 when the pot covers the quote, R12h; the exact
 * total only where the read gives no floor; the notice's one close 0, R12b): a cancel that takes the batch under it
 * reverts BatchTooSmall instead of sending a smaller batch than the rule allows, `value` the fee float (closeValue: three
 * times the quote, at least 0.0015 ETH; the front door spends the batch's pot first and refunds what the fee leaves),
 * `kept` what of the float the close is expected to keep (closeKeeps: its quote less the pot; R12a, R12d L-2): the spend
 * cap's check counts that with its gas, not the whole float, as its mined row counts the float less the door's refund. */
export const closeRequest = (rec: KeeperContracts, id: bigint, minValue: bigint, value: bigint, nonce: number, kept?: bigint): CallRequest => ({
  chain: "base",
  nonce,
  label: `close batch ${id} and send it to Bittensor`,
  to: rec.plan.addresses.frontDoor,
  abi: KEEPER_CALLS_V32,
  functionName: "closeBatch",
  args: [id, minValue],
  value,
  ...(kept !== undefined ? { valueKept: kept } : {}),
});

/** closeBatch(id, 0) with no value on an empty batch: the front door restarts its timer (BatchRolled). */
export const rollRequest = (rec: KeeperContracts, id: bigint, nonce: number): CallRequest => ({
  chain: "base",
  nonce,
  label: `roll the empty open batch ${id} (restart its timer)`,
  to: rec.plan.addresses.frontDoor,
  abi: KEEPER_CALLS_V32,
  functionName: "closeBatch",
  args: [id, 0n],
});

export const stakeRequest = (rec: KeeperContracts, nonce: number): CallRequest => ({
  chain: "bittensor",
  nonce,
  label: "stake the vault's idle TAO",
  to: rec.plan.addresses.vault,
  abi: KEEPER_CALLS_V32,
  functionName: "stakeIdle",
  args: [],
  gasFloor: MIN_READ_GAS_FLOOR,
});

/** processPayouts(key, list, MAX_ENTRIES) with `topUp` as its value (whole rao: the vault refuses anything else,
 * BadValue) and the estimate plus `gasAbove` as its gas (EXIT_GAS_RESERVE + listed positions × unstakeGas, Task 20), at
 * most MAX_KEEPER_GAS (Task 41a's Minor 6: 22,000,000 above the estimate at the maximum, under the keeper's 64,900,000
 * bound, Bittensor's per-transaction ceiling: core/ceiling.ts), refused unless the list is the one the vault stored. The
 * value is the
 * top-up the quote asks, never more (spec §3.3: any value that covers the whole fee pays all of it), except `full`, the full
 * top-up (merge 7b): the whole fee, which the keeper sends only when the chain's floor refuses the chunk's net. */
export function payoutsRequest(rec: KeeperContracts, key: Hex, list: Payout[], stored: { payoutsHash: Hex; count: number }, nonce: number, topUp: bigint, gasAbove: bigint, full = false): CallRequest {
  if (!payoutsMatch(list, stored)) {
    throw new PayoutListMismatch(
      `the payout list rebuilt from the vault's events (${list.length} entries) does not match batch ${key.slice(0, 10)}… (${stored.count} entries); nothing sent`,
    );
  }
  if (topUp < 0n || topUp % RAO !== 0n) throw new Error(`a top-up of ${topUp} wei is not whole rao (the vault would refuse it: BadValue); nothing sent`);
  return {
    chain: "bittensor",
    nonce,
    label: `pay out batch ${key.slice(0, 10)}… to Base${full ? ` (the full top-up: the whole ${formatEther(topUp)} TAO bridge fee)` : topUp ? ` (topping the bridge fee up by ${formatEther(topUp)} TAO)` : ""}`,
    to: rec.plan.addresses.vault,
    abi: KEEPER_CALLS_V32,
    functionName: "processPayouts",
    args: [key, list, MAX_ENTRIES],
    ...(topUp ? { value: topUp } : {}),
    gasAbove,
    gasMax: MAX_KEEPER_GAS,
  };
}

/** claimRewards(hotkey) on the vault (Task 51): one listed hotkey's root rewards, with the fixed gas limit the claim
 * needs (core/rewards.ts claimGasLimit: claimGasRequired plus the margin, held to the per-transaction ceiling), which
 * Bittensor takes up front; never
 * fee-bumped (a stuck claim is cancelled: T51 re-review R1), and sent at no more than `maxFeeCap`, the fee cap its room
 * was checked at (m1). */
export const claimRequest = (rec: KeeperContracts, hotkey: Hex, gasLimit: bigint, nonce: number, maxFeeCap: bigint, lastClaimAt?: number): CallRequest => ({
  chain: "bittensor",
  nonce,
  label: `claim the vault's rewards on hotkey ${hotkey.slice(0, 10)}…`,
  to: rec.plan.addresses.vault,
  abi: KEEPER_CALLS_V32,
  functionName: "claimRewards",
  args: [hotkey],
  gasLimit,
  replaceBy: "cancel",
  maxFeeCap,
  // R9 (L-2): the hotkey's last claim as read before the send, for a late revert to tell another caller's claim first
  ...(lastClaimAt !== undefined ? { claimLast: lastClaimAt } : {}),
});

/** adoptStake() on the vault (Task 51): the surplus booked and vested. */
export const adoptRequest = (rec: KeeperContracts, nonce: number): CallRequest => ({
  chain: "bittensor",
  nonce,
  label: "adopt the vault's surplus stake",
  to: rec.plan.addresses.vault,
  abi: KEEPER_CALLS_V32,
  functionName: "adoptStake",
  args: [],
  gasFloor: MIN_READ_GAS_FLOOR,
});

/** The Bittensor adapter that holds `park` (R4, D-M2: a pair added after the deploy's), else the deploy's. */
export const parkAdapter = (rec: KeeperContracts, park: Pick<ParkRef, "adapter">): Address => park.adapter ?? rec.plan.addresses.bitAdapter;

/** deliverParked(recipient, sender, message) of a TOKEN park on its Bittensor adapter: it converts the park and delivers
 * it to the vault. Tagged as the migration conversion, the one send the rails let through a hold or an outage while
 * ForeverMoney's migration notice runs (the founder, 2026-11-08). Only a token park's conversion may carry the tag: Task
 * 52's job picks the parks (the registered door's, to the vault, unconverted) and sends them with this. Its gas is the
 * estimate plus `gasAbove`, the parked delivery's floor (R4, A-M1 and C-M1: parked.ts parkGasAbove), never 1.25 × the
 * estimate, which can starve the vault's call into a re-park the adapter reports as a success. Held to the keeper's bound
 * (MAX_KEEPER_GAS) whole: a limit the bound would cut below the floor is refused (R4-O's fix round, Minor 2). */
export const convertParkRequest = (rec: KeeperContracts, park: ParkRef, nonce: number, gasAbove: bigint): CallRequest => ({
  chain: "bittensor",
  nonce,
  label: `convert and deliver token park ${park.key.slice(0, 10)}… (ForeverMoney's migration notice)`,
  to: parkAdapter(rec, park),
  abi: PARK_CALLS,
  functionName: "deliverParked",
  args: [park.recipient, park.sender, park.message],
  rail: "migration-conversion",
  gasAbove,
  gasMax: MAX_KEEPER_GAS,
  gasAboveWhole: true,
});

/** deliverParked(recipient, sender, message) on the park's Bittensor adapter, untagged (Task 52's park job, when its
 * eth_call succeeds): a token park is converted and delivered, a native one delivered; the vault refusing it keeps it
 * parked. Never the migration conversion (convertParkRequest is), so the rails stop it under a hold like any other send.
 * Its gas is the estimate plus `gasAbove`, the parked delivery's floor, held to the keeper's bound whole (R4, as
 * convertParkRequest's). */
export const deliverParkedRequest = (rec: KeeperContracts, park: ParkRef, nonce: number, gasAbove: bigint): CallRequest => ({
  chain: "bittensor",
  nonce,
  label: `deliver park ${park.key.slice(0, 10)}… to the vault`,
  to: parkAdapter(rec, park),
  abi: PARK_CALLS,
  functionName: "deliverParked",
  args: [park.recipient, park.sender, park.message],
  gasAbove,
  gasMax: MAX_KEEPER_GAS,
  gasAboveWhole: true,
});

/** refundParked(recipient, sender, message) with `fee` (quoteRefund's) as its value, after PARK_TIMEOUT: the park goes back
 * to its door on Base, each depositor credited their deposit (spec §3.2, I-9). The fee is the keeper's; any excess stays in
 * the adapter. */
export const refundParkedRequest = (rec: KeeperContracts, park: ParkRef, fee: bigint, nonce: number): CallRequest => ({
  chain: "bittensor",
  nonce,
  label: `refund park ${park.key.slice(0, 10)}… to its door on Base (a ${formatEther(fee)} TAO bridge fee)`,
  to: parkAdapter(rec, park),
  abi: PARK_JOBS,
  functionName: "refundParked",
  args: [park.recipient, park.sender, park.message],
  value: fee,
});

/** dropParked(recipient, sender, message) of an empty park (a refused redeem-only batch) after PARK_TIMEOUT. */
export const dropParkedRequest = (rec: KeeperContracts, park: ParkRef, nonce: number): CallRequest => ({
  chain: "bittensor",
  nonce,
  label: `drop the empty park ${park.key.slice(0, 10)}…`,
  to: parkAdapter(rec, park),
  abi: PARK_JOBS,
  functionName: "dropParked",
  args: [park.recipient, park.sender, park.message],
});

/** OffRamp 2.0.0's execute(encodedMessage, ccvs, verifierResults, gasLimitOverride) on `lane`'s destination (Task 52): the
 * FAILURE `id`'s bytes as rebuilt and checked, the CCVs and their results (reexec.ts reexecProof), and the raised gas
 * limit for the receiver. */
export const reexecRequest = (lane: Lane, id: Hex, encoded: Hex, proof: { ccvs: Address[]; verifierResults: Hex[] }, gas: number, nonce: number): CallRequest => ({
  chain: lane.dest,
  nonce,
  label: `re-execute bridge message ${id.slice(0, 10)}… (${lane.direction}) on its OffRamp with a ${gas.toLocaleString("en-US")} gas limit`,
  to: lane.offRamp,
  abi: OFFRAMP_EXECUTE,
  functionName: "execute",
  args: [encoded, proof.ccvs, proof.verifierResults, gas],
  gasFloor: REEXEC_GAS_FLOOR,
});

/** A park's key on the Bittensor adapter, as its _parkKey makes it: keccak256(abi.encode(remoteChainId, sender,
 * recipient, message)). */
export const parkKeyOf = (remoteChainId: bigint, sender: Address, recipient: Address, message: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }, { type: "address" }, { type: "bytes" }], [remoteChainId, sender, recipient, message]));
