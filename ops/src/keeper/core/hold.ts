import type { Address } from "viem";

// The monitor's hold, as the v3.2 keeper reads it (design-keeper-worker.md §6; the monitor plan's Task 38, which was
// never built; the founder's Phase 10 answers). Once a round the keeper reads GET /v1/status (indexer/src/api.ts
// handleStatus: the hold by its opaque ids, the payout keys the monitor confirmed, each chain's settled block, its time
// and its lag) and, on a hand run, ops/hold.json. While a hold is on NOTHING is sent: no close, payout, stake, claim,
// delivery, park job or FAILURE re-execution (the founder: "a hold stops everything", USDC deliveries included, over
// the note's recommendation). While the monitor can't be read, or can't see (another deployment, a chain lagging past
// its limit, none configured), nothing is sent either: it fails closed. A hand run's --ignore-monitor-outage --until
// (at most 24 hours ahead) lifts an outage only, never a hold; the Worker never carries one. Portable: fetch only.

/** The monitor's lag limit for the keeper (indexer rules/ops.ts lagLimitOf with its default thresholds, lagCapS 1,800
 * and lagPayoutDelayDivisor 4): a quarter of the payout delay, at most 30 minutes. */
export const LAG_CAP_S = 1_800;
export const LAG_PAYOUT_DELAY_DIVISOR = 4;
export function lagLimitS(payoutDelayS: number): number {
  if (!Number.isFinite(payoutDelayS) || payoutDelayS <= 0) return LAG_CAP_S;
  return Math.min(LAG_CAP_S, Math.floor(payoutDelayS / LAG_PAYOUT_DELAY_DIVISOR));
}

/** How long the status may take (the plan's 10 seconds), and the price (the web's 5 seconds). */
export const STATUS_TIMEOUT_MS = 10_000;
export const PRICE_TIMEOUT_MS = 5_000;
/** The most an answer may weigh: a status lists every confirmed key, a few dozen bytes each. */
export const MAX_MONITOR_BYTES = 65_536;
/** The longest --ignore-monitor-outage --until may reach ahead. */
export const OVERRIDE_MAX_MS = 24 * 3_600_000;

/** The monitor could not be read: why, in words that never carry its URL (only the host is ever named). */
export class MonitorUnreadable extends Error {}

/** Where the keeper reads the monitor: the hand run over HTTPS (OPS_HOLD_URL), the Worker through its service binding
 * (Task 50b). `where` is the host alone, for the log. Each read gives the body's text, or throws MonitorUnreadable. */
export interface MonitorClient {
  where: string;
  status(): Promise<string>;
  price(): Promise<string>;
}

/** The monitor at `baseUrl` (its /v1/status, its /v1/price; a URL that already ends in /v1/status is taken as its
 * base), each read under its timeout and size limit. A failure is MonitorUnreadable naming what failed, never the URL,
 * its path, its user or its query. */
export function monitorOverHttp(
  baseUrl: string,
  o: { fetch?: typeof globalThis.fetch; statusTimeoutMs?: number; priceTimeoutMs?: number; maxBytes?: number } = {},
): MonitorClient {
  const url = new URL(baseUrl);
  const base = `${url.origin}${url.pathname.replace(/\/v1\/status\/?$/, "").replace(/\/+$/, "")}${url.search}`;
  const at = (path: string) => {
    const u = new URL(base);
    u.pathname = `${u.pathname.replace(/\/+$/, "")}${path}`;
    return u.toString();
  };
  const f = o.fetch ?? globalThis.fetch;
  const max = o.maxBytes ?? MAX_MONITOR_BYTES;
  async function get(path: string, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await f(at(path), { method: "GET", headers: { accept: "application/json" }, signal: controller.signal });
      } catch {
        throw new MonitorUnreadable(controller.signal.aborted ? `no answer within ${timeoutMs / 1000} s` : "a network error");
      }
      if (res.status !== 200) throw new MonitorUnreadable(`it answered HTTP ${res.status}`);
      let text: string;
      try {
        text = await res.text();
      } catch {
        throw new MonitorUnreadable(controller.signal.aborted ? `no answer within ${timeoutMs / 1000} s` : "its answer broke off");
      }
      if (text.length > max) throw new MonitorUnreadable(`its answer is over ${max} bytes`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    where: url.host,
    status: () => get("/v1/status", o.statusTimeoutMs ?? STATUS_TIMEOUT_MS),
    price: () => get("/v1/price", o.priceTimeoutMs ?? PRICE_TIMEOUT_MS),
  };
}

/** What the monitor says this round. `hold`: something holds the keeper (the monitor's hold.active, or ops/hold.json):
 * nothing is sent, and no override lifts it. `outage`: the monitor can't be read or can't see: nothing is sent, unless
 * a hand run's override covers it. `okKeys`: the payout keys the monitor confirmed (lowercase), when it was read. */
export interface MonitorView {
  hold?: string;
  outage?: string;
  okKeys?: ReadonlySet<string>;
}

export interface MonitorRead {
  /** The monitor, or null when none is configured (an outage: the v3.2 keeper never sends without one) */
  client: MonitorClient | null;
  /** ops/hold.json's text on a hand run (undefined: no such file; the host reads it) */
  holdFile?: string;
  /** The deployment the keeper runs (the status must name its front door and vault) */
  deployment: { frontDoor: Address; vault: Address };
  /** The vault's payout delay as read on chain (the lag limit's input) */
  payoutDelayS: number;
  /** The keeper's own clock (ms): the second lag test is the settled block's time against it */
  nowMs: number;
}

/** ops/hold.json read as the hold it is: `{"hold": true}` holds (with its `reason`, if a string), `{"hold": false}`
 * holds nothing; a file that says neither (not JSON, no boolean `hold`) holds too: it exists to hold. */
export function holdFileHold(text: string): string | undefined {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    x = undefined;
  }
  const o = typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined;
  if (o?.hold === false) return undefined;
  if (o?.hold === true) return `ops/hold.json holds the keeper${typeof o.reason === "string" && o.reason ? ` (${o.reason})` : ""}`;
  return `ops/hold.json can't be read (it says neither {"hold": true} nor {"hold": false}), so it holds the keeper`;
}

const CHAINS = [
  ["base", "Base"],
  ["bittensor", "Bittensor"],
] as const;

type ChainStatus = { settledTo?: unknown; settledTime?: unknown; lagS?: unknown } | null;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isoS = (x: unknown): number | undefined => {
  if (typeof x !== "string") return undefined;
  const ms = Date.parse(x);
  return Number.isFinite(ms) ? ms / 1000 : undefined;
};
const minutes = (s: number) => Math.floor(s / 60);
const joinHold = (a: string | undefined, b: string) => (a ? `${a}; ${b}` : b);

/** The monitor's view this round (the monitor plan's Task 38): ops/hold.json first, then the status. Unreadable or not
 * JSON, not a status, `v` not 1, or naming another deployment's front door or vault: an outage. On either chain, the
 * lag the monitor read plus the time since its last complete tick, or the time since the chain's newest settled block
 * by the keeper's own clock, over lagLimitS(payoutDelayS): an outage naming the chain and the test. `hold.active`: a
 * hold, by its opaque ids. Reasons never carry the monitor's URL, only its host. */
export async function readMonitor(i: MonitorRead): Promise<MonitorView> {
  const view: { hold?: string; outage?: string; okKeys?: ReadonlySet<string> } = {};
  if (i.holdFile !== undefined) view.hold = holdFileHold(i.holdFile);
  if (!i.client) {
    view.outage = "no monitor is configured (OPS_HOLD_URL, or the Worker's binding), and the v3.2 keeper never sends without one";
    return view;
  }
  const where = i.client.where;
  let text: string;
  try {
    text = await i.client.status();
  } catch (e) {
    view.outage = `the monitor (${where}) could not be read: ${e instanceof MonitorUnreadable ? e.message : "an error of its client"}`;
    return view;
  }
  let s: unknown;
  try {
    s = JSON.parse(text);
  } catch {
    view.outage = `the monitor's status (${where}) is not JSON`;
    return view;
  }
  // a hold the monitor states holds whatever else its status says (its version, its shape, its deployment), so no
  // override ever passes one (T50a review M2)
  const stated = isObject(s) && isObject(s.hold) && s.hold.active === true ? s.hold : undefined;
  if (stated) {
    const ids = Array.isArray(stated.ids) ? stated.ids.filter((x): x is string => typeof x === "string") : [];
    view.hold = joinHold(view.hold, `the monitor holds the keeper${ids.length ? ` (hold ${ids.join(", ")})` : ""}`);
  }
  if (!isObject(s)) {
    view.outage = `the monitor's status (${where}) is not one the keeper reads`;
    return view;
  }
  // no version at all is not version 1 either (T50a review M1)
  if (s.v !== 1) {
    view.outage = `the monitor's status is version ${"v" in s ? String(s.v) : "none"}, not 1`;
    return view;
  }
  const dep = isObject(s) ? s.deployment : undefined;
  const hold = isObject(s) ? s.hold : undefined;
  const payouts = isObject(s) ? s.payouts : undefined;
  const indexer = isObject(s) ? s.indexer : undefined;
  const monitor = isObject(s) ? s.monitor : undefined;
  if (
    !isObject(s) ||
    !isObject(dep) ||
    typeof dep.frontDoor !== "string" ||
    typeof dep.vault !== "string" ||
    !isObject(hold) ||
    typeof hold.active !== "boolean" ||
    !Array.isArray(hold.ids) ||
    !hold.ids.every((x) => typeof x === "string") ||
    !isObject(payouts) ||
    !Array.isArray(payouts.okKeys) ||
    !payouts.okKeys.every((x) => typeof x === "string") ||
    !isObject(indexer) ||
    !isObject(monitor)
  ) {
    view.outage = `the monitor's status (${where}) is not one the keeper reads`;
    return view;
  }
  if (dep.frontDoor.toLowerCase() !== i.deployment.frontDoor.toLowerCase() || dep.vault.toLowerCase() !== i.deployment.vault.toLowerCase()) {
    view.outage = `the monitor (${where}) watches another deployment (its front door ${dep.frontDoor}, its vault ${dep.vault})`;
    return view;
  }
  // hold.active: said above, before the checks
  view.okKeys = new Set((payouts.okKeys as string[]).map((k) => k.toLowerCase()));
  const now = i.nowMs / 1000;
  const limit = lagLimitS(i.payoutDelayS);
  const tick = isoS(monitor.lastCompleteTickAt);
  const out: string[] = [];
  if (tick === undefined) out.push("the monitor has completed no tick yet");
  else {
    for (const [c, name] of CHAINS) {
      const x = indexer[c] as ChainStatus | undefined;
      if (!isObject(x)) {
        out.push(`the monitor has no reading of ${name}`);
        continue;
      }
      const settled = isoS(x.settledTime);
      if (settled === undefined || typeof x.lagS !== "number" || !Number.isFinite(x.lagS)) {
        out.push(`the monitor has settled no block of ${name} yet`);
        continue;
      }
      // the monitor's own reading: its lag, aged by the time since its last complete tick (never less than the lag)
      const ago = Math.max(0, Math.round(now - tick));
      const byMonitor = x.lagS + ago;
      if (byMonitor > limit) {
        out.push(`${name} is ${minutes(byMonitor)} minutes behind by the monitor's own reading (a lag of ${x.lagS} s, its last complete tick ${ago} s ago), over the ${minutes(limit)}-minute limit`);
      }
      // the keeper's clock against the newest settled block's time: catches a monitor whose head itself stopped
      const old = now - settled;
      if (old > limit) out.push(`${name}'s newest settled block is ${minutes(old)} minutes old by the keeper's clock, over the ${minutes(limit)}-minute limit`);
    }
  }
  if (out.length) view.outage = out.join("; ");
  return view;
}

/** A hand run's --ignore-monitor-outage --until: an outage (never a hold) ignored until this time (ms). */
export interface MonitorOverride {
  until: number;
}

/** --until's UTC time (an ISO time with its zone, e.g. 2027-01-18T14:05Z), at most 24 hours ahead of `nowMs`: refused
 * when it is not such a time, is not ahead of now, or is further. */
export function monitorOverride(until: string, nowMs: number): MonitorOverride {
  const ok = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(until.trim());
  const ms = ok ? Date.parse(until.trim()) : Number.NaN;
  if (!Number.isFinite(ms)) throw new Error(`--until ${until} is not a UTC time (e.g. 2027-01-18T14:05Z); nothing sent`);
  if (ms <= nowMs) throw new Error(`--until ${until} is not ahead of now; nothing sent`);
  if (ms - nowMs > OVERRIDE_MAX_MS) throw new Error(`--until ${until} is more than 24 hours ahead (the most --ignore-monitor-outage allows); nothing sent`);
  return { until: ms };
}

/** What the round may do by the monitor. `stop`: nothing is sent this round, and why (a hold; an outage no override
 * covers). `warn`: an outage a hand run's override covers, said every round. `okKeys`: the payout keys a payout needs,
 * or undefined for no per-key check (an outage the override covers: the plan's rule). */
export interface MonitorGate {
  stop?: string;
  warn?: string;
  okKeys?: ReadonlySet<string>;
}

export function monitorGate(view: MonitorView, override: MonitorOverride | undefined, nowMs: number): MonitorGate {
  if (view.hold) return { stop: `HOLD: ${view.hold}: nothing is sent (no close, payout, stake, claim, delivery or park job) until it clears` };
  if (view.outage) {
    if (override && nowMs < override.until) {
      return {
        warn: `MONITOR OUTAGE IGNORED until ${new Date(override.until).toISOString()} (--ignore-monitor-outage): ${view.outage}; sending without the monitor's checks, payouts it hasn't confirmed included`,
      };
    }
    return { stop: `THE MONITOR CAN'T SEE: ${view.outage}: nothing is sent until it can` };
  }
  return { okKeys: view.okKeys };
}
