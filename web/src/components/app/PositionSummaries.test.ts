import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { cascadeKeys } from "@/lib/cascade/hooks";
import type { Available, Position, PositionHistory } from "@/lib/cascade/types";
import { type Cached, launchData, plainText, renderWithCache, shownText, spokenText } from "../test-render";
import { RewardsCard } from "./RewardsCard";
import { StakeCard, StakedSummary } from "./StakeCard";
import { UnstakeForm } from "./UnstakeForm";
import { UnstakeSummary } from "./UnstakeScreen";

const ME = "0x1234567890abcdef1234567890abcdef12345678";
const position: Position = { shares: 8n * 10n ** 22n, taoWei: 8n * 10n ** 16n, taoBalance: 0.08, usdValue: 20, taoPriceUsd: 250 };
const available: Available = { availableShares: 7n * 10n ** 22n, availableTaoWei: 7n * 10n ** 16n };
const history: PositionHistory = { pendingTao: 0, rewardsEarnedTao: 0.02, avgEntryPriceUsd: 240 };

const POSITION: Cached = { key: cascadeKeys.position(ME), data: position };
const text = (el: Parameters<typeof renderWithCache>[0], cached: Cached[]) => plainText(renderWithCache(el, cached));

describe("the balance, before the vault's history is read", () => {
  it("shows what is staked from the contract reads alone", () => {
    expect(text(createElement(StakedSummary, { account: ME }), [POSITION])).toContain("Your stake0.08 TAO $20.00");
  });

  it("keeps a skeleton in the balance's place while it loads (no dash, no number), and a dash when it can't be shown", () => {
    const loading = renderWithCache(createElement(StakedSummary, { account: ME }), []);
    expect(spokenText(loading)).toContain("Your stakeLoading");
    expect(shownText(loading)).toBe("Your stake");
    expect(loading).toContain('data-figure="loading"');
    expect(text(createElement(StakedSummary, { account: ME }), [{ ...POSITION, failed: true }])).toContain("Your stake–Not available");
  });

  it("never fills it from what the browser remembers: with a store full of figures from an earlier visit, the stake is still read from the chain", () => {
    const m = new Map<string, string>();
    const read: string[] = [];
    const storage = { getItem: (k: string) => (read.push(k), m.get(k) ?? null), setItem: (k: string, v: string) => void m.set(k, v) };
    const data = launchData(undefined, {}, { storage });
    data.figures.remember("apy", 9.9);
    data.figures.remember("staked", 99.5);
    data.figures.remember("price", 999.99);
    const stake = renderWithCache(createElement(StakedSummary, { account: ME }), [], { data });
    expect(shownText(stake)).toBe("Your stake");
    const summary = renderWithCache(createElement(UnstakeSummary, { account: ME }), [], { data });
    expect(shownText(summary)).toBe("Your stakeAvailable to unstake");
    // with the stake read: its own dollars (the position's price), nothing of the remembered price
    const known = shownText(renderWithCache(createElement(StakedSummary, { account: ME }), [POSITION], { data }));
    expect(known).toBe("Your stake0.08 TAO $20.00");
    // the store holds nothing but the three public figures, and none of these renders read it
    expect([...m.keys()].map((k) => k.split(".").pop()).sort()).toEqual(["apy", "price", "staked"]);
    expect(read).toEqual([]);
  });
});

describe("Your USDC, on the stake card", () => {
  const card = (account: string | null) => renderWithCache(createElement(StakeCard, { account }), [], { data: launchData() });

  it("keeps a skeleton in the balance's place while the wallet's balance is read, never a remembered balance", () => {
    const h = card(ME);
    expect(spokenText(h)).toContain("Your USDCLoadingYour stakeLoading");
    expect(shownText(h)).toContain("Your USDCYour stake");
  });

  it("shows the plain dash with no wallet connected: nothing is being read", () => {
    const h = card(null);
    expect(shownText(h)).toContain("Your USDC–Your stake–");
    expect(spokenText(h)).not.toContain("Your USDCLoading");
  });
});

describe("Unstake summary", () => {
  it("shows the balance while what can be unstaked is still being worked out", () => {
    const h = renderWithCache(createElement(UnstakeSummary, { account: ME }), [POSITION]);
    expect(plainText(h)).toContain("Your stake0.0800 TAO$20.00");
    expect(spokenText(h)).toContain("Available to unstakeLoading");
    expect(shownText(h)).toBe("Your stake0.0800 TAO$20.00Available to unstake");
  });

  it("shows what can be unstaked once it is known, keeping it through a failed read", () => {
    for (const failed of [false, true]) {
      expect(text(createElement(UnstakeSummary, { account: ME }), [POSITION, { key: cascadeKeys.available(ME), data: available, failed }])).toContain(
        "Available to unstake$17.500.0700 TAO",
      );
    }
  });
});

describe("Rewards card", () => {
  const ready: Cached[] = [POSITION, { key: cascadeKeys.rewards(ME), data: [] }];

  it("shows the card with a dash for what was earned until the vault's history has been read", () => {
    const h = renderWithCache(createElement(RewardsCard, { account: ME }), ready);
    // a skeleton for what was earned and for the TAO price, each read out as Loading; no dash while they load
    expect(spokenText(h)).toContain("Earned so farLoadingTAO priceLoading");
    expect(shownText(h)).toContain("Earned so farTAO price");
    expect(h.match(/data-figure="loading"/g)).toHaveLength(2);
  });

  it("shows what was earned once the history is in, keeping it through a failed read", () => {
    for (const failed of [false, true]) {
      expect(text(createElement(RewardsCard, { account: ME }), [...ready, { key: cascadeKeys.history(ME), data: history, failed }])).toContain(
        "Earned so far$5.00 0.020000 TAO",
      );
    }
    // no deposit yet: nothing earned to show
    expect(
      text(createElement(RewardsCard, { account: ME }), [...ready, { key: cascadeKeys.history(ME), data: { pendingTao: 0, avgEntryPriceUsd: null } }]),
    ).toContain("Earned so far–TAO price");
  });

  it("shows no figure, only 'checking…', while the history came from the indexer and this browser hasn't read it all itself", () => {
    const provisional: PositionHistory = { pendingTao: 0, avgEntryPriceUsd: null, provisional: true };
    const t = text(createElement(RewardsCard, { account: ME }), [...ready, { key: cascadeKeys.history(ME), data: provisional }]);
    expect(t).toContain("Earned so far–checking…");
    expect(t).not.toMatch(/\$\d/);
    expect(text(createElement(RewardsCard, { account: ME }), [...ready, { key: cascadeKeys.history(ME), data: history }])).not.toContain("checking");
  });
});

describe("Unstake form", () => {
  it("says which read failed: the balance, or what can be unstaked", () => {
    const AVAILABLE: Cached = { key: cascadeKeys.available(ME), data: available };
    expect(text(createElement(UnstakeForm, { account: ME }), [{ ...POSITION, failed: true }, AVAILABLE])).toContain("We couldn't load your balance just now.");
    expect(text(createElement(UnstakeForm, { account: ME }), [POSITION, { ...AVAILABLE, failed: true }])).toContain(
      "We couldn't load what you can unstake just now.",
    );
  });
});
