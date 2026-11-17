import { existsSync, readFileSync } from "node:fs";
import { type Address, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { DELIVERY_CHECKS_PER_ROUND, deliveryDecision, KEEPER_ROOM, KEEPER_ROOM_BPS, thinPool } from "../src/keeper/core/delivery.ts";
import { type JournalRow, memoryJournal } from "../src/keeper/core/journal.ts";
import { encodeMemory, freshMemory, type KeeperMemory, loadMemory } from "../src/keeper/core/memory.ts";
import { REVERT_BUDGET, runRound } from "../src/keeper/core/round.ts";
import { targetV32 } from "../src/keeper/core/v32/actions.ts";
import { ADDR, deploymentFor, depsFor, marketOf, saleOf, T, TAO, type World, world } from "./keeper-v32-world.ts";

// Task 50a's deliveries on the v3.2 core: the candidates from the front door's own events (credited, less delivered or
// claimed, with a live preference), oldest credit first, one sale a round, each re-quoted and re-simulated after the
// one before; ThinPool and the outside-price veto are skips tried again every round, never a strike (SE-4, R3 C-L1);
// USDC delivery off, or the keeper's deliveries switch off, sends nothing. On fake chains (no network, no real key).

const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);
const lower = (a: string) => a.toLowerCase();
const KEY_A: Hex = `0x${"ab".repeat(32)}`;
const OLDER = at("f1");
const NEWER = at("a1");
const d = deploymentFor();
const target = targetV32(d);
const OPTS = { intervalMs: 60_000, policy: { claimCostTao: 57n * 10n ** 15n, claimMultiple: 25n, monthlyClaimMaxUsd: 20 }, rewardsEveryTicks: 1000 };
const USDC = 1_000_000n;

/** `user` credited `amount` on Base (PayoutReceived at `block`), with a live delivery preference (DeliverySet a little
 * before) unless `min` is 0. */
function credit(w: World, user: Address, amount: bigint, o: { block?: bigint; min?: bigint } = {}) {
  const block = o.block ?? 9_000n;
  w.door.claimable[lower(user)] = (w.door.claimable[lower(user)] ?? 0n) + amount;
  w.logs.push({ chain: "base", address: ADDR.frontDoor, event: "PayoutReceived", args: { batchKey: KEY_A, chunk: 0, user, amount }, block });
  if (o.min === 0n) return;
  const pref = [o.min ?? 300n * USDC, BigInt(T + 7 * 86_400), 6] as const;
  w.door.prefs[lower(user)] = pref;
  w.logs.push({ chain: "base", address: ADDR.frontDoor, event: "DeliverySet", args: { user, minUsdcPerTao: pref[0], deadline: pref[1], destination: 6 }, block: block - 500n });
}

/** A world where only deliveries are due: no batch can close, the idle TAO below the staking floor, no payout. */
function deliveryWorld(): World {
  const w = world();
  w.door.canClose = false;
  w.market = marketOf();
  return w;
}

/** `n` rounds a minute apart, the memory through JSON between them and one journal across them (the Worker's). */
async function rounds(w: World, n: number, o: { memory?: KeeperMemory; dep?: typeof d; between?: (i: number) => void; journal?: ReturnType<typeof memoryJournal> } = {}) {
  const lines: string[] = [];
  const journal = o.journal ?? memoryJournal();
  let saved = encodeMemory(o.memory ?? freshMemory());
  let memory = freshMemory();
  const dep = o.dep ?? d;
  for (let i = 0; i < n; i++) {
    o.between?.(i);
    memory = loadMemory(saved).memory;
    const r = await runRound(depsFor(w, memory, dep, (l) => lines.push(l), { journal }).deps, targetV32(dep), memory, { ...OPTS, now: () => (T + i * 60) * 1000 });
    expect(r.end, `round ${i + 1}`).toBeUndefined();
    saved = encodeMemory(r.memory);
  }
  return { lines, memory, journal, delivers: w.sends.filter((s) => s.fn === "deliver") };
}

describe("the candidates: the door's own events, oldest credit first", () => {
  it("credited and not since delivered or claimed, with a live preference; ordered by the oldest credit, not the address", async () => {
    const w = deliveryWorld();
    credit(w, NEWER, TAO, { block: 9_100n });
    credit(w, OLDER, TAO, { block: 8_000n });
    // credited, but no preference: its TAO stays claimable and it is never read as a candidate
    credit(w, at("c0"), TAO, { block: 7_000n, min: 0n });
    // credited, then claimed: no longer a candidate
    credit(w, at("c1"), TAO, { block: 6_000n });
    w.door.claimable[lower(at("c1"))] = 0n;
    w.logs.push({ chain: "base", address: ADDR.frontDoor, event: "Claimed", args: { user: at("c1"), amount: TAO }, block: 6_500n });
    const { deps } = depsFor(w);
    expect(await deps.deliveryCandidates()).toEqual([OLDER, NEWER]);
  });

  it("a credit after a delivery is a new one; the cursor lives in the memory, so a fresh invocation reads on from it", async () => {
    const w = deliveryWorld();
    credit(w, OLDER, TAO, { block: 5_000n });
    w.logs.push({ chain: "base", address: ADDR.frontDoor, event: "Delivered", args: { user: OLDER, taoIn: TAO, usdcOut: 400n * USDC }, block: 5_100n });
    credit(w, NEWER, TAO, { block: 6_000n });
    const m = freshMemory();
    expect(await depsFor(w, m).deps.deliveryCandidates()).toEqual([NEWER]);
    // the next invocation: deps built afresh from the saved memory, a new credit of OLDER's (after its delivery)
    w.head.base += 500n;
    credit(w, OLDER, TAO, { block: w.head.base - 100n });
    const { memory } = loadMemory(encodeMemory(m));
    w.logQueries.length = 0;
    expect(await depsFor(w, memory).deps.deliveryCandidates()).toEqual([NEWER, OLDER]);
    // it read on from the cursor (REREAD blocks back), not from the deploy block: each of the four scans from 9,931
    const base = w.logQueries.filter((q) => q.chain === "base");
    expect(base.every((q) => q.from >= 10_000n + 1n - 70n)).toBe(true);
    expect(base.filter((q) => q.from === 10_000n + 1n - 70n)).toHaveLength(4);
  });
});

describe("one sale at a time, each re-quoted and re-simulated after the one before (founder 2026-11-05)", () => {
  it("two users owed about 4.8 TAO each, credited together: the older first; the second, re-quoted after the first moved the pool, waits for it; then goes at its fresh quote", async () => {
    const w = deliveryWorld();
    // 0.1% of price impact per TAO: a 4.8 TAO sale moves the pool about 1%, which the TWAP (30 minutes) doesn't follow
    w.market = marketOf({ impactBps: 10n });
    const owed = 48n * 10n ** 17n;
    credit(w, NEWER, owed, { block: 9_000n });
    credit(w, OLDER, owed, { block: 8_999n });
    const r = await rounds(w, 3, {
      between: (i) => {
        // the pool recovers (arbitrage) before the third round
        if (i === 2 && w.market) w.market.spot = 400_000_000n;
      },
    });
    // round 1: the older credit; round 2: nothing (the newer's re-quote no longer clears the TWAP's floor); round 3: it goes
    expect(r.delivers.map((s) => s.args[0])).toEqual([OLDER, NEWER]);
    const second = r.delivers[1];
    const quote = saleOf(marketOf({ impactBps: 10n }), owed);
    const net = quote - (quote * 15n) / 10_000n;
    expect(second.args[1]).toBe((net * (10_000n - KEEPER_ROOM_BPS)) / 10_000n);
    // the round-2 wait: the fresh quote, after the first sale, below the floor by the keeper's room; never a hold, never a strike
    expect(r.lines.some((l) => l.startsWith(`Delivery to ${NEWER} waits: the quote, `) && l.includes("the 30-minute TWAP floor"))).toBe(true);
    expect(r.memory.reverts).toEqual({});
    expect(r.memory.held).toEqual({});
    // the queue is logged, oldest credit first, when it changes
    const queue = r.lines.filter((l) => l.startsWith("Delivery queue (oldest credit first): "));
    expect(queue[0]).toBe(`Delivery queue (oldest credit first): ${OLDER} 4.8 TAO (due), ${NEWER} 4.8 TAO (due)`);
    expect(queue[1]).toBe(`Delivery queue (oldest credit first): ${NEWER} 4.8 TAO (waits)`);
    expect(queue).toHaveLength(3);
  });
});

describe("ThinPool is a skip tried again every round, never a strike, until meanLiquidity() clears (SE-4, R3 C-L1)", () => {
  const THIN: [bigint, bigint] = [5n, 10n ** 24n];

  it("at the simulation: waits each round with why, nothing sent, nothing held, no strike; delivered the round the mean clears", async () => {
    const w = deliveryWorld();
    credit(w, OLDER, TAO);
    if (w.market) w.market.meanLiquidity = THIN;
    const r = await rounds(w, 4, {
      between: (i) => {
        if (i === 3 && w.market) w.market.meanLiquidity = [10n ** 24n, 10n ** 24n];
      },
    });
    expect(r.delivers.map((s) => s.args[0])).toEqual([OLDER]);
    expect(r.lines).toContain(`Delivery to ${OLDER} waits: the TAO/WETH pool's 30-minute mean liquidity (5) is under the front door's floor (ThinPool): it waits, tried again each round until the pool's depth clears it (never a strike)`);
    expect(r.memory.reverts).toEqual({});
  });

  it("at the send's estimate: not held for 30 minutes as another refused estimate is: tried again the next round", async () => {
    const w = deliveryWorld();
    credit(w, OLDER, TAO);
    let first = true;
    w.simulate = (c) => (c.fn === "deliver" && first ? ((first = false), { error: "ThinPool", args: [1, 7n] }) : 200_000n);
    const r = await rounds(w, 2);
    expect(r.delivers.map((s) => s.args[0])).toEqual([OLDER]);
    expect(r.lines.some((l) => l.startsWith(`Delivery to ${OLDER} waits: the WETH/USDC pool's 30-minute mean liquidity (7) is under the front door's floor (ThinPool)`))).toBe(true);
    expect(r.memory.held).toEqual({});
  });

  it("on chain (the pool thinned in the block the sale landed in): no strike, no hold; the next round's simulation waits for the mean, then it goes", async () => {
    const w = deliveryWorld();
    credit(w, OLDER, TAO);
    let thinned = false;
    w.fate = () => {
      if (!thinned && w.market) {
        thinned = true;
        w.market.meanLiquidity = THIN;
      }
      return "mine";
    };
    const r = await rounds(w, 3, {
      between: (i) => {
        if (i === 2 && w.market) w.market.meanLiquidity = [10n ** 24n, 10n ** 24n];
      },
    });
    expect(r.delivers).toHaveLength(2);
    expect(w.receipts[r.delivers[0].hash].status).toBe("0x0");
    expect(r.lines.some((l) => l.startsWith(`Delivery to ${OLDER} waits: Base: deliver ${OLDER}'s TAO as USDC reverted on chain (transaction ${r.delivers[0].hash}, ThinPool(0, 5)): the TAO/WETH pool thinned before it landed; it waits, tried again each round until the pool's depth clears it (never a strike)`))).toBe(true);
    expect(r.memory.reverts).toEqual({});
    expect(r.memory.held).toEqual({});
    expect(r.lines.some((l) => l.startsWith("Failed this round"))).toBe(false);
    // a revert of another kind still counts against the user's budget, as before (the control)
    expect(REVERT_BUDGET).toBe(2);
  });

  it("a late receipt that reverted ThinPool: no strike either (its reason replayed from the journal's call)", async () => {
    const w = deliveryWorld();
    credit(w, OLDER, TAO);
    w.fate = (c) => (c.fn === "deliver" ? "hold" : "mine");
    const journal = memoryJournal();
    const first = await rounds(w, 1, { journal });
    const sent = first.delivers[0];
    expect(sent).toBeDefined();
    // it is mined later, reverted, while the pool reads thin (so its replay names ThinPool)
    w.receipts[sent.hash] = { status: "0x0", logs: [] };
    w.nonce.base.latest++;
    if (w.market) w.market.meanLiquidity = THIN;
    const second = await rounds(w, 1, { memory: first.memory, journal });
    expect(second.lines.some((l) => l.startsWith("Late receipt: delivering to") && l.includes("ThinPool(0, 5)") && l.includes("never a strike"))).toBe(true);
    expect(second.memory.reverts).toEqual({});
    expect(second.memory.held).toEqual({});
    // the journal's row is settled by the late receipt
    expect(journal.rows.find((x: JournalRow) => x.hashes.includes(sent.hash))?.status).toBe("reverted");
  });

  it("the plain sentence names the pool and its reading", () => {
    expect(thinPool("Base: deliver x would fail, nothing sent (ThinPool(1, 77))")).toBe("the WETH/USDC pool's 30-minute mean liquidity (77) is under the front door's floor (ThinPool)");
    expect(thinPool("BelowMinimum()")).toBeUndefined();
    expect(thinPool(undefined)).toBeUndefined();
  });
});

describe("the outside-price veto before each delivery, in the round", () => {
  it("the pools more than 3% under the reference: nothing sent, a wait tried again each round, never a strike; delivered once they agree", async () => {
    const w = deliveryWorld();
    credit(w, OLDER, TAO);
    w.monitor.price = { v: 1, usd: 420, sources: 2, at: T - 60 };
    const r = await rounds(w, 3, {
      between: (i) => {
        if (i === 2) w.monitor.price = { v: 1, usd: 401, sources: 1, at: T - 60 };
      },
    });
    expect(r.delivers.map((s) => s.args[0])).toEqual([OLDER]);
    expect(r.lines).toContain(
      `Delivery to ${OLDER} waits: the pools pay $400.00 a TAO (0.5 TAO along the delivery route), more than 3% under the outside price of $420.00 (2 sources): it waits, tried again each round (the outside-price veto; never a strike)`,
    );
    expect(r.memory.reverts).toEqual({});
    expect(r.memory.held).toEqual({});
  });

  it("stale (13 minutes) or unavailable: nothing sent; the pools above the reference (the user's gain): sent", async () => {
    for (const [price, sent] of [
      [{ v: 1, usd: 400, sources: 2, at: T - 13 * 60 }, false],
      [{ v: 1, unavailable: "the sources disagree by more than 2%", at: T - 60 }, false],
      [{ v: 1, usd: 380, sources: 2, at: T - 60 }, true],
    ] as const) {
      const w = deliveryWorld();
      credit(w, OLDER, TAO);
      w.monitor.price = price;
      const r = await rounds(w, 1);
      expect(r.delivers.length, JSON.stringify(price)).toBe(sent ? 1 : 0);
      if (!sent) expect(r.lines.some((l) => l.includes("the outside price can't be checked right now"))).toBe(true);
    }
    const w = deliveryWorld();
    credit(w, OLDER, TAO);
    w.monitor.priceDown = true;
    const r = await rounds(w, 1);
    expect(r.delivers).toEqual([]);
    expect(r.lines.some((l) => l.includes("the outside price can't be checked right now (the monitor gave no reference price)"))).toBe(true);
  });

  it("the reference is asked only when a delivery would otherwise go, once a round", async () => {
    const w = deliveryWorld();
    credit(w, OLDER, TAO, { min: 900n * USDC });
    credit(w, NEWER, TAO, { min: 900n * USDC });
    await rounds(w, 1);
    expect(w.monitor.priceReads).toBe(0);
    const v = deliveryWorld();
    credit(v, OLDER, TAO);
    credit(v, NEWER, TAO);
    v.monitor.price = { v: 1, usd: 420, sources: 2, at: T - 60 };
    await rounds(v, 1);
    expect(v.monitor.priceReads).toBe(1);
  });
});

describe("USDC delivery off, or the keeper's deliveries switch off: no delivery at all; credits stay claimable", () => {
  it("usdcDelivery off: nothing sent, no candidate read, said once; the batch still closes", async () => {
    const w = deliveryWorld();
    credit(w, OLDER, TAO);
    const r = await rounds(w, 2, { dep: deploymentFor({ usdcDelivery: false }) });
    expect(r.delivers).toEqual([]);
    expect(w.calls.filter((c) => c.fn === "deliveryOf")).toEqual([]);
    // no candidate read: none of the front door's delivery events scanned (Task 52's FAILURE watch reads the Base adapter's
    // own Sent, which is no candidate)
    expect(w.logQueries.filter((q) => q.chain === "base" && q.address.toLowerCase() === ADDR.frontDoor.toLowerCase())).toEqual([]);
    expect(r.lines.filter((l) => l.startsWith("USDC DELIVERY OFF: "))).toEqual([
      "USDC DELIVERY OFF: USDC delivery is off for this deployment (deployments.json usdcDelivery): no delivery is sent; credits stay claimable",
    ]);
    expect(w.door.claimable[lower(OLDER)]).toBe(TAO);
    // other work goes on
    const v = deliveryWorld();
    credit(v, OLDER, TAO);
    v.door.canClose = true;
    v.door.start = BigInt(T - 90_000);
    await rounds(v, 1, { dep: deploymentFor({ usdcDelivery: false }) });
    expect(v.sends.map((s) => s.fn)).toEqual(["closeBatch"]);
  });

  it("the deliveries switch off: the same, and back on it delivers", async () => {
    const w = deliveryWorld();
    credit(w, OLDER, TAO);
    w.deliveriesOn = false;
    const r = await rounds(w, 3, {
      between: (i) => {
        if (i === 2) w.deliveriesOn = true;
      },
    });
    expect(r.delivers.map((s) => s.args[0])).toEqual([OLDER]);
    expect(r.lines.filter((l) => l.startsWith("USDC DELIVERY OFF: "))).toEqual(["USDC DELIVERY OFF: the keeper's deliveries switch is off: no delivery is sent; credits stay claimable"]);
    expect(r.lines).toContain("USDC delivery is on again: deliveries go ahead");
  });
});

describe("the keeper's 0.5% room is the margin against a sandwich (R3 fix c2, C-I6)", () => {
  const pref = { minUsdcPerTao: 1n, deadline: T + 86_400, destination: 6 };

  it("its minimum is always the fresh quote less 0.5%, so a sale pushed further than that by a front-run reverts and the TAO stays", async () => {
    expect(KEEPER_ROOM).toBe("0.5%");
    for (const quote of [1_000_000n, 399_400_000n, 2_146_420_000n]) {
      const dcs = deliveryDecision({ claimable: TAO, pref, quoteUsdc: quote, twapUsdc: quote, slippageBps: 150, now: T });
      expect(dcs.keeperMinOut).toBe((quote * 9_950n) / 10_000n);
    }
    // a front-run of 0.4% between the quote and the sale: delivered at no less than the minimum
    for (const [front, mined] of [
      [40n, true],
      [60n, false],
    ] as const) {
      const w = deliveryWorld();
      credit(w, OLDER, TAO);
      w.fate = () => {
        if (w.market) w.market.spot = (w.market.spot * (10_000n - front)) / 10_000n;
        return "mine";
      };
      const r = await rounds(w, 1);
      expect(w.receipts[r.delivers[0].hash].status).toBe(mined ? "0x1" : "0x0");
      if (!mined) {
        expect(w.door.claimable[lower(OLDER)]).toBe(TAO);
        // BelowMinimum: a real revert, the price moved before it landed (counted against the budget as before)
        expect(r.lines.some((l) => l.includes("BelowMinimum") && l.includes("the price moved before the sale landed"))).toBe(true);
      }
    }
  });

  // the web's withdrawal limit counts the same room (web/src/lib/cascade/delivery-limit.ts, v3.2's Task 59a): held equal
  // from this side wherever the branch carries it; the web's own pin (delivery-limit.test.ts) reads core/delivery.ts
  const WEB_LIMIT = new URL("../../web/src/lib/cascade/delivery-limit.ts", import.meta.url);
  it.runIf(existsSync(WEB_LIMIT))("the web's KEEPER_ROOM_BPS is the keeper's (T59a M5)", () => {
    expect(readFileSync(WEB_LIMIT, "utf8")).toContain(`export const KEEPER_ROOM_BPS = ${KEEPER_ROOM_BPS}n;`);
  });

  it("R3's 10 TAO case (Base block 53,552,705): the quote less 0.5%, 2,135.69, is under the TWAP floor, 2,142.02: not sent", () => {
    const dcs = deliveryDecision({ claimable: 10n * TAO, pref, quoteUsdc: 2_146_422_000n, twapUsdc: 2_174_640_000n, slippageBps: 150, now: T });
    expect(dcs.deliver).toBe(false);
    expect(dcs.reason).toMatch(/clears the 30-minute TWAP floor of 2142\.0204 USDC by less than the 0\.5% room the keeper keeps/);
  });
});

describe("the candidates read a round: at most DELIVERY_CHECKS_PER_ROUND, in turn, the oldest first (Task 52w fix: the deliveries' reads never take a run's budget)", () => {
  /** Every deliveryOf the round asks (whose preference is read: a candidate read), round by round */
  const watchReads = (w: World) => {
    const rounds: string[][] = [[]];
    w.answers[`${lower(ADDR.frontDoor)}:deliveryOf`] = (args) => {
      rounds[rounds.length - 1].push(lower(args[0] as string));
      return w.door.prefs[lower(args[0] as string)] ?? [0n, 0n, 0];
    };
    return { rounds, next: () => void rounds.push([]) };
  };

  it("110 owed a delivery: each round reads at most the cap, the oldest not read yet first, so each is read within ceil(110 / the cap) rounds; one is delivered a round", async () => {
    expect(DELIVERY_CHECKS_PER_ROUND).toBe(20);
    const w = deliveryWorld();
    const users = Array.from({ length: 110 }, (_, i) => at(`d${(i + 1).toString(16).padStart(4, "0")}`));
    users.forEach((u, i) => credit(w, u, TAO, { block: 5_000n + BigInt(i) }));
    const seen = watchReads(w);
    const n = Math.ceil(users.length / DELIVERY_CHECKS_PER_ROUND);
    const r = await rounds(w, n, { between: (i) => (i > 0 ? seen.next() : undefined) });
    // the users each round read (a delivery re-reads its own user before it sells)
    const read = seen.rounds.map((x) => [...new Set(x)]);
    expect(read).toHaveLength(n);
    for (const x of read) expect(x.length).toBeLessThanOrEqual(DELIVERY_CHECKS_PER_ROUND);
    expect(read[0]).toEqual(users.slice(0, DELIVERY_CHECKS_PER_ROUND).map(lower));
    expect(new Set(read.flat())).toEqual(new Set(users.map(lower)));
    // each round's delivery is the oldest due among those it read: the sixth round ends the turn (the last 10) and starts
    // the next with the oldest left (users 1 to 10), so its oldest is user 1
    expect(r.delivers.map((s) => s.args[0])).toEqual([users[0], users[20], users[40], users[60], users[80], users[1]]);
    // the next round reads on in that turn: the oldest not read yet
    seen.next();
    await rounds(w, 1, { memory: r.memory, journal: r.journal });
    expect(seen.rounds.at(-1)?.[0]).toBe(lower(users[11]));
  });

  it("fewer than the cap: every one read every round, as before", async () => {
    const w = deliveryWorld();
    // floors above the market: read each round, never due
    credit(w, OLDER, TAO, { block: 8_000n, min: 900n * USDC });
    credit(w, NEWER, TAO, { block: 9_100n, min: 900n * USDC });
    const seen = watchReads(w);
    await rounds(w, 3, { between: (i) => (i > 0 ? seen.next() : undefined) });
    expect(seen.rounds).toHaveLength(3);
    for (const x of seen.rounds) expect(new Set(x)).toEqual(new Set([lower(OLDER), lower(NEWER)]));
  });

  it("one candidate whose read fails is said and skipped this round, and read again on its next turn; the others' deliveries go", async () => {
    const w = deliveryWorld();
    credit(w, OLDER, TAO, { block: 8_000n });
    credit(w, NEWER, TAO, { block: 9_100n });
    let fail = true;
    w.answers[`${lower(ADDR.frontDoor)}:deliveryOf`] = (args) => {
      if (fail && lower(args[0] as string) === lower(OLDER)) throw new Error("the node lost its state for it");
      return w.door.prefs[lower(args[0] as string)] ?? [0n, 0n, 0];
    };
    const r = await rounds(w, 1);
    expect(r.delivers.map((s) => s.args[0])).toEqual([NEWER]);
    expect(r.lines).toContainEqual(
      "DELIVERIES READ IN PART: 1 of the 2 users read this round could not be read (the node lost its state for it); each is read again on its next turn, and the keeper's other work goes on",
    );
    fail = false;
    const r2 = await rounds(w, 1, { memory: r.memory, journal: r.journal });
    expect(r2.delivers.map((s) => s.args[0])).toEqual([NEWER, OLDER]);
  });

  it("R1: candidates whose reads always fail take their turn and wait for their next one, so the cap's places never all go to them and every other candidate is still read within ceil(n / the cap) rounds (Task 52w re-review)", async () => {
    const w = deliveryWorld();
    // 25 failing users, the oldest credits, then 30 healthy ones: 55 candidates, so a turn takes 3 rounds
    const failing = Array.from({ length: 25 }, (_, i) => at(`fa${(i + 1).toString(16).padStart(3, "0")}`));
    const healthy = Array.from({ length: 30 }, (_, i) => at(`b0${(i + 1).toString(16).padStart(3, "0")}`));
    failing.forEach((u, i) => credit(w, u, TAO, { block: 5_000n + BigInt(i) }));
    healthy.forEach((u, i) => credit(w, u, TAO, { block: 6_000n + BigInt(i) }));
    const bad = new Set(failing.map(lower));
    const reads: string[][] = [[]];
    w.answers[`${lower(ADDR.frontDoor)}:deliveryOf`] = (args) => {
      const u = lower(args[0] as string);
      reads[reads.length - 1].push(u);
      if (bad.has(u)) throw new Error("the node lost its state for it");
      return w.door.prefs[u] ?? [0n, 0n, 0];
    };
    const n = Math.ceil((failing.length + healthy.length) / DELIVERY_CHECKS_PER_ROUND);
    expect(n).toBe(3);
    const r = await rounds(w, n, { between: (i) => (i > 0 ? void reads.push([]) : undefined) });
    const seen = reads.map((x) => [...new Set(x)]);
    for (const x of seen) expect(x.length).toBeLessThanOrEqual(DELIVERY_CHECKS_PER_ROUND);
    // every healthy one read within the turn's bound, and each failing one tried in it too
    expect(new Set(seen.flat().filter((u) => !bad.has(u)))).toEqual(new Set(healthy.map(lower)));
    expect(new Set(seen.flat().filter((u) => bad.has(u)))).toEqual(bad);
    // the first round reads the 20 oldest (all failing); the second the 5 failing left, then the healthy ones in order
    expect(seen[0]).toEqual(failing.slice(0, 20).map(lower));
    expect(seen[1].slice(0, 6)).toEqual([...failing.slice(20).map(lower), lower(healthy[0])]);
    // each failure is said, and the healthy ones are delivered, one a round, from the second round on
    expect(r.lines.filter((l) => l.startsWith("DELIVERIES READ IN PART: 20 of the 20 users read this round could not be read"))).toHaveLength(1);
    expect(r.delivers.map((s) => s.args[0])).toEqual([healthy[0], healthy[15]]);
  });
});
