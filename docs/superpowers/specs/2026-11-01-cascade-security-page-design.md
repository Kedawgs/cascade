# Cascade live security page: design

Date: 2026-11-01. Status: approved by the founder (2026-11-01).
Mockups (the chosen layout, "the map"): `docs/superpowers/specs/assets/2026-11-01-security-page-map.html` and
`docs/superpowers/specs/assets/2026-11-01-security-page-notices.html`.

## Intent

A depositor opens `cascadefi.xyz/security` and sees where their money goes, step by step, from their own wallet to
the validator that stakes it and back, with live on-chain numbers at every step. They trust Cascade by checking, not
by being told. In the founder's words: "the whole money flow of everything with crucial numbers like live liquidity
and backing and bridging and vault balances so everything is transparent is live".

The reader is a depositor or would-be depositor: a crypto user on Base who will never open a Bittensor wallet.

## Goals

1. **The map.** The money flow on one line, one step per box, each with a status dot and one headline number:
   **Your wallet → Swap → Backing → Bridge → Vault → Validator**. Clicking (tapping) a step shows its details below
   the map: one plain sentence on what happens there, two or three live numbers, and a link to check them on a
   public explorer.
2. **Money in and money out.** A switch above the map flips it to the way back:
   **Vault → Bridge back → Swap to USDC → Your wallet**.
3. **Live.** Every number comes from the monitor's latest reading of the chains. The page says when that was
   ("checked 1 min ago"). A number that is too old to trust shows "–", never a stale value.
4. **A status line at the top**, in one of three states:
   - **Normal:** green, "All checks passing, last checked 1 min ago".
   - **Something is happening with our contracts:** a blue notice per event, in plain words, with the earliest
     time it can take effect where the chain records one, and a link to the contract on its explorer. These are
     facts anyone can already see on-chain. On v3-launch today:
     - the vault or the front door is paused;
     - an ownership transfer is pending (vault, front door, staker): "can be accepted at any time";
     - a guardian change, a new bridge or a new front door is proposed (v3-launch's registries): the proposal time
       plus its delay is the earliest effect;
     - ForeverMoney's own vault (the backing) has a scheduled admin change, an announced migration or a timed
       pause, shown against the Backing step (my call: it isn't our contract, but it stands behind the money).

     The monitor's reading has `paused`, `pendingOwner`, `pendingGuardian` and ForeverMoney's `alpha.*` fields
     today. The contract notices come from the monitor's stored contract events (`GuardianProposed`,
     `BridgeProposed`, `FrontDoorProposed`, `OwnershipTransferStarted`, `Paused` and their cancel/activate/accept/
     unpause counterparts), which give the earliest time and the transaction; no per-minute call is added for them
     (amended 2026-11-01, plan Task 1).
   - **A check isn't passing:** amber, "Conditions aren't optimal right now", plus one plain sentence on what is
     affected (for example: the bridge has no room until it refills, so new deposits wait longer to cross; your
     existing stake isn't affected). The founder will refine this wording later; ship a sensible first draft.

## Non-goals

- **No explanation of who controls the contracts.** No section on keys, the owner, the guardian, timelocks or
  audits. The page is purely the live money flow (founder's decision). Contract events appear only as the top
  notices above.
- **No account data.** The page needs no wallet connection; "Your wallet" is the flow's starting point, not a
  balance. (My call.)
- **No history or charts.** Only the current reading.
- **No final wording for the bad states.** A first draft now; the founder refines it later.

## Anti-goals (failure even if it works)

- **Claiming safety.** The page says "monitored", "checked", "passing". It never says "safe", "secure" or
  "guaranteed".
- **Handing an attacker a map.** The page and its data show public chain facts only. Never the monitor's alert
  thresholds, rule names, which checks exist privately, the runbook, or the keeper's holds. The amber state uses
  the page's own simple, public conditions (below), not the monitor's private alert rules.
- **A stale number shown as live.** Every number has its reading's time behind it; past the limit it shows "–" and
  the top line can't say "All checks passing".
- **Load on the chains.** The page never calls an RPC. It makes one cached request to the monitor when it loads,
  and refreshes at most once a minute while the tab is visible (my call), served from the edge cache.
- **A scarier landing page.** The page is linked from the navigation and footer, never pushed onto the landing.

## The steps and their numbers

The numbers below exist in the monitor's per-minute reading today (`indexer/src/snapshot.ts`, `BaseState` and
`BitState`). The field names are given so the builder can find them; the page shows the plain labels.

### Money in

| Step (chain) | Headline on the map | Details | From the reading | Link |
|---|---|---|---|---|
| **Your wallet** (Base) | "You send USDC" (no number) | "You start with USDC in your own wallet. Cascade never holds your keys." | none | none |
| **Swap** (Base) | pool depth in $ | pool depth in $ for TAO/WETH and for WETH/USDC; "a $1,000 deposit moves the price about X%"; market price vs the 30-minute average, "X% apart" | `taoWethPool`, `wethUsdcPool` (liquidity, sqrtPrice, TAO held), `oracleValue` (the TWAP) | the pools on a Base explorer |
| **Backing** (Bittensor) | "% backed" | "The TAO you get on Base is ForeverMoney's bridged TAO, backed by real TAO on Bittensor." TAO held vs bridged TAO issued; the TAO locked for Base vs the bridged TAO on Base | `alpha.backing` vs `wTaoSupply`; `lockPoolFmTao` vs `fmTaoSupply` | the AlphaVault and lock pool on a Bittensor explorer |
| **Bridge** (Base → Bittensor) | TAO room left | "Cascade groups deposits into batches and sends them to Bittensor over Chainlink. The bridge has a safety limit that refills over time." Room left of capacity; refill per hour; transfers on the way; next batch sends in | Base `lane.outbound` (tokens, capacity, rate, isEnabled); in-flight rows of the `messages` table; `openBatch.start` + `batchInterval` | the lane on the CCIP explorer |
| **Vault** (Bittensor) | TAO staked | "Your TAO is staked by the vault, and you hold vault shares that grow as rewards come in." TAO staked; what 1 share is worth in TAO; TAO waiting to pay out | `totalAssets`, `price`, `pendingPayouts` | the vault on a Bittensor explorer |
| **Validator** (Bittensor) | its name (tao.bot) | "The validator the vault stakes with. It earns the staking rewards and keeps a cut." Our stake with it; its cut; the backup validator, when one is configured | `stakes[stakeHotkey]`, `validator.take` (of 65,535; null means the chain default, 18%), `hotkeys` | the validator on taostats |

The **Backing** headline is the lower of the two ratios, AlphaVault backing ÷ wTAO supply and lock pool ÷ FM-TAO on
Base, so the page never shows a better number than the weaker layer. (My call; the details show both.)

### Money out

| Step | Headline | Details | From the reading |
|---|---|---|---|
| **Vault** | TAO waiting to send back | waiting to send back; next payout batch | `pendingPayouts`, `payoutBatches` + `payoutDelay` |
| **Bridge back** (Bittensor → Base) | TAO room left | room left of capacity; transfers on the way | Bittensor `lane.outbound`; `messages` |
| **Swap to USDC** (Base) | pool depth in $ | depth; "a $1,000 payout moves the price about X%" | as Swap above |
| **Your wallet** (Base) | "USDC arrives" | "USDC lands back in your wallet." | none |

## The amber conditions

Simple, public and fixed, each tied to the step it affects (its dot turns amber too):

- the reading is too old (the page shows "–" and the top line says it is waiting for a fresh reading);
- backing below 100%;
- a bridge direction has no room left, or is switched off;
- the vault or the front door is paused (also a blue notice; amber wins for the dot).

The market price vs the 30-minute average is shown as a number ("X% apart") but triggers no amber state on
v3-launch, which has no public on-chain limit for it (my call).

## Where the data comes from

- **A new public, read-only endpoint on the monitor Worker** (`indexer/`), for example `GET /v1/flow`, served
  through the Workers Cache like `/v1/status` (15-second TTL). It may run a few small indexed D1 queries: the
  newest reading of each chain, and the count of bridge messages sent but not yet delivered (`messages`).
- **Per-chain freshness.** Each chain's numbers come from that chain's newest reading, even when the other chain's
  half of the same tick is missing, and carry that reading's block and time. A chain whose newest reading is
  older than 10 minutes is stale (my call: the monitor reads every minute, and its health check fails at 5): every
  number from that chain shows "–" and its steps go stale. Base feeds Swap and Swap to USDC; Bittensor feeds
  Vault and Validator; Backing and both Bridge steps read both chains (the backing is the lower of a Bittensor and
  a cross-chain layer, and a bridge's room is the tighter of its two pools' buckets), so they need both fresh.
  The endpoint never exposes the monitor's own lag limits, thresholds or alert state. (Amended after the final
  review, 2026-11-01.)
- **It returns facts, not judgements:** the numbers with their readings' blocks and times; the in-flight message
  count; the contract notices (kind, the earliest effect time where there is one, the contract); and the explorer
  addresses. The amber conditions above may be computed on the page or in the endpoint, but only from these facts.
- **The swap figure is a quoted cost.** "A $1,000 deposit costs about X%" is a Uniswap QuoterV2 quote (the site's
  quoter and path), added to the monitor's Base reading (`buyQuote1000`; `sellQuote` for $1,000 of TAO sold, sized
  at the previous reading's `oracleValue`; `wethUsdcPoolUsdc`, the USDC the WETH/USDC pool holds). It includes pool
  fees and price movement, which an in-range price-impact estimate would understate in thin pools (amended
  2026-11-01, plan Task 1).
- **Dollar figures** (pool depth, the $1,000 example) are priced with the front door's own 30-minute average
  (`oracleValue`, the TWAP the contracts use), not the spot price, and show "–" when it reverted or is stale
  (my call).
- **Names and links.** Validator names come from a small list in the site's config keyed by hotkey (tao.bot, and
  Yuma as the backup), with a shortened hotkey for anything not on it. Explorers: Basescan for Base, taostats for
  Bittensor accounts and validators, Chainlink's CCIP explorer for the lane.
- **Cross-origin and failure.** The endpoint allows the site's origin (`SITE_ORIGIN`) the same way `/v1/scan`
  does. The site fetches it client-side from `NEXT_PUBLIC_CASCADE_INDEXER_URL`; when that is unset or the endpoint
  can't be reached, every number shows "–" and the top line says the page can't check right now.

## Ready for later contract versions

The endpoint returns notices as a list of kinds and the steps as a list, so a later contract version's new
notices, states and amber conditions slot in without a redesign.

## Look and placement

- **The site's design.** Tokens in `web/src/app/globals.css`, Manrope, mist panels, pills. Layout B from the
  mockups: a title, a one-line lede, the status line with the In/Out switch, the map, the detail panel.
- **On a phone** (my call), the map becomes a vertical list of steps; tapping one opens its details in place.
- **Navigation** (my call): a "Security" link in the top navigation and the footer.

## Constraints

- It works against the live v3-launch deployment now.
- The plan ends at "ready to deploy": code and tests for the site and the endpoint. Deploying is a separate step
  with the founder's OK.
- The site is a static export, so all data is fetched client-side.
- Deploying the site or the Worker to production needs the founder's OK. After any site deploy, run
  `site:approved`, commit, and redeploy the indexer (the monitor checks the live site's contract addresses). Run
  wrangler only from the folder whose config it should use.
- The repo is public: nothing in the endpoint or the page may be secret.
- cascade.fi is not ours; never reference or touch it.

## Left to the builder

- The exact formulas for pool depth in $ and "a $1,000 deposit moves the price about X%" (concentrated liquidity,
  so state the approximation used, in the endpoint's code comments).
- The exact explorer URLs, the endpoint's field names, and the copy polish.
- How the map wraps between desktop and phone widths.

## Calls made in the brainstorm, for the founder to check

1. Order: the swap comes before the backing (money is swapped first; the backing stands behind the TAO the swap gives).
2. The validator is a step; Cascade's batching is folded into the Bridge step.
3. The "Money out" view.
4. The backup validator shown on the Validator step when one is configured.
5. "Security" in the navigation and footer.
6. The phone layout as a tappable list.
7. No wallet connection on the page.
8. A refresh once a minute while the tab is visible.
9. The Backing headline is the lower of its two layers.
10. ForeverMoney's own scheduled changes to its vault appear as notices on the Backing step.
11. A chain's numbers go to "–" when its newest reading is over 10 minutes old.
12. Dollar figures use the contracts' own 30-minute average price, not the spot price.
13. Market price vs average is shown but raises no amber state on v3-launch.
