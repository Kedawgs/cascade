# Cascade v3: one-signature stake, USDC delivered on exit, a reward cut

Status: design, 2026-10-26. Builds on the v2 contracts (`docs/superpowers/specs/2026-10-21-cascade-v2-vault-on-bittensor-design.md`,
as built in `contracts/`), which ran the owner's real-money round trip on 2026-10-24/25. "v3" is the
contracts' version; to the owner this is "Cascade v2 of the product".

## Intent and why

Cascade is for someone holding USDC on Base who wants passive income without learning Bittensor,
installing a new wallet or managing anything. They think in dollars: they put in $500, want to see it
grow, and want dollars back when they leave. What they get is staked TAO earning the root yield
(about 5.3% a year, 4.7% after Cascade's cut), so **their dollar balance moves with TAO's price**. A
price-hedged "stable income" vault is a later product.

The test run showed four things to fix before other people's money goes in:

1. **Too many wallet prompts, with warnings.** A stake was up to four confirmations (approve USDC,
   swap, approve TAO, deposit), and MetaMask flagged the unlimited USDC approval. An exit ended with a
   manual claim and two more prompts.
2. **No revenue.** Every keeper action is a cost and nothing pays it back. The fee model
   (`https://claude.ai/artifact/92WEm1u1rFFufyLANHzLpi`) breaks even at about $400k staked with a 10%
   reward cut, a 0.15% swap fee and $0.05 per deposit.
3. **Reward collection is expensive and must stay rare.** One `claimRootWithHotkey` needs a 53.2M gas
   limit (0.266 TAO worst case at 5 gwei); Bittensor refunds unused gas, and its docs put a full claim
   at about τ0.057. Unclaimed rewards are safe where they are.
4. **Liquidity is small.** TAO on Base: Uniswap TAO/WETH 0.3% about $201k, Aerodrome Slipstream
   TAO/USDC about $226k (its fee is 1%, not the 0.039% GeckoTerminal shows), Aero TAO/USDC 1% about
   $57k. Caps follow liquidity.

The owner asked for this version to be conservative on every level, to keep reward claims rare so fees
don't eat the start, to put the TAO price front and center, and to be ready for USDC from other chains
later.

## Goals

- **Stake in one confirmation:** a USDC permit signature (exact amount) plus one transaction that takes
  the fees, swaps and deposits, with a minimum TAO the user sees before signing. An `approve` fallback
  for wallets whose permit signatures USDC rejects (EIP-7702 smart accounts verify through ERC-1271).
- **Exit to USDC with no claim step:** the user states a minimum price when they unstake; when the
  payout reaches Base, the keeper delivers USDC to their wallet at or above it. If it can't, the TAO
  stays claimable and the user can claim by hand, as today.
- **Revenue:** a reward cut paid to the treasury in vault shares at the current price; a swap fee and a
  flat deposit fee taken in USDC by the stake contract. Every fee has a hard maximum in code and changes
  only through the owner (the timelock).
- **Multichain-ready, Base-only for now:** staking accepts USDC from any sender for any beneficiary (so
  a bridge's executor can deliver and stake in one call later), and an exit carries a destination
  field that only accepts Base today.
- **Routes:** swaps go through an owner-set list of routes, each checked against the caller's minimum
  by balance deltas. Launch route: Uniswap USDC –0.05%→ WETH –0.3%→ TAO, which quoted best at $100,
  $1k and $10k in both directions.

## Non-goals

A hedged vault; delivery to other chains or from Solana; a hosted keeper (separate project, built
against this version); a transferable csTAO; changing the bridge adapters' code; the audit itself.

## Anti-goals (a failure even if it works)

- A user receives less than the minimum they agreed to, or loses funds to a bug, a bad route or a
  compromised admin key beyond what v2 already bounds.
- A fee or price risk surprises a user. Fees and the price exposure are shown before they sign.
- Reward claims cost more than 4% of the rewards they collect.
- A user cannot get out: manual `claim()` and every v2 exit path keep working regardless of the new
  parts.

## What changes

All contracts are deployed fresh (the adapters are immutable and bound to the vault and front door
addresses). The v2 test deployment is wound down and swept after v3 is live (`pnpm ops wind-down`,
`pnpm ops sweep`), once the owner has unstaked what is left in it.

### CascadeVault (Bittensor): the reward cut

The only behaviour change. In `claimRewards`, after measuring `delta`:

- `fee = delta * rewardCutBps / 10_000`. If `fee != 0`, mint the treasury shares worth `fee` at the
  price before this claim. Read `assetsBefore = totalAssets() - delta` before the vesting update (at
  that point `totalAssets()` already includes the freshly claimed `delta`, because the old vesting
  schedule doesn't know about it), then `shares = CascadeMath.sharesForDeposit(fee, assetsBefore,
  totalSupply())`, rounded down as everywhere.
- `vestingAmount = unvestedRewards() + (delta - fee)`; the fee does not vest, so the share price is
  unchanged by the mint and stakers' balances never drop when the cut is taken.
- New state `treasury` (address) and `rewardCutBps` (uint16). `setRewardCut(address, uint16)` is
  owner-only; `rewardCutBps <= MAX_REWARD_CUT_BPS = 2_000` (20%) else `FeeTooHigh`; a zero treasury
  with a non-zero cut reverts. Event `RewardCutSet`. Launch value: 10% to the owner's treasury.
- The treasury's csTAO is ordinary, non-transferable csTAO: it redeems on Bittensor with
  `redeemDirect`.
- Size: the vault has 799 bytes of headroom at `optimizer_runs = 200`. The plan checks
  `forge build --sizes` as soon as it compiles; if it doesn't fit, lower `optimizer_runs` (the v2
  spec's agreed fallback) and re-run the gas tests.

Nothing else in the vault changes: claims stay keeper-timed with the 7-day permissionless fallback and
7-day vesting; `claimGasRequired` stays owner-set.

### CascadeFrontDoor (Base): delivery

Additions; every v2 function keeps its behaviour.

- Immutable `usdc` (constructor); owner-set `keeper` and `swapper` (events `KeeperSet`,
  `SwapperSet`). The owner is the timelock, so either change waits its delay in public.
- **Delivery preference** per user: `struct Delivery { uint128 minUsdcPerTao; uint64 deadline; uint32
  destination; }`, where `minUsdcPerTao` is USDC units (6 decimals) per 1e18 TAO wei.
  - `setDelivery(uint128 minUsdcPerTao, uint64 deadline, uint32 destination)` (the user, any time;
    `minUsdcPerTao == 0` clears it) and `requestRedeemWithDelivery(shares, minUsdcPerTao, deadline,
    destination) payable` (`requestRedeem` plus `setDelivery` in one call, same fee rule).
  - `destination` is a Circle CCTP domain number; only `DESTINATION_BASE = 6` (Base's CCTP domain) is
    accepted, else `UnsupportedDestination`. Later versions may accept other CCTP domains without
    re-encoding anything.
  - The preference stays until its deadline, until the user changes or clears it, or until `claim()`;
    every payout that lands while it is live is delivered. (It is not cleared by a delivery, so a user
    with unstakes in two batches gets USDC for both.)
- `deliver(address user, uint256 keeperMinOut)` — `onlyKeeper`, `whenNotPaused`, `nonReentrant`:
  1. `amount = claimable[user]`, non-zero; the preference is set, unexpired (`block.timestamp <=
     deadline`) and Base.
  2. `minOut` is the largest of: the user's floor `amount * minUsdcPerTao / 1e18` (rounded up, so it
     is never shaved), the keeper's `keeperMinOut`, and the **market floor**: `amount` valued at the
     route's 30-minute time-weighted average price (Uniswap v3 `observe()` on each pool of the
     delivery route, combined across the hops) less `maxDeliverySlippageBps` (owner-set, default 150 =
     1.5%, code maximum 300).
  3. Clear `claimable[user]`, reduce `totalClaimable`, transfer `amount` TAO to `swapper`, record
     `before = usdc.balanceOf(user)`, call `ICascadeSwapper(swapper).sellFor(amount, user, minOut)`,
     then require `usdc.balanceOf(user) - before >= minOut` else `BelowMinimum` (which reverts
     everything, TAO included).
  4. Emit `Delivered(user, amount, received)`.

  The front door's own balance check is the guarantee against the swapper: a buggy or malicious
  swapper can only make the delivery revert, never pay a user less than the minimum or keep their
  TAO. The market floor is the guarantee against the keeper: a stolen keeper key can time deliveries
  but cannot sell a user's TAO more than 1.5% below the half-hour average price, so v2's promise
  ("a stolen keeper key can time things badly, nothing more") still holds within that margin. A pool
  too young or too thin for a 30-minute window makes `deliver` revert, and the user claims by hand.
- `claim()` is unchanged and still works while paused; it also clears any preference.

### CascadeStaker (Base, new): fees, swaps, deposits

A small contract with no upgrade path. Immutable `usdc`, `tao`, `frontDoor`; owner (the timelock) sets
`treasury`, `swapFeeBps` (`<= 50`, 0.5%), `depositFeeUsdc` (`<= 250_000`, $0.25), and the routes.
It holds no user funds between transactions; any balance is dust the owner may sweep to the treasury.

- `stake(address beneficiary, uint256 usdcIn, uint256 minTaoOut, uint8 routeId, uint256 deadline)`:
  pull `usdcIn` from `msg.sender` (`transferFrom`), take the deposit fee then the swap fee on the rest
  (to the treasury), swap the remainder along the route with the router's own minimum set to
  `minTaoOut`, measure the TAO received by balance delta (must be `>= minTaoOut`), floor it to whole
  rao, approve the front door for exactly that and call `frontDoor.depositFor(beneficiary, amount)`.
  Any sender may stake for any beneficiary: that is what lets a bridge's executor deliver USDC from
  another chain and stake it in one call later.
- `stakeWithPermit(..., uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s)`: calls USDC's
  `permit(msg.sender, this, usdcIn, permitDeadline, v, r, s)` inside `try/catch` (a front-run permit
  leaves the allowance in place), then `stake` with the caller as payer.
- `sellFor(uint256 taoIn, address recipient, uint256 minUsdcOut)`: only the front door. Swaps the TAO
  it was just sent along `deliveryRouteId`, takes the swap fee on the USDC out, sends the rest to the
  recipient and requires it to be `>= minUsdcOut`.
- Routes: `routes[id] = Route { RouterKind kind; address router; bytes buyPath; bytes sellPath; bool
  active }` for `RouterKind.UniswapV3` (SwapRouter02's `exactInput`, no deadline field) and
  `RouterKind.Slipstream` (Aerodrome's router, `exactInput` with a `deadline` field, tick spacing in
  the path). Paths must start and end at the right tokens (`BadPath`). Launch: id 0 = Uniswap two-hop
  (SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481`); Slipstream router
  `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F` and Aero router `0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418` can be added later
  if they become cheaper. Every swap approves the router for the exact amount and checks the balance
  delta, so a wrong route can only make a call revert.

### Bridge adapters

Code unchanged. The v2 adapters are bound only to the CCIP router, the token and each other (each
message names its recipient), so they could be reused; this version deploys a fresh pair anyway, to
keep v3's addresses and reserves separate from the test deployment. The cost is a new 1e12-wei reserve
for the Bittensor adapter.

## Keeper and reward policy (ops tool now, the hosted keeper later)

- `pnpm ops rewards`: read-only. Rewards waiting (`getUnclaimedRootTaoByHotkey(vaultColdkey,
  hotkey)`, wei), the estimated claim cost, and the ratio.
- `pnpm ops claim`: claims when either (a) rewards waiting are at least **25×** the claim cost (so a
  claim costs at most 4% of what it collects), or (b) **30 days** have passed since the last claim and
  one claim costs less than **$20** (the owner's choice, 2026-10-26: while Cascade is small, rewards
  reach balances at least monthly, so nobody gains or loses more than about a month of yield). It
  refuses otherwise and says why. No automatic claims during tests.
- **Why monthly matters (disclosed on the site):** unclaimed rewards are outside the share price until
  collected (pricing them in costs about 1.7M gas per hotkey per read). Someone who leaves before a
  collection misses their share of what is waiting; someone who joins just before one shares in it.
  The monthly floor bounds both to about a month of yield (about 0.4%).
- `claimRewards` stays keeper-timed with v2's 7-day permissionless fallback: with monthly claims the
  fallback rarely matters, and claims are never needed for funds to stay safe.
- Validator choice: the claim's cost grows with the number of subnet tokens in the validator's basket
  (about τ0.057 for a full 128-token basket). The testnet measurement compares validators; the vault
  can move its stake to a cheaper-to-claim validator with `setStakeHotkey` and `moveStake`.
- Before launch, measure a real claim on Bittensor testnet 945 (pre-mainnet checklist item 1) and use
  the measured cost.
- `pnpm ops deliver`: for each user with claimable TAO and a live preference, quote the sell off-chain
  and call `deliver` only when the quote clears their minimum with room for the fee; otherwise leave it
  for the next round.

## Website

- TAO price front and center, with a plain note before the first deposit: "Your balance is TAO: its
  dollar value moves with TAO's price."
- Stake: one permit signature plus one transaction, through the stake contract; the `approve` path for
  wallets whose permit fails; the full fee line (swap fee, deposit fee, pool fees) and a break-even
  estimate before confirming.
- Unstake: the minimum price defaults to today's quote less 2%, valid 7 days, editable; the receipt
  says USDC arrives automatically and offers the manual claim only if delivery has not happened.
- Rewards: show what the vault has earned and not yet collected, so balances visibly grow between
  claims.

## Conservative launch settings

| Setting | Value |
|---|---|
| Minimum deposit | 0.04 TAO (about $10) |
| Deposit cap (all deposits in flight and staked) | 40 TAO (about $10k), raised with liquidity |
| Largest batch | 10 TAO |
| Batch interval | 6 hours, closed early when full |
| Unstake request fee | 0.0001 ETH |
| Reward cut | 10% (code maximum 20%) |
| Swap fee | 0.15% (code maximum 0.5%) |
| Deposit fee | $0.05 (code maximum $0.25) |
| Delivery minimum | quote − 2%, valid 7 days |
| Reward claims | at ≥ 25× cost, or monthly while a claim costs under $20 |
| Delivery market floor | 30-minute average price − 1.5% (code maximum 3%) |

## Roles and keys

Owner: the timelock (48 hours) with a Safe behind it for anything with other people's money; the
owner's test wallet for the second test run. Guardian: a separate low-trust key that can only stop
flows. Keeper: the ops wallet. Treasury: an address the owner controls on both chains (decided with
the owner before launch).

## Tests the plan must include

- Vault: the cut mints shares worth exactly `fee` at the pre-claim price; the share price before and
  after a claim with a cut is unchanged apart from vesting; a cut above 20% reverts; existing
  invariants still hold with a non-zero cut; the size check.
- Front door: delivery pays at least the minimum; a swapper that keeps the TAO, pays less or reverts
  makes `deliver` revert with everything restored; expired, unset or non-Base (domain != 6)
  preferences revert; the preference survives a delivery and serves a second payout; `claim()` still
  works and clears the preference; only the keeper can deliver; paused blocks `deliver` but not
  `claim`; the market floor binds when the user's floor and the keeper's are lower, and a manipulated
  spot price within the TWAP window cannot push a delivery below it; a pool with too short an
  observation history makes `deliver` revert.
- Stake contract: fee math at the caps; a route that returns less than `minTaoOut` reverts; permit,
  front-run permit and approve paths; staking for another beneficiary from a contract caller; deposit
  caps on the front door revert the whole call; dust handling.
- Fork tests on Base: a real Uniswap two-hop stake and sell; a real USDC permit; a Slipstream route
  added and used.
- The ops rehearsal on local forks runs a full v3 round trip: permit stake, batch, delivery on
  Bittensor, payout, automatic USDC delivery.

## Decisions made in the builder check (2026-10-26)

- The owner chose monthly reward collection while claims cost under $20 (above).
- The author's calls, consistent with "conservative on every level": the TWAP market floor on
  deliveries; the delivery preference lasts until its deadline; `destination` uses CCTP domain numbers
  (Base = 6); fresh adapters.

## Left to the builder

Names, file layout, the ops command names, event field details, whether `requestRedeemWithDelivery`
shares code with `requestRedeem`, and how the website orders its new elements within the existing
design.
