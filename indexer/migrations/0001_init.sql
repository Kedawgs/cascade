-- Cascade indexer and monitor, spec section 2. Addresses and hashes are lowercase hex, amounts decimal
-- text, times unix seconds. (No semicolons in comments: migrations are split on them.)

-- key/value facts: schema version, deployment id, last tick times, digest date, site-check progress
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
INSERT INTO meta (k, v) VALUES ('schema', '1');

-- one row per chain: how far the scan has read and what is stored
CREATE TABLE cursors (
  chain        TEXT PRIMARY KEY CHECK (chain IN ('base','bittensor')),
  from_block   INTEGER NOT NULL,   -- the deployment's first block on this chain
  scanned_to   INTEGER,            -- the last head fully read (null before the first window)
  settled_to   INTEGER NOT NULL,   -- every log in [from_block, settled_to] is stored (from_block - 1 at first)
  settled_time INTEGER,            -- block time of settled_to
  head_time    INTEGER,            -- set every tick: the newest time known for this chain (the scan head's
                                   -- block time, else this tick's reading's, else the Worker's clock)
                                   -- lag = head_time - settled_time, so a stuck scan shows as growing lag
  updated_at   INTEGER NOT NULL
);

-- every log of the watched contracts, stored once it is SETTLE blocks deep
CREATE TABLE logs (
  uid       TEXT PRIMARY KEY,      -- keccak256(chain ':' txHash ':' topics ':' data '#' n), the keeper's identity
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
-- the stored uids in a chain's re-read range, loaded every tick (not in the spec's list: without it that
-- query reads the whole table each tick)
CREATE INDEX logs_by_block ON logs(chain, block);

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
-- updated by each tick, read by rules that look back a day or a week, pruned after 35 days
CREATE TABLE hours (hour INTEGER PRIMARY KEY, json TEXT NOT NULL);

-- bridge messages our contracts sent, and what became of them
CREATE TABLE messages (
  message_id TEXT PRIMARY KEY, direction TEXT NOT NULL,  -- 'base>bittensor' | 'bittensor>base'
  sender TEXT NOT NULL, recipient TEXT NOT NULL, amount TEXT NOT NULL,
  src_tx TEXT NOT NULL, src_block INTEGER NOT NULL, src_time INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'UNTOUCHED', state_at INTEGER,
  dst_tx TEXT, dst_block INTEGER);                       -- set from the destination adapter's Delivered
CREATE INDEX messages_pending ON messages(src_block) WHERE dst_tx IS NULL;

-- the cross-check: one row per DELIVERY (a forged delivery reusing an honest batch id gets its own row and
-- can't block the honest one), and one row per LANDING on Base (keyed by the PayoutsDelivered log's uid)
CREATE TABLE batch_checks (
  batch_id INTEGER NOT NULL, delivered_key TEXT NOT NULL, delivered_uid TEXT NOT NULL, delivered_tx TEXT NOT NULL,
  closed_tx TEXT, message_id TEXT, expected_key TEXT,
  status TEXT NOT NULL,              -- 'waiting' | 'ok' | 'mismatch' | 'ok_by_owner'
  detail TEXT, approved_note TEXT, approved_at INTEGER,
  queued_block INTEGER,              -- the delivery's PayoutBatchQueued block, if it queued payouts
  payout_done_block INTEGER,         -- first reading block (after queued_block) where getPayoutBatch(key).count = 0
  PRIMARY KEY (batch_id, delivered_key));
CREATE INDEX batch_checks_by_key ON batch_checks(delivered_key);
CREATE TABLE chunk_checks (
  landed_uid TEXT PRIMARY KEY,       -- the PayoutsDelivered log: a forged duplicate landing gets its own row
  batch_key TEXT NOT NULL, chunk INTEGER NOT NULL, landed_tx TEXT NOT NULL, landed_block INTEGER NOT NULL,
  sent_tx TEXT, message_id TEXT, expected_hash TEXT,
  status TEXT NOT NULL,              -- 'waiting' | 'awaiting_read' | 'ok' | 'mismatch'
  detail TEXT);
CREATE INDEX chunk_checks_by_chunk ON chunk_checks(batch_key, chunk);
-- what every tick loads (not in the spec's list: without these, each tick's load reads whole tables that
-- only grow): checks still open, deliveries whose payouts are pending, messages not yet arrived
CREATE INDEX chunk_checks_by_status ON chunk_checks(status);
CREATE INDEX batch_checks_pending ON batch_checks(delivered_key) WHERE queued_block IS NOT NULL AND payout_done_block IS NULL;

-- watched addresses' transaction counts (or a Safe's nonce): compared with the transactions seen in our logs
CREATE TABLE nonces (chain TEXT NOT NULL, address TEXT NOT NULL, roles TEXT NOT NULL, baseline INTEGER NOT NULL,
  nonce INTEGER NOT NULL, changed_at INTEGER NOT NULL, PRIMARY KEY (chain, address));

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY, alert_key TEXT NOT NULL, rule TEXT NOT NULL,
  tier TEXT NOT NULL, kind TEXT NOT NULL,           -- 'critical'|'warning', 'condition'|'event'
  subject TEXT NOT NULL, body TEXT NOT NULL, runbook TEXT NOT NULL,
  opened_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, resolved_at INTEGER,
  notified_at INTEGER, notify_count INTEGER NOT NULL DEFAULT 0, acknowledged_at INTEGER);
CREATE UNIQUE INDEX alerts_open ON alerts(alert_key) WHERE resolved_at IS NULL;

CREATE TABLE holds (id TEXT PRIMARY KEY,           -- internal: 'bridge.batch:42' (emails, scripts)
  public_id TEXT NOT NULL UNIQUE,                   -- opaque: 'h_' + 8 random hex digits (the public status)
  rule TEXT NOT NULL, summary TEXT NOT NULL,
  raised_at INTEGER NOT NULL, cleared_at INTEGER, cleared_note TEXT);

CREATE TABLE lease (name TEXT PRIMARY KEY, holder TEXT NOT NULL, until INTEGER NOT NULL);
-- a commit's first statement inserts 1 here unless its tick is still the lease's holder. The CHECK then
-- fails the whole batch, so a tick can never commit over a newer tick that took the lease from it.
CREATE TABLE guard (x INTEGER CHECK (x = 0));
