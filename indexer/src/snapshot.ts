import { type Abi, encodeAbiParameters, encodeFunctionData, type Hex, hexToBigInt, keccak256, toBytes } from "viem";
import {
  ADAPTER_PEER_VIEWS,
  ADMIN_VIEWS,
  ALPHA_VAULT,
  BIT_ADAPTER_V32_VIEWS,
  BIT_RAIL_VIEWS,
  BRIDGE_VIEWS,
  CCIP_SELECTOR,
  DOOR_LENS_VIEWS,
  ERC20,
  EXECUTION_STATES,
  FRONT_DOOR_V32_VIEWS,
  FRONT_DOOR_VIEWS,
  MULTICALL3,
  OFFRAMP,
  ORACLE,
  ORACLE_V32,
  QUOTER_V2,
  SAFE,
  SAFE_OWNERS,
  STAKE_RAMP_S,
  STAKING,
  TOKEN_POOL,
  TREASURY,
  UNISWAP_POOL,
  VAULT_LENS_VIEWS,
  VAULT_V32_VIEWS,
  VAULT_VIEWS,
} from "./abi.ts";
import { type ChainName, type Config, PATH_TAO_TO_USDC, PATH_USDC_TO_TAO, UNISWAP_QUOTER as QUOTER } from "./config.ts";
import { encodePayoutsMessage } from "./crosscheck/payouts.ts";
import { encodeBatchMessage } from "./crosscheck/replay.ts";
import { multicall, newerThan, type Read } from "./multicall.ts";
import type { Rpc } from "./rpc.ts";
// the reads no ForeverMoney event replaces (R3 FM-L2), on every deployment
import { LOCK_POOL, TOKEN_ADMIN_REGISTRY } from "./abi.ts";
import {
  decodeAccountId,
  decodeAccountIds,
  decodeU16,
  decodeU64,
  delegatesKey,
  ownerStorageKey,
  ROOT_STAKE_UNLOCK_INTERVAL_KEY,
  STAKING_PRECOMPILE,
  stakingHotkeysKey,
  STORAGE_QUERY,
  totalHotkeyAlphaKey,
  uidsKey,
} from "./subtensor.ts";

/** At most this many hotkeys' stakes are read a tick (the vault lists at most 4; the chain's list for the
 * coldkey is bounded by what ever held its stake). */
const MAX_STAKE_READS = 16;

/** The payout chunk payout.fee_ceiling has the primary bridge quote: the most entries a chunk holds (CascadeMessages
 * MAX_ENTRIES, the keeper's maxEntries), so the costliest message, worth the most a chunk can carry: the lower of the
 * vault's and its bridge's maxMessageValue, from the last reading (15 and 50 TAO live on 2026-10-31; more reverts
 * MessageTooLarge), so a fee in basis points of the amount is priced too (none today: 1 and 50 TAO quoted the same).
 * 1 TAO until a reading has named them. Its content is a stand-in; the fee follows its size, gas and amount. */
const QUOTE_ENTRIES = 100;
const QUOTE_DEFAULT_AMOUNT = 10n ** 18n;
const quoteMessage = (amount: bigint) =>
  encodePayoutsMessage(
    keccak256(toBytes("cascade monitor fee quote")),
    0,
    Array.from({ length: QUOTE_ENTRIES }, (_, i) => ({ user: `0x${(i + 1).toString(16).padStart(40, "0")}` as Hex, amount: amount / BigInt(QUOTE_ENTRIES) })),
  );
/** The quote's message, kept for the last amount asked (it changes only when a limit does). */
let quoteCache: { amount: bigint; message: Hex } | undefined;
const quoteFor = (amount: bigint): Hex => {
  if (quoteCache?.amount !== amount) quoteCache = { amount, message: quoteMessage(amount) };
  return quoteCache.message;
};

/** R12a: the batch the front door's primary bridge quotes a close of, for batch.redeem_fee_thin and keeper.low_eth: the
 * most entries a batch holds on each side (CascadeMessages MAX_ENTRIES, the launch's maxDeposits and maxRedeems, 50 +
 * 50: the costliest close, 7,000,000 gas toward Bittensor at launch), its deposits worth the front door's maxBatchValue
 * from the last reading (1 TAO until a reading has named it). The keeper sends three of this quote as a full batch's
 * close float. Its content is a stand-in; the fee follows its size, gas and amount. */
const FULL_BATCH_ENTRIES = 50;
const fullBatchMessage = (amount: bigint): Hex =>
  encodeBatchMessage(
    1n,
    Array.from({ length: FULL_BATCH_ENTRIES }, (_, i) => ({ user: `0x${(i + 1).toString(16).padStart(40, "0")}` as Hex, amount: amount / BigInt(FULL_BATCH_ENTRIES) })),
    Array.from({ length: FULL_BATCH_ENTRIES }, (_, i) => ({ user: `0x${(i + 1 + FULL_BATCH_ENTRIES).toString(16).padStart(40, "0")}` as Hex, amount: 10n ** 18n })),
  );
let closeQuoteCache: { amount: bigint; message: Hex } | undefined;
const fullBatchFor = (amount: bigint): Hex => {
  if (closeQuoteCache?.amount !== amount) closeQuoteCache = { amount, message: fullBatchMessage(amount) };
  return closeQuoteCache.message;
};

/** A CCIP token pool's rate-limit bucket, refilled to the reading's block. */
export interface Bucket {
  tokens: bigint;
  isEnabled: boolean;
  capacity: bigint;
  rate: bigint;
}
/** A token pool's buckets for Cascade's lane: inbound (from the other chain) and outbound (to it), and whether the pool
 * still lists the other chain (isSupportedChain). In CCIP a bucket that is off (isEnabled false: capacity, rate and
 * tokens 0) is no limit; a lane removed from the pool reads the same, so only `supported` tells the two apart. */
export interface Lane {
  inbound?: Bucket;
  outbound?: Bucket;
  supported?: boolean;
}
/** A token's entry in Chainlink's TokenAdminRegistry (getTokenConfig): who administers it, who it is being moved to
 * (the zero address: nobody), and the pool CCIP releases or mints it through. */
export interface RegistryEntry {
  administrator: Hex;
  pendingAdministrator: Hex;
  tokenPool: Hex;
}

// One block-pinned reading of each chain per tick (spec section 6, "Readings"): one Multicall3 call per
// chain, every field optional (a failed sub-call leaves it undefined, and the rules that need it skip).
// A v3.2 deployment (DEPLOYMENT.version) reads the vault's and the front door's moved getters through their lenses in
// the same multicall, and the v3.2-only fields below; a v3.1 deployment (the live v3-launch) reads exactly what it did.

/** A validator, as SubtensorModule stores it: its take (of 65,535; null: no Delegates entry, which is the chain's
 * default take, 18%), the stake on it on root (rao, everyone's) and its root uid (null: not registered on root); a
 * field undefined when its answer didn't decode. */
export interface Validator {
  hotkey: Hex;
  take?: number | null;
  rootStake?: bigint;
  rootUid?: number | null;
}

/** v3.2: the exits machine on one chain (spec §3.6), read through its lens: whether exits are open, each actor's
 * hold, who holds the pause and the primary bridge's disable (Actor: 0 None, 1 Owner, 2 Guardian), each actor's last
 * close, and when the pending owner's transfer started (unix seconds; 0: never, or none pending). */
export interface Exits {
  open?: boolean;
  ownerHold?: boolean;
  guardianHold?: boolean;
  /** the vault only */
  pausedBy?: number;
  primaryDisabledBy?: number;
  /** the vault only: who removed the launch door */
  launchDoorRemovedBy?: number;
  lastOwnerClose?: number;
  lastGuardianClose?: number;
  pendingSince?: number;
}

/** v3.2: scheduled(id) as a lens answers it (CascadeTypes.sol Item): when it was scheduled and may run (unix
 * seconds), its delay class (Param 0, Registry 1, Guardian 2), its kind (Ordinary 0, GuardianSwap 1, Reopen 2), its
 * selector and the block it may run from; all zero for an id the scheduler doesn't hold (executed, cancelled,
 * pruned or never scheduled). */
export interface ScheduledItem {
  scheduledAt: number;
  readyAt: number;
  class: number;
  kind: number;
  selector: Hex;
  readyBlock: bigint;
}

/** v3.2: the owner the last reading named, read as a Safe: its threshold and signers, kept only when its code is a
 * contract's own (never an account's, nor an EIP-7702 delegation's, whose delegate may answer). Its code is in the
 * snapshot's `codes`. */
export interface OwnerSafe {
  address: Hex;
  threshold?: bigint;
  signers?: Hex[];
}

/** v3.2: a Bittensor bridge (each BRIDGES.bittensor adapter): its native TAO and wTAO, what it holds for parks, and
 * the reserve and cushion it keeps (bridge.cushion_low: balance − parkedNative under reserveTarget / 2, or the booked
 * tokenCushion under tokenReserveTarget / 2). Its wTAO above parkedTokens + tokenCushion is surplus, the sweep's. */
export interface BitAdapterState {
  balance?: bigint;
  tokens?: bigint;
  parkedNative?: bigint;
  parkedTokens?: bigint;
  reserveTarget?: bigint;
  tokenReserveTarget?: bigint;
  /** R4 (F-1): the token cushion booked by fundCushion (CushionFunded), less the shortfalls it covered */
  tokenCushion?: bigint;
}

/** v3.2: one half of a rail (rails.incoherent), an adapter as its own chain reads it in that chain's multicall: the
 * adapter on the other chain it sends to and alone takes messages from, and that chain's id (its immutables
 * remoteAdapter() and remoteChainId()); and, through this chain's lens, whether this chain's contract (the vault, or the
 * front door) has it enabled (bridgeEnabled) and has ever enabled it (bridgeKnown). A field whose read failed is
 * undefined, never false. */
export interface RailHalf {
  remote?: Hex;
  remoteChainId?: bigint;
  enabled?: boolean;
  known?: boolean;
  /** its setup, which a bridge must share with the deploy's adapter on its chain (R4-O's fix round, Minor 8: ops' rail
   * check's fields, ops/src/v32/pairs.ts): its CCIP router and token, the remote selector it sends to, and on Bittensor
   * the AlphaVault that converts its tokens */
  router?: Hex;
  token?: Hex;
  remoteSelector?: bigint;
  alphaVault?: Hex;
  /** on Bittensor (R4, S-H1): canSendPayouts(), whether the adapter can send payouts now: the view the vault reads on its
   * primary bridge once per delivery, deferring every front-door redeem while it is false (payoutsClosedOf) */
  canSendPayouts?: boolean;
}

/** v3.2: a lens whose target() answered another contract than the one DEPLOYMENT names for it. */
export interface LensMismatch {
  lens: Hex;
  target: Hex;
  expected: Hex;
}

/** v3.2: a Base bridge (each BRIDGES.base adapter): its ETH and FM-TAO (a surplus it may sweep). */
export interface BaseAdapterState {
  balance?: bigint;
  tokens?: bigint;
}

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
  /** the visible stake, in rao: rootStakeRao() on v3.1, visibleStakeRao() (the same sum of the listed hotkeys' root
   * stake, renamed) on v3.2 */
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
  /** getStake(hotkey, coldkey, root) for each hotkey asked: the set known before this reading, the stake
   * hotkey (the configured one too) and the hotkeys the chain listed for the coldkey before this reading */
  stakes: Record<Hex, bigint>;
  /** the hotkeys SubtensorModule.StakingHotkeys names for the vault's coldkey: where its stake sits, listed by
   * the vault or not (a validator's hotkey swap moves it to a hotkey the vault doesn't list); undefined when the
   * answer couldn't be decoded, [] when the coldkey has no entry */
  stakedHotkeys?: Hex[];
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
  alpha: {
    isPaused?: boolean;
    migrationReadyAt?: bigint;
    migrationFinished?: boolean;
    /** a guardian's timed pause runs until this time (0: none) */
    pausedUntil?: bigint;
    pauseableAfter?: bigint;
    /** where an announced migration moves the AlphaVault's holdings (zero: none) */
    migrationTarget?: Hex;
    migrationExecuted?: boolean;
    /** pendingDefaultAdmin(): a scheduled admin transfer (the zero address: none) and when it may be accepted */
    pendingAdmin?: { admin: Hex; schedule: number };
    /** backing(wTAO): what the AlphaVault holds against wTAO, in wei of TAO */
    backing?: bigint;
  };
  /** v3.2 (R4-O round 4): the AlphaVaults `alpha` was read at: those of the rail now primary on each chain
   * (SnapshotInputs.alphaVaults), TOKENS' until the readings name them. Two while half switched: `alpha` is then both as
   * one (paused or finished if either is, the later notice) */
  alphaVaults?: Hex[];
  /** v3.2 (R4-O round 4): the deploy's Bittensor adapter's own AlphaVault (the old vault after a migration): the target
   * it announced and whether its migration executed and finished, which rails.incoherent's accepted-target rule reads */
  deployAlpha?: { vault: Hex; migrationTarget?: Hex; migrationFinished?: boolean; migrationExecuted?: boolean };
  /** wTAO's total supply (TOKENS.bittensor.fmTao): what the AlphaVault's backing must cover */
  wTaoSupply?: bigint;
  /** the lock pool's rebalancer (getRebalancer; the zero address: none): the one account that can withdraw its wTAO */
  lockPoolRebalancer?: Hex;
  /** wTAO's entry in Bittensor's TokenAdminRegistry */
  registry?: RegistryEntry;
  /** the lock pool's buckets for the Base lane */
  lane?: Lane;
  /** the stake hotkey as a validator (the primary) */
  validator?: Validator;
  /** the standby validator (STANDBY_HOTKEY), on any deployment that sets it; absent when unset */
  standby?: Validator;
  /** SubtensorModule.RootStakeUnlockInterval, in blocks (0: unset, no hold) */
  rootUnlockInterval?: bigint;
  /** the gas the vault requires left before a claim (the keeper sends claimGasRequired + 2M) */
  claimGasRequired?: bigint;
  /** the block's base fee: Bittensor takes a transaction's whole gas limit at it up front */
  baseFee?: bigint;
  primaryBridge?: Hex;
  /** the vault's payout fee ceiling: a chunk's fee may be at most max(sum × maxFeeBps / 10,000, maxFeeAbs) */
  maxFeeAbs?: bigint;
  maxFeeBps?: bigint;
  /** the largest chunk the vault sends (its maxMessageValue), and the most its primary bridge carries in a message */
  maxMessageValue?: bigint;
  bridgeMaxMessageValue?: bigint;
  /** the primary bridge's fee for a full payout chunk (QUOTE_ENTRIES entries), rounded up to whole rao as the vault does */
  payoutFeeQuote?: bigint;
  /** getPayoutBatch(key) for each pending payout key */
  payoutBatches: Record<Hex, { queuedAt: number; cursor: number; count: number; chunk: number; remaining: bigint }>;
  /** a getPayoutBatch read failed: its key is missing from payoutBatches, so they aren't all known */
  payoutBatchFailed?: boolean;

  // v3.2 only (the vault lens; spec §8.1), absent on v3.1
  /** the lens's target() was another contract than DEPLOYMENT.vault: every field read through the lens is left
   * unread (monitor.unjudged names it); lensUnchecked: target() didn't answer, so they are unread and nothing is known */
  lensMismatch?: LensMismatch;
  lensUnchecked?: boolean;
  /** the ledger, in rao: the booked stake, the booked stake the hotkey set doesn't show (a swap's), the visible stake
   * above booked (a gift, or stake back after a write-off), and the stake on hotkeys the vault doesn't list;
   * stakeMissing is the stake guard (missing beyond its tolerance). The vault prices min(visible, booked). */
  bookedStake?: bigint;
  /** Ledger.ramping, in wei, as last written (at lastStakeAt, unix seconds): not the part ramping now, which is it
   * spent linearly over STAKE_RAMP_S from lastStakeAt (stillRamping). The outflow allowance's base is
   * min(visible, booked) × 1e9 less that part. */
  rampingStake?: bigint;
  lastStakeAt?: number;
  missingStakeRao?: bigint;
  surplusStakeRao?: bigint;
  unlistedStakeRao?: bigint;
  /** v3.2 (R11: ChatGPT r3, claim 1): the lens's unlistedStakeRao() reverted in an answered multicall, the lens's own
   * target() checked: it totals the vault's coldkey with getTotalColdkeyStakeOnSubnet, the read the vault's write-off
   * bound makes (capped, and 0 when it fails), so that bound can't be read (stake.writeoff_bound_off). Absent when it
   * answered, and when it was unread (the lens unchecked or another vault's, the multicall failed). */
  unlistedStakeFailed?: true;
  /** v3.2 (R6, ChatGPT R2 claim C): what the precompile's getTotalColdkeyStakeOnSubnet(the vault's coldkey, root) costs
   * now, the read the vault's write-off caps at WRITE_OFF_READ_GAS (45,000,000): eth_estimateGas of it, less the 21,000 a
   * transaction starts with. It grows with every position on the coldkey, on any subnet, and anyone can add one under a
   * hotkey the vault ever listed. Undefined when the node refused the estimate (stake.writeoff_read_gas: unjudged). */
  writeOffReadGas?: bigint;
  stakeMissing?: boolean;
  grossAssets?: bigint;
  /** the reward vesting as it stands (the write-down and the vesting snapshot log nothing, so it is read, never
   * rebuilt from events): unvested now, both drips' sum (Revision 27); the claim schedule's amount vesting, from when
   * and over how long (seconds); the adoption drip's three, laid out the same (an adoption restarts only its drip,
   * never the claim schedule; all 0 until an adoption, or a write-down at a supply of 0, first sets them); and
   * rewardVesting, the period a new restart of either takes */
  unvestedRewards?: bigint;
  vestingAmount?: bigint;
  vestingStart?: number;
  vestingPeriod?: number;
  adoptVestingAmount?: bigint;
  adoptVestingStart?: number;
  adoptVestingPeriod?: number;
  rewardVesting?: number;
  /** the last adoptStake (unix seconds; 0: never) */
  lastAdoptAt?: number;
  idleBufferBps?: number;
  /** every door's exits together in 24 hours (bps of the allowance base), and their shared window
   * (burnWindows(bytes32(0))) */
  globalOutflowBps?: bigint;
  globalWindow?: { start: number; burned: bigint };
  /** launchChain() (an immutable on the vault), and activeDoors(launchChain): the active front doors there, asked for
   * Base (8453); doorState of the configured front door (Unknown 0, Active 1, Removed 2) */
  launchChain?: bigint;
  activeDoors?: bigint;
  doorState?: number;
  exits?: Exits;
  /** scheduled(id) for each pending item asked (SnapshotInputs.scheduledIds) */
  scheduled?: Record<Hex, ScheduledItem>;
  /** v3.2: the vault's MS_PER_BLOCK (through its lens), its block time as the deploy calibrated it, in ms: an item's window
   * in blocks is counted in it (Revision 28) */
  msPerBlock?: number;
  /** getUnclaimedRootTaoByHotkey(coldkey, hotkey) for each hotkey in the set (and the stake hotkey): a hotkey with
   * credits can't be removed by a stranger */
  unclaimedBy?: Record<Hex, bigint>;
  /** each Bittensor bridge, by address */
  adapters?: Record<Hex, BitAdapterState>;
  /** each Bittensor adapter as a rail half (BRIDGES.bittensor and SnapshotInputs.railCandidates), by address */
  rails?: Record<Hex, RailHalf>;
  ownerSafe?: OwnerSafe;
  /** the limits a scheduled setter's direction is judged against (beside payoutDelay, the outflow and fee limits,
   * maxMessageValue, the reward cut and vesting and idleBufferBps above): the largest entry and the smallest chunk a
   * payout message carries, and the cap on the vault's assets (wei) */
  maxEntryValue?: bigint;
  minChunk?: number;
  maxTotalAssets?: bigint;
  /** the unclaimed rewards (rao) up to which the keeper or the guardian may remove an empty hotkey */
  hotkeyDustRao?: bigint;
}

/** The front door and what surrounds it on Base. */
export interface BaseState {
  openBatch?: { id: bigint; start: number; totalDeposits: bigint; feePot: bigint; nDeposits: number; nRedeems: number };
  totalClaimable?: bigint;
  totalFeeCredit?: bigint;
  netForwarded?: bigint;
  depositCap?: bigint;
  maxBatchValue?: bigint;
  /** v3.2 (R6b, U4): the door's own canClose(), read with the rest: batch.deposits_blocked judges by it */
  canClose?: boolean;
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
  /** QuoterV2.quoteExactInput(PATH_USDC_TO_TAO, 1_000e6): TAO wei a $1,000 deposit gets (pool fees included) */
  buyQuote1000?: bigint;
  /** QuoterV2.quoteExactInput(PATH_TAO_TO_USDC, sellSize): USDC units for `sellSize` TAO wei */
  sellQuote?: { taoIn: bigint; usdcOut: bigint };
  /** USDC.balanceOf(wethUsdcPool) */
  wethUsdcPoolUsdc?: bigint;
  /** FM-TAO's total supply on Base */
  fmTaoSupply?: bigint;
  /** the pools the TWAP oracle reads: `cardinality` is how many observations each keeps (slot0) */
  taoWethPool: { sqrtPriceX96?: bigint; liquidity?: bigint; tao?: bigint; token0?: Hex; cardinality?: number; cardinalityNext?: number };
  wethUsdcPool: { sqrtPriceX96?: bigint; liquidity?: bigint; token0?: Hex; cardinality?: number; cardinalityNext?: number };
  /** the Base token pool's buckets for the Bittensor lane */
  lane?: Lane;
  /** FM-TAO's entry in Base's TokenAdminRegistry */
  registry?: RegistryEntry;
  /** the front door's oracle's usdcValue(1e18); `oracleReverted` when that call failed */
  oracleValue?: bigint;
  oracleReverted?: boolean;
  keeperBalance?: bigint;
  /** R12a: the front door's redeemRequestFee, the ETH the first redeem request a user makes in a batch pays its pot */
  redeemRequestFee?: bigint;
  /** R12a: the front door's primary bridge's fee to close a full batch (50 deposits and 50 redeem requests: the costliest
   * close), the quote a keeper's float is three of (batch.redeem_fee_thin, keeper.low_eth) */
  fullBatchQuote?: bigint;
  claimable: Record<Hex, bigint>;
  deliveryOf: Record<Hex, { minUsdcPerTao: bigint; deadline: number; destination: number }>;

  // v3.2 only (the front door, its lens and its oracle), absent on v3.1
  /** the door lens's target() was another contract than DEPLOYMENT.frontDoor (or, lensUnchecked, didn't answer):
   * every field read through it is unread */
  lensMismatch?: LensMismatch;
  lensUnchecked?: boolean;
  primaryBridge?: Hex;
  /** the fee pot carried into the open batch (the owner may sweep up to it) */
  potCarried?: bigint;
  minDeposit?: bigint;
  /** the floors deliver() checks against the oracle's meanLiquidity (ThinPool below either) */
  minPoolLiquidity?: { taoWeth?: bigint; wethUsdc?: bigint };
  /** the oracle's meanLiquidity(): each pool's mean in-range liquidity over the TWAP window */
  meanLiquidity?: { taoWeth: bigint; wethUsdc: bigint };
  /** the oracle's MIN_CARDINALITY, the observations each pool must keep (the pools' own are in taoWethPool and
   * wethUsdcPool) */
  minCardinality?: number;
  exits?: Exits;
  scheduled?: Record<Hex, ScheduledItem>;
  /** v3.2: the front door's MS_PER_BLOCK (through its lens), in ms (Revision 28) */
  msPerBlock?: number;
  /** each Base bridge, by address */
  adapters?: Record<Hex, BaseAdapterState>;
  /** each Base adapter as a rail half (BRIDGES.base and SnapshotInputs.railCandidates), by address */
  rails?: Record<Hex, RailHalf>;
  ownerSafe?: OwnerSafe;
  /** the market floor's discount to the oracle on a delivery, in bps (a scheduled setter loosens it up) */
  maxDeliverySlippageBps?: number;
}

export interface Snapshot {
  /** the tick's time */
  at: number;
  base?: ChainReading<BaseState>;
  bittensor?: ChainReading<BitState>;
  nonces: Record<ChainName, Record<Hex, bigint>>;
  /** nonce() of each watched address that is a Safe, per chain (one Safe address can be deployed on both), read in that
   * chain's multicall at its reading's block */
  safeNonces: Record<ChainName, Record<Hex, bigint>>;
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
   * the hotkeys the chain listed for the coldkey, the stake hotkey, the keepers, the front door's oracle.
   * Config's values before the first reading. */
  hotkeys?: Hex[];
  stakedHotkeys?: Hex[];
  stakeHotkey?: Hex;
  keepers?: { base?: Hex; bittensor?: Hex };
  oracle?: Hex;
  /** the previous Base reading's oracleValue: a $1,000 sell quote is sized by it (no quote without one) */
  previousOracleValue?: bigint;
  /** the vault's primary bridge, which quotes the payout fee */
  bitBridge?: Hex;
  /** what the payout fee quote's chunk carries: the lower of the vault's and its bridge's maxMessageValue */
  payoutQuoteAmount?: bigint;
  /** R12a: the front door's primary bridge (the last Base reading's), which quotes a full batch's close (else the
   * deployment's Base adapter), and what that batch's deposits are worth: the front door's maxBatchValue as last read */
  baseBridge?: Hex;
  fullBatchAmount?: bigint;
  /** v3.2: the owners the last reading named, whose threshold and signers to read (and whose code, in the counts
   * batch) */
  owners?: { base?: Hex; bittensor?: Hex };
  /** v3.2: the scheduled items to read through each chain's lens */
  scheduledIds?: { chain: ChainName; id: Hex }[];
  /** v3.2: the adapters to read as rail halves beside BRIDGES, on each chain (railCandidatesOf the last readings) */
  railCandidates?: { base?: Hex[]; bittensor?: Hex[] };
  /** v3.2 (R4-O round 4): the AlphaVaults of the rail now primary on each chain, and the deploy adapter's own
   * (alphaVaultsOf the last readings) */
  alphaVaults?: { primary: Hex[]; deploy?: Hex };
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
const RAO_WEI = 10n ** 9n;
const USDC_UNIT = 10n ** 6n;
const bucketOf = (v: { tokens: bigint; isEnabled: boolean; capacity: bigint; rate: bigint }): Bucket => ({ tokens: v.tokens, isEnabled: v.isEnabled, capacity: v.capacity, rate: v.rate });
const registryOf = (v: { administrator: Hex; pendingAdministrator: Hex; tokenPool: Hex }): RegistryEntry => ({ administrator: lc(v.administrator), pendingAdministrator: lc(v.pendingAdministrator), tokenPool: lc(v.tokenPool) });
const state = (n: unknown) => EXECUTION_STATES[Number(n)] ?? String(n);

/** The reads of one chain's multicall, each with what to do with its answer. A read behind a gate (a lens's) counts
 * only when the gate's own read, in the same multicall, answered what it must (the lens's target(): the deployment's
 * contract); otherwise it is unread, never another contract's number. */
class Plan {
  readonly reads: Read[] = [];
  readonly sets: { ok: (v: unknown) => void; failed?: () => void; gate?: string }[] = [];
  readonly gates = new Map<string, { index: number; expected: Hex; shut: (answer: Hex | undefined) => void }>();
  add(read: Read, ok: (v: any) => void, failed?: () => void, gate?: string) {
    this.reads.push(read);
    this.sets.push({ ok, failed, gate });
  }
  /** A gate: `read` must answer `expected` (an address) for the reads behind it to count; `shut` is told what it
   * answered instead (undefined: it didn't answer, so nothing is known). */
  gate(name: string, read: Read, expected: Hex, shut: (answer: Hex | undefined) => void) {
    this.gates.set(name, { index: this.reads.length, expected: lc(expected), shut });
    this.add(read, () => {});
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
  const shut = new Set<string>();
  for (const [name, g] of plan.gates) {
    const x = r.results[g.index];
    if (x.ok && lc(x.value) === g.expected) continue;
    shut.add(name);
    g.shut(x.ok ? lc(x.value) : undefined);
  }
  r.results.forEach((x, i) => {
    const set = plan.sets[i];
    if (x.ok && !(set.gate && shut.has(set.gate))) set.ok(x.value);
    else set.failed?.();
  });
  return { block: r.block, time: r.time, state: s };
}

/** R6 (ChatGPT R2 claim C): eth_estimateGas of the write-off's aggregate read for `coldkey` on root, less the 21,000 a
 * transaction starts with; undefined when the node refuses it (never taken as cheap). */
async function writeOffReadGasOf(rpc: Rpc, coldkey: Hex): Promise<bigint | undefined> {
  try {
    const data = encodeFunctionData({ abi: STAKING, functionName: "getTotalColdkeyStakeOnSubnet", args: [coldkey, 0n] });
    const gas = hexToBigInt((await rpc.call("bittensor", "eth_estimateGas", [{ to: STAKING_PRECOMPILE, data }])) as Hex);
    return gas > 21_000n ? gas - 21_000n : 0n;
  } catch (e) {
    console.warn(`bittensor write-off read's gas estimate failed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
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

/** v3.2's global burn window: burnWindows(bytes32(0)), every door's exits together. */
const GLOBAL_WINDOW = `0x${"00".repeat(32)}` as Hex;

/** scheduled(id)'s Item as read. */
const itemOf = (v: { scheduledAt: bigint; readyAt: bigint; class: number; kind: number; selector: Hex; readyBlock: bigint }): ScheduledItem => ({
  scheduledAt: Number(v.scheduledAt),
  readyAt: Number(v.readyAt),
  class: Number(v.class),
  kind: Number(v.kind),
  selector: lc(v.selector),
  readyBlock: v.readyBlock,
});

/** Asks an owner, as a Safe, for its threshold and signers (an account answers nothing that decodes). */
function safeOwnersOf(plan: Plan, rec: OwnerSafe) {
  plan.add({ address: rec.address, abi: SAFE_OWNERS, functionName: "getThreshold" }, (v: bigint) => (rec.threshold = v));
  plan.add({ address: rec.address, abi: SAFE_OWNERS, functionName: "getOwners" }, (v: readonly Hex[]) => (rec.signers = v.map(lc)));
}

/** An owner's Safe reading, kept only from contract code of its own (as a Safe's nonce() is). */
const ownSafe = (rec: OwnerSafe, codes: Record<Hex, Hex>): OwnerSafe => (isContractCode(codes[rec.address]) ? rec : { address: rec.address });

/** One reading of both chains: a multicall each (block-pinned), and the watched addresses' transaction
 * counts in one batch per chain (a Safe's nonce() is read in the multicall instead). A chain's reading
 * from a block not newer than the last kept, or one that failed, is left out. */
export async function readSnapshot(rpc: Rpc, cfg: Config, i: SnapshotInputs, nowS: number): Promise<Snapshot> {
  const d = cfg.deployment;
  const t = cfg.tokens;
  const v32 = d.version === "v3.2";
  const stakeHotkey = i.stakeHotkey ?? d.stakeHotkey;
  const safes = (chain: ChainName) => i.watched.filter((w) => w.chain === chain && w.isSafe).map((w) => w.address);
  /** v3.2: the owner the last reading named on a chain, read as a Safe */
  const ownerOn = (chain: ChainName): Hex | undefined => (v32 && i.owners?.[chain] ? lc(i.owners[chain]) : undefined);
  /** the code to read: each Safe candidate's (a nonce() counts only from code of its own), each role wallet's, and on
   * v3.2 the owner's (its threshold and signers count only from code of its own) */
  const coded = (chain: ChainName) => {
    const owner = ownerOn(chain);
    return [...new Set([...safes(chain), ...(i.codesOf ?? []).filter((w) => w.chain === chain).map((w) => w.address.toLowerCase() as Hex), ...(owner ? [owner] : [])])];
  };
  const counted = (chain: ChainName) => i.watched.filter((w) => w.chain === chain && !w.isSafe).map((w) => w.address);
  /** v3.2: the adapters read as rail halves on a chain (rails.incoherent): its BRIDGES, and the candidates the last
   * readings named (a primary not in BRIDGES, the half the other chain's primary names), each once */
  const railHalves = (chain: ChainName): Hex[] =>
    // the deploy's adapter always: the reference a bridge's setup is held to (R4-O's fix round, Minor 8)
    [...new Set([...cfg.bridges[chain], chain === "base" ? d.baseAdapter : d.bitAdapter, ...(i.railCandidates?.[chain] ?? [])].map(lc))];
  /** one adapter as a rail half: its immutables, read directly; enabled and known, through `registry` (its chain's lens) */
  const readHalf = (plan: Plan, into: Record<Hex, RailHalf>, a: Hex, registry: (functionName: string, ok: (v: boolean) => void, args: unknown[]) => void, chain: ChainName) => {
    const h: RailHalf = {};
    into[a] = h;
    plan.add({ address: a, abi: ADAPTER_PEER_VIEWS, functionName: "remoteAdapter" }, (v) => (h.remote = lc(v)));
    plan.add({ address: a, abi: ADAPTER_PEER_VIEWS, functionName: "remoteChainId" }, (v: bigint) => (h.remoteChainId = v));
    plan.add({ address: a, abi: ADAPTER_PEER_VIEWS, functionName: "router" }, (v) => (h.router = lc(v)));
    plan.add({ address: a, abi: ADAPTER_PEER_VIEWS, functionName: "token" }, (v) => (h.token = lc(v)));
    plan.add({ address: a, abi: ADAPTER_PEER_VIEWS, functionName: "remoteSelector" }, (v: bigint) => (h.remoteSelector = v));
    if (chain === "bittensor") {
      plan.add({ address: a, abi: BIT_RAIL_VIEWS, functionName: "alphaVault" }, (v) => (h.alphaVault = lc(v)));
      plan.add({ address: a, abi: BIT_RAIL_VIEWS, functionName: "canSendPayouts" }, (v: boolean) => (h.canSendPayouts = v));
    }
    registry("bridgeEnabled", (v) => (h.enabled = v), [a]);
    registry("bridgeKnown", (v) => (h.known = v), [a]);
  };
  const safeNonces: Snapshot["safeNonces"] = { base: {}, bittensor: {} };
  const messageStates: Record<Hex, string> = {};

  // Bittensor
  const bit: BitState = { stakes: {}, alpha: {}, payoutBatches: {} };
  const bitMessages: Record<Hex, string> = {};
  const vp = new Plan();
  // the vault's getters: on v3.2 every one but the token, ownership and pause surface moved to the vault lens (§8.1),
  // read here in the same multicall
  const vaultView = v32 ? { address: d.vaultLens as Hex, abi: VAULT_LENS_VIEWS as Abi } : { address: d.vault, abi: VAULT_VIEWS as Abi };
  // v3.2: the lens counts only while its target() is the deployment's vault (another vault's lens would serve its
  // numbers as ours); otherwise everything read through it is unread, and the mismatch is named
  const lensGate = v32 ? "vaultLens" : undefined;
  if (v32) {
    vp.gate("vaultLens", { address: d.vaultLens as Hex, abi: VAULT_LENS_VIEWS, functionName: "target" }, d.vault, (target) => {
      if (target === undefined) bit.lensUnchecked = true;
      else bit.lensMismatch = { lens: d.vaultLens as Hex, target, expected: d.vault };
    });
  }
  const vault = (functionName: string, ok: (v: any) => void, args?: unknown[], failed?: () => void) => vp.add({ ...vaultView, functionName, args }, ok, failed, lensGate);
  /** v3.2: the reads that call the staking precompile with no gas cap of their own (the lens views that walk the
   * hotkey set, and the precompile's own views) go last, so one that fails by halting, burning the gas Multicall3
   * forwarded it, can't starve the reads after it; Task 61's fork rehearsal checks a failing read's gas. On v3.1
   * each is read where it always was. */
  const late: (() => void)[] = [];
  const walk = (add: () => void) => (v32 ? late.push(add) : add());
  /** what the vault itself answers in both versions (its token, ownership and pause surface) */
  const vself = (functionName: string, ok: (v: any) => void) => vp.add({ address: d.vault, abi: v32 ? VAULT_V32_VIEWS : VAULT_VIEWS, functionName }, ok);
  const vadmin = (functionName: string, ok: (v: any) => void) => vp.add({ address: d.vault, abi: ADMIN_VIEWS, functionName }, ok);
  walk(() => vault("price", (v) => (bit.price = v)));
  walk(() => vault("totalAssets", (v) => (bit.totalAssets = v)));
  vself("totalSupply", (v) => (bit.totalSupply = v));
  // v3.1's rootStakeRao is v3.2's visibleStakeRao (renamed; the same sum, in rao)
  walk(() => vault(v32 ? "visibleStakeRao" : "rootStakeRao", (v) => (bit.rootStakeRao = v)));
  vault("pendingPayouts", (v) => (bit.pendingPayouts = v));
  vault("keeper", (v) => (bit.keeper = lc(v)));
  if (v32) vault("treasury", (v) => (bit.treasury = lc(v)));
  else vp.add({ address: d.vault, abi: TREASURY, functionName: "treasury" }, (v) => (bit.treasury = lc(v)));
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
  // v3.2: the guardian is the lens's, and there is no pending guardian (setGuardian is a scheduled item)
  if (v32) vault("guardian", (v) => (bit.guardian = lc(v)));
  else {
    vadmin("guardian", (v) => (bit.guardian = lc(v)));
    vadmin("pendingGuardian", (v) => (bit.pendingGuardian = lc(v)));
  }
  vadmin("paused", (v) => (bit.paused = v));
  // the hotkey set now: at most 4 (MAX_HOTKEYS); an index past its end reverts
  const slots: (Hex | undefined)[] = [];
  for (let n = 0; n < 4; n++) vault("hotkeys", (v) => (slots[n] = lc(v)), [BigInt(n)]);
  // the coldkey's stake on each hotkey that may hold it: the set known before this reading, the stake hotkey
  // (the configured one too: listed or not), and every hotkey the chain listed for the coldkey last time, so
  // stake a validator's swap moved to a hotkey the vault doesn't list is read (stake.divergence)
  const stakeReads = [...new Set([...(i.hotkeys ?? []), stakeHotkey, d.stakeHotkey, ...(i.stakedHotkeys ?? [])].map(lc))].slice(0, MAX_STAKE_READS);
  for (const hk of stakeReads) {
    walk(() => vp.add({ address: STAKING_PRECOMPILE, abi: STAKING, functionName: "getStake", args: [hk, d.vaultColdkey, 0n] }, (v) => (bit.stakes[hk] = v)));
  }
  walk(() => vp.add({ address: STAKING_PRECOMPILE, abi: STAKING, functionName: "getUnclaimedRootTaoByHotkey", args: [d.vaultColdkey, stakeHotkey] }, (v) => (bit.unclaimed = v)));
  vp.add({ address: STORAGE_QUERY, callData: ownerStorageKey(stakeHotkey) }, (v) => (bit.hotkeyOwner = decodeAccountId(v)));
  vp.add({ address: STORAGE_QUERY, callData: stakingHotkeysKey(d.vaultColdkey) }, (v) => {
    const ids = decodeAccountIds(v);
    if (ids) bit.stakedHotkeys = ids;
  });
  vp.add({ ethBalance: d.vault }, (v) => (bit.balance = v));
  vp.add({ ethBalance: d.bitAdapter }, (v) => (bit.adapterBalance = v));
  if (i.keepers?.bittensor) vp.add({ ethBalance: i.keepers.bittensor }, (v) => (bit.keeperBalance = v));
  vp.add({ address: t.bittensor.fmTao, abi: ERC20, functionName: "balanceOf", args: [t.bittensor.lockPool] }, (v) => (bit.lockPoolFmTao = v));
  // ForeverMoney's state, read at the AlphaVaults of the rail now primary on each chain (v3.2, R4-O round 4: the deploy's
  // until a switch, the replacement pair's after one), TOKENS' until the readings name them; v3-launch at TOKENS'
  const alphaVaults = v32 && i.alphaVaults?.primary.length ? [...new Set(i.alphaVaults.primary.map(lc))] : [lc(t.bittensor.alphaVault)];
  const alphaOf: Record<Hex, BitState["alpha"]> = {};
  for (const av of alphaVaults) {
    const s: BitState["alpha"] = (alphaOf[av] = {});
    const alpha = (functionName: string, ok: (v: any) => void, args?: unknown[]) => vp.add({ address: av, abi: ALPHA_VAULT, functionName, args }, ok);
    alpha("isPaused", (v) => (s.isPaused = v));
    alpha("migrationReadyAt", (v) => (s.migrationReadyAt = v));
    alpha("migrationFinished", (v) => (s.migrationFinished = v));
    alpha("pausedUntil", (v) => (s.pausedUntil = v));
    alpha("pauseableAfter", (v) => (s.pauseableAfter = v));
    alpha("migrationTarget", (v) => (s.migrationTarget = lc(v)));
    alpha("migrationExecuted", (v) => (s.migrationExecuted = v));
    alpha("pendingDefaultAdmin", (v) => (s.pendingAdmin = { admin: lc(v[0]), schedule: Number(v[1]) }));
    // the rail's true backing: the AlphaVault's TAO against wTAO, and wTAO against the lock pool's share of it
    alpha("backing", (v) => (s.backing = v), [t.bittensor.fmTao]);
  }
  // the deploy adapter's own AlphaVault, for the accepted-target rule (TOKENS' until the readings name it)
  if (v32) {
    const dv = lc(i.alphaVaults?.deploy ?? t.bittensor.alphaVault);
    const dep: NonNullable<BitState["deployAlpha"]> = (bit.deployAlpha = { vault: dv });
    vp.add({ address: dv, abi: ALPHA_VAULT, functionName: "migrationTarget" }, (v) => (dep.migrationTarget = lc(v)));
    vp.add({ address: dv, abi: ALPHA_VAULT, functionName: "migrationFinished" }, (v) => (dep.migrationFinished = v));
    vp.add({ address: dv, abi: ALPHA_VAULT, functionName: "migrationExecuted" }, (v) => (dep.migrationExecuted = v));
  }
  vp.add({ address: t.bittensor.fmTao, abi: ERC20, functionName: "totalSupply" }, (v) => (bit.wTaoSupply = v));
  // the lane's buckets on the lock pool (toward Base)
  const bitLane: Lane = {};
  vp.add({ address: t.bittensor.lockPool, abi: TOKEN_POOL, functionName: "getCurrentInboundRateLimiterState", args: [CCIP_SELECTOR.base] }, (v) => (bitLane.inbound = bucketOf(v)));
  vp.add({ address: t.bittensor.lockPool, abi: TOKEN_POOL, functionName: "getCurrentOutboundRateLimiterState", args: [CCIP_SELECTOR.base] }, (v) => (bitLane.outbound = bucketOf(v)));
  vp.add({ address: t.bittensor.lockPool, abi: TOKEN_POOL, functionName: "isSupportedChain", args: [CCIP_SELECTOR.base] }, (v) => (bitLane.supported = v));
  // what no event shows (R3 FM-L2): the lock pool's rebalancer (setRebalancer logs nothing), and the pool and administrator
  // Bittensor's TokenAdminRegistry names for wTAO
  vp.add({ address: t.bittensor.lockPool, abi: LOCK_POOL, functionName: "getRebalancer" }, (v) => (bit.lockPoolRebalancer = lc(v)));
  vp.add({ address: t.bittensor.tokenAdminRegistry, abi: TOKEN_ADMIN_REGISTRY, functionName: "getTokenConfig", args: [t.bittensor.fmTao] }, (v) => (bit.registry = registryOf(v)));
  // the stake hotkey as a validator, and the chain's root-stake hold (SubtensorModule storage)
  const storage = (key: Hex, ok: (v: Hex) => void) => vp.add({ address: STORAGE_QUERY, callData: key }, ok);
  /** a hotkey as a validator: its take, root stake and root uid */
  const validatorOf = (hotkey: Hex): Validator => {
    const out: Validator = { hotkey: lc(hotkey) };
    storage(delegatesKey(hotkey), (v) => {
      const take = decodeU16(v);
      if (take !== undefined) out.take = take;
    });
    storage(totalHotkeyAlphaKey(hotkey, 0), (v) => {
      const stake = decodeU64(v);
      // ValueQuery: no entry is 0
      if (stake !== undefined) out.rootStake = stake ?? 0n;
    });
    storage(uidsKey(0, hotkey), (v) => {
      const uid = decodeU16(v);
      if (uid !== undefined) out.rootUid = uid;
    });
    return out;
  };
  const validator = validatorOf(stakeHotkey);
  storage(ROOT_STAKE_UNLOCK_INTERVAL_KEY, (v) => {
    const blocks = decodeU64(v);
    if (blocks !== undefined) bit.rootUnlockInterval = blocks ?? 0n;
  });
  // the standby validator, beside the primary: only when STANDBY_HOTKEY is set (unset reads no standby)
  const standby = cfg.standbyHotkey ? validatorOf(cfg.standbyHotkey) : undefined;
  // what a claim and a payout chunk cost: the keeper's claim gas at the base fee, and the primary bridge's quote
  vault("claimGasRequired", (v) => (bit.claimGasRequired = v));
  vp.add({ address: t.multicall3, abi: MULTICALL3, functionName: "getBasefee" }, (v) => (bit.baseFee = v));
  vault("primaryBridge", (v) => (bit.primaryBridge = lc(v)));
  vault("maxFeeAbs", (v) => (bit.maxFeeAbs = v));
  vault("maxFeeBps", (v) => (bit.maxFeeBps = v));
  vault("maxMessageValue", (v) => (bit.maxMessageValue = v));
  const bridge = i.bitBridge ?? d.bitAdapter;
  vp.add({ address: bridge, abi: BRIDGE_VIEWS, functionName: "maxMessageValue" }, (v) => (bit.bridgeMaxMessageValue = v));
  const amount = i.payoutQuoteAmount && i.payoutQuoteAmount > 0n ? i.payoutQuoteAmount : QUOTE_DEFAULT_AMOUNT;
  vp.add({ address: bridge, abi: BRIDGE_VIEWS, functionName: "quoteFee", args: [BigInt(d.base.chainId), d.frontDoor, quoteFor(amount), amount] }, (v: bigint) => {
    bit.payoutFeeQuote = ((v + RAO_WEI - 1n) / RAO_WEI) * RAO_WEI;
  });
  for (const p of i.pendingPayoutKeys) {
    vault(
      "getPayoutBatch",
      (v) => (bit.payoutBatches[p.key] = { queuedAt: Number(v.queuedAt), cursor: Number(v.cursor), count: Number(v.count), chunk: Number(v.chunk), remaining: v.remaining }),
      [p.key],
      () => (bit.payoutBatchFailed = true),
    );
  }
  for (const m of i.pendingMessages.filter((m) => m.direction === "base>bittensor")) {
    vp.add({ address: t.bittensor.offRamp, abi: OFFRAMP, functionName: "getExecutionState", args: [m.messageId] }, (v) => (bitMessages[m.messageId] = state(v)));
  }
  const bitSafes: Record<Hex, bigint> = {};
  for (const a of safes("bittensor")) vp.add({ address: a, abi: SAFE, functionName: "nonce" }, (v) => (bitSafes[a] = v));
  // v3.2: the ledger, the two vesting drips, the global window, the doors, the exits machine, the scheduler, every
  // listed hotkey's credits, the bridges' parks and the owner's signing set (spec §7's monitor lines)
  const bitExits: Exits = {};
  const bitOwner = ownerOn("bittensor");
  const bitOwnerSafe: OwnerSafe | undefined = bitOwner ? { address: bitOwner } : undefined;
  if (v32) {
    vault("bookedStake", (v) => (bit.bookedStake = v));
    vault("rampingStake", (v) => (bit.rampingStake = v));
    vault("lastStakeAt", (v) => (bit.lastStakeAt = Number(v)));
    // these walk the hotkey set through getStake: last (see `late`)
    walk(() => vault("missingStakeRao", (v) => (bit.missingStakeRao = v)));
    walk(() => vault("surplusStakeRao", (v) => (bit.surplusStakeRao = v)));
    walk(() => vault("stakeMissing", (v) => (bit.stakeMissing = v)));
    walk(() => vault("grossAssets", (v) => (bit.grossAssets = v)));
    vault("unvestedRewards", (v) => (bit.unvestedRewards = v));
    vault("vestingAmount", (v) => (bit.vestingAmount = v));
    vault("vestingStart", (v) => (bit.vestingStart = Number(v)));
    vault("vestingPeriod", (v) => (bit.vestingPeriod = Number(v)));
    vault("adoptVestingAmount", (v) => (bit.adoptVestingAmount = v));
    vault("adoptVestingStart", (v) => (bit.adoptVestingStart = Number(v)));
    vault("adoptVestingPeriod", (v) => (bit.adoptVestingPeriod = Number(v)));
    vault("rewardVesting", (v) => (bit.rewardVesting = Number(v)));
    vault("lastAdoptAt", (v) => (bit.lastAdoptAt = Number(v)));
    vault("idleBufferBps", (v) => (bit.idleBufferBps = Number(v)));
    vault("globalOutflowBps", (v) => (bit.globalOutflowBps = v));
    vault("burnWindows", (v) => (bit.globalWindow = { start: Number(v[0]), burned: v[1] }), [GLOBAL_WINDOW]);
    vself("launchChain", (v) => (bit.launchChain = v));
    // the launch chain is Base's (the vault's peers are keyed by EVM chain id); launchChain is read beside it
    vault("activeDoors", (v) => (bit.activeDoors = v), [BigInt(d.base.chainId)]);
    vault("doorState", (v) => (bit.doorState = Number(v)), [peerIdOf(BigInt(d.base.chainId), d.frontDoor)]);
    vault("exitsOpen", (v) => (bitExits.open = v));
    vault("ownerHold", (v) => (bitExits.ownerHold = v));
    vault("guardianHold", (v) => (bitExits.guardianHold = v));
    vault("pausedBy", (v) => (bitExits.pausedBy = Number(v)));
    vault("primaryDisabledBy", (v) => (bitExits.primaryDisabledBy = Number(v)));
    vault("launchDoorRemovedBy", (v) => (bitExits.launchDoorRemovedBy = Number(v)));
    vault("lastOwnerClose", (v) => (bitExits.lastOwnerClose = Number(v)));
    vault("lastGuardianClose", (v) => (bitExits.lastGuardianClose = Number(v)));
    vault("pendingSince", (v) => (bitExits.pendingSince = Number(v)));
    vault("MS_PER_BLOCK", (v) => (bit.msPerBlock = Number(v)));
    const items: Record<Hex, ScheduledItem> = {};
    bit.scheduled = items;
    for (const s of (i.scheduledIds ?? []).filter((s) => s.chain === "bittensor")) vault("scheduled", (v) => (items[lc(s.id)] = itemOf(v)), [s.id]);
    // the limits a scheduled setter is judged against (admin.scheduled, admin.item_loosens), and the dust allowance
    // of a keeper's or guardian's removal (stake.set_full)
    vault("maxEntryValue", (v) => (bit.maxEntryValue = v));
    vault("minChunk", (v) => (bit.minChunk = Number(v)));
    vault("maxTotalAssets", (v) => (bit.maxTotalAssets = v));
    vault("hotkeyDustRao", (v) => (bit.hotkeyDustRao = v));
    // each hotkey in the set (as last read) and the stake hotkey: its credits
    const credits: Record<Hex, bigint> = {};
    bit.unclaimedBy = credits;
    for (const hk of [...new Set([...(i.hotkeys ?? []), stakeHotkey].map(lc))]) {
      walk(() => vp.add({ address: STAKING_PRECOMPILE, abi: STAKING, functionName: "getUnclaimedRootTaoByHotkey", args: [d.vaultColdkey, hk] }, (v) => (credits[hk] = v)));
    }
    const adapters: Record<Hex, BitAdapterState> = {};
    bit.adapters = adapters;
    for (const a of cfg.bridges.bittensor.map(lc)) {
      const s: BitAdapterState = {};
      adapters[a] = s;
      vp.add({ ethBalance: a }, (v) => (s.balance = v));
      vp.add({ address: t.bittensor.fmTao, abi: ERC20, functionName: "balanceOf", args: [a] }, (v) => (s.tokens = v));
      const park = (functionName: string, ok: (v: bigint) => void) => vp.add({ address: a, abi: BIT_ADAPTER_V32_VIEWS, functionName }, ok);
      park("parkedNative", (v) => (s.parkedNative = v));
      park("parkedTokens", (v) => (s.parkedTokens = v));
      park("RESERVE_TARGET", (v) => (s.reserveTarget = v));
      park("TOKEN_RESERVE_TARGET", (v) => (s.tokenReserveTarget = v));
      park("tokenCushion", (v) => (s.tokenCushion = v));
    }
    // each adapter as a rail half (rails.incoherent): its peer on Base, and the vault's enabled and known of it
    const bitRails: Record<Hex, RailHalf> = {};
    bit.rails = bitRails;
    for (const a of railHalves("bittensor")) readHalf(vp, bitRails, a, vault, "bittensor");
    if (bitOwnerSafe) safeOwnersOf(vp, bitOwnerSafe);
  }
  // v3.2: the precompile walks, last; unlistedStakeRao the very last (it also asks getTotalColdkeyStakeOnSubnet, which
  // the vault caps at 45,000,000 gas and the lens doesn't, and it reverts when a precompile read fails: left unread).
  // R11 (ChatGPT r3, claim 1): its revert behind an open gate is recorded, for stake.writeoff_bound_off (the gates are
  // judged before any read's answer, so a shut one is known here)
  for (const add of late) add();
  if (v32) {
    vault(
      "unlistedStakeRao",
      (v) => (bit.unlistedStakeRao = v),
      undefined,
      () => {
        if (!bit.lensUnchecked && !bit.lensMismatch) bit.unlistedStakeFailed = true;
      },
    );
  }

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
  if (v32) fd("canClose", (v) => (base.canClose = v));
  // R12a: a full redeem list's fees against a full batch's close quote (batch.redeem_fee_thin), and that quote for the
  // keeper's float (keeper.low_eth)
  fd("redeemRequestFee", (v) => (base.redeemRequestFee = v));
  const closeAmount = i.fullBatchAmount && i.fullBatchAmount > 0n ? i.fullBatchAmount : QUOTE_DEFAULT_AMOUNT;
  bp.add(
    { address: i.baseBridge ?? d.baseAdapter, abi: BRIDGE_VIEWS, functionName: "quoteFee", args: [BigInt(d.bittensor.chainId), d.vault, fullBatchFor(closeAmount), closeAmount] },
    (v: bigint) => (base.fullBatchQuote = v),
  );
  fd("keeper", (v) => (base.keeper = lc(v)));
  fd("oracle", (v) => (base.oracle = lc(v)));
  fadmin("owner", (v) => (base.owner = lc(v)));
  fadmin("pendingOwner", (v) => (base.pendingOwner = lc(v)));
  // v3.2: CascadeBase's getters are the door lens's, and there is no pending guardian
  // its reads count only while its target() is the deployment's front door, as the vault lens's
  if (v32) {
    bp.gate("doorLens", { address: d.doorLens as Hex, abi: DOOR_LENS_VIEWS, functionName: "target" }, d.frontDoor, (target) => {
      if (target === undefined) base.lensUnchecked = true;
      else base.lensMismatch = { lens: d.doorLens as Hex, target, expected: d.frontDoor };
    });
  }
  const lens = (functionName: string, ok: (v: any) => void, args?: unknown[]) => bp.add({ address: d.doorLens as Hex, abi: DOOR_LENS_VIEWS, functionName, args }, ok, undefined, "doorLens");
  if (v32) lens("guardian", (v) => (base.guardian = lc(v)));
  else {
    fadmin("guardian", (v) => (base.guardian = lc(v)));
    fadmin("pendingGuardian", (v) => (base.pendingGuardian = lc(v)));
  }
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
    bp.add({ address: pool, abi: UNISWAP_POOL, functionName: "slot0" }, (v) => {
      into.sqrtPriceX96 = v[0];
      into.cardinality = Number(v[3]);
      into.cardinalityNext = Number(v[4]);
    });
    bp.add({ address: pool, abi: UNISWAP_POOL, functionName: "liquidity" }, (v) => (into.liquidity = v));
    bp.add({ address: pool, abi: UNISWAP_POOL, functionName: "token0" }, (v) => (into.token0 = lc(v)));
  }
  const baseLane: Lane = {};
  bp.add({ address: t.base.tokenPool, abi: TOKEN_POOL, functionName: "getCurrentInboundRateLimiterState", args: [CCIP_SELECTOR.bittensor] }, (v) => (baseLane.inbound = bucketOf(v)));
  bp.add({ address: t.base.tokenPool, abi: TOKEN_POOL, functionName: "getCurrentOutboundRateLimiterState", args: [CCIP_SELECTOR.bittensor] }, (v) => (baseLane.outbound = bucketOf(v)));
  bp.add({ address: t.base.tokenPool, abi: TOKEN_POOL, functionName: "isSupportedChain", args: [CCIP_SELECTOR.bittensor] }, (v) => (baseLane.supported = v));
  // the pool and administrator Base's TokenAdminRegistry names for FM-TAO (R3 FM-L2)
  bp.add({ address: t.base.tokenAdminRegistry, abi: TOKEN_ADMIN_REGISTRY, functionName: "getTokenConfig", args: [t.base.fmTao] }, (v) => (base.registry = registryOf(v)));
  bp.add(
    { address: i.oracle ?? d.oracle, abi: ORACLE, functionName: "usdcValue", args: [10n ** 18n] },
    (v) => (base.oracleValue = v),
    () => (base.oracleReverted = true),
  );
  // the swap quotes the security page shows: a $1,000 deposit, and $1,000 of TAO (at the last oracle value) sold
  bp.add({ address: QUOTER, abi: QUOTER_V2, functionName: "quoteExactInput", args: [PATH_USDC_TO_TAO, 1_000n * USDC_UNIT] }, (v: readonly [bigint]) => (base.buyQuote1000 = v[0]));
  if (i.previousOracleValue !== undefined && i.previousOracleValue > 0n) {
    const taoIn = (1_000n * USDC_UNIT * 10n ** 18n) / i.previousOracleValue;
    if (taoIn > 0n) bp.add({ address: QUOTER, abi: QUOTER_V2, functionName: "quoteExactInput", args: [PATH_TAO_TO_USDC, taoIn] }, (v: readonly [bigint]) => (base.sellQuote = { taoIn, usdcOut: v[0] }));
  }
  bp.add({ address: t.base.usdc, abi: ERC20, functionName: "balanceOf", args: [t.base.wethUsdcPool] }, (v) => (base.wethUsdcPoolUsdc = v));
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
  // v3.2: the door lens's primary bridge and exits machine, the carried pot, the floors and the oracle's pool depth,
  // the scheduler, the bridges' balances and the owner's signing set
  const baseExits: Exits = {};
  const baseOwner = ownerOn("base");
  const baseOwnerSafe: OwnerSafe | undefined = baseOwner ? { address: baseOwner } : undefined;
  if (v32) {
    const fd32 = (functionName: string, ok: (v: any) => void, args?: unknown[]) => bp.add({ address: d.frontDoor, abi: FRONT_DOOR_V32_VIEWS, functionName, args }, ok);
    lens("primaryBridge", (v) => (base.primaryBridge = lc(v)));
    fd32("potCarried", (v) => (base.potCarried = v));
    fd32("minDeposit", (v) => (base.minDeposit = v));
    const floors: NonNullable<BaseState["minPoolLiquidity"]> = {};
    base.minPoolLiquidity = floors;
    fd32("minPoolLiquidity", (v) => (floors.taoWeth = v), [0n]);
    fd32("minPoolLiquidity", (v) => (floors.wethUsdc = v), [1n]);
    fd32("maxDeliverySlippageBps", (v) => (base.maxDeliverySlippageBps = Number(v)));
    const oracle = i.oracle ?? d.oracle;
    bp.add({ address: oracle, abi: ORACLE_V32, functionName: "meanLiquidity" }, (v) => (base.meanLiquidity = { taoWeth: v[0], wethUsdc: v[1] }));
    bp.add({ address: oracle, abi: ORACLE_V32, functionName: "MIN_CARDINALITY" }, (v) => (base.minCardinality = Number(v)));
    lens("exitsOpen", (v) => (baseExits.open = v));
    lens("ownerHold", (v) => (baseExits.ownerHold = v));
    lens("guardianHold", (v) => (baseExits.guardianHold = v));
    lens("primaryDisabledBy", (v) => (baseExits.primaryDisabledBy = Number(v)));
    lens("lastOwnerClose", (v) => (baseExits.lastOwnerClose = Number(v)));
    lens("lastGuardianClose", (v) => (baseExits.lastGuardianClose = Number(v)));
    lens("pendingSince", (v) => (baseExits.pendingSince = Number(v)));
    lens("MS_PER_BLOCK", (v) => (base.msPerBlock = Number(v)));
    const items: Record<Hex, ScheduledItem> = {};
    base.scheduled = items;
    for (const s of (i.scheduledIds ?? []).filter((s) => s.chain === "base")) lens("scheduled", (v) => (items[lc(s.id)] = itemOf(v)), [s.id]);
    const adapters: Record<Hex, BaseAdapterState> = {};
    base.adapters = adapters;
    for (const a of cfg.bridges.base.map(lc)) {
      const s: BaseAdapterState = {};
      adapters[a] = s;
      bp.add({ ethBalance: a }, (v) => (s.balance = v));
      bp.add({ address: t.base.fmTao, abi: ERC20, functionName: "balanceOf", args: [a] }, (v) => (s.tokens = v));
    }
    // each adapter as a rail half (rails.incoherent): its peer on Bittensor, and the front door's enabled and known of it
    const baseRails: Record<Hex, RailHalf> = {};
    base.rails = baseRails;
    for (const a of railHalves("base")) readHalf(bp, baseRails, a, lens, "base");
    if (baseOwnerSafe) safeOwnersOf(bp, baseOwnerSafe);
  }

  const [bitReading, baseReading, baseCounts, bitCounts, writeOffGas] = await Promise.all([
    readChain(rpc, "bittensor", vp, t.multicall3, i.last.bittensor, bit),
    readChain(rpc, "base", bp, t.multicall3, i.last.base, base),
    countsAndCodes(rpc, "base", counted("base"), coded("base")),
    countsAndCodes(rpc, "bittensor", counted("bittensor"), coded("bittensor")),
    v32 ? writeOffReadGasOf(rpc, d.vaultColdkey as Hex) : Promise.resolve(undefined),
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
    // ForeverMoney's state as one, from the vaults read (R4-O round 4)
    bit.alpha = combinedAlpha(alphaVaults.map((v) => alphaOf[v]));
    if (v32) bit.alphaVaults = alphaVaults;
    // the set now: from hotkeys(0) on, up to the first index past its end (unknown if hotkeys(0) failed)
    const set: Hex[] = [];
    for (const hk of slots) {
      if (hk === undefined) break;
      set.push(hk);
    }
    if (slots[0] !== undefined) bit.hotkeys = set;
    if (bitLane.inbound || bitLane.outbound || bitLane.supported !== undefined) bit.lane = bitLane;
    if (Object.keys(validator).length > 1) bit.validator = validator;
    if (standby && Object.keys(standby).length > 1) bit.standby = standby;
    if (v32) bit.exits = bitExits;
    if (writeOffGas !== undefined) bit.writeOffReadGas = writeOffGas;
    if (bitOwnerSafe) bit.ownerSafe = ownSafe(bitOwnerSafe, bitCounts.codes);
    snap.bittensor = bitReading;
    Object.assign(messageStates, bitMessages);
    Object.assign(safeNonces.bittensor, bitSafes);
  }
  if (baseReading) {
    if (baseLane.inbound || baseLane.outbound || baseLane.supported !== undefined) base.lane = baseLane;
    if (v32) base.exits = baseExits;
    if (baseOwnerSafe) base.ownerSafe = ownSafe(baseOwnerSafe, baseCounts.codes);
    snap.base = baseReading;
    Object.assign(messageStates, baseMessages);
    Object.assign(safeNonces.base, baseSafes);
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

/** v3.2: the part of the ramp still entering the outflow allowance's base at the reading's block time, as the vault
 * works it out (CascadeFormulas.unspent(ramping, lastStakeAt, STAKE_RAMP), floored): rampingStake spent linearly over
 * STAKE_RAMP_S from lastStakeAt, none from then on. Wei; undefined while either half is unread. */
export function stillRamping(r: ChainReading<BitState>): bigint | undefined {
  const { rampingStake: amount, lastStakeAt: start } = r.state;
  if (amount === undefined || start === undefined) return undefined;
  const elapsed = r.time - start;
  return elapsed >= STAKE_RAMP_S ? 0n : (amount * BigInt(STAKE_RAMP_S - elapsed)) / BigInt(STAKE_RAMP_S);
}

/** One of a v3.2 vault's two burn windows as a delivery reads it: what it has burned while it runs (24 hours from its
 * start; 0 once it ended), its allowance, and whether the window was read at all (unread burns count 0). */
export interface OutflowWindow {
  burned: bigint;
  allowance: bigint;
  read: boolean;
}

/** v3.2's daily outflow allowance as CascadeBatchLib._burnRedeems works it out from a reading (the T17 M5 carry): the base
 * is the priced stake, min(visible, booked) × 1e9, less what still ramps in (stillRamping), never the liquid balance;
 * this front door's window allows max(base × maxDailyOutflowBps / 10,000, minDailyOutflow), every door's together
 * max(base × globalOutflowBps / 10,000, minDailyOutflow), and a delivery burns at most the smaller of their rests.
 * Undefined while the ledger, the ramp or a limit is unread. The base moves with the stake, so it is a guide: the vault
 * works it out again at each delivery. */
export function outflowOf(r: ChainReading<BitState>): { base: bigint; ramp: bigint; door: OutflowWindow; global: OutflowWindow } | undefined {
  const s = r.state;
  const ramp = stillRamping(r);
  if (s.rootStakeRao === undefined || s.bookedStake === undefined || ramp === undefined || s.maxDailyOutflowBps === undefined || s.globalOutflowBps === undefined || s.minDailyOutflow === undefined) {
    return undefined;
  }
  const floor = s.minDailyOutflow;
  const priced = (s.rootStakeRao < s.bookedStake ? s.rootStakeRao : s.bookedStake) * RAO_WEI;
  const base = priced > ramp ? priced - ramp : 0n;
  const allowance = (bps: bigint) => {
    const byBps = (base * bps) / 10_000n;
    return byBps > floor ? byBps : floor;
  };
  const window = (w: { start: number; burned: bigint } | undefined, bps: bigint): OutflowWindow => ({
    burned: w && r.time < w.start + 86_400 ? w.burned : 0n,
    allowance: allowance(bps),
    read: w !== undefined,
  });
  return { base, ramp, door: window(s.burnWindow, s.maxDailyOutflowBps), global: window(s.globalWindow, s.globalOutflowBps) };
}

/** The payout fee quote's amount, from a reading: the lower of the vault's and its bridge's maxMessageValue (either
 * alone when the other is unread); undefined before any reading has named one. */
export function quoteAmountOf(s?: BitState): bigint | undefined {
  const xs = [s?.maxMessageValue, s?.bridgeMaxMessageValue].filter((x): x is bigint => x !== undefined && x > 0n);
  return xs.length ? xs.reduce((a, b) => (a < b ? a : b)) : undefined;
}

/** v3.2 (R4, S-H1): whether the vault's primary bridge, as this reading names it, can't send payouts: its
 * canSendPayouts() read false, the view the vault itself reads before each delivery's door redeems (while it is false
 * every one is deferred, and no queued payout can be sent). Undefined while the primary, or its view, is unread (a
 * primary new since the last reading, and not in BRIDGES, is read as a rail half from the next tick on). */
export function payoutsClosedOf(s: BitState | undefined): boolean | undefined {
  const can = s?.primaryBridge ? s.rails?.[lc(s.primaryBridge)]?.canSendPayouts : undefined;
  return can === undefined ? undefined : !can;
}

/** v3.2 (R6, ChatGPT R2 claim D): whether the vault reads its payout rail closed, as its _payoutsOpen does since R6: its
 * primary disabled on the vault (a disabled primary can't send, so every door redeem is deferred), else its
 * canSendPayouts() false (payoutsClosedOf). What the monitor's rail rules judge by; the site's notice keeps the adapter's
 * view (a disabled primary is its routeDisabled). */
export function payoutRailClosedOf(s: BitState | undefined): boolean | undefined {
  return primaryDisabledOf(s) ? true : payoutsClosedOf(s);
}

/** Whether the vault's primary, as this reading names it, reads disabled on the vault (R6, claim D). */
export const primaryDisabledOf = (s: BitState | undefined): boolean => !!s?.primaryBridge && s.rails?.[lc(s.primaryBridge)]?.enabled === false;

/** v3.2: the adapters to read as rail halves beside BRIDGES (SnapshotInputs.railCandidates), from the last readings,
 * since one multicall can't use its own answers: on each chain its primary bridge, and the half there that the other
 * chain's primary names (its remoteAdapter). A primary or a peer that changes since is read on the next tick
 * (rails.incoherent can't see it until then). */
export function railCandidatesOf(last: { base?: BaseState; bittensor?: BitState }): { base: Hex[]; bittensor: Hex[] } {
  const peerOf = (s: BaseState | BitState | undefined) => (s?.primaryBridge ? s.rails?.[lc(s.primaryBridge)]?.remote : undefined);
  const list = (...xs: (Hex | undefined)[]) => [...new Set(xs.filter((x): x is Hex => x !== undefined).map(lc))];
  return { base: list(last.base?.primaryBridge, peerOf(last.bittensor)), bittensor: list(last.bittensor?.primaryBridge, peerOf(last.base)) };
}

/** v3.2 (R4-O round 4): the AlphaVaults of the rail now primary on each chain, from the last readings: the front door's
 * primary's Bittensor half's and the vault's primary's (each half's alphaVault()), TOKENS' in place of one not read yet;
 * and the deploy's Bittensor adapter's own (undefined until read). What the snapshot reads ForeverMoney's state at. */
export function alphaVaultsOf(last: { base?: BaseState; bittensor?: BitState }, cfg: Pick<Config, "tokens" | "deployment">): { primary: Hex[]; deploy?: Hex } {
  const vaultOf = (a: Hex | undefined) => (a ? last.bittensor?.rails?.[lc(a)]?.alphaVault : undefined);
  const doorHalf = last.base?.primaryBridge ? last.base.rails?.[lc(last.base.primaryBridge)]?.remote : undefined;
  const fallback = lc(cfg.tokens.bittensor.alphaVault);
  const primary = [...new Set([vaultOf(doorHalf), vaultOf(last.bittensor?.primaryBridge)].map((v) => (v ? lc(v) : fallback)))];
  const deploy = vaultOf(cfg.deployment.bitAdapter);
  return { primary, deploy: deploy ? lc(deploy) : undefined };
}

/** Several AlphaVaults' state as one (half switched, R4-O round 4): paused, executed or finished when any is, the latest
 * notice, pause and pauseable times, the target announced, a pending admin if any, the lowest backing; a field unread
 * at any is unread. One vault's is its own. */
function combinedAlpha(list: BitState["alpha"][]): BitState["alpha"] {
  if (list.length === 1) return list[0];
  const out: BitState["alpha"] = {};
  const all = <K extends keyof BitState["alpha"]>(k: K): NonNullable<BitState["alpha"][K]>[] | undefined =>
    list.every((x) => x[k] !== undefined) ? list.map((x) => x[k] as NonNullable<BitState["alpha"][K]>) : undefined;
  const any = (k: "isPaused" | "migrationFinished" | "migrationExecuted") => {
    const v = all(k);
    if (v) out[k] = v.some(Boolean);
  };
  any("isPaused");
  any("migrationFinished");
  any("migrationExecuted");
  for (const k of ["migrationReadyAt", "pausedUntil", "pauseableAfter"] as const) {
    const v = all(k);
    if (v) out[k] = v.reduce((a, b) => (b > a ? b : a));
  }
  const target = all("migrationTarget");
  if (target) out.migrationTarget = target.find((x) => x !== ZERO_ADDR) ?? target[0];
  const admin = all("pendingAdmin");
  if (admin) out.pendingAdmin = admin.find((x) => x.admin !== ZERO_ADDR) ?? admin[0];
  const backing = all("backing");
  if (backing) out.backing = backing.reduce((a, b) => (b < a ? b : a));
  return out;
}
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Hex;

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
  /** the validator's root stake (everyone's), the hour's highest */
  validatorStakeHigh?: bigint;
  /** the standby validator's root stake (STANDBY_HOTKEY), the hour's highest; absent while there is none */
  standbyStakeHigh?: bigint;
  /** the AlphaVault's backing(wTAO) over wTAO's supply, in parts per million: the hour's lowest and highest (a week of
   * them sets backingToleranceBps before BACKING_HOLD is switched on: README) */
  backingPpmLow?: number;
  backingPpmHigh?: number;
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
  const ppm = bit?.alpha.backing !== undefined && bit.wTaoSupply ? Number((bit.alpha.backing * 1_000_000n) / bit.wTaoSupply) : undefined;
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
    validatorStakeHigh: hi(p.validatorStakeHigh, bit?.validator?.rootStake),
    standbyStakeHigh: hi(p.standbyStakeHigh, bit?.standby?.rootStake),
    backingPpmLow: ppm === undefined ? p.backingPpmLow : Math.min(p.backingPpmLow ?? ppm, ppm),
    backingPpmHigh: ppm === undefined ? p.backingPpmHigh : Math.max(p.backingPpmHigh ?? ppm, ppm),
    spotSum: p.spotSum + (spotUsd ?? 0),
    spotCount: p.spotCount + (spotUsd === undefined ? 0 : 1),
  };
}
