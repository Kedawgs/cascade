import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "../src/args.ts";
import { encodeSs58 } from "../src/ss58.ts";
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

  it("parses pool-floors (Task 61 step 4: reads Base's archive, takes nothing) and rehearse --v32", () => {
    expect(parseArgs(["pool-floors"])).toEqual({ cmd: "pool-floors", live: false, users: [] });
    expect(() => parseArgs(["pool-floors", "--v32"])).toThrow(UsageError);
    expect(parseArgs(["rehearse", "--v32"])).toEqual({ cmd: "rehearse", live: false, users: [], v32: true });
    expect(parseArgs(["rehearse", "--v32", "--no-build"])).toEqual({ cmd: "rehearse", live: false, users: [], v32: true, noBuild: true });
    expect(() => parseArgs(["rehearse", "--no-build"])).toThrow(/--no-build goes with rehearse --v32/);
    expect(() => parseArgs(["rehearse", "--v32", "--live"])).toThrow(/rehearse runs on local forks only/);
    expect(() => parseArgs(["deploy", "--no-build"])).toThrow(UsageError);
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

  it("Task 53's one-shots: claim, adopt, add-hotkey, remove-hotkey and park check first and send only with --send; a hotkey as hex or SS58", () => {
    const HK = `0x${"5e".repeat(32)}` as const;
    expect(parseArgs(["claim", HK, "--live", "--send"])).toEqual({ cmd: "claim", live: true, users: [], hotkey: HK, send: true });
    expect(parseArgs(["claim", "--live"])).toEqual({ cmd: "claim", live: true, users: [] });
    expect(parseArgs(["adopt", "--live"])).toEqual({ cmd: "adopt", live: true, users: [] });
    expect(parseArgs(["adopt", "--send"])).toEqual({ cmd: "adopt", live: false, users: [], send: true });
    expect(parseArgs(["add-hotkey", HK, "--live"])).toEqual({ cmd: "add-hotkey", live: true, users: [], hotkey: HK });
    // taostats shows a hotkey's SS58 address: taken as its 32 bytes
    expect(parseArgs(["add-hotkey", encodeSs58(HK), "--live", "--send"])).toEqual({ cmd: "add-hotkey", live: true, users: [], hotkey: HK, send: true });
    expect(parseArgs(["remove-hotkey", HK, "--live", "--send"])).toEqual({ cmd: "remove-hotkey", live: true, users: [], hotkey: HK, send: true });
    expect(parseArgs(["park", "--live"])).toEqual({ cmd: "park", live: true, users: [] });
    expect(parseArgs(["park", `0x${"ab".repeat(32)}`, "--live", "--send"])).toEqual({ cmd: "park", live: true, users: [], parkKey: `0x${"ab".repeat(32)}`, send: true });
    // the owner's or the guardian's call files
    expect(parseArgs(["add-hotkey", HK, "--as", "guardian", "--for-wallet", "--live"])).toEqual({ cmd: "add-hotkey", live: true, users: [], hotkey: HK, as: "guardian", forWallet: true });
    expect(parseArgs(["remove-hotkey", HK, "--forfeit", "--as", "owner", "--for-wallet", "--live"])).toEqual({ cmd: "remove-hotkey", live: true, users: [], hotkey: HK, forfeit: true, as: "owner", forWallet: true });
    expect(parseArgs(["set-stake-hotkey", HK, "--for-wallet", "--live"])).toEqual({ cmd: "set-stake-hotkey", live: true, users: [], hotkey: HK, forWallet: true });
    expect(parseArgs(["set-redeem-origin", "--for-wallet", "--live"])).toEqual({ cmd: "set-redeem-origin", live: true, users: [], forWallet: true });
    const refused: [string[], string][] = [
      [["add-hotkey", "--live"], "add-hotkey needs the hotkey: add-hotkey <hotkey>"],
      [["add-hotkey", "0x1234", "--live"], "0x1234 is not a hotkey (32 bytes of hex, 0x…, or its SS58 address, 5…)"],
      [["add-hotkey", `0x${"00".repeat(32)}`], `0x${"00".repeat(32)} is the zero hotkey`],
      [["add-hotkey", HK, "--as", "owner"], "--as goes with --for-wallet (a call file for the owner's or the guardian's Ledger); without them the keeper sends it"],
      [["add-hotkey", HK, "--for-wallet", "--live"], "add-hotkey --for-wallet writes the owner's or the guardian's call: add --as owner or --as guardian"],
      [["add-hotkey", HK, "--as", "owner", "--for-wallet"], "add-hotkey --for-wallet is for the live deployment: add --live (it only reads; it sends nothing)"],
      [["add-hotkey", HK, "--as", "owner", "--for-wallet", "--live", "--send"], "add-hotkey --for-wallet writes a call for the sign page and sends nothing: drop --send"],
      [["remove-hotkey", HK, "--forfeit", "--live", "--send"], "--forfeit is the owner's: remove-hotkey <hotkey> --forfeit --as owner --for-wallet --live"],
      [["remove-hotkey", HK, "--forfeit", "--as", "guardian", "--for-wallet", "--live"], "--forfeit is the owner's: remove-hotkey <hotkey> --forfeit --as owner --for-wallet --live"],
      [["set-stake-hotkey", HK, "--live"], "set-stake-hotkey writes the owner's call for the sign page and sends nothing: add --for-wallet"],
      [["set-stake-hotkey", HK, "--for-wallet"], "set-stake-hotkey --for-wallet is for the live deployment: add --live (it only reads; it sends nothing)"],
      [["set-stake-hotkey", HK, "--send", "--for-wallet", "--live"], "unexpected argument --send"],
      [["park", "--send"], "park --send needs the park's key: park <key> --send"],
      [["set-redeem-origin", "--live"], "set-redeem-origin writes the treasury's call for the sign page and sends nothing: add --for-wallet"],
      [["set-redeem-origin", "--for-wallet"], "set-redeem-origin --for-wallet is for the live deployment: add --live (it only reads; it sends nothing)"],
      [["park", "0xab"], "0xab is not a park's key (32 bytes of hex)"],
      [["stake", "--send"], "unexpected argument --send"],
      [["close", HK], `unexpected argument ${HK}`],
    ];
    for (const [argv, why] of refused) expect(() => parseArgs(argv), argv.join(" ")).toThrow(new UsageError(why));
  });

  it("R5 Minor 3: set-claim-gas <gas> --for-wallet --live, the owner's immediate setClaimGasRequired, within the vault's bounds", () => {
    expect(parseArgs(["set-claim-gas", "58000000", "--for-wallet", "--live"])).toEqual({ cmd: "set-claim-gas", live: true, users: [], claimGas: "58000000", forWallet: true });
    const refused: [string[], string][] = [
      [["set-claim-gas", "5.8e7", "--for-wallet", "--live"], "set-claim-gas needs a whole number of gas within the vault's bounds, 54,100,000 to 63,400,000, not 5.8e7"],
      [["set-claim-gas", "54099999", "--for-wallet", "--live"], "set-claim-gas needs a whole number of gas within the vault's bounds, 54,100,000 to 63,400,000, not 54099999"],
      [["set-claim-gas", "63400001", "--for-wallet", "--live"], "set-claim-gas needs a whole number of gas within the vault's bounds, 54,100,000 to 63,400,000, not 63400001"],
      [["set-claim-gas", "58000000", "--live"], "set-claim-gas writes a call for the sign page and sends nothing: add --for-wallet"],
    ];
    for (const [argv, why] of refused) expect(() => parseArgs(argv), argv.join(" ")).toThrow(new UsageError(why));
  });

  it("Task 53's fix round: the four call files' commands (set-keeper, fund-reserve, disable-bridge, set-idle-buffer), each --for-wallet --live", () => {
    const A = "0x00000000000000000000000000000000000a11ce";
    const B = "0x000000000000000000000000000000000000b0b0";
    expect(parseArgs(["set-keeper", A, "--for-wallet", "--live"])).toEqual({ cmd: "set-keeper", live: true, users: [], newKeeper: A, forWallet: true });
    expect(parseArgs(["fund-reserve", "--from", A, "--for-wallet", "--live"])).toEqual({ cmd: "fund-reserve", live: true, users: [], from: A, forWallet: true });
    expect(parseArgs(["disable-bridge", "both", A, B, "--as", "guardian", "--for-wallet", "--live"])).toEqual({ cmd: "disable-bridge", live: true, users: [], target: "both", bridges: [A, B], as: "guardian", forWallet: true });
    expect(parseArgs(["disable-bridge", "front-door", B, "--as", "owner", "--for-wallet", "--live"])).toEqual({ cmd: "disable-bridge", live: true, users: [], target: "front-door", bridges: [B], as: "owner", forWallet: true });
    expect(parseArgs(["set-idle-buffer", "240", "--for-wallet", "--live"])).toEqual({ cmd: "set-idle-buffer", live: true, users: [], bps: "240", forWallet: true });
    const refused: [string[], string][] = [
      [["set-keeper", "--for-wallet", "--live"], "set-keeper needs the new keeper's address: set-keeper <0x…>"],
      [["set-keeper", "0x12", "--for-wallet", "--live"], "0x12 is not an address (or its checksum is wrong)"],
      [["set-keeper", A, "--live"], "set-keeper writes a call for the sign page and sends nothing: add --for-wallet"],
      [["fund-reserve", "--for-wallet", "--live"], "fund-reserve needs --from <0x…>, the account that will send it from MetaMask"],
      [["disable-bridge", "both", A, "--as", "guardian", "--for-wallet", "--live"], "disable-bridge both needs two bridges: the vault's, then the front door's"],
      [["disable-bridge", "vault", A, "--for-wallet", "--live"], "disable-bridge needs --as owner or --as guardian: who signs it"],
      [["disable-bridge", "nowhere", A, "--as", "guardian", "--for-wallet", "--live"], "disable-bridge takes vault, front-door or both first, not nowhere"],
      [["set-idle-buffer", "2.5", "--for-wallet", "--live"], "set-idle-buffer needs a whole number of bps (0 to 1000), not 2.5"],
      [["set-idle-buffer", "240", "--for-wallet"], "set-idle-buffer --for-wallet is for the live deployment: add --live (it only reads; it sends nothing)"],
    ];
    for (const [argv, why] of refused) expect(() => parseArgs(argv), argv.join(" ")).toThrow(new UsageError(why));
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
