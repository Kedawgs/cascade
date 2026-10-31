# Cascade web app

The landing page and the signed-in app: Stake, Unstake, Rewards and Activity. Next.js 16, React 19,
wagmi 3, viem 2, TanStack Query, CSS modules, Manrope via `next/font`. Every figure on screen is read
from Base or Bittensor (or derived from chain data by stated arithmetic); a figure the chain cannot
give is hidden, never filled with a sample.

Designs: `docs/superpowers/specs/2026-10-23-cascade-web-redesign-design.md` (look and copy) and
`docs/superpowers/specs/2026-10-25-cascade-web-wiring-design.md` (live data and wallet flows).

## Run

Pick the deployment first (PowerShell): `$env:OPS_DEPLOYMENT = "v3-test"`. Without it `web-config`
writes the old v2 deployment (`test-2026-10.json`) and the site is pointed at that.

```
pnpm --dir ../ops ops web-config --live   # writes .env.local with the live deployment's addresses
pnpm install
pnpm dev                                  # http://localhost:3000
pnpm test                                 # vitest, pure logic (LIVE=1 also reads mainnet)
pnpm typecheck && pnpm lint
pnpm build                                # static export into out/, with out/_headers for Cloudflare Pages
```

Without `.env.local` the site shows that it isn't connected to a deployment and no figure appears.
`.env.local` holds only public values (addresses, a block number, SS58 names); no RPC key ever goes
into the site.

The env must name one of the deployments committed in `src/lib/cascade/deployments.json`, every
address, block and SS58 name alike; any other fails `pnpm build` (and `pnpm dev`). A new deployment
is added there in a reviewed commit. Before any transaction, the browser also reads the contracts
(`wiring.ts`; an answer is kept 15 minutes in the page's memory only, never in the browser's storage,
where anything else on the origin could plant a pass, and read again after each flow and on every
reload) and checks they are wired to each other as the config says: the front
door to the vault, TAO and the Base adapter; the adapters to each other; on v3 the staker and the
front door to each other and to the oracle; on Bittensor the vault to this front door and its
adapter. A wrong answer, or a read the contract refuses (a revert, or no contract there), is a
mismatch: it turns staking and unstaking off with one message. The ways out stay open (claim,
cancel, and swapping wallet TAO to USDC): they touch only the listed front door and the fixed Uniswap
router, send no ETH and approve only that router, so a user can always get their own money out. The
check holds only a stake (new, carried on, or of wallet TAO) and an unstake. A read the node couldn't
answer (unreachable, rate-limited, timing out) is never a mismatch: nothing is said on its own, and a
click checks again and sends nothing unless the contracts then check out ("We can't check Cascade's
contracts right now…").

Dependencies: exact versions, a committed lockfile, install scripts blocked except as allowed, and
`minimumReleaseAge` (7 days) in `pnpm-workspace.yaml`: pnpm installs no version published less than a
week ago, and checks every lockfile entry against that on each install, frozen or not. A bump waits
out the week; an urgent fix can be let through by name with `minimumReleaseAgeExclude`.

Known advisories in packages the site doesn't ship (as of 31 Oct 2026): `pnpm audit --prod` reports
two high advisories under `@base-org/account > @coinbase/cdp-sdk`, zod 3.25.76
(GHSA-mrhx-c7xc-m3w5) and follow-redirects 1.16.1 (GHSA-mrwp-f3q8-3g9p). Neither reaches the
browser: cdp-sdk is imported only by Base Account's Node entry points (`index.node.js` and
`interface/payment/*.node.js`, its server-side subscription charge and revoke features), the browser
build takes the browser entry, and a search of every chunk in `out/` after `pnpm build` finds no
trace of zod (`ZodError`, `ZodType`), axios (`AxiosError`), follow-redirects (`maxRedirects`,
`beforeRedirect`) or cdp-sdk, while the wallet code (`wallet.coinbase.com`, `baseAccount`) is there.
Neither can be fixed by an override yet: zod's fix exists only in 4.6.6+, a different major that
cdp-sdk (`^3.25.76`) doesn't declare support for, and 3.x has no patched release; follow-redirects
1.16.2 was published on 25 Oct 2026, inside the week `minimumReleaseAge` holds it for. From 1 Nov 2026
a `pnpm.overrides` entry `"follow-redirects": "1.16.2"` closes that one (a later `@base-org/account`
is the proper fix for both). Re-check with `pnpm audit --prod` after any bump.

## Response headers

The site is hosted as static files on Cloudflare Pages, which reads `out/_headers`. `public/_headers`
sets, on every path, a Content-Security-Policy (only this site's scripts; connections only to the
RPCs above and Base Account's wallet hosts, `*.wallet.coinbase.com`; no framing, plugins, other
`<base>` or form targets), HSTS, `nosniff`, a referrer policy and a minimal permissions policy. As
committed, the policy allows no inline script. After `next build`, `scripts/csp-headers.mjs` adds the
sha256 of every exported page's inline scripts (the 404 page's too) to it, and gives each page a
policy of its own allowing only that page's (Next writes a few into every page, different in every
build). Styles keep `'unsafe-inline'`: the pages have inline `style` attributes and Base Account
injects a `<style>`.

On Cloudflare Pages:
- **The build command must be `pnpm build`** (in `web/`, output `out`). `next build` alone leaves
  out the hashes: every page then breaks loudly instead of running without the policy.
- **Keep off every Cloudflare feature that injects scripts into pages:** Rocket Loader, Email
  Obfuscation, automatically injected Web Analytics, and Zaraz. The policy would block their scripts,
  and allowing them would let code that isn't in this repository run on the page.

HSTS covers this host only (`max-age=31536000`). Adding `includeSubDomains` is the owner's decision,
for later: it makes browsers refuse plain HTTP on every subdomain of the domain for a year, so it
waits until every subdomain serves HTTPS. `preload` is a further step after that.

Base Account asks `rpc.wallet.coinbase.com` for a batch's status before it connects. Once
connected, it sends what it doesn't answer itself (a batch's status among them) to the RPC its popup
names, which its own constants give as `chain-proxy.wallet.coinbase.com`: both are under
`*.wallet.coinbase.com`. That can't be checked without signing in to a Base Account. **Before
launch, test one real Base Account stake on a Pages preview**, with the browser console open for CSP
errors.

## Routes

| Route | What it is |
|---|---|
| `/` | Landing page, for everyone, signed in or not |
| `/stake/` | Stake tab. Without a wallet it shows a connect state instead of redirecting |
| `/unstake/` | Unstake tab (TAO back to Base, then claimed as USDC in the same wallet) |
| `/rewards/` | What the staked TAO has earned |
| `/activity/` | Deposits or unstakes, one tab at a time (`?tab=unstakes` opens the second); `?deposit=<id>` or `?withdrawal=<id>` opens one receipt trail with its actions (continue, cancel, claim) |
| `/deposit/`, `/withdraw/` | The old pages, redirecting to the tabs |

## How it reads the chains

`src/lib/cascade/types.ts` is the contract (`CascadeData`), `live.ts` implements it over viem public
clients (`chain.ts`: `https://mainnet.base.org` and `https://archive.chain.opentensor.ai`, JSON-RPC
batching and Multicall3 on both; not the lite node, which keeps only minutes of event history), `index.ts` picks it (or the not-connected data source) and
`hooks.ts` wraps it in react-query. Amounts that feed a transaction are exact `bigint`s; numbers are
for display only (`units.ts`).

- **First paint:** the APY and the protocol figures are also read once on the server (`snapshot.ts`,
  at `pnpm build`; under `pnpm dev` at most every ten minutes) and seeded into react-query, so the
  first HTML has them and nothing moves when the browser's own reads replace them. A figure the build
  couldn't read is left to the browser. The TAO price is the exception: it is shown only from the
  browser's own read (`useTaoPrice`), never the build's, so its place shows "–" until then (the
  home page's dollar total staked still starts from the build's price).
- **Base logs** come from a separate public RPC, `https://base-rpc.publicnode.com` (`baseLogs` in
  `config.ts`), because `https://mainnet.base.org` refuses `eth_getLogs`. Everything else on Base is
  read by `eth_call` and by transaction hash.
- **Activity without an indexer:** `oplog.ts` keeps, in the browser, the transactions this site sent
  for each account; `facts.ts` follows each one through the site's own receipts, direct reads and the
  vault's Bittensor logs (1,000-block windows); `trail.ts` turns that into the receipt trails.
  Deposits made from another browser still appear, from the vault's `Deposited` events. Reading the
  history waits on Bittensor, so until it is read, this browser's own deposits and unstakes of the last
  day that went through show at once from the op log (`pending.ts`), marked "Confirming" and never with
  more than the figures they were sent with; each gives way to its record, by id, once the list read from
  the chain holds it. A receipt (`?deposit=` / `?withdrawal=`) picks its record from the same list query
  as the list, so one opened from the list shows at once and the two never read the chain twice.
- **Prices and fees:** TAO from Uniswap's quoter (what selling 0.01 TAO pays), swap fees from the
  route's pool fees, the bridge fee from the Bittensor adapter's own `quoteFee`.
- **Nothing is sent on one source's word.** Every figure above comes from `https://mainnet.base.org`,
  so before a stake is sent its quote (the price its floor is cut from) is checked against the
  30-minute TWAP of Cascade's own oracle (`CascadeTwapOracle.usdcValue`), read on the other Base RPC
  the policy allows (`base-rpc.publicnode.com`; on the first only when that one can't answer): a quote
  more than 5% off the oracle either way, or an oracle that can't be read, sends nothing and says so
  (`flows.ts`, `assertPriceAgrees`; the 5% is justified from live data in `config.ts`,
  `PRICE_CHECK_BPS`). Send it now reads the bridge fee on both RPCs and offers it only when they agree
  within 10%, at the larger (`reads.ts`, `readOpenBatch`); when they don't, the receipt says the fee
  couldn't be confirmed.

## How it sends transactions

`flows.ts` builds the calls and runs them; `use-flows.ts` binds them to the connected wallet through
wagmi. Every flow is recorded in the operation log before the first signature.

A stake or unstake that goes through clears its form at once (the refresh after it counts what was just
sent, so the amount left in place would read as too much) and is confirmed in a modal panel
(`SentDialog`, copy in `sent.ts`): the amount, the estimate, what happens next by the deployment's
timing, and **Follow it live** to its receipt trail on Activity.

A deployment with a staker and price oracle in `.env.local` runs the v3 flows; one with neither keeps
v2. An env that names a v3 deployment (a staker, an oracle or a payout delay) without both a valid
staker and oracle fails the build rather than falling back to v2.

Every approval the site asks for is for exactly the most the call after it may spend (a test checks
every flow), never an unlimited amount. All but one are spent in full. The exception is the v2
stake's USDC approval to Uniswap's router: `exactOutput` spends only what buying the TAO costs, so
up to the 0.5% slippage margin (about 0.5% of the stake) can stay approved to that fixed router
until the next approval replaces it.

- **Stake (v3):** one signature plus one transaction. The wallet signs a USDC permit (EIP-2612, exactly
  the amount, valid 30 minutes) and the site sends `CascadeStaker.stakeWithPermit`, which swaps the
  USDC to TAO and deposits it. An account with code (a smart account), a wallet that can't sign a
  permit, or a permit USDC refuses instead approves exactly that USDC to the staker, then `stake`.
- **Unstake (v3):** `requestRedeemWithDelivery(shares, minUsdcPerTao, deadline, destination)`: the
  request and a delivery preference in one call, a minimum USDC per TAO of today's price less 2%,
  valid 7 days. When the TAO is back on Base the keeper sells it and sends the
  USDC to the wallet (the form shows the floor). The request fee is only for the first request in the
  open batch. At least 0.011 TAO (the vault defers a redeem worth less than 0.01 TAO, so a little more),
  and never leaving less than that behind.
- **Claim by hand:** `claim()`, then (unless the user keeps TAO) `exactInput` back to USDC. On v3 the
  claim banner and the receipt's **Claim as USDC** appear only when automatic delivery can't happen
  (price below the floor, deadline passed) or more than an hour has passed since the TAO landed on
  Base ("It's taking longer than usual").
- **Cancel:** `cancelDeposit` / `cancelRedeem` while the batch is still open.
- **Stake (v2):** approve exactly the swap's most USDC to Uniswap's SwapRouter02 if needed (what it
  doesn't spend, up to the 0.5% margin, stays approved to the router), `exactOutput` along
  TAO←WETH←USDC for exactly the deposit's TAO (0.5% slippage), approve that TAO to the front door,
  `deposit`. v2 unstakes pay nothing automatically and always end in a claim.

A wallet that offers EIP-5792 batching (MetaMask's smart account, Base Account) gets one
confirmation; any other wallet gets the steps one at a time, and a stopped stake continues from its
receipt in Activity without repeating a confirmed step.

**Continuing a stopped stake never sends the floor it was first quoted with.** A stake whose swap (on
v3, its one transaction) the chain doesn't show is quoted again, exactly as a fresh stake is, and goes
at today's floor (`flows.ts`, `freshStakeTerms`), after the same oracle check. If today's TAO figure
moved from the one the user last saw by more than the 0.5% slippage they accepted, nothing is sent:
the receipt says "The price moved since you started: you'd now get about X TAO (was Y)" and the button
becomes **Continue at today's price**, which quotes again on the way (and asks again if it moved again
from the figure shown). A stake stopped a day or more ago isn't continued at all: its receipt shows it
as a stake that didn't happen and offers **Stake again at today's price**, the stake form with the
same amount typed in (`/stake?amount=…`), quoted afresh. The floor a record keeps (`minTaoOut`) is for
the record only.

The browser's own records (the op log) are checked field by field when read back (`oplog.ts`,
`decodeOperations`): known kinds, states and step names, exact amounts within their token's range,
dates that make sense, hashes and accounts that are what they say. A record that isn't is dropped
with a console warning and never reaches a screen or a flow. With the re-quoting above, nothing that
moves money is ever taken from storage without a fresh read from the chain.

## Copy rules

Sentence case; the actions are "Stake" and "Unstake" everywhere; yield is "APR" with its footnote,
shown only once it is measured on-chain; no security jargon on any screen. The full list is in the
redesign document.
