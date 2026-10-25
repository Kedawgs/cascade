import { describe, expect, it } from "vitest";
import { createOpLog, type DepositOp } from "./oplog";
import { opStore } from "./op-store";

const FD = "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750" as const;
const ME = "0x000000000000000000000000000000000000A11c" as const;

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
});
