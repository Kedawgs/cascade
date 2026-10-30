# cascade-indexer

Cascade's history indexer and monitor: one Cloudflare Worker with one D1 database per environment. The
design is `docs/superpowers/specs/2026-10-28-cascade-indexer-monitor-design.md`; this file is how to run it.

## What it does

- **Serves the site's starting point.** A first visit to cascade.fi reads the vault's whole history from the
  chain. The Worker keeps that history and serves it in the two halves the site's store saves, so a first visit
  starts near the head instead. It is only an accelerator: the site checks what it uses against chain receipts
  and works without it.
- **Watches both chains and the bridge.** Every minute it reads Base and Bittensor, checks every batch that
  arrives on Bittensor against the batch the front door really closed on Base, and every payout that lands on
  Base against the chunk the vault really sent, and runs the rest of the rules (spec section 6). It emails the
  owner, raises a **hold** that the keeper respects, and lists the batches it has confirmed so the keeper pays
  only those.

It holds no key and never sends a transaction. Nothing over HTTP can write anything, set or clear a hold.

### Four crons

| Cron | Job |
|---|---|
| `* * * * *` | the **tick**: lease, scan both chains, read their state, run the rules, commit, then send email |
| `*/2 * * * *` | the **site check**: the live site's scripts against the approved lists, in its own invocation |
| `17 * * * *` | the **hourly job**: the watchdog, and pruning readings (120 kept) and hour rows (35 days) |
| `0 13 * * *` | the **daily digest** (once per UTC day), and the watchdog again |

The **watchdog** emails `monitor.stalled` itself when no tick has completed for 15 minutes, even when the
database can't be written (then straight from memory). A tick that can't write its database sends one
`monitor.db_failing` email, at minute 0 only.

### Four routes

| Route | For |
|---|---|
| `GET /v1/scan/{vault}` | the site: the deployment-wide half of its scan (cached 30 s, CORS for `SITE_ORIGIN`) |
| `GET /v1/scan/{vault}/{account}` | the site: one account's half |
| `GET /v1/status` | the keeper: the hold (opaque ids only), confirmed payout keys, each chain's lag |
| `GET /v1/health` | an uptime checker: 200 while a tick completed in the last 5 minutes |

The vault and account must be lowercase and there must be no query string (one spelling per resource, so the
cache can't be sidestepped).

## Working on it locally (nothing is deployed)

```sh
cd indexer
pnpm install
pnpm test          # both projects: worker (inside workerd, with a local D1) and node (scripts, files)
pnpm typecheck
pnpm bundle        # wrangler deploy --dry-run: builds the Worker without logging in
```

Tests never reach the network; they use a fake JSON-RPC server and a Miniflare D1.

To run the Worker against the live chains (read-only) on your machine:

```sh
pnpm wrangler d1 migrations apply DB --local --env test
pnpm dev                                                        # wrangler dev --env test --test-scheduled
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*"     # one tick
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/2+*+*+*+*"   # one site-check run
curl "http://localhost:8787/v1/status"
```

The local database lives in `.wrangler/state` (git-ignored). Emails stay in `ALERT_MODE=log` (written to the
console). A local secret goes in `indexer/.dev.vars` (git-ignored, never committed). Never set `remote: true` on
a binding.

`pnpm smoke` runs one tick against the live v3 test deployment into a throwaway local D1 (read-only RPC calls,
at most `SMOKE_BUDGET`, 40 by default) and prints the tick's report, the cross-checks and the digest. It is not
part of `pnpm test`. `pnpm fixtures:record ../ops/deployments/v3-test.json` re-records the real-bytes fixtures
the tests use (`test/fixtures/v3-test-*.json`, about 10 read-only requests).

## Configuration

Everything public is in `wrangler.jsonc` (`env.test` and `env.production` vars). `src/config.ts` checks all of
it at the start of every invocation and refuses to run on a bad config, with a log line only.

- **`DEPLOYMENT`**: the deployment's addresses and blocks. `pnpm config:from-record <ops record>` prints it from
  a verified ops record (addresses checksummed, Bittensor starting at the Bittensor adapter's block, which is the
  site's `NEXT_PUBLIC_CASCADE_BIT_BLOCK`). `env.test` already holds the v3 test deployment's; `env.production`
  is a placeholder until the launch record exists.
- **RPC URLs**: `BASE_RPC_URL` (state reads), `BASE_LOGS_RPC_URL` (log scans) and `BITTENSOR_RPC_URL`. The Base
  logs URL must **not** be `https://mainnet.base.org`: it refuses `eth_getLogs`. The default,
  `https://base-rpc.publicnode.com`, answers 100-block windows. Bittensor must be an archive node
  (`https://archive.chain.opentensor.ai`): the lite node keeps only minutes of logs.
- **Budgets** (two profiles; both environments are set to Paid):

  | Var | Workers Paid (set) | Workers Free (fallback) |
  |---|---|---|
  | `SUBREQUEST_BUDGET` | 200 | 45 |
  | `DECODE_BUDGET` | 5000 | 100 |
  | `SITE_FILES_PER_RUN` | 20 | 2 (1 if the site has a chunk near the byte cap) |
  | `SCAN_WALL_S`, `LEASE_S`, `SITE_MAX_BYTES` | 40, 180, 2000000 | the same |

  On Paid, raise `DECODE_BUDGET` and `SUBREQUEST_BUDGET` if a backfill is slow; on Free, keep the Free column.
- **Thresholds**: every number the rules use is in `src/thresholds.ts`. Override any of them with the
  `THRESHOLDS` var (public) or the `THRESHOLDS_SECRET` secret (wins over the var, for values you'd rather not
  publish), as JSON, e.g. `{"keeperMinEthWei":"3000000000000000","rules":{"off":["fmtao.mint_surge"]}}`.
  Amounts are decimal strings; unknown keys are refused.
- **Secrets** (`pnpm wrangler secret put <NAME> --env <env>`): `ALERT_TO` (the recipients, comma-separated:
  never in the repo); optionally `THRESHOLDS_SECRET`, and keyed RPC URLs as `BASE_RPC_URL_SECRET`,
  `BASE_LOGS_RPC_URL_SECRET` and `BITTENSOR_RPC_URL_SECRET`. A secret can't share a var's name (the Worker sees
  one value per name), so each override is the var's name plus `_SECRET`, and it wins over the var.

## Deploying (the owner does these)

Nothing in this repository logs in, creates a resource or deploys. These steps are yours. Run them from the
repository root.

0. **The plan.** Workers plans apply to the whole Cloudflare account. The decision (open question 1) is
   **Workers Paid** ($5/month), with `test` and `production` side by side in one account. Confirm it in the
   dashboard under **Workers & Pages → Plans** before deploying.

   If the account were to stay on Free instead: run **one environment per account** (`production` in the main
   account, `test` in a second, free account), never both in one Free account (eight crons exceed its five,
   and both would share one set of daily quotas), and set the Free budget column above. The test Worker in a
   second account then has two limits: it **can't send email from cascade.fi** (a Worker sends only from an
   Email Routing domain in its own account, so it stays in `ALERT_MODE=log` or uses a domain of its own), and it
   **can't use `api.cascade.fi`** (a custom domain must be a zone in its own account: it uses its `workers.dev`
   URL).
1. Install and test: `pnpm --dir indexer install && pnpm --dir indexer test`.
2. Log in: `pnpm --dir indexer wrangler login`.
3. Create the database: `pnpm --dir indexer wrangler d1 create cascade-indexer-test`, and paste the printed
   `database_id` over `local-only-test` in `env.test` of `indexer/wrangler.jsonc` (an id, not a secret).
4. Create the tables: `pnpm --dir indexer wrangler d1 migrations apply cascade-indexer-test --remote --env test`.
5. Email (open question 2). In the dashboard: **Email Service → Email Routing**, onboard the sending domain
   (cascade.fi; it adds MX and SPF records, so check nothing else receives mail there first, or use a sending
   subdomain), then add and **verify** the destination address. Then:
   `pnpm --dir indexer wrangler secret put ALERT_TO --env test` (the verified address). Optionally the
   `THRESHOLDS_SECRET` and `*_RPC_URL_SECRET` secrets. Once the address is verified, set `"ALERT_MODE": "send"`
   in `env.test`'s vars (it ships as `"log"`).
6. The deployment: `env.test` already holds v3-test's. For another deployment:
   `pnpm --dir indexer config:from-record ../ops/deployments/<record>.json` and paste what it prints into that
   environment's vars.
7. The approved site lists: build the site you are about to deploy, then
   `pnpm --dir indexer site:approved ../web/out`, review the change to `indexer/src/site-approved.ts` and commit
   it. Until this is done, the site check judges nothing and says so (`site.no_approved_lists`). When the site
   check reports a host that Cloudflare itself injects into the served pages (the Web Analytics beacon,
   `static.cloudflareinsights.com`, or a `/cdn-cgi/` script), check it is Cloudflare's and run it again with
   `--extra-hosts static.cloudflareinsights.com` (comma-separated for several): the hand-added hosts are named in
   the file, so they stay reviewable in git. Re-run this whenever the site is redeployed with new dependencies.
8. Deploy: `pnpm --dir indexer wrangler deploy --env test`. Add the custom domain (`api.cascade.fi`), or use the
   `workers.dev` URL to start.
9. Watch `GET /v1/status` until both chains' `lagS` are small: the first backfill takes an hour or so, and the
   digest says "catching up" meanwhile (the cross-checks wait until both chains are within an hour of their
   heads). Expect the first digest at 13:00 UTC. Trigger one warning on purpose to see an email arrive, e.g.
   `THRESHOLDS` `{"keeperMinEthWei":"1000000000000000000000"}` (a keeper floor above the real balance), then
   remove it.
10. A rate-limiting rule on the API path (`api.cascade.fi/v1/scan/*`), and optionally an outside uptime check on
    `/v1/health` (open question 9).
11. The site: set `NEXT_PUBLIC_CASCADE_INDEXER_URL` (after the site tasks). The keeper: set `OPS_HOLD_URL`
    (after the keeper tasks).
12. Production: the same steps with `--env production` and the launch deployment's record, once it exists.

## When an email arrives

Every alert says what happened, where to look (explorer links and hashes only, never a link to sign anything)
and what to do. Criticals arrive at once and are re-sent hourly (at most 6 times) until acknowledged; warnings
arrive together at most every 30 minutes; a critical condition that clears sends a "resolved" email. Act from
your own tools, never from a link in an email.

The owner's scripts run `wrangler d1 execute --remote`, so they need `wrangler login`; each takes `--dry-run` to
print what it would run:

- **Acknowledge** (stops the re-sends; the id is in the email):
  `pnpm --dir indexer alerts:ack -- --env test <alert id>`
- **Clear a hold** after checking what raised it (the internal id is in the email; the public id the status
  shows works too). It prints the active holds first:
  `pnpm --dir indexer hold:clear -- --env test --id <hold id> --note "what you checked"`, or `--all`.
  The Worker never clears a hold itself, and a cleared id is never raised again.
- **Approve a delivery check by hand**, when you have verified a batch yourself and the check is wrong or stuck
  (`bridge.check_stuck`). It prints the check first (the delivered key next to the key the front door's events
  rebuild, and the failing step) and asks for the batch id as the alert names it:
  `pnpm --dir indexer checks:approve -- --env test --key <delivered key> --batch <batch id> --note "what you checked"`.
  The keeper may then pay that batch, and the next tick emails the critical `checks.owner_approved`, so an
  approval you didn't make is noticed.

On v3-test the owner, guardian and keeper are one address, so a reverted keeper call pages as a critical
`keys.unexplained_tx`: expect that noise there.

## Limits worth knowing

- **The site check is a tripwire over the scripts' text.** An address or host built at run time (by string
  concatenation, or fetched from elsewhere) isn't seen, and a site that serves the monitor a clean copy and its
  users a tampered one can't be caught from outside. A file that stopped a site-check run points to the CPU
  limit (Workers Paid, or `SITE_FILES_PER_RUN=1`), not the byte cap.
- **FM-TAO's backing check is a weak backstop.** `fmtao.unbacked` compares FM-TAO's supply on Base with the
  Bittensor lock pool, which also backs FM-TAO on other chains, so the lock is far above Base's supply (read
  2026-10-29: 8,778 TAO on Base against 13,912 locked) and only a large forged mint would cross it.
- **CPU on Workers Free.** Measured in local workerd (2026-10-29): hashing and decoding a log costs about
  110–125 µs, so a full batch delivery (one block of about 205 vault logs) costs about 23–26 ms each time a tick
  reads it, while it is within SETTLE of the head (about 3 ticks) and once more when it settles. That is over
  Free's 10 ms per invocation, and nothing on Paid (30 s). A steady tick of the recorded v3-test scenario made 6
  D1 queries and read 149 rows (a first, backfilling tick: 5 and 110). Check the real CPU per invocation in
  Workers Observability in the first week.
- **Re-running migration 0004** (`INSERT OR IGNORE` into the check tables): it silently skips any row that
  breaks a NOT NULL rule, not only duplicates. Check the counts by hand if it is ever re-run against real data.
- **Every log write goes through `upsertLogs`** (`src/store.ts`), which also gives every delivery and landing its
  check row: a script or tool that writes logs any other way would leave a delivery unchecked.
