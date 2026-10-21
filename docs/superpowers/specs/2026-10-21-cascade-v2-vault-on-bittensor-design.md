# Cascade contracts v2 — vault on Bittensor, front door on Base — design spec

Revision 2 (2026-10-21), after the v2 research (`reports/Cascade v2 Bittensor vault rails.md`).
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

Revision 2 changes nothing in that intent. It corrects the places where revision 1 assumed an
ordinary EVM chain and a generic bridge. The research established that:

- Chainlink CCIP is the only rail that moves TAO between Base and Bittensor EVM, and what it
  delivers on Bittensor is ForeverMoney's ERC-20 claim token, not native TAO. Only ForeverMoney's
  contracts convert it. **The conversion lives in a replaceable adapter, outside the vault.**
- Claiming root rewards needs a ~53M-gas allowance and can be refused by the chain. **Claims are
  a separate keeper call, never part of pricing or delivery.**
- A CCIP delivery on Bittensor gets about 7.2M gas, one message carries at most 5,000 TAO, and
  storage is the cost that matters. **Batches are smaller and payout lists are stored as hashes.**
- TAO balances are kept in rao (1e9 wei); sub-minimum stake remainders are swept; the coldkey
  can be derived on-chain. **Amounts are rao-aligned, floors are read live, balance deltas are
  measured.**
- Only Base and Robinhood Chain have a bridgeable TAO token. **Ethereum, BNB and Polygon front
  doors are dropped; those users bridge USDC to Base in the app.**

## Goals / non-goals / anti-goals

- Goals: simplest possible money logic; no trusted operator in the loop; one vault, any number of
  front doors; a user's shares survive the front door disappearing (direct access for EOAs); the
  parts that depend on outside parties (bridge, ForeverMoney) are isolated in adapters that can be
  replaced without touching the vault.
- Non-goals (this build): production bridge adapters (a separate spec once ForeverMoney's
  contract interface is known — see "Adapters"), deployment scripts, fees to users, USDC
  conversion (the app swaps USDC↔TAO on Base around deposit/claim), a wrapped csTAO on Base,
  subnet staking, a user-registered recovery address on Bittensor (v2.1).
- Anti-goals: any path where the team's keys can move user funds; any contract that must trust a
  reported balance; any single lost message that blocks other users; any routine action that
  needs more gas than a bridge delivery can buy.

## Global rules

- Solidity `0.8.24`, EVM `cancun`, OpenZeppelin `v5.4.0`. No proxies, no `delegatecall`, no
  arbitrary external calls. Custom errors; an event per state change. `renounceOwnership`
  reverts `RenounceDisabled()`. The vault must stay under the 24,576-byte code limit (ForeverMoney's
  comparable contract is 19,129 bytes); the plan includes a `forge build --sizes` check.
- Admin = `Ownable2Step` owner (timelock + Safe in production). Guardian may only `pause()` and
  `cancelProposal()`. Owner may `pause()`/`unpause()`. Routine actions are permissionless.
- Share math via `CascadeMath` (unchanged): `sharesForDeposit`, `assetsForRedeem`, `price`,
  virtual offset `1e6`, all rounded down. Shares have 24 decimals.
- Units: TAO amounts in contracts are 18-decimal wei; the precompile takes rao (`RAO = 1e9` wei).
  **Every amount that crosses into the vault must be a whole number of rao** (`amount % RAO == 0`,
  else `NotRaoAligned`), because the chain truncates transfers to rao. Every amount the vault
  pays out is rounded down to rao. Front doors hold bridged TAO as an 18-decimal ERC-20
  (`UnsupportedDecimals` otherwise) and enforce rao alignment at deposit.
- Users are identified by their EVM address, which is the same on every EVM chain. A front door
  forwards `msg.sender` (or the named user of `depositFor`, deposits only); the vault never takes
  a user address from anyone but a registered front door.
- Registries (front doors, bridge adapters) are sets with a propose/activate delay — see "Exit
  safety".
- Precompiles are constants: `STAKING = 0x0000000000000000000000000000000000000805` (staking
  precompile v2), `ADDRESS_MAPPING = 0x000000000000000000000000000000000000080c`. Tests
  `vm.etch` mocks at those addresses (as v1 does).
- **Measure, never assume.** Around every precompile call that moves value the vault records the
  balance and stake before and after and emits what actually happened. Precompile dispatch
  failures surface as low-level errors with no return data and consume all forwarded gas, so the
  vault never wraps a precompile write in `try/catch`; it lets the revert bubble up and the caller
  retries.

## Bridge interface v2 (chain-aware) — unchanged

```solidity
interface ICascadeBridge {
    /// ERC-20 side: pulls `amount` tokens from msg.sender (approve first); msg.value == fee.
    /// Native side: msg.value == amount + fee.
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
18 decimals, no permit).

## Adapters (out of this build; the contract they must honour)

The vault and front door never see CCIP or ForeverMoney. A **Bittensor adapter** sits between
CCIP and the vault, and a **Base adapter** between CCIP and the front door. They are the parts
designed to be replaced, because every outside change (ForeverMoney's token, Chainlink's lane,
a Bittensor runtime upgrade) lands there. Their obligations:

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
  there, then anyone re-executes it).
- Limits the adapter must enforce before sending, because the lane will otherwise fail the
  message: ≤ 5,000 TAO per message (ForeverMoney pool rate limit, 0.6 TAO/s refill, shared with
  every ForeverMoney user), ≤ 32,000 bytes of data, and a delivery gas budget ≤ ~7.2M on Bittensor
  / ~13M on Base. The contracts below keep every message under those limits by construction, so
  an adapter only has to pass them through.
- Adapter admin is ForeverMoney-facing and outside the vault's trust model. The README must say
  plainly that ForeverMoney's 2-of-3 Safe (token pools, rate limits), Chainlink's lane
  configuration and Bittensor's sudo key can each stop or change the rails with no delay.

**Blocking dependency:** the inbound conversion needs a function on ForeverMoney's Bittensor
contracts that a third-party contract may call. Their source is not verified on the explorer and
their docs describe only app/SDK use. The contracts in this spec are built against `MockBridge`
and do not wait for that answer; the adapter spec does.

## Messages (`CascadeMessages` v2)

```solidity
struct Entry { address user; uint256 amount; }   // amount = TAO wei for deposits/payouts, shares for redeems
```

| Kind | Value | Payload | Bridged amount |
|---|---|---|---|
| `BATCH` (front door → vault) | 1 | `uint64 batchId, Entry[] deposits, Entry[] redeems` | Σ deposits |
| `PAYOUTS` (vault → front door) | 2 | `uint64 batchId, uint32 chunk, Entry[] payouts` | Σ payouts |

Wrong kind → `WrongMessageKind`. Entry arrays are bounded by `MAX_ENTRIES = 100` per list per
message (decoding more reverts `TooManyEntries`). The front door's operator limits (default 50 per
list) sit below that; `MAX_ENTRIES` is the hard ceiling the vault relies on for gas.

A payout batch may be sent in several chunks (see `processPayouts`); `(batchId, chunk)` is the
replay key on the front door.

## CascadeVault (Bittensor EVM) — stake + shares

ERC-20 `Cascade Staked TAO` / `csTAO`, 24 decimals. Absorbs the v1 `StakeEngine` logic.

Constructor `(bytes32 expectedColdkey, bytes32 hotkey, ICascadeBridge bridge, address owner, address guardian, uint256 minDirectDeposit)`:
derives `coldkey = ADDRESS_MAPPING.addressMapping(address(this))` and reverts `ColdkeyMismatch`
if it differs from `expectedColdkey` (ForeverMoney's hand-typed coldkey caused a deploy incident;
the parameter stays as a cross-check only); `ZeroHotkey`; zero-address checks; calls
`STAKING.setRejectStakingHotkeyGrowth(true)` (stops strangers adding new hotkeys to the vault's
stake list; stake sent onto the vault's own hotkeys still lands, which only raises the price).

### Stake and hotkeys

- `bytes32[] hotkeys` (bounded by `MAX_HOTKEYS = 4`), `bytes32 stakeHotkey` (where idle TAO is
  staked; always in the set). `rootStakeRao() view` = Σ `STAKING.getStake(h, coldkey, 0)` over the
  set. A hotkey stays in the set until its stake is zero because rewards claimed later land on the
  hotkey that earned them.
- `setStakeHotkey(bytes32 h)` (owner): adds `h` to the set if absent (`TooManyHotkeys`,
  `ZeroHotkey`), makes it the stake hotkey; emits `StakeHotkeySet`.
- `moveStake(bytes32 from, uint256 rao)` (owner): `STAKING.moveStake(from, stakeHotkey, 0, 0, rao)`
  (root→root, fee-free); measures both stakes before/after; emits `StakeMoved(from, to, rao, moved)`.
- `removeHotkey(bytes32 h)` (owner): `h != stakeHotkey` (`HotkeyInUse`), `getStake(h) == 0`
  (`HotkeyNotEmpty`); emits `HotkeyRemoved`.
- `stakeIdle()` — permissionless, `whenNotPaused`, `nonReentrant`. **Not called from any delivery
  or payout path** (a precompile failure there would burn the delivery's gas, and a future root
  hold would re-arm on every stake). Stakes `idle = balance - pendingPayouts - ED_RESERVE` on
  `stakeHotkey` if `idle / RAO >= minStakeRao()`; measures the stake delta; emits
  `Staked(hotkey, rao)`. `ED_RESERVE = 1e12` wei (1,000 rao) is never spent and never counted,
  so the chain's 500-rao existential deposit can never make a payout fail.
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
  `remaining -= received`; stop when `remaining == 0`. A precompile revert (e.g. root "too early",
  basket migration) bubbles up; the caller retries later; nothing else is blocked. `receive()`
  accepts value only while `_unstaking` is set (reverts `DirectTransferNotAllowed` otherwise).
  Credits bypass `receive()` on today's runtime; the flag protects against a runtime that routes
  them through it.
- Unexpected stake decreases (a chain sweep) or increases (a donation onto a hotkey) are never
  treated as errors: `totalAssets` reads both stake and balance, so a sweep moves value from one
  term to the other and a donation raises the price.

### Rewards: separate, keeper-timed, vested

Root rewards accrue in the validator's basket and become stake only when claimed. Claiming needs
a gas limit of about 53.2M (the precompile checks its declared worst-case weight before doing
anything), costs real money (about τ0.057 for a full basket), sells basket holdings with no
slippage bound, and can be refused by the chain (`RootClaimTooHeavy`) for reasons outside the
vault's control. Therefore:

- `claimRewards(bytes32 hotkey)` — `nonReentrant`; `hotkey` must be in the set. Callable by
  `claimer` (owner-set role, event `ClaimerSet`) at any time, and by anyone once
  `block.timestamp >= lastClaimAt + CLAIM_FALLBACK_DELAY` (`7 days`), so a dead keeper can never
  strand rewards. Requires `gasleft() >= claimGasRequired` (owner-set, default `55_000_000`,
  event `ClaimGasSet`) else `InsufficientGas` — this is what stops a mis-sized call from burning
  its gas in the precompile. Calls `STAKING.claimRootWithHotkey(hotkey)` with no `try/catch`;
  measures `delta = stake_after - stake_before`; sets `lastClaimAt`; starts vesting `delta`;
  emits `RewardsClaimed(hotkey, delta)`. The claimer role only times claims; it can never move
  funds.
- **Vesting.** A claim adds `delta` to `vestingAmount` (plus whatever was still unvested) and
  restarts `vestingStart`; `unvestedRewards() view = vestingAmount * remaining / REWARD_VESTING`
  with `REWARD_VESTING = 7 days`, linear. `totalAssets()` excludes the unvested part, so the
  share price rises smoothly over the week instead of jumping at the claim. Without this, a
  Bittensor-native user could `depositDirect` just before a keeper's claim and `redeemDirect`
  just after, taking a week of everyone's rewards (the claim is a visible transaction and the
  chain ignores priority fees, so the sandwich is cheap). Vesting also removes the v1 "catch-up
  claim distorts one batch's price" problem without putting the claim in the pricing path.
- Unclaimed rewards are never priced in (reading them costs 1.7M gas and the claim can fail).
  With weekly claims at most about a week of yield (~0.1%) is outside the price at any time.
- `setHotkey` no longer claims first (it cannot, inside normal gas). Moving stake off a hotkey
  leaves that hotkey's unclaimed rewards owed to it; they are claimed later with
  `claimRewards(oldHotkey)` and vest like any other claim. That is why the hotkey set exists.

### Assets and pricing

- `grossAssets() view = rootStakeRao() * RAO + balance - ED_RESERVE` (floored at 0).
- `totalAssets() view = grossAssets() - pendingPayouts - unvestedRewards()` (floored at 0).
- One price per batch: `onBridgeMessage` fixes `A = totalAssets() - msg.value` and
  `S = totalSupply()` once and uses them for every entry, rounded in the vault's favour.

### State

`guardian`, `claimer`, `pendingPayouts` (TAO owed to batches not yet fully sent),
`mapping(bytes32 key => PayoutBatch)` with `key = keccak256(sourceChain, sender, batchId)`,
`PayoutBatch { uint64 sourceChain; address frontDoor; uint64 batchId; uint32 cursor; uint32 count; uint32 chunk; uint256 remaining; bytes32 payoutsHash; }`
(the entries themselves are **not stored** — storing 100 entries costs two fresh slots each and
would push a full delivery past the lane's gas ceiling; the keeper resubmits the list from the
`Redeemed` events), front-door and bridge registries (see "Exit safety"), `primaryBridge`,
outflow window (`windowStart`, `outflowInWindow`), `maxDailyOutflowBps` (default `2000`),
`maxEntryValue` (default `2_000e18`), `maxMessageValue` (default `4_000e18`), `maxTotalAssets`,
`minDirectDeposit`, hotkey set, vesting fields, `lastClaimAt`, `claimGasRequired`, floor
fallbacks.

### `onBridgeMessage(sourceChain, sender, message, amount) payable`

Only an enabled bridge (`NotBridge`); `(sourceChain, sender)` must be an active front door
(`UnknownPeer`); `msg.value != amount` → `ValueMismatch`; `amount % RAO != 0` → `NotRaoAligned`;
decodes `BATCH`; `amount != Σ deposits.amount` or any `d.amount % RAO != 0` → `AmountMismatch` /
`NotRaoAligned`; replayed key → `DuplicateBatch`. Works while paused (money in flight is never
stuck). Does **no staking and no claiming**. With `A`, `S` fixed:

1. For each deposit: `_mint(user, sharesForDeposit(d.amount, A, S))`; emit
   `Deposited(sourceChain, batchId, user, d.amount, shares)`. Zero shares (dust) → still fine.
2. For each redeem: `s = min(r.amount, balanceOf(user))`; if `s == 0` emit
   `RedeemSkipped(...)` and continue. Clip to the per-entry payout bound: `sMax =
   maxEntryValue * (S + 1e6) / (A + 1)` (rounded down; `CascadeMath.sharesForDeposit` is exactly
   this formula); `s = min(s, sMax)`; `out = assetsForRedeem(s, A, S)` rounded down to rao
   (`out -= out % RAO`); if `out == 0` emit `RedeemSkipped` and continue (nothing burned);
   `_burn(user, s)`; accumulate `total += out`, `hash = keccak256(hash, user, out)` (running
   hash over `(user, out)` pairs in order); emit `Redeemed(sourceChain, batchId, user, s, out)`.
   A user whose request was clipped keeps the rest of their shares and may request again.
3. If `total > 0`: `pendingPayouts += total`; store
   `PayoutBatch{sourceChain, sender, batchId, cursor 0, count n, chunk 0, remaining total, payoutsHash hash}`;
   emit `PayoutBatchQueued(key, sourceChain, batchId, n, total)`.

Gas: a full `MAX_ENTRIES` + `MAX_ENTRIES` delivery must fit under the lane budget. The plan
includes a test that measures a 100 + 100 delivery (fresh users, cold storage) and asserts it
under `6_500_000` gas, and a 50 + 50 delivery under `3_500_000`; the operator limits default to
50 + 50 and may be raised to 100 only if the fork measurement confirms the number.

### `processPayouts(bytes32 key, Entry[] calldata payouts, uint32 maxEntries)`

Permissionless, `whenNotPaused`, `nonReentrant`. `payouts` must be the batch's full ordered list:
its running hash must equal `payoutsHash` and its length `count` (`PayoutsMismatch`); `cursor <
count` (`NotPending`).

1. **Window.** If `block.timestamp >= windowStart + 24 hours` reset the window. `allowance =
   grossAssets() * maxDailyOutflowBps / 10000 - outflowInWindow` (floored at 0). The denominator
   is **gross** assets (stake plus balance, before subtracting pending payouts) so a large
   redemption batch cannot shrink its own allowance to zero; revision 1 measured against
   `totalAssets()` and a 300-TAO batch in a 1,000-TAO vault could never clear.
2. **Select a chunk.** Starting at `cursor`, take entries in order while `sum + out_i <=
   allowance`, `sum + out_i <= maxMessageValue` and `taken < maxEntries`; stop at the first entry
   that does not fit (order is preserved so the hash stays checkable). If no entry fits, emit
   `OutflowLimited(key, allowance)` and return without changes (never a revert that loses state).
3. **Fee.** `msg_ = encodePayouts(batchId, chunk, chunkEntries)`; `fee = primaryBridge.quoteFee(sourceChain, frontDoor, msg_, sum)`;
   `fee >= sum` → `FeeExceedsPayout` (retry later). Deduct pro-rata in TAO: `net_i = out_i -
   out_i * fee / sum`, rounded against the user and down to rao; an entry that cannot cover its
   share is paid 0 and emitted as `PayoutDust`. `net = Σ net_i`.
4. **Liquidity.** `available = balance - ED_RESERVE - (pendingPayouts - batch.remaining)`; if
   `available < sum` call `_unstake(sum - available)` (a precompile revert bubbles up; retry).
5. **Effects first.** `cursor += taken`, `chunk += 1`, `remaining -= sum`, `pendingPayouts -=
   sum`, `outflowInWindow += sum`.
6. **Send.** `primaryBridge.send{value: sum}(sourceChain, frontDoor, encodePayouts(batchId, chunk-1, netEntries), net)`
   (the bridge takes `fee` from the value and forwards `net`). Emit `PayoutChunkSent(key, chunk-1, taken, sum, net, fee)`.

No `stakeIdle()` here either; the keeper calls it separately.

### Direct access (Bittensor-native users; escape hatch for EOAs)

- `depositDirect() payable` — `whenNotPaused`, `nonReentrant`; `msg.value % RAO != 0` →
  `NotRaoAligned`; `msg.value < minDirectDeposit` → `BelowMinDeposit`; `totalAssets() + msg.value
  > maxTotalAssets` → `CapExceeded`; mints at the current price to `msg.sender`; emits
  `DepositedDirect`. No staking inline.
- `redeemDirect(uint256 shares)` — `whenNotPaused`, `nonReentrant`; `ZeroAmount`; `out =
  assetsForRedeem(shares, totalAssets(), totalSupply())` rounded down to rao; `out >
  maxEntryValue` → `AboveMaxEntry` (redeem less); window as above, `out > allowance` →
  `OutflowLimitReached` (nothing burned, so a revert is correct here); burn; unstake any shortfall
  with `_unstake` (respecting `pendingPayouts` and `ED_RESERVE`); `outflowInWindow += out`; send
  `out` to `msg.sender` with `call` (`TransferFailed`); emits `RedeemedDirect`.
- Who can really use it: Bittensor-native users and EOAs that hold TAO for gas on chain 964. No
  Coinbase Smart Wallet factory, faucet or gas sponsorship was found on chain 964, so smart-wallet
  users on Base rely on the front door for exits. The README says so; a user-registered
  Bittensor recovery address is the v2.1 answer.

### Admin

Front-door and bridge registries (`propose*` / `activate*` after `REGISTRY_DELAY` / `remove*`
or `disable*` immediately / `cancelProposal` by owner or guardian), `setPrimaryBridge`,
`setGuardian`, `setClaimer`, `setStakeHotkey`, `moveStake`, `removeHotkey`,
`setMinDirectDeposit`, `setMaxTotalAssets`, `setMaxDailyOutflowBps` (`<= 10000`),
`setMaxEntryValue` / `setMaxMessageValue` (`maxEntryValue <= maxMessageValue`),
`setClaimGasRequired`, `setFloorFallbacks(minStakeRao, minRemainRao)` (`1 <= a <= b <= 1e9`),
`pause`/`unpause`. Value leaves the vault only via `primaryBridge.send` in `processPayouts` and
`redeemDirect` to `msg.sender`.

### Exit safety: what a compromised registry, bridge or front door can do

The payout for a redeem batch goes back to **the front door that sent the batch**. Anyone who can
get an address registered as a front door, or who controls the primary bridge adapter, could
submit one `BATCH` redeeming every holder and collect the payout. The owner's timelock is not
enough on its own (anti-goal: "no path where the team's keys can move user funds"). The vault
bounds this itself:

- **Registry changes are slow, visible and vetoable.** `proposeFrontDoor(chain, addr)` /
  `proposeBridge(addr)` emit an event and start `REGISTRY_DELAY = 7 days`; `activateFrontDoor` /
  `activateBridge` only succeed after it. `cancelProposal(...)` by the owner **or the guardian**
  stops a pending proposal at once (cancelling can only stop a flow, so it fits a guardian whose
  only other power is pause). Removal (`removeFrontDoor`, `disableBridge`) is immediate.
  Registries are sets, so an old and a new peer can both be live during a migration and nothing
  in transit is rejected with `UnknownPeer`.
- **Outflow is rate-limited per entry, not per batch.** `maxDailyOutflowBps` (default 20% of
  gross assets per rolling 24 h) is enforced in `processPayouts` (which pays what fits and defers
  the rest) and `redeemDirect`. A drain therefore needs several days, and even a corrected cap
  lets at most 1 − 0.8⁷ ≈ 79% leave within the 7-day delay; the guardian veto is what closes the
  rest, which is why it exists.
- **A forged `BATCH` without the registry.** Deposits need real native value. Redeems can only
  burn shares the named user holds and route the payout to the registered front door of the
  batch's source chain — an unwanted exit for that user (griefing), not theft, while the registry
  is honest.
- **Pause scope.** Guardian/owner pause blocks `deposit`, `depositFor`, `requestRedeem`,
  `closeBatch`, `processPayouts`, `stakeIdle`, `depositDirect`, `redeemDirect`; it never blocks
  `cancelDeposit`, `cancelRedeem`, `claim`, `claimRewards`, or incoming `onBridgeMessage`.
- Donations cannot freeze anything: no bounds, no flags; unexpected TAO only raises the price.
- Honest statement for the README: *the team cannot move user funds instantly; any change that
  could is announced on-chain seven days ahead and the guardian can veto it; a compromised bridge
  or peer can take at most the daily outflow limit before it is paused or removed. Outside the
  contract, ForeverMoney's signers, Chainlink's lane configuration and Bittensor's sudo key can
  stop or change the rails with no delay.*

### Lost messages

Tokens and data travel together in one adapter delivery. If delivery reverts (gas, a transient
precompile error) the adapter's manual re-execution path is the retry; the vault and front doors
are written so that re-delivery is safe (`DuplicateBatch` / `DuplicatePayouts` only after
success). If the rail itself loses a message, the funds in it are the rail's loss; v2 has no
in-contract recovery and no in-flight lock, so other users are unaffected.

### Addresses and wallets

Shares are credited to the depositor's address as seen on Base. This is safe for EOAs,
EIP-7702 accounts and CREATE2 smart wallets whose factory exists on Bittensor EVM; it is NOT safe
for legacy nonce-based (`CREATE`) contract wallets. The contracts keep the same-address rule; the
app must refuse legacy contract wallets and tell smart-wallet users that their exit is the front
door. Documented in the README.

## CascadeFrontDoor (Base; one deployment per supported chain)

Constructor `(IERC20Metadata asset, ICascadeBridge bridge, uint64 vaultChain, address vault, address owner, address guardian, uint64 batchInterval, uint256 minDeposit, uint256 depositCap)`.
`asset` is immutable and must have 18 decimals.

State: open batch `{ uint64 id; uint64 start; Entry[] deposits; Entry[] redeems; uint256 totalDeposits; }`
with **one merged entry per user per list** (`depositIndex[batchId][user]`, `redeemIndex[...]`),
`mapping(address => uint256) claimable`, `uint256 totalClaimable`, `uint256 depositCap`
(owner-set soft TVL limit for this chain — in the beta it follows Base TAO liquidity, about $450k
total depth, not the contract's own limits), `uint256 netForwarded` (forwarded deposits minus
payouts received, floored at 0), `mapping(uint64 batchId => mapping(uint32 chunk => bool)) delivered`.
Operator limits: `maxDeposits` and `maxRedeems` entries per batch (owner-set `setBatchLimits`,
each `1..MAX_ENTRIES`, default `50`), `maxBatchValue` (owner-set, default `4_000e18`, below the
lane's 5,000-TAO message cap). Known nuisance (accepted for the capped beta; a refundable bond per
redeem request is the v2.1 answer): `requestRedeem` needs no shares, so junk requests cost the
keeper one bridge fee per filled batch.

- `deposit(uint256 amount)` = `depositFor(msg.sender, amount)`.
- `depositFor(address user, uint256 amount)` — `whenNotPaused`, `nonReentrant`; `user == 0` →
  `ZeroAddress`; `amount % RAO != 0` → `NotRaoAligned`; `amount < minDeposit` → `BelowMinDeposit`;
  `netForwarded + open.totalDeposits + amount > depositCap` → `CapExceeded`;
  `open.totalDeposits + amount > maxBatchValue` → `BatchValueFull` (close the batch first);
  deposit list full and `user` has no entry → `BatchFull`; pulls `amount` from `msg.sender`;
  adds to `user`'s entry; emits `DepositRequested(batchId, user, amount, msg.sender)`.
  `depositFor` exists for one-signature "zap" contracts (approve + swap + deposit); it can only
  give shares to the named user, so it does not weaken the same-address rule.
- `cancelDeposit(uint256 amount)` — open batch only, works while paused; reduces the caller's own
  entry (`InsufficientRequest`); returns tokens to the caller; emits `DepositCancelled`.
- `requestRedeem(uint256 shares)` — `whenNotPaused`; `ZeroAmount`; redeem list full and no entry →
  `BatchFull`; adds to the caller's entry (the vault clips to what the user holds and to
  `maxEntryValue`); emits `RedeemRequested`. `cancelRedeem(uint256 shares)` mirrors `cancelDeposit`.
- `closeBatch() payable` — permissionless, `whenNotPaused`, `nonReentrant`. Allowed when
  `block.timestamp >= start + batchInterval` OR either list is at its limit OR
  `totalDeposits == maxBatchValue`; empty batch → restart the timer, refund, emit `BatchRolled`.
  Otherwise: effects first (open the next batch, `netForwarded += totalDeposits`),
  `fee = bridge.quoteFee(vaultChain, vault, msg_, totalDeposits)`, `InsufficientFee`,
  `asset.forceApprove(bridge, totalDeposits)`, `bridge.send{value: fee}(...)`, `forceApprove(bridge, 0)`,
  refund excess; emit `BatchClosed(id, totalDeposits, deposits.length, redeems.length)`. No
  in-flight lock. Default `batchInterval` for the beta: `12 hours` (bridged TAO earns nothing
  while it waits, and a batch costs dollars, not tens of dollars).
- `onBridgeMessage(sourceChain, sender, message, amount)` — only an enabled bridge;
  `(sourceChain, sender) != (vaultChain, vault)` → `UnknownPeer`; `msg.value != 0` →
  `ValueMismatch`; decodes `PAYOUTS`; `Σ payouts != amount` → `AmountMismatch`;
  `asset.balanceOf(this) < open.totalDeposits + totalClaimable + amount` → `TokensNotReceived`;
  `delivered[batchId][chunk]` → `DuplicatePayouts`. Credits `claimable[user] += amount` per entry,
  `totalClaimable += amount`, `netForwarded -= min(netForwarded, amount)`; emits
  `PayoutReceived(batchId, chunk, user, amount)`. Works while paused.
- `claim()` — `nonReentrant`, works while paused; `NothingToClaim`; zero first, then transfer;
  emits `Claimed`.
- Invariant: `asset.balanceOf(this) == open.totalDeposits + totalClaimable`.
- Admin: `setCaps(minDeposit, depositCap)`, `setBatchLimits(maxDeposits, maxRedeems)`,
  `setMaxBatchValue`, `setBatchInterval`, bridge set with the same propose/activate/cancel/disable
  pattern as the vault, `setVault(chain, address)` (two-step with `REGISTRY_DELAY`, cancellable),
  `setGuardian`, `pause`/`unpause`.

## Keepers and fees

Anyone may call `closeBatch`, `processPayouts`, `stakeIdle`, and (after the fallback delay)
`claimRewards`. The keeper is "the most reliable caller", never a privileged one, except that the
`claimer` role may time claims early.

- **Deposit leg (Base → Bittensor):** bridge fee in ETH, paid by the caller of `closeBatch`,
  excess refunded; an operator cost (about $1.5–11 per batch depending on size and gas bought).
- **Payout leg (Bittensor → Base):** bridge fee in native TAO, deducted from the chunk pro-rata.
  The caller only fronts gas (about $1.4–4 per `processPayouts` at the chain's 5-gwei floor).
- **Hosted keeper services are gone** (Chainlink Automation sunset July 2026, Gelato Web3
  Functions March 2026, OpenZeppelin Defender July 2026; Chainlink CRE serves Base but not
  Bittensor). The keeper is a self-hosted bot with keys in OpenZeppelin Relayer or a cloud KMS,
  running on both chains against an archive/paid RPC (the public lite RPC drops state after
  ~300 blocks and rate-limits). Its jobs: close batches (after checking the pool's rate-limit
  allowance and sizing delivery gas to the entry count), re-execute failed deliveries, run
  `processPayouts` with the list rebuilt from `Redeemed` events, `stakeIdle` on a schedule,
  `claimRewards` weekly after an off-chain `eth_call` pre-check (expected delta, no
  `RootClaimTooHeavy`), check `getPrecompileStatus` for the staking precompile, and run the
  contract's precompile calls against each Bittensor pre-release on testnet 945.
- A stolen keeper key can only delay things; every routine function is permissionless.

## Test doubles

- `MockStaking` v2 (at the precompile address via `vm.etch`): `getDefaultMinStake()` /
  `getNominatorMinRequiredStake()` (settable, defaults `2_000_000` / `20_000_000`);
  `removeStake` clips an over-request to a full exit, enforces `AmountTooLow` on partial unstakes
  below the min, and sweeps a remainder below the nominator min to the balance;
  `removeStakeFull`; `moveStake` root→root; `claimRootWithHotkey` requires `gasleft() >=
  claimGasRequired` (settable, default `53_200_000`) and models a dispatch failure by consuming
  all gas (`invalid()`); `setClaimTooHeavy(bool)` makes claims fail the same way;
  `setUnclaimed(hotkey, rao)` so a claim adds stake; `setRejectStakingHotkeyGrowth`;
  `mirror(a) = keccak256("evm:" ++ a)` shared with `MockAddressMapping` (etched at `0x…080c`),
  so the vault's derived coldkey matches what the mock credits.
- `MockTAO` (unchanged).
- `MockBridge` v2: chain-aware (`connect(chain, contract_, native)`), routes `send` to the
  receiver on `destChain` with `(sourceChain, sender)`; native delivery to the vault, ERC-20 to
  the front door; FIFO; `setAutoDeliver`, `deliverNext`, `pendingCount`; `failNext()`;
  enforces `maxMessageValue` (default `5_000e18`, `RateLimited`) and delivers with an explicit
  gas cap `deliveryGas` (default `7_000_000`) so a gas regression shows up as a failed delivery.
- `StubBridge` v2 for unit tests (records the last send).

## Tests the plan must include (minimum)

Unit, vault: constructor derives and cross-checks the coldkey; batch handling (one batch price;
redeems clipped to balance and to `maxEntryValue`; rao rounding; skipped redeems; running hash;
duplicate batch; wrong peer; value/amount mismatch; `NotRaoAligned`; `pendingPayouts`
accounting; no staking inside delivery); `processPayouts` (hash check; chunking by window, message
cap and `maxEntries`; `OutflowLimited` with no state change; fee pro-rata and dust; unstake
across several hotkeys; full-exit and sweep paths; retry after a precompile revert); `stakeIdle`
(threshold, `ED_RESERVE`, paused); rewards (claimer vs fallback timing; `InsufficientGas`
before the call; gas-burning failure leaves state untouched; vesting curve; sandwich attempt
yields nothing); hotkey set (add/move/remove rules; `rootStakeRao` sums); direct deposit/redeem
(caps, window, `AboveMaxEntry`); registries (delay, activate, cancel by guardian, remove);
pause rules; `receive()` guard.
Unit, front door: deposit/depositFor/cancel/redeem/cancel/close (interval, list limits,
`maxBatchValue`), roll, payout credit per chunk, duplicate chunk, `TokensNotReceived`, claim, caps,
peer checks, rao alignment.
Gas: 100 + 100 delivery under `6_500_000`; 50 + 50 under `3_500_000`; vault bytecode under
`24_576` bytes (`forge build --sizes`).
End to end: one vault, one front door, through `MockBridge`: deposit → batch → shares → claim
rewards → vest → redeem → chunked payouts → claim on Base; a second front door on another chain id.
Invariants: csTAO price never decreases (with vesting); `grossAssets` conservation;
`pendingPayouts == Σ remaining of open payout batches`; outflow in any 24 h ≤ cap of gross assets
at window start; front-door balance identity; claims never exceed delivered payouts; no
unexpected reverts; reachability logged.

## Decisions taken by the author (not the user's)

1. Fees: deposit-leg bridge fee is an operator cost; payout-leg fee is deducted pro-rata in TAO.
2. Lost messages: no in-contract recovery (adapter manual re-execution); registries are sets.
3. Same-address rule kept; app guards legacy `CREATE` contract wallets; recovery address → v2.1.
4. Batch griefing: merged per-user entries, separate deposit/redeem limits, close-when-full;
   a redeem bond is deferred to v2.1.
5. Caps: `netForwarded` nets off payouts; vault-wide `maxTotalAssets` for direct deposits;
   `depositCap` on Base follows DEX liquidity.
6. Direct access kept, with the honest note about who can use it.
7. Adapters are a separate spec; the vault's native-value interface is the contract they honour.
8. Rewards: keeper-timed `claimer` role with a 7-day permissionless fallback, `gasleft()` guard,
   7-day linear vesting of each claim.
9. Payout lists stored as a running hash; chunked, per-entry outflow limiting against gross assets.
10. Operator defaults: 50 + 50 entries, 4,000 TAO per batch, 2,000 TAO per payout entry, 12-hour
    batch interval, 20%/day outflow, 7-day registry delay with guardian veto.
11. Floors read live with owner-set fallbacks; `ED_RESERVE` of 1,000 rao.

## Open questions for the user

1. **ForeverMoney.** The inbound adapter needs a function on their Bittensor contracts that a
   third-party contract can call to turn their token into native TAO. Reaching out to them is an
   outward-facing step the user takes (a draft message can be provided). The contracts build does
   not wait for the answer; the adapter spec does.
2. **Exit safety:** 7-day registry delay with guardian veto, 20% of gross assets per day paid per
   entry. Accept these defaults?
3. **Reward vesting** over 7 days (share price rises smoothly instead of jumping at each weekly
   claim). Accept?
4. **Launch scope:** Base only, beta `depositCap` sized to Base TAO liquidity (about $250k);
   Robinhood Chain as a possible second front door later; Ethereum/BNB/Polygon users bridge USDC
   to Base in the app. Accept?

## Findings carried from the v1 final review

| v1 finding | How v2 handles it |
|---|---|
| Cheap flag-and-freeze griefing via a substrate donation (Important 1) | No bounds/flags; a donation only raises the price |
| Catch-up reward claims flag honest epochs; last redeemers lose unclaimed rewards (Important 2) | Separate keeper-timed claim with vesting; nothing is flagged; rewards claimed later still land on the earning hotkey |
| `setBridge` during an in-flight epoch bricks it (Important 3) | adapter set + primary; no in-flight lock |
| `MIN_STAKE_RAO` constant mirrors a tunable chain parameter (Important 4) | floors read live from the precompile with owner-set fallbacks |
| Vault trusts that bridged tokens arrived (minor) | front door `TokensNotReceived`; vault `msg.value == amount` |
| Pre-mainnet checklist (12 items) | copy into `docs/architecture.md`; add: fork measurement of delivery gas, `try/catch` behaviour of a view read on the live runtime, ForeverMoney conversion interface, CCIP 2.0 lane migration status |

## Migration from v1

`StakeEngine.sol` is folded into the new `CascadeVault.sol` (staking, shortfall and hotkey logic
carry over where they match this spec; the inline claim does not). v1's Base `CascadeVault.sol`
and its settlement tests are removed; `CascadeMath`, `IStaking` (extended with
`removeStakeFull`, `getDefaultMinStake`, `getNominatorMinRequiredStake`), `MockTAO` stay;
`MockStaking` is extended as above; `IAddressMapping` and `MockAddressMapping` are new.
