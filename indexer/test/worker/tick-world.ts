import { env } from "cloudflare:workers";
import { type Abi, type Hex, keccak256, toBytes } from "viem";
import { ADAPTER, BIT_ADAPTER, FRONT_DOOR, VAULT } from "../../src/abi.ts";
import { handleStatus } from "../../src/api.ts";
import type { ChainName, Config } from "../../src/config.ts";
import { encodePayoutsMessage } from "../../src/crosscheck/payouts.ts";
import { batchKey, encodeBatchMessage } from "../../src/crosscheck/replay.ts";
import type { RawLog } from "../../src/logs.ts";
import { poolPriceUsd } from "../../src/prices.ts";
import { runTick, type TickReport } from "../../src/tick.ts";
import { deploymentState, fakeDeployment, KEEPER } from "./fake-deployment.ts";
import { TEST_URLS } from "./fake-rpc.ts";
import { rawLog, testConfig } from "./fixtures.ts";

// A fake world for the tick's tests: both chains (logs encoded as the contracts emit them, every view the
// readings ask), a clock, an email binding that records, and a way to make requests fail.

export const h = (s: string) => keccak256(toBytes(s)) as Hex;
/** The chain time at the first heads (fake-deployment's block times), and the tick's clock 30 s after. */
export const T0 = 1_800_000_000;
export const START_HEADS = { base: 37_000_400n, bittensor: 6_900_200n };

export interface SentEmail {
  to: string | string[];
  subject: string;
  text: string;
}

export function tickWorld(o: { over?: Record<string, unknown>; heads?: { base: bigint; bittensor: bigint } } = {}) {
  const cfg: Config = testConfig({
    PRICE_SOURCES: "[]",
    BASE_RPC_URL: TEST_URLS.base,
    BASE_LOGS_RPC_URL: TEST_URLS.baseLogs,
    BITTENSOR_RPC_URL: TEST_URLS.bittensor,
    ...o.over,
  });
  const state = deploymentState(cfg);
  // a recent claim and no idle TAO: the rules about those stay quiet unless a test wants them
  state.bit.lastClaimAt = BigInt(T0 - 3600);
  state.bit.balance = 10n ** 12n;
  // the oracle at the pools' own price, so twap.divergence stays quiet
  const spot = poolPriceUsd(
    {
      taoWethPool: { sqrtPriceX96: state.base.taoWeth.slot0[0], token0: state.base.taoWeth.token0 },
      wethUsdcPool: { sqrtPriceX96: state.base.wethUsdc.slot0[0], token0: state.base.wethUsdc.token0 },
    },
    cfg.tokens,
  );
  if (spot !== undefined) state.base.oracleValue = BigInt(Math.round(spot * 1e6));
  const heads = o.heads ?? START_HEADS;
  const world = fakeDeployment(cfg, state, { heads: { ...heads } });
  const { specs, net } = world;
  specs.base.logs = [];
  specs.bittensor.logs = [];
  for (const c of ["base", "bittensor"] as const) {
    specs[c].calls = {
      ...specs[c].calls,
      eth_getTransactionByHash: ([hash]) => ({ hash, from: KEEPER, to: c === "base" ? cfg.deployment.frontDoor : cfg.deployment.vault, input: "0x12345678", nonce: "0x1" }),
    };
  }
  const clock = { ms: (T0 + 30) * 1000 };
  /** a request to a URL this answers for gets its answer (a Response, or an Error thrown) instead */
  let failing: ((url: string) => Response | Error | undefined) | undefined;
  /** runs before every request is answered (a slow node moves the clock; a test takes the lease over) */
  let before: ((url: string) => void | Promise<void>) | undefined;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    await before?.(url);
    const f = failing?.(url);
    if (f instanceof Error) throw f;
    if (f) return f;
    return net.fetch(input, init);
  }) as typeof globalThis.fetch;
  const sent: SentEmail[] = [];
  const email = { send: async (m: SentEmail) => void sent.push(m) } as unknown as SendEmail;

  return {
    cfg,
    state,
    specs,
    net,
    sent,
    clock,
    fail(f: typeof failing) {
      failing = f;
    },
    beforeFetch(f: typeof before) {
      before = f;
    },
    addLogs(chain: ChainName, logs: RawLog[]) {
      specs[chain].logs = [...(specs[chain].logs ?? []), ...logs];
    },
    /** one tick at the clock's time; `minute` is the cron's minute (1 unless given: 0 sends db_failing) */
    tick(t: { minute?: number; db?: D1Database; email?: SendEmail; holder?: string; cfg?: Config } = {}): Promise<TickReport> {
      const minute = t.minute ?? 1;
      const scheduled = Math.floor(clock.ms / 3_600_000) * 3_600_000 + minute * 60_000;
      return runTick({
        env: { DB: t.db ?? env.DB, EMAIL: t.email ?? email },
        cfg: t.cfg ?? cfg,
        fetch,
        now: () => clock.ms,
        scheduledMs: scheduled,
        holder: t.holder,
        sleep: async (ms) => {
          clock.ms += ms;
        },
        spacingMs: { base: 0, bittensor: 0 },
      });
    },
    /** a minute later: the clock, and both chains' heads (Base 30 blocks, Bittensor 5) */
    advance(minutes = 1) {
      clock.ms += 60_000 * minutes;
      specs.base.head += 30n * BigInt(minutes);
      specs.bittensor.head += 5n * BigInt(minutes);
    },
    nowS: () => Math.floor(clock.ms / 1000),
    async status() {
      const res = await handleStatus(new Request("https://x/v1/status"), env, cfg, Math.floor(clock.ms / 1000));
      return (await res.json()) as {
        hold: { active: boolean; ids: string[] };
        payouts: { okKeys: string[] };
        indexer: Record<ChainName, { settledTo: number; settledTime: string | null; lagS: number | null } | null>;
        monitor: { lastCompleteTickAt: string | null };
      };
    },
  };
}

export type TickWorld = ReturnType<typeof tickWorld>;

let txn = 0;
const txOf = (label: string) => h(`${label} ${txn++}`);

/** A log the contract at `address` emits, encoded with its ABI. */
const emit = (address: Hex, abi: Abi, eventName: string, args: Record<string, unknown>, at: { block: bigint; txHash: Hex; logIndex: number }) =>
  rawLog({ address, abi, eventName, args, ...at });

/** A batch's whole round trip, as both chains log it: a deposit and a redeem requested on Base, the close,
 * the delivery on Bittensor (the deposit minted, the redeem burned and queued for payout) and, unless
 * `payout` is false, the payout chunk sent from Bittensor and landed on Base. `forge` alters the delivery:
 * another key (a forged batch) or another amount. */
export function roundTrip(
  cfg: Config,
  o: {
    id: bigint;
    payout?: boolean;
    forge?: "key" | "amount";
    blocks?: { request?: bigint; close?: bigint; delivery?: bigint; chunk?: bigint; landing?: bigint };
  },
) {
  const d = cfg.deployment;
  const depositor = `0x${"d".repeat(38)}${o.id.toString(16).padStart(2, "0")}` as Hex;
  const redeemer = `0x${"e".repeat(38)}${o.id.toString(16).padStart(2, "0")}` as Hex;
  const amount = 2n * 10n ** 18n + 123n;
  const shares = 10n ** 18n;
  const assets = 11n * 10n ** 17n;
  const fee = 10n ** 15n;
  const net = assets - fee;
  const b = { request: 37_000_010n, close: 37_000_020n, delivery: 6_900_150n, chunk: 6_900_160n, landing: 37_000_200n, ...o.blocks };
  const key = batchKey(8453n, d.frontDoor, encodeBatchMessage(o.id, [{ user: depositor, amount }], [{ user: redeemer, amount: shares }]));
  const deliveredKey = o.forge === "key" ? h(`forged ${o.id}`) : key;
  const deliveredAmount = o.forge === "amount" ? amount + 1n : amount;
  const m1 = h(`close message ${o.id}`);
  const m2 = h(`payout message ${o.id}`);
  const closeTx = txOf("close");
  const deliveryTx = txOf("delivery");
  const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
  const RAO = 10n ** 9n;

  const base: RawLog[] = [
    emit(d.frontDoor, FRONT_DOOR, "DepositRequested", { batchId: o.id, user: depositor, amount, payer: depositor }, { block: b.request, txHash: txOf("deposit"), logIndex: 0 }),
    emit(d.frontDoor, FRONT_DOOR, "RedeemRequested", { batchId: o.id, user: redeemer, shares }, { block: b.request, txHash: txOf("redeem"), logIndex: 1 }),
    emit(d.baseAdapter, ADAPTER, "Sent", { messageId: m1, destChain: 964n, sender: d.frontDoor, recipient: d.vault, amount, fee: 1n, gasLimit: 1n }, { block: b.close, txHash: closeTx, logIndex: 0 }),
    emit(d.frontDoor, FRONT_DOOR, "BatchClosed", { id: o.id, totalDeposits: amount, nDeposits: 1n, nRedeems: 1n, fee: 1n, potUsed: 1n }, { block: b.close, txHash: closeTx, logIndex: 1 }),
  ];
  let i = 0;
  const at = () => ({ block: b.delivery, txHash: deliveryTx, logIndex: i++ });
  const bit: RawLog[] = [
    emit(d.vault, VAULT, "BatchDelivered", { key: deliveredKey, sourceChain: 8453n, frontDoor: d.frontDoor, batchId: o.id, amount: deliveredAmount }, at()),
    emit(d.vault, VAULT, "Transfer", { from: ZERO, to: depositor, value: 1n }, at()),
    emit(d.vault, VAULT, "Deposited", { key: deliveredKey, user: depositor, assets: amount - (amount % RAO), shares: 1n }, at()),
    emit(d.vault, VAULT, "Transfer", { from: redeemer, to: ZERO, value: shares }, at()),
    emit(d.vault, VAULT, "Redeemed", { key: deliveredKey, user: redeemer, shares, assets }, at()),
    emit(d.vault, VAULT, "PayoutBatchQueued", { key: deliveredKey, sourceChain: 8453n, batchId: o.id, count: 1, total: assets, price: 10n ** 18n }, at()),
    emit(d.bitAdapter, BIT_ADAPTER, "Delivered", { messageId: m1, sourceChain: 8453n, sender: d.frontDoor, recipient: d.vault, amount: deliveredAmount }, at()),
  ];
  const payoutHash = keccak256(encodePayoutsMessage(deliveredKey, 0, [{ user: redeemer, amount: net }]));
  if (o.payout !== false) {
    const chunkTx = txOf("chunk");
    const landTx = txOf("landing");
    bit.push(
      emit(d.bitAdapter, BIT_ADAPTER, "Sent", { messageId: m2, destChain: 8453n, sender: d.vault, recipient: d.frontDoor, amount: net, fee, gasLimit: 1n }, { block: b.chunk, txHash: chunkTx, logIndex: 0 }),
      emit(d.vault, VAULT, "PayoutChunkSent", { key: deliveredKey, chunk: 0, taken: 1, gross: assets, net, fee }, { block: b.chunk, txHash: chunkTx, logIndex: 1 }),
    );
    base.push(
      emit(d.frontDoor, FRONT_DOOR, "PayoutsDelivered", { batchKey: deliveredKey, chunk: 0, amount: net, bridge: d.baseAdapter }, { block: b.landing, txHash: landTx, logIndex: 0 }),
      emit(d.frontDoor, FRONT_DOOR, "PayoutReceived", { batchKey: deliveredKey, chunk: 0, user: redeemer, amount: net }, { block: b.landing, txHash: landTx, logIndex: 1 }),
      emit(d.baseAdapter, ADAPTER, "Delivered", { messageId: m2, sourceChain: 964n, sender: d.vault, recipient: d.frontDoor, amount: net }, { block: b.landing, txHash: landTx, logIndex: 2 }),
    );
  }
  return { key, deliveredKey, base, bit, payoutHash, depositor, redeemer, net, closeTx, deliveryTx };
}

/** A vault Staked log (a seed event) at a block. */
export const stakedLog = (cfg: Config, block: bigint, label = "stake") =>
  emit(cfg.deployment.vault, VAULT, "Staked", { hotkey: cfg.deployment.stakeHotkey, rao: 1000n, measured: 1000n }, { block, txHash: txOf(label), logIndex: 0 });

/** A D1Database whose commit 1 (the batch that starts with the lease's guard) throws while `fail()` says
 * so, as a D1 that can't be written would; every other query goes through. */
export function failingCommits(db: D1Database, fail: () => boolean): D1Database {
  const sqlOf = new WeakMap<object, string>();
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const w = {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql),
      all: () => stmt.all(),
      run: () => stmt.run(),
      first: (c?: string) => (c === undefined ? stmt.first() : stmt.first(c)),
      raw: (o?: { columnNames?: boolean }) => stmt.raw(o as never),
    } as unknown as D1PreparedStatement;
    sqlOf.set(w, sql);
    real.set(w, stmt);
    return w;
  };
  return {
    prepare: (sql: string) => wrap(db.prepare(sql), sql),
    async batch(stmts: D1PreparedStatement[]) {
      if (stmts.length && sqlOf.get(stmts[0])?.startsWith("INSERT INTO guard") && fail()) throw new Error("D1_ERROR: the database is over its limit");
      return db.batch(stmts.map((s) => real.get(s) ?? s));
    },
    exec: (sql: string) => db.exec(sql),
    withSession: () => db.withSession(),
    dump: () => db.dump(),
  } as unknown as D1Database;
}

/** Rows of a table, for assertions. */
export const rows = async <T = Record<string, unknown>>(sql: string): Promise<T[]> => (await env.DB.prepare(sql).all<T>()).results;
