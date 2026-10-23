# Cascade contracts v2 — vault on Bittensor, front door on Base — design spec

## As built (revision 6, 2026-10-22)

The contracts on branch `contracts-v2` follow revision 5 below, except for these build rulings.
Where they differ, the code and this list win. Contract-level detail is in `contracts/README.md`.

1. **Short unstakes revert.** `_unstake` returns the unmet remainder; `redeemDirect` and
   `processPayouts` revert `UnstakeShort()` if it is non-zero (no slack). A precompile that
   under-delivers makes exits fail loudly instead of paying from `ED_RESERVE` or `pendingPayouts`.
2. `redeemDirect` reverts `ZeroAmount` when the payout, floored to rao, is 0 (no burning shares for
   nothing).
3. A reward claim with a measured delta of 0 updates `lastClaimAt` and emits `RewardsClaimed(h, 0)`
   but does not restart the vesting schedule.
4. **Insolvency guard.** `onBridgeMessage` and `depositDirect` revert `VaultInsolvent()` when
   `A * 2_000_000 < S`, i.e. the share price is below half the launch price (1e-6 wei per share
   unit, which is 1 TAO per csTAO). This applies to every batch, redeem-only ones included. Recovery
   is out of band (a substrate-side transfer to the vault's mirror address), then the failed delivery
   is re-executed.
5. `processPayouts` rounds the quoted bridge fee up to a whole rao before the ceiling check and the
   pro-rata deduction, so the value sent is always whole rao (the chain floors EVM transfers).
6. `moveStake` measures only the destination (`moved`); `StakeMoved` has one measured field.
7. Front door `canClose()` full-by-value term: `totalDeposits >= maxBatchValue ||
   maxBatchValue - totalDeposits < minDeposit`.
8. The front door emits `FeeCreditSpent(user, amount)` when a redeem request is paid from credit.
9. **Front-door replay record** is `delivered[bridge][keccak256(message)]` (per delivering adapter,
   by message hash), not `delivered[batchKey][chunk]`. A rogue adapter can only occupy its own slots;
   an early exact copy must be backed by tokens (so it can only spend surplus or donations) and
   leaves the honest adapter its own slot. Every delivery emits
   `PayoutsDelivered(batchKey, chunk, amount, bridge)`, including an empty one.
10. Vault `LimitSet(bytes32 name, uint256 a, uint256 b)` uses the state-variable name as the label;
    `setMessageLimits` emits two events. `maxTotalAssets` defaults to `1_000e18`. Front-door batch
    ids start at 1. `setKeeper(address(0))` is allowed (fallback-only mode).
11. The vault's `onBridgeMessage` checks `NotBridge` before the pause, with explicit
    `_requireBridge(); _requireNotPaused();` calls.
12. Test doubles: MockStaking's one-rao-short read applies to any credit into an empty position
    (`addStake` and the `moveStake` destination); `removeStakeFull` honours `setUnstakeBlocked`;
    MockBridge checks `destChain` (`UnknownDestination`).

Naming: the guardian's `cancelProposal` below is two functions in the code,
`cancelBridgeProposal` (both contracts) and `cancelFrontDoorProposal` (vault).

---

Revision 5 (2026-10-21), after the v2 research (`reports/Cascade v2 Bittensor vault rails.md`)
and four builder checks (the last found nothing Critical; the per-task code reviews take over).
Supersedes the v1 contract design (`2026-10-20-cascade-contracts-design.md`) for the vault half.
Product context: `docs/architecture.md` (to be updated to match this spec once approved).

## Intent and why

v1 kept the share accounting on Base and only the stake on Bittensor. Because the Base vault
could not see the stake, it had to trust a number reported across the bridge, so it needed
price bounds, flagging, an owner review step and a one-batch-in-flight rule — and a lost bridge
message froze every later batch.

v2 moves the accounting next to the stake. **One contract on Bittensor EVM holds both the root
stake and the csTAO share balances and prices every action from the real stake it can read
directly.** Base gets a thin **front door** that batches users' deposits and redemption requests
and forwards them with each user's address. Nothing is estimated, nothing is flagged, batches are
independent (no in-flight lock), and the "all your TAO is staked" proof is one read from the
chain where shares and stake both live.

The research established, and this revision builds in, that:

- Chainlink CCIP is the only rail that moves TAO between Base and Bittensor EVM, and what it
  delivers on Bittensor is ForeverMoney's ERC-20 claim token, not native TAO. Only ForeverMoney's
  contracts convert it. **The conversion lives in a replaceable adapter, outside the vault.**
- Claiming root rewards needs a ~53M-gas allowance and can be refused by the chain. **Claims are
  a separate keeper call, never part of pricing or delivery, and vest into the price.**
- A CCIP delivery on Bittensor gets about 7.2M gas, one message carries at most 5,000 TAO, and
  storage is the cost that matters. **Batches are smaller and payout lists are stored as hashes.**
- TAO balances are kept in rao (1e9 wei); sub-minimum stake remainders are swept; the coldkey
  can be derived on-chain. **Amounts are rao-aligned, floors are read live, balance deltas are
  measured.**
- Only Base and Robinhood Chain have a bridgeable TAO token. **Ethereum, BNB and Polygon front
  doors are dropped; those users bridge USDC to Base in the app.**
- A front door speaks for its users: a rogue one could burn their shares. **Redeems are capped
  per front door at delivery, payouts wait a delay and stop the moment a front door is removed,
  and a batch can be cancelled with the shares given back.** That is the core of exit safety.

## Goals / non-goals / anti-goals

- Goals: simplest possible money logic; no trusted operator in the loop; one vault, any number of
  front doors; a user's shares survive the front door disappearing (direct access for EOAs); the
  parts that depend on outside parties (bridge, ForeverMoney) are isolated in adapters that can be
  replaced without touching the vault.
- Non-goals (this build): production bridge adapters (a separate spec once ForeverMoney's
  contract interface is known — see "Adapters"), the keeper bot (a separate deliverable),
  deployment scripts, fees to users (one exception: a small anti-spam charge on redeem *requests*
  on Base; it pays the batch's bridge fee and any excess goes to whoever forwards the batch,
  usually Cascade's own keeper, and the app may pre-pay it for its users), USDC conversion (the app swaps
  USDC↔TAO on Base around deposit/claim), a wrapped or transferable csTAO (possible later),
  subnet staking, a user-registered recovery address on Bittensor (v2.1).
- Anti-goals: any path where the team's keys can move user funds; any contract that must trust a
  reported balance; any single lost or forged message that blocks other users; any routine action
  that needs more gas than a bridge delivery can buy; any way for a peer or an outside party to
  take more than a bounded, delayed, reversible amount.

## Global rules

- Solidity `0.8.24`, EVM `cancun`, OpenZeppelin `v5.4.0`. No proxies, no `delegatecall` (which
  also rules out external libraries), no arbitrary external calls. Custom errors; an event per
  state change. `renounceOwnership` reverts `RenounceDisabled()`.
- **Code size.** The vault must stay under 24,576 bytes. The plan checks `forge build --sizes`
  as soon as the vault compiles. Agreed fallback if it does not fit: csTAO becomes a separate
  minimal ERC-20 contract (`CascadeShares`) that only the vault can mint and burn, deployed from
  the vault's constructor; the vault keeps the accounting and the stake on the same chain, which
  is the property that matters (the gas test is re-run if this split is used, since mint, burn
  and balance reads become external calls in the delivery loop). Second fallback: lower the
  optimizer `runs`.
- Roles. Owner = `Ownable2Step` (timelock + Safe in production; the timelock delay is an
  operations parameter, 48 hours in the beta). Guardian (a fast, low-trust key) may only stop
  flows: `pause`, `cancelProposal`, `disableBridge`, `removeFrontDoor`. Keeper (owner-set role)
  may time `claimRewards` and `stakeIdle`; anyone may call them after a fallback delay. Everything
  else routine is permissionless.
- Share math via `CascadeMath` (unchanged): `sharesForDeposit`, `assetsForRedeem`, `price`,
  virtual offset `1e6`, all rounded down. Shares have 24 decimals.
- **csTAO is non-transferable in v2.** `transfer`, `transferFrom`, `approve` revert
  `NonTransferable()`. Shares can only be minted by a batch, `depositDirect` or a cancelled
  batch, and burned by a batch or `redeemDirect`. This is what makes "the address that deposited
  controls the shares" true on both chains (see "Addresses and wallets"); a transferable wrapper
  can come later.
- Units: TAO amounts in contracts are 18-decimal wei; the precompile takes rao (`RAO = 1e9` wei).
  The chain truncates every transfer to rao, so the front door only accepts whole-rao amounts
  (`NotRaoAligned`) in `depositFor` **and** `cancelDeposit`, the vault rounds every incoming
  amount down to rao before pricing it (defence in depth: a misaligned entry can never strand a
  batch), and every amount the vault pays out is rounded down to rao. Front doors hold bridged
  TAO as an 18-decimal ERC-20 (`UnsupportedDecimals` otherwise).
- Users are identified by their EVM address, which is the same on every EVM chain. A front door
  forwards `msg.sender` (or the named user of `depositFor`, deposits only); the vault never takes
  a user address from anyone but a registered front door.
- Registries (front doors, bridge adapters) are sets with a propose/activate delay — see "Exit
  safety".
- Precompiles are constants: `STAKING = 0x0000000000000000000000000000000000000805` (staking
  precompile v2), `ADDRESS_MAPPING = 0x000000000000000000000000000000000000080c`. Tests
  `vm.etch` mocks at those addresses (as v1 does).
- **Measure, never assume.** Around every precompile call that moves value the vault records the
  balance and stake before and after and emits what actually happened; a measured delta may be
  zero or negative and never reverts on its own. Precompile dispatch failures surface as
  low-level errors with no return data and consume all forwarded gas, so the vault never wraps a
  precompile *write* in `try/catch`; it lets the revert bubble up and the caller retries.

## Bridge interface v2 (chain-aware)

```solidity
interface ICascadeBridge {
    /// ERC-20 side: pulls `amount` tokens from msg.sender (approve first); msg.value is the fee budget.
    /// Native side: msg.value == amount + fee budget.
    /// The fee budget (msg.value, or msg.value - amount) must be >= the adapter's real fee; the
    /// adapter keeps any excess and NEVER sends value back to the caller.
    function send(uint64 destChain, address recipient, bytes calldata message, uint256 amount) external payable;
    function quoteFee(uint64 destChain, address recipient, bytes calldata message, uint256 amount) external view returns (uint256);
}
interface ICascadeReceiver {
    /// Delivered by the adapter after transferring `amount` (ERC-20: before the call, msg.value == 0;
    /// native: msg.value == amount). `sourceChain`/`sender` are verified by the adapter.
    function onBridgeMessage(uint64 sourceChain, address sender, bytes calldata message, uint256 amount) external payable;
}
```

Receivers check `msg.sender` is an enabled bridge and that `(sourceChain, sender)` is a
registered peer. The vault side is **native**: the adapter must deliver real TAO with the message.
The front-door side is **ERC-20** (ForeverMoney's TAO on Base, `0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67`,
18 decimals, no permit). "At least the fee, never a refund" is the rule that lets the vault quote
a fee on one message shape and send another with the same byte length: the fee cannot depend on
amounts (CCIP's does not; data length is fixed-width per entry), and a small over-budget is
simply kept by the adapter.

## Adapters (out of this build; the contract they must honour)

The vault and front door never see CCIP or ForeverMoney. A **Bittensor adapter** sits between
CCIP and the vault, and a **Base adapter** between CCIP and the front door. They are the parts
designed to be replaced, because every outside change (ForeverMoney's token, Chainlink's lane,
a Bittensor runtime upgrade) lands there. Their obligations:

- **Immutable.** An adapter has no admin and no upgrade path; its router, peer addresses and
  gateway are constructor constants. Any change is a new adapter that goes through the vault's
  7-day registry. Otherwise an adapter's own admin would bypass the delay, and because any enabled
  adapter may present any registered `(sourceChain, sender)`, the weakest adapter would set the
  security level for every front door.
- **Fee budget.** Accept any `send` whose budget covers the real fee; keep the excess; never send
  value back to the caller (the vault's `receive()` would reject it).
- Inbound (Base → vault): receive ForeverMoney's token plus the `BATCH` data, convert the token to
  native TAO, then call `vault.onBridgeMessage{value: amount}(...)` with `amount == Σ deposits`.
  Preferred: conversion through a ForeverMoney function in the same transaction (atomic). Fallback
  if ForeverMoney only offers asynchronous "liquid delivery" to an address: the adapter owns that
  address, holds the data message as "awaiting funds", and calls the vault only once its own
  balance covers the batch. Either way the vault's `msg.value == amount` rule holds and the
  fragility stays in the adapter.
- Outbound (vault → front door): receive native TAO plus `PAYOUTS` data from `vault.processPayouts`,
  convert through ForeverMoney's gateway, and deliver token plus data to the front door. If the
  gateway cannot carry data, the adapter sends the data as a separate CCIP message; the front
  door's `TokensNotReceived` check makes that safe (the data message fails until the tokens are
  there, then anyone re-executes it). Note for the adapter spec: in that fallback the token check
  is pooled across chunks, so a chunk whose tokens the rail loses makes the *last* chunk's data
  fail, not its own.
- Limits the adapter must enforce before sending, because the lane will otherwise fail the
  message: ≤ 5,000 TAO per message (ForeverMoney pool rate limit, 0.6 TAO/s refill, shared with
  every ForeverMoney user), ≤ 32,000 bytes of data, and a delivery gas budget ≤ ~7.2M on Bittensor
  / ~13M on Base. The contracts below keep every message under those limits by construction.
- The README must say plainly that ForeverMoney's 2-of-3 Safe (token pools, rate limits),
  Chainlink's lane configuration and Bittensor's sudo key can each stop or change the rails with
  no delay.

**Blocking dependency:** the inbound conversion needs a function on ForeverMoney's Bittensor
contracts that a third-party contract may call. Their source is not verified on the explorer and
their docs describe only app/SDK use. The contracts in this spec are built against `MockBridge`
and do not wait for that answer; the adapter spec does.

## Messages (`CascadeMessages` v2)

```solidity
struct Entry { address user; uint256 amount; }   // amount = TAO wei for deposits/payouts, shares for redeems
struct Payout { address user; uint256 shares; uint256 assets; }   // what a batch committed to
```

| Kind | Value | Payload | Bridged amount |
|---|---|---|---|
| `BATCH` (front door → vault) | 1 | `uint64 batchId, Entry[] deposits, Entry[] redeems` | Σ deposits |
| `PAYOUTS` (vault → front door) | 2 | `bytes32 batchKey, uint32 chunk, Entry[] payouts` | Σ payouts |

Wrong kind → `WrongMessageKind`. Entry arrays are bounded by `MAX_ENTRIES = 100` per list per
message (decoding more reverts `TooManyEntries`). The front door's operator limits (default 50 per
list) sit below that; `MAX_ENTRIES` is the hard ceiling the vault relies on for gas.

`batchKey` is the vault's key for the delivered batch (see `onBridgeMessage`); it, not the front
door's `batchId`, identifies a payout batch, because a forged `BATCH` may carry any `batchId`. A
payout batch may be sent in several chunks; `(batchKey, chunk)` is the replay key on the front
door. `Payout` is never bridged; it is what the vault's running hash commits to and what the
keeper resubmits from events.

## CascadeVault (Bittensor EVM) — stake + shares

ERC-20 `Cascade Staked TAO` / `csTAO`, 24 decimals, non-transferable. Absorbs the v1
`StakeEngine` logic.

Constructor `(bytes32 expectedColdkey, bytes32 hotkey, ICascadeBridge bridge, address owner, address guardian, uint256 minDirectDeposit)`:
derives `coldkey = ADDRESS_MAPPING.addressMapping(address(this))` and reverts `ColdkeyMismatch`
if it differs from `expectedColdkey` (ForeverMoney's hand-typed coldkey caused a deploy incident;
the parameter stays as a cross-check only); `ZeroHotkey`; zero-address checks; calls
`STAKING.setRejectStakingHotkeyGrowth(true)` (stops strangers adding new hotkeys to the vault's
stake list; stake sent onto the vault's own hotkeys still lands, which only raises the price).
The initial bridge is enabled immediately (no delay at construction) and is the primary.

### Stake and hotkeys

- `bytes32[] hotkeys` (bounded by `MAX_HOTKEYS = 4`), `bytes32 stakeHotkey` (where idle TAO is
  staked; always in the set). `rootStakeRao() view` = Σ `STAKING.getStake(h, coldkey, 0)` over the
  set. A hotkey stays in the set while it has stake or meaningful unclaimed rewards, because
  rewards claimed later land on the hotkey that earned them.
- `addHotkey(bytes32 h)` (owner): adds `h` to the set without changing the stake hotkey
  (`TooManyHotkeys`, `ZeroHotkey`, `HotkeyKnown`); emits `HotkeyAdded`. Used to re-add a
  forfeited hotkey so its rewards can be claimed without routing new stake to it.
- `setStakeHotkey(bytes32 h)` (owner): adds `h` to the set if absent (same rules), makes it the
  stake hotkey; emits `StakeHotkeySet`.
- `moveStake(bytes32 from, uint256 rao)` (owner): `STAKING.moveStake(from, stakeHotkey, 0, 0, rao)`
  (root→root, fee-free); measures both stakes before/after; emits `StakeMoved(from, to, rao, moved)`.
- `removeHotkey(bytes32 h, bool forfeit)` (owner): `h != stakeHotkey` (`HotkeyInUse`); clears any
  remaining stake first (so a stranger parking dust on it cannot block removal): if the leftover
  is below `minStakeRao()` call `removeStakeFull(h, 0)` (a move below the minimum would be
  refused; the TAO becomes idle balance that `stakeIdle` restakes later), otherwise
  `moveStake(h, stakeHotkey, 0, 0, leftover)`; measure either way; then, unless `forfeit`, requires
  `STAKING.getUnclaimedRootTaoByHotkey(coldkey, h) <= hotkeyDustRao` (owner-set, default
  `1_000_000` rao, `HotkeyHasRewards`; a 1.7M-gas read is fine in an admin call). `forfeit` exists
  because a stranger's dust stake keeps earning a few rao per epoch and the chain can refuse that
  hotkey's claims (`RootClaimTooHeavy`), either of which would otherwise pin the hotkey forever;
  forfeited rewards stay owed on chain and can be claimed after re-adding the hotkey. Emits
  `HotkeyRemoved(h, unclaimed, forfeit)`.
- `stakeIdle()` — keeper, or anyone once `block.timestamp >= lastStakeAt + KEEPER_FALLBACK`
  (`7 days`); `whenNotPaused`, `nonReentrant`. **Not called from any delivery or payout path** (a
  precompile failure there would burn the delivery's gas, and a future root hold would re-arm on
  every stake — which is also why it is not permissionless: anyone could otherwise restart such a
  hold for cents). Stakes `idle = balance - pendingPayouts - ED_RESERVE` (floored at 0 — the
  liquid balance is normally below what queued batches are owed) on `stakeHotkey` if
  `idle / RAO >= minStakeRao()`; measures the stake delta; sets `lastStakeAt`; emits
  `Staked(hotkey, rao, measuredDelta)`. `ED_RESERVE = 1e12` wei (1,000 rao) is never spent and
  never counted, so the chain's 500-rao existential deposit can never make a payout fail.
- Floors are read live with a capped gas and a fallback: `minStakeRao()` =
  `STAKING.getDefaultMinStake{gas: 100_000}()` else `fallbackMinStakeRao` (owner-set, default
  `2_000_000`); `minRemainRao()` = `STAKING.getNominatorMinRequiredStake{gas: 100_000}()` else
  `fallbackMinRemainRao` (default `20_000_000`). (These are view reads, not dispatches, so a
  capped `try/catch` is safe.)
- `_unstake(uint256 shortfallWei)` (internal, used by payouts and direct redeems): walks the
  hotkey set starting with `stakeHotkey`. For each hotkey with stake `s`: `want =
  max(ceil(remaining / RAO), minStakeRao())`; if `want >= s` or `s - want < minRemainRao()` call
  `STAKING.removeStakeFull(h, 0)` (the chain would otherwise sweep the remainder anyway, and an
  over-request silently exits the whole position), else `STAKING.removeStake(h, want, 0)`.
  Measure `received = balance_after - balance_before`; emit `Unstaked(h, want, received)`;
  `remaining -= min(remaining, received)`; stop when `remaining == 0`. A precompile revert (e.g.
  root "too early", basket migration) bubbles up; the caller retries later; nothing else is
  blocked. `receive()` accepts value only while `_unstaking` is set (reverts
  `DirectTransferNotAllowed` otherwise). Credits bypass `receive()` on today's runtime; the flag
  protects against a runtime that routes them through it.
- Unexpected stake decreases (a chain sweep) or increases (a donation onto a hotkey) are never
  treated as errors: `totalAssets` reads both stake and balance, so a sweep moves value from one
  term to the other and a donation raises the price. A brand-new stake position reads back one
  rao short on the live chain; the mock models it and the price invariant tolerates one rao.

### Rewards: separate, keeper-timed, vested

Root rewards accrue in the validator's basket and become stake only when claimed. Claiming needs
a gas limit of about 53.2M (the precompile checks its declared worst-case weight before doing
anything), costs real money (about τ0.057 for a full basket), sells basket holdings with no
slippage bound, and can be refused by the chain (`RootClaimTooHeavy`) for reasons outside the
vault's control. Therefore:

- `claimRewards(bytes32 hotkey)` — `nonReentrant`; `hotkey` must be in the set. Callable by the
  keeper at any time, and by anyone once `block.timestamp >= lastClaimAt[hotkey] + KEEPER_FALLBACK`
  (per hotkey, so claiming one does not close the fallback for another). Requires `gasleft() >=
  claimGasRequired` (owner-set, default `55_000_000`, event `ClaimGasSet`) else `InsufficientGas`
  — this is what stops a mis-sized call from burning its gas in the precompile. Calls
  `STAKING.claimRootWithHotkey(hotkey)` with no `try/catch`; measures `delta = stake_after -
  stake_before` (zero or negative → `delta = 0`, still a success); sets `lastClaimAt[hotkey]`;
  starts vesting `delta`; emits `RewardsClaimed(hotkey, delta)`. The keeper role only times
  claims; it can never move funds. (Timing does shift a little value between leavers and stayers,
  see vesting; the README says so.)
- **Vesting.** A claim adds `delta` to the still-unvested remainder and restarts
  `vestingStart`; `unvestedRewards() view = vestingAmount * timeRemaining / REWARD_VESTING` with
  `REWARD_VESTING = 7 days`, linear. `totalAssets()` excludes the unvested part, so the share
  price rises smoothly over the week instead of jumping at the claim. Without this, a
  Bittensor-native user could `depositDirect` just before a keeper's claim and `redeemDirect`
  just after, taking a week of everyone's rewards (the claim is a visible transaction and the
  chain ignores priority fees, so the sandwich is cheap). Vesting also removes the v1 "catch-up
  claim distorts one batch's price" problem without putting the claim in the pricing path.
- Unclaimed rewards are never priced in (reading them costs 1.7M gas and the claim can fail).
  With weekly claims at most about a week of yield (~0.1%) is outside the price at any time.
- Moving stake off a hotkey leaves that hotkey's unclaimed rewards owed to it; they are claimed
  later with `claimRewards(oldHotkey)` and vest like any other claim. That is why the hotkey set
  exists.

### Assets and pricing

- `grossAssets() view = rootStakeRao() * RAO + balance - ED_RESERVE` (floored at 0).
- `totalAssets() view = grossAssets() - pendingPayouts - unvestedRewards()` (floored at 0).
- One price per batch: `onBridgeMessage` fixes `A = totalAssets() - credited` (where `credited`
  is `msg.value` rounded down to rao, and the subtraction floors at 0) and `S = totalSupply()`
  once and uses them for every entry, rounded in the vault's favour. `depositDirect` does the
  same with its own `msg.value`.

### State

`guardian`, `keeper`, `pendingPayouts` (TAO owed to batches not yet fully sent),
`mapping(bytes32 key => bool) processed` (every delivered batch, payouts or not — the replay
record), `mapping(bytes32 key => PayoutBatch)`,
`PayoutBatch { uint64 sourceChain; address frontDoor; uint64 batchId; uint64 queuedAt; uint32 cursor; uint32 count; uint32 chunk; uint256 remaining; bytes32 payoutsHash; }`
(the entries themselves are **not stored** — storing 100 entries costs two fresh slots each and
would push a full delivery past the lane's gas ceiling; the keeper resubmits the list from the
`Redeemed` events), per-front-door burn windows `mapping(bytes32 peer => Window { uint64 start; uint256 burned; })`
with `peer = keccak256(sourceChain, sender)`, `mapping(address => bool) directOnly`, front-door
and bridge registries (see "Exit safety"), `primaryBridge`, `maxDailyOutflowBps` (default `2000`),
`minDailyOutflow` (default `100e18`), `maxEntryValue` (default `2_000e18`), `maxMessageValue`
(default `4_000e18`), `minChunk` (default `10`), `payoutDelay` (default `24 hours`), `maxFeeBps`
(default `100`), `maxFeeAbs` (default `0.02e18`), `maxTotalAssets`, `minDirectDeposit`,
`hotkeyDustRao`, hotkey set, vesting fields, `lastClaimAt[hotkey]`, `lastStakeAt`,
`claimGasRequired`, floor fallbacks.

### `onBridgeMessage(sourceChain, sender, message, amount) payable`

Only an enabled bridge (`NotBridge`); `(sourceChain, sender)` must be an active front door
(`UnknownPeer`); `msg.value != amount` → `ValueMismatch`; decodes `BATCH`; `amount != Σ
deposits.amount` → `AmountMismatch`. The batch key is `key = keccak256(sourceChain, sender,
keccak256(message))` — the whole message, not the `batchId`, so an exact replay is rejected
(`DuplicateBatch` if `processed[key]`) but a forged batch carrying an honest front door's future
`batchId` can never block the real one. **Reverts while paused** (`EnforcedPause`): the rail marks
the delivery failed and anyone re-executes it after unpause, so money in flight is held, not
lost, and a pause really stops a rogue peer. Does **no staking and no claiming**. Sets
`processed[key]`. With `A`, `S` fixed:

1. For each deposit: `a = d.amount - d.amount % RAO`; `user == 0` → emit
   `DepositSkipped(key, user, a)` and continue (the TAO stays; price rises); else
   `_mint(user, sharesForDeposit(a, A, S))`; emit `Deposited(key, user, a, shares)`. Zero shares
   (dust) → still fine. No per-entry condition ever reverts the batch.
2. **Burn allowance for this peer.** Reset the peer's window if `block.timestamp >= start + 24
   hours`. `allowance = max(grossAssets() * maxDailyOutflowBps / 10000, minDailyOutflow) -
   burned` (floored at 0; `grossAssets()` here includes the deposits just credited).
3. For each redeem: `s = min(r.amount, balanceOf(user))`; if `s == 0` or `directOnly[user]` →
   emit `RedeemSkipped(key, user, r.amount)` and continue. Clip to the per-entry bound and to
   the remaining allowance: `cap = min(maxEntryValue, allowance)`; `sMax = cap * (S + 1e6) /
   (A + 1)` (rounded down; this is `CascadeMath.sharesForDeposit(cap, A, S)`); `s = min(s,
   sMax)`; `out = assetsForRedeem(s, A, S)` rounded down to rao; if `out == 0` → emit
   `RedeemDeferred(key, user, r.amount)` and continue (nothing burned; the user keeps the shares
   and may request again); `_burn(user, s)`; `allowance -= out`; `burned += out`; `total += out`;
   `hash = keccak256(hash, user, s, out)` (running hash over `Payout` triples in order); emit
   `Redeemed(key, user, s, out)`. A clipped user keeps the rest of their shares.
4. If `total > 0`: `pendingPayouts += total`; store
   `PayoutBatch{sourceChain, sender, batchId, queuedAt = now, cursor 0, count n, chunk 0, remaining total, payoutsHash hash}`;
   emit `PayoutBatchQueued(key, sourceChain, batchId, n, total, price)` (the batch price is in
   the event so the cancel test can compare against it).

Gas: a full `MAX_ENTRIES` + `MAX_ENTRIES` delivery must fit under the lane budget. The plan
includes a test that measures a 100 + 100 delivery (fresh users, cold storage) and asserts it
under `6_500_000` gas, and a 50 + 50 delivery under `3_500_000`; the operator limits default to
50 + 50 and may be raised to 100 only if the fork measurement confirms the number.

### `processPayouts(bytes32 key, Payout[] calldata payouts, uint32 maxEntries)`

Permissionless, `whenNotPaused`, `nonReentrant`. `payouts` must be the batch's full ordered list:
its running hash must equal `payoutsHash` and its length `count` (`PayoutsMismatch`); `cursor <
count` (`NotPending`); `block.timestamp >= queuedAt + payoutDelay` (`PayoutDelayed`); the batch's
front door must still be active (`FrontDoorInactive`) — so a guardian's `removeFrontDoor` holds
that peer's queued payouts at once, with no vault-wide pause, until the owner cancels the batch
or the front door is re-activated. There is no outflow window here: everything queued already
passed the per-peer burn allowance at delivery.

1. **Select a chunk.** Starting at `cursor`, take entries in order while `sum + assets_i <=
   maxMessageValue` and `taken < maxEntries`, **always taking at least the first remaining
   entry** (the vault cannot see queued entries when `maxMessageValue` is lowered; if the lane
   then rejects an oversized message the send reverts and the owner cancels that batch).
   `maxEntries < minChunk` is treated as `minChunk` unless fewer entries remain, so a caller
   cannot make every user pay a whole message fee by sending one-entry chunks.
2. **Fee.** Quote on a message of the same shape as the one that will be sent (same entry count,
   gross amounts; byte length is identical): `fee = primaryBridge.quoteFee(sourceChain, frontDoor,
   encodePayouts(key, chunk, chunkEntries), sum)`. **Ceiling:** `fee > max(sum * maxFeeBps /
   10000, maxFeeAbs)` → revert `FeeTooHigh` (the batch waits for fees to fall; the quote depends
   on Chainlink's price feeds, Base gas and ForeverMoney's gateway, and without a ceiling a fee
   spike would let anyone make users pay most of their payout as fee). Deduct pro-rata in TAO:
   `net_i = assets_i - assets_i * fee / sum`, rounded against the user and down to rao; `net = Σ
   net_i`. **Dust tail:** only if `sum <= fee` (which the ceiling bounds to `sum <= maxFeeAbs`,
   about one normal message fee) pay nothing, emit `PayoutDust(key, user, assets)` per entry, and
   complete the chunk so the batch can finish; an individual `net_i == 0` is likewise
   `PayoutDust`. Dust stays in the vault and raises the price.
3. **Liquidity.** `available = balance - ED_RESERVE - (pendingPayouts - batch.remaining)`,
   **floored at 0** (with several batches queued against a fully staked vault — the normal
   state — the raw difference is negative, and an unfloored subtraction would freeze every
   payout); if `available < net + fee` call `_unstake(net + fee - available)` (a precompile
   revert bubbles up; retry). Each chunk unstakes only what it needs; other batches'
   reservations stay staked until their turn.
4. **Effects first.** `cursor += taken`, `chunk += 1`, `remaining -= sum`, `pendingPayouts -=
   sum`. If `cursor == count` delete the batch (keep `processed[key]`).
5. **Send.** `primaryBridge.send{value: net + fee}(sourceChain, frontDoor, encodePayouts(key, chunk-1, netEntries), net)`
   — exactly `net + fee`, never `sum`; the rounding difference `sum - net - fee` stays in the
   vault; the adapter keeps any fee excess and never refunds. Emit
   `PayoutChunkSent(key, chunk-1, taken, sum, net, fee)`. Skip the send entirely when `net == 0`.

No `stakeIdle()` here; the keeper calls it separately.

### `cancelPayoutBatch(bytes32 key, Payout[] calldata payouts)`

Owner only (timelocked), works while paused and when the front door is removed, `nonReentrant`.
Verifies the list against `payoutsHash` and `count`. For every entry from `cursor` to the end:
`_mint(user, shares)` (exact, because the batch's price was fixed), emit
`RedeemReversed(key, user, shares, assets)`. `pendingPayouts -= remaining`; delete the batch.
The peer's `burned` is not restored. This is how a batch from a rogue or dead front door is
undone: the users get their shares back instead of their TAO being paid to an address that
should not have it, or sitting in `pendingPayouts` forever. Chunks already sent stay sent. A
cancel lowers the share price slightly (the reserved TAO kept earning for the remaining holders
while it waited, and the same shares now come back); that is the fair outcome and the invariant
suite treats it as such.

### Direct access (Bittensor-native users; escape hatch for EOAs)

- `depositDirect() payable` — `whenNotPaused`, `nonReentrant`; `msg.value % RAO != 0` →
  `NotRaoAligned`; `msg.value < minDirectDeposit` → `BelowMinDeposit`; with `A = totalAssets() -
  msg.value`: `A + msg.value > maxTotalAssets` → `CapExceeded`; **always** sets
  `directOnly[msg.sender] = true` (setting it only on a first deposit would let a Base-side party
  deposit first and then redeem the Bittensor party's later deposits); mints
  `sharesForDeposit(msg.value, A, S)` to `msg.sender`; emits `DepositedDirect`. No staking inline.
- `allowFrontDoorRedeems()` — clears `directOnly[msg.sender]`; emits `FrontDoorRedeemsAllowed`.
  A Bittensor-native depositor must opt in (again after every direct deposit) before a front door
  may redeem for their address, because the same address on Base may belong to someone else (a
  contract deployed with `CREATE` on Bittensor, for example). Front-door depositors are opted in
  by construction: their shares exist only because that address acted on Base.
- `redeemDirect(uint256 shares)` — `whenNotPaused`, `nonReentrant`; `ZeroAmount`; `out =
  assetsForRedeem(shares, totalAssets(), totalSupply())` rounded down to rao; burn; `available
  = balance - ED_RESERVE - pendingPayouts` floored at 0; if `available < out` unstake the
  shortfall with `_unstake`; send `out` to
  `msg.sender` with `call` (`TransferFailed`); emits `RedeemedDirect`. **No outflow cap**: a
  direct redeem is authorised by the share owner's own signature on this chain, so it is not a
  drain vector, and sharing a window with front doors would let anyone starve the bridged queue
  for free by looping `depositDirect`/`redeemDirect`. Root unstaking is 1:1 and fee-free, so a
  large direct exit cannot hurt remaining holders.
- Who can really use it: Bittensor-native users and EOAs that hold TAO for gas on chain 964. No
  Coinbase Smart Wallet factory, faucet or gas sponsorship was found on chain 964, so smart-wallet
  users on Base rely on the front door for exits. The README says so; a user-registered
  Bittensor recovery address is the v2.1 answer.

### Admin

Owner: front-door and bridge registries (`proposeFrontDoor` / `activateFrontDoor` /
`removeFrontDoor`, `proposeBridge` / `activateBridge` / `disableBridge`, `cancelProposal`),
`setPrimaryBridge` (must be an enabled bridge; disabling the primary halts payouts until a new
primary is set — payouts wait, nothing is lost), `setGuardian`, `setKeeper`, `addHotkey`,
`setStakeHotkey`, `moveStake`, `removeHotkey`, `cancelPayoutBatch`, `setMinDirectDeposit`, `setMaxTotalAssets`,
`setOutflowLimits(maxDailyOutflowBps <= 10000, minDailyOutflow)`, `setMessageLimits(maxEntryValue,
maxMessageValue, minChunk)` (`maxEntryValue <= maxMessageValue`, `1 <= minChunk <= MAX_ENTRIES`),
`setFeeLimits(maxFeeBps <= 10000, maxFeeAbs)`, `setPayoutDelay` (`<= 7 days`),
`setClaimGasRequired`, `setHotkeyDustRao`, `setFloorFallbacks(minStakeRao, minRemainRao)`
(`1 <= a <= b <= 1e9`), `pause`/`unpause`.
Guardian: `pause`, `cancelProposal`, `disableBridge`, `removeFrontDoor`.
Value leaves the vault only via `primaryBridge.send` in `processPayouts` and `redeemDirect` to
`msg.sender`.

### Exit safety: what a compromised registry, bridge or front door can do

A front door speaks for its users: a `BATCH` from it burns the named users' shares and the TAO is
owed to **that front door**. So anyone who gets an address registered as a front door, or who
controls an enabled adapter, could submit redeem-only batches naming every holder. The owner's
timelock is not enough on its own (anti-goal: "no path where the team's keys can move user
funds"). The vault bounds this in four layers:

1. **Registry changes are slow, visible and vetoable.** `proposeFrontDoor(chain, addr)` /
   `proposeBridge(addr)` emit an event and start `REGISTRY_DELAY = 7 days`; `activate*` only
   succeeds after it. `cancelProposal` (owner or guardian) stops a pending proposal at once.
   `removeFrontDoor` / `disableBridge` (owner or guardian) take effect at once; they can only stop
   flows, which is the same argument that gives the guardian its cancel power. Registries are
   sets, so an old and a new peer can both be live during a migration. Adapters are immutable, so
   nothing behind the registry can change without going through it.
2. **Burns are capped per peer at delivery.** Each front door may burn at most
   `max(20% of gross assets, minDailyOutflow)` per fixed 24-hour window; redeems beyond that are
   deferred (the user keeps the shares). A rogue peer therefore takes at most one day's allowance
   per window, and only its own allowance — direct redeems and other front doors have none to
   share. Because any enabled adapter can present any registered front door, a rogue *adapter*
   can use every registered front door's allowance (two during a migration, more if Robinhood
   Chain is added); a cap across all front doors would let one front door's honest exits block
   another's users, so it is not added.
3. **Payouts wait, and stop the moment a peer is removed.** Nothing burned can leave for
   `payoutDelay` (default 24 hours), and `processPayouts` refuses batches whose front door is no
   longer active. Within the delay the guardian removes the peer (or disables the adapter), which
   holds its queued payouts at once with no vault-wide pause; the owner then cancels the batch
   after the timelock, which gives every affected user their shares back. If the guardian acts
   within the delay, a rogue peer steals nothing. If nobody acts, the loss is bounded by layer 2.
4. **Pause holds everything that moves value.** Guardian/owner pause blocks `onBridgeMessage`
   (re-executed later), `processPayouts`, `stakeIdle`, `depositDirect`, `redeemDirect`, and on the
   front door `deposit`, `depositFor`, `requestRedeem`, `closeBatch`. It never blocks
   `cancelDeposit`, `cancelRedeem`, `claim`, `claimRewards`, `cancelPayoutBatch`, or the front
   door's incoming `PAYOUTS` (tokens already there; crediting is harmless).

Other properties:

- **A forged `BATCH` needs a registered peer.** Deposits need real native value. Redeems can only
  burn shares the named user holds, within the peer's allowance, and only for users who are not
  `directOnly`. A forged batch cannot block an honest one (message-hash keys).
- Donations cannot freeze anything: no bounds, no flags; unexpected TAO only raises the price.
- Honest statement for the README: *the team cannot move user funds instantly; any new front door
  or bridge is announced on-chain seven days ahead and the guardian can veto it; a compromised
  front door can burn at most about 20% of the vault per day in redemptions (per registered front
  door, and never less than 100 TAO a day), nothing it burned can be paid out for 24 hours, the
  guardian can hold those payouts at once, and the owner can then cancel the batch and return the
  shares. Outside the contract, ForeverMoney's signers, Chainlink's lane configuration and
  Bittensor's sudo key can stop or change the rails with no delay.*

### Lost messages

Tokens and data travel together in one adapter delivery. If delivery reverts (gas, a transient
precompile error, the vault paused) the adapter's manual re-execution path is the retry; the
vault and front doors are written so that re-delivery is safe (`DuplicateBatch` /
`DuplicatePayouts` only after success). The pre-mainnet checklist must confirm that manual
re-execution never expires on these lanes. If the rail itself loses a message, the funds in it
are the rail's loss; v2 has no in-contract recovery and no in-flight lock, so other users are
unaffected.

### Addresses and wallets

Shares are credited to the depositor's address as seen on Base. Because csTAO is non-transferable,
every share balance was created either by a front door (the address acted on Base) or by
`depositDirect` (the address acted on Bittensor, and is `directOnly` until it opts in). That
closes both directions of the same-address problem: a Base party cannot redeem a Bittensor
depositor's shares, and a Bittensor party cannot receive shares it did not deposit for. What
remains: legacy nonce-based (`CREATE`) contract wallets on Base, where a different party could
hold the same address on Bittensor and `redeemDirect` — the app must refuse those; and smart
wallets whose factory is absent on chain 964, whose only exit is the front door. Both in the
README.

## CascadeFrontDoor (Base; one deployment per supported chain)

Constructor `(IERC20Metadata asset, ICascadeBridge bridge, uint64 vaultChain, address vault, address owner, address guardian, uint64 batchInterval, uint256 minDeposit, uint256 depositCap, uint256 redeemRequestFee)`.
`asset`, `vaultChain` and `vault` are immutable (a new vault means new front doors; a mutable
vault peer would reject in-flight payouts with `UnknownPeer`). `asset` must have 18 decimals.

State: open batch `{ uint64 id; uint64 start; Entry[] deposits; Entry[] redeems; uint256 totalDeposits; uint256 feePot; }`
with **one merged entry per user per list** (`depositIndex[batchId][user]`, `redeemIndex[...]`;
an entry cancelled down to zero is removed and its slot freed, so a deposit-and-cancel loop cannot
fill the list for free), `mapping(address => uint256) claimable`, `uint256 totalClaimable`,
`uint256 depositCap` (owner-set soft TVL limit for this chain — in the beta it follows Base TAO
liquidity, about $450k total depth, not the contract's own limits), `uint256 netForwarded`
(forwarded deposits minus payouts received, floored at 0),
`mapping(bytes32 batchKey => mapping(uint32 chunk => bool)) delivered`,
`mapping(address => uint256) feeCredit` (pre-paid redeem-request fees, see below), `primaryBridge`.
Operator limits: `maxDeposits` and `maxRedeems` entries per batch (owner-set `setBatchLimits`,
each `1..MAX_ENTRIES`, default `50`), `maxBatchValue` (owner-set, default `4_000e18`, below the
lane's 5,000-TAO message cap), `redeemRequestFee` (owner-set, in ETH, default `1e14` wei ≈ $0.30).

**Junk redeem requests.** `requestRedeem` needs no shares (the front door cannot see balances on
Bittensor), so without a cost per slot anyone with 50 throwaway contracts could fill every
batch's redeem list for cents and block honest exits — and smart-wallet users have no other exit.
The answer has three parts: (1) the first redeem request per user per batch costs
`redeemRequestFee` in ETH, paid into the batch's `feePot` either as `msg.value` or from the
user's `feeCredit` — anyone may pre-pay credit for any user with `creditRedeemFee(address user)
payable`, which is how the app sponsors users whose passkey wallets hold no ETH (a gas paymaster
cannot supply `msg.value`), and nobody can spend another user's credit; (2) a batch whose redeem
list is full may be closed at once by anyone, and closing spends the pot on the bridge fee first
and pays any remainder to the closer, so a junk-filled batch pays for its own forwarding and the
griefer loses more than the keeper; (3) `requestRedeem` itself closes the open batch when the
redeem list is full and the caller has no entry (same rules as `closeBatch`: pot first,
`InsufficientFee` if short, remainder to the caller), then places the request in the new batch —
one call that works for every wallet in every state, so blocking is impossible, only a one-fee
tax under attack. A refundable bond would not work (the front door never learns which requests
were empty); reporting empties back from the vault would cost an extra message per batch.

- `deposit(uint256 amount)` = `depositFor(msg.sender, amount)`.
- `depositFor(address user, uint256 amount)` — `whenNotPaused`, `nonReentrant`; `user == 0` →
  `ZeroAddress`; `amount % RAO != 0` → `NotRaoAligned`; `amount < minDeposit` → `BelowMinDeposit`;
  `netForwarded + open.totalDeposits + amount > depositCap` → `CapExceeded`;
  `open.totalDeposits + amount > maxBatchValue` → `BatchValueFull` (the deposit waits for the
  next batch; a batch within `minDeposit` of full may be closed early by anyone);
  deposit list full and `user` has no entry → `BatchFull`; pulls `amount` from `msg.sender`;
  adds to `user`'s entry; emits `DepositRequested(batchId, user, amount, msg.sender)`.
  `depositFor` exists for one-signature "zap" contracts (approve + swap + deposit); it can only
  give shares to the named user, so it does not weaken the same-address rule.
- `cancelDeposit(uint256 amount)` — open batch only, works while paused; `amount % RAO != 0` →
  `NotRaoAligned` (so a cancel can never leave a misaligned total); reduces the caller's own
  entry (`InsufficientRequest`), freeing the slot at zero; returns tokens to the caller; emits
  `DepositCancelled`.
- `creditRedeemFee(address user) payable` — anyone; `feeCredit[user] += msg.value`; emits
  `FeeCredited`. Credit is only ever spent on that user's own requests; it is not withdrawable.
- `requestRedeem(uint256 shares) payable` — `whenNotPaused`, `nonReentrant`; `ZeroAmount`. If
  the caller already has an entry in the open batch: `msg.value` must be 0, add to the entry.
  Otherwise: if the redeem list is full, close the batch first (exactly as `closeBatch` does,
  with `msg.value` excluded from the budget — the pot pays, `InsufficientFee` if it cannot, any
  remainder to the caller), then take the fee: `msg.value == redeemRequestFee` → `feePot +=
  msg.value`; else `msg.value == 0` and `feeCredit[caller] >= redeemRequestFee` → move it to
  `feePot`; else `WrongFee`. Adds to the caller's entry (the vault clips to what the user holds,
  to `maxEntryValue` and to the peer's daily allowance); emits `RedeemRequested`.
  `cancelRedeem(uint256 shares)` mirrors `cancelDeposit` (no alignment rule: shares; the fee is
  not refunded; the slot is freed at zero).
- `closeBatch() payable` — permissionless, `whenNotPaused`, `nonReentrant`. Allowed when
  `block.timestamp >= start + batchInterval` OR either list is at its limit OR
  `maxBatchValue - totalDeposits < minDeposit` (full by value); empty batch → restart the timer,
  refund `msg.value`, emit `BatchRolled`. Otherwise: effects first (open the next batch,
  `netForwarded += totalDeposits`), `fee = primaryBridge.quoteFee(vaultChain, vault, msg_,
  totalDeposits)`; `budget = feePot + msg.value`; `budget < fee` → `InsufficientFee`;
  `asset.forceApprove(primaryBridge, totalDeposits)`, `primaryBridge.send{value: fee}(...)`,
  `forceApprove(primaryBridge, 0)`; pay `budget - fee` to `msg.sender` (the caller's own excess
  plus any pot remainder); emit `BatchClosed(id, totalDeposits, deposits.length, redeems.length,
  fee, potUsed)`. No in-flight lock. Default
  `batchInterval` for the beta: `12 hours` (bridged TAO earns nothing while it waits, and a batch
  costs dollars, not tens of dollars).
- `onBridgeMessage(sourceChain, sender, message, amount)` — only an enabled bridge;
  `(sourceChain, sender) != (vaultChain, vault)` → `UnknownPeer`; `msg.value != 0` →
  `ValueMismatch`; decodes `PAYOUTS`; `Σ payouts != amount` → `AmountMismatch`;
  `asset.balanceOf(this) < open.totalDeposits + totalClaimable + amount` → `TokensNotReceived`;
  `delivered[batchKey][chunk]` → `DuplicatePayouts`. Credits `claimable[user] += amount` per
  entry, `totalClaimable += amount`, `netForwarded -= min(netForwarded, amount)`; emits
  `PayoutReceived(batchKey, chunk, user, amount)`. Works while paused.
- `claim()` — `nonReentrant`, works while paused; `NothingToClaim`; zero first, then transfer;
  emits `Claimed`.
- Invariant: `asset.balanceOf(this) >= open.totalDeposits + totalClaimable` (`>=`, because
  donations and tokens that land ahead of their data message are allowed); ETH held `==` the open
  batch's `feePot + Σ feeCredit`.
- Admin: `setCaps(minDeposit, depositCap)`, `setBatchLimits(maxDeposits, maxRedeems)`,
  `setMaxBatchValue`, `setBatchInterval`, `setRedeemRequestFee`, bridge set with the same
  propose/activate/cancel/disable pattern as the vault (guardian may cancel and disable) plus
  `setPrimaryBridge` (owner; must be enabled) — batches are sent through `primaryBridge`,
  incoming `PAYOUTS` are accepted from any enabled bridge, and disabling the primary stops
  closes (deposits can still be cancelled) until a new primary is set; `setGuardian`,
  `pause`/`unpause`.

## Keepers and fees

Routine calls and who makes them:

| Call | Who | Fallback |
|---|---|---|
| `closeBatch` (Base) | anyone; keeper in practice | — |
| `processPayouts` (Bittensor) | anyone; keeper in practice | — |
| `stakeIdle` | keeper | anyone after 7 days idle |
| `claimRewards(hotkey)` | keeper | anyone after 7 days since that hotkey's last claim |
| CCIP re-execution | anyone | — |

- **Deposit leg (Base → Bittensor):** bridge fee in ETH, paid from the batch's redeem-request pot
  first and then by the caller of `closeBatch`, excess to the caller; an operator cost (about
  $1.5–11 per batch depending on size and gas bought) when there are no redeem requests.
- **Payout leg (Bittensor → Base):** bridge fee in native TAO, deducted from the chunk pro-rata
  under the fee ceiling. The caller only fronts gas (about $1.4–4 per `processPayouts` at the
  chain's 5-gwei floor).
- **Hosted keeper services are gone** (Chainlink Automation sunset July 2026, Gelato Web3
  Functions March 2026, OpenZeppelin Defender July 2026; Chainlink CRE serves Base but not
  Bittensor). The keeper is a self-hosted bot with keys in OpenZeppelin Relayer or a cloud KMS,
  running on both chains against an archive/paid RPC (the public lite RPC drops state after
  ~300 blocks and rate-limits). Its jobs: close batches (after checking the pool's rate-limit
  allowance and sizing delivery gas to the entry count), re-execute failed deliveries, run
  `processPayouts` after the delay with the list rebuilt from `Redeemed` events, `stakeIdle` on a
  schedule, `claimRewards` weekly after an off-chain `eth_call` pre-check (expected delta, no
  `RootClaimTooHeavy`), check `getPrecompileStatus` for the staking precompile, and run the
  contract's precompile calls against each Bittensor pre-release on testnet 945. The bot is a
  separate deliverable; this build only guarantees that every call it makes is permissionless or
  role-gated as in the table.
- A stolen keeper key can time claims and stakes badly and nothing else; every money-moving
  function is permissionless or owner-only.

## Test doubles

- `MockStaking` v2 (at the precompile address via `vm.etch`): `getDefaultMinStake()` /
  `getNominatorMinRequiredStake()` (settable, defaults `2_000_000` / `20_000_000`);
  `removeStake` clips an over-request to a full exit, enforces `AmountTooLow` on partial unstakes
  below the min, and sweeps a remainder below the nominator min to the balance;
  `removeStakeFull`; `moveStake` root→root; a fresh position reads one rao short (`setOneRaoShort(bool)`,
  default on); `claimRootWithHotkey` requires `gasleft() >= claimGasRequired` (settable, default
  `53_200_000`) and models a dispatch failure by consuming all gas (`invalid()`);
  `setClaimTooHeavy(bool)` makes claims fail the same way; `setUnclaimed(hotkey, rao)` so a claim
  adds stake and `getUnclaimedRootTaoByHotkey` reads it; `setRejectStakingHotkeyGrowth`;
  `mirror(a) = keccak256("evm:" ++ a)` shared with `MockAddressMapping` (etched at `0x…080c`),
  so the vault's derived coldkey matches what the mock credits.
- `MockTAO` (unchanged).
- `MockBridge` v2: chain-aware (`connect(chain, contract_, native)`), routes `send` to the
  receiver on `destChain` with `(sourceChain, sender)`; native delivery to the vault, ERC-20 to
  the front door; FIFO; `setAutoDeliver`, `deliverNext`, `pendingCount`; `failNext()`;
  enforces the fee rule ("budget at least the fee, excess kept, never refunded" —
  `InsufficientFee` otherwise), `maxMessageValue` (default `5_000e18`, `RateLimited`) and
  delivers with an explicit gas cap `deliveryGas` (default `7_000_000`) so a gas regression shows
  up as a failed delivery; a failed delivery stays queued for re-delivery (`retryNext`); a
  settable `fee` so fee-spike tests can exceed the ceiling.
- `StubBridge` v2 for unit tests (records the last send; same fee rule).

## Tests the plan must include (minimum)

Unit, vault: constructor derives and cross-checks the coldkey; non-transferable shares; batch
handling (one batch price; deposits rounded to rao; zero-address deposit skipped; redeems clipped
to balance, `maxEntryValue` and the peer allowance; `directOnly` skipped; deferred redeems keep
shares; running hash; message-hash keys: an exact replay is rejected, a forged batch with the
same `batchId` does not block the real one; deposit-only batches are recorded; wrong peer;
value/amount mismatch; `pendingPayouts` accounting; no staking inside delivery; reverts while
paused and re-delivers after); `processPayouts` (hash check; delay; `FrontDoorInactive` after a
guardian removal, then cancel; chunking by message cap, `maxEntries` and `minChunk`; oversized
first entry still taken; fee ceiling reverts on a spike and no burned value is lost; fee pro-rata,
true dust tail completes the batch; exact `net + fee` sent and the adapter keeps excess; unstake
across several hotkeys; full-exit and sweep paths; retry after a precompile revert; batch deleted
when done); `cancelPayoutBatch` (re-mints exactly; after partial chunks; owner only; works paused
and with the front door removed; price after cancel ≥ price at that batch's delivery);
two redeem batches queued against a fully staked vault both pay out, in either order;
`stakeIdle` (threshold, `ED_RESERVE`, floored idle, keeper vs fallback, paused); rewards (keeper
vs per-hotkey fallback; `InsufficientGas` before the call; gas-burning failure leaves state
untouched; zero delta succeeds; vesting curve; sandwich attempt yields nothing); hotkey set
(`addHotkey`, set/move/remove rules incl. dust threshold, `forfeit`, leftover stake below and
above the minimum; `rootStakeRao` sums); direct
deposit/redeem (caps, `directOnly` set on every deposit and cleared by opt-in, a front-door
deposit then a direct deposit then a front-door redeem is skipped, pricing excludes own
`msg.value`); registries (delay, activate, cancel/disable/remove by guardian, primary must be
enabled); pause scope; `receive()` guard.
Unit, front door: deposit/depositFor/cancel (alignment, slot freed at zero)/redeem (fee on first
entry only, paid by value or by credit, `WrongFee`, credit not spendable by others)/cancel/close
(interval, list limits, full by value within `minDeposit`, pot spent first, remainder to the
closer, through `primaryBridge` only), roll, payout credit per `(batchKey, chunk)` from any
enabled bridge, duplicate chunk, `TokensNotReceived`, claim, caps, peer checks; in a junk-filled
batch a single `requestRedeem` from a plain wallet closes it and lands in the next batch.
Gas: 100 + 100 delivery under `6_500_000`; 50 + 50 under `3_500_000`; vault bytecode under
`24_576` bytes (`forge build --sizes`).
End to end: one vault, one front door, through `MockBridge`: deposit → batch → shares → claim
rewards → vest → redeem → delay → chunked payouts → claim on Base; a second front door on
another chain id with its own allowance; a rogue front door scenario (burn capped, guardian
removal holds payouts without a pause, owner cancels, shares restored).
Invariants: csTAO price never decreases beyond one rao of tolerance except across a
`cancelPayoutBatch` (where it must stay ≥ that batch's delivery price); `grossAssets`
conservation; `pendingPayouts == Σ remaining of open payout batches`; per-peer burned in any
fixed window ≤ its allowance; front-door balance identity (`>=`) and ETH identity; claims never
exceed delivered payouts; no unexpected reverts; reachability logged.

## Decisions taken by the author (not the user's)

1. Fees: deposit-leg bridge fee is an operator cost net of the redeem-request pot; payout-leg
   fee is deducted pro-rata in TAO under a ceiling (`maxFeeBps` 1%, `maxFeeAbs` 0.02 TAO);
   rounding dust stays in the vault.
2. Lost messages: no in-contract recovery (adapter manual re-execution); registries are sets;
   adapters are immutable and never refund; the front door's vault peer is immutable; batch keys
   are message hashes.
3. Same-address rule kept and made sound by non-transferable shares plus `directOnly` on every
   direct deposit; app guards legacy `CREATE` contract wallets; recovery address → v2.1.
4. Batch griefing: merged per-user entries, slots freed at zero, separate deposit/redeem limits,
   close-when-full (including full by value), `minChunk`, `requestRedeem` closes a full batch
   itself, pre-paid fee credits so sponsored wallets can request.
5. Caps: `netForwarded` nets off payouts; vault-wide `maxTotalAssets` for direct deposits;
   `depositCap` on Base follows DEX liquidity.
6. Direct access kept, uncapped, with the honest note about who can use it.
7. Adapters and the keeper bot are separate deliverables; the vault's native-value interface and
   the role table are the contracts they honour.
8. Rewards: keeper role with 7-day permissionless fallback per hotkey, `gasleft()` guard, 7-day
   linear vesting; `stakeIdle` under the same role for the root-hold reason.
9. Payout lists stored as a running hash over `(user, shares, assets)`; chunked; always at least
   one entry per chunk; cancellable with exact re-mint; held at once when the front door is
   removed.
10. Exit safety at delivery time: per-peer burn allowance `max(20% of gross, minDailyOutflow)`
    per fixed 24-hour window, `payoutDelay` 24 hours, guardian stop powers; no cap across front
    doors.
11. Operator defaults: 50 + 50 entries, 4,000 TAO per batch, 2,000 TAO per payout entry,
    `minChunk` 10, 12-hour batch interval, 100 TAO `minDailyOutflow`, 7-day registry delay,
    48-hour owner timelock, `hotkeyDustRao` 0.001 TAO.
12. Floors read live with owner-set fallbacks; `ED_RESERVE` of 1,000 rao; code-size fallback
    agreed in advance.

## Open questions for the user

1. **ForeverMoney.** The inbound adapter needs a function on their Bittensor contracts that a
   third-party contract can call to turn their token into native TAO. Reaching out to them is an
   outward-facing step the user takes (a draft message can be provided). The contracts build does
   not wait for the answer; the adapter spec does.
2. **Exit safety:** 7-day registry delay with guardian veto; each front door may burn at most
   20% of the vault per day in redemptions (never less than 100 TAO); payouts wait 24 hours and
   stop at once if the guardian removes the front door; a rogue batch can be cancelled with the
   shares returned. The visible cost to honest users is that a withdrawal takes about two days
   end to end (batch, delay, bridge). Accept?
3. **Non-transferable shares** in v2 (csTAO cannot be sent between wallets; this is what makes the
   same-address model safe). Accept?
4. **Anti-spam fee on withdrawal requests:** about $0.30 in ETH per request on Base. It pays the
   batch's bridge fee; any excess goes to whoever forwards the batch, usually Cascade's own
   keeper. The app can pre-pay it for users whose wallets hold no ETH. Without it, anyone could
   block all withdrawals for cents. Accept?
5. **Reward vesting** over 7 days (share price rises smoothly instead of jumping at each weekly
   claim). Accept?
6. **Launch scope:** Base only, beta `depositCap` sized to Base TAO liquidity (about $250k);
   Robinhood Chain as a possible second front door later; Ethereum/BNB/Polygon users bridge USDC
   to Base in the app. Accept?

## Findings carried from the v1 final review

| v1 finding | How v2 handles it |
|---|---|
| Cheap flag-and-freeze griefing via a substrate donation (Important 1) | No bounds/flags; a donation only raises the price |
| Catch-up reward claims flag honest epochs; last redeemers lose unclaimed rewards (Important 2) | Separate keeper-timed claim with vesting; nothing is flagged; rewards claimed later still land on the earning hotkey |
| `setBridge` during an in-flight epoch bricks it (Important 3) | adapter set + primary; no in-flight lock; immutable adapters |
| `MIN_STAKE_RAO` constant mirrors a tunable chain parameter (Important 4) | floors read live from the precompile with owner-set fallbacks |
| Vault trusts that bridged tokens arrived (minor) | front door `TokensNotReceived`; vault `msg.value == amount` |
| Pre-mainnet checklist (12 items) | copy into `docs/architecture.md`; add: fork measurement of delivery gas, `try/catch` behaviour of a view read on the live runtime, ForeverMoney conversion interface, CCIP 2.0 lane migration status, CCIP manual re-execution never expiring, CCIP fee independence from token amount on these lanes |

## Migration from v1

`StakeEngine.sol` is folded into the new `CascadeVault.sol` (staking, shortfall and hotkey logic
carry over where they match this spec; the inline claim does not). v1's Base `CascadeVault.sol`
and its settlement tests are removed; `CascadeMath`, `IStaking` (extended with
`removeStakeFull`, `getDefaultMinStake`, `getNominatorMinRequiredStake`), `MockTAO` stay;
`MockStaking` is extended as above; `IAddressMapping` and `MockAddressMapping` are new.
