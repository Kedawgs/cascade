import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress } from "viem";
import { describe, expect, it } from "vitest";
import { checkedDeployment, type Deployment, deploymentEntry, deploymentStage, EXPECTED_DEPLOYMENTS, isV32, knownDeployment, readDeployment, sourcePublished, wordingStage } from "./config";

/** The env `pnpm ops web-config` writes for a committed deployment. */
function envOf(name: string): Record<string, string> {
  const e = EXPECTED_DEPLOYMENTS[name];
  return {
    NEXT_PUBLIC_CASCADE_FRONT_DOOR: e.frontDoor,
    NEXT_PUBLIC_CASCADE_BASE_ADAPTER: e.baseAdapter,
    NEXT_PUBLIC_CASCADE_VAULT: e.vault,
    NEXT_PUBLIC_CASCADE_BIT_ADAPTER: e.bitAdapter,
    NEXT_PUBLIC_CASCADE_BIT_BLOCK: e.bitBlock,
    NEXT_PUBLIC_CASCADE_VAULT_SS58: e.vaultSs58,
    NEXT_PUBLIC_CASCADE_HOTKEY_SS58: e.hotkeySs58,
    ...(e.version === 3 ? { NEXT_PUBLIC_CASCADE_STAKER: e.staker!, NEXT_PUBLIC_CASCADE_ORACLE: e.oracle!, NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S: String(e.payoutDelayS ?? 3600) } : {}),
    ...(e.batchMaxWaitS !== undefined ? { NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S: String(e.batchMaxWaitS) } : {}),
    // a v3.2 entry: its two lenses, and the indexer its build needs (the monitor's origin, as OPS_INDEXER_URL names it)
    ...(e.vaultLens ? { NEXT_PUBLIC_CASCADE_VAULT_LENS: e.vaultLens, NEXT_PUBLIC_CASCADE_DOOR_LENS: e.doorLens!, NEXT_PUBLIC_CASCADE_INDEXER_URL: INDEXER } : {}),
  };
}

/** The live monitor's origin (the indexer a v3.2 site reads). */
const INDEXER = "https://cascade-indexer-production.dev-truthpoll.workers.dev";

const OTHER = getAddress("0x00000000000000000000000000000000000b0b00");

describe("the committed deployments", () => {
  it("list checksummed addresses, with a staker and an oracle exactly for v3", () => {
    expect(Object.keys(EXPECTED_DEPLOYMENTS).length).toBeGreaterThan(0);
    for (const [name, e] of Object.entries(EXPECTED_DEPLOYMENTS)) {
      const addresses = [e.frontDoor, e.baseAdapter, e.vault, e.bitAdapter, ...(e.version === 3 ? [e.staker, e.oracle] : [])];
      for (const a of addresses) expect(a && isAddress(a, { strict: true }) && a !== a.toLowerCase(), `${name} ${a}`).toBe(true);
      expect(e.version === 3 ? !!(e.staker && e.oracle) : !e.staker && !e.oracle, name).toBe(true);
      expect(e.bitBlock, name).toMatch(/^\d+$/);
    }
  });

  it("name the deployment an env matches, field for field", () => {
    for (const name of Object.keys(EXPECTED_DEPLOYMENTS)) expect(knownDeployment(readDeployment(envOf(name))!)).toBe(name);
  });

  it("know no deployment with any one address, block or name changed", () => {
    const d = readDeployment(envOf("v3-test")) as Deployment;
    const changed: Partial<Deployment>[] = [
      { frontDoor: OTHER },
      { baseAdapter: OTHER },
      { vault: OTHER },
      { bitAdapter: OTHER },
      { staker: OTHER },
      { oracle: OTHER },
      { bitBlock: d.bitBlock + 1n },
      { vaultSs58: "5FNEuRkKZvg2jFjhY3DWpC3TBSH51AC3FKQpLyC1xesTBwLu" },
      { hotkeySs58: "5FNEuRkKZvg2jFjhY3DWpC3TBSH51AC3FKQpLyC1xesTBwLu" },
    ];
    for (const patch of changed) expect(knownDeployment({ ...d, ...patch }), JSON.stringify(patch, (_k, v) => (typeof v === "bigint" ? String(v) : v))).toBeUndefined();
  });

  it("know no v2 deployment given a staker and an oracle, nor a v3 one without them", () => {
    const v2 = readDeployment(envOf("test-2026-10")) as Deployment;
    const v3 = readDeployment(envOf("v3-test")) as Deployment;
    expect(knownDeployment({ ...v2, staker: v3.staker, oracle: v3.oracle })).toBeUndefined();
    expect(knownDeployment({ ...v3, staker: undefined, oracle: undefined })).toBeUndefined();
  });

  it("fail the build for an env that names a deployment not listed, and let one with none through", () => {
    const d = readDeployment(envOf("v3-test")) as Deployment;
    expect(checkedDeployment(d)).toBe(d);
    expect(checkedDeployment(null)).toBeNull();
    expect(() => checkedDeployment({ ...d, frontDoor: OTHER })).toThrow(/deployments\.json/);
  });

  it("include the launch, as `pnpm ops web-config` writes it for v3-launch: its 24-hour batch wait and payout delay kept", () => {
    const env = {
      NEXT_PUBLIC_CASCADE_FRONT_DOOR: "0xbAe5417A40613141790624bCeF6BaFc3b24ff9AA",
      NEXT_PUBLIC_CASCADE_BASE_ADAPTER: "0xF2B3A36185e74ddCf8Ea9A174c06b75520F47F92",
      NEXT_PUBLIC_CASCADE_STAKER: "0xe33012f8ae80E17a7D7B8d9249043dB01D27e59E",
      NEXT_PUBLIC_CASCADE_ORACLE: "0xcAa85F00b6e470Dd28a31FBa982267B820736eBc",
      NEXT_PUBLIC_CASCADE_VAULT: "0x450cD94401B45c72C09734071fe683F6b74Aea72",
      NEXT_PUBLIC_CASCADE_BIT_ADAPTER: "0x002d7C6b2A6062d4E066FB41671DbB3Fd4f388E1",
      NEXT_PUBLIC_CASCADE_BIT_BLOCK: "9398120",
      NEXT_PUBLIC_CASCADE_VAULT_SS58: "5ELMyza1QBFKY1K6bbJXoPSENaiJVVTSQZBgdkQujxKpsfQn",
      NEXT_PUBLIC_CASCADE_HOTKEY_SS58: "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u",
      NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S: "86400",
      NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S: "86400",
    };
    const d = checkedDeployment(readDeployment(env)) as Deployment;
    expect(knownDeployment(d)).toBe("v3-launch");
    expect(d).toMatchObject({ batchMaxWaitS: 86_400, payoutDelayS: 86_400 });
    // the test deployments stay listed beside it
    expect(Object.keys(EXPECTED_DEPLOYMENTS)).toEqual(expect.arrayContaining(["v3-launch", "v3-test", "test-2026-10"]));
    // early: real money, a Ledger owner, no multisig or timelock yet
    expect(deploymentStage(d)).toBe("early");
  });

  it("give each deployment its stage: the launch early, the test deployments testing, anything else testing", () => {
    for (const [name, e] of Object.entries(EXPECTED_DEPLOYMENTS)) expect(["testing", "early", "live"], name).toContain(e.stage);
    expect(EXPECTED_DEPLOYMENTS["v3-launch"].stage).toBe("early");
    expect(EXPECTED_DEPLOYMENTS["v3-test"].stage).toBe("testing");
    expect(EXPECTED_DEPLOYMENTS["test-2026-10"].stage).toBe("testing");
    expect(deploymentStage(readDeployment(envOf("v3-test")))).toBe("testing");
    // no deployment, or one not listed (the build refuses it anyway): the most careful wording
    expect(deploymentStage(null)).toBe("testing");
    expect(deploymentStage({ ...(readDeployment(envOf("v3-launch")) as Deployment), frontDoor: OTHER })).toBe("testing");
  });

  it("fail closed: a stage that isn't exactly testing, early or live reads as testing", () => {
    const launch = readDeployment(envOf("v3-launch")) as Deployment;
    const listed = (stage: string) => ({ "v3-launch": { ...EXPECTED_DEPLOYMENTS["v3-launch"], stage } }) as unknown as Parameters<typeof deploymentStage>[1];
    for (const stage of ["Live", "live ", "launch", "", "LIVE", "early\n"]) expect(deploymentStage(launch, listed(stage)), JSON.stringify(stage)).toBe("testing");
    expect(deploymentStage(launch, listed("live"))).toBe("live");
    expect(deploymentStage(launch, listed("early"))).toBe("early");
  });

  it("unknownStageStillFailsClosedToTesting: with retired known, every other stage still reads as testing (Task 60)", () => {
    const launch = readDeployment(envOf("v3-launch")) as Deployment;
    const listed = (stage: unknown) => ({ "v3-launch": { ...EXPECTED_DEPLOYMENTS["v3-launch"], stage } }) as unknown as Parameters<typeof deploymentStage>[1];
    // retired exactly, and nothing near it
    expect(deploymentStage(launch, listed("retired"))).toBe("retired");
    for (const stage of ["Retired", "RETIRED", "retired ", " retired", "retire", "retired\n", "", undefined, null, 3, ["retired"]]) {
      expect(deploymentStage(launch, listed(stage)), JSON.stringify(stage)).toBe("testing");
    }
    // no deployment, or one not listed: testing too
    expect(deploymentStage(null, listed("retired"))).toBe("testing");
    expect(deploymentStage({ ...launch, frontDoor: OTHER }, listed("retired"))).toBe("testing");
    // every committed entry names one of the four, and v3-launch stays early until Task 69 retires it
    for (const [name, e] of Object.entries(EXPECTED_DEPLOYMENTS)) expect(["testing", "early", "live", "retired"], name).toContain(e.stage);
    expect(EXPECTED_DEPLOYMENTS["v3-launch"].stage).toBe("early");
  });

  it("words a retired deployment as the stage its entry says it was retired from, failing closed to testing (Task 60 follow-up)", () => {
    const launch = readDeployment(envOf("v3-launch")) as Deployment;
    const listed = (stage: string, retiredFrom?: unknown) =>
      ({ "v3-launch": { ...EXPECTED_DEPLOYMENTS["v3-launch"], stage, ...(retiredFrom !== undefined ? { retiredFrom } : {}) } }) as unknown as Parameters<typeof wordingStage>[1];
    for (const was of ["testing", "early", "live"]) expect(wordingStage(launch, listed("retired", was)), was).toBe(was);
    for (const bad of [undefined, "Live", "retired", "", 3]) expect(wordingStage(launch, listed("retired", bad)), JSON.stringify(bad)).toBe("testing");
    // not retired: the stage itself (an unknown one testing), whatever retiredFrom says
    expect(wordingStage(launch, listed("early", "live"))).toBe("early");
    expect(wordingStage(launch, listed("launch"))).toBe("testing");
    expect(wordingStage(launch)).toBe("early");
    // every retired entry says what it was retired from
    for (const [name, e] of Object.entries(EXPECTED_DEPLOYMENTS)) if (e.stage === "retired") expect(["testing", "early", "live"], name).toContain(e.retiredFrom);
  });

  it("pin the launch's 24-hour payout delay and batch wait: a build whose env says otherwise fails", () => {
    expect(EXPECTED_DEPLOYMENTS["v3-launch"]).toMatchObject({ payoutDelayS: 86_400, batchMaxWaitS: 86_400 });
    const launch = readDeployment(envOf("v3-launch")) as Deployment;
    expect(checkedDeployment(launch)).toBe(launch);
    expect(() => checkedDeployment({ ...launch, payoutDelayS: 3_600 })).toThrow(
      /NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S is 3600, but deployments\.json pins v3-launch's at 86400/,
    );
    expect(() => checkedDeployment({ ...launch, batchMaxWaitS: 600 })).toThrow(/NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S is 600, but deployments\.json pins v3-launch's at 86400/);
    // left out of the env: refused too
    const noDelay: Deployment = { ...launch };
    delete noDelay.payoutDelayS;
    expect(() => checkedDeployment(noDelay)).toThrow(/NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S is not set, but deployments\.json pins v3-launch's at 86400/);
    // a deployment that pins nothing keeps whatever the env says
    const test = readDeployment(envOf("v3-test")) as Deployment;
    expect(checkedDeployment({ ...test, payoutDelayS: 7_200 })).toMatchObject({ payoutDelayS: 7_200 });
  });

  it("give the launch's unstake limits, as its vault was set up (the FAQ quotes them)", () => {
    expect(EXPECTED_DEPLOYMENTS["v3-launch"].unstakeLimits).toEqual({ maxEntryTao: 10, dailyOutflowPct: 20, dailyFloorTao: 10 });
    expect(deploymentEntry(readDeployment(envOf("v3-launch")))?.unstakeLimits).toEqual({ maxEntryTao: 10, dailyOutflowPct: 20, dailyFloorTao: 10 });
    expect(deploymentEntry(null)).toBeUndefined();
  });

  it("include the deployment this checkout builds with (web/.env.local), when there is one", () => {
    const path = fileURLToPath(new URL("../../../.env.local", import.meta.url));
    if (!existsSync(path)) return;
    const env = Object.fromEntries(
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .filter((l) => /^NEXT_PUBLIC_[A-Z0-9_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
    );
    const d = readDeployment(env);
    if (d) expect(knownDeployment(d), "web/.env.local names a deployment missing from deployments.json").toBeDefined();
  });
});

describe("a v3.2 deployment: a v3 one with its two lenses", () => {
  const VAULT_LENS = getAddress("0x000000000000000000000000000000000000Ae15");
  const DOOR_LENS = getAddress("0x000000000000000000000000000000000000De15");
  /** The lenses, and the indexer a v3.2 build needs for its outside-price check (below). */
  const lenses = { NEXT_PUBLIC_CASCADE_VAULT_LENS: VAULT_LENS, NEXT_PUBLIC_CASCADE_DOOR_LENS: DOOR_LENS, NEXT_PUBLIC_CASCADE_INDEXER_URL: "https://api.cascadefi.xyz" };
  /** v3-test's addresses with lenses, as a v3.2 entry lists them. */
  const list = { "v3.2-x": { ...EXPECTED_DEPLOYMENTS["v3-test"], vaultLens: VAULT_LENS, doorLens: DOOR_LENS } };

  it("reads both lenses (pnpm ops web-config writes them), and only then is v3.2", () => {
    const d = readDeployment({ ...envOf("v3-test"), ...lenses }) as Deployment;
    expect(d).toMatchObject({ vaultLens: VAULT_LENS, doorLens: DOOR_LENS });
    expect(isV32(d)).toBe(true);
    expect(isV32(readDeployment(envOf("v3-test")) as Deployment)).toBe(false);
    expect(isV32(readDeployment(envOf("v3-launch")) as Deployment)).toBe(false);
  });

  it("refuses, loudly, half a v3.2 env, a lens not checksummed, or lenses without a v3 staker and oracle", () => {
    const v3 = { ...envOf("v3-test"), ...lenses };
    const broken: Record<string, Record<string, string | undefined>> = {
      "no door lens": { ...v3, NEXT_PUBLIC_CASCADE_DOOR_LENS: undefined },
      "no vault lens": { ...v3, NEXT_PUBLIC_CASCADE_VAULT_LENS: "" },
      "lens not checksummed": { ...v3, NEXT_PUBLIC_CASCADE_VAULT_LENS: VAULT_LENS.toLowerCase() },
      "lenses on v2": { ...envOf("test-2026-10"), ...lenses },
    };
    for (const [name, env] of Object.entries(broken)) expect(() => readDeployment(env), name).toThrow(/v3\.2 deployment/);
  });

  it("is known only with both its lenses, as listed; a listed v3 deployment never with lenses added", () => {
    const d = readDeployment({ ...envOf("v3-test"), ...lenses }) as Deployment;
    expect(knownDeployment(d, list)).toBe("v3.2-x");
    expect(knownDeployment({ ...d, vaultLens: OTHER }, list)).toBeUndefined();
    expect(knownDeployment({ ...d, doorLens: OTHER }, list)).toBeUndefined();
    expect(knownDeployment({ ...d, vaultLens: undefined, doorLens: undefined }, list)).toBeUndefined();
    // v3-launch and v3-test, as committed, have no lenses: a v3.2 env with their addresses is none of them
    expect(knownDeployment(d)).toBeUndefined();
    expect(knownDeployment(readDeployment(envOf("v3-launch")) as Deployment)).toBe("v3-launch");
  });

  it("needs the indexer: a v3.2 env without NEXT_PUBLIC_CASCADE_INDEXER_URL, or with one that isn't an https origin, fails the build, naming it", () => {
    const v32 = { ...envOf("v3-test"), ...lenses };
    // every stake and USDC unstake reads the outside price from it, and fails closed without it (price-veto.ts)
    for (const url of [undefined, "", "http://api.cascadefi.xyz", "https://api.cascadefi.xyz/", "https://api.cascadefi.xyz/v1"]) {
      expect(() => readDeployment({ ...v32, NEXT_PUBLIC_CASCADE_INDEXER_URL: url }), String(url)).toThrow(/NEXT_PUBLIC_CASCADE_INDEXER_URL/);
    }
    expect(readDeployment(v32)).toMatchObject({ indexerUrl: "https://api.cascadefi.xyz" });
    // v3-launch, v3-test and v2 build as before without one (v3-launch's flows have no veto)
    for (const name of ["v3-launch", "v3-test", "test-2026-10"]) expect(readDeployment(envOf(name))?.indexerUrl, name).toBeUndefined();
  });

  it("v3.2-launch (Task 67, deployed 2026-11-16): the env pnpm ops web-config wrote from the live record is that entry, a v3.2 deployment at the early stage with USDC delivery on", () => {
    // web/.env.local as written on deploy day, line for line
    const env = {
      NEXT_PUBLIC_CASCADE_FRONT_DOOR: "0xd1Ae29169146Ff62c9E9D4dC17c653B62fA3754e",
      NEXT_PUBLIC_CASCADE_BASE_ADAPTER: "0x0BEbdEbD94Ff1eD14a06E8fC055Afabd1465637E",
      NEXT_PUBLIC_CASCADE_STAKER: "0x371C5CFa5F5F6B3356fBC360EaD26066A2958B87",
      NEXT_PUBLIC_CASCADE_ORACLE: "0xDddd746237b923A0081630F4DcE7857De568696D",
      NEXT_PUBLIC_CASCADE_VAULT: "0x56544AfF15fccea33b4db189cB5B3726DBac724e",
      NEXT_PUBLIC_CASCADE_BIT_ADAPTER: "0x24B1b5eC0bB46c4F9850Ce9D75f7957eCB3B0027",
      NEXT_PUBLIC_CASCADE_BIT_BLOCK: "9520646",
      NEXT_PUBLIC_CASCADE_VAULT_SS58: "5G4DLACwJDTUhHtu62rCDqA7afCgd3m6f6TphYBShS1q6fTv",
      NEXT_PUBLIC_CASCADE_HOTKEY_SS58: "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u",
      NEXT_PUBLIC_CASCADE_VAULT_LENS: "0xc8b3b74261489ff544cF18335778498cd6f32010",
      NEXT_PUBLIC_CASCADE_DOOR_LENS: "0x9Da3e48fF7ab29AA277f37B0bC5B14c8Bbf96e7f",
      NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S: "86400",
      NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S: "86400",
      NEXT_PUBLIC_CASCADE_INDEXER_URL: INDEXER,
    };
    const d = checkedDeployment(readDeployment(env)) as Deployment;
    expect(knownDeployment(d)).toBe("v3.2-launch");
    expect(isV32(d)).toBe(true);
    expect([deploymentStage(d), wordingStage(d)]).toEqual(["early", "early"]);
    expect(deploymentEntry(d)).toMatchObject({ usdcDelivery: true, unstakeLimits: { maxEntryTao: 10, dailyOutflowPct: 20, dailyFloorTao: 10 } });
    expect(d.indexerUrl).toBe(INDEXER);
    // the helper's env for the entry is the same deployment
    expect(readDeployment(envOf("v3.2-launch"))).toEqual(d);
    // one address off and the build refuses it
    expect(() => checkedDeployment(readDeployment({ ...env, NEXT_PUBLIC_CASCADE_VAULT: OTHER }))).toThrow(/isn't in web\/src\/lib\/cascade\/deployments\.json/);
  });

  it("says whether a deployment's contract source is published: every listed one's is (v3.2-launch's since Task 70 published it, and its entry's sourcePublished: false went with that commit); only a listed false says no", () => {
    for (const [name, e] of Object.entries(EXPECTED_DEPLOYMENTS)) if (e.sourcePublished !== undefined) expect(typeof e.sourcePublished, name).toBe("boolean");
    expect(EXPECTED_DEPLOYMENTS["v3.2-launch"]).not.toHaveProperty("sourcePublished");
    for (const name of ["v3.2-launch", "v3-launch", "v3-test", "test-2026-10"]) expect(sourcePublished(readDeployment(envOf(name))), name).toBe(true);
    // no deployment, or one whose entry doesn't say: the site's words as they always were
    expect(sourcePublished(null)).toBe(true);
    // a list whose entry says false (a new deployment before its code is published) still says no, and only that
    const d = readDeployment(envOf("v3.2-launch")) as Deployment;
    const entry = EXPECTED_DEPLOYMENTS["v3.2-launch"];
    expect(sourcePublished(d, { "v3.2-launch": { ...entry, sourcePublished: false } })).toBe(false);
    expect(sourcePublished(d, { "v3.2-launch": entry })).toBe(true);
    expect(sourcePublished(d, { "v3.2-launch": { ...entry, sourcePublished: true } })).toBe(true);
  });

  it("lists, on every v3.2 entry, whether it offers USDC delivery, as a boolean; on no other entry is it off (Task 60)", () => {
    for (const [name, e] of Object.entries(EXPECTED_DEPLOYMENTS)) {
      if (e.vaultLens) expect(typeof e.usdcDelivery, name).toBe("boolean");
      else expect(e.usdcDelivery, name).not.toBe(false);
    }
  });

  it("lists, in deployments.json, both lenses or neither, checksummed, and only on a v3 entry", () => {
    for (const [name, e] of Object.entries(EXPECTED_DEPLOYMENTS)) {
      expect(!!e.vaultLens, name).toBe(!!e.doorLens);
      if (!e.vaultLens) continue;
      expect(e.version, name).toBe(3);
      for (const a of [e.vaultLens, e.doorLens]) expect(a && isAddress(a, { strict: true }) && a !== a.toLowerCase(), `${name} ${a}`).toBe(true);
    }
    // v3-launch stays as it is: v3, no lenses
    expect(EXPECTED_DEPLOYMENTS["v3-launch"]).not.toHaveProperty("vaultLens");
    expect(EXPECTED_DEPLOYMENTS["v3-launch"]).not.toHaveProperty("doorLens");
  });
});
