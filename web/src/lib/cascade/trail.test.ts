import { describe, expect, it } from "vitest";
import {
  adapterDelivered,
  BATCH,
  BACK_TX,
  baseAt,
  BIT_CLOCK,
  BIT_HEAD,
  bitAt,
  bitTs,
  CHUNK_TX,
  chains,
  type Crossed,
  crossed,
  DAY,
  depositBounced,
  DIRECT,
  enc,
  event,
  EXEC_TX,
  fd,
  LAND_TX,
  LAUNCH,
  MSG,
  NOW_S,
  OTHER,
  PARK_KEY,
  parkedDropped,
  parkedRefunded,
  parkedRun,
  payoutReceived,
  receipt,
  redeemed,
  redeemSkipped,
  scanned,
  TAO,
  USER,
  V32,
  vault,
  vaultDelivered,
  VKEY,
} from "./__fixtures__/v32-chains";
import { ADAPTER, REFUND_CHUNK, VAULT_V32 } from "./abi";
import { RESUME_WINDOW_MS } from "./config";
import { depositFacts, withdrawalFacts } from "./facts";
import type { DepositOp, WithdrawalOp } from "./oplog";
import {
  chainOnlyDeposit,
  DEFERRED_UNREAD,
  DEPOSIT_CANCELLED,
  depositCancelSent,
  type DepositFacts,
  depositRecord,
  HOLD_DEFERRED,
  isDelivering,
  MINIMUM_DEFERRED,
  offersClaim,
  RAIL_DEFERRED,
  STAKE_LAPSED,
  UNSTAKE_CANCELLED,
  withdrawalCancelSent,
  type WithdrawalFacts,
  withdrawalRecord,
} from "./trail";

const ME = "0x000000000000000000000000000000000000A11c" as const;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const T0 = new Date("2026-10-25T10:00:00Z");

const op: DepositOp = {
  id: "d1",
  kind: "deposit",
  account: ME,
  createdAt: T0.getTime(),
  usdcIn: 20_000_000n,
  targetTao: 78_000_000_000_000_000n,
  priceUsd: 251.6,
  feesUsd: 0.08,
  mode: "sequential",
  hashes: { swap: H(1), deposit: H(2) },
  batchId: 3n,
  state: "sent",
};

const base: DepositFacts = {
  swapMined: true,
  depositMined: true,
  openBatchId: 3n,
  now: new Date("2026-10-25T10:05:00Z"),
  closesAt: new Date("2026-10-25T10:10:00Z"),
  waitingForMinimum: false,
  stillOpen: true,
};

const statuses = (r: { steps: { status: string }[] }) => r.steps.map((s) => s.status);

describe("deposit trail with a max wait", () => {
  it("words the close time as an upper bound, with the day when it is not today", () => {
    const same = depositRecord(op, { ...base, closesBy: true });
    expect(same.steps[2].detail).toMatch(/^Waits for the batch to close, by about 10:10 AM, then the bridge/);
    expect(same.steps[2].detail).not.toMatch(/tomorrow/);
    const next = depositRecord(op, { ...base, closesBy: true, now: new Date(2026, 9, 25, 10, 5), closesAt: new Date(2026, 9, 26, 14, 5) });
    expect(next.steps[2].detail).toMatch(/close, by about 2:05 PM tomorrow, then/);
    expect(depositRecord(op, base).steps[2].detail).toMatch(/^Waits for the batch to close at /);
  });
});

describe("deposit trail", () => {
  it("waits in the open batch, saying when it closes", () => {
    const r = depositRecord(op, base);
    expect(statuses(r)).toEqual(["done", "done", "active", "pending"]);
    expect(r.steps[2].detail).toMatch(/10:10 AM/);
    expect(r.cancellableWei).toBe(78_000_000_000_000_000n);
    expect(r.amountUsd).toBe(20);
    expect(r.status).toBe("in_progress");
  });

  it("says at what price only for a deposit recorded with one", () => {
    expect(depositRecord(op, base).taoPriceUsd).toBe(251.6);
    const unpriced: DepositOp = { ...op };
    delete unpriced.priceUsd;
    expect(depositRecord(unpriced, base)).not.toHaveProperty("taoPriceUsd");
    // wallet-TAO deposits were once recorded at $0 when no price was at hand
    expect(depositRecord({ ...op, priceUsd: 0 }, base)).not.toHaveProperty("taoPriceUsd");
  });

  it("marks a stopped deposit that never sent anything, so it can be removed", () => {
    const stopped = { ...op, state: "needs-you" as const, hashes: {} };
    const none = { ...base, swapMined: false, depositMined: false };
    expect(depositRecord(stopped, none).nothingSent).toBe(true);
    expect(depositRecord({ ...stopped, hashes: { approveUsdc: H(1) } }, none).nothingSent).toBeUndefined();
    expect(depositRecord({ ...stopped, callsId: "0xabc" }, none).nothingSent).toBeUndefined();
    expect(depositRecord({ ...op, state: "running" as const, hashes: {} }, none).nothingSent).toBeUndefined();
  });

  it("does not offer removal for a flow interrupted moments ago: its wallet prompt may still be open", () => {
    const left = { ...op, state: "needs-you" as const, hashes: {} };
    const none = { ...base, swapMined: false, depositMined: false, interrupted: true };
    expect(depositRecord(left, { ...none, now: new Date(T0.getTime() + 2 * 60_000) }).nothingSent).toBeUndefined();
    expect(depositRecord(left, { ...none, now: new Date(T0.getTime() + 15 * 60_000) }).nothingSent).toBe(true);
  });

  it("gives the bridge an expected arrival when it knows when the batch was sent", () => {
    const r = depositRecord(op, { ...base, openBatchId: 4n, stillOpen: false, sentAt: new Date("2026-10-25T10:12:00Z") });
    expect(r.steps[2].detail).toMatch(/expected around 10:32 AM/);
  });

  it("shows what the swap really spent once it is known, not the most it could spend", () => {
    expect(depositRecord(op, { ...base, usdcSpent: 19_903_212n }).amountUsd).toBeCloseTo(19.903212, 6);
    expect(depositRecord(op, base).amountUsd).toBe(20);
  });

  it("explains a failed step with the saved reason, and offers to try again or remove it when nothing was sent", () => {
    const failed = { ...op, state: "failed" as const, hashes: {}, error: "The price moved past your 0.5% limit, so the swap was undone." };
    const r = depositRecord(failed, { ...base, swapMined: false, depositMined: false });
    expect(r.steps[0].status).toBe("failed");
    expect(r.steps[0].detail).toBe("The price moved past your 0.5% limit, so the swap was undone.");
    expect(r.retryable).toBeUndefined();
    expect(r.restake).toBe(true);
    expect(r.nothingSent).toBe(true);
  });

  it("offers a fresh stake, not a retry, when the swap itself reverted (its hash is saved, so a retry would only re-read it)", () => {
    const reverted = { ...op, state: "failed" as const, hashes: { approveUsdc: H(1), swap: H(2) }, error: "The price moved past your 0.5% limit, so the swap was undone." };
    const r = depositRecord(reverted, { ...base, swapMined: false, depositMined: false });
    expect(r.restake).toBe(true);
    expect(r.retryable).toBeUndefined();
    const batch = { ...op, state: "failed" as const, hashes: {}, callsId: "0xabc", error: "x" };
    expect(depositRecord(batch, { ...base, swapMined: false, depositMined: false }).restake).toBe(true);
  });

  it("after a swap that worked but a deposit that failed, says the TAO is in the wallet", () => {
    const failed = { ...op, state: "failed" as const, hashes: { swap: H(1) }, error: "The deposit didn't go through." };
    const r = depositRecord(failed, { ...base, swapMined: true, depositMined: false });
    expect(r.steps[1].status).toBe("failed");
    expect(r.steps[1].detail).toMatch(/didn't go through/);
    expect(r.steps[1].detail).toMatch(/in your wallet/);
    expect(r.retryable).toBe(true);
    expect(r.nothingSent).toBeUndefined();
  });

  it("says the batch can close now once its time has passed", () => {
    const r = depositRecord(op, { ...base, now: new Date("2026-10-25T10:20:00Z") });
    expect(r.steps[2].detail).toMatch(/can close now/i);
    expect(r.steps[2].detail).not.toMatch(/10:10/);
  });

  it("R11: a deposit waiting in the open batch carries the account's cancelableAt and the batch it waits in; one whose batch left carries neither (its depositOf is the next batch's)", () => {
    const r = depositRecord(op, { ...base, cancelableAt: 1_800_000_300 });
    expect(r).toMatchObject({ cancellableWei: 78_000_000_000_000_000n, cancelableAt: 1_800_000_300, cancelBatchId: 3n });
    // 0: no wait (build B)
    expect(depositRecord(op, { ...base, cancelableAt: 0 }).cancelableAt).toBe(0);
    // v3-launch reads none: the batch alone
    const launch = depositRecord(op, base);
    expect(launch).toMatchObject({ cancelBatchId: 3n });
    expect(launch).not.toHaveProperty("cancelableAt");
    // its batch left: no cancel and no wait to show
    const left = depositRecord(op, { ...base, cancelableAt: 1_800_000_300, stillOpen: false, openBatchId: 4n });
    expect(left).not.toHaveProperty("cancellableWei");
    expect(left).not.toHaveProperty("cancelableAt");
    expect(left).not.toHaveProperty("cancelBatchId");
  });

  it("R12d (M1): with cancelableAt, the clock it was read on (the block's time and the device's read time); none once its batch left", () => {
    const cancelClock = { chainTime: 1_800_000_100, readAt: 1_700_000_000_000 };
    expect(depositRecord(op, { ...base, cancelableAt: 1_800_000_300, cancelClock })).toMatchObject({ cancelableAt: 1_800_000_300, cancelClock });
    expect(depositRecord(op, { ...base, cancelableAt: 1_800_000_300, cancelClock, stillOpen: false, openBatchId: 4n })).not.toHaveProperty("cancelClock");
  });

  it("shows a deposit taken back before the batch closed as cancelled", () => {
    const r = depositRecord({ ...op, cancelled: { hash: H(12), at: T0.getTime() } }, { ...base, cancelMined: true });
    expect(r.status).toBe("cancelled");
    expect(r.cancellableWei).toBeUndefined();
    expect(r.steps[2]).toMatchObject({ status: "failed" });
    expect(r.steps[2].detail).toMatch(/back in your wallet/i);
  });

  it("says it is cancelling, and offers no second cancel, while Base hasn't settled the one sent", () => {
    const sent = { ...op, cancelled: { hash: H(12), at: T0.getTime() + 4 * 60_000 } };
    const r = depositRecord(sent, { ...base, cancelPending: "unseen" });
    expect(r.steps[2]).toMatchObject({ status: "active", detail: "Cancelling…" });
    expect(r.steps[2].txUrl).toContain(H(12));
    expect(r.cancellableWei).toBeUndefined();
    expect(r.status).toBe("in_progress");
    // ten minutes on and Base still doesn't know it: dropped, and Cancel is offered again
    const later = depositRecord(sent, { ...base, cancelPending: "unseen", now: new Date(T0.getTime() + 15 * 60_000) });
    expect(later.cancellableWei).toBe(78_000_000_000_000_000n);
    expect(later.steps[2].detail).not.toBe("Cancelling…");
    // a cancel Base has, still waiting to be mined, is on its way however long it takes; after ten minutes
    // it says the wallet can speed it up
    const soon = depositRecord(sent, { ...base, cancelPending: "waiting", now: new Date(T0.getTime() + 8 * 60_000) });
    expect(soon.steps[2].detail).toBe("Cancelling…");
    const waiting = depositRecord(sent, { ...base, cancelPending: "waiting", now: new Date(T0.getTime() + 60 * 60_000) });
    expect(waiting.steps[2].detail).toBe("Cancelling… It's taking longer than usual. You can speed it up in your wallet.");
    expect(waiting.cancellableWei).toBeUndefined();
    // mined, its receipt not readable yet: no hint, it's done waiting
    expect(depositRecord(sent, { ...base, cancelPending: "mined", now: new Date(T0.getTime() + 60 * 60_000) }).steps[2].detail).toBe("Cancelling…");
  });

  it("shows the batch's real progress once it has closed, whatever became of a cancel sent before", () => {
    const sent = { ...op, cancelled: { hash: H(12), at: T0.getTime() + 4 * 60_000 } };
    const closed = { ...base, openBatchId: 4n, stillOpen: false, depositedAt: new Date("2026-10-25T09:53:00Z"), cancelPending: "waiting" as const };
    const r = depositRecord(sent, closed);
    expect(r.steps[2].detail).toMatch(/^On the bridge to Bittensor/);
    expect(r.cancellableWei).toBeUndefined();
  });

  it("stays cancelled after its batch is delivered with other people's deposits", () => {
    const delivered = { at: new Date("2026-10-25T10:35:00Z"), txHash: H(9), outcome: "deposited" as const };
    const r = depositRecord(
      { ...op, cancelled: { hash: H(12), at: T0.getTime() } },
      { ...base, openBatchId: 4n, stillOpen: false, delivered, staked: { at: new Date(), txHash: H(7) }, cancelMined: true },
    );
    expect(r.status).toBe("cancelled");
    expect(statuses(r)).toEqual(["done", "done", "failed", "pending"]);
    expect(r.steps[2].detail).toMatch(/back in your wallet/i);
    expect(r.cancellableWei).toBeUndefined();
  });

  it("says a cancelled deposit's TAO came back as TAO, not USDC", () => {
    expect(DEPOSIT_CANCELLED).toBe("Cancelled. Your TAO is back in your wallet as TAO, not USDC");
    expect(depositRecord({ ...op, cancelled: { hash: H(12), at: T0.getTime() } }, { ...base, cancelMined: true }).steps[2].detail).toBe(DEPOSIT_CANCELLED);
  });

  it("a record that offers its cancel again names the cancel its read saw fail (cancelSeen), so a cancel sent since is known to be newer than the read", () => {
    const sent = { ...op, cancelled: { hash: H(12), at: T0.getTime() + 4 * 60_000 } };
    // reverted (no receipt of a cancel that took it out, nothing pending), or dropped ten minutes on: offered again
    expect(depositRecord(sent, { ...base, cancelMined: false })).toMatchObject({ cancellableWei: 78_000_000_000_000_000n, cancelSeen: H(12) });
    expect(depositRecord(sent, { ...base, cancelPending: "unseen", now: new Date(T0.getTime() + 15 * 60_000) }).cancelSeen).toBe(H(12));
    // never cancelled from here: nothing seen
    expect(depositRecord(op, base)).not.toHaveProperty("cancelSeen");
    // cancelling, cancelled, or gone with its batch: no cancel is offered, so none is named
    expect(depositRecord(sent, { ...base, cancelPending: "waiting" })).not.toHaveProperty("cancelSeen");
    expect(depositRecord(sent, { ...base, cancelMined: true })).not.toHaveProperty("cancelSeen");
    expect(depositRecord(sent, { ...base, openBatchId: 4n, stillOpen: false })).not.toHaveProperty("cancelSeen");
  });

  it("this browser's own cancel laid over a record read before it (depositCancelSent) is the record a read of the chain gives once it catches up", () => {
    const at = T0.getTime() + 4 * 60_000;
    const sent = { ...op, cancelled: { hash: H(12), at } };
    // as the list last read it, before the cancel: waiting in its batch, its cancel offered, with v3.2's cooldown
    const cooled = { ...base, cancelableAt: 1_800_000_300, cancelClock: { chainTime: 1_800_000_100, readAt: 1_700_000_000_000 } };
    const stale = depositRecord(op, cooled);
    expect(stale.cancellableWei).toBe(78_000_000_000_000_000n);
    // on its way: "Cancelling…", its transaction, and nothing to cancel or to send
    const sending = depositCancelSent(stale, { state: "sending", hash: H(12), at });
    expect(sending).toEqual(depositRecord(sent, { ...cooled, cancelPending: "waiting" }));
    expect(sending.steps[2]).toMatchObject({ status: "active", detail: "Cancelling…" });
    expect(sending.steps[2].txUrl).toContain(H(12));
    for (const gone of ["cancellableWei", "cancelBatchId", "cancelableAt", "cancelClock", "cancelSeen"]) expect(sending, gone).not.toHaveProperty(gone);
    expect(sending.status).toBe("in_progress");
    // confirmed: cancelled, in the chain's own words
    const done = depositCancelSent(stale, { state: "done", hash: H(12), at });
    expect(done).toEqual(depositRecord(sent, { ...cooled, cancelMined: true }));
    expect(done.status).toBe("cancelled");
    expect(done.steps[2]).toMatchObject({ status: "failed", detail: DEPOSIT_CANCELLED, at: new Date(at) });
    expect(done.cancellableWei).toBeUndefined();
    // a record whose read saw an earlier cancel fail: that mark goes too
    expect(depositCancelSent(depositRecord({ ...op, cancelled: { hash: H(11), at: at - 1 } }, { ...base, cancelMined: false }), { state: "done", hash: H(12), at })).toEqual(
      depositRecord(sent, { ...base, cancelMined: true }),
    );
    // the record it was laid over is left as it was
    expect(stale.cancellableWei).toBe(78_000_000_000_000_000n);
    expect(stale.steps[2].status).toBe("active");
  });

  it("is on the bridge once the batch has closed, saying for how long and where to watch it", () => {
    const r = depositRecord(op, {
      ...base,
      openBatchId: 4n,
      stillOpen: false,
      depositedAt: new Date("2026-10-25T09:53:00Z"),
      watchUrl: "https://ccip.chain.link/address/0x221C",
    });
    expect(statuses(r)).toEqual(["done", "done", "active", "pending"]);
    expect(r.steps[2].detail).toMatch(/deposited 12 minutes ago/);
    expect(r.steps[2].detail).toMatch(/finalize/);
    expect(r.steps[2].txUrl).toBe("https://ccip.chain.link/address/0x221C");
    expect(r.cancellableWei).toBeUndefined();
  });

  it("is in the vault after delivery, then staked", () => {
    const delivered = { at: new Date("2026-10-25T10:35:00Z"), txHash: H(9), messageId: H(8), outcome: "deposited" as const };
    const arrived = depositRecord(op, { ...base, openBatchId: 4n, stillOpen: false, delivered });
    expect(statuses(arrived)).toEqual(["done", "done", "done", "active"]);
    expect(arrived.steps[2].txUrl).toContain(H(9));
    const staked = depositRecord(op, { ...base, openBatchId: 4n, stillOpen: false, delivered, staked: { at: new Date(), txHash: H(7) } });
    expect(statuses(staked)).toEqual(["done", "done", "done", "done"]);
    expect(staked.status).toBe("staked");
  });

  it("explains a vault still waiting for the 0.02-TAO minimum, with how much it holds and how much is missing", () => {
    const delivered = { at: new Date(), txHash: H(9), outcome: "deposited" as const };
    const r = depositRecord(op, {
      ...base,
      openBatchId: 4n,
      stillOpen: false,
      delivered,
      waitingForMinimum: true,
      vaultWei: 11_749_608n * 10n ** 9n,
      minimumWei: 2n * 10n ** 16n,
    });
    expect(r.steps[3].status).toBe("active");
    expect(r.steps[3].detail).toMatch(/0\.02 TAO/);
    expect(r.steps[3].detail).toMatch(/holds 0\.0117 TAO/);
    expect(r.steps[3].detail).toMatch(/0\.0083 TAO more/);
    expect(r.steps[3].detail).toMatch(/not earning/i);
    expect(r.steps[3].summary).toBe("waiting for the 0.02 TAO minimum");
  });

  it("says no more is needed when the user's own deposit on its way covers the minimum", () => {
    const delivered = { at: new Date(), txHash: H(9), outcome: "deposited" as const };
    const waiting = { ...base, openBatchId: 4n, stillOpen: false, delivered, waitingForMinimum: true, vaultWei: 11_749_608n * 10n ** 9n, minimumWei: 2n * 10n ** 16n };
    const covered = depositRecord(op, { ...waiting, incomingWei: 78_336_398n * 10n ** 9n });
    expect(covered.steps[3].detail).toMatch(/0\.0783 TAO deposit on its way/);
    expect(covered.steps[3].detail).toMatch(/nothing for you to do/i);
    expect(covered.steps[3].detail).not.toMatch(/more arrives/);
    const short = depositRecord(op, { ...waiting, incomingWei: 10n ** 15n });
    expect(short.steps[3].detail).toMatch(/with your 0\.0010 TAO deposit on its way, it is staked once 0\.0073 TAO more arrives/);
  });

  it("rounds what the vault holds down and what is missing up, and shows the live minimum as it is", () => {
    const delivered = { at: new Date(), txHash: H(9), outcome: "deposited" as const };
    const almost = depositRecord(op, {
      ...base,
      openBatchId: 4n,
      stillOpen: false,
      delivered,
      waitingForMinimum: true,
      vaultWei: 19_996n * 10n ** 12n,
      minimumWei: 2n * 10n ** 16n,
    });
    expect(almost.steps[3].detail).toMatch(/holds 0\.0199 TAO/);
    expect(almost.steps[3].detail).toMatch(/0\.0001 TAO more/);
    const odd = depositRecord(op, { ...base, openBatchId: 4n, stillOpen: false, delivered, waitingForMinimum: true, minimumWei: 25n * 10n ** 15n });
    expect(odd.steps[3].detail).toMatch(/the 0\.025 TAO minimum/);
    expect(odd.steps[3].summary).toBe("waiting for the 0.025 TAO minimum");
  });

  it("marks a bounced delivery as failed", () => {
    const r = depositRecord(op, { ...base, openBatchId: 4n, stillOpen: false, delivered: { at: new Date(), txHash: H(9), outcome: "bounced" } });
    expect(r.steps[2].status).toBe("failed");
    expect(r.status).toBe("failed");
  });

  it("asks the user to carry on when a step is waiting in the wallet", () => {
    const r = depositRecord({ ...op, hashes: { swap: H(1) }, batchId: undefined, state: "needs-you" }, { ...base, depositMined: false });
    expect(statuses(r)).toEqual(["done", "action", "pending", "pending"]);
    expect(r.status).toBe("needs_you");
  });

  it("shows a deposit found only on-chain without dollar figures", () => {
    const r = chainOnlyDeposit({ key: H(5), txHash: H(9), at: new Date(), assets: 10n ** 16n, staked: true });
    expect(r.amountUsd).toBeUndefined();
    expect(r.taoAmount).toBeCloseTo(0.01, 10);
    expect(r.status).toBe("staked");
  });
});

describe("v3 deposit trail (one stake through CascadeStaker)", () => {
  const op3: DepositOp = { ...op, v: 3, minTaoOut: 77_611_000_000_000_000n, hashes: { stake: H(5) } };

  it("marks the swap and the deposit done together from the one stake receipt, both linking to it", () => {
    const r = depositRecord(op3, { ...base, taoDeposited: 77_700_000_000_000_000n });
    expect(statuses(r)).toEqual(["done", "done", "active", "pending"]);
    expect(r.steps[0].txUrl).toContain(H(5));
    expect(r.steps[1].txUrl).toContain(H(5));
    // the TAO the front door recorded, which the cancel must ask for exactly
    expect(r.taoWei).toBe(77_700_000_000_000_000n);
    expect(r.cancellableWei).toBe(77_700_000_000_000_000n);
  });

  it("offers 'Stake again at today's price' for a stake that reverted, never a retry of the deposit alone", () => {
    const failed = { ...op3, state: "failed" as const, error: "The price moved before the stake went through, so no USDC left your wallet." };
    const r = depositRecord(failed, { ...base, swapMined: false, depositMined: false });
    expect(statuses(r)).toEqual(["failed", "pending", "pending", "pending"]);
    expect(r.steps[0].detail).toMatch(/price moved/);
    expect(r.status).toBe("failed");
    expect(r.restake).toBe(true);
    expect(r.retryable).toBeUndefined();
  });

  it("waits for the user after a declined signature, and can be removed since nothing was sent", () => {
    const stopped = { ...op3, hashes: {}, state: "needs-you" as const, error: "You declined the signature in your wallet." };
    const r = depositRecord(stopped, { ...base, swapMined: false, depositMined: false });
    expect(r.status).toBe("needs_you");
    expect(r.steps[0]).toMatchObject({ status: "action", detail: "You declined the signature in your wallet." });
    expect(r.nothingSent).toBe(true);
  });

  describe("a stopped stake a day on", () => {
    const stopped = { ...op3, hashes: {}, state: "needs-you" as const, error: "You declined the signature in your wallet." };
    const facts = { ...base, swapMined: false, depositMined: false };
    const dayOn = new Date(T0.getTime() + RESUME_WINDOW_MS);

    it("isn't carried on: it shows as a stake that didn't happen, says why, and offers a fresh stake at today's price", () => {
      const r = depositRecord(stopped, { ...facts, now: dayOn });
      expect(r.status).toBe("failed");
      expect(statuses(r)).toEqual(["failed", "pending", "pending", "pending"]);
      expect(r.steps[0].detail).toBe(STAKE_LAPSED);
      expect(STAKE_LAPSED).toBe("This stake stopped more than a day ago, so it isn't carried on. Stake again at today's price.");
      expect(r.restake).toBe(true);
      expect(r.retryable).toBeUndefined();
      // nothing was ever sent, so it can still be removed
      expect(r.nothingSent).toBe(true);
    });

    it("is still carried on a minute short of a day, and whatever its age once its stake was sent (that is only waited for)", () => {
      expect(depositRecord(stopped, { ...facts, now: new Date(dayOn.getTime() - 60_000) }).status).toBe("needs_you");
      const sent = { ...stopped, hashes: { stake: H(5) } };
      const r = depositRecord(sent, { ...facts, now: dayOn });
      expect(r.status).toBe("needs_you");
      expect(r.restake).toBeUndefined();
      const batched = { ...stopped, callsId: "batch-1" };
      expect(depositRecord(batched, { ...facts, now: dayOn }).status).toBe("needs_you");
    });

    it("applies to a v2 stake whose swap was never sent too, and never to a deposit of wallet TAO (nothing to quote)", () => {
      const v2 = { ...op, hashes: {}, state: "needs-you" as const };
      expect(depositRecord(v2, { ...facts, now: dayOn }).restake).toBe(true);
      // the swap was sent: carried on
      expect(depositRecord({ ...v2, hashes: { swap: H(1) } }, { ...facts, now: dayOn }).status).toBe("needs_you");
      const walletTao = { ...v2, usdcIn: 0n };
      expect(depositRecord(walletTao, { ...facts, now: dayOn }).status).toBe("needs_you");
    });
  });
});

const wop: WithdrawalOp = {
  id: "w1",
  kind: "withdrawal",
  account: ME,
  createdAt: T0.getTime(),
  shares: 10n ** 22n,
  taoEstimate: 10n ** 16n,
  usdcEstimate: 2_500_000n,
  fee: 10n ** 14n,
  hash: H(3),
  batchId: 5n,
  state: "sent",
};

const wbase: WithdrawalFacts = {
  requestMined: true,
  openBatchId: 5n,
  now: new Date("2026-10-25T10:05:00Z"),
  closesAt: new Date("2026-10-25T10:10:00Z"),
  stillOpen: true,
  claimable: 0n,
  payoutDelay: 3600,
};

describe("withdrawal trail with a max wait", () => {
  it("words the close time as an upper bound, with the day when it is not today", () => {
    const same = withdrawalRecord(wop, { ...wbase, closesBy: true });
    expect(same.steps[1].detail).toBe("Waits for the batch to close, by about 10:10 AM, then the bridge");
    const next = withdrawalRecord(wop, { ...wbase, closesBy: true, now: new Date(2026, 9, 25, 10, 5), closesAt: new Date(2026, 9, 26, 14, 5) });
    expect(next.steps[1].detail).toBe("Waits for the batch to close, by about 2:05 PM tomorrow, then the bridge");
    // without a max wait: the close time itself, as before
    expect(withdrawalRecord(wop, wbase).steps[1].detail).toBe("Waits for the batch to close at 10:10 AM, then the bridge");
    // past the time: it can close now, either way
    expect(withdrawalRecord(wop, { ...wbase, closesBy: true, now: new Date("2026-10-25T10:20:00Z") }).steps[1].detail).toMatch(/^The batch can close now/);
  });

  it("gives the day the launch's 24-hour safety wait ends on when it is not today", () => {
    const redeemed = { at: new Date(2026, 9, 25, 10, 35), txHash: H(9), outcome: "redeemed" as const, taoWei: 99n * 10n ** 14n };
    const facts = { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payoutDelay: 86_400, now: new Date(2026, 9, 25, 10, 40) };
    expect(withdrawalRecord(wop, facts).steps[2].detail).toBe("The 24-hour safety wait ends around 10:35 AM tomorrow, then it crosses back to Base (usually 20–30 minutes)");
    // the next morning it ends today: no day
    expect(withdrawalRecord(wop, { ...facts, now: new Date(2026, 9, 26, 8, 0) }).steps[2].detail).toBe(
      "The 24-hour safety wait ends around 10:35 AM, then it crosses back to Base (usually 20–30 minutes)",
    );
  });
});

describe("withdrawal trail", () => {
  it("goes from requested to unstaked to returning", () => {
    expect(statuses(withdrawalRecord(wop, wbase))).toEqual(["done", "active", "pending", "pending"]);
    const redeemed = { at: new Date("2026-10-25T10:35:00Z"), txHash: H(9), outcome: "redeemed" as const, taoWei: 99n * 10n ** 14n };
    const r = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed });
    expect(statuses(r)).toEqual(["done", "done", "active", "pending"]);
    expect(r.steps[2].detail).toMatch(/safety wait ends around 11:35 AM/);
    expect(r.steps[0].title).toBe("Request your unstake");
    expect(r.steps[0].detail).toBeUndefined();
    const flying = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout: { txHash: H(4), messageId: H(6), state: 1, at: new Date() } });
    expect(flying.steps[2].txUrl).toContain(H(6));
  });

  it("gives the unstake's bridge leg how long so far, an expected arrival and Chainlink's explorer", () => {
    const r = withdrawalRecord(wop, {
      ...wbase,
      openBatchId: 6n,
      stillOpen: false,
      now: new Date("2026-10-25T10:20:00Z"),
      requestedAt: new Date("2026-10-25T10:05:00Z"),
      sentAt: new Date("2026-10-25T10:12:00Z"),
      watchUrl: "https://ccip.chain.link/address/0x221C",
    });
    expect(r.steps[1].detail).toMatch(/requested 15 minutes ago/);
    expect(r.steps[1].detail).toMatch(/expected around 10:32 AM/);
    expect(r.steps[1].txUrl).toBe("https://ccip.chain.link/address/0x221C");
  });

  it("explains an unstake that took nothing, in plain words, offers to unstake again and promises no payout", () => {
    const at = new Date();
    const skipped = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: { at, txHash: H(9), outcome: "skipped" as const, taoWei: 0n } });
    expect(skipped.steps[1].detail).toBe("There was no stake to take when this request arrived, so nothing was taken.");
    expect(skipped.unstakeAgain).toBe(true);
    expect(skipped.usdcAmount).toBeUndefined();
    const limited = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: { at, txHash: H(9), outcome: "deferred" as const, taoWei: 0n } });
    expect(limited.steps[1].detail).toBe("The daily unstake limit was reached, so nothing was taken. You can unstake again tomorrow.");
    expect(limited.unstakeAgain).toBe(true);
  });

  it("v3.2: a deferred unstake says its own cause, told from the reads at its delivery's block (R4: the one-day hold and a closed rail)", () => {
    const at = new Date();
    const deferred = (defer?: "hold" | "rail" | "minimum" | "unread") =>
      withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: { at, txHash: H(9), outcome: "deferred" as const, taoWei: 0n, ...(defer ? { defer } : {}) } });
    expect(deferred("hold").steps[1].detail).toBe(HOLD_DEFERRED);
    expect(HOLD_DEFERRED).toBe("Nothing was taken: shares less than a day old can't be unstaked through Base yet. Unstake again once they are a day old.");
    expect(deferred("rail").steps[1].detail).toBe(RAIL_DEFERRED);
    expect(RAIL_DEFERRED).toBe("Nothing was taken: unstakes through Base were on hold. You can unstake again once they resume.");
    expect(deferred("minimum").steps[1].detail).toBe(MINIMUM_DEFERRED);
    expect(MINIMUM_DEFERRED).toBe("Nothing was taken: it was worth less than the 0.03 TAO minimum when it arrived. You can unstake again.");
    expect(deferred("unread").steps[1].detail).toBe(DEFERRED_UNREAD);
    expect(DEFERRED_UNREAD).toBe("Nothing was taken when this request arrived. You can unstake again.");
    // the day's limit (or the entry limit): today's sentence; every cause offers to unstake again
    expect(deferred().steps[1].detail).toBe("The daily unstake limit was reached, so nothing was taken. You can unstake again tomorrow.");
    for (const x of ["hold", "rail", "minimum", "unread", undefined] as const) {
      expect(deferred(x).unstakeAgain, String(x)).toBe(true);
      expect(deferred(x).steps[1].status).toBe("action");
    }
  });

  it("is ready to claim only once its own payout has reached Base, not whenever something is claimable", () => {
    const redeemed = { at: new Date(), txHash: H(9), outcome: "redeemed" as const, taoWei: 99n * 10n ** 14n };
    const waiting = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, claimable: 5n * 10n ** 15n });
    expect(waiting.status).toBe("in_progress");
    expect(waiting.steps[3].status).toBe("pending");
    const landed = withdrawalRecord(wop, {
      ...wbase,
      openBatchId: 6n,
      stillOpen: false,
      delivered: redeemed,
      claimable: 5n * 10n ** 15n,
      payout: { txHash: H(4), messageId: H(6), state: 2, at: new Date() },
    });
    expect(landed.status).toBe("ready");
    expect(landed.steps[3].status).toBe("action");
  });

  it("calls a payout the bridge hasn't delivered yet delayed, not a problem", () => {
    const redeemed = { at: new Date(), txHash: H(9), outcome: "redeemed" as const, taoWei: 99n * 10n ** 14n };
    const r = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout: { txHash: H(4), messageId: H(6), state: 3, at: new Date() } });
    expect(r.steps[2].status).toBe("active");
    expect(r.steps[2].detail).toMatch(/hasn't delivered this payout yet/);
    expect(r.status).toBe("in_progress");
  });

  it("says plainly when its payout was too small to send back, rather than on the bridge for ever", () => {
    const redeemed = { at: new Date(), txHash: H(9), outcome: "redeemed" as const, taoWei: 10n ** 12n };
    const r = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout: { txHash: H(4), state: 0, at: new Date(), dust: true } });
    expect(r.steps[2]).toMatchObject({ status: "failed", detail: "Too small to send back after the bridge fee, so nothing came back" });
    expect(r.steps[3].status).toBe("pending");
    expect(r.status).toBe("failed");
    expect(r.usdcAmount).toBeUndefined();
    expect(r.unstakeAgain).toBeUndefined();
    expect(withdrawalRecord({ ...wop, delivery: { minUsdcPerTao: 1n, deadline: 2_000_000_000 } }, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout: { txHash: H(4), state: 0, at: new Date(), dust: true } }).awaitingDelivery).toBeUndefined();
  });

  it("asks the user to claim once the TAO is back on Base, then shows it paid", () => {
    const redeemed = { at: new Date(), txHash: H(9), outcome: "redeemed" as const, taoWei: 99n * 10n ** 14n };
    const payout = { txHash: H(4), messageId: H(6), state: 2 as const, at: new Date() };
    const ready = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout, claimable: 99n * 10n ** 14n });
    expect(statuses(ready)).toEqual(["done", "done", "done", "action"]);
    expect(ready.status).toBe("ready");
    const claimed = { hash: H(11), at: new Date(), taoClaimed: 99n * 10n ** 14n, usdcOut: 2_450_000n, keptTao: false, swapFailed: false };
    const paid = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout, claimable: 0n, claimed });
    expect(paid.status).toBe("paid");
    expect(statuses(paid)).toEqual(["done", "done", "done", "done"]);
    expect(paid.received).toEqual({ usdc: 2.45 });
    const kept = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout, claimable: 0n, claimed: { ...claimed, usdcOut: undefined, keptTao: true } });
    expect(kept.received).toEqual({ keptTao: 0.0099 });
    expect(kept.steps[3].title).toMatch(/kept as TAO/i);
  });

  it("says when the claim went through but the swap back to USDC did not", () => {
    const redeemed = { at: new Date(), txHash: H(9), outcome: "redeemed" as const, taoWei: 99n * 10n ** 14n };
    const payout = { txHash: H(4), messageId: H(6), state: 2 as const, at: new Date() };
    const r = withdrawalRecord(wop, {
      ...wbase,
      openBatchId: 6n,
      stillOpen: false,
      delivered: redeemed,
      payout,
      claimable: 0n,
      claimed: { hash: H(11), at: new Date(), taoClaimed: 99n * 10n ** 14n, keptTao: false, swapFailed: true },
    });
    expect(r.status).toBe("needs_you");
    expect(r.steps[3]).toMatchObject({ status: "action" });
    expect(r.steps[3].detail).toMatch(/in your wallet/i);
  });

  it("shows a request taken back as cancelled, noting the fee is kept", () => {
    const r = withdrawalRecord({ ...wop, cancelled: { hash: H(13), at: T0.getTime() } }, { ...wbase, cancelMined: true });
    expect(r.status).toBe("cancelled");
    expect(r.cancellableShares).toBeUndefined();
    expect(r.steps[1].detail).toMatch(/fee/i);
  });

  it("says it is cancelling, and offers no second cancel, while Base hasn't settled the one sent", () => {
    const sent = { ...wop, cancelled: { hash: H(13), at: T0.getTime() + 4 * 60_000 } };
    const r = withdrawalRecord(sent, { ...wbase, cancelPending: "unseen" });
    expect(r.steps[1]).toMatchObject({ status: "active", detail: "Cancelling…" });
    expect(r.cancellableShares).toBeUndefined();
    expect(withdrawalRecord(sent, { ...wbase, cancelPending: "unseen", now: new Date(T0.getTime() + 15 * 60_000) }).cancellableShares).toBe(10n ** 22n);
    expect(withdrawalRecord(sent, { ...wbase, cancelPending: "waiting", now: new Date(T0.getTime() + 60 * 60_000) }).cancellableShares).toBeUndefined();
    // the batch closed: its real progress, not "Cancelling…"
    const closed = withdrawalRecord(sent, { ...wbase, openBatchId: 6n, stillOpen: false, cancelPending: "waiting" });
    expect(closed.steps[1].detail).toMatch(/^On the bridge to Bittensor/);
  });

  it("stays cancelled when its batch is delivered with another request of the account's", () => {
    const redeemed = { at: new Date(), txHash: H(9), outcome: "redeemed" as const, taoWei: 99n * 10n ** 14n };
    const payout = { txHash: H(4), messageId: H(6), state: 2 as const, at: new Date() };
    const r = withdrawalRecord(
      { ...wop, cancelled: { hash: H(13), at: T0.getTime() } },
      { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout, claimable: 99n * 10n ** 14n, cancelMined: true },
    );
    expect(r.status).toBe("cancelled");
    expect(statuses(r)).toEqual(["done", "failed", "pending", "pending"]);
    expect(r.steps[1].detail).toMatch(/Cancelled/);
    expect(r.taoAmount).toBe(0.01);
    expect(offersClaim(r)).toBe(false);
  });

  it("marks a skipped redeem as failed (a payout the bridge hasn't delivered is delayed, tested above)", () => {
    const skipped = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: { at: new Date(), txHash: H(9), outcome: "skipped" } });
    expect(skipped.steps[1].status).toBe("failed");
  });

  it("lets a request still in the open batch be cancelled", () => {
    expect(withdrawalRecord(wop, wbase).cancellableShares).toBe(10n ** 22n);
  });

  it("a request that offers its cancel again names the cancel its read saw fail (cancelSeen), and only then", () => {
    const sent = { ...wop, cancelled: { hash: H(13), at: T0.getTime() + 4 * 60_000 } };
    expect(withdrawalRecord(sent, { ...wbase, cancelMined: false })).toMatchObject({ cancellableShares: 10n ** 22n, cancelSeen: H(13) });
    expect(withdrawalRecord(sent, { ...wbase, cancelPending: "unseen", now: new Date(T0.getTime() + 15 * 60_000) }).cancelSeen).toBe(H(13));
    expect(withdrawalRecord(wop, wbase)).not.toHaveProperty("cancelSeen");
    expect(withdrawalRecord(sent, { ...wbase, cancelPending: "waiting" })).not.toHaveProperty("cancelSeen");
    expect(withdrawalRecord(sent, { ...wbase, cancelMined: true })).not.toHaveProperty("cancelSeen");
  });

  it("this browser's own cancel laid over a request read before it (withdrawalCancelSent) is the record a read of the chain gives once it catches up", () => {
    const at = T0.getTime() + 4 * 60_000;
    const sent = { ...wop, cancelled: { hash: H(13), at } };
    const stale = withdrawalRecord(wop, wbase);
    const sending = withdrawalCancelSent(stale, { state: "sending", hash: H(13), at });
    expect(sending).toEqual(withdrawalRecord(sent, { ...wbase, cancelPending: "waiting" }));
    expect(sending.steps[1]).toMatchObject({ status: "active", detail: "Cancelling…" });
    expect(sending).not.toHaveProperty("cancellableShares");
    const done = withdrawalCancelSent(stale, { state: "done", hash: H(13), at });
    expect(done).toEqual(withdrawalRecord(sent, { ...wbase, cancelMined: true }));
    expect(done.status).toBe("cancelled");
    expect(done.steps[1]).toMatchObject({ status: "failed", detail: UNSTAKE_CANCELLED });
    expect(UNSTAKE_CANCELLED).toBe("Cancelled before the batch closed. Your shares stay staked; the request fee isn't refunded");
    expect(done).not.toHaveProperty("cancellableShares");
    expect(stale.cancellableShares).toBe(10n ** 22n);
    // a v3 request with USDC delivery asked for, and v3.2's asked as TAO: the same, and a cancelled one awaits no delivery
    const asked: WithdrawalOp[] = [
      { ...wop, delivery: { minUsdcPerTao: 245_000_000n, deadline: Math.floor(T0.getTime() / 1000) + 604_800 } },
      { ...wop, keepTao: true },
    ];
    for (const o of asked) {
      const before = withdrawalRecord(o, wbase);
      const cancelled = { ...o, cancelled: { hash: H(13), at } };
      expect(withdrawalCancelSent(before, { state: "sending", hash: H(13), at }), JSON.stringify(Object.keys(o))).toEqual(withdrawalRecord(cancelled, { ...wbase, cancelPending: "waiting" }));
      const over = withdrawalCancelSent(before, { state: "done", hash: H(13), at });
      expect(over, JSON.stringify(Object.keys(o))).toEqual(withdrawalRecord(cancelled, { ...wbase, cancelMined: true }));
      expect(over).not.toHaveProperty("awaitingDelivery");
    }
  });
});

describe("v3 withdrawal trail (USDC delivered to the wallet automatically)", () => {
  const DEADLINE = Math.floor(T0.getTime() / 1000) + 604_800;
  const asked = { minUsdcPerTao: 245_000_000n, deadline: DEADLINE };
  const wop3: WithdrawalOp = { ...wop, delivery: asked };
  const CREDIT = 99n * 10n ** 14n;
  const redeemed = { at: new Date("2026-10-25T10:35:00Z"), txHash: H(9), outcome: "redeemed" as const, taoWei: CREDIT };
  const payout = { txHash: H(4), messageId: H(6), state: 2 as const, at: new Date("2026-10-25T11:40:00Z") };
  // back on Base 25 minutes ago, nothing has taken it yet: 0.0099 TAO waits in the front door
  const back: WithdrawalFacts = {
    ...wbase,
    openBatchId: 6n,
    stillOpen: false,
    delivered: redeemed,
    payout,
    now: new Date("2026-10-25T12:10:00Z"),
    claimable: CREDIT,
    credited: { at: new Date("2026-10-25T11:45:00Z"), taoWei: CREDIT },
    preference: asked,
  };
  const receipt = { hash: H(30), at: new Date("2026-10-25T11:50:00Z"), usdcOut: 2_431_337n };
  const claimed = { hash: H(11), at: new Date(), taoClaimed: CREDIT, usdcOut: 2_450_000n, keptTao: false, swapFailed: false };

  it("waits for its payout to reach Base before anything can be delivered", () => {
    const r = withdrawalRecord(wop3, { ...back, payout: { ...payout, state: 1 }, credited: undefined });
    expect(statuses(r)).toEqual(["done", "done", "active", "pending"]);
    expect(r.status).toBe("in_progress");
    expect(offersClaim(r)).toBe(false);
  });

  it("shows 'USDC delivered' with the amount from the Delivered log and a link to its receipt", () => {
    const r = withdrawalRecord(wop3, { ...back, claimable: 0n, usdcDelivered: receipt });
    expect(statuses(r)).toEqual(["done", "done", "done", "done"]);
    expect(r.steps[3]).toMatchObject({ title: "USDC delivered", status: "done", at: receipt.at });
    expect(r.steps[3].txUrl).toContain(H(30));
    expect(r.status).toBe("paid");
    expect(r.received).toEqual({ usdc: 2.431337 });
    // what arrived, not the estimate
    expect(r.usdcAmount).toBe(2.431337);
  });

  it("finds the delivery even when a later payout is waiting on Base", () => {
    const r = withdrawalRecord(wop3, { ...back, claimable: 5n * 10n ** 15n, usdcDelivered: receipt });
    expect(r.status).toBe("paid");
    expect(r.steps[3].status).toBe("done");
  });

  it("shows one delivery that sold two payouts together without a per-unstake amount: its receipt and the total", () => {
    const r = withdrawalRecord(wop3, { ...back, claimable: 0n, usdcDelivered: { ...receipt, usdcOut: 4_862_674n, shared: true } });
    expect(r.status).toBe("paid");
    expect(r.steps[3]).toMatchObject({ title: "USDC delivered", status: "done", detail: "Delivered together with your other payout: 4.86 USDC in all" });
    expect(r.steps[3].txUrl).toContain(H(30));
    expect(r.received).toBeUndefined();
    expect(r.usdcAmount).toBeUndefined();
  });

  it("says USDC is on its way automatically while the delivery preference is live", () => {
    const r = withdrawalRecord(wop3, back);
    expect(statuses(r)).toEqual(["done", "done", "done", "active"]);
    expect(r.steps[3].detail).toBe("USDC is being delivered to your wallet automatically");
    expect(r.status).toBe("in_progress");
    expect(offersClaim(r)).toBe(false);
    expect(r.received).toBeUndefined();
    // the preference couldn't be read: the one this unstake asked for stands in
    expect(withdrawalRecord(wop3, { ...back, preference: undefined }).steps[3].status).toBe("active");
  });

  it("marks an unstake still on its way back with automatic delivery ahead, which a claim by hand would turn off", () => {
    // in the open batch, on the bridge, in the safety wait, on the way back to Base
    expect(withdrawalRecord(wop3, wbase).awaitingDelivery).toBe(true);
    expect(withdrawalRecord(wop3, { ...back, payout: undefined, credited: undefined, claimable: 0n, preference: undefined }).awaitingDelivery).toBe(true);
    expect(withdrawalRecord(wop3, { ...back, payout: { ...payout, state: 1 }, credited: undefined, preference: undefined }).awaitingDelivery).toBe(true);
    // landed (being delivered, or offering the claim), paid, or never going to be delivered: not
    expect(withdrawalRecord(wop3, back).awaitingDelivery).toBeUndefined();
    expect(withdrawalRecord(wop3, { ...back, claimable: 0n, usdcDelivered: receipt }).awaitingDelivery).toBeUndefined();
    expect(withdrawalRecord(wop3, { ...wbase, now: new Date((DEADLINE + 1) * 1000) }).awaitingDelivery).toBeUndefined();
    expect(withdrawalRecord(wop3, { ...wbase, requestMined: false }).awaitingDelivery).toBeUndefined();
    expect(withdrawalRecord({ ...wop3, cancelled: { hash: H(12), at: T0.getTime() } }, { ...wbase, cancelMined: true }).awaitingDelivery).toBeUndefined();
    expect(
      withdrawalRecord(wop3, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: { ...redeemed, outcome: "skipped" as const, taoWei: 0n } }).awaitingDelivery,
    ).toBeUndefined();
    // v2 delivers nothing automatically
    expect(withdrawalRecord(wop, wbase).awaitingDelivery).toBeUndefined();
  });

  it("tells the screens when an unstake's USDC is on its way by itself", () => {
    expect(isDelivering(withdrawalRecord(wop3, back))).toBe(true);
    // taking longer than usual: the claim is offered, so it no longer counts as delivering
    expect(isDelivering(withdrawalRecord(wop3, { ...back, now: new Date("2026-10-25T12:46:00Z") }))).toBe(false);
    expect(isDelivering(withdrawalRecord(wop3, { ...back, preference: null }))).toBe(false);
    expect(isDelivering(withdrawalRecord(wop3, { ...back, payout: { ...payout, state: 1 }, credited: undefined }))).toBe(false);
    expect(isDelivering(withdrawalRecord(wop3, { ...back, claimable: 0n, usdcDelivered: receipt }))).toBe(false);
  });

  it("offers the claim as well once delivery is taking longer than usual: an hour after the payout landed", () => {
    const slow = withdrawalRecord(wop3, { ...back, now: new Date("2026-10-25T12:46:00Z") });
    expect(slow.steps[3]).toMatchObject({ title: "USDC to your wallet", status: "action" });
    expect(slow.steps[3].detail).toBe(
      "USDC is being delivered to your wallet automatically. It's taking longer than usual. You can keep waiting, or claim it as USDC now.",
    );
    expect(slow.status).toBe("ready");
    expect(offersClaim(slow)).toBe(true);
    expect(offersClaim(withdrawalRecord(wop3, { ...back, now: new Date("2026-10-25T12:44:00Z") }))).toBe(false);
    // when it landed isn't known: the payout left Bittensor at 11:40, plus 30 minutes on the bridge, plus the hour
    const unknown = { ...back, credited: undefined, traceFailed: true as const };
    expect(offersClaim(withdrawalRecord(wop3, { ...unknown, now: new Date("2026-10-25T13:09:00Z") }))).toBe(false);
    expect(offersClaim(withdrawalRecord(wop3, { ...unknown, now: new Date("2026-10-25T13:11:00Z") }))).toBe(true);
  });

  it("offers 'Claim as USDC' once the preference has expired, or when there is none", () => {
    const expired = withdrawalRecord(wop3, { ...back, preference: { ...asked, deadline: Math.floor(back.now.getTime() / 1000) - 1 } });
    expect(expired.steps[3]).toMatchObject({ title: "Claim as USDC", status: "action" });
    expect(expired.status).toBe("ready");
    expect(offersClaim(expired)).toBe(true);
    const none = withdrawalRecord(wop3, { ...back, preference: null });
    expect(none.steps[3]).toMatchObject({ title: "Claim as USDC", status: "action", detail: "Your money is back on Base. Claim it as USDC" });
    expect(none.status).toBe("ready");
  });

  it("offers 'Claim as USDC' when today's price is under the minimum, since it can't be delivered at that price", () => {
    // the floor on 0.0099 TAO at 245 USDC per TAO is 2.4255 USDC
    const under = withdrawalRecord(wop3, { ...back, saleNowUsdc: 2_400_000n });
    expect(under.steps[3]).toMatchObject({ title: "Claim as USDC", status: "action" });
    expect(under.steps[3].detail).toMatch(/below your minimum/);
    expect(under.status).toBe("ready");
    const over = withdrawalRecord(wop3, { ...back, saleNowUsdc: 2_425_500n });
    expect(over.steps[3].status).toBe("active");
  });

  it("while the price is under the minimum, gives what the payout would sell for today, not the estimate from the request", () => {
    const under = withdrawalRecord(wop3, { ...back, saleNowUsdc: 2_400_000n });
    expect(under.belowMinimum).toEqual({ usdcNow: 2.4 });
    // two payouts waiting, sold together: this one's share of the sale
    const two = withdrawalRecord(wop3, { ...back, claimable: 2n * CREDIT, saleNowUsdc: 4_800_000n });
    expect(two.steps[3].detail).toMatch(/below your minimum/);
    expect(two.belowMinimum).toEqual({ usdcNow: 2.4 });
    // what this payout was credited can't be read: no figure rather than one that may be shared
    const unknown = withdrawalRecord(wop3, { ...back, credited: undefined, traceFailed: true, saleNowUsdc: 2_400_000n });
    expect(unknown.steps[3].detail).toMatch(/below your minimum/);
    expect(unknown.belowMinimum).toEqual({});
    // at or over the minimum, and on v2, there is no such state
    expect(withdrawalRecord(wop3, { ...back, saleNowUsdc: 2_425_500n }).belowMinimum).toBeUndefined();
    expect(withdrawalRecord(wop3, back).belowMinimum).toBeUndefined();
    expect(withdrawalRecord(wop, { ...back, saleNowUsdc: 2_400_000n }).belowMinimum).toBeUndefined();
  });

  it("stays 'Claim as USDC' in progress while a claim from this browser settles, whatever is claimable", () => {
    for (const claimable of [0n, CREDIT]) {
      const r = withdrawalRecord(wop3, { ...back, claimable, preference: null, claimPending: true });
      expect(r.steps[3]).toMatchObject({ title: "Claim as USDC", status: "active" });
      expect(r.status).toBe("in_progress");
      expect(offersClaim(r)).toBe(false);
    }
  });

  it("shows no amount when the logs can't be read, with the status still right: nothing claimable and no claim made", () => {
    const r = withdrawalRecord(wop3, { ...back, claimable: 0n, traceFailed: true });
    expect(r.steps[3]).toMatchObject({ title: "Paid out", status: "done" });
    expect(r.steps[3].txUrl).toBeUndefined();
    expect(r.status).toBe("paid");
    expect(r.received).toBeUndefined();
    expect(r.usdcAmount).toBeUndefined();
  });

  it("doesn't call it paid when the logs were read and show nothing taking it, or no credit for this account", () => {
    // credited, and nothing after it: the empty balance is an older read, not a payment
    const untaken = withdrawalRecord(wop3, { ...back, claimable: 0n });
    expect(untaken.status).toBe("in_progress");
    expect(untaken.steps[3].status).toBe("active");
    // nothing credited to this account at all (too small to send after the bridge fee, say)
    const none = withdrawalRecord(wop3, { ...back, claimable: 0n, credited: undefined });
    expect(none.status).toBe("in_progress");
    expect(none.steps[3].title).not.toBe("Paid out");
  });

  it("shows a claim by hand from this browser as today when it took exactly this payout", () => {
    const here = withdrawalRecord(wop3, { ...back, claimable: 0n, claimed });
    expect(here.status).toBe("paid");
    expect(here.steps[3]).toMatchObject({ title: "Claim as USDC", status: "done" });
    expect(here.received).toEqual({ usdc: 2.45 });
  });

  it("shows one hand claim that took two payouts without a per-unstake amount", () => {
    const both = withdrawalRecord(wop3, { ...back, claimable: 0n, claimed: { ...claimed, taoClaimed: 2n * CREDIT, usdcOut: 4_900_000n } });
    expect(both.status).toBe("paid");
    expect(both.steps[3]).toMatchObject({ status: "done", detail: "Claimed together with your other payout: 4.90 USDC in all" });
    expect(both.received).toBeUndefined();
    expect(both.usdcAmount).toBeUndefined();
    // what this payout was credited isn't known yet: no amount rather than one that may be shared
    const unknown = withdrawalRecord(wop3, { ...back, claimable: 0n, credited: undefined, traceFailed: true, claimed });
    expect(unknown.status).toBe("paid");
    expect(unknown.received).toBeUndefined();
  });

  it("shows a claim made elsewhere without an amount, and says when it took other payouts too", () => {
    const elsewhere = withdrawalRecord(wop3, { ...back, claimable: 0n, claimedOnChain: { hash: H(31), at: new Date(), taoClaimed: CREDIT } });
    expect(elsewhere.status).toBe("paid");
    expect(elsewhere.steps[3].txUrl).toContain(H(31));
    expect(elsewhere.received).toBeUndefined();
    expect(elsewhere.usdcAmount).toBeUndefined();
    const both = withdrawalRecord(wop3, { ...back, claimable: 0n, claimedOnChain: { hash: H(31), at: new Date(), taoClaimed: 2n * CREDIT, shared: true } });
    expect(both.steps[3].detail).toBe("Claimed together with your other payout: 0.0198 TAO in all");
  });

  it("v2: shows one claim that paid out several unstakes without a per-unstake amount, and its total once", () => {
    const shared = withdrawalRecord(wop, { ...back, claimable: 0n, credited: undefined, claimed: { ...claimed, taoClaimed: 2n * CREDIT, usdcOut: 4_900_000n, shared: true } });
    expect(shared.status).toBe("paid");
    expect(shared.steps[3]).toMatchObject({ status: "done", detail: "Claimed together with your other payout: 4.90 USDC in all" });
    expect(shared.received).toBeUndefined();
    // the claim named this unstake alone: its amount is this one's
    const own = withdrawalRecord(wop, { ...back, claimable: 0n, credited: undefined, claimed });
    expect(own.received).toEqual({ usdc: 2.45 });
    expect(own.steps[3].detail).toBeUndefined();
  });

  it("leaves a v2 unstake as it was, whatever the delivery facts say", () => {
    const r = withdrawalRecord(wop, { ...back, saleNowUsdc: 9_999_999n, now: new Date("2026-10-26T12:00:00Z") });
    expect(r.steps[3]).toMatchObject({ title: "Claim as USDC", status: "action", detail: "Your money is back on Base. Claim it as USDC" });
    expect(r.status).toBe("ready");
    expect(offersClaim(r)).toBe(true);
    expect(r.usdcAmount).toBe(2.5);
    const paid = withdrawalRecord(wop, { ...back, claimable: 0n, claimed: { ...claimed, taoClaimed: 2n * CREDIT } });
    expect(paid.received).toEqual({ usdc: 2.45 });
  });
});


// ---- v3.2: the trail's new states, each from fixture logs of v3.2's own events (decoded with v3.2's ABIs), the copy exact ----

describe("v3.2's trail, from its own events", () => {
  const deposit = async (c: unknown, x: Pick<Crossed, "stakeOp">, d = V32, s = scanned(d)) => {
    const { facts } = await depositFacts(c as never, d, x.stakeOp, { fd, vault, scan: s });
    return depositRecord(x.stakeOp, facts);
  };
  const withdrawal = async (c: unknown, x: Pick<Crossed, "requestOp">, v = vault, d = V32, s = scanned(d)) => {
    const { facts } = await withdrawalFacts(c as never, d, x.requestOp, { fd, vault: v, scan: s, claims: [] });
    return withdrawalRecord(x.requestOp, facts);
  };

  it("parkedDeposit: a batch the vault refused waits in the Bittensor adapter, said in plain words", async () => {
    const x = crossed(3 * 3_600);
    const c = chains({ ...x.base, ...parkedRun(x), parks: { [PARK_KEY]: [TAO, BigInt(x.parkS), true] } });
    const r = await deposit(c, x);
    expect(r.steps[2]).toMatchObject({
      key: "bridge",
      status: "active",
      summary: "waiting to be added",
      detail: "Your deposit reached Bittensor and is waiting to be added. Nothing is lost: it is added, or returned to you, automatically.",
    });
    expect(r.steps[3].status).toBe("pending");
    expect(r.status).toBe("in_progress");
    // a park two weeks old the keeper hasn't sent back yet: still parked, as its record shows
    const old = crossed(15 * DAY);
    const still = await deposit(chains({ ...old.base, ...parkedRun(old), parks: { [PARK_KEY]: [TAO, BigInt(old.parkS), true] } }), old);
    expect(still.steps[2].detail).toBe("Your deposit reached Bittensor and is waiting to be added. Nothing is lost: it is added, or returned to you, automatically.");
    // v3-launch's trail reads none of it: its batch is on the bridge, as before
    const launch = await deposit(c, x, LAUNCH);
    expect(launch.steps[2].status).toBe("active");
    expect(launch.steps[2].detail).toMatch(/^On the bridge to Bittensor/);
  });

  it("refundedDeposit: a park sent back to Base after its 14 days is returned, not withdrawn", async () => {
    const x = crossed(16 * DAY);
    const refundBlock = bitAt(x.parkS + 14 * DAY + 3_600);
    const landBlock = baseAt(bitTs(refundBlock) + 25 * 60);
    const run = parkedRun(x);
    const bitLogs = [...run.bitLogs, parkedRefunded(refundBlock)];
    // the refund left Bittensor and hasn't reached Base yet
    const going = await deposit(chains({ ...x.base, ...run, bitLogs }), x);
    expect(going.steps[2]).toMatchObject({ status: "failed", detail: "Your deposit is on its way back to Base." });
    // the refund payout (REFUND_CHUNK, under the park's key) credited the account on Base; the claim is on the Stake
    // page (the controller's wording, Task 59 review Important 1: the site has no Withdraw page)
    const landed = payoutReceived(PARK_KEY, REFUND_CHUNK, USER, TAO, landBlock, LAND_TX);
    const back = await deposit(chains({ ...x.base, ...run, bitLogs, baseLogs: [...x.base.baseLogs, landed] }), x);
    expect(back.steps[2]).toMatchObject({ status: "failed", detail: "Your deposit was returned to you on Base. Claim it on the Stake page." });
    expect(back.steps[3].status).toBe("pending");
    expect(back.status).toBe("failed");
    // another depositor's refund from the same park isn't this account's
    const theirs = payoutReceived(PARK_KEY, REFUND_CHUNK, OTHER, TAO, landBlock, LAND_TX);
    const notMine = await deposit(chains({ ...x.base, ...run, bitLogs, baseLogs: [...x.base.baseLogs, theirs] }), x);
    expect(notMine.steps[2].detail).toBe("Your deposit is on its way back to Base.");
  });

  it("refundedDeposit at Bittensor's measured block time: on 6-second blocks its run and its refund are found where their times put them", async () => {
    BIT_CLOCK.blockS = 6;
    try {
      const x = crossed(16 * DAY);
      const refundBlock = bitAt(x.parkS + 14 * DAY + 3_600);
      const landBlock = baseAt(bitTs(refundBlock) + 25 * 60);
      const run = parkedRun(x);
      const landed = payoutReceived(PARK_KEY, REFUND_CHUNK, USER, TAO, landBlock, LAND_TX);
      const c = chains({ ...x.base, ...run, bitLogs: [...run.bitLogs, parkedRefunded(refundBlock)], baseLogs: [...x.base.baseLogs, landed] });
      const back = await deposit(c, x);
      expect(back.steps[2]).toMatchObject({ status: "failed", detail: "Your deposit was returned to you on Base. Claim it on the Stake page." });
      // the park's end looked for from its timeout by the head's clock at 6 s a block: a window or two, not dozens
      const endWindows = c.asked.filter((k) => k.startsWith("bittensor.logs:") && BigInt(k.split(":")[1].split("-")[0]) > x.execBlock);
      expect(endWindows.length).toBeLessThanOrEqual(2);
    } finally {
      BIT_CLOCK.blockS = 12;
    }
  });

  it("parkEndAfterAHalt: a park whose 14 days took fewer than 80,640 blocks (a halt) is still found refunded, from the head's clock", async () => {
    // a four-day halt after the park: its 14 days span 72,100 blocks, under 80,640 (14 days at 15 s)
    const halt = { before: BIT_HEAD - 1_950n, seconds: 4 * DAY };
    const parkBlock = BIT_HEAD - 74_000n;
    const refundBlock = parkBlock + 72_100n;
    const parkS = bitTs(parkBlock, halt);
    expect(bitTs(refundBlock, halt) - parkS).toBeGreaterThanOrEqual(14 * DAY);
    expect(refundBlock - parkBlock).toBeLessThan(80_640n);
    // the stake 55 minutes before the park, its batch's close half an hour after it
    const x = crossed(NOW_S - parkS + 55 * 60);
    const run = parkedRun({ execBlock: parkBlock });
    const landBlock = baseAt(bitTs(refundBlock, halt) + 25 * 60);
    const c = chains({
      ...x.base,
      ...run,
      halt,
      bitLogs: [...run.bitLogs, parkedRefunded(refundBlock)],
      baseLogs: [...x.base.baseLogs, payoutReceived(PARK_KEY, REFUND_CHUNK, USER, TAO, landBlock, LAND_TX)],
    });
    const r = await deposit(c, x);
    expect(r.steps[2]).toMatchObject({ status: "failed", detail: "Your deposit was returned to you on Base. Claim it on the Stake page." });
    // the search for the park's end started near the timeout by the head's clock: one window, not dozens
    const endWindows = c.asked.filter((k) => k.startsWith("bittensor.logs:") && BigInt(k.split(":")[1].split("-")[0]) > parkBlock);
    expect(endWindows.length).toBeLessThanOrEqual(2);
  });

  it("foreignOriginBounce: a deposit for an address that belongs to another chain's Cascade comes back, said so", async () => {
    const x = crossed(3 * 3_600);
    // the batch's delivery, as the vault's scan read it (each read its own scan: a scan keeps the receipts it read)
    const s = () => {
      const scan = scanned(V32);
      scan.delivered.set(String(BATCH), { key: VKEY, txHash: EXEC_TX, block: x.execBlock });
      return scan;
    };
    const run = (reason: number) => ({ bitReceipts: { [EXEC_TX]: receipt([vaultDelivered(x.execBlock), depositBounced(x.execBlock, reason)]) } });
    const r = await deposit(chains({ ...x.base, ...run(1) }), x, V32, s());
    expect(r.steps[2]).toMatchObject({ status: "failed", detail: "This address already belongs to another chain's Cascade; your deposit is on its way back." });
    expect(r.status).toBe("failed");
    // a bounce for any other reason keeps its words
    const insolvent = await deposit(chains({ ...x.base, ...run(0) }), x, V32, s());
    expect(insolvent.steps[2].detail).toBe("The vault couldn't accept this deposit safely just then, so it sent it back. It returns to Base, where you can claim it as USDC from the Stake page");
  });

  it("checking: a batch that crossed but whose outcome, delivered or parked, isn't read yet says so, never a guess", async () => {
    const x = crossed(3 * 3_600);
    const checking = { status: "checking", detail: "Your deposit has left Base. Loading its latest status on the way to Bittensor…" };
    // the bridge ran it on Bittensor, but nothing read yet shows where it went
    expect((await deposit(chains({ ...x.base, executed: { [MSG]: 2 } }), x)).steps[2]).toMatchObject(checking);
    // its run delivered it to the vault, whose scan hasn't reached that block yet
    const delivered = chains({
      ...x.base,
      executed: { [MSG]: 2 },
      bitLogs: [adapterDelivered(x.execBlock)],
      bitReceipts: { [EXEC_TX]: receipt([vaultDelivered(x.execBlock), adapterDelivered(x.execBlock)]) },
    });
    expect((await deposit(delivered, x)).steps[2]).toMatchObject(checking);
    // Bittensor can't be asked
    expect((await deposit(chains({ ...x.base, ...parkedRun(x), bittensorDown: true }), x)).steps[2]).toMatchObject(checking);
    // Base's logs show no close for the batch yet (a logs server that is behind)
    expect((await deposit(chains({ ...x.base, baseLogs: [], executed: { [MSG]: 2 } }), x)).steps[2]).toMatchObject(checking);
    // the bridge's run failed on Bittensor (CCIP FAILURE: re-executable, not lost): checking, never "any minute" (review Minor 5)
    const failed = await deposit(chains({ ...x.base, executed: { [MSG]: 3 } }), x);
    expect(failed.steps[2]).toMatchObject(checking);
    expect(failed.steps[2].detail).not.toMatch(/any minute/);
    // not run on Bittensor yet: on the bridge, timed from when it left Base
    const bridge = await deposit(chains({ ...x.base }), x);
    expect(bridge.steps[2].status).toBe("active");
    expect(bridge.steps[2].detail).toMatch(
      /^On the bridge to Bittensor \(deposited 180 minutes ago\)\. Chainlink waits for Base to finalize the batch \(about 15–25 minutes\), then delivers it on Bittensor; Chainlink's estimate was /,
    );
  });

  it("parkedWithdrawalRequest: a request in a parked batch is pending, and once the park is dropped it can be made again", async () => {
    // an unstake alone: its batch carries no TAO, so its park is empty
    const x = crossed(3 * 3_600);
    const pending = await withdrawal(chains({ ...x.base, ...parkedRun(x, 0n), parks: { [PARK_KEY]: [0n, BigInt(x.parkS), true] } }), x);
    expect(pending.steps[1]).toMatchObject({ key: "unstake", status: "active", detail: "Still pending; do not request again until it shows dropped." });
    expect(pending.status).toBe("in_progress");
    expect(pending.unstakeAgain).toBeUndefined();
    // 14 days on, the empty park is dropped
    const old = crossed(16 * DAY);
    const dropBlock = bitAt(old.parkS + 14 * DAY + 3_600);
    const run = parkedRun(old, 0n);
    const dropped = await withdrawal(chains({ ...old.base, ...run, bitLogs: [...run.bitLogs, parkedDropped(dropBlock)] }), old);
    expect(dropped.steps[1]).toMatchObject({ status: "failed", detail: "This request was dropped and nothing was taken. You can request again." });
    expect(dropped.status).toBe("failed");
    expect(dropped.unstakeAgain).toBe(true);
    expect(dropped.usdcAmount).toBeUndefined();
    // a batch with deposits in it was refunded instead: its requests went with it
    const withDeposits = parkedRun(old);
    const refunded = await withdrawal(chains({ ...old.base, ...withDeposits, bitLogs: [...withDeposits.bitLogs, parkedRefunded(dropBlock)] }), old);
    expect(refunded.steps[1].detail).toBe("This request was dropped and nothing was taken. You can request again.");
    // v3-launch's trail reads none of it
    expect((await withdrawal(chains({ ...x.base, ...parkedRun(x, 0n) }), x, vault, LAUNCH)).steps[1].detail).toMatch(/^On the bridge to Bittensor/);
  });

  it("originElsewhere: a request skipped because the address withdrew on Bittensor at the time says why, and what to do", async () => {
    const x = crossed(3 * 3_600);
    const s = () => {
      const scan = scanned(V32);
      scan.delivered.set(String(BATCH), { key: VKEY, txHash: EXEC_TX, block: x.execBlock });
      return scan;
    };
    const skipped = (originAt: bigint | "fail") =>
      chains({ ...x.base, originAt, bitReceipts: { [EXEC_TX]: receipt([vaultDelivered(x.execBlock), redeemSkipped(x.execBlock)]) } });
    // the origin at the skip (read at the delivery's block) was DIRECT_ORIGIN, though the address has set Base since
    const c = skipped(DIRECT);
    const direct = await withdrawal(c, x, { ...vault, redeemOrigin: 8453n }, V32, s());
    expect(direct.steps[1]).toMatchObject({
      status: "failed",
      detail: "Nothing was taken. This address withdraws on Bittensor, not here. Withdraw there, or set Base as its withdrawal chain from Bittensor.",
    });
    expect(direct.unstakeAgain).toBe(true);
    expect(c.asked).toContain(`bittensor.redeemOrigin@${x.execBlock}`);
    // Base's at the skip, today elsewhere: it was skipped for having no stake, whatever the origin reads now
    const none = await withdrawal(skipped(8453n), x, { ...vault, redeemOrigin: DIRECT }, V32, s());
    expect(none.steps[1].detail).toBe("There was no stake to take when this request arrived, so nothing was taken.");
    // the origin at the skip can't be read: only what is true either way
    const unread = await withdrawal(skipped("fail"), x, vault, V32, s());
    expect(unread.steps[1]).toMatchObject({ status: "failed", detail: "This request was skipped, and nothing was taken." });
    expect(unread.unstakeAgain).toBe(true);
  });

  it("thinPool: a payout back on Base waits for the market while a pool is thinner than its floor, and the claim is offered", async () => {
    const x = crossed(3 * 3_600);
    const chunkBlock = x.execBlock + 400n;
    const landBlock = baseAt(bitTs(chunkBlock) + 25 * 60);
    const deadline = BigInt(NOW_S + 7 * DAY);
    const op: WithdrawalOp = { ...x.requestOp, delivery: { minUsdcPerTao: 200_000_000n, deadline: Number(deadline) } };
    const chunk = event(
      V32.vault,
      VAULT_V32,
      "PayoutChunkSent",
      { key: VKEY },
      enc("uint32, uint32, uint256, uint256, uint256, uint256, uint256", [0, 1, TAO, TAO - 10n ** 14n, 10n ** 14n, 10n ** 14n, 0n]),
      chunkBlock,
      CHUNK_TX,
    );
    const sent = event(V32.bitAdapter, ADAPTER, "Sent", { messageId: H(0x53), sender: V32.vault, recipient: V32.frontDoor }, enc("uint64, uint256, uint256, uint256", [8453n, TAO - 10n ** 14n, 10n ** 14n, 1n]), chunkBlock, CHUNK_TX, 1);
    const run = (pools: { mean: readonly [bigint, bigint]; floors: readonly [bigint, bigint] }) =>
      chains({
        ...x.base,
        baseLogs: [...x.base.baseLogs, payoutReceived(VKEY, 0, USER, TAO - 10n ** 14n, landBlock, BACK_TX)],
        bitReceipts: { [EXEC_TX]: receipt([vaultDelivered(x.execBlock), redeemed(x.execBlock)]), [CHUNK_TX]: receipt([chunk, sent]) },
        baseExecuted: { [H(0x53)]: 2 },
        pref: [200_000_000n, deadline, 6],
        sale: 9_900_000n,
        pools,
      });
    const scan = () => {
      const s = scanned(V32);
      s.delivered.set(String(BATCH), { key: VKEY, txHash: EXEC_TX, block: x.execBlock });
      s.payouts.set(VKEY, [{ txHash: CHUNK_TX, block: chunkBlock, chunk: 0, taken: 1 }]);
      return s;
    };
    const record = async (c: unknown) => {
      const { facts } = await withdrawalFacts(c as never, V32, op, { fd: { ...fd, claimable: TAO - 10n ** 14n }, vault, scan: scan(), claims: [] });
      return withdrawalRecord(op, facts);
    };
    // the TAO/WETH pool's 30-minute mean liquidity is under the front door's floor
    const thin = await record(run({ mean: [100n, 10n ** 12n], floors: [1_000n, 0n] }));
    expect(thin.steps[3]).toMatchObject({ status: "action", detail: "USDC delivery is waiting for the market to deepen. You can claim your TAO now instead." });
    expect(thin.status).toBe("ready");
    expect(offersClaim(thin)).toBe(true);
    // deep enough: delivered automatically, as before
    const deep = await record(run({ mean: [10n ** 6n, 10n ** 12n], floors: [1_000n, 10n ** 9n] }));
    expect(deep.steps[3]).toMatchObject({ status: "active", detail: "USDC is being delivered to your wallet automatically" });
    expect(isDelivering(deep)).toBe(true);
  });
});

describe("v3.2's Receive TAO: an unstake with no delivery, its TAO claimed on Base by hand (Task 59a)", () => {
  const redeemed = { at: new Date(), txHash: H(9), outcome: "redeemed" as const, taoWei: 99n * 10n ** 14n };
  const payout = { txHash: H(4), messageId: H(6), state: 2 as const, at: new Date() };
  const tao: WithdrawalOp = { ...wop, usdcEstimate: 0n, keepTao: true };

  it("names its last step as claiming the TAO, and shows no USDC it never asked for", () => {
    const on = withdrawalRecord(tao, wbase);
    expect(on.steps[3]).toMatchObject({ key: "claim", title: "Claim your TAO", status: "pending" });
    expect(on.usdcAmount).toBeUndefined();
    expect(on.keepsTao).toBe(true);
    expect(on.awaitingDelivery).toBeUndefined();
  });

  it("is ready to claim once its own payout is back on Base", () => {
    const ready = withdrawalRecord(tao, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout, claimable: 99n * 10n ** 14n });
    expect(ready.steps[3]).toMatchObject({ title: "Claim your TAO", status: "action", detail: "Your TAO is back on Base, ready to claim" });
    expect(ready.status).toBe("ready");
    expect(offersClaim(ready)).toBe(true);
    // claimed as TAO: paid, what came back in TAO
    const claimed = { hash: H(11), at: new Date(), taoClaimed: 99n * 10n ** 14n, keptTao: true, swapFailed: false };
    const paid = withdrawalRecord(tao, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout, claimable: 0n, claimed });
    expect(paid.status).toBe("paid");
    expect(paid.received).toEqual({ keptTao: 0.0099 });
    expect(paid.usdcAmount).toBeUndefined();
  });

  it("sold by a later USDC unstake's delivery: shown sold, with its receipt, never in progress (C1, M7)", () => {
    const back = { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout, claimable: 0n, credited: { at: new Date(), taoWei: 99n * 10n ** 14n } };
    const sold = withdrawalRecord(tao, { ...back, usdcDelivered: { hash: H(12), at: new Date(), usdcOut: 2_450_000n } });
    expect(sold.status).toBe("paid");
    expect(sold.steps[3]).toMatchObject({ title: "USDC delivered", status: "done", txUrl: `https://basescan.org/tx/${H(12)}` });
    expect(sold.received).toEqual({ usdc: 2.45 });
    expect(sold.usdcAmount).toBe(2.45);
  });

  it("claimed from another device, or paid out with its logs unreadable: settled, never in progress (M7)", () => {
    const back = { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout, claimable: 0n };
    const claimed = withdrawalRecord(tao, { ...back, claimedOnChain: { hash: H(13), at: new Date(), taoClaimed: 99n * 10n ** 14n } });
    expect(claimed.status).toBe("paid");
    expect(claimed.steps[3]).toMatchObject({ title: "Claimed", status: "done", txUrl: `https://basescan.org/tx/${H(13)}` });
    const unread = withdrawalRecord(tao, { ...back, traceFailed: true });
    expect(unread.status).toBe("paid");
    expect(unread.steps[3]).toMatchObject({ title: "Paid out", status: "done" });
  });

  it("leaves a USDC unstake's record as it was", () => {
    const usdc = withdrawalRecord(wop, wbase);
    expect(usdc.steps[3].title).toBe("Claim as USDC");
    expect(usdc.keepsTao).toBeUndefined();
    expect(usdc.usdcAmount).toBe(2.5);
  });
});
