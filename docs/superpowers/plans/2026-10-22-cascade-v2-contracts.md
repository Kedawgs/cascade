# Cascade contracts v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the v2 Solidity contracts for Cascade: one `CascadeVault` on Bittensor EVM that holds the root stake and the csTAO shares, and a thin `CascadeFrontDoor` on Base that batches deposits and redemption requests — with test doubles, gas tests, end-to-end tests and an invariant suite proving the money flow.

**Architecture:** The vault prices every batch from the stake it reads directly through the staking precompile and never trusts a reported number. A front door forwards each user's address with their deposit or redeem request; the vault mints or burns their shares at one price per batch and pays redemptions back in chunks after a delay. Rogue-peer damage is bounded by a per-front-door daily burn allowance, a payout delay, guardian stop powers and an owner cancel that returns shares. Bridge adapters and the keeper bot are outside this build; the contracts talk to a chain-aware `ICascadeBridge` and are tested against mocks.

**Tech Stack:** Solidity 0.8.24 (EVM cancun), Foundry (forge 1.7.x), OpenZeppelin Contracts v5.4.0, forge-std.

**Spec:** `docs/superpowers/specs/2026-10-21-cascade-v2-vault-on-bittensor-design.md` (revision 5). The spec is the authority; this plan argues from it. Where the plan pins a value the spec leaves open, the line says "plan decision".

## Global Constraints

- Solidity `0.8.24`, `evm_version = "cancun"`, OpenZeppelin `v5.4.0` (in `contracts/lib`). Config in `contracts/foundry.toml`; never change compiler settings or add `code_size_limit` / `--code-size-limit` — the vault must deploy under 24,576 bytes in tests exactly as on chain.
- No proxies, no `delegatecall`, no external libraries (every library is `internal`), no arbitrary external calls. Value leaves the vault only via `primaryBridge.send` in `processPayouts` and `redeemDirect` to `msg.sender`; tokens leave the front door only via `cancelDeposit`, `closeBatch` (to the bridge) and `claim`.
- Custom errors only; an event for every state change; `renounceOwnership()` overridden to revert `RenounceDisabled()`.
- Precompile constants: `STAKING = 0x0000000000000000000000000000000000000805`, `ADDRESS_MAPPING = 0x000000000000000000000000000000000000080c`. Tests `vm.etch` mocks at both. Because `vm.etch` copies code only, every mock default must be the zero value of its storage (see Task 2).
- Units: TAO in contracts is 18-decimal wei; the precompile takes rao, `RAO = 1e9` wei. Never pass `msg.value` to the staking precompile. Never wrap a precompile *write* in `try/catch`; only the two floor reads use a gas-capped `try/catch`.
- Measure, never assume: around every precompile call that moves value, read balance and stake before and after and emit the measured delta.
- Share math only via `CascadeMath` (unchanged, never edit its formulas). Shares have 24 decimals. Expected values in tests are literals derived by hand (write the arithmetic in a comment), never computed with `CascadeMath` inside the assertion.
- Tests: Foundry, test-first (write the test, watch it fail, implement, watch it pass). Test contracts live under `contracts/test/`; mocks under `contracts/test/mocks/`.
- Run `forge fmt` before every commit. Line endings: `contracts/.gitattributes` pins `*.sol text eol=lf` (Task 1).
- Only `git add` files under `contracts/` and `docs/`. Never `git add -A` (an uncommitted web app lives in `web/`).
- Commits run from the repo root `E:/projects/cascade`; forge commands run from `E:/projects/cascade/contracts` with `export PATH="$PATH:$HOME/.foundry/bin"`. Use absolute paths; do not `cd` in a compound command.
- Branch: `contracts-v2` (already checked out). Never merge to `main`.

## Review Focus

1. A redeem-only batch (no deposits, `amount == 0`, `msg.value == 0`) is the normal exit case and must flow end to end: the front door sends it with a zero token amount and the vault accepts it. (Task 7: `test_delivery_redeemOnlyBatchWithZeroValue`; Task 9: `test_closeBatch_redeemOnlyBatchSendsZeroAmount`)
2. The owner lowers `maxBatchValue` below the open batch's `totalDeposits`: the batch must still close and new deposits must revert `BatchValueFull`, with no underflow in the "full by value" check. (Task 9: `test_closeBatch_afterMaxBatchValueLoweredBelowTotal`)
3. The same user deposits and requests a redeem in one batch: deposits are credited first, so the redeem can burn the just-minted shares at the same batch price. (Task 7: `test_delivery_sameUserDepositAndRedeemInOneBatch`)
4. Zero-amount deposit or redeem requests must revert `ZeroAmount` even when the owner has set `minDeposit` to 0, or slots would be free. (Task 9: `test_depositZeroAmountReverts`, `test_requestRedeemZeroAndPausedRevert`)
5. `processPayouts` after the guardian disabled the primary bridge must revert `PrimaryBridgeDisabled` with no state change, and succeed once the owner sets a new enabled primary. (Task 8: `test_processPayouts_primaryBridgeDisabledHoldsBatch`)

## File structure

```
contracts/.gitattributes                           Task 1   *.sol text eol=lf
contracts/src/interfaces/IStaking.sol              Task 1   precompile subset, v2 (3 new functions)
contracts/src/interfaces/IAddressMapping.sol       Task 1   new: ADDRESS_MAPPING_ADDRESS + addressMapping
contracts/src/interfaces/ICascadeBridge.sol        Task 1   chain-aware v2 interfaces
contracts/src/libraries/CascadeMessages.sol        Task 1   Entry, Payout, BATCH / PAYOUTS, MAX_ENTRIES
contracts/src/libraries/CascadeMath.sol            exists   share math (unchanged)
contracts/src/CascadeBase.sol                      Task 3   owner/guardian/pause + bridge registry (shared)
contracts/src/CascadeVault.sol                     Tasks 4-8 vault: token, registries, stake, rewards, delivery, payouts
contracts/src/CascadeFrontDoor.sol                 Tasks 9-10 Base front door
contracts/test/mocks/Mirror.sol                    Task 2   free function mirror(address) → bytes32
contracts/test/mocks/MockAddressMapping.sol        Task 2
contracts/test/mocks/MockStaking.sol               Task 2   v2 (rewrite)
contracts/test/mocks/StubBridge.sol                Task 2   v2 (rewrite)
contracts/test/mocks/MockTAO.sol                   exists
contracts/test/mocks/MockBridge.sol                Task 11  v2 (rewrite)
contracts/test/CascadeMessages.t.sol               Task 1   (rewrite)
contracts/test/MockStaking.t.sol                   Task 2   (rewrite)
contracts/test/CascadeBase.t.sol                   Task 3
contracts/test/VaultTestBase.sol                   Task 4   shared vault fixture
contracts/test/vault/VaultCore.t.sol               Task 4
contracts/test/vault/VaultStake.t.sol              Task 5
contracts/test/vault/VaultRewards.t.sol            Task 6
contracts/test/vault/VaultDelivery.t.sol           Task 7
contracts/test/vault/VaultPayouts.t.sol            Task 8
contracts/test/FrontDoorTestBase.sol               Task 9   shared front-door fixture
contracts/test/frontdoor/FrontDoorBatches.t.sol    Task 9
contracts/test/frontdoor/FrontDoorPayouts.t.sol    Task 10
contracts/test/EndToEnd.t.sol                      Task 11  (rewrite)
contracts/test/Gas.t.sol                           Task 11
contracts/test/invariants/Handler.sol              Task 12  (rewrite)
contracts/test/invariants/Cascade.invariants.t.sol Task 12  (rewrite)
contracts/README.md                                Task 13  (rewrite)
docs/architecture.md                               Task 13  (rewrite to v2)
```

Deleted in Task 1 (they only compile against the v1 interfaces; git history on `contracts-v1` keeps them): `src/CascadeVault.sol` (v1 Base vault), `src/StakeEngine.sol`, `test/CascadeVault.t.sol`, `test/CascadeVaultSettlement.t.sol`, `test/StakeEngine.t.sol`, `test/EndToEnd.t.sol`, `test/invariants/*`, `test/mocks/MockBridge.sol`. The v1 `StakeEngine` staking code is reference material for Task 5: `git show contracts-v1:contracts/src/StakeEngine.sol`.

Shared vocabulary used by every task (plan decisions):

- `peerId(uint64 chain, address addr) = keccak256(abi.encode(chain, addr))` identifies a front door in the vault.
- `batchKey = keccak256(abi.encode(sourceChain, sender, keccak256(message)))`.
- Running payout hash: `hash = keccak256(abi.encode(hash, user, shares, assets))` starting from `bytes32(0)`.
- Test chain ids: `BASE = 8453`, `BITTENSOR = 964` (opaque `uint64` ids; adapters map them to CCIP selectors).
- Hotkeys in tests: `HK1 = bytes32(uint256(1))`, `HK2 = bytes32(uint256(2))`, `HK3 = bytes32(uint256(3))`, `HK4`, `HK5` likewise.

---

### Task 1: Interfaces, messages v2, repo hygiene, v1 removal

**Files:**
- Create: `contracts/.gitattributes`, `contracts/src/interfaces/IAddressMapping.sol`
- Modify: `contracts/src/interfaces/IStaking.sol`, `contracts/src/interfaces/ICascadeBridge.sol`, `contracts/src/libraries/CascadeMessages.sol`
- Delete: the v1 files listed under "File structure"
- Test: `contracts/test/CascadeMessages.t.sol` (rewrite)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `IStaking.sol`: keep `ISTAKING_ADDRESS` and the seven v1 functions; add `function removeStakeFull(bytes32 hotkey, uint256 netuid) external payable;`, `function getDefaultMinStake() external view returns (uint256);` (rao), `function getNominatorMinRequiredStake() external view returns (uint256);` (rao).
  - `IAddressMapping.sol`: `address constant ADDRESS_MAPPING_ADDRESS = 0x000000000000000000000000000000000000080c; interface IAddressMapping { function addressMapping(address addr) external view returns (bytes32); }`
  - `ICascadeBridge.sol`: exactly the two interfaces from the spec section "Bridge interface v2", doc comments included:
    `send(uint64 destChain, address recipient, bytes calldata message, uint256 amount) external payable`,
    `quoteFee(uint64 destChain, address recipient, bytes calldata message, uint256 amount) external view returns (uint256)`,
    `ICascadeReceiver.onBridgeMessage(uint64 sourceChain, address sender, bytes calldata message, uint256 amount) external payable`.
  - `CascadeMessages.sol`: `struct Entry { address user; uint256 amount; }`, `struct Payout { address user; uint256 shares; uint256 assets; }`, `uint8 internal constant BATCH = 1; uint8 internal constant PAYOUTS = 2; uint256 internal constant MAX_ENTRIES = 100;`, `error WrongMessageKind(uint8 expected, uint8 actual); error TooManyEntries();`,
    `encodeBatch(uint64 batchId, Entry[] memory deposits, Entry[] memory redeems) internal pure returns (bytes memory)` = `abi.encode(BATCH, batchId, deposits, redeems)`,
    `decodeBatch(bytes memory message) internal pure returns (uint64 batchId, Entry[] memory deposits, Entry[] memory redeems)` (kind check first via `kind()`, then `TooManyEntries` if either list is longer than `MAX_ENTRIES`),
    `encodePayouts(bytes32 batchKey, uint32 chunk, Entry[] memory payouts) internal pure returns (bytes memory)` = `abi.encode(PAYOUTS, batchKey, chunk, payouts)`,
    `decodePayouts(bytes memory message) internal pure returns (bytes32 batchKey, uint32 chunk, Entry[] memory payouts)` (same checks),
    `kind(bytes memory message) internal pure returns (uint8)`.

- [ ] **Step 1: Repo hygiene and v1 removal**

Create `contracts/.gitattributes` containing `*.sol text eol=lf`. `git rm` the v1 files listed above. Run `forge fmt` on what remains.

- [ ] **Step 2: Write the failing tests**

`contracts/test/CascadeMessages.t.sol`: a `MessagesHarness` exposing the five library functions as `external`, and:

```solidity
function test_batchRoundTrip()        // decodeBatch(encodeBatch(7, [Entry(a,10e18)], [Entry(b,5e24)])) returns 7 and both lists intact
function test_payoutsRoundTrip()      // decodePayouts(encodePayouts(keccak256("k"), 3, [Entry(a,1e18)])) returns the key, 3, the list
function test_kinds()                 // kind(encodeBatch(...)) == 1; kind(encodePayouts(...)) == 2
function test_decodeBatchRejectsPayouts()   // expectRevert(WrongMessageKind.selector, 1, 2)
function test_decodePayoutsRejectsBatch()   // expectRevert(WrongMessageKind.selector, 2, 1)
function test_batchEncodingIsAbiEncode()    // encodeBatch(7, d, r) == abi.encode(uint8(1), uint64(7), d, r)
function test_decodeBatchRejects101Deposits()   // 101-entry deposits list → TooManyEntries
function test_decodeBatchAccepts100Each()       // 100 deposits + 100 redeems decode
function test_decodePayoutsRejects101()         // TooManyEntries
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `forge test --match-path test/CascadeMessages.t.sol` — expected: compilation fails (new functions/structs missing).

- [ ] **Step 4: Write the interfaces and the library**

Signatures above, verbatim.

- [ ] **Step 5: Run the tests to verify they pass, then the whole suite**

Run: `forge test` — expected: 9 CascadeMath + 9 messages pass; nothing else compiles yet because the v1 files are gone.

- [ ] **Step 6: Commit**

```bash
git add contracts/.gitattributes contracts/src contracts/test
git commit -m "feat(contracts): v2 interfaces and batch messages; remove v1 vault and engine"
```

---

### Task 2: Test doubles — MockStaking v2, MockAddressMapping, StubBridge v2

**Files:**
- Create: `contracts/test/mocks/Mirror.sol`, `contracts/test/mocks/MockAddressMapping.sol`
- Modify (rewrite): `contracts/test/mocks/MockStaking.sol`, `contracts/test/mocks/StubBridge.sol`
- Test: `contracts/test/MockStaking.t.sol` (rewrite)

**Interfaces:**
- Consumes: `IStaking`, `IAddressMapping`, `ICascadeBridge` (Task 1).
- Produces:
  - `Mirror.sol`: `function mirror(address a) pure returns (bytes32)` = `keccak256(abi.encodePacked("evm:", a))` (free function; the real chain uses blake2 — the mock only needs the vault and the staking mock to agree).
  - `MockAddressMapping is IAddressMapping`: `addressMapping(a)` returns `mirror(a)`. Etched at `ADDRESS_MAPPING_ADDRESS`.
  - `MockStaking is IStaking`, etched at `ISTAKING_ADDRESS`. Zero-default storage (plan decision, because `vm.etch` skips constructors): `uint256 minStakeOverride` (0 → `2_000_000`), `uint256 nominatorMinOverride` (0 → `20_000_000`), `uint256 claimGasOverride` (0 → `53_200_000`), `bool exactStakeReads` (false → a fresh position is credited one rao short), `bool claimTooHeavy`, `bool unstakeBlocked`. Test configuration: `addHotkey(bytes32)`, `setMinStake(uint256)`, `setNominatorMin(uint256)`, `setClaimGasRequired(uint256)`, `setOneRaoShort(bool on)` (sets `exactStakeReads = !on`), `setClaimTooHeavy(bool)`, `setUnstakeBlocked(bool)`, `setUnclaimed(bytes32 coldkey, bytes32 hotkey, uint256 rao)` (sets, not adds), `donateStake(bytes32 hotkey, bytes32 coldkey, uint256 rao)`, `rejectsGrowth(bytes32 coldkey) view`.
    Behaviour (errors `UnknownHotkey`, `BelowMinStake`, `AmountTooLow`, `InsufficientBalance`, `TooEarly`, `UnexpectedValue`):
    - `addStake(h, rao, netuid)`: `msg.value != 0` → `UnexpectedValue`; unknown hotkey reverts; `rao < minStake` → `BelowMinStake`; debits `rao * 1e9` from `msg.sender` via `vm.deal`; if the position `[h][mirror(msg.sender)][netuid]` was 0 and `!exactStakeReads`, credits `rao - 1`, else `rao`.
    - `removeStake(h, rao, netuid)`: `unstakeBlocked` → `TooEarly`; `rao > staked` → treated as a full exit; `rao < minStake && rao != staked` → `AmountTooLow`; subtract; if the remainder is below `nominatorMin` sweep it to the balance too; credit the total removed `* 1e9` via `vm.deal`.
    - `removeStakeFull(h, netuid)`: removes and credits the whole position (zero is fine).
    - `moveStake(from, to, 0, 0, rao)`: destination must be a known hotkey; `rao > staked` → `InsufficientStake`; moves rao.
    - `getStake(h, coldkey, netuid)` returns the stored rao.
    - `claimRootWithHotkey(h)`: `if (gasleft() < claimGas || claimTooHeavy) { assembly { invalid() } }` (burns all forwarded gas, like a dispatch failure); else moves `unclaimed[coldkey][h]` into stake and zeroes it.
    - `getUnclaimedRootTaoByHotkey(coldkey, h)` returns `unclaimed * 1e9`.
    - `getDefaultMinStake()` / `getNominatorMinRequiredStake()` return the effective values.
    - `setRejectStakingHotkeyGrowth(bool)` records per `mirror(msg.sender)`.
  - `StubBridge is ICascadeBridge` (records, never delivers): constructor `(IERC20 token)` — non-zero token = ERC-20 side (pulls `amount` tokens from `msg.sender`, requires `msg.value >= fee`), zero = native side (requires `msg.value >= amount + fee`); `InsufficientFee` otherwise; never refunds. `setFee(uint256)`; public `fee`, `lastDestChain`, `lastRecipient`, `lastMessage`, `lastAmount`, `lastValue`, `sendCount`. `quoteFee` returns `fee`.

- [ ] **Step 1: Write the failing tests**

`contracts/test/MockStaking.t.sol` (etch both mocks in `setUp`; the test contract is the staker, funded with `vm.deal`):

```solidity
function test_addressMappingMatchesMirror()        // IAddressMapping(ADDRESS_MAPPING_ADDRESS).addressMapping(x) == mirror(x)
function test_defaultsWithoutConstructor()         // getDefaultMinStake()==2_000_000; getNominatorMinRequiredStake()==20_000_000
function test_freshPositionReadsOneRaoShort()      // addStake(HK1, 5_000_000, 0) → getStake == 4_999_999; a second add of 1_000_000... (BelowMinStake) → add 2_000_000 → 6_999_999
function test_exactReadsWhenShortDisabled()        // setOneRaoShort(false); addStake 5_000_000 → 5_000_000
function test_removeStakeClipsOverRequestToFullExit()   // stake 30_000_000; removeStake(HK1, 40_000_000) → stake 0, balance +30_000_000e9
function test_removeStakePartialBelowMinReverts()  // stake 30_000_000; removeStake(HK1, 1_000_000) → AmountTooLow
function test_removeStakeSweepsSubNominatorRemainder()  // stake 30_000_000; removeStake(HK1, 15_000_000) → remainder 15_000_000 < 20_000_000 → stake 0, balance +30_000_000e9
function test_removeStakeFullEmptiesPosition()
function test_claimBurnsAllGasBelowRequirement()   // setUnclaimed(mirror(this), HK1, 1e6); (bool ok,) = address(staking).call{gas: 1_000_000}(claim) → !ok; unclaimed unchanged
function test_claimTooHeavyBurnsGas()              // setClaimTooHeavy(true); same shape with 60M gas → !ok
function test_claimMovesUnclaimedIntoStake()       // call{gas: 60_000_000} → stake += 1e6, unclaimed 0
function test_getUnclaimedIs18Decimals()           // setUnclaimed 7 rao → 7e9
function test_stubBridgeNativeFeeRule()            // native stub, fee 1e15: send{value: amount+fee-1} → InsufficientFee; {value: amount+fee+5} ok, lastValue == amount+fee+5 (kept)
function test_stubBridgeErc20FeeRule()             // ERC-20 stub pulls tokens; {value: fee-1} → InsufficientFee
```

- [ ] **Step 2: Run to verify they fail**

Run: `forge test --match-path test/MockStaking.t.sol` — expected: compilation fails.

- [ ] **Step 3: Write the mocks**

As specified above.

- [ ] **Step 4: Run to verify they pass, then the suite**

Run: `forge test --match-path test/MockStaking.t.sol -vv` — expected: 14 passed. Then `forge test` — all pass.

- [ ] **Step 5: Commit**

```bash
git add contracts/test/mocks contracts/test/MockStaking.t.sol
git commit -m "test(contracts): v2 staking mock with floors, clipping, sweep and gas-burning claims"
```

---

### Task 3: CascadeBase — owner, guardian, pause, bridge registry

**Files:**
- Create: `contracts/src/CascadeBase.sol`
- Test: `contracts/test/CascadeBase.t.sol`

**Interfaces:**
- Consumes: `ICascadeBridge` (Task 1); OpenZeppelin `Ownable2Step`, `Pausable`, `ReentrancyGuard`.
- Produces: `abstract contract CascadeBase is Ownable2Step, Pausable, ReentrancyGuard` with
  - `uint64 public constant REGISTRY_DELAY = 7 days;`
  - state: `address public guardian; mapping(address => bool) public bridgeEnabled; mapping(address => uint64) public bridgeProposedAt; address public primaryBridge;`
  - errors: `ZeroAddress(); NotGuardian(); NotBridge(); BridgeKnown(); NoProposal(); NotReady(); BridgeNotEnabled(); PrimaryBridgeDisabled(); RenounceDisabled();`
  - events: `GuardianSet(address guardian); BridgeProposed(address indexed bridge, uint64 readyAt); BridgeActivated(address indexed bridge); BridgeProposalCancelled(address indexed bridge); BridgeDisabled(address indexed bridge); PrimaryBridgeSet(address indexed bridge);`
  - `constructor(address owner_, address guardian_, address initialBridge)`: `Ownable(owner_)`; guardian and bridge zero → `ZeroAddress`; enables `initialBridge` at once and makes it primary (emits `BridgeActivated` and `PrimaryBridgeSet`).
  - `modifier onlyOwnerOrGuardian` (`NotGuardian` otherwise).
  - `setGuardian(address) onlyOwner`; `proposeBridge(address) onlyOwner` (`ZeroAddress`; already enabled → `BridgeKnown`; records `block.timestamp`, emits `readyAt = now + REGISTRY_DELAY`); `activateBridge(address) onlyOwner` (`NoProposal`; `now < proposedAt + REGISTRY_DELAY` → `NotReady`; enables, clears the proposal); `cancelBridgeProposal(address) onlyOwnerOrGuardian` (`NoProposal`); `disableBridge(address) onlyOwnerOrGuardian` (`BridgeNotEnabled`; the `primaryBridge` pointer is left as is); `setPrimaryBridge(address) onlyOwner` (`BridgeNotEnabled`); `pause() onlyOwnerOrGuardian`; `unpause() onlyOwner`; `renounceOwnership()` reverts `RenounceDisabled`.
  - internal helpers: `_requireBridge()` (`msg.sender` not enabled → `NotBridge`), `_primary() returns (ICascadeBridge)` (primary not enabled → `PrimaryBridgeDisabled`).

- [ ] **Step 1: Write the failing tests**

`contracts/test/CascadeBase.t.sol` with `contract BaseHarness is CascadeBase` (constructor pass-through; exposes `requireBridge()` and `primary()`):

```solidity
function test_constructorEnablesInitialBridgeAsPrimary()   // bridgeEnabled[b] && primaryBridge == b
function test_constructorRejectsZeroGuardianAndBridge()     // ZeroAddress for each
function test_proposeThenActivateAfterSevenDays()           // activate at +7d-1s → NotReady; at +7d → enabled, proposedAt == 0
function test_proposeEnabledBridgeReverts()                 // BridgeKnown
function test_activateWithoutProposalReverts()              // NoProposal
function test_guardianCancelsProposal()                     // proposedAt == 0 after; stranger → NotGuardian
function test_guardianDisablesBridge()                      // enabled false; disabling again → BridgeNotEnabled
function test_setPrimaryRequiresEnabled()                   // BridgeNotEnabled for an unknown address
function test_disabledPrimaryMakesPrimaryQueryRevert()      // disableBridge(primary); harness.primary() → PrimaryBridgeDisabled; after proposing+activating b2 and setPrimaryBridge(b2) → ok
function test_requireBridgeRejectsStranger()                // NotBridge
function test_pauseByGuardianUnpauseByOwnerOnly()           // guardian pause ok; guardian unpause → OwnableUnauthorizedAccount; owner unpause ok; stranger pause → NotGuardian
function test_renounceReverts()                             // RenounceDisabled
```

- [ ] **Step 2: Run to verify they fail** — `forge test --match-path test/CascadeBase.t.sol`: compilation fails.

- [ ] **Step 3: Write `CascadeBase.sol`** as specified.

- [ ] **Step 4: Run to verify they pass, then the suite** — 12 passed; `forge test` all green.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/CascadeBase.sol contracts/test/CascadeBase.t.sol
git commit -m "feat(contracts): shared admin base with delayed bridge registry"
```

---

### Task 4: CascadeVault core — token, constructor, front-door registry, direct deposits, parameters

**Files:**
- Create: `contracts/src/CascadeVault.sol`, `contracts/test/VaultTestBase.sol`
- Test: `contracts/test/vault/VaultCore.t.sol`

**Interfaces:**
- Consumes: `CascadeBase` (Task 3), `CascadeMath`, `CascadeMessages`, `IStaking`, `IAddressMapping`, mocks (Task 2).
- Produces: `contract CascadeVault is ERC20, CascadeBase, ICascadeReceiver` with
  - constants: `uint256 public constant RAO = 1e9; uint256 public constant NETUID_ROOT = 0; uint256 public constant ED_RESERVE = 1e12; uint256 public constant MAX_HOTKEYS = 4; uint64 public constant KEEPER_FALLBACK = 7 days; uint64 public constant REWARD_VESTING = 7 days; IStaking public constant STAKING = IStaking(ISTAKING_ADDRESS); IAddressMapping public constant ADDRESS_MAPPING = IAddressMapping(ADDRESS_MAPPING_ADDRESS);`
  - `bytes32 public immutable coldkey;`
  - constructor `(bytes32 expectedColdkey, bytes32 hotkey, ICascadeBridge bridge, address owner_, address guardian_, uint256 minDirectDeposit_)`: `ERC20("Cascade Staked TAO", "csTAO")`, `CascadeBase(owner_, guardian_, address(bridge))`; `coldkey = ADDRESS_MAPPING.addressMapping(address(this))`; differs from `expectedColdkey` → `ColdkeyMismatch(bytes32 expected, bytes32 derived)`; `ZeroHotkey`; `hotkeys.push(hotkey); isHotkey[hotkey] = true; stakeHotkey = hotkey;` emits `StakeHotkeySet(hotkey)`; `STAKING.setRejectStakingHotkeyGrowth(true)`; defaults (spec values; `maxTotalAssets` is a plan decision): `maxDailyOutflowBps = 2000; minDailyOutflow = 100e18; maxEntryValue = 2_000e18; maxMessageValue = 4_000e18; minChunk = 10; payoutDelay = 24 hours; maxFeeBps = 100; maxFeeAbs = 0.02e18; maxTotalAssets = 1_000e18; hotkeyDustRao = 1_000_000; claimGasRequired = 55_000_000; fallbackMinStakeRao = 2_000_000; fallbackMinRemainRao = 20_000_000;`
  - token: `decimals()` returns 24; `transfer`, `transferFrom`, `approve` revert `NonTransferable()`.
  - state declared now (used by later tasks): `bytes32[] public hotkeys; mapping(bytes32 => bool) public isHotkey; bytes32 public stakeHotkey; address public keeper; uint256 public pendingPayouts; uint256 public vestingAmount; uint64 public vestingStart; uint64 public lastStakeAt; mapping(bytes32 => uint64) public lastClaimAt; bool internal _unstaking; mapping(address => bool) public directOnly;` plus the public parameters named in the defaults.
  - front-door registry: `function peerId(uint64 chain, address addr) public pure returns (bytes32)` = `keccak256(abi.encode(chain, addr))`; `mapping(bytes32 => bool) public frontDoorActive; mapping(bytes32 => uint64) public frontDoorProposedAt;` `proposeFrontDoor(uint64 chain, address addr) onlyOwner` (`ZeroAddress`; active → `PeerKnown`), `activateFrontDoor(uint64, address) onlyOwner` (`NoProposal`, `NotReady`, same delay as bridges), `cancelFrontDoorProposal(uint64, address) onlyOwnerOrGuardian`, `removeFrontDoor(uint64, address) onlyOwnerOrGuardian` (`PeerNotActive`); events `FrontDoorProposed(uint64 indexed chain, address indexed addr, uint64 readyAt)`, `FrontDoorActivated(uint64 indexed chain, address indexed addr)`, `FrontDoorProposalCancelled(...)`, `FrontDoorRemoved(...)`.
  - views: `rootStakeRao() view` (Σ `STAKING.getStake(h, coldkey, 0)` over `hotkeys`), `grossAssets() view` (`rootStakeRao() * RAO + address(this).balance - ED_RESERVE`, floored at 0), `unvestedRewards() view` (`elapsed >= REWARD_VESTING ? 0 : vestingAmount * (REWARD_VESTING - elapsed) / REWARD_VESTING` with `elapsed = block.timestamp - vestingStart`), `totalAssets() view` (`grossAssets() - pendingPayouts - unvestedRewards()`, floored at 0), `price() view` = `CascadeMath.price(totalAssets(), totalSupply())`.
  - direct access (part 1): `depositDirect() payable whenNotPaused nonReentrant` exactly as the spec section "Direct access" (`NotRaoAligned`, `BelowMinDeposit`, `CapExceeded`, sets `directOnly[msg.sender] = true` every time, `A = totalAssets() - msg.value` floored at 0, mints `CascadeMath.sharesForDeposit(msg.value, A, totalSupply())`, emits `DepositedDirect(address indexed user, uint256 assets, uint256 shares)`); `allowFrontDoorRedeems()` (clears the flag, emits `FrontDoorRedeemsAllowed(address indexed user)`).
  - parameters (owner): `setKeeper(address)` (zero allowed = fallback-only; `KeeperSet`), `setMinDirectDeposit(uint256)`, `setMaxTotalAssets(uint256)`, `setOutflowLimits(uint256 bps, uint256 minDaily)` (`bps <= 10000`), `setMessageLimits(uint256 maxEntryValue_, uint256 maxMessageValue_, uint32 minChunk_)` (`maxEntryValue_ <= maxMessageValue_`, `1 <= minChunk_ <= MAX_ENTRIES`), `setFeeLimits(uint256 bps, uint256 abs_)` (`bps <= 10000`), `setPayoutDelay(uint64)` (`<= 7 days`), `setClaimGasRequired(uint256)` (`ClaimGasSet(uint256)`), `setHotkeyDustRao(uint256)`, `setFloorFallbacks(uint256 minStake, uint256 minRemain)` (`1 <= minStake <= minRemain <= 1e9`). Invalid → `InvalidParameter()`. Every numeric setter emits `LimitSet(bytes32 indexed name, uint256 a, uint256 b)` with `name` the function's parameter name as a string literal (plan decision; keeps the ABI small).
  - `receive() external payable` reverts `DirectTransferNotAllowed()` unless `_unstaking`.
  - `VaultTestBase` (abstract, `is Test`): constants `BASE`, `BITTENSOR`, `HK1..HK5`, `uint256 constant ED = 1e12`; actors `owner`, `guardian`, `keeper`, `frontDoor = makeAddr("frontDoor")`, `alice`, `bob`, `carol`; `MockStaking staking` (etched at `ISTAKING_ADDRESS`, `addHotkey(HK1..HK5)`), `MockAddressMapping` etched at `ADDRESS_MAPPING_ADDRESS`, `StubBridge bridge` (native, `fee = 1e15`), `CascadeVault vault` deployed with `expectedColdkey = mirror(vm.computeCreateAddress(address(this), vm.getNonce(address(this))))`, `HK1`, `minDirectDeposit = 1e15`; then `vm.deal(address(vault), ED)` (the operator funds the existential reserve before use — Task 13 documents it), `vm.prank(owner); vault.setKeeper(keeper)`, and `registerFrontDoor(BASE, frontDoor)` (propose, warp +7 days, activate). Helpers: `registerFrontDoor(uint64, address)`, `depositDirect(address user, uint256 amount)` (deals and pranks), `entries1(address, uint256) returns (Entry[] memory)`, `noEntries() returns (Entry[] memory)`. Task 7 adds `deliver(...)`.

- [ ] **Step 1: Write the failing tests**

`contracts/test/vault/VaultCore.t.sol is VaultTestBase`. Hand-derived literals: the first `depositDirect(10e18)` mints `10e18 * (0 + 1e6) / (0 + 1) = 1e25` shares; a second `depositDirect(5e18)` prices against `A = 10e18` and mints `5e18 * (1e25 + 1e6) / (10e18 + 1) = 5e24` exactly (the numerator is `5e24 * (1e19 + 1)`).

```solidity
function test_constructorDerivesColdkey()            // vault.coldkey() == mirror(address(vault))
function test_constructorRejectsColdkeyMismatch()    // expectRevert(ColdkeyMismatch.selector, wrong, derived) on a fresh deploy
function test_constructorRejectsZeroHotkey()
function test_constructorSetsRejectGrowth()          // staking.rejectsGrowth(vault.coldkey())
function test_constructorInitialHotkeyIsStakeHotkey() // hotkeys(0)==HK1, isHotkey(HK1), stakeHotkey()==HK1
function test_tokenMetadata()                        // "Cascade Staked TAO", "csTAO", decimals 24
function test_sharesNonTransferable()                // transfer, transferFrom, approve → NonTransferable (after a deposit)
function test_frontDoorProposeActivateDelay()        // peer BASE/bob: activate at +7d-1 → NotReady; +7d → active
function test_frontDoorCancelByGuardian()            // proposal cleared; stranger → NotGuardian
function test_frontDoorRemoveByGuardian()            // active false; remove again → PeerNotActive
function test_depositDirectMintsAtOffsetPrice()      // alice 10e18 → balanceOf 1e25, totalSupply 1e25, directOnly true, event DepositedDirect(alice, 10e18, 1e25)
function test_depositDirectSecondDepositExcludesOwnValue() // then bob 5e18 → 5e24
function test_depositDirectRejectsMisaligned()       // 10e18 + 1 → NotRaoAligned
function test_depositDirectRejectsBelowMin()         // 1e15 - 1e9 → BelowMinDeposit
function test_depositDirectRejectsAboveCap()         // 1_001e18 → CapExceeded; 1_000e18 ok
function test_depositDirectWhilePausedReverts()      // EnforcedPause
function test_allowFrontDoorRedeemsClearsFlagAndDepositSetsItAgain()
function test_grossAssetsEqualsDepositsWithReserveFunded()   // after 10e18: grossAssets == totalAssets == 10e18; price() == 1e12 (1 TAO per 1e24 shares, scaled 1e18: (10e18+1)*1e18/(1e25+1e6) floors to 1e12)
function test_grossAssetsFloorsAtZeroOnEmptyVault()  // fresh vault without the reserve: 0
function test_settersRejectInvalid()                 // bps 10001; maxEntryValue > maxMessageValue; minChunk 0 and 101; payoutDelay 7 days + 1; floors (0,1), (5,4), (1, 1e9+1) → InvalidParameter
function test_settersOwnerOnly()                     // guardian calling setOutflowLimits → OwnableUnauthorizedAccount
function test_receiveRejectsDirectTransfer()         // DirectTransferNotAllowed
```

- [ ] **Step 2: Run to verify they fail** — compilation fails.

- [ ] **Step 3: Write `CascadeVault.sol` (core) and `VaultTestBase.sol`**

Only what this task's Produces block names. Leave no stubs for later tasks' functions.

- [ ] **Step 4: Run to verify they pass, then the suite; check size**

`forge test --match-path "test/vault/VaultCore.t.sol" -vv` → 22 passed. `forge build --sizes` → note `CascadeVault` runtime size in the report file (must already be well under 24,576; it grows in Tasks 5–8).

- [ ] **Step 5: Commit**

```bash
git add contracts/src/CascadeVault.sol contracts/test/VaultTestBase.sol contracts/test/vault/VaultCore.t.sol
git commit -m "feat(contracts): vault core — csTAO token, coldkey derivation, registries, direct deposits"
```

---

### Task 5: Vault stake engine — hotkey set, floors, stakeIdle, unstake, redeemDirect

**Files:**
- Modify: `contracts/src/CascadeVault.sol`
- Test: `contracts/test/vault/VaultStake.t.sol`

**Interfaces:**
- Consumes: Task 4 state and views; `MockStaking` behaviours (Task 2). Reference for the staking calls: `git show contracts-v1:contracts/src/StakeEngine.sol`.
- Produces:
  - `hotkeyCount() view returns (uint256)`.
  - `addHotkey(bytes32 h) onlyOwner` (`ZeroHotkey`, `HotkeyKnown`, `TooManyHotkeys`; `HotkeyAdded(bytes32 indexed hotkey)`).
  - `setStakeHotkey(bytes32 h) onlyOwner` (adds if absent under the same rules; `StakeHotkeySet(bytes32 indexed hotkey)`).
  - `moveStake(bytes32 from, uint256 rao) onlyOwner` (`from` not in set → `UnknownHotkey`; `from == stakeHotkey` → `HotkeyInUse`; `STAKING.moveStake(from, stakeHotkey, 0, 0, rao)`; measures both stakes; `StakeMoved(bytes32 indexed from, bytes32 indexed to, uint256 rao, uint256 moved)` where `moved` is the destination's measured increase).
  - `removeHotkey(bytes32 h, bool forfeit) onlyOwner` exactly as the spec bullet (`UnknownHotkey`, `HotkeyInUse`, leftover below `minStakeRao()` → `removeStakeFull`, else `moveStake` to `stakeHotkey`; then unless `forfeit`, `getUnclaimedRootTaoByHotkey(coldkey, h) > hotkeyDustRao * RAO` → `HotkeyHasRewards`; swap-and-pop; `HotkeyRemoved(bytes32 indexed hotkey, uint256 unclaimed, bool forfeit)`).
  - `minStakeRao() view` / `minRemainRao() view`: `try STAKING.getDefaultMinStake{gas: 100_000}() returns (uint256 v) { return v; } catch { return fallbackMinStakeRao; }` (same shape for `getNominatorMinRequiredStake` / `fallbackMinRemainRao`).
  - `stakeIdle() whenNotPaused nonReentrant`: `msg.sender != keeper && block.timestamp < lastStakeAt + KEEPER_FALLBACK` → `NotKeeper`; `idle = balance - pendingPayouts - ED_RESERVE` floored at 0; `idle / RAO < minStakeRao()` → `NothingToStake()` (plan decision: revert, not a silent no-op, so the keeper sees it); `STAKING.addStake(stakeHotkey, idle / RAO, 0)`; measures the stake delta; `lastStakeAt = uint64(block.timestamp)`; `Staked(bytes32 indexed hotkey, uint256 rao, uint256 measured)`.
  - `_unstake(uint256 shortfallWei) internal` exactly as the spec bullet, with `_unstaking = true` around the precompile calls and `Unstaked(bytes32 indexed hotkey, uint256 wantRao, uint256 receivedWei)` per hotkey touched; walks `stakeHotkey` first, then the array in order, skipping hotkeys with zero stake.
  - `redeemDirect(uint256 shares) whenNotPaused nonReentrant`: `ZeroAmount`; `out = CascadeMath.assetsForRedeem(shares, totalAssets(), totalSupply())` rounded down to rao; `_burn`; `available = balance - ED_RESERVE - pendingPayouts` floored at 0; `available < out` → `_unstake(out - available)`; `call{value: out}` to `msg.sender` (`TransferFailed`); `RedeemedDirect(address indexed user, uint256 shares, uint256 assets)`.

- [ ] **Step 1: Write the failing tests**

`contracts/test/vault/VaultStake.t.sol is VaultTestBase`. Literals: `depositDirect(10e18)` then `stakeIdle` stakes `10_000_000_000` rao; with the default one-rao-short mock the position reads `9_999_999_999`, so `grossAssets() == 10e18 - 1e9`. Redeeming `1e25` shares against `totalAssets == 10e18` and `totalSupply == 1e25` returns `1e25 * (10e18 + 1) / (1e25 + 1e6) = 10e18` exactly (the denominator is `1e6 * (1e19 + 1)`).

```solidity
function test_stakeIdleByKeeperStakesEverythingAboveReserve()  // alice 10e18; keeper stakeIdle → Staked(HK1, 10_000_000_000, 9_999_999_999); balance == ED; grossAssets == 10e18 - 1e9; lastStakeAt == now
function test_stakeIdleStrangerBeforeFallbackReverts()         // NotKeeper; warp +7d → succeeds
function test_stakeIdleBelowMinReverts()                        // alice 1e15 (1_000_000 rao < 2_000_000) → NothingToStake
function test_stakeIdleWhilePausedReverts()
function test_priceToleratesOneRaoShort()                       // after the stake: totalAssets() == 10e18 - 1e9 and price() == 999_999_999_900 (= (10e18 - 1e9 + 1) * 1e18 / (1e25 + 1e6) = (1e19 - 1e9 + 1) * 1e12 / (1e19 + 1), floor; remainder 100)
function test_floorsReadLive()                                  // staking.setMinStake(2_500_000) → minStakeRao() == 2_500_000; setNominatorMin(25_000_000) → minRemainRao()
function test_floorsFallBackWhenReadReverts()                   // vm.mockCallRevert on getDefaultMinStake → 2_000_000; setFloorFallbacks(3_000_000, 30_000_000) → 3_000_000
function test_addHotkeyRules()                                  // HK2,HK3,HK4 ok (count 4); HK5 → TooManyHotkeys; HK2 → HotkeyKnown; 0 → ZeroHotkey; stakeHotkey still HK1
function test_setStakeHotkeyAddsAndSwitches()                   // setStakeHotkey(HK2): isHotkey, stakeHotkey == HK2, count 2
function test_moveStakeMeasuresBothSides()                      // stake 10e18 on HK1 (reads 9_999_999_999); setStakeHotkey(HK2); moveStake(HK1, 5_000_000_000) → HK1 4_999_999_999, HK2 4_999_999_999 (fresh position short); StakeMoved(HK1, HK2, 5_000_000_000, 4_999_999_999); rootStakeRao == 9_999_999_998
function test_moveStakeFromStakeHotkeyReverts()                 // HotkeyInUse
function test_removeHotkeyMovesLeftoverAboveMin()               // continuing: removeHotkey(HK1,false) → HK1 stake 0, HK2 += 4_999_999_999, count 1, HotkeyRemoved(HK1, 0, false)
function test_removeHotkeyFullExitsLeftoverBelowMin()           // stakeHotkey HK2; staking.donateStake(HK1, coldkey, 1_500_000); removeHotkey(HK1,false) → balance == ED + 1.5e15 (idle), HK1 stake 0
function test_removeHotkeyRejectsStakeHotkey()                  // HotkeyInUse
function test_removeHotkeyRejectsRewardsAboveDust()             // setUnclaimed(coldkey, HK1, 1_000_001) → HotkeyHasRewards; 1_000_000 → ok
function test_removeHotkeyForfeitThenReAdd()                    // forfeit with 5_000_000 unclaimed → HotkeyRemoved(HK1, 5e15, true); addHotkey(HK1) → count back to 2
function test_redeemDirectFromLiquidBalance()                   // alice 10e18 (unstaked); redeemDirect(5e24) → alice +5e18, supply 5e24, RedeemedDirect(alice, 5e24, 5e18)
function test_redeemDirectUnstakesFullPositionForShortfall()    // setOneRaoShort(false); alice 10e18; stakeIdle; redeemDirect(1e25) → Unstaked(HK1, 10_000_000_000, 10e18); alice +10e18; stake 0; balance == ED
function test_redeemDirectPartialUnstakeKeepsRemainder()        // exact reads; alice 100e18; stakeIdle; redeemDirect(1e25) → Unstaked(HK1, 10_000_000_000, 10e18); HK1 stake 90_000_000_000
function test_redeemDirectFullExitsWhenRemainderBelowNominatorMin() // exact reads; alice 10e18; stakeIdle; redeemDirect(9.99e24 = 9_990_000_000_000_000_000_000_000) → out 9.99e18; want 9_990_000_000 leaves 10_000_000 < 20_000_000 → Unstaked(HK1, 9_990_000_000, 10e18); stake 0; balance == ED + 1e16
function test_redeemDirectWalksHotkeysStakeHotkeyFirst()        // exact reads; alice 10e18; stakeIdle; addHotkey(HK2); setStakeHotkey(HK2); moveStake(HK1, 5_000_000_000) (HK2 now stake hotkey with 5e9, HK1 5e9); redeemDirect(8e24) → HK2 fully exited (5e18), HK1 removeStake 3e9 → HK1 2_000_000_000; alice +8e18
function test_redeemDirectRetriesAfterPrecompileRevert()        // staking.setUnstakeBlocked(true); redeemDirect → reverts (TooEarly bubbles); shares intact; unblock → succeeds
function test_redeemDirectZeroReverts()                         // ZeroAmount
function test_redeemDirectWhilePausedReverts()
function test_redeemDirectDoesNotRestake()                      // after a redeem that unstaked more than needed (sweep case: exact reads, alice 25e18 staked, redeem 1e25 → want 1e10, remainder 1.5e10 < 2e7? no — use alice 10.019e18 … ) → keep simple: assert no Staked event is emitted during redeemDirect
```

For the last test use: exact reads, alice `10e18` staked, bob `1e18` deposited and left liquid, `redeemDirect` by bob of `1e24` → paid from balance, no `Unstaked`, no `Staked`.

- [ ] **Step 2: Run to verify they fail** — compilation fails on the missing functions.

- [ ] **Step 3: Implement** the Produces block in `CascadeVault.sol`.

- [ ] **Step 4: Run to verify they pass, then the suite** — 25 passed; `forge test` green; `forge build --sizes` size noted in the report.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/CascadeVault.sol contracts/test/vault/VaultStake.t.sol
git commit -m "feat(contracts): vault stake engine — hotkey set, live floors, stakeIdle, unstake walk, redeemDirect"
```

---

### Task 6: Vault rewards — keeper-timed claims with vesting

**Files:**
- Modify: `contracts/src/CascadeVault.sol`
- Test: `contracts/test/vault/VaultRewards.t.sol`

**Interfaces:**
- Consumes: `vestingAmount`, `vestingStart`, `unvestedRewards()`, `lastClaimAt`, `keeper`, `claimGasRequired` (Task 4); `MockStaking.setUnclaimed`, `setClaimTooHeavy` (Task 2).
- Produces: `claimRewards(bytes32 hotkey) nonReentrant` (no `whenNotPaused` — claims work while paused): `!isHotkey[hotkey]` → `UnknownHotkey`; `msg.sender != keeper && block.timestamp < lastClaimAt[hotkey] + KEEPER_FALLBACK` → `NotKeeper`; `gasleft() < claimGasRequired` → `InsufficientGas()`; `before = STAKING.getStake(hotkey, coldkey, 0)`; `STAKING.claimRootWithHotkey(hotkey)` (no `try/catch`); `delta = after > before ? after - before : 0` (rao); `lastClaimAt[hotkey] = uint64(block.timestamp)`; `vestingAmount = unvestedRewards() + delta * RAO; vestingStart = uint64(block.timestamp)`; `RewardsClaimed(bytes32 indexed hotkey, uint256 deltaRao)`.

- [ ] **Step 1: Write the failing tests**

`contracts/test/vault/VaultRewards.t.sol is VaultTestBase`; its `setUp` also calls `staking.setOneRaoShort(false)`, deposits `10e18` for alice via `depositDirect`, and has the keeper `stakeIdle()`. Claims are sent with `{gas: 60_000_000}`. Literal: one claimed TAO vests linearly, so one day in the unvested part is `1e18 * 6 days / 7 days = 857142857142857142`.

```solidity
function test_claimByKeeperAddsStakeAndVests()        // setUnclaimed(coldkey, HK1, 1_000_000_000); keeper claims → stake 11_000_000_000; RewardsClaimed(HK1, 1e9); grossAssets 11e18; totalAssets 10e18; +3.5 days → 10.5e18; +7 days → 11e18
function test_claimStrangerBeforeFallbackReverts()    // NotKeeper; warp +7d → ok
function test_claimFallbackIsPerHotkey()              // warp to 8 days; keeper claims HK1; stranger HK1 → NotKeeper; addHotkey(HK2); stranger HK2 → ok
function test_claimInsufficientGasRevertsBeforeCall() // {gas: 50_000_000} → InsufficientGas; unclaimed unchanged; lastClaimAt 0
function test_claimGasBurningFailureLeavesStateUntouched() // setClaimTooHeavy(true); low-level call{gas: 60_000_000} as keeper → !ok; unclaimed, lastClaimAt, vestingAmount unchanged
function test_claimZeroDeltaSucceeds()                // no unclaimed → RewardsClaimed(HK1, 0); lastClaimAt == now; vestingAmount 0
function test_vestingCurveIsLinear()                  // after a 1-TAO claim: unvestedRewards() == 1e18; +1 day → 857142857142857142; +7 days → 0
function test_secondClaimRestartsWithRemainder()      // claim 1 TAO; +3.5 days (unvested 5e17); claim 1 TAO → vestingAmount 1.5e18, vestingStart now, unvested 1.5e18; +7 days → 0
function test_sandwichAroundClaimYieldsNothing()      // bob depositDirect 10e18 just before the claim (gets 1e25); keeper claims 1 TAO; bob redeemDirect(1e25) at once → bob receives exactly 10e18 (totalAssets 20e18 with 1e18 unvested: 1e25*(2e19+1)/(2e25+1e6) = 1e19)
function test_claimUnknownHotkeyReverts()
function test_claimWorksWhilePaused()
function test_setClaimGasRequiredEmits()              // ClaimGasSet(70_000_000); then {gas: 60_000_000} → InsufficientGas
```

- [ ] **Step 2: Run to verify they fail** — `claimRewards` missing.

- [ ] **Step 3: Implement `claimRewards`.**

- [ ] **Step 4: Run to verify they pass, then the suite** — 12 passed; suite green.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/CascadeVault.sol contracts/test/vault/VaultRewards.t.sol
git commit -m "feat(contracts): keeper-timed root reward claims with 7-day vesting"
```

---

### Task 7: Vault batch delivery — `onBridgeMessage`

**Files:**
- Modify: `contracts/src/CascadeVault.sol`, `contracts/test/VaultTestBase.sol`
- Test: `contracts/test/vault/VaultDelivery.t.sol`

**Interfaces:**
- Consumes: `CascadeMessages.decodeBatch`, `peerId`, `frontDoorActive`, `directOnly`, `grossAssets`, `totalAssets`, `_requireBridge` (Tasks 1–4).
- Produces:
  - `struct PayoutBatch { uint64 sourceChain; address frontDoor; uint64 batchId; uint64 queuedAt; uint32 cursor; uint32 count; uint32 chunk; uint256 remaining; bytes32 payoutsHash; }` with `mapping(bytes32 => PayoutBatch) public payoutBatches;` `mapping(bytes32 => bool) public processed;` `struct Window { uint64 start; uint256 burned; }` with `mapping(bytes32 => Window) public burnWindows;` (keyed by `peerId`).
  - `function batchKey(uint64 sourceChain, address sender, bytes calldata message) public pure returns (bytes32)` = `keccak256(abi.encode(sourceChain, sender, keccak256(message)))`; `function getPayoutBatch(bytes32 key) external view returns (PayoutBatch memory)` (plan decision: the auto-getter returns a tuple, which tests and the keeper find awkward).
  - `onBridgeMessage(uint64 sourceChain, address sender, bytes calldata message, uint256 amount) external payable whenNotPaused nonReentrant`: steps 1–4 of the spec section "`onBridgeMessage`" exactly. Errors: `NotBridge`, `UnknownPeer()`, `ValueMismatch()`, `AmountMismatch()`, `DuplicateBatch()`. Events: `BatchDelivered(bytes32 indexed key, uint64 indexed sourceChain, address indexed frontDoor, uint64 batchId, uint256 amount)` (plan decision: one summary event), `DepositSkipped(bytes32 indexed key, address user, uint256 assets)`, `Deposited(bytes32 indexed key, address indexed user, uint256 assets, uint256 shares)`, `RedeemSkipped(bytes32 indexed key, address indexed user, uint256 requested)`, `RedeemDeferred(bytes32 indexed key, address indexed user, uint256 requested)`, `Redeemed(bytes32 indexed key, address indexed user, uint256 shares, uint256 assets)`, `PayoutBatchQueued(bytes32 indexed key, uint64 indexed sourceChain, uint64 batchId, uint32 count, uint256 total, uint256 price)` where `price = CascadeMath.price(A, S)`.
  - `VaultTestBase.deliver(uint64 chain, address sender, uint64 batchId, Entry[] memory deposits, Entry[] memory redeems) returns (bytes32 key)`: encodes, deals the stub bridge `Σ deposits`, pranks it and calls `vault.onBridgeMessage{value: Σ}`; returns `vault.batchKey(chain, sender, message)`. Also `depositVia(address user, uint256 amount)` = `deliver(BASE, frontDoor, ++nextBatchId, entries1(user, amount), noEntries())`.

- [ ] **Step 1: Write the failing tests**

`contracts/test/vault/VaultDelivery.t.sol is VaultTestBase`. Literals: a fresh vault prices the first batch at `A = 0, S = 0`, so every deposit entry in it mints `amount * 1e6` shares and every redeem entry pays `shares / 1e6` (`assetsForRedeem(s, 0, 0) = s * 1 / 1e6`). With alice holding `1e25` against `10e18`, a `2e18` cap gives `sMax = 2e18 * (1e25 + 1e6) / (10e18 + 1) = 2e24`. With `1_000e18` in the vault, the default allowance is `max(200e18, 100e18) = 200e18` and `200e18` of value is `2e26` shares.

```solidity
function test_delivery_oneBatchPriceForAllEntries()        // alice 10e18 + bob 10e18 in one batch → 1e25 each; BatchDelivered(key, BASE, frontDoor, 1, 20e18)
function test_delivery_secondBatchPricesAgainstExistingAssets() // then bob 5e18 → 5e24
function test_delivery_misalignedEntriesRoundDownAndNeverRevert() // alice 10e18+5e8, bob 5e18-5e8 (sum aligned 15e18) → alice 1e25, bob 4_999_999_999_000_000_000_000_000; grossAssets 15e18
function test_delivery_zeroAddressDepositSkipped()         // Entry(0, 1e18) → DepositSkipped(key, 0, 1e18); no mint; grossAssets includes 1e18
function test_delivery_notBridgeReverts()                  // NotBridge
function test_delivery_unknownPeerReverts()                // unregistered sender → UnknownPeer; removed front door → UnknownPeer
function test_delivery_valueMismatchReverts()              // msg.value != amount → ValueMismatch
function test_delivery_amountMismatchReverts()             // amount != Σ deposits → AmountMismatch
function test_delivery_exactReplayRejected()               // DuplicateBatch
function test_delivery_forgedBatchIdDoesNotBlockRealOne()  // batchId 5 twice with different entries → both delivered, two keys
function test_delivery_depositOnlyBatchRecordedWithoutPayout() // processed[key]; payoutBatches(key).count == 0; pendingPayouts 0
function test_delivery_redeemOnlyBatchWithZeroValue()      // alice holds 1e25; redeem-only batch 5e24 with amount 0, value 0 → Redeemed(key, alice, 5e24, 5e18); PayoutBatchQueued(key, BASE, id, 1, 5e18, 1e12); pendingPayouts 5e18
function test_delivery_redeemClippedToBalance()            // redeem 2e25 of 1e25 → burns 1e25, out 10e18
function test_delivery_redeemClippedToMaxEntryValue()      // setMessageLimits(2e18, 4_000e18, 10); redeem 1e25 → burns 2e24, out 2e18; alice keeps 8e24
function test_delivery_redeemClippedToPeerAllowanceThenDeferred() // 1_000e18 vault; redeem 1e27 → burns 2e26, out 200e18; burnWindows(peer).burned == 200e18; a second redeem in the window → RedeemDeferred; warp +24h → burns another 2e26 (allowance is on gross, which still includes the reserved TAO)
function test_delivery_minDailyOutflowFloor()              // 10e18 vault: redeem all 1e25 → out 10e18 (100e18 floor)
function test_delivery_directOnlySkippedUntilOptIn()       // alice deposits 10e18 via a batch, then depositDirect 10e18 (flag set); a batch redeem of alice → RedeemSkipped (nothing burned); allowFrontDoorRedeems; the same redeem → Redeemed
function test_delivery_sameUserDepositAndRedeemInOneBatch() // fresh vault: deposit alice 10e18 and redeem alice 5e24 in one batch → mints 1e25, burns 5e24, out 5e18
function test_delivery_runningHashOverPayoutTriples()      // two redeems → payoutsHash == keccak256(abi.encode(keccak256(abi.encode(bytes32(0), alice, sA, oA)), bob, sB, oB))
function test_delivery_pendingPayoutsExcludedFromTotalAssets() // pendingPayouts == total; totalAssets == grossAssets - total
function test_delivery_doesNotStake()                      // after a deposit batch: rootStakeRao 0; balance == Σ + ED
function test_delivery_revertsWhilePausedAndDeliversAfterUnpause() // EnforcedPause; then the same message succeeds (not a duplicate)
function test_delivery_acceptsMaxEntries()                 // 100 fresh deposits + 100 redeems (holders from a prior batch) → delivered
function test_delivery_secondFrontDoorHasOwnAllowance()    // register (4663, fd2); 1_000e18 vault; fd1 and fd2 each burn 200e18 worth in the same window → pendingPayouts 400e18
function test_stakeIdle_excludesPendingPayouts()           // alice 10e18; redeem 5e24 queued; keeper stakeIdle → Staked(HK1, 5_000_000_000, 4_999_999_999)
```

- [ ] **Step 2: Run to verify they fail** — `onBridgeMessage` missing.

- [ ] **Step 3: Implement `onBridgeMessage`, the structs, `batchKey`, and the fixture helpers.**

Keep `A` and `S` in locals for the whole call; read `balanceOf(user)` once per redeem entry.

- [ ] **Step 4: Run to verify they pass, then the suite; size check** — 25 passed; `forge build --sizes` size noted.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/CascadeVault.sol contracts/test/VaultTestBase.sol contracts/test/vault/VaultDelivery.t.sol
git commit -m "feat(contracts): batch delivery — one price per batch, per-peer burn allowance, hashed payout queue"
```

---

### Task 8: Vault payouts — `processPayouts` and `cancelPayoutBatch`

**Files:**
- Modify: `contracts/src/CascadeVault.sol`
- Test: `contracts/test/vault/VaultPayouts.t.sol`

**Interfaces:**
- Consumes: `PayoutBatch`, `pendingPayouts`, `_unstake`, `_primary()`, `CascadeMessages.encodePayouts`, `Payout` (Tasks 1–7).
- Produces:
  - `processPayouts(bytes32 key, Payout[] calldata payouts, uint32 maxEntries) external whenNotPaused nonReentrant`: steps 1–5 of the spec section "`processPayouts`". Plan decisions: the chunk limit is `min(max(maxEntries, minChunk), MAX_ENTRIES)` (the front door's decoder rejects more than `MAX_ENTRIES`); fee deduction per entry is `Math.mulDiv(assets_i, fee, sum, Math.Rounding.Ceil)`, then `net_i` is floored to rao; entries whose `net_i == 0` emit `PayoutDust` and are left out of the sent list (the front door never credits zero). Errors: `NotPending()`, `PayoutsMismatch()`, `PayoutDelayed()`, `FrontDoorInactive()`, `FeeTooHigh()`, `PrimaryBridgeDisabled`. Events: `PayoutChunkSent(bytes32 indexed key, uint32 chunk, uint32 taken, uint256 gross, uint256 net, uint256 fee)`, `PayoutDust(bytes32 indexed key, address indexed user, uint256 assets)`.
  - `cancelPayoutBatch(bytes32 key, Payout[] calldata payouts) external onlyOwner nonReentrant` (works while paused and with the front door removed): `NotPending`; verifies the list; re-mints `shares` for every entry from `cursor` on, emitting `RedeemReversed(bytes32 indexed key, address indexed user, uint256 shares, uint256 assets)`; `pendingPayouts -= remaining`; deletes the batch; `PayoutBatchCancelled(bytes32 indexed key, uint256 remaining)`.
  - internal `_verifyPayouts(bytes32 key, Payout[] calldata payouts) view returns (PayoutBatch storage)`: recomputes the running hash over the whole list; length or hash mismatch → `PayoutsMismatch`.

- [ ] **Step 1: Write the failing tests**

`contracts/test/vault/VaultPayouts.t.sol is VaultTestBase`; `setUp` calls `staking.setOneRaoShort(false)`, delivers `1_000e18` for alice (`1e27` shares), has the keeper `stakeIdle()`, sets the stub fee to `1e15`, and queues batch `K`: alice redeems `1e26` → payout `Payout(alice, 1e26, 100e18)`; then `vm.warp(+24 hours)` unless the test says otherwise. Literals: with fee `1e15` on a `100e18` chunk, `net = 100e18 - 1e15 = 99_999e15` (rao-aligned) and the send carries exactly `100e18`. For alice `1e18` and bob `2e18` with fee `1e15`: `ded = ceil(3.333…e14) = 333_333_333_333_334` and `ceil(6.666…e14) = 666_666_666_666_667`; nets floor to `999_666_666_000_000_000` and `1_999_333_333_000_000_000`; sent `2_999_999_999_000_000_000`; `1e9` wei stays in the vault.

```solidity
function test_processPayouts_beforeDelayReverts()              // PayoutDelayed at +24h-1s
function test_processPayouts_wrongListReverts()                // wrong user, wrong length → PayoutsMismatch
function test_processPayouts_unknownKeyReverts()               // NotPending
function test_processPayouts_singleChunkSendsNetPlusFee()      // Unstaked(HK1, 100_000_000_000, 100e18); bridge.lastValue 100e18, lastAmount 99_999e15, lastMessage == encodePayouts(K, 0, [Entry(alice, 99_999e15)]), lastDestChain BASE, lastRecipient frontDoor; PayoutChunkSent(K, 0, 1, 100e18, 99_999e15, 1e15); pendingPayouts 0; batch deleted; processed[K] true
function test_processPayouts_feeRoundingRemainderStaysInVault() // alice 1e18 + bob 2e18 batch → the literals above; grossAssets drops by exactly 2_999_999_999_000_000_000
function test_processPayouts_feeCeilingReverts()               // setFee(1e18 + 1) → FeeTooHigh (ceiling max(1e18, 2e16)); batch still queued, pendingPayouts unchanged; setFee(1e18) → ok
function test_processPayouts_dustTailCompletesBatch()          // bob holds 1e16 worth; redeem all; setFee(2e16); sum 1e16 <= fee → PayoutDust(K2, bob, 1e16); no send; batch deleted; pendingPayouts 0; grossAssets unchanged
function test_processPayouts_individualDustEntryDropped()      // alice 5e18 + bob 1e9 entries → PayoutDust(K, bob, 1e9); message carries alice only; amount == alice's net
function test_processPayouts_chunksByMessageValue()            // bob and carol each deposit 100e18 via a batch; three 60e18 payouts (alice, bob, carol) in one batch (setOutflowLimits(10000, 100e18) first); setMessageLimits(2_000e18, 150e18, 1); one call → chunk 0 = alice+bob (120e18), cursor 2, remaining 60e18, pendingPayouts 60e18; second call → carol; two sends
function test_processPayouts_maxEntriesRaisedToMinChunk()      // setMessageLimits(2_000e18, 4_000e18, 2); maxEntries 1 → takes 2; then takes the last 1
function test_processPayouts_oversizedFirstEntryStillTaken()   // setMessageLimits(50e18, 50e18, 10) after a 60e18 entry queued → sent anyway
function test_processPayouts_unstakesAcrossHotkeys()           // stake split HK1/HK2 via moveStake; payout larger than one position → two Unstaked events
function test_processPayouts_retriesAfterPrecompileRevert()    // setUnstakeBlocked(true) → revert bubbles, cursor 0, pending unchanged; unblock → ok
function test_processPayouts_frontDoorInactiveHoldsThenCancel() // guardian removeFrontDoor → FrontDoorInactive; owner cancelPayoutBatch → alice +1e26, pendingPayouts 0, RedeemReversed(K, alice, 1e26, 100e18), PayoutBatchCancelled(K, 100e18)
function test_processPayouts_primaryBridgeDisabledHoldsBatch() // guardian disableBridge(primary) → PrimaryBridgeDisabled, no change; new StubBridge proposed+activated, setPrimaryBridge → sent through it
function test_processPayouts_twoBatchesFullyStakedBThenA()     // bob also holds; batch A alice 30e18, batch B bob 40e18; process B then A → both sent, pendingPayouts 0
function test_processPayouts_twoBatchesFullyStakedAThenB()
function test_processPayouts_doneBatchRevertsNotPending()
function test_processPayouts_whilePausedReverts()
function test_cancelPayoutBatch_afterPartialChunk()            // chunking scenario; after chunk 0 cancel → only carol re-minted (6e25), pendingPayouts 0
function test_cancelPayoutBatch_ownerOnly()                    // guardian → OwnableUnauthorizedAccount
function test_cancelPayoutBatch_worksWhilePaused()
function test_cancelPayoutBatch_wrongListReverts()             // PayoutsMismatch
function test_cancelPayoutBatch_priceStaysAtOrAboveDeliveryPrice() // p0 = price() before the redeem batch; claim 1 TAO and warp 7 days; cancel → price() >= p0
function test_cancelPayoutBatch_keepsBurnedWindow()            // burnWindows(peer).burned unchanged after cancel
function test_redeemDirect_leavesPendingPayoutsReserved()      // vault liquid (no stakeIdle in this test): bob redeemDirect 5e25 paid from balance; pendingPayouts unchanged
function test_stakeIdle_flooredWhenPendingExceedsBalance()     // fully staked vault with K queued: keeper stakeIdle → NothingToStake (no underflow revert)
```

- [ ] **Step 2: Run to verify they fail** — functions missing.

- [ ] **Step 3: Implement `processPayouts`, `cancelPayoutBatch`, `_verifyPayouts`.**

Effects (cursor, chunk, remaining, pendingPayouts, delete) before the external `send`.

- [ ] **Step 4: Run to verify they pass, then the suite; size check** — 27 passed; `forge build --sizes`: `CascadeVault` must be under 24,576 bytes. If it is not, apply the spec's agreed fallback in this order and re-run the suite: (a) move csTAO into a minimal `CascadeShares` ERC-20 (`contracts/src/CascadeShares.sol`, mint/burn only by the vault, deployed from the vault's constructor; the vault keeps `balanceOf`/`totalSupply` as external reads), then (b) lower `optimizer_runs` in `foundry.toml`. Record which, if any, was needed in the report.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/CascadeVault.sol contracts/test/vault/VaultPayouts.t.sol
git commit -m "feat(contracts): chunked payouts with fee ceiling and owner cancel that returns shares"
```

---

### Task 9: CascadeFrontDoor — batches, deposits, redeem requests, close

**Files:**
- Create: `contracts/src/CascadeFrontDoor.sol`, `contracts/test/FrontDoorTestBase.sol`
- Test: `contracts/test/frontdoor/FrontDoorBatches.t.sol`

**Interfaces:**
- Consumes: `CascadeBase` (Task 3), `CascadeMessages.encodeBatch` / `Entry` (Task 1), `StubBridge` ERC-20 side and `MockTAO` (Task 2), OpenZeppelin `SafeERC20`, `IERC20Metadata`.
- Produces: `contract CascadeFrontDoor is CascadeBase` (Task 10 adds `ICascadeReceiver`) with
  - `uint256 public constant RAO = 1e9;` immutables `IERC20Metadata public immutable asset; uint64 public immutable vaultChain; address public immutable vault;`
  - constructor `(IERC20Metadata asset_, ICascadeBridge bridge, uint64 vaultChain_, address vault_, address owner_, address guardian_, uint64 batchInterval_, uint256 minDeposit_, uint256 depositCap_, uint256 redeemRequestFee_)`: `CascadeBase(owner_, guardian_, address(bridge))`; `asset_.decimals() != 18` → `UnsupportedDecimals()`; `vault_ == 0` → `ZeroAddress`; stores the parameters; defaults `maxDeposits = 50; maxRedeems = 50; maxBatchValue = 4_000e18;` opens batch `id = 1` with `start = block.timestamp` (plan decision: ids start at 1).
  - state: `struct Batch { uint64 id; uint64 start; uint256 totalDeposits; uint256 feePot; Entry[] deposits; Entry[] redeems; }` `Batch internal open;` slot maps `mapping(uint64 => mapping(address => uint256)) internal depositSlot, redeemSlot` (index + 1, 0 = none); `mapping(address => uint256) public claimable; uint256 public totalClaimable; uint256 public netForwarded; mapping(bytes32 => mapping(uint32 => bool)) public delivered; mapping(address => uint256) public feeCredit; uint256 public totalFeeCredit; uint64 public batchInterval; uint256 public minDeposit; uint256 public depositCap; uint256 public redeemRequestFee; uint32 public maxDeposits; uint32 public maxRedeems; uint256 public maxBatchValue;`
  - views: `openBatch() returns (uint64 id, uint64 start, uint256 totalDeposits, uint256 feePot, uint256 nDeposits, uint256 nRedeems)`, `openDeposits() returns (Entry[] memory)`, `openRedeems() returns (Entry[] memory)`, `depositOf(address) returns (uint256)`, `redeemOf(address) returns (uint256)` (open batch only), `canClose() returns (bool)` = `block.timestamp >= start + batchInterval || deposits.length >= maxDeposits || redeems.length >= maxRedeems || totalDeposits + minDeposit > maxBatchValue` (the last term is the spec's "full by value" test written without subtraction — Review Focus 2).
  - `deposit(uint256 amount)` = `depositFor(msg.sender, amount)`; `depositFor(address user, uint256 amount) whenNotPaused nonReentrant` as the spec bullet, plus `amount == 0` → `ZeroAmount()` (Review Focus 4); pulls with `safeTransferFrom(msg.sender, …)`; `DepositRequested(uint64 indexed batchId, address indexed user, uint256 amount, address payer)`.
  - `cancelDeposit(uint256 amount) nonReentrant` (works while paused): `ZeroAmount`, `NotRaoAligned`, `InsufficientRequest()`; swap-and-pop frees the slot at zero; `DepositCancelled(uint64 indexed batchId, address indexed user, uint256 amount)`.
  - `creditRedeemFee(address user) payable`: `ZeroAddress`, `msg.value == 0` → `ZeroAmount`; `FeeCredited(address indexed user, uint256 amount, address payer)`.
  - `requestRedeem(uint256 shares) payable whenNotPaused nonReentrant` as the spec bullet (`ZeroAmount`; existing entry → `msg.value != 0` is `WrongFee()`; else close first if `redeems.length >= maxRedeems` using `_closeBatch(open.feePot)`, then the fee by value or by credit, else `WrongFee`); `RedeemRequested(uint64 indexed batchId, address indexed user, uint256 shares)`.
  - `cancelRedeem(uint256 shares) nonReentrant` (works while paused; no alignment rule; fee not refunded): `RedeemCancelled(uint64 indexed batchId, address indexed user, uint256 shares)`.
  - `closeBatch() payable whenNotPaused nonReentrant`: `!canClose()` → `BatchNotReady()`; empty batch → restart `start`, refund `msg.value` by `call` (`TransferFailed()`), `BatchRolled(uint64 indexed id)`; else `_closeBatch(open.feePot + msg.value)`.
  - internal `_closeBatch(uint256 budget)`: `message = encodeBatch(open.id, open.deposits, open.redeems)`; `fee = _primary().quoteFee(vaultChain, vault, message, open.totalDeposits)`; `budget < fee` → `InsufficientFee()`; effects first (capture id/totals/counts/pot, `netForwarded += totalDeposits`, `delete open`, then `open.id = id + 1; open.start = now`); `asset.forceApprove(bridge, totalDeposits)`, `bridge.send{value: fee}(vaultChain, vault, message, totalDeposits)`, `forceApprove(bridge, 0)`; `budget - fee` to `msg.sender` by `call` (`TransferFailed`); `BatchClosed(uint64 indexed id, uint256 totalDeposits, uint256 nDeposits, uint256 nRedeems, uint256 fee, uint256 potUsed)` with `potUsed = min(pot, fee)`.
  - admin: `setCaps(uint256 minDeposit_, uint256 depositCap_)`, `setBatchLimits(uint32 maxDeposits_, uint32 maxRedeems_)` (each in `1..MAX_ENTRIES`, else `InvalidParameter()`), `setMaxBatchValue(uint256)`, `setBatchInterval(uint64)`, `setRedeemRequestFee(uint256)`; each emits `LimitSet(bytes32 indexed name, uint256 a, uint256 b)`.
  - `receive()` reverts `DirectTransferNotAllowed()` (ETH enters only through `requestRedeem`, `creditRedeemFee` and `closeBatch`).
  - `FrontDoorTestBase` (abstract, `is Test`): `MockTAO tao = new MockTAO(18)`; `StubBridge bridge = new StubBridge(tao)` with `fee = 1e15`; `vault = makeAddr("vault")`; `CascadeFrontDoor fd = new CascadeFrontDoor(tao, bridge, BITTENSOR, vault, owner, guardian, 12 hours, 1e18, 10_000e18, 1e14)`; alice/bob/carol minted `1_000e18`, approved, dealt `1 ether`; helper `fillRedeems(uint256 n)` (n fresh addresses each dealt `1e14` and requesting `1` share with the fee), `requestWithFee(address user, uint256 shares)`.

- [ ] **Step 1: Write the failing tests**

`contracts/test/frontdoor/FrontDoorBatches.t.sol is FrontDoorTestBase`:

```solidity
function test_constructorRejectsNon18Decimals()        // new MockTAO(6) → UnsupportedDecimals
function test_constructorOpensBatchOne()               // openBatch().id == 1, start == now, maxDeposits 50, maxRedeems 50, maxBatchValue 4_000e18
function test_depositMergesPerUser()                   // alice 10e18 twice → one entry 20e18, nDeposits 1, totalDeposits 20e18; DepositRequested(1, alice, 10e18, alice)
function test_depositForNamesUserAndChargesPayer()     // bob depositFor(alice, 5e18) → bob's tokens, alice's entry, event payer bob
function test_depositZeroAmountReverts()               // setCaps(0, 10_000e18); deposit(0) → ZeroAmount
function test_depositRejectsMisalignedBelowMinAndZeroUser() // NotRaoAligned (1e18+1), BelowMinDeposit (1e18-1e9), ZeroAddress
function test_depositCapCountsNetForwarded()           // 10_001e18 → CapExceeded; close a 100e18 batch, then 9_901e18 → CapExceeded, 9_900e18 ok
function test_depositBatchValueFull()                  // 3_000e18 then 1_001e18 → BatchValueFull
function test_depositBatchFullUnlessMerging()          // setBatchLimits(2, 2): alice, bob ok; carol → BatchFull; alice again ok
function test_depositWhilePausedReverts()
function test_cancelDepositPartialThenFullFreesSlot()  // 10e18; cancel 4e18 → entry 6e18, tokens back; cancel 6e18 → nDeposits 0, depositOf 0; again → InsufficientRequest; 1e9+1 → NotRaoAligned; works while paused
function test_cancelDepositFreesSlotForOthers()        // setBatchLimits(1, 1): alice in; bob → BatchFull; alice cancels; bob ok
function test_requestRedeemFeeOnFirstEntryOnly()       // alice {1e14} 5e24 → feePot 1e14, RedeemRequested(1, alice, 5e24); {1e14} again → WrongFee; {0} 3e24 → entry 8e24
function test_requestRedeemWrongFeeReverts()           // {1e14 - 1} → WrongFee; {0} without credit → WrongFee
function test_requestRedeemFromCredit()                // bob creditRedeemFee(alice){1e14} → FeeCredited(alice, 1e14, bob), totalFeeCredit 1e14; alice {0} → feePot 1e14, feeCredit 0, totalFeeCredit 0
function test_creditNotSpendableByOthers()             // credit alice; bob {0} → WrongFee
function test_creditZeroValueReverts()                 // ZeroAmount
function test_requestRedeemZeroAndPausedRevert()
function test_cancelRedeemKeepsFeeAndFreesSlot()       // cancel all → nRedeems 0; feePot still 1e14; fd.balance == feePot + totalFeeCredit
function test_closeBatchBeforeIntervalReverts()        // BatchNotReady; +12h ok
function test_closeBatchSendsThroughPrimaryBridge()    // alice 10e18, bob requests 1e24 {1e14}; +12h; carol closeBatch{1e15} → lastDestChain BITTENSOR, lastRecipient vault, lastAmount 10e18, lastValue 1e15, lastMessage == encodeBatch(1, [Entry(alice,10e18)], [Entry(bob,1e24)]); tao.balanceOf(bridge) 10e18; carol's ETH −9e14 net; BatchClosed(1, 10e18, 1, 1, 1e15, 1e14); open id 2; netForwarded 10e18; fd.balance 0
function test_closeBatchPotCoversFeeRemainderToCloser() // setFee(5e13); one request (pot 1e14); carol closeBatch{0} → carol +5e13; potUsed 5e13
function test_closeBatchInsufficientFeeReverts()        // pot 0, {1e15 - 1} → InsufficientFee
function test_closeBatchEmptyRollsAndRefunds()          // +12h; closeBatch{7} → BatchRolled(1); id 1; start == now; caller refunded
function test_closeBatchEarlyWhenRedeemListFull()       // setBatchLimits(50, 2); two requests → close before the interval
function test_closeBatchEarlyWhenFullByValue()          // deposit 3_999_500_000_000_000_000_000 → closable early (3_999.5 + 1 > 4_000)
function test_closeBatchAfterMaxBatchValueLoweredBelowTotal() // 3_000e18 in; setMaxBatchValue(2_000e18); deposit 1e18 → BatchValueFull; closeBatch early → ok
function test_closeBatchRedeemOnlyBatchSendsZeroAmount() // one request; +12h; close{1e15} → lastAmount 0, message has no deposits, no tokens moved
function test_closeBatchPrimaryDisabledReverts()        // guardian disableBridge → PrimaryBridgeDisabled; cancelDeposit still works
function test_closeBatchWhilePausedReverts()
function test_requestRedeemSelfClosesFullBatch()        // setFee(2e14); setBatchLimits(50, 3); fillRedeems(3); alice {1e14} requestRedeem(1e24) → BatchClosed(1, 0, 0, 3, 2e14, 2e14); alice received the 1e14 remainder; open id 2 with redeemOf(alice) 1e24 and feePot 1e14
function test_requestRedeemSelfCloseInsufficientPotReverts() // fee 1e15, 3 junk requests (pot 3e14) → alice's request → InsufficientFee
function test_ethIdentityHolds()                        // after credits, requests, cancels and a close: fd.balance == feePot + totalFeeCredit
function test_settersValidateAndOwnerOnly()             // setBatchLimits(0,1), (101,1) → InvalidParameter; guardian → OwnableUnauthorizedAccount
function test_receiveRejectsEth()                       // DirectTransferNotAllowed
```

- [ ] **Step 2: Run to verify they fail** — compilation fails.

- [ ] **Step 3: Write `CascadeFrontDoor.sol` (everything in Produces; `onBridgeMessage` and `claim` are Task 10) and `FrontDoorTestBase.sol`.**

- [ ] **Step 4: Run to verify they pass, then the suite** — 35 passed; suite green; `forge build --sizes` for the front door noted.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/CascadeFrontDoor.sol contracts/test/FrontDoorTestBase.sol contracts/test/frontdoor/FrontDoorBatches.t.sol
git commit -m "feat(contracts): Base front door — merged batches, redeem-request fee, self-closing requests"
```

---

### Task 10: CascadeFrontDoor — payouts in, claims out

**Files:**
- Modify: `contracts/src/CascadeFrontDoor.sol`
- Test: `contracts/test/frontdoor/FrontDoorPayouts.t.sol`

**Interfaces:**
- Consumes: Task 9 state; `CascadeMessages.decodePayouts`.
- Produces: the contract now declares `is CascadeBase, ICascadeReceiver`, and
  - `onBridgeMessage(uint64 sourceChain, address sender, bytes calldata message, uint256 amount) external payable nonReentrant` (works while paused) exactly as the spec bullet: `_requireBridge()`; `(sourceChain, sender) != (vaultChain, vault)` → `UnknownPeer()`; `msg.value != 0` → `ValueMismatch()`; `decodePayouts`; `Σ payouts != amount` → `AmountMismatch()`; `asset.balanceOf(this) < open.totalDeposits + totalClaimable + amount` → `TokensNotReceived()`; `delivered[batchKey][chunk]` → `DuplicatePayouts()`; credits; `netForwarded -= min(netForwarded, amount)`; `PayoutReceived(bytes32 indexed batchKey, uint32 chunk, address indexed user, uint256 amount)` per entry. An empty list with `amount == 0` is accepted and marked delivered (plan decision).
  - `claim() external nonReentrant` (works while paused): `NothingToClaim()`; zero first, `totalClaimable -= amount`, `safeTransfer`; `Claimed(address indexed user, uint256 amount)`.

- [ ] **Step 1: Write the failing tests**

`contracts/test/frontdoor/FrontDoorPayouts.t.sol is FrontDoorTestBase` with helper `deliverPayouts(bytes32 key, uint32 chunk, Entry[] memory payouts, bool mintFirst)` (mints `Σ` to `fd` when asked, pranks `bridge`, calls `onBridgeMessage(BITTENSOR, vault, encodePayouts(key, chunk, payouts), Σ)`):

```solidity
function test_payoutCreditsClaimable()                 // alice 3e18, bob 2e18 → claimable; totalClaimable 5e18; PayoutReceived twice; delivered[key][0]
function test_payoutFromAnyEnabledBridge()             // bridge2 proposed/activated delivers → ok; stranger → NotBridge
function test_payoutWrongPeerReverts()                 // (BITTENSOR, other) and (BASE, vault) → UnknownPeer
function test_payoutValueMismatchReverts()             // msg.value 1 → ValueMismatch
function test_payoutAmountMismatchReverts()
function test_payoutTokensNotReceivedThenRedelivered() // without mint → TokensNotReceived; mint → ok
function test_payoutDuplicateChunkReverts()            // same (key, 0) → DuplicatePayouts; (key, 1) ok
function test_payoutReducesNetForwardedFloored()       // close a 10e18 deposit batch → netForwarded 10e18; payout 4e18 → 6e18; payout 20e18 → 0
function test_payoutWorksWhilePaused()
function test_payoutEmptyListAccepted()                // amount 0 → delivered set, nothing credited
function test_claimTransfersAndZeroes()                // alice +3e18; claimable 0; totalClaimable 2e18; Claimed(alice, 3e18); again → NothingToClaim; works while paused
function test_balanceIdentityWithOpenDepositsAndDonation() // 10e18 open + 5e18 payouts → balance 15e18 >= 15e18; a 1e18 donation keeps >=
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement `onBridgeMessage` and `claim`.**

- [ ] **Step 4: Run to verify they pass, then the suite** — 12 passed; suite green.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/CascadeFrontDoor.sol contracts/test/frontdoor/FrontDoorPayouts.t.sol
git commit -m "feat(contracts): front door payout credits and pull claims"
```

---

### Task 11: MockBridge v2, end-to-end flows, gas and size tests

**Files:**
- Create: `contracts/test/mocks/MockBridge.sol`, `contracts/test/Gas.t.sol`
- Test: `contracts/test/EndToEnd.t.sol`

**Interfaces:**
- Consumes: both contracts complete (Tasks 4–10), `MockTAO`, mocks.
- Produces `MockBridge is ICascadeBridge` (one EVM, two "chains"):
  - constructor `(MockTAO token)`; `connect(uint64 chain, address contract_, bool native)` records `endpoint[chain] = contract_`, `nativeOf[chain] = native`, `chainOf[contract_] = chain`.
  - settings: `setFee(uint256)` (default 0), `setMaxMessageValue(uint256)` (default `5_000e18`), `setDeliveryGas(uint256)` (default `7_000_000`), `setAutoDeliver(bool)` (default true), `failNext()` (the next delivery attempt is recorded as failed without calling the receiver).
  - `quoteFee(...)` returns `fee`. `send(destChain, recipient, message, amount)`: `chainOf[msg.sender] == 0` → `UnknownSender()`; native source → `msg.value < amount + fee` is `InsufficientFee()`; ERC-20 source → `msg.value < fee` is `InsufficientFee()` and `amount` tokens are pulled from the sender; `amount > maxMessageValue` → `RateLimited()`; nothing is ever refunded; queues `Delivery { uint64 destChain; address recipient; uint64 sourceChain; address sender; bytes message; uint256 amount; bool funded; }`; `autoDeliver` → `deliverNext()`.
  - `deliverNext() returns (bool ok)`: pops the oldest pending delivery; if `failNext` was set, clears it and files the delivery as failed; otherwise funds it once (`funded` guards retries: native destination → `vm.deal(this, balance + amount)`; ERC-20 destination → `token.mint(recipient, amount)`), then low-level calls `recipient.onBridgeMessage{value: native ? amount : 0, gas: deliveryGas}(sourceChain, sender, message, amount)`; on failure files it under `failed` and emits `DeliveryFailed(uint256 index, bytes reason)`. `retryNext() returns (bool ok)` retries the oldest failed delivery the same way. Views `pendingCount()`, `failedCount()`.
- Produces `EndToEnd.t.sol` fixture: mocks etched; `tao = new MockTAO(18)`; `bridge = new MockBridge(tao)` with `fee = 1e15`; vault deployed as in `VaultTestBase` (predicted address, `HK1`, `minDirectDeposit 1e15`, reserve funded, keeper set); `fd = new CascadeFrontDoor(tao, bridge, BITTENSOR, address(vault), owner, guardian, 12 hours, 1e18, 10_000e18, 1e14)`; `bridge.connect(BITTENSOR, address(vault), true)`, `bridge.connect(BASE, address(fd), false)`; `(BASE, fd)` registered on the vault; `staking.setOneRaoShort(false)`; users minted `1_000e18` and approved, dealt `1 ether`.

- [ ] **Step 1: Write the failing end-to-end tests**

Literals for `test_fullLifecycle`: alice deposits `10e18` → `1e25` shares; the keeper stakes `10_000_000_000` rao; a claim of `1_000_000_000` rao vests over 7 days to `totalAssets == 11e18`; alice redeems `5e24` → `assetsForRedeem(5e24, 11e18, 1e25) = 5_499_999_999_999_999_999` floors to rao `5_499_999_999_000_000_000`; with fee `1e15` the net is `5_498_999_999_000_000_000` and the vault unstakes `5_499_999_999` rao, leaving `5_500_000_001` rao staked.

```solidity
function test_fullLifecycle()            // deposit → close (auto-delivered) → shares 1e25 → stakeIdle → claim + 7 days → requestRedeem{1e14}(5e24) → close → Redeemed(key, alice, 5e24, 5_499_999_999_000_000_000) → +24h → processPayouts(key, list, 50) → fd.claimable(alice) == 5_498_999_999_000_000_000 → claim → tao.balanceOf(alice) == 1_000e18 - 10e18 + 5_498_999_999_000_000_000; vault.pendingPayouts 0; rootStakeRao 5_500_000_001; fd.netForwarded == 10e18 - 5_498_999_999_000_000_000
function test_secondFrontDoorOnAnotherChain()  // fd2 on chain 4663 connected and registered; 1_000e18 through each; each burns 200e18-worth in one window; a third request from fd1 is deferred
function test_rogueFrontDoorIsBoundedAndReversed() // alice 1_000e18 via fd, staked; owner registers `rogue` (an EOA) as a BASE front door; a BATCH from (BASE, rogue) redeeming alice's 1e27 is injected via vm.prank(address(bridge)) → burns 2e26 only; guardian removeFrontDoor(BASE, rogue) (vault not paused); +24h processPayouts → FrontDoorInactive; owner cancelPayoutBatch → alice 1e27; pendingPayouts 0; alice's honest redeem through fd still pays out
function test_failedDeliveryIsRetried()  // pause vault; fd closeBatch → bridge.failedCount() 1, no shares; unpause; bridge.retryNext() == true → shares minted
function test_deliveryGasCapCatchesRegression() // bridge.setDeliveryGas(100_000); close → failed; setDeliveryGas(7_000_000); retryNext → ok
function test_lostTokensDoNotBlockOtherBatches() // bridge.failNext(); close batch 1 (filed as failed); batch 2 closes and delivers normally; retryNext delivers batch 1 afterwards
```

- [ ] **Step 2: Run to verify they fail** — `MockBridge` missing.

- [ ] **Step 3: Write `MockBridge.sol`, then make the end-to-end tests pass.**

- [ ] **Step 4: Write the gas and size tests**

`contracts/test/Gas.t.sol is VaultTestBase` (stub bridge; the test pranks the bridge and calls `onBridgeMessage` directly). `setUp` delivers one batch of 100 holders (`address(uint160(0x1000 + i))`, `10e18` each; allowance is then `200e18`).

```solidity
function test_gas_delivery100Plus100Under6_5M()   // 100 fresh depositors (0x2000+i, 1e18 each) + 100 holder redeems of 1e24; g = gasleft() before/after the call; emit log_named_uint("gas 100+100", g); assertLt(g, 6_500_000)
function test_gas_delivery50Plus50Under3_5M()     // same shape with 50 + 50; assertLt(g, 3_500_000)
function test_size_vaultAndFrontDoorUnderLimit()  // address(vault).code.length < 24_576 and a front door's code.length < 24_576
```

If a gas test fails, do not loosen the bound: report the measured number and stop; the controller rules on optimisations (first candidates: pack `PayoutBatch`, avoid re-reading `balanceOf` in the redeem loop, emit one `Redeemed` per entry only).

- [ ] **Step 5: Run everything** — `forge test` green; `forge build --sizes` under the limit.

- [ ] **Step 6: Commit**

```bash
git add contracts/test/mocks/MockBridge.sol contracts/test/EndToEnd.t.sol contracts/test/Gas.t.sol
git commit -m "test(contracts): chain-aware mock bridge, end-to-end flows, delivery gas and size bounds"
```

---

### Task 12: Invariant suite

**Files:**
- Create: `contracts/test/invariants/Handler.sol`, `contracts/test/invariants/Cascade.invariants.t.sol`

**Interfaces:**
- Consumes: the `EndToEnd` fixture shape (Task 11), `MockBridge` with `autoDeliver`, `vm.recordLogs`/`vm.getRecordedLogs` to rebuild payout lists from `Redeemed` events.
- Produces: `Handler is CommonBase, StdCheats, StdUtils` over three actors, exact stake reads (`setOneRaoShort(false)`), no donations. Ghosts: `ghostIn` (TAO wei delivered into the vault: batch values + direct deposits), `ghostOut` (Σ `net + fee` sent by payouts + Σ `redeemDirect` payouts), `ghostRewards` (Σ claimed delta × RAO), `ghostPayoutsReceived`, `ghostClaimed`, `priceFloor`, `burnViolations`, `unexpectedReverts`, `bytes32[] queuedKeys` (keys with `cursor < count`), `mapping(bytes32 => uint256) deliveryPrice`, `mapping(bytes32 => Payout[]) lists`, reachability counters (`closes`, `deliveries`, `payoutChunks`, `claims`, `directDeposits`, `directRedeems`, `rewardClaims`, `cancels`). Actions, each with `bound`ed inputs and wrapped in `try/catch`: `deposit(seed, amount)` (`1e18..100e18`, rao-aligned), `requestRedeem(seed, shares)` (pays the fee by value), `cancelDeposit(seed, amount)`, `cancelRedeem(seed, shares)`, `closeBatch()` (warps 12h; records logs; stores the `Redeemed` list and `PayoutBatchQueued` price per key; ghostIn += value), `processPayouts(seed)` (picks a queued key; warps 24h; `maxEntries 50`; ghostOut += `net + fee` from `PayoutChunkSent`; drops the key when done), `claim(seed)`, `depositDirect(seed, amount)`, `redeemDirect(seed, shares)`, `stakeIdle()` (as keeper; only when idle ≥ min), `accrueAndClaim(rao)` (`1e6..1e9` rao; as keeper with 60M gas; ghostRewards += delta × RAO), `warp(seconds)` (`1 hour..3 days`), `cancelQueued(seed)` (as owner; `priceFloor = min(priceFloor, deliveryPrice[key])`). After every successful action other than cancel: `priceFloor = max(priceFloor, vault.price())`. After every delivery: `burnViolations++` if `burnWindows(peer).burned > max(grossAssets * 2000 / 10000, 100e18)`. `unexpectedReverts++` when a call whose precondition the handler checked reverts (a close with `canClose()`, a payout past its delay with the stored list, a claim of a non-zero `claimable`, a stakeIdle with idle ≥ min).

- [ ] **Step 1: Write the invariant test**

`Cascade.invariants.t.sol is Test` (`targetContract(handler)`):

```solidity
function invariant_priceNeverFallsExceptAcrossCancel() // CascadeMath.price(vault.totalAssets() + 1e9, vault.totalSupply()) >= handler.priceFloor()
function invariant_grossAssetsConserved()              // vault.grossAssets() == ghostIn - ghostOut + ghostRewards
function invariant_pendingPayoutsMatchQueue()          // Σ payoutBatches(key).remaining over queuedKeys == vault.pendingPayouts()
function invariant_burnWindowsRespected()              // handler.burnViolations() == 0
function invariant_frontDoorIdentities()               // tao.balanceOf(fd) >= open.totalDeposits + totalClaimable; address(fd).balance == feePot + totalFeeCredit
function invariant_claimsNeverExceedPayouts()          // ghostClaimed <= ghostPayoutsReceived && totalClaimable == ghostPayoutsReceived - ghostClaimed
function invariant_noUnexpectedReverts()               // == 0
function invariant_reachabilityLogged()                // emit log_named_uint for every counter; no assertion
```

- [ ] **Step 2: Run to verify it fails** — `forge test --match-path "test/invariants/*"`: compilation fails.

- [ ] **Step 3: Write the handler**, then run `forge test --match-path "test/invariants/*" -vv` until all invariants hold with the configured `runs = 128, depth = 64`. A genuine invariant failure is a finding about the contracts: report it with the sequence, do not weaken the invariant.

- [ ] **Step 4: Run the whole suite** — green.

- [ ] **Step 5: Commit**

```bash
git add contracts/test/invariants
git commit -m "test(contracts): v2 invariant suite — price, conservation, queues, windows, identities"
```

---

### Task 13: Documentation — README and architecture to v2

**Files:**
- Modify (rewrite): `contracts/README.md`, `docs/architecture.md`

**Interfaces:**
- Consumes: the final contracts and the spec's fixed statements.
- Produces: documentation only; no code.

- [ ] **Step 1: Rewrite `contracts/README.md`** with these sections, in this order: Contracts (vault, front door, base, libraries, what adapters must honour — the "Adapters" obligations list from the spec, verbatim in substance); Build and test (unchanged commands; `forge build --sizes`); Money flow (deposit leg, payout leg, direct access); Roles (the keeper/fee table from the spec section "Keepers and fees"); Exit safety — copy the spec's "Honest statement for the README" paragraph verbatim, then the four layers in one line each; Who can use direct access (the spec's wording: EOAs with TAO for gas; smart-wallet users rely on the front door; legacy `CREATE` contract wallets must be refused by the app); Operator notes: fund the vault's address with at least `ED_RESERVE` (1e12 wei) before first use; keep `redeemRequestFee × maxRedeems ≥` the live bridge fee or a junk-filled batch cannot self-close; set `maxTotalAssets` and the front door's `depositCap` to the beta cap; claims need a 55M gas limit; rails can be stopped by ForeverMoney's 2-of-3 Safe, Chainlink's lane configuration and Bittensor's sudo key with no delay; Pre-mainnet checklist: carry over every item from the current README and `docs/architecture.md` lists that v2 did not resolve (drop decimals, the min-unstake constant and the single-bridge items), and add: fork measurement of delivery gas before raising batch limits above 50 + 50, `try/catch` behaviour of a view read on the live runtime, ForeverMoney's conversion interface, CCIP 2.0 lane migration status, CCIP manual re-execution never expiring, CCIP fee independence from token amount on these lanes, confirmation on testnet 945 that `claimRootWithHotkey` behaves as the mock models.

- [ ] **Step 2: Rewrite `docs/architecture.md`** as "Cascade architecture (v2)": product decisions (unchanged ones kept), the two-contract money flow with the accounting on Bittensor, why the vault is denominated in TAO, how pricing works (one price per batch from the real stake, vested rewards), the exit-safety summary, and a pointer to the spec and the README checklist. Keep it under 120 lines.

- [ ] **Step 3: Commit**

```bash
git add contracts/README.md docs/architecture.md
git commit -m "docs: v2 contracts README and architecture"
```
