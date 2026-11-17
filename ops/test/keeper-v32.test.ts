import { readFileSync } from "node:fs";
import { type AbiEvent, type AbiFunction, type Address, decodeAbiParameters, encodeAbiParameters, encodeEventTopics, getAddress, type Hex, parseAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { CADENCE } from "../src/config.ts";
import { KEEPER_CALLS_V32, VAULT_ABI_V32 } from "../src/keeper/core/abi.ts";
import { encodeMemory, freshMemory, type KeeperMemory, loadMemory } from "../src/keeper/core/memory.ts";
import { decideNext, type State } from "../src/keeper/core/due.ts";
import { SendRefused } from "../src/keeper/core/errors.ts";
import { classifyFailure, FinalRefusal, KeeperBug, NotNow, Waits } from "../src/keeper/core/failures.ts";
import { type Payout, type PayoutLog, payoutsHash, rebuildPayouts } from "../src/keeper/core/payouts.ts";
import { runRound } from "../src/keeper/core/round.ts";
import { isEvmHalt, RpcError } from "../src/keeper/core/rpc.ts";
import { doorLimitsFull, fullCloseFloor, listHalf, RAIL_VIEW_CALL_GAS, RAIL_VIEW_GAS } from "../src/keeper/core/v32/reads.ts";
import { closeV32, payoutsV32, rollV32, stakeV32, targetV32 } from "../src/keeper/core/v32/actions.ts";
import { closeByHand } from "../src/keeper/core/v32/hand.ts";
import { depositOutlook, HALF_LAUNCH_SHARES_PER_WEI, UNDERWATER_TOLERANCE_WEI, underwater } from "../src/keeper/core/v32/bounce.ts";
import { deductFee, EXIT_GAS_RESERVE, encodePayouts, feeSplit, MAX_ENTRIES, planPayout, SHORTFALL_TOLERANCE_WEI, takeChunk, type PayoutInputs } from "../src/keeper/core/v32/payout.ts";
import { closeRequest, payoutsRequest } from "../src/keeper/core/v32/requests.ts";
import { classifyRevert, REVERTS_V32 } from "../src/keeper/core/v32/reverts.ts";
import { batchMaxWaitOf, payoutTopUpMax, usdcDeliveryOf, webEntry } from "../src/keeper/deployment-v32.ts";
import { ADDR, type Batch, deploymentFor, depsFor, KEY, RAO, revertWith, T, TAO, type World, world } from "./keeper-v32-world.ts";

// Task 50 on the v3.2 core: closes by id, payouts with a top-up only within the operator's limit, the carried rebuild,
// each new revert as the plan classifies it, the bounce outlook, the max wait the web reads. On fake chains (no
// network, no real key).

const src = (path: string) => readFileSync(new URL(`../../contracts/src/${path}`, import.meta.url), "utf8");
const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);
const KEY_A: Hex = `0x${"ab".repeat(32)}`;
const ALICE = at("a11c");
const BOB = at("b0b");
const CAROL = at("ca401");
const DAN = at("da9");
const ERIN = at("e417");
const d = deploymentFor();
const target = targetV32(d);
const OPTS = { intervalMs: 60_000, policy: { claimCostTao: 57n * 10n ** 15n, claimMultiple: 25n, monthlyClaimMaxUsd: 20 }, rewardsEveryTicks: 1000 };
/** The world's door's minDeposit: a close by the fee rule names the total less one (R12g, reads.ts feeCloseFloor) */
const MIN_DEPOSIT = 4n * 10n ** 16n;
/** The staker's deposit of `amount` into batch 7 (its DepositRequested, the staker the payer, a few blocks back): a deposit
 * fee and the swap fee on it (about $1.25 for 2 TAO) against the world's $0.30 bridge fee, so the fee rule closes the batch
 * with its pot empty, short of the quote (R12h: a pot covering the quote names 0) */
const stakedInto = (w: World, amount = 2n * TAO) =>
  w.logs.push({ chain: "base", address: ADDR.frontDoor, event: "DepositRequested", args: { batchId: 7n, user: at("de01"), amount, payer: ADDR.staker }, block: 9_990n });

/** A payout chunk's PayoutChunkSent in the vault's receipt (KEY_A's first chunk, one entry of 1 TAO gross, no walk), as the
 * published vault ABI encodes it: what the entries were charged, the fee, and the net sent. */
function chunkSentLog(o: { fee: bigint; charged: bigint; net: bigint }): { address: Address; topics: Hex[]; data: Hex } {
  const ev = VAULT_ABI_V32.find((x): x is AbiEvent => x.type === "event" && x.name === "PayoutChunkSent") as AbiEvent;
  return {
    address: ADDR.vault,
    topics: encodeEventTopics({ abi: [ev], eventName: "PayoutChunkSent", args: { key: KEY_A } } as never) as Hex[],
    data: encodeAbiParameters(parseAbiParameters("uint32, uint32, uint256, uint256, uint256, uint256, uint256"), [0, 1, TAO, o.net, o.fee, o.charged, 0n]),
  };
}

/** A payout batch queued in the world, with its list's logs: bounces then redeems, in log order, and its queue. */
function queue(w: World, key: Hex, list: Payout[], o: { cursor?: number; block?: bigint; queuedAt?: bigint } = {}): Batch {
  const block = o.block ?? 5_000n;
  list.forEach((p, i) =>
    w.logs.push(
      p.shares === 0n
        ? { chain: "bittensor", address: ADDR.vault, event: "DepositBounced", args: { key, user: p.user, assets: p.assets, reason: 0 }, block: block + BigInt(i) }
        : { chain: "bittensor", address: ADDR.vault, event: "Redeemed", args: { key, user: p.user, shares: p.shares, assets: p.assets }, block: block + BigInt(i) },
    ),
  );
  const total = list.reduce((t, p) => t + p.assets, 0n);
  w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "PayoutBatchQueued", args: { key, sourceChain: 8453n, batchId: 7n, count: list.length, total, price: 10n ** 12n }, block: block + 50n });
  const cursor = o.cursor ?? 0;
  const b: Batch = {
    sourceChain: 8453n,
    frontDoor: ADDR.frontDoor,
    batchId: 7n,
    queuedAt: o.queuedAt ?? BigInt(T - 2 * 86_400),
    cursor,
    count: list.length,
    chunk: 0,
    remaining: list.slice(cursor).reduce((t, p) => t + p.assets, 0n),
    payoutsHash: payoutsHash(list),
  };
  w.vault.batches[key.toLowerCase()] = b;
  w.vault.pending += b.remaining;
  return b;
}

const bounce = (user: Address, assets: bigint): Payout => ({ user, shares: 0n, assets });
const redeem = (user: Address, shares: bigint, assets: bigint): Payout => ({ user, shares, assets });

describe("close by id (spec §3.5)", () => {
  it("closePassesTheReadIdAndValue: closeBatch(the open batch's id, the deposits read) with the fee float; a paused door's batch closes all the same (Task 58 c4)", async () => {
    for (const paused of [false, true]) {
      const w = world();
      w.door.paused = paused;
      // its pot covering the bridge fee, so the close rule closes it on the close's own read too (R12d, L-1); by the fee
      // rule with the pot covering its quote, so its minValue is 0 (R12h; the total less one minimum deposit when the pot
      // is short: the R12g test below)
      w.door.feePot = 2n * w.door.closeFee;
      const { deps } = depsFor(w);
      const done = await closeV32(deps, target);
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]).toMatchObject({ chain: "base", to: ADDR.frontDoor, fn: "closeBatch", args: [7n, 0n], value: 15n * 10n ** 14n });
      expect(done.hash).toBe(w.sends[0].hash);
    }
    // the request itself: the id and the value as read, never the next batch's
    expect(closeRequest({ plan: { addresses: d.addresses } }, 9n, 3n * TAO, 4n * 10n ** 14n, 3)).toMatchObject({ functionName: "closeBatch", args: [9n, 3n * TAO], value: 4n * 10n ** 14n, nonce: 3 });
    // R12a: with its quote, what the spend cap's check counts of the float (the door sends back the rest)
    expect(closeRequest({ plan: { addresses: d.addresses } }, 9n, 3n * TAO, 15n * 10n ** 14n, 3, 10n ** 14n)).toMatchObject({ value: 15n * 10n ** 14n, valueKept: 10n ** 14n });
    expect(closeRequest({ plan: { addresses: d.addresses } }, 9n, 3n * TAO, 15n * 10n ** 14n, 3)).not.toHaveProperty("valueKept");
  });

  it("WrongBatch or BatchTooSmall in the simulation: the batch is read again once and sent with what it reads; a second refusal waits", async () => {
    // a deposit cancelled since the read: BatchTooSmall, then the batch with its new total (the staker's deposit fees
    // covering the bridge fee, so the close rule still closes it; R12c: a close at the max wait names 0, so this is the fee
    // rule's, and its pot short of the quote: R12h names 0 when the pot covers it)
    const w = world();
    stakedInto(w);
    let first = true;
    w.simulate = (c) => {
      if (c.fn !== "closeBatch") return 200_000n;
      if (first) {
        first = false;
        w.door.totalDeposits = TAO;
        w.door.deposits = [{ user: ALICE, amount: TAO }];
        return { error: "BatchTooSmall" };
      }
      return 200_000n;
    };
    const lines: string[] = [];
    const { deps } = depsFor(w, freshMemory(), d, (l) => lines.push(l));
    await closeV32(deps, target);
    // the re-read's total (1 TAO) less one minimum deposit: the fee rule's floor (R12g)
    expect(w.sends.map((s) => s.args)).toEqual([[7n, TAO - MIN_DEPOSIT]]);
    expect(lines).toContain("Not closed yet: the open batch holds less than when it was read (a deposit was cancelled) (BatchTooSmall); reading the open batch again");

    // another close landed first, twice: it waits for the next round
    const v = world();
    v.simulate = (c) => (c.fn === "closeBatch" ? { error: "WrongBatch", args: [8n] } : 200_000n);
    const e = await closeV32(depsFor(v).deps, target).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Waits);
    expect(classifyFailure(e)).toMatchObject({ stop: false, kind: "waits" });
    expect(v.sends).toEqual([]);
  });

  it("the re-read decides again by the close rule: a full batch a cancelled deposit left not full, within its max wait and its fees short of the bridge fee, waits (T50 review M1)", async () => {
    const w = world();
    // build B: 2 of 4 is the list's half (closable at once), 1 of 4 under it
    w.door.maxDeposits = 4;
    w.door.deposits = [
      { user: ALICE, amount: TAO },
      { user: BOB, amount: TAO },
    ];
    w.simulate = (c) => {
      if (c.fn !== "closeBatch") return 200_000n;
      w.door.deposits = [{ user: ALICE, amount: TAO }];
      w.door.totalDeposits = TAO;
      return { error: "BatchTooSmall" };
    };
    const e = await closeV32(depsFor(w).deps, target).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Waits);
    expect((e as Error).message).toMatch(/^batch 7 changed under the close \(BatchTooSmall\), and now the keeper holds it: it waits until .* or until its fees cover the bridge fee \(\$0\.00 of \$0\.30\); the next round decides again$/);
    expect(w.sends).toEqual([]);
  });

  /** R12b (the cooldown review): a world whose closeBatch simulation lets a holder cancel `cancel` wei from an aged entry
   * first (a partial cancel moves no clock), every time, then holds the close to its minValue as the door does
   * (BatchTooSmall below it); `still` says whether the door then still lets it close (canClose()). */
  const cancelsUnderTheClose = (w: World, cancel: bigint, still: (w: World) => boolean = () => true) => {
    w.simulate = (c) => {
      if (c.fn !== "closeBatch") return 200_000n;
      w.door.totalDeposits -= cancel;
      w.door.deposits = [{ ...w.door.deposits[0], amount: w.door.deposits[0].amount - cancel }, ...w.door.deposits.slice(1)];
      w.door.canClose = still(w);
      if (!w.door.canClose) return { error: "BatchNotReady" };
      return w.door.totalDeposits < (c.args[1] as bigint) ? { error: "BatchTooSmall" } : 200_000n;
    };
  };
  const roundOf = async (w: World) => {
    const m = freshMemory();
    await runRound(depsFor(w, m).deps, target, m, { ...OPTS, now: () => T * 1000 });
    return w.sends.map((s) => [s.fn, s.args]);
  };

  it("R12b: an aged entry's 1-rao cancel between the keeper's read and its send no longer voids a full batch's close: the least total still full, before its interval as after it (R12d)", async () => {
    // before its interval, full by value (6 of the 10 TAO limit, an aged entry): the least total still at half the limit,
    // 5 TAO, as after it (R12d, L-1: before it named 0, trusting canClose(), but a close read before the interval can land
    // after it, closable by time, where only minValue guards the line)
    const before = world();
    before.door.start = BigInt(T - 600);
    before.door.totalDeposits = 6n * TAO;
    before.door.deposits = [{ user: ALICE, amount: 6n * TAO }];
    cancelsUnderTheClose(before, RAO);
    expect(await roundOf(before)).toEqual([["closeBatch", [7n, 5n * TAO]]]);
    // past its interval (closable by time) and full by value: the least total still at half the limit, 5 TAO
    const after = world();
    after.door.totalDeposits = 6n * TAO;
    after.door.deposits = [{ user: ALICE, amount: 6n * TAO }];
    cancelsUnderTheClose(after, RAO);
    expect(await roundOf(after)).toEqual([["closeBatch", [7n, 5n * TAO]]]);
    // a cancel there that takes it under half: refused (BatchTooSmall), read again, no longer full, its fees short: held
    const under = world();
    under.door.totalDeposits = 6n * TAO;
    under.door.deposits = [{ user: ALICE, amount: 6n * TAO }];
    cancelsUnderTheClose(under, TAO + RAO);
    expect(await roundOf(under)).toEqual([]);
    // full by its list past the interval: the least its entries carry, listHalf(1) × the 0.04 TAO minimum, so a partial
    // cancel keeps it full (R12d, L-1: before it named 0, so a list cancelled down to one entry went as full)
    const list = world();
    list.door.maxDeposits = 1;
    cancelsUnderTheClose(list, RAO);
    expect(await roundOf(list)).toEqual([["closeBatch", [7n, 4n * 10n ** 16n]]]);
    // full past its max wait too: R12c, minValue 0 there, whatever the batch (the close goes whatever its fees or size)
    const late = world();
    late.door.start = BigInt(T - 90_000);
    late.door.totalDeposits = 6n * TAO;
    late.door.deposits = [{ user: ALICE, amount: 6n * TAO }];
    cancelsUnderTheClose(late, RAO);
    expect(await roundOf(late)).toEqual([["closeBatch", [7n, 0n]]]);
  });

  it("R12c: at its max wait a batch not full closes with minValue 0, so an aged entry's 1-rao cancel before each send can't hold its deposits on Base past the max wait; the hand close too (pnpm ops close)", async () => {
    // 2 TAO, far under every line, a day and an hour old: a rao cancelled under every simulation, as a holder would
    const late = () => {
      const w = world();
      w.door.start = BigInt(T - 90_000);
      cancelsUnderTheClose(w, RAO);
      return w;
    };
    const round = late();
    expect(await roundOf(round)).toEqual([["closeBatch", [7n, 0n]]]);
    // round after round: the same holder can't void it at the next one either
    const again = late();
    expect(await roundOf(again)).toEqual([["closeBatch", [7n, 0n]]]);
    // the hand close (no migration notice: closeV32) at the max wait: 0 too
    const hand = late();
    await closeByHand(depsFor(hand).deps, target);
    expect(hand.sends.map((s) => [s.fn, s.args])).toEqual([["closeBatch", [7n, 0n]]]);
    // the hand close before the max wait of a batch not full, its fees short: the fee rule's floor, the total it read less
    // one minimum deposit (R12g; before it the exact total; pnpm ops close is the operator's own call there)
    const early = world();
    await closeByHand(depsFor(early).deps, target);
    expect(early.sends.map((s) => [s.fn, s.args])).toEqual([["closeBatch", [7n, 2n * TAO - MIN_DEPOSIT]]]);
  });

  it("R12g (before it R12b's exact total): a close by the fee rule before the max wait names the total it read less one minimum deposit: a cancel refunds none of the fees the rule weighed, so a 1-rao cancel under it no longer voids it, while a cancel-down of more than a minimum deposit still does", async () => {
    // past its interval, not full, the staker's deposit fees covering the bridge fee (its pot empty, short of the quote):
    // the fee rule closes it, 2 TAO read less 0.04 TAO
    const fees = world();
    stakedInto(fees);
    expect(await roundOf(fees)).toEqual([["closeBatch", [7n, 2n * TAO - MIN_DEPOSIT]]]);
    // R12h: its pot covering the quote instead (the close keeps none of its float): 0, whatever a cancel leaves
    const pot = world();
    pot.door.feePot = 2n * pot.door.closeFee;
    expect(await roundOf(pot)).toEqual([["closeBatch", [7n, 0n]]]);
    // a cancel under it: `amount` off the aged entry before the first simulation, then the door holds the close to its
    // minValue
    const cancelledBy = (amount: bigint) => {
      const w = world();
      stakedInto(w);
      let once = true;
      w.simulate = (c) => {
        if (c.fn !== "closeBatch") return 200_000n;
        if (once) {
          once = false;
          w.door.totalDeposits -= amount;
          w.door.deposits = [{ ...w.door.deposits[0], amount: w.door.totalDeposits }];
        }
        return w.door.totalDeposits < (c.args[1] as bigint) ? { error: "BatchTooSmall" } : 200_000n;
      };
      return w;
    };
    // a rao, or a whole minimum deposit: it goes as it was sent, at its floor (before R12g a rao refused it each time)
    expect(await roundOf(cancelledBy(RAO))).toEqual([["closeBatch", [7n, 2n * TAO - MIN_DEPOSIT]]]);
    expect(await roundOf(cancelledBy(MIN_DEPOSIT))).toEqual([["closeBatch", [7n, 2n * TAO - MIN_DEPOSIT]]]);
    // a rao more than that: refused (BatchTooSmall), read again, the fee rule still closes what is left at its own floor
    expect(await roundOf(cancelledBy(MIN_DEPOSIT + RAO))).toEqual([["closeBatch", [7n, 2n * TAO - 2n * MIN_DEPOSIT - RAO]]]);
    // at its max wait, not full: R12c, 0 (the close goes whatever its fees there)
    const wait = world();
    wait.door.start = BigInt(T - 90_000);
    expect(await roundOf(wait)).toEqual([["closeBatch", [7n, 0n]]]);
  });

  describe("R12d (L-1): a cancel-down can't turn a full close into a small one the keeper pays for", () => {
    const MIN = 4n * 10n ** 16n;
    const addr = (i: number) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address;
    /** `n` deposits of `amount` each, the batch past its interval (T - 4,000) unless `start` */
    const listOf = (n: number, amount: bigint, start?: bigint) => {
      const w = world();
      w.door.deposits = Array.from({ length: n }, (_, i) => ({ user: addr(i), amount }));
      w.door.totalDeposits = BigInt(n) * amount;
      if (start !== undefined) w.door.start = start;
      return w;
    };
    /** Under every closeBatch simulation `change` runs first (the holder's cancels landing ahead of the close), then the door
     * holds the close to its minValue (BatchTooSmall below it) */
    const underTheClose = (w: World, change: () => void) => {
      w.simulate = (c) => {
        if (c.fn !== "closeBatch") return 200_000n;
        change();
        return w.door.totalDeposits < (c.args[1] as bigint) ? { error: "BatchTooSmall" } : 200_000n;
      };
    };

    it("a list at half (25 × 0.04 TAO), 24 aged entries cancelled in full under the close: its floor, the least 25 entries carry (1 TAO), voids it, and the one entry left is held for its fees; a rao off an entry above the minimum doesn't void it", async () => {
      const w = listOf(25, MIN);
      underTheClose(w, () => {
        w.door.deposits = [w.door.deposits[24]];
        w.door.totalDeposits = MIN;
      });
      const lines: string[] = [];
      const m = freshMemory();
      await runRound(depsFor(w, m, d, (l) => lines.push(l)).deps, target, m, { ...OPTS, now: () => T * 1000 });
      // before R12d: closeBatch(7, 0), a one-entry 0.04 TAO batch closed as full, its bridge fee the keeper's
      expect(w.sends).toEqual([]);
      expect(lines).toContain("Not closed yet: the open batch holds less than when it was read (a deposit was cancelled) (BatchTooSmall); reading the open batch again");
      // R12e: the round's quiet skip, never a failed round
      expect(lines).toContainEqual(expect.stringMatching(/^Skipped this round \(closing the batch\): batch 7 changed under the close \(BatchTooSmall\), and now the keeper holds it: it waits until /));
      expect(lines.filter((l) => l.startsWith("Failed this round"))).toEqual([]);
      expect(m.failing).toBe(0);
      // entries above the minimum, a rao cancelled under the close: still 25 entries, still full: it goes at its floor
      const rao = listOf(25, 2n * MIN);
      underTheClose(rao, () => {
        rao.door.deposits = [{ ...rao.door.deposits[0], amount: rao.door.deposits[0].amount - RAO }, ...rao.door.deposits.slice(1)];
        rao.door.totalDeposits -= RAO;
      });
      expect(await roundOf(rao)).toEqual([["closeBatch", [7n, TAO]]]);
    });

    it("read just before the interval ends, full by value (4.96 TAO aged and 0.04 fresh), the aged entry cancelled down and the send landing after the interval: the floor (5 TAO) voids it, and the two small entries are held for their fees", async () => {
      const w = world();
      w.door.start = BigInt(T - 3_590);
      w.door.deposits = [
        { user: addr(1), amount: 496n * 10n ** 16n },
        { user: addr(2), amount: MIN },
      ];
      w.door.totalDeposits = 5n * TAO;
      underTheClose(w, () => {
        w.door.deposits = [{ user: addr(1), amount: MIN }, w.door.deposits[1]];
        w.door.totalDeposits = 2n * MIN;
        // the send lands after the interval: canClose() is true by time, and only minValue guards the line
        w.time.base = T + 20;
        w.door.canClose = true;
      });
      // before R12d: closeBatch(7, 0) read before the interval, a 0.08 TAO batch closed at the keeper's cost
      expect(await roundOf(w)).toEqual([]);
      // the control, read after the interval: the same floor, the same wait
      const after = world();
      after.door.deposits = [
        { user: addr(1), amount: 496n * 10n ** 16n },
        { user: addr(2), amount: MIN },
      ];
      after.door.totalDeposits = 5n * TAO;
      underTheClose(after, () => {
        after.door.deposits = [{ user: addr(1), amount: MIN }, after.door.deposits[1]];
        after.door.totalDeposits = 2n * MIN;
      });
      expect(await roundOf(after)).toEqual([]);
    });

    it("the close rule decides on the close's own read too: full by value at the round's read (5 TAO), cancelled down to 0.08 TAO by the close's own read, it is held for its fees, nothing sent; a batch still full there goes", async () => {
      const gap = () => {
        const w = world();
        w.door.deposits = [
          { user: addr(1), amount: 496n * 10n ** 16n },
          { user: addr(2), amount: MIN },
        ];
        w.door.totalDeposits = 5n * TAO;
        return w;
      };
      const w = gap();
      const m = freshMemory();
      const lines: string[] = [];
      const { deps } = depsFor(w, m, d, (l) => lines.push(l));
      const read = deps.readState.bind(deps);
      let n = 0;
      // the second read is the close's own: the aged entry cancelled down before it
      (deps as { readState: typeof deps.readState }).readState = async (o) => {
        if (++n === 2) {
          w.door.deposits = [{ user: addr(1), amount: MIN }, w.door.deposits[1]];
          w.door.totalDeposits = 2n * MIN;
        }
        return read(o);
      };
      await runRound(deps, target, m, { ...OPTS, now: () => T * 1000 });
      // before R12d: closeBatch(7, 0.08 TAO), the close rule asked only of a re-read after a refusal
      expect(w.sends).toEqual([]);
      // R12e: the round's quiet skip, never a failed round
      expect(lines).toContainEqual(expect.stringMatching(/^Skipped this round \(closing the batch\): batch 7 changed since the round read it, and now the keeper holds it: it waits until .* or until its fees cover the bridge fee/));
      expect(lines.filter((l) => l.startsWith("Failed this round"))).toEqual([]);
      expect(m.failing).toBe(0);
      // the same batch untouched: it goes, at its floor
      expect(await roundOf(gap())).toEqual([["closeBatch", [7n, 5n * TAO]]]);
    });

    it("the hand close (pnpm ops close) names the same floors: a list at half its least its entries carry, a batch full by value before its interval its line; the close rule doesn't hold its first read (the operator's call)", async () => {
      const list = listOf(25, 2n * MIN);
      await closeByHand(depsFor(list).deps, target);
      expect(list.sends.map((s) => [s.fn, s.args])).toEqual([["closeBatch", [7n, TAO]]]);
      const value = world();
      value.door.start = BigInt(T - 600);
      value.door.totalDeposits = 6n * TAO;
      value.door.deposits = [{ user: ALICE, amount: 6n * TAO }];
      await closeByHand(depsFor(value).deps, target);
      expect(value.sends.map((s) => [s.fn, s.args])).toEqual([["closeBatch", [7n, 5n * TAO]]]);
      // the round's close of a batch the rule holds is refused at its own read (Waits); the hand close sends it
      const held = world();
      const e = await closeV32(depsFor(held).deps, target).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Waits);
      expect(held.sends).toEqual([]);
      await closeByHand(depsFor(held).deps, target);
      // not full, before its max wait: the fee rule's floor, the total read less one minimum deposit (R12g)
      expect(held.sends.map((s) => [s.fn, s.args])).toEqual([["closeBatch", [7n, 2n * TAO - MIN_DEPOSIT]]]);
    });
  });

  describe("R12e: a close its own reads refuse, nothing sent, is that round's quiet skip: no failed round, no breaker count, tried again next round", () => {
    type KeeperDepsOf = ReturnType<typeof depsFor>["deps"];
    const AGED = at("a11ce");
    const FRESH = at("f1e5");
    /** The open batch as two entries: an aged one and a fresh one */
    const set = (w: World, aged: bigint, fresh: bigint) => {
      w.door.deposits = [
        { user: AGED, amount: aged },
        { user: FRESH, amount: fresh },
      ];
      w.door.totalDeposits = aged + fresh;
    };
    type Round = { lines: string[]; failing: number; waitMs: number; refusals: unknown };
    /** `n` rounds a minute apart, the memory through JSON between them; `before(i, w)` sets the batch the round reads, and
     * `under(i, w, deps)` may change the chain under the round's close */
    async function rounds(w: World, n: number, o: { before: (i: number) => void; under?: (i: number, deps: KeeperDepsOf) => void; rewardsEveryTicks?: number }) {
      const out: Round[] = [];
      let saved = encodeMemory(freshMemory());
      for (let i = 0; i < n; i++) {
        const memory = loadMemory(saved).memory;
        w.time.base = T + i * 60;
        w.time.bittensor = T + i * 60;
        o.before(i);
        const lines: string[] = [];
        const { deps } = depsFor(w, memory, d, (l) => lines.push(l));
        o.under?.(i, deps);
        const r = await runRound(deps, target, memory, { ...OPTS, ...(o.rewardsEveryTicks ? { rewardsEveryTicks: o.rewardsEveryTicks } : {}), now: () => (T + i * 60) * 1000 });
        expect(r.end, `round ${i + 1}: ${lines.at(-1)}`).toBeUndefined();
        out.push({ lines, failing: r.memory.failing, waitMs: r.waitMs, refusals: r.memory.refusals.close });
        saved = encodeMemory(r.memory);
      }
      return out;
    }
    /** The close's own read (the round's second) sees `change` first */
    const atTheClosesRead = (deps: KeeperDepsOf, change: () => void) => {
      const read = deps.readState.bind(deps);
      let n = 0;
      (deps as { readState: typeof deps.readState }).readState = async (x) => {
        if (++n === 2) change();
        return read(x);
      };
    };

    it("three cancel-downs between the round's read and the close's own read (4.9 TAO aged, 0.2 fresh: over the half line at the round's read, under it at the close's), then a full batch: it closes at the very next round, and the round went on to the work behind the close each time (before R12e the third tripped the breaker: SKIPPING for 5 minutes, then 10, 20, 40, 60, and the full batch waited)", async () => {
      const w = world();
      // behind the close, on Bittensor: the vault's surplus due its adoption (read once nothing else is due)
      w.vault.lastAdoptAt = BigInt(T - 2 * 86_400);
      w.vault.surplusStakeRao = 2_000_000n;
      const r = await rounds(w, 4, {
        before: (i) => set(w, 49n * 10n ** 17n, i < 3 ? 2n * 10n ** 17n : 51n * 10n ** 17n),
        under: (i, deps) => {
          if (i < 3) atTheClosesRead(deps, () => set(w, 47n * 10n ** 17n, 2n * 10n ** 17n));
        },
        rewardsEveryTicks: 1,
      });
      // the adoption went in the first round, behind the skipped close; the full batch closed at the next round, at its floor
      expect(w.sends.map((s) => [s.fn, s.args])).toEqual([
        ["adoptStake", []],
        ["closeBatch", [7n, 5n * TAO]],
      ]);
      const all = r.flatMap((x) => x.lines);
      expect(all.filter((l) => l.startsWith("Failed this round") || /SKIPPING/.test(l))).toEqual([]);
      // no failed round, no back-off, no breaker count
      expect(r.map((x) => [x.failing, x.waitMs, x.refusals])).toEqual([
        [0, 60_000, undefined],
        [0, 60_000, undefined],
        [0, 60_000, undefined],
        [0, 60_000, undefined],
      ]);
      // said each round, as a skip
      for (const x of r.slice(0, 3)) {
        expect(x.lines).toContainEqual(
          expect.stringMatching(/^Skipped this round \(closing the batch\): batch 7 changed since the round read it, and now the keeper holds it: it waits until .* or until its fees cover the bridge fee \(\$0\.00 of \$0\.30\); the next round decides again$/),
        );
      }
      // a quiet round says what waits, and why
      // (R12f: no longer "nothing sent", since a close reverted BatchNotReady on chain is a quiet skip too; its Skipped line says)
      expect(r[1].lines.at(-1)).toBe("nothing due: closing the batch waits: refused by its own read of the chain this round (see Skipped above); the next round decides again from its own read");
    });

    it("the re-read after BatchTooSmall (the batch cancelled down under the close's simulation, then held by the close rule) and the batch no longer ready at the close's read: each a quiet skip too, three rounds running, then the full batch closes", async () => {
      const MIN = 4n * 10n ** 16n;
      const addr = (i: number) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address;
      // a list at half (25 × 0.04 TAO): 24 aged entries cancelled in full under each simulation, three rounds running
      const w = world();
      const list = () => {
        w.door.deposits = Array.from({ length: 25 }, (_, i) => ({ user: addr(i), amount: MIN }));
        w.door.totalDeposits = 25n * MIN;
      };
      let flap = true;
      w.simulate = (c) => {
        if (c.fn !== "closeBatch") return 200_000n;
        if (flap) {
          w.door.deposits = [w.door.deposits[24]];
          w.door.totalDeposits = MIN;
        }
        return w.door.totalDeposits < (c.args[1] as bigint) ? { error: "BatchTooSmall" } : 200_000n;
      };
      const r = await rounds(w, 4, {
        before: (i) => {
          flap = i < 3;
          list();
        },
      });
      expect(w.sends.map((s) => [s.fn, s.args])).toEqual([["closeBatch", [7n, TAO]]]);
      expect(r.map((x) => [x.failing, x.refusals])).toEqual([
        [0, undefined],
        [0, undefined],
        [0, undefined],
        [0, undefined],
      ]);
      for (const x of r.slice(0, 3)) {
        expect(x.lines).toContain("Not closed yet: the open batch holds less than when it was read (a deposit was cancelled) (BatchTooSmall); reading the open batch again");
        expect(x.lines).toContainEqual(expect.stringMatching(/^Skipped this round \(closing the batch\): batch 7 changed under the close \(BatchTooSmall\), and now the keeper holds it: it waits until /));
      }
      // not ready at the close's own read (a cancel that took a batch full before its interval under its line): the same
      const v = world();
      const s = await rounds(v, 4, {
        before: (i) => {
          v.door.canClose = true;
          v.door.start = BigInt(T + i * 60 - 600);
          v.door.totalDeposits = 6n * TAO;
          v.door.deposits = [{ user: AGED, amount: 6n * TAO }];
        },
        under: (i, deps) => {
          if (i < 3) atTheClosesRead(deps, () => (v.door.canClose = false));
        },
      });
      expect(v.sends.map((x) => [x.fn, x.args])).toEqual([["closeBatch", [7n, 5n * TAO]]]);
      expect(s.map((x) => [x.failing, x.refusals])).toEqual([
        [0, undefined],
        [0, undefined],
        [0, undefined],
        [0, undefined],
      ]);
      expect(s[0].lines).toContain("Skipped this round (closing the batch): the open batch is not ready to close yet");
    });

    it("the breaker still counts what nothing explains: a simulation refusal no rule names, three rounds running, trips it; a mined revert nothing explains counts too (R12h: a mined WrongBatch, its block explaining it, does not); a quiet skip between refusals neither counts nor resets them", async () => {
      // a refusal no rule names (InsufficientFee is no revert the close's table takes)
      const w = world();
      w.door.start = BigInt(T - 90_000);
      w.simulate = (c) => (c.fn === "closeBatch" ? { error: "InsufficientFee" } : 200_000n);
      const r = await rounds(w, 3, { before: () => undefined });
      expect(r.map((x) => x.failing)).toEqual([1, 2, 0]);
      expect(r[2].lines).toContainEqual(expect.stringMatching(/^SKIPPING closing the batch: refused 3 times in a row \(refused by simulation: .*InsufficientFee/));
      expect(w.sends).toEqual([]);
      // mined after the simulation passed, three rounds running (each a close's gas spent), with nothing to explain it: the
      // replay names no reason, no deposit of the batch was cancelled in its blocks, and read again it can still close
      const minedAs = (replay: () => unknown) => {
        const x = world();
        x.door.start = BigInt(T - 90_000);
        x.fate = (c) => (c.fn === "closeBatch" ? "revert" : "mine");
        x.fns.push(...(KEEPER_CALLS_V32 as readonly AbiFunction[]).filter((f) => f.type === "function" && f.name === "closeBatch"));
        x.answers[`${ADDR.frontDoor.toLowerCase()}:closeBatch`] = replay;
        return x;
      };
      const m = minedAs(() => []);
      const mined = await rounds(m, 3, { before: () => undefined });
      expect(mined[2].lines).toContainEqual(
        expect.stringMatching(/^SKIPPING closing the batch: refused 3 times in a row \(it waits: the close of batch 7 waits: its replay names no reason .*; no deposit of it was cancelled from block .*; read again, it can still close, so nothing explains it/),
      );
      expect(m.sends.map((s) => s.fn)).toEqual(["closeBatch", "closeBatch", "closeBatch"]);
      // R12h: the replay naming WrongBatch at its block (another close landed first there) is the round's quiet skip, three
      // rounds running, whatever the batch read again (before R12h: still batch 7 and closable, counted, and the third
      // tripped the breaker)
      const q = minedAs(() => {
        throw revertWith("WrongBatch", [8n]);
      });
      const quiet = await rounds(q, 3, { before: () => undefined });
      expect(quiet.map((x) => [x.failing, x.refusals])).toEqual([
        [0, undefined],
        [0, undefined],
        [0, undefined],
      ]);
      expect(q.sends.map((s) => s.fn)).toEqual(["closeBatch", "closeBatch", "closeBatch"]);
      // two refusals, a quiet skip, a refusal: the third refusal trips it
      const v = world();
      v.door.start = BigInt(T - 90_000);
      v.simulate = (c) => (c.fn === "closeBatch" ? { error: "InsufficientFee" } : 200_000n);
      const s = await rounds(v, 4, {
        before: () => (v.door.canClose = true),
        under: (i, deps) => {
          if (i === 2) atTheClosesRead(deps, () => (v.door.canClose = false));
        },
      });
      expect(s.map((x) => (x.refusals as { n: number } | undefined)?.n)).toEqual([1, 2, 2, 3]);
      expect(s[2].lines.filter((l) => l.startsWith("Failed this round"))).toEqual([]);
      expect(s[3].lines).toContainEqual(expect.stringMatching(/^SKIPPING closing the batch: refused 3 times in a row/));
    });

    describe("R12f: a cancel between the close's own read and its simulation (BatchNotReady), or after the simulation (mined): read again once, a batch no longer closable is that round's quiet skip too", () => {
      /** The batch the round reads: full by value before its interval (6 of the 10 TAO limit, ten minutes old), closable */
      const full = (w: World, i: number) => {
        w.door.canClose = true;
        w.door.start = BigInt(T + i * 60 - 600);
        w.door.totalDeposits = 6n * TAO;
        w.door.deposits = [{ user: AGED, amount: 6n * TAO }];
      };
      /** The holder cancels 1.1 TAO: under the half line, and before its interval nothing else lets the batch close */
      const cancelDown = (w: World) => {
        w.door.totalDeposits = 49n * 10n ** 17n;
        w.door.deposits = [{ user: AGED, amount: 49n * 10n ** 17n }];
        w.door.canClose = false;
      };
      const WHY = "the open batch can't close now (canClose() went false since the read: a cancel took it under every line that let it close, or a roll restarted its timer)";
      const NOT_READY = `Not closed yet: ${WHY} (BatchNotReady); reading the open batch again`;
      /** The chain mines `w`'s closes as `fate` says, the reverted ones replayed as BatchNotReady */
      const minedAs = (w: World, fate: () => "mine" | "revert") => {
        w.fns.push(...(KEEPER_CALLS_V32 as readonly AbiFunction[]).filter((f) => f.type === "function" && f.name === "closeBatch"));
        w.answers[`${ADDR.frontDoor.toLowerCase()}:closeBatch`] = () => {
          throw revertWith("BatchNotReady");
        };
        w.fate = (c) => (c.fn === "closeBatch" ? fate() : "mine");
      };
      const quiet = (r: Round[]) => r.flatMap((x) => x.lines).filter((l) => l.startsWith("Failed this round") || l.startsWith("Not done:") || /SKIPPING/.test(l));

      it("three rounds running, a cancel between the close's own read and its simulation: read again once, the batch not closable, each the round's quiet skip (one simulation a round); no failed round, no breaker count; the next round closes the full batch (before R12f each was a counted refusal: the third tripped the breaker, and the full batch waited out its back-off)", async () => {
        const w = world();
        let cancel = false;
        let sims = 0;
        w.simulate = (c) => {
          if (c.fn !== "closeBatch") return 200_000n;
          sims++;
          if (cancel) cancelDown(w);
          return w.door.canClose ? 200_000n : { error: "BatchNotReady" };
        };
        const r = await rounds(w, 4, {
          before: (i) => {
            full(w, i);
            cancel = i < 3;
          },
        });
        expect(w.sends.map((s) => [s.fn, s.args])).toEqual([["closeBatch", [7n, 5n * TAO]]]);
        expect(quiet(r)).toEqual([]);
        expect(r.map((x) => [x.failing, x.waitMs, x.refusals])).toEqual([
          [0, 60_000, undefined],
          [0, 60_000, undefined],
          [0, 60_000, undefined],
          [0, 60_000, undefined],
        ]);
        for (const x of r.slice(0, 3)) {
          expect(x.lines).toContain(NOT_READY);
          expect(x.lines).toContain("Skipped this round (closing the batch): the open batch is not ready to close yet");
        }
        // the re-read decided: nothing simulated again in those rounds
        expect(sims).toBe(4);
      });

      it("a BatchNotReady the re-read contradicts (the door still says the batch can close) is simulated once more, and a second one is counted: three rounds running trip the breaker; after a BatchTooSmall's re-read the same, never a fourth simulation", async () => {
        const w = world();
        let sims = 0;
        w.simulate = (c) => {
          if (c.fn !== "closeBatch") return 200_000n;
          sims++;
          return { error: "BatchNotReady" };
        };
        const r = await rounds(w, 3, { before: (i) => full(w, i) });
        expect(w.sends).toEqual([]);
        // read again and simulated once more, each round
        expect(sims).toBe(6);
        for (const x of r) expect(x.lines).toContain(NOT_READY);
        expect(r.map((x) => [x.failing, (x.refusals as { n: number } | undefined)?.n])).toEqual([
          [1, 1],
          [2, 2],
          [0, 3],
        ]);
        expect(r[0].lines.at(-1)).toMatch(/^Failed this round \(refused by simulation, closing the batch\): Base: .* would fail, nothing sent \(BatchNotReady\(\)\); next round in /);
        expect(r[2].lines).toContainEqual(expect.stringMatching(/^SKIPPING closing the batch: refused 3 times in a row \(refused by simulation: .*BatchNotReady\(\)/));
        // BatchTooSmall (a rao cancelled: still full), read again, then BatchNotReady twice while the door says it can close
        const v = world();
        full(v, 0);
        const answers = ["BatchTooSmall", "BatchNotReady", "BatchNotReady", "BatchNotReady"];
        let n = 0;
        v.simulate = (c) => (c.fn === "closeBatch" ? { error: answers[n++] } : 200_000n);
        const lines: string[] = [];
        const e = await closeV32(depsFor(v, freshMemory(), d, (l) => lines.push(l)).deps, target).catch((x: unknown) => x);
        expect(e).toBeInstanceOf(SendRefused);
        expect(classifyFailure(e)).toMatchObject({ stop: false, kind: "estimate" });
        expect((e as Error).message).toMatch(/\(BatchNotReady\(\)\)$/);
        expect(n).toBe(3);
        expect(lines.filter((l) => l.startsWith("Not closed yet:"))).toEqual([
          "Not closed yet: the open batch holds less than when it was read (a deposit was cancelled) (BatchTooSmall); reading the open batch again",
          NOT_READY,
        ]);
        expect(v.sends).toEqual([]);
      });

      it("mined: a cancel that lands after the close's simulation passed, so the chain reverts the close BatchNotReady: its replay names it, the round's quiet skip, three rounds running, then the full batch closes; it neither counts for the breaker nor starts its count again; R12h: so too while the door, read again, still lets the batch close, never a stop (before R12f: 'another close landed first' and the count started again, or a revert nothing explains, which stopped the keeper; before R12h, read again closable, a counted wait)", async () => {
        const w = world();
        let cancel = false;
        minedAs(w, () => {
          if (cancel) cancelDown(w);
          return w.door.canClose ? "mine" : "revert";
        });
        const r = await rounds(w, 4, {
          before: (i) => {
            full(w, i);
            cancel = i < 3;
          },
        });
        // each a close's gas spent; the fourth went through
        expect(w.sends.map((s) => [s.fn, s.args])).toEqual(Array.from({ length: 4 }, () => ["closeBatch", [7n, 5n * TAO]]));
        expect(quiet(r)).toEqual([]);
        expect(r.map((x) => [x.failing, x.refusals])).toEqual([
          [0, undefined],
          [0, undefined],
          [0, undefined],
          [0, undefined],
        ]);
        for (const x of r.slice(0, 3)) {
          expect(x.lines).toContainEqual(
            `Skipped this round (closing the batch): batch 7 changed under the close after its simulation passed (BatchNotReady: ${WHY}); transaction ${w.sends[r.indexOf(x)].hash} reverted on chain; its replay names that at the block it was mined in or the one before, whatever the batch holds now; the next round decides again`,
          );
          // the quiet round's reason never says "nothing sent" (R12e's did): this close was sent, and reverted
          expect(x.lines.at(-1)).toBe("nothing due: closing the batch waits: refused by its own read of the chain this round (see Skipped above); the next round decides again from its own read");
        }
        // between refusals no rule explains, the mined skip keeps their count as it was: the third trips the breaker
        const v = world();
        let mode: "refuse" | "cancel" = "refuse";
        v.simulate = (c) => (c.fn === "closeBatch" && mode === "refuse" ? { error: "InsufficientFee" } : 200_000n);
        minedAs(v, () => {
          cancelDown(v);
          return "revert";
        });
        const s = await rounds(v, 4, {
          before: (i) => {
            full(v, i);
            mode = i === 2 ? "cancel" : "refuse";
          },
        });
        expect(s.map((x) => (x.refusals as { n: number } | undefined)?.n)).toEqual([1, 2, 2, 3]);
        expect(s[2].lines.filter((l) => l.startsWith("Failed this round") || l.startsWith("Not done:"))).toEqual([]);
        expect(s[3].lines).toContainEqual(expect.stringMatching(/^SKIPPING closing the batch: refused 3 times in a row/));
        // R12h: reverted BatchNotReady while the door, read again, still lets the batch close (the holder's TAO back by the
        // read after it): the replay at its block names it, so it is the round's quiet skip all the same, three rounds
        // running, never counted and never a stop (before R12h: a counted wait, and the third tripped the breaker)
        const x = world();
        minedAs(x, () => "revert");
        const t = await rounds(x, 3, { before: (i) => full(x, i) });
        expect(x.sends.map((c) => c.fn)).toEqual(["closeBatch", "closeBatch", "closeBatch"]);
        expect(t.map((y) => [y.failing, y.refusals])).toEqual([
          [0, undefined],
          [0, undefined],
          [0, undefined],
        ]);
        expect(quiet(t)).toEqual([]);
      });
    });
  });

  it("build B (the list half rule): past its interval a deposit list at half its limit closes at once (2 x deposits >= maxDeposits: 25 of 50, 25 of 49), a rao of value or an entry under it is held; the redeem list stays at full", async () => {
    const l = { maxDeposits: 50, maxRedeems: 50, maxBatchValue: 10n * TAO, minDeposit: 4n * 10n ** 16n, depositCap: 40n * TAO, netForwarded: 0n };
    const small = (deposits: number, redeems = 0) => ({ deposits, redeems, totalDeposits: 2n * TAO });
    expect(doorLimitsFull(small(25), l)).toBe(true);
    expect(doorLimitsFull(small(24), l)).toBe(false);
    // an odd limit: 2 x 25 = 50 >= 49, 2 x 24 = 48 < 49
    expect(doorLimitsFull(small(25), { ...l, maxDeposits: 49 })).toBe(true);
    expect(doorLimitsFull(small(24), { ...l, maxDeposits: 49 })).toBe(false);
    // the redeem list at half is not full: it closes only at its limit
    expect(doorLimitsFull({ deposits: 1, redeems: 25, totalDeposits: 2n * TAO }, l)).toBe(false);
    expect(doorLimitsFull({ deposits: 1, redeems: 50, totalDeposits: 2n * TAO }, l)).toBe(true);
    // the count makes it full whatever the value: a list at half names the least its 25 entries carry, 25 × 0.04 TAO
    // (R12d, L-1: before it 0)
    expect(fullCloseFloor(small(25), l)).toBe(TAO);
    expect(fullCloseFloor(small(24), l)).toBeUndefined();
    // and a round past the interval closes a batch of 25 small deposits at once, 24 held for its fees
    const round = async (n: number) => {
      const x = world();
      x.door.deposits = Array.from({ length: n }, (_, i) => ({ user: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address, amount: 8n * 10n ** 16n }));
      x.door.totalDeposits = BigInt(n) * 8n * 10n ** 16n;
      const m = freshMemory();
      await runRound(depsFor(x, m).deps, target, m, { ...OPTS, now: () => T * 1000 });
      return x.sends.map((s) => [s.fn, s.args]);
    };
    expect(await round(25)).toEqual([["closeBatch", [7n, TAO]]]);
    expect(await round(24)).toEqual([]);
  });

  it("R12b: fullCloseFloor is the least total at which a clause that held at the read still holds: the deposit list's the least its entries carry (R12d), the redeem list's 0, never above the total", () => {
    const l = { maxDeposits: 50, maxRedeems: 50, maxBatchValue: 10n * TAO, minDeposit: 4n * 10n ** 16n, depositCap: 40n * TAO, netForwarded: 0n };
    const b = (totalDeposits: bigint, deposits = 1, redeems = 0) => ({ deposits, redeems, totalDeposits });
    // half the value limit: 5 TAO (an odd limit rounds up: 2 × t >= 9 needs 4.5)
    expect(fullCloseFloor(b(6n * TAO), l)).toBe(5n * TAO);
    expect(fullCloseFloor(b(6n * TAO), { ...l, maxBatchValue: 9n * TAO })).toBe((9n * TAO + 1n) / 2n);
    // no room for a minimum deposit, under half (a minimum above half the limit): maxBatchValue - minDeposit + 1 wei
    expect(fullCloseFloor(b(45n * 10n ** 17n), { ...l, minDeposit: 6n * TAO })).toBe(4n * TAO + 1n);
    // half the cap's room: netForwarded 30 of 40, so 5 TAO of deposits
    expect(fullCloseFloor(b(6n * TAO), { ...l, maxBatchValue: 100n * TAO, netForwarded: 30n * TAO })).toBe(5n * TAO);
    // no room under the cap for a minimum, under half its room: depositCap - netForwarded - minDeposit + 1 wei
    expect(fullCloseFloor(b(45n * 10n ** 17n), { ...l, maxBatchValue: 100n * TAO, netForwarded: 30n * TAO, minDeposit: 6n * TAO })).toBe(4n * TAO + 1n);
    // the least of the clauses that held: 9.8 TAO at half a 16 TAO limit (8) and at half the cap's room left by 30 of 40 (5)
    expect(fullCloseFloor(b(98n * 10n ** 17n), { ...l, maxBatchValue: 16n * TAO, netForwarded: 30n * TAO })).toBe(5n * TAO);
    expect(fullCloseFloor(b(98n * 10n ** 17n), { ...l, maxBatchValue: 16n * TAO, netForwarded: 20n * TAO })).toBe(8n * TAO);
    // R12d (L-1): the deposit list at half or more: the count makes it full, whatever the value, and its floor is the least
    // its entries carry, half the limit (rounded up) × minDeposit: 25 × 0.04 = 1 TAO, at 50 entries too
    expect(listHalf(50)).toBe(25);
    expect(listHalf(49)).toBe(25);
    expect(fullCloseFloor(b(2n * TAO, 50), l)).toBe(TAO);
    expect(fullCloseFloor(b(2n * TAO, 25), { ...l, maxDeposits: 49 })).toBe(TAO);
    // never above the total (entries made before a raised minimum)
    expect(fullCloseFloor(b(5n * 10n ** 17n, 25), l)).toBe(5n * 10n ** 17n);
    // and with a value clause holding too, the least of them
    expect(fullCloseFloor(b(6n * TAO, 25), l)).toBe(TAO);
    // the redeem list full: 0 (its requests' fees in the pot pay its close), whatever else held
    expect(fullCloseFloor(b(2n * TAO, 1, 50), l)).toBe(0n);
    expect(fullCloseFloor(b(6n * TAO, 25, 50), l)).toBe(0n);
    // never below 1 wei of deposits by value, never above the total read
    expect(fullCloseFloor(b(6n * TAO), { ...l, netForwarded: 40n * TAO })).toBe(1n);
    // not full at all: undefined (the exact total then)
    expect(fullCloseFloor(b(2n * TAO), l)).toBeUndefined();
  });

  it("an empty batch rolls by its id with no value, a paused door's too", async () => {
    const w = world();
    w.door.deposits = [];
    w.door.totalDeposits = 0n;
    w.door.paused = true;
    const r = await rollV32(depsFor(w).deps, target);
    expect(r.rolled).toBe(true);
    expect(w.sends[0]).toMatchObject({ fn: "closeBatch", args: [7n, 0n], value: 0n });
  });

  it("R6b (U4, the room rule): a batch the front door lets close before its interval (canClose() true: no room for a minimum deposit) closes at once, whatever its fees; the keeper reads the door's canClose, never a copy of its rule", async () => {
    // 9.97 TAO of the 10 TAO maxBatchValue: no room for a 0.06 TAO deposit, so the door's room rule makes it closable
    // 10 minutes in, an hour before its interval; one deposit, far under maxDeposits, and its fees far short of the bridge fee
    const room = () => {
      const w = world();
      w.door.start = BigInt(T - 600);
      w.door.totalDeposits = (997n * TAO) / 100n;
      w.door.deposits = [{ user: ALICE, amount: (997n * TAO) / 100n }];
      return w;
    };
    const w = room();
    const s = await depsFor(w).deps.readState({ economics: true });
    expect(s.frontDoor).toMatchObject({ canClose: true, full: true });
    const m = freshMemory();
    await runRound(depsFor(w, m).deps, target, m, { ...OPTS, now: () => T * 1000 });
    // full before its interval: the least total still full (R12d, L-1: before it 0), never the exact total: at half the
    // 10 TAO limit, 5 TAO, the least of the lines that held (no room for a 0.04 minimum holds from 9.96 TAO and 1 wei)
    expect(w.sends.map((s) => [s.fn, s.args])).toEqual([["closeBatch", [7n, 5n * TAO]]]);
    // the same batch the door doesn't let close yet: nothing
    const v = room();
    v.door.canClose = false;
    const n = freshMemory();
    await runRound(depsFor(v, n).deps, target, n, { ...OPTS, now: () => T * 1000 });
    expect(v.sends).toEqual([]);
    // past its interval, not full, its fees short: held for the max wait, as before
    const h = world();
    const k = freshMemory();
    await runRound(depsFor(h, k).deps, target, k, { ...OPTS, now: () => T * 1000 });
    expect(h.sends).toEqual([]);
    // past its interval and full (its list, or no room for a minimum deposit by value or by the deposit cap): at once
    const full = [
      (x: World) => (x.door.maxDeposits = 1),
      (x: World) => (x.door.totalDeposits = (997n * TAO) / 100n),
      (x: World) => (x.door.depositCap = x.door.netForwarded + 2n * TAO + 10n ** 16n),
    ];
    for (const [i, make] of full.entries()) {
      const x = world();
      make(x);
      const y = freshMemory();
      await runRound(depsFor(x, y).deps, target, y, { ...OPTS, now: () => T * 1000 });
      expect(x.sends.map((s) => s.fn), String(i)).toEqual(["closeBatch"]);
    }
  });

  it("R7 (L3): past its interval the keeper's copy of the room rule is CascadeFrontDoor.canClose's: the value and cap clauses only while the batch holds deposits, at half the limit or no room for a minimum; a batch of unstakes alone at the cap waits", async () => {
    // the copy, held to the contract's source once the contracts round lands (the controller re-pins it on the merge)
    const round = async (make: (x: World) => void) => {
      const x = world();
      make(x);
      const y = freshMemory();
      await runRound(depsFor(x, y).deps, target, y, { ...OPTS, now: () => T * 1000 });
      return x.sends.map((s) => s.fn);
    };
    // 2 × totalDeposits >= maxBatchValue: half of the 10 TAO limit closes at once; a rao under half is held, its fees short
    const half = (total: bigint) => (x: World) => {
      x.door.totalDeposits = total;
      x.door.deposits = [{ user: ALICE, amount: total }];
    };
    expect(await round(half(5n * TAO))).toEqual(["closeBatch"]);
    expect(await round(half(5n * TAO - RAO))).toEqual([]);
    // netForwarded + 2 × totalDeposits >= depositCap: half the cap's room left, at once; a rao less is held
    expect(await round((x) => (x.door.netForwarded = x.door.depositCap - 4n * TAO))).toEqual(["closeBatch"]);
    expect(await round((x) => (x.door.netForwarded = x.door.depositCap - 4n * TAO - RAO))).toEqual([]);
    // a batch of unstakes alone (no deposits): neither the value nor the cap counts, even with the cap full; it waits for
    // its max wait or its fees, as any other; its list full still closes it at once
    const unstakes = (x: World) => {
      x.door.deposits = [];
      x.door.totalDeposits = 0n;
      x.door.redeems = [{ user: BOB, amount: TAO }];
      x.door.netForwarded = x.door.depositCap;
    };
    expect(await round(unstakes)).toEqual([]);
    expect(
      await round((x) => {
        unstakes(x);
        x.door.maxRedeems = 1;
      }),
    ).toEqual(["closeBatch"]);
  });

  /** A world whose open batch is due at once but for the payout rail: past the 24 h max wait, or (`full`) before it, at
   * half its value limit; with BOB's redeem request (`redeems`), with or without deposits, the vault's primary disabled
   * there, or its canSendPayouts() answering `view`. */
  const railDue = (o: { redeems: boolean; deposits?: boolean; full?: boolean; disabled?: boolean; view?: boolean | "reverts" | "empty" | bigint }) => {
    const w = world();
    w.door.start = BigInt(o.full ? T - 4_000 : T - 90_000);
    if (o.full) {
      w.door.totalDeposits = 5n * TAO;
      w.door.deposits = [{ user: ALICE, amount: 5n * TAO }];
    }
    if (o.deposits === false) {
      w.door.totalDeposits = 0n;
      w.door.deposits = [];
    }
    if (o.redeems) w.door.redeems = [{ user: BOB, amount: TAO }];
    if (o.disabled) w.bridgeEnabled[ADDR.bitAdapter.toLowerCase()] = false;
    if (o.view !== undefined) w.canSendPayouts[ADDR.bitAdapter.toLowerCase()] = o.view;
    return w;
  };
  /** One round on `w` at T: what it sent, and its lines. */
  const railRound = async (w: World) => {
    const lines: string[] = [];
    const m = freshMemory();
    await runRound(depsFor(w, m, d, (l) => lines.push(l)).deps, target, m, { ...OPTS, now: () => T * 1000 });
    return { sent: w.sends.map((s) => s.fn), lines };
  };
  const disabledWhy = (n: number) =>
    `the open batch holds 1 redeem request and the vault's payouts are closed (its primary bridge ${ADDR.bitAdapter} is disabled on the vault), so the vault would defer it (RedeemDeferred: the requester keeps the shares and asks again)${n === 0 ? "; the batch stays on Base until the vault's payouts open" : ""}`;

  it("R7 (L4): a batch of redeem requests alone waits while the vault's payouts are closed (its _payoutsOpen: the primary disabled on the vault, or its canSendPayouts() false), said plainly, by hand too; deposits alone still go", async () => {
    const w = railDue({ redeems: true, deposits: false, disabled: true });
    const r = await railRound(w);
    expect(r.sent).toEqual([]);
    expect(r.lines).toContainEqual(expect.stringContaining(`closing waits: ${disabledWhy(0)}`));
    // by hand (no notice): the same, nothing sent
    const e = await closeV32(depsFor(w).deps, target).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NotNow);
    expect((e as Error).message).toBe(`not closing the batch: ${disabledWhy(0)}`);
    expect(w.sends).toEqual([]);
    // its canSendPayouts() reading false, as the vault reads it: the same wait
    expect((await railRound(railDue({ redeems: true, deposits: false, view: false }))).sent).toEqual([]);
    // the keeper's read is the vault's _payoutsOpen: a disabled primary is closed, else its capped, fail-open view
    const payoutsOpen = src("CascadeVault.sol").match(/function _payoutsOpen\(\) internal view returns \(bool\) \{[\s\S]*?\n {4}\}/)?.[0] ?? "";
    expect(payoutsOpen).toContain("address p = primaryBridge;");
    expect(payoutsOpen).toContain("if (!bridgeEnabled[p]) return false;");
    expect(payoutsOpen).toContain('p.staticcall{gas: RAIL_VIEW_GAS}(abi.encodeWithSignature("canSendPayouts()"))');
    expect(payoutsOpen).toContain("return !ok || ret.length != 32 || abi.decode(ret, (uint256)) != 0;");
    // the payouts open (a view that reverts reads open, as the vault's fail-open staticcall does), or a batch of deposits
    // alone: it closes
    for (const x of [railDue({ redeems: true, deposits: false, view: "reverts" }), railDue({ redeems: true, deposits: false }), railDue({ redeems: false, disabled: true })]) {
      expect((await railRound(x)).sent).toEqual(["closeBatch"]);
    }
  });

  it("R8 (L-C): a batch with deposits waits behind its redeem requests while the vault's payouts are closed only until its max wait, then closes, saying they will be deferred (requestRedeem on Base checks no shares: a stranger's would hold every deposit)", async () => {
    // full at half its value limit, before its max wait: held, its line naming when it goes
    const early = await railRound(railDue({ redeems: true, full: true, disabled: true }));
    expect(early.sent).toEqual([]);
    expect(early.lines).toContainEqual(
      expect.stringContaining(
        `closing waits: ${disabledWhy(1)}; the batch stays on Base until the vault's payouts open, or until its max wait at 06:53 UTC tomorrow, when it closes with its 1 deposit and the vault defers its redeem requests`,
      ),
    );
    // past its max wait: it closes with its deposits, and its redeem request goes with it, said loudly
    const late = await railRound(railDue({ redeems: true, disabled: true }));
    expect(late.sent).toEqual(["closeBatch"]);
    expect(late.lines).toContain(
      `REDEEMS DEFERRED: batch 7 closes at its max wait with its 1 deposit, and its 1 redeem request goes with it: the vault's payouts are closed (its primary bridge ${ADDR.bitAdapter} is disabled on the vault), so it will defer it (RedeemDeferred: the requester keeps the shares and asks again once they open). Deposits never wait past the max wait behind a redeem request (requestRedeem on Base checks no shares)`,
    );
    // by hand the same: before its max wait refused, after it sent
    const e = await closeV32(depsFor(railDue({ redeems: true, full: true, view: false })).deps, target).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NotNow);
    const byHand = railDue({ redeems: true, view: false });
    await closeV32(depsFor(byHand).deps, target);
    expect(byHand.sends.map((s) => s.fn)).toEqual(["closeBatch"]);
    // a batch of redeem requests alone still waits past its max wait (closed now, the vault would only defer them)
    expect((await railRound(railDue({ redeems: true, deposits: false, disabled: true }))).sent).toEqual([]);
  });

  it("R8 (L-D): the rail view's answer read as the vault's staticcall reads it: only one word of 0 is closed; a revert, no bytes or any other word reads open; a node's own error fails the round, never read as open", async () => {
    const closes = async (view: boolean | "reverts" | "empty" | bigint) => (await railRound(railDue({ redeems: true, deposits: false, view }))).sent;
    expect(await closes(false)).toEqual([]);
    expect(await closes(0n)).toEqual([]);
    for (const view of ["reverts", "empty", 2n, true] as const) expect(await closes(view), String(view)).toEqual(["closeBatch"]);
    // the node didn't run the call (a transport or RPC error of its own): the round fails and reads again; nothing is closed
    const w = railDue({ redeems: true, deposits: false });
    w.callAt = (c) => (c.fn === "canSendPayouts" ? new RpcError("bittensor eth_call: header not found", -32000) : undefined);
    const r = await railRound(w);
    expect(r.sent).toEqual([]);
    expect(r.lines).toContainEqual(expect.stringMatching(/^Failed this round \(.*reading the chains\): .*header not found/));
    const v = railDue({ redeems: true, deposits: false });
    v.callAt = (c) => (c.fn === "canSendPayouts" ? new Error("fetch failed") : undefined);
    expect((await railRound(v)).sent).toEqual([]);
  });

  it("R9 (L-3): the payouts-open read is the vault's own call: from the vault, with its RAIL_VIEW_GAS (150,000) for the view plus the call's intrinsic gas, so a view that needs more reads open as it does for the vault", async () => {
    const asked: { from?: Address; gas?: Hex }[] = [];
    const w = railDue({ redeems: true, deposits: false, view: false });
    w.callAt = (c) => {
      if (c.fn === "canSendPayouts") asked.push({ ...(c.from ? { from: c.from } : {}), ...(c.gas ? { gas: c.gas } : {}) });
      return undefined;
    };
    expect((await railRound(w)).sent).toEqual([]);
    // 150,000 for the view, 21,000 for the call and 16 a byte of its four-byte selector (none is zero)
    expect(RAIL_VIEW_GAS).toBe(150_000n);
    expect(RAIL_VIEW_CALL_GAS).toBe(150_000n + 21_000n + 4n * 16n);
    expect(asked).toEqual([{ from: ADDR.vault, gas: `0x${RAIL_VIEW_CALL_GAS.toString(16)}` }]);
    // the vault's constant, and the staticcall that spends it
    expect(src("CascadeVault.sol")).toMatch(/uint256 internal constant RAIL_VIEW_GAS = 150_000;/);
    expect(src("CascadeVault.sol")).toContain('p.staticcall{gas: RAIL_VIEW_GAS}(abi.encodeWithSignature("canSendPayouts()"))');
  });

  it("R9 (L-3): Bittensor's EVM halting the view (Frontier's evm error / evm fatal: out of gas, an invalid opcode) is the view failing, read open as the vault's fail-open staticcall reads it, in this read only; a node's own error still fails the round", async () => {
    for (const message of ["evm error: OutOfGas", "evm error: InvalidCode(Opcode(254))", "evm fatal: NotSupported", "EVM error: StackUnderflow"]) {
      const w = railDue({ redeems: true, deposits: false, view: false });
      w.callAt = (c) => (c.fn === "canSendPayouts" ? new RpcError(message, -32603) : undefined);
      expect((await railRound(w)).sent, message).toEqual(["closeBatch"]);
    }
    expect(isEvmHalt(new RpcError("evm error: OutOfGas", -32603))).toBe(true);
    // a node that didn't run the call says nothing of the view: the round fails and reads again
    for (const e of [new RpcError("bittensor eth_call: header not found", -32000), new Error("evm error: fetch failed"), new RpcError("too many requests", -32005)]) {
      const w = railDue({ redeems: true, deposits: false });
      w.callAt = (c) => (c.fn === "canSendPayouts" ? e : undefined);
      expect((await railRound(w)).sent, e.message).toEqual([]);
      expect(isEvmHalt(e), e.message).toBe(false);
    }
  });

  it("a round closes a paused door's batch (the door's pause stops deliveries, never a close)", async () => {
    const w = world();
    w.door.paused = true;
    w.door.start = BigInt(T - 90_000); // past the 24 h max wait
    const lines: string[] = [];
    const m = freshMemory();
    await runRound(depsFor(w, m, d, (l) => lines.push(l)).deps, target, m, { ...OPTS, now: () => T * 1000 });
    expect(w.sends.map((s) => s.fn)).toEqual(["closeBatch"]);
    expect(lines.some((l) => l.startsWith("Done: the open batch is ready to close"))).toBe(true);
  });
});

describe("the carried rebuild (spec §3.10.15, Review Focus 3)", () => {
  const list = [bounce(ALICE, 3n * TAO), bounce(BOB, 2n * TAO), bounce(CAROL, TAO), redeem(DAN, 5n * TAO, 4n * TAO), redeem(ERIN, TAO, TAO)];
  const logs: PayoutLog[] = list.map((p, i) => ({ ...p, kind: p.shares === 0n ? "bounced" : "redeemed", key: KEY_A, blockNumber: 100n + BigInt(i), logIndex: 0 }));

  it("carriedRebuildWithTheCursorInsideTheBounces: after a cancel the list is the last bouncesCarried bounces, in log order, hashed as the vault re-hashes them", () => {
    expect(rebuildPayouts(logs, KEY_A)).toEqual(list);
    // the cursor at 1 (ALICE's bounce paid): the cancel re-mints DAN and ERIN and carries BOB's and CAROL's bounces
    const carried = rebuildPayouts(logs, KEY_A, { bouncesCarried: 2 });
    expect(carried).toEqual([bounce(BOB, 2n * TAO), bounce(CAROL, TAO)]);
    // CascadePayoutLib.cancel: h over (user, 0, assets) of each carried bounce, from zero
    expect(payoutsHash(carried)).toBe(payoutsHash([{ user: BOB, shares: 0n, assets: 2n * TAO }, { user: CAROL, shares: 0n, assets: TAO }]));
    // the cursor at 0: every bounce carried; past the bounces: none (the batch is deleted)
    expect(rebuildPayouts(logs, KEY_A, { bouncesCarried: 3 })).toEqual(list.slice(0, 3));
    expect(rebuildPayouts(logs, KEY_A, { bouncesCarried: 0 })).toEqual([]);
    // log order, not the order the logs come back in
    expect(rebuildPayouts([...logs].reverse(), KEY_A, { bouncesCarried: 2 })).toEqual(carried);
  });

  it("the keeper pays the carried bounces: the list from the cancel's bouncesCarried, held to the vault's hash", async () => {
    const w = world();
    queue(w, KEY_A, list, { cursor: 1 });
    // the owner's cancel: DAN and ERIN re-minted, BOB's and CAROL's bounces carried as the new list
    w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "PayoutBatchCancelled", args: { key: KEY_A, reminted: 5n * TAO, bouncesCarried: 2 }, block: 6_000n });
    const carried = [bounce(BOB, 2n * TAO), bounce(CAROL, TAO)];
    w.vault.batches[KEY_A] = { ...w.vault.batches[KEY_A], cursor: 0, count: 2, remaining: 3n * TAO, payoutsHash: payoutsHash(carried) };
    w.vault.pending = 3n * TAO;
    w.vault.balance = 10n * TAO;
    await payoutsV32(depsFor(w).deps, target, KEY_A);
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]).toMatchObject({ fn: "processPayouts", args: [KEY_A, carried, MAX_ENTRIES] });
  });
});

const inputs = (over: Partial<PayoutInputs> = {}): PayoutInputs => ({
  batch: { sourceChain: 8453n, frontDoor: ADDR.frontDoor, cursor: 0, count: 1, chunk: 0, remaining: TAO, payoutsHash: `0x${"00".repeat(32)}`, queuedAt: 0n },
  pendingPayouts: TAO,
  balance: 5n * TAO,
  maxFeeBps: 100n,
  maxFeeAbs: 15n * 10n ** 15n,
  minChunk: 10,
  maxMessageValue: 15n * TAO,
  visibleStakeRao: (50n * TAO) / RAO,
  hotkeyCount: 2,
  unstakeGas: 400_000n,
  ...over,
});

describe("processPayouts with a top-up (spec §3.3, the fee valve)", () => {
  const one = [redeem(ALICE, TAO, TAO)];
  // a 1 TAO chunk's ceiling is max(1% of it, 0.015 TAO) = 0.015 TAO; a quote of 0.0200000001 TAO is 0.020000001 TAO
  // in whole rao, so the caller tops up 0.005000001 TAO
  const QUOTE = 20_000_000_100_000_000n;

  it("topUpOnlyWithinTheOperatorsLimit: a fee above what the entries pay goes only within OPS_PAYOUT_TOPUP_MAX (0 by default), in whole rao", () => {
    const split = feeSplit(QUOTE, TAO, 100n, 15n * 10n ** 15n);
    expect(split).toEqual({ fee: 20_000_001n * RAO, charged: 15n * 10n ** 15n, ceiling: 15n * 10n ** 15n });
    const topUp = split.fee - split.charged;
    expect(topUp % RAO).toBe(0n);
    for (const limit of [0n, topUp - RAO]) {
      const p = planPayout(one, inputs(), QUOTE, limit);
      expect(p, String(limit)).toMatchObject({ go: false, why: "top-up", topUp });
    }
    expect(planPayout(one, inputs(), QUOTE, topUp)).toMatchObject({ go: true, topUp, fee: split.fee, charged: split.charged });
    // a fee under the ceiling needs none
    expect(planPayout(one, inputs(), 10n ** 15n, 0n)).toMatchObject({ go: true, topUp: 0n });
    // the operator's limit: TAO, whole rao, 0 when unset
    expect(payoutTopUpMax({})).toBe(0n);
    expect(payoutTopUpMax({ OPS_PAYOUT_TOPUP_MAX: "0.006" })).toBe(6n * 10n ** 15n);
    expect(() => payoutTopUpMax({ OPS_PAYOUT_TOPUP_MAX: "0.0000000001" })).toThrow(/not a whole number of rao/);
    expect(() => payoutTopUpMax({ OPS_PAYOUT_TOPUP_MAX: "1e-3" })).toThrow(/not an amount of TAO/);
    // the request carries the top-up as its value, and refuses one that isn't whole rao (BadValue)
    const stored = { payoutsHash: payoutsHash(one), count: 1 };
    expect(payoutsRequest({ plan: { addresses: d.addresses } }, KEY_A, one, stored, 5, topUp, 0n)).toMatchObject({ value: topUp, args: [KEY_A, one, 50] });
    expect(payoutsRequest({ plan: { addresses: d.addresses } }, KEY_A, one, stored, 5, 0n, 0n).value).toBeUndefined();
    expect(() => payoutsRequest({ plan: { addresses: d.addresses } }, KEY_A, one, stored, 5, topUp + 1n, 0n)).toThrow(/not whole rao/);
  });

  it("the keeper sends the top-up within its limit, and waits above it", async () => {
    for (const [limit, sent] of [
      [0n, false],
      [6n * 10n ** 15n, true],
    ] as const) {
      const w = world();
      queue(w, KEY_A, one);
      w.vault.payoutFee = QUOTE;
      const e = await payoutsV32(depsFor(w, freshMemory(), deploymentFor({ payoutTopUpMax: limit })).deps, target, KEY_A).catch((x: unknown) => x);
      if (sent) expect(w.sends[0]).toMatchObject({ fn: "processPayouts", value: 5_000_001n * RAO });
      else {
        expect(e).toBeInstanceOf(Waits);
        expect((e as Error).message).toMatch(/its bridge fee, 0\.020000001 TAO, is above what its 1 entry pays \(at most 0\.015 TAO\), and the keeper adds at most 0 TAO/);
        expect(w.sends).toEqual([]);
      }
    }
  });

  describe("merge 7b: the full top-up (spec §3.3; the R4-K review's Minor 6)", () => {
    const FEE = 10n ** 15n;
    /** The chain's conversion floor raised to `floor`: the adapter refuses a send whose net is under it, so the
     * simulation of a payout sent with less than the whole fee as its value answers BelowConversionFloor(net, floor), and
     * one sent with the whole fee (the entries sent their gross) passes, unless the floor is above the gross too. Each
     * simulation's value, kept. */
    const floorAt = (w: World, floor: bigint) => {
      const values: bigint[] = [];
      w.simulate = (c) => {
        if (c.fn !== "processPayouts") return 200_000n;
        values.push(c.value);
        const net = c.value >= FEE ? TAO : TAO - FEE;
        return net >= floor ? 200_000n : { error: "BelowConversionFloor", args: [net, floor] };
      };
      return values;
    };

    it("BelowConversionFloor: the keeper chooses the full top-up, the whole fee as its value, so the entries are sent their gross; said", async () => {
      const w = world();
      queue(w, KEY_A, one);
      // a 0.001 TAO fee, all within what the 1 TAO entry pays: a top-up of 0; the floor raised to 1 TAO, above the net
      w.vault.payoutFee = FEE;
      const values = floorAt(w, TAO);
      const lines: string[] = [];
      await payoutsV32(depsFor(w, freshMemory(), d, (l) => lines.push(l)).deps, target, KEY_A);
      // first the top-up alone (0), as always; then, refused for the floor, the whole fee
      expect(values).toEqual([0n, FEE]);
      expect(w.sends.map((s) => [s.fn, s.value])).toEqual([["processPayouts", FEE]]);
      expect(lines).toContain(
        `Payout batch ${KEY_A.slice(0, 10)}…: its net after the entries' fee, 0.999 TAO, is under the chain's conversion floor, 1 TAO (BelowConversionFloor): the keeper sends the full top-up, the whole 0.001 TAO bridge fee (0.001 TAO more than the top-up the quote asks), so its entries are sent their gross, 1 TAO`,
      );
    });

    it("the floor above even the chunk's gross: no top-up helps, so it waits for the floor to fall or a new route; nothing is sent", async () => {
      const w = world();
      queue(w, KEY_A, one);
      w.vault.payoutFee = FEE;
      const values = floorAt(w, 2n * TAO);
      const e = await payoutsV32(depsFor(w).deps, target, KEY_A).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Waits);
      expect((e as Error).message).toBe(
        `payout batch ${KEY_A.slice(0, 10)}… waits: the chain's conversion floor, 2 TAO, is above even its chunk's gross, 1 TAO (BelowConversionFloor): no top-up helps; it waits for the floor to fall or for a new route`,
      );
      expect(values).toEqual([0n]);
      expect(w.sends).toEqual([]);
    });

    describe("merge 7b (review M5): the full top-up's waits say why", () => {
      /** The world's simulations of processPayouts: the first (the top-up alone) and the second (the full top-up) refused
       * as given */
      const refusedTwice = (w: World, first: { error: string; args?: unknown[] }, second: { error: string; args?: unknown[] }) => {
        const values: bigint[] = [];
        w.simulate = (c) => {
          if (c.fn !== "processPayouts") return 200_000n;
          values.push(c.value);
          return values.length === 1 ? first : second;
        };
        return values;
      };
      const due = (o: { balance?: bigint } = {}) => {
        const w = world();
        queue(w, KEY_A, one);
        w.vault.payoutFee = FEE;
        if (o.balance !== undefined) w.vault.balance = o.balance;
        return w;
      };
      const waits = async (w: World, deps = depsFor(w).deps) => {
        const e = await payoutsV32(deps, target, KEY_A).catch((x: unknown) => x);
        expect(e).toBeInstanceOf(Waits);
        return (e as Error).message;
      };

      it("a reason that names no floor: the full top-up is never tried, and the wait says so, never that it was refused", async () => {
        const w = due();
        const { deps } = depsFor(w);
        const send = deps.sendCall;
        let sends = 0;
        deps.sendCall = async (req) => {
          sends++;
          if (req.functionName === "processPayouts") throw new SendRefused("estimate", "Bittensor: pay out batch 0xabababab… to Base would fail, nothing sent (BelowConversionFloor())");
          return send(req);
        };
        expect(await waits(w, deps)).toBe(
          `payout batch ${KEY_A.slice(0, 10)}… waits: the chain's conversion floor refuses its net (BelowConversionFloor), but the reason names no floor to judge the full top-up by, so it isn't tried; the next round decides again`,
        );
        expect(sends).toBe(1);
      });

      it("the full top-up refused for a walk's cost (the leaver pays, spec §3.3): said, and paid once liquid TAO covers it without a walk", async () => {
        const w = due({ balance: TAO / 2n });
        const values = refusedTwice(w, { error: "BelowConversionFloor", args: [TAO - FEE, TAO] }, { error: "BelowConversionFloor", args: [TAO - 2n * FEE, TAO] });
        expect(await waits(w)).toBe(
          `payout batch ${KEY_A.slice(0, 10)}… waits: even with the full top-up its net is under the chain's conversion floor, 1 TAO: its walk's cost falls on its entries (the leaver pays, spec §3.3), so it is paid once liquid TAO covers it without a walk (BelowConversionFloor)`,
        );
        expect(values).toEqual([0n, FEE]);
        expect(w.sends).toEqual([]);
      });

      it("the full top-up refused with no walk: the fee or the floor moved since the quote; a floor now above the gross is the residual", async () => {
        // liquid TAO covers the chunk: no walk
        const w = due({ balance: 5n * TAO });
        refusedTwice(w, { error: "BelowConversionFloor", args: [TAO - FEE, TAO] }, { error: "BelowConversionFloor", args: [TAO - FEE, TAO] });
        expect(await waits(w)).toBe(
          `payout batch ${KEY_A.slice(0, 10)}… waits: the chain's conversion floor refused it with the full top-up too (BelowConversionFloor): the fee or the floor moved since the quote; the next round decides again`,
        );
        const x = due({ balance: 5n * TAO });
        refusedTwice(x, { error: "BelowConversionFloor", args: [TAO - FEE, TAO] }, { error: "BelowConversionFloor", args: [TAO, 2n * TAO] });
        expect(await waits(x)).toBe(
          `payout batch ${KEY_A.slice(0, 10)}… waits: the chain's conversion floor, 2 TAO, is above even its chunk's gross, 1 TAO (BelowConversionFloor): no top-up helps; it waits for the floor to fall or for a new route`,
        );
      });
    });

    it("never more than the top-up unless choosing the full top-up: a payout under the floor-free chain sends the top-up alone", async () => {
      const w = world();
      queue(w, KEY_A, one);
      w.vault.payoutFee = QUOTE;
      const values = floorAt(w, 0n);
      await payoutsV32(depsFor(w, freshMemory(), deploymentFor({ payoutTopUpMax: 6n * 10n ** 15n })).deps, target, KEY_A);
      expect(values).toEqual([5_000_001n * RAO]);
      expect(w.sends.map((s) => s.value)).toEqual([5_000_001n * RAO]);
    });

    it("the chunk said from its PayoutChunkSent: the entries' share and the keeper's; a quote that fell to the value sent made the keeper pay the whole fee, never more than it sent", async () => {
      const w = world();
      queue(w, KEY_A, one);
      w.vault.payoutFee = QUOTE;
      // the quote fell to 0.004 TAO between the read and the block, at or below the 0.005000001 TAO top-up sent: the vault
      // charged the entries nothing and the keeper the whole fee, and refunded the rest
      w.receiptLogs = (c) => (c.fn === "processPayouts" ? [chunkSentLog({ fee: 4n * 10n ** 15n, charged: 0n, net: TAO })] : []);
      const lines: string[] = [];
      await payoutsV32(depsFor(w, freshMemory(), deploymentFor({ payoutTopUpMax: 6n * 10n ** 15n }), (l) => lines.push(l)).deps, target, KEY_A);
      expect(lines).toContain(
        `Payout chunk of batch ${KEY_A.slice(0, 10)}…: 1 TAO sent; the entries paid 0 TAO of the 0.004 TAO bridge fee, the keeper 0.004 TAO (the quote fell to at or below the 0.005000001 TAO top-up it sent, so the vault charged it the whole fee and refunded the rest)`,
      );
      // as quoted: the entries their share, the keeper the rest
      const x = world();
      queue(x, KEY_A, one);
      x.vault.payoutFee = QUOTE;
      x.receiptLogs = (c) => (c.fn === "processPayouts" ? [chunkSentLog({ fee: 20_000_001n * RAO, charged: 15n * 10n ** 15n, net: TAO - 15n * 10n ** 15n })] : []);
      const said: string[] = [];
      await payoutsV32(depsFor(x, freshMemory(), deploymentFor({ payoutTopUpMax: 6n * 10n ** 15n }), (l) => said.push(l)).deps, target, KEY_A);
      expect(said).toContain(`Payout chunk of batch ${KEY_A.slice(0, 10)}…: 0.985 TAO sent; the entries paid 0.015 TAO of the 0.020000001 TAO bridge fee, the keeper 0.005000001 TAO`);
    });
  });

  it("its gas: the estimate plus EXIT_GAS_RESERVE + listed positions × unstakeGas (Task 20); maxEntries 50", async () => {
    const w = world();
    queue(w, KEY_A, one);
    w.vault.hotkeyCount = 3;
    await payoutsV32(depsFor(w).deps, target, KEY_A);
    expect(w.sends[0].gas).toBe(200_000n + EXIT_GAS_RESERVE + 3n * 400_000n);
    expect(w.sends[0].args[2]).toBe(50);
  });

  it("the planner's face-value coverage (the leaver pays): stake that can't cover the walk waits; a walk's cost refusing the chunk waits too", async () => {
    // free TAO 0.5 (less ED_RESERVE), the chunk 1 TAO: the walk asks the rest and 1,000 rao more, at face value
    const thin = inputs({ balance: TAO / 2n, visibleStakeRao: TAO / 10n / RAO });
    const p = planPayout(one, thin, 10n ** 15n, 0n);
    expect(p).toMatchObject({ go: false, why: "unstake-short" });
    const need = TAO - (TAO * 10n ** 15n) / TAO + 10n ** 15n; // net + charged
    expect(p.walk).toBe(need - (TAO / 2n - 10n ** 12n) + SHORTFALL_TOLERANCE_WEI);
    expect(planPayout(one, inputs({ balance: TAO / 2n }), 10n ** 15n, 0n)).toMatchObject({ go: true, walk: p.walk });
    // the vault refuses only past the tolerance unmet (CascadeVault _unstake): stake at walk - 1,000 rao goes, a rao
    // less waits (T50 review M2)
    const edge = (p.walk - SHORTFALL_TOLERANCE_WEI) / RAO;
    expect(planPayout(one, inputs({ balance: TAO / 2n, visibleStakeRao: edge }), 10n ** 15n, 0n)).toMatchObject({ go: true, walk: p.walk });
    expect(planPayout(one, inputs({ balance: TAO / 2n, visibleStakeRao: edge - 1n }), 10n ** 15n, 0n)).toMatchObject({ go: false, why: "unstake-short" });
    // the liquid TAO covers it: no walk
    expect(planPayout(one, inputs(), 10n ** 15n, 0n)).toMatchObject({ go: true, walk: 0n });

    // the simulation answers FeeTooHigh while the chunk walks: its walk's cost would leave an entry nothing
    const w = world();
    queue(w, KEY_A, one);
    w.vault.balance = TAO / 2n;
    w.simulate = (c) => (c.fn === "processPayouts" ? { error: "FeeTooHigh" } : 200_000n);
    const e = await payoutsV32(depsFor(w).deps, target, KEY_A).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Waits);
    expect((e as Error).message).toMatch(/its walk's cost would leave an entry nothing \(FeeTooHigh; the leaver pays\), so it is paid once liquid TAO covers it without a walk/);
  });

  it("the chunk is the contract's: 50 entries at most, the message cap, a short tail folded in", () => {
    const many = Array.from({ length: 60 }, (_, i) => redeem(at((0x1000 + i).toString(16)), 1n, TAO / 10n));
    expect(takeChunk(many, 0, 50, 15n * TAO, 10).entries).toHaveLength(50);
    // 55 left of 60 with minChunk 10: 50, then the last 5 can't fold in (55 > 50)
    expect(takeChunk(many, 5, 50, 15n * TAO, 10).entries).toHaveLength(50);
    // 8 entries left after 42: folded in, all 8, within the cap and 50
    expect(takeChunk(many.slice(0, 50), 0, 45, 15n * TAO, 10).entries).toHaveLength(50);
    // the cap: 15 TAO of 1 TAO entries is 15, and the first is taken even above it
    const big = Array.from({ length: 20 }, () => redeem(ALICE, 1n, TAO));
    expect(takeChunk(big, 0, 50, 15n * TAO, 1).sum).toBe(15n * TAO);
    expect(takeChunk([redeem(ALICE, 1n, 20n * TAO)], 0, 50, 15n * TAO, 1).sum).toBe(20n * TAO);
    // the message the fee is quoted on: abi.encode(2, key, chunk, entries)
    const [kind, key, chunk, entries] = decodeAbiParameters(parseAbiParameters("uint8, bytes32, uint32, (address user, uint256 amount)[]"), encodePayouts(KEY_A, 3, [{ user: ALICE, amount: TAO }]));
    expect([kind, key, chunk, entries]).toEqual([2, KEY_A, 3, [{ user: ALICE, amount: TAO }]]);
    // a shares entry the split would zero: FeeTooHigh (B11: unreachable under the bounds); a bounce is dust
    expect(deductFee([redeem(ALICE, 1n, 10n ** 9n), redeem(BOB, 1n, TAO)], 0, 2, 10n ** 16n, TAO + 10n ** 9n).zeroed).toBe(0);
    const dust = deductFee([bounce(ALICE, 10n ** 9n), redeem(BOB, 1n, TAO)], 0, 2, 10n ** 16n, TAO + 10n ** 9n);
    expect([dust.dust, dust.zeroed]).toEqual([1, undefined]);
  });
});

describe("each new revert, as the plan classifies it", () => {
  const one = [redeem(ALICE, TAO, TAO)];
  const payoutRefused = async (error: string) => {
    const w = world();
    queue(w, KEY_A, one);
    // liquid TAO covers the chunk: no walk
    w.vault.balance = 5n * TAO;
    w.simulate = (c) => (c.fn === "processPayouts" ? { error } : 200_000n);
    return { w, e: await payoutsV32(depsFor(w).deps, target, KEY_A).catch((x: unknown) => x) };
  };

  it("the table: every name the plan lists, plus BadValue", () => {
    expect(Object.fromEntries(Object.entries(REVERTS_V32).map(([k, v]) => [k, v.class]))).toEqual({
      WrongBatch: "reread",
      BatchTooSmall: "reread",
      StakeMissing: "stop-staking",
      UnstakeShort: "wait",
      FeeTooHigh: "top-up",
      NothingToCancel: "final",
      ThinPool: "skip-delivery",
      NotScheduled: "report",
      AboveBridgeCap: "report",
      BadValue: "stop",
      // merge 7b: the chain's conversion floor above a chunk's net: the keeper chooses the full top-up
      BelowConversionFloor: "full-top-up",
      // Revision 28's gas guard (and a claim's claimGasRequired): the call ran short of gas; the next round estimates again
      InsufficientGas: "wait",
      // R11: only a depositor's own cancel inside its five-minute cooldown reverts it; the keeper never cancels
      CancelTooSoon: "report",
      // R12f: a cancel since the read took the batch under every line that let it close; read again once (see close by id)
      BatchNotReady: "not-closable",
    });
    expect(classifyRevert("Bittensor: stake the vault's idle TAO would fail, nothing sent (InsufficientGas())")).toMatchObject({ name: "InsufficientGas", class: "wait" });
    expect(classifyRevert("Bittensor: pay out batch 0xaa… to Base would fail, nothing sent (UnstakeShort())")).toMatchObject({ name: "UnstakeShort", class: "wait" });
    expect(classifyRevert("ThinPool(0, 12345)")).toMatchObject({ name: "ThinPool", class: "skip-delivery" });
    expect(classifyRevert("Too little received")).toEqual({ name: undefined, class: undefined, why: undefined });
  });

  it("R11: CancelTooSoon names the second the cancel works from, its one argument read by position, in UTC", () => {
    const at = 1_900_000_300;
    const c = classifyRevert(`Base: cancel 0.04 TAO would fail, nothing sent (CancelTooSoon(${at}))`);
    expect(c).toMatchObject({ name: "CancelTooSoon", class: "report" });
    expect(c.why).toBe(`a depositor's cancel inside its five-minute cooldown (CANCEL_COOLDOWN after its last deposit): it works from ${new Date(at * 1000).toISOString()} (unix ${at}); no keeper call cancels`);
    // with no readable time, the rule alone
    expect(classifyRevert("CancelTooSoon()").why).toBe("a depositor's cancel inside its five-minute cooldown (CANCEL_COOLDOWN after its last deposit); no keeper call cancels");
  });

  it("WrongBatch: another close landed first; the close reads again (see close by id)", () => {
    expect(classifyRevert("WrongBatch(8)").class).toBe("reread");
  });

  it("BatchTooSmall: a deposit cancelled under the close; read again (see close by id)", () => {
    expect(classifyRevert("BatchTooSmall()").class).toBe("reread");
  });

  it("BatchNotReady (R12f): the batch can't close now, a cancel since the read; read again once, a batch no longer closable the round's quiet skip (see close by id)", () => {
    expect(classifyRevert("Base: close the open batch and send it to Bittensor would fail, nothing sent (BatchNotReady())")).toMatchObject({ name: "BatchNotReady", class: "not-closable" });
  });

  it("StakeMissing: staking stops and says so; the round's close waits too, since the vault would refuse the batch (Task 52w fix)", async () => {
    const w = world();
    w.vault.balance = 10n * TAO;
    w.vault.stakeMissing = true;
    w.door.start = BigInt(T - 90_000);
    const lines: string[] = [];
    const m = freshMemory();
    await runRound(depsFor(w, m, d, (l) => lines.push(l)).deps, target, m, { ...OPTS, now: () => T * 1000 });
    expect(w.sends.map((s) => s.fn)).toEqual([]);
    expect(lines.at(-1)).toMatch(/^nothing due: closing waits: some of the vault's stake is not on a listed hotkey \(stake missing\), so a batch sent now would park on Bittensor/);
    // nothing else due: the reason says why staking waits
    const v = world();
    v.vault.balance = 10n * TAO;
    v.vault.stakeMissing = true;
    v.door.canClose = false;
    const said: string[] = [];
    const mv = freshMemory();
    await runRound(depsFor(v, mv, d, (l) => said.push(l)).deps, target, mv, { ...OPTS, now: () => T * 1000 });
    expect(said).toContain("nothing due: staking waits: some of the vault's stake is not on a listed hotkey (stake missing), which needs the owner or the guardian");
    // a stake its simulation refuses StakeMissing waits, never fails the keeper
    const x = world();
    x.vault.balance = 10n * TAO;
    x.simulate = (c) => (c.fn === "stakeIdle" ? { error: "StakeMissing" } : 200_000n);
    const e = await stakeV32(depsFor(x).deps, target).catch((y: unknown) => y);
    expect(e).toBeInstanceOf(Waits);
    expect(classifyFailure(e).stop).toBe(false);
  });

  it("UnstakeShort: the payout waits (the buffer rule)", async () => {
    const { w, e } = await payoutRefused("UnstakeShort");
    expect(e).toBeInstanceOf(Waits);
    expect((e as Error).message).toMatch(/the buffer rule: an idleBufferBps that keeps the payouts liquid/);
    expect(w.sends).toEqual([]);
  });

  it("FeeTooHigh with no walk: the fee rose past what the entries pay and the top-up allowed: it waits", async () => {
    const { e } = await payoutRefused("FeeTooHigh");
    expect(e).toBeInstanceOf(Waits);
    expect((e as Error).message).toMatch(/its bridge fee rose above what its entries pay and the 0 TAO the keeper may add \(FeeTooHigh\)/);
  });

  it("nothingToCancelIsFinal: NothingToCancel is said once and the payout is never tried again", async () => {
    const { e } = await payoutRefused("NothingToCancel");
    expect(e).toBeInstanceOf(FinalRefusal);
    expect(classifyFailure(e)).toMatchObject({ stop: false, kind: "final" });

    const w = world();
    queue(w, KEY_A, one);
    w.door.canClose = false;
    let tries = 0;
    w.simulate = (c) => (c.fn === "processPayouts" ? (tries++, { error: "NothingToCancel" }) : 200_000n);
    const lines: string[] = [];
    let saved = encodeMemory(freshMemory());
    for (let i = 0; i < 4; i++) {
      const { memory } = loadMemory(saved);
      const r = await runRound(depsFor(w, memory, d, (l) => lines.push(l)).deps, target, memory, { ...OPTS, now: () => (T + i * 60) * 1000 });
      expect(r.end).toBeUndefined();
      saved = encodeMemory(r.memory);
    }
    expect(tries).toBe(1);
    expect(lines.filter((l) => l.startsWith("FINAL: paying out batch 0xabababab…"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("not tried again (see FINAL above)"))).toHaveLength(4);
  });

  it("ThinPool: the delivery is skipped and retried, never a strike (the class; Task 50a wires deliveries)", () => {
    expect(classifyRevert("ThinPool(1, 77)").class).toBe("skip-delivery");
  });

  it("NotScheduled and AboveBridgeCap: never a keeper call: reported loudly, not tried again", async () => {
    for (const name of ["NotScheduled", "AboveBridgeCap"]) {
      const { e } = await payoutRefused(name);
      expect(e, name).toBeInstanceOf(FinalRefusal);
      expect((e as Error).message, name).toMatch(/^REPORT: /);
    }
  });

  it("BadValue: the keeper's own top-up wasn't whole rao, a keeper bug: it stops", async () => {
    const { e } = await payoutRefused("BadValue");
    expect(e).toBeInstanceOf(KeeperBug);
    expect(classifyFailure(e)).toMatchObject({ stop: true, kind: "keeper-bug" });
  });
});

describe("a v3.2 send its simulation passed but the chain reverted is taken by its reason, as a refused simulation is (T50 review I1)", () => {
  const one = [redeem(ALICE, TAO, TAO)];
  const HASH = /transaction 0x[0-9a-f]{64} reverted on chain/;

  /** `fn` passes its simulation and is mined reverted; its replay at the block names `reason` (send.ts revertReason). */
  function minedRevert(w: World, to: Address, fn: string, reason: string, args: unknown[] = []) {
    const before = w.fate;
    w.fate = (c) => (c.fn === fn ? "revert" : before(c));
    // the door's closeBatch is not among the reads' fragments: the replay needs it
    if (fn === "closeBatch") w.fns.push(...(KEEPER_CALLS_V32 as readonly AbiFunction[]).filter((f) => f.type === "function" && f.name === "closeBatch"));
    w.answers[`${to.toLowerCase()}:${fn}`] = () => {
      throw revertWith(reason, args);
    };
  }
  /** A payout due, the liquid TAO covering it (no walk), nothing else due (the idle TAO below the staking floor). */
  function duePayout(): World {
    const w = world();
    queue(w, KEY_A, one);
    w.vault.balance = TAO + 10n ** 15n;
    w.door.canClose = false;
    return w;
  }
  /** `n` rounds on `w`, a minute apart, the memory through JSON between them. */
  async function rounds(w: World, n = 1) {
    const lines: string[] = [];
    const ends: unknown[] = [];
    let saved = encodeMemory(freshMemory());
    for (let i = 0; i < n; i++) {
      const { memory } = loadMemory(saved);
      const r = await runRound(depsFor(w, memory, d, (l) => lines.push(l)).deps, target, memory, { ...OPTS, now: () => (T + i * 60) * 1000 });
      ends.push(r.end);
      saved = encodeMemory(r.memory);
    }
    return { lines, ends, failed: lines.filter((l) => l.startsWith("Failed this round")) };
  }

  it("FeeTooHigh with no walk: the fee rose after the estimate: it waits within the top-up limit, and the breaker bounds the gas", async () => {
    const w = duePayout();
    minedRevert(w, ADDR.vault, "processPayouts", "FeeTooHigh");
    const { ends, failed, lines } = await rounds(w, 3);
    expect(ends).toEqual([undefined, undefined, undefined]);
    expect(failed[0]).toMatch(/^Failed this round \(it waits, paying out batch 0xabababab…\): payout batch 0xabababab… waits: its bridge fee rose above what its entries pay and the 0 TAO the keeper may add \(FeeTooHigh\); /);
    expect(failed[0]).toMatch(HASH);
    // a refusal for the breaker: the third skips it on a back-off, so a fee that keeps rising costs three reverts
    expect(lines.some((l) => l.startsWith("SKIPPING paying out batch 0xabababab…: refused 3 times in a row"))).toBe(true);
    expect(w.sends.map((s) => s.fn)).toEqual(["processPayouts", "processPayouts", "processPayouts"]);
  });

  it("merge 7b: BelowConversionFloor on chain (the floor rose after the simulation): it waits, and the next round's simulation decides the full top-up", async () => {
    const w = duePayout();
    minedRevert(w, ADDR.vault, "processPayouts", "BelowConversionFloor", [TAO - 10n ** 15n, TAO]);
    const { ends, failed } = await rounds(w);
    expect(ends).toEqual([undefined]);
    expect(failed[0]).toMatch(
      /payout batch 0xabababab… waits: the chain's conversion floor rose above its net after the simulation \(BelowConversionFloor\); transaction 0x[0-9a-f]{64} reverted on chain; the next round's simulation decides the full top-up/,
    );
  });

  it("FeeTooHigh while the chunk walks: its walk's cost (the leaver pays): it waits for liquid TAO", async () => {
    const w = duePayout();
    w.vault.balance = TAO / 2n;
    minedRevert(w, ADDR.vault, "processPayouts", "FeeTooHigh");
    const { ends, failed } = await rounds(w);
    expect(ends).toEqual([undefined]);
    expect(failed[0]).toMatch(/payout batch 0xabababab… waits: its walk's cost would leave an entry nothing \(FeeTooHigh; the leaver pays\), so it is paid once liquid TAO covers it without a walk; transaction 0x/);
  });

  it("UnstakeShort: a hold or another exit took the stake after the estimate: it waits (the buffer rule)", async () => {
    const w = duePayout();
    minedRevert(w, ADDR.vault, "processPayouts", "UnstakeShort");
    const { ends, failed } = await rounds(w);
    expect(ends).toEqual([undefined]);
    expect(failed[0]).toMatch(/payout batch 0xabababab… waits: the free TAO and the stake the walk can take don't cover the chunk \(UnstakeShort\); a deposit, a stake or a reward moves it \(the buffer rule: an idleBufferBps that keeps the payouts liquid\); transaction 0x/);
  });

  it("InsufficientGas on a payout (the gas guard: its gas ran short at a capped read): it waits, and the next round estimates again; never a stop", async () => {
    const w = duePayout();
    minedRevert(w, ADDR.vault, "processPayouts", "InsufficientGas");
    const { ends, failed } = await rounds(w);
    expect(ends).toEqual([undefined]);
    expect(failed[0]).toMatch(
      /payout batch 0xabababab… waits: the call ran short of gas \(the contract's gas guard: a capped read must start with its whole 100,000, a claim with its claimGasRequired\) \(InsufficientGas\); transaction 0x[0-9a-f]{64} reverted on chain; the next round estimates its gas again;/,
    );
  });

  it("InsufficientGas on a stake: it waits, never a stop (an unnamed mined revert would stop the keeper)", async () => {
    const w = world();
    w.vault.balance = 10n * TAO;
    minedRevert(w, ADDR.vault, "stakeIdle", "InsufficientGas");
    const e = await stakeV32(depsFor(w).deps, target).catch((y: unknown) => y);
    expect(e).toBeInstanceOf(Waits);
    expect((e as Error).message).toMatch(/^staking waits: the call ran short of gas .* \(InsufficientGas\); transaction 0x[0-9a-f]{64} reverted on chain; the next round decides again$/);
  });

  it("NothingToCancel: final, said once, never tried again", async () => {
    const w = duePayout();
    minedRevert(w, ADDR.vault, "processPayouts", "NothingToCancel");
    const { ends, lines } = await rounds(w, 3);
    expect(ends).toEqual([undefined, undefined, undefined]);
    expect(lines.filter((l) => l.startsWith("FINAL: paying out batch 0xabababab…: payout batch 0xabababab…: Bittensor:"))).toHaveLength(1);
    expect(lines.find((l) => l.startsWith("FINAL:"))).toMatch(/reverted on chain \(transaction 0x[0-9a-f]{64}, NothingToCancel\(\)\): what is left is bounced deposits/);
    expect(w.sends).toHaveLength(1);
  });

  it("NotScheduled and AboveBridgeCap: no keeper call should meet them: reported loudly, not tried again", async () => {
    for (const name of ["NotScheduled", "AboveBridgeCap"]) {
      const w = duePayout();
      minedRevert(w, ADDR.vault, "processPayouts", name);
      const { ends, lines } = await rounds(w, 2);
      expect(ends, name).toEqual([undefined, undefined]);
      expect(lines.filter((l) => l.startsWith("FINAL: paying out batch 0xabababab…: REPORT: payout batch 0xabababab…")), name).toHaveLength(1);
      expect(w.sends, name).toHaveLength(1);
    }
  });

  it("ThinPool, StakeMissing, WrongBatch or BatchTooSmall on a payout (none can come from one): a refusal, as its simulation's, never a stop", async () => {
    for (const name of ["ThinPool", "StakeMissing", "WrongBatch", "BatchTooSmall"]) {
      const w = duePayout();
      minedRevert(w, ADDR.vault, "processPayouts", name, name === "ThinPool" ? [1, 77n] : name === "WrongBatch" ? [8n] : []);
      const { ends, failed } = await rounds(w);
      expect(ends, name).toEqual([undefined]);
      expect(failed[0], name).toMatch(new RegExp(`^Failed this round \\(it waits, paying out batch 0xabababab…\\): payout batch 0xabababab… waits: .* \\(${name}\\); transaction 0x[0-9a-f]{64} reverted on chain; the next round decides again`));
    }
  });

  it("BadValue: the keeper's own top-up, a keeper bug: it stops as one, not as an unexplained revert", async () => {
    const w = duePayout();
    minedRevert(w, ADDR.vault, "processPayouts", "BadValue");
    const { ends } = await rounds(w);
    expect(ends[0]).toMatchObject({ stopped: true, kind: "keeper-bug" });
  });

  it("StakeMissing on a stake: staking waits, said loudly; the keeper goes on", async () => {
    const w = world();
    w.vault.balance = 10n * TAO;
    w.door.canClose = false;
    minedRevert(w, ADDR.vault, "stakeIdle", "StakeMissing");
    const { ends, failed } = await rounds(w);
    expect(ends).toEqual([undefined]);
    expect(failed[0]).toMatch(/^Failed this round \(it waits, staking\): staking waits: some of the vault's stake is not on a listed hotkey \(StakeMissing\), which needs the owner or the guardian; the keeper's other work goes on; transaction 0x/);
    expect(w.sends.map((s) => s.fn)).toEqual(["stakeIdle"]);
  });

  it("WrongBatch or BatchTooSmall on a close: the batch changed after the estimate: it waits, and the next round reads it again (no second send); R12h: the replay names the door's own reason at its block, so it is the round's quiet skip whatever the batch read again (R12g counted it while batch 7 read again still open and closable as it was sent: keeper-v32-r12h.test.ts)", async () => {
    for (const [name, args] of [
      ["WrongBatch", [8n]],
      ["BatchTooSmall", []],
    ] as const) {
      const w = world();
      w.door.start = BigInt(T - 90_000);
      minedRevert(w, ADDR.frontDoor, "closeBatch", name, [...args]);
      const { ends, failed, lines } = await rounds(w);
      expect(ends, name).toEqual([undefined]);
      expect(failed, name).toEqual([]);
      expect(lines, name).toContainEqual(
        expect.stringMatching(
          new RegExp(`^Skipped this round \\(closing the batch\\): batch 7 changed under the close after its simulation passed \\(${name}: .*\\); transaction 0x[0-9a-f]{64} reverted on chain; its replay names that at the block it was mined in or the one before, whatever the batch holds now; the next round decides again$`),
        ),
      );
      expect(w.sends.map((s) => s.fn), name).toEqual(["closeBatch"]);
    }
  });

  it("a close the chain reverted with a reason its simulation would only have refused (AboveBridgeCap): a refusal, not a final one", async () => {
    const w = world();
    w.door.start = BigInt(T - 90_000);
    minedRevert(w, ADDR.frontDoor, "closeBatch", "AboveBridgeCap");
    const { ends, failed, lines } = await rounds(w);
    expect(ends).toEqual([undefined]);
    expect(failed[0]).toMatch(/^Failed this round \(it waits, closing the batch\): the close of batch 7 waits: only a limit setter reverts it; no keeper call should \(AboveBridgeCap\); transaction 0x/);
    expect(lines.some((l) => l.startsWith("FINAL:"))).toBe(false);
  });

  it("WrongBatch on a roll: another close or roll landed first: not rolled, as its refused simulation", async () => {
    const w = world();
    w.door.deposits = [];
    w.door.totalDeposits = 0n;
    minedRevert(w, ADDR.frontDoor, "closeBatch", "WrongBatch", [8n]);
    const { ends, lines } = await rounds(w);
    expect(ends).toEqual([undefined]);
    expect(lines).toContainEqual(expect.stringMatching(/^Not rolled: the open batch is another one now \(another close landed first\) \(WrongBatch\); the roll reverted on chain \(transaction 0x[0-9a-f]{64}\); the next round decides again$/));
  });

  it("a revert no reason explains, and no race: it still stops the keeper", async () => {
    const w = duePayout();
    // a reason the table doesn't name
    minedRevert(w, ADDR.vault, "processPayouts", "BelowMinimum");
    const { ends } = await rounds(w);
    expect(ends[0]).toMatchObject({ stopped: true, kind: "reverted" });
    // and none at all (the replay goes through)
    const v = duePayout();
    v.fate = (c) => (c.fn === "processPayouts" ? "revert" : "mine");
    v.answers[`${ADDR.vault.toLowerCase()}:processPayouts`] = () => [];
    expect((await rounds(v)).ends[0]).toMatchObject({ stopped: true, kind: "reverted" });
  });
});

describe("R12d (a nit): doorLimitsFull is CascadeFrontDoor.canClose() without its clock, clause for clause, as the source in this tree has it", () => {
  /** canClose()'s body in contracts/src/CascadeFrontDoor.sol, its comments dropped and its whitespace collapsed */
  const canCloseBody = (): string => {
    const text = src("CascadeFrontDoor.sol");
    const head = "function canClose() public view returns (bool) {";
    const start = text.indexOf(head);
    if (start < 0) throw new Error(`CascadeFrontDoor.sol has no "${head}": the keeper's doorLimitsFull can't be held to it`);
    let depth = 0;
    let end = -1;
    for (let i = start + head.length - 1; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    return text
      .slice(start + head.length, end)
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\s+/g, " ")
      .trim();
  };
  const BY_TIME = "if (block.timestamp >= uint256(open.start) + batchInterval) return true;";
  const VALUE =
    "uint256 total = open.totalDeposits; if (total == 0) return false; uint256 limit = maxBatchValue; uint256 withAMinimum = total + minDeposit; if (2 * total >= limit || withAMinimum > limit) return true; uint256 forwarded = netForwarded; uint256 cap = depositCap; return forwarded + 2 * total >= cap || forwarded + withAMinimum > cap;";
  /** build B's door (the list half rule, ae474d1): what doorLimitsFull mirrors, and the one text this test takes. R12e: the
   * R11 door (its deposit list closing only at full) no longer passes with a warning, so this fails until the build-B door
   * is merged into this tree, as the web's two BUILD-B GATE pins do */
  const BUILD_B = `${BY_TIME} if (2 * open.deposits.length >= maxDeposits || open.redeems.length >= maxRedeems) return true; ${VALUE}`;
  type B = { deposits: number; redeems: number; totalDeposits: bigint };
  type L = { maxDeposits: number; maxRedeems: number; maxBatchValue: bigint; minDeposit: bigint; depositCap: bigint; netForwarded: bigint };
  /** canClose() as that text reads, without its clock (Solidity's uint256: no overflow at these sizes) */
  const transcribed = (b: B, l: L): boolean => {
    if (2 * b.deposits >= l.maxDeposits || b.redeems >= l.maxRedeems) return true;
    const total = b.totalDeposits;
    if (total === 0n) return false;
    const withAMinimum = total + l.minDeposit;
    if (2n * total >= l.maxBatchValue || withAMinimum > l.maxBatchValue) return true;
    return l.netForwarded + 2n * total >= l.depositCap || l.netForwarded + withAMinimum > l.depositCap;
  };
  /** every batch and limits of a grid around each line */
  const grid = function* (): Generator<[B, L]> {
    for (const maxDeposits of [50, 49, 1])
      for (const deposits of [0, 1, 24, 25, 26, 48, 49, 50])
        for (const redeems of [0, 49, 50])
          for (const totalDeposits of [0n, 1n, 2n * TAO, 4_999_999_999_999_999_999n, 5n * TAO, 996n * 10n ** 16n, 997n * 10n ** 16n, 10n * TAO])
            for (const netForwarded of [0n, 30n * TAO, 3999n * 10n ** 16n, 41n * TAO])
              yield [{ deposits, redeems, totalDeposits }, { maxDeposits, maxRedeems: 50, maxBatchValue: 10n * TAO, minDeposit: 4n * 10n ** 16n, depositCap: 40n * TAO, netForwarded }];
  };

  it("BUILD-B GATE (fails on the R11 door): the source is build B's canClose(), its deposit list full at half its limit, and the mirror agrees with it on every case of the grid; any other text fails, naming what it found", () => {
    const found = canCloseBody();
    if (found !== BUILD_B) {
      throw new Error(
        `CascadeFrontDoor.canClose() is not build B's door, which the keeper's doorLimitsFull (ops/src/keeper/core/v32/reads.ts) mirrors: merge the build-B door, or change the mirror (and fullCloseFloor, the web's closeFirstFloor, the monitor's batch.deposits_full) with it.
found:    ${found}
expected: ${BUILD_B}`,
      );
    }
    for (const [b, l] of grid()) {
      const said = `${JSON.stringify(b, (_k, v) => (typeof v === "bigint" ? String(v) : v))} at ${JSON.stringify(l, (_k, v) => (typeof v === "bigint" ? String(v) : v))}`;
      expect(doorLimitsFull(b, l), said).toBe(transcribed(b, l));
    }
  });
});

describe("the bounce outlook: the underwater rule and its 1,000-rao constant (T10c)", () => {
  it("the constants are the contracts'", () => {
    expect(src("CascadeConstants.sol")).toMatch(/uint256 constant UNDERWATER_TOLERANCE = 1_000 \* RAO;/);
    expect(UNDERWATER_TOLERANCE_WEI).toBe(1_000n * RAO);
    expect(src("CascadeVault.sol")).toMatch(/insolvent: A \* 2_000_000 < S,/);
    expect(HALF_LAUNCH_SHARES_PER_WEI).toBe(2_000_000n);
    expect(src("libraries/CascadeFormulas.sol")).toMatch(
      /if \(unvested != 0\) return unvested > sub0\(gross, pendingPayouts\);\s+return sub0\(pendingPayouts, gross\) > UNDERWATER_TOLERANCE;/,
    );
    expect(src("libraries/CascadeMessages.sol")).toMatch(/uint256 internal constant MAX_ENTRIES = 50;/);
    expect(MAX_ENTRIES).toBe(50);
    expect(src("CascadeConstants.sol")).toMatch(/uint256 constant EXIT_GAS_RESERVE = 2_000_000;/);
    expect(EXIT_GAS_RESERVE).toBe(2_000_000n);
    expect(src("CascadeVault.sol")).toMatch(/uint256 internal constant SHORTFALL_TOLERANCE_RAO = 1_000;/);
    expect(SHORTFALL_TOLERANCE_WEI).toBe(1_000n * RAO);
  });

  it("at a supply of 0 a hole past 1,000 rao parks the batch; within it, it mints; with shares, below half the launch price bounces", () => {
    const v = { grossAssets: 10n * TAO, pendingPayouts: 10n * TAO, unvestedRewards: 0n, totalAssets: 0n, totalSupply: 0n };
    expect(depositOutlook({ ...v, pendingPayouts: 10n * TAO + 1_000n * RAO })).toBe("mint");
    expect(depositOutlook({ ...v, pendingPayouts: 10n * TAO + 1_000n * RAO + 1n })).toBe("park");
    // at a supply of 0 the schedule is written down first: vesting never parks a batch the payouts don't
    expect(depositOutlook({ ...v, unvestedRewards: 5n * TAO })).toBe("mint");
    expect(underwater(10n * TAO, 10n * TAO, 5n * TAO)).toBe(true);
    const s = { grossAssets: 10n * TAO, pendingPayouts: 0n, unvestedRewards: 0n, totalAssets: 10n * TAO, totalSupply: 10n * TAO * 1_000_000n };
    expect(depositOutlook(s)).toBe("mint");
    expect(depositOutlook({ ...s, totalAssets: s.totalSupply / 2_000_000n - 1n })).toBe("bounce");
  });

  it("a close of a batch with deposits the vault won't mint for says so, and closes", async () => {
    const w = world();
    // its pot covering the bridge fee: the close rule closes it (R12d, L-1: on the close's own read too)
    w.door.feePot = 2n * w.door.closeFee;
    w.vault.totalSupply = 0n;
    w.vault.pending = 3n * TAO;
    w.vault.grossAssets = TAO;
    const lines: string[] = [];
    await closeV32(depsFor(w, freshMemory(), d, (l) => lines.push(l)).deps, target);
    expect(lines).toContain("The vault is underwater with no shares: it will refuse this batch, and the bridge adapter will hold it until it can be delivered or refunded");
    expect(w.sends.map((x) => x.fn)).toEqual(["closeBatch"]);
  });
});

describe("the 24 h max wait is the web's own (T43a's review M2)", () => {
  it("from the web's deployments.json entry, else what web-config gives the site; the v3-launch entry agrees", () => {
    expect(batchMaxWaitOf({ batchMaxWaitS: 43_200 })).toBe(43_200);
    expect(batchMaxWaitOf(undefined)).toBe(CADENCE.launch.closeMaxWaitS);
    expect(CADENCE.launch.closeMaxWaitS).toBe(86_400);
    // the site's own value for v3-launch is the launch cadence's: one value, read by the keeper and the web alike
    expect(webEntry("v3-launch")?.batchMaxWaitS).toBe(CADENCE.launch.closeMaxWaitS);
    // web-config writes the same constant for a v3.2 site
    expect(readFileSync(new URL("../src/webconfig.ts", import.meta.url), "utf8")).toMatch(/NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S=\$\{CADENCE\.launch\.closeMaxWaitS\}/);
    expect(() => batchMaxWaitOf({ batchMaxWaitS: "86400" })).toThrow(/not a number of seconds/);
    expect(usdcDeliveryOf(undefined)).toBe(true);
    expect(usdcDeliveryOf({ usdcDelivery: false })).toBe(false);
    expect(usdcDeliveryOf({ usdcDelivery: "no" })).toBe(false);
  });

  it("the round holds a batch with entries for the deployment's max wait, then closes it", async () => {
    for (const [age, closes] of [
      [86_399, false],
      [86_400, true],
    ] as const) {
      const w = world();
      w.door.start = BigInt(T - age);
      // its fees never cover the bridge fee here (0.1 ETH: within the world's 1 ETH spend cap, which since R12a counts the
      // quote the close keeps)
      w.door.closeFee = 10n ** 17n;
      const m = freshMemory();
      await runRound(depsFor(w, m).deps, target, m, { ...OPTS, now: () => T * 1000 });
      expect(w.sends.length, String(age)).toBe(closes ? 1 : 0);
    }
  });
});

describe("a v3.2 run split across invocations", () => {
  it("aRunSplitAcrossInvocationsBehavesAsOneLoop on v3.2: deps built afresh each round from the memory's cursors", async () => {
    const run = async (split: boolean) => {
      const w = world();
      queue(w, KEY_A, [bounce(ALICE, TAO), redeem(BOB, TAO, TAO)]);
      w.door.canClose = false;
      const lines: string[] = [];
      let memory: KeeperMemory = freshMemory();
      let saved = encodeMemory(memory);
      for (let i = 0; i < 4; i++) {
        if (split) memory = loadMemory(saved).memory;
        // each round: new logs arrive, the head moves on
        w.head.bittensor += 100n;
        if (i === 2) w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "PayoutBatchQueued", args: { key: `0x${"cd".repeat(32)}`, sourceChain: 8453n, batchId: 8n, count: 1, total: TAO, price: 1n }, block: w.head.bittensor - 50n });
        const r = await runRound(depsFor(w, memory, d, (l) => lines.push(l)).deps, target, memory, { ...OPTS, now: () => (T + i * 60) * 1000 });
        saved = encodeMemory(r.memory);
        // a sent payout's batch moves on
        for (const s of w.sends.splice(0)) lines.push(`SENT ${s.fn} ${String(s.args[0])}`);
      }
      return { lines, memory: saved, calls: w.calls.length };
    };
    const one = await run(false);
    const split = await run(true);
    expect(split.lines).toEqual(one.lines);
    expect(split.memory).toEqual(one.memory);
    expect(split.calls).toBe(one.calls);
    expect(one.lines.some((l) => l.startsWith(`SENT processPayouts ${KEY_A}`))).toBe(true);
  });
});

describe("the v3.2 reads keep their place in the memory", () => {
  it("each round's log scans start from the memory's cursor (REREAD blocks back), not from the deploy block", async () => {
    const w = world();
    queue(w, KEY_A, [bounce(ALICE, TAO)]);
    const m = freshMemory();
    await depsFor(w, m).deps.payoutLogs();
    const first = w.logQueries.splice(0);
    // the first scan reads from the deploy block on, in the RPC's windows
    expect(first.map((q) => q.from).sort((x, y) => (x < y ? -1 : 1))[0]).toBe(100n);
    // a new invocation, its deps built afresh from the saved memory: it reads on from where the last one stopped
    w.head.bittensor += 500n;
    const { memory } = loadMemory(encodeMemory(m));
    await depsFor(w, memory).deps.payoutLogs();
    const second = w.logQueries.splice(0);
    expect(second.length).toBeGreaterThan(0);
    expect(second.every((q) => q.from === 10_000n + 1n - 400n)).toBe(true);
    // only open batches' logs are kept: a batch the vault deleted is let go of
    delete w.vault.batches[KEY_A.toLowerCase()];
    await depsFor(w, memory).deps.readState();
    expect(((memory.reads.v32 as { bounced: { kept: unknown[] } }).bounced.kept)).toEqual([]);
    // a rescan (a payout list that didn't match) reads every log again from the deploy block: the deleted batch's are
    // let go of at once, its queue log, its bounces and its redeems (T50 review M3)
    w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "Redeemed", args: { key: KEY_A, user: BOB, shares: TAO, assets: TAO }, block: 5_001n });
    const again = depsFor(w, memory).deps;
    again.rescanPayoutLogs();
    await again.readState();
    expect(await again.payoutLogs()).toEqual([]);
    const v = memory.reads.v32 as Record<"queued" | "bounced" | "redeemed", { kept: unknown[] }>;
    expect([v.queued.kept, v.bounced.kept, v.redeemed.kept]).toEqual([[], [], []]);
  });
});

describe("the v3.2 target", () => {
  it("is ready to send as the key its deps sign with (R4, D-M1: keeper() on both contracts decides, read each round, not the deployment's keeper), and refuses a delivery while usdcDelivery is off", () => {
    const { deps } = depsFor(world());
    expect(() => target.requireReady(KEY.address, deps)).not.toThrow();
    expect(() => targetV32(deploymentFor({ keeper: at("01d") })).requireReady(KEY.address, deps)).not.toThrow();
    expect(target.deliveryPlan()).toEqual({ addresses: { frontDoor: ADDR.frontDoor } });
    expect(() => targetV32(deploymentFor({ usdcDelivery: false })).deliveryPlan()).toThrow(/USDC delivery is off/);
  });

  it("a v3.2 target refuses v3-launch's deps", async () => {
    const w = world();
    const { deps } = depsFor(w);
    const { readPayoutInputs: _, ...launchLike } = deps;
    await expect(closeV32(launchLike as never, target)).rejects.toThrow(/needs the v3.2 deps/);
  });
});

// unused helpers kept for readability of the scenarios above
void revertWith;

describe("no close into a vault that would refuse the batch (Task 52w; T57c m2: the monitor can't hold the keeper there)", () => {
  const cases: [string, (w: World) => void, string][] = [
    ["the vault reads paused", (w) => void (w.vault.paused = true), "the vault is paused"],
    ["the launch door was removed by the owner", (w) => void (w.vault.doorState = 2), "the vault no longer takes the front door's batches (its door reads Removed there)"],
    ["the launch door was removed by the guardian", (w) => void (w.vault.doorState = 0), "the vault no longer takes the front door's batches (its door reads Unknown there)"],
    ["the vault reads stake missing (Task 52w fix)", (w) => void (w.vault.stakeMissing = true), "some of the vault's stake is not on a listed hotkey (stake missing)"],
  ];
  for (const [what, set, why] of cases) {
    it(`${what}: the round closes nothing and says why; a close by hand refuses; nothing is rolled either`, async () => {
      const w = world();
      w.door.start = BigInt(T - 90_000);
      set(w);
      const lines: string[] = [];
      const m = freshMemory();
      await runRound(depsFor(w, m, d, (l) => lines.push(l)).deps, target, m, { ...OPTS, now: () => T * 1000 });
      expect(w.sends).toEqual([]);
      const waits = `closing waits: ${why}, so a batch sent now would park on Bittensor; it stays on Base until the vault takes it again`;
      expect(lines).toContainEqual(`nothing due: ${waits}`);
      const e = await closeV32(depsFor(w).deps, target).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(NotNow);
      expect((e as Error).message).toBe(`not closing the batch: ${why}, so a batch sent now would park on Bittensor; it stays on Base until the vault takes it again`);
      // an empty batch is not rolled either: an entry landing first would make the roll a close
      w.door.deposits = [];
      w.door.totalDeposits = 0n;
      const r = await rollV32(depsFor(w).deps, target);
      expect(r).toEqual({ rolled: false, reason: `not rolling the empty batch: ${why}, so a batch sent now would park on Bittensor; it stays on Base until the vault takes it again` });
      expect(w.sends).toEqual([]);
    });
  }

  it("once the vault takes batches again, the batch closes; a state without the v3.2 reading (v3-launch's) closes into a paused vault as it always has", async () => {
    const w = world();
    w.door.start = BigInt(T - 90_000);
    w.vault.paused = true;
    const m = freshMemory();
    await runRound(depsFor(w, m, d).deps, target, m, { ...OPTS, now: () => T * 1000 });
    expect(w.sends).toEqual([]);
    w.vault.paused = false;
    await runRound(depsFor(w, m, d).deps, target, m, { ...OPTS, now: () => T * 1000 + 60_000 });
    expect(w.sends.map((s) => s.fn)).toEqual(["closeBatch"]);
    const launch: State = {
      now: T,
      frontDoor: { canClose: true, nDeposits: 1, nRedeems: 0, paused: false, openStart: T - 90_000, batchInterval: 3_600, full: false, now: T },
      closeMaxWaitS: 86_400,
      alphaVault: { healthy: true },
      vault: { paused: true, available: 0n, minStakeWei: 1n, rootStake: 0n, nominatorMinWei: 0n, batches: [], payoutDelay: 86_400 },
    };
    expect(decideNext(launch).action).toEqual({ kind: "close" });
  });

  it("the round's own rule offers no notice's flush while the vault refuses either: a second guard beside flushProblem's (Task 52w fix)", () => {
    const notice: State = {
      now: T,
      frontDoor: { canClose: true, nDeposits: 1, nRedeems: 0, paused: false, openStart: T - 90_000, batchInterval: 3_600, full: false, now: T },
      closeMaxWaitS: 86_400,
      alphaVault: { healthy: false },
      vault: { paused: false, available: 0n, minStakeWei: 1n, rootStake: 0n, nominatorMinWei: 0n, batches: [], payoutDelay: 86_400 },
      flush: { id: 7n, minValue: TAO, reason: "ForeverMoney's migration notice" },
    };
    expect(decideNext(notice).action).toEqual({ kind: "flush", id: 7n, minValue: TAO });
    expect(decideNext({ ...notice, vaultRefuses: "the vault is paused" }).action).toBeNull();
  });
});

// ---- Task 53: the hotkey watch and the buffer rule (spec §3.1, §3.8, §7 keeper changes) ----

const HK_A: Hex = `0x${"11".repeat(32)}`;
const HK_B: Hex = `0x${"22".repeat(32)}`;
const HK_NEW: Hex = `0x${"5e".repeat(32)}`;
const HK_STANDBY: Hex = `0x${"40".repeat(32)}`;
const WATCH = { ...OPTS, rewardsEveryTicks: 1 };

/** A world where nothing is due but what a test adds: the batch can't close, no idle TAO, no payout. */
function quietWorld(): World {
  const w = world();
  w.door.canClose = false;
  return w;
}

/** The vault's listed hotkeys, as given; the stake hotkey the first unless `stake` says otherwise. */
function listHotkeys(w: World, hks: { hotkey: Hex; stakeRao?: bigint; credits?: bigint }[], stake: Hex = hks[0].hotkey) {
  w.vault.hotkeys = hks.map((h) => ({ hotkey: h.hotkey, stakeRao: h.stakeRao ?? 0n, credits: h.credits ?? 0n, lastClaimAt: BigInt(T - 86_400) }));
  w.vault.hotkeyCount = hks.length;
  w.vault.stakeHotkey = stake;
  w.vault.visibleStakeRao = hks.reduce((x, h) => x + (h.stakeRao ?? 0n), 0n);
}

/** A validator's swap of `from`: its stake moves to `to`, off the vault's list, and the vault reads stake missing. */
function swap(w: World, from: Hex, to: Hex) {
  const h = w.vault.hotkeys.find((x) => x.hotkey === from) as { stakeRao: bigint };
  w.vault.offList[to.toLowerCase()] = h.stakeRao;
  w.vault.unlistedStakeRao = h.stakeRao;
  w.vault.visibleStakeRao -= h.stakeRao;
  h.stakeRao = 0n;
  w.vault.stakeMissing = true;
}

/** The swap's new hotkey listed (a stranger, the guardian or the keeper): nothing is missing any more. */
function listNew(w: World, hotkey: Hex) {
  const stakeRao = w.vault.offList[hotkey.toLowerCase()] ?? 0n;
  w.vault.hotkeys.splice(w.vault.hotkeyCount, 0, { hotkey, stakeRao, credits: 0n, lastClaimAt: BigInt(T) });
  w.vault.hotkeyCount++;
  w.vault.visibleStakeRao += stakeRao;
  w.vault.unlistedStakeRao = 0n;
  w.vault.stakeMissing = false;
}

/** `n` rounds a minute apart, the memory through JSON between them (as the Worker saves it), `between` run before each. */
async function watchRounds(w: World, n: number, o: { between?: (i: number) => void; from?: number; saved?: string } = {}) {
  const lines: string[] = [];
  const sent: string[][] = [];
  let saved = o.saved ?? encodeMemory(freshMemory());
  for (let i = 0; i < n; i++) {
    o.between?.(i);
    const memory = loadMemory(saved).memory;
    const before = w.sends.length;
    const r = await runRound(depsFor(w, memory, d, (l) => lines.push(l)).deps, target, memory, { ...WATCH, now: () => ((o.from ?? T) + i * 60) * 1000 });
    expect(r.end, `round ${i + 1}: ${lines.at(-1)}`).toBeUndefined();
    sent.push(w.sends.slice(before).map((s) => `${s.fn}${s.args.length ? ` ${s.args.map(String).join(" ")}` : ""}`));
    saved = encodeMemory(r.memory);
  }
  return { lines, sent, saved };
}

describe("the hotkey watch (plan Task 53; spec §3.1)", () => {
  it("reportsStakeMissingWithTheHotkey: the hotkey whose stake left, named in full with its stake before and now, said once; and once it is back", async () => {
    const w = quietWorld();
    listHotkeys(w, [
      { hotkey: HK_A, stakeRao: (45n * TAO) / RAO },
      { hotkey: HK_B, stakeRao: (5n * TAO) / RAO },
    ]);
    const r = await watchRounds(w, 5, {
      between: (i) => {
        if (i === 1) swap(w, HK_A, HK_NEW);
        if (i === 4) listNew(w, HK_NEW);
      },
    });
    expect(r.lines.filter((l) => l.startsWith("STAKE MISSING: "))).toEqual([
      `STAKE MISSING: 45 TAO of the vault's booked stake is not on its listed hotkeys: it left hotkey ${HK_A} (45 TAO before, 0 TAO now). Most likely a validator's hotkey swap moved it. Until a hotkey that holds it is listed, the vault takes no batch, so the keeper closes, rolls and stakes nothing (payouts, claims and deliveries go on). List the new hotkey: pnpm ops add-hotkey <hotkey> --live --send`,
    ]);
    expect(r.lines.filter((l) => l === "Stake is no longer missing: all of the vault's booked stake is on its listed hotkeys again; closes and staking go on")).toHaveLength(1);
    expect(r.sent.flat()).toEqual([]);
  });

  it("reportsStakeMissingWithTheHotkey, with no earlier reading (a fresh memory): what each listed hotkey holds, the stake hotkey named", async () => {
    const w = quietWorld();
    listHotkeys(w, [
      { hotkey: HK_A, stakeRao: (45n * TAO) / RAO },
      { hotkey: HK_B, stakeRao: (5n * TAO) / RAO },
    ]);
    swap(w, HK_A, HK_NEW);
    const r = await watchRounds(w, 2);
    expect(r.lines.filter((l) => l.startsWith("STAKE MISSING: "))).toEqual([
      `STAKE MISSING: 45 TAO of the vault's booked stake is not on its listed hotkeys; no earlier reading says which hotkey it left (the stake hotkey ${HK_A} holds 0 TAO; ${HK_B} holds 5 TAO). Most likely a validator's hotkey swap moved it. Until a hotkey that holds it is listed, the vault takes no batch, so the keeper closes, rolls and stakes nothing (payouts, claims and deliveries go on). List the new hotkey: pnpm ops add-hotkey <hotkey> --live --send`,
    ]);
  });

  it("reportsUnlistedStake: unlistedStakeRao above 0 is said once, with what to do; 0 says nothing; a read that reverts is said, never taken for 0", async () => {
    const gift = quietWorld();
    gift.vault.unlistedStakeRao = (3n * TAO) / RAO;
    const g = await watchRounds(gift, 2);
    expect(g.lines.filter((l) => l.startsWith("UNLISTED STAKE: "))).toEqual([
      "UNLISTED STAKE: 3 TAO of the vault's root stake is on hotkeys it doesn't list (unlistedStakeRao). It is outside the books and the price (a gift, or stake sent to the vault's coldkey): nothing is lost; the monitor's stake.unlisted names the hotkey",
    ]);
    const none = await watchRounds(quietWorld(), 2);
    expect(none.lines.some((l) => /unlisted/i.test(l))).toBe(false);
    const unread = quietWorld();
    unread.vault.unlistedStakeRao = "reverts";
    const u = await watchRounds(unread, 2);
    expect(u.lines.filter((l) => l.startsWith("Unlisted stake can't be read now"))).toEqual([
      "Unlisted stake can't be read now (unlistedStakeRao reverted: the staking precompile can't total the vault's root stake); the monitor's stake.unlisted watches it",
    ]);
    // while stake is missing, it is most likely the swap's new hotkey
    const swapped = quietWorld();
    listHotkeys(swapped, [
      { hotkey: HK_A, stakeRao: (45n * TAO) / RAO },
      { hotkey: HK_B, stakeRao: (5n * TAO) / RAO },
    ]);
    swap(swapped, HK_A, HK_NEW);
    const s = await watchRounds(swapped, 1);
    expect(s.lines).toContainEqual(
      "UNLISTED STAKE: 45 TAO of the vault's root stake is on hotkeys it doesn't list (unlistedStakeRao). Most likely the swap's new hotkey: list it and the stake counts again (pnpm ops add-hotkey <hotkey> --live --send; taostats shows the hotkey)",
    );
  });

  it("freesASwappedSlotOnlyAfterSetStakeHotkeyAndZeroCredits: a swap's old hotkey is freed (removeHotkey(h, false)) only once the owner's setStakeHotkey moved off it and its credits, claimed first, read 0; a standby listed with no stake is never freed", async () => {
    const w = quietWorld();
    // the claim pays the retained credits into the vault's balance, so the old hotkey stays empty after its claim (and a
    // millionth of a TAO, below the staking floor, leaves nothing to stake)
    w.vault.claimPaysTo = "balance";
    listHotkeys(w, [
      { hotkey: HK_A, stakeRao: (45n * TAO) / RAO },
      { hotkey: HK_B, stakeRao: (5n * TAO) / RAO },
      // a standby, listed and not staked yet: empty, nothing to claim, never the keeper's to free (T51 carry)
      { hotkey: HK_STANDBY },
    ]);
    const r = await watchRounds(w, 8, {
      between: (i) => {
        if (i === 1) {
          swap(w, HK_A, HK_NEW);
          // the swap left claim-only credits on the old hotkey
          (w.vault.hotkeys[0] as { credits: bigint }).credits = 10n ** 12n;
        }
        if (i === 2) listNew(w, HK_NEW);
        // the owner's setStakeHotkey(new)
        if (i === 4) w.vault.stakeHotkey = HK_NEW;
      },
    });
    // rounds 1-4: nothing (the old hotkey is still the stake hotkey, so the policy alone decides its credits: no claim);
    // round 5: its credits claimed first (A17); round 6: its slot freed; then nothing
    expect(r.sent).toEqual([[], [], [], [], [`claimRewards ${HK_A}`], [`removeHotkey ${HK_A} false`], [], []]);
    expect(r.lines).toContainEqual(
      `Hotkey ${HK_A} lost its stake while stake was missing (a swap's old hotkey): it is still the stake hotkey, so its slot is freed only after the owner's setStakeHotkey moves new stake to another listed hotkey, and once its credits read 0`,
    );
    expect(r.lines).toContainEqual(`Hotkey ${HK_A} (a swap's old hotkey): 0.000001 TAO of credits wait on it; they are claimed first, and its slot is freed once they read 0`);
    expect(r.lines).toContainEqual(`Hotkey ${HK_A} (a swap's old hotkey) holds none of the vault's stake and its credits read 0: the keeper frees its slot (removeHotkey)`);
    expect(r.lines).toContainEqual(`Hotkey ${HK_A} removed from the vault's list (removeHotkey): its slot is free`);
    // the standby stays listed, and nothing is said of freeing it
    expect(w.vault.hotkeys.slice(0, w.vault.hotkeyCount).map((h) => h.hotkey).sort()).toEqual([HK_B, HK_STANDBY, HK_NEW].sort());
    expect(r.lines.some((l) => l.includes(HK_STANDBY))).toBe(false);
  });

  it("a swap's old hotkey with credits still waiting is never freed, even while its claim can't go (a spend cap too small for a claim): the slot waits for the credits to read 0", async () => {
    const w = quietWorld();
    listHotkeys(w, [
      { hotkey: HK_A, stakeRao: (45n * TAO) / RAO },
      { hotkey: HK_B, stakeRao: (5n * TAO) / RAO },
    ]);
    // a Bittensor cap that fits no claim (57M gas at 1 gwei is 0.057 TAO): the claim waits, said; nothing else may go
    const small = deploymentFor({ spendCap: { base: 10n ** 18n, bittensor: 10n ** 16n } });
    const lines: string[] = [];
    let saved = encodeMemory(freshMemory());
    for (let i = 0; i < 6; i++) {
      if (i === 1) {
        swap(w, HK_A, HK_NEW);
        (w.vault.hotkeys[0] as { credits: bigint }).credits = TAO / 5n;
      }
      if (i === 2) {
        listNew(w, HK_NEW);
        w.vault.stakeHotkey = HK_NEW;
      }
      const memory = loadMemory(saved).memory;
      const r = await runRound(depsFor(w, memory, small, (l) => lines.push(l)).deps, targetV32(small), memory, { ...WATCH, now: () => (T + i * 60) * 1000 });
      saved = encodeMemory(r.memory);
    }
    expect(w.sends).toEqual([]);
    expect(lines).toContainEqual(`Hotkey ${HK_A} (a swap's old hotkey): 0.2 TAO of credits wait on it; they are claimed first, and its slot is freed once they read 0`);
    // the watch itself never offers the slot while credits wait: no removal is even tried (freeV32's own check is the
    // second guard, never the first)
    expect(lines.filter((l) => /freeing hotkey|not freeing the slot/.test(l))).toEqual([]);
  });

  it("a swap's old hotkey a claim paid its credits onto as stake is never removed by the keeper: the owner's removeHotkey, said once (T51 carry)", async () => {
    const w = quietWorld();
    listHotkeys(w, [
      { hotkey: HK_A, stakeRao: (45n * TAO) / RAO },
      { hotkey: HK_B, stakeRao: (5n * TAO) / RAO },
    ]);
    const r = await watchRounds(w, 6, {
      between: (i) => {
        if (i === 1) {
          swap(w, HK_A, HK_NEW);
          (w.vault.hotkeys[0] as { credits: bigint }).credits = TAO / 5n;
        }
        if (i === 2) {
          listNew(w, HK_NEW);
          w.vault.stakeHotkey = HK_NEW;
        }
      },
    });
    // the claim pays as stake (the world's default): the old hotkey holds 0.2 TAO again, and stays listed
    expect(r.sent.flat()).toEqual([`claimRewards ${HK_A}`]);
    expect(r.lines.filter((l) => l.startsWith(`Hotkey ${HK_A} (a swap's old hotkey) holds 0.2 TAO of the vault's stake again`))).toEqual([
      `Hotkey ${HK_A} (a swap's old hotkey) holds 0.2 TAO of the vault's stake again: the keeper never removes a hotkey with stake; the owner's removeHotkey frees it (pnpm ops remove-hotkey ${HK_A} --as owner --for-wallet --live), which moves that stake onto the stake hotkey`,
    ]);
  });

  it("the review's Important 5: a hotkey whose stake only dipped while stake was missing (a walk) is never marked: the primary 900 → 0 is, the standby 100 → 99 isn't, and the standby emptied later is never freed", async () => {
    const w = quietWorld();
    w.vault.claimPaysTo = "balance";
    listHotkeys(w, [
      { hotkey: HK_A, stakeRao: (900n * TAO) / RAO },
      { hotkey: HK_STANDBY, stakeRao: (100n * TAO) / RAO },
    ]);
    const r = await watchRounds(w, 6, {
      between: (i) => {
        if (i === 1) {
          swap(w, HK_A, HK_NEW);
          // a payout's walk took 1 TAO from the standby in the same reading
          (w.vault.hotkeys[1] as { stakeRao: bigint }).stakeRao = (99n * TAO) / RAO;
          w.vault.visibleStakeRao -= TAO / RAO;
        }
        if (i === 2) {
          listNew(w, HK_NEW);
          w.vault.stakeHotkey = HK_NEW;
          // the owner's moveStake empties the standby onto the stake hotkey
          (w.vault.hotkeys[1] as { stakeRao: bigint }).stakeRao = 0n;
        }
      },
    });
    // the swap's old hotkey alone is freed; the standby stays listed
    expect(r.sent.flat()).toEqual([`removeHotkey ${HK_A} false`]);
    expect(w.vault.hotkeys.slice(0, w.vault.hotkeyCount).map((h) => h.hotkey)).toContain(HK_STANDBY);
    // the report names the hotkey emptied, not the dip
    expect(r.lines.filter((l) => l.startsWith("STAKE MISSING: "))[0]).toContain(`it left hotkey ${HK_A} (900 TAO before, 0 TAO now)`);
    expect(r.lines.some((l) => l.includes(HK_STANDBY))).toBe(false);
  });

  it("R6b (U9): a swap's old hotkey on which Bittensor still owes the vault deferred rewards (left out of its credits) is not freed until they are paid; its line says why", async () => {
    const w = quietWorld();
    w.vault.claimPaysTo = "balance";
    listHotkeys(w, [{ hotkey: HK_A, stakeRao: (900n * TAO) / RAO }]);
    // the swap's move ran while the hotkey's queued credits couldn't settle: 0.005 alpha deferred, owed to the vault
    w.deferred[HK_A.toLowerCase()] = { alphaDebtRao: -5_000_000n };
    const r = await watchRounds(w, 5, {
      between: (i) => {
        if (i === 1) swap(w, HK_A, HK_NEW);
        if (i === 2) {
          listNew(w, HK_NEW);
          w.vault.stakeHotkey = HK_NEW;
        }
        // paid by a claim after it converted
        if (i === 4) w.deferred[HK_A.toLowerCase()] = { alphaDebtRao: 0n };
      },
    });
    expect(r.sent.flat()).toEqual([`removeHotkey ${HK_A} false`]);
    expect(r.sent.findIndex((s) => s.length > 0)).toBe(4);
    // the watch never offers the free while they are owed (the send's own re-check would refuse it, round after round)
    expect(r.lines.filter((l) => l.includes("not freeing the slot"))).toEqual([]);
    expect(r.lines).toContainEqual(expect.stringMatching(new RegExp(`^Hotkey ${HK_A} \\(a swap's old hotkey\\) holds none of the vault's stake and its credits read 0, but its slot waits: Bittensor still owes the vault deferred rewards on hotkey ${HK_A} \\(5,000,000 rao of subnet alpha`)));
  });

  it("the mark is let go of once the hotkey holds stake again in a reading with nothing missing: emptied later by the owner, it is never freed", async () => {
    const w = quietWorld();
    listHotkeys(w, [
      { hotkey: HK_A, stakeRao: (45n * TAO) / RAO },
      { hotkey: HK_B, stakeRao: (5n * TAO) / RAO },
    ]);
    const r = await watchRounds(w, 6, {
      between: (i) => {
        if (i === 1) swap(w, HK_A, HK_NEW);
        if (i === 2) {
          // the stake came back to the old hotkey (the swap undone): nothing missing
          (w.vault.hotkeys[0] as { stakeRao: bigint }).stakeRao = (45n * TAO) / RAO;
          w.vault.visibleStakeRao += (45n * TAO) / RAO;
          w.vault.unlistedStakeRao = 0n;
          w.vault.stakeMissing = false;
        }
        if (i === 3) {
          // later the owner moves its stake onto another stake hotkey: empty, but no swap's
          w.vault.stakeHotkey = HK_B;
          (w.vault.hotkeys[0] as { stakeRao: bigint }).stakeRao = 0n;
          (w.vault.hotkeys[1] as { stakeRao: bigint }).stakeRao = (50n * TAO) / RAO;
        }
      },
    });
    expect(r.sent.flat()).toEqual([]);
  });

  it("slotFreeable stays true of a fresh standby (A17's claim job), but the keeper frees only a hotkey the watch saw lose its stake while stake was missing (T51 carry)", async () => {
    const w = quietWorld();
    listHotkeys(w, [{ hotkey: HK_A, stakeRao: (50n * TAO) / RAO }, { hotkey: HK_STANDBY }]);
    const r = await watchRounds(w, 4);
    expect(r.sent.flat()).toEqual([]);
    expect(w.vault.hotkeyCount).toBe(2);
  });
});

describe("the buffer rule (plan Task 53; spec §3.8)", () => {
  it("bufferRuleWhenTheHoldIntervalIsNonZero: says the idleBufferBps that covers pendingPayouts plus a day's floor, rounded up, once", async () => {
    const w = quietWorld();
    w.rootHold = 7_200n;
    w.vault.bookedStake = (500n * TAO) / RAO;
    w.vault.visibleStakeRao = (500n * TAO) / RAO;
    w.vault.pending = 2n * TAO;
    w.vault.minDailyOutflow = 10n * TAO;
    const r = await watchRounds(w, 3);
    expect(r.lines.filter((l) => l.startsWith("ROOT HOLD: "))).toEqual([
      "ROOT HOLD: Bittensor holds root stake 7200 blocks (about 24 hours) after each add, remove or claim on a hotkey (RootStakeUnlockInterval). BUFFER RULE: the owner raises the vault's idleBufferBps from 0 to 240, so its idle buffer covers the queued payouts (2 TAO) and a day's floor (minDailyOutflow, 10 TAO): 12 TAO of the 500 TAO booked stake. Claims wait while a payout is due",
    ]);
  });

  it("the buffer rule's other answers: already covered; more than the vault's most (1,000 bps); nothing staked; no hold says nothing; unreadable", async () => {
    const line = async (set: (w: World) => void) => {
      const w = quietWorld();
      w.rootHold = 300n;
      w.vault.bookedStake = (500n * TAO) / RAO;
      w.vault.visibleStakeRao = (500n * TAO) / RAO;
      w.vault.pending = 2n * TAO;
      w.vault.minDailyOutflow = 10n * TAO;
      set(w);
      return (await watchRounds(w, 1)).lines.find((l) => l.startsWith("ROOT HOLD"));
    };
    const head = "ROOT HOLD: Bittensor holds root stake 300 blocks (about 1 hour) after each add, remove or claim on a hotkey (RootStakeUnlockInterval).";
    expect(await line((w) => void (w.vault.idleBufferBps = 300))).toBe(
      `${head} BUFFER RULE: the vault's idleBufferBps (300) already covers the queued payouts (2 TAO) and a day's floor (minDailyOutflow, 10 TAO). Claims wait while a payout is due`,
    );
    expect(
      await line((w) => {
        w.vault.bookedStake = (50n * TAO) / RAO;
        w.vault.visibleStakeRao = (50n * TAO) / RAO;
      }),
    ).toBe(
      `${head} BUFFER RULE: covering the queued payouts (2 TAO) and a day's floor (minDailyOutflow, 10 TAO) needs 12 TAO of the 50 TAO booked stake, more than the most idleBufferBps keeps (1,000: 10%): the owner raises it from 0 to 1,000, and the payouts it can't cover wait for deposits or for the hold to pass. Claims wait while a payout is due`,
    );
    expect(
      await line((w) => {
        w.vault.bookedStake = 0n;
        w.vault.visibleStakeRao = 0n;
      }),
    ).toBe(`${head} BUFFER RULE: nothing is staked, so nothing needs a buffer. Claims wait while a payout is due`);
    expect(await line((w) => void (w.rootHold = 0n))).toBeUndefined();
    expect(await line((w) => void (w.rootHold = "unreadable"))).toBe(
      "ROOT HOLD UNREAD: Bittensor's RootStakeUnlockInterval can't be read now (the storage-query precompile refused it): the keeper takes it as set, so claims wait while a payout is due; the monitor's root.hold_interval watches it",
    );
    // no code at the precompile's address (every eth_call answers "0x"): the empty answer is not trusted, since the block
    // number's key, which always has an entry, answers empty too (Task 53's fix round, the review's Important 6)
    expect(await line((w) => void (w.rootHold = "absent"))).toBe(
      "ROOT HOLD UNREAD: Bittensor's RootStakeUnlockInterval can't be read now (the storage-query precompile answered nothing for the block number, a key that always has an entry): the keeper takes it as set, so claims wait while a payout is due; the monitor's root.hold_interval watches it",
    );
  });

  it("the buffer rule's claim wait: once the hold interval is non-zero, claims wait while any payout is due, waiting or not (T51 review M6); with no hold the claim goes", async () => {
    const run = async (hold: bigint | "unreadable" | "absent") => {
      const w = quietWorld();
      w.rootHold = hold;
      // a claim is due on the stake hotkey (2 TAO waiting, over 25 × 0.057)
      (w.vault.hotkeys[0] as { credits: bigint }).credits = 2n * TAO;
      // and a payout batch is due, but waits (the monitor hasn't confirmed it)
      queue(w, KEY_A, [redeem(ALICE, TAO, TAO)]);
      w.monitor.okKeys = [];
      return watchRounds(w, 2);
    };
    const held = await run(7_200n);
    expect(held.sent.flat()).toEqual([]);
    expect(
      held.lines.some((l) =>
        l.includes(
          "claims wait while a payout is due: Bittensor holds root stake 7200 blocks (about 24 hours) after each add, remove or claim on a hotkey (RootStakeUnlockInterval), and a claim stamps the pair it claims on (the buffer rule)",
        ),
      ),
    ).toBe(true);
    const unread = await run("unreadable");
    expect(unread.sent.flat()).toEqual([]);
    const absent = await run("absent");
    expect(absent.sent.flat()).toEqual([]);
    const free = await run(0n);
    expect(free.sent.flat()).toEqual([`claimRewards ${HK_A}`]);
  });

  it("decideNext: with the hold set, claims wait while a payout is due, the payout skipped or not; the adoption and a free still go", () => {
    const s: State = {
      now: T,
      frontDoor: { canClose: false, nDeposits: 0, nRedeems: 0, paused: false, openStart: T, batchInterval: 3_600, full: false, now: T },
      closeMaxWaitS: 86_400,
      alphaVault: { healthy: true },
      vault: { paused: false, available: 0n, minStakeWei: 1n, rootStake: 0n, nominatorMinWei: 0n, batches: [{ key: KEY_A, queuedAt: T - 90_000, cursor: 0, count: 1 }], payoutDelay: 86_400 },
      skipped: new Set([`payouts:${KEY_A.toLowerCase()}`]),
      claims: [{ hotkey: HK_A, reason: "due" }],
    };
    expect(decideNext(s).action).toEqual({ kind: "claim", hotkey: HK_A });
    const held = decideNext({ ...s, rootHold: "the hold" });
    expect(held.action).toBeNull();
    expect(held.reason).toContain("claims wait while a payout is due: the hold, and a claim stamps the pair it claims on (the buffer rule)");
    expect(decideNext({ ...s, rootHold: "the hold", adopt: { reason: "a surplus" } }).action).toEqual({ kind: "adopt" });
    expect(decideNext({ ...s, rootHold: "the hold", frees: [{ hotkey: HK_B, reason: "empty" }] }).action).toEqual({ kind: "free", hotkey: HK_B });
    // no payout due: the claim goes under the hold
    expect(decideNext({ ...s, rootHold: "the hold", vault: { ...s.vault, batches: [] } }).action).toEqual({ kind: "claim", hotkey: HK_A });
  });
});
