# Cascade contracts (v3)

Solidity contracts for Cascade: staked TAO for people who do not have a Bittensor wallet. Users
deposit TAO on Base, the TAO is staked on Bittensor's root network (netuid 0), and users hold csTAO
shares whose price rises as staking rewards come in.

- Product context: [`docs/architecture.md`](../docs/architecture.md).
- Authoritative design: [`docs/superpowers/specs/2026-10-21-cascade-v2-vault-on-bittensor-design.md`](../docs/superpowers/specs/2026-10-21-cascade-v2-vault-on-bittensor-design.md)
  (revision 5, with the as-built rulings of revision 6 at the top).
- Rail facts (CCIP, ForeverMoney, limits): [`reports/Cascade v2 Bittensor vault rails.md`](../reports/Cascade%20v2%20Bittensor%20vault%20rails.md).
- Bridge adapters: [`docs/superpowers/specs/2026-10-24-cascade-ccip-adapters-design.md`](../docs/superpowers/specs/2026-10-24-cascade-ccip-adapters-design.md)
  and [`docs/forevermoney-probe.md`](../docs/forevermoney-probe.md).

v3 (2026-10-26) adds one-signature staking from USDC, USDC delivered on exit, and a reward cut. Design:
[`docs/superpowers/specs/2026-10-26-cascade-v3-design.md`](../docs/superpowers/specs/2026-10-26-cascade-v3-design.md);
research: [`reports/Cascade v3 swap routes and permits.md`](../reports/Cascade%20v3%20swap%20routes%20and%20permits.md)
and [`reports/Cascade v3 root validators.md`](../reports/Cascade%20v3%20root%20validators.md). The
[v3 trust model](#v3-trust-model) says plainly what each new power can and cannot do. See the
[pre-mainnet checklist](#pre-mainnet-checklist).

Licence: the repository is MIT, except `src/CascadeTwapOracle.sol`, which is GPL-2.0-or-later
because it ports the maths of Uniswap's `OracleLibrary`.

## Contracts

| Contract | Chain | What it does |
|---|---|---|
| `CascadeVault` | Bittensor EVM (chain 964) | Holds the root stake and the csTAO balances. Prices every batch from the stake it reads directly. Queues payouts and sends them in chunks. Lets Bittensor-native users deposit and redeem directly. v3 adds the reward cut. |
| `CascadeFrontDoor` | Base | Collects deposits of ForeverMoney's bridged TAO and redeem requests into batches, forwards each batch to the vault with each user's address, receives payouts and lets users claim them. It never prices anything. v3 adds USDC delivery: `setDelivery`, `requestRedeemWithDelivery` and a keeper-only `deliver`. |
| `CascadeStaker` | Base | One-signature staking. Takes USDC (by permit signature, or by approval for wallets that cannot sign a permit), pays the fees to the treasury, swaps through an owner-set route with a minimum checked by the balance it actually received, and calls the front door's `depositFor` for the user. `sellFor` does the reverse swap for deliveries. |
| `CascadeTwapOracle` | Base | A 30-minute average TAO price in USDC, from Uniswap's TAO/WETH 0.3% and WETH/USDC 0.05% pools. Used only as a floor for deliveries. GPL-2.0-or-later (ports Uniswap's `OracleLibrary`). |
| `CascadeBase` | both | Shared admin: two-step owner, guardian, pause, and the bridge registry (a new bridge waits 7 days). The guardian is replaced only 8 days after the owner proposes it. `renounceOwnership` is disabled. |
| `CcipBaseAdapter` | Base | The front door's bridge: sends ForeverMoney's TAO plus a `BATCH` over Chainlink CCIP, and delivers incoming tokens plus `PAYOUTS` to the front door. See [Bridge adapters](#bridge-adapters-ccip-20). |
| `CcipBittensorAdapter` | Bittensor EVM | The vault's bridge: converts between native TAO and ForeverMoney's TAO through their `AlphaVault` in the same transaction as each send and delivery. |

csTAO ("Cascade Staked TAO") has 24 decimals and cannot be transferred: `transfer`, `transferFrom`
and `approve` revert. At launch 1 csTAO is worth 1 TAO.

Libraries and interfaces:

- `CascadeMath`: share math with a virtual offset of 1e6 shares (the ERC-4626 defence against
  inflation attacks). Every result rounds down, in the vault's favour.
- `CascadeMessages`: the two bridge messages. `BATCH` goes from a front door to the vault (batch
  id, deposits, redeem requests). `PAYOUTS` goes back (batch key, chunk number, payouts). At most
  100 entries per list (`MAX_ENTRIES`).
- `ICascadeBridge` / `ICascadeReceiver`: the adapter interface (`send` and `quoteFee` out,
  `onBridgeMessage` in).
- `IStaking` (the staking precompile at `0x…0805`) and `IAddressMapping` (`0x…080c`, used once in
  the vault's constructor to derive its own coldkey).
- `IAlphaVault`: ForeverMoney's `depositLiquid` and `withdrawLiquid`, which the Bittensor adapter
  calls, plus four views the tests read.
- `src/vendor/ccip`: three files from Chainlink's `@chainlink/contracts-ccip@2.0.0` (the message
  structs, the Router interface and the receiver interface), copied byte-for-byte; `VENDOR.md`
  records the package, its integrity hash and the one changed import path.

There are no proxies, no `delegatecall` and no arbitrary external calls. Value leaves the vault in
only two ways: a payout chunk sent through the primary bridge, and a direct redeem paid to the share
owner.

### What adapters must honour

The vault and the front door never see CCIP or ForeverMoney. A Bittensor adapter sits between CCIP
and the vault, and a Base adapter between CCIP and the front door. They are the parts designed to be
replaced, because every outside change (ForeverMoney's token, Chainlink's lane, a Bittensor runtime
upgrade) lands there. An adapter must:

- **Be immutable.** No admin and no upgrade path. Its router, remote adapter and ForeverMoney
  contract are constructor constants. Any change is a new adapter that goes through the 7-day
  registry. Otherwise the adapter's own admin would bypass the delay, and because any enabled
  adapter may present any registered front door, the weakest adapter would set the security level
  for every front door.
- **Report the true source.** The receivers trust the `(sourceChain, sender)` pair the adapter
  passes in. The adapter verifies it against CCIP before calling `onBridgeMessage`.
- **Keep the fee-budget rule.** Accept any `send` whose budget covers the real fee, keep the excess,
  and never send value back to the caller (the vault's `receive()` would reject it).
- **Inbound (Base to vault):** receive ForeverMoney's token plus the `BATCH` data, convert the token
  to native TAO, then call `vault.onBridgeMessage{value: amount}(...)` with `amount` equal to the sum
  of the deposits. Preferred: conversion through a ForeverMoney function in the same transaction.
  Fallback, if ForeverMoney only offers asynchronous "liquid delivery" to an address: the adapter
  owns that address, holds the data as "awaiting funds", and calls the vault only once its own
  balance covers the batch. Either way the vault's `msg.value == amount` rule holds and the
  fragility stays in the adapter.
- **Outbound (vault to front door):** receive native TAO plus `PAYOUTS` data from
  `processPayouts`, convert through ForeverMoney's gateway, and deliver token plus data to the front
  door. If the gateway cannot carry data, send the data as a separate CCIP message. The front door's
  `TokensNotReceived` check makes that safe: the data message fails until the tokens are there, then
  anyone re-executes it. In that fallback the token check is pooled across chunks, so a chunk whose
  tokens the rail loses makes the *last* chunk's data fail, not its own.
- **Enforce the lane's limits before sending:** at most 5,000 TAO per message (ForeverMoney's pool
  rate limit, refilling at 0.6 TAO/s and shared with every ForeverMoney user; each adapter is
  deployed with its own lower cap, `maxMessageValue`), at most 32,000 bytes
  of data, and a delivery gas budget within about 7.2M on Bittensor and about 13M on Base. The
  contracts' defaults are set to stay under these: 4,000 TAO per batch and per payout chunk, 50 + 50
  entries per batch, and at most 100 entries in any list.

The adapters in this build take the preferred path in both directions: ForeverMoney's `AlphaVault`
converts in the same transaction (`withdrawLiquid` inbound, `depositLiquid` outbound; permissionless
and exactly 1:1, per `docs/forevermoney-probe.md`), and each CCIP message carries the tokens and the
data together. The fallbacks above are not built. How they meet each rule:
[Bridge adapters (CCIP 2.0)](#bridge-adapters-ccip-20).

### Bridge adapters (CCIP 2.0)

Two immutable adapters sit between Chainlink CCIP and the vault and front door, which see only
`ICascadeBridge` / `ICascadeReceiver` and run unchanged from the `MockBridge` build. Both lanes run
the CCIP 2.0.0 execution model (`OnRamp 2.0.0`, `OffRamp 2.0.0`, `Router 1.2.0`).

| Adapter | Sends | Delivers |
|---|---|---|
| `CcipBaseAdapter` (Base) | pulls exactly `amount` of ForeverMoney's TAO from the caller (the front door), approves the Router, sends tokens plus `BATCH`, resets the approval | transfers the tokens to the recipient, then calls its `onBridgeMessage` with no value |
| `CcipBittensorAdapter` (Bittensor EVM) | turns `amount` of the caller's (the vault's) native TAO into ForeverMoney's TAO with `AlphaVault.depositLiquid` (the token balance must grow by exactly `amount`), then sends tokens plus `PAYOUTS` | turns the tokens back with `AlphaVault.withdrawLiquid(token, amount, amount)` (the native balance must grow by at least `amount`, else `ConversionShort`), then calls `onBridgeMessage{value: amount}` |

Both inherit `CcipAdapterBase`: the Router and sender checks, ERC-165, the payload, gas sizing and
the fee rule.

- **Immutables only.** `router`, `token` (ForeverMoney's TAO on that chain), `localChainId`,
  `remoteChainId`, `remoteSelector`, `remoteAdapter` (the only CCIP sender a delivery accepts), and
  the gas model `gasBase` and `gasPerEntry`, and the per-message cap `maxMessageValue`; plus
  `minSendAmount` on Base and `alphaVault` on Bittensor. No owner, pause, upgrade or rescue
  function, and no stored balance anyone can withdraw. A change is a new adapter through the
  7-day bridge registry. The constructor rejects zero addresses, equal chain ids, a gas model
  whose largest message does not fit the cap, a `maxMessageValue` of 0 or above 5,000 TAO, and
  (Base) a `minSendAmount` above `maxMessageValue`.
- **A pipe, not a peer.** The CCIP data is `abi.encode(recipient, sender, message)`: who called
  `send` and who should receive. A delivery checks that the message came from the Router, from
  `remoteSelector` and from `remoteAdapter` (exactly 32 bytes), and carries at most one token, ours.
  Whether that sender and recipient are registered peers is the vault's and the front door's
  decision, as with `MockBridge`. This is what lets one adapter pair serve an old and a new front
  door during a migration (the vault pays every front door through its one primary bridge).
  Anyone may call `send`; a caller that names a recipient that rejects the delivery strands only
  its own tokens.
- **Tokens and data in one transaction.** The OffRamp releases or mints the tokens and calls
  `ccipReceive` in one call, so any revert (a ForeverMoney pause, a paused vault, out of gas, a
  raised staking floor) undoes the token transfer too and marks the message `FAILURE`. CCIP calls a
  receiver only if it answers ERC-165 for `IAny2EVMMessageReceiver`, otherwise it delivers the
  tokens alone; the adapters answer it, and answer false for the V2 interface so the lane's default
  verifiers and "wait for finality" apply.
- **Manual re-execution.** On CCIP 2.0, `OffRamp.execute(encodedMessage, ccvs, verifierResults,
  gasLimitOverride)` is permissionless: anyone can execute a message in `FAILURE` again at any time,
  with no expiry, and `gasLimitOverride` can raise (never lower) the receiver gas. This is the retry
  path for every failure above; the tooling belongs to the keeper spec. Permissionless is not the same as "anyone with the message": `execute` also needs the default committee's `verifierResults` (signatures), which only Chainlink's verifier infrastructure produces, so the operator must fetch them (CCIP explorer or verifier API) before anyone can re-execute (checklist item 27). The adapters store no
  message ids: CCIP executes a message successfully at most once, and the vault and front door
  reject a repeated delivery as a duplicate.
- **Fee rule.** Fees are paid in the native coin (ETH on Base, TAO on Bittensor) and do not depend
  on the amount. `quoteFee` prices exactly the message `send` builds (same payload length, same gas
  limit, a token entry only when `amount > 0`), so the quote is the fee paid. `send` needs
  `msg.value >= fee` on Base and `msg.value >= amount + fee` on Bittensor (`InsufficientFee`), pays
  the Router exactly the fee, keeps any excess and never sends value back.
- **Gas sizing.** The delivery gas limit is `min(gasBase + entries × gasPerEntry, 7,000,000)`
  (`GAS_CAP`), with `entries` read from the message's length (both message kinds have a fixed size
  per entry); a message of neither shape gets the cap. The deployment values, calibrated in
  `test/adapters/AdapterGas.t.sol` with at least 15% headroom, are `gasBase` 540,000 and
  `gasPerEntry` 26,450 toward Bittensor (Base adapter) and 120,000 and 29,900 toward Base
  (Bittensor adapter); the constructor's 200-entry check gives 5,830,000 and 6,100,000, under the
  cap. They are constructor arguments, so a tune is a redeploy, not a code change. A delivery that
  still runs short fails and is re-executed with `gasLimitOverride`; nothing is lost. The
  Bittensor-side figures rest on mock-precompile measurements plus a 300,000-gas allowance; the
  1-deposit point has 5,883 gas of slack against the real-AlphaVault fork measurement. Real-precompile
  delivery gas is unmeasured until the first live batch, which should therefore be the single-entry
  batch of the checklist (item 28), with the re-execution path and its `verifierResults` source
  ready.
- **Send limits.** At most `maxMessageValue` per message (`MessageTooLarge`), a constructor
  argument at most `MAX_MESSAGE_VALUE`, 5,000 TAO, the pools' bucket capacity. Deploy it near the
  real sizes: the Base adapter's must be at least the front door's `maxBatchValue` (a batch above it
  cannot close), and the Bittensor adapter's at least the largest payout entry, which is the larger
  of the vault's `maxMessageValue` and the front door's `maxBatchValue` (a bounced deposit can be a
  whole batch). An entry above the Bittensor adapter's cap can never be sent, and a batch holding
  a bounced deposit must not be cancelled (note 7), so raising those limits past the caps needs new
  adapters (7 days) first. Deliveries are not checked against the cap. The adapters do not read the
  pools' rate-limit bucket: a short bucket makes `ccipSend` revert, so `closeBatch` or
  `processPayouts` reverts and the batch waits.
- **The reserve.** The Bittensor adapter's `receive()` accepts TAO only from the `AlphaVault` (the
  `withdrawLiquid` proceeds), so TAO sent to it by mistake bounces. `fundReserve()` adds TAO the
  adapter never spends. Bittensor EVM reports a balance net of the chain's 500-rao existential
  deposit, so an adapter that holds nothing sees every incoming conversion 500 rao short and every
  delivery reverts `ConversionShort` (re-executable once funded; the live simulation shows both
  cases). The deployer funds 1e12 wei through `fundReserve()` before the first delivery. Sends move
  only exact amounts, but a delivery requires only at least `amount` from ForeverMoney's
  `withdrawLiquid`, so a withdraw surplus stays in the adapter; the reserve, any kept fee excess and
  any such surplus are what an adapter holds at rest.

**The staking floor.** Bittensor refuses to add stake, or pay out a partial unstake, below
`DefaultMinStake` (2,000,000 rao = 0.002 TAO today; the root key can change it), and both
conversions stake or unstake on ForeverMoney's validator. The adapters make the failure early and
explicit:

- Bittensor adapter: `send` and `quoteFee` revert `BelowConversionFloor(amount, floor)` when
  `0 < amount < floor`, with the floor read live from the staking precompile
  (`getDefaultMinStake()`); a delivery makes the same check before `withdrawLiquid`.
- Base adapter: it cannot read Bittensor, so `send` and `quoteFee` revert
  `BelowSendMinimum(amount, minSendAmount)` below an immutable minimum, 0.01 TAO at deployment
  (five times today's floor). The front door keeps every entry at or above `minDeposit` (a partial
  `cancelDeposit` may not leave less), so with `minDeposit >= minSendAmount` an honest batch never
  trips it.

What remains, and who owns it:

| Stall | What happens | Owner |
|---|---|---|
| A payout chunk whose net is below the live floor | `processPayouts` reverts `BelowConversionFloor` every time | Rare now: the vault defers (does not burn) any front-door redeem worth less than 0.01 TAO after clipping (`RedeemDeferred`), so a chunk nets at least 0.01 TAO less its fee. It can still happen if the root key raises the floor, the fee approaches 0.008 TAO, or a tiny bounced deposit goes alone. The keeper groups it with neighbouring entries (`maxEntries`); if every remaining entry is tiny, the owner cancels the batch (`cancelPayoutBatch` re-mints the shares; nobody loses funds). The web app must still refuse unstake requests worth less than 0.01 TAO (web-wiring spec), or the user pays the request fee for a deferral. |
| A deposit batch in flight when the root key raises the floor above its total | the delivery fails and waits in CCIP until the floor comes back down, then is re-executed | The keeper reads `getDefaultMinStake()` before `closeBatch` (keeper spec). At a 0.01 TAO minimum this needs a five-fold raise. |
| `minDeposit` set below `minSendAmount` with `setCaps` | a batch whose total is below `minSendAmount` reverts `BelowSendMinimum` at `closeBatch` and stays open until more deposits arrive | The operator keeps `minDeposit >= minSendAmount` ([Operator notes](#operator-notes)). |

**Tests.** Unit and end-to-end tests (`test/adapters`) run the adapters over `MockRouter` and
`MockAlphaVault`, including a vault-to-front-door round trip with the two adapters in place of
`MockBridge`. The fork tests (`test/fork`, run on demand) drive deliveries through the deployed
`OffRamp 2.0.0` on forks of both mainnets with only its verifiers stubbed, so the real Router, the
real token pools (BurnMint on Base, LockRelease on Bittensor) and the real ERC-165 gate run; on
Bittensor, ForeverMoney's real `AlphaVault` code runs over `MockStaking`, because the forked EVM
has no staking precompile. They also assert the lane limits and the `OffRamp 2.0.0` addresses.
`script/simulate_inbound.sh` runs one delivery against the live Bittensor node, the only run
through the real staking precompile (see [Build and test](#build-and-test)).

## Build and test

```shell
forge build
forge test                                    # unit, end-to-end and invariant tests
forge test --match-path "test/invariants/*"   # invariant suite only
forge build --sizes                           # the vault must stay under 24,576 bytes
forge fmt --check
forge lint
```

- **Suite:** 438 tests (unit, end-to-end, fuzz, and 10 invariants at 128 runs × 64 depth, set in
  `foundry.toml`), plus 18 fork tests that report as skipped unless `FORK` is set (below). The
  invariants also held at 3,000 × 64 (re-run on the pre-audit changes, 2026-10-29).
- **Stale artifacts:** running `forge lint` right after an edit can leave test artifacts without
  bytecode, and `forge test` then reports "No tests found". `forge clean && forge build` fixes it.
- **Invariants:** the price never falls (one rao of rounding tolerance), except that an owner's
  payout-batch cancel may leave it below that batch's delivery price by at most one rao of rounding
  dust per re-minted entry; gross assets are conserved; reserved payouts match the queue; no front
  door burns more than its allowance in a window (checked against the vault's root stake, the most
  the allowance base can be); the front door's token and ETH balances match its books; users never claim more than
  was paid out; no unexpected reverts. The one expected exit failure is counted, not hidden: an
  `UnstakeShort` while the vault's only stake sits below the minimum stake (see the soft spots).
  The handler also simulates rare losses (at most two a run, from liquid TAO not reserved for
  payouts) that can make the vault insolvent. The price floor restarts from each post-loss price
  and gross-asset conservation subtracts the losses, so bounced deposits are delivered, paid out and
  cancelled under fuzzing. A 32-seed sweep reached a loss, a bounce, a paid bounce and a cancelled
  bounce on every seed.
- **Test doubles** (`test/mocks`): `MockStaking` is etched at the precompile address and models the
  floor reads, over-request clipping, sweeps, a fresh position reading one rao short, claims that
  burn all gas when refused, an optional per-removal chain fee (`removeFeeRao`) and claims paid out
  as balance (`claimToBalance`). It credits with `vm.deal`, which a reverted call does not undo, so
  a test that expects a revert after a removal resets the vault's balance. `MockBridge` is
  chain-aware, enforces the fee rule and a 5,000-TAO message cap, delivers with a 7,000,000 gas cap,
  and keeps failed deliveries queued for retry. For the adapters, `MockRouter` records each
  `ccipSend`, quotes a settable fee and delivers the way the 2.0 OffRamp does (code-size and
  ERC-165 gate, tokens, then `ccipReceive` as the Router), and `MockAlphaVault` converts 1:1 both
  ways with a settable pause, floor and short payment. Also `MockAddressMapping`, `StubBridge` and
  `MockTAO`.
- **Gas:** a 100 + 100 batch delivery costs 4,549,540 gas (test bound 6,500,000); 50 + 50 costs
  2,398,159 (bound 3,500,000), both with one hotkey in the set. A delivery reads the stake once
  (one `getStake` per hotkey in the set). The lane gives about 7.2M. Operator limits default to
  50 + 50; raise them to 100 only after a fork measurement.
- **Sizes:** `CascadeVault` is 24,509 B of runtime code at `optimizer_runs = 200` (limit 24,576;
  67 B of headroom, so any post-audit change must watch `forge build --sizes`, and pay for any
  growth). `CascadeFrontDoor` is 17,677 B, `CcipBaseAdapter` 6,852 B, `CcipBittensorAdapter`
  7,989 B.

### Fork tests and the live simulation

The fork tests (`test/fork`, 12 on Base, six of them v3's in `BaseForkV3.t.sol`, and 6 on
Bittensor) fork both mainnets and are skipped unless `FORK` is set. `FORK=1 forge test` runs the
whole suite including all 18.

```shell
FORK=1 forge test --match-path "test/fork/*.t.sol"           # all 18 fork tests
FORK=1 forge test --match-path test/fork/BaseFork.t.sol      # Base only
FORK=1 forge test --match-path test/fork/BittensorFork.t.sol # Bittensor only (rate limit below)
bash script/simulate_inbound.sh                              # live eth_call, Bittensor node
```

| Variable | Default | Effect |
|---|---|---|
| `FORK` | unset | Runs the fork tests; without it they report as skipped. |
| `BASE_RPC` | `https://mainnet.base.org` | Base RPC. |
| `BITTENSOR_RPC` | `https://lite.chain.opentensor.ai` | Bittensor EVM RPC. The lite node keeps only about 300 blocks of state. |
| `FORK_BLOCK` | latest block | Forks at this block, so Foundry's on-disk RPC cache serves repeat runs. It applies to every fork in the run, so pin one chain at a time with `--match-path`. |

- **Base** runs fine on the public RPC (green at block 53034779, and pinned there again with
  `FORK_BLOCK=53034779`).
- **Bittensor rate limit.** Both public Bittensor RPCs (`lite.chain.opentensor.ai` and
  `archive.chain.opentensor.ai`) allow about 128 requests a minute, and a cold run of the
  Bittensor fork tests needs more, so it fails with HTTP 429. Run a local anvil as a cache of the
  archive node at a fixed block and point the tests at it (green at block 9354721):

  ```shell
  anvil --fork-url https://archive.chain.opentensor.ai --fork-block-number <N> --port 8547 \
    --retries 12 --fork-retry-backoff 20000 --timeout 60000
  BITTENSOR_RPC=http://127.0.0.1:8547 FORK=1 forge test --match-path test/fork/BittensorFork.t.sol -vv
  ```

- **What the forks cannot run.** The forked Bittensor EVM has no staking precompile, so the fork
  tests etch `MockStaking` at its address and ForeverMoney's real `AlphaVault` code runs over a
  mock unstake.

`script/simulate_inbound.sh` covers that gap. It deploys the Bittensor adapter (real constructor
arguments) and `test/fork/Sink.sol` on a throwaway local anvil to get their runtime code, then
runs one `ccipReceive` as a plain `eth_call` on the live Bittensor node with state overrides: the
two runtime codes at unused addresses, 1 TAO of ForeverMoney's token in the adapter's balance slot
(found by matching the pool's balance), and a small stand-in at the Router's address that funds the
adapter's 1e12-wei reserve through `fundReserve()` and then forwards the `ccipReceive`, so the
adapter still sees the Router as caller. ForeverMoney's real `withdrawLiquid` burns the tokens,
unstakes through the real precompile and pays the adapter, which forwards the TAO to the sink; the
sink reverts unless it receives exactly the amount. Before the delivery it checks, with the same
overrides, that the adapter answers `alphaVault()` and the sink `reverting()`, because the node
silently ignores some overrides and calls to an empty account succeed. Success prints
`SIMULATION OK`; a revert is named (the adapter's, the sink's or ForeverMoney's error). Nothing is
broadcast. It makes about 14 requests to the node. Options: `BITTENSOR_RPC`, `REMOTE_ADAPTER` (the Base adapter's address),
`AMOUNT` (wei), `GAS_BASE` and `GAS_PER_ENTRY` (the Bittensor adapter's gas model), `MAX_MESSAGE`
(its per-message cap, which a delivery does not check), `RESERVE`
(0 shows the unfunded adapter's `ConversionShort`) and `FUNDER`. Run on 2026-10-24 against the lite
node: 1 TAO and exactly 0.002 TAO (the floor) delivered; `RESERVE=0` reverted `ConversionShort`;
20,000 TAO, more than ForeverMoney's position, reverted their `Insolvent()`.

## Money flow

### Deposit leg (Base to Bittensor)

1. The app swaps the user's USDC for ForeverMoney's TAO on Base. The user calls `deposit`, or a
   one-signature "zap" contract calls `depositFor`, which can only credit the named user. Amounts
   must be whole rao (1 rao = 1e-9 TAO), at least `minDeposit`, inside the front door's
   `depositCap`, and inside the batch's 4,000-TAO value limit. Each user has one merged entry per
   batch. `cancelDeposit` returns tokens while the batch is still open. A partial cancel must leave
   at least `minDeposit`; a full cancel is always allowed, so every entry is at least the
   `minDeposit` in force when it last changed.
2. To exit, a user calls `requestRedeem(shares)`. The front door cannot see balances on Bittensor,
   so the vault clips each request later. The first request per user per batch costs
   `redeemRequestFee` in ETH (the spec's default, 1e14 wei, is about $0.30). It is paid cash first:
   the call may carry up to the fee, and the user's credit covers the rest. Anyone can pre-pay
   credit with `creditRedeemFee`; this is how the app sponsors passkey wallets that hold no ETH.
   The app may send the full fee or `fee - credit`. The full fee in cash always works, so a gift of
   credit cannot make a request revert. `cancelRedeem` reduces a request; the fee is not refunded.
3. Anyone calls `closeBatch` once the batch interval has passed (12 hours in the beta), either list
   is full, or the batch is full by value. The batch's fee pot pays the bridge fee first, the caller
   tops up any gap, and the caller keeps any remainder. An empty batch just restarts its timer. When
   the redeem list is full, the next `requestRedeem` closes the batch itself on the pot alone and
   lands in the new batch, so junk requests cost the spammer a fee per slot and cannot block exits
   (as long as the pot covers the fee; see [Operator notes](#operator-notes)).
4. The batch crosses on CCIP. On Bittensor the adapter converts the token to native TAO and calls
   the vault's `onBridgeMessage`. The vault fixes one price for the whole batch, mints shares for
   each deposit, then burns shares for each redeem request, clipped to what the user holds, to
   2,000 TAO per entry, and to the front door's daily allowance. Whatever is clipped is not burned:
   the user keeps those shares and can request again. A redeem worth less than 0.01 TAO after
   clipping is not burned at all (`RedeemDeferred`): its payout, less its share of the fee, could
   fall below the bridge's conversion floor and never be sent. Each burn's payout is reserved and queued.
   If the vault is insolvent (share price below half the launch price), deposits are not minted:
   each is bounced, queued ahead of the batch's redeems as a payout of its TAO with 0 shares
   (`DepositBounced`), and comes back to the user on Base like any payout. The vault stores only a
   running hash of the queue; the keeper resubmits the list from the `DepositBounced` and
   `Redeemed` events, in log order. No single entry can make a batch revert. Delivery never stakes
   and never claims rewards.
5. Later, the keeper calls `stakeIdle` to stake the liquid TAO that is not reserved for payouts.
   That stake ramps into the front doors' daily allowance base over the next 24 hours.

### Payout leg (Bittensor to Base)

1. Once `payoutDelay` (24 hours) has passed, anyone calls `processPayouts` with the batch's full
   list. Only the keeper chooses the chunk size, and a keeper request below 10 entries (`minChunk`)
   is raised to 10; anyone else's call sends the largest chunk that fits (up to 100 entries,
   `MAX_ENTRIES`). A tail of fewer than 10 entries that would be left behind is folded into the
   chunk when the whole still fits, so a short tail does not pay a message fee alone. A chunk stays
   within 4,000 TAO, except that it always takes at least one entry. The vault quotes the bridge
   fee and refuses (`FeeTooHigh`) if the fee is above the larger of 1% of the chunk and 0.02 TAO;
   the batch then waits for fees to fall. Each user pays a pro-rata share of the fee in TAO,
   rounded against the user and down to whole rao. An entry left with nothing is recorded as dust
   (`PayoutDust`) and its value stays in the vault. The vault unstakes only what the chunk needs,
   plus the owner's `unstakeMarginRao` (0 by default; root unstaking is 1:1 and fee-free today), and
   sends the chunk through the primary bridge. A batch whose front door has been removed is refused
   (`FrontDoorInactive`).
2. The adapters deliver ForeverMoney's TAO plus the payout list to the front door, which credits
   each user. Incoming payouts are accepted even while the front door is paused.
3. The user calls `claim` on Base, and the app swaps to USDC. Credited TAO earns nothing while it
   waits, so claim promptly.

End to end, a withdrawal through the front door takes about two days: the batch interval, the
24-hour delay, and the bridge.

### Direct access (on Bittensor EVM)

- `depositDirect` takes whole-rao TAO, at least `minDirectDeposit`, while the vault's assets stay
  within `maxTotalAssets`, and mints shares at once. It also marks the address `directOnly`: no
  front door can redeem for it until that address calls `allowFrontDoorRedeems` (again after every
  direct deposit).
- `redeemDirect(shares)` burns the shares, unstakes any shortfall and pays the caller at once. It
  has no outflow cap: the share owner signs on this chain, and root unstaking is 1:1 and fee-free
  today, so it costs other holders nothing. (If the chain ever charged a fee, the owner's
  `unstakeMarginRao` would cover it from the vault, so all holders would bear it.)
- Both refuse while the vault is paused. See [Who can use direct access](#who-can-use-direct-access).

## Roles

Routine calls and who makes them:

| Call | Who | Fallback |
|---|---|---|
| `closeBatch` (Base) | anyone; the keeper in practice | — |
| `processPayouts` (Bittensor) | anyone; the keeper in practice, and only the keeper chooses the chunk size | — |
| `stakeIdle` | keeper | anyone, once 7 days have passed since the last stake (or the deploy) |
| `claimRewards(hotkey)` | keeper | anyone, once 7 days have passed since that hotkey's last claim (or since it was first added) |
| CCIP re-execution | anyone | — |

- **Deposit-leg fee:** the CCIP fee in ETH, paid from the batch's redeem-request pot first and then
  by whoever calls `closeBatch`; any excess goes to that caller. With no redeem requests it is an
  operator cost of about $1.5–11 per batch, depending on size and the delivery gas bought.
- **Payout-leg fee:** the CCIP fee in native TAO, deducted from the chunk pro-rata under the fee
  ceiling. The caller only fronts gas (about $1.4–4 per `processPayouts` at the chain's 5-gwei
  floor).
- There are no other fees to users.
- The keeper times reward claims and staking and may add a hotkey to the set; it cannot move funds.
  Timing does shift a little value between leavers and stayers. Rewards count in the price only
  after a claim, and then vest linearly over 7 days, so someone who leaves forgoes rewards that are
  still unclaimed or vesting. With weekly claims the unclaimed part is at most about a week of yield
  (about 0.1%).
- `setKeeper(address(0))` is allowed and leaves only the 7-day fallback.
- Both fallbacks start counting at once, so only the keeper can act in the first 7 days: the stake
  fallback from deploy, and each hotkey's claim fallback from deploy (the constructor hotkey) or
  from when the hotkey is first added (`addHotkey`, `setStakeHotkey`). A removed and re-added
  hotkey keeps its last claim time.

Other roles:

- **Owner:** a timelock (48 hours in the beta) controlled by a Safe. Proposes and activates front
  doors and bridges, sets the primary bridge, keeper, hotkeys and limits, replaces the guardian
  (`proposeGuardian`, then `acceptGuardian` 8 days later; only the owner can
  `cancelGuardianProposal`), cancels payout batches, and unpauses.
- **Guardian:** a fast, low-trust key that can only stop flows: `pause`, `removeFrontDoor`,
  `disableBridge`, `cancelBridgeProposal` and `cancelFrontDoorProposal`. It can also `addHotkey`,
  which only widens the stake the price reads. It stays in office for 8 days after the owner
  proposes its replacement, longer than the 7-day registry delay, so it can still veto anything
  proposed alongside.
- **Keeper:** times `stakeIdle` and `claimRewards` (above), chooses the payout chunk size, and can
  `addHotkey`.
- **Everyone else:** deposits, redeem requests, cancels, closes, payouts, claims and direct access.

The keeper bot is a separate deliverable. Hosted keeper services are gone (Chainlink Automation,
Gelato Web3 Functions and OpenZeppelin Defender all shut down in 2026), so it is a self-hosted bot
on both chains with its keys in OpenZeppelin Relayer or a cloud KMS. It needs an archive or paid
RPC: the public lite RPC drops state after about 300 blocks, and payout lists are rebuilt from
events. Its jobs: close batches after checking the pools' rate-limit allowance and the live
staking floor (`getDefaultMinStake()`; the adapters size delivery gas to the entry count
themselves); re-execute failed deliveries (`OffRamp.execute`, with `gasLimitOverride` when a
delivery ran out of gas); run `processPayouts` after the delay; run `stakeIdle` on a schedule;
run `claimRewards` weekly after an `eth_call` pre-check (expected delta, no `RootClaimTooHeavy`);
watch the validators for hotkey swaps and drops in the vault's stake (re-add the hotkey with
`addHotkey` and alert the guardian); watch `getPrecompileStatus` for the staking precompile; and
run the contracts' precompile calls against each Bittensor pre-release on testnet 945.

## Exit safety

A front door speaks for its users: a `BATCH` from it burns the named users' shares, and the TAO is
owed to that front door. So whoever gets an address registered as a front door, or controls an
enabled adapter, could submit redeem-only batches naming every holder. The vault bounds this.

The honest statement, from the spec:

> The team cannot move user funds instantly; any front door or bridge added after deployment is
> announced on-chain seven days ahead and the guardian can veto it; a compromised front door can burn at most about 20%
> of the vault per day in redemptions (per registered front door, and never less than 100 TAO a
> day), nothing it burned can be paid out for 24 hours, the guardian can hold those payouts at once,
> and the owner can then cancel the batch and return the shares. Outside the contract, ForeverMoney's
> signers, Chainlink's lane configuration and Bittensor's sudo key can stop or change the rails with
> no delay.

"About 20% of the vault" is measured on the vault's root stake that has ramped in: stake that
`stakeIdle` added counts linearly over the 24 hours after it, and liquid TAO never counts. So neither
a batch's own deposits, nor capital delivered or deposited earlier and taken back within a day, can
raise it (see the soft spots below).

The four layers:

1. **Registry changes are slow, visible and vetoable.** A new front door or bridge can be activated
   only 7 days after it is proposed on-chain (the ones named at deployment are active at once); the
   guardian or owner can cancel a proposal, remove a front door or disable a bridge at once. The guardian itself can be replaced only 8 days after the
   owner proposes it, so it outlasts any registry proposal made alongside.
2. **Burns are capped per front door at delivery.** Each front door may burn at most
   `max(20% of the ramped-in root stake, 100 TAO)` per fixed 24-hour window; requests beyond that
   are deferred and the users keep their shares.
3. **Payouts wait, and stop the moment a front door is removed.** Nothing burned can leave for 24
   hours, `processPayouts` refuses a removed front door's batches, and the owner can then
   `cancelPayoutBatch`, which re-mints every unsent user's shares at the batch's price.
4. **Pause holds the money flows:** deliveries, payouts, staking, and direct deposits and redeems
   on Bittensor; deposits, redeem requests and closes on Base. It never blocks cancels, claims on
   Base, reward claims, payout-batch cancels or incoming payouts on Base, and the owner's stake
   management (`moveStake`, `removeHotkey`), `addHotkey` and `creditRedeemFee` also run while
   paused.

Soft spots:

- **The allowance base trusts capital that stays a day.** The base is the vault's root stake, at
  most the stake the vault booked itself, less what `stakeIdle` added and has not yet ramped in
  (each stake re-spreads what is still ramping, plus the new stake, linearly over the next 24 hours,
  like reward vesting). Liquid TAO never counts: a delivery's deposits, an earlier delivery's, a
  direct deposit, payouts reserved in the balance. So borrowed or short-lived capital cannot raise
  the base. Measured: a rogue adapter that delivers
  4,000 TAO of its own as a deposit-only batch, then a redeem batch naming a 1,000-TAO holder, burns
  that holder for 200 TAO, not 1,000, whether in the same transaction (the adapter then takes its
  4,000 back with `redeemDirect`), a block later, or a block after the keeper staked the 4,000
  (about 200.1 TAO). The ramp applies whoever calls `stakeIdle` (the keeper, or anyone after
  `KEEPER_FALLBACK`), so a stolen keeper key cannot shortcut it. Stake can also rise without
  `stakeIdle`: another coldkey can move stake onto the vault's hotkeys, and depositors get such a
  gift back through their shares (measured: next to a borrowed 100,000-TAO deposit, a 4,000-TAO gift
  costs its giver about 40 TAO). The booked-stake cap (what `stakeIdle` staked and reward claims
  measured, less what unstakes paid) keeps it out: the allowance stays 200 TAO. Booked stake can
  overstate the real stake by rewards paid out as balance and by any chain fee on unstakes (none
  today), which a gift could then fill. Capital that stays staked raises the base as it ramps in: half after 12 hours,
  all after 24. To the vault that is a holder like any other, and a percentage cap cannot tell them
  apart; the backstop is unchanged (the 24-hour payout delay, the guardian's hold and the owner's
  cancel). Flagged for the auditor.
- **New stake waits a day to count.** The cost to honest users: deposits count in the base only as
  they ramp in after the keeper stakes them, so a new vault, or one that grew fast, has a lower
  allowance for about a day (never below `minDailyOutflow`). A keeper that stops staking freezes the
  base at the stake it last ramped in; anyone may stake after `KEEPER_FALLBACK`.
- **Cycling capital lowers the base for a day.** Someone who deposits, waits for the keeper to stake
  it, then redeems directly adds to what is ramping without adding stake, so the base falls (to the
  `minDailyOutflow` floor at worst) for up to a day. It costs them the capital for a keeper round and
  gas, takes nothing, and leaves exits open at the floor and through `redeemDirect`. A keeper that
  stakes less often (say daily) makes each cycle hold its capital longer.
- **Dust cannot leave through a front door.** A holder whose shares are worth less than 0.01 TAO,
  or whose request the window's last sliver of allowance would clip below 0.01 TAO, is deferred
  (`RedeemDeferred`) and keeps the shares; `redeemDirect` pays any amount. The minimum is a
  constant (`MIN_REDEEM_VALUE`) matching the Base adapter's 0.01 TAO `minSendAmount`.
- **First come, first served.** A front door's allowance goes to redeems in delivery order, so one
  large holder can take a door's whole window. Deferred users must request again and pay the
  redeem-request fee again.
- **Earlier unpaid burns can count again.** Payouts reserved in the liquid balance do not count in
  the base, but value burned and not yet paid out that is still staked (when the balance does not
  cover the queue, which `processPayouts` then unstakes) counts in the next window's base.
- **Windows are fixed, not rolling.** A rogue front door can burn a full allowance just before its
  window ends and another just after, about 2× in a short span.
- **A rogue adapter gets every door's allowance.** Any enabled adapter can present any registered
  front door: two during a migration, more if Robinhood Chain is added. A cap across all front
  doors is deliberately not added, because one door's honest exits would then block another's users.
- **The backstop needs people.** Beyond the allowance, protection depends on the guardian removing
  the front door (or disabling the adapter) within the 24-hour delay, and on the owner then
  cancelling the batch. Otherwise the loss is bounded by the allowance each window, for as long as
  nobody acts.
- **A cancel does not restore the burn window,** so honest requests through that front door may be
  deferred until its window resets.
- **Chunk size is the keeper's call.** `processPayouts` is permissionless, but only the keeper's
  `maxEntries` counts: anyone else sends the largest chunk that fits, so a stranger cannot split a
  batch into many fee-paying messages. A stolen keeper key could still send `minChunk`-sized
  chunks, and a tail that would push a chunk over `maxMessageValue` still goes alone. Each extra
  message costs its users at most the fee ceiling.
- **Vesting follows the keeper's cadence.** Each claim re-spreads what is still unvested plus the
  new reward over 7 days, so frequent tiny claims stretch vesting out. Claim on a steady weekly
  cadence.
- **The claim fallback is permissionless.** If the keeper lapses for 7 days, anyone may claim a
  hotkey's rewards and so choose when its validator basket is sold into root stake. Do not let the
  keeper lapse.
- **The limits are owner parameters, within hard bounds.** They change without the 7-day registry
  delay, behind only the owner's timelock (an operational setting, 48 hours in the beta), but the
  code bounds each one, so even a captured owner cannot remove layers 2 and 3:

  | Setter | Bound in the code | Why this bound |
  |---|---|---|
  | `setOutflowLimits` | at most 50% of the base a day; a floor of at most 100 TAO | A rogue front door takes at most half the base a window; the floor exists only so a small vault can exit, and 100 TAO is the spec's default. |
  | `setPayoutDelay` | 1 hour to 7 days | The delay is the guardian's window to hold a rogue batch; 1 hour is what the test cadence uses. A launch build may want a higher floor (12 hours or more), a code change that the test cadence would then have to follow. |
  | `setFeeLimits` | at most 5% of a chunk, or 0.1 TAO | What the primary adapter can quote, and keep, per chunk; the live fee is about 0.001 TAO. |
  | `setMessageLimits` | `maxMessageValue` at most 5,000 TAO | The lane's per-message limit (the adapters' `MAX_MESSAGE_VALUE`): above it chunks are unsendable. Keep it at or below the Bittensor adapter's deployed `maxMessageValue()` too. |
  | `setUnstakeMarginRao` | at most 1 TAO per removal | A huge margin turns every exit into a full unstake and re-stake, which also ramps back into the allowance base. |
  | `setRedeemRequestFee` (front door, and its constructor) | at most 0.001 ETH | Ten times the launch fee: no setting can price every exit out. |
  | `setMaxBatchValue` (front door) | at most 5,000 TAO | A batch above the lane's limit can never be sent, and its redeems wait with it. |

  Deliberately unbounded: `maxTotalAssets` and the front door's `depositCap` (beta caps that must
  grow with the product, and since the allowance base counts only ramped-in stake, a direct deposit
  no longer feeds it); `minDeposit`, `minDirectDeposit` and `hotkeyDustRao` (they gate deposits or
  hotkey removal, not exits); `claimGasRequired` (it affects only when rewards are claimed, and the
  right ceiling is the chain's block gas limit, still to be confirmed: checklist item 19).
- **Retiring a front door fails its in-flight batches.** `removeFrontDoor` also makes that door's
  batches still crossing revert `UnknownPeer` at delivery; their deposits wait in the rail until the
  door is registered again (7 days). Drain a door before retiring it.
- **The guardian's veto holds through the registry delay, not forever.** Replacing the guardian
  takes 8 days from the owner's proposal, longer than the 7-day registry delay, and only the owner
  can cancel it. So the sitting guardian stays in office through any registry proposal made
  alongside its replacement and can veto it: a compromised owner cannot bypass that veto within the
  registry delay. After 8 days it can install its own guardian and propose again, so a rogue front
  door or bridge needs at least 15 days of public notice plus the timelock's delay, during which
  users can exit.
- **A stolen guardian key can freeze for about 15 days.** Besides pausing, it can `removeFrontDoor`
  and `disableBridge`, and while still in office it can cancel the owner's re-registration
  proposals (`cancelFrontDoorProposal`, `cancelBridgeProposal`). Front-door deposits, redeems and
  payouts can therefore stay frozen for about 15 days plus the owner's timelock (8 days to replace
  the guardian, then a 7-day registry re-proposal); direct deposits and redeems, which only a pause
  stops, for 8 days plus the timelock. It cannot cancel its own replacement. This bound holds only
  if the guardian key is NOT granted the timelock's canceller role. Without that role the guardian
  cannot veto timelocked parameter changes within their hard bounds (the outflow percentage, `payoutDelay`, the fee ceiling,
  `setStakeHotkey` / `moveStake`), which wait only for the timelock.
- **An insolvent vault bounces deposits, not exits.** If the share price falls below half the
  launch price, a front-door batch still delivers: its deposits are not minted but bounced, queued
  ahead of the batch's redeems as payouts of their TAO with 0 shares (`DepositBounced`), and its
  redeems burn at the lowered price. A bounced deposit comes back to the user on Base after the
  24-hour payout delay, less its share of the bridge fee and the rao floor, so a griefer's deposit
  cannot hold up a batch's exits. `depositDirect` reverts `VaultInsolvent` until the vault is
  recapitalised out of band (see [Operator notes](#operator-notes)); direct redeems keep working.
- **Process a batch with bounced deposits; never cancel it.** `cancelPayoutBatch` re-mints each
  unsent entry's shares, and a bounced deposit has none, so a cancel releases its TAO into the
  vault's assets (to the holders) instead of returning it to the depositor.
- **A second front door needs share-origin tracking first.** Shares are not tied to the front door
  that minted them: any registered front door can redeem for an address. With a second front door
  on another chain, whoever controls the same address on that chain could redeem shares deposited
  through Base and claim the payout there, and a contract wallet's address can belong to someone
  else on another chain (see [Who can use direct access](#who-can-use-direct-access)). Before a
  second front door (on another chain) is activated, the vault needs per-peer share-origin
  tracking, which is not built. This is a precondition, not a parameter.
- **A position below the minimum stake waits.** The unstake walk skips any hotkey whose stake is
  below the minimum stake: the chain may refuse to touch it, and that revert would block every exit.
  An exit that needs that dust (under the minimum stake per hotkey: 0.002 TAO today, up to 1 TAO if
  the owner raises the fallback) reverts `UnstakeShort` until the position is cleared. `stakeIdle`
  tops up only the stake hotkey, and only once at least the minimum stake is idle; otherwise the
  owner sweeps the position with `removeHotkey`, which exits it fully (for the stake hotkey, after
  `setStakeHotkey` elsewhere first).

## Trust and supply chain

Outside parties. No delay applies to any of them.

| Party | What it can do | What bounds it |
|---|---|---|
| ForeverMoney's guardian and admin | Pause their `AlphaVault` (guardian) or start a migration (admin), with no notice. | A pause stalls both legs: deliveries to the vault fail (`withdrawLiquid` reverts) and are re-executed once it lifts, and `processPayouts` reverts (`depositLiquid`) and is retried. A migration is different and permanent for inbound batches: `initiateMigration` closes `depositLiquid` from the announcement (payouts through this adapter stop then and never resume on it; that TAO stays in Cascade's vault, so nothing is lost on that leg) while `withdrawLiquid` stays open for the 7-day delay, `executeMigration` moves the whole position and `withdrawLiquid` then reverts `Insolvent` for good, and `finishMigration` halts the vault indefinitely (ForeverMoney's operator can lift the halt; that does not bring the position back). The adapter's `alphaVault` is immutable and always answers ERC-165, so every `BATCH` delivered after `executeMigration` sits in CCIP `FAILURE` forever (no token-only fallback, no rescue), and the depositors in those batches lose their TAO, which was burned on Base. The 7-day notice window is the only protection: the keeper must not close batches during it, and ForeverMoney's `MIGRATION_DELAY` (7 days) equals the bridge registry's `REGISTRY_DELAY` (7 days), so the owner must propose the replacement adapter pair (both adapters, because `remoteAdapter` is circular) the day a migration is announced (see [Operator notes](#operator-notes) 17 and checklist item 25). No ForeverMoney key can take TAO that sits in the vault. |
| ForeverMoney's validator | Holds the stake behind bridged TAO while a batch or payout is in flight (minutes). | Nothing users see: conversion is 1:1 both ways, and the vault's own stake sits with its own validators. |
| ForeverMoney's 2-of-3 Safe | Pause the token pools, change rate limits, or remove ForeverMoney's TAO from CCIP. | Sends revert and batches wait. Exposure is TAO in an open batch, in flight, or credited and unclaimed on Base. Staked TAO is native on Bittensor and unaffected. |
| Chainlink CCIP (lane configuration, the default verifier committee, the Risk Management Network) | Pause a lane, change its gas or data limits, or withhold verification, which stalls batches in either direction. A compromised CCIP network could also deliver forged `BATCH` or `PAYOUTS` messages that an honest adapter accepts. The Risk Management Network check, an extra independent verification, is disabled on these lanes. Executions on both lanes go through `OffRamp 2.0.0` (read 2026-10-24). | Sends revert or deliveries wait. A lane gas limit lowered below an adapter's gas model needs a new adapter through the 7-day registry. Forged messages get the same bounds as a rogue adapter (see the contracts table below), and funds in flight are exposed. A failed delivery is retried by manual re-execution, which anyone can run, with no expiry. A message the rail loses loses only that batch's funds: there is no in-contract recovery and no in-flight lock, so other batches are unaffected. |
| Chainlink's default executor | Executes verified messages on the destination chain, or stops doing so. | Anyone, including the keeper, can execute a verified message with `OffRamp.execute`; there is no expiry. |
| Bittensor's sudo (root) key | Ship runtime upgrades (about weekly) that change precompile behaviour, or disable a precompile. Raise the staking floor (`DefaultMinStake`). | A raised floor holds a deposit batch below it in CCIP until the floor drops, and a payout chunk below it reverts until regrouped or cancelled (see [the staking floor](#bridge-adapters-ccip-20)); the adapters add one precompile read, `getDefaultMinStake()`. Value-moving precompile calls are measured, so an under-delivering unstake reverts (`UnstakeShort`) instead of paying from reserves or other users' payouts. That is a freeze, not a protection, if the chain ever charges a fee or under-delivers on root unstake: every exit that needs an unstake reverts until the owner raises `unstakeMarginRao` (added to every unstake request; any excess stays idle for `stakeIdle`; the fee then falls on all holders, not the leaver). For the Bittensor adapter an under-delivering root unstake is a loss of in-flight inbound batches, not a freeze: its delivery requires the native delta from `withdrawLiquid(token, amount, amount)` to be at least `amount`, it has no margin knob and it is immutable, so one rao short strands every batch in flight (a new adapter only helps future batches; checklist item 26). The price itself trusts the stake read, so a changed read would misprice; the keeper is to run each pre-release on testnet 945 first, and the [checklist](#pre-mainnet-checklist) lists the behaviours to confirm. |
| Validators (the hotkey owners) | The owner picks them, and they keep their validator take from the rewards. A validator's hotkey swap moves the vault's root stake to a new hotkey outside the set the vault reads, so the price drops until that hotkey is added back. | The keeper watches for hotkey swaps and stake drops, the guardian pauses, and the owner, guardian or keeper re-adds the hotkey (`addHotkey`; no timelock for the guardian or keeper). Front-door batches delivered in that window are mispriced (deposits get too many shares, redeems too little), and so are direct deposits and redeems: a colluding validator could swap and then `depositDirect` at the lowered price, bounded by the `maxTotalAssets` headroom the drop opens (the insolvency guard trips only below 50%). Keep one hotkey slot free (the set holds at most 4) so a swapped hotkey can be re-added without the timelock. |

Keys:

| Key | What it can do | What bounds it |
|---|---|---|
| Owner | Everything in [Roles](#roles) under "Owner", including replacing the guardian (8 days after proposing it) and picking the validators. | Cannot move user funds directly. The only route would be registering a rogue front door or bridge, which waits 7 days in public, and the sitting guardian can veto it: replacing the guardian takes 8 days, longer than the registry delay, and the guardian stays in office until then. A compromised owner cannot bypass the sitting guardian's veto within the registry delay; with the guardian vetoing, a rogue registration needs at least 15 days of public notice plus the timelock's delay. Parameter changes wait only for the timelock. |
| Guardian | Stop only: pause, remove a front door, disable a bridge, cancel a pending proposal. It can also add a hotkey, which only widens what the price reads. | A stolen guardian key can freeze, not take. The owner proposes a replacement at once and accepts it after 8 days; the guardian cannot cancel that. Until then it can re-pause, remove front doors, disable bridges and cancel the owner's re-registration proposals, so front-door deposits, redeems and payouts can stay frozen for about 15 days plus the owner's timelock (8-day replacement, then a 7-day registry re-proposal), and direct deposits and redeems for 8 days plus the timelock. The bound holds only if the guardian key does NOT hold the timelock's canceller role. It could fill the hotkey set (at most 4); the owner removes extras. |
| Keeper | Time `claimRewards` and `stakeIdle`; add a hotkey; choose payout chunk sizes. | A stolen key can time claims and stakes badly (frequent tiny claims stretch vesting), and on a runtime with a post-stake hold on unstaking it can re-arm that hold with `stakeIdle` to delay exits, and it alone chooses payout chunk sizes (each extra chunk costs its users at most the fee ceiling); it cannot move funds. Anyone may act after 7 days (counted from deploy, or from when a hotkey was first added, until the first stake or claim), and the owner can replace or clear the keeper. |
| Deployer | One-shot: sets the owner, guardian, hotkey, expected coldkey, initial bridge and, optionally, the vault's initial front door (a chain id and address; a zero address names none). The initial bridge and front door are active at once, with no delay, because nobody has deposited yet; every later front door or bridge waits 7 days. | Check every constructor argument before anyone deposits (checklist item 28), including that the initial front door has code and points back at this vault: `frontDoorActive(peerId(chain, frontDoor))` proves only the registration. The vault derives its own coldkey and reverts `ColdkeyMismatch` if the expected one differs. |

Contracts:

| If compromised | What it can do | What bounds it |
|---|---|---|
| A front door | Burn the shares of users it names, up to `max(20% of the ramped-in root stake, 100 TAO)` per fixed 24-hour window, with the TAO owed to itself. | The 24-hour payout delay, an instant guardian hold, and an owner cancel that re-mints the shares. Users marked `directOnly` are skipped. |
| An adapter | Present any registered front door, so it gets every door's allowance (same bounds). It holds whatever passes through it in flight. On Base it can credit only tokens the front door holds beyond its books: donations, or payout tokens that landed ahead of their data in the separate-data-message fallback. It can credit that surplus to anyone with a made-up `PAYOUTS` message, and the pending chunk whose tokens it spent then fails `TokensNotReceived`. Its replay slots are its own, so it cannot pre-mark another adapter's deliveries. Whichever adapter is primary sets the fee quote: it can quote up to the fee ceiling and keep the excess. Borrowed TAO delivered as a forged deposit-only batch first does not raise a door's allowance base: only stake that has ramped in for a day counts (see the soft spots). | The same bounds, plus the 7-day bridge registry and the guardian's `disableBridge`. A non-primary adapter's forged redeems are paid out through the primary adapter to the registered front door, which credits the named users on Base: forced exits, not theft. Theft needs a rogue front door or the primary adapter. Disabling a non-primary adapter does not hold batches it already delivered; hold those by removing the front door, then cancel them. |

App side (outside this build): the swap router and onramp APIs, npm dependencies, and the keeper's
RPC provider.

Build dependencies: OpenZeppelin Contracts v5.4.0 and forge-std v1.17.0, pinned by tag in
`foundry.lock`; solc 0.8.24 with EVM target cancun (what Bittensor EVM's docs recommend). Chainlink
code is vendored, not a dependency: three files of `@chainlink/contracts-ccip@2.0.0` in
`src/vendor/ccip` and its message codec in `test/vendor/ccip` (tests only), each with a `VENDOR.md`
giving the package's integrity hash.

## v3 trust model

**Delivery (USDC on exit).** With `requestRedeemWithDelivery` the user states a minimum USDC out and
a deadline. When the payout reaches Base, the keeper calls `deliver`: the front door hands the TAO to
the swapper, measures its own USDC balance before and after, and forwards what it received to the
user. The result must be at least the largest of three floors: the user's floor, the keeper's
floor, and the 30-minute TWAP value less 1.5% (owner-set, hard maximum 3%).

- A stolen keeper key can time deliveries but cannot sell a user's TAO more than 1.5% below the
  30-minute average price (or below the user's own floor).
- A malicious swapper can only make a delivery revert. It cannot keep the TAO or count an unrelated
  transfer as the proceeds, because the front door measures its own balance.
- `claim()` always works. If a delivery keeps failing, or the user's USDC address is blocked, the
  user claims the TAO by hand, as in v2.
- The owner changes the swapper, routes and fee values only behind the timelock and only within the
  hard caps in the code.

**The oracle has no liquidity check.** The price is a 30-minute average of two pools, the smaller
holding about $200k. Holding such a pool off-price for 30 minutes costs more than the margin on
capped deliveries (the 1.5% edge), so it is not worth attacking, but nothing on chain checks pool
depth. If liquidity thins a lot, the owner lowers the delivery slippage or swaps the oracle.
A delivery reverts unless the swap can pay at least the 30-minute average less
`maxDeliverySlippageBps` (1.5%). The keeper then skips it and retries later, and the user can always
claim by hand. The keeper uses that whole window: it delivers once its quote (after the 0.15% swap
fee) reaches both floors, with its own minimum at the quote less 0.5% but never below either floor.
Observation, not a guarantee: on a Base fork in October 2026 (pool fees about 0.35%, the 0.15% swap
fee, pools near $200k) deliveries went through while the pools' sell quote (pool fees and price
impact included) was within about 1.35% of the 30-minute average, which is the mid price within
about 1.0% of it.

**The reward cut.** At each reward claim the vault mints shares worth 10% of the claimed rewards
(owner-set, hard maximum 20%) to the treasury, at the price from before the claim, so the cut never
moves the share price. It is skipped when the price is below half the launch price (the existing
insolvency line); that claim then vests normally for everyone.

- The treasury must be an address with no code on both chains. `pnpm ops verify` checks it. A
  contract treasury could be impersonated by a twin at the same address on the other chain.
- The effective share is slightly above the rate, about 10.01% at normal claim sizes (a claim near
  1% of assets), because the treasury's new shares also share in that claim's 7-day vesting. Say
  "about 10%" in copy.
- If a reward claim happens while no shares are outstanding, the treasury (the only holder) ends up
  with the whole claim as it vests; nobody else is affected.
- Unclaimed rewards sit outside the share price until collected. Collection is expensive (one claim
  is about 53M gas; the vault requires `claimGasRequired` = 55M and the ops tool sends a 57M limit), so the keeper claims only when the rewards waiting are at least 25 times the
  claim's cost, or monthly while a claim costs under $20 and does not exceed what is waiting.
  Someone who leaves before a collection misses up to about a month of yield. Anyone can still
  claim by hand.

**Validator.** The v3 test deployment stakes with tao.bot (0% take, the largest, among the cheapest estimated
claim; see `reports/Cascade v3 root validators.md`). Moving to another validator later is
`setStakeHotkey` plus `moveStake`.

## Who can use direct access

- **Bittensor-native users, and anyone with a plain key-pair wallet (EOA) who holds TAO for gas on
  chain 964.** The same key controls the same address on both chains.
- **Not, in practice, smart-wallet users on Base.** No Coinbase Smart Wallet factory, faucet or gas
  sponsorship was found on chain 964, so smart-wallet users rely on the front door for exits. A
  user-registered Bittensor recovery address is the v2.1 answer.
- **Contract wallets whose address someone else can claim on Bittensor must be handled by the app.**
  `redeemDirect` pays whoever controls the address on chain 964. A legacy `CREATE` wallet's address
  follows its deployer's nonce, so a different party may hold it there: the app must refuse these.
  A counterfactual (`CREATE2`) wallet's address follows its factory and its *initial* owners
  (Coinbase Smart Wallet, Safe): if the owner set changed after deployment (a rotated key, a
  replaced signer), the original owners can deploy the same address on chain 964 and call
  `redeemDirect` on its shares. The app must warn users who rotated keys.
- Because csTAO cannot be transferred, every share balance was created either by a front door (a
  deposit for that address on Base) or by `depositDirect` (the address acted on Bittensor and stays
  `directOnly` until it opts in). A Base party therefore cannot redeem a Bittensor depositor's
  shares. Anyone can deposit for any address (`depositFor` on Base), so an address can hold shares
  it did not pay for, but shares can never be taken from anyone: only the address itself can redeem
  them, directly on Bittensor or by its own redeem request on Base.
- **The same address on a second front door's chain may be a different party.** Any registered
  front door may redeem for any address, so a second front door on another chain would let whoever
  controls that address there redeem shares deposited through Base: the contract-wallet cases
  above, now between two front-door chains. Per-peer share-origin tracking is required before a
  second front door (on another chain) is activated (see the soft spots under
  [Exit safety](#exit-safety)).

## Operator notes

1. **Fund the reserves first.** Before first use, send the vault's address at least `ED_RESERVE`
   (1e12 wei = 1,000 rao) as a substrate-side transfer to its mirror (SS58) address; `receive()`
   rejects plain EVM sends. The reserve is never spent or counted, so the chain's 500-rao
   existential deposit can never make a payout fail. Funding it up front means the first users'
   deposits do not have to fill it. Also call the Bittensor adapter's `fundReserve()` with 1e12 wei
   before its first delivery. Bittensor EVM reports balances net of the existential deposit, so an
   adapter that holds nothing sees each conversion 500 rao short and every delivery reverts
   `ConversionShort` until the reserve is there (nothing is lost; re-execute them afterwards).
2. **Size the redeem-request fee to the bridge fee.** Keep `redeemRequestFee × maxRedeems` at or
   above the live Base-to-Bittensor bridge fee (beta values: 1e14 wei × 50 = 0.005 ETH). Otherwise a
   junk-filled batch cannot self-close: the `requestRedeem` that would close it reverts
   `InsufficientFee`, and the keeper must close it with `closeBatch` and ETH attached. The fee is
   capped at `MAX_REDEEM_REQUEST_FEE` (0.001 ETH; 0.05 ETH for a full 50-entry list).
3. **Set the beta cap, in TAO.** Set the vault's `maxTotalAssets` (default 1,000 TAO; it caps direct
   deposits against the whole vault's assets) and each front door's `depositCap` (its deposits, net
   of payouts received) to the beta cap: about $250k, sized to the TAO liquidity on Base.
4. **Claims need about 55M gas.** `claimRewards` refuses to start below `claimGasRequired` (default
   55,000,000), so a mis-sized call cannot burn its gas in the precompile. Size it against the real
   precompile (about 53.2M measured), allowing for a call forwarding at most 63/64 of the gas left
   and for the stake reads of every hotkey in the set before and after the claim, and pre-check each
   claim with `eth_call`.
5. **Batch limits.** Keep 50 deposits + 50 redeems per batch until a fork measurement confirms that
   100 + 100 fits the lane's delivery gas (with as many hotkeys in the set as you use). The adapters
   size each delivery's gas to its entry count (unused gas is not refunded); check the pools'
   rate-limit allowance before closing. Keep the vault's `maxMessageValue` and the front door's
   `maxBatchValue` at or below the deployed adapters' `maxMessageValue()` (see the send limits in
   [Bridge adapters](#bridge-adapters-ccip-20)); the code refuses more than the lane's 5,000 TAO,
   but cannot read the adapters' caps.
6. **ETH receivers.** `closeBatch` pays the rest of the budget to the caller with a plain call, and
   so does a `requestRedeem` that self-closes a full batch. A keeper, router or wallet contract that
   cannot receive ETH cannot close a batch whose pot exceeds the fee; give it a payable `receive`.
7. **Insolvency recovery is out of band.** If the share price falls below half the launch price,
   front-door deposits bounce back to their users (process those batches with `processPayouts`;
   never cancel them, or the bounced TAO stays in the vault) and `depositDirect` reverts
   `VaultInsolvent`; redeems keep working. Recover with a substrate-side transfer to the vault's
   mirror address; deposits mint again from the next delivery.
8. **Pause on any unexplained drop in `totalAssets`.** The insolvency guard trips only below half
   the launch price. A smaller unexplained drop (a misread stake, for example) still lets batches
   and direct deposits through at the lowered price until someone pauses.
9. **`batchInterval` has no lower bound, but it has an upper one.** A very short interval lets anyone
   close a batch before a user's cancel lands. Set it behind the timelock with care. The other way,
   `MAX_BATCH_INTERVAL` is 7 days: the constructor and `setBatchInterval` refuse more
   (`InvalidParameter`), so even a captured owner cannot set a longer `batchInterval`. The cap
   bounds `batchInterval` only: the owner or guardian can still `pause()`, which stops closes for as
   long as it lasts (deposits stay cancellable with `cancelDeposit`, and redeems with
   `cancelRedeem`, while paused), and the keeper's 24-hour hold under the launch cadence is an
   off-chain policy, not something the contract enforces.
10. **The primary bridge is a single point of liveness.** Disabling a contract's primary bridge stops
    its outgoing messages (closes on Base, payouts on Bittensor) until the owner sets another enabled
    bridge as primary, and a new adapter takes 7 days to register. Keep a standby adapter registered.
11. **Hotkeys.** `setStakeHotkey` routes new stake to a new validator and `moveStake` moves existing
    stake onto it. Keep an old hotkey in the set (at most 4) until its rewards are claimed, because
    rewards land on the hotkey that earned them. `removeHotkey` refuses while unclaimed rewards
    exceed `hotkeyDustRao`, unless told to forfeit them. The owner, guardian or keeper can
    `addHotkey`: after a validator's hotkey swap, add the new hotkey at once so its stake counts in
    the price again (pause first if batches are arriving). Keep one slot free so a swapped hotkey
    can be re-added without the timelock. The unstake walk skips a position below the minimum
    stake: `stakeIdle` tops up only the stake hotkey, and only when at least the minimum stake is
    idle; `removeHotkey` exits such dust fully (on the stake hotkey, `setStakeHotkey` elsewhere
    first).
12. **Replacing the guardian takes 8 days.** `proposeGuardian`, then `acceptGuardian` once
    `GUARDIAN_DELAY` has passed; only the owner can `cancelGuardianProposal`. Do NOT grant the
    guardian key the timelock's canceller role, or the bound below fails. A stolen guardian key can
    keep front-door flows frozen for about 15 days plus the owner's timelock (it can cancel
    re-registration proposals until it is replaced), and direct deposits and redeems for 8 days
    plus the timelock. Without the canceller role the guardian cannot veto timelocked parameter
    changes (the outflow percentage, `payoutDelay`, the fee ceiling, `setStakeHotkey` /
    `moveStake`), which wait only for the timelock. A compromised owner cannot bypass the sitting
    guardian's veto within the registry delay.
13. **Unstake margin and floors.** If root unstakes start delivering short (a chain fee), every exit
    that needs an unstake reverts `UnstakeShort`. Set `unstakeMarginRao` to at least the shortfall
    per removal; any excess stays idle for `stakeIdle`. `setFloorFallbacks` can raise the floors but
    never lower them below the live reads: the vault uses the larger of the two.
14. **Drain a front door before retiring it.** `removeFrontDoor` also fails that door's batches
    still in flight (`UnknownPeer`). Stop its deposits, let its open and in-flight batches deliver,
    then remove it.
15. **Outside parties.** ForeverMoney's 2-of-3 Safe, Chainlink's lane configuration and Bittensor's
    sudo key can each stop or change the rails with no delay. See [Trust and supply chain](#trust-and-supply-chain).
16. **Deposit minimums.** A partial `cancelDeposit` must leave at least `minDeposit` (a full cancel
    always works), so no entry sits below the minimum in force when it last changed. Keep the front
    door's `minDeposit` at or above the Base adapter's `minSendAmount` (0.01 TAO). `setCaps` can set
    it lower, and a batch whose total then falls below `minSendAmount` reverts `BelowSendMinimum`
    at `closeBatch` and stays open until more deposits arrive.
17. **Staking-floor stalls.** A payout chunk whose net is below the live floor (0.002 TAO today)
    makes `processPayouts` revert `BelowConversionFloor` until the keeper groups it with
    neighbouring entries (`maxEntries`). The vault no longer burns a redeem worth less than 0.01 TAO,
    so this needs a raised floor, a fee near 0.008 TAO or a tiny bounced deposit. If every remaining
    entry is tiny, the owner cancels the batch (`cancelPayoutBatch` re-mints the shares; nobody loses
    funds), unless it holds bounced deposits (note 7). The web app must refuse unstake requests
    worth less than 0.01 TAO (the vault would defer them, and the user would have paid the request
    fee for nothing). Before
    `closeBatch`, the keeper reads `getDefaultMinStake()`: a deposit batch that arrives while the
    floor sits above its total waits in CCIP until the floor drops (at a 0.01 TAO minimum deposit
    that takes a five-fold raise). Next to that floor pre-check, a second keeper rule: do not
    `closeBatch` while `AlphaVault.migrationReadyAt() != 0`, `AlphaVault.migrationFinished()` or `AlphaVault.isPaused()` is true
    (a batch delivered after a completed ForeverMoney migration is stranded for good; see
    [Trust and supply chain](#trust-and-supply-chain)).
18. **Re-executing a failed delivery.** A delivery that reverts (ForeverMoney paused, the vault
    paused, out of gas, the floor raised, the adapter's reserve unfunded) stays `FAILURE` on the
    destination's `OffRamp 2.0.0`. Anyone can run `OffRamp.execute(encodedMessage, ccvs,
    verifierResults, gasLimitOverride)` on it again at any time, with no expiry; raise
    `gasLimitOverride` if it ran out of gas. Re-execution needs the default committee's
    `verifierResults`, which only Chainlink's verifier infrastructure produces: fetch them from the
    CCIP explorer or verifier API first. The keeper spec owns the tooling.

Defaults at deploy:

| Parameter | Default | Contract |
|---|---|---|
| `maxDeposits` / `maxRedeems` | 50 / 50 per batch (ceiling 100) | front door |
| `maxBatchValue` | 4,000 TAO (at most `MAX_BATCH_VALUE`, 5,000 TAO) | front door |
| `batchInterval`, `minDeposit`, `depositCap`, `redeemRequestFee` | constructor arguments (beta: 12 hours; fee 1e14 wei); `batchInterval` is capped at `MAX_BATCH_INTERVAL` (7 days), `redeemRequestFee` at `MAX_REDEEM_REQUEST_FEE` (0.001 ETH) | front door |
| `maxDailyOutflowBps` / `minDailyOutflow` | 20% / 100 TAO per 24-hour window per front door (at most 50% / 100 TAO) | vault |
| `maxEntryValue` / `maxMessageValue` / `minChunk` | 2,000 TAO / 4,000 TAO / 10 entries (`maxMessageValue` at most 5,000 TAO) | vault |
| `payoutDelay` | 24 hours (owner-settable, 1 hour to 7 days) | vault |
| `maxFeeBps` / `maxFeeAbs` | 1% / 0.02 TAO (at most 5% / 0.1 TAO) | vault |
| `maxTotalAssets` | 1,000 TAO | vault |
| `minDirectDeposit` | constructor argument | vault |
| `claimGasRequired` | 55,000,000 | vault |
| `hotkeyDustRao` | 1,000,000 rao (0.001 TAO) | vault |
| `fallbackMinStakeRao` / `fallbackMinRemainRao` | 2,000,000 / 20,000,000 rao (0.002 / 0.02 TAO); the floors used are the larger of these and the live reads | vault |
| `unstakeMarginRao` | 0 rao (at most 1 TAO) | vault |
| `REGISTRY_DELAY`, `KEEPER_FALLBACK`, `REWARD_VESTING` | 7 days each (constants) | both / vault |
| `GUARDIAN_DELAY` | 8 days (constant) | both |
| `ED_RESERVE` | 1e12 wei (constant) | vault |
| `gasBase` / `gasPerEntry` toward Bittensor | 540,000 / 26,450 (constructor arguments, Base adapter; calibrated in `test/adapters/AdapterGas.t.sol`) | Base adapter |
| `gasBase` / `gasPerEntry` toward Base | 120,000 / 29,900 (constructor arguments, Bittensor adapter) | Bittensor adapter |
| `minSendAmount` | 0.01 TAO (1e16 wei; constructor argument; keep `minDeposit` at or above it) | Base adapter |
| adapter reserve | 1e12 wei, funded by the deployer through `fundReserve()` before the first delivery | Bittensor adapter |
| `GAS_CAP` | 7,000,000 (constant) | both adapters |
| `MAX_MESSAGE_VALUE` | 5,000 TAO (constant): the most `maxMessageValue` may be | both adapters |
| `maxMessageValue` | constructor argument (`Config`), 0 < value <= 5,000 TAO; see the send limits | both adapters |

## Static analysis

Slither 0.11.5 over `src/` (`contracts/slither.config.json` filters out `lib/` and `test/`): 69
results, no new defects. Re-run from `contracts/` with `slither .`.

| Severity | Finding | Verdict |
|---|---|---|
| High | `arbitrary-send-eth` in `processPayouts` (no longer reported) | Slither now reads the `msg.sender == keeper` chunk-size check in `_takeChunk` as access control, but `processPayouts` is still permissionless. By design: the destination is the owner-registered primary bridge (7-day registry). |
| High | `weak-prng` ×3 | False positive: `x % RAO` aligns amounts to whole rao; nothing is random. |
| High | `reentrancy-eth` in `requestRedeem` | The self-close path. Every function that moves ETH or tokens is `nonReentrant`; the only function reachable mid-call is `creditRedeemFee`, which only adds credit (credit added there may pay the same request's fee, which is taken after the close). |
| Medium | `incorrect-equality` ×7 | Intentional zero checks (including the unset-timestamp check that seeds a new hotkey's claim fallback). |
| Medium | `uninitialized-local` ×2 | Intentional zero starts: the delivery's payout queue `b` in `onBridgeMessage` and the burn total in `_burnRedeems`. |
| Medium | `reentrancy-no-eth` ×4 | Calls into the staking precompile, which is runtime code, not EVM code, and cannot re-enter. |
| Low / Info | `calls-loop` | Bounded by `MAX_HOTKEYS = 4` (the set's stake reads, including those around a reward claim, and the unstake walk). |
| Low / Info | `timestamp` | The 7-day, 8-day and 24-hour windows tolerate clock drift. |
| Low / Info | `assembly` | A memory-safe length shrink in `_deductFee`. |
| Low / Info | `low-level-calls` | Intended value sends. |
| Low / Info | `missing-zero-check` on `setKeeper` | By design: `address(0)` leaves only the 7-day fallback. |
| Low / Info | `naming-convention` ×4 | The precompile's own snake_case parameter names in `IStaking.moveStake`. |

## Pre-mainnet checklist

Confirm on Bittensor testnet 945 or a fork of chain 964:

1. `claimRootWithHotkey` behaves as the mock models: it credits root (netuid 0) stake on the same
   hotkey for the vault's coldkey (the vault measures its whole position, so a credit elsewhere in
   the set or as balance still vests); the root claim type is Swap, not Keep; what it does when
   there is nothing to claim; no chain-side auto-claim bypasses vesting; and `getStake` reads one
   rao short only on a fresh position.
2. Units and rounding: the precompile's stake amounts are rao; root `removeStake` and
   `removeStakeFull` credit exactly `want × 1e9` wei (otherwise set `unstakeMarginRao`);
   `getUnclaimedRootTaoByHotkey` is 18-decimal; Bittensor EVM floors value transfers to rao (the
   payout-fee rounding assumes it); `removeStakeFull` on an empty position reverts rather than
   silently paying 0.
3. Floors: the minimum-stake boundary is inclusive on both remove and add (for a partial unstake
   of exactly the floor, the live simulation in item 11 showed it), and a full exit of a position
   below the minimum stake succeeds (`removeHotkey` relies on it).
4. Identity: `addressMapping(vault)` equals the coldkey the staking precompile credits (stake dust
   and read it back).
5. Root unstake "too early" windows for a contract coldkey, and pauses during basket migrations (a
   payout or direct redeem that hits one reverts and must be retried).
6. Precompile failure modes on the live runtime: a failed write reverts with no data and burns the
   forwarded gas, and a capped `try/catch` view read (the live floors from `getDefaultMinStake` and
   `getNominatorMinRequiredStake`, 100,000 gas each) falls back to the owner-set values as modelled.
   A read that succeeds with malformed return data is NOT caught by the `try/catch`: the decode
   reverts in the vault and fails every call that reads the floors. Nor is an out-of-range
   (implausibly large) but successful read: every position would read as below the minimum stake,
   so the unstake walk skips them all and exits freeze until the owner moves stake and removes
   hotkeys (each removal exits its position fully).
7. `setRejectStakingHotkeyGrowth` semantics, and that it has no clearing setter; a root-to-root
   `moveStake` is fee-free.
8. A validator's hotkey swap moves a contract coldkey's root stake (the keeper's swap monitoring and
   `addHotkey` exist for this).
9. Gas: the block gas limit exceeds 55M (reward claims need it), and delivery gas with 4 hotkeys in
   the set (every price read walks the set).
10. The post-Root-Reborn reward cadence, to set how often the keeper claims.

Rails and ForeverMoney:

11. ForeverMoney's conversion: answered on 2026-10-23 (`withdrawLiquid` and `depositLiquid` on
    their `AlphaVault`, permissionless and exactly 1:1; `docs/forevermoney-probe.md`). Just before
    deploying (`pnpm ops preflight` in `ops/` does this), run `bash script/simulate_inbound.sh` against the live node with the deployment's
    constructor arguments (`REMOTE_ADAPTER`, `GAS_BASE`, `GAS_PER_ENTRY`) and record its output in
    the runbook: it is the only run of their real unstake through the real staking precompile. On
    2026-10-24 it delivered 1 TAO, and exactly 0.002 TAO (so a partial unstake at the floor
    succeeds).
12. The adapters deliver tokens and data together (fork-tested through the real `OffRamp 2.0.0` on
    both lanes; the front door's `TokensNotReceived` check assumes tokens arrive with or before
    their data). Still open: a batch with no deposits (`amount` 0) sent through a real Router (the
    fork tests deliver one through Bittensor's OffRamp but send none).
13. CCIP manual re-execution never expires on these lanes (none in the 2.0.0 source; the fork tests
    re-execute a failed message through the real OffRamp).
14. The CCIP fee does not depend on the token amount on these lanes (the vault quotes on gross
    amounts and sends the net).
15. Executions land on `OffRamp 2.0.0` on both lanes (read 2026-10-24). Before deploying, confirm
    the `OffRamp 2.0.0` addresses still match `test/fork/ForkBase.sol` (`BASE_OFFRAMP`,
    `BIT_OFFRAMP`); the fork tests' `offRamp20` check fails if they changed.
16. ForeverMoney's TAO on Base has no transfer fee and does not rebase (the front door checks only
    its 18 decimals).

Measurements and policy:

17. Fork-measure delivery gas before raising batch limits above 50 + 50.
18. Watch `forge build --sizes` after any post-audit change (67 B of headroom in the vault at
    `optimizer_runs = 200`).
19. Decide the `setClaimGasRequired` bounds policy: 0 disables the guard and too high blocks claims.
    It is owner discipline, behind the timelock.
20. Maintenance: the vault's front-door registry (`proposeFrontDoor`, `activateFrontDoor`,
    `cancelFrontDoorProposal`, `removeFrontDoor`) duplicates the bridge registry in `CascadeBase`
    (propose, activate after `REGISTRY_DELAY`, cancel, disable), and the vault's constructor
    activates the initial front door the way `CascadeBase`'s activates the initial bridge. A fix to
    one must be mirrored in the other; consider one shared, keyed registry in a later version.

Outside this build:

21. Per-peer share-origin tracking, before a second front door on another chain is activated (see
    the soft spots under [Exit safety](#exit-safety)).
22. The deployment scripts and runbook, and the keeper bot (including the tooling that re-executes
    failed deliveries). The adapters are built.
23. An independent audit of the contracts and the adapters.
24. Legal: jurisdictions, fees, US users.

Added by the final whole-branch review (2026-10-24):

25. ForeverMoney migration: a completed migration strands every inbound batch delivered after it,
    and `MIGRATION_DELAY` (7 days) equals `REGISTRY_DELAY` (7 days). Have the runbook say that the
    owner proposes the replacement adapter pair (both adapters, because `remoteAdapter` is
    circular) the day a migration is announced, and that the keeper stops closing batches while
    `AlphaVault.migrationReadyAt() != 0`, `AlphaVault.migrationFinished()` or `AlphaVault.isPaused()`.
26. Decide, before any deployment larger than the first test run, whether the next adapter version
    tops up a bounded shortfall (for example at most 1 rao per delivery) from its reserve; the
    current adapter requires exact 1:1.
27. Confirm how to obtain `verifierResults` for a FAILURE message on these lanes before deploying.
28. After deploying (`pnpm ops deploy` and `pnpm ops verify` in `ops/` do all of this; see
    `docs/runbook-test-run.md`), read back on chain `adapterBase.remoteAdapter()`, `adapterBit.remoteAdapter()`,
    both adapters' `router()`, `token()` and `remoteSelector()`, and `adapterBit.alphaVault()`, and
    compare them with the plan: `remoteAdapter` is circular across two chains, and a wrong
    prediction (a stray transaction, a nonce mismatch) makes every delivery `WrongSender` and
    leaves the first batch's tokens in FAILURE forever. Deploy the Base side first, so the vault
    names an initial front door that already has code (the Base contracts then hold the predicted
    Bittensor addresses, and nothing on Bittensor trusts an empty slot). Then read back on Base the
    front door's `vault()`, `vaultChain()` and `primaryBridge()` and its code hash, and on Bittensor
    `vault.frontDoorActive(vault.peerId(chain, frontDoor))` with `chain` equal to
    `adapterBit.remoteChainId()` (the chain id the adapter reports, not the CCIP selector), and
    that the vault's deploy transaction emitted exactly one `FrontDoorActivated`. Call
    `fundReserve()` with 1e12 wei before
    activating the bridge. Send one single-entry 0.01-TAO batch and watch it deliver before opening
    deposits.
29. **Implemented in v3.** Add a reward cut before taking other people's money (owner decision, 2026-10-25): the contracts
    charge nothing today, so the keeper's batch, stake and payout fees are pure cost (about $1.60
    per deposit batch at test-run prices). Planned shape: at each reward claim the vault mints
    treasury shares worth a set share of the claimed rewards (about 10%, as Lido does), with a
    hard-coded ceiling and the rate behind the timelock. The vault has 799 bytes of headroom, so it
    must fit there or go in a new vault version; it gets its own spec, tests and review.
    The cut alone does not cover spam: costs are per batch, and 50 minimum deposits from 50
    addresses fill the deposit list (`maxDeposits`), which makes the batch closable at once and
    reverts every other deposit (`BatchFull`) until someone pays the ~$1.45 bridge fee to close it.
    Give deposits a small fee into the batch's fee pot, as redeem requests already have, sized so a
    full batch pays its own close; raise `minDeposit` for launch; and give the keeper a close policy
    (close a full batch at once, otherwise on the timer).
30. **Implemented in v3.** USDC lands in the wallet (owner decision, 2026-10-25): no claim step for users. Planned shape:
    with the redeem request the user signs (EIP-712) a minimum USDC out and a deadline; when the
    payout reaches Base, the keeper calls the next front door's claim-and-swap for that user, which
    swaps through the fixed Uniswap route and reverts below the signed minimum, then sends USDC to
    the user. Below the minimum or past the deadline it waits or delivers the TAO; the user can
    always claim by hand. No keeper-chosen slippage, so a keeper or a sandwich bot cannot take more
    than the user agreed to. Own spec, tests and review; launch can ship one-click claim-and-swap
    first if this is not ready.

Added for v3 (2026-10-26):

31. Measure a real claim on Bittensor testnet 945 (gas used and TAO cost) and compare candidate
    validators' basket sizes; set `OPS_CLAIM_COST_TAO` from the measurement. The 53M gas figure (the vault requires 55M, ops sends 57M) and
    the tao.bot cost estimate (about 0.045 TAO) come from research, not from a run.
32. Check both pools' observation cardinality before launch (Uniswap TAO/WETH 0.3% and WETH/USDC
    0.05%): the oracle needs history covering 30 minutes, so if a pool's cardinality is too low,
    grow it with `increaseObservationCardinalityNext` and wait. Concretely, before launch call
    `increaseObservationCardinalityNext(1800)` on the TAO/WETH pool
    (`0x82dD34C6631C286cDD1dB16f2c232f60E402Dd5A`): 30 minutes is 900 Base blocks but the pool has
    600 slots, so dust swaps in more than 600 of 900 blocks could block deliveries (no loss; claims
    still work).
33. **Partly done.** The launch cadence now exists in ops: `OPS_CADENCE=launch` when making a new v3
    plan gives a 1-hour minimum batch interval, a 24-hour payout delay and a keeper that closes a
    batch when it is full, 24 hours old, or its estimated Cascade fees cover its bridge fee (the
    test cadence is 10 minutes and 1 hour; the cadence is stored in the record, so `verify` checks
    each record against its own values). Still to decide before real users: the treasury (the test
    deployment uses the test wallet), a timelock as owner (so interval changes are announced first),
    and the caps.
34. **Done in v3.** The v3 Bittensor adapter's payout gas is raised: `SETTINGS_V3.bitGas.base`
    goes from 120,000 to 170,000 (29,900 per entry, unchanged), and v2 keeps 120,000. The Base
    payout receiver needs about 134.6k for one entry: the node's estimate, which counts gas before
    refunds. That was 90% of the old 149,900 limit and is about 67% of 199,900. The ops rehearsal
    now relays each message with exactly the gas limit the message asks for, and fails when a
    receiver needs more. A failed delivery would need manual CCIP re-execution.
