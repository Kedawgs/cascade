import { createElement } from "react";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { TOKENS } from "@/lib/cascade/config";
import { cascadeKeys } from "@/lib/cascade/hooks";
import type { WithdrawalRecord } from "@/lib/cascade/records";
import { faqSections } from "@/lib/faq";
import { SeeTaoInWallet } from "./app/StakeCard";
import { FaqItems } from "./faq/FaqItems";
import { launchData, plainText, renderWithCache } from "./test-render";

// Task 59b: "Add to wallet" for ForeverMoney's TAO on Base, on the claim screen (the Stake page's card) and in the
// FAQ. It serves v3-launch too, which pays out the same token: each test runs on both deployments.

const ME = "0x1234567890abcdef1234567890abcdef12345678";
const LENSES = { vaultLens: "0x000000000000000000000000000000000000Ae15" as Address, doorLens: "0x000000000000000000000000000000000000De15" as Address };
const DEPLOYMENTS = [
  ["v3-launch", () => launchData()],
  ["v3.2", () => launchData(undefined, LENSES)],
] as const;
/** The buttons a page shows, by their text. */
const buttons = (html: string, text: string) => [...html.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].filter((m) => m[1] === text).length;

/** An unstake whose USDC the front door is delivering automatically (trail.ts isDelivering): its TAO is sold, never
 * the wallet's to see. */
const delivering: WithdrawalRecord = {
  id: "w1",
  createdAt: new Date(0),
  status: "in_progress",
  steps: [
    { key: "request", title: "Request your unstake", status: "done" },
    { key: "unstake", title: "Unstake on Bittensor", status: "done" },
    { key: "return", title: "Return to Base", status: "done" },
    { key: "claim", title: "USDC to your wallet", status: "active", detail: "USDC is being delivered to your wallet automatically" },
  ],
  shares: 1n,
  taoAmount: 0.01,
  claimable: 10n ** 16n,
};

describe("Add to wallet on the claim screen (Task 59b)", () => {
  for (const [name, data] of DEPLOYMENTS) {
    const card = (balances: { claimable: bigint; tao: bigint }, withdrawals: WithdrawalRecord[] = []) =>
      renderWithCache(
        createElement(SeeTaoInWallet, { account: ME }),
        [
          { key: cascadeKeys.balances(ME), data: balances },
          { key: cascadeKeys.withdrawals(ME), data: withdrawals },
        ],
        { data: data() },
      );

    it(`${name}: offers it while TAO waits to be claimed on Base, or sits in the wallet`, () => {
      for (const balances of [
        { claimable: 10n ** 16n, tao: 0n },
        { claimable: 0n, tao: 10n ** 16n },
      ]) {
        const html = card(balances);
        expect(plainText(html)).toContain("See your TAO in your wallet.");
        expect(buttons(html, "Add to wallet")).toBe(1);
      }
    });

    it(`${name}: shows nothing while there is no TAO on Base, or while what waits is being sold as USDC for the user`, () => {
      expect(card({ claimable: 0n, tao: 0n })).toBe("");
      // the claim banner's own rule (ClaimReady): no claim offered while the USDC is being delivered automatically
      expect(card({ claimable: 10n ** 16n, tao: 0n }, [delivering])).toBe("");
      // TAO already in the wallet is the wallet's to see, whatever else is being delivered
      expect(buttons(card({ claimable: 10n ** 16n, tao: 1n }, [delivering]), "Add to wallet")).toBe(1);
    });
  }
});

describe("Add to wallet in the FAQ (Task 59b)", () => {
  for (const [name, data] of DEPLOYMENTS) {
    it(`${name}: "See your TAO in your wallet" has the button, and says how to add the token by hand`, () => {
      const d = data().deployment;
      const chains = faqSections(d).find((s) => s.id === "chains")!;
      const item = chains.items.find((i) => i.id === "see-your-tao")!;
      expect(item.q).toBe("See your TAO in your wallet");
      expect(item.action).toBe("add-fm-tao");
      const html = renderWithCache(createElement(FaqItems, { items: chains.items }), [], { data: data() });
      // the one item with the action shows the one button
      expect(buttons(html, "Add to wallet")).toBe(1);
      expect(plainText(html)).toContain(`address ${TOKENS.tao}, symbol TAO, 18 decimals`);
    });
  }
});
