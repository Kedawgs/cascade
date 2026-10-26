# Cascade v3 contracts and ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build v3's contracts (reward cut, USDC delivery with a market floor, a one-signature stake contract) and teach the ops tool to deploy, verify, rehearse and run them.

**Architecture:** The vault gains a reward cut minted to the treasury at the pre-claim price. The front door gains per-user delivery preferences and a keeper-only `deliver` that hands TAO to an owner-set swapper and requires the user's USDC balance to rise by at least the largest of the user's floor, the keeper's floor and a 30-minute Uniswap TWAP floor (`CascadeTwapOracle`). A new `CascadeStaker` takes fees, swaps along owner-set routes with balance-delta checks and deposits for any beneficiary. The ops tool gets a v3 deployment plan, verification, `rewards`, a policy-guarded `claim`, `deliver`, and a v3 rehearsal on forks.

**Tech Stack:** Solidity 0.8.24 / Foundry (cancun), OpenZeppelin 5.4.0, vendored Uniswap v3 math (0.8 branch); TypeScript ops tool (Node, viem, vitest).

**Spec:** `docs/superpowers/specs/2026-10-26-cascade-v3-design.md` (and the v2 spec it builds on, `docs/superpowers/specs/2026-10-21-cascade-v2-vault-on-bittensor-design.md`).

## Global Constraints

- Solidity `0.8.24`, EVM `cancun`, OpenZeppelin `v5.4.0`; no proxies, no `delegatecall`; custom errors; an event per state change; `renounceOwnership` stays disabled (CascadeBase).
- The vault stays under 24,576 bytes; check `forge build --sizes` as soon as it compiles; fallback: lower `optimizer_runs` in `contracts/foundry.toml` and re-run the gas tests.
- Every fee has a hard maximum in code: reward cut `MAX_REWARD_CUT_BPS = 2_000`; swap fee `MAX_SWAP_FEE_BPS = 50`; deposit fee `MAX_DEPOSIT_FEE_USDC = 250_000`; delivery slippage `MAX_DELIVERY_SLIPPAGE_BPS = 300` (default 150).
- Destinations are CCTP domain numbers; only `DESTINATION_BASE = 6` is accepted.
- TWAP window `TWAP_WINDOW = 1800` seconds.
- Base tokens and pools (verified on chain 2026-10-26): USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals, EIP-2612 domain name "USD Coin" version "2"); WETH `0x4200000000000000000000000000000000000006`; TAO `0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67` (18 decimals, no permit); Uniswap v3 pools TAO/WETH 0.3% `0x82dD34C6631C286cDD1dB16f2c232f60E402Dd5A` (token0 WETH, cardinality 600) and WETH/USDC 0.05% `0xd0b53D9277642d899DF5C87A3966A349A798F224` (token0 WETH, cardinality 5000); SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481`; Slipstream SwapRouter `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F` (structs carry `int24 tickSpacing` and `uint256 deadline`).
- Launch settings (spec table): minimum deposit 0.04 TAO; deposit cap 40 TAO; max batch value 10 TAO; batch interval 6 hours; redeem request fee 0.0001 ETH; reward cut 10%; swap fee 0.15%; deposit fee $0.05; delivery floor quote − 2% for 7 days (website, plan 2); claims at ≥ 25× cost or monthly while a claim costs under $20.
- Ops: never read or print the password file; RPC URLs stay redacted in errors; the v2 record `ops/deployments/test-2026-10.json` must keep working for `status`, `wind-down` and `sweep`.
- Commit trailer on every commit:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01QsFviaJn5ejsAa5vHQciyX`

## Review Focus

1. A user whose address USDC refuses (blacklisted, or a recipient contract that reverts) must still get out: `deliver` reverts with nothing moved and `claim()` returns the TAO. (Task 4)
2. A reward claim while the vault has no shares outstanding must not divide by zero or mint the treasury more than its cut. (Task 2)
3. A permit signed for a different amount, an expired permit, or a permit already used by a front-runner: the stake either proceeds on an existing allowance or reverts with a clear error, never pulls more than `usdcIn`. (Task 5)
4. A staker asked to stake for itself, the front door or the zero address must refuse, so shares never land on an address nobody controls. (Task 5)
5. A pool whose observation history no longer reaches 30 minutes makes `deliver` revert cleanly (the user claims by hand), and the ops tool says why instead of retrying forever. (Tasks 3, 9)

---

### Task 1: Uniswap v3 math, vendored

**Files:**
- Create: `contracts/src/vendor/uniswap/TickMath.sol`, `contracts/src/vendor/uniswap/FullMath.sol`, `contracts/src/vendor/uniswap/VENDOR.md`
- Test: `contracts/test/vendor/UniswapMath.t.sol`

**Interfaces:**
- Produces: `library TickMath { function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160); }`, `library FullMath { function mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256); }` (Uniswap v3-core `0.8` branch, byte-for-byte apart from the pragma line if needed).

- [ ] **Step 1: Write the failing test** `UniswapMathTest`: `getSqrtRatioAtTick(0) == 79228162514264337593543950336`; `getSqrtRatioAtTick(887272)` and `(-887272)` equal Uniswap's `MAX_SQRT_RATIO`/`MIN_SQRT_RATIO`; `mulDiv(2**255, 2, 4) == 2**254` (no overflow).
- [ ] **Step 2: Run** `forge test --match-contract UniswapMathTest` — Expected: FAIL (files missing).
- [ ] **Step 3: Vendor** the two files from `github.com/Uniswap/v3-core` branch `0.8` (`contracts/libraries/TickMath.sol`, `FullMath.sol`); write `VENDOR.md` with the repository, branch, commit hash, the files' SHA-256 and any line changed (match the existing `src/vendor/ccip/VENDOR.md` format). Add `src/vendor/uniswap/**` to `[fmt] ignore` in `foundry.toml`.
- [ ] **Step 4: Run** the test — Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): vendor Uniswap v3 TickMath and FullMath (0.8 branch)`

### Task 2: Vault reward cut

**Files:**
- Modify: `contracts/src/CascadeVault.sol` (state, `claimRewards`, new setter), `contracts/foundry.toml` only if the size check needs it
- Test: `contracts/test/vault/VaultRewards.t.sol`

**Interfaces:**
- Produces: `address public treasury; uint16 public rewardCutBps; uint16 public constant MAX_REWARD_CUT_BPS = 2_000; function setRewardCut(address treasury_, uint16 bps) external onlyOwner; event RewardCutSet(address treasury, uint16 bps); event RewardCutMinted(address indexed treasury, uint256 assets, uint256 shares);` — `setRewardCut` reverts `FeeTooHigh` above the maximum and `ZeroAddress` for a zero treasury with a non-zero cut.

- [ ] **Step 1: Write the failing tests** in `VaultRewards.t.sol`:
  - `test_cutMintsTreasuryAtPreClaimPrice`: stake 100 TAO for alice, set cut 1_000 bps to `treasury`, credit a 10 TAO reward in the mock and claim; assert `vault.balanceOf(treasury) == CascadeMath.sharesForDeposit(1e18, assetsBefore, supplyBefore)` and `vault.vestingAmount() == 9e18`.
  - `test_cutLeavesPriceUnchanged`: `vault.price()` right after the claim is at least the price right before it and at most 1 unit above it (the treasury's shares round down).
  - `test_cutAboveMaximumReverts`: `setRewardCut(treasury, 2_001)` reverts `FeeTooHigh`; `setRewardCut(address(0), 1)` reverts `ZeroAddress`; only the owner may call.
  - `test_zeroCutChangesNothing`: with the cut at 0 the v2 vesting behaviour and events are unchanged.
  - `test_claimWithNoSharesMintsOnlyTheCut` (Review Focus 2): no deposits, a 1 TAO reward claimed with a 10% cut; no revert; the treasury's shares redeem for at most 0.1 TAO.
  - `test_tinyClaimRoundsCutToZero`: a delta of 9 wei with a 10% cut mints nothing and vests 9 wei.
- [ ] **Step 2: Run** `forge test --match-path test/vault/VaultRewards.t.sol` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement** in `claimRewards`, after `delta` is measured and before `vestingAmount` is set: `fee = delta * rewardCutBps / 10_000`; if `fee != 0`: `assetsBefore = totalAssets() - delta` (`totalAssets()` still includes `delta` here), mint `CascadeMath.sharesForDeposit(fee, assetsBefore, totalSupply())` to `treasury`, emit `RewardCutMinted`; then `vestingAmount = unvestedRewards() + (delta - fee)` only when `delta - fee != 0` (keep v2's "a zero claim doesn't restart vesting").
- [ ] **Step 4: Run** the vault tests, the invariants (`forge test --match-path test/invariants/*`) and `forge build --sizes` — Expected: PASS; `CascadeVault` runtime size ≤ 24,576 (lower `optimizer_runs` if not, re-run `test/Gas.t.sol`, and record the new value in the commit message).
- [ ] **Step 5: Commit** `feat(vault): reward cut minted to the treasury at the pre-claim price`

### Task 3: TWAP oracle

**Files:**
- Create: `contracts/src/CascadeTwapOracle.sol`, `contracts/src/interfaces/ICascadeTwap.sol`, `contracts/test/mocks/MockUniswapPool.sol`
- Test: `contracts/test/oracle/TwapOracle.t.sol`, `contracts/test/fork/BaseForkV3.t.sol` (oracle part)

**Interfaces:**
- Consumes: Task 1 `TickMath`, `FullMath`.
- Produces: `interface ICascadeTwap { function usdcValue(uint256 taoWei) external view returns (uint256 usdcUnits); }`; `contract CascadeTwapOracle is ICascadeTwap` with immutables `taoWethPool`, `wethUsdcPool`, `tao`, `weth`, `usdc`, `uint32 public constant TWAP_WINDOW = 1800;` constructor `(address taoWethPool, address wethUsdcPool, address tao, address weth, address usdc)` that checks each pool's `token0()/token1()` are the expected pair (`BadPool`).

- [ ] **Step 1: Write the failing tests** with `MockUniswapPool` (settable `token0/token1` and `observe(uint32[])` returning tick cumulatives for a chosen mean tick, or reverting `"OLD"`):
  - `test_valueAtTickZeroIsOneToOneScaled`: both pools at mean tick 0 with token0 WETH: 1e18 TAO → 1e18 WETH → 1e18 USDC units (the raw 1:1 the ticks say).
  - `test_valueMatchesSpotForStableTicks`: mean ticks equal to `slot0` ticks of the live pools (22227 and -198877 as of 2026-10-26) value 1 TAO between 240 and 265 USDC (= 240e6..265e6).
  - `test_oldHistoryReverts` (Review Focus 5): a pool whose `observe` reverts `"OLD"` makes `usdcValue` revert.
  - `test_wrongPoolTokensRejected`: constructor reverts `BadPool`.
- [ ] **Step 2: Run** `forge test --match-path test/oracle/TwapOracle.t.sol` — Expected: FAIL.
- [ ] **Step 3: Implement** `usdcValue`: for each pool `observe([TWAP_WINDOW, 0])`, mean tick = `(c1 - c0) / TWAP_WINDOW` rounded toward negative infinity (Uniswap OracleLibrary's `consult`); quote with the OracleLibrary `getQuoteAtTick(tick, baseAmount, baseToken, quoteToken)` algorithm (written into the contract, using `TickMath`/`FullMath`): TAO→WETH on the first pool, then WETH→USDC on the second.
- [ ] **Step 4: Fork test** in `BaseForkV3.t.sol` (`forkFrom("BASE_RPC", "https://mainnet.base.org")` as `ForkBase.sol` does): the oracle built on the two live pools values 1 TAO within 3% of QuoterV2's spot quote for a 1-TAO sell; both pools' `observe([1800, 0])` succeed. Run `forge test --match-path test/fork/BaseForkV3.t.sol` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): 30-minute TWAP oracle over the Uniswap TAO/WETH and WETH/USDC pools`

### Task 4: Front door delivery

**Files:**
- Modify: `contracts/src/CascadeFrontDoor.sol`
- Create: `contracts/src/interfaces/ICascadeSwapper.sol`, `contracts/test/mocks/MockSwapper.sol`, `contracts/test/mocks/MockUSDC.sol`, `contracts/test/mocks/MockTwap.sol`
- Modify (constructor callers): `contracts/test/FrontDoorTestBase.sol`, `contracts/test/EndToEnd.t.sol`, `contracts/test/invariants/Handler.sol` and `Cascade.invariants.t.sol`, `contracts/test/Gas.t.sol`, `contracts/test/fork/*.t.sol`, `contracts/test/adapters/AdaptersFixture.sol` (whichever construct a front door)
- Test: `contracts/test/frontdoor/FrontDoorDelivery.t.sol`

**Interfaces:**
- Consumes: Task 3 `ICascadeTwap`.
- Produces:
  - `interface ICascadeSwapper { function sellFor(uint256 taoIn, address recipient, uint256 minUsdcOut) external returns (uint256 usdcOut); }`
  - Front door constructor gains `IERC20 usdc_` as the last parameter; `IERC20 public immutable usdc;`
  - `struct Delivery { uint128 minUsdcPerTao; uint64 deadline; uint32 destination; }`, `mapping(address => Delivery) public deliveryOf;`, `uint32 public constant DESTINATION_BASE = 6;`, `uint16 public constant MAX_DELIVERY_SLIPPAGE_BPS = 300;`, `uint16 public maxDeliverySlippageBps = 150;`
  - `address public keeper; address public swapper; ICascadeTwap public oracle;` with `setKeeper(address)`, `setSwapper(address)`, `setOracle(ICascadeTwap)`, `setMaxDeliverySlippage(uint16)` (owner only; events `KeeperSet`, `SwapperSet`, `OracleSet`, `MaxDeliverySlippageSet`)
  - `function setDelivery(uint128 minUsdcPerTao, uint64 deadline, uint32 destination) external;` (`minUsdcPerTao == 0` clears; otherwise `destination == 6` else `UnsupportedDestination`, `deadline > block.timestamp` else `DeadlinePassed`; event `DeliverySet`)
  - `function requestRedeemWithDelivery(uint256 shares, uint128 minUsdcPerTao, uint64 deadline, uint32 destination) external payable;` (same fee rule as `requestRedeem`)
  - `function deliver(address user, uint256 keeperMinOut) external returns (uint256 received);` (`NotKeeper`, `whenNotPaused`, `nonReentrant`; errors `NothingToClaim`, `NoDelivery`, `DeliveryExpired`, `BelowMinimum`; event `Delivered(address indexed user, uint256 taoIn, uint256 usdcOut)`)
  - `claim()` also deletes `deliveryOf[msg.sender]`.

- [ ] **Step 1: Write the failing tests** in `FrontDoorDelivery.t.sol` (extend `FrontDoorTestBase`; a payout of 10 TAO credited to alice through the stub bridge; `MockTwap` values TAO at a set price; `MockSwapper` has modes `Honest(rate)`, `KeepsTao`, `PaysLess(bps)`, `Reverts`):
  - `test_deliverPaysAtLeastTheLargestFloor`: user floor 240 USDC/TAO, keeper floor 0, TWAP 250 with 150 bps → min = max(2_400e6, 2_462.5e6) = 2_462.5e6; honest swapper at 248/TAO delivers ≥ min; `claimable(alice) == 0`; `totalClaimable` reduced; event emitted.
  - `test_keepsTaoSwapperReverts`, `test_paysLessSwapperReverts`, `test_revertingSwapperReverts`: each reverts (`BelowMinimum` or bubbled), and afterwards `claimable(alice) == 10e18`, the front door's TAO balance is unchanged, the preference is unchanged.
  - `test_usdcRefusingRecipientCanStillClaim` (Review Focus 1): `MockUSDC` set to revert transfers to alice → `deliver` reverts; `claim()` then sends alice her 10 TAO.
  - `test_preferenceServesTwoPayouts`: two payouts delivered in turn with one preference.
  - `test_expiredUnsetOrForeignDestination`: deadline passed → `DeliveryExpired`; no preference → `NoDelivery`; `setDelivery(.., 0 /*Ethereum*/)` → `UnsupportedDestination`.
  - `test_onlyKeeperAndNotPaused`: a non-keeper reverts `NotKeeper`; paused → `deliver` reverts, `claim()` works.
  - `test_claimClearsPreference`; `test_requestRedeemWithDeliverySetsBoth` (fee rule as `requestRedeem`).
  - `test_slippageCap`: `setMaxDeliverySlippage(301)` reverts `FeeTooHigh`.
  - `test_twapRevertBlocksDelivery` (Review Focus 5): `MockTwap` reverting → `deliver` reverts, `claim()` works.
- [ ] **Step 2: Run** `forge test --match-path test/frontdoor/FrontDoorDelivery.t.sol` — Expected: FAIL.
- [ ] **Step 3: Implement** the additions. The market floor is `oracle.usdcValue(amount) * (10_000 - maxDeliverySlippageBps) / 10_000`; the user floor `Math.mulDiv(amount, minUsdcPerTao, 1e18, Math.Rounding.Ceil)`. Order inside `deliver`: checks; compute `minOut`; state changes (`claimable`, `totalClaimable`); `asset.safeTransfer(swapper, amount)`; `before = usdc.balanceOf(user)`; `ICascadeSwapper(swapper).sellFor(amount, user, minOut)`; check the balance delta. Update every constructor caller listed under Files to pass a USDC (tests: `MockUSDC`; forks: the live USDC).
- [ ] **Step 4: Run** `forge test` (whole suite: the constructor change touches many fixtures) and `forge build --sizes` — Expected: PASS; front door under 24,576 bytes.
- [ ] **Step 5: Commit** `feat(front door): USDC delivery with user, keeper and 30-minute TWAP floors`

### Task 5: CascadeStaker

**Files:**
- Create: `contracts/src/CascadeStaker.sol`, `contracts/src/interfaces/IUniswapV3Router02.sol`, `contracts/src/interfaces/ISlipstreamRouter.sol`, `contracts/test/mocks/MockSwapRouter.sol`
- Modify: `contracts/test/mocks/MockUSDC.sol` (Task 4) gains OpenZeppelin `ERC20Permit` with name "USD Coin", version "2", 6 decimals
- Test: `contracts/test/staker/Staker.t.sol`

**Interfaces:**
- Consumes: Task 4 `ICascadeSwapper`, the front door's `depositFor(address,uint256)`.
- Produces:
  - `contract CascadeStaker is Ownable2Step, ReentrancyGuard, ICascadeSwapper`, constructor `(IERC20Permit usdc, IERC20 tao, CascadeFrontDoor frontDoor, address owner, address treasury)`.
  - `enum RouterKind { UniswapV3, Slipstream }`; `struct Route { RouterKind kind; address router; bytes buyPath; bytes sellPath; bool active; }`; `mapping(uint8 => Route) public routes; uint8 public deliveryRouteId;`
  - `uint16 public swapFeeBps; uint256 public depositFeeUsdc; address public treasury;` with `uint16 constant MAX_SWAP_FEE_BPS = 50; uint256 constant MAX_DEPOSIT_FEE_USDC = 250_000;`
  - `setRoute(uint8 id, Route calldata r)`, `setDeliveryRoute(uint8 id)`, `setFees(uint16 swapFeeBps, uint256 depositFeeUsdc)`, `setTreasury(address)`, `sweep(IERC20 token)` (to the treasury) — owner only; events `RouteSet`, `DeliveryRouteSet`, `FeesSet`, `TreasurySet`, `Swept`.
  - `function stake(address beneficiary, uint256 usdcIn, uint256 minTaoOut, uint8 routeId, uint256 deadline) external returns (uint256 taoDeposited);`
  - `function stakeWithPermit(address beneficiary, uint256 usdcIn, uint256 minTaoOut, uint8 routeId, uint256 deadline, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s) external returns (uint256);`
  - `function sellFor(uint256 taoIn, address recipient, uint256 minUsdcOut) external returns (uint256 usdcOut);` (only the front door, `NotFrontDoor`)
  - Events `Staked(address indexed payer, address indexed beneficiary, uint256 usdcIn, uint256 fees, uint256 taoDeposited)`, `Sold(address indexed recipient, uint256 taoIn, uint256 usdcOut, uint256 fee)`.
  - Errors `BadPath`, `RouteInactive`, `Expired`, `InsufficientOutput`, `BadBeneficiary`, `NotFrontDoor`, `FeeTooHigh`, `ZeroAddress`.

- [ ] **Step 1: Write the failing tests** in `Staker.t.sol` (`MockSwapRouter` implements both routers' `exactInput` shapes, paying a configurable output rate and recording the struct it received; a real `CascadeFrontDoor` from `FrontDoorTestBase` with the staker's TAO approvals):
  - `test_stakeTakesFeesSwapsAndDeposits`: 1_000e6 USDC, deposit fee 50_000, swap fee 15 bps → treasury gets 50_000 + 1_499_925 (= 0.15% of 999_950_000, rounded down); the router receives 998_450_075; the front door's open batch holds the floored TAO for `beneficiary`; the event carries the amounts.
  - `test_feeCaps`: `setFees(51, 0)` and `setFees(0, 250_001)` revert `FeeTooHigh`.
  - `test_minTaoOutEnforcedByBalanceDelta`: a router that reports success but delivers less than `minTaoOut` → `InsufficientOutput`; nothing deposited, the payer's USDC unchanged.
  - `test_pathsMustMatchTokens`: `setRoute` with a buy path not starting at USDC / ending at TAO, or a sell path the other way round, reverts `BadPath`; an inactive route reverts `RouteInactive`.
  - `test_permitPaths` (Review Focus 3): a valid permit stakes; a permit already consumed by a front-runner still stakes on the allowance it left; a permit for a smaller amount reverts on `transferFrom` and leaves balances unchanged; an expired permit with no allowance reverts.
  - `test_stakeForAnyBeneficiaryFromAContract`: a helper contract holding USDC stakes for `bob`; the deposit is bob's.
  - `test_badBeneficiaries` (Review Focus 4): `address(0)`, `address(staker)` and `address(frontDoor)` revert `BadBeneficiary`.
  - `test_frontDoorCapRevertsWholeStake`: a stake above the front door's cap reverts and the payer keeps their USDC.
  - `test_sellForOnlyFrontDoor`: anyone else reverts `NotFrontDoor`; from the front door it swaps along `deliveryRouteId`, takes 0.15% of the USDC out, pays the rest and returns it; less than `minUsdcOut` reverts `InsufficientOutput`.
  - `test_slipstreamStructCarriesDeadline`: a Slipstream route passes `deadline` and the path through.
  - `test_dustAndSweep`: sub-rao TAO left after a stake stays in the staker and `sweep(tao)` sends it to the treasury; only the owner can sweep.
- [ ] **Step 2: Run** `forge test --match-path test/staker/Staker.t.sol` — Expected: FAIL.
- [ ] **Step 3: Implement.** Order in `stake`: checks (`deadline`, beneficiary, route active); `usdc.safeTransferFrom(msg.sender, this, usdcIn)`; fees to the treasury; `forceApprove(router, rest)`; swap (`exactInput`; the Slipstream struct gets `deadline`); measure TAO by balance delta; `>= minTaoOut`; floor to `1e9`; `forceApprove(frontDoor, amount)`; `frontDoor.depositFor(beneficiary, amount)`; reset approvals to 0. `stakeWithPermit` wraps `usdc.permit(msg.sender, this, usdcIn, permitDeadline, v, r, s)` in `try/catch {}` and continues. `sellFor` mirrors it in the sell direction.
- [ ] **Step 4: Run** `forge test` and `forge build --sizes` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): CascadeStaker — one-signature stake, fees, routed swaps, delivery sells`

### Task 6: Base fork tests for v3

**Files:**
- Modify: `contracts/test/fork/BaseForkV3.t.sol` (from Task 3)

**Interfaces:**
- Consumes: Tasks 3–5.

- [ ] **Step 1: Write the fork tests**:
  - `test_fork_permitStakeThroughUniswap`: a fresh key holding 100 USDC (`deal`) signs a real USDC permit (domain "USD Coin"/"2"/8453); `stakeWithPermit` on route 0 (SwapRouter02, path USDC–500–WETH–3000–TAO) deposits ≥ the QuoterV2 quote × 0.99 into a front door on the fork.
  - `test_fork_deliverThroughUniswapWithTwapFloor`: a 1-TAO payout credited to a user, preference = QuoterV2 sell quote × 0.98, `deliver` from the keeper pays the user ≥ the largest floor; a `keeperMinOut` 5% above the quote reverts `BelowMinimum` and restores the claim.
  - `test_fork_slipstreamRoute`: route 1 = Slipstream router with path USDC–tickSpacing 100–TAO; a $10 stake succeeds.
- [ ] **Step 2: Run** `forge test --match-path test/fork/BaseForkV3.t.sol` — Expected: PASS (needs network; the repo's fork tests read `BASE_RPC`, default public RPC).
- [ ] **Step 3: Commit** `test(fork): v3 permit stake, TWAP-floored delivery and a Slipstream route on a Base fork`

### Task 7: End-to-end and invariants for v3

**Files:**
- Modify: `contracts/test/EndToEnd.t.sol`, `contracts/test/invariants/Handler.sol`, `contracts/test/invariants/Cascade.invariants.t.sol`

- [ ] **Step 1: Write the failing tests**:
  - `EndToEnd`: `test_v3RoundTrip`: stake through the staker (mock router) → batch → vault delivery → stake → unstake with delivery → payouts → `deliver` → the user's USDC rises by ≥ the floor; with a 10% cut and one reward claim, the treasury's shares are worth 10% of the claimed delta (± 1 wei per rounding).
  - Invariants: the handler gains `claimWithCut` and `deliver` actions; new invariants `invariant_cutNeverMovesPrice` (the share price immediately after a claim equals the price before it) and `invariant_deliveryNeverBelowFloor` (every successful delivery the handler saw met its floor).
- [ ] **Step 2: Run** `forge test --match-path test/EndToEnd.t.sol` and `forge test --match-path "test/invariants/*"` — Expected: FAIL until the handler and fixtures are wired, then PASS.
- [ ] **Step 3: Commit** `test: v3 round trip and invariants (cut never moves the price, delivery never below its floor)`

### Task 8: Ops v3 deployment plan, deploy and verify

**Files:**
- Modify: `ops/src/config.ts` (`SETTINGS_V3`, Base pool/router constants, `OPS_DEPLOYMENT`), `ops/src/plan.ts` (`buildPlanV3`), `ops/src/types.ts` (new `StepId`s), `ops/src/deploy.ts`, `ops/src/verify.ts`, `ops/src/cli.ts` (record path), `ops/src/webconfig.ts` (staker and oracle addresses)
- Test: `ops/test/plan.test.ts`, `ops/test/verify.test.ts`, `ops/test/config.test.ts`, `ops/test/webconfig.test.ts`

**Interfaces:**
- Produces:
  - `recordPath(live)` = `deployments/${env.OPS_DEPLOYMENT ?? "test-2026-10"}.json` when live (rehearsal: `rehearsal-${name}.json`), so `OPS_DEPLOYMENT=v3-test` gives a separate record and the v2 record keeps working.
  - `buildPlanV3(baseNonce, bitNonce, vaultColdkey): PlanV3` whose `addresses` add `oracle` and `staker`. Steps, in order — Base: `baseAdapter`, `oracle`, `frontDoor` (constructor adds USDC), `staker`, `fdSetKeeper`, `fdSetSwapper`, `fdSetOracle`, `fdSetMaxBatchValue` (10 TAO), `stakerSetRoute0` (Uniswap two-hop), `stakerSetDeliveryRoute`, `stakerSetFees` (15 bps, 50_000); Bittensor: `bitAdapter`, `vault`, `adapterReserve`, `vaultReserve`, `setKeeper`, `setPayoutDelay`, `setRewardCut` (treasury = `WALLET` for the test, 1_000 bps).
  - `SETTINGS_V3` = the launch settings in Global Constraints (`minDeposit 4e16`, `depositCap 40e18`, `maxBatchValue 10e18`, `batchInterval 600` and `payoutDelay 3600` for the test run (launch: 21_600 and the v2 default), `redeemRequestFee 1e14`).
  - `verify` checks, in addition to v2's: the front door's `usdc`, `keeper`, `swapper`, `oracle`, `maxDeliverySlippageBps == 150`; the staker's `frontDoor`, `treasury`, fees, route 0 and delivery route; the oracle's pools; the vault's `treasury` and `rewardCutBps == 1_000`.
- [ ] **Step 1: Write the failing tests**: `plan.test.ts` — `buildPlanV3` predicts addresses from nonces like v2 and lists the steps above in that order with those arguments; `config.test.ts` — the record name follows `OPS_DEPLOYMENT` and defaults to the v2 record; `verify.test.ts` — a read-back that differs in any new field fails with a message naming it; `webconfig.test.ts` — the web env gains `NEXT_PUBLIC_CASCADE_STAKER` and `NEXT_PUBLIC_CASCADE_ORACLE`.
- [ ] **Step 2: Run** `pnpm --dir ops test` — Expected: FAIL.
- [ ] **Step 3: Implement**; `deploy` picks `buildPlanV3` for a new record when `OPS_DEPLOYMENT` starts with `v3`.
- [ ] **Step 4: Run** `pnpm --dir ops test` and `pnpm --dir ops typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): v3 deployment plan, deploy and verify, in its own record`

### Task 9: Ops rewards, claim policy and deliver

**Files:**
- Create: `ops/src/keeper/rewards.ts`, `ops/src/keeper/delivery.ts`
- Modify: `ops/src/keeper/due.ts`, `ops/src/keeper/actions.ts`, `ops/src/keeper/state.ts`, `ops/src/args.ts`, `ops/src/cli.ts`, `ops/src/config.ts` (`claimCostTao` default `57n * 10n ** 15n`, `claimMultiple 25n`, `monthlyClaimMaxUsd 20`)
- Test: `ops/test/keeper-rewards.test.ts`, `ops/test/keeper-delivery.test.ts`, `ops/test/cli.test.ts`

**Interfaces:**
- Produces:
  - `claimDecision(i: { waitingWei: bigint; costWei: bigint; taoPriceUsd: number; lastClaimAt: number; now: number; multiple: bigint; monthlyMaxUsd: number }): { claim: boolean; reason: string }` — claims when `waitingWei >= multiple * costWei`, or when `now - lastClaimAt >= 30 days` and `costWei` is worth less than `monthlyMaxUsd`; otherwise `claim: false` with the reason.
  - `deliveryDecision(i: { claimable: bigint; pref: { minUsdcPerTao: bigint; deadline: number; destination: number } | null; quoteUsdc: bigint; twapUsdc: bigint; slippageBps: number; now: number }): { deliver: boolean; keeperMinOut?: bigint; reason: string }` — delivers only when there is a live Base preference and the quote clears every floor by at least 0.5%; `keeperMinOut = quote * 9950 / 10000`.
  - CLI: `pnpm ops rewards` (read-only: waiting TAO, cost, ratio, the decision), `pnpm ops claim [--live]` (refuses with the reason unless `claimDecision` says claim), `pnpm ops deliver [--live] [--user 0x…]` (candidates from the vault's `Redeemed` events since the deploy block, read from the archive node; each checked with `deliveryDecision`).
  - `due.ts` adds `deliver` to the `run` loop's due actions; `claim` is never automatic (`run` only reports it).
- [ ] **Step 1: Write the failing tests**: `keeper-rewards.test.ts` — 1.5 TAO waiting at 0.057 cost → claim (25× = 1.425); 1.0 TAO waiting, 31 days, cost $14 → claim (monthly); 1.0 TAO waiting, 31 days, cost $66 → no, reason names the $20 ceiling; 10 days → no. `keeper-delivery.test.ts` — no preference / expired / destination 0 → no with reasons; quote below the user floor or the TWAP floor → no; quote 1% above every floor → yes with `keeperMinOut` = quote × 0.995; a TWAP read error (Review Focus 5) → no, reason "the pool's price history doesn't reach 30 minutes; the user can claim by hand". `cli.test.ts` — the three commands parse.
- [ ] **Step 2: Run** `pnpm --dir ops test` — Expected: FAIL.
- [ ] **Step 3: Implement** (reads: `getUnclaimedRootTaoByHotkey(vaultColdkey, hotkey)` on the staking precompile; `lastClaimAt(hotkey)` on the vault; QuoterV2 for quotes; the oracle's `usdcValue`).
- [ ] **Step 4: Run** `pnpm --dir ops test` and `typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ops): rewards view, policy-guarded claim and USDC delivery`

### Task 10: v3 rehearsal on forks

**Files:**
- Modify: `ops/src/rehearse.ts`, `contracts/test/rehearsal/RehearsalPrecompiles.sol` (only if the claim stand-in needs a reward hook)
- Test: `ops/test/deploy.test.ts` (rehearsal-shaped), a manual run

- [ ] **Step 1: Extend `rehearse`** for `OPS_DEPLOYMENT=v3-*`: deploy the v3 plan on the two anvil forks, then run: a permit stake through the staker from a funded test key (Base fork has real USDC and Uniswap), close the batch, deliver on the Bittensor fork, stake, request a redeem with delivery, process payouts, deliver USDC on the Base fork; print each step's gas and fee.
- [ ] **Step 2: Run** `OPS_DEPLOYMENT=v3-rehearsal pnpm --dir ops ops rehearse` — Expected: every step reports success and the final user USDC balance is ≥ the floor.
- [ ] **Step 3: Commit** `feat(ops): v3 rehearsal — permit stake to delivered USDC on local forks`

### Task 11: Docs

**Files:**
- Modify: `contracts/README.md` (contracts table: `CascadeStaker`, `CascadeTwapOracle`; trust model: the keeper may deliver within the TWAP floor, the staker cannot short a user below their floor, owner powers within the fee caps; pre-mainnet checklist: items 29 and 30 now implemented in v3; new items — measure a real claim on testnet 945 and compare validators' basket sizes; check both pools' observation cardinality before launch), `docs/architecture.md` (v3 flows), `docs/runbook-test-run.md` (v3 section: `OPS_DEPLOYMENT=v3-test`, deploy, verify, rewards/claim/deliver)
- [ ] **Step 1: Write** the changes.
- [ ] **Step 2: Run** `forge test`, `pnpm --dir ops test`, `pnpm --dir web test` — Expected: all PASS.
- [ ] **Step 3: Commit** `docs: v3 contracts, trust model, checklist and runbook`
