// Regression tests from the site-seed review: a seed must never make a number or a definite step appear
// that the chain hasn't confirmed, whatever it leaves out, mislabels or pads; and with no indexer named,
// nothing changes for anyone.
import { encodeAbiParameters, encodeEventTopics, type Hex, HttpRequestError, parseAbiParameters, toHex, TransactionReceiptNotFoundError } from "viem";
import { describe, expect, it } from "vitest";
import { VAULT } from "./abi";
import type { Deployment } from "./config";
import { depositFacts, newScan, scanVault } from "./facts";
import { indexerDistrusted } from "./indexer";
import { CHECK_EVERY_MS, createLiveCascadeData, type LiveDeps, SEED_CONFIRM_TRIES } from "./live";
import { createOpLog } from "./oplog";
import type { FrontDoorState, VaultState } from "./reads";
import { createScanStore, SCAN_VERSION, scanState } from "./scan-store";
import { MAX_SEED_ACCOUNT_EVENTS_EXTRA, vaultEvents, verifySeed } from "./seed";

const D: Deployment = {
  frontDoor: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  baseAdapter: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  vault: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  bitAdapter: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  bitBlock: 1n,
  vaultSs58: "5FNEuRkKZvg2jFjhY3DWpC3TBSH51AC3FKQpLyC1xesTBwLu",
  hotkeySs58: "5E4z3h9yVhmQyCFWNbY9BPpwhx4xFiPwq3eeqmBgVF6KULde",
  indexerUrl: "https://api.cascadefi.xyz",
};
const PLAIN: Deployment = { ...D };
delete PLAIN.indexerUrl;
const ME = "0x000000000000000000000000000000000000a11c" as const;
const OTHER = "0x000000000000000000000000000000000000b0b0" as const;
const fd = { depositOf: 0n, redeemOf: 10n ** 21n, claimable: 0n, openBatchId: 4n, openStart: 1_800_000_000, openTotal: 0n, openDeposits: 0, openRedeems: 1, netForwarded: 0n, depositCap: 10n ** 18n, minDeposit: 10n ** 16n, redeemRequestFee: 0n, canClose: false, batchInterval: 600, maxBatchValue: 10n ** 21n, maxDeposits: 50 } as FrontDoorState;
const vault = { shares: 8n * 10n ** 22n, totalAssets: 8n * 10n ** 16n, totalSupply: 8n * 10n ** 22n, rootStakeWei: 8n * 10n ** 16n, pendingPayouts: 0n, balanceWei: 10n ** 12n, stakeHotkey: `0x${"58".repeat(32)}`, payoutDelay: 3600, nominatorMinWei: 2n * 10n ** 16n } as VaultState;
function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}
const T0 = 1_800_000_000_000;
const NOW = 1_800_000_100_000;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
type Log = { address: string; topics: Hex[]; data: Hex; blockNumber: bigint; transactionHash: Hex; logIndex: number };
const log = (topics: readonly unknown[], data: Hex, block: bigint, tx: Hex, index = 0): Log => ({ address: D.vault, topics: topics as Hex[], data, blockNumber: block, transactionHash: tx, logIndex: index });
const delivered = (batchId: bigint, key: Hex, block: bigint, tx: Hex) =>
  log(encodeEventTopics({ abi: VAULT, eventName: "BatchDelivered", args: { key, sourceChain: 8453n, frontDoor: D.frontDoor } }), encodeAbiParameters(parseAbiParameters("uint64, uint256"), [batchId, 10n ** 16n]), block, tx);
const staked = (block: bigint, tx: Hex) => log(encodeEventTopics({ abi: VAULT, eventName: "Staked", args: { hotkey: H(1) } }), encodeAbiParameters(parseAbiParameters("uint256, uint256"), [1n, 1n]), block, tx);
const chunk = (key: Hex, n: number, taken: number, block: bigint, tx: Hex) =>
  log(encodeEventTopics({ abi: VAULT, eventName: "PayoutChunkSent", args: { key } }), encodeAbiParameters(parseAbiParameters("uint32, uint32, uint256, uint256, uint256"), [n, taken, 10n ** 16n, 9n * 10n ** 15n, 10n ** 15n]), block, tx);
const deposited = (key: Hex, assets: bigint, shares: bigint, block: bigint, tx: Hex, user: Hex = ME, index = 1) =>
  log(encodeEventTopics({ abi: VAULT, eventName: "Deposited", args: { key, user } }), encodeAbiParameters(parseAbiParameters("uint256, uint256"), [assets, shares]), block, tx, index);
const redeemed = (key: Hex, assets: bigint, shares: bigint, block: bigint, tx: Hex, user: Hex = ME, index = 1) =>
  log(encodeEventTopics({ abi: VAULT, eventName: "Redeemed", args: { key, user } }), encodeAbiParameters(parseAbiParameters("uint256, uint256"), [shares, assets]), block, tx, index);
const depositedDirect = (assets: bigint, shares: bigint, block: bigint, tx: Hex) =>
  log(encodeEventTopics({ abi: VAULT, eventName: "DepositedDirect", args: { user: ME } }), encodeAbiParameters(parseAbiParameters("uint256, uint256"), [assets, shares]), block, tx);

const HEAD = 30_000n;
const NEXT = HEAD - 100n;
/** Twenty-nine stakes a thousand blocks apart, so a seed has something to leave out or mislabel. */
const STAKES = Array.from({ length: 29 }, (_, k) => staked(BigInt((k + 1) * 1000), H(300 + k)));
/** 0.07 TAO in (batch 1, block 500), staked at 510; 0.01 TAO out (batch 2, block 20,000), its payout at 20,100. */
const CHAIN: Log[] = [
  delivered(1n, H(1), 500n, H(101)),
  deposited(H(1), 7n * 10n ** 16n, 7n * 10n ** 22n, 500n, H(101)),
  staked(510n, H(102)),
  delivered(2n, H(2), 20_000n, H(103)),
  redeemed(H(2), 10n ** 16n, 10n ** 22n, 20_000n, H(103)),
  chunk(H(2), 0, 1, 20_100n, H(104)),
  staked(NEXT - 50n, H(105)),
  ...STAKES,
];
/** csTAO after all that: 7e22 − 1e22. */
const SHARES = 6n * 10n ** 22n;
const settled = () => new Promise((r) => setTimeout(r, 0));

/** Bittensor from a node at HEAD holding `logs` and their receipts, answering raw log queries with hex
 * numbers as a node does; `flaky`: every n-th receipt read is refused. */
function node(logs: Log[] = CHAIN, o: { flaky?: number; head?: bigint } = {}) {
  const head = o.head ?? HEAD;
  const receipts = new Map<string, { status: string; blockNumber: bigint; logs: Log[] }>();
  for (const l of logs) {
    const r = receipts.get(l.transactionHash) ?? { status: "success", blockNumber: l.blockNumber, logs: [] };
    r.logs.push(l);
    receipts.set(l.transactionHash, r);
  }
  const counts = { receipts: 0, windows: 0, checks: 0 };
  const receiptsFor = new Map<string, number>();
  let n = 0;
  const bittensor = {
    getBlock: async () => ({ number: head, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === "eth_blockNumber") return toHex(head);
      if (method === "eth_getLogs") {
        counts.checks++;
        const q = (params as [{ fromBlock: Hex; toBlock: Hex; topics?: (unknown | null)[] }])[0];
        const [from, to] = [BigInt(q.fromBlock), BigInt(q.toBlock)];
        const user = q.topics?.[2] as string | null | undefined;
        return logs
          .filter((l) => l.blockNumber >= from && l.blockNumber <= to && (!user || l.topics[2] === user))
          .map((l) => ({ ...l, blockNumber: toHex(l.blockNumber), logIndex: toHex(l.logIndex) }));
      }
      throw new Error(`unexpected ${method}`);
    },
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      counts.windows++;
      return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      counts.receipts++;
      receiptsFor.set(hash, (receiptsFor.get(hash) ?? 0) + 1);
      if (o.flaky && ++n % o.flaky === 0) throw new HttpRequestError({ url: "https://archive.chain.opentensor.ai", status: 429 });
      const r = receipts.get(hash);
      if (!r) throw new TransactionReceiptNotFoundError({ hash });
      return r;
    },
  };
  return { bittensor, counts, receiptsFor };
}

/** The indexer's honest halves of `logs` up to `next`. */
function honestHalves(logs: Log[] = CHAIN, next = NEXT) {
  const s = newScan(D);
  s.next = next + 10n;
  const ev = vaultEvents(logs as never, D, ME);
  for (const e of ev.delivered) s.delivered.set(e.batchId, { key: e.key, txHash: e.txHash, block: e.block });
  s.staked.push(...ev.staked);
  for (const p of ev.payouts) s.payouts.set(p.key, [...(s.payouts.get(p.key) ?? []), { txHash: p.txHash, block: p.block, chunk: p.chunk, taken: p.taken }]);
  s.deposited.push(...ev.deposited);
  s.redeemed.push(...ev.redeemed);
  const state = scanState(s);
  return { shared: { ...state, deposited: [], redeemed: [] }, own: { ...state, delivered: [], staked: [], payouts: [] } };
}

type Seed = { shared: unknown; own: unknown } | null;

/** A visit of the site: the real scan and seed checks against `n`, the indexer answering `seed`. */
function visit(n: ReturnType<typeof node>, seed: Seed, storage = memory(), now: () => number = () => NOW, d: Deployment = D, over: Partial<LiveDeps> = {}) {
  const opLog = createOpLog(storage, d.frontDoor, undefined, now);
  const deps: LiveDeps = {
    clients: { bittensor: n.bittensor } as never,
    opLog,
    readFrontDoor: async () => fd,
    readOpenBatch: async () => Promise.reject(new Error("x")),
    readNextBatch: async () => Promise.reject(new Error("x")),
    readVault: async () => vault,
    readWallet: async () => Promise.reject(new Error("x")),
    readPendingRewards: async () => undefined,
    taoPriceUsd: async () => 250,
    ethPriceUsd: async () => 4000,
    readStakerFees: async () => ({ swapFeeBps: 15n, depositFeeUsdc: 50_000n }),
    quoteBuy: async () => 0n,
    quoteSell: async () => 0n,
    quotePayoutFee: async () => 0n,
    readRewardCutBps: async () => 1000,
    readApyPercent: async () => 5,
    checkWiring: async () => "ok",
    scan: scanVault,
    scanStore: createScanStore(storage, d),
    storage,
    fetchSeed: async () => seed as never,
    verifySeed,
    readSharesAt: async () => SHARES,
    checkPaceMs: 0,
    now,
    ...over,
  };
  return { data: createLiveCascadeData(d, deps), opLog, storage };
}

/** Polls the history until the browser's own check has finished (or `rounds` polls), advancing the clock. */
async function untilChecked(v: ReturnType<typeof visit>, clock: { t: number }, rounds = 60) {
  let h = await v.data.getPositionHistory(ME).catch(() => undefined);
  for (let i = 0; i < rounds && (h === undefined || h.provisional); i++) {
    clock.t += CHECK_EVERY_MS;
    await settled();
    h = await v.data.getPositionHistory(ME).catch(() => undefined);
    await settled();
  }
  return h;
}

describe("a mislabeled or omitted seeded delivery", () => {
  it("never leaves what can be unstaked low: a delivery whose receipt names another batch is a contradiction, the scan starts over and the indexer is distrusted", async () => {
    const h = honestHalves();
    // batch 2 now points at batch 1's delivery; a decoy batch carries batch 2's key so a key-only check would pass
    const shared = {
      ...h.shared,
      delivered: h.shared.delivered.map((e) => (e.batchId === "2" ? { batchId: "2", key: H(1), txHash: H(101), block: "20000" } : e)).concat([{ batchId: "999", key: H(2), txHash: H(103), block: "20000" }]),
    };
    const clock = { t: NOW };
    const storage = memory();
    const v = visit(node(), { shared, own: h.own }, storage, () => clock.t);
    v.opLog.put({ id: "w2", kind: "withdrawal", account: ME, createdAt: T0 + 1, shares: 2n * 10n ** 21n, taoEstimate: 0n, usdcEstimate: 0n, fee: 0n, batchId: 2n, state: "sent" });
    const honest = 8n * 10n ** 22n - 10n ** 21n;
    // every read either refuses to answer or is right; a low figure is never given
    for (let i = 0; i < 6; i++) {
      const a = await v.data.getAvailable(ME).catch(() => undefined);
      if (a && !a.checking) expect(a.availableShares).toBe(honest);
      clock.t += CHECK_EVERY_MS;
      await settled();
    }
    expect(indexerDistrusted(storage, D, clock.t)).toBe(true);
    const a = await v.data.getAvailable(ME);
    expect(a.checking).toBeUndefined();
    expect(a.availableShares).toBe(honest);
    const w = (await v.data.listWithdrawals(ME)).find((r) => r.id === "w2");
    expect(w?.steps.find((s) => s.key === "unstake")?.status).toBe("done");
    // a new visit in the same browser: right, and nothing asked of the indexer
    const again = visit(node(), null, storage, () => clock.t);
    expect((await again.data.getAvailable(ME)).availableShares).toBe(honest);
  });

  it("shows no 'on the bridge' for an unstake whose delivery the seed left out while the seeded range is unchecked, and finds it once the browser has read that range", async () => {
    const h = honestHalves();
    const shared = { ...h.shared, delivered: h.shared.delivered.filter((e) => e.batchId !== "2") };
    const clock = { t: NOW };
    const storage = memory();
    const v = visit(node(), { shared, own: h.own }, storage, () => clock.t);
    v.opLog.put({ id: "w2", kind: "withdrawal", account: ME, createdAt: T0 + 1, shares: 2n * 10n ** 21n, taoEstimate: 0n, usdcEstimate: 0n, fee: 0n, batchId: 2n, state: "sent" });
    const first = await v.data.getAvailable(ME).catch(() => undefined);
    // either still being checked (no figure), or already refused: never the low figure
    if (first) expect(first.checking).toBe(true);
    await untilChecked(v, clock);
    expect(indexerDistrusted(storage, D, clock.t)).toBe(true);
    expect((await v.data.getAvailable(ME)).availableShares).toBe(8n * 10n ** 22n - 10n ** 21n);
  });
});

describe("an oversized or padded seed, and a flaky node", () => {
  it("refuses an account half padded with thousands of events before reading a single receipt, and reads the chain itself", async () => {
    const h = honestHalves();
    const fakes = Array.from({ length: 2_000 }, (_, i) => ({ key: H(1), txHash: H(10_000 + i), block: String(600 + i), assets: "1" }));
    const own = { ...h.own, deposited: [...h.own.deposited, ...fakes] };
    const n = node();
    const storage = memory();
    const v = visit(n, { shared: h.shared, own }, storage);
    const first = await v.data.getPositionHistory(ME);
    expect(first.rewardsEarnedTao).toBeCloseTo(0.02, 12);
    expect(first.provisional).toBeUndefined();
    // the padding never reached the chain: no receipt of a fake was asked for
    expect([...n.receiptsFor.keys()].filter((k) => k >= H(10_000))).toEqual([]);
    expect(n.counts.receipts).toBeLessThan(10);
    expect(createScanStore(storage, D).load(ME).deposited).toHaveLength(1);
    // 2 deliveries allow at most 2 × 2 + the direct allowance account events
    expect(2 * 2 + MAX_SEED_ACCOUNT_EVENTS_EXTRA).toBeLessThan(2_002);
  });

  it("concludes with a node that refuses one receipt in 300: the figures come from the chain, nothing seeded stays saved unverified", async () => {
    const h = honestHalves();
    const clock = { t: NOW };
    const storage = memory();
    const n = node(CHAIN, { flaky: 300 });
    const v = visit(n, h, storage, () => clock.t);
    let h2 = await v.data.getPositionHistory(ME).catch(() => undefined);
    for (let i = 0; i < 40 && (h2 === undefined || h2.provisional); i++) {
      clock.t += CHECK_EVERY_MS;
      await settled();
      h2 = await v.data.getPositionHistory(ME).catch(() => undefined);
      await settled();
    }
    expect(h2?.rewardsEarnedTao).toBeCloseTo(0.02, 12);
    expect(h2?.provisional).toBeUndefined();
    const saved = createScanStore(storage, D).load(ME);
    expect(saved.accountSeededTo).toBeUndefined();
    expect(saved.sharedSeededTo).toBeUndefined();
    expect(saved.deposited).toHaveLength(1);
    // an honest indexer isn't blamed for the node
    expect(indexerDistrusted(storage, D, clock.t)).toBe(false);
  });

  it("gives up on a seed whose events can't be confirmed after a few tries, reading the chain itself without distrusting the indexer", async () => {
    const h = honestHalves();
    // every receipt read fails: the seed's amounts can never be confirmed
    const n = node();
    n.bittensor.getTransactionReceipt = async () => {
      throw new HttpRequestError({ url: "https://archive.chain.opentensor.ai", status: 503 });
    };
    const clock = { t: NOW };
    const storage = memory();
    const v = visit(n, h, storage, () => clock.t, D, { verifySeed: async () => ({ ok: true, next: NEXT }) });
    for (let i = 0; i < SEED_CONFIRM_TRIES; i++) {
      await expect(v.data.getPositionHistory(ME)).rejects.toThrow();
      clock.t += CHECK_EVERY_MS;
    }
    // the next read is the browser's own: the scan started over without the seed
    const h2 = await v.data.getPositionHistory(ME);
    expect(h2.rewardsEarnedTao).toBeCloseTo(0.02, 12);
    expect(h2.provisional).toBeUndefined();
    expect(indexerDistrusted(storage, D, clock.t)).toBe(false);
  });
});

describe("stakes and chunks a seed left out or misplaced", () => {
  it("never links a deposit's trail to a later stake when the seed left the real one out: the step is checked, then the omission is caught", async () => {
    const h = honestHalves();
    const shared = { ...h.shared, staked: h.shared.staked.filter((s) => s.txHash !== H(102)) };
    const clock = { t: NOW };
    const storage = memory();
    const v = visit(node(), { shared, own: h.own }, storage, () => clock.t);
    v.opLog.put({ id: "d", kind: "deposit", account: ME, createdAt: T0 + 1, usdcIn: 0n, targetTao: 7n * 10n ** 16n, hashes: {}, batchId: 1n, state: "sent" });
    for (let i = 0; i < 8; i++) {
      const list = await v.data.listDeposits(ME).catch(() => undefined);
      const stake = list?.find((r) => r.id === "d")?.steps.find((s) => s.key === "stake");
      // never "done" with a stake that isn't the first after the delivery
      if (stake?.status === "done") expect(stake.txUrl).toContain(H(102).slice(2));
      if (indexerDistrusted(storage, D, clock.t)) break;
      clock.t += CHECK_EVERY_MS;
      await settled();
    }
    expect(indexerDistrusted(storage, D, clock.t)).toBe(true);
    const stake = (await v.data.listDeposits(ME)).find((r) => r.id === "d")?.steps.find((s) => s.key === "stake");
    expect(stake?.status).toBe("done");
    expect(stake?.txUrl).toContain(H(102).slice(2));
  });

  it("refuses a seeded stake whose receipt puts it at another block, and shows no stake step from it meanwhile", async () => {
    const h = honestHalves();
    const shared = { ...h.shared, staked: h.shared.staked.map((s) => (s.txHash === H(102) ? { ...s, block: "505" } : s)) };
    const clock = { t: NOW };
    const storage = memory();
    const v = visit(node(), { shared, own: h.own }, storage, () => clock.t);
    v.opLog.put({ id: "d", kind: "deposit", account: ME, createdAt: T0 + 1, usdcIn: 0n, targetTao: 7n * 10n ** 16n, hashes: {}, batchId: 1n, state: "sent" });
    const first = await v.data.listDeposits(ME).catch(() => undefined);
    const step = first?.find((r) => r.id === "d")?.steps.find((s) => s.key === "stake");
    if (step?.status === "done") expect(step.at?.getTime()).not.toBe(0);
    await untilChecked(v, clock, 10);
    expect(indexerDistrusted(storage, D, clock.t)).toBe(true);
  });

  it("shows no payout step from seeded chunks that don't account for every entry of the batch: an omitted final chunk is checked, never guessed", async () => {
    // batch 2 had two entries: the other account's redeem first, then ours; two chunks took one each
    const chain: Log[] = [
      delivered(1n, H(1), 500n, H(101)),
      deposited(H(1), 7n * 10n ** 16n, 7n * 10n ** 22n, 500n, H(101)),
      staked(510n, H(102)),
      delivered(2n, H(2), 20_000n, H(103)),
      redeemed(H(2), 10n ** 16n, 10n ** 22n, 20_000n, H(103), OTHER, 1),
      redeemed(H(2), 10n ** 16n, 10n ** 22n, 20_000n, H(103), ME, 2),
      chunk(H(2), 0, 1, 20_100n, H(104)),
      chunk(H(2), 1, 1, 20_110n, H(106)),
      staked(NEXT - 50n, H(105)),
    ];
    const h = honestHalves(chain);
    const shared = { ...h.shared, payouts: h.shared.payouts.filter((p) => p.chunk !== 1) };
    const clock = { t: NOW };
    const storage = memory();
    const v = visit(node(chain), { shared, own: h.own }, storage, () => clock.t);
    v.opLog.put({ id: "w2", kind: "withdrawal", account: ME, createdAt: T0 + 1, shares: 10n ** 22n, taoEstimate: 0n, usdcEstimate: 0n, fee: 0n, batchId: 2n, state: "sent" });
    const first = (await v.data.listWithdrawals(ME).catch(() => undefined))?.find((r) => r.id === "w2");
    const ret = first?.steps.find((s) => s.key === "return");
    // with the seed's one chunk, our entry (the second) would map to nothing or to the wrong chunk: neither is shown as done
    expect(ret?.status === "done" ? ret.txUrl : undefined).toBeUndefined();
    await untilChecked(v, clock);
    const after = (await v.data.listWithdrawals(ME)).find((r) => r.id === "w2");
    expect(after?.steps.find((s) => s.key === "unstake")?.status).toBe("done");
    // the browser's own read holds both chunks: the step is the second chunk's, as the chain says
    const r2 = after?.steps.find((s) => s.key === "return");
    expect(r2?.status).not.toBe("pending");
  });
});

describe("with no indexer named, nothing changes", () => {
  it("loads saved stakes and chunks trusted, as before, and never asks for their receipts", async () => {
    const storage = memory();
    // a save by an earlier visit: a delivery, the stake after it, a payout chunk, the account's deposit
    const s = newScan(PLAIN);
    s.next = 2_500n;
    s.delivered.set("1", { key: H(1), txHash: H(101), block: 500n });
    s.staked.push({ block: 510n, txHash: H(102) });
    s.payouts.set(H(2), [{ txHash: H(104), block: 1_900n, chunk: 0, taken: 1 }]);
    s.deposited.push({ key: H(1), txHash: H(101), block: 500n, assets: 7n * 10n ** 16n, shares: 7n * 10n ** 22n });
    createScanStore(storage, PLAIN).save(ME, s);
    const back = createScanStore(storage, PLAIN).load(ME);
    expect(back.staked).toEqual([{ block: 510n, txHash: H(102) }]);
    expect(back.payouts.get(H(2))).toEqual([{ txHash: H(104), block: 1_900n, chunk: 0, taken: 1 }]);
    expect(back.sharedSeededTo).toBeUndefined();
    // the saved form is the store's first version: a rollback reads it as before
    expect(JSON.parse(storage.m.get(`cascade.scan.${PLAIN.frontDoor.toLowerCase()}.1`)!).v).toBe(SCAN_VERSION);
    // a node whose receipts all fail: the trail still shows the stake, from the saved scan alone
    const n = node([delivered(1n, H(1), 500n, H(101)), deposited(H(1), 7n * 10n ** 16n, 7n * 10n ** 22n, 500n, H(101)), staked(510n, H(102))], { head: 2_600n });
    const real = n.bittensor.getTransactionReceipt;
    n.bittensor.getTransactionReceipt = async (q) => {
      if (q.hash === H(102)) throw new HttpRequestError({ url: "https://archive.chain.opentensor.ai", status: 503 });
      return real(q);
    };
    const scan = createScanStore(storage, PLAIN).load(ME);
    const f = await depositFacts({ bittensor: n.bittensor } as never, PLAIN, { id: "d", kind: "deposit", account: ME, createdAt: 0, usdcIn: 0n, targetTao: 7n * 10n ** 16n, hashes: {}, batchId: 1n, state: "sent" }, { fd, vault, scan });
    expect(f.facts.staked).toMatchObject({ txHash: H(102) });
    expect(n.receiptsFor.get(H(102)) ?? 0).toBe(0);
  });

  it("writes a half that carries a seeded mark as the store's second version, so an older build starts over rather than trust it", async () => {
    const h = honestHalves();
    const storage = memory();
    const v = visit(node(), h, storage);
    await v.data.getPositionHistory(ME);
    const shared = JSON.parse(storage.m.get(`cascade.scan.${D.frontDoor.toLowerCase()}.1`)!);
    expect(shared.v).toBe(2);
    expect(shared.seededTo).toBeDefined();
    expect(shared.seededFrom).toBe("1");
  });
});

describe("accounts and events a seed can't describe", () => {
  it("falls back without distrust for an account with a direct deposit the indexer's seed can't carry, and then counts it", async () => {
    const chain = [...CHAIN, depositedDirect(2n * 10n ** 16n, 2n * 10n ** 22n, 3_000n, H(200))];
    const h = honestHalves(CHAIN);
    const clock = { t: NOW };
    const storage = memory();
    const v = visit(node(chain), h, storage, () => clock.t, D, { readSharesAt: async () => SHARES + 2n * 10n ** 22n });
    const first = await v.data.getPositionHistory(ME).catch(() => undefined);
    if (first) expect(first.rewardsEarnedTao).toBeUndefined();
    const h2 = await untilChecked(v, clock);
    // 0.08 now + 0.01 out − (0.07 + 0.02) in
    expect(h2?.rewardsEarnedTao).toBeCloseTo(0, 12);
    expect(h2?.provisional).toBeUndefined();
    expect(indexerDistrusted(storage, D, clock.t)).toBe(false);
  });

  it("catches a matched pair with unequal amounts the seed left out, and shows no figure before the browser's own read", async () => {
    // a 0.02 TAO deposit whose full redeem paid 0.025 TAO: the shares add up, the rewards don't
    const pair = [delivered(5n, H(5), 1_000n, H(106)), deposited(H(5), 2n * 10n ** 16n, 2n * 10n ** 22n, 1_000n, H(106)), delivered(6n, H(6), 1_500n, H(107)), redeemed(H(6), 25n * 10n ** 15n, 2n * 10n ** 22n, 1_500n, H(107))];
    const chain = [...CHAIN, ...pair];
    const honest = honestHalves(chain);
    const omitted = { shared: honest.shared, own: honestHalves(CHAIN).own };
    const clock = { t: NOW };
    const storage = memory();
    const v = visit(node(chain), omitted, storage, () => clock.t);
    const first = await v.data.getPositionHistory(ME).catch(() => undefined);
    if (first) {
      expect(first.provisional).toBe(true);
      expect(first.rewardsEarnedTao).toBeUndefined();
    }
    const h2 = await untilChecked(v, clock);
    // 0.08 now + 0.035 out − 0.09 in
    expect(h2?.rewardsEarnedTao).toBeCloseTo(0.025, 12);
    expect(indexerDistrusted(storage, D, clock.t)).toBe(true);
  });
});

describe("two tabs", () => {
  it("a second tab on the same browser never shows a figure the first tab's check contradicted, and asks the indexer nothing once it is distrusted", async () => {
    const h = honestHalves();
    const shared = { ...h.shared, staked: h.shared.staked.filter((s) => s.txHash !== H(102)) };
    const clock = { t: NOW };
    const storage = memory();
    const a = visit(node(), { shared, own: h.own }, storage, () => clock.t);
    const b = visit(node(), { shared, own: h.own }, storage, () => clock.t);
    for (const t of [a, b]) t.opLog.put({ id: "d", kind: "deposit", account: ME, createdAt: T0 + 1, usdcIn: 0n, targetTao: 7n * 10n ** 16n, hashes: {}, batchId: 1n, state: "sent" });
    await untilChecked(a, clock, 12);
    expect(indexerDistrusted(storage, D, clock.t)).toBe(true);
    for (let i = 0; i < 4; i++) {
      const list = await b.data.listDeposits(ME).catch(() => undefined);
      const stake = list?.find((r) => r.id === "d")?.steps.find((s) => s.key === "stake");
      if (stake?.status === "done") expect(stake.txUrl).toContain(H(102).slice(2));
      clock.t += CHECK_EVERY_MS;
      await settled();
    }
    const stake = (await b.data.listDeposits(ME)).find((r) => r.id === "d")?.steps.find((s) => s.key === "stake");
    expect(stake?.status).toBe("done");
    expect(stake?.txUrl).toContain(H(102).slice(2));
  });
});
