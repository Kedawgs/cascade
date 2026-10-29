import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ROLES } from "./launch-roles.ts";
import { WALLET, WALLET_SS58 } from "../src/config.ts";
import { buildPlan, buildPlanV3, settingsV3Of } from "../src/plan.ts";
import type { DeploymentRecord } from "../src/record.ts";
import { decodeSs58, encodeSs58 } from "../src/ss58.ts";
import { webEnv } from "../src/webconfig.ts";

const COLDKEY: Hex = "0x9214633d20bb6247cb0475ea91ae10665a084404a04147ea48f673571263ad68";
const plan = buildPlan(0, 0, COLDKEY);
const sent = (block: number) => ({ hash: `0x${"ab".repeat(32)}` as Hex, block, gasUsed: 1n, costWei: 1n });
const rec: DeploymentRecord = {
  target: "live",
  wallet: WALLET,
  createdAt: "",
  plan,
  done: { baseAdapter: { recovered: true }, frontDoor: sent(100), bitAdapter: sent(9_357_492), vault: sent(9_357_493) },
  verify: { ok: true, failures: [], checkedAt: "" },
};

describe("web-config", () => {
  it("encodes SS58 addresses back to what they decode from", () => {
    expect(encodeSs58(decodeSs58(WALLET_SS58))).toBe(WALLET_SS58);
    expect(encodeSs58(decodeSs58("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"))).toBe(
      "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    );
    expect(encodeSs58(COLDKEY)).toBe("5FNEuRkKZvg2jFjhY3DWpC3TBSH51AC3FKQpLyC1xesTBwLu");
  });

  it("writes the deployment's addresses, the Bittensor deploy block and the SS58 names", () => {
    expect(webEnv(rec).split("\n")).toEqual([
      "# Written by `pnpm ops web-config`: the live test deployment. Local only (git-ignored).",
      `NEXT_PUBLIC_CASCADE_FRONT_DOOR=${plan.addresses.frontDoor}`,
      `NEXT_PUBLIC_CASCADE_BASE_ADAPTER=${plan.addresses.baseAdapter}`,
      `NEXT_PUBLIC_CASCADE_VAULT=${plan.addresses.vault}`,
      `NEXT_PUBLIC_CASCADE_BIT_ADAPTER=${plan.addresses.bitAdapter}`,
      "NEXT_PUBLIC_CASCADE_BIT_BLOCK=9357492",
      "NEXT_PUBLIC_CASCADE_VAULT_SS58=5FNEuRkKZvg2jFjhY3DWpC3TBSH51AC3FKQpLyC1xesTBwLu",
      "NEXT_PUBLIC_CASCADE_HOTKEY_SS58=5E4z3h9yVhmQyCFWNbY9BPpwhx4xFiPwq3eeqmBgVF6KULde",
      "",
    ]);
  });

  it("adds the staker and the oracle for a v3 deployment, and names tao.bot as the validator", () => {
    const plan3 = buildPlanV3(0, 40, COLDKEY);
    const lines = webEnv({ ...rec, plan: plan3 }).split("\n");
    expect(lines).toEqual([
      "# Written by `pnpm ops web-config`: the live test deployment. Local only (git-ignored).",
      `NEXT_PUBLIC_CASCADE_FRONT_DOOR=${plan3.addresses.frontDoor}`,
      `NEXT_PUBLIC_CASCADE_BASE_ADAPTER=${plan3.addresses.baseAdapter}`,
      `NEXT_PUBLIC_CASCADE_STAKER=${plan3.addresses.staker}`,
      `NEXT_PUBLIC_CASCADE_ORACLE=${plan3.addresses.oracle}`,
      `NEXT_PUBLIC_CASCADE_VAULT=${plan3.addresses.vault}`,
      `NEXT_PUBLIC_CASCADE_BIT_ADAPTER=${plan3.addresses.bitAdapter}`,
      "NEXT_PUBLIC_CASCADE_BIT_BLOCK=9357492",
      "NEXT_PUBLIC_CASCADE_VAULT_SS58=5FNEuRkKZvg2jFjhY3DWpC3TBSH51AC3FKQpLyC1xesTBwLu",
      "NEXT_PUBLIC_CASCADE_HOTKEY_SS58=5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u",
      "NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S=3600",
      "",
    ]);
  });

  it("writes the vault's payout delay for every v3 plan, from the plan's own cadence", () => {
    const test3 = buildPlanV3(0, 40, COLDKEY);
    const launch3 = buildPlanV3(0, 40, COLDKEY, "launch", ROLES);
    expect(webEnv({ ...rec, plan: test3 })).toContain(`\nNEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S=${settingsV3Of(test3).payoutDelay}\n`);
    expect(settingsV3Of(test3).payoutDelay).toBe(3_600);
    // a launch goes public once its final owners have accepted
    const launch = webEnv({ ...rec, plan: launch3, verify: { ok: true, failures: [], checkedAt: "", handoff: "accepted" } }).split("\n");
    expect(launch).toContain("NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S=86400");
    expect(launch).toContain("NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S=86400");
    expect(webEnv(rec)).not.toContain("PAYOUT_DELAY");
  });

  it("takes a recovered Bittensor adapter's block as deploy found it, and refuses one without", () => {
    expect(webEnv({ ...rec, done: { ...rec.done, bitAdapter: { recovered: true, block: 9_357_490 } } })).toContain("\nNEXT_PUBLIC_CASCADE_BIT_BLOCK=9357490\n");
    expect(() => webEnv({ ...rec, done: { ...rec.done, bitAdapter: { recovered: true } } })).toThrow(/deploy block is not in the record/);
    expect(() => webEnv({ ...rec, done: { ...rec.done, bitAdapter: { recovered: true, block: undefined } } })).toThrow(/deploy block is not in the record/);
  });

  it("refuses a deployment whose read-back has not passed", () => {
    expect(() => webEnv({ ...rec, verify: undefined })).toThrow(/verify/);
    expect(() => webEnv({ ...rec, verify: { ok: false, failures: ["x"], checkedAt: "" } })).toThrow(/verify/);
  });
});
