import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress } from "viem";
import { describe, expect, it } from "vitest";
import { checkedDeployment, type Deployment, deploymentStage, EXPECTED_DEPLOYMENTS, knownDeployment, readDeployment } from "./config";

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
    ...(e.version === 3 ? { NEXT_PUBLIC_CASCADE_STAKER: e.staker!, NEXT_PUBLIC_CASCADE_ORACLE: e.oracle!, NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S: "3600" } : {}),
  };
}

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
