import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { createElement } from "react";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { ActivityTab } from "@/lib/activity-params";
import { cascadeKeys } from "@/lib/cascade/hooks";
import { createOpLog, type DepositOp, type Operation, type WithdrawalOp } from "@/lib/cascade/oplog";
import { pendingEntry } from "@/lib/cascade/pending";
import type { DepositRecord, WithdrawalRecord } from "@/lib/cascade/records";
import type { OpenBatch } from "@/lib/cascade/types";
import { type Cached, launchData, plainText, renderWithCache } from "../test-render";
import { CANCEL_AT_ONCE, CANCEL_MARGIN_S, CANCEL_OPEN_STATUS, CANCEL_WAITING_STATUS, cancelCall, runFlow, type WalletPort } from "@/lib/cascade/flows";
import { notConfiguredData } from "@/lib/cascade/live";
import { cancelStore, settleCancel } from "@/lib/cascade/op-store";
import { appGuard } from "@/lib/cascade/use-flows";
import { DepositDetail, Lists, OLDER_CHECKING, PendingReceipt, WithdrawalDetail } from "./ActivityScreen";

const ME = "0x1234567890abcdef1234567890abcdef12345678";
const at = new Date("2026-10-28T12:00:00Z");

const deposit: DepositRecord = {
  id: "d1",
  createdAt: at,
  sourceChain: "base",
  status: "staked",
  steps: [{ key: "stake", title: "Stake on Bittensor", status: "done" }],
  taoWei: 10n ** 17n,
  taoAmount: 0.1,
  amountUsd: 25,
};

const unstake = (over: Partial<WithdrawalRecord> = {}): WithdrawalRecord => ({
  id: "w1",
  createdAt: at,
  status: "in_progress",
  steps: [{ key: "return", title: "Return to Base", status: "active" }],
  shares: 10n ** 17n,
  taoAmount: 0.07,
  usdcAmount: 17.41,
  claimable: 0n,
  ...over,
});

const html = (tab: ActivityTab, withdrawals: WithdrawalRecord[]) =>
  renderWithCache(createElement(Lists, { account: ME, tab }), [
    { key: cascadeKeys.deposits(ME), data: [deposit] },
    { key: cascadeKeys.withdrawals(ME), data: withdrawals },
  ]);

describe("Activity lists", () => {
  it("shows one list at a time, with both tabs' counts", () => {
    const text = plainText(html("deposits", [unstake()]));
    expect(text).toContain("Deposits: 1Unstakes: 1");
    expect(text).toContain("$25 from Base");
    expect(text).not.toContain("17.41");
    expect(plainText(html("unstakes", [unstake()]))).not.toContain("$25 from Base");
  });

  it("marks the open tab", () => {
    expect(html("unstakes", [unstake()])).toMatch(/aria-current="page"[^>]*>Unstakes/);
  });

  it("puts a dot on Unstakes while money is ready to claim, so it can't hide behind Deposits", () => {
    expect(plainText(html("deposits", [unstake({ status: "ready" })]))).toContain("Unstakes: 1, money ready to claim");
    expect(plainText(html("deposits", [unstake()]))).not.toContain("ready to claim");
  });

  it("puts no dot on what stays flagged after it's dealt with (a daily-limit unstake, a claim whose swap failed)", () => {
    const dailyLimit = unstake({ status: "needs_you", unstakeAgain: true, steps: [{ key: "unstake", title: "Unstake on Bittensor", status: "action" }] });
    const swapFailed = unstake({ status: "needs_you", steps: [{ key: "claim", title: "Swap it to USDC", status: "action" }] });
    expect(plainText(html("deposits", [dailyLimit, swapFailed]))).not.toContain("ready to claim");
  });

  it("says so when there are no unstakes yet", () => {
    expect(plainText(html("unstakes", []))).toContain("No unstakes yet.");
  });

  it("says under the deposits that older history is still being checked, while the indexer's seed isn't the browser's own reading yet (review 2)", () => {
    const withHistory = (provisional: boolean, data = launchData(undefined, { indexerUrl: "https://api.cascadefi.xyz" }), tab: ActivityTab = "deposits") =>
      plainText(
        renderWithCache(
          createElement(Lists, { account: ME, tab }),
          [
            { key: cascadeKeys.deposits(ME), data: [deposit] },
            { key: cascadeKeys.withdrawals(ME), data: [] },
            { key: cascadeKeys.history(ME), data: { pendingTao: 0, avgEntryPriceUsd: null, ...(provisional ? { provisional: true } : {}) } },
          ],
          { data },
        ),
      );
    expect(withHistory(true)).toContain(OLDER_CHECKING);
    expect(withHistory(false)).not.toContain(OLDER_CHECKING);
    expect(withHistory(true, launchData(undefined, { indexerUrl: "https://api.cascadefi.xyz" }), "unstakes")).not.toContain(OLDER_CHECKING);
    // with no indexer named nothing is ever seeded: the history isn't read for Activity at all (review 3)
    expect(withHistory(true, launchData())).not.toContain(OLDER_CHECKING);
  });

  it("shows the open tab as soon as its own list is read, without waiting for the other", () => {
    const h = renderWithCache(createElement(Lists, { account: ME, tab: "deposits" }), [{ key: cascadeKeys.deposits(ME), data: [deposit] }]);
    expect(plainText(h)).toContain("$25 from Base");
    expect(plainText(h)).toContain("Deposits: 1Unstakes");
  });
});

/** An op log holding `ops`, in memory, behind the launch deployment. */
function withOps(...ops: Operation[]) {
  const m = new Map<string, string>();
  const log = createOpLog({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }, ME);
  for (const o of ops) log.put(o);
  return launchData(log);
}

const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
/** A $50 stake this browser sent a minute ago, quoted at 0.19461 TAO. */
const sentDeposit = (): DepositOp => ({
  id: "d9",
  kind: "deposit",
  v: 3,
  account: ME,
  createdAt: Date.now() - 60_000,
  usdcIn: 50_000_000n,
  targetTao: 194_610_000_000_000_000n,
  minTaoOut: 193_600_000_000_000_000n,
  priceUsd: 256.9,
  hashes: { stake: H(1) },
  state: "sent",
});
const sentUnstake = (): WithdrawalOp => ({
  id: "w9",
  kind: "withdrawal",
  account: ME,
  createdAt: Date.now() - 60_000,
  shares: 7n * 10n ** 16n,
  taoEstimate: 7n * 10n ** 16n,
  usdcEstimate: 17_410_000n,
  fee: 10n ** 14n,
  hash: H(2),
  state: "sent",
});
/** Its record as the chain reads it: the stake's receipt deposited 0.19482 TAO, not the quote's 0.19461. */
const readDeposit: DepositRecord = { ...deposit, id: "d9", amountUsd: 50, taoWei: 194_820_000_000_000_000n, taoAmount: 0.19482, status: "in_progress" };
/** How many links to `href` the page has. */
const links = (h: string, href: string) => h.split(`href="${href}"`).length - 1;

describe("a deposit or unstake just sent, before Activity has read it", () => {
  const list = (tab: ActivityTab, cached: Parameters<typeof renderWithCache>[1], ...ops: Operation[]) =>
    renderWithCache(createElement(Lists, { account: ME, tab }), cached, { data: withOps(...ops) });

  it("shows at once, said to be unconfirmed, with the amount sent and the TAO estimate", () => {
    const h = list("deposits", [], sentDeposit());
    const text = plainText(h);
    expect(links(h, "/activity?deposit=d9")).toBe(1);
    expect(text).toContain("$50 from Base");
    expect(text).toContain("about 0.1946 TAO");
    expect(text).toContain("Confirming");
    expect(text).toContain("sent, not confirmed yet");
    // the rest of the history is still being read
    expect(text).toContain("Reading the rest from Base and Bittensor");
    // no count is given until the list is read
    expect(text).not.toMatch(/Deposits: \d/);
  });

  it("gives way to its record once the list is read: one row, with the chain's figures only", () => {
    const h = list("deposits", [{ key: cascadeKeys.deposits(ME), data: [readDeposit] }], sentDeposit());
    const text = plainText(h);
    expect(links(h, "/activity?deposit=d9")).toBe(1);
    expect(text).toContain("0.1948 TAO");
    expect(text).not.toContain("0.1946");
    expect(text).not.toContain("Confirming");
    expect(text).toContain("Deposits: 1");
  });

  it("shows above a list read before it was sent (cached from the Stake page), counted with it", () => {
    const h = list("deposits", [{ key: cascadeKeys.deposits(ME), data: [deposit] }], sentDeposit());
    const text = plainText(h);
    expect(links(h, "/activity?deposit=d9")).toBe(1);
    expect(links(h, "/activity?deposit=d1")).toBe(1);
    expect(text.indexOf("$50 from Base")).toBeLessThan(text.indexOf("$25 from Base"));
    expect(text).toContain("Deposits: 2");
    expect(text).not.toContain("No deposits yet");
  });

  it("an unstake: shows at once with its USDC estimate, then gives way to its record", () => {
    const before = list("unstakes", [{ key: cascadeKeys.deposits(ME), data: [] }], sentUnstake());
    expect(links(before, "/activity?withdrawal=w9")).toBe(1);
    expect(plainText(before)).toContain("about 17.41 USDC");
    expect(plainText(before)).toContain("Confirming");
    const after = list("unstakes", [{ key: cascadeKeys.withdrawals(ME), data: [unstake({ id: "w9" })] }], sentUnstake());
    expect(links(after, "/activity?withdrawal=w9")).toBe(1);
    expect(plainText(after)).not.toContain("Confirming");
  });

  it("a failed read shows only the entries just sent above the error, never the records read before it", () => {
    const text = plainText(list("deposits", [{ key: cascadeKeys.deposits(ME), data: [deposit], failed: true }], sentDeposit()));
    expect(text).toContain("$50 from Base");
    expect(text).toContain("We couldn't load your activity just now.");
    expect(text).not.toContain("$25 from Base");
  });

  it("shows nothing it can't stand behind: a stake that stopped, one taken back out, or one from last week", () => {
    const stopped = { ...sentDeposit(), state: "needs-you" as const };
    const cancelled = { ...sentDeposit(), cancelled: { hash: H(3), at: Date.now() } };
    const old = { ...sentDeposit(), createdAt: Date.now() - 8 * 24 * 60 * 60_000 };
    for (const op of [stopped, cancelled, old]) expect(plainText(list("deposits", [], op))).not.toContain("Confirming");
  });
});

describe("a receipt page before its list is read", () => {
  // a receipt can send the reader back to the list, so it asks for the router: a stub that goes nowhere
  const router = { push: () => undefined, replace: () => undefined, back: () => undefined, forward: () => undefined, refresh: () => undefined, prefetch: () => undefined };
  const page = (op: Operation) =>
    plainText(
      renderWithCache(createElement(AppRouterContext.Provider, { value: router as never }, createElement(DepositDetail, { account: ME, id: op.id })), [], {
        data: withOps(op),
      }),
    );

  it("shows a deposit sent in the last day as sent and confirming, in the receipt's own steps", () => {
    expect(page(sentDeposit())).toContain("Sent from this browser. Confirming on Base…");
  });

  it("waits for the list for one sent more than a day ago: it may well be staked, so it isn't called unconfirmed", () => {
    const text = page({ ...sentDeposit(), createdAt: Date.now() - 8 * 24 * 60 * 60_000 });
    expect(text).toContain("Loading your deposit…");
    expect(text).not.toContain("Submitted");
  });
});

describe("an unstake's receipt, claimed as TAO (Task 59b review, M4)", () => {
  const LENSES = { vaultLens: "0x000000000000000000000000000000000000Ae15" as const, doorLens: "0x000000000000000000000000000000000000De15" as const };
  const receipt = (w: WithdrawalRecord) =>
    renderWithCache(createElement(WithdrawalDetail, { account: ME, id: w.id }), [{ key: cascadeKeys.withdrawals(ME), data: [w] }], { data: launchData(undefined, LENSES) });
  const buttons = (h: string) => [...h.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

  it("offers Add to wallet beside Claim as TAO, and on a payout kept as TAO, so the wallet shows the TAO", () => {
    const tao = receipt(unstake({ status: "ready", claimable: 10n ** 16n, keepsTao: true }));
    expect(buttons(tao)).toEqual(["Claim as TAO", "Claim as USDC", "Add to wallet"]);
    expect(plainText(tao)).toContain("See your TAO in your wallet.");
    const kept = receipt(unstake({ status: "paid", received: { keptTao: 0.07 } }));
    expect(buttons(kept)).toEqual(["Add to wallet"]);
    // claimed as USDC, or offered as USDC alone: no TAO to see
    expect(buttons(receipt(unstake({ status: "ready", claimable: 10n ** 16n })))).toEqual(["Claim as USDC"]);
    expect(buttons(receipt(unstake({ status: "paid", received: { usdc: 17.41 } })))).toEqual([]);
  });

  it("names the deployment's own request fee beside the cancel that doesn't refund it: v3.2's 0.0002 ETH, v3-launch's 0.0001 ETH", () => {
    const open = unstake({ cancellableShares: 10n ** 17n });
    const h = receipt(open);
    expect(buttons(h)).toEqual(["Cancel unstake"]);
    expect(plainText(h)).toContain("If you cancel, the 0.0002 ETH request fee isn't refunded.");
    // the button is described by that line, so the fee is heard with it, not only seen under it
    const note = /<p id="([^"]+)">If you cancel, the 0\.0002 ETH request fee isn(?:'|&#x27;)t refunded\.<\/p>/.exec(h)?.[1];
    expect(note).toBeDefined();
    expect(h).toContain(`aria-describedby="${note}"`);
    expect(/<button\b([^>]*)>Cancel unstake<\/button>/.exec(h)?.[1]).toContain(`aria-describedby="${note}"`);
    const launch = renderWithCache(createElement(WithdrawalDetail, { account: ME, id: open.id }), [{ key: cascadeKeys.withdrawals(ME), data: [open] }], { data: launchData() });
    expect(plainText(launch)).toContain("If you cancel, the 0.0001 ETH request fee isn't refunded.");
    expect(plainText(launch)).not.toContain("0.0002 ETH");
  });
});

describe("a receipt opened before Activity has read it", () => {
  const card = (op: Operation) => {
    const entry = pendingEntry(op);
    if (!entry) throw new Error("no entry");
    return renderWithCache(createElement(PendingReceipt, { entry }), [], { data: withOps(op) });
  };

  it("a deposit: the receipt's own four steps from the moment it is sent, the first said plainly to be confirming, with its transaction on Base", () => {
    const h = card(sentDeposit());
    const text = plainText(h);
    expect(text).toContain("Where your $50 is going");
    // one layout at every stage: the trail, never a box of its own
    expect(h).toMatch(/<ol[^>]*aria-label="Deposit steps"/);
    expect([...h.matchAll(/<li\b/g)]).toHaveLength(4);
    for (const step of ["Swap USDC for TAO", "Deposit into Cascade", "Cross to Bittensor", "Stake on Bittensor"]) expect(text, step).toContain(step);
    expect(text).toContain("Sent from this browser. Confirming on Base…");
    expect(text).toContain("Leaves Base with the next batch, then the bridge (usually 20–30 minutes)");
    for (const gone of ["Submitted, confirming…", "not confirmed here yet", "these are the figures it was sent with"]) expect(text, gone).not.toContain(gone);
    // the confirmed receipt's own row and words, an estimate said to be one
    expect(text).toContain("TAO in this depositabout 0.1946 TAO");
    expect(h).toContain(`href="https://basescan.org/tx/${H(1)}"`);
    expect(h).toContain('href="/activity"');
  });

  it("an unstake: its estimates and its request on Base", () => {
    const h = card(sentUnstake());
    const text = plainText(h);
    expect(text).toContain("Your unstake of about $17.41");
    expect(h).toMatch(/<ol[^>]*aria-label="Unstake steps"/);
    for (const step of ["Request your unstake", "Unstake on Bittensor", "Return to Base", "USDC to your wallet"]) expect(text, step).toContain(step);
    expect(text).toContain("Sent from this browser. Confirming on Base…");
    // what is ahead, the safety wait first: on the receipt before anything is read from the chain
    expect(text).toMatch(/Starts after a (24-hour )?safety wait on Bittensor/);
    expect(text).toContain("Sold for USDC on Base and sent to your wallet automatically");
    expect(text).not.toContain("Submitted, confirming…");
    expect(text).toContain("You will receiveabout 17.41 USDC on Base");
    expect(h).toContain(`href="https://basescan.org/tx/${H(2)}"`);
    expect(h).toContain('href="/activity?tab=unstakes"');
  });
});

describe("R11: a deposit's cancel waits out its five-minute cooldown on the receipt", () => {
  const router = { push: () => undefined, replace: () => undefined, back: () => undefined, forward: () => undefined, refresh: () => undefined, prefetch: () => undefined };
  const waiting = (over: Partial<DepositRecord> = {}): DepositRecord => ({
    ...deposit,
    status: "in_progress",
    steps: [{ key: "bridge", title: "Cross to Bittensor", status: "active" }],
    cancellableWei: 10n ** 17n,
    cancelBatchId: 7n,
    ...over,
  });
  const receipt = (d: DepositRecord) =>
    renderWithCache(createElement(AppRouterContext.Provider, { value: router as never }, createElement(DepositDetail, { account: ME, id: d.id })), [{ key: cascadeKeys.deposits(ME), data: [d] }]);
  const cancel = (h: string) => /<button\b([^>]*)>Cancel deposit<\/button>/.exec(h)?.[1];
  const nowS = () => Math.floor(Date.now() / 1000);
  /** R12d (M1): the front door read just now, on a device whose clock agrees with Base's (`skewS`: how far it is off) */
  const readNow = (skewS = 0) => ({ chainTime: nowS() - skewS, readAt: Date.now() });
  /** cancelableAt `inS` seconds after Base's clock at that read */
  const cooling = (inS: number, skewS = 0) => {
    const cancelClock = readNow(skewS);
    return { cancelableAt: cancelClock.chainTime + inS, cancelClock };
  };

  it("inside the cooldown: says how long until a cancel works (and the margin), and the button waits", () => {
    const h = receipt(waiting(cooling(200)));
    expect(plainText(h)).toMatch(new RegExp(`You can cancel this deposit in 3 min (${19 + CANCEL_MARGIN_S}|${20 + CANCEL_MARGIN_S}) s: a cancel works 5 minutes after the last deposit to your entry\\.`));
    expect(cancel(h)).toContain("disabled");
  });

  it("R12d (M1): a device clock 20 minutes slow or fast shows the same wait and holds the button no longer: the wait is counted on Base's clock", () => {
    for (const skewS of [-20 * 60, 20 * 60]) {
      const h = receipt(waiting(cooling(200, skewS)));
      expect(plainText(h), String(skewS)).toMatch(new RegExp(`You can cancel this deposit in 3 min (${19 + CANCEL_MARGIN_S}|${20 + CANCEL_MARGIN_S}) s:`));
      expect(cancel(h), String(skewS)).toContain("disabled");
      // its cooldown over on Base's clock: open, whatever this device's clock says
      const over = receipt(waiting(cooling(-(CANCEL_MARGIN_S + 1), skewS)));
      expect(plainText(over), String(skewS)).not.toContain("You can cancel this deposit in");
      expect(cancel(over), String(skewS)).not.toContain("disabled");
    }
    // a read whose cancelableAt is further off than a cooldown can be: never held more than 5 minutes past the read
    expect(plainText(receipt(waiting(cooling(3_600))))).toMatch(/You can cancel this deposit in 5 min 0 s:/);
  });

  it("past it, at 0 (no wait), or on v3-launch (none read): the button is open and nothing waits", () => {
    for (const over of [cooling(-(CANCEL_MARGIN_S + 1)), { cancelableAt: 0, cancelClock: readNow() }, {}] as Partial<DepositRecord>[]) {
      const h = receipt(waiting(over));
      const said = String(over.cancelableAt);
      expect(plainText(h), said).not.toContain("You can cancel this deposit in");
      expect(cancel(h), said).toBeDefined();
      expect(cancel(h), said).not.toContain("disabled");
    }
  });

  it("R12d: the countdown that changes each second is no live region; a screen reader is told the state (waiting, then open) instead", () => {
    const h = receipt(waiting(cooling(200)));
    const live = [...h.matchAll(/<p\b[^>]*role="status"[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
    expect(live).toEqual([CANCEL_WAITING_STATUS.replace(/'/g, "&#x27;")]);
    // (a plain paragraph: no role, no aria-live)
    expect(h).toMatch(/<p>You can cancel this deposit in /);
    const open = receipt(waiting(cooling(-(CANCEL_MARGIN_S + 1))));
    expect([...open.matchAll(/<p\b[^>]*role="status"[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1])).toEqual([CANCEL_OPEN_STATUS]);
  });

  it("build B: cancelableAt 0 (deposits paused, or batches unable to leave) says a cancel works at once; build A's door never reads 0", () => {
    const h = receipt(waiting({ cancelableAt: 0, cancelClock: readNow() }));
    expect(plainText(h)).toContain(CANCEL_AT_ONCE);
    expect(CANCEL_AT_ONCE).toBe("While deposits are paused, or batches can't leave, a cancel works at once: there is no 5-minute wait.");
    expect(cancel(h)).not.toContain("disabled");
    for (const over of [cooling(-(CANCEL_MARGIN_S + 1)), cooling(200), {}] as Partial<DepositRecord>[]) expect(plainText(receipt(waiting(over))), JSON.stringify(over)).not.toContain("a cancel works at once");
  });

  it("a deposit whose batch left (no cancellableWei) shows neither a cancel nor a wait, however recent its last deposit", () => {
    const h = receipt(waiting({ cancellableWei: undefined, cancelBatchId: undefined, ...cooling(200) }));
    expect(cancel(h)).toBeUndefined();
    expect(plainText(h)).not.toContain("You can cancel this deposit in");
  });
});

// ---- the receipt's bottom: Send it now and the cancel in one row, and what a cancel sent from this browser leaves there ----

/** A receipt can send the reader back to the list, so it asks for the router: one that goes nowhere. */
const ROUTER = { push: () => undefined, replace: () => undefined, back: () => undefined, forward: () => undefined, refresh: () => undefined, prefetch: () => undefined };
/** 8:00 AM UTC (the tests read times in UTC). */
const START = 1_800_000_000;
/** Batch 7 as read just now, two hours in: it can close, Bittensor can take it, and what sending it costs has been read.
 * The account has a deposit and an unstake in it. */
const openBatch = (over: Partial<OpenBatch> = {}): Cached => ({
  key: cascadeKeys.openBatch(ME),
  at: Date.now(),
  data: {
    id: 7n,
    start: START,
    interval: 3_600,
    canClose: true,
    paused: false,
    chainTime: START + 7_200,
    mine: { depositWei: 10n ** 17n, redeemShares: 10n ** 21n },
    potWei: 0n,
    bittensor: "open",
    feeWei: 744_898_037_875_672n,
    ethWei: 10n ** 16n,
    gasWei: 10n ** 13n,
    ethPriceUsd: 2_330,
    ...over,
  } satisfies OpenBatch,
});
/** A $25 deposit waiting in that batch, as the list last read it: its cancel offered. */
const inBatch = (over: Partial<DepositRecord> = {}): DepositRecord => ({
  ...deposit,
  status: "in_progress",
  steps: [
    { key: "swap", title: "Swap USDC for TAO", status: "done" },
    { key: "deposit", title: "Deposit into Cascade", status: "done" },
    { key: "bridge", title: "Cross to Bittensor", status: "active", detail: "On Base, waiting for the next batch. Leaves by about 8:00 AM tomorrow, then the bridge (usually 20–30 minutes)." },
    { key: "stake", title: "Stake on Bittensor", status: "pending" },
  ],
  cancellableWei: 10n ** 17n,
  cancelBatchId: 7n,
  ...over,
});
/** An unstake waiting in it. */
const unstakeInBatch = (over: Partial<WithdrawalRecord> = {}): WithdrawalRecord =>
  unstake({
    steps: [
      { key: "request", title: "Request your unstake", status: "done" },
      { key: "unstake", title: "Unstake on Bittensor", status: "active", detail: "On Base, waiting for the next batch. Leaves by about 8:00 AM tomorrow, then the bridge (usually 20–30 minutes)." },
      { key: "return", title: "Return to Base", status: "pending" },
      { key: "claim", title: "USDC to your wallet", status: "pending" },
    ],
    shares: 10n ** 21n,
    cancellableShares: 10n ** 21n,
    ...over,
  });
const depositPage = (cached: Cached[], data = launchData(), d = inBatch()) =>
  renderWithCache(createElement(AppRouterContext.Provider, { value: ROUTER as never }, createElement(DepositDetail, { account: ME, id: d.id })), [{ key: cascadeKeys.deposits(ME), data: [d] }, ...cached], { data });
const unstakePage = (cached: Cached[], data = launchData(), w = unstakeInBatch()) =>
  renderWithCache(createElement(AppRouterContext.Provider, { value: ROUTER as never }, createElement(WithdrawalDetail, { account: ME, id: w.id })), [{ key: cascadeKeys.withdrawals(ME), data: [w] }, ...cached], { data });
/** Every button on the page, by its words. */
const allButtons = (h: string) => [...h.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
/** The block's rows of buttons (SendItNow.module.css .row), each as its buttons' words in order. */
const rows = (h: string) =>
  [...h.matchAll(/<div class="[^"]*_row_[^"]*">((?:<button\b[^>]*>[^<]*<\/button>)+)<\/div>/g)].map((m) => [...m[1].matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map((b) => b[2]));

describe("the receipt's two buttons while it waits in its open batch: Send it now and the cancel, in one row", () => {
  it("a deposit: both, when both are offered, inside the one row container, each a real ghost-pill button; their small print under the row", () => {
    const h = depositPage([openBatch()]);
    expect(rows(h)).toEqual([["Send it now: about $1.74", "Cancel deposit"]]);
    // nothing else on the receipt is a button: the two are side by side in that row, and nowhere else
    expect(allButtons(h)).toEqual(["Send it now: about $1.74", "Cancel deposit"]);
    expect(h).toMatch(/<div class="[^"]*_row_[^"]*"><button type="button" class="pill pill-ghost">Send it now: about \$1\.74<\/button><button type="button" class="pill pill-ghost pill-danger">Cancel deposit<\/button><\/div>/);
    const text = plainText(h);
    expect(text).toContain("Leaves in 22 h (by 8:00 AM tomorrow), or sooner.");
    expect(text).toContain("You pay the whole batch's bridge fee, in ETH. Up to $2.26 is sent; any extra is refunded.");
    // one line, the row, then the note: in that order
    expect(h.indexOf("Leaves in 22 h")).toBeLessThan(h.indexOf("_row_"));
    expect(h.indexOf("_row_")).toBeLessThan(h.indexOf("You pay the whole batch"));
  });

  it("a deposit inside its cancel's cooldown: the cancel held in the row, and how long it waits under the row, after Send it now's own note", () => {
    const nowS = Math.floor(Date.now() / 1000);
    const h = depositPage([openBatch()], launchData(), inBatch({ cancelableAt: nowS + 200, cancelClock: { chainTime: nowS, readAt: Date.now() } }));
    expect(rows(h)).toEqual([["Send it now: about $1.74", "Cancel deposit"]]);
    expect(/<button\b([^>]*)>Cancel deposit<\/button>/.exec(h)?.[1]).toContain("disabled");
    expect(/<button\b([^>]*)>Send it now: about \$1\.74<\/button>/.exec(h)?.[1]).not.toContain("disabled");
    expect(h.indexOf("_row_")).toBeLessThan(h.indexOf("You pay the whole batch"));
    expect(h.indexOf("You pay the whole batch")).toBeLessThan(h.indexOf("You can cancel this deposit in"));
  });

  it("the cancel alone fills the row, and is never held, when Send it now isn't offered yet or the batch's block has nothing to show", () => {
    const alone = (h: string, why: string) => {
      expect(rows(h), why).toEqual([["Cancel deposit"]]);
      expect(allButtons(h), why).toEqual(["Cancel deposit"]);
      expect(/<button\b([^>]*)>Cancel deposit<\/button>/.exec(h)?.[1], why).toBe(' type="button" class="pill pill-ghost pill-danger"');
    };
    // before Send it now is offered (ten minutes into the batch): when it leaves, and when it can be sent
    const early = depositPage([openBatch({ canClose: false, chainTime: START + 600, economics: { feesUsdc: 430_000n, bridgeFeeUsdc: 1_735_000n }, bittensor: undefined, feeWei: undefined })]);
    alone(early, "early");
    expect(plainText(early)).toContain("Send it yourself in 55 min (from 9:05 AM).");
    // the batch not read yet (or its read failing): no block at all, and the cancel still there
    const unread = depositPage([]);
    alone(unread, "unread");
    // the box's own line ("Leaves in ..."); the step above it says when the batch leaves too
    expect(plainText(unread)).not.toMatch(/Leaves (in |any moment|within )/);
    // the contracts don't match (the wiring check): Send it now shows nothing, the way out stays
    const blocked = depositPage([openBatch(), { key: ["wiring"], data: "mismatch" }]);
    alone(blocked, "blocked");
    expect(plainText(blocked)).not.toMatch(/Leaves (in |any moment|within )/);
    expect(plainText(blocked)).not.toContain("Send it now");
    // v3-launch's front door paused: nothing to send, the cancel stays
    alone(depositPage([openBatch({ paused: true })]), "paused");
    // the keeper sends it any moment, or Bittensor's side can't take it: a line, and the cancel
    const free = depositPage([openBatch({ chainTime: START + 600 })]);
    alone(free, "free");
    expect(plainText(free)).toContain("Leaves any moment now.");
    alone(depositPage([openBatch({ bittensor: "paused" })]), "bittensor paused");
    // no deployment at all (its reads all fail)
    alone(depositPage([], notConfiguredData()), "no deployment");
  });

  it("an unstake: Send it now and its cancel in the one row, and under it that the cancel doesn't refund the request fee", () => {
    const h = unstakePage([openBatch({ mine: { depositWei: 0n, redeemShares: 10n ** 21n } })]);
    expect(rows(h)).toEqual([["Send it now: about $1.74", "Cancel unstake"]]);
    expect(allButtons(h)).toEqual(["Send it now: about $1.74", "Cancel unstake"]);
    expect(h.indexOf("_row_")).toBeLessThan(h.indexOf("If you cancel, the 0.0001 ETH request fee"));
    // and its cancel alone, with that line, when the batch's block has nothing to show
    for (const cached of [[], [openBatch(), { key: ["wiring"], data: "mismatch" }]] as Cached[][]) {
      const alone = unstakePage(cached);
      expect(rows(alone)).toEqual([["Cancel unstake"]]);
      expect(plainText(alone)).toContain("If you cancel, the 0.0001 ETH request fee isn't refunded.");
      expect(/<button\b([^>]*)>Cancel unstake<\/button>/.exec(alone)?.[1]).not.toContain("disabled");
    }
  });

  it("while a flow runs both are held; the cancel says to confirm in the wallet while the flow is its own, Send it now while it is its own", async () => {
    /** The page as it renders while the app's one flow lock is held by `label`. */
    const during = async (label: string, page: () => string) => {
      let release = () => undefined as void;
      const running = appGuard.run(label, () => new Promise<void>((done) => (release = done)));
      try {
        return page();
      } finally {
        release();
        await running;
      }
    };
    const held = (h: string) => [...h.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map((m) => [m[2], m[1].includes("disabled")]);
    expect(held(await during("cancel", () => depositPage([openBatch()])))).toEqual([["Send it now: about $1.74", true], ["Confirm in your wallet…", true]]);
    expect(held(await during("send", () => depositPage([openBatch()])))).toEqual([["Confirm in your wallet…", true], ["Cancel deposit", true]]);
    expect(held(await during("stake", () => depositPage([openBatch()])))).toEqual([["Send it now: about $1.74", true], ["Cancel deposit", true]]);
    const unstakeBatch = openBatch({ mine: { depositWei: 0n, redeemShares: 10n ** 21n } });
    expect(held(await during("cancel", () => unstakePage([unstakeBatch])))).toEqual([["Send it now: about $1.74", true], ["Confirm in your wallet…", true]]);
    expect(held(await during("claim", () => unstakePage([unstakeBatch])))).toEqual([["Send it now: about $1.74", true], ["Cancel unstake", true]]);
    // and none is held once it ends
    expect(held(depositPage([openBatch()]))).toEqual([["Send it now: about $1.74", false], ["Cancel deposit", false]]);
  });

  it("a deposit or unstake that has left its batch shows no row at all", () => {
    expect(rows(depositPage([openBatch()], launchData(), inBatch({ cancellableWei: undefined, cancelBatchId: undefined })))).toEqual([]);
    expect(rows(unstakePage([openBatch()], launchData(), unstakeInBatch({ cancellableShares: undefined })))).toEqual([]);
  });
});

describe("after a cancel is sent from this browser, the receipt stops offering Cancel and Send it now, before the list has read it", () => {
  const CANCEL = H(0xcc);
  const TX = `https://basescan.org/tx/${CANCEL}`;
  /** This browser's own record of the deposit (the receipt's id), an hour old. */
  const depositOp = (over: Partial<DepositOp> = {}): DepositOp => ({
    id: "d1",
    kind: "deposit",
    v: 3,
    account: ME,
    createdAt: Date.now() - 60 * 60_000,
    usdcIn: 25_000_000n,
    targetTao: 10n ** 17n,
    hashes: { stake: H(1) },
    batchId: 7n,
    state: "sent",
    ...over,
  });
  const unstakeOp = (over: Partial<WithdrawalOp> = {}): WithdrawalOp => ({
    id: "w1",
    kind: "withdrawal",
    account: ME,
    createdAt: Date.now() - 60 * 60_000,
    shares: 10n ** 21n,
    taoEstimate: 7n * 10n ** 16n,
    usdcEstimate: 17_410_000n,
    fee: 10n ** 14n,
    hash: H(2),
    batchId: 7n,
    state: "sent",
    ...over,
  });
  /** Sent five seconds ago; `confirmed` once its flow saw it through (op-store.ts confirmCancel). */
  const sent = (confirmed = false) => ({ hash: CANCEL, at: Date.now() - 5_000, ...(confirmed ? { confirmed: true as const } : {}) });
  /** The list still holds the deposit as read before the cancel: in its batch, both buttons offered. */
  const stale = [openBatch()];

  it("with no cancel recorded, exactly as before: both buttons", () => {
    expect(allButtons(depositPage(stale, withOps(depositOp())))).toEqual(["Send it now: about $1.74", "Cancel deposit"]);
    expect(allButtons(unstakePage(stale, withOps(unstakeOp())))).toEqual(["Send it now: about $1.74", "Cancel unstake"]);
  });

  it("in flight: neither button; in their place that it is cancelling, with its transaction; the trail says so too", () => {
    const h = depositPage(stale, withOps(depositOp({ cancelled: sent() })));
    expect(allButtons(h)).toEqual([]);
    expect(rows(h)).toEqual([]);
    const text = plainText(h);
    expect(text).toContain("Cancelling your deposit…");
    expect(text).not.toContain("Send it now");
    expect(text).not.toContain("Leaves in");
    expect(text).not.toContain("Cancel deposit");
    // told to a screen reader as it appears, with the cancel's transaction on Base
    expect(h).toMatch(new RegExp(`<div class="[^"]*_box_[^"]*" role="status"><p[^>]*>Cancelling your deposit…</p><p[^>]*><a href="${TX}"[^>]*>View the transaction`));
    // the trail's step, as a read of the chain will show it
    expect(text).toContain("Cross to BittensorCancelling…");
    expect(text).not.toContain("waiting for the next batch");
  });

  it("confirmed before the scan catches up: shown as cancelled, its TAO back as TAO, not USDC, and neither button", () => {
    const data = () => withOps(depositOp({ cancelled: sent(true) }));
    const h = depositPage(stale, data());
    expect(allButtons(h)).toEqual([]);
    const text = plainText(h);
    expect(text).toContain("Deposit cancelled.Your TAO is back in your wallet as TAO, not USDC. View the transaction");
    expect(h).toContain(`href="${TX}"`);
    expect(text).toContain("Cross to BittensorCancelled. Your TAO is back in your wallet as TAO, not USDC");
    for (const gone of ["Send it now", "Leaves in", "Cancel deposit", "Cancelling", "waiting for the next batch"]) expect(text, gone).not.toContain(gone);
    // a read from a node behind the cancel's block, which says that same cancel failed and offers it again: within the
    // cancel's ten minutes the read is taken to be behind, and it is still cancelled
    const lagging = depositPage(stale, data(), inBatch({ cancelSeen: CANCEL }));
    expect(allButtons(lagging)).toEqual([]);
    expect(plainText(lagging)).toContain("Deposit cancelled.");
    // inside the cooldown of a stale read: no wait is counted for a cancel that is done
    const nowS = Math.floor(Date.now() / 1000);
    const cooling = depositPage(stale, data(), inBatch({ cancelableAt: nowS + 200, cancelClock: { chainTime: nowS, readAt: Date.now() } }));
    expect(plainText(cooling)).not.toContain("You can cancel this deposit in");
    expect(cooling).not.toMatch(/<p\b[^>]*role="status"/);
    // its TAO, once the wallet's balance shows it, can be swapped back, as on any cancelled deposit's receipt
    const balances = { key: cascadeKeys.balances(ME), data: { usdc: 0n, tao: 10n ** 17n, eth: 10n ** 16n, usdcRouterAllowance: 0n, usdcStakerAllowance: 0n, taoRouterAllowance: 0n, taoFrontDoorAllowance: 0n, claimable: 0n } };
    expect(allButtons(depositPage([...stale, balances], data()))).toEqual(["Swap your TAO back to USDC"]);
  });

  it("a confirmed mark never holds the ways out against the chain for the batch's life: past the cancel's ten minutes, a read that names that very cancel as failed gives both buttons back", () => {
    const old = { hash: CANCEL, at: Date.now() - 11 * 60_000, confirmed: true as const };
    const refused = depositPage(stale, withOps(depositOp({ cancelled: old })), inBatch({ cancelSeen: CANCEL }));
    expect(allButtons(refused)).toEqual(["Send it now: about $1.74", "Cancel deposit"]);
    const text = plainText(refused);
    for (const gone of ["Deposit cancelled", "Cancelled.", "Cancelling"]) expect(text, gone).not.toContain(gone);
    expect(text).toContain("waiting for the next batch");
    // the same mark on a read that knows of no cancel (made before it), or only of another: still cancelled, however old
    for (const read of [inBatch(), inBatch({ cancelSeen: H(0xee) })]) {
      const stillStale = depositPage(stale, withOps(depositOp({ cancelled: old })), read);
      expect(allButtons(stillStale)).toEqual([]);
      expect(plainText(stillStale)).toContain("Deposit cancelled.");
    }
    // an unstake's the same
    const unstakeRefused = unstakePage(stale, withOps(unstakeOp({ cancelled: old })), unstakeInBatch({ cancelSeen: CANCEL }));
    expect(allButtons(unstakeRefused)).toEqual(["Send it now: about $1.74", "Cancel unstake"]);
    expect(plainText(unstakeRefused)).not.toContain("Unstake cancelled");
    expect(allButtons(unstakePage(stale, withOps(unstakeOp({ cancelled: old })), unstakeInBatch()))).toEqual([]);
  });

  it("the cancel's own receipt settles what the page shows: definitely didn't take the deposit out, both buttons back at once; unreadable, still cancelling; took it out, cancelled", async () => {
    /** A wallet that sends the cancel and sees it through. */
    const wallet: WalletPort = {
      switchToBase: async () => undefined,
      canBatch: async () => false,
      sendBatch: async () => ({ id: "x" }),
      waitBatch: async () => ({ status: "success", hashes: [] }),
      send: async () => CANCEL,
      wait: async () => ({ status: "success" }),
      hasCode: async () => false,
      signPermit: async () => ({ v: 27, r: CANCEL, s: CANCEL }),
      simulate: async () => ({ ok: true }),
    };
    /** The receipt once the cancel's flow has ended, its record settled by what its own receipt said (use-flows.ts cancel) */
    const page = async (outcome: boolean | undefined) => {
      const m = new Map<string, string>();
      const log = createOpLog({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }, ME);
      log.put(depositOp());
      const data = launchData(log);
      const store = cancelStore(log, ME, "d1");
      await runFlow(wallet, store, [cancelCall("deposit", 10n ** 17n, data.deployment)]);
      // sent, and seen through by the wallet: on its way until its receipt is read
      expect(plainText(depositPage(stale, data))).toContain("Cancelling your deposit…");
      settleCancel(store, log, ME, "d1", CANCEL, outcome);
      return depositPage(stale, data);
    };
    // a definite no: nothing of "Cancelling…" for ten minutes, the cancel (and Send it now) is offered again at once
    const no = await page(false);
    expect(allButtons(no)).toEqual(["Send it now: about $1.74", "Cancel deposit"]);
    expect(/<button\b([^>]*)>Cancel deposit<\/button>/.exec(no)?.[1]).not.toContain("disabled");
    for (const gone of ["Cancelling", "Deposit cancelled"]) expect(plainText(no), gone).not.toContain(gone);
    // Base can't show its receipt yet: not known, so it stays on its way and nothing is offered twice
    const unread = await page(undefined);
    expect(allButtons(unread)).toEqual([]);
    expect(plainText(unread)).toContain("Cancelling your deposit…");
    // it took the deposit out
    const yes = await page(true);
    expect(allButtons(yes)).toEqual([]);
    expect(plainText(yes)).toContain("Deposit cancelled.");
  });

  it("a mark dated hours ahead of this device's clock is not a cancel on its way: both buttons", () => {
    const ahead = depositPage(stale, withOps(depositOp({ cancelled: { hash: CANCEL, at: Date.now() + 12 * 60 * 60_000 } })));
    expect(allButtons(ahead)).toEqual(["Send it now: about $1.74", "Cancel deposit"]);
    expect(plainText(ahead)).not.toContain("Cancelling");
  });

  it("failed: a cancel that left no mark (reverted, or declined in the wallet), or one the read saw fail, gives both buttons back", () => {
    // reverted in this tab: the store took its mark back off the record (op-store.ts cancelStore)
    expect(allButtons(depositPage(stale, withOps(depositOp())))).toEqual(["Send it now: about $1.74", "Cancel deposit"]);
    // sent, never confirmed, and the list (read since) found it didn't take the deposit out
    const seen = depositPage(stale, withOps(depositOp({ cancelled: sent() })), inBatch({ cancelSeen: CANCEL }));
    expect(allButtons(seen)).toEqual(["Send it now: about $1.74", "Cancel deposit"]);
    expect(plainText(seen)).not.toContain("Cancelling your deposit");
    // sent more than ten minutes ago with nothing to confirm it: the record's word stands
    const old = depositPage(stale, withOps(depositOp({ cancelled: { hash: CANCEL, at: Date.now() - 11 * 60_000 } })));
    expect(allButtons(old)).toEqual(["Send it now: about $1.74", "Cancel deposit"]);
  });

  it("another deposit's cancel never hides this one's buttons", () => {
    const h = depositPage(stale, withOps(depositOp(), depositOp({ id: "d2", cancelled: sent(true) }), depositOp({ id: "d3", cancelled: sent() })));
    expect(allButtons(h)).toEqual(["Send it now: about $1.74", "Cancel deposit"]);
    expect(plainText(h)).not.toContain("cancelled");
  });

  it("an unstake's cancel, the same: on its way, then cancelled with its shares kept and its request fee not refunded", () => {
    const flying = unstakePage(stale, withOps(unstakeOp({ cancelled: sent() })));
    expect(allButtons(flying)).toEqual([]);
    expect(plainText(flying)).toContain("Cancelling your unstake…");
    expect(plainText(flying)).toContain("Unstake on BittensorCancelling…");
    expect(flying).toContain(`href="${TX}"`);
    expect(plainText(flying)).not.toContain("If you cancel");
    const done = unstakePage(stale, withOps(unstakeOp({ cancelled: sent(true) })));
    expect(allButtons(done)).toEqual([]);
    const text = plainText(done);
    expect(text).toContain("Unstake cancelled.Your shares stay staked; the request fee isn't refunded. View the transaction");
    expect(text).toContain("Cancelled before the batch closed. Your shares stay staked; the request fee isn't refunded");
    for (const gone of ["Send it now", "Leaves in", "Cancel unstake", "You will receive", "If you cancel"]) expect(text, gone).not.toContain(gone);
    // a deposit's cancel isn't its unstake's
    expect(allButtons(unstakePage(stale, withOps(unstakeOp(), depositOp({ cancelled: sent(true) }))))).toEqual(["Send it now: about $1.74", "Cancel unstake"]);
  });
});

describe("the receipt's figures", () => {
  it("says the price the deposit's TAO was bought at when this browser knows it (the list's row leaves it out on a phone), and no row when it doesn't", () => {
    const known = plainText(depositPage([], launchData(), inBatch({ taoPriceUsd: 191.52 })));
    expect(known).toContain("TAO in this deposit0.1000 TAOBought at$191.52 per TAO");
    expect(plainText(depositPage([], launchData(), inBatch()))).not.toContain("Bought at");
  });
});
