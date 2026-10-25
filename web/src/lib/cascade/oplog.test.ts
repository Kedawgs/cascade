import { describe, expect, it } from "vitest";
import { createOpLog, type DepositOp } from "./oplog";

const FD = "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750" as const;
const ME = "0x000000000000000000000000000000000000A11c" as const;
const YOU = "0x000000000000000000000000000000000000b0B0" as const;

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), keys: () => [...m.keys()] };
}

const deposit = (id: string, account: `0x${string}`, createdAt: number): DepositOp => ({
  id,
  kind: "deposit",
  account,
  createdAt,
  usdcIn: 20_000_000n,
  targetTao: 78_000_000_000_000_000n,
  priceUsd: 251.6,
  mode: "sequential",
  hashes: {},
  state: "running",
});

describe("operation log", () => {
  it("round-trips operations with exact amounts, newest first", () => {
    const s = memoryStorage();
    const log = createOpLog(s, FD);
    log.put(deposit("a", ME, 1));
    log.put(deposit("b", ME, 2));
    log.update(ME, "a", { hashes: { swap: `0x${"11".repeat(32)}` }, batchId: 3n });
    const again = createOpLog(s, FD);
    expect(again.list(ME).map((o) => o.id)).toEqual(["b", "a"]);
    const a = again.get(ME, "a") as DepositOp;
    expect(a.targetTao).toBe(78_000_000_000_000_000n);
    expect(a.batchId).toBe(3n);
    expect(a.hashes.swap).toBe(`0x${"11".repeat(32)}`);
  });

  it("keeps each account's log apart, keyed by front door and lowercase account", () => {
    const s = memoryStorage();
    const log = createOpLog(s, FD);
    log.put(deposit("a", ME, 1));
    log.put(deposit("z", YOU, 1));
    expect(log.list(ME).map((o) => o.id)).toEqual(["a"]);
    expect(log.list(YOU).map((o) => o.id)).toEqual(["z"]);
    expect(s.keys()).toContain(`cascade.ops.${FD.toLowerCase()}.${ME.toLowerCase()}`);
  });

  it("still works in memory when the browser blocks storage", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const log = createOpLog(broken, FD);
    log.put(deposit("a", ME, 1));
    expect(log.get(ME, "a")?.id).toBe("a");
  });
});
