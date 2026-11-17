import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { CANCEL_AHEAD_MS, CANCEL_SENDING_MS, cancelSentCopy, cancelSentFromHere } from "./cancel-sent";
import { cancelCall, FlowError, runFlow, type WalletPort } from "./cascade/flows";
import { createOpLog, type DepositOp, type Operation, type WithdrawalOp } from "./cascade/oplog";
import { cancelStore, confirmCancel, settleCancel } from "./cascade/op-store";

const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const FD = "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750" as const;
const ME = "0x000000000000000000000000000000000000A11c" as const;
const D = { frontDoor: FD, baseAdapter: FD, vault: FD, bitAdapter: FD, bitBlock: 1n, vaultSs58: "x", hotkeySs58: "y" };
/** Records are dated in 2026 (the op log drops a record dated before Cascade existed). */
const NOW = Date.UTC(2026, 10, 16, 12);
const CANCEL = H(0xcc);

const deposit = (over: Partial<DepositOp> = {}): DepositOp => ({
  id: "d1",
  kind: "deposit",
  account: ME,
  createdAt: NOW - 60 * 60_000,
  v: 3,
  usdcIn: 25_000_000n,
  targetTao: 10n ** 17n,
  hashes: { stake: H(1) },
  batchId: 7n,
  state: "sent",
  ...over,
});
const unstake = (over: Partial<WithdrawalOp> = {}): WithdrawalOp => ({
  id: "w1",
  kind: "withdrawal",
  account: ME,
  createdAt: NOW - 60 * 60_000,
  shares: 10n ** 21n,
  taoEstimate: 7n * 10n ** 16n,
  usdcEstimate: 17_410_000n,
  fee: 2n * 10n ** 14n,
  hash: H(2),
  batchId: 7n,
  state: "sent",
  ...over,
});
/** The receipt's record as the list last read it: still waiting in its open batch, its cancel offered. */
const waiting = { id: "d1", cancellableWei: 10n ** 17n };
const waitingUnstake = { id: "w1", cancellableShares: 10n ** 21n };
/** A cancel sent a few seconds ago. */
const sent = { hash: CANCEL, at: NOW - 5_000 };

describe("a cancel this browser sent, while the receipt's record doesn't show it yet", () => {
  it("with no record of a cancel, nothing: the receipt is exactly what its record says", () => {
    expect(cancelSentFromHere([], "deposit", waiting, NOW)).toBeNull();
    expect(cancelSentFromHere([deposit()], "deposit", waiting, NOW)).toBeNull();
    expect(cancelSentFromHere([unstake()], "withdrawal", waitingUnstake, NOW)).toBeNull();
  });

  it("in flight: sent from here and not confirmed, on a record read before it: it is on its way, with its transaction", () => {
    expect(cancelSentFromHere([deposit({ cancelled: sent })], "deposit", waiting, NOW)).toEqual({ state: "sending", hash: CANCEL, at: NOW - 5_000 });
    expect(cancelSentFromHere([unstake({ cancelled: sent })], "withdrawal", waitingUnstake, NOW)).toEqual({ state: "sending", hash: CANCEL, at: NOW - 5_000 });
    // a device clock a little behind the record's (the mark is newer than `now`) is still in flight
    expect(cancelSentFromHere([deposit({ cancelled: sent })], "deposit", waiting, NOW - 20_000)?.state).toBe("sending");
  });

  it("a mark dated ahead of this device's clock isn't in flight: it would otherwise hold the cancel for the clock's error and ten minutes more", () => {
    expect(CANCEL_AHEAD_MS).toBe(60_000);
    const ahead = (ms: number) => cancelSentFromHere([deposit({ cancelled: { hash: CANCEL, at: NOW + ms } })], "deposit", waiting, NOW);
    // 12 hours ahead (a clock since set back, or a forged date): the record's word stands, and the cancel is offered
    expect(ahead(12 * 60 * 60_000)).toBeNull();
    expect(ahead(CANCEL_AHEAD_MS + 1)).toBeNull();
    // up to a minute ahead is the same clock, read a moment apart
    expect(ahead(CANCEL_AHEAD_MS)?.state).toBe("sending");
    expect(ahead(1)?.state).toBe("sending");
    // an unstake's the same
    expect(cancelSentFromHere([unstake({ cancelled: { hash: CANCEL, at: NOW + 12 * 60 * 60_000 } })], "withdrawal", waitingUnstake, NOW)).toBeNull();
  });

  it("confirmed before the scan catches up: cancelled, on a read made before the cancel, however long that read stays", () => {
    const done = deposit({ cancelled: { ...sent, confirmed: true } });
    expect(cancelSentFromHere([done], "deposit", waiting, NOW)).toEqual({ state: "done", hash: CANCEL, at: NOW - 5_000 });
    // days later (a reload, the same stale read, which knows of no cancel, or only of an earlier one): still cancelled
    expect(cancelSentFromHere([done], "deposit", waiting, NOW + 3 * 24 * 60 * 60_000)?.state).toBe("done");
    expect(cancelSentFromHere([done], "deposit", { ...waiting, cancelSeen: H(0xee) }, NOW + 3 * 24 * 60 * 60_000)?.state).toBe("done");
    expect(cancelSentFromHere([unstake({ cancelled: { ...sent, confirmed: true } })], "withdrawal", waitingUnstake, NOW)?.state).toBe("done");
  });

  it("a confirmed mark is this browser's word, not the chain's: a read that names this very cancel as one that didn't take the record out wins once the cancel's ten minutes are over", () => {
    const done = (at: number) => deposit({ cancelled: { hash: CANCEL, at, confirmed: true } });
    const refused = { ...waiting, cancelSeen: CANCEL };
    // inside the window: a node that hasn't the cancel's block yet says the same thing, so the read is taken to be behind
    expect(cancelSentFromHere([done(NOW - 5_000)], "deposit", refused, NOW)?.state).toBe("done");
    expect(cancelSentFromHere([done(NOW - CANCEL_SENDING_MS + 1)], "deposit", refused, NOW)?.state).toBe("done");
    // past it: the record's word decides, and the cancel (and Send it now) is offered again, never held for the batch's life
    expect(cancelSentFromHere([done(NOW - CANCEL_SENDING_MS)], "deposit", refused, NOW)).toBeNull();
    expect(cancelSentFromHere([done(NOW - 3 * 24 * 60 * 60_000)], "deposit", refused, NOW)).toBeNull();
    expect(cancelSentFromHere([done(NOW - CANCEL_SENDING_MS)], "deposit", { ...waiting, cancelSeen: CANCEL.toUpperCase().replace("0X", "0x") as Hex }, NOW)).toBeNull();
    // a mark dated ahead of the clock has no window to stand in against such a read
    expect(cancelSentFromHere([done(NOW + 12 * 60 * 60_000)], "deposit", refused, NOW)).toBeNull();
    // an unstake's the same
    const undone = unstake({ cancelled: { hash: CANCEL, at: NOW - CANCEL_SENDING_MS, confirmed: true } });
    expect(cancelSentFromHere([undone], "withdrawal", { ...waitingUnstake, cancelSeen: CANCEL }, NOW)).toBeNull();
    expect(cancelSentFromHere([undone], "withdrawal", { ...waitingUnstake, cancelSeen: CANCEL }, NOW - 1)?.state).toBe("done");
  });

  it("failed: the mark taken back off the record, or a read that saw this same cancel fail, offers the cancel again", () => {
    // reverted in this tab: cancelStore took the mark back (below, through the store itself)
    expect(cancelSentFromHere([deposit()], "deposit", waiting, NOW)).toBeNull();
    // the read was made after the cancel was sent, and found it didn't take the deposit out (reverted, dropped, replaced)
    expect(cancelSentFromHere([deposit({ cancelled: sent })], "deposit", { ...waiting, cancelSeen: CANCEL }, NOW)).toBeNull();
    expect(cancelSentFromHere([deposit({ cancelled: sent })], "deposit", { ...waiting, cancelSeen: CANCEL.toUpperCase().replace("0X", "0x") as Hex }, NOW)).toBeNull();
    // a read that saw an earlier cancel fail says nothing of the one sent since
    expect(cancelSentFromHere([deposit({ cancelled: sent })], "deposit", { ...waiting, cancelSeen: H(0xee) }, NOW)?.state).toBe("sending");
  });

  it("never holds a way out on a cancel nothing has confirmed: ten minutes on, the record's word stands again", () => {
    expect(CANCEL_SENDING_MS).toBe(10 * 60_000);
    const op = deposit({ cancelled: { hash: CANCEL, at: NOW - CANCEL_SENDING_MS + 1 } });
    expect(cancelSentFromHere([op], "deposit", waiting, NOW)?.state).toBe("sending");
    expect(cancelSentFromHere([op], "deposit", waiting, NOW + 1)).toBeNull();
  });

  it("another deposit's cancel, or an unstake's, never hides this one's button", () => {
    const other = deposit({ id: "d2", cancelled: { ...sent, confirmed: true } });
    expect(cancelSentFromHere([other, deposit()], "deposit", waiting, NOW)).toBeNull();
    expect(cancelSentFromHere([other], "deposit", waiting, NOW)).toBeNull();
    // nor a record of the other kind that happens to share the id
    expect(cancelSentFromHere([unstake({ id: "d1", cancelled: { ...sent, confirmed: true } })], "deposit", waiting, NOW)).toBeNull();
    expect(cancelSentFromHere([deposit({ id: "w1", cancelled: sent })], "withdrawal", waitingUnstake, NOW)).toBeNull();
    // and its own still does, beside them
    expect(cancelSentFromHere([other, deposit({ cancelled: sent })], "deposit", waiting, NOW)?.state).toBe("sending");
  });

  it("says nothing once the record itself no longer offers its cancel: the read has caught up (cancelled, cancelling, or gone with its batch)", () => {
    for (const cancelled of [sent, { ...sent, confirmed: true as const }]) {
      expect(cancelSentFromHere([deposit({ cancelled })], "deposit", { id: "d1" }, NOW)).toBeNull();
      expect(cancelSentFromHere([unstake({ cancelled })], "withdrawal", { id: "w1" }, NOW)).toBeNull();
    }
  });
});

describe("the three states, through the cancel's own store (cancelStore, confirmCancel, settleCancel)", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  /** A wallet that sends the cancel, then answers its receipt with `wait`. */
  const wallet = (wait: WalletPort["wait"], send: WalletPort["send"] = async () => CANCEL): WalletPort => ({
    switchToBase: async () => undefined,
    canBatch: async () => false,
    sendBatch: async () => ({ id: "x" }),
    waitBatch: async () => ({ status: "success", hashes: [] }),
    send,
    wait,
    hasCode: async () => false,
    signPermit: async () => ({ v: 27, r: CANCEL, s: CANCEL }),
    simulate: async () => ({ ok: true }),
  });
  const seen = (log: ReturnType<typeof createOpLog>, now = NOW) => cancelSentFromHere(log.list(ME) as Operation[], "deposit", waiting, now);

  it("in flight from the moment the wallet sends it, cancelled once its flow has seen it through, and still so after a reload", async () => {
    const storage = memory();
    const log = createOpLog(storage, FD, undefined, () => NOW);
    log.put(deposit());
    const during: unknown[] = [];
    const landing = wallet(async () => {
      // the receipt is still awaited: the record already says a cancel is on its way
      during.push(seen(log));
      return { status: "success" };
    });
    expect(seen(log)).toBeNull();
    await runFlow(landing, cancelStore(log, ME, "d1", () => NOW - 2_000), [cancelCall("deposit", 10n ** 17n, D)]);
    expect(during).toEqual([{ state: "sending", hash: CANCEL, at: NOW - 2_000 }]);
    // the wallet's receipt came back; it is marked confirmed only once the cancel's own receipt has said it took the
    // deposit out (use-flows.ts, next: flows.ts cancelConfirmed)
    expect(seen(log)?.state).toBe("sending");
    confirmCancel(log, ME, "d1", CANCEL);
    expect(seen(log)).toEqual({ state: "done", hash: CANCEL, at: NOW - 2_000 });
    // a reload: the same storage, read by a new log
    expect(seen(createOpLog(storage, FD, undefined, () => NOW))).toEqual({ state: "done", hash: CANCEL, at: NOW - 2_000 });
    expect((createOpLog(storage, FD, undefined, () => NOW).get(ME, "d1") as DepositOp).cancelled).toEqual({ hash: CANCEL, at: NOW - 2_000, confirmed: true });
  });

  it("failed: a cancel Base reverted leaves no mark, so the button comes back; so does one declined in the wallet, never sent", async () => {
    const log = createOpLog(memory(), FD, undefined, () => NOW);
    log.put(deposit());
    const during: unknown[] = [];
    const reverted = wallet(async () => {
      during.push(seen(log)?.state);
      return { status: "reverted" };
    });
    await expect(runFlow(reverted, cancelStore(log, ME, "d1", () => NOW - 2_000), [cancelCall("deposit", 10n ** 17n, D)])).rejects.toBeInstanceOf(FlowError);
    expect(during).toEqual(["sending"]);
    expect(seen(log)).toBeNull();
    // nothing to confirm on a record whose cancel failed
    confirmCancel(log, ME, "d1", CANCEL);
    expect((log.get(ME, "d1") as DepositOp).cancelled).toBeUndefined();
    const declined = wallet(
      async () => ({ status: "success" }),
      async () => {
        throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      },
    );
    await expect(runFlow(declined, cancelStore(log, ME, "d1", () => NOW - 1_000), [cancelCall("deposit", 10n ** 17n, D)])).rejects.toBeInstanceOf(FlowError);
    expect(seen(log)).toBeNull();
  });

  it("a cancel whose receipt never came back stays on its way, then gives the button back: nothing confirmed it", async () => {
    const log = createOpLog(memory(), FD, undefined, () => NOW);
    log.put(deposit());
    const lost = wallet(async () => {
      throw new Error("the connection dropped");
    });
    await expect(runFlow(lost, cancelStore(log, ME, "d1", () => NOW - 2_000), [cancelCall("deposit", 10n ** 17n, D)])).rejects.toBeInstanceOf(FlowError);
    expect(seen(log)?.state).toBe("sending");
    expect(seen(log, NOW + CANCEL_SENDING_MS)).toBeNull();
  });

  it("confirmCancel marks only a deposit's or an unstake's own cancel, once", () => {
    const log = createOpLog(memory(), FD, undefined, () => NOW);
    log.put(deposit({ cancelled: sent }));
    log.put(unstake({ cancelled: sent }));
    log.put(deposit({ id: "d2" }));
    confirmCancel(log, ME, "d1", CANCEL);
    confirmCancel(log, ME, "d1", CANCEL);
    confirmCancel(log, ME, "w1", CANCEL);
    confirmCancel(log, ME, "d2", CANCEL);
    confirmCancel(log, ME, "none", CANCEL);
    expect((log.get(ME, "d1") as DepositOp).cancelled).toEqual({ ...sent, confirmed: true });
    expect((log.get(ME, "w1") as WithdrawalOp).cancelled).toEqual({ ...sent, confirmed: true });
    expect((log.get(ME, "d2") as DepositOp).cancelled).toBeUndefined();
    expect(log.get(ME, "none")).toBeNull();
  });

  it("confirmCancel confirms only the cancel whose receipt was read: with another hash than the record's mark holds now, it writes nothing", () => {
    const storage = memory();
    const log = createOpLog(storage, FD, undefined, () => NOW);
    // another tab's cancel replaced this one's mark while this one's receipt was being read
    const theirs = { hash: H(0xdd), at: NOW - 1_000 };
    log.put(deposit({ cancelled: theirs }));
    log.put(unstake({ cancelled: theirs }));
    const before = storage.getItem(`cascade.ops.${FD.toLowerCase()}.${ME.toLowerCase()}`);
    confirmCancel(log, ME, "d1", CANCEL);
    confirmCancel(log, ME, "w1", CANCEL);
    expect((log.get(ME, "d1") as DepositOp).cancelled).toEqual(theirs);
    expect((log.get(ME, "w1") as WithdrawalOp).cancelled).toEqual(theirs);
    expect(storage.getItem(`cascade.ops.${FD.toLowerCase()}.${ME.toLowerCase()}`)).toBe(before);
    expect(seen(log)?.state).toBe("sending");
    // the mark's own hash, whatever its letters' case, is the one confirmed
    confirmCancel(log, ME, "d1", H(0xdd).toUpperCase().replace("0X", "0x") as Hex);
    expect((log.get(ME, "d1") as DepositOp).cancelled).toEqual({ ...theirs, confirmed: true });
  });

  it("the cancel's own receipt settles it: took the deposit out, cancelled; definitely didn't, its mark is taken back and Cancel is offered again at once; unreadable, still on its way", async () => {
    /** A cancel the wallet saw through, then settled by what its own receipt said (`outcome`, of the cancel `read`; null:
     * nothing was read) */
    const settled = async (outcome: boolean | undefined, read: Hex | null = CANCEL, earlier?: { hash: Hex; at: number }) => {
      const log = createOpLog(memory(), FD, undefined, () => NOW);
      log.put(deposit(earlier ? { cancelled: earlier } : {}));
      const store = cancelStore(log, ME, "d1", () => NOW - 2_000);
      await runFlow(wallet(async () => ({ status: "success" })), store, [cancelCall("deposit", 10n ** 17n, D)]);
      expect(seen(log)?.state).toBe("sending");
      settleCancel(store, log, ME, "d1", read ?? undefined, outcome);
      return log;
    };
    expect(seen(await settled(true))).toEqual({ state: "done", hash: CANCEL, at: NOW - 2_000 });
    // a definite no (its receipt was read: no cancel of the account's from the front door, or one out of another batch)
    const no = await settled(false);
    expect((no.get(ME, "d1") as DepositOp).cancelled).toBeUndefined();
    expect(seen(no)).toBeNull();
    // the record gets back the cancel it had before, as on a cancel Base reverted
    const earlier = { hash: H(0xee), at: NOW - 60 * 60_000 };
    expect(((await settled(false, CANCEL, earlier)).get(ME, "d1") as DepositOp).cancelled).toEqual(earlier);
    // not readable yet, or nothing read: nothing is written, and it stays on its way
    for (const log of [await settled(undefined), await settled(true, null), await settled(false, null)]) {
      expect((log.get(ME, "d1") as DepositOp).cancelled).toEqual({ hash: CANCEL, at: NOW - 2_000 });
      expect(seen(log)?.state).toBe("sending");
    }
    // a receipt read for another cancel than the record holds now (another tab's since) settles nothing of it
    for (const outcome of [true, false]) {
      const log = await settled(outcome, H(0xdd));
      expect((log.get(ME, "d1") as DepositOp).cancelled, String(outcome)).toEqual({ hash: CANCEL, at: NOW - 2_000 });
    }
  });

  it("takeBack is the store's own cancel alone: nothing before it has sent one", () => {
    const log = createOpLog(memory(), FD, undefined, () => NOW);
    log.put(deposit({ cancelled: sent }));
    cancelStore(log, ME, "d1").takeBack(CANCEL);
    expect((log.get(ME, "d1") as DepositOp).cancelled).toEqual(sent);
  });
});

describe("what the receipt says in the buttons' place", () => {
  const tx = `https://basescan.org/tx/${CANCEL}`;

  it("on its way: that it is cancelling, with its transaction", () => {
    expect(cancelSentCopy("deposit", { state: "sending", hash: CANCEL, at: NOW })).toEqual({ lead: "Cancelling your deposit…", txUrl: tx });
    expect(cancelSentCopy("unstake", { state: "sending", hash: CANCEL, at: NOW })).toEqual({ lead: "Cancelling your unstake…", txUrl: tx });
  });

  it("cancelled: a deposit's TAO is back as TAO, not USDC; an unstake keeps its shares, not its request fee", () => {
    expect(cancelSentCopy("deposit", { state: "done", hash: CANCEL, at: NOW })).toEqual({
      lead: "Deposit cancelled.",
      text: "Your TAO is back in your wallet as TAO, not USDC.",
      txUrl: tx,
    });
    expect(cancelSentCopy("unstake", { state: "done", hash: CANCEL, at: NOW })).toEqual({
      lead: "Unstake cancelled.",
      text: "Your shares stay staked; the request fee isn't refunded.",
      txUrl: tx,
    });
  });
});
