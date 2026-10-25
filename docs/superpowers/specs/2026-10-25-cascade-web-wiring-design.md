# Cascade web wiring — design

Date: 2026-10-25. Piece 4 of the test-run milestone. Status: draft for the builder check.

## Intent

The contracts are live on Base and Bittensor (deployed 2026-10-24; addresses below). The user wants
to do the $20 test **from the website**, the full product flow, with **real numbers everywhere and
no sample data**: "I think B also I want real numbers no more sample stuff". B means the site also
swaps USDC to TAO on Base (and back on the way out), so the user only ever handles USDC.

## Goals

1. Stake: the user enters a USDC amount; the site swaps it to TAO on Base and deposits it in the
   front door, from the user's own wallet, with every number on screen read from the chain.
2. Unstake: the user asks for some or all of their stake back; once the TAO has come back to Base,
   the site claims it and swaps it to USDC.
3. Position, proof of stake, stats, rewards and activity all show live chain data. Anything the
   chain cannot tell us yet is hidden, never invented.
4. The demo mode, sample tags and the demo banner go. The mock adapter survives only as a test fixture.

## Non-goals

- Chains other than Base (their chips stay "Soon"). An indexer or any backend. Hosting the site:
  for the test it runs on the user's machine (`pnpm dev` at localhost). Keeper actions from the
  site (the operator runs `pnpm ops`). Reward claims (skipped in the test).

## Anti-goals

- A figure on screen that is not from the chain (or derived from chain data by stated arithmetic).
- A transaction the user did not see explained in plain words first (what, how much, fees).
- An API key in the website bundle. The site reads public RPCs only.
- Money moving in a step the UI cannot follow afterwards (every step leaves a trail).

## Facts (verified 2026-10-24/25 unless marked)

**Cascade, live** (from `ops/deployments/test-2026-10.json`):
- Base: front door `0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750`, Base adapter
  `0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b`. Bittensor: vault
  `0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750`, Bittensor adapter
  `0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b` (same addresses on both chains: nonce 0 on each).
- Vault coldkey SS58 `5FNEuRkKZvg2jFjhY3DWpC3TBSH51AC3FKQpLyC1xesTBwLu`; validator hotkey
  `0x58aef7b1…af40d` = `5E4z3h9yVhmQyCFWNbY9BPpwhx4xFiPwq3eeqmBgVF6KULde`.
- Settings: `batchInterval` 600 s, `minDeposit` 0.01 TAO, `depositCap` 0.15 TAO,
  `redeemRequestFee` 1e14 wei (paid in ETH with `requestRedeem`), `payoutDelay` 3600 s, vault fee
  ceiling `max(1%, 0.02 TAO)` (the live Bittensor→Base fee is about 0.00105 TAO per payout chunk).
- Front door (Base): `deposit(uint256)` (amount whole rao, `% 1e9 == 0`, at least `minDeposit`,
  within the cap), `requestRedeem(uint256 shares)` payable, `cancelDeposit`, `cancelRedeem`,
  `claim()`, views `depositOf`, `redeemOf`, `claimable`, `canClose`, `openDeposits`, `depositCap`,
  `minDeposit`, `redeemRequestFee`; events `DepositRequested(batchId, user, amount, payer)`,
  `RedeemRequested(batchId, user, shares)`, `BatchClosed(id, totalDeposits, nDeposits, nRedeems,
  fee, potUsed)`, `PayoutReceived(batchKey, chunk, user, amount)`, `Claimed(user, amount)`.
- Vault (Bittensor): csTAO shares with **24 decimals**, non-transferable, held by the same address
  as the user's Base wallet (also when that wallet is a smart account). Views `balanceOf`,
  `totalAssets`, `totalSupply`, `price`, `rootStakeRao`, `pendingPayouts`, `stakeHotkey`; events
  `BatchDelivered`, `Deposited(key, user, assets, shares)`, `Redeemed(key, user, shares, assets)`,
  `Staked`, `PayoutBatchQueued`, `PayoutChunkSent`.
- Bridge messages: the adapters' `Sent(messageId, …)` on the source chain; the destination
  `OffRamp 2.0.0` (`getExecutionState(messageId)`: 0 untouched, 1 in progress, 2 success, 3
  failure) at Base `0x16E577f1…3808`, Bittensor `0xF9410A08…9AD9` (`contracts/test/fork/ForkBase.sol`).

**Swap venue** (Base): TAO trades at about $250. The deepest, cheapest route is Uniswap v3:
USDC –0.05%→ WETH –0.3%→ TAO (pools `0xd0b53D92…F224` and `0x82dD34C6…Dd5A`, about $197k of TAO/WETH
liquidity and $107k a day of volume). Aerodrome's TAO/USDC pool (`0x99f0364e…35a3`, $229k) charges
1% and trades little. Uniswap v3 on Base: SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481`,
QuoterV2 `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` (both report factory `0x33128a8f…6FDfD`).
Live quote: 20 USDC → 0.07882 TAO; 0.08 TAO → 20.16 USDC. Tokens: USDC
`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals), WETH `0x4200…0006`, TAO (ForeverMoney's
bridged TAO) `0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67` (18 decimals).

**RPCs from the browser:** `https://mainnet.base.org` and `https://lite.chain.opentensor.ai` both
answer cross-origin requests from `http://localhost:3000`. Base's public RPC rate-limits bursts
and refuses `eth_getLogs` over more than 200 blocks; Bittensor's allows about 128 requests a
minute and 1,000-block log queries. Multicall3 exists on Base at `0xcA11…CA11` (Bittensor: to check).

**The web app** (`web/`, Next.js 16 static export, wagmi 3.7.7 + viem 2.57.7, react-query, 62
vitest tests): every screen reads `CascadeData` (`src/lib/cascade/types.ts`) through
`src/lib/cascade/index.ts`, `context.tsx` and `hooks.ts`; today `createCascadeData()` returns the
mock. Wallets: Base Account and injected wallets (MetaMask, Rabby…). There is a demo state
(`state.status === "demo"`), `SampleTag`, `DemoBanner`, "See the demo" on the landing page.

## Decided with the user

- Option B: the site swaps USDC↔TAO itself. Real numbers only; no sample data.
- The test is the user's own money, about $20, on localhost; the site stays unadvertised.

## The design (my calls are marked *call*)

### Configuration (*call*)

`pnpm ops web-config --live` writes `web/.env.local` (git-ignored) with the deployment's addresses,
the deploy blocks on each chain and the front door's settings, as `NEXT_PUBLIC_CASCADE_*` values.
The site reads only those and the constants above. Without them the app shows "Cascade isn't
connected to a deployment" instead of any number. No RPC key goes into the site.

### Reading the chain

A live `CascadeData` implementation (`src/lib/cascade/live.ts`) built on viem public clients for
Base and Bittensor (public RPCs above), batching Base reads through Multicall3 and spacing
requests (Base bursts, Bittensor ~2 per second). React-query keeps the current polling cadence
(fast while something moves, slow otherwise) but no faster than once every 5 s for chain reads.

- **TAO price**: QuoterV2 `quoteExactInput` for 0.01 TAO → USDC along the reverse path, ×100
  (includes pool fees; stated as "price you'd get selling").
- **Position**: shares = vault `balanceOf(account)`; TAO = shares × `totalAssets` / `totalSupply`
  (0 if no supply); USD = TAO × price. `pendingTao` = front door `depositOf(account)` (open batch)
  plus deposits the activity log knows are closed but not yet delivered. `rewardsEarnedTao` =
  TAO + redeemed TAO − deposited TAO, from the vault's `Deposited` / `Redeemed` events for the
  account (Bittensor, scanned from the deploy block in 1,000-block windows), floored at 0.
  `avgEntryPriceUsd` from the site's own swap records, else null.
- **Proof**: `stakedTao` = `rootStakeRao` × 1e9 wei; `owedTao` = `totalAssets`; `allStaked` when the
  idle TAO (balance − 1e12 reserve − `pendingPayouts`) is below the staking floor or below the
  0.02-TAO nominator minimum still waiting for more; the explorer link is taostats for the vault
  coldkey; the hotkey shown as SS58.
- **Stats**: total staked = `totalAssets`; TAO price as above. APR and staker count are **hidden**
  (no reward claims yet, no indexer); the landing page shows only what it has.
- **Rewards**: earned-so-far as in the position; the history list stays empty with an explanation
  until there are claims.
- **USDC and ETH balances**: from the wallet's address on Base. ETH matters for gas and the redeem fee.

### Staking (USDC → TAO → front door)

1. Quote: `quoteExactInput(USDC→WETH→TAO, amountUsd)` → expected TAO; target =
   `floor_rao(expected × (1 − 0.5%))` (*call*: 0.5% slippage); refuse below `minDeposit` or above
   the cap still free (`depositCap` − what the front door has forwarded and holds: builder to find
   the exact view). Show: TAO you'll stake, the price, fees (pool fees ≈ 0.35%, Base gas estimate),
   and the time (next batch within 10 minutes, then about 20–30 minutes on the bridge).
2. Transactions (*call*): `approve(USDC → SwapRouter02, amountUsd)` if needed; `exactOutput` (path
   TAO←WETH←USDC, `amountOut` = target, `amountInMaximum` = amountUsd, recipient = the user) so
   exactly the target TAO arrives and unused USDC never leaves the wallet; `approve(TAO → front
   door, target)` if needed; `deposit(target)`. When the wallet supports atomic batching on Base
   (EIP-5792 `wallet_sendCalls`, e.g. Base Account) all four go as one batch; otherwise one at a
   time, with a step list on screen (Approve USDC → Swap → Approve TAO → Deposit) that survives a
   reload and resumes where it stopped.
3. The wallet must be on Base; the site asks it to switch first. Too little ETH for gas: say so.

### Unstaking (front door → back to Base → USDC)

1. The user picks a TAO amount or "all"; shares = TAO × `totalSupply` / `totalAssets` (rounded down;
   "all" = the full balance). Show the USDC estimate (quote back at today's price), the fees
   (redeem request fee in ETH, the payout's bridge fee share ≈ 0.00105 TAO, pool fees ≈ 0.35%), and
   the time (batch 10 minutes + bridge + the 1-hour payout delay + bridge back).
2. `requestRedeem(shares)` with `value` = the front door's `redeemRequestFee`.
3. When `claimable(account)` > 0 on Base, the withdrawal shows "Ready: claim and swap to USDC";
   that sends `claim()`, `approve(TAO → SwapRouter02)` and `exactInput(TAO→WETH→USDC, min = quote ×
   (1 − 0.5%))`, batched when possible.

### Activity and trails

No indexer, so the site keeps a local log (browser storage, per account and deployment) of the
transactions it sent: for a deposit the swap and deposit hashes, the batch id (from
`DepositRequested`), the TAO and USDC amounts and the swap price; for a withdrawal the request
hash, batch id and shares. Each step is then resolved from the chain:

- Deposit: received (USDC left the wallet: the swap tx) → swapped (TAO arrived) → bridged (the
  `BatchClosed` for that batch id, its adapter `Sent` message, and the Bittensor OffRamp's
  SUCCESS) → staked (a vault `Staked` after the delivery, or "waiting to reach the 0.02-TAO
  minimum" when the vault is holding it).
- Withdrawal: requested → unstaked (the vault's `Redeemed` for the account in that batch) →
  returned (`PayoutReceived` on Base for the account) → paid (`Claimed` and the swap back).
- Finding a batch's close on Base scans forward from the deposit's block in 200-block windows,
  bounded (*call*: at most 20 windows per refresh, remembering how far it got).
- Deposits made outside this browser still appear, from the vault's `Deposited` events
  (amounts and time only).

### Removing the samples

Delete the demo state, `SampleTag`, `DemoBanner`, "See the demo" and the landing page's sample
quote; the money-flow animation uses a live quote (or none). `createCascadeData()` returns the live
implementation. The mock moves to test fixtures and keeps the component tests running.

## Testing (*call*)

Unit tests (vitest) for: rao flooring, slippage and the exact-output target; share/TAO conversion;
the deposit and withdrawal trail derivation from recorded logs and states; the activity log's
storage; limits; the live adapter against a fake transport. The existing component tests keep
passing on the mock fixture. Then a manual end-to-end on localhost: the user's first 0.01-TAO
deposit while the operator runs `pnpm ops`.

## Left to the builder

File layout, hook names, UI copy details within the existing design, the polling cadence, how the
batched-versus-sequential choice is detected with wagmi, error and empty states.

## Open items for the builder check

1. Which front-door view gives the cap still free (`netForwarded`, the open batch total)?
2. Does Bittensor EVM have Multicall3, and does `lite.chain.opentensor.ai` answer batched JSON-RPC?
3. Does `exactOutput` through SwapRouter02 behave as described with a smart-account sender, and
   does Base Account report atomic batching to wagmi on Base?
4. Anything in the current UI's flows (stake form, receipts, unstake form) that assumes the mock's
   instant behaviour and needs a different shape for multi-step wallet transactions.
