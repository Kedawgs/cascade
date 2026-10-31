import { type Abi, type Hex, keccak256, parseAbi, toBytes, toEventSelector } from "viem";
import type { Role } from "./config.ts";

// Events by contract role, as tagged v3.1 (contracts/src). A test checks each list against the
// sources both ways, so an event added to a contract can't go unrecognised here.

/** CascadeBase's events, and those it inherits from OpenZeppelin (Pausable, Ownable2Step): the vault
 * and the front door both emit them. */
export const BASE_ADMIN = parseAbi([
  "event GuardianSet(address indexed guardian)",
  "event GuardianProposed(address indexed guardian, uint64 readyAt)",
  "event GuardianProposalCancelled(address indexed guardian)",
  "event BridgeProposed(address indexed bridge, uint64 readyAt)",
  "event BridgeActivated(address indexed bridge)",
  "event BridgeProposalCancelled(address indexed bridge)",
  "event BridgeDisabled(address indexed bridge)",
  "event PrimaryBridgeSet(address indexed bridge)",
  "event Paused(address account)",
  "event Unpaused(address account)",
  "event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
]);

/** CascadeVault (Bittensor), with csTAO's ERC-20 Transfer (every mint and burn). */
export const VAULT = [
  ...parseAbi([
    "event StakeHotkeySet(bytes32 indexed hotkey)",
    "event HotkeyAdded(bytes32 indexed hotkey)",
    "event HotkeyRemoved(bytes32 indexed hotkey, uint256 unclaimed, bool forfeit)",
    "event StakeMoved(bytes32 indexed from, bytes32 indexed to, uint256 rao, uint256 moved)",
    "event Staked(bytes32 indexed hotkey, uint256 rao, uint256 measured)",
    "event Unstaked(bytes32 indexed hotkey, uint256 wantRao, uint256 receivedWei)",
    "event RewardsClaimed(bytes32 indexed hotkey, uint256 deltaRao)",
    "event RewardCutSet(address treasury, uint16 bps)",
    "event RewardCutMinted(address indexed treasury, uint256 assets, uint256 shares)",
    "event FrontDoorProposed(uint64 indexed chain, address indexed addr, uint64 readyAt)",
    "event FrontDoorActivated(uint64 indexed chain, address indexed addr)",
    "event FrontDoorProposalCancelled(uint64 indexed chain, address indexed addr)",
    "event FrontDoorRemoved(uint64 indexed chain, address indexed addr)",
    "event DepositedDirect(address indexed user, uint256 assets, uint256 shares)",
    "event RedeemedDirect(address indexed user, uint256 shares, uint256 assets)",
    "event FrontDoorRedeemsAllowed(address indexed user)",
    "event KeeperSet(address indexed keeper)",
    "event ClaimGasSet(uint256 claimGasRequired)",
    "event LimitSet(bytes32 indexed name, uint256 a, uint256 b)",
    "event BatchDelivered(bytes32 indexed key, uint64 indexed sourceChain, address indexed frontDoor, uint64 batchId, uint256 amount)",
    "event DepositSkipped(bytes32 indexed key, address user, uint256 assets)",
    "event Deposited(bytes32 indexed key, address indexed user, uint256 assets, uint256 shares)",
    "event DepositBounced(bytes32 indexed key, address indexed user, uint256 assets)",
    "event RedeemSkipped(bytes32 indexed key, address indexed user, uint256 requested)",
    "event RedeemDeferred(bytes32 indexed key, address indexed user, uint256 requested)",
    "event Redeemed(bytes32 indexed key, address indexed user, uint256 shares, uint256 assets)",
    "event PayoutBatchQueued(bytes32 indexed key, uint64 indexed sourceChain, uint64 batchId, uint32 count, uint256 total, uint256 price)",
    "event PayoutChunkSent(bytes32 indexed key, uint32 chunk, uint32 taken, uint256 gross, uint256 net, uint256 fee)",
    "event PayoutDust(bytes32 indexed key, address indexed user, uint256 assets)",
    "event RedeemReversed(bytes32 indexed key, address indexed user, uint256 shares, uint256 assets)",
    "event PayoutBatchCancelled(bytes32 indexed key, uint256 remaining)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ]),
  ...BASE_ADMIN,
] as const;

/** CascadeFrontDoor (Base). */
export const FRONT_DOOR = [
  ...parseAbi([
    "event DepositRequested(uint64 indexed batchId, address indexed user, uint256 amount, address payer)",
    "event DepositCancelled(uint64 indexed batchId, address indexed user, uint256 amount)",
    "event FeeCredited(address indexed user, uint256 amount, address payer)",
    "event FeeCreditSpent(address indexed user, uint256 amount)",
    "event RedeemRequested(uint64 indexed batchId, address indexed user, uint256 shares)",
    "event RedeemCancelled(uint64 indexed batchId, address indexed user, uint256 shares)",
    "event BatchClosed(uint64 indexed id, uint256 totalDeposits, uint256 nDeposits, uint256 nRedeems, uint256 fee, uint256 potUsed)",
    "event BatchRolled(uint64 indexed id)",
    "event LimitSet(bytes32 indexed name, uint256 a, uint256 b)",
    "event PayoutsDelivered(bytes32 indexed batchKey, uint32 chunk, uint256 amount, address bridge)",
    "event PayoutReceived(bytes32 indexed batchKey, uint32 chunk, address indexed user, uint256 amount)",
    "event Claimed(address indexed user, uint256 amount)",
    "event DeliverySet(address indexed user, uint128 minUsdcPerTao, uint64 deadline, uint32 destination)",
    "event Delivered(address indexed user, uint256 taoIn, uint256 usdcOut)",
    "event KeeperSet(address indexed keeper)",
    "event SwapperSet(address indexed swapper)",
    "event OracleSet(address indexed oracle)",
    "event MaxDeliverySlippageSet(uint16 bps)",
  ]),
  ...BASE_ADMIN,
] as const;

/** CascadeStaker (Base): Ownable2Step, not Pausable. `kind` is the RouterKind enum. */
export const STAKER = parseAbi([
  "event RouteSet(uint8 indexed id, uint8 kind, address router, bytes buyPath, bytes sellPath, bool active)",
  "event DeliveryRouteSet(uint8 indexed id)",
  "event FeesSet(uint16 swapFeeBps, uint256 depositFeeUsdc)",
  "event TreasurySet(address indexed treasury)",
  "event Swept(address indexed token, uint256 amount)",
  "event Staked(address indexed payer, address indexed beneficiary, uint256 usdcIn, uint256 fees, uint256 taoDeposited)",
  "event Sold(address indexed recipient, uint256 taoIn, uint256 usdcOut, uint256 fee)",
  "event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
]);

/** CcipAdapterBase: both adapters, immutable and ownerless. */
export const ADAPTER = parseAbi([
  "event Sent(bytes32 indexed messageId, uint64 destChain, address indexed sender, address indexed recipient, uint256 amount, uint256 fee, uint256 gasLimit)",
  "event Delivered(bytes32 indexed messageId, uint64 sourceChain, address indexed sender, address indexed recipient, uint256 amount)",
]);

/** The Bittensor adapter also takes top-ups of its native reserve. */
export const BIT_ADAPTER = [...ADAPTER, ...parseAbi(["event ReserveFunded(address indexed from, uint256 amount)"])] as const;

/** The admin events of ForeverMoney's contracts the rail runs on (config.ts watchFilters), the only events of theirs the
 * scan asks for. What each watched contract can really emit (read live on 2026-10-31; none of these was observed in a
 * log, the signatures are the libraries'):
 * - FM-TAO on Base: not Chainlink's BurnMintERC20, but it answers OpenZeppelin AccessControl's views (MINTER_ROLE,
 *   BURNER_ROLE, getRoleAdmin, hasRole: ForeverMoney's Safe holds the admin role) and getCCIPAdmin, so its RoleGranted,
 *   RoleRevoked and RoleAdminChanged are OpenZeppelin's; its CCIPAdminTransferred is Chainlink's signature, assumed.
 * - wTAO on Bittensor: not AccessControl (only getCCIPAdmin answers; the AlphaVault mints it), so the Role* topics
 *   watch nothing there; only a CCIPAdminTransferred with Chainlink's signature (assumed) could come from it. The real
 *   coverage of wTAO is the AlphaVault's events and the backing readings (fmtao.backing_true).
 * - the CCIP token pools: Chainlink TokenPool 1.5.1 ("BurnMintTokenPool 1.5.1" and "LockReleaseTokenPool 1.5.1"):
 *   ConfirmedOwner's two-step ownership, the rate-limit admin, each lane's buckets and remote pools, the router, the
 *   lock pool's liquidity.
 * - the AlphaVault: AccessControlDefaultAdminRules (defaultAdmin, pendingDefaultAdmin and a 2-day delay answer): its
 *   roles and its admin, which moves only after a scheduled delay.
 * One list for all of them: a log whose topic 0 is one of these is decoded the same whichever watched contract emitted
 * it. */
export const DEPENDENCY_EVENTS = parseAbi([
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)",
  "event CCIPAdminTransferred(address indexed previousAdmin, address indexed newAdmin)",
  "event DefaultAdminTransferScheduled(address indexed newAdmin, uint48 acceptSchedule)",
  "event DefaultAdminTransferCanceled()",
  "event DefaultAdminDelayChangeScheduled(uint48 newDelay, uint48 effectSchedule)",
  "event DefaultAdminDelayChangeCanceled()",
  "event OwnershipTransferRequested(address indexed from, address indexed to)",
  "event OwnershipTransferred(address indexed from, address indexed to)",
  "event RateLimitAdminSet(address rateLimitAdmin)",
  "event ChainAdded(uint64 remoteChainSelector, bytes remoteToken, (bool isEnabled, uint128 capacity, uint128 rate) outboundRateLimiterConfig, (bool isEnabled, uint128 capacity, uint128 rate) inboundRateLimiterConfig)",
  "event ChainConfigured(uint64 remoteChainSelector, (bool isEnabled, uint128 capacity, uint128 rate) outboundRateLimiterConfig, (bool isEnabled, uint128 capacity, uint128 rate) inboundRateLimiterConfig)",
  "event ChainRemoved(uint64 remoteChainSelector)",
  "event RemotePoolAdded(uint64 indexed remoteChainSelector, bytes remotePoolAddress)",
  "event RemotePoolRemoved(uint64 indexed remoteChainSelector, bytes remotePoolAddress)",
  "event RouterUpdated(address oldRouter, address newRouter)",
  "event AllowListAdd(address sender)",
  "event AllowListRemove(address sender)",
  "event LiquidityRemoved(address indexed provider, uint256 indexed amount)",
  "event LiquidityTransferred(address indexed from, uint256 amount)",
]);

/** Topic 0 of each watched admin event: the watched contracts' log filter. */
export const DEPENDENCY_TOPICS: readonly Hex[] = DEPENDENCY_EVENTS.map((e) => toEventSelector(e));

/** AccessControl's roles as FM-TAO names them: MINTER_ROLE is keccak256("MINTER_ROLE") (read live), the admin role 0. */
export const MINTER_ROLE = keccak256(toBytes("MINTER_ROLE"));
export const BURNER_ROLE = keccak256(toBytes("BURNER_ROLE"));
export const DEFAULT_ADMIN_ROLE = `0x${"00".repeat(32)}` as Hex;

/** CCIP's chain selectors of the lane Cascade uses (ops/src/config.ts LIVE). */
export const CCIP_SELECTOR = { base: 15_971_525_489_660_198_786n, bittensor: 2_135_107_236_357_186_872n } as const;

const BY_ROLE: Record<Role, Abi> = {
  vault: VAULT,
  frontDoor: FRONT_DOOR,
  staker: STAKER,
  baseAdapter: ADAPTER,
  bitAdapter: BIT_ADAPTER,
  fmTao: DEPENDENCY_EVENTS,
  tokenPool: DEPENDENCY_EVENTS,
  alphaVault: DEPENDENCY_EVENTS,
};

/** The events a scanned contract can emit. */
export const abiFor = (role: Role): Abi => BY_ROLE[role];

const BASE_ADMIN_NAMES = BASE_ADMIN.map((e) => e.name);

/** The admin events (spec Facts), keyed by role and name: any one after the deployment's baseline is
 * an `admin.event` critical. */
export const ADMIN_EVENTS: ReadonlySet<`${Role}:${string}`> = new Set([
  ...["LimitSet", "KeeperSet", "SwapperSet", "OracleSet", "MaxDeliverySlippageSet", ...BASE_ADMIN_NAMES].map((n) => `frontDoor:${n}` as const),
  ...[
    "StakeHotkeySet",
    "HotkeyAdded",
    "HotkeyRemoved",
    "RewardCutSet",
    "FrontDoorProposed",
    "FrontDoorActivated",
    "FrontDoorProposalCancelled",
    "FrontDoorRemoved",
    "KeeperSet",
    "ClaimGasSet",
    "LimitSet",
    "PayoutBatchCancelled",
    "RedeemReversed",
    ...BASE_ADMIN_NAMES,
  ].map((n) => `vault:${n}` as const),
  ...["RouteSet", "DeliveryRouteSet", "FeesSet", "TreasurySet", "Swept", "OwnershipTransferStarted", "OwnershipTransferred"].map((n) => `staker:${n}` as const),
]);

// Views of the deployment's contracts, as the readings use them (contracts/src, tagged v3.1).

/** Ownable2Step, Pausable and CascadeBase's guardian: the vault and front door have all, the staker the
 * first two (owner, pendingOwner). */
export const ADMIN_VIEWS = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function guardian() view returns (address)",
  "function pendingGuardian() view returns (address)",
  "function paused() view returns (bool)",
]);

export const VAULT_VIEWS = parseAbi([
  "struct PayoutBatch { uint64 sourceChain; address frontDoor; uint64 batchId; uint64 queuedAt; uint32 cursor; uint32 count; uint32 chunk; uint256 remaining; bytes32 payoutsHash; }",
  "function price() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function rootStakeRao() view returns (uint256)",
  "function pendingPayouts() view returns (uint256)",
  "function keeper() view returns (address)",
  "function stakeHotkey() view returns (bytes32)",
  "function hotkeys(uint256) view returns (bytes32)",
  "function payoutDelay() view returns (uint64)",
  "function maxDailyOutflowBps() view returns (uint256)",
  "function minDailyOutflow() view returns (uint256)",
  "function burnWindows(bytes32) view returns (uint64 start, uint256 burned)",
  "function lastClaimAt(bytes32) view returns (uint64)",
  "function minStakeRao() view returns (uint256)",
  "function rewardCutBps() view returns (uint16)",
  "function getPayoutBatch(bytes32 key) view returns (PayoutBatch)",
  "function claimGasRequired() view returns (uint256)",
  "function maxFeeBps() view returns (uint256)",
  "function maxMessageValue() view returns (uint256)",
  "function maxFeeAbs() view returns (uint256)",
  "function primaryBridge() view returns (address)",
]);

/** CcipAdapterBase's fee quote (the vault asks its primary bridge before each payout chunk). */
export const BRIDGE_VIEWS = parseAbi([
  "function quoteFee(uint64 destChain, address recipient, bytes message, uint256 amount) view returns (uint256)",
  // the most one message may carry (quoteFee and send revert MessageTooLarge above it)
  "function maxMessageValue() view returns (uint256)",
]);

export const FRONT_DOOR_VIEWS = parseAbi([
  "function openBatch() view returns (uint64 id, uint64 start, uint256 totalDeposits, uint256 feePot, uint256 nDeposits, uint256 nRedeems)",
  "function totalClaimable() view returns (uint256)",
  "function totalFeeCredit() view returns (uint256)",
  "function netForwarded() view returns (uint256)",
  "function depositCap() view returns (uint256)",
  "function maxBatchValue() view returns (uint256)",
  "function maxDeposits() view returns (uint32)",
  "function maxRedeems() view returns (uint32)",
  "function batchInterval() view returns (uint64)",
  "function keeper() view returns (address)",
  "function oracle() view returns (address)",
  "function claimable(address) view returns (uint256)",
  "function deliveryOf(address) view returns (uint128 minUsdcPerTao, uint64 deadline, uint32 destination)",
  "function delivered(address bridge, bytes32 messageHash) view returns (bool)",
]);

// Views of contracts the monitor reads but doesn't scan.

export const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export const UNISWAP_POOL = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

/** CascadeTwapOracle (the front door's oracle). */
export const ORACLE = parseAbi(["function usdcValue(uint256 taoWei) view returns (uint256)"]);

/** The CCIP OffRamp's execution state of a message (0 UNTOUCHED, 1 IN_PROGRESS, 2 SUCCESS, 3 FAILURE), as the keeper reads it. */
export const OFFRAMP = parseAbi(["function getExecutionState(bytes32 messageId) view returns (uint8)"]);
export const EXECUTION_STATES = ["UNTOUCHED", "IN_PROGRESS", "SUCCESS", "FAILURE"] as const;

/** ForeverMoney's AlphaVault, the rail TAO crosses on (each view answered live on 2026-10-31). */
export const ALPHA_VAULT = parseAbi([
  "function isPaused() view returns (bool)",
  "function migrationReadyAt() view returns (uint256)",
  "function migrationFinished() view returns (bool)",
  "function pausedUntil() view returns (uint256)",
  "function pauseableAfter() view returns (uint256)",
  "function migrationTarget() view returns (address)",
  "function migrationExecuted() view returns (bool)",
  "function pendingDefaultAdmin() view returns (address newAdmin, uint48 schedule)",
  "function backing(address token) view returns (uint256)",
]);

/** A Chainlink TokenPool 1.5.1's rate-limit buckets for a remote chain, refilled to now. */
export const TOKEN_POOL = parseAbi([
  "struct TokenBucket { uint128 tokens; uint32 lastUpdated; bool isEnabled; uint128 capacity; uint128 rate; }",
  "function getCurrentInboundRateLimiterState(uint64 remoteChainSelector) view returns (TokenBucket)",
  "function getCurrentOutboundRateLimiterState(uint64 remoteChainSelector) view returns (TokenBucket)",
]);

/** Bittensor's staking precompile (0x…0805), as contracts/src/interfaces/IStaking.sol declares it. */
export const STAKING = parseAbi([
  "function getStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid) view returns (uint256)",
  "function getUnclaimedRootTaoByHotkey(bytes32 coldkey, bytes32 hotkey) view returns (uint256)",
  "function getNominatorMinRequiredStake() view returns (uint256)",
]);

export const MULTICALL3 = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  "function getEthBalance(address addr) view returns (uint256 balance)",
  "function getBlockNumber() view returns (uint256 blockNumber)",
  "function getCurrentBlockTimestamp() view returns (uint256 timestamp)",
  "function getBasefee() view returns (uint256 basefee)",
]);

/** A Safe's nonce counts its executed transactions (an owner that is a Safe sends none of its own). */
export const SAFE = parseAbi(["function nonce() view returns (uint256)"]);

/** The staker's and the vault's treasury (fees, the reward cut): a role wallet keys.delegated watches. */
export const TREASURY = parseAbi(["function treasury() view returns (address)"]);
