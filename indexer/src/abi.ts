import { type Abi, parseAbi } from "viem";
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

const BY_ROLE: Record<Role, Abi> = {
  vault: VAULT,
  frontDoor: FRONT_DOOR,
  staker: STAKER,
  baseAdapter: ADAPTER,
  bitAdapter: BIT_ADAPTER,
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

/** ForeverMoney's AlphaVault, the rail TAO crosses on. */
export const ALPHA_VAULT = parseAbi([
  "function isPaused() view returns (bool)",
  "function migrationReadyAt() view returns (uint256)",
  "function migrationFinished() view returns (bool)",
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
]);

/** A Safe's nonce counts its executed transactions (an owner that is a Safe sends none of its own). */
export const SAFE = parseAbi(["function nonce() view returns (uint256)"]);

/** The staker's and the vault's treasury (fees, the reward cut): a role wallet keys.delegated watches. */
export const TREASURY = parseAbi(["function treasury() view returns (address)"]);
