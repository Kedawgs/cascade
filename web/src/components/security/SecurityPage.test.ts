import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { cascadeKeys } from "@/lib/cascade/hooks";
import { goodFlow } from "@/lib/cascade/__fixtures__/flow-v1";
import type { FlowV1 } from "@/lib/cascade/flow";
import { flowView } from "@/lib/security-view";
import { plainText, renderWithCache } from "../test-render";
import { SecurityPage, selectStep, tabAfterKey } from "./SecurityPage";
import { ContractsSection } from "./SecuritySections";
import deployments from "@/lib/cascade/deployments.json";
import type { Deployment } from "@/lib/cascade/config";

const seed = (flow: FlowV1 | null) => [{ key: cascadeKeys.flow(), data: flow ? { flow, receivedAt: Date.now() } : null }];
const html = (flow: FlowV1 | null) => renderWithCache(createElement(SecurityPage), seed(flow));
const text = (flow: FlowV1 | null) => plainText(html(flow));
const healthy = () => {
  const f = goodFlow();
  f.backing.ratioPpm = 1_000_000;
  return f;
};
const viewOf = (f: FlowV1) => flowView({ flow: f, receivedAt: Date.now() }, Date.now());

describe("SecurityPage", () => {
  it("rendersTheMapAndHeadlines", () => {
    const t = text(healthy());
    expect(t).toContain("Where your money goes");
    expect(t).toContain("Every number is read straight from the chain, checked every minute, and links to where you can check it yourself.");
    expect(t).toContain("All checks passing, last checked 1 minute ago");
    for (const name of ["Your wallet", "Swap", "Backing", "Bridge", "Vault", "Validator"]) expect(t).toContain(name);
    for (const headline of ["You send USDC", "$800K", "100.00%", "80 TAO", "1,234.50 TAO", "tao.bot"]) expect(t, headline).toContain(headline);
    expect(t).toContain("Money in");
    expect(t).toContain("Money out");
  });

  it("selectedStepShowsDetails", () => {
    const v = viewOf(healthy());
    const bridge = selectStep(v, "in", "bridge");
    expect(bridge.figures.map((f) => f.label)).toEqual(expect.arrayContaining(["Room left", "Refills", "Transfers on the way"]));
    expect(bridge.link?.href).toMatch(/^https:\/\//);
  });

  it("shows the first step's details by default", () => {
    expect(text(healthy())).toContain("You start with USDC in your own wallet.");
  });

  it("staleShowsDashes", () => {
    const f = healthy();
    f.chains.bittensor = { block: "1", time: f.generatedAt - 700, stale: true };
    f.backing = { alphaBacking: null, wTaoSupply: null, lockPoolFmTao: null, fmTaoSupplyBase: null, ratioPpm: null };
    const t = text(f);
    expect(t).toContain("Waiting for a fresh reading");
    expect(t).not.toContain("All checks passing");
    expect(t).not.toContain("100.00%");
    expect(t).toContain("–");
  });

  it("cantCheckState", () => {
    const t = text(null);
    expect(t).toContain("We can't check right now");
    expect(t).toContain("none of the numbers below are current");
    expect(t).not.toMatch(/All checks passing/);
  });

  it("noticeRenders", () => {
    const f = healthy();
    f.notices = [{ kind: "paused", chain: "base", contract: f.addresses.frontDoor, tx: "0x" + "ab".repeat(32) }];
    const h = html(f);
    expect(plainText(h)).toContain("The front door is paused");
    expect(h).toContain("/tx/0x" + "ab".repeat(32));
  });

  it("is accessible: tablist, pressed steps, hidden arrows, live panel", () => {
    const h = html(healthy());
    expect(h).toContain('role="tablist"');
    expect(h.match(/role="tab"/g)).toHaveLength(2);
    expect(h).toContain('aria-selected="true"');
    expect(h).toContain('aria-pressed="true"');
    expect(h).toContain('aria-live="polite"');
    expect(h).toContain('aria-hidden="true"');
  });

  it("shows how the money is protected, with the home page's points", () => {
    const t = text(healthy());
    expect(t).toContain("How your money is protected");
    expect(t).toContain("We can't move your TAO without 7 days' public notice.");
    for (const point of ["Verifiable on-chain", "Open source", "Independent audit", "Built on Chainlink CCIP"]) expect(t).toContain(point);
  });

  it("lists the deployment's contracts on both chains, each with a copy button and its explorer", () => {
    const live = Object.values(deployments).find((x) => x.stage === "early")!;
    const h = renderWithCache(createElement(ContractsSection, { deployment: live as unknown as Deployment }), []);
    const t = plainText(h);
    expect(t).toContain("The contracts");
    for (const name of ["Swap contract", "Price check", "Front door", "Bridge adapter", "Vault"]) expect(t).toContain(name);
    expect(h).toMatch(/https:\/\/basescan\.org\/address\/0x[0-9a-fA-F]{40}/);
    expect(h).toMatch(/https:\/\/evm\.taostats\.io\/address\/0x[0-9a-fA-F]{40}/);
    expect(h).toContain("Copy the Bittensor Vault address");
  });

  it("names the risks, each pointing at where to watch it", () => {
    const t = text(healthy());
    expect(t).toContain("Risks to know");
    for (const watch of ["Read the code", "Watch the backing", "Watch the bridge", "Watch the validator", "Watch the swap"]) expect(t).toContain(watch);
    expect(t).toContain("only deposit what you could afford to lose");
  });

  it("ends with where to report a problem", () => {
    const h = html(healthy());
    expect(plainText(h)).toContain("Found a problem?");
    expect(h).toContain('href="https://github.com/Kedawgs/cascade/blob/main/SECURITY.md"');
  });

  it("noForbiddenWords", () => {
    const f = healthy();
    f.vault.paused = true;
    f.notices = [{ kind: "ownershipPending", chain: "base", contract: f.addresses.staker, target: "0xaa" }];
    // the page's own words: the shared footer's disclaimer ("not guaranteed") is outside <main>
    const main = (doc: FlowV1 | null) => plainText(html(doc).split("<main")[1]!.split("</main>")[0]!);
    for (const doc of [healthy(), f, null]) expect(main(doc)).not.toMatch(/\b(safe|secure|guarantee)/i);
  });
});

describe("selectStep", () => {
  it("selectStepDefaultsToFirst", () => {
    const v = viewOf(healthy());
    expect(selectStep(v, "in", null).id).toBe("wallet");
    expect(selectStep(v, "out", null).id).toBe("vaultOut");
  });
  it("selectStepSwitchesDirection", () => {
    const v = viewOf(healthy());
    expect(selectStep(v, "in", "swap").id).toBe("swap");
    // an id from the other direction falls back to the first of this one
    expect(selectStep(v, "out", "swap").id).toBe("vaultOut");
    expect(selectStep(v, "out", "bridgeBack").id).toBe("bridgeBack");
  });
});

describe("tabAfterKey", () => {
  it("moves between the two tabs with the arrow keys, wrapping, and Home/End", () => {
    expect(tabAfterKey("in", "ArrowRight")).toBe("out");
    expect(tabAfterKey("out", "ArrowRight")).toBe("in");
    expect(tabAfterKey("in", "ArrowLeft")).toBe("out");
    expect(tabAfterKey("out", "ArrowLeft")).toBe("in");
    expect(tabAfterKey("out", "Home")).toBe("in");
    expect(tabAfterKey("in", "End")).toBe("out");
    expect(tabAfterKey("in", "Enter")).toBeNull();
  });
  it("makes only the selected tab a tab stop", () => {
    const h = renderWithCache(createElement(SecurityPage), []);
    expect(h).toContain('tabindex="-1"');
  });
});
