import { type Address, encodePacked, formatEther, getContractAddress, type Hex, parseAbi } from "viem";
import {
  BASE_V3,
  CADENCE,
  type Cadence,
  type DeploySettings,
  LAUNCH_VAULT_LIMITS,
  LIVE,
  PRECOMPILE,
  SETTINGS,
  SETTINGS_V3,
  SETTINGS_V3_A2B4412,
  SETTINGS_V3_LAUNCH,
  VAULT_DEFAULTS,
  type VaultLimits,
  WALLET,
} from "./config.ts";
import { roleProblems, type Roles, TEST_ROLES } from "./roles.ts";
import type { PlannedStep } from "./types.ts";

export interface Plan {
  baseNonce: number;
  bitNonce: number;
  addresses: { baseAdapter: Address; frontDoor: Address; bitAdapter: Address; vault: Address };
  steps: PlannedStep[];
}

/** The v3 deployment: v2's four contracts (the front door now takes USDC) plus, on Base, the TWAP
 * oracle and the staker. A v2 record's plan has no `version`. */
export interface PlanV3 extends Omit<Plan, "addresses"> {
  version: 3;
  /** The contracts build the plan is deployed from, so verify compares its code with that build. Absent =
   * "a2b4412" (plans made before the launch cadence, e.g. the v3-test record; see builds.ts). */
  build?: string;
  /** Absent = "test". Fixed when the plan is made; later commands read it from the record. */
  cadence?: Cadence;
  /** A launch plan's owner, guardian, keeper and treasury. Absent = the test plan: the test wallet in
   * every role (TEST_ROLES). */
  roles?: Roles;
  addresses: Plan["addresses"] & { oracle: Address; staker: Address };
}

export const isPlanV3 = (plan: Plan | PlanV3): plan is PlanV3 => "version" in plan && plan.version === 3;

/** The contracts build in contracts/out, which new v3 plans record and are deployed from: the pre-audit
 * changes (the adapters take a per-message cap, the vault's allowance base and setter bounds). The build
 * before it, "launch-cadence", was never deployed, and its plans are refused like any unknown build. */
export const CONTRACTS_BUILD = "preaudit";
/** The build v3 was first deployed from: a v3 plan without a `build` was made by it. */
export const A2B4412_BUILD = "a2b4412";
export type ContractsBuild = typeof CONTRACTS_BUILD | typeof A2B4412_BUILD;

/** The contracts build a v3 plan was deployed from: absent is a2b4412; anything unrecognised is refused. */
export function buildOf(plan: PlanV3): ContractsBuild {
  const b = plan.build;
  if (b === undefined) return A2B4412_BUILD;
  if (b === CONTRACTS_BUILD) return CONTRACTS_BUILD;
  throw new Error(
    `the record's plan was deployed from a contracts build "${String(b)}" this tool does not know (an unfinished plan can be replaced with deploy --new-plan); nothing read or sent`,
  );
}

/** The settings a plan was built with. */
export const settingsOf = (plan: Plan | PlanV3): DeploySettings => (isPlanV3(plan) ? settingsV3Of(plan) : SETTINGS);

/** A v3 plan's full settings, for its cadence and the build it was deployed from: an a2b4412 plan (the
 * live v3-test record) keeps the settings that build deployed. */
export function settingsV3Of(plan: PlanV3): typeof SETTINGS_V3 | typeof SETTINGS_V3_LAUNCH | typeof SETTINGS_V3_A2B4412 {
  if (!isPlanV3(plan)) throw new Error("settingsV3Of: the plan is v2");
  if (cadenceOf(plan) === "launch") return SETTINGS_V3_LAUNCH;
  return buildOf(plan) === A2B4412_BUILD ? SETTINGS_V3_A2B4412 : SETTINGS_V3;
}

/** The vault limits a cadence runs with: a launch's own (set during deploy) over the contract's defaults,
 * which a test plan keeps. */
const vaultLimitsFor = (cadence: Cadence): VaultLimits => (cadence === "launch" ? { ...VAULT_DEFAULTS, ...LAUNCH_VAULT_LIMITS } : VAULT_DEFAULTS);

/** The vault limits a v3 plan runs with. */
export const vaultLimitsOf = (plan: PlanV3): VaultLimits => vaultLimitsFor(cadenceOf(plan));

/** What the adapters' per-message caps are checked against, in wei. */
export interface AdapterCapInputs {
  baseCap: bigint;
  bitCap: bigint;
  minSendAmount: bigint;
  maxBatchValue: bigint;
  vaultMaxMessageValue: bigint;
  maxEntryValue: bigint;
}

/** What breaks the adapters' per-message caps, as lines naming each value; none when they fit. The Base
 * adapter's cap must hold a full batch (the front door's maxBatchValue), and its minSendAmount must be
 * within it. The Bittensor adapter's must hold the largest payout message (the vault's maxMessageValue),
 * a bounced deposit, which can be a whole batch (maxBatchValue), and the largest single entry (the
 * vault's maxEntryValue, which goes alone if it must). Above a cap a send reverts MessageTooLarge, so the
 * batch or payout would wait for new adapters (7 days). `view` names the adapters' view in the lines. */
export function adapterCapProblems(c: AdapterCapInputs, view = "maxMessageValue"): string[] {
  const tao = (wei: bigint) => `${formatEther(wei)} TAO`;
  const base = `Base CcipBaseAdapter.${view} (${tao(c.baseCap)})`;
  const bit = `Bittensor CcipBittensorAdapter.${view} (${tao(c.bitCap)})`;
  const out: string[] = [];
  if (c.baseCap < c.maxBatchValue) out.push(`${base} is below the front door's maxBatchValue (${tao(c.maxBatchValue)}): a full batch could never be sent`);
  if (c.bitCap < c.vaultMaxMessageValue && c.vaultMaxMessageValue >= c.maxBatchValue) {
    out.push(`${bit} is below the vault's maxMessageValue (${tao(c.vaultMaxMessageValue)}): a payout message that size could never be sent`);
  } else if (c.bitCap < c.maxBatchValue) {
    out.push(`${bit} is below the front door's maxBatchValue (${tao(c.maxBatchValue)}): a bounced batch could never be paid back`);
  }
  if (c.bitCap < c.maxEntryValue) out.push(`${bit} is below the vault's maxEntryValue (${tao(c.maxEntryValue)}): a payout entry that size could never be sent`);
  if (c.minSendAmount > c.baseCap) out.push(`Base CcipBaseAdapter.minSendAmount (${tao(c.minSendAmount)}) is above its ${view} (${tao(c.baseCap)}): no amount could be sent`);
  return out;
}

/** Refuses settings whose adapter caps don't cover the plan's batch value and vault limits. */
export function checkAdapterCaps(
  s: Pick<DeploySettings, "adapterMaxMessageValue" | "minSendAmount"> & { maxBatchValue: bigint },
  limits: Pick<VaultLimits, "maxMessageValue" | "maxEntryValue">,
): void {
  const problems = adapterCapProblems({
    baseCap: s.adapterMaxMessageValue.base,
    bitCap: s.adapterMaxMessageValue.bittensor,
    minSendAmount: s.minSendAmount,
    maxBatchValue: s.maxBatchValue,
    vaultMaxMessageValue: limits.maxMessageValue,
    maxEntryValue: limits.maxEntryValue,
  });
  if (problems.length) throw new Error(`the adapters' per-message caps don't cover the plan's limits:\n  ${problems.join("\n  ")}\nnothing planned`);
}

/** Each adapter's per-message cap as deployed, and the view that reads it back. The a2b4412 build's
 * adapters (the live v3-test record) have no maxMessageValue(): their cap is the constant
 * MAX_MESSAGE_VALUE, 5,000 TAO. */
export function adapterCapsOf(plan: PlanV3): { view: "maxMessageValue" | "MAX_MESSAGE_VALUE"; base: bigint; bittensor: bigint } {
  return { view: buildOf(plan) === A2B4412_BUILD ? "MAX_MESSAGE_VALUE" : "maxMessageValue", ...settingsV3Of(plan).adapterMaxMessageValue };
}

/** Who holds each role: a launch plan's roles, else the test wallet in every one. */
export const rolesOf = (plan: Plan | PlanV3): Roles => (isPlanV3(plan) && plan.roles ? plan.roles : TEST_ROLES);

/** A record's cadence: absent is test; anything unrecognised is refused. */
export function cadenceOf(plan: Plan | PlanV3): Cadence {
  const c = isPlanV3(plan) ? plan.cadence : undefined;
  if (c === undefined || c === "test") return "test";
  if (c === "launch") return "launch";
  throw new Error(`the record's plan has a cadence "${String(c)}" this tool does not know; nothing sent`);
}

/** The keeper's extra wait, in seconds, before closing a batch. 0 (test) means none: close as soon as the
 * contract allows, so a later on-chain interval change cannot make the keeper wait longer than the contract. */
export const closeMaxWaitS = (plan: Plan | PlanV3): number => CADENCE[cadenceOf(plan)].closeMaxWaitS ?? 0;

export const CONFIG_ABI = {
  fundReserve: parseAbi(["function fundReserve() payable"]),
  transfer: parseAbi(["function transfer(bytes32 data) payable"]),
  setKeeper: parseAbi(["function setKeeper(address newKeeper)"]),
  setPayoutDelay: parseAbi(["function setPayoutDelay(uint64 delay)"]),
  setSwapper: parseAbi(["function setSwapper(address newSwapper)"]),
  setOracle: parseAbi(["function setOracle(address newOracle)"]),
  setMaxBatchValue: parseAbi(["function setMaxBatchValue(uint256 value)"]),
  setRoute: parseAbi([
    "struct Route { uint8 kind; address router; bytes buyPath; bytes sellPath; bool active; }",
    "function setRoute(uint8 id, Route r)",
  ]),
  setDeliveryRoute: parseAbi(["function setDeliveryRoute(uint8 id)"]),
  setFees: parseAbi(["function setFees(uint16 swapFeeBps_, uint256 depositFeeUsdc_)"]),
  setRewardCut: parseAbi(["function setRewardCut(address treasury_, uint16 bps)"]),
  transferOwnership: parseAbi(["function transferOwnership(address newOwner)"]),
  setOutflowLimits: parseAbi(["function setOutflowLimits(uint256 bps, uint256 minDaily)"]),
  setMaxTotalAssets: parseAbi(["function setMaxTotalAssets(uint256 amount)"]),
  setMessageLimits: parseAbi(["function setMessageLimits(uint256 maxEntryValue_, uint256 maxMessageValue_, uint32 minChunk_)"]),
  setFeeLimits: parseAbi(["function setFeeLimits(uint256 bps, uint256 abs_)"]),
};

/** A launch's vault limits, set after the reward cut and before the vault's hand-off. */
function vaultLimitSteps(nonce: number, vault: Address): PlannedStep[] {
  const L = LAUNCH_VAULT_LIMITS;
  const call = (id: PlannedStep["id"], n: number, label: string, functionName: keyof typeof CONFIG_ABI, args: unknown[]): PlannedStep => ({
    id,
    kind: "call",
    chain: "bittensor",
    nonce: n,
    label,
    to: vault,
    abi: CONFIG_ABI[functionName],
    functionName,
    args,
  });
  const tao = (wei: bigint) => formatEther(wei);
  return [
    call(
      "setOutflowLimits",
      nonce,
      `let redeems burn at most ${Number(L.maxDailyOutflowBps) / 100}% of the vault a day, or ${tao(L.minDailyOutflow)} TAO when that is more`,
      "setOutflowLimits",
      [L.maxDailyOutflowBps, L.minDailyOutflow],
    ),
    call("setMaxTotalAssets", nonce + 1, `stop direct deposits once the vault holds ${tao(L.maxTotalAssets)} TAO`, "setMaxTotalAssets", [L.maxTotalAssets]),
    call(
      "setMessageLimits",
      nonce + 2,
      `limit a redeem entry to ${tao(L.maxEntryValue)} TAO and a payout message to ${tao(L.maxMessageValue)} TAO (chunks of at least ${L.minChunk})`,
      "setMessageLimits",
      [L.maxEntryValue, L.maxMessageValue, L.minChunk],
    ),
    call("setFeeLimits", nonce + 3, `cap a payout's bridge fee at ${Number(L.maxFeeBps) / 100}% or ${tao(L.maxFeeAbs)} TAO`, "setFeeLimits", [L.maxFeeBps, L.maxFeeAbs]),
  ];
}

/** A Uniswap v3 path: token | fee (3 bytes) | token | fee | token. */
const uniswapPath = (a: Address, ab: number, b: Address, bc: number, c: Address): Hex =>
  encodePacked(["address", "uint24", "address", "uint24", "address"], [a, ab, b, bc, c]);

/** The staker's route 0: SwapRouter02's exactInput through WETH, USDC -0.05%-> WETH -0.3%-> TAO, and back. */
export const ROUTE_0 = {
  kind: 0, // RouterKind.UniswapV3
  router: BASE_V3.SWAP_ROUTER_02,
  buyPath: uniswapPath(BASE_V3.USDC, 500, BASE_V3.WETH, 3000, LIVE.base.TOKEN),
  sellPath: uniswapPath(LIVE.base.TOKEN, 3000, BASE_V3.WETH, 500, BASE_V3.USDC),
  active: true,
} as const;

const at = (nonce: number) => getContractAddress({ from: WALLET, nonce: BigInt(nonce) });

type Core = Plan["addresses"];

function baseAdapterStep(nonce: number, a: Core, s: DeploySettings): PlannedStep {
  const base = LIVE.base;
  const bit = LIVE.bittensor;
  return {
    id: "baseAdapter",
    kind: "create",
    chain: "base",
    nonce,
    label: "deploy the Base bridge adapter",
    contract: "src/adapters/CcipBaseAdapter.sol:CcipBaseAdapter",
    args: [
      {
        router: base.ROUTER,
        token: base.TOKEN,
        localChainId: BigInt(base.CHAIN_ID),
        remoteChainId: BigInt(bit.CHAIN_ID),
        remoteSelector: bit.SELECTOR,
        remoteAdapter: a.bitAdapter,
        gasBase: s.baseGas.base,
        gasPerEntry: s.baseGas.perEntry,
        maxMessageValue: s.adapterMaxMessageValue.base,
      },
      s.minSendAmount,
    ],
  };
}

/** The front door's v2 constructor arguments; v3 appends USDC. The test wallet deploys it and owns it
 * while the deployment is configured; the guardian is the final one (a launch's own). */
const frontDoorArgs = (a: Core, s: DeploySettings, guardian: Address = WALLET): unknown[] => [
  LIVE.base.TOKEN,
  a.baseAdapter,
  BigInt(LIVE.bittensor.CHAIN_ID),
  a.vault,
  WALLET,
  guardian,
  BigInt(s.batchInterval),
  s.minDeposit,
  s.depositCap,
  s.redeemRequestFee,
];

const frontDoorStep = (nonce: number, args: unknown[]): PlannedStep => ({
  id: "frontDoor",
  kind: "create",
  chain: "base",
  nonce,
  label: "deploy the front door",
  contract: "src/CascadeFrontDoor.sol:CascadeFrontDoor",
  args,
});

/** How a step names the keeper: the test wallet, or a launch's keeper by address. */
const keeperName = (roles: Roles) => (roles === TEST_ROLES ? "the test wallet" : roles.keeper);

/** Bittensor's adapter, vault, reserves, keeper and payout delay, from `bitNonce` on. The test wallet
 * deploys the vault and owns it while it is configured; its guardian and keeper are the roles'. */
function bittensorSteps(bitNonce: number, a: Core, vaultColdkey: Hex, s: DeploySettings, roles: Roles = TEST_ROLES): PlannedStep[] {
  const base = LIVE.base;
  const bit = LIVE.bittensor;
  const hours = s.payoutDelay / 3600;
  return [
    {
      id: "bitAdapter",
      kind: "create",
      chain: "bittensor",
      nonce: bitNonce,
      label: "deploy the Bittensor bridge adapter",
      contract: "src/adapters/CcipBittensorAdapter.sol:CcipBittensorAdapter",
      args: [
        {
          router: bit.ROUTER,
          token: bit.TOKEN,
          localChainId: BigInt(bit.CHAIN_ID),
          remoteChainId: BigInt(base.CHAIN_ID),
          remoteSelector: base.SELECTOR,
          remoteAdapter: a.baseAdapter,
          gasBase: s.bitGas.base,
          gasPerEntry: s.bitGas.perEntry,
          maxMessageValue: s.adapterMaxMessageValue.bittensor,
        },
        LIVE.ALPHA_VAULT,
      ],
    },
    {
      id: "vault",
      kind: "create",
      chain: "bittensor",
      nonce: bitNonce + 1,
      label: "deploy the vault",
      contract: "src/CascadeVault.sol:CascadeVault",
      args: [vaultColdkey, s.hotkey, a.bitAdapter, WALLET, roles.guardian.bittensor, s.minDirectDeposit, BigInt(base.CHAIN_ID), a.frontDoor],
    },
    {
      id: "adapterReserve",
      kind: "call",
      chain: "bittensor",
      nonce: bitNonce + 2,
      label: "fund the Bittensor adapter's reserve",
      to: a.bitAdapter,
      abi: CONFIG_ABI.fundReserve,
      functionName: "fundReserve",
      args: [],
      value: s.adapterReserve,
    },
    {
      id: "vaultReserve",
      kind: "call",
      chain: "bittensor",
      nonce: bitNonce + 3,
      label: "fund the vault's reserve through the transfer precompile",
      to: PRECOMPILE.balanceTransfer,
      abi: CONFIG_ABI.transfer,
      functionName: "transfer",
      args: [vaultColdkey],
      value: s.vaultReserve,
    },
    {
      id: "setKeeper",
      kind: "call",
      chain: "bittensor",
      nonce: bitNonce + 4,
      label: `make ${keeperName(roles)} the vault's keeper`,
      to: a.vault,
      abi: CONFIG_ABI.setKeeper,
      functionName: "setKeeper",
      args: [roles.keeper],
    },
    {
      id: "setPayoutDelay",
      kind: "call",
      chain: "bittensor",
      nonce: bitNonce + 5,
      label: `set the payout delay to ${hours} hour${hours === 1 ? "" : "s"}`,
      to: a.vault,
      abi: CONFIG_ABI.setPayoutDelay,
      functionName: "setPayoutDelay",
      args: [BigInt(s.payoutDelay)],
    },
  ];
}

/** The deployment from the wallet's current nonces: Base first, so the vault names a front door that
 * already has code (spec, deployment order). `vaultColdkey` is addressMapping(predicted vault). */
export function buildPlan(baseNonce: number, bitNonce: number, vaultColdkey: Hex): Plan {
  const addresses = { baseAdapter: at(baseNonce), frontDoor: at(baseNonce + 1), bitAdapter: at(bitNonce), vault: at(bitNonce + 1) };
  const steps: PlannedStep[] = [
    baseAdapterStep(baseNonce, addresses, SETTINGS),
    frontDoorStep(baseNonce + 1, frontDoorArgs(addresses, SETTINGS)),
    ...bittensorSteps(bitNonce, addresses, vaultColdkey, SETTINGS),
  ];
  return { baseNonce, bitNonce, addresses, steps };
}

/** The roles a new plan is made with: a launch needs its own, which must pass roleProblems; the test
 * plan takes none and keeps the test wallet in every role. */
function planRoles(cadence: Cadence, roles: Roles | undefined): Roles {
  if (cadence === "test") {
    if (roles) throw new Error("the test plan keeps the test wallet in every role: roles are for a launch plan (OPS_CADENCE=launch)");
    return TEST_ROLES;
  }
  if (!roles) throw new Error("a launch plan needs its roles: set OPS_LAUNCH_OWNER_BASE, OPS_LAUNCH_OWNER_BITTENSOR, OPS_LAUNCH_GUARDIAN_BASE, OPS_LAUNCH_GUARDIAN_BITTENSOR, OPS_LAUNCH_KEEPER and OPS_LAUNCH_TREASURY");
  const problems = roleProblems(roles);
  if (problems.length) throw new Error(`the launch's roles are not ready:\n  ${problems.join("\n  ")}`);
  return roles;
}

/** A launch's last step on one contract: offer its ownership to that chain's final owner (Ownable2Step:
 * the test wallet stays the owner until the final owner calls acceptOwnership, from pnpm ops handoff). */
const handOff = (id: PlannedStep["id"], chain: "base" | "bittensor", nonce: number, what: string, to: Address, owner: Address): PlannedStep => ({
  id,
  kind: "call",
  chain,
  nonce,
  label: `offer ${what}'s ownership to ${owner} (it accepts with the files from pnpm ops handoff)`,
  to,
  abi: CONFIG_ABI.transferOwnership,
  functionName: "transferOwnership",
  args: [owner],
});

/** The v3 deployment from the wallet's current nonces. Base first: the adapter, the oracle, the front
 * door (which takes USDC), the staker (which reads the front door's tokens, so after it), then the
 * front door's keeper, swapper, oracle and batch value and the staker's route, delivery route and fees.
 * Then Bittensor as in v2, staking with tao.bot, and the vault's reward cut to the treasury. The test
 * plan has the test wallet as owner, guardian, keeper and treasury. A launch plan takes its `roles`:
 * the test wallet deploys and owns everything while it is configured, the guardians are the final ones
 * from the constructors, the keeper and treasury are set to the roles', and each chain ends by offering
 * ownership of the front door, the staker and the vault to that chain's owner (the oracle and the
 * adapters have no owner). */
export function buildPlanV3(baseNonce: number, bitNonce: number, vaultColdkey: Hex, cadence: Cadence = "test", roles?: Roles): PlanV3 {
  const r = planRoles(cadence, roles);
  const launch = cadence === "launch";
  const s = launch ? SETTINGS_V3_LAUNCH : SETTINGS_V3;
  checkAdapterCaps(s, vaultLimitsFor(cadence));
  const addresses = {
    baseAdapter: at(baseNonce),
    oracle: at(baseNonce + 1),
    frontDoor: at(baseNonce + 2),
    staker: at(baseNonce + 3),
    bitAdapter: at(bitNonce),
    vault: at(bitNonce + 1),
  };
  const call = (
    id: PlannedStep["id"],
    nonce: number,
    label: string,
    to: Address,
    functionName: keyof typeof CONFIG_ABI,
    args: unknown[],
  ): PlannedStep => ({ id, kind: "call", chain: "base", nonce, label, to, abi: CONFIG_ABI[functionName], functionName, args });
  const n = baseNonce;
  const steps: PlannedStep[] = [
    baseAdapterStep(n, addresses, s),
    {
      id: "oracle",
      kind: "create",
      chain: "base",
      nonce: n + 1,
      label: "deploy the TWAP oracle",
      contract: "src/CascadeTwapOracle.sol:CascadeTwapOracle",
      args: [BASE_V3.TAO_WETH_POOL, BASE_V3.WETH_USDC_POOL, LIVE.base.TOKEN, BASE_V3.WETH, BASE_V3.USDC],
    },
    frontDoorStep(n + 2, [...frontDoorArgs(addresses, s, r.guardian.base), BASE_V3.USDC]),
    {
      id: "staker",
      kind: "create",
      chain: "base",
      nonce: n + 3,
      label: "deploy the staker",
      contract: "src/CascadeStaker.sol:CascadeStaker",
      args: [BASE_V3.USDC, LIVE.base.TOKEN, addresses.frontDoor, WALLET, r.treasury],
    },
    call("fdSetKeeper", n + 4, `make ${keeperName(r)} the front door's keeper`, addresses.frontDoor, "setKeeper", [r.keeper]),
    call("fdSetSwapper", n + 5, "make the staker the front door's swapper", addresses.frontDoor, "setSwapper", [addresses.staker]),
    call("fdSetOracle", n + 6, "point the front door at the TWAP oracle", addresses.frontDoor, "setOracle", [addresses.oracle]),
    call(
      "fdSetMaxBatchValue",
      n + 7,
      `cap a batch's value at ${formatEther(s.maxBatchValue)} TAO`,
      addresses.frontDoor,
      "setMaxBatchValue",
      [s.maxBatchValue],
    ),
    call("stakerSetRoute0", n + 8, "give the staker route 0 (Uniswap, USDC - WETH - TAO)", addresses.staker, "setRoute", [0, { ...ROUTE_0 }]),
    call("stakerSetDeliveryRoute", n + 9, "deliver along route 0", addresses.staker, "setDeliveryRoute", [s.deliveryRouteId]),
    call(
      "stakerSetFees",
      n + 10,
      `set the staker's fees (${s.swapFeeBps / 100}% swap, ${Number(s.depositFeeUsdc) / 1e6} USDC deposit)`,
      addresses.staker,
      "setFees",
      [s.swapFeeBps, s.depositFeeUsdc],
    ),
    ...(launch
      ? [
          handOff("fdTransferOwnership", "base", n + 11, "the front door", addresses.frontDoor, r.owner.base),
          handOff("stakerTransferOwnership", "base", n + 12, "the staker", addresses.staker, r.owner.base),
        ]
      : []),
    ...bittensorSteps(bitNonce, addresses, vaultColdkey, s, r),
    {
      id: "setRewardCut",
      kind: "call",
      chain: "bittensor",
      nonce: bitNonce + 6,
      label: `cut ${s.rewardCutBps / 100}% of rewards to the treasury`,
      to: addresses.vault,
      abi: CONFIG_ABI.setRewardCut,
      functionName: "setRewardCut",
      args: [r.treasury, s.rewardCutBps],
    },
    ...(launch
      ? [...vaultLimitSteps(bitNonce + 7, addresses.vault), handOff("vaultTransferOwnership", "bittensor", bitNonce + 11, "the vault", addresses.vault, r.owner.bittensor)]
      : []),
  ];
  return { version: 3, build: CONTRACTS_BUILD, ...(launch ? { cadence, roles: r } : {}), baseNonce, bitNonce, addresses, steps };
}
