import type { Abi, Address } from "viem";
import type { ChainName } from "./config.ts";

/** A contract creation, sent with `forge create`. */
export interface CreateRequest {
  chain: ChainName;
  nonce: number;
  label: string;
  /** forge's path:Name, e.g. 'src/CascadeVault.sol:CascadeVault' */
  contract: string;
  args: unknown[];
}

/** A contract call, sent with `cast send`. */
export interface CallRequest {
  chain: ChainName;
  nonce: number;
  label: string;
  to: Address;
  abi: Abi;
  functionName: string;
  args: unknown[];
  value?: bigint;
}

export type StepId =
  | "baseAdapter"
  | "frontDoor"
  | "bitAdapter"
  | "vault"
  | "adapterReserve"
  | "vaultReserve"
  | "setKeeper"
  | "setPayoutDelay"
  // v3
  | "oracle"
  | "staker"
  | "fdSetKeeper"
  | "fdSetSwapper"
  | "fdSetOracle"
  | "fdSetMaxBatchValue"
  | "stakerSetRoute0"
  | "stakerSetDeliveryRoute"
  | "stakerSetFees"
  | "setRewardCut";

export type PlannedStep = { id: StepId } & (({ kind: "create" } & CreateRequest) | ({ kind: "call" } & CallRequest));
