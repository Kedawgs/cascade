import {
  type Address,
  encodeErrorResult,
  type Hex,
  keccak256,
  numberToHex,
  parseAbi,
  parseTransaction,
  serializeTransaction,
  type TransactionSerializable,
} from "viem";
import { addHotkeyRequest, adoptRequest, MIN_READ_GAS_FLOOR, REEXEC_GAS_FLOOR, REMOVE_HOTKEY_GAS_FLOOR, removeHotkeyRequest, stakeRequest } from "../src/keeper/core/v32/requests.ts";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { paths, targets } from "../src/config.ts";
import { castSigner } from "../src/keeper/cast-signer.ts";
import { type JournalRow, memoryJournal, spentOf, spentOn } from "../src/keeper/core/journal.ts";
import { replaceRaw, type SendCtx, type Signer, sendRaw, settlePending, signedCallProblem } from "../src/keeper/core/send.ts";
import { BITTENSOR_TX_GAS_CEILING } from "../src/keeper/core/ceiling.ts";
import { type Rpc, RpcError } from "../src/rpc.ts";
import { type Ctx, ReceiptTimeout, RevertedOnChain, SendRefused } from "../src/send.ts";
import type { CallRequest } from "../src/types.ts";

// The core's raw send path (core/send.ts) on a fake chain, with throwaway keys made in the test (no real key, no
// network): the nonce guard, the caps, the signer's check, the write-ahead, the receipt, and the replacement.

const DOOR: Address = "0x00000000000000000000000000000000000d00e5";
const ABI = parseAbi(["function closeBatch(uint64 expectedId, uint256 minValue) payable", "error WrongBatch(uint64 openId)"]);
const REQ: CallRequest = { chain: "base", nonce: 7, label: "close batch 8", to: DOOR, abi: ABI, functionName: "closeBatch", args: [8n, 10n ** 18n], value: 10n ** 15n };

const testSigner = (key = generatePrivateKey()): Signer & { key: Hex } => {
  const a = privateKeyToAccount(key);
  return { key, address: a.address, signTransaction: (tx) => a.signTransaction(tx) };
};

interface Chain {
  /** eth_chainId's answer (Base's by default; 964 for a Bittensor request) */
  id?: number;
  pending: number;
  mined: number;
  gasPrice: bigint;
  tip: bigint;
  estimate: bigint | Error;
  receipt: "ok" | "reverted" | null;
  broadcast?: Error;
  known?: boolean;
}

/** A fake Base: what it answers, and what was asked of it (every raw transaction broadcast, with the journal's rows as
 * they stood at that moment). */
function chain(over: Partial<Chain> = {}, journal = memoryJournal()) {
  const c: Chain = { pending: 7, mined: 7, gasPrice: 10n ** 9n, tip: 10n ** 8n, estimate: 100_000n, receipt: "ok", ...over };
  const broadcasts: { raw: Hex; rows: JournalRow[] }[] = [];
  const asked: string[] = [];
  const pool = new Map<Hex, { from: Address; nonce: Hex; blockNumber: null; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex }>();
  const rpc: Rpc = {
    async request(_chain, method, params) {
      asked.push(method);
      switch (method) {
        case "eth_chainId":
          return numberToHex(c.id ?? 8453);
        case "eth_getTransactionCount":
          return numberToHex(params[1] === "pending" ? c.pending : c.mined);
        case "eth_estimateGas":
          if (c.estimate instanceof Error) throw c.estimate;
          return numberToHex(c.estimate);
        case "eth_gasPrice":
          return numberToHex(c.gasPrice);
        case "eth_blockNumber":
          return "0x10";
        case "eth_maxPriorityFeePerGas":
          return numberToHex(c.tip);
        case "eth_sendRawTransaction": {
          const raw = params[0] as Hex;
          broadcasts.push({ raw, rows: journal.rows.map((r) => ({ ...r })) });
          if (c.broadcast) throw c.broadcast;
          return keccak256(raw);
        }
        case "eth_getTransactionByHash":
          if (c.known !== undefined) return c.known ? { from: DOOR, nonce: numberToHex(7), blockNumber: null } : null;
          return pool.get(params[0] as Hex) ?? null;
        case "eth_getTransactionReceipt":
          if (c.receipt === null) return null;
          return { status: c.receipt === "ok" ? "0x1" : "0x0", blockNumber: "0x10", gasUsed: numberToHex(90_000n), effectiveGasPrice: numberToHex(c.gasPrice), logs: [] };
        case "eth_call":
          // the replay of a reverted close: the batch moved on
          throw new RpcError("execution reverted", 3, encodeErrorResult({ abi: ABI, errorName: "WrongBatch", args: [9n] }));
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const ctx: SendCtx = {
    rpc,
    chains: { base: { chainId: 8453, legacy: false }, bittensor: { chainId: 964, legacy: true } },
    maxGasPrice: { base: 5n * 10n ** 9n },
    receiptTimeoutMs: 0,
    pollMs: 0,
    errors: ABI,
    journal,
    log: () => undefined,
    now: () => 1_000,
    sleep: async () => undefined,
    // the rails (v3.2's, at the send path) are tested in keeper-v32-rails.test.ts: here they allow every send
    railsCheck: async () => undefined,
  };
  return { ctx, c, journal, broadcasts, asked, pool };
}

describe("the core's raw send path", () => {
  it("signs the call, writes it ahead to the journal, then broadcasts it and records its receipt", async () => {
    const w = chain();
    const signer = testSigner();
    const sent = await sendRaw(w.ctx, signer, REQ);
    expect(w.broadcasts).toHaveLength(1);
    const { raw, rows } = w.broadcasts[0];
    // the row was there, signed and not yet sent, before the node saw the transaction
    expect(rows).toEqual([expect.objectContaining({ chain: "base", from: signer.address, nonce: 7, hashes: [keccak256(raw)], raw, status: "signed", at: 1_000 })]);
    expect(sent.hash).toBe(keccak256(raw));
    expect(w.journal.rows[0]).toMatchObject({ status: "landed", receipt: { hash: sent.hash, block: 16, gasUsed: 90_000n, costWei: 90_000n * 10n ** 9n } });
    // the transaction is the call: to the front door, its value, its data, a 1.25× gas limit, fee cap twice the price
    const tx = parseTransaction(raw);
    expect(tx).toMatchObject({ type: "eip1559", chainId: 8453, nonce: 7, to: DOOR, value: 10n ** 15n, gas: 125_000n, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n });
  });

  it("the payout gas rule: the estimate plus gasAbove; an exact gasLimit refuses an estimate above it", async () => {
    const w = chain();
    await sendRaw(w.ctx, testSigner(), { ...REQ, gasAbove: 2_800_000n });
    expect(parseTransaction(w.broadcasts[0].raw).gas).toBe(2_900_000n);
    const v = chain();
    await expect(sendRaw(v.ctx, testSigner(), { ...REQ, gasLimit: 99_999n })).rejects.toThrow(SendRefused);
    expect(v.broadcasts).toEqual([]);
  });

  it("a gas floor: at least the estimate plus gasFloor (a caught inner call the estimator starved), else 1.25× the estimate", async () => {
    const w = chain();
    await sendRaw(w.ctx, testSigner(), { ...REQ, gasFloor: 400_000n });
    expect(parseTransaction(w.broadcasts[0].raw).gas).toBe(500_000n);
    const v = chain();
    await sendRaw(v.ctx, testSigner(), { ...REQ, gasFloor: 10_000n });
    expect(parseTransaction(v.broadcasts[0].raw).gas).toBe(125_000n);
  });

  it("the keeper's Bittensor calls that catch an inner call's failure carry a floor; the payout and park sends their own, the claim its fixed limit", () => {
    const rec = { plan: { addresses: { vault: DOOR, frontDoor: DOOR } } } as never;
    const h = `0x${"11".repeat(32)}` as const;
    expect(addHotkeyRequest(rec, h, 0).gasFloor).toBe(MIN_READ_GAS_FLOOR);
    expect(removeHotkeyRequest(rec, h, 0).gasFloor).toBe(REMOVE_HOTKEY_GAS_FLOOR);
    expect(stakeRequest(rec, 0).gasFloor).toBe(MIN_READ_GAS_FLOOR);
    expect(adoptRequest(rec, 0).gasFloor).toBe(MIN_READ_GAS_FLOOR);
    expect([MIN_READ_GAS_FLOOR, REMOVE_HOTKEY_GAS_FLOOR, REEXEC_GAS_FLOOR]).toEqual([400_000n, 1_000_000n, 1_000_000n]);
  });

  it("the nonce guard: nothing is signed while an earlier transaction is pending, or at another nonce", async () => {
    for (const [over, reason] of [
      [{ pending: 8, mined: 7 }, "waiting"],
      [{ pending: 8, mined: 8 }, "nonce"],
    ] as const) {
      const w = chain(over);
      const e = await sendRaw(w.ctx, testSigner(), REQ).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(SendRefused);
      expect((e as SendRefused).reason).toBe(reason);
      expect(w.asked).not.toContain("eth_estimateGas");
      expect(w.journal.rows).toEqual([]);
    }
  });

  it("an RPC on another chain is refused before anything is read", async () => {
    const w = chain();
    w.ctx.chains.base.chainId = 1;
    await expect(sendRaw(w.ctx, testSigner(), REQ)).rejects.toMatchObject({ reason: "chain-id" });
    expect(w.journal.rows).toEqual([]);
  });

  it("a simulation that reverts refuses the send, naming the error; a gas price over the cap waits", async () => {
    const w = chain({ estimate: new RpcError("execution reverted", 3, encodeErrorResult({ abi: ABI, errorName: "WrongBatch", args: [9n] })) });
    await expect(sendRaw(w.ctx, testSigner(), REQ)).rejects.toThrow(/close batch 8 would fail, nothing sent \(WrongBatch\(9\)\)/);
    const v = chain({ gasPrice: 6n * 10n ** 9n });
    await expect(sendRaw(v.ctx, testSigner(), REQ)).rejects.toMatchObject({ reason: "fee" });
    const t = chain({ tip: 2n * 10n ** 9n });
    await expect(sendRaw(t.ctx, testSigner(), REQ)).rejects.toMatchObject({ reason: "fee" });
    for (const x of [w, v, t]) expect(x.broadcasts).toEqual([]);
  });

  it("a signer that signs as another account, or signs something else, sends nothing", async () => {
    const other = testSigner();
    const liar: Signer = { address: testSigner().address, signTransaction: other.signTransaction };
    const w = chain();
    await expect(sendRaw(w.ctx, liar, REQ)).rejects.toThrow(/it recovers to/);
    const a = privateKeyToAccount(generatePrivateKey());
    const swapper: Signer = { address: a.address, signTransaction: (tx) => a.signTransaction({ ...tx, value: 10n ** 18n } as TransactionSerializable) };
    const v = chain();
    await expect(sendRaw(v.ctx, swapper, REQ)).rejects.toThrow(/its value is 1000000000000000000, not 1000000000000000/);
    for (const x of [w, v]) {
      expect(x.broadcasts).toEqual([]);
      expect(x.journal.rows).toEqual([]);
    }
  });

  it("a revert on chain is named by its replay, and journaled", async () => {
    const w = chain({ receipt: "reverted" });
    const e = await sendRaw(w.ctx, testSigner(), REQ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RevertedOnChain);
    expect((e as RevertedOnChain).reason).toBe("WrongBatch(9)");
    expect(w.journal.rows[0].status).toBe("reverted");
  });

  it("no receipt in time: ReceiptTimeout with the hash and the call, and the row stays sent for the next run", async () => {
    const w = chain({ receipt: null });
    const e = (await sendRaw(w.ctx, testSigner(), REQ).catch((x: unknown) => x)) as ReceiptTimeout;
    expect(e).toBeInstanceOf(ReceiptTimeout);
    expect(e.hash).toBe(keccak256(w.broadcasts[0].raw));
    expect(e.request).toBe(REQ);
    expect(await w.journal.pending()).toEqual([expect.objectContaining({ status: "sent", hashes: [e.hash] })]);
  });

  it("a broadcast no node took, its nonce still free, was never sent: the row says so", async () => {
    const w = chain({ broadcast: new Error("connection reset"), known: false });
    await expect(sendRaw(w.ctx, testSigner(), REQ)).rejects.toThrow(/was not sent, as far as the node says/);
    expect(w.journal.rows[0].status).toBe("never-sent");
    // the node took it after all (its answer lost on the way back): a send, watched by its hash
    const v = chain({ broadcast: new Error("timeout"), receipt: null, known: true });
    await expect(sendRaw(v.ctx, testSigner(), REQ)).rejects.toThrow(ReceiptTimeout);
    expect(v.journal.rows[0].status).toBe("sent");
  });

  it("a replacement re-signs the same call at the nonce with 12.5% more, journaled before it goes; a call that would fail is cancelled", async () => {
    const signer = testSigner();
    const w = chain({ pending: 8, mined: 7 });
    const first = await signer.signTransaction({ type: "eip1559", chainId: 8453, nonce: 7, to: DOOR, gas: 125_000n, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n, value: 10n ** 15n });
    const h0 = keccak256(first);
    await w.journal.writeAhead({ chain: "base", from: signer.address, nonce: 7, hashes: [h0], request: REQ, raw: first, status: "sent", at: 0 });
    w.pool.set(h0, { from: signer.address, nonce: numberToHex(7), blockNumber: null, maxFeePerGas: numberToHex(2n * 10n ** 9n), maxPriorityFeePerGas: numberToHex(10n ** 8n) });
    const r = await replaceRaw(w.ctx, signer, REQ, [h0]);
    expect(r).toMatchObject({ replaced: true, cancelled: false });
    const tx = parseTransaction(w.broadcasts[0].raw);
    expect(tx).toMatchObject({ nonce: 7, to: DOOR, value: 10n ** 15n, maxFeePerGas: 2_250_000_000n, maxPriorityFeePerGas: 112_500_000n });
    expect(w.broadcasts[0].rows[0].hashes).toEqual([h0, keccak256(w.broadcasts[0].raw)]);

    const v = chain({ pending: 8, mined: 7, estimate: new RpcError("execution reverted", 3, encodeErrorResult({ abi: ABI, errorName: "WrongBatch", args: [9n] })) });
    await v.journal.writeAhead({ chain: "base", from: signer.address, nonce: 7, hashes: [h0], request: REQ, raw: first, status: "sent", at: 0 });
    v.pool.set(h0, { from: signer.address, nonce: numberToHex(7), blockNumber: null, maxFeePerGas: numberToHex(2n * 10n ** 9n), maxPriorityFeePerGas: numberToHex(10n ** 8n) });
    const c = await replaceRaw(v.ctx, signer, REQ, [h0]);
    expect(c).toMatchObject({ replaced: true, cancelled: true });
    const cancel = parseTransaction(v.broadcasts[0].raw);
    expect(cancel).toMatchObject({ nonce: 7, to: signer.address.toLowerCase(), gas: 21_000n });
    expect(cancel.value ?? 0n).toBe(0n);
    expect(v.journal.rows[0].status).toBe("cancelled");

    // nothing in the pool: nothing replaced, nothing signed
    const u = chain({ pending: 8, mined: 7 });
    expect(await replaceRaw(u.ctx, signer, REQ, [h0])).toMatchObject({ replaced: false });
    expect(u.broadcasts).toEqual([]);
  });
});

describe("Task 65: Bittensor's per-transaction ceiling, the spend cap's worst case before a send, and each claim's and payout's gas used", () => {
  const VAULT: Address = "0x00000000000000000000000000000000000a017e";
  const VAULT_ABI = parseAbi(["function claimRewards(bytes32 hotkey)", "function processPayouts(bytes32 key, (address user, uint256 amount)[] list, uint32 maxEntries) payable", "function stakeIdle()"]);
  const HK = `0x${"11".repeat(32)}` as Hex;
  const claim = (gasLimit: bigint): CallRequest => ({ chain: "bittensor", nonce: 7, label: "claim the vault's rewards on hotkey 0x11111111…", to: VAULT, abi: VAULT_ABI, functionName: "claimRewards", args: [HK], gasLimit });
  const stake: CallRequest = { chain: "bittensor", nonce: 7, label: "stake the vault's idle TAO", to: VAULT, abi: VAULT_ABI, functionName: "stakeIdle", args: [] };
  const payout: CallRequest = { chain: "bittensor", nonce: 7, label: "pay out batch 0xabababab… to Base", to: VAULT, abi: VAULT_ABI, functionName: "processPayouts", args: [`0x${"ab".repeat(32)}`, [], 50], gasAbove: 3_000_000n };
  const bittensor = (over: Partial<Chain> = {}) => chain({ id: 964, gasPrice: 5n * 10n ** 9n, ...over });

  it("no Bittensor transaction goes above the ceiling (64,900,000): a fixed limit or a scaled estimate above it is refused, nothing signed; Base has no such ceiling", async () => {
    expect(BITTENSOR_TX_GAS_CEILING).toBe(64_900_000n);
    const ok = bittensor();
    await sendRaw(ok.ctx, testSigner(), claim(64_900_000n));
    expect(parseTransaction(ok.broadcasts[0].raw).gas).toBe(64_900_000n);
    const over = bittensor();
    await expect(sendRaw(over.ctx, testSigner(), claim(64_900_001n))).rejects.toThrow(
      /^Bittensor: claim the vault's rewards on hotkey 0x11111111… would go with a 64,900,001 gas limit, above Bittensor's per-transaction ceiling of 64,900,000 \(its pool refuses more\); nothing sent$/,
    );
    // 1.25 × an estimate of 52,000,000 is 65,000,000
    const scaled = bittensor({ estimate: 52_000_000n });
    const e = await sendRaw(scaled.ctx, testSigner(), stake).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SendRefused);
    expect((e as SendRefused).reason).toBe("estimate");
    for (const x of [over, scaled]) {
      expect(x.broadcasts).toEqual([]);
      expect(x.journal.rows).toEqual([]);
    }
    const base = chain({ estimate: 52_000_000n });
    base.ctx.maxGasPrice = undefined;
    await sendRaw(base.ctx, testSigner(), REQ);
    expect(parseTransaction(base.broadcasts[0].raw).gas).toBe(65_000_000n);
  });

  it("the spend cap refuses a send whose worst case (its gas limit at its fee cap) would cross what is left of the cap, then charges only what the receipt says it cost", async () => {
    // a stake: 125,000 gas (1.25 × 100,000) at 5 gwei, 0.000625 TAO at most; the receipt: 90,000 gas at 5 gwei
    const worst = 125_000n * 5n * 10n ** 9n;
    const tight = bittensor();
    tight.ctx.spendCap = { bittensor: worst - 1n };
    const e = await sendRaw(tight.ctx, testSigner(), stake).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SendRefused);
    expect((e as SendRefused).reason).toBe("spend-cap");
    expect((e as Error).message).toBe(
      "Bittensor: stake the vault's idle TAO could cost up to 0.000625 TAO (a 125,000 gas limit at 5 gwei), and the keeper has sent 0 TAO in the last 24 hours: that would cross its 0.000624999999999999 TAO cap; nothing sent",
    );
    expect(tight.broadcasts).toEqual([]);
    expect(tight.journal.rows).toEqual([]);
    // exactly the cap: it goes, and the row is charged its actual cost, never the limit
    const w = bittensor();
    w.ctx.spendCap = { bittensor: worst };
    await sendRaw(w.ctx, testSigner(), stake);
    expect(w.broadcasts).toHaveLength(1);
    expect(spentOf(w.journal.rows[0])).toBe(90_000n * 5n * 10n ** 9n);
    expect(spentOn(w.journal.rows, "bittensor", 1_000)).toBe(90_000n * 5n * 10n ** 9n);
    // the next stake: 0.00045 spent and 0.000625 at most is 0.001075; a cap of 0.001 refuses it, 0.001075 lets it go
    w.c.pending = 8;
    w.c.mined = 8;
    w.ctx.spendCap = { bittensor: 10n ** 15n };
    await expect(sendRaw(w.ctx, testSigner(), { ...stake, nonce: 8 })).rejects.toMatchObject({ reason: "spend-cap" });
    w.ctx.spendCap = { bittensor: 90_000n * 5n * 10n ** 9n + worst };
    await sendRaw(w.ctx, testSigner(), { ...stake, nonce: 8 });
    expect(w.broadcasts).toHaveLength(2);
  });

  it("each claim's and each payout's gas used is logged beside its limit, one line each (GAS USED), mined or reverted; other sends are not", async () => {
    const lines: string[] = [];
    const w = bittensor();
    w.ctx.log = (l) => lines.push(l);
    const sent = await sendRaw(w.ctx, testSigner(), claim(57_000_000n));
    await sendRaw({ ...w.ctx, journal: memoryJournal() }, testSigner(), payout);
    await sendRaw({ ...w.ctx, journal: memoryJournal() }, testSigner(), stake);
    const v = bittensor({ receipt: "reverted" });
    v.ctx.log = (l) => lines.push(l);
    const reverted = await sendRaw(v.ctx, testSigner(), claim(57_000_000n)).catch((x: unknown) => x);
    expect(reverted).toBeInstanceOf(RevertedOnChain);
    expect(lines.filter((l) => l.startsWith("GAS USED"))).toEqual([
      `GAS USED: Bittensor: claim the vault's rewards on hotkey 0x11111111…: 90,000 of its 57,000,000 gas limit (0.2%); transaction ${sent.hash}`,
      expect.stringMatching(/^GAS USED: Bittensor: pay out batch 0xabababab… to Base: 90,000 of its 3,100,000 gas limit \(2\.9%\); transaction 0x[0-9a-f]{64}$/),
      expect.stringMatching(/^GAS USED: Bittensor: claim the vault's rewards on hotkey 0x11111111…: 90,000 of its 57,000,000 gas limit \(0\.2%\), reverted; transaction 0x[0-9a-f]{64}$/),
    ]);
  });

  it("a receipt found later (the next run's settling) logs its GAS USED line once too", async () => {
    const lines: string[] = [];
    const w = bittensor({ receipt: null });
    w.ctx.log = (l) => lines.push(l);
    await expect(sendRaw(w.ctx, testSigner(), payout)).rejects.toThrow(ReceiptTimeout);
    expect(lines.filter((l) => l.startsWith("GAS USED"))).toEqual([]);
    w.c.receipt = "ok";
    w.c.mined = 8;
    await settlePending(w.ctx);
    await settlePending(w.ctx);
    expect(w.journal.rows[0].status).toBe("landed");
    expect(lines.filter((l) => l.startsWith("GAS USED"))).toEqual([`GAS USED: Bittensor: pay out batch 0xabababab… to Base: 90,000 of its 3,100,000 gas limit (2.9%); transaction ${w.journal.rows[0].hashes[0]}`]);
  });
});

describe("R12a: the spend cap's check of a send counts the value it keeps, as its mined row will", () => {
  // a full 50 + 50 batch's close: a 0.004 ETH quote, sent with a float of three quotes, of which the door sends back what
  // the fee leaves; its gas at most 125,000 (1.25 × 100,000) at a 2 gwei fee cap (twice the 1 gwei price), 0.00025 ETH
  const QUOTE = 4n * 10n ** 15n;
  const WORST_GAS = 125_000n * 2n * 10n ** 9n;
  const close: CallRequest = { ...REQ, value: 3n * QUOTE, valueKept: QUOTE };
  /** A journal whose 24 hours hold `wei` already spent on Base (a landed send's gas). */
  const spent = (wei: bigint) => {
    const j = memoryJournal();
    j.rows.push({ chain: "base", from: DOOR, nonce: 1, hashes: [`0x${"01".repeat(32)}`], request: { ...REQ, value: 0n }, raw: "0x", status: "landed", at: 500, receipt: { hash: `0x${"01".repeat(32)}`, block: 1, gasUsed: 1n, costWei: wei } });
    return j;
  };

  it("a close is refused when its gas and its quoted fee would cross what is left of the cap, nothing signed (the T61a carry left its value out)", async () => {
    const cap = 10n ** 16n;
    const w = chain({}, spent(cap - WORST_GAS - QUOTE + 1n));
    w.ctx.spendCap = { base: cap };
    const e = await sendRaw(w.ctx, testSigner(), close).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SendRefused);
    expect((e as SendRefused).reason).toBe("spend-cap");
    expect((e as Error).message).toBe(
      "Base: close batch 8 could cost up to 0.00425 ETH (a 125,000 gas limit at 2 gwei, and the 0.004 ETH of its 0.012 ETH value it keeps), and the keeper has sent 0.005750000000000001 ETH in the last 24 hours: that would cross its 0.01 ETH cap; nothing sent",
    );
    expect(w.broadcasts).toEqual([]);
  });

  it("only the part of a close's float it keeps counts: at exactly the cap it goes, though gas and the whole float are well over it", async () => {
    const cap = 10n ** 16n;
    const w = chain({}, spent(cap - WORST_GAS - QUOTE));
    w.ctx.spendCap = { base: cap };
    expect(cap - WORST_GAS - QUOTE + WORST_GAS + 3n * QUOTE).toBeGreaterThan(cap);
    await sendRaw(w.ctx, testSigner(), close);
    expect(w.broadcasts).toHaveLength(1);
    expect(parseTransaction(w.broadcasts[0].raw).value).toBe(3n * QUOTE);
    // the row as written ahead counts the whole float until its receipt says what came back (journal.ts spentOf)
    expect(w.broadcasts[0].rows.at(-1)?.request.valueKept).toBe(QUOTE);
  });

  it("a send that keeps its whole value (a payout's top-up) counts all of it", async () => {
    const VAULT: Address = "0x00000000000000000000000000000000000a017e";
    const abi = parseAbi(["function processPayouts(bytes32 key, (address user, uint256 amount)[] list, uint32 maxEntries) payable"]);
    const topUp = 10n ** 15n;
    const payout: CallRequest = { chain: "bittensor", nonce: 7, label: "pay out batch 0xabababab… to Base", to: VAULT, abi, functionName: "processPayouts", args: [`0x${"ab".repeat(32)}`, [], 50], value: topUp };
    // 125,000 gas at Bittensor's 5 gwei (legacy: the price itself), and the 0.001 TAO top-up
    const worst = 125_000n * 5n * 10n ** 9n + topUp;
    const tight = chain({ id: 964, gasPrice: 5n * 10n ** 9n });
    tight.ctx.spendCap = { bittensor: worst - 1n };
    await expect(sendRaw(tight.ctx, testSigner(), payout)).rejects.toMatchObject({ reason: "spend-cap" });
    expect(tight.broadcasts).toEqual([]);
    const fits = chain({ id: 964, gasPrice: 5n * 10n ** 9n });
    fits.ctx.spendCap = { bittensor: worst };
    await sendRaw(fits.ctx, testSigner(), payout);
    expect(fits.broadcasts).toHaveLength(1);
  });
});

describe("the PC's signer: the cast keystore", () => {
  const ctxWith = (answer: (args: string[]) => { code: number; stdout: string; stderr: string }, address: Address) =>
    ({
      runner: { run: async (_f: string, args: string[]) => answer(args) },
      paths: paths({}),
      targets: targets({}).live,
      signer: { address, keystore: "k.json", passwordFile: "p.txt", name: "the keeper" },
    }) as unknown as Ctx;
  const TX: TransactionSerializable = { type: "eip1559", chainId: 8453, nonce: 7, to: DOOR, gas: 125_000n, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n, value: 1n, data: "0x" };

  it("signs the transaction's hash with the keystore (by path) and returns the signed transaction, which the core accepts", async () => {
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    const seen: string[][] = [];
    const ctx = ctxWith((args) => {
      seen.push(args);
      return { code: 0, stdout: "", stderr: "" };
    }, address);
    // the runner signs the digest it is given, as cast would
    ctx.runner.run = async (_f, args) => {
      seen.push(args);
      return { code: 0, stdout: await sign({ hash: args[3] as Hex, privateKey: key, to: "hex" }), stderr: "" };
    };
    const raw = await castSigner(ctx).signTransaction(TX);
    expect(seen[0]).toEqual(["wallet", "sign", "--no-hash", keccak256(serializeTransaction(TX)), "--keystore", "k.json", "--password-file", "p.txt"]);
    expect(await signedCallProblem(TX, raw, address)).toBeNull();
  });

  it("a keystore that signs as another account, or doesn't sign, is refused", async () => {
    const address = privateKeyToAccount(generatePrivateKey()).address;
    const other = generatePrivateKey();
    const wrong = ctxWith(() => ({ code: 0, stdout: "", stderr: "" }), address);
    wrong.runner.run = async (_f, args) => ({ code: 0, stdout: await sign({ hash: args[3] as Hex, privateKey: other, to: "hex" }), stderr: "" });
    await expect(castSigner(wrong).signTransaction(TX)).rejects.toThrow(/the keystore signed as 0x[0-9a-fA-F]{40}, not the keeper/);
    const none = ctxWith(() => ({ code: 1, stdout: "", stderr: "Error: wrong password" }), address);
    await expect(castSigner(none).signTransaction(TX)).rejects.toThrow(/the keeper's keystore did not sign \(Error: wrong password\)/);
  });
});
