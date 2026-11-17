import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { cascadeKeys } from "@/lib/cascade/hooks";
import { faqSections } from "@/lib/faq";
import { APY_FOOTNOTE, APY_NOTE_SHORT } from "@/lib/stats";
import { type Cached, plainText, renderWithCache, shownText, spokenText } from "../test-render";
import { Hero } from "./Hero";

const DAY = 86_400_000;
const html = (cached: Cached[] = [], seededAt?: number) => renderWithCache(createElement(Hero), cached, { seededAt });
const hero = (cached: Cached[] = [], seededAt?: number) => plainText(html(cached, seededAt));
const apy = (data?: number, over: Partial<Cached> = {}): Cached => ({ key: cascadeKeys.apy(), data, ...over });
/** The total staked (Bittensor's read) and the TAO price (Base's own), both dated alike. */
const stats = (totalStakedTao: number, over: Partial<Cached> = {}): Cached[] => [
  { key: cascadeKeys.stats(), data: { totalStakedTao }, ...over },
  { key: cascadeKeys.taoPrice(), data: 255, ...over },
];

describe("Hero", () => {
  it("has the snapshot's APY and its footnote in the first HTML", () => {
    const text = hero([apy(5.362), ...stats(0)]);
    expect(text).toContain("5.4%APY in TAO*");
    expect(text).toContain(APY_NOTE_SHORT);
  });

  it("shows each figure once on screen and reads it out once: the node that counts to a new value is hidden from screen readers, which read its twin", () => {
    const h = html([apy(5.362), ...stats(10)]);
    expect(shownText(h)).toContain("5.4%APY in TAO*$2.6KTotal staked");
    expect(spokenText(h)).toContain("5.4%APY in TAO*$2.6KTotal staked");
    expect(h.match(/data-figure="value"/g)).toHaveLength(2);
  });

  it("keeps the APY's place and the footnote while the APY loads: a skeleton in it, read out as Loading, no dash and no number", () => {
    const h = html();
    expect(spokenText(h)).toContain("LoadingAPY in TAO*");
    expect(shownText(h)).toContain("APY in TAO*");
    expect(shownText(h)).not.toContain("–APY in TAO*");
    expect(h).toMatch(/data-figure="loading"[^>]*><\/span><span class="sr-only[^"]*">Loading<\/span><\/p><p[^>]*>APY in TAO\*/);
    expect(plainText(h)).toContain(APY_NOTE_SHORT);
  });

  it("keeps its footnote short, with the full account a link away in the FAQ", () => {
    const h = renderWithCache(createElement(Hero), [apy(5.4)]);
    expect(plainText(h)).toContain(`${APY_NOTE_SHORT} How it's worked out`);
    expect(plainText(h)).not.toContain(APY_FOOTNOTE);
    expect(h).toMatch(/href="\/faq\/?#apy"/);
    // the link lands on a real answer: renaming that question's id would break it
    expect(faqSections(null).flatMap((x) => x.items.map((i) => i.id))).toContain("apy");
  });

  it("keeps showing the APY through a failed read, for up to 14 days", () => {
    expect(hero([apy(5.4, { at: Date.now() - 13 * DAY, failed: true })])).toContain("5.4%APY in TAO*");
  });

  it("shows a dash in the APY's place once a failed read leaves only an older value", () => {
    const text = hero([apy(5.4, { at: Date.now() - 15 * DAY, failed: true })]);
    expect(text).toContain("–Not availableAPY in TAO*");
    expect(text).toContain(APY_NOTE_SHORT);
  });

  it("shows the total staked from a dollar up", () => {
    expect(hero([apy(5.4), ...stats(0)])).not.toContain("Total staked");
    expect(hero([apy(5.4), ...stats(0.003)])).not.toContain("Total staked");
    expect(hero([apy(5.4), ...stats(10)])).toContain("$2.6KTotal staked");
  });

  it("keeps the total's place, with its skeleton, while the total isn't known yet: the Stake button never moves when it arrives", () => {
    // nothing read yet
    expect(spokenText(html([apy(5.4)]))).toContain("LoadingTotal staked");
    // the total staked read, the price still on its way (or the other way round)
    expect(spokenText(html([apy(5.4), stats(10)[0]]))).toContain("LoadingTotal staked");
    expect(spokenText(html([apy(5.4), stats(10)[1]]))).toContain("LoadingTotal staked");
    // nothing staked is known without a price: no place
    expect(hero([apy(5.4), stats(0)[0]])).not.toContain("Total staked");
  });

  it("shows the snapshot's total at first paint: a total, not a price anyone acts on", () => {
    const seeded = Date.now() - 60_000;
    expect(hero([apy(5.4, { at: seeded }), ...stats(10, { at: seeded })], seeded)).toContain("$2.6KTotal staked");
  });

  it("reads the total staked and the price apart: the price's read failing leaves the yield as it is", () => {
    const text = hero([apy(5.4), stats(10)[0], { key: cascadeKeys.taoPrice(), data: 255, at: Date.now() - 2 * 60 * 60_000, failed: true }]);
    expect(text).toContain("5.4%APY in TAO*");
    expect(text).toContain("–Not availableTotal staked");
  });

  it("keeps the total's place, with a dash, once a failed read leaves only an old value", () => {
    expect(hero([apy(5.4), ...stats(10, { at: Date.now() - 2 * 60 * 60_000, failed: true })])).toContain("–Not availableTotal staked");
  });

  it("leads to the stake page from the button after its figures, as before", () => {
    const h = html([apy(5.4), ...stats(10)]);
    expect(h).toMatch(/Total staked<\/p><\/div><a[^>]*href="\/stake\/?"[^>]*>/);
    expect(plainText(h)).toContain("Total stakedStake");
  });
});
