import { env } from "cloudflare:workers";
import { type Hex, keccak256, toBytes } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { VAULT } from "../../src/abi.ts";
import type { Config } from "../../src/config.ts";
import { runHourly } from "../../src/hourly.ts";
import { LOGS_CHECK_WINDOW, runLogsCheck } from "../../src/logs-check.ts";
import type { RawLog } from "../../src/logs.ts";
import { indexerUnverified } from "../../src/rules/ops.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import { REREAD, SETTLE } from "../../src/scan.ts";
import { setMeta } from "../../src/store.ts";
import { DEFAULTS } from "../../src/thresholds.ts";
import { wipe } from "./d1-count.ts";
import { type ChainSpec, fakeChains, TEST_URLS } from "./fake-rpc.ts";
import { rawLog } from "./fixtures.ts";
import { ruleCtx } from "./rule-ctx.ts";
import { roundTrip, rows, type SentEmail, tickWorld } from "./tick-world.ts";

// The hourly cross-validation of the logs: a second, independent RPC per chain re-reads a recent settled range of
// the watched addresses, and its logs are compared with what the primary had the tick store.

const db = env.DB;
const h = (s: string) => keccak256(toBytes(s)) as Hex;

beforeEach(async () => {
  await wipe(db);
});

/** A world ticked until a round trip's logs are stored and settled on both chains, and a second fake of each chain
 * (its own logs, its own head) answering the second URLs. */
type Trip = ReturnType<typeof roundTrip>;
type SecondLogs = (chain: "base" | "bittensor", primary: RawLog[], x: { cfg: Config; trip: Trip }) => RawLog[];

async function world(o: { secondLogs?: SecondLogs; secondHeads?: { base?: bigint; bittensor?: bigint } } = {}) {
  const w = tickWorld({ over: { ALERT_MODE: "send", ALERT_TO: "owner@example.com", BASE_LOGS_RPC_URL_2: TEST_URLS.baseLogs2, BITTENSOR_RPC_URL_2: TEST_URLS.bittensor2 } });
  const trip = roundTrip(w.cfg, { id: 1n });
  w.addLogs("base", trip.base);
  w.addLogs("bittensor", trip.bit);
  // settle everything: the heads move 30 and 5 blocks a minute, the logs sit 200-400 blocks below the first heads
  for (let i = 0; i < 4; i++) {
    await w.tick();
    w.advance();
  }
  const logsOf = (chain: "base" | "bittensor") => (o.secondLogs ? o.secondLogs(chain, w.specs[chain].logs ?? [], { cfg: w.cfg, trip }) : [...(w.specs[chain].logs ?? [])]);
  const second = {
    base: { head: o.secondHeads?.base ?? w.specs.base.head, logs: logsOf("base") } as ChainSpec,
    bittensor: { head: o.secondHeads?.bittensor ?? w.specs.bittensor.head, logs: logsOf("bittensor") } as ChainSpec,
  };
  const net2 = fakeChains(second);
  const SECOND_HOSTS = new Set([new URL(TEST_URLS.baseLogs2).host, new URL(TEST_URLS.bittensor2).host]);
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return SECOND_HOSTS.has(new URL(url).host) ? net2.fetch(input, init) : w.net.fetch(input, init);
  }) as typeof globalThis.fetch;
  const email = { send: async (m: SentEmail) => void w.sent.push(m) } as unknown as SendEmail;
  // the fake clock: a retry's backoff moves it instead of waiting
  const deps = (nowS = w.nowS()) => ({ env: { DB: db, EMAIL: email }, cfg: w.cfg, nowS, fetch, now: () => w.clock.ms, sleep: async (ms: number) => void (w.clock.ms += ms) });
  const cursors = Object.fromEntries((await rows<{ chain: string; settled_to: number }>("SELECT chain, settled_to FROM cursors")).map((r) => [r.chain, BigInt(r.settled_to)])) as Record<"base" | "bittensor", bigint>;
  return { w, trip, second, net2, deps, cursors, sentBefore: w.sent.length };
}

const meta = async () => Object.fromEntries((await rows<{ k: string; v: string }>("SELECT k, v FROM meta")).map((r) => [r.k, r.v]));
/** The cross-check's open alerts (the ticks of this fake world open a few of their own). */
const alerts = () =>
  rows<{ alert_key: string; rule: string; tier: string; subject: string; body: string }>(
    "SELECT alert_key, rule, tier, subject, body FROM alerts WHERE resolved_at IS NULL AND rule IN ('indexer.logs_omitted', 'indexer.logs_extra') ORDER BY id",
  );
/** The emails about the cross-check. */
const aboutLogs = (sent: readonly SentEmail[]) => sent.filter((m) => /logs RPC|lacks a log/.test(m.subject));

describe("runLogsCheck", () => {
  it("re-reads each chain's newest settled range through the second endpoint, finds the same logs, records where it got to, and sends nothing", async () => {
    const { w, deps, cursors, net2 } = await world();
    const r = await runLogsCheck(deps());
    // the newest cap's worth of settled blocks, never before the deployment's start (this world is younger than the cap)
    const max = (a: bigint, b: bigint) => (a > b ? a : b);
    const from = { base: max(cursors.base - BigInt(DEFAULTS.logsCheckBaseBlocks) + 1n, w.cfg.deployment.base.startBlock), bittensor: max(cursors.bittensor - BigInt(DEFAULTS.logsCheckBittensorBlocks) + 1n, w.cfg.deployment.bittensor.startBlock) };
    expect(r).toEqual({
      base: { from: from.base, to: cursors.base, primary: 7, second: 7, omitted: 0, extra: 0 },
      bittensor: { from: from.bittensor, to: cursors.bittensor, primary: 9, second: 9, omitted: 0, extra: 0 },
    });
    const m = await meta();
    expect([m["logs_check_to:base"], m["logs_check_to:bittensor"]]).toEqual([String(cursors.base), String(cursors.bittensor)]);
    expect(m["logs_check_fail_since:base"] ?? "").toBe("");
    expect(await alerts()).toEqual([]);
    expect(aboutLogs(w.sent)).toEqual([]);
    // Base in windows of its log window (100 blocks) to the second logs URL; Bittensor in one window
    const asked = net2.fetches.map((f) => [f.chain, new URL(f.url).host, f.methods.join("+")]);
    expect(asked.filter(([c]) => c === "base").every(([, host, m]) => host === new URL(TEST_URLS.baseLogs2).host && m === "eth_getLogs+eth_blockNumber")).toBe(true);
    expect(asked.filter(([c]) => c === "base")).toHaveLength(Math.ceil(Number(cursors.base - from.base + 1n) / Number(w.cfg.baseLogWindow)));
    expect(asked.filter(([c]) => c === "bittensor")).toHaveLength(1);
    expect(LOGS_CHECK_WINDOW.bittensor).toBeGreaterThanOrEqual(BigInt(DEFAULTS.logsCheckBittensorBlocks));
  });

  it("checks on from where it left off on the next run, never twice, and never more than the cap at once", async () => {
    const { w, deps, cursors } = await world();
    await runLogsCheck(deps());
    // nothing new settled: nothing to check
    expect(await runLogsCheck(deps())).toEqual({ base: { from: cursors.base + 1n, to: cursors.base, primary: 0, second: 0, omitted: 0, extra: 0 }, bittensor: { from: cursors.bittensor + 1n, to: cursors.bittensor, primary: 0, second: 0, omitted: 0, extra: 0 } });
    // a few more blocks settled: just those; a long gap (the job missed hours): the newest cap's worth
    await db.batch([
      db.prepare("UPDATE cursors SET settled_to = settled_to + 50 WHERE chain = 'base'"),
      db.prepare("UPDATE cursors SET settled_to = settled_to + 5000 WHERE chain = 'bittensor'"),
    ]);
    w.specs.base.head += 50n;
    w.specs.bittensor.head += 5000n;
    const r = await runLogsCheck({ ...deps(), fetch: w.net.fetch });
    expect(r.base).toMatchObject({ from: cursors.base + 1n, to: cursors.base + 50n });
    expect(r.bittensor).toMatchObject({ from: cursors.bittensor + 5000n - BigInt(DEFAULTS.logsCheckBittensorBlocks) + 1n, to: cursors.bittensor + 5000n });
  });

  it("the primary omitted a watched event: the second has a vault log the store doesn't, a critical names it, with the counts and hashes", async () => {
    const { w, deps, cursors } = await world({
      secondLogs: (chain, primary, { cfg }) =>
        chain === "bittensor"
          ? [...primary, rawLog({ address: cfg.deployment.vault, abi: VAULT, eventName: "KeeperSet", args: { keeper: "0x00000000000000000000000000000000000000ee" }, block: 6_900_170n, logIndex: 0, txHash: h("the hidden keeper change") })]
          : primary,
    });
    expect(cursors.bittensor).toBeGreaterThan(6_900_170n);
    const r = await runLogsCheck(deps());
    expect(r.bittensor).toMatchObject({ primary: 9, second: 10, omitted: 1, extra: 0 });
    const open = await alerts();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ rule: "indexer.logs_omitted", tier: "critical", subject: "The Bittensor logs RPC omitted a watched event: vault KeeperSet" });
    expect(open[0].alert_key).toMatch(/^indexer\.logs_omitted:0x[0-9a-f]{64}$/);
    for (const line of ["chain: bittensor", "event: vault KeeperSet", "block: 6900170", `transaction: https://evm.taostats.io/tx/${h("the hidden keeper change")}`, "primary: 9 logs", "second: 10 logs", "primary endpoint: rpc.test", "second endpoint: second.test", "omitted: 1"]) {
      expect(open[0].body).toContain(line);
    }
    expect(open[0].body).toMatch(/range: 6\d{6}-6\d{6}/);
    expect(open[0].body).not.toContain("second-key");
    expect(aboutLogs(w.sent).map((m) => m.subject)).toEqual(["[CASCADE CRITICAL] The Bittensor logs RPC omitted a watched event: vault KeeperSet"]);
    expect(aboutLogs(w.sent)[0].text).toContain("switch BITTENSOR_RPC_URL");
    // the next run (before the hourly resend is due) finds it still missing: the same alert, no second email
    await runLogsCheck(deps(w.nowS() + 1800));
    expect(await alerts()).toHaveLength(1);
    expect(aboutLogs(w.sent)).toHaveLength(1);
  });

  it("the store has a log the second lacks: a warning, and only once the second node is REREAD blocks past it", async () => {
    const { w, deps } = await world({ secondLogs: (chain, primary, { trip }) => (chain === "base" ? primary.filter((l) => l.transactionHash !== trip.closeTx) : primary) });
    const r = await runLogsCheck(deps());
    // the close's two logs (the adapter's Sent and BatchClosed) are stored and missing from the second
    expect(r.base).toMatchObject({ primary: 7, second: 5, omitted: 0, extra: 2 });
    const open = await alerts();
    expect(open.map((a) => [a.rule, a.tier])).toEqual([
      ["indexer.logs_extra", "warning"],
      ["indexer.logs_extra", "warning"],
    ]);
    expect(open[0].subject).toBe("The second Base RPC lacks a log the Base logs RPC served: Base adapter Sent");
    expect(open[0].body).toContain("lacking: 2");
    // warnings go out together at the usual cadence: with none sent in the last 30 minutes, now
    const warning = aboutLogs(w.sent);
    expect(warning.map((m) => m.subject)).toEqual([expect.stringMatching(/^\[Cascade warning\] \d+ new: /)]);
    expect(warning[0].text).toContain("The second Base RPC lacks a log the Base logs RPC served: Base adapter Sent");
    expect(warning[0].text).toContain("pruned");
  });

  it("judges nothing from a second node that hasn't settled the range, and keeps the range for the next run", async () => {
    const { deps } = await world({ secondHeads: { base: 37_000_000n, bittensor: 6_900_100n } });
    const r = await runLogsCheck(deps());
    expect(r).toEqual({ base: "behind", bittensor: "behind" });
    const m = await meta();
    expect(m["logs_check_to:base"]).toBeUndefined();
    expect(m["logs_check_to:bittensor"]).toBeUndefined();
    expect(await alerts()).toEqual([]);
  });

  it("a second node past SETTLE but not REREAD judges omissions, not absences (the scan's rule for trusting an absence)", async () => {
    const { w, deps, cursors, trip } = await world();
    // the second Bittensor node: just past the settled range, less than REREAD past the delivery's block, without the
    // delivery's seven logs
    const second = fakeChains({
      bittensor: { head: cursors.bittensor + SETTLE.bittensor, logs: (w.specs.bittensor.logs ?? []).filter((l) => l.transactionHash !== trip.deliveryTx) },
      base: { head: w.specs.base.head, logs: w.specs.base.logs },
    });
    const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new URL(url).host === new URL(TEST_URLS.bittensor2).host ? second.fetch(input, init) : deps().fetch(input, init);
    }) as typeof globalThis.fetch;
    const r = await runLogsCheck({ ...deps(), fetch });
    expect(r.bittensor).toMatchObject({ omitted: 0, extra: 0, primary: 9, second: 2 });
    expect(await alerts()).toEqual([]);
    expect(REREAD.bittensor).toBeGreaterThan(SETTLE.bittensor);
  });

  it("a second endpoint that fails: nothing judged, the failure noted in meta; the tick warns after 3 hours of it, and a working run clears it", async () => {
    const { w, deps } = await world();
    const failing = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).host === new URL(TEST_URLS.bittensor2).host) return Promise.resolve(new Response("busy", { status: 503 }));
      return deps().fetch(input, init);
    }) as typeof globalThis.fetch;
    const t0 = w.nowS();
    const r = await runLogsCheck({ ...deps(t0), fetch: failing });
    expect(r.bittensor).toBe("failed");
    expect(typeof r.base).toBe("object");
    const m = await meta();
    expect(m["logs_check_fail_since:bittensor"]).toBe(String(t0));
    expect(m["logs_check_error:bittensor"]).toContain("HTTP 503");
    expect(m["logs_check_error:bittensor"]).not.toContain("second-key");
    expect(await alerts()).toEqual([]);
    // the tick's rule: quiet for 3 hours, then a warning naming the chain and the error
    const ctxAt = async (nowS: number) => ruleCtx({ nowS, meta: await meta() });
    expect(indexerUnverified.run(await ctxAt(t0 + 3 * 3600 - 1))).toEqual([]);
    const [f] = indexerUnverified.run(await ctxAt(t0 + 3 * 3600));
    expect(f).toMatchObject({ rule: "indexer.unverified", key: "indexer.unverified:bittensor" });
    expect(f.subject).toBe("Bittensor's logs haven't been cross-checked for 3 hours");
    expect(f.facts).toMatchObject({ chain: "bittensor", error: expect.stringContaining("HTTP 503") });
    expect(RUNBOOK["indexer.unverified"](f.facts)).toContain("BITTENSOR_RPC_URL_2");
    // the second run still fails: the first failure's time is kept
    await runLogsCheck({ ...deps(t0 + 3600), fetch: failing });
    expect((await meta())["logs_check_fail_since:bittensor"]).toBe(String(t0));
    // a working run clears it (the condition then resolves)
    await runLogsCheck(deps(t0 + 7200));
    expect((await meta())["logs_check_fail_since:bittensor"]).toBe("");
    expect(indexerUnverified.run(await ctxAt(t0 + 4 * 3600))).toEqual([]);
  });

  it("skips a chain still catching up in its first backfill (an old range a non-archive second node may not have)", async () => {
    const { deps } = await world();
    await setMeta(db, "catching_up", "bittensor").run();
    const r = await runLogsCheck(deps());
    expect(r.bittensor).toBe("catching up");
    expect(typeof r.base).toBe("object");
  });

  it("runs with the hourly job, within a budget of its own", async () => {
    const { w, deps, net2 } = await world();
    const r = await runHourly(deps());
    expect(r.watchdog.stalled).toBe(false);
    expect(typeof r.logsCheck.base).toBe("object");
    expect(net2.count()).toBeGreaterThan(0);
    expect(net2.count()).toBeLessThanOrEqual(12);
    expect(aboutLogs(w.sent)).toEqual([]);
  });
});
