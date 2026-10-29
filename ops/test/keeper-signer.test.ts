import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, type Hex, numberToHex } from "viem";
import { describe, expect, it } from "vitest";
import { paths, WALLET } from "../src/config.ts";
import { claim, close, deliver, payouts, requireReady, roll, stake } from "../src/keeper/actions.ts";
import { keeperSigner, requireKeeperKey, separateKeeper } from "../src/keeper/signer.ts";
import { DELIVERY_READ_ABIS, keeperDeps, REWARD_READ_ABIS } from "../src/keeper/state.ts";
import { buildPlanV3 } from "../src/plan.ts";
import type { Ctx } from "../src/send.ts";
import { type Answer, COLDKEY, fakeChain, stubDeps, v3Record } from "./fake-keeper.ts";
import { ROLES, ROLES_ENV } from "./launch-roles.ts";

const KEEPER = ROLES.keeper;
const launch = v3Record("live", buildPlanV3(0, 0, COLDKEY, "launch", ROLES));
const p = paths({});
const KEYS = { OPS_KEEPER_KEYSTORE: "/keys/keeper.json", OPS_KEEPER_PASSWORD_FILE: "/keys/keeper.pw" };

describe("the keeper commands sign as the record's keeper", () => {
  it("with OPS_KEEPER_KEYSTORE and OPS_KEEPER_PASSWORD_FILE, as the record's keeper; without, as the test wallet", () => {
    expect(keeperSigner(KEYS, p, launch.plan)).toEqual({ address: KEEPER, keystore: "/keys/keeper.json", passwordFile: "/keys/keeper.pw", name: "the keeper" });
    expect(keeperSigner({}, p, launch.plan)).toEqual({ address: WALLET, keystore: p.keystore, passwordFile: p.passwordFile, name: "the test wallet" });
    // the test cadence's keeper is the test wallet, whichever key signs for it
    expect(keeperSigner(KEYS, p, v3Record().plan).address).toBe(WALLET);
    expect(() => keeperSigner({ OPS_KEEPER_KEYSTORE: "/k.json" }, p, launch.plan)).toThrow(/set both OPS_KEEPER_KEYSTORE and OPS_KEEPER_PASSWORD_FILE/);
    expect(() => keeperSigner({ OPS_KEEPER_PASSWORD_FILE: "/k.pw" }, p, launch.plan)).toThrow(/set both/);
  });

  it("refuses to act when the record's keeper isn't who the keeper commands sign as, naming the variables", () => {
    const wrong = new RegExp(`the record's keeper is ${KEEPER}, but the keeper commands sign as ${WALLET}: set OPS_KEEPER_KEYSTORE and OPS_KEEPER_PASSWORD_FILE to the keeper's key`);
    expect(() => requireReady(launch, WALLET)).toThrow(wrong);
    expect(() => requireReady(launch, KEEPER)).not.toThrow();
    expect(() => requireReady(v3Record(), WALLET)).not.toThrow();
  });

  it("every keeper command checks it before sending: close, roll, stake, payouts, claim and deliver", async () => {
    const sent: string[] = [];
    const deps = stubDeps({ signer: WALLET, sendCall: async (r) => (sent.push(r.functionName), { hash: `0x${"ee".repeat(32)}` as Hex, block: 1, gasUsed: 1n, costWei: 1n }) });
    const runs: [string, () => Promise<unknown>][] = [
      ["close", () => close(deps, launch)],
      ["roll", () => roll(deps, launch)],
      ["stake", () => stake(deps, launch)],
      ["payouts", () => payouts(deps, launch, `0x${"aa".repeat(32)}`)],
      ["claim", () => claim(deps, launch, { claimCostTao: 1n, claimMultiple: 1n, monthlyClaimMaxUsd: 1 })],
      ["deliver", () => deliver(deps, launch, WALLET)],
    ];
    for (const [name, run] of runs) await expect(run(), name).rejects.toThrow(/the record's keeper is/);
    expect(sent).toEqual([]);
  });

  it("run checks first that the keystore really signs as the keeper", async () => {
    const ctx = (signs: string, code = 0) =>
      ({ paths: p, runner: { run: async () => ({ code, stdout: `${signs}\n`, stderr: "" }) }, signer: keeperSigner(KEYS, p, launch.plan) }) as unknown as Ctx;
    await expect(requireKeeperKey(ctx(KEEPER), launch)).resolves.toBeUndefined();
    await expect(requireKeeperKey(ctx(WALLET), launch)).rejects.toThrow(
      `the keeper's keystore /keys/keeper.json signs as ${WALLET}, not the record's keeper ${KEEPER}: set OPS_KEEPER_KEYSTORE and OPS_KEEPER_PASSWORD_FILE to the keeper's key; nothing sent`,
    );
    await expect(requireKeeperKey(ctx("", 1), launch)).rejects.toThrow(/signs as no account \(it can't be opened\)/);
  });

  it("run stops at once when the record's keeper isn't who it signs as, even with the default keystore, before opening it", async () => {
    const opened: string[][] = [];
    const ctx = { paths: p, runner: { run: async (_f: string, args: string[]) => (opened.push(args), { code: 0, stdout: `${WALLET}\n`, stderr: "" }) } } as unknown as Ctx;
    await expect(requireKeeperKey(ctx, launch)).rejects.toThrow(
      `the record's keeper is ${KEEPER}, but the keeper commands sign as ${WALLET}: set OPS_KEEPER_KEYSTORE and OPS_KEEPER_PASSWORD_FILE to the keeper's key; nothing sent`,
    );
    expect(opened).toEqual([]);
    // a test record's keeper is the test wallet, which the default keystore signs as
    await expect(requireKeeperKey(ctx, v3Record())).resolves.toBeUndefined();
  });
});

describe("the keeper's reads follow its signer", () => {
  it("its nonces, balances, claim balance and delivery simulation are the keeper's", async () => {
    const nonceOf: string[] = [];
    const balanceOf: string[] = [];
    const callsFrom: (Hex | undefined)[] = [];
    const answers: Record<string, Answer> = {
      stakeHotkey: () => `0x${"11".repeat(32)}`,
      getUnclaimedRootTaoByHotkey: () => 0n,
      lastClaimAt: () => 0n,
      claimGasRequired: () => 55_000_000n,
      quoteExactInput: () => [250_000_000n, [], [], 0n],
      claimable: () => 10n ** 16n,
      deliver: (_a, c) => (callsFrom.push(c.from), 1n),
    };
    const f = fakeChain([...Object.values(DELIVERY_READ_ABIS), ...Object.values(REWARD_READ_ABIS)], answers, {
      eth_getTransactionCount: (_c, params) => (nonceOf.push(params[0] as string), numberToHex(3)),
      eth_getBalance: (_c, params) => (balanceOf.push(params[0] as string), "0x0"),
      eth_gasPrice: () => "0x1",
    });
    const deps = keeperDeps({ ...f.ctx, signer: keeperSigner(KEYS, p, launch.plan) }, launch, join(mkdtempSync(join(tmpdir(), "ops-ks-")), "r.json"));
    expect(deps.signer).toBe(KEEPER);
    await deps.nonce("base");
    await deps.readRewards();
    await deps.simulateDeliver(WALLET as Address, 1n);
    expect(nonceOf).toEqual([KEEPER]);
    expect(balanceOf).toEqual([KEEPER]);
    expect(callsFrom).toEqual([KEEPER]);
  });
});

describe("the separate keeper key budget and preflight check", () => {
  it("is the record's keeper (else a launch's from the environment) when OPS_KEEPER_KEYSTORE is set and it isn't the test wallet", () => {
    expect(separateKeeper({}, launch.plan)).toBeUndefined();
    expect(separateKeeper(KEYS, launch.plan)).toBe(KEEPER);
    expect(separateKeeper(KEYS, v3Record().plan)).toBeUndefined();
    expect(separateKeeper({ ...KEYS, ...ROLES_ENV, OPS_CADENCE: "launch" }, undefined)).toBe(KEEPER);
    expect(separateKeeper(KEYS, undefined)).toBeUndefined();
  });
});
