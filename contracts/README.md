# Cascade contracts

Solidity contracts for Cascade: staked TAO without a Bittensor wallet. Product context and money
flow are in [`docs/architecture.md`](../docs/architecture.md). Contract behaviour is pinned in
[`docs/superpowers/specs/2026-10-20-cascade-contracts-design.md`](../docs/superpowers/specs/2026-10-20-cascade-contracts-design.md).

## Contracts

- `CascadeVault` (Base): the csTAO token. Batches deposits and redemptions per epoch, bridges them to the engine, and settles each epoch from the engine's result.
- `StakeEngine` (Bittensor EVM): owns the root stake. Prices each epoch from its root stake plus its liquid balance (`totalAssets()`, which excludes unclaimed rewards), pays redemptions back through the bridge, stakes the rest, and claims root rewards.
- `CascadeMath` / `CascadeMessages`: the share math both sides compute with, and the `EpochRequest` / `EpochResult` bridge messages.

## Build and test

```shell
forge build
forge test                                    # unit, end-to-end and invariant tests
forge test --match-path "test/invariants/*"   # invariant suite only
```

The invariant suite runs random sequences of deposits, redemptions, cancels, closes, settles, claims,
root rewards and time jumps against both contracts, wired through `MockBridge`. It checks that no TAO
or csTAO is created, lost or mis-booked, and that the share price never falls. Runs and depth are set
in `foundry.toml`.

## Epoch lifecycle

1. Users `requestDeposit` (TAO) or `requestRedeem` (shares, escrowed) during an epoch. Requests can be cancelled until the epoch closes.
2. After `epochDuration`, anyone calls `closeEpoch()` on Base. Pending deposits are bridged with an `EpochRequest` message. Only one epoch can be in flight.
3. On Bittensor the bridge delivers the message; the engine only records it.
4. Anyone calls `settleEpoch()` on the engine: it computes `assetsBefore`, unstakes any shortfall, sends redemption TAO back with an `EpochResult`, and stakes the rest.
5. The vault checks the price bounds, mints shares, burns escrowed shares, and users `claimShares` / `claimAssets` for that epoch.

## Trust and controls

| Piece | Who can do what |
|---|---|
| Vault / engine owner | A timelock (72h+ in production) controlled by a Safe. Can change caps, bridge, validator hotkey, guardian; can accept a flagged epoch after review. |
| Guardian | Can pause. Cannot move funds. |
| Bridge adapter | Only it can call `onBridgeMessage`. Must verify source chain + peer contract. |
| Keepers | Nobody special. All routine functions are permissionless. |
| Engine funds | Can only be staked, unstaked, or sent through the bridge to the vault. No arbitrary calls, no `transferStake`. |

## Operator notes

1. The keeper should call `claimRewards()` before `settleEpoch()`. Settlement does not claim
   rewards itself, so this is what prices an epoch's rewards into that epoch.
2. The bridge adapter the owner sets is fully trusted, and it receives every payout. The vault
   checks the reported payout against its own recomputation from `assetsBefore`. It does not
   verify that the reported amount actually arrived. That is what is trusted.
3. The vault assumes a standard 18-decimal token, with no fee-on-transfer and no rebasing.
4. There is no lower bound on `epochDuration`. A very short duration lets closers front-run
   cancels, so set it behind the timelock with care.

## Open questions before mainnet

1. Can CCIP (ForeverMoney's TAO pool) deliver TAO plus a message to and from a contract
   on Bittensor EVM, and what are the rate limits? Decides the production adapter.
2. Units for root stake via `getStake(hotkey, coldkey, 0)` and `removeStake(..., 0)`
   (assumed rao, 1 TAO = 1e9). Verify on testnet.
3. Root unstake "too early" waiting periods for a contract coldkey.
4. Bridged-TAO token decimals on Base (adapter scales to 18).
5. Minimum-unstake rule: the engine never asks root for a partial unstake below 0.002 TAO
   (subtensor's `DefaultMinStake`, which it rejects as `AmountTooLow`). Confirm the exact
   rule, and the behaviour of `claim_root` with nothing to claim, against the real precompile
   on testnet.
6. Legal: jurisdictions, fee, US users.
