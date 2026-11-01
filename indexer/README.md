# cascade-indexer

Cascade's history indexer and monitor: one Cloudflare Worker with one D1 database per environment. The
design is `docs/superpowers/specs/2026-10-28-cascade-indexer-monitor-design.md`; this file is how to run it.

## What it does

- **Serves the site's starting point.** A first visit to cascadefi.xyz reads the vault's whole history from the
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
| `*/2 * * * *` | the **site check**: the live site's pages and scripts against the approved lists, in its own invocation |
| `17 * * * *` | the **hourly job**: the watchdog, the **logs cross-check** (each chain's newest settled blocks re-read through a second RPC and compared with the store), and pruning readings (120 kept) and hour rows (35 days) |
| `0 13 * * *` | the **daily digest** (once per UTC day), and the watchdog again |

The site check's cron is how often a run may work, not how often the site is judged: a **pass** starts an hour
after the last one finished, reads every page in `SITE_PAGES` (all 8 of the site's) in its first run, then 20
scripts a run. The real build (32 scripts) is one pass of two runs, so a change to the live site is judged within
about 64 minutes; at the 400-file cap a pass takes 40 minutes at most. A page it can't read is named
(`site.unreachable`) and the other pages are still judged.

The **watchdog** emails `monitor.stalled` itself when no tick has completed for 15 minutes, even when the
database can't be written (then straight from memory). It runs with the hourly job, so a stall is noticed 15 to
about 75 minutes after the last complete tick. A tick that can't read or write its database sends one
`monitor.db_failing` email, at minute 0 only. Neither can speak when the Worker refuses its config: that is
what the outside uptime check on `/v1/health` is for (deploy step 10).

### Four routes

| Route | For |
|---|---|
| `GET /v1/scan/{vault}` | the site: the deployment-wide half of its scan (cached 30 s, CORS for `SITE_ORIGIN`) |
| `GET /v1/scan/{vault}/{account}` | the site: one account's half |
| `GET /v1/status` | the keeper: the hold (opaque ids only), confirmed payout keys, each chain's lag (cached 15 s; `generatedAt` says when it was computed; `HEAD` answers the same without the body) |
| `GET /v1/health` | an uptime checker: 200 while a tick completed in the last 5 minutes and no chain lags past the lag limit; else 503 and why (cached 15 s; `HEAD` answers the same status without the body, for checkers that default to it) |

The vault and account must be lowercase and there must be no query string (one spelling per resource, so the
cache can't be sidestepped). Every route answers 429 (with `Retry-After: 60`) past 60 requests a minute from one
IP, each route counted on its own (the keeper's status polls and a checker's health probes are minutes apart,
far under it); the site falls back to its own scan on it, as on any refusal. The status and the health are served
through the Workers Cache for 15 s, so a burst at them reaches D1 once per 15 s per Cloudflare location, and a
cached answer is never counted; a D1 failure (503) is never cached, so the next request reaches a recovered
database.

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

- **`TOKENS`**: the public contracts the monitor reads (Multicall3, FM-TAO, USDC, WETH, the two oracle pools, the
  OffRamps) and the rail's contracts it watches for admin events: `base.fmTao` and `base.tokenPool` (FM-TAO's CCIP
  burn-mint pool, `0xF5AC6D6Bd12d8b87dE3c136FAc9375961577e794`), `bittensor.fmTao` (wTAO), `bittensor.lockPool` and
  `bittensor.alphaVault`. A watched contract can't share an address with the deployment's on its chain.
- **`BACKING_HOLD`**: `"false"` as shipped in both; `"true"` lets `fmtao.backing_true`'s AlphaVault side raise the
  keeper's hold (switch it on as "What Cascade depends on" says, after a week of readings). Read in any case, spaces
  around it ignored; anything but true or false (or blank, which is false) is refused.
- **`DEPLOYMENT`**: the deployment's addresses and blocks. `pnpm config:from-record <ops record>` prints it from
  a verified ops record (addresses checksummed, Bittensor starting at the Bittensor adapter's block, which is the
  site's `NEXT_PUBLIC_CASCADE_BIT_BLOCK`). `env.test` already holds the v3 test deployment's; `env.production`
  holds the launch's (v3-launch).
- **Baselines**: each chain's `baselineBlock` is where the deployment's setup ends: an admin event at or before
  it is setup, never an alert. It is the record's last step on that chain, unless an owner action that belongs
  to the setup came later; `--setup-ends-base <block>` and `--setup-ends-bittensor <block>` move it there (never
  earlier than the record's last step, nor more than 100,000 blocks past it without `--force`). Scans still start at `startBlock`, so that history is indexed. v3-launch
  uses them: the Ledger accepted ownership after the deploy (front door at Base block 53297713, staker 53297722,
  vault at Bittensor block 9398435), so production's baselines are 53297722 and 9398435, not the record's
  53295834 and 9398130.
- **RPC URLs**: `BASE_RPC_URL` (state reads), `BASE_LOGS_RPC_URL` (log scans) and `BITTENSOR_RPC_URL`. The Base
  logs URL must **not** be `https://mainnet.base.org`: it refuses `eth_getLogs`. The default,
  `https://base-rpc.publicnode.com`, answers 100-block windows. Bittensor must be an archive node
  (`https://archive.chain.opentensor.ai`): the lite node keeps only minutes of logs.
- **The second logs RPCs**: `BASE_LOGS_RPC_URL_2` and `BITTENSOR_RPC_URL_2`, each one URL or a list of up to three
  tried in order until one answers (Base: `["https://base.gateway.tenderly.co", "https://base.drpc.org"]`;
  Bittensor: `https://bittensor-finney.api.onfinality.io/public`, OnFinality's public node, which serves batched
  `eth_getLogs` in 1.3–5 s a call; dRPC's Bittensor endpoint needs a paid plan). A keyed URL, or a JSON list, goes
  in `BASE_LOGS_RPC_URL_2_SECRET` / `BITTENSOR_RPC_URL_2_SECRET`. The hourly job re-reads each chain's newest
  re-read blocks through them (the settled point less the tick's re-read depth, 70 on Base and 400 on Bittensor,
  so the primary's log index lagging its head is never read as an omission; `logsCheckBaseBlocks` 600 and
  `logsCheckBittensorBlocks` 300 at most per run, in the chain's windows, within 20 requests) and compares the
  logs with what the primary had the tick store, so a primary that omits a watched log is noticed. An endpoint
  that fails (after one retry), or answers from a head short of the range's first window, verifies nothing and
  hands the whole range to the next in its list; the alert names the one that answered. A second opinion has to
  come from another provider: the config refuses a second URL on the same registrable domain as its primary (the
  lite node next to the archive node; a keyed dRPC primary next to the dRPC fallback: drop it from the list). An
  archive endpoint is best (a pruning second node reads as `indexer.logs_extra` warnings); a chain none of whose
  second endpoints has verified a window for 3 hours (failing, or behind) is `indexer.unverified`, and `pnpm smoke`
  tries each endpoint of each list on its own from your machine (not Cloudflare's egress, which public nodes
  rate-limit harder), printing each one's result. **Why this Base list** (tested 2026-10-31 with the check's own batch, two `eth_getLogs` over 100 blocks
  and `eth_blockNumber`, a few times each): Tenderly answered every time in 150–520 ms with the same logs as dRPC;
  dRPC answers from a home IP but has answered the production Worker with HTTP 429 since 14:17 UTC that day, so it
  is the fallback. Keyless Base endpoints that don't fit a 100-block window: `mainnet.base.org` (`eth_getLogs`
  "request limit reached"), `1rpc.io/base` and `base-public.nodies.app` (50 blocks at most), `base-mainnet.public.blastapi.io`
  and `base.meowrpc.com` (10), `base.llamarpc.com` (a Cloudflare challenge page), `base.api.onfinality.io/public`
  and `api.zan.top` (HTTP 429, a key wanted), `base.blockpi.network` (a key wanted).
- **Budgets** (two profiles; both environments are set to Paid):

  | Var | Workers Paid (set) | Workers Free (fallback, not viable for a full batch) |
  |---|---|---|
  | `SUBREQUEST_BUDGET` | 200 | 45 |
  | `DECODE_BUDGET` | 5000 | 100 |
  | `SITE_FILES_PER_RUN` | 20 | 2 (1 if the site has a chunk near the byte cap) |
  | `SCAN_WALL_S`, `LEASE_S`, `SITE_MAX_BYTES` | 40, 180, 2000000 | the same |

  On Paid, raise `DECODE_BUDGET` and `SUBREQUEST_BUDGET` if a backfill is slow. The Free column is not viable
  for a full batch: hashing and decoding a log costs about 110–125 µs (measured in local workerd), so a full
  batch delivery (one block of about 205 logs, which the scan can't split) needs about 23–26 ms, over Free's
  10 ms per invocation, and the tick that meets it is killed every minute until it settles.
- **Thresholds**: every number the rules use is in `src/thresholds.ts`. Override any of them with the
  `THRESHOLDS` var (public) or the `THRESHOLDS_SECRET` secret (wins over the var, for values you'd rather not
  publish), as JSON, e.g. `{"keeperMinEthWei":"3000000000000000","rules":{"off":["fmtao.mint_surge"]}}`.
  Amounts are decimal strings; unknown keys are refused.
- **Secrets** (`pnpm wrangler secret put <NAME> --env <env>`): `ALERT_TO` (the recipients, comma-separated:
  never in the repo); optionally `THRESHOLDS_SECRET`, and keyed RPC URLs as `BASE_RPC_URL_SECRET`,
  `BASE_LOGS_RPC_URL_SECRET`, `BITTENSOR_RPC_URL_SECRET`, `BASE_LOGS_RPC_URL_2_SECRET` and
  `BITTENSOR_RPC_URL_2_SECRET`. A secret can't share a var's name (the Worker sees one value per name), so each
  override is the var's name plus `_SECRET`, and it wins over the var.

## Deploying (the owner does these)

Nothing in this repository logs in, creates a resource or deploys. These steps are yours. Run them from the
repository root.

0. **The plan.** Workers plans apply to the whole Cloudflare account. The decision (open question 1) is
   **Workers Paid** ($5/month), with `test` and `production` side by side in one account. Confirm it in the
   dashboard under **Workers & Pages → Plans** before deploying.

   If the account were to stay on Free instead: run **one environment per account** (`production` in the main
   account, `test` in a second, free account), never both in one Free account (eight crons exceed its five,
   and both would share one set of daily quotas), and set the Free budget column above, knowing a full batch
   delivery doesn't fit Free's CPU limit (see Configuration). The test Worker in a
   second account then has two limits: it **can't send email from cascadefi.xyz** (a Worker sends only from an
   Email Routing domain in its own account, so it stays in `ALERT_MODE=log` or uses a domain of its own), and it
   **can't use `api.cascadefi.xyz`** (a custom domain must be a zone in its own account: it uses its `workers.dev`
   URL).
The order matters: wrangler offers to create things when a step comes too early (a secret put before the first
deploy creates an empty Worker), so deploy first, in log mode, and add the email secret after.

1. Install and test: `pnpm --dir indexer install && pnpm --dir indexer test`.
2. Log in: `pnpm --dir indexer wrangler login`.
3. Create the database: `pnpm --dir indexer wrangler d1 create cascade-indexer-test`. When it asks whether to
   add the binding to your config, answer **No** (it would add a top-level binding the environments don't use).
   Paste the printed `database_id` over `local-only-test` in `env.test` of `indexer/wrangler.jsonc` (an id, not
   a secret). For production later, the same with `cascade-indexer-production` into `env.production`.
4. Create the tables: `pnpm --dir indexer wrangler d1 migrations apply cascade-indexer-test --remote --env test`.
5. The deployment: `env.test` already holds v3-test's. For another deployment:
   `pnpm --dir indexer config:from-record ../ops/deployments/<record>.json` and paste what it prints into that
   environment's vars.
6. The approved site lists: build the site you are about to deploy, then
   `pnpm --dir indexer site:approved ../web/out`, review the change to `indexer/src/site-approved.ts` and commit
   it. **Run it on the exact `web/out` that was (or is about to be) deployed, never on a rebuild**: Next gives
   every build a new random build id, so a rebuild of the same commit has different inline scripts, so different
   CSP hashes, and the lists would match no live page. If `web/out` has been rebuilt since the deploy, rebuild
   and redeploy the site too, then run this on that `out`. Until this is done, the site check judges nothing and says so (`site.no_approved_lists`). It writes the
   addresses; the **script hosts**, hosts the pages really load a script from (a cross-origin `<script src>`, or
   a host in a `script-src` of `out/_headers`: none today); the hosts **seen in the bundle**, which a page or
   script may name but never load a script from (a dependency's gateways, such as arweave.net and ipfs.io, are
   only seen); and each page's **Content-Security-Policy** from `out/_headers` (it refuses a build without one
   for every page). When the site check reports something Cloudflare itself injects into the served pages, check
   it is Cloudflare's and run it again with `--extra-script-hosts <host>` for a script loaded from it (the Web
   Analytics beacon, `static.cloudflareinsights.com`) or `--extra-hosts <host>` for a host a `/cdn-cgi/` script
   names (comma-separated for several): the hand-added hosts are named in the file, so they stay reviewable in
   git. **Re-run this, commit it and redeploy the Worker on every site deploy**: each build changes its pages'
   inline-script hashes, so their policies. A live policy that differs from the approved one only in those
   hashes is the warning `site.stale_lists` (the lists are out of date; it clears on the first pass after the
   Worker has the new lists, within the hour); any other difference (a new host, `'unsafe-inline'`, a directive
   or policy gone, the header missing) is a critical `site.integrity`.
7. Deploy, still in log mode (`"ALERT_MODE": "log"` as shipped, which needs no `ALERT_TO`):
   `pnpm --dir indexer wrangler deploy --env test`. Add the custom domain (`api.cascadefi.xyz`), or use the
   `workers.dev` URL to start.
8. Email (open question 2). In the dashboard: **Email Service → Email Routing**, onboard the sending domain
   (cascadefi.xyz; it adds MX and SPF records, so check nothing else receives mail there first, or use a sending
   subdomain), then add and **verify** the destination address. Then, the Worker existing now:
   `pnpm --dir indexer wrangler secret put ALERT_TO --env test` (the verified address), and optionally the
   `THRESHOLDS_SECRET` and `*_RPC_URL_SECRET` secrets. Then set `"ALERT_MODE": "send"` in `env.test`'s vars
   and deploy again (step 7's command).
9. Watch `GET /v1/status` until both chains' `lagS` are small: the first backfill takes an hour or so, and the
   digest says "catching up" meanwhile (its lag alerts are quiet then, and a cross-check waiting on it isn't
   reported stuck). Expect the first digest at 13:00 UTC. Trigger one warning on purpose to see an email
   arrive, e.g. `THRESHOLDS` `{"keeperMinEthWei":"1000000000000000000000"}` (a keeper floor above the real
   balance), then remove it. Two warnings stand from the first ticks on production, both real (read live
   2026-10-31): `keeper.low_tao` (the keeper holds 0.06 TAO and a claim needs 0.295 up front: top it up) and
   `oracle.cardinality` (TAO/WETH keeps 600 observations, growing to 2,000 as swaps come: it clears by itself).
10. **An outside uptime check on `/v1/health`** (required): a free checker that emails you when it stops
    answering 200. The Worker can't watch itself for everything: if it refuses its config (a bad value after an
    edit, a missing secret in `send` mode), no job runs at all, the watchdog and the digest included, and it
    stays silent. `/v1/health` answers 503 then (no tick has completed), which only an outside check sees. It
    answers 503 too while a chain's settled history lags past the lag limit (the keeper's: 30 minutes at launch),
    e.g. `base is 61 minutes behind (limit 30 minutes)`: ticks completing while an RPC refuses a chain is a blind
    monitor, and the outside check sees it even when email is broken. A chain catching up in the first backfill
    isn't counted (one stuck then is). A missing daily digest is the weaker sign.
11. Rate limiting on the API needs nothing set up: the Worker counts `/v1/scan/*`, `/v1/status` and `/v1/health`
    requests itself with Workers Rate Limiting (the `SCAN_LIMITER` binding in `wrangler.jsonc`, deployed with
    it: 60 a minute per client IP, per Cloudflare location, approximate, each route under its own key) and
    answers 429 past it; cached answers never reach the Worker, so never count. A WAF rate-limiting rule on
    `api.cascadefi.xyz/v1/*` in the dashboard is optional on top (it would also count cached answers, and stop
    floods before the Worker runs).
12. The site: set `NEXT_PUBLIC_CASCADE_INDEXER_URL` (after the site tasks). The keeper: set `OPS_HOLD_URL`
    (after the keeper tasks).
13. Production: the same steps with `--env production` (its database `cascade-indexer-production`). Step 5 is
    done: `env.production` already holds v3-launch's `DEPLOYMENT`.
14. **After any deploy that changes a second logs endpoint** (`BASE_LOGS_RPC_URL_2`, `BITTENSOR_RPC_URL_2` or their
    `_SECRET`): `pnpm smoke` only shows they answer from your machine, and public nodes treat Cloudflare's egress
    harder. After the next hourly run (minute 17), confirm from the Worker's own record that the chain's marks
    cleared and its range moved on:

    ```sh
    pnpm --dir indexer wrangler d1 execute cascade-indexer-<env> --remote --env <env> --command \
      "SELECT k, v FROM meta WHERE k IN ('logs_check_fail_since:base', 'logs_check_error:base', 'logs_check_to:base', 'logs_check_at:base')"
    ```

    `logs_check_fail_since:base` and `logs_check_error:base` both empty, and `logs_check_at:base` at the last run,
    mean an endpoint verified a window (an open `indexer.unverified` resolves on the next tick). A set mark with an
    error naming every endpoint means none answered the Worker (or each was behind): add another provider to the
    list.

## When an email arrives

Every alert says what happened, where to look (explorer links and hashes only, never a link to sign anything)
and what to do. Criticals arrive at once and are re-sent hourly (at most 6 times) until acknowledged; warnings
arrive together at most every 30 minutes; a critical condition that clears sends a "resolved" email. Act from
your own tools, never from a link in an email.

A condition resolves only on a reading that shows it cleared. A tick that can't judge it (that chain's reading
missing, a field the rule needs unread or undecodable, a ×2 rule with no older reading to confirm, or the rule
throwing) keeps its open alert open: not resolved, no "resolved" email, and sent as any open alert is (a first send
that failed is retried, a warning goes out with the next digest, a critical is re-sent hourly until acknowledged);
the next reading that still shows it continues the same alert rather than opening a new one (`unjudged` in
`src/rules/context.ts`). So a condition alert stays open through an RPC hiccup.

A read that breaks for good while the chain still answers (a Subtensor runtime change breaking the `Delegates`,
`Uids` or `TotalHotkeyAlpha` decode, an AlphaVault upgrade dropping `backing()`) would leave its rule blind with no
alert of its own, so **`monitor.unjudged`** (critical) pages once any critical rule has been unjudged on every tick
for `unjudgedCriticalS` (30 minutes; since when: meta `unjudged_since:<rule>`): a critical condition whose reading or
field is missing, or any rule that keeps throwing and can raise a critical, events included (`keys.unexplained_tx`,
`fmtao.role_change_critical`, the price and stake rules). `site.integrity` waits `siteUnjudgedS` (3 hours): it is
judged once an hourly pass, so one incomplete pass stays `site.unreachable`'s warning and about three in a row page.
Its alerts are grouped by onset (key `monitor.unjudged:<since, floored to 10 minutes>`, each listing its rules and
since when): a whole chain out is one email, a rule going blind later is a new alert and email of its own (even with
the first acknowledged, or past its last resend), and each group resolves when its rules are judged again. Rules
switched off in `rules.off` aren't counted. The email says what to check.

Two consequences, both erring toward alerting:

- **"Since" marks survive an unjudged gap.** A rule that times a condition in meta (`twap_off_since`,
  `rate_limited_since:*`, `lock_outside_since`, `idle_since` and the like) leaves its mark alone while it can't
  judge, so the first judged reading after a long gap that still shows the condition can trip at once, without
  waiting out the window again.
- **A hold can be raised twice.** A holding rule raises its hold on the first tick of an occurrence (`onset`); when
  the reading before last couldn't be judged, it can't tell the condition was already there, and raises the hold
  again under a new id: one more hold to look at and clear (pinned in `test/worker/rules-unjudged.test.ts`).

**Which conditions note what they can't judge.** Every condition rule was audited (2026-10-31). Changed to mark
unjudged: `batch.past_max_wait`, `payout.overdue`, `delivery.overdue`, `keeper.low_eth`, `keeper.low_tao`,
`keeper.idle_unstaked`, `adapter.low_reserve`, `cap.nearly_full`, `batch.one_wallet`, `unstakes.tiny_wave`,
`outflow.near_limit`, `rewards.uncollected`, `validator.not_earning`, `rail.alpha_vault`, `indexer.lag` and
`indexer.blind`, `fmtao.backing_true` and `fmtao.lock_outside`, `rail.alpha_vault_admin`, `validator.take_high`,
`validator.root_stake_drop`, `validator.root_uid_lost`, `ccip.rate_limited`, `root.unlock_interval`,
`oracle.cardinality`, `oracle.reverted`, `payout.fee_ceiling`, `fmtao.unbacked`, `twap.divergence`,
`pool.liquidity`, `frontdoor.solvency`, `vault.solvency` and `site.integrity` (an incomplete pass). Left as they
were, because what they judge outlasts a missing reading already: `ccip.failure` and `ccip.undelivered` (the
message's stored state), `fmtao.depeg` and `price.reference_unavailable` (their verdicts kept in meta),
`bridge.check_stuck` and `bridge.payout_unchecked` (the check rows in D1), `keys.safe_unread`,
`indexer.unverified`, `monitor.chain_unreadable`, `monitor.email_failing` and `monitor.rule_failed` (counters and
marks in meta), and the other `site.*` warnings (the last pass's result). Events never resolve on a missing reading.

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

`keys.unexplained_tx` (an owner, pending-owner or guardian key) and `keys.keeper_unexplained_tx` (the keeper)
compare an address's transaction count (or a Safe's `nonce()`), read at the head, with the transactions Cascade's
settled logs explain. A count ahead of the logs waits `unexplainedTxGraceS` (15 minutes) before it is reported,
since the logs settle a minute or two behind the head. The count is read in a request of its own, so a
load-balanced RPC can answer it from an older head than the logs' (on 2026-10-31 the keeper's hourly roll was
reported as unexplained this way). A count is taken as stale only when that is provable: it is below the highest
count already read, or below one past the nonce of one of the address's own settled transactions (a Safe's, below
its reading plus each execution logged after the reading's block). A provably stale count is judged by what is
known instead, for at most `nonceBehindTicks` (10) count readings in a row (meta `nonce_behind:<chain>:<address>`
counts them; it must stay under the grace, so a count read too high is taken back before it can page, and a
`THRESHOLDS` that breaks that is refused); one more is a
reorg past the settle depth, and the count is taken. Any other count behind what the logs explain (a transaction
counted twice because it hadn't settled when the address was first watched, after a role change or on a fresh
database) is a new start at once, so a transaction no log explains can't hide in the gap. What is left: an own
transaction known only from an event's arguments (its nonce unknown: a user action such as a deposit sent from an
admin key) that settles on a stale tick before any fresh count saw it is reported as unexplained, and so is a
node's count that stays behind for more than 10 readings: both err toward alerting. And a reorg past the settle
depth (30 blocks on Base, 10 on Bittensor) that drops one of the address's settled transactions, followed within
those 10 readings by another reusing its nonce, isn't reported here: `indexer.reorg` warns of the vanished log, so
when it fires check the watched keys' transactions on the explorer. On v3-test the owner, guardian and keeper are
one address, so a reverted keeper call pages as a critical `keys.unexplained_tx`: expect that noise there.

### The vault's stake and its direct entry points

The share price is `totalAssets / totalSupply`, and `totalAssets` counts the vault coldkey's root stake **on the
hotkeys the vault lists** (`rootStakeRao()`, at most 4). A validator's hotkey swap moves every nominator's stake,
the vault's included, to the validator's new hotkey, which the vault doesn't list: the price falls to what the
vault's liquid balance alone is worth, and until the new hotkey is re-added with `addHotkey` (owner, guardian or
keeper) a batch delivery or a `depositDirect` mints shares at that price. Every tick reads where the stake really
sits (`SubtensorModule.StakingHotkeys` for the vault's coldkey, and `getStake` on each of those hotkeys, the
listed ones and the configured stake hotkey), so the monitor names the hotkey to re-add:

| Alert | Tier | What it means | What to do |
|---|---|---|---|
| `stake.divergence` | critical, **holds** | the vault's counted stake fell by what now sits on a hotkey the vault doesn't list (a material share, `stakeDivergenceMinBps`, of the vault), on two settled readings in a row: a hotkey swap, stake moved off a listed hotkey, or the configured stake hotkey removed with stake still on it; the email names the hotkey, the stake on it, what the vault counts, the unexplained fall since the hotkey appeared and what the chain holds. The fall is a running sum from the hotkey's first sight: each pair of settled readings adds its own fall net of the vault's `Staked` and `Unstaked` in between (so an honest unstake hours later is netted while its log is there, never counted once it has scrolled out), kept in meta `unlisted_since:<hotkey>` | guardian `pause()` the vault (deliveries, direct deposits and payouts stop); owner, guardian or keeper `addHotkey(<the hotkey>)` (if the set is full, owner `removeHotkey` an empty one first); check the price recovered, clear the hold, unpause. `stake.unexplained_drop` sees the same swap as stake leaving the listed hotkey and holds at once; this alert then names where it went and raises no second hold while that one is on (`price.drop` and `stake.hotkey_changed` fire from their own angles too) |
| `stake.unlisted` | warning | stake on a hotkey the vault doesn't list **without** a matching fall in its counted stake: a stranger's `transfer_stake` (anyone can push stake onto any coldkey, from about 0.0005 TAO, which also lists their hotkey under it), or an amount below the hold threshold | nothing is held. Sweep it when worth a transaction: `addHotkey(<the hotkey>)`, then owner `removeHotkey(<the hotkey>, true)` moves it onto the stake hotkey (its depositors get it through their shares); acknowledge dust |
| `vault.stake_moved` | warning | a `StakeMoved` onto the configured stake hotkey below `stakeMoveCriticalRao` (100 TAO): `moveStake` or `removeHotkey`, owner only; the sender is named | your own change: acknowledge. Not yours: the owner key is compromised, guardian `pause()`, rotate |
| `vault.stake_moved_unexpected` | critical | a `StakeMoved` to a hotkey that isn't the configured stake hotkey (the vault's stake hotkey was changed first: see the `StakeHotkeySet` admin alert), or of `stakeMoveCriticalRao` or more at once | if you didn't, assume the owner key is compromised: guardian `pause()` the vault now, rotate; check where the stake sits on taostats |
| `vault.direct_use` | warning | a `DepositedDirect`, `RedeemedDirect` or `FrontDoorRedeemsAllowed` (the launch offers none; the user is named) | check the user; if the share price isn't right (a swap in progress), guardian `pause()` the vault: `depositDirect` and `redeemDirect` stop while paused |
| `vault.direct_use_large` | critical | a direct deposit or redeem of `directCriticalWei` (10 TAO) or more, or **any** direct deposit while a hold is on (the price is in doubt) | guardian `pause()` the vault until the price is checked; if the price was depressed when the deposit minted, those shares are the loss: find the cause (`stake.divergence`, `price.drop`) before unpausing |

The thresholds (`stakeDustRao`, `stakeDivergenceMinBps`, `stakeMoveCriticalRao`, `directCriticalWei`) are in
`src/thresholds.ts` and can be set in `THRESHOLDS`. The `StakingHotkeys` storage key is worked out offline (`src/subtensor.ts`);
`pnpm smoke` checks the live chain answers it with a list that holds the stake hotkey.

### What Cascade depends on and doesn't control

Cascade's TAO crosses ForeverMoney's rail: on Bittensor the AlphaVault turns TAO into wTAO, the CCIP lock-release pool
locks wTAO, and on Base the burn-mint pool mints FM-TAO for it (the same lock pool also serves a Robinhood lane). One
2-of-3 Safe of ForeverMoney's (`0xADF60fcC63217961c931d57f1dCE2C5d70Af3546`, the same three owners on both chains) is
FM-TAO's admin and CCIP admin, both pools' owner (and the Base pool's rate-limit admin), and the AlphaVault's admin,
guardian, operator and CCIP admin. The vault's stake earns through one validator (tao.bot's hotkey, take 0), and
Bittensor's rules for root stake apply to it. None of that is Cascade's to change, so the monitor watches it:

- **Readings** (in the two multicalls every tick already makes): the AlphaVault's `isPaused`, `pausedUntil`,
  `pauseableAfter`, `migrationReadyAt`, `migrationTarget`, `migrationExecuted`, `migrationFinished`,
  `pendingDefaultAdmin` and `backing(wTAO)`; wTAO's supply and the lock pool's wTAO; both pools' buckets for the
  Base-Bittensor lane (`getCurrentInbound/OutboundRateLimiterState`); the stake hotkey's take, root stake and root uid
  and `RootStakeUnlockInterval` (SubtensorModule storage through the 0x807 precompile); the vault's
  `claimGasRequired`, `maxFeeAbs`, `maxFeeBps`, `maxMessageValue` and `primaryBridge`, the block's base fee, and the
  primary bridge's `maxMessageValue` and `quoteFee` for a full payout chunk (100 entries, worth the lower of the two
  `maxMessageValue`s the last reading named: 15 TAO live, so a fee in basis points is priced); each oracle pool's
  observation cardinality (from the `slot0` already read).
- **Events**: FM-TAO and its pool on Base, wTAO, the lock pool and the AlphaVault on Bittensor (`TOKENS`), for their
  admin events only (`DEPENDENCY_EVENTS` in `src/abi.ts`: role grants and revokes, CCIP admin and ownership transfers,
  the rate-limit admin, lanes, remote pools, the router, the lock pool's liquidity, the AlphaVault's scheduled admin
  transfers). Each log window's request carries a second, topic-filtered `eth_getLogs` for them, so none of FM-TAO's
  transfers is ever read. They are stored under their own roles (`fmTao`, `tokenPool`, `alphaVault`), recognised on
  re-reads, and re-read by the hourly logs cross-check like the deployment's own (from the first block a tick read
  with their filter, meta `watch_from:<chain>`, so the first run after this version is deployed can't call older ones
  omitted). What each really covers (none of these events was observed in a log; the signatures are the libraries'):
  the pools are Chainlink TokenPool 1.5.1 (read live); the AlphaVault answers AccessControlDefaultAdminRules' views;
  FM-TAO on Base is not Chainlink's BurnMintERC20 but answers OpenZeppelin AccessControl's views, so its role events
  are OpenZeppelin's, and its `CCIPAdminTransferred` is Chainlink's signature, assumed. wTAO on Bittensor isn't
  AccessControl at all (only `getCCIPAdmin` answers), so its role watch is inert: wTAO is really covered by the
  AlphaVault's events and the backing readings.
- **Cost per tick**: no request of its own. 23 more calls inside the two multicalls (21 on Bittensor, 2 on Base;
  the fee quote's message makes Bittensor's about 13 KB larger), one more `eth_getLogs` inside each log window's
  existing batch (a steady tick makes the same requests as before; the hourly cross-check too), a few more fields in
  the stored reading and the hour row, and meta written only when a mark changes. Decoding the extra answers takes
  microseconds. Admin events are rare; each is hashed and decoded once (the decode budget counts them) and its
  transaction fetched once for its sender. All four logs endpoints (publicnode and dRPC on Base, OpenTensor's archive
  and OnFinality on Bittensor) answered the batch with its 21-topic filter on 2026-10-31, and so did Tenderly's Base
  gateway, the second endpoint since.

| Alert | Tier | What it means | What to do |
|---|---|---|---|
| `fmtao.backing_true` | critical; the `alpha` side holds only once `BACKING_HOLD` is on (off as shipped) | `alpha`: on two readings, the AlphaVault's `backing(wTAO)` below wTAO's supply by more than `backingToleranceBps` (0.1%): FM-TAO on every lane is under-backed (read live 2026-10-31: 13,992.86 TAO against 13,985.65 wTAO, 100.05%). `lock`: more than `lockOutsideCriticalBps` (5%) of wTAO's supply outside the lock pool for over `lockOutsideS` (an hour; meta `lock_outside_critical_since`): wTAO left the pool without FM-TAO being burned (a drain or a forged release), seen while it is held. Never a hold: anyone can mint wTAO with `depositLiquid` (simulated live) and keep it; and a drain unwrapped at once burns the wTAO, keeping supply and lock level, which only `fmtao.unbacked` (Base) sees | `alpha`: guardian `pause()` the front door and the vault (a payout sends TAO into this rail); tell ForeverMoney and Chainlink; unpause (and clear the hold, if one was raised) only once the backing is back. `lock`: look at wTAO's largest holders and the pool's last transfers; a release to someone who burned no FM-TAO is a drain (pause both, tell ForeverMoney), a holder that deposited for it is not (acknowledge). Users' TAO in the vault is staked on Bittensor, not held as wTAO |
| `fmtao.lock_outside` | warning | `lockOutsideMinWei` (100 TAO) or more of wTAO outside the lock pool for over an hour (meta `lock_outside_since`; 0.047 TAO was on 2026-10-31). Usually someone holding wTAO unwrapped (anyone can mint it; unwrapping and re-wrapping toggles it); possibly a drain starting | look at wTAO's largest holders and the pool's last transfers; acknowledge a holder; act as `fmtao.backing_true` says on a drain |
| `fmtao.role_change_critical` | critical | a transaction with a watched admin event that can mint, release or move the rail's tokens: `MINTER_ROLE` (or FM-TAO's admin role) granted, a role's admin changed, a remote pool or lane added, a pool's router changed, the lock pool's liquidity withdrawn, the AlphaVault's admin transfer scheduled, a pool's ownership transfer requested, a lane bucket switched off, or Cascade's lane removed. One alert per transaction (keyed `<chain>:<tx>`), every watched event in it listed, so a pool upgrade is one email. A bucket at capacity 0 is a bucket switched off: on TokenPool 1.5.1 capacity 0 is only allowed with the limit disabled, so that direction has **no limit**; only `ChainRemoved` freezes a lane | ask ForeverMoney whether it was planned (a pool upgrade grants `MINTER_ROLE` to the new pool and adds remote pools). If not, or until you know, guardian `pause()` the front door and the vault, and watch `fmtao.backing_true`, `fmtao.mint_surge`, `fmtao.depeg`. **After a planned pool upgrade**, set `TOKENS.base.tokenPool` and `TOKENS.bittensor.lockPool` in `wrangler.jsonc` to the new pools and redeploy: otherwise the lane buckets, `fmtao.unbacked`, the lock readings and these events keep watching the old pools. Deploy it **at least three hours after the new pool's own setup transactions**: the hourly logs cross-check judges each block once, with the addresses watched then, about 80–140 minutes after it on Bittensor (3–25 on Base), so a run after the change would find the new pool's setup events, which the tick wasn't watching for yet, as one `indexer.logs_omitted` critical; sooner, expect that alert, check it lists only the new pool's setup, and acknowledge it |
| `fmtao.role_change` | warning | a transaction with only other watched admin events: a role revoked or another role granted, the CCIP admin moved, an ownership accepted, the rate-limit admin set, a rate limit tuned, a remote pool or another lane removed | check it matches something ForeverMoney announced, and acknowledge; ask them if not |
| `rail.alpha_vault` | critical | the AlphaVault paused (`isPaused`, or a guardian's `pausedUntil` still to come), a migration announced (`migrationReadyAt` or `migrationTarget` set), executed or finished | guardian `pause()` the front door (deliveries and payouts through a paused AlphaVault revert, so nothing is lost meanwhile); ask ForeverMoney why and until when; before a migration executes, decide with them whether the adapter can use the new vault |
| `rail.alpha_vault_admin` | warning | the AlphaVault has a default-admin transfer pending (`pendingDefaultAdmin`; it can be accepted once its schedule, 2 days after it was scheduled, passes) | ask ForeverMoney if it is theirs; if not, tell them now (the current admin can cancel it) and be ready to pause as `rail.alpha_vault` says |
| `validator.take_changed` | warning | the validator's take (SubtensorModule `Delegates`) moved and held on the next reading, or its entry is gone: `Delegates` is a ValueQuery, so no entry reads as the chain's default take, 11,796 of 65,535 (18%: the entry's default in the runtime metadata), and `validator.take_high` fires too | small: acknowledge. High or gone: move validators (below) |
| `validator.take_high` | critical | the take (no entry: the default 18%) above `validatorTakeMaxBps` (9%) on two readings: it keeps that share of the vault's root dividends | move validators: owner `setStakeHotkey(<new hotkey>)`, claim the old hotkey's rewards (`pnpm ops claim`), owner `removeHotkey(<old hotkey>, false)` (moves its stake onto the new one); check the price after |
| `validator.root_stake_drop` | warning | the root stake on the validator's hotkey (everyone's, `TotalHotkeyAlpha(hotkey, 0)`) more than 25% below its high of the last 24 hours, on two readings: nominators leaving. 1,021,436.95 TAO on 2026-10-31 | look the hotkey up on taostats; if the validator is winding down, move validators |
| `validator.root_uid_lost` | critical | the hotkey has no root uid (`Uids(0, hotkey)`) on two readings, after one was read: it was deregistered from root and the vault's stake on it earns no root dividends. uid 1 on 2026-10-31 | move validators (the stake stays the vault's) |
| `ccip.rate_limited` | warning | a bucket of Cascade's lane (either pool, either direction) under `ccipBucketMinWei` (10 TAO) for more than `ccipRateLimitedS` (10 minutes): a batch or payout bigger than what is left waits for it to refill (0.6 TAO a second, 5,000 TAO at most, both read live) | usually someone bridged a lot at once and it clears; if it stays empty, check the pool on ccip.chain.link and ask ForeverMoney; keep batches under the bucket's capacity |
| `root.unlock_interval` | critical | SubtensorModule's `RootStakeUnlockInterval` is set (above 0, unset on 2026-10-31) on two readings: root stake must then sit that many blocks after its last add, remove or claim before it can leave root, and anyone can restart that clock on the vault's coldkey with a `transfer_stake` gift, holding off the vault's unstakes and the payouts that need them | payouts revert and wait, nothing is lost; watch `payout.overdue`, keep enough unstaked TAO in the vault for the payouts due, raise it with the Bittensor team if payouts stall. There is no redeem-only pause: if they stall for long, guardian `pause()` the front door stops deposits, redeem requests and closes alike |
| `oracle.cardinality` | warning | a pool the TWAP oracle reads keeps fewer than `oracleMinCardinality` (901) observations on two readings: its 30-minute window of 2-second blocks doesn't fit, so a busy half hour makes `usdcValue` revert. TAO/WETH kept 600 on 2026-10-31, growing to 2,000 (its `cardinalityNext`) as swaps come: this warns until then | if it is growing to 901 or more by itself, wait; else anyone can call `increaseObservationCardinalityNext(2000)` on the pool |
| `oracle.reverted` | critical | the front door's oracle's `usdcValue` reverts (or answers something that doesn't decode: the reading counts both) on two readings: the keeper can't price a sale, so USDC deliveries stop (claims of TAO on Base still work). It replaces `twap.divergence`'s revert warning | see `oracle.cardinality`; it clears when the window is covered again; if it lasts, tell users deliveries are paused |
| `payout.fee_ceiling` | warning | the primary bridge's fee for a full payout chunk (100 entries, worth the most a chunk carries: the costliest) above `payoutFeeCeilingPct` (70%) of the vault's `maxFeeAbs` on two readings; once the fee passes it, chunks worth less than fee / `maxFeeBps` are refused (`FeeTooHigh`). 0.0013 TAO against 0.005 (26%) on 2026-10-31 | owner `setFeeLimits(bps, abs)` (at most 0.1 TAO) before the fee reaches it |
| `keeper.low_tao` | warning | (changed) the keeper's TAO below a round of actions (`keeperMinTaoWei`, 0.01) **plus a claim's gas up front**: (`claimGasRequired` + `claimGasMargin`, the keeper's 2M) × the base fee, 0.285 TAO at launch, so 0.295 in all. Bittensor takes a transaction's whole gas limit up front, so below this the keeper can't claim at all. The launch keeper held 0.06 TAO on 2026-10-31: this warns from the first tick | top the keeper up on Bittensor above the amount the email names |

`fmtao.unbacked` stays (Base's FM-TAO supply against the whole lock), with its blind spot: the lock also backs FM-TAO
on Robinhood, which it can't read, so the lock can fall well short of every lane before Base's supply crosses it.
`fmtao.backing_true` watches the lock against wTAO's supply instead. Every number above is in `src/thresholds.ts`;
each rule can be switched off in `THRESHOLDS` (`rules.off`).

**Switching on `fmtao.backing_true`'s hold.** `backing(wTAO)` is ForeverMoney's own view and its normal range isn't
known yet (100.05% on 2026-10-31, a 0.05% cushion over the 0.1% tolerance), so the alert ships without its hold
(`"BACKING_HOLD": "false"` in both environments). Each hour row keeps the ratio's lowest and highest, in parts per
million (`backingPpmLow`, `backingPpmHigh`). After at least 7 days of them:

```sh
pnpm --dir indexer wrangler d1 execute cascade-indexer-<env> --remote --env <env> --command \
  "SELECT MIN(json_extract(json, '$.backingPpmLow')) AS low, MAX(json_extract(json, '$.backingPpmHigh')) AS high, (MIN(json_extract(json, '$.backingPpmLow')) - 1000000) / 100.0 AS cushion_bps, (MAX(json_extract(json, '$.backingPpmHigh')) - MIN(json_extract(json, '$.backingPpmLow'))) / 100.0 AS spread_bps, COUNT(*) AS hours FROM hours WHERE hour >= unixepoch() - 7 * 86400"
```

Look at both numbers, the spread **and the low**:

1. **The spread**, `spread_bps = (high - low) / 100`: how far the ratio swings in a normal week. Start from
   `backingToleranceBps = max(10, 3 × spread_bps)`, rounded up.
2. **The low**, how close the worst hour came to 1,000,000 ppm (100%: exactly backed). `cushion_bps = (low -
   1,000,000) / 100` is how far above 100% it stayed (negative: below). The hold fires once the ratio drops under
   `1,000,000 - 100 × backingToleranceBps` ppm, so the worst hour cleared that line by `cushion_bps +
   backingToleranceBps` basis points: that must be at least `spread_bps` again (a normal week's swing from the low
   must not reach it); if it isn't, raise `backingToleranceBps` until it is. A `low` under 1,000,000 means wTAO was
   under-backed in some hour of the week: ask ForeverMoney why before switching the hold on, whatever the tolerance.
   With fewer than 168 `hours`, wait.

Then set `backingToleranceBps` in `THRESHOLDS`, set `"BACKING_HOLD": "true"` in that environment's vars (any case
works), and redeploy.

### The logs cross-check

The tick reads each chain's logs through one RPC. A node that omits a watched log (lying, or pruning) would
blind the monitor to that event with no lag, blind or reorg signal, so every hour a second, independent endpoint
per chain re-reads the newest settled blocks of the watched addresses, and its logs are compared, by the uid the
scan gives every log, with what the store holds for that range (`src/logs-check.ts`; the counts and a hash of
each side are in every alert's facts):

| Alert | Tier | What it means | What to do |
|---|---|---|---|
| `indexer.logs_omitted` | critical | the second RPC served watched logs the primary never did, in blocks the tick had already re-read from a node well past them, so the monitor's history and its rules missed them. One alert per chain, the logs (event, block, transaction) listed in it; re-sent hourly by the job until acknowledged, resolved by the job once the store holds every log it named | open the transactions on the explorer; if they are real, read the events and act on them as their own alerts would have had you, and switch the primary (`BASE_LOGS_RPC_URL` / `BITTENSOR_RPC_URL`, or the `_SECRET`) to another provider, then redeploy. The tick re-reads only 70 (Base) or 400 (Bittensor) blocks back, so a missed log isn't added by itself |
| `indexer.logs_extra` | warning | the store holds logs the second RPC, 70 or 400 blocks past them, doesn't serve (one alert per chain, the logs listed) | usually the second node pruned them (set an archive endpoint in `*_RPC_URL_2`) or lags its log index; if the explorer doesn't have a transaction either, the primary served a log that isn't on the chain: switch it and re-check what the rules decided on it |
| `indexer.unverified` | warning (condition) | no second RPC of a chain (every one in its list) has answered the cross-check for `logsCheckUnverifiedS` (3 hours): the primary's logs go unverified meanwhile. The email carries each endpoint's last error | check `BASE_LOGS_RPC_URL_2` / `BITTENSOR_RPC_URL_2`: a public node may refuse Cloudflare's egress (HTTP 429). Add another keyless provider to the list (one that answers a 100-block `eth_getLogs`: the README's "The second logs RPCs" names those that don't), or set a keyed URL in its `_SECRET` (another provider than the primary's); redeploy. Clears on the next run that answers |

A chain still catching up in its first backfill isn't cross-checked (an old range a non-archive second node may
not have), and a second node that hasn't settled the range yet is asked again next hour.

**Backfilling missed logs.** There is no backfill script: the scan itself is the backfill. The tick re-reads from
`scanned_to + 1 − REREAD` every minute, so rewinding a chain's `scanned_to` below the oldest missing log makes
the next ticks re-read from there (in windows of 100 blocks on Base, 1,000 on Bittensor: a long rewind takes
several ticks), store what was missing through `upsertLogs` (so deliveries and landings get their check rows)
and run the rules on it (an omitted admin event pages then, as it should have). Everything already stored is
left as it was: the tick loads what the store holds for the whole span it re-reads (up to `settled_to`, which
never moves back), so every stored log is recognised by place, none is hashed, upserted or judged again, no
event alert fires twice and no seed page is rebuilt (`test/worker/tick-rewind.test.ts` checks both):

```sh
pnpm --dir indexer wrangler d1 execute cascade-indexer-<env> --remote --env <env> \
  --command "UPDATE cursors SET scanned_to = <a block before the oldest missing log> WHERE chain = '<base|bittensor>'"
```

The `indexer.logs_omitted` alert then resolves by itself on the next hourly run that finds every log it named in
the store (or on acknowledgement, `pnpm alerts:ack`).

## Limits worth knowing

- **The site check is a tripwire over the scripts' text and the pages' policies.** An address or host built at
  run time (by string concatenation, or fetched from elsewhere) isn't seen; what stops such a script loading is
  the page's Content-Security-Policy (`script-src 'self'` and the build's own inline-script hashes), which the
  check compares with the build's on every page. A site that serves the monitor a clean copy and its users a
  tampered one can't be caught from outside, and telling them apart is easy: a Worker's requests carry a `CF-Worker`
  header naming its zone. The site check is for accidental and CDN failures, not a determined site owner. A file that stopped a site-check run points to the CPU
  limit (Workers Paid, or `SITE_FILES_PER_RUN=1`), not the byte cap.
- **FM-TAO's Base-only backing check is a weak backstop.** `fmtao.unbacked` compares FM-TAO's supply on Base with
  the Bittensor lock pool, which also backs FM-TAO on Robinhood (and any other lane), so the lock is far above Base's
  supply (read 2026-10-31: 8,855.69 TAO on Base against 13,985.61 locked) and only a large forged mint would cross it;
  a drain of the lock is invisible to it. `fmtao.backing_true` (the AlphaVault's backing against wTAO, and wTAO
  against the lock) covers what it can't, and still can't read Robinhood's supply itself.
- **`validator.not_earning` sleeps while the vault holds little stake.** It is judged only while the vault's stake on
  the stake hotkey is at least `notEarningMinStakeRao` (1 TAO; the vault's counted stake stands in when that read is
  missing): an empty vault's unclaimed rewards stay at 0 and used to page every day. A test run of a few dollars
  isn't watched by it; set the threshold lower in `THRESHOLDS` to watch one.
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
