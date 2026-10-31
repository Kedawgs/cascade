import { env } from "cloudflare:workers";
import { type Hex, keccak256, toBytes } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { VAULT } from "../../src/abi.ts";
import { type Config, rolesOf } from "../../src/config.ts";
import { runHourly } from "../../src/hourly.ts";
import { LOGS_CHECK_WINDOW, runLogsCheck } from "../../src/logs-check.ts";
import { decode, identify, type RawLog } from "../../src/logs.ts";
import { indexerUnverified } from "../../src/rules/ops.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import { REREAD, SETTLE } from "../../src/scan.ts";
import { setMeta, upsertLogs } from "../../src/store.ts";
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
type Cursors = Record<"base" | "bittensor", bigint>;
type SecondLogs = (chain: "base" | "bittensor", primary: RawLog[], x: { cfg: Config; trip: Trip; cursors: Cursors }) => RawLog[];

async function world(o: { secondLogs?: SecondLogs; secondHeads?: { base?: bigint; bittensor?: bigint } } = {}) {
  const w = tickWorld({ over: { ALERT_MODE: "send", ALERT_TO: "owner@example.com", BASE_LOGS_RPC_URL_2: TEST_URLS.baseLogs2, BITTENSOR_RPC_URL_2: TEST_URLS.bittensor2 } });
  const trip = roundTrip(w.cfg, { id: 1n });
  w.addLogs("base", trip.base);
  w.addLogs("bittensor", trip.bit);
  // settle everything, and re-read it: the check judges only blocks REREAD (70 and 400) below the settled point,
  // so Bittensor's head is moved 500 blocks on after the logs settled (Base's 2-second blocks need no help)
  for (let i = 0; i < 4; i++) {
    if (i === 2) w.specs.bittensor.head += 500n;
    await w.tick();
    w.advance();
  }
  const cursors = Object.fromEntries((await rows<{ chain: string; settled_to: number }>("SELECT chain, settled_to FROM cursors")).map((r) => [r.chain, BigInt(r.settled_to)])) as Cursors;
  const logsOf = (chain: "base" | "bittensor") => (o.secondLogs ? o.secondLogs(chain, w.specs[chain].logs ?? [], { cfg: w.cfg, trip, cursors }) : [...(w.specs[chain].logs ?? [])]);
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
  /** the end of what a run judges: the settled point less REREAD, the blocks the tick has re-read from a node well past them */
  const to = { base: cursors.base - REREAD.base, bittensor: cursors.bittensor - REREAD.bittensor };
  return { w, trip, second, net2, deps, cursors, to, sentBefore: w.sent.length };
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
  it("re-reads each chain's newest re-read range (the settled point less REREAD) through the second endpoint, finds the same logs, records where it got to, and sends nothing", async () => {
    const { w, deps, to, net2 } = await world();
    const r = await runLogsCheck(deps());
    // the newest cap's worth of blocks the tick has re-read, never before the deployment's start (this world is younger than the cap)
    const max = (a: bigint, b: bigint) => (a > b ? a : b);
    const from = { base: max(to.base - BigInt(DEFAULTS.logsCheckBaseBlocks) + 1n, w.cfg.deployment.base.startBlock), bittensor: max(to.bittensor - BigInt(DEFAULTS.logsCheckBittensorBlocks) + 1n, w.cfg.deployment.bittensor.startBlock) };
    expect(r).toEqual({
      base: { from: from.base, to: to.base, primary: 7, second: 7, omitted: 0, extra: 0 },
      bittensor: { from: from.bittensor, to: to.bittensor, primary: 9, second: 9, omitted: 0, extra: 0 },
    });
    const m = await meta();
    expect([m["logs_check_to:base"], m["logs_check_to:bittensor"]]).toEqual([String(to.base), String(to.bittensor)]);
    expect(m["logs_check_fail_since:base"] ?? "").toBe("");
    expect(await alerts()).toEqual([]);
    expect(aboutLogs(w.sent)).toEqual([]);
    // Base in windows of its log window (100 blocks) to the second logs URL; Bittensor in one window
    const asked = net2.fetches.map((f) => [f.chain, new URL(f.url).host, f.methods.join("+")]);
    expect(asked.filter(([c]) => c === "base").every(([, host, m]) => host === new URL(TEST_URLS.baseLogs2).host && m === "eth_getLogs+eth_blockNumber")).toBe(true);
    expect(asked.filter(([c]) => c === "base")).toHaveLength(Math.ceil(Number(to.base - from.base + 1n) / Number(w.cfg.baseLogWindow)));
    expect(asked.filter(([c]) => c === "bittensor")).toHaveLength(1);
    expect(LOGS_CHECK_WINDOW.bittensor).toBeGreaterThanOrEqual(BigInt(DEFAULTS.logsCheckBittensorBlocks));
  });

  it("never judges the blocks the tick hasn't re-read from a node REREAD past them: a log the primary's lagging log index adds a tick later is no omission", async () => {
    const { w, deps, to, cursors } = await world({
      // the second serves a vault log inside the last REREAD blocks before the settled point: the tick may still add it
      secondLogs: (chain, primary, { cfg, cursors }) =>
        chain === "bittensor"
          ? [...primary, rawLog({ address: cfg.deployment.vault, abi: VAULT, eventName: "KeeperSet", args: { keeper: "0x00000000000000000000000000000000000000ee" }, block: cursors.bittensor - 5n, logIndex: 0, txHash: h("late") })]
          : primary,
    });
    expect(cursors.bittensor - 5n).toBeGreaterThan(to.bittensor);
    const r = await runLogsCheck(deps());
    expect(r.bittensor).toMatchObject({ to: to.bittensor, omitted: 0 });
    expect(await alerts()).toEqual([]);
    expect(aboutLogs(w.sent)).toEqual([]);
  });

  it("checks on from where it left off on the next run, never twice, and never more than the cap at once", async () => {
    const { w, deps, to } = await world();
    await runLogsCheck(deps());
    // nothing new re-read: nothing to check
    expect(await runLogsCheck(deps())).toEqual({ base: { from: to.base + 1n, to: to.base, primary: 0, second: 0, omitted: 0, extra: 0 }, bittensor: { from: to.bittensor + 1n, to: to.bittensor, primary: 0, second: 0, omitted: 0, extra: 0 } });
    // a few more blocks settled: just those; a long gap (the job missed hours): the newest cap's worth
    await db.batch([
      db.prepare("UPDATE cursors SET settled_to = settled_to + 50 WHERE chain = 'base'"),
      db.prepare("UPDATE cursors SET settled_to = settled_to + 5000 WHERE chain = 'bittensor'"),
    ]);
    w.specs.base.head += 50n;
    w.specs.bittensor.head += 5000n;
    const r = await runLogsCheck({ ...deps(), fetch: w.net.fetch });
    expect(r.base).toMatchObject({ from: to.base + 1n, to: to.base + 50n });
    expect(r.bittensor).toMatchObject({ from: to.bittensor + 5000n - BigInt(DEFAULTS.logsCheckBittensorBlocks) + 1n, to: to.bittensor + 5000n });
  });

  it("the primary omitted watched events: one critical per chain names them all, with the counts and hashes; it resolves once the store has them", async () => {
    const hidden = (cfg: Config) => [
      rawLog({ address: cfg.deployment.vault, abi: VAULT, eventName: "KeeperSet", args: { keeper: "0x00000000000000000000000000000000000000ee" }, block: 6_900_170n, logIndex: 0, txHash: h("the hidden keeper change") }),
      rawLog({ address: cfg.deployment.vault, abi: VAULT, eventName: "Paused", args: { account: "0x00000000000000000000000000000000000000ee" }, block: 6_900_171n, logIndex: 0, txHash: h("the hidden pause") }),
    ];
    const { w, deps, to } = await world({ secondLogs: (chain, primary, { cfg }) => (chain === "bittensor" ? [...primary, ...hidden(cfg)] : primary) });
    expect(to.bittensor).toBeGreaterThan(6_900_171n);
    const r = await runLogsCheck(deps());
    expect(r.bittensor).toMatchObject({ primary: 9, second: 11, omitted: 2, extra: 0 });
    const open = await alerts();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ alert_key: "indexer.logs_omitted:bittensor", rule: "indexer.logs_omitted", tier: "critical", subject: "The Bittensor logs RPC omitted 2 watched events: vault KeeperSet and 1 more" });
    for (const line of [
      "chain: bittensor",
      "omitted: 2 of the 11 logs the second served",
      `log 1: vault KeeperSet, block 6900170, https://evm.taostats.io/tx/${h("the hidden keeper change")}`,
      `log 2: vault Paused, block 6900171, https://evm.taostats.io/tx/${h("the hidden pause")}`,
      "primary: 9 logs",
      "second: 11 logs",
      "primary endpoint: rpc.test",
      "second endpoint: second.test",
    ]) {
      expect(open[0].body).toContain(line);
    }
    expect(open[0].body).toMatch(/range: 6\d{6}-6\d{6}/);
    expect(open[0].body).not.toContain("second-key");
    expect(aboutLogs(w.sent).map((m) => m.subject)).toEqual(["[CASCADE CRITICAL] The Bittensor logs RPC omitted 2 watched events: vault KeeperSet and 1 more"]);
    expect(aboutLogs(w.sent)[0].text).toContain("switch BITTENSOR_RPC_URL");
    const uids = JSON.parse((await meta())["logs_omitted_uids:bittensor"]) as string[];
    expect(uids).toHaveLength(2);
    // the tick leaves the job's alert alone: neither resolved nor re-sent by it, even an hour on
    w.clock.ms += 3700 * 1000;
    w.advance(0);
    await w.tick();
    expect(await alerts()).toHaveLength(1);
    expect(aboutLogs(w.sent)).toHaveLength(1);
    // the job's next run an hour on, the logs still missing: the same alert, re-sent by the job
    await runLogsCheck(deps(w.nowS()));
    expect(await alerts()).toHaveLength(1);
    expect(aboutLogs(w.sent)).toHaveLength(2);
    // the store gets the logs (a later re-read, or by hand): the alert resolves on the next run, quietly
    const stored = identify("bittensor", hidden(w.cfg)).flatMap((x) => {
      const l = decode("bittensor", x, rolesOf(w.cfg.deployment, w.cfg.bridges));
      return l ? [l] : [];
    });
    expect(stored.map((l) => l.uid).sort()).toEqual([...uids].sort());
    await db.batch(upsertLogs(db, stored));
    const healed = await runLogsCheck(deps(w.nowS() + 3600));
    expect(await alerts()).toEqual([]);
    expect((await meta())["logs_omitted_uids:bittensor"]).toBe("");
    expect(aboutLogs(w.sent)).toHaveLength(2);
    expect(await rows("SELECT alert_key FROM alerts WHERE alert_key = 'indexer.logs_omitted:bittensor' AND resolved_at IS NOT NULL")).toHaveLength(1);
    void healed;
  });

  it("the omitted uids go with their alert: acknowledged, closed after 7 days, or gone, so a later alert heals on its own logs", async () => {
    const hidden = (cfg: Config) => [rawLog({ address: cfg.deployment.vault, abi: VAULT, eventName: "KeeperSet", args: { keeper: "0x00000000000000000000000000000000000000ee" }, block: 6_900_170n, logIndex: 0, txHash: h("hidden") })];
    const { w, deps, second, to } = await world({ secondLogs: (chain, primary, { cfg }) => (chain === "bittensor" ? [...primary, ...hidden(cfg)] : primary) });
    const uidsMeta = async () => (await meta())["logs_omitted_uids:bittensor"] ?? "";
    const withoutHidden = () => (second.bittensor.logs ?? []).filter((l) => l.transactionHash !== h("hidden") && l.transactionHash !== h("hidden 2"));
    // acknowledged by the owner: the next run closes the alert (as reconcile does any acknowledged event) and clears the uids
    await runLogsCheck(deps());
    expect(JSON.parse(await uidsMeta())).toHaveLength(1);
    await db.prepare("UPDATE alerts SET acknowledged_at = ?1 WHERE alert_key = 'indexer.logs_omitted:bittensor'").bind(w.nowS()).run();
    // the second now agrees (the primary stopped lying): nothing re-found
    second.bittensor.logs = withoutHidden();
    await runLogsCheck(deps(w.nowS() + 3600));
    expect(await alerts()).toEqual([]);
    expect(await uidsMeta()).toBe("");
    // closed quietly 7 days after opening: the same (a new omission, in the ten blocks that settle next)
    const hidden2 = rawLog({ address: w.cfg.deployment.vault, abi: VAULT, eventName: "KeeperSet", args: { keeper: "0x00000000000000000000000000000000000000ee" }, block: to.bittensor + 5n, logIndex: 0, txHash: h("hidden 2") });
    second.bittensor.logs = [...withoutHidden(), hidden2];
    await db.prepare("UPDATE cursors SET settled_to = settled_to + 10 WHERE chain = 'bittensor'").run();
    w.specs.bittensor.head += 10n;
    second.bittensor.head += 10n;
    await runLogsCheck(deps(w.nowS() + 7200));
    expect(await alerts()).toHaveLength(1);
    expect(JSON.parse(await uidsMeta())).toHaveLength(1);
    await db.prepare("UPDATE alerts SET opened_at = ?1 WHERE alert_key = 'indexer.logs_omitted:bittensor' AND resolved_at IS NULL").bind(w.nowS() - 8 * 86400).run();
    second.bittensor.logs = withoutHidden();
    await runLogsCheck(deps(w.nowS() + 10_800));
    expect(await alerts()).toEqual([]);
    expect(await uidsMeta()).toBe("");
    // uids left behind with no open alert at all (whatever closed it): cleared on the next run
    await setMeta(db, "logs_omitted_uids:bittensor", JSON.stringify([h("stale uid")])).run();
    await runLogsCheck(deps(w.nowS() + 14_400));
    expect(await uidsMeta()).toBe("");
  });

  it("the store has logs the second lacks: one warning per chain, and only once the second node is REREAD blocks past them", async () => {
    const { w, deps } = await world({ secondLogs: (chain, primary, { trip }) => (chain === "base" ? primary.filter((l) => l.transactionHash !== trip.closeTx) : primary) });
    const r = await runLogsCheck(deps());
    // the close's two logs (the adapter's Sent and BatchClosed) are stored and missing from the second
    expect(r.base).toMatchObject({ primary: 7, second: 5, omitted: 0, extra: 2 });
    const open = await alerts();
    expect(open.map((a) => [a.alert_key, a.tier])).toEqual([["indexer.logs_extra:base", "warning"]]);
    expect(open[0].subject).toBe("The second Base RPC lacks 2 logs the Base logs RPC served: Base adapter Sent and 1 more");
    expect(open[0].body).toContain("lacking: 2 of the 7 logs stored");
    expect(open[0].body).toContain("log 2: front door BatchClosed, block 37000020");
    // warnings go out together at the usual cadence: with none sent in the last 30 minutes, now
    const warning = aboutLogs(w.sent);
    expect(warning.map((m) => m.subject)).toEqual([expect.stringMatching(/^\[Cascade warning\] \d+ new: /)]);
    expect(warning[0].text).toContain("The second Base RPC lacks 2 logs the Base logs RPC served: Base adapter Sent and 1 more");
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
    const { w, deps, to, trip } = await world();
    // the second Bittensor node: just past the range judged, less than REREAD past the delivery's block, without the
    // delivery's seven logs
    const second = fakeChains({
      bittensor: { head: to.bittensor + SETTLE.bittensor, logs: (w.specs.bittensor.logs ?? []).filter((l) => l.transactionHash !== trip.deliveryTx) },
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
