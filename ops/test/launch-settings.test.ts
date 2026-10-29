import { type AbiFunction, encodeFunctionData, type Hex, parseEther, toFunctionSignature } from "viem";
import { describe, expect, it } from "vitest";
import { loadArtifact } from "../src/artifacts.ts";
import { LAUNCH_VAULT_LIMITS, paths, SETTINGS_V3, SETTINGS_V3_LAUNCH, VAULT_DEFAULTS } from "../src/config.ts";
import { effectPresent } from "../src/deploy.ts";
import { buildPlanV3, vaultLimitsOf } from "../src/plan.ts";
import { limitExpectations } from "../src/verify.ts";
import { type Answer, COLDKEY, fakeChain } from "./fake-keeper.ts";
import { ROLES } from "./launch-roles.ts";

const L = LAUNCH_VAULT_LIMITS;
const TAO = 10n ** 18n;
const launch = buildPlanV3(4, 9, COLDKEY, "launch", ROLES);
const test = buildPlanV3(4, 9, COLDKEY);
const step = (id: string) => launch.steps.find((s) => s.id === id)!;

/** The vault's daily allowance per front door for a vault of `gross` (CascadeVault._burnRedeems). */
const allowance = (gross: bigint) => {
  const pct = (gross * BigInt(L.maxDailyOutflowBps)) / 10_000n;
  return pct > L.minDailyOutflow ? pct : L.minDailyOutflow;
};
/** Daily windows a holder of `holding` needs to leave a vault of `gross` when nobody else redeems: each
 * window burns the smaller of the allowance and one entry's limit (a request asks for everything left). */
function windowsToExit(holding: bigint, gross: bigint): number {
  let n = 0;
  for (let left = holding, g = gross; left > 0n; n++) {
    let burn = allowance(g) < L.maxEntryValue ? allowance(g) : L.maxEntryValue;
    if (burn > left) burn = left;
    left -= burn;
    g -= burn;
  }
  return n;
}

describe("the launch's vault limits, sized for a 40 TAO deposit cap", () => {
  it("are these values", () => {
    expect(L).toEqual({
      maxDailyOutflowBps: 2_000n,
      minDailyOutflow: 10n * TAO,
      maxEntryValue: 10n * TAO,
      maxMessageValue: 15n * TAO,
      minChunk: 10,
      maxFeeBps: 100n,
      maxFeeAbs: parseEther("0.005"),
      maxTotalAssets: 44n * TAO,
    });
    expect(SETTINGS_V3_LAUNCH.depositCap).toBe(40n * TAO);
    // the redeem request fee is kept
    expect(SETTINGS_V3_LAUNCH.redeemRequestFee).toBe(SETTINGS_V3.redeemRequestFee);
    expect(SETTINGS_V3_LAUNCH.redeemRequestFee).toBe(10n ** 14n);
  });

  it("are values setters accept: entry within message, 1 to 100 entries a chunk, bps at most 100%", () => {
    expect(L.maxEntryValue <= L.maxMessageValue).toBe(true);
    expect(L.minChunk >= 1 && L.minChunk <= 100).toBe(true);
    expect(L.maxDailyOutflowBps <= 10_000n && L.maxFeeBps <= 10_000n).toBe(true);
  });

  it("bound a forced exit to a quarter of a 40-60 TAO vault a day (the old 100 TAO floor was all of it)", () => {
    for (const vault of [40n, 50n, 60n]) {
      const a = allowance(vault * TAO);
      expect(a * 4n <= vault * TAO, `${vault} TAO`).toBe(true);
      expect(VAULT_DEFAULTS.minDailyOutflow >= vault * TAO, `${vault} TAO`).toBe(true);
    }
  });

  it("still let one holder of the whole 40 TAO cap leave within 4 daily windows", () => {
    expect(windowsToExit(40n * TAO, 40n * TAO)).toBe(4);
    expect(windowsToExit(40n * TAO, 60n * TAO)).toBe(4);
    expect(windowsToExit(10n * TAO, 50n * TAO)).toBe(1);
  });

  it("cap direct deposits a little above the deposit cap", () => {
    expect(L.maxTotalAssets > SETTINGS_V3_LAUNCH.depositCap).toBe(true);
    expect(L.maxTotalAssets * 10n <= SETTINGS_V3_LAUNCH.depositCap * 12n).toBe(true);
  });

  it("keep a payout message near the batch size, and room for a day's allowance in one", () => {
    expect(L.maxMessageValue >= SETTINGS_V3_LAUNCH.maxBatchValue).toBe(true);
    expect(L.maxMessageValue <= 2n * SETTINGS_V3_LAUNCH.maxBatchValue).toBe(true);
    expect(L.maxMessageValue >= allowance(60n * TAO)).toBe(true);
  });

  it("cap the payout fee at about 5 times the live fee, an eighth of a minimum deposit", () => {
    const liveFee = parseEther("0.00105");
    expect(L.maxFeeAbs >= 4n * liveFee).toBe(true);
    expect(L.maxFeeAbs * 8n <= SETTINGS_V3_LAUNCH.minDeposit).toBe(true);
  });
});

describe("a launch sets them during deploy and verify checks them", () => {
  it("sets the four limits on the vault after the reward cut and before the hand-off", () => {
    const bit = launch.steps.filter((s) => s.chain === "bittensor").map((s) => s.id);
    expect(bit.slice(-6)).toEqual(["setRewardCut", "setOutflowLimits", "setMaxTotalAssets", "setMessageLimits", "setFeeLimits", "vaultTransferOwnership"]);
    const calls = ["setOutflowLimits", "setMaxTotalAssets", "setMessageLimits", "setFeeLimits"].map((id) => {
      const s = step(id);
      return s.kind === "call" && [s.to, s.functionName, s.args];
    });
    expect(calls).toEqual([
      [launch.addresses.vault, "setOutflowLimits", [L.maxDailyOutflowBps, L.minDailyOutflow]],
      [launch.addresses.vault, "setMaxTotalAssets", [L.maxTotalAssets]],
      [launch.addresses.vault, "setMessageLimits", [L.maxEntryValue, L.maxMessageValue, L.minChunk]],
      [launch.addresses.vault, "setFeeLimits", [L.maxFeeBps, L.maxFeeAbs]],
    ]);
    expect(step("setOutflowLimits").label).toBe("let redeems burn at most 20% of the vault a day, or 10 TAO when that is more");
    expect(test.steps.some((s) => s.id === "setOutflowLimits")).toBe(false);
  });

  it("each limit step encodes against the vault's build", () => {
    const vault = loadArtifact(paths({}).contractsDir, "CascadeVault").abi.filter((i): i is AbiFunction => i.type === "function").map((i) => toFunctionSignature(i));
    for (const id of ["setOutflowLimits", "setMaxTotalAssets", "setMessageLimits", "setFeeLimits", "vaultTransferOwnership"]) {
      const s = step(id);
      if (s.kind !== "call") throw new Error(id);
      expect(() => encodeFunctionData({ abi: s.abi, functionName: s.functionName, args: s.args } as never), id).not.toThrow();
      const fn = s.abi.find((i) => i.type === "function" && i.name === s.functionName) as AbiFunction;
      expect(vault, id).toContain(toFunctionSignature(fn));
    }
  });

  it("verify expects the launch's limits, and the defaults for a test plan", () => {
    const at = (plan: typeof launch, f: string) => limitExpectations(plan).find((e) => e.field === f)?.expected;
    expect(vaultLimitsOf(launch)).toEqual({ ...VAULT_DEFAULTS, ...L });
    expect(vaultLimitsOf(test)).toBe(VAULT_DEFAULTS);
    expect(at(launch, "minDailyOutflow")).toBe(10n * TAO);
    expect(at(launch, "maxFeeAbs")).toBe(parseEther("0.005"));
    expect(at(launch, "claimGasRequired")).toBe(VAULT_DEFAULTS.claimGasRequired);
    expect(at(test, "minDailyOutflow")).toBe(100n * TAO);
  });

  it("deploy finds each limit already set by reading it back", async () => {
    const ctx = (over: Record<string, unknown>) => {
      const values: Record<string, unknown> = { ...VAULT_DEFAULTS, ...over };
      const answers = Object.fromEntries(Object.keys(VAULT_DEFAULTS).map((k) => [k, (() => values[k]) as Answer]));
      return fakeChain([loadArtifact(paths({}).contractsDir, "CascadeVault").abi], answers, { eth_getCode: () => "0x6080" as Hex }).ctx;
    };
    for (const id of ["setOutflowLimits", "setMaxTotalAssets", "setMessageLimits", "setFeeLimits"]) {
      expect(await effectPresent(ctx({}), launch, step(id)), id).toBe(false);
      expect(await effectPresent(ctx(L), launch, step(id)), id).toBe(true);
    }
  });
});
