import { env } from "cloudflare:workers";
import type { Hex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { countingDb, wipe } from "./d1-count.ts";
import { BIT_ADAPTER } from "../../src/abi.ts";
import { catchingUpChains } from "../../src/tick.ts";
import { KEEPER, TREASURY_WALLET } from "./fake-deployment.ts";
import { TEST_URLS } from "./fake-rpc.ts";
import { rawLog } from "./fixtures.ts";
import { failingBatches, failingCommits, h, roundTrip, rows, type SentEmail, START_HEADS, stakedLog, T0, tickWorld } from "./tick-world.ts";

const db = env.DB;

beforeEach(async () => {
  await wipe(db);
});

const alertKeys = async () => (await rows<{ alert_key: string }>("SELECT alert_key FROM alerts WHERE resolved_at IS NULL ORDER BY alert_key")).map((r) => r.alert_key);

describe("a first tick", () => {
  it("backfills both chains, stores the logs, reads the state, and evaluates", async () => {
    const w = tickWorld();
    const rt = roundTrip(w.cfg, { id: 1n });
    w.addLogs("base", rt.base);
    w.addLogs("bittensor", rt.bit);
    const r = await w.tick();
    expect(r.outcome).toBe("done");
    const cursors = await rows<{ chain: string; scanned_to: number; settled_to: number; settled_time: number; head_time: number }>(
      "SELECT chain, scanned_to, settled_to, settled_time, head_time FROM cursors ORDER BY chain",
    );
    expect(cursors).toEqual([
      { chain: "base", scanned_to: 37_000_400, settled_to: 37_000_370, settled_time: T0 - 60, head_time: T0 },
      { chain: "bittensor", scanned_to: 6_900_200, settled_to: 6_900_190, settled_time: T0 - 120, head_time: T0 },
    ]);
    expect((await rows("SELECT uid FROM logs")).length).toBe(rt.base.length + rt.bit.length);
    expect(await rows("SELECT base_block, bit_block FROM readings")).toEqual([{ base_block: 37_000_400, bit_block: 6_900_200 }]);
    expect((await rows("SELECT hour FROM hours")).length).toBe(1);
    const meta = Object.fromEntries((await rows<{ k: string; v: string }>("SELECT k, v FROM meta")).map((m) => [m.k, m.v]));
    expect(meta.last_complete_tick).toBe(String(w.nowS()));
    expect(meta.deployment).toBe(w.cfg.deployment.id);
    expect(meta.ticks_run).toBe("1");
    // the seed pages hold the delivery, and the chunk sent
    expect(await rows("SELECT page, count FROM seed_pages")).toEqual([{ page: 0, count: 2 }]);
    // the lease is released
    expect(await rows("SELECT until FROM lease")).toEqual([{ until: 0 }]);
  });
});

describe("the cross-check, end to end (D1 → prefetch → rules)", () => {
  it("passes an honest round trip and raises nothing: the batch ok, the landing ok after its delivered() read", async () => {
    const w = tickWorld();
    const rt = roundTrip(w.cfg, { id: 1n });
    w.addLogs("base", rt.base);
    w.addLogs("bittensor", rt.bit);
    w.state.base.delivered[`${w.cfg.deployment.baseAdapter}:${rt.payoutHash}`] = true;
    await w.tick();
    expect(await rows("SELECT batch_id, status, closed_tx FROM batch_checks")).toEqual([{ batch_id: 1, status: "ok", closed_tx: rt.closeTx }]);
    expect(await rows("SELECT status, expected_hash FROM chunk_checks")).toEqual([{ status: "awaiting_read", expected_hash: rt.payoutHash }]);
    w.advance();
    await w.tick();
    expect(await rows("SELECT status FROM chunk_checks")).toEqual([{ status: "ok" }]);
    expect(await alertKeys()).toEqual([]);
    // both messages arrived
    expect((await rows<{ dst_tx: string | null }>("SELECT dst_tx FROM messages")).every((m) => m.dst_tx !== null)).toBe(true);
    expect(w.sent).toEqual([]);
  });

  it("decides a delivery found by a later re-read from the Base history stored ticks before", async () => {
    const w = tickWorld();
    const rt = roundTrip(w.cfg, { id: 1n, payout: false });
    w.addLogs("base", rt.base);
    await w.tick();
    expect(await rows("SELECT uid FROM logs WHERE chain = 'bittensor'")).toEqual([]);
    w.advance();
    w.addLogs("bittensor", rt.bit);
    await w.tick();
    expect(await rows("SELECT batch_id, status, expected_key, detail FROM batch_checks")).toEqual([{ batch_id: 1, status: "ok", expected_key: rt.key, detail: null }]);
    expect(await alertKeys()).toEqual([]);
  });

  it("checks a landing that settles a tick later from the vault's logs stored the tick before", async () => {
    const w = tickWorld();
    const rt = roundTrip(w.cfg, { id: 1n, blocks: { landing: 37_000_390n } });
    w.addLogs("base", rt.base);
    w.addLogs("bittensor", rt.bit);
    w.state.base.delivered[`${w.cfg.deployment.baseAdapter}:${rt.payoutHash}`] = true;
    await w.tick();
    // within SETTLE of Base's head: not stored yet
    expect(await rows("SELECT status FROM chunk_checks")).toEqual([]);
    const trail: unknown[] = [];
    for (let k = 0; k < 6; k++) {
      w.advance();
      await w.tick();
      trail.push(await rows("SELECT status, expected_hash, detail FROM chunk_checks"));
    }
    expect(trail).toContainEqual([{ status: "awaiting_read", expected_hash: rt.payoutHash, detail: null }]);
    expect(await rows("SELECT status FROM chunk_checks")).toEqual([{ status: "ok" }]);
    expect(await alertKeys()).toEqual([]);
  });

  it("lists an honest batch's key in okKeys while its payouts are pending", async () => {
    const w = tickWorld();
    const rt = roundTrip(w.cfg, { id: 1n, payout: false });
    w.addLogs("base", rt.base);
    w.addLogs("bittensor", rt.bit);
    w.state.bit.payoutBatches[rt.key] = { queuedAt: BigInt(T0 - 600), cursor: 0, count: 1, chunk: 0, remaining: 11n * 10n ** 17n };
    await w.tick();
    w.advance();
    await w.tick();
    expect((await w.status()).payouts.okKeys).toEqual([rt.key]);
    expect(await alertKeys()).toEqual([]);
    // once the vault says the batch is done, it leaves okKeys
    delete w.state.bit.payoutBatches[rt.key];
    w.advance();
    await w.tick();
    expect((await w.status()).payouts.okKeys).toEqual([]);
  });

  it("raises a forged batch's critical and hold and sends one email; its key never enters okKeys", async () => {
    const w = tickWorld({ over: { ALERT_MODE: "send", ALERT_TO: "owner@example.com" } });
    const rt = roundTrip(w.cfg, { id: 1n, payout: false, forge: "key" });
    w.addLogs("base", rt.base);
    w.addLogs("bittensor", rt.bit);
    w.state.bit.payoutBatches[rt.deliveredKey] = { queuedAt: BigInt(T0 - 600), cursor: 0, count: 1, chunk: 0, remaining: 1n };
    await w.tick();
    expect(await rows("SELECT status, expected_key FROM batch_checks")).toEqual([{ status: "mismatch", expected_key: rt.key }]);
    expect(await alertKeys()).toEqual([`bridge.batch:1:${rt.deliveredKey}`]);
    const holds = await rows<{ id: string; public_id: string }>("SELECT id, public_id FROM holds");
    expect(holds.map((x) => x.id)).toEqual([`bridge.batch:1:${rt.deliveredKey}`]);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].subject).toMatch(/^\[CASCADE CRITICAL\] Batch 1's delivery failed the cross-check at step 5/);
    // the email names the hold's public id and the alert's id to acknowledge
    expect(w.sent[0].text).toContain(holds[0].public_id);
    const id = (await rows<{ id: number }>("SELECT id FROM alerts"))[0].id;
    expect(w.sent[0].text).toContain(`alerts:ack -- --env <env> ${id}`);
    w.advance();
    await w.tick();
    const s = await w.status();
    expect(s.payouts.okKeys).toEqual([]);
    expect(s.hold.ids).toEqual([holds[0].public_id]);
    // not sent again the next minute
    expect(w.sent).toHaveLength(1);
  });
});

describe("commit, then send", () => {
  const forged = () => {
    const w = tickWorld({ over: { ALERT_MODE: "send", ALERT_TO: "owner@example.com" } });
    const rt = roundTrip(w.cfg, { id: 1n, payout: false, forge: "key" });
    w.addLogs("base", rt.base);
    w.addLogs("bittensor", rt.bit);
    return { w, rt };
  };

  it("commits an alert before its email goes out", async () => {
    const { w } = forged();
    const seen: unknown[] = [];
    const email = { send: async () => void seen.push(...(await rows("SELECT alert_key, notified_at FROM alerts"))) } as unknown as SendEmail;
    await w.tick({ email });
    expect(seen).toEqual([{ alert_key: expect.stringMatching(/^bridge\.batch:1:/), notified_at: null }]);
    // and marks it sent after
    expect((await rows<{ notified_at: number }>("SELECT notified_at FROM alerts"))[0].notified_at).toBe(w.nowS());
  });

  it("sends no alert email when commit 1 fails, and the db_failing email only at minute 0", async () => {
    const { w } = forged();
    const broken = failingCommits(db, () => true);
    for (let m = 1; m <= 10; m++) {
      expect((await w.tick({ db: broken, minute: m })).outcome).toBe("db_failing");
      w.advance();
    }
    expect(w.sent).toEqual([]);
    expect((await w.tick({ db: broken, minute: 0 })).outcome).toBe("db_failing");
    expect(w.sent.map((m) => m.subject)).toEqual(["[CASCADE CRITICAL] The monitor can't write its database"]);
    expect(w.sent[0].text).toContain("D1_ERROR: the database is over its limit");
    expect(await rows("SELECT alert_key FROM alerts")).toEqual([]);
    // the failures are counted, and the lease let go, when the database takes that much
    expect((await rows<{ v: string }>("SELECT v FROM meta WHERE k = 'ticks_failed'"))[0].v).toBe("11");
  });

  it("treats a database that can't be read after the lease (the load, the prefetch) as failing: the db_failing email at minute 0 only", async () => {
    const { w } = forged();
    for (const first of ["SELECT chain, from_block", "SELECT * FROM logs WHERE chain = 'bittensor' AND block >= ?1"]) {
      w.sent.length = 0;
      const broken = failingBatches(db, (sql) => sql.startsWith(first));
      expect((await w.tick({ db: broken, minute: 7 })).outcome).toBe("db_failing");
      expect(w.sent).toEqual([]);
      w.advance();
      expect((await w.tick({ db: broken, minute: 0 })).outcome).toBe("db_failing");
      expect(w.sent.map((m) => m.subject)).toEqual(["[CASCADE CRITICAL] The monitor can't write its database"]);
      // the lease is let go: the next tick tries again at once
      expect(await rows("SELECT until FROM lease")).toEqual([{ until: 0 }]);
      w.advance();
    }
  });

  it("stops quietly when another tick took the lease over mid-tick: commit 1 fails whole, and no email, even at minute 0", async () => {
    const { w } = forged();
    let taken = false;
    w.beforeFetch(async () => {
      if (taken) return;
      taken = true;
      await db.prepare("UPDATE lease SET holder = 'the other tick', until = ?1").bind(w.nowS() + 180).run();
    });
    expect((await w.tick({ minute: 0 })).outcome).toBe("lost_lease");
    expect(w.sent).toEqual([]);
    expect(await rows("SELECT uid FROM logs")).toEqual([]);
    expect(await rows("SELECT alert_key FROM alerts")).toEqual([]);
  });

  it("skips a tick while another holds the lease, and counts it", async () => {
    const { w } = forged();
    await db.prepare("INSERT INTO lease (name, holder, until) VALUES ('tick', 'another', ?1)").bind(w.nowS() + 100).run();
    expect((await w.tick()).outcome).toBe("skipped");
    expect(await rows("SELECT v FROM meta WHERE k = 'ticks_skipped'")).toEqual([{ v: "1" }]);
    expect(await rows("SELECT uid FROM logs")).toEqual([]);
  });

  it("keeps an email that failed due, retries it next tick, and still commits", async () => {
    const { w } = forged();
    let fails = 1;
    const email = {
      send: async (m: SentEmail) => {
        if (fails-- > 0) throw Object.assign(new Error("rate limited"), { code: "E_RATE_LIMIT_EXCEEDED" });
        w.sent.push(m);
      },
    } as unknown as SendEmail;
    const r = await w.tick({ email });
    expect(r).toMatchObject({ outcome: "done", sent: 0, failedEmails: 1 });
    expect((await rows<{ notified_at: number | null }>("SELECT notified_at FROM alerts"))[0].notified_at).toBeNull();
    expect(await rows("SELECT v FROM meta WHERE k = 'email_failing_error'")).toEqual([{ v: "E_RATE_LIMIT_EXCEEDED" }]);
    w.advance();
    await w.tick({ email });
    expect(w.sent.map((m) => m.subject)).toEqual([expect.stringMatching(/^\[CASCADE CRITICAL\] Batch 1/)]);
    expect(await rows("SELECT v FROM meta WHERE k = 'email_failing_since'")).toEqual([{ v: "" }]);
  });

  it("refuses to run on a database of another deployment (a log line only)", async () => {
    const { w } = forged();
    await db.prepare("INSERT INTO meta (k, v) VALUES ('deployment', '0xother:0xother')").run();
    expect((await w.tick()).outcome).toBe("refused");
    expect(await rows("SELECT uid FROM logs")).toEqual([]);
    expect(await rows("SELECT until FROM lease")).toEqual([{ until: 0 }]);
  });
});

describe("the lag sees a stuck scan", () => {
  it("a logs RPC down for 35 minutes while readings work: the lag grows a minute a minute, indexer.lag then indexer.blind, and both clear after", async () => {
    const w = tickWorld();
    await w.tick();
    w.fail((url) => (url.includes("base-logs.rpc.test") ? new Response("down", { status: 503 }) : undefined));
    const lags: number[] = [];
    const keysAt: Record<number, string[]> = {};
    for (let m = 1; m <= 35; m++) {
      w.advance();
      expect((await w.tick()).outcome).toBe("done");
      lags.push((await w.status()).indexer.base?.lagS ?? -1);
      keysAt[m] = await alertKeys();
    }
    // head_time moves with the readings even though no Base log can be read
    for (let i = 1; i < lags.length; i++) expect(lags[i] - lags[i - 1]).toBe(60);
    expect(keysAt[14]).toEqual([]);
    expect(keysAt[15]).toEqual(["indexer.lag:base"]);
    expect(keysAt[29]).toEqual(["indexer.lag:base"]);
    expect(keysAt[30]).toEqual(["indexer.blind:base"]);
    // the logs RPC is back: the scan catches up in a tick and both clear
    w.fail(undefined);
    w.advance();
    await w.tick();
    expect((await w.status()).indexer.base?.lagS).toBeLessThan(120);
    expect(await alertKeys()).toEqual([]);
  });

  it("with every RPC failing, head_time follows the Worker's clock, so the lag still grows", async () => {
    const w = tickWorld();
    await w.tick();
    w.fail(() => new Error("network down"));
    for (let m = 1; m <= 3; m++) {
      w.advance();
      expect((await w.tick()).outcome).toBe("done");
      const c = await rows<{ chain: string; head_time: number }>("SELECT chain, head_time FROM cursors");
      expect(c.map((x) => x.head_time)).toEqual([w.nowS(), w.nowS()]);
    }
    expect((await w.status()).indexer.bittensor?.lagS).toBe(w.nowS() - (T0 - 120));
  });

  it("raises monitor.chain_unreadable after 5 ticks without a reading of a chain; the other chain is still scanned", async () => {
    const w = tickWorld();
    await w.tick();
    const calls = w.specs.bittensor.calls ?? {};
    const real = calls.eth_call;
    calls.eth_call = () => {
      throw new Error("the node is down");
    };
    for (let m = 1; m <= 5; m++) {
      w.advance();
      await w.tick();
      expect(await alertKeys()).toEqual(m < 5 ? [] : ["monitor.chain_unreadable:bittensor"]);
    }
    const base = await rows<{ scanned_to: number }>("SELECT scanned_to FROM cursors WHERE chain = 'base'");
    expect(base[0].scanned_to).toBe(37_000_400 + 5 * 30);
    calls.eth_call = real;
    w.advance();
    await w.tick();
    expect(await alertKeys()).toEqual([]);
  });
});

describe("role wallets' code (keys.delegated)", () => {
  it("raises keys.delegated and its hold when the keeper's wallet takes a 7702 delegation, read with no extra request", async () => {
    const w = tickWorld();
    await w.tick();
    w.advance();
    await w.tick();
    const fetchesBefore = w.net.fetches.length;
    w.advance();
    await w.tick();
    const steady = w.net.fetches.slice(fetchesBefore);
    // the role wallets' code rides in the transaction-count batch of each chain: never a request of its own
    expect(steady.filter((f) => f.methods.includes("eth_getCode")).every((f) => f.methods.includes("eth_getTransactionCount"))).toBe(true);
    expect(steady.some((f) => f.chain === "base" && f.methods.includes("eth_getCode"))).toBe(true);
    expect(steady.some((f) => f.chain === "bittensor" && f.methods.includes("eth_getCode"))).toBe(true);
    expect(await alertKeys()).toEqual([]);
    // the keeper's key is stolen and delegated
    w.specs.base.code = { [KEEPER]: `0xef0100${"ee".repeat(20)}` };
    w.advance();
    await w.tick();
    expect(await alertKeys()).toEqual([]);
    w.advance();
    await w.tick();
    const keys = await alertKeys();
    expect(keys).toHaveLength(1);
    // keyed by the occurrence: the code before and after, and the confirming block
    expect(keys[0]).toMatch(new RegExp(`^keys\\.delegated:base:${KEEPER}:0x[0-9a-f]{8}:0x[0-9a-f]{8}:\\d+$`));
    expect((await w.status()).hold.active).toBe(true);
  });

  it("raises a fresh hold and a fresh email when the same delegation comes back after it was cleared", async () => {
    const w = tickWorld({ over: { ALERT_MODE: "send", ALERT_TO: "owner@example.com" } });
    const step = async (code: Hex | undefined) => {
      w.specs.base.code = code === undefined ? {} : { [KEEPER]: code };
      for (let i = 0; i < 2; i++) {
        await w.tick();
        w.advance();
      }
    };
    const criticals = () => w.sent.filter((m) => m.subject.startsWith("[CASCADE CRITICAL]") && m.subject.includes("role wallet"));
    const evil = `0xef0100${"ee".repeat(20)}` as Hex;
    await step(undefined);
    await step(evil);
    expect(criticals()).toHaveLength(1);
    // the owner checked: the hold cleared, the alert acknowledged
    await db.prepare("UPDATE holds SET cleared_at = ?1, cleared_note = 'checked'").bind(w.nowS()).run();
    await db.prepare("UPDATE alerts SET acknowledged_at = ?1").bind(w.nowS()).run();
    await step("0x");
    // and the same delegation again: a new occurrence, a new hold, a new email
    await step(evil);
    expect(criticals()).toHaveLength(2);
    const holds = await rows<{ cleared_at: number | null }>("SELECT cleared_at FROM holds WHERE rule = 'keys.delegated' ORDER BY raised_at");
    expect(holds.map((x) => x.cleared_at === null)).toEqual([false, true]);
    expect((await w.status()).hold.active).toBe(true);
  });

  it("watches the treasuries' wallets too (not watched for unexplained transactions), on both chains", async () => {
    const w = tickWorld();
    for (let i = 0; i < 2; i++) {
      await w.tick();
      w.advance();
    }
    w.specs.base.code = { [TREASURY_WALLET]: "0x6000" };
    w.specs.bittensor.code = { [TREASURY_WALLET]: `0xef0100${"ee".repeat(20)}` };
    for (let i = 0; i < 2; i++) {
      await w.tick();
      w.advance();
    }
    // plain contract code at an account is only a warning (a counterfactual Safe); a delegation is critical
    expect((await alertKeys()).map((k) => k.split(":").slice(0, 3).join(":"))).toEqual([`keys.code_changed:base:${TREASURY_WALLET}`, `keys.delegated:bittensor:${TREASURY_WALLET}`]);
    // the treasury isn't a watched key: its own transactions raise nothing
    expect(await rows(`SELECT address FROM nonces WHERE address = '${TREASURY_WALLET}'`)).toEqual([]);
  });
});

describe("what the tick reads from the site check", () => {
  it("turns a site result in meta into a site.integrity alert on the next tick, and never runs the site job", async () => {
    const w = tickWorld();
    const result = { finishedAt: T0, complete: true, files: ["/_next/static/chunks/a.js"], unapproved: [{ kind: "host", value: "evil.example", file: "/_next/static/chunks/a.js" }], missing: [], problems: [], capped: false };
    await db.prepare("INSERT INTO meta (k, v) VALUES ('site_result', ?1)").bind(JSON.stringify(result)).run();
    await w.tick();
    expect(await alertKeys()).toEqual(["site.integrity:host:evil.example"]);
    // no request went to the site
    expect(w.net.fetches.every((f) => f.url.includes(".rpc.test"))).toBe(true);
  });
});

describe("the seed pages", () => {
  it("appends new seed events, and rebuilds the pages when one is found late, below what was paged", async () => {
    const w = tickWorld();
    w.addLogs("bittensor", [stakedLog(w.cfg, 6_900_150n, "a"), stakedLog(w.cfg, 6_900_160n, "b")]);
    await w.tick();
    const staked = async () => (await rows<{ staked: string }>("SELECT staked FROM seed_pages ORDER BY page")).flatMap((p) => JSON.parse(`[${p.staked}]`).map((s: { block: string }) => s.block));
    expect(await staked()).toEqual(["6900150", "6900160"]);
    // a node had hidden this one: the re-read finds it
    w.addLogs("bittensor", [stakedLog(w.cfg, 6_900_120n, "late")]);
    w.advance();
    await w.tick();
    expect(await staked()).toEqual(["6900120", "6900150", "6900160"]);
    // a later one is appended
    w.advance();
    w.addLogs("bittensor", [stakedLog(w.cfg, 6_900_204n, "next")]);
    w.advance();
    await w.tick();
    expect(await staked()).toEqual(["6900120", "6900150", "6900160", "6900204"]);
  });

  it("rebuilds the pages without a log that vanished from a later read, and reports it", async () => {
    const w = tickWorld();
    const gone = stakedLog(w.cfg, 6_900_150n, "reorged");
    w.addLogs("bittensor", [gone, stakedLog(w.cfg, 6_900_160n, "kept")]);
    await w.tick();
    w.specs.bittensor.logs = (w.specs.bittensor.logs ?? []).filter((l) => l !== gone);
    // a node REREAD blocks past it answers without it
    w.advance(70);
    await w.tick();
    const pages = await rows<{ staked: string; count: number }>("SELECT staked, count FROM seed_pages");
    expect(pages.map((p) => p.count)).toEqual([1]);
    expect(pages[0].staked).toContain("6900160");
    expect((await alertKeys()).filter((k) => k.startsWith("indexer.reorg:"))).toHaveLength(1);
  });
});

describe("catchingUpChains", () => {
  const chain = (lagS: number, settled: [number | null, number | null], head: [number | null, number]) => ({ lagS, settled: { before: settled[0], now: settled[1] }, head: { before: head[0], now: head[1] } });
  const fine = chain(100, [1000, 1060], [1100, 1160]);
  // the floor is the lag limit (15 minutes with v3-test's payoutDelay of an hour)
  const of = (bittensor: ReturnType<typeof chain>, caughtUp = false) => catchingUpChains({ caughtUp, floorS: 900, chains: { base: fine, bittensor } });

  it("is a chain over its lag limit whose lag shrank by a minute or more this tick", () => {
    expect(of(chain(7200, [1000, 2000], [8000, 8060]))).toEqual(["bittensor"]);
    // between the lag limit and an hour too: catching up lasts until no lag alert would fire
    expect(of(chain(3000, [1000, 1200], [3800, 3860]))).toEqual(["bittensor"]);
    // a settled time known for the first time is a gain
    expect(of(chain(7200, [null, 1000], [null, 8200]))).toEqual(["bittensor"]);
  });

  it("is not a chain whose settled block is frozen, keeps pace, or is within its lag limit", () => {
    expect(of(chain(7200, [1000, 1000], [8000, 8060]))).toEqual([]);
    expect(of(chain(7200, [1000, 1060], [8000, 8060]))).toEqual([]);
    expect(of(chain(7200, [1000, 1100], [8000, 8060]))).toEqual([]);
    expect(of(chain(900, [1000, 5000], [5800, 5860]))).toEqual([]);
    expect(of(chain(7200, [null, null], [null, 8200]))).toEqual([]);
  });

  it("is never once both chains have first come within their lag limit", () => {
    expect(of(chain(7200, [1000, 2000], [8000, 8060]), true)).toEqual([]);
  });
});

describe("catching up", () => {
  it("a clean first backfill, slower than an hour, never pages: catching up lasts until the lag is under its limit (probe P3)", async () => {
    // Base starts 8,000 s back and gains about 140 s a tick (one 100-block window); v3-test's limits: lag 15 min, blind 30
    const w = tickWorld({ heads: { base: 37_004_000n, bittensor: 6_900_700n }, over: { ALERT_MODE: "send", ALERT_TO: "owner@example.com" } });
    w.beforeFetch((url) => {
      if (url.includes("base-logs.rpc.test")) w.clock.ms += 35_000;
    });
    const lags: number[] = [];
    for (let i = 0; i < 70; i++) {
      await w.tick();
      lags.push((await w.status()).indexer.base?.lagS ?? -1);
      w.advance();
      if (lags.at(-1)! < 600) break;
    }
    // it went through the hour, the blind limit and the lag limit, and ended caught up
    expect(lags[0]).toBeGreaterThan(3600);
    expect(lags.at(-1)).toBeLessThan(600);
    expect(w.sent.map((m) => m.subject)).toEqual([]);
    expect(await rows("SELECT alert_key FROM alerts")).toEqual([]);
    expect(await rows("SELECT v FROM meta WHERE k = 'caught_up'")).toHaveLength(1);
  });

  it("while a chain backfills, more than an hour behind and its lag shrinking: its lag is quiet, and the cross-checks judge what both sides hold", async () => {
    const w = tickWorld({ heads: { base: START_HEADS.base, bittensor: 6_903_000n } });
    const rt = roundTrip(w.cfg, { id: 1n, payout: false, forge: "key", blocks: { delivery: 6_900_500n } });
    w.addLogs("base", rt.base);
    w.addLogs("bittensor", rt.bit);
    // a slow Bittensor node: a window or two a tick
    w.beforeFetch((url) => {
      if (url.includes("bittensor.rpc.test")) w.clock.ms += 15_000;
    });
    const r = await w.tick();
    expect(r.catchingUp).toEqual(["bittensor"]);
    expect(await rows("SELECT v FROM meta WHERE k = 'catching_up'")).toEqual([{ v: "bittensor" }]);
    // Base is stored past the delivery: the forged batch is judged at once, however far Bittensor has to go
    expect(await rows("SELECT status, expected_key FROM batch_checks")).toEqual([{ status: "mismatch", expected_key: rt.key }]);
    expect(await alertKeys()).toEqual([`bridge.batch:1:${rt.deliveredKey}`]);
    for (let i = 0; i < 4; i++) {
      w.advance();
      await w.tick();
    }
    expect(await rows("SELECT v FROM meta WHERE k = 'catching_up'")).toEqual([{ v: "" }]);
    expect(await rows("SELECT v FROM meta WHERE k = 'caught_up'")).toEqual([{ v: expect.stringMatching(/^\d+$/) }]);
    expect(await alertKeys()).toEqual([`bridge.batch:1:${rt.deliveredKey}`]);
  });

  it("during a backfill, a check waiting on the other chain isn't reported stuck, and is decided once that chain is stored past it", async () => {
    // Base starts 8,000 s back and backfills slowly; the delivery on Bittensor is 6,600 s old
    const w = tickWorld({ heads: { base: 37_004_000n, bittensor: 6_900_700n } });
    const rt = roundTrip(w.cfg, { id: 1n, payout: false, blocks: { delivery: 6_900_150n } });
    w.addLogs("base", rt.base);
    w.addLogs("bittensor", rt.bit);
    w.state.bit.payoutBatches[rt.key] = { queuedAt: BigInt(T0 - 600), cursor: 0, count: 1, chunk: 0, remaining: 1n };
    w.beforeFetch((url) => {
      if (url.includes("base-logs.rpc.test")) w.clock.ms += 15_000;
    });
    const trail: { status: string; catchingUp: string[]; keys: string[] }[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await w.tick();
      trail.push({ status: (await rows<{ status: string }>("SELECT status FROM batch_checks"))[0]?.status, catchingUp: r.catchingUp ?? [], keys: await alertKeys() });
      w.advance();
    }
    // it waited while Base was behind the delivery, with no bridge.check_stuck (nor Base's lag) reported
    expect(trail[0]).toEqual({ status: "waiting", catchingUp: ["base"], keys: [] });
    // and was decided while Base was still catching up, as soon as Base was stored past the delivery
    const decided = trail.findIndex((x) => x.status === "ok");
    expect(decided).toBeGreaterThan(0);
    expect(trail[decided].catchingUp).toEqual(["base"]);
    expect(trail.every((x) => x.keys.length === 0)).toBe(true);
  });

  it("raises ccip.unexpected_source for a forged sender stored while catching up", async () => {
    const w = tickWorld({ heads: { base: START_HEADS.base, bittensor: 6_903_000n } });
    const d = w.cfg.deployment;
    const forgedTx = h("forged tx");
    w.addLogs("bittensor", [
      rawLog({ address: d.bitAdapter, abi: BIT_ADAPTER, eventName: "Delivered", args: { messageId: h("forged"), sourceChain: 8453n, sender: "0x00000000000000000000000000000000000000ee", recipient: d.vault, amount: 5n }, block: 6_900_500n, logIndex: 0, txHash: forgedTx }),
    ]);
    w.beforeFetch((url) => {
      if (url.includes("bittensor.rpc.test")) w.clock.ms += 15_000;
    });
    expect((await w.tick()).catchingUp).toEqual(["bittensor"]);
    expect(await alertKeys()).toContain(`ccip.unexpected_source:bittensor:${forgedTx}`);
  });

  it("never again after the first full catch-up: a chain an hour behind keeps indexer.blind up while it recovers", async () => {
    const w = tickWorld({ over: { BASE_LOG_WINDOW: "10", SUBREQUEST_BUDGET: "45" } });
    for (let i = 0; i < 3; i++) {
      await w.tick();
      w.advance();
    }
    expect(await rows("SELECT v FROM meta WHERE k = 'caught_up'")).toHaveLength(1);
    w.fail((url) => (url.includes("base-logs.rpc.test") ? new Error("down") : undefined));
    for (let m = 0; m < 90; m++) {
      await w.tick();
      w.advance();
    }
    expect(await alertKeys()).toEqual(["indexer.blind:base"]);
    // back, but slow (10-block windows): the lag shrinks over several ticks, still above an hour at first
    w.fail(undefined);
    const lags: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await w.tick();
      expect(r.catchingUp).toEqual([]);
      lags.push((await w.status()).indexer.base?.lagS ?? -1);
      expect(await alertKeys()).toEqual(["indexer.blind:base"]);
      w.advance();
    }
    expect(lags[0]).toBeGreaterThan(3600);
    expect(lags[2]).toBeLessThan(lags[0]);
    expect(await rows("SELECT resolved_at FROM alerts WHERE alert_key = 'indexer.blind:base'")).toEqual([{ resolved_at: null }]);
  });

  it("is never a frozen settled block: Bittensor's block times failing while its logs flow keeps indexer.blind up, and the cross-checks on", async () => {
    const w = tickWorld();
    await w.tick();
    // only the block-time batch fails (by number; the scan's own head asks for "latest")
    const realFetch = w.net.fetch;
    w.net.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? init.body : "";
      if (url.startsWith(TEST_URLS.bittensor) && body.includes("eth_getBlockByNumber") && !body.includes("latest")) return new Response("busy", { status: 503 });
      return realFetch(input, init);
    }) as typeof globalThis.fetch;
    const seen: Record<number, { keys: string[]; catchingUp: string[] }> = {};
    for (let m = 1; m <= 75; m++) {
      w.advance();
      const r = await w.tick();
      if (m % 15 === 0) seen[m] = { keys: await alertKeys(), catchingUp: r.catchingUp ?? [] };
    }
    expect(seen[30].keys).toEqual(["indexer.blind:bittensor"]);
    expect(seen[75]).toEqual({ keys: ["indexer.blind:bittensor"], catchingUp: [] });
    expect(await rows("SELECT resolved_at FROM alerts WHERE alert_key LIKE 'indexer.%' AND resolved_at IS NOT NULL")).toEqual([
      // only indexer.lag, resolved quietly when indexer.blind replaced it
      { resolved_at: expect.any(Number) },
    ]);
  });
});

describe("transactions and messages", () => {
  it("retries a transaction it couldn't fetch until it is fetched", async () => {
    const w = tickWorld();
    const rt = roundTrip(w.cfg, { id: 1n, payout: false });
    w.addLogs("base", rt.base);
    w.addLogs("bittensor", rt.bit);
    const calls = w.specs.base.calls ?? {};
    const real = calls.eth_getTransactionByHash;
    calls.eth_getTransactionByHash = () => {
      throw new Error("not now");
    };
    await w.tick();
    expect(await rows("SELECT hash FROM txs WHERE chain = 'base' AND selector IS NOT NULL")).toEqual([]);
    expect(JSON.parse((await rows<{ v: string }>("SELECT v FROM meta WHERE k = 'tx_backlog'"))[0].v)).toEqual([{ chain: "base", hash: rt.closeTx, tries: 0 }]);
    calls.eth_getTransactionByHash = real;
    w.advance();
    await w.tick();
    expect(await rows("SELECT hash FROM txs WHERE chain = 'base' AND selector IS NOT NULL")).toEqual([{ hash: rt.closeTx }]);
    expect(await rows("SELECT v FROM meta WHERE k = 'tx_backlog'")).toEqual([{ v: "" }]);
  });

  it("gives up on a transaction the node never returns after 10 answered tries; tries while the node is down don't count", async () => {
    const w = tickWorld();
    const rt = roundTrip(w.cfg, { id: 1n, payout: false });
    w.addLogs("base", rt.base);
    w.addLogs("bittensor", rt.bit);
    const calls = w.specs.base.calls ?? {};
    const real = calls.eth_getTransactionByHash;
    const backlog = async () => {
      const v = (await rows<{ v: string }>("SELECT v FROM meta WHERE k = 'tx_backlog'"))[0]?.v;
      return v ? (JSON.parse(v) as { hash: string; tries?: number }[]) : [];
    };
    // down: the batch fails, which isn't the node saying it has no such transaction
    calls.eth_getTransactionByHash = () => {
      throw new Error("down");
    };
    for (let i = 0; i < 3; i++) {
      await w.tick();
      w.advance();
    }
    expect(await backlog()).toEqual([{ chain: "base", hash: rt.closeTx, tries: 0 }]);
    // up, but it answers null for this one
    calls.eth_getTransactionByHash = (params, at) => (params[0] === rt.closeTx ? null : real?.(params, at));
    for (let i = 0; i < 9; i++) {
      await w.tick();
      w.advance();
    }
    expect(await backlog()).toEqual([{ chain: "base", hash: rt.closeTx, tries: 9 }]);
    await w.tick();
    expect(await backlog()).toEqual([]);
  });

  it("counts a message as arrived when its destination's Delivered was stored before its Sent", async () => {
    const w = tickWorld();
    // the close lands where Base's next re-read will find it late; the delivery is stored first
    const rt = roundTrip(w.cfg, { id: 1n, payout: false, blocks: { request: 37_000_350n, close: 37_000_360n } });
    w.addLogs("bittensor", rt.bit);
    await w.tick();
    w.addLogs("base", rt.base);
    w.advance();
    await w.tick();
    expect(await rows("SELECT direction, dst_tx FROM messages")).toEqual([{ direction: "base>bittensor", dst_tx: rt.deliveryTx }]);
  });
});

describe("backfill and budgets", () => {
  it("makes progress on a long backfill: stops at the wall time, commits, and the next tick resumes", async () => {
    const w = tickWorld({ heads: { base: START_HEADS.base, bittensor: 6_903_000n } });
    for (let b = 6_900_005n; b < 6_903_000n; b += 50n) w.addLogs("bittensor", [stakedLog(w.cfg, b)]);
    // a slow node: 15 s a request
    w.beforeFetch(() => {
      w.clock.ms += 15_000;
    });
    const scanned: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await w.tick();
      expect(r.outcome).toBe("done");
      scanned.push((await rows<{ scanned_to: number }>("SELECT scanned_to FROM cursors WHERE chain = 'bittensor'"))[0].scanned_to);
      w.advance();
    }
    // forward every tick, until the backlog is read
    for (let i = 1; i < scanned.length; i++) expect(scanned[i]).toBeGreaterThanOrEqual(scanned[i - 1]);
    expect(scanned[0]).toBeLessThan(6_903_000);
    expect(scanned[scanned.length - 1]).toBeGreaterThanOrEqual(6_903_000);
    expect((await rows("SELECT uid FROM logs WHERE event = 'Staked'")).length).toBe(60);
  });

  it("never spends more than its subrequest and decode budgets", async () => {
    const w = tickWorld({ heads: { base: 37_002_000n, bittensor: 6_905_000n }, over: { SUBREQUEST_BUDGET: "45", DECODE_BUDGET: "100" } });
    for (let b = 6_900_001n; b < 6_905_000n; b += 10n) w.addLogs("bittensor", [stakedLog(w.cfg, b)]);
    for (let i = 0; i < 4; i++) {
      const before = w.net.fetches.length;
      const r = await w.tick();
      expect(r.outcome).toBe("done");
      expect(r.subrequests).toBeLessThanOrEqual(45);
      expect(w.net.fetches.length - before).toBeLessThanOrEqual(45);
      expect(r.decoded).toBeLessThanOrEqual(100);
      w.advance();
    }
    // Base gets its own share: it moves while Bittensor backfills
    const base = (await rows<{ scanned_to: number }>("SELECT scanned_to FROM cursors WHERE chain = 'base'"))[0].scanned_to;
    expect(base).toBeGreaterThan(37_000_000);
  });

  it("keeps D1 to 6 queries and under 2,000 rows read on a steady tick", async () => {
    const w = tickWorld();
    const rt = roundTrip(w.cfg, { id: 1n });
    w.addLogs("base", rt.base);
    w.addLogs("bittensor", rt.bit);
    await w.tick();
    w.advance();
    await w.tick();
    w.advance();
    const c = countingDb(db);
    expect((await w.tick({ db: c.db })).outcome).toBe("done");
    expect(c.stats.queries).toBeLessThanOrEqual(6);
    expect(c.stats.rowsRead).toBeLessThan(2000);
  });
});
