import { type Address, encodeAbiParameters, encodeEventTopics, getAddress, type Hex, padHex, parseAbi, parseEther } from "viem";
import { describe, expect, it } from "vitest";
import { DOOR } from "../src/keeper/core/abi.ts";
import { SendRefused, SpendCapRefused } from "../src/keeper/core/errors.ts";
import { classifyFailure, KeeperNotReady } from "../src/keeper/core/failures.ts";
import { type JournalRow, memoryJournal, SPEND_WINDOW_MS, spentOf, spentOn } from "../src/keeper/core/journal.ts";
import { encodeMemory, freshMemory, type KeeperMemory, loadMemory } from "../src/keeper/core/memory.ts";
import { type Payout, payoutsHash } from "../src/keeper/core/payouts.ts";
import { REPLACE_AFTER_MS, runRound } from "../src/keeper/core/round.ts";
import { act, deliver, deliverAll, deliverCommand, type KeeperDeps, type KeeperTarget, keeperSend } from "../src/keeper/core/actions.ts";
import { closeV32, payoutsV32, rollV32, stakeV32, targetV32, V32_ACTIONS } from "../src/keeper/core/v32/actions.ts";
import { railsRefusal, railsV32 } from "../src/keeper/core/v32/rails.ts";
import type { KeeperDepsV32 } from "../src/keeper/core/v32/reads.ts";
import { closeRequest, convertParkRequest, parkKeyOf, stakeRequest } from "../src/keeper/core/v32/requests.ts";
import type { CallRequest } from "../src/keeper/core/types.ts";
import { ADDR, deploymentFor, depsFor, failInWorld, healthyStatus, KEY, laneMessage, marketOf, parkInWorld, sendInWorld, T, TAO, type World, world } from "./keeper-v32-world.ts";

// Task 50a's rails on the v3.2 core, round by round: the monitor's hold stops every send, deliveries included (the
// founder's Phase 10 answer), and so does a monitor the keeper can't read or that can't see (fail closed); a hand run's
// --ignore-monitor-outage --until (at most 24 h) lifts an outage only, never a hold; a payout needs its key confirmed by
// the monitor; and the 24 h spend cap per chain, summed from the journal, stops that chain's sends. On fake chains.

const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);
const lower = (a: string) => a.toLowerCase();
const KEY_A: Hex = `0x${"ab".repeat(32)}`;
const KEY_B: Hex = `0x${"cd".repeat(32)}`;
const ALICE = at("a11c");
const USDC = 1_000_000n;
const d = deploymentFor();
const OPTS = { intervalMs: 60_000, policy: { claimCostTao: 57n * 10n ** 15n, claimMultiple: 25n, monthlyClaimMaxUsd: 20 }, rewardsEveryTicks: 1000 };

/** A payout batch due in the world, its list's logs and its queue (as keeper-v32.test.ts's queue). */
function queue(w: World, key: Hex, list: Payout[], block = 5_000n) {
  list.forEach((p, i) => w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "Redeemed", args: { key, user: p.user, shares: p.shares, assets: p.assets }, block: block + BigInt(i) }));
  const total = list.reduce((t, p) => t + p.assets, 0n);
  w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "PayoutBatchQueued", args: { key, sourceChain: 8453n, batchId: 7n, count: list.length, total, price: 10n ** 12n }, block: block + 50n });
  w.vault.batches[key.toLowerCase()] = {
    sourceChain: 8453n,
    frontDoor: ADDR.frontDoor,
    batchId: 7n,
    queuedAt: BigInt(T - 2 * 86_400),
    cursor: 0,
    count: list.length,
    chunk: 0,
    remaining: total,
    payoutsHash: payoutsHash(list),
  };
  w.vault.pending += total;
}

/** Each kind of send the round makes, in a world where it alone is due. */
const SCENES: Record<string, { fn: string; make: () => World }> = {
  "a close carrying a redeem": {
    fn: "closeBatch",
    make: () => {
      const w = world();
      w.door.start = BigInt(T - 90_000);
      w.door.deposits = [];
      w.door.totalDeposits = 0n;
      w.door.redeems = [{ user: ALICE, amount: TAO }];
      return w;
    },
  },
  "a deposit-only close": {
    fn: "closeBatch",
    make: () => {
      const w = world();
      w.door.start = BigInt(T - 90_000);
      return w;
    },
  },
  "a roll": {
    fn: "closeBatch",
    make: () => {
      const w = world();
      w.door.deposits = [];
      w.door.totalDeposits = 0n;
      return w;
    },
  },
  "a stake": {
    fn: "stakeIdle",
    make: () => {
      const w = world();
      w.door.canClose = false;
      w.vault.balance = 10n * TAO;
      return w;
    },
  },
  "a payout": {
    fn: "processPayouts",
    make: () => {
      const w = world();
      w.door.canClose = false;
      queue(w, KEY_A, [{ user: ALICE, shares: TAO, assets: TAO }]);
      w.vault.balance = TAO + 10n ** 15n;
      return w;
    },
  },
  "a delivery": {
    fn: "deliver",
    make: () => {
      const w = world();
      w.door.canClose = false;
      w.market = marketOf();
      w.door.claimable[lower(ALICE)] = TAO;
      w.door.prefs[lower(ALICE)] = [300n * USDC, BigInt(T + 86_400), 6];
      w.logs.push({ chain: "base", address: ADDR.frontDoor, event: "DeliverySet", args: { user: ALICE, minUsdcPerTao: 300n * USDC, deadline: BigInt(T + 86_400), destination: 6 }, block: 8_000n });
      w.logs.push({ chain: "base", address: ADDR.frontDoor, event: "PayoutReceived", args: { batchKey: KEY_A, chunk: 0, user: ALICE, amount: TAO }, block: 9_000n });
      return w;
    },
  },
};

/** `n` rounds a minute apart (from `from` s), the memory through JSON between them and one journal across them. */
async function rounds(
  w: World,
  n: number,
  o: {
    from?: number;
    dep?: typeof d;
    rails?: NonNullable<Parameters<typeof depsFor>[4]>["rails"];
    journal?: ReturnType<typeof memoryJournal>;
    memory?: KeeperMemory;
    between?: (i: number) => void;
    target?: KeeperTarget;
    wrap?: (deps: KeeperDeps) => void;
    /** each round's memory once the round is done */
    after?: (m: KeeperMemory) => void;
    /** how often the claims and the adoption are read (OPTS: once, at the first round) */
    rewardsEveryTicks?: number;
  } = {},
) {
  const lines: string[] = [];
  const journal = o.journal ?? memoryJournal();
  let saved = encodeMemory(o.memory ?? freshMemory());
  let memory = freshMemory();
  const dep = o.dep ?? d;
  for (let i = 0; i < n; i++) {
    o.between?.(i);
    memory = loadMemory(saved).memory;
    const now = ((o.from ?? T) + i * 60) * 1000;
    const { deps } = depsFor(w, memory, dep, (l) => lines.push(l), { journal, rails: o.rails });
    o.wrap?.(deps);
    const r = await runRound(deps, o.target ?? targetV32(dep), memory, { ...OPTS, ...(o.rewardsEveryTicks ? { rewardsEveryTicks: o.rewardsEveryTicks } : {}), now: () => now });
    expect(r.end, `round ${i + 1}: ${lines.at(-1)}`).toBeUndefined();
    o.after?.(r.memory);
    saved = encodeMemory(r.memory);
  }
  return { lines, memory, journal };
}

describe("each scene sends its one transaction when nothing holds the keeper (the control)", () => {
  for (const [name, s] of Object.entries(SCENES)) {
    it(name, async () => {
      const w = s.make();
      await rounds(w, 1);
      expect(w.sends.map((x) => x.fn)).toEqual([s.fn]);
    });
  }
});

describe("a monitor hold stops everything, USDC deliveries included (the founder's answer, over the note's)", () => {
  for (const [name, s] of Object.entries(SCENES)) {
    it(`holds ${name}: nothing sent in every held round, the round not even reading the chains, said once; sent once the hold clears`, async () => {
      const w = s.make();
      w.monitor.hold = ["h-7f3a"];
      const owed = { ...w.door.claimable };
      const r = await rounds(w, 3, {
        between: (i) => {
          if (i === 0) return;
          // after each held round: nothing sent, the credit as it was, and the round stopped before its state read
          // (no openBatch, no delivery read or simulation): the hold is the round's own early return
          expect(w.sends, `after held round ${i}`).toEqual([]);
          expect(w.door.claimable, `after held round ${i}`).toEqual(owed);
          expect(w.calls.filter((c) => ["openBatch", "deliveryOf", "deliver"].includes(c.fn)), `after held round ${i}`).toEqual([]);
          if (i === 2) w.monitor.hold = [];
        },
      });
      expect(w.sends.map((x) => x.fn)).toEqual([s.fn]);
      if (s.fn === "deliver") expect(w.door.claimable[lower(ALICE)]).toBe(0n);
      expect(r.lines.filter((l) => l.startsWith("HOLD: "))).toEqual([
        "HOLD: the monitor holds the keeper (hold h-7f3a): nothing is sent (no close, payout, stake, claim, delivery or park job) until it clears",
      ]);
      expect(r.lines).toContain("Sends resume: nothing holds the keeper, and the monitor can see");
    });
  }

  it("a hold that changes is said again; the status is read once a round", async () => {
    const w = SCENES["a stake"].make();
    w.monitor.hold = ["h-1"];
    const r = await rounds(w, 3, {
      between: (i) => {
        if (i === 1) w.monitor.hold = ["h-1", "h-2"];
      },
    });
    expect(r.lines.filter((l) => l.startsWith("HOLD: "))).toHaveLength(2);
    expect(w.monitor.statusReads).toBe(3);
    expect(w.sends).toEqual([]);
  });

  it("holds a replacement of a stuck transaction too (a replacement is a send): the receipt is still looked up", async () => {
    const run = async (held: boolean) => {
      const w = SCENES["a stake"].make();
      w.fate = () => "hold";
      const first = await rounds(w, 1);
      expect(w.sends).toHaveLength(1);
      if (held) w.monitor.hold = ["h-1"];
      const second = await rounds(w, 1, { memory: first.memory, from: T + REPLACE_AFTER_MS / 1000 + 60 });
      return { w, lines: second.lines, memory: second.memory };
    };
    const control = await run(false);
    expect(control.lines.some((l) => l.startsWith("REPLACING transaction"))).toBe(true);
    const held = await run(true);
    expect(held.lines.some((l) => l.startsWith("REPLACING"))).toBe(false);
    expect(held.w.sends).toHaveLength(1);
    // still watched, for the round after the hold
    expect(held.memory.unreceipted).toHaveLength(1);
  });

  it("ops/hold.json holds a hand run the same way", async () => {
    const w = SCENES["a deposit-only close"].make();
    w.holdFile = '{"hold": true, "reason": "checking a swap"}';
    const r = await rounds(w, 1);
    expect(w.sends).toEqual([]);
    expect(r.lines).toContain("HOLD: ops/hold.json holds the keeper (checking a swap): nothing is sent (no close, payout, stake, claim, delivery or park job) until it clears");
  });
});

describe("the monitor unreachable, or not seeing, stops every send (fail closed)", () => {
  for (const [name, s] of Object.entries(SCENES)) {
    it(`unreachable: ${name} isn't sent`, async () => {
      const w = s.make();
      w.monitor.down = true;
      const r = await rounds(w, 2);
      expect(w.sends).toEqual([]);
      expect(r.lines.filter((l) => l.startsWith("THE MONITOR CAN'T SEE: "))).toEqual(["THE MONITOR CAN'T SEE: the monitor (monitor.test) could not be read: a network error: nothing is sent until it can"]);
    });
  }

  it("no monitor configured: nothing sent", async () => {
    const w = SCENES["a deposit-only close"].make();
    const r = await rounds(w, 1, { rails: { monitor: null } });
    expect(w.sends).toEqual([]);
    expect(r.lines.some((l) => l.startsWith("THE MONITOR CAN'T SEE: no monitor is configured"))).toBe(true);
  });

  it("a chain lagging past the limit: nothing sent; a hand run's --ignore-monitor-outage --until lets it go on with a warning each round, until --until", async () => {
    const w = SCENES["a deposit-only close"].make();
    w.monitor.status = () => healthyStatus(w, { lagS: 4_000 });
    const held = await rounds(w, 1);
    expect(w.sends).toEqual([]);
    expect(held.lines.some((l) => l.startsWith("THE MONITOR CAN'T SEE: Base is 67 minutes behind"))).toBe(true);
    // an hour's override (the hand run's): the close goes, said each round; at --until it lapses
    w.override = { until: (T + 90) * 1000 };
    w.door.canClose = true;
    const r = await rounds(w, 3);
    expect(r.lines.filter((l) => l.startsWith("MONITOR OUTAGE IGNORED until "))).toHaveLength(2);
    expect(r.lines.filter((l) => l.startsWith("THE MONITOR CAN'T SEE: "))).toHaveLength(1);
    expect(w.sends.length).toBeGreaterThanOrEqual(1);
    const before = w.sends.length;
    // the override never lifts a hold, the monitor's or the file's
    w.override = { until: (T + 3_600) * 1000 };
    w.monitor.hold = ["h-1"];
    await rounds(w, 1);
    w.monitor.hold = [];
    w.holdFile = '{"hold": true}';
    await rounds(w, 1);
    expect(w.sends.length).toBe(before);
  });

  it("an overridden outage skips the per-key check: a payout the monitor never confirmed goes (the plan's rule)", async () => {
    const w = SCENES["a payout"].make();
    w.monitor.down = true;
    w.override = { until: (T + 3_600) * 1000 };
    await rounds(w, 1);
    expect(w.sends.map((s) => s.fn)).toEqual(["processPayouts"]);
  });
});

describe("a payout also needs its key in the monitor's okKeys", () => {
  it("monitor healthy, a key not in okKeys: that payout isn't sent; another that is, is", async () => {
    const w = SCENES["a payout"].make();
    queue(w, KEY_B, [{ user: at("b0b"), shares: TAO, assets: TAO }], 6_000n);
    w.vault.balance = 3n * TAO;
    w.monitor.okKeys = [KEY_B];
    await rounds(w, 1);
    expect(w.sends.map((s) => [s.fn, s.args[0]])).toEqual([["processPayouts", KEY_B]]);
    const v = SCENES["a payout"].make();
    v.monitor.okKeys = [];
    const r = await rounds(v, 1);
    expect(v.sends).toEqual([]);
    expect(r.lines.some((l) => l.includes("paying out batch 0xabababab… waits for the monitor to confirm it (not in its okKeys)"))).toBe(true);
  });
});

describe("the 24 h spend cap per chain, summed from the journal (gas plus value)", () => {
  const CAP = { base: parseEther("0.0017"), bittensor: parseEther("0.033") };
  const capped = deploymentFor({ spendCap: CAP });
  const row = (o: Partial<JournalRow> & Pick<JournalRow, "chain" | "status" | "at">): JournalRow => ({
    from: KEY.address,
    nonce: 1,
    hashes: [`0x${"01".repeat(32)}`],
    request: closeRequest({ plan: { addresses: d.addresses } }, 7n, TAO, 15n * 10n ** 14n, 1),
    raw: "0x",
    ...o,
  });
  const landedClose = (atMs: number, returned = 0n) =>
    row({ chain: "base", status: "landed", at: atMs, receipt: { hash: `0x${"01".repeat(32)}`, block: 1, gasUsed: 200_000n, costWei: 2n * 10n ** 14n }, returned });

  it("counts a landed send's gas and its value less what came back, a revert's gas alone, nothing for one never sent; a pending one at its worst case", async () => {
    expect(spentOf(landedClose(0))).toBe(2n * 10n ** 14n + 15n * 10n ** 14n);
    expect(spentOf(landedClose(0, 14n * 10n ** 14n))).toBe(3n * 10n ** 14n);
    expect(spentOf(row({ chain: "base", status: "reverted", at: 0, receipt: { hash: `0x${"01".repeat(32)}`, block: 1, gasUsed: 1n, costWei: 7n } }))).toBe(7n);
    expect(spentOf(row({ chain: "base", status: "never-sent", at: 0 }))).toBe(0n);
    const raw = await KEY.signTransaction({ type: "eip1559", chainId: 8453, nonce: 1, to: ADDR.frontDoor, gas: 300_000n, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n, value: 15n * 10n ** 14n, data: "0x" });
    expect(spentOf(row({ chain: "base", status: "sent", at: 0, raw }))).toBe(300_000n * 2n * 10n ** 9n + 15n * 10n ** 14n);
    const legacy = await KEY.signTransaction({ type: "legacy", chainId: 964, nonce: 1, to: ADDR.vault, gas: 500_000n, gasPrice: 10n ** 10n, data: "0x" });
    expect(spentOf(row({ chain: "bittensor", status: "signed", at: 0, raw: legacy, request: stakeRequest({ plan: { addresses: d.addresses } }, 1) }))).toBe(500_000n * 10n ** 10n);
    // by chain, within the window
    const now = 100 * SPEND_WINDOW_MS;
    expect(spentOn([landedClose(now - 1_000), landedClose(now - SPEND_WINDOW_MS - 1)], "base", now)).toBe(spentOf(landedClose(0)));
    expect(spentOn([landedClose(now - 1_000)], "bittensor", now)).toBe(0n);
  });

  it("a close's float counts net of what the door sent back (BatchClosed: the fee less the pot's part)", async () => {
    const w = SCENES["a deposit-only close"].make();
    w.receiptLogs = (c) =>
      c.fn === "closeBatch"
        ? [{ address: ADDR.frontDoor, topics: encodeEventTopics({ abi: DOOR, eventName: "BatchClosed", args: { id: 7n } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [2n * TAO, 1n, 0n, 10n ** 14n, 0n, 0n]) }]
        : [];
    const { journal } = await rounds(w, 1, { dep: capped });
    expect(journal.rows).toHaveLength(1);
    // sent 0.0015 ETH, the bridge fee 0.0001 from it: 0.0014 back
    expect(journal.rows[0].returned).toBe(14n * 10n ** 14n);
    expect(spentOf(journal.rows[0])).toBe(journal.rows[0].receipt?.costWei as bigint + 10n ** 14n);
  });

  it("at the cap on Base: nothing more is sent on Base, said loudly once; Bittensor's sends go on; after 24 h Base's resume", async () => {
    const w = SCENES["a stake"].make();
    w.door.canClose = true;
    w.door.start = BigInt(T - 90_000);
    const journal = memoryJournal();
    journal.rows.push(landedClose(T * 1000 - 3_600_000));
    // the stake (Bittensor) goes first by the round's order, then the close (Base) waits on the cap
    const r = await rounds(w, 3, { dep: capped, journal });
    expect(w.sends.map((s) => s.fn)).toEqual(["stakeIdle", "stakeIdle", "stakeIdle"]);
    w.vault.balance = 10n ** 15n;
    const r2 = await rounds(w, 2, { dep: capped, journal, memory: r.memory });
    expect(w.sends.filter((s) => s.chain === "base")).toEqual([]);
    const loud = [...r.lines, ...r2.lines].filter((l) => l.startsWith("SPEND CAP: "));
    expect(loud).toEqual([
      "SPEND CAP: Base: the keeper has sent 0.0017 ETH in the last 24 hours (gas and value, from its journal), at or over its 0.0017 ETH cap: nothing more is sent on Base until the 24-hour sum falls under it; Bittensor's sends go on",
    ]);
    expect(r2.lines.some((l) => l.includes("Base's sends wait: the keeper is at its 24 h spend cap there (see SPEND CAP above)"))).toBe(true);
    // 24 hours on (the chains' clocks and the monitor's with the keeper's), the old close leaves the window: Base's sends resume
    w.time.base = T + 86_400;
    w.time.bittensor = T + 86_400;
    const r3 = await rounds(w, 1, { dep: capped, journal, memory: r2.memory, from: T + 86_400 });
    expect(r3.lines).toContain("SPEND CAP lifted on Base: the 24-hour sum is under the cap again");
    expect(w.sends.filter((s) => s.chain === "base").map((s) => s.fn)).toEqual(["closeBatch"]);
  });

  it("R12a: at the launch's 0.01 ETH cap a full batch's close goes while its gas and quoted fee fit, though its float (three quotes) doesn't; one whose quote would cross the cap waits, and nothing lands the keeper over it", async () => {
    const launch = deploymentFor({ spendCap: { base: parseEther("0.01"), bittensor: parseEther("0.4") } });
    // a full 50 + 50 batch quotes about 0.0043 ETH (7,000,000 gas toward Bittensor): a float of 0.0129 ETH, above the cap;
    // the close's gas at most 250,000 (1.25 × the world's 200,000) at a 2 gwei fee cap: 0.0005 ETH
    const QUOTE = 43n * 10n ** 14n;
    const spentBefore = (w: World, wei: bigint) => {
      const journal = memoryJournal();
      // a landed close of an hour ago whose float all came back but `wei`: its gas
      journal.rows.push(row({ chain: "base", status: "landed", at: w.time.base * 1000 - 3_600_000, receipt: { hash: `0x${"01".repeat(32)}`, block: 1, gasUsed: 1n, costWei: wei }, returned: 15n * 10n ** 14n }));
      return journal;
    };
    const goes = SCENES["a deposit-only close"].make();
    goes.door.closeFee = QUOTE;
    const { journal } = await rounds(goes, 1, { dep: launch, journal: spentBefore(goes, 5n * 10n ** 15n) });
    expect(goes.sends.map((s) => [s.fn, s.value])).toEqual([["closeBatch", 3n * QUOTE]]);
    // the request carries its quote: what the check counted of the float
    expect(journal.rows.at(-1)?.request).toMatchObject({ value: 3n * QUOTE, valueKept: QUOTE });
    // 0.0056 spent: 0.0056 + 0.0005 + 0.0043 is over 0.01, so it waits for the window (by its gas alone it would go)
    const waits = SCENES["a deposit-only close"].make();
    waits.door.closeFee = QUOTE;
    const r = await rounds(waits, 1, { dep: launch, journal: spentBefore(waits, 56n * 10n ** 14n) });
    expect(waits.sends).toEqual([]);
    expect(r.lines.some((l) => l.includes("could cost up to 0.0048 ETH (a 250,000 gas limit at 2 gwei, and the 0.0043 ETH of its 0.0129 ETH value it keeps)"))).toBe(true);
  });

  it("R12d (M-1): a close the send path refuses for want of room (the chain under its cap, the close's own worst case over what is left) is a wait, said once: every round goes on to the work behind it on both chains, no round fails, a Base send that still fits goes; once the window leaves room the close goes", async () => {
    const launch = deploymentFor({ spendCap: { base: parseEther("0.01"), bittensor: parseEther("0.4") }, reexecAuto: true });
    const QUOTE = 43n * 10n ** 14n;
    // a batch at its max wait (its close due whatever its fees), quoting a full batch's 0.0043 ETH: 0.0048 ETH at worst with
    // its gas, over the 0.0044 left by 0.0056 spent an hour ago, though Base reads under its 0.01 cap
    const w = SCENES["a deposit-only close"].make();
    w.door.closeFee = QUOTE;
    // behind it on Bittensor: the vault's surplus due its adoption; on Base: a payout of Cascade's in CCIP FAILURE there, due
    // its re-execution (OPS_REEXEC_AUTO on), which carries no value
    w.vault.lastAdoptAt = BigInt(T - 2 * 86_400);
    w.vault.surplusStakeRao = 2_000_000n;
    const payload = { recipient: ADDR.frontDoor, sender: ADDR.vault, message: padHex("0x02", { size: 64 }) };
    const msg = laneMessage("Bittensor → Base", payload, { amount: 2n * TAO, number: 2n, gas: 300_000 });
    sendInWorld(w, "Bittensor → Base", msg, payload, { block: 9_002n });
    failInWorld(w, "Bittensor → Base", msg);
    // and a delivery, due once the deliveries switch is on, from the third round: no value, so it fits what is left
    w.market = marketOf();
    w.door.claimable[lower(ALICE)] = TAO;
    w.door.prefs[lower(ALICE)] = [300n * USDC, BigInt(T + 86_400), 6];
    w.logs.push({ chain: "base", address: ADDR.frontDoor, event: "DeliverySet", args: { user: ALICE, minUsdcPerTao: 300n * USDC, deadline: BigInt(T + 86_400), destination: 6 }, block: 8_000n });
    w.logs.push({ chain: "base", address: ADDR.frontDoor, event: "PayoutReceived", args: { batchKey: KEY_A, chunk: 0, user: ALICE, amount: TAO }, block: 9_000n });
    w.deliveriesOn = false;
    const journal = memoryJournal();
    journal.rows.push(row({ chain: "base", status: "landed", at: w.time.base * 1000 - 3_600_000, receipt: { hash: `0x${"01".repeat(32)}`, block: 1, gasUsed: 1n, costWei: 56n * 10n ** 14n }, returned: 15n * 10n ** 14n }));
    const failing: number[] = [];
    const r = await rounds(w, 4, {
      dep: launch,
      journal,
      between: (i) => {
        if (i === 2) w.deliveriesOn = true;
      },
      after: (m) => failing.push(m.failing),
      rewardsEveryTicks: 1,
    });
    // the work behind the close went, one send a round, on both chains; the close never went, and no round failed
    expect(w.sends.map((s) => [s.chain, s.fn])).toEqual([
      ["base", "execute"],
      ["bittensor", "adoptStake"],
      ["base", "deliver"],
    ]);
    expect(failing).toEqual([0, 0, 0, 0]);
    expect(r.lines.filter((l) => l.startsWith("Failed this round"))).toEqual([]);
    // said once, with the send path's own words, though it was refused every round
    const said = r.lines.filter((l) => l.startsWith("SPEND CAP ROOM: "));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("closing the batch waits: Base: close batch 7 and send it to Bittensor could cost up to 0.0048 ETH");
    expect(said[0]).toContain("the keeper's other work goes on, on both chains");
    // the quiet round says what waits, and why
    expect(r.lines).toContain("nothing due: closing the batch waits for room under the keeper's 24 h spend cap on Base (see SPEND CAP ROOM above); it is tried again each round");
    // a day on, the old close leaves the window: the close goes
    w.time.base = T + 86_400;
    w.time.bittensor = T + 86_400;
    await rounds(w, 1, { dep: launch, journal, memory: r.memory, from: T + 86_400 });
    expect(w.sends.at(-1)).toMatchObject({ chain: "base", fn: "closeBatch", args: [7n, 0n] });
  });

  it("R12d (L-2): what a close keeps is its quote less the batch's pot (the door spends the pot first), never below 0, so a close whose pot pays part of its fee fits the room its quote alone would not", async () => {
    const launch = deploymentFor({ spendCap: { base: parseEther("0.01"), bittensor: parseEther("0.4") } });
    const QUOTE = 43n * 10n ** 14n;
    const spent = (w: World) => {
      const journal = memoryJournal();
      journal.rows.push(row({ chain: "base", status: "landed", at: w.time.base * 1000 - 3_600_000, receipt: { hash: `0x${"01".repeat(32)}`, block: 1, gasUsed: 1n, costWei: 56n * 10n ** 14n }, returned: 15n * 10n ** 14n }));
      return journal;
    };
    // 0.0056 spent: 0.0044 left; the close's gas at most 0.0005, its quote 0.0043, its pot 0.002: it keeps 0.0023, so fits
    const w = SCENES["a deposit-only close"].make();
    w.door.closeFee = QUOTE;
    w.door.feePot = 2n * 10n ** 15n;
    const { journal } = await rounds(w, 1, { dep: launch, journal: spent(w) });
    expect(w.sends.map((s) => [s.fn, s.value])).toEqual([["closeBatch", 3n * QUOTE]]);
    expect(journal.rows.at(-1)?.request).toMatchObject({ value: 3n * QUOTE, valueKept: QUOTE - 2n * 10n ** 15n });
    // a pot that covers the whole quote: the close keeps nothing of its float
    const paid = SCENES["a deposit-only close"].make();
    paid.door.closeFee = QUOTE;
    paid.door.feePot = 2n * QUOTE;
    const second = await rounds(paid, 1, { dep: launch, journal: spent(paid) });
    expect(second.journal.rows.at(-1)?.request).toMatchObject({ value: 3n * QUOTE, valueKept: 0n });
  });

  it("the raw send path refuses on its own too (the backstop): SendRefused spend-cap, a wait, never a stop", async () => {
    const w = SCENES["a deposit-only close"].make();
    const journal = memoryJournal();
    journal.rows.push(landedClose(w.time.base * 1000 - 1_000));
    const { deps } = depsFor(w, freshMemory(), capped, () => undefined, { journal });
    const e = await deps.sendCall(closeRequest({ plan: { addresses: d.addresses } }, 7n, 2n * TAO, 15n * 10n ** 14n, 3)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SendRefused);
    expect((e as SendRefused).reason).toBe("spend-cap");
    expect(classifyFailure(e)).toMatchObject({ stop: false, kind: "spend-cap" });
    // R12d (M-1): it says the chain is at its cap, so the round waits on the chain, not on this send alone
    expect(e).toBeInstanceOf(SpendCapRefused);
    expect(e).toMatchObject({ chain: "base", atCap: true });
    expect(w.sends).toEqual([]);
  });
});

describe("a one-shot hand command goes by the same rails (Task 50b's CLI applies railsRefusal before each send)", () => {
  it("a hold refuses everything; a capped chain its sends; deliveries off a delivery; an unconfirmed key its payout", async () => {
    const w = SCENES["a payout"].make();
    const m = freshMemory();
    const healthy = await railsV32(depsFor(w, m).deps, m, T * 1000);
    expect(railsRefusal(healthy, { chain: "bittensor", payoutKey: KEY_A })).toBeUndefined();
    expect(railsRefusal(healthy, { chain: "bittensor", payoutKey: KEY_B })).toBe("payout batch 0xcdcdcdcd… waits for the monitor to confirm it (not in its okKeys)");
    w.monitor.hold = ["h-1"];
    const held = await railsV32(depsFor(w, m).deps, m, T * 1000);
    expect(railsRefusal(held, { chain: "base" })).toMatch(/^HOLD: the monitor holds the keeper \(hold h-1\)/);
    w.monitor.hold = [];
    w.deliveriesOn = false;
    const off = await railsV32(depsFor(w, m).deps, m, T * 1000);
    expect(railsRefusal(off, { chain: "base", delivery: true })).toMatch(/^USDC DELIVERY OFF: the keeper's deliveries switch is off/);
    expect(railsRefusal(off, { chain: "base" })).toBeUndefined();
    expect(railsRefusal({ capped: new Set(["base"]) }, { chain: "base" })).toBe("Base is at the keeper's 24 h spend cap (see SPEND CAP above): nothing more is sent on it");
    expect(railsRefusal({ capped: new Set(["base"]) }, { chain: "bittensor" })).toBeUndefined();
  });
});

describe("the rails at the one send path: every v3.2 send, from any entry point, is refused under them (T50a review I2)", () => {
  /** `run` against a world under a hold: refused at the send path (SendRefused "rails", a wait), nothing sent. */
  async function refusedUnderHold(scene: string, run: (deps: KeeperDeps, w: World) => Promise<unknown>) {
    const w = SCENES[scene].make();
    w.monitor.hold = ["h-1"];
    const { deps } = depsFor(w);
    const e = await run(deps, w).catch((x: unknown) => x);
    expect(e, scene).toBeInstanceOf(SendRefused);
    expect((e as SendRefused).reason).toBe("rails");
    expect((e as Error).message).toMatch(/^the rails refuse it: HOLD: the monitor holds the keeper \(hold h-1\)/);
    expect(classifyFailure(e)).toMatchObject({ stop: false, kind: "rails" });
    expect(w.sends).toEqual([]);
  }
  const t = targetV32(d);

  it("deliver", () => refusedUnderHold("a delivery", (deps) => deliver(deps, t, ALICE)));
  it("deliverAll", () => refusedUnderHold("a delivery", (deps) => deliverAll(deps, t, [ALICE])));
  it("deliverCommand", () => refusedUnderHold("a delivery", (deps) => deliverCommand(deps, t, [], () => undefined)));
  it("act (the core's, on the v3.2 deps)", () => refusedUnderHold("a deposit-only close", (deps) => act(deps, t, { kind: "close" })));
  it("v3.2's act: a close, a stake, a payout", async () => {
    await refusedUnderHold("a deposit-only close", (deps) => V32_ACTIONS.act(deps, t, { kind: "close" }));
    await refusedUnderHold("a stake", (deps) => V32_ACTIONS.act(deps, t, { kind: "stake" }));
    await refusedUnderHold("a payout", (deps) => V32_ACTIONS.act(deps, t, { kind: "payouts", key: KEY_A }));
  });
  it("closeV32", () => refusedUnderHold("a close carrying a redeem", (deps) => closeV32(deps, t)));
  it("stakeV32", () => refusedUnderHold("a stake", (deps) => stakeV32(deps, t)));
  it("payoutsV32", () => refusedUnderHold("a payout", (deps) => payoutsV32(deps, t, KEY_A)));
  it("rollV32", () => refusedUnderHold("a roll", (deps) => rollV32(deps, t)));
  it("runRound: nothing sent (each scene, above); and the round's own stop comes first, so the send path is never asked", async () => {
    const w = SCENES["a stake"].make();
    w.monitor.hold = ["h-1"];
    const r = await rounds(w, 1);
    expect(w.sends).toEqual([]);
    expect(r.lines.some((l) => l.includes("the rails refuse it"))).toBe(false);
  });

  it("an outage refuses the same way; a hand run's override lets the one-shot go", async () => {
    const w = SCENES["a stake"].make();
    w.monitor.down = true;
    const e = await stakeV32(depsFor(w).deps, t).catch((x: unknown) => x);
    expect((e as SendRefused).reason).toBe("rails");
    expect((e as Error).message).toMatch(/THE MONITOR CAN'T SEE/);
    w.override = { until: (w.time.base + 3_600) * 1000 };
    await stakeV32(depsFor(w).deps, t);
    expect(w.sends.map((s) => s.fn)).toEqual(["stakeIdle"]);
  });

  it("the deliveries switch refuses a one-shot delivery; okKeys a one-shot payout of a key the monitor never confirmed", async () => {
    const w = SCENES["a delivery"].make();
    w.deliveriesOn = false;
    const e = await deliver(depsFor(w).deps, t, ALICE).catch((x: unknown) => x);
    expect((e as SendRefused).reason).toBe("rails");
    expect((e as Error).message).toMatch(/USDC DELIVERY OFF: the keeper's deliveries switch is off/);
    const v = SCENES["a payout"].make();
    v.monitor.okKeys = [];
    const p = await payoutsV32(depsFor(v).deps, t, KEY_A).catch((x: unknown) => x);
    expect((p as Error).message).toMatch(/waits for the monitor to confirm it \(not in its okKeys\)/);
    expect([...w.sends, ...v.sends]).toEqual([]);
  });

  it("healthy, a one-shot reads the rails itself (the status, once) and sends", async () => {
    const w = SCENES["a delivery"].make();
    const d1 = await deliver(depsFor(w).deps, t, ALICE);
    expect(d1.delivered).toBe(true);
    expect(w.monitor.statusReads).toBe(1);
  });

  it("deliverAll on v3.2 takes a fresh veto reading for each user", async () => {
    const w = SCENES["a delivery"].make();
    const BOB = at("b0b");
    w.door.claimable[lower(BOB)] = TAO;
    w.door.prefs[lower(BOB)] = [300n * USDC, BigInt(T + 86_400), 6];
    const out = await deliverAll(depsFor(w).deps, t, [ALICE, BOB]);
    expect(out.map((x) => x.delivered)).toEqual([true, true]);
    expect(w.monitor.priceReads).toBe(2);
  });
});

describe("the founder's one exception (2026-11-08): during a ForeverMoney migration notice, a token park's conversion goes under a hold or an outage", () => {
  const PARK_MESSAGE: Hex = "0x0102";
  const PARK = { key: parkKeyOf(8453n, ADDR.frontDoor, ADDR.vault, PARK_MESSAGE), recipient: ADDR.vault, sender: ADDR.frontDoor, message: PARK_MESSAGE };
  /** A park on the world's Bittensor adapter, under the key the adapter gives it (_parkKey) */
  const parkIn = (w: World, p: { recipient: Address; sender: Address; message: Hex }, o: { amount?: bigint; converted?: boolean } = {}) => {
    w.parks[lower(parkKeyOf(8453n, p.sender, p.recipient, p.message))] = [o.amount ?? TAO, BigInt(T - 3_600), o.converted ?? false];
  };
  const NOTICE = BigInt(T + 7 * 86_400);
  /** The v3.2 target: the conversion is Task 52's real park job now (T50b's concern 2: no seams), deliverParked of the
   * token park through the one send path, tagged as the migration conversion. */
  const convTarget = (): KeeperTarget => targetV32(d);
  /** A stake and a delivery due as well, so "only the conversion" means something. The token park, from the registered
   * door to the vault, unconverted: as the park job finds it (its BatchParked, its message on Base) unless `logged` is
   * false (then only its record, parked(key), which the send path reads, and the round's job finds nothing). */
  function busyWorld(o: { logged?: boolean } = {}): World {
    const w = SCENES["a delivery"].make();
    w.vault.balance = 10n * TAO;
    if (o.logged === false) parkIn(w, PARK);
    else parkInWorld(w, PARK);
    return w;
  }

  describe("the send path lets a tagged deliverParked through only for a token park from the door to the vault (re-review A)", () => {
    /** A conversion request through the one send path, under a hold during a notice. */
    async function underHold(edit: (w: World) => void, req: (t: KeeperTarget, nonce: number) => CallRequest = (t, n) => convertParkRequest(t, PARK, n, 1_000_000n)) {
      const w = busyWorld();
      w.monitor.hold = ["h-1"];
      w.alpha.migrationReadyAt = NOTICE;
      edit(w);
      const { deps } = depsFor(w);
      const e = await keeperSend(deps, req(targetV32(d), await deps.nonce("bittensor"))).catch((x: unknown) => x);
      return { w, e };
    }
    const refused = (r: { w: World; e: unknown }, why: RegExp) => {
      expect((r.e as SendRefused).reason).toBe("rails");
      expect((r.e as Error).message).toMatch(why);
      expect(r.w.sends).toEqual([]);
    };

    it("a token park from the door to the vault goes", async () => {
      const { w, e } = await underHold(() => undefined);
      expect(e).not.toBeInstanceOf(Error);
      expect(w.sends.map((s) => s.fn)).toEqual(["deliverParked"]);
    });
    it("a native park: refused", async () => refused(await underHold((w) => parkIn(w, PARK, { converted: true })), /it is no token park's conversion: park 0x[0-9a-f]{8}… is a native or converted park/));
    it("a converted park (a token park a refused delivery converted): refused", async () =>
      refused(await underHold((w) => parkIn(w, PARK, { converted: true, amount: 3n * TAO })), /is a native or converted park/));
    it("an empty park: refused (nothing to convert, a batch delivered all the same)", async () => refused(await underHold((w) => parkIn(w, PARK, { amount: 0n })), /is empty/));
    it("no such park: refused", async () => refused(await underHold((w) => (w.parks = {})), /there is no park 0x[0-9a-f]{8}…/));
    it("a wrong recipient: refused", async () => {
      const stranger = { ...PARK, recipient: at("5e7") };
      refused(
        await underHold(
          (w) => parkIn(w, stranger),
          (t, n) => convertParkRequest(t, { ...stranger, key: parkKeyOf(8453n, stranger.sender, stranger.recipient, stranger.message) }, n, 1_000_000n),
        ),
        /its recipient 0x[0-9a-fA-F]{40} is not the vault/,
      );
    });
    it("a wrong sender (a stranger's park): refused", async () => {
      const stranger = { ...PARK, sender: at("5e7") };
      refused(
        await underHold(
          (w) => parkIn(w, stranger),
          (t, n) => convertParkRequest(t, { ...stranger, key: parkKeyOf(8453n, stranger.sender, stranger.recipient, stranger.message) }, n, 1_000_000n),
        ),
        /its sender 0x[0-9a-fA-F]{40} is not the front door/,
      );
    });
    it("a wrong target: refused", async () =>
      refused(await underHold(() => undefined, (t, n) => ({ ...convertParkRequest(t, PARK, n, 1_000_000n), to: ADDR.baseAdapter })), /it is not sent to the Bittensor adapter/));
    it("a wrong selector (another function named deliverParked): refused", async () =>
      refused(
        await underHold(() => undefined, (t, n) => ({
          ...convertParkRequest(t, PARK, n, 1_000_000n),
          abi: parseAbi(["function deliverParked(address recipient, address sender, bytes32 message)"]),
          args: [PARK.recipient, PARK.sender, `0x${"01".repeat(32)}`],
        })),
        /its selector is not deliverParked\(address,address,bytes\)'s/,
      ));
    it("parked(key) unreadable: refused", async () =>
      refused(
        await underHold((w) => {
          w.answers[`${lower(ADDR.bitAdapter)}:parked`] = () => {
            throw new Error("the node didn't answer");
          };
        }),
        /its park could not be read/,
      ));
  });

  it("under a hold during a notice: the conversion goes, and nothing else (the stake and the delivery due wait)", async () => {
    const w = busyWorld();
    w.monitor.hold = ["h-1"];
    w.alpha.migrationReadyAt = NOTICE;
    const r = await rounds(w, 2, { target: convTarget() });
    // the park job's one conversion; the park is gone after it, and the round after finds nothing more to convert
    expect(w.sends.map((s) => [s.fn, lower(s.to)])).toEqual([["deliverParked", lower(ADDR.bitAdapter)]]);
    expect(w.sends[0].args).toEqual([PARK.recipient, PARK.sender, PARK.message]);
    expect(w.parks).toEqual({});
    expect(r.lines).toContain(
      `MIGRATION NOTICE: ForeverMoney's migration is announced (migrationReadyAt ${NOTICE}): while the keeper is held, only token-park conversions go`,
    );
  });

  it("under a hold without a notice: refused (nothing sent)", async () => {
    const w = busyWorld();
    w.monitor.hold = ["h-1"];
    await rounds(w, 2, { target: convTarget() });
    expect(w.sends).toEqual([]);
  });

  it("any other action under a hold during a notice is refused, in the round and at the send path", async () => {
    const w = busyWorld({ logged: false });
    w.monitor.hold = ["h-1"];
    w.alpha.migrationReadyAt = NOTICE;
    const r = await rounds(w, 2, { target: convTarget() });
    expect(w.sends).toEqual([]);
    expect(r.lines.some((l) => l.startsWith("nothing due: the keeper is held; during ForeverMoney's migration notice only token-park conversions go"))).toBe(true);
    // one-shots: a stake, a delivery, and a deliverParked not tagged as the conversion
    const t = targetV32(d);
    for (const run of [
      (deps: KeeperDeps) => stakeV32(deps, t),
      (deps: KeeperDeps) => deliver(deps, t, ALICE),
      async (deps: KeeperDeps) => keeperSend(deps, { ...convertParkRequest(t, PARK, await deps.nonce("bittensor"), 1_000_000n), rail: undefined }),
    ]) {
      const e = await run(depsFor(w).deps).catch((x: unknown) => x);
      expect((e as SendRefused).reason).toBe("rails");
    }
    expect(w.sends).toEqual([]);
    // the tagged conversion itself, one-shot: it goes
    const { deps } = depsFor(w);
    await keeperSend(deps, convertParkRequest(t, PARK, await deps.nonce("bittensor"), 1_000_000n));
    expect(w.sends.map((s) => s.fn)).toEqual(["deliverParked"]);
  });

  it("an unreadable notice: no exception (fail closed), in the round and at the send path", async () => {
    const w = busyWorld();
    w.monitor.hold = ["h-1"];
    w.alpha.migrationReadyAt = NOTICE;
    // only the rails' notice read fails (the round's own state read still answers, so it is the rails that refuse)
    const unreadable = (deps: KeeperDeps) => {
      (deps as KeeperDepsV32).migrationNotice = async () => {
        throw new Error("the node didn't answer");
      };
    };
    const r = await rounds(w, 1, { target: convTarget(), wrap: unreadable });
    expect(w.sends).toEqual([]);
    expect(r.lines).toContain("MIGRATION NOTICE unreadable: ForeverMoney's migration notice could not be read (the node didn't answer): no exception to the hold, nothing is sent");
    // a one-shot conversion: refused too
    const { deps } = depsFor(w);
    unreadable(deps);
    const e = await keeperSend(deps, convertParkRequest(targetV32(d), PARK, await deps.nonce("bittensor"), 1_000_000n)).catch((x: unknown) => x);
    expect((e as SendRefused).reason).toBe("rails");
    expect(w.sends).toEqual([]);
  });

  it("under an outage during a notice: the conversion goes", async () => {
    const w = busyWorld();
    w.monitor.down = true;
    w.alpha.migrationReadyAt = NOTICE;
    await rounds(w, 1, { target: convTarget() });
    expect(w.sends.map((s) => s.fn)).toEqual(["deliverParked"]);
  });

  it("the spend cap: at Bittensor's cap during the notice, the conversion goes and is counted (the controller's ruling for Task 52, as a cancel passes it)", async () => {
    const w = busyWorld();
    w.monitor.hold = ["h-1"];
    w.alpha.migrationReadyAt = NOTICE;
    const journal = memoryJournal();
    journal.rows.push({
      chain: "bittensor",
      from: KEY.address,
      nonce: 1,
      hashes: [`0x${"02".repeat(32)}`],
      request: stakeRequest({ plan: { addresses: d.addresses } }, 1),
      raw: "0x",
      status: "landed",
      at: T * 1000 - 1_000,
      receipt: { hash: `0x${"02".repeat(32)}`, block: 1, gasUsed: 1n, costWei: parseEther("0.05") },
    });
    const before = spentOn(journal.rows, "bittensor", T * 1000);
    await rounds(w, 1, { target: convTarget(), journal, dep: deploymentFor({ spendCap: { base: parseEther("0.0017"), bittensor: parseEther("0.033") } }) });
    expect(w.sends.map((s) => s.fn)).toEqual(["deliverParked"]);
    expect(journal.rows.at(-1)?.request.rail).toBe("migration-conversion");
    expect(spentOn(journal.rows, "bittensor", T * 1000)).toBeGreaterThan(before);
  });

  it("R12e: a conversion the spend cap refuses at the cap (the migration executed between the round's read and the send, so it no longer passes the cap) is tried once and passed over for the rest of the round, never offered again in it (before R12e: 201 tries in one round, and counting); the notice's one close behind it, refused by its own read (the notice is over), is the round's quiet skip, as a close's", async () => {
    const run = async (canClose: boolean) => {
      const w = world();
      w.door.canClose = canClose;
      parkInWorld(w, PARK);
      w.alpha.migrationReadyAt = NOTICE;
      const journal = memoryJournal();
      journal.rows.push({
        chain: "bittensor",
        from: KEY.address,
        nonce: 1,
        hashes: [`0x${"02".repeat(32)}`],
        request: stakeRequest({ plan: { addresses: d.addresses } }, 1),
        raw: "0x",
        status: "landed",
        at: T * 1000 - 1_000,
        receipt: { hash: `0x${"02".repeat(32)}`, block: 1, gasUsed: 1n, costWei: parseEther("0.05") },
      });
      let tries = 0;
      let failing = -1;
      const r = await rounds(w, 1, {
        target: convTarget(),
        journal,
        dep: deploymentFor({ spendCap: { base: parseEther("0.0017"), bittensor: parseEther("0.033") } }),
        wrap: (deps) => {
          const nonce = deps.nonce.bind(deps);
          (deps as { nonce: typeof deps.nonce }).nonce = async (chain) => {
            if (chain === "bittensor") {
              tries++;
              // the migration executed: the conversion passes the cap no more (capExempt reads 0 from here on)
              w.alpha.migrationReadyAt = 0n;
              if (tries > 5) throw new Error(`the same conversion was tried ${tries} times inside one round`);
            }
            return nonce(chain);
          };
        },
        after: (m) => (failing = m.failing),
      });
      expect(tries).toBe(1);
      expect(w.sends).toEqual([]);
      expect(r.lines).toContainEqual(expect.stringMatching(/^SPEND CAP: .*convert and deliver token park 0x[0-9a-f]{8}… \(ForeverMoney's migration notice\) not sent: nothing more is sent on Bittensor this round/));
      expect(r.lines.filter((l) => l.startsWith("Failed this round"))).toEqual([]);
      expect(failing).toBe(0);
      return r.lines;
    };
    expect((await run(false)).filter((l) => l.startsWith("Skipped this round"))).toEqual([]);
    // the open batch able to close: the notice's one close was due behind the conversion, and its own read finds the notice over
    expect((await run(true)).filter((l) => l.startsWith("Skipped this round"))).toEqual([
      "Skipped this round (closing batch 7 once (ForeverMoney's migration notice)): ForeverMoney's migration notice is over: the close rule decides the open batch again",
    ]);
  });

  it("the replacement gate: a stuck conversion is replaced under a hold during a notice; a stuck stake is not", async () => {
    const run = async (conversion: boolean) => {
      const w = conversion ? busyWorld() : SCENES["a stake"].make();
      w.alpha.migrationReadyAt = NOTICE;
      w.fate = () => "hold";
      const first = await rounds(w, 1, conversion ? { target: convTarget() } : {});
      expect(w.sends).toHaveLength(1);
      w.monitor.hold = ["h-1"];
      const second = await rounds(w, 1, { memory: first.memory, from: T + REPLACE_AFTER_MS / 1000 + 60, ...(conversion ? { target: convTarget() } : {}) });
      return second.lines.some((l) => l.startsWith("REPLACING transaction"));
    };
    expect(await run(true)).toBe(true);
    expect(await run(false)).toBe(false);
  });

  it("railsRefusal: under a stop, only the tagged conversion while the notice runs", () => {
    const held = { stop: "HOLD: x" };
    expect(railsRefusal(held, { chain: "bittensor", conversion: true })).toBe("HOLD: x");
    expect(railsRefusal({ ...held, migrationConversions: true }, { chain: "bittensor", conversion: true })).toBeUndefined();
    expect(railsRefusal({ ...held, migrationConversions: true }, { chain: "bittensor" })).toBe("HOLD: x");
    // the spend cap: a conversion passes it while the notice runs (the controller's ruling for Task 52), counted; the
    // tag alone, without the notice read, passes nothing
    expect(railsRefusal({ ...held, migrationConversions: true, migrationNotice: true, capped: new Set(["bittensor"]) }, { chain: "bittensor", conversion: true })).toBeUndefined();
    expect(railsRefusal({ capped: new Set(["bittensor"]), migrationNotice: true }, { chain: "bittensor", conversion: true })).toBeUndefined();
    expect(railsRefusal({ capped: new Set(["bittensor"]), migrationNotice: true }, { chain: "bittensor" })).toMatch(/spend cap/);
    expect(railsRefusal({ capped: new Set(["bittensor"]) }, { chain: "bittensor", conversion: true })).toMatch(/spend cap/);
  });
});

describe("the review's Minors", () => {
  it("M3: a hold that clears under the override says the sends resume under it, not that the monitor can see", async () => {
    const w = SCENES["a stake"].make();
    w.monitor.down = true;
    w.override = { until: (T + 3_600) * 1000 };
    w.holdFile = '{"hold": true}';
    const r = await rounds(w, 2, {
      between: (i) => {
        if (i === 1) w.holdFile = undefined;
      },
    });
    expect(r.lines).toContain("Sends resume under --ignore-monitor-outage: nothing holds the keeper, but the monitor can't see");
    expect(r.lines).not.toContain("Sends resume: nothing holds the keeper, and the monitor can see");
  });

  it("M4: a send still unsettled 24 h after it was written stays in the sum until it settles", async () => {
    const raw = await KEY.signTransaction({ type: "eip1559", chainId: 8453, nonce: 1, to: ADDR.frontDoor, gas: 300_000n, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n, value: 15n * 10n ** 14n, data: "0x" });
    const now = 100 * SPEND_WINDOW_MS;
    const old: JournalRow = {
      chain: "base",
      from: KEY.address,
      nonce: 1,
      hashes: [`0x${"03".repeat(32)}`],
      request: closeRequest({ plan: { addresses: d.addresses } }, 7n, TAO, 15n * 10n ** 14n, 1),
      raw,
      status: "sent",
      at: now - SPEND_WINDOW_MS - 3_600_000,
    };
    expect(spentOn([old], "base", now)).toBe(spentOf(old));
    expect(spentOn([{ ...old, status: "landed", receipt: { hash: old.hashes[0], block: 1, gasUsed: 1n, costWei: 1n } }], "base", now)).toBe(0n);
    // the rails' cap sums it too, while it may still land (its nonce not yet passed: re-review B drops one whose is)
    const w = SCENES["a deposit-only close"].make();
    w.nonce.base = { latest: 1, pending: 2 };
    const journal = memoryJournal();
    journal.rows.push({ ...old, at: w.time.base * 1000 - SPEND_WINDOW_MS - 3_600_000 });
    const capped = deploymentFor({ spendCap: { base: parseEther("0.0017"), bittensor: parseEther("0.033") } });
    const m = freshMemory();
    const rails = await railsV32(depsFor(w, m, capped, () => undefined, { journal }).deps, m, w.time.base * 1000);
    expect(rails.capped?.has("base")).toBe(true);
    expect(journal.rows[0].status).toBe("sent");
  });
});

describe("a send that can no longer land leaves the spend cap (re-review B)", () => {
  const capped = deploymentFor({ spendCap: { base: parseEther("0.0017"), bittensor: parseEther("0.033") } });
  /** A close written ahead and broadcast at nonce 3 (worst case 0.0021 ETH, over Base's cap), with no receipt. */
  async function stuckClose(o: { hashes?: Hex[] } = {}): Promise<JournalRow> {
    const raw = await KEY.signTransaction({ type: "eip1559", chainId: 8453, nonce: 3, to: ADDR.frontDoor, gas: 300_000n, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n, value: 15n * 10n ** 14n, data: "0x" });
    return {
      chain: "base",
      from: KEY.address,
      nonce: 3,
      hashes: o.hashes ?? [`0x${"04".repeat(32)}`],
      request: closeRequest({ plan: { addresses: d.addresses } }, 7n, TAO, 15n * 10n ** 14n, 3),
      raw,
      status: "sent",
      at: T * 1000 - 60_000,
    };
  }
  const railsOf = async (w: World, journal: ReturnType<typeof memoryJournal>, lines: string[] = []) => {
    const m = freshMemory();
    return railsV32(depsFor(w, m, capped, (l) => lines.push(l), { journal }).deps, m, T * 1000);
  };

  it("a stuck send whose nonce the wallet has passed, with no receipt: marked dropped, it counts 0, said once", async () => {
    const w = SCENES["a deposit-only close"].make();
    w.nonce.base = { latest: 4, pending: 4 };
    const journal = memoryJournal();
    journal.rows.push(await stuckClose());
    const lines: string[] = [];
    // two readings a block apart, as the round's own watch (T50a round-2 R2-1)
    await railsOf(w, journal, lines);
    w.head.base += 1n;
    const r = await railsOf(w, journal, lines);
    expect(journal.rows[0].status).toBe("dropped");
    expect(spentOf(journal.rows[0])).toBe(0n);
    expect(r.capped?.has("base")).toBe(false);
    expect(lines.filter((l) => l.startsWith("DROPPED: "))).toEqual([
      `DROPPED: transaction 0x${"04".repeat(32)} (close batch 7 and send it to Bittensor, nonce 3 on Base): the wallet's mined nonce is past it and it has no receipt, so it can no longer land; it no longer counts toward the spend cap`,
    ]);
  });

  it("one still pending (its nonce not yet passed) still counts at its worst case", async () => {
    const w = SCENES["a deposit-only close"].make();
    w.nonce.base = { latest: 3, pending: 4 };
    const journal = memoryJournal();
    journal.rows.push(await stuckClose());
    const r = await railsOf(w, journal);
    expect(journal.rows[0].status).toBe("sent");
    expect(r.capped?.has("base")).toBe(true);
  });

  it("a replaced send counts only the replacement that landed (its receipt's cost, not the worst case)", async () => {
    const w = SCENES["a deposit-only close"].make();
    w.nonce.base = { latest: 4, pending: 4 };
    const replacement: Hex = `0x${"05".repeat(32)}`;
    w.receipts[replacement] = { status: "0x1", logs: [] };
    const journal = memoryJournal();
    journal.rows.push(await stuckClose({ hashes: [`0x${"04".repeat(32)}`, replacement] }));
    await railsOf(w, journal);
    const row = journal.rows[0];
    expect(row.status).toBe("landed");
    expect(row.receipt?.hash).toBe(replacement);
    // the world's receipt: 200,000 gas at 1 gwei, plus the close's float (no BatchClosed in it, so none came back)
    expect(spentOf(row)).toBe(200_000n * 10n ** 9n + 15n * 10n ** 14n);
  });

  it("the send path's cap settles first too: a dropped send no longer blocks a one-shot close", async () => {
    const w = SCENES["a deposit-only close"].make();
    w.nonce.base = { latest: 4, pending: 4 };
    const journal = memoryJournal();
    journal.rows.push(await stuckClose());
    // the first reading (the rails'), then the send path's own a block later: the second drops it
    await railsOf(w, journal);
    w.head.base += 1n;
    await closeV32(depsFor(w, freshMemory(), capped, () => undefined, { journal }).deps, targetV32(capped));
    expect(w.sends.map((s) => s.fn)).toEqual(["closeBatch"]);
  });

  it("R2-1: one reading never drops a row: the nonce past with no receipt at two readings a block apart, in a row, as the round's own watch", async () => {
    const w = SCENES["a deposit-only close"].make();
    w.nonce.base = { latest: 4, pending: 4 };
    const journal = memoryJournal();
    journal.rows.push(await stuckClose());
    const lines: string[] = [];
    // a null receipt (a lagging, load-balanced or pruned node) with the nonce past: still counted, at its worst case
    expect((await railsOf(w, journal, lines)).capped?.has("base")).toBe(true);
    expect(journal.rows[0].status).toBe("sent");
    // a second reading at the same block: still not dropped (the two must be a block apart)
    await railsOf(w, journal, lines);
    expect(journal.rows[0].status).toBe("sent");
    // a reading between that sees the nonce not past (a node behind) starts the count again
    w.head.base += 1n;
    w.nonce.base = { latest: 3, pending: 4 };
    await railsOf(w, journal, lines);
    w.head.base += 1n;
    w.nonce.base = { latest: 4, pending: 4 };
    await railsOf(w, journal, lines);
    expect(journal.rows[0].status).toBe("sent");
    expect(lines.filter((l) => l.startsWith("DROPPED: "))).toEqual([]);
    // the second reading in a row, a block on: dropped, said once
    w.head.base += 1n;
    const r = await railsOf(w, journal, lines);
    expect(journal.rows[0].status).toBe("dropped");
    expect(r.capped?.has("base")).toBe(false);
    expect(lines.filter((l) => l.startsWith("DROPPED: "))).toHaveLength(1);
  });

  it("R2-1: a receipt found later turns a dropped row into a landed one at its actual cost (at the settling, and at the round's late receipt)", async () => {
    const hash: Hex = `0x${"04".repeat(32)}`;
    const dropped = async () => {
      const w = SCENES["a deposit-only close"].make();
      w.nonce.base = { latest: 4, pending: 4 };
      const journal = memoryJournal();
      journal.rows.push(await stuckClose());
      await railsOf(w, journal);
      w.head.base += 1n;
      await railsOf(w, journal);
      expect(journal.rows[0].status).toBe("dropped");
      // the node that answered null had not seen it: it landed
      w.receipts[hash] = { status: "0x1", logs: [] };
      return { w, journal };
    };
    // the next settling rechecks the window's dropped rows
    const a = await dropped();
    expect((await railsOf(a.w, a.journal)).capped?.has("base")).toBe(true);
    expect(a.journal.rows[0]).toMatchObject({ status: "landed", receipt: { hash, gasUsed: 200_000n } });
    // the world's receipt: 200,000 gas at 1 gwei, plus the close's float (no BatchClosed in it, so none came back)
    expect(spentOf(a.journal.rows[0])).toBe(200_000n * 10n ** 9n + 15n * 10n ** 14n);
    // the round's late receipt (deps.receipt) settles it too
    const b = await dropped();
    await depsFor(b.w, freshMemory(), capped, () => undefined, { journal: b.journal }).deps.receipt?.("base", hash);
    expect(b.journal.rows[0]).toMatchObject({ status: "landed", receipt: { hash } });
    // one still without a receipt stays dropped
    const c = await dropped();
    delete c.w.receipts[hash];
    await railsOf(c.w, c.journal);
    expect(c.journal.rows[0].status).toBe("dropped");
  });
});

describe("Task 50a's round-2 Minors", () => {
  it("R2-2: the exception's park check needs the request on Bittensor: a tagged deliverParked on Base, to the adapter's address there, is refused", async () => {
    const w = SCENES["a delivery"].make();
    w.vault.balance = 10n * TAO;
    w.monitor.hold = ["h-1"];
    w.alpha.migrationReadyAt = BigInt(T + 7 * 86_400);
    const message: Hex = "0x0102";
    const park = { key: parkKeyOf(8453n, ADDR.frontDoor, ADDR.vault, message), recipient: ADDR.vault, sender: ADDR.frontDoor, message };
    // the token park itself is real, on Bittensor's adapter
    w.parks[lower(park.key)] = [TAO, BigInt(T - 3_600), false];
    const { deps } = depsFor(w);
    const req = { ...convertParkRequest(targetV32(d), park, await deps.nonce("base"), 1_000_000n), chain: "base" as const };
    const e = await keeperSend(deps, req).catch((x: unknown) => x);
    expect((e as SendRefused).reason).toBe("rails");
    expect((e as Error).message).toMatch(/it is no token park's conversion: it is not sent on Bittensor/);
    expect(w.sends).toEqual([]);
  });

  it("R2-3: requireReady's deps are required: the v3.2 target refuses a call that gives none", () => {
    const t = targetV32(d);
    const { deps } = depsFor(world());
    expect(() => t.requireReady(KEY.address, deps)).not.toThrow();
    expect(() => t.requireReady(KEY.address, undefined as unknown as KeeperDeps)).toThrow(KeeperNotReady);
  });
});

describe("the rails are structural (re-review Minor 1)", () => {
  it("a v3.2 target refuses deps that aren't depsV32's at every generic entry point (a mis-wiring never sends without the rails)", async () => {
    const w = SCENES["a deposit-only close"].make();
    const { deps } = depsFor(w);
    const { railsSeen: _, ...notV32 } = deps;
    const t = targetV32(d);
    for (const run of [() => act(notV32 as KeeperDeps, t, { kind: "close" }), () => deliver(notV32 as KeeperDeps, t, ALICE), () => deliverAll(notV32 as KeeperDeps, t, [ALICE])]) {
      const e = await run().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(KeeperNotReady);
      expect((e as Error).message).toMatch(/a v3\.2 target needs the v3\.2 deps \(depsV32\), whose sends pass the rails; nothing sent/);
    }
    expect(w.sends).toEqual([]);
    // its own deps pass
    expect(() => t.requireReady(KEY.address, deps)).not.toThrow();
  });
});
