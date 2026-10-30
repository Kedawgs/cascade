import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLOSE_MAX_WAIT_S, deploymentFromRecord, main } from "../../scripts/config-from-record.ts";
import { parseConfig } from "../../src/config.ts";
import { pkg, readJsonc } from "./files.ts";

// A record shaped like ops/deployments/v3-test.json, with made-up addresses and blocks (bigints in the
// ops record's { $bigint } form).
const A = {
  baseAdapter: "0x019c592aFe36E17f71866FeF0BC09508b3714450",
  oracle: "0x9788d195AecE108638d519bFa3a09004b3005E4D",
  frontDoor: "0x8A825738D0287D0959957A0f6ec18bA1276d209d",
  staker: "0x51D233584210133De458DC45c0BcA0698D31396d",
  bitAdapter: "0x51D233584210133De458DC45c0BcA0698D31396d",
  vault: "0x44CeaCE0b097D9d5eF01e08b12029Ad2762cbDC6",
};
const COLDKEY = "0x2c9db4bedc1653813af5e5156519a6982e5c499348ffbdbedd1fc07ffa777f41";
const HOTKEY = "0x358cae921ebeb5f9e82d096d664ce8840b2f36e5ba6c59ac22ded1528bfab0a7";
const sent = (block: number) => ({ hash: `0x${"11".repeat(32)}`, block, gasUsed: { $bigint: "1" }, costWei: { $bigint: "1" }, logs: [] });

function record(over: Record<string, unknown> = {}) {
  return {
    target: "live",
    wallet: "0x0000000000000000000000000000000000000001",
    createdAt: "2026-10-26T15:00:00.000Z",
    plan: {
      version: 3,
      baseNonce: 5,
      bitNonce: 8,
      addresses: A,
      steps: [
        { id: "baseAdapter", kind: "create", chain: "base", args: [] },
        { id: "frontDoor", kind: "create", chain: "base", args: [] },
        { id: "fdSetKeeper", kind: "call", chain: "base", args: [] },
        { id: "bitAdapter", kind: "create", chain: "bittensor", args: [] },
        { id: "vault", kind: "create", chain: "bittensor", args: [COLDKEY, HOTKEY, A.bitAdapter] },
        { id: "setRewardCut", kind: "call", chain: "bittensor", args: [] },
      ],
    },
    done: { baseAdapter: sent(53119544), frontDoor: sent(53119551), fdSetKeeper: sent(53119575), bitAdapter: sent(9368744), vault: sent(9368745), setRewardCut: sent(9368753) },
    verify: { ok: true, failures: [], checkedAt: "2026-10-26T15:31:37.005Z" },
    ...over,
  };
}

/** wrangler.jsonc's env.test vars, the Worker's whole config but DEPLOYMENT. */
const testVars = () => (readJsonc(pkg("wrangler.jsonc")) as { env: { test: { vars: Record<string, unknown> } } }).env.test.vars;

describe("pnpm config:from-record", () => {
  it("prints a DEPLOYMENT the Worker parses: checksummed addresses, the Bittensor adapter's block as the start", () => {
    const { deployment } = deploymentFromRecord(record());
    expect(deployment).toEqual({
      base: { chainId: 8453, startBlock: "53119544", baselineBlock: "53119575" },
      bittensor: { chainId: 964, startBlock: "9368744", baselineBlock: "9368753" },
      ...A,
      vaultColdkey: COLDKEY,
      stakeHotkey: HOTKEY,
      batchMaxWaitS: 0,
    });
    const cfg = parseConfig({ ...testVars(), DEPLOYMENT: JSON.stringify(deployment) });
    expect(cfg.deployment.bittensor.startBlock).toBe(9368744n);
    expect(cfg.deployment.frontDoor).toBe(A.frontDoor.toLowerCase());
  });

  it("checksums addresses a record holds in another case", () => {
    const lower = Object.fromEntries(Object.entries(A).map(([k, v]) => [k, v.toLowerCase()]));
    const { deployment } = deploymentFromRecord(record({ plan: { ...record().plan, addresses: lower } }));
    expect(deployment.frontDoor).toBe(A.frontDoor);
  });

  it("takes a launch plan's close wait as batchMaxWaitS", () => {
    expect(deploymentFromRecord(record({ plan: { ...record().plan, cadence: "launch" } })).deployment.batchMaxWaitS).toBe(86_400);
  });

  it("refuses a record whose read-back hasn't passed, a v2 record, and an unknown cadence", () => {
    expect(() => deploymentFromRecord(record({ verify: { ok: false, failures: ["x"], checkedAt: "" } }))).toThrow(/read-back/);
    expect(() => deploymentFromRecord(record({ verify: undefined }))).toThrow(/read-back/);
    expect(() => deploymentFromRecord(record({ plan: { ...record().plan, version: undefined } }))).toThrow(/v3/);
    expect(() => deploymentFromRecord(record({ plan: { ...record().plan, cadence: "weekly" } }))).toThrow(/cadence/);
  });

  it("refuses a recovered Bittensor adapter without a block, with the keeper's advice", () => {
    const done = { ...record().done, bitAdapter: { recovered: true } };
    expect(() => deploymentFromRecord(record({ done }))).toThrow(/no block for the Bittensor adapter's creation \(it was recovered, not recorded\).*run deploy again/);
  });

  it("starts Base at the earliest Base step recorded when the Base adapter's block wasn't kept", () => {
    const done = { ...record().done, baseAdapter: { recovered: true } };
    const r = deploymentFromRecord(record({ done }));
    expect(r.deployment.base.startBlock).toBe("53119551");
    expect(r.notes.join("\n")).toMatch(/Base adapter/);
  });

  it("ends the setup later when told: the owner's acceptOwnership after the deploy is setup too, and the scans still start at the deploy", () => {
    const r = deploymentFromRecord(record(), { setupEnds: { base: 53119600, bittensor: 9368800 } });
    expect(r.deployment.base).toEqual({ chainId: 8453, startBlock: "53119544", baselineBlock: "53119600" });
    expect(r.deployment.bittensor).toEqual({ chainId: 964, startBlock: "9368744", baselineBlock: "9368800" });
    expect(r.notes).toEqual([
      "Base's setup ends at block 53119600 (--setup-ends-base), after the record's last Base step (53119575): no admin event up to it is an alert",
      "Bittensor's setup ends at block 9368800 (--setup-ends-bittensor), after the record's last Bittensor step (9368753): no admin event up to it is an alert",
    ]);
    // one chain only: the other keeps the record's
    expect(deploymentFromRecord(record(), { setupEnds: { bittensor: 9368800 } }).deployment.base.baselineBlock).toBe("53119575");
    // never before the record's own setup: its events would be alerts
    expect(() => deploymentFromRecord(record(), { setupEnds: { base: 53119574 } })).toThrow(
      /--setup-ends-base 53119574 is before the record's last Base step \(53119575\)/,
    );
  });

  it("takes --setup-ends-base and --setup-ends-bittensor, and refuses a value that isn't a block number", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cascade-record-"));
    const path = join(dir, "v3-test.json");
    writeFileSync(path, JSON.stringify(record()));
    const read = (p: string) => readFileSync(p, "utf8");
    const out: string[] = [];
    expect(await main(["--", path, "--setup-ends-base", "53119600", "--setup-ends-bittensor", "9368800"], { print: (l) => out.push(l), read })).toBe(0);
    const pasted = JSON.parse(`{${out.filter((l) => !l.startsWith("//")).join("\n").replace(/,\s*$/, "")}}`) as { DEPLOYMENT: { base: unknown; bittensor: unknown } };
    expect(pasted.DEPLOYMENT.base).toEqual({ chainId: 8453, startBlock: "53119544", baselineBlock: "53119600" });
    expect(pasted.DEPLOYMENT.bittensor).toEqual({ chainId: 964, startBlock: "9368744", baselineBlock: "9368800" });
    expect(out).toContain(
      "// note: Base's setup ends at block 53119600 (--setup-ends-base), after the record's last Base step (53119575): no admin event up to it is an alert",
    );
    for (const bad of [["--setup-ends-base", "12.5"], ["--setup-ends-base", "-1"], ["--setup-ends-bittensor"], ["--setup-end", "1"]]) {
      const said: string[] = [];
      expect(await main([path, ...bad], { print: (l) => said.push(l), read }), bad.join(" ")).toBe(2);
      expect(said.join("\n")).toMatch(/usage: pnpm config:from-record/);
    }
  });

  it("reads the record with its $bigint reviver and prints the vars to paste", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cascade-record-"));
    const path = join(dir, "v3-test.json");
    writeFileSync(path, JSON.stringify(record()));
    const out: string[] = [];
    expect(await main([path], { print: (l) => out.push(l), read: (p) => readFileSync(p, "utf8") })).toBe(0);
    const text = out.join("\n");
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const pasted = JSON.parse(`{${text.split("\n").filter((l) => !l.startsWith("//")).join("\n").replace(/,\s*$/, "")}}`) as Record<string, unknown>;
    expect(pasted.DEPLOYMENT).toEqual(deploymentFromRecord(record()).deployment);
    expect(json.length).toBeGreaterThan(0);
    expect(text).toContain("BRIDGES");
    expect(await main([], { print: () => undefined, read: () => "" })).toBe(2);
    expect(await main([path.replace("v3-test", "missing")], { print: (l) => out.push(l), read: (p) => readFileSync(p, "utf8") })).toBe(1);
  });
});

describe("the close waits are ops'", () => {
  it("equal ops/src/config.ts CADENCE (null is no wait)", () => {
    const src = readFileSync(pkg("../ops/src/config.ts"), "utf8");
    const m = /CADENCE = \{\s*test: \{ closeMaxWaitS: (null|[\d_]+) \},\s*launch: \{ closeMaxWaitS: (null|[\d_]+) \},?\s*\}/.exec(src);
    expect(m).not.toBeNull();
    const wait = (s: string) => (s === "null" ? 0 : Number(s.replaceAll("_", "")));
    expect(CLOSE_MAX_WAIT_S).toEqual({ test: wait(m![1]), launch: wait(m![2]) });
  });
});

describe("the test environment in wrangler.jsonc", () => {
  it("holds the v3 test deployment, as the Worker parses it", () => {
    const cfg = parseConfig(testVars());
    expect(cfg.deployment.bittensor.startBlock).toBeGreaterThan(0n);
    expect(cfg.rpc.baseLogs).toBe("https://base-rpc.publicnode.com");
  });
});

describe("the production environment in wrangler.jsonc", () => {
  const productionVars = () => (readJsonc(pkg("wrangler.jsonc")) as { env: { production: { vars: Record<string, unknown> } } }).env.production.vars;

  it("holds the v3-launch deployment, as pnpm config:from-record printed it from the launch record, and the Worker parses it", () => {
    const cfg = parseConfig(productionVars());
    // the launch's addresses (web/src/lib/cascade/deployments.json "v3-launch") and the 24-hour close wait
    expect(cfg.deployment.frontDoor).toBe("0xbAe5417A40613141790624bCeF6BaFc3b24ff9AA".toLowerCase());
    expect(cfg.deployment.vault).toBe("0x450cD94401B45c72C09734071fe683F6b74Aea72".toLowerCase());
    expect(cfg.deployment.bitAdapter).toBe("0x002d7C6b2A6062d4E066FB41671DbB3Fd4f388E1".toLowerCase());
    expect(cfg.deployment.bittensor.startBlock).toBe(9398120n);
    expect(cfg.deployment.base.startBlock).toBe(53295800n);
    expect(cfg.deployment.batchMaxWaitS).toBe(86_400);
  });

  it("counts the Ledger's acceptOwnership as setup: each chain's baseline is its acceptance block, so the first run raises no ownership alert", () => {
    const cfg = parseConfig(productionVars());
    // the staker's acceptance (Base 53297722, after the front door's at 53297713) and the vault's (Bittensor
    // 9398435); admin.event skips a log at or before the baseline
    expect(cfg.deployment.base.baselineBlock).toBe(53297722n);
    expect(cfg.deployment.bittensor.baselineBlock).toBe(9398435n);
  });

  it("keeps writing alerts to the log until the owner chooses a recipient and deploys", () => {
    expect(productionVars().ALERT_MODE).toBe("log");
  });
});
