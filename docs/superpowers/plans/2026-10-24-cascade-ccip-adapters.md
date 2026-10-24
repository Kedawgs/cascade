# Cascade CCIP Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two immutable adapter contracts that carry Cascade's batches between the Base front door and the Bittensor vault over Chainlink CCIP 2.0, converting ForeverMoney's bridged TAO to native TAO and back in the same transaction, proven on forks of both mainnets.

**Architecture:** A shared abstract base (`CcipAdapterBase`) implements `ICascadeBridge` toward the Cascade peers and `IAny2EVMMessageReceiver` toward CCIP: it builds the CCIP message (19-byte V3 extra args, payload `abi.encode(recipient, sender, message)`), sizes gas from the Cascade message's byte length, enforces the fee rule, and verifies deliveries. `CcipBaseAdapter` moves ERC-20 tokens in and out of the front door; `CcipBittensorAdapter` converts through `AlphaVault` and moves native TAO in and out of the vault. Unit tests run against `MockRouter` and `MockAlphaVault`; fork tests drive the real `OffRamp 2.0.0` with stubbed verifiers.

**Tech Stack:** Solidity 0.8.24 (EVM Cancun), Foundry 1.7 (`forge`, `cast`, `anvil` in `~/.foundry/bin`), forge-std v1.17, OpenZeppelin 5.4 (SafeERC20, IERC165), vendored `@chainlink/contracts-ccip@2.0.0` sources.

**Spec:** `docs/superpowers/specs/2026-10-24-cascade-ccip-adapters-design.md` (parent: `docs/superpowers/specs/2026-10-21-cascade-v2-vault-on-bittensor-design.md`, rail facts: `docs/forevermoney-probe.md`).

## Global Constraints

- Solidity `0.8.24`, `evm_version = "cancun"`, optimizer 200 runs (existing `contracts/foundry.toml`); all commands run from `contracts/` with `export PATH="$HOME/.foundry/bin:$PATH"`.
- Adapters are immutable: no owner, no pause, no upgrade, no rescue, no storage written outside a send or a delivery.
- Chain ids are EVM chain ids (`8453`, `964`); CCIP selectors are `15971525489660198786` (Base) and `2135107236357186872` (Bittensor).
- Fee rule (parent spec): budget at least the fee, pay the Router exactly the fee, keep the excess, never refund.
- Gas cap constant `7_000_000`; constructor rejects `gasBase + 200 * gasPerEntry > 7_000_000`.
- Pool capacity constant `5_000e18` per message; one token per message; data under 32,000 bytes.
- Extra args: exactly 19 bytes, `0xa69dd4aa ‖ uint32 gasLimit ‖ bytes4(0) ‖ bytes7(0)`.
- Amounts are whole rao (`amount % 1e9 == 0`); the Bittensor floor is `STAKING.getDefaultMinStake() * 1e9` read live.
- ERC-165: true for `IAny2EVMMessageReceiver` (`0x85572ffb`) and `IERC165` (`0x01ffc9a7`); false for everything else.
- Vendored Chainlink files are byte-for-byte copies of `@chainlink/contracts-ccip@2.0.0` (integrity `sha512-P0KvQtZSYC1LevMSS16jOOSsqZG4g0n/MJdcWGmE0Z5U01NVYd1MnTQJOBPsbu1NWR79DBXPXLvyr9tR5y+tiw==`), each directory with a `VENDOR.md`.
- Test-first; the full suite (`forge test`) stays green after every task; fork tests are gated by `FORK=1` and skipped otherwise.
- Every commit message ends with the two trailer lines `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01QsFviaJn5ejsAa5vHQciyX`; never `git add -A`.

## Review Focus

1. A delivery whose `destTokenAmounts` is empty while its `BATCH` sums to more than zero: the adapter must pass `amount = 0` and let the vault reject it (`AmountMismatch`), never invent a conversion. Pinned in Task 5 (`test_ccipReceive_noTokensWithNonZeroBatchFailsAtVault`).
2. ForeverMoney paying *more* native TAO than `amount`: the adapter forwards exactly `amount` and the surplus stays in the adapter; it must not revert or forward the surplus. Pinned in Task 5 (`test_ccipReceive_overpaymentStaysInAdapter`).
3. `send` with a budget far above the fee (the front door's fee pot): the Router must receive exactly `fee` (Router 1.2 wraps all of `msg.value` into Chainlink's fee, so overpaying loses it) and the adapter keeps the rest. Pinned in Task 4 (`test_send_paysRouterExactlyFee`).
4. A CCIP sender that is 20 raw bytes, or 32 bytes decoding to another address: `WrongSender`, with no token movement. Pinned in Task 4 (`test_ccipReceive_rejectsUnpaddedSender`, `test_ccipReceive_rejectsOtherSender`).
5. A Cascade message over the lane's data limit: the quote must revert (the FeeQuoter's `MessageTooLarge`) and `closeBatch` must leave the batch open. Pinned in Task 3 (`MockRouter` rejects data over 32,000 bytes) and Task 6 (`test_oversizedBatchLeavesBatchOpen`).

---

## File structure

| Path | Responsibility |
|---|---|
| `contracts/src/vendor/ccip/{Client.sol, IRouterClient.sol, IAny2EVMMessageReceiver.sol, VENDOR.md}` | Chainlink 2.0.0 message structs and interfaces, unmodified |
| `contracts/src/interfaces/IAlphaVault.sol` | ForeverMoney's surface we call or read |
| `contracts/src/adapters/CcipAdapterBase.sol` | Shared send/quote/deliver logic, gas sizing, payload, ERC-165, events, errors |
| `contracts/src/adapters/CcipBaseAdapter.sol` | ERC-20 side (front door peer) |
| `contracts/src/adapters/CcipBittensorAdapter.sol` | Native side (vault peer), `AlphaVault` conversion, reserve |
| `contracts/test/mocks/MockRouter.sol` | CCIP Router/OffRamp double: records sends, quotes fees, delivers like the 2.0 OffRamp |
| `contracts/test/mocks/MockAlphaVault.sol` | ForeverMoney double over `MockTAO` |
| `contracts/test/mocks/MockTAO.sol` (modify) | add `burn` |
| `contracts/test/mocks/MockStaking.sol` (modify) | add a coldkey alias so real `AlphaVault` bytecode works on the mock |
| `contracts/test/adapters/AdapterHarness.sol` | Concrete subclass exposing the base's internals for unit tests |
| `contracts/test/adapters/{CcipAdapterBase,CcipBaseAdapter,CcipBittensorAdapter,AdaptersEndToEnd,AdapterGas}.t.sol` | Unit, end-to-end and gas tests |
| `contracts/test/MockRouter.t.sol`, `contracts/test/MockAlphaVault.t.sol` | Tests of the doubles (pattern: `test/MockBridge.t.sol`) |
| `contracts/test/vendor/ccip/{MessageV1Codec.sol, VENDOR.md}` | Chainlink 2.0.0 wire codec, tests only |
| `contracts/test/fork/{ForkBase.sol, StubVerifier.sol, Sink.sol, BaseFork.t.sol, BittensorFork.t.sol}` | Fork harness and fork tests |
| `contracts/script/simulate_inbound.sh` | Live `eth_call` simulation of an inbound delivery with state overrides |
| `contracts/README.md`, `README.md`, `docs/architecture.md` | Documentation |

---

### Task 1: Vendored Chainlink sources, `IAlphaVault`, and the adapter base's pure helpers

**Files:**
- Create: `contracts/src/vendor/ccip/Client.sol`, `contracts/src/vendor/ccip/IRouterClient.sol`, `contracts/src/vendor/ccip/IAny2EVMMessageReceiver.sol`, `contracts/src/vendor/ccip/VENDOR.md`
- Create: `contracts/src/interfaces/IAlphaVault.sol`
- Create: `contracts/src/adapters/CcipAdapterBase.sol` (helpers and constructor only in this task)
- Create: `contracts/test/adapters/AdapterHarness.sol`
- Test: `contracts/test/adapters/CcipAdapterBase.t.sol`

**Interfaces:**
- Consumes: `ICascadeBridge`, `ICascadeReceiver` (`contracts/src/interfaces/ICascadeBridge.sol`); `CascadeMessages.BATCH = 1`, `PAYOUTS = 2`.
- Produces:
  ```solidity
  // contracts/src/vendor/ccip/* — identical to the npm package; import paths become
  // "../vendor/ccip/Client.sol" etc. (fix only the relative import inside IRouterClient.sol and
  // IAny2EVMMessageReceiver.sol from "../libraries/Client.sol" to "./Client.sol"; VENDOR.md records that one-line change).
  interface IAlphaVault {
      function depositLiquid(address token, uint256 minAlphaRao) external payable returns (uint256 minted);
      function withdrawLiquid(address token, uint256 wad, uint256 minTaoOut) external returns (uint256 taoOut);
      function isPaused() external view returns (bool);
      function isListed(address token) external view returns (bool);
      function positionOf(address token) external view returns (bytes32 validator, uint256 netuid);
      function vaultColdkey() external view returns (bytes32);
  }
  abstract contract CcipAdapterBase is ICascadeBridge, IAny2EVMMessageReceiver, IERC165 {
      struct Config { address router; address token; uint64 localChainId; uint64 remoteChainId; uint64 remoteSelector; address remoteAdapter; uint256 gasBase; uint256 gasPerEntry; }
      uint256 public constant GAS_CAP = 7_000_000;
      uint256 public constant MAX_MESSAGE_VALUE = 5_000e18;
      bytes4 public constant EXTRA_ARGS_V3_TAG = 0xa69dd4aa;
      uint256 internal constant RAO = 1e9;
      IRouterClient public immutable router; IERC20 public immutable token;
      uint64 public immutable localChainId; uint64 public immutable remoteChainId; uint64 public immutable remoteSelector;
      address public immutable remoteAdapter; uint256 public immutable gasBase; uint256 public immutable gasPerEntry;
      constructor(Config memory c);                       // ZeroAddress (router, token, remoteAdapter), SameChain, GasModelTooLarge
      function gasFor(bytes calldata message) public view returns (uint256);
      function extraArgs(uint256 gasLimit) public pure returns (bytes memory);
      function encodePayload(address recipient, address sender, bytes memory message) public pure returns (bytes memory);
      function decodePayload(bytes memory data) public pure returns (address recipient, address sender, bytes memory message);
      function supportsInterface(bytes4 id) public pure virtual returns (bool);
      event Sent(bytes32 indexed messageId, uint64 destChain, address indexed sender, address indexed recipient, uint256 amount, uint256 fee, uint256 gasLimit);
      event Delivered(bytes32 indexed messageId, uint64 sourceChain, address indexed sender, address indexed recipient, uint256 amount);
      error ZeroAddress(); error SameChain(); error GasModelTooLarge(); error WrongDestination(); error MessageTooLarge();
      error BelowSendMinimum(uint256 amount, uint256 minimum); error BelowConversionFloor(uint256 amount, uint256 floor);
      error InsufficientFee(); error NotRaoAligned(); error ConversionShort(); error NotRouter(); error WrongSource();
      error WrongSender(); error WrongToken(); error TooManyTokens(); error UnexpectedValue();
  }
  // test/adapters/AdapterHarness.sol: `contract AdapterHarness is CcipAdapterBase` whose constructor
  // forwards Config and whose send/quoteFee/ccipReceive hooks revert; it exists only to call the public helpers.
  ```

- [ ] **Step 1: Copy the three Chainlink files and write `VENDOR.md`**

From the package tarball `https://registry.npmjs.org/@chainlink/contracts-ccip/-/contracts-ccip-2.0.0.tgz` (verify the integrity string in Global Constraints with `npm view @chainlink/contracts-ccip@2.0.0 dist.integrity`), copy `package/contracts/libraries/Client.sol`, `package/contracts/interfaces/IRouterClient.sol`, `package/contracts/interfaces/IAny2EVMMessageReceiver.sol` into `contracts/src/vendor/ccip/`. Change only the two relative imports to `./Client.sol`. `VENDOR.md` lists package, version, publish date 2026-06-18, integrity, the three files, the import edit, and the sentence "Any other change is a bug."

- [ ] **Step 2: Write the failing helper tests**

```solidity
// test/adapters/CcipAdapterBase.t.sol — fixture: AdapterHarness h = new AdapterHarness(cfg) with
// router/token/remoteAdapter = makeAddr(...), localChainId 8453, remoteChainId 964,
// remoteSelector 2135107236357186872, gasBase 1_000_000, gasPerEntry 25_000.
function test_extraArgs_is19BytesV3() public {
    // tag ‖ uint32 1_500_000 ‖ bytes4 finality 0 ‖ 7 zero bytes (adjacent hex literals concatenate)
    assertEq(h.extraArgs(1_500_000), hex"a69dd4aa" hex"0016e360" hex"00000000" hex"00000000000000");
    assertEq(h.extraArgs(1_500_000).length, 19);
}
function test_gasFor_batchCountsDepositsAndRedeems() public {
    // encodeBatch(1, 1 deposit, 0 redeems) -> 1 entry; encodeBatch(1, 100, 100) -> 200 entries
    assertEq(h.gasFor(CascadeMessages.encodeBatch(1, entries(1), entries(0))), 1_025_000);
    assertEq(h.gasFor(CascadeMessages.encodeBatch(1, entries(100), entries(100))), 6_000_000);
    assertEq(h.gasFor(CascadeMessages.encodeBatch(1, entries(0), entries(0))), 1_000_000);
}
function test_gasFor_payoutsCountsEntries() public {
    assertEq(h.gasFor(CascadeMessages.encodePayouts(bytes32(0), 0, entries(50))), 2_250_000);
}
function test_gasFor_capsAtGasCap() public {
    AdapterHarness big = new AdapterHarness(cfgWith(6_000_000, 5_000)); // 6_000_000 + 200*5_000 == 7_000_000, allowed
    assertEq(big.gasFor(CascadeMessages.encodeBatch(1, entries(100), entries(100))), 7_000_000);
}
function test_gasFor_malformedMessageQuotesCap() public {
    assertEq(h.gasFor(hex"01"), 7_000_000);                    // not a multiple of 32
    assertEq(h.gasFor(abi.encode(uint8(7), uint64(1))), 7_000_000); // unknown kind
}
function test_payload_roundTrip() public {
    bytes memory m = CascadeMessages.encodeBatch(9, entries(2), entries(1));
    (address r, address s, bytes memory out) = h.decodePayload(h.encodePayload(address(0xA), address(0xB), m));
    assertEq(r, address(0xA)); assertEq(s, address(0xB)); assertEq(out, m);
}
function test_supportsInterface() public {
    assertTrue(h.supportsInterface(0x85572ffb)); assertTrue(h.supportsInterface(0x01ffc9a7));
    assertFalse(h.supportsInterface(0xffffffff));
    assertFalse(h.supportsInterface(0x85572ffb ^ bytes4(keccak256("getCCVsAndFinalityConfig(uint64,bytes)"))));
}
function test_constructor_rejections() public {
    vm.expectRevert(CcipAdapterBase.ZeroAddress.selector);     new AdapterHarness(cfgWithRouter(address(0)));
    vm.expectRevert(CcipAdapterBase.SameChain.selector);       new AdapterHarness(cfgWithChains(964, 964));
    vm.expectRevert(CcipAdapterBase.GasModelTooLarge.selector); new AdapterHarness(cfgWith(6_000_001, 5_000));
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `forge test --match-path test/adapters/CcipAdapterBase.t.sol`
Expected: compilation fails — `CcipAdapterBase`, `AdapterHarness` not found.

- [ ] **Step 4: Implement `IAlphaVault.sol`, `CcipAdapterBase.sol` (constructor, constants, helpers, events, errors) and `AdapterHarness.sol`**

`gasFor`: read `kind` from the first 32-byte word when `message.length >= 32`; header words 6 for `BATCH`, 5 for `PAYOUTS`; return `GAS_CAP` when the length is not a multiple of 32, the kind is unknown, the word count is below the header, or the remainder is odd; otherwise `min(gasBase + entries * gasPerEntry, GAS_CAP)` with `entries = (words - header) / 2`. `extraArgs`: `abi.encodePacked(EXTRA_ARGS_V3_TAG, uint32(gasLimit), bytes4(0), bytes7(0))`. Leave `send`, `quoteFee`, `ccipReceive` as `abstract`/unimplemented declarations for Task 2 (the harness stubs them).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `forge test --match-path test/adapters/CcipAdapterBase.t.sol -vv`
Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
git add src/vendor/ccip src/interfaces/IAlphaVault.sol src/adapters/CcipAdapterBase.sol test/adapters/AdapterHarness.sol test/adapters/CcipAdapterBase.t.sol
git commit -m "feat(adapters): vendor CCIP 2.0.0 interfaces, IAlphaVault, adapter base helpers"
```

---

### Task 2: Send, quote and delivery logic in the base

**Files:**
- Modify: `contracts/src/adapters/CcipAdapterBase.sol`
- Modify: `contracts/test/adapters/AdapterHarness.sol`
- Test: `contracts/test/adapters/CcipAdapterBase.t.sol`

**Interfaces:**
- Consumes: Task 1.
- Produces (in `CcipAdapterBase`):
  ```solidity
  function send(uint64 destChain, address recipient, bytes calldata message, uint256 amount) external payable;
  function quoteFee(uint64 destChain, address recipient, bytes calldata message, uint256 amount) external view returns (uint256);
  function ccipReceive(Client.Any2EVMMessage calldata message) external;   // NotRouter, WrongSource, WrongSender, WrongToken, TooManyTokens
  function buildMessage(address recipient, address sender, bytes calldata message, uint256 amount) public view returns (Client.EVM2AnyMessage memory);
  // hooks a concrete adapter implements:
  function _checkAmount(uint256 amount) internal view virtual;                 // side-specific minimum
  function _budget(uint256 amount) internal view virtual returns (uint256);    // fee budget from msg.value
  function _collect(uint256 amount) internal virtual;                           // obtain `amount` tokens and approve the router
  function _deliver(address recipient, address sender, bytes memory message, uint256 amount) internal virtual;
  ```
  `send` order: `_checkSend` (WrongDestination, ZeroAddress recipient, MessageTooLarge, `_checkAmount`) → `buildMessage(recipient, msg.sender, message, amount)` → `fee = router.getFee(remoteSelector, m)` → `if (_budget(amount) < fee) revert InsufficientFee()` → `if (amount > 0) _collect(amount)` → `router.ccipSend{value: fee}` → `if (amount > 0) token.forceApprove(router, 0)` → `emit Sent`. `quoteFee` = `_checkSend` + `router.getFee(buildMessage(...))`. `buildMessage`: `receiver = abi.encode(remoteAdapter)`, `data = encodePayload(recipient, sender, message)`, `tokenAmounts` empty or `[(token, amount)]`, `feeToken = address(0)`, `extraArgs = extraArgs(gasFor(message))`. `ccipReceive`: checks in spec order, then `_deliver`, then `emit Delivered`.

- [ ] **Step 1: Extend the harness and write the failing tests**

The harness implements the hooks trivially: `_checkAmount` no-op, `_budget` returns `msg.value`, `_collect` pulls `amount` of a `MockTAO` from `msg.sender` and approves the router, `_deliver` records `(recipient, sender, message, amount)` in public storage. Use a `MockRouter` from Task 3? No — Task 3 comes later; here use a tiny inline `FakeRouter` in the test file that returns a fixed fee, records `ccipSend` args and `msg.value`, and pulls tokens.

```solidity
function test_send_buildsExactCcipMessage() public {
    // amount 3e18, message = encodeBatch(1, entries(1), entries(0)); as frontDoor (approved)
    // assert FakeRouter.last: destSelector == 2135107236357186872, receiver == abi.encode(remoteAdapter),
    // data == h.encodePayload(recipient, frontDoor, message), tokenAmounts == [(token, 3e18)],
    // feeToken == address(0), extraArgs == h.extraArgs(1_025_000), value == fee
}
function test_send_zeroAmountSendsNoToken() public;           // tokenAmounts.length == 0, no transferFrom
function test_send_wrongDestinationReverts() public;          // destChain 1 -> WrongDestination
function test_send_zeroRecipientReverts() public;             // ZeroAddress
function test_send_overCapacityReverts() public;              // 5_000e18 + 1 -> MessageTooLarge; 5_000e18 passes
function test_send_insufficientFeeReverts() public;           // fee 1e15, value 1e15 - 1 -> InsufficientFee
function test_send_keepsExcessAndEmits() public;              // value 5e15: router got 1e15, adapter holds 4e15, Sent(id, 964, frontDoor, recipient, 3e18, 1e15, 1_025_000)
function test_quoteFee_equalsFeePaid() public;                // for 0, 1, 50, 100+100 entries; FakeRouter fee depends on extraArgs gas so sizes differ
function test_quoteFee_independentOfCaller() public;          // vm.prank(stranger) quote == frontDoor quote
function test_ccipReceive_notRouterReverts() public;          // NotRouter
function test_ccipReceive_wrongSourceReverts() public;        // WrongSource
function test_ccipReceive_rejectsUnpaddedSender() public;     // sender = abi.encodePacked(remoteAdapter) (20 bytes) -> WrongSender
function test_ccipReceive_rejectsOtherSender() public;        // abi.encode(other) -> WrongSender
function test_ccipReceive_wrongTokenReverts() public;         // WrongToken
function test_ccipReceive_twoTokensReverts() public;          // TooManyTokens
function test_ccipReceive_deliversDecodedPayload() public;    // harness recorded (recipient, sender, message, amount); Delivered emitted
function test_ccipReceive_noTokensDeliversZero() public;      // destTokenAmounts empty -> amount 0
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `forge test --match-path test/adapters/CcipAdapterBase.t.sol`
Expected: compilation fails on the missing `send`/`buildMessage`/hooks.

- [ ] **Step 3: Implement `send`, `quoteFee`, `buildMessage`, `ccipReceive` and the hook declarations**

Use `SafeERC20.forceApprove`. Decode the sender with `abi.decode(message.sender, (address))` only after `message.sender.length == 32`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `forge test --match-path test/adapters/CcipAdapterBase.t.sol -vv`
Expected: 25 passed.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/CcipAdapterBase.sol test/adapters/AdapterHarness.sol test/adapters/CcipAdapterBase.t.sol
git commit -m "feat(adapters): send, quote and delivery in the CCIP adapter base"
```

---

### Task 3: Test doubles — `MockRouter`, `MockAlphaVault`, `MockTAO.burn`, `MockStaking` coldkey alias

**Files:**
- Create: `contracts/test/mocks/MockRouter.sol`, `contracts/test/mocks/MockAlphaVault.sol`
- Modify: `contracts/test/mocks/MockTAO.sol` (add `burn`), `contracts/test/mocks/MockStaking.sol` (coldkey alias)
- Test: `contracts/test/MockRouter.t.sol`, `contracts/test/MockAlphaVault.t.sol`, `contracts/test/MockStaking.t.sol` (one added test)

**Interfaces:**
- Consumes: vendored `Client`, `IRouterClient`, `IAny2EVMMessageReceiver`; `IAlphaVault`.
- Produces:
  ```solidity
  contract MockRouter is IRouterClient {
      struct Sent { uint64 destSelector; bytes receiver; bytes data; Client.EVMTokenAmount[] tokenAmounts; address feeToken; bytes extraArgs; uint256 value; bytes32 messageId; }
      error GasTooHigh(uint256 gasLimit, uint256 maxGas); error DataTooLarge(uint256 length); error TooManyTokens(); error BadExtraArgs();
      error UnsupportedFeeToken(); error InvalidMsgValue(); error DeliveryFailed(bytes reason); error OnlySelf();
      MockTAO public immutable token;                        // the local bridged token: pulled on send, minted on delivery
      uint256 public fee; uint256 public maxGas = 7_000_000; uint256 public maxDataBytes = 32_000;
      constructor(MockTAO token_);
      function setFee(uint256) external; function setMaxGas(uint256) external;
      function isChainSupported(uint64) external pure returns (bool);          // true
      function getFee(uint64, Client.EVM2AnyMessage memory m) public view returns (uint256);
          // BadExtraArgs unless m.extraArgs is 19 bytes with tag 0xa69dd4aa; GasTooHigh if gasLimit > maxGas;
          // DataTooLarge if m.data.length >= maxDataBytes; TooManyTokens if > 1; returns fee
      function ccipSend(uint64 sel, Client.EVM2AnyMessage calldata m) external payable returns (bytes32 id);
          // UnsupportedFeeToken unless feeToken == 0; InvalidMsgValue unless msg.value == getFee; pulls each token amount
          // with safeTransferFrom(msg.sender); records; id = keccak256(abi.encode(sendCount))
      function sendCount() external view returns (uint256); function sendAt(uint256 i) external view returns (Sent memory); function lastSend() external view returns (Sent memory);
      function gasLimitOf(bytes memory extraArgs) public pure returns (uint32);
      function deliver(address receiver, Client.Any2EVMMessage memory m, uint256 gas) external returns (bool called, bool ok, bytes memory reason);
          // like OffRamp 2.0: if receiver has no code or !supportsInterface(0x85572ffb): mint tokens to receiver, return (false, true, "");
          // else try this.deliverAtomic(receiver, m, gas): (true, true, "") or (true, false, err) — tokens are NOT minted on failure
      function deliverAtomic(address receiver, Client.Any2EVMMessage memory m, uint256 gas) external; // OnlySelf; mints m.destTokenAmounts to receiver, then receiver.call{gas}(ccipReceive); reverts DeliveryFailed on failure
  }
  contract MockAlphaVault is IAlphaVault {
      error ZeroAmount(); error NotWholeRao(); error AmountTooLow(); error Halted(); error Migrating(); error Slippage(); error NativeTransferFailed(); error NotListed();
      MockTAO public immutable token; uint256 public floorRao = 2_000_000; bool public paused; bool public migrating; uint256 public shortBy;
      constructor(MockTAO token_); receive() external payable;   // funding
      function setPaused(bool) external; function setMigrating(bool) external; function setFloorRao(uint256) external; function setShortBy(uint256) external;
      // depositLiquid: NotListed, Halted, Migrating, ZeroAmount, NotWholeRao, AmountTooLow (msg.value / 1e9 < floorRao),
      //   Slippage (msg.value / 1e9 < minAlphaRao), then mints msg.value - shortBy to msg.sender and returns it
      // withdrawLiquid: NotListed, Halted, ZeroAmount, NotWholeRao, AmountTooLow (wad / 1e9 < floorRao), burns wad from msg.sender,
      //   Slippage (wad < minTaoOut), then pays wad - shortBy by call (NativeTransferFailed) and returns it
      // isPaused -> paused; isListed(t) -> t == token; positionOf -> (bytes32(uint256(1)), 0); vaultColdkey -> bytes32(uint256(2))
  }
  // MockTAO: function burn(address from, uint256 amount) external;
  // MockStaking: function setColdkeyAlias(address who, bytes32 coldkey) external;  // every former mirror(msg.sender) becomes _cold(msg.sender): alias if set, else mirror
  ```

- [ ] **Step 1: Write the failing double tests**

```solidity
// test/MockRouter.t.sol
function test_getFee_rejectsBadExtraArgs() public;           // 1.6-style 68-byte args -> BadExtraArgs
function test_getFee_rejectsGasOverMax() public;             // 7_000_001 -> GasTooHigh
function test_getFee_rejectsDataOver32000() public;          // 32_000 bytes -> DataTooLarge; 31_999 ok
function test_ccipSend_requiresExactValue() public;          // fee+1 -> InvalidMsgValue
function test_ccipSend_pullsTokensAndRecords() public;
function test_deliver_skipsNonReceiverButMintsTokens() public; // receiver = EOA: called false, tokens minted
function test_deliver_isAtomic() public;                     // receiver reverts: called true, ok false, no tokens minted
// test/MockAlphaVault.t.sol
function test_withdrawLiquid_belowFloorReverts() public;     // 1e15 -> AmountTooLow; 2e15 pays
function test_withdrawLiquid_burnsAndPays() public;
function test_withdrawLiquid_shortByPaysLess() public;       // shortBy 1 -> pays wad - 1 after the slippage check
function test_depositLiquid_mintsOneToOne() public;
function test_depositLiquid_pausedReverts() public;
// test/MockStaking.t.sol
function test_coldkeyAliasRoutesStake() public;              // alias set: addStake credits the alias coldkey, getStake(hk, alias) reads it
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `forge test --match-path "test/Mock*.t.sol"`
Expected: compilation fails (missing contracts/functions).

- [ ] **Step 3: Implement the doubles**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `forge test --match-path "test/Mock*.t.sol" -vv`
Expected: all pass, including the existing `MockBridge`/`MockStaking` tests.

- [ ] **Step 5: Run the full suite**

Run: `forge test`
Expected: everything passes — the existing 276, the 25 adapter-base tests, and the 13 new double tests.

- [ ] **Step 6: Commit**

```bash
git add test/mocks/MockRouter.sol test/mocks/MockAlphaVault.sol test/mocks/MockTAO.sol test/mocks/MockStaking.sol test/MockRouter.t.sol test/MockAlphaVault.t.sol test/MockStaking.t.sol
git commit -m "test(adapters): MockRouter and MockAlphaVault doubles, MockTAO burn, MockStaking coldkey alias"
```

---

### Task 4: `CcipBaseAdapter`

**Files:**
- Create: `contracts/src/adapters/CcipBaseAdapter.sol`
- Test: `contracts/test/adapters/CcipBaseAdapter.t.sol`

**Interfaces:**
- Consumes: `CcipAdapterBase` (Task 2), `MockRouter` (Task 3), `CascadeFrontDoor` as a real recipient in two tests.
- Produces:
  ```solidity
  contract CcipBaseAdapter is CcipAdapterBase {
      uint256 public immutable minSendAmount;
      constructor(Config memory c, uint256 minSendAmount_);
      // _checkAmount: amount != 0 && amount < minSendAmount -> BelowSendMinimum(amount, minSendAmount)
      // _budget: msg.value
      // _collect: token.safeTransferFrom(msg.sender, this, amount); token.forceApprove(router, amount)
      // _deliver: if amount > 0 token.safeTransfer(recipient, amount); ICascadeReceiver(recipient).onBridgeMessage(remoteChainId, sender, message, amount)
  }
  ```
  Fixture: `MockTAO tao; MockRouter router = new MockRouter(tao); router.setFee(1e15);` adapter with localChainId 8453, remoteChainId 964, remoteSelector 2135107236357186872, remoteAdapter = makeAddr("adapterBit"), gasBase 1_000_000, gasPerEntry 25_000, minSendAmount 0.01e18; a `CascadeFrontDoor fd = new CascadeFrontDoor(tao, adapter, 964, vaultAddr, owner, guardian, 12 hours, 0.01e18, 10_000e18, 1e14)`.

- [ ] **Step 1: Write the failing tests**

```solidity
function test_send_belowMinimumReverts() public;              // 0.01e18 - 1 -> BelowSendMinimum(amount, 0.01e18); 0.01e18 passes; 0 passes
function test_send_pullsTokensAndApprovesExactly() public;    // router holds amount after send; allowance(router) == 0 after
function test_send_paysRouterExactlyFee() public;             // value 3e15, fee 1e15: router.balance == 1e15, adapter.balance == 2e15, no refund to caller
function test_closeBatch_throughAdapter() public;             // alice deposits 1e18 into fd; warp 12h; keeper closeBatch{value: quote}; router.lastSend().data == encodePayload(vaultAddr, fd, batchMessage); tokenAmounts == [(tao, 1e18)]
function test_ccipReceive_deliversTokensThenMessageToFrontDoor() public;
    // router.deliver(adapter, msg{sender: abi.encode(adapterBit), data: encodePayload(fd, vaultAddr, encodePayouts(key, 0, [alice 1e18])), destTokenAmounts [(tao, 1e18)]}, 2_000_000)
    // -> called true, ok true; fd.claimable(alice) == 1e18; adapter holds 0 tao
function test_ccipReceive_frontDoorRevertIsAtomic() public;   // deliver the same payouts twice: second ok == false (DuplicatePayouts), adapter and fd token balances unchanged
function test_noReceiveFunction() public;                     // (bool ok,) = address(adapter).call{value: 1}(""); assertFalse(ok)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `forge test --match-path test/adapters/CcipBaseAdapter.t.sol`
Expected: compilation fails — `CcipBaseAdapter` not found.

- [ ] **Step 3: Implement `CcipBaseAdapter.sol`**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `forge test --match-path test/adapters/CcipBaseAdapter.t.sol -vv`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/CcipBaseAdapter.sol test/adapters/CcipBaseAdapter.t.sol
git commit -m "feat(adapters): CcipBaseAdapter (ERC-20 side)"
```

---

### Task 5: `CcipBittensorAdapter`

**Files:**
- Create: `contracts/src/adapters/CcipBittensorAdapter.sol`
- Test: `contracts/test/adapters/CcipBittensorAdapter.t.sol`

**Interfaces:**
- Consumes: `CcipAdapterBase`, `MockRouter`, `MockAlphaVault`, `MockStaking` etched at `ISTAKING_ADDRESS` (its `getDefaultMinStake()` returns 2_000_000 by default; `setMinStake` changes it), `CascadeVault` as a real recipient (fixture from `VaultTestBase`: etch both precompile mocks, predict the vault address with `vm.computeCreateAddress`).
- Produces:
  ```solidity
  contract CcipBittensorAdapter is CcipAdapterBase {
      IStaking public constant STAKING = IStaking(ISTAKING_ADDRESS);
      IAlphaVault public immutable alphaVault;
      event ReserveFunded(address indexed from, uint256 amount);
      constructor(Config memory c, IAlphaVault alphaVault_);              // ZeroAddress
      function floor() public view returns (uint256);                     // STAKING.getDefaultMinStake() * 1e9
      function fundReserve() external payable;                            // emits ReserveFunded
      receive() external payable;                                         // UnexpectedValue unless msg.sender == alphaVault
      // _checkAmount: amount != 0 && amount < floor() -> BelowConversionFloor(amount, floor())
      // _budget: msg.value < amount -> InsufficientFee; else msg.value - amount
      // _collect: amount % 1e9 != 0 -> NotRaoAligned; b0 = token.balanceOf(this); alphaVault.depositLiquid{value: amount}(token, amount / 1e9);
      //           token.balanceOf(this) - b0 != amount -> ConversionShort; forceApprove(router, amount)
      // _deliver: if amount > 0: amount % 1e9 != 0 -> NotRaoAligned; amount < floor() -> BelowConversionFloor; b0 = this.balance;
      //           alphaVault.withdrawLiquid(token, amount, amount); this.balance - b0 < amount -> ConversionShort;
      //           ICascadeReceiver(recipient).onBridgeMessage{value: amount}(remoteChainId, sender, message, amount)
  }
  ```
  Fixture: `MockTAO taoBit; MockRouter router = new MockRouter(taoBit); MockAlphaVault av = new MockAlphaVault(taoBit); vm.deal(address(av), 1_000e18);` adapter with localChainId 964, remoteChainId 8453, remoteSelector 15971525489660198786, remoteAdapter = makeAddr("adapterBase"); vault deployed with `bridge = adapter` and `(8453, frontDoorAddr)` registered; `adapter.fundReserve{value: 1e12}()`.

- [ ] **Step 1: Write the failing tests**

```solidity
function test_floor_readsPrecompile() public;                     // 2e15; staking.setMinStake(5_000_000) -> 5e15
function test_send_belowFloorReverts() public;                    // quoteFee and send with 1e15 -> BelowConversionFloor(1e15, 2e15)
function test_send_budgetMustCoverAmountPlusFee() public;         // value amount + fee - 1 -> InsufficientFee
function test_send_convertsThroughAlphaVaultAndSendsToken() public; // value amount + fee + 7: av minted amount to adapter; router pulled amount; router got fee; adapter.balance == 1e12 + 7
function test_send_notRaoAlignedReverts() public;                 // amount 1e18 + 1 -> NotRaoAligned
function test_send_conversionShortReverts() public;               // av.setShortBy(1) -> ConversionShort
function test_send_pausedAlphaVaultReverts() public;              // av.setPaused(true) -> MockAlphaVault.Halted
function test_ccipReceive_convertsAndDeliversNativeToVault() public;
    // deliver BATCH(1 deposit alice 1e18) with [(taoBit, 1e18)]: vault.balanceOf(alice) > 0; adapter tao balance 0; adapter.balance == 1e12
function test_ccipReceive_belowFloorReverts() public;             // amount 1e15 -> delivery ok == false, reason BelowConversionFloor
function test_ccipReceive_noTokensWithNonZeroBatchFailsAtVault() public; // destTokenAmounts empty, BATCH sums 1e18 -> ok false, reason CascadeVault.AmountMismatch; no state change
function test_ccipReceive_overpaymentStaysInAdapter() public;     // av pays amount + 5 (set a negative shortBy via a dedicated `setOverpay(uint256)` on the mock): vault got exactly amount; adapter.balance == 1e12 + 5
function test_ccipReceive_shortPaymentReverts() public;           // av.setShortBy(1) -> ConversionShort
function test_ccipReceive_vaultPausedIsAtomic() public;           // vault paused: ok false; av did not burn (adapter tao balance unchanged, i.e. 0 because mint was rolled back)
function test_receive_rejectsStrangers() public;                  // UnexpectedValue
function test_fundReserve_isNeverSpent() public;                  // after a send and a delivery, adapter.balance >= 1e12
```

Add `setOverpay(uint256)` to `MockAlphaVault` in this task (pays `wad + overpay` on withdraw); update `MockAlphaVault.t.sol` with `test_withdrawLiquid_overpayPaysMore`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `forge test --match-path test/adapters/CcipBittensorAdapter.t.sol`
Expected: compilation fails — `CcipBittensorAdapter` not found.

- [ ] **Step 3: Implement `CcipBittensorAdapter.sol`**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `forge test --match-path "test/adapters/CcipBittensorAdapter.t.sol" -vv && forge test --match-path test/MockAlphaVault.t.sol`
Expected: 15 + 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/CcipBittensorAdapter.sol test/adapters/CcipBittensorAdapter.t.sol test/mocks/MockAlphaVault.sol test/MockAlphaVault.t.sol
git commit -m "feat(adapters): CcipBittensorAdapter (native side via AlphaVault)"
```

---

### Task 6: End-to-end with both adapters and two routers

**Files:**
- Create: `contracts/test/adapters/AdaptersFixture.sol` (abstract: the fixture and relay helpers below, shared with Task 9)
- Test: `contracts/test/adapters/AdaptersEndToEnd.t.sol` (extends `AdaptersFixture`)

**Interfaces:**
- Consumes: both adapters, `MockRouter`, `MockAlphaVault`, `CascadeVault`, `CascadeFrontDoor`, the helpers in `test/EndToEnd.t.sol` (copy `registerFrontDoor`, `close`, `keyOf`, `entries1`, `noEntries`, `vaultLogs` patterns; do not import that contract).
- Produces: `abstract contract AdaptersFixture is Test` with the fixture state (`taoBase`, `taoBit`, `routerBase`, `routerBit`, `av`, `adapterBase`, `adapterBit`, `vault`, `fd`, `keeper`, `alice`, `bob`), `setUp()`, and `relayToBittensor(uint256)` / `relayToBase(uint256)`.

Fixture: two "chains" in one EVM. `taoBase`, `routerBase = new MockRouter(taoBase)`; `taoBit`, `routerBit = new MockRouter(taoBit)`, `av = new MockAlphaVault(taoBit)` funded with 1_000e18; precompile mocks etched. Predict four addresses with `vm.computeCreateAddress(address(this), nonce + i)` for `adapterBase`, `adapterBit`, `vault`, `fd` in that deployment order, construct each with the others' predicted addresses, and `assertEq` each deployed address to its prediction. Gas model 1_000_000 / 25_000 both sides; `minSendAmount` 0.01e18; fees 1e15 (Base) and 1e15 (Bittensor); vault ED funded; adapter reserve 1e12; keeper set; `(8453, fd)` registered.

Relay helpers:
```solidity
function relay(MockRouter from, MockRouter to, address toAdapter, address fromAdapter, uint64 fromSelector, uint256 sendIndex) internal returns (bool ok, bytes memory reason) {
    MockRouter.Sent memory s = from.sendAt(sendIndex);
    Client.EVMTokenAmount[] memory t = new Client.EVMTokenAmount[](s.tokenAmounts.length);
    for (uint256 i; i < t.length; ++i) t[i] = Client.EVMTokenAmount(address(to.token()), s.tokenAmounts[i].amount);
    Client.Any2EVMMessage memory m = Client.Any2EVMMessage(s.messageId, fromSelector, abi.encode(fromAdapter), s.data, t);
    (, ok, reason) = to.deliver(toAdapter, m, to.gasLimitOf(s.extraArgs));
}
function relayToBittensor(uint256 i) internal returns (bool, bytes memory) { return relay(routerBase, routerBit, address(adapterBit), address(adapterBase), BASE_SELECTOR, i); }
function relayToBase(uint256 i) internal returns (bool, bytes memory) { return relay(routerBit, routerBase, address(adapterBase), address(adapterBit), BITTENSOR_SELECTOR, i); }
```

- [ ] **Step 1: Write the failing tests**

```solidity
function test_fullLifecycle() public;
    // alice deposits 10e18 on Base; close; relayToBittensor(0) ok; vault.balanceOf(alice) > 0; av's taoBit supply fell by 10e18;
    // alice requests redeem of all shares (fee); close; relayToBittensor(1) ok (no token entry); warp payoutDelay;
    // keeper processPayouts (payout list from the vault's Redeemed events, as EndToEnd.t.sol does); routerBit.lastSend().tokenAmounts[0].amount == net;
    // relayToBase(0) ok; alice claims from fd; taoBase.balanceOf(alice) == 1_000e18 - 10e18 + net; both adapters hold 0 tokens;
    // adapterBit.balance == 1e12 + (fee excess from the vault's rao rounding)
function test_twoFrontDoorsThroughOneAdapter() public;
    // fd2 (same adapterBase, registered on the vault for 8453); alice via fd, bob via fd2; both relayed; both redeem; both paid to the right door
function test_failedDeliveryIsRetried() public;
    // pause vault; relayToBittensor(0) ok == false; taoBit.balanceOf(adapterBit) == 0; unpause; relayToBittensor(0) ok == true
function test_redeliveryAfterSuccessIsRejected() public;
    // relayToBittensor(0) twice: second ok == false with CascadeVault.DuplicateBatch; vault shares unchanged; adapterBit holds 0 tokens
function test_strangerSendStrandsOnlyItself() public;
    // stranger holds 1e18 taoBase, approves adapterBase, send(964, vault, batch naming stranger as sender, 1e18) with fee;
    // relayToBittensor ok == false (vault UnknownPeer); vault untouched; adapterBit holds 0 tokens
function test_oversizedBatchLeavesBatchOpen() public;
    // routerBase.setMaxDataBytes-equivalent: set maxDataBytes to 100 via a setter added to MockRouter in this task; closeBatch reverts DataTooLarge; fd.openBatch() unchanged
function test_payoutFeeExcessStaysInAdapter() public;
    // fee 1e15 + 1 (not rao aligned): vault rounds up to 1e15 + 1e9; adapterBit keeps 1e9 - 1
```

Add `setMaxDataBytes(uint256)` to `MockRouter` for `test_oversizedBatchLeavesBatchOpen`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `forge test --match-path test/adapters/AdaptersEndToEnd.t.sol`
Expected: compilation fails on `setMaxDataBytes`; after adding the setter, `test_oversizedBatchLeavesBatchOpen` fails until the assertion is right and the rest fail only if an adapter is wrong (they may pass immediately — that is acceptable here: this task tests integration of already-tested units, and the ledger records which tests passed on first run).

- [ ] **Step 3: Fix whatever the integration reveals**

Any adapter change here gets its own failing unit test in Task 4/5's file first.

- [ ] **Step 4: Run the full suite**

Run: `forge test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add test/adapters/AdaptersFixture.sol test/adapters/AdaptersEndToEnd.t.sol test/mocks/MockRouter.sol
git commit -m "test(adapters): end-to-end through both adapters and two mock routers"
```

---

### Task 7: Fork harness spike and Base fork tests

**Files:**
- Create: `contracts/test/vendor/ccip/MessageV1Codec.sol`, `contracts/test/vendor/ccip/VENDOR.md`
- Create: `contracts/test/fork/ForkBase.sol`, `contracts/test/fork/StubVerifier.sol`, `contracts/test/fork/Sink.sol`
- Test: `contracts/test/fork/BaseFork.t.sol`

**Interfaces:**
- Consumes: both adapters, `CascadeFrontDoor`, vendored `MessageV1Codec` (copy `package/contracts/libraries/MessageV1Codec.sol` unchanged; it has no imports).
- Produces:
  ```solidity
  // test/fork/ForkBase.sol
  abstract contract ForkBase is Test {
      uint64 constant BASE_SELECTOR = 15971525489660198786; uint64 constant BITTENSOR_SELECTOR = 2135107236357186872;
      address constant BASE_ROUTER = 0x881e3A65B4d4a04dD529061dd0071cf975F58bCD; address constant BIT_ROUTER = 0xD941fBEcD2b971d0F54b4C34286C95faB52B60B8;
      address constant BASE_ONRAMP = 0xF75bf16b03aaE98677926F0987F195A2153996B9; address constant BIT_ONRAMP = 0x5aA05e14ac7FaF23F1757d46429E6CA7e3FC1274;
      address constant BASE_OFFRAMP = 0x16E577f1724AE2598F9b43a52C19E6f67eE13808; address constant BIT_OFFRAMP = 0xF9410A08FD57e629c66E1f37a5Ae8f0a757d9AD9;
      address constant BASE_TAO = 0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67; address constant BIT_TAO = 0xC5b6C1632d34901239396F5E1BDe54B342900256;
      address constant BASE_POOL = 0xF5AC6D6Bd12d8b87dE3c136FAc9375961577e794; address constant BIT_POOL = 0xB66b9c085ab711ECC373aaF6dc959a4A6B42BE2e;
      address constant ALPHA_VAULT = 0x11837459896D96F821a8D88eC93a3C8D152033D4;
      bool internal isFork;
      modifier onlyFork() { if (!isFork) vm.skip(true); _; }
      function forkFrom(string memory envKey, string memory defaultRpc) internal;   // isFork = vm.envOr("FORK", false); if so createSelectFork(vm.envOr(envKey, defaultRpc))
      function offRamp20(address router, uint64 sourceSelector) internal view returns (address);  // from IRouterView(router).getOffRamps(): the entry for sourceSelector whose typeAndVersion() == "OffRamp 2.0.0"; assert exactly one; assert it equals the constant
      function message(uint64 srcSel, uint64 dstSel, address srcOnRamp, address dstOffRamp, address srcAdapter, address dstAdapter, address srcPool, address srcToken, address dstToken, uint256 amount, bytes memory data, uint32 gas) internal pure returns (MessageV1Codec.MessageV1 memory);
          // executionGasLimit 0, ccipReceiveGasLimit gas, finality 0, ccvAndExecutorHash 0, onRampAddress abi.encode(srcOnRamp), offRampAddress abi.encodePacked(dstOffRamp),
          // sender abi.encode(srcAdapter), receiver abi.encodePacked(dstAdapter), destBlob "", tokenTransfer: amount == 0 ? [] : [{amount, abi.encode(srcPool), abi.encode(srcToken), abi.encodePacked(dstToken), abi.encodePacked(dstAdapter), ""}], data
      function execute(address offRamp, MessageV1Codec.MessageV1 memory m) internal returns (bytes32 id, bool ok, bytes memory err);
          // encoded = MessageV1Codec._encodeMessageV1(m); (required, optional,) = IOffRamp20(offRamp).getCCVsForMessage(encoded);
          // ccvs = required ++ optional with any address(0) entries dropped; vm.etch(each, StubVerifier code); results = empty bytes each;
          // try IOffRamp20(offRamp).execute(encoded, ccvs, results, 0) -> ok; id = keccak256(encoded); then read getExecutionState(id)
  }
  interface IOffRamp20 { function execute(bytes calldata, address[] calldata, bytes[] calldata, uint32) external; function getCCVsForMessage(bytes calldata) external view returns (address[] memory, address[] memory, uint8); function getExecutionState(bytes32) external view returns (uint8); }
  interface IRouterView { struct OffRamp { uint64 sourceChainSelector; address offRamp; } function getOffRamps() external view returns (OffRamp[] memory); }
  interface ITypeAndVersion { function typeAndVersion() external view returns (string memory); }
  // StubVerifier: getInboundImplementation(bytes) returns address(this); verifyMessage(MessageV1Codec.MessageV1 memory, bytes32, bytes memory) no-op; supportsInterface returns true
  // Sink: ICascadeReceiver that records the last (sourceChain, sender, message, amount, msg.value) and reverts ValueMismatch if msg.value != amount
  ```
  Execution-state enum in 2.0.0 `Internal.MessageExecutionState`: `UNTOUCHED = 0, IN_PROGRESS = 1, SUCCESS = 2, FAILURE = 3` (verified in the package's `libraries/Internal.sol`).

- [ ] **Step 1: Spike the harness (no commit until it works)**

In `BaseFork.t.sol`, `setUp`: `forkFrom("BASE_RPC", "https://mainnet.base.org")`; `offRamp20(BASE_ROUTER, BITTENSOR_SELECTOR)`. Write `test_spike_executeDeliversTokensToSink`: deploy a `Sink`-like minimal receiver that implements `IAny2EVMMessageReceiver` + ERC-165 (reuse `AdapterHarness` is wrong here — write `test/fork/Probe.sol`: records `ccipReceive` calls), build a `message(...)` from Bittensor to Base with amount 1e18 to the probe, `execute`; assert `ok`, state 2, `IERC20(BASE_TAO).balanceOf(probe) == 1e18`, probe recorded the call. If the pool or OffRamp rejects, read the revert and adjust the message fields (likely culprits: `sourcePoolAddress` must be a configured remote pool — check `IPool(BASE_POOL).isRemotePool(BITTENSOR_SELECTOR, abi.encode(BIT_POOL))`; the OnRamp hash must be in `getSourceChainConfig(BITTENSOR_SELECTOR).onRamps`).

Run: `FORK=1 forge test --match-path test/fork/BaseFork.t.sol --match-test spike -vvv`
Expected: PASS. If it cannot be made to pass after a bounded effort, record `Ruling:` in the ledger, fall back to Router-impersonated delivery (`vm.prank(BASE_ROUTER); adapter.ccipReceive(...)` after `deal`), and keep the rest of this task's tests on that path.

- [ ] **Step 2: Write the failing Base fork tests**

```solidity
function test_fork_limitsMatchSpec() public onlyFork;
    // FeeQuoter at BASE_ONRAMP.getDynamicConfig()[0]: raw getDestChainConfig(BITTENSOR_SELECTOR) words [1] == 32_000, [2] == 8_000_000;
    // IPool(BASE_POOL).getCurrentOutboundRateLimiterState(BITTENSOR_SELECTOR).capacity == 5_000e18; typeAndVersion(BASE_ONRAMP) == "OnRamp 2.0.0"
function test_fork_closeBatchBurnsThroughRealRouter() public onlyFork;
    // adapterBase(gas 1_000_000/25_000, minSend 0.01e18, remoteAdapter = makeAddr); fd(BASE_TAO, adapterBase, 964, makeAddr("vault"), ..., minDeposit 0.01e18);
    // deal(BASE_TAO, alice, 10e18); alice approves + deposits 1e18; warp 12h; quote = adapterBase.quoteFee(964, vault, encodeBatch(...), 1e18) via fd's message;
    // supplyBefore = totalSupply; keeper closeBatch{value: quote + 1}; totalSupply == supplyBefore - 1e18 (BurnMint burned);
    // adapterBase holds 0 tokens; adapterBase.balance == 0 (the front door sends exactly the quote and refunds the keeper's extra 1);
    // our Sent event's fee == quote; the real Router's balance change == quote (it wraps exactly what we send)
function test_fork_quoteMatchesRouterForSizes() public onlyFork;
    // for 1, 50, 100 entries: adapterBase.quoteFee == IRouterClient(BASE_ROUTER).getFee(BITTENSOR_SELECTOR, adapterBase.buildMessage(...))
function test_fork_payoutsDeliveredThroughRealOffRamp() public onlyFork;
    // message from Bittensor: srcAdapter = the remoteAdapter the Base adapter was built with; data = encodePayload(fd, vaultAddr, encodePayouts(key, 0, [alice 1e18])); amount 1e18;
    // execute -> ok, state 2; IERC20(BASE_TAO).balanceOf(fd) grew by 1e18; fd credits alice (its claimable getter)
function test_fork_failedDeliveryIsRetriable() public onlyFork;
    // same message but payload recipient = a Sink that reverts: execute -> ok false, state 3, fd/adapter balances unchanged;
    // etch a non-reverting Sink at the same address, execute again -> state 2
```

- [ ] **Step 3: Run the fork tests to verify they fail**

Run: `FORK=1 forge test --match-path test/fork/BaseFork.t.sol -vv`
Expected: FAIL on the assertions (or compile errors for missing helpers).

- [ ] **Step 4: Implement `ForkBase`, `StubVerifier`, `Sink`, and make the tests pass**

- [ ] **Step 5: Run the fork tests and the normal suite**

Run: `FORK=1 forge test --match-path test/fork/BaseFork.t.sol -vv` then `forge test`
Expected: fork tests pass with `FORK=1`; without it they report as skipped and the suite is green.

- [ ] **Step 6: Commit**

```bash
git add test/vendor/ccip test/fork/ForkBase.sol test/fork/StubVerifier.sol test/fork/Sink.sol test/fork/Probe.sol test/fork/BaseFork.t.sol
git commit -m "test(adapters): fork harness through the real OffRamp 2.0.0; Base fork tests"
```

---

### Task 8: Bittensor fork tests

**Files:**
- Test: `contracts/test/fork/BittensorFork.t.sol`

**Interfaces:**
- Consumes: `ForkBase`, `CcipBittensorAdapter`, `CascadeVault`, `MockStaking` (with `setColdkeyAlias`), `MockAddressMapping`, `IAlphaVault` views.

Fixture: `forkFrom("BITTENSOR_RPC", "https://lite.chain.opentensor.ai")`; etch `MockStaking` at `ISTAKING_ADDRESS` and `MockAddressMapping` at `ADDRESS_MAPPING_ADDRESS`; `(validator, netuid) = IAlphaVault(ALPHA_VAULT).positionOf(BIT_TAO)`; `staking.addHotkey(validator)`; `staking.setColdkeyAlias(ALPHA_VAULT, IAlphaVault(ALPHA_VAULT).vaultColdkey())`; `staking.donateStake(validator, vaultColdkey, 20_000e9)`; `staking.setOneRaoShort(false)`; `staking.addHotkey(HK1)`; predict and deploy `adapterBit` (remoteAdapter = makeAddr("adapterBase"), gas 1_000_000/25_000, alphaVault = ALPHA_VAULT) then `vault` (bridge = adapterBit); `vm.deal(vault, 1e12)`; `adapterBit.fundReserve{value: 1e12}()`; keeper set; `(8453, fdAddr)` registered.

- [ ] **Step 1: Write the failing tests**

```solidity
function test_fork_limitsMatchSpec() public onlyFork;          // FeeQuoter words [1] == 32_000, [2] == 15_000_000; BIT_POOL outbound capacity 5_000e18; OffRamp 2.0.0 == BIT_OFFRAMP
function test_fork_batchDeliveredThroughRealOffRampAndAlphaVault() public onlyFork;
    // message from Base: amount 1e18, data = encodePayload(vault, fdAddr, encodeBatch(1, [alice 1e18], [])); poolBefore = IERC20(BIT_TAO).balanceOf(BIT_POOL);
    // execute -> ok, state 2; pool balance fell by 1e18 (LockRelease released); IERC20(BIT_TAO).totalSupply() fell by 1e18 (AlphaVault burned);
    // vault.balanceOf(alice) > 0; vault stake (staking.getStake(HK1, vault coldkey, 0)) == 1e9 rao; adapterBit holds 0 tokens and exactly 1e12 wei
function test_fork_payoutThroughRealAlphaVaultAndPool() public onlyFork;
    // after the deposit above: deliver a second BATCH with redeems [alice, all shares] (amount 0, no token); warp payoutDelay;
    // quote = adapterBit.quoteFee(8453, fdAddr, payoutsMessage, net) (reconstruct as the vault does; see EndToEnd.t.sol);
    // keeper processPayouts(key, payouts, 10); poolAfter == poolBefore + net (pool locked the newly minted token); adapterBit holds 0 tokens;
    // adapterBit.balance == 1e12 + (vault's rounded fee - real fee); our Sent event's fee equals the live quote
function test_fork_subFloorQuoteReverts() public onlyFork;      // adapterBit.quoteFee(8453, fdAddr, encodePayouts(.., [alice 1e15]), 1e15) reverts BelowConversionFloor(1e15, 2e15)
function test_fork_pausedAlphaVaultFailsAndRetries() public onlyFork;
    // vm.store the AlphaVault's pausedUntil slot? No: simpler — vm.mockCall(ALPHA_VAULT, withdrawLiquid selector, revert) for the first execute (state 3, pool balance unchanged), clear the mock, execute again (state 2)
function test_fork_receiverGasMeasured() public onlyFork;
    // vm.prank(BIT_ROUTER); g = gasleft(); adapterBit.ccipReceive(any2evm for 1 deposit after deal(BIT_TAO, adapterBit, 1e18)); g -= gasleft(); emit log_named_uint("receiver gas 1+0 (mock precompile)", g)
```

- [ ] **Step 2: Run the fork tests to verify they fail**

Run: `FORK=1 forge test --match-path test/fork/BittensorFork.t.sol -vv`
Expected: FAIL on assertions.

- [ ] **Step 3: Make them pass**

If the real `AlphaVault` reverts for a reason the mock precompile causes (for example `Insolvent` because `getStake` under the alias reads 0), fix the alias or the seeding in the fixture, not the adapter; ledger the finding.

- [ ] **Step 4: Run the fork tests and the normal suite**

Run: `FORK=1 forge test --match-path "test/fork/*.t.sol" -vv` then `forge test`
Expected: all fork tests pass; the normal suite is green with the fork tests skipped.

- [ ] **Step 5: Commit**

```bash
git add test/fork/BittensorFork.t.sol
git commit -m "test(adapters): Bittensor fork tests through the real OffRamp, pool and AlphaVault"
```

---

### Task 9: Gas calibration

**Files:**
- Test: `contracts/test/adapters/AdapterGas.t.sol`
- Modify: `contracts/README.md` (deploy-args table rows, see Task 10 for the rest)

**Interfaces:**
- Consumes: `AdaptersFixture` (Task 6), the measured number from Task 8's `test_fork_receiverGasMeasured`.
- Produces: the deployment gas model, as constants in `AdapterGas.t.sol`: `GAS_BASE_TO_BITTENSOR`, `GAS_PER_ENTRY_TO_BITTENSOR`, `GAS_BASE_TO_BASE`, `GAS_PER_ENTRY_TO_BASE`.

- [ ] **Step 1: Write the measuring test (it fails until the constants satisfy it)**

```solidity
function test_gas_vaultDeliveryModelHasHeadroom() public {
    // measure receiver gas (vm.prank(routerBit); gasleft deltas around adapterBit.ccipReceive) for 1+0, 50+50, 100+100 entries,
    // with taoBit dealt to adapterBit and MockAlphaVault converting; emit log_named_uint for each;
    // PRECOMPILE_ALLOWANCE = 300_000 (two real precompile calls at ~145k each, research note bittensor_evm_home_chain.md);
    // for each n: assertGe(GAS_BASE_TO_BITTENSOR + entries(n) * GAS_PER_ENTRY_TO_BITTENSOR, (measured + PRECOMPILE_ALLOWANCE) * 115 / 100);
    // assertLe(GAS_BASE_TO_BITTENSOR + 200 * GAS_PER_ENTRY_TO_BITTENSOR, 7_000_000);
}
function test_gas_frontDoorDeliveryModelHasHeadroom() public;   // same shape for 1, 50, 100 payouts into fd via adapterBase; no precompile allowance
```

- [ ] **Step 2: Run it, read the measurements, choose the constants**

Run: `forge test --match-path test/adapters/AdapterGas.t.sol -vv`
Expected: logs with the six measurements; the assertions fail on placeholder constants of 0.

Choose `GAS_PER_ENTRY_*` as the slope `(g100 - g1) / 99` rounded up to the next 1,000 then ×1.15; `GAS_BASE_*` as `(g1 + allowance) × 1.15 - GAS_PER_ENTRY` rounded up to the next 10,000. Record the six measurements and the chosen values in the ledger.

- [ ] **Step 3: Run it to verify it passes**

Run: `forge test --match-path test/adapters/AdapterGas.t.sol -vv`
Expected: PASS.

- [ ] **Step 4: Add the deploy-args rows to `contracts/README.md` "Defaults at deploy"**

Rows: `gasBase` / `gasPerEntry` (toward Bittensor: the two values; toward Base: the two values), `minSendAmount` 0.01 TAO (Base adapter), adapter reserve 1e12 wei (Bittensor adapter, funded by the deployer), `GAS_CAP` 7,000,000 (constant), `MAX_MESSAGE_VALUE` 5,000 TAO (constant).

- [ ] **Step 5: Commit**

```bash
git add test/adapters/AdapterGas.t.sol README.md
git commit -m "test(adapters): gas model calibration with 15% headroom"
```

---

### Task 10: Live simulation script and documentation

**Files:**
- Create: `contracts/script/simulate_inbound.sh`
- Modify: `contracts/README.md` (adapter section under "Contracts", "What adapters must honour" cross-reference, "Trust and supply chain" rows, "Build and test" fork instructions, "Operator notes" failure rows for the staking floor), root `README.md` (status paragraph, test count), `docs/architecture.md` (one paragraph on the adapters)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write `simulate_inbound.sh`**

Inputs: env `BITTENSOR_RPC` (default `https://lite.chain.opentensor.ai`), `REMOTE_ADAPTER` (any address; defaults to `0x1111…1111`), `AMOUNT` (wei, default `1000000000000000000`). Steps, each echoed:
1. `anvil --fork-url $BITTENSOR_RPC --port 8546` in the background; `forge create` `CcipBittensorAdapter` with the real constructor args (BIT_ROUTER, BIT_TAO, 964, 8453, BASE_SELECTOR, REMOTE_ADAPTER, the Task 9 gas values, ALPHA_VAULT) and `Sink` using anvil's first default key; `cast code` both; stop anvil.
2. Find the AlphaToken balance slot: for `s` in 0..5, stop at the first `s` where `cast storage $BIT_TAO $(cast index address $BIT_POOL $s)` equals `cast call $BIT_TAO "balanceOf(address)(uint256)" $BIT_POOL`; fail loudly if none matches. The adapter's slot is then `cast index address $ADAPTER $s`.
3. `cast call --from $BIT_ROUTER $ADAPTER "ccipReceive((bytes32,uint64,bytes,bytes,(address,uint256)[]))" "(<id>,15971525489660198786,<abi.encode(REMOTE_ADAPTER)>,<payload>,[($BIT_TAO,$AMOUNT)])" --override-code $ADAPTER:$CODE --override-code $SINK:$SINK_CODE --override-state $BIT_TAO:$SLOT:$AMOUNT --override-balance $ADAPTER:1000000000000 --rpc-url $BITTENSOR_RPC --trace`, where `<payload>` is `abi.encode(SINK, 0xfd…, encodeBatch(1, [(0xa11ce, AMOUNT)], []))` produced with `cast abi-encode`.
4. Print "SIMULATION OK: real AlphaVault.withdrawLiquid ran through the real staking precompile and the sink received AMOUNT" on success, or the revert and trace on failure.

Run: `bash script/simulate_inbound.sh`
Expected: `SIMULATION OK`. If the lite node rejects `--trace`, drop `--trace` and rely on success/revert (the Sink reverts on a value mismatch, so success is sufficient). Record the exact output in the ledger.

- [ ] **Step 2: Write the documentation**

`contracts/README.md`:
- New subsection "Bridge adapters (CCIP 2.0)" under "Contracts": the two contracts, immutables, the payload, gas sizing, the fee rule, the staking floor and who owns each residual stall (keeper grouping, owner cancel, app minimum of 0.01 TAO, keeper pre-check), manual re-execution (permissionless `OffRamp.execute`, `gasLimitOverride`), the reserve, and the "pipe, not peer" model.
- "Trust and supply chain": the spec's trust table rows (ForeverMoney pause/migration, pools Safe, Chainlink lane/verifiers/RMN, default executor, root key floor).
- "Build and test": `FORK=1 forge test --match-path "test/fork/*.t.sol"` with the RPC env vars, and `bash script/simulate_inbound.sh`.
- "Pre-mainnet checklist": add "run `simulate_inbound.sh` against the live node with the deployment's constructor args" and "confirm `OffRamp 2.0.0` addresses still match `ForkBase`".

Root `README.md`: status paragraph says the adapters are built and fork-tested, next is the deployment runbook; update the test count. `docs/architecture.md`: one paragraph on where the adapters sit.

- [ ] **Step 3: Run the whole suite one last time**

Run: `forge test && FORK=1 forge test --match-path "test/fork/*.t.sol"`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add script/simulate_inbound.sh README.md ../README.md ../docs/architecture.md
git commit -m "docs(adapters): live simulation script, README sections, trust map, checklist"
```

---

## Self-review notes

- Spec coverage: send/quote/deliver (Tasks 2, 4, 5); payload and multi-peer (Tasks 2, 6); ERC-165 (Tasks 1, 7); gas sizing and calibration (Tasks 1, 9); floor handling both sides (Tasks 4, 5, 8); reserve and `receive()` (Task 5); vendoring with provenance (Tasks 1, 7); fork tests through the real OffRamp with the spike-and-fallback rule (Tasks 7, 8); live simulation and docs (Task 10); limits assertions (Tasks 7, 8).
- Type consistency: `Config` struct, hook names, `MockRouter.Sent`, `deliver` return triple, `gasLimitOf`, `offRamp20`, `message`, `execute` are used with the same names in every task that consumes them.
- Review Focus lines 1–5 are pinned in Tasks 5, 5, 4, 2, 3/6 respectively.
