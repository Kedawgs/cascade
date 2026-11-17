import { type Query, QueryClient } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import { type Cached, launchData, plainText, renderWithCache } from "@/components/test-render";
import { createFigureStore, type FigureStore } from "../remembered";
import { APY_KEEP_MS, shownFigure, withRemembered } from "../stats";
import { explorer } from "./config";
import {
  APY_ATTEMPT_MS,
  APY_MS,
  APY_RETRY_MS,
  apyQuery,
  cascadeKeys,
  changedByFlow,
  depositMoving,
  flowQuery,
  listPollMs,
  movingOffBase,
  seedSnapshot,
  statsQuery,
  taoPriceQuery,
  useHeroTotal,
  useShownApy,
  useShownStaked,
  useShownTaoPrice,
  useTaoPrice,
  unstakeReads,
  useUnstakeReads,
  useVaultExplorerUrl,
  withdrawalMoving,
} from "./hooks";
import { notConfiguredData } from "./live";
import type { DepositRecord, WithdrawalRecord } from "./records";
import type { CascadeData } from "./types";

describe("seedSnapshot", () => {
  it("puts the snapshot's figures in the cache, dated when they were read: the yield, the total staked, and the TAO price under its own key", () => {
    const client = new QueryClient();
    seedSnapshot(client, { at: 1_700_000_000_000, apyPercent: 5.4, stats: { totalStakedTao: 0 }, taoPriceUsd: 255 });
    expect(client.getQueryData(cascadeKeys.apy())).toBe(5.4);
    expect(client.getQueryState(cascadeKeys.apy())?.dataUpdatedAt).toBe(1_700_000_000_000);
    expect(client.getQueryData(cascadeKeys.stats())).toEqual({ totalStakedTao: 0 });
    expect(client.getQueryState(cascadeKeys.stats())?.dataUpdatedAt).toBe(1_700_000_000_000);
    expect(client.getQueryData(cascadeKeys.taoPrice())).toBe(255);
    expect(client.getQueryState(cascadeKeys.taoPrice())?.dataUpdatedAt).toBe(1_700_000_000_000);
  });

  it("leaves out a figure the snapshot doesn't have, so its query loads as before", () => {
    const client = new QueryClient();
    seedSnapshot(client, { at: 1, stats: { totalStakedTao: 12.5 } });
    expect(client.getQueryState(cascadeKeys.apy())).toBeUndefined();
    expect(client.getQueryState(cascadeKeys.taoPrice())).toBeUndefined();
    seedSnapshot(client, { at: 1 });
    expect(client.getQueryData(cascadeKeys.stats())).toEqual({ totalStakedTao: 12.5 });
  });
});

describe("how often Activity's lists are read again", () => {
  const at = new Date("2026-10-30T12:00:00Z");
  const dep = (over: Partial<DepositRecord>): DepositRecord => ({ id: "d", createdAt: at, sourceChain: "base", status: "in_progress", steps: [], taoWei: 1n, taoAmount: 1, ...over });
  const uns = (over: Partial<WithdrawalRecord>): WithdrawalRecord => ({ id: "w", createdAt: at, status: "in_progress", steps: [], shares: 1n, taoAmount: 1, claimable: 0n, ...over });
  const waiting = dep({ cancellableWei: 1n });
  const crossing = dep({});

  it("every 30 s while each moving deposit still waits in its open batch on Base: nothing changes on Bittensor until it leaves", () => {
    expect(listPollMs([waiting], depositMoving)).toBe(30_000);
    expect(listPollMs([waiting, dep({ status: "staked" })], depositMoving)).toBe(30_000);
    expect(movingOffBase([waiting], depositMoving)).toBe(false);
  });

  it("every 10 s again once one has left Base (or isn't in its batch yet)", () => {
    expect(listPollMs([waiting, crossing], depositMoving)).toBe(10_000);
    expect(listPollMs([dep({ status: "needs_you" })], depositMoving)).toBe(10_000);
    expect(movingOffBase([waiting, crossing], depositMoving)).toBe(true);
  });

  it("every 30 s with nothing moving, or nothing read yet", () => {
    expect(listPollMs([dep({ status: "staked" })], depositMoving)).toBe(30_000);
    expect(listPollMs(undefined, depositMoving)).toBe(30_000);
  });

  it("every 30 s while each moving record waits only on the background check of the indexer's history ('checking'): reading sooner moves it no sooner (review 2)", () => {
    const checkingStep = { key: "bridge" as const, title: "Cross to Bittensor", status: "checking" as const };
    expect(listPollMs([dep({ steps: [checkingStep] })], depositMoving)).toBe(30_000);
    expect(listPollMs([dep({ steps: [checkingStep] }), crossing], depositMoving)).toBe(10_000);
    const returning = { key: "return" as const, title: "Return to Base", status: "checking" as const };
    expect(listPollMs([uns({ steps: [returning] })], withdrawalMoving)).toBe(30_000);
    expect(listPollMs([uns({ status: "ready", steps: [returning] })], withdrawalMoving)).toBe(10_000);
  });

  it("an unstake: 30 s while its request waits in the open batch, 10 s once it has left, or is back on Base to be paid", () => {
    expect(listPollMs([uns({ cancellableShares: 1n })], withdrawalMoving)).toBe(30_000);
    expect(listPollMs([uns({ cancellableShares: 1n }), uns({})], withdrawalMoving)).toBe(10_000);
    expect(listPollMs([uns({ status: "ready" })], withdrawalMoving)).toBe(10_000);
    expect(listPollMs([uns({ status: "paid" })], withdrawalMoving)).toBe(30_000);
  });
});

describe("useTaoPrice: the price that values the user's own money", () => {
  // a minute ago, so the hour a failed read keeps a price for hasn't run out
  const SEEDED = Date.now() - 60_000;
  const priced = (over: Partial<Cached> = {}): Cached => ({ key: cascadeKeys.taoPrice(), data: 255.5, ...over });
  function Probe() {
    const price = useTaoPrice();
    return createElement("b", null, price === undefined ? "none" : String(price));
  }
  const price = (cached: Cached[], seededAt?: number) => plainText(renderWithCache(createElement(Probe), cached, { seededAt }));

  it("has no price while the query still holds the server's snapshot", () => {
    expect(price([priced({ at: SEEDED })], SEEDED)).toBe("none");
  });

  it("has the price once a live read has replaced the snapshot's", () => {
    expect(price([priced({ at: SEEDED + 20_000 })], SEEDED)).toBe("255.5");
  });

  it("counts a live read as live even when this browser's clock is behind the build machine's", () => {
    expect(price([priced({ at: SEEDED - 5 * 60_000 })], SEEDED)).toBe("255.5");
  });

  it("has no price when the live read failed with only the snapshot's to show", () => {
    expect(price([priced({ at: SEEDED, failed: true })], SEEDED)).toBe("none");
  });

  it("has the live price when there was no snapshot", () => {
    expect(price([priced()])).toBe("255.5");
    expect(price([])).toBe("none");
  });

  it("keeps a live price through a failed read for an hour, then drops it", () => {
    expect(price([priced({ at: Date.now() - 30 * 60_000, failed: true })], SEEDED)).toBe("255.5");
    expect(price([priced({ at: Date.now() - 2 * 60 * 60_000, failed: true })], SEEDED)).toBe("none");
  });

  it("is the price's own read: it doesn't wait for the total staked (Bittensor), nor go when that read fails", () => {
    expect(price([priced(), { key: cascadeKeys.stats(), failed: true }])).toBe("255.5");
    expect(price([priced()])).toBe("255.5");
    // and a total staked alone gives no price
    expect(price([{ key: cascadeKeys.stats(), data: { totalStakedTao: 12.5 } }])).toBe("none");
  });
});

/** A data source with only the three public figures' reads, and what it remembers. */
function figureSource(over: Partial<CascadeData> = {}) {
  const remembered: [string, number][] = [];
  const figures: FigureStore = { recall: () => undefined, remember: (key, value) => void remembered.push([key, value]) };
  const data = { figures, getApy: async () => 3.42, getProtocolStats: async () => ({ totalStakedTao: 0.156 }), getTaoPrice: async () => 254.49, ...over } as Partial<CascadeData> as CascadeData;
  return { data, remembered };
}

describe("the TAO price's query (D1): Base alone", () => {
  it("has its own key and its own read: it resolves when the vault's read on Bittensor fails, and when it never answers", async () => {
    expect(cascadeKeys.taoPrice()).not.toEqual(cascadeKeys.stats());
    for (const getProtocolStats of [() => Promise.reject(new Error("Bittensor's node is down")), () => new Promise<never>(() => {})]) {
      const { data } = figureSource({ getProtocolStats });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const stats = client.fetchQuery(statsQuery(data));
      stats.catch(() => undefined);
      expect(await client.fetchQuery(taoPriceQuery(data))).toBe(254.49);
      expect(client.getQueryData(cascadeKeys.taoPrice())).toBe(254.49);
      expect(client.getQueryData(cascadeKeys.stats())).toBeUndefined();
    }
  });

  it("and the total staked resolves when the price's read fails", async () => {
    const { data } = figureSource({ getTaoPrice: () => Promise.reject(new Error("quoter reverted")) });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await expect(client.fetchQuery(taoPriceQuery(data))).rejects.toThrow("quoter reverted");
    expect(await client.fetchQuery(statsQuery(data))).toEqual({ totalStakedTao: 0.156 });
  });

  it("is read every 30 s, as the total staked is", () => {
    const { data } = figureSource();
    expect(taoPriceQuery(data).refetchInterval).toBe(30_000);
    expect(statsQuery(data).refetchInterval).toBe(30_000);
  });
});

describe("the yield's query: able to finish against a slow node, tried again soon after a failure", () => {
  const { data } = figureSource();
  const state = (status: "success" | "error" | "pending") => ({ state: { status } }) as Query<number>;

  it("is read every half hour after a reading, and three minutes after a failed one", () => {
    const q = apyQuery(data);
    expect(APY_MS).toBe(30 * 60_000);
    expect(APY_RETRY_MS).toBe(3 * 60_000);
    expect(q.refetchInterval(state("success"))).toBe(APY_MS);
    expect(q.refetchInterval(state("pending"))).toBe(APY_MS);
    expect(q.refetchInterval(state("error"))).toBe(APY_RETRY_MS);
    expect(q.staleTime).toBe(APY_MS);
    expect(q.refetchOnWindowFocus).toBe(false);
  });

  it("asks once an attempt: its connection retries a request once itself (chain.ts), and the query adds no second try on top", async () => {
    expect(apyQuery(data).retry).toBe(false);
    let asked = 0;
    const failing = figureSource({ getApy: async () => (asked++, Promise.reject(new Error("The request took too long to respond."))) });
    const client = new QueryClient();
    await expect(client.fetchQuery(apyQuery(failing.data))).rejects.toThrow(/too long/);
    expect(asked).toBe(1);
    // a failed read remembers nothing
    expect(failing.remembered).toEqual([]);
  });

  it("gives one attempt three minutes in all: past that it counts as failed, the next comes three minutes later, and a late answer is left unused", async () => {
    expect(APY_ATTEMPT_MS).toBe(3 * 60_000);
    vi.useFakeTimers();
    try {
      let answer!: (apy: number) => void;
      const hung = figureSource({ getApy: () => new Promise<number>((resolve) => (answer = resolve)) });
      const client = new QueryClient();
      let failed: unknown;
      void client.fetchQuery(apyQuery(hung.data)).catch((e: unknown) => (failed = e));
      await vi.advanceTimersByTimeAsync(APY_ATTEMPT_MS - 1);
      expect(failed).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(failed).toMatchObject({ message: "The yield took too long to read" });
      // failed: the query asks again in three minutes, not thirty
      const query = client.getQueryCache().find<number>({ queryKey: cascadeKeys.apy() })!;
      expect(query.state.status).toBe("error");
      expect(apyQuery(hung.data).refetchInterval(query as never)).toBe(APY_RETRY_MS);
      // the node answers after all: neither shown nor remembered
      answer(3.4);
      await vi.advanceTimersByTimeAsync(0);
      expect(client.getQueryData(cascadeKeys.apy())).toBeUndefined();
      expect(hung.remembered).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an answer inside the three minutes is the reading, and leaves no timer running", async () => {
    vi.useFakeTimers();
    try {
      const slow = figureSource({ getApy: () => new Promise<number>((resolve) => setTimeout(resolve, 80_000, 3.4)) });
      const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
      let read: number | undefined;
      void client.fetchQuery(apyQuery(slow.data)).then((v) => (read = v));
      await vi.advanceTimersByTimeAsync(80_000);
      expect(read).toBe(3.4);
      expect(slow.remembered).toEqual([["apy", 3.4]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is its own query: the total staked and the price don't wait for it", async () => {
    const slow = figureSource({ getApy: () => new Promise<never>(() => {}) });
    const client = new QueryClient();
    void client.fetchQuery(apyQuery(slow.data)).catch(() => undefined);
    expect(await client.fetchQuery(statsQuery(slow.data))).toEqual({ totalStakedTao: 0.156 });
    expect(await client.fetchQuery(taoPriceQuery(slow.data))).toBe(254.49);
  });
});

describe("what a flow reads again when it ends (use-flows.ts)", () => {
  const ME = "0x1234567890abcdef1234567890abcdef12345678";

  it("is every figure a flow may have changed, and not the 30-day yield: a stake doesn't move it, and restarting its query leaves a slow archive read in flight for nothing", async () => {
    const client = new QueryClient();
    const keys = [
      cascadeKeys.apy(),
      cascadeKeys.stats(),
      cascadeKeys.taoPrice(),
      cascadeKeys.limits(),
      cascadeKeys.proof(),
      cascadeKeys.nextBatch(),
      cascadeKeys.position(ME),
      cascadeKeys.balances(ME),
      cascadeKeys.available(ME),
      cascadeKeys.deposits(ME),
      cascadeKeys.withdrawals(ME),
      cascadeKeys.pendingRewards(ME),
      cascadeKeys.openBatch(ME),
    ];
    for (const key of keys) client.setQueryData(key, 1);
    await client.invalidateQueries(changedByFlow());
    const again = keys.filter((key) => client.getQueryState(key)?.isInvalidated).map((key) => key.join("/"));
    expect(again).toEqual(keys.slice(1).map((key) => key.join("/")));
    expect(client.getQueryState(cascadeKeys.apy())?.isInvalidated).toBe(false);
  });

  it("is what both of a flow's refreshes use; the quotes and the wiring check are still read again as before", () => {
    const flows = readFileSync(fileURLToPath(new URL("./use-flows.ts", import.meta.url)), "utf8");
    expect(flows.match(/queryClient\.invalidateQueries\(changedByFlow\(\)\)/g)).toHaveLength(2);
    expect(flows).not.toContain("cascadeKeys.all()");
    expect(flows).toMatch(/void queryClient\.invalidateQueries\(changedByFlow\(\)\);\s*void queryClient\.invalidateQueries\(\{ queryKey: \["quote"\] \}\);[\s\S]*?data\.forgetWiring\(\);\s*void queryClient\.invalidateQueries\(\{ queryKey: \["wiring"\] \}\);/);
  });
});

describe("what a visit remembers for the next (remembered.ts)", () => {
  it("is each reading of the three public figures as it arrives, and nothing else", async () => {
    const { data, remembered } = figureSource();
    const client = new QueryClient();
    await client.fetchQuery(apyQuery(data));
    await client.fetchQuery(statsQuery(data));
    await client.fetchQuery(taoPriceQuery(data));
    expect(remembered).toEqual([
      ["apy", 3.42],
      ["staked", 0.156],
      ["price", 254.49],
    ]);
  });

  it("isn't a total the chain didn't give", async () => {
    const { data, remembered } = figureSource({ getProtocolStats: async () => ({}) });
    await new QueryClient().fetchQuery(statsQuery(data));
    expect(remembered).toEqual([]);
  });

  it("a read set aside for a newer one is not remembered, and never shown in the newer one's place: fetch A slow, fetch B answers first, A answers later, the figure is B's", async () => {
    let clock = 1_800_000_000_000;
    const m = new Map<string, string>();
    const figures = createFigureStore({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }, "0xvault", () => clock);
    const answers: ((apy: number) => void)[] = [];
    const data = { figures, getApy: () => new Promise<number>((resolve) => answers.push(resolve)) } as Partial<CascadeData> as CascadeData;
    const client = new QueryClient();
    // this visit's first reading
    const first = client.fetchQuery(apyQuery(data));
    answers[0](3.0);
    expect(await first).toBe(3.0);
    const query = client.getQueryCache().find<number>({ queryKey: cascadeKeys.apy() })!;
    // A: read again, and slow
    const a = query.fetch(apyQuery(data) as never);
    a.catch(() => undefined);
    // B: read again before A answered, as a refresh does; the query now waits for B, and A is set aside
    const b = query.fetch(apyQuery(data) as never, { cancelRefetch: true });
    clock += 1_000;
    answers[2](3.5);
    expect(await b).toBe(3.5);
    // A answers a second after B
    clock += 1_000;
    answers[1](3.4);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.getQueryData(cascadeKeys.apy())).toBe(3.5);
    // remembered for the next visit: B's, dated when B answered, not A's
    expect(figures.recall("apy")).toEqual({ value: 3.5, at: 1_800_000_001_000 });
    expect(m.get("cascade.figure.0xvault.apy")).toBe('{"v":1,"value":3.5,"at":1800000001000}');
    // and what the page shows is what the query holds, whatever is remembered and however it is dated
    const held = { data: query.state.data, isError: false, dataUpdatedAt: query.state.dataUpdatedAt };
    expect(shownFigure(withRemembered(held, figures.recall("apy"), 0), APY_KEEP_MS)).toBe(3.5);
    expect(shownFigure(withRemembered(held, { value: 3.4, at: clock + 60_000 }, 0), APY_KEEP_MS)).toBe(3.5);
  });

  it("the total staked and the price are the same: a read set aside is not remembered", async () => {
    for (const [query, read, key, late, kept] of [
      [statsQuery, "getProtocolStats", cascadeKeys.stats(), { totalStakedTao: 0.15 }, { totalStakedTao: 0.156 }],
      [taoPriceQuery, "getTaoPrice", cascadeKeys.taoPrice(), 250, 254.49],
    ] as const) {
      const answers: ((v: unknown) => void)[] = [];
      const source = figureSource({ [read]: () => new Promise((resolve) => answers.push(resolve)) });
      const client = new QueryClient();
      const first = client.fetchQuery(query(source.data) as never);
      answers[0](kept);
      await first;
      const q = client.getQueryCache().find({ queryKey: key })!;
      q.fetch(query(source.data) as never).catch(() => undefined);
      const b = q.fetch(query(source.data) as never, { cancelRefetch: true });
      answers[2](kept);
      await b;
      answers[1](late);
      await new Promise((resolve) => setTimeout(resolve, 0));
      // twice the kept reading (the first read's, then B's), never the late one's
      expect(source.remembered.map(([, v]) => v)).toEqual([typeof kept === "number" ? kept : kept.totalStakedTao, typeof kept === "number" ? kept : kept.totalStakedTao]);
    }
  });

  describe("never the account's own figures: a balance, a stake, a limit or a quote is read from the chain on every visit", () => {
    const source = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    const hooks = source("./hooks.ts");

    it("only the three public figures' queries remember, and only the four display hooks recall", () => {
      expect([...hooks.matchAll(/figures\.remember\("(\w+)"/g)].map((m) => m[1]).sort()).toEqual(["apy", "price", "staked"]);
      expect(hooks.match(/figures\.remember\(/g)).toHaveLength(3);
      // the store is read in one place, useRecalled, which the display hooks alone call
      expect(hooks.match(/figures\.recall\(/g)).toHaveLength(1);
      expect([...hooks.matchAll(/useRecalled\("(\w+)"\)/g)].map((m) => m[1]).sort()).toEqual(["apy", "price", "price", "staked", "staked"]);
      expect(hooks.match(/\buseRecalled\(/g)).toHaveLength(6);
      const body = (name: string) => {
        const from = hooks.indexOf(`export function ${name}(`);
        expect(from).toBeGreaterThan(-1);
        const next = hooks.indexOf("\nexport ", from + 1);
        return hooks.slice(from, next === -1 ? undefined : next);
      };
      for (const display of ["useShownApy", "useShownStaked", "useShownTaoPrice", "useHeroTotal"]) expect(body(display)).toContain("useRecalled(");
      // the account's own reads, and the price that values its money, never touch the store
      for (const own of ["usePosition", "useBalances", "useLimits", "useAvailable", "usePositionHistory", "usePendingRewards", "useDepositQuote", "useWithdrawalQuote", "useOpenBatch", "useDeliveryLimit", "useExitHold", "useTaoPrice"]) {
        expect(body(own)).not.toMatch(/useRecalled|figures\.|withRemembered|useShown/);
      }
    });

    it("the pages' own-money figures use none of the display hooks", () => {
      const pages = ["../../components/app/StakeCard.tsx", "../../components/app/UnstakeScreen.tsx", "../../components/app/UnstakeForm.tsx", "../../components/app/WhereIsMyMoney.tsx", "../../components/app/ActivityScreen.tsx", "../use-usdc-balance.ts", "./use-flows.ts"];
      for (const page of pages) expect(source(page), page).not.toMatch(/useShown\w+|useHeroTotal|useRecalled|figures\.|lib\/remembered|\.\/remembered/);
      // the stake form: the price strip alone shows the remembered price; the form itself prices a stake by its quote
      const form = source("../../components/app/StakeForm.tsx");
      expect(form.match(/useShownTaoPrice\(/g)).toHaveLength(1);
      expect(form.slice(form.indexOf("function StakeFormBody"))).not.toMatch(/useShown\w+|useRecalled|figures\./);
      // the rewards card: the TAO price tile alone
      const rewards = source("../../components/app/RewardsCard.tsx");
      expect(rewards.match(/useShownTaoPrice\(/g)).toHaveLength(1);
      expect(rewards.slice(rewards.indexOf("function RewardsForAccount"))).not.toMatch(/useShown\w+|useRecalled|figures\./);
    });
  });
});

describe("the figures a page shows, in the first HTML", () => {
  const ME = "0x1234567890abcdef1234567890abcdef12345678";
  const NOW = Date.now();
  /** The launch's data source, its browser storage already holding every figure from a visit ten minutes ago. */
  function remembering() {
    const m = new Map<string, string>();
    const read: string[] = [];
    const storage = { getItem: (k: string) => (read.push(k), m.get(k) ?? null), setItem: (k: string, v: string) => void m.set(k, v) };
    const data = launchData(undefined, {}, { storage });
    const earlier = createFigureStore(storage, data.deployment.vault.toLowerCase(), () => NOW - 10 * 60_000);
    earlier.remember("apy", 9.9);
    earlier.remember("staked", 99.5);
    earlier.remember("price", 999.99);
    return { data, read };
  }
  function Probe() {
    const shown = { apy: useShownApy(), staked: useShownStaked(), price: useShownTaoPrice(), total: useHeroTotal() };
    return createElement("b", null, JSON.stringify(shown));
  }
  const probe = (cached: Cached[], given: { seededAt?: number; data?: CascadeData } = {}) =>
    JSON.parse(plainText(renderWithCache(createElement(Probe), cached, given)).replace(/&quot;/g, '"')) as Record<string, { value?: number; usd?: number; loading: boolean; place?: boolean }>;

  it("are loading, with no value, before anything is known", () => {
    expect(probe([])).toEqual({ apy: { loading: true }, staked: { loading: true }, price: { loading: true }, total: { place: true, loading: true } });
  });

  it("are the snapshot's yield and total, and its price in the total's dollars only: never as the TAO price", () => {
    const seeded = NOW - 60_000;
    const cached: Cached[] = [
      { key: cascadeKeys.apy(), data: 3.4, at: seeded },
      { key: cascadeKeys.stats(), data: { totalStakedTao: 0.156 }, at: seeded },
      { key: cascadeKeys.taoPrice(), data: 255, at: seeded },
    ];
    expect(probe(cached, { seededAt: seeded })).toEqual({
      apy: { value: 3.4, loading: false },
      staked: { value: 0.156, loading: false },
      price: { loading: true },
      total: { place: true, usd: 0.156 * 255, loading: true },
    });
  });

  it("never carry what the browser remembers: the server's markup, and the render that hydrates it, show the snapshot or nothing", () => {
    const { data, read } = remembering();
    expect(probe([], { data })).toEqual({ apy: { loading: true }, staked: { loading: true }, price: { loading: true }, total: { place: true, loading: true } });
    // the store wasn't even read
    expect(read).toEqual([]);
    // (it does hold them: the first render after hydration reads them)
    expect(data.figures.recall("apy")?.value).toBe(9.9);
    expect(data.figures.recall("staked")?.value).toBe(99.5);
    expect(data.figures.recall("price")?.value).toBe(999.99);
  });

  it("say when a read failed and what there was is too old to show: no value, and not loading", () => {
    const DAY = 86_400_000;
    const failed: Cached[] = [
      { key: cascadeKeys.apy(), data: 3.4, at: NOW - 15 * DAY, failed: true },
      { key: cascadeKeys.stats(), data: { totalStakedTao: 10 }, at: NOW - 2 * 60 * 60_000, failed: true },
      { key: cascadeKeys.taoPrice(), data: 255, at: NOW - 2 * 60 * 60_000, failed: true },
    ];
    expect(probe(failed)).toEqual({ apy: { loading: false }, staked: { loading: false }, price: { loading: false }, total: { place: true, loading: false } });
    // within their windows (14 days, an hour) they stay
    const recent: Cached[] = [
      { key: cascadeKeys.apy(), data: 3.4, at: NOW - 13 * DAY, failed: true },
      { key: cascadeKeys.stats(), data: { totalStakedTao: 10 }, at: NOW - 30 * 60_000, failed: true },
      { key: cascadeKeys.taoPrice(), data: 255, at: NOW - 30 * 60_000, failed: true },
    ];
    expect(probe(recent)).toEqual({
      apy: { value: 3.4, loading: false },
      staked: { value: 10, loading: false },
      price: { value: 255, loading: false },
      total: { place: true, usd: 2550, loading: false },
    });
  });

  it("the account's own figures stay empty with a store full of remembered figures: nothing personal is ever taken from it", () => {
    const { data, read } = remembering();
    function Own() {
      const price = useTaoPrice();
      return createElement("b", null, price === undefined ? "no price" : String(price));
    }
    expect(plainText(renderWithCache(createElement(Own), [{ key: cascadeKeys.position(ME), data: undefined }], { data }))).toBe("no price");
    expect(read).toEqual([]);
  });
});

describe("the statistics card's link to the vault on Bittensor", () => {
  function Probe() {
    return createElement("b", null, useVaultExplorerUrl() ?? "none");
  }
  it("is the deployment's own vault address, known at build: it waits on no read", () => {
    const data = launchData();
    const html = renderWithCache(createElement(Probe), [], { data });
    expect(plainText(html)).toBe(explorer.account(data.deployment.vaultSs58));
  });

  it("is absent when the site has no deployment", () => {
    expect(plainText(renderWithCache(createElement(Probe), [], { data: notConfiguredData() }))).toBe("none");
  });
});

describe("the unstake screen's reads, started with the screen", () => {
  const ME = "0x1234567890abcdef1234567890abcdef12345678";
  const LENSES = { vaultLens: "0x000000000000000000000000000000000000Ae15" as Address, doorLens: "0x000000000000000000000000000000000000De15" as Address };
  const source = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

  const STAKED = 10n ** 22n;
  /** What the screen starts for a wallet on v3.2 with USDC delivery on, unless said otherwise. */
  const reads = (over: Partial<Parameters<typeof unstakeReads>[0]> = {}) => unstakeReads({ account: ME, shares: STAKED, checking: false, v32: true, usdcDelivery: true, ...over });

  it("start in two steps: the balances and the wiring check with the wallet, the delivery limit and the unstake hold only once the stake is known and above nothing", () => {
    // the balance still loading: the quick reads only; no history scan, no 30-second polls for a form that may never show
    expect(reads({ shares: undefined })).toEqual({ account: ME, wiring: true, deliveryPreference: false, staked: null, deliveryLimit: false, exitHold: null });
    // the stake known: v3.2's live delivery limit and what holds an unstake, too
    expect(reads()).toEqual({ account: ME, wiring: true, deliveryPreference: false, staked: ME, deliveryLimit: true, exitHold: ME });
    // v3.2, USDC delivery off: the delivery preference (one read on Base, from the start) in the limit's place
    expect(reads({ shares: undefined, usdcDelivery: false })).toEqual({ account: ME, wiring: true, deliveryPreference: true, staked: null, deliveryLimit: false, exitHold: null });
    expect(reads({ usdcDelivery: false })).toEqual({ account: ME, wiring: true, deliveryPreference: true, staked: ME, deliveryLimit: false, exitHold: ME });
    // v3-launch: the balances and the wiring check, whatever the stake
    expect(reads({ v32: false })).toEqual({ account: ME, wiring: true, deliveryPreference: false, staked: ME, deliveryLimit: false, exitHold: null });
    expect(reads({ v32: false, shares: undefined })).toEqual({ account: ME, wiring: true, deliveryPreference: false, staked: null, deliveryLimit: false, exitHold: null });
  });

  it("never start the delivery limit or the unstake hold for a wallet with nothing staked, nor while its history is being checked against the chain: the form doesn't show then", () => {
    // nothing staked: nothing at all for the wallet
    expect(reads({ shares: 0n })).toEqual({ account: null, wiring: false, deliveryPreference: false, staked: null, deliveryLimit: false, exitHold: null });
    expect(reads({ shares: 0n, usdcDelivery: false })).toEqual({ account: null, wiring: false, deliveryPreference: false, staked: null, deliveryLimit: false, exitHold: null });
    // its history being checked: the quick reads stay, the two that scan and poll don't start (or stop)
    expect(reads({ checking: true })).toEqual({ account: ME, wiring: true, deliveryPreference: false, staked: null, deliveryLimit: false, exitHold: null });
    // no wallet: nothing
    expect(reads({ account: null, shares: undefined })).toEqual({ account: null, wiring: false, deliveryPreference: false, staked: null, deliveryLimit: false, exitHold: null });
  });

  it("are the form's own queries, the two later ones under the form's own conditions", () => {
    // as the form writes them: a change there is a change to make here too
    const form = source("../../components/app/UnstakeForm.tsx");
    expect(form).toContain("const balances = useBalances(account);");
    expect(form).toContain("const limit = useDeliveryLimit(account, v32 && usdcDelivery);");
    expect(form).toContain("const taoOnly = v32 && !usdcDelivery;");
    expect(form).toContain("const preference = useDeliveryPreference(account, taoOnly);");
    expect(form).toContain("const exitHold = useExitHold(v32 ? account : null);");
    expect(form).toContain("const flows = useFlows(account);");
    expect(source("./use-flows.ts")).toContain("const wiring = useWiring(account !== null);");
  });

  function Probe({ account }: { account: string | null }) {
    useUnstakeReads(account);
    return null;
  }
  /** The queries a render of the screen's reads sets up for the account. */
  function started(account: string | null, data: CascadeData, seed: (client: QueryClient) => void = () => undefined) {
    const client = new QueryClient();
    seed(client);
    renderWithCache(createElement(Probe, { account }), [], { data, client });
    return client
      .getQueryCache()
      .getAll()
      .map((q) => JSON.stringify(q.queryKey));
  }
  const key = (k: readonly unknown[]) => JSON.stringify(k);
  const positionOf = (shares: bigint) => (client: QueryClient) => client.setQueryData(cascadeKeys.position(ME), { shares, taoWei: shares / 10n ** 6n, taoBalance: 0.01, usdValue: 2.5, taoPriceUsd: 250 });
  const quick = [cascadeKeys.position(ME), cascadeKeys.available(ME), cascadeKeys.balances(ME), ["wiring"]];
  const later = [cascadeKeys.deliveryLimit(ME), cascadeKeys.exitHold(ME)];

  it("the screen sets up the quick ones for the wallet as it renders, beside the balance; the delivery limit and the hold only with a stake known", () => {
    // the balance not known yet: the quick reads, and neither of the later two
    const loading = started(ME, launchData(undefined, LENSES));
    for (const k of quick) expect(loading).toContain(key(k));
    for (const k of later) expect(loading).not.toContain(key(k));
    // a stake known: both of them, too
    const staked = started(ME, launchData(undefined, LENSES), positionOf(STAKED));
    for (const k of [...quick, ...later]) expect(staked).toContain(key(k));
    // its history being checked against the chain: not those two
    const checking = started(ME, launchData(undefined, LENSES), (client) => {
      positionOf(STAKED)(client);
      client.setQueryData(cascadeKeys.available(ME), { availableShares: 0n, availableTaoWei: 0n, checking: true });
    });
    for (const k of later) expect(checking).not.toContain(key(k));
    // v3-launch has no hold to read (and its delivery limit's query, set up for the wallet, is never enabled: above)
    expect(started(ME, launchData(), positionOf(STAKED))).not.toContain(key(cascadeKeys.exitHold(ME)));
    // nothing staked: none of the form's reads for the wallet
    const empty = started(ME, launchData(undefined, LENSES), positionOf(0n));
    for (const k of [cascadeKeys.balances(ME), ...later]) expect(empty).not.toContain(key(k));
    // no wallet: nothing for any account
    expect(started(null, launchData(undefined, LENSES)).filter((k) => k.includes(ME))).toEqual([]);
  });

  it("the unstake screen itself starts them, with the account it shows", () => {
    const screen = source("../../components/app/UnstakeScreen.tsx");
    expect(screen).toMatch(/const account = state\.status === "wallet" \? state\.account : null;[\s\S]*useUnstakeReads\(account\);[\s\S]*return \(/);
  });
});

describe("useFlow's query", () => {
  // a document read this long ago, held in the cache as a page that lost focus would hold it
  const isStaleAfter = (ageMs: number) => {
    const client = new QueryClient();
    client.setQueryData(cascadeKeys.flow(), null, { updatedAt: Date.now() - ageMs });
    return client.getQueryCache().find({ queryKey: cascadeKeys.flow() })!.isStaleByTime(flowQuery().staleTime);
  };

  it("reads the monitor at most once a minute: a tab focused again within the minute asks for nothing", () => {
    expect(flowQuery().refetchInterval).toBe(60_000);
    expect(flowQuery().refetchIntervalInBackground).toBe(false);
    // focus and mount read again only a stale query
    expect(isStaleAfter(30_000)).toBe(false);
    expect(isStaleAfter(61_000)).toBe(true);
  });
});
