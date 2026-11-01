import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { cascadeKeys } from "@/lib/cascade/hooks";
import { goodFlow } from "@/lib/cascade/__fixtures__/flow-v1";
import type { FlowV1 } from "@/lib/cascade/flow";
import { flowView } from "@/lib/security-view";
import { plainText, renderWithCache } from "../test-render";
import { SecurityPage, selectStep, tabAfterKey } from "./SecurityPage";

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
