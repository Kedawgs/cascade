import { type AbiFunction, encodeDeployData, encodeFunctionData, getContractAddress, type Hex, toFunctionSignature } from "viem";
import { describe, expect, it } from "vitest";
import { loadArtifact } from "../src/artifacts.ts";
import { LIVE, PRECOMPILE, paths, SETTINGS, WALLET } from "../src/config.ts";
import { buildPlan, buildPlanV3, isPlanV3 } from "../src/plan.ts";
import { castArg } from "../src/send.ts";

const coldkey: Hex = "0x9214633d20bb6247cb0475ea91ae10665a084404a04147ea48f673571263ad68";
const at = (nonce: number) => getContractAddress({ from: WALLET, nonce: BigInt(nonce) });

describe("buildPlan", () => {
  // different nonces on the two chains, so a chain mix-up cannot pass by coincidence
  const plan = buildPlan(3, 5, coldkey);
  const step = (id: string) => plan.steps.find((s) => s.id === id)!;

  it("predicts each address from its own chain's nonce", () => {
    expect(plan.addresses).toEqual({ baseAdapter: at(3), frontDoor: at(4), bitAdapter: at(5), vault: at(6) });
  });

  it("orders the steps and their nonces as the spec's table", () => {
    expect(plan.steps.map((s) => s.id)).toEqual([
      "baseAdapter",
      "frontDoor",
      "bitAdapter",
      "vault",
      "adapterReserve",
      "vaultReserve",
      "setKeeper",
      "setPayoutDelay",
    ]);
    expect(plan.steps.map((s) => s.nonce)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(plan.steps.map((s) => s.chain)).toEqual(["base", "base", ...Array(6).fill("bittensor")]);
  });

  it("wires the Base adapter to the predicted Bittensor adapter with the Base gas model", () => {
    const s = step("baseAdapter");
    expect(s.kind === "create" && s.contract).toBe("src/adapters/CcipBaseAdapter.sol:CcipBaseAdapter");
    expect(s.args).toEqual([
      {
        router: LIVE.base.ROUTER,
        token: LIVE.base.TOKEN,
        localChainId: 8453n,
        remoteChainId: 964n,
        remoteSelector: LIVE.bittensor.SELECTOR,
        remoteAdapter: plan.addresses.bitAdapter,
        gasBase: SETTINGS.baseGas.base,
        gasPerEntry: SETTINGS.baseGas.perEntry,
      },
      SETTINGS.minSendAmount,
    ]);
  });

  it("points the front door at the predicted vault with the test settings", () => {
    expect(step("frontDoor").args).toEqual([
      LIVE.base.TOKEN,
      plan.addresses.baseAdapter,
      964n,
      plan.addresses.vault,
      WALLET,
      WALLET,
      600n,
      SETTINGS.minDeposit,
      SETTINGS.depositCap,
      SETTINGS.redeemRequestFee,
    ]);
  });

  it("wires the Bittensor adapter back to the Base adapter and ForeverMoney's vault", () => {
    expect(step("bitAdapter").args).toEqual([
      {
        router: LIVE.bittensor.ROUTER,
        token: LIVE.bittensor.TOKEN,
        localChainId: 964n,
        remoteChainId: 8453n,
        remoteSelector: LIVE.base.SELECTOR,
        remoteAdapter: plan.addresses.baseAdapter,
        gasBase: SETTINGS.bitGas.base,
        gasPerEntry: SETTINGS.bitGas.perEntry,
      },
      LIVE.ALPHA_VAULT,
    ]);
  });

  it("names the front door as the vault's initial front door", () => {
    expect(step("vault").args).toEqual([
      coldkey,
      SETTINGS.hotkey,
      plan.addresses.bitAdapter,
      WALLET,
      WALLET,
      SETTINGS.minDirectDeposit,
      8453n,
      plan.addresses.frontDoor,
    ]);
  });

  it("funds the reserves and configures the vault", () => {
    const reserve = step("adapterReserve");
    expect(reserve.kind === "call" && [reserve.to, reserve.functionName, reserve.value]).toEqual([
      plan.addresses.bitAdapter,
      "fundReserve",
      1_000_000_000_000n,
    ]);
    const vaultReserve = step("vaultReserve");
    expect(vaultReserve.kind === "call" && [vaultReserve.to, vaultReserve.value, vaultReserve.args]).toEqual([
      PRECOMPILE.balanceTransfer,
      1500000000000n,
      [coldkey],
    ]);
    const keeper = step("setKeeper");
    expect(keeper.kind === "call" && [keeper.to, keeper.args]).toEqual([plan.addresses.vault, [WALLET]]);
    const delay = step("setPayoutDelay");
    expect(delay.kind === "call" && [delay.to, delay.args]).toEqual([plan.addresses.vault, [3600n]]);
  });
});

describe("buildPlanV3", () => {
  // Base needs four creates: a Bittensor nonce far from Base's keeps every address distinct
  const plan = buildPlanV3(3, 20, coldkey);
  const step = (id: string) => plan.steps.find((s) => s.id === id)!;
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const WETH = "0x4200000000000000000000000000000000000006";
  const TAO = "0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67";
  const SWAP_ROUTER_02 = "0x2626664c2603336E57B271c5C0b26F421741e481";
  // tao.bot's hotkey 5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u
  const TAO_BOT: Hex = "0x56a9aee6291bd03ab6d36d4d13e2bebae7cd403518066c72fba1b417d6ddd748";

  it("predicts each address from its own chain's nonce, the oracle and the staker included", () => {
    expect(plan.version).toBe(3);
    expect(plan.addresses).toEqual({
      baseAdapter: at(3),
      oracle: at(4),
      frontDoor: at(5),
      staker: at(6),
      bitAdapter: at(20),
      vault: at(21),
    });
  });

  it("orders the steps and their nonces: Base first, then Bittensor", () => {
    expect(plan.steps.map((s) => s.id)).toEqual([
      "baseAdapter",
      "oracle",
      "frontDoor",
      "staker",
      "fdSetKeeper",
      "fdSetSwapper",
      "fdSetOracle",
      "fdSetMaxBatchValue",
      "stakerSetRoute0",
      "stakerSetDeliveryRoute",
      "stakerSetFees",
      "bitAdapter",
      "vault",
      "adapterReserve",
      "vaultReserve",
      "setKeeper",
      "setPayoutDelay",
      "setRewardCut",
    ]);
    expect(plan.steps.map((s) => s.nonce)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 20, 21, 22, 23, 24, 25, 26]);
    expect(plan.steps.map((s) => s.chain)).toEqual([...Array(11).fill("base"), ...Array(7).fill("bittensor")]);
  });

  it("wires the Base adapter to the predicted Bittensor adapter, as in v2", () => {
    expect(step("baseAdapter").args).toEqual([
      {
        router: LIVE.base.ROUTER,
        token: LIVE.base.TOKEN,
        localChainId: 8453n,
        remoteChainId: 964n,
        remoteSelector: LIVE.bittensor.SELECTOR,
        remoteAdapter: plan.addresses.bitAdapter,
        gasBase: 540_000n,
        gasPerEntry: 26_450n,
      },
      10n ** 16n,
    ]);
  });

  it("deploys the TWAP oracle over the TAO/WETH 0.3% and WETH/USDC 0.05% pools", () => {
    const s = step("oracle");
    expect(s.kind === "create" && s.contract).toBe("src/CascadeTwapOracle.sol:CascadeTwapOracle");
    expect(s.args).toEqual([
      "0x82dD34C6631C286cDD1dB16f2c232f60E402Dd5A",
      "0xd0b53D9277642d899DF5C87A3966A349A798F224",
      TAO,
      WETH,
      USDC,
    ]);
  });

  it("deploys the front door with the v3 test settings and Base USDC last", () => {
    const s = step("frontDoor");
    expect(s.kind === "create" && s.contract).toBe("src/CascadeFrontDoor.sol:CascadeFrontDoor");
    expect(s.args).toEqual([
      TAO,
      plan.addresses.baseAdapter,
      964n,
      plan.addresses.vault,
      WALLET,
      WALLET,
      600n,
      4n * 10n ** 16n,
      40n * 10n ** 18n,
      10n ** 14n,
      USDC,
    ]);
  });

  it("deploys the staker on the front door, owned by the test wallet, which is also the treasury", () => {
    const s = step("staker");
    expect(s.kind === "create" && s.contract).toBe("src/CascadeStaker.sol:CascadeStaker");
    expect(s.args).toEqual([USDC, TAO, plan.addresses.frontDoor, WALLET, WALLET]);
  });

  it("configures the front door: keeper, swapper, oracle and a 10 TAO batch value", () => {
    const calls = ["fdSetKeeper", "fdSetSwapper", "fdSetOracle", "fdSetMaxBatchValue"].map((id) => {
      const s = step(id);
      return s.kind === "call" && [s.to, s.functionName, s.args];
    });
    expect(calls).toEqual([
      [plan.addresses.frontDoor, "setKeeper", [WALLET]],
      [plan.addresses.frontDoor, "setSwapper", [plan.addresses.staker]],
      [plan.addresses.frontDoor, "setOracle", [plan.addresses.oracle]],
      [plan.addresses.frontDoor, "setMaxBatchValue", [10n * 10n ** 18n]],
    ]);
  });

  it("gives the staker route 0, Uniswap's two hops through WETH both ways, and delivers along it", () => {
    const route = step("stakerSetRoute0");
    expect(route.kind === "call" && [route.to, route.functionName, route.args]).toEqual([
      plan.addresses.staker,
      "setRoute",
      [
        0,
        {
          kind: 0,
          router: SWAP_ROUTER_02,
          // USDC | 500 | WETH | 3000 | TAO, and back
          buyPath: `0x${USDC.slice(2)}0001f4${WETH.slice(2)}000bb8${TAO.slice(2)}`.toLowerCase(),
          sellPath: `0x${TAO.slice(2)}000bb8${WETH.slice(2)}0001f4${USDC.slice(2)}`.toLowerCase(),
          active: true,
        },
      ],
    ]);
    const delivery = step("stakerSetDeliveryRoute");
    expect(delivery.kind === "call" && [delivery.to, delivery.functionName, delivery.args]).toEqual([plan.addresses.staker, "setDeliveryRoute", [0]]);
    const fees = step("stakerSetFees");
    expect(fees.kind === "call" && [fees.to, fees.functionName, fees.args]).toEqual([plan.addresses.staker, "setFees", [15, 50_000n]]);
  });

  it("stakes with tao.bot and names the front door as the vault's initial front door", () => {
    expect(step("vault").args).toEqual([
      coldkey,
      TAO_BOT,
      plan.addresses.bitAdapter,
      WALLET,
      WALLET,
      SETTINGS.minDirectDeposit,
      8453n,
      plan.addresses.frontDoor,
    ]);
    expect(step("bitAdapter").args[0]).toMatchObject({ remoteAdapter: plan.addresses.baseAdapter });
  });

  it("funds the reserves, configures the vault and cuts 10% of rewards to the treasury", () => {
    const calls = ["adapterReserve", "vaultReserve", "setKeeper", "setPayoutDelay", "setRewardCut"].map((id) => {
      const s = step(id);
      return s.kind === "call" && [s.to, s.functionName, s.args, s.value];
    });
    expect(calls).toEqual([
      [plan.addresses.bitAdapter, "fundReserve", [], 1_000_000_000_000n],
      [PRECOMPILE.balanceTransfer, "transfer", [coldkey], 1_500_000_000_000n],
      [plan.addresses.vault, "setKeeper", [WALLET], undefined],
      [plan.addresses.vault, "setPayoutDelay", [3600n], undefined],
      [plan.addresses.vault, "setRewardCut", [WALLET, 1_000], undefined],
    ]);
  });

  it("encodes every step against the contracts build", () => {
    const dir = paths({}).contractsDir;
    const contractAt = new Map<string, string>([
      [plan.addresses.frontDoor, "CascadeFrontDoor"],
      [plan.addresses.staker, "CascadeStaker"],
      [plan.addresses.vault, "CascadeVault"],
      [plan.addresses.bitAdapter, "CcipBittensorAdapter"],
    ]);
    for (const s of plan.steps) {
      if (s.kind === "create") {
        const a = loadArtifact(dir, s.contract.split(":")[1]);
        expect(() => encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: s.args } as never), s.id).not.toThrow();
        continue;
      }
      expect(() => encodeFunctionData({ abi: s.abi, functionName: s.functionName, args: s.args } as never), s.id).not.toThrow();
      const name = contractAt.get(s.to);
      if (!name) continue; // the transfer precompile
      const fn = s.abi.find((i) => i.type === "function" && i.name === s.functionName) as AbiFunction;
      const built = loadArtifact(dir, name)
        .abi.filter((i): i is AbiFunction => i.type === "function")
        .map((i) => toFunctionSignature(i));
      expect(built, s.id).toContain(toFunctionSignature(fn));
    }
  });

  it("hands the route to cast as one tuple", () => {
    const s = step("stakerSetRoute0");
    if (s.kind !== "call") throw new Error("not a call");
    const fn = s.abi.find((i) => i.type === "function" && i.name === "setRoute") as AbiFunction;
    const r = s.args[1] as { buyPath: string; sellPath: string };
    expect(castArg(r, fn.inputs[1])).toBe(`(0,${SWAP_ROUTER_02},${r.buyPath},${r.sellPath},true)`);
  });

  it("leaves the v2 plan as it was: no version, no oracle, no staker", () => {
    const v2 = buildPlan(3, 5, coldkey);
    expect("version" in v2).toBe(false);
    expect(Object.keys(v2.addresses)).toEqual(["baseAdapter", "frontDoor", "bitAdapter", "vault"]);
    expect(isPlanV3(v2)).toBe(false);
    expect(isPlanV3(plan)).toBe(true);
  });
});
