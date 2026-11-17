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
A script that answers 404 or 410 is first checked against its page read again (once a pass): when the page no longer
names it, the site was redeployed mid-pass (a new build has new file names), so it is not reported, the page's
current scripts are checked instead, and the Worker log says so; when the page still names it, it is a broken site
and `site.unreachable` names the file as before. What the first reading of a page found (its policy, a foreign script)
is still judged. Files dropped this way are counted per pass; once `site.redeploy_race` (warning) sees 3 passes in a row
with drops, the site is changing under the check, and it resolves on a pass with none.

The **watchdog** emails `monitor.stalled` itself when no tick has completed for 15 minutes, even when the
database can't be written (then straight from memory). It runs with the hourly job, so a stall is noticed 15 to
about 75 minutes after the last complete tick. A tick that can't read or write its database sends one
`monitor.db_failing` email, at minute 0 only. Neither can speak when the Worker refuses its config: that is
what the outside uptime check on `/v1/health` is for (deploy step 10).

### Six routes

| Route | For |
|---|---|
| `GET /v1/scan/{vault}` | the site: the deployment-wide half of its scan (cached 30 s, CORS for `SITE_ORIGIN`) |
| `GET /v1/scan/{vault}/{account}` | the site: one account's half |
| `GET /v1/status` | the keeper: the hold (opaque ids only), confirmed payout keys, each chain's lag (cached 15 s; `generatedAt` says when it was computed; `HEAD` answers the same without the body) |
| `GET /v1/flow` | the site's /security page: public chain facts only (each chain's newest reading, bridge messages in flight, proposals and pending changes from the stored events; on v3.2 also its states, stake missing, deposits parked on Bittensor, payouts closed by the primary's `canSendPayouts()` and a route switched off, and an `exits` part: the payout delay, today's unstake limit and what it has burned, and the parked total with the oldest park's refund date) as JSON v1 (cached 15 s, CORS for `SITE_ORIGIN`, `HEAD` as above; 503 when D1 can't be read or the document can't be built, both never cached, or when the database holds another deployment than `DEPLOYMENT` or none yet, cached 15 s; a stale or missing chain reading is no 503: its numbers are null and its time says how old it is) |
| `GET /v1/price` | the site's outside-price check, **a veto only** (below): the newest outside reference price of TAO, as JSON v1 `{ v, usd, sources, at }`, or `{ v, unavailable, at }` with the reason (cached 15 s, CORS for `SITE_ORIGIN`, `HEAD` as above; 503 when D1 can't be read or the stored reading is damaged, never cached) |
| `GET /v1/health` | an uptime checker: 200 while a tick completed in the last 5 minutes and no chain lags past the lag limit; else 503 and why (cached 15 s; `HEAD` answers the same status without the body, for checkers that default to it) |

The vault and account must be lowercase and there must be no query string (one spelling per resource, so the
cache can't be sidestepped). Every route answers 429 (with `Retry-After: 60`) past 60 requests a minute from one
IP, each route counted on its own (the keeper's status polls and a checker's health probes are minutes apart,
far under it); the site falls back to its own scan on it, as on any refusal. The status, the flow, the price and the health are served
through the Workers Cache for 15 s, so a burst at them reaches D1 once per 15 s per Cloudflare location, and a
cached answer is never counted; a D1 failure (503) is never cached, so the next request reaches a recovered
database.

### The outside reference price (`/v1/price`): a veto only

Every fifth minute the tick asks the price sources (`PRICE_SOURCES`: CoinGecko and Coinbase) for TAO in USD and
takes the median. The reading is unavailable when no source answers or they differ by more than 2%. The tick stores
the newest reading in meta `reference` (one row, overwritten): `{ usd, sources, at }` or `{ unavailable, at }`,
`at` being when the sources were asked. The tick's log line carries each reading too, and meta `reference_reads` and
`reference_unavailable_since` (from `price.reference_unavailable`) keep the last hour's available reads and since
when it has been missing. No other history is kept. `/v1/price` serves the stored reading as it is.

- **It may only block a trade.** The site may refuse a stake or a USDC delivery request when the Base pools' TAO
  price is too far from it. It must never use it to approve or loosen a trade, nor as a price to trade at. The
  contracts' floors (the staker's TWAP floor, the delivery floor, the user's own minimum) stay the binding limits, so
  a wrong or forged figure here can only make a trade wait. Nothing is signed, as everywhere in this Worker.
- **Never a guess.** A source that fails, a disagreement, or no reading yet is served as unavailable with the
  reason, never as a 0 or as an older price. The reason carries no price (the sources' prices when they disagree
  are in the tick's log line only). No reading yet, or no `PRICE_SOURCES`, is `at: null`. A damaged row is 503.
- **The site judges its age.** The body always carries `at`, and the indexer never calls a reading fresh. A tick that
  fails, is refused, or skips the read (no budget left) leaves the old reading with its old `at`.
- **The same for every deployment.** It reads no contract, so v3-launch and v3.2 serve it alike, and it is served
  even when the database holds another deployment (no tick writes it then, so its `at` ages).

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
  site's `NEXT_PUBLIC_CASCADE_BIT_BLOCK`). From a v3.2 record (plan version 32) it also prints `version`, both
  lenses, `stage` `"early"`, each chain's start at its first create (the adapter's, unless another came first, which it
  notes), and `STANDBY_HOTKEY` from the plan's standby validator; it refuses a rehearsal's record, a voided plan and a
  deploy with a create not done. `env.test` already holds the v3 test deployment's; `env.production`
  holds the launch's (v3.2-launch since 2026-11-16; v3-launch's before, in git history). `version` names the contracts: absent (or `"v3.1"`) for v3-launch and v3-test,
  `"v3.2"` for a v3.2 deployment, which also needs `vaultLens` (on Bittensor) and `doorLens` (on Base): the scan
  then decodes v3.2's events and the readings go through the lenses. Neither lens is scanned. v3.2's contracts log
  their settings when they are deployed, so each chain's `startBlock` is its first deploy block at the latest, and
  its `baselineBlock` at least its last: those events are setup, never an alert. `stage` (optional) is the site's
  stage for the deployment (`"testing"`, `"early"`, `"live"` or `"retired"`, as `web/src/lib/cascade/deployments.json`
  has it): `admin.owner_kind` reads `"live"` as past the founder level; unset, only the caps say.
- **`STANDBY_HOTKEY`**: the standby validator's hotkey (32 bytes of hex). Its take, root stake and root uid are read
  beside the stake hotkey's, and the four validator rules judge it as they judge the primary, keyed by its hotkey, its
  emails saying "standby" (it isn't judged twice while it is the stake hotkey). Blank in both as shipped: no standby is
  read. The v3.2 deployment's entry sets it (Yuma's `0x40c47b6a…3209` at launch; `pnpm config:from-record` prints
  the record's).
- **Baselines**: each chain's `baselineBlock` is where the deployment's setup ends: an admin event at or before
  it is setup, never an alert. It is the record's last step on that chain, unless an owner action that belongs
  to the setup came later; `--setup-ends-base <block>` and `--setup-ends-bittensor <block>` move it there (never
  earlier than the record's last step, nor more than about 2.3 days of Base's blocks or 14 days of Bittensor's past it
  without `--force`, in blocks at the chain's block time read from its public RPC; 100,000 blocks while it can't be read). Scans still start at `startBlock`, so that history is indexed. v3-launch
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
  re-read blocks through them (the settled point less the tick's re-read depth, 140 s of Base's blocks and 4,800 s of
  Bittensor's at each chain's block time,
  so the primary's log index lagging its head is never read as an omission; `logsCheckBaseS` 1,200 (20 minutes)
  and `logsCheckBittensorS` 3,600 (an hour) at most per run, in blocks at each chain's block time as the tick
  measures it (meta `block_s:<chain>`: 6,000 of Base's 200 ms blocks, 60 windows of 100), within twice their
  windows and a few more requests) and compares the
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
11. Rate limiting on the API needs nothing set up: the Worker counts `/v1/scan/*`, `/v1/status`, `/v1/flow`, `/v1/price` and `/v1/health`
    requests itself with Workers Rate Limiting (the `SCAN_LIMITER` binding in `wrangler.jsonc`, deployed with
    it: 60 a minute per client IP, per Cloudflare location, approximate, each route under its own key) and
    answers 429 past it; cached answers never reach the Worker, so never count. A WAF rate-limiting rule on
    `api.cascadefi.xyz/v1/*` in the dashboard is optional on top (it would also count cached answers, and stop
    floods before the Worker runs).
12. The site: set `NEXT_PUBLIC_CASCADE_INDEXER_URL` (after the site tasks). The keeper: set `OPS_HOLD_URL`
    (after the keeper tasks).
13. Production: the same steps with `--env production`. Step 5 is done: `env.production` holds v3.2-launch's
    `DEPLOYMENT`. **A new deployment needs a new database:** a tick refuses a `DEPLOYMENT` changed under the database
    it has written to ("the database holds another deployment than DEPLOYMENT"). v3.2-launch's is
    `cascade-indexer-production-v32` (created 2026-11-16); v3-launch's history stays in `cascade-indexer-production`,
    which no Worker is bound to now. Wrangler's `d1` commands take the binding in place of a name, resolved in the
    environment's config (`pnpm wrangler d1 migrations apply DB --remote --env production`), and the owner's scripts
    (hold:clear, alerts:ack, checks:approve, alpha-target) name the database that way, so they follow the config.
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
`validator.root_stake_drop`, `validator.root_uid_lost`, `ccip.rate_limited`, `root.hold_interval`,
`oracle.cardinality`, `oracle.reverted`, `payout.fee_ceiling` (and R12a's `batch.redeem_fee_thin`), `fmtao.unbacked`, `twap.divergence`,
`pool.liquidity`, `frontdoor.solvency`, `vault.solvency` and `site.integrity` (an incomplete pass). Left as they
were, because what they judge outlasts a missing reading already: `ccip.failure` and `ccip.undelivered` (the
message's stored state), `fmtao.depeg` and `price.reference_unavailable` (their verdicts kept in meta),
`bridge.check_stuck` and `bridge.payout_unchecked` (the check rows in D1), `keys.safe_unread`, `keys.count_unread`,
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
since the logs settle a minute or two behind the head. A transaction is new on one tick only, the tick that first
stores it, so a tick whose count batch fails (an RPC answering HTTP 429) still counts the address's own transactions
settling on it, and what their nonces prove of the count, and judges nothing until a count is read again. Before
2026-11-01 it skipped the address first, so a transaction settling on such a tick was never counted: that is what
reported the keeper's hourly roll as unexplained on 2026-10-31 (count 12) and on 2026-11-01 (count 31), though the
first was taken at the time for the stale count below. While a chain's counts go unread nothing there is judged,
and `keys.delegated` is blind too (the role wallets' code is read in the same batch): `countUnreadTicks` (15) ticks
in a row of it is the warning `keys.count_unread` (meta `count_unread:<chain>` counts them), which resolves on the
next tick that reads the counts. A Safe, judged by its `nonce()`, has `keys.safe_unread` instead. The count is also
read in a request of its own, so a load-balanced RPC can answer it from an older head than the logs', and the floor
below stays as the defence against that. A count is taken as stale only when that is provable: it is below the
highest count already read, or below one past the nonce of one of the address's own settled transactions (a
Safe's: below its reading plus each `execTransaction` to it logged after the reading's block; only
`execTransaction` moves `nonce()`, a module's call doesn't). A provably stale count is judged by what is known
instead for up to `nonceBehindTicks` − 1 (9) count readings in a row, and the `nonceBehindTicks`-th (the 10th) takes the count, as a
reorg past the settle depth (meta `nonce_behind:<chain>:<address>` counts them). That reading must come before the
grace ends, so a count read too high is taken back before it can page: a `THRESHOLDS` or `THRESHOLDS_SECRET` that
would hold longer is clamped to fit, with a warning in the Worker's log (a shorter hold means more false alerts,
never a miss). Any other count behind what the logs explain (a transaction counted twice because it hadn't settled
when the address was first watched, after a role change or on a fresh database) is a new start at once, so a
transaction no log explains can't hide in the gap. What is left: an own transaction known only from an event's
arguments (its nonce unknown: a user action such as a deposit sent from an admin key) that settles on a stale tick
before any fresh count saw it is reported as unexplained, and so is a node's count still behind on the 10th
reading: both err toward alerting. Such a transaction (or any Safe execution) settling while an unexplained one is
already pending, on a stale or unread tick, can also postpone that alert: it nets the excess to zero until the next
read restarts the 15-minute grace, so a key that keeps sending them can delay the page, never cancel it. And a reorg past the settle depth (60 s of Base's blocks, 120 s of Bittensor's) that drops
one of the address's settled transactions, followed within those 9 readings by another reusing its nonce, isn't
reported here. `indexer.reorg` warns of the vanished log, but only within the re-read window (140 s of Base's blocks, 4,800 s of
Bittensor's); a deeper reorg falls to the hourly logs check (`indexer.logs_extra`). When either fires, check
the watched keys' transactions on the explorer. On v3-test the owner, guardian and keeper are one address, so a
reverted keeper call pages as a critical `keys.unexplained_tx`: expect that noise there.

### v3.2's scheduler, exits and owner

On a v3.2 deployment (`DEPLOYMENT.version` `"v3.2"`) every loosening owner change waits as a scheduled item, and the
email on each one is the single-key mitigation (spec §5): the guardian can veto an Ordinary item, and the owner's
signed stamp (`pnpm ops stamp`, relayed from any funded account) kills every item scheduled up to it. v3-launch's
admin rules are unchanged. The rules (`src/rules/admin.ts`) keep a record of the items scheduled and not yet closed
(meta `scheduled_items`, `src/scheduler.ts`): each is decoded once from its `Scheduled`'s calldata, its
`scheduled(id)` is read through the lens every tick (this tick's new ones too, at most 64), and the security page
(`/v1/flow`) shows the pending ones from the same record, judged the same way. An item the lens hasn't read is
shown, never taken for "nothing pending". A finished item (past its window, killed by a closure or a stamp, or one
that reverts at execute) is read, judged and shown by nothing, and forgotten once its window passes. The record holds
at most 256 live items (four times the read slots; about 256 KB, an eighth of D1's 2 MB value, so the tick's commit
can't fail on it) and 256 finished ones; past the live cap a `Scheduled` is still emailed, but refused: kept apart until
there is room, and still counted by `admin.record_full` until then.

| Alert | Tier | What it means | What to do |
|---|---|---|---|
| `admin.scheduled` | critical, at once | a `Scheduled` on the vault or the front door: its kind (who can cancel it), setter, arguments (decoded with the contract's ABI, and checked to be their canonical encoding), `readyAt`, the lens's `readyBlock`, until when it can run, and whether it loosens a limit against the current value | yours: check it, acknowledge. Not yours: sign an owner stamp before it is ready and have it relayed; the guardian can cancel an Ordinary item |
| `admin.executed`, `admin.cancelled` | critical, at once | an item ran (the events it logged itself are listed in it, not emailed apart; anything else in its transaction is emailed on its own) or was cancelled (by whom) | yours: acknowledge. Not yours: guardian closure, then undo and rotate |
| `admin.lapsed` | warning | an item can no longer run: both its windows passed unexecuted (its 7 days, and its window in blocks, as the contract judges it since Revision 28), a closure or an owner stamp since its scheduling killed it, it reverts at execute (`setMinPoolLiquidity` with an index above 1), or it was pruned | schedule it again if you still want it, after any closure or stamp |
| `admin.record_full` | critical | more items are scheduled than the record tracks (256 live): each is still emailed, and those refused at the cap aren't judged or shown. A refused item is kept apart (meta `scheduled_refused`: the oldest 256 in full, the rest as a count per chain) and taken into the record on a later tick with room. The alert holds until each is tracked, has run or been cancelled, or is past its window | relay an owner stamp, rotate the owner key |
| `admin.item_loosens` | critical | a pending item that didn't loosen when it was scheduled now would, on two readings (a direct tightening since moved the current value past it: the direction is judged at execute) | cancel it before it is ready if you don't want it |
| `admin.hotkey_switched` | critical | a `StakeHotkeySet` that its own scheduled item didn't run (the transaction's next `Executed` isn't `keccak256` of `setStakeHotkey(<that hotkey>)`'s calldata): the immediate switch, possible when the new hotkey already holds more stake than the old and half the booked stake (gifts count) | not yours: guardian `pause()` the vault, rotate the owner key |
| `admin.exits_state` | critical | either chain's exits machine isn't OPEN (the holds and who closed last, with what), or the launch chain has no active front door | closed on purpose: finish and reopen. Not: see who holds it |
| `rails.incoherent` | critical, holds | on two readings of both chains, the two chains disagree on the bridge while both may read OPEN: the front door's primary's Bittensor half isn't enabled on the vault (`rails.incoherent:batches`: deposits from Base are refused and parked), or the vault's primary's Base half was never enabled on the front door (`rails.incoherent:payouts`), or a pair's halves don't name each other. Or a primary is disabled on a chain whose exits read OPEN (the front door's: no batch can close; the vault's: no payout leaves), or the vault's disabled primary still carries the front door's batches, its exits closed or not | finish the two-sided switch, or switch the other side back; a disabled primary: reopen it, or switch both sides; halves that don't name each other: move both sides to a correct pair; a guardian can't fix it alone; clear the hold once it clears |
| `admin.owner_pending` | critical | `pendingOwner()` isn't zero and the new owner can still accept: a transfer ran, and acceptance stays open until `pendingSince` + 7 days unless a closure or an owner stamp comes first (it clears once acceptance can't happen) | yours: accept from the new owner. Not: any closure or an owner stamp refuses it |
| `admin.owner_kind` | warning | the owner isn't a Safe with a threshold of 2 or more and 3 signers or more (a delegated EOA counts as an account, and so does a contract that answers neither), while the stage is `"live"` or `"retired"` or a cap is above the founder level (a 40 TAO deposit cap, 44 TAO in the vault) | move the owner to a 2-of-3 Safe |
| `stake.set_full` | critical | stake is missing, the hotkey set is full and only the owner can free a slot for the swap's new hotkey (every other hotkey holds stake, or rewards beyond the dust allowance) | owner: claim, `removeHotkey` one, then `addHotkey` the new one |

`rails.incoherent` (`src/rules/rails.ts`, spec §5's residual beside row 4): each chain keeps its own bridges and
primary, so one side's switch alone, or a guardian's disable on the vault of a bridge the front door still uses, leaves
both OPEN while every batch is refused at one end. Every tick reads, in each chain's one multicall (one block), each
adapter in `BRIDGES` and the ones the last readings named (each primary, and the half the other chain's primary
names): its `remoteAdapter()` and `remoteChainId()`, and the lens's `bridgeEnabled` and `bridgeKnown` of it. The
vault takes a message only from a bridge it has enabled; the front door from any bridge it ever enabled, so a
disabled Base half still takes payouts and is no finding. A primary disabled on its own side is `admin.exits_state`'s
while that chain's exits read closed; on an OPEN chain (a swap ended the guardian's hold, the primary still disabled
until its Reopen) it fires here, naming the bridge and its pending Reopen, or "none scheduled". The vault's disabled
primary that the front door still sends through fires even while the vault's exits read closed: those batches park,
and a hold comes only with an alert, so it pages beside `admin.exits_state` to hold the keeper. No launch door is
`admin.exits_state`'s. A pending activation never counts as enabled, so a switch done in order (both activations, then
the front door, then the vault) raises nothing. A read that fails leaves the rule unjudged, never coherent. A primary
outside `BRIDGES` takes about four ticks to judge: one to read the primary, one to read it as a half and learn its
peer, one to read the peer on the other chain, and a second reading to confirm.

`admin.event` on v3.2: a `StampedBySig` emails once per `asOf` on its chain, and only when it moves the owner's clock
(meta `stamp_asof:<chain>`), so replays can't bury a `Scheduled`; a vault `LimitSet` names its setter, an
`ExitsClosed` or `ExitsReopened` its instrument; one pause, primary disable or launch-door removal is one email (its
`ExitsClosed`, naming the instrument's own event, the log just before it); any other disable or removal batched in
the same transaction is emailed on its own; `OutflowLimitsSet`, `StakeWrittenOff` and `PotSwept` are admin events.
The routine ones are not: `StakeAdopted` (the keeper's `adoptStake`, at most daily) is the warning `vault.stake_adopted`,
and both adapters' `SurplusSwept` (anyone's sweep, to the fixed treasury) is a line in the daily digest. Their
transactions are fetched all the same, so the keeper's call is never "unexplained".

`admin.record_full` is one alert per flood: a refusal more than an hour after the last one starts a new flood (meta
`record_full_episodes`), whose alert emails though an earlier one was acknowledged; every flood's alert stays while the
record is full, and all clear together. Past 8 floods, a new one is counted in the oldest flood's alert (`folded`), so no
key is dropped, and no "resolved" email goes out, while the record is still full. Each tick decodes a new `Scheduled`
once, and `admin.event` decodes none on a tick with no `Executed`. A record or refused list that doesn't read never
stops the tick's emails: every `Scheduled`, `Executed` and `Cancelled` is still sent, nothing is written over the damaged
value, and `monitor.unjudged` names it at once (`monitor.unjudged:record:<meta key>`) until it is repaired or cleared by
hand. A `RedeemReversed` email says what the cancel gave back in TAO.

### v3.2's stake guard and parks

On a v3.2 deployment the vault guards itself: it prices the lower of its booked and visible stake and mints nothing
while stake is missing, so `stake.missing` replaces v3-launch's `stake.divergence` (kept for v3-launch until it
retires). A swap's fall that `stake.missing` explains (the listed hotkey's stake reappears off the set on the vault's
coldkey, `unlistedStakeRao` rising by it, while `stakeMissing()` reads true) raises no `stake.unexplained_drop` and no
`price.drop`, so it holds nothing; any other fall still raises `stake.unexplained_drop` and holds the keeper, as on
v3-launch. A batch the vault refuses (or can't convert) parks in the Bittensor adapter instead of failing in CCIP.
`ccipReceive` logs `Delivered` after a park too, so the rules read `BatchParked` first: a parked message hasn't arrived
(`ccip.*` leaves it to `bridge.parked`), a stranger's park is no `ccip.unexpected_source`, a batch `deliverParked`
delivers later passes the batch check by its park (the park's message id and route, and the park key rebuilt from the
batch), and a refund landing on Base (chunk `4294967295`, the park's key, no `PayoutChunkSent`) is checked against its
park and the batch the front door closed (`src/crosscheck/refunds.ts`: each depositor's exact deposit, then
`delivered()`), never as a vault chunk. A stranger's park refunded to the stranger (the vault its sender) is no Cascade
message: a vault `Sent` counts only when it names the front door, so its failed delivery raises no `ccip.failure`. Every
open park's events are loaded each tick (`src/rules/context.ts`), so a park is judged whenever it began.

| Alert | Tier | What it means | What to do |
|---|---|---|---|
| `stake.missing` | critical | `stakeMissing()` on two readings in a row: the booked stake isn't on the listed hotkeys (a swap); names the hotkey whose stake fell (against the newest reading kept that wasn't missing, meta `stake_missing_fell`) and where stake sits unlisted, each position saying whether a stranger can list it (at least the chain's minimum) | list the swap's new hotkey (`addHotkey`; anyone may while it lasts); `stake.set_full` if the set is full |
| `batch.deposits_blocked` | critical | v3.2 (R4, A-L1; R7, L1; R8): the open batch the front door lets close because it is full (its own `canClose()` true before its interval: a list, or the room rule's half of the value limit or of the cap's room, or no room for a minimum deposit) is still open on 7 readings in a row (`FULL_UNCLOSED_READINGS`, the store's limit: the half rule makes full routine, and a busy keeper can take a few rounds to close it). The keeper closes a full batch on its next round, so nothing is closing it. Past its interval full can't be told from the clock (`batch.past_max_wait` watches that); unread, or too few readings: unjudged | check the keeper, its ETH and Base spend cap, and its holds; if someone holds the batch, the levers are `minDeposit` (`pnpm ops set-caps`) or the guardian's deposit pause, any limit set back in the same sitting (runbook 7.10) |
| `batch.cancel_churn` | warning | v3.2 (R8, the contracts review's L-1): one address's deposit cancels (`DepositCancelled`) in the open batch add up to `cancelChurnPct` (50%) of its `maxBatchValue`, or number `cancelChurnCount` (3): the pattern of a holder that deposits the batch full just after a keeper round and cancels before the next, so honest deposits revert `BatchValueFull` most of each minute (`batch.deposits_blocked` misses it: the batch never reads full seven readings in a row). Names the address, its cancels, the amounts and its deposits; one per address and batch, cleared once the batch closes. The open batch's cancels are prefetched whatever their age; the open batch unread, or its limit unread with nothing found by count: unjudged | no funds are at risk: a close that lands while it is full commits the holder (the keeper's each minute, a depositor's own from the site, or `pnpm ops close --live`); if it goes on, raise `minDeposit` or pause deposits, set back in the same sitting (runbook 7.10) |
| `batch.deposits_full` | warning | v3.2 (R6, L-2; build B's list half rule): at least 2 batches closed in the last 24 hours with their deposit list at half `maxDeposits` or more (25 of 50) of deposits averaging at most twice `minDeposit`. Such a list closes at once, its bridge fee paid by its closer (mostly the keeper), so lists filled to half with tiny deposits spend the keeper's ETH; a list left closable is `batch.deposits_blocked`'s | check the keeper's ETH; if it goes on, raise `minDeposit` (`setCaps`, runbook 7.10) |
| `stake.writeoff_read_gas` | warning | v3.2 (R6): the write-off's check of the unlisted stake (`getTotalColdkeyStakeOnSubnet` of the vault's coldkey, priced each tick by `eth_estimateGas`) costs more than `writeOffReadGasWarn` (10,000,000 gas) on two readings in a row; its cost grows with every position on the coldkey, which anyone can add, and past the vault's 45,000,000 cap the vault's own `WriteOffTooLarge` check fails open | nothing at once: a write-off rests on `pnpm ops execute`'s check and the guardian's veto; plan the next vault if it keeps rising |
| `stake.writeoff_bound_off` | critical | v3.2 (R11: ChatGPT r3, claim 1): the vault lens's `unlistedStakeRao()` reverts in an answered multicall on two readings in a row (its own `target()` checked), or (R12d) the estimate of that read (`stake.writeoff_read_gas`'s) is above the vault's 45,000,000 `WRITE_OFF_READ_GAS` on two readings, so the vault's capped read fails though the lens's uncapped one answers. It totals the vault's coldkey with `getTotalColdkeyStakeOnSubnet`, the read the write-off's bound makes; the vault takes a failed read as 0, so a write-off would run with no bound. Nothing on chain causes it today: most likely a runtime change. Unread (the lens unchecked or another vault's, no reading): unjudged | guardian: cancel any scheduled `writeOffMissingStake` (`pnpm ops pending --live`, then `pnpm ops cancel <id> --as guardian --for-wallet --live`); schedule none until the read answers again (runbook 7.5); find what changed in the runtime |
| `stake.missing_small` | warning | v3.2 (R6): `missingStakeRao()` above dust (`stakeDustRao`) on two readings in a row while `stakeMissing()` is false: the gap is inside the vault's tolerance, so deposits still mint at a price that leaves it out, and gain from the holders once the stake is listed | list the hotkey it moved to at once (`addHotkey`, owner, guardian or keeper): listing it closes the gap (`adoptStake` books only a surplus above the booked) |
| `stake.unlisted` | warning | v3.2: `unlistedStakeRao()` above dust while nothing is missing (a gift, or stake back after a write-off); only the owner, guardian or keeper can list it then, and the last slot stays shut | `addHotkey`, then the keeper's `adoptStake` books it |
| `stake.surplus_unadopted` | warning | a surplus of at least the chain's minimum for more than `surplusUnadoptedS` (a day; meta `surplus_since`) while adoption is allowed (a day since the last, and an hour more); time the vault is paused isn't counted (meta `surplus_paused_at`, `surplus_paused_s`) | check the keeper's adopt job |
| `stake.unstake_skipped` | warning | the unstake walk skipped one hotkey `unstakeSkippedCount` (3) times in `unstakeSkippedS` (a day; meta `unstake_skips`), not once | a root hold on the pair (`root.hold_interval`) or gas |
| `stake.min_raised` | warning, once | the chain's minimum stake rose above the last one known (meta `min_stake_known`); names the listed positions now below it (the walk skips them; a stranger can't list a smaller swapped one) | consolidate a position below it |
| `outflow.near_limit` | warning | v3.2: the base is the lower of visible and booked stake less what still ramps in (never the balance); this door's window and every door's (`globalOutflowBps`, the global window) each against its allowance | expect `RedeemDeferred` |
| `rail.payouts_closed` | critical | R4 (S-H1): the vault's primary bridge, as the reading names it, answers `canSendPayouts()` false (ForeverMoney paused, a migration announced or finished, or the adapter's read of it failing): the vault defers every front-door redeem meanwhile, so one finding names the open batch's redeem requests (deferred when it lands, their fees spent) and one each queued payout batch, its share entries apart from its bounces; why, from ForeverMoney's state beside it. Unjudged while the primary or its view is unread | a pause: wait, nothing to cancel; a migration: cancel each queued batch before scheduling the replacement rail (runbook 7.7); no close needs holding |
| `payout.no_rail` | critical, once | R4 (S-H1): a front-door `Redeemed` stored inside a closure of the primary the monitor saw (meta `rail_closed_since`: `since` or `since:until`, a closure that ended kept until the scan's settled block passes its end, so a burn stored late is caught): the vault should have deferred it (a primary with no such view reads open, a view over 150,000 gas, or another bridge read). One alert per delivery key | cancel the batch in a migration (runbook 7.7); check the primary's `canSendPayouts()` |
| `unstakes.wash` | warning, once | R4 (B-H1): a `Redeemed` or `RedeemDeferred` whose holder has a `Deposited` under the same key, or a `Deposited` or `DepositedDirect` within the window before it (the hold's day, 7,200 blocks, for a deferral; two, for a burn): the spec's stated residual, crowding the first-come allowance with a day's exposure. Never holds | acknowledge an honest holder; the same holders day after day: the pro-rata allowance is the founder's call |
| `payout.entry_above_cap` | warning | a queued entry not sent yet above the primary bridge's `maxMessageValue`: its chunk can't be sent | `setPrimaryBridge` to a pair that carries it, send, switch back |
| `bridge.parked` | critical | a front-door batch parked for `parkedCriticalS` (an hour) by the settled history (its time, or its block at Bittensor's block time as measured), one alert per park; or an adapter whose `parkedNative + parkedTokens` owe more than the parks seen, for an hour | fix the cause, `deliverParked`; `refundParked` after 14 days |
| `bridge.parked_stranger` | warning, once | a stranger's park (another sender, or another recipient: R3 A-L2) | nothing |
| `bridge.parked_tokens_during_migration` | critical, at once | ForeverMoney's `migrationReadyAt` is set while an adapter holds a token park | pause deposits, close the open batch, `deliverParked` every token park |
| `bridge.cushion_low` | warning | an adapter's TAO above `parkedNative` under half its `RESERVE_TARGET`, or its booked `tokenCushion()` under half its `TOKEN_RESERVE_TARGET` (0.001 each; `CUSHION_LOW_DIVISOR`): any `sweepSurplus` leaves exactly the reserve's target and the cushion falls a rao per shortfall it covers, so a few rao under is expected. Since R4 the cushion is what `fundCushion` booked (`CushionFunded`), never the wTAO above the parks: a plain transfer is surplus, the sweep's, shown as a fact; an empty booked cushion says so | `fundReserve()`; approve wTAO, then `fundCushion(amount)` |
| `bridge.refunded`, `bridge.dropped` | warning, once | a park refunded to its door on Base, or an empty one dropped | none if expected |
| `bridge.retire_blocked` | warning | a Bittensor bridge in `BRIDGES` that is no longer the vault's primary still holds parks | deliver, refund or drop each before retiring the pair |
| `vault.deposits_refused` | critical | on two readings, shares outstanding and `totalAssets` × 2,000,000 below `totalSupply` (the vault's own half-launch-price line, `HALF_LAUNCH_SHARES_PER_WEI`, pinned to its source): it refuses every deposit (a batch's bounce, a direct deposit's revert). The standing state `price.drop`, which sees a fall between readings, misses on a slow slide | find the loss (`stake.missing`, `stake.unexplained_drop`, `vault.solvency`); guardian `pause()` the front door |
| `deposits.bounced` | critical, once | (changed on v3.2) the email names `DepositBounced`'s reason: `Insolvent`, or `ForeignOrigin` (the address redeems through another chain) | process the bounced payout, never cancel it |
| `stake.removal_fee` | warning, once | the chain kept part of a root unstake, one alert per transaction: a payout chunk's `PayoutChunkSent.unstakeCost` above 0, an `Unstaked` receipt short of what it asked (`receivedWei` below `wantRao` × 1e9), or a direct exit's `ShortfallAbsorbed` above 1,000 rao (its walk leaves at most 1,000 rao untaken, so the rest is the chain's). A `ShortfallAbsorbed` of 1,000 rao or less is a fact only: an exit that close to what was liquid runs no unstake. The leaver pays it (Task 36b) | check the receipts; the site's exit quote must show the fee |
| `swap.below_oracle` | warning, once | a stake (`Staked`: TAO received against the oracle's value of the USDC swapped, after fees) or a USDC delivery (`Delivered`, the swapper's `Sold` fee added back: against the oracle, and against the pools' spot in the reading before it, R3 C-I6) settled more than `swapBelowOracleBps` (1%) below it. Judged against the newest reading from before the trade (unjudged without an oracle value) | look for a sandwich or a thin pool; pause the front door if it repeats |

A missing reading leaves each critical unjudged, never quiet (`monitor.unjudged` counts it); the warnings judge
nothing while unread. The thresholds (`parkedCriticalS`, `surplusUnadoptedS`, `unstakeSkippedCount`, `unstakeSkippedS`,
`swapBelowOracleBps`) are in `src/thresholds.ts`. On v3.2 `fmtao.depeg`'s email also names the reference price's age
(the minutes since the read its verdict rests on).

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
  observation cardinality (from the `slot0` already read). And what no event shows (R3 FM-L2, read 2026-11-05):
  each chain's TokenAdminRegistry entry for the rail's token (`getTokenConfig`: FM-TAO's on Base, wTAO's on
  Bittensor, from `TOKENS.<chain>.tokenAdminRegistry`: its administrator, a transfer pending and the pool CCIP moves
  it through) and the lock pool's rebalancer (`getRebalancer`), three more calls on any deployment. Read once a
  tick, they miss a `setPool` and its undo within the same minute: that shows only through what it did, `ccip.failure`
  on whatever crossed the other pool, or the `MINTER_ROLE` grant such a pool needs to mint (`fmtao.role_change_critical`).
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
| `fmtao.backing_true` | critical; the `alpha` side holds only once `BACKING_HOLD` is on (off as shipped) | `alpha`: on two readings, the AlphaVault's `backing(wTAO)` below wTAO's supply by more than `backingToleranceBps` (0.1%): FM-TAO on every lane is under-backed (at 0, `stakedValueRao` reads no stake: most likely ForeverMoney's validator swapped its hotkey, and the email says so: R6b, U6) (read live 2026-10-31: 13,992.86 TAO against 13,985.65 wTAO, 100.05%). `lock`: more than `lockOutsideCriticalBps` (5%) of wTAO's supply outside the lock pool for over `lockOutsideS` (an hour; meta `lock_outside_critical_since`): wTAO left the pool without FM-TAO being burned (a drain or a forged release), seen while it is held. Never a hold: anyone can mint wTAO with `depositLiquid` (simulated live) and keep it; and a drain unwrapped at once burns the wTAO, keeping supply and lock level, which only `fmtao.unbacked` (Base) sees | `alpha`: guardian `pause()` the front door and the vault (a payout sends TAO into this rail); tell ForeverMoney and Chainlink; unpause (and clear the hold, if one was raised) only once the backing is back. `lock`: look at wTAO's largest holders and the pool's last transfers; a release to someone who burned no FM-TAO is a drain (pause both, tell ForeverMoney), a holder that deposited for it is not (acknowledge). Users' TAO in the vault is staked on Bittensor, not held as wTAO |
| `fmtao.lock_outside` | warning | `lockOutsideMinWei` (100 TAO) or more of wTAO outside the lock pool for over an hour (meta `lock_outside_since`; 0.047 TAO was on 2026-10-31). Usually someone holding wTAO unwrapped (anyone can mint it; unwrapping and re-wrapping toggles it); possibly a drain starting | look at wTAO's largest holders and the pool's last transfers; acknowledge a holder; act as `fmtao.backing_true` says on a drain |
| `fmtao.role_change_critical` | critical | a transaction with a watched admin event that can mint, release or move the rail's tokens, or stop the lane: `MINTER_ROLE` (or FM-TAO's admin role) granted, FM-TAO's `MINTER_ROLE` or `BURNER_ROLE` revoked from its pool (the one `TOKENS` names, or the registry's), a role's admin changed, a remote pool or lane added, a pool's router changed, the lock pool's liquidity withdrawn, the AlphaVault's admin transfer scheduled, a pool's ownership transfer requested, a lane bucket switched off, or Cascade's lane removed. One alert per transaction (keyed `<chain>:<tx>`), every watched event in it listed, so a pool upgrade is one email. A bucket at capacity 0 is a bucket switched off: on TokenPool 1.5.1 capacity 0 is only allowed with the limit disabled, so that direction has **no limit**; only `ChainRemoved` freezes a lane | ask ForeverMoney whether it was planned (a pool upgrade grants `MINTER_ROLE` to the new pool and adds remote pools). If not, or until you know, guardian `pause()` the front door and the vault, and watch `fmtao.backing_true`, `fmtao.mint_surge`, `fmtao.depeg`. **After a planned pool upgrade**, set `TOKENS.base.tokenPool` and `TOKENS.bittensor.lockPool` in `wrangler.jsonc` to the new pools and redeploy: otherwise the lane buckets, `fmtao.unbacked`, the lock readings and these events keep watching the old pools. Deploy it **at least three hours after the new pool's own setup transactions**: the hourly logs cross-check judges each block once, with the addresses watched then, about 80–140 minutes after it on Bittensor (3–25 on Base), so a run after the change would find the new pool's setup events, which the tick wasn't watching for yet, as one `indexer.logs_omitted` critical; sooner, expect that alert, check it lists only the new pool's setup, and acknowledge it |
| `fmtao.role_change` | warning | a transaction with only other watched admin events: a role revoked or another role granted, the CCIP admin moved, an ownership accepted, the rate-limit admin set, a rate limit tuned, a remote pool or another lane removed; or a token's administrator in a TokenAdminRegistry moved (read on two readings, against the last one remembered in meta `registry_admin:<chain>`) | check it matches something ForeverMoney announced, and acknowledge; ask them if not |
| `rail.pool` | critical | on two readings, one alert per chain: the TokenAdminRegistry names another pool for the rail's token (FM-TAO on Base, wTAO on Bittensor) than `TOKENS`, or none (ForeverMoney's `setPool`: in-flight messages execute through it); the batch lane's pool (the Base pool's outbound bucket, the lock pool's inbound) no longer lists the other chain, its bucket is off (no limit) or its capacity is below the front door's `maxBatchValue` | a pool that isn't ForeverMoney's takes the next batch or payout sent through it (CCIP's router hands a send's tokens to the pool the registry names): guardian `pause()` the front door and the vault until the pool is checked (v3.2: a paused front door never stops a close, so to keep the open batch from crossing the guardian can `disableBridge` the front door's primary bridge, which also keeps every redeem on Base from leaving until the owner reopens it: your call); ask ForeverMoney; after a planned move to a new pool, check its roles and lanes and point `TOKENS` at it (as `fmtao.role_change_critical` says) |
| `rail.pool_low` | warning | the batch lane's bucket, enabled, below `maxBatchValue` for over `railPoolLowS` (an hour; meta `rail_pool_low_since:<chain>`): the next full batch waits for it to refill | usually other people's bridging, it clears; if it stays, ask ForeverMoney whether the lane is throttled |
| `fmtao.rebalancer_set` | critical | on two readings, the lock pool has a rebalancer (`getRebalancer`, 0 on 2026-11-05): that account can withdraw all the locked wTAO behind every FM-TAO, and `setRebalancer` logs nothing, so this is the drain's only early warning | ask ForeverMoney; until you know, guardian `pause()` the front door and the vault and watch `LiquidityRemoved` and `fmtao.backing_true` |
| `fmtao.registry_admin` | critical | on two readings, a transfer of the rail token's administrator in a TokenAdminRegistry is pending (`pendingAdministrator`): once accepted, the new administrator can set the token's pool | ask ForeverMoney whether it is theirs; if not, tell them now (they can still cancel it) |
| `rail.alpha_vault` | critical | the AlphaVault paused (`isPaused`, or a `pausedUntil` still to come: a guardian's pause, at most 2 days a shot, or the operator's `adminHold`, any time at all, which the email names when it runs past 2 days), a migration announced (`migrationReadyAt` or `migrationTarget` set), executed or finished | guardian `pause()` the front door (deliveries and payouts through a paused AlphaVault revert, so nothing is lost meanwhile); ask ForeverMoney why and until when; before a migration executes, decide with them whether the adapter can use the new vault |
| `rail.alpha_vault_admin` | warning | the AlphaVault has a default-admin transfer pending (`pendingDefaultAdmin`; it can be accepted once its schedule, 2 days after it was scheduled, passes) | ask ForeverMoney if it is theirs; if not, tell them now (the current admin can cancel it) and be ready to pause as `rail.alpha_vault` says |
| `validator.take_changed` | warning | the validator's take (SubtensorModule `Delegates`) moved and held on the next reading, or its entry is gone: `Delegates` is a ValueQuery, so no entry reads as the chain's default take, 11,796 of 65,535 (18%: the entry's default in the runtime metadata), and `validator.take_high` fires too | small: acknowledge. High or gone: move validators (below) |
| `validator.take_high` | critical | the take (no entry: the default 18%) above `validatorTakeMaxBps` (9%) on two readings: it keeps that share of the vault's root dividends | move validators: owner `setStakeHotkey(<new hotkey>)`, claim the old hotkey's rewards (`pnpm ops claim`), owner `removeHotkey(<old hotkey>, false)` (moves its stake onto the new one); check the price after |
| `validator.root_stake_drop` | warning | the root stake on the validator's hotkey (everyone's, `TotalHotkeyAlpha(hotkey, 0)`) more than 25% below its high of the last 24 hours, on two readings: nominators leaving. 1,021,436.95 TAO on 2026-10-31 | look the hotkey up on taostats; if the validator is winding down, move validators |
| `validator.root_uid_lost` | critical | the hotkey has no root uid (`Uids(0, hotkey)`) on two readings, after one was read: it was deregistered from root and the vault's stake on it earns no root dividends. uid 1 on 2026-10-31 | move validators (the stake stays the vault's) |
| `ccip.rate_limited` | warning | a bucket of Cascade's lane (either pool, either direction) under `ccipBucketMinWei` (10 TAO) for more than `ccipRateLimitedS` (10 minutes): a batch or payout bigger than what is left waits for it to refill (0.6 TAO a second, 5,000 TAO at most, both read live) | usually someone bridged a lot at once and it clears; if it stays empty, check the pool on ccip.chain.link and ask ForeverMoney; keep batches under the bucket's capacity |
| `root.hold_interval` | critical | (today's `root.unlock_interval`, renamed on every deployment) SubtensorModule's `RootStakeUnlockInterval` is set (above 0, unset on 2026-10-31) on two readings: root stake must then sit that many blocks after its last add, remove or claim before it can leave root, and anyone can restart that clock on the vault's coldkey with a `transfer_stake` gift, holding off the vault's unstakes and the payouts that need them. On v3.2 the email names the idle buffer kept liquid and the `idleBufferBps` that covers the pending payouts plus a day's floor (spec §3.8) | payouts revert and wait, nothing is lost; watch `payout.overdue`, keep enough unstaked TAO in the vault for the payouts due (v3.2: owner `setIdleBuffer(<the bps named>)`, immediate), raise it with the Bittensor team if payouts stall. There is no redeem-only pause. On v3-launch, if they stall for long, guardian `pause()` the front door stops deposits, redeem requests and closes alike; on v3.2 a pause stops only `deposit`, `depositFor` and `deliver`. On v3.2, while the hold lasts (R6b): guardian `pause()` the front door's deposits, founder funds the buffer with `depositDirect()` (runbook 7.6) |
| `root.pair_stamped` | warning | (v3.2) a root hold stamp on one of the pairs the deployment depends on. **Unjudged** on every tick while the stamp's storage key is unconfirmed (Task 62 reads it on testnet): never a silent "no stamp". Meanwhile `root.hold_interval` and `stake.unstake_skipped` see the hold | keep the idle buffer up as `root.hold_interval` says |
| `oracle.cardinality` | warning | a pool the TWAP oracle reads keeps fewer observations than its 30-minute window needs at Base's block time as the readings measure it, on two readings: a pool writes at most one observation a second, so 1,801 on Base's 200 ms blocks (901 on its old 2-second ones); never fewer than `oracleMinCardinality` (1,801: the window at one observation a second, the v3.2 oracle's `MIN_CARDINALITY` since Revision 28), and on v3.2 never fewer than the oracle's own `MIN_CARDINALITY` (its constructor's precondition, read live). With fewer, a busy half hour makes `usdcValue` revert. TAO/WETH kept 600 on 2026-10-31, growing to 2,000 (its `cardinalityNext`) as swaps come | if it is growing to the number needed by itself, wait; else anyone can call `increaseObservationCardinalityNext` on the pool (`pnpm ops cardinality` prints the steps) |
| `oracle.thin_pool` | warning | (v3.2) a pool's 30-minute mean in-range liquidity (the oracle's `meanLiquidity`) below the front door's floor for it (`minPoolLiquidity`) on two readings, one alert per pool: `deliver()` refuses every USDC delivery (`ThinPool`) and the keeper skips them; claims still work. The episode's start is kept in meta `thin_pool_since:<pool>` | usually clears within a window; tell waiting users they can claim |
| `oracle.thin_pool_repeated` | warning | (v3.2) the same for more than `thinPoolRepeatedS` (2 hours, four windows), or `thinPoolEpisodes` (3) thin episodes within `thinPoolEpisodesS` (24 hours; meta `thin_pool_episodes:<pool>`), standing between them while they last: deliveries refused round after round, which one cheap block every half hour can do, or one before each keeper round (R3 C-L1, about $88 a hold), as can a pool that lost its depth. One or two episodes a day can be liquidity providers moving their ranges; three is a pattern | check the pool's swaps and liquidity; tell waiting users to claim; lower the floor (`setMinPoolLiquidity`, scheduled) only if the depth really fell |
| `oracle.reverted` | critical | the front door's oracle's `usdcValue` reverts (or answers something that doesn't decode: the reading counts both) on two readings: the keeper can't price a sale, so USDC deliveries stop (claims of TAO on Base still work). It replaces `twap.divergence`'s revert warning | see `oracle.cardinality`; it clears when the window is covered again; if it lasts, tell users deliveries are paused |
| `payout.fee_ceiling` | warning | the primary bridge's fee for a full payout chunk (100 entries, worth the most a chunk carries: the costliest) above `payoutFeeCeilingPct` (70%) of the vault's `maxFeeAbs` on two readings; once the fee passes it, chunks worth less than fee / `maxFeeBps` are refused (`FeeTooHigh`). 0.0013 TAO against 0.005 (26%) on 2026-10-31 | owner `setFeeLimits(bps, abs)` (at most 0.1 TAO) before the fee reaches it |
| `batch.redeem_fee_thin` | warning | R12a (the ChatGPT r3 DoS scan's fake redeem requests): a full redeem list's fees, the front door's `redeemRequestFee` × `maxRedeems`, under `redeemFeeCoverPct` (150%) of the front door's primary bridge's quote to close a full batch (50 deposits and 50 redeem requests worth its `maxBatchValue`, `fullBatchQuote`, the costliest close), on two readings. A request needs only its fee, so anyone can fill the list; below the quote a junk-filled list can't close itself (`InsufficientFee`) and the keeper pays the rest. At launch 0.0002 ETH × 50 (the founder, 2026-11-16) against about 0.0043 ETH: about 2.3 times (2.32), so it is quiet until a full batch's quote passes about 0.0067 ETH (at the 0.0001 ETH before, 1.16 times, it warned from the first readings); unread: unjudged | owner `setRedeemRequestFee(fee)` on the front door, immediate, at most 0.001 ETH (the email names the fee that covers 1.5 times; runbook section 4) |
| `keeper.low_eth` | warning | (changed, R12a) the keeper's ETH on Base below what a full batch's close needs: the floor `keeperMinEthWei` (0.015 ETH; 0.002 before), or `keeperCloseQuotes` (4) of the read full batch's close quote (`fullBatchQuote`) when that is more, the float the keeper sends with such a close (three quotes, which a node wants held whole) and one more close's fee, so it warns while one more full close still goes. The floor alone while the quote is unread | top the keeper up on Base, to about 0.03 ETH (pnpm ops budget, runbook 2.2) |
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
| `indexer.logs_extra` | warning | the store holds logs the second RPC, the re-read depth past them (140 s of Base's blocks, 4,800 s of Bittensor's), doesn't serve (one alert per chain, the logs listed) | usually the second node pruned them (set an archive endpoint in `*_RPC_URL_2`) or lags its log index; if the explorer doesn't have a transaction either, the primary served a log that isn't on the chain: switch it and re-check what the rules decided on it |
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
