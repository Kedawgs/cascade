import { parseAbi } from "viem";

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
  "function balanceOf(address account) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function rootStakeRao() view returns (uint256)",
  "function pendingPayouts() view returns (uint256)",
  "function stakeHotkey() view returns (bytes32)",
  "function payoutDelay() view returns (uint64)",
  "function rewardCutBps() view returns (uint16)",
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
