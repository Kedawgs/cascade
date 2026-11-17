import { env } from "cloudflare:workers";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { BASKET_TWR_PREFIX, basketTwrKey, decodeTwr, netApyPercent } from "../../src/apy.ts";
import { buildDigest, digestDue } from "../../src/digest.ts";
import { renderDigest } from "../../src/email.ts";
import { formatSpend } from "../../src/gas.ts";
import type { StoredLog } from "../../src/logs.ts";
import type { HourAgg } from "../../src/snapshot.ts";
import { type AlertRow, type CursorRow, upsertBlocks, upsertLogs } from "../../src/store.ts";
import { D, h } from "./bridge-fixtures.ts";
import { wipe } from "./d1-count.ts";
import { baseState, bitState, reading, slog } from "./rule-ctx.ts";

const db = env.DB;
const E18 = 10n ** 18n;
const NOW = 1_800_000_000;
const ONE = 2n ** 64n;
const DAY = 86_400;

describe("the APY, ported from the site", () => {
  it("keys BasketTwr like the site and decodes U64F64", () => {
    const taoBot = "0x56a9aee6291bd03ab6d36d4d13e2bebae7cd403518066c72fba1b417d6ddd748" as Hex;
    expect(basketTwrKey(taoBot)).toBe(`${BASKET_TWR_PREFIX}6c1664b37fae67165907bd92805ee938${taoBot.slice(2)}`);
    expect(decodeTwr(`0x${"00".repeat(8)}0100000000000000`)).toBe(ONE);
    expect(decodeTwr("0x")).toBeNull();
  });

  it("gives the site's results on the site's test values", () => {
    expect(netApyPercent({ twrNow: (ONE * 1004n) / 1000n, twrThen: ONE, seconds: 30 * DAY, rewardCutBps: 1000 })).toBeCloseTo(4.469, 3);
    const at = (x: number) => BigInt(Math.round(x * 1e12)) * (ONE / 10n ** 12n);
    expect(netApyPercent({ twrNow: at(1.009854518057), twrThen: at(1.005053043487), seconds: 30 * DAY + 17 * 60 + 12, rewardCutBps: 1000 })?.toFixed(2)).toBe("5.36");
    expect(netApyPercent({ twrNow: (ONE * 1004n) / 1000n, twrThen: ONE, seconds: 26 * DAY, rewardCutBps: 1000 })).toBeUndefined();
  });
});

describe("digestDue", () => {
  it("is due once per UTC day", () => {
    expect(digestDue({}, NOW)).toBe(true);
    expect(digestDue({ digest_date: "2027-01-14" }, NOW)).toBe(true);
    expect(digestDue({ digest_date: "2027-01-15" }, NOW)).toBe(false);
    expect(digestDue({ digest_date: "2027-01-15" }, NOW + 16 * 3600)).toBe(true);
  });
});

describe("buildDigest", () => {
  const cursor = (chain: "base" | "bittensor", settledTo: bigint): CursorRow => ({ chain, fromBlock: 1n, scannedTo: settledTo, settledTo, settledTime: NOW - 120, headTime: NOW, updatedAt: NOW });
  const alert = (o: Partial<AlertRow>): AlertRow => ({
    id: 1,
    alertKey: "k",
    rule: "keeper.low_eth",
    tier: "warning",
    kind: "condition",
    subject: "The keeper has 0.0019 ETH on Base",
    body: "",
    runbook: "",
    openedAt: NOW - 3 * 3600,
    lastSeenAt: NOW,
    resolvedAt: null,
    notifiedAt: null,
    notifyCount: 0,
    acknowledgedAt: null,
    ...o,
  });

  async function fixtureDay() {
    await wipe(db);
    const at = (chain: "base" | "bittensor", n: number) => (chain === "base" ? 37_100_000n + BigInt(n) : 6_905_000n + BigInt(n));
    const log = (o: Partial<StoredLog> & Pick<StoredLog, "contract" | "event">, n: number, old = false) =>
      slog({ ...o, block: at(o.chain ?? (o.contract === "vault" ? "bittensor" : "base"), old ? n : 100 + n) });
    const logs = [
      ...[1, 2, 3].map((i) => log({ contract: "frontDoor", event: "BatchClosed", args: { id: String(40 + i), totalDeposits: "0", nDeposits: "0", nRedeems: "0", fee: String(2n * 10n ** 15n), potUsed: "0" } }, i)),
      // a close from the day before: not counted
      log({ contract: "frontDoor", event: "BatchClosed", args: { id: "40", fee: String(10n ** 18n) } }, 1, true),
      ...[1, 2].map((i) => log({ contract: "vault", event: "BatchDelivered", args: { key: h(`k${i}`), batchId: String(40 + i), amount: "0" } }, i)),
      log({ contract: "vault", event: "PayoutChunkSent", args: { key: h("k1"), chunk: 0, taken: 1, gross: "0", net: "0", fee: String(3n * 10n ** 15n) } }, 5),
      log({ contract: "vault", event: "RewardCutMinted", args: { treasury: D.vault, assets: String(4n * 10n ** 16n), shares: "1" } }, 6),
      log({ contract: "staker", event: "Staked", chain: "base", args: { payer: D.staker, beneficiary: D.staker, usdcIn: "100000000", fees: "500000", taoDeposited: "1" } }, 7),
    ];
    const blocks = logs.map((l) => ({ chain: l.chain, number: l.block, time: l.block % 1000n < 100n ? NOW - 2 * DAY : NOW - 3600 }));
    await db.batch([...upsertLogs(db, logs), ...upsertBlocks(db, blocks)]);
  }

  it("counts the day's batches, sums the fees per kind, lists the open alerts with their ages, and says CRITICAL", async () => {
    await fixtureDay();
    const hours: HourAgg[] = [
      { hour: Math.floor((NOW - DAY) / 3600) * 3600, ticks: 60, spotSum: 0, spotCount: 0, priceLast: E18 },
      { hour: Math.floor((NOW - 7 * DAY) / 3600) * 3600, ticks: 60, spotSum: 0, spotCount: 0, priceLast: (E18 * 99n) / 100n },
    ];
    const d = await buildDigest({
      db,
      nowS: NOW,
      base: reading(37_100_200n, NOW, baseState({ openBatch: { id: 44n, start: NOW - 1800, totalDeposits: 5n * E18, feePot: 0n, nDeposits: 2, nRedeems: 1 }, keeperBalance: 10n ** 16n })),
      bit: reading(6_905_200n, NOW, bitState({ totalAssets: 1000n * E18, price: (E18 * 1001n) / 1000n, keeperBalance: E18 })),
      hours,
      cursors: { base: cursor("base", 37_100_200n), bittensor: cursor("bittensor", 6_905_200n) },
      openAlerts: [alert({}), alert({ id: 2, tier: "critical", rule: "price.drop", subject: "The share price fell", openedAt: NOW - 600 })],
      activeHolds: [{ id: "price.drop:105", publicId: "h_3f9a0c1e", rule: "price.drop", summary: "the share price is 12 bps below its 24-hour high", raisedAt: NOW - 600, clearedAt: null, clearedNote: null }],
      meta: { ticks_date: "2027-01-15", ticks_run: "900", ticks_failed: "2", ticks_skipped: "1", emails_sent: "3" },
      apyPercent: 5.36,
    });
    expect(d.date).toBe("2027-01-15");
    expect(d.status).toBe("CRITICAL open");
    const text = d.sections.map((s) => `${s.title}\n${s.lines.join("\n")}`).join("\n\n");
    expect(text).toContain("closed: 3");
    expect(text).toContain("delivered: 2");
    expect(text).toContain("paid out: 1");
    expect(text).toContain("close fees: 0.006 ETH");
    expect(text).toContain("payout bridge fees: 0.003 TAO");
    expect(text).toContain("reward cut: 0.04 TAO");
    expect(text).toContain("staker fees: 0.5 USDC");
    expect(text).toContain("total staked: 1000 TAO");
    expect(text).toContain("APY (30 days, after the cut): 5.36%");
    expect(text).toMatch(/24 h: \+0\.1(0)?%/);
    expect(text).toContain("open batch 44: 30 minutes old, 3 entries, 5 TAO");
    expect(text).toContain("[critical] The share price fell (10 minutes)");
    expect(text).toContain("[warning] The keeper has 0.0019 ETH on Base (3 hours)");
    expect(text).toContain("h_3f9a0c1e");
    expect(text).toContain("ticks: 900 run, 2 failed, 1 skipped");
  });

  it("finds the day's logs a day by time back, at each chain's block time as measured: on Base's 200 ms blocks a close 20 hours ago is 360,000 blocks back", async () => {
    await wipe(db);
    const settled = 60_000_000n;
    const close = (id: number, back: bigint) => slog({ contract: "frontDoor", event: "BatchClosed", block: settled - back, args: { id: String(id), totalDeposits: "0", nDeposits: "0", nRedeems: "0", fee: String(10n ** 15n), potUsed: "0" } });
    const logs = [close(1, 360_000n), close(2, 1_000n), close(3, 500_000n)];
    // the third is 27.8 hours old: past the day
    await db.batch([...upsertLogs(db, logs), ...upsertBlocks(db, logs.map((l) => ({ chain: "base" as const, number: l.block, time: NOW - Math.floor(Number(settled - l.block) / 5) })))]);
    const o = { db, nowS: NOW, hours: [], activeHolds: [], openAlerts: [], cursors: { base: cursor("base", settled) } };
    const closed = async (meta: Record<string, string>) => (await buildDigest({ ...o, meta })).sections.flatMap((s) => s.lines).find((l) => l.startsWith("closed:"));
    expect(await closed({ "block_s:base": "0.2" })).toBe("closed: 2");
    // unmeasured: from block 0, the day cut by the blocks' times alone
    expect(await closed({})).toBe("closed: 2");
  });

  it("lists the day's surplus sweeps of each adapter (v3.2: anyone may sweep, to the fixed treasury), and nothing of them when there were none", async () => {
    await wipe(db);
    const o = { db, nowS: NOW, hours: [], activeHolds: [], openAlerts: [], meta: {}, cursors: { base: cursor("base", 37_100_200n), bittensor: cursor("bittensor", 6_905_200n) } };
    const text = async () => (await buildDigest(o)).sections.map((s) => s.lines.join("\n")).join("\n");
    expect(await text()).not.toContain("surplus");
    const logs = [
      slog({ contract: "baseAdapter", event: "SurplusSwept", block: 37_100_150n, args: { native: String(10n ** 15n), tokens: String(5n * 10n ** 17n) } }),
      slog({ contract: "baseAdapter", event: "SurplusSwept", block: 37_100_151n, args: { native: String(10n ** 15n), tokens: "0" } }),
      slog({ contract: "bitAdapter", event: "SurplusSwept", block: 6_905_150n, args: { native: String(2n * 10n ** 15n), tokens: "0" } }),
    ];
    await db.batch([...upsertLogs(db, logs), ...upsertBlocks(db, logs.map((l) => ({ chain: l.chain, number: l.block, time: NOW - 3600 })))]);
    const t = await text();
    expect(t).toContain("Base adapter surplus swept: 0.002 ETH and 0.5 FM-TAO (2 sweeps)");
    expect(t).toContain("Bittensor adapter surplus swept: 0.002 TAO and 0 wTAO (1 sweep)");
  });

  it("shows the share price in TAO per csTAO (csTAO has 24 decimals: price() 1e12 is 1 TAO)", async () => {
    await wipe(db);
    const o = { db, nowS: NOW, hours: [], cursors: {}, activeHolds: [], openAlerts: [], meta: {} };
    const text = async (price: bigint) => (await buildDigest({ ...o, bit: reading(1n, NOW, bitState({ price })) })).sections.map((s) => s.lines.join("\n")).join("\n");
    expect(await text(10n ** 12n)).toContain("share price: 1 TAO per csTAO");
    expect(await text(1_012_345_678_901n)).toContain("share price: 1.012345678901 TAO per csTAO");
  });

  it("says when a chain is catching up, and what that quiets", async () => {
    await wipe(db);
    const o = { db, nowS: NOW, hours: [], cursors: {}, activeHolds: [], openAlerts: [] };
    const text = (d: Awaited<ReturnType<typeof buildDigest>>) => d.sections.map((s) => s.lines.join("\n")).join("\n");
    expect(text(await buildDigest({ ...o, meta: { catching_up: "bittensor" } }))).toContain(
      "catching up: bittensor (its first backfill: its lag alerts are quiet, and a cross-check waiting on it isn't reported stuck)",
    );
    expect(text(await buildDigest({ ...o, meta: { catching_up: "" } }))).not.toContain("catching up");
  });

  it("lists every warning rule the last tick couldn't judge (monitor.unjudged pages only critical ones), so a blind spot stays in sight", async () => {
    await wipe(db);
    const o = { db, nowS: NOW, hours: [], cursors: {}, activeHolds: [], openAlerts: [] };
    const monitor = async (meta: Record<string, string>) => (await buildDigest({ ...o, meta })).sections.find((s) => s.title === "The monitor")?.lines ?? [];
    // root.pair_stamped until Task 62 confirms the stamp's storage key
    expect(await monitor({ unjudged_warnings: "root.pair_stamped,oracle.thin_pool" })).toContain("warning rules not judged: root.pair_stamped, oracle.thin_pool");
    expect(await monitor({ unjudged_warnings: "" })).toContain("warning rules not judged: none");
    expect(await monitor({})).toContain("warning rules not judged: none");
  });

  it("says OK, or the number of warnings, when nothing critical is open", async () => {
    await wipe(db);
    const o = { db, nowS: NOW, hours: [], cursors: {}, activeHolds: [], meta: {} };
    expect((await buildDigest({ ...o, openAlerts: [] })).status).toBe("OK");
    expect((await buildDigest({ ...o, openAlerts: [alert({}), alert({ id: 3 })] })).status).toBe("2 warnings");
  });
});

describe("the digest's Gas section: the keeper's and the guardian's balances, and the keeper's spend (src/gas.ts)", () => {
  const KEEPER = "0x00000000000000000000000000000000000000a3" as Hex;
  /** an hour row `back` hours before the digest's hour */
  const row = (back: number, o: Partial<HourAgg> = {}): HourAgg => ({ hour: Math.floor(NOW / 3600) * 3600 - back * 3600, ticks: 60, spotSum: 0, spotCount: 0, ...o });
  const total = (since: number, spent: bigint, last = 0n) => formatSpend({ since, spent, last, keeper: KEEPER });
  type Input = Parameters<typeof buildDigest>[0];
  const digest = async (o: Partial<Input>) => {
    await wipe(db);
    return buildDigest({ db, nowS: NOW, hours: [], cursors: {}, activeHolds: [], openAlerts: [], meta: {}, ...o });
  };
  const gas = async (o: Partial<Input>) => (await digest(o)).sections.find((s) => s.title === "Gas")?.lines ?? [];
  // the launch keeper after its two stakes, and the guardian as funded
  const base = reading(37_100_200n, NOW, baseState({ keeperBalance: 29_999_550_000_000_000n, guardianBalance: 10n ** 15n }));
  const bit = reading(6_905_200n, NOW, bitState({ keeperBalance: 498_432_220_000_000_000n, guardianBalance: 10n ** 16n }));
  /** NOW is 15 Jan 2027, 08:00 UTC */
  const JAN_6 = NOW - 9 * DAY;

  it("spent: each balance from the latest reading (ETH to 8 places, TAO to 6), and the keeper's spend on each chain in 24 hours, 7 days, and since the date its count starts", async () => {
    const d = await digest({
      base,
      bit,
      meta: { "keeper_spend:base": total(JAN_6, 450_000_000_000n), "keeper_spend:bittensor": total(JAN_6, 1_567_280_000_000_000n) },
      // the second stake two hours ago, the first on the day before; rows back to the count's start, and one a day older
      hours: [
        row(2, { keeperEthSpent: 250_000_000_000n, keeperTaoSpent: 698_170_000_000_000n }),
        row(30, { keeperEthSpent: 200_000_000_000n, keeperTaoSpent: 869_110_000_000_000n }),
        row(168, { keeperEthSpent: 0n, keeperTaoSpent: 0n }),
        row(192, { keeperEthSpent: 7n * E18, keeperTaoSpent: 7n * E18 }),
      ],
    });
    expect(d.sections.find((s) => s.title === "Gas")?.lines).toEqual([
      "keeper on Base: 0.02999955 ETH",
      "keeper on Bittensor: 0.498432 TAO",
      "guardian on Base: 0.001 ETH",
      "guardian on Bittensor: 0.01 TAO",
      "keeper spent on Base, last 24 hours: 0.00000025 ETH",
      "keeper spent on Base, last 7 days: 0.00000045 ETH",
      "keeper spent on Base, since 6 Jan 2027: 0.00000045 ETH",
      "keeper spent on Bittensor, last 24 hours: 0.000698 TAO",
      "keeper spent on Bittensor, last 7 days: 0.001567 TAO",
      "keeper spent on Bittensor, since 6 Jan 2027: 0.001567 TAO",
    ]);
    // it takes the place of the old "Keeper balances" section, where that one stood, and no line of it is in dollars
    expect(d.sections.map((s) => s.title)).toEqual(["Staking", "Batches in 24 hours", "Fees in 24 hours", "Gas", "Open alerts", "The hold", "The monitor"]);
    const text = renderDigest(d).text;
    expect(text).toContain("Gas\nkeeper on Base: 0.02999955 ETH\n");
    expect(text).not.toMatch(/all time/i);
    expect((d.sections.find((s) => s.title === "Gas")?.lines ?? []).join("\n")).not.toMatch(/\$|USD/);
  });

  it("topped up: the spend of a window a top-up fell in, and that it did; never of a window it didn't fall in, or of the other chain", async () => {
    const lines = await gas({
      base,
      bit,
      meta: { "keeper_spend:base": total(JAN_6, 9n * 10n ** 11n), "keeper_spend:bittensor": total(JAN_6, 3n * 10n ** 15n) },
      hours: [
        row(1, { keeperEthSpent: 10n ** 11n, keeperTaoSpent: 10n ** 15n }),
        // 0.02 ETH sent to the keeper three days ago, between two spends
        row(72, { keeperEthSpent: 3n * 10n ** 11n, keeperEthAdded: 2n * 10n ** 16n, keeperTaoSpent: 2n * 10n ** 15n }),
        row(170, { keeperEthSpent: 5n * 10n ** 11n, keeperTaoSpent: 0n }),
      ],
    });
    expect(lines.slice(4)).toEqual([
      "keeper spent on Base, last 24 hours: 0.0000001 ETH",
      "keeper spent on Base, last 7 days: 0.0000004 ETH (topped up in this window)",
      "keeper spent on Base, since 6 Jan 2027: 0.0000009 ETH",
      "keeper spent on Bittensor, last 24 hours: 0.001 TAO",
      "keeper spent on Bittensor, last 7 days: 0.003 TAO",
      "keeper spent on Bittensor, since 6 Jan 2027: 0.003 TAO",
    ]);
  });

  it("not enough history: a window the count doesn't reach back over says so, never a figure from less; the total still prints, from its own date", async () => {
    // the first day after the deploy: counted from 20:00 UTC the evening before, twelve hours ago, nothing spent since
    const since = NOW - 12 * 3600;
    const lines = await gas({
      base,
      bit,
      meta: { "keeper_spend:base": total(since, 0n), "keeper_spend:bittensor": total(since, 0n) },
      hours: Array.from({ length: 13 }, (_, i) => row(i, { keeperEthSpent: 0n, keeperTaoSpent: 0n })),
    });
    expect(lines.slice(4)).toEqual([
      "keeper spent on Base, last 24 hours: not enough history yet",
      "keeper spent on Base, last 7 days: not enough history yet",
      "keeper spent on Base, since 14 Jan 2027: 0 ETH",
      "keeper spent on Bittensor, last 24 hours: not enough history yet",
      "keeper spent on Bittensor, last 7 days: not enough history yet",
      "keeper spent on Bittensor, since 14 Jan 2027: 0 TAO",
    ]);
    // three days on: the day is covered, the week isn't yet; a spend under the last place shown is never "0"
    const later = await gas({
      base,
      bit,
      meta: { "keeper_spend:base": total(NOW - 3 * DAY, 4_000_000_000n), "keeper_spend:bittensor": total(NOW - 3 * DAY, 10n ** 15n) },
      hours: [row(3, { keeperEthSpent: 4_000_000_000n, keeperTaoSpent: 0n }), row(40, { keeperEthSpent: 0n, keeperTaoSpent: 10n ** 15n })],
    });
    expect(later.slice(4)).toEqual([
      "keeper spent on Base, last 24 hours: under 0.00000001 ETH",
      "keeper spent on Base, last 7 days: not enough history yet",
      "keeper spent on Base, since 12 Jan 2027: under 0.00000001 ETH",
      "keeper spent on Bittensor, last 24 hours: 0 TAO",
      "keeper spent on Bittensor, last 7 days: not enough history yet",
      "keeper spent on Bittensor, since 12 Jan 2027: 0.001 TAO",
    ]);
  });

  it("not read, not counted yet: a chain with no reading, a balance unread, or no total says so in a plain line, never a zero", async () => {
    // no reading of Base at all; Bittensor's names no guardian balance; Base has no total, Bittensor's doesn't read
    const lines = await gas({
      bit: reading(6_905_200n, NOW, bitState({ keeperBalance: 498_432_220_000_000_000n })),
      meta: { "keeper_spend:bittensor": '{"since":1,"spent":"x"}' },
      hours: [row(1, { keeperEthSpent: 5n, keeperTaoSpent: 5n }), row(200, { keeperEthSpent: 5n, keeperTaoSpent: 5n })],
    });
    expect(lines).toEqual([
      "keeper on Base: not read",
      "keeper on Bittensor: 0.498432 TAO",
      "guardian on Base: not read",
      "guardian on Bittensor: not read",
      "keeper spent on Base: not counted yet",
      "keeper spent on Bittensor: not counted yet",
    ]);
    // nothing at all in hand: the section still stands, every line saying what is missing
    expect(await gas({})).toEqual([
      "keeper on Base: not read",
      "keeper on Bittensor: not read",
      "guardian on Base: not read",
      "guardian on Bittensor: not read",
      "keeper spent on Base: not counted yet",
      "keeper spent on Bittensor: not counted yet",
    ]);
    // a balance read as nothing is a reading: 0, as read
    expect((await gas({ base: reading(1n, NOW, baseState({ keeperBalance: 0n, guardianBalance: 0n })) })).slice(0, 4)).toEqual([
      "keeper on Base: 0 ETH",
      "keeper on Bittensor: not read",
      "guardian on Base: 0 ETH",
      "guardian on Bittensor: not read",
    ]);
  });

  it("the total's date is the UTC day its count starts on, as \"16 Nov 2026\"", async () => {
    const since = async (s: number) => (await gas({ meta: { "keeper_spend:base": total(s, 0n) } })).find((l) => l.includes("since"));
    expect(await since(Date.UTC(2026, 10, 16, 0, 0, 0) / 1000)).toBe("keeper spent on Base, since 16 Nov 2026: 0 ETH");
    expect(await since(Date.UTC(2026, 10, 16, 23, 59, 59) / 1000)).toBe("keeper spent on Base, since 16 Nov 2026: 0 ETH");
    expect(await since(Date.UTC(2026, 10, 17, 0, 0, 0) / 1000)).toBe("keeper spent on Base, since 17 Nov 2026: 0 ETH");
    expect(await since(Date.UTC(2027, 4, 3, 12, 0, 0) / 1000)).toBe("keeper spent on Base, since 3 May 2027: 0 ETH");
  });
});
