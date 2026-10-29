# Cascade history indexer and monitor — design

Date: 2026-10-28. Status: design, not built. Builds on the v3 contracts (`contracts/src`, tags `v3.0`/`v3.1`),
the keeper's incremental log scan (`ops/src/keeper/state.ts`) and the site's resumable vault scan on branch
`web-hardening` (`web/src/lib/cascade/facts.ts`, `live.ts`, `scan-store.ts`).

## Intent

Two small backend pieces, in one Cloudflare Worker with one D1 database:

1. **A history indexer.** Today every browser reads the vault's whole event history from the deploy block in
   1,000-block windows: about 3 seconds per day of deployment age, so about 18 minutes for a first visit a year
   after launch. `web-hardening` makes the scan resumable in the browser and adds `seedScan(scan, seed)`, which
   carries a scan forward from a published starting point. The indexer publishes that starting point. It is an
   accelerator only: the site checks what it uses against chain receipts and works without it.
2. **A monitor.** It watches both chains and the bridge between them every minute, emails the owner when
   something is wrong, and sends a daily summary. Its most important job is the bridge cross-check: every batch
   that arrives on Bittensor must be one the front door really closed on Base, and every payout that arrives on
   Base must be one the vault really sent. In April 2026 a bridge integration elsewhere lost funds to a forged
   cross-chain message that its verifier accepted; a second forged message was stopped only because people
   noticed in time. The cross-check exists so that we notice.

## Goals

- A first visit loads the account's history in seconds, whatever the deployment's age, with amounts still taken
  only from chain receipts.
- The site behaves exactly as today when the indexer is down, slow, wrong or absent.
- Every rule in the owner's agreed list is a precise, testable condition with a data source, a threshold and a
  one-line "what to do".
- A forged or altered bridge message is reported within minutes, with the exact steps and the deadline for
  undoing it (the vault's 24-hour payout delay).
- On a sharp share-price drop or a cross-check mismatch, the keeper stops closing redeem batches and sending
  payouts until a human looks.
- Everything runs and is tested locally with wrangler and Miniflare; nothing is created or deployed by the build.

## Non-goals

- Balances, quotes, limits or anything a user signs: those stay direct chain reads in the site.
- Any keeper decision other than the hold. The keeper stays chain-only.
- Pausing, cancelling or any other transaction. The Worker holds no keys and never sends a transaction.
- A public alert feed, a dashboard, SMS or push notifications (email only for now).
- v2 deployments (being wound down). The indexer and monitor target v3 deployments.

## Anti-goals (a failure even if it works)

- A figure on the site that came from the indexer without a chain receipt behind it.
- A forged batch or payout that passes the cross-check, or an honest one that fails it because the other chain
  hasn't been read yet.
- An alert nobody can act on: every alert says what happened, where to look, and what to do.
- A way to set or clear the hold, or to write anything, over HTTP.
- Alert fatigue: a rule that pages the owner at night for something that needs no action.

## Facts (verified 2026-10-28 unless marked)

### The contracts' events, as the rules use them

- **Front door (Base)** `CascadeFrontDoor.sol`: `DepositRequested(uint64 indexed batchId, address indexed user,
  uint256 amount, address payer)`, `DepositCancelled(batchId, user, amount)`, `RedeemRequested(batchId, user,
  shares)`, `RedeemCancelled(batchId, user, shares)`, `BatchClosed(uint64 indexed id, uint256 totalDeposits,
  uint256 nDeposits, uint256 nRedeems, uint256 fee, uint256 potUsed)`, `BatchRolled(id)`,
  `PayoutsDelivered(bytes32 indexed batchKey, uint32 chunk, uint256 amount, address bridge)`,
  `PayoutReceived(bytes32 indexed batchKey, uint32 chunk, address indexed user, uint256 amount)`, `Claimed`,
  `DeliverySet`, `Delivered(user, taoIn, usdcOut)`, `FeeCredited`, `FeeCreditSpent`; admin: `LimitSet`,
  `KeeperSet`, `SwapperSet`, `OracleSet`, `MaxDeliverySlippageSet`.
- **Vault (Bittensor)** `CascadeVault.sol`: `BatchDelivered(bytes32 indexed key, uint64 indexed sourceChain,
  address indexed frontDoor, uint64 batchId, uint256 amount)`, per deposit entry one of `Deposited(key, user,
  assets, shares)` / `DepositBounced(key, user, assets)` / `DepositSkipped(key, user, assets)`, per redeem entry
  one of `Redeemed(key, user, shares, assets)` / `RedeemDeferred(key, user, requested)` / `RedeemSkipped(key,
  user, requested)`, `PayoutBatchQueued(key, sourceChain, batchId, count, total, price)`,
  `PayoutChunkSent(bytes32 indexed key, uint32 chunk, uint32 taken, uint256 gross, uint256 net, uint256 fee)`,
  `PayoutDust`, `Staked`, `Unstaked`, `StakeMoved`, `RewardsClaimed`, `RewardCutMinted`; admin:
  `StakeHotkeySet`, `HotkeyAdded`, `HotkeyRemoved`, `RewardCutSet`, `FrontDoorProposed/Activated/
  ProposalCancelled/Removed`, `KeeperSet`, `ClaimGasSet`, `LimitSet`, `PayoutBatchCancelled`, `RedeemReversed`.
- **Both** (`CascadeBase.sol` and OpenZeppelin): `GuardianSet`, `GuardianProposed`, `GuardianProposalCancelled`,
  `BridgeProposed`, `BridgeActivated`, `BridgeProposalCancelled`, `BridgeDisabled`, `PrimaryBridgeSet`,
  `Paused(account)`, `Unpaused(account)`, `OwnershipTransferStarted`, `OwnershipTransferred`.
- **Staker (Base)** `CascadeStaker.sol`: `Staked(address indexed payer, address indexed beneficiary, uint256
  usdcIn, uint256 fees, uint256 taoDeposited)`, `Sold`; admin: `RouteSet`, `DeliveryRouteSet`, `FeesSet`,
  `TreasurySet`, `Swept`, ownership events.
- **Adapters (both chains)** `CcipAdapterBase.sol`: `Sent(bytes32 indexed messageId, uint64 destChain, address
  indexed sender, address indexed recipient, uint256 amount, uint256 fee, uint256 gasLimit)` and
  `Delivered(bytes32 indexed messageId, uint64 sourceChain, address indexed sender, address indexed recipient,
  uint256 amount)`. The adapters are immutable and ownerless. `send` is open to anyone; the payload carries the
  real caller as `sender`, and a destination adapter accepts only messages from its paired remote adapter.
  `Delivered` is emitted only after the receiving contract accepted the message.
- **What ties the two sides of a batch together.** The front door builds the message as
  `abi.encode(uint8 1, uint64 batchId, Entry[] deposits, Entry[] redeems)` (`CascadeMessages.encodeBatch`) from
  the open batch's lists, one merged entry per user per list, in slot order (a full cancel moves the last entry
  into the freed slot). The vault names the delivery `key = keccak256(abi.encode(uint64 sourceChain, address
  sender, keccak256(message)))` (`CascadeVault.batchKey`), so the key commits to every byte of the message.
  `BatchClosed` carries the id, the TAO total and the two list lengths; the Base adapter's `Sent` in the same
  transaction carries the CCIP message id; the Bittensor adapter's `Delivered` in the delivery transaction
  carries the same id.
- **What ties the two sides of a payout together.** The vault's payout list for a batch is its
  `DepositBounced` entries (0 shares) then its `Redeemed` entries, each in log order (`ops/src/keeper/payouts.ts`
  `rebuildPayouts`). Chunk `c` takes the next `taken` entries; each entry pays `ceil(assets × fee / gross)` and
  is floored to whole rao; an entry left with 0 is dropped (`PayoutDust`). The message is
  `abi.encode(uint8 2, bytes32 key, uint32 chunk, Entry[] entries)`; the front door records
  `delivered[bridge][keccak256(message)]` (a public view) and emits `PayoutsDelivered` and one `PayoutReceived`
  per entry. A chunk whose `net` is 0 sends no message.
- **Accounting identities the contracts state.** Front door: the TAO it holds is at least the open batch's
  `totalDeposits` plus `totalClaimable`; the ETH it holds equals the open batch's `feePot` plus
  `totalFeeCredit` (contract header comment). Vault: `totalAssets = rootStake + balance − 1e12 −
  pendingPayouts − unvestedRewards`, floored; the share price is `price()`.

### The site's scan (branch `web-hardening`)

- `VaultScan` (`facts.ts`) holds the vault's `BatchDelivered` from our front door with `sourceChain == 8453`
  (by batch id), every `Staked`, every `PayoutChunkSent` (by key and chunk), and the connected account's own
  `Deposited` and `Redeemed`. It reads one vault-address `eth_getLogs` per 1,000-block window, asking the head in
  the same request and accepting a window only from a server that has reached its end; it re-reads 400 blocks
  (REREAD) and never saves the last 10 (SETTLE).
- `ScanState` v1 (`scan-store.ts`) is the saved and seedable form: `{ v: 1, vault (lowercase), from (deploy
  block), next, delivered[{batchId, key, txHash, block}], staked[{block, txHash}], payouts[{key, chunk, taken,
  txHash, block}], deposited[{key, txHash, block, assets}], redeemed[...] }`, numbers as decimal strings. A state
  for another vault or deploy block, a malformed field or an event outside `[from, next)` is dropped whole.
  `seedScan` adds only events at or after the browser's own `next`, marks the account's events `unconfirmed`
  (their amounts wait for receipts: `confirmAccountEvents`), and moves `next` forward.

### The keeper's scan (`ops/src/keeper/state.ts` on main)

Windows Base 100 / Bittensor 1,000 blocks; REREAD Base 70 / Bittensor 400; SETTLE Base 30 / Bittensor 10.
A log's identity is `txHash:topics:data#n` (n counts identical logs within one transaction), so a copy re-mined in
another block or at another index after a reorg is the same log. Logs within SETTLE of the head are returned but
not kept. Every Bittensor scan starts at the record's Bittensor adapter block.

### RPCs (probed 2026-10-28 from the owner's network)

- `https://mainnet.base.org` answers batched JSON-RPC (`eth_blockNumber`, `eth_chainId` in one request) but
  answered `eth_getLogs` with `-32011 request limit reached`, even for a 10-block window (the web-wiring builder
  check saw the same). `https://base-rpc.publicnode.com` answered a batched `[eth_getLogs (100 blocks),
  eth_blockNumber]`; the site already reads Base logs there in windows up to 2,000 blocks. The owner's working
  numbers for Base: 100-block windows, about 200 requests a minute.
- `https://archive.chain.opentensor.ai` answers batched JSON-RPC and 1,000-block log windows (about 128 requests
  a minute, web-wiring spec); the lite node keeps only minutes of logs.
- Cloudflare's egress addresses are shared, so a public RPC's per-address limits may bite harder from a Worker
  than from a home connection (unverified). Every RPC URL is configurable, and a keyed one can be a secret.

### Cloudflare (docs read 2026-10-28)

- Workers Free: 100,000 requests a day **per account** (Workers and Pages Functions together; static Pages
  assets are free), 10 ms CPU per invocation (HTTP and cron alike), 50 external subrequests per invocation
  (1,000 to Cloudflare services), 5 cron triggers per account, cron wall time up to 15 minutes. Workers Paid
  ($5/month): no daily request limit, 30 s CPU per cron invocation (under 1-hour interval), 10,000 subrequests.
- D1 Free: 5 M rows read and 100 k rows written a day (enforced since 2026-09-01: queries fail until midnight UTC),
  500 MB per database, 5 GB per account, **50 queries per Worker invocation**, where one `db.batch()` counts as
  one query and runs as a transaction. Paid: 10 GB per database, 1,000 queries per invocation.
- Email Service: sending to **verified destination addresses** in the account is free on every plan and doesn't
  count toward quotas, from a domain with Email Routing enabled ("you can only send from your routing domains").
  Sending to arbitrary recipients needs Workers Paid and an onboarded sending domain. Workers binding:
  `send_email: [{ name, allowed_sender_addresses? }]`, `env.EMAIL.send({ to, from: { email, name }, subject,
  text, html })`, errors thrown as `E_*` codes.
- Cron: `triggers.crons` in `wrangler.jsonc`, `scheduled(controller, env, ctx)` with `controller.cron`.
  `wrangler dev --test-scheduled` exposes `/cdn-cgi/local/scheduled?cron=…`; Local Explorer (wrangler ≥ 4.139)
  can fire configured crons.
- Testing: `@cloudflare/vitest-plugin` (renamed from `@cloudflare/vitest-pool-workers` in 2026-08), `cloudflareTest()`
  plugin, `readD1Migrations` / `applyD1Migrations`, `createScheduledController`, `createExecutionContext`.
  Version 1.4.2 pins wrangler 4.151.0 and supports vitest ^5. `fetchMock` is gone; tests mock `globalThis.fetch`
  or inject their own fetch.
- Workers Cache (`"cache": { "enabled": true }`) serves responses by `Cache-Control` without running the Worker;
  hits are still billed as requests; the key is the path, not the host; `Vary` is honoured.

## Decided with the owner

- Cloudflare: one Worker with a cron trigger and a D1 database for both pieces; the site moves to Cloudflare Pages.
- The indexer stores display history only; the site checks entries against chain receipts before showing
  amounts and falls back to its own scan plus browser memory; balances and anything signed never come from it;
  the keeper stays chain-only; the API serves `seedScan`'s shape; it is public, read-only, with CORS for the
  site's origin and caching.
- Alerts by email: critical (immediate, distinct subject), warning (immediate or batched), daily digest.
- The rule list (critical, warning, digest, website integrity) and "every alert carries a what-to-do line".
- One automatic reaction: a hold flag on a sharp share-price drop or a cross-check mismatch, read by the keeper.
  No automatic pause.

## The design (my calls are marked *call*)

### 1. Architecture

```
 site (browser) ── GET /v1/scan/{vault}/{account} ──┐
 keeper, people ── GET /v1/status, /v1/health ──────┤
                                                    ▼
                  ┌──────────── Worker cascade-indexer ────────────┐
                  │ fetch():      three read-only routes           │
                  │ scheduled():  * * * * *    tick                │───▶ D1: logs, cursors, readings,
                  │               17 * * * *   hourly              │         checks, alerts, holds
                  │               0 13 * * *   daily digest        │
                  └───────┬────────────────┬────────────────┬──────┘
                          ▼                ▼                ▼
          Base and Bittensor RPCs    price APIs and     send_email ──▶ owner's inbox
          (logs, Multicall3)         cascade.fi's JS
```

- **One Worker, `cascade-indexer`**, two handlers. `fetch` serves three read-only routes and nothing else
  (section 4). `scheduled` dispatches on `controller.cron`. *call*: three cron expressions (three of the free
  plan's five per account): the **tick** every minute (scan both chains, read state, run the rules, raise the
  hold, send criticals and batched warnings), an **hourly** job at minute 17 (website integrity,
  pool-liquidity medians, pruning), and the **daily digest** at 13:00 UTC. Each runs in its own invocation, so
  each has its own subrequest and CPU budget.
- **One D1 database** per deployment environment (`test` for the v3 test deployment, `production` later),
  holding logs, cursors, readings, cross-check results, alerts, holds and the seed pages (section 2).
- **No keys.** The Worker reads public chain data, writes only its own D1, and sends email to verified
  addresses. It never builds or sends a transaction (a test fails if `eth_sendRawTransaction` or
  `eth_sendTransaction` appears in `src/`).
- **A tick** (*call*), in order, each step bounded by a per-invocation subrequest budget (section 3.6):
  1. take the lease (one D1 row) so two ticks never overlap; skip if another tick holds it;
  2. load cursors, open alerts, holds and the previous readings in one `db.batch()`;
  3. scan Bittensor, then Base, forward from their cursors (section 3);
  4. fetch block times and the transactions behind attributable events found this tick;
  5. read both chains' state in one Multicall3 `aggregate3` per chain plus one batched nonce request per chain;
  6. run the rules on the stored logs, the readings and the previous readings (section 6);
  7. update alerts and holds, render and send due emails (section 7);
  8. commit everything (logs, cursors, seed pages, readings, alerts, holds, heartbeat) in one `db.batch()`, which
     D1 runs as one transaction, so a tick that dies part-way leaves the database as it was before it (at worst
     an email sent in step 7 is sent again by the next tick).
  A failing rule or read is caught and recorded; it never stops the other rules. A chain whose reads fail for 5
  ticks in a row raises the `monitor.chain_unreadable` warning.

### 2. The D1 schema

Migration `indexer/migrations/0001_init.sql` (*call*: addresses and hashes lowercase hex; amounts as decimal
text; times as unix seconds):

```sql
-- key/value facts about this database: schema version, deployment id, last tick times
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- one row per chain: how far the scan has read and what is stored
CREATE TABLE cursors (
  chain        TEXT PRIMARY KEY CHECK (chain IN ('base','bittensor')),
  from_block   INTEGER NOT NULL,   -- the deployment's first block on this chain
  scanned_to   INTEGER,            -- the last head fully read (null before the first window)
  settled_to   INTEGER NOT NULL,   -- every log in [from_block, settled_to] is stored (from_block − 1 at first)
  settled_time INTEGER,            -- block time of settled_to
  updated_at   INTEGER NOT NULL
);

-- every log of the watched contracts, stored once it is SETTLE blocks deep
CREATE TABLE logs (
  uid       TEXT PRIMARY KEY,      -- keccak256(chain ':' txHash ':' topics ':' data '#' n): the keeper's identity
  chain     TEXT NOT NULL,
  block     INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  tx_hash   TEXT NOT NULL,
  address   TEXT NOT NULL,
  event     TEXT NOT NULL,         -- decoded name ('BatchDelivered'), or 'unknown'
  topic1    TEXT, topic2 TEXT, topic3 TEXT,
  data      TEXT NOT NULL,
  args      TEXT NOT NULL,         -- decoded arguments as JSON, integers as decimal strings
  removed   INTEGER NOT NULL DEFAULT 0  -- 1 when a later read of its block no longer had it (reorg)
);
CREATE INDEX logs_by_event ON logs(chain, event, block);
CREATE INDEX logs_by_topic2 ON logs(event, topic2);   -- Deposited/Redeemed/PayoutReceived by user
CREATE INDEX logs_by_tx ON logs(chain, tx_hash);

CREATE TABLE blocks (chain TEXT NOT NULL, number INTEGER NOT NULL, time INTEGER NOT NULL,
                     PRIMARY KEY (chain, number));     -- times of blocks that hold stored logs

CREATE TABLE txs (                                      -- senders of attributable transactions
  chain TEXT NOT NULL, hash TEXT NOT NULL, from_addr TEXT NOT NULL, to_addr TEXT,
  selector TEXT, nonce INTEGER, PRIMARY KEY (chain, hash));  -- to/selector/nonce null when known from args
CREATE INDEX txs_by_from ON txs(chain, from_addr, nonce);

-- the deployment-wide part of the seed, pre-built: pages of up to 500 events in block order
CREATE TABLE seed_pages (page INTEGER PRIMARY KEY, first_block INTEGER NOT NULL,
                         last_block INTEGER NOT NULL, count INTEGER NOT NULL, json TEXT NOT NULL);

-- one compact reading of both chains' state per tick (pruned after 35 days)
CREATE TABLE readings (at INTEGER PRIMARY KEY, base_block INTEGER, bit_block INTEGER, json TEXT NOT NULL);

-- bridge messages our contracts sent, and what became of them
CREATE TABLE messages (
  message_id TEXT PRIMARY KEY, direction TEXT NOT NULL,  -- 'base>bittensor' | 'bittensor>base'
  sender TEXT NOT NULL, recipient TEXT NOT NULL, amount TEXT NOT NULL,
  src_tx TEXT NOT NULL, src_block INTEGER NOT NULL, src_time INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'UNTOUCHED', state_at INTEGER,
  dst_tx TEXT, dst_block INTEGER);

-- the cross-check, one row per batch and per payout chunk
CREATE TABLE batch_checks (batch_id INTEGER PRIMARY KEY, closed_tx TEXT, message_id TEXT,
  expected_key TEXT, delivered_key TEXT, delivered_tx TEXT, status TEXT NOT NULL, detail TEXT);
CREATE TABLE chunk_checks (batch_key TEXT NOT NULL, chunk INTEGER NOT NULL, sent_tx TEXT, message_id TEXT,
  expected_hash TEXT, delivered_tx TEXT, status TEXT NOT NULL, detail TEXT, PRIMARY KEY (batch_key, chunk));

-- watched addresses' nonces: the rule compares them with the transactions seen in Cascade's logs
CREATE TABLE nonces (chain TEXT NOT NULL, address TEXT NOT NULL, baseline INTEGER NOT NULL,
  nonce INTEGER NOT NULL, changed_at INTEGER NOT NULL, PRIMARY KEY (chain, address));

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY, alert_key TEXT NOT NULL, rule TEXT NOT NULL, tier TEXT NOT NULL,
  subject TEXT NOT NULL, body TEXT NOT NULL, runbook TEXT NOT NULL,
  opened_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, resolved_at INTEGER,
  notified_at INTEGER, notify_count INTEGER NOT NULL DEFAULT 0, acknowledged_at INTEGER);
CREATE UNIQUE INDEX alerts_open ON alerts(alert_key) WHERE resolved_at IS NULL;

CREATE TABLE holds (id TEXT PRIMARY KEY, rule TEXT NOT NULL, summary TEXT NOT NULL,
  raised_at INTEGER NOT NULL, cleared_at INTEGER, cleared_note TEXT);

CREATE TABLE lease (name TEXT PRIMARY KEY, holder TEXT NOT NULL, until INTEGER NOT NULL);
```

Size: a stored log is under 1 KB; at 100 stakes a day (about 5 logs each) that is about 150 MB a year, inside the
free 500 MB per database for well over a year; `readings` is pruned to 35 days (about 50 MB). Logs are kept for
good: the seed and the cross-check replay need them.

### 3. Scanning

#### 3.1 What is read

| Chain | Addresses in one `eth_getLogs` (address array, no topic filter) | Window | REREAD | SETTLE |
|---|---|---|---|---|
| Bittensor | vault, Bittensor adapter | 1,000 blocks | 400 | 10 |
| Base | front door, Base adapter, staker | 100 blocks (configurable) | 70 | 30 |

The numbers are the keeper's (*call*: mirror them exactly, so the two never disagree about what "settled"
means). The Base window is configurable because the probed public endpoints differ (section Facts); with a
2,000-block logs endpoint, backfill is 20 times faster. The FM-TAO token and the Uniswap pools are not scanned
(too busy); the monitor reads their state instead.

#### 3.2 The algorithm (per chain, per tick)

```
head        = server head (asked in the same JSON-RPC batch as the first window)
start       = scanned_to === null ? from_block : max(from_block, scanned_to + 1 − REREAD)
for each window [a, b] from start to head (b ≤ head), while the budget lasts:
    [logs, serverHead] = one JSON-RPC batch: eth_getLogs(addresses, a, b), eth_blockNumber
    if serverHead < b: retry once; still behind → stop this chain for this tick (cursor unchanged past a−1)
    identify every log: uid = keccak(chain:txHash:topics:data#n), n counting identical logs in one tx
    settled = logs with block ≤ head − SETTLE
    stage INSERT OR IGNORE for each settled log (decoded, args as JSON)
    vanished check: every stored log with block in [a, min(b, head − SETTLE)] that is not in this read
                    is staged removed = 1, and raises the indexer.reorg warning
    scanned_to = b
settled_to = min(scanned_to, head − SETTLE)   (only ever moves forward)
```

- A window is accepted only from a server that has reached its end (*call*: logs and head travel in one batched
  request to one server, as the site's `windowLogs` does). A load-balanced node that is behind answers "no logs"
  for blocks it hasn't seen; that must never count as none.
- A failed or refused window stops that chain for the tick without moving the cursor past the last whole window,
  so nothing is skipped; the next tick resumes there.
- Reorgs: logs are stored only SETTLE blocks deep, re-reads cover REREAD blocks, and the identity ignores block
  number and index, so a transaction re-mined elsewhere is not stored twice (`INSERT OR IGNORE` on `uid`). A
  stored log missing from a later read of its own block (a reorg deeper than SETTLE) is marked `removed`, left out
  of the seed and the rules, and reported; the seed pages are rebuilt.
- Decoding: each log is decoded against the ABI of the address it came from; an undecodable log is stored as
  `unknown` and raises a warning (a contract emitting something its ABI doesn't know is worth a look).
- Backfill: a new database starts every chain at the deployment's first block (*call*: Bittensor from the
  record's Bittensor adapter block, exactly the site's `bitBlock`, so the seed's `from` matches; Base from the
  record's Base adapter block). Bittensor is caught up first, since the API depends on it. A year of Bittensor
  is about 2,600 windows: about an hour of ticks on the free plan's budget. Until both chains are within an hour
  of their heads the monitor runs only the rules whose data is complete and the digest says "catching up".

#### 3.3 Block times and transactions

Rules work on chain time. For every block that holds a newly stored log, the tick fetches its header (one batched
request per chain) and stores the time. For events that only a few addresses can cause or that admin actions
emit (`BatchClosed`, `BatchRolled`, `PayoutChunkSent`, vault `Staked`, front door `Delivered`,
`RewardsClaimed`, `HotkeyAdded`, and every admin event), it fetches the transaction (`from`, `to`, selector,
nonce) into `txs`. Events whose arguments already name their sender are recorded without a fetch: the front
door's `RedeemRequested`, `RedeemCancelled`, `DepositCancelled`, `Claimed` and `DeliverySet` (the user is
`msg.sender`) and the staker's `Staked` (`payer` is `msg.sender`). Other user events are not fetched. That is a
few dozen lookups a day. `keys.unexplained_tx` counts a watched address's distinct transactions in `txs`.

#### 3.4 Seed pages

In the same commit that moves Bittensor's `settled_to`, the tick appends the newly settled deployment-wide seed
events (our front door's `BatchDelivered` with `sourceChain == 8453`, every vault `Staked`, every
`PayoutChunkSent`) to the last `seed_pages` row, opening a new page every 500 events. The API then reads one row
per 500 events instead of one per event (section 12). A `removed` log forces a rebuild of all pages.

#### 3.5 RPC client

One choke point (`src/rpc.ts`), as in `ops/src/rpc.ts`: JSON-RPC over `fetch`, batched requests, a minimum
spacing per chain (Base 300 ms ≈ 200 a minute; Bittensor 500 ms), HTTP 429 retried with backoff while wall time
allows, RPC URLs redacted from every error and log line. Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`,
on both chains) carries every `eth_call` of a tick in one `aggregate3` with `allowFailure: true`.

#### 3.6 The subrequest budget

*call*: every external `fetch` goes through a per-invocation counter; the tick stops scanning when 5 of its 50
are left, so the state reads, the rules and the emails always run. A steady tick needs about 10: one window per
chain (logs and head together), one multicall per chain, one nonce batch per chain, one block-time batch per
chain, the odd transaction lookup, and the price references every fifth minute. Backfill takes whatever is left.
D1 work is shaped to stay under 10 queries per invocation (each `db.batch()` counts once): the tick prefetches,
in one batch, every stored log the rules will read (this tick's new logs, the open batch's front door logs,
unchecked deliveries and chunks with their related logs, the last 24 hours of request events), and the rules
query that in memory.

### 4. The API

Three routes, all `GET` (and `OPTIONS` for CORS preflight); anything else is 404 or 405. No route writes.

**`GET /v1/scan/{vault}/{account}`** — the account's seed, exactly `ScanState` v1 so that
`seedScan(scan, await res.json())` works as is:

```json
{
  "v": 1,
  "vault": "0x…",
  "from": "9368744",
  "next": "9402131",
  "delivered": [{ "batchId": "3", "key": "0x…", "txHash": "0x…", "block": "9371002" }],
  "staked":    [{ "block": "9371040", "txHash": "0x…" }],
  "payouts":   [{ "key": "0x…", "chunk": 0, "taken": 1, "txHash": "0x…", "block": "9372950" }],
  "deposited": [{ "key": "0x…", "txHash": "0x…", "block": "9371002", "assets": "40000000000000000" }],
  "redeemed":  []
}
```

- `vault` must be the configured vault (any case), else 404; `account` must be 40 hex digits, else 400.
- `next = settled_to + 1` of Bittensor; every event has `from ≤ block < next` and comes from a stored, not
  removed log. The deployment-wide lists come from `seed_pages`; `deposited`/`redeemed` from `logs` by
  `(event, topic2)` with `topic2` the account left-padded to 32 bytes (`user` is the second indexed argument of
  both events), read in the same `db.batch()` as the cursor, so the snapshot is consistent.
- Headers: `Content-Type: application/json`, `Cache-Control: public, max-age=30`,
  `Access-Control-Allow-Origin: <SITE_ORIGIN>` (one fixed origin, *call*: a constant header keeps cached
  responses valid for every caller; CORS here is not a security boundary, the data is public),
  `Cascade-Settled-Time: <unix>` (exposed via `Access-Control-Expose-Headers`).
- 503 with `Retry-After: 60` until the first Bittensor window is stored.

**`GET /v1/status`** — health and the hold, for the keeper and for people (section 8). `Cache-Control: no-store`.
It names the deployment, says whether the hold is on and why, when the last tick completed, and how far each
chain is settled. It carries no alert details: alerts go only to the owner's email (*call*).

**`GET /v1/health`** — `200 ok` while the last complete tick is under 5 minutes old, else `503`: for an outside
uptime checker (open question 9).

### 5. How the site verifies, and how it falls back

The site work is its own tasks, after `web-hardening` merges. With `NEXT_PUBLIC_CASCADE_INDEXER_URL` unset,
nothing changes.

1. **When to ask.** In `scanFor(account)`, after loading the saved scan: if the chain head is more than 14,400
   blocks (2 days) past `scan.next` and the indexer isn't distrusted, fetch the seed with a 5-second timeout. A
   timeout, network error, non-200, invalid JSON, or a seed `decode` rejects all mean "no seed": the scan goes on
   from the browser's own state, exactly as today.
2. **Seeding.** `seedScan(scan, seed, { verify: true })` (one new option): besides the account's events, the
   seeded deliveries, stakes and payout chunks are marked `unconfirmed`, and the scan is marked `seeded`
   (persisted as an optional field, so older saved states still load).
3. **Every entry used is confirmed by a receipt before it shows.**
   - The account's `Deposited`/`Redeemed`: already confirmed by `confirmAccountEvents`; it now also keeps each
     event's `shares` from the receipt.
   - A delivery is used when a record's batch id is looked up; `depositFacts`/`withdrawalFacts` already fetch its
     receipt. A seeded delivery counts only if that receipt is successful and holds the vault's `BatchDelivered`
     with the same key, batch id, `sourceChain` 8453 and our front door.
   - The first stake after a delivery, and the payout chunks of a key, are confirmed by their receipts (vault
     `Staked`; `PayoutChunkSent` with the same key, chunk and taken) the first time a trail uses them.
   - A receipt that shows the entry is not there (from a server that has reached its block) means the seed lied:
     the scan restarts from the deploy block without the seed (`HistoryMismatchError`, as today), and the indexer
     is distrusted for 24 hours in this browser.
4. **Completeness of amounts.** Receipts prove an event exists, not that none was left out. The "rewards earned"
   figure sums the account's `Deposited` and `Redeemed`, so a seeded scan must also pass a share-conservation
   check once it reaches the head: csTAO is non-transferable, so `Σ Deposited.shares − Σ Redeemed.shares` must
   equal `balanceOf(account)` read at block `scan.next − 1` (one archive `eth_call`). If not (an omitted event,
   or the rarer mint paths: direct deposits, cancelled payouts, the treasury's cut), the site discards the seed,
   distrusts the indexer for 24 hours and runs its own scan from the deploy block before showing the figure. An
   unseeded scan isn't checked (today's behaviour).
5. **Omitted deliveries.** An omitted `BatchDelivered` would leave a record "on the bridge" too long. When a
   record's batch closed more than 2 hours before the seed's `next` and the seeded scan has no delivery for it,
   the site reads the Bittensor blocks from the close time to `next` directly (a few windows, by block time) and,
   if the delivery is there, treats the seed as lying (step 3's restart).
6. **What never comes from the indexer:** balances, share price, limits, quotes, claimable amounts, anything
   passed to a wallet. Those remain direct reads, as today.

### 6. The monitor's rules

Conventions:

- **Chain clocks.** Times in conditions are block times (`blocks.time`, or the head's time); the Worker's clock
  only schedules work.
- **Readings.** Each tick stores one reading of both chains (one Multicall3 per chain): vault `price`,
  `totalAssets`, `totalSupply`, `rootStakeRao`, `pendingPayouts`, `paused`, `owner`, `pendingOwner`,
  `guardian`, `pendingGuardian`, `keeper`, `stakeHotkey`, the hotkey set, `getStake` per set hotkey, the
  vault's balance, `payoutDelay`, outflow settings and the front door's `burnWindows` entry, `lastClaimAt` and
  unclaimed rewards on the stake hotkey; the front door's `openBatch`, `totalClaimable`, `totalFeeCredit`,
  `netForwarded`, `depositCap`, `maxBatchValue`, `maxDeposits`, `maxRedeems`, `batchInterval`, `paused`,
  `owner`, `guardian`, `keeper`; TAO `balanceOf(frontDoor)` and the front door's ETH balance; FM-TAO
  `totalSupply` on Base and the lock pool's FM-TAO balance on Bittensor; both pools' `slot0` and `liquidity`, the
  TAO held by the TAO/WETH pool, the oracle's `usdcValue(1e18)`; keeper balances; the Bittensor adapter's
  balance; AlphaVault `isPaused`, `migrationReadyAt`, `migrationFinished`; and the OffRamp execution state of
  every message not yet `SUCCESS` or `FAILURE`.
- **Settled evaluation.** A rule over logs runs only on ranges both chains have settled; a cross-chain rule waits
  until the other chain's settled time has passed the event's time (section 6.2).
- **Debounce.** Rules over readings that a single bad RPC answer could trip need two consecutive ticks
  (marked "×2"); log-based rules fire at once.
- **Alert keys and kinds.** Each finding has a stable key (rule plus its subject, e.g. `bridge.batch:42`), so a
  condition that persists is one alert, not one per tick. A rule is either a *condition* (a state that holds or
  not: solvency, lag, a low balance; the alert resolves when the state clears) or an *event* (something that
  happened: an admin log, a bounced deposit, a price drop, a cross-check result; the alert stays open until it is
  acknowledged, or closes quietly after 7 days, and never sends a "resolved" email).
- **Baseline.** Events in the deployment's own setup transactions (blocks up to the record's last deploy step on
  each chain) are the baseline, not alerts.

Thresholds are defaults in `src/thresholds.ts`, overridable through the `THRESHOLDS` variable (*call*: every
number below is in one place, so the owner can tune without touching rules).

#### 6.1 Critical

| ID | Condition (fires when) | Data | Default | Hold | What to do (runbook line) |
|---|---|---|---|---|---|
| `price.drop` | vault `price()` is lower than at the previous tick by more than 1e-9 of it | readings | 1e-9 | if ≥ 10 bps below the highest price of the last 24 h | Find the cause before anything else moves (stake hotkey and the vault's stake on taostats). If stake left the hotkey set or the drop is unexplained, guardian: `pause()` the vault so no batch is priced low; re-add a swapped hotkey with `addHotkey`. |
| `stake.unexplained_drop` | for a hotkey in the set, `getStake(h, vaultColdkey, 0)` fell by more than 1,000 rao between two readings, with no vault `Unstaked`, `StakeMoved` or `HotkeyRemoved` log in that block range (evaluated once Bittensor settled past the later reading) | readings, logs | 1,000 rao | yes | Stake left the vault without a vault action: look up the hotkey on taostats (swap, slash, chain change). Guardian: pause the vault until it is explained. |
| `stake.hotkey_changed` | the vault's `stakeHotkey` or hotkey set differs from the last reading; or the hotkey's owner in SubtensorModule `Owner` (storage-query precompile `0x…0807`, as `web/src/lib/cascade/apy.ts` reads `BasketTwr`) changed or vanished ×2 | readings | — | yes when the owner vanished | A hotkey change the owner didn't make means a validator-side swap: re-add the new hotkey with `addHotkey` (owner, guardian or keeper) and check the price. |
| `admin.event` | any admin event (list in Facts) from the vault, front door or staker after the baseline | logs, txs | — | no | Name the sender. If it was a planned change, acknowledge. If not: guardian `pause()` both contracts now, then rotate keys. |
| `keys.unexplained_tx` | a watched address's nonce (owner, pending owner, guardian and keeper of each contract, read every tick, plus any configured extra address) rose by more than the number of its transactions seen in Cascade's logs (section 3.3), still so 15 minutes later | nonce batch, txs | 15 min | no | A transaction left a Cascade key that didn't touch Cascade (or reverted). Open the address on the explorer (link in the email). If it isn't yours, treat the key as compromised: guardian pause, rotate. The rule is quiet only while these keys are used for Cascade alone; acknowledge your own other transactions. |
| `frontdoor.solvency` | TAO `balanceOf(frontDoor)` < `openBatch.totalDeposits + totalClaimable`, or the front door's ETH < `openBatch.feePot + totalFeeCredit`, in one block ×2 | readings | — | yes | The front door holds less than it owes. Guardian: `pause()` the front door (claims and cancels still work); find the transfer that broke the identity. |
| `vault.solvency` | `rootStakeRao × 1e9 + balance(vault) < pendingPayouts + 1e12` ×2 | readings | — | yes | The vault can't cover its queued payouts. Guardian: pause the vault; do not process payouts. |
| `ccip.failure` | the destination OffRamp's `getExecutionState(messageId)` is `FAILURE` for a message our front door or vault sent | messages, readings | — | no | The message and its tokens wait in CCIP. Open it on ccip.chain.link (link) and note the reason; it can be executed again by hand once the cause is fixed. Don't pause anything else for this alone. |
| `ccip.unexpected_source` | an adapter `Delivered` into the vault or front door whose `sender` isn't that contract's registered peer (front door → vault, vault → front door) | logs | — | yes | A Cascade contract accepted a message from an unexpected sender. Treat it as a forgery: the steps of `bridge.batch_mismatch` (vault side) or `bridge.payout_mismatch` (Base side). |
| `deposits.bounced` | any `DepositBounced` | logs | — | no | The vault read itself as insolvent and returned the deposits. Find out why (price, stake) before the next batch; process the bounced payout, never cancel it. |
| `fmtao.unbacked` | FM-TAO `totalSupply` on Base exceeds the Bittensor lock pool's FM-TAO balance by more than 0.01 TAO ×2 | readings | 0.01 TAO | no | TAO on Base isn't fully backed. Guardian: pause the front door (stops new batches and deliveries); tell ForeverMoney and Chainlink; hold payouts until it is explained. |
| `fmtao.depeg` | the TAO/WETH pool's TAO price in USD (from both pools' `slot0`) differs from the reference TAO price by more than 5%, on two readings 5 minutes apart | readings, price APIs | 5% | no | TAO on Base trades away from TAO. Guardian: pause the front door if it persists; deliveries' floors stop sales into a crashed pool. |
| `bridge.batch_mismatch` | a delivery fails the batch cross-check (6.2) | logs, D1 | — | yes | Possible forged batch. Guardian: `pause()` the vault now. Owner: `cancelPayoutBatch(key, payouts)` before **{deadline UTC}** (queued time + payout delay), with the list rebuilt from the vault's events for this key. Keep the hold until the cancel lands. |
| `bridge.payout_mismatch` | a payout landing on Base fails the payout cross-check (6.2) | logs, D1 | — | yes | Possible forged payout: TAO was minted on Base for it. Guardian: `pause()` the front door (deliveries stop; claims can't be stopped); tell ForeverMoney and Chainlink; keep the hold. |
| `bridge.duplicate` | a second `BatchDelivered` for one batch id from our front door, or a second `PayoutsDelivered` for one (key, chunk) | logs | — | yes | One message delivered twice under different content. As `bridge.batch_mismatch` (vault side) or `bridge.payout_mismatch` (Base side). |
| `site.integrity` | the live site's JavaScript is missing a configured Cascade address, or contains a 0x-address not in the approved list (6.6) | hourly fetch | — | no | The site may be tampered with. Take it down (Pages: roll back or disable the project), then check DNS, the build and the Pages project. |

#### 6.2 The bridge cross-check

**Batches, Base → Bittensor.** For each stored vault `BatchDelivered(key, sourceChain, frontDoor, batchId,
amount)`, once Base has settled past its block time:

1. `sourceChain == 8453` and `frontDoor` is ours (else `ccip.unexpected_source`).
2. Exactly one `BatchClosed(id = batchId)` from our front door exists, with `totalDeposits == amount`.
3. The delivery transaction holds exactly `nDeposits` deposit outcomes (`Deposited`, `DepositBounced`,
   `DepositSkipped` with this key) and `nRedeems` redeem outcomes (`Redeemed`, `RedeemDeferred`,
   `RedeemSkipped`).
4. The Bittensor adapter's `Delivered` in the delivery transaction has the same `messageId` as the Base adapter's
   `Sent` in the `BatchClosed` transaction, and both name front door → vault with `amount == totalDeposits`.
5. **The key matches the batch the front door built.** Replaying the front door's `DepositRequested`,
   `DepositCancelled`, `RedeemRequested` and `RedeemCancelled` for this batch id in log order, with the
   contract's rules (one merged entry per user per list, partial cancels reduce, a full cancel moves the last
   entry into the freed slot, a request that meets a full redeem list closes the batch first and lands in the
   next one), gives the two lists; `keccak256(abi.encode(uint64 8453, frontDoor, keccak256(encodeBatch(batchId,
   deposits, redeems))))` must equal `key`.
6. The outcomes match the lists entry by entry: the i-th deposit outcome names `deposits[i].user` with
   `deposits[i].amount` (floored to rao, as the vault does); the i-th redeem outcome names `redeems[i].user`,
   with `requested == redeems[i].amount` for skipped or deferred entries and `shares ≤ redeems[i].amount` for
   burned ones.

Any failure is `bridge.batch_mismatch` with the failing step in the email; a replay that can't be done (a cancel
for an entry the replay doesn't have) is the same alert, worded "can't rebuild this batch", because the response
is the same: stop and look. Steps 1–4 catch most forgeries without the replay; step 5 makes the check exact,
since the key commits to every byte of the message. The result is stored in `batch_checks`, so each batch is
checked once.

**Payouts, Bittensor → Base.** For each stored front door `PayoutsDelivered(batchKey, chunk, amount, bridge)`,
once Bittensor has settled past its block time:

1. `bridge` is our Base adapter (a payout through any other bridge is `bridge.payout_mismatch`).
2. Exactly one vault `PayoutChunkSent(key = batchKey, chunk)` exists, with `net == amount` and `net > 0`.
3. The Base adapter's `Delivered` in the same transaction has the `messageId` of the Bittensor adapter's `Sent`
   in the `PayoutChunkSent` transaction, both naming vault → front door.
4. The `PayoutReceived` list in the transaction equals the chunk's entries recomputed from the vault: the batch's
   payout list (`DepositBounced` then `Redeemed` for the key, in log order of its delivery), entries
   `[cursor, cursor + taken)` where `cursor` sums the earlier chunks' `taken`, each paid
   `floor_rao(assets − ceil(assets × fee / gross))`, zeros dropped.
5. `frontDoor.delivered(bridge, keccak256(encodePayouts(batchKey, chunk, entries)))` reads true (one call in the
   next multicall), which ties the check to the exact bytes the front door accepted.

**Timeliness (warnings).** A `BatchClosed` with no matching delivery 60 minutes after its block time, and a
`PayoutChunkSent` with `net > 0` and no landing 60 minutes after, are `ccip.undelivered` (6.3), alongside the
OffRamp state.

**Why the timing rule matters.** Base is read 30 blocks (a minute) behind its head and Bittensor 10 blocks (two
minutes); a delivery is about 20 minutes behind its close. Waiting for the other chain's settled time to pass the
event's time means an honest batch is never judged before its Base side is stored, while a forged one is judged
within a few minutes of arriving: far inside the 24-hour payout delay that bounds the cancel.

#### 6.3 Warning

| ID | Condition | Data | Default | What to do |
|---|---|---|---|---|
| `ccip.undelivered` | a message our contracts sent is not `SUCCESS` 60 min after its source block time | messages | 60 min | Check it on ccip.chain.link; lanes are sometimes slow. If it stays stuck for hours, raise it with Chainlink. |
| `ccip.foreign_send` | an adapter `Sent` whose `sender` isn't the front door or the vault and whose `recipient` is a Cascade contract | logs | — | Someone sent a message through our adapter at a Cascade contract; the contract will refuse it (its execution should end in `FAILURE`). Nothing to do unless it reaches `SUCCESS` (then `ccip.unexpected_source` fires). |
| `batch.past_max_wait` | the open batch has entries and Base time > `openStart + max(batchInterval, batchMaxWaitS) + 15 min` | readings | 15 min | The keeper isn't closing: check that it runs, its ETH, and the front door's state. |
| `payout.overdue` | a queued payout batch still pending (`getPayoutBatch(key).count > cursor`) at `queuedAt + payoutDelay + 60 min` | logs, readings | 60 min | The keeper isn't paying out: check it runs and its TAO; `processPayouts` is open to anyone after the delay. |
| `delivery.overdue` | a user with `claimable > 0` and a live delivery preference, 120 min after their `PayoutReceived` | logs, readings | 120 min | The keeper can't deliver USDC: check the TWAP oracle and the floors in the keeper's log; the user can still claim. |
| `keeper.low_eth` / `keeper.low_tao` | keeper ETH on Base < 0.002; keeper TAO on Bittensor < 0.1 | readings | 0.002 ETH, 0.1 TAO | Top up the keeper wallet. |
| `adapter.low_reserve` | the Bittensor adapter's native balance < 5e11 wei | readings | 5e11 | Top up with `fundReserve()`. |
| `twap.divergence` | `oracle.usdcValue(1e18)` differs from the spot price by more than 2% ×2, or the oracle call reverts ×2 | readings | 200 bps | Deliveries may stall (or the pool is being pushed). Watch the pool; users can claim by hand. |
| `pool.liquidity` | the TAO/WETH pool's TAO balance or in-range `liquidity` below 50% of its 7-day median (hourly) | readings | 50% | Swaps cost more; consider lowering batch and deposit limits. |
| `batch.one_wallet` | one payer (the staker's `Staked.payer` for staker deposits, else `DepositRequested.payer`) holds ≥ 50% of an open batch's TAO when the batch is ≥ 50% of `maxBatchValue`, or ≥ 10 of its entries | logs | 50%, 10 | One wallet is filling batches; watch for griefing of the cap or the lists. |
| `cap.nearly_full` | `netForwarded + openBatch.totalDeposits ≥ 90% of depositCap` | readings | 90% | New deposits will soon be refused; decide whether to raise the cap. |
| `unstakes.tiny_wave` | ≥ 20 `RedeemRequested` in 24 h each worth < 0.02 TAO at the current price, or the open batch's redeem list ≥ 80% of `maxRedeems` | logs, readings | 20, 0.02 TAO, 80% | Someone may be pushing honest exits into later batches; watch the next batches. |
| `outflow.near_limit` | this front door's burned amount in the vault's current 24-hour window plus the redeems waiting (open batch and in flight, at the current price) ≥ 80% of `max(gross × maxDailyOutflowBps / 10,000, minDailyOutflow)` | readings, logs | 80% | Exits beyond the allowance will be deferred; expect `RedeemDeferred`. |
| `rewards.uncollected` | Bittensor time − `lastClaimAt(stakeHotkey)` > 35 days, or unclaimed rewards ≥ 25 × 0.057 TAO (the keeper's claim policy) | readings | 35 d, 25× | Run `pnpm ops claim --live`. |
| `vault.events` | any `RedeemDeferred`, `PayoutDust`, `DepositSkipped` or an undecodable log | logs | — | Read the event in the email; usually a user-level edge case. |
| `indexer.lag` | a chain's settled time more than 15 minutes behind its head (2 hours: raised to critical `indexer.blind`) | cursors | 15 min / 2 h | The monitor can't see a chain: check the RPC (quota, outage), switch URLs if needed. |
| `indexer.reorg` | a stored log vanished from a later read | logs | — | Usually harmless; if it was a Cascade transaction, re-check its effects. |
| `site.unreachable` | the hourly integrity check couldn't fetch the site for 30 min | hourly fetch | 30 min | Check that the site is up (Pages, DNS). |
| `monitor.chain_unreadable` / `monitor.email_failing` / `monitor.rule_failed` | 5 ticks in a row without a chain's state; emails failing for 30 min; a rule that threw | tick | 5, 30 min | Check RPC URLs and the email binding; a failing rule names its error (a bug to fix). |

Warnings are emailed at most every 30 minutes, all new ones together (section 7).

#### 6.4 Two more rules I propose (*call*, cheap; drop if unwanted)

- `rail.alpha_vault` (critical): ForeverMoney's AlphaVault reads `isPaused()`, `migrationReadyAt() != 0` or
  `migrationFinished()`. The keeper already refuses to close then; the email says to pause the front door so no
  one else closes a batch into a rail that may not deliver, and to follow the bridge runbook.
- `fmtao.mint_surge` (warning): FM-TAO's total supply on Base rose by more than 500 TAO in an hour beyond the
  payouts that landed for Cascade. Other people's bridging moves supply too, so this is a nudge, not a page.

#### 6.5 Daily digest (13:00 UTC)

Subject `[Cascade daily] {date}: {OK | n warnings | CRITICAL open}`. Contents: total staked (`totalAssets`),
share price and its 24-hour and 7-day change, APY (the site's `netApyPercent` method: the validator's
`BasketTwr` over 30 days, less the reward cut); batches closed, delivered and paid out in 24 hours, the open batch
(age, entries, TAO); fees earned in 24 hours (staker fees from `Staked.fees`, the reward cut from
`RewardCutMinted`, payout bridge fees from `PayoutChunkSent.fee`, close fees from `BatchClosed.fee`); keeper
balances on both chains; open warnings and criticals with their age; the hold; indexer lag and the number of
ticks run, failed and skipped; emails sent. The digest's arrival is itself the monitor's heartbeat: no digest
means the monitor is down.

#### 6.6 Website integrity (hourly)

The hourly job fetches the site's pages listed in `SITE_PAGES` (default `/` and `/stake/`), collects every
`<script src>` under `/_next/static/` (at most 40 files) and the inline scripts, and extracts every
`0x[0-9a-fA-F]{40}`. *call*: compare against an **approved address list** committed in
`indexer/src/site-addresses.ts`, generated by `pnpm site:addresses ../web/out` from the static export the owner
is about to deploy. Critical if any configured Cascade address (front door, staker, vault, adapters, oracle) is
missing, or any address appears that isn't approved; warning if the site can't be fetched for 30 minutes.
Content hashes are not compared: they change with every build, while the address set changes only when
dependencies or the deployment do, so the owner refreshes the list rarely and reviews it in git.

### 7. Email

- **Transport:** the `send_email` binding `EMAIL`, restricted with `allowed_sender_addresses` to the sender in
  `ALERT_FROM` (e.g. `monitor@cascade.fi`). Recipients come from the secret `ALERT_TO` (comma-separated), so no
  personal address is in the public repo. *call*: send only to **verified destination addresses** (free on every
  plan, no quota); that needs Email Routing on the sending domain (open question 2).
- **Tiers:**
  - Critical: sent in the tick that opens it, subject `[CASCADE CRITICAL] {summary}`; re-sent every 60 minutes
    while open and not acknowledged, at most 6 times; a `[Cascade resolved] {summary}` when a condition clears
    (event alerts don't resolve by themselves: section 6 conventions).
  - Warning: collected and sent at most every 30 minutes as one email, subject `[Cascade warning] {n} new: {first
    summary}`; not re-sent; listed in the digest while open; resolved quietly (the digest says so).
  - Digest: daily, section 6.5.
- **Body** (plain text and simple HTML, same content): one sentence of what happened; the facts (chain, block,
  time, contract, transaction links on basescan.org / evm.taostats.io, CCIP explorer links, amounts with units);
  **What to do:** the rule's runbook line, with values filled in (key, deadline); whether the hold is on and how
  to clear it; how to acknowledge. *call*: emails contain explorer links and hashes only, never a link to sign
  anything, and say so in the footer ("act from your own tools, never from a link in this email").
- **Every rule has a runbook line** in `src/runbook.ts`; a test fails for a rule without one.
- **Acknowledging:** `pnpm alerts:ack <id>` runs `wrangler d1 execute` to set `acknowledged_at` (stops re-sends).
- **Failures:** a send that throws leaves `notified_at` unset and is retried next tick; `E_RATE_LIMIT_EXCEEDED`
  and `E_INTERNAL_SERVER_ERROR` back off; validation errors are logged and raise `monitor.email_failing`. A send
  never stops the tick.
- **Local and dry runs:** `ALERT_MODE=log` writes the rendered email to the log instead of sending (the default in
  local dev and tests).

### 8. The hold flag

**When it is raised.** Findings of rules marked "Hold" in 6.1 raise a hold row with a stable id
(`bridge.batch:42`, `price.drop:{bittensor block}`, …). The Worker never clears a hold by itself, even when the
condition clears. It never pauses anything either: a paused vault or front door makes bridge messages that arrive
meanwhile fail until someone executes them again by hand, so a pause stays a human decision, taken with the
email's steps in front of them.

**What the keeper reads** (the keeper change is a later task): `GET {OPS_HOLD_URL}` (the Worker's
`/v1/status`), schema v1:

```json
{
  "v": 1,
  "deployment": { "frontDoor": "0x…", "vault": "0x…", "baseChainId": 8453, "bittensorChainId": 964 },
  "hold": {
    "active": true,
    "reasons": [{ "id": "bridge.batch:42", "rule": "bridge.batch_mismatch", "since": "2026-…Z",
                  "summary": "Batch 42 delivered on Bittensor doesn't match the batch the front door closed" }]
  },
  "monitor": { "lastCompleteTickAt": "2026-…Z", "degraded": false },
  "indexer": { "base": { "settledTo": 53227000, "settledTime": "…Z" },
               "bittensor": { "settledTo": 9402130, "settledTime": "…Z" } },
  "generatedAt": "2026-…Z"
}
```

**What the keeper does with it** (*call*, the interface the later task builds):

- Before closing a batch with any redeem entry, and before `processPayouts`, the keeper reads the status. It holds
  (skips the action and logs why, once) when `hold.active` is true, **or** the status can't be read or parsed, its
  `deployment` isn't the keeper's record, or `monitor.lastCompleteTickAt` is more than 15 minutes old. That is,
  it fails closed: a monitor that can't see is treated as a monitor that says stop. Payouts have a 24-hour delay
  and redeem batches can wait, so a monitor outage costs time, not money.
- Deposit-only closes, staking and reward reports are unaffected. USDC deliveries are unaffected too unless the
  owner decides otherwise (open question 4).
- A local file `ops/hold.json` (git-ignored, `{ "v": 1, "hold": true, "reason": "…" }`) holds the keeper too:
  a manual brake that needs no Cloudflare.
- `OPS_HOLD_URL` unset keeps today's behaviour (no monitor configured). `pnpm ops run --ignore-hold` runs without
  the check, printing a warning each round: the escape hatch when Cloudflare is down and a human has decided.
- The hold stops our keeper only. `closeBatch` and `processPayouts` stay open to anyone (by design), so the hold
  buys time for the human steps in the email; it doesn't replace them.

**Clearing.** No HTTP route can set or clear it. A human clears it with `pnpm hold:clear -- --env production
--note "…"`, which runs `wrangler d1 execute <db> --remote` with an `UPDATE holds SET cleared_at, cleared_note
WHERE cleared_at IS NULL` (the note restricted to letters, digits, spaces and basic punctuation). Clearing needs
Cloudflare account access, the right authority for it. A cleared condition doesn't raise the hold again; for the
price rule the 24-hour high is reset to the current price, so the same drop isn't re-counted.

### 9. Config and secrets

`indexer/wrangler.jsonc` (committed): name, `main`, `compatibility_date`, `observability.enabled`, the three
crons, `"cache": { "enabled": true }`, the D1 binding `DB` and the `send_email` binding `EMAIL` per environment
(`env.test`, `env.production`), and `vars`:

| Var | Example | Notes |
|---|---|---|
| `DEPLOYMENT` | JSON: chain ids, front door, Base adapter, staker, oracle, vault, Bittensor adapter, vault coldkey, stake hotkey, Base and Bittensor start blocks, baseline blocks, `batchMaxWaitS` | public; generated by `pnpm config:from-record ../ops/deployments/v3-test.json` (reads the ops record with its `$bigint` reviver) |
| `TOKENS` | FM-TAO on Base and Bittensor, the Bittensor lock pool, USDC, WETH, the two Uniswap pools, Multicall3, OffRamps, AlphaVault | public constants, as in `ops/src/config.ts` |
| `BASE_RPC_URL`, `BASE_LOGS_RPC_URL`, `BITTENSOR_RPC_URL` | `https://mainnet.base.org`, `https://base-rpc.publicnode.com`, `https://archive.chain.opentensor.ai` | a secret of the same name overrides each (for a keyed URL) |
| `BASE_LOG_WINDOW` | `100` | Base `eth_getLogs` window |
| `SITE_ORIGIN`, `SITE_URL`, `SITE_PAGES` | `https://cascade.fi`, `https://cascade.fi`, `["/","/stake/"]` | CORS and the integrity check |
| `ALERT_FROM`, `ALERT_MODE` | `monitor@cascade.fi`, `send` | `log` in dev and tests |
| `THRESHOLDS` | `{}` | overrides of `src/thresholds.ts` |
| `PRICE_SOURCES` | `["coingecko","coinbase"]` | reference TAO price for `fmtao.depeg` (median of those that answer; both must agree within 2%) |

Secrets (`wrangler secret put`, or `.dev.vars` locally, git-ignored): `ALERT_TO`; optionally the three RPC URLs
when keyed. **No private key, mnemonic or signer exists anywhere in the Worker.** `src/config.ts` parses and
validates all of it at the start of every invocation (checksummed addresses, integer blocks, known price
sources) and refuses to run on a bad config, raising nothing but a log line (an unconfigured Worker must not
spam).

### 10. Local development and testing (no deploy)

- **Package:** `indexer/` with its own `package.json` (pnpm 11.23.0), TypeScript 5.9.3, vitest 5.0.5,
  `@cloudflare/vitest-plugin` 1.4.2 (which pins wrangler 4.151.0), wrangler 4.151.0, viem 2.57.7 and
  `@noble/hashes` 1.8.0 (the web app's versions); `wrangler types` generates `worker-configuration.d.ts`
  (committed).
- **Tests** (`pnpm test`): two vitest projects. `worker`: every `src/` module runs inside workerd through
  `cloudflareTest()`, with D1 migrations applied by `applyD1Migrations` in a setup file and a fake JSON-RPC server
  injected as the `fetch` the RPC client uses (scripted answers per method, a head that can lag, failures on
  demand); handler tests call `worker.fetch` and `worker.scheduled(createScheduledController({ cron }), env,
  ctx)`. `node`: the Node scripts (`config:from-record`, `site:addresses`, `hold:clear`, `alerts:ack`).
- **Fixtures:** recorded logs from the live v3 test deployment (a delivered batch, a paid-out chunk) captured once
  by a script and committed as JSON, so the replay and the cross-check are tested on real bytes; a seed fixture
  that the web tasks feed to the real `seedScan`.
- **Run it locally:** `pnpm wrangler d1 migrations apply DB --local --env test`, then `pnpm wrangler dev --env test
  --test-scheduled`, then `curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*"` to run a tick
  against the live chains (read-only) and `curl http://localhost:8787/v1/scan/{vault}/{account}`. Local D1 lives
  in `.wrangler/state` (git-ignored). Email stays in `ALERT_MODE=log`; never set the binding's `remote: true`.
- **Live smoke** (`pnpm smoke`, skipped unless `INDEXER_SMOKE=1`): one tick against the v3 test deployment into a
  Miniflare D1, printing the digest; asserts the seed for the test wallet passes the web's `decode` rules.

### 11. Deploy steps the owner will do later

1. `pnpm --dir indexer install && pnpm --dir indexer test`.
2. `pnpm --dir indexer wrangler login`.
3. `pnpm --dir indexer wrangler d1 create cascade-indexer-test`; paste the printed `database_id` into
   `env.test` in `wrangler.jsonc` (an id, not a secret).
4. `pnpm --dir indexer wrangler d1 migrations apply cascade-indexer-test --remote --env test`.
5. Email: in the dashboard, Email Service → Email Routing → onboard `cascade.fi` (it adds the MX and SPF
   records), then add and verify the destination address. `pnpm --dir indexer wrangler secret put ALERT_TO --env
   test`.
6. Optional: keyed RPC URLs as secrets.
7. `pnpm --dir indexer config:from-record ../ops/deployments/v3-test.json` and paste the `DEPLOYMENT` value.
8. `pnpm --dir indexer wrangler deploy --env test`; add the custom domain (`api.cascade.fi`, or the
   `workers.dev` URL to start).
9. Watch `GET /v1/status` until both chains are settled near their heads (an hour or so); expect the first digest
   at 13:00 UTC; trigger one warning on purpose (e.g. a low `THRESHOLDS.keeperMinEth` above the real balance) to
   see an email arrive, then remove it.
10. Optional on the free plan: a WAF rate-limiting rule on `api.cascade.fi/v1/*` (one rule is included), and an
    outside uptime check on `/v1/health`.
11. Site: set `NEXT_PUBLIC_CASCADE_INDEXER_URL` (after the site tasks). Keeper: set `OPS_HOLD_URL` (after the
    keeper task).
12. Production: the same with `--env production` once the launch deployment exists.

### 12. Cost on the free tier

| Resource | Use | Free limit |
|---|---|---|
| Worker requests | 1,440 ticks + 24 hourly + 1 digest + API calls (1–2 per site visit) ≈ 3,500/day at 1,000 visits | 100,000/day per account (shared with Pages Functions; static Pages are free) |
| Subrequests | ~10 per steady tick; backfill ticks up to 45 | 50 per invocation |
| CPU | steady tick estimated 3–8 ms (decoding a few logs and two multicall answers): **unmeasured** | 10 ms per invocation |
| D1 rows written | cursors 2,880 + readings 1,440 + logs ~500 + seed page updates ~200 + alerts ≈ 6–10 k/day | 100 k/day |
| D1 rows read | ticks ~200 k/day + API ~50 rows per call (seed pages instead of per-event rows) | 5 M/day |
| D1 storage | ~150 MB/year of logs + ~50 MB readings | 500 MB per database |
| Email | alerts and digests to verified addresses | free, no quota |
| RPC, price APIs | public endpoints | free (rate-limited) |

It fits at $0. Three things make the free plan fragile for a security monitor, so *call*: **recommend Workers Paid
($5/month) for production** and use the free plan for the test deployment:

- **CPU.** 10 ms is tight; a tick over it is killed. Measure in the first week (Workers Observability shows CPU per
  invocation). The scan is built to split work across ticks, but rule evaluation can't be split indefinitely.
- **Subrequests.** 50 per invocation slows backfill and leaves little slack when RPCs retry.
- **The shared daily request quota.** Anyone can spend the account's 100,000 daily requests by calling the public
  API (cache hits count). Past it the Worker returns error 1027; whether cron invocations are then refused too
  isn't documented, so a flood could blind the monitor until midnight UTC. Paid has no daily limit.

### 13. Security of the Worker itself

**What it holds:** public chain data, alert history, the alert recipients (`ALERT_TO`), and any keyed RPC URLs.
No signing key, no user data beyond public addresses.

**An attacker who controls the Worker, its code, its D1 or the Cloudflare account can:**

- serve false history to the site: the site uses an entry only after its receipt confirms it, checks the account's
  amounts by share conservation, and otherwise falls back to its own scan (section 5). The worst left is a stale
  or slow trail, not a wrong amount or a wrong transaction;
- silence the monitor: suppress alerts, digests and the hold. The missing daily digest is the tell; an outside
  uptime check on `/v1/health` is the stronger one (open question 9);
- send false alerts: emails carry explorer links and hashes only, and every action they ask for is done from the
  owner's own tools, never from a link (stated in every footer);
- raise a false hold: our keeper stops redeem closes and payouts until a human clears it (a delay, bounded by the
  human); or clear a real one: back to the brake not existing;
- read the keyed RPC URLs (quota theft) and the recipient address;
- with the account itself, also change the Pages site: that is account security (hardware-key 2FA, few members),
  outside this design. The integrity check runs from Cloudflare, so it guards against DNS and build tampering
  more than against an account takeover.

**It can't:** move or freeze money, sign or send a transaction, change a contract setting, change what a user's
wallet is asked to sign, or change a balance the site shows.

**Hardening in the design:** no write routes and no admin routes; every route validates its parameters and queries
D1 only through prepared statements; one fixed CORS origin; `no-store` on status; minimal dependencies (viem
only at runtime), exact pins and a committed lockfile; secrets only for the recipient and keyed RPC URLs; the
RPC client never logs URLs; a test that greps `src/` for transaction-sending methods; the hold can only be cleared
with account access. A lying RPC can make the monitor miss or invent things; a second RPC per chain for the
critical reads is a later improvement (open question 12).

### 14. Open questions for the owner

1. **Workers Paid ($5/month) for production?** Recommended (section 12): CPU, subrequests and the shared daily
   request quota. The test deployment can stay free.
2. **Email:** is cascade.fi's DNS on Cloudflare, and does anything else receive mail for cascade.fi today
   (Email Routing takes over its MX records)? Which address gets alerts? A subdomain sender (e.g.
   `alerts.cascade.fi` with Email Sending on Paid) avoids touching the main domain's mail.
3. **Keeper fail-closed:** the design holds redeem closes and payouts when the monitor is unreachable or stale
   (15 minutes). Agree? The alternative (fail open) keeps exits moving through a monitor outage but lets an outage
   hide a forgery.
4. **Should the hold also stop USDC deliveries?** On a payout mismatch, the TAO on Base may be unbacked; selling it
   for users is arguably right (they get USDC) or wrong (we sell into a depeg). The floors protect the price
   either way.
5. **Thresholds:** sharp drop 10 bps from the 24-hour high; depeg 5%; TWAP divergence 2%; keeper floors 0.002 ETH
   and 0.1 TAO; the tiny-unstake and one-wallet numbers. Any to change?
6. **Price references:** OK to call CoinGecko and Coinbase's public price endpoints from the Worker (no keys)?
7. **Planned admin changes:** today every admin event is critical, including the owner's own. Want a way to
   pre-announce a change (a row added with wrangler) so its alert says "announced"?
8. **Domains:** the API at `api.cascade.fi`? Which site origin(s) to allow: only `https://cascade.fi`, or also
   `www` and Pages preview URLs (previews would then fall back to their own scan)?
9. **Outside heartbeat:** add a free external uptime check on `/v1/health` that emails if the Worker stops?
   (An outward action on a third-party service, so your call.)
10. **FM-TAO backing:** is FM-TAO bridged to chains other than Base? If so, the backing rule (Base supply ≤
    Bittensor lock) still holds but is weaker; a full check would add the other chains' supplies.
11. **Run on the v3 test deployment now?** Recommended: it rehearses the backfill, the cross-check on real
    batches and the email path before launch.
12. **A second RPC per chain** for the critical reads (price, stake, supply), raising a warning when they
    disagree: worth paying for a keyed provider?

## Left to the builder

File layout inside `indexer/src`, the exact email wording within the rules above, HTML styling, the fake RPC's
shape, how readings are compacted into JSON, and the order of rules within a tick.
