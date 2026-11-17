import type { Address } from "viem";
import type { ChainName } from "./config.ts";
import type { CallRequest } from "./keeper/core/types.ts";
import type { BuildV32 } from "./v32/build.ts";

/** A contract creation of a v3-launch plan, sent with `forge create` (send.ts sendCreate). It names no build: such a
 * request is v3-launch's, whose frozen build (ops/builds/preaudit) gives its constructor. */
export interface CreateRequest {
  chain: ChainName;
  nonce: number;
  label: string;
  /** forge's path:Name, e.g. 'src/CascadeVault.sol:CascadeVault' */
  contract: string;
  args: unknown[];
}

/** A v3.2 create (Task 44): tied to v3.2's frozen build, which gives its creation code, linked with `libraries` (path:Name
 * -> the planned address), and its constructor; sent as exactly those bytes, signed by the deployer's keystore. Its
 * gas may not exceed `gasCeiling`, the most the plan's funding counts for it (v32/deploy.ts). */
export interface CreateRequestV32 extends CreateRequest {
  version: 32;
  build: BuildV32;
  libraries?: Record<string, Address>;
  gasCeiling: bigint;
}

/** A contract call: the keeper core's type (keeper/core/types.ts). */
export type { CallRequest };

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
  | "setRewardCut"
  // a launch: the vault's limits (LAUNCH_VAULT_LIMITS)
  | "setOutflowLimits"
  | "setMaxTotalAssets"
  | "setMessageLimits"
  | "setFeeLimits"
  // a launch: offer ownership to the final owner, the last step on each contract
  | "fdTransferOwnership"
  | "stakerTransferOwnership"
  | "vaultTransferOwnership";

export type PlannedStep = { id: StepId } & (({ kind: "create" } & CreateRequest) | ({ kind: "call" } & CallRequest));
