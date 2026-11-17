import type { Config, Deployment } from "./config.ts";
import type { StoredLog } from "./logs.ts";
import { BITTENSOR_BLOCK_S, PARK_TIMEOUT_S, parksOf } from "./parks.ts";
import { itemStatus, kindName, type TrackedItem } from "./scheduler.ts";
import { type BaseState, type BitState, type Bucket as RawBucket, type ChainReading, type Lane, type OutflowWindow, outflowOf, payoutsClosedOf } from "./snapshot.ts";

// The public document behind the /security page: facts only, from the newest reading of each chain, the
// bridge messages in flight and the stored admin events. Pure: no D1, no fetch. The monitor's own thresholds
// and rules never appear here.

// Throughout, null means unknown: unread, or from a stale chain. A field that can be known to be empty says so with a
// value of its own ("none" for a time with nothing scheduled, [] for a list), so an unknown never reads as "none".

/** decimal base units; null when unknown or stale */
export type Amount = string | null;
/** unix s something is due; "none" when nothing is scheduled; null when unknown or stale */
export type Scheduled = number | "none" | null;
export interface FlowChain { block: string; time: number; stale: boolean }
export type NoticeKind =
  | "paused" | "ownershipPending" | "guardianProposed" | "bridgeProposed" | "frontDoorProposed"
  | "fmAdminScheduled" | "fmMigration" | "fmPaused"
  | "itemScheduled"
  // v3.2 (the web copy audit, N1 to N4): stake missing (a validator key change), front-door deposits parked on Bittensor
  // (`earliest`: when the oldest can be sent back to Base), the vault's primary bridge unable to send payouts (its
  // canSendPayouts(): `contract` is the bridge), and Cascade's route switched off (a primary disabled, or the launch door
  // removed)
  | "stakeMissing" | "parked" | "payoutsClosed" | "routeDisabled";
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
  /** v3.2's itemScheduled: the scheduled item (its kind, Ordinary, GuardianSwap or Reopen; its setter and arguments as
   * decoded from its calldata, decimal integers and lowercase hex, null when the calldata didn't decode) */
  item?: { id: string; kind: string; setter: string | null; args: Record<string, string> | null };
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
  /** openBatch.start + batchInterval when the open batch holds anything; "none" when it holds nothing */
  batch: { nextSendAt: Scheduled };
  vault: {
    totalAssets: Amount;
    /** the vault's price(): wei of assets per share unit, scaled by 1e18 (shares have 24 decimals, so 1e12 = 1 TAO per share) */
    price: Amount;
    pendingPayouts: Amount;
    /** the earliest queued payout batch's queuedAt + payoutDelay; "none" when no batch is queued */
    nextPayoutAt: Scheduled;
    paused: boolean | null;
  };
  /** backups: the vault's other hotkeys ([] when it has none) */
  validator: { hotkey: string | null; ourStake: Amount; takeBps: number | null; backups: string[] | null };
  frontDoor: { paused: boolean | null };
  notices: Notice[];
  addresses: {
    vault: string; frontDoor: string; staker: string; taoWethPool: string; wethUsdcPool: string;
    alphaVault: string; lockPool: string; baseTokenPool: string; wTao: string; fmTaoBase: string;
  };
  /** v3.2 only (absent on v3-launch): the money-out figures (the web copy audit's N5 and S9) and the deposits waiting on
   * Bittensor (N2). The limit and what it has burned are a guide: the vault works the base out again at each delivery */
  exits?: {
    /** the vault's payoutDelay, seconds */
    payoutDelayS: number | null;
    /** today's unstake limit through the front door: the allowance of the window whose rest is the smaller (its own, or
     * every door's together), and what that window has burned since it began (24 hours from its first burn) */
    dailyLimit: Amount;
    usedToday: Amount;
    /** the front door's deposits parked on Bittensor, wei ("0" when none), and when the oldest can be sent back to Base
     * (its parked time + 14 days; "none" with none parked) */
    parked: Amount;
    parkedRefundFrom: Scheduled;
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
  /** v3.2: the scheduled items the admin rules keep (meta scheduled_items, src/scheduler.ts), oldest first */
  items?: readonly TrackedItem[];
  /** v3.2: the front door's open parks with TAO (doorParksOf), each with when it parked when known; absent: unread */
  parks?: readonly { amount: bigint; parkedAt?: number }[];
  cfg: Config;
  nowS: number;
}

/** v3.2: the front door's parks still open with TAO in them (a redeem-only park holds no deposit; a stranger's isn't
 * Cascade's), from the Bittensor adapters' park events (src/parks.ts), each with when it parked: its BatchParked's block
 * time, else told by its block back from `reading` at Bittensor's block time as measured (`blockS`, src/blocktime.ts; its
 * nominal 12 s while that is unread), else unknown. */
export function doorParksOf(
  logs: readonly StoredLog[],
  d: Pick<Deployment, "frontDoor" | "vault">,
  timeOf: (block: bigint) => number | undefined,
  reading?: { block: bigint; time: number },
  blockS: number = BITTENSOR_BLOCK_S,
): { amount: bigint; parkedAt?: number }[] {
  return parksOf(logs, d)
    .filter((p) => !p.ended && p.door && p.amount > 0n)
    .map((p) => {
      const at = timeOf(p.parked.block) ?? (reading ? reading.time - Number(reading.block - p.parked.block) * blockS : undefined);
      return at === undefined ? { amount: p.amount } : { amount: p.amount, parkedAt: at };
    });
}

/** What a burn window may still burn today. */
const restOf = (w: OutflowWindow) => (w.allowance > w.burned ? w.allowance - w.burned : 0n);

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

  // the open batch: unknown unread, "none" when it holds nothing (the interval doesn't matter then)
  const ob = bs?.openBatch;
  const nextSendAt: Scheduled = !ob ? null : ob.nDeposits + ob.nRedeems === 0 ? "none" : bs!.batchInterval === undefined ? null : ob.start + bs!.batchInterval;

  // the payout batches: unknown when the delay is unread or a batch's read failed; a batch that has finished (count
  // 0, its struct zeroed) is skipped, so it never reads as due at queuedAt 0
  let nextPayoutAt: Scheduled = null;
  if (ts && ts.payoutDelay !== undefined && !ts.payoutBatchFailed) {
    nextPayoutAt = "none";
    for (const b of Object.values(ts.payoutBatches)) {
      if (b.count === 0) continue;
      const at = b.queuedAt + ts.payoutDelay;
      if (nextPayoutAt === "none" || at < nextPayoutAt) nextPayoutAt = at;
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
    // its time and transaction only from a proposal of this guardian (as the ownership notice's)
    const l = latest(logs, contract, "GuardianProposed", (x) => lc(x.args.guardian ?? "") === lc(pending));
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

  // v3.2: the pending scheduled items, from the record the admin rules keep and judged as they judge them (one source,
  // no second decoding): a finished one (the record's `lapsed`), or one the lens reads gone, dead or past its window, is
  // left out; one it hasn't read (a stale chain's too) is shown, since unread is never "nothing pending"
  for (const it of i.items ?? []) {
    if (it.lapsed) continue;
    const r = it.chain === "base" ? (bs ? i.base : null) : ts ? i.bittensor : null;
    const status = itemStatus(it, r ?? undefined).status;
    if (status === "gone" || status === "dead" || status === "lapsed") continue;
    const target = Object.values(it.args ?? {}).find((v) => /^0x[0-9a-f]{40}$/.test(v));
    notices.push({
      kind: "itemScheduled",
      chain: it.chain,
      contract: it.role === "vault" ? d.vault : d.frontDoor,
      ...(target ? { target } : {}),
      earliest: it.readyAt,
      tx: it.tx,
      item: { id: it.id, kind: kindName(it.kind), setter: it.setter ?? null, args: it.args ?? null },
    });
  }

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

  // v3.2's states (N1 to N4) and money-out figures (N2, N5, S9), each from a fresh reading only (a stale chain's are
  // unknown, and an unknown is never said as a state)
  let exits: FlowV1["exits"];
  if (d.version === "v3.2") {
    const parks = ts ? i.parks : undefined;
    const times = parks?.map((p) => p.parkedAt);
    const refundFrom: Scheduled = !parks ? null : !parks.length ? "none" : times!.every((t) => t !== undefined) ? Math.min(...(times as number[])) + PARK_TIMEOUT_S : null;
    if (ts?.stakeMissing === true) notices.push({ kind: "stakeMissing", chain: "bittensor", contract: d.vault });
    if (parks?.length) notices.push({ kind: "parked", chain: "bittensor", contract: d.bitAdapter, ...(typeof refundFrom === "number" ? { earliest: refundFrom } : {}) });
    // the view the vault defers its door redeems on, read where the rail now primary is (R4-O round 4)
    if (ts && payoutsClosedOf(ts) === true) notices.push({ kind: "payoutsClosed", chain: "bittensor", contract: lc(ts.primaryBridge as string) });
    // a primary disabled on either chain, or the launch door removed: turning either back on is a 7-day Reopen
    const doorOff = !!bs?.exits?.primaryDisabledBy;
    const vaultOff = !!ts?.exits?.primaryDisabledBy || !!ts?.exits?.launchDoorRemovedBy;
    if (doorOff) notices.push({ kind: "routeDisabled", chain: "base", contract: d.frontDoor });
    else if (vaultOff) notices.push({ kind: "routeDisabled", chain: "bittensor", contract: d.vault });
    // the day's limit: the window whose rest is the smaller binds a delivery's burns (both must be read)
    const o = ts && i.bittensor ? outflowOf(i.bittensor) : undefined;
    const binding = o && o.door.read && o.global.read ? (restOf(o.global) < restOf(o.door) ? o.global : o.door) : undefined;
    exits = {
      payoutDelayS: ts?.payoutDelay ?? null,
      dailyLimit: binding ? binding.allowance.toString() : null,
      usedToday: binding ? (binding.burned < binding.allowance ? binding.burned : binding.allowance).toString() : null,
      parked: parks ? parks.reduce((t, p) => t + p.amount, 0n).toString() : null,
      parkedRefundFrom: refundFrom,
    };
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
      backups: ts?.hotkeys ? ts.hotkeys.filter((h) => lc(h) !== lc(stakeHotkey ?? "")) : null,
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
    ...(exits ? { exits } : {}),
  };
}
