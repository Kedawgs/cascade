# Cascade web app

The landing page and the signed-in app: Stake, Unstake, Rewards and Activity. Next.js 16, React 19,
wagmi 3, viem 2, TanStack Query, CSS modules, Manrope via `next/font`. Every figure on screen is read
from Base or Bittensor (or derived from chain data by stated arithmetic); a figure the chain cannot
give is hidden, never filled with a sample.

Designs: `docs/superpowers/specs/2026-10-23-cascade-web-redesign-design.md` (look and copy) and
`docs/superpowers/specs/2026-10-25-cascade-web-wiring-design.md` (live data and wallet flows).

## Run

```
pnpm --dir ../ops ops web-config --live   # writes .env.local with the live deployment's addresses
pnpm install
pnpm dev                                  # http://localhost:3000
pnpm test                                 # vitest, pure logic (LIVE=1 also reads mainnet)
pnpm typecheck && pnpm lint
pnpm build                                # static export into out/
```

Without `.env.local` the site shows that it isn't connected to a deployment and no figure appears.
`.env.local` holds only public values (addresses, a block number, SS58 names); no RPC key ever goes
into the site.

## Routes

| Route | What it is |
|---|---|
| `/` | Landing page, for everyone, signed in or not |
| `/stake/` | Stake tab. Without a wallet it shows a connect state instead of redirecting |
| `/unstake/` | Unstake tab (TAO back to Base, then claimed as USDC in the same wallet) |
| `/rewards/` | What the staked TAO has earned |
| `/activity/` | Deposits and unstakes; `?deposit=<id>` or `?withdrawal=<id>` opens one receipt trail with its actions (continue, cancel, claim) |
| `/deposit/`, `/withdraw/` | The old pages, redirecting to the tabs |

## How it reads the chains

`src/lib/cascade/types.ts` is the contract (`CascadeData`), `live.ts` implements it over viem public
clients (`chain.ts`: `https://mainnet.base.org` and `https://lite.chain.opentensor.ai`, JSON-RPC
batching and Multicall3 on both), `index.ts` picks it (or the not-connected data source) and
`hooks.ts` wraps it in react-query. Amounts that feed a transaction are exact `bigint`s; numbers are
for display only (`units.ts`).

- **Base logs are never read** (the public Base RPC refuses `eth_getLogs`). Base is read by `eth_call`
  and by transaction hash.
- **Activity without an indexer:** `oplog.ts` keeps, in the browser, the transactions this site sent
  for each account; `facts.ts` follows each one through the site's own receipts, direct reads and the
  vault's Bittensor logs (1,000-block windows); `trail.ts` turns that into the receipt trails.
  Deposits made from another browser still appear, from the vault's `Deposited` events.
- **Prices and fees:** TAO from Uniswap's quoter (what selling 0.01 TAO pays), swap fees from the
  route's pool fees, the bridge fee from the Bittensor adapter's own `quoteFee`.

## How it sends transactions

`flows.ts` builds the calls and runs them; `use-flows.ts` binds them to the connected wallet through
wagmi. Every flow is recorded in the operation log before the first signature.

- **Stake:** approve USDC to Uniswap's SwapRouter02 if needed (an open approval, standard for that
  router), `exactOutput` along TAO←WETH←USDC for exactly the deposit's TAO (0.5% slippage; unused
  USDC never leaves the wallet), approve exactly that TAO to the front door, `deposit`.
- **Unstake:** `requestRedeem(shares)`, with the request fee only for the first request in the open
  batch. At least 0.005 TAO, and never leaving less than that behind.
- **Claim:** `claim()`, then (unless the user keeps TAO) `exactInput` back to USDC.
- **Cancel:** `cancelDeposit` / `cancelRedeem` while the batch is still open.

A wallet that offers EIP-5792 batching (MetaMask's smart account, Base Account) gets one
confirmation; any other wallet gets the steps one at a time, and a stopped stake continues from its
receipt in Activity without repeating a confirmed step.

## Copy rules

Sentence case; the actions are "Stake" and "Unstake" everywhere; yield is "APR" with its footnote,
shown only once it is measured on-chain; no security jargon on any screen. The full list is in the
redesign document.
