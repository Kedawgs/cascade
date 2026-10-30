# Cascade History Indexer and Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker (`indexer/`) with a cron trigger and a D1 database that serves the site's vault-scan seed (a deployment-wide half and a per-account half) and monitors both chains and the bridge, emailing critical, warning and daily alerts, raising a hold, and confirming each batch before the keeper may pay it out; then the site's verified use of the seed and the keeper's reading of the status.

**Architecture:** One Worker, two handlers. `scheduled` runs a tick every minute (scan Bittensor and Base logs incrementally with the keeper's windows, REREAD, SETTLE and reorg-safe log identity, within a 40-second wall-time limit under a 3-minute lease; read both chains' state through block-pinned Multicall3 reads; run the rules; commit; then send email), a site check every two minutes in its own invocation, an hourly job (aggregates, pruning, the watchdog) and a once-a-day digest. `fetch` serves four read-only routes: the two seed halves (`ScanState` v1, exactly the halves the site's store saves), the status (hold ids, `ok` payout keys, per-chain lag) and a health probe. Pure logic (decoding, identity, pairing, replay, cross-checks, rules, email rendering) is separated from I/O and tested inside workerd with the Cloudflare Vitest plugin, a real Miniflare D1 and a fake JSON-RPC server; anything that touches files is tested in a Node project.

**Tech Stack:** Node 24.11, pnpm 11.23.0, TypeScript 5.9.3, vitest 5.0.5, `@cloudflare/vitest-plugin` 1.4.2, wrangler 4.151.0 (the plugin's pinned wrangler), viem 2.57.7 and `@noble/hashes` 1.8.0 (the web app's versions), `@types/node` 24.19.2 for the Node scripts. Types for the Workers runtime come from `wrangler types` (committed `worker-configuration.d.ts`).

**Spec:** `docs/superpowers/specs/2026-10-28-cascade-indexer-monitor-design.md` (revised 2026-10-29, two review rounds). Contracts as tagged `v3.1`; keeper scan `ops/src/keeper/state.ts`; the site's scan on main at `438deaf` (merged from `web-hardening`): `web/src/lib/cascade/facts.ts`, `live.ts`, `scan-store.ts`.

## Global Constraints

- Parts A–F touch only `indexer/`. Part G (site) touches `web/` and `ops/src/webconfig.ts`; it re-checks main's current files before starting (the plan was written against `438deaf`). Part H (keeper) is a later task and touches `ops/`.
- Four crons per environment: tick `* * * * *`, site check `*/2 * * * *`, hourly `17 * * * *`, daily `0 13 * * *`. Only the tick sends alert email (the watchdog's `monitor.stalled` excepted). The site check never runs inside the tick.
- A tick takes a 3-minute lease under a random holder id, stops scanning 40 seconds in, and commits under a guard that checks only that it is still the lease's holder.
- Nothing is deployed and no Cloudflare resource is created while executing this plan: no `wrangler login`, `wrangler deploy` (except `--dry-run`, which builds without logging in), `wrangler d1 create`, `wrangler secret put`, and no `--remote` flag anywhere except inside the owner-only scripts' printed commands (whose tests use `--dry-run`). Local runs use Miniflare's local D1 (`.wrangler/state`, git-ignored). The owner does the deploy later (spec section 11).
- The Worker holds no key and never sends a transaction: no private key, mnemonic or signer anywhere in `indexer/`; Task 1 adds a test that fails if transaction-sending methods appear under `indexer/src`.
- No `.env*` file is created, read or edited. Local secrets for `wrangler dev` go in `indexer/.dev.vars`, which is git-ignored and never committed; tests never need it.
- No personal email address, RPC key or production threshold in any committed file: recipients come from the `ALERT_TO` secret, keyed RPC URLs and private thresholds from secrets. A secret can't share a var's name (the Worker sees one value per name), so the overrides are `BASE_RPC_URL_SECRET`, `BASE_LOGS_RPC_URL_SECRET`, `BITTENSOR_RPC_URL_SECRET` and `THRESHOLDS_SECRET` (built in Task 2).
- Every external `fetch` goes through `src/rpc.ts` (or `src/http.ts` for price APIs and the site) and spends the invocation's subrequest `Budget` (45 by default). A second budget bounds the scan's CPU (`DECODE_BUDGET`, 100 by default on Free): one unit per log hashed and decoded (about 42 µs), none for a log already stored at the same place, and the scan cuts at a block boundary once it is spent. A tick makes at most about 6 D1 queries (each `db.batch()` counts once); a query that SQLite would plan onto the wrong index names its own with `INDEXED BY`.
- Every log is keyed by (chain, contract role, event), never by event name alone: names collide (`Delivered`, `Staked`) and addresses can collide across chains.
- Readings carry the block they were read at; a reading whose block isn't newer than the last for that chain is dropped.
- RPC URLs are never printed: errors and logs use `redact(url)`, the URL's registrable domain only (`quiknode.pro`; a provider can put its key in a subdomain), and `scrub` cuts the host, path and query from anything a node echoes back.
- Chain amounts are `bigint` in code and decimal strings in JSON and D1; addresses, hashes and topics are lowercase hex in D1 and in the API.
- The scan numbers are the keeper's: windows Base 100 (configurable via `BASE_LOG_WINDOW`) and Bittensor 1,000; REREAD Base 70, Bittensor 400; SETTLE Base 30, Bittensor 10. A log window is accepted only from a server whose head (asked in the same JSON-RPC batch) has reached the window's end, and never asks past a head some node has reported (two requests per chain per steady tick; built in Task 7).
- Thresholds live only in `src/thresholds.ts` (spec section 6 defaults), overridable by the `THRESHOLDS` variable or the `THRESHOLDS_SECRET` secret (the secret wins).
- Every rule id has a runbook line in `src/runbook.ts` (Task 13's test enforces it). Emails carry explorer links and hashes only, never a link to sign anything. Alerts are committed before their emails are sent.
- Tests that read or write files (contract sources, `ops/src/keeper/state.ts`, `wrangler.jsonc`, grep tests, fixtures) live in the `node` project: workerd has no filesystem.
- Dependencies are pinned exactly and `indexer/pnpm-lock.yaml` is committed. In `indexer/pnpm-workspace.yaml`, `allowBuilds` approves only the packages wrangler needs to install its binaries (`esbuild`, `workerd`) if pnpm asks; everything else `false`.
- Tests never reach the network, except `pnpm smoke` and `scripts/record-fixtures.ts` (Task 30), which are read-only and run by hand.
- Commit trailer on every commit: the two attribution lines the executing session is given (`Co-Authored-By: …` and `Claude-Session: …`).

## Depends on the owner

Tasks that can be built either way but whose defaults follow an open question in the spec (section 14). Build with the default shown; change the config if the owner decides otherwise.

| Open question | Default built | Tasks |
|---|---|---|
| Q1 Workers Paid or a second account for test | budgets sized for Free (`SUBREQUEST_BUDGET` 45, `DECODE_BUDGET` 300, `SITE_FILES_PER_RUN` 2); `env.test` and `env.production` both in `wrangler.jsonc` (on Free, only one of them per account) | 1, 2, 27, 28, 29 (README's plan choice and option (b)'s email and domain limits) |
| Q2 Email domain and recipient | sender `monitor@cascadefi.xyz`, recipients from the secret, `ALERT_MODE=log` until deployed | 1 (binding), 25, 29 |
| Q3 Keeper fails closed (per-key `ok`, lag limit, escape hatch) | as specified | 11 (status fields), 38, 39 |
| Q4 Hold stops USDC deliveries | no | 39 |
| Q6 Third-party price APIs | `PRICE_SOURCES` CoinGecko and Coinbase; with none configured, `fmtao.depeg` and `price.reference_unavailable` are off | 22 |
| Q13 Proposed rules `rail.alpha_vault`, `fmtao.mint_surge` | built, each switchable off in `THRESHOLDS` (`rules.off`) | 22, 23 |
| Q14 Provisional "rewards earned" after a seeded visit | provisional with background check | 35 |

## Review items → tasks

Round 1: C1 → 11, 38, 39. I1 → 19, 20. I2 → 5, 12, 15, 20. I3 → 15. I4 → 3, 6, 8. I5 → 8, 12, 16. I6 → 6, 7, 9, 10, 14, 28. I7 → 25, 28. I8 → 7, 28. I9 → 39. I10 → 35 (and spec 5, 13). I11 → Part G. M1 → 6, 7. M2 → 21. M3, M4 → 11. M5 → 24. M6 → 6, 28. M7 → 1, 26, 29. M8 → 1, 3, 7, 10, 12, 20, 24. M9 → 12, 22, 23. M10 → 27. M11 → 2. M12 → spec. M13 → 2, 20.

Round 2: R1 (lag misses a stuck logs RPC) → 6, 7, 11, 23, 28, 38. R2 (lease guard vs long backfill) → 2, 6, 7, 28. R3 (an honest batch stuck out of `okKeys`) → 6, 11, 12, 19, 20, 24. R4 (site check inside the tick) → 1, 2, 27, 28. Chunk gaps, all four consumers, stake contradictions, seeded shared half → 33, 34. Option (b)'s limits → 29. Lowercase-only seed paths, no query strings → 10. Opaque hold ids → 6, 11, 24. Payout completion source → 11, 12. Main instead of `web-hardening` → Part G, 10. v3-test noise → 16. Background check cost → 35.

## Review Focus

1. A lagging or load-balanced RPC node must never make the scanner skip blocks (window accepted only from a server at its end; cursor never past the last whole window) nor make a reading go backwards (Tasks 5, 7, 12).
2. A reorg must never store a log twice, and a log that vanishes then reappears must come back (Tasks 6, 7).
3. The cross-checks must fail a forged batch or payout and must never fail an honest one: not before the other chain is stored, not when one transaction carries two messages, not from a node behind the landing block (Tasks 19, 20).
4. The keeper must never pay a key the monitor hasn't reported `ok` while the monitor is healthy, and must hold when the monitor is unreadable, stale or lagging, including when only the logs RPC is down (Tasks 11, 23, 28, 38, 39). A forged delivery must never keep an honest one out of `okKeys` (Task 19).
5. The seed halves must never contain an event outside `[from, next)`, a removed log, or another deployment's events, and must pass the site's `decode` (Task 10; Part G).
6. Nothing over HTTP can set or clear the hold or write anything (Task 11).
7. An alert is committed before its email is sent; a failing commit can't flood the inbox; a tick that never completes is noticed (Tasks 25, 28).
8. The site must not show an amount from a seeded event before its receipt confirms it, must mark completeness-dependent figures provisional until checked, and must fall back to its own scan on any indexer failure (Part G).
9. A long backfill tick must always commit what it read, and a hostile site file must never stop the tick (Tasks 6, 27, 28).

---

## Part A — Package, config, RPC and decoding

### Task 1: The `indexer/` package (Owner: Q1, Q2)

**Files:**
- Create: `indexer/package.json`, `indexer/pnpm-workspace.yaml`, `indexer/tsconfig.json`, `indexer/vitest.config.ts`, `indexer/wrangler.jsonc`, `indexer/.gitignore`, `indexer/src/index.ts`, `indexer/src/crons.ts`, `indexer/worker-configuration.d.ts` (generated)
- Test: `indexer/test/worker/index.test.ts`, `indexer/test/node/no-signing.test.ts`, `indexer/test/node/crons.test.ts`

**Interfaces:**
- `package.json`: `"name": "cascade-indexer"`, `"private": true`, `"type": "module"`, `"packageManager": "pnpm@11.23.0"`; scripts `test` (`vitest run --project worker --project node`), `typecheck` (`tsc --noEmit`), `types` (`wrangler types`), `bundle` (`wrangler deploy --dry-run --outdir .wrangler/dry-run --env test`), `dev` (`wrangler dev --env test --test-scheduled`), `wrangler` (`wrangler`), and placeholders filled by later tasks: `smoke`, `fixtures`, `config:from-record`, `site:approved`, `hold:clear`, `alerts:ack`, `checks:approve`.
- `wrangler.jsonc`: `name: "cascade-indexer"`, `main: "src/index.ts"`, `compatibility_date: "2026-10-14"`, `observability: { enabled: true }`, `triggers.crons: ["* * * * *", "*/2 * * * *", "17 * * * *", "0 13 * * *"]` (four: within Free's five per account for one environment), `"cache": { "enabled": true }`; `env.test` and `env.production` each with a `d1_databases` entry `{ binding: "DB", database_name: "cascade-indexer-<env>", database_id: "local-only-<env>", migrations_dir: "migrations" }` (the owner replaces the id at deploy), a `send_email` entry `{ name: "EMAIL", allowed_sender_addresses: ["monitor@cascadefi.xyz"] }`, and `vars` (Task 2). No `remote: true` anywhere.
- `src/crons.ts`: `export const CRONS = { tick: "* * * * *", site: "*/2 * * * *", hourly: "17 * * * *", daily: "0 13 * * *" } as const` (the dispatch table the handler uses).
- `.gitignore`: `node_modules/`, `.wrangler/`, `.dev.vars*`, `coverage/`.
- `vitest.config.ts`: two projects. `worker`: `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc", environment: "test" }, miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("migrations") } } })` configured on this project only, include `test/worker/**/*.test.ts`, setup file `test/worker/setup.ts` (applies migrations; empty until Task 6). `node`: `environment: "node"`, include `test/node/**/*.test.ts`.
- `src/index.ts`: `export default { fetch, scheduled } satisfies ExportedHandler<Env>`; for now `fetch` returns 404 and `scheduled` returns.

- [ ] **Step 1: Write the failing tests.**
  - `index.test.ts`: `GET https://x/nope` through `exports.default.fetch` returns 404; `worker.scheduled(createScheduledController({ cron: CRONS.tick }), env, createExecutionContext())` resolves.
  - `no-signing.test.ts` (node): no file under `indexer/src` contains `eth_sendRawTransaction`, `eth_sendTransaction`, `privateKeyToAccount`, `mnemonicToAccount` or `signTransaction`.
  - `crons.test.ts` (node): the crons in `wrangler.jsonc` (parsed as JSONC) equal `Object.values(CRONS)`, for the top level and every environment, and there are at most 5.
- [ ] **Step 2: Run** `pnpm install` then `pnpm test` (in `indexer/`). Expected: FAIL (no `src/index.ts`).
- [ ] **Step 3: Implement** the stub and the config files; run `pnpm types` to generate `worker-configuration.d.ts`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck && pnpm bundle`. Expected: PASS; the dry-run bundle builds without asking to log in.
- [ ] **Step 5: Commit** `feat(indexer): package scaffold, wrangler config, test projects, bundle check` (include `pnpm-lock.yaml` and the generated types).

*As built:* `typecheck` is `tsc --noEmit && tsc --noEmit -p tsconfig.node.json` (Node's types and the Workers runtime's clash, so a `src/` module a Node script imports must not use Workers globals); `types` is `wrangler types --env test --strict-vars=false`; the worker project sets `fsModuleCache: false` (the plugin at 1.4.2 can't load Vitest 5's on-disk module cache; fixed in 1.4.3); `wrangler.jsonc` has `send_metrics: false`.

### Task 2: Config and thresholds (Owner: Q1, Q6, Q13)

**Files:**
- Create: `indexer/src/config.ts`, `indexer/src/thresholds.ts`
- Modify: `indexer/wrangler.jsonc` (`vars` for `env.test`, from the spec's section 9 table, with `DEPLOYMENT` a placeholder JSON the Task 29 script fills)
- Test: `indexer/test/worker/config.test.ts`

**Interfaces:**
- `thresholds.ts`: `export const DEFAULTS` with every number in spec section 6 (`priceDropEpsilon: 1e-12`, `holdPriceDropBps: 10`, `stakeDustRao: 1000n`, `unexplainedTxGraceS: 900`, `fmtaoBackingSlackWei: 10n ** 16n`, `depegBps: 500`, `referenceUnavailableS: 3600`, `undeliveredS: 3600`, `maxWaitGraceS: 900`, `payoutGraceS: 3600`, `deliveryGraceS: 7200`, `keeperMinEthWei: 2n * 10n ** 15n`, `keeperMinTaoWei: 10n ** 17n`, `idleUnstakedS: 7200`, `adapterMinReserveWei: 5n * 10n ** 11n`, `twapDivergenceBps: 300`, `liquidityDropPct: 50`, `oneWalletPct: 50`, `oneWalletEntries: 10`, `capNearlyFullPct: 90`, `tinyUnstakeWei: 2n * 10n ** 16n`, `tinyUnstakeCount: 20`, `redeemListPct: 80`, `outflowNearPct: 80`, `rewardsMaxAgeS: 35 * 86400`, `rewardsDueWei: 25n * 57n * 10n ** 15n`, `notEarningS: 86400`, `lagCapS: 1800`, `lagPayoutDelayDivisor: 4`, `blindMinS: 1800`, `stalledS: 900`, `mintSurgeWei: 500n * 10n ** 18n`, `criticalResendS: 3600`, `criticalMaxSends: 6`, `warningEveryS: 1800`, `siteUnreachableS: 1800`, `chainUnreadableTicks: 5`, `emailFailingS: 1800`, `rules: { off: [] as string[] }`); `type Thresholds = typeof DEFAULTS`; `mergeThresholds(varJson, secretJson): Thresholds` (the secret applied over the var; bigints as decimal strings; unknown keys refused); `lagLimitS(t, payoutDelayS) = min(t.lagCapS, floor(payoutDelayS / t.lagPayoutDelayDivisor))`.
- `config.ts`: `interface Config { deployment: Deployment; bridges: { base: Hex[]; bittensor: Hex[] }; tokens: Tokens; rpc: { base: string; baseLogs: string; bittensor: string }; budgets: { subrequests: number; decode: number; scanWallS: number /* 40 */; leaseS: number /* 180, at least 3 × scanWallS */; siteFilesPerRun: number /* 2 */; siteMaxBytes: number /* 2_000_000 */ }; baseLogWindow: bigint; site: { origin: string; url: string; pages: string[] }; alerts: { from: string; mode: "send" | "log"; to: string[] }; thresholds: Thresholds; priceSources: ("coingecko" | "coinbase")[] }`; `interface Deployment { id: string /* "<frontDoor>:<vault>" lowercase */; base: { chainId: 8453; startBlock: bigint; baselineBlock: bigint }; bittensor: { chainId: 964; startBlock: bigint; baselineBlock: bigint }; frontDoor, baseAdapter, staker, oracle, vault, bitAdapter: Address; vaultColdkey: Hex; stakeHotkey: Hex; batchMaxWaitS: number }`; `roleOf(chain, address): Role | undefined`; `parseConfig(env: Env): Config` (throws `ConfigError` naming the field, never a secret's value); `redact(url): string` (the registrable domain only).
- Secrets `BASE_RPC_URL_SECRET`, `BASE_LOGS_RPC_URL_SECRET`, `BITTENSOR_RPC_URL_SECRET` and `THRESHOLDS_SECRET` override the vars of the same name without `_SECRET` (a secret can't share a var's name: the Worker sees one value per name); `ALERT_TO` is a comma list (may be empty in `log` mode). `BRIDGES` defaults to the deployment's two adapters.
- *As built:* `rolesOf(d)` returns the `roleOf(chain, address)` function; `redact` is the registrable domain (`hostDomain`, after the Tasks 1–10 review); `ConfigError` is in `src/errors.ts`; addresses must be exactly EIP-55; JSON vars may be written as a JSON string or a JSON value; `DEPLOYMENT` stays a placeholder the Worker refuses until Task 29, and the tests bind `test/fixtures/deployment.json`.

- [ ] **Step 1: Write the failing tests:** a full test env parses; an address that isn't checksummed is refused naming `DEPLOYMENT.frontDoor`; a start block that isn't an integer is refused; `THRESHOLDS='{"depegBps":300}'` overrides one value; a `THRESHOLDS_SECRET` secret wins over the var; `{"nope":1}` is refused; a secret RPC URL (`BITTENSOR_RPC_URL_SECRET`) overrides the var; `redact("https://x.example/key/abc")` is `"x.example"` and `redact("https://KEY.base-mainnet.quiknode.pro/x")` is `"quiknode.pro"`; `ALERT_MODE` other than `send`/`log` is refused; the `ConfigError` for a bad `BITTENSOR_RPC_URL` secret never contains its value; `lagLimitS(DEFAULTS, 3600) === 900` and `lagLimitS(DEFAULTS, 86400) === 1800`; `LEASE_S=60` with `SCAN_WALL_S=40` is refused; `roleOf("base", staker)` is `"staker"` and `roleOf("bittensor", staker)` is `"bitAdapter"` when the two share an address (as on v3-test).
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `config.ts` and `thresholds.ts`; fill `env.test.vars` (public RPCs, `BASE_LOG_WINDOW: "100"`, `SUBREQUEST_BUDGET: "45"`, `DECODE_BUDGET: "100"`, `SCAN_WALL_S: "40"`, `LEASE_S: "180"`, `SITE_FILES_PER_RUN: "2"`, `SITE_MAX_BYTES: "2000000"`, `SITE_ORIGIN`, `SITE_URL`, `SITE_PAGES`, `ALERT_FROM`, `ALERT_MODE: "log"`, `THRESHOLDS: "{}"`, `PRICE_SOURCES`, `TOKENS` from `ops/src/config.ts` `LIVE`/`BASE_V3` plus Multicall3).
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): config, thresholds with a secret override, payout-delay-based lag limit`.

### Task 3: ABIs, decoding and log identity

**Files:**
- Create: `indexer/src/abi.ts`, `indexer/src/logs.ts`
- Test: `indexer/test/worker/logs.test.ts`, `indexer/test/node/abi-sources.test.ts`

**Interfaces:**
- `abi.ts`: per role: `VAULT` (including csTAO's ERC-20 `Transfer`), `FRONT_DOOR`, `STAKER`, `ADAPTER` (with `ReserveFunded` for the Bittensor adapter), `BASE_ADMIN` (CascadeBase plus OpenZeppelin `Paused`, `Unpaused`, `OwnershipTransferStarted`, `OwnershipTransferred`), plus view ABIs `ERC20`, `UNISWAP_POOL`, `ORACLE`, `OFFRAMP`, `ALPHA_VAULT`, `STAKING`, `MULTICALL3` (`aggregate3`, `getEthBalance`, `getBlockNumber`, `getCurrentBlockTimestamp`), `SAFE` (`nonce()`); `abiFor(role)`; `ADMIN_EVENTS: ReadonlySet<\`${Role}:${string}\`>` (the spec's admin list, keyed by role and name).
- `logs.ts`: `interface RawLog { address: Hex; topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex; transactionHash: Hex }`; `interface StoredLog { uid: Hex; chain: ChainName; contract: Role; address: Hex; block: bigint; logIndex: number; txHash: Hex; event: string; topic1?: Hex; topic2?: Hex; topic3?: Hex; data: Hex; args: Record<string, string | number | boolean> }`; `identify(chain, logs: RawLog[]): { uid; raw }[]` (uid = `keccak256(toBytes(`${chain}:${txHash}:${topics.join(",")}:${data}#${n}`))`, n counting identical logs in one transaction, exactly the keeper's `identified()` plus the chain); `decode(chain, raw, roleOf)` (event name from the role's ABI, args with bigints as decimal strings, lowercase addresses; `"unknown"` and `{}` when nothing matches); `is(log, role, event)`.

- [ ] **Step 1: Write the failing tests:**
  - `decodes BatchDelivered` from a log built with viem's encoders.
  - `the front door's Delivered and the Base adapter's Delivered decode to different roles`, and `the vault's Staked and the staker's Staked` likewise.
  - `a csTAO mint Transfer decodes` (not `unknown`); `ReserveFunded decodes` on the Bittensor adapter.
  - `an unknown topic is "unknown"`.
  - `a re-mined copy is the same log`: the same transaction and content at block 10 index 3 and at block 11 index 0 give one uid.
  - `two identical logs in one transaction get #0 and #1`; `the same log on another chain is another uid`.
  - `abi-sources.test.ts` (node): every name in `ADMIN_EVENTS` and every event in each role's ABI appears in the matching `contracts/src` file (`CascadeBase.sol`, `CascadeVault.sol`, `CascadeFrontDoor.sol`, `CascadeStaker.sol`, `adapters/*.sol`), and every `event` declared in those files is in an ABI.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `abi.ts` (with viem `parseAbi`) and `logs.ts`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): ABIs by contract role, decoding, and the keeper's reorg-safe log identity`.

### Task 4: RPC client and the budgets

**Files:**
- Create: `indexer/src/rpc.ts`, `indexer/src/http.ts`
- Test: `indexer/test/worker/rpc.test.ts`, `indexer/test/worker/fake-rpc.ts` (test helper)

**Interfaces:**
- `class Budget { constructor(limit: number); spend(n = 1): void /* throws BudgetExhausted */; get left(): number }` (used for subrequests and for decoded logs).
- `interface Rpc { call(chain, method, params): Promise<unknown>; batch(chain, calls: { method; params }[]): Promise<unknown[]>; logsWithHead(chain, filter: { address: Hex[]; fromBlock: bigint; toBlock: bigint }): Promise<{ logs: RawLog[]; head: bigint }> }`.
- `createRpc({ urls: Record<ChainName | "baseLogs", string>, fetch, budget: Budget, spacingMs?: Partial<Record<ChainName, number>> /* base 300, bittensor 500 */, sleep?, retries? /* 3 */ }): Rpc`. A batch is one `fetch` (one budget unit); answers matched by id; an error member throws `RpcError { chain, method, code, message }` with the URL redacted; HTTP 429 and 5xx retry with backoff (2 s, 4 s, 8 s); `logsWithHead` sends `[eth_getLogs, eth_blockNumber]` as one batch, to the Base logs URL for Base.
- `http.ts`: `getJson(url, { fetch, budget, timeoutMs })` and `getText(...)` (one budget unit each, `AbortSignal.timeout`).
- `test/worker/fake-rpc.ts`: `fakeChain({ head, logs, calls: Record<string, (params, blockTag) => unknown>, lagBy?, behindFor?, failNext? })` returning a `fetch` that answers JSON-RPC (single and batch) for both chains, can serve a `latest` read from an older block (to test backward readings), and counts fetches; used by every later test.

- [ ] **Step 1: Write the failing tests:** a batch of three calls is one `fetch` and one budget unit; answers out of order are matched by id; a 429 then 200 succeeds after one backoff (injected `sleep` records 2,000); four 429s throw `RpcError` whose message has neither the URL's path nor its query; spending past the limit throws `BudgetExhausted` before the `fetch`; two Base calls are at least 300 ms apart (injected clock); `logsWithHead` returns the server's head from the same request.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `rpc.ts`, `http.ts` and the fake.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): one JSON-RPC choke point with batching, backoff, redaction and budgets`.

*As built (with the Tasks 1–10 review):* every request has a 20 s timeout, not retried; a caller's deadline (`createRpc({ deadlineMs })` or per call) is kept: no spacing wait or backoff that would end past it, and a request's timeout cut short at it (`RpcError.deadline`); `logsWithHead` takes `{ headTime, deadlineMs }` and refuses a malformed log as an `RpcError`; errors name the registrable domain only.

### Task 5: Block-pinned Multicall3 reads

**Files:**
- Create: `indexer/src/multicall.ts`
- Test: `indexer/test/worker/multicall.test.ts`

**Interfaces:**
- `type Read = { address: Hex; abi: Abi; functionName: string; args?: unknown[] } | { ethBalance: Hex }`.
- `multicall(rpc, chain, reads: Read[]): Promise<{ block: bigint; time: number; results: ({ ok: true; value: unknown } | { ok: false })[] }>`: one `eth_call` to Multicall3 `aggregate3` with `allowFailure: true` at `latest`, always prefixed with `getBlockNumber()` and `getCurrentBlockTimestamp()` (so the answer names the block it was computed at); ETH balances through `getEthBalance`; results in input order; a sub-call that reverted or returned undecodable data is `{ ok: false }`.
- `newerThan(last: bigint | undefined, read: { block: bigint }): boolean` (the forward-only rule).

- [ ] **Step 1: Write the failing tests** (fake RPC answering `aggregate3` built with viem's `encodeFunctionResult`): three reads decode in order with the block and time; a failed sub-call is `{ ok: false }` and the others still decode; an ETH balance read returns a bigint; `newerThan(100n, { block: 100n })` is false, `101n` true, `undefined` true; a fake node serving an older block returns that older block number (the caller drops it).
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `multicall.ts`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): Multicall3 reads that name their block, with per-call failure`.

## Part B — Storage and scanning

### Task 6: D1 schema and the store

**Files:**
- Create: `indexer/migrations/0001_init.sql` (exactly the spec's section 2, including `contract`, `hours`, `guard`, `kind`, `head_time`, `roles`, `batch_checks` keyed by `(batch_id, delivered_key)` with `ok_by_owner`, `queued_block` and `payout_done_block`, `chunk_checks` keyed by `landed_uid`, and `holds.public_id`), `indexer/src/store.ts`
- Modify: `indexer/test/worker/setup.ts` (apply `TEST_MIGRATIONS` with `applyD1Migrations`)
- Test: `indexer/test/worker/store.test.ts`, `indexer/test/worker/d1-count.ts` (a wrapper around `env.DB` counting queries and summing `meta.rows_read`)

**Interfaces:**
- `store.ts` returns `D1PreparedStatement`s to be committed together, plus reads: `loadTickState(db): Promise<{ cursors; openAlerts; activeHolds; lastReadings: Reading[] /* last 2 per chain */; hours: HourRow[] /* last 25 */; nonces /* watched addresses */; pendingMessages; awaitingReads /* chunk_checks awaiting a delivered(...) read */; payoutUsers /* ≤ 50: PayoutReceived in 7 days, not since claimed or delivered */; pendingPayoutKeys /* batch_checks with queued_block set, payout_done_block null */; meta }>` (one `db.batch()`: everything Task 12's `readSnapshot` needs); `storedUids(db, ranges: { chain; from; to }[]): Promise<Map<ChainName, Map<Hex, bigint>>>` (one query, uid → block); `takeLease(db, holder /* random per tick */, leaseS, nowS): Promise<boolean>`; `guardStatement(db, holder)` (the spec's guard insert: holder only, never `until`); `leaseHolder(db)` (read once after a failed commit, to tell a lost lease from a D1 failure); statements `upsertLogs(db, logs)` (`ON CONFLICT (uid) DO UPDATE SET removed = 0, block, log_index`), `markRemoved`, `setCursor` (`settled_to = MAX(settled_to, ?)`; `head_time = MAX(head_time, ?)`, written every tick), `upsertBlocks`, `insertTxs`, `insertReading`, `pruneReadings(keep = 120)`, `upsertHour`, `pruneHours(days = 35)`, `setMeta`, `releaseLease`; query helpers used by prefetch and the API.

- [ ] **Step 1: Write the failing tests:** the migration applies and every table exists; `takeLease` succeeds once, refuses while held, succeeds after `until`; **a commit whose lease was taken over fails whole**: tick A takes the lease, its time passes, tick B takes it, A's batch beginning with `guardStatement(A)` throws and leaves every table unchanged, B's commits, and `leaseHolder` then names B; **a slow tick whose lease expired but wasn't taken still commits** (the guard ignores `until`); two deliveries with one batch id and different keys make two `batch_checks` rows; two landings for one (key, chunk) make two `chunk_checks` rows; a hold gets a `public_id` matching `^h_[0-9a-f]{8}$`; upserting the same log twice leaves one row; a log marked removed and upserted again at a new block has `removed = 0` and the new block; `setCursor` with a smaller `settledTo` keeps the larger; `loadTickState` is one query and reads at most 2 readings per chain and 25 hour rows (`d1-count` asserts both); `pruneReadings` keeps the newest 120.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the migration and `store.ts` (prepared statements only; no string-built SQL).
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): D1 schema, a lease-guarded commit, reorg-safe log upserts`.

*As built (with the Tasks 1–10 review):* extra indexes `logs_by_block`, `logs_by_topic1` (forced with `INDEXED BY` in the payout users' lookup), `chunk_checks_by_status`, `batch_checks_pending`, `messages_pending`; `seed_pages` keeps `delivered`, `staked`, `payouts` JSON fragments instead of one `json`; `loadTickState(db, nowS)` also returns `holdIds` (every hold ever raised); `storedUids` returns each stored log's place and content (`StoredRef`, in `logs.ts`); `deploymentStatement` (written by every commit, kept from the first) and `checkDeployment` ("new" | "same" | "other": the tick refuses "other"); `upsertBatchCheck`, `upsertChunkCheck`, `insertHold`, `appendStatements`, `rebuildStatements`, `seedPageOf`.

### Task 7: The incremental scanner

**Files:**
- Create: `indexer/src/scan.ts`
- Test: `indexer/test/worker/scan.test.ts`, `indexer/test/node/scan-numbers.test.ts`

**Interfaces:**
- `WINDOW = { base: cfg.baseLogWindow, bittensor: 1000n }`, `REREAD = { base: 70n, bittensor: 400n }`, `SETTLE = { base: 30n, bittensor: 10n }` (exported).
- `rereadRange(chain, cursor, startBlock): { from: bigint; to: bigint } | null` (the range whose stored uids the tick loads once, Task 6's `storedUids`).
- `interface ScanResult { upserts: StoredLog[] /* settled */; fresh: StoredLog[] /* unsettled, not stored */; removed: Hex[]; cursor: { scannedTo: bigint; settledTo: bigint }; head?: bigint; headTime?: number /* the head block's time, from the first window's batch */; stopped?: "budget" | "decode" | "wall" | "lagging" | "error" }`.
- `headTimeOf({ scanHeadTime?, readingTime?, nowS, previous }): number` (pure, used by Task 28 every tick): `max(previous, scanHeadTime ?? readingTime ?? nowS)`: so a chain whose logs can't be read still has its `head_time` moved on by the reading or, failing that, the clock.
- `scanChain({ rpc, chain, roleOf, addresses, startBlock, cursor, stored: Map<Hex, bigint>, decodeBudget: Budget, deadlineMs: number /* tick start + scanWallS */, now: () => number }): Promise<ScanResult>` implementing spec section 3.2: start at `startBlock` when `scannedTo` is null, else `max(startBlock, scannedTo + 1 − REREAD)`; one `logsWithHead` per window (the first also asks `eth_getBlockByNumber("latest", false)` in the same batch, for `headTime`); no new window starts after `deadlineMs` (`"wall"`); a server head below the window's end is retried once, then the chain stops with the cursor at the last whole window; `BudgetExhausted` (subrequests) stops the same way; the decode budget is spent per decoded log and, once exhausted, the tick finishes the current window and stops (`"decode"`); settled = block ≤ head − SETTLE; a uid in `stored` whose block lies in a re-read window's settled part and is missing from the read is `removed`.

- [ ] **Step 1: Write the failing tests** (fake RPC, Bittensor numbers unless stated):
  - `the first scan reads from the start block in 1,000-block windows`: start 1,000, head 3,500 → `[1000,1999]`, `[2000,2999]`, `[3000,3500]`.
  - `a later scan starts REREAD blocks back`: `scannedTo` 3,500 → starts at 3,101; `rereadRange` is `[3101, 3500]`.
  - `logs within SETTLE are returned but not stored`, and `are stored on the next tick once settled`.
  - `a re-mined copy is the same log`; `a vanished log is marked removed`; `a removed log re-mined later comes back as an upsert at its new block`.
  - `a lagging node never advances the cursor`: server head 2,500 for `[2000,2999]` twice → `stopped: "lagging"`, `scannedTo` 1,999, nothing in `[2000,2999]` stored.
  - `budget exhaustion keeps the last whole window`: subrequest budget 2 → `stopped: "budget"`, `scannedTo` 2,999.
  - `the decode budget stops after the window that spends it`: 350 logs in window 1 with a budget of 300 → window 1 kept whole, `stopped: "decode"`, `scannedTo` 1,999.
  - `the wall-time limit stops between windows`: a fake RPC that takes 15 s a window (injected clock) with a 40 s deadline → three windows read, `stopped: "wall"`, cursor at the third window's end (the backoff of a 429 counts toward it).
  - `the head's time comes from the first window's batch`; `headTimeOf` takes the scan's head time, else the reading's time, else the clock, and never goes backwards.
  - `Base uses its own window` (100, and 2,000 when configured).
  - `scan-numbers.test.ts` (node): `REREAD`, `SETTLE` and the Bittensor window equal the constants in `ops/src/keeper/state.ts` (read as text).
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `scan.ts`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): incremental log scan with REREAD, SETTLE, reorg upserts, lag checks, decode and wall-time limits`.

*As built (with the Tasks 1–10 review):* no window asks past a head some node has reported: a steady tick's first request re-reads up to the last head read and brings back the head and its time, the second reads the new blocks (two requests per chain), and a first scan asks for the head alone (so the budget test uses 3, not 2). The decode budget counts each log hashed and decoded, none for one stored at the same transaction, index, block and content, and once it is spent the scan cuts before the next block needing work, never splitting a block (the "350 logs, budget 300" test now ends at block 1299). `scanChain` takes `window`, `reserve: { budget, keep }` (it starts a window only with two requests left above `keep`) and passes its deadline to every request; `headTimeOf` takes the newer of the scan's and the reading's time; `ScanResult.error` says why it stopped.

### Task 8: Block times and transaction attribution

**Files:**
- Create: `indexer/src/attribute.ts`
- Test: `indexer/test/worker/attribute.test.ts`

**Interfaces:**
- `blockTimes(rpc, chain, numbers: bigint[]): Promise<Map<bigint, number>>` (one batched `eth_getBlockByNumber(n, false)`, at most 20 blocks per tick per chain; the rest wait).
- `ATTRIBUTABLE: ReadonlySet<\`${Role}:${string}\`>` (`frontDoor:BatchClosed`, `frontDoor:BatchRolled`, `frontDoor:Delivered`, `vault:PayoutChunkSent`, `vault:Staked`, `vault:RewardsClaimed`, `vault:HotkeyAdded`, and every `ADMIN_EVENTS` member).
- `senderFromArgs(log: StoredLog): Hex | undefined`: `frontDoor:DepositRequested` → `payer`; `frontDoor:FeeCredited` → `payer`; `frontDoor:RedeemRequested`, `RedeemCancelled`, `DepositCancelled`, `Claimed`, `DeliverySet` → `user`; `staker:Staked` → `payer`; `bitAdapter:ReserveFunded` → `from`.
- `fetchTxs(rpc, chain, hashes): Promise<TxRow[]>` (one batched `eth_getTransactionByHash`, at most 20 per tick) with `TxRow = { chain; hash; from; to?; selector?; nonce? }` (a row from `senderFromArgs` has only `from`).

- [ ] **Step 1: Write the failing tests:** times for three blocks come from one request; more than 20 blocks are cut to 20; `senderFromArgs` gives the payer for `DepositRequested` and `FeeCredited`, the user for `RedeemRequested`, the payer for the staker's `Staked`, `from` for `ReserveFunded`, and nothing for the vault's `Staked` or `Deposited`; only attributable events' transactions are fetched (the front door's `Delivered` yes, the Base adapter's `Delivered` no); a transaction row has the 4-byte selector of its input.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `attribute.ts`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): block times and the senders of attributable transactions`.

### Task 9: Seed pages and the two halves (pure)

**Files:**
- Create: `indexer/src/seed.ts`
- Test: `indexer/test/worker/seed.test.ts`

**Interfaces:**
- `type SeedEvent = { kind: "delivered"; batchId: string; key: Hex; txHash: Hex; block: string } | { kind: "staked"; block: string; txHash: Hex } | { kind: "payout"; key: Hex; chunk: number; taken: number; txHash: Hex; block: string }`.
- `seedEventsOf(logs: StoredLog[], d: Deployment): SeedEvent[]` (`vault:BatchDelivered` only with `sourceChain == 8453` and our front door; every `vault:Staked`; every `vault:PayoutChunkSent`; ordered by block then log index; `removed` logs never).
- `appendStatements(db, lastPage, events, pageSize = 500)`, `rebuildStatements(db, allEvents)`.
- `sharedHalf({ vault, from, next, events }): ScanState` (deposited and redeemed empty) and `accountHalf({ vault, from, next, deposited, redeemed }): ScanState` (delivered, staked and payouts empty) — pure, so the API and the fixture writer use the same code.

- [ ] **Step 1: Write the failing tests:** a delivery from another front door, or with `sourceChain` 1, is left out; staked and payout events keep their fields; 1,201 events become pages of 500, 500, 201; appending 10 to a page of 495 fills it to 500 and opens a page of 5; a rebuild after a removed log drops it; `sharedHalf` and `accountHalf` have the exact `ScanState` v1 keys with the other lists empty.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `seed.ts`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): pre-built seed pages and the two seed halves`.

*As built:* `seed.ts` stays pure (Node imports it); the statements `appendStatements` and `rebuildStatements` are in `store.ts`. Pages keep the half's three lists as JSON fragments (`appendPages`, `rebuildPages`, `pageEvents`), and `sharedHalfJson` builds the half by joining them, byte for byte `JSON.stringify(sharedHalf(...))`, parsing only a page across an edge of `[from, next)`.

## Part C — The API

### Task 10: `GET /v1/scan/{vault}` and `GET /v1/scan/{vault}/{account}` (Owner: Q8 for the origin)

**Files:**
- Create: `indexer/src/api.ts`, `indexer/test/worker/scan-state-rules.ts` (a port of the site's `decode` rules from main's `web/src/lib/cascade/scan-store.ts`, as an assertion helper), `indexer/scripts/write-seed-fixtures.ts`, `indexer/test/fixtures/seed-shared-v1.json`, `indexer/test/fixtures/seed-account-v1.json`
- Modify: `indexer/src/index.ts` (routes), `indexer/package.json` (`fixtures` script)
- Test: `indexer/test/worker/api-scan.test.ts`, `indexer/test/node/seed-fixtures.test.ts`

**Interfaces:**
- `handleScan(request, env, cfg)`: shared half from the Bittensor cursor and all `seed_pages`; account half from the cursor and `vault:Deposited`/`vault:Redeemed` rows with `topic2` = the account left-padded, `block ≤ settled_to`, `removed = 0`, each in one `db.batch()`; headers `Content-Type: application/json`, `Cache-Control: public, max-age=30`, `Access-Control-Allow-Origin: cfg.site.origin`, `Access-Control-Expose-Headers: Cascade-Settled-Time`, `Cascade-Settled-Time`; `OPTIONS` answers the preflight (`GET` only, no credentials). Checked **before any D1 query**, so the cache can't be sidestepped with variants: any query string → 400; the vault must be the configured vault in lowercase (any other spelling, or another vault or path → 404); the account must be `0x` and 40 lowercase hex digits (else 400). 405 for other methods; 503 with `Retry-After: 60` before the first Bittensor window is stored or when the D1 read fails.
- `scripts/write-seed-fixtures.ts` (node): builds both fixture halves from fixed rows with `sharedHalf`/`accountHalf` and writes them; the Part G tasks use these files.

- [ ] **Step 1: Write the failing tests** (seed D1 directly):
  - `serves the shared half`: `ScanState` v1, `vault` lowercase, `from` the Bittensor start block, `next = settled_to + 1`, account lists empty; passes `assertValidScanState(json, vault, from)`; equals `sharedHalf` of the same rows.
  - `serves the account half` with only that account's events, other accounts' events absent, deployment lists empty.
  - `variants are refused before D1`: the vault or account in mixed case, a trailing `?x=1`, or `?` alone → 400/404 with **zero** D1 queries (`d1-count`).
  - `every event is in [from, next)`: a stored log above `settled_to` isn't served; `removed logs are not served`.
  - `both halves of one tick share next`.
  - `another vault is 404`, `a bad account is 400`, `POST is 405`, `before the first window it is 503`, `a failing D1 read is 503`.
  - `CORS and caching headers` exactly as above; `OPTIONS` returns 204 with `Access-Control-Allow-Methods: GET`.
  - `the account half reads only that account's rows` (`d1-count`: rows read ≤ the account's event count + 2).
  - `seed-fixtures.test.ts` (node): running the writer produces exactly the committed fixtures (they are current).
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the routes and the writer; port `decode`'s rules from main's `web/src/lib/cascade/scan-store.ts` (as of `438deaf` or later); run `pnpm fixtures`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): the seed API in the site store's two halves, cached, CORS for the site`.

*As built (with the Tasks 1–10 review):* the account half reads by `logs_by_topic2` (`INDEXED BY`); D1 counts an index entry and its row apiece, so the rows-read test checks that other accounts' events add nothing rather than "count + 2". 503 also when `meta.deployment` is missing or another deployment's, the cursor starts at another block, a stored row can't be parsed, or the Worker isn't configured (each with CORS and `Retry-After`).

### Task 11: `GET /v1/status` and `GET /v1/health` (Owner: Q3)

**Files:**
- Modify: `indexer/src/api.ts`, `indexer/src/index.ts`
- Test: `indexer/test/worker/api-status.test.ts`

**Interfaces:**
- `handleStatus(env, cfg, nowS)`: the spec's section 8 JSON: `v: 1`; `deployment`; `hold: { active, ids }` from uncleared `holds`, where `ids` are the opaque `public_id`s (no internal ids, rule names, batch ids or summaries); `payouts: { okKeys }` = `delivered_key`s of `batch_checks` rows with status `ok` or `ok_by_owner`, `queued_block` set and `payout_done_block` null (the one completion source: spec section 6, "When a payout batch is done", filled by Task 12's readings); `indexer.{base,bittensor}: { settledTo, settledTime, lagS }` (`lagS = head_time − settled_time`, `head_time` being moved every tick even when no logs could be read); refuses query strings; `monitor.lastCompleteTickAt`; `generatedAt`; `Cache-Control: no-store`.
- `handleHealth(env, nowS)`: `200 ok` while `meta.last_complete_tick` is under 300 s old, else `503`; `Cache-Control: no-store`.

- [ ] **Step 1: Write the failing tests:** no hold → `active: false`, `ids: []`; two uncleared holds and one cleared → two ids, each matching `^h_[0-9a-f]{8}$`, and the body contains no internal hold id (`bridge.batch:…`), no summary and no alert subject or `alerts` key; a check `ok` or `ok_by_owner` with payouts queued and not done → its key in `okKeys`; `waiting` or `mismatch` → absent; `payout_done_block` set → absent; **a forged `mismatch` row and an honest `ok` row for the same batch id → only the honest key is listed**; `lagS` per chain is `head_time − settled_time`; `no-store` on both routes; health 200 at 299 s, 503 at 301 s; `no route writes`: for each route and for `POST`/`PUT`/`DELETE` on every path, every table's row count is unchanged.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** both routes.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): status with hold ids, confirmed payout keys and per-chain lag; a health probe`.

## Part D — Monitor core

### Task 12: State readings

**Files:**
- Create: `indexer/src/snapshot.ts`, `indexer/src/subtensor.ts`
- Test: `indexer/test/worker/snapshot.test.ts`

**Interfaces:**
- `interface Snapshot { at: number; base?: ChainReading<BaseState>; bittensor?: ChainReading<BitState>; nonces: Record<ChainName, Record<Hex, bigint>>; safeNonces: Record<Hex, bigint>; messageStates: Record<Hex, string>; deliveredReads: { key: Hex; chunk: number; block: bigint; value: boolean }[] }`, `ChainReading<T> = { block: bigint; time: number; state: T }`, with every field in the spec's section 6 "Readings" (each optional: a failed sub-call leaves it undefined and the rules that need it skip).
- `readSnapshot(rpc, cfg, { last: { base?: bigint; bittensor?: bigint }, hotkeys, pendingMessages, watched: { chain; address; roles; isSafe }[], payoutUsers: Hex[] /* ≤ 50 */, deliveredChecks: { key; chunk; message: Hex }[], pendingPayoutKeys: { key: Hex; queuedBlock: bigint }[] /* batch_checks with queued_block set and payout_done_block null */ })`: one multicall per chain (Task 5), `getPayoutBatch(key)` for each pending payout key (a key is **done** at the first reading whose block is after its `queuedBlock` with `count == 0`: `payoutDoneStatements` records `payout_done_block`, the one completion source for `okKeys` and `payout.overdue`), message states on each destination OffRamp, `burnWindows(peerId)` with `peerId = keccak256(abi.encode(uint64 8453, frontDoor))`, `claimable` and `deliveryOf` for `payoutUsers`, `nonce()` for Safe owners, `delivered(bridge, keccak256(message))` for `deliveredChecks`; one batched `eth_getTransactionCount(address, "latest")` per chain for the other watched addresses; **a chain's reading whose block isn't newer than `last` is dropped** (`base`/`bittensor` undefined).
- `subtensor.ts`: `ownerStorageKey(hotkey)` (`twox128("SubtensorModule") ++ twox128("Owner") ++ blake2_128_concat(hotkey)`, the two twox128 prefixes as constants, `@noble/hashes` blake2b, the method of `web/src/lib/cascade/apy.ts`), read by an `eth_call` to the storage-query precompile `0x…0807` inside the multicall; `decodeAccountId(data)` returns `null` for empty data.
- `compact(snapshot)` / `expand(json)` (bigints as strings) for `readings`; `hourRollup(prevHour, snapshot)` updates the running hourly aggregates (highest and lowest price, stakes, pool TAO and liquidity, supply, unclaimed rewards, spot price sum and count).

- [ ] **Step 1: Write the failing tests:** a fake multicall answer for every read becomes a full `Snapshot` with the block and time; one failed sub-call leaves only its field undefined; **a Base reading at a block not newer than `last.base` is dropped while Bittensor's is kept**; nonces come from one batched request per chain; a watched Safe's `nonce()` is read in the multicall instead; `delivered` reads come back with the block they were read at; a pending key reading `count == 0` at a block after its queue block is marked done, and at a block not after it (a node that hasn't seen the queue) is not; `compact`/`expand` round-trips; `hourRollup` keeps the highest price across ticks of one hour; `peerId` equals the vault's formula; `ownerStorageKey` for a fixed hotkey equals a key worked out by hand in the test; empty storage data decodes to `null`.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `snapshot.ts` and `subtensor.ts`. The Owner key against the live chain is checked by Task 30's smoke test.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): one block-pinned reading of both chains per tick, nonces, hourly rollups`.

### Task 13: Alerts and runbook lines

**Files:**
- Create: `indexer/src/alerts.ts`, `indexer/src/runbook.ts`, `indexer/src/rules/ids.ts`
- Test: `indexer/test/worker/alerts.test.ts`

**Interfaces:**
- `rules/ids.ts`: `RULES` — every rule id in the spec's section 6 tables with its tier (`"critical" | "warning"`), kind (`"condition" | "event"`), whether it can hold, and whether a hold mutes it.
- `runbook.ts`: `RUNBOOK: Record<RuleId, (facts: Record<string, string>) => string>` (the spec's "What to do" lines, values filled from facts, e.g. the cancel deadline).
- `interface Finding { rule: RuleId; key: string; subject: string; facts: Record<string, string>; hold?: { id: string; summary: string } }`.
- `reconcile({ open: AlertRow[], findings: Finding[], nowS, thresholds, holdActive }): { statements; due: AlertRow[] }`: a new key opens an alert; a persisting key updates `last_seen_at` only; a *condition* alert whose key isn't found resolves (a critical one is due as "resolved"); an *event* alert never resolves by absence and closes quietly 7 days after opening; criticals are due when never notified, or `notified_at + criticalResendS ≤ now` while unacknowledged and `notify_count < criticalMaxSends`; warnings are due as one group when the last warning email is at least `warningEveryS` old; findings of muted rules are dropped while `holdActive`; rules in `thresholds.rules.off` are dropped.
- `markSent(db, ids, nowS)`: the small statements of commit 2.

- [ ] **Step 1: Write the failing tests:** `every rule has a runbook line` (iterate `RULES`); a new critical is due; the same finding next tick is not due and not duplicated; at 3,600 s it is due again; after 6 sends it isn't; an acknowledged critical isn't re-sent; a cleared condition critical is due as resolved; an event critical missing from the next tick stays open with nothing due, and closes after 7 days; two warnings 10 minutes apart go out together at the 30-minute mark; `payout.overdue` is dropped while a hold is active; a rule in `rules.off` is dropped; a rule that can't hold never returns a hold.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): alert lifecycle by kind, resend policy, mutes, a runbook line for every rule`.

### Task 14: The rule framework and the prefetch

**Files:**
- Create: `indexer/src/rules/index.ts`, `indexer/src/rules/context.ts`
- Test: `indexer/test/worker/rules-framework.test.ts`

**Interfaces:**
- `interface RuleCtx { cfg; nowS; snap: Snapshot; previous: { base?: ChainReading; bittensor?: ChainReading } /* the last stored, older blocks */; hours: HourRow[] /* last 25, or 170 for weekly rules */; settled: Record<ChainName, { block: bigint; time: number; headTime?: number }>; payoutDelayS: number; lagLimitS: number; logs: LogQuery /* in memory */; checks: { batches; chunks }; t: Thresholds; holdActive: boolean }`. Rules never query D1.
- `prefetch(db, state): Promise<LogQuery>`: one `db.batch()` loading this tick's new logs, the open batch's front door logs, the logs of deliveries and chunks not yet `ok` or `mismatch` (with their transactions' other logs and the batch's front door history), the last 24 hours of request events, and the `txs`, `messages`, `batch_checks` and `chunk_checks` rows the rules read. `LogQuery` answers by (chain, role, event, block range) and by transaction (in log order).
- `runRules(rules, ctx)`: each rule in try/catch; a failure becomes a `monitor.rule_failed` finding keyed by rule id. Helpers: `twice(ctx, key, condition)` (true only when the condition held in the previous reading too, with increasing blocks), `afterSettled(ctx, otherChain, time)`.

- [ ] **Step 1: Write the failing tests:** a throwing rule doesn't stop the next one and becomes one `monitor.rule_failed` finding; `twice` is false on the first true reading and true on the second, and false when the second reading isn't newer; `afterSettled` is false until the other chain's settled time passes the event's time; `prefetch` is one D1 query (`d1-count`) and returns a delivery's same-transaction logs in log order and its batch's front door history; `prefetch` on a steady tick reads under 500 rows.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the framework.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): rule framework with one prefetch, failure isolation and debouncing`.

## Part E — The rules

Each rule task: write the failing tests in `indexer/test/worker/rules-<group>.test.ts` against a `RuleCtx` built from fixtures, run them (FAIL), implement in `indexer/src/rules/<group>.ts` and register the rules, run `pnpm test && pnpm typecheck` (PASS), commit. The tests below are the minimum.

### Task 15: Share price and stake

**Rules:** `price.drop`, `stake.unexplained_drop`, `stake.hotkey_changed` (spec 6.1).

- [ ] **Step 1: Failing tests:**
  - `price.drop` is computed only between readings with increasing blocks, and needs the next reading to confirm (×2).
  - `honest rounding is explained`: the v3-test case (a `Staked` with rao 77,877,093 and measured 77,877,092 in the range, price 1.28e-8 lower) → nothing; the same drop with no vault event in the range → a finding after the confirming reading; an `Unstaked` short of `wantRao`, a `StakeMoved` short of `rao` and a `PayoutChunkSent` with `gross − net − fee > 0` each explain their own wei.
  - `a sharp drop holds`: 11 bps below the 24-hour high from `hours` → hold id `price.drop:{bittensor block}`; after that hold is cleared, the high resets to the current price and the same drop doesn't hold again.
  - `a backward reading is not a drop`: a reading from an older block is never compared.
  - `stake.unexplained_drop`: a set hotkey's stake down 2,000 rao with a vault `Unstaked` in the range → nothing; without → finding with hold; not evaluated until Bittensor settled past the later reading.
  - `stake.hotkey_changed`: a changed `stakeHotkey` → finding; the hotkey's owner `null` on two readings → hold, on one → nothing.
- [ ] **Steps 2–5.** Commit `feat(indexer): share price and stake rules that subtract honest rounding, with the hold on a sharp drop`.

### Task 16: Admin events and watched keys

**Rules:** `admin.event`, `keys.unexplained_tx` (critical: an address holding owner, pending-owner or guardian), `keys.keeper_unexplained_tx` (warning: an address holding only the keeper role).

- [ ] **Step 1: Failing tests:** a `frontDoor:LimitSet` after the baseline → one finding naming the event, its args and the sender from `txs`; the same event in the baseline block → nothing; `vault:Paused` → finding; an address whose nonce rose by 2 with 2 transactions in `txs` → nothing; by 3 → finding only after 900 s; a transaction known through `senderFromArgs` (its own `DepositRequested.payer`, `FeeCredited.payer`, `ReserveFunded.from`) counts as seen; an address that is owner, guardian and keeper at once (as on v3-test) gets the critical rule, so there a reverted keeper call pages as critical (the runbook line says to expect that noise on v3-test); a keeper-only address gets the warning; a Safe owner is judged by its `nonce()` against admin events it executed; a newly watched address starts at its current count as baseline; facts include `https://basescan.org/address/{a}` or `https://evm.taostats.io/address/{a}`.
- [ ] **Steps 2–5.** Commit `feat(indexer): admin-event and unexplained-transaction rules, tiered by role`.

### Task 17: Solvency and vault events

**Rules:** `frontdoor.solvency`, `vault.solvency`, `deposits.bounced`, `vault.events` (warning).

- [ ] **Step 1: Failing tests:** front door TAO equal to `totalDeposits + totalClaimable` → nothing; one wei less on two readings with increasing blocks → finding with hold, on one → nothing; ETH below `feePot + totalFeeCredit` twice → finding; vault `rootStake × 1e9 + balance` below `pendingPayouts + 1e12` twice → finding with hold; one `vault:DepositBounced` → `deposits.bounced` naming the user and amount; `RedeemDeferred`, `PayoutDust`, `DepositSkipped` and an `unknown` log → `vault.events`; a csTAO `Transfer` → nothing.
- [ ] **Steps 2–5.** Commit `feat(indexer): front door and vault solvency rules, bounced deposits`.

### Task 18: Rebuilding a batch's message (pure)

**Files:** Create `indexer/src/crosscheck/replay.ts`; test `indexer/test/worker/replay.test.ts`.

**Interfaces:**
- `replayBatch(frontDoorLogs /* log order */, batchId: bigint): { deposits: Entry[]; redeems: Entry[] } | { error: string }` following `CascadeFrontDoor.sol`: `DepositRequested(id, user, amount)` adds to the user's slot or appends; `DepositCancelled(id, user, amount)` reduces, and a full cancel moves the last entry into the freed slot (`_reduce`); the same for redeems; a `BatchClosed` inside a `requestRedeem` transaction ends batch `id` before that transaction's `RedeemRequested(id + 1, …)`; a cancel for an entry that isn't there → `{ error }`.
- `encodeBatchMessage(batchId, deposits, redeems): Hex` and `batchKey(sourceChain, frontDoor, message): Hex`.

- [ ] **Step 1: Failing tests:** two deposits by one user merge; a partial cancel reduces; a full cancel of entry 0 of three moves entry 2 into slot 0; redeems alike; a self-close on a full redeem list ends the batch before the request that caused it; a cancel of a missing entry is an error; `encodeBatchMessage` equals viem's `encodeAbiParameters` of the same tuple; **real bytes** (fixture from Task 30, `it.todo` until then): the replayed lists of v3-test batches 1 and 2 give keys `0x07531aa4…39b48c` and `0xc2645240…7fd49c` (full values in the fixture), equal to their `BatchDelivered.key`.
- [ ] **Steps 2–5.** Commit `feat(indexer): rebuild a closed batch's message and key from the front door's events`.

### Task 19: The batch cross-check

**Files:** Create `indexer/src/crosscheck/pairing.ts`, `indexer/src/crosscheck/batches.ts`, `indexer/src/rules/bridge.ts`; test `indexer/test/worker/rules-bridge-batches.test.ts`, `indexer/test/worker/pairing.test.ts`.

**Interfaces:**
- `pairing.ts`: `pairSent(txLogs, { closer: "frontDoor:BatchClosed" | "vault:PayoutChunkSent", adapter: Role, sender: Hex })` (each closer pairs with the nearest earlier unpaired adapter `Sent` from `sender`, after the previous closer; a `PayoutChunkSent` with `net = 0` pairs with none); `groupDelivered(txLogs, { opener: "vault:BatchDelivered" | "frontDoor:PayoutsDelivered", adapter: Role, recipient: Hex })` (each opener's group holds the receiver's events after it, up to and paired with the first adapter `Delivered` to `recipient`).
- Results in `batch_checks`, **one row per delivery** (`batch_id`, `delivered_key`), each delivery checked once (`waiting`, `ok`, `mismatch`; `ok_by_owner` only ever comes from Task 24's script); the row records the delivery's `queued_block` when it queued payouts.

**Rules:** `bridge.batch_mismatch`, `bridge.duplicate` (batch side), `ccip.unexpected_source` (vault side), `bridge.check_stuck` (warning).

- [ ] **Step 1: Failing tests** (fixtures: an honest batch's Base and Bittensor logs, then each altered):
  - `pairing`: **two closes in one transaction** pair each `BatchClosed` with its own `Sent`; **two deliveries in one transaction** keep each group's outcomes and `Delivered` apart; a `PayoutChunkSent` with `net = 0` between two others takes no `Sent`.
  - `an honest batch passes` (`ok`); `two honest batches closed in one transaction both pass`; `two honest batches delivered in one transaction both pass`.
  - `a forged delivery reusing an honest batch id can't block it`: a forged `BatchDelivered` for batch 43 arrives before batch 43 closes (its row ends `mismatch` once Base is settled past it with no matching close, or when the close's key differs); the honest batch 43 then closes and is delivered → its own row is `ok` and its key is eligible for `okKeys`; `bridge.duplicate` still fires (and holds) because one batch id was delivered twice.
  - `bridge.check_stuck`: a row still `waiting` 61 minutes after its delivery → warning naming `pnpm checks:approve`.
  - `waits for Base`: Base settled time before the delivery's time → `waiting`, no finding.
  - `an amount that differs from totalDeposits`, `one more redeem outcome than nRedeems`, `a message id the Base adapter never sent`, `a key that isn't the replayed batch's`, `a deposit outcome naming another user`, `a burned redeem above its request`: each → `bridge.batch_mismatch` naming the failing step, hold id `bridge.batch:{id}`.
  - `can't rebuild` → the same rule, worded so.
  - `a second BatchDelivered for one batch id` → `bridge.duplicate` with hold; `a delivery from another front door` → `ccip.unexpected_source` with hold.
  - `the email facts carry the cancel deadline`: `queuedAt + payoutDelay` from the batch's `PayoutBatchQueued` and the reading's `payoutDelay`, as UTC.
- [ ] **Steps 2–5.** Commit `feat(indexer): cross-check every delivered batch, paired by log order, against the batch the front door closed`.

### Task 20: The payout cross-check

**Files:** Create `indexer/src/crosscheck/payouts.ts`; extend `indexer/src/rules/bridge.ts`; test `indexer/test/worker/rules-bridge-payouts.test.ts`.

**Interfaces:** `payoutList(vaultLogs, key): Payout[]` (bounced then redeemed, log order; equal to `ops/src/keeper/payouts.ts` `rebuildPayouts`); `chunkEntries(list, cursor, taken, gross, fee): Entry[]` (each `floor_rao(assets − ceil(assets × fee / gross))`, zeros dropped); `encodePayoutsMessage(key, chunk, entries)`; `deliveredChecks(chunkChecks)` hands Task 12 the `delivered(...)` reads to make (the hook into the snapshot).

**Rules:** `bridge.payout_mismatch`, `bridge.duplicate` (payout side), `ccip.unexpected_source` (Base side). Results in `chunk_checks`, **one row per landing**, keyed by the `PayoutsDelivered` log's uid (`waiting` → `awaiting_read` → `ok` | `mismatch`), so a forged duplicate landing is judged on its own row and never overwrites the honest one.

- [ ] **Step 1: Failing tests:** an honest chunk passes (two chunks of one batch: the second's cursor is the first's `taken`); **two chunks of different keys paid out in one transaction** and **two landings in one transaction** both pass, each `PayoutReceived` list filtered by (key, chunk); waits until Bittensor settled past the landing; `bridge` outside `BRIDGES` → mismatch; a second bridge added to `BRIDGES` → passes; `amount ≠ net` → mismatch; one user changed or one amount off by 1 wei → mismatch; a message id the Bittensor adapter never sent → mismatch; **`delivered(...)` false from a reading at a block before the landing → still `awaiting_read`**, false from a reading at or after the landing → mismatch, true → `ok`; a second landing for one (key, chunk) → `bridge.duplicate`, with the honest landing's row still `ok` and the forged one's `mismatch` (two rows); a `PayoutChunkSent` with `net = 0` expects no landing; `chunkEntries` matches `_deductFee` on a worked example; **real bytes** (Task 30 fixture): v3-test batch 2 chunk 0's recomputed message hash is the one `delivered(baseAdapter, …)` reads true for (`net = 77877092e9 − 1061267e9`).
- [ ] **Steps 2–5.** Commit `feat(indexer): cross-check every payout landing on Base, paired by log order, against the chunk the vault sent`.

### Task 21: Bridge messages

**Files:** Create `indexer/src/messages.ts`, `indexer/src/rules/ccip.ts`; test `indexer/test/worker/rules-ccip.test.ts`.

**Interfaces:** `messagesFrom(logs, d): MessageRow[]` (each adapter `Sent` whose sender is the front door or vault); a destination adapter `Delivered` with the message id sets `dst_tx`/`dst_block` and counts as arrived whatever the OffRamp says; `pendingMessages(db)` feeds Task 12's OffRamp reads.

**Rules:** `ccip.failure` (critical: `FAILURE` and no destination `Delivered`), `ccip.undelivered` (warning, 60 min), `ccip.foreign_send` (warning).

- [ ] **Step 1: Failing tests:** a front door `Sent` becomes a `base>bittensor` message; state `FAILURE` without a `Delivered` → `ccip.failure` with the ccip.chain.link link; **a destination `Delivered` resolves the message even if the OffRamp read still says `UNTOUCHED`** (an upgraded OffRamp); not arrived at 59 minutes → nothing, at 61 → `ccip.undelivered`; a stranger's `Sent` to the vault → `ccip.foreign_send`; a stranger's `Sent` elsewhere → nothing.
- [ ] **Steps 2–5.** Commit `feat(indexer): bridge message tracking, failures and slow deliveries`.

### Task 22: FM-TAO, prices and pools (Owner: Q6, Q13)

**Files:** Create `indexer/src/prices.ts`, `indexer/src/rules/market.ts`; test `indexer/test/worker/rules-market.test.ts`.

**Interfaces:** `referencePrice({ getJson, sources }): Promise<{ usd: number } | { unavailable: string }>` (CoinGecko `simple/price?ids=bittensor&vs_currencies=usd` and Coinbase `v2/prices/TAO-USD/spot`; median of those that answer; `unavailable` when they disagree by more than 2%, none answers, or none is configured); `poolPriceUsd(state)` from both pools' `sqrtPriceX96`; prices read every fifth minute; the spot price is added to the hourly rollup for the 30-minute mean.

**Rules:** `fmtao.unbacked`, `fmtao.depeg` (critical); `fmtao.mint_surge` (proposed, switchable), `twap.divergence`, `pool.liquidity`, `price.reference_unavailable` (warning).

- [ ] **Step 1: Failing tests:** supply equal to the lock → nothing; above lock + 0.01 TAO twice → `fmtao.unbacked`; pool 4.9% from the reference → nothing; 5.1% on two readings 5 minutes apart → `fmtao.depeg`; reference unavailable → no depeg finding, and after 61 minutes `price.reference_unavailable`; no sources configured → neither rule runs; sources 3% apart → unavailable; the oracle 3.1% from **the mean of the last 30 minutes of our own spot readings**, twice → `twap.divergence`; 2.9% → nothing; the oracle reverting twice → `twap.divergence` worded "unavailable"; TAO in the pool at 49% of its 7-day median (`hours`) → `pool.liquidity`; supply up 600 TAO in an hour with 50 TAO of Cascade payouts landed → `fmtao.mint_surge`, and nothing when it is in `rules.off`; `poolPriceUsd` matches a hand-computed price within 0.01%.
- [ ] **Steps 2–5.** Commit `feat(indexer): FM-TAO backing and peg, TWAP and pool rules`.

### Task 23: Operational warnings (Owner: Q13 for `rail.alpha_vault`)

**Files:** Create `indexer/src/rules/ops.ts`; test `indexer/test/worker/rules-ops.test.ts`.

**Rules:** `batch.past_max_wait` and `payout.overdue` (muted while held), `delivery.overdue` (from the readings' `claimable` and `deliveryOf` for recent payout users), `keeper.low_eth`, `keeper.low_tao`, `keeper.idle_unstaked`, `adapter.low_reserve`, `cap.nearly_full`, `batch.one_wallet`, `unstakes.tiny_wave`, `outflow.near_limit`, `rewards.uncollected`, `validator.not_earning`, `rail.alpha_vault` (critical, proposed, switchable), `indexer.lag` (warning) and `indexer.blind` (critical) on `lag = head_time − settled_time` (with `head_time` moved every tick by Task 28, even when no logs can be read) and limits from `lagLimitS` and the on-chain `payoutDelay`, `indexer.reorg`, `monitor.chain_unreadable`, `monitor.email_failing`.

- [ ] **Step 1: Failing tests,** one each side of every threshold, for example: open batch with entries at `openStart + max(interval, maxWait) + 14 min` → nothing, `+ 16 min` → warning, and nothing while a hold is active; a pending payout batch at `queuedAt + payoutDelay + 61 min` → warning; a user with `claimable > 0` and a live preference 121 minutes after their `PayoutReceived` → `delivery.overdue`; keeper ETH 0.0019 → warning; stakeable idle balance above the minimum stake for 2 h 1 min → `keeper.idle_unstaked`; `netForwarded + open` at 90% → warning; one payer (through the staker's `Staked.payer` in the same transaction) with 51% of a half-full batch → warning; 20 tiny redeems in 24 h → warning, 19 → nothing; burned plus waiting at 80% of the allowance → warning; last claim 36 days ago → warning; unclaimed rewards flat for 24 h with no claim → `validator.not_earning`; AlphaVault `migrationReadyAt != 0` → `rail.alpha_vault`; with `payoutDelay` 3,600, a lag of 16 minutes → `indexer.lag` (limit 15 min), 31 minutes → `indexer.blind`; with 86,400, 29 minutes → nothing, 31 → `indexer.lag`; `batch.past_max_wait` and `payout.overdue` read payout completion only from `payout_done_block`.
- [ ] **Steps 2–5.** Commit `feat(indexer): operational warnings, keeper liveness, validator earnings, payout-delay-based lag`.

## Part F — Hold, email, digest, integrity and the tick

### Task 24: The hold; the clear, acknowledge and approve scripts

**Files:**
- Create: `indexer/src/hold.ts`, `indexer/src/rules/approvals.ts`, `indexer/scripts/hold-clear.ts`, `indexer/scripts/alerts-ack.ts`, `indexer/scripts/checks-approve.ts`
- Modify: `indexer/package.json` (`hold:clear`, `alerts:ack`, `checks:approve` run with `node`)
- Test: `indexer/test/worker/hold.test.ts`, `indexer/test/worker/rules-approvals.test.ts`, `indexer/test/node/scripts-hold.test.ts`, `indexer/test/node/no-auto-clear.test.ts`

**Interfaces:**
- `holdStatements(db, findings, existingHoldIds, nowS)`: inserts a hold for each finding's `hold.id` not already present (cleared or not: a cleared id never re-raises), with a fresh random `public_id` (`h_` + 8 hex digits); never clears.
- `scripts/hold-clear.ts --env <test|production> (--id <hold id or public id> | --all) --note "<text>" [--dry-run]`: requires exactly one of `--id`/`--all`; validates (`--note` `^[A-Za-z0-9 .,:;()_-]{1,200}$`, ids `^[a-z0-9_.:-]{1,120}$`); first runs (or with `--dry-run` prints) a `SELECT id, public_id, rule, summary, raised_at FROM holds WHERE cleared_at IS NULL` and prints the active holds, then the `UPDATE … WHERE (id = ? OR public_id = ?) AND cleared_at IS NULL`; through `execFile` (no shell) of `pnpm wrangler d1 execute cascade-indexer-<env> --env <env> --remote --command "<SQL>"`. `scripts/alerts-ack.ts --env <env> <alert id> [--dry-run]` (id digits only).
- `scripts/checks-approve.ts --env <env> --key <delivered key> --note "<text>" [--dry-run]` (key `^0x[0-9a-f]{64}$`, the same note rule): prints the `batch_checks` row(s) for the key first (refuses if there is none, or if the key's row is already `ok`), then `UPDATE batch_checks SET status = 'ok_by_owner', approved_note = …, approved_at = … WHERE delivered_key = …`; through the same `execFile` path.
- `rules/approvals.ts`: `checks.owner_approved` (critical, event): a `batch_checks` row whose `approved_at` is newer than the last tick's `meta.approvals_seen` → one finding per approval, naming the key, batch id, note and time.

- [ ] **Step 1: Failing tests:** a finding with a hold raises one row with a public id; the same finding next tick doesn't add another; a cleared id isn't raised again; `no-auto-clear.test.ts` (node): nothing under `src/` contains `UPDATE holds` or sets `status = 'ok_by_owner'` (only the scripts clear and approve); `hold-clear` without `--id` or `--all` is refused; `--dry-run --id bridge.batch:42` prints the SELECT then the UPDATE limited to that id; `--id h_3f9a0c1e` works the same; `--all` prints the UPDATE for every active hold; a note with a quote or backtick is refused; `alerts-ack --dry-run 12` prints the `UPDATE alerts SET acknowledged_at` command; `checks-approve --dry-run` prints the row then the UPDATE, refuses an unknown key and a malformed key; after an approval (applied to the test D1 directly) the key is in `okKeys` (Task 11) and the next tick's rules return `checks.owner_approved` once.
- [ ] **Steps 2–5.** Commit `feat(indexer): the hold, cleared by id, and owner approval of a check, both only with account access and the approval emailed`.

### Task 25: Email (Owner: Q2)

**Files:** Create `indexer/src/email.ts`; test `indexer/test/worker/email.test.ts`.

**Interfaces:**
- `renderCritical`, `renderWarnings`, `renderResolved`, `renderDigest`, `renderDbFailing(error, nowS)` → `{ subject; text; html }` (subjects `[CASCADE CRITICAL] …`, `[Cascade warning] {n} new: …`, `[Cascade resolved] …`, `[Cascade daily] {date}: …`; body: what happened, facts with explorer links, **What to do**, the hold, how to acknowledge, and the footer "Act from your own tools, never from a link in this email.").
- `sendAll(env, cfg, messages): Promise<{ sent: number[]; failed: { id; code }[] }>` through `env.EMAIL.send(...)`, or `console.log` in `log` mode; a thrown `E_*` error marks that message failed and continues.

- [ ] **Step 1: Failing tests:** a `bridge.batch_mismatch` email names the batch, the failing step, the cancel deadline and the guardian and owner steps; every rendered email has `text` and `html` and the footer; links only to basescan.org, evm.taostats.io, taostats.io, ccip.chain.link or the status URL, never `http://`; `log` mode never calls the binding; a binding that throws `E_RATE_LIMIT_EXCEEDED` for the first message still sends the second; the `monitor.db_failing` email renders without any D1 data.
- [ ] **Steps 2–5.** Commit `feat(indexer): alert and digest emails with a what-to-do line, log mode for dev`.

### Task 26: The daily digest

**Files:** Create `indexer/src/digest.ts`, `indexer/src/apy.ts` (a port of `web/src/lib/cascade/apy.ts`'s `basketTwrKey`, `decodeTwr`, `netApyPercent`); test `indexer/test/worker/digest.test.ts`.

**Interfaces:** `buildDigest(ctx, db, nowS)` with the spec's section 6.5 contents (24-hour windows by chain time; fees from `staker:Staked.fees`, `vault:RewardCutMinted.assets`, `vault:PayoutChunkSent.fee`, `frontDoor:BatchClosed.fee`; APY from two archive reads of `BasketTwr` 216,000 blocks apart); `digestDue(meta, nowS)` (false once `meta.digest_date` is today, UTC).

- [ ] **Step 1: Failing tests:** a fixture day with 3 batches closed, 2 delivered, 1 paid out gives those counts; fees sum per kind; open alerts listed with ages; `CRITICAL open` in the subject when one is; **a second daily invocation the same UTC day sends nothing**; `netApyPercent` gives the web's result on the web test's fixture values.
- [ ] **Steps 2–5.** Commit `feat(indexer): the daily digest, sent once per UTC day`.

### Task 27: Website integrity, in its own cron (Owner: Q1 for the files-per-run budget)

**Files:** Create `indexer/src/site.ts`, `indexer/src/site-job.ts`, `indexer/src/rules/site.ts`, `indexer/src/site-approved.ts` (generated), `indexer/scripts/site-approved.ts`; modify `indexer/src/index.ts` (dispatch `CRONS.site`); test `indexer/test/worker/site.test.ts`, `indexer/test/node/site-approved.test.ts`.

**Interfaces:**
- `ADDRESS_RE = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g`; `HOST_RE` for `https://` hosts; `CHUNK_RE` for `/_next/static/chunks/….js` paths.
- `scripts/site-approved.ts <web/out dir>` (node): reads every `.html` and `_next/static/**/*.js`, writes `src/site-approved.ts` (`APPROVED_ADDRESSES`, `APPROVED_HOSTS`, lowercased, deduplicated, sorted, with the build date in a comment).
- `readCapped(response, maxBytes): Promise<{ text: string } | { tooLarge: true }>`: reads the body as a stream and cancels it past `maxBytes` (`SITE_MAX_BYTES`, 2 MB), never buffering more.
- `runSiteJob({ db, getText, cfg, nowS })` (the `*/2` cron, never the tick): reads `meta.site_pass`; if no pass is running and the last finished an hour or more ago, starts one (fetches `cfg.site.pages`, records inline-script findings and the initial `<script src>` list); **if `meta.site_trying` names a file (an earlier invocation died on it), skips that file, records it as unchecked and clears the mark**; then for up to `SITE_FILES_PER_RUN` files: writes `meta.site_trying = file` (its own small D1 write) **before** fetching, fetches with `readCapped`, scans, records addresses, hosts and newly named chunk paths (lazy chunks, up to 80 files), clears the mark; on completion writes the pass's result to `meta.site_result` and resets. It sends no email: its subrequests and CPU are its own, and the tick reads `meta.site_result`.
- `rules/site.ts` (run by the tick from the prefetched `meta`): `site.integrity` (critical: a configured Cascade address missing from a complete pass, an unapproved address or host, a file over the byte cap, or a file that stopped an invocation) and `site.unreachable` (warning, 30 minutes without a successful fetch).

- [ ] **Step 1: Failing tests:** a fixture site whose files hold exactly the approved addresses and hosts → nothing after a complete pass; one extra address → critical naming it and the file; a new RPC host → critical; the front door's address missing → critical; **a 64-hex hash doesn't match as an address**; a lazy chunk named only inside another chunk is fetched and scanned; a pass over 6 files with 2 files per run completes on the third run; more than 80 files → the first 80 and a warning; **a 3 MB file is cancelled at 2 MB (the fake body counts bytes read) and reported as too large**; **a file whose scan throws mid-run (simulating a killed invocation: the mark is written, the run aborts before clearing it) is skipped by the next run and reported, and the pass completes**; the site job never calls the email binding and never touches the lease; the script on a fixture `out/` directory writes sorted, deduplicated, lowercased lists.
- [ ] **Steps 2–5.** Commit `feat(indexer): the site's addresses and hosts checked in their own cron, byte-capped, skipping a file that kills a run`.

### Task 28: The tick, the jobs and the watchdog (Owner: Q1 for the budgets)

**Files:** Create `indexer/src/tick.ts`, `indexer/src/hourly.ts`, `indexer/src/daily.ts`; modify `indexer/src/index.ts`; test `indexer/test/worker/tick.test.ts`.

**Interfaces:**
- `runTick(deps: { env; cfg; rpc; getJson; nowS; nowMs: () => number; minute; holder /* random per tick */ }): Promise<TickReport>` doing the spec's section 1 steps in order: lease (`LEASE_S`, 180 s) → `loadTickState` → `storedUids` (REREAD ranges) → `scanChain` Bittensor then Base (subrequest and decode budgets, and `deadlineMs = start + SCAN_WALL_S`) → block times, transactions → `readSnapshot` → **`head_time` for each chain from `headTimeOf` (the newer of the scan's head time and the reading's block time, else the clock)**, `payout_done_block` updates, messages, check rows → `prefetch` (including `meta.site_result`) → `runRules` → `reconcile`, `holdStatements` → **commit 1** (`guardStatement(holder)` first; logs, removed marks, cursors with `head_time`, seed pages, blocks, txs, reading, hourly rollup, messages, checks, alerts, holds, `meta.last_complete_tick`, failure counters) → `sendAll` for the due alerts → **commit 2** (`markSent`, release the lease). If commit 1 throws: read `leaseHolder` once; if another tick holds it, stop quietly (no email); otherwise send no alert emails and, when `minute === 0`, send `renderDbFailing` straight from memory.
- `runHourly`: watchdog (`meta.last_complete_tick` older than 15 min → `monitor.stalled` alert and email, sent by the job itself), hourly rollup close, prune `readings` to 120 and `hours` to 35 days. `runDaily`: the watchdog again, then the digest if `digestDue`. The site check is Task 27's own cron, not part of either.
- `scheduled(controller, env, ctx)` dispatches by `CRONS` (tick, site, hourly, daily); any other cron is logged and ignored. Each invocation builds its own budgets and RPC client.

- [ ] **Step 1: Failing tests** (fake RPC through the injected fetch; `worker.scheduled` with `createScheduledController`; `d1-count` around `env.DB`):
  - `a first tick backfills, stores, reads and evaluates`: logs stored, cursors set, a reading and an hour row stored, `meta.last_complete_tick` set.
  - `an honest round trip raises nothing and its batch key appears in okKeys`; `a forged batch raises the critical, the hold and one email`, and its key never appears in `okKeys`.
  - `an alert is committed before its email is sent`: a fake `EMAIL` that reads D1 when called finds the alert row.
  - `a commit that fails sends no alert emails, then one db_failing email only at minute 0`; ten failing ticks at minutes 1–10 send nothing.
  - `a lease taken over mid-tick makes commit 1 fail whole, and sends no db_failing email even at minute 0`.
  - **`a long backfill always makes progress`**: a fake RPC slow enough that 40 s covers only part of the backlog → the tick stops at the wall-time limit, commits (its lease, 180 s, hasn't been taken), and the next tick resumes from the new cursor; over several ticks the backlog is consumed.
  - **`a logs RPC that fails for 20 minutes while readings work`**: the fake logs endpoint errors from minute 0 to minute 20 while the multicall answers with advancing blocks → `head_time` moves every tick, the status's `lagS` grows by about 60 a tick, `indexer.lag` fires once it passes `lagLimitS` (15 min with `payoutDelay` 3,600), `indexer.blind` at 30, and both clear after the endpoint returns and the scan catches up. (Task 38 feeds this status to the keeper and asserts it holds.)
  - `with every RPC failing, head_time follows the Worker's clock`, so the lag still grows.
  - `the site cron runs the site job and never the tick's work`; `a site result in meta becomes a site.integrity alert on the next tick`.
  - `an email that fails stays due and is retried next tick; the tick still commits`.
  - `a chain that can't be read, or reads backwards, for 5 ticks raises monitor.chain_unreadable`; the other chain is still scanned.
  - `the hourly job raises monitor.stalled when the last complete tick is 16 minutes old`; `the daily job too`.
  - `the hourly job prunes readings to 120 and hours to 35 days`; `the daily cron sends the digest once`; `an unknown cron does nothing`.
  - `subrequests never exceed the budget in one invocation`, and `logs decoded never exceed the decode budget plus one block` during a long backfill.
  - *From the Tasks 1–10 build:* `loadTickState` runs first and `checkDeployment(meta, d)` decides: "other" refuses the tick (log line only); every commit 1 includes `deploymentStatement`. Pass `scanChain` a `reserve` sized for everything after the scan (about 10, not 5) and `window: cfg.baseLogWindow` for Base; give each chain a share of the decode budget, or Base can starve while Bittensor backfills; rebuild the seed pages when the scan returns removed logs or an upsert whose uid was stored at another block.
  - `D1 queries stay at 6 or fewer per tick and rows read under 2,000 on a steady tick` (`d1-count`).
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck && pnpm bundle`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): the minute tick with a wall-time limit and a lag that sees a stuck scan, commit-then-send, the hourly and daily jobs and their watchdog`.

*As built:* `runTick({ env, cfg, fetch, now, scheduledMs, holder?, sleep?, spacingMs? })` builds its own budgets and RPC client (deadline: the lease less 30 s). Bittensor is scanned with a reserve of 14 and three quarters of the wall time, Base with a reserve of 10 and the rest; Bittensor gets half the decode budget, Base the rest. Block times and transactions are fetched after the prefetch (which says what is stored): the new settled block first (settled_to moves only once its time is known), then the blocks the cross-checks wait on, then the new logs' blocks; transactions not fetched wait in `meta.tx_backlog`. Every watched address is read both ways (its count, and `nonce()` in case it is a Safe), from the stored rows and the last reading's role holders. Catching up (after the reviews): only during the first backfill, until both chains first come within their lag limit (`lagLimitOf`, so the end of a backfill never pages; `meta.caught_up`, set once), and only for a chain further behind whose lag shrank by a minute or more this tick (its settled time gained that much beyond its head's); a frozen settled block, or one that only keeps pace, is stuck and alerts. Every rule runs, the cross-checks included (`afterSettled` makes them wait); while catching up, that chain's `indexer.lag`/`indexer.blind` and every `bridge.check_stuck`/`bridge.payout_unchecked` are quiet, passed to `reconcile` so an open one is neither resolved nor re-sent. The prefetch also loads the open batch's deposit transactions, adapters' `Delivered` by message id (an arrival stored before its `Sent`), and block times of the loaded transactions and recent ranges. Alert ids and raised holds' public ids come back from commit 1 (`RETURNING`). A failed commit 1 releases the lease when it can. The watchdog is in `src/hourly.ts` (`runHourly`), the digest job in `src/daily.ts` (`runDaily`, with the APY read the site's way); the digest counters are reset per UTC day together (`countStatements`). Tests: `tick.test.ts`, `jobs.test.ts`, `index.test.ts` (with the global fetch stubbed).

*After the review of `indexer-tick`:* a D1 error after the lease (the load, the re-read query, the prefetch, the seed logs) is `db_failing` like a failed commit, with the minute-0 email; the hourly and daily jobs run at their scheduled time; a watched address is read as a Safe only from contract code of its own (never an EIP-7702 delegation); a transaction the node never returns is given up after 10 answered tries. New rule `keys.delegated` (critical, holds): every role wallet's code, the treasuries' too, read in the count batch, compared with the first code seen, ×2 (`test/worker/rules-delegation.test.ts`).

### Task 29: Config from the ops record, and the package README (Owner: Q1, Q2)

**Files:** Create `indexer/scripts/config-from-record.ts`, `indexer/README.md`; test `indexer/test/node/config-from-record.test.ts`.

**Interfaces:**
- `config-from-record.ts <record.json>`: loads the ops record with the `{ $bigint }` reviver (`ops/src/record.ts`), refuses one whose `verify.ok` isn't true or that isn't a v3 plan, and prints the `DEPLOYMENT` JSON (addresses from `plan.addresses`; Bittensor start block from `done.bitAdapter.block`, exactly what `pnpm ops web-config` writes as `NEXT_PUBLIC_CASCADE_BIT_BLOCK`; Base start block from `done.baseAdapter.block`; baseline blocks = the highest recorded step block per chain; vault coldkey and stake hotkey from the vault step's args; `batchMaxWaitS` from the plan's cadence) and the default `BRIDGES`.
- `README.md`: what the Worker does; local dev (spec section 10); the deploy steps (spec section 11, "the owner does these"), starting with the plan choice: Workers Paid for the account, or Free with one environment per account (a second account for test), never both environments in one Free account, and stating option (b)'s limits (the test Worker in the second account can't send email from cascadefi.xyz, since a Worker sends only from an Email Routing domain in its own account, and can't use `api.cascadefi.xyz`, since a custom domain must be a zone in its own account: it uses its `workers.dev` URL and `ALERT_MODE=log` or a domain of its own); the hold, acknowledge, approve and site-approval scripts; threshold overrides by the `THRESHOLDS` variable or the `THRESHOLDS_SECRET` secret, and keyed RPC URLs as `BASE_RPC_URL_SECRET`, `BASE_LOGS_RPC_URL_SECRET` and `BITTENSOR_RPC_URL_SECRET` (a secret can't share a var's name); `DECODE_BUDGET` and `SUBREQUEST_BUDGET` raised on Workers Paid.

- [ ] **Step 1: Failing tests** on a fixture record shaped like `ops/deployments/v3-test.json` (fake addresses): the output parses with `parseConfig`; the Bittensor start block equals `done.bitAdapter.block`; a record without `verify.ok` is refused; a v2 record is refused; a recovered Bittensor adapter without a block is refused with the keeper's `startBlock` advice.
- [ ] **Steps 2–5.** Commit `feat(indexer): DEPLOYMENT config from a verified ops record; package README with the plan choice`.

*As built:* Base starts at the Base adapter's block, else the first Base step recorded (said so); `batchMaxWaitS` is compared with ops' `CADENCE` by a node test. `env.test`'s `DEPLOYMENT` holds what the script prints for `ops/deployments/v3-test.json` (Bittensor from 9368744), as a JSON value; a node test parses the whole `env.test` config. The Task 27 polish came with it: quoted same-origin `"/….js"` paths are followed, a `data:`/`blob:` script is named as such, `site:approved --extra-hosts`, and the runbook's limits.

### Task 30: Recorded fixtures and the live smoke test

**Files:** Create `indexer/scripts/record-fixtures.ts`, `indexer/test/fixtures/v3-test-batches.json`, `indexer/test/fixtures/v3-test-chunk.json`, `indexer/test/smoke/live.test.ts`; modify `indexer/package.json` (`smoke`: `INDEXER_SMOKE=1 vitest run --project smoke`), `indexer/vitest.config.ts` (a `smoke` project, not in `pnpm test`).

- [ ] **Step 1:** Run `node scripts/record-fixtures.ts ../ops/deployments/v3-test.json` once (read-only public RPC calls): it saves the front door's logs for **v3-test batches 1 and 2** (from the batch's first request to its close), their delivery transactions' full logs on Bittensor, and **batch 2's chunk 0** (the `processPayouts` transaction and its landing on Base, with the `delivered(...)` answer at the landing block). Turn Task 18's and Task 20's `it.todo` real-bytes tests into tests with the expected keys (`0x07531aa4…39b48c`, `0xc2645240…7fd49c`, full values in the fixture) and message id; run them. Expected: PASS (a mismatch means the replay or pairing is wrong: fix it first).
- [ ] **Step 2: Write the smoke test:** one `runTick` against the live v3 test deployment with Miniflare D1 and `ALERT_MODE=log`; asserts both cursors moved, a reading was stored, the hotkey Owner read is non-null for the stake hotkey, both halves for the test wallet pass `assertValidScanState`, batches 1 and 2 end `ok`, and prints the digest.
- [ ] **Step 3: Run** `pnpm smoke` (network). Expected: PASS; skim the digest for nonsense values.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `test(indexer): real-bytes fixtures of v3-test batches 1–2 and chunk 0; a live smoke run`.

*As built:* the recorder (`pnpm fixtures:record`, 10 read-only requests) also records `test/fixtures/v3-test-reads.json` (the stake hotkey's Owner, 32 bytes; an absent one, empty; FM-TAO 8,778 on Base against 13,912 locked). `tick-v3.test.ts` runs the recorded scenario through whole ticks and measures (local workerd): a steady tick 6 D1 queries and 149 rows read; about 110–125 µs to hash and decode a log, 23–26 ms for a 204-log batch delivery. `pnpm smoke` runs through `scripts/smoke.ts` (any shell) with at most `SMOKE_BUDGET` (40) requests; in one tick both chains are still catching up, so it asserts batches 1 and 2 only once they are not (they are checked end to end by the recorded scenario instead). Its digest showed the share price at 1e-6: fixed (TAO per csTAO is `price / 1e12`).

## Part G — The site uses the seed (re-check main first)

**Re-check main first.** `web-hardening` is merged into main (`438deaf`) and its branch deleted; these tasks were written against main at that commit. Before starting, read main's current `scan-store.ts`, `facts.ts` and `live.ts` and confirm the shapes these tasks assume: the store saves a deployment-wide half (`cascade.scan.<frontDoor>.<bitBlock>`, account lists empty) and a per-account half (deployment lists empty) and `load` merges them at the earlier `next`; `decode` marks deliveries and account events `unconfirmed`; `deliveryOf` uses a delivery only when its receipt shows it; `checkDeliveries` and `confirmAccountEvents` confirm by receipt; `receiptAt` answers "not there" only from a server `REREAD` blocks past the block; stakes and chunks are used, unconfirmed, in four places: `depositFacts`' first stake after a delivery (`facts.ts` l.496), `withdrawalFacts`' `chunkOf` (l.547, which sums `taken`, l.597), `deliveryFacts`' `payouts.get(key)?.[0]` (l.623) and `chainDeposits`' `staked` flag (l.869). Adjust the tasks to the code as it is before writing tests. Branch from main. Every task runs `pnpm test`, `pnpm typecheck` and `pnpm lint` in `web/`.

### Task 31: The indexer URL in the site's config

**Files:** Modify `web/src/lib/cascade/config.ts` (`Deployment.indexerUrl?`, from `NEXT_PUBLIC_CASCADE_INDEXER_URL`: `https://` only, no trailing slash, else absent), `ops/src/webconfig.ts` (writes `NEXT_PUBLIC_CASCADE_INDEXER_URL` when `OPS_INDEXER_URL` is an `https://` URL); tests in `web/src/lib/cascade/config.test.ts`, `ops/test/webconfig.test.ts`.

- [ ] **Step 1: Failing tests:** `https://api.cascadefi.xyz` kept; `http://…`, a trailing slash or junk → absent; `webEnv` with `OPS_INDEXER_URL` writes the line, without it writes nothing new.
- [ ] **Steps 2–5.** Commit `feat(web,ops): optional indexer URL in the site's deployment config`.

### Task 32: Fetching the two halves

**Files:** Create `web/src/lib/cascade/indexer.ts`; test `web/src/lib/cascade/indexer.test.ts`; copy `indexer/test/fixtures/seed-shared-v1.json` and `seed-account-v1.json` into `web/src/lib/cascade/__fixtures__/`.

**Interfaces:** `fetchSeed(d, account, { fetch?, timeoutMs? /* 5000 */ }): Promise<{ shared: unknown; own: unknown } | null>` (both `GET {indexerUrl}/v1/scan/{vault}` and `/v1/scan/{vault}/{account}` in parallel; null if either fails: no URL, timeout, network error, non-200, invalid JSON; never throws); `indexerDistrusted(storage, d, now)` and `distrustIndexer(storage, d, now, hours = 24)` (per deployment, in the op log's storage, try/catch).

- [ ] **Step 1: Failing tests:** both fixtures returned on 200s; one half failing → null; timeout, 503, invalid JSON or a thrown fetch → null; distrust lasts 24 hours, per deployment; blocked storage never throws.
- [ ] **Steps 2–5.** Commit `feat(web): fetch the indexer's two seed halves, never throwing, with a 24-hour distrust switch`.

### Task 33: Seeding through the store's own merge

**Files:** Modify `web/src/lib/cascade/scan-store.ts` (extract `load`'s half-merging into an exported `mergeHalves(scan, shared, own): boolean` used by `load` and by the new `seedHalves(scan, shared, own): boolean`, which decodes both, merges at the earlier `next` and marks both halves seeded; **both** saved halves gain an optional `seeded?: true`, kept by `save` and read by `decode`: the account half's mark (`VaultScan.accountSeeded`) is cleared by Task 35's check, the shared half's (`VaultScan.sharedSeeded`) only when a restart rebuilds that half from the browser's own scan, so a contradiction found later on any account's trail still knows the indexer was its source), `web/src/lib/cascade/facts.ts` (`VaultScan.sharedSeeded?: true`, `accountSeeded?: true`); tests in `scan-store.test.ts`.

- [ ] **Step 1: Failing tests:** `load` behaves exactly as before (existing tests unchanged); `seedHalves` with the fixtures moves the scan to their `next` with deliveries and account events `unconfirmed` (as `decode` already does) and both marks set; a half for another vault or deploy block → nothing changes; halves behind the saved scan → nothing changes; after `save` and `load`, both marks survive; **a second account loading the same deployment gets `sharedSeeded` from the shared half** even though its own half isn't seeded; older saved halves without the marks load unseeded; a restart from the deploy block clears `sharedSeeded` once the browser's own scan has rewritten the shared half.
- [ ] **Steps 2–5.** Commit `feat(web): seed a scan through the store's own half-merge, marked seeded`.

### Task 34: Stakes and payout chunks confirmed on use

**Files:** Modify `web/src/lib/cascade/facts.ts`; tests in `facts.test.ts`.

**Interfaces:**
- `confirmedStakeAfter(c, d, scan, block)`: the first stake after `block` whose receipt shows the vault's `Staked`.
- `confirmedChunks(c, d, scan, key)`: the key's chunks, **only if they are numbered `0 … n` with no gap** and every one's receipt shows `PayoutChunkSent` with that key, chunk and `taken`; otherwise undefined (the trail waits). `chunkOf` then maps an entry over these alone.
- **All four consumers use them** (spec section 5, step 3): `depositFacts`' stake after a delivery (l.496), `withdrawalFacts`' `chunkOf` (l.547), `deliveryFacts`' first chunk (`payouts.get(key)?.[0]`, l.623, becomes `confirmedChunks(…)?.[0]`), and `chainDeposits`' `staked` flag (l.869, becomes "a confirmed stake after it").
- **Stakes and chunks are treated alike:** a receipt that contradicts a stake or a chunk (from a server `REREAD` past its block), or a chunk gap in a scan whose shared half is `sharedSeeded`, discards the shared half (restart from the deploy block) and, when `sharedSeeded`, distrusts the indexer. A gap in the browser's own scan only makes the trail wait. Receipts are cached for the visit.

- [ ] **Step 1: Failing tests:** a confirmed stake is shown in `depositFacts` and sets `chainDeposits`' `staked`; **a seeded stake whose receipt holds no vault `Staked` restarts the scan and distrusts the indexer** (the same as a chunk), while an unseeded one restarts without distrust; chunks `0, 1, 2` all confirmed map an entry correctly in `withdrawalFacts` and give `deliveryFacts` its first chunk; **chunks `0, 2` (chunk 1 left out by a seed) → no mapping, restart and distrust**; the same gap in the browser's own scan → the trail waits, no restart; a chunk whose receipt shows another `taken` restarts (and distrusts when seeded); a receipt not yet readable leaves the trail at its previous step (never a guess); entries from the browser's own scan follow the same code path.
- [ ] **Steps 2–5.** Commit `feat(web): stakes and payout chunks count only when confirmed by receipt and, for chunks, complete`.

### Task 35: Completeness: tripwire and a provisional figure (Owner: Q14)

**Files:** Modify `web/src/lib/cascade/facts.ts` (`confirmAccountEvents` keeps each event's `shares`), `web/src/lib/cascade/live.ts` (after a seeded scan reaches the head: the tripwire `Σ Deposited.shares − Σ Redeemed.shares == balanceOf(account)` at block `scan.next − 1`; while the account half is `accountSeeded`, `rewardsEarnedTao` is returned as provisional and a background check reads the account's own `Deposited`/`Redeemed` from the deploy block to the seed's `next` (topic-filtered by user, 1,000-block windows, resumable, progress saved: about 2,600 archive windows per year of deployment age, acceptable because it runs in the background and never blocks the page); an exact match clears `accountSeeded`; a mismatch discards both halves, distrusts the indexer and restarts), `web/src/lib/cascade/types.ts` (`PositionHistory.rewardsProvisional?: true`) and the component that shows the figure ("checking…"); tests in `live.test.ts` and the component's test.

- [ ] **Step 1: Failing tests:** a seeded scan whose shares add up shows the figure marked provisional; when the background check matches, the next read shows it final and `accountSeeded` is cleared in storage (the shared half's mark stays); a seed missing a matched set (deposit, its full redeem, a later deposit) passes the tripwire but fails the background check → discarded, distrusted, restarted; a seed missing a single `Deposited` fails the tripwire at once; an unseeded scan is never checked and never provisional (today's behaviour, including a direct depositor's); a failed `balanceOf` read leaves the figure hidden for this read, not wrong.
- [ ] **Steps 2–5.** Commit `feat(web): a seeded history's rewards figure is provisional until the browser's own check matches`.

### Task 36: Catching an omitted delivery

**Files:** Modify `web/src/lib/cascade/live.ts` (for a record whose batch closed more than 2 hours before a seeded scan's `next` with no delivery in the scan: read the Bittensor windows from the close time to `next` directly; a delivery found there means the seed lied: discard, distrust, restart); tests in `live.test.ts`.

- [ ] **Step 1: Failing tests:** an op-log deposit whose batch closed 3 hours before `next` and whose delivery the seed left out is found, and the seed is discarded and distrusted; one closed 1 hour before isn't checked; the direct read covers only the windows between the close time and `next`; an unseeded scan is never checked this way.
- [ ] **Steps 2–5.** Commit `feat(web): a delivery a seed left out is looked for directly`.

### Task 37: Wiring the seed into `scanFor`

**Files:** Modify `web/src/lib/cascade/live.ts` (`LiveDeps.fetchSeed`; in `scanFor`, after `known(account)`: when `d.indexerUrl` is set, the indexer isn't distrusted, and the head is more than 14,400 blocks past `scan.next`, `seedHalves(scan, …)` before scanning on, then save both halves); tests in `live.test.ts`.

- [ ] **Step 1: Failing tests:** with the fixtures, a first visit reads only the windows after the seed's `next` (count `getLogs` calls) and the account's events are confirmed before amounts show; the indexer down (null) → today's full scan, no error shown; a distrusted indexer isn't asked; a scan within 2 days of the head doesn't ask; no indexer URL → no fetch at all; `getAvailable` still counts a seeded delivery only after `checkDeliveries` confirms it (unchanged behaviour).
- [ ] **Steps 2–5.** Commit `feat(web): a first visit starts from the indexer's halves, verified, and falls back to its own scan`.

## Part H — The keeper reads the status (later; Owner: Q3, Q4)

### Task 38: Reading the status

**Files:** Create `ops/src/keeper/hold.ts`; test `ops/test/keeper-hold.test.ts`.

**Interfaces:**
- `lagLimitS(payoutDelayS) = min(1800, floor(payoutDelayS / 4))` (the monitor's formula).
- `readMonitor({ url?: string; file: string /* ops/hold.json */; rec: DeploymentRecord; fetch; nowMs; payoutDelayS /* read on chain by readState */ }): Promise<MonitorView>` with `MonitorView = { configured: false } | { configured: true; hold?: string /* explicit: hold.active or the file */; outage?: string /* unreadable, bad v, other deployment, stale or lagging */; okKeys?: Set<string> }`: no URL and no file → `{ configured: false }`; the file with `hold: true` (or unparsable) → `hold`; otherwise `GET url` (10-second timeout): unreadable or unparsable, `v ≠ 1`, `deployment.frontDoor`/`vault` not the record's → `outage`; on either chain, `lagS + (now − lastCompleteTickAt)` **or** `now − settledTime` (the keeper's own clock against the settled block's time) above `lagLimitS(payoutDelayS)` → `outage` naming the chain and which test tripped; `hold.active` → `hold` (its opaque ids); `okKeys` from `payouts.okKeys`. Reasons never contain the URL (redacted host only).

- [ ] **Step 1: Failing tests:** each case above; with `payoutDelay` 3,600 a Bittensor `lagS` of 800 plus a status 101 s old (901 s) is an outage, 899 s isn't; **a status whose `lagS` reads small but whose Bittensor `settledTime` is 16 minutes old by the keeper's clock is an outage** (the second test); **the status sequence recorded from Task 28's "logs RPC fails for 20 minutes" test** (copied as a fixture) turns into an outage once `lagS` passes 900, and back to healthy after; with 86,400 the limit is 1,800; a hold and an outage can both be present; the URL's path never appears in a reason.
- [ ] **Steps 2–5.** Commit `feat(ops): read the monitor's status: hold, outage and confirmed payout keys`.

### Task 39: The keeper respects it

**Files:** Modify `ops/src/keeper/actions.ts` (`close` with `nRedeems > 0`, `roll` and `payouts` consult `readMonitor`: held when `hold` is set, or `outage` is set and no valid override applies; `payouts(key)` additionally requires `okKeys.has(key)` whenever the monitor is configured and not in an overridden outage; `runLoop` reads the monitor once a round, skips those actions with one log line per change of reason, and still does deposit-only closes, staking and deliveries), `ops/src/cli.ts` (`OPS_HOLD_URL`; `--ignore-monitor-outage --until <UTC ISO time>` at most 24 hours ahead, for `run`, `close`, `roll` and `payouts`: bypasses only `outage` (and, during one, the per-key check), never `hold`; a warning every round; refused when `--until` is past or more than 24 h ahead), `ops/src/keeper/status.ts` (prints the monitor view); tests in `ops/test/keeper-actions.test.ts`, `ops/test/cli.test.ts`.

- [ ] **Step 1: Failing tests:**
  - held → a batch with a redeem isn't closed, no roll is sent, and no payout is sent, while a deposit-only close and `stakeIdle` go ahead; the reason is logged once until it changes.
  - **monitor healthy, key not in `okKeys` → that payout isn't sent; another key that is `ok` is**; a key the owner approved by hand (`ok_by_owner`, listed in `okKeys`) is sent.
  - **the logs RPC down for 20 minutes** (Task 38's status fixture, round by round): redeem closes, rolls and payouts stop once the lag passes the limit, and resume after it recovers.
  - outage (unreadable, stale or lagging) → held; with `--ignore-monitor-outage --until` an hour ahead → sent, with a warning each round; at `--until` it lapses; with an explicit hold or `ops/hold.json` → still held despite the flag.
  - the one-shot `pnpm ops close`, `pnpm ops roll` and `pnpm ops payouts <key>` refuse the same way, naming the reason.
  - `--until` in the past, or more than 24 h ahead, is refused.
  - no `OPS_HOLD_URL` and no file → today's behaviour exactly (existing tests unchanged).
  - deliveries are unaffected (Q4 default).
- [ ] **Steps 2–5.** Commit `feat(ops): the keeper pays only confirmed batches and holds redeem closes, rolls and payouts while the monitor says so or can't see`.
