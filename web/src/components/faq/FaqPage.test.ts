import { createElement } from "react";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { cascadeKeys } from "@/lib/cascade/hooks";
import { launchData, plainText, renderWithCache } from "../test-render";
import { FaqBody } from "./FaqBody";

// Task 60 (Task 58's concern 5): the FAQ follows the deployment. On v3.2 the reward vesting period is the owner's
// setting, read from the vault lens, never v3-launch's constant 7 days.

const LENSES = { vaultLens: "0x000000000000000000000000000000000000Ae15" as Address, doorLens: "0x000000000000000000000000000000000000De15" as Address };

describe("the FAQ page's answers on v3.2 (Task 60)", () => {
  it("say the vesting period the lens reads, once it is read, and no figure before", () => {
    const vesting = (vestingPeriodS: number) => [{ key: cascadeKeys.rewardVesting(), data: { rewardVestingS: 3 * 86_400, vestingPeriodS } }];
    const read = plainText(renderWithCache(createElement(FaqBody), vesting(0), { data: launchData(undefined, LENSES) }));
    expect(read).toContain("gradually over 3 days");
    expect(read).toContain("still being added to balances over 3 days");
    expect(read).not.toContain("over 7 days");
    // a longer schedule still running after a lowering: the leaving answer says it (review, Minor 4)
    const lowered = plainText(renderWithCache(createElement(FaqBody), vesting(10 * 86_400), { data: launchData(undefined, LENSES) }));
    expect(lowered).toContain("gradually over 3 days");
    expect(lowered).toContain("still being added to balances over 10 days");
    const unread = plainText(renderWithCache(createElement(FaqBody), [], { data: launchData(undefined, LENSES) }));
    expect(unread).toContain("over a period Cascade sets, from 1 to 30 days");
    expect(unread).not.toContain("over 7 days");
  });

  it("say an adopted gift's own drip while it runs and is the longest (Revision 27)", () => {
    const gift = [{ key: cascadeKeys.rewardVesting(), data: { rewardVestingS: 3 * 86_400, vestingPeriodS: 3 * 86_400, adoptVestingPeriodS: 10 * 86_400 } }];
    const text = plainText(renderWithCache(createElement(FaqBody), gift, { data: launchData(undefined, LENSES) }));
    // the claimed rewards keep the owner's period; what is still being added runs as long as the gift's drip
    expect(text).toContain("gradually over 3 days");
    expect(text).toContain("still being added to balances over 10 days");
  });

  it("keep v3-launch's 7 days", () => {
    expect(plainText(renderWithCache(createElement(FaqBody), [], { data: launchData() }))).toContain("gradually over 7 days");
  });
});
