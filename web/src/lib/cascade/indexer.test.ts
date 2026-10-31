import { describe, expect, it } from "vitest";
import type { Deployment } from "./config";
import account from "./__fixtures__/seed-account-v1.json";
import shared from "./__fixtures__/seed-shared-v1.json";
import { DISTRUST_MS, distrustIndexer, fetchSeed, indexerDistrusted } from "./indexer";

/** The fake deployment the indexer's fixtures are for (indexer/test/fixtures/deployment.json). */
const D: Deployment = {
  frontDoor: "0x8A825738D0287D0959957A0f6ec18bA1276d209d",
  baseAdapter: "0x019c592aFe36E17f71866FeF0BC09508b3714450",
  vault: "0x44CeaCE0b097D9d5eF01e08b12029Ad2762cbDC6",
  bitAdapter: "0x51D233584210133De458DC45c0BcA0698D31396d",
  bitBlock: 6_900_000n,
  vaultSs58: "x",
  hotkeySs58: "y",
  indexerUrl: "https://api.cascadefi.xyz",
};
const ME = "0x00000000000000000000000000000000000A11CE" as const;
const SHARED_URL = "https://api.cascadefi.xyz/v1/scan/0x44ceace0b097d9d5ef01e08b12029ad2762cbdc6";
const OWN_URL = `${SHARED_URL}/0x00000000000000000000000000000000000a11ce`;

type Answer = { status: number; body: string } | Error | "hang";

/** A fetch answering each URL as `answers` says, recording what was asked. */
function fakeFetch(answers: Record<string, Answer>) {
  const asked: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, init });
    const a = answers[url];
    if (a === undefined) return new Response("not found", { status: 404 });
    if (a instanceof Error) throw a;
    if (a === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return new Response(a.body, { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

const ok = (x: unknown): Answer => ({ status: 200, body: JSON.stringify(x) });

describe("fetchSeed", () => {
  it("asks the indexer for both halves at once, the vault and account in lowercase with no query string, and returns them as sent", async () => {
    const f = fakeFetch({ [SHARED_URL]: ok(shared), [OWN_URL]: ok(account) });
    const seed = await fetchSeed(D, ME, { fetch: f.fetch });
    expect(seed).toEqual({ shared, own: account });
    expect(f.asked.map((a) => a.url)).toEqual([SHARED_URL, OWN_URL]);
    // a plain cross-origin GET: no cookies, nothing that needs a preflight
    for (const { init } of f.asked) {
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.credentials).toBe("omit");
      expect(init?.mode).toBe("cors");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("asks nothing, and is null, without an indexer URL", async () => {
    const f = fakeFetch({ [SHARED_URL]: ok(shared), [OWN_URL]: ok(account) });
    const { indexerUrl: _, ...none } = D;
    expect(await fetchSeed(none, ME, { fetch: f.fetch })).toBeNull();
    expect(f.asked).toEqual([]);
  });

  it("is null, never throwing, when either half fails: a refusal, a rate limit, a 404, a 503, junk, a network error", async () => {
    const failures: Record<string, Answer> = {
      "429 (rate limited)": { status: 429, body: "too many requests" },
      "404": { status: 404, body: "not found" },
      "503": { status: 503, body: "not available yet" },
      "400": { status: 400, body: "no query string" },
      "a 200 that isn't JSON": { status: 200, body: "<html>" },
      "a network error": new TypeError("Failed to fetch"),
    };
    for (const [name, failure] of Object.entries(failures)) {
      expect(await fetchSeed(D, ME, { fetch: fakeFetch({ [SHARED_URL]: failure, [OWN_URL]: ok(account) }).fetch }), `shared half: ${name}`).toBeNull();
      expect(await fetchSeed(D, ME, { fetch: fakeFetch({ [SHARED_URL]: ok(shared), [OWN_URL]: failure }).fetch }), `account half: ${name}`).toBeNull();
    }
    // a fetch that throws synchronously is a failure too
    const broken = (() => {
      throw new Error("no fetch here");
    }) as unknown as typeof globalThis.fetch;
    expect(await fetchSeed(D, ME, { fetch: broken })).toBeNull();
  });

  it("gives up after the timeout, aborting the request, rather than holding the scan", async () => {
    const f = fakeFetch({ [SHARED_URL]: "hang", [OWN_URL]: ok(account) });
    const started = Date.now();
    expect(await fetchSeed(D, ME, { fetch: f.fetch, timeoutMs: 20 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(f.asked[0].init?.signal?.aborted).toBe(true);
  });

  it("answers with whatever JSON the indexer sent: judging it is the scan store's job", async () => {
    const f = fakeFetch({ [SHARED_URL]: ok({ v: 2, anything: true }), [OWN_URL]: ok(null) });
    expect(await fetchSeed(D, ME, { fetch: f.fetch })).toEqual({ shared: { v: 2, anything: true }, own: null });
  });
});

describe("distrusting the indexer", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  const T0 = 1_800_000_000_000;

  it("lasts 24 hours from when it was decided, in this browser", () => {
    const s = memory();
    expect(indexerDistrusted(s, D, T0)).toBe(false);
    distrustIndexer(s, D, T0);
    expect(indexerDistrusted(s, D, T0)).toBe(true);
    expect(indexerDistrusted(s, D, T0 + DISTRUST_MS - 1)).toBe(true);
    expect(indexerDistrusted(s, D, T0 + DISTRUST_MS)).toBe(false);
    expect(DISTRUST_MS).toBe(24 * 60 * 60_000);
  });

  it("is per deployment: the same front door redeployed from another block is trusted on its own", () => {
    const s = memory();
    distrustIndexer(s, D, T0);
    expect(indexerDistrusted(s, { ...D, bitBlock: 7_000_000n }, T0)).toBe(false);
    expect(indexerDistrusted(s, { ...D, frontDoor: "0x0000000000000000000000000000000000000001" }, T0)).toBe(false);
    expect([...s.m.keys()]).toEqual([`cascade.indexer.distrust.${D.frontDoor.toLowerCase()}.6900000`]);
  });

  it("takes a stored value that isn't a time, or one further ahead than a distrust can reach (a clock put back), for no distrust", () => {
    const s = memory();
    s.setItem(`cascade.indexer.distrust.${D.frontDoor.toLowerCase()}.6900000`, "soon");
    expect(indexerDistrusted(s, D, T0)).toBe(false);
    s.setItem(`cascade.indexer.distrust.${D.frontDoor.toLowerCase()}.6900000`, String(T0 + 10 * DISTRUST_MS));
    expect(indexerDistrusted(s, D, T0)).toBe(false);
  });

  it("never throws on storage that is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => distrustIndexer(blocked, D, T0)).not.toThrow();
    expect(indexerDistrusted(blocked, D, T0)).toBe(false);
  });
});
