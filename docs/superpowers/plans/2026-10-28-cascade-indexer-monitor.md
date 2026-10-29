# Cascade History Indexer and Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker (`indexer/`) with a cron trigger and a D1 database that serves the site's vault-scan seed and monitors both chains and the bridge, emailing critical, warning and daily alerts and raising a hold the keeper reads; then the site's use of the seed (verified, with fallback) and the keeper's reading of the hold.

**Architecture:** One Worker, two handlers. `scheduled` runs a tick every minute (scan Bittensor and Base logs incrementally with the keeper's windows, REREAD, SETTLE and reorg-safe log identity; read both chains' state through Multicall3; run the rules; update alerts and holds; send email), an hourly job (site integrity, liquidity medians, pruning) and a daily digest. `fetch` serves three read-only routes: the seed (`ScanState` v1, exactly what `seedScan` takes), the status with the hold, and a health probe. Pure logic (decoding, identity, replay, cross-checks, rules, email rendering) is separated from I/O and tested inside workerd with the Cloudflare Vitest plugin, a real Miniflare D1 and a fake JSON-RPC server.

**Tech Stack:** Node 24.11, pnpm 11.23.0, TypeScript 5.9.3, vitest 5.0.5, `@cloudflare/vitest-plugin` 1.4.2, wrangler 4.151.0 (the plugin's pinned wrangler), viem 2.57.7 and `@noble/hashes` 1.8.0 (the web app's versions), `@types/node` 24.19.2 for the Node scripts. Types for the Workers runtime come from `wrangler types` (committed `worker-configuration.d.ts`).

**Spec:** `docs/superpowers/specs/2026-10-28-cascade-indexer-monitor-design.md`. Contracts as tagged `v3.1`; keeper scan on main `76926ba` (`ops/src/keeper/state.ts`); the site's scan on branch `web-hardening` (`web/src/lib/cascade/facts.ts`, `live.ts`, `scan-store.ts`).

## Global Constraints

- Parts A–F touch only `indexer/`. Part G (site) starts after `web-hardening` merges into main and touches `web/` and `ops/src/webconfig.ts`. Part H (keeper) is a later task and touches `ops/`.
- Nothing is deployed and no Cloudflare resource is created while executing this plan: no `wrangler login`, `wrangler deploy`, `wrangler d1 create`, `wrangler secret put`, and no `--remote` flag anywhere. Local runs use Miniflare's local D1 (`.wrangler/state`, git-ignored). The owner does the deploy later (spec section 11).
- The Worker holds no key and never sends a transaction: no private key, mnemonic or signer anywhere in `indexer/`; Task 1 adds a test that fails if `eth_sendRawTransaction` or `eth_sendTransaction` appears under `indexer/src`.
- No `.env*` file is created, read or edited. Local secrets for `wrangler dev` go in `indexer/.dev.vars`, which is git-ignored and never committed; tests never need it.
- No personal email address and no RPC key in any committed file: recipients come from the `ALERT_TO` secret, keyed RPC URLs from secrets.
- Every external `fetch` goes through `src/rpc.ts` (or `src/http.ts` for price APIs and the site) and spends the invocation's subrequest budget (`Budget`, 45 of the free plan's 50 by default). Every D1 write of a tick is committed in one `db.batch()`.
- RPC URLs are never printed: errors and logs use `redact(url)` (scheme and host only).
- Chain amounts are `bigint` in code and decimal strings in JSON and D1; addresses, hashes and topics are lowercase hex in D1 and in the API.
- The scan numbers are the keeper's: windows Base 100 (configurable via `BASE_LOG_WINDOW`) and Bittensor 1,000; REREAD Base 70, Bittensor 400; SETTLE Base 30, Bittensor 10. A log window is accepted only from a server whose head (asked in the same JSON-RPC batch) has reached the window's end.
- Thresholds live only in `src/thresholds.ts` (spec section 6 defaults), overridable by the `THRESHOLDS` variable.
- Every rule id has a runbook line in `src/runbook.ts` (Task 13's test enforces it). Emails carry explorer links and hashes only, never a link to sign anything.
- Dependencies are pinned exactly and `indexer/pnpm-lock.yaml` is committed. In `indexer/pnpm-workspace.yaml`, `allowBuilds` approves only the packages wrangler needs to install its binaries (`esbuild`, `workerd`) if pnpm asks; everything else `false`.
- Tests never reach the network, except `pnpm smoke` (Task 30), which is read-only and skipped unless `INDEXER_SMOKE=1`.
- Commit trailer on every commit: the two attribution lines the executing session is given (`Co-Authored-By: …` and `Claude-Session: …`).

## Review Focus

1. A lagging or load-balanced RPC node must never make the scanner skip blocks: a window whose server head is below its end is never stored as "no logs", and the cursor never moves past the last whole window (Task 7 tests `a lagging node never advances the cursor`, `budget exhaustion keeps the last whole window`).
2. A reorg must never store a log twice, and a stored log that vanishes must be flagged, not silently kept (Task 7 tests `a re-mined copy is the same log`, `a vanished log is marked removed`).
3. The batch cross-check must fail a forged batch (an added redeem entry, a changed amount, an unknown message id, a different key) and must never judge an honest batch before its Base side is stored (Task 19 tests).
4. The seed must never contain an event outside `[from, next)`, a removed log, or another deployment's events, and must pass `seedScan`'s own `decode` (Task 10 contract test; Task 37 feeds the fixture to the real `seedScan`).
5. Nothing over HTTP can set or clear the hold or write anything (Task 11 test `no route writes`); the keeper fails closed when the status is unreadable or stale (Task 38).
6. An email failure must not lose an alert (retried next tick) and must not stop the tick (Tasks 25, 28).
7. The site must not show an amount from a seeded event before its receipt confirms it, and must fall back to its own scan on any indexer failure (Tasks 34, 35, 37).

---

## Part A — Package, config, RPC and decoding

### Task 1: The `indexer/` package

**Files:**
- Create: `indexer/package.json`, `indexer/pnpm-workspace.yaml`, `indexer/tsconfig.json`, `indexer/vitest.config.ts`, `indexer/wrangler.jsonc`, `indexer/.gitignore`, `indexer/src/index.ts`, `indexer/worker-configuration.d.ts` (generated)
- Test: `indexer/test/worker/index.test.ts`, `indexer/test/node/no-signing.test.ts`

**Interfaces:**
- `package.json`: `"name": "cascade-indexer"`, `"private": true`, `"type": "module"`, `"packageManager": "pnpm@11.23.0"`; scripts `test` (`vitest run`), `typecheck` (`tsc --noEmit`), `types` (`wrangler types`), `dev` (`wrangler dev --env test --test-scheduled`), `wrangler` (`wrangler`), and placeholders filled by later tasks: `smoke`, `config:from-record`, `site:addresses`, `hold:clear`, `alerts:ack`.
- `wrangler.jsonc`: `name: "cascade-indexer"`, `main: "src/index.ts"`, `compatibility_date: "2026-10-14"`, `observability: { enabled: true }`, `triggers.crons: ["* * * * *", "17 * * * *", "0 13 * * *"]`, `"cache": { "enabled": true }`; `env.test` and `env.production` each with a `d1_databases` entry `{ binding: "DB", database_name: "cascade-indexer-<env>", database_id: "local-only-<env>", migrations_dir: "migrations" }` (the owner replaces the id at deploy), a `send_email` entry `{ name: "EMAIL", allowed_sender_addresses: ["monitor@cascade.fi"] }`, and `vars` (Task 2). No `remote: true` anywhere.
- `.gitignore`: `node_modules/`, `.wrangler/`, `.dev.vars*`, `coverage/`.
- `vitest.config.ts`: two projects. `worker`: `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc", environment: "test" }, miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("migrations") } } })`, include `test/worker/**/*.test.ts`, setup file `test/worker/setup.ts` (applies migrations; empty until Task 6). `node`: `environment: "node"`, include `test/node/**/*.test.ts`.
- `src/index.ts`: `export default { fetch, scheduled } satisfies ExportedHandler<Env>`; for now `fetch` returns 404 and `scheduled` returns.

- [ ] **Step 1: Write the failing tests.**
  - `index.test.ts`: `GET https://x/nope` through `exports.default.fetch` returns 404; `worker.scheduled(createScheduledController({ cron: "* * * * *" }), env, createExecutionContext())` resolves.
  - `no-signing.test.ts` (node): no file under `indexer/src` contains `eth_sendRawTransaction`, `eth_sendTransaction`, `privateKeyToAccount`, `mnemonicToAccount` or `signTransaction`.
- [ ] **Step 2: Run** `pnpm install` then `pnpm test` (in `indexer/`). Expected: FAIL (no `src/index.ts`).
- [ ] **Step 3: Implement** the stub and the config files; run `pnpm types` to generate `worker-configuration.d.ts`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): package scaffold, wrangler config, test projects` (include `pnpm-lock.yaml` and the generated types).

### Task 2: Config and thresholds

**Files:**
- Create: `indexer/src/config.ts`, `indexer/src/thresholds.ts`
- Modify: `indexer/wrangler.jsonc` (`vars` for `env.test`, from the spec's section 9 table, with `DEPLOYMENT` left as a placeholder JSON the Task 29 script fills)
- Test: `indexer/test/worker/config.test.ts`

**Interfaces:**
- `thresholds.ts`: `export const DEFAULTS` with every number in spec section 6 (`priceDropEpsilon: 1e-9`, `holdPriceDropBps: 10`, `stakeDustRao: 1000n`, `unexplainedTxGraceS: 900`, `fmtaoBackingSlackWei: 10n ** 16n`, `depegBps: 500`, `undeliveredS: 3600`, `maxWaitGraceS: 900`, `payoutGraceS: 3600`, `deliveryGraceS: 7200`, `keeperMinEthWei: 2n * 10n ** 15n`, `keeperMinTaoWei: 10n ** 17n`, `adapterMinReserveWei: 5n * 10n ** 11n`, `twapDivergenceBps: 200`, `liquidityDropPct: 50`, `oneWalletPct: 50`, `oneWalletEntries: 10`, `capNearlyFullPct: 90`, `tinyUnstakeWei: 2n * 10n ** 16n`, `tinyUnstakeCount: 20`, `redeemListPct: 80`, `outflowNearPct: 80`, `rewardsMaxAgeS: 35 * 86400`, `rewardsDueWei: 25n * 57n * 10n ** 15n`, `lagWarnS: 900`, `lagCriticalS: 7200`, `mintSurgeWei: 500n * 10n ** 18n`, `criticalResendS: 3600`, `criticalMaxSends: 6`, `warningEveryS: 1800`, `siteUnreachableS: 1800`, `chainUnreadableTicks: 5`, `emailFailingS: 1800`); `type Thresholds = typeof DEFAULTS`; `mergeThresholds(json: string | undefined): Thresholds` (bigints given as decimal strings; unknown keys refused).
- `config.ts`: `interface Config { deployment: Deployment; tokens: Tokens; rpc: { base: string; baseLogs: string; bittensor: string }; baseLogWindow: bigint; site: { origin: string; url: string; pages: string[] }; alerts: { from: string; mode: "send" | "log"; to: string[] }; thresholds: Thresholds; priceSources: ("coingecko" | "coinbase")[] }`; `interface Deployment { id: string /* "<frontDoor>:<vault>" lowercase */; base: { chainId: 8453; startBlock: bigint; baselineBlock: bigint }; bittensor: { chainId: 964; startBlock: bigint; baselineBlock: bigint }; frontDoor, baseAdapter, staker, oracle, vault, bitAdapter: Address; vaultColdkey: Hex; stakeHotkey: Hex; batchMaxWaitS: number }`; `parseConfig(env: Env): Config` (throws `ConfigError` naming the field, never the value of a secret); `redact(url): string` (scheme and host only).
- Secrets `BASE_RPC_URL`, `BASE_LOGS_RPC_URL`, `BITTENSOR_RPC_URL` override the same-named vars when present; `ALERT_TO` is a comma list of addresses (may be empty in `log` mode).

- [ ] **Step 1: Write the failing tests:** a full test env parses; an address that isn't checksummed is refused naming `DEPLOYMENT.frontDoor`; a start block that isn't an integer is refused; `THRESHOLDS='{"depegBps":300}'` overrides one value and keeps the rest; `THRESHOLDS='{"nope":1}'` is refused; a secret RPC URL overrides the var; `redact("https://x.example/key/abc")` is `"https://x.example"`; `ALERT_MODE` other than `send`/`log` is refused; the `ConfigError` message for a bad `BITTENSOR_RPC_URL` secret never contains the secret's value.
- [ ] **Step 2: Run** `pnpm test test/worker/config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `config.ts` and `thresholds.ts`; fill `env.test.vars` (public RPCs, `BASE_LOG_WINDOW: "100"`, `SITE_ORIGIN`, `SITE_URL`, `SITE_PAGES`, `ALERT_FROM`, `ALERT_MODE: "log"`, `THRESHOLDS: "{}"`, `PRICE_SOURCES`, `TOKENS` from `ops/src/config.ts` `LIVE`/`BASE_V3` plus Multicall3).
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): config and thresholds, validated at every invocation`.

### Task 3: ABIs, decoding and log identity

**Files:**
- Create: `indexer/src/abi.ts`, `indexer/src/logs.ts`
- Test: `indexer/test/worker/logs.test.ts`

**Interfaces:**
- `abi.ts`: `VAULT`, `FRONT_DOOR`, `STAKER`, `ADAPTER`, `BASE_ADMIN` (CascadeBase plus OpenZeppelin `Paused`, `Unpaused`, `OwnershipTransferStarted`, `OwnershipTransferred`), `ERC20`, `UNISWAP_POOL` (`slot0`, `liquidity`), `ORACLE`, `OFFRAMP` (`getExecutionState`), `ALPHA_VAULT`, `STAKING` (`getStake`, `getUnclaimedRootTaoByHotkey`), `MULTICALL3` (`aggregate3`, `getEthBalance`), each event exactly as in `contracts/src` (spec Facts); `ADMIN_EVENTS: ReadonlySet<string>` (the spec's admin list).
- `logs.ts`: `interface RawLog { address: Hex; topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex; transactionHash: Hex }`; `interface StoredLog { uid: Hex; chain: ChainName; block: bigint; logIndex: number; txHash: Hex; address: Hex; event: string; topic1?: Hex; topic2?: Hex; topic3?: Hex; data: Hex; args: Record<string, string | number | boolean> }`; `identify(chain, logs: RawLog[]): StoredLog[]` (uid = `keccak256(toBytes(`${chain}:${txHash}:${topics.join(",")}:${data}#${n}`))`, n counting identical logs in one transaction, exactly the keeper's `identified()` plus the chain); `decode(chain, raw, abiFor: (address) => Abi | undefined)` (event name, args with bigints as decimal strings, lowercase addresses; `"unknown"` and `{}` when no ABI matches).

- [ ] **Step 1: Write the failing tests:**
  - `decodes BatchDelivered`: a log built with viem `encodeEventTopics`/`encodeAbiParameters` decodes to `{ event: "BatchDelivered", args: { key, sourceChain: "8453", frontDoor, batchId: "7", amount: "40000000000000000" } }`.
  - `an unknown topic is "unknown"`.
  - `a re-mined copy is the same log`: the same transaction and content at block 10 index 3 and at block 11 index 0 give one uid.
  - `two identical logs in one transaction get #0 and #1` (two uids).
  - `the same log on another chain is another uid`.
  - `ADMIN_EVENTS covers every admin event in the contracts`: for each of `CascadeBase.sol`, `CascadeVault.sol`, `CascadeFrontDoor.sol`, `CascadeStaker.sol`, the listed admin event names exist in the ABI (guards against typos).
- [ ] **Step 2: Run** `pnpm test test/worker/logs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `abi.ts` (with viem `parseAbi`) and `logs.ts`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): contract ABIs, log decoding and the keeper's reorg-safe log identity`.

### Task 4: RPC client and the subrequest budget

**Files:**
- Create: `indexer/src/rpc.ts`, `indexer/src/http.ts`
- Test: `indexer/test/worker/rpc.test.ts`, `indexer/test/worker/fake-rpc.ts` (test helper)

**Interfaces:**
- `class Budget { constructor(limit: number); spend(n = 1): void /* throws BudgetExhausted */; get left(): number }`.
- `interface Rpc { call(chain: ChainName, method: string, params: unknown[]): Promise<unknown>; batch(chain: ChainName, calls: { method: string; params: unknown[] }[]): Promise<unknown[]>; logsWithHead(chain: ChainName, filter: { address: Hex[]; fromBlock: bigint; toBlock: bigint }): Promise<{ logs: RawLog[]; head: bigint }> }`.
- `createRpc({ urls: Record<ChainName | "baseLogs", string>, fetch: typeof fetch, budget: Budget, spacingMs?: Partial<Record<ChainName, number>> /* base 300, bittensor 500 */, sleep?: (ms) => Promise<void>, retries?: number /* 3 */ }): Rpc`. A batch is one `fetch` (one budget unit); answers are matched by id; an error member throws `RpcError { chain, method, code, message }` with the URL redacted; HTTP 429 and 5xx retry with backoff (2 s, 4 s, 8 s); `logsWithHead` sends `[eth_getLogs, eth_blockNumber]` as one batch to the Base logs URL for Base.
- `http.ts`: `getJson(url, { fetch, budget, timeoutMs })` and `getText(...)` for price APIs and the site (also one budget unit each, timeouts via `AbortSignal.timeout`).
- `test/worker/fake-rpc.ts`: `fakeChain({ head, logs, calls: Record<string, (params) => unknown>, lagBy?, failNext? })` returning a `fetch` that answers JSON-RPC (single and batch) for both chains, used by every later test.

- [ ] **Step 1: Write the failing tests:** a batch of three calls is one `fetch` and spends one budget unit; answers out of order are matched by id; a 429 then 200 succeeds after one backoff (injected `sleep` records 2,000); four 429s throw `RpcError` whose message contains neither the URL's path nor its query; spending past the limit throws `BudgetExhausted` before the `fetch`; two Base calls are at least 300 ms apart (injected clock); `logsWithHead` returns the server's head from the same request.
- [ ] **Step 2: Run** `pnpm test test/worker/rpc.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `rpc.ts`, `http.ts` and the fake.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): one JSON-RPC choke point with batching, backoff, redaction and a subrequest budget`.

### Task 5: Multicall3 reads

**Files:**
- Create: `indexer/src/multicall.ts`
- Test: `indexer/test/worker/multicall.test.ts`

**Interfaces:**
- `type Read = { address: Hex; abi: Abi; functionName: string; args?: unknown[] } | { ethBalance: Hex }`.
- `multicall(rpc, chain, reads: Read[], blockTag: "latest" | bigint = "latest"): Promise<({ ok: true; value: unknown } | { ok: false })[]>`: one `eth_call` to Multicall3 `aggregate3` with `allowFailure: true` (ETH balances through `getEthBalance`), results in input order; a sub-call that reverted or returned undecodable data is `{ ok: false }`.

- [ ] **Step 1: Write the failing tests** (fake RPC answering `eth_call` with an `aggregate3` result built by viem's `encodeFunctionResult`): three reads decode in order; a failed sub-call is `{ ok: false }` and the others still decode; an ETH balance read returns a bigint; reads at a past block send that block tag.
- [ ] **Step 2: Run** `pnpm test test/worker/multicall.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `multicall.ts`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): Multicall3 reads with per-call failure`.

## Part B — Storage and scanning

### Task 6: D1 schema and the store

**Files:**
- Create: `indexer/migrations/0001_init.sql` (exactly the spec's section 2), `indexer/src/store.ts`
- Modify: `indexer/test/worker/setup.ts` (apply `TEST_MIGRATIONS` with `applyD1Migrations`)
- Test: `indexer/test/worker/store.test.ts`

**Interfaces:**
- `store.ts` returns `D1PreparedStatement`s to be committed together, plus a few reads: `loadTickState(db): Promise<{ cursors; openAlerts; activeHolds; lastReadings: Reading[] /* last 60 */; nonces; meta }>` (one `db.batch()`); `takeLease(db, name, holder, untilS, nowS): Promise<boolean>`; statements `insertLogs(db, logs)` (`INSERT OR IGNORE`), `markRemoved(db, uids)`, `setCursor(db, chain, { scannedTo, settledTo, settledTime, nowS })` (SQL keeps `settled_to = MAX(settled_to, ?)`), `upsertBlocks`, `insertTxs`, `insertReading`, `setMeta`; query helpers `logsByEvent(db, chain, events, fromBlock, toBlock)`, `logsByTx(db, chain, txHash)`, `accountLogs(db, account, settledTo)`.

- [ ] **Step 1: Write the failing tests:** the migration applies and every table exists; `takeLease` succeeds once, refuses while held, succeeds after `until`; inserting the same log twice leaves one row; `setCursor` with a smaller `settledTo` leaves the larger one; a `db.batch()` containing a statement that violates a constraint changes nothing (atomic); `loadTickState` on an empty database returns no cursors and is one batch.
- [ ] **Step 2: Run** `pnpm test test/worker/store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the migration and `store.ts` (prepared statements only; no string-built SQL).
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): D1 schema, lease and batched store statements`.

### Task 7: The incremental scanner

**Files:**
- Create: `indexer/src/scan.ts`
- Test: `indexer/test/worker/scan.test.ts`

**Interfaces:**
- `const WINDOW = { base: cfg.baseLogWindow, bittensor: 1000n }`, `REREAD = { base: 70n, bittensor: 400n }`, `SETTLE = { base: 30n, bittensor: 10n }` (exported; a test pins them to the keeper's values).
- `interface ScanResult { stored: StoredLog[] /* settled, new to the store */; fresh: StoredLog[] /* unsettled, not stored */; removed: Hex[] /* stored uids missing from a re-read */; cursor: { scannedTo: bigint; settledTo: bigint }; head: bigint; stopped?: "budget" | "lagging" | "error" }`.
- `scanChain({ rpc, chain, addresses, startBlock, cursor, storedUidsIn: (from, to) => Promise<Set<Hex>> }): Promise<ScanResult>` implementing the spec's section 3.2 loop (start at `startBlock` when `scannedTo` is null, else `max(startBlock, scannedTo + 1 − REREAD)`; one `logsWithHead` per window; a server head below the window's end is retried once, then the chain stops for this tick with the cursor at the last whole window; `BudgetExhausted` stops the same way; settled = block ≤ head − SETTLE).

- [ ] **Step 1: Write the failing tests** (fake RPC, Bittensor numbers unless stated):
  - `the first scan reads from the start block in 1,000-block windows`: start 1,000, head 3,500 → windows `[1000,1999]`, `[2000,2999]`, `[3000,3500]`.
  - `a later scan starts REREAD blocks back`: `scannedTo` 3,500 → the next starts at 3,101.
  - `logs within SETTLE are returned but not stored` and `are stored on the next tick once settled`.
  - `a re-mined copy is the same log`: a log stored at block 3,480 re-read at block 3,482 (same tx and content) is not in `stored`.
  - `a vanished log is marked removed`: a stored uid in the re-read range, absent from a read whose server reached the window's end, is in `removed`.
  - `a lagging node never advances the cursor`: the server head is 2,500 for window `[2000,2999]` twice → `stopped: "lagging"`, `scannedTo` 1,999, nothing in `[2000,2999]` stored.
  - `budget exhaustion keeps the last whole window`: budget of 2 → two windows read, `stopped: "budget"`, `scannedTo` 2,999.
  - `Base uses its own window`: Base window 100 (and 2,000 when configured).
  - `the scan numbers are the keeper's`: `REREAD`, `SETTLE` and the Bittensor window equal `ops/src/keeper/state.ts`'s constants (read that file's text in the test and compare the numbers).
- [ ] **Step 2: Run** `pnpm test test/worker/scan.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `scan.ts`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): incremental log scan with REREAD, SETTLE, reorg-safe identity and lag checks`.

### Task 8: Block times and transaction attribution

**Files:**
- Create: `indexer/src/attribute.ts`
- Test: `indexer/test/worker/attribute.test.ts`

**Interfaces:**
- `blockTimes(rpc, chain, numbers: bigint[]): Promise<Map<bigint, number>>` (one batched `eth_getBlockByNumber(n, false)` request, at most 20 blocks per tick per chain; the rest wait for the next tick).
- `ATTRIBUTABLE: ReadonlySet<string>` (`BatchClosed`, `BatchRolled`, `PayoutChunkSent`, vault `Staked`, front door `Delivered`, `RewardsClaimed`, `HotkeyAdded`, every `ADMIN_EVENTS` member).
- `senderFromArgs(log: StoredLog): Hex | undefined` (front door `RedeemRequested`, `RedeemCancelled`, `DepositCancelled`, `Claimed`, `DeliverySet` → `user`; staker `Staked` → `payer`).
- `fetchTxs(rpc, chain, hashes: Hex[]): Promise<TxRow[]>` (one batched `eth_getTransactionByHash` request, at most 20 per tick) with `TxRow = { chain; hash; from; to?; selector?; nonce? }` (a row recorded through `senderFromArgs` has only `from`).

- [ ] **Step 1: Write the failing tests:** times for three blocks come from one request; more than 20 blocks are cut to 20; `senderFromArgs` names the user for `RedeemRequested` and the payer for the staker's `Staked`, and nothing for `DepositRequested` (whose `user` is the beneficiary, not the sender); only attributable events' transactions are fetched; a transaction row has the 4-byte selector of its input.
- [ ] **Step 2: Run** `pnpm test test/worker/attribute.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `attribute.ts`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): block times and the senders of attributable transactions`.

### Task 9: Seed pages

**Files:**
- Create: `indexer/src/seed.ts`
- Test: `indexer/test/worker/seed.test.ts`

**Interfaces:**
- `type SeedEvent = { kind: "delivered"; batchId: string; key: Hex; txHash: Hex; block: string } | { kind: "staked"; block: string; txHash: Hex } | { kind: "payout"; key: Hex; chunk: number; taken: number; txHash: Hex; block: string }`.
- `seedEventsOf(logs: StoredLog[], d: Deployment): SeedEvent[]` (vault `BatchDelivered` only with `sourceChain == 8453` and our front door; every vault `Staked`; every `PayoutChunkSent`; ordered by block then log index; `removed` logs never).
- `appendStatements(db, lastPage: { page; count; json } | null, events: SeedEvent[], pageSize = 500): D1PreparedStatement[]`; `rebuildStatements(db, allEvents): D1PreparedStatement[]` (delete and rewrite all pages).

- [ ] **Step 1: Write the failing tests:** a delivery from another front door, or with `sourceChain` 1, is left out; staked and payout events are kept with their fields; 1,201 events become pages of 500, 500, 201; appending 10 to a page of 495 fills it to 500 and opens a page of 5; a rebuild after a removed log drops it.
- [ ] **Step 2: Run** `pnpm test test/worker/seed.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `seed.ts`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): pre-built pages of the deployment-wide seed events`.

## Part C — The API

### Task 10: `GET /v1/scan/{vault}/{account}`

**Files:**
- Create: `indexer/src/api.ts`, `indexer/test/worker/scan-state-rules.ts` (a port of `seedScan`'s `decode` rules from `web-hardening`'s `scan-store.ts`, as an assertion helper)
- Modify: `indexer/src/index.ts` (route)
- Test: `indexer/test/worker/api-scan.test.ts`; writes `indexer/test/fixtures/seed-v1.json`

**Interfaces:**
- `handleScan(request, env, cfg): Promise<Response>`: one `db.batch()` reading the Bittensor cursor, all `seed_pages` and the account's `Deposited`/`Redeemed` (`event`, `topic2 = account`, `block ≤ settled_to`, `removed = 0`); body exactly `ScanState` v1 (spec section 4); headers `Content-Type: application/json`, `Cache-Control: public, max-age=30`, `Access-Control-Allow-Origin: cfg.site.origin`, `Access-Control-Expose-Headers: Cascade-Settled-Time`, `Cascade-Settled-Time`; `OPTIONS` answers the preflight (`GET` only, no credentials); 400 for an account that isn't 40 hex digits, 404 for another vault or path, 405 for other methods, 503 with `Retry-After: 60` before the first Bittensor window is stored.

- [ ] **Step 1: Write the failing tests** (seed D1 directly with logs and pages):
  - `serves ScanState v1`: `v`, `vault` lowercase, `from` the Bittensor start block, `next = settled_to + 1`, the five lists; passes `assertValidScanState(json, vault, from)`; writes the response to `test/fixtures/seed-v1.json` (committed; the web tasks use it).
  - `every event is in [from, next)`: a stored log above `settled_to` (inserted directly) is not served.
  - `removed logs are not served`.
  - `the account is case-insensitive and other accounts' events are not served` (the query matches `topic2`, the account left-padded to 32 bytes).
  - `another vault is 404`, `a bad account is 400`, `POST is 405`, `before the first window it is 503`.
  - `CORS and caching headers` are exactly as above; `OPTIONS` returns 204 with `Access-Control-Allow-Methods: GET`.
- [ ] **Step 2: Run** `pnpm test test/worker/api-scan.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `api.ts` and the route; port `decode`'s rules into `scan-state-rules.ts` (from `git show web-hardening:web/src/lib/cascade/scan-store.ts`).
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): the seed API in seedScan's shape, cached, CORS for the site`.

### Task 11: `GET /v1/status` and `GET /v1/health`

**Files:**
- Modify: `indexer/src/api.ts`, `indexer/src/index.ts`
- Test: `indexer/test/worker/api-status.test.ts`

**Interfaces:**
- `handleStatus(env, cfg, nowS)`: the spec's section 8 JSON (`v: 1`, `deployment`, `hold: { active, reasons }` from uncleared `holds`, `monitor: { lastCompleteTickAt, degraded }`, `indexer` cursors, `generatedAt`), `Cache-Control: no-store`.
- `handleHealth(env, nowS)`: `200 ok` while `meta.last_complete_tick` is under 300 s old, else `503`.

- [ ] **Step 1: Write the failing tests:** no hold → `active: false`, `reasons: []`; two uncleared holds and one cleared → two reasons; the body has no `alerts` key and no alert subjects (only hold summaries); `no-store`; health 200 at 299 s, 503 at 301 s; `no route writes`: for each route and for `POST`/`PUT`/`DELETE` on every path, the row counts of every table are unchanged afterwards.
- [ ] **Step 2: Run** `pnpm test test/worker/api-status.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both routes.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): status with the hold, and a health probe`.

## Part D — Monitor core

### Task 12: State readings

**Files:**
- Create: `indexer/src/snapshot.ts`, `indexer/src/subtensor.ts`
- Test: `indexer/test/worker/snapshot.test.ts`

**Interfaces:**
- `interface Snapshot { at: number; base: { block: bigint; time: number; frontDoor: {…}; staker: {…}; taoBalanceOfFrontDoor; ethOfFrontDoor; fmtaoSupply; pools: { taoWeth: { sqrtPriceX96; liquidity; taoHeld }, wethUsdc: { sqrtPriceX96 } }; oracleUsdcPerTao?: bigint; balances: Record<Hex, bigint> }; bittensor: { block; time; vault: {…}; stakes: Record<Hex, bigint>; hotkeyOwner?: Hex | null; lockPoolFmtao; adapterBalance; alphaVault: {…}; balances } ; messageStates: Record<Hex, string> }` with every field listed in the spec's section 6 "Readings" (each optional: a failed sub-call leaves it undefined and the rules that need it skip).
- `readSnapshot(rpc, cfg, { hotkeys, pendingMessages, watched })`: one multicall per chain (the hotkey set read first from the previous snapshot; a changed set is re-read next tick), message states on each destination OffRamp in the same multicall, `burnWindows(peerId)` with `peerId = keccak256(abi.encode(uint64 8453, frontDoor))`.
- `subtensor.ts`: `ownerStorageKey(hotkey)` (`twox128("SubtensorModule") ++ twox128("Owner") ++ blake2_128_concat(hotkey)`, with the two twox128 prefixes as constants and `@noble/hashes` blake2b, the method of `web/src/lib/cascade/apy.ts`); the read is an `eth_call` to the storage-query precompile `0x0000000000000000000000000000000000000807`; `decodeAccountId(data)` returns `null` for empty data.
- `compact(snapshot): string` and `expand(json): Snapshot` (bigints as strings) for the `readings` table.

- [ ] **Step 1: Write the failing tests:** a fake multicall answer for every read becomes a full `Snapshot`; one failed sub-call leaves only its field undefined; `compact`/`expand` round-trips; `peerId` equals the vault's formula (`keccak256(encodeAbiParameters([uint64, address], [8453n, fd]))`); `ownerStorageKey` for a fixed hotkey equals a key worked out by hand in the test from the documented hashers; empty storage data decodes to `null`.
- [ ] **Step 2: Run** `pnpm test test/worker/snapshot.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `snapshot.ts` and `subtensor.ts`. The Owner key's correctness against the live chain is checked by Task 30's smoke test.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): one Multicall3 reading of both chains per tick`.

### Task 13: Alerts and runbook lines

**Files:**
- Create: `indexer/src/alerts.ts`, `indexer/src/runbook.ts`, `indexer/src/rules/ids.ts`
- Test: `indexer/test/worker/alerts.test.ts`

**Interfaces:**
- `rules/ids.ts`: `RULES` — every rule id in the spec's section 6 tables with its tier (`"critical" | "warning"`), its kind (`"condition" | "event"`, spec section 6 conventions) and whether it can hold.
- `runbook.ts`: `RUNBOOK: Record<RuleId, (facts: Record<string, string>) => string>` (the spec's "What to do" lines, values filled from facts, e.g. the cancel deadline).
- `interface Finding { rule: RuleId; key: string; subject: string; facts: Record<string, string>; hold?: { id: string; summary: string } }`.
- `reconcile({ open: AlertRow[], findings: Finding[], nowS, thresholds }): { statements; notify: AlertRow[]; resolved: AlertRow[] }`: a new key opens an alert; a persisting key updates `last_seen_at` only; a *condition* alert whose key isn't found this tick resolves (a critical one produces a "resolved" notification); an *event* alert never resolves by absence: it stays open until acknowledged and closes quietly 7 days after opening; criticals are due when never notified, or `notified_at + criticalResendS ≤ now` while unacknowledged and `notify_count < criticalMaxSends`; warnings are due as one group when the last warning email is at least `warningEveryS` old.

- [ ] **Step 1: Write the failing tests:** `every rule has a runbook line` (iterate `RULES`); a new critical is due at once; the same finding next tick is not due and not duplicated; at 3,600 s it is due again; after 6 sends it isn't; an acknowledged critical isn't re-sent; a cleared *condition* critical resolves and is in `resolved`; an *event* critical missing from the next tick's findings stays open with no "resolved" email, and closes quietly after 7 days; two new warnings 10 minutes apart go out together at the next 30-minute mark; a rule that can't hold never returns a hold (type-level and runtime check).
- [ ] **Step 2: Run** `pnpm test test/worker/alerts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): alert lifecycle, resend policy and a runbook line for every rule`.

### Task 14: The rule framework

**Files:**
- Create: `indexer/src/rules/index.ts`, `indexer/src/rules/context.ts`
- Test: `indexer/test/worker/rules-framework.test.ts`

**Interfaces:**
- `interface RuleCtx { cfg: Config; nowS: number; snap: Snapshot; history: Snapshot[] /* newest first, up to 24 h at hourly granularity plus the last 60 ticks */; settled: { base: { block: bigint; time: number }; bittensor: { block: bigint; time: number } }; logs: LogQuery /* in memory: by event, range, tx */; t: Thresholds }`. Rules never query D1 themselves (the free plan allows 50 D1 queries per invocation): `prefetch(db, state): Promise<LogQuery>` loads, in one `db.batch()`, this tick's new logs, the open batch's front door logs, the logs of deliveries and chunks not yet checked (with their transactions' other logs and the batch's front door history), the last 24 hours of request events, and the `txs`, `messages`, `batch_checks` and `chunk_checks` rows the rules read.
- `interface Rule { id: RuleId; run(ctx: RuleCtx): Promise<Finding[]> }`; `runRules(rules, ctx): Promise<{ findings: Finding[]; failures: { rule; error }[] }>` (each rule in try/catch; a failure becomes a `monitor.rule_failed` warning finding keyed by rule id); `twice(ctx, key, condition)` (true only when the condition held in the previous reading too); `afterSettled(ctx, otherChain, time)`.

- [ ] **Step 1: Write the failing tests:** a throwing rule doesn't stop the next one and becomes one `monitor.rule_failed` finding; `twice` is false on the first true reading and true on the second; `afterSettled` is false until the other chain's settled time passes the event's time; `prefetch` is one D1 query (a counting wrapper around `env.DB`) and returns a delivery's same-transaction logs and its batch's front door history.
- [ ] **Step 2: Run** `pnpm test test/worker/rules-framework.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the framework (add `monitor.rule_failed` to `RULES` and `RUNBOOK`).
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): rule framework with failure isolation and debouncing`.

## Part E — The rules

Each rule task: write the failing tests in `indexer/test/worker/rules-<group>.test.ts` against a `RuleCtx` built from fixtures, run them (FAIL), implement in `indexer/src/rules/<group>.ts` and register the rules, run `pnpm test && pnpm typecheck` (PASS), commit. The tests below are the minimum.

### Task 15: Share price and stake

**Rules:** `price.drop`, `stake.unexplained_drop`, `stake.hotkey_changed` (spec 6.1).

- [ ] **Step 1: Failing tests:** price equal or higher → nothing; lower by 1e-10 of it → nothing (rounding); lower by 1e-8 → `price.drop` with no hold; 11 bps below the 24-hour high → with hold id `price.drop:{bittensor block}`; after a hold on this drop was cleared (`holds.cleared_at` set) the 24-hour high resets to the current price and the same drop doesn't hold again; stake on a set hotkey down 2,000 rao with a vault `Unstaked` in the block range → nothing; without → `stake.unexplained_drop` with hold; not evaluated until Bittensor settled past the later reading; a changed `stakeHotkey` → `stake.hotkey_changed`; the hotkey's owner `null` on two readings → hold, on one reading → nothing.
- [ ] **Steps 2–5** as above. Commit `feat(indexer): share price and stake rules, with the hold on a sharp drop`.

### Task 16: Admin events and watched keys

**Rules:** `admin.event`, `keys.unexplained_tx`.

- [ ] **Step 1: Failing tests:** a `LimitSet` at a block after the baseline → one finding naming the event, its args and the sender from `txs`; the same event in the baseline block → nothing; `Paused` on the front door → finding; a watched address whose nonce rose by 2 with 2 transactions in `txs` → nothing; rose by 3 → finding only after `unexplainedTxGraceS` (900 s); a transaction recorded through `senderFromArgs` (the address's own `Claimed`) counts as seen; a new watched address (owner changed) starts at its current nonce as baseline (no finding); the finding's facts include the explorer link `https://basescan.org/address/{a}` or `https://evm.taostats.io/address/{a}`.
- [ ] **Steps 2–5.** Commit `feat(indexer): admin-event and unexplained-transaction rules`.

### Task 17: Solvency and vault events

**Rules:** `frontdoor.solvency`, `vault.solvency`, `deposits.bounced`, `vault.events` (warning).

- [ ] **Step 1: Failing tests:** front door TAO equal to `totalDeposits + totalClaimable` → nothing; one wei less on two readings → finding with hold, on one reading → nothing; ETH below `feePot + totalFeeCredit` twice → finding; vault `rootStake × 1e9 + balance` below `pendingPayouts + 1e12` twice → finding with hold; one `DepositBounced` → `deposits.bounced` naming the user and amount; `RedeemDeferred`, `PayoutDust`, `DepositSkipped` and an `unknown` log → `vault.events` warnings.
- [ ] **Steps 2–5.** Commit `feat(indexer): front door and vault solvency rules, bounced deposits`.

### Task 18: Rebuilding a batch's message (pure)

**Files:** Create `indexer/src/crosscheck/replay.ts`; test `indexer/test/worker/replay.test.ts`.

**Interfaces:**
- `replayBatch(frontDoorLogs: StoredLog[] /* log order */, batchId: bigint): { deposits: Entry[]; redeems: Entry[] } | { error: string }` following `CascadeFrontDoor.sol`: `DepositRequested(id, user, amount)` adds to the user's slot or appends; `DepositCancelled(id, user, amount)` reduces, and a full cancel moves the last entry into the freed slot (`_reduce`); the same for redeems; a `BatchClosed` inside a `requestRedeem` transaction ends batch `id` before that transaction's `RedeemRequested(id + 1, …)`; a cancel for an entry that isn't there → `{ error }`.
- `encodeBatchMessage(batchId, deposits, redeems): Hex` (`abi.encode(uint8 1, uint64, Entry[], Entry[])`) and `batchKey(sourceChain, frontDoor, message): Hex` (`keccak256(abi.encode(uint64, address, keccak256(message)))`).

- [ ] **Step 1: Failing tests:** two deposits by one user merge into one entry; a partial cancel reduces; a full cancel of entry 0 of three moves entry 2 into slot 0 (order `[c, b]`); redeems behave alike; a self-close on a full redeem list ends the batch before the request that caused it; a cancel of a missing entry is an error; `encodeBatchMessage` equals viem's `encodeAbiParameters` of the same tuple; **real bytes:** `batchKey` of the replayed lists from `test/fixtures/v3-test-batch.json` (Task 30 records it; until then this test is `it.todo`) equals that batch's `BatchDelivered.key`.
- [ ] **Steps 2–5.** Commit `feat(indexer): rebuild a closed batch's message and key from the front door's events`.

### Task 19: The batch cross-check

**Files:** Create `indexer/src/crosscheck/batches.ts`, `indexer/src/rules/bridge.ts`; test `indexer/test/worker/rules-bridge-batches.test.ts`.

**Rules:** `bridge.batch_mismatch`, `bridge.duplicate` (batch side), `ccip.unexpected_source` (vault side). Results are stored in `batch_checks`, so each batch is checked once (`status`: `ok`, `mismatch`, `waiting`).

- [ ] **Step 1: Failing tests** (fixtures: an honest batch's Base logs and Bittensor logs, then each altered):
  - `an honest batch passes` and its `batch_checks` row is `ok`.
  - `waits for Base`: Base settled time before the delivery's time → `waiting`, no finding.
  - `an amount that differs from totalDeposits`, `one more redeem outcome than nRedeems`, `a message id the Base adapter never sent`, `a key that isn't the replayed batch's` (the outcomes and ids unchanged), `a deposit outcome naming another user`, `a burned redeem above its request`: each → `bridge.batch_mismatch` with the failing step in the facts and hold id `bridge.batch:{id}`.
  - `can't rebuild` (a replay error) → the same rule, worded so.
  - `a second BatchDelivered for one batch id` → `bridge.duplicate` with hold.
  - `a delivery from another front door` → `ccip.unexpected_source` with hold.
  - `the email facts carry the cancel deadline`: `queuedAt + payoutDelay` of the batch's `PayoutBatchQueued`, as UTC.
- [ ] **Steps 2–5.** Commit `feat(indexer): cross-check every delivered batch against the batch the front door closed`.

### Task 20: The payout cross-check

**Files:** Create `indexer/src/crosscheck/payouts.ts`; extend `indexer/src/rules/bridge.ts`; test `indexer/test/worker/rules-bridge-payouts.test.ts`.

**Interfaces:** `payoutList(vaultLogs, key): Payout[]` (bounced then redeemed, log order; equal to `ops/src/keeper/payouts.ts` `rebuildPayouts`); `chunkEntries(list, cursor, taken, gross, fee): Entry[]` (each `floor_rao(assets − ceil(assets × fee / gross))`, zeros dropped); `encodePayoutsMessage(key, chunk, entries)`.

**Rules:** `bridge.payout_mismatch`, `bridge.duplicate` (payout side), `ccip.unexpected_source` (Base side). Results in `chunk_checks`; the next tick's multicall reads `frontDoor.delivered(bridge, keccak256(message))` for each new chunk and the check completes when it reads true.

- [ ] **Step 1: Failing tests:** an honest chunk passes (two chunks of one batch: the second's cursor is the first's `taken`); waits until Bittensor settled past the landing; `bridge` not our adapter → mismatch; `amount ≠ net` → mismatch; a `PayoutReceived` list with one user changed, or one amount off by 1 wei → mismatch; a message id the Bittensor adapter never sent → mismatch; `delivered(...)` reading false → mismatch; a second landing for one (key, chunk) → `bridge.duplicate`; a `PayoutChunkSent` with `net = 0` expects no landing; `chunkEntries` matches the vault's `_deductFee` on a worked example (gross 1e17 + 3e16, fee 1.05e15).
- [ ] **Steps 2–5.** Commit `feat(indexer): cross-check every payout landing on Base against the chunk the vault sent`.

### Task 21: Bridge messages

**Files:** Create `indexer/src/messages.ts`, `indexer/src/rules/ccip.ts`; test `indexer/test/worker/rules-ccip.test.ts`.

**Interfaces:** `messagesFrom(logs, d): MessageRow[]` (each adapter `Sent` whose sender is the front door or vault, with direction and source time); `pendingMessages(db)` feeds Task 12's OffRamp reads; states are written back each tick.

**Rules:** `ccip.failure` (critical), `ccip.undelivered` (warning, 60 min by source time), `ccip.foreign_send` (warning).

- [ ] **Step 1: Failing tests:** a `Sent` by the front door becomes a `base>bittensor` message; state `FAILURE` → `ccip.failure` with the ccip.chain.link link; `UNTOUCHED` at 59 minutes → nothing, at 61 → `ccip.undelivered`; `SUCCESS` resolves it; a `Sent` from a stranger to the vault → `ccip.foreign_send`; a stranger's `Sent` to some other recipient → nothing.
- [ ] **Steps 2–5.** Commit `feat(indexer): bridge message tracking, failures and slow deliveries`.

### Task 22: FM-TAO, prices and pools

**Files:** Create `indexer/src/prices.ts`, `indexer/src/rules/market.ts`; test `indexer/test/worker/rules-market.test.ts`.

**Interfaces:** `referencePrice({ getJson, sources }): Promise<{ usd: number } | { unavailable: string }>` (CoinGecko `simple/price?ids=bittensor&vs_currencies=usd` and Coinbase `v2/prices/TAO-USD/spot`; the median of those that answer; `unavailable` when they disagree by more than 2% or none answers); `poolPriceUsd(snap)` from both pools' `sqrtPriceX96` (token order as in `CascadeTwapOracle`); prices read every fifth minute (`minute % 5 == 0`).

**Rules:** `fmtao.unbacked`, `fmtao.depeg` (critical); `fmtao.mint_surge`, `twap.divergence`, `pool.liquidity` (warning; the 7-day median from hourly readings).

- [ ] **Step 1: Failing tests:** supply equal to the lock → nothing; supply above lock + 0.01 TAO twice → `fmtao.unbacked`; pool 4.9% from the reference → nothing; 5.1% on two 5-minute readings → `fmtao.depeg`; reference unavailable → no depeg finding; sources 3% apart → unavailable; oracle 2.1% from spot twice → `twap.divergence`; oracle reverting twice → `twap.divergence` worded "unavailable"; TAO in the pool at 49% of its 7-day median → `pool.liquidity`; supply up 600 TAO in an hour with 50 TAO of Cascade payouts landed → `fmtao.mint_surge`; `poolPriceUsd` on a fixture matches a hand-computed price within 0.01%.
- [ ] **Steps 2–5.** Commit `feat(indexer): FM-TAO backing and peg, TWAP and pool rules`.

### Task 23: Operational warnings

**Files:** Create `indexer/src/rules/ops.ts`; test `indexer/test/worker/rules-ops.test.ts`.

**Rules:** `batch.past_max_wait`, `payout.overdue`, `delivery.overdue`, `keeper.low_eth`, `keeper.low_tao`, `adapter.low_reserve`, `cap.nearly_full`, `batch.one_wallet`, `unstakes.tiny_wave`, `outflow.near_limit`, `rewards.uncollected`, `rail.alpha_vault` (critical, spec 6.4), `indexer.lag` / `indexer.blind`, `indexer.reorg`, `monitor.chain_unreadable`, `monitor.email_failing`.

- [ ] **Step 1: Failing tests,** one each side of every threshold, for example: open batch with entries at `openStart + max(interval, maxWait) + 14 min` → nothing, `+ 16 min` → warning; a pending payout batch at `queuedAt + delay + 61 min` → warning, a deleted one → nothing; keeper ETH 0.0019 → warning; `netForwarded + open` at 90% → warning; one payer (resolved through the staker's `Staked.payer` in the same transaction) with 51% of a half-full batch → warning; 20 tiny redeems in 24 h → warning, 19 → nothing; burned plus waiting at 80% of the allowance → warning (allowance = `max(gross × bps / 1e4, minDaily)`); last claim 36 days ago → warning; AlphaVault `migrationReadyAt != 0` → `rail.alpha_vault`; settled time 16 minutes behind → `indexer.lag`, 121 minutes → `indexer.blind` (critical).
- [ ] **Steps 2–5.** Commit `feat(indexer): operational warnings and the rail health rule`.

## Part F — Hold, email, digest, integrity and the tick

### Task 24: The hold, and the clear and acknowledge scripts

**Files:**
- Create: `indexer/src/hold.ts`, `indexer/scripts/hold-clear.ts`, `indexer/scripts/alerts-ack.ts`
- Modify: `indexer/package.json` (`hold:clear`, `alerts:ack` run with `node`)
- Test: `indexer/test/worker/hold.test.ts`, `indexer/test/node/scripts-hold.test.ts`

**Interfaces:**
- `holdStatements(db, findings, activeHolds, nowS)`: inserts a hold for each finding's `hold.id` not already present (cleared or not: a cleared id never re-raises); never clears.
- `scripts/hold-clear.ts --env <test|production> --note "<text>" [--id <hold id>]` and `scripts/alerts-ack.ts --env <env> <alert id>`: validate the arguments (`--note` matches `^[A-Za-z0-9 .,:;()_-]{1,200}$`, hold ids `^[a-z0-9_.:-]{1,120}$`, alert ids digits only), then print and run `pnpm wrangler d1 execute cascade-indexer-<env> --env <env> --remote --command "<SQL>"` through `execFile` (no shell). A `--dry-run` flag prints only (tests use it; nothing is run against Cloudflare while executing this plan).

- [ ] **Step 1: Failing tests:** a finding with a hold raises one row; the same finding next tick doesn't add another; a cleared hold with the same id isn't raised again; no code path in `src/` issues `UPDATE holds SET cleared_at` (grep test); `hold-clear --dry-run` prints the exact wrangler command with the note quoted; a note with a quote or backtick is refused; `alerts-ack --dry-run 12` prints the `UPDATE alerts SET acknowledged_at` command.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(indexer): the hold, raised by the monitor and cleared only by a human with account access`.

### Task 25: Email

**Files:** Create `indexer/src/email.ts`; test `indexer/test/worker/email.test.ts`.

**Interfaces:**
- `renderCritical(alert, ctx)`, `renderWarnings(alerts, ctx)`, `renderResolved(alert)`, `renderDigest(digest)` → `{ subject; text; html }` (subjects `[CASCADE CRITICAL] …`, `[Cascade warning] {n} new: …`, `[Cascade resolved] …`, `[Cascade daily] {date}: …`; body: what happened, facts with explorer links, **What to do** (the runbook line), the hold, how to acknowledge, and the footer "Act from your own tools, never from a link in this email.").
- `sendAll(env, cfg, messages): Promise<{ sent: number[]; failed: { id; code }[] }>`: through `env.EMAIL.send({ to: cfg.alerts.to, from: { email: cfg.alerts.from, name: "Cascade monitor" }, subject, text, html })`; in `log` mode, `console.log` instead; a thrown `E_*` error marks that message failed and continues.

- [ ] **Step 1: Failing tests:** a `bridge.batch_mismatch` email names the batch, the failing step, the cancel deadline and the guardian and owner steps; every rendered email has `text` and `html` and the footer; no rendered email contains `http://` or a link that isn't to basescan.org, evm.taostats.io, taostats.io, ccip.chain.link or the status URL; `log` mode never calls the binding; a binding that throws `E_RATE_LIMIT_EXCEEDED` for the first message still sends the second and reports the first failed; subjects for each tier are as above.
- [ ] **Steps 2–5.** Commit `feat(indexer): alert and digest emails with a what-to-do line, log mode for dev`.

### Task 26: The daily digest

**Files:** Create `indexer/src/digest.ts`, `indexer/src/apy.ts` (a port of `web/src/lib/cascade/apy.ts`'s `basketTwrKey`, `decodeTwr`, `netApyPercent`); test `indexer/test/worker/digest.test.ts`.

**Interfaces:** `buildDigest(ctx, db, nowS): Promise<Digest>` with the spec's section 6.5 contents (24-hour windows by chain time; fees from `Staked.fees`, `RewardCutMinted.assets`, `PayoutChunkSent.fee`, `BatchClosed.fee`; APY from two archive reads of `BasketTwr` 216,000 blocks apart).

- [ ] **Step 1: Failing tests:** a fixture day with 3 batches closed, 2 delivered, 1 paid out gives those counts; fees sum per kind with units; open warnings and criticals listed with ages; the subject says `CRITICAL open` when one is; `netApyPercent` gives the same result as the web's on the web test's fixture values.
- [ ] **Steps 2–5.** Commit `feat(indexer): the daily digest`.

### Task 27: Website integrity

**Files:** Create `indexer/src/site.ts`, `indexer/src/site-addresses.ts` (generated), `indexer/scripts/site-addresses.ts`; test `indexer/test/worker/site.test.ts`, `indexer/test/node/site-addresses.test.ts`.

**Interfaces:**
- `scripts/site-addresses.ts <web/out dir>`: reads every `.html` and `_next/static/**/*.js` file, extracts `0x[0-9a-fA-F]{40}` (lowercased, deduplicated, sorted) and writes `src/site-addresses.ts` (`export const APPROVED: readonly string[]`, with the build's date in a comment).
- `checkSite({ getText, cfg }): Promise<Finding[]>`: fetches `cfg.site.pages` under `cfg.site.url`, collects `<script src="/_next/static/…">` (at most 40) and inline scripts, extracts addresses; `site.integrity` (critical) when a configured Cascade address is missing or an unapproved address appears; a fetch failure is remembered and becomes a `site.unreachable` warning after 30 minutes.

- [ ] **Step 1: Failing tests:** a fixture site whose scripts contain exactly the approved addresses → nothing; one extra address → critical naming it and the file; the front door's address missing → critical; more than 40 scripts → only the first 40 fetched and a warning; the script on a fixture `out/` directory writes a sorted, deduplicated, lowercased list.
- [ ] **Steps 2–5.** Commit `feat(indexer): hourly check of the live site's addresses against an approved list`.

### Task 28: The tick and the handlers

**Files:** Create `indexer/src/tick.ts`, `indexer/src/hourly.ts`; modify `indexer/src/index.ts`; test `indexer/test/worker/tick.test.ts`.

**Interfaces:**
- `runTick(deps: { env; cfg; rpc; getJson; nowS; holder }): Promise<TickReport>` doing the spec's section 1 steps in order: lease (skip if held) → `loadTickState` → `scanChain` Bittensor then Base (budget reserving 5 units) → block times and transactions → `readSnapshot` → messages, cross-check rows → `runRules` → `reconcile` and `holdStatements` → render and `sendAll` (mark sent ones notified) → one `db.batch()` with every statement (logs, removed marks, cursors, seed pages, blocks, txs, reading, messages, checks, alerts, holds, `meta.last_complete_tick`, consecutive-failure counters) → release the lease. A chain whose reads fail raises its failure counter (5 → `monitor.chain_unreadable`); email failures for 30 minutes → `monitor.email_failing`.
- `scheduled(controller, env, ctx)` dispatches `* * * * *` → `runTick`, `17 * * * *` → `runHourly` (site check, liquidity medians, prune `readings` older than 35 days), `0 13 * * *` → digest; any other cron is logged and ignored. Each builds its own `Budget(45)` and its own RPC client with `globalThis.fetch`.

- [ ] **Step 1: Failing tests** (fake RPC as the global `fetch` through the RPC client's injected fetch; `worker.scheduled` with `createScheduledController`):
  - `a first tick backfills, stores, reads and evaluates`: logs stored, cursors set, a reading stored, `meta.last_complete_tick` set.
  - `an honest round trip raises nothing; a forged batch raises the critical, the hold and one email` (log mode captured).
  - `a second tick while the lease is held does nothing`.
  - `a tick that fails before its commit leaves the database unchanged` (the fake throws on the reading).
  - `an email that fails is retried next tick and the tick still commits`.
  - `a chain that can't be read for 5 ticks raises monitor.chain_unreadable`; the other chain is still scanned.
  - `the hourly cron runs the site check and prunes readings older than 35 days`; `the daily cron sends the digest`; `an unknown cron does nothing`.
  - `subrequests never exceed 45 in one invocation` (the fake counts fetches) during a long backfill.
  - `D1 queries stay at 10 or fewer per invocation` (a counting wrapper around `env.DB`; each `db.batch()` counts once), for a steady tick and for a tick with a cross-check and an email.
- [ ] **Steps 2–5.** Commit `feat(indexer): the minute tick, hourly and daily jobs, committed atomically`.

### Task 29: Config from the ops record, and the package README

**Files:** Create `indexer/scripts/config-from-record.ts`, `indexer/README.md`; test `indexer/test/node/config-from-record.test.ts`.

**Interfaces:**
- `config-from-record.ts <record.json>`: loads the ops record with the `{ $bigint }` reviver (`ops/src/record.ts`), refuses one whose `verify.ok` isn't true or that isn't a v3 plan, and prints the `DEPLOYMENT` JSON: addresses from `plan.addresses`; the Bittensor start block from `done.bitAdapter.block` (exactly what `pnpm ops web-config` writes as `NEXT_PUBLIC_CASCADE_BIT_BLOCK`), the Base start block from `done.baseAdapter.block`; baseline blocks = the highest recorded step block per chain; vault coldkey and stake hotkey from the vault step's args; `batchMaxWaitS` from the plan's cadence (0 for test).
- `README.md`: what the Worker does, local dev (spec section 10's commands), the deploy steps (spec section 11, marked "the owner does these"), the hold and acknowledge scripts, and the threshold overrides.

- [ ] **Step 1: Failing tests** on a fixture record shaped like `ops/deployments/v3-test.json` (fake addresses): the printed JSON parses with Task 2's `parseConfig`; the Bittensor start block equals `done.bitAdapter.block`; a record without `verify.ok` is refused; a v2 record is refused; a recovered Bittensor adapter without a block is refused with the same advice as the keeper's `startBlock`.
- [ ] **Steps 2–5.** Commit `feat(indexer): DEPLOYMENT config from a verified ops record; package README`.

### Task 30: Recorded fixtures and the live smoke test

**Files:** Create `indexer/scripts/record-fixtures.ts`, `indexer/test/fixtures/v3-test-batch.json`, `indexer/test/fixtures/v3-test-chunk.json`, `indexer/test/smoke/live.test.ts`; modify `indexer/package.json` (`smoke`: `INDEXER_SMOKE=1 vitest run --project smoke`), `indexer/vitest.config.ts` (a `smoke` project, excluded from `pnpm test`).

- [ ] **Step 1:** Run `node scripts/record-fixtures.ts ../ops/deployments/v3-test.json` once (read-only public RPC calls): it saves the front door's logs for one delivered batch and the vault's logs for its delivery and one paid-out chunk, with the matching adapter logs. Turn Task 18's and Task 20's `it.todo` real-bytes tests into tests; run them. Expected: PASS (if a key doesn't match, the replay is wrong: fix it before going on).
- [ ] **Step 2: Write the smoke test:** one `runTick` against the live v3 test deployment with Miniflare D1 and `ALERT_MODE=log`; asserts both cursors moved, a reading was stored, the hotkey Owner read is non-null for the stake hotkey, the seed for the test wallet passes `assertValidScanState`, and prints the digest.
- [ ] **Step 3: Run** `pnpm smoke` (network). Expected: PASS; skim the printed digest for nonsense values.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS (the smoke project is not part of `pnpm test`).
- [ ] **Step 5: Commit** `test(indexer): real-bytes fixtures from the v3 test deployment and a live smoke run`.

## Part G — The site uses the seed (after `web-hardening` merges into main)

Branch from main after the merge. Every task runs `pnpm test`, `pnpm typecheck` and `pnpm lint` in `web/`.

### Task 31: The indexer URL in the site's config

**Files:** Modify `web/src/lib/cascade/config.ts` (`Deployment.indexerUrl?`, read from `NEXT_PUBLIC_CASCADE_INDEXER_URL`: `https://` only, no trailing slash, else absent), `ops/src/webconfig.ts` (writes `NEXT_PUBLIC_CASCADE_INDEXER_URL` when `OPS_INDEXER_URL` is set and is an `https://` URL); tests in `web/src/lib/cascade/config.test.ts`, `ops/test/webconfig.test.ts`.

- [ ] **Step 1: Failing tests:** an `https://api.cascade.fi` value is kept; `http://…`, a trailing slash or junk leaves it absent; `webEnv` with `OPS_INDEXER_URL` writes the line, without it writes nothing new.
- [ ] **Steps 2–5.** Commit `feat(web,ops): optional indexer URL in the site's deployment config`.

### Task 32: Fetching the seed

**Files:** Create `web/src/lib/cascade/indexer.ts`; test `web/src/lib/cascade/indexer.test.ts`.

**Interfaces:** `fetchSeed(d: Deployment, account: Address, opts: { fetch?: typeof fetch; timeoutMs?: number /* 5000 */ }): Promise<unknown | null>` (`GET {indexerUrl}/v1/scan/{vault}/{account}`; null on no URL, timeout, network error, non-200 or invalid JSON; never throws); `indexerDistrusted(storage, d, now)` and `distrustIndexer(storage, d, now, hours = 24)` (a per-deployment key in the op log's storage, wrapped in try/catch).

- [ ] **Step 1: Failing tests:** a 200 with the committed fixture `seed-v1.json` (copied from `indexer/test/fixtures`) returns the object; a timeout, 503, invalid JSON or thrown fetch returns null; distrust lasts 24 hours and is per deployment; blocked storage never throws.
- [ ] **Steps 2–5.** Commit `feat(web): fetch the indexer's seed, never throwing, with a 24-hour distrust switch`.

### Task 33: Seeding marks everything for checking

**Files:** Modify `web/src/lib/cascade/scan-store.ts` (`seedScan(scan, seed, opts?: { verify?: boolean })`; `ScanState.seeded?: true` optional, kept by `scanState` and read by `decode`), `web/src/lib/cascade/facts.ts` (`VaultScan.seeded?`, `unconfirmed?: true` on delivered, staked and payout entries); tests in `scan-store.test.ts`.

- [ ] **Step 1: Failing tests:** with `verify`, seeded deliveries, stakes and chunks carry `unconfirmed` and the scan is `seeded`; without it, behaviour is exactly today's (existing tests unchanged); a saved state without `seeded` still loads; a saved seeded state keeps `seeded` and the `unconfirmed` marks across a save and load; the indexer fixture is accepted by `seedScan` for its vault and deploy block and refused for another.
- [ ] **Steps 2–5.** Commit `feat(web): a seed from the indexer marks every entry for confirmation`.

### Task 34: Confirming seeded entries by their receipts

**Files:** Modify `web/src/lib/cascade/facts.ts` (`depositFacts`, `withdrawalFacts`, `deliveryFacts` confirm an `unconfirmed` delivery, the first stake after it and a key's chunks through the receipts they read, with `receiptAt`'s "server has reached the block" rule); tests in `facts.test.ts`.

- [ ] **Step 1: Failing tests:** a seeded delivery whose receipt holds the vault's `BatchDelivered` (same key, batch id, source chain 8453, our front door) is used and marked confirmed; a receipt without it, from a server past its block, throws `HistoryMismatchError`, restarts the scan and distrusts the indexer; a receipt not found from a server behind its block leaves the entry unconfirmed and shows no delivery yet (never a guess); a seeded stake and seeded chunks are confirmed the same way before their times or the payout's chunk are shown; confirmed entries aren't re-fetched.
- [ ] **Steps 2–5.** Commit `feat(web): every seeded delivery, stake and payout chunk is confirmed by its receipt before use`.

### Task 35: The share-conservation check

**Files:** Modify `web/src/lib/cascade/facts.ts` (`confirmAccountEvents` keeps each event's `shares` from its receipt), `web/src/lib/cascade/live.ts` (after a seeded scan reaches the head: `Σ Deposited.shares − Σ Redeemed.shares` must equal `balanceOf(account)` at block `scan.next − 1`, read with `blockNumber`); tests in `live.test.ts`.

- [ ] **Step 1: Failing tests:** a seeded scan whose shares add up shows "rewards earned"; one with a `Deposited` left out fails the check, distrusts the indexer, restarts from the deploy block without the seed and shows the figure only after its own scan finishes; an unseeded scan is never checked (today's behaviour, including a direct depositor's); a failed `balanceOf` read leaves the figure hidden for this read, not wrong.
- [ ] **Steps 2–5.** Commit `feat(web): a seeded history must account for the account's whole share balance`.

### Task 36: Catching an omitted delivery

**Files:** Modify `web/src/lib/cascade/live.ts` (for a record whose batch closed more than 2 hours before the seeded scan's `next` with no delivery in the scan: read the Bittensor windows from the close time to `next` directly; a delivery found there means the seed lied); tests in `live.test.ts`.

- [ ] **Step 1: Failing tests:** an op-log deposit whose batch closed 3 hours before `next` and whose delivery the seed left out is found by the direct read, and the seed is discarded and distrusted; one closed 1 hour before isn't checked; the direct read is bounded to the windows between the close time and `next`.
- [ ] **Steps 2–5.** Commit `feat(web): a delivery the seed left out is looked for directly`.

### Task 37: Wiring the seed into `scanFor`

**Files:** Modify `web/src/lib/cascade/live.ts` (`LiveDeps.fetchSeed`; in `scanFor`, after `known(account)`: when `d.indexerUrl` is set, the indexer isn't distrusted, and the head is more than 14,400 blocks past `scan.next`, `seedScan(scan, await fetchSeed(...), { verify: true })` before scanning on); tests in `live.test.ts`.

- [ ] **Step 1: Failing tests:** with the fixture seed, a first visit needs only the windows after the seed's `next` (count `getLogs` calls) and the account's events are confirmed before amounts show; the indexer down (null) → today's full scan, no error shown; a distrusted indexer isn't asked; a scan within 2 days of the head doesn't ask; a seed behind the saved scan changes nothing; no indexer URL → no fetch at all.
- [ ] **Steps 2–5.** Commit `feat(web): a first visit starts from the indexer's seed, verified, and falls back to its own scan`.

## Part H — The keeper reads the hold (later)

### Task 38: Reading the hold

**Files:** Create `ops/src/keeper/hold.ts`; test `ops/test/keeper-hold.test.ts`.

**Interfaces:** `readHold({ url?: string; file: string /* ops/hold.json */; rec: DeploymentRecord; fetch; nowMs; staleS = 900 }): Promise<{ hold: false } | { hold: true; reason: string }>`: no URL and no file → `{ hold: false }`; the file with `hold: true` → held with its reason; otherwise `GET url` with a 10-second timeout and hold when it can't be read or parsed, `v` isn't 1, `deployment.frontDoor`/`vault` aren't the record's, `monitor.lastCompleteTickAt` is older than `staleS`, or `hold.active` is true (reason: the first `reasons[].summary`).

- [ ] **Step 1: Failing tests:** each of those cases; the URL never appears in a reason (redacted host only); a file that isn't valid JSON holds ("the hold file can't be read").
- [ ] **Steps 2–5.** Commit `feat(ops): read the monitor's hold, failing closed`.

### Task 39: The keeper respects the hold

**Files:** Modify `ops/src/keeper/actions.ts` (`close` with `nRedeems > 0` and `payouts` refuse while held; `runLoop` reads the hold once a round and skips those actions with one log line per change of reason), `ops/src/cli.ts` (`OPS_HOLD_URL`; `--ignore-hold` for `run`, logging a warning every round), `ops/src/keeper/status.ts` (status prints the hold); tests in `ops/test/keeper-actions.test.ts`, `ops/test/cli.test.ts`.

- [ ] **Step 1: Failing tests:** held → a batch with a redeem isn't closed and no payout is sent, while a deposit-only close and `stakeIdle` still go ahead; the reason is logged once until it changes; `--ignore-hold` sends them and warns each round; no `OPS_HOLD_URL` and no file → today's behaviour exactly (existing tests unchanged).
- [ ] **Steps 2–5.** Commit `feat(ops): the keeper holds redeem closes and payouts while the monitor says so`.
