import { formatUnits } from "viem";
import type { ChainName } from "./config.ts";
import type { DigestContent } from "./email.ts";
import type { BaseState, BitState, ChainReading, HourAgg } from "./snapshot.ts";
import type { AlertRow, CursorRow, HoldRow } from "./store.ts";

// The daily digest (spec 6.5, 13:00 UTC): sent once per UTC day (meta.digest_date). Its arrival is itself a
// heartbeat: no digest means the monitor is down.

const DAY = 86_400;
const dateOf = (nowS: number) => new Date(nowS * 1000).toISOString().slice(0, 10);

/** True until the digest for today (UTC) is recorded as sent. */
export const digestDue = (meta: Readonly<Record<string, string>>, nowS: number): boolean => meta.digest_date !== dateOf(nowS);

/** Blocks a day takes on each chain (Base 2 s, Bittensor 12 s), with room for slow blocks. */
const DAY_BLOCKS: Record<ChainName, bigint> = { base: 64_800n, bittensor: 10_800n };

/** The day's logs of these kinds, with their block times. */
const KINDS: { chain: ChainName; contract: string; event: string }[] = [
  { chain: "base", contract: "frontDoor", event: "BatchClosed" },
  { chain: "base", contract: "staker", event: "Staked" },
  { chain: "bittensor", contract: "vault", event: "BatchDelivered" },
  { chain: "bittensor", contract: "vault", event: "PayoutChunkSent" },
  { chain: "bittensor", contract: "vault", event: "RewardCutMinted" },
];

const amount = (wei: bigint, unit: string, decimals = 18) => `${formatUnits(wei, decimals)} ${unit}`;
const age = (s: number) => (s >= 2 * 3600 ? `${Math.floor(s / 3600)} hours` : s >= 3600 ? "1 hour" : `${Math.floor(s / 60)} minutes`);
const pct = (now: bigint, then: bigint | undefined) => {
  if (then === undefined || then === 0n) return "unknown";
  const bp = Number(((now - then) * 1_000_000n) / then) / 10_000;
  return `${bp >= 0 ? "+" : ""}${bp.toFixed(2)}%`;
};

export interface DigestInput {
  db: D1Database;
  nowS: number;
  /** the latest readings */
  base?: ChainReading<BaseState>;
  bit?: ChainReading<BitState>;
  hours: HourAgg[];
  cursors: Partial<Record<ChainName, CursorRow>>;
  openAlerts: AlertRow[];
  activeHolds: HoldRow[];
  meta: Readonly<Record<string, string>>;
  /** the 30-day APY after the reward cut, when it could be read */
  apyPercent?: number;
}

/** The digest's contents: one D1 query for the day's batches and fees, the rest from what the job loaded. */
export async function buildDigest(i: DigestInput): Promise<DigestContent> {
  const since = i.nowS - DAY;
  const stmts = KINDS.map((k) =>
    i.db
      .prepare(
        `SELECT l.args AS args, b.time AS time FROM logs l JOIN blocks b ON b.chain = l.chain AND b.number = l.block
         WHERE l.chain = ?1 AND l.contract = ?2 AND l.event = ?3 AND l.block >= ?4 AND l.removed = 0`,
      )
      .bind(k.chain, k.contract, k.event, Number((i.cursors[k.chain]?.settledTo ?? DAY_BLOCKS[k.chain]) - DAY_BLOCKS[k.chain])),
  );
  const rs = await i.db.batch<{ args: string; time: number }>(stmts);
  const day = (n: number) => rs[n].results.filter((r) => r.time >= since).map((r) => JSON.parse(r.args) as Record<string, string | number>);
  const [closed, staked, delivered, chunks, cuts] = [0, 1, 2, 3, 4].map(day);
  const sum = (rows: Record<string, string | number>[], arg: string) => rows.reduce((s, r) => s + BigInt(String(r[arg] ?? 0)), 0n);

  const critical = i.openAlerts.filter((a) => a.tier === "critical");
  const warnings = i.openAlerts.filter((a) => a.tier === "warning");
  const status = critical.length ? "CRITICAL open" : warnings.length ? `${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : "OK";

  const bit = i.bit?.state;
  const base = i.base?.state;
  const hourAt = (s: number) => i.hours.find((r) => r.hour === Math.floor((i.nowS - s) / 3600) * 3600)?.priceLast;
  const staking = [
    `total staked: ${bit?.totalAssets === undefined ? "unknown" : amount(bit.totalAssets, "TAO")}`,
    // price() is TAO wei per share unit, scaled by 1e18; csTAO has 24 decimals, so TAO per csTAO is price / 1e12
    `share price: ${bit?.price === undefined ? "unknown" : `${formatUnits(bit.price, 12)} TAO per csTAO`} (24 h: ${bit?.price === undefined ? "unknown" : pct(bit.price, hourAt(DAY))}, 7 days: ${bit?.price === undefined ? "unknown" : pct(bit.price, hourAt(7 * DAY))})`,
    `APY (30 days, after the cut): ${i.apyPercent === undefined ? "not available" : `${i.apyPercent.toFixed(2)}%`}`,
  ];
  const ob = base?.openBatch;
  const batches = [
    `closed: ${closed.length}`,
    `delivered: ${delivered.length}`,
    `paid out: ${new Set(chunks.map((c) => String(c.key))).size}`,
    ob && i.base ? `open batch ${ob.id}: ${age(i.base.time - ob.start)} old, ${ob.nDeposits + ob.nRedeems} entries, ${amount(ob.totalDeposits, "TAO")}` : "open batch: unknown",
  ];
  const fees = [
    `staker fees: ${amount(sum(staked, "fees"), "USDC", 6)}`,
    `reward cut: ${amount(sum(cuts, "assets"), "TAO")}`,
    `payout bridge fees: ${amount(sum(chunks, "fee"), "TAO")}`,
    `close fees: ${amount(sum(closed, "fee"), "ETH")}`,
  ];
  const keeper = [
    `Base: ${base?.keeperBalance === undefined ? "unknown" : amount(base.keeperBalance, "ETH")}`,
    `Bittensor: ${bit?.keeperBalance === undefined ? "unknown" : amount(bit.keeperBalance, "TAO")}`,
  ];
  const alerts = i.openAlerts.length ? [...critical, ...warnings].map((a) => `[${a.tier}] ${a.subject} (${age(i.nowS - a.openedAt)})`) : ["none open"];
  const hold = i.activeHolds.length ? i.activeHolds.map((h) => `on: ${h.publicId} (${h.summary}), raised ${age(i.nowS - h.raisedAt)} ago`) : ["off"];
  const lag = (["base", "bittensor"] as ChainName[]).map((c) => {
    const cur = i.cursors[c];
    return `${c}: ${cur?.headTime && cur.settledTime ? `${Math.floor((cur.headTime - cur.settledTime) / 60)} minutes behind` : "unknown"}`;
  });
  if (i.meta.catching_up) {
    lag.push(`catching up: ${i.meta.catching_up.split(",").join(", ")} (its first backfill: its lag alerts are quiet, and a cross-check waiting on it isn't reported stuck)`);
  }
  const counted = i.meta.ticks_date === dateOf(i.nowS);
  const ticks = counted ? `ticks: ${i.meta.ticks_run ?? 0} run, ${i.meta.ticks_failed ?? 0} failed, ${i.meta.ticks_skipped ?? 0} skipped` : "ticks: none counted today";
  return {
    date: dateOf(i.nowS),
    status,
    sections: [
      { title: "Staking", lines: staking },
      { title: "Batches in 24 hours", lines: batches },
      { title: "Fees in 24 hours", lines: fees },
      { title: "Keeper balances", lines: keeper },
      { title: "Open alerts", lines: alerts },
      { title: "The hold", lines: hold },
      { title: "The monitor", lines: [...lag, ticks, `emails sent: ${counted ? (i.meta.emails_sent ?? 0) : 0}`] },
    ],
  };
}

