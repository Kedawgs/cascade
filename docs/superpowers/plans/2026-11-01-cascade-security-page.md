# Cascade Live Security Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public `/security` page on cascadefi.xyz that maps the money flow (wallet → swap → backing → bridge →
vault → validator, and the way back) with live on-chain numbers, fed by a new cached `GET /v1/flow` on the monitor
Worker.

**Architecture:** The monitor already reads both chains every minute and stores the readings in D1. A pure
`flowOf()` in `indexer/src/flow.ts` turns the newest reading of each chain, the in-flight bridge messages and the
stored admin events into a public JSON document of facts. `GET /v1/flow` serves it through the Workers Cache with
CORS for the site. The site (static Next.js export) fetches it client-side, a pure `flowView()` turns it into step
view models and notices, and the page renders the map.

**Tech Stack:** TypeScript; Cloudflare Workers + D1 + Workers Cache (`indexer/`, vitest with
`@cloudflare/vitest-plugin`); Next.js static export, React, TanStack Query (`web/`, vitest in node with
`renderWithCache`/`plainText`); viem.

**Spec:** `docs/superpowers/specs/2026-11-01-cascade-security-page-design.md` (approved 2026-11-01).

**Plan decisions beyond the spec** (made while planning; the spec leaves them to the builder):
- **Contract notices come from the monitor's stored events** (`logs` table: `GuardianProposed`, `BridgeProposed`,
  `FrontDoorProposed`, `OwnershipTransferStarted`, `Paused`, with their cancel/activate/accept/unpause
  counterparts), which carry the earliest time (`readyAt`) and the transaction hash. This replaces the spec's
  "add the three proposal times to the per-minute call": no multicall change is needed for notices, and the links
  go to the transaction. The spec is amended in Task 1's commit.
- **The swap cost figure is a real quote.** The monitor adds two Uniswap QuoterV2 reads to its Base multicall (the
  same paths and quoter the site uses). The page shows "A $1,000 deposit costs about X% (pool fees and price
  movement)", where X = 1 − (TAO out × the 30-minute average USD price ÷ 1,000). This is more honest than an
  in-range price-impact estimate, which understates thin pools.

## Global Constraints

- Public chain facts only. The endpoint and page never expose alert thresholds, alert state, rule names, the
  monitor's lag limits, holds or the runbook (spec, Anti-goals).
- Copy never says "safe", "secure" or "guaranteed"; it says "monitored", "checked", "passing".
- A chain's newest reading older than **600 seconds** is stale: every number from that chain is "–".
- Base feeds Swap, Bridge (in), Swap to USDC; Bittensor feeds Backing, Vault, Validator, Bridge back.
- Edge cache: the existing `CACHE_TTL_S` (15 s) and `cached()` helper. Client refresh: every **60 s**, only while
  the tab is visible. The page never calls an RPC.
- CORS: `Access-Control-Allow-Origin: cfg.site.origin` (from `SITE_ORIGIN`), as `/v1/scan` does.
- Amounts in the JSON are decimal strings of base units (wei, rao, USDC units); times are unix seconds.
- Work only in the worktree `E:/projects/cascade/.claude/worktrees/security-page` (branch `security-page`). Never
  push, never deploy, never read `.env*` files. Stop at "ready to deploy".
- Commit trailers, exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01X1CCbdP5vJ1r9dnqrYdWaE`
- Commands. Indexer (from `indexer/`): `pnpm test`, `pnpm typecheck`. Web (from `web/`): `pnpm test`,
  `pnpm typecheck`, `pnpm lint`, `pnpm build`.
- cascade.fi is not ours: never reference it.

## Review Focus

1. **A partial tick** (one chain's half of the newest reading missing): that chain's steps show "–", while the
   other chain's numbers still show from its own newest reading. Test in Task 2.
2. **The endpoint unreachable, slow, oversized or malformed** (timeout, 5xx, non-JSON, `v` ≠ 1, missing fields):
   the page shows its can't-check state and never renders half a document. Test in Task 4.
3. **Degenerate numbers:** a bucket with capacity 0 or disabled, wTAO supply 0, a missing TWAP. No division by
   zero, no `Infinity`/`NaN` in the JSON or on screen; the step goes amber or "–". Test in Task 2.
4. **The visitor's clock is wrong:** "checked N min ago" comes from the endpoint's `generatedAt` and the reading
   times, not the browser's clock alone. Test in Task 4.
5. **Leaking a private signal:** the JSON's keys are exactly the allow-listed shape; nothing from `alerts`,
   `holds`, `thresholds` or `cfg.alerts` appears. Test in Task 2.

---

### Task 1: The monitor reads the swap quotes and the USDC pool's depth

**Files:**
- Modify: `indexer/src/snapshot.ts` (`BaseState`, `readSnapshot` Base block), `indexer/src/abi.ts` (a
  `QUOTER_V2` ABI and an `ERC20_BALANCE` view if not present), `indexer/src/config.ts` (`Tokens.base.quoter` and
  the two paths, as constants), `indexer/test/fixtures/v3-test-reads.json` and `indexer/test/worker/fake-rpc.ts` if
  reads are replayed, `docs/superpowers/specs/2026-11-01-cascade-security-page-design.md` (the amendment above)
- Test: `indexer/test/worker/snapshot-quotes.test.ts`, `indexer/test/node/quote-paths.test.ts`

**Interfaces:**
- Produces in `BaseState`:
  ```ts
  /** QuoterV2.quoteExactInput(PATH_USDC_TO_TAO, 1_000e6): TAO wei a $1,000 deposit gets (pool fees included) */
  buyQuote1000?: bigint;
  /** QuoterV2.quoteExactInput(PATH_TAO_TO_USDC, sellSize): USDC units for `sellSize` TAO wei */
  sellQuote?: { taoIn: bigint; usdcOut: bigint };
  /** USDC.balanceOf(wethUsdcPool) */
  wethUsdcPoolUsdc?: bigint;
  ```
  `sellSize` is $1,000 of TAO at the previous Base reading's `oracleValue` (`1_000e6 × 1e18 ÷ oracleValue`); the
  read is skipped (field undefined) when there is no previous `oracleValue`. Pass it in through `SnapshotInputs`.

- [ ] **Step 1: Write the failing tests.** `quote-paths.test.ts` (node): reads `web/src/lib/cascade/config.ts` as
  text and asserts the indexer's quoter address, `PATH_USDC_TO_TAO` and `PATH_TAO_TO_USDC` equal the site's.
  `snapshot-quotes.test.ts` (worker, fake RPC): a reading sets `buyQuote1000`, `sellQuote` (with
  `taoIn == 1_000e6 * 10n**18n / previousOracleValue`) and `wethUsdcPoolUsdc`; with no previous `oracleValue`,
  `sellQuote` is undefined; a reverting quoter leaves the field undefined and every other field set.
- [ ] **Step 2: Run** `pnpm test -- snapshot-quotes quote-paths` — Expected: FAIL.
- [ ] **Step 3: Implement.** Copy the quoter address and paths from `web/src/lib/cascade/config.ts` (`UNISWAP.quoter`,
  `PATH_USDC_TO_TAO`, `PATH_TAO_TO_USDC`); add the three `bp.add` reads; QuoterV2's `quoteExactInput` is
  non-view but answers under `eth_call` inside Multicall3 (use its `amountOut`, the first return value). Amend the
  spec: in "Goals" item 4 and "Where the data comes from", notices come from the monitor's stored contract events
  (which give the earliest time and the transaction), and the swap figure is the quoted cost.
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck` — Expected: PASS (the existing suite unchanged).
- [ ] **Step 5: Commit** `feat(indexer): the reading quotes a $1,000 swap each way and the USDC pool's depth`

### Task 2: `flowOf`, the public flow document

**Files:**
- Create: `indexer/src/flow.ts`
- Test: `indexer/test/worker/flow.test.ts`

**Interfaces:**
- Consumes: `ChainReading<BaseState>`, `ChainReading<BitState>` (`src/snapshot.ts`, Task 1's fields), `Config`.
- Produces (the endpoint's body; Tasks 3 and 4 use these exact names):
  ```ts
  export type Amount = string | null;           // decimal base units; null when unknown or stale
  export interface FlowChain { block: string; time: number; stale: boolean }
  export type NoticeKind =
    | "paused" | "ownershipPending" | "guardianProposed" | "bridgeProposed" | "frontDoorProposed"
    | "fmAdminScheduled" | "fmMigration" | "fmPaused";
  export interface Notice {
    kind: NoticeKind; chain: "base" | "bittensor";
    contract: string;                 // address of the contract it concerns
    target?: string;                  // the proposed guardian / bridge / door / owner / FM admin or migration target
    earliest?: number;                // unix s it can take effect (absent: any time, or not applicable)
    tx?: string;                      // the transaction that started it, when the monitor stored it
  }
  export interface FlowV1 {
    v: 1; deployment: string; generatedAt: number;
    chains: { base: FlowChain | null; bittensor: FlowChain | null };
    swap: { taoWethPoolTao: Amount; wethUsdcPoolUsdc: Amount; twapUsdcPerTao: Amount; spotUsdcPerTao: Amount;
            buyQuote1000Tao: Amount; sellQuote: { taoIn: string; usdcOut: string } | null };
    backing: { alphaBacking: Amount; wTaoSupply: Amount; lockPoolFmTao: Amount; fmTaoSupplyBase: Amount;
               ratioPpm: number | null };   // the lower of the two layers, in parts per million
    bridgeIn: Bucket; bridgeOut: Bucket;
    batch: { nextSendAt: number | null };   // openBatch.start + batchInterval when the open batch holds anything
    vault: { totalAssets: Amount; price: Amount /* TAO per share, 1e18 */; pendingPayouts: Amount;
             nextPayoutAt: number | null; paused: boolean | null };
    validator: { hotkey: string | null; ourStake: Amount; takeBps: number | null; backups: string[] };
    frontDoor: { paused: boolean | null };
    notices: Notice[];
    addresses: { vault: string; frontDoor: string; staker: string; taoWethPool: string; wethUsdcPool: string;
                 alphaVault: string; lockPool: string; baseTokenPool: string; wTao: string; fmTaoBase: string };
  }
  export interface Bucket { roomLeft: Amount; capacity: Amount; perHour: Amount; enabled: boolean | null; inFlight: number }
  export interface FlowInput {
    base: ChainReading<BaseState> | null; bittensor: ChainReading<BitState> | null;
    inFlight: { toBittensor: number; toBase: number };
    adminLogs: { chain: "base" | "bittensor"; address: string; event: string; args: Record<string, string>;
                 txHash: string; block: number }[];   // oldest first
    cfg: Config; nowS: number;
  }
  export const STALE_AFTER_S = 600;
  export function flowOf(i: FlowInput): FlowV1;
  ```
  Rules `flowOf` follows:
  - A chain is stale when `nowS − reading.time > STALE_AFTER_S`; its amounts are null and its booleans null.
  - `ratioPpm` = min(alphaBacking × 1e6 ÷ wTaoSupply, lockPoolFmTao × 1e6 ÷ fmTaoSupplyBase) over the layers whose
    inputs are present and whose divisor is non-zero; null when neither is available. Both layers come from
    Bittensor except `fmTaoSupplyBase` (Base): a stale Base half drops only the second layer.
  - `perHour` = `rate × 3600`; `takeBps` = round(`take` × 10,000 ÷ 65,535), and 1,800 when `take` is null (the
    chain's default, 18%); `backups` = `hotkeys` without `stakeHotkey`.
  - `nextPayoutAt` = min over `payoutBatches` of `queuedAt` + `payoutDelay`, or null.
  - `spotUsdcPerTao` comes from the two pools' `sqrtPriceX96` and `token0`; `twapUsdcPerTao` is `oracleValue`
    (null when `oracleReverted`).
  - Notices: `paused` when a reading says paused (one per contract); `ownershipPending` when `pendingOwner` is
    non-zero (vault, front door, staker), with `tx` from the latest `OwnershipTransferStarted` of that contract;
    `guardianProposed` when `pendingGuardian` is non-zero, `earliest` = the latest `GuardianProposed.readyAt`;
    `bridgeProposed` / `frontDoorProposed` for each proposal event not followed by its activate or cancel event
    for the same target; `fmAdminScheduled` / `fmMigration` / `fmPaused` from `alpha.pendingAdmin`,
    `alpha.migrationReadyAt`/`migrationTarget`, `alpha.pausedUntil > nowS` (no `tx`).

- [ ] **Step 1: Write the failing tests** in `flow.test.ts`, one `it` each:
  `stalesOneChainOnly` (Bittensor reading 601 s old: its amounts null, Base's present), `aMissingHalfIsNull`,
  `backingTakesTheLowerLayer` (alpha 1.0002, lock 0.9990 → `ratioPpm == 999_000`), `zeroSupplyIsNotInfinity`
  (wTaoSupply 0 → that layer skipped; `JSON.stringify` has no `Infinity`/`NaN`/`null` where a number is expected
  beyond the typed nulls), `bucketPerHourAndDisabled`, `nextSendOnlyWithSomethingInTheBatch`,
  `nextPayoutIsTheEarliestBatch`, `takeDefaultsTo1800`, `backupsExcludeTheStakeHotkey`,
  `noticesFromStateAndLogs` (a `BridgeProposed` then `BridgeActivated` → no notice; a second `BridgeProposed` →
  one notice with `earliest` = its `readyAt` and `tx`), `fmNotices`, `theDocumentIsTheAllowListedShape`
  (recursively, the keys of `flowOf(...)` equal the interface's; no key matching `/alert|threshold|hold|rule/i`).
- [ ] **Step 2: Run** `pnpm test -- flow` — Expected: FAIL (no module).
- [ ] **Step 3: Implement** `flowOf` in `src/flow.ts` (pure: no D1, no fetch).
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): flowOf, the public facts behind the security page`

### Task 3: `GET /v1/flow`

**Files:**
- Modify: `indexer/src/api.ts` (`handleFlow`; widen `withinLimit`'s route union with `"flow"`), `indexer/src/index.ts`
  (the route, with HEAD handled as for `/v1/status`), `indexer/README.md` (the routes table and heading, the deploy
  step's rate-limited route list), `indexer/wrangler.jsonc` (the comments that list routes)
- Test: `indexer/test/worker/api-flow.test.ts`

**Interfaces:**
- Consumes: `flowOf`, `FlowInput`, `FlowV1` (Task 2); `cached`, `CACHE_TTL_S`, `RouteEnv` (`src/api.ts`).
- Produces: `export async function handleFlow(request: Request, env: RouteEnv, cfg: Config, nowS: number): Promise<Response>`.
  Order: OPTIONS → 204 with `Access-Control-Allow-Origin: cfg.site.origin`, `Access-Control-Allow-Methods: GET`,
  `Access-Control-Max-Age: 86400`; non-GET → 405 `Allow: GET, OPTIONS`; rate limit → 429; a query string → 400;
  then one `db.batch`: the newest `readings` row with `base_block IS NOT NULL`, the newest with
  `bit_block IS NOT NULL`, `SELECT direction, COUNT(*) FROM messages WHERE dst_tx IS NULL AND state <> 'SUCCESS'
  GROUP BY direction`, and the admin events (`logs` where `removed = 0` and `event` in the Task 2 list, oldest
  first); `meta.deployment` ≠ `cfg.deployment.id` → 503 with the cache header; a D1 failure → 503 `no-store`.
  Success: `JSON.stringify(flowOf(...))`, `Content-Type: application/json`,
  `Cache-Control: public, max-age=${CACHE_TTL_S}`, and the CORS origin header. Every response carries the CORS
  origin header.

- [ ] **Step 1: Write the failing tests** in `api-flow.test.ts` (model: `api-status.test.ts` and `api-scan.test.ts`,
  real Miniflare D1, `caches.default` purged per test): `servesTheDocument` (seeded readings, messages and a
  `BridgeProposed` log → 200, `v == 1`, the notice present, `Cache-Control` equals the cached value, CORS origin
  = `cfg.site.origin`); `optionsPreflight`; `postIs405`; `queryIs400`; `d1FailureIs503NoStore`;
  `deploymentMismatchIs503`; `headHasNoBody` (through the Worker's `fetch`); `unknownPathStill404`; `cachedOnce`
  (a second call within the TTL does not touch D1: count with `test/worker/d1-count.ts`).
- [ ] **Step 2: Run** `pnpm test -- api-flow` — Expected: FAIL.
- [ ] **Step 3: Implement**; update the README routes table ("Five routes") and the route lists.
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): GET /v1/flow, cached, for the site`

### Task 4: The site's flow data and view models

**Files:**
- Create: `web/src/lib/cascade/flow.ts` (types mirrored from Task 2, `fetchFlow`), `web/src/lib/security-view.ts`
  (`flowView`), `web/src/lib/cascade/validators.ts` (names)
- Modify: `web/src/lib/cascade/config.ts` (`explorer.baseAddress`, `explorer.bittensorAddress`,
  `explorer.validator`, `explorer.ccipLane`), `web/src/lib/cascade/hooks.ts` (`useFlow`)
- Test: `web/src/lib/cascade/flow.test.ts`, `web/src/lib/security-view.test.ts`

**Interfaces:**
- Consumes: the `FlowV1` JSON (Task 2), `DEPLOYMENT.indexerUrl` (`config.ts`), `formatTao`, `formatUsdCompact`,
  `formatPercent`, `formatRelative` (`src/lib/format.ts`).
- Produces:
  ```ts
  // flow.ts
  export type { FlowV1, Notice, NoticeKind, Bucket } ...      // the same names and fields as Task 2
  export function fetchFlow(d: Deployment, o?: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number }): Promise<{ flow: FlowV1; receivedAt: number } | null>;
  // never throws; null on no indexerUrl, network error, timeout (5 s), non-200, body over 256 KB, non-JSON,
  // v !== 1 or a missing top-level key
  // hooks.ts
  export function useFlow(): UseQueryResult<{ flow: FlowV1; receivedAt: number } | null>;
  // refetchInterval 60_000, refetchIntervalInBackground false, enabled only with DEPLOYMENT.indexerUrl
  // validators.ts
  export const VALIDATOR_NAMES: Record<string, string>;      // hotkey hex (lowercase) → "tao.bot" | "Yuma"
  export function validatorName(hotkey: string): string;      // the name, else a shortened hotkey
  // security-view.ts
  export type Tone = "ok" | "amber" | "stale";
  export interface StepView { id: StepId; name: string; chain: string; headline: string; say: string;
                              figures: { label: string; value: string }[]; link: { label: string; href: string } | null; tone: Tone }
  export type StepId = "wallet" | "swap" | "backing" | "bridge" | "vault" | "validator"
                     | "vaultOut" | "bridgeBack" | "swapOut" | "walletOut";
  export interface NoticeView { tone: "info"; title: string; body: string; href: string | null }
  export interface PageView {
    status: { kind: "passing" | "notOptimal" | "cantCheck" | "waiting"; text: string; detail: string | null };
    notices: NoticeView[]; stepsIn: StepView[]; stepsOut: StepView[];
  }
  export function flowView(data: { flow: FlowV1; receivedAt: number } | null, nowMs: number): PageView;
  ```
  The Yuma hotkey is `0x40c47b6a294686fe9612b5d78dd369f4c77fa3bbf96a4286ede97410ba2e3209`; tao.bot's is the
  deployment's stake hotkey (read its hex from `web/src/lib/cascade/deployments.json` or the indexer's deployment
  fixture). Figures: the TAO/WETH pool's depth in $ = 2 × its TAO × the TWAP; the WETH/USDC pool's = 2 × its USDC;
  the cost figure = 1 − (`buyQuote1000Tao` × TWAP ÷ 1,000) for money in and 1 − (`usdcOut` ÷ (`taoIn` × TWAP)) for
  money out; "price vs 30-minute average" = |spot − TWAP| ÷ TWAP. Amber conditions (spec): a stale chain; `ratioPpm < 1_000_000`; a bucket with `roomLeft == "0"` or
  `enabled === false`; the vault or front door paused. "Checked N ago" uses
  `receivedAt − (generatedAt − reading.time) × 1000` as the reading's moment on the visitor's clock.
  Status texts: passing "All checks passing, last checked {N ago}"; notOptimal "Conditions aren't optimal right
  now" plus the affected step's sentence; cantCheck "We can't check right now" (no data); waiting "Waiting for a
  fresh reading" (a chain stale). Notice titles (first draft): paused "{Contract} is paused";
  ownershipPending "An ownership change is pending"; guardianProposed "A new guardian is proposed";
  bridgeProposed "A new bridge is proposed"; frontDoorProposed "A new front door is proposed";
  fmAdminScheduled "ForeverMoney has scheduled an admin change"; fmMigration "ForeverMoney has announced a
  migration"; fmPaused "ForeverMoney's vault is paused". Bodies state the earliest time ("It can't take effect
  before {date}") or "It can be accepted at any time".

- [ ] **Step 1: Write the failing tests.** `flow.test.ts`: `nullWithoutIndexer`, `nullOnTimeout` (a fetch that
  never resolves, `timeoutMs: 10`), `nullOn5xx`, `nullOnOversizedBody`, `nullOnWrongVersion`,
  `nullOnMissingKey`, `parsesAGoodDocument`. `security-view.test.ts`: `passingWhenAllFresh`,
  `notOptimalWhenBackingBelowOne`, `amberStepWhenBridgeHasNoRoom`, `staleChainShowsDashes` (every Bittensor
  figure is "–", Base's are numbers), `cantCheckOnNull`, `checkedAgoUsesTheServerClock` (visitor clock 3 h ahead,
  still "1 minute ago"), `noticeTitlesAndEarliest`, `backingHeadlineIsTheRatio` ("99.90%"),
  `validatorNamesAndBackup` ("tao.bot", backup "Yuma"), `costFigureFromTheQuote` ("about 0.7%"),
  `noForbiddenWords` (no "safe", "secure", "guaranteed" in any string `flowView` returns, case-insensitive).
- [ ] **Step 2: Run** `pnpm test -- flow security-view` — Expected: FAIL.
- [ ] **Step 3: Implement.** `fetchFlow` follows `fetchSeed` in `src/lib/cascade/indexer.ts` (`mode: "cors"`,
  `credentials: "omit"`, `AbortController`, `bodyWithin`).
- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck`, `pnpm lint` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): the security page's data and view models`

### Task 5: The `/security` page

**Files:**
- Create: `web/src/app/security/page.tsx` (`metadata.title = "Security"`), `web/src/components/security/SecurityPage.tsx`
  (client), `web/src/components/security/Security.module.css`
- Test: `web/src/components/security/SecurityPage.test.ts`

**Interfaces:**
- Consumes: `useFlow`, `flowView`, `PageView`, `StepView` (Task 4); `SiteNav`, `SiteFooter`, `landing` styles,
  `Dash`.
- Produces: `export function SecurityPage(): JSX.Element`; `export function selectStep(view: PageView, dir: "in" | "out", id: StepId | null): StepView`
  (the step shown in the detail panel: the given one, else the first of the direction).

Layout (spec "Look and placement", mockups in `docs/superpowers/specs/assets/`): the FAQ page's wrapper
(`FaqPage.tsx`); title "Where your money goes"; lede "Every number is read straight from the chain, checked every
minute, and links to where you can check it yourself."; the status line; the notices; a "Money in" / "Money out"
switch (`role="tablist"`); the map as buttons (`aria-pressed` on the selected step) with arrows between; the
detail panel (`aria-live="polite"`). Under 720 px the map is a vertical list and the selected step's details open
inside it. Tokens from `globals.css` only.

- [ ] **Step 1: Write the failing tests** with `renderWithCache` + `plainText`, seeding the `useFlow` query:
  `rendersTheMapAndHeadlines` (all six "money in" names and their headlines), `selectedStepShowsDetails`
  (the bridge step's three figures and its link), `staleShowsDashes`, `cantCheckState`, `noticeRenders`,
  `selectStepDefaultsToFirst`, `selectStepSwitchesDirection`, `noForbiddenWords` in the rendered HTML.
- [ ] **Step 2: Run** `pnpm test -- SecurityPage` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` — Expected: PASS, and
  `out/security/index.html` exists.
- [ ] **Step 5: Commit** `feat(web): the live security page`

### Task 6: Links and the site's page lists

**Files:**
- Modify: `web/src/components/landing/SiteNav.tsx` (`/#secure` → `/security/`, both renders),
  `web/src/components/landing/SiteFooter.tsx` (a "Security" link to `/security/`; the existing GitHub
  SECURITY.md link becomes "Report a vulnerability"), `indexer/wrangler.jsonc` (`SITE_PAGES` in `test` and
  `production`: add `"/security/"` in sorted order), `indexer/test/node/site-pages.test.ts` (the list and "9
  pages"), `indexer/src/site-approved.ts` (regenerated)
- Test: the existing `site-pages.test.ts`, `site-approved.test.ts`, `csp-headers.test.ts`, and the nav/footer
  tests if present

- [ ] **Step 1: Update** `site-pages.test.ts`'s expected list and count — Run `pnpm test -- site-pages` from
  `indexer/` — Expected: FAIL (the page exists, `SITE_PAGES` doesn't list it).
- [ ] **Step 2: Implement** the links and `SITE_PAGES`.
- [ ] **Step 3: Regenerate** `src/site-approved.ts`: from `web/`, `pnpm build`; from `indexer/`,
  `pnpm site:approved ../web/out`. (Deploy time regenerates it again from the production build; this keeps the
  branch's tests green.)
- [ ] **Step 4: Run** the indexer's `pnpm test` and `pnpm typecheck` and the web's `pnpm test`, `pnpm typecheck`,
  `pnpm lint` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Security in the navigation and footer; the monitor knows the new page`
