import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { cascadeKeys } from "@/lib/cascade/hooks";
import type { Available, Position, PositionHistory } from "@/lib/cascade/types";
import { type Cached, plainText, renderWithCache } from "../test-render";
import { RewardsCard } from "./RewardsCard";
import { StakedSummary } from "./StakeCard";
import { UnstakeSummary } from "./UnstakeScreen";

const ME = "0x1234567890abcdef1234567890abcdef12345678";
const position: Position = { shares: 8n * 10n ** 22n, taoWei: 8n * 10n ** 16n, taoBalance: 0.08, usdValue: 20, taoPriceUsd: 250 };
const available: Available = { availableShares: 7n * 10n ** 22n, availableTaoWei: 7n * 10n ** 16n };
const history: PositionHistory = { pendingTao: 0, rewardsEarnedTao: 0.02, avgEntryPriceUsd: 240 };

const POSITION: Cached = { key: cascadeKeys.position(ME), data: position };
const text = (el: Parameters<typeof renderWithCache>[0], cached: Cached[]) => plainText(renderWithCache(el, cached));

describe("the balance, before the vault's history is read", () => {
  it("shows what is staked from the contract reads alone", () => {
    expect(text(createElement(StakedSummary, { account: ME }), [POSITION])).toContain("Staked0.08 TAO $20.00");
  });

  it("keeps a dash in the balance's place while it loads, and says when it can't be shown", () => {
    expect(text(createElement(StakedSummary, { account: ME }), [])).toContain("Staked–Loading");
    expect(text(createElement(StakedSummary, { account: ME }), [{ ...POSITION, failed: true }])).toContain("Staked–Not available");
  });
});

describe("Unstake summary", () => {
  it("shows the balance while what can be unstaked is still being worked out", () => {
    const t = text(createElement(UnstakeSummary, { account: ME }), [POSITION]);
    expect(t).toContain("Staked0.0800 TAO$20.00");
    expect(t).toContain("Available to unstake–Loading");
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
    const t = text(createElement(RewardsCard, { account: ME }), ready);
    expect(t).toContain("Earned so far–Loading");
    expect(t).toContain("TAO price");
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
});
