import { parseAbi } from "viem";
import { type Deployment, isV32 } from "./config";

/** The parts of each contract the site calls or reads (signatures from contracts/src). */
export const FRONT_DOOR = parseAbi([
  "function deposit(uint256 amount)",
  "function cancelDeposit(uint256 amount)",
  "function requestRedeem(uint256 shares) payable",
  "function cancelRedeem(uint256 shares)",
  "function claim()",
  "function depositOf(address user) view returns (uint256)",
  "function redeemOf(address user) view returns (uint256)",
  "function claimable(address user) view returns (uint256)",
  "function openBatch() view returns (uint64 id, uint64 start, uint256 totalDeposits, uint256 feePot, uint256 nDeposits, uint256 nRedeems)",
  "function netForwarded() view returns (uint256)",
  "function depositCap() view returns (uint256)",
  "function minDeposit() view returns (uint256)",
  "function redeemRequestFee() view returns (uint256)",
  "function canClose() view returns (bool)",
  "function batchInterval() view returns (uint64)",
  "function maxBatchValue() view returns (uint256)",
  "function maxDeposits() view returns (uint32)",
  "function usdc() view returns (address)",
  "function deliveryOf(address user) view returns (uint128 minUsdcPerTao, uint64 deadline, uint32 destination)",
  "function setDelivery(uint128 minUsdcPerTao, uint64 deadline, uint32 destination)",
  "function requestRedeemWithDelivery(uint256 shares, uint128 minUsdcPerTao, uint64 deadline, uint32 destination) payable",
  "function maxDeliverySlippageBps() view returns (uint16)",
  // Send it now: anyone may send the open batch once it can close, paying its bridge fee (the pot first,
  // the rest refunded to the sender)
  "function closeBatch() payable",
  "function openDeposits() view returns ((address user, uint256 amount)[])",
  "function openRedeems() view returns ((address user, uint256 amount)[])",
  "function paused() view returns (bool)",
  "event BatchClosed(uint64 indexed id, uint256 totalDeposits, uint256 nDeposits, uint256 nRedeems, uint256 fee, uint256 potUsed)",
  "event BatchRolled(uint64 indexed id)",
  // what closeBatch can revert with, so the pre-send check can say why (EnforcedPause is OpenZeppelin's
  // Pausable; TransferFailed is the refund to a sender that can't take ETH)
  "error BatchNotReady()",
  "error InsufficientFee()",
  "error EnforcedPause()",
  "error PrimaryBridgeDisabled()",
  "error TransferFailed()",
  // how it is wired, read before anything is sent (wiring.ts); oracle and swapper are v3 only
  "function asset() view returns (address)",
  "function vault() view returns (address)",
  "function vaultChain() view returns (uint64)",
  "function primaryBridge() view returns (address)",
  "function bridgeEnabled(address bridge) view returns (bool)",
  "function oracle() view returns (address)",
  "function swapper() view returns (address)",
  "event DepositRequested(uint64 indexed batchId, address indexed user, uint256 amount, address payer)",
  "event RedeemRequested(uint64 indexed batchId, address indexed user, uint256 shares)",
  "event DepositCancelled(uint64 indexed batchId, address indexed user, uint256 amount)",
  "event RedeemCancelled(uint64 indexed batchId, address indexed user, uint256 shares)",
  "event Claimed(address indexed user, uint256 amount)",
  "event Delivered(address indexed user, uint256 taoIn, uint256 usdcOut)",
  "event PayoutReceived(bytes32 indexed batchKey, uint32 chunk, address indexed user, uint256 amount)",
]);

export const STAKER = parseAbi([
  "function stake(address beneficiary, uint256 usdcIn, uint256 minTaoOut, uint8 routeId, uint256 deadline) returns (uint256)",
  "function stakeWithPermit(address beneficiary, uint256 usdcIn, uint256 minTaoOut, uint8 routeId, uint256 deadline, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s) returns (uint256)",
  "function swapFeeBps() view returns (uint16)",
  "function depositFeeUsdc() view returns (uint256)",
  "function frontDoor() view returns (address)",
  "function usdc() view returns (address)",
  "function tao() view returns (address)",
  "event Staked(address indexed payer, address indexed beneficiary, uint256 usdcIn, uint256 fees, uint256 taoDeposited)",
  // what a stake can revert with, so a pre-send check can say why: the staker's own errors, and the
  // front door's that its depositFor passes back (EnforcedPause is OpenZeppelin's Pausable)
  "error Expired()",
  "error BadBeneficiary()",
  "error RouteInactive()",
  "error AmountTooSmall()",
  "error InsufficientOutput()",
  "error SwapIncomplete()",
  "error ZeroAmount()",
  "error NotRaoAligned()",
  "error BelowMinDeposit()",
  "error CapExceeded()",
  "error BatchValueFull()",
  "error BatchFull()",
  "error EnforcedPause()",
]);

export const VAULT = parseAbi([
  "function paused() view returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function rootStakeRao() view returns (uint256)",
  "function pendingPayouts() view returns (uint256)",
  "function stakeHotkey() view returns (bytes32)",
  "function payoutDelay() view returns (uint64)",
  "function rewardCutBps() view returns (uint16)",
  "function maxEntryValue() view returns (uint256)",
  "function coldkey() view returns (bytes32)",
  "function frontDoorActive(bytes32 peer) view returns (bool)",
  "function primaryBridge() view returns (address)",
  "function bridgeEnabled(address bridge) view returns (bool)",
  "event BatchDelivered(bytes32 indexed key, uint64 indexed sourceChain, address indexed frontDoor, uint64 batchId, uint256 amount)",
  "event Deposited(bytes32 indexed key, address indexed user, uint256 assets, uint256 shares)",
  "event DepositBounced(bytes32 indexed key, address indexed user, uint256 assets)",
  "event DepositSkipped(bytes32 indexed key, address user, uint256 assets)",
  "event Redeemed(bytes32 indexed key, address indexed user, uint256 shares, uint256 assets)",
  "event RedeemSkipped(bytes32 indexed key, address indexed user, uint256 requested)",
  "event RedeemDeferred(bytes32 indexed key, address indexed user, uint256 requested)",
  "event Staked(bytes32 indexed hotkey, uint256 rao, uint256 measured)",
  "event PayoutChunkSent(bytes32 indexed key, uint32 chunk, uint32 taken, uint256 gross, uint256 net, uint256 fee)",
  "event PayoutDust(bytes32 indexed key, address indexed user, uint256 assets)",
  // the other ways an account's shares move: a deposit or redeem made on Bittensor directly, a payout
  // batch cancelled by the owner (shares re-minted), and the reward cut minted to the treasury
  "event DepositedDirect(address indexed user, uint256 assets, uint256 shares)",
  "event RedeemedDirect(address indexed user, uint256 shares, uint256 assets)",
  "event RedeemReversed(bytes32 indexed key, address indexed user, uint256 shares, uint256 assets)",
  "event RewardCutMinted(address indexed treasury, uint256 assets, uint256 shares)",
]);

export const STAKING = parseAbi([
  "function getNominatorMinRequiredStake() view returns (uint256)",
  "function getUnclaimedRootTaoByHotkey(bytes32 coldkey, bytes32 hotkey) view returns (uint256)",
]);
export const STAKING_ADDRESS = "0x0000000000000000000000000000000000000805" as const;

export const ADAPTER = parseAbi([
  "function quoteFee(uint64 destChain, address recipient, bytes message, uint256 amount) view returns (uint256)",
  "function token() view returns (address)",
  "function remoteAdapter() view returns (address)",
  "function remoteChainId() view returns (uint64)",
  "event Sent(bytes32 indexed messageId, uint64 destChain, address indexed sender, address indexed recipient, uint256 amount, uint256 fee, uint256 gasLimit)",
  "event Delivered(bytes32 indexed messageId, uint64 sourceChain, address indexed sender, address indexed recipient, uint256 amount)",
]);

/** Multicall3's own clock: asked in a batch read, it gives the timestamp of the block the read came from. */
export const MULTICALL3_ABI = parseAbi([
  "function getCurrentBlockTimestamp() view returns (uint256 timestamp)",
  "function getBlockNumber() view returns (uint256 blockNumber)",
  "function getEthBalance(address addr) view returns (uint256 balance)",
]);

/** ForeverMoney's AlphaVault on Bittensor, which the Bittensor adapter deposits a batch's TAO into: the
 * reads the keeper takes for "can a batch be sent" (ops/src/keeper/state.ts, ops/src/preflight.ts). */
export const ALPHA_VAULT_ABI = parseAbi([
  "function isPaused() view returns (bool)",
  "function migrationReadyAt() view returns (uint256)",
  "function migrationFinished() view returns (bool)",
]);

/** The front door's TWAP oracle: what `taoWei` is worth in USDC units, the keeper's TAO price. */
export const TWAP_ORACLE = parseAbi(["function usdcValue(uint256 taoWei) view returns (uint256)"]);

export const OFFRAMP_ABI = parseAbi(["function getExecutionState(bytes32 messageId) view returns (uint8)"]);

/** QuoterV2's quote functions are not marked view (they revert internally), but eth_call answers them. */
export const QUOTER = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) view returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
  "function quoteExactOutput(bytes path, uint256 amountOut) view returns (uint256 amountIn, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);

export const ROUTER = parseAbi([
  "struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }",
  "struct ExactOutputParams { bytes path; address recipient; uint256 amountOut; uint256 amountInMaximum; }",
  "function exactInput(ExactInputParams params) payable returns (uint256 amountOut)",
  "function exactOutput(ExactOutputParams params) payable returns (uint256 amountIn)",
]);

export const ERC20 = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function nonces(address owner) view returns (uint256)",
  // EIP-2612: only ever simulated, to tell a permit USDC refuses from a stake that can't go through
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);

// ---- v3.2 ----
// What changed (spec §7, "Website changes"; §8.1): most getters moved off the vault and the front door to two
// read-only lenses; events and errors are file-level (contracts/src/CascadeEvents.sol, CascadeErrors.sol), merged
// into the published vault ABI (contracts/abi/CascadeVault.json); closeBatch takes the batch's id and a minimum
// value. abi-sources.test.ts holds each list below to the contracts' own ABIs, and v3-launch's above to the build it
// was deployed from (ops/builds/preaudit): those stay exactly as they are while v3-launch is live.

/** v3.2's front door: the calls and reads above, with Send it now by the batch's id (`closeBatch(expectedId,
 * minValue)`, refusing `WrongBatch(openId)` once that batch has left and `BatchTooSmall()` when its deposits total
 * less than `minValue`) and a seven-field BatchClosed (`potCarried`, the pot's remainder rolled into the next batch).
 * Its pause stops only deposits and deliveries, never a close (spec §3.5, I-20); `primaryBridge` and
 * `bridgeEnabled` are the door lens's now. */
export const FRONT_DOOR_V32 = parseAbi([
  "function deposit(uint256 amount)",
  "function cancelDeposit(uint256 amount)",
  "function requestRedeem(uint256 shares) payable",
  "function cancelRedeem(uint256 shares)",
  "function claim()",
  "function depositOf(address user) view returns (uint256)",
  "function redeemOf(address user) view returns (uint256)",
  "function claimable(address user) view returns (uint256)",
  "function openBatch() view returns (uint64 id, uint64 start, uint256 totalDeposits, uint256 feePot, uint256 nDeposits, uint256 nRedeems)",
  "function netForwarded() view returns (uint256)",
  "function depositCap() view returns (uint256)",
  "function minDeposit() view returns (uint256)",
  "function redeemRequestFee() view returns (uint256)",
  "function canClose() view returns (bool)",
  "function batchInterval() view returns (uint64)",
  "function maxBatchValue() view returns (uint256)",
  "function maxDeposits() view returns (uint32)",
  // the redeem list's limit: a request that finds it full closes the batch first, on its pot alone (ChatGPT r3, §2)
  "function maxRedeems() view returns (uint32)",
  // R11, the cancel cooldown: a cancel works from cancelableAt(user), CANCEL_COOLDOWN (five minutes) after the user's
  // last deposit, anyone's depositFor to it included; before then cancelDeposit reverts CancelTooSoon(cancelableAt), its
  // argument read by position. 0 means no wait (build B: the door paused, or its primary bridge disabled)
  "function cancelableAt(address user) view returns (uint256)",
  "function CANCEL_COOLDOWN() view returns (uint64)",
  "error CancelTooSoon(uint256 cancelableAt)",
  // what else a cancel can refuse, so its pre-send check can say why: more than the entry holds, or a partial cancel
  // that would leave less than the minimum deposit
  "error InsufficientRequest()",
  "error BelowMinDeposit()",
  "function usdc() view returns (address)",
  "function deliveryOf(address user) view returns (uint128 minUsdcPerTao, uint64 deadline, uint32 destination)",
  "function setDelivery(uint128 minUsdcPerTao, uint64 deadline, uint32 destination)",
  "function requestRedeemWithDelivery(uint256 shares, uint128 minUsdcPerTao, uint64 deadline, uint32 destination) payable",
  "function maxDeliverySlippageBps() view returns (uint16)",
  // the pools' depth floors on a delivery (spec §3.7): [0] TAO/WETH, [1] WETH/USDC, against the oracle's meanLiquidity
  "function minPoolLiquidity(uint256 index) view returns (uint128)",
  "function closeBatch(uint64 expectedId, uint256 minValue) payable",
  "function openDeposits() view returns ((address user, uint256 amount)[])",
  "function openRedeems() view returns ((address user, uint256 amount)[])",
  "function paused() view returns (bool)",
  "event BatchClosed(uint64 indexed id, uint256 totalDeposits, uint256 nDeposits, uint256 nRedeems, uint256 fee, uint256 potUsed, uint256 potCarried)",
  "event BatchRolled(uint64 indexed id)",
  // what closeBatch can revert with, so the pre-send check can say why
  "error WrongBatch(uint64 openId)",
  "error BatchNotReady()",
  "error BatchTooSmall()",
  "error InsufficientFee()",
  "error PrimaryBridgeDisabled()",
  "error TransferFailed()",
  "error EnforcedPause()",
  // how it is wired, read before anything is sent (wiring.ts)
  "function asset() view returns (address)",
  "function vault() view returns (address)",
  "function vaultChain() view returns (uint64)",
  "function oracle() view returns (address)",
  "function swapper() view returns (address)",
  "event DepositRequested(uint64 indexed batchId, address indexed user, uint256 amount, address payer)",
  "event RedeemRequested(uint64 indexed batchId, address indexed user, uint256 shares)",
  "event DepositCancelled(uint64 indexed batchId, address indexed user, uint256 amount)",
  "event RedeemCancelled(uint64 indexed batchId, address indexed user, uint256 shares)",
  "event Claimed(address indexed user, uint256 amount)",
  "event Delivered(address indexed user, uint256 taoIn, uint256 usdcOut)",
  "event PayoutReceived(bytes32 indexed batchKey, uint32 chunk, address indexed user, uint256 amount)",
]);

/** v3.2's cancel cooldown in seconds (CascadeFrontDoor.CANCEL_COOLDOWN, R11): a cancel works five minutes after the
 * account's last deposit to the open batch. abi-sources.test.ts holds it to the source. */
export const CANCEL_COOLDOWN_S = 5 * 60;

/** v3.2's staker: the same calls, and its buy floor's refusals (spec §3.7): `BelowOracleFloor()`, a stake's TAO
 * under 95% of the oracle's 30-minute value of the USDC swapped, and `NoOracle()`, a front door without one. And the
 * route a delivery sells along, `routes[deliveryRouteId]` (sellFor's), which the live USDC delivery limit quotes as the
 * keeper does (reads.ts readDeliveryMarket; Task 59a review, M2). */
export const STAKER_V32 = [
  ...STAKER,
  ...parseAbi([
    "error BelowOracleFloor()",
    "error NoOracle()",
    "function deliveryRouteId() view returns (uint8)",
    "function routes(uint8) view returns (uint8 kind, address router, bytes buyPath, bytes sellPath, bool active)",
  ]),
] as const;

/** v3.2's vault itself: the share token (balanceOf, totalSupply), `paused`, the direct exit and the origin
 * setter (spec §7; the site never offers `redeemDirect`'s opt-in: flows.ts, redeemDirectCall), and the events the
 * site reads, as the published ABI has them: Task 36b's eight-field PayoutChunkSent (`charged`, `unstakeCost`), a
 * bounce's `reason` (CascadeTypes.BounceReason), a direct exit's `acceptedMissing`, and the scheduler's. Every
 * other getter is the vault lens's. */
export const VAULT_V32 = parseAbi([
  "function paused() view returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function launchChain() view returns (uint64)",
  "function redeemDirect(uint256 shares, bool acceptMissing)",
  "function setRedeemOrigin(uint64 chain)",
  "event BatchDelivered(bytes32 indexed key, uint64 indexed sourceChain, address indexed frontDoor, uint64 batchId, uint256 amount)",
  "event Deposited(bytes32 indexed key, address indexed user, uint256 assets, uint256 shares)",
  "event DepositBounced(bytes32 indexed key, address indexed user, uint256 assets, uint8 reason)",
  "event DepositSkipped(bytes32 indexed key, address user, uint256 assets)",
  "event Redeemed(bytes32 indexed key, address indexed user, uint256 shares, uint256 assets)",
  "event RedeemSkipped(bytes32 indexed key, address indexed user, uint256 requested)",
  "event RedeemDeferred(bytes32 indexed key, address indexed user, uint256 requested)",
  "event Staked(bytes32 indexed hotkey, uint256 rao, uint256 measured)",
  "event PayoutChunkSent(bytes32 indexed key, uint32 chunk, uint32 taken, uint256 gross, uint256 net, uint256 fee, uint256 charged, uint256 unstakeCost)",
  "event PayoutDust(bytes32 indexed key, address indexed user, uint256 assets)",
  "event PayoutBatchCancelled(bytes32 indexed key, uint256 reminted, uint32 bouncesCarried)",
  "event DepositedDirect(address indexed user, uint256 assets, uint256 shares)",
  "event RedeemedDirect(address indexed user, uint256 shares, uint256 assets, bool acceptedMissing)",
  "event RedeemReversed(bytes32 indexed key, address indexed user, uint256 shares, uint256 assets)",
  "event RedeemOriginSet(address indexed user, uint64 chain)",
  "event RewardCutMinted(address indexed treasury, uint256 assets, uint256 shares)",
  "event ShortfallAbsorbed(uint256 amount)",
  "event Scheduled(bytes32 indexed id, uint8 kind, bytes4 indexed selector, uint64 readyAt, bytes data)",
  "event Executed(bytes32 indexed id)",
  "event Cancelled(bytes32 indexed id, address indexed by)",
  "event Lapsed(bytes32 indexed id)",
  // what a direct exit can revert with, so a pre-send check can say why (direct-exit.ts): stake missing, a pause
  // (OpenZeppelin's Pausable), a stake its own cost leaves nothing, a walk that can't reach the stake, shares no longer
  // there, a payment the address can't take
  "error StakeMissing()",
  "error ExitsNotOpen()",
  "error ZeroAmount()",
  "error EnforcedPause()",
  "error UnstakeShort()",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error TransferFailed()",
  // Revision 28's gas guard: the walk's capped read of the chain's minimum stake given less than its whole 100,000 gas
  "error InsufficientGas()",
  // setRedeemOrigin to a chain with no active front door
  "error UnknownOrigin()",
]);

/** CascadeVaultLens: the vault's getters v3.2 moved off it (spec §8.1), read through the vault's single-slot
 * extsload, and its derived figures (totalAssets, the priced stake). `target` is the vault it reads (wiring.ts
 * checks it). The ledger is in rao: `visibleStakeRao` (the stake the chain shows on the listed hotkeys) and
 * `bookedStake` (the vault's own book); the vault prices the smaller. The vesting figures are the lens's, never
 * rebuilt from events (they log nothing). `doorState(peer)` is 0 unknown, 1 active, 2 removed. */
export const VAULT_LENS = parseAbi([
  "function target() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function grossAssets() view returns (uint256)",
  "function visibleStakeRao() view returns (uint256 total)",
  "function bookedStake() view returns (uint256)",
  "function pendingPayouts() view returns (uint256)",
  "function stakeHotkey() view returns (bytes32)",
  // every listed hotkey, the stake hotkey and a standby (MAX_HOTKEYS = 4): each holds stake and earns
  "function hotkeyCount() view returns (uint256)",
  "function hotkeys(uint256 i) view returns (bytes32)",
  "function stakeMissing() view returns (bool)",
  "function payoutDelay() view returns (uint64)",
  "function rewardCutBps() view returns (uint16)",
  "function maxEntryValue() view returns (uint256)",
  "function coldkey() view returns (bytes32)",
  "function doorState(bytes32 peer) view returns (uint8)",
  "function primaryBridge() view returns (address)",
  "function bridgeEnabled(address bridge) view returns (bool)",
  "function redeemOrigin(address user) view returns (uint64)",
  // the active front doors on a chain: only a chain with one can be named a redeem origin (setRedeemOrigin, UnknownOrigin)
  "function activeDoors(uint64 chain) view returns (uint256)",
  "function exitsOpen() view returns (bool)",
  "function rewardVesting() view returns (uint64)",
  "function vestingAmount() view returns (uint256)",
  "function vestingStart() view returns (uint64)",
  "function vestingPeriod() view returns (uint64)",
  // the adoption drip (Revision 27): an adopted gift vests on its own drip beside the claim schedule above
  "function adoptVestingAmount() view returns (uint256)",
  "function adoptVestingStart() view returns (uint64)",
  "function adoptVestingPeriod() view returns (uint64)",
  // both drips' sum
  "function unvestedRewards() view returns (uint256)",
  // R4 (exit-hold.ts): a holder's fresh shares (the one-day hold), the share price, and the daily allowance's inputs
  "function freshShares(address user) view returns (uint64 since, uint128 shares)",
  "function price() view returns (uint256)",
  "function rampingStake() view returns (uint256)",
  "function lastStakeAt() view returns (uint64)",
  "function maxDailyOutflowBps() view returns (uint256)",
  "function globalOutflowBps() view returns (uint256)",
  "function minDailyOutflow() view returns (uint256)",
  "function burnWindows(bytes32 peer) view returns (uint64 start, uint256 burned)",
  // the caller's gas rule for a direct exit (direct-exit.ts exitGasFloor, review M-6): each removal's least gas and what
  // the walk leaves for the exit's work after it
  "function unstakeGas() view returns (uint256)",
  "function EXIT_GAS_RESERVE() view returns (uint256)",
]);

/** CascadeDoorLens: the front door's bridge getters, moved off it (spec §8.1). `target` is the front door it reads. */
export const DOOR_LENS = parseAbi([
  "function target() view returns (address)",
  "function primaryBridge() view returns (address)",
  "function bridgeEnabled(address bridge) view returns (bool)",
]);

/** v3.2's Bittensor adapter parks a batch the vault refused instead of bouncing it (spec §3.2): what the trail
 * reads of a park. */
export const BIT_ADAPTER_V32 = parseAbi([
  "function parked(bytes32 key) view returns (uint128 amount, uint64 parkedAt, bool converted)",
  // the AlphaVault it converts through (immutable): Bittensor's side is read there for the rail now primary (R4-O round 3)
  "function alphaVault() view returns (address)",
  "function parkedNative() view returns (uint256)",
  "function parkedTokens() view returns (uint256)",
  // R4 (S-H1): whether it can send payouts now; the vault defers every front-door redeem while its primary's reads false
  "function canSendPayouts() view returns (bool)",
  "event BatchParked(bytes32 indexed key, bytes32 indexed messageId, address recipient, address sender, uint256 amount, bool converted, bytes4 reason)",
  "event ParkedConverted(bytes32 indexed key)",
  "event ParkedDelivered(bytes32 indexed key)",
  "event ParkedRefunded(bytes32 indexed key, bytes32 indexed messageId)",
  "event ParkedDropped(bytes32 indexed key)",
]);
/** The chunk number a refund payout carries: a parked deposit sent back to Base (CcipBittensorAdapter.REFUND_CHUNK). */
export const REFUND_CHUNK = 2 ** 32 - 1;
/** How long a park waits before it can be refunded to its door, or dropped when empty (CcipBittensorAdapter.PARK_TIMEOUT). */
export const PARK_TIMEOUT_S = 14 * 24 * 60 * 60;
/** A deposit bounce's reason (CascadeTypes.BounceReason): the address's redeem origin is another chain's (spec §3.4). */
export const BOUNCE_FOREIGN_ORIGIN = 1;
/** The redeem origin of an address that withdraws on Bittensor itself, never through a door (CascadeConstants.DIRECT_ORIGIN). */
export const DIRECT_ORIGIN = 2n ** 64n - 1n;
/** The chain id of Base, the front door's chain: the redeem origin a Base door burns for (spec §3.4, I-16). */
export const BASE_CHAIN = 8453n;

/** v3.2's TWAP oracle: v3-launch's TAO price, and its pools' 30-minute harmonic-mean in-range liquidity (spec §3.7),
 * which the front door's `deliver` holds against `minPoolLiquidity` (ThinPool). */
export const ORACLE_V32 = parseAbi([
  "function usdcValue(uint256 taoWei) view returns (uint256)",
  "function meanLiquidity() view returns (uint128 taoWeth, uint128 wethUsdc)",
]);

/** The front door's and the staker's ABIs for deployment `d`: v3.2's for a v3.2 deployment, else v3-launch's,
 * exactly as they were. */
export const frontDoorAbi = (d: Deployment) => (isV32(d) ? FRONT_DOOR_V32 : FRONT_DOOR);
export const stakerAbi = (d: Deployment) => (isV32(d) ? STAKER_V32 : STAKER);
/** The vault events of deployment `d`, to decode its logs with: v3.2's (eight-field PayoutChunkSent, a bounce's
 * reason, a direct exit's acceptedMissing, and the events only v3.2 has: new topics) on v3.2, else v3-launch's. Typed
 * as either list, each as itself (Task 58 review, Minor 2): a reader that needs one of v3.2's own events or fields
 * reads `VAULT_V32` on a v3.2 deployment; one by name reads either, since each of v3-launch's events is in v3.2's
 * with every field under the same name, only more after them (abi-sources.test.ts). */
export const vaultEventsAbi = (d: Deployment): typeof VAULT | typeof VAULT_V32 => (isV32(d) ? VAULT_V32 : VAULT);
