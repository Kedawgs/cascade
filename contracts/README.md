# Cascade contracts (v2)

Solidity contracts for Cascade: staked TAO for people who do not have a Bittensor wallet. Users
deposit TAO on Base, the TAO is staked on Bittensor's root network (netuid 0), and users hold csTAO
shares whose price rises as staking rewards come in.

- Product context: [`docs/architecture.md`](../docs/architecture.md).
- Authoritative design: [`docs/superpowers/specs/2026-10-21-cascade-v2-vault-on-bittensor-design.md`](../docs/superpowers/specs/2026-10-21-cascade-v2-vault-on-bittensor-design.md)
  (revision 5, with the as-built rulings of revision 6 at the top).
- Rail facts (CCIP, ForeverMoney, limits): [`reports/Cascade v2 Bittensor vault rails.md`](../reports/Cascade%20v2%20Bittensor%20vault%20rails.md).

Not in this build: the production bridge adapters, the keeper bot, deployment scripts, and the
app's USDC swaps. See the [pre-mainnet checklist](#pre-mainnet-checklist).

## Contracts

| Contract | Chain | What it does |
|---|---|---|
| `CascadeVault` | Bittensor EVM (chain 964) | Holds the root stake and the csTAO balances. Prices every batch from the stake it reads directly. Queues payouts and sends them in chunks. Lets Bittensor-native users deposit and redeem directly. |
| `CascadeFrontDoor` | Base | Collects deposits of ForeverMoney's bridged TAO and redeem requests into batches, forwards each batch to the vault with each user's address, receives payouts and lets users claim them. It never prices anything. |
| `CascadeBase` | both | Shared admin: two-step owner, guardian, pause, and the bridge registry (a new bridge waits 7 days). `renounceOwnership` is disabled. |

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

There are no proxies, no `delegatecall` and no arbitrary external calls. Value leaves the vault in
only two ways: a payout chunk sent through the primary bridge, and a direct redeem paid to the share
owner.

### What adapters must honour

The vault and the front door never see CCIP or ForeverMoney. A Bittensor adapter sits between CCIP
and the vault, and a Base adapter between CCIP and the front door. They are the parts designed to be
replaced, because every outside change (ForeverMoney's token, Chainlink's lane, a Bittensor runtime
upgrade) lands there. An adapter must:

- **Be immutable.** No admin and no upgrade path. Its router, peer addresses and gateway are
  constructor constants. Any change is a new adapter that goes through the 7-day registry.
  Otherwise the adapter's own admin would bypass the delay, and because any enabled adapter may
  present any registered front door, the weakest adapter would set the security level for every
  front door.
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
  rate limit, refilling at 0.6 TAO/s and shared with every ForeverMoney user), at most 32,000 bytes
  of data, and a delivery gas budget within about 7.2M on Bittensor and about 13M on Base. The
  contracts' defaults are set to stay under these: 4,000 TAO per batch and per payout chunk, 50 + 50
  entries per batch, and at most 100 entries in any list.

Blocking dependency: the inbound conversion needs a function on ForeverMoney's Bittensor contracts
that a third-party contract may call. Their source is not verified on the explorer, and their docs
describe only app and SDK use. These contracts are built and tested against `MockBridge`; the
adapter spec waits for ForeverMoney's answer.

## Build and test

```shell
forge build
forge test                                    # unit, end-to-end and invariant tests
forge test --match-path "test/invariants/*"   # invariant suite only
forge build --sizes                           # the vault must stay under 24,576 bytes
forge fmt --check
```

- **Suite:** 242 tests (unit, end-to-end, and 8 invariants at 128 runs × 64 depth, set in
  `foundry.toml`). The invariants also held at 3,000 × 64 and 500 × 256.
- **Invariants:** the price never falls, except across a payout-batch cancel, and then not below
  that batch's price (within 100 rao of rounding dust); gross assets are conserved; reserved payouts
  match the queue; no front door burns more than its allowance in a window; the front door's token
  and ETH balances match its books; users never claim more than was paid out; no unexpected reverts.
- **Test doubles** (`test/mocks`): `MockStaking` is etched at the precompile address and models the
  floor reads, over-request clipping, sweeps, a fresh position reading one rao short, and claims that
  burn all gas when refused. `MockBridge` is chain-aware, enforces the fee rule and a 5,000-TAO
  message cap, delivers with a 7,000,000 gas cap, and keeps failed deliveries queued for retry. Also
  `MockAddressMapping`, `StubBridge` and `MockTAO`.
- **Gas:** a 100 + 100 batch delivery costs 4,524,716 gas (test bound 6,500,000); 50 + 50 costs
  2,381,432 (bound 3,500,000). The lane gives about 7.2M. Operator limits default to 50 + 50; raise
  them to 100 only after a fork measurement.
- **Sizes:** `CascadeVault` is 22,266 B of runtime code (limit 24,576; 2,310 B of headroom, so any
  post-audit change must watch `forge build --sizes`). `CascadeFrontDoor` is 13,117 B.

## Money flow

### Deposit leg (Base to Bittensor)

1. The app swaps the user's USDC for ForeverMoney's TAO on Base. The user calls `deposit`, or a
   one-signature "zap" contract calls `depositFor`, which can only credit the named user. Amounts
   must be whole rao (1 rao = 1e-9 TAO), at least `minDeposit`, inside the front door's
   `depositCap`, and inside the batch's 4,000-TAO value limit. Each user has one merged entry per
   batch. `cancelDeposit` returns tokens while the batch is still open.
2. To exit, a user calls `requestRedeem(shares)`. The front door cannot see balances on Bittensor,
   so the vault clips each request later. The first request per user per batch costs
   `redeemRequestFee` in ETH (the spec's default, 1e14 wei, is about $0.30). It is paid with the
   call or from credit that anyone can pre-pay with `creditRedeemFee`; this is how the app sponsors
   passkey wallets that hold no ETH. `cancelRedeem` reduces a request; the fee is not refunded.
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
   the user keeps those shares and can request again. Each burn's payout is reserved and queued.
   The vault stores only a running hash of the queue; the keeper resubmits the list from the
   `Redeemed` events. No single entry can make a batch revert. Delivery never stakes and never
   claims rewards.
5. Later, the keeper calls `stakeIdle` to stake the liquid TAO that is not reserved for payouts.

### Payout leg (Bittensor to Base)

1. Once `payoutDelay` (24 hours) has passed, anyone calls `processPayouts` with the batch's full
   list. The caller chooses the chunk size, but a request below 10 entries (`minChunk`) is raised to
   10, so nobody can make each user pay a whole message fee. A chunk stays within 4,000 TAO, except
   that it always takes at least one entry. The vault quotes the bridge fee and refuses
   (`FeeTooHigh`) if the fee is above the larger of 1% of the chunk and 0.02 TAO; the batch then
   waits for fees to fall. Each user pays a pro-rata share of the fee in TAO, rounded against the
   user and down to whole rao. An entry left with nothing is recorded as dust (`PayoutDust`) and its
   value stays in the vault. The vault unstakes only what the chunk needs (root unstaking is 1:1 and
   fee-free) and sends the chunk through the primary bridge. A batch whose front door has been
   removed is refused (`FrontDoorInactive`).
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
  has no outflow cap: the share owner signs on this chain, and root unstaking costs other holders
  nothing.
- Both refuse while the vault is paused. See [Who can use direct access](#who-can-use-direct-access).

## Roles

Routine calls and who makes them:

| Call | Who | Fallback |
|---|---|---|
| `closeBatch` (Base) | anyone; the keeper in practice | — |
| `processPayouts` (Bittensor) | anyone; the keeper in practice | — |
| `stakeIdle` | keeper | anyone, once 7 days have passed since the last stake |
| `claimRewards(hotkey)` | keeper | anyone, once 7 days have passed since that hotkey's last claim |
| CCIP re-execution | anyone | — |

- **Deposit-leg fee:** the CCIP fee in ETH, paid from the batch's redeem-request pot first and then
  by whoever calls `closeBatch`; any excess goes to that caller. With no redeem requests it is an
  operator cost of about $1.5–11 per batch, depending on size and the delivery gas bought.
- **Payout-leg fee:** the CCIP fee in native TAO, deducted from the chunk pro-rata under the fee
  ceiling. The caller only fronts gas (about $1.4–4 per `processPayouts` at the chain's 5-gwei
  floor).
- There are no other fees to users.
- The keeper only times reward claims and staking; it cannot move funds. Timing does shift a little
  value between leavers and stayers. Rewards count in the price only after a claim, and then vest
  linearly over 7 days, so someone who leaves forgoes rewards that are still unclaimed or vesting.
  With weekly claims the unclaimed part is at most about a week of yield (about 0.1%).
- `setKeeper(address(0))` is allowed and leaves only the 7-day fallback.

Other roles:

- **Owner:** a timelock (48 hours in the beta) controlled by a Safe. Proposes and activates front
  doors and bridges, sets the primary bridge, guardian, keeper, hotkeys and limits, cancels payout
  batches, and unpauses.
- **Guardian:** a fast, low-trust key that can only stop flows: `pause`, `removeFrontDoor`,
  `disableBridge`, `cancelBridgeProposal` and `cancelFrontDoorProposal`.
- **Everyone else:** deposits, redeem requests, cancels, closes, payouts, claims and direct access.

The keeper bot is a separate deliverable. Hosted keeper services are gone (Chainlink Automation,
Gelato Web3 Functions and OpenZeppelin Defender all shut down in 2026), so it is a self-hosted bot
on both chains with its keys in OpenZeppelin Relayer or a cloud KMS. It needs an archive or paid
RPC: the public lite RPC drops state after about 300 blocks, and payout lists are rebuilt from
events. Its jobs: close batches after checking the pools' rate-limit allowance and sizing delivery
gas to the entry count; re-execute failed deliveries; run `processPayouts` after the delay; run
`stakeIdle` on a schedule; run `claimRewards` weekly after an `eth_call` pre-check (expected delta,
no `RootClaimTooHeavy`); watch `getPrecompileStatus` for the staking precompile; and run the
contracts' precompile calls against each Bittensor pre-release on testnet 945.

## Exit safety

A front door speaks for its users: a `BATCH` from it burns the named users' shares, and the TAO is
owed to that front door. So whoever gets an address registered as a front door, or controls an
enabled adapter, could submit redeem-only batches naming every holder. The vault bounds this.

The honest statement, from the spec:

> The team cannot move user funds instantly; any new front door or bridge is announced on-chain
> seven days ahead and the guardian can veto it; a compromised front door can burn at most about 20%
> of the vault per day in redemptions (per registered front door, and never less than 100 TAO a
> day), nothing it burned can be paid out for 24 hours, the guardian can hold those payouts at once,
> and the owner can then cancel the batch and return the shares. Outside the contract, ForeverMoney's
> signers, Chainlink's lane configuration and Bittensor's sudo key can stop or change the rails with
> no delay.

"About 20% of the vault" is measured on gross assets after the batch's deposits are credited, so it
includes anything the attacker deposits in the same batch (see the soft spots below).

The four layers:

1. **Registry changes are slow, visible and vetoable.** A new front door or bridge can be activated
   only 7 days after it is proposed on-chain; the guardian or owner can cancel a proposal, remove a
   front door or disable a bridge at once.
2. **Burns are capped per front door at delivery.** Each front door may burn at most
   `max(20% of gross assets, 100 TAO)` per fixed 24-hour window; requests beyond that are deferred
   and the users keep their shares.
3. **Payouts wait, and stop the moment a front door is removed.** Nothing burned can leave for 24
   hours, `processPayouts` refuses a removed front door's batches, and the owner can then
   `cancelPayoutBatch`, which re-mints every unsent user's shares at the batch's price.
4. **Pause holds everything that moves value** (deliveries, payouts, staking, direct deposits and
   redeems; on Base, deposits, redeem requests and closes) but never blocks cancels, claims on Base,
   reward claims, payout-batch cancels or incoming payouts on Base.

Soft spots:

- **The allowance counts the attacker's own deposits.** It is 20% of gross assets after the batch's
  deposits are credited. A rogue front door that delivers about 4× the vault's assets in deposits in
  one batch raises its allowance to the whole vault for that batch. (Those deposits must be real TAO
  delivered with the message.)
- **Windows are fixed, not rolling.** A rogue front door can burn a full allowance just before its
  window ends and another just after, about 2× in a short span.
- **A rogue adapter gets every door's allowance.** Any enabled adapter can present any registered
  front door: two during a migration, more if Robinhood Chain is added. A cap across all front
  doors is deliberately not added, because one door's honest exits would then block another's users.
- **The backstop needs people.** The hard bound is the 24-hour delay plus the guardian removing the
  front door (or disabling the adapter) in time, and the owner cancelling the batch. If nobody acts
  within the delay, the loss is bounded only by the allowance.
- **A cancel does not restore the burn window,** so honest requests through that front door may be
  deferred until its window resets.
- **The limits are owner parameters.** The outflow percentage and floor, the payout delay (up to 7
  days) and the fee ceiling change without the 7-day registry delay, behind only the owner's
  timelock (an operational setting, 48 hours in the beta).
- **An insolvent vault stops front-door batches.** If the share price falls below half the launch
  price, every front-door batch, redeems included, reverts `VaultInsolvent` until the vault is
  recapitalised out of band (see [Operator notes](#operator-notes)). Direct redeems keep working.

## Trust and supply chain

Outside parties. No delay applies to any of them.

| Party | What it can do | What bounds it |
|---|---|---|
| ForeverMoney's 2-of-3 Safe | Pause the token pools, change rate limits, or remove ForeverMoney's TAO from CCIP. | Exposure is TAO in an open batch, in flight, or credited and unclaimed on Base. Staked TAO is native on Bittensor and unaffected. |
| Chainlink CCIP lane configuration and rate limits | Stall batches in either direction. The lanes are mid-migration to CCIP 2.0, and the Risk Management Network check is switched off on the current lanes. | A failed delivery is retried by manual re-execution, which anyone can run. A message the rail loses loses only that batch's funds: there is no in-contract recovery and no in-flight lock, so other batches are unaffected. |
| Bittensor's sudo key | Ship runtime upgrades (about weekly) that change precompile behaviour, or disable a precompile. | Value-moving precompile calls are measured, so an under-delivering unstake reverts (`UnstakeShort`) instead of paying from reserves or other users' payouts. The price itself trusts the stake read, so a changed read would misprice; the keeper is to run each pre-release on testnet 945 first. |

Keys:

| Key | What it can do | What bounds it |
|---|---|---|
| Owner | Everything in [Roles](#roles) under "Owner". | Cannot move user funds directly. The only route would be registering a rogue front door or bridge, which waits 7 days in public and which the guardian can veto. Parameter changes wait only for the timelock. |
| Guardian | Stop only: pause, remove a front door, disable a bridge, cancel a pending proposal. | A stolen guardian key can freeze, not take. Unpausing needs the owner, and a removed front door or disabled bridge comes back only through the 7-day registry. |
| Keeper | Time `claimRewards` and `stakeIdle`. | A stolen key can shift a little reward timing and nothing else. Anyone may act after 7 days, and the owner can replace or clear the keeper. |
| Deployer | One-shot: sets the owner, guardian, hotkey, expected coldkey and initial bridge. The initial bridge is enabled at once, with no delay. | Check every constructor argument before anyone deposits. The vault derives its own coldkey and reverts `ColdkeyMismatch` if the expected one differs. |

Contracts:

| If compromised | What it can do | What bounds it |
|---|---|---|
| A front door | Burn the shares of users it names, up to `max(20% of gross assets including its own deposits, 100 TAO)` per fixed 24-hour window, with the TAO owed to itself. | The 24-hour payout delay, an instant guardian hold, and an owner cancel that re-mints the shares. Users marked `directOnly` are skipped. |
| An adapter | Present any registered front door, so it gets every door's allowance (same bounds). It holds whatever passes through it in flight. On Base it can only credit payouts backed by tokens already in the front door, and can block only its own deliveries. | The same bounds, plus the 7-day bridge registry and the guardian's `disableBridge`. |

App side (outside this build): the swap router and onramp APIs, npm dependencies, and the keeper's
RPC provider.

Build dependencies: OpenZeppelin Contracts v5.4.0 and forge-std v1.17.0, pinned by tag in
`foundry.lock`; solc 0.8.24 with EVM target cancun (what Bittensor EVM's docs recommend).

## Who can use direct access

- **Bittensor-native users, and anyone with a plain key-pair wallet (EOA) who holds TAO for gas on
  chain 964.** The same key controls the same address on both chains.
- **Not, in practice, smart-wallet users on Base.** No Coinbase Smart Wallet factory, faucet or gas
  sponsorship was found on chain 964, so smart-wallet users rely on the front door for exits. A
  user-registered Bittensor recovery address is the v2.1 answer.
- **Legacy `CREATE` contract wallets must be refused by the app.** A nonce-deployed contract wallet
  on Base could have its address held by a different party on Bittensor, who could then call
  `redeemDirect` on its shares.
- Because csTAO cannot be transferred, every share balance was created either by a front door (the
  address acted on Base) or by `depositDirect` (the address acted on Bittensor and stays
  `directOnly` until it opts in). A Base party therefore cannot redeem a Bittensor depositor's
  shares, and a Bittensor party cannot receive shares it did not deposit for.

## Operator notes

1. **Fund the reserve first.** Before first use, send the vault's address at least `ED_RESERVE`
   (1e12 wei = 1,000 rao) as a substrate-side transfer to its mirror (SS58) address; `receive()`
   rejects plain EVM sends. The reserve is never spent or counted, so the chain's 500-rao
   existential deposit can never make a payout fail. Funding it up front means the first users'
   deposits do not have to fill it.
2. **Size the redeem-request fee to the bridge fee.** Keep `redeemRequestFee × maxRedeems` at or
   above the live Base-to-Bittensor bridge fee (defaults: 1e14 wei × 50 = 0.005 ETH). Otherwise a
   junk-filled batch cannot self-close: the `requestRedeem` that would close it reverts
   `InsufficientFee`, and the keeper must close it with `closeBatch` and ETH attached.
3. **Set the beta cap, in TAO.** Set the vault's `maxTotalAssets` (default 1,000 TAO; it caps direct
   deposits against the whole vault's assets) and each front door's `depositCap` (its deposits, net
   of payouts received) to the beta cap: about $250k, sized to the TAO liquidity on Base.
4. **Claims need about 55M gas.** `claimRewards` refuses to start below `claimGasRequired` (default
   55,000,000), so a mis-sized call cannot burn its gas in the precompile. Size it against the real
   precompile (about 53.2M measured), allowing for a call forwarding at most 63/64 of the gas left,
   and pre-check each claim with `eth_call`.
5. **Batch limits.** Keep 50 deposits + 50 redeems per batch until a fork measurement confirms that
   100 + 100 fits the lane's delivery gas. Size each batch's delivery gas to its entry count (unused
   gas is not refunded), and check the pools' rate-limit allowance before closing.
6. **ETH receivers.** `closeBatch` pays the rest of the budget to the caller with a plain call, and
   so does a `requestRedeem` that self-closes a full batch. A keeper, router or wallet contract that
   cannot receive ETH cannot close a batch whose pot exceeds the fee; give it a payable `receive`.
7. **Insolvency recovery is out of band.** If the share price falls below half the launch price,
   `onBridgeMessage` and `depositDirect` revert `VaultInsolvent`. Recover with a substrate-side
   transfer to the vault's mirror address, then re-execute the failed deliveries.
8. **`batchInterval` has no lower bound.** A very short interval lets anyone close a batch before a
   user's cancel lands. Set it behind the timelock with care.
9. **The primary bridge is a single point of liveness.** Disabling a contract's primary bridge stops
   its outgoing messages (closes on Base, payouts on Bittensor) until the owner sets another enabled
   bridge as primary, and a new adapter takes 7 days to register. Keep a standby adapter registered.
10. **Hotkeys.** `setStakeHotkey` routes new stake to a new validator and `moveStake` moves existing
    stake onto it. Keep an old hotkey in the set (at most 4) until its rewards are claimed, because
    rewards land on the hotkey that earned them. `removeHotkey` refuses while unclaimed rewards
    exceed `hotkeyDustRao`, unless told to forfeit them.
11. **Outside parties.** ForeverMoney's 2-of-3 Safe, Chainlink's lane configuration and Bittensor's
    sudo key can each stop or change the rails with no delay. See [Trust and supply chain](#trust-and-supply-chain).

Defaults at deploy:

| Parameter | Default | Contract |
|---|---|---|
| `maxDeposits` / `maxRedeems` | 50 / 50 per batch (ceiling 100) | front door |
| `maxBatchValue` | 4,000 TAO | front door |
| `batchInterval`, `minDeposit`, `depositCap`, `redeemRequestFee` | constructor arguments (beta: 12 hours; fee 1e14 wei) | front door |
| `maxDailyOutflowBps` / `minDailyOutflow` | 20% / 100 TAO per 24-hour window per front door | vault |
| `maxEntryValue` / `maxMessageValue` / `minChunk` | 2,000 TAO / 4,000 TAO / 10 entries | vault |
| `payoutDelay` | 24 hours (at most 7 days) | vault |
| `maxFeeBps` / `maxFeeAbs` | 1% / 0.02 TAO | vault |
| `maxTotalAssets` | 1,000 TAO | vault |
| `minDirectDeposit` | constructor argument | vault |
| `claimGasRequired` | 55,000,000 | vault |
| `hotkeyDustRao` | 1,000,000 rao (0.001 TAO) | vault |
| `fallbackMinStakeRao` / `fallbackMinRemainRao` | 2,000,000 / 20,000,000 rao (0.002 / 0.02 TAO) | vault |
| `REGISTRY_DELAY`, `KEEPER_FALLBACK`, `REWARD_VESTING` | 7 days each (constants) | both / vault |
| `ED_RESERVE` | 1e12 wei (constant) | vault |

## Static analysis

Slither 0.11.6 over `src/` (with `lib/` and `test/` filtered out): 67 results, no new defects.
Re-run from `contracts/` with `slither . --filter-paths "lib/|test/"`.

| Severity | Finding | Verdict |
|---|---|---|
| High | `arbitrary-send-eth` in `processPayouts` | By design: the destination is the owner-registered primary bridge (7-day registry). |
| High | `weak-prng` ×3 | False positive: `x % RAO` aligns amounts to whole rao; nothing is random. |
| High | `reentrancy-eth` in `requestRedeem` | The self-close path. Every function that moves ETH or tokens is `nonReentrant`; the only function reachable mid-call is `creditRedeemFee`, which only adds credit. |
| Medium | `incorrect-equality` ×6 | Intentional zero checks. |
| Medium | `reentrancy-no-eth` ×4 | Calls into the staking precompile, which is runtime code, not EVM code, and cannot re-enter. |
| Medium | `uninitialized-local` ×3 | Counters and sums that start at 0, as intended. |
| Low / Info | `calls-loop` | Bounded by `MAX_HOTKEYS = 4`. |
| Low / Info | `timestamp` | The 7-day and 24-hour windows tolerate clock drift. |
| Low / Info | `assembly` | A memory-safe length shrink in `_deductFee`. |
| Low / Info | `low-level-calls` | Intended value sends. |
| Low / Info | naming; two unindexed event address parameters | Hygiene. |

## Pre-mainnet checklist

Confirm on Bittensor testnet 945 or a fork of chain 964:

1. `claimRootWithHotkey` behaves as the mock models: it credits root (netuid 0) stake on the same
   hotkey for the vault's coldkey; what it does when there is nothing to claim; no chain-side
   auto-claim bypasses vesting; and `getStake` reads one rao short only on a fresh position.
2. Units and rounding: the precompile's stake amounts are rao; Bittensor EVM floors value transfers
   to rao (the payout-fee rounding assumes it); `removeStakeFull` on an empty position reverts
   rather than silently paying 0.
3. Root unstake "too early" windows for a contract coldkey, and pauses during basket migrations (a
   payout or direct redeem that hits one reverts and must be retried).
4. Precompile failure modes on the live runtime: a failed write reverts with no data and burns the
   forwarded gas, and a capped `try/catch` view read (the live floors from `getDefaultMinStake` and
   `getNominatorMinRequiredStake`, 100,000 gas each) falls back to the owner-set values as modelled.
5. `setRejectStakingHotkeyGrowth` semantics, and that a root-to-root `moveStake` is fee-free.
6. The post-Root-Reborn reward cadence, to set how often the keeper claims.

Rails and ForeverMoney:

7. ForeverMoney's conversion interface: a function on their Bittensor contracts that a third-party
   contract may call to turn their token into native TAO (this blocks the adapter spec), and whether
   their Base gateway can forward a data payload.
8. The adapters deliver tokens and data together on both lanes (the front door's
   `TokensNotReceived` check assumes tokens arrive with or before their data), and a batch with no
   deposits (`amount` 0) crosses the lane.
9. CCIP manual re-execution never expires on these lanes.
10. The CCIP fee does not depend on the token amount on these lanes (the vault quotes on gross
    amounts and sends the net).
11. CCIP 2.0 lane migration status.
12. ForeverMoney's TAO on Base has no transfer fee and does not rebase (the front door checks only
    its 18 decimals).

Measurements and policy:

13. Fork-measure delivery gas before raising batch limits above 50 + 50.
14. Watch `forge build --sizes` after any post-audit change (2,310 B of headroom in the vault).
15. Decide the `setClaimGasRequired` bounds policy: 0 disables the guard and too high blocks claims.
    It is owner discipline, behind the timelock.

Outside this build:

16. Production adapters (a separate spec, once ForeverMoney answers), the keeper bot, and
    deployment scripts.
17. An independent audit of the contracts and the adapters.
18. Legal: jurisdictions, fees, US users.
