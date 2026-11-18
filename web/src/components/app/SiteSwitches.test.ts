import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { createElement, type ReactElement } from "react";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { type Deployment, EXPECTED_DEPLOYMENTS, type ExpectedDeployment } from "@/lib/cascade/config";
import { CLAIM_TAO_NOW, NO_DEPOSITS_HERE, NOTHING_STAKED_HERE, RETIRED, RETIRED_NOT_FOUND_LINK, RETIRED_TITLE } from "@/lib/cascade/flows";
import { cascadeKeys } from "@/lib/cascade/hooks";
import type { DepositRecord, WithdrawalRecord } from "@/lib/cascade/records";
import type { Available, Position } from "@/lib/cascade/types";
import { SEND_HELD_BY_DEPOSIT, sendNowHeldByDeposit, sendNowOffered } from "@/lib/send-now";
import { AS_TAO_LINK, BACK_TO_USDC_LABEL, DELIVERY_IS_OFF, RECEIVE_ENDS_DELIVERY, RECEIVE_TAO_LABEL, RECEIVE_TAO_NOTE_OFF, TURN_OFF_DELIVERY, taoChoice, unstakeHeading } from "@/lib/stake-form";
import { Hero } from "../landing/Hero";
import { SiteNav } from "../landing/SiteNav";
import { StakeSection } from "../landing/StakeSection";
import { NotFoundBody } from "../NotFoundBody";
import { type Cached, launchData, plainText, renderWithCache } from "../test-render";
import { ActivityScreen, DepositDetail, Lists, WithdrawalDetail } from "./ActivityScreen";
import { RewardsScreen } from "./RewardsScreen";
import { SendItNow } from "./SendItNow";
import { ClaimReady, StakeCard } from "./StakeCard";
import { StakeForm } from "./StakeForm";
import { StakeScreen } from "./StakeScreen";
import { UnstakeForm } from "./UnstakeForm";
import { appGuard } from "@/lib/cascade/use-flows";
import { OtherWaysOut, UnstakeScreen } from "./UnstakeScreen";

// Task 60: the founder's two switches, each a line of a deployment's entry in deployments.json: the stage "retired" (the
// site shows only the ways out), and v3.2's `usdcDelivery: false` (no USDC option; preference holders prompted to claim).
// Rendered on the server, as the static export does.

const ME = "0x1234567890abcdef1234567890abcdef12345678";
const LENSES = { vaultLens: "0x000000000000000000000000000000000000Ae15" as Address, doorLens: "0x000000000000000000000000000000000000De15" as Address };

/** The launch's data source (with v3.2's lenses when `v32`), listed in deployments.json with `entry` changed. */
function site(entry: Partial<ExpectedDeployment>, v32 = false) {
  const over: Partial<Deployment> = v32 ? LENSES : {};
  const listed = { "x-site": { ...EXPECTED_DEPLOYMENTS["v3-launch"], ...(v32 ? LENSES : {}), ...entry } as ExpectedDeployment };
  return launchData(undefined, over, { deployments: listed });
}
const router = { push: () => undefined, replace: () => undefined, back: () => undefined, forward: () => undefined, refresh: () => undefined, prefetch: () => undefined };
const render = (el: ReactElement, cached: Cached[], data: ReturnType<typeof site>) =>
  renderWithCache(createElement(AppRouterContext.Provider, { value: router as never }, el), cached, { data });
/** The buttons a page shows, by their text (an amount field's MAX left out). */
const buttons = (h: string) => [...h.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]).filter((b) => b !== "MAX");
const LIMITS: Cached = { key: cascadeKeys.limits(), data: { minTao: 10n ** 15n, maxTao: 10n ** 19n, minUsd: 1, maxUsd: 2_000, full: null } };

const position: Position = { shares: 10n ** 24n, taoWei: 10n ** 18n, taoBalance: 1, usdValue: 250, taoPriceUsd: 250 };
const available: Available = { availableShares: 10n ** 24n, availableTaoWei: 10n ** 18n };
const balances = (over: { claimable?: bigint; tao?: bigint } = {}) => ({
  usdc: 0n,
  tao: 0n,
  eth: 10n ** 16n,
  usdcRouterAllowance: 0n,
  usdcStakerAllowance: 0n,
  taoRouterAllowance: 0n,
  taoFrontDoorAllowance: 0n,
  claimable: 0n,
  ...over,
});
const unstakeForm: Cached[] = [
  { key: cascadeKeys.position(ME), data: position },
  { key: cascadeKeys.available(ME), data: available },
];
/** An unstake whose payout is back on Base and being delivered as USDC (trail.ts isDelivering). */
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
const ready: WithdrawalRecord = { ...delivering, id: "w2", status: "ready", steps: delivering.steps.map((s) => (s.key === "claim" ? { ...s, status: "action", detail: "Your money is back on Base. Claim it as USDC" } : s)) };

describe("retiredStageShowsOnlyExits (Task 60)", () => {
  for (const [name, v32] of [
    ["v3-launch", false],
    ["v3.2", true],
  ] as const) {
    const retired = () => site({ stage: "retired" }, v32);
    const early = () => site({ stage: "early" }, v32);

    it(`${name}: the stake form, on the Stake page and the landing page, is the plan's sentence instead`, () => {
      const t = plainText(render(createElement(StakeForm, { account: null }), [], retired()));
      expect(t).toBe(RETIRED);
      expect(RETIRED).toBe("This version of Cascade is retired. Withdraw and claim here.");
      // not retired: the form as before
      expect(plainText(render(createElement(StakeForm, { account: null }), [], early()))).toContain("Amount");
    });

    it(`${name}: no "Stake with USDC" and no Stake link on the landing page, rather than a way to the retired sentence (follow-up)`, () => {
      const stakePage = plainText(render(createElement(StakeScreen), [], retired()));
      expect(stakePage).not.toContain("Stake with USDC");
      expect(stakePage).not.toContain("We swap your USDC to TAO");
      expect(stakePage).toContain(RETIRED_TITLE);
      expect(RETIRED_TITLE).toBe("Withdraw and claim");
      expect(stakePage).toContain(RETIRED);
      expect(plainText(render(createElement(StakeScreen), [], early()))).toContain("Stake with USDC");
      // the landing page: no Stake button in the hero or the bar, and no stake section; the sentence in the hero instead
      const hero = render(createElement(Hero), [], retired());
      expect(hero).not.toMatch(/href="\/stake/);
      expect(plainText(hero)).toContain(RETIRED);
      expect(render(createElement(Hero), [], early())).toMatch(/href="\/stake/);
      expect(render(createElement(StakeSection), [], retired())).toBe("");
      expect(plainText(render(createElement(StakeSection), [], early()))).toContain("Stake in a few clicks");
      expect(render(createElement(SiteNav, { stage: "retired" }), [], retired())).not.toMatch(/href="\/stake/);
      expect(render(createElement(SiteNav, { stage: "early" }), [], early())).toMatch(/href="\/stake/);
    });

    it(`${name}: the Stake page's card keeps the ways out: the claim and the wallet's TAO swapped back, never staked`, () => {
      const cached: Cached[] = [{ key: cascadeKeys.balances(ME), data: balances({ claimable: 10n ** 16n, tao: 10n ** 17n }) }, { key: cascadeKeys.withdrawals(ME), data: [] }, LIMITS];
      const h = render(createElement(StakeCard, { account: ME }), cached, retired());
      expect(buttons(h)).toEqual(["Claim as USDC", "Swap to USDC", "Add to wallet"]);
      // no stake form in the card (the page's heading says it is retired, once: StakeScreen)
      expect(plainText(h)).not.toContain("Amount");
      expect(plainText(h)).not.toContain(RETIRED);
      // not retired: the wallet's TAO can be staked again
      expect(buttons(render(createElement(StakeCard, { account: ME }), cached, early()))).toContain("Stake it");
    });

    it(`${name}: Unstake, Rewards and Activity say so above the ways out, and the unstake stays`, () => {
      for (const screen of [UnstakeScreen, RewardsScreen, ActivityScreen]) {
        expect(plainText(render(createElement(screen), [], retired())), screen.name).toContain(RETIRED);
        expect(plainText(render(createElement(screen), [], early())), screen.name).not.toContain(RETIRED);
      }
      const form = buttons(render(createElement(UnstakeForm, { account: ME }), unstakeForm, retired()));
      expect(form[0]).toBe("Unstake");
      // v3.2's unstake as TAO stays too: the form itself, switched to it (its one button then asks for TAO)
      if (v32) {
        const tao = render(createElement(UnstakeForm, { account: ME, asTao: true, onAsTao: () => undefined }), unstakeForm, retired());
        expect(buttons(tao)).toEqual(["Receive TAO", BACK_TO_USDC_LABEL]);
        expect(plainText(tao)).toContain(RECEIVE_TAO_NOTE_OFF);
      }
    });

    it(`${name}: where nothing is there yet, no invitation to stake: the unstake form, the deposits, a page not found (review, Minor 1)`, () => {
      const nothing: Cached[] = [
        { key: cascadeKeys.position(ME), data: { ...position, shares: 0n, taoWei: 0n, taoBalance: 0, usdValue: 0 } },
        { key: cascadeKeys.available(ME), data: { availableShares: 0n, availableTaoWei: 0n } },
      ];
      const form = render(createElement(UnstakeForm, { account: ME }), nothing, retired());
      expect(plainText(form)).toBe(NOTHING_STAKED_HERE);
      expect(NOTHING_STAKED_HERE).toBe("Nothing staked here.");
      expect(form).not.toMatch(/href="\/stake/);
      const lists = (data: ReturnType<typeof site>) =>
        render(createElement(Lists, { account: ME, tab: "deposits" }), [{ key: cascadeKeys.deposits(ME), data: [] }, { key: cascadeKeys.withdrawals(ME), data: [] }], data);
      expect(plainText(lists(retired()))).toContain(NO_DEPOSITS_HERE);
      expect(NO_DEPOSITS_HERE).toBe("No deposits here.");
      expect(plainText(lists(retired()))).not.toContain("Stake some USDC");
      // the page not found leads to the ways out, by the retired Stake page's own title
      const lost = render(createElement(NotFoundBody, { stage: "retired" }), [], retired());
      expect(plainText(lost)).toBe(`There's nothing at this address.${RETIRED_NOT_FOUND_LINK}`);
      expect(RETIRED_NOT_FOUND_LINK).toBe("Go to withdraw and claim");
      expect(lost).toMatch(/href="\/stake"/);
      // not retired: as before
      const before = render(createElement(UnstakeForm, { account: ME }), nothing, early());
      expect(plainText(before)).toBe("Nothing staked yet.Stake some USDC first and it will show up here.Go to Stake");
      expect(before).toMatch(/href="\/stake"/);
      expect(plainText(lists(early()))).toContain("No deposits yet. Stake some USDC and it will show up here.");
      expect(plainText(render(createElement(NotFoundBody, { stage: "early" }), [], early()))).toBe("There's nothing at this address.Go to the stake page");
    });

    it(`${name}: a deposit's receipt offers its cancel and nothing that stakes: no carrying on, no stake again`, () => {
      const stopped: DepositRecord = {
        id: "d1",
        createdAt: new Date(0),
        sourceChain: "base",
        status: "needs_you",
        steps: [{ key: "deposit", title: "Deposit", status: "action" }],
        taoWei: 10n ** 17n,
        taoAmount: 0.1,
        amountUsd: 25,
        cancellableWei: 10n ** 17n,
      };
      const failed: DepositRecord = { ...stopped, id: "d2", status: "failed", restake: true, cancellableWei: undefined };
      const receipt = (r: DepositRecord, data: ReturnType<typeof site>) => render(createElement(DepositDetail, { account: ME, id: r.id }), [{ key: cascadeKeys.deposits(ME), data: [stopped, failed] }], data);
      expect(buttons(receipt(stopped, retired()))).toEqual(["Cancel deposit"]);
      expect(plainText(receipt(failed, retired()))).not.toContain("Stake again at today's price");
      // not retired: as before
      expect(buttons(receipt(stopped, early()))).toContain("Continue this deposit");
      expect(plainText(receipt(failed, early()))).toContain("Stake again at today's price");
    });
  }

  it("a receipt's Send it now box: nothing for a batch holding the account's deposit, and the countdown for its unstake alone", () => {
    const nowS = Math.floor(Date.now() / 1000);
    const batch = (depositWei: bigint, redeemShares: bigint) => ({
      id: 7n,
      start: nowS - 600,
      interval: 3_600,
      canClose: false,
      paused: false,
      chainTime: nowS,
      mine: { depositWei, redeemShares },
      potWei: 0n,
    });
    const box = (what: "deposit" | "unstake", b: ReturnType<typeof batch>, data: ReturnType<typeof site>) =>
      plainText(render(createElement(SendItNow, { account: ME, what, waiting: true, href: "/activity" }), [{ key: cascadeKeys.openBatch(ME), data: b }], data));
    for (const v32 of [false, true]) {
      // the launch cadence (a 24-hour max wait): a countdown, and when the user can send it themselves
      expect(box("deposit", batch(10n ** 17n, 0n), site({ stage: "early" }, v32))).toContain("Leaves in");
      expect(box("deposit", batch(10n ** 17n, 0n), site({ stage: "retired" }, v32))).toBe("");
      // its unstake in a batch with its deposit: when the batch leaves, and why it can't be sent from here (review, Minor 5)
      const both = box("unstake", batch(10n ** 17n, 10n ** 21n), site({ stage: "retired" }, v32));
      expect(both).toContain("Leaves in");
      expect(both).toContain(SEND_HELD_BY_DEPOSIT);
      expect(both).not.toContain("Send it yourself");
      expect(box("unstake", batch(0n, 10n ** 21n), site({ stage: "retired" }, v32))).toContain("Leaves in");
      expect(box("unstake", batch(0n, 10n ** 21n), site({ stage: "retired" }, v32))).toContain("Send it yourself");
      expect(box("unstake", batch(0n, 10n ** 21n), site({ stage: "retired" }, v32))).not.toContain(SEND_HELD_BY_DEPOSIT);
      expect(box("unstake", batch(10n ** 17n, 10n ** 21n), site({ stage: "early" }, v32))).not.toContain(SEND_HELD_BY_DEPOSIT);
    }
    // and once it can be sent: no button, the line in its place
    const due = { ...batch(10n ** 17n, 10n ** 21n), start: nowS - 7_200, canClose: true, bittensor: "open", feeWei: 10n ** 14n, ethWei: 10n ** 16n, gasWei: 10n ** 12n };
    const ready = render(createElement(SendItNow, { account: ME, what: "unstake", waiting: true, href: "/activity" }), [{ key: cascadeKeys.openBatch(ME), data: due }], site({ stage: "retired" }, true));
    expect(buttons(ready)).toEqual([]);
    expect(plainText(ready)).toContain(SEND_HELD_BY_DEPOSIT);
    expect(buttons(render(createElement(SendItNow, { account: ME, what: "unstake", waiting: true, href: "/activity" }), [{ key: cascadeKeys.openBatch(ME), data: { ...due, mine: { depositWei: 0n, redeemShares: 10n ** 21n } } }], site({ stage: "retired" }, true)))[0]).toMatch(/^Send it now/);
  });

  it("says why Send it now isn't offered for a retired account's unstake beside its deposit, and only then (review, Minor 5)", () => {
    expect(sendNowHeldByDeposit({ retired: true, what: "unstake", depositWei: 10n ** 17n })).toBe(SEND_HELD_BY_DEPOSIT);
    expect(SEND_HELD_BY_DEPOSIT).toBe("Cancel your deposit to send your unstake now.");
    expect(sendNowHeldByDeposit({ retired: true, what: "unstake", depositWei: 0n })).toBeNull();
    expect(sendNowHeldByDeposit({ retired: true, what: "deposit", depositWei: 10n ** 17n })).toBeNull();
    expect(sendNowHeldByDeposit({ retired: false, what: "unstake", depositWei: 10n ** 17n })).toBeNull();
  });

  it("Send it now is never offered for a batch holding the account's deposit, and still is for its unstake alone", () => {
    expect(sendNowOffered({ retired: true, what: "deposit", depositWei: 10n ** 17n })).toBe(false);
    expect(sendNowOffered({ retired: true, what: "unstake", depositWei: 10n ** 17n })).toBe(false);
    expect(sendNowOffered({ retired: true, what: "deposit", depositWei: 0n })).toBe(false);
    expect(sendNowOffered({ retired: true, what: "unstake", depositWei: 0n })).toBe(true);
    // not retired: offered as before
    for (const what of ["deposit", "unstake"] as const) expect(sendNowOffered({ retired: false, what, depositWei: 10n ** 17n })).toBe(true);
  });
});

describe("usdcDeliveryOffHidesTheOptionAndPromptsAClaim (Task 60)", () => {
  const off = () => site({ stage: "early", usdcDelivery: false }, true);
  const on = () => site({ stage: "early", usdcDelivery: true }, true);

  it("the unstake form offers Receive TAO alone, as its one button, with no USDC line, amount or price", () => {
    const pref = (set: boolean): Cached => ({ key: cascadeKeys.deliveryPreference(ME), data: set });
    const h = render(createElement(UnstakeForm, { account: ME }), [...unstakeForm, pref(true)], off());
    const t = plainText(h);
    // the TAO view's button says what it asks for, never the USDC view's word
    expect(buttons(h)).toEqual(["Receive TAO"]);
    expect(t).toContain(RECEIVE_TAO_NOTE_OFF);
    expect(RECEIVE_TAO_NOTE_OFF).toBe("Nothing is sold: your TAO comes back to Base for you to claim.");
    // it clears the preference the chain holds, and says so
    expect(t).toContain(RECEIVE_ENDS_DELIVERY);
    expect(plainText(render(createElement(UnstakeForm, { account: ME }), [...unstakeForm, pref(false)], off()))).not.toContain(RECEIVE_ENDS_DELIVERY);
    for (const usdc of ["USDC arrives", "With USDC", "Price impact", "TAO price", "can be delivered", "USDC unstake", "Type a USDC amount"]) expect(h, usdc).not.toContain(usdc);
    expect(t).toContain("TAO on Base, to claim");
    // USDC delivery on: the USDC button alone (Receive TAO is the form's switch, under "Other ways out")
    expect(buttons(render(createElement(UnstakeForm, { account: ME, onAsTao: () => undefined }), unstakeForm, on()))).toEqual(["Unstake"]);
  });

  it("the claim banner prompts the claim in the plan's words while the chain holds a delivery preference, whatever is being delivered", () => {
    const card = (pref: boolean | undefined, data = off()) =>
      render(
        createElement(StakeCard, { account: ME }),
        [
          { key: cascadeKeys.balances(ME), data: balances({ claimable: 10n ** 16n, tao: 10n ** 17n }) },
          { key: cascadeKeys.withdrawals(ME), data: [delivering] },
          LIMITS,
          ...(pref === undefined ? [] : [{ key: cascadeKeys.deliveryPreference(ME), data: pref }]),
        ],
        data,
      );
    const prompted = card(true);
    expect(plainText(prompted)).toContain(CLAIM_TAO_NOW);
    expect(CLAIM_TAO_NOW).toBe("Claim your TAO now: USDC delivery is off.");
    // the claim as TAO alone (which clears the preference), never a USDC claim or swap; the wallet's TAO can still be
    // staked (USDC delivery off holds no stake)
    const b = buttons(prompted);
    // beside it, turning the preference off at once (the follow-up's ruling)
    expect(b.slice(0, 4)).toEqual(["Claim as TAO", TURN_OFF_DELIVERY, "Stake it", "Add to wallet"]);
    for (const usdc of ["Claim as USDC", "Swap to USDC"]) expect(b).not.toContain(usdc);
    // no preference: the claim, without the prompt or the turn-off; not read yet: the prompt (unknown taken as set), and
    // the turn-off only once the read says set or fails
    expect(plainText(card(false))).not.toContain(CLAIM_TAO_NOW);
    expect(buttons(card(false))[0]).toBe("Claim as TAO");
    expect(buttons(card(false))).not.toContain(TURN_OFF_DELIVERY);
    expect(plainText(card(undefined))).toContain(CLAIM_TAO_NOW);
    expect(buttons(card(undefined))).not.toContain(TURN_OFF_DELIVERY);
    // USDC delivery on: nothing claimed while it is being delivered, as before, and the swap offered
    const before = buttons(card(true, on()));
    expect(before.slice(0, 3)).toEqual(["Stake it", "Swap to USDC", "Add to wallet"]);
    expect(plainText(card(true, on()))).not.toContain(CLAIM_TAO_NOW);
  });

  it("an unstake's receipt claims as TAO only, and one being delivered offers the claim with the prompt", () => {
    const receipt = (w: WithdrawalRecord, data = off()) =>
      render(createElement(WithdrawalDetail, { account: ME, id: w.id }), [{ key: cascadeKeys.withdrawals(ME), data: [delivering, ready] }, { key: cascadeKeys.deliveryPreference(ME), data: true }], data);
    expect(buttons(receipt(ready))).toEqual(["Claim as TAO", TURN_OFF_DELIVERY, "Add to wallet"]);
    const d = receipt(delivering);
    expect(buttons(d)).toEqual(["Claim as TAO", TURN_OFF_DELIVERY, "Add to wallet"]);
    expect(plainText(d)).toContain(CLAIM_TAO_NOW);
    // on: as before
    expect(buttons(receipt(ready, on()))).toEqual(["Claim as USDC"]);
    expect(buttons(receipt(delivering, on()))).toEqual([]);
  });

  it("a receipt whose claim kept the TAO and waits for its swap offers no \"Swap it to USDC\" (review, Minor 2)", () => {
    const swapLeft: WithdrawalRecord = {
      ...ready,
      id: "w3",
      status: "needs_you",
      claimable: 0n,
      steps: ready.steps.map((s) => (s.key === "claim" ? { ...s, status: "action", detail: "Claimed as TAO. Swap it to USDC to finish." } : s)),
    };
    expect(swapLeft.steps[3]?.status).toBe("action");
    const receipt = (data: ReturnType<typeof site>) =>
      render(createElement(WithdrawalDetail, { account: ME, id: "w3" }), [{ key: cascadeKeys.withdrawals(ME), data: [swapLeft] }, { key: cascadeKeys.deliveryPreference(ME), data: false }], data);
    expect(buttons(receipt(off()))).not.toContain("Swap it to USDC");
    expect(buttons(receipt(off()))).toEqual([]);
    // on: the swap, as before
    expect(buttons(receipt(on()))).toEqual(["Swap it to USDC"]);
  });

  it("offers to turn off USDC delivery for the account while its preference is set, with nothing to claim yet (follow-up)", () => {
    const card = (pref: Cached | null, data = off()) =>
      render(
        createElement(ClaimReady, { account: ME }),
        [{ key: cascadeKeys.balances(ME), data: balances() }, { key: cascadeKeys.withdrawals(ME), data: [] }, ...(pref ? [pref] : [])],
        data,
      );
    const set = card({ key: cascadeKeys.deliveryPreference(ME), data: true });
    expect(buttons(set)).toEqual([TURN_OFF_DELIVERY]);
    expect(plainText(set)).toContain(DELIVERY_IS_OFF);
    // nothing claimable, so no claim and no "claim now"
    expect(plainText(set)).not.toContain(CLAIM_TAO_NOW);
    // (a failed read offers it too: stake-form.test.ts turnOffDeliveryOffered; a server render retries a failed query on mount)
    // none set, not read yet, or USDC delivery on: nothing at all
    expect(card({ key: cascadeKeys.deliveryPreference(ME), data: false })).toBe("");
    expect(card(null)).toBe("");
    expect(card({ key: cascadeKeys.deliveryPreference(ME), data: true }, on())).toBe("");
  });

  it("a cancelled deposit's receipt doesn't offer to swap its TAO back to USDC", () => {
    const cancelled: DepositRecord = {
      id: "d1",
      createdAt: new Date(0),
      sourceChain: "base",
      status: "cancelled",
      steps: [{ key: "deposit", title: "Deposit", status: "done" }],
      taoWei: 10n ** 17n,
      taoAmount: 0.1,
      amountUsd: 25,
    };
    const cached: Cached[] = [
      { key: cascadeKeys.deposits(ME), data: [cancelled] },
      { key: cascadeKeys.balances(ME), data: balances({ tao: 10n ** 17n }) },
    ];
    expect(buttons(render(createElement(DepositDetail, { account: ME, id: "d1" }), cached, off()))).toEqual([]);
    expect(buttons(render(createElement(DepositDetail, { account: ME, id: "d1" }), cached, on()))).toEqual(["Swap your TAO back to USDC"]);
  });

  it("the Unstake page's heading fits both ways out on v3.2, and only TAO with USDC delivery off (Task 59a review, M9)", () => {
    expect(unstakeHeading({ v32: false, usdcDelivery: true })).toEqual({ title: "Unstake to USDC", sub: "We sell your staked TAO and send the USDC back to the same wallet." });
    expect(unstakeHeading({ v32: true, usdcDelivery: true })).toEqual({ title: "Unstake", sub: "Your staked TAO comes back to the same wallet on Base, as USDC or as TAO." });
    expect(unstakeHeading({ v32: true, usdcDelivery: false })).toEqual({ title: "Unstake", sub: "Your staked TAO comes back to the same wallet on Base, as TAO to claim." });
    const t = plainText(render(createElement(UnstakeScreen), [], off()));
    expect(t).toContain("as TAO to claim.");
    // v3-launch's page is as it was
    expect(plainText(render(createElement(UnstakeScreen), [], launchData()))).toContain("Unstake to USDCWe sell your staked TAO and send the USDC back to the same wallet.");
  });

  it("is v3.2's alone: v3-launch's site, which has no Receive TAO, offers its USDC unstake whatever its entry says", () => {
    const launch = launchData(undefined, {}, { deployments: { "x-site": { ...EXPECTED_DEPLOYMENTS["v3-launch"], usdcDelivery: false } } });
    expect(launch.usdcDelivery).toBe(true);
    expect(buttons(render(createElement(UnstakeForm, { account: ME }), unstakeForm, launch))).toEqual(["Unstake"]);
  });
});

describe("the unstake form keeps what decides a click in the open and folds the explanations away", () => {
  const on = () => site({ stage: "early", usdcDelivery: true }, true);
  const noop = () => undefined;

  it("v3.2 with USDC delivery: one button and one short line; 'How unstaking works' closed, holding the rest", () => {
    const h = render(createElement(UnstakeForm, { account: ME, onAsTao: noop }), unstakeForm, on());
    const [open, folded] = [h.slice(0, h.indexOf("<details")), /<details[^>]*>([\s\S]*?)<\/details>/.exec(h)?.[1] ?? ""];
    // closed until asked for (no `open` attribute), under its heading
    expect(h).toMatch(/<details class="[^"]*_more_[^"]*"><summary>How unstaking works<\/summary>/);
    // folded: how the sale goes, and the daily limit
    for (const part of ["one sale at a time", "Unstakes share a daily limit"]) expect(plainText(folded), part).toContain(part);
    // in the open: the one button; no second button, and none of Receive TAO's words (it is the form's switch, elsewhere)
    expect(buttons(h)).toEqual(["Unstake"]);
    for (const gone of [RECEIVE_TAO_LABEL, RECEIVE_TAO_NOTE_OFF, RECEIVE_ENDS_DELIVERY, "one sale at a time", "Unstakes share a daily limit"]) expect(plainText(open), gone).not.toContain(gone);
    // dollars typed, dollars said: the minimum's TAO figure is the TAO view's
    expect(plainText(open)).toMatch(/The minimum is about \$[0-9.]+\.(?! \()/);
    expect(plainText(open)).not.toContain("(0.033 TAO)");
  });

  it("switched to TAO by the person: the form USDC delivery off shows, with the way back, and nothing of the USDC sale", () => {
    const pref = (set: boolean): Cached => ({ key: cascadeKeys.deliveryPreference(ME), data: set });
    const h = render(createElement(UnstakeForm, { account: ME, asTao: true, onAsTao: noop }), [...unstakeForm, pref(true)], on());
    const t = plainText(h);
    expect(buttons(h)).toEqual(["Receive TAO", BACK_TO_USDC_LABEL]);
    expect(t).toContain(RECEIVE_TAO_NOTE_OFF);
    // it clears the delivery preference the chain holds, and says so where the choice is made
    expect(t).toContain(RECEIVE_ENDS_DELIVERY);
    expect(plainText(render(createElement(UnstakeForm, { account: ME, asTao: true, onAsTao: noop }), [...unstakeForm, pref(false)], on()))).not.toContain(RECEIVE_ENDS_DELIVERY);
    for (const usdc of ["USDC arrives", "With USDC", "Price impact", "can be delivered", "Type a USDC amount", "one sale at a time"]) expect(t, usdc).not.toContain(usdc);
    expect(t).toContain("TAO on Base, to claim");
    expect(t).toContain("The minimum is 0.033 TAO.");
    // folded: what a later USDC unstake does to TAO taken by choice, and the daily limit
    const folded = plainText(/<details[^>]*>([\s\S]*?)<\/details>/.exec(h)?.[1] ?? "");
    expect(folded).toContain("If this TAO is still waiting to be claimed when you next unstake to USDC, it is sold too.");
    expect(folded).toContain("Unstakes share a daily limit");
    // with USDC delivery off there is no way back to offer, whatever was chosen
    const off = site({ stage: "early", usdcDelivery: false }, true);
    expect(buttons(render(createElement(UnstakeForm, { account: ME, asTao: true }), [...unstakeForm, pref(false)], off))).toEqual(["Receive TAO"]);
  });

  it("the form's own way back is held while any request runs (the shared guard), and free again after", async () => {
    const tao = () => render(createElement(UnstakeForm, { account: ME, asTao: true, onAsTao: noop }), unstakeForm, on());
    const back = (h: string) => /<button type="button" class="link"( disabled="")?>Unstake to USDC instead<\/button>/.exec(h);
    expect(back(tao())?.[1]).toBeUndefined();
    let release = () => undefined as void;
    const running = appGuard.run("unstake", () => new Promise<void>((done) => (release = done)));
    try {
      expect(back(tao())?.[1]).toBe(' disabled=""');
    } finally {
      release();
      await running;
    }
    expect(back(tao())?.[1]).toBeUndefined();
  });

  it("'Other ways out' holds the switch to TAO and its way back, and only where the page offers the choice", () => {
    const section = (props: { asTao?: boolean; onAsTao?: (t: boolean) => void; busy?: boolean }, data = on()) => render(createElement(OtherWaysOut, props), [], data);
    // the choice offered: the switch first, then the emergency page
    const offered = section({ onAsTao: noop });
    expect(buttons(offered)).toEqual([AS_TAO_LINK]);
    expect(plainText(offered)).toContain(`${AS_TAO_LINK}: nothing is sold; your TAO comes back to Base for you to claim.`);
    expect(plainText(offered).indexOf(AS_TAO_LINK)).toBeLessThan(plainText(offered).indexOf("Withdraw on Bittensor"));
    // taken: the same place is the way back
    const taken = section({ asTao: true, onAsTao: noop });
    expect(buttons(taken)).toEqual(["Unstake to USDC"]);
    expect(plainText(taken)).toContain("Unstake to USDC: your TAO is sold on Base and the USDC is sent to your wallet.");
    // while any request runs the switch is held: no other form may come up under a wallet's prompt
    expect(section({ onAsTao: noop, busy: true })).toMatch(/<button type="button" class="link" disabled="">Receive TAO instead of USDC<\/button>/);
    expect(offered).not.toContain('disabled=""');
    // the emergency way out, in plain steps: the fee's TAO first, where the TAO ends up last
    expect(plainText(offered)).toContain("your TAO arrives at this same wallet address on the Bittensor network, not on Base.");
    expect([...offered.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1])).toEqual([
      "Have about 0.02 TAO at this address on Bittensor for the network fee.",
      "Open the page: your wallet switches to the Bittensor network.",
      "Withdraw. Your TAO lands in your wallet on Bittensor.",
    ]);
    // no choice to offer (the page gives no switch): the emergency page alone, as before
    expect(buttons(section({}))).toEqual([]);
    expect(plainText(section({}))).toContain("Withdraw on Bittensor");
    // and the page offers it only on v3.2 with USDC delivery on; a choice made before never outlives that
    expect(taoChoice({ v32: true, usdcDelivery: true, asTao: false })).toEqual({ offered: true, asTao: false });
    expect(taoChoice({ v32: true, usdcDelivery: true, asTao: true })).toEqual({ offered: true, asTao: true });
    expect(taoChoice({ v32: true, usdcDelivery: false, asTao: true })).toEqual({ offered: false, asTao: false });
    expect(taoChoice({ v32: false, usdcDelivery: true, asTao: true })).toEqual({ offered: false, asTao: false });
  });
});
