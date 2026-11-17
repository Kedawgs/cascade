import { type Address, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  holdFileHold,
  lagLimitS,
  type MonitorClient,
  monitorGate,
  monitorOverHttp,
  monitorOverride,
  MonitorUnreadable,
  OVERRIDE_MAX_MS,
  readMonitor,
  STATUS_TIMEOUT_MS,
} from "../src/keeper/core/hold.ts";

// The monitor's hold as the v3.2 keeper reads it (the monitor plan's Task 38, scoped by the founder's Phase 10 answers:
// a hold stops everything, and so does a monitor that can't see). GET /v1/status (indexer/src/api.ts handleStatus) gives
// the hold (opaque ids only), the payout keys it confirmed and each chain's settled time and lag; ops/hold.json holds a
// hand run. No network: the monitor is a fake client, or fetch is.

const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);
const FD = at("fd01");
const VAULT = at("7a01");
const DEPLOYMENT = { frontDoor: FD, vault: VAULT };
const NOW = 1_800_000_000;
const NOW_MS = NOW * 1000;
const iso = (s: number) => new Date(s * 1000).toISOString();
const KEY = `0x${"ab".repeat(32)}`;

type Chain = { settledTo: number; settledTime: string | null; lagS: number | null } | null;

/** A /v1/status body as handleStatus writes it: both chains settled `settledAgo` s before now with a lag of `lagS`, the
 * last complete tick `tickAgo` s ago. */
function status(o: { lag?: Partial<Record<"base" | "bittensor", number>>; settledAgo?: Partial<Record<"base" | "bittensor", number>>; tickAgo?: number | null; hold?: string[]; okKeys?: string[]; v?: unknown; deployment?: Partial<typeof DEPLOYMENT>; indexer?: Partial<Record<"base" | "bittensor", Chain>> } = {}) {
  const chain = (c: "base" | "bittensor"): Chain => {
    if (o.indexer && c in o.indexer) return o.indexer[c] ?? null;
    const lag = o.lag?.[c] ?? 60;
    return { settledTo: 1_000, settledTime: iso(NOW - (o.settledAgo?.[c] ?? lag)), lagS: lag };
  };
  return {
    v: o.v ?? 1,
    deployment: { ...DEPLOYMENT, baseChainId: 8453, bittensorChainId: 964, ...o.deployment },
    hold: { active: (o.hold ?? []).length > 0, ids: o.hold ?? [] },
    payouts: { okKeys: o.okKeys ?? [] },
    indexer: { base: chain("base"), bittensor: chain("bittensor") },
    monitor: { lastCompleteTickAt: o.tickAgo === null ? null : iso(NOW - (o.tickAgo ?? 0)) },
    generatedAt: iso(NOW),
  };
}

const client = (body: unknown | (() => unknown)): MonitorClient => ({
  where: "monitor.test",
  async status() {
    const b = typeof body === "function" ? (body as () => unknown)() : body;
    if (b instanceof Error) throw b;
    return typeof b === "string" ? b : JSON.stringify(b);
  },
  async price() {
    return "{}";
  },
});

const read = (body: unknown, o: { payoutDelayS?: number; holdFile?: string; nowMs?: number } = {}) =>
  readMonitor({ client: client(body), holdFile: o.holdFile, deployment: DEPLOYMENT, payoutDelayS: o.payoutDelayS ?? 86_400, nowMs: o.nowMs ?? NOW_MS });

describe("the lag limit (the monitor's formula, indexer rules/ops.ts lagLimitOf)", () => {
  it("is a quarter of the payout delay, at most 30 minutes", () => {
    expect(lagLimitS(3_600)).toBe(900);
    expect(lagLimitS(86_400)).toBe(1_800);
    expect(lagLimitS(0)).toBe(1_800);
    expect(lagLimitS(Number.NaN)).toBe(1_800);
  });
});

describe("readMonitor: the hold, the outage and the confirmed keys (monitor plan Task 38)", () => {
  it("a healthy status: no hold, no outage, and the keys it confirmed (lowercase)", async () => {
    const v = await read(status({ okKeys: [KEY.toUpperCase().replace("0X", "0x")] }));
    expect(v.hold).toBeUndefined();
    expect(v.outage).toBeUndefined();
    expect([...(v.okKeys ?? [])]).toEqual([KEY]);
  });

  it("no monitor configured is an outage: the v3.2 keeper never sends without one (the founder: stop when the monitor can't see)", async () => {
    const v = await readMonitor({ client: null, deployment: DEPLOYMENT, payoutDelayS: 86_400, nowMs: NOW_MS });
    expect(v.outage).toMatch(/^no monitor is configured/);
    expect(v.hold).toBeUndefined();
  });

  it("ops/hold.json: hold true holds, so does a file that can't be read; hold false holds nothing", async () => {
    expect((await read(status(), { holdFile: '{"hold": true, "reason": "checking a swap"}' })).hold).toBe("ops/hold.json holds the keeper (checking a swap)");
    expect((await read(status(), { holdFile: '{"hold": true}' })).hold).toBe("ops/hold.json holds the keeper");
    expect((await read(status(), { holdFile: "{hold: yes" })).hold).toMatch(/^ops\/hold\.json can't be read/);
    expect((await read(status(), { holdFile: '{"hold": "no"}' })).hold).toMatch(/^ops\/hold\.json can't be read/);
    expect((await read(status(), { holdFile: '{"hold": false}' })).hold).toBeUndefined();
    expect(holdFileHold('{"hold": false}')).toBeUndefined();
  });

  it("unreadable, not JSON, not a status, v not 1, or another deployment: an outage", async () => {
    expect((await read(new MonitorUnreadable("a network error"))).outage).toBe("the monitor (monitor.test) could not be read: a network error");
    expect((await read("<html>")).outage).toBe("the monitor's status (monitor.test) is not JSON");
    expect((await read({ v: 1 })).outage).toBe("the monitor's status (monitor.test) is not one the keeper reads");
    expect((await read(status({ v: 2 }))).outage).toBe("the monitor's status is version 2, not 1");
    expect((await read(status({ deployment: { frontDoor: at("fd99") } }))).outage).toMatch(/^the monitor \(monitor\.test\) watches another deployment \(its front door 0x[0-9a-fA-F]{40}, its vault/);
    expect((await read(status({ deployment: { vault: at("7a99") } }))).outage).toMatch(/watches another deployment/);
    // the addresses' case doesn't matter
    expect((await read(status({ deployment: { frontDoor: FD.toLowerCase() as Address } }))).outage).toBeUndefined();
  });

  it("payoutDelay 3,600: a Bittensor lag of 800 s plus a status 101 s old (901 s) is an outage; 899 s isn't", async () => {
    const out = await read(status({ lag: { bittensor: 800 }, settledAgo: { bittensor: 800 }, tickAgo: 101 }), { payoutDelayS: 3_600 });
    expect(out.outage).toBe("Bittensor is 15 minutes behind by the monitor's own reading (a lag of 800 s, its last complete tick 101 s ago), over the 15-minute limit");
    const ok = await read(status({ lag: { bittensor: 800 }, settledAgo: { bittensor: 800 }, tickAgo: 99 }), { payoutDelayS: 3_600 });
    expect(ok.outage).toBeUndefined();
  });

  it("a status whose lagS reads small but whose Bittensor settledTime is 16 minutes old by the keeper's clock is an outage (the second test)", async () => {
    const v = await read(status({ lag: { bittensor: 60 }, settledAgo: { bittensor: 16 * 60 } }), { payoutDelayS: 3_600 });
    expect(v.outage).toBe("Bittensor's newest settled block is 16 minutes old by the keeper's clock, over the 15-minute limit");
  });

  it("with payoutDelay 86,400 the limit is 1,800 s", async () => {
    expect((await read(status({ lag: { base: 1_700 }, tickAgo: 50 }))).outage).toBeUndefined();
    expect((await read(status({ lag: { base: 1_790 }, tickAgo: 20 }))).outage).toMatch(/^Base is 30 minutes behind by the monitor's own reading/);
  });

  it("no tick completed, no reading of a chain, or a chain with no settled block: an outage naming it", async () => {
    expect((await read(status({ tickAgo: null }))).outage).toBe("the monitor has completed no tick yet");
    expect((await read(status({ indexer: { base: null } }))).outage).toBe("the monitor has no reading of Base");
    expect((await read(status({ indexer: { bittensor: { settledTo: 0, settledTime: null, lagS: null } } }))).outage).toBe("the monitor has settled no block of Bittensor yet");
  });

  it("the logs RPC down for 35 minutes (the monitor's own test, indexer tick.test.ts:248): an outage once the lag passes the limit, healthy again after", async () => {
    // the sequence that test records, minute by minute: Base's lag grows 60 s a minute while the readings go on (each
    // tick completes, so the status is fresh), then the scan catches up in a tick
    const seen: (string | undefined)[] = [];
    for (let m = 1; m <= 35; m++) seen.push((await read(status({ lag: { base: 60 + 60 * m }, tickAgo: 10 }), { payoutDelayS: 3_600 })).outage);
    const firstOut = seen.findIndex((o) => o !== undefined) + 1;
    // 60 + 60m > 900 - 10 first at m = 14 (lag 900 s plus 10 s since the tick)
    expect(firstOut).toBe(14);
    expect(seen.slice(firstOut - 1).every((o) => o?.startsWith("Base is "))).toBe(true);
    const back = await read(status({ lag: { base: 90 }, tickAgo: 10 }), { payoutDelayS: 3_600 });
    expect(back.outage).toBeUndefined();
  });

  it("a status with no version at all is an outage, as any v not 1 (T50a review M1)", async () => {
    const { v: _, ...noV } = status();
    expect((await read(noV)).outage).toBe("the monitor's status is version none, not 1");
    expect((await read([])).outage).toBe("the monitor's status (monitor.test) is not one the keeper reads");
  });

  it("a hold the monitor states holds even when the rest of its status fails the checks, so no override passes it (T50a review M2)", async () => {
    for (const body of [status({ hold: ["h-9"], v: 2 }), { hold: { active: true, ids: ["h-9"] } }, { ...status({ hold: ["h-9"] }), deployment: { frontDoor: at("fd99"), vault: VAULT } }]) {
      const v = await read(body);
      expect(v.hold, JSON.stringify(body).slice(0, 60)).toBe("the monitor holds the keeper (hold h-9)");
      expect(v.outage).toBeDefined();
      expect(monitorGate(v, { until: NOW_MS + 3_600_000 }, NOW_MS).stop).toMatch(/^HOLD: the monitor holds the keeper \(hold h-9\)/);
    }
  });

  it("a hold and an outage can both be present", async () => {
    const v = await read(status({ hold: ["h-7f3a", "h-91c2"], lag: { base: 4_000 } }));
    expect(v.hold).toBe("the monitor holds the keeper (hold h-7f3a, h-91c2)");
    expect(v.outage).toMatch(/^Base is 66 minutes behind/);
  });
});

describe("monitorOverHttp: GET /v1/status and /v1/price with a timeout, and a reason that never carries the URL", () => {
  const SECRET = "https://user:pw@mon.example.com/secret-path/abc?key=XYZ";

  it("reads the routes under the base URL (a URL that already ends in /v1/status is taken as its base)", async () => {
    const asked: string[] = [];
    const fetch = (async (url: string) => {
      asked.push(url);
      return new Response(url.endsWith("/v1/price") ? '{"v":1}' : '{"v":1,"x":1}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const c = monitorOverHttp("https://mon.example.com", { fetch });
    expect(c.where).toBe("mon.example.com");
    await c.status();
    await c.price();
    await monitorOverHttp("https://mon.example.com/v1/status", { fetch }).status();
    expect(asked).toEqual(["https://mon.example.com/v1/status", "https://mon.example.com/v1/price", "https://mon.example.com/v1/status"]);
  });

  it("a network error, a status that isn't 200, an answer that is too big or none in time: MonitorUnreadable, with no URL, path, key or password in it", async () => {
    const failing = (f: () => Promise<Response>) => (() => f()) as unknown as typeof globalThis.fetch;
    const reasons: string[] = [];
    const tries: [string, typeof globalThis.fetch][] = [
      ["network", failing(() => Promise.reject(new TypeError(`fetch failed for ${SECRET}/v1/status`)))],
      ["503", failing(async () => new Response(`down at ${SECRET}`, { status: 503 }))],
      ["big", failing(async () => new Response("x".repeat(70_000), { status: 200 }))],
    ];
    for (const [, fetch] of tries) {
      const e = await monitorOverHttp(SECRET, { fetch }).status().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(MonitorUnreadable);
      reasons.push((e as Error).message);
    }
    // no answer in time: aborted at the timeout
    const slow = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof globalThis.fetch;
    const late = await monitorOverHttp(SECRET, { fetch: slow, statusTimeoutMs: 5 }).status().catch((x: unknown) => x);
    expect(late).toBeInstanceOf(MonitorUnreadable);
    reasons.push((late as Error).message);
    expect(reasons).toEqual(["a network error", "it answered HTTP 503", "its answer is over 65536 bytes", "no answer within 0.005 s"]);
    const v = await readMonitor({ client: monitorOverHttp(SECRET, { fetch: tries[0][1] }), deployment: DEPLOYMENT, payoutDelayS: 86_400, nowMs: NOW_MS });
    for (const r of [...reasons, v.outage as string]) {
      for (const leak of ["secret-path", "XYZ", "pw@", "user:", "/v1/status"]) expect(r, r).not.toContain(leak);
    }
    expect(v.outage).toBe("the monitor (mon.example.com) could not be read: a network error");
    expect(STATUS_TIMEOUT_MS).toBe(10_000);
  });
});

describe("the gate: a hold stops everything; an outage too, unless a hand run's --ignore-monitor-outage covers it (never a hold)", () => {
  const view = { okKeys: new Set([KEY]) };

  it("healthy: nothing stops, the confirmed keys are the monitor's", () => {
    expect(monitorGate(view, undefined, NOW_MS)).toEqual({ okKeys: view.okKeys });
  });

  it("a hold stops every send, whatever the override says", () => {
    const g = monitorGate({ hold: "the monitor holds the keeper (hold h-1)" }, { until: NOW_MS + 3_600_000 }, NOW_MS);
    expect(g.stop).toBe("HOLD: the monitor holds the keeper (hold h-1): nothing is sent (no close, payout, stake, claim, delivery or park job) until it clears");
    expect(g.okKeys).toBeUndefined();
  });

  it("an outage stops every send; the override lets a hand run go on until --until, with a warning, and no per-key check", () => {
    const out = { outage: "the monitor (monitor.test) could not be read: a network error" };
    expect(monitorGate(out, undefined, NOW_MS).stop).toBe("THE MONITOR CAN'T SEE: the monitor (monitor.test) could not be read: a network error: nothing is sent until it can");
    const until = NOW_MS + 3_600_000;
    const g = monitorGate(out, { until }, NOW_MS);
    expect(g.stop).toBeUndefined();
    expect(g.okKeys).toBeUndefined();
    expect(g.warn).toBe(
      `MONITOR OUTAGE IGNORED until ${new Date(until).toISOString()} (--ignore-monitor-outage): the monitor (monitor.test) could not be read: a network error; sending without the monitor's checks, payouts it hasn't confirmed included`,
    );
    // at --until it lapses
    expect(monitorGate(out, { until }, until).stop).toMatch(/^THE MONITOR CAN'T SEE/);
    // a hold and an outage: the hold stops it, the override or not
    expect(monitorGate({ ...out, hold: "ops/hold.json holds the keeper" }, { until }, NOW_MS).stop).toMatch(/^HOLD: ops\/hold\.json holds the keeper/);
  });

  it("--until: a UTC time at most 24 h ahead; in the past, more than 24 h ahead, or not a time: refused", () => {
    expect(monitorOverride(new Date(NOW_MS + 3_600_000).toISOString(), NOW_MS)).toEqual({ until: NOW_MS + 3_600_000 });
    expect(monitorOverride(new Date(NOW_MS + OVERRIDE_MAX_MS).toISOString(), NOW_MS).until).toBe(NOW_MS + OVERRIDE_MAX_MS);
    expect(() => monitorOverride(new Date(NOW_MS - 1_000).toISOString(), NOW_MS)).toThrow(/is not ahead of now/);
    expect(() => monitorOverride(new Date(NOW_MS + OVERRIDE_MAX_MS + 1_000).toISOString(), NOW_MS)).toThrow(/more than 24 hours ahead/);
    expect(() => monitorOverride("tomorrow", NOW_MS)).toThrow(/not a UTC time/);
    expect(() => monitorOverride("2027-01-18 14:05", NOW_MS)).toThrow(/not a UTC time/);
  });
});
