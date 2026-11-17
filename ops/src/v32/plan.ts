import { blake2b } from "@noble/hashes/blake2";
import { type Address, bytesToHex, concat, getAddress, getContractAddress, type Hex, hexToBytes, stringToBytes } from "viem";
import { BASE_V3, type ChainName, LIVE } from "../config.ts";
import type { Plan, PlanV3 } from "../plan.ts";
import type { CreateRequest } from "../types.ts";
import {
  BOUNDS_V32,
  capRelationProblemsV32,
  deployerProblems,
  msPerBlockProblems,
  roleProblemsV32,
  SETTINGS_V32_LAUNCH,
  type SettingsV32,
  type V32Roles,
  type V32Validators,
  validatorProblems,
} from "./settings.ts";

// v3.2's deployment plan (spec §7 step 2): every contract, library and lens by plain CREATE from one fresh,
// single-use deployer key per chain, each at the address its nonce predicts, each taking every setting from its
// constructor (SETTINGS_V32_LAUNCH, Appendix B). No setter step follows (§7 step 4, "nothing to set"), so every
// step is a create. Bittensor goes first (a revert there costs nothing on Base), then Base; on each chain the
// adapter comes first, as the constructors read its maxMessageValue().

/** The steps of a v3.2 plan, one per contract. */
export type V32StepId =
  | "bitAdapter"
  | "payoutMath"
  | "stakeLib"
  | "payoutLib"
  | "batchLib"
  | "hotkeyLib"
  | "vault"
  | "vaultLens"
  | "baseAdapter"
  | "oracle"
  | "frontDoor"
  | "staker"
  | "doorLens";

/** A v3.2 step: always a create (constructor-only). `version` 32 ties it to v3.2's build: send.ts's sendCreate routes it
 * there before any v3-launch path, and refuses it without that build. `libraries` names, for a create whose code links
 * libraries, each one's planned address by forge's `path:Name` (build.ts linkLibraries fills them in). */
export type PlannedStepV32 = { id: V32StepId; kind: "create"; version: 32; libraries?: Record<string, Address> } & CreateRequest;

export interface PlanV32 {
  version: 32;
  roles: V32Roles;
  validators: V32Validators;
  /** One fresh deployer per chain, each from nonce 0. */
  deployers: Record<ChainName, Address>;
  addresses: Record<V32StepId, Address>;
  /** The vault's coldkey: the ADDRESS_MAPPING of its planned address (the constructor's expectedColdkey). */
  vaultColdkey: Hex;
  /** The front door's pool-depth floors, TAO/WETH then WETH/USDC (Appendix B: measured; the founder's rule, floors.ts
   * FLOOR_RULES: a quarter of the 30-day median, half the 30-day lowest). */
  poolFloors: [bigint, bigint];
  /** The vault's claimGasRequired (Appendix B: the testnet measurement of claimRootWithHotkey). */
  claimGasRequired: bigint;
  /** The measurement the adapters' gas models come from (SETTINGS_V32_LAUNCH.gas.source); absent while they are the
   * mock figures, and a live deploy refuses then. */
  gasSource?: string;
  steps: PlannedStepV32[];
}

/** Whether a record's plan is v3.2's (`version` 32); v3-launch's and v3-test's are 3, a v2 plan has none. */
export const isPlanV32 = (plan: Plan | PlanV3 | PlanV32): plan is PlanV32 => "version" in plan && plan.version === 32;

/** The nonce plan, in §7 step 2's order: on Bittensor the adapter; the libraries, CascadePayoutMath, L2
 * CascadeStakeLib, L3 CascadePayoutLib (it links the math, deployed before it) and L1 CascadeBatchLib, then L4
 * CascadeHotkeyLib (the reserve lever, used: it joins before the vault, and every later nonce shifts); the vault,
 * which links L1, L2, L3 and L4; its lens. On Base the adapter, the oracle, the front door (which names the oracle
 * and the staker), the staker (which reads the front door's tokens), the door's lens. The order follows the build's
 * link graph, contracts/test/utils/generated/LibraryLinks.sol (test/v32-plan.test.ts holds it so). */
export const NONCE_PLAN = {
  bittensor: ["bitAdapter", "payoutMath", "stakeLib", "payoutLib", "batchLib", "hotkeyLib", "vault", "vaultLens"],
  base: ["baseAdapter", "oracle", "frontDoor", "staker", "doorLens"],
} as const satisfies Record<ChainName, readonly V32StepId[]>;

/** The address a plain CREATE from `deployer` at `nonce` makes (keccak256 of the RLP of the deployer and the nonce).
 * test/v32-plan.test.ts holds it to a textbook vector and to v3-launch's real creates (Task 45's re-review, N1). */
export const createAddressV32 = (deployer: Address, nonce: number): Address => getContractAddress({ from: getAddress(deployer), nonce: BigInt(nonce) });

/** Each step's address: the CREATE address of its chain's deployer at the step's nonce in NONCE_PLAN. The one
 * derivation, used by the plan (buildPlanV32), the deploy (the vault's coldkey before its keys are planned) and the
 * code read-back, which re-derives a record's addresses with it (Task 45's review, M4). */
export function plannedAddressesV32(deployers: Record<ChainName, Address>): Record<V32StepId, Address> {
  const addresses = {} as Record<V32StepId, Address>;
  for (const chain of ["bittensor", "base"] as const) {
    NONCE_PLAN[chain].forEach((id, nonce) => {
      addresses[id] = createAddressV32(deployers[chain], nonce);
    });
  }
  return addresses;
}

/** Each step's contract (forge's path:Name) and what the deploy prints for it. */
export const CONTRACTS_V32: Record<V32StepId, { contract: string; label: string }> = {
  bitAdapter: { contract: "src/adapters/CcipBittensorAdapter.sol:CcipBittensorAdapter", label: "deploy the Bittensor bridge adapter" },
  payoutMath: { contract: "src/libraries/CascadePayoutMath.sol:CascadePayoutMath", label: "deploy the payout math library" },
  stakeLib: { contract: "src/libraries/CascadeStakeLib.sol:CascadeStakeLib", label: "deploy the unstake library" },
  payoutLib: { contract: "src/libraries/CascadePayoutLib.sol:CascadePayoutLib", label: "deploy the payout library" },
  batchLib: { contract: "src/libraries/CascadeBatchLib.sol:CascadeBatchLib", label: "deploy the batch library" },
  hotkeyLib: { contract: "src/libraries/CascadeHotkeyLib.sol:CascadeHotkeyLib", label: "deploy the hotkey library" },
  vault: { contract: "src/CascadeVault.sol:CascadeVault", label: "deploy the vault" },
  vaultLens: { contract: "src/lens/CascadeVaultLens.sol:CascadeVaultLens", label: "deploy the vault's lens" },
  baseAdapter: { contract: "src/adapters/CcipBaseAdapter.sol:CcipBaseAdapter", label: "deploy the Base bridge adapter" },
  oracle: { contract: "src/CascadeTwapOracle.sol:CascadeTwapOracle", label: "deploy the TWAP oracle" },
  frontDoor: { contract: "src/CascadeFrontDoor.sol:CascadeFrontDoor", label: "deploy the front door" },
  staker: { contract: "src/CascadeStaker.sol:CascadeStaker", label: "deploy the staker" },
  doorLens: { contract: "src/lens/CascadeDoorLens.sol:CascadeDoorLens", label: "deploy the front door's lens" },
};

/** The link graph (I-32): the libraries each linking create links. The vault links L1, L2, L3 and L4; L3 links
 * CascadePayoutMath; nothing else links anything. */
export const LINKS_V32 = {
  payoutLib: ["payoutMath"],
  vault: ["batchLib", "hotkeyLib", "payoutLib", "stakeLib"],
} as const satisfies Partial<Record<V32StepId, readonly V32StepId[]>>;

/** The substrate account Bittensor's EVM mirrors `address` to, as the ADDRESS_MAPPING precompile (0x…080C) answers:
 * blake2b-256 of "evm:" followed by the address's 20 bytes (HashedAddressMapping<BlakeTwo256>). */
export function addressMapping(address: Address): Hex {
  return bytesToHex(blake2b(concat([stringToBytes("evm:"), hexToBytes(getAddress(address))]), { dkLen: 32 }));
}

const create = (id: V32StepId, chain: ChainName, nonce: number, args: unknown[], libraries?: Record<string, Address>): PlannedStepV32 => ({
  id,
  kind: "create",
  version: 32,
  chain,
  nonce,
  label: CONTRACTS_V32[id].label,
  contract: CONTRACTS_V32[id].contract,
  args,
  ...(libraries ? { libraries } : {}),
});

const UINT128_MAX = (1n << 128n) - 1n;

/** The v3.2 plan from fresh deployer keys (nonce 0 on each chain), constructor-only, every setting from
 * SETTINGS_V32_LAUNCH. `vaultColdkey` must be the ADDRESS_MAPPING of the vault's planned address (a wrong one would
 * revert the vault's CREATE, after six others, ColdkeyMismatch): a caller that read it from the chain's precompile
 * has it checked against the offline derivation. The standby is recorded, never passed to a constructor. Refuses,
 * planning nothing, roles, validators, deployers or inputs that are not ready, and cap relations that do not hold. */
export function buildPlanV32(o: {
  deployers: PlanV32["deployers"];
  roles: V32Roles;
  validators: V32Validators;
  vaultColdkey: Hex;
  poolFloors: [bigint, bigint];
  claimGasRequired: bigint;
}): PlanV32 {
  const s = SETTINGS_V32_LAUNCH;
  const gasSource = (s.gas as SettingsV32["gas"]).source?.trim();
  const problems = [...roleProblemsV32(o.roles), ...validatorProblems(o.validators), ...deployerProblems(o.deployers, o.roles), ...capRelationProblemsV32(s), ...msPerBlockProblems(s)];
  if (o.claimGasRequired < BOUNDS_V32.minClaimGas || o.claimGasRequired > BOUNDS_V32.maxClaimGas) {
    problems.push(`claimGasRequired ${o.claimGasRequired} is outside ${BOUNDS_V32.minClaimGas} to ${BOUNDS_V32.maxClaimGas} (the vault's bounds)`);
  }
  o.poolFloors.forEach((f, i) => {
    if (f <= 0n || f > UINT128_MAX) problems.push(`the ${i === 0 ? "TAO/WETH" : "WETH/USDC"} pool floor ${f} is not above 0 and within uint128 (0 would check nothing)`);
  });
  if (problems.length) throw new Error(`the v3.2 plan is not ready:\n  ${problems.join("\n  ")}\nnothing planned`);

  const deployers = { base: getAddress(o.deployers.base), bittensor: getAddress(o.deployers.bittensor) };
  const addresses = plannedAddressesV32(deployers);
  const derived = addressMapping(addresses.vault);
  if (o.vaultColdkey.toLowerCase() !== derived) {
    throw new Error(
      `the vault's coldkey ${o.vaultColdkey} is not the ADDRESS_MAPPING of its planned address ${addresses.vault} (${derived}): the vault's CREATE would revert; nothing planned`,
    );
  }
  const nonceOf = (chain: ChainName, id: V32StepId) => (NONCE_PLAN[chain] as readonly V32StepId[]).indexOf(id);
  const links = (id: keyof typeof LINKS_V32) => Object.fromEntries(LINKS_V32[id].map((lib) => [CONTRACTS_V32[lib].contract, addresses[lib]]));
  const r: V32Roles = { owner: getAddress(o.roles.owner), guardian: getAddress(o.roles.guardian), keeper: getAddress(o.roles.keeper), treasury: getAddress(o.roles.treasury) };
  const validators: V32Validators = { primary: o.validators.primary.toLowerCase() as Hex, standby: o.validators.standby.toLowerCase() as Hex };
  const v = s.vault;
  const fd = s.frontDoor;
  const base = LIVE.base;
  const bit = LIVE.bittensor;
  const adapterConfig = (local: typeof base | typeof bit, remote: typeof base | typeof bit, remoteAdapter: Address, cap: bigint, gas: { base: bigint; perEntry: bigint }) => ({
    router: local.ROUTER,
    token: local.TOKEN,
    localChainId: BigInt(local.CHAIN_ID),
    remoteChainId: BigInt(remote.CHAIN_ID),
    remoteSelector: remote.SELECTOR,
    remoteAdapter,
    gasBase: gas.base,
    gasPerEntry: gas.perEntry,
    maxMessageValue: cap,
    treasury: r.treasury,
  });
  const vaultParams = {
    expectedColdkey: derived,
    hotkey: validators.primary,
    bridge: addresses.bitAdapter,
    owner: r.owner,
    guardian: r.guardian,
    keeper: r.keeper,
    treasury: r.treasury,
    rewardCutBps: v.rewardCutBps,
    launchChain: v.launchChain,
    initialFrontDoor: addresses.frontDoor,
    payoutDelay: v.payoutDelay,
    maxDailyOutflowBps: v.maxDailyOutflowBps,
    minDailyOutflow: v.minDailyOutflow,
    maxEntryValue: v.maxEntryValue,
    maxMessageValue: v.maxMessageValue,
    minChunk: v.minChunk,
    maxFeeBps: v.maxFeeBps,
    maxFeeAbs: v.maxFeeAbs,
    maxTotalAssets: v.maxTotalAssets,
    minDirectDeposit: v.minDirectDeposit,
    claimGasRequired: o.claimGasRequired,
    hotkeyDustRao: v.hotkeyDustRao,
    unstakeMarginRao: v.unstakeMarginRao,
    msPerBlock: v.msPerBlock,
    rewardVesting: v.rewardVesting,
    globalOutflowBps: v.globalOutflowBps,
    idleBufferBps: v.idleBufferBps,
    unstakeGas: v.unstakeGas,
  };
  const doorParams = {
    asset: base.TOKEN,
    bridge: addresses.baseAdapter,
    vaultChain: BigInt(bit.CHAIN_ID),
    vault: addresses.vault,
    usdc: BASE_V3.USDC,
    owner: r.owner,
    guardian: r.guardian,
    keeper: r.keeper,
    oracle: addresses.oracle,
    swapper: addresses.staker,
    treasury: r.treasury,
    minPoolLiquidity: [o.poolFloors[0], o.poolFloors[1]],
    batchInterval: fd.batchInterval,
    minDeposit: fd.minDeposit,
    depositCap: fd.depositCap,
    redeemRequestFee: fd.redeemRequestFee,
    maxDeposits: fd.maxDeposits,
    maxRedeems: fd.maxRedeems,
    maxBatchValue: fd.maxBatchValue,
    maxDeliverySlippageBps: fd.maxDeliverySlippageBps,
    msPerBlock: fd.msPerBlock,
  };
  const stakerParams = {
    usdc: BASE_V3.USDC,
    tao: base.TOKEN,
    frontDoor: addresses.frontDoor,
    owner: r.owner,
    treasury: r.treasury,
    route0: { ...s.staker.route0 },
    deliveryRouteId: s.staker.deliveryRouteId,
    swapFeeBps: s.staker.swapFeeBps,
    depositFeeUsdc: s.staker.depositFeeUsdc,
  };
  const argsOf: Record<V32StepId, unknown[]> = {
    // the Bittensor adapter also takes the lane's inbound model, the Base adapter's own pair (R4: deliverParked's gas
    // requirement), from the same setting, so the two copies are one model; verify holds them equal
    bitAdapter: [
      adapterConfig(bit, base, addresses.baseAdapter, s.adapters.maxMessageValue.bittensor, s.gas.towardBase),
      LIVE.ALPHA_VAULT,
      s.gas.towardBittensor.base,
      s.gas.towardBittensor.perEntry,
    ],
    payoutMath: [],
    stakeLib: [],
    payoutLib: [],
    batchLib: [],
    hotkeyLib: [],
    vault: [vaultParams],
    vaultLens: [addresses.vault],
    baseAdapter: [adapterConfig(base, bit, addresses.bitAdapter, s.adapters.maxMessageValue.base, s.gas.towardBittensor), s.adapters.minSendAmount],
    oracle: [BASE_V3.TAO_WETH_POOL, BASE_V3.WETH_USDC_POOL, base.TOKEN, BASE_V3.WETH, BASE_V3.USDC],
    frontDoor: [doorParams],
    staker: [stakerParams],
    doorLens: [addresses.frontDoor],
  };
  const steps: PlannedStepV32[] = [];
  for (const chain of ["bittensor", "base"] as const) {
    for (const id of NONCE_PLAN[chain]) {
      steps.push(create(id, chain, nonceOf(chain, id), argsOf[id], id in LINKS_V32 ? links(id as keyof typeof LINKS_V32) : undefined));
    }
  }
  return {
    version: 32,
    roles: r,
    validators,
    deployers,
    addresses,
    vaultColdkey: derived,
    poolFloors: [o.poolFloors[0], o.poolFloors[1]],
    claimGasRequired: o.claimGasRequired,
    ...(gasSource ? { gasSource } : {}),
    steps,
  };
}
