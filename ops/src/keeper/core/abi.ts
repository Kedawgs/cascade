import { type Abi, parseAbi } from "viem";
import vaultAbi from "../../../../contracts/abi/CascadeVault.json" with { type: "json" };

// v3.2's ABIs, as the keeper core bundles them (design-keeper-worker.md §1; no file is read at run time):
// - the vault's: the published ABI, contracts/abi/CascadeVault.json, the vault artifact's merged with its libraries'
//   events and errors (DepositBounced, Redeemed, PayoutChunkSent, PayoutBatchCancelled, … come from the vault's address
//   but are declared in L1 and L3). Every vault event and revert the keeper decodes, it decodes with this.
// - what the keeper reads and calls of the lenses, the front door, the adapters, the staker and the oracle: the
//   fragments below, each held to the build (contracts/out) by test/keeper-v32-abi.test.ts, through Task 43a's helpers
//   (routeOf: each getter on the contract that serves it, the vault or its lens, the door or its lens; shapeOf: the
//   same types), so a getter that moves or changes type fails a test, never a round.

/** The published vault ABI (contracts/abi/CascadeVault.json). */
export const VAULT_ABI_V32 = vaultAbi as unknown as Abi;

/** What the keeper reads of the vault itself: the getters it kept (spec §8.1). */
export const VAULT_KEPT = parseAbi([
  "function paused() view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function launchChain() view returns (uint64)",
  "function MS_PER_BLOCK() view returns (uint64)",
]);

/** What the keeper reads of the vault through its lens (CascadeVaultLens). */
export const VAULT_LENS = parseAbi([
  // R4 (C-L2): whether a park's Bittensor adapter is enabled on the vault (the vault takes a batch only from one enabled)
  "function bridgeEnabled(address bridge) view returns (bool)",
  // R4 (the vault-favour review's Medium 1): the period claimed rewards vest over, held to the claim policy's longest gap
  "function rewardVesting() view returns (uint64)",
  // a front door's state on the vault, by its peer id (DoorState: 0 Unknown, 1 Active, 2 Removed; Task 52w: no close
  // while the launch door's isn't Active)
  "function doorState(bytes32 peer) view returns (uint8)",
  "struct PayoutBatch { uint64 sourceChain; address frontDoor; uint64 batchId; uint64 queuedAt; uint32 cursor; uint32 count; uint32 chunk; uint256 remaining; bytes32 payoutsHash; }",
  "function getPayoutBatch(bytes32 key) view returns (PayoutBatch)",
  "function pendingPayouts() view returns (uint256)",
  "function payoutDelay() view returns (uint64)",
  "function visibleStakeRao() view returns (uint256)",
  "function bookedStake() view returns (uint256)",
  "function minStakeRao() view returns (uint256)",
  "function minRemainRao() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function grossAssets() view returns (uint256)",
  "function unvestedRewards() view returns (uint256)",
  "function stakeMissing() view returns (bool)",
  "function stakeHotkey() view returns (bytes32)",
  "function hotkeyCount() view returns (uint256)",
  // the claim job (Task 51): the list in the vault's order (reverts past its end), the surplus and the last adoption
  "function hotkeys(uint256 i) view returns (bytes32)",
  "function surplusStakeRao() view returns (uint256)",
  // the hotkey watch (Task 53): the booked stake the list doesn't show (a swap's), and the vault's root stake off the list
  // (reverts when the staking precompile can't total it)
  "function missingStakeRao() view returns (uint256)",
  "function unlistedStakeRao() view returns (uint256)",
  "function lastAdoptAt() view returns (uint64)",
  "function lastClaimAt(bytes32 hotkey) view returns (uint64)",
  "function lastStakeAt() view returns (uint64)",
  "function claimGasRequired() view returns (uint256)",
  // R6b (U1, U2): the claim schedule, which the claim round comes before the end of (core/rewards.ts claimFor)
  "function vestingStart() view returns (uint64)",
  "function vestingPeriod() view returns (uint64)",
  "function vestingAmount() view returns (uint256)",
  // R6b (U9): the dust allowance a removal's deferred rewards are held to (v32/deferred.ts)
  "function hotkeyDustRao() view returns (uint256)",
  "function keeper() view returns (address)",
  "function primaryBridge() view returns (address)",
  "function maxFeeBps() view returns (uint256)",
  "function maxFeeAbs() view returns (uint256)",
  "function minChunk() view returns (uint32)",
  "function maxMessageValue() view returns (uint256)",
  "function unstakeGas() view returns (uint256)",
  "function idleBufferBps() view returns (uint16)",
  "function minDailyOutflow() view returns (uint256)",
  "function coldkey() view returns (bytes32)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function STAMP_TYPEHASH() view returns (bytes32)",
  "function EXIT_GAS_RESERVE() view returns (uint256)",
  "function FALLBACK_MIN_STAKE_RAO() view returns (uint256)",
  "function FALLBACK_MIN_REMAIN_RAO() view returns (uint256)",
  "function MIN_CLAIM_GAS() view returns (uint256)",
]);

/** What the keeper reads of the front door itself (its own getters, kept). */
export const DOOR = parseAbi([
  "struct Entry { address user; uint256 amount; }",
  "function openBatch() view returns (uint64 id, uint64 start, uint256 totalDeposits, uint256 feePot, uint256 nDeposits, uint256 nRedeems)",
  "function openDeposits() view returns (Entry[])",
  "function openRedeems() view returns (Entry[])",
  "function canClose() view returns (bool)",
  "function paused() view returns (bool)",
  "function claimable(address user) view returns (uint256)",
  "function depositCap() view returns (uint256)",
  // R6b (U4): what the deposit cap counts, for the room rule once a batch's interval has passed
  "function netForwarded() view returns (uint256)",
  "function batchInterval() view returns (uint64)",
  "function maxDeposits() view returns (uint32)",
  "function maxRedeems() view returns (uint32)",
  "function maxBatchValue() view returns (uint256)",
  "function minDeposit() view returns (uint256)",
  // R11, the cancel cooldown (no round reads them; listed with the door so a hand read or a replay is named): a
  // depositor's cancel works from cancelableAt(user), CANCEL_COOLDOWN (five minutes) after its last deposit
  "function cancelableAt(address user) view returns (uint256)",
  "function CANCEL_COOLDOWN() view returns (uint64)",
  "function keeper() view returns (address)",
  "function oracle() view returns (address)",
  "function swapper() view returns (address)",
  "function vault() view returns (address)",
  "function vaultChain() view returns (uint64)",
  "function treasury() view returns (address)",
  "function asset() view returns (address)",
  "function usdc() view returns (address)",
  "function MS_PER_BLOCK() view returns (uint64)",
  // USDC delivery (Task 50a): each user's preference, the TWAP's slippage allowance, the pools' depth floors
  "function deliveryOf(address user) view returns (uint128 minUsdcPerTao, uint64 deadline, uint32 destination)",
  "function maxDeliverySlippageBps() view returns (uint16)",
  "function minPoolLiquidity(uint256 index) view returns (uint128)",
  "event DepositRequested(uint64 indexed batchId, address indexed user, uint256 amount, address payer)",
  // R12h: a deposit cancelled from the open batch; a close the chain reverted with no reason its replay can read reads them
  // from the read it was sent on through the block it was mined in (v32/actions.ts minedClose)
  "event DepositCancelled(uint64 indexed batchId, address indexed user, uint256 amount)",
  "event BatchClosed(uint64 indexed id, uint256 totalDeposits, uint256 nDeposits, uint256 nRedeems, uint256 fee, uint256 potUsed, uint256 potCarried)",
  "event BatchRolled(uint64 indexed id)",
  // a delivery's candidates (Task 50a): credited, less delivered or claimed, with a live preference
  "event PayoutReceived(bytes32 indexed batchKey, uint32 chunk, address indexed user, uint256 amount)",
  "event Delivered(address indexed user, uint256 taoIn, uint256 usdcOut)",
  "event Claimed(address indexed user, uint256 amount)",
  "event DeliverySet(address indexed user, uint128 minUsdcPerTao, uint64 deadline, uint32 destination)",
]);

/** What the keeper reads of the front door through its lens (CascadeDoorLens): CascadeBase's views (the door kept its
 * keeper, which the keeper reads from the door). */
export const DOOR_LENS = parseAbi([
  "function primaryBridge() view returns (address)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function STAMP_TYPEHASH() view returns (bytes32)",
]);

/** The keeper's calls (v3.2's entry points): close by id, stake, pay out with a top-up, deliver, claim a hotkey's rewards,
 * adopt the surplus. */
export const KEEPER_CALLS_V32 = parseAbi([
  "function closeBatch(uint64 expectedId, uint256 minValue) payable",
  "function deliver(address user, uint256 keeperMinOut) returns (uint256 received)",
  "function stakeIdle()",
  "struct Payout { address user; uint256 shares; uint256 assets; }",
  "function processPayouts(bytes32 key, Payout[] payouts, uint32 maxEntries) payable",
  "function claimRewards(bytes32 hotkey)",
  "function adoptStake()",
  // the hotkey watch and its hand commands (Task 53): list a hotkey; remove an empty non-stake one (the keeper's path: no
  // stake, unclaimed within the dust allowance; the keeper itself waits for 0)
  "function addHotkey(bytes32 h)",
  "function removeHotkey(bytes32 h, bool forfeit)",
  // the owner's (scheduled), which ops and the sign page encode with its uint256 argument (Task 20)
  "function setIdleBuffer(uint256 bps)",
]);

/** Either adapter: the fee quote and the per-message cap (ICascadeBridge), and what the for-life checks read. */
export const ADAPTER = parseAbi([
  "function quoteFee(uint64 destChain, address recipient, bytes message, uint256 amount) view returns (uint256)",
  "function maxMessageValue() view returns (uint256)",
  "function treasury() view returns (address)",
  "event Sent(bytes32 indexed messageId, uint64 destChain, address indexed sender, address indexed recipient, uint256 amount, uint256 fee, uint256 gasLimit)",
]);

/** R7 (L4): the view the vault reads of its primary bridge before each delivery's door redeems (CascadeVault
 * _payoutsOpen), which the keeper reads the same way before closing a batch with redeem requests. */
export const RAIL_VIEWS = parseAbi(["function canSendPayouts() view returns (bool)"]);

/** The Bittensor adapter's parks (I-7: it holds at least what they owe). */
export const BIT_ADAPTER = parseAbi([
  "function parkedNative() view returns (uint256)",
  "function parkedTokens() view returns (uint256)",
  "function token() view returns (address)",
]);

/** The Bittensor adapter's park job the rails know (Task 50a, the founder's migration exception; Task 52 builds the job):
 * deliverParked converts a token park and delivers it to the vault. */
export const PARK_CALLS = parseAbi(["function deliverParked(address recipient, address sender, bytes message)"]);

/** What the rails read of a park before letting its conversion through a hold (T50a re-review A): the park itself, and
 * the adapter's remote chain, which its key is made with (CcipBittensorAdapter _parkKey). */
export const PARK_READS = parseAbi([
  "function parked(bytes32 key) view returns (uint128 amount, uint64 parkedAt, bool converted)",
  "function remoteChainId() view returns (uint64)",
  // R4 (A-M1, C-M1; merge 7b): the gas deliverParked requires left for the vault's call with this message, the lane's
  // inbound model with the park reserve inside it: the keeper's floor, read from the adapter, never recomputed
  "function parkedDeliveryGas(bytes message) view returns (uint256)",
  // R4-O round 3: the AlphaVault the adapter converts through (immutable), read for the rail now primary
  "function alphaVault() view returns (address)",
]);

/** The rest of the park job (Task 52; spec §3.2): a park refunded to its door after PARK_TIMEOUT, its fee quoted first, and
 * an empty park dropped after it. */
export const PARK_JOBS = parseAbi([
  "function refundParked(address recipient, address sender, bytes message) payable",
  "function quoteRefund(address recipient, address sender, bytes message) view returns (uint256)",
  "function dropParked(address recipient, address sender, bytes message)",
]);

/** The Bittensor adapter's park events (Task 52: the park job folds them, v32/parked.ts openParks). */
export const PARK_EVENTS = parseAbi([
  "event BatchParked(bytes32 indexed key, bytes32 indexed messageId, address recipient, address sender, uint256 amount, bool converted, bytes4 reason)",
  "event ParkedDelivered(bytes32 indexed key)",
  "event ParkedConverted(bytes32 indexed key)",
  "event ParkedRefunded(bytes32 indexed key, bytes32 indexed messageId)",
  "event ParkedDropped(bytes32 indexed key)",
]);

/** The source OnRamp 2.0.0's send event (contracts/test/fork/ForkBase.sol CCIP_MESSAGE_SENT): the encoded MessageV1 the
 * keeper rebuilds a park's or a FAILURE's message from (Task 52). Indexed: the destination selector, the CCIP sender (the
 * adapter) and the message id. */
export const ONRAMP = parseAbi([
  "struct Receipt { address issuer; uint32 destGasLimit; uint32 destBytesOverhead; uint256 feeTokenAmount; bytes extraArgs; }",
  "event CCIPMessageSent(uint64 indexed destChainSelector, address indexed sender, bytes32 indexed messageId, address feeToken, uint256 tokenAmountBeforeTokenPoolFees, bytes encodedMessage, Receipt[] receipts, bytes[] verifierBlobs)",
]);

/** The Base adapter's own floor. (Its gasBase and gasPerEntry, which R4-O's park floor read, are gone since merge 7b: the
 * floor is the Bittensor adapter's own parkedDeliveryGas, PARK_READS; the for-life list holds both copies of the model.) */
export const BASE_ADAPTER = parseAbi(["function minSendAmount() view returns (uint256)"]);

/** The staker the front door sells and buys through. */
export const STAKER = parseAbi([
  "function frontDoor() view returns (address)",
  "function tao() view returns (address)",
  "function usdc() view returns (address)",
  "function depositFeeUsdc() view returns (uint256)",
  "function swapFeeBps() view returns (uint16)",
  "function deliveryRouteId() view returns (uint8)",
  "function routes(uint8 id) view returns (uint8 kind, address router, bytes buyPath, bytes sellPath, bool active)",
]);

/** The front door's TWAP oracle. */
export const ORACLE = parseAbi([
  "function tao() view returns (address)",
  "function usdc() view returns (address)",
  "function weth() view returns (address)",
  "function taoWethPool() view returns (address)",
  "function wethUsdcPool() view returns (address)",
  "function usdcValue(uint256 taoWei) view returns (uint256)",
  "function meanLiquidity() view returns (uint128 taoWeth, uint128 wethUsdc)",
  "function MIN_CARDINALITY() view returns (uint16)",
]);

/** The front door's errors that are not the vault's (CascadeErrors.sol's are in the published ABI): a refused close,
 * a delivery's, and the rest, so an estimate or a replay is named. Held to the build. */
export const DOOR_ERRORS = parseAbi([
  "error BatchFull()",
  "error BatchNotReady()",
  "error BatchTooSmall()",
  "error BatchValueFull()",
  "error BelowMinimum()",
  // R11: a depositor's cancelDeposit before its cancelableAt (five minutes after its last deposit), which it names;
  // CascadeErrors.sol declares it, but only the front door reverts it, so it is not in the published vault ABI
  "error CancelTooSoon(uint256 cancelableAt)",
  "error DeadlinePassed()",
  "error DeliveryExpired()",
  "error DuplicatePayouts()",
  "error InsufficientFee()",
  "error InsufficientRequest()",
  "error NoDelivery()",
  "error NothingToClaim()",
  "error SafeERC20FailedOperation(address token)",
  "error ThinPool(uint8 index, uint128 liquidity)",
  "error TokensNotReceived()",
  "error UnsupportedDecimals()",
  "error UnsupportedDestination()",
  "error WrongBatch(uint64 openId)",
  "error WrongFee()",
]);

/** The Bittensor adapter's errors a park job can meet (Task 52), so its simulation's refusal is named. Held to the build. */
export const ADAPTER_ERRORS = parseAbi([
  "error AlreadyParked()",
  "error BelowConversionFloor(uint256 amount, uint256 floor)",
  "error ConversionShort()",
  "error NotParked()",
  "error NotRaoAligned()",
  "error NothingToRefund()",
  "error ParkedTooYoung()",
  "error ReentrancyGuardReentrantCall()",
  "error ReserveShort()",
]);

/** The deployed OffRamp 2.0.0's errors a re-execution can meet (Task 52; R3 W2-2's fork PoC declares them from the
 * verified source, OffRamp.sol:33-52), so a refused re-execution is named: no progress from FAILURE (the receiver or a
 * verifier failed again), the message already executed, an override under the message's own limit, a verifier missing. */
export const OFFRAMP_ERRORS = parseAbi([
  "error NoStateProgressMade(bytes32 messageId, bytes err)",
  "error SkippedAlreadyExecutedMessage(bytes32 messageId, uint64 sourceChainSelector, uint64 messageNumber)",
  "error InvalidGasLimitOverride(uint32 messageGasLimit, uint32 gasLimitOverride)",
  "error RequiredCCVMissing(address requiredCCV)",
  "error InvalidVerifierResultsLength(uint256 ccvsLength, uint256 verifierResultsLength)",
  "error ReceiverError(bytes err)",
  // Task 52 fix round 1: what else a re-execution's simulation can name (OffRamp.sol:33-54)
  "error TokenHandlingError(address target, bytes err)",
  "error OptionalCCVQuorumNotReached(uint256 wanted, uint256 got)",
  "error InboundImplementationNotFound(address ccvAddress, bytes verifierResults)",
  "error CursedByRMN(uint64 sourceChainSelector)",
  "error SourceChainNotEnabled(uint64 sourceChainSelector)",
]);

/** The committee verifier's own refusals of a proof (Task 52 fix round 1; the verified CommitteeVerifier.sol:25-26; Task
 * 65: its quorum checks, as docs.chain.link's manual execution page names them, WrongNumberOfSignatures 0x71253a25,
 * UnauthorizedSigner 0xca31867a, NonOrderedOrNonUniqueSignatures 0xb70ad94b): a re-execution's simulation names them
 * inside NoStateProgressMade, and a FAILURE a stranger's junk proof wrote logs one. Not in ERRORS_V32: only reexec.ts
 * decodes them. */
export const CCV_ERRORS = parseAbi([
  "error InvalidVerifierResults()",
  "error InvalidCCVVersion(bytes4 verifierVersion)",
  "error WrongNumberOfSignatures()",
  "error UnauthorizedSigner()",
  "error NonOrderedOrNonUniqueSignatures()",
]);

/** Every error a v3.2 keeper send can meet, by name: the published vault ABI's (CascadeErrors.sol and the libraries'),
 * the front door's own, the Bittensor adapter's park errors and the OffRamp's (Task 52). */
export const ERRORS_V32: Abi = [...VAULT_ABI_V32.filter((i) => i.type === "error"), ...DOOR_ERRORS, ...ADAPTER_ERRORS, ...OFFRAMP_ERRORS];

/** Uniswap's QuoterV2 (not a view: it quotes by reverting inside, but answers an eth_call). */
export const QUOTER = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);

/** ForeverMoney's AlphaVault, which the Bittensor adapter converts through: the keeper closes and pays out only while
 * it is neither paused nor migrating (as today's keeper, and the web's sendGate). */
export const ALPHA = parseAbi([
  "function isPaused() view returns (bool)",
  "function migrationReadyAt() view returns (uint256)",
  "function migrationFinished() view returns (bool)",
  // ForeverMoney's notice length (a public constant, 7 days; contracts/test/mocks/MockAlphaVault.sol): the notice began at
  // migrationReadyAt less it (Task 52 re-review N3, read once)
  "function MIGRATION_DELAY() view returns (uint256)",
]);

/** The CCIP OffRamp's view of a message. */
export const OFFRAMP = parseAbi(["function getExecutionState(bytes32 messageId) view returns (uint8)"]);

/** The deployed OffRamp 2.0.0's manual execution (R3 W2-2; contracts/test/fork/ForkBase.sol IOffRamp20): the encoded
 * message, the CCVs and their verifier results (as long as each other), and a receiver gas limit that may only raise the
 * message's own (0: none). Task 52's hand re-run (pnpm ops reexec) re-executes a FAILURE of Cascade's with it, and so does the
 * keeper only with OPS_REEXEC_AUTO on. */
export const OFFRAMP_EXECUTE = parseAbi(["function execute(bytes encodedMessage, address[] ccvs, bytes[] verifierResults, uint32 gasLimitOverride)"]);

/** The OffRamp 2.0.0's CCVs for a message (Task 52 fix round 1; ForkBase.sol IOffRamp20): the committees a re-execution's
 * results must cover, and the optional ones' threshold. */
export const OFFRAMP_CCVS = parseAbi(["function getCCVsForMessage(bytes encodedMessage) view returns (address[] requiredCCVs, address[] optionalCCVs, uint8 threshold)"]);

/** The OffRamp 2.0.0's state change (Task 52 fix round 1; ForkBase.sol EXECUTION_STATE_CHANGED): the transaction that
 * wrote a message's FAILURE carries the committee's results its re-execution takes, and logs the error it failed with. */
export const OFFRAMP_EVENTS = parseAbi([
  "event ExecutionStateChanged(uint64 indexed sourceChainSelector, uint64 indexed messageNumber, bytes32 indexed messageId, uint8 state, bytes returnData)",
]);

/** The claim source (plan Task 51): the staking precompile's view the keeper reads what waits to be claimed on a listed
 * hotkey from, for the vault's coldkey, in wei. The runtime accrues root rewards per hotkey (BasketRate, BasketClaimed,
 * BasketTwr); RootClaimable is legacy and never read. Task 64 confirms the source on chain: should it differ, this one
 * fragment is the line that changes (every read of it goes through v32/reads.ts creditsOf). */
export const CLAIM_SOURCE = parseAbi(["function getUnclaimedRootTaoByHotkey(bytes32 coldkey, bytes32 hotkey) view returns (uint256)"])[0];

/** Bittensor's storage-query precompile (as ops' v32/validators.ts and the monitor read the chain's own storage): an
 * eth_call whose data is a raw storage key answers the raw SCALE value. */
export const STORAGE_QUERY = "0x0000000000000000000000000000000000000807" as const;

/** twox128("SubtensorModule") ++ twox128("RootStakeUnlockInterval"): a plain u64, the blocks root stake must sit after the
 * last root add, remove or claim on a (coldkey, hotkey) pair before it can leave root; no entry is 0, no hold (spec §3.8;
 * the monitor's indexer/src/subtensor.ts ROOT_STAKE_UNLOCK_INTERVAL_KEY, which test/keeper-v32-abi.test.ts holds this to). */
export const ROOT_STAKE_UNLOCK_INTERVAL_KEY = "0x658faa385070e074c85bf6b568cf05554e541e10cbd64f2b97721f57262b538f" as const;

/** R6b (U9): twox128("SubtensorModule") ++ twox128("DeferredBasketDebts"), a DMAP (hotkey Blake2_128Concat, coldkey
 * Blake2_128Concat) → BoundedBTreeMap<NetUid u16, { generation u64, amount I64F64 }>, an OptionQuery (subtensor main's
 * pallets/subtensor/src/lib.rs, whose spec 490 the live chain runs): a coldkey's signed debt against each origin's deferred
 * dividends on the hotkey. With no stake there, owed = rate × 0 − debt, so a debt below 0 is alpha still owed, which
 * getUnclaimedRootTaoByHotkey leaves out until it converts (test/keeper-v32-deferred.test.ts holds the prefix to the name). */
export const DEFERRED_BASKET_DEBTS_PREFIX = "0x658faa385070e074c85bf6b568cf055537da55aa457602833b177a08e0823c1f" as const;

/** R6b (U9): twox128("SubtensorModule") ++ twox128("DeferredBasketCashClaimed"), a DMAP (hotkey, coldkey) → i128, a
 * ValueQuery: with no stake there, below 0 is TAO (rao) of a dissolved origin's cash still owed to the coldkey. */
export const DEFERRED_BASKET_CASH_CLAIMED_PREFIX = "0x658faa385070e074c85bf6b568cf0555467c65684205369cc175766901f27950" as const;

/** twox128("System") ++ twox128("Number"): the block number, a u32 every block has. The root hold's "no entry" ("0x")
 * is believed only once this key answers through the same precompile, since a chain with no code at STORAGE_QUERY (an
 * anvil fork) answers "0x" to every eth_call (Task 53's fix round, the review's Important 6). */
export const SYSTEM_NUMBER_KEY = "0x26aa394eea5630e07c48ae0c9558cef702a5c1b19ab7a04f536c519aca4983ac" as const;

/** The staking precompile's views the keeper reads: the claim source, the vault's stake on each listed hotkey (Task 51:
 * a hotkey with none, not the stake hotkey, is being freed), and the flag the vault's constructor sets on its coldkey (no
 * stake grows on a hotkey it never listed), for life. */
export const STAKING: Abi = [
  CLAIM_SOURCE,
  ...parseAbi(["function getStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid) view returns (uint256)", "function getRejectStakingHotkeyGrowth(bytes32 coldkey) view returns (bool)"]),
];

/** A Uniswap v3 pool the oracle reads: its fee tier (immutable) and its observation slots in use (they only grow), for
 * life; as ops reads them (cardinality.ts POOL_ABI, verify.ts). */
export const POOL = parseAbi([
  "function fee() view returns (uint24)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);
