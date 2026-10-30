# Cascade architecture (v3)

Cascade lets someone get staked-TAO exposure without a Bittensor wallet and without knowing what
alpha tokens are. They deposit from a normal wallet, see one balance, and can check at any time
that their TAO really is staked.

Design: `docs/superpowers/specs/2026-10-21-cascade-v2-vault-on-bittensor-design.md`. Contract
details, operator notes and the pre-mainnet checklist: `contracts/README.md`. Research:
`reports/Cascade v2 Bittensor vault rails.md` (rails and chain behaviour) and
`reports/Cascade subnet index vault.md` (background). v3 research: `reports/Cascade v3 swap
routes and permits.md` (USDC permits, swap routes, liquidity) and `reports/Cascade v3 root
validators.md` (which validator to stake with). v3 design:
`docs/superpowers/specs/2026-10-26-cascade-v3-design.md`.

## Product decisions

- **Plain root staking only.** Deposits are staked as TAO on Bittensor's root (netuid 0). No
  subnet picking, no alpha swaps. Since Root Reborn (Aug 2026) root rewards accrue from validator
  baskets and are claimed back as root stake.
- **Transparency is the product.** The stake page shows the balance, a live on-chain check that it
  is all staked, and a three-stop lane for where the money is right now (wallet, in transit, staked);
  each deposit has a step-by-step trail with a receipt per step under the Activity tab. Shares and stake
  now live in one contract, so the check is one read on one chain.
- **Security first.** Small immutable contracts, no upgrade proxies, caps, and a guardian that can
  only stop flows. At launch the owner is a single hardware-wallet account with no timelock, so its
  setting changes take effect at once; a Safe plus a timelock is planned before Cascade takes other
  people's money. The team cannot move user funds instantly: a front door or bridge added after
  deployment is announced on-chain 7 days ahead.
- **Runs on its own.** Closing batches, sending payouts and re-executing bridge messages are
  permissionless. Staking idle TAO and claiming rewards are timed by a keeper; if it has not acted
  for 7 days, anyone may. The team's bot is just the most reliable caller.
- **Base only, in the contracts.** ForeverMoney's bridged TAO, the only TAO that CCIP carries to
  Bittensor EVM, exists only on Base and Robinhood Chain. The first front door is on Base; Robinhood
  Chain is a possible second. Users on Ethereum, BNB or Polygon bridge USDC to Base inside the app.
- **The beta cap follows liquidity:** about $250k, sized to the TAO market on Base. The first launch
  (v3-launch) starts far lower, at 40 TAO.
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

The bridge is wrapped in two replaceable, immutable adapters, one beside each contract:
`CcipBaseAdapter` next to the front door on Base and `CcipBittensorAdapter` next to the vault. The
vault and the front door only call `send` and receive `onBridgeMessage`; everything that touches
the rail happens in the adapters. CCIP carries ForeverMoney's ERC-20 TAO, not native TAO, so the
Bittensor adapter converts in the same transaction as each crossing: `withdrawLiquid` on
ForeverMoney's `AlphaVault` turns arriving tokens into native TAO before the vault sees them, and
`depositLiquid` turns a payout's native TAO into tokens before it leaves. Tokens and the batch or
payout list travel in one CCIP message, so a delivery that fails leaves both on the rail, where
anyone can re-execute it later. The adapters have no owner; replacing one is a new deployment
through the 7-day bridge registry. That is where a change on the rail (ForeverMoney's token,
Chainlink's lane) lands, not in the vault or the front door. Details: the "Bridge adapters" section
of `contracts/README.md`.

### Why the vault is denominated in TAO, not USDC

The vault's asset is TAO. USDC is converted to ForeverMoney's TAO in the user's own transaction on
Base before it reaches the front door, and back after the payout is claimed. So the share price only
moves because of staking rewards:

- no USD price oracle is needed anywhere in the contracts;
- the price should only go up, as the invariant suite checks (except that cancelling a payout
  batch can bring it back to that batch's own price, within rounding dust). Below half the launch
  price, the vault refuses deposits (batches carrying deposits, and direct deposits) until it is
  recapitalised; exits keep working.

## How pricing works

- **Assets are read, not reported.** `totalAssets` is the root stake across the vault's hotkeys
  plus its liquid balance, minus a small reserve for the chain's existential deposit, minus payouts
  already owed to queued batches, minus rewards still vesting.
- **One price per batch.** When a batch arrives, the vault fixes assets (without the TAO that batch
  brought) and share supply once, and prices every deposit and redeem in it at that price, rounded
  in the vault's favour. A direct deposit is priced the same way, without its own value.
- **Rewards are claimed separately and vest.** Claiming needs about 53M gas and can be refused by
  the chain, so it is never part of pricing or delivery. The keeper claims (weekly, in practice);
  each claim's measured gain (the whole position's increase, wherever the chain credits it) vests
  linearly over 7 days. That stops someone depositing just before a claim and redeeming just after
  to take a week of everyone's rewards. Unclaimed rewards are never priced in: with weekly claims,
  at most about a week of yield (about 0.1%) is outside the price.
- **Measure, never assume.** Around every precompile call that moves value, the vault measures the
  balance or stake before and after. An unstake that delivers less than the exit needs makes the
  exit revert instead of paying from reserves; if the chain ever charged a fee on unstaking, an
  owner-set margin added to every unstake request would cover it.

## Exit safety, in short

A front door speaks for its users, so a rogue front door or adapter could try to burn every holder's
shares. Four layers bound that:

1. Front doors and bridges added after deployment wait 7 days in public, and the guardian can veto
   them. Replacing the guardian takes 8 days, so it stays in office through any proposal made
   alongside.
2. Each front door may burn at most `max(20% of gross assets before the batch's deposits, 100 TAO)`
   per fixed 24-hour window.
3. Nothing burned leaves for 24 hours; the guardian can hold a front door's payouts at once, and the
   owner can cancel the batch and give the shares back.
4. Pause stops deposits, redemptions, payouts and staking, not cancels, claims or incoming payouts.

The rails sit outside this: ForeverMoney's 2-of-3 Safe, Chainlink's lane configuration and
Bittensor's sudo key can each stop or change them with no delay, and a validator's hotkey swap
reprices the vault until the hotkey is re-added (the owner, guardian or keeper can do that at
once). The README has the full honest statement, the soft spots, and what each outside party can
do.

## v3 flows

v3 keeps the v2 vault and bridge and adds two contracts on Base, a delivery path in the front door,
and a reward cut in the vault.

```
 STAKE (one signature)
 user: signs a USDC permit (or approves once), sends one transaction
   v
 CascadeStaker (Base)   takes USDC; fees to the treasury; swaps USDC -> WETH -> TAO along an
   |                    owner-set route; reverts if the TAO it received is below the user's minimum
   v
 CascadeFrontDoor.depositFor(user)  ->  same batch, bridge and vault as v2

 EXIT (USDC delivered)
 user: requestRedeemWithDelivery(minimum USDC, deadline)   (or a plain redeem, then claim by hand)
   v   ... batch, vault burn, payout delay, bridge back (as v2) ...
 CascadeFrontDoor (Base)  holds the user's TAO
   |  keeper calls deliver(user): the TAO goes to the swapper (CascadeStaker.sellFor)
   |  the front door measures its own USDC rise; it must be at least the largest of:
   |    the user's floor, the keeper's floor, the 30-minute TWAP value less 1.5%
   v
 user's wallet receives USDC.  claim() for the TAO always works.

 REWARD CUT
 keeper claims rewards (rarely) -> the vault vests them over 7 days and mints treasury shares worth
 10% of the claim at the pre-claim price.
```

`CascadeTwapOracle` supplies the 30-minute price used as the delivery floor. The keeper claims
rewards only when they are worth at least 25 times a claim's cost, or monthly while a claim is
cheap. The trust model, including what a stolen keeper key can and cannot do, is in
`contracts/README.md` under "v3 trust model". Unclaimed rewards are outside the share price until
collected, so someone leaving just before a collection can miss up to about a month of yield. The
reward cut is about 10% (slightly above, since the treasury's new shares share in that claim's
vesting). The v3 test deployment stakes with tao.bot (`reports/Cascade v3 root validators.md`).

## When a batch closes (launch cadence)

A batch close costs about $1.40 of bridge fee whatever its size, and Cascade earns $0.05 plus 0.15%
on each deposit (plus the roughly $0.23 unstake request fee, which goes into the pot). So about $800-900
of deposits (less when unstake requests have paid into the pot) in one batch pays for its own crossing. Under the launch cadence the keeper closes a
non-empty batch once the contract allows it and the batch is full (a full batch can close before the
1-hour interval), or, once the interval has passed, when it is 24 hours old or its estimated Cascade
fees are at least its bridge fee. If a price or fee read fails (or reads zero) it never closes
early; the 24-hour rule still does. Deposits made directly in TAO (not through the staker) pay no
Cascade fee but are counted at the staker's fee rate, so such a batch can close early; the cost is
bounded at one bridge fee per batch. It also "rolls" an empty batch (a close
with no value, which costs only a little Base gas) so the 24-hour wait counts from about the first
deposit. A quiet day costs at most one bridge crossing (about $1.40, only if there was at least one deposit or unstake) plus up to about 24 tiny Base transactions to keep the batch clock fresh (pennies in total, no bridge fee). The contract caps the interval at 7 days
(`MAX_BATCH_INTERVAL`). The site's "closes by about" estimates use the later of the interval and
the keeper's maximum wait.

## Launch status

v3-launch has been live on Base and Bittensor mainnet since 2026-10-30, holding only the founder's
own money, with deposits capped at 40 TAO. It is not professionally audited. The addresses are in
`SECURITY.md` and under "Launch configuration" in `contracts/README.md`; the pre-mainnet checklist
there records what was confirmed. An audit, and a Safe plus a timelock as owner, come before other
people's money.
