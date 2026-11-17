import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLOSE_MAX_WAIT_S, deploymentFromRecord, main, PUBLIC_RPC, publicBlockTimeOf, SETUP_ENDS_MAX_PAST_S, setupEndsMaxPast } from "../../scripts/config-from-record.ts";
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

  it("refuses a setup end further past the record's last step than a time (about 2.3 days on Base, 14 on Bittensor) in blocks at the chain's measured block time, unless forced", () => {
    // what 100,000 blocks meant on Base's 2-second and Bittensor's 12-second blocks
    expect(SETUP_ENDS_MAX_PAST_S).toEqual({ base: 200_000, bittensor: 1_200_000 });
    expect(setupEndsMaxPast("base", 0.2)).toBe(1_000_000);
    expect(setupEndsMaxPast("bittensor", 12)).toBe(100_000);
    // while unread: at the block times the limit was set at, 100,000 blocks
    expect(setupEndsMaxPast("base", undefined)).toBe(100_000);
    // on Base's 200 ms blocks: 1,000,000 past the last Base step (53119575) is allowed; one more is a typo or the wrong
    // chain's block
    const at = { base: 0.2, bittensor: 12 };
    expect(deploymentFromRecord(record(), { setupEnds: { base: 53119575 + 1_000_000 }, blockS: at }).deployment.base.baselineBlock).toBe("54119575");
    expect(() => deploymentFromRecord(record(), { setupEnds: { base: 53119575 + 1_000_001 }, blockS: at })).toThrow(
      /--setup-ends-base 54119576 is 1,000,001 blocks past the record's last Base step \(53119575\), more than 1,000,000 \(about 2\.3 days of Base's blocks at 0\.2 s\): check the block, or pass --force/,
    );
    // its block time unread: 100,000, as it was set
    expect(() => deploymentFromRecord(record(), { setupEnds: { base: 53119575 + 100_001 } })).toThrow(
      /--setup-ends-base 53219576 is 100,001 blocks past the record's last Base step \(53119575\), more than 100,000 \(about 2\.3 days of Base's blocks at 2 s, the block time it was set at: Base's block time wasn't read\): check the block, or pass --force/,
    );
    expect(() => deploymentFromRecord(record(), { setupEnds: { bittensor: 53119575 }, blockS: at })).toThrow(/--setup-ends-bittensor 53119575 is .* past the record's last Bittensor step/);
    const forced = deploymentFromRecord(record(), { setupEnds: { base: 53119575 + 1_000_001 }, force: true, blockS: at });
    expect(forced.deployment.base.baselineBlock).toBe("54119576");
    expect(forced.notes.join("\n")).toMatch(/--force/);
  });

  it("reads a chain's block time from its public RPC with a timeout, and refuses one outside 0.05 to 60 s (review M-3)", async () => {
    // a public RPC whose block n is at 1,000 + n * `blockS` seconds, head 1,000,000
    const rpc = (blockS: number) => {
      const asked: { url: string; signal: unknown }[] = [];
      const fetchFn = (async (url: string, init: RequestInit) => {
        asked.push({ url, signal: init.signal });
        const tag = (JSON.parse(String(init.body)) as { params: [string] }).params[0];
        const n = tag === "latest" ? 1_000_000 : Number.parseInt(tag, 16);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { number: `0x${n.toString(16)}`, timestamp: `0x${(1_000 + Math.floor(n * blockS)).toString(16)}` } }));
      }) as unknown as typeof fetch;
      return { fetchFn, asked };
    };
    const ok = rpc(0.2);
    expect(await publicBlockTimeOf("base", ok.fetchFn)).toBe(0.2);
    expect(ok.asked.every((a) => a.url === PUBLIC_RPC.base && a.signal instanceof AbortSignal)).toBe(true);
    await expect(publicBlockTimeOf("base", rpc(0.01).fetchFn)).rejects.toThrow(/0\.01 s a block is outside 0\.05 to 60 s/);
    await expect(publicBlockTimeOf("bittensor", rpc(120).fetchFn)).rejects.toThrow(/120 s a block is outside 0\.05 to 60 s/);
  });

  it("takes --setup-ends-base and --setup-ends-bittensor, and refuses a value that isn't a block number", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cascade-record-"));
    const path = join(dir, "v3-test.json");
    writeFileSync(path, JSON.stringify(record()));
    const read = (p: string) => readFileSync(p, "utf8");
    const out: string[] = [];
    // each chain's block time is read only for a setup end given on it (from its public RPC; here, the test's)
    const asked: string[] = [];
    const blockTimeOf = async (chain: "base" | "bittensor") => {
      asked.push(chain);
      return chain === "base" ? 0.2 : 12;
    };
    expect(await main(["--", path, "--setup-ends-base", "53119600", "--setup-ends-bittensor", "9368800"], { print: (l) => out.push(l), read, blockTimeOf })).toBe(0);
    expect(asked).toEqual(["base", "bittensor"]);
    const pasted = JSON.parse(`{${out.filter((l) => !l.startsWith("//")).join("\n").replace(/,\s*$/, "")}}`) as { DEPLOYMENT: { base: unknown; bittensor: unknown } };
    expect(pasted.DEPLOYMENT.base).toEqual({ chainId: 8453, startBlock: "53119544", baselineBlock: "53119600" });
    expect(pasted.DEPLOYMENT.bittensor).toEqual({ chainId: 964, startBlock: "9368744", baselineBlock: "9368800" });
    expect(out).toContain(
      "// note: Base's setup ends at block 53119600 (--setup-ends-base), after the record's last Base step (53119575): no admin event up to it is an alert",
    );
    for (const bad of [["--setup-ends-base", "12.5"], ["--setup-ends-base", "-1"], ["--setup-ends-bittensor"], ["--setup-end", "1"]]) {
      const said: string[] = [];
      expect(await main([path, ...bad], { print: (l) => said.push(l), read, blockTimeOf }), bad.join(" ")).toBe(2);
      expect(said.join("\n")).toMatch(/usage: pnpm config:from-record/);
    }
    // far past the record: refused (nothing printed), then taken with --force
    const far = ["--setup-ends-base", String(53119575 + 1_000_001)];
    const refused: string[] = [];
    expect(await main([path, ...far], { print: (l) => refused.push(l), read, blockTimeOf })).toBe(1);
    expect(refused.join("\n")).toMatch(/^nothing printed: --setup-ends-base 54119576 is 1,000,001 blocks past/);
    const forced: string[] = [];
    expect(await main([path, ...far, "--force"], { print: (l) => forced.push(l), read, blockTimeOf })).toBe(0);
    expect(forced.join("\n")).toContain('"baselineBlock": "54119576"');
    // a block time that can't be read: the limit as it was set (100,000), and a note says so
    const down = async () => {
      throw new Error("no answer");
    };
    const unread: string[] = [];
    expect(await main([path, "--setup-ends-base", String(53119575 + 100_001)], { print: (l) => unread.push(l), read, blockTimeOf: down })).toBe(1);
    expect(unread.join("\n")).toMatch(/more than 100,000 \(about 2\.3 days of Base's blocks at 2 s, the block time it was set at: Base's block time wasn't read\)/);
    // no setup end: no block time read
    asked.length = 0;
    expect(await main([path], { print: () => undefined, read, blockTimeOf })).toBe(0);
    expect(asked).toEqual([]);
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

// A v3.2 record as ops/src/v32/deploy.ts writes it (DeploymentRecordV32 on the v3.2-ops branch: PlanV32, every step a
// create at its planned nonce, the standby recorded in plan.validators), with made-up addresses and blocks.
const V = {
  bitAdapter: "0x51D233584210133De458DC45c0BcA0698D31396d",
  payoutMath: "0x00000000000000000000000000000000000000F1",
  stakeLib: "0x00000000000000000000000000000000000000F2",
  payoutLib: "0x00000000000000000000000000000000000000f3",
  batchLib: "0x00000000000000000000000000000000000000f4",
  hotkeyLib: "0x00000000000000000000000000000000000000F5",
  vault: "0x44CeaCE0b097D9d5eF01e08b12029Ad2762cbDC6",
  vaultLens: "0x1E5A000000000000000000000000000000000a11",
  baseAdapter: "0x019c592aFe36E17f71866FeF0BC09508b3714450",
  oracle: "0x9788d195AecE108638d519bFa3a09004b3005E4D",
  frontDoor: "0x8A825738D0287D0959957A0f6ec18bA1276d209d",
  staker: "0x51D233584210133De458DC45c0BcA0698D31396d",
  doorLens: "0xD00A000000000000000000000000000000000a12",
};
const YUMA = "0x40c47b6a294686fe9612b5d78dd369f4c77fa3bbf96a4286ede97410ba2e3209";
const BIT_STEPS = ["bitAdapter", "payoutMath", "stakeLib", "payoutLib", "batchLib", "hotkeyLib", "vault", "vaultLens"] as const;
const BASE_STEPS = ["baseAdapter", "oracle", "frontDoor", "staker", "doorLens"] as const;
function recordV32(over: Record<string, unknown> = {}) {
  const create = (id: string, chain: string, nonce: number) => ({ id, kind: "create", version: 32, chain, nonce, label: id, contract: `src/${id}.sol`, args: [] });
  return {
    target: "live",
    createdAt: "2026-11-20T15:00:00.000Z",
    plan: {
      version: 32,
      roles: {},
      validators: { primary: HOTKEY, standby: YUMA } as Record<string, string>,
      deployers: { base: "0x0000000000000000000000000000000000000d01", bittensor: "0x0000000000000000000000000000000000000d02" },
      addresses: V,
      vaultColdkey: COLDKEY,
      poolFloors: [{ $bigint: "1" }, { $bigint: "1" }],
      claimGasRequired: { $bigint: "55000000" },
      steps: [...BIT_STEPS.map((id, i) => create(id, "bittensor", i)), ...BASE_STEPS.map((id, i) => create(id, "base", i))],
    },
    build: { dir: "builds/v32-x", hash: `0x${"22".repeat(32)}` },
    done: {
      ...Object.fromEntries(BIT_STEPS.map((id, i) => [id, sent(9500000 + i)])),
      ...Object.fromEntries(BASE_STEPS.map((id, i) => [id, sent(53400000 + 3 * i)])),
    } as Record<string, ReturnType<typeof sent>>,
    verify: { ok: true, failures: [], checkedAt: "2026-11-20T16:00:00.000Z" },
    ...over,
  };
}

describe("pnpm config:from-record on a v3.2 record (Task 54 concern 2, Task 55's stage)", () => {
  it("prints a v3.2 DEPLOYMENT the Worker parses: version, both lenses, stage early, each chain from its first create, and the standby", () => {
    const r = deploymentFromRecord(recordV32());
    expect(r.deployment).toEqual({
      version: "v3.2",
      stage: "early",
      base: { chainId: 8453, startBlock: "53400000", baselineBlock: "53400012" },
      bittensor: { chainId: 964, startBlock: "9500000", baselineBlock: "9500007" },
      frontDoor: V.frontDoor,
      doorLens: "0xD00a000000000000000000000000000000000A12",
      baseAdapter: V.baseAdapter,
      staker: V.staker,
      oracle: V.oracle,
      vault: V.vault,
      vaultLens: "0x1e5a000000000000000000000000000000000a11",
      bitAdapter: V.bitAdapter,
      vaultColdkey: COLDKEY,
      stakeHotkey: HOTKEY,
      batchMaxWaitS: 86_400,
    });
    expect(r.standbyHotkey).toBe(YUMA);
    expect(r.bridges).toEqual({ base: [V.baseAdapter], bittensor: [V.bitAdapter] });
    const cfg = parseConfig({ ...testVars(), DEPLOYMENT: JSON.stringify(r.deployment), STANDBY_HOTKEY: r.standbyHotkey });
    expect(cfg.deployment).toMatchObject({ version: "v3.2", stage: "early", vaultLens: V.vaultLens.toLowerCase(), doorLens: V.doorLens.toLowerCase() });
    expect(cfg.standbyHotkey).toBe(YUMA);
  });

  it("starts each chain at its first create, the constructors' events included (the vault's, if it came before the adapter)", () => {
    const done = { ...recordV32().done, vault: sent(9499990) };
    const r = deploymentFromRecord(recordV32({ done }));
    expect(r.deployment.bittensor.startBlock).toBe("9499990");
    expect(r.notes.join("\n")).toMatch(/first create on Bittensor is the vault's/);
  });

  it("refuses a rehearsal record, a voided plan, a deploy not finished, and a standby that isn't 32 bytes", () => {
    expect(() => deploymentFromRecord(recordV32({ target: "rehearsal" }))).toThrow(/rehearsal/);
    expect(() => deploymentFromRecord(recordV32({ void: { at: "x", reason: "a revert" } }))).toThrow(/void/);
    const { doorLens: _, ...unfinished } = recordV32().done;
    expect(() => deploymentFromRecord(recordV32({ done: unfinished }))).toThrow(/doorLens/);
    expect(() => deploymentFromRecord(recordV32({ verify: { ok: false, failures: ["x"] } }))).toThrow(/read-back/);
    const plan = recordV32().plan;
    expect(() => deploymentFromRecord(recordV32({ plan: { ...plan, validators: { primary: HOTKEY, standby: "0x12" } } }))).toThrow(/standby/);
    // no standby recorded: none printed
    expect(deploymentFromRecord(recordV32({ plan: { ...plan, validators: { primary: HOTKEY } } })).standbyHotkey).toBeUndefined();
  });

  it("prints the DEPLOYMENT and STANDBY_HOTKEY lines to paste into the v3.2 deployment's vars", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cascade-record-"));
    const path = join(dir, "v3.2-launch.json");
    writeFileSync(path, JSON.stringify(recordV32()));
    const out: string[] = [];
    expect(await main([path], { print: (l) => out.push(l), read: (p) => readFileSync(p, "utf8") })).toBe(0);
    const pasted = JSON.parse(`{${out.filter((l) => !l.startsWith("//")).join("\n").replace(/,\s*$/, "")}}`) as Record<string, unknown>;
    expect(pasted.DEPLOYMENT).toEqual(deploymentFromRecord(recordV32()).deployment);
    expect(pasted.STANDBY_HOTKEY).toBe(YUMA);
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
  // the recipient is the ALERT_TO secret (wrangler secret put), never in the repo; a stand-in lets send mode parse
  const productionWithSecret = () => ({ ...productionVars(), ALERT_TO: "owner@example.com" });

  it("holds the v3.2-launch deployment (Task 67, deployed 2026-11-16), as pnpm config:from-record printed it from the live record, and the Worker parses it", () => {
    const cfg = parseConfig(productionWithSecret());
    // the launch's addresses (web/src/lib/cascade/deployments.json "v3.2-launch"), both lenses, and the 24-hour close wait
    expect(cfg.deployment.version).toBe("v3.2");
    expect(cfg.deployment.frontDoor).toBe("0xd1Ae29169146Ff62c9E9D4dC17c653B62fA3754e".toLowerCase());
    expect(cfg.deployment.doorLens).toBe("0x9Da3e48fF7ab29AA277f37B0bC5B14c8Bbf96e7f".toLowerCase());
    expect(cfg.deployment.baseAdapter).toBe("0x0BEbdEbD94Ff1eD14a06E8fC055Afabd1465637E".toLowerCase());
    expect(cfg.deployment.staker).toBe("0x371C5CFa5F5F6B3356fBC360EaD26066A2958B87".toLowerCase());
    expect(cfg.deployment.oracle).toBe("0xDddd746237b923A0081630F4DcE7857De568696D".toLowerCase());
    expect(cfg.deployment.vault).toBe("0x56544AfF15fccea33b4db189cB5B3726DBac724e".toLowerCase());
    expect(cfg.deployment.vaultLens).toBe("0xc8b3b74261489ff544cF18335778498cd6f32010".toLowerCase());
    expect(cfg.deployment.bitAdapter).toBe("0x24B1b5eC0bB46c4F9850Ce9D75f7957eCB3B0027".toLowerCase());
    expect(cfg.deployment.bittensor.startBlock).toBe(9520646n);
    expect(cfg.deployment.base.startBlock).toBe(58306060n);
    expect(cfg.deployment.batchMaxWaitS).toBe(86_400);
    // the plan's standby validator (Yuma), read beside tao.bot
    expect(cfg.standbyHotkey).toBe("0x40c47b6a294686fe9612b5d78dd369f4c77fa3bbf96a4286ede97410ba2e3209");
  });

  it("counts the funding after the deploy as setup: Bittensor's baseline is the treasury's setRedeemOrigin, after the adapter's reserve and cushion, so the first run raises no alert for them; Base's is the record's last step", () => {
    const cfg = parseConfig(productionWithSecret());
    // Bittensor: the record's last step is 9520653; ReserveFunded 9520712, CushionFunded 9520723, RedeemOriginSet
    // 9520746 (--setup-ends-bittensor 9520746). admin.event skips a log at or before the baseline
    expect(cfg.deployment.base.baselineBlock).toBe(58306137n);
    expect(cfg.deployment.bittensor.baselineBlock).toBe(9520746n);
  });

  it("sends alerts, to a recipient that lives only in the ALERT_TO secret", () => {
    expect(productionVars().ALERT_MODE).toBe("send");
    expect(productionVars()).not.toHaveProperty("ALERT_TO");
    // without the secret the Worker refuses to start rather than send to no one
    expect(() => parseConfig(productionVars())).toThrow(/ALERT_TO is empty/);
  });
});
