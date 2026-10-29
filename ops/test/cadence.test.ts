import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ROLES } from "./launch-roles.ts";
import { CADENCE, cadenceFromEnv, LAUNCH_VAULT_LIMITS, SETTINGS, SETTINGS_V3, SETTINGS_V3_LAUNCH, WALLET } from "../src/config.ts";
import { buildPlan, buildPlanV3, cadenceOf, closeMaxWaitS, settingsOf, settingsV3Of } from "../src/plan.ts";
import type { DeploymentRecord } from "../src/record.ts";
import { expectations } from "../src/verify.ts";
import { webEnv } from "../src/webconfig.ts";

const COLDKEY: Hex = "0x9214633d20bb6247cb0475ea91ae10665a084404a04147ea48f673571263ad68";
const field = (plan: ReturnType<typeof buildPlanV3>, contract: string, f: string) =>
  expectations(plan).find((e) => e.contract === contract && e.field === f)?.expected;

describe("cadence", () => {
  it("reads the cadence from the environment: unset, empty or test is test, launch is launch, anything else throws", () => {
    expect(cadenceFromEnv({ OPS_CADENCE: "launch" })).toBe("launch");
    expect(cadenceFromEnv({ OPS_CADENCE: " launch " })).toBe("launch");
    for (const v of [undefined, "", " ", "test"]) expect(cadenceFromEnv({ OPS_CADENCE: v })).toBe("test");
    for (const v of ["Launch", "fast", "mainnet"]) {
      expect(() => cadenceFromEnv({ OPS_CADENCE: v })).toThrow(`OPS_CADENCE "${v}" is not a cadence: use launch, or leave it unset for test; nothing sent`);
    }
  });

  it("refuses an unrecognised cadence in a record; an absent one is test", () => {
    const bad = { ...buildPlanV3(0, 40, COLDKEY), cadence: "fast" } as unknown as ReturnType<typeof buildPlanV3>;
    expect(() => cadenceOf(bad)).toThrow(/cadence "fast"/);
    expect(() => settingsOf(bad)).toThrow(/cadence "fast"/);
  });

  it("settingsV3Of gives a plan's full v3 settings, and verify's expectations come from them", () => {
    const test = buildPlanV3(0, 40, COLDKEY);
    const launch = buildPlanV3(0, 40, COLDKEY, "launch", ROLES);
    expect(settingsV3Of(test)).toBe(SETTINGS_V3);
    expect(settingsV3Of(launch)).toBe(SETTINGS_V3_LAUNCH);
    expect(() => settingsV3Of(buildPlan(0, 0, COLDKEY) as never)).toThrow(/v2/);
    const exp = expectations(launch);
    const get = (c: string, f: string) => exp.find((e) => e.contract === c && e.field === f)?.expected;
    expect(get("CascadeFrontDoor", "maxBatchValue")).toBe(SETTINGS_V3_LAUNCH.maxBatchValue);
    expect(get("CascadeStaker", "swapFeeBps")).toBe(SETTINGS_V3_LAUNCH.swapFeeBps);
    expect(get("CascadeVault", "rewardCutBps")).toBe(SETTINGS_V3_LAUNCH.rewardCutBps);
  });

  it("launch settings change the batch interval, the payout delay and the vault's limits, and take no treasury from the test settings", () => {
    const { treasury: _, ...rest } = SETTINGS_V3;
    expect(SETTINGS_V3_LAUNCH).toEqual({ ...rest, batchInterval: 3_600, payoutDelay: 86_400, vaultLimits: LAUNCH_VAULT_LIMITS });
    expect("treasury" in SETTINGS_V3_LAUNCH).toBe(false);
    expect(CADENCE.launch.closeMaxWaitS).toBe(86_400);
  });

  it("a plan without a cadence is a test plan, v2 and v3 alike, and keeps SETTINGS_V3 exactly", () => {
    const v3 = buildPlanV3(0, 40, COLDKEY);
    expect("cadence" in v3).toBe(false);
    expect(cadenceOf(v3)).toBe("test");
    expect(cadenceOf(buildPlan(0, 0, COLDKEY))).toBe("test");
    expect(settingsOf(v3)).toBe(SETTINGS_V3);
    expect(settingsOf(buildPlan(0, 0, COLDKEY))).toBe(SETTINGS);
    expect(buildPlanV3(0, 40, COLDKEY, "test")).toEqual(v3);
    expect(field(v3, "CascadeFrontDoor", "batchInterval")).toBe(600n);
    expect(field(v3, "CascadeVault", "payoutDelay")).toBe(3600n);
  });

  it("the keeper's extra close wait is none for test and a day for launch", () => {
    expect(closeMaxWaitS(buildPlanV3(0, 40, COLDKEY))).toBe(0);
    expect(closeMaxWaitS(buildPlan(0, 0, COLDKEY))).toBe(0);
    expect(closeMaxWaitS(buildPlanV3(0, 40, COLDKEY, "launch", ROLES))).toBe(86_400);
  });

  it("a launch plan stores its cadence, builds its steps with the launch values and verifies against them", () => {
    const plan = buildPlanV3(2, 40, COLDKEY, "launch", ROLES);
    expect(plan.cadence).toBe("launch");
    expect(cadenceOf(plan)).toBe("launch");
    expect(settingsOf(plan)).toBe(SETTINGS_V3_LAUNCH);
    const fd = plan.steps.find((s) => s.id === "frontDoor")!;
    expect(fd.args[6]).toBe(3_600n);
    const delay = plan.steps.find((s) => s.id === "setPayoutDelay")!;
    expect(delay.args).toEqual([86_400n]);
    expect(delay.label).toBe("set the payout delay to 24 hours");
    expect(field(plan, "CascadeFrontDoor", "batchInterval")).toBe(3_600n);
    expect(field(plan, "CascadeVault", "payoutDelay")).toBe(86_400n);
    // the treasury is the launch's own (roles), not the test wallet
    expect(field(plan, "CascadeStaker", "treasury")).toBe(ROLES.treasury);
    expect(field(plan, "CascadeStaker", "treasury")).not.toBe(WALLET);
    // the test plan's steps, in order, then the vault's limits and each chain's hand-off of ownership; the same addresses
    const test = buildPlanV3(2, 40, COLDKEY);
    const launchOnly = ["setOutflowLimits", "setMaxTotalAssets", "setMessageLimits", "setFeeLimits"];
    expect(plan.steps.map((s) => s.id).filter((id) => !id.endsWith("TransferOwnership") && !launchOnly.includes(id))).toEqual(test.steps.map((s) => s.id));
    expect(plan.addresses).toEqual(test.addresses);
  });

  it("web-config adds the max-wait line for launch plans only", () => {
    const rec = (plan: DeploymentRecord["plan"]): DeploymentRecord => ({
      target: "live",
      wallet: WALLET,
      createdAt: "",
      plan,
      done: { bitAdapter: { hash: `0x${"ab".repeat(32)}` as Hex, block: 5, gasUsed: 1n, costWei: 1n } },
      verify: { ok: true, failures: [], checkedAt: "" },
    });
    expect(webEnv(rec(buildPlanV3(0, 40, COLDKEY, "launch", ROLES)))).toContain("NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S=86400\n");
    expect(webEnv(rec(buildPlanV3(0, 40, COLDKEY)))).not.toContain("MAX_WAIT");
    expect(webEnv(rec(buildPlanV3(0, 40, COLDKEY, "launch", ROLES))).split("\n")[0]).toBe(
      "# Written by `pnpm ops web-config`: the live launch deployment. Local only (git-ignored).",
    );
    expect(webEnv(rec(buildPlanV3(0, 40, COLDKEY))).split("\n")[0]).toBe(
      "# Written by `pnpm ops web-config`: the live test deployment. Local only (git-ignored).",
    );
    expect(webEnv(rec(buildPlan(0, 0, COLDKEY)))).not.toContain("MAX_WAIT");
  });
});
