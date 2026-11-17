import { describe, expect, it } from "vitest";
import type { Deployment } from "./cascade/config";
import { contractsLabel, contractsOf, risksFor } from "./security-content";

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
      expect(r.linkLabel).toBe("Read it on the explorer");
      expect(r.does.length).toBeGreaterThan(20);
    }
  });

  it("a v3.2 deployment's contracts link to their verified source on Sourcify, by chain id, and say so", () => {
    const v32 = { ...d, vaultLens: "0xc8b3b74261489ff544cF18335778498cd6f32010", doorLens: "0x9Da3e48fF7ab29AA277f37B0bC5B14c8Bbf96e7f" } as unknown as Deployment;
    const rows = contractsOf(v32);
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.href).toBe(`https://repo.sourcify.dev/${r.chain === "Base" ? 8453 : 964}/${r.address}`);
      expect(r.linkLabel).toBe("Read its code on Sourcify");
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
  it("names seven risks, each with a place to watch it", () => {
    const risks = risksFor("https://github.com/Kedawgs/cascade");
    expect(risks.map((r) => r.title)).toEqual(["The contracts", "The keys", "The bridged TAO", "The bridge", "The validator", "Swap prices", "Getting out"]);
    expect(risks[0]!.watch).toEqual({ kind: "link", href: "https://github.com/Kedawgs/cascade", label: "Read the code" });
    expect(risks[1]!.watch).toEqual({ kind: "link", href: "/faq/#who-controls", label: "Who controls Cascade" });
    // until the deployment's code is published there is no code to read: the contracts' risk points at what was checked
    const unpublished = risksFor("https://github.com/Kedawgs/cascade", false);
    expect(unpublished[0]!.watch).toEqual({ kind: "link", href: "/faq/#audited", label: "What has been checked" });
    expect(unpublished.slice(1)).toEqual(risks.slice(1));
    expect(JSON.stringify(unpublished)).not.toMatch(/Read the code|open source/i);
    // and the count of contracts says "open source" only then
    expect([contractsLabel(true), contractsLabel(false)]).toEqual(["Contracts, all open source", "Contracts your money passes through"]);
    expect(risks.slice(2).map((r) => (r.watch.kind === "step" ? `${r.watch.dir}:${r.watch.id}` : null))).toEqual(["in:backing", "in:bridge", "in:validator", "in:swap", "out:vaultOut"]);
  });

  it("says each risk as it is on v3.2 (the web copy audit)", () => {
    const body = (title: string) => risksFor("https://x").find((r) => r.title === title)!.body;
    expect(body("The keys")).toBe(
      "One hardware wallet owns the contracts for now, with no multi-signature yet. Changes that loosen a protection wait in public, 48 hours to 8 days, and show at the top of this page. If the keys were stolen, exits could be frozen or badly limited.",
    );
    expect(body("The bridged TAO")).toBe(
      "Your staked TAO is real TAO on Bittensor. ForeverMoney's bridged TAO is what carries it across: you hold it while a deposit waits on Base and when a payout comes back. If its backing fell short, that TAO would be worth less. And if ForeverMoney pauses or moves, unstaking through Base waits.",
    );
    expect(body("The bridge")).toBe(
      "Chainlink's bridge caps how much can cross at a time. When it's full, deposits and payouts wait until it refills. If the bridge itself were compromised, it could forge unstakes, but only up to a day's allowance, and each waits 24 hours before paying, so it can be cancelled.",
    );
    expect(body("The validator")).toBe(
      "Rewards come from the validator the vault stakes with. If it went offline or raised its cut, rewards would fall until the stake moved. If it changes its key, deposits and unstakes wait until the new key is listed.",
    );
    expect(body("Getting out")).toBe(
      "Unstaking through Base has a daily limit shared first come first served, a 24-hour wait, and a one-day hold on new deposits. In a rush it can take days.",
    );
  });

  it("never claims safety", () => {
    for (const r of risksFor("https://x")) expect(`${r.title} ${r.body} ${r.watch.label}`).not.toMatch(/\b(safe|secure|guarantee)/i);
  });
});
