import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { cancelCall, FlowError, runFlow, sendNowCall, type WalletPort } from "./flows";
import { type CloseOp, createOpLog, type DepositOp, type WithdrawalOp } from "./oplog";
import { cancelStore, opStore } from "./op-store";

const FD = "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750" as const;
const ME = "0x000000000000000000000000000000000000A11c" as const;
const D = { frontDoor: FD, baseAdapter: FD, vault: FD, bitAdapter: FD, bitBlock: 1n, vaultSs58: "x", hotkeySs58: "y" };

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

const op: DepositOp = {
  id: "d1",
  kind: "deposit",
  account: ME,
  createdAt: 1,
  usdcIn: 20_000_000n,
  targetTao: 78_000_000_000_000_000n,
  priceUsd: 251.6,
  hashes: {},
  state: "running",
};

describe("opStore", () => {
  it("keeps a Send it now on its own record: the close's hash before its receipt is waited for, then sent", async () => {
    const log = createOpLog(memoryStorage(), FD);
    const close: CloseOp = { id: "c1", kind: "close", account: ME, createdAt: 1, batchId: 7n, value: 969_000_000_000_000n, hashes: {}, state: "running" };
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
    const w: WithdrawalOp = { id: "w1", kind: "withdrawal", account: ME, createdAt: 1, shares: 1n, taoEstimate: 0n, usdcEstimate: 0n, fee: 0n, state: "running" };
    log.put(w);
    let now = 5_000;
    const store = opStore(log, ME, "w1", () => now);
    store.setHash("request", `0x${"22".repeat(32)}`);
    expect(log.get(ME, "w1")).toMatchObject({ hash: `0x${"22".repeat(32)}`, sentAt: 5_000 });
    now = 9_000;
    store.setHash("request", `0x${"33".repeat(32)}`);
    expect(log.get(ME, "w1")).toMatchObject({ hash: `0x${"33".repeat(32)}`, sentAt: 9_000 });
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
    await expect(runFlow(lost, cancelStore(log, ME, "d1", () => 42), [cancelCall("deposit", 1n, D)])).rejects.toBeInstanceOf(FlowError);
    const after = log.get(ME, "d1") as DepositOp;
    expect(after.cancelled).toEqual({ hash: CANCEL, at: 42 });
    // the record's own flow is left as it was
    expect(after.state).toBe("sent");
    expect(after.error).toBeUndefined();
  });

  it("keeps a cancel that went through, and the record's state", async () => {
    const log = createOpLog(memoryStorage(), FD);
    log.put(sent);
    await runFlow(wallet(async () => ({ status: "success" })), cancelStore(log, ME, "d1", () => 42), [cancelCall("deposit", 1n, D)]);
    expect(log.get(ME, "d1")).toMatchObject({ state: "sent", cancelled: { hash: CANCEL, at: 42 } });
  });

  it("forgets a cancel Base reverted, keeping the one recorded before it", async () => {
    const log = createOpLog(memoryStorage(), FD);
    const earlier = { hash: `0x${"ee".repeat(32)}` as Hex, at: 7 };
    log.put({ ...sent, cancelled: earlier });
    const reverted = wallet(async () => ({ status: "reverted" }));
    await expect(runFlow(reverted, cancelStore(log, ME, "d1", () => 42), [cancelCall("deposit", 1n, D)])).rejects.toBeInstanceOf(FlowError);
    expect((log.get(ME, "d1") as DepositOp).cancelled).toEqual(earlier);
    log.update(ME, "d1", { cancelled: undefined });
    await expect(runFlow(reverted, cancelStore(log, ME, "d1", () => 42), [cancelCall("deposit", 1n, D)])).rejects.toBeInstanceOf(FlowError);
    expect((log.get(ME, "d1") as DepositOp).cancelled).toBeUndefined();
  });
});
