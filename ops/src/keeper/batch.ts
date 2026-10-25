import { type Address, encodeAbiParameters, type Hex, parseAbiParameters } from "viem";

export interface Entry {
  user: Address;
  amount: bigint;
}

/** CascadeMessages.encodeBatch: abi.encode(BATCH = 1, batchId, deposits, redeems) (CascadeMessages.sol:26-31). */
export const BATCH_PARAMS =
  "uint8 kind, uint64 batchId, (address user, uint256 amount)[] deposits, (address user, uint256 amount)[] redeems";

export const encodeBatch = (id: bigint, deposits: readonly Entry[], redeems: readonly Entry[]): Hex =>
  encodeAbiParameters(parseAbiParameters(BATCH_PARAMS), [1, id, deposits, redeems]);

/** The open batch's id: one past the last closed one (an empty batch rolls without a new id). */
export const openBatchId = (closedIds: readonly bigint[]): bigint =>
  closedIds.reduce((max, id) => (id > max ? id : max), 0n) + 1n;
