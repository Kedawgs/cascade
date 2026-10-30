import { type Hex, pad } from "viem";
import type { Config } from "./config.ts";
import { lagLimitOf } from "./rules/ops.ts";
import { type AccountEvent, accountHalf, sharedHalfJson } from "./seed.ts";
import { seedPageOf } from "./store.ts";
import { DEFAULTS, type Thresholds } from "./thresholds.ts";
import { DEFAULT_PAYOUT_DELAY_S } from "./tick.ts";

// The read-only HTTP routes (spec section 4). Nothing here writes: every route reads D1 through fixed
// prepared statements, and every parameter is checked before D1 is touched.

const SCAN_PATH = /^\/v1\/scan\/([^/]+)(?:\/([^/]*))?$/;
const ACCOUNT = /^0x[0-9a-f]{40}$/;

const plain = (status: number, text: string, headers: Record<string, string> = {}) =>
  new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers } });

/** The site falls back to its own scan on this; Retry-After tells a client when to ask again. */
const unavailable = (cors: Record<string, string>) => plain(503, "not available yet", { ...cors, "Retry-After": "60" });

type Row = Record<string, unknown>;

/** Bittensor's cursor, and which deployment the database holds (written by the tick's first commit). */
const CURSOR =
  "SELECT from_block, scanned_to, settled_to, settled_time, (SELECT v FROM meta WHERE k = 'deployment') AS deployment FROM cursors WHERE chain = 'bittensor'";

/** Whether a /v1/scan request is within the client's rate limit (the SCAN_LIMITER binding: per client IP,
 * per Cloudflare location, approximate). A request with no client IP (never one through Cloudflare's edge,
 * which sets it) isn't counted, and a limiter that fails lets the request through: the API is an accelerator,
 * and the site falls back to its own scan on any refusal anyway. */
async function withinLimit(limiter: RateLimit | undefined, request: Request): Promise<boolean> {
  const ip = request.headers.get("cf-connecting-ip");
  if (!limiter || !ip) return true;
  try {
    return (await limiter.limit({ key: `scan:${ip}` })).success;
  } catch (e) {
    console.error(`the rate limiter failed (request served): ${e instanceof Error ? e.message : String(e)}`);
    return true;
  }
}

/** GET /v1/scan/{vault} (the deployment-wide half) and GET /v1/scan/{vault}/{account} (one account's
 * half), in exactly the ScanState v1 form the site's store saves, with next = Bittensor's settled_to + 1.
 * One spelling per resource, checked before any D1 query so the cache can't be sidestepped with
 * variants: no query string at all (400), the configured vault in lowercase (else 404), the account as
 * 0x and 40 lowercase hex digits (else 400). 503 until the first Bittensor window is stored, when D1
 * fails or a row can't be read, or when the database holds another deployment than DEPLOYMENT. 429 past the
 * client's rate limit (every GET that reaches the Worker counts; cached answers don't reach it). Cached for
 * 30 s, with CORS for the site's one origin. */
export async function handleScan(request: Request, env: { DB: D1Database; SCAN_LIMITER?: RateLimit }, cfg: Config): Promise<Response> {
  const cors = { "Access-Control-Allow-Origin": cfg.site.origin };
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" } });
  }
  if (request.method !== "GET") return plain(405, "method not allowed", { ...cors, Allow: "GET, OPTIONS" });
  if (!(await withinLimit(env.SCAN_LIMITER, request))) return plain(429, "too many requests", { ...cors, "Retry-After": "60" });
  // `?` alone leaves URL.search empty: look at the raw URL
  if (request.url.includes("?")) return plain(400, "no query string", cors);
  const m = SCAN_PATH.exec(new URL(request.url).pathname);
  if (!m || m[1] !== cfg.deployment.vault) return plain(404, "not found", cors);
  const account = m[2];
  if (account !== undefined && !ACCOUNT.test(account)) return plain(400, "the account must be 0x and 40 lowercase hex digits", cors);

  let rows: Row[][];
  try {
    const db = env.DB;
    const second =
      account === undefined
        ? db.prepare("SELECT page, first_block, last_block, count, delivered, staked, payouts FROM seed_pages ORDER BY page")
        : db
            .prepare(
              // by the account's index: the planner would otherwise walk every account's deposits
              `SELECT event, block, tx_hash, args FROM logs INDEXED BY logs_by_topic2
               WHERE contract = 'vault' AND event IN ('Deposited', 'Redeemed') AND topic2 = ?1 AND chain = 'bittensor' AND removed = 0
                 AND block <= (SELECT settled_to FROM cursors WHERE chain = 'bittensor')
               ORDER BY block, log_index`,
            )
            .bind(pad(account as Hex));
    rows = (await db.batch<Row>([db.prepare(CURSOR), second])).map((r) => r.results);
  } catch (e) {
    console.error(`seed read failed: ${e instanceof Error ? e.message : String(e)}`);
    return unavailable(cors);
  }

  const cursor = rows[0][0];
  if (!cursor || cursor.scanned_to === null || cursor.scanned_to === undefined) return unavailable(cors);
  const from = cfg.deployment.bittensor.startBlock;
  if (cursor.deployment !== cfg.deployment.id || BigInt(cursor.from_block as number) !== from) {
    // DEPLOYMENT changed under the database (or the database never said whose it is): never serve another's history
    console.error("the database holds another deployment than DEPLOYMENT (or doesn't say which): not serving it");
    return unavailable(cors);
  }
  const next = BigInt(cursor.settled_to as number) + 1n;
  const vault = cfg.deployment.vault;

  let body: string;
  try {
    if (account === undefined) {
      // joined from the pages' pre-split lists: no page wholly inside [from, next) is parsed
      body = sharedHalfJson({ vault, from, next, pages: rows[1].map(seedPageOf) });
    } else {
      const deposited: AccountEvent[] = [];
      const redeemed: AccountEvent[] = [];
      for (const r of rows[1]) {
        const args = JSON.parse(r.args as string) as { key: Hex; assets: string };
        (r.event === "Deposited" ? deposited : redeemed).push({ key: args.key, txHash: r.tx_hash as Hex, block: String(r.block), assets: args.assets });
      }
      body = JSON.stringify(accountHalf({ vault, from, next, deposited, redeemed }));
    }
  } catch (e) {
    console.error(`seed rows couldn't be read: ${e instanceof Error ? e.message : String(e)}`);
    return unavailable(cors);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=30",
    ...cors,
    "Access-Control-Expose-Headers": "Cascade-Settled-Time",
  };
  if (cursor.settled_time !== null && cursor.settled_time !== undefined) headers["Cascade-Settled-Time"] = String(cursor.settled_time);
  return new Response(body, { status: 200, headers });
}

const iso = (s: unknown): string | null => (s === null || s === undefined ? null : new Date(Number(s) * 1000).toISOString());

/** GET /v1/status: what the keeper reads (spec section 8): whether a hold is on (by the holds' opaque
 * public ids only: no rule, batch, summary or alert reaches it), the delivered keys it may pay out
 * (`ok` or `ok_by_owner`, payouts queued and not yet done), and each chain's settled block, time and
 * lag (head_time − settled_time, head_time being moved every tick even when no logs could be read).
 * Never cached; no query string; 503 when D1 fails or the database holds another deployment (or none
 * yet), which the keeper treats as an outage and holds on. */
export async function handleStatus(request: Request, env: { DB: D1Database }, cfg: Config, nowS: number): Promise<Response> {
  const noStore = { "Cache-Control": "no-store" };
  if (request.method !== "GET") return plain(405, "method not allowed", { Allow: "GET" });
  if (request.url.includes("?")) return plain(400, "no query string");
  let rows: Row[][];
  try {
    const db = env.DB;
    rows = (
      await db.batch<Row>([
        db.prepare("SELECT public_id FROM holds WHERE cleared_at IS NULL ORDER BY raised_at, public_id"),
        db.prepare(
          `SELECT DISTINCT delivered_key FROM batch_checks
           WHERE queued_block IS NOT NULL AND payout_done_block IS NULL AND status IN ('ok', 'ok_by_owner') ORDER BY delivered_key`,
        ),
        db.prepare("SELECT chain, settled_to, settled_time, head_time FROM cursors"),
        db.prepare("SELECT k, v FROM meta WHERE k IN ('deployment', 'last_complete_tick')"),
      ])
    ).map((r) => r.results);
  } catch (e) {
    console.error(`status read failed: ${e instanceof Error ? e.message : String(e)}`);
    return plain(503, "not available", noStore);
  }
  const meta = Object.fromEntries(rows[3].map((r) => [r.k as string, r.v as string]));
  if (meta.deployment !== cfg.deployment.id) {
    console.error("the database holds another deployment than DEPLOYMENT (or none yet): no status");
    return plain(503, "not available", noStore);
  }
  const chain = (name: "base" | "bittensor") => {
    const c = rows[2].find((r) => r.chain === name);
    if (!c) return null;
    const settled = c.settled_time === null ? null : Number(c.settled_time);
    const head = c.head_time === null ? null : Number(c.head_time);
    return { settledTo: Number(c.settled_to), settledTime: iso(settled), lagS: settled === null || head === null ? null : head - settled };
  };
  const ids = rows[0].map((r) => r.public_id as string);
  const body = {
    v: 1,
    deployment: { frontDoor: cfg.deployment.frontDoor, vault: cfg.deployment.vault, baseChainId: 8453, bittensorChainId: 964 },
    hold: { active: ids.length > 0, ids },
    payouts: { okKeys: rows[1].map((r) => r.delivered_key as string) },
    indexer: { base: chain("base"), bittensor: chain("bittensor") },
    monitor: { lastCompleteTickAt: iso(meta.last_complete_tick) },
    generatedAt: iso(nowS),
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", ...noStore } });
}

/** A tick must have completed this recently for /v1/health to be ok. */
export const HEALTHY_WITHIN_S = 300;

/** GET /v1/health, for an outside uptime check: 200 "ok" while the last complete tick is under 5 minutes old
 * and no chain's settled history lags (head_time − settled_time) past the lag limit, the keeper's (a quarter of
 * the payout delay the tick last read, at most 30 minutes); else 503 with the reason. So a chain the monitor
 * can't see (its RPC refusing it) is seen from outside even when email is broken. A chain catching up in the
 * first backfill (meta catching_up, before caught_up) isn't counted, as its lag alerts are quiet; one stuck
 * then is. Two D1 reads, no RPC. Never cached. */
export async function handleHealth(env: { DB: D1Database }, nowS: number, t: Pick<Thresholds, "lagCapS" | "lagPayoutDelayDivisor"> = DEFAULTS): Promise<Response> {
  const noStore = { "Cache-Control": "no-store" };
  let rows: Row[][];
  try {
    const db = env.DB;
    rows = (
      await db.batch<Row>([
        db.prepare("SELECT k, v FROM meta WHERE k IN ('last_complete_tick', 'caught_up', 'catching_up', 'payout_delay')"),
        db.prepare("SELECT chain, settled_time, head_time FROM cursors ORDER BY chain"),
      ])
    ).map((r) => r.results);
  } catch {
    return plain(503, "not available", noStore);
  }
  const meta = Object.fromEntries(rows[0].map((r) => [r.k as string, r.v as string]));
  if (meta.last_complete_tick === undefined || !(nowS - Number(meta.last_complete_tick) < HEALTHY_WITHIN_S)) {
    return plain(503, "no complete tick in the last 5 minutes", noStore);
  }
  const delay = Number(meta.payout_delay);
  const limit = lagLimitOf(meta.payout_delay && delay > 0 ? delay : DEFAULT_PAYOUT_DELAY_S, t);
  const catchingUp = meta.caught_up ? [] : (meta.catching_up ?? "").split(",");
  const behind = rows[1].flatMap((c) => {
    if (c.head_time === null || c.head_time === undefined || catchingUp.includes(c.chain as string)) return [];
    if (c.settled_time === null || c.settled_time === undefined) return [`${c.chain} has settled no block yet`];
    const lag = Number(c.head_time) - Number(c.settled_time);
    return lag > limit ? [`${c.chain} is ${Math.floor(lag / 60)} minutes behind (limit ${Math.floor(limit / 60)} minutes)`] : [];
  });
  return behind.length ? plain(503, behind.join("; "), noStore) : plain(200, "ok", noStore);
}
