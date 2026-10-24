# Cascade web redesign: landing page and stake app

Date: 2026-10-23. Status: mockup approved in conversation; builder check done and its questions settled below; awaiting the owner's read of this document.
Visual reference: `docs/superpowers/specs/assets/2026-10-23-web-redesign-mockup.html` (open it in a browser; it is the approved mockup, landing page on top and the stake page below).

## Intent

Cascade gives people who hold or want TAO a way to get TAO staking exposure from the wallet they already have (MetaMask, Coinbase Wallet, Rabby, any wallet on Base). They deposit USDC; Cascade swaps it to TAO, moves it to Bittensor and stakes it. The current web app works but looks like a wireframe: a narrow centred column, small type, no sense of a real product. A cautious crypto user landing on it today would not put money in.

The redesign makes the site look and feel like an established staking product in the vein of Lido, Aave, MetaMask, Chainlink and Mantle: calm, polished, confident with numbers, friendly to someone who will never learn Bittensor. The owner's words: "make things as easy as possible for crypto users", "get exposure to TAO staking, simple and easy", "more like lido.fi", and for the stake page "more like Lido" (stake.lido.fi).

## Goals

1. A landing page that reads as legitimate at a glance on a wide monitor and on a phone, leads with the yield, and shows (not tells) where the money goes.
2. A stake page in the shape of Lido's stake app: one centred column, a summary and form card, protocol statistics, FAQ.
3. Multichain made visible from day one: Base is live; Ethereum, Arbitrum, Polygon and BNB are shown as "Soon" in the stake form and the hero.
4. Every screen still works against the existing mock data layer in `web/src/lib/cascade`, so the demo keeps working and the later wiring to real contracts is a data-layer change only.
5. Plain, consistent language. Sentence case. Actions keep the same name through a flow (Stake, Unstake).

## Non-goals

- Wiring to real contracts, RPCs or indexers. That is the separate `web-wiring` piece. This work stays on mock data behind `CascadeData`.
- Dark mode. Light only for now (my call; see below).
- Making the "Soon" chains functional, or any bridging UI for them.
- Docs site, blog, SEO content, analytics.
- Changing the contracts or the keeper.

## Anti-goals (what would make this a failure even if it works)

- A page that feels like a warning wall. Threat-model language (guardians, stop buttons, timelocks, "nobody can move your TAO") stays out of the landing page and stake page. It belongs in the README and docs.
- Fake trust signals. No "Audited" until an audit report exists; the audit item reads "Scheduled" until then. No fabricated protocol statistics in production: a statistic the data layer cannot supply is hidden, not faked.
- Generic template chrome: all-caps eyebrow labels, middle-dot meta strings, arrows appended to buttons, identical rounded cards for everything, purple or neon gradients.
- Wallet-brand or mechanism copy in the money-flow visual. Rejected lines: "One approval in MetaMask", "Still on Base", "Rewards show on their own line, apart from price moves".

## Constraints

- Stack stays as is: Next.js 16, React 19, wagmi 3, viem 2, TanStack Query, CSS modules with global tokens in `globals.css`, pnpm, vitest. No Tailwind, no component library.
- Typeface changes to Manrope (weights 300, 400, 500, 600, 700), loaded with `next/font/google` so it is self-hosted at build time. No runtime requests to Google Fonts.
- No third-party scripts, trackers or embedded widgets. The site must be deployable as static files with no server-side secrets (owner's security requirement after the Railway environment-variable breach). Prefer Next.js static export; if a route cannot be exported statically, the builder decides how to restructure it (see "Left to the builder").
- The brand mark does not change: the three stepped bars (ink `#10212B`, water `#2E8FA3`, green `#1E8A5A`) with the bold lowercase "cascade" wordmark, as in `web/src/components/Logo.tsx`.
- All numbers use tabular figures. Amounts show the unit (USDC, TAO, $).
- Responsive down to 360 px wide. Visible keyboard focus. Motion respects `prefers-reduced-motion`. Text contrast meets WCAG AA.
- Every number on screen comes from the data layer or the wallet, never from a literal in a component. The sample numbers in the mockup are placeholders for the mock adapter.

## Design tokens (my call, approved via the mockup)

- Ink `#10212B` (text, black pill buttons), ink-2 `#4B5B66`, ink-3 `#7E8C96`.
- Water `#2E8FA3` with deep variant `#206F80` for yield figures, links and the active flow; water tint `#E3F1F4`.
- Mist `#F3F7F9` for page and card backgrounds behind white cards; lines `#E3EAEE` and `#EEF3F6`.
- Green `#1E8A5A` with tint `#E6F4EC` only for money earned and "staked" checks. Amber `#9A5B00` on `#FFF3DE` for the audit "Scheduled" pill.
- Soft halo behind the hero: radial washes of water, lavender and pale pink at low opacity, blurred. The only gradient on the site.
- Radii: cards 20 px, inputs 14 px, buttons and chips pill-shaped. One soft shadow for cards.
- Type scale (desktop): hero line one 54 px light, hero "TAO staking" 104 px semibold tight; section titles 48 px light with a semibold phrase; card titles 18 to 32 px; body 15 to 17 px. At 1800 px and wider the hero scales up; below 1000 px everything collapses to one column.

## The landing page (as approved)

Nav. Tall bar (about 100 px): logo left; "Stake", "How it works", "Security", "Docs" centre; black pill "Stake TAO" right. On phones the centre links collapse (builder decides into what).

Hero. Two columns. Left: the money-flow visual. Right: headline "Get exposure to" (light) over "TAO staking" (huge, semibold); sub-line "Simple and easy, from the wallet you already have. Deposit USDC, we swap it to TAO and stake it on Bittensor for you."; a stats row of APR (water colour, "APR, paid in TAO*") and total staked ("staked through Cascade"), with a black pill "Stake"; a "Deposit from" chip row (Base solid; Ethereum, Arbitrum, Polygon, BNB dashed with a small "Soon" tag); a footnote "*Average over the last 7 days. Changes with the network and is not guaranteed."

Money-flow visual. A descending stepped path (the cascade) with three white tiles sitting on its ledges and small captions on the drops:
1. "Your wallet, on Base" / 500 USDC / "Deposited just now"
2. caption "swapped for TAO" → "Your TAO" / 1.84 TAO / "Bought at $271.18 each"
3. caption "crosses via Chainlink CCIP" → "Staked on Bittensor" / 1.84 TAO with a check / "Earning 11.4% a year in TAO"
Below the path a green pill: "Rewards land in your balance every day". Three dots travel along the path on a loop; they stop under reduced motion. The amounts in the tiles come from a sample quote in the data layer (same source as the stake form's estimate), not from literals. On phones the path becomes vertical.

How it works. Title "One transaction from you. We handle the rest." Lede: "No Bittensor wallet, no seed phrase to write down, nothing new to learn. You can follow every step with a receipt anyone can look up." Three steps on descending ledges connected by faint drops (this is a real sequence, so numbering is justified):
1. Deposit USDC: "Straight from MetaMask, Coinbase Wallet, Rabby or any wallet on Base."
2. We swap and stake: "Your USDC becomes TAO, crosses to Bittensor over Chainlink CCIP and is staked. Usually within the hour."
3. Earn, and leave any time: "Staking rewards are added to your balance every day. Unstake back to USDC whenever you like."

Stake section (mist background, soft halo bottom right). Left: "Stake in under a minute", lede "Pick the chain your USDC is on, type an amount, approve once. Base is live today and more chains are on the way.", three checked points: "One balance. Your TAO and your rewards, in dollars and in TAO."; "Always visible. See exactly where your money is at every step, with a live on-chain check once it is staked."; "Unstake any time. Back to USDC in the same wallet, usually within a day." Right: the stake widget (same component as the stake page form, see below) with a filled-in sample amount so the estimate rows show real numbers.

Secure by design. Title "Secure by design", lede "Your TAO sits in an open, auditable contract. Not in our hands." Four items with a small line icon each: Verifiable on-chain; Open source; Independent audit (with the "Scheduled" pill, driven by a config value); Built on Chainlink CCIP. Copy as in the mockup.

Footer. Logo, one quiet line ("TAO staking exposure for people who would rather not run a Bittensor wallet. Yield varies with the network and is not guaranteed."), links: Docs, GitHub, Security, Status, Contact.

## The stake page (as approved)

Route `/stake` (the app home once a wallet is connected or the demo is on). Mist page background.

Top bar. Logo; pill tabs "Stake", "Unstake", "Rewards", "Activity" with small line icons, active tab white; right side: network pill ("Base" with its blue dot) and a wallet pill showing the USDC balance and the short address with an avatar.

Title. "Stake TAO" with "Deposit USDC and earn TAO staking rewards" under it.

Main card, two halves.
- Summary (mist half): "Available to stake" with a small live dot and the wallet's USDC balance; "Network" Base; "Staked" as TAO with the dollar value small beside it; "Cascade APR*" in water colour.
- Form (white half): "Deposit from" chip row (Base selected; others "Soon", not selectable); "Amount" input with a USDC token selector on the left and a MAX button on the right; full-width black pill "Stake" (reads "Stake 500 USDC" once an amount is typed); details list: You will receive (about N TAO), TAO price, Staking yield (APR, water colour), Fees, Staked in (about N minutes).

Where your money is right now. Section heading with the on-chain check time as a link on the right. A card with a three-node lane: wallet USDC on Base; TAO in transit ("crossing to Bittensor, step 3 of 4", node highlighted in water); TAO staked on Bittensor (green node, "See it" link to the explorer). Nodes with nothing in them are shown muted, not hidden, so the lane always has the same shape.

Cascade statistics. Heading with "View on Bittensor" link. Card rows: Annual percentage rate* (water), Total staked through Cascade, Stakers, TAO price. A row whose value the data layer cannot supply is omitted.

FAQ. Accordion of six items, first open: What is Cascade?; Do I need a Bittensor wallet?; Where is my TAO staked?; What are the fees?; How do I unstake?; Is there a lock-up? Answers as in the mockup; the fee answer must stay generic until the fee schedule is final.

Footnote. "*APR is an estimate based on recent rewards. It is not guaranteed and changes with network conditions."

### The other tabs (my calls, not yet mocked up)

- Unstake: the same card shape. Summary shows Staked and Available to unstake. Form: TAO amount with MAX, estimate rows (You will receive about N USDC, TAO price, Fees, Paid out in about N hours), black pill "Unstake". The existing withdrawal quote and `startWithdrawal` back it.
- Rewards: a card with "Earned so far" in TAO and dollars, current APR, and a simple list of recent reward accruals from the data layer. Keep it to one card; no charts in this round.
- Activity: the existing deposits and withdrawals lists restyled as rows (amount and chain, TAO at price, status chip with the four-bar progress), each opening the existing trail screen with receipts.

Routes and gating: `/` is always the landing page, for everyone, like lido.fi; its "Stake TAO" button goes to `/stake`. The app routes (`/stake`, `/unstake`, `/rewards`, `/activity`) never redirect away. With no wallet and no demo they render in a connect state: the summary shows dashes, the form's button reads "Connect wallet", statistics and FAQ show as usual. "See the demo" starts the existing demo account and lands on `/stake`. The old `/deposit` and `/withdraw` routes redirect to `/stake` and `/unstake`.

## Data layer additions

`CascadeData` gains:

- `source: "mock" | "live"` so the UI knows whether figures are samples.
- `getProtocolStats(): Promise<ProtocolStats>` with `aprPercent`, `totalStakedTao`, `stakers`, `taoPriceUsd` (each optional); the mock returns the mockup's sample figures.
- `listRewards(account): Promise<RewardRecord[]>`: one record per day with the TAO accrued and the running total. The mock models a daily accrual at the sample APR from each staked deposit's date. (In the contracts, claimed rewards vest over seven days, so a balance grows a little every day; "Rewards land in your balance every day" is the honest plain-language version of that.)
- `WithdrawalQuote.etaMinutes` for the "Paid out in about N hours" row.
- `SourceChain` gains `arbitrum`; `chains.ts` carries a `status: "live" | "soon"` per chain, and every chip row reads that one list. Base is the only live chain at launch.

The wallet USDC balance comes from wagmi when a wallet is connected and from the mock in demo mode. The money-flow visual and the stake widget share one sample quote from `quoteDeposit`. `startDeposit` and `startWithdrawal` stay mocked until the `web-wiring` piece, even with a real wallet connected.

## Copy rules

- Sentence case everywhere; no all-caps labels except the MAX button.
- The action is "Stake" and "Unstake" throughout: tab names, buttons, confirmations.
- Describe states, not mechanisms: "Your TAO", "Staked on Bittensor", "crossing to Bittensor". Chainlink CCIP is named where the money crosses chains (the flow caption, step 2) and in the Security section, and nowhere else.
- Errors say what happened and what to do next, in the interface's voice. Empty states invite the first action.
- Yield is always "APR" with the footnote; never "guaranteed", never "up to".

## Decisions after the builder check (my calls)

- Public demo before wiring. This build may be deployed publicly on mock data as a demo. Whenever `source` is `"mock"`, the existing demo banner shows on every page and each protocol-wide figure (hero APR and total staked, the statistics card) carries a small "sample" tag. Per-account figures in demo mode are already covered by the banner. The money-flow tiles are illustrative and need no tag.
- "Where your money is right now" with several deposits in progress: the middle node sums `pendingTao` over all in-progress deposits. With one deposit in progress its sub-line is that deposit's step ("crossing to Bittensor, step 3 of 4"); with more than one it reads "N deposits on their way"; with none the node is muted and reads "nothing in transit". The staked node reads from `StakeProof`; the wallet node from the USDC balance. Derivation is a pure function with unit tests.
- Links. GitHub goes to https://github.com/Kedawgs/cascade; Security to the repo's `SECURITY.md`; Docs to the repo's `docs/` folder for now. Status and Contact are left out until a status page and a contact channel exist; nothing on the site may link to a dead page.
- Static export with no server. Receipt detail screens move to query-string routes under the Activity tab (for example `/activity?deposit=<id>`), which work on any static host without a fallback rule. The old `/deposits/[id]` and `/withdrawals/[id]` URLs are not kept; nothing public links to them yet. Host choice is a deploy-time decision; any static host works.

## Left to the builder

- Component breakdown and file layout within `web/src`.
- Component breakdown for the four tabs and the receipt detail screen under the Activity tab.
- Exact breakpoints, the phone version of the hero path and the nav.
- Accordion, chip row and tab implementations (native elements preferred: `details`, buttons with `aria-pressed`).
- Loading, empty and error states for every data-backed element, following the current app's pattern.
- Test coverage: keep the existing vitest tests green and add tests for formatting, the protocol stats mock, and any pure logic (estimates, lane state derivation).
