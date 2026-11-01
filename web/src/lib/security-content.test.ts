import { describe, expect, it } from "vitest";
import type { Deployment } from "./cascade/config";
import { contractsOf, risksFor } from "./security-content";

const d = {
  frontDoor: "0xbAe5417A40613141790624bCeF6BaFc3b24ff9AA",
  baseAdapter: "0xF2B3A36185e74ddCf8Ea9A174c06b75520F47F92",
  staker: "0xe33012f8ae80E17a7D7B8d9249043dB01D27e59E",
  oracle: "0xcAa85F00b6e470Dd28a31FBa982267B820736eBc",
  vault: "0x450cD94401B45c72C09734071fe683F6b74Aea72",
  bitAdapter: "0x002d7C6b2A6062d4E066FB41671DbB3Fd4f388E1",
} as unknown as Deployment;

describe("contractsOf", () => {
  it("lists every contract of a v3 deployment, Base first, each linked to its chain's explorer", () => {
    const rows = contractsOf(d);
    expect(rows.map((r) => `${r.chain}:${r.name}`)).toEqual([
      "Base:Swap contract",
      "Base:Price check",
      "Base:Front door",
      "Base:Bridge adapter",
      "Bittensor:Vault",
      "Bittensor:Bridge adapter",
    ]);
    for (const r of rows) {
      expect(r.href).toBe(r.chain === "Base" ? `https://basescan.org/address/${r.address}` : `https://evm.taostats.io/address/${r.address}`);
      expect(r.does.length).toBeGreaterThan(20);
    }
  });

  it("leaves out the staker and the oracle a deployment doesn't have, and lists nothing without one", () => {
    const v2 = { ...d, staker: undefined, oracle: undefined } as unknown as Deployment;
    expect(contractsOf(v2).map((r) => r.name)).not.toContain("Swap contract");
    expect(contractsOf(v2).map((r) => r.name)).not.toContain("Price check");
    expect(contractsOf(null)).toEqual([]);
  });
});

describe("risksFor", () => {
  it("names five risks, each with a place to watch it", () => {
    const risks = risksFor("https://github.com/Kedawgs/cascade");
    expect(risks.map((r) => r.title)).toEqual(["The contracts", "The bridged TAO", "The bridge", "The validator", "Swap prices"]);
    expect(risks[0]!.watch).toEqual({ kind: "link", href: "https://github.com/Kedawgs/cascade", label: "Read the code" });
    expect(risks.slice(1).map((r) => (r.watch.kind === "step" ? r.watch.id : null))).toEqual(["backing", "bridge", "validator", "swap"]);
  });

  it("never claims safety", () => {
    for (const r of risksFor("https://x")) expect(`${r.title} ${r.body} ${r.watch.label}`).not.toMatch(/\b(safe|secure|guarantee)/i);
  });
});
