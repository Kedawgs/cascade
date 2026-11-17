import { type Address, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.ts";
import { CLAIM_GAP_MAX_S, vestingGapProblem } from "../src/keeper/core/rewards.ts";
import { SETTINGS_V32_LAUNCH } from "../src/v32/settings.ts";
import { paths, targets } from "../src/config.ts";
import { keeperSignerV32 } from "../src/keeper/cast-signer.ts";
import { freshMemory } from "../src/keeper/core/memory.ts";
import { runRound } from "../src/keeper/core/round.ts";
import { targetV32 } from "../src/keeper/core/v32/actions.ts";
import { checkReadyV32, everyRoundProblems } from "../src/keeper/core/v32/readiness.ts";
import type { Ctx } from "../src/send.ts";
import { ADDR, deploymentFor, depsFor, KEY, T, world } from "./keeper-v32-world.ts";

const ADDR_LENS = ADDR.vaultLens;

// Checkpoint R4's ops fixes (r4o-dispatch.md; r4-D-review.md D-M1 and the rest of ops' items).

const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);
const OPTS = { intervalMs: 60_000, policy: { claimCostTao: 57n * 10n ** 15n, claimMultiple: 25n, monthlyClaimMaxUsd: 20 }, rewardsEveryTicks: 1000 };
/** The plan's first keeper, which the record and the Worker's DEPLOYMENT still name after a rotation */
const OLD = at("01d");

describe("D-M1: a keeper key rotation leaves the Worker and the hand runs ready (the key is keeper() on both contracts; the record's keeper is the plan's, shown, never a gate)", () => {
  it("after the runbook's rotation (2.6, 7.4): the record still names the old keeper, keeper() names the new key on both contracts, which signs: ready, and a round sends", async () => {
    const w = world();
    // the open batch past its 24 h max wait: its close is due
    w.door.start = BigInt(T - 2 * 86_400);
    // the world's vault and door name KEY, the new key; the deployment (the record's, DEPLOYMENT's) the old one
    const d = deploymentFor({ keeper: OLD });
    const { deps } = depsFor(w, freshMemory(), d);
    expect(await everyRoundProblems(deps)).toEqual([]);
    await expect(checkReadyV32(deps, freshMemory(), T * 1000)).resolves.toBeUndefined();
    expect(() => targetV32(d).requireReady(KEY.address, deps)).not.toThrow();
    const r = await runRound(deps, targetV32(d), freshMemory(), { ...OPTS, now: () => T * 1000 });
    expect(r.end).toBeUndefined();
    expect(w.sends.map((s) => s.fn)).toEqual(["closeBatch"]);
  });

  it("until both setKeeper calls have landed the new key is refused, each contract named, and nothing is sent", async () => {
    const w = world();
    w.door.keeper = OLD;
    const d = deploymentFor({ keeper: OLD });
    const { deps } = depsFor(w, freshMemory(), d);
    expect(await everyRoundProblems(deps)).toEqual([`the front door's keeper() is ${OLD}, not the keeper's key ${KEY.address} (a rotation not yet signed, or the key revoked)`]);
    const r = await runRound(deps, targetV32(d), freshMemory(), { ...OPTS, now: () => T * 1000 });
    expect(r.end).toBeDefined();
    expect(w.sends).toEqual([]);
  });

  it("a key keeper() doesn't name is refused whatever the record says", async () => {
    const w = world();
    w.vault.keeper = OLD;
    w.door.keeper = OLD;
    const { deps } = depsFor(w, freshMemory(), deploymentFor({ keeper: KEY.address }));
    expect(await everyRoundProblems(deps)).toEqual([
      `the vault's keeper() is ${OLD}, not the keeper's key ${KEY.address} (a rotation not yet signed, or the key revoked)`,
      `the front door's keeper() is ${OLD}, not the keeper's key ${KEY.address} (a rotation not yet signed, or the key revoked)`,
    ]);
  });

  it("a hand run signs as its keystore's own account (cast wallet address), not as the record's keeper", async () => {
    const asked: string[][] = [];
    const ctx = {
      paths: paths({}),
      targets: targets({}).live,
      runner: { run: async (_f: string, args: string[]) => (asked.push(args), { code: 0, stdout: `${KEY.address}\n`, stderr: "" }) },
    } as unknown as Ctx;
    const s = await keeperSignerV32(ctx, { keystore: "Z:/keys/new.json", passwordFile: "Z:/keys/new.pw" });
    expect(s.address).toBe(KEY.address);
    expect(asked[0]).toEqual(["wallet", "address", "--keystore", "Z:/keys/new.json", "--password-file", "Z:/keys/new.pw"]);
    const fails = { ...ctx, runner: { run: async () => ({ code: 1, stdout: "", stderr: "wrong password" }) } } as unknown as Ctx;
    await expect(keeperSignerV32(fails, { keystore: "Z:/keys/new.json", passwordFile: "Z:/keys/new.pw" })).rejects.toThrow(
      "the keystore at OPS_V32_KEEPER_KEYSTORE didn't open with OPS_V32_KEEPER_PASSWORD_FILE (cast wallet address): check both; nothing sent",
    );
  });
});

describe("D-L4: pnpm ops pause --for-wallet --offline parses; --offline only with --for-wallet, and only for the pause", () => {
  it("parses", () => {
    expect(parseArgs(["pause", "both", "--for-wallet", "--offline"])).toMatchObject({ cmd: "pause", target: "both", forWallet: true, offline: true });
    expect(() => parseArgs(["pause", "both", "--offline"])).toThrow("--offline writes the pause's call file with no chain read: add --for-wallet");
    expect(() => parseArgs(["unpause", "both", "--for-wallet", "--offline"])).toThrow(/unexpected argument --offline/);
  });
});

describe("the vault-favour review's Medium 1: rewards vest no faster than the keeper claims", () => {
  it("the launch rewardVesting is 30 days (the contract's maximum), the claim policy's longest gap", () => {
    expect(SETTINGS_V32_LAUNCH.vault.rewardVesting).toBe(2_592_000n);
    expect(CLAIM_GAP_MAX_S).toBe(30 * 86_400);
    expect(vestingGapProblem(SETTINGS_V32_LAUNCH.vault.rewardVesting)).toBeUndefined();
  });

  it("warns when the vault's rewardVesting is shorter than the claim policy's longest gap, at readiness's hourly check, once while it lasts", async () => {
    expect(vestingGapProblem(604_800n)).toBe(
      "the vault's rewardVesting is 7 days, shorter than the claim policy's longest gap between claims (30 days): a holder present only while rewards vest takes more than its share of them. Raise it to at least 30 days (setRewardVesting: a raise is immediate)",
    );
    const w = world();
    w.answers[`${ADDR_LENS.toLowerCase()}:rewardVesting`] = () => 604_800n;
    const lines: string[] = [];
    const m = freshMemory();
    const { deps } = depsFor(w, m, deploymentFor(), (l) => lines.push(l));
    await checkReadyV32(deps, m, T * 1000);
    await checkReadyV32(deps, m, T * 1000 + 3_600_000);
    expect(lines.filter((l) => l.startsWith("REWARDS VEST TOO FAST: "))).toEqual([`REWARDS VEST TOO FAST: ${vestingGapProblem(604_800n)}`]);
  });
});

void privateKeyToAccount;
