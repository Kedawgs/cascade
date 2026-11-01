import type { Config } from "./config.ts";
import type { BaseState, BitState, Bucket as RawBucket, ChainReading, Lane } from "./snapshot.ts";

// The public document behind the /security page: facts only, from the newest reading of each chain, the
// bridge messages in flight and the stored admin events. Pure: no D1, no fetch. The monitor's own thresholds
// and rules never appear here.

/** decimal base units; null when unknown or stale */
export type Amount = string | null;
export interface FlowChain { block: string; time: number; stale: boolean }
export type NoticeKind =
  | "paused" | "ownershipPending" | "guardianProposed" | "bridgeProposed" | "frontDoorProposed"
  | "fmAdminScheduled" | "fmMigration" | "fmPaused";
export interface Notice {
  kind: NoticeKind;
  chain: "base" | "bittensor";
  /** address of the contract it concerns */
  contract: string;
  /** the proposed guardian / bridge / door / owner / FM admin or migration target */
  target?: string;
  /** unix s it can take effect (absent: any time, or not applicable) */
  earliest?: number;
  /** the transaction that started it, when the monitor stored it */
  tx?: string;
}
/** One bridge direction: the binding one of the source pool's outbound limiter and the destination pool's inbound one. */
export interface Bucket {
  /** the binding limiter's room, capacity and refill per hour; null when unknown, and when no limiter binds or the lane is closed */
  roomLeft: Amount;
  capacity: Amount;
  perHour: Amount;
  /** whether a rate limit applies: false is no limit (CCIP's limiter off on both pools), never "switched off"; null when unknown */
  enabled: boolean | null;
  /** whether both pools still list the other chain (isSupportedChain): false is a closed lane; null when unknown */
  supported: boolean | null;
  inFlight: number;
}
export interface FlowV1 {
  v: 1;
  deployment: string;
  generatedAt: number;
  chains: { base: FlowChain | null; bittensor: FlowChain | null };
  swap: {
    taoWethPoolTao: Amount; wethUsdcPoolUsdc: Amount; twapUsdcPerTao: Amount; spotUsdcPerTao: Amount;
    buyQuote1000Tao: Amount; sellQuote: { taoIn: string; usdcOut: string } | null;
  };
  backing: {
    alphaBacking: Amount; wTaoSupply: Amount; lockPoolFmTao: Amount; fmTaoSupplyBase: Amount;
    /** the lower of the two layers, in parts per million; null unless both layers are known (both chains fresh) */
    ratioPpm: number | null;
  };
  bridgeIn: Bucket;
  bridgeOut: Bucket;
  /** openBatch.start + batchInterval when the open batch holds anything */
  batch: { nextSendAt: number | null };
  vault: {
    totalAssets: Amount;
    /** TAO per share, 1e18 */
    price: Amount;
    pendingPayouts: Amount;
    nextPayoutAt: number | null;
    paused: boolean | null;
  };
  validator: { hotkey: string | null; ourStake: Amount; takeBps: number | null; backups: string[] };
  frontDoor: { paused: boolean | null };
  notices: Notice[];
  addresses: {
    vault: string; frontDoor: string; staker: string; taoWethPool: string; wethUsdcPool: string;
    alphaVault: string; lockPool: string; baseTokenPool: string; wTao: string; fmTaoBase: string;
  };
}
export interface AdminLog {
  chain: "base" | "bittensor";
  address: string;
  event: string;
  args: Record<string, string>;
  txHash: string;
  block: number;
}
export interface FlowInput {
  base: ChainReading<BaseState> | null;
  bittensor: ChainReading<BitState> | null;
  inFlight: { toBittensor: number; toBase: number };
  /** oldest first */
  adminLogs: AdminLog[];
  cfg: Config;
  nowS: number;
}

export const STALE_AFTER_S = 600;

const ZERO = /^0x0*$/i;
const nonZero = (a: string | undefined): a is string => !!a && !ZERO.test(a);
const amt = (v: bigint | undefined, live: boolean): Amount => (live && v !== undefined ? v.toString() : null);
const lc = (a: string) => a.toLowerCase();
const Q192 = 1n << 192n;

/** USDC units (6 decimals) per 1 TAO (1e18 wei), from the TAO/WETH and WETH/USDC pools, in integer math. */
function spotUsdcPerTao(s: BaseState, cfg: Config): bigint | undefined {
  const a = s.taoWethPool;
  const b = s.wethUsdcPool;
  if (!a.sqrtPriceX96 || !a.token0 || !b.sqrtPriceX96 || !b.token0) return undefined;
  const sa = a.sqrtPriceX96 ** 2n;
  const sb = b.sqrtPriceX96 ** 2n;
  // a pool's price is token1 per token0 in raw units: sqrtPriceX96^2 / 2^192
  const taoFirst = lc(a.token0) === lc(cfg.tokens.base.fmTao);
  const wethFirst = lc(b.token0) === lc(cfg.tokens.base.weth);
  const [nA, dA] = taoFirst ? [sa, Q192] : [Q192, sa]; // WETH wei per TAO wei
  const [nB, dB] = wethFirst ? [sb, Q192] : [Q192, sb]; // USDC units per WETH wei
  const v = (10n ** 18n * nA * nB) / (dA * dB);
  return v > 0n ? v : undefined;
}

/** One bridge direction from the two pools' lanes (each undefined when its chain's half is stale or missing).
 * A transfer passes two limiters: the source pool's outbound one when it is sent, the destination pool's inbound one
 * when it is released, so the room is the tighter of the two. A limiter that is off (isEnabled false: CCIP stores it as
 * capacity, rate and tokens 0, and lets transfers through unlimited) never binds; with both off there is no limit. A
 * lane either pool no longer lists (isSupportedChain false: a removed lane reads the same zeros) is closed. Anything
 * unknown on either side (a stale half, a bucket or the support unread) leaves the room unknown, never one side's. */
function laneOf(src: Lane | undefined, dst: Lane | undefined, inFlight: number): Bucket {
  const unknown: Bucket = { roomLeft: null, capacity: null, perHour: null, enabled: null, supported: null, inFlight };
  if (!src || !dst) return unknown;
  const supported = src.supported === false || dst.supported === false ? false : src.supported === true && dst.supported === true ? true : null;
  if (supported !== true || !src.outbound || !dst.inbound) return { ...unknown, supported };
  const limits = [src.outbound, dst.inbound].filter((b) => b.isEnabled);
  if (!limits.length) return { ...unknown, enabled: false, supported };
  const b: RawBucket = limits.reduce((m, x) => (x.tokens < m.tokens ? x : m));
  return { roomLeft: b.tokens.toString(), capacity: b.capacity.toString(), perHour: (b.rate * 3600n).toString(), enabled: true, supported, inFlight };
}

/** A stored readyAt as unix seconds, only when it is a plain decimal string. */
const readyOf = (x: string | undefined) => (x !== undefined && /^\d+$/.test(x) && Number.isSafeInteger(Number(x)) ? Number(x) : undefined);

/** The proposals of one contract that no activate or cancel event has followed since. */
function openProposals(
  logs: AdminLog[],
  address: string,
  proposed: string,
  closers: string[],
  keyOf: (a: Record<string, string>) => string,
  targetOf: (a: Record<string, string>) => string,
) {
  const open = new Map<string, { target: string; earliest?: number; tx: string }>();
  for (const l of logs) {
    if (lc(l.address) !== lc(address)) continue;
    if (!targetOf(l.args)) continue;
    if (l.event === proposed) {
      const earliest = readyOf(l.args.readyAt);
      open.set(keyOf(l.args), { target: targetOf(l.args), ...(earliest !== undefined ? { earliest } : {}), tx: l.txHash });
    } else if (closers.includes(l.event)) open.delete(keyOf(l.args));
  }
  return [...open.values()];
}

const latest = (logs: AdminLog[], address: string, event: string, where: (l: AdminLog) => boolean = () => true) => {
  for (let i = logs.length - 1; i >= 0; i--) if (lc(logs[i].address) === lc(address) && logs[i].event === event && where(logs[i])) return logs[i];
  return undefined;
};

export function flowOf(i: FlowInput): FlowV1 {
  const { cfg, nowS } = i;
  const d = cfg.deployment;
  const tb = cfg.tokens.base;
  const tt = cfg.tokens.bittensor;
  const chainOf = (r: ChainReading<unknown> | null): FlowChain | null =>
    r ? { block: r.block.toString(), time: r.time, stale: nowS - r.time > STALE_AFTER_S } : null;
  const chains = { base: chainOf(i.base), bittensor: chainOf(i.bittensor) };
  // a stale chain is treated as unread: amounts and booleans null, no state notices
  const bs = i.base && !chains.base!.stale ? i.base.state : undefined;
  const ts = i.bittensor && !chains.bittensor!.stale ? i.bittensor.state : undefined;

  const spot = bs ? spotUsdcPerTao(bs, cfg) : undefined;
  const sq = bs?.sellQuote;

  // backing: each layer's coverage in ppm, and the lower one counts, so the page never shows a better number than the
  // weaker layer. Both layers must be known: the AlphaVault's backing against wTAO's supply (Bittensor), and the lock
  // pool against FM-TAO's supply on Base (a fresh Base half too). With either unknown the ratio is unknown, never the
  // other layer alone. A zero supply is known but owes nothing: its layer is skipped, never divided (no Infinity).
  const alphaBacking = ts?.alpha.backing;
  const layers = [
    { held: alphaBacking, owed: ts?.wTaoSupply },
    { held: ts?.lockPoolFmTao, owed: bs?.fmTaoSupply },
  ];
  let ratioPpm: number | null = null;
  if (layers.every((l) => l.held !== undefined && l.owed !== undefined)) {
    const ratios = layers.flatMap(({ held, owed }) => (owed! > 0n ? [(held! * 1_000_000n) / owed!] : []));
    if (ratios.length) ratioPpm = Number(ratios.reduce((m, x) => (x < m ? x : m)));
  }

  const ob = bs?.openBatch;
  const nextSendAt = ob && bs?.batchInterval !== undefined && ob.nDeposits + ob.nRedeems > 0 ? ob.start + bs.batchInterval : null;

  let nextPayoutAt: number | null = null;
  if (ts?.payoutDelay !== undefined) {
    for (const b of Object.values(ts.payoutBatches)) {
      const at = b.queuedAt + ts.payoutDelay;
      if (nextPayoutAt === null || at < nextPayoutAt) nextPayoutAt = at;
    }
  }

  const v = ts?.validator;
  const stakeHotkey = ts ? (ts.stakeHotkey ?? v?.hotkey) : undefined;
  const takeBps = !v || v.take === undefined ? null : v.take === null ? 1800 : Math.round((v.take * 10_000) / 65_535);

  const notices: Notice[] = [];
  const logs = i.adminLogs;
  const pausedN = (chain: Notice["chain"], contract: string, paused: boolean | undefined) => {
    if (paused) notices.push({ kind: "paused", chain, contract });
  };
  const ownerN = (chain: Notice["chain"], contract: string, pending: string | undefined) => {
    if (!nonZero(pending)) return;
    const n: Notice = { kind: "ownershipPending", chain, contract, target: pending };
    const l = latest(logs, contract, "OwnershipTransferStarted", (x) => lc(x.args.newOwner ?? "") === lc(pending));
    if (l) n.tx = l.txHash;
    notices.push(n);
  };
  const guardianN = (chain: Notice["chain"], contract: string, pending: string | undefined) => {
    if (!nonZero(pending)) return;
    const n: Notice = { kind: "guardianProposed", chain, contract, target: pending };
    const l = latest(logs, contract, "GuardianProposed");
    if (l) {
      const e = readyOf(l.args.readyAt);
      if (e !== undefined) n.earliest = e;
      n.tx = l.txHash;
    }
    notices.push(n);
  };
  const proposalsN = (chain: Notice["chain"], contract: string) => {
    for (const p of openProposals(logs, contract, "BridgeProposed", ["BridgeActivated", "BridgeProposalCancelled"], (a) => lc(a.bridge ?? ""), (a) => a.bridge ?? ""))
      notices.push({ kind: "bridgeProposed", chain, contract, target: p.target, ...(p.earliest !== undefined ? { earliest: p.earliest } : {}), tx: p.tx });
    for (const p of openProposals(logs, contract, "FrontDoorProposed", ["FrontDoorActivated", "FrontDoorProposalCancelled"], (a) => `${a.chain}:${lc(a.addr ?? "")}`, (a) => a.addr ?? ""))
      notices.push({ kind: "frontDoorProposed", chain, contract, target: p.target, ...(p.earliest !== undefined ? { earliest: p.earliest } : {}), tx: p.tx });
  };

  pausedN("base", d.frontDoor, bs?.paused);
  pausedN("bittensor", d.vault, ts?.paused);
  ownerN("base", d.frontDoor, bs?.pendingOwner);
  ownerN("base", d.staker, bs?.stakerPendingOwner);
  ownerN("bittensor", d.vault, ts?.pendingOwner);
  guardianN("base", d.frontDoor, bs?.pendingGuardian);
  guardianN("bittensor", d.vault, ts?.pendingGuardian);
  proposalsN("base", d.frontDoor);
  proposalsN("bittensor", d.vault);

  if (ts) {
    const a = ts.alpha;
    if (a.pendingAdmin && nonZero(a.pendingAdmin.admin)) {
      const n: Notice = { kind: "fmAdminScheduled", chain: "bittensor", contract: tt.alphaVault, target: a.pendingAdmin.admin };
      if (a.pendingAdmin.schedule > 0) n.earliest = a.pendingAdmin.schedule;
      notices.push(n);
    }
    if (a.migrationReadyAt !== undefined && a.migrationReadyAt > 0n && !a.migrationExecuted) {
      const n: Notice = { kind: "fmMigration", chain: "bittensor", contract: tt.alphaVault, earliest: Number(a.migrationReadyAt) };
      if (nonZero(a.migrationTarget)) n.target = a.migrationTarget;
      notices.push(n);
    }
    if (a.pausedUntil !== undefined && a.pausedUntil > BigInt(nowS)) notices.push({ kind: "fmPaused", chain: "bittensor", contract: tt.alphaVault });
  }

  return {
    v: 1,
    deployment: d.id,
    generatedAt: nowS,
    chains,
    swap: {
      taoWethPoolTao: amt(bs?.taoWethPool.tao, !!bs),
      wethUsdcPoolUsdc: amt(bs?.wethUsdcPoolUsdc, !!bs),
      twapUsdcPerTao: bs && !bs.oracleReverted ? amt(bs.oracleValue, true) : null,
      spotUsdcPerTao: spot === undefined ? null : spot.toString(),
      buyQuote1000Tao: amt(bs?.buyQuote1000, !!bs),
      sellQuote: sq ? { taoIn: sq.taoIn.toString(), usdcOut: sq.usdcOut.toString() } : null,
    },
    backing: {
      alphaBacking: amt(alphaBacking, !!ts),
      wTaoSupply: amt(ts?.wTaoSupply, !!ts),
      lockPoolFmTao: amt(ts?.lockPoolFmTao, !!ts),
      fmTaoSupplyBase: amt(bs?.fmTaoSupply, !!bs),
      ratioPpm,
    },
    // a direction needs both halves fresh: the source pool's outbound limiter and the destination pool's inbound one
    bridgeIn: laneOf(bs && (bs.lane ?? {}), ts && (ts.lane ?? {}), i.inFlight.toBittensor),
    bridgeOut: laneOf(ts && (ts.lane ?? {}), bs && (bs.lane ?? {}), i.inFlight.toBase),
    batch: { nextSendAt },
    vault: {
      totalAssets: amt(ts?.totalAssets, !!ts),
      price: amt(ts?.price, !!ts),
      pendingPayouts: amt(ts?.pendingPayouts, !!ts),
      nextPayoutAt,
      paused: ts?.paused ?? null,
    },
    validator: {
      hotkey: stakeHotkey ?? null,
      ourStake: ts && stakeHotkey ? amt(ts.stakes[stakeHotkey], true) : null,
      takeBps,
      backups: ts?.hotkeys ? ts.hotkeys.filter((h) => lc(h) !== lc(stakeHotkey ?? "")) : [],
    },
    frontDoor: { paused: bs?.paused ?? null },
    notices,
    addresses: {
      vault: d.vault,
      frontDoor: d.frontDoor,
      staker: d.staker,
      taoWethPool: tb.taoWethPool,
      wethUsdcPool: tb.wethUsdcPool,
      alphaVault: tt.alphaVault,
      lockPool: tt.lockPool,
      baseTokenPool: tb.tokenPool,
      wTao: tt.fmTao,
      fmTaoBase: tb.fmTao,
    },
  };
}
