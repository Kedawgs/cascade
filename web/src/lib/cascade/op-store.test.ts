import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { cancelCall, FlowError, runFlow, sendNowCall, stakeV3Calls, type WalletPort } from "./flows";
import { type CloseOp, createOpLog, type DepositOp, type WithdrawalOp } from "./oplog";
import { cancelStore, confirmCancel, opStore, settleCancel } from "./op-store";

const FD = "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750" as const;
const ME = "0x000000000000000000000000000000000000A11c" as const;
const D = { frontDoor: FD, baseAdapter: FD, vault: FD, bitAdapter: FD, bitBlock: 1n, vaultSs58: "x", hotkeySs58: "y" };

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

/** Records are dated in 2026 (the op log drops a record dated before Cascade existed). */
const T0 = Date.UTC(2026, 9, 1);

const op: DepositOp = {
  id: "d1",
  kind: "deposit",
  account: ME,
  createdAt: T0 + 1,
  usdcIn: 20_000_000n,
  targetTao: 78_000_000_000_000_000n,
  priceUsd: 251.6,
  hashes: {},
  state: "running",
};

describe("opStore", () => {
  it("keeps a Send it now on its own record: the close's hash before its receipt is waited for, then sent", async () => {
    const log = createOpLog(memoryStorage(), FD);
    const close: CloseOp = { id: "c1", kind: "close", account: ME, createdAt: T0 + 1, batchId: 7n, value: 969_000_000_000_000n, hashes: {}, state: "running" };
    log.put(close);
    const hash = `0x${"44".repeat(32)}` as Hex;
    const seenWhileWaiting: unknown[] = [];
    const port = {
      switchToBase: async () => undefined,
      canBatch: async () => true,
      send: async () => hash,
      wait: async () => {
        seenWhileWaiting.push((log.get(ME, "c1") as CloseOp).hashes.close);
        return { status: "success" as const };
      },
    } as unknown as WalletPort;
    await runFlow(port, opStore(log, ME, "c1"), [sendNowCall(969_000_000_000_000n, D)]);
    // one call is never sent as a wallet batch
    expect(seenWhileWaiting).toEqual([hash]);
    expect(log.get(ME, "c1")).toMatchObject({ hashes: { close: hash }, state: "sent", mode: "sequential", batchId: 7n, value: 969_000_000_000_000n });
    // it is no deposit or unstake: it never shows among them, and is never removed as unsent
    expect(log.removeUnsent(ME, "c1")).toBe(false);
  });

  it("puts its entry back if it was removed while the flow was still running, keeping the new hash", () => {
    const log = createOpLog(memoryStorage(), FD);
    log.put(op);
    const store = opStore(log, ME, "d1");
    log.remove(ME, "d1");
    store.setHash("swap", `0x${"22".repeat(32)}`);
    const back = log.get(ME, "d1") as DepositOp;
    expect(back.hashes.swap).toBe(`0x${"22".repeat(32)}`);
    expect(back.targetTao).toBe(78_000_000_000_000_000n);
  });

  it("dates an unstake request's hash when it is recorded, again when a sped-up one takes its place", () => {
    const log = createOpLog(memoryStorage(), FD);
    const w: WithdrawalOp = { id: "w1", kind: "withdrawal", account: ME, createdAt: T0 + 1, shares: 1n, taoEstimate: 0n, usdcEstimate: 0n, fee: 0n, state: "running" };
    log.put(w);
    let now = T0 + 5_000;
    const store = opStore(log, ME, "w1", () => now);
    store.setHash("request", `0x${"22".repeat(32)}`);
    expect(log.get(ME, "w1")).toMatchObject({ hash: `0x${"22".repeat(32)}`, sentAt: T0 + 5_000 });
    now = T0 + 9_000;
    store.setHash("request", `0x${"33".repeat(32)}`);
    expect(log.get(ME, "w1")).toMatchObject({ hash: `0x${"33".repeat(32)}`, sentAt: T0 + 9_000 });
  });
});

describe("opStore through a whole wallet-batch flow", () => {
  const v3: DepositOp = { ...op, v: 3, minTaoOut: 77_611_000_000_000_000n };
  const D3 = { ...D, staker: "0x00000000000000000000000000000000005A4E12" as const, oracle: "0x000000000000000000000000000000000000041E" as const };
  const balances = { usdc: 20_000_000n, tao: 0n, eth: 10n ** 15n, usdcRouterAllowance: 0n, usdcStakerAllowance: 0n, taoRouterAllowance: 0n, taoFrontDoorAllowance: 0n, claimable: 0n };
  /** A wallet that sends the stake as one batch under `id`. */
  const batching = (id: string): WalletPort => ({
    switchToBase: async () => undefined,
    canBatch: async () => true,
    sendBatch: async () => ({ id }),
    waitBatch: async () => ({ status: "success", hashes: [`0x${"11".repeat(32)}`] }),
    send: async () => {
      throw new Error("not one at a time");
    },
    wait: async () => ({ status: "success" }),
    hasCode: async () => false,
    signPermit: async () => ({ v: 27, r: `0x${"11".repeat(32)}`, s: `0x${"11".repeat(32)}` }),
    simulate: async () => ({ ok: true }),
  });

  it("keeps a batch id as long as EIP-5792 allows (8,194 characters) from the send to the receipt, and reads it back", async () => {
    const s = memoryStorage();
    const log = createOpLog(s, FD);
    log.put(v3);
    const longest = `0x${"ab".repeat(4_096)}`;
    await runFlow(batching(longest), opStore(log, ME, "d1"), stakeV3Calls(v3 as never, balances, D3, ME));
    const back = createOpLog(s, FD).get(ME, "d1") as DepositOp;
    expect(back).toMatchObject({ state: "sent", mode: "batch", callsId: longest });
    expect(back.hashes).toEqual({ approveUsdc: `0x${"11".repeat(32)}`, stake: `0x${"11".repeat(32)}` });
  });

  it("never loses its place when a write leaves the record unreadable: it says so loudly, keeps what it knows, and the flow finishes", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const log = createOpLog(memoryStorage(), FD);
      log.put(v3);
      // a batch id past what the log reads back: the record in storage can't be read after this write
      const tooLong = `0x${"ab".repeat(5_000)}`;
      const store = opStore(log, ME, "d1");
      await expect(runFlow(batching(tooLong), store, stakeV3Calls(v3 as never, balances, D3, ME))).resolves.toBeUndefined();
      // the store went on from its own copy: the batch's hashes and the final state were recorded on it
      expect(store.hashes()).toEqual({ approveUsdc: `0x${"11".repeat(32)}`, stake: `0x${"11".repeat(32)}` });
      expect(store.callsId()).toBe(tooLong);
      expect(error).toHaveBeenCalled();
      expect(String(error.mock.calls[0][0])).toMatch(/couldn't be read back/);
    } finally {
      error.mockRestore();
    }
  });
});

describe("cancelStore", () => {
  const CANCEL = `0x${"cc".repeat(32)}` as Hex;
  /** A wallet that sends the cancel, then answers its receipt with `wait`. */
  const wallet = (wait: WalletPort["wait"]): WalletPort => ({
    switchToBase: async () => undefined,
    canBatch: async () => false,
    sendBatch: async () => ({ id: "x" }),
    waitBatch: async () => ({ status: "success", hashes: [] }),
    send: async () => CANCEL,
    wait,
    hasCode: async () => false,
    signPermit: async () => ({ v: 27, r: CANCEL, s: CANCEL }),
    simulate: async () => ({ ok: true }),
  });
  const sent = { ...op, state: "sent" as const, hashes: { stake: `0x${"11".repeat(32)}` as Hex } };

  it("links the cancel to its record as soon as it is sent, even when its receipt never comes back", async () => {
    const log = createOpLog(memoryStorage(), FD);
    log.put(sent);
    const lost = wallet(async () => {
      throw new Error("the connection dropped");
    });
    await expect(runFlow(lost, cancelStore(log, ME, "d1", () => T0 + 42), [cancelCall("deposit", 1n, D)])).rejects.toBeInstanceOf(FlowError);
    const after = log.get(ME, "d1") as DepositOp;
    expect(after.cancelled).toEqual({ hash: CANCEL, at: T0 + 42 });
    // the record's own flow is left as it was
    expect(after.state).toBe("sent");
    expect(after.error).toBeUndefined();
  });

  it("keeps a cancel that went through, and the record's state", async () => {
    const log = createOpLog(memoryStorage(), FD);
    log.put(sent);
    await runFlow(wallet(async () => ({ status: "success" })), cancelStore(log, ME, "d1", () => T0 + 42), [cancelCall("deposit", 1n, D)]);
    expect(log.get(ME, "d1")).toMatchObject({ state: "sent", cancelled: { hash: CANCEL, at: T0 + 42 } });
    // the store itself confirms nothing: its flow does, on the cancel's own receipt (confirmCancel, for that cancel's hash)
    expect((log.get(ME, "d1") as DepositOp).cancelled).toEqual({ hash: CANCEL, at: T0 + 42 });
    confirmCancel(log, ME, "d1", CANCEL);
    expect((log.get(ME, "d1") as DepositOp).cancelled).toEqual({ hash: CANCEL, at: T0 + 42, confirmed: true });
    expect((log.get(ME, "d1") as DepositOp).state).toBe("sent");
  });

  it("confirmCancel is bound to the cancel whose receipt was read: another hash than the record's mark holds now writes nothing", () => {
    const log = createOpLog(memoryStorage(), FD);
    const OTHER = `0x${"dd".repeat(32)}` as Hex;
    log.put({ ...sent, cancelled: { hash: CANCEL, at: T0 + 42 } });
    confirmCancel(log, ME, "d1", OTHER);
    expect((log.get(ME, "d1") as DepositOp).cancelled).toEqual({ hash: CANCEL, at: T0 + 42 });
    // (a second tab's cancel took the mark's place while the first tab read its own receipt: the first confirms nothing)
    log.update(ME, "d1", { cancelled: { hash: OTHER, at: T0 + 50 } });
    confirmCancel(log, ME, "d1", CANCEL);
    expect((log.get(ME, "d1") as DepositOp).cancelled).toEqual({ hash: OTHER, at: T0 + 50 });
    confirmCancel(log, ME, "d1", OTHER);
    expect((log.get(ME, "d1") as DepositOp).cancelled).toEqual({ hash: OTHER, at: T0 + 50, confirmed: true });
  });

  it("takeBack: a cancel the wallet saw through whose own receipt shows it didn't take the record out is taken back off it, as one Base reverted is; only this store's, and only while it is still the record's", async () => {
    const earlier = { hash: `0x${"ee".repeat(32)}` as Hex, at: T0 + 7 };
    const OTHER = `0x${"dd".repeat(32)}` as Hex;
    const ran = async (before?: { hash: Hex; at: number }) => {
      const log = createOpLog(memoryStorage(), FD);
      log.put({ ...sent, ...(before ? { cancelled: before } : {}) });
      const store = cancelStore(log, ME, "d1", () => T0 + 42);
      await runFlow(wallet(async () => ({ status: "success" })), store, [cancelCall("deposit", 1n, D)]);
      expect((log.get(ME, "d1") as DepositOp).cancelled).toEqual({ hash: CANCEL, at: T0 + 42 });
      return { log, store };
    };
    const plain = await ran();
    plain.store.takeBack(CANCEL);
    expect((plain.log.get(ME, "d1") as DepositOp).cancelled).toBeUndefined();
    expect((plain.log.get(ME, "d1") as DepositOp).state).toBe("sent");
    // the cancel the record had before comes back, as on "failed"
    const again = await ran(earlier);
    again.store.takeBack(CANCEL);
    expect((again.log.get(ME, "d1") as DepositOp).cancelled).toEqual(earlier);
    // another hash than the record's: nothing; nor once another tab's cancel has taken the mark's place
    const other = await ran();
    other.store.takeBack(OTHER);
    expect((other.log.get(ME, "d1") as DepositOp).cancelled).toEqual({ hash: CANCEL, at: T0 + 42 });
    other.log.update(ME, "d1", { cancelled: { hash: OTHER, at: T0 + 50 } });
    other.store.takeBack(CANCEL);
    expect((other.log.get(ME, "d1") as DepositOp).cancelled).toEqual({ hash: OTHER, at: T0 + 50 });
    // a store that has sent nothing takes nothing back
    const idle = createOpLog(memoryStorage(), FD);
    idle.put({ ...sent, cancelled: earlier });
    cancelStore(idle, ME, "d1").takeBack(earlier.hash);
    expect((idle.get(ME, "d1") as DepositOp).cancelled).toEqual(earlier);
  });

  it("settleCancel writes what the cancel's own receipt said: confirmed, taken back, or (unreadable) nothing", async () => {
    /** `hash`: the cancel the receipt was read for; null when nothing was read */
    const settled = async (outcome: boolean | undefined, hash: Hex | null = CANCEL) => {
      const log = createOpLog(memoryStorage(), FD);
      log.put(sent);
      const store = cancelStore(log, ME, "d1", () => T0 + 42);
      await runFlow(wallet(async () => ({ status: "success" })), store, [cancelCall("deposit", 1n, D)]);
      settleCancel(store, log, ME, "d1", hash ?? undefined, outcome);
      return (log.get(ME, "d1") as DepositOp).cancelled;
    };
    expect(await settled(true)).toEqual({ hash: CANCEL, at: T0 + 42, confirmed: true });
    expect(await settled(false)).toBeUndefined();
    expect(await settled(undefined)).toEqual({ hash: CANCEL, at: T0 + 42 });
    expect(await settled(true, null)).toEqual({ hash: CANCEL, at: T0 + 42 });
    expect(await settled(false, null)).toEqual({ hash: CANCEL, at: T0 + 42 });
  });

  it("confirmCancel leaves a record with no cancel sent, a claim or a close, and a record that isn't there, as they were", () => {
    const log = createOpLog(memoryStorage(), FD);
    log.put(sent);
    const close: CloseOp = { id: "c1", kind: "close", account: ME, createdAt: T0 + 1, batchId: 7n, value: 1n, hashes: {}, state: "sent" };
    log.put(close);
    confirmCancel(log, ME, "d1", CANCEL);
    confirmCancel(log, ME, "c1", CANCEL);
    confirmCancel(log, ME, "gone", CANCEL);
    expect(log.get(ME, "d1")).toEqual(sent);
    expect(log.get(ME, "c1")).toEqual(close);
    expect(log.get(ME, "gone")).toBeNull();
  });

  it("forgets a cancel Base reverted, keeping the one recorded before it", async () => {
    const log = createOpLog(memoryStorage(), FD);
    const earlier = { hash: `0x${"ee".repeat(32)}` as Hex, at: T0 + 7 };
    log.put({ ...sent, cancelled: earlier });
    const reverted = wallet(async () => ({ status: "reverted" }));
    await expect(runFlow(reverted, cancelStore(log, ME, "d1", () => T0 + 42), [cancelCall("deposit", 1n, D)])).rejects.toBeInstanceOf(FlowError);
    expect((log.get(ME, "d1") as DepositOp).cancelled).toEqual(earlier);
    log.update(ME, "d1", { cancelled: undefined });
    await expect(runFlow(reverted, cancelStore(log, ME, "d1", () => T0 + 42), [cancelCall("deposit", 1n, D)])).rejects.toBeInstanceOf(FlowError);
    expect((log.get(ME, "d1") as DepositOp).cancelled).toBeUndefined();
  });
});
