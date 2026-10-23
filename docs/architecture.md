# Cascade architecture (v2)

Cascade lets someone get staked-TAO exposure without a Bittensor wallet and without knowing what
alpha tokens are. They deposit from a normal wallet, see one balance, and can check at any time
that their TAO really is staked.

Design: `docs/superpowers/specs/2026-10-21-cascade-v2-vault-on-bittensor-design.md`. Contract
details, operator notes and the pre-mainnet checklist: `contracts/README.md`. Research:
`reports/Cascade v2 Bittensor vault rails.md` (rails and chain behaviour) and
`reports/Cascade subnet index vault.md` (background).

## Product decisions

- **Plain root staking only.** Deposits are staked as TAO on Bittensor's root (netuid 0). No
  subnet picking, no alpha swaps. Since Root Reborn (Aug 2026) root rewards accrue from validator
  baskets and are claimed back as root stake.
- **Transparency is the product.** The home screen shows the balance plus a live on-chain check that
  it is all staked; each deposit has a step-by-step trail with a receipt per step. Shares and stake
  now live in one contract, so the check is one read on one chain.
- **Security first.** Small immutable contracts, no upgrade proxies, caps, a guardian that can only
  stop flows, and admin behind a timelock (48 hours in the beta). The team cannot move user funds
  instantly: a new front door or bridge is announced on-chain 7 days ahead.
- **Runs on its own.** Closing batches, sending payouts and re-executing bridge messages are
  permissionless. Staking idle TAO and claiming rewards are timed by a keeper; if it has not acted
  for 7 days, anyone may. The team's bot is just the most reliable caller.
- **Base only, in the contracts.** ForeverMoney's bridged TAO, the only TAO that CCIP carries to
  Bittensor EVM, exists only on Base and Robinhood Chain. The first front door is on Base; Robinhood
  Chain is a possible second. Users on Ethereum, BNB or Polygon bridge USDC to Base inside the app.
- **The beta cap follows liquidity:** about $250k, sized to the TAO market on Base.
- **csTAO cannot be transferred in v2.** That is what makes "the address that deposited controls the
  shares" true on both chains.
- **A small anti-spam fee on withdrawal requests** (about $0.30 in ETH; the app can pre-pay it).
  Without it, anyone could fill every batch with junk requests for cents.
- **Rewards vest over 7 days,** so the share price rises smoothly instead of jumping at each claim.
- **A withdrawal takes about two days** end to end: batch interval, a 24-hour safety delay, bridge.

## Money flow

```
 user wallet (any chain)
   |  app routes USDC -> ForeverMoney's TAO on Base (DEX swap), user signs
   v
 CascadeFrontDoor (Base)        collects deposits and redeem requests into one batch
   |  closeBatch(): tokens + BATCH message naming each user
   v
 Base adapter -> CCIP -> Bittensor adapter    (ForeverMoney's token -> native TAO)
   v
 CascadeVault (Bittensor EVM)   holds the root stake AND the csTAO balances
   |  delivery: one price per batch; mint for deposits, burn for redeems, queue payouts
   |  after 24 h: processPayouts(): TAO + PAYOUTS message, in chunks
   v
 Bittensor adapter -> CCIP -> Base adapter    (native TAO -> ForeverMoney's token)
   v
 CascadeFrontDoor (Base)        credits each user; user claims; app swaps to USDC
```

v1 kept the share balances on Base and only the stake on Bittensor. The Base vault could not see
the stake, so it had to trust a number reported across the bridge, with price bounds, flagging, an
owner review step and a one-batch-in-flight rule; a lost message froze every later batch. v2 moves
the accounting next to the stake. Nothing is estimated, nothing is flagged, batches are independent,
and a lost message affects only its own batch.

The front door is thin: it batches, forwards each user's address, and pays out what the vault sends.
Bittensor-native users (and EOAs with TAO for gas on chain 964) can also deposit and redeem directly
on the vault, which is the exit if a front door disappears. Smart-wallet users on Base rely on the
front door; a user-registered recovery address is planned for v2.1.

The bridge is wrapped in replaceable, immutable adapters. CCIP delivers ForeverMoney's ERC-20 claim
token, not native TAO, and only ForeverMoney's contracts convert it, so the adapter is where that
dependency, and every other outside change, lands.

### Why the vault is denominated in TAO, not USDC

The vault's asset is TAO. USDC is converted to ForeverMoney's TAO in the user's own transaction on
Base before it reaches the front door, and back after the payout is claimed. So the share price only
moves because of staking rewards:

- no USD price oracle is needed anywhere in the contracts;
- the price should only go up, as the invariant suite checks (except that cancelling a payout
  batch can bring it back to that batch's own price, within rounding dust). Below half the launch
  price, the vault refuses new batches and direct deposits until it is recapitalised.

## How pricing works

- **Assets are read, not reported.** `totalAssets` is the root stake across the vault's hotkeys
  plus its liquid balance, minus a small reserve for the chain's existential deposit, minus payouts
  already owed to queued batches, minus rewards still vesting.
- **One price per batch.** When a batch arrives, the vault fixes assets (without the TAO that batch
  brought) and share supply once, and prices every deposit and redeem in it at that price, rounded
  in the vault's favour. A direct deposit is priced the same way, without its own value.
- **Rewards are claimed separately and vest.** Claiming needs about 53M gas and can be refused by
  the chain, so it is never part of pricing or delivery. The keeper claims (weekly, in practice);
  each claim's measured gain vests linearly over 7 days. That stops someone depositing just before a
  claim and redeeming just after to take a week of everyone's rewards. Unclaimed rewards are never
  priced in: with weekly claims, at most about a week of yield (about 0.1%) is outside the price.
- **Measure, never assume.** Around every precompile call that moves value, the vault measures the
  balance or stake before and after. An unstake that delivers less than the exit needs makes the
  exit revert instead of paying from reserves.

## Exit safety, in short

A front door speaks for its users, so a rogue front door or adapter could try to burn every holder's
shares. Four layers bound that:

1. New front doors and bridges wait 7 days in public, and the guardian can veto them.
2. Each front door may burn at most `max(20% of gross assets, 100 TAO)` per fixed 24-hour window.
3. Nothing burned leaves for 24 hours; the guardian can hold a front door's payouts at once, and the
   owner can cancel the batch and give the shares back.
4. Pause stops deposits, redemptions, payouts and staking, not cancels, claims or incoming payouts.

The rails sit outside this: ForeverMoney's 2-of-3 Safe, Chainlink's lane configuration and
Bittensor's sudo key can each stop or change them with no delay. The README has the full honest
statement, the soft spots (one: the owner can replace the guardian behind only the timelock, so
the guardian must hold the timelock's canceller role), and what each outside party can do.

## Before mainnet

See the pre-mainnet checklist in `contracts/README.md`. First: ForeverMoney's conversion interface
(the adapter spec waits on it) and a fork measurement of delivery gas. An audit is still required.
