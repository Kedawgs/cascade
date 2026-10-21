# Cascade architecture (v1 draft)

Cascade lets someone get staked-TAO exposure without a Bittensor wallet and without
knowing what alpha tokens are. They deposit from a normal wallet, see one balance,
and can check at any time that their TAO really is staked.

Background research: `reports/Cascade subnet index vault.md`.

## Product decisions so far

- **Plain root staking only.** Deposits are staked as TAO on Bittensor's root
  (netuid 0). No subnet picking, no alpha swaps. Since Root Reborn (Aug 2026) root
  rewards accrue from validator baskets and are claimed back as root stake.
- **Transparency is the product.** Home screen shows the balance plus a live
  on-chain check that it is all staked; each deposit has a step-by-step trail with
  a receipt per step.
- **Security first.** Small immutable contracts, no upgrade proxies, caps, a
  guardian that can only pause, admin behind a timelock.
- **Runs on its own.** Every routine action (close epoch, settle, stake, claim
  rewards) is a permissionless function. The team's bot is just the most reliable
  caller.
- **Multichain in the app, single route in the contracts.** Contracts only know
  one route: Base <-> Bittensor. Deposits from Ethereum / BNB / Polygon hop to Base
  first through an established bridge aggregator inside the app.

## Money flow

```
 user wallet (any chain)
   |  app routes USDC -> TAO on Base (aggregator / Aerodrome), user signs
   v
 CascadeVault (Base)            holds TAO waiting to cross, issues csTAO shares
   |  closeEpoch(): one batched bridge transfer + message
   v
 bridge adapter (CCIP planned; MockBridge for local dev)
   v
 StakeEngine (Bittensor EVM)    owns the root stake via the staking precompile 0x...0805
   |  settleEpoch(): prices the epoch from its own on-chain stake,
   |  sends redemption TAO + a price message back
   v
 CascadeVault (Base)            mints shares for depositors, pays redeemers
```

### Why the vault is denominated in TAO, not USDC

The vault's asset is bridged TAO on Base. USDC is converted to TAO in the user's own
transaction before it reaches the vault. That means the share price only ever moves
because of staking rewards, so:

- no USD price oracle is needed anywhere in the contracts,
- the share price should only go up, which gives a simple, strong safety check:
  any settlement that lowers the price, or raises it faster than a capped yearly
  rate, is flagged and pauses the vault instead of being applied.

### Pricing comes from the engine, checked by the vault

The engine is the only place that can see the real stake, so it reports the
pre-deposit asset value (`assetsBefore`) for each epoch. Both sides compute shares and
redemption amounts with the same library (`CascadeMath`), so the vault does not trust
any share or payout number from the bridge, only `assetsBefore`, and that one number
is bounded by the price-growth check.

Deposits and redemptions in the same epoch are netted on the engine, so most
withdrawals don't need an unstake at all.

### Epoch lifecycle

1. Users `requestDeposit` (TAO) or `requestRedeem` (shares, escrowed) during an epoch.
   Requests can be cancelled until the epoch closes.
2. After `epochDuration`, anyone calls `closeEpoch()` on Base. Pending deposits are
   bridged with an `EpochRequest` message. Only one epoch can be in flight.
3. On Bittensor the bridge delivers the message; the engine only records it.
4. Anyone calls `settleEpoch()` on the engine: it computes `assetsBefore`, unstakes any
   shortfall, sends redemption TAO back with an `EpochResult`, and stakes the rest.
5. The vault checks the price bounds, mints shares, burns escrowed shares, and users
   `claimShares` / `claimAssets` for that epoch.

## Trust and controls

| Piece | Who can do what |
|---|---|
| Vault / engine owner | A timelock (72h+ in production) controlled by a Safe. Can change caps, bridge, validator hotkey, guardian; can accept a flagged epoch after review. |
| Guardian | Can pause. Cannot move funds. |
| Bridge adapter | Only it can call `onBridgeMessage`. Must verify source chain + peer contract. |
| Keepers | Nobody special. All routine functions are permissionless. |
| Engine funds | Can only be staked, unstaked, or sent through the bridge to the vault. No arbitrary calls, no `transferStake`. |

## Open questions to settle before mainnet

1. Can CCIP (ForeverMoney's TAO pool) deliver TAO plus a message to and from a contract
   on Bittensor EVM, and what are the rate limits? Decides the production adapter.
2. Units for root stake via `getStake(hotkey, coldkey, 0)` and `removeStake(..., 0)`
   (assumed rao, 1 TAO = 1e9). Verify on testnet.
3. Root unstake "too early" waiting periods for a contract coldkey.
4. Bridged-TAO token decimals on Base (adapter scales to 18).
5. Legal: jurisdictions, fee, US users.
