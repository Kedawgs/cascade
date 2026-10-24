# Cascade web app

The landing page and the signed-in app: Stake, Unstake, Rewards and Activity. Next.js 16, React 19,
wagmi 3, TanStack Query, CSS modules, Manrope via `next/font`. Everything a visitor sees comes from
the data layer in `src/lib/cascade`; today that is the mock adapter, so the site runs as a demo with
sample numbers.

Design: `docs/superpowers/specs/2026-10-23-cascade-web-redesign-design.md`. Visual reference:
`docs/superpowers/specs/assets/2026-10-23-web-redesign-mockup.html`.

## Run

```
pnpm install
pnpm dev                      # http://localhost:3000
pnpm test                     # vitest, pure logic only (no DOM)
pnpm typecheck && pnpm lint
pnpm build                    # static export into out/
```

## Deploy

`pnpm build` writes a plain static site to `out/`, one folder per route with an `index.html` inside,
so any static host serves it with no rewrite rules. There is no server and nothing secret in the
build: contract addresses and public RPC URLs are the only configuration, and they are public by
design. To check the export locally: `python -m http.server 3002 --directory out`.

## Routes

| Route | What it is |
|---|---|
| `/` | Landing page, for everyone, signed in or not |
| `/stake/` | Stake tab. Without a wallet it shows a connect state instead of redirecting |
| `/unstake/` | Unstake tab (TAO back to USDC in the same wallet) |
| `/rewards/` | What the staked TAO has earned, day by day |
| `/activity/` | Deposits and unstakes; `?deposit=<id>` or `?withdrawal=<id>` opens one receipt trail |
| `/deposit/`, `/withdraw/` | The old pages, redirecting to the tabs |

## Data boundary

`src/lib/cascade/types.ts` is the contract (`CascadeData`), `mock.ts` implements it,
`index.ts` picks the implementation and `hooks.ts` wraps it in react-query. To go live, implement
`CascadeData` against the contracts and an indexer, return it from `createCascadeData()`, and set
`source: "live"`. Components never hold a number of their own.

The one exception to "data layer only" is the connected wallet's USDC balance, which comes straight
from the chain through wagmi (`src/lib/use-usdc-balance.ts`). The demo account gets its balance from
the mock.

## Sample figures

While `source === "mock"`, the demo banner shows on every page and every protocol-wide figure (APR,
total staked, stakers, TAO price) carries a small "sample" tag. Per-account numbers in demo mode are
covered by the banner. A statistic the data layer cannot supply is left out, never faked.

## Copy rules

Sentence case; the actions are "Stake" and "Unstake" everywhere; yield is always "APR" with its
footnote; no security jargon on any screen. The full list is in the design document.
