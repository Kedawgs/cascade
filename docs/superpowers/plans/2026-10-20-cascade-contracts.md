# Cascade contracts v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the v1 Solidity contracts for Cascade: a Base vault that takes bridged TAO and issues csTAO shares, and a Bittensor EVM engine that holds the root stake — with test doubles, end-to-end tests and invariant tests proving the money flow.

**Architecture:** Two small immutable contracts talk through a minimal bridge interface using two message types. All share pricing goes through one shared library so both chains compute identical numbers. The vault never trusts a share or payout figure from the bridge; it recomputes them and bounds the reported price, flagging and pausing instead of applying anything out of range.

**Tech Stack:** Solidity 0.8.24 (EVM cancun), Foundry (forge 1.7.x), OpenZeppelin Contracts v5.4.0, forge-std.

**Spec:** `docs/superpowers/specs/2026-10-20-cascade-contracts-design.md` (product context in `docs/architecture.md`). The spec is the authority; this plan argues from it.

## Global Constraints

- Solidity `0.8.24`, `evm_version = "cancun"`, OpenZeppelin `v5.4.0` (already in `contracts/lib`). Config in `contracts/foundry.toml` — do not change compiler settings.
- No upgradeable proxies, no `delegatecall`, no arbitrary external calls. The engine sends TAO only via `bridge.send` and the settle-fee refund; the vault moves assets only via `requestDeposit`/`cancelDeposit`/`closeEpoch`/`claimAssets`.
- Admin: `Ownable2Step` owner; guardian may only `pause()`; owner may `pause()`/`unpause()`.
- Every routine function (close, settle, stake idle, claim rewards, claims) is permissionless.
- Custom errors only (no revert strings); an event for every state change named in the spec.
- All share math via `CascadeMath` (`contracts/src/libraries/CascadeMath.sol`, already implemented and tested — never change its formulas).
- Units: vault asset and engine accounting are 18-decimal TAO; precompile amounts are rao (`1 rao = 1e9 wei`). Never pass `msg.value` to the staking precompile.
- Tests: Foundry, test-first. Expected values in tests are literals derived by hand (the plan supplies them), never computed with `CascadeMath` inside the assertion.
- Only `git add` files under `contracts/` and `docs/`. Never `git add -A` (an unrelated web app is being written in `web/` concurrently).
- Commits run from the repo root `E:/projects/cascade`; forge commands run from `E:/projects/cascade/contracts` with `export PATH="$PATH:$HOME/.foundry/bin"`.

## Review Focus

1. A settlement result arriving while the vault is paused must still be accepted and applied — money in flight is never stuck. (Task 5: `test_onBridgeMessage_worksWhilePaused`)
2. Everyone redeems at once (`redeemShares == supplyAtClose`), then new depositors arrive — no false flag, no stuck funds. (Task 5: `test_settle_fullRedeemThenNewDepositDoesNotFlag`)
3. The engine receives an empty request (0 deposits, 0 redeem shares) — it settles cleanly, reports `assetsBefore`, sends amount 0. (Task 3: `test_settleEpoch_emptyRequestStillReports`)
4. A duplicate or late result for an already-settled or flagged epoch is rejected and can never overwrite stored values. (Task 5: `test_onBridgeMessage_duplicateResultReverts`, `test_onBridgeMessage_flaggedEpochRejectsSecondResult`)
5. Claims for an old settled epoch stay claimable after later epochs settle. (Task 5: `test_claimShares_oldEpochStillClaimable`)

## File structure

```
contracts/src/interfaces/IStaking.sol            Task 1  Bittensor precompile subset (verbatim signatures)
contracts/src/interfaces/ICascadeBridge.sol      Task 1  ICascadeBridge + ICascadeReceiver
contracts/src/libraries/CascadeMessages.sol      Task 1  encode/decode the two bridge messages
contracts/src/libraries/CascadeMath.sol          exists  share math
contracts/src/StakeEngine.sol                    Task 3  Bittensor-side engine
contracts/src/CascadeVault.sol                   Task 4+5 Base-side vault and csTAO token
contracts/test/mocks/MockTAO.sol                 Task 2
contracts/test/mocks/MockStaking.sol             Task 2
contracts/test/mocks/StubBridge.sol              Task 3
contracts/test/mocks/MockBridge.sol              Task 6
contracts/test/CascadeMessages.t.sol             Task 1
contracts/test/MockStaking.t.sol                 Task 2
contracts/test/StakeEngine.t.sol                 Task 3
contracts/test/CascadeVault.t.sol                Task 4
contracts/test/CascadeVaultSettlement.t.sol      Task 5
contracts/test/EndToEnd.t.sol                    Task 6
contracts/test/invariants/Handler.sol            Task 7
contracts/test/invariants/Cascade.invariants.t.sol Task 7
contracts/README.md                              Task 7
```

---

### Task 1: Interfaces and bridge messages

**Files:**
- Create: `contracts/src/interfaces/IStaking.sol`
- Create: `contracts/src/interfaces/ICascadeBridge.sol`
- Create: `contracts/src/libraries/CascadeMessages.sol`
- Test: `contracts/test/CascadeMessages.t.sol`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `address constant ISTAKING_ADDRESS = 0x0000000000000000000000000000000000000805;` and `interface IStaking` with exactly the seven functions listed in the spec section "Bittensor staking precompile (subset used)", signatures verbatim, doc comments carrying the units.
  - `interface ICascadeBridge { function send(bytes calldata message, uint256 amount) external payable; function quoteFee(bytes calldata message, uint256 amount) external view returns (uint256); }`
  - `interface ICascadeReceiver { function onBridgeMessage(bytes calldata message, uint256 amount) external payable; }` (same file).
  - `library CascadeMessages` with `uint8 internal constant EPOCH_REQUEST = 1; uint8 internal constant EPOCH_RESULT = 2; error WrongMessageKind(uint8 expected, uint8 actual);` and
    `encodeRequest(uint64 epochId, uint256 redeemShares, uint256 totalSupply) internal pure returns (bytes memory)`,
    `decodeRequest(bytes memory message) internal pure returns (uint64 epochId, uint256 redeemShares, uint256 totalSupply)`,
    `encodeResult(uint64 epochId, uint256 assetsBefore) internal pure returns (bytes memory)`,
    `decodeResult(bytes memory message) internal pure returns (uint64 epochId, uint256 assetsBefore)`,
    `kind(bytes memory message) internal pure returns (uint8)`.
    Encoding is `abi.encode(uint8 kind, fields...)`; decoding a message of the wrong kind reverts `WrongMessageKind(expected, actual)`.

- [ ] **Step 1: Write the failing tests**

`contracts/test/CascadeMessages.t.sol` contains a `MessagesHarness` contract exposing the five library functions as `external` (so `vm.expectRevert` can observe reverts) and these tests:

```solidity
function test_requestRoundTrip() // decodeRequest(encodeRequest(7, 40e24, 100e24)) == (7, 40e24, 100e24)
function test_resultRoundTrip()  // decodeResult(encodeResult(7, 123e18)) == (7, 123e18)
function test_kindOfRequestIsOne()  // kind(encodeRequest(1,0,0)) == 1
function test_kindOfResultIsTwo()   // kind(encodeResult(1,0)) == 2
function test_decodeRequestRejectsResult() // expectRevert(abi.encodeWithSelector(CascadeMessages.WrongMessageKind.selector, 1, 2)); harness.decodeRequest(encodeResult(1, 0))
function test_decodeResultRejectsRequest() // expectRevert(... WrongMessageKind.selector, 2, 1)); harness.decodeResult(encodeRequest(1, 0, 0))
function test_requestEncodingIsAbiEncode() // encodeRequest(7, 40e24, 100e24) == abi.encode(uint8(1), uint64(7), uint256(40e24), uint256(100e24))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `contracts/`): `forge test --match-path test/CascadeMessages.t.sol`
Expected: compilation fails because `CascadeMessages` does not exist.

- [ ] **Step 3: Create the three source files**

`IStaking.sol`: copy the seven signatures from the spec verbatim with their unit comments. `ICascadeBridge.sol`: the two interfaces above. `CascadeMessages.sol`: the library; `decodeRequest`/`decodeResult` read the kind first with `kind()` and revert before decoding the rest.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `forge test --match-path test/CascadeMessages.t.sol -vv`
Expected: 7 passed, 0 failed.

- [ ] **Step 5: Run the whole suite and commit**

Run: `forge test` — expected: all tests pass (9 CascadeMath + 7 messages).

```bash
git add contracts/src/interfaces contracts/src/libraries/CascadeMessages.sol contracts/test/CascadeMessages.t.sol
git commit -m "feat(contracts): staking and bridge interfaces, epoch messages"
```

---

### Task 2: Test doubles for TAO and the staking precompile

**Files:**
- Create: `contracts/test/mocks/MockTAO.sol`
- Create: `contracts/test/mocks/MockStaking.sol`
- Test: `contracts/test/MockStaking.t.sol`

**Interfaces:**
- Consumes: `IStaking`, `ISTAKING_ADDRESS` (Task 1).
- Produces:
  - `contract MockTAO is ERC20 { constructor(uint8 decimals_); function decimals() public view override returns (uint8); function mint(address to, uint256 amount) external; }` name `Bridged TAO`, symbol `TAO`.
  - `contract MockStaking is IStaking` implementing the seven `IStaking` functions per the spec's "Test doubles" section, plus:
    `function mirror(address a) public pure returns (bytes32)` = `keccak256(abi.encodePacked("evm:", a))`;
    `function addHotkey(bytes32 hotkey) external`; `function accrueRootReward(bytes32 coldkey, bytes32 hotkey, uint256 rao) external`; `function donateStake(bytes32 hotkey, bytes32 coldkey, uint256 rao) external`; `function setUnstakeBlocked(bool) external`; `function rejectsGrowth(bytes32 coldkey) external view returns (bool)`;
    errors `UnknownHotkey()`, `BelowMinStake()`, `InsufficientBalance()`, `InsufficientStake()`, `TooEarly()`, `UnexpectedValue()`;
    `uint256 public constant MIN_STAKE_RAO = 2_000_000;`.
    Native balance moves use the forge `Vm` at `address(uint160(uint256(keccak256("hevm cheat code"))))`: `addStake` does `vm.deal(msg.sender, msg.sender.balance - amount * 1e9)`, `removeStake` does `vm.deal(msg.sender, msg.sender.balance + amount * 1e9)`. `getUnclaimedRootTaoByHotkey` returns `unclaimedRao * 1e9`. `claimRootWithHotkey` moves the caller's unclaimed rao for that hotkey into root stake (netuid 0). `moveStake` moves rao between hotkeys/netuids for the caller's coldkey. `setRejectStakingHotkeyGrowth` records the flag for `mirror(msg.sender)`.
  - Test helper pattern every later test uses to install the mock:
    ```solidity
    MockStaking staking;
    function _installStaking() internal {
        MockStaking impl = new MockStaking();
        vm.etch(ISTAKING_ADDRESS, address(impl).code);
        staking = MockStaking(ISTAKING_ADDRESS);
    }
    ```
    (storage lives at the etched address; configure hotkeys etc. through `staking`, not `impl`).

- [ ] **Step 1: Write the failing tests**

`contracts/test/MockStaking.t.sol` uses a `Staker` helper contract (deployed in `setUp`, funded with `vm.deal(address(staker), 10 ether)`) whose external functions forward to the precompile, so `msg.sender` seen by the mock is a contract like the real engine. Tests:

```solidity
function test_addStakeDebitsBalanceAndRecordsStake() // staker.add(hotkey, 3e9, 0): address(staker).balance == 7 ether; staking.getStake(hotkey, staking.mirror(address(staker)), 0) == 3e9
function test_removeStakeCreditsBalance()            // after add 3e9: staker.remove(hotkey, 1e9, 0): balance == 8 ether; stake == 2e9
function test_addStakeBelowMinimumReverts()          // add(hotkey, 1_999_999, 0) reverts BelowMinStake
function test_addStakeUnknownHotkeyReverts()         // add(bytes32("nope"), 3e9, 0) reverts UnknownHotkey
function test_addStakeInsufficientBalanceReverts()   // add(hotkey, 11e9, 0) reverts InsufficientBalance
function test_removeStakeInsufficientStakeReverts()  // remove(hotkey, 1, 0) with no stake reverts InsufficientStake
function test_removeStakeBlockedRevertsTooEarly()    // add 3e9; setUnstakeBlocked(true); remove reverts TooEarly
function test_valueSentToPrecompileReverts()         // staker.addWithValue{value: 1}(...) reverts UnexpectedValue
function test_claimRootMovesUnclaimedIntoRootStake() // accrueRootReward(mirror(staker), hotkey, 5e8): getUnclaimedRootTaoByHotkey == 5e17; staker.claim(hotkey); stake == 5e8; unclaimed == 0
function test_moveStakeBetweenHotkeys()              // add 3e9 to hk1; staker.move(hk1, hk2, 0, 0, 3e9): getStake(hk1)==0, getStake(hk2)==3e9
function test_rejectGrowthFlagIsPerColdkey()         // staker.setReject(true): staking.rejectsGrowth(mirror(staker)) == true; rejectsGrowth(mirror(address(0xBEEF))) == false
function test_donateStakeIncreasesStakeWithoutPayment() // donateStake(hotkey, mirror(staker), 1e9): stake == 1e9, balance unchanged
function test_mockTaoDecimalsFromConstructor()      // new MockTAO(6).decimals() == 6; new MockTAO(18).decimals() == 18
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `forge test --match-path test/MockStaking.t.sol`
Expected: compilation fails (mocks missing).

- [ ] **Step 3: Implement `MockTAO` and `MockStaking`**

Keep `MockStaking` storage simple: `mapping(bytes32 => bool) hotkeys; mapping(bytes32 hotkey => mapping(bytes32 coldkey => mapping(uint256 netuid => uint256))) stakeRao; mapping(bytes32 coldkey => mapping(bytes32 hotkey => uint256)) unclaimedRao; mapping(bytes32 => bool) rejectGrowth; bool unstakeBlocked;`. Every `IStaking` write function starts with `if (msg.value != 0) revert UnexpectedValue();`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `forge test --match-path test/MockStaking.t.sol -vv`
Expected: 13 passed.

- [ ] **Step 5: Run the whole suite and commit**

```bash
git add contracts/test/mocks/MockTAO.sol contracts/test/mocks/MockStaking.sol contracts/test/MockStaking.t.sol
git commit -m "test(contracts): TAO token and staking precompile doubles"
```

---

### Task 3: StakeEngine

**Files:**
- Create: `contracts/src/StakeEngine.sol`
- Create: `contracts/test/mocks/StubBridge.sol`
- Test: `contracts/test/StakeEngine.t.sol`

**Interfaces:**
- Consumes: `IStaking`/`ISTAKING_ADDRESS`, `ICascadeBridge`, `ICascadeReceiver`, `CascadeMessages` (Task 1); `CascadeMath`; `MockStaking` helper pattern (Task 2).
- Produces:
  - `contract StubBridge is ICascadeBridge { constructor(IERC20 token); uint256 public fee; bytes public lastMessage; uint256 public lastAmount; uint256 public lastValue; uint256 public sendCount; error FeeTooLow(); function setFee(uint256) external; function send(bytes calldata, uint256) external payable; function quoteFee(bytes calldata, uint256) external view returns (uint256); }` — behaviour per spec "Test doubles". When `token != address(0)` it is the ERC-20 side: requires `msg.value >= fee` and pulls `amount` tokens with `transferFrom`; otherwise native side: requires `msg.value >= amount + fee`.
  - `contract StakeEngine is ICascadeReceiver, Ownable2Step, Pausable, ReentrancyGuard` with, exactly:
    ```solidity
    uint256 public constant NETUID_ROOT = 0;
    uint256 public constant RAO = 1e9;
    uint256 public constant MIN_STAKE_RAO = 2_000_000;
    IStaking public constant STAKING = IStaking(ISTAKING_ADDRESS);
    bytes32 public immutable coldkey;
    bytes32 public hotkey;
    ICascadeBridge public bridge;
    address public guardian;
    uint64 public lastSettledEpoch;
    bool public hasPending;
    struct PendingEpoch { uint64 epochId; uint256 depositAssets; uint256 redeemShares; uint256 totalSupply; }
    PendingEpoch public pending;
    error NotBridge(); error ValueMismatch(); error EpochPending(); error StaleEpoch(); error InvalidRedeem();
    error NoPendingEpoch(); error InsufficientFee(); error RefundFailed(); error NotGuardian(); error ZeroAddress();
    error DirectTransferNotAllowed();
    event EpochReceived(uint64 indexed epochId, uint256 depositAssets, uint256 redeemShares, uint256 totalSupply);
    event EpochSettled(uint64 indexed epochId, uint256 assetsBefore, uint256 redeemAssets);
    event Staked(uint256 rao); event Unstaked(uint256 rao); event RewardsClaimed(uint256 rao);
    event HotkeySet(bytes32 indexed oldHotkey, bytes32 indexed newHotkey);
    event BridgeSet(address indexed bridge); event GuardianSet(address indexed guardian);
    constructor(bytes32 coldkey_, bytes32 hotkey_, ICascadeBridge bridge_, address owner_, address guardian_);
    function totalAssets() public view returns (uint256);
    function rootStakeRao() public view returns (uint256);          // STAKING.getStake(hotkey, coldkey, 0)
    function unclaimedRewards() external view returns (uint256);    // 18-decimal
    function onBridgeMessage(bytes calldata message, uint256 amount) external payable;
    function settleEpoch() external payable;
    function stakeIdle() external;
    function claimRewards() external;
    function setHotkey(bytes32 newHotkey) external;   // owner
    function setBridge(address) external;             // owner
    function setGuardian(address) external;           // owner
    function pause() external;                        // owner or guardian
    function unpause() external;                      // owner
    receive() external payable;                       // reverts DirectTransferNotAllowed
    ```
    Semantics exactly as the spec's "StakeEngine" section (settle steps 1–8 in that order).

- [ ] **Step 1: Write the failing tests**

`setUp` installs `MockStaking`, registers `HOTKEY = keccak256("validator")` and `HOTKEY2`, deploys `StubBridge(IERC20(address(0)))`, precomputes the engine address with `vm.computeCreateAddress(address(this), vm.getNonce(address(this)))`, sets `COLDKEY = staking.mirror(predicted)`, deploys the engine with `owner = address(this)`, `guardian = GUARDIAN`, and asserts `address(engine) == predicted`. Helper `_deliver(uint64 id, uint256 deposits, uint256 redeemShares, uint256 supply)` does `vm.deal(address(bridge), deposits); vm.prank(address(bridge)); engine.onBridgeMessage{value: deposits}(CascadeMessages.encodeRequest(id, redeemShares, supply), deposits);`. Tests (expected literals are exact):

```solidity
function test_constructorSetsRejectGrowth()               // staking.rejectsGrowth(COLDKEY) == true
function test_constructorRejectsZeroAddresses()           // bridge_ == 0 or guardian_ == 0 → ZeroAddress
function test_onBridgeMessage_onlyBridge()                // prank(0xBAD) → NotBridge
function test_onBridgeMessage_valueMustMatchAmount()      // value 1e18 with amount 2e18 → ValueMismatch
function test_onBridgeMessage_recordsRequest()            // expectEmit EpochReceived(1, 10e18, 0, 0); _deliver(1,10e18,0,0); hasPending; pending == (1,10e18,0,0); engine.balance == 10e18
function test_onBridgeMessage_rejectsSecondWhilePending() // second _deliver → EpochPending
function test_onBridgeMessage_rejectsStaleEpoch()         // settle epoch 1, then _deliver(1,...) → StaleEpoch
function test_onBridgeMessage_rejectsRedeemOverSupply()   // _deliver(1, 0, 5, 4) → InvalidRedeem
function test_onBridgeMessage_worksWhilePaused()          // pause as guardian; _deliver succeeds
function test_settleEpoch_noPendingReverts()              // NoPendingEpoch
function test_settleEpoch_firstDepositStakesEverything()  // _deliver(1,10e18,0,0); expectEmit EpochSettled(1, 0, 0); settleEpoch(); rootStakeRao()==10e9; engine.balance==0; !hasPending; lastSettledEpoch==1; bridge.lastAmount==0; bridge.lastMessage == encodeResult(1, 0); bridge.sendCount==1
function test_settleEpoch_emptyRequestStillReports()      // after 10 TAO staked: _deliver(2,0,0,10e24); settle → emits EpochSettled(2, 10e18, 0); bridge.lastAmount == 0
function test_settleEpoch_reportsAssetsBeforeExcludingNewDeposits() // 10 TAO staked; staking.donateStake(HOTKEY, COLDKEY, 1e9); _deliver(2, 5e18, 0, 10e24); settle → EpochSettled(2, 11e18, 0); rootStakeRao()==16e9
function test_settleEpoch_redeemUsesIdleThenUnstakes()    // 10 TAO staked; _deliver(2, 4e18, 5e24, 10e24); settle → EpochSettled(2, 10e18, 5e18); expectEmit Unstaked(1e9); bridge.lastAmount==5e18; bridge.lastValue==5e18; rootStakeRao()==9e9; engine.balance==0; bridge.lastMessage==encodeResult(2,10e18)
function test_settleEpoch_redeemWithoutIdleUnstakesAll()  // 10 TAO staked; _deliver(2, 0, 10e24, 10e24); expectEmit Unstaked(10e9); settle → EpochSettled(2, 10e18, 10e18) (10e24*(10e18+1)/(10e24+1e6) == 10e18 exactly because 10e24+1e6 == 1e6*(10e18+1)); rootStakeRao()==0; engine.balance==0; bridge.lastAmount==10e18
function test_settleEpoch_unstakeBlockedRevertsAndKeepsPending() // as redeem test but staking.setUnstakeBlocked(true) → revert MockStaking.TooEarly; hasPending still true
function test_settleEpoch_insufficientFeeReverts()        // bridge.setFee(0.01 ether); settleEpoch{value: 0}() → InsufficientFee
function test_settleEpoch_refundsExcessFee()              // fee 0.01 ether; caller funded 1 ether; settleEpoch{value: 0.05 ether}(); caller.balance == 0.99 ether; bridge.lastValue == redeemAssets + 0.01 ether
function test_settleEpoch_whenPausedReverts()             // Pausable.EnforcedPause
function test_stakeIdle_keepsPendingDepositsLiquid()      // _deliver(1,10e18,0,0); stakeIdle(); rootStakeRao()==0; engine.balance==10e18
function test_stakeIdle_ignoresBelowMinimum()             // vm.deal(engine, 1_999_999 * 1e9); stakeIdle(); rootStakeRao()==0
function test_stakeIdle_stakesAtMinimum()                 // vm.deal(engine, 2_000_000 * 1e9); expectEmit Staked(2_000_000); stakeIdle(); rootStakeRao()==2_000_000; balance==0
function test_claimRewards_movesUnclaimedIntoRootStake()  // 10 TAO staked; accrueRootReward(COLDKEY, HOTKEY, 5e8); unclaimedRewards()==5e17; expectEmit RewardsClaimed(5e8); claimRewards(); rootStakeRao()==10e9+5e8; unclaimedRewards()==0; totalAssets()==10e18+5e17
function test_totalAssets_sumsStakeAndBalance()           // 10 TAO staked + vm.deal(engine, 1e18) → 11e18
function test_setHotkey_movesStakeAndEmits()              // 10 TAO staked; expectEmit HotkeySet(HOTKEY,HOTKEY2); setHotkey(HOTKEY2); getStake(HOTKEY)==0; rootStakeRao()==10e9 (now under HOTKEY2)
function test_setHotkey_onlyOwner()                       // prank(0xBAD) → Ownable.OwnableUnauthorizedAccount
function test_setBridge_zeroReverts()                     // ZeroAddress
function test_pause_guardianCanPauseButNotUnpause()       // prank GUARDIAN pause ok; prank GUARDIAN unpause → OwnableUnauthorizedAccount; prank(0xBAD) pause → NotGuardian
function test_receive_rejectsDirectTransfer()             // (bool ok,) = address(engine).call{value: 1}(""); assertFalse(ok)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `forge test --match-path test/StakeEngine.t.sol`
Expected: compilation fails (`StakeEngine`, `StubBridge` missing).

- [ ] **Step 3: Implement `StubBridge`, then `StakeEngine`**

Settle order matters for safety: compute, unstake if needed, quote fee, clear pending + bump `lastSettledEpoch`, `bridge.send`, refund, then stake idle. Unstake amount in rao is `(shortfallWei + RAO - 1) / RAO`. `stakeIdle` logic lives in an internal `_stakeIdle()` reused by `settleEpoch`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `forge test --match-path test/StakeEngine.t.sol -vv`
Expected: 29 passed.

- [ ] **Step 5: Run the whole suite and commit**

```bash
git add contracts/src/StakeEngine.sol contracts/test/mocks/StubBridge.sol contracts/test/StakeEngine.t.sol
git commit -m "feat(contracts): StakeEngine holds root stake and settles epochs"
```

---

### Task 4: CascadeVault — shares, deposits, epochs, admin

**Files:**
- Create: `contracts/src/CascadeVault.sol`
- Test: `contracts/test/CascadeVault.t.sol`

**Interfaces:**
- Consumes: `ICascadeBridge`, `ICascadeReceiver`, `CascadeMessages` (Task 1); `CascadeMath`; `MockTAO`, `StubBridge` (Tasks 2–3).
- Produces (the full surface below; this task implements everything NOT marked "Task 5". The Task-5 functions are left out of the contract entirely in this task — no placeholder bodies — except `onBridgeMessage`, which `ICascadeReceiver` requires: see the note after the listing):
  ```solidity
  contract CascadeVault is ERC20, ICascadeReceiver, Ownable2Step, Pausable, ReentrancyGuard {
      enum EpochStatus { Open, InFlight, Flagged, Settled }
      struct Epoch { uint64 start; EpochStatus status; uint256 totalDeposits; uint256 totalRedeemShares;
                     uint256 supplyAtClose; uint256 assetsBefore; uint256 sharesMinted; uint256 assetsPaid; }
      IERC20 public immutable asset;
      ICascadeBridge public bridge; address public guardian;
      uint64 public epochDuration; uint256 public tvlCap; uint256 public minDeposit;
      uint16 public maxAprBps; uint16 public maxDropBps;              // 2000, 10 initially
      uint64 public currentEpochId; uint64 public inFlightEpoch;      // ids start at 1; 0 = none in flight
      uint256 public lastTotalAssets; uint256 public lastPrice; uint64 public lastPriceTime;
      mapping(uint64 => mapping(address => uint256)) public depositOf;
      mapping(uint64 => mapping(address => uint256)) public redeemOf;
      error UnsupportedDecimals(); error BelowMinDeposit(); error CapExceeded(); error ZeroAddress(); error ZeroAmount();
      error InsufficientRequest(); error EpochNotOver(); error EpochInFlight(); error InsufficientFee(); error RefundFailed();
      error NotBridge(); error ValueMismatch(); error UnexpectedEpoch(); error NotFlagged(); error NotSettled();
      error NothingToClaim(); error InvalidBounds(); error NotGuardian();
      event DepositRequested(uint64 indexed epochId, address indexed receiver, uint256 assets);
      event DepositCancelled(uint64 indexed epochId, address indexed owner, uint256 assets);
      event RedeemRequested(uint64 indexed epochId, address indexed owner, uint256 shares);
      event RedeemCancelled(uint64 indexed epochId, address indexed owner, uint256 shares);
      event EpochRolled(uint64 indexed epochId);
      event EpochClosed(uint64 indexed epochId, uint256 totalDeposits, uint256 totalRedeemShares, uint256 supplyAtClose);
      event EpochSettled(uint64 indexed epochId, uint256 assetsBefore, uint256 sharesMinted, uint256 assetsPaid);
      event EpochFlagged(uint64 indexed epochId, uint256 assetsBefore, uint256 amount);
      event SharesClaimed(uint64 indexed epochId, address indexed user, uint256 shares);
      event AssetsClaimed(uint64 indexed epochId, address indexed user, uint256 assets);
      event CapsSet(uint256 tvlCap, uint256 minDeposit); event EpochDurationSet(uint64 epochDuration);
      event PriceBoundsSet(uint16 maxAprBps, uint16 maxDropBps); event BridgeSet(address indexed bridge); event GuardianSet(address indexed guardian);
      constructor(IERC20Metadata asset_, ICascadeBridge bridge_, address owner_, address guardian_, uint64 epochDuration_, uint256 tvlCap_, uint256 minDeposit_);
      function decimals() public pure override returns (uint8);        // 24
      function epochs(uint64 id) external view returns (Epoch memory);
      function totalAssetsEstimate() public view returns (uint256);
      function requestDeposit(uint256 assets, address receiver) external;
      function cancelDeposit(uint256 assets) external;
      function requestRedeem(uint256 shares) external;                  // Task 5
      function cancelRedeem(uint256 shares) external;                   // Task 5
      function closeEpoch() external payable;
      function onBridgeMessage(bytes calldata message, uint256 amount) external payable; // Task 5
      function acceptFlaggedEpoch() external;                           // Task 5
      function claimShares(uint64 epochId) external;                    // Task 5
      function claimAssets(uint64 epochId) external;                    // Task 5
      function claimableShares(uint64 epochId, address user) external view returns (uint256); // Task 5
      function claimableAssets(uint64 epochId, address user) external view returns (uint256); // Task 5
      function setCaps(uint256 tvlCap_, uint256 minDeposit_) external; function setEpochDuration(uint64) external;
      function setPriceBounds(uint16 maxAprBps_, uint16 maxDropBps_) external; function setBridge(address) external; function setGuardian(address) external;
      function pause() external; function unpause() external;
  }
  ```
  Note on `onBridgeMessage`: in this task implement it with only the access checks (`NotBridge`, `ValueMismatch`) followed by `revert UnexpectedEpoch()`; Task 5 replaces its body. `_epochs[currentEpochId].start` is set to `block.timestamp` when an epoch opens. ERC-20 name `Cascade Staked TAO`, symbol `csTAO`.

- [ ] **Step 1: Write the failing tests**

`setUp`: `tao = new MockTAO(18)`, `bridge = new StubBridge(IERC20(tao))`, `FEE = 0.001 ether`, `bridge.setFee(FEE)`, vault with `epochDuration = 1 days`, `tvlCap = 1000e18`, `minDeposit = 1e18`, owner `address(this)`, guardian `GUARDIAN`; `alice`, `bob` minted `1_000e18` TAO each with the vault approved, and `vm.deal`ed 1 ether each for fees; the test contract itself holds 10 ether. Tests:

```solidity
function test_constructorRejectsNon18Decimals()      // new MockTAO(6) → UnsupportedDecimals
function test_tokenMetadata()                        // name "Cascade Staked TAO", symbol "csTAO", decimals 24; currentEpochId == 1; epochs(1).start == block.timestamp; maxAprBps==2000; maxDropBps==10
function test_requestDeposit_pullsAssetsAndCredits() // expectEmit DepositRequested(1, alice, 100e18); alice requestDeposit(100e18, alice): tao.balanceOf(vault)==100e18; depositOf(1,alice)==100e18; epochs(1).totalDeposits==100e18; totalAssetsEstimate()==100e18
function test_requestDeposit_creditsReceiverNotSender() // alice requestDeposit(100e18, bob): depositOf(1,bob)==100e18; depositOf(1,alice)==0
function test_requestDeposit_belowMinReverts()       // 1e18 - 1 → BelowMinDeposit
function test_requestDeposit_capExceededReverts()    // alice 500e18 ok; bob 500e18 ok; alice 1e18 → CapExceeded (cap 1000e18)
function test_requestDeposit_zeroReceiverReverts()   // ZeroAddress
function test_requestDeposit_whenPausedReverts()     // EnforcedPause
function test_cancelDeposit_returnsAssets()          // deposit 100e18; expectEmit DepositCancelled(1, alice, 40e18); cancelDeposit(40e18): alice balance 940e18; depositOf 60e18; totalDeposits 60e18
function test_cancelDeposit_tooMuchReverts()         // deposit 100e18; cancel 100e18+1 → InsufficientRequest
function test_cancelDeposit_worksWhilePaused()       // pause; cancel succeeds
function test_cancelDeposit_afterCloseReverts()      // deposit; warp 1 days; closeEpoch{value: FEE}; cancelDeposit(1) → InsufficientRequest
function test_closeEpoch_beforeDurationReverts()     // EpochNotOver
function test_closeEpoch_emptyEpochRolls()           // warp 1 days + 1; expectEmit EpochRolled(1); closeEpoch{value: FEE}(): currentEpochId==1; epochs(1).start==block.timestamp; caller balance unchanged (full refund); bridge.sendCount==0
function test_closeEpoch_sendsDepositsAndOpensNext() // deposit 100e18; warp; expectEmit EpochClosed(1, 100e18, 0, 0); closeEpoch{value: FEE}(): bridge.lastAmount==100e18; bridge.lastMessage==encodeRequest(1,0,0); bridge.lastValue==FEE; tao.balanceOf(vault)==0; tao.balanceOf(bridge)==100e18; currentEpochId==2; inFlightEpoch==1; epochs(1).status==InFlight; epochs(1).supplyAtClose==0; epochs(2).start==block.timestamp; totalAssetsEstimate()==100e18
function test_closeEpoch_whileInFlightReverts()      // close once; warp again; close → EpochInFlight
function test_closeEpoch_insufficientFeeReverts()    // bridge.setFee(FEE); closeEpoch{value: FEE-1} → InsufficientFee
function test_closeEpoch_refundsExcess()             // closeEpoch{value: FEE + 1 ether}: caller paid exactly FEE
function test_closeEpoch_whenPausedReverts()         // EnforcedPause
function test_closeEpoch_permissionless()            // prank(0xCAFE) with funds closes successfully
function test_onBridgeMessage_onlyBridge()           // prank(0xBAD) → NotBridge
function test_onBridgeMessage_withValueReverts()     // prank(bridge) value 1 → ValueMismatch
function test_setPriceBounds_validatesAndEmits()     // (10001, 10) → InvalidBounds; (2000, 101) → InvalidBounds; expectEmit PriceBoundsSet(1500, 20); set ok
function test_setCaps_emitsAndApplies()              // setCaps(10e18, 2e18); requestDeposit(1.5e18) → BelowMinDeposit; requestDeposit(11e18) → CapExceeded
function test_setEpochDuration_applies()             // setEpochDuration(2 days); warp 1 days+1; closeEpoch → EpochNotOver
function test_setBridge_zeroReverts()                // ZeroAddress; non-owner → OwnableUnauthorizedAccount
function test_pause_guardianCanPauseButNotUnpause()  // as in engine
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `forge test --match-path test/CascadeVault.t.sol`
Expected: compilation fails (`CascadeVault` missing).

- [ ] **Step 3: Implement `CascadeVault` (this task's scope)**

`closeEpoch` order: checks → if empty: `start = now`, refund all `msg.value`, emit `EpochRolled`, return → else record `supplyAtClose`, status `InFlight`, `inFlightEpoch = id`, `currentEpochId = id + 1` with `start = now`, `fee = bridge.quoteFee(msg_, totalDeposits)`, `msg.value < fee → InsufficientFee`, `asset.forceApprove(bridge, totalDeposits)`, `bridge.send{value: fee}(msg_, totalDeposits)`, refund `msg.value - fee`, emit `EpochClosed`. Use `SafeERC20`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `forge test --match-path test/CascadeVault.t.sol -vv`
Expected: 28 passed.

- [ ] **Step 5: Run the whole suite and commit**

```bash
git add contracts/src/CascadeVault.sol contracts/test/CascadeVault.t.sol
git commit -m "feat(contracts): CascadeVault deposits, epochs and admin"
```

---

### Task 5: CascadeVault — settlement, bounds, flagging, redemptions and claims

**Files:**
- Modify: `contracts/src/CascadeVault.sol`
- Test: `contracts/test/CascadeVaultSettlement.t.sol`

**Interfaces:**
- Consumes: everything from Task 4.
- Produces: the Task-5-marked functions of the Task 4 surface, with semantics exactly as the spec's "CascadeVault" section (`onBridgeMessage` checks, amount check, price check, apply, `acceptFlaggedEpoch`, `claimShares`, `claimAssets`, `claimableShares`, `claimableAssets`, `requestRedeem`, `cancelRedeem`). Internal helper `_applySettlement(uint64 epochId, uint256 assetsBefore, uint256 amount)` shared by `onBridgeMessage` and `acceptFlaggedEpoch`.

- [ ] **Step 1: Write the failing tests**

Same `setUp` as Task 4 plus helpers: `_closeWithDeposit(address who, uint256 assets)` (deposit, warp `1 days + 1`, `closeEpoch{value: FEE}`), `_settle(uint64 id, uint256 assetsBefore, uint256 amount)` (`tao.mint(vault, amount)` if `amount > 0`; `vm.prank(bridge)`; `vault.onBridgeMessage(CascadeMessages.encodeResult(id, assetsBefore), amount)`). Fixture `_firstEpoch()` = `_closeWithDeposit(alice, 100e18); _settle(1, 0, 0);`. Tests:

```solidity
function test_settle_firstEpochMintsAtOffsetPrice()      // _closeWithDeposit(alice,100e18); expectEmit EpochSettled(1, 0, 100e24, 0); _settle(1,0,0): epochs(1).status==Settled; sharesMinted==100e24; balanceOf(vault)==100e24; lastTotalAssets==100e18; lastPrice==1e12; lastPriceTime==block.timestamp; inFlightEpoch==0
function test_claimShares_paysEntitlement()              // _firstEpoch(); expectEmit SharesClaimed(1, alice, 100e24); alice claimShares(1): balanceOf(alice)==100e24; second claim → NothingToClaim; claimableShares(1,alice)==0 after
function test_claimShares_beforeSettledReverts()         // _closeWithDeposit(alice,100e18); claimShares(1) → NotSettled; claimableShares(1,alice)==0
function test_claimShares_twoDepositorsProRata()         // alice 100e18 + bob 300e18 in epoch 1; settle(1,0,0) → sharesMinted 400e24; alice claims 100e24, bob 300e24
function test_claimShares_worksWhilePaused()             // _firstEpoch(); pause; alice claims ok
function test_claimShares_oldEpochStillClaimable()       // _firstEpoch() (alice doesn't claim); epoch 2: bob 100e18, close, warp, settle(2, 100e18, 0); alice claimShares(1) == 100e24
function test_onBridgeMessage_wrongEpochReverts()        // _closeWithDeposit; _settle(2, ...) → UnexpectedEpoch; _settle(0,...) → UnexpectedEpoch
function test_onBridgeMessage_duplicateResultReverts()   // _firstEpoch(); _settle(1, 0, 0) again → UnexpectedEpoch
function test_onBridgeMessage_worksWhilePaused()         // _closeWithDeposit; pause; _settle(1,0,0) succeeds, status Settled
function test_settle_rewardsRaisePriceWithinBounds()     // _firstEpoch(); alice claims; warp 1 days; _closeWithDeposit(bob, 100e18) [epoch 2]; _settle(2, 100.05e18, 0): status Settled (not flagged); lastPrice > 1e12; assertApproxEqRel(epochs(2).sharesMinted, 99950024987506246876561, 1e9)  // 100e18*(100e24+1e6)/(100.05e18+1)
function test_settle_priceDropFlagsAndPauses()           // _firstEpoch(); alice claims; warp 1 days; _closeWithDeposit(bob,100e18); expectEmit EpochFlagged(2, 99e18, 0); _settle(2, 99e18, 0): status Flagged; paused(); inFlightEpoch==2; totalSupply()==100e24 (nothing minted); epochs(2).assetsBefore==99e18
function test_settle_priceJumpFlags()                    // same but assetsBefore 110e18 → Flagged
function test_settle_tinyGrowthAllowedByToleranceTerm()  // same fixture but warp only 1 second before close: assetsBefore 100e18 + 1e9 (1 gwei) → Settled, not flagged  (lastPrice/1e9 + 1 tolerance)
function test_onBridgeMessage_flaggedEpochRejectsSecondResult() // after flag: _settle(2, 100e18, 0) → UnexpectedEpoch; epochs(2).assetsBefore still 99e18
function test_acceptFlaggedEpoch_appliesStoredValues()   // after flag (99e18): expectEmit EpochSettled(2, 99e18, sharesMinted, 0); owner acceptFlaggedEpoch(): status Settled; paused() still true; inFlightEpoch==0; sharesMinted == 101010101010101010101010 (= 100e18*(100e24+1e6)/(99e18+1), assertApproxEqRel 1e9)
function test_acceptFlaggedEpoch_onlyOwnerAndOnlyFlagged() // non-owner → OwnableUnauthorizedAccount; nothing flagged → NotFlagged
function test_requestRedeem_escrowsShares()              // _firstEpoch(); alice claims; expectEmit RedeemRequested(2, alice, 40e24); requestRedeem(40e24): balanceOf(alice)==60e24; balanceOf(vault)==40e24; redeemOf(2,alice)==40e24; epochs(2).totalRedeemShares==40e24
function test_requestRedeem_zeroReverts()                // ZeroAmount
function test_requestRedeem_whenPausedReverts()          // EnforcedPause
function test_cancelRedeem_returnsShares()               // after request 40e24: expectEmit RedeemCancelled(2, alice, 15e24); cancelRedeem(15e24): balanceOf(alice)==75e24; redeemOf==25e24; cancel 25e24+1 → InsufficientRequest; cancel works while paused
function test_closeEpoch_sendsRedeemSharesAndSupply()    // after request 40e24: warp; closeEpoch: bridge.lastMessage == encodeRequest(2, 40e24, 100e24); bridge.lastAmount == 0
function test_settle_redeemBurnsEscrowAndPaysOut()       // ... _settle(2, 100e18, 40e18): expectEmit EpochSettled(2, 100e18, 0, 40e18); totalSupply()==60e24; balanceOf(vault)==0; epochs(2).assetsPaid==40e18; lastTotalAssets==60e18; lastPrice==1e12; claimableAssets(2,alice)==40e18; expectEmit AssetsClaimed(2, alice, 40e18); alice claimAssets(2): tao.balanceOf(alice)==940e18; second claim → NothingToClaim
function test_settle_payoutShortByMoreThanToleranceFlags() // redeem 40e24 epoch; _settle(2, 100e18, 40e18 - 1e9 - 1) → Flagged
function test_settle_payoutWithinToleranceSettles()       // _settle(2, 100e18, 40e18 - 1e9) → Settled; assetsPaid == 40e18 - 1e9
function test_settle_overpaymentFlags()                   // _settle(2, 100e18, 40e18 + 1) → Flagged
function test_settle_fullRedeemThenNewDepositDoesNotFlag() // alice redeems all 100e24; close; _settle(2, 100e18, 100e18) (100e24*(100e18+1)/(100e24+1e6) == 100e18 exactly) → Settled, totalSupply()==0, lastTotalAssets==0, alice claimAssets(2) gets 100e18; then epoch 3: bob 100e18, close, _settle(3, 1000, 0) (engine reports 1000 wei of leftover dust) → Settled (supplyAtClose==0 skips the price check); bob claims 100e18*(0+1e6)/(1000+1) shares: assertApproxEqRel(balanceOf(bob), 99900099900099900099900, 1e9)
function test_claimAssets_twoRedeemersProRata()           // alice and bob both hold shares (epoch 1: 100e18 each → 100e24 each); epoch 2: alice redeems 50e24, bob 100e24; _settle(2, 200e18, 150e18): alice claimAssets → 50e18; bob → 100e18
function test_claimAssets_zeroEntitlementReverts()        // bob never redeemed; bob claimAssets(2) → NothingToClaim
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `forge test --match-path test/CascadeVaultSettlement.t.sol`
Expected: tests fail (functions missing or `UnexpectedEpoch` from the Task 4 placeholder).

- [ ] **Step 3: Implement the settlement functions in `CascadeVault.sol`**

Upper price bound uses integer math in this order to avoid overflow: `lastPrice + Math.mulDiv(lastPrice, uint256(maxAprBps) * (block.timestamp - lastPriceTime), 10000 * 365 days) + lastPrice / 1e9 + 1`. Flagging stores `assetsBefore` and `assetsPaid = amount` on the epoch, sets status `Flagged`, calls `_pause()` (only if not already paused), emits `EpochFlagged` — and never reverts.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `forge test --match-path test/CascadeVaultSettlement.t.sol -vv`
Expected: 30 passed.

- [ ] **Step 5: Run the whole suite and commit**

Run: `forge test` — all green.

```bash
git add contracts/src/CascadeVault.sol contracts/test/CascadeVaultSettlement.t.sol
git commit -m "feat(contracts): vault settlement with price bounds, flagging and claims"
```

---

### Task 6: MockBridge and end-to-end tests

**Files:**
- Create: `contracts/test/mocks/MockBridge.sol`
- Test: `contracts/test/EndToEnd.t.sol`

**Interfaces:**
- Consumes: `CascadeVault`, `StakeEngine`, `MockTAO`, `MockStaking`, `CascadeMessages`.
- Produces: `contract MockBridge is ICascadeBridge` with `constructor(MockTAO token)`, `function connect(address vault, address payable engine) external`, `function setFee(uint256) external`, `function setAutoDeliver(bool) external` (default true), `function deliverNext() external`, `function pendingCount() external view returns (uint256)`, `error FeeTooLow(); error UnknownSender(); error NothingPending();`. Behaviour per spec "Test doubles → MockBridge": vault→engine pulls tokens from the vault and delivers native TAO with `engine.onBridgeMessage{value: amount}` (after `vm.deal(address(this), address(this).balance + amount)`); engine→vault keeps the native TAO, `token.mint(vault, amount)`, then `vault.onBridgeMessage(message, amount)`. Deliveries are FIFO.

- [ ] **Step 1: Write the failing tests**

`setUp` wires everything: `MockStaking` installed, `HOTKEY` registered, `tao = new MockTAO(18)`, `bridge = new MockBridge(tao)`, engine deployed at a precomputed address with `COLDKEY = staking.mirror(predicted)`, vault with `1 days`, cap `10_000e18`, min `1e18`, `bridge.connect(vault, engine)`, `FEE = 0.001 ether` on the bridge, alice/bob/carol funded with 1_000e18 TAO and 1 ether of gas each, approvals set. Helpers `_deposit(user, amount)`, `_close()` (warp `1 days + 1`, `closeEpoch{value: FEE}`), `_settle()` (`engine.settleEpoch{value: FEE}()`). Tests:

```solidity
function test_e2e_depositCloseSettleClaim()       // alice 100e18; _close(): engine.hasPending, engine.balance==100e18; _settle(): vault epochs(1) Settled; engine.rootStakeRao()==100e9; engine.balance==0; alice claimShares(1) → 100e24; tao.balanceOf(vault)==0; bridge.pendingCount()==0
function test_e2e_rewardsRaiseSharePrice()        // after above: staking.accrueRootReward(COLDKEY, HOTKEY, 1e8) (0.1 TAO); engine.claimRewards(); bob 100e18; _close(); _settle(): assetsBefore reported 100.1e18; bob claims shares < alice's: assertApproxEqRel(balanceOf(bob), 99900099900099900099900, 1e9); vault.lastPrice > 1e12
function test_e2e_redeemRoundTrip()               // after first epoch: alice requestRedeem(50e24); _close(); _settle(): engine.rootStakeRao()==50e9 (unstaked 50e9); alice claimAssets(2): tao.balanceOf(alice) == 900e18 + 50e18 exactly (50e24*(100e18+1)/(100e24+1e6) == 50e18)
function test_e2e_depositAndRedeemSameEpochNetsOnEngine() // epoch 1: alice 100e18. epoch 2: bob deposits 60e18, alice redeems 50e24 → _settle(): no Unstaked event (expect no unstake: rootStakeRao()==110e9), bob gets ≈60e24, alice gets 50e18
function test_e2e_manualDeliveryOrder()           // setAutoDeliver(false): alice deposit; _close(): pendingCount()==1, !engine.hasPending; deliverNext(): engine.hasPending; _settle(): pendingCount()==1, vault epochs(1) InFlight; deliverNext(): Settled; deliverNext() → NothingPending
function test_e2e_unexpectedStakeJumpFlagsAndOwnerAccepts() // after epoch 1 settled; warp 1 days; staking.donateStake(HOTKEY, COLDKEY, 5e9) (5% jump); bob 100e18; _close(); _settle(): vault epochs(2) Flagged, vault.paused(); vault.acceptFlaggedEpoch(); vault.unpause(); bob claimShares(2) ≈ 95238095238095238095238 (100e18*(100e24+1e6)/(105e18+1), 1e9 rel)
function test_e2e_unstakeBlockedCanRetryLater()   // redeem epoch; staking.setUnstakeBlocked(true); _settle() reverts TooEarly; vault epochs(2) still InFlight; setUnstakeBlocked(false); _settle() ok → Settled
function test_e2e_vaultPausedStillReceivesResult() // deposit; _close(); vault.pause() by guardian; _settle(): epochs(1) Settled; alice claims
function test_e2e_allValueLeavingEngineReachesTheBridge() // run the redeem round trip (epoch 1: alice 100e18; epoch 2: alice redeems 50e24; two closes, two settles): address(engine).balance == 0 and address(bridge).balance == 50e18 + 4 * FEE (two close fees + two settle fees + the 50e18 payout; the bridge's own vault→engine deliveries are value-neutral because it deals itself the amount it forwards)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `forge test --match-path test/EndToEnd.t.sol`
Expected: compilation fails (`MockBridge` missing).

- [ ] **Step 3: Implement `MockBridge`**

Store a queue of `Delivery { address to; bytes message; uint256 amount; bool native; }`; `send` enqueues (after fee/pull checks) and, if `autoDeliver`, calls `deliverNext()` immediately. Identify the side by `msg.sender == vault` / `msg.sender == engine`, else `UnknownSender`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `forge test --match-path test/EndToEnd.t.sol -vv`
Expected: 9 passed.

- [ ] **Step 5: Run the whole suite and commit**

```bash
git add contracts/test/mocks/MockBridge.sol contracts/test/EndToEnd.t.sol
git commit -m "test(contracts): mock bridge and end-to-end epoch cycles"
```

---

### Task 7: Invariant tests and README

**Files:**
- Create: `contracts/test/invariants/Handler.sol`
- Create: `contracts/test/invariants/Cascade.invariants.t.sol`
- Create: `contracts/README.md`

**Interfaces:**
- Consumes: the full Task 6 wiring.
- Produces: a `Handler` contract with bounded, `try/catch`-guarded actions over three actors (`deposit(actorSeed, amount)`, `cancelDeposit(actorSeed, amount)`, `redeem(actorSeed, shares)`, `cancelRedeem(actorSeed, shares)`, `closeEpoch()` (warps past the epoch first), `settle()`, `claimShares(actorSeed, epochId)`, `claimAssets(actorSeed, epochId)`, `accrueAndClaimRewards(rao)` (skipped while `vault.lastPriceTime() == 0`; otherwise bounded so that `accruedSinceSettle + rao <= engine.rootStakeRao() * 1000 * (block.timestamp - vault.lastPriceTime()) / (10000 * 365 days)`, i.e. at most a 10% APR — half the vault's 20% bound — accumulated since the last settlement; `accruedSinceSettle` resets to 0 on each successful `settle()`), `warp(seconds)` bounded `1..12 hours`) and ghost totals `claimedShares`, `claimedAssets`, `paidAssets` (Σ `assetsPaid` over settled epochs), `mintedShares` (Σ `sharesMinted`), `lastSeenPrice`, `accruedSinceSettle`.

- [ ] **Step 1: Write the failing invariants**

In `Cascade.invariants.t.sol` (`setUp` wires like Task 6, `targetContract(address(handler))`, selectors via `targetSelector`):

```solidity
function invariant_priceNeverDecreases()     // if vault.lastPrice() != 0: vault.lastPrice() >= handler.lastSeenPrice(); handler updates lastSeenPrice after each successful settle
function invariant_vaultAssetsCoverObligations() // tao.balanceOf(vault) == epochs(currentEpochId).totalDeposits + handler.paidAssets() - handler.claimedAssets()
function invariant_shareEscrowIsExact()      // vault.balanceOf(vault) == epochs(current).totalRedeemShares + (inFlight != 0 ? epochs(inFlight).totalRedeemShares : 0) + handler.mintedShares() - handler.claimedShares()
function invariant_engineHoldsNoIdleWithoutPending() // if !engine.hasPending(): engine.balance < 2_000_000 * 1e9
function invariant_noEpochFlagged()          // with bounded rewards nothing should ever flag: for all ids <= currentEpochId, status != Flagged
function invariant_atMostOneInFlight()       // inFlightEpoch == 0 || epochs(inFlightEpoch).status == InFlight
```

- [ ] **Step 2: Run to verify they fail or error**

Run: `forge test --match-path "test/invariants/*"`
Expected: compilation fails (`Handler` missing).

- [ ] **Step 3: Implement `Handler`**

Actors are three fixed addresses funded in the handler constructor (TAO + gas). Every action wraps the vault/engine call in `try/catch` and only updates ghost state on success. `settle()` calls `engine.settleEpoch{value: fee}()` and, on success, records the vault's new `lastPrice` and adds the settled epoch's `sharesMinted`/`assetsPaid` to the ghosts (read from `vault.epochs(id)`).

- [ ] **Step 4: Run the invariants and make them pass**

Run: `forge test --match-path "test/invariants/*" -vv`
Expected: 6 passed (runs 128, depth 64, per `foundry.toml`). If an invariant fails, it is either a real bug (fix the contract with a failing unit test first) or a handler accounting error — determine which from the counterexample before changing anything.

- [ ] **Step 5: Write `contracts/README.md`**

Short: what each contract does (3 lines), how to run `forge build` / `forge test` / `forge test --match-path "test/invariants/*"`, the epoch lifecycle in 5 lines, the trust table from `docs/architecture.md`, and the "open questions before mainnet" list copied from `docs/architecture.md`.

- [ ] **Step 6: Run the whole suite and commit**

Run: `forge test` — all green, no warnings about unused variables in `src/`.

```bash
git add contracts/test/invariants contracts/README.md
git commit -m "test(contracts): invariant suite and README"
```
