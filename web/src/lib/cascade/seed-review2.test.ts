// Regression tests from the site-seed re-review (review 2): the background check's progress belongs to
// the seed it checked, whatever another account or tab writes to the browser's storage (N1); and what can
// be unstaked never waits on a page that isn't open (N2).
import { encodeAbiParameters, encodeEventTopics, type Hex, HttpRequestError, parseAbiParameters, toHex, TransactionReceiptNotFoundError } from "viem";
import { describe, expect, it } from "vitest";
import { VAULT } from "./abi";
import type { Deployment } from "./config";
import { newScan, scanVault } from "./facts";
import { indexerDistrusted } from "./indexer";
import { CHECK_EVERY_MS, createLiveCascadeData, type LiveDeps } from "./live";
import { createOpLog } from "./oplog";
import type { FrontDoorState, VaultState } from "./reads";
import { createScanStore, scanState } from "./scan-store";
import { vaultEvents, verifySeed } from "./seed";

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
  const seen: [bigint, bigint][] = [];
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
      seen.push([fromBlock, toBlock]);
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
  return { bittensor, counts, receiptsFor, seen };
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

/** Polls `account`'s history until the browser's own check has finished (or `rounds` polls), advancing the clock. */
async function untilCheckedFor(v: ReturnType<typeof visit>, account: `0x${string}`, clock: { t: number }, rounds = 60) {
  let h = await v.data.getPositionHistory(account).catch(() => undefined);
  for (let i = 0; i < rounds && (h === undefined || h.provisional); i++) {
    clock.t += CHECK_EVERY_MS;
    await settled();
    h = await v.data.getPositionHistory(account).catch(() => undefined);
    await settled();
  }
  return h;
}

/** A Bittensor client for the background check that reads only where `ok` says, else refuses (an archive node that's busy). */
const gated = (n: ReturnType<typeof node>, ok: (q: { fromBlock: bigint; toBlock: bigint }) => boolean | Promise<boolean>) => ({
  ...n.bittensor,
  getLogs: async (q: { fromBlock: bigint; toBlock: bigint }) => ((await ok(q)) ? n.bittensor.getLogs(q) : Promise.reject(new Error("archive busy"))),
});

/** A saved half, as stored. */
const half = (st: ReturnType<typeof memory>, account?: string) =>
  JSON.parse(st.m.get(`cascade.scan.${D.frontDoor.toLowerCase()}.${D.bitBlock}${account ? `.${account.toLowerCase()}` : ""}`) ?? "null") as { v: number; checkedTo?: string; seededTo?: string; staked: { txHash: string }[] } | null;

/** Batch 3 delivered at 4,500 with a 0.02 TAO deposit of ME's; the first stake after it is H(304) at 5,000. */
const CHAIN2 = [...CHAIN, delivered(3n, H(3), 4_500n, H(150)), deposited(H(3), 2n * 10n ** 16n, 2n * 10n ** 22n, 4_500n, H(150))];
const SHARES2 = 8n * 10n ** 22n;
const sharesOf = async (_c: unknown, _d: unknown, a: string) => (a.toLowerCase() === ME.toLowerCase() ? SHARES2 : 0n);
const depositIn3 = { id: "d", kind: "deposit" as const, account: ME, createdAt: T0 + 1, usdcIn: 0n, targetTao: 2n * 10n ** 16n, hashes: {}, batchId: 3n, state: "sent" as const };
const stakeStep = async (v: ReturnType<typeof visit>) => (await v.data.listDeposits(ME)).find((r) => r.id === "d")?.steps.find((s) => s.key === "stake");

describe("the background check's progress belongs to the half it checked (review 2, N1)", () => {
  it("two accounts in one browser: one account's progress never vouches for the deployment half another account's seed wrote", { timeout: 60_000 }, async () => {
    const st = memory();
    // A's first visit: an honest seed; its check reads to block 20,000, then the archive node stops answering
    const s1 = honestHalves(CHAIN2);
    const n1 = node(CHAIN2);
    const a1 = visit(n1, s1, st, () => NOW, D, { clients: { bittensor: n1.bittensor, bittensorHistory: gated(n1, (q) => q.fromBlock <= 20_000n) } as never, readSharesAt: sharesOf as never });
    await a1.data.getPositionHistory(ME).catch(() => undefined);
    for (let i = 0; i < 400; i++) await settled();
    // its progress went into each half it checked, in the same write as that half's events
    expect(half(st)?.checkedTo).toBe("20001");
    expect(half(st, ME)?.checkedTo).toBe("20001");
    // B, in the same browser: a seed whose deployment half leaves out the stake at 5,000; B's own check can't read yet
    const own = { ...s1.own, deposited: [], redeemed: [] };
    const s2 = { shared: { ...s1.shared, staked: s1.shared.staked.filter((s) => s.txHash !== H(304)) }, own };
    const n2 = node(CHAIN2);
    const b = visit(n2, s2, st, () => NOW, D, { clients: { bittensor: n2.bittensor, bittensorHistory: gated(n2, () => false) } as never, readSharesAt: sharesOf as never });
    await b.data.getPositionHistory(OTHER).catch(() => undefined);
    for (let i = 0; i < 50; i++) await settled();
    // B's half replaced the deployment's, with no progress: nobody has checked it
    expect(half(st)?.staked.some((s) => s.txHash === H(304))).toBe(false);
    expect(half(st)?.checkedTo).toBeUndefined();
    // A comes back: its own half resumes from 20,001, but the deployment's half (B's) is checked from its start
    const clock = { t: NOW };
    const n3 = node(CHAIN2);
    const a2 = visit(n3, null, st, () => clock.t, D, { readSharesAt: sharesOf as never });
    a2.opLog.put(depositIn3);
    const h = await untilCheckedFor(a2, ME, clock);
    // the omission was caught, the indexer distrusted, and everything read again from the chain
    expect(indexerDistrusted(st, D, clock.t)).toBe(true);
    expect(h?.provisional).toBeUndefined();
    // 0.08 now + 0.01 out − (0.07 + 0.02) in
    expect(h?.rewardsEarnedTao).toBeCloseTo(0, 12);
    // the trail links the real first stake after the delivery at 4,500: H(304) at 5,000, never the later one
    const stake = await stakeStep(a2);
    expect(stake?.status).toBe("done");
    expect(stake?.txUrl).toContain(H(304).slice(2));
    // what is saved now is the browser's own reading: no mark, no progress
    expect(half(st)?.checkedTo).toBeUndefined();
    expect(half(st)?.seededTo).toBeUndefined();
  });

  it("two tabs on one account racing a first visit with different seeds: each checks its own seed from its start, never from the other tab's progress", { timeout: 60_000 }, async () => {
    // a 0.02 TAO deposit and a full redeem paying 0.025 TAO: the shares add up, so only the check can see them left out
    const pair = [delivered(5n, H(5), 1_000n, H(106)), deposited(H(5), 2n * 10n ** 16n, 2n * 10n ** 22n, 1_000n, H(106)), delivered(6n, H(6), 1_500n, H(107)), redeemed(H(6), 25n * 10n ** 15n, 2n * 10n ** 22n, 1_500n, H(107))];
    const chain = [...CHAIN, ...pair];
    const honest = honestHalves(chain);
    const omitted = { shared: honest.shared, own: honestHalves(CHAIN).own };
    const st = memory();
    const clock = { t: NOW };
    const n1 = node(chain);
    const n2 = node(chain);
    let up = false;
    const asked = { t1: 0, t2: 0 };
    const t1 = visit(n1, honest, st, () => clock.t, D, {
      clients: { bittensor: n1.bittensor, bittensorHistory: gated(n1, (q) => q.fromBlock <= 20_000n) } as never,
      fetchSeed: async () => (asked.t1++, honest) as never,
    });
    const t2 = visit(n2, omitted, st, () => clock.t, D, {
      clients: { bittensor: n2.bittensor, bittensorHistory: gated(n2, () => up) } as never,
      fetchSeed: async () => (asked.t2++, omitted) as never,
    });
    // both tabs open on an empty browser: each takes its own seed
    await Promise.all([t1.data.getPositionHistory(ME).catch(() => undefined), t2.data.getPositionHistory(ME).catch(() => undefined)]);
    expect(asked).toEqual({ t1: 1, t2: 1 });
    // tab 1's check of the honest seed gets to 20,001 and stops, saving its progress
    for (let i = 0; i < 400; i++) await settled();
    // tab 2's check can read now: it starts from its own seed's first block, whatever tab 1 wrote
    up = true;
    const h = await untilCheckedFor(t2, ME, clock);
    // 0.08 now + 0.035 out − 0.09 in: the pair tab 2's seed left out is counted
    expect(h?.rewardsEarnedTao).toBeCloseTo(0.025, 12);
    expect(indexerDistrusted(st, D, clock.t)).toBe(true);
  });

  it("a seed of another account overwriting the deployment half while this account's check is mid-run: the run goes on with its own seed, and the other's omission is still caught", { timeout: 60_000 }, async () => {
    const st = memory();
    const clock = { t: NOW };
    // A's check reads to 10,000, then waits (an archive node that's slow) until released
    let release!: () => void;
    const released = new Promise<boolean>((r) => (release = () => r(true)));
    const s1 = honestHalves(CHAIN2);
    const n1 = node(CHAIN2);
    const a = visit(n1, s1, st, () => clock.t, D, {
      clients: { bittensor: n1.bittensor, bittensorHistory: gated(n1, (q) => (q.fromBlock <= 10_000n ? true : released)) } as never,
      readSharesAt: sharesOf as never,
    });
    a.opLog.put(depositIn3);
    expect((await a.data.getPositionHistory(ME)).provisional).toBe(true);
    for (let i = 0; i < 200; i++) await settled();
    // B's seed, leaving out the stake at 5,000, replaces the deployment half meanwhile; B's own check can't read yet
    let bUp = false;
    const s2 = { shared: { ...s1.shared, staked: s1.shared.staked.filter((s) => s.txHash !== H(304)) }, own: { ...s1.own, deposited: [], redeemed: [] } };
    const n2 = node(CHAIN2);
    const b = visit(n2, s2, st, () => clock.t, D, { clients: { bittensor: n2.bittensor, bittensorHistory: gated(n2, () => bUp) } as never, readSharesAt: sharesOf as never });
    await b.data.getPositionHistory(OTHER).catch(() => undefined);
    for (let i = 0; i < 50; i++) await settled();
    expect(half(st)?.staked.some((s) => s.txHash === H(304))).toBe(false);
    // A's run goes on, against A's own seed in memory, to the end: right, and nobody blamed
    release();
    const h = await untilCheckedFor(a, ME, clock);
    expect(h?.provisional).toBeUndefined();
    expect(h?.rewardsEarnedTao).toBeCloseTo(0, 12);
    expect(indexerDistrusted(st, D, clock.t)).toBe(false);
    expect((await stakeStep(a))?.txUrl).toContain(H(304).slice(2));
    // B's tab still holds its own seed: its check, once it can read, catches what it left out
    bUp = true;
    await untilCheckedFor(b, OTHER, clock);
    expect(indexerDistrusted(st, D, clock.t)).toBe(true);
  });

  it("a reload resumes each half from the progress saved inside it, and a scan that starts over keeps none", { timeout: 60_000 }, async () => {
    const st = memory();
    const clock = { t: NOW };
    const n1 = node();
    // the first visit's check reads to 12,000, then stops
    const v1 = visit(n1, honestHalves(), st, () => clock.t, D, { clients: { bittensor: n1.bittensor, bittensorHistory: gated(n1, (q) => q.fromBlock <= 12_000n) } as never });
    await v1.data.getPositionHistory(ME);
    for (let i = 0; i < 300; i++) await settled();
    expect(half(st)?.checkedTo).toBe("12001");
    // a reload: the check reads on from 12,001, never the blocks below again
    const n2 = node();
    const v2 = visit(n2, null, st, () => clock.t);
    const h = await untilCheckedFor(v2, ME, clock);
    expect(h?.provisional).toBeUndefined();
    // the check's windows (the scan's own reads near the head aside): from 12,001, none below
    const checked = n2.seen.filter(([from]) => from < 29_000n);
    expect(checked[0]).toEqual([12_001n, 13_000n]);
    expect(checked.every(([from]) => from >= 12_001n)).toBe(true);
    expect(half(st)?.seededTo).toBeUndefined();
    // a scan that starts over (the chain contradicted the saved history) keeps no progress of the check
    const n3 = node();
    const st2 = memory();
    const lying = honestHalves(CHAIN.filter((l) => l.transactionHash !== H(305)));
    const v3 = visit(n3, lying, st2, () => clock.t, D, { clients: { bittensor: n3.bittensor, bittensorHistory: gated(n3, (q) => q.fromBlock <= 3_000n) } as never });
    await v3.data.getPositionHistory(ME).catch(() => undefined);
    for (let i = 0; i < 200; i++) await settled();
    expect(half(st2)?.checkedTo).toBe("3001");
    const v4 = visit(node(), null, st2, () => clock.t);
    await untilCheckedFor(v4, ME, clock);
    expect(indexerDistrusted(st2, D, clock.t)).toBe(true);
    expect(half(st2)?.checkedTo).toBeUndefined();
  });
});

describe("what can be unstaked on the Unstake page alone (review 2, N2)", () => {
  const w3 = { id: "w3", kind: "withdrawal" as const, account: ME, createdAt: T0 + 1, shares: 2n * 10n ** 21n, taoEstimate: 0n, usdcEstimate: 0n, fee: 0n, batchId: 3n, state: "sent" as const };
  /** csTAO less the open batch's request and the unstake in batch 3, which hasn't arrived. */
  const AWAY = 8n * 10n ** 22n - 10n ** 21n - 2n * 10n ** 21n;

  it("keeps an unstake whose delivery the scan lacks at checking (never a low figure) while seeded blocks are unread, whatever openStart says, until the check started from this page alone has read them", { timeout: 60_000 }, async () => {
    for (const fdNow of [
      fd, // batch 3 is the one before the open one, and openStart is after the seed's last block: no proof of when it closed
      { ...fd, openBatchId: 4n, openStart: 1_700_000_000 },
      { ...fd, openBatchId: 5n },
    ]) {
      const clock = { t: NOW };
      const n = node();
      const storage = memory();
      const v = visit(n, honestHalves(), storage, () => clock.t, D, { readFrontDoor: async () => fdNow });
      v.opLog.put(w3);
      let a = await v.data.getAvailable(ME);
      expect(a.checking).toBe(true);
      expect(a.availableShares).toBe(0n);
      for (let i = 0; i < 40 && a.checking; i++) {
        clock.t += CHECK_EVERY_MS;
        await settled();
        a = await v.data.getAvailable(ME);
        await settled();
      }
      expect(a.checking).toBeUndefined();
      expect(a.availableShares).toBe(AWAY);
      expect(createScanStore(storage, D).load(ME).sharedSeededTo).toBeUndefined();
      expect(indexerDistrusted(v.storage, D, clock.t)).toBe(false);
    }
  });
});

describe("an empty batch rolled after the seed's last block (review 3, R3-1)", () => {
  // batch 3 arrived at 25,000, burning the account's 2e21 shares; the seed leaves its delivery out. The open
  // batch, 4, was rolled empty after the seed's last block (closeBatch on an empty batch restarts its timer
  // without a new id), so fd.openStart is long after batch 3 really closed
  const CHAIN3 = [...CHAIN, delivered(3n, H(3), 25_000n, H(160)), redeemed(H(3), 10n ** 16n, 2n * 10n ** 21n, 25_000n, H(160))];
  const omittedSeed = () => {
    const h = honestHalves(CHAIN3);
    return { shared: { ...h.shared, delivered: h.shared.delivered.filter((e) => e.batchId !== "3") }, own: h.own };
  };
  const w3 = { id: "w3", kind: "withdrawal" as const, account: ME, createdAt: T0 + 1, shares: 2n * 10n ** 21n, taoEstimate: 0n, usdcEstimate: 0n, fee: 0n, batchId: 3n, state: "sent" as const };
  /** Honest: batch 3 arrived, so only the open batch's request is still asked. */
  const HONEST = 8n * 10n ** 22n - 10n ** 21n;

  it("never takes an omitted delivery of the batch before the open one for absent: Available is checking, not low, and the unstake's step is checking", { timeout: 30_000 }, async () => {
    const n = node(CHAIN3);
    // the request is mined on Base: its trail goes as far as the chain can say
    const base = { getTransactionReceipt: async () => ({ status: "success", logs: [] }) };
    const v = visit(n, omittedSeed(), memory(), () => NOW, D, { checkPaceMs: 1e9, clients: { bittensor: n.bittensor, base } as never, readSharesAt: async () => SHARES - 2n * 10n ** 21n });
    v.opLog.put({ ...w3, hash: H(930) });
    const a = await v.data.getAvailable(ME);
    expect(a.checking).toBe(true);
    expect(a.availableShares).not.toBe(HONEST - 2n * 10n ** 21n);
    const w = (await v.data.listWithdrawals(ME)).find((r) => r.id === "w3");
    expect(w?.steps.find((s) => s.key === "unstake")?.status).toBe("checking");
  });

  it("finds the omission once the check, started from the Unstake page alone, reads those blocks: the indexer is distrusted and the figure is the honest one", { timeout: 60_000 }, async () => {
    const clock = { t: NOW };
    const n = node(CHAIN3);
    const v = visit(n, omittedSeed(), memory(), () => clock.t, D, { readSharesAt: async () => SHARES - 2n * 10n ** 21n });
    v.opLog.put(w3);
    let a = await v.data.getAvailable(ME).catch(() => undefined);
    for (let i = 0; i < 40 && (a === undefined || a.checking); i++) {
      if (a && !a.checking) break;
      clock.t += CHECK_EVERY_MS;
      await settled();
      a = await v.data.getAvailable(ME).catch(() => undefined);
      await settled();
    }
    expect(indexerDistrusted(v.storage, D, clock.t)).toBe(true);
    a = await v.data.getAvailable(ME);
    expect(a.checking).toBeUndefined();
    expect(a.availableShares).toBe(HONEST);
  });
});

describe("the minor findings of review 2", () => {
  it("never calls a deposit whose arrival is still being checked 'on its way' toward the staking minimum (minor 9)", { timeout: 60_000 }, async () => {
    // batch 1 long ago; batch 5 after the seed's blocks, read by the browser itself; nothing staked since
    const chain = [delivered(1n, H(1), 500n, H(101)), deposited(H(1), 7n * 10n ** 16n, 7n * 10n ** 22n, 500n, H(101)), delivered(5n, H(5), 29_950n, H(155)), deposited(H(5), 10n ** 16n, 10n ** 22n, 29_950n, H(155))];
    const n = node(chain);
    const base = { getTransactionReceipt: async () => ({ status: "success", logs: [] }) };
    const v = visit(n, honestHalves(chain.slice(0, 2)), memory(), () => NOW, D, {
      clients: { bittensor: n.bittensor, bittensorHistory: gated(n, () => false), base } as never,
      readFrontDoor: async () => ({ ...fd, openBatchId: 7n }),
      readVault: async () => ({ ...vault, rootStakeWei: 0n, balanceWei: 10n ** 16n + 10n ** 12n }),
      readSharesAt: async () => 7n * 10n ** 22n,
    });
    const sent = (id: string, batchId: bigint, targetTao: bigint) => ({ id, kind: "deposit" as const, account: ME, createdAt: T0 + 1, usdcIn: 0n, targetTao, hashes: { deposit: H(900 + Number(batchId)) }, batchId, state: "sent" as const });
    v.opLog.put(sent("d5", 5n, 10n ** 16n));
    // batch 3 closed before the open one's predecessor: its delivery may be in the seeded blocks not read yet
    v.opLog.put(sent("d3", 3n, 15n * 10n ** 15n));
    const list = await v.data.listDeposits(ME);
    expect(list.find((r) => r.id === "d3")?.steps.find((s) => s.key === "bridge")?.status).toBe("checking");
    const stake = list.find((r) => r.id === "d5")?.steps.find((s) => s.key === "stake");
    expect(stake?.summary).toContain("minimum");
    expect(stake?.detail).not.toContain("on its way");
    expect(stake?.detail).toContain("staked once 0.0100 TAO more arrives");
  });
});
