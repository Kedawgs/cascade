import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex, HttpRequestError, parseAbiParameters, TransactionReceiptNotFoundError } from "viem";
import { describe, expect, it } from "vitest";
import { VAULT } from "./abi";
import type { Deployment } from "./config";
import { HistoryMismatchError, newScan, REREAD, restartScan } from "./facts";
import { StaleChainError } from "./fresh";
import { scanState, seedHalves } from "./scan-store";
import { type CheckMemo, checkSeededHistory, MAX_SEED_ACCOUNT_EVENTS_EXTRA, MAX_SEED_CHUNKS_PER_KEY, MAX_SEED_EVENTS, SEED_MAX_LAG, SEED_SAMPLE, vaultEvents, verifySeed } from "./seed";

const D: Deployment = {
  frontDoor: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  baseAdapter: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  vault: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  bitAdapter: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  bitBlock: 1_000n,
  vaultSs58: "x",
  hotkeySs58: "y",
};
const ME = getAddress("0x000000000000000000000000000000000000a11c");
const OTHER = getAddress("0x000000000000000000000000000000000000b0b0");
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const OTHER_DOOR = "0x00000000000000000000000000000000000000d0";

type Log = { address: string; topics: Hex[]; data: Hex; blockNumber: bigint; transactionHash: Hex; logIndex: number };
const log = (address: string, topics: Hex[], data: Hex, block: bigint, tx: Hex, index = 0): Log => ({ address, topics, data, blockNumber: block, transactionHash: tx, logIndex: index });
const deliveredLog = (batchId: bigint, key: Hex, block: bigint, tx: Hex, frontDoor: string = D.frontDoor) =>
  log(D.vault, encodeEventTopics({ abi: VAULT, eventName: "BatchDelivered", args: { key, sourceChain: 8453n, frontDoor: frontDoor as Hex } }) as Hex[], encodeAbiParameters(parseAbiParameters("uint64, uint256"), [batchId, 10n ** 16n]), block, tx);
const stakedLog = (block: bigint, tx: Hex) =>
  log(D.vault, encodeEventTopics({ abi: VAULT, eventName: "Staked", args: { hotkey: H(1) } }) as Hex[], encodeAbiParameters(parseAbiParameters("uint256, uint256"), [1n, 1n]), block, tx);
const chunkLog = (key: Hex, chunk: number, taken: number, block: bigint, tx: Hex) =>
  log(
    D.vault,
    encodeEventTopics({ abi: VAULT, eventName: "PayoutChunkSent", args: { key } }) as Hex[],
    encodeAbiParameters(parseAbiParameters("uint32, uint32, uint256, uint256, uint256"), [chunk, taken, 10n ** 16n, 9n * 10n ** 15n, 10n ** 15n]),
    block,
    tx,
  );
const depositedLog = (key: Hex, user: Hex, assets: bigint, block: bigint, tx: Hex, index = 1) =>
  log(D.vault, encodeEventTopics({ abi: VAULT, eventName: "Deposited", args: { key, user } }) as Hex[], encodeAbiParameters(parseAbiParameters("uint256, uint256"), [assets, assets * 10n ** 6n]), block, tx, index);
const redeemedLog = (key: Hex, user: Hex, assets: bigint, block: bigint, tx: Hex, index = 1) =>
  log(D.vault, encodeEventTopics({ abi: VAULT, eventName: "Redeemed", args: { key, user } }) as Hex[], encodeAbiParameters(parseAbiParameters("uint256, uint256"), [assets * 10n ** 6n, assets]), block, tx, index);
const bouncedLog = (key: Hex, user: Hex, block: bigint, tx: Hex, index = 1) =>
  log(D.vault, encodeEventTopics({ abi: VAULT, eventName: "DepositBounced", args: { key, user } }) as Hex[], encodeAbiParameters(parseAbiParameters("uint256"), [1n]), block, tx, index);

/** The chain's history: five years of nothing, then a little of everything near block 20,000. */
const NEXT = 20_000n;
const HEAD = NEXT + 50n;
const OLD = [
  deliveredLog(1n, H(1), 1_500n, H(101)),
  depositedLog(H(1), ME, 10n ** 16n, 1_500n, H(101)),
  stakedLog(1_600n, H(102)),
  deliveredLog(2n, H(2), 5_000n, H(103)),
  redeemedLog(H(2), ME, 5n * 10n ** 15n, 5_000n, H(103)),
  chunkLog(H(2), 0, 1, 5_300n, H(104)),
  deliveredLog(3n, H(3), 9_000n, H(105)),
  depositedLog(H(3), ME, 2n * 10n ** 16n, 9_000n, H(105)),
  stakedLog(9_010n, H(106)),
];
/** In the seed's last REREAD blocks. */
const RECENT = [deliveredLog(4n, H(4), NEXT - 100n, H(107)), depositedLog(H(4), ME, 3n * 10n ** 16n, NEXT - 100n, H(107)), stakedLog(NEXT - 90n, H(108)), chunkLog(H(3), 0, 2, NEXT - 50n, H(109))];
/** Not the deployment's, or not the account's: never in a seed. */
const NOISE = [deliveredLog(9n, H(9), NEXT - 80n, H(110), OTHER_DOOR), depositedLog(H(4), OTHER, 7n, NEXT - 100n, H(107), 2)];
const CHAIN = [...OLD, ...RECENT, ...NOISE];

/** Receipts by transaction: every log of that transaction. */
const receiptsOf = (logs: Log[]) => {
  const out: Record<string, { status: string; blockNumber: bigint; logs: Log[] }> = {};
  for (const l of logs) (out[l.transactionHash] ??= { status: "success", blockNumber: l.blockNumber, logs: [] }).logs.push(l);
  return out;
};

/** Bittensor from a node at `head` holding `logs` and their receipts; `indexedTo`: its logs and receipts stop there. */
function node(o: { head?: bigint; logs?: Log[]; indexedTo?: bigint; receiptsFail?: boolean; heads?: bigint[] } = {}) {
  const head = o.head ?? HEAD;
  const logs = o.logs ?? CHAIN;
  const receipts = receiptsOf(logs);
  const windows: [bigint, bigint][] = [];
  const asked: { hash: Hex }[] = [];
  const topics: unknown[] = [];
  let heads = 0;
  const bittensor = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === "eth_blockNumber") return `0x${(o.heads?.[heads++] ?? head).toString(16)}`;
      if (method === "eth_getLogs") {
        const q = (params as [{ fromBlock: Hex; toBlock: Hex; address: string; topics: unknown }])[0];
        const [from, to] = [BigInt(q.fromBlock), BigInt(q.toBlock)];
        windows.push([from, to]);
        topics.push(q.topics);
        const user = (q.topics as (Hex | null)[])[2];
        return logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to && l.blockNumber <= (o.indexedTo ?? head) && (!user || l.topics[2] === user));
      }
      throw new Error(`unexpected ${method}`);
    },
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      windows.push([fromBlock, toBlock]);
      return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock && l.blockNumber <= (o.indexedTo ?? head));
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      asked.push({ hash });
      if (o.receiptsFail) throw new HttpRequestError({ url: "https://archive.chain.opentensor.ai", status: 503 });
      const r = receipts[hash];
      if (!r || r.blockNumber > (o.indexedTo ?? head)) throw new TransactionReceiptNotFoundError({ hash });
      return r;
    },
    getBlock: async () => ({ number: head, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
  };
  return { clients: { bittensor } as never, windows, asked, topics };
}

/** The indexer's honest halves: everything of the deployment's and the account's up to NEXT. */
function honest(next = NEXT) {
  const s = newScan(D);
  s.next = next + 10n; // scanState saves SETTLE short
  for (const l of [...OLD, ...RECENT]) {
    const ev = vaultEvents([l], D, ME);
    for (const d of ev.delivered) s.delivered.set(d.batchId, { key: d.key, txHash: d.txHash, block: d.block });
    s.staked.push(...ev.staked);
    for (const p of ev.payouts) s.payouts.set(p.key, [...(s.payouts.get(p.key) ?? []), { txHash: p.txHash, block: p.block, chunk: p.chunk, taken: p.taken }]);
    s.deposited.push(...ev.deposited);
    s.redeemed.push(...ev.redeemed);
  }
  const state = scanState(s);
  return { shared: { ...state, deposited: [], redeemed: [] }, own: { ...state, delivered: [], staked: [], payouts: [] } };
}

const verify = (n: ReturnType<typeof node>, halves: { shared: unknown; own: unknown }, scan = newScan(D), head = HEAD) => verifySeed(n.clients, D, scan, ME, halves, head);

describe("vaultEvents", () => {
  it("reads a window as the scan does: our front door's deliveries, every stake and chunk, the account's own events, nothing else", () => {
    const ev = vaultEvents(CHAIN as never, D, ME);
    expect(ev.delivered.map((d) => d.batchId)).toEqual(["1", "2", "3", "4"]);
    expect(ev.staked.map((s) => s.block)).toEqual([1_600n, 9_010n, NEXT - 90n]);
    expect(ev.payouts.map((p) => [p.key, p.chunk, p.taken])).toEqual([
      [H(2), 0, 1],
      [H(3), 0, 2],
    ]);
    expect(ev.deposited.map((e) => e.assets)).toEqual([10n ** 16n, 2n * 10n ** 16n, 3n * 10n ** 16n]);
    expect(ev.redeemed.map((e) => e.assets)).toEqual([5n * 10n ** 15n]);
  });
});

describe("verifySeed", () => {
  it("accepts a seed whose last blocks match the chain's logs and whose sampled older events are in their receipts, reading one window", async () => {
    const n = node();
    const v = await verify(n, honest());
    expect(v).toEqual({ ok: true, next: NEXT });
    // one window: the seed's last REREAD blocks
    expect(n.windows).toEqual([[NEXT - REREAD, NEXT - 1n]]);
    // a handful of older events' receipts, no more
    expect(n.asked.length).toBeGreaterThan(0);
    expect(n.asked.length).toBeLessThanOrEqual(SEED_SAMPLE);
    // and the halves then seed the scan through the store
    const scan = newScan(D);
    expect(seedHalves(scan, honest().shared, honest().own)).toBe(true);
    expect(scan.next).toBe(NEXT);
    expect(scan.delivered.size).toBe(4);
  });

  it("falls back, distrusting, on another deployment's halves; falls back without distrust on halves that aren't a state at all", async () => {
    const h = honest();
    const other = { ...h.shared, vault: OTHER_DOOR };
    const otherBlock = { ...h.own, from: "999" };
    for (const [shared, own] of [
      [other, h.own],
      [h.shared, otherBlock],
    ]) {
      const v = await verify(node(), { shared, own });
      expect(v).toMatchObject({ ok: false, distrust: true });
      expect((v as { reason: string }).reason).toMatch(/deployment/);
    }
    for (const [shared, own] of [
      [null, h.own],
      [h.shared, "<html>"],
      [{ ...h.shared, staked: [{ block: "abc", txHash: H(1) }] }, h.own],
      [{ v: 1 }, h.own],
    ]) {
      const v = await verify(node(), { shared, own });
      expect(v).toMatchObject({ ok: false, distrust: false });
    }
  });

  it("falls back, without distrust, on a seed that is stale, ahead of the chain, or no further than the saved scan", async () => {
    const stale = await verify(node(), honest(), newScan(D), NEXT + SEED_MAX_LAG + 1n);
    expect(stale).toMatchObject({ ok: false, distrust: false });
    expect((stale as { reason: string }).reason).toMatch(/behind/);
    expect(await verify(node(), honest(), newScan(D), NEXT + SEED_MAX_LAG)).toMatchObject({ ok: true });
    const ahead = await verify(node({ head: NEXT - 5n }), honest(), newScan(D), NEXT - 5n);
    expect(ahead).toMatchObject({ ok: false, distrust: false });
    expect((ahead as { reason: string }).reason).toMatch(/ahead/);
    const scan = newScan(D);
    scan.next = NEXT;
    expect(await verify(node(), honest(), scan)).toMatchObject({ ok: false, distrust: false });
  });

  it("catches a seed missing an event the chain shows in its last blocks: a delivery, a stake, a chunk, or the account's own deposit", async () => {
    const h = honest();
    const without = {
      "a delivery": { shared: { ...h.shared, delivered: h.shared.delivered.filter((d) => d.batchId !== "4") }, own: h.own },
      "a stake": { shared: { ...h.shared, staked: h.shared.staked.filter((s) => s.block !== String(NEXT - 90n)) }, own: h.own },
      "a chunk": { shared: { ...h.shared, payouts: h.shared.payouts.filter((p) => p.block !== String(NEXT - 50n)) }, own: h.own },
      "the account's deposit": { shared: h.shared, own: { ...h.own, deposited: h.own.deposited.filter((e) => e.block !== String(NEXT - 100n)) } },
    };
    for (const [what, halves] of Object.entries(without)) {
      const v = await verify(node(), halves);
      expect(v, what).toMatchObject({ ok: false, distrust: true });
      expect((v as { reason: string }).reason, what).toMatch(/left out/);
    }
  });

  it("catches a wrong amount, batch or transaction on an event in the seed's last blocks", async () => {
    const h = honest();
    const wrong = {
      "the deposit's amount": { shared: h.shared, own: { ...h.own, deposited: h.own.deposited.map((e) => (e.block === String(NEXT - 100n) ? { ...e, assets: "1" } : e)) } },
      "the delivery's batch": { shared: { ...h.shared, delivered: h.shared.delivered.map((d) => (d.batchId === "4" ? { ...d, batchId: "5" } : d)) }, own: h.own },
      "the chunk's taken count": { shared: { ...h.shared, payouts: h.shared.payouts.map((p) => (p.block === String(NEXT - 50n) ? { ...p, taken: 1 } : p)) }, own: h.own },
      "the stake's transaction": { shared: { ...h.shared, staked: h.shared.staked.map((s) => (s.block === String(NEXT - 90n) ? { ...s, txHash: H(999) } : s)) }, own: h.own },
    };
    for (const [what, halves] of Object.entries(wrong)) {
      const v = await verify(node(), halves);
      expect(v, what).toMatchObject({ ok: false, distrust: true });
    }
  });

  it("catches an extra event in the seed's last blocks by its receipt: none on a node well past its block means it was invented", async () => {
    const h = honest();
    const extra = { shared: { ...h.shared, staked: [...h.shared.staked, { block: String(NEXT - 70n), txHash: H(777) }] }, own: h.own };
    // a node only 50 blocks past it can't yet say the transaction isn't there (its receipts may lag): no seed, nothing decided
    const soon = await verify(node(), extra);
    expect(soon).toMatchObject({ ok: false, distrust: false });
    expect((soon as { reason: string }).reason).toMatch(/couldn't/);
    // one REREAD blocks past it can: the seed invented it
    const far = await verify(node({ head: NEXT + REREAD }), extra, newScan(D), NEXT + REREAD);
    expect(far).toMatchObject({ ok: false, distrust: true });
    expect((far as { reason: string }).reason).toMatch(/isn't on the chain/);
    // an extra deposit of the account's whose transaction is real but holds another account's deposit only: its receipt says so at once
    const forged = { shared: h.shared, own: { ...h.own, deposited: [...h.own.deposited, { key: H(4), txHash: H(110), block: String(NEXT - 80n), assets: "5" }] } };
    expect(await verify(node(), forged)).toMatchObject({ ok: false, distrust: true });
  });

  it("forgives a node whose logs lag its head: an event the window lacks but whose receipt shows it is the node's doing, not the seed's", async () => {
    // the node's logs and receipts stop 60 blocks short: the window misses the chunk at NEXT - 50
    const lagging = node({ indexedTo: NEXT - 60n });
    const v = await verify(lagging, honest());
    // the receipt can't be read either from that node: nothing is decided
    expect(v).toMatchObject({ ok: false, distrust: false });
    expect((v as { reason: string }).reason).toMatch(/couldn't/);
    // a node whose receipts are complete though its log index lags: the chunk's receipt shows it
    const logsLag = node();
    const real = (logsLag.clients as { bittensor: { getLogs: (q: { fromBlock: bigint; toBlock: bigint }) => Promise<Log[]> } }).bittensor.getLogs;
    (logsLag.clients as { bittensor: { getLogs: (q: { fromBlock: bigint; toBlock: bigint }) => Promise<Log[]> } }).bittensor.getLogs = async (q) => (await real(q)).filter((l) => l.blockNumber <= NEXT - 60n);
    expect(await verify(logsLag, honest())).toEqual({ ok: true, next: NEXT });
  });

  it("falls back without distrust when the chain can't be read well enough to judge: a window from a server behind it, or receipts that fail", async () => {
    const behind = node({ heads: [NEXT - 500n, NEXT - 500n, NEXT - 500n, NEXT - 500n] });
    const v = await verify(behind, honest());
    expect(v).toMatchObject({ ok: false, distrust: false });
    const failing = node({ receiptsFail: true });
    expect(await verify(failing, honest())).toMatchObject({ ok: false, distrust: false });
  });

  it("samples older events at random, account events included, and refuses the seed when one isn't in its receipt", async () => {
    const h = honest();
    const n = node();
    await verify(n, h);
    const sampled = n.asked.map((a) => a.hash);
    // SEED_SAMPLE distinct picks out of the older events, from the platform's randomness (two picks in
    // one transaction share its receipt)
    expect(sampled.length).toBeGreaterThanOrEqual(SEED_SAMPLE / 2);
    expect(sampled.length).toBeLessThanOrEqual(SEED_SAMPLE);
    expect(new Set(sampled).size).toBe(sampled.length);
    // across runs the picks vary (a seed can't arrange to be sampled where it is honest); 8 picks of these 9
    // events leave all 6 receipts asked 2 times in 3, so it takes 30 runs to all but rule out every one alike
    const runs = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const m = node();
      await verify(m, h);
      runs.add(m.asked.map((a) => a.hash).sort().join());
    }
    expect(runs.size).toBeGreaterThan(1);
    // with the picks pinned (tests only): an old delivery given another transaction's hash is caught by its receipt
    const first = (): number => 0;
    const swapped = { shared: { ...h.shared, delivered: h.shared.delivered.map((d) => (d.batchId === "2" ? { ...d, txHash: H(102) } : d)) }, own: h.own };
    expect(await verifySeed(node().clients, D, newScan(D), ME, swapped, HEAD, { random: first })).toMatchObject({ ok: false, distrust: true });
    // an old stake whose transaction isn't on the chain at all
    const invented = { shared: { ...h.shared, staked: h.shared.staked.map((s) => (s.block === "1600" ? { ...s, txHash: H(888) } : s)) }, own: h.own };
    expect(await verifySeed(node().clients, D, newScan(D), ME, invented, HEAD, { random: first })).toMatchObject({ ok: false, distrust: true });
    // and an account event of the seed's that its receipt doesn't show: the sample reaches those too
    const wrongDeposit = { shared: h.shared, own: { ...h.own, deposited: h.own.deposited.map((e) => (e.block === "1500" ? { ...e, txHash: H(102) } : e)) } };
    const last = (k: number): number => k - 1;
    expect(await verifySeed(node().clients, D, newScan(D), ME, wrongDeposit, HEAD, { random: last })).toMatchObject({ ok: false, distrust: true });
  });

  it("refuses a padded or oversized seed before it reads a single receipt", async () => {
    const h = honest();
    const n = node();
    const fakes = Array.from({ length: 2_000 }, (_, i) => ({ key: H(1), txHash: H(10_000 + i), block: String(2_000 + i), assets: "1" }));
    const padded = await verify(n, { shared: h.shared, own: { ...h.own, deposited: [...h.own.deposited, ...fakes] } });
    expect(padded).toEqual({ ok: false, distrust: true, reason: "its account half holds more events than its deliveries allow" });
    expect(n.asked).toEqual([]);
    expect(n.windows).toEqual([]);
    // a batch's payout list holds at most 100 bounced deposits and 100 redeems, each chunk taking one or more
    const chunks = (k: number) => ({ ...h.shared, payouts: Array.from({ length: k }, (_, i) => ({ key: H(2), chunk: i, taken: 1, txHash: H(20_000 + i), block: String(5_300 + i) })) });
    expect(MAX_SEED_CHUNKS_PER_KEY).toBe(200);
    expect(await verify(node(), { shared: chunks(201), own: h.own })).toMatchObject({ ok: false, distrust: true, reason: "it holds more payout chunks for one batch than a batch can have" });
    expect(await verify(node(), { shared: chunks(200), own: h.own })).not.toMatchObject({ reason: "it holds more payout chunks for one batch than a batch can have" });
    // the allowance for events of the account's beyond its batches'
    expect(MAX_SEED_ACCOUNT_EVENTS_EXTRA).toBeLessThanOrEqual(100);
  });

  it("distrusts only a shape no chain can have: an honest history merely too big to check here is read from the chain, with no blame", async () => {
    const h = honest();
    // two of one batch's deposits for one account (the front door keeps one entry per account a batch)
    const twice = { shared: h.shared, own: { ...h.own, deposited: [...h.own.deposited, { ...h.own.deposited[0], txHash: H(4_242) }] } };
    expect(await verify(node(), twice)).toMatchObject({ ok: false, distrust: true });
    // more direct deposits than are checked here: honest accounts can have them
    const direct = Array.from({ length: MAX_SEED_ACCOUNT_EVENTS_EXTRA + 1 }, (_, i) => ({ key: H(0), txHash: H(30_000 + i), block: String(2_000 + i), assets: "1", kind: "direct" }));
    const n = node();
    expect(await verify(n, { shared: h.shared, own: { ...h.own, deposited: [...h.own.deposited, ...direct] } })).toMatchObject({ ok: false, distrust: false });
    expect(n.asked).toEqual([]);
    // years of an honest deployment past what is checked here
    const many = Array.from({ length: MAX_SEED_EVENTS + 1 }, (_, i) => ({ block: String(1_000 + (i % 18_000)), txHash: H(40_000 + i) }));
    const big = node();
    expect(await verify(big, { shared: { ...h.shared, staked: many }, own: h.own })).toMatchObject({ ok: false, distrust: false });
    expect(big.asked).toEqual([]);
  });

  it("asks nothing of the chain for halves that already fail on their own", async () => {
    const n = node();
    await verify(n, { shared: null, own: null });
    expect(n.windows).toEqual([]);
    expect(n.asked).toEqual([]);
  });
});

describe("checkSeededHistory", () => {
  /** A scan seeded with the honest halves, its account events confirmed (as historyFor leaves them). */
  const seeded = (halves = honest()) => {
    const scan = newScan(D);
    seedHalves(scan, halves.shared, halves.own);
    for (const list of [scan.deposited, scan.redeemed]) for (let i = 0; i < list.length; i++) delete list[i].unconfirmed;
    return scan;
  };

  it("reads every vault log of the seeded blocks, in windows of at most 1,000 blocks from the seed's first block to its mark, a few per step, resuming", async () => {
    const n = node();
    const scan = seeded();
    expect(await checkSeededHistory(n.clients, D, scan, ME, 3)).toBe("more");
    expect(n.windows).toEqual([
      [1_000n, 1_999n],
      [2_000n, 2_999n],
      [3_000n, 3_999n],
    ]);
    // each half's progress, on the scan, saved with that half
    expect(scan.sharedCheckedTo).toBe(4_000n);
    expect(scan.accountCheckedTo).toBe(4_000n);
    // the whole vault's logs, not one account's topic: the deployment's half is checked too
    expect(n.topics).toEqual([]);
    // the rest, in later steps, up to the mark and no further
    let r: "more" | "done" | "stopped" = "more";
    for (let i = 0; i < 20 && r === "more"; i++) r = await checkSeededHistory(n.clients, D, scan, ME, 3);
    expect(r).toBe("done");
    expect(n.windows[n.windows.length - 1]).toEqual([19_000n, NEXT - 1n]);
    expect(n.windows).toHaveLength(19);
    // both halves read to their end: the browser's own, marks and progress gone
    expect([scan.sharedSeededTo, scan.accountSeededTo, scan.sharedCheckedTo, scan.accountCheckedTo]).toEqual([undefined, undefined, undefined, undefined]);
    // done again at once, without reading
    expect(await checkSeededHistory(n.clients, D, scan, ME, 3)).toBe("done");
    expect(n.windows).toHaveLength(19);
  });

  it("is done at once for a scan the browser read itself, and still reads the deployment's half when only the account's was the browser's", async () => {
    const n = node();
    const scan = seeded();
    delete scan.accountSeededFrom;
    delete scan.accountSeededTo;
    expect(await checkSeededHistory(n.clients, D, scan, ME, 1)).toBe("more");
    expect(n.windows).toHaveLength(1);
    delete scan.sharedSeededFrom;
    delete scan.sharedSeededTo;
    expect(await checkSeededHistory(n.clients, D, scan, ME, 3)).toBe("done");
    expect(n.windows).toHaveLength(1);
  });

  it("confirms the scan's entries in a window that matched, so a trail uses them without their receipts", async () => {
    const n = node();
    const scan = seeded();
    expect(scan.staked[0].unconfirmed).toBe(true);
    await checkSeededHistory(n.clients, D, scan, ME, 2);
    expect(scan.staked[0]).toEqual({ block: 1_600n, txHash: H(102), clearBefore: 1_000n });
    expect(scan.delivered.get("1")?.unconfirmed).toBeUndefined();
    expect(scan.sharedCheckedTo).toBe(3_000n);
    // amounts are confirmed by receipt, not by a matching window: a seeded deposit stays unconfirmed
    const fresh = newScan(D);
    seedHalves(fresh, honest().shared, honest().own);
    await checkSeededHistory(n.clients, D, fresh, ME, 2);
    expect(fresh.deposited.find((e) => e.block === 1_500n)?.unconfirmed).toBe(true);
  });

  it("catches a delivery, stake or chunk the seed left out of the deployment's half, anywhere in the seeded blocks", async () => {
    const h = honest();
    const cases: [string, typeof h.shared][] = [
      ["a delivery", { ...h.shared, delivered: h.shared.delivered.filter((d) => d.batchId !== "2") }],
      ["a stake", { ...h.shared, staked: h.shared.staked.filter((s) => s.block !== "9010") }],
      ["a chunk", { ...h.shared, payouts: [] }],
    ];
    for (const [what, shared] of cases) {
      const scan = seeded({ shared, own: h.own });
      let err: unknown;
      for (let i = 0; i < 20 && err === undefined; i++) err = await checkSeededHistory(node().clients, D, scan, ME, 1).then(() => undefined, (e: unknown) => e);
      expect(err, what).toBeInstanceOf(HistoryMismatchError);
      expect((err as HistoryMismatchError).seeded, what).toBe(true);
    }
  });

  it("catches a matched set the seed left out (a deposit, its full redeem) that no balance check could see", async () => {
    const h = honest();
    const omitted = { shared: h.shared, own: { ...h.own, deposited: h.own.deposited.filter((e) => e.block !== "1500"), redeemed: [] } };
    const scan = seeded(omitted);
    const err = await checkSeededHistory(node().clients, D, scan, ME, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HistoryMismatchError);
    expect((err as HistoryMismatchError).seeded).toBe(true);
    expect((err as HistoryMismatchError).restarted).toBe(false);
  });

  it("catches an event of the account's the seed invented, and a wrong transaction for a real one", async () => {
    const h = honest();
    const invented = { shared: h.shared, own: { ...h.own, redeemed: [...h.own.redeemed, { key: H(1), txHash: H(555), block: "1700", assets: "1" }] } };
    await expect(checkSeededHistory(node().clients, D, seeded(invented), ME, 1)).rejects.toBeInstanceOf(HistoryMismatchError);
    const wrongTx = { shared: h.shared, own: { ...h.own, deposited: h.own.deposited.map((e) => (e.block === "1500" ? { ...e, txHash: H(102) } : e)) } };
    await expect(checkSeededHistory(node().clients, D, seeded(wrongTx), ME, 1)).rejects.toBeInstanceOf(HistoryMismatchError);
  });

  it("catches a delivery the seed left out of a batch the account took part in, bounced deposits included; not one the browser's own read is still catching up on", async () => {
    const h = honest();
    const bounced = bouncedLog(H(7), ME, 7_000n, H(177));
    const chainWithBounce = [...CHAIN, deliveredLog(7n, H(7), 7_000n, H(177)), bounced];
    // the seed has neither the delivery nor (it carries no bounces) the bounce: the delivery's absence gives it away
    const scan = seeded(h);
    scan.sharedCheckedTo = scan.accountCheckedTo = 7_000n;
    const err = await checkSeededHistory(node({ logs: chainWithBounce }).clients, D, scan, ME, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HistoryMismatchError);
    expect((err as HistoryMismatchError).seeded).toBe(true);
    // the same with the deployment's half read by the browser itself: a trail may lag, the seed isn't blamed
    const own = seeded(h);
    delete own.sharedSeededTo;
    own.accountCheckedTo = 7_000n;
    expect(await checkSeededHistory(node({ logs: chainWithBounce }).clients, D, own, ME, 1)).toBe("more");
  });

  it("stops at a window a server hasn't reached, keeping the progress made, to go on later", async () => {
    const n = node({ heads: [5_000n, 5_000n, 5_000n, 5_000n, 5_000n, 5_000n, 5_000n, 5_000n] });
    const scan = seeded();
    scan.sharedCheckedTo = scan.accountCheckedTo = 4_000n;
    await expect(checkSeededHistory(n.clients, D, scan, ME, 3)).rejects.toBeInstanceOf(StaleChainError);
    // the first window (to 4,999) was within reach; the second (to 5,999) wasn't
    expect(scan.sharedCheckedTo).toBe(5_000n);
    expect(scan.accountCheckedTo).toBe(5_000n);
  });

  it("passes an honest seed whose account has bounced and skipped entries too, as long as their deliveries are there", async () => {
    const chain = [...CHAIN, deliveredLog(7n, H(7), 7_000n, H(177)), bouncedLog(H(7), ME, 7_000n, H(177))];
    const h = honest();
    const withBatch7 = { ...h, shared: { ...h.shared, delivered: [...h.shared.delivered, { batchId: "7", key: H(7), txHash: H(177), block: "7000" }] } };
    const scan = seeded(withBatch7);
    let r: "more" | "done" | "stopped" = "more";
    for (let i = 0; i < 30 && r === "more"; i++) r = await checkSeededHistory(node({ logs: chain }).clients, D, scan, ME, 5);
    expect(r).toBe("done");
  });

  it("reads each half on from its own progress: a window below one half's progress judges only the other half there", async () => {
    // the deployment half was checked to 9,000 (an earlier visit); the account half not at all
    const h = honest();
    const lacking = { shared: { ...h.shared, staked: h.shared.staked.filter((x) => x.block !== "1600") }, own: { ...h.own, deposited: h.own.deposited.filter((e) => e.block !== "1500") } };
    // a stake left out below the deployment half's progress isn't judged again; a deposit left out of the
    // account half, unchecked there, is caught
    const scan = seeded(lacking);
    scan.sharedCheckedTo = 9_000n;
    const err = await checkSeededHistory(node().clients, D, scan, ME, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HistoryMismatchError);
    const sharedOnly = seeded({ shared: lacking.shared, own: h.own });
    sharedOnly.sharedCheckedTo = 9_000n;
    expect(await checkSeededHistory(node().clients, D, sharedOnly, ME, 1)).toBe("more");
    expect(sharedOnly.sharedCheckedTo).toBe(9_000n);
    expect(sharedOnly.accountCheckedTo).toBe(2_000n);
  });

  it("clears a half's mark once it is read to its end, while the other half's goes on", async () => {
    const scan = seeded();
    // the deployment half read to its last block in an earlier step
    scan.sharedCheckedTo = NEXT;
    expect(await checkSeededHistory(node().clients, D, scan, ME, 1)).toBe("more");
    expect(scan.sharedSeededTo).toBeUndefined();
    expect(scan.sharedCheckedTo).toBeUndefined();
    expect(scan.accountSeededTo).toBe(NEXT);
    expect(scan.accountCheckedTo).toBe(2_000n);
  });

  it("confirms nothing outside the blocks each half judged: a window read for the account half leaves the deployment half's entries as they were", async () => {
    const scan = seeded();
    // the deployment half's own progress is past this window: its entries here aren't compared again
    scan.sharedCheckedTo = 3_000n;
    await checkSeededHistory(node().clients, D, scan, ME, 1);
    expect(scan.delivered.get("1")?.unconfirmed).toBe(true);
    expect(scan.staked.find((x) => x.block === 1_600n)?.unconfirmed).toBe(true);
    // a saved delivery past the deployment half's mark, inside a window judged for the account half only
    const past = seeded();
    past.sharedSeededTo = 5_000n;
    past.accountCheckedTo = 9_000n;
    past.sharedCheckedTo = 4_000n;
    past.delivered.set("8", { key: H(8), txHash: H(188), block: 4_500n, unconfirmed: true });
    const chain = [...CHAIN, deliveredLog(8n, H(8), 4_500n, H(188))];
    await checkSeededHistory(node({ logs: chain }).clients, D, past, ME, 1);
    // compared (it is in the deployment half's window 4,000–4,999): confirmed; nothing past 4,999 was
    expect(past.delivered.get("8")?.unconfirmed).toBeUndefined();
    expect(past.delivered.get("3")?.unconfirmed).toBe(true);
  });

  it("indexes the deployment half's events once, keeping the index while they stay the same, and building it again when they change", async () => {
    const n = node();
    const scan = seeded();
    const memo: CheckMemo = {};
    await checkSeededHistory(n.clients, D, scan, ME, 1, memo);
    const first = memo.shared;
    expect(first?.events.length).toBe(scan.delivered.size + scan.staked.length + [...scan.payouts.values()].flat().length);
    await checkSeededHistory(n.clients, D, scan, ME, 3, memo);
    expect(memo.shared).toBe(first);
    // the scan read on and found a stake: the index follows
    scan.staked.push({ block: NEXT + 5n, txHash: H(999) });
    await checkSeededHistory(n.clients, D, scan, ME, 1, memo);
    expect(memo.shared).not.toBe(first);
  });

  it("stops, confirming nothing and moving no progress, when the scan started over while a receipt was being read for an event the window lacked (review 3)", async () => {
    const n = node();
    const scan = seeded();
    // a node whose logs for the first window lag: the seed's stake at 1,600 is judged by its receipt, and
    // the scan starts over (a trail caught something) while that receipt is being read
    const nodeBittensor = (n.clients as { bittensor: Record<string, (q: never) => Promise<unknown>> }).bittensor;
    const logs = nodeBittensor.getLogs;
    nodeBittensor.getLogs = async (q: never) => ((await logs(q)) as { transactionHash: Hex }[]).filter((l) => l.transactionHash !== H(102));
    const receipt = nodeBittensor.getTransactionReceipt;
    nodeBittensor.getTransactionReceipt = async (q: never) => {
      const r = await receipt(q);
      restartScan(scan);
      return r;
    };
    expect(await checkSeededHistory(n.clients, D, scan, ME, 1)).toBe("stopped");
    expect(scan.sharedCheckedTo).toBeUndefined();
    expect(scan.accountCheckedTo).toBeUndefined();
  });

  it("stops, judging nothing and moving no progress, when the scan's mark changed under a window read: it started over, or was seeded again", async () => {
    const n = node();
    const scan = seeded();
    scan.sharedCheckedTo = scan.accountCheckedTo = 3_000n;
    // the scan starts over (a trail caught something) while the first window is being read
    const real = (n.clients as { bittensor: { request: (q: unknown) => Promise<unknown> } }).bittensor.request;
    (n.clients as { bittensor: { request: (q: unknown) => Promise<unknown> } }).bittensor.request = async (q) => {
      const r = await real(q);
      delete scan.accountSeededTo;
      return r;
    };
    expect(await checkSeededHistory(n.clients, D, scan, ME, 3)).toBe("stopped");
    expect(scan.sharedCheckedTo).toBe(3_000n);
    expect(n.windows).toHaveLength(1);
  });
});
