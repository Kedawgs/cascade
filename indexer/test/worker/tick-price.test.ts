import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handlePrice } from "../../src/api.ts";
import { PRICE_URLS } from "../../src/prices.ts";
import deploymentV32 from "../fixtures/deployment-v3.2.json";
import { wipe } from "./d1-count.ts";
import { type TickWorld, tickWorld } from "./tick-world.ts";

// The tick stores each reading of the outside reference price (every fifth minute) with when it asked the sources,
// for /v1/price and the site's outside-price check.

const db = env.DB;
beforeEach(async () => {
  await wipe(db);
});

const SOURCES = { PRICE_SOURCES: '["coingecko","coinbase"]' };
const isPrice = (url: string) => url === PRICE_URLS.coingecko || url === PRICE_URLS.coinbase;

/** The two sources' answers: a price, or an Error (the request fails). */
function answer(w: TickWorld, cg: number | Error, cb: number | Error) {
  w.fail((url) => {
    if (url === PRICE_URLS.coingecko) return cg instanceof Error ? cg : Response.json({ bittensor: { usd: cg } });
    if (url === PRICE_URLS.coinbase) return cb instanceof Error ? cb : Response.json({ data: { amount: String(cb), base: "TAO", currency: "USD" } });
    return undefined;
  });
}

/** The clock moves 5 s at the tick's first request, so the price is asked later than the tick began; the time
 * it was asked is recorded. */
function timed(w: TickWorld) {
  const t = { askedAt: undefined as number | undefined };
  let moved = false;
  w.beforeFetch((url) => {
    if (isPrice(url)) t.askedAt ??= w.nowS();
    else if (!moved) {
      moved = true;
      w.clock.ms += 5000;
    }
  });
  return t;
}

const stored = async () => {
  const v = await db.prepare("SELECT v FROM meta WHERE k = 'reference'").first<string>("v");
  return v === null ? undefined : (JSON.parse(v) as Record<string, unknown>);
};

describe("the tick stores the outside reference price", () => {
  it("stores each reading on a fifth minute: the median, how many sources agreed, and when they were asked", async () => {
    const w = tickWorld({ over: SOURCES });
    answer(w, 400, 404);
    const t = timed(w);
    const startS = w.nowS();
    const r = await w.tick({ minute: 5 });
    expect(r.outcome).toBe("done");
    expect(t.askedAt).toBeGreaterThan(startS);
    expect(await stored()).toEqual({ usd: 402, sources: 2, at: t.askedAt });
    // and the tick's log line carries it (an operator's history of the readings)
    expect(r.reference).toEqual({ usd: 402, sources: 2, at: t.askedAt });
  });

  it("stores one source's price with sources 1 when the other fails", async () => {
    const w = tickWorld({ over: SOURCES });
    answer(w, new Error("down"), 404);
    await w.tick({ minute: 5 });
    expect(await stored()).toEqual({ usd: 404, sources: 1, at: w.nowS() });
  });

  it("stores unavailable, with a reason that carries no price, when the sources disagree by more than 2%", async () => {
    const w = tickWorld({ over: SOURCES });
    answer(w, 400, 412);
    const r = await w.tick({ minute: 5 });
    expect(await stored()).toEqual({ unavailable: "the price sources disagree by more than 2%", at: w.nowS() });
    expect(r.reference).toEqual({ unavailable: "the price sources disagree by more than 2%", at: w.nowS() });
    // the sources' prices are in the tick's log line only, never stored or served (a client could parse one)
    expect(r.referenceAnswers).toEqual([400, 412]);
    expect(JSON.stringify(await stored())).not.toMatch(/400|412/);
  });

  it("stores unavailable when no source answers, never the last price relabelled", async () => {
    const w = tickWorld({ over: SOURCES });
    answer(w, 400, 404);
    await w.tick({ minute: 5 });
    const first = await stored();
    expect(first).toEqual({ usd: 402, sources: 2, at: w.nowS() });
    w.advance(5);
    // one request fails, the other answers 503
    w.fail((url) => (url === PRICE_URLS.coingecko ? new Error("down") : url === PRICE_URLS.coinbase ? new Response("busy", { status: 503 }) : undefined));
    const r = await w.tick({ minute: 10 });
    expect(await stored()).toEqual({ unavailable: "no price source answered", at: w.nowS() });
    expect(r.reference).toEqual({ unavailable: "no price source answered", at: w.nowS() });
    expect(w.nowS()).toBeGreaterThan(first?.at as number);
  });

  it("leaves the stored reading and its time alone on a minute that doesn't read the sources", async () => {
    const w = tickWorld({ over: SOURCES });
    answer(w, 400, 404);
    await w.tick({ minute: 5 });
    const first = await stored();
    w.advance();
    const asked: string[] = [];
    w.beforeFetch((url) => void (isPrice(url) && asked.push(url)));
    const r = await w.tick({ minute: 6 });
    expect(r.outcome).toBe("done");
    expect(asked).toEqual([]);
    expect(r.reference).toBeUndefined();
    expect(await stored()).toEqual(first);
  });

  it("stores nothing with no price source configured (the route then says so)", async () => {
    const w = tickWorld();
    expect(w.cfg.priceSources).toEqual([]);
    await w.tick({ minute: 5 });
    expect(await stored()).toBeUndefined();
  });

  it("stores the same for a v3.2 deployment (it reads no contract)", async () => {
    const w = tickWorld({ over: { ...SOURCES, DEPLOYMENT: JSON.stringify(deploymentV32) } });
    expect(w.cfg.deployment.version).toBe("v3.2");
    answer(w, 400, 404);
    expect((await w.tick({ minute: 5 })).outcome).toBe("done");
    expect(await stored()).toEqual({ usd: 402, sources: 2, at: w.nowS() });
  });

  it("is what /v1/price serves", async () => {
    const w = tickWorld({ over: SOURCES });
    answer(w, 400, 404);
    await w.tick({ minute: 5 });
    const res = await handlePrice(new Request("https://api.test/v1/price"), { DB: db }, w.cfg);
    expect(await res.json()).toEqual({ v: 1, usd: 402, sources: 2, at: w.nowS() });
  });
});
