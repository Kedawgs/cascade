import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "../src/args.ts";
import { gasPriceCapFor, WALLET } from "../src/config.ts";
import { deployAndVerify } from "../src/deploy.ts";
import { buildPlan } from "../src/plan.ts";
import { type DeploymentRecord, loadRecordFor, needRecord, saveRecord } from "../src/record.ts";
import { refuseV2Verify, V2_VERIFY_REFUSED, verify, verifyAndSave } from "../src/verify.ts";
import { fakeChain, SENT, v3Record } from "./fake-keeper.ts";

const ALICE = "0x000000000000000000000000000000000000a11c";

describe("cli arguments", () => {
  it("parses deploy --live --new-plan", () => {
    expect(parseArgs(["deploy", "--live", "--new-plan"])).toEqual({ cmd: "deploy", live: true, newPlan: true, users: [] });
  });

  it("keeps rehearsal as the default target", () => {
    expect(parseArgs(["status"])).toMatchObject({ cmd: "status", live: false });
  });

  it("needs both sweep destinations", () => {
    expect(() => parseArgs(["sweep", "--live", "--eth-to", "0x770932787DD3bcE64f14E31f4746bCe22E214fFF"])).toThrow(UsageError);
    expect(parseArgs(["sweep", "--live", "--tao-to", "5Fx", "--eth-to", "0x77"])).toMatchObject({ taoTo: "5Fx", ethTo: "0x77" });
  });

  it("needs a message id for track", () => {
    expect(() => parseArgs(["track"])).toThrow(UsageError);
    expect(parseArgs(["track", "0xab", "--live"])).toMatchObject({ cmd: "track", messageId: "0xab", live: true });
  });

  it("collects repeated --user and refuses unknown commands and flags", () => {
    expect(parseArgs(["wind-down", "--user", "0x1", "--user", "0x2"]).users).toEqual(["0x1", "0x2"]);
    expect(() => parseArgs(["launch"])).toThrow(UsageError);
    expect(() => parseArgs(["status", "--force"])).toThrow(UsageError);
  });

  it("--max-gas-price goes with the uncapped commands (pause, unpause, wind-down, sweep) and is a gas price in gwei", () => {
    expect(parseArgs(["pause", "--live", "--max-gas-price", "50"])).toMatchObject({ cmd: "pause", live: true, maxGasPrice: "50" });
    expect(parseArgs(["unpause", "vault", "--max-gas-price", "0.5"]).maxGasPrice).toBe("0.5");
    expect(parseArgs(["wind-down", "--live", "--max-gas-price", "20"]).maxGasPrice).toBe("20");
    expect(parseArgs(["sweep", "--live", "--tao-to", "5Fx", "--eth-to", "0x77", "--max-gas-price", "20"]).maxGasPrice).toBe("20");
    for (const capped of ["run", "close", "deploy", "deliver"]) expect(() => parseArgs([capped, "--max-gas-price", "50"]), capped).toThrow(/unexpected argument --max-gas-price/);
    for (const bad of ["0", "-1", "lots", "5gwei"]) expect(() => parseArgs(["pause", "--max-gas-price", bad]), bad).toThrow(/--max-gas-price .* is not a gas price in gwei/);
    expect(() => parseArgs(["pause", "--max-gas-price"])).toThrow(/needs a value/);
  });

  it("the gas price cap a command sends under: none for the emergency and owner commands, the environment's for the keeper's and deploy", () => {
    for (const cmd of ["pause", "unpause", "wind-down", "sweep"]) expect(gasPriceCapFor(cmd, { OPS_MAX_GAS_PRICE_BASE: "1" }), cmd).toBeUndefined();
    for (const cmd of ["run", "close", "stake", "payouts", "deliver", "claim", "deploy"]) {
      expect(gasPriceCapFor(cmd, {}), cmd).toEqual({ base: 5_000_000_000n, bittensor: 100_000_000_000n });
      expect(gasPriceCapFor(cmd, { OPS_MAX_GAS_PRICE_BASE: "1", OPS_MAX_GAS_PRICE_BITTENSOR: "20" }), cmd).toEqual({ base: 1_000_000_000n, bittensor: 20_000_000_000n });
    }
    // --max-gas-price gives an uncapped command a cap for the run, both chains
    expect(gasPriceCapFor("pause", {}, "50")).toEqual({ base: 50_000_000_000n, bittensor: 50_000_000_000n });
    expect(() => gasPriceCapFor("pause", {}, "lots")).toThrow(/--max-gas-price/);
  });

  it("parses handoff and ownership, which take only --live", () => {
    expect(parseArgs(["handoff", "--live"])).toEqual({ cmd: "handoff", live: true, users: [] });
    expect(parseArgs(["ownership"])).toEqual({ cmd: "ownership", live: false, users: [] });
    expect(() => parseArgs(["handoff", "--new-plan"])).toThrow(UsageError);
    expect(parseArgs(["cardinality"])).toEqual({ cmd: "cardinality", live: false, users: [] });
  });

  it("parses rewards, claim and deliver", () => {
    expect(parseArgs(["rewards"])).toEqual({ cmd: "rewards", live: false, users: [] });
    expect(parseArgs(["rewards", "--live"])).toEqual({ cmd: "rewards", live: true, users: [] });
    expect(parseArgs(["claim", "--live"])).toEqual({ cmd: "claim", live: true, users: [] });
    expect(parseArgs(["deliver"])).toEqual({ cmd: "deliver", live: false, users: [] });
    expect(parseArgs(["deliver", "--live", "--user", ALICE])).toEqual({ cmd: "deliver", live: true, users: [ALICE] });
    // deliver sends a transaction naming the user: a mistyped address is refused here
    expect(() => parseArgs(["deliver", "--user", "0x1"])).toThrow(UsageError);
    expect(() => parseArgs(["claim", "--new-plan"])).toThrow(UsageError);
  });
});

function v2Record(target: DeploymentRecord["target"] = "live"): DeploymentRecord {
  const plan = buildPlan(0, 0, `0x${"44".repeat(32)}`);
  return {
    target,
    wallet: WALLET,
    createdAt: "",
    plan,
    done: Object.fromEntries(plan.steps.map((s) => [s.id, SENT])),
    verify: { ok: true, failures: [], checkedAt: "2026-10-24T00:00:00Z" },
  };
}

/** A complete, verified v2 record saved as test-2026-10.json, and a chain that records every request. */
function v2World() {
  const dir = mkdtempSync(join(tmpdir(), "ops-cli-"));
  const path = join(dir, "test-2026-10.json");
  saveRecord(path, v2Record());
  const f = fakeChain([], {});
  return { dir, path, before: readFileSync(path, "utf8"), ...f };
}

describe("v2 records are never verified again", () => {
  it("names the reason", () => {
    expect(V2_VERIFY_REFUSED).toBe("v2 contracts were verified at deploy; the build has since moved to v3");
  });

  it("refuses a v2 plan, or the v2 record's file, and lets a v3 record through", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-cli-"));
    expect(() => refuseV2Verify(join(dir, "v3-test.json"), v2Record())).toThrow(V2_VERIFY_REFUSED);
    expect(() => refuseV2Verify(join(dir, "test-2026-10.json"), v3Record())).toThrow(V2_VERIFY_REFUSED);
    expect(() => refuseV2Verify(join(dir, "v3-test.json"), v3Record())).not.toThrow();
  });

  it("verify reads nothing and writes nothing for a v2 record", async () => {
    const w = v2World();
    const rec = needRecord(w.path, true);
    await expect(verifyAndSave(w.ctx, w.path, rec)).rejects.toThrow(V2_VERIFY_REFUSED);
    await expect(verify(w.ctx, rec)).rejects.toThrow(V2_VERIFY_REFUSED);
    expect(w.calls).toEqual([]);
    expect(readFileSync(w.path, "utf8")).toBe(w.before);
  });

  it("deploy --live on a v2 record, complete or not, refuses before deploying or verifying", async () => {
    const w = v2World();
    await expect(deployAndVerify(w.ctx, w.path, { newPlan: false, v3: false })).rejects.toThrow(V2_VERIFY_REFUSED);
    expect(w.calls).toEqual([]);
    expect(readFileSync(w.path, "utf8")).toBe(w.before);
    expect(needRecord(w.path, true).verify).toMatchObject({ ok: true });

    // an unfinished v2 record is refused before deploy reads a nonce or sends anything
    const unfinished = v2Record();
    delete unfinished.done.setPayoutDelay;
    saveRecord(w.path, unfinished);
    const saved = readFileSync(w.path, "utf8");
    await expect(deployAndVerify(w.ctx, w.path, { newPlan: false, v3: false })).rejects.toThrow(V2_VERIFY_REFUSED);
    // a v3 run that finds a v2 record is told to check OPS_DEPLOYMENT
    await expect(deployAndVerify(w.ctx, w.path, { newPlan: false, v3: true })).rejects.toThrow(/holds a v2 plan.*OPS_DEPLOYMENT/);
    expect(w.calls).toEqual([]);
    expect(readFileSync(w.path, "utf8")).toBe(saved);
  });

  it("a new deployment, or a new plan, must be v3", async () => {
    const w = v2World();
    await expect(deployAndVerify(w.ctx, w.path, { newPlan: true, v3: false })).rejects.toThrow(/uses the v3 contracts/);
    await expect(deployAndVerify(w.ctx, join(w.dir, "none.json"), { newPlan: false, v3: false })).rejects.toThrow(/uses the v3 contracts/);
    expect(w.calls).toEqual([]);
    expect(readFileSync(w.path, "utf8")).toBe(w.before);
  });
});

describe("records stay with their own kind of run", () => {
  it("a --live action refuses a rehearsal record, and a rehearsal action a live one", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-cli-"));
    const rehearsal = join(dir, "rehearsal-v3-test.json");
    const live = join(dir, "v3-test.json");
    saveRecord(rehearsal, v3Record("rehearsal"));
    saveRecord(live, v3Record("live"));
    expect(() => needRecord(rehearsal, true)).toThrow(/is a rehearsal record.*--live/);
    expect(() => loadRecordFor(rehearsal, true)).toThrow(/is a rehearsal record/);
    expect(() => needRecord(live, false)).toThrow(/is a live record.*local forks/);
    expect(needRecord(rehearsal, false).target).toBe("rehearsal");
    expect(needRecord(live, true).target).toBe("live");
    expect(loadRecordFor(join(dir, "none.json"), true)).toBeNull();
    expect(() => needRecord(join(dir, "none.json"), true)).toThrow(/no live deployment record yet/);
  });

  it("deploy --live refuses a rehearsal record before reading the chains", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-cli-"));
    const path = join(dir, "v3-test.json");
    saveRecord(path, v3Record("rehearsal"));
    const f = fakeChain([], {});
    await expect(deployAndVerify(f.ctx, path, { newPlan: false, v3: true })).rejects.toThrow(/is a rehearsal record/);
    expect(f.calls).toEqual([]);
  });
});
