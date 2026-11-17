import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import type { Deployment } from "@/lib/cascade/config";
import { cascadeKeys } from "@/lib/cascade/hooks";
import { CLOSE_FIRST_RECHECKING } from "@/lib/send-now";
import { type Cached, launchData, plainText, renderWithCache, shownText, spokenText } from "../test-render";
import { PriceStrip, StakeForm } from "./StakeForm";

const SEEDED = Date.now() - 60_000;
const stripHtml = (cached: Cached[], seededAt?: number) => renderWithCache(createElement(PriceStrip), cached, { seededAt });
const strip = (cached: Cached[], seededAt?: number) => plainText(stripHtml(cached, seededAt));
/** The TAO price's own read (Base). */
const priced = (over: Partial<Cached>): Cached => ({ key: cascadeKeys.taoPrice(), data: 254.49, ...over });

describe("PriceStrip", () => {
  it("doesn't show the snapshot's TAO price as today's: a skeleton in its place while this visit's is read", () => {
    const h = stripHtml([priced({ at: SEEDED })], SEEDED);
    expect(spokenText(h)).toContain("TAO Loading");
    expect(shownText(h)).not.toMatch(/\$|–/);
  });

  it("shows the price from a live read, once on screen and read out once", () => {
    const h = stripHtml([priced({ at: SEEDED + 20_000 })], SEEDED);
    expect(shownText(h)).toContain("TAO $254.49Your balance is TAO");
    expect(spokenText(h)).toContain("TAO $254.49Your balance is TAO");
  });

  it("shows it without the total staked: the price is Base's own read, which doesn't wait for Bittensor's nor fail with it", () => {
    expect(strip([priced({}), { key: cascadeKeys.stats(), data: { totalStakedTao: 1 }, at: Date.now() - 2 * 60 * 60_000, failed: true }])).toContain("TAO $254.49");
    expect(spokenText(stripHtml([priced({})]))).toContain("TAO $254.49");
    // and the total staked alone is no price
    expect(spokenText(stripHtml([{ key: cascadeKeys.stats(), data: { totalStakedTao: 1 } }]))).toContain("TAO Loading");
  });

  it("says the price isn't available when the live read fails with only the snapshot's", () => {
    expect(strip([priced({ at: SEEDED, failed: true })], SEEDED)).toContain("TAO –Not available");
  });
});

describe("R8 (the contracts review's L-1): a stake the full open batch has no room for, offered with sending the batch first", () => {
  const ME = "0x1234567890abcdef1234567890abcdef12345678";
  const LENSES = { vaultLens: "0x000000000000000000000000000000000000Ae15" as Address, doorLens: "0x000000000000000000000000000000000000De15" as Address };
  /** $1 to $1,000 now; $2,400 once the open batch (7, full by its limits) has left, found closable by reads a refresh apart */
  const after = (over: object = {}) => ({ maxTao: 10n ** 19n, maxUsd: 2_400, batchId: 7n, due: "full", closableForMs: 30_000, ...over });
  const limits = (over: object = {}): Cached => ({ key: cascadeKeys.limits(), data: { minTao: 10n ** 15n, maxTao: 4n * 10n ** 18n, minUsd: 1, maxUsd: 1_000, full: null, afterClose: after(), ...over } });
  const balances: Cached = { key: cascadeKeys.balances(ME), data: { usdc: 5_000n * 10n ** 6n, tao: 0n, eth: 10n ** 16n, usdcRouterAllowance: 0n, usdcStakerAllowance: 0n, taoRouterAllowance: 0n, taoFrontDoorAllowance: 0n, claimable: 0n } };
  const START = 1_800_000_000;
  const openBatch: Cached = {
    key: cascadeKeys.openBatch(ME),
    data: { id: 7n, start: START, interval: 3_600, canClose: true, paused: false, chainTime: START + 120, mine: { depositWei: 0n, redeemShares: 0n }, potWei: 0n, totalWei: 10n ** 19n, feeWei: 744_898_037_875_672n, ethWei: 10n ** 16n, gasWei: 10n ** 13n, ethPriceUsd: 2_330, bittensor: "open", closesWhilePaused: true },
  };
  const form = (amount: string, cached: Cached[], over: Partial<Deployment> = LENSES) =>
    plainText(renderWithCache(createElement(StakeForm, { account: ME, initialAmount: amount, maxUsdc: 5_000 }), cached, { data: launchData(undefined, over) }));

  it("names the two steps on its button and says what sending the batch costs", () => {
    const t = form("1500", [limits(), balances, openBatch]);
    expect(t).toContain("Send the batch, then stake $1,500");
    expect(t).toContain(
      "The current batch is full. It normally leaves on its own within a minute or two, at no cost to you, and the next batch then has room for your stake. It hasn't left yet, so you can send it now yourself: sending it now costs its bridge fee, about $1.74 in ETH, and Base's network fee for the two steps.",
    );
    expect(t).not.toContain("The most you can stake right now");
  });

  it("R9 (M-2): a batch only just found closable waits for the keeper's free close first, saying so; one closable by time alone is due, not full", () => {
    const fresh = form("1500", [limits({ afterClose: after({ closableForMs: 0 }) }), balances, openBatch]);
    expect(fresh).toContain("The current batch is full. It normally leaves on its own within a minute or two, at no cost to you, and the next batch then has room for your stake. If it hasn't left in a moment, you can send it yourself.");
    expect(fresh).not.toContain("costs its bridge fee");
    const due = form("1500", [limits({ afterClose: after({ due: "time" }) }), balances, openBatch]);
    expect(due).toContain("The current batch has no room for this stake. It is due to leave, but it isn't full, so the keeper may hold it for more fees");
    expect(due).not.toContain("The current batch is full");
  });

  it("R10 (M-1): no paid close offered on a reading of the limits that failed, or is more than 65 s old (two refreshes: a hidden tab's): the button waits for a fresh one", () => {
    const FULL = "The current batch is full. It normally leaves on its own within a minute or two, at no cost to you, and the next batch then has room for your stake.";
    const old = form("1500", [{ ...limits(), at: Date.now() - 66_000 }, balances, openBatch]);
    expect(old).toContain(`${FULL} Checking whether it has left yet…`);
    expect(old).not.toContain("costs its bridge fee");
    const failed = form("1500", [{ ...limits(), failed: true }, balances, openBatch]);
    expect(failed).toContain(`${FULL} We couldn't check the batch again just now, so it can't be sent from here yet.`);
    expect(failed).not.toContain("costs its bridge fee");
    // a reading a minute old (a refresh late) still offers it
    expect(form("1500", [{ ...limits(), at: Date.now() - 60_000 }, balances, openBatch])).toContain("costs its bridge fee");
  });

  it("R12d: a click on a reading that aged since the render (a tab just shown again) reads the limits again and says so, never silently", () => {
    const src = readFileSync(fileURLToPath(new URL("./StakeForm.tsx", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(src).toMatch(/if \(closeView && limitsFreshness\(limits, Date\.now\(\)\) !== "fresh"\) \{\s*setRechecking\(true\);\s*void limits\.refetch\(\)\.finally\(\(\) => setRechecking\(false\)\);\s*return;\s*\}/);
    expect(src).toMatch(/\{rechecking && \(\s*<p role="status" className=\{styles\.note\}>\s*\{CLOSE_FIRST_RECHECKING\}\s*<\/p>\s*\)\}/);
    expect(CLOSE_FIRST_RECHECKING).toBe("Checking the batch again, so nothing was sent yet. Press the button again in a moment.");
  });

  it("an amount that fits now is an ordinary stake; one over what the next batch takes, or any amount on v3-launch, keeps the form's own words", () => {
    expect(form("500", [limits(), balances, openBatch])).not.toContain("Send the batch");
    const over = form("2500", [limits(), balances, openBatch]);
    expect(over).toContain("The most you can stake right now is $1,000.");
    expect(over).not.toContain("Send the batch");
    const launch = form("1500", [limits(), balances, openBatch], {});
    expect(launch).not.toContain("Send the batch");
    // a full cap: no offer (a close frees none of it)
    expect(form("20", [limits({ full: "cap", afterClose: undefined }), balances, openBatch])).toContain("Cascade is full for now.");
  });
});
