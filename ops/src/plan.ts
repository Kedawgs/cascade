import { type Address, encodePacked, formatEther, getContractAddress, type Hex, parseAbi } from "viem";
import { BASE_V3, type DeploySettings, LIVE, PRECOMPILE, SETTINGS, SETTINGS_V3, WALLET } from "./config.ts";
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
  addresses: Plan["addresses"] & { oracle: Address; staker: Address };
}

export const isPlanV3 = (plan: Plan | PlanV3): plan is PlanV3 => "version" in plan && plan.version === 3;

/** The settings a plan was built with. */
export const settingsOf = (plan: Plan | PlanV3): DeploySettings => (isPlanV3(plan) ? SETTINGS_V3 : SETTINGS);

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
};

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
      },
      s.minSendAmount,
    ],
  };
}

/** The front door's v2 constructor arguments; v3 appends USDC. */
const frontDoorArgs = (a: Core, s: DeploySettings): unknown[] => [
  LIVE.base.TOKEN,
  a.baseAdapter,
  BigInt(LIVE.bittensor.CHAIN_ID),
  a.vault,
  WALLET,
  WALLET,
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

/** Bittensor's adapter, vault, reserves, keeper and payout delay, from `bitNonce` on. */
function bittensorSteps(bitNonce: number, a: Core, vaultColdkey: Hex, s: DeploySettings): PlannedStep[] {
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
      args: [vaultColdkey, s.hotkey, a.bitAdapter, WALLET, WALLET, s.minDirectDeposit, BigInt(base.CHAIN_ID), a.frontDoor],
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
      label: "make the test wallet the vault's keeper",
      to: a.vault,
      abi: CONFIG_ABI.setKeeper,
      functionName: "setKeeper",
      args: [WALLET],
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

/** The v3 deployment from the wallet's current nonces. Base first: the adapter, the oracle, the front
 * door (which takes USDC), the staker (which reads the front door's tokens, so after it), then the
 * front door's keeper, swapper, oracle and batch value and the staker's route, delivery route and fees.
 * Then Bittensor as in v2, staking with tao.bot, and the vault's reward cut to the treasury. The test
 * wallet is owner, guardian, keeper and treasury. */
export function buildPlanV3(baseNonce: number, bitNonce: number, vaultColdkey: Hex): PlanV3 {
  const s = SETTINGS_V3;
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
    frontDoorStep(n + 2, [...frontDoorArgs(addresses, s), BASE_V3.USDC]),
    {
      id: "staker",
      kind: "create",
      chain: "base",
      nonce: n + 3,
      label: "deploy the staker",
      contract: "src/CascadeStaker.sol:CascadeStaker",
      args: [BASE_V3.USDC, LIVE.base.TOKEN, addresses.frontDoor, WALLET, s.treasury],
    },
    call("fdSetKeeper", n + 4, "make the test wallet the front door's keeper", addresses.frontDoor, "setKeeper", [WALLET]),
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
    ...bittensorSteps(bitNonce, addresses, vaultColdkey, s),
    {
      id: "setRewardCut",
      kind: "call",
      chain: "bittensor",
      nonce: bitNonce + 6,
      label: `cut ${s.rewardCutBps / 100}% of rewards to the treasury`,
      to: addresses.vault,
      abi: CONFIG_ABI.setRewardCut,
      functionName: "setRewardCut",
      args: [s.treasury, s.rewardCutBps],
    },
  ];
  return { version: 3, baseNonce, bitNonce, addresses, steps };
}
