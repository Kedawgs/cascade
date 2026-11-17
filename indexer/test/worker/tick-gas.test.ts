import { env } from "cloudflare:workers";
import type { Hex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { runDaily } from "../../src/daily.ts";
import { amountTo, formatSpend, parseSpend, type SpendTotal, spendKey } from "../../src/gas.ts";
import { compactHour, expand, expandHour, type HourAgg } from "../../src/snapshot.ts";
import { loadTickState, upsertHour } from "../../src/store.ts";
import { keeperSpend } from "../../src/tick.ts";
import deploymentV32 from "../fixtures/deployment-v3.2.json";
import { wipe } from "./d1-count.ts";
import { KEEPER } from "./fake-deployment.ts";
import { TEST_URLS } from "./fake-rpc.ts";
import { baseState, bitState, reading } from "./rule-ctx.ts";
import { rows, type SentEmail, T0, type TickWorld, tickWorld } from "./tick-world.ts";

// The keeper's spend through the tick (src/gas.ts): each chain's running total (meta keeper_spend:<chain>) loaded with
// the tick's state, stepped with this tick's reading of the keeper's balance, written in commit 1 only when it moved,
// and the tick's count added to the hour row. No request of its own to a chain, no query of its own to D1.

const db = env.DB;
const OTHER = "0x00000000000000000000000000000000000000b3" as Hex;
/** 0.001 of a coin */
const M = 10n ** 15n;

beforeEach(async () => {
  await wipe(db);
});

/** A v3.2 world (the live deployment's shape), the keeper holding `eth` on Base and `tao` on Bittensor. */
const world = (eth: bigint, tao: bigint) =>
  tickWorld({
    over: { DEPLOYMENT: JSON.stringify(deploymentV32) },
    setup: (s) => {
      s.base.keeperBalance = eth;
      s.bit.keeperBalance = tao;
    },
  });
/** The next minute's tick, the keeper's balances set first when given. */
async function next(w: TickWorld, o: { eth?: bigint; tao?: bigint; db?: D1Database } = {}) {
  if (o.eth !== undefined) w.state.base.keeperBalance = o.eth;
  if (o.tao !== undefined) w.state.bit.keeperBalance = o.tao;
  w.advance();
  expect((await w.tick({ db: o.db })).outcome).toBe("done");
}
const stored = async (chain: "base" | "bittensor") => (await rows<{ v: string }>(`SELECT v FROM meta WHERE k = '${spendKey(chain)}'`))[0]?.v;
const total = async (chain: "base" | "bittensor") => parseSpend(await stored(chain));
const hourRow = async () => expandHour((await rows<{ json: string }>("SELECT json FROM hours ORDER BY hour DESC LIMIT 1"))[0].json) as HourAgg;
/** the stored readings, oldest first */
const readings = async () => (await rows<{ json: string }>("SELECT json FROM readings ORDER BY at")).map((r) => expand(r.json));

/** A D1Database that keeps every statement it is asked to write or read, a batch at a time (its SQL and bound values). */
function recordingDb(real: D1Database) {
  const batches: { sql: string; values: unknown[] }[][] = [];
  const info = new WeakMap<object, { sql: string; values: unknown[]; stmt: D1PreparedStatement }>();
  const wrap = (stmt: D1PreparedStatement, sql: string, values: unknown[]): D1PreparedStatement => {
    const one = <T>(run: () => Promise<T>) => {
      batches.push([{ sql, values }]);
      return run();
    };
    const w = {
      bind: (...v: unknown[]) => wrap(stmt.bind(...v), sql, v),
      all: () => one(() => stmt.all()),
      run: () => one(() => stmt.run()),
      first: (c?: string) => one(() => (c === undefined ? stmt.first() : stmt.first(c))),
      raw: (o?: { columnNames?: boolean }) => one(() => stmt.raw(o as never)),
    } as unknown as D1PreparedStatement;
    info.set(w, { sql, values, stmt });
    return w;
  };
  return {
    batches,
    db: {
      prepare: (sql: string) => wrap(real.prepare(sql), sql, []),
      async batch(stmts: D1PreparedStatement[]) {
        batches.push(stmts.map((s) => ({ sql: info.get(s)?.sql ?? "?", values: info.get(s)?.values ?? [] })));
        return real.batch(stmts.map((s) => info.get(s)?.stmt ?? s));
      },
      exec: (sql: string) => real.exec(sql),
      withSession: () => real.withSession(),
      dump: () => real.dump(),
    } as unknown as D1Database,
  };
}
/** The totals a recorded tick wrote, by their meta keys. */
const spendWrites = (rec: ReturnType<typeof recordingDb>) =>
  rec.batches
    .flat()
    .filter((s) => s.sql.startsWith("INSERT INTO meta") && String(s.values[0]).startsWith("keeper_spend:"))
    .map((s) => String(s.values[0]));

describe("the keeper's spend, through the tick", () => {
  it("falls only: the launch keeper's two stakes and its gas on Base, counted from the first reading of its balance, and written only on a tick its balance moved", async () => {
    // funded with 0.03 ETH and 0.4999995 TAO
    const w = world(30n * M, 499_999_500_000_000_000n);
    expect((await w.tick()).outcome).toBe("done");
    // the first reading names the keeper; its balance is read from the next one on: nothing to step, nothing kept
    expect((await readings())[0].base?.state).not.toHaveProperty("keeperBalance");
    expect(await rows("SELECT k FROM meta WHERE k LIKE 'keeper_spend:%'")).toEqual([]);
    for (const k of ["keeperEthSpent", "keeperEthAdded", "keeperTaoSpent", "keeperTaoAdded"]) expect(await hourRow(), k).not.toHaveProperty(k);

    await next(w);
    // the first balance read is where the count starts: nothing spent yet, as of that reading's block
    const [, second] = await readings();
    expect(second.base?.time).toBe(T0 + 60);
    expect(await total("base")).toEqual({ since: T0 + 60, spent: 0n, last: 30n * M, keeper: KEEPER });
    expect(await total("bittensor")).toEqual({ since: second.bittensor?.time, spent: 0n, last: 499_999_500_000_000_000n, keeper: KEEPER });
    // the hour says it counted both chains (0 is a count, not a gap), and saw no top-up
    expect(await hourRow()).toMatchObject({ keeperEthSpent: 0n, keeperTaoSpent: 0n });
    expect(await hourRow()).not.toHaveProperty("keeperEthAdded");
    expect(await hourRow()).not.toHaveProperty("keeperTaoAdded");

    // a stake of 0.00086911 TAO, and 0.0000002 ETH of gas on Base
    await next(w, { eth: 29_999_800_000_000_000n, tao: 499_130_390_000_000_000n });
    expect((await total("bittensor"))?.spent).toBe(869_110_000_000_000n);
    expect((await total("base"))?.spent).toBe(200_000_000_000n);

    // a minute in which neither balance moved: no total is written (every row written counts against D1's quota), and
    // the hour's count stays
    const quiet = recordingDb(db);
    const before = { base: await stored("base"), bittensor: await stored("bittensor"), fetches: w.net.fetches.length };
    await next(w, { db: quiet.db });
    const quietFetches = w.net.fetches.length - before.fetches;
    expect(spendWrites(quiet)).toEqual([]);
    expect(await stored("base")).toBe(before.base);
    expect(await stored("bittensor")).toBe(before.bittensor);
    expect(await hourRow()).toMatchObject({ ticks: 4, keeperEthSpent: 200_000_000_000n, keeperTaoSpent: 869_110_000_000_000n });

    // the second stake, 0.00069817 TAO; Base's didn't move: one total written, Bittensor's, in the tick's own commit
    const moved = recordingDb(db);
    const fetched = w.net.fetches.length;
    await next(w, { tao: 498_432_220_000_000_000n, db: moved.db });
    expect(spendWrites(moved)).toEqual(["keeper_spend:bittensor"]);
    const commit = moved.batches.find((b) => b[0].sql.startsWith("INSERT INTO guard"));
    expect(commit?.some((s) => s.values[0] === "keeper_spend:bittensor")).toBe(true);
    // the same queries of D1 as the quiet tick, and the same requests to the chains
    expect(moved.batches.length).toBe(quiet.batches.length);
    expect(w.net.fetches.length - fetched).toBe(quietFetches);

    await next(w, { eth: 29_999_550_000_000_000n });
    const tao = (await total("bittensor")) as SpendTotal;
    const eth = (await total("base")) as SpendTotal;
    expect(tao).toEqual({ since: second.bittensor?.time, spent: 1_567_280_000_000_000n, last: 498_432_220_000_000_000n, keeper: KEEPER });
    expect(eth).toEqual({ since: T0 + 60, spent: 450_000_000_000n, last: 29_999_550_000_000_000n, keeper: KEEPER });
    expect(amountTo(tao.spent, 6)).toBe("0.001567");
    expect(amountTo(eth.spent, 8)).toBe("0.00000045");
    // the hour row carries the same, summed tick by tick through its own write and read, and no rise
    const h = await hourRow();
    expect(h).toMatchObject({ ticks: 6, keeperEthSpent: 450_000_000_000n, keeperTaoSpent: 1_567_280_000_000_000n });
    expect(h).not.toHaveProperty("keeperEthAdded");
    expect(h).not.toHaveProperty("keeperTaoAdded");
  });

  it("a top-up between falls: the rise is no spend and hides none, and the hour row says a rise was seen", async () => {
    const w = world(100n * M, 500n * M);
    await w.tick();
    await next(w);
    await next(w, { tao: 480n * M });
    await next(w, { tao: 600n * M });
    // (a difference of the two ends would say 100 more, or nothing spent)
    expect(await total("bittensor")).toMatchObject({ spent: 20n * M, last: 600n * M });
    await next(w, { tao: 570n * M });
    expect(await total("bittensor")).toMatchObject({ spent: 50n * M, last: 570n * M, keeper: KEEPER });
    const h = await hourRow();
    expect(h).toMatchObject({ keeperTaoSpent: 50n * M, keeperTaoAdded: 120n * M, keeperEthSpent: 0n });
    // Base's keeper was never topped up
    expect(h).not.toHaveProperty("keeperEthAdded");
    expect(await total("base")).toMatchObject({ spent: 0n, last: 100n * M });
  });

  it("an unread balance steps nothing, and what fell meanwhile is counted by the next reading that has one", async () => {
    const w = world(100n * M, 500n * M);
    await w.tick();
    await next(w);
    await next(w, { tao: 490n * M });
    const before = await stored("bittensor");

    // no reading of Bittensor at all (its node is down) while its keeper spends: nothing stepped, nothing written
    w.fail((url) => (url === TEST_URLS.bittensor ? new Error("down") : undefined));
    const down = recordingDb(db);
    await next(w, { tao: 470n * M, eth: 99n * M, db: down.db });
    expect((await readings()).at(-1)?.bittensor).toBeUndefined();
    expect(spendWrites(down)).toEqual(["keeper_spend:base"]);
    expect(await stored("bittensor")).toBe(before);
    expect(await hourRow()).toMatchObject({ keeperTaoSpent: 10n * M, keeperEthSpent: M });
    w.fail(undefined);

    // a reading that doesn't name the keeper: the one after it is read, its keeper's balance isn't (no one to read it of)
    w.state.reverts.add("vault.keeper");
    await next(w);
    // (this one's balance was still read, of the keeper the reading before named: the 20 that fell while the node was down)
    expect((await total("bittensor"))?.spent).toBe(30n * M);
    expect((await readings()).at(-1)?.bittensor?.state).not.toHaveProperty("keeper");
    w.state.reverts.delete("vault.keeper");
    const unread = recordingDb(db);
    await next(w, { tao: 455n * M, db: unread.db });
    const last = (await readings()).at(-1);
    expect(last?.bittensor).toBeDefined();
    expect(last?.bittensor?.state).not.toHaveProperty("keeperBalance");
    expect(spendWrites(unread)).toEqual([]);
    expect(await total("bittensor")).toMatchObject({ spent: 30n * M, last: 470n * M });
    expect(await hourRow()).toMatchObject({ keeperTaoSpent: 30n * M });

    // the next reading has it again: compared with the last balance counted, so the 15 isn't lost
    await next(w);
    expect(await total("bittensor")).toMatchObject({ spent: 45n * M, last: 455n * M, keeper: KEEPER });
    expect(await hourRow()).toMatchObject({ keeperTaoSpent: 45n * M, keeperEthSpent: M });
    expect(await hourRow()).not.toHaveProperty("keeperTaoAdded");
  });

  it("the first run: with no total, the count is seeded from the stored readings in hand (the six the tick loads), the oldest left out", async () => {
    // seven readings stored by the version before this one, the keeper's TAO falling by 10, 20, 30, 40 and 50; then no
    // total and no count in the hour row, as that version left them
    const w = world(100n * M, 1000n * M);
    await w.tick();
    await next(w);
    for (const tao of [990n, 970n, 940n, 900n, 850n]) await next(w, { tao: tao * M });
    await db.batch([db.prepare("DELETE FROM meta WHERE k LIKE 'keeper_spend:%'"), db.prepare("DELETE FROM hours")]);
    const inHand = (await readings()).slice(-6);
    expect(inHand.map((r) => r.bittensor?.state.keeperBalance)).toEqual([1000n * M, 990n * M, 970n * M, 940n * M, 900n * M, 850n * M]);

    // this version's first tick, the keeper 60 lower again: the oldest in hand isn't counted from (the tick doesn't hold
    // the reading that named the keeper it was read of), so the count starts at the second, and the 10 before it is out
    await next(w, { tao: 790n * M });
    expect(await total("bittensor")).toEqual({ since: inHand[1].bittensor?.time, spent: (20n + 30n + 40n + 50n + 60n) * M, last: 790n * M, keeper: KEEPER });
    expect(await total("base")).toEqual({ since: inHand[1].base?.time, spent: 0n, last: 100n * M, keeper: KEEPER });
    // and the hour row has what was counted
    expect(await hourRow()).toMatchObject({ ticks: 1, keeperTaoSpent: 200n * M, keeperEthSpent: 0n });

    // from then on it goes on from the total, a reading at a time: its start is kept
    await next(w, { tao: 780n * M });
    expect(await total("bittensor")).toEqual({ since: inHand[1].bittensor?.time, spent: 210n * M, last: 780n * M, keeper: KEEPER });
    expect(await hourRow()).toMatchObject({ ticks: 2, keeperTaoSpent: 210n * M });
  });

  it("a total that doesn't read is no total: the count starts again from the readings in hand, and its date says so", async () => {
    const w = world(100n * M, 500n * M);
    await w.tick();
    await next(w);
    await next(w, { eth: 99n * M });
    await db.prepare("UPDATE meta SET v = '{\"since\":1,\"spent\":\"x\"}' WHERE k = 'keeper_spend:base'").run();
    await next(w, { eth: 97n * M });
    const rs = await readings();
    expect(await total("base")).toEqual({ since: rs[1].base?.time, spent: 3n * M, last: 97n * M, keeper: KEEPER });
  });

  it("a changed keeper (setKeeper): the new one's balance is never compared with the old one's, neither a spend nor a top-up, and its falls count on", async () => {
    const w = world(100n * M, 500n * M);
    await w.tick();
    await next(w);
    await next(w, { eth: 90n * M });
    expect(await total("base")).toMatchObject({ spent: 10n * M, last: 90n * M, keeper: KEEPER });

    // the front door names another keeper, holding 0.7 ETH; the old one keeps its 0.09
    w.state.base.keeper = OTHER;
    w.state.base.ethOf[KEEPER] = 90n * M;
    await next(w, { eth: 700n * M });
    // this reading's balance is still the old keeper's (the one the reading before named): unmoved
    expect(await total("base")).toMatchObject({ spent: 10n * M, last: 90n * M, keeper: KEEPER });
    await next(w);
    expect(await total("base")).toMatchObject({ spent: 10n * M, last: 700n * M, keeper: OTHER });
    expect(await hourRow()).toMatchObject({ keeperEthSpent: 10n * M });
    expect(await hourRow()).not.toHaveProperty("keeperEthAdded");
    await next(w, { eth: 695n * M });
    expect(await total("base")).toMatchObject({ spent: 15n * M, last: 695n * M, keeper: OTHER });
    expect(await hourRow()).toMatchObject({ keeperEthSpent: 15n * M });
    expect(await hourRow()).not.toHaveProperty("keeperEthAdded");
  });
});

describe("from the ticks to the email: the daily job's Gas section, from what the ticks stored", () => {
  it("the first day says what it can't know yet; a day on, the last 24 hours are the hours since, and the total is everything since its date", async () => {
    const w = tickWorld({
      over: { DEPLOYMENT: JSON.stringify(deploymentV32), ALERT_MODE: "send", ALERT_TO: "owner@example.com" },
      setup: (s) => {
        s.base.keeperBalance = 100n * M;
        s.bit.keeperBalance = 500n * M;
      },
    });
    const sent: SentEmail[] = [];
    const email = { send: async (m: SentEmail) => void sent.push(m) } as unknown as SendEmail;
    const gasOf = async () => {
      expect((await runDaily({ env: { DB: db, EMAIL: email }, cfg: w.cfg, nowS: w.nowS() + 30, fetch: w.net.fetch })).digest).toBe("sent");
      const text = sent.at(-1)?.text ?? "";
      const from = text.indexOf("Gas\n");
      return text.slice(from, text.indexOf("\n\n", from)).split("\n");
    };
    await w.tick();
    await next(w);
    await next(w, { tao: 480n * M });
    // 15 Jan 2027, a few minutes after the count began (T0 is 08:00 UTC that day)
    expect(await gasOf()).toEqual([
      "Gas",
      "keeper on Base: 0.1 ETH",
      "keeper on Bittensor: 0.48 TAO",
      "guardian on Base: 0.001 ETH",
      "guardian on Bittensor: 0.01 TAO",
      "keeper spent on Base, last 24 hours: not enough history yet",
      "keeper spent on Base, last 7 days: not enough history yet",
      "keeper spent on Base, since 15 Jan 2027: 0 ETH",
      "keeper spent on Bittensor, last 24 hours: not enough history yet",
      "keeper spent on Bittensor, last 7 days: not enough history yet",
      "keeper spent on Bittensor, since 15 Jan 2027: 0.02 TAO",
    ]);

    // 25 hours on: the keeper sent a transaction on each chain since, and was sent 0.05 ETH after its own on Base
    w.advance(25 * 60 - 1);
    await next(w, { tao: 477n * M, eth: 99n * M });
    await next(w, { eth: 149n * M });
    expect(await gasOf()).toEqual([
      "Gas",
      "keeper on Base: 0.149 ETH",
      "keeper on Bittensor: 0.477 TAO",
      "guardian on Base: 0.001 ETH",
      "guardian on Bittensor: 0.01 TAO",
      "keeper spent on Base, last 24 hours: 0.001 ETH (topped up in this window)",
      "keeper spent on Base, last 7 days: not enough history yet",
      "keeper spent on Base, since 15 Jan 2027: 0.001 ETH",
      // the first day's 0.02 is outside the day, and in the total
      "keeper spent on Bittensor, last 24 hours: 0.003 TAO",
      "keeper spent on Bittensor, last 7 days: not enough history yet",
      "keeper spent on Bittensor, since 15 Jan 2027: 0.023 TAO",
    ]);
  });
});

describe("the tick's step by itself (keeperSpend): what the fake chains can't be made to answer", () => {
  /** a Bittensor reading `n` minutes after T0, naming `keeper`, its keeper balance as read (of the keeper the one before named) */
  const r = (n: number, keeper: Hex | undefined, keeperBalance?: bigint) => reading(BigInt(100 + n), T0 + 60 * n, bitState({ keeper, keeperBalance }));
  const kept = { since: T0, spent: 7n, last: 500n, keeper: KEEPER };
  const meta = { "keeper_spend:bittensor": formatSpend(kept) };
  const nothing = { totals: {}, tick: {} };

  it("a reading whose keeper balance is unread (its call failed in the multicall) steps nothing, with a total or without: never read as a balance of 0", () => {
    const history = { base: [], bittensor: [r(2, KEEPER, 500n), r(1, KEEPER, 510n)] };
    expect(keeperSpend(meta, history, { bittensor: r(3, KEEPER) })).toEqual(nothing);
    expect(keeperSpend({}, history, { bittensor: r(3, KEEPER) })).toEqual(nothing);
    // nor does a tick with no reading of the chain
    expect(keeperSpend(meta, history, {})).toEqual(nothing);
    // (the same reading with its balance: the 10 it fell by)
    expect(keeperSpend(meta, history, { bittensor: r(3, KEEPER, 490n) })).toEqual({ totals: { bittensor: { ...kept, spent: 17n, last: 490n } }, tick: { bittensor: { spent: 10n, added: 0n } } });
  });

  it("a balance with no keeper named by the reading before it is no one's: nothing is stepped", () => {
    expect(keeperSpend(meta, { base: [], bittensor: [r(2, undefined, 500n)] }, { bittensor: r(3, KEEPER, 400n) })).toEqual(nothing);
    expect(keeperSpend({}, { base: [], bittensor: [] }, { bittensor: r(3, KEEPER, 400n) })).toEqual(nothing);
  });

  it("the keeper is the same one whatever the case of its letters in the reading, and each chain is stepped by its own total and readings", () => {
    const mixed = "0x00000000000000000000000000000000000000A3" as Hex;
    const base = (n: number, keeperBalance?: bigint) => reading(BigInt(900 + n), T0 + 60 * n, baseState({ keeper: mixed, keeperBalance }));
    const out = keeperSpend(meta, { base: [base(2, 80n), base(1, 90n), base(0, 95n)], bittensor: [r(2, mixed, 500n)] }, { base: base(3, 60n), bittensor: r(3, mixed, 520n) });
    expect(out.totals.bittensor).toEqual({ ...kept, last: 520n });
    expect(out.tick.bittensor).toEqual({ spent: 0n, added: 20n });
    // Base has no total: seeded from its own stored readings (the oldest left out), then this one
    expect(out.totals.base).toEqual({ since: T0 + 60, spent: 30n, last: 60n, keeper: KEEPER });
    expect(out.tick.base).toEqual({ spent: 30n, added: 0n });
  });
});

describe("the hour row's keeper fields, through a write and a read", () => {
  it("keeps the four amounts as bigints, past 2^53 and at 0, through D1 and the tick's own load", async () => {
    const hour = Math.floor(T0 / 3600) * 3600;
    const h: HourAgg = { hour, ticks: 7, spotSum: 0, spotCount: 0, keeperEthSpent: 450_000_000_000n, keeperEthAdded: 0n, keeperTaoSpent: 1_567_280_000_000_000n, keeperTaoAdded: 12_345_678_901_234_567_890_123n };
    await upsertHour(db, hour, compactHour(h)).run();
    const state = await loadTickState(db, T0);
    const back = expandHour(state.hours[0].json) as HourAgg;
    expect(back).toEqual(h);
    for (const k of ["keeperEthSpent", "keeperEthAdded", "keeperTaoSpent", "keeperTaoAdded"] as const) expect(typeof back[k], k).toBe("bigint");
    // a row from before the keeper's spend was kept reads back without them (absent, never 0)
    await upsertHour(db, hour - 3600, compactHour({ hour: hour - 3600, ticks: 60, spotSum: 0, spotCount: 0 })).run();
    const old = expandHour((await loadTickState(db, T0)).hours[1].json) as HourAgg;
    for (const k of ["keeperEthSpent", "keeperEthAdded", "keeperTaoSpent", "keeperTaoAdded"]) expect(old, k).not.toHaveProperty(k);
  });
});
