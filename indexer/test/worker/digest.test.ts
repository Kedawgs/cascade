import { env } from "cloudflare:workers";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { BASKET_TWR_PREFIX, basketTwrKey, decodeTwr, netApyPercent } from "../../src/apy.ts";
import { buildDigest, digestDue } from "../../src/digest.ts";
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

  it("says OK, or the number of warnings, when nothing critical is open", async () => {
    await wipe(db);
    const o = { db, nowS: NOW, hours: [], cursors: {}, activeHolds: [], meta: {} };
    expect((await buildDigest({ ...o, openAlerts: [] })).status).toBe("OK");
    expect((await buildDigest({ ...o, openAlerts: [alert({}), alert({ id: 3 })] })).status).toBe("2 warnings");
  });
});
