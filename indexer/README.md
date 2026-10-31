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
| `GET /v1/status` | the keeper: the hold (opaque ids only), confirmed payout keys, each chain's lag (cached 15 s; `generatedAt` says when it was computed) |
| `GET /v1/health` | an uptime checker: 200 while a tick completed in the last 5 minutes and no chain lags past the lag limit; else 503 and why (cached 15 s) |

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
- **The second logs RPCs**: `BASE_LOGS_RPC_URL_2` and `BITTENSOR_RPC_URL_2` (defaults `https://base.drpc.org` and
  `https://bittensor.drpc.org`; a keyed URL goes in `BASE_LOGS_RPC_URL_2_SECRET` / `BITTENSOR_RPC_URL_2_SECRET`).
  The hourly job re-reads each chain's newest settled blocks through them (`logsCheckBaseBlocks` 600 and
  `logsCheckBittensorBlocks` 300 at most per run, in the chain's windows, within 12 requests) and compares the
  logs with what the primary had the tick store, so a primary that omits a watched log is noticed. A second
  opinion has to come from another provider: the config refuses a second URL on the same registrable domain as
  its primary (the lite node next to the archive node; a keyed dRPC primary next to the dRPC default: set another
  provider for one of them, e.g. `https://base-mainnet.public.blastapi.io` or `https://base.llamarpc.com` for
  Base). An archive endpoint is best (a pruning second node reads as `indexer.logs_extra` warnings); a second
  endpoint that stops answering is `indexer.unverified` after 3 hours, and `pnpm smoke` tries both from your
  machine.
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
   balance), then remove it.
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
| `stake.divergence` | critical, **holds** | the vault's counted stake fell by what now sits on a hotkey the vault doesn't list (a material share, `stakeDivergenceMinBps`, of the vault), on two readings in a row and once settled: a hotkey swap, stake moved off a listed hotkey, or the configured stake hotkey removed with stake still on it; the email names the hotkey, the stake on it, what the vault counts, what it counted before the hotkey appeared, and what the chain holds. The fall is measured from the reading before the hotkey first appeared, less the vault's own `Unstaked` since | guardian `pause()` the vault (deliveries, direct deposits and payouts stop); owner, guardian or keeper `addHotkey(<the hotkey>)` (if the set is full, owner `removeHotkey` an empty one first); check the price recovered, clear the hold, unpause. `stake.unexplained_drop` sees the same swap as stake leaving the listed hotkey and holds at once; this alert then names where it went and raises no second hold while that one is on (`price.drop` and `stake.hotkey_changed` fire from their own angles too) |
| `stake.unlisted` | warning | stake on a hotkey the vault doesn't list **without** a matching fall in its counted stake: a stranger's `transfer_stake` (anyone can push stake onto any coldkey, from about 0.0005 TAO, which also lists their hotkey under it), or an amount below the hold threshold | nothing is held. Sweep it when worth a transaction: `addHotkey(<the hotkey>)`, then owner `removeHotkey(<the hotkey>, true)` moves it onto the stake hotkey (its depositors get it through their shares); acknowledge dust |
| `vault.stake_moved` | warning | a `StakeMoved` onto the configured stake hotkey below `stakeMoveCriticalRao` (100 TAO): `moveStake` or `removeHotkey`, owner only; the sender is named | your own change: acknowledge. Not yours: the owner key is compromised, guardian `pause()`, rotate |
| `vault.stake_moved_unexpected` | critical | a `StakeMoved` to a hotkey that isn't the configured stake hotkey (the vault's stake hotkey was changed first: see the `StakeHotkeySet` admin alert), or of `stakeMoveCriticalRao` or more at once | if you didn't, assume the owner key is compromised: guardian `pause()` the vault now, rotate; check where the stake sits on taostats |
| `vault.direct_use` | warning | a `DepositedDirect`, `RedeemedDirect` or `FrontDoorRedeemsAllowed` (the launch offers none; the user is named) | check the user; if the share price isn't right (a swap in progress), guardian `pause()` the vault: `depositDirect` and `redeemDirect` stop while paused |
| `vault.direct_use_large` | critical | a direct deposit or redeem of `directCriticalWei` (10 TAO) or more, or **any** direct deposit while a hold is on (the price is in doubt) | guardian `pause()` the vault until the price is checked; if the price was depressed when the deposit minted, those shares are the loss: find the cause (`stake.divergence`, `price.drop`) before unpausing |

The thresholds (`stakeDustRao`, `stakeDivergenceMinBps`, `stakeMoveCriticalRao`, `directCriticalWei`) are in
`src/thresholds.ts` and can be set in `THRESHOLDS`. The `StakingHotkeys` storage key is worked out offline (`src/subtensor.ts`);
`pnpm smoke` checks the live chain answers it with a list that holds the stake hotkey.

### The logs cross-check

The tick reads each chain's logs through one RPC. A node that omits a watched log (lying, or pruning) would
blind the monitor to that event with no lag, blind or reorg signal, so every hour a second, independent endpoint
per chain re-reads the newest settled blocks of the watched addresses, and its logs are compared, by the uid the
scan gives every log, with what the store holds for that range (`src/logs-check.ts`; the counts and a hash of
each side are in every alert's facts):

| Alert | Tier | What it means | What to do |
|---|---|---|---|
| `indexer.logs_omitted` | critical | the second RPC served a watched log the primary never did, so the monitor's history and its rules missed it (the event, block and transaction are named) | open the transaction on the explorer; if it is real, read the event and act on it as its own alert would have had you, and switch the primary (`BASE_LOGS_RPC_URL` / `BITTENSOR_RPC_URL`, or the `_SECRET`) to another provider, then redeploy. The tick re-reads only 70 (Base) or 400 (Bittensor) blocks back, so the missed log isn't added by itself |
| `indexer.logs_extra` | warning | the store holds a log the second RPC, 70 or 400 blocks past it, doesn't serve | usually the second node pruned it (set an archive endpoint in `*_RPC_URL_2`) or lags its log index; if the explorer doesn't have the transaction either, the primary served a log that isn't on the chain: switch it and re-check what the rules decided on it |
| `indexer.unverified` | warning (condition) | the second RPC of a chain hasn't answered the cross-check for `logsCheckUnverifiedS` (3 hours): the primary's logs go unverified meanwhile | check `BASE_LOGS_RPC_URL_2` / `BITTENSOR_RPC_URL_2`: the public default may refuse Cloudflare's egress; set a keyed URL in its `_SECRET` (another provider than the primary's), redeploy. Clears on the next run that answers |

A chain still catching up in its first backfill isn't cross-checked (an old range a non-archive second node may
not have), and a second node that hasn't settled the range yet is asked again next hour.

## Limits worth knowing

- **The site check is a tripwire over the scripts' text and the pages' policies.** An address or host built at
  run time (by string concatenation, or fetched from elsewhere) isn't seen; what stops such a script loading is
  the page's Content-Security-Policy (`script-src 'self'` and the build's own inline-script hashes), which the
  check compares with the build's on every page. A site that serves the monitor a clean copy and its users a
  tampered one can't be caught from outside. A file that stopped a site-check run points to the CPU
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
