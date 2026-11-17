import { reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { encodeFunctionData, type Hex, keccak256, parseTransaction, recoverTransactionAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEEPER_CALLS_V32 } from "../../../ops/src/keeper/core/abi.ts";
import { type JournalRow, spentOf } from "../../../ops/src/keeper/core/journal.ts";
import { fromJson, toJson } from "../../../ops/src/keeper/core/memory.ts";
import { REPLACE_AFTER_MS } from "../../../ops/src/keeper/core/round.ts";
import type { CallRequest } from "../../../ops/src/keeper/core/types.ts";
import { ADDR } from "../../../ops/test/keeper-v32-world.ts";
import { rowProblem } from "../../src/proof.ts";
import { chains, coordinator, KEY, keeperRun, ME, started, testEnv } from "./harness.ts";

// Journal rows proven by their own signed transaction (the review's Important 1): a row written over the control route
// must carry its raw, signed by the keeper's key and exactly its request; a row in the journal that isn't is never
// watched; and a pooled transaction that isn't the row's request is never replaced. So a leaked control token can't
// steer what the keeper signs.

const call = (path: string, body: unknown) =>
  exports.default.fetch(`https://keeper.test${path}`, { method: "POST", headers: { authorization: `Bearer ${testEnv.TEST_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const json = async (r: Response) => fromJson<Record<string, unknown>>(await r.text());
const rows = async () => fromJson<JournalRow[]>(await coordinator().since({ sinceMs: 0 }));

/** A close of batch 7 for `minValue`, as the keeper's request */
const closeOf = (minValue: bigint, nonce = 3): CallRequest => ({ chain: "base", nonce, label: "close batch 7 and send it to Bittensor", to: ADDR.frontDoor, abi: KEEPER_CALLS_V32, functionName: "closeBatch", args: [7n, minValue], value: 10n ** 15n });

/** `req` signed by `key` (Base's EIP-1559, the keeper's fees) */
async function signed(req: CallRequest, key: Hex = KEY): Promise<Hex> {
  const data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args } as never);
  return privateKeyToAccount(key).signTransaction({ type: "eip1559", chainId: 8453, nonce: req.nonce, to: req.to, value: req.value ?? 0n, data, gas: 300_000n, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n });
}

const rowOf = (req: CallRequest, raw: Hex, over: Partial<JournalRow> = {}): JournalRow => ({ chain: req.chain, from: ME, nonce: req.nonce, hashes: [keccak256(raw)], request: req, raw, status: "signed", at: Date.now(), ...over });

beforeEach(async () => {
  await reset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function handLease() {
  const a = await json(await call("/v1/lease", { action: "acquire", holder: "hand:pc:1" }));
  return { holder: "hand:pc:1", token: a.token as number };
}

describe("the control route takes a hand run's row only with its proof", () => {
  it("a row whose raw is its request, signed by the keeper: written", async () => {
    chains();
    const l = await handLease();
    const req = closeOf(10n ** 18n);
    const r = await json(await call("/v1/journal", { action: "writeAhead", ...l, row: toJson(rowOf(req, await signed(req))) }));
    expect(r).toMatchObject({ ok: true });
    expect(await rows()).toHaveLength(1);
  });

  it("refused: a request other than its raw, no raw, a raw another key signed, a hash not the raw's, a row not written as signed", async () => {
    chains();
    const l = await handLease();
    const req = closeOf(10n ** 18n);
    const raw = await signed(req);
    const cases: [string, JournalRow, RegExp][] = [
      ["a request other than its raw", rowOf(closeOf(5n * 10n ** 18n), raw), /its signed transaction is not its request signed by the keeper: its data is not the call's/],
      ["no raw", rowOf(req, "0x" as Hex, { hashes: [keccak256(raw)] }), /it carries no signed transaction/],
      ["a raw another key signed", rowOf(req, await signed(req, generatePrivateKey())), /it recovers to 0x[0-9a-fA-F]{40}, not /],
      ["a hash not the raw's", rowOf(req, raw, { hashes: [`0x${"aa".repeat(32)}`] }), /its signed transaction is not its last hash/],
      ["written as sent", rowOf(req, raw, { status: "sent" }), /a hand run writes a row ahead as signed, with its one hash/],
    ];
    for (const [what, row, why] of cases) {
      const res = await call("/v1/journal", { action: "writeAhead", ...l, row: toJson(row) });
      expect(res.status, what).toBe(400);
      expect(String((await json(res)).error), what).toMatch(why);
    }
    expect(await rows()).toEqual([]);
  });

  it("a replacement only as the row's own request at its nonce, or a cancel, signed by the keeper", async () => {
    chains();
    const l = await handLease();
    const req = closeOf(10n ** 18n);
    const raw = await signed(req);
    await call("/v1/journal", { action: "writeAhead", ...l, row: toJson(rowOf(req, raw)) });
    const other = await signed(closeOf(9n * 10n ** 18n));
    const bad = await call("/v1/journal", { action: "replaced", ...l, hash: keccak256(raw), next: { hash: keccak256(other), raw: other } });
    expect(bad.status).toBe(400);
    const cancel = await privateKeyToAccount(KEY).signTransaction({ type: "eip1559", chainId: 8453, nonce: 3, to: ME, value: 0n, data: "0x", gas: 21_000n, maxFeePerGas: 3n * 10n ** 9n, maxPriorityFeePerGas: 2n * 10n ** 8n });
    expect(await json(await call("/v1/journal", { action: "replaced", ...l, hash: keccak256(raw), next: { hash: keccak256(cancel), raw: cancel } }))).toMatchObject({ ok: true });
    expect((await rows())[0].hashes).toEqual([keccak256(raw), keccak256(cancel)]);
  });
});

/** The keeper's cancel at `nonce` on Base (a transfer of nothing to itself), `over` changing a field of it */
async function cancelOf(nonce: number, over: Partial<{ gas: bigint; value: bigint; data: Hex; to: Hex; nonce: number }> = {}): Promise<Hex> {
  return privateKeyToAccount(KEY).signTransaction({ type: "eip1559", chainId: 8453, nonce, to: ME, value: 0n, data: "0x", gas: 21_000n, maxFeePerGas: 3n * 10n ** 9n, maxPriorityFeePerGas: 2n * 10n ** 8n, ...over });
}
/** A cancel as a request (no function, no data: to the keeper, value 0, 21,000 gas) */
const cancelReq = (nonce: number): CallRequest => ({ chain: "base", nonce, label: `cancel nonce ${nonce}`, to: ME, abi: [], functionName: "", args: [], value: 0n, gasLimit: 21_000n });
const ctx = { keeper: ME, chainIds: { base: 8453, bittensor: 964 }, legacy: { base: false, bittensor: true } };

describe("a cancel proves only itself (the re-review's N1, as re-ruled: Task 51 made cancels legitimate keeper sends)", () => {
  it("a row whose transaction is a cancel is written only when its request is that cancel, the raw exactly it; a signed cancel never proves another request", async () => {
    chains();
    const l = await handLease();
    // the attack N1 named: a key-signed cancel at a nonce, beside any request
    const cancel = await cancelOf(3);
    const forged = await call("/v1/journal", { action: "writeAhead", ...l, row: toJson(rowOf(closeOf(10n ** 18n), cancel)) });
    expect(forged.status).toBe(400);
    expect(String((await json(forged)).error)).toMatch(/its signed transaction is a cancel \(a transfer of nothing to the keeper\), which proves no request but that cancel/);
    // the cancel as its own request: not written either (the review's W2): the keeper journals a cancel as the replacement of
    // its stuck send's row, never as a row of its own, which the core could not replace
    const own = await call("/v1/journal", { action: "writeAhead", ...l, row: toJson(rowOf(cancelReq(3), cancel)) });
    expect(own.status).toBe(400);
    expect(String((await json(own)).error)).toMatch(/its request is a cancel, which the keeper never journals as a row of its own \(a cancel is the replacement of its stuck send's row\)/);
    // a raw that isn't exactly that cancel: refused, whatever field differs
    const misses: [string, Hex][] = [
      ["more gas", await cancelOf(4, { gas: 30_000n })],
      ["a value", await cancelOf(4, { value: 1n })],
      ["call data", await cancelOf(4, { data: "0x00" })],
      ["another recipient", await cancelOf(4, { to: ADDR.frontDoor })],
      ["another nonce", await cancelOf(5)],
    ];
    for (const [what, raw] of misses) {
      const res = await call("/v1/journal", { action: "writeAhead", ...l, row: toJson(rowOf(cancelReq(4), raw)) });
      expect(res.status, what).toBe(400);
    }
    expect(await rows()).toEqual([]);
    // nor is one adopted from the journal by a run (it got in some other way): refused, marked dropped
    await call("/v1/lease", { action: "release", ...l });
    const s = coordinator();
    const a = await s.acquire({ holder: "hand:y", kind: "hand", ttlMs: 60_000 });
    if (!a.granted) throw new Error("no lease");
    await s.writeAhead({ holder: "hand:y", token: a.token, row: toJson(rowOf(cancelReq(3), cancel, { status: "sent" })) });
    await s.release({ holder: "hand:y", token: a.token });
    await started();
    const r = await keeperRun(testEnv, { print: () => undefined });
    expect(r.lines.some((x) => x.startsWith("JOURNAL ROW REFUSED: cancel nonce 3") && x.includes("its request is a cancel"))).toBe(true);
    expect((await rows())[0].status).toBe("dropped");
  });

  it("a row whose transaction a cancel replaced stays proven by its first: the route takes the cancel, the object keeps the first beside it, and the next run watches the row", async () => {
    const c = chains((w) => {
      w.door.canClose = false;
    });
    const l = await handLease();
    const req = closeOf(10n ** 18n);
    const raw = await signed(req);
    await call("/v1/journal", { action: "writeAhead", ...l, row: toJson(rowOf(req, raw)) });
    await call("/v1/journal", { action: "update", ...l, patch: toJson([{ hash: keccak256(raw), patch: { status: "sent" } }]) });
    const cancel = await cancelOf(3);
    expect(await json(await call("/v1/journal", { action: "replaced", ...l, hash: keccak256(raw), next: { hash: keccak256(cancel), raw: cancel } }))).toMatchObject({ ok: true });
    const kept = fromJson<JournalRow & { requestRaw?: Hex }>((await coordinator().rowOf({ hash: keccak256(raw) })) as string);
    expect([kept.requestRaw, kept.raw, kept.hashes]).toEqual([raw, cancel, [keccak256(raw), keccak256(cancel)]]);
    // the hand run died without releasing: the cron's run adopts the row, proven by its first transaction and its cancel
    await call("/v1/lease", { action: "break", by: "founder" });
    await started();
    const r = await keeperRun(testEnv, { print: () => undefined });
    expect(r.lines.some((x) => x.startsWith("JOURNAL ROW REFUSED"))).toBe(false);
    expect(r.lines.some((x) => x.startsWith("Settling: close batch 7") && x.includes("it is watched from now"))).toBe(true);
    expect(c.w.sends).toEqual([]);
  });

  it("a row whose newest transaction is a cancel, with nothing proving its request, is never watched; nor one whose first transaction is another request's, or whose newest is neither its request nor a cancel", async () => {
    const c = chains((w) => {
      w.door.canClose = false;
    });
    await started();
    // past the route, as a row that got in some other way: a cancel and a request of anyone's choosing
    const cancel = await cancelOf(3);
    const s = coordinator();
    const a = await s.acquire({ holder: "hand:x", kind: "hand", ttlMs: 60_000 });
    if (!a.granted) throw new Error("no lease");
    await s.writeAhead({ holder: "hand:x", token: a.token, row: toJson(rowOf(closeOf(10n ** 18n), cancel, { status: "sent" })) });
    await s.release({ holder: "hand:x", token: a.token });
    const r = await keeperRun(testEnv, { print: () => undefined });
    expect(r.lines.some((x) => x.startsWith("JOURNAL ROW REFUSED: close batch 7") && x.includes("which proves no request but that cancel"))).toBe(true);
    expect(r.lines.some((x) => x.startsWith("Settling: "))).toBe(false);
    expect((await rows())[0].status).toBe("dropped");
    expect(c.w.sends).toEqual([]);
    // the first transaction kept beside the cancel must prove the row's own request; the newest must be it or a cancel
    const req = closeOf(10n ** 18n);
    const raw = await signed(req);
    const other = await signed(closeOf(9n * 10n ** 18n));
    const replaced = (first: Hex, newest: Hex) => ({ ...rowOf(req, newest, { status: "sent" as const }), hashes: [keccak256(first), keccak256(newest)], requestRaw: first });
    expect(await rowProblem(replaced(raw, cancel), ctx)).toBeUndefined();
    expect(await rowProblem(replaced(other, cancel), ctx)).toMatch(/^its first transaction: its signed transaction is not its request signed by the keeper: its data is not the call's$/);
    expect(await rowProblem(replaced(raw, other), ctx)).toMatch(/its data is not the call's; nor is it the keeper's cancel at nonce 3$/);
    expect(await rowProblem({ ...replaced(raw, cancel), hashes: [keccak256(other), keccak256(cancel)] }, ctx)).toBe("its first signed transaction is not its first hash");
  });
});

describe("the fees prove nothing (the re-review's N3): no fee bound, so a send near a gas price cap is never refused", () => {
  it("a replacement whose fee cap is over twice the Worker's gas price cap is taken: a Base replacement near the cap, a hand run under a higher cap of its own", async () => {
    chains();
    const l = await handLease();
    const req = closeOf(10n ** 18n);
    const raw = await signed(req);
    await call("/v1/journal", { action: "writeAhead", ...l, row: toJson(rowOf(req, raw)) });
    // the Worker's Base cap is 5 gwei: 12.5% over a fee cap near twice it is over twice it
    const data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args } as never);
    const high = await privateKeyToAccount(KEY).signTransaction({ type: "eip1559", chainId: 8453, nonce: 3, to: req.to, value: req.value ?? 0n, data, gas: 300_000n, maxFeePerGas: 11_250_000_000n, maxPriorityFeePerGas: 2n * 10n ** 8n });
    expect(await json(await call("/v1/journal", { action: "replaced", ...l, hash: keccak256(raw), next: { hash: keccak256(high), raw: high } }))).toMatchObject({ ok: true });
    const next = closeOf(10n ** 18n, 4);
    const ahead = await privateKeyToAccount(KEY).signTransaction({ type: "eip1559", chainId: 8453, nonce: 4, to: next.to, value: next.value ?? 0n, data, gas: 300_000n, maxFeePerGas: 30n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n });
    expect(await json(await call("/v1/journal", { action: "writeAhead", ...l, row: toJson(rowOf(next, ahead)) }))).toMatchObject({ ok: true });
  });
});

describe("the journal's routes serve no signed transaction (the re-review's N5)", () => {
  it("since and pending give each raw without its signature (no node would take it), which the spend cap reads the same; the first transaction a replacement keeps is never served", async () => {
    chains();
    const l = await handLease();
    const req = closeOf(10n ** 18n);
    const raw = await signed(req);
    await call("/v1/journal", { action: "writeAhead", ...l, row: toJson(rowOf(req, raw)) });
    await call("/v1/journal", { action: "update", ...l, patch: toJson([{ hash: keccak256(raw), patch: { status: "sent" } }]) });
    const cancel = await cancelOf(3);
    await call("/v1/journal", { action: "replaced", ...l, hash: keccak256(raw), next: { hash: keccak256(cancel), raw: cancel } });
    const stored = await rows();
    for (const action of ["since", "pending"]) {
      const out = fromJson<(JournalRow & { requestRaw?: unknown })[]>((await json(await call("/v1/journal", { action, sinceMs: 0 }))).rows as string);
      expect(out, action).toHaveLength(1);
      const [served] = out;
      const tx = parseTransaction(served.raw);
      expect([tx.r, tx.s, served.requestRaw], action).toEqual([undefined, undefined, undefined]);
      await expect(recoverTransactionAddress({ serializedTransaction: served.raw as never })).rejects.toThrow();
      expect([tx.gas, tx.maxFeePerGas, tx.nonce, tx.to?.toLowerCase()], action).toEqual([21_000n, 3n * 10n ** 9n, 3, ME.toLowerCase()]);
      expect(spentOf(served), action).toBe(spentOf(stored[0]));
      expect(spentOf(served), action).toBeGreaterThan(0n);
    }
  });
});

describe("the Worker adopts and replaces only what a row's own raw proves", () => {
  it("a row in the journal whose raw is not its request is never watched: said loudly, and marked dropped", async () => {
    const c = chains((w) => {
      w.door.canClose = false;
    });
    await started();
    const req = closeOf(10n ** 18n);
    const raw = await signed(closeOf(4n * 10n ** 18n));
    // written into the object directly (past the route), as a row that got in some other way
    const s = coordinator();
    const a = await s.acquire({ holder: "hand:x", kind: "hand", ttlMs: 60_000 });
    if (!a.granted) throw new Error("no lease");
    await s.writeAhead({ holder: "hand:x", token: a.token, row: toJson(rowOf(req, raw, { status: "sent", at: 0 })) });
    await s.release({ holder: "hand:x", token: a.token });
    const r = await keeperRun(testEnv, { print: () => undefined });
    expect(r.lines.some((l) => l.startsWith("JOURNAL ROW REFUSED: close batch 7") && l.includes("its signed transaction is not its request signed by the keeper"))).toBe(true);
    expect(r.lines.some((l) => l.startsWith("Settling: "))).toBe(false);
    expect((await rows())[0].status).toBe("dropped");
    expect(c.w.sends).toEqual([]);
  });

  it("a pooled transaction that isn't the row's request is never replaced", async () => {
    const c = chains((w) => {
      w.door.canClose = false;
      w.fate = () => "hold";
    });
    await started();
    // a keeper transaction pending at nonce 3 with a call of its own (sent by a hand run without the lease, say)
    const pendingReq = closeOf(8n * 10n ** 18n);
    const pending = await signed(pendingReq);
    await c.fetch("https://base.rpc.test/x", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [pending] }) });
    expect(c.w.sends).toHaveLength(1);
    // a row whose own raw proves its request, its hashes naming that pending transaction too, overdue for a replacement
    const req = closeOf(10n ** 18n);
    const raw = await signed(req);
    const s = coordinator();
    const a = await s.acquire({ holder: "hand:x", kind: "hand", ttlMs: 60_000 });
    if (!a.granted) throw new Error("no lease");
    await s.writeAhead({ holder: "hand:x", token: a.token, row: toJson(rowOf(req, raw, { status: "sent", at: 0, hashes: [keccak256(pending), keccak256(raw)] })) });
    await s.release({ holder: "hand:x", token: a.token });
    // the row's time is the object's, not the 0 written (the re-review's N2): the run comes once its replacement is due
    // (two hashes: twice REPLACE_AFTER_MS after it was written)
    const r = await keeperRun(testEnv, { print: () => undefined, now: () => Date.now() + 2 * REPLACE_AFTER_MS + 60_000 });
    expect(r.lines.some((l) => l.startsWith("Settling: close batch 7"))).toBe(true);
    expect(r.lines.some((l) => l.startsWith("Not replaced: ") && l.includes("is not close batch 7 and send it to Bittensor (its call differs): it is never replaced"))).toBe(true);
    expect(c.w.sends).toHaveLength(1);
  });
});
