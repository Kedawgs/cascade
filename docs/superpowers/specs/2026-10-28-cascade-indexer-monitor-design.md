# Cascade history indexer and monitor — design

Date: 2026-10-28; revised 2026-10-29 after review (items C1, I1–I11, M1–M13). Status: design, not built. Builds
on the v3 contracts (`contracts/src`, tags `v3.0`/`v3.1`), the keeper's incremental log scan
(`ops/src/keeper/state.ts`) and the site's resumable vault scan on branch `web-hardening`
(`web/src/lib/cascade/facts.ts`, `live.ts`, `scan-store.ts`), which is still in review: section 5 is to be
re-checked once it merges.

## Intent

Two small backend pieces, in one Cloudflare Worker with one D1 database:

1. **A history indexer.** Today every browser reads the vault's whole event history from the deploy block in
   1,000-block windows: about 3 seconds per day of deployment age, so about 18 minutes for a first visit a year
   after launch. `web-hardening` makes the scan resumable in the browser (a deployment-wide half and a
   per-account half) and accepts a published starting point (`seedScan`). The indexer publishes both halves. It
   is an accelerator only: the site checks what it uses against chain receipts and works without it.
2. **A monitor.** It watches both chains and the bridge between them every minute, emails the owner when
   something is wrong, and sends a daily summary. Its most important job is the bridge cross-check: every batch
   that arrives on Bittensor must be one the front door really closed on Base, and every payout that arrives on
   Base must be one the vault really sent. In April 2026 a bridge integration elsewhere lost funds to a forged
   cross-chain message that its verifier accepted; a second forged message was stopped only because people
   noticed in time. The cross-check exists so that we notice, and the keeper doesn't pay out a batch the
   monitor hasn't confirmed.

## Goals

- A first visit shows the account's history in seconds, whatever the deployment's age, with amounts taken only
  from chain receipts, and figures that depend on the history being complete marked as such until it is checked.
- The site behaves exactly as today when the indexer is down, slow, wrong or absent.
- Every rule in the owner's agreed list is a precise, testable condition with a data source, a threshold and a
  one-line "what to do".
- A forged or altered bridge message is reported within minutes, with the exact steps and the deadline for
  undoing it (the vault's `payoutDelay`: 24 hours at launch, 1 hour on the v3 test deployment).
- The keeper pays out a batch only after the monitor has confirmed it, and stops closing redeem batches and
  sending payouts while the monitor raises a hold or can't see a chain well enough to judge.
- Everything runs and is tested locally with wrangler and Miniflare; nothing is created or deployed by the build.

## Non-goals

- Balances, quotes, limits or anything a user signs: those stay direct chain reads in the site.
- Any keeper decision other than the hold and the per-batch confirmation. The keeper stays chain-only.
- Pausing, cancelling or any other transaction. The Worker holds no keys and never sends a transaction.
- A public alert feed, a dashboard, SMS or push notifications (email only for now).
- v2 deployments (being wound down). The indexer and monitor target v3 deployments.

## Anti-goals (a failure even if it works)

- A figure on the site that came from the indexer without a chain receipt behind it, or a figure that needs a
  complete history shown as final before the history is known to be complete.
- A forged or altered batch or payout that passes the cross-check, or an honest one that fails it because the
  other chain hasn't been read yet or because one transaction carried two messages.
- A payout sent by our keeper for a batch the monitor hasn't confirmed.
- An alert nobody can act on: every alert says what happened, where to look, and what to do.
- A way to set or clear the hold, or to write anything, over HTTP.
- Alert fatigue: a rule that pages the owner for honest rounding, a lagging node or something that needs no action.

## Facts (verified 2026-10-28/29 unless marked)

### The contracts' events, as the rules use them

- **Front door (Base)** `CascadeFrontDoor.sol`: `DepositRequested(uint64 indexed batchId, address indexed user,
  uint256 amount, address payer)` (`payer` is `msg.sender`; `user` is the beneficiary), `DepositCancelled(batchId,
  user, amount)`, `RedeemRequested(batchId, user, shares)`, `RedeemCancelled(batchId, user, shares)`,
  `BatchClosed(uint64 indexed id, uint256 totalDeposits, uint256 nDeposits, uint256 nRedeems, uint256 fee,
  uint256 potUsed)`, `BatchRolled(id)`, `PayoutsDelivered(bytes32 indexed batchKey, uint32 chunk, uint256 amount,
  address bridge)`, `PayoutReceived(bytes32 indexed batchKey, uint32 chunk, address indexed user, uint256 amount)`,
  `Claimed`, `DeliverySet`, `Delivered(user, taoIn, usdcOut)`, `FeeCredited(user, amount, payer)` (`payer` is
  `msg.sender`), `FeeCreditSpent`; admin: `LimitSet`, `KeeperSet`, `SwapperSet`, `OracleSet`,
  `MaxDeliverySlippageSet`.
- **Vault (Bittensor)** `CascadeVault.sol`: `BatchDelivered(bytes32 indexed key, uint64 indexed sourceChain,
  address indexed frontDoor, uint64 batchId, uint256 amount)`, per deposit entry one of `Deposited(key, user,
  assets, shares)` / `DepositBounced(key, user, assets)` / `DepositSkipped(key, user, assets)`, per redeem entry
  one of `Redeemed(key, user, shares, assets)` / `RedeemDeferred(key, user, requested)` / `RedeemSkipped(key,
  user, requested)`, `PayoutBatchQueued(key, sourceChain, batchId, count, total, price)`,
  `PayoutChunkSent(bytes32 indexed key, uint32 chunk, uint32 taken, uint256 gross, uint256 net, uint256 fee)`,
  `PayoutDust`, `Staked(hotkey, rao, measured)`, `Unstaked(hotkey, wantRao, receivedWei)`, `StakeMoved(from, to,
  rao, moved)`, `RewardsClaimed`, `RewardCutMinted`, and csTAO's ERC-20 `Transfer(from, to, value)` for every
  mint and burn (a delivery receipt shows a mint `Transfer` between `BatchDelivered` and `Deposited`); admin:
  `StakeHotkeySet`, `HotkeyAdded`, `HotkeyRemoved`, `RewardCutSet`, `FrontDoorProposed/Activated/
  ProposalCancelled/Removed`, `KeeperSet`, `ClaimGasSet`, `LimitSet`, `PayoutBatchCancelled`, `RedeemReversed`.
- **Both** (`CascadeBase.sol` and OpenZeppelin): `GuardianSet`, `GuardianProposed`, `GuardianProposalCancelled`,
  `BridgeProposed`, `BridgeActivated`, `BridgeProposalCancelled`, `BridgeDisabled`, `PrimaryBridgeSet`,
  `Paused(account)`, `Unpaused(account)`, `OwnershipTransferStarted`, `OwnershipTransferred`.
- **Staker (Base)** `CascadeStaker.sol`: `Staked(address indexed payer, address indexed beneficiary, uint256
  usdcIn, uint256 fees, uint256 taoDeposited)` (`payer` is `msg.sender`), `Sold`; admin: `RouteSet`,
  `DeliveryRouteSet`, `FeesSet`, `TreasurySet`, `Swept`, ownership events.
- **Adapters (both chains)** `CcipAdapterBase.sol`: `Sent(bytes32 indexed messageId, uint64 destChain, address
  indexed sender, address indexed recipient, uint256 amount, uint256 fee, uint256 gasLimit)` and
  `Delivered(bytes32 indexed messageId, uint64 sourceChain, address indexed sender, address indexed recipient,
  uint256 amount)`; the Bittensor adapter also emits `ReserveFunded(address indexed from, uint256 amount)`. The
  adapters are immutable and ownerless. `send` is open to anyone; the payload carries the real caller as
  `sender`, and a destination adapter accepts only messages from its paired remote adapter. `Delivered` is
  emitted only after the receiving contract accepted the message.
- **Names collide; addresses can too.** On Base the front door and the Base adapter both emit `Delivered`; the
  vault and the staker both emit `Staked`. On the v3 test deployment the staker (Base) and the Bittensor adapter
  share one address on their two chains. Every stored log is therefore keyed by chain, contract and event, never
  by event name alone.
- **Log order inside a transaction.** `_closeBatch` calls the adapter's `send` (which emits `Sent`) and then emits
  `BatchClosed`; `processPayouts` calls `send` and then emits `PayoutChunkSent`. On the receiving side the
  receiver's events (`BatchDelivered` and its outcomes, or `PayoutsDelivered` and its `PayoutReceived`s) come
  before the destination adapter's `Delivered`. **One transaction can carry several messages:** anyone can close
  two batches from a contract in one transaction, `processPayouts` is permissionless and can run for two keys in
  one transaction, and CCIP may execute several messages in one transaction. Pairing goes by log order (6.2).
- **What ties the two sides of a batch together.** The front door builds the message as
  `abi.encode(uint8 1, uint64 batchId, Entry[] deposits, Entry[] redeems)` (`CascadeMessages.encodeBatch`) from
  the open batch's lists, one merged entry per user per list, in slot order (a full cancel moves the last entry
  into the freed slot). The vault names the delivery `key = keccak256(abi.encode(uint64 sourceChain, address
  sender, keccak256(message)))` (`CascadeVault.batchKey`), so the key commits to every byte of the message.
  The review rebuilt the keys of v3-test batches 1 and 2 from Base events alone and matched the vault's
  `BatchDelivered` (`0x07531aa4…39b48c`, `0xc2645240…7fd49c`), and matched the CCIP message ids
  (`0xf42eadb2…`) across the two adapters.
- **What ties the two sides of a payout together.** The vault's payout list for a batch is its
  `DepositBounced` entries (0 shares) then its `Redeemed` entries, each in log order (`ops/src/keeper/payouts.ts`
  `rebuildPayouts`). Chunk `c` takes the next `taken` entries; each entry pays `ceil(assets × fee / gross)` and
  is floored to whole rao; an entry left with 0 is dropped (`PayoutDust`). The message is
  `abi.encode(uint8 2, bytes32 key, uint32 chunk, Entry[] entries)`; the front door records
  `delivered[bridge][keccak256(message)]` (a public view) and emits `PayoutsDelivered` and one `PayoutReceived`
  per entry. A chunk whose `net` is 0 sends no message. The review confirmed `delivered(baseAdapter,
  keccak256(encodePayouts(key, 0, [(user, net)])))` is true for v3-test batch 2 chunk 0 (`net = 77877092e9 −
  1061267e9`).
- **Accounting identities the contracts state.** Front door: the TAO it holds is at least the open batch's
  `totalDeposits` plus `totalClaimable`; the ETH it holds equals the open batch's `feePot` plus
  `totalFeeCredit` (contract header comment). Vault: `totalAssets = rootStake + balance − 1e12 −
  pendingPayouts − unvestedRewards`, floored; the share price is `price()`.
- **Honest rounding moves the price down a little.** A stake can measure 1 rao below what was asked (v3-test:
  `Staked` rao 77877093, measured 77877092); on the tiny test vault the next batch price read 999999987159,
  1.28e-8 below the launch price. Moves, unstakes and payouts have similar measured-versus-asked gaps. A
  price rule must subtract these (6.1).
- `payoutDelay` is 3,600 s on v3-test and 86,400 s in the launch cadence (`ops/src/config.ts`).

### The site's scan (branch `web-hardening`, in review; re-check after merge)

- `VaultScan` (`facts.ts`) holds the vault's `BatchDelivered` from our front door with `sourceChain == 8453`
  (by batch id), every `Staked`, every `PayoutChunkSent` (by key and chunk), and the connected account's own
  `Deposited` and `Redeemed`. It reads one vault-address `eth_getLogs` per 1,000-block window, asking the head in
  the same request and accepting a window only from a server that has reached its end; it re-reads 400 blocks
  (REREAD) and never saves the last 10 (SETTLE).
- `ScanState` v1 (`scan-store.ts`) is the saved and seedable form: `{ v: 1, vault (lowercase), from (deploy
  block), next, delivered[{batchId, key, txHash, block}], staked[{block, txHash}], payouts[{key, chunk, taken,
  txHash, block}], deposited[{key, txHash, block, assets}], redeemed[...] }`, numbers as decimal strings. A state
  for another vault or deploy block, a malformed field or an event outside `[from, next)` is dropped whole.
- **Two halves.** The store saves the deployment's own events once (`cascade.scan.<frontDoor>.<bitBlock>`, the
  account lists empty) and each account's events separately (that key plus the account, the deployment lists
  empty), and resumes from the earlier `next` of the two.
- **What decode already distrusts.** Every delivery and every account event loaded from storage or a seed comes
  in `unconfirmed`. A trail uses a delivery only when its receipt shows the vault's `BatchDelivered` for that
  batch from our front door (`deliveryOf`); what can be unstaked confirms saved deliveries by receipt
  (`checkDeliveries`); amounts wait for `confirmAccountEvents`, which restarts the scan (`HistoryMismatchError`)
  when a receipt from a server well past the block shows the event isn't there. Stakes and payout chunks are not
  marked.

### The keeper's scan (`ops/src/keeper/state.ts` on main)

Windows Base 100 / Bittensor 1,000 blocks; REREAD Base 70 / Bittensor 400; SETTLE Base 30 / Bittensor 10.
A log's identity is `txHash:topics:data#n` (n counts identical logs within one transaction), so a copy re-mined in
another block or at another index after a reorg is the same log. Logs within SETTLE of the head are returned but
not kept. Every Bittensor scan starts at the record's Bittensor adapter block. `readState` already reads the
vault's `payoutDelay` and its pending payout batches.

### RPCs (probed 2026-10-28 from the owner's network)

- `https://mainnet.base.org` answers batched JSON-RPC but answered `eth_getLogs` with `-32011 request limit
  reached`, even for a 10-block window. `https://base-rpc.publicnode.com` answered a batched `[eth_getLogs (100
  blocks), eth_blockNumber]`; the site already reads Base logs there. The owner's working numbers for Base:
  100-block windows, about 200 requests a minute.
- `https://archive.chain.opentensor.ai` answers batched JSON-RPC and 1,000-block log windows (about 128 requests
  a minute); the lite node keeps only minutes of logs.
- Load-balanced endpoints can answer a `latest` read from a node a little behind, so two reads a minute apart can
  go backwards. Cloudflare's egress addresses are shared, so a public RPC's per-address limits may bite harder
  from a Worker (unverified). Every RPC URL is configurable, and a keyed one can be a secret.

### Cloudflare (docs read 2026-10-28)

- **Plans apply to the whole account**: an account is on Workers Free or Workers Paid, for every Worker in it.
- Workers Free: 100,000 requests a day per account (Workers and Pages Functions together; static Pages assets
  are free), 10 ms CPU per invocation (HTTP and cron alike), 50 external subrequests per invocation (1,000 to
  Cloudflare services), 5 cron triggers per account, cron wall time up to 15 minutes. Workers Paid ($5/month):
  no daily request limit, 30 s CPU per cron invocation (under 1-hour interval), 10,000 subrequests, 250 crons.
- D1 Free: 5 M rows read and 100 k rows written a day per account (enforced since 2026-09-01: queries fail until
  midnight UTC), 500 MB per database, 5 GB per account, **50 queries per Worker invocation**, where one
  `db.batch()` counts as one query and runs as one transaction. Paid: 25 billion rows read a month included,
  10 GB per database, 1,000 queries per invocation.
- Email Service: sending to **verified destination addresses** in the account is free on every plan and doesn't
  count toward quotas, from a domain with Email Routing enabled ("you can only send from your routing domains").
  Sending to arbitrary recipients needs Workers Paid and an onboarded sending domain. Workers binding:
  `send_email: [{ name, allowed_sender_addresses? }]`, `env.EMAIL.send({ to, from: { email, name }, subject,
  text, html })`, errors thrown as `E_*` codes.
- Cron: `triggers.crons` in `wrangler.jsonc`, `scheduled(controller, env, ctx)` with `controller.cron`.
  `wrangler dev --test-scheduled` exposes `/cdn-cgi/local/scheduled?cron=…`; Local Explorer (wrangler ≥ 4.139)
  can fire configured crons.
- Testing: `@cloudflare/vitest-plugin` (renamed from `@cloudflare/vitest-pool-workers` in 2026-08), `cloudflareTest()`
  per vitest project, `readD1Migrations` / `applyD1Migrations`, `createScheduledController`,
  `createExecutionContext`. Version 1.4.2 pins wrangler 4.151.0 (its miniflare is a `-beta` build) and supports
  vitest ^5. Tests run inside workerd, which has no filesystem. `fetchMock` is gone; tests inject their own fetch.
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
 site (browser) ── GET /v1/scan/{vault}, /v1/scan/{vault}/{account} ──┐
 keeper, people ── GET /v1/status, /v1/health ────────────────────────┤
                                                                      ▼
                  ┌──────────── Worker cascade-indexer ────────────┐
                  │ fetch():      four read-only routes            │
                  │ scheduled():  * * * * *    tick                │───▶ D1: logs, cursors, readings,
                  │               17 * * * *   hourly              │         hours, checks, alerts, holds
                  │               0 13 * * *   daily digest        │
                  └───────┬────────────────┬────────────────┬──────┘
                          ▼                ▼                ▼
          Base and Bittensor RPCs    price APIs and     send_email ──▶ owner's inbox
          (logs, Multicall3)         cascade.fi's JS
```

- **One Worker, `cascade-indexer`**, two handlers. `fetch` serves four read-only routes and nothing else
  (section 4). `scheduled` dispatches on `controller.cron`; a test checks that the crons in `wrangler.jsonc` and
  the dispatch table match. *call*: three crons per environment: the **tick** every minute, an **hourly** job at
  minute 17 (hourly aggregates, pruning, the site check's new pass, the watchdog), and the **daily digest** at
  13:00 UTC (sent once per UTC day, whatever retries happen). Each runs in its own invocation with its own
  subrequest and CPU budget.
- **One D1 database** per environment (`test` for the v3 test deployment, `production` later). Two
  environments on one Free account would need six crons, over the five allowed (section 11).
- **No keys.** The Worker reads public chain data, writes only its own D1, and sends email to verified
  addresses. It never builds or sends a transaction (a test fails if transaction-sending methods appear in
  `src/`).
- **A tick** (*call*), in order; every external fetch spends the tick's subrequest budget (section 3.6):
  1. take the lease row (`UPDATE lease … WHERE until < now`); skip the tick if another holds it;
  2. load cursors, open alerts, holds, the last readings, the last 25 hourly rows, the watched addresses, the
     messages and `delivered(...)` reads still pending, and the recent payout users in one `db.batch()`;
  3. load the uids already stored in each chain's REREAD range (one query for both chains);
  4. scan Bittensor, then Base, forward from their cursors (section 3), within the subrequest and decode budgets;
  5. fetch block times and the transactions behind attributable events found this tick;
  6. read both chains' state: one Multicall3 `aggregate3` per chain, which includes the block number it was
     read at, plus one batched nonce request per chain;
  7. prefetch, in one `db.batch()`, every stored log and check row the rules will read;
  8. run the rules; reconcile alerts; work out holds and which emails are due;
  9. **commit 1**, one `db.batch()` guarded by the lease (it fails whole if the lease is no longer this tick's,
     section 2): logs, cursors, seed pages, blocks, txs, the reading, hourly running values, messages, checks,
     alerts, holds, `meta.last_complete_tick`;
  10. send the due emails;
  11. **commit 2**, a small batch: mark the sent alerts notified, release the lease.
  An email is sent only after the alert behind it is committed, so a commit that keeps failing can't flood the
  inbox. If commit 1 fails, the tick sends no alert emails; instead, only when the tick's scheduled minute is 0
  (stateless, so at most hourly), it sends one `monitor.db_failing` email straight from memory. A failing rule
  or read is caught and recorded; it never stops the other rules.
- **Watchdog** (*call*): the hourly and daily jobs read `meta.last_complete_tick` and raise the critical
  `monitor.stalled` when it is more than 15 minutes old: a tick killed for CPU commits nothing, so only another
  job can notice. A tick killed the same way every time (a deterministic overrun) is what this catches.

### 2. The D1 schema

Migration `indexer/migrations/0001_init.sql` (*call*: addresses and hashes lowercase hex; amounts as decimal
text; times as unix seconds):

```sql
-- key/value facts: schema version, deployment id, last tick times, digest date, site-check progress
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- one row per chain: how far the scan has read and what is stored
CREATE TABLE cursors (
  chain        TEXT PRIMARY KEY CHECK (chain IN ('base','bittensor')),
  from_block   INTEGER NOT NULL,   -- the deployment's first block on this chain
  scanned_to   INTEGER,            -- the last head fully read (null before the first window)
  settled_to   INTEGER NOT NULL,   -- every log in [from_block, settled_to] is stored (from_block − 1 at first)
  settled_time INTEGER,            -- block time of settled_to
  head_time    INTEGER,            -- block time of the head when settled_to was last moved (for the lag)
  updated_at   INTEGER NOT NULL
);

-- every log of the watched contracts, stored once it is SETTLE blocks deep
CREATE TABLE logs (
  uid       TEXT PRIMARY KEY,      -- keccak256(chain ':' txHash ':' topics ':' data '#' n): the keeper's identity
  chain     TEXT NOT NULL,
  contract  TEXT NOT NULL,         -- role: 'vault' | 'bitAdapter' | 'frontDoor' | 'baseAdapter' | 'staker'
  address   TEXT NOT NULL,
  block     INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  tx_hash   TEXT NOT NULL,
  event     TEXT NOT NULL,         -- decoded name ('BatchDelivered'), or 'unknown'
  topic1    TEXT, topic2 TEXT, topic3 TEXT,
  data      TEXT NOT NULL,
  args      TEXT NOT NULL,         -- decoded arguments as JSON, integers as decimal strings
  removed   INTEGER NOT NULL DEFAULT 0  -- 1 while a later read of its block no longer has it (reorg)
);
CREATE INDEX logs_by_event ON logs(chain, contract, event, block);
CREATE INDEX logs_by_topic2 ON logs(contract, event, topic2);  -- Deposited/Redeemed/PayoutReceived by user
CREATE INDEX logs_by_tx ON logs(chain, tx_hash, log_index);

CREATE TABLE blocks (chain TEXT NOT NULL, number INTEGER NOT NULL, time INTEGER NOT NULL,
                     PRIMARY KEY (chain, number));     -- times of blocks that hold stored logs

CREATE TABLE txs (                                      -- senders of attributable transactions
  chain TEXT NOT NULL, hash TEXT NOT NULL, from_addr TEXT NOT NULL, to_addr TEXT,
  selector TEXT, nonce INTEGER, PRIMARY KEY (chain, hash));  -- to/selector/nonce null when known from args
CREATE INDEX txs_by_from ON txs(chain, from_addr);

-- the deployment-wide half of the seed, pre-built: pages of up to 500 events in block order
CREATE TABLE seed_pages (page INTEGER PRIMARY KEY, first_block INTEGER NOT NULL,
                         last_block INTEGER NOT NULL, count INTEGER NOT NULL, json TEXT NOT NULL);

-- the last 120 per-tick readings of both chains' state (pruned every hour)
CREATE TABLE readings (at INTEGER PRIMARY KEY, base_block INTEGER, bit_block INTEGER, json TEXT NOT NULL);

-- one row per hour of running aggregates (highest price, stakes, pool depth, supply, rewards, spot prices),
-- updated by each tick, read by rules that look back a day or a week; pruned after 35 days
CREATE TABLE hours (hour INTEGER PRIMARY KEY, json TEXT NOT NULL);

-- bridge messages our contracts sent, and what became of them
CREATE TABLE messages (
  message_id TEXT PRIMARY KEY, direction TEXT NOT NULL,  -- 'base>bittensor' | 'bittensor>base'
  sender TEXT NOT NULL, recipient TEXT NOT NULL, amount TEXT NOT NULL,
  src_tx TEXT NOT NULL, src_block INTEGER NOT NULL, src_time INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'UNTOUCHED', state_at INTEGER,
  dst_tx TEXT, dst_block INTEGER);                       -- set from the destination adapter's Delivered

-- the cross-check, one row per batch and per payout chunk
CREATE TABLE batch_checks (batch_id INTEGER PRIMARY KEY, closed_tx TEXT, message_id TEXT,
  expected_key TEXT, delivered_key TEXT, delivered_tx TEXT,
  status TEXT NOT NULL,              -- 'waiting' | 'ok' | 'mismatch'
  detail TEXT);
CREATE INDEX batch_checks_by_key ON batch_checks(delivered_key);
CREATE TABLE chunk_checks (batch_key TEXT NOT NULL, chunk INTEGER NOT NULL, sent_tx TEXT, message_id TEXT,
  expected_hash TEXT, landed_tx TEXT, landed_block INTEGER,
  status TEXT NOT NULL,              -- 'waiting' | 'awaiting_read' | 'ok' | 'mismatch'
  detail TEXT, PRIMARY KEY (batch_key, chunk));

-- watched addresses' transaction counts (or a Safe's nonce): compared with the transactions seen in our logs
CREATE TABLE nonces (chain TEXT NOT NULL, address TEXT NOT NULL, roles TEXT NOT NULL, baseline INTEGER NOT NULL,
  nonce INTEGER NOT NULL, changed_at INTEGER NOT NULL, PRIMARY KEY (chain, address));

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY, alert_key TEXT NOT NULL, rule TEXT NOT NULL,
  tier TEXT NOT NULL, kind TEXT NOT NULL,           -- 'critical'|'warning'; 'condition'|'event'
  subject TEXT NOT NULL, body TEXT NOT NULL, runbook TEXT NOT NULL,
  opened_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, resolved_at INTEGER,
  notified_at INTEGER, notify_count INTEGER NOT NULL DEFAULT 0, acknowledged_at INTEGER);
CREATE UNIQUE INDEX alerts_open ON alerts(alert_key) WHERE resolved_at IS NULL;

CREATE TABLE holds (id TEXT PRIMARY KEY, rule TEXT NOT NULL, summary TEXT NOT NULL,
  raised_at INTEGER NOT NULL, cleared_at INTEGER, cleared_note TEXT);

CREATE TABLE lease (name TEXT PRIMARY KEY, holder TEXT NOT NULL, until INTEGER NOT NULL);
-- the commit's first statement inserts 1 here unless this tick still holds the lease; the CHECK then fails the
-- whole batch, so a tick whose lease expired can never commit over a newer one
CREATE TABLE guard (x INTEGER CHECK (x = 0));
```

The guard statement is `INSERT INTO guard (x) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM lease WHERE name =
'tick' AND holder = ?1 AND until > ?2)`: it inserts nothing while the lease is ours, and fails the batch (as a
transaction) when it isn't. Logs are written with an upsert: `INSERT … ON CONFLICT (uid) DO UPDATE SET removed =
0, block = excluded.block, log_index = excluded.log_index`, so a log marked removed by a reorg and re-mined in
a later block comes back.

Size: a stored log is under 1 KB; at 100 stakes a day (about 6 logs each, with csTAO transfers) that is about
200 MB a year, inside the free 500 MB per database for about two years; `readings` holds 120 rows and `hours`
35 days. Logs are kept for good: the seed and the cross-check replay need them.

### 3. Scanning

#### 3.1 What is read

| Chain | Addresses in one `eth_getLogs` (address array, no topic filter) | Window | REREAD | SETTLE |
|---|---|---|---|---|
| Bittensor | vault, Bittensor adapter | 1,000 blocks | 400 | 10 |
| Base | front door, Base adapter, staker | 100 blocks (configurable) | 70 | 30 |

The numbers are the keeper's (*call*: mirror them exactly, so the two never disagree about what "settled"
means). The Base window is configurable because the probed public endpoints differ; with a 2,000-block logs
endpoint, backfill is 20 times faster. The FM-TAO token and the Uniswap pools are not scanned (too busy); the
monitor reads their state instead. Each log is tagged with its contract's role from the address it came from on
its chain.

#### 3.2 The algorithm (per chain, per tick)

```
stored      = uids of stored logs in [start, scanned_to] (loaded in step 3, one query for both chains)
start       = scanned_to === null ? from_block : max(from_block, scanned_to + 1 − REREAD)
for each window [a, b] from start (b ≤ head), while the subrequest and decode budgets last:
    [logs, serverHead] = one JSON-RPC batch: eth_getLogs(addresses, a, b), eth_blockNumber
    if serverHead < b: retry once; still behind → stop this chain for this tick (cursor stays at a − 1)
    identify every log: uid = keccak(chain:txHash:topics:data#n), n counting identical logs in one tx
    settled = logs with block ≤ head − SETTLE
    stage an upsert for each settled log (decoded, role-tagged, args as JSON; clears removed)
    vanished check: each uid in `stored` with block in [a, min(b, head − SETTLE)] missing from this read
                    is staged removed = 1, and raises the indexer.reorg warning
    scanned_to = b
settled_to = min(scanned_to, head − SETTLE)   (only ever moves forward)
```

- A window is accepted only from a server that has reached its end (*call*: logs and head travel in one batched
  request to one server, as the site's `windowLogs` does). A node that is behind answers "no logs" for blocks
  it hasn't seen; that must never count as none.
- A failed or refused window stops that chain for the tick without moving the cursor past the last whole window,
  so nothing is skipped; the next tick resumes there.
- Reorgs: logs are stored only SETTLE blocks deep, re-reads cover REREAD blocks, and the identity ignores block
  number and index, so a transaction re-mined elsewhere is not stored twice. A stored log missing from a later
  read of its own block is marked `removed`, left out of the seed and the rules, and reported; if it is re-mined
  later, the upsert brings it back with its new block. Either change rebuilds the seed pages.
- Only the REREAD range can hold stored logs that a window re-reads, so the vanished check needs one uid query
  per tick, not one per window (backfill windows beyond `scanned_to` have nothing stored).
- Decoding: each log is decoded against the ABI of its contract; an undecodable log is stored as `unknown` and
  raises the `vault.events` warning.
- Backfill: a new database starts every chain at the deployment's first block (*call*: Bittensor from the
  record's Bittensor adapter block, exactly the site's `bitBlock`, so the seed's `from` matches; Base from the
  record's Base adapter block). Bittensor is caught up first, since the API depends on it. A year of Bittensor
  is about 2,600 windows. Until both chains are within an hour of their heads the monitor runs only the rules
  whose data is complete, the cross-checks wait, and the digest says "catching up".

#### 3.3 Block times and transactions

Rules work on chain time. For every block that holds a newly stored log, the tick fetches its header (one batched
request per chain) and stores the time. For events that only a few addresses can cause or that admin actions
emit (front door `BatchClosed`, `BatchRolled`, `Delivered`; vault `PayoutChunkSent`, `Staked`, `RewardsClaimed`,
`HotkeyAdded`; and every admin event), it fetches the transaction (`from`, `to`, selector, nonce) into `txs`.
Events whose arguments name the caller (`msg.sender`) are recorded without a fetch: the front door's
`DepositRequested.payer`, `FeeCredited.payer`, and the `user` of `RedeemRequested`, `RedeemCancelled`,
`DepositCancelled`, `Claimed` and `DeliverySet`; the staker's `Staked.payer`; the Bittensor adapter's
`ReserveFunded.from`. (For an externally owned account `msg.sender` is the transaction's sender; when a contract
in between is the caller, it is that contract, which isn't watched.) `keys.unexplained_tx` counts a watched
address's distinct transactions in `txs`.

#### 3.4 Seed pages

In the same commit that moves Bittensor's `settled_to`, the tick appends the newly settled deployment-wide seed
events (our front door's `BatchDelivered` with `sourceChain == 8453`, every vault `Staked`, every
`PayoutChunkSent`) to the last `seed_pages` row, opening a new page every 500 events. The shared half of the
seed (section 4) is these pages, so serving it reads one row per 500 events, and it is cached for everyone.

#### 3.5 RPC client

One choke point (`src/rpc.ts`), as in `ops/src/rpc.ts`: JSON-RPC over `fetch`, batched requests, a minimum
spacing per chain (Base 300 ms ≈ 200 a minute; Bittensor 500 ms), HTTP 429 retried with backoff while wall time
allows, RPC URLs redacted from every error and log line. Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`,
on both chains) carries every `eth_call` of a tick in one `aggregate3` with `allowFailure: true`, and always
includes its own `getBlockNumber()` and `getCurrentBlockTimestamp()`, so every reading knows the block it came
from (section 6, "Readings").

#### 3.6 Budgets

*call*: every external `fetch` spends a per-invocation counter (45 of the free plan's 50; configurable); the
tick stops scanning when 5 are left, so the state reads, the rules and the emails always run. A steady tick
needs about 10: one window per chain (logs and head together), one multicall per chain, one nonce batch per
chain, one block-time batch per chain, the odd transaction lookup, the price references every fifth minute, and
up to two files of the site check. A second budget caps the logs decoded per tick (default 300), so a backfill
over a busy stretch can't overrun the CPU limit: the tick finishes the window it is in and stops.

D1 work stays at about 6 queries per tick (each `db.batch()` counts once): the load, the uid query, the
prefetch, the lease and the two commits. Rows read stay small: rules that look back a day or a week read the
`hours` table (25 or 170 rows), not per-minute readings; the prefetch reads only what this tick's rules need.
Task tests assert both counts.

### 4. The API

Four routes, all `GET` (and `OPTIONS` for CORS preflight); anything else is 404 or 405. No route writes.

**`GET /v1/scan/{vault}`** — the deployment-wide half of the seed, in exactly the form the site's store saves it:
`ScanState` v1 with `deposited` and `redeemed` empty.

**`GET /v1/scan/{vault}/{account}`** — the account's half: `ScanState` v1 with `delivered`, `staked` and
`payouts` empty, and the account's `Deposited` and `Redeemed`.

```json
{
  "v": 1,
  "vault": "0x…",
  "from": "9368744",
  "next": "9402131",
  "delivered": [{ "batchId": "3", "key": "0x…", "txHash": "0x…", "block": "9371002" }],
  "staked":    [{ "block": "9371040", "txHash": "0x…" }],
  "payouts":   [{ "key": "0x…", "chunk": 0, "taken": 1, "txHash": "0x…", "block": "9372950" }],
  "deposited": [],
  "redeemed":  []
}
```

- *call*: two halves instead of one combined state, because they match the site's store exactly, and because
  the shared half is one URL for every visitor (one cached response, one page read per 500 events), while an
  account half reads only that account's rows through an index (a few rows, or none).
- `vault` must be the configured vault (any case), else 404; `account` must be 40 hex digits, else 400.
- Both halves of one tick carry the same `next = settled_to + 1` of Bittensor; every event has
  `from ≤ block < next` and comes from a stored, not removed log. The account half matches `topic2` (the account
  left-padded to 32 bytes; `user` is the second indexed argument of both events) on the vault's `Deposited` and
  `Redeemed`, read in the same `db.batch()` as the cursor.
- Headers: `Content-Type: application/json`, `Cache-Control: public, max-age=30`,
  `Access-Control-Allow-Origin: <SITE_ORIGIN>` (one fixed origin, *call*: a constant header keeps cached
  responses valid for every caller; CORS here is not a security boundary, the data is public),
  `Cascade-Settled-Time: <unix>` (exposed via `Access-Control-Expose-Headers`).
- 503 with `Retry-After: 60` until the first Bittensor window is stored, or when a D1 read fails (the site then
  falls back).

**`GET /v1/status`** — the hold, the per-batch confirmations and the monitor's sight, for the keeper (section 8).
`Cache-Control: no-store`. It carries hold ids but no summaries and no alert details: the reasons go only to the
owner's email (*call*, so an attacker reading it learns no more than "a hold is on").

**`GET /v1/health`** — `200 ok` while the last complete tick is under 5 minutes old, else `503`;
`Cache-Control: no-store` (Workers Cache is on). For an outside uptime checker (open question 9).

### 5. How the site verifies, and how it falls back

The site work is its own tasks, after `web-hardening` merges, and is **to be re-checked against its merged
shape** (it is in review). With `NEXT_PUBLIC_CASCADE_INDEXER_URL` unset, nothing changes.

1. **When to ask.** In `scanFor(account)`, after loading the saved halves: if the chain head is more than 14,400
   blocks (2 days) past `scan.next` and the indexer isn't distrusted, fetch both halves in parallel with a
   5-second timeout. A timeout, network error, non-200, invalid JSON, or a half that `decode` rejects mean "no
   seed": the scan goes on from the browser's own state, exactly as today.
2. **Seeding.** The halves are merged as the store merges saved halves (the earlier `next` wins), through the
   same function, so seeded and saved history follow one path. `decode` already marks seeded deliveries and
   account events `unconfirmed`. The account's half is saved with an optional `seeded: true` (older saved halves
   without it load as before), cleared once the account's history is verified (step 5).
3. **Deliveries, stakes and chunks are confirmed on use.** A trail already uses a delivery only when its receipt
   shows the vault's `BatchDelivered` for that batch (`deliveryOf`). *call*: stakes and payout chunks get the
   same treatment wherever they come from (seed, storage or the browser's own scan), instead of persisted marks:
   the "first stake after a delivery" counts only if its receipt shows the vault's `Staked`, and a key's chunks
   count, for mapping an entry to its chunk, only if each one's receipt shows `PayoutChunkSent` with that key,
   chunk and `taken`. Receipts are cached for the visit. A receipt that contradicts an entry, from a server well
   past its block (`receiptAt`'s rule), discards the shared half (the scan restarts from the deploy block) and,
   if the scan was seeded, distrusts the indexer for 24 hours in this browser.
4. **Amounts.** The account's `Deposited`/`Redeemed` are confirmed by `confirmAccountEvents` before anything sums
   them, as today; it now also keeps each event's `shares`.
5. **Completeness, stated honestly.** Receipts prove an event exists, not that none was left out. A seed could
   omit a matched set of the account's events (a deposit, its full redeem, a later deposit) and still add up.
   So: *call*:
   - A **tripwire** runs once a seeded scan reaches the head: `Σ Deposited.shares − Σ Redeemed.shares` must equal
     `balanceOf(account)` at block `scan.next − 1` (one archive `eth_call`; csTAO is non-transferable). A
     mismatch (an omission, or a rarer mint path such as a direct deposit) discards the seed and distrusts the
     indexer. It catches crude omissions cheaply; it does not prove completeness.
   - **"Rewards earned" is marked provisional** ("checking…") while the account's half is `seeded`, and a
     background check reads the account's own `Deposited` and `Redeemed` from the deploy block to the seed's
     `next` (topic-filtered by user, resumable across visits). When it matches the seeded events exactly,
     `seeded` is cleared and the figure is final; when it doesn't, the seed is discarded and the indexer
     distrusted. Everything else (the trail, the lists) shows at once.
6. **Omitted deliveries.** A record whose batch closed more than 2 hours before the seed's `next` with no
   delivery in the scan is looked up directly: the site reads the Bittensor windows from the close time to
   `next`; a delivery found there means the seed lied (discard and distrust).
7. **What never comes from the indexer:** balances, share price, limits, quotes, claimable amounts, anything
   passed to a wallet. Those remain direct reads, as today.

### 6. The monitor's rules

Conventions:

- **Chain clocks.** Times in conditions are block times (`blocks.time`, or the reading's block time); the
  Worker's clock only schedules work.
- **Readings.** Each tick stores one reading of both chains (one Multicall3 per chain, each with the block it was
  read at): vault `price`, `totalAssets`, `totalSupply`, `rootStakeRao`, `pendingPayouts`, `paused`, `owner`,
  `pendingOwner`, `guardian`, `pendingGuardian`, `keeper`, `stakeHotkey`, the hotkey set, `getStake` per set
  hotkey, the vault's balance, `payoutDelay`, outflow settings and the front door's `burnWindows` entry,
  `lastClaimAt` and unclaimed rewards on the stake hotkey; the front door's `openBatch`, `totalClaimable`,
  `totalFeeCredit`, `netForwarded`, `depositCap`, `maxBatchValue`, `maxDeposits`, `maxRedeems`,
  `batchInterval`, `paused`, `owner`, `guardian`, `keeper`, and `claimable` and `deliveryOf` for each user with
  a `PayoutReceived` in the last 7 days not yet claimed or delivered (at most 50); TAO `balanceOf(frontDoor)` and
  the front door's ETH balance; FM-TAO `totalSupply` on Base and the lock pool's FM-TAO balance on Bittensor;
  both pools' `slot0` and `liquidity`, the TAO held by the TAO/WETH pool, the oracle's `usdcValue(1e18)`; keeper
  balances; the Bittensor adapter's balance; AlphaVault `isPaused`, `migrationReadyAt`, `migrationFinished`; the
  OffRamp execution state of every message not yet settled; `nonce()` for a watched owner that is a Safe; and the
  `delivered(...)` reads the payout checks are waiting for. Each chain's nonces come from one batched
  `eth_getTransactionCount` request.
- **Readings only move forward.** A chain's reading whose block isn't newer than the last stored one (a lagging
  node behind `latest`) is dropped for this tick; rules over that chain's readings skip it. Five ticks in a row
  without a usable reading raise `monitor.chain_unreadable`.
- **Settled evaluation.** A rule over logs runs only on ranges both chains have settled; a cross-chain rule waits
  until the other chain's settled time has passed the event's time (section 6.2).
- **Debounce.** Rules over readings that one bad answer could trip need two consecutive readings with
  increasing blocks (marked "×2"); log-based rules fire at once.
- **Alert keys and kinds.** Each finding has a stable key (rule plus its subject, e.g. `bridge.batch:42`), so a
  condition that persists is one alert, not one per tick. A rule is either a *condition* (a state that holds or
  not: solvency, lag, a low balance; the alert resolves when the state clears) or an *event* (something that
  happened: an admin log, a bounced deposit, a price drop, a cross-check result; the alert stays open until it is
  acknowledged, or closes quietly after 7 days, and never sends a "resolved" email).
- **Muted while held.** `batch.past_max_wait` and `payout.overdue` stay quiet while a hold is on: the keeper is
  holding on purpose.
- **Lag limits follow the payout delay.** `lagLimit = min(30 min, payoutDelay / 4)`, with `payoutDelay` read on
  chain each tick (15 minutes on v3-test, 30 at launch). The keeper uses the same formula (section 8).
- **Baseline.** Events in the deployment's own setup transactions (blocks up to the record's last deploy step on
  each chain) are the baseline, not alerts.

Thresholds are defaults in `src/thresholds.ts`, overridable through the `THRESHOLDS` variable or, so that
production values needn't be public, a `THRESHOLDS` secret (which wins). *call*: every number below is in one
place.

#### 6.1 Critical

| ID | Condition (fires when) | Data | Default | Hold | What to do (runbook line) |
|---|---|---|---|---|---|
| `price.drop` | vault `price()` fell between two readings (increasing blocks) by more than the rounding the vault's own events in that block range explain (asked minus measured, in wei: `Staked` (rao − measured) × 1e9, `StakeMoved` (rao − moved) × 1e9, `Unstaked` wantRao × 1e9 − receivedWei when positive, and the `PayoutChunkSent` rounding `gross − net − fee`), converted to a price change at the reading's supply, plus 1e-12 of the price; and the next reading confirms it (×2) | readings, logs | 1e-12 | if ≥ 10 bps below the highest price of the last 24 h (`hours`) | Find the cause before anything else moves (stake hotkey and the vault's stake on taostats). If stake left the hotkey set or the drop is unexplained, guardian: `pause()` the vault so no batch is priced low; re-add a swapped hotkey with `addHotkey`. |
| `stake.unexplained_drop` | for a hotkey in the set, `getStake(h, vaultColdkey, 0)` fell by more than 1,000 rao between two readings, with no vault `Unstaked`, `StakeMoved` or `HotkeyRemoved` log in that block range (evaluated once Bittensor settled past the later reading) | readings, logs | 1,000 rao | yes | Stake left the vault without a vault action: look up the hotkey on taostats (swap, slash, chain change). Guardian: pause the vault until it is explained. |
| `stake.hotkey_changed` | the vault's `stakeHotkey` or hotkey set differs from the last reading; or the hotkey's owner in SubtensorModule `Owner` (storage-query precompile `0x…0807`, as `web/src/lib/cascade/apy.ts` reads `BasketTwr`) changed or vanished ×2 | readings | — | yes when the owner vanished | A hotkey change the owner didn't make means a validator-side swap: re-add the new hotkey with `addHotkey` (owner, guardian or keeper) and check the price. |
| `admin.event` | any admin event (list in Facts) from the vault, front door or staker after the baseline | logs, txs | — | no | Name the sender. If it was a planned change, acknowledge. If not: guardian `pause()` both contracts now, then rotate keys. |
| `keys.unexplained_tx` | a watched address holding the owner, pending-owner or guardian role (read every tick) sent more transactions than its transactions seen in Cascade's logs (section 3.3), still so 15 minutes later. For an owner that is a Safe, its `nonce()` counts instead of the account's transaction count | nonce batch, txs | 15 min | no | A transaction left a Cascade admin key that didn't touch Cascade (or reverted). Open the address on the explorer (link). If it isn't yours, treat the key as compromised: guardian pause, rotate. The rule is quiet only while these keys are used for Cascade alone; acknowledge your own other transactions. |
| `frontdoor.solvency` | TAO `balanceOf(frontDoor)` < `openBatch.totalDeposits + totalClaimable`, or the front door's ETH < `openBatch.feePot + totalFeeCredit`, in one block ×2 | readings | — | yes | The front door holds less than it owes. Guardian: `pause()` the front door (claims and cancels still work); find the transfer that broke the identity. |
| `vault.solvency` | `rootStakeRao × 1e9 + balance(vault) < pendingPayouts + 1e12` ×2 | readings | — | yes | The vault can't cover its queued payouts. Guardian: pause the vault; do not process payouts. |
| `ccip.failure` | the destination OffRamp's `getExecutionState(messageId)` is `FAILURE` for a message our front door or vault sent, and the destination adapter has no `Delivered` for it | messages, readings, logs | — | no | The message and its tokens wait in CCIP. Open it on ccip.chain.link (link) and note the reason; it can be executed again by hand once the cause is fixed. Don't pause anything else for this alone. |
| `ccip.unexpected_source` | an adapter `Delivered` into the vault or front door whose `sender` isn't that contract's registered peer (front door → vault, vault → front door) | logs | — | yes | A Cascade contract accepted a message from an unexpected sender. Treat it as a forgery: the steps of `bridge.batch_mismatch` (vault side) or `bridge.payout_mismatch` (Base side). |
| `deposits.bounced` | any `DepositBounced` | logs | — | no | The vault read itself as insolvent and returned the deposits. Find out why (price, stake) before the next batch; process the bounced payout, never cancel it. |
| `fmtao.unbacked` | FM-TAO `totalSupply` on Base exceeds the Bittensor lock pool's FM-TAO balance by more than 0.01 TAO ×2 | readings | 0.01 TAO | no | TAO on Base isn't fully backed. Guardian: pause the front door (stops new batches and deliveries); tell ForeverMoney and Chainlink; hold payouts until it is explained. |
| `fmtao.depeg` | the TAO/WETH pool's TAO price in USD (from both pools' `slot0`) differs from the reference TAO price by more than 5%, on two readings 5 minutes apart | readings, price APIs | 5% | no | TAO on Base trades away from TAO. Guardian: pause the front door if it persists; deliveries' floors stop sales into a crashed pool. |
| `bridge.batch_mismatch` | a delivery fails the batch cross-check (6.2) | logs, D1 | — | yes | Possible forged batch. Guardian: `pause()` the vault now. Owner: `cancelPayoutBatch(key, payouts)` before **{deadline UTC}** (queued time + `payoutDelay`), with the list rebuilt from the vault's events for this key. Keep the hold until the cancel lands. |
| `bridge.payout_mismatch` | a payout landing on Base fails the payout cross-check (6.2) | logs, D1 | — | yes | Possible forged payout: TAO was minted on Base for it. Guardian: `pause()` the front door (deliveries stop; claims can't be stopped); tell ForeverMoney and Chainlink; keep the hold. |
| `bridge.duplicate` | a second `BatchDelivered` for one batch id from our front door, or a second `PayoutsDelivered` for one (key, chunk) | logs | — | yes | One message delivered twice under different content. As `bridge.batch_mismatch` (vault side) or `bridge.payout_mismatch` (Base side). |
| `site.integrity` | a pass over the live site's scripts found a configured Cascade address missing, or an address or host not on the approved lists (6.6) | site check | — | no | The site may be tampered with. Take it down (Pages: roll back or disable the project), then check DNS, the build and the Pages project. |
| `indexer.blind` | a chain's settled time more than `max(2 × lagLimit, 30 min)` behind its head | cursors | derived | no (the keeper holds on lag itself) | The monitor can't see a chain and the keeper is holding: fix the RPC (quota, outage, switch URLs). |
| `monitor.stalled` | (hourly and daily jobs) `meta.last_complete_tick` more than 15 minutes old | meta | 15 min | no (the keeper holds on a stale status) | Ticks aren't completing (likely the CPU limit): check Workers Observability for the error; the keeper is holding. |
| `monitor.db_failing` | commit 1 failed; sent only at minute 0, straight from memory | the tick | — | no | The monitor can't write its database (D1 limit or error): check the D1 dashboard; the keeper is holding once the status goes stale. |

#### 6.2 The bridge cross-check

**Pairing by log order** (*call*, since one transaction can carry several messages). Within a transaction's
logs, in log-index order: each front door `BatchClosed` pairs with the nearest earlier Base adapter `Sent` from
the front door not already paired; each vault `PayoutChunkSent` with `net > 0` pairs with the nearest earlier
Bittensor adapter `Sent` from the vault, after the previous `PayoutChunkSent`. On the receiving side each vault
`BatchDelivered` opens a group that holds the vault's outcome events with its key until the first Bittensor
adapter `Delivered` to the vault after it, which closes the group; each front door `PayoutsDelivered` does the
same with its `PayoutReceived`s, filtered by (batch key, chunk), until the first Base adapter `Delivered` to the
front door after it.

**Batches, Base → Bittensor.** For each stored vault `BatchDelivered(key, sourceChain, frontDoor, batchId,
amount)`, once Base has settled past its block time:

1. `sourceChain == 8453` and `frontDoor` is ours (else `ccip.unexpected_source`).
2. Exactly one `BatchClosed(id = batchId)` from our front door exists, with `totalDeposits == amount`.
3. The delivery's group holds exactly `nDeposits` deposit outcomes (`Deposited`, `DepositBounced`,
   `DepositSkipped` with this key) and `nRedeems` redeem outcomes (`Redeemed`, `RedeemDeferred`,
   `RedeemSkipped`).
4. The group's adapter `Delivered` has the same `messageId` as the `Sent` paired with the `BatchClosed`, and both
   name front door → vault with `amount == totalDeposits`.
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
is the same: stop and look. The result is stored in `batch_checks` (`ok`, `waiting`, `mismatch`), so each batch
is checked once; `ok` keys are what the keeper needs before paying out (section 8).

**Payouts, Bittensor → Base.** For each stored front door `PayoutsDelivered(batchKey, chunk, amount, bridge)`,
once Bittensor has settled past its block time:

1. `bridge` is in the configured set of our Base bridges (`BRIDGES`, the Base adapter by default; a legitimately
   activated second bridge is added there, and its activation is an `admin.event` anyway).
2. Exactly one vault `PayoutChunkSent(key = batchKey, chunk)` exists, with `net == amount` and `net > 0`.
3. The group's adapter `Delivered` has the `messageId` of the `Sent` paired with that `PayoutChunkSent`, both
   naming vault → front door.
4. The group's `PayoutReceived` list (filtered by key and chunk) equals the chunk's entries recomputed from the
   vault: the batch's payout list (`DepositBounced` then `Redeemed` for the key, in log order of its delivery),
   entries `[cursor, cursor + taken)` where `cursor` sums the earlier chunks' `taken`, each paid
   `floor_rao(assets − ceil(assets × fee / gross))`, zeros dropped.
5. `frontDoor.delivered(bridge, keccak256(encodePayouts(batchKey, chunk, entries)))` reads true in a later
   tick's multicall, counted only from a reading at or after the landing block (a node behind the landing would
   answer false for an honest chunk). Until then the check is `awaiting_read`.

**Timeliness (warnings).** A message our contracts sent that hasn't arrived (no destination adapter `Delivered`,
OffRamp state not `SUCCESS`) 60 minutes after its source block time is `ccip.undelivered` (6.3).

**Why the timing rules matter.** Base is read 30 blocks (a minute) behind its head and Bittensor 10 blocks (two
minutes); a delivery is about 20 minutes behind its close. Waiting for the other chain's settled time to pass the
event's time means an honest batch is never judged before its Base side is stored. A forged one is judged within
a few minutes of arriving, far inside `payoutDelay`; and if the monitor can't see a chain, the batch stays
`waiting`, so the keeper, which pays only `ok` keys and holds on lag, doesn't pay it either.

#### 6.3 Warning

| ID | Condition | Data | Default | What to do |
|---|---|---|---|---|
| `ccip.undelivered` | a message our contracts sent has no destination adapter `Delivered` and no `SUCCESS` state 60 min after its source block time | messages, logs | 60 min | Check it on ccip.chain.link; lanes are sometimes slow. If it stays stuck for hours, raise it with Chainlink. |
| `ccip.foreign_send` | an adapter `Sent` whose `sender` isn't the front door or the vault and whose `recipient` is a Cascade contract | logs | — | Someone sent a message through our adapter at a Cascade contract; the contract will refuse it (its execution should end in `FAILURE`). Nothing to do unless it is delivered (then `ccip.unexpected_source` fires). |
| `keys.keeper_unexplained_tx` | as `keys.unexplained_tx`, for an address that holds only the keeper role | nonce batch, txs | 15 min | Usually a keeper call that reverted (it uses the nonce and emits nothing). Check the explorer; if it isn't the keeper's, rotate the keeper key. |
| `batch.past_max_wait` | the open batch has entries and Base time > `openStart + max(batchInterval, batchMaxWaitS) + 15 min` (muted while held) | readings | 15 min | The keeper isn't closing: check that it runs, its ETH, and the front door's state. |
| `payout.overdue` | a queued payout batch still pending (`getPayoutBatch(key).count > cursor`) at `queuedAt + payoutDelay + 60 min` (muted while held) | logs, readings | 60 min | The keeper isn't paying out: check it runs and its TAO; `processPayouts` is open to anyone after the delay. |
| `delivery.overdue` | a user with `claimable > 0` and a live `deliveryOf` preference (both in the readings), 120 min after their `PayoutReceived` | logs, readings | 120 min | The keeper can't deliver USDC: check the TWAP oracle and the floors in the keeper's log; the user can still claim. |
| `keeper.low_eth` / `keeper.low_tao` | keeper ETH on Base < 0.002; keeper TAO on Bittensor < 0.1 | readings | 0.002 ETH, 0.1 TAO | Top up the keeper wallet. |
| `keeper.idle_unstaked` | the vault's stakeable idle balance (balance − 1e12 − pendingPayouts) has been at least the chain's minimum stake for more than 2 h | readings | 2 h | The keeper isn't staking (or isn't running): check it. |
| `adapter.low_reserve` | the Bittensor adapter's native balance < 5e11 wei | readings | 5e11 | Top up with `fundReserve()`. |
| `twap.divergence` | `oracle.usdcValue(1e18)` differs by more than 3% from the mean of this monitor's own spot readings over the same 30 minutes ×2, or the oracle call reverts ×2 | readings | 300 bps | Deliveries may stall (or the pool is being pushed). Watch the pool; users can claim by hand. |
| `price.reference_unavailable` | the reference TAO price (6.1 `fmtao.depeg`) has been unavailable for more than 1 h | price APIs | 1 h | The depeg rule can't run; check the price sources. |
| `pool.liquidity` | the TAO/WETH pool's TAO balance or in-range `liquidity` below 50% of its 7-day median (`hours`) | readings | 50% | Swaps cost more; consider lowering batch and deposit limits. |
| `batch.one_wallet` | one payer (the staker's `Staked.payer` for staker deposits, else `DepositRequested.payer`) holds ≥ 50% of an open batch's TAO when the batch is ≥ 50% of `maxBatchValue`, or ≥ 10 of its entries | logs | 50%, 10 | One wallet is filling batches; watch for griefing of the cap or the lists. |
| `cap.nearly_full` | `netForwarded + openBatch.totalDeposits ≥ 90% of depositCap` | readings | 90% | New deposits will soon be refused; decide whether to raise the cap. |
| `unstakes.tiny_wave` | ≥ 20 `RedeemRequested` in 24 h each worth < 0.02 TAO at the current price, or the open batch's redeem list ≥ 80% of `maxRedeems` | logs, readings | 20, 0.02 TAO, 80% | Someone may be pushing honest exits into later batches; watch the next batches. |
| `outflow.near_limit` | this front door's burned amount in the vault's current 24-hour window plus the redeems waiting (open batch and in flight, at the current price) ≥ 80% of `max(gross × maxDailyOutflowBps / 10,000, minDailyOutflow)` | readings, logs | 80% | Exits beyond the allowance will be deferred; expect `RedeemDeferred`. |
| `rewards.uncollected` | Bittensor time − `lastClaimAt(stakeHotkey)` > 35 days, or unclaimed rewards ≥ 25 × 0.057 TAO (the keeper's claim policy) | readings | 35 d, 25× | Run `pnpm ops claim --live`. |
| `validator.not_earning` | the stake hotkey's unclaimed rewards haven't grown in 24 h (`hours`), with no `RewardsClaimed` in that time | readings, logs | 24 h | The validator may have stopped earning (deregistered, offline): check it on taostats; consider moving stake. |
| `vault.events` | any `RedeemDeferred`, `PayoutDust`, `DepositSkipped` or an undecodable log | logs | — | Read the event in the email; usually a user-level edge case. |
| `indexer.lag` | a chain's settled time more than `lagLimit` behind its head (the keeper holds past this) | cursors | derived | The monitor is behind on a chain and the keeper is holding: check the RPC. |
| `indexer.reorg` | a stored log vanished from a later read | logs | — | Usually harmless; if it was a Cascade transaction, re-check its effects. |
| `site.unreachable` | the site check couldn't fetch the site for 30 min | site check | 30 min | Check that the site is up (Pages, DNS). |
| `monitor.chain_unreadable` / `monitor.email_failing` / `monitor.rule_failed` | 5 ticks in a row without a usable reading of a chain; emails failing for 30 min; a rule that threw | tick | 5, 30 min | Check RPC URLs and the email binding; a failing rule names its error (a bug to fix). |

Warnings are emailed at most every 30 minutes, all new ones together (section 7).

#### 6.4 Two more rules I propose (*call*, cheap; the owner decides: open question 13)

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
ticks run, failed and skipped; emails sent. It is sent once per UTC day (`meta.digest_date`), so a retried
invocation doesn't send it twice. Its arrival is itself a heartbeat: no digest means the monitor is down.

#### 6.6 Website integrity

*call*: compare the live site against **approved lists** committed in `indexer/src/site-approved.ts`, generated
by `pnpm site:approved ../web/out` from the static export the owner is about to deploy: every 0x-address and
every `https://` host found in its HTML and JavaScript.

- **What is checked.** A pass starts from the pages in `SITE_PAGES` (default `/` and `/stake/`): their inline
  scripts and every `<script src>` under `/_next/static/`, then every further `/_next/static/chunks/….js` path
  named inside the files fetched (the lazily loaded chunks), up to 80 files. Addresses are matched with hex
  boundaries (`(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])`), so 64-digit hashes don't match.
- **Findings.** Critical `site.integrity` when a configured Cascade address (front door, staker, vault, adapters,
  oracle) is missing from a complete pass, or an address or host appears that isn't approved (a new RPC
  endpoint counts); warning `site.unreachable` after 30 minutes without a fetch.
- **Within the CPU limit.** The hourly job starts a pass (the pages); each minute tick then fetches and scans
  up to `SITE_FILES_PER_TICK` files (default 2), keeping the pass's progress in `meta`, so a pass completes in
  well under an hour on the free plan; on Workers Paid the hourly job can run a whole pass at once.
- **Limits, stated.** An address assembled at run time, or code fetched from elsewhere at run time, is not seen;
  content hashes are not compared (they change with every build, while the address and host lists change only
  when dependencies or the deployment do, so the owner refreshes them rarely and reviews them in git). The check
  runs from Cloudflare, so it guards against DNS and build tampering more than against an account takeover.

### 7. Email

- **Transport:** the `send_email` binding `EMAIL`, restricted with `allowed_sender_addresses` to the sender in
  `ALERT_FROM` (e.g. `monitor@cascade.fi`). Recipients come from the secret `ALERT_TO` (comma-separated), so no
  personal address is in the public repo. *call*: send only to **verified destination addresses** (free on every
  plan, no quota); that needs Email Routing on the sending domain (open question 2).
- **Order:** an alert is committed first, then its email is sent, then a small write marks it sent (section 1).
  If that last write fails the email may go out once more; if the main commit fails, no alert email goes out
  and the stateless `monitor.db_failing` email is the only one (at minute 0).
- **Tiers:**
  - Critical: sent in the tick after it is committed, subject `[CASCADE CRITICAL] {summary}`; re-sent every 60
    minutes while open and not acknowledged, at most 6 times; a `[Cascade resolved] {summary}` when a condition
    clears (event alerts don't resolve by themselves).
  - Warning: collected and sent at most every 30 minutes as one email, subject `[Cascade warning] {n} new: {first
    summary}`; not re-sent; listed in the digest while open; resolved quietly (the digest says so).
  - Digest: once a day, section 6.5.
- **Body** (plain text and simple HTML, same content): one sentence of what happened; the facts (chain, block,
  time, contract, transaction links on basescan.org / evm.taostats.io, CCIP explorer links, amounts with units);
  **What to do:** the rule's runbook line, with values filled in (key, deadline); whether the hold is on and how
  to clear it; how to acknowledge. *call*: emails contain explorer links and hashes only, never a link to sign
  anything, and say so in the footer ("act from your own tools, never from a link in this email").
- **Every rule has a runbook line** in `src/runbook.ts`; a test fails for a rule without one.
- **Acknowledging:** `pnpm alerts:ack <id>` runs `wrangler d1 execute` to set `acknowledged_at` (stops re-sends).
- **Failures:** a send that throws stays due and is retried next tick; `E_RATE_LIMIT_EXCEEDED` and
  `E_INTERNAL_SERVER_ERROR` back off; validation errors are logged and raise `monitor.email_failing`. A send never
  stops the tick.
- **Local and dry runs:** `ALERT_MODE=log` writes the rendered email to the log instead of sending (the default in
  local dev and tests).

### 8. The hold flag, the per-batch confirmation, and what the keeper does

**When the hold is raised.** Findings of rules marked "Hold" in 6.1 raise a hold row with a stable id
(`bridge.batch:42`, `price.drop:{bittensor block}`, …). The Worker never clears a hold by itself, even when the
condition clears. It never pauses anything either: a paused vault or front door makes bridge messages that arrive
meanwhile fail until someone executes them again by hand, so a pause stays a human decision, taken with the
email's steps in front of them.

**What the keeper reads** (the keeper change is a later task): `GET {OPS_HOLD_URL}` (the Worker's `/v1/status`),
schema v1:

```json
{
  "v": 1,
  "deployment": { "frontDoor": "0x…", "vault": "0x…", "baseChainId": 8453, "bittensorChainId": 964 },
  "hold": { "active": true, "ids": ["bridge.batch:42"] },
  "payouts": { "okKeys": ["0x…", "0x…"] },
  "indexer": {
    "base":      { "settledTo": 53227000, "settledTime": "…Z", "lagS": 64 },
    "bittensor": { "settledTo": 9402130,  "settledTime": "…Z", "lagS": 130 }
  },
  "monitor": { "lastCompleteTickAt": "2026-…Z" },
  "generatedAt": "2026-…Z"
}
```

`okKeys` lists the keys of payout batches still pending in the vault whose batch check is `ok`. `lagS` is the
head's block time minus the settled block time, at the last complete tick.

**What the keeper does with it** (*call*, the interface the later task builds; open questions 3 and 4):

- **Before `processPayouts(key)`**: the key must be in `okKeys`. A key that isn't (the check is waiting or failed,
  or the monitor hasn't seen the batch) is not paid this round, with one log line.
- **Before closing a batch with any redeem entry, before `processPayouts`, and before `roll`** (a roll can become
  a close that carries redeems if a request lands first): the keeper holds when any of these is true:
  - `hold.active`, or the local file `ops/hold.json` (git-ignored, `{ "v": 1, "hold": true, "reason": "…" }`)
    says hold;
  - the status can't be read or parsed, `v` isn't 1, or its `deployment` isn't the keeper's record;
  - `max(lagS) + (now − lastCompleteTickAt)` on either chain exceeds `min(30 min, payoutDelay / 4)`, with
    `payoutDelay` read on chain by the keeper itself (its `readState` already does).
  The keeper fails closed: a monitor that can't see is treated as a monitor that says stop. Payouts wait out
  `payoutDelay` anyway, so a monitor outage costs time, not money.
- Deposit-only closes, staking and reward reports are unaffected. USDC deliveries are unaffected unless the owner
  decides otherwise (open question 4).
- The same rules apply to the one-shot `pnpm ops close`, `pnpm ops payouts` and `pnpm ops roll`, not only to `run`.
- `OPS_HOLD_URL` unset keeps today's behaviour (no monitor configured).
- **Escape hatch:** `--ignore-monitor-outage --until <UTC time>` (at most 24 hours ahead) bypasses only the outage
  conditions (unreadable, stale, lagging) and, while one of them holds, the per-key `ok` (which an outage can't
  supply). It never bypasses an active hold or `ops/hold.json`, and while the monitor is healthy a key that isn't
  `ok` is still not paid. It prints a warning every round and lapses at `--until`.
- The hold governs our keeper only. The contracts' permissionless calls are unaffected, so the hold buys time for
  the human steps in the email; it doesn't replace them.

**Clearing.** No HTTP route can set or clear a hold. A human runs `pnpm hold:clear -- --env production --id <id>
--note "…"` (or `--all`), which first prints the active holds, then runs `wrangler d1 execute <db> --remote` with
the `UPDATE holds SET cleared_at, cleared_note WHERE id = … AND cleared_at IS NULL` (the note restricted to
letters, digits, spaces and basic punctuation). Clearing needs Cloudflare account access, the right authority for
it. A cleared id is never raised again; for the price rule the 24-hour high is reset to the current price, so the
same drop isn't re-counted.

### 9. Config and secrets

`indexer/wrangler.jsonc` (committed): name, `main`, `compatibility_date`, `observability.enabled`, the three
crons, `"cache": { "enabled": true }`, the D1 binding `DB` and the `send_email` binding `EMAIL` per environment
(`env.test`, `env.production`), and `vars`:

| Var | Example | Notes |
|---|---|---|
| `DEPLOYMENT` | JSON: chain ids, front door, Base adapter, staker, oracle, vault, Bittensor adapter, vault coldkey, stake hotkey, Base and Bittensor start blocks, baseline blocks, `batchMaxWaitS` | public; generated by `pnpm config:from-record ../ops/deployments/v3-test.json` (reads the ops record with its `$bigint` reviver) |
| `BRIDGES` | `{"base":["<Base adapter>"],"bittensor":["<Bittensor adapter>"]}` | the bridges a payout or batch may arrive through; default the deployment's adapters |
| `TOKENS` | FM-TAO on Base and Bittensor, the Bittensor lock pool, USDC, WETH, the two Uniswap pools, Multicall3, OffRamps, AlphaVault | public constants, as in `ops/src/config.ts` |
| `BASE_RPC_URL`, `BASE_LOGS_RPC_URL`, `BITTENSOR_RPC_URL` | `https://mainnet.base.org`, `https://base-rpc.publicnode.com`, `https://archive.chain.opentensor.ai` | a secret of the same name overrides each (for a keyed URL) |
| `BASE_LOG_WINDOW`, `SUBREQUEST_BUDGET`, `DECODE_BUDGET`, `SITE_FILES_PER_TICK` | `100`, `45`, `300`, `2` | raise the last three on Workers Paid |
| `SITE_ORIGIN`, `SITE_URL`, `SITE_PAGES` | `https://cascade.fi`, `https://cascade.fi`, `["/","/stake/"]` | CORS and the integrity check |
| `ALERT_FROM`, `ALERT_MODE` | `monitor@cascade.fi`, `send` | `log` in dev and tests |
| `THRESHOLDS` | `{}` | overrides of `src/thresholds.ts`; a secret of the same name wins |
| `PRICE_SOURCES` | `["coingecko","coinbase"]` | reference TAO price for `fmtao.depeg` (median of those that answer; both must agree within 2%) |

Secrets (`wrangler secret put`, or `.dev.vars` locally, git-ignored): `ALERT_TO`; optionally `THRESHOLDS` and the
three RPC URLs. **No private key, mnemonic or signer exists anywhere in the Worker.** `src/config.ts` parses and
validates all of it at the start of every invocation (checksummed addresses, integer blocks, known price
sources) and refuses to run on a bad config with a log line only (an unconfigured Worker must not spam).

### 10. Local development and testing (no deploy)

- **Package:** `indexer/` with its own `package.json` (pnpm 11.23.0), TypeScript 5.9.3, vitest 5.0.5,
  `@cloudflare/vitest-plugin` 1.4.2 (which pins wrangler 4.151.0), wrangler 4.151.0, viem 2.57.7 and
  `@noble/hashes` 1.8.0 (the web app's versions); `wrangler types` generates `worker-configuration.d.ts`
  (committed).
- **Tests** (`pnpm test`): two vitest projects. `worker` (with `cloudflareTest()` configured on that project
  only): every `src/` module runs inside workerd, with D1 migrations applied by `applyD1Migrations` in a setup
  file and a fake JSON-RPC server injected as the fetch the RPC client uses (scripted answers per method, a head
  that can lag, readings that go backwards, failures on demand); handler tests call `worker.fetch` and
  `worker.scheduled(createScheduledController({ cron }), env, ctx)`. `node`: everything that reads or writes
  files (the Node scripts, the tests that compare constants with `ops/src/keeper/state.ts` or the contracts'
  sources, the crons-versus-dispatch test, the grep tests, and the fixture writer), since workerd has no
  filesystem.
- **Fixtures:** recorded logs from the live v3 test deployment (batches 1 and 2, whose keys the review rebuilt,
  and batch 2's chunk 0) committed as JSON, so the replay and the cross-checks are tested on real bytes; the seed
  fixtures the web tasks use are written by a Node script from the same pure function the API uses, and a test
  checks the committed files are current.
- **Bundle check:** `pnpm wrangler deploy --dry-run --outdir .wrangler/dry-run --env test` builds the Worker
  without logging in or creating anything; it runs in CI-style checks with `pnpm test`.
- **Run it locally:** `pnpm wrangler d1 migrations apply DB --local --env test`, then `pnpm wrangler dev --env test
  --test-scheduled`, then `curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*"` to run a tick
  against the live chains (read-only) and `curl http://localhost:8787/v1/scan/{vault}`. Local D1 lives in
  `.wrangler/state` (git-ignored). Email stays in `ALERT_MODE=log`; never set the binding's `remote: true`.
- **Live smoke** (`pnpm smoke`, skipped unless `INDEXER_SMOKE=1`): one tick against the v3 test deployment into a
  Miniflare D1, printing the digest; asserts the halves for the test wallet pass the web's `decode` rules.

### 11. Deploy steps the owner will do later

0. **Choose the plan shape** (open question 1). Workers plans apply to the whole Cloudflare account. Either
   (a) put the account on Workers Paid ($5/month), and run `test` and `production` side by side; or (b) stay on
   Free with **one environment per account**: `production` in the main account and `test` in a second, free
   Cloudflare account. Don't run both environments in one Free account: six crons exceed its five, and both
   would share one set of daily quotas.
1. `pnpm --dir indexer install && pnpm --dir indexer test`.
2. `pnpm --dir indexer wrangler login`.
3. `pnpm --dir indexer wrangler d1 create cascade-indexer-test`; paste the printed `database_id` into
   `env.test` in `wrangler.jsonc` (an id, not a secret).
4. `pnpm --dir indexer wrangler d1 migrations apply cascade-indexer-test --remote --env test`.
5. Email (open question 2): in the dashboard, Email Service → Email Routing → onboard the sending domain (it
   adds MX and SPF records), then add and verify the destination address. `pnpm --dir indexer wrangler secret put
   ALERT_TO --env test`; optionally `THRESHOLDS` and keyed RPC URLs as secrets.
6. `pnpm --dir indexer config:from-record ../ops/deployments/v3-test.json` and paste the `DEPLOYMENT` value.
7. `pnpm --dir indexer site:approved ../web/out` after building the site to deploy; commit the lists.
8. `pnpm --dir indexer wrangler deploy --env test`; add the custom domain (`api.cascade.fi`, or the
   `workers.dev` URL to start).
9. Watch `GET /v1/status` until both chains' `lagS` are small (backfill takes an hour or so); expect the first
   digest at 13:00 UTC; trigger one warning on purpose (e.g. a `THRESHOLDS` keeper floor above the real balance)
   to see an email arrive, then remove it.
10. A rate-limiting rule on the API path (`api.cascade.fi/v1/scan/*`), and optionally an outside uptime check
    on `/v1/health`.
11. Site: set `NEXT_PUBLIC_CASCADE_INDEXER_URL` (after the site tasks). Keeper: set `OPS_HOLD_URL` (after the
    keeper tasks).
12. Production: the same with `--env production` once the launch deployment exists.

### 12. Cost

| Resource | Use | Free limit (per account) |
|---|---|---|
| Worker requests | 1,440 ticks + 24 hourly + 1 digest + API calls (about 2 per first visit; repeat visits rarely ask) ≈ 3,500/day at 1,000 visits | 100,000/day (shared with Pages Functions; static Pages are free) |
| Subrequests | ~10 per steady tick; backfill ticks up to 45 | 50 per invocation |
| CPU | steady tick estimated 3–8 ms (decoding a few logs, two multicall answers, two site files): **unmeasured** | 10 ms per invocation |
| D1 rows written | cursors 2,880 + readings 1,440 + hours 1,440 + logs ~600 + seed pages ~200 + alerts ≈ 7–11 k/day | 100 k/day |
| D1 rows read | ticks ~100 k/day (hourly rows, not per-minute history) + API (the shared half is cached; an account half reads that account's rows) | 5 M/day |
| D1 storage | ~200 MB/year of logs, plus small tables | 500 MB per database |
| Email | alerts and digests to verified addresses | free, no quota |
| RPC, price APIs | public endpoints | free (rate-limited) |

It fits at $0 for one environment per Free account. *call*: **recommend Workers Paid ($5/month) for the
account** (open question 1), because a security monitor shouldn't run at the edge of its limits:

- **CPU.** 10 ms is tight; a tick over it is killed and commits nothing (the watchdog notices, section 1). The
  scan and the site check are split across ticks, but rule evaluation can't be split indefinitely. Measure in the
  first week (Workers Observability shows CPU per invocation).
- **Subrequests.** 50 per invocation slows backfill and leaves little slack when RPCs retry.
- **Shared daily quotas.** Public API traffic and the monitor draw on the same account quotas (requests, D1 rows
  read), and on Free those reset only at midnight UTC. Defences: Workers Paid (no daily request limit, a monthly
  D1 allowance thousands of times larger), the cacheable shared half, a rate-limiting rule on the API path, the
  site's fallback when the API answers 503, and the keeper holding when the monitor goes stale.
- **Two environments.** On Paid both run side by side in one account; on Free the test one needs its own account
  (section 11).

### 13. Security of the Worker itself

**What it holds:** public chain data, alert history, the alert recipients (`ALERT_TO`), private thresholds if set,
and any keyed RPC URLs. No signing key, no user data beyond public addresses.

**An attacker who controls the Worker, its code, its D1 or the Cloudflare account can:**

- serve false history to the site. Every entry a trail uses is confirmed by its receipt first, so it can't show a
  delivery, stake or chunk that didn't happen, nor an amount that isn't in a receipt. It can omit events: a trail
  may then lag (step 6 of section 5 looks for omitted deliveries), and the cumulative "rewards earned" figure
  could be wrong if a matched set of the account's events were left out; that is why the figure stays marked
  provisional until the browser's own check of the account's history matches (section 5, step 5);
- silence the monitor: suppress alerts, digests and the hold. The missing daily digest is the tell; an outside
  uptime check on `/v1/health` is the stronger one (open question 9). A silent monitor also goes stale in the
  status, so our keeper holds payouts;
- report a batch as `ok` that isn't: our keeper would then pay it. This is the one place the keeper relies on the
  Worker, and it relies on it only to say "yes" in addition to its own chain reads; an attacker who can also
  forge a bridge message and controls the Worker defeats the check, which is why the human steps (guardian pause,
  owner cancel within `payoutDelay`) remain the real defence;
- send false alerts: emails carry explorer links and hashes only, and every action they ask for is done from the
  owner's own tools, never from a link (stated in every footer);
- raise a false hold or withhold `ok`: our keeper stops redeem closes and payouts until a human acts (a delay,
  bounded by the human); or clear a real hold: back to the brake not existing;
- read the keyed RPC URLs (quota theft), the private thresholds and the recipient address;
- with the account itself, also change the Pages site: that is account security (hardware-key 2FA, few members),
  outside this design.

**It can't:** move or freeze money, sign or send a transaction, change a contract setting, change what a user's
wallet is asked to sign, or change a balance the site shows.

**Hardening in the design:** no write routes and no admin routes; every route validates its parameters and queries
D1 only through prepared statements; one fixed CORS origin; `no-store` on status and health; the status shows
hold ids, not reasons; minimal dependencies (viem and `@noble/hashes` at runtime), exact pins and a committed
lockfile; secrets only for the recipients, private thresholds and keyed RPC URLs; the RPC client never logs URLs;
a test that greps `src/` for transaction-sending methods; holds cleared only with account access; commits guarded
by the lease. A lying RPC can make the monitor miss or invent things; readings that go backwards are dropped, and
a second RPC per chain for the critical reads is a later improvement (open question 12).

### 14. Open questions for the owner

Tasks that depend on an answer are marked in the plan.

1. **Plan shape:** Workers Paid ($5/month) for the account, with test and production side by side (recommended,
   section 12)? Or stay Free with a second Cloudflare account for test?
2. **Email:** is cascade.fi's DNS on Cloudflare, and does anything else receive mail for cascade.fi today
   (Email Routing takes over its MX records)? Which address gets alerts? A sending subdomain (e.g.
   `alerts.cascade.fi` with Email Sending on Paid) avoids touching the main domain's mail.
3. **Keeper fail-closed:** the design pays a batch only once the monitor reports it `ok`, and holds redeem closes,
   payouts and rolls when the monitor is unreadable, stale or lagging past `min(30 min, payoutDelay / 4)`, with an
   expiring `--ignore-monitor-outage` escape hatch. Agree?
4. **Should the hold also stop USDC deliveries?** On a payout mismatch, the TAO on Base may be unbacked; selling it
   for users is arguably right (they get USDC) or wrong (we sell into a depeg). The floors protect the price
   either way.
5. **Thresholds:** sharp drop 10 bps from the 24-hour high; depeg 5%; TWAP divergence 3% against our own 30-minute
   spot mean; keeper floors 0.002 ETH and 0.1 TAO; the tiny-unstake and one-wallet numbers. Any to change? Keep
   production values in the `THRESHOLDS` secret?
6. **Price references:** OK to call CoinGecko and Coinbase's public price endpoints from the Worker (no keys)?
   Without them `fmtao.depeg` doesn't run.
7. **Planned admin changes:** today every admin event is critical, including the owner's own. Want a way to
   pre-announce a change (a row added with wrangler) so its alert says "announced"?
8. **Domains:** the API at `api.cascade.fi`? Which site origin(s) to allow: only `https://cascade.fi`, or also
   `www` and Pages preview URLs (previews would then fall back to their own scan)?
9. **Outside heartbeat:** add a free external uptime check on `/v1/health` that emails if the Worker stops? (An
   outward action on a third-party service, so your call.)
10. **FM-TAO backing:** is FM-TAO bridged to chains other than Base? If so, the backing rule (Base supply ≤
    Bittensor lock) still holds but is weaker.
11. **Run on the v3 test deployment now?** Recommended: it rehearses the backfill, the cross-check on real batches,
    the email path and the keeper's per-batch confirmation before launch.
12. **A second RPC per chain** for the critical reads (price, stake, supply), raising a warning when they disagree:
    worth paying for a keyed provider?
13. **The two proposed rules** (6.4): keep `rail.alpha_vault` and `fmtao.mint_surge`?
14. **"Rewards earned" after a seeded first visit:** shown as provisional until the browser's own check of the
    account's history matches (section 5). Acceptable, or hide it until then?

## Left to the builder

File layout inside `indexer/src`, the exact email wording within the rules above, HTML styling, the fake RPC's
shape, how readings and hourly rows are compacted into JSON, and the order of rules within a tick.
