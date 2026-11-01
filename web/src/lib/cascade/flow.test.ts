import { describe, expect, it } from "vitest";
import type { Deployment } from "./config";
import { fetchFlow } from "./flow";
import { goodFlow } from "./__fixtures__/flow-v1";

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
const URL_ = "https://api.cascadefi.xyz/v1/flow";
const json = (body: unknown, status = 200) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("fetchFlow", () => {
  it("nullWithoutIndexer", async () => {
    const none: Deployment = { ...D };
    delete none.indexerUrl;
    let asked = 0;
    const f = (async () => { asked++; return new Response("{}"); }) as typeof fetch;
    expect(await fetchFlow(none, { fetch: f })).toBeNull();
    expect(asked).toBe(0);
  });

  it("nullOnTimeout", async () => {
    const f = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch;
    expect(await fetchFlow(D, { fetch: f, timeoutMs: 10 })).toBeNull();
  });

  it("nullOn5xx and other failures, never throwing", async () => {
    expect(await fetchFlow(D, { fetch: json("down", 503) as typeof fetch })).toBeNull();
    expect(await fetchFlow(D, { fetch: json("nope", 404) as typeof fetch })).toBeNull();
    expect(await fetchFlow(D, { fetch: json("<html>") as typeof fetch })).toBeNull();
    expect(await fetchFlow(D, { fetch: (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch })).toBeNull();
  });

  it("nullOnOversizedBody", async () => {
    const big = JSON.stringify({ ...goodFlow(), pad: "x".repeat(300_000) });
    expect(await fetchFlow(D, { fetch: json(big) as typeof fetch })).toBeNull();
    expect(await fetchFlow(D, { fetch: json(JSON.stringify(goodFlow())) as typeof fetch, maxBytes: 100 })).toBeNull();
  });

  it("nullOnWrongVersion", async () => {
    expect(await fetchFlow(D, { fetch: json({ ...goodFlow(), v: 2 }) as typeof fetch })).toBeNull();
  });

  it("nullOnMissingKey", async () => {
    for (const key of Object.keys(goodFlow())) {
      if (key === "v") continue;
      const doc: Record<string, unknown> = { ...goodFlow() };
      delete doc[key];
      expect(await fetchFlow(D, { fetch: json(doc) as typeof fetch }), key).toBeNull();
    }
    expect(await fetchFlow(D, { fetch: json({ ...goodFlow(), chains: { base: null } }) as typeof fetch })).toBeNull();
    expect(await fetchFlow(D, { fetch: json({ ...goodFlow(), notices: {} }) as typeof fetch })).toBeNull();
  });

  it("parsesAGoodDocument, asking the endpoint as a plain cross-origin read", async () => {
    const asked: { url: string; init?: RequestInit }[] = [];
    const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
      asked.push({ url: String(u), init });
      return new Response(JSON.stringify(goodFlow()), { status: 200 });
    }) as typeof fetch;
    const got = await fetchFlow(D, { fetch: f });
    expect(got?.flow).toEqual(goodFlow());
    expect(typeof got?.receivedAt).toBe("number");
    expect(asked).toHaveLength(1);
    expect(asked[0].url).toBe(URL_);
    expect(asked[0].init?.mode).toBe("cors");
    expect(asked[0].init?.credentials).toBe("omit");
  });
});
