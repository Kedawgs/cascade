# Cascade contracts v1 — design spec

Product context and money flow: `docs/architecture.md` (read it first). This spec pins the
contract-level behaviour. Where the two disagree, this spec wins for contract code.

## Scope

In scope: Solidity contracts for the Base vault and the Bittensor stake engine, the shared
math and message libraries, interfaces, test doubles for the Bittensor staking precompile and
the bridge, and unit, end-to-end and invariant tests (Foundry).

Out of scope for v1: the production CCIP bridge adapter, deployment scripts for real networks,
web app wiring, keeper bot, fees charged to users, multi-validator stake splitting, and
recovery from a permanently lost in-flight epoch (an owner override with a timeout — v2; in
v1 a lost bridge message freezes new epochs, which is the safe failure).

## Global rules

- Solidity `0.8.24`, EVM `cancun` (Bittensor EVM limit). OpenZeppelin Contracts `v5.4.0`.
- No upgradeable proxies. No `delegatecall`. No arbitrary external calls.
- Admin = `Ownable2Step` owner (a timelock controlled by a Safe in production).
  Guardian = may call `pause()` only. Owner may `pause()` and `unpause()`.
  `renounceOwnership()` is overridden to revert `RenounceDisabled()` in both contracts: a
  guardian pause must always be reversible by someone.
- Every routine function (close epoch, settle epoch, stake idle, claim rewards, claims) is
  permissionless.
- Custom errors, not revert strings. Events for every state change listed below.
- All share math goes through `CascadeMath` (already implemented in
  `contracts/src/libraries/CascadeMath.sol`, do not change its formulas):
  - `sharesForDeposit(assets, totalAssets, totalSupply) = assets * (totalSupply + 1e6) / (totalAssets + 1)` rounded down
  - `assetsForRedeem(shares, totalAssets, totalSupply) = shares * (totalAssets + 1) / (totalSupply + 1e6)` rounded down
  - `price(totalAssets, totalSupply) = (totalAssets + 1) * 1e18 / (totalSupply + 1e6)` rounded down
- Units: the vault asset and engine accounting are both 18-decimal ("wei") TAO. The Bittensor
  precompile takes rao: `1 rao = 1e9 wei`. v1 vault requires `asset.decimals() == 18`
  (a production adapter will scale if the bridged token differs).

## Bittensor staking precompile (subset used)

Address `0x0000000000000000000000000000000000000805`. Signatures verbatim from
RaoFoundation/subtensor `precompiles/src/solidity/stakingV2.sol`:

```solidity
function addStake(bytes32 hotkey, uint256 amount, uint256 netuid) external payable;      // amount in rao, debited from caller balance
function removeStake(bytes32 hotkey, uint256 amount, uint256 netuid) external payable;   // amount in alpha (root: rao of TAO), credited to caller balance
function moveStake(bytes32 origin_hotkey, bytes32 destination_hotkey, uint256 origin_netuid, uint256 destination_netuid, uint256 amount) external payable; // rao
function getStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid) external view returns (uint256);
function claimRootWithHotkey(bytes32 hotkey) external;
function getUnclaimedRootTaoByHotkey(bytes32 coldkey, bytes32 hotkey) external view returns (uint256 taoValue); // 18-decimal
function setRejectStakingHotkeyGrowth(bool enabled) external;
```

The calling contract's coldkey is the mirror of its H160 address (computed off-chain with
`btcli evm mirror`); the engine receives it as a constructor argument. Never send `msg.value`
to `addStake`: the precompile debits the contract's own balance.

## Bridge interface

```solidity
interface ICascadeBridge {
    /// ERC-20 side: bridge pulls `amount` from msg.sender (caller approves first); msg.value == fee.
    /// Native side: msg.value == amount + fee.
    function send(bytes calldata message, uint256 amount) external payable;
    function quoteFee(bytes calldata message, uint256 amount) external view returns (uint256);
}

interface ICascadeReceiver {
    /// Called by the bridge after delivering `amount` to the receiver.
    /// ERC-20 side: tokens are transferred before the call and msg.value == 0.
    /// Native side: msg.value == amount.
    function onBridgeMessage(bytes calldata message, uint256 amount) external payable;
}
```

The production adapter is responsible for verifying source chain and peer contract.
Receivers only check `msg.sender == bridge`.

## Messages (`CascadeMessages` library)

`abi.encode(uint8 kind, ...)`. Decoding a message of the wrong kind reverts `WrongMessageKind`.

| Kind | Value | Payload | Bridged amount means |
|---|---|---|---|
| `EPOCH_REQUEST` (vault → engine) | 1 | `uint64 epochId, uint256 redeemShares, uint256 totalSupply` | deposits for the epoch |
| `EPOCH_RESULT` (engine → vault) | 2 | `uint64 epochId, uint256 assetsBefore` | redemption payout for the epoch |

## StakeEngine (Bittensor EVM)

Constants: `NETUID_ROOT = 0`, `RAO = 1e9`, `MIN_STAKE_RAO = 2_000_000` (0.002 TAO).

Constructor `(bytes32 coldkey, bytes32 hotkey, ICascadeBridge bridge, address owner, address guardian)`.
Reverts `ZeroColdkey` / `ZeroHotkey` / `ZeroAddress` (bridge or guardian) on zero inputs.
Calls `setRejectStakingHotkeyGrowth(true)`.

State: `coldkey` (immutable), `hotkey`, `bridge`, `guardian`, `lastSettledEpoch` (uint64),
one pending request `{epochId, depositAssets, redeemShares, totalSupply}` plus `hasPending`.

- `totalAssets() view` = `getStake(hotkey, coldkey, 0) * 1e9 + address(this).balance`.
  Unclaimed root rewards are excluded (conservative).
- `onBridgeMessage(message, amount) payable` — only bridge (`NotBridge`); `msg.value == amount`
  (`ValueMismatch`); decodes `EPOCH_REQUEST`; reverts `EpochPending` if one is pending,
  `StaleEpoch` if `epochId <= lastSettledEpoch`, `InvalidRedeem` if `redeemShares > totalSupply`.
  Records the request; emits `EpochReceived(epochId, depositAssets, redeemShares, totalSupply)`.
  Works while paused.
- `settleEpoch() payable` — permissionless, `whenNotPaused`, `nonReentrant`. Reverts
  `NoPendingEpoch` if none.
  1. `assetsBefore = totalAssets() - msg.value - pending.depositAssets`
  2. `redeemAssets = CascadeMath.assetsForRedeem(redeemShares, assetsBefore, totalSupply)`
  3. If `address(this).balance - msg.value < redeemAssets`, unstake
     `min(max(ceil((redeemAssets - available) / 1e9), MIN_STAKE_RAO), rootStakeRao())` rao
     from root. The floor exists because subtensor rejects a partial unstake smaller than
     `DefaultMinStake` (`AmountTooLow`) unless it removes the whole position; without it a
     sub-0.002-TAO shortfall would make every settle revert and freeze the vault. Any excess
     unstaked this way is below `MIN_STAKE_RAO`, so step 8 leaves it idle rather than
     re-staking it. A precompile revert (e.g. root "too early") bubbles up: the whole settle
     reverts and can be retried later.
  4. `fee = bridge.quoteFee(resultMessage, redeemAssets)`; `msg.value < fee` → `InsufficientFee`.
  5. Clear the pending request and set `lastSettledEpoch = epochId` before external sends.
  6. `bridge.send{value: redeemAssets + fee}(encodeResult(epochId, assetsBefore), redeemAssets)`.
  7. Refund `msg.value - fee` to the caller (revert `RefundFailed` on failure).
  8. Stake idle balance (same rule as `stakeIdle`).
  Emits `EpochSettled(epochId, assetsBefore, redeemAssets)`.
- `stakeIdle()` — permissionless, `whenNotPaused`, `nonReentrant`. Stakeable =
  `balance - (hasPending ? pending.depositAssets : 0)`; stakes `stakeable / 1e9` rao to root
  if that is `>= MIN_STAKE_RAO`, otherwise does nothing. Emits `Staked(rao)` when it stakes.
  (Pending deposits stay liquid so anyone calling this cannot force an unstake at settlement.)
- `claimRewards()` — permissionless, `whenNotPaused`, `nonReentrant`. Calls
  `claimRootWithHotkey(hotkey)` (claimed rewards land as root stake). Emits
  `RewardsClaimed(raoGained)` where raoGained is the root stake increase.
- `unclaimedRewards() view` = `getUnclaimedRootTaoByHotkey(coldkey, hotkey)`.
- `setHotkey(bytes32)` — owner. Zero → `ZeroHotkey`. First claims any unclaimed root rewards
  on the old hotkey (`claimRootWithHotkey(old)` when `getUnclaimedRootTaoByHotkey(coldkey, old)
  > 0`, emitting `RewardsClaimed`) so nothing is stranded, then moves the full root stake with
  `moveStake(old, new, 0, 0, rao)` when non-zero. Emits `HotkeySet(old, new)`.
- `setBridge(address)`, `setGuardian(address)` — owner, emit `BridgeSet`, `GuardianSet`.
  Zero address → `ZeroAddress`.
- `pause()` — owner or guardian (`NotGuardian` otherwise). `unpause()` — owner.
- `receive()` reverts `DirectTransferNotAllowed`. No `fallback`.
- No function sends TAO anywhere except `bridge.send` and the fee refund to the settle caller.

## CascadeVault (Base) — also the csTAO share token

ERC-20 name `Cascade Staked TAO`, symbol `csTAO`, decimals `24` (asset 18 + 6).

Constructor `(IERC20Metadata asset, ICascadeBridge bridge, address owner, address guardian,
uint64 epochDuration, uint256 tvlCap, uint256 minDeposit)`. Reverts `UnsupportedDecimals` if
asset decimals != 18. Initial price bounds: `maxAprBps = 2000`, `maxDropBps = 10`.
Epoch ids start at `1`; `currentEpochId` is the open epoch.

Epoch status: `Open → InFlight → Settled`, or `InFlight → Flagged → Settled` (owner accept).
Per epoch: `start`, `totalDeposits`, `totalRedeemShares`, `supplyAtClose`, `assetsBefore`,
`sharesMinted`, `assetsPaid`, `status`. Per user per epoch: `depositOf`, `redeemOf`.
Global: `inFlightEpoch` (0 = none), `lastTotalAssets`, `lastPrice`, `lastPriceTime`.

- `totalAssetsEstimate() view` = `lastTotalAssets + epochs[currentEpochId].totalDeposits +
  (inFlightEpoch != 0 ? epochs[inFlightEpoch].totalDeposits : 0)`.
- `requestDeposit(uint256 assets, address receiver)` — `whenNotPaused`, `nonReentrant`.
  `assets < minDeposit` → `BelowMinDeposit`; `totalAssetsEstimate() + assets > tvlCap` →
  `CapExceeded`; `receiver == 0` → `ZeroAddress`. Pulls assets from msg.sender, credits
  receiver in the open epoch. Emits `DepositRequested(epochId, receiver, assets)`.
- `cancelDeposit(uint256 assets)` — open epoch only, works while paused. More than requested →
  `InsufficientRequest`. Returns assets. Emits `DepositCancelled`.
- `requestRedeem(uint256 shares)` — `whenNotPaused`. Zero → `ZeroAmount`. Escrows shares
  (transfer to the vault). Emits `RedeemRequested(epochId, owner, shares)`.
- `cancelRedeem(uint256 shares)` — open epoch only, works while paused. Returns shares.
  Emits `RedeemCancelled`.
- `closeEpoch() payable` — permissionless, `whenNotPaused`, `nonReentrant`.
  `block.timestamp < start + epochDuration` → `EpochNotOver`; `inFlightEpoch != 0` →
  `EpochInFlight`. If the epoch has no deposits and no redemptions it just restarts its timer
  (`start = now`), refunds msg.value, and emits `EpochRolled(epochId)`. Otherwise: record
  `supplyAtClose = totalSupply()`, mark `InFlight`, set `inFlightEpoch`, open the next epoch,
  approve and `bridge.send{value: fee}(encodeRequest(id, totalRedeemShares, supplyAtClose),
  totalDeposits)`, refund `msg.value - fee`. `msg.value < fee` → `InsufficientFee`. Emits
  `EpochClosed(epochId, totalDeposits, totalRedeemShares, supplyAtClose)`.
- `onBridgeMessage(message, amount)` — only bridge; `msg.value != 0` → `ValueMismatch`;
  decodes `EPOCH_RESULT`; `epochId == 0 || epochId != inFlightEpoch ||
  epochs[epochId].status != InFlight` → `UnexpectedEpoch` (so a duplicate result for a
  `Flagged` epoch cannot overwrite the stored values). Works while paused. Then:
  - `expectedPay = assetsForRedeem(totalRedeemShares, assetsBefore, supplyAtClose)`.
    Amount is OK if `amount <= expectedPay && amount + 1e9 >= expectedPay`.
  - Price is OK if `supplyAtClose == 0` or `lastPriceTime == 0`; otherwise with
    `p = price(assetsBefore, supplyAtClose)`:
    `p >= lastPrice - lastPrice * maxDropBps / 10000` and
    `p <= lastPrice + lastPrice * maxAprBps * (now - lastPriceTime) / (10000 * 365 days) + lastPrice / 1e9 + 1`.
  - Both OK → apply the settlement. Otherwise store `assetsBefore` and `amount`, mark the epoch
    `Flagged`, pause the vault, emit `EpochFlagged(epochId, assetsBefore, amount)`. Never revert
    for a bounds failure.
- Applying a settlement: mint `sharesForDeposit(totalDeposits, assetsBefore, supplyAtClose)` to
  the vault, burn the escrowed `totalRedeemShares`, record `sharesMinted` and
  `assetsPaid = amount`, set `lastTotalAssets = assetsBefore + totalDeposits - amount`,
  `lastPrice = price(lastTotalAssets, totalSupply())`, `lastPriceTime = now`, `inFlightEpoch = 0`,
  status `Settled`. Emits `EpochSettled(epochId, assetsBefore, sharesMinted, assetsPaid)`.
- `acceptFlaggedEpoch()` — owner. The in-flight epoch must be `Flagged` (`NotFlagged`). Applies
  its stored settlement. The vault stays paused until the owner unpauses.
- `claimShares(uint64 epochId)` / `claimAssets(uint64 epochId)` — permissionless for the caller's
  own entitlement, `nonReentrant`, work while paused. Epoch must be `Settled` (`NotSettled`);
  nothing owed → `NothingToClaim`. Shares owed = `depositOf * sharesMinted / totalDeposits`;
  assets owed = `redeemOf * assetsPaid / totalRedeemShares`, rounded down. Zero the user's entry,
  then transfer. Emit `SharesClaimed` / `AssetsClaimed`.
- `claimableShares(epochId, user)`, `claimableAssets(epochId, user)` views (0 unless Settled).
- Owner setters with events: `setCaps(tvlCap, minDeposit)`, `setEpochDuration(uint64)`,
  `setPriceBounds(uint16 maxAprBps, uint16 maxDropBps)` (`maxAprBps <= 10000`,
  `maxDropBps <= 100`, else `InvalidBounds`), `setBridge`, `setGuardian`. `pause()` owner or
  guardian; `unpause()` owner.

## Test doubles (test code only, `contracts/test/mocks/`)

- `MockTAO` — ERC-20 "Bridged TAO" / "TAO", `constructor(uint8 decimals_)` (tests use 18;
  the decimals check test uses 6), public `mint(address,uint256)`.
- `MockStaking` — etched at `0x…0805` with `vm.etch`. Moves native balances with `vm.deal` to
  mirror the real precompile (stake debits the caller, unstake credits it). The caller's
  coldkey is `mirror(address a) = keccak256(abi.encodePacked("evm:", a))` (a stand-in for the
  real blake2 mapping; tests precompute the engine address with `vm.computeCreateAddress` and
  pass `mirror(thatAddress)` to the engine constructor). Reverts `UnexpectedValue` if any
  `msg.value` is sent to a staking call (the real precompile debits balance, never takes
  value). Test helpers: `addHotkey(bytes32)`, `accrueRootReward(bytes32 coldkey, bytes32
  hotkey, uint256 rao)` (becomes claimable), `donateStake(bytes32 hotkey, bytes32 coldkey,
  uint256 rao)`, `setUnstakeBlocked(bool)`, `rejectsGrowth(bytes32 coldkey) view`. Reverts with
  custom errors on: unknown hotkey (`UnknownHotkey`), amount below `MIN_STAKE_RAO` on `addStake`
  (`BelowMinStake`), a partial `removeStake` below `MIN_STAKE_RAO` that does not remove the whole
  position (`BelowMinStake`, mirroring subtensor's `AmountTooLow`), insufficient balance
  (`InsufficientBalance`), insufficient stake (`InsufficientStake`), unstake blocked (`TooEarly`).
- `StubBridge` — records the last `send` (`lastMessage`, `lastAmount`, `lastValue`,
  `sendCount`), returns a settable `fee` from `quoteFee`, reverts `FeeTooLow` if
  `msg.value < fee` (ERC-20 side) or `msg.value < amount + fee` (native side), and on the ERC-20
  side (`constructor(IERC20 token)` with non-zero token) pulls `amount` tokens from the caller.
  Used by the engine and vault unit tests; never delivers anything.
- `MockBridge` — connects the ERC-20 side (vault) and native side (engine) in one EVM.
  `connect(vault, engine)`, `setFee(uint256)`, `setAutoDeliver(bool)` (default true),
  `deliverNext()`, `pendingCount()`. Vault→engine: pulls tokens from the vault, delivers native
  TAO (`vm.deal`) to the engine with the message. Engine→vault: keeps the native TAO, mints
  `MockTAO` to the vault, then calls `onBridgeMessage`.
