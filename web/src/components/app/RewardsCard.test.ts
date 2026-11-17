import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { cascadeKeys } from "@/lib/cascade/hooks";
import type { Position } from "@/lib/cascade/types";
import { FAQ_FACTS } from "@/lib/faq";
import { type Cached, plainText, renderWithCache } from "../test-render";
import { RewardsCard, rewardsSchedule } from "./RewardsCard";

const file = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const ME = "0x1234567890abcdef1234567890abcdef12345678";
const position: Position = { shares: 8n * 10n ** 22n, taoWei: 8n * 10n ** 16n, taoBalance: 0.08, usdValue: 20, taoPriceUsd: 250 };
const ready: Cached[] = [
  { key: cascadeKeys.position(ME), data: position },
  { key: cascadeKeys.rewards(ME), data: [] },
];

describe("how rewards reach a balance, in one sentence", () => {
  it("v3.2: how often they are collected (the keeper's round) and how long they take to be added (the vault's period)", () => {
    expect(FAQ_FACTS.v32.claimRoundDays).toBe(28);
    expect(rewardsSchedule({ v32: true, vestingS: 30 * 86_400 })).toBe(
      "Cascade collects rewards for everyone at least every 28 days, then adds them to balances gradually over 30 days.",
    );
    expect(rewardsSchedule({ v32: true, vestingS: 7 * 86_400 })).toContain("gradually over 7 days.");
  });

  it("v3.2, the period not read yet (or unreadable): its limit, never a guess of the figure", () => {
    for (const vestingS of [undefined, 0, Number.NaN]) {
      expect(rewardsSchedule({ v32: true, vestingS })).toBe(
        "Cascade collects rewards for everyone at least every 28 days, then adds them to balances gradually over up to 30 days.",
      );
    }
  });

  it("every other deployment: collected when enough waits, added over its vault's constant", () => {
    expect(rewardsSchedule({ v32: false })).toBe("Cascade collects rewards for everyone when enough is waiting, then adds them to balances gradually over 7 days.");
  });
});

describe("the Rewards card under its summary", () => {
  it("with no wallet: the sentence, where rewards will show, the FAQ's answer, then the connect button (one paragraph, not two)", () => {
    const html = renderWithCache(createElement(RewardsCard, { account: null }));
    expect(html.match(/<p class="_note_[^"]*">/g)).toHaveLength(1);
    expect(plainText(html)).toContain("gradually over 7 days. Yours show here as they are added. How rewards work");
    expect(html).toMatch(/<a href="\/faq\/?#how-rewards-arrive">How rewards work<\/a>/);
    expect(html).not.toContain("Your rewards show here once the first ones are collected");
    // the answer it links to exists
    expect(file("../../lib/faq.ts")).toContain('id: "how-rewards-arrive"');
  });

  it("with a wallet and nothing added yet: the same single paragraph, no list", () => {
    const html = renderWithCache(createElement(RewardsCard, { account: ME }), ready);
    expect(html.match(/<p class="_note_[^"]*">/g)).toHaveLength(1);
    expect(plainText(html)).toContain("Yours show here as they are added.");
    expect(html).not.toContain("Recent rewards");
  });

  it("with rewards added: the sentence without the 'yours show here' line, then the list", () => {
    const rewards = [{ date: new Date(2026, 10, 14), taoAccrued: 0.0001, runningTotalTao: 0.0001 }];
    const html = renderWithCache(createElement(RewardsCard, { account: ME }), [ready[0], { key: cascadeKeys.rewards(ME), data: rewards }]);
    expect(plainText(html)).not.toContain("Yours show here");
    expect(html.indexOf("_note_")).toBeLessThan(html.indexOf('aria-label="Recent rewards"'));
  });

  it("what waits and the sentence share one left edge, on a phone too (the phone's rule comes after theirs)", () => {
    const css = file("./RewardsCard.module.css");
    const rule = (selector: string) => {
      const at = css.indexOf(`\n${selector} {`);
      expect(at, selector).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf("}", at)).replace(/\s+/g, " ");
    };
    expect(rule(".waiting")).toContain("padding: 18px 24px 0;");
    expect(rule(".note")).toContain("padding: 16px 24px 22px;");
    expect(rule(".note")).not.toContain("text-align");
    const phone = css.indexOf("@media (max-width: 480px)");
    for (const selector of [".waiting {", ".note {", ".list {", ".connect {"]) expect(css.indexOf(`\n${selector}`), selector).toBeLessThan(phone);
    expect(css.slice(phone).replace(/\s+/g, " ")).toContain(".list, .waiting, .note, .connect { padding-left: 18px; padding-right: 18px; }");
  });
});
