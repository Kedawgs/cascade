// Bittensor's gas limits, as the keeper sends by them (Task 65; the contract review of 898bd83, I-1 and I-2).
//
// Bittensor's block holds 75,000,000 gas (runtime BLOCK_GAS_LIMIT), but no single transaction may carry that much. A
// transaction's weight is its gas LIMIT at 40,000 ref time a gas, and the normal class's max_extrinsic (75% of the
// block's 4e12, less the 10% kept for block initialization and the base extrinsic weight) is about 2.6e12: the pool
// refuses a gas limit above about 64,998,400 with ExhaustsResources (subtensor runtime/src/lib.rs:290-314 and
// :1276-1293, frame/system limits.rs, frontier's ethereum pallet; read live on 2026-11-15, spec 490, by a read-only
// validate_transaction call: 64,998,400 passed the weight check, 64,998,600 did not). Every keeper gas limit on
// Bittensor derives from the one ceiling below, so a lower reading changes it here alone.

/** Bittensor's block gas limit: the most gas a block's transactions carry together (no transaction gets near it). */
export const BITTENSOR_BLOCK_GAS_LIMIT = 75_000_000n;

/** The most gas any keeper transaction on Bittensor carries: under the pool's per-transaction limit (about 64,998,400),
 * with about 98,000 to spare for a runtime upgrade that moves the base weights. A claim's limit is held to it
 * (core/rewards.ts claimGasLimit), and so are the payout's and the parked delivery's bound (v32/payout.ts
 * MAX_KEEPER_GAS), the Worker's proof bound (keeper/src/proof.ts MAX_PROOF_GAS) and the one send path's last check
 * (core/send.ts). */
export const BITTENSOR_TX_GAS_CEILING = 64_900_000n;

/** `gas`, held to BITTENSOR_TX_GAS_CEILING. */
export const underCeiling = (gas: bigint): bigint => (gas > BITTENSOR_TX_GAS_CEILING ? BITTENSOR_TX_GAS_CEILING : gas);
