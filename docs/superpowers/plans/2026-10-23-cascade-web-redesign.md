# Cascade Web Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the wireframe-quality web app with the approved Lido-style landing page and stake app, still running on the mock data layer.

**Architecture:** The data boundary stays `web/src/lib/cascade` (`CascadeData` interface, mock adapter, react-query hooks); it grows a few fields and methods. Above it, the UI is rebuilt as two surfaces: a marketing landing page at `/` and an app shell with four tab routes (`/stake`, `/unstake`, `/rewards`, `/activity`), all client-rendered React with CSS modules and global tokens. The site builds as a static export with no server code and no secrets.

**Tech Stack:** Next.js 16 (app router, `output: "export"`), React 19, wagmi 3 + viem 2, TanStack Query 5, CSS modules, Manrope via `next/font/google`, pnpm, vitest (node environment, pure-logic tests only).

**Spec:** `docs/superpowers/specs/2026-10-23-cascade-web-redesign-design.md`. Visual reference: `docs/superpowers/specs/assets/2026-10-23-web-redesign-mockup.html` (open it in a browser; match it).

## Global Constraints

- Work in `web/`. Run commands with `pnpm` from `web/`. All paths below are relative to `web/` unless they start with `docs/`.
- Next.js 16 differs from training data. Before writing app-router code, read the relevant guide under `web/node_modules/next/dist/docs/` (per `web/AGENTS.md`).
- Stack stays as is: Next.js 16, React 19, wagmi 3, viem 2, TanStack Query, CSS modules with global tokens in `src/app/globals.css`, pnpm, vitest. No Tailwind, no component library, no new runtime dependencies.
- Typeface Manrope, weights 300, 400, 500, 600, 700, via `next/font/google` (self-hosted at build). No runtime requests to third parties: no analytics, no trackers, no embedded widgets, no remote fonts or images.
- Static export: `output: "export"` in `next.config.ts`; `pnpm build` must produce `out/`. No server-only code paths, no dynamic route segments.
- Brand mark unchanged: `src/components/Logo.tsx` `Mark` (three bars `#10212B`, `#2E8FA3`, `#1E8A5A`) with the bold lowercase "cascade" wordmark.
- Tokens (exact): ink `#10212B`, ink-2 `#4B5B66`, ink-3 `#7E8C96`, water `#2E8FA3`, water-deep `#206F80`, water-tint `#E3F1F4`, mist `#F3F7F9`, line `#E3EAEE`, line-soft `#EEF3F6`, green (proof) `#1E8A5A`, green tint `#E6F4EC`, amber `#9A5B00` on `#FFF3DE`. Cards 20 px radius, inputs 14 px, buttons and chips pill-shaped (999 px). Primary buttons are ink-coloured pills with white text.
- Every number on screen comes from the data layer or the wallet, never from a literal in a component. Tabular figures everywhere (`font-variant-numeric: tabular-nums` is already on `body`). Amounts always show their unit.
- Copy: sentence case; the actions are "Stake" and "Unstake" everywhere; no all-caps labels except the MAX button; no middle dots, no arrows in button text; yield is always "APR" with the footnote and never "guaranteed" or "up to". Chainlink CCIP is named only in the hero flow caption, How-it-works step 2, and the Security section. Banned lines: "One approval in MetaMask", "Still on Base", "Rewards show on their own line, apart from price moves".
- Threat-model language (guardian, timelock, stop button, "nobody can move your TAO") does not appear on any screen.
- Responsive to 360 px; visible keyboard focus (`:focus-visible` outline in water, already global); `prefers-reduced-motion` stops the hero dots; AA contrast.
- Whenever `data.source === "mock"`: the demo banner shows on every page and every protocol-wide figure (hero APR and total staked, statistics card) carries the "sample" tag.
- Links: GitHub `https://github.com/Kedawgs/cascade`, Security `https://github.com/Kedawgs/cascade/blob/main/SECURITY.md`, Docs `https://github.com/Kedawgs/cascade/tree/main/docs`. No Status or Contact links anywhere. No link may point at a page that does not exist.
- Tests: `pnpm test` (vitest, `src/**/*.test.ts`, node environment: pure logic only, no DOM). Each task also passes `pnpm typecheck`, `pnpm lint` and, from Task 2 on, `pnpm build`.
- A dev server may already be running on port 3000 from the owner's session. For a visual check start your own with `pnpm dev -p 3001` and stop it afterwards.
- Every commit message ends with these two trailer lines, each on its own line:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01QsFviaJn5ejsAa5vHQciyX`
- Branch: `web-redesign` (already exists, two commits ahead of `main`). Never commit to `main`.

## Review Focus

1. Pasted or odd amount input ("$1,000", "1e5", "0.") must sanitize to a valid number or disable the button, never throw. Pinned in Task 5 (`stakeButtonLabel` and `validateStakeAmount` tests).
2. Wallet balance unavailable (RPC error, wallet on another chain) must show "–" for "Available to stake" and disable MAX, not crash the page. Pinned in Task 6 (`availableToStake` test).
3. Several deposits in progress at once must aggregate in the lane and read "N deposits on their way". Pinned in Task 3.
4. A deep link `/activity?deposit=<unknown>` must show the not-found message with a way back, and a link with both params must pick the deposit. Pinned in Task 9 (`parseActivityParams` test).
5. Protocol statistics with a missing value must omit that row rather than show "undefined" or a fake number. Pinned in Task 4 (`statRows` test).

---

## File structure

Data layer (modify): `src/lib/cascade/types.ts`, `chains.ts`, `mock.ts`, `hooks.ts`, `mock.test.ts`; create `chains.test.ts`.
Foundations (modify): `src/app/globals.css`, `src/app/layout.tsx`, `next.config.ts`, `src/lib/wagmi.ts`, `src/components/DemoBanner.tsx`; create `src/lib/site.ts`.
Pure logic (create): `src/lib/lane.ts` + test, `src/lib/stats.ts` + test, `src/lib/stake-form.ts` + test, `src/lib/activity-params.ts` + test, `src/lib/usdc-balance.ts`.
App shell and tabs (create): `src/components/app/AppShell.tsx` + `.module.css`, `WalletPill.tsx`, `ChainChips.tsx`, `AmountField.tsx`, `StakeCard.tsx`, `StakeForm.tsx`, `UnstakeForm.tsx`, `WhereIsMyMoney.tsx`, `StatsCard.tsx`, `Faq.tsx`, `RewardsCard.tsx`, `ActivityScreen.tsx`, `SampleTag.tsx`, `Redirect.tsx`, shared `App.module.css`.
Routes (create/modify/delete): `src/app/page.tsx` (landing), `stake/page.tsx`, `unstake/page.tsx`, `rewards/page.tsx`, `activity/page.tsx`, `deposit/page.tsx` and `withdraw/page.tsx` (redirects), `not-found.tsx`; delete `deposits/[id]/` and `withdrawals/[id]/`.
Landing (create): `src/components/landing/SiteNav.tsx`, `Hero.tsx`, `MoneyFlow.tsx`, `HowItWorks.tsx`, `StakeSection.tsx`, `SecureByDesign.tsx`, `SiteFooter.tsx`, `LandingPage.tsx`, `Landing.module.css`, `MoneyFlow.module.css`.
Delete after replacement: `HomeScreen.tsx` + css, `Landing.tsx` (old) + css, `ProofBox.tsx` + css, `DepositScreen.tsx`, `WithdrawScreen.tsx`, `TrailScreens.tsx`, `ChainPicker.tsx`, `RequireAccount.tsx`, `TopBar.tsx` + css, `AccountMenu.tsx`, `ActivityList.module.css` (if unused). Keep and reuse: `Logo.tsx`, `Trail.tsx` + css, `ReceiptLink.tsx`, `ConnectWallet.tsx` (restyled), `Providers.tsx`, `lib/account.ts`, `lib/client-state.ts`, `lib/format.ts`.

---

### Task 1: Data contract additions

**Files:**
- Modify: `src/lib/cascade/types.ts`, `src/lib/cascade/chains.ts`, `src/lib/cascade/mock.ts`, `src/lib/cascade/hooks.ts`, `src/lib/wagmi.ts`
- Test: `src/lib/cascade/mock.test.ts`, `src/lib/cascade/chains.test.ts` (create)

**Interfaces:**
- Produces, in `types.ts`:
  - `SourceChain = "base" | "ethereum" | "arbitrum" | "polygon" | "bnb"`
  - `interface ProtocolStats { aprPercent?: number; totalStakedTao?: number; stakers?: number; taoPriceUsd?: number }`
  - `interface RewardRecord { date: Date; taoAccrued: number; runningTotalTao: number }`
  - `WithdrawalQuote` gains `etaMinutes: number`
  - `CascadeData` gains `readonly source: "mock" | "live"`, `getProtocolStats(): Promise<ProtocolStats>`, `listRewards(account: string): Promise<RewardRecord[]>`, `getUsdcBalance(account: string): Promise<number>`
- Produces, in `chains.ts`: `SourceChainInfo` gains `status: "live" | "soon"`; `SOURCE_CHAINS` order Base, Ethereum, Arbitrum, Polygon, BNB Chain with colors `#0052FF`, `#627EEA`, `#213147`, `#8247E5`, `#F0B90B` and chain ids 8453, 1, 42161, 137, 56; only Base is `live`; new `liveChains(): SourceChainInfo[]`.
- Produces, in `hooks.ts`: `useProtocolStats()`, `useRewards(account)`, `useMockUsdcBalance(account)` (react-query hooks over the new methods), and keys `cascadeKeys.stats()`, `cascadeKeys.rewards(account)`, `cascadeKeys.usdc(account)`.
- Mock values: `source: "mock"`; stats `{ aprPercent: 11.4, totalStakedTao: 12480, stakers: 1204, taoPriceUsd: <price option> }`; USDC balance `2400` for every account; withdrawal `etaMinutes: 1440`; `ROUTE_FEE_USD.arbitrum = 0.3`, `ETA_MINUTES.arbitrum = 13`.
- Reward list rule (settles a spec ambiguity so the numbers reconcile): for each deposit with status `staked`, let `count = max(1, floor((now - stakedAt) / day))` and spread its `rewardsTao` evenly over `count` records dated `min(stakedAt + (i + 1) * day, now)` for `i` in `0..count-1` (so the first record is the day after staking). Merge all deposits' records oldest first; `runningTotalTao` is cumulative across deposits; the final running total equals `getPosition().rewardsEarnedTao` to 4 decimals. Round `taoAccrued` and `runningTotalTao` to 4 decimals and put any rounding remainder on the last record. Deposits still in progress contribute nothing.

- [ ] **Step 1: Write failing tests**

Append to `src/lib/cascade/mock.test.ts`:

```ts
describe("protocol stats, rewards and balances", () => {
  it("reports itself as the mock", () => {
    const { data } = setup();
    expect(data.source).toBe("mock");
  });

  it("returns the sample protocol statistics", async () => {
    const { data } = setup();
    expect(await data.getProtocolStats()).toEqual({
      aprPercent: 11.4,
      totalStakedTao: 12480,
      stakers: 1204,
      taoPriceUsd: 286,
    });
  });

  it("gives every account 2,400 USDC to stake", async () => {
    const { data } = setup();
    expect(await data.getUsdcBalance(ACCOUNT)).toBe(2400);
  });

  it("quotes withdrawals as paid out in about a day", async () => {
    const { data } = setup();
    expect((await data.quoteWithdrawal(1)).etaMinutes).toBe(1440);
  });

  it("spreads each staked deposit's rewards over the days since it staked", async () => {
    const { data } = setup(); // clock is Oct 20 12:00; seed staked Oct 1 09:19
    const rewards = await data.listRewards(ACCOUNT);
    expect(rewards).toHaveLength(19);
    expect(rewards[0].date.getDate()).toBe(2); // the day after it staked on Oct 1
    expect(rewards.at(-1)?.date.getDate()).toBe(20);
    expect(rewards.at(-1)?.runningTotalTao).toBe(0.0213);
    expect(rewards.every((r) => r.taoAccrued > 0)).toBe(true);
    const total = rewards.reduce((s, r) => s + r.taoAccrued, 0);
    expect(Math.round(total * 1e4) / 1e4).toBe(0.0213);
  });

  it("ignores deposits that are still in progress", async () => {
    const { data, advance } = setup();
    await data.startDeposit(ACCOUNT, 100, "base");
    advance(DEMO_STEP_MS); // first step only; not staked
    const rewards = await data.listRewards(ACCOUNT);
    expect(rewards).toHaveLength(19);
    expect(rewards.at(-1)?.runningTotalTao).toBe(0.0213);
  });
});
```

Create `src/lib/cascade/chains.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SOURCE_CHAINS, chainInfo, isSourceChain, liveChains } from "./chains";

describe("source chains", () => {
  it("lists five chains in the approved order", () => {
    expect(SOURCE_CHAINS.map((c) => c.id)).toEqual(["base", "ethereum", "arbitrum", "polygon", "bnb"]);
  });
  it("has Base as the only live chain", () => {
    expect(liveChains().map((c) => c.id)).toEqual(["base"]);
    expect(chainInfo("arbitrum")).toMatchObject({ status: "soon", chainId: 42161, label: "Arbitrum" });
  });
  it("recognises arbitrum", () => {
    expect(isSourceChain("arbitrum")).toBe(true);
    expect(isSourceChain("solana")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test`
Expected: FAIL on the new tests (`source`, `getProtocolStats`, `getUsdcBalance`, `listRewards`, `liveChains` undefined; `etaMinutes` undefined).

- [ ] **Step 3: Implement the additions**

`types.ts`: add the types and members listed in Interfaces. `chains.ts`: extend the list and add `liveChains()`. `mock.ts`: add the constants, the `arbitrum` entries, `source`, `getProtocolStats`, `getUsdcBalance`, `etaMinutes` on withdrawal quotes, and `listRewards` per the reward list rule (use the seed deposit's `stepTimes[3]` as its staked time). `hooks.ts`: add the three hooks and keys (stats and USDC poll at `IDLE_MS`; rewards do not poll). `wagmi.ts`: add `arbitrum` from `wagmi/chains` to `chains` and `transports`.

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass. The existing "matches the approved mockup numbers" seed test still passes (seed numbers are unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/lib/cascade src/lib/wagmi.ts
git commit -m "feat(web): extend the data contract with stats, rewards, balances and chain status"
```

---

### Task 2: Foundations: tokens, font, layout, static export, site config, demo banner

**Files:**
- Modify: `src/app/globals.css`, `src/app/layout.tsx`, `next.config.ts`, `src/components/DemoBanner.tsx`, `src/components/DemoBanner.module.css`
- Create: `src/lib/site.ts`, `src/components/SampleTag.tsx`, `src/components/SampleTag.module.css`

**Interfaces:**
- Produces: CSS custom properties on `:root`: `--ink`, `--ink-2`, `--ink-3`, `--water`, `--water-deep`, `--water-tint`, `--mist`, `--paper` (`#FFFFFF`), `--line`, `--line-soft`, `--proof`, `--proof-tint`, `--amber`, `--amber-tint`, `--shadow` (`0 2px 4px rgba(16,33,43,.04), 0 24px 60px -24px rgba(16,33,43,.18)`), `--r-card: 20px`, `--r-input: 14px`, `--r-pill: 999px`, `--font-sans` (Manrope). Keep `--muted` as an alias of `--ink-2` and `--danger: #b4232a` so existing components compile until they are replaced.
- Global classes: `.wrap` (max-width 1280 px, padding 0 40 px; 20 px below 700 px; 1440 px at min-width 1800 px), `.col` (max-width 560 px, centred), `.pill` (ink pill button, 46 px high, 600 weight) with `.pill-ghost` (white, 1 px line border), `.sr-only`, `.loading`. Remove the 420 px `.page` constraint: `main` renders children with no width limit.
- `src/lib/site.ts` exports `SITE_LINKS = { github, security, docs }` (URLs from Global Constraints) and `AUDIT_STATUS: "scheduled" | "done" = "scheduled"`.
- `SampleTag` renders a small pill reading "sample" (title "Sample figure from the demo data") and nothing when `useCascadeData().source !== "mock"`.
- `DemoBanner` becomes a client component that renders only when `useCascadeData().source === "mock"`; text unchanged ("Demo with made-up numbers. No real money moves.").

- [ ] **Step 1: Switch the font and tokens**

In `layout.tsx` replace `Schibsted_Grotesk` with `Manrope` (`weight: ["300","400","500","600","700"]`, `variable: "--font-sans"`, `display: "swap"`). Rewrite the `:root` block of `globals.css` with the tokens above; set `body { background: var(--paper); color: var(--ink); font-size: 16px; line-height: 1.5 }`; replace `.page` with the `.wrap` / `.col` / `.pill` classes; keep `.btn*` classes for now.

- [ ] **Step 2: Static export**

In `next.config.ts` add `output: "export"`. Keep `reactStrictMode` and `serverExternalPackages`.

- [ ] **Step 3: Site config, SampleTag, conditional DemoBanner**

Create the three files per Interfaces.

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: build succeeds and `out/index.html` exists. (The old dynamic routes `deposits/[id]` and `withdrawals/[id]` will fail the export with "Page is missing generateStaticParams". If so, add `export function generateStaticParams() { return []; }` plus `export const dynamicParams = false;` to both pages as a stopgap; Task 9 deletes them.)

- [ ] **Step 5: Commit**

```bash
git add next.config.ts src/app/globals.css src/app/layout.tsx src/lib/site.ts src/components/DemoBanner.tsx src/components/DemoBanner.module.css src/components/SampleTag.tsx src/components/SampleTag.module.css src/app/deposits src/app/withdrawals
git commit -m "feat(web): design tokens, Manrope, static export, site config, sample tag"
```

---

### Task 3: "Where your money is right now" lane

**Files:**
- Create: `src/lib/lane.ts`, `src/lib/lane.test.ts`, `src/components/app/WhereIsMyMoney.tsx`, `src/components/app/WhereIsMyMoney.module.css`

**Interfaces:**
- Consumes: `DepositRecord`, `StakeProof`, `DepositStepKey` from `src/lib/cascade/types.ts`; `formatTao`, `formatUsdc`, `formatRelative` from `src/lib/format.ts`.
- Produces, in `lane.ts`:
  ```ts
  export interface LaneNode { amount: string; label: string; state: "muted" | "live" | "done"; href?: string }
  export interface LaneInput { usdcBalance: number | null; deposits: DepositRecord[]; proof: StakeProof | null }
  export function deriveLane(input: LaneInput): [LaneNode, LaneNode, LaneNode]
  export const TRANSIT_PHRASE: Record<DepositStepKey, string> = { received: "waiting for your USDC", swapped: "swapping for TAO", bridged: "crossing to Bittensor", staked: "being staked" }
  ```
  Rules: node 1 amount `"${formatUsdc(balance)} USDC"` label "in your wallet on Base", state `muted` always (`"–"` and label "balance unavailable" when `null`). Node 2 sums `taoAmount` of deposits with status `in_progress`; 0 → `"0 TAO"`, "nothing in transit", `muted`; 1 → amount `"${formatTao(sum, 2)} TAO"`, label `"${TRANSIT_PHRASE[activeKey]}, step ${n} of 4"` where the active step is the one with status `active` (n = its index + 1), state `live`; >1 → label `"${count} deposits on their way"`, `live`. Node 3 from `proof`: `stakedTao > 0` → `"${formatTao(stakedTao, 2)} TAO"`, "staked on Bittensor", `done`, `href: proof.explorerUrl`; otherwise `"0 TAO"`, "nothing staked yet", `muted`; `proof === null` → `"–"`, "checking", `muted`.
- `WhereIsMyMoney({ account })` renders the section heading "Where your money is right now", the right-hand link "Checked on-chain {formatRelative(proof.checkedAt, now)}" (uses `useNow`), and the three-node lane card styled like the mockup (`.lane`, `.node`, `.node.live`, `.node.done`; connecting line between nodes; "See it" link via `ReceiptLink` on node 3 when `href`). Reads `useDeposits`, `useProof`, and the USDC balance via the hook from Task 6 (`useUsdcBalance(account)`); until Task 6 exists, import `useMockUsdcBalance` from `hooks.ts` and switch in Task 6.

- [ ] **Step 1: Write the failing tests**

`src/lib/lane.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveLane } from "./lane";
import type { DepositRecord, StakeProof } from "./cascade/types";

const proof: StakeProof = { allStaked: true, stakedTao: 3.86, owedTao: 3.86, checkedAt: new Date(), validatorHotkey: "5F", explorerUrl: "https://x/stake" };
const steps = (active: number) =>
  (["received", "swapped", "bridged", "staked"] as const).map((key, i) => ({
    key, title: key, status: i < active ? "done" : i === active ? "active" : "pending",
  })) as DepositRecord["steps"];
const dep = (id: string, tao: number, active: number): DepositRecord => ({
  id, createdAt: new Date(), amountUsd: 500, sourceChain: "base", status: active >= 4 ? "staked" : "in_progress",
  steps: steps(active), taoAmount: tao, feesUsd: 1.9, taoPriceUsd: 271.18, rewardsTao: 0,
});

describe("deriveLane", () => {
  it("shows one deposit's phrase and step", () => {
    const [w, t, s] = deriveLane({ usdcBalance: 2400, deposits: [dep("a", 2.03, 2)], proof });
    expect(w).toEqual({ amount: "2,400 USDC", label: "in your wallet on Base", state: "muted" });
    expect(t).toEqual({ amount: "2.03 TAO", label: "crossing to Bittensor, step 3 of 4", state: "live" });
    expect(s).toEqual({ amount: "3.86 TAO", label: "staked on Bittensor", state: "done", href: "https://x/stake" });
  });
  it("adds up several deposits in transit", () => {
    const [, t] = deriveLane({ usdcBalance: 0, deposits: [dep("a", 1, 1), dep("b", 2.5, 3), dep("c", 9, 4)], proof });
    expect(t).toEqual({ amount: "3.50 TAO", label: "2 deposits on their way", state: "live" });
  });
  it("mutes empty nodes and keeps the lane shape", () => {
    const lane = deriveLane({ usdcBalance: null, deposits: [], proof: { ...proof, stakedTao: 0 } });
    expect(lane.map((n) => n.state)).toEqual(["muted", "muted", "muted"]);
    expect(lane[0].amount).toBe("–");
    expect(lane[1].label).toBe("nothing in transit");
    expect(lane[2].label).toBe("nothing staked yet");
  });
  it("says it is checking while the proof loads", () => {
    expect(deriveLane({ usdcBalance: 1, deposits: [], proof: null })[2]).toEqual({ amount: "–", label: "checking", state: "muted" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/lib/lane.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lane.ts`, then the component and its stylesheet**

- [ ] **Step 4: Verify**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lane.ts src/lib/lane.test.ts src/components/app/WhereIsMyMoney.tsx src/components/app/WhereIsMyMoney.module.css
git commit -m "feat(web): where-your-money-is lane with pure derivation"
```

---

### Task 4: Statistics card, FAQ, stat rows helper

**Files:**
- Create: `src/lib/stats.ts`, `src/lib/stats.test.ts`, `src/components/app/StatsCard.tsx`, `src/components/app/Faq.tsx`, `src/components/app/App.module.css`

**Interfaces:**
- Consumes: `ProtocolStats` (Task 1), `useProtocolStats` (Task 1), `SampleTag` (Task 2), `formatTao`, `formatUsd`, `formatPercent`.
- Produces, in `stats.ts`: `export interface StatRow { label: string; value: string; accent?: boolean }` and `export function statRows(stats: ProtocolStats): StatRow[]` producing, in order and only when defined: `{ label: "Annual percentage rate*", value: "11.4%", accent: true }`, `{ label: "Total staked through Cascade", value: "12,480 TAO" }` (whole TAO: `formatTao(n, 0)`), `{ label: "Stakers", value: "1,204" }`, `{ label: "TAO price", value: "$286.00" }`. Also `export function formatApr(aprPercent: number): string` → `"11.4%"` (one decimal).
- `StatsCard({ explorerUrl?: string })` renders heading "Cascade statistics", a right-hand "View on Bittensor" link only when `explorerUrl` is passed (callers pass `proof.explorerUrl` when they have a proof; never a placeholder), the rows from `statRows`, a `SampleTag` beside each value when `source === "mock"`, and the footnote "*APR is an estimate based on recent rewards. It is not guaranteed and changes with network conditions."
- `Faq()` renders the six `details` items from the spec; the first has `open`; summary text exactly: "What is Cascade?", "Do I need a Bittensor wallet?", "Where is my TAO staked?", "What are the fees?", "How do I unstake?", "Is there a lock-up?"; answers copied from the mockup.
- `App.module.css` holds the shared card styles: `.card`, `.cardRows`, `.secHead`, `.faq`, `.footnote`.

- [ ] **Step 1: Write the failing test**

`src/lib/stats.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatApr, statRows } from "./stats";

describe("statRows", () => {
  it("formats the four rows in order", () => {
    expect(statRows({ aprPercent: 11.4, totalStakedTao: 12480, stakers: 1204, taoPriceUsd: 286 })).toEqual([
      { label: "Annual percentage rate*", value: "11.4%", accent: true },
      { label: "Total staked through Cascade", value: "12,480 TAO" },
      { label: "Stakers", value: "1,204" },
      { label: "TAO price", value: "$286.00" },
    ]);
  });
  it("omits rows whose value is missing", () => {
    expect(statRows({ aprPercent: 9.05 }).map((r) => r.label)).toEqual(["Annual percentage rate*"]);
    expect(statRows({})).toEqual([]);
  });
  it("formats APR with one decimal", () => {
    expect(formatApr(11.4)).toBe("11.4%");
    expect(formatApr(9)).toBe("9.0%");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm test src/lib/stats.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `stats.ts`, `StatsCard`, `Faq`, shared styles**

- [ ] **Step 4: Verify** — `pnpm test && pnpm typecheck && pnpm lint` → pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/stats.ts src/lib/stats.test.ts src/components/app
git commit -m "feat(web): statistics card with sample tags and FAQ"
```

---

### Task 5: Stake form: chain chips, amount field, button logic

**Files:**
- Create: `src/lib/stake-form.ts`, `src/lib/stake-form.test.ts`, `src/components/app/ChainChips.tsx`, `src/components/app/AmountField.tsx`, `src/components/app/StakeForm.tsx`, `src/components/app/StakeForm.module.css`
- Modify: `src/components/ConnectWallet.tsx` (+ move its styles out of `Landing.module.css` into `src/components/ConnectWallet.module.css`)

**Interfaces:**
- Consumes: `SOURCE_CHAINS`, `liveChains` (Task 1); `useDepositQuote`, `useStartDeposit`, `useCascadeData` (hooks); `sanitizeAmountInput`, `parseAmount`, `formatUsdShort`, `formatTao`, `formatUsd` (format); `formatApr` (Task 4).
- Produces, in `stake-form.ts`:
  ```ts
  export type StakeState = { account: string | null; amount: number | null; error: string | null; pending: boolean }
  export function validateStakeAmount(amount: number | null, limits: { minUsd: number; maxUsd: number }): string | null
  export function stakeButtonLabel(s: StakeState): string
  ```
  `validateStakeAmount`: `null` → `null`; below min → `"The smallest stake is $10."` (uses `formatUsdShort(limits.minUsd)`); above max → `"The most you can stake right now is $50,000."`; otherwise `null`.
  `stakeButtonLabel`: no account → `"Connect wallet"`; pending → `"Starting your stake…"`; valid amount (non-null, no error) → `"Stake ${formatUsdc(amount)} USDC"` (for example "Stake 500 USDC"); otherwise `"Stake"`.
- `ChainChips({ value, onChange })`: a row of pill chips from `SOURCE_CHAINS`; live chips are `button`s with `aria-pressed`; `soon` chips are disabled buttons with a "Soon" tag and `aria-disabled`; colour dot per chain. Row wraps on desktop and scrolls horizontally below 480 px.
- `AmountField({ id, value, onChange, unit: "USDC" | "TAO", onMax?, maxDisabled?, invalid? })`: the mockup's input with the token selector on the left (coin dot + unit), the text input in the middle (`inputMode="decimal"`, placeholder `"${unit} amount"`), and a MAX button on the right (only when `onMax` is given).
- `StakeForm({ account, initialAmount? })`: label "Deposit from" + `ChainChips`; label "Amount" + `AmountField` (USDC, MAX sets the USDC balance when `account` is set and a balance is known); the primary pill button whose text is `stakeButtonLabel`; with `account === null` the button opens the existing `ConnectWallet` chooser (render `ConnectWallet` in pill style); the details list rows "You will receive" (`about ${formatTao(estTao, 2)} TAO`), "TAO price", "Staking yield" (`formatApr(stats.aprPercent)` in water-deep with a `SampleTag`), "Fees", "Staked in" (`about ${etaMinutes} minutes`); rows show "–" until a quote exists. On success, `router.push("/activity?deposit=" + id)`. Errors from `startDeposit` render in a `role="alert"` paragraph. Below the button: the line "One transaction from your wallet. No Bittensor wallet needed."
- `ConnectWallet` keeps its behaviour, gains a `variant: "pill" | "pill-block"` prop and its own stylesheet.

- [ ] **Step 1: Write the failing tests**

`src/lib/stake-form.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { stakeButtonLabel, validateStakeAmount } from "./stake-form";
import { parseAmount, sanitizeAmountInput } from "./format";

const limits = { minUsd: 10, maxUsd: 50_000 };

describe("validateStakeAmount", () => {
  it("accepts amounts within limits", () => {
    expect(validateStakeAmount(500, limits)).toBeNull();
    expect(validateStakeAmount(null, limits)).toBeNull();
  });
  it("rejects below and above the limits in plain words", () => {
    expect(validateStakeAmount(5, limits)).toBe("The smallest stake is $10.");
    expect(validateStakeAmount(50_001, limits)).toBe("The most you can stake right now is $50,000.");
  });
  it("copes with pasted and odd input through the sanitizer", () => {
    expect(validateStakeAmount(parseAmount(sanitizeAmountInput("$1,000", 2)), limits)).toBeNull();
    expect(parseAmount(sanitizeAmountInput("1e5", 2))).toBe(15);
    expect(parseAmount(sanitizeAmountInput("0.", 2))).toBe(0);
    expect(validateStakeAmount(0, limits)).toBe("The smallest stake is $10.");
  });
});

describe("stakeButtonLabel", () => {
  it("asks to connect first", () => {
    expect(stakeButtonLabel({ account: null, amount: 500, error: null, pending: false })).toBe("Connect wallet");
  });
  it("names the amount once it is valid", () => {
    expect(stakeButtonLabel({ account: "0xa", amount: 500, error: null, pending: false })).toBe("Stake 500 USDC");
    expect(stakeButtonLabel({ account: "0xa", amount: 1234.5, error: null, pending: false })).toBe("Stake 1,234.50 USDC");
  });
  it("falls back to the bare verb and shows progress", () => {
    expect(stakeButtonLabel({ account: "0xa", amount: null, error: null, pending: false })).toBe("Stake");
    expect(stakeButtonLabel({ account: "0xa", amount: 5, error: "too small", pending: false })).toBe("Stake");
    expect(stakeButtonLabel({ account: "0xa", amount: 500, error: null, pending: true })).toBe("Starting your stake…");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm test src/lib/stake-form.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `stake-form.ts`, then `ChainChips`, `AmountField`, `StakeForm`, restyle `ConnectWallet`**

- [ ] **Step 4: Verify** — `pnpm test && pnpm typecheck && pnpm lint` → pass. (`StakeForm` is not yet rendered by any route; that is Task 6.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/stake-form.ts src/lib/stake-form.test.ts src/components/app src/components/ConnectWallet.tsx src/components/ConnectWallet.module.css src/components/Landing.module.css
git commit -m "feat(web): stake form with chain chips, amount field and connect state"
```

---

### Task 6: App shell and the `/stake` page

**Files:**
- Create: `src/lib/usdc-balance.ts`, `src/lib/usdc-balance.test.ts`, `src/components/app/AppShell.tsx`, `src/components/app/AppShell.module.css`, `src/components/app/WalletPill.tsx`, `src/components/app/StakeCard.tsx`, `src/components/app/Redirect.tsx`, `src/app/stake/page.tsx`
- Modify: `src/app/deposit/page.tsx` (becomes a redirect), `src/components/app/WhereIsMyMoney.tsx` (switch to `useUsdcBalance`)

**Interfaces:**
- Consumes: `useCascadeAccount` (`lib/account.ts`, states `loading | none | wallet | demo`, `signOut`, `startDemo`); `useMockUsdcBalance` (Task 1); wagmi `useReadContract`; `StakeForm` (Task 5); `WhereIsMyMoney` (Task 3); `StatsCard`, `Faq` (Task 4); `usePosition`, `useProof`, `useProtocolStats`.
- Produces, in `usdc-balance.ts`:
  ```ts
  export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const; // 6 decimals
  export type BalanceQuery = { status: "pending" | "error" | "success"; data?: number }
  export function availableToStake(q: BalanceQuery): { text: string; max: number | null }
  export function useUsdcBalance(state: AccountState): BalanceQuery  // "use client"
  ```
  `availableToStake`: success → `{ text: "${formatUsdc(data)} USDC", max: data }`; pending → `{ text: "–", max: null }`; error → `{ text: "–", max: null }`. `useUsdcBalance`: demo → `useMockUsdcBalance`; wallet → `useReadContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [account], chainId: base.id })` mapped to a number with 6 decimals; none/loading → pending.
- `AppShell({ active, children })`: the mist page background; top bar with `Logo`, the four pill tabs (Stake `/stake`, Unstake `/unstake`, Rewards `/rewards`, Activity `/activity`) with the small line icons from the mockup, the network pill "Base", and `WalletPill`; then `<div class="col">{children}</div>`. The demo banner (Task 2) stays in the root layout.
- `WalletPill()`: wallet or demo → pill showing `availableToStake(...).text` and the short address (or "Demo account"), with a popover menu to "Disconnect" / "Leave the demo" (port the existing `AccountMenu` behaviour); no account → the `ConnectWallet` pill (Task 5).
- `StakeCard({ account })`: the main card; summary half (Available to stake with the live dot, Network, Staked `${formatTao(taoBalance, 2)} TAO` with `formatUsd(usdValue)` small, Cascade APR* with `SampleTag`), form half = `StakeForm`. With `account === null` the summary shows "–" for the account figures and the APR still shows.
- `/stake/page.tsx`: `<AppShell active="stake">` → title "Stake TAO", sub "Deposit USDC and earn TAO staking rewards", `StakeCard`, `WhereIsMyMoney` (only with an account), `StatsCard` (with `explorerUrl` from the proof when available), `Faq`. Never redirects.
- `Redirect({ to })`: client component: `useEffect(() => router.replace(to))` plus a visible link "Continue to {to}" for no-JS. `/deposit/page.tsx` renders `<Redirect to="/stake" />`.

- [ ] **Step 1: Write the failing test**

`src/lib/usdc-balance.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { availableToStake } from "./usdc-balance";

describe("availableToStake", () => {
  it("shows the balance and enables MAX", () => {
    expect(availableToStake({ status: "success", data: 2400 })).toEqual({ text: "2,400 USDC", max: 2400 });
    expect(availableToStake({ status: "success", data: 12.5 })).toEqual({ text: "12.50 USDC", max: 12.5 });
  });
  it("shows a dash and disables MAX while loading or on error", () => {
    expect(availableToStake({ status: "pending" })).toEqual({ text: "–", max: null });
    expect(availableToStake({ status: "error" })).toEqual({ text: "–", max: null });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm test src/lib/usdc-balance.test.ts` → FAIL.

- [ ] **Step 3: Implement `usdc-balance.ts`, `AppShell`, `WalletPill`, `StakeCard`, `Redirect`, the `/stake` route and the `/deposit` redirect; point `WhereIsMyMoney` at `useUsdcBalance`**

- [ ] **Step 4: Verify**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: pass; `out/stake.html` (or `out/stake/index.html`) exists. Then `pnpm dev -p 3001`, open `http://localhost:3001/stake`: with no account the form shows "Connect wallet" and the summary shows dashes; click "See the demo" is not on this page, so set demo mode by opening `/` later (Task 10) or by running `localStorage.setItem("cascade.demoMode","1")` in the console and reloading: the summary shows 2,400 USDC, 3.66 TAO, APR with sample tag; the lane shows three nodes. Compare with the mockup's stake page. Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add src/lib/usdc-balance.ts src/lib/usdc-balance.test.ts src/components/app src/app/stake src/app/deposit
git commit -m "feat(web): app shell, wallet pill and the stake page"
```

---

### Task 7: Unstake tab

**Files:**
- Create: `src/components/app/UnstakeForm.tsx`, `src/app/unstake/page.tsx`
- Modify: `src/lib/stake-form.ts` (+ test), `src/app/withdraw/page.tsx` (redirect)

**Interfaces:**
- Consumes: `usePosition`, `useWithdrawalQuote`, `useStartWithdrawal`; `AmountField` (unit "TAO", MAX = `taoBalance`); `AppShell`; `WalletPill`.
- Produces, in `stake-form.ts`: `export function unstakeButtonLabel(s: StakeState): string` → no account "Connect wallet"; pending "Starting your unstake…"; valid `"Unstake ${formatTao(amount, 2)} TAO"`; else "Unstake". `export function validateUnstakeAmount(amount: number | null, balance: number): string | null` → over balance: `"You have ${formatTao(balance, 2)} TAO staked."`; `amount === 0` → `"Enter how much TAO to unstake."`; else `null`.
- `UnstakeForm({ account })` mirrors `StakeForm`: summary rows handled by the page; form: "Amount" + `AmountField` (TAO); details list: "You will receive" (`about ${formatUsdc(usdcAmount)} USDC`), "TAO price", "Fees", "Paid out in" (`about ${Math.round(etaMinutes / 60)} hours`); button via `unstakeButtonLabel`; success → `router.push("/activity?withdrawal=" + id)`; empty balance → the card says "Nothing staked yet. Stake some USDC first." with a pill link to `/stake`.
- `/unstake/page.tsx`: `<AppShell active="unstake">`, title "Unstake TAO", sub "Get USDC back in the same wallet on Base", a card whose summary half shows Staked and Available to unstake (same value) and whose form half is `UnstakeForm`, then `StatsCard` and `Faq`. `/withdraw/page.tsx` → `<Redirect to="/unstake" />`.

- [ ] **Step 1: Write the failing tests** (append to `src/lib/stake-form.test.ts`)

```ts
describe("unstake helpers", () => {
  it("labels the button", () => {
    expect(unstakeButtonLabel({ account: null, amount: 1, error: null, pending: false })).toBe("Connect wallet");
    expect(unstakeButtonLabel({ account: "0xa", amount: 1.5, error: null, pending: false })).toBe("Unstake 1.50 TAO");
    expect(unstakeButtonLabel({ account: "0xa", amount: null, error: null, pending: false })).toBe("Unstake");
  });
  it("validates against the staked balance", () => {
    expect(validateUnstakeAmount(4, 3.66)).toBe("You have 3.66 TAO staked.");
    expect(validateUnstakeAmount(0, 3.66)).toBe("Enter how much TAO to unstake.");
    expect(validateUnstakeAmount(1, 3.66)).toBeNull();
    expect(validateUnstakeAmount(null, 3.66)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm test src/lib/stake-form.test.ts` → FAIL on the new describe.

- [ ] **Step 3: Implement the helpers, `UnstakeForm`, the route and the redirect**

- [ ] **Step 4: Verify** — `pnpm test && pnpm typecheck && pnpm lint && pnpm build` → pass. Visual check of `/unstake` in demo mode: MAX fills 3.66, estimate rows fill, "Paid out in about 24 hours".

- [ ] **Step 5: Commit**

```bash
git add src/lib/stake-form.ts src/lib/stake-form.test.ts src/components/app/UnstakeForm.tsx src/app/unstake src/app/withdraw
git commit -m "feat(web): unstake tab"
```

---

### Task 8: Rewards tab

**Files:**
- Create: `src/components/app/RewardsCard.tsx`, `src/app/rewards/page.tsx`

**Interfaces:**
- Consumes: `useRewards(account)`, `usePosition`, `useProtocolStats` (Task 1); `formatTao`, `formatUsd`, `formatDay`; `formatApr`; `SampleTag`; `AppShell`.
- Produces: `RewardsCard({ account })`: one card. Top: "Earned so far" `${formatTao(rewardsEarnedTao, 4)} TAO` with `formatUsd(rewardsEarnedTao * taoPriceUsd)` beside it, and "Current APR*" with `SampleTag`. Below: a list of the last 14 `RewardRecord`s newest first, each row `formatDay(date)` left, `+${formatTao(taoAccrued, 4)} TAO` right, running total small. Empty list → "Rewards start the day after your first deposit is staked." No account → the card shows the APR and the empty-state line with a "Connect wallet" pill.
- `/rewards/page.tsx`: `<AppShell active="rewards">`, title "Rewards", sub "What your staked TAO has earned", `RewardsCard`, the APR footnote (same text as Task 4). The list's empty-state line "Rewards start the day after your first deposit is staked." matches the reward list rule in Task 1 (first record dated the day after staking).

- [ ] **Step 1: Implement the card and route** (logic is covered by Task 1's `listRewards` tests)

- [ ] **Step 2: Verify** — `pnpm typecheck && pnpm lint && pnpm build` → pass. Visual check in demo mode: 14 rows, running total ends at 0.0213.

- [ ] **Step 3: Commit**

```bash
git add src/components/app/RewardsCard.tsx src/app/rewards
git commit -m "feat(web): rewards tab"
```

---

### Task 9: Activity tab with receipt detail, and removal of the old routes

**Files:**
- Create: `src/lib/activity-params.ts`, `src/lib/activity-params.test.ts`, `src/components/app/ActivityScreen.tsx`, `src/components/app/ActivityScreen.module.css`, `src/app/activity/page.tsx`
- Modify: `src/components/ActivityList.tsx` (restyle to the mockup rows), `src/components/Trail.tsx` (no behaviour change; restyle), `src/app/not-found.tsx`
- Delete: `src/app/deposits/`, `src/app/withdrawals/`, `src/components/TrailScreens.tsx`, `src/components/DepositScreen.tsx`, `src/components/WithdrawScreen.tsx`, `src/components/ChainPicker.tsx`, `src/components/RequireAccount.tsx` (move `Loading` into `src/components/Loading.tsx`), `src/components/TopBar.tsx` + `TopBar.module.css`, `src/components/AccountMenu.tsx`, `src/components/HomeScreen.tsx` + css, `src/components/ProofBox.tsx` + css, `src/components/Form.module.css`

**Interfaces:**
- Consumes: `useDeposits`, `useWithdrawals`, `useDeposit`, `useWithdrawal`; `Trail`; `ReceiptLink`; `chainInfo`.
- Produces, in `activity-params.ts`: `export type ActivityView = { kind: "list" } | { kind: "deposit"; id: string } | { kind: "withdrawal"; id: string }` and `export function parseActivityParams(params: URLSearchParams): ActivityView` → `deposit` wins over `withdrawal` when both are present; empty values count as absent.
- `ActivityScreen({ account })`: reads `useSearchParams()` inside a `<Suspense>` boundary (required for static export). List view: "Your deposits" rows (amount from chain; `about N TAO at $price` or `N TAO at $price`; status chip "On its way" with the four-bar progress and the active step's phrase from `TRANSIT_PHRASE`, or "Staked" with `+N TAO earned so far`; chevron; each row links to `/activity?deposit=<id>`) and "Your withdrawals" rows (`N TAO to USDC`, chip "On its way"/"Paid", link `/activity?withdrawal=<id>`). Detail view: a "Back to activity" link, the title ("Where your $500 is going" / "went", as today), `Trail`, and the summary rows from today's `TrailScreens`. Unknown id → "We couldn't find this deposit." / "withdrawal." with "It may belong to a different wallet." and the back link. No account → the empty-state card "Connect a wallet to see your activity." with the connect pill.
- `/activity/page.tsx`: `<AppShell active="activity">`, title "Activity", `ActivityScreen`.
- `not-found.tsx`: restyle using `.col`; link text "Go to the stake page" → `/stake`.

- [ ] **Step 1: Write the failing test**

`src/lib/activity-params.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseActivityParams } from "./activity-params";

describe("parseActivityParams", () => {
  it("defaults to the list", () => {
    expect(parseActivityParams(new URLSearchParams(""))).toEqual({ kind: "list" });
    expect(parseActivityParams(new URLSearchParams("deposit="))).toEqual({ kind: "list" });
  });
  it("picks a deposit or a withdrawal", () => {
    expect(parseActivityParams(new URLSearchParams("deposit=d-1"))).toEqual({ kind: "deposit", id: "d-1" });
    expect(parseActivityParams(new URLSearchParams("withdrawal=w-9"))).toEqual({ kind: "withdrawal", id: "w-9" });
  });
  it("prefers the deposit when both are given", () => {
    expect(parseActivityParams(new URLSearchParams("withdrawal=w&deposit=d"))).toEqual({ kind: "deposit", id: "d" });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm test src/lib/activity-params.test.ts` → FAIL.

- [ ] **Step 3: Implement the parser, `ActivityScreen`, the route; restyle `ActivityList` and `Trail`; delete the old routes and components; fix every import they leave behind**

- [ ] **Step 4: Verify**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: pass with no `generateStaticParams` stopgap left in the tree (`git grep generateStaticParams src` prints nothing). Visual check in demo mode: `/activity` lists the Oct 1 deposit; clicking it opens the trail at `/activity?deposit=oct-1-base`; `/activity?deposit=nope` shows the not-found message; starting a stake from `/stake` lands on its trail and the row shows "On its way" with the bars advancing.

- [ ] **Step 5: Commit**

```bash
git add -A src/app src/components src/lib
git commit -m "feat(web): activity tab with receipt detail; remove the old routes and screens"
```

(`git add -A` is scoped to `src/`; check `git status` first so nothing outside `web/src` is staged.)

---

### Task 10: Landing page

**Files:**
- Create: `src/components/landing/SiteNav.tsx`, `Hero.tsx`, `MoneyFlow.tsx`, `MoneyFlow.module.css`, `HowItWorks.tsx`, `StakeSection.tsx`, `SecureByDesign.tsx`, `SiteFooter.tsx`, `LandingPage.tsx`, `Landing.module.css`
- Modify: `src/app/page.tsx`
- Delete: `src/components/Landing.tsx`, the old `src/components/Landing.module.css` (replace with the new one in `landing/`)

**Interfaces:**
- Consumes: `useProtocolStats`, `useDepositQuote` (sample quote: `quoteDeposit(500, "base")`), `StakeForm` (Task 5, with `account` from `useCascadeAccount` or `null`, `initialAmount="500"`), `SampleTag`, `SITE_LINKS`, `AUDIT_STATUS`, `SOURCE_CHAINS`, `formatApr`, `formatTao`, `formatUsd`, `useCascadeAccount().startDemo`.
- Produces: `LandingPage()` composing the sections in this order: `SiteNav`, `Hero`, `HowItWorks`, `StakeSection`, `SecureByDesign`, `SiteFooter`. `/` always renders it (no account gate).
- `SiteNav`: 100 px bar: `Logo` left; links "Stake" (`/stake`), "How it works" (`#how`), "Security" (`#secure`), "Docs" (`SITE_LINKS.docs`); right pill "Stake TAO" → `/stake`. Below 1000 px the centre links hide and a "Menu" button toggles them as a stacked list.
- `Hero`: grid 1.05fr / 1fr. Left `MoneyFlow`. Right: `h1` "Get exposure to" + `strong` "TAO staking"; sub-line exactly as the spec; stats row: `formatApr(aprPercent)` + "APR, paid in TAO*" (+ `SampleTag`), vertical rule, `formatUsdShort(Math.round(totalStakedTao * taoPriceUsd))` (whole dollars, for example "$3,569,280") + "staked through Cascade**" (+ `SampleTag`), black pill "Stake" → `/stake`; then the "Deposit from" chip row (read-only chips from `SOURCE_CHAINS`, soon chips dashed with the "Soon" tag); footnote "*Average over the last 7 days. Changes with the network and is not guaranteed. **Sample figure." (drop the second sentence when `source === "live"`). Soft halo: the `::before` radial washes from the mockup. Secondary action under the stats: a text link "See the demo" that calls `startDemo()` and navigates to `/stake`.
- `MoneyFlow`: fixed 600 × 430 coordinate space, scaled with `transform: scale()` to fit its column (1.18 at ≥1800 px); the SVG route `M44 92 H214 V206 H384 V320 H556` with a faint base stroke and a dashed water stroke; three `circle`s with `animateMotion` (7 s loop, begins 0 s, 2.3 s, 4.6 s) hidden under `prefers-reduced-motion`; tiles positioned at (44, 78), (230, 192), (400, 306) with `translateY(-100%)`; captions right-aligned to the drops at (202, 134) "swapped for TAO" and (372, 248) "crosses via Chainlink CCIP"; the green end pill at (286, 372) "Rewards land in your balance every day". Tile copy: "Your wallet, on Base" / `${formatUsdc(quote.amountUsd)} USDC` / "Deposited just now"; "Your TAO" / `${formatTao(quote.estTao, 2)} TAO` / `Bought at ${formatUsd(quote.taoPriceUsd)} each`; "Staked on Bittensor" / same TAO with a check / `Earning ${formatApr(apr)} a year in TAO`. Below 1000 px the flow stacks vertically (three tiles with short vertical connectors; no SVG).
- `HowItWorks` (`id="how"`): the title, lede and three descending steps with ledges and faint drops exactly as the mockup and spec.
- `StakeSection` (`id="stake"`, mist background): left copy and three checked points per the spec; right `StakeForm` in a card.
- `SecureByDesign` (`id="secure"`): title, lede, four items with inline SVG icons; the audit item shows the pill "Scheduled" when `AUDIT_STATUS === "scheduled"`.
- `SiteFooter`: `Logo`, the one-line note, links Docs, GitHub, Security (from `SITE_LINKS`).

- [ ] **Step 1: Build the sections and wire `/`**

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: pass. Visual check at widths 360, 768, 1280, 1920 and 2560 against the mockup: hero flow aligned with its path and no overlap; stats and chips readable; "See the demo" lands on `/stake` in demo mode with the banner; nav collapses on phones; dots stop with reduced motion (toggle in DevTools rendering settings).

- [ ] **Step 3: Commit**

```bash
git add src/app/page.tsx src/components/landing
git rm -q src/components/Landing.tsx src/components/Landing.module.css
git commit -m "feat(web): landing page with hero money flow, how it works, stake and security sections"
```

---

### Task 11: Export check, accessibility pass, docs

**Files:**
- Modify: `web/README.md` (create if absent), root `README.md` (web section), `docs/architecture.md` (web section, if it describes the old screens)

- [ ] **Step 1: Full verification**

Run from `web/`: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: all green; `out/` contains `index.html`, `stake`, `unstake`, `rewards`, `activity`, `deposit`, `withdraw`, `404.html`; `git grep -n "generateStaticParams\|/deposits/\|/withdrawals/" src` prints nothing.

- [ ] **Step 2: Serve the export and walk it**

Run: `npx serve out -l 3002` (or `python -m http.server 3002 -d out`), then in a browser: `/` → "Stake TAO" → `/stake` (connect state) → "See the demo" from `/` → `/stake` with banner → stake 500 → trail under Activity → Unstake MAX → Rewards list. Keyboard only: Tab through the nav, chips, amount field, MAX, button; focus is visible everywhere. Check `/deposit` and `/withdraw` redirect. Stop the server.

- [ ] **Step 3: Copy audit**

Run: `git grep -n -i "one approval in metamask\|still on base\|own line, apart\|guardian\|timelock\|stop button\|guaranteed" src`
Expected: only the two footnotes containing "not guaranteed" match.

- [ ] **Step 4: Docs**

`web/README.md`: how to run, test and build the static export; where the data boundary is; the sample-tag rule; the route map. Root `README.md`: update the web paragraph. `docs/architecture.md`: replace any description of the old screens with the four tabs and the landing page.

- [ ] **Step 5: Commit**

```bash
git add web/README.md README.md docs/architecture.md
git commit -m "docs: web app routes, static export and data boundary"
```

---

## Self-review notes

- Spec coverage: landing (Task 10), stake page (Tasks 4–6), other tabs (7–9), data additions (1), sample tags and banner (2, 4, 10), routes and redirects (6, 7, 9), static export (2, 11), links (2, 10), copy rules (Global Constraints + Task 11 audit), accessibility and motion (Global Constraints + Task 10/11 checks).
- One deliberate deviation from the spec's data-layer wording: the reward list spreads each deposit's existing `rewardsTao` evenly across days instead of recomputing from the APR, so the list always adds up to the balance shown. The APR stays a protocol statistic.
- Added beyond the spec's list, implied by its text: `getUsdcBalance` on the mock so the demo account has a USDC balance.
