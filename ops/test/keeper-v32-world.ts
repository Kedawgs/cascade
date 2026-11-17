import {
  type Abi,
  type AbiEvent,
  type AbiFunction,
  type Address,
  concat,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
  type Hex,
  keccak256,
  numberToHex,
  padHex,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  size,
  stringToHex,
  toFunctionSelector,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ADAPTER,
  ADAPTER_ERRORS,
  ALPHA,
  BASE_ADAPTER,
  BIT_ADAPTER,
  RAIL_VIEWS,
  DEFERRED_BASKET_CASH_CLAIMED_PREFIX,
  DEFERRED_BASKET_DEBTS_PREFIX,
  DOOR,
  DOOR_LENS,
  ERRORS_V32,
  KEEPER_CALLS_V32,
  OFFRAMP,
  OFFRAMP_CCVS,
  OFFRAMP_EVENTS,
  OFFRAMP_EXECUTE,
  ONRAMP,
  PARK_CALLS,
  PARK_EVENTS,
  PARK_JOBS,
  PARK_READS,
  ORACLE,
  POOL,
  QUOTER,
  STAKER,
  STAKING,
  VAULT_ABI_V32,
  VAULT_KEPT,
  VAULT_LENS,
} from "../src/keeper/core/abi.ts";
import type { DeploymentV32 } from "../src/keeper/core/deployment.ts";
import type { ChainName } from "../src/keeper/core/types.ts";
import { type MonitorClient, MonitorUnreadable } from "../src/keeper/core/hold.ts";
import { type Journal, type JournalRow, memoryJournal } from "../src/keeper/core/journal.ts";
import { freshMemory, type KeeperMemory } from "../src/keeper/core/memory.ts";
import type { Signer } from "../src/keeper/core/send.ts";
import type { MessageV1 } from "../src/keeper/core/v32/ccip.ts";
import type { RailsEnv } from "../src/keeper/core/v32/rails.ts";
import { addressMapping } from "../src/keeper/core/v32/readiness.ts";
import { depsV32, type V32Env } from "../src/keeper/core/v32/reads.ts";
import { type Rpc, RpcError } from "../src/rpc.ts";

// A fake v3.2 deployment on two fake chains for the keeper's v3.2 tests: the reads the v3.2 deps make (by function,
// through the core's own fragments and the published vault ABI), the vault's and the door's logs, and raw
// transactions, which it recovers, records and settles as each test says. The keeper's key is a throwaway made here.

const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);
/** Bittensor's storage-query precompile and RootStakeUnlockInterval's key (indexer/src/subtensor.ts's, Task 53) */
const STORAGE_QUERY_ADDR = "0x0000000000000000000000000000000000000807" as Address;
const ROOT_HOLD_KEY = "0x658faa385070e074c85bf6b568cf05554e541e10cbd64f2b97721f57262b538f" as Hex;
/** System.Number's key (twox128("System") ++ twox128("Number")): a key that always has an entry, the block number */
const SYSTEM_NUMBER_KEY = "0x26aa394eea5630e07c48ae0c9558cef702a5c1b19ab7a04f536c519aca4983ac" as Hex;
export const TAO = 10n ** 18n;
export const RAO = 10n ** 9n;
export const T = 1_800_000_000;
/** When the fake vault was created (its create's block time): 90 days before T */
export const CREATED = T - 90 * 86_400;

export const KEY = privateKeyToAccount(generatePrivateKey());
/** The vault's stake hotkey in the world, and a second listed hotkey (both hold stake; neither has credits unless a test
 * says so) */
export const HK_STAKE: Hex = `0x${"11".repeat(32)}`;
export const HK_SECOND: Hex = `0x${"22".repeat(32)}`;

/** One listed hotkey of the world's vault: the vault's root stake on it (rao), the credits waiting on it
 * (getUnclaimedRootTaoByHotkey, wei) and its last claim (lastClaimAt). */
export interface WorldHotkey {
  hotkey: Hex;
  stakeRao: bigint;
  credits: bigint;
  lastClaimAt: bigint;
}
export const SIGNER: Signer = { address: KEY.address, signTransaction: (tx) => KEY.signTransaction(tx) };

export const ADDR = {
  vault: at("7a01"),
  vaultLens: at("7a02"),
  frontDoor: at("fd01"),
  doorLens: at("fd02"),
  bitAdapter: at("ad01"),
  baseAdapter: at("ad02"),
  staker: at("57a1"),
  oracle: at("0c01"),
  alphaVault: at("a1fa"),
  quoter: at("9e01"),
  token: at("70c1"),
  staking: "0x0000000000000000000000000000000000000805" as Address,
  onRampBase: at("0e01"),
  onRampBittensor: at("0e02"),
  offRampBase: at("0f01"),
  offRampBittensor: at("0f02"),
  /** R4: a second adapter pair (runbook §8's switch): its Bittensor adapter and its Base adapter */
  bitAdapter2: at("ad11"),
  baseAdapter2: at("ad12"),
};

/** R4: the world's second adapter pair, as a deployment lists it (DeploymentV32.pairs) */
export const PAIR2 = { baseAdapter: at("ad12"), bitAdapter: at("ad11"), startBlocks: { base: 100n, bittensor: 100n } };
/** Which pair a world helper works on: the deploy's (1, the default) or the second (2) */
export type PairNo = 1 | 2;
const adaptersOf = (pair: PairNo = 1) => (pair === 2 ? { base: ADDR.baseAdapter2, bit: ADDR.bitAdapter2 } : { base: ADDR.baseAdapter, bit: ADDR.bitAdapter });

/** The lanes' CCIP chain selectors (the live ones, LIVE in ops/src/config.ts). */
export const SELECTOR = { base: 15971525489660198786n, bittensor: 2135107236357186872n };

/** The committee verifier both lanes require (getCCVsForMessage's default answer), and Chainlink's executor, which writes
 * a FAILURE in the world */
export const COMMITTEE = at("cc01");
export const EXECUTOR = at("ec01");
/** The committee's verifier results for message `id`, as the world's committee signs them (its version, then a signature
 * over the id: they fit that message only) */
export const committeeResult = (id: Hex): Hex => concat(["0x49ff34ed", "0x0020", keccak256(concat([stringToHex("committee"), id]))]);

export const deploymentFor = (over: Partial<DeploymentV32> = {}): DeploymentV32 => ({
  version: "v3.2",
  name: "v3.2-launch",
  chainIds: { base: 8453, bittensor: 964 },
  launchChain: 8453n,
  addresses: {
    vault: ADDR.vault,
    vaultLens: ADDR.vaultLens,
    frontDoor: ADDR.frontDoor,
    doorLens: ADDR.doorLens,
    bitAdapter: ADDR.bitAdapter,
    baseAdapter: ADDR.baseAdapter,
    staker: ADDR.staker,
    oracle: ADDR.oracle,
  },
  keeper: KEY.address,
  vaultColdkey: addressMapping(ADDR.vault),
  vaultCreatedAt: CREATED,
  startBlocks: { base: 100n, bittensor: 100n },
  batchMaxWaitS: 86_400,
  usdcDelivery: true,
  payoutTopUpMax: 0n,
  // generous in the world unless a test says otherwise (the founder's ~a third of the keeper's gas is the record's default)
  spendCap: { base: 10n ** 18n, bittensor: 100n * TAO },
  alphaVault: ADDR.alphaVault,
  quoterV2: ADDR.quoter,
  ethUsdcPath: "0x",
  offRamps: { base: at("0f01"), bittensor: at("0f02") },
  onRamps: { base: ADDR.onRampBase, bittensor: ADDR.onRampBittensor },
  selectors: { base: SELECTOR.base, bittensor: SELECTOR.bittensor },
  stakingPrecompile: ADDR.staking,
  forLife: { values: [], code: [], pools: [] },
  ...over,
});

export interface Batch {
  sourceChain: bigint;
  frontDoor: Address;
  batchId: bigint;
  queuedAt: bigint;
  cursor: number;
  count: number;
  chunk: number;
  remaining: bigint;
  payoutsHash: Hex;
}

export interface Log {
  chain: "base" | "bittensor";
  address: Address;
  event: string;
  args: Record<string, unknown>;
  block: bigint;
  tx?: Hex;
}

export interface SentCall {
  chain: "base" | "bittensor";
  to: Address;
  fn: string;
  args: readonly unknown[];
  value: bigint;
  gas: bigint;
  hash: Hex;
}

/** The world's state: what each read answers. Tests change it between rounds. */
export function world() {
  const w = {
    head: { base: 10_000n, bittensor: 10_000n },
    time: { base: T, bittensor: T },
    chainIds: { base: 8453, bittensor: 964 },
    door: {
      id: 7n,
      start: BigInt(T - 4_000),
      totalDeposits: 2n * TAO,
      feePot: 0n,
      deposits: [{ user: at("de01"), amount: 2n * TAO }] as { user: Address; amount: bigint }[],
      redeems: [] as { user: Address; amount: bigint }[],
      canClose: true,
      paused: false,
      batchInterval: 3_600n,
      maxDeposits: 50,
      maxRedeems: 50,
      maxBatchValue: 10n * TAO,
      /** The deposit cap and what the door has forwarded against it (R6b: the room rule counts the cap's room too) */
      depositCap: 40n * TAO,
      netForwarded: 0n,
      keeper: KEY.address as Address,
      closeFee: 10n ** 14n,
      /** What each user may claim (or the keeper deliver), by lowercase address */
      claimable: {} as Record<string, bigint>,
      /** Each user's delivery preference (deliveryOf): minUsdcPerTao, deadline, destination */
      prefs: {} as Record<string, readonly [bigint, bigint, number]>,
      slippageBps: 150,
      /** minPoolLiquidity: TAO/WETH, WETH/USDC */
      minLiquidity: [1_000n, 1_000n] as [bigint, bigint],
    },
    vault: {
      paused: false,
      totalSupply: 100n * TAO,
      pending: 0n,
      // below the staking floor (0.002 TAO): nothing to stake unless a test says so
      balance: 10n ** 15n,
      payoutDelay: 86_400n,
      batches: {} as Record<string, Batch>,
      visibleStakeRao: 50n * TAO / RAO,
      bookedStake: 50n * TAO / RAO,
      minStakeRao: 2_000_000n,
      minRemainRao: 20_000_000n,
      totalAssets: 52n * TAO,
      grossAssets: 52n * TAO,
      unvested: 0n,
      stakeMissing: false,
      hotkeyCount: 2,
      /** The listed hotkeys in the vault's order (hotkeys(i), each one's stake, credits and last claim): hotkeyCount says
       * how many are listed */
      hotkeys: [
        { hotkey: HK_STAKE, stakeRao: (45n * TAO) / RAO, credits: 0n, lastClaimAt: BigInt(T - 86_400) },
        { hotkey: HK_SECOND, stakeRao: (5n * TAO) / RAO, credits: 0n, lastClaimAt: BigInt(T - 86_400) },
      ] as WorldHotkey[],
      stakeHotkey: HK_STAKE as Hex,
      /** Where a mined claim pays a hotkey's credits: as stake on the claimed hotkey (MockStaking's default, as the runtime
       * pays root claims and retained swap credits as understood today), or as the vault's balance (claimToBalance) */
      claimPaysTo: "stake" as "balance" | "stake",
      /** R6b (U1, U2): the claim schedule (the lens's vestingStart, vestingPeriod, vestingAmount; all 0 before the first
       * claim that books rewards). A mined claim that pays credits restarts it from then, over rewardVesting (30 days). */
      vesting: { start: 0n, period: 0n, amount: 0n },
      /** A mined claim the chain skips (its payout under RootClaimableThreshold): it stamps the claim and pays nothing, and
       * the hotkey's credits still read as before */
      claimBooksNothing: false,
      /** The surplus (visible above booked, rao) and the last adoption (or the vault's creation) */
      surplusStakeRao: 0n,
      lastAdoptAt: BigInt(CREATED),
      idleBufferBps: 0,
      minDailyOutflow: 10n * TAO,
      /** The lens's missingStakeRao (undefined: the booked stake less the visible, floored at 0, as the lens computes it) and
       * unlistedStakeRao (the vault's root stake off its list; "reverts": the precompile can't total it) (Task 53) */
      missingStakeRao: undefined as bigint | undefined,
      unlistedStakeRao: 0n as bigint | "reverts",
      /** The vault's root stake on hotkeys it doesn't list, by lowercase hotkey (rao): what an addHotkey of one lists */
      offList: {} as Record<string, bigint>,
      keeper: KEY.address as Address,
      /** The vault's last stake (its creation time until its first): a day before T */
      lastStakeAt: BigInt(T - 86_400),
      /** The staking precompile's getRejectStakingHotkeyGrowth for the vault's coldkey (the constructor sets it) */
      rejectGrowth: true,
      /** The launch door's state on the vault (doorState(peerId(8453, frontDoor))): 0 Unknown, 1 Active, 2 Removed */
      doorState: 1,
      maxFeeBps: 100n,
      maxFeeAbs: 15n * 10n ** 15n,
      minChunk: 10,
      maxMessageValue: 15n * TAO,
      unstakeGas: 400_000n,
      payoutFee: 5n * 10n ** 15n,
    },
    /** Bittensor's RootStakeUnlockInterval through the storage-query precompile (Task 53): blocks (0: no entry, no hold);
     * "unreadable" (the precompile reverts); or "absent" (no code at its address: every eth_call answers "0x", the block
     * number's key too: Task 53's fix round, the review's Important 6) */
    rootHold: 0n as bigint | "unreadable" | "absent",
    /** R6b (U9): what Bittensor still owes the vault's coldkey on a hotkey beyond the unclaimed view, by lowercase hotkey: its
     * DeferredBasketDebts debt (rao of alpha; below 0 is owed) and its DeferredBasketCashClaimed watermark (rao; below 0 is
     * owed), as the storage-query precompile answers them (no entry: nothing) */
    deferred: {} as Record<string, { alphaDebtRao?: bigint; cashClaimedRao?: bigint }>,
    /** ForeverMoney's AlphaVault: its pause, its migration notice and its end, and its MIGRATION_DELAY() (undefined: the
     * getter reverts, as on an AlphaVault without it) */
    alpha: { paused: false, migrationReadyAt: 0n, migrationFinished: false, migrationDelay: 7n * 86_400n as bigint | undefined },
    /** R4-O round 3: ForeverMoney's other AlphaVaults (a migration's new one), by lowercase address, as `alpha` */
    vaults: {} as Record<string, { paused: boolean; migrationReadyAt: bigint; migrationFinished: boolean; migrationDelay?: bigint }>,
    /** R4-O round 3: each Bittensor adapter's alphaVault() (absent: the deploy's AlphaVault), by lowercase address */
    adapterVault: {} as Record<string, Address>,
    /** R4-O round 3: each side's primary bridge, as the lenses answer primaryBridge() */
    primary: { base: ADDR.baseAdapter as Address, bittensor: ADDR.bitAdapter as Address },
    /** A block's time where it isn't told by the chain's clock and block time (eth_getBlockByNumber of a number), by "chain:block" */
    blockTimes: {} as Record<string, number>,
    /** Each chain's seconds a block: an earlier block's time is the head's less this a block (Base's 2 s as these tests were
     * written; a test sets Base's 200 ms of today where it matters) */
    blockS: { base: 2, bittensor: 12 } as Record<ChainName, number>,
    /** Base's pools along the delivery route (marketOf); absent, the quoter answers 3,000 USDC whatever it is asked and
     * the oracle prices a TAO at $400, as before */
    market: undefined as Market | undefined,
    /** The monitor (monitorOf): its holds, the payout keys it confirms (absent: every queued batch's), whether it can be
     * read, a status of a test's own, and the outside price it serves */
    monitor: {
      hold: [] as string[],
      okKeys: undefined as string[] | undefined,
      down: false,
      status: undefined as (() => unknown) | undefined,
      price: { v: 1, usd: 400, sources: 2, at: T - 60 } as unknown,
      priceDown: false,
      statusReads: 0,
      priceReads: 0,
    },
    /** The keeper's deliveries switch (the host's), ops/hold.json's text, and a hand run's --ignore-monitor-outage */
    deliveriesOn: true,
    /** The Bittensor adapter's parks (parked(key)): amount, parkedAt, converted, by lowercase key */
    parks: {} as Record<string, readonly [bigint, bigint, boolean]>,
    /** R4: the second pair's Bittensor adapter's parks and their messages, as `parks` and `parkMessages` */
    parks2: {} as Record<string, readonly [bigint, bigint, boolean]>,
    parkMessages2: {} as Record<string, { recipient: Address; sender: Address; message: Hex }>,
    /** R4: each Base adapter's gas model toward Bittensor (gasBase, gasPerEntry: the gas CCIP gives the Bittensor adapter's
     * ccipReceive), by lowercase address */
    inbound: { [at("ad02").toLowerCase()]: [1_300_000n, 57_000n], [at("ad12").toLowerCase()]: [1_400_000n, 55_000n] } as Record<string, readonly [bigint, bigint]>,
    /** merge 7b (R4): each Bittensor adapter's inbound pair (inboundGasBase, inboundGasPerEntry: the copy of its Base
     * adapter's, the park reserve included), by lowercase address: what its parkedDeliveryGas(message) answers from, as
     * CcipAdapterBase._gasModel does (capped at GAS_CAP; a message that doesn't parse, the cap) */
    parkModel: { [at("ad01").toLowerCase()]: [1_300_000n, 57_000n], [at("ad11").toLowerCase()]: [1_400_000n, 55_000n] } as Record<string, readonly [bigint, bigint]>,
    /** R4: the vault's bridgeEnabled, by lowercase adapter (absent: true) */
    bridgeEnabled: {} as Record<string, boolean>,
    /** R7 (L4): each Bittensor adapter's canSendPayouts(), by lowercase adapter (absent: true; "reverts": the view reverts;
     * R8 (L-D): "empty", an answer of no bytes; a bigint, one word of that value, raw) */
    canSendPayouts: {} as Record<string, boolean | "reverts" | "empty" | bigint>,
    /** Each park's message as the adapter keys it (by lowercase key): what deliverParked, refundParked and dropParked
     * find the park by, so a call with other bytes meets NotParked */
    parkMessages: {} as Record<string, { recipient: Address; sender: Address; message: Hex }>,
    /** What deliverParked's simulation (eth_call or estimate) answers for a park, beyond the adapter's own checks: an
     * error's name to revert with (a conversion that fails, say), or nothing */
    parkSim: (_key: string): string | undefined => undefined,
    /** Whether the recipient takes a park deliverParked delivers (else it stays parked, converted: ParkedConverted) */
    vaultTakesParks: true,
    /** R4 (A-M1): the least gas limit a mined deliverParked delivers with; below it the vault's call is starved and the park
     * kept as converted (ParkedConverted). By default 0: every limit delivers. */
    deliverStarvedBelow: (_c: SentCall): bigint => 0n,
    /** quoteRefund's answer */
    refundFee: 4n * 10n ** 15n,
    /** Each bridge message's state on its destination's OffRamp (by lowercase id): 0 UNTOUCHED, 2 SUCCESS, 3 FAILURE */
    messageStates: {} as Record<string, number>,
    /** What OffRamp.execute answers (gas, or an error's name), given its arguments: its estimate, its eth_call, and whether a
     * mined one delivers. By default the OffRamp 2.0.0's checks (offRampExecute): the CCV quorum and the committee's
     * results for that very message, so an empty or a wrong proof is refused as the real one refuses it (review I4) */
    executeSim: (args: readonly unknown[]): bigint | { error: string; args?: unknown[] } => offRampExecute(w, args),
    /** Whether a message's receiver fails when it is executed (its revert data), by id; else it takes it */
    receiverFails: (_id: Hex): Hex | undefined => undefined,
    /** The OffRamps' getCCVsForMessage: the committees a message's execution must carry results from */
    ccvs: { required: [COMMITTEE] as Address[], optional: [] as Address[], threshold: 0 },
    /** Transactions the chains know by hash beyond the keeper's own (eth_getTransactionByHash): an execution attempt's */
    txs: {} as Record<string, { from: Address; to: Address; input: Hex; blockNumber: Hex }>,
    /** A node that ignores eth_getLogs's topic filters past the event's own (it answers every log of the event) */
    logsIgnoreTopics: false,
    holdFile: undefined as string | undefined,
    override: undefined as { until: number } | undefined,
    /** Extra answers for a function on an address (`${address}:${fn}`), which win over the defaults, and the functions
     * the default fragments don't hold */
    answers: {} as Record<string, (args: readonly unknown[]) => unknown>,
    fns: [] as AbiFunction[],
    logs: [] as Log[],
    sends: [] as SentCall[],
    /** The keeper's account's nonces */
    nonce: { base: { latest: 3, pending: 3 }, bittensor: { latest: 5, pending: 5 } },
    /** What the simulation of a call answers: gas, or an error's name (and args) to revert with */
    simulate: (_c: { chain: string; to: Address; fn: string; args: readonly unknown[]; value: bigint }): bigint | { error: string; args?: unknown[] } => 200_000n,
    /** What becomes of a broadcast transaction */
    fate: (_c: SentCall): "mine" | "revert" | "hold" => "mine",
    /** The logs a mined call leaves (its receipt's) */
    receiptLogs: (_c: SentCall): { address: Address; topics: Hex[]; data: Hex }[] => [],
    receipts: {} as Record<string, { status: Hex; logs: { address: Address; topics: Hex[]; data: Hex }[] }>,
    codes: {} as Record<string, Hex>,
    balances: {} as Record<string, bigint>,
    calls: [] as { chain: string; to: Address; fn: string }[],
    /** R4 (B-L2): an eth_call's answer by the block tag it is read at, which wins over the default ({ result }), or an error
     * the node answers with; undefined: the default */
    callAt: undefined as ((c: { chain: string; to: Address; fn: string; args: readonly unknown[]; tag: string; from?: Address; gas?: Hex }) => { result: unknown } | Error | undefined) | undefined,
    /** Every eth_getLogs asked: its chain, address, event topic, its other topics and block range */
    logQueries: [] as { chain: string; address: Address; topic0: Hex; topics: (Hex | null)[]; from: bigint; to: bigint }[],
    /** The n-th eth_getLogs (from 1) fails: an error thrown before it is asked (a read deadline, a node down), or a log in
     * its answer that can't be decoded ("malformed"); the query itself is given too */
    logsFail: undefined as ((n: number, chain: string, q: { address: Address; topics: (Hex | null)[]; from: bigint; to: bigint }) => Error | "malformed" | undefined) | undefined,
    /** Every balance asked (eth_getBalance), by address */
    balanceReads: [] as Address[],
    /** Every getUnclaimedRootTaoByHotkey asked: its coldkey and hotkey */
    creditReads: [] as { coldkey: Hex; hotkey: Hex }[],
    /** eth_gasPrice on both chains; `gasPriceAt`, when set, answers the n-th read (from 1) instead */
    gasPrice: 10n ** 9n,
    gasPriceAt: undefined as ((n: number) => bigint) | undefined,
    gasPriceReads: 0,
    /** Whether a broadcast transaction that isn't mined stays in the node's pool (eth_getTransactionByHash answers it as
     * pending), so a replacement can take its nonce */
    pooled: false,
    pool: {} as Record<string, { from: Address; nonce: Hex; blockNumber: null; gasPrice?: Hex; maxFeePerGas?: Hex; maxPriorityFeePerGas?: Hex }>,
  };
  return w;
}
export type World = ReturnType<typeof world>;

/** Base's pools as a delivery's sale meets them: the staker's delivery route (its sell path), the marginal price, the
 * sale's own impact, the oracle's 30-minute value and its two pools' mean liquidity. */
export interface Market {
  sellPath: Hex;
  /** USDC units a TAO, at the margin */
  spot: bigint;
  /** Basis points of price impact per whole TAO sold (a sale's average price is spot less amount × impactBps) */
  impactBps: bigint;
  /** The oracle's 30-minute value, USDC units a TAO */
  twap: bigint;
  /** oracle.meanLiquidity(): TAO/WETH, WETH/USDC */
  meanLiquidity: [bigint, bigint];
}

export const SELL_PATH: Hex = "0x5e115e11";

/** A market of `spot` USDC a TAO (TWAP the same), deep enough, with no impact unless asked. */
export const marketOf = (o: Partial<Market> = {}): Market => ({ sellPath: SELL_PATH, spot: 400_000_000n, impactBps: 0n, twap: o.spot ?? 400_000_000n, meanLiquidity: [10n ** 24n, 10n ** 24n], ...o });

/** What selling `amount` of TAO along the route pays, gross (before the staker's fee), pool fees and impact included. */
export const saleOf = (m: Market, amount: bigint): bigint => ((amount * m.spot) / TAO) * (10_000n - (m.impactBps * amount) / TAO) / 10_000n;

const STAKER_FEE_BPS = 15n;

/** The front door's deliver(user, keeperMinOut) on the world, as CascadeFrontDoor.sol does it: the claim, the
 * preference, the pools' depth (ThinPool), then the sale against the largest of the user's floor, the keeper's
 * minimum and the TWAP's less the slippage (BelowMinimum). The USDC it pays, or the revert. */
export function doorDeliver(w: World, user: Address, keeperMinOut: bigint): bigint {
  const d = w.door;
  const k = lower(user);
  const amount = d.claimable[k] ?? 0n;
  if (amount === 0n) throw revertWith("NothingToClaim");
  const [min, deadline, destination] = d.prefs[k] ?? [0n, 0n, 0];
  if (min === 0n) throw revertWith("NoDelivery");
  if (BigInt(w.time.base) > deadline) throw revertWith("DeliveryExpired");
  if (destination !== 6) throw revertWith("UnsupportedDestination");
  const m = w.market ?? marketOf();
  if (m.meanLiquidity[0] < d.minLiquidity[0]) throw revertWith("ThinPool", [0, m.meanLiquidity[0]]);
  if (m.meanLiquidity[1] < d.minLiquidity[1]) throw revertWith("ThinPool", [1, m.meanLiquidity[1]]);
  const userFloor = (amount * min + TAO - 1n) / TAO;
  const marketFloor = (((amount * m.twap) / TAO) * BigInt(10_000 - d.slippageBps)) / 10_000n;
  const floor = [userFloor, keeperMinOut, marketFloor].reduce((a, b) => (a > b ? a : b));
  const gross = saleOf(m, amount);
  const received = gross - (gross * STAKER_FEE_BPS) / 10_000n;
  if (received < floor) throw revertWith("BelowMinimum");
  return received;
}

const isoOf = (s: number) => new Date(s * 1000).toISOString();

/** /v1/status as the monitor serves it for the world (indexer/src/api.ts handleStatus): its holds, the keys it
 * confirmed, both chains settled a minute ago (lag `lagS`), its last tick 30 s ago. */
export function healthyStatus(w: World, o: { lagS?: number } = {}) {
  const now = w.time.base;
  const lag = o.lagS ?? 60;
  const chain = { settledTo: 1, settledTime: isoOf(now - lag), lagS: lag };
  return {
    v: 1,
    deployment: { frontDoor: ADDR.frontDoor, vault: ADDR.vault, baseChainId: 8453, bittensorChainId: 964 },
    hold: { active: w.monitor.hold.length > 0, ids: w.monitor.hold },
    payouts: { okKeys: w.monitor.okKeys ?? Object.keys(w.vault.batches) },
    indexer: { base: chain, bittensor: chain },
    monitor: { lastCompleteTickAt: isoOf(now - 30) },
    generatedAt: isoOf(now),
  };
}

/** The monitor the round reads, over the world: /v1/status from its holds, its confirmed keys and both chains read a
 * minute ago (or a status of the test's own); /v1/price as it is set. */
export function monitorOf(w: World): MonitorClient {
  return {
    where: "monitor.test",
    async status() {
      w.monitor.statusReads++;
      if (w.monitor.down) throw new MonitorUnreadable("a network error");
      return JSON.stringify(w.monitor.status ? w.monitor.status() : healthyStatus(w));
    },
    async price() {
      w.monitor.priceReads++;
      if (w.monitor.priceDown) throw new MonitorUnreadable("it answered HTTP 503");
      return JSON.stringify(w.monitor.price);
    },
  };
}

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const DELIVER = (KEEPER_CALLS_V32 as readonly AbiFunction[]).filter((f) => f.type === "function" && f.name === "deliver");
const FNS: AbiFunction[] = [VAULT_LENS, VAULT_KEPT, DOOR, DOOR_LENS, ADAPTER, BIT_ADAPTER, RAIL_VIEWS, PARK_READS, PARK_CALLS, PARK_JOBS, BASE_ADAPTER, STAKER, ORACLE, POOL, ALPHA, QUOTER, OFFRAMP, OFFRAMP_EXECUTE, OFFRAMP_CCVS, STAKING, ERC20, VAULT_ABI_V32, DELIVER]
  .flat()
  .filter((i): i is AbiFunction => i.type === "function");
const EVENTS: AbiEvent[] = [...VAULT_ABI_V32, ...DOOR, ...PARK_EVENTS, ...ADAPTER, ...ONRAMP, ...OFFRAMP_EVENTS].filter((i): i is AbiEvent => i.type === "event");

/** The Bittensor adapter's park errors, as the world's adapter reverts with them */
const PARK_ERRORS = ADAPTER_ERRORS;

/** A CCIP 2.0 MessageV1 encoded as MessageV1Codec._encodeMessageV1 does it (the vendored codec), for the world's OnRamp. */
export function encodeMessageV1(m: MessageV1): Hex {
  const len = (h: Hex, bytes: 1 | 2) => numberToHex(size(h), { size: bytes });
  const tt = m.tokenTransfer[0];
  const transfer: Hex = tt
    ? concat([
        "0x01",
        numberToHex(tt.amount, { size: 32 }),
        len(tt.sourcePoolAddress, 1),
        tt.sourcePoolAddress,
        len(tt.sourceTokenAddress, 1),
        tt.sourceTokenAddress,
        len(tt.destTokenAddress, 1),
        tt.destTokenAddress,
        len(tt.tokenReceiver, 1),
        tt.tokenReceiver,
        len(tt.extraData, 2),
        tt.extraData,
      ])
    : "0x";
  return concat([
    "0x01",
    numberToHex(m.sourceChainSelector, { size: 8 }),
    numberToHex(m.destChainSelector, { size: 8 }),
    numberToHex(m.messageNumber, { size: 8 }),
    numberToHex(m.executionGasLimit, { size: 4 }),
    numberToHex(m.ccipReceiveGasLimit, { size: 4 }),
    m.finality,
    m.ccvAndExecutorHash,
    len(m.onRampAddress, 1),
    m.onRampAddress,
    len(m.offRampAddress, 1),
    m.offRampAddress,
    len(m.sender, 1),
    m.sender,
    len(m.receiver, 1),
    m.receiver,
    len(m.destBlob, 2),
    m.destBlob,
    len(transfer, 2),
    transfer,
    len(m.data, 2),
    m.data,
  ]);
}

const word = (a: Address): Hex => padHex(a.toLowerCase() as Hex, { size: 32 });

/** Cascade's own bridge message on a lane of the world, as the source OnRamp would emit it: the adapter payload
 * (recipient, sender, message), `amount` of the token, the gas limit the sending adapter asked for, and a message number
 * (each message's own, so two are never the same bytes). Its id is keccak256 of the bytes. */
export function laneMessage(
  direction: "Base → Bittensor" | "Bittensor → Base",
  payload: { recipient: Address; sender: Address; message: Hex },
  o: { amount?: bigint; gas?: number; number?: bigint; over?: Partial<MessageV1>; pair?: PairNo } = {},
): { id: Hex; encoded: Hex; message: MessageV1 } {
  const toBittensor = direction === "Base → Bittensor";
  const src = toBittensor ? "base" : "bittensor";
  const dst = toBittensor ? "bittensor" : "base";
  const ad = adaptersOf(o.pair);
  const srcAdapter = toBittensor ? ad.base : ad.bit;
  const dstAdapter = toBittensor ? ad.bit : ad.base;
  const amount = o.amount ?? 0n;
  const m: MessageV1 = {
    sourceChainSelector: SELECTOR[src],
    destChainSelector: SELECTOR[dst],
    messageNumber: o.number ?? 1n,
    executionGasLimit: 0,
    ccipReceiveGasLimit: o.gas ?? 900_000,
    finality: "0x00000000",
    ccvAndExecutorHash: `0x${"00".repeat(32)}`,
    onRampAddress: word(toBittensor ? ADDR.onRampBase : ADDR.onRampBittensor),
    offRampAddress: (toBittensor ? ADDR.offRampBittensor : ADDR.offRampBase).toLowerCase() as Hex,
    sender: word(srcAdapter),
    receiver: dstAdapter.toLowerCase() as Hex,
    destBlob: "0x",
    tokenTransfer:
      amount > 0n
        ? [{ amount, sourcePoolAddress: word(at("9001")), sourceTokenAddress: word(at("9002")), destTokenAddress: at("9003").toLowerCase() as Hex, tokenReceiver: dstAdapter.toLowerCase() as Hex, extraData: "0x" }]
        : [],
    data: encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "bytes" }], [payload.recipient, payload.sender, payload.message]),
    ...o.over,
  };
  const encoded = encodeMessageV1(m);
  return { id: keccak256(encoded), encoded, message: m };
}

/** A bridge message's send in the world: the source adapter's Sent (its payload's sender and recipient) and the source
 * OnRamp's CCIPMessageSent with the encoded bytes, both at `block` of the source chain, in one transaction. */
export function sendInWorld(
  w: World,
  direction: "Base → Bittensor" | "Bittensor → Base",
  msg: { id: Hex; encoded: Hex; message: MessageV1 },
  payload: { recipient: Address; sender: Address },
  o: { block?: bigint; amount?: bigint; encodedLogged?: Hex; idLogged?: Hex; pair?: PairNo } = {},
): void {
  const toBittensor = direction === "Base → Bittensor";
  const ad = adaptersOf(o.pair);
  const chain = toBittensor ? "base" : "bittensor";
  const block = o.block ?? 9_000n;
  // sent at the chain's clock unless a test says when (its block's time, not told by the block time)
  w.blockTimes[`${chain}:${block}`] ??= w.time[chain];
  const tx = keccak256(stringToHex(`send:${msg.id}`));
  const id = o.idLogged ?? msg.id;
  w.logs.push({
    chain,
    address: toBittensor ? ad.base : ad.bit,
    event: "Sent",
    args: { messageId: id, destChain: toBittensor ? 964n : 8453n, sender: payload.sender, recipient: payload.recipient, amount: o.amount ?? msg.message.tokenTransfer[0]?.amount ?? 0n, fee: 10n ** 15n, gasLimit: BigInt(msg.message.ccipReceiveGasLimit) },
    block,
    tx,
  });
  w.logs.push({
    chain,
    address: toBittensor ? ADDR.onRampBase : ADDR.onRampBittensor,
    event: "CCIPMessageSent",
    args: {
      destChainSelector: toBittensor ? SELECTOR.bittensor : SELECTOR.base,
      sender: toBittensor ? ad.base : ad.bit,
      messageId: id,
      feeToken: at("0"),
      tokenAmountBeforeTokenPoolFees: msg.message.tokenTransfer[0]?.amount ?? 0n,
      encodedMessage: o.encodedLogged ?? msg.encoded,
      receipts: [],
      verifierBlobs: [],
    },
    block,
    tx,
  });
}

/** A park on the world's Bittensor adapter from a batch the door sent: its message sent on Base (sendInWorld), its
 * BatchParked log on Bittensor (at `block`), and its record under the adapter's key (parked(key): amount, parkedAt,
 * converted). Returns the park's key and its CCIP message. */
export function parkInWorld(
  w: World,
  p: { recipient: Address; sender: Address; message: Hex },
  o: {
    amount?: bigint;
    converted?: boolean;
    parkedAt?: bigint;
    block?: bigint;
    /** The Base block its send is in (default sendInWorld's, 9,000) */
    sendBlock?: bigint;
    number?: bigint;
    send?: boolean;
    encodedLogged?: Hex;
    idLogged?: Hex;
    /** The CCIP message sent for it, when not the one its payload makes (a mismatch's test) */
    msg?: { id: Hex; encoded: Hex; message: MessageV1 };
    /** R4: the pair it parks on (the second: its Base adapter sent it, its Bittensor adapter holds it) */
    pair?: PairNo;
  } = {},
): { key: Hex; id: Hex; encoded: Hex } {
  const amount = o.amount ?? TAO;
  const msg = o.msg ?? laneMessage("Base → Bittensor", p, { amount, number: o.number ?? BigInt(Object.keys(w.parks).length + Object.keys(w.parks2).length + 1), pair: o.pair });
  if (o.send !== false) sendInWorld(w, "Base → Bittensor", msg, p, { encodedLogged: o.encodedLogged, idLogged: o.idLogged, pair: o.pair, ...(o.sendBlock !== undefined ? { block: o.sendBlock } : {}) });
  const key = keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }, { type: "address" }, { type: "bytes" }], [8453n, p.sender, p.recipient, p.message]));
  const store = storeOf(w, adaptersOf(o.pair).bit);
  store.parks[lower(key)] = [amount, o.parkedAt ?? BigInt(T - 3_600), o.converted ?? false];
  store.messages[lower(key)] = p;
  w.logs.push({
    chain: "bittensor",
    address: adaptersOf(o.pair).bit,
    event: "BatchParked",
    args: { key, messageId: msg.id, recipient: p.recipient, sender: p.sender, amount, converted: o.converted ?? false, reason: "0x00000000" },
    block: o.block ?? 9_500n,
    tx: keccak256(stringToHex(`park:${key}`)),
  });
  w.messageStates[lower(msg.id)] = 2;
  return { key, id: msg.id, encoded: msg.encoded };
}

/** An execution attempt of `msg` on its destination's OffRamp, as a transaction the chain knows (eth_getTransactionByHash):
 * by default Chainlink's executor's, calling the OffRamp's execute with the message's bytes, the committee's CCV and its
 * results for that id; `to`, `input`, `ccvs` and `results` make another. Returns its hash. */
export function attemptInWorld(
  w: World,
  direction: "Base → Bittensor" | "Bittensor → Base",
  msg: { id: Hex; encoded: Hex },
  o: { ccvs?: Address[]; results?: Hex[]; to?: Address; input?: Hex; block?: bigint; tx?: Hex; encoded?: Hex } = {},
): Hex {
  const offRamp = direction === "Base → Bittensor" ? ADDR.offRampBittensor : ADDR.offRampBase;
  const tx = o.tx ?? keccak256(stringToHex(`attempt:${msg.id}:${Object.keys(w.txs).length}`));
  const input =
    o.input ?? encodeFunctionData({ abi: OFFRAMP_EXECUTE, functionName: "execute", args: [o.encoded ?? msg.encoded, o.ccvs ?? [COMMITTEE], o.results ?? [committeeResult(msg.id)], 0] });
  w.txs[lower(tx)] = { from: EXECUTOR, to: o.to ?? offRamp, input, blockNumber: numberToHex(o.block ?? 9_900n) };
  return tx;
}

/** `msg` in FAILURE on its destination's OffRamp, as the OffRamp writes it: its state, the ExecutionStateChanged log (the
 * error the attempt failed with: by default the receiver's), and the attempt that wrote it (attemptInWorld: by default an
 * honest one). Returns the attempt's hash. */
export function failInWorld(
  w: World,
  direction: "Base → Bittensor" | "Bittensor → Base",
  msg: { id: Hex; encoded: Hex; message: MessageV1 },
  o: Parameters<typeof attemptInWorld>[3] & { err?: Hex } = {},
): Hex {
  const toBittensor = direction === "Base → Bittensor";
  const tx = attemptInWorld(w, direction, msg, { ...o, tx: o.tx ?? keccak256(stringToHex(`fail:${msg.id}`)) });
  w.messageStates[lower(msg.id)] = 3;
  w.logs.push({
    chain: toBittensor ? "bittensor" : "base",
    address: toBittensor ? ADDR.offRampBittensor : ADDR.offRampBase,
    event: "ExecutionStateChanged",
    args: {
      sourceChainSelector: msg.message.sourceChainSelector,
      messageNumber: msg.message.messageNumber,
      messageId: msg.id,
      state: 3,
      returnData: o.err ?? encodeErrorResult({ abi: OFFRAMP_ERRS, errorName: "ReceiverError", args: [encodeErrorResult({ abi: ERRORS_V32, errorName: "ReentrancyGuardReentrantCall" } as never)] } as never),
    },
    block: o.block ?? 9_900n,
    tx,
  });
  return tx;
}

/** The world's OffRamp 2.0.0's execute(encodedMessage, ccvs, verifierResults, gasLimitOverride), as the verified source
 * does it (OffRamp.sol:188-262, 308-353, 624-683; CommitteeVerifier.sol:85-118): the CCVs as many as the results; a
 * message already delivered skipped; an override under the message's own refused; then, inside, the CCV quorum (every
 * required CCV listed, `threshold` of the optional ones) and each listed one's results checked against what the world's
 * committee signed for that very id (committeeResult), then the receiver (receiverFails). From FAILURE an inner failure
 * reverts NoStateProgressMade(id, err); otherwise it answers gas (a mined one delivers). */
export function offRampExecute(w: World, args: readonly unknown[]): bigint | { error: string; args?: unknown[] } {
  const [encoded, ccvs, results, gas] = args as [Hex, readonly Address[], readonly Hex[], number];
  if (ccvs.length !== results.length) return { error: "InvalidVerifierResultsLength", args: [BigInt(ccvs.length), BigInt(results.length)] };
  const id = keccak256(encoded);
  const state = w.messageStates[lower(id)] ?? 0;
  if (state !== 0 && state !== 3) return { error: "SkippedAlreadyExecutedMessage", args: [id, 0n, 0n] };
  const own = Number(`0x${encoded.slice(2 + 2 * 29, 2 + 2 * 33)}`);
  if (gas !== 0 && gas < own) return { error: "InvalidGasLimitOverride", args: [own, gas] };
  const inner = offRampInner(w, args);
  if (inner !== undefined && state === 3) return { error: "NoStateProgressMade", args: [id, inner] };
  return 400_000n;
}

/** What fails inside the world's OffRamp's execution of `args` (its CCV quorum, the committee's results for that very id,
 * the receiver), its error encoded, or undefined when nothing does. From FAILURE it reverts the call (NoStateProgressMade);
 * from UNTOUCHED the OffRamp writes FAILURE with it. */
export function offRampInner(w: World, args: readonly unknown[]): Hex | undefined {
  const [encoded, ccvs, results] = args as [Hex, readonly Address[], readonly Hex[], number];
  const id = keccak256(encoded);
  const at = (c: Address) => ccvs.findIndex((x) => lower(x) === lower(c));
  const signed = (j: number) => lower(results[j]) === lower(committeeResult(id));
  let inner: Hex | undefined;
  for (const c of w.ccvs.required) {
    const j = at(c);
    if (j < 0) inner ??= offRampError("RequiredCCVMissing", [c]);
    else if (!signed(j)) inner ??= offRampError("InvalidVerifierResults");
  }
  let need = w.ccvs.threshold;
  for (const c of w.ccvs.optional) {
    const j = at(c);
    if (j < 0 || need === 0) continue;
    need--;
    if (!signed(j)) inner ??= offRampError("InvalidVerifierResults");
  }
  if (need > 0) inner ??= offRampError("OptionalCCVQuorumNotReached", [BigInt(w.ccvs.threshold), BigInt(w.ccvs.threshold - need)]);
  const receiver = w.receiverFails(id);
  if (receiver !== undefined) inner ??= offRampError("ReceiverError", [receiver]);
  return inner;
}

/** A revert of the world's OffRamp: the error's name and its arguments, as OffRamp 2.0.0 declares them. */
export const offRampRevert = (name: string, args: unknown[] = []) => new RpcError("execution reverted", 3, encodeErrorResult({ abi: OFFRAMP_ERRS, errorName: name, args } as never));
/** An inner error of OffRamp 2.0.0 (NoStateProgressMade's `err`), encoded. */
export const offRampError = (name: string, args: unknown[] = []): Hex => encodeErrorResult({ abi: OFFRAMP_ERRS, errorName: name, args } as never);

/** The park the adapter would find for this call's (recipient, sender, message), as its _parkKey keys it: keccak256 of
 * abi.encode(remoteChainId, sender, recipient, message). */
const parkKeyIn = (args: readonly unknown[]) =>
  lower(keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }, { type: "address" }, { type: "bytes" }], [8453n, args[1] as Address, args[0] as Address, args[2] as Hex])));

/** The world's adapter's own checks of a park call (NotParked, ParkedTooYoung, NothingToRefund), then the test's
 * simulation for a delivery: the error it reverts with, or nothing. */
function parkCallProblem(w: World, fn: string, args: readonly unknown[], adapter: Address = ADDR.bitAdapter): string | undefined {
  const k = parkKeyIn(args);
  const p = storeOf(w, adapter).parks[k];
  if (!p || p[1] === 0n) return "NotParked";
  const young = BigInt(w.time.bittensor) < p[1] + 14n * 86_400n;
  if (fn === "deliverParked") return w.parkSim(k);
  if (fn === "refundParked" || fn === "quoteRefund") {
    if (p[0] === 0n) return "NothingToRefund";
    if (fn === "refundParked" && young) return "ParkedTooYoung";
  }
  if (fn === "dropParked") {
    if (p[0] !== 0n) return "NotParked";
    if (young) return "ParkedTooYoung";
  }
  return undefined;
}

const parkRevert = (name: string) => new RpcError("execution reverted", 3, encodeErrorResult({ abi: PARK_ERRORS, errorName: name } as never));

/** Whether `a` is one of the world's Bittensor adapters (R4: the deploy's, the second pair's). */
const isBitAdapter = (a: string) => a.toLowerCase() === ADDR.bitAdapter.toLowerCase() || a.toLowerCase() === ADDR.bitAdapter2.toLowerCase();

/** CcipAdapterBase.GAS_CAP, and its _gasModel: `base + entries * perEntry` for a BATCH (6 header words) or PAYOUTS (5)
 * message, capped at the cap; the cap itself for a message that does not parse or of another kind. */
export const GAS_CAP = 7_000_000n;
export function gasModelOf(message: Hex, base: bigint, perEntry: bigint): bigint {
  const bytes = (message.length - 2) / 2;
  if (bytes < 32 || bytes % 32 !== 0) return GAS_CAP;
  const words = bytes / 32;
  const kind = Number(BigInt(`0x${message.slice(2, 66)}`) & 0xffn);
  const header = kind === 1 ? 6 : kind === 2 ? 5 : 0;
  if (!header || words < header || (words - header) % 2 !== 0) return GAS_CAP;
  const gas = base + BigInt((words - header) / 2) * perEntry;
  return gas > GAS_CAP ? GAS_CAP : gas;
}
/** A Bittensor adapter's parks and their messages (R4): the deploy's adapter's are `parks` and `parkMessages`. */
export function storeOf(w: World, adapter: Address): { parks: World["parks"]; messages: World["parkMessages"] } {
  return adapter.toLowerCase() === ADDR.bitAdapter2.toLowerCase() ? { parks: w.parks2, messages: w.parkMessages2 } : { parks: w.parks, messages: w.parkMessages };
}

const lower = (a: string) => a.toLowerCase();

/** The world's listed hotkey `h`, if it is listed. */
const listed = (w: World, h: Hex): WorldHotkey | undefined => w.vault.hotkeys.slice(0, w.vault.hotkeyCount).find((x) => lower(x.hotkey) === lower(h));

/** A SCALE i128, little-endian two's complement, as hex without 0x. */
function i128Le(x: bigint): string {
  const u = x & ((1n << 128n) - 1n);
  return Array.from({ length: 16 }, (_, k) => ((u >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, "0")).join("");
}

/** A claim of listed hotkey `h` mined, as the vault does it: it pays the hotkey's credits (as stake on it, or the vault's
 * balance), stamps its claim, and, when it paid any, restarts the claim schedule from now over rewardVesting (30 days; R6b:
 * the vault's _vest, the period at least rewardVesting). The keeper's fake chains use it too. */
export function claimMined(w: World, hotkey: Hex): void {
  const h = listed(w, hotkey);
  if (!h) return;
  h.lastClaimAt = BigInt(w.time.bittensor);
  if (w.vault.claimBooksNothing) return;
  if (h.credits > 0n) w.vault.vesting = { start: BigInt(w.time.bittensor), period: 2_592_000n, amount: w.vault.vesting.amount + h.credits };
  if (w.vault.claimPaysTo === "stake") h.stakeRao += h.credits / RAO;
  else w.vault.balance += h.credits;
  h.credits = 0n;
}

/** The default answer of `fn` on `to`, from the world. */
function answer(w: World, to: Address, fn: string, args: readonly unknown[]): unknown {
  const extra = w.answers[`${lower(to)}:${fn}`];
  if (extra) return extra(args);
  const v = w.vault;
  const d = w.door;
  const is = (a: Address) => lower(a) === lower(to);
  if (is(ADDR.vaultLens)) {
    const map: Record<string, unknown> = {
      pendingPayouts: v.pending,
      payoutDelay: v.payoutDelay,
      visibleStakeRao: v.visibleStakeRao,
      bookedStake: v.bookedStake,
      minStakeRao: v.minStakeRao,
      minRemainRao: v.minRemainRao,
      totalAssets: v.totalAssets,
      grossAssets: v.grossAssets,
      unvestedRewards: v.unvested,
      stakeMissing: v.stakeMissing,
      hotkeyCount: BigInt(v.hotkeyCount),
      idleBufferBps: v.idleBufferBps,
      minDailyOutflow: v.minDailyOutflow,
      keeper: v.keeper,
      primaryBridge: w.primary.bittensor,
      maxFeeBps: v.maxFeeBps,
      maxFeeAbs: v.maxFeeAbs,
      minChunk: v.minChunk,
      maxMessageValue: v.maxMessageValue,
      unstakeGas: v.unstakeGas,
      // R4: the launch value, 30 days (the claim policy's longest gap)
      rewardVesting: 2_592_000n,
      stakeHotkey: v.stakeHotkey,
      lastStakeAt: v.lastStakeAt,
      claimGasRequired: 55_000_000n,
      hotkeyDustRao: 1_000_000n,
      vestingStart: v.vesting.start,
      vestingPeriod: v.vesting.period,
      vestingAmount: v.vesting.amount,
      surplusStakeRao: v.surplusStakeRao,
      lastAdoptAt: v.lastAdoptAt,
      missingStakeRao: v.missingStakeRao ?? (v.bookedStake > v.visibleStakeRao ? v.bookedStake - v.visibleStakeRao : 0n),
    };
    if (fn === "unlistedStakeRao") {
      if (v.unlistedStakeRao === "reverts") throw new RpcError("execution reverted", 3, "0x");
      return v.unlistedStakeRao;
    }
    if (fn === "lastClaimAt") return listed(w, args[0] as Hex)?.lastClaimAt ?? BigInt(T - 86_400);
    if (fn === "bridgeEnabled") return w.bridgeEnabled[lower(args[0] as string)] ?? true;
    // the launch door's state, by its peer id (CascadeFormulas.peerId); any other door is Unknown
    if (fn === "doorState") return lower(args[0] as string) === lower(keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }], [8453n, ADDR.frontDoor]))) ? v.doorState : 0;
    if (fn === "hotkeys") {
      const i = Number(args[0]);
      // past the end it reverts without data, as the lens does
      if (i >= v.hotkeyCount) throw new RpcError("execution reverted", 3, "0x");
      return v.hotkeys[i]?.hotkey ?? (`0x${(i + 1).toString(16).padStart(2, "0").repeat(32)}` as Hex);
    }
    if (fn === "getPayoutBatch") {
      const b = v.batches[lower(args[0] as string)];
      return b ?? { sourceChain: 0n, frontDoor: at("0"), batchId: 0n, queuedAt: 0n, cursor: 0, count: 0, chunk: 0, remaining: 0n, payoutsHash: `0x${"00".repeat(32)}` };
    }
    if (fn in map) return map[fn];
  }
  if (is(ADDR.vault)) {
    if (fn === "paused") return v.paused;
    if (fn === "totalSupply") return v.totalSupply;
    // a keeper call's eth_call (a hand one-shot's simulation, Task 53): what its estimate would answer
    if (["claimRewards", "adoptStake", "addHotkey", "removeHotkey"].includes(fn)) {
      const r = w.simulate({ chain: "bittensor", to, fn, args, value: 0n });
      if (typeof r !== "bigint") throw revertWith(r.error, r.args);
      return undefined;
    }
  }
  if (is(ADDR.frontDoor)) {
    if (fn === "claimable") return d.claimable[lower(args[0] as string)] ?? 0n;
    if (fn === "deliveryOf") return d.prefs[lower(args[0] as string)] ?? [0n, 0n, 0];
    if (fn === "maxDeliverySlippageBps") return d.slippageBps;
    if (fn === "minPoolLiquidity") return d.minLiquidity[Number(args[0])];
    if (fn === "deliver") return doorDeliver(w, args[0] as Address, args[1] as bigint);
    const map: Record<string, unknown> = {
      openDeposits: d.deposits,
      openRedeems: d.redeems,
      canClose: d.canClose,
      paused: d.paused,
      openBatch: [d.id, d.start, d.totalDeposits, d.feePot, BigInt(d.deposits.length), BigInt(d.redeems.length)],
      batchInterval: d.batchInterval,
      maxDeposits: d.maxDeposits,
      maxRedeems: d.maxRedeems,
      maxBatchValue: d.maxBatchValue,
      minDeposit: 4n * 10n ** 16n,
      depositCap: d.depositCap,
      netForwarded: d.netForwarded,
      keeper: d.keeper,
      oracle: ADDR.oracle,
      swapper: ADDR.staker,
    };
    if (fn in map) return map[fn];
  }
  if (is(ADDR.doorLens) && fn === "primaryBridge") return w.primary.base;
  if ((is(ADDR.baseAdapter) || is(ADDR.baseAdapter2)) && fn === "quoteFee") return d.closeFee;
  if (isBitAdapter(to) && fn === "quoteFee") return v.payoutFee;
  if (isBitAdapter(to) && fn === "alphaVault") return w.adapterVault[lower(to)] ?? ADDR.alphaVault;
  // the Base adapters' gas model toward Bittensor (R4: the parked delivery's gas floor reads it)
  if ((fn === "gasBase" || fn === "gasPerEntry") && w.inbound[lower(to)]) return w.inbound[lower(to)][fn === "gasBase" ? 0 : 1];
  // merge 7b (R4): the parked delivery's gas requirement, the adapter's own view over its inbound pair
  if (isBitAdapter(to) && fn === "parkedDeliveryGas") return gasModelOf(args[0] as Hex, ...w.parkModel[lower(to)]);
  if (isBitAdapter(to) && fn === "parked") return storeOf(w, to).parks[lower(args[0] as string)] ?? [0n, 0n, false];
  if (isBitAdapter(to) && fn === "remoteChainId") return 8453n;
  if (isBitAdapter(to) && (fn === "deliverParked" || fn === "quoteRefund" || fn === "refundParked" || fn === "dropParked")) {
    const problem = parkCallProblem(w, fn, args, to);
    if (problem) throw parkRevert(problem);
    return fn === "quoteRefund" ? w.refundFee : undefined;
  }
  if ((is(ADDR.offRampBase) || is(ADDR.offRampBittensor)) && fn === "getExecutionState") return w.messageStates[lower(args[0] as string)] ?? 0;
  if ((is(ADDR.offRampBase) || is(ADDR.offRampBittensor)) && fn === "getCCVsForMessage") return [w.ccvs.required, w.ccvs.optional, w.ccvs.threshold];
  // a manual execution's eth_call (the keeper's explicit simulation): what its estimate would answer
  if ((is(ADDR.offRampBase) || is(ADDR.offRampBittensor)) && fn === "execute") {
    const x = w.executeSim(args);
    if (typeof x !== "bigint") throw offRampRevert(x.error, x.args);
    return undefined;
  }
  if (isBitAdapter(to) && fn === "canSendPayouts") {
    const c = w.canSendPayouts[lower(to)];
    if (c === "reverts") throw new RpcError("execution reverted", 3, "0x");
    return c ?? true;
  }
  if (isBitAdapter(to) && fn === "parkedNative") return 0n;
  if (isBitAdapter(to) && fn === "parkedTokens") return 0n;
  if (is(ADDR.alphaVault)) {
    if (fn === "isPaused") return w.alpha.paused;
    if (fn === "migrationReadyAt") return w.alpha.migrationReadyAt;
    if (fn === "migrationFinished") return w.alpha.migrationFinished;
    if (fn === "MIGRATION_DELAY") {
      if (w.alpha.migrationDelay === undefined) throw new RpcError("execution reverted", 3, "0x");
      return w.alpha.migrationDelay;
    }
  }
  const other = w.vaults[lower(to)];
  if (other) {
    if (fn === "isPaused") return other.paused;
    if (fn === "migrationReadyAt") return other.migrationReadyAt;
    if (fn === "migrationFinished") return other.migrationFinished;
    if (fn === "MIGRATION_DELAY") {
      if (other.migrationDelay === undefined) throw new RpcError("execution reverted", 3, "0x");
      return other.migrationDelay;
    }
  }
  if (is(ADDR.oracle) && fn === "usdcValue") return ((args[0] as bigint) * (w.market?.twap ?? 400_000_000n)) / TAO;
  if (is(ADDR.oracle) && fn === "meanLiquidity") return w.market?.meanLiquidity ?? [10n ** 24n, 10n ** 24n];
  if (is(ADDR.oracle) && fn === "MIN_CARDINALITY") return 1_801;
  if (is(ADDR.staker)) {
    if (fn === "depositFeeUsdc") return 50_000n;
    if (fn === "swapFeeBps") return 15;
    if (fn === "deliveryRouteId") return 0;
    if (fn === "routes") return [0, at("1"), "0x", w.market?.sellPath ?? "0x", true];
  }
  if (is(ADDR.quoter) && fn === "quoteExactInput") {
    if (w.market && lower(args[0] as string) === lower(w.market.sellPath)) return [saleOf(w.market, args[1] as bigint), [], [], 0n];
    return [3_000_000_000n, [], [], 0n];
  }
  if (is(ADDR.staking) && fn === "getUnclaimedRootTaoByHotkey") {
    w.creditReads.push({ coldkey: args[0] as Hex, hotkey: args[1] as Hex });
    return lower(args[0] as string) === lower(addressMapping(ADDR.vault)) ? (listed(w, args[1] as Hex)?.credits ?? 0n) : 0n;
  }
  if (is(ADDR.staking) && fn === "getStake") {
    return lower(args[1] as string) === lower(addressMapping(ADDR.vault)) && args[2] === 0n ? (listed(w, args[0] as Hex)?.stakeRao ?? 0n) : 0n;
  }
  if (is(ADDR.staking) && fn === "getRejectStakingHotkeyGrowth") return v.rejectGrowth;
  throw new Error(`the fake v3.2 world has no answer for ${fn} on ${to}`);
}

function encodeLog(l: Log, i: number): { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex; transactionHash: Hex } {
  const ev = EVENTS.find((e) => e.name === l.event);
  if (!ev) throw new Error(`no event ${l.event}`);
  const topics = encodeEventTopics({ abi: [ev], eventName: ev.name, args: l.args } as never) as Hex[];
  const data = encodeAbiParameters(
    ev.inputs.filter((i) => !i.indexed),
    ev.inputs.filter((i) => !i.indexed).map((i) => l.args[i.name as string]),
  );
  return { address: l.address, topics, data, blockNumber: numberToHex(l.block), logIndex: numberToHex(i), transactionHash: l.tx ?? keccak256(stringToHex(`${l.event}:${l.block}:${i}`)) };
}

/** A revert as a node answers it: the error's name, encoded with the v3.2 errors. */
export const revertWith = (name: string, args: unknown[] = []) =>
  new RpcError("execution reverted", 3, encodeErrorResult({ abi: ERRORS_V32, errorName: name, args } as never));

type ReceiptLog = { address: Address; topics: Hex[]; data: Hex };

/** A mined call `c` (transaction `hash`, its receipt's `logs` so far) as the adapter and the OffRamp take it, for rpcOf's
 * broadcast and the keeper Worker's fake chains alike. A park call: deliverParked delivers (ParkedDelivered) or, refused by
 * the recipient, keeps it as a converted park (ParkedConverted); refundParked sends it back to the door (ParkedRefunded, and
 * the adapter's Sent); dropParked deletes an empty one (ParkedDropped); one the adapter would refuse reverts. A manual
 * execution (executeSim): from FAILURE delivered (SUCCESS) or reverted; from UNTOUCHED, one whose checks inside fail (the
 * proof, the receiver: offRampInner) writes FAILURE, as the OffRamp does (its ExecutionStateChanged; the re-review's N7),
 * else SUCCESS. Anything else is left as it is. */
export function bridgeCallMined(w: World, c: SentCall, hash: Hex, logs: ReceiptLog[]): { fate: "mine" | "revert"; logs: ReceiptLog[] } {
  let out = logs;
  const emit = (l: Log) => {
    w.logs.push(l);
    const { address, topics, data } = encodeLog(l, w.logs.length - 1);
    out = [...out, { address, topics, data }];
  };
  if (isBitAdapter(c.to) && ["deliverParked", "refundParked", "dropParked"].includes(c.fn)) {
    const k = parkKeyIn(c.args);
    const parks = storeOf(w, c.to).parks;
    const adapter = getAddress(c.to);
    const p = parks[k];
    const key = keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }, { type: "address" }, { type: "bytes" }], [8453n, c.args[1] as Address, c.args[0] as Address, c.args[2] as Hex]));
    if (parkCallProblem(w, c.fn, c.args, c.to) || !p) return { fate: "revert", logs };
    if (c.fn === "deliverParked") {
      // R4 (A-M1): a delivery sent with less gas than the vault's call needs is starved: the vault refuses it, out of gas,
      // and the park is kept as converted, as the adapter's catch does (deliverStarvedBelow: the least gas that delivers)
      if (w.vaultTakesParks && c.gas >= w.deliverStarvedBelow(c)) {
        delete parks[k];
        emit({ chain: "bittensor", address: adapter, event: "ParkedDelivered", args: { key }, block: w.head.bittensor, tx: hash });
      } else {
        parks[k] = [p[0], p[1], true];
        emit({ chain: "bittensor", address: adapter, event: "ParkedConverted", args: { key }, block: w.head.bittensor, tx: hash });
      }
    } else if (c.fn === "refundParked") {
      delete parks[k];
      const id = keccak256(stringToHex(`refund:${k}`));
      emit({ chain: "bittensor", address: adapter, event: "Sent", args: { messageId: id, destChain: 8453n, sender: c.args[0], recipient: c.args[1], amount: p[0], fee: w.refundFee, gasLimit: 200_000n }, block: w.head.bittensor, tx: hash });
      emit({ chain: "bittensor", address: adapter, event: "ParkedRefunded", args: { key, messageId: id }, block: w.head.bittensor, tx: hash });
    } else {
      delete parks[k];
      emit({ chain: "bittensor", address: adapter, event: "ParkedDropped", args: { key }, block: w.head.bittensor, tx: hash });
    }
    return { fate: "mine", logs: out };
  }
  if (c.fn === "execute") {
    if (typeof w.executeSim(c.args) !== "bigint") return { fate: "revert", logs };
    const encoded = c.args[0] as Hex;
    const id = lower(keccak256(encoded));
    const inner = (w.messageStates[id] ?? 0) === 0 ? offRampInner(w, c.args) : undefined;
    if (inner === undefined) w.messageStates[id] = 2;
    else {
      // UNTOUCHED, and its checks inside failed: the OffRamp writes FAILURE (the transaction itself succeeds), the
      // re-review's N7
      w.messageStates[id] = 3;
      const toBittensor = lower(c.to) === lower(ADDR.offRampBittensor);
      emit({
        chain: toBittensor ? "bittensor" : "base",
        address: c.to,
        event: "ExecutionStateChanged",
        args: { sourceChainSelector: BigInt(`0x${encoded.slice(4, 20)}`), messageNumber: BigInt(`0x${encoded.slice(36, 52)}`), messageId: keccak256(encoded), state: 3, returnData: inner },
        block: w.head[toBittensor ? "bittensor" : "base"],
        tx: hash,
      });
    }
    return { fate: "mine", logs: out };
  }
  return { fate: "mine", logs };
}

/** The fake chains' RPC over the world. */
export function rpcOf(w: World): Rpc {
  return {
    async request(chain, method, params) {
      switch (method) {
        case "eth_chainId":
          return numberToHex(w.chainIds[chain]);
        case "eth_blockNumber":
          return numberToHex(w.head[chain]);
        case "eth_getBlockByNumber": {
          const n = params[0] === "latest" ? w.head[chain] : BigInt(params[0] as Hex);
          const t = params[0] === "latest" ? w.time[chain] : (w.blockTimes[`${chain}:${n}`] ?? w.time[chain] - Math.floor(Number(w.head[chain] - n) * w.blockS[chain]));
          return { number: numberToHex(n), timestamp: numberToHex(t) };
        }
        case "eth_getBalance": {
          const a = lower(params[0] as string);
          w.balanceReads.push(getAddress(a));
          if (a === lower(ADDR.vault)) return numberToHex(w.vault.balance);
          return numberToHex(w.balances[a] ?? TAO);
        }
        case "eth_getCode":
          return w.codes[lower(params[0] as string)] ?? "0x";
        case "eth_getTransactionCount":
          return numberToHex(params[1] === "pending" ? w.nonce[chain].pending : w.nonce[chain].latest);
        case "eth_gasPrice":
          w.gasPriceReads++;
          return numberToHex(w.gasPriceAt ? w.gasPriceAt(w.gasPriceReads) : w.gasPrice);
        case "eth_maxPriorityFeePerGas":
          return numberToHex(10n ** 8n);
        case "eth_call": {
          const tx = params[0] as { to: Address; data: Hex; from?: Address; gas?: Hex };
          // Bittensor's storage-query precompile: the raw key in, the raw SCALE value out (RootStakeUnlockInterval, a u64)
          if (lower(tx.to) === lower(STORAGE_QUERY_ADDR)) {
            w.calls.push({ chain, to: tx.to, fn: "storage" });
            if (w.rootHold === "absent") return "0x";
            if (w.rootHold === "unreadable") throw new RpcError("execution reverted", 3, "0x");
            // the block number, a u32: always an entry
            if (lower(tx.data) === lower(SYSTEM_NUMBER_KEY)) return numberToHex(w.head.bittensor, { size: 4 }).replace(/^0x(..)(..)(..)(..)$/, "0x$4$3$2$1") as Hex;
            // R6b (U9): the vault coldkey's deferred rows on a hotkey (prefix, then Blake2_128Concat(hotkey): 16 bytes, the hotkey)
            const deferredOf = (prefix: string) => (lower(tx.data).startsWith(lower(prefix)) ? w.deferred[`0x${tx.data.slice(prefix.length + 32, prefix.length + 96).toLowerCase()}`] : undefined);
            if (lower(tx.data).startsWith(lower(DEFERRED_BASKET_DEBTS_PREFIX))) {
              const debt = deferredOf(DEFERRED_BASKET_DEBTS_PREFIX)?.alphaDebtRao;
              return debt === undefined ? "0x" : (`0x04${"0100"}${"0100000000000000"}${i128Le(debt << 64n)}` as Hex);
            }
            if (lower(tx.data).startsWith(lower(DEFERRED_BASKET_CASH_CLAIMED_PREFIX))) {
              const claimed = deferredOf(DEFERRED_BASKET_CASH_CLAIMED_PREFIX)?.cashClaimedRao;
              return claimed === undefined ? "0x" : (`0x${i128Le(claimed)}` as Hex);
            }
            if (lower(tx.data) !== lower(ROOT_HOLD_KEY)) throw new Error(`unexpected storage key ${tx.data}`);
            if (w.rootHold === 0n) return "0x";
            let x = w.rootHold;
            let out = "0x";
            for (let i = 0; i < 8; i++) {
              out += (x & 0xffn).toString(16).padStart(2, "0");
              x >>= 8n;
            }
            return out as Hex;
          }
          const fn = [...FNS, ...w.fns].find((f) => toFunctionSelector(f) === tx.data.slice(0, 10) && (FNS.includes(f) || w.answers[`${lower(tx.to)}:${f.name}`]));
          if (!fn) throw new Error(`unexpected call ${tx.data.slice(0, 10)} on ${tx.to}`);
          const { args } = decodeFunctionData({ abi: [fn], data: tx.data });
          w.calls.push({ chain, to: tx.to, fn: fn.name });
          // R4 (B-L2): a call answered by the block it is read at (a node behind another, a block it doesn't have)
          const hooked = w.callAt?.({ chain, to: tx.to, fn: fn.name, args: args ?? [], tag: String(params[1] ?? "latest"), ...(tx.from ? { from: tx.from } : {}), ...(tx.gas ? { gas: tx.gas } : {}) });
          if (hooked instanceof Error) throw hooked;
          if (hooked) return encodeFunctionResult({ abi: [fn], functionName: fn.name, result: hooked.result } as never);
          // R8 (L-D): a rail view's raw answer, as the vault's staticcall sees it
          const raw = fn.name === "canSendPayouts" ? w.canSendPayouts[lower(tx.to)] : undefined;
          if (raw === "empty") return "0x";
          if (typeof raw === "bigint") return numberToHex(raw, { size: 32 });
          return encodeFunctionResult({ abi: [fn], functionName: fn.name, result: answer(w, tx.to, fn.name, args ?? []) } as never);
        }
        case "eth_getLogs": {
          const f = params[0] as { address: Address; fromBlock: Hex; toBlock: Hex; topics: (Hex | null)[] };
          const fail = w.logsFail?.(w.logQueries.length + 1, chain, { address: f.address, topics: f.topics.slice(1), from: BigInt(f.fromBlock), to: BigInt(f.toBlock) });
          if (fail instanceof Error) throw fail;
          w.logQueries.push({ chain, address: f.address, topic0: f.topics[0] as Hex, topics: f.topics.slice(1), from: BigInt(f.fromBlock), to: BigInt(f.toBlock) });
          if (fail === "malformed") return [{ address: f.address, topics: [f.topics[0]], data: "0x01", blockNumber: f.fromBlock, logIndex: "0x0", transactionHash: `0x${"ee".repeat(32)}` }];
          return w.logs
            .map((l, i) => [l, i] as const)
            .filter(([l]) => l.chain === chain && lower(l.address) === lower(f.address) && l.block >= BigInt(f.fromBlock) && l.block <= BigInt(f.toBlock))
            .map(([l, i]) => encodeLog(l, i))
            .filter((l) => l.topics[0] === f.topics[0] && (w.logsIgnoreTopics || f.topics.slice(1).every((t, i) => t === null || t === undefined || lower(t) === lower(l.topics[i + 1] ?? ""))));
        }
        case "eth_estimateGas": {
          const tx = params[0] as { to: Address; data: Hex; value?: Hex };
          const fn = FNS.find((x) => toFunctionSelector(x) === tx.data.slice(0, 10)) ?? KEEPER_FNS.find((x) => toFunctionSelector(x) === tx.data.slice(0, 10));
          const { args } = fn ? decodeFunctionData({ abi: [fn], data: tx.data }) : { args: [] };
          const r = w.simulate({ chain, to: tx.to, fn: fn?.name ?? "?", args: args ?? [], value: BigInt(tx.value ?? "0x0") });
          if (typeof r !== "bigint") throw revertWith(r.error, r.args);
          // a delivery's estimate runs the door's checks on the world as it is
          if (fn?.name === "deliver") doorDeliver(w, (args ?? [])[0] as Address, (args ?? [])[1] as bigint);
          // a park call's runs the adapter's (and its fee: InsufficientFee), and a manual execution the test's
          if (isBitAdapter(tx.to) && fn && ["deliverParked", "refundParked", "dropParked"].includes(fn.name)) {
            const problem = parkCallProblem(w, fn.name, args ?? [], tx.to);
            if (problem) throw parkRevert(problem);
            if (fn.name === "refundParked" && BigInt(tx.value ?? "0x0") < w.refundFee) throw revertWith("InsufficientFee");
          }
          if (fn?.name === "execute") {
            const x = w.executeSim(args ?? []);
            if (typeof x !== "bigint") throw new RpcError("execution reverted", 3, encodeErrorResult({ abi: OFFRAMP_ERRS, errorName: x.error, args: x.args } as never));
            return numberToHex(x);
          }
          return numberToHex(r);
        }
        case "eth_sendRawTransaction": {
          const raw = params[0] as Hex;
          const tx = parseTransaction(raw);
          const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
          if (lower(from) !== lower(KEY.address)) throw new Error("not the keeper's");
          const fn = KEEPER_FNS.find((x) => toFunctionSelector(x) === (tx.data ?? "0x").slice(0, 10));
          const { args } = fn ? decodeFunctionData({ abi: [fn], data: tx.data as Hex }) : { args: [] };
          const hash = keccak256(raw);
          const c: SentCall = { chain, to: tx.to as Address, fn: fn?.name ?? "transfer", args: args ?? [], value: tx.value ?? 0n, gas: tx.gas ?? 0n, hash };
          w.sends.push(c);
          let fate = w.fate(c);
          w.nonce[chain].pending++;
          // a delivery mined: the door's checks on the world as it is then, and the sale's effects (the claim spent, the
          // pool's price moved by the sale, the Delivered log)
          let logs = fate === "hold" ? [] : w.receiptLogs(c);
          if (c.fn === "deliver" && fate === "mine") {
            const [user, keeperMinOut] = c.args as [Address, bigint];
            try {
              const amount = w.door.claimable[lower(user)] ?? 0n;
              const received = doorDeliver(w, user, keeperMinOut);
              w.door.claimable[lower(user)] = 0n;
              const m = w.market;
              if (m) m.spot = (m.spot * (10_000n - (2n * m.impactBps * amount) / TAO)) / 10_000n;
              const log: Log = { chain: "base", address: ADDR.frontDoor, event: "Delivered", args: { user, taoIn: amount, usdcOut: received }, block: w.head.base, tx: hash };
              w.logs.push(log);
              const { address, topics, data } = encodeLog(log, w.logs.length - 1);
              logs = [...logs, { address, topics, data }];
            } catch {
              fate = "revert";
            }
          }
          // a claim or an adoption mined, as the vault does it: claimRewards pays the hotkey's credits and stamps its claim;
          // adoptStake books the surplus and stamps the adoption
          if (fate === "mine" && c.fn === "claimRewards") claimMined(w, c.args[0] as Hex);
          // a hotkey listed or removed, as the vault's L4 does it (Task 53): added at the end with the stake it holds off the
          // list; removed by swap-and-pop
          if (fate === "mine" && c.fn === "addHotkey") {
            const h = c.args[0] as Hex;
            w.vault.hotkeys.splice(w.vault.hotkeyCount, 0, { hotkey: h, stakeRao: w.vault.offList[lower(h)] ?? 0n, credits: 0n, lastClaimAt: BigInt(w.time.bittensor) });
            w.vault.hotkeyCount++;
          }
          if (fate === "mine" && c.fn === "removeHotkey") {
            const i = w.vault.hotkeys.slice(0, w.vault.hotkeyCount).findIndex((x) => lower(x.hotkey) === lower(c.args[0] as string));
            if (i >= 0) {
              w.vault.hotkeys[i] = w.vault.hotkeys[w.vault.hotkeyCount - 1];
              w.vault.hotkeys.splice(w.vault.hotkeyCount - 1, 1);
              w.vault.hotkeyCount--;
            }
          }
          if (fate === "mine" && c.fn === "adoptStake") {
            w.vault.bookedStake += w.vault.surplusStakeRao;
            w.vault.surplusStakeRao = 0n;
            w.vault.lastAdoptAt = BigInt(w.time.bittensor);
          }
          // a park call or a manual execution mined, as the adapter and the OffRamp do it (bridgeCallMined)
          if (fate === "mine") ({ fate, logs } = bridgeCallMined(w, c, hash, logs));
          if (fate === "hold" && w.pooled) {
            w.pool[hash] = {
              from: KEY.address,
              nonce: numberToHex(tx.nonce ?? 0),
              blockNumber: null,
              ...(tx.gasPrice !== undefined ? { gasPrice: numberToHex(tx.gasPrice) } : {}),
              ...(tx.maxFeePerGas !== undefined ? { maxFeePerGas: numberToHex(tx.maxFeePerGas), maxPriorityFeePerGas: numberToHex(tx.maxPriorityFeePerGas ?? 0n) } : {}),
            };
            // a replacement at a pooled nonce is pending in its turn, the one before it no longer
            w.nonce[chain].pending--;
            for (const [h, x] of Object.entries(w.pool)) if (h !== hash && x.nonce === numberToHex(tx.nonce ?? 0)) delete w.pool[h];
            w.nonce[chain].pending = Math.max(w.nonce[chain].pending, (tx.nonce ?? 0) + 1);
          }
          if (fate !== "hold") {
            // a pooled transaction at this nonce is replaced by this one (its nonce was counted pending already)
            for (const [h, x] of Object.entries(w.pool)) {
              if (x.nonce !== numberToHex(tx.nonce ?? 0)) continue;
              delete w.pool[h];
              w.nonce[chain].pending--;
            }
            w.nonce[chain].latest++;
            w.receipts[hash] = { status: fate === "mine" ? "0x1" : "0x0", logs };
          }
          return hash;
        }
        case "eth_getTransactionReceipt": {
          const r = w.receipts[params[0] as string];
          return r ? { status: r.status, blockNumber: numberToHex(w.head[chain]), gasUsed: "0x30d40", effectiveGasPrice: numberToHex(10n ** 9n), logs: r.logs } : null;
        }
        case "eth_getTransactionByHash":
          if (w.txs[lower(params[0] as string)]) return { hash: params[0], nonce: "0x0", ...w.txs[lower(params[0] as string)] };
          if (w.pool[params[0] as string]) return w.pool[params[0] as string];
          return w.receipts[params[0] as string] ? { from: KEY.address, nonce: "0x0", blockNumber: "0x1" } : null;
      }
      throw new Error(`the fake v3.2 world has no ${method}`);
    },
  };
}

const KEEPER_FNS = (parseAbi([
  "function closeBatch(uint64 expectedId, uint256 minValue) payable",
  "function stakeIdle()",
  "struct Payout { address user; uint256 shares; uint256 assets; }",
  "function processPayouts(bytes32 key, Payout[] payouts, uint32 maxEntries) payable",
  "function deliver(address user, uint256 keeperMinOut) returns (uint256 received)",
  "function deliverParked(address recipient, address sender, bytes message)",
  "function refundParked(address recipient, address sender, bytes message) payable",
  "function dropParked(address recipient, address sender, bytes message)",
  "function execute(bytes encodedMessage, address[] ccvs, bytes[] verifierResults, uint32 gasLimitOverride)",
  "function claimRewards(bytes32 hotkey)",
  "function adoptStake()",
  "function addHotkey(bytes32 h)",
  "function removeHotkey(bytes32 h, bool forfeit)",
]) as Abi).filter((i): i is AbiFunction => i.type === "function");

/** The deployed OffRamp 2.0.0's errors a manual execution can meet (R3 W2-2's PoC; the verified OffRamp.sol:33-54), and
 * its committee verifier's (CommitteeVerifier.sol:25-26), for the world's OffRamp. */
const OFFRAMP_ERRS = parseAbi([
  "error NoStateProgressMade(bytes32 messageId, bytes err)",
  "error SkippedAlreadyExecutedMessage(bytes32 messageId, uint64 sourceChainSelector, uint64 messageNumber)",
  "error InvalidGasLimitOverride(uint32 messageGasLimit, uint32 gasLimitOverride)",
  "error RequiredCCVMissing(address requiredCCV)",
  "error OptionalCCVQuorumNotReached(uint256 wanted, uint256 got)",
  "error InvalidVerifierResultsLength(uint256 expected, uint256 got)",
  "error ReceiverError(bytes err)",
  "error TokenHandlingError(address target, bytes err)",
  "error InvalidVerifierResults()",
  "error InvalidCCVVersion(bytes4 verifierVersion)",
  // Task 65: what an empty or junk proof meets inside the deployed OffRamp (docs.chain.link manual execution, Phase B)
  "error InboundImplementationNotFound(address ccvAddress, bytes verifierResults)",
  "error WrongNumberOfSignatures()",
]);

/** The v3.2 deps over the world, for one round on `memory`: a fresh journal unless one is given (the Worker's lives in
 * its Durable Object, across rounds), and the rails as the world says (its monitor, its deliveries switch, ops/hold.json,
 * a hand run's override), unless `rails` says otherwise. */
export function depsFor(
  w: World,
  memory: KeeperMemory = freshMemory(),
  d: DeploymentV32 = deploymentFor(),
  log: (l: string) => void = () => undefined,
  o: { journal?: Journal & { rows: JournalRow[] }; rails?: Partial<RailsEnv>; logsWindow?: Partial<Record<"base" | "bittensor", bigint>>; executionInputs?: V32Env["executionInputs"] } = {},
) {
  const journal = o.journal ?? memoryJournal();
  const rails: RailsEnv = {
    monitor: monitorOf(w),
    deliveriesOn: w.deliveriesOn,
    holdFile: () => w.holdFile,
    override: w.override,
    ...o.rails,
  };
  const deps = depsV32({
    rpc: rpcOf(w),
    ...(o.logsWindow ? { logsWindow: o.logsWindow } : {}),
    deployment: d,
    signer: SIGNER,
    send: { chains: { base: { chainId: 8453, legacy: false }, bittensor: { chainId: 964, legacy: true } }, receiptTimeoutMs: 0, pollMs: 0, now: () => w.time.base * 1000, sleep: async () => undefined },
    journal,
    memory,
    rails,
    log,
    ...(o.executionInputs ? { executionInputs: o.executionInputs } : {}),
  });
  return { deps, journal, memory };
}

export const ABIS_FOR_TESTS: Abi = [...FNS];
