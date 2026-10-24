# Cascade CCIP adapters — design spec

Date: 2026-10-24. Status: revised after the builder check (three questions, all settled by the
author; see "Rulings"). Parent spec:
`docs/superpowers/specs/2026-10-21-cascade-v2-vault-on-bittensor-design.md` (section "Adapters").
Rail facts: `docs/forevermoney-probe.md`, `research_notes/Cascade v2 Bittensor vault rails/`.

## Intent and why

The vault (Bittensor EVM, chain 964) and the front door (Base, chain 8453) are built and reviewed
against a test double (`MockBridge`). They never see Chainlink CCIP or ForeverMoney. This spec
defines the two real adapters that sit between them and the rail, so that:

- a closed batch on Base (ForeverMoney's bridged TAO plus the `BATCH` message) arrives at the vault
  as **native TAO plus the message in one transaction**, and
- a payout chunk from the vault (native TAO plus the `PAYOUTS` message) arrives at the front door as
  **bridged TAO plus the message in one transaction**.

This is the first of four pieces toward the user's own real-money test run (about $20, Base and
Bittensor mainnet, the user as the only depositor). The other three — deployment scripts and
runbook, a hand-run keeper, and wiring the web app — are separate specs.

Why now: the one thing that blocked this piece, "does ForeverMoney let a third-party contract
convert bridged TAO to native TAO in the same transaction", was answered on 2026-10-23 by probing
their deployed contracts: yes, both directions, permissionless, exactly 1:1, with no gateway
involved. The adapters build directly against ForeverMoney's `AlphaVault`.

## Goals, non-goals, anti-goals

Goals
- Drop-in for `MockBridge`: the vault and front door run unchanged. The adapters honour
  `ICascadeBridge` / `ICascadeReceiver` exactly as the parent spec states them, including serving
  several peers on one chain through one adapter pair (the vault pays every front door through its
  single primary bridge).
- Money is held, never lost, on every failure the adapters can see: a failed delivery reverts
  whole (tokens and message together) and stays re-executable by anyone, with no expiry, and with
  more gas if the first attempt ran short.
- Immutable, admin-less, no stored balances that anyone can withdraw. Replacing an adapter is a new
  deployment through the vault's and front door's 7-day bridge registry.
- Fees sized to the batch, not to the worst case, because the deposit leg's fee is dominated by the
  destination gas limit (measured 2026-10-24: 0.00061 ETH at 500k gas, 0.0040 ETH at 7M gas).
- Proven on forks of both mainnets through the real 2.0 OffRamp, Router and token pools, plus a
  simulation of the inbound conversion against live Bittensor state (the forked EVM has no staking
  precompile, so ForeverMoney's unstake cannot run inside Foundry).

Non-goals (this piece)
- The keeper, the deployment scripts, the web app, and the tooling that re-executes a failed
  delivery (the keeper spec owns that; this spec only guarantees re-execution is safe, sufficient,
  and permissionless).
- Paying CCIP fees in LINK or wrapped TAO. Fees are paid in the native coin on both chains because
  `ICascadeBridge` carries the fee as `msg.value`.
- Any token other than ForeverMoney's TAO, any chain other than Base and Bittensor.
- Pre-checking the token pool's rate-limit bucket. If the bucket is short, `ccipSend` reverts, so
  `closeBatch` reverts and the batch stays open for a later attempt. The keeper reads the bucket.
- Custom verifier (CCV) or finality choices. The adapters take Chainlink's defaults for the lane:
  the default committee verifier and "wait for finality".

Anti-goals (a failure even if it "works")
- An adapter with an owner, a pause, an upgrade path, or a rescue function. Any of these would let
  one key bypass the registry delay that protects every holder.
- A delivery that transfers tokens but not the message. CCIP does exactly this when the receiver
  has no code or does not advertise `IAny2EVMMessageReceiver` through ERC-165 (2.0 OffRamp,
  `_isTokenOnlyTransfer`). Tokens would then sit in the adapter with no way to attach their batch.
- A fee quote that does not match what `send` actually pays, in a way the vault or front door
  cannot cover. The parent spec's rule stands: quote and send see the same message byte length,
  the fee never depends on the amount, and the adapter keeps any excess and never refunds.
- Silent partial conversion: delivering fewer native TAO than the message says.
- A batch that can never be delivered because its amount is below Bittensor's minimum stake.

## Constraints (verified 2026-10-24 unless noted)

### Chainlink CCIP as deployed on these two chains

Both lanes run the **CCIP 2.0.0** execution model: `OnRamp 2.0.0`, `FeeQuoter 2.0.0`, executions
land on `OffRamp 2.0.0` (the `OffRamp 1.6.0` contracts are still registered but only receive
commits, per the 2026-10-21 research), and the `Router` is `1.2.0` on both chains. Read live by
`typeAndVersion()` on 2026-10-24.

| | Base (8453) | Bittensor EVM (964) |
|---|---|---|
| Router | `0x881e3A65B4d4a04dD529061dd0071cf975F58bCD` | `0xD941fBEcD2b971d0F54b4C34286C95faB52B60B8` |
| Chain selector | `15971525489660198786` | `2135107236357186872` |
| OnRamp 2.0.0 (to the other chain) | `0xF75bf16b03aaE98677926F0987F195A2153996B9` | `0x5aA05e14ac7FaF23F1757d46429E6CA7e3FC1274` |
| OffRamp 2.0.0 (from the other chain) | `0x16E577f1724AE2598F9b43a52C19E6f67eE13808` | `0xF9410A08FD57e629c66E1f37a5Ae8f0a757d9AD9` |
| FeeQuoter 2.0.0 | `0x0352750e6e37e3af39e314d26eb75b950eb3cb62` | `0x4d3457b8cf083113f7d4bec82de6f44a8c5a1535` |
| ForeverMoney TAO token | `0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67` (BurnMint pool `0xF5AC6D6Bd12d8b87dE3c136FAc9375961577e794`) | `0xC5b6C1632d34901239396F5E1BDe54B342900256` (LockRelease pool `0xB66b9c085ab711ECC373aaF6dc959a4A6B42BE2e`) |
| Lane limit, data | 32,000 bytes (31,000 accepted, 32,000 rejected) | same |
| Lane limit, receiver gas | FeeQuoter max 8,000,000; 7,000,000 accepted, 7,500,000 rejected | FeeQuoter max 15,000,000; 13,000,000 accepted |
| Tokens per message | 1 | 1 |
| Pool rate limit (outbound) | capacity 5,000 TAO, refill 0.6 TAO/s, bucket full today | same |
| Fee token | native ETH | native TAO |
| Fee, measured (1 token, 300–3,400 B data) | 0.00061 ETH @ 500k gas; 0.00110 @ 1.5M; 0.00192 @ 3M; 0.00399 @ 7M; independent of amount | 0.00108 TAO @ 500k; 0.00124 @ 2M; 0.00136 @ 5M |

Execution facts that the design relies on (from the 2.0.0 sources, `@chainlink/contracts-ccip@2.0.0`,
cross-checked with the research note's on-chain reads):
- The OnRamp encodes the sender as `abi.encode(address)` (32 bytes) and the receiver as 20 raw
  bytes. A legacy `EVM2AnyMessage` with no explicit token receiver delivers the tokens to the
  message receiver.
- Extra args: the 2.0 format is `GenericExtraArgsV3`, tag `0xa69dd4aa`; the basic encoding is 19
  bytes: `tag ‖ uint32 gasLimit ‖ bytes4 finality ‖ 7 zero bytes` (no custom verifiers, executor,
  token receiver or token args, so the lane defaults apply). Finality `bytes4(0)` means "wait for
  finality". Both routers quote it today, and on Base the quote equals the legacy V2 encoding's to
  the wei. The old `allowOutOfOrderExecution` flag is gone; execution is unordered.
- Delivery: `OffRamp.execute(encodedMessage, ccvs, verifierResults, gasLimitOverride)` is
  **completely permissionless**. It releases or mints the token to the receiver, then — only if the
  receiver has code and answers ERC-165 for `IAny2EVMMessageReceiver` — calls
  `Router.routeMessage`, which calls `receiver.ccipReceive(Any2EVMMessage)` with `msg.sender ==
  Router`. The token step and the receiver call happen in one self-call, so a receiver revert
  reverts the token transfer too and the message state becomes `FAILURE`.
- A message in `UNTOUCHED` or `FAILURE` state may be executed by anyone at any time; there is no
  time threshold and no expiry. `gasLimitOverride` may raise (never lower) the receiver gas, so a
  delivery that ran out of gas can be retried with more.
- A receiver that does not implement `IAny2EVMMessageReceiverV2` gets the lane's default verifiers
  and "wait for finality". The adapters implement only the V1 interface, deliberately.

### ForeverMoney and Bittensor

ForeverMoney (`docs/forevermoney-probe.md`; AlphaVault `0x11837459896D96F821a8D88eC93a3C8D152033D4`,
bytecode verified against audit commit `e80a443`; `isPaused() == false`, `isListed(TAO) == true`,
supply 13,247 TAO on 2026-10-24):
- `withdrawLiquid(address token, uint256 wad, uint256 minTaoOut) returns (uint256 taoOut)`: burns
  `wad` of the caller's bridged TAO (no approval), unstakes from their validator, pays native TAO
  to the caller by `call`. Reverts when halted, when `wad % 1e9 != 0`, or when `taoOut < minTaoOut`.
- `depositLiquid(address token, uint256 minAlphaRao) payable`: stakes `msg.value` (a whole number
  of rao) and mints bridged TAO 1:1 to the caller. Reverts when halted or migrating.
- Their guardian pause and admin migration can stall either leg with no notice; their 2-of-3 Safe
  controls the pools and rate limits. No ForeverMoney key can take TAO that sits in Cascade's vault.

Bittensor staking floor (research, `bittensor_evm_home_chain.md`, live 2026-10-21): adding stake
needs at least `DefaultMinStake` = 2,000,000 rao (0.002 TAO), and a partial unstake must pay out at
least the same. So `depositLiquid` below the floor reverts, and `withdrawLiquid` below the floor
reverts (ForeverMoney's position is far larger than any batch, so the unstake is always partial).
The floor is a runtime parameter the root key can change; the staking precompile exposes it as
`getDefaultMinStake()`, which the vault's `IStaking` already declares.

Bittensor EVM: block gas limit 75M, gas price 5 gwei (floor); an account whose native balance hits
zero can be reaped (the vault keeps `ED_RESERVE = 1e12` wei for this reason). Compile with Solidity
0.8.24, EVM Cancun, as the rest of the contracts.

Project rules: `ICascadeBridge` (chain ids are EVM chain ids: 8453 and 964, as the vault and front
door use them), rao alignment (`amount % 1e9 == 0`), `MockBridge` semantics for fees and routing,
no admin on adapters, test-first, independent review before merge.

## The design

### Two contracts, one shared base

`contracts/src/adapters/CcipAdapterBase.sol` (abstract): router check, sender check, ERC-165,
chain-id ↔ selector mapping, payload encoding, gas sizing, fee rule, events and errors.

`contracts/src/adapters/CcipBaseAdapter.sol` — the ERC-20 side on Base.
`contracts/src/adapters/CcipBittensorAdapter.sol` — the native side on Bittensor.

Everything is an `immutable` set in the constructor; there is no storage that an admin could change
and no function that moves funds except as part of a send or a delivery.

Immutables (both adapters): `router` (CCIP Router), `token` (ForeverMoney TAO on this chain),
`localChainId` (8453 or 964), `remoteChainId`, `remoteSelector`, `remoteAdapter` (the only accepted
CCIP sender), and the gas model `gasBase`, `gasPerEntry`. Base adapter only: `minSendAmount`.
Bittensor adapter only: `alphaVault`.

The constructor rejects zero addresses, `localChainId == remoteChainId`, and a gas model whose
largest message (100 + 100 entries) exceeds the cap.

### The adapter-to-adapter payload

Like `MockBridge`, an adapter is a pipe with a verified stamp, not a peer: it carries **who sent**
and **who should receive**, and the vault and front door decide whether that pair is registered.
The CCIP `data` field is `abi.encode(address recipient, address sender, bytes message)` where
`sender` is the caller of `send` and `message` is the Cascade `BATCH` or `PAYOUTS` bytes. This is
what lets one adapter pair serve an old and a new front door during a migration, which the vault's
single primary bridge requires.

A caller who names a recipient that rejects the delivery strands only its own tokens (the delivery
fails and nobody will re-execute it successfully). The vault and front door only ever name their
registered peers.

### `send` (called by the vault or a front door)

`send(uint64 destChain, address recipient, bytes message, uint256 amount) payable`

1. `destChain == remoteChainId` (`WrongDestination`); `recipient != address(0)` (`ZeroAddress`).
2. `amount <= 5_000e18` (`MessageTooLarge`; pool capacity — the vault and front door already stay
   far below it).
3. Minimum conversion (below): Base adapter `amount == 0 || amount >= minSendAmount`
   (`BelowSendMinimum`); Bittensor adapter `amount == 0 || amount >= floor` where
   `floor = STAKING.getDefaultMinStake() * 1e9` read live (`BelowConversionFloor`).
4. Build the CCIP message: `receiver = abi.encode(remoteAdapter)`,
   `data = abi.encode(recipient, msg.sender, message)`,
   `tokenAmounts = amount == 0 ? [] : [(token, amount)]`, `feeToken = address(0)`,
   `extraArgs = V3 basic encoding with gasLimit = gasFor(message)` and finality `bytes4(0)`.
5. `fee = router.getFee(remoteSelector, ccipMessage)`. Budget rule (parent spec): Base side
   `msg.value >= fee`; Bittensor side `msg.value >= amount + fee`. Otherwise `InsufficientFee`.
   The adapter pays the router exactly `fee`, keeps any excess, never sends value back.
6. Tokens:
   - Base: if `amount > 0`, `safeTransferFrom(msg.sender, this, amount)` (the front door approved
     exactly `amount`), then `forceApprove(router, amount)`; reset the approval to 0 after sending.
   - Bittensor: if `amount > 0`, require `amount % 1e9 == 0` (`NotRaoAligned`), call
     `alphaVault.depositLiquid{value: amount}(token, amount / 1e9)`, require the adapter's token
     balance grew by exactly `amount` (`ConversionShort`), then approve the router as above.
7. `messageId = router.ccipSend{value: fee}(remoteSelector, ccipMessage)`; emit
   `Sent(messageId, remoteChainId, msg.sender, recipient, amount, fee, gasLimit)`.

`quoteFee(destChain, recipient, message, amount) view` runs steps 1–3 and returns `router.getFee`
for exactly the message `send` would build (same payload length, same gas limit, token entry iff
`amount > 0`), so a misconfiguration or a sub-floor amount surfaces at the quote, before any state
changes. It uses `msg.sender` as the payload sender, which is the same caller in both the vault's
and the front door's code paths.

### Delivery (called by the CCIP Router)

`ccipReceive(Client.Any2EVMMessage message)`

1. `msg.sender == router` (`NotRouter`).
2. `message.sourceChainSelector == remoteSelector` (`WrongSource`); `message.sender` is exactly 32
   bytes and decodes to `remoteAdapter` (`WrongSender`); `destTokenAmounts` is empty or has exactly
   one entry whose token is `token` (`WrongToken`, `TooManyTokens`). `amount` is that entry's
   amount or 0. Decode `(recipient, sender, cascadeMessage)` from `message.data`.
3. Convert and deliver, in one transaction:
   - Base: `token.safeTransfer(recipient, amount)` if `amount > 0`, then
     `ICascadeReceiver(recipient).onBridgeMessage(remoteChainId, sender, cascadeMessage, amount)`
     with no value.
   - Bittensor: if `amount > 0`: require `amount >= floor` (`BelowConversionFloor`, a clearer
     failure than ForeverMoney's), record the native balance, call
     `alphaVault.withdrawLiquid(token, amount, amount)` (exact 1:1 as the minimum; the adapter's
     `receive()` accepts the credit), require the balance grew by at least `amount`
     (`ConversionShort`); then
     `ICascadeReceiver(recipient).onBridgeMessage{value: amount}(remoteChainId, sender, cascadeMessage, amount)`.
4. Emit `Delivered(message.messageId, remoteChainId, sender, recipient, amount)`.

Any revert in steps 2–3 reverts the whole CCIP execution: the tokens are not credited, the message
is marked `FAILURE`, and anyone can execute it again, with more gas if needed. That is the retry
path for a ForeverMoney pause, a paused vault, an out-of-gas, a floor raised by the root key, or a
transient precompile error. The vault and front door already treat a repeated successful delivery
as a duplicate, so re-execution after success is harmless.

The adapters do not store delivered message ids: CCIP executes each message at most once, and the
peers dedupe by content.

### ERC-165

`supportsInterface(bytes4)` returns true for `IAny2EVMMessageReceiver` and `IERC165`, and false for
`IAny2EVMMessageReceiverV2` (so the lane defaults apply). The OffRamp checks this before calling
the receiver; without it CCIP would transfer the tokens alone and skip the call. The fork tests
drive deliveries through the real `OffRamp 2.0.0` (below), so this gate is exercised against the
deployed code, not a mock.

### Gas sizing

The receiver gas limit is derived from the Cascade message's byte length, which the vault and front
door fix per entry (`abi.encode(uint8, uint64, Entry[], Entry[])` for `BATCH`: 6 header words plus
2 words per entry; `abi.encode(uint8, bytes32, uint32, Entry[])` for `PAYOUTS`: 5 header words plus
2 words per entry). `entries = (message.length / 32 - header) / 2` with the header chosen by the
message's `kind` word; a message that does not fit either shape is quoted at the cap.

`gasLimit = min(gasBase + entries * gasPerEntry, gasCap)`, with `gasBase` and `gasPerEntry`
constructor parameters and `gasCap` the constant 7,000,000 in both directions (toward Bittensor the
lane rejects 7,500,000; toward Base the lane allows far more, and the front door needs far less).
The constructor requires `gasBase + 200 * gasPerEntry <= gasCap` so the largest legal message is
never silently clipped. The limit is encoded as `uint32` in the V3 extra args.

The plan measures real deliveries on the forks (1 + 0, 50 + 50, 100 + 100 entries on the vault;
1, 50, 100 payouts on the front door), adds the conversion cost and the adapter's own overhead, and
fixes `gasBase`/`gasPerEntry` with at least 15% headroom. These values are deployment arguments,
recorded in the deployment spec, not code constants, so a tune is a redeploy without a code change.
If a deployment still under-provisions, the delivery fails and is re-executed with
`gasLimitOverride`; nothing is lost.

Quote and send see the same byte length, so the fee is identical. Toward Bittensor, the vault's
"at least the fee, never a refund" rule absorbs the sub-rao rounding the vault applies to the fee.

### Minimum conversion

Bittensor's staking floor (0.002 TAO today) applies to both conversions. A sub-floor payout chunk
would make `processPayouts` revert inside ForeverMoney every time; a sub-floor deposit batch would
fail delivery every time. The adapters make both failures early and explicit:

- Bittensor adapter: `send`/`quoteFee` revert `BelowConversionFloor(amount, floor)` when
  `0 < amount < floor`, with `floor` read live from the staking precompile. Delivery does the same
  check before `withdrawLiquid`.
- Base adapter: `send`/`quoteFee` revert `BelowSendMinimum(amount, minSendAmount)` when
  `0 < amount < minSendAmount`. The Base side cannot read Bittensor's floor, so `minSendAmount` is a
  deployment argument set with margin (the deployment spec sets it at 0.01 TAO, five times today's
  floor) and the deployment rule is front door `minDeposit >= minSendAmount`. For that rule to
  mean "an honest batch never trips it", every entry in a batch must stay at or above
  `minDeposit`: the front door therefore refuses a partial `cancelDeposit` that would leave an
  entry between zero and `minDeposit` (a full cancel is always allowed). This front-door change
  was added on 2026-10-24 after the Task 4 review showed that a partial cancel could leave a
  batch total below `minSendAmount` and stall `closeBatch` until the next deposit.

What remains, and who owns it (recorded in `contracts/README.md`):
- A payout batch whose last chunk is below the floor stalls until the keeper groups it with
  neighbouring entries (`maxEntries` is the keeper's choice) or, if every remaining entry is tiny,
  until the owner cancels the batch, which re-mints the shares — nobody loses funds. The web app
  must refuse unstake requests worth less than 0.01 TAO (web-wiring spec).
- A deposit batch in flight when the root key raises the floor above its total waits in CCIP until
  the floor comes back down. The keeper reads `getDefaultMinStake()` before `closeBatch` (keeper
  spec). With `minDeposit` at 0.01 TAO this needs a five-fold raise.

### Native TAO handling on the Bittensor adapter

- `receive()` accepts value only from `alphaVault` (the `withdrawLiquid` credit). Anything else
  reverts, so a user who pastes the adapter's address into a wallet does not lose TAO to a contract
  with no rescue path.
- `fundReserve() payable`: anyone may add native TAO that the adapter never spends. The deployment
  runbook funds `1e12` wei (the same figure as the vault's `ED_RESERVE`) before the first delivery
  so the adapter's balance never returns to zero between the credit and the forward. `send` and
  delivery only ever move the exact amounts above, so the reserve and any kept fee excess are the
  only balance the adapter ever holds at rest.

### Vendored Chainlink code

From `@chainlink/contracts-ccip@2.0.0` (npm, published 2026-06-18, integrity
`sha512-P0KvQtZSYC1LevMSS16jOOSsqZG4g0n/MJdcWGmE0Z5U01NVYd1MnTQJOBPsbu1NWR79DBXPXLvyr9tR5y+tiw==`),
copied byte-for-byte:
- to `contracts/src/vendor/ccip/`: `libraries/Client.sol` (`EVMTokenAmount`, `Any2EVMMessage`,
  `EVM2AnyMessage`), `interfaces/IRouterClient.sol`, `interfaces/IAny2EVMMessageReceiver.sol`;
- to `contracts/test/vendor/ccip/` (tests only): `libraries/MessageV1Codec.sol`, so the fork
  harness encodes exactly what the OffRamp decodes.

A `VENDOR.md` beside each records the package, version, integrity string, file list, and the
reason. The 19-byte V3 extra-args encoding is written by the adapter base itself (the codec library
is 670 lines of assembly for features we do not use); a unit test pins the exact bytes, and the fork
tests prove the live routers quote them. The receiver base (`ccipReceive` + ERC-165) is about twenty
lines of our own code rather than Chainlink's `CCIPReceiver`, which pins an OpenZeppelin import path
this repo does not have and advertises the V2 interface.

ForeverMoney's surface is declared in `contracts/src/interfaces/IAlphaVault.sol`:
`withdrawLiquid`, `depositLiquid`, `isPaused`, `isListed`, with the signatures from the probe.

### Events and errors

Events: `Sent(bytes32 indexed messageId, uint64 destChain, address indexed sender, address indexed recipient, uint256 amount, uint256 fee, uint256 gasLimit)`,
`Delivered(bytes32 indexed messageId, uint64 sourceChain, address indexed sender, address indexed recipient, uint256 amount)`,
`ReserveFunded(address from, uint256 amount)`.

Errors: `ZeroAddress`, `SameChain`, `GasModelTooLarge`, `WrongDestination`, `MessageTooLarge`,
`BelowSendMinimum(uint256 amount, uint256 minimum)`, `BelowConversionFloor(uint256 amount, uint256 floor)`,
`InsufficientFee`, `NotRaoAligned`, `ConversionShort`, `NotRouter`, `WrongSource`, `WrongSender`,
`WrongToken`, `TooManyTokens`, `UnexpectedValue`.

## Trust and failure map (for the README)

| Party or event | Can do | What the user sees |
|---|---|---|
| ForeverMoney guardian pause / admin migration | a pause stalls deposits (inbound `withdrawLiquid` reverts) or payouts (`depositLiquid` reverts); a completed migration (`executeMigration`) makes `withdrawLiquid` revert `Insolvent` permanently | a pause: deliveries fail and are re-executed when it lifts; `processPayouts` reverts and is retried; nothing is lost. A migration: every inbound batch delivered after `executeMigration` sits in CCIP `FAILURE` forever (the adapter's `alphaVault` is immutable; no token-only fallback, no rescue) and its depositors lose their TAO; the 7-day notice window is the only protection, and it equals the registry's 7-day delay, so the replacement adapter pair is proposed the day a migration is announced (corrected after the whole-branch review, 2026-10-24) |
| ForeverMoney validator choice | where bridged TAO is staked while in flight (minutes) | none |
| ForeverMoney 2-of-3 Safe | change pool rate limits, pause the pools | sends revert; batches wait |
| Chainlink lane config, default verifier committee, RMN | pause the lane, change gas or data limits, withhold verification | sends revert or deliveries wait; an over-cap gas model needs a new adapter through the 7-day registry |
| Chainlink's default executor | run `execute` for us, or stop | anyone, including the keeper, can execute a verified message; no expiry |
| Bittensor root key | raise the staking floor; change precompile behaviour | a sub-floor batch waits; otherwise as in the vault's trust map (the adapter adds one precompile read, `getDefaultMinStake`) |
| A rail that loses a message | funds in that message | the rail's loss; other users unaffected (parent spec, "Lost messages") |

No key held by Cascade can move funds through an adapter except as the vault or a front door
directs.

## Tests the plan must include (minimum)

Unit (Foundry, no network):
- `MockRouter`: records the last `ccipSend` (selector, receiver, data, token amounts, fee token,
  extra args, value), returns a settable fee from `getFee`, reverts `getFee` above a settable gas
  cap, and delivers a crafted `Any2EVMMessage` to a receiver the way the real OffRamp does
  (code-size and ERC-165 gate first, token transfer, then `ccipReceive` as the Router), reporting
  whether the call was skipped.
- `MockAlphaVault` over `MockTAO`: 1:1 both ways, settable `paused`, settable floor (default
  2,000,000 rao) that reverts both functions below it, settable short-pay for `ConversionShort`
  tests, pays by `call` like the real one.
- Every error path above; the fee rule (exact fee paid, excess kept, no refund, `InsufficientFee`);
  `quoteFee == fee paid` for 0, 1, 50, 100 and 100 + 100 entries; redeem-only batch sends no token;
  empty payout chunk sends no token; the exact 19-byte extra args; gas limit formula and cap;
  constructor rejections; `receive()` from a stranger reverts; `fundReserve` never spent; payload
  round trip (recipient, sender, message) including a second front door on the same adapter.
- `EndToEnd` with the two adapters and a `MockRouter` pair in place of `MockBridge`: deposit → batch
  → delivery → stake, redeem → payout → delivery → claim, including a failed-then-re-executed
  delivery, a re-executed successful delivery (duplicate rejected by the peer, adapter unchanged),
  and payouts to two front doors through one adapter.

Fork (run on demand with `FORK=1`, RPCs `https://mainnet.base.org` and
`https://lite.chain.opentensor.ai`; the lite RPC keeps about 300 blocks of state, so each run pins
a fresh block). The harness drives the real `OffRamp 2.0.0` (chosen from `router.getOffRamps()` by
`typeAndVersion()`): it encodes a `MessageV1` with the vendored codec (real remote OnRamp and pool
addresses, our adapter as receiver and token receiver), asks `offRamp.getCCVsForMessage` which
verifiers the message needs, `vm.etch`es each of those addresses with a stub resolver whose
implementation accepts any message, and calls `execute`. That runs the real pool (BurnMint on Base,
LockRelease on Bittensor), the real ERC-165 gate, the real Router call, and our adapter.
- Base: deploy the front door and the Base adapter, `deal` bridged TAO to a user, `deposit` →
  `closeBatch`: the real Router accepts the message, the BurnMint pool burns the tokens, the fee
  equals the live quote, and the emitted `MessageV1` names our adapter as token receiver. Deliver a
  `PAYOUTS` message through `execute`: tokens are minted and the front door credits the user.
- Bittensor: the forked EVM lacks the staking precompile, so etch `MockStaking` at the precompile
  address (it already answers `getDefaultMinStake`), deploy the vault and the Bittensor adapter, and
  deliver a `BATCH` through `execute`: the LockRelease pool releases, real `AlphaVault` code burns
  and pays, the vault stakes. Run `processPayouts`: real `depositLiquid` mints, the pool locks, the
  fee equals the live quote in TAO. Also a sub-floor send reverts `BelowConversionFloor`.
- Both: read `getDestChainConfig` and the pools' rate-limiter state and assert the limits in the
  Constraints table; assert the `OffRamp 2.0.0` address matches the table.
- Gas: print measured gas for the sizes above and assert the chosen `gasBase`/`gasPerEntry` cover
  them with 15% headroom under the cap.

The plan's first fork task is a spike that proves the verifier stubbing works on both forks before
the harness is built on it. If it cannot be made to work, the fallback is a Router-impersonated
direct call to `ccipReceive` after `deal`ing the tokens, and the spec's "exercised against deployed
code" claim is downgraded in the README to "exercised against a faithful mock".

Live simulation (a script, not a test; run before deployment and recorded in the runbook):
`eth_call` against the live Bittensor node with state overrides (`cast call --override-code` /
`--override-state`) that place the adapter's bytecode at an address, give it bridged TAO, and
execute a delivery from the Router's address — the only way to run ForeverMoney's real unstake
through the real precompile before money moves.

## Rulings in this document (the author's calls, not the user's)

1. Native-coin fees only (ETH on Base, TAO on Bittensor). Matches `ICascadeBridge`; LINK would
   need balances an admin-less contract cannot manage.
2. Gas from message length, not from decoding the message. O(1), and the peers already fix the
   byte layout per entry.
3. Gas parameters are constructor arguments; the cap is a constant (7,000,000 both ways).
4. The adapter is a pipe, not a peer: `send` is open to any caller, and the payload carries the
   recipient and the true sender, as `MockBridge` does. This replaced an earlier draft that pinned
   one peer per adapter, which the builder check showed would break payouts whenever two front
   doors are registered at once, because the vault pays every front door through one primary
   bridge. A stranger can only strand its own tokens.
5. `receive()` only from `AlphaVault`; explicit `fundReserve()` for the reserve.
6. Build against CCIP 2.0.0 (what runs on these lanes), vendor three source files and one
   test-only codec from that package with provenance rather than add a submodule or an npm
   dependency; write the receiver base ourselves; implement only the V1 receiver interface so the
   lane defaults (default verifiers, wait for finality) apply.
7. V3 extra args (19-byte basic encoding) rather than the legacy V2 tag the 2.0 OnRamp still
   accepts for compatibility: an immutable contract should speak the current format.
8. No stored message ids in the adapter; CCIP's once-only execution plus the peers' content dedupe
   is the replay protection.
9. The staking floor is enforced at the quote on both sides (live read on Bittensor, deployment
   argument on Base), the vault stays unchanged, and the residual stalls are documented with their
   owners (keeper grouping, owner cancel, app minimum, keeper pre-check).
10. Fork tests go through the real `OffRamp 2.0.0` with stubbed verifiers, `MockStaking` at the
    precompile address under real `AlphaVault` bytecode, plus a live `eth_call` simulation for the
    real precompile path.

## Left to the builder

File layout inside `contracts/src/adapters/` and `contracts/test/adapters/`; exact `MockRouter`
API; the stub verifier's shape; the measured gas constants and their headroom; the deploy-time
argument list as a table in `contracts/README.md`; wording of the README's adapter section and
trust-map rows; address prediction for the circular immutables (deployment spec).
