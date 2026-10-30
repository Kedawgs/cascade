import { encodeAbiParameters, type Hex, hexToBigInt, keccak256 } from "viem";
import { ADMIN_VIEWS, ALPHA_VAULT, ERC20, EXECUTION_STATES, FRONT_DOOR_VIEWS, OFFRAMP, ORACLE, SAFE, STAKING, TREASURY, UNISWAP_POOL, VAULT_VIEWS } from "./abi.ts";
import type { ChainName, Config } from "./config.ts";
import { multicall, newerThan, type Read } from "./multicall.ts";
import type { Rpc } from "./rpc.ts";
import { decodeAccountId, ownerStorageKey, STAKING_PRECOMPILE, STORAGE_QUERY } from "./subtensor.ts";

// One block-pinned reading of each chain per tick (spec section 6, "Readings"): one Multicall3 call per
// chain, every field optional (a failed sub-call leaves it undefined, and the rules that need it skip).

export interface ChainReading<T> {
  block: bigint;
  /** the block's time */
  time: number;
  state: T;
}

/** The vault and what surrounds it on Bittensor. */
export interface BitState {
  price?: bigint;
  totalAssets?: bigint;
  totalSupply?: bigint;
  rootStakeRao?: bigint;
  pendingPayouts?: bigint;
  paused?: boolean;
  owner?: Hex;
  pendingOwner?: Hex;
  guardian?: Hex;
  pendingGuardian?: Hex;
  keeper?: Hex;
  /** where the reward cut is minted */
  treasury?: Hex;
  stakeHotkey?: Hex;
  /** the vault's hotkey set now (hotkeys(0..3)) */
  hotkeys?: Hex[];
  /** getStake(hotkey, coldkey, root) for each hotkey asked (the set known before this reading) */
  stakes: Record<Hex, bigint>;
  /** the vault's own TAO */
  balance?: bigint;
  payoutDelay?: number;
  maxDailyOutflowBps?: bigint;
  minDailyOutflow?: bigint;
  /** the front door's burn window (burnWindows(peerId(8453, frontDoor))) */
  burnWindow?: { start: number; burned: bigint };
  lastClaimAt?: number;
  /** unclaimed root rewards on the stake hotkey */
  unclaimed?: bigint;
  /** the stake hotkey's owner in SubtensorModule `Owner`; null when it has none */
  hotkeyOwner?: Hex | null;
  minStakeRao?: bigint;
  rewardCutBps?: number;
  /** FM-TAO held by the Bittensor lock pool */
  lockPoolFmTao?: bigint;
  adapterBalance?: bigint;
  keeperBalance?: bigint;
  alpha: { isPaused?: boolean; migrationReadyAt?: bigint; migrationFinished?: boolean };
  /** getPayoutBatch(key) for each pending payout key */
  payoutBatches: Record<Hex, { queuedAt: number; cursor: number; count: number; chunk: number; remaining: bigint }>;
}

/** The front door and what surrounds it on Base. */
export interface BaseState {
  openBatch?: { id: bigint; start: number; totalDeposits: bigint; feePot: bigint; nDeposits: number; nRedeems: number };
  totalClaimable?: bigint;
  totalFeeCredit?: bigint;
  netForwarded?: bigint;
  depositCap?: bigint;
  maxBatchValue?: bigint;
  maxDeposits?: number;
  maxRedeems?: number;
  batchInterval?: number;
  paused?: boolean;
  owner?: Hex;
  pendingOwner?: Hex;
  guardian?: Hex;
  pendingGuardian?: Hex;
  keeper?: Hex;
  oracle?: Hex;
  stakerOwner?: Hex;
  stakerPendingOwner?: Hex;
  /** where the staker's fees go */
  stakerTreasury?: Hex;
  /** FM-TAO the front door holds */
  frontDoorTao?: bigint;
  frontDoorEth?: bigint;
  /** FM-TAO's total supply on Base */
  fmTaoSupply?: bigint;
  taoWethPool: { sqrtPriceX96?: bigint; liquidity?: bigint; tao?: bigint; token0?: Hex };
  wethUsdcPool: { sqrtPriceX96?: bigint; liquidity?: bigint; token0?: Hex };
  /** the front door's oracle's usdcValue(1e18); `oracleReverted` when that call failed */
  oracleValue?: bigint;
  oracleReverted?: boolean;
  keeperBalance?: bigint;
  claimable: Record<Hex, bigint>;
  deliveryOf: Record<Hex, { minUsdcPerTao: bigint; deadline: number; destination: number }>;
}

export interface Snapshot {
  /** the tick's time */
  at: number;
  base?: ChainReading<BaseState>;
  bittensor?: ChainReading<BitState>;
  nonces: Record<ChainName, Record<Hex, bigint>>;
  /** nonce() of each watched owner that is a Safe */
  safeNonces: Record<Hex, bigint>;
  /** the OffRamp execution state of each pending message, on its destination chain */
  messageStates: Record<Hex, string>;
  /** delivered(bridge, keccak256(message)) for each landing awaiting that read, at the Base reading's block */
  deliveredReads: { landedUid: Hex; key: Hex; chunk: number; block: bigint; value: boolean }[];
  /** eth_getCode of the role wallets and Safe candidates asked (lowercase hex; "0x" for an account) */
  codes?: Record<ChainName, Record<Hex, Hex>>;
}

export interface SnapshotInputs {
  /** the blocks of the last readings kept: a reading must be newer */
  last: { base?: bigint; bittensor?: bigint };
  /** from the previous reading (one multicall can't use its own answers): the hotkeys whose stakes to read,
   * the stake hotkey, the keepers, the front door's oracle. Config's values before the first reading. */
  hotkeys?: Hex[];
  stakeHotkey?: Hex;
  keepers?: { base?: Hex; bittensor?: Hex };
  oracle?: Hex;
  pendingMessages: { messageId: Hex; direction: "base>bittensor" | "bittensor>base" }[];
  watched: { chain: ChainName; address: Hex; isSafe?: boolean }[];
  /** addresses whose code to read (the role wallets, for keys.delegated), in the same batch as the counts */
  codesOf?: { chain: ChainName; address: Hex }[];
  /** at most 50 */
  payoutUsers: Hex[];
  deliveredChecks: { landedUid: Hex; key: Hex; chunk: number; bridge: Hex; hash: Hex }[];
  pendingPayoutKeys: { key: Hex; queuedBlock: bigint }[];
}

/** The vault's peerId(chain, addr): keccak256(abi.encode(uint64 chain, address addr)). */
export const peerIdOf = (chain: bigint, addr: Hex): Hex => keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }], [chain, addr]));

const lc = (x: unknown) => String(x).toLowerCase() as Hex;
const state = (n: unknown) => EXECUTION_STATES[Number(n)] ?? String(n);

/** The reads of one chain's multicall, each with what to do with its answer. */
class Plan {
  readonly reads: Read[] = [];
  readonly sets: { ok: (v: unknown) => void; failed?: () => void }[] = [];
  add(read: Read, ok: (v: any) => void, failed?: () => void) {
    this.reads.push(read);
    this.sets.push({ ok, failed });
  }
}

async function readChain<T>(rpc: Rpc, chain: ChainName, plan: Plan, multicall3: Hex, last: bigint | undefined, s: T): Promise<ChainReading<T> | undefined> {
  let r: Awaited<ReturnType<typeof multicall>>;
  try {
    r = await multicall(rpc, chain, plan.reads, multicall3);
  } catch (e) {
    console.warn(`${chain} reading failed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
  // a load-balanced node can answer from an older block: readings only move forward
  if (!newerThan(last, r)) return undefined;
  r.results.forEach((x, i) => (x.ok ? plan.sets[i].ok(x.value) : plan.sets[i].failed?.()));
  return { block: r.block, time: r.time, state: s };
}

/** An eth_getCode answer: whole bytes of hex. */
const CODE = /^0x([0-9a-f]{2})*$/;

/** The watched accounts' transaction counts, and the code of the addresses read as Safes, in one batch. */
async function countsAndCodes(rpc: Rpc, chain: ChainName, counted: Hex[], coded: Hex[]): Promise<{ counts: Record<Hex, bigint>; codes: Record<Hex, Hex> }> {
  if (counted.length + coded.length === 0) return { counts: {}, codes: {} };
  try {
    const out = await rpc.batch(chain, [
      ...counted.map((a) => ({ method: "eth_getTransactionCount", params: [a, "latest"] })),
      ...coded.map((a) => ({ method: "eth_getCode", params: [a, "latest"] })),
    ]);
    // a code counts only when the answer is whole bytes of hex: anything else (null, an odd length) is unread
    const codes: Record<Hex, Hex> = {};
    coded.forEach((a, i) => {
      const c = out[counted.length + i];
      if (typeof c === "string" && CODE.test(c.toLowerCase())) codes[a] = c.toLowerCase() as Hex;
    });
    return { counts: Object.fromEntries(counted.map((a, i) => [a, hexToBigInt(out[i] as Hex)])), codes };
  } catch (e) {
    console.warn(`${chain} transaction counts failed: ${e instanceof Error ? e.message : String(e)}`);
    return { counts: {}, codes: {} };
  }
}

/** An address is read as a Safe (by its nonce()) only when it holds contract code of its own: not an account
 * (no code, nothing answers), and not an EIP-7702 delegated account (code 0xef0100 and the delegate's
 * address), whose delegate may answer nonce() while its transactions are counted by its own nonce. */
export const isContractCode = (code: Hex | undefined): boolean => code !== undefined && code !== "0x" && !code.toLowerCase().startsWith("0xef0100");

/** One reading of both chains: a multicall each (block-pinned), and the watched addresses' transaction
 * counts in one batch per chain (a Safe's nonce() is read in the multicall instead). A chain's reading
 * from a block not newer than the last kept, or one that failed, is left out. */
export async function readSnapshot(rpc: Rpc, cfg: Config, i: SnapshotInputs, nowS: number): Promise<Snapshot> {
  const d = cfg.deployment;
  const t = cfg.tokens;
  const stakeHotkey = i.stakeHotkey ?? d.stakeHotkey;
  const safes = (chain: ChainName) => i.watched.filter((w) => w.chain === chain && w.isSafe).map((w) => w.address);
  /** the code to read: each Safe candidate's (a nonce() counts only from code of its own) and each role wallet's */
  const coded = (chain: ChainName) => [...new Set([...safes(chain), ...(i.codesOf ?? []).filter((w) => w.chain === chain).map((w) => w.address.toLowerCase() as Hex)])];
  const counted = (chain: ChainName) => i.watched.filter((w) => w.chain === chain && !w.isSafe).map((w) => w.address);
  const safeNonces: Record<Hex, bigint> = {};
  const messageStates: Record<Hex, string> = {};

  // Bittensor
  const bit: BitState = { stakes: {}, alpha: {}, payoutBatches: {} };
  const bitMessages: Record<Hex, string> = {};
  const vp = new Plan();
  const vault = (functionName: string, ok: (v: any) => void, args?: unknown[]) => vp.add({ address: d.vault, abi: VAULT_VIEWS, functionName, args }, ok);
  const vadmin = (functionName: string, ok: (v: any) => void) => vp.add({ address: d.vault, abi: ADMIN_VIEWS, functionName }, ok);
  vault("price", (v) => (bit.price = v));
  vault("totalAssets", (v) => (bit.totalAssets = v));
  vault("totalSupply", (v) => (bit.totalSupply = v));
  vault("rootStakeRao", (v) => (bit.rootStakeRao = v));
  vault("pendingPayouts", (v) => (bit.pendingPayouts = v));
  vault("keeper", (v) => (bit.keeper = lc(v)));
  vp.add({ address: d.vault, abi: TREASURY, functionName: "treasury" }, (v) => (bit.treasury = lc(v)));
  vault("stakeHotkey", (v) => (bit.stakeHotkey = lc(v)));
  vault("payoutDelay", (v) => (bit.payoutDelay = Number(v)));
  vault("maxDailyOutflowBps", (v) => (bit.maxDailyOutflowBps = v));
  vault("minDailyOutflow", (v) => (bit.minDailyOutflow = v));
  vault("burnWindows", (v) => (bit.burnWindow = { start: Number(v[0]), burned: v[1] }), [peerIdOf(8453n, d.frontDoor)]);
  vault("lastClaimAt", (v) => (bit.lastClaimAt = Number(v)), [stakeHotkey]);
  vault("minStakeRao", (v) => (bit.minStakeRao = v));
  vault("rewardCutBps", (v) => (bit.rewardCutBps = Number(v)));
  vadmin("owner", (v) => (bit.owner = lc(v)));
  vadmin("pendingOwner", (v) => (bit.pendingOwner = lc(v)));
  vadmin("guardian", (v) => (bit.guardian = lc(v)));
  vadmin("pendingGuardian", (v) => (bit.pendingGuardian = lc(v)));
  vadmin("paused", (v) => (bit.paused = v));
  // the hotkey set now: at most 4 (MAX_HOTKEYS); an index past its end reverts
  const slots: (Hex | undefined)[] = [];
  for (let n = 0; n < 4; n++) vault("hotkeys", (v) => (slots[n] = lc(v)), [BigInt(n)]);
  for (const hk of i.hotkeys ?? [stakeHotkey]) {
    vp.add({ address: STAKING_PRECOMPILE, abi: STAKING, functionName: "getStake", args: [hk, d.vaultColdkey, 0n] }, (v) => (bit.stakes[hk] = v));
  }
  vp.add({ address: STAKING_PRECOMPILE, abi: STAKING, functionName: "getUnclaimedRootTaoByHotkey", args: [d.vaultColdkey, stakeHotkey] }, (v) => (bit.unclaimed = v));
  vp.add({ address: STORAGE_QUERY, callData: ownerStorageKey(stakeHotkey) }, (v) => (bit.hotkeyOwner = decodeAccountId(v)));
  vp.add({ ethBalance: d.vault }, (v) => (bit.balance = v));
  vp.add({ ethBalance: d.bitAdapter }, (v) => (bit.adapterBalance = v));
  if (i.keepers?.bittensor) vp.add({ ethBalance: i.keepers.bittensor }, (v) => (bit.keeperBalance = v));
  vp.add({ address: t.bittensor.fmTao, abi: ERC20, functionName: "balanceOf", args: [t.bittensor.lockPool] }, (v) => (bit.lockPoolFmTao = v));
  vp.add({ address: t.bittensor.alphaVault, abi: ALPHA_VAULT, functionName: "isPaused" }, (v) => (bit.alpha.isPaused = v));
  vp.add({ address: t.bittensor.alphaVault, abi: ALPHA_VAULT, functionName: "migrationReadyAt" }, (v) => (bit.alpha.migrationReadyAt = v));
  vp.add({ address: t.bittensor.alphaVault, abi: ALPHA_VAULT, functionName: "migrationFinished" }, (v) => (bit.alpha.migrationFinished = v));
  for (const p of i.pendingPayoutKeys) {
    vault("getPayoutBatch", (v) => (bit.payoutBatches[p.key] = { queuedAt: Number(v.queuedAt), cursor: Number(v.cursor), count: Number(v.count), chunk: Number(v.chunk), remaining: v.remaining }), [p.key]);
  }
  for (const m of i.pendingMessages.filter((m) => m.direction === "base>bittensor")) {
    vp.add({ address: t.bittensor.offRamp, abi: OFFRAMP, functionName: "getExecutionState", args: [m.messageId] }, (v) => (bitMessages[m.messageId] = state(v)));
  }
  const bitSafes: Record<Hex, bigint> = {};
  for (const a of safes("bittensor")) vp.add({ address: a, abi: SAFE, functionName: "nonce" }, (v) => (bitSafes[a] = v));

  // Base
  const base: BaseState = { taoWethPool: {}, wethUsdcPool: {}, claimable: {}, deliveryOf: {} };
  const baseMessages: Record<Hex, string> = {};
  const delivered: { c: SnapshotInputs["deliveredChecks"][number]; value: boolean }[] = [];
  const bp = new Plan();
  const fd = (functionName: string, ok: (v: any) => void, args?: unknown[]) => bp.add({ address: d.frontDoor, abi: FRONT_DOOR_VIEWS, functionName, args }, ok);
  const fadmin = (functionName: string, ok: (v: any) => void) => bp.add({ address: d.frontDoor, abi: ADMIN_VIEWS, functionName }, ok);
  fd("openBatch", (v) => (base.openBatch = { id: v[0], start: Number(v[1]), totalDeposits: v[2], feePot: v[3], nDeposits: Number(v[4]), nRedeems: Number(v[5]) }));
  fd("totalClaimable", (v) => (base.totalClaimable = v));
  fd("totalFeeCredit", (v) => (base.totalFeeCredit = v));
  fd("netForwarded", (v) => (base.netForwarded = v));
  fd("depositCap", (v) => (base.depositCap = v));
  fd("maxBatchValue", (v) => (base.maxBatchValue = v));
  fd("maxDeposits", (v) => (base.maxDeposits = Number(v)));
  fd("maxRedeems", (v) => (base.maxRedeems = Number(v)));
  fd("batchInterval", (v) => (base.batchInterval = Number(v)));
  fd("keeper", (v) => (base.keeper = lc(v)));
  fd("oracle", (v) => (base.oracle = lc(v)));
  fadmin("owner", (v) => (base.owner = lc(v)));
  fadmin("pendingOwner", (v) => (base.pendingOwner = lc(v)));
  fadmin("guardian", (v) => (base.guardian = lc(v)));
  fadmin("pendingGuardian", (v) => (base.pendingGuardian = lc(v)));
  fadmin("paused", (v) => (base.paused = v));
  bp.add({ address: d.staker, abi: ADMIN_VIEWS, functionName: "owner" }, (v) => (base.stakerOwner = lc(v)));
  bp.add({ address: d.staker, abi: ADMIN_VIEWS, functionName: "pendingOwner" }, (v) => (base.stakerPendingOwner = lc(v)));
  bp.add({ address: d.staker, abi: TREASURY, functionName: "treasury" }, (v) => (base.stakerTreasury = lc(v)));
  bp.add({ address: t.base.fmTao, abi: ERC20, functionName: "totalSupply" }, (v) => (base.fmTaoSupply = v));
  bp.add({ address: t.base.fmTao, abi: ERC20, functionName: "balanceOf", args: [d.frontDoor] }, (v) => (base.frontDoorTao = v));
  bp.add({ address: t.base.fmTao, abi: ERC20, functionName: "balanceOf", args: [t.base.taoWethPool] }, (v) => (base.taoWethPool.tao = v));
  bp.add({ ethBalance: d.frontDoor }, (v) => (base.frontDoorEth = v));
  if (i.keepers?.base) bp.add({ ethBalance: i.keepers.base }, (v) => (base.keeperBalance = v));
  for (const [pool, into] of [
    [t.base.taoWethPool, base.taoWethPool],
    [t.base.wethUsdcPool, base.wethUsdcPool],
  ] as const) {
    bp.add({ address: pool, abi: UNISWAP_POOL, functionName: "slot0" }, (v) => (into.sqrtPriceX96 = v[0]));
    bp.add({ address: pool, abi: UNISWAP_POOL, functionName: "liquidity" }, (v) => (into.liquidity = v));
    bp.add({ address: pool, abi: UNISWAP_POOL, functionName: "token0" }, (v) => (into.token0 = lc(v)));
  }
  bp.add(
    { address: i.oracle ?? d.oracle, abi: ORACLE, functionName: "usdcValue", args: [10n ** 18n] },
    (v) => (base.oracleValue = v),
    () => (base.oracleReverted = true),
  );
  for (const u of i.payoutUsers.slice(0, 50)) {
    fd("claimable", (v) => (base.claimable[u] = v), [u]);
    fd("deliveryOf", (v) => (base.deliveryOf[u] = { minUsdcPerTao: v[0], deadline: Number(v[1]), destination: Number(v[2]) }), [u]);
  }
  for (const c of i.deliveredChecks) fd("delivered", (v) => delivered.push({ c, value: v }), [c.bridge, c.hash]);
  for (const m of i.pendingMessages.filter((m) => m.direction === "bittensor>base")) {
    bp.add({ address: t.base.offRamp, abi: OFFRAMP, functionName: "getExecutionState", args: [m.messageId] }, (v) => (baseMessages[m.messageId] = state(v)));
  }
  const baseSafes: Record<Hex, bigint> = {};
  for (const a of safes("base")) bp.add({ address: a, abi: SAFE, functionName: "nonce" }, (v) => (baseSafes[a] = v));

  const [bitReading, baseReading, baseCounts, bitCounts] = await Promise.all([
    readChain(rpc, "bittensor", vp, t.multicall3, i.last.bittensor, bit),
    readChain(rpc, "base", bp, t.multicall3, i.last.base, base),
    countsAndCodes(rpc, "base", counted("base"), coded("base")),
    countsAndCodes(rpc, "bittensor", counted("bittensor"), coded("bittensor")),
  ]);
  // a nonce() answer counts only from contract code of the address's own (never a 7702 delegation)
  for (const [own, codes] of [
    [baseSafes, baseCounts.codes],
    [bitSafes, bitCounts.codes],
  ] as const) {
    for (const a of Object.keys(own) as Hex[]) if (!isContractCode(codes[a])) delete own[a];
  }

  const snap: Snapshot = {
    at: nowS,
    nonces: { base: baseCounts.counts, bittensor: bitCounts.counts },
    safeNonces,
    messageStates,
    deliveredReads: [],
    codes: { base: baseCounts.codes, bittensor: bitCounts.codes },
  };
  if (bitReading) {
    // the set now: from hotkeys(0) on, up to the first index past its end (unknown if hotkeys(0) failed)
    const set: Hex[] = [];
    for (const hk of slots) {
      if (hk === undefined) break;
      set.push(hk);
    }
    if (slots[0] !== undefined) bit.hotkeys = set;
    snap.bittensor = bitReading;
    Object.assign(messageStates, bitMessages);
    Object.assign(safeNonces, bitSafes);
  }
  if (baseReading) {
    snap.base = baseReading;
    Object.assign(messageStates, baseMessages);
    Object.assign(safeNonces, baseSafes);
    snap.deliveredReads = delivered.map(({ c, value }) => ({ landedUid: c.landedUid, key: c.key, chunk: c.chunk, block: baseReading.block, value }));
  }
  return snap;
}

/** The pending payout keys the reading shows done: getPayoutBatch(key).count is 0 at a block after the
 * key's queue block (a node that hasn't seen the queue answers 0 too, from a block not after it). The one
 * completion source for okKeys and payout.overdue. */
export function payoutsDone(s: Snapshot, pending: readonly { key: Hex; queuedBlock: bigint }[]): { key: Hex; block: bigint }[] {
  const r = s.bittensor;
  if (!r) return [];
  return pending.flatMap((p) => {
    const b = r.state.payoutBatches[p.key];
    return b && b.count === 0 && r.block > p.queuedBlock ? [{ key: p.key, block: r.block }] : [];
  });
}

const bigOut = (_k: string, v: unknown) => (typeof v === "bigint" ? { $bigint: v.toString() } : v);
const bigIn = (_k: string, v: any) => (v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.$bigint === "string" ? BigInt(v.$bigint) : v);

/** A snapshot as stored in `readings`: JSON, bigints tagged { $bigint } (the ops record's form). */
export const compact = (s: Snapshot): string => JSON.stringify(s, bigOut);

export const expand = (json: string): Snapshot => JSON.parse(json, bigIn) as Snapshot;

/** An hour row as stored in `hours`, in the same form. */
export const compactHour = (h: HourAgg): string => JSON.stringify(h, bigOut);

/** An hour row read back; undefined for one that can't be read (it is then left out, never fatal). */
export function expandHour(json: string): HourAgg | undefined {
  try {
    const h = JSON.parse(json, bigIn) as HourAgg;
    return typeof h?.hour === "number" ? h : undefined;
  } catch {
    return undefined;
  }
}

/** One hour's running aggregates, updated by each tick (rules that look back a day or a week read these,
 * not per-minute readings). `hour` is the unix time the hour starts at. */
export interface HourAgg {
  hour: number;
  ticks: number;
  priceHigh?: bigint;
  priceLow?: bigint;
  priceLast?: bigint;
  rootStakeLast?: bigint;
  supplyFirst?: bigint;
  supplyLast?: bigint;
  poolTaoLow?: bigint;
  poolTaoLast?: bigint;
  liquidityLow?: bigint;
  liquidityLast?: bigint;
  unclaimedFirst?: bigint;
  unclaimedLast?: bigint;
  /** the pool's TAO price in USD, summed over the readings that had one */
  spotSum: number;
  spotCount: number;
}

const hi = (a: bigint | undefined, b: bigint | undefined) => (a === undefined ? b : b === undefined ? a : a > b ? a : b);
const lo = (a: bigint | undefined, b: bigint | undefined) => (a === undefined ? b : b === undefined ? a : a < b ? a : b);

/** The hour's aggregates with this tick's reading: a new hour starts afresh. */
export function hourRollup(prev: HourAgg | undefined, s: Snapshot, spotUsd?: number): HourAgg {
  const hour = Math.floor(s.at / 3600) * 3600;
  const p: HourAgg = prev && prev.hour === hour ? prev : { hour, ticks: 0, spotSum: 0, spotCount: 0 };
  const bit = s.bittensor?.state;
  const base = s.base?.state;
  return {
    hour,
    ticks: p.ticks + 1,
    priceHigh: hi(p.priceHigh, bit?.price),
    priceLow: lo(p.priceLow, bit?.price),
    priceLast: bit?.price ?? p.priceLast,
    rootStakeLast: bit?.rootStakeRao ?? p.rootStakeLast,
    supplyFirst: p.supplyFirst ?? base?.fmTaoSupply,
    supplyLast: base?.fmTaoSupply ?? p.supplyLast,
    poolTaoLow: lo(p.poolTaoLow, base?.taoWethPool.tao),
    poolTaoLast: base?.taoWethPool.tao ?? p.poolTaoLast,
    liquidityLow: lo(p.liquidityLow, base?.taoWethPool.liquidity),
    liquidityLast: base?.taoWethPool.liquidity ?? p.liquidityLast,
    unclaimedFirst: p.unclaimedFirst ?? bit?.unclaimed,
    unclaimedLast: bit?.unclaimed ?? p.unclaimedLast,
    spotSum: p.spotSum + (spotUsd ?? 0),
    spotCount: p.spotCount + (spotUsd === undefined ? 0 : 1),
  };
}
