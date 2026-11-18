import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { cascadeKeys } from "@/lib/cascade/hooks";
import { goodFlow } from "@/lib/cascade/__fixtures__/flow-v1";
import type { FlowV1 } from "@/lib/cascade/flow";
import { flowView } from "@/lib/security-view";
import { plainText, renderWithCache } from "../test-render";
import { DirectExit, SecurityPage, selectStep, tabAfterKey } from "./SecurityPage";
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
    expect(t).toContain("Follow a deposit from your wallet to the validator, and back. Pick any step to see its live numbers.");
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

  it("shows a figure's place, never a number, while the first reading is on its way; a dash once there is none", () => {
    // the first HTML and a visit before the monitor answers: nothing cached, the read running
    const client = new QueryClient();
    client.getQueryCache().build(client, { queryKey: cascadeKeys.flow() }).setState({ fetchStatus: "fetching" });
    const loading = renderWithCache(createElement(SecurityPage), [], { client });
    expect(plainText(loading)).toContain("Checking the chain…");
    // the top's five live figures (backing, last check, pool depth, deposit cost, bridge room) and the map's: places
    expect((loading.match(/data-figure="loading"/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(loading).not.toContain('data-figure="none"');
    for (const made of ["0.0%", "$0", "0 TAO"]) expect(plainText(loading), made).not.toContain(made);
    // what is not read from the chain is there from the start
    expect(plainText(loading)).toContain("7 days");
    // the read came back with nothing (the monitor unreachable): dashes, and no shimmer left running
    const none = html(null);
    expect(none).toContain('data-figure="none"');
    expect(none).not.toContain('data-figure="loading"');
    // a reading: the figures themselves
    const live = html(healthy());
    expect(live).not.toContain('data-figure="loading"');
    expect(plainText(live)).toContain("100.00%");
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
    expect(plainText(h)).toContain("New deposits and automatic USDC payouts wait until it is unpaused. Unstake requests, cancels and claims still work.");
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

  it("opens with the page's name, its two lead figures and a row of live ones", () => {
    const h = html(healthy());
    const t = plainText(h);
    expect(h.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(t).toContain("Live on-chain");
    expect(t).toContain("Security");
    for (const label of ["Bridged TAO backed", "Last on-chain check", "Pool depth on Base", "About what a $1,000 deposit costs", "Bridge room to Bittensor", "Public notice before a new bridge or front door"])
      expect(t, label).toContain(label);
    expect(t).toContain("100.00%");
    expect(h).toContain('href="#flow"');
    expect(t).toContain("The live numbers on this page are read from the chain every minute, each with a link to check it yourself.");
    expect(t).not.toContain("any contract change");
  });

  it("shows how the money is protected, with the home page's points", () => {
    const t = text(healthy());
    expect(t).toContain("How your money is protected");
    expect(t).toContain("Your TAO sits in an open-source contract anyone can read. Sensitive changes are timelocked: 48 hours for settings, 7 days for a new bridge or front door.");
    for (const point of ["Verifiable on-chain", "Open source", "Independent audit", "Built on Chainlink CCIP"]) expect(t).toContain(point);
    // the bridge's live figures are in the map above the grid
    expect(t).toContain("Your TAO crosses chains over Chainlink's CCIP bridge. Its limits and anything in transit are shown above.");
    expect(t).not.toMatch(/largest DeFi|auditable/);
  });

  it("lists the deployment's contracts on both chains, each with a copy button and a link to its verified source", () => {
    const live = Object.values(deployments).find((x) => x.stage === "early")!;
    const h = renderWithCache(createElement(ContractsSection, { deployment: live as unknown as Deployment }), []);
    const t = plainText(h);
    expect(t).toContain("The contracts");
    for (const name of ["Swap contract", "Price check", "Front door", "Bridge adapter", "Vault"]) expect(t).toContain(name);
    // the live (v3.2) deployment: each contract's code on Sourcify, by chain (Base 8453, Bittensor 964), and the link says so
    expect(h.match(/https:\/\/repo\.sourcify\.dev\/8453\/0x[0-9a-fA-F]{40}/g)).toHaveLength(4);
    expect(h.match(/https:\/\/repo\.sourcify\.dev\/964\/0x[0-9a-fA-F]{40}/g)).toHaveLength(2);
    expect(t.match(/Read its code on Sourcify ↗/g)).toHaveLength(6);
    expect(h).not.toMatch(/evm\.taostats\.io\/address|basescan\.org\/address/);
    expect(h).toContain("Copy the Bittensor Vault address");
  });

  it("names the risks, each pointing at where to watch it", () => {
    const t = text(healthy());
    expect(t).toContain("Risks to know");
    for (const watch of ["Read the code", "Who controls Cascade", "Watch the backing", "Watch the bridge", "Watch the validator", "Watch the swap", "Watch the queue"]) expect(t).toContain(watch);
    expect(t).toContain("only deposit what you could afford to lose");
    // the FAQ's answer opens on this site, in the same tab
    expect(html(healthy())).toMatch(/<a[^>]*href="\/faq\/#who-controls"(?![^>]*target)[^>]*>Who controls Cascade/);
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

describe("DirectExit", () => {
  it("names the way out on Bittensor under the money-out map, on v3.2 only", () => {
    // v3-launch by name: v3.2-launch is at the early stage too, and has its lenses
    const launch = deployments["v3-launch"] as unknown as Deployment;
    expect(launch).not.toHaveProperty("vaultLens");
    const v32 = { ...launch, vaultLens: "0x000000000000000000000000000000000000Ae15", doorLens: "0x000000000000000000000000000000000000De15" } as Deployment;
    const h = renderWithCache(createElement(DirectExit, { deployment: v32 }), []);
    expect(plainText(h)).toBe("There is a second way out that skips Base and the bridge: a regular wallet can withdraw straight from the vault on Bittensor.");
    expect(h).toMatch(/href="\/unstake\/bittensor\/?"/);
    for (const d of [launch, null]) expect(renderWithCache(createElement(DirectExit, { deployment: d }), [])).toBe("");
    // the live v3.2 entry, as listed, names it too
    expect(plainText(renderWithCache(createElement(DirectExit, { deployment: deployments["v3.2-launch"] as unknown as Deployment }), []))).toMatch(/second way out/);
  });
});

describe("selectStep", () => {
  it("selectStepDefaultsToFirst", () => {
    const v = viewOf(healthy());
    expect(selectStep(v, "in", null).id).toBe("wallet");
    expect(selectStep(v, "out", null).id).toBe("request");
  });
  it("selectStepSwitchesDirection", () => {
    const v = viewOf(healthy());
    expect(selectStep(v, "in", "swap").id).toBe("swap");
    // an id from the other direction falls back to the first of this one
    expect(selectStep(v, "out", "swap").id).toBe("request");
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
