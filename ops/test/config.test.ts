import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BASE_V3, deploymentName, isV3Deployment, LIVE, paths, recordPath, SETTINGS, SETTINGS_V3, SETTINGS_V3_LAUNCH, targets, WALLET } from "../src/config.ts";
import { decodeSs58, encodeSs58 } from "../src/ss58.ts";

const forkBase = readFileSync(new URL("../../contracts/test/fork/ForkBase.sol", import.meta.url), "utf8");
const constant = (name: string) => forkBase.match(new RegExp(`${name} = (\\w+);`))?.[1];
const forkV3 = readFileSync(new URL("../../contracts/test/fork/BaseForkV3.t.sol", import.meta.url), "utf8");
const constantV3 = (name: string) => forkV3.match(new RegExp(`${name} = (\\w+);`))?.[1];

describe("v3 config", () => {
  it("names the record after OPS_DEPLOYMENT, and without it keeps the v2 records", () => {
    const dir = paths({}).deploymentsDir;
    expect(recordPath({}, true)).toBe(join(dir, "test-2026-10.json"));
    expect(recordPath({}, false)).toBe(join(dir, "rehearsal.json"));
    expect(recordPath({ OPS_DEPLOYMENT: "" }, true)).toBe(join(dir, "test-2026-10.json"));
    expect(recordPath({ OPS_DEPLOYMENT: "v3-test" }, true)).toBe(join(dir, "v3-test.json"));
    expect(recordPath({ OPS_DEPLOYMENT: "v3-test" }, false)).toBe(join(dir, "rehearsal-v3-test.json"));
    expect(deploymentName({})).toBe("test-2026-10");
  });

  it("plans v3 only for a deployment named v3…", () => {
    expect(isV3Deployment({})).toBe(false);
    expect(isV3Deployment({ OPS_DEPLOYMENT: "test-2026-10" })).toBe(false);
    expect(isV3Deployment({ OPS_DEPLOYMENT: "v3-test" })).toBe(true);
  });

  it("refuses a deployment name that could leave the deployments folder", () => {
    for (const bad of ["../v3-test", "v3/../../x", "..\\x", ".hidden", "v3 test"]) {
      expect(() => recordPath({ OPS_DEPLOYMENT: bad }, true), bad).toThrow(/OPS_DEPLOYMENT/);
    }
  });

  it("holds the v3 test settings: launch values except a 10-minute batch and a 1-hour payout delay", () => {
    expect(SETTINGS_V3.minDeposit).toBe(40_000_000_000_000_000n);
    expect(SETTINGS_V3.depositCap).toBe(40_000_000_000_000_000_000n);
    expect(SETTINGS_V3.maxBatchValue).toBe(10_000_000_000_000_000_000n);
    expect(SETTINGS_V3.batchInterval).toBe(600);
    expect(SETTINGS_V3.payoutDelay).toBe(3600);
    expect(SETTINGS_V3.redeemRequestFee).toBe(100_000_000_000_000n);
    expect(SETTINGS_V3.rewardCutBps).toBe(1_000);
    expect(SETTINGS_V3.treasury).toBe(WALLET);
    expect(SETTINGS_V3.swapFeeBps).toBe(15);
    expect(SETTINGS_V3.depositFeeUsdc).toBe(50_000n);
    expect(SETTINGS_V3.maxDeliverySlippageBps).toBe(150);
    // unchanged from v2: the reserves; the payout gas and the delivery gas toward Bittensor are raised
    expect(SETTINGS_V3.baseGas).toEqual({ base: 720_000n, perEntry: 29_500n });
    expect(SETTINGS.baseGas).toEqual({ base: 540_000n, perEntry: 26_450n });
    expect(SETTINGS_V3.bitGas).toEqual({ base: 170_000n, perEntry: 29_900n });
    expect(SETTINGS.bitGas).toEqual({ base: 120_000n, perEntry: 29_900n });
    expect([SETTINGS_V3.adapterReserve, SETTINGS_V3.vaultReserve]).toEqual([SETTINGS.adapterReserve, SETTINGS.vaultReserve]);
  });

  it("asks for the delivery gas toward Bittensor that contracts/test/adapters/AdapterGas.t.sol calibrates, and at least its gas toward Base", () => {
    const gasTest = readFileSync(new URL("../../contracts/test/adapters/AdapterGas.t.sol", import.meta.url), "utf8");
    const calibrated = (name: string) => {
      const m = gasTest.match(new RegExp(`constant ${name} = ([\\d_]+);`));
      if (!m) throw new Error(name);
      return BigInt(m[1].replaceAll("_", ""));
    };
    expect(SETTINGS_V3.baseGas).toEqual({ base: calibrated("GAS_BASE_TO_BITTENSOR"), perEntry: calibrated("GAS_PER_ENTRY_TO_BITTENSOR") });
    expect(SETTINGS_V3.bitGas.base >= calibrated("GAS_BASE_TO_BASE")).toBe(true);
    expect(SETTINGS_V3.bitGas.perEntry >= calibrated("GAS_PER_ENTRY_TO_BASE")).toBe(true);
    // the launch asks the same
    expect(SETTINGS_V3_LAUNCH.baseGas).toEqual(SETTINGS_V3.baseGas);
    expect(SETTINGS_V3_LAUNCH.bitGas).toEqual(SETTINGS_V3.bitGas);
  });

  it("stakes with tao.bot's hotkey", () => {
    expect(SETTINGS_V3.hotkey).toBe("0x56a9aee6291bd03ab6d36d4d13e2bebae7cd403518066c72fba1b417d6ddd748");
    expect(decodeSs58("5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u")).toBe(SETTINGS_V3.hotkey);
    expect(encodeSs58(SETTINGS_V3.hotkey)).toBe("5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u");
    expect(SETTINGS.hotkey).not.toBe(SETTINGS_V3.hotkey);
  });

  it("copies the Base tokens, pools and router from the plan and BaseForkV3.t.sol", () => {
    expect(BASE_V3).toEqual({
      USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      WETH: "0x4200000000000000000000000000000000000006",
      TAO_WETH_POOL: "0x82dD34C6631C286cDD1dB16f2c232f60E402Dd5A",
      WETH_USDC_POOL: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
      SWAP_ROUTER_02: "0x2626664c2603336E57B271c5C0b26F421741e481",
      QUOTER_V2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    });
    expect(BASE_V3.QUOTER_V2).toBe(constantV3("QUOTER_V2"));
    expect(BASE_V3.USDC).toBe(constantV3("BASE_USDC"));
    expect(BASE_V3.WETH).toBe(constantV3("BASE_WETH"));
    expect(BASE_V3.TAO_WETH_POOL).toBe(constantV3("TAO_WETH_POOL"));
    expect(BASE_V3.WETH_USDC_POOL).toBe(constantV3("WETH_USDC_POOL"));
    expect(BASE_V3.SWAP_ROUTER_02).toBe(constantV3("SWAP_ROUTER_02"));
  });
});

describe("config", () => {
  it("copies the live constants from ForkBase.sol", () => {
    expect(LIVE.base.SELECTOR).toBe(15971525489660198786n);
    expect(LIVE.bittensor.SELECTOR).toBe(2135107236357186872n);
    expect(LIVE.bittensor.ROUTER).toBe(constant("BIT_ROUTER"));
    expect(LIVE.base.ROUTER).toBe(constant("BASE_ROUTER"));
    expect(LIVE.base.TOKEN).toBe(constant("BASE_TAO"));
    expect(LIVE.bittensor.TOKEN).toBe(constant("BIT_TAO"));
    expect(LIVE.base.OFFRAMP).toBe(constant("BASE_OFFRAMP"));
    expect(LIVE.bittensor.OFFRAMP).toBe(constant("BIT_OFFRAMP"));
    expect(LIVE.base.POOL).toBe(constant("BASE_POOL"));
    expect(LIVE.ALPHA_VAULT).toBe(constant("ALPHA_VAULT"));
  });

  it("holds the spec's test settings", () => {
    expect(SETTINGS.depositCap).toBe(150000000000000000n);
    expect(SETTINGS.payoutDelay).toBe(3600);
    expect(SETTINGS.batchInterval).toBe(600);
    expect(SETTINGS.baseGas).toEqual({ base: 540_000n, perEntry: 26_450n });
    expect(SETTINGS.bitGas).toEqual({ base: 120_000n, perEntry: 29_900n });
    expect(SETTINGS.vaultReserve).toBe(1_500_000_000_000n);
  });

  it("points the rehearsal at local forks with their own chain ids", () => {
    const t = targets({});
    expect(t.rehearsal.bittensor.chainId).toBe(31338);
    expect(t.rehearsal.base.chainId).toBe(31337);
    expect(t.live.base.chainId).toBe(8453);
    expect(t.live.bittensor.legacy).toBe(true);
    expect(t.live.base.legacy).toBe(false);
    expect(targets({ OPS_BASE_RPC: "https://x" }).live.base.rpcUrl).toBe("https://x");
  });

  it("reads Bittensor from OpenTensor's archive node by default: the lite node keeps only minutes of logs", () => {
    expect(targets({}).live.bittensor.rpcUrl).toBe("https://archive.chain.opentensor.ai");
    expect(targets({ OPS_BITTENSOR_RPC: "https://y" }).live.bittensor.rpcUrl).toBe("https://y");
  });

  it("finds the key material by path only, never the other keystore", () => {
    expect(paths({ OPS_PASSWORD_FILE: "x" }).passwordFile).toBe("x");
    expect(JSON.stringify(paths({}))).not.toContain("sf-mainnet");
    expect(paths({}).keystore).toMatch(/9ffde5b1-4193-4175-9eb3-a26f9d027214$/);
  });
});
