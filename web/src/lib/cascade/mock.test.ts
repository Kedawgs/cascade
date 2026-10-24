import { beforeEach, describe, expect, it } from "vitest";
import { createMockCascadeData, DEMO_STEP_MS, memoryStore, type KeyValueStore } from "./mock";

const ACCOUNT = "0xAbC0000000000000000000000000000000000001";

function setup(store: KeyValueStore | null = memoryStore()) {
  let t = new Date(2026, 9, 20, 12, 0).getTime();
  const data = createMockCascadeData({ now: () => t, store });
  return {
    data,
    store,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("mock seed", () => {
  it("matches the approved mockup numbers", async () => {
    const { data } = setup();
    const position = await data.getPosition(ACCOUNT);
    expect(position).toEqual({
      taoBalance: 3.66,
      usdValue: 1046.76,
      rewardsEarnedTao: 0.0213,
      taoPriceUsd: 286,
      pendingTao: 0,
      avgEntryPriceUsd: 274,
    });
  });

  it("has one finished $1,000 deposit from Base on Oct 1", async () => {
    const { data } = setup();
    const [deposit, ...rest] = await data.listDeposits(ACCOUNT);
    expect(rest).toHaveLength(0);
    expect(deposit).toMatchObject({
      amountUsd: 1000,
      sourceChain: "base",
      status: "staked",
      taoAmount: 3.6387,
      feesUsd: 3,
      taoPriceUsd: 274,
    });
    expect(deposit.createdAt.getMonth()).toBe(9);
    expect(deposit.createdAt.getDate()).toBe(1);
    expect(deposit.steps.map((s) => [s.status, s.title, s.detail])).toEqual([
      ["done", "Received 1,000 USDC on Base", undefined],
      ["done", "Swapped for 3.6387 TAO", "At $274.00, fees $3.00"],
      ["done", "Moved to Bittensor", "Took 4 minutes"],
      ["done", "Staked and earning", "19 reward payouts so far, +0.0213 TAO"],
    ]);
    expect(await data.getDeposit(ACCOUNT, deposit.id)).toEqual(deposit);
  });

  it("reports everything owed as staked", async () => {
    const { data } = setup();
    const proof = await data.getProof(ACCOUNT);
    expect(proof.allStaked).toBe(true);
    expect(proof.stakedTao).toBe(3.66);
    expect(proof.owedTao).toBe(3.66);
  });
});

describe("deposit quotes", () => {
  it("charges 0.3% on Base and turns the rest into TAO at the current price", async () => {
    const { data } = setup();
    expect(await data.quoteDeposit(1000, "base")).toEqual({
      amountUsd: 1000,
      chain: "base",
      feesUsd: 3,
      estTao: 3.486, // 997 / 286
      etaMinutes: 10,
      taoPriceUsd: 286,
    });
  });

  it("adds the cost and time of moving USDC to Base for other chains", async () => {
    const { data } = setup();
    const q = await data.quoteDeposit(500, "ethereum");
    expect(q.feesUsd).toBe(4); // 1.50 swap + 2.50 route
    expect(q.estTao).toBe(1.7343); // 496 / 286
    expect(q.etaMinutes).toBe(15);
  });

  it("returns an empty quote for zero or nonsense input", async () => {
    const { data } = setup();
    expect(await data.quoteDeposit(0, "base")).toMatchObject({ feesUsd: 0, estTao: 0 });
    expect(await data.quoteDeposit(Number.NaN, "polygon")).toMatchObject({ feesUsd: 0, estTao: 0 });
  });
});

describe("deposit progress", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  const statuses = async (id: string) =>
    (await ctx.data.getDeposit(ACCOUNT, id))!.steps.map((s) => s.status);

  it("moves forward one step at a time until staked", async () => {
    const started = await ctx.data.startDeposit(ACCOUNT, 500, "base");
    expect(started.status).toBe("in_progress");
    expect(await statuses(started.id)).toEqual(["active", "pending", "pending", "pending"]);

    ctx.advance(DEMO_STEP_MS);
    expect(await statuses(started.id)).toEqual(["done", "active", "pending", "pending"]);

    ctx.advance(DEMO_STEP_MS);
    expect(await statuses(started.id)).toEqual(["done", "done", "active", "pending"]);

    ctx.advance(DEMO_STEP_MS);
    expect(await statuses(started.id)).toEqual(["done", "done", "done", "active"]);

    ctx.advance(DEMO_STEP_MS);
    const finished = await ctx.data.getDeposit(ACCOUNT, started.id);
    expect(finished?.status).toBe("staked");
    expect(finished?.steps.at(-1)?.title).toBe("Staked and earning");
  });

  it("counts TAO as pending until it is staked, then adds it to the balance", async () => {
    const started = await ctx.data.startDeposit(ACCOUNT, 500, "base");
    expect(started.taoAmount).toBe(1.743); // (500 - 1.50) / 286
    let position = await ctx.data.getPosition(ACCOUNT);
    expect(position.pendingTao).toBe(1.743);
    expect(position.taoBalance).toBe(3.66);

    ctx.advance(DEMO_STEP_MS * 4);
    position = await ctx.data.getPosition(ACCOUNT);
    expect(position.pendingTao).toBe(0);
    expect(position.taoBalance).toBe(5.403);
    expect(position.usdValue).toBe(1545.26);
  });

  it("lists the newest deposit first", async () => {
    const started = await ctx.data.startDeposit(ACCOUNT, 250, "polygon");
    const list = await ctx.data.listDeposits(ACCOUNT);
    expect(list.map((d) => d.id)).toEqual([started.id, "oct-1-base"]);
  });

  it("rejects amounts outside the limits", async () => {
    await expect(ctx.data.startDeposit(ACCOUNT, 5, "base")).rejects.toThrow("smallest stake");
    await expect(ctx.data.startDeposit(ACCOUNT, 60_000, "base")).rejects.toThrow("most you can");
  });
});

describe("withdrawals", () => {
  it("takes TAO out of the balance and finishes as paid", async () => {
    const { data, advance } = setup();
    const w = await data.startWithdrawal(ACCOUNT, 1);
    expect(w).toMatchObject({ taoAmount: 1, usdcAmount: 285.14, feesUsd: 0.86, status: "in_progress" });
    expect((await data.getPosition(ACCOUNT)).taoBalance).toBe(2.66);

    advance(DEMO_STEP_MS * 4);
    const done = await data.getWithdrawal(ACCOUNT, w.id);
    expect(done?.status).toBe("paid");
    expect(done?.steps.at(-1)?.title).toBe("Paid 285.14 USDC to your wallet on Base");
  });

  it("won't withdraw more than the balance", async () => {
    const { data } = setup();
    await expect(data.startWithdrawal(ACCOUNT, 3.6601)).rejects.toThrow("up to 3.6600 TAO");
    await expect(data.startWithdrawal(ACCOUNT, 3.66)).resolves.toBeTruthy();
    expect((await data.getPosition(ACCOUNT)).taoBalance).toBe(0);
  });
});

describe("persistence", () => {
  it("keeps deposits across adapter instances and separates accounts", async () => {
    const store = memoryStore();
    const first = setup(store);
    const started = await first.data.startDeposit(ACCOUNT, 100, "bnb");

    const second = setup(store);
    expect(await second.data.getDeposit(ACCOUNT.toLowerCase(), started.id)).not.toBeNull();
    expect(await second.data.listDeposits("0xother")).toHaveLength(1);
  });

  it("survives corrupt or broken storage", async () => {
    const corrupt = memoryStore();
    corrupt.setItem("cascade.demo.v1", "{not json");
    expect(await setup(corrupt).data.listDeposits(ACCOUNT)).toHaveLength(1);

    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const { data } = setup(broken);
    const started = await data.startDeposit(ACCOUNT, 100, "base");
    expect(await data.getDeposit(ACCOUNT, started.id)).not.toBeNull();
  });

  it("works with no storage at all", async () => {
    const { data } = setup(null);
    const started = await data.startDeposit(ACCOUNT, 100, "base");
    expect(await data.listDeposits(ACCOUNT)).toHaveLength(2);
    expect(started.sourceChain).toBe("base");
  });
});

describe("protocol stats, rewards and balances", () => {
  it("reports itself as the mock", () => {
    const { data } = setup();
    expect(data.source).toBe("mock");
  });

  it("returns the sample protocol statistics", async () => {
    const { data } = setup();
    expect(await data.getProtocolStats()).toEqual({
      aprPercent: 11.4,
      totalStakedTao: 12480,
      stakers: 1204,
      taoPriceUsd: 286,
    });
  });

  it("gives every account 2,400 USDC to stake", async () => {
    const { data } = setup();
    expect(await data.getUsdcBalance(ACCOUNT)).toBe(2400);
  });

  it("quotes withdrawals as paid out in about a day", async () => {
    const { data } = setup();
    expect((await data.quoteWithdrawal(1)).etaMinutes).toBe(1440);
  });

  it("spreads each staked deposit's rewards over the days since it staked", async () => {
    const { data } = setup(); // clock is Oct 20 12:00; seed staked Oct 1 09:19
    const rewards = await data.listRewards(ACCOUNT);
    expect(rewards).toHaveLength(19);
    expect(rewards[0].date.getDate()).toBe(2); // the day after it staked on Oct 1
    expect(rewards.at(-1)?.date.getDate()).toBe(20);
    expect(rewards.at(-1)?.runningTotalTao).toBe(0.0213);
    expect(rewards.every((r) => r.taoAccrued > 0)).toBe(true);
    const total = rewards.reduce((s, r) => s + r.taoAccrued, 0);
    expect(Math.round(total * 1e4) / 1e4).toBe(0.0213);
  });

  it("ignores deposits that are still in progress", async () => {
    const { data, advance } = setup();
    await data.startDeposit(ACCOUNT, 100, "base");
    advance(DEMO_STEP_MS); // first step only; not staked
    const rewards = await data.listRewards(ACCOUNT);
    expect(rewards).toHaveLength(19);
    expect(rewards.at(-1)?.runningTotalTao).toBe(0.0213);
  });
});

describe("reward list over time", () => {
  it("never shows a negative day and always adds up, whatever the date", async () => {
    for (let day = 0; day < 400; day++) {
      const t = new Date(2026, 9, 2, 12, 0).getTime() + day * 86_400_000;
      const data = createMockCascadeData({ now: () => t, store: memoryStore() });
      const rewards = await data.listRewards(ACCOUNT);
      expect(rewards.every((r) => r.taoAccrued >= 0), `day ${day}`).toBe(true);
      const total = rewards.reduce((s, r) => s + r.taoAccrued, 0);
      expect(Math.round(total * 1e4) / 1e4, `day ${day}`).toBe(0.0213);
      expect(rewards.at(-1)?.runningTotalTao, `day ${day}`).toBe(0.0213);
    }
  });
});
