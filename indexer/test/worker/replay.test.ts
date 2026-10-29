import { encodeAbiParameters, type Hex, keccak256, numberToHex, pad } from "viem";
import { describe, expect, it } from "vitest";
import { batchKey, encodeBatchMessage, replayBatch } from "../../src/crosscheck/replay.ts";
import type { StoredLog } from "../../src/logs.ts";
import { tx } from "./fixtures.ts";
import { slog } from "./rule-ctx.ts";

const A = "0x00000000000000000000000000000000000000a1" as Hex;
const B = "0x00000000000000000000000000000000000000b2" as Hex;
const C = "0x00000000000000000000000000000000000000c3" as Hex;
const FD = "0x8a825738d0287d0959957a0f6ec18ba1276d209d" as Hex;

let pos = 0;
/** Front door logs in the order given (each in its own block unless a transaction is given). */
function fd(event: string, batchId: bigint, args: Record<string, string>, o: Partial<StoredLog> = {}): StoredLog {
  pos++;
  return slog({ contract: "frontDoor", event, chain: "base", address: FD, block: BigInt(pos), logIndex: 0, topic1: pad(numberToHex(batchId)), args: { ...args, [event === "BatchClosed" || event === "BatchRolled" ? "id" : "batchId"]: String(batchId) }, ...o });
}
const dep = (id: bigint, user: Hex, amount: bigint) => fd("DepositRequested", id, { user, amount: String(amount), payer: user });
const cancelDep = (id: bigint, user: Hex, amount: bigint) => fd("DepositCancelled", id, { user, amount: String(amount) });
const red = (id: bigint, user: Hex, shares: bigint, o: Partial<StoredLog> = {}) => fd("RedeemRequested", id, { user, shares: String(shares) }, o);
const cancelRed = (id: bigint, user: Hex, shares: bigint) => fd("RedeemCancelled", id, { user, shares: String(shares) });
const close = (id: bigint, totalDeposits: bigint, nDeposits: number, nRedeems: number, o: Partial<StoredLog> = {}) =>
  fd("BatchClosed", id, { totalDeposits: String(totalDeposits), nDeposits: String(nDeposits), nRedeems: String(nRedeems), fee: "1", potUsed: "1" }, o);

describe("replayBatch", () => {
  it("merges two deposits by one user, and reduces on a partial cancel", () => {
    const r = replayBatch([dep(7n, A, 10n), dep(7n, B, 5n), dep(7n, A, 3n), cancelDep(7n, A, 4n), close(7n, 14n, 2, 0)], 7n);
    expect(r).toMatchObject({ deposits: [{ user: A, amount: 9n }, { user: B, amount: 5n }], redeems: [] });
  });

  it("moves the last entry into the slot a full cancel frees (swap-and-pop), for deposits and redeems alike", () => {
    const deps = replayBatch([dep(7n, A, 1n), dep(7n, B, 2n), dep(7n, C, 3n), cancelDep(7n, A, 1n), close(7n, 5n, 2, 0)], 7n);
    expect(deps).toMatchObject({ deposits: [{ user: C, amount: 3n }, { user: B, amount: 2n }] });
    const reds = replayBatch([red(7n, A, 1n), red(7n, B, 2n), red(7n, C, 3n), cancelRed(7n, A, 1n), close(7n, 0n, 0, 2)], 7n);
    expect(reds).toMatchObject({ redeems: [{ user: C, amount: 3n }, { user: B, amount: 2n }] });
  });

  it("appends a user's new deposit after a full cancel freed their slot", () => {
    const r = replayBatch([dep(7n, A, 1n), dep(7n, B, 2n), cancelDep(7n, A, 1n), dep(7n, A, 4n), close(7n, 6n, 2, 0)], 7n);
    expect(r).toMatchObject({ deposits: [{ user: B, amount: 2n }, { user: A, amount: 4n }] });
  });

  it("ends a batch closed by a request on a full redeem list before that request, which lands in the next batch", () => {
    const t = tx(77);
    const logs = [red(8n, A, 1n), red(8n, B, 2n), close(8n, 0n, 0, 2, { txHash: t, block: 500n, logIndex: 3 }), red(9n, C, 5n, { txHash: t, block: 500n, logIndex: 4 }), close(9n, 0n, 0, 1, { block: 501n })];
    expect(replayBatch(logs, 8n)).toMatchObject({ redeems: [{ user: A, amount: 1n }, { user: B, amount: 2n }] });
    expect(replayBatch(logs, 9n)).toMatchObject({ redeems: [{ user: C, amount: 5n }] });
  });

  it("can't rebuild: a cancel of an entry that isn't there, a batch not closed, a close whose counts differ", () => {
    expect(replayBatch([dep(7n, A, 1n), cancelDep(7n, B, 1n), close(7n, 0n, 0, 0)], 7n)).toEqual({ error: expect.stringContaining("cancel") });
    expect(replayBatch([dep(7n, A, 1n), cancelDep(7n, A, 2n), close(7n, 0n, 0, 0)], 7n)).toEqual({ error: expect.stringContaining("cancel") });
    expect(replayBatch([dep(7n, A, 1n)], 7n)).toEqual({ error: expect.stringContaining("not closed") });
    expect(replayBatch([dep(7n, A, 1n), close(7n, 2n, 1, 0)], 7n)).toEqual({ error: expect.stringContaining("totalDeposits") });
    expect(replayBatch([dep(7n, A, 1n), close(7n, 1n, 1, 1)], 7n)).toEqual({ error: expect.stringContaining("nRedeems") });
    expect(replayBatch([dep(7n, A, 1n), close(7n, 1n, 1, 0), dep(7n, B, 1n)], 7n)).toEqual({ error: expect.stringContaining("after") });
  });

  it("returns the close it ended on", () => {
    const d = dep(7n, A, 1n);
    const c = close(7n, 1n, 1, 0);
    const r = replayBatch([d, c], 7n);
    expect("closed" in r && r.closed.uid).toBe(c.uid);
  });
});

describe("encodeBatchMessage and batchKey", () => {
  const deposits = [{ user: A, amount: 10n ** 18n }];
  const redeems = [{ user: B, amount: 5n }, { user: C, amount: 6n }];

  it("encodes abi.encode(uint8 1, uint64 id, Entry[] deposits, Entry[] redeems)", () => {
    const entry = { type: "tuple[]", components: [{ name: "user", type: "address" }, { name: "amount", type: "uint256" }] } as const;
    const want = encodeAbiParameters([{ type: "uint8" }, { type: "uint64" }, entry, entry], [1, 43n, deposits, redeems]);
    expect(encodeBatchMessage(43n, deposits, redeems)).toBe(want);
  });

  it("keys a message as keccak256(abi.encode(uint64 sourceChain, address sender, keccak256(message)))", () => {
    const m = encodeBatchMessage(43n, deposits, redeems);
    const want = keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }, { type: "bytes32" }], [8453n, FD, keccak256(m)]));
    expect(batchKey(8453n, FD, m)).toBe(want);
  });

  // Task 30 adds the fixture: v3-test batches 1 and 2's front door logs, whose replayed lists give keys
  // 0x07531aa4…39b48c and 0xc2645240…7fd49c, equal to their BatchDelivered.key.
  it.todo("rebuilds v3-test batches 1 and 2 to their delivered keys (real bytes)");
});
