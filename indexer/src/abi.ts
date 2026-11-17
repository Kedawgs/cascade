import { type Abi, type AbiFunction, type Hex, keccak256, parseAbi, toBytes, toEventSelector, toFunctionSelector } from "viem";
import type { Role, Version } from "./config.ts";

// Events by contract role, as tagged v3.1 (the live v3-launch and v3-test: ops/builds/preaudit/src), then v3.2's
// beside them (contracts/: the published vault ABI and the build output). A deployment's DEPLOYMENT.version picks one
// set. Tests check each list against its sources both ways, so an event added to a contract can't go unrecognised.

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

// v3.2's events, as contracts/abi/CascadeVault.json (the vault merged with its libraries' events, which they emit at
// the vault's address) and contracts/out publish them; the enums Kind and BounceReason are uint8 there. A test pins
// each list equal to its ABI's, both ways.

/** CascadeBase's events in v3.2 (contracts/src/CascadeEvents.sol): the scheduler, the exits machine and the owner's
 * stamp; no proposals any more. With OpenZeppelin's Pausable and Ownable2Step. The vault and the front door emit them. */
export const BASE_ADMIN_V32 = parseAbi([
  "event GuardianSet(address indexed guardian)",
  "event BridgeActivated(address indexed bridge)",
  "event BridgeDisabled(address indexed bridge)",
  "event PrimaryBridgeSet(address indexed bridge)",
  "event Scheduled(bytes32 indexed id, uint8 kind, bytes4 indexed selector, uint64 readyAt, bytes data)",
  "event Executed(bytes32 indexed id)",
  "event Cancelled(bytes32 indexed id, address indexed by)",
  "event Lapsed(bytes32 indexed id)",
  "event ExitsClosed(address indexed by, bytes4 indexed instrument)",
  "event ExitsReopened(bytes4 indexed instrument)",
  "event StampedBySig(uint64 asOf, address indexed relayer)",
  "event Paused(address account)",
  "event Unpaused(address account)",
  "event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
]);

/** CascadeVault in v3.2, its share token's Transfer and its libraries' events included (contracts/abi/CascadeVault.json). */
export const VAULT_V32 = [
  ...parseAbi([
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "event StakeHotkeySet(bytes32 indexed hotkey)",
    "event HotkeyAdded(bytes32 indexed hotkey)",
    "event HotkeyRemoved(bytes32 indexed hotkey, uint256 unclaimed, bool forfeit)",
    "event StakeMoved(bytes32 indexed from, bytes32 indexed to, uint256 rao, uint256 moved)",
    "event Staked(bytes32 indexed hotkey, uint256 rao, uint256 measured)",
    "event StakeAdopted(uint256 rao)",
    "event StakeWrittenOff(uint256 rao)",
    "event Unstaked(bytes32 indexed hotkey, uint256 wantRao, uint256 receivedWei)",
    "event UnstakeSkipped(bytes32 indexed hotkey)",
    "event RewardsClaimed(bytes32 indexed hotkey, uint256 deltaRao)",
    "event RewardCutSet(address treasury, uint16 bps)",
    "event RewardCutMinted(address indexed treasury, uint256 assets, uint256 shares)",
    "event FrontDoorActivated(uint64 indexed chain, address indexed addr)",
    "event FrontDoorRemoved(uint64 indexed chain, address indexed addr)",
    "event DepositedDirect(address indexed user, uint256 assets, uint256 shares)",
    "event RedeemedDirect(address indexed user, uint256 shares, uint256 assets, bool acceptedMissing)",
    "event ShortfallAbsorbed(uint256 amount)",
    "event RedeemOriginSet(address indexed user, uint64 chain)",
    "event KeeperSet(address indexed keeper)",
    "event ClaimGasSet(uint256 claimGasRequired)",
    "event LimitSet(bytes4 indexed selector, uint256 a, uint256 b)",
    "event OutflowLimitsSet(uint256 bps, uint256 minDaily, uint256 globalBps)",
    "event BatchDelivered(bytes32 indexed key, uint64 indexed sourceChain, address indexed frontDoor, uint64 batchId, uint256 amount)",
    "event DepositSkipped(bytes32 indexed key, address user, uint256 assets)",
    "event Deposited(bytes32 indexed key, address indexed user, uint256 assets, uint256 shares)",
    "event DepositBounced(bytes32 indexed key, address indexed user, uint256 assets, uint8 reason)",
    "event RedeemSkipped(bytes32 indexed key, address indexed user, uint256 requested)",
    // nothing burned, for one of four causes it doesn't name (R4 added the first two): the one-day hold on fresh shares
    // (B-H1), the primary bridge unable to send payouts (S-H1), the day's allowance or the entry limit spent, or under
    // MIN_REDEEM_VALUE (rules/r4.ts deferralWhy tells them apart where that is cheap)
    "event RedeemDeferred(bytes32 indexed key, address indexed user, uint256 requested)",
    "event Redeemed(bytes32 indexed key, address indexed user, uint256 shares, uint256 assets)",
    "event PayoutBatchQueued(bytes32 indexed key, uint64 indexed sourceChain, uint64 batchId, uint32 count, uint256 total, uint256 price)",
    "event PayoutChunkSent(bytes32 indexed key, uint32 chunk, uint32 taken, uint256 gross, uint256 net, uint256 fee, uint256 charged, uint256 unstakeCost)",
    "event PayoutDust(bytes32 indexed key, address indexed user, uint256 assets)",
    "event RedeemReversed(bytes32 indexed key, address indexed user, uint256 shares, uint256 assets)",
    "event PayoutBatchCancelled(bytes32 indexed key, uint256 reminted, uint32 bouncesCarried)",
  ]),
  ...BASE_ADMIN_V32,
] as const;

/** CascadeFrontDoor in v3.2 (contracts/out): BatchClosed gains potCarried, PotSwept is new; its LimitSet still names
 * its setter in a bytes32. */
export const FRONT_DOOR_V32 = [
  ...parseAbi([
    "event DepositRequested(uint64 indexed batchId, address indexed user, uint256 amount, address payer)",
    "event DepositCancelled(uint64 indexed batchId, address indexed user, uint256 amount)",
    "event FeeCredited(address indexed user, uint256 amount, address payer)",
    "event FeeCreditSpent(address indexed user, uint256 amount)",
    "event RedeemRequested(uint64 indexed batchId, address indexed user, uint256 shares)",
    "event RedeemCancelled(uint64 indexed batchId, address indexed user, uint256 shares)",
    "event BatchClosed(uint64 indexed id, uint256 totalDeposits, uint256 nDeposits, uint256 nRedeems, uint256 fee, uint256 potUsed, uint256 potCarried)",
    "event BatchRolled(uint64 indexed id)",
    "event PotSwept(uint256 amount)",
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
  ...BASE_ADMIN_V32,
] as const;

/** CcipAdapterBase in v3.2: both adapters sweep a surplus to their treasury. */
export const ADAPTER_V32 = [...ADAPTER, ...parseAbi(["event SurplusSwept(uint256 native, uint256 tokens)"])] as const;

/** CcipBittensorAdapter in v3.2: a delivery the vault refuses is parked, then delivered, converted, refunded or dropped;
 * the token cushion covers a short conversion. */
export const BIT_ADAPTER_V32 = [
  ...ADAPTER_V32,
  ...parseAbi([
    "event ReserveFunded(address indexed from, uint256 amount)",
    "event CushionFunded(address indexed from, uint256 amount)",
    "event BatchParked(bytes32 indexed key, bytes32 indexed messageId, address recipient, address sender, uint256 amount, bool converted, bytes4 reason)",
    "event ParkedDelivered(bytes32 indexed key)",
    "event ParkedConverted(bytes32 indexed key)",
    "event ParkedRefunded(bytes32 indexed key, bytes32 indexed messageId)",
    "event ParkedDropped(bytes32 indexed key)",
    "event ShortfallCovered(uint256 amount)",
  ]),
] as const;

/** The admin events of ForeverMoney's contracts the rail runs on (config.ts watchFilters), the only events of theirs the
 * scan asks for. What each watched contract can really emit (read live on 2026-10-31; none of these was observed in a
 * log, the signatures are the libraries'):
 * - FM-TAO on Base: Chainlink's BurnMintERC20 (its verified source, read 2026-11-05 for R3: OpenZeppelin 4.8.3 ERC20,
 *   ERC20Burnable and AccessControl, not a proxy), so its RoleGranted, RoleRevoked and RoleAdminChanged are
 *   OpenZeppelin's (MINTER_ROLE and BURNER_ROLE held by the pool; ForeverMoney's Safe holds the admin role) and its
 *   CCIPAdminTransferred is Chainlink's own signature, as watched.
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

const BY_ROLE: Record<Version, Record<Role, Abi>> = {
  "v3.1": {
    vault: VAULT,
    frontDoor: FRONT_DOOR,
    staker: STAKER,
    baseAdapter: ADAPTER,
    bitAdapter: BIT_ADAPTER,
    fmTao: DEPENDENCY_EVENTS,
    tokenPool: DEPENDENCY_EVENTS,
    alphaVault: DEPENDENCY_EVENTS,
  },
  "v3.2": {
    vault: VAULT_V32,
    frontDoor: FRONT_DOOR_V32,
    // the staker's events are v3.1's (a test pins them against contracts/out)
    staker: STAKER,
    baseAdapter: ADAPTER_V32,
    bitAdapter: BIT_ADAPTER_V32,
    fmTao: DEPENDENCY_EVENTS,
    tokenPool: DEPENDENCY_EVENTS,
    alphaVault: DEPENDENCY_EVENTS,
  },
};

/** The events a scanned contract can emit, in the deployment's contracts version (v3.1 when not given: the live
 * v3-launch). */
export const abiFor = (role: Role, version: Version = "v3.1"): Abi => BY_ROLE[version][role];

/** The v3.2 vault's owner setters that log LimitSet, keyed by the selector LimitSet's topic carries (CascadeVault.sol
 * emits `LimitSet(this.<setter>.selector, a, b)`; setMessageLimits logs two, (maxEntryValue, maxMessageValue) then
 * (minChunk, 0)). The signatures are the published ABI's (a test pins them, and that every LimitSet emit is here);
 * viem works out the selectors. setOutflowLimits logs OutflowLimitsSet instead. */
const LIMIT_SETTER_FNS = parseAbi([
  "function setMinDirectDeposit(uint256 amount)",
  "function setMaxTotalAssets(uint256 amount)",
  "function setMessageLimits(uint256 maxEntryValue_, uint256 maxMessageValue_, uint32 minChunk_)",
  "function setFeeLimits(uint256 bps, uint256 abs_)",
  "function setPayoutDelay(uint64 delay)",
  "function setRewardVesting(uint64 period)",
  "function setHotkeyDustRao(uint256 rao)",
  "function setUnstakeMarginRao(uint256 rao)",
  "function setUnstakeGas(uint256 gas)",
  "function setIdleBuffer(uint256 bps)",
]);
export const LIMIT_SETTERS: ReadonlyMap<Hex, string> = new Map(LIMIT_SETTER_FNS.map((f) => [toFunctionSelector(f), f.name]));

/** The setter a v3.2 vault LimitSet names by its selector (the decoded `selector` arg, or its 32-byte topic); undefined
 * for a selector this list doesn't know. */
export const limitSetterOf = (selector: string): string | undefined => LIMIT_SETTERS.get(selector.slice(0, 10).toLowerCase() as Hex);

const BASE_ADMIN_NAMES = BASE_ADMIN.map((e) => e.name);

/** v3-launch's admin events (spec Facts), keyed by role and name, as v3.1 has them. */
export const ADMIN_EVENTS_V31: ReadonlySet<`${Role}:${string}`> = new Set([
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

/** The scheduler's own events: each has a rule of its own (admin.scheduled, admin.executed, admin.cancelled,
 * admin.lapsed), so admin.event leaves them alone. */
export const SCHEDULER_EVENTS = ["Scheduled", "Executed", "Cancelled", "Lapsed"] as const;

/** v3.2's admin events beside v3-launch's: the scheduler's, the exits machine's and the owner's stamp on the vault and
 * the front door, the vault's outflow limits (setOutflowLimits logs OutflowLimitsSet, not LimitSet) and its write-off,
 * and the front door's pot sweep (the owner's). The routine ones are not: StakeAdopted (the keeper's adoptStake) is
 * vault.stake_adopted's warning, and SurplusSwept (anyone's sweep, to the fixed treasury) the daily digest's; both are
 * attributable (attribute.ts), so their transactions are explained. */
const ADMIN_EVENTS_V32_ONLY: readonly `${Role}:${string}`[] = [
  ...[...SCHEDULER_EVENTS, "StampedBySig", "ExitsClosed", "ExitsReopened"].flatMap((n) => [`vault:${n}`, `frontDoor:${n}`] as const),
  "vault:OutflowLimitsSet",
  "vault:StakeWrittenOff",
  "frontDoor:PotSwept",
];

/** The admin events (spec Facts), keyed by role and name, of either version: a deployment decodes only its own
 * version's events, so v3-launch's are matched exactly as before. Any one after the deployment's baseline is an
 * `admin.event` critical (v3.2's scheduler events have rules of their own); their transactions are fetched
 * (attribute.ts), so an admin key's transactions are explained. */
export const ADMIN_EVENTS: ReadonlySet<`${Role}:${string}`> = new Set([...ADMIN_EVENTS_V31, ...ADMIN_EVENTS_V32_ONLY]);

// v3.2's scheduler (spec §3.6): the setters schedule(data) accepts, by contract, as each _classify names them (a test
// pins each list to the sources' _classify and the published ABIs' signatures). Scheduled carries the item's calldata;
// these decode it.

const BASE_SCHEDULABLE = ["function setGuardian(address newGuardian)", "function transferOwnership(address newOwner)", "function activateBridge(address bridge)"] as const;

/** The setters each v3.2 contract schedules: the vault's and the front door's own, then CascadeBase's. */
export const SCHEDULABLE: Readonly<Record<"vault" | "frontDoor", readonly AbiFunction[]>> = {
  vault: parseAbi([
    "function activateFrontDoor(uint64 chain, address addr)",
    "function writeOffMissingStake(uint256 rao)",
    "function setStakeHotkey(bytes32 h)",
    "function setMaxTotalAssets(uint256 amount)",
    "function setPayoutDelay(uint64 delay)",
    "function setRewardVesting(uint64 period)",
    "function setIdleBuffer(uint256 bps)",
    "function setFeeLimits(uint256 bps, uint256 abs_)",
    "function setRewardCut(address treasury_, uint16 bps)",
    "function moveStake(bytes32 from, bytes32 to, uint256 rao)",
    "function setMessageLimits(uint256 maxEntryValue_, uint256 maxMessageValue_, uint32 minChunk_)",
    "function setOutflowLimits(uint256 bps, uint256 minDaily, uint256 globalBps)",
    ...BASE_SCHEDULABLE,
  ]),
  frontDoor: parseAbi([
    "function setOracle(address newOracle)",
    "function setSwapper(address newSwapper)",
    "function setMaxDeliverySlippage(uint16 bps)",
    "function setBatchInterval(uint64 interval)",
    "function setMaxBatchValue(uint256 value)",
    "function setMinPoolLiquidity(uint8 index, uint128 value)",
    ...BASE_SCHEDULABLE,
  ]),
};

const SCHEDULABLE_BY_SELECTOR = {
  vault: new Map(SCHEDULABLE.vault.map((f) => [toFunctionSelector(f), f])),
  frontDoor: new Map(SCHEDULABLE.frontDoor.map((f) => [toFunctionSelector(f), f])),
} as Record<"vault" | "frontDoor", ReadonlyMap<Hex, AbiFunction>>;

/** The setter a v3.2 contract schedules under `selector` (a Scheduled's indexed selector, or its calldata's first
 * four bytes); undefined for any other. */
export const schedulableOf = (role: "vault" | "frontDoor", selector: string): AbiFunction | undefined => SCHEDULABLE_BY_SELECTOR[role].get(selector.slice(0, 10).toLowerCase() as Hex);

/** The instruments ExitsClosed and ExitsReopened name by selector (spec §3.6's table): the closers pause,
 * disableBridge (of the primary), removeFrontDoor (of the launch chain's last door) and cancelPayoutBatch, and what
 * reopens: unpause, activateFrontDoor, activateBridge, setPrimaryBridge and setGuardian (over a guardian's hold). A test
 * pins the list to every selector the sources emit them with. */
export const INSTRUMENTS: ReadonlyMap<Hex, string> = new Map(
  [
    "pause()",
    "disableBridge(address)",
    "removeFrontDoor(uint64,address)",
    "cancelPayoutBatch(bytes32,(address,uint256,uint256)[])",
    "unpause()",
    "activateFrontDoor(uint64,address)",
    "activateBridge(address)",
    "setPrimaryBridge(address)",
    "setGuardian(address)",
  ].map((sig) => [toFunctionSelector(sig), sig.slice(0, sig.indexOf("("))]),
);

/** An instrument's name from the selector an exits event carries (the decoded bytes4, or its 32-byte topic). */
export const instrumentOf = (selector: string): string | undefined => INSTRUMENTS.get(selector.slice(0, 10).toLowerCase() as Hex);

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
  // R6b (U4): batch.deposits_blocked judges by the door's own canClose(), never a copy of its rule (its room rule)
  "function canClose() view returns (bool)",
  "function keeper() view returns (address)",
  "function oracle() view returns (address)",
  "function claimable(address) view returns (uint256)",
  "function deliveryOf(address) view returns (uint128 minUsdcPerTao, uint64 deadline, uint32 destination)",
  "function delivered(address bridge, bytes32 messageHash) view returns (bool)",
  // R12a: batch.redeem_fee_thin compares a full redeem list's fees with a full batch's close quote
  "function redeemRequestFee() view returns (uint256)",
]);

// v3.2's views (spec §8.1): the vault keeps the token, ownership and pause surface and launchChain; every other getter
// moved to CascadeVaultLens, and CascadeBase's to the door lens on Base, both read through the target's extsload. A
// test pins each view here equal to its contract's in contracts/out (or the published vault ABI).

/** What the v3.2 vault still answers itself. */
export const VAULT_V32_VIEWS = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function paused() view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function launchChain() view returns (uint64)",
]);

/** CascadeTypes.sol's Item: a scheduled owner change (class: Delay; kind: Kind). */
const ITEM = "struct Item { uint64 scheduledAt; uint64 readyAt; uint8 class; uint8 kind; bytes4 selector; uint64 readyBlock; }";

/** CascadeVaultLens: v3.1's vault views the readings use (rootStakeRao is visibleStakeRao, in rao), the ledger, the
 * two vesting drips (the claim schedule and the adoption drip), the global window, the doors, the exits machine (holds, who closed, the clocks) and the
 * scheduler. */
export const VAULT_LENS_VIEWS = parseAbi([
  "struct PayoutBatch { uint64 sourceChain; address frontDoor; uint64 batchId; uint64 queuedAt; uint32 cursor; uint32 count; uint32 chunk; uint256 remaining; bytes32 payoutsHash; }",
  ITEM,
  "function target() view returns (address)",
  "function price() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function grossAssets() view returns (uint256)",
  "function visibleStakeRao() view returns (uint256 total)",
  "function bookedStake() view returns (uint256)",
  "function rampingStake() view returns (uint256)",
  "function lastStakeAt() view returns (uint64)",
  "function missingStakeRao() view returns (uint256)",
  "function surplusStakeRao() view returns (uint256)",
  "function unlistedStakeRao() view returns (uint256)",
  "function stakeMissing() view returns (bool)",
  "function pendingPayouts() view returns (uint256)",
  "function unvestedRewards() view returns (uint256)",
  "function vestingAmount() view returns (uint256)",
  "function vestingStart() view returns (uint64)",
  "function vestingPeriod() view returns (uint64)",
  // the adoption drip (Revision 27), beside the claim schedule above: unvestedRewards is both drips' sum
  "function adoptVestingAmount() view returns (uint256)",
  "function adoptVestingStart() view returns (uint64)",
  "function adoptVestingPeriod() view returns (uint64)",
  "function rewardVesting() view returns (uint64)",
  "function lastAdoptAt() view returns (uint64)",
  "function idleBufferBps() view returns (uint16)",
  "function keeper() view returns (address)",
  "function guardian() view returns (address)",
  "function treasury() view returns (address)",
  "function stakeHotkey() view returns (bytes32)",
  "function hotkeys(uint256 i) view returns (bytes32)",
  "function payoutDelay() view returns (uint64)",
  "function maxDailyOutflowBps() view returns (uint256)",
  "function minDailyOutflow() view returns (uint256)",
  "function globalOutflowBps() view returns (uint256)",
  "function burnWindows(bytes32 peer) view returns (uint64 start, uint256 burned)",
  "function lastClaimAt(bytes32 h) view returns (uint64)",
  "function minStakeRao() view returns (uint256)",
  "function rewardCutBps() view returns (uint16)",
  "function getPayoutBatch(bytes32 key) view returns (PayoutBatch b)",
  "function claimGasRequired() view returns (uint256)",
  "function maxFeeBps() view returns (uint256)",
  "function maxMessageValue() view returns (uint256)",
  "function maxFeeAbs() view returns (uint256)",
  "function primaryBridge() view returns (address)",
  // a bridge the vault takes messages from (its inbound check), and one it ever enabled (rails.incoherent)
  "function bridgeEnabled(address bridge) view returns (bool)",
  "function bridgeKnown(address bridge) view returns (bool)",
  "function activeDoors(uint64 chain) view returns (uint256)",
  "function doorState(bytes32 peer) view returns (uint8)",
  "function exitsOpen() view returns (bool)",
  "function ownerHold() view returns (bool)",
  "function guardianHold() view returns (bool)",
  "function pausedBy() view returns (uint8)",
  "function primaryDisabledBy() view returns (uint8)",
  "function launchDoorRemovedBy() view returns (uint8)",
  "function lastOwnerClose() view returns (uint64)",
  "function lastGuardianClose() view returns (uint64)",
  "function pendingSince() view returns (uint64)",
  "function scheduled(bytes32 id) view returns (Item item)",
  // the vault's block time as the deploy calibrated it, in ms (Revision 28): an item's window in blocks is counted in it
  "function MS_PER_BLOCK() view returns (uint64)",
  // the limits a scheduled setter's direction is judged against, beside those read above, and the dust allowance a
  // keeper's or guardian's hotkey removal reads
  "function maxEntryValue() view returns (uint256)",
  "function minChunk() view returns (uint32)",
  "function maxTotalAssets() view returns (uint256)",
  "function hotkeyDustRao() view returns (uint256)",
]);

/** CascadeDoorLens: the front door's CascadeBase state (no pausedBy or launch-door hold there). */
export const DOOR_LENS_VIEWS = parseAbi([
  ITEM,
  "function target() view returns (address)",
  "function guardian() view returns (address)",
  "function keeper() view returns (address)",
  "function primaryBridge() view returns (address)",
  // a bridge the front door has enabled, and one it ever enabled: its inbound check takes any of those (H-2 i)
  "function bridgeEnabled(address bridge) view returns (bool)",
  "function bridgeKnown(address bridge) view returns (bool)",
  "function exitsOpen() view returns (bool)",
  "function ownerHold() view returns (bool)",
  "function guardianHold() view returns (bool)",
  "function primaryDisabledBy() view returns (uint8)",
  "function lastOwnerClose() view returns (uint64)",
  "function lastGuardianClose() view returns (uint64)",
  "function pendingSince() view returns (uint64)",
  "function scheduled(bytes32 id) view returns (Item item)",
  // the front door's block time as the deploy calibrated it, in ms (Revision 28): an item's window in blocks is counted in it
  "function MS_PER_BLOCK() view returns (uint64)",
]);

/** CascadeFrontDoor in v3.2: v3.1's views the readings use, ownership and pause, the carried pot, the minimum deposit
 * and the two pool floors deliveries check (minPoolLiquidity(0): TAO/WETH, (1): WETH/USDC). */
export const FRONT_DOOR_V32_VIEWS = [
  ...FRONT_DOOR_VIEWS,
  ...parseAbi([
    "function owner() view returns (address)",
    "function pendingOwner() view returns (address)",
    "function paused() view returns (bool)",
    "function potCarried() view returns (uint256)",
    "function minDeposit() view returns (uint256)",
    "function minPoolLiquidity(uint256) view returns (uint128)",
    "function maxDeliverySlippageBps() view returns (uint16)",
  ]),
] as const;

/** CcipBittensorAdapter in v3.2: the park totals, the reserve and cushion targets, and the token cushion booked (R4,
 * F-1: what fundCushion brought in, less the shortfalls it covered; a plain transfer is surplus, never cushion). Its
 * native balance and wTAO are read beside them. */
export const BIT_ADAPTER_V32_VIEWS = parseAbi([
  "function parkedNative() view returns (uint256)",
  "function parkedTokens() view returns (uint256)",
  "function RESERVE_TARGET() view returns (uint256)",
  "function TOKEN_RESERVE_TARGET() view returns (uint256)",
  "function tokenCushion() view returns (uint256)",
]);

/** Both v3.2 adapters' immutables that make a rail (rails.incoherent): the adapter on the other chain it sends to and
 * alone takes messages from, and that chain's EVM id (it sends only there, and names it as each message's source). */
export const ADAPTER_PEER_VIEWS = parseAbi([
  "function remoteAdapter() view returns (address)",
  "function remoteChainId() view returns (uint64)",
  // R4-O's fix round (Minor 8, C-L4's parity with ops' rail check): what a bridge must share with the deploy's adapter
  "function router() view returns (address)",
  "function token() view returns (address)",
  "function remoteSelector() view returns (uint64)",
]);
/** A Bittensor adapter as a rail half: ADAPTER_PEER_VIEWS, the AlphaVault that converts its tokens (R4-O, Minor 8), and
 * whether it can send payouts now (R4, S-H1: canSendPayouts(), the view the vault reads on its primary bridge before it
 * burns a front-door redeem; false while ForeverMoney's AlphaVault is paused, has a migration announced or finished, or
 * a read of it fails; it never reverts). */
export const BIT_RAIL_VIEWS = [...ADAPTER_PEER_VIEWS, ...parseAbi(["function alphaVault() view returns (address)", "function canSendPayouts() view returns (bool)"])];

/** CascadeTwapOracle in v3.2: its pools' mean liquidity over the TWAP window, and the cardinality its constructor
 * required. */
export const ORACLE_V32 = parseAbi([
  "function usdcValue(uint256 taoWei) view returns (uint256 usdcUnits)",
  "function meanLiquidity() view returns (uint128 taoWeth, uint128 wethUsdc)",
  "function MIN_CARDINALITY() view returns (uint16)",
]);

// v3.2's constants no ABI exposes (each an internal or file-level constant). The Worker can't read contracts/src, so
// each is written once here, and test/node/abi-sources.test.ts reads it back from the source and fails on any
// difference.

/** CascadeVault.sol STAKE_RAMP: stake a stakeIdle adds enters the outflow allowance's base linearly over this long
 * from lastStakeAt (and adoptStake waits as long between adoptions). */
export const STAKE_RAMP_S = 86_400;

/** CascadeConstants.sol UNDERWATER_TOLERANCE (1,000 rao, in wei): with nothing vesting, CascadeFormulas.underwater
 * counts only a shortfall of the gross against the queued payouts beyond it (a rounding of the chain's at a supply
 * of 0). */
export const UNDERWATER_TOLERANCE_WEI = 1_000n * 10n ** 9n;

/** CascadeVault.sol's half-launch-price line (depositDirect's `assetsBefore * 2_000_000 < supply`, a delivery's
 * `insolvent: A * 2_000_000 < S`): a share is minted at 1e-6 TAO at launch (CascadeMath's 1e6 virtual shares a wei), so
 * below half of that every deposit is refused. Pinned to the source by test/node/abi-sources.test.ts. */
export const HALF_LAUNCH_SHARES_PER_WEI = 2_000_000n;

/** CascadeConstants.sol EXECUTE_WINDOW (7 days): a scheduled item may run from its readyAt until this long after, and
 * until half of it in its chain's calibrated blocks after its readyBlock: it lapses (anyone may prune it) only once both
 * have passed (CascadeBase._lapsed, Revision 28; src/scheduler.ts lapsedAt). */
export const EXECUTE_WINDOW_S = 7 * 86_400;

/** CascadeConstants.sol MAX_HOTKEYS: the most hotkeys the vault lists. */
export const MAX_HOTKEYS = 4;

// Views of contracts the monitor reads but doesn't scan.

export const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

/** Uniswap v3 QuoterV2. quoteExactInput isn't a view in Solidity (it runs the swap and reverts to read it), but
 * it answers under eth_call, so it is declared view here to read it through Multicall3. */
export const QUOTER_V2 = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) view returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
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

/** A Chainlink TokenPool 1.5.1's rate-limit buckets for a remote chain, refilled to now, and whether the pool still lists
 * that chain (a lane removed with ChainRemoved reads false, and its buckets all zeros and off, like a limiter switched off). */
export const TOKEN_POOL = parseAbi([
  "struct TokenBucket { uint128 tokens; uint32 lastUpdated; bool isEnabled; uint128 capacity; uint128 rate; }",
  "function getCurrentInboundRateLimiterState(uint64 remoteChainSelector) view returns (TokenBucket)",
  "function getCurrentOutboundRateLimiterState(uint64 remoteChainSelector) view returns (TokenBucket)",
  "function isSupportedChain(uint64 remoteChainSelector) view returns (bool)",
]);

/** LockReleaseTokenPool 1.5.1's rebalancer: the one account whose withdrawLiquidity takes the locked wTAO; its owner (ForeverMoney's
 * Safe) sets it with setRebalancer, which logs nothing (R3 FM-L2: 0 on 2026-11-05). */
export const LOCK_POOL = parseAbi(["function getRebalancer() view returns (address)"]);

/** Chainlink's TokenAdminRegistry 1.5.0 (Base 0x6f6C…1e37, Bittensor 0xe72d…8Be6; R3 FM-L2, read 2026-11-05): a token's
 * administrator, the administrator proposed (0: none) and the pool every CCIP message carrying it is released or minted
 * through (the OffRamp reads it at execution). The administrator sets the pool (setPool) and moves itself
 * (transferAdminRole, then acceptAdminRole), each at once. */
export const TOKEN_ADMIN_REGISTRY = parseAbi([
  "struct TokenConfig { address administrator; address pendingAdministrator; address tokenPool; }",
  "function getTokenConfig(address token) view returns (TokenConfig)",
]);

/** Bittensor's staking precompile (0x…0805), as contracts/src/interfaces/IStaking.sol declares it. */
export const STAKING = parseAbi([
  "function getStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid) view returns (uint256)",
  "function getUnclaimedRootTaoByHotkey(bytes32 coldkey, bytes32 hotkey) view returns (uint256)",
  "function getNominatorMinRequiredStake() view returns (uint256)",
  // R6 (claim C): the vault's write-off reads it capped (WRITE_OFF_READ_GAS); the monitor prices it (eth_estimateGas)
  "function getTotalColdkeyStakeOnSubnet(bytes32 coldkey, uint256 netuid) view returns (uint256)",
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

/** A Safe's signing set (Safe 1.3 and 1.4's OwnerManager): how many of its owners must sign, and who they are. */
export const SAFE_OWNERS = parseAbi(["function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"]);

/** The staker's and the vault's treasury (fees, the reward cut): a role wallet keys.delegated watches. */
export const TREASURY = parseAbi(["function treasury() view returns (address)"]);
