import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { depositNotice, type SentNotice, unstakeNotice } from "@/lib/sent";
import { launchData, plainText, renderWithCache } from "../test-render";
import { SentDialog } from "./SentDialog";

const html = (notice: SentNotice | null) => renderWithCache(createElement(SentDialog, { notice, onClose: () => undefined }), [], { data: launchData() });

/** The dialog's accessible name: the element its aria-labelledby points at. */
function labelOf(h: string): string {
  const id = /<dialog[^>]*aria-labelledby="([^"]+)"/.exec(h)?.[1];
  expect(id).toBeDefined();
  const title = new RegExp(`<h2[^>]*id="${id}"[^>]*>([^<]*)</h2>`).exec(h)?.[1];
  return title ?? "";
}

describe("the panel that confirms a deposit", () => {
  const h = html(depositNotice("d1", { amountUsd: 50, estTao: 0.19461, batchIntervalS: 3_600 }));

  it("is a dialog named by its title", () => {
    expect(h).toMatch(/^<dialog/);
    expect(labelOf(h)).toBe("Your deposit is on its way");
  });

  it("gives the USDC, the TAO estimate and what happens next on the launch's timing", () => {
    const text = plainText(h);
    expect(text).toContain("Amount50 USDC");
    expect(text).toContain("TAO (estimate)about 0.1946 TAO");
    expect(text).toContain(
      "Next it crosses to Bittensor in a batch: batches leave hourly once their fees cover the bridge fee, otherwise within 24 hours. It's staked about 20 minutes after it leaves.",
    );
  });

  it("follows it live on its receipt trail, or closes with Done", () => {
    expect(h).toMatch(/<a[^>]*href="\/activity\?deposit=d1"[^>]*>Follow it live<\/a>/);
    expect(h).toMatch(/<button type="button"[^>]*>Done<\/button>/);
  });
});

describe("the panel that confirms an unstake", () => {
  const h = html(unstakeNotice("w1", { taoAmount: 0.07, usdcAmount: 17.41, batchIntervalS: 3_600 }));

  it("says it is requested, then the safety wait, then the payout", () => {
    expect(labelOf(h)).toBe("Your unstake is requested");
    const text = plainText(h);
    expect(text).toContain("Unstakingabout 0.0700 TAO");
    expect(text).toContain("You will receiveabout 17.41 USDC");
    expect(text).toContain("After the 24-hour safety wait it comes back to Base, where it's sold at your minimum price or better and the USDC is sent to your wallet.");
  });

  it("follows it live on its receipt trail", () => {
    expect(h).toMatch(/<a[^>]*href="\/activity\?withdrawal=w1"[^>]*>Follow it live<\/a>/);
    expect(h).toMatch(/<button type="button"[^>]*>Done<\/button>/);
  });
});

describe("with nothing to confirm", () => {
  it("is a closed, empty dialog", () => {
    const h = html(null);
    expect(h).toMatch(/^<dialog/);
    expect(h).not.toContain(" open");
    expect(plainText(h)).toBe("");
  });
});
