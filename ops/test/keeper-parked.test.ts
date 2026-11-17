import { type Address, getAddress, type Hex, keccak256, padHex, parseEther } from "viem";
import { describe, expect, it } from "vitest";
import { keeperSend } from "../src/keeper/core/actions.ts";
import { encodeBatch } from "../src/keeper/core/batch.ts";
import { SendRefused } from "../src/keeper/core/errors.ts";
import { NotNow } from "../src/keeper/core/failures.ts";
import { type JournalRow, memoryJournal, spentOn } from "../src/keeper/core/journal.ts";
import { encodeMemory, freshMemory, type KeeperMemory, loadMemory } from "../src/keeper/core/memory.ts";
import { REPLACE_AFTER_MS, runRound } from "../src/keeper/core/round.ts";
import { flushV32, targetV32 } from "../src/keeper/core/v32/actions.ts";
import {
  FLUSH_MARGIN_S,
  FM_MIGRATION_DELAY_S,
  holdPark,
  openParks,
  PARK_HOLD_MS,
  PARK_REFUND_FEE_MAX,
  PARK_SENT_LOOKBACK_S,
  PARK_TIMEOUT_S,
  type ParkLog,
  parkAction,
  parkJobV32,
  parkMessage,
  parksV32,
  settledClosed,
} from "../src/keeper/core/v32/parked.ts";
import { blocksIn } from "../src/keeper/core/blocktime.ts";
import { SENT_RETAIN_S } from "../src/keeper/core/v32/reads.ts";
import { convertParkRequest, deliverParkedRequest, parkKeyOf, stakeRequest } from "../src/keeper/core/v32/requests.ts";
import { ADDR, deploymentFor, depsFor, KEY, laneMessage, parkInWorld, sendInWorld, T, TAO, type World, world } from "./keeper-v32-world.ts";

// Task 52's park job on the v3.2 core (plan Task 52; spec §3.2, M-7; design-keeper-worker.md §8): a park on the Bittensor
// adapter is handled only when it is the registered door's batch to the vault (A-L2: a stranger's park is never touched or
// paid for); its message is rebuilt from the Base OnRamp's CCIPMessageSent by its messageId and checked, byte for byte,
// against the park's on-chain record before anything is sent; deliverParked goes when its eth_call succeeds; refundParked
// after PARK_TIMEOUT with quoteRefund's fee, under its cap; dropParked for an empty park after it; and at ForeverMoney's
// migration notice every token park is converted at once (through Task 50a's tagged conversion, which then passes the
// spend cap too, counted: the controller's ruling), the open batch is closed once with its id, and nothing is closed
// afterwards. On fake chains.

const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);
const lower = (a: string) => a.toLowerCase();
const d = deploymentFor();
const OPTS = { intervalMs: 60_000, policy: { claimCostTao: 57n * 10n ** 15n, claimMultiple: 25n, monthlyClaimMaxUsd: 20 }, rewardsEveryTicks: 1000 };
const STRANGER = at("5e7");
const DAY = 86_400n;
const NOTICE = BigInt(T + 7 * 86_400);
/** A batch the door sent: one deposit of `amount` (or a redeem only, when 0), batch `id` */
const batch = (id: bigint, amount = TAO): Hex => (amount > 0n ? encodeBatch(id, [{ user: at("de01"), amount }], []) : encodeBatch(id, [], [{ user: at("de02"), amount: TAO }]));
/** The door's batch `id` parked on its way to the vault */
const doors = (id: bigint, amount = TAO) => ({ recipient: ADDR.vault, sender: ADDR.frontDoor, message: batch(id, amount) });

/** `n` rounds on `w`, the memory through JSON between them (as the Worker saves it), a minute apart from `from` (s). */
async function rounds(
  w: World,
  n: number,
  o: {
    from?: number;
    dep?: typeof d;
    journal?: ReturnType<typeof memoryJournal>;
    memory?: KeeperMemory;
    between?: (i: number) => void;
    logsWindow?: Partial<Record<"base" | "bittensor", bigint>>;
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
    const { deps } = depsFor(w, memory, dep, (l) => lines.push(l), { journal, ...(o.logsWindow ? { logsWindow: o.logsWindow } : {}) });
    const r = await runRound(deps, targetV32(dep), memory, { ...OPTS, now: () => now });
    expect(r.end, `round ${i + 1}: ${lines.at(-1)}`).toBeUndefined();
    saved = encodeMemory(r.memory);
  }
  return { lines, memory, journal };
}

/** A close mined opens the next batch, as the door does: its id one on, its start the close's time (Base's clock) */
const closesOpenTheNext = (w: World) => {
  w.fate = (c) => {
    if (c.fn === "closeBatch") {
      w.door.id++;
      w.door.start = BigInt(w.time.base);
    }
    return "mine";
  };
};

/** The sends made, as [function, to] */
const sent = (w: World) => w.sends.map((s) => [s.fn, lower(s.to)]);
/** How often a line starting `start` was said */
const said = (lines: string[], start: string) => lines.filter((l) => l.startsWith(start)).length;

describe("openParks: BatchParked less ParkedDelivered, ParkedRefunded and ParkedDropped; ParkedConverted updates", () => {
  const k = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
  const parked = (key: Hex, block: bigint, o: Partial<ParkLog> = {}): ParkLog => ({
    kind: "parked",
    key,
    blockNumber: block,
    logIndex: 0,
    messageId: keccak256(key),
    recipient: ADDR.vault,
    sender: ADDR.frontDoor,
    amount: TAO,
    converted: false,
    ...o,
  });
  const closed = (kind: ParkLog["kind"], key: Hex, block: bigint): ParkLog => ({ kind, key, blockNumber: block, logIndex: 1 });

  it("folds the five events in chain order, whatever order they come in", () => {
    const logs = [closed("delivered", k(1), 20n), parked(k(1), 10n), parked(k(2), 11n), closed("converted", k(2), 12n), parked(k(3), 13n), closed("refunded", k(3), 30n), parked(k(4), 14n, { amount: 0n }), closed("dropped", k(4), 40n), parked(k(5), 15n)];
    const open = openParks(logs);
    expect(open.map((p) => [p.key, p.converted])).toEqual([
      [k(2), true],
      [k(5), false],
    ]);
  });

  it("a close is let go of once it is the scan's settle margin deep: 10 of Bittensor's 12 s blocks, 20 of 6 s ones (120 s)", () => {
    const logs = [parked(k(1), 10n), closed("delivered", k(1), 100n)];
    expect(settledClosed(logs, 110n)).toEqual([k(1)]);
    expect(settledClosed(logs, 109n)).toEqual([]);
    // the scan's margin at Bittensor's block time, measured: 120 s at 6 s a block is 20 blocks
    expect(settledClosed(logs, 110n, 20n)).toEqual([]);
    expect(settledClosed(logs, 120n, 20n)).toEqual([k(1)]);
  });

  it("a park delivered and parked again (the same key: never on chain from the door, but folded right) is open again", () => {
    expect(openParks([parked(k(1), 10n), closed("delivered", k(1), 11n), parked(k(1), 12n, { converted: true })]).map((p) => [p.key, p.converted])).toEqual([[k(1), true]]);
  });
});

describe("parkAction: deliver when the simulation succeeded, or a token park at the notice; refund or drop after PARK_TIMEOUT", () => {
  const park = { key: `0x${"aa".repeat(32)}` as Hex, messageId: `0x${"bb".repeat(32)}` as Hex, recipient: ADDR.vault, sender: ADDR.frontDoor, amount: TAO, converted: false, block: 1n };
  const record = (o: Partial<{ amount: bigint; parkedAt: bigint; converted: boolean }> = {}) => ({ amount: TAO, parkedAt: BigInt(T) - DAY, converted: false, ...o });
  const now = T;

  it("ignoresAParkFromAnUnregisteredSender: a stranger's park is never acted on, whatever it is", () => {
    for (const notice of [false, true]) {
      for (const deliverable of [false, true]) {
        for (const r of [record(), record({ parkedAt: BigInt(T) - 15n * DAY }), record({ amount: 0n, parkedAt: BigInt(T) - 15n * DAY })]) {
          expect(parkAction({ ...park, sender: STRANGER }, { ours: false, now, record: r, notice, deliverable })).toBeNull();
          expect(parkAction({ ...park, recipient: STRANGER }, { ours: false, now, record: r, notice, deliverable })).toBeNull();
        }
      }
    }
  });

  it("ours: deliver when its eth_call succeeded; a token park at the notice whatever its simulation; else nothing until the timeout", () => {
    expect(parkAction(park, { ours: true, now, record: record(), notice: false, deliverable: true })).toBe("deliver");
    expect(parkAction(park, { ours: true, now, record: record(), notice: false, deliverable: false })).toBeNull();
    expect(parkAction(park, { ours: true, now, record: record(), notice: true })).toBe("deliver");
    // a native (converted) park is TAO already: the notice changes nothing for it
    expect(parkAction(park, { ours: true, now, record: record({ converted: true }), notice: true, deliverable: false })).toBeNull();
    // no record (delivered, refunded or dropped since): nothing
    expect(parkAction(park, { ours: true, now, record: record({ parkedAt: 0n }), notice: true, deliverable: true })).toBeNull();
  });

  it("after PARK_TIMEOUT from the record's parkedAt: refund what it owes, drop it when empty; a delivery that would succeed still comes first", () => {
    const old = BigInt(T) - BigInt(PARK_TIMEOUT_S);
    expect(parkAction(park, { ours: true, now, record: record({ parkedAt: old + 1n }), notice: false, deliverable: false })).toBeNull();
    expect(parkAction(park, { ours: true, now, record: record({ parkedAt: old }), notice: false, deliverable: false })).toBe("refund");
    expect(parkAction(park, { ours: true, now, record: record({ parkedAt: old, amount: 0n }), notice: false, deliverable: false })).toBe("drop");
    expect(parkAction(park, { ours: true, now, record: record({ parkedAt: old }), notice: false, deliverable: true })).toBe("deliver");
  });
});

describe("the park job, round by round", () => {
  it("ignoresAParkFromAnUnregisteredSender: in the round too, nothing is sent for a stranger's park, past its timeout or not", async () => {
    const w = world();
    const old = BigInt(T) - 15n * DAY;
    // a stranger's batch through Cascade's adapter (its payload's sender the stranger), and one to a stranger's recipient
    parkInWorld(w, { recipient: ADDR.vault, sender: STRANGER, message: batch(1n) }, { parkedAt: old });
    parkInWorld(w, { recipient: STRANGER, sender: ADDR.frontDoor, message: batch(2n, 0n) }, { amount: 0n, parkedAt: old });
    await rounds(w, 6);
    expect(w.sends).toEqual([]);
  });

  it("aStrangersParkCostsNothing: no read, no simulation, no quote and no send for it, and it is said once", async () => {
    const w = world();
    const old = BigInt(T) - 15n * DAY;
    const a = parkInWorld(w, { recipient: ADDR.vault, sender: STRANGER, message: batch(1n) }, { parkedAt: old });
    const b = parkInWorld(w, { recipient: STRANGER, sender: ADDR.frontDoor, message: batch(2n, 0n) }, { amount: 0n, parkedAt: old });
    const r = await rounds(w, 12);
    expect(w.sends).toEqual([]);
    // nothing of the adapter's park calls was read or simulated (readiness's hourly I-7 totals aside), and the OnRamp was
    // never searched
    const PARK_FNS = ["parked", "remoteChainId", "deliverParked", "quoteRefund", "refundParked", "dropParked"];
    expect(w.calls.filter((c) => lower(c.to) === lower(ADDR.bitAdapter) && PARK_FNS.includes(c.fn)).map((c) => c.fn)).toEqual([]);
    expect(w.logQueries.filter((q) => lower(q.address) === lower(ADDR.onRampBase))).toEqual([]);
    for (const p of [a, b]) {
      expect(r.lines.filter((l) => l.includes(p.key.slice(0, 10))), p.key).toEqual([
        expect.stringMatching(/^Park 0x[0-9a-f]{8}… is not Cascade's \(from 0x[0-9a-fA-F]{40} to 0x[0-9a-fA-F]{40}\): the keeper never touches it or pays for it$/),
      ]);
    }
  });

  it("rebuildsTheMessageByteForByte: the message comes from the Base OnRamp's CCIPMessageSent, its key the park's", async () => {
    const w = world();
    const p = doors(7n);
    const park = parkInWorld(w, p, { converted: true });
    const { deps, memory } = depsFor(w);
    const logs = (await deps.parkLogs()).logs;
    const open = openParks(logs);
    expect(open.map((x) => x.key)).toEqual([park.key]);
    const got = await parkMessage(deps, open[0]);
    expect(got).toEqual({ ok: { key: park.key, recipient: p.recipient, sender: p.sender, message: p.message } });
    if (!("ok" in got)) throw new Error("not rebuilt");
    expect(parkKeyOf(8453n, got.ok.sender, got.ok.recipient, got.ok.message)).toBe(park.key);
    // and the round sends exactly those bytes
    await rounds(w, 1, { memory });
    expect(w.sends.map((s) => [s.fn, s.args])).toEqual([["deliverParked", [p.recipient, p.sender, p.message]]]);
  });

  describe("a mismatched rebuild refuses: nothing is sent, said once", () => {
    async function refused(make: (w: World) => void, why: RegExp) {
      const w = world();
      make(w);
      const r = await rounds(w, 7);
      expect(w.sends).toEqual([]);
      const lines = r.lines.filter((l) => l.startsWith("PARK NOT REBUILT"));
      expect(lines, r.lines.join("\n")).toHaveLength(1);
      expect(lines[0]).toMatch(why);
    }
    it("the OnRamp's bytes don't hash to the park's message id", () =>
      refused((w) => {
        const other = laneMessage("Base → Bittensor", doors(8n), { amount: TAO, number: 9n });
        parkInWorld(w, doors(7n), { converted: true, encodedLogged: other.encoded });
      }, /hash to 0x[0-9a-f]{64}, not the message id/));
    it("Cascade's adapter did not send it (its CCIP sender)", () =>
      refused((w) => {
        const msg = laneMessage("Base → Bittensor", doors(7n), { amount: TAO, over: { sender: padHex(STRANGER.toLowerCase() as Hex, { size: 32 }) } });
        parkInWorld(w, doors(7n), { converted: true, msg });
      }, /Cascade's adapter did not send it/));
    it("its payload's message is not the parked one (the key differs)", () =>
      refused((w) => {
        const msg = laneMessage("Base → Bittensor", doors(99n), { amount: TAO });
        parkInWorld(w, doors(7n), { converted: true, msg });
      }, /its message does not hash to park 0x[0-9a-f]{8}…'s key/));
    it("it names another OffRamp", () =>
      refused((w) => {
        const msg = laneMessage("Base → Bittensor", doors(7n), { amount: TAO, over: { offRampAddress: at("bad").toLowerCase() as Hex } });
        parkInWorld(w, doors(7n), { converted: true, msg });
      }, /it names another OffRamp/));
  });

  it("deliversOnlyWhenTheSimulationSucceeds: deliverParked goes only once its eth_call passes, untagged, and the park is gone", async () => {
    const w = world();
    const p = doors(7n);
    parkInWorld(w, p, { converted: true });
    // the vault still refuses it: its simulation fails, and nothing is sent (not even estimated)
    w.parkSim = () => "ReentrancyGuardReentrantCall";
    const r1 = await rounds(w, 6);
    expect(w.sends).toEqual([]);
    expect(w.calls.filter((c) => c.fn === "deliverParked").length).toBeGreaterThan(0);
    // the vault paused: not even simulated
    w.parkSim = () => undefined;
    w.vault.paused = true;
    const before = w.calls.filter((c) => c.fn === "deliverParked").length;
    const r2 = await rounds(w, 6, { memory: r1.memory });
    expect(w.sends).toEqual([]);
    expect(w.calls.filter((c) => c.fn === "deliverParked").length).toBe(before);
    // it would succeed now: delivered, once
    w.vault.paused = false;
    const r3 = await rounds(w, 6, { memory: r2.memory });
    expect(sent(w)).toEqual([["deliverParked", lower(ADDR.bitAdapter)]]);
    const row = r3.journal.rows[0] as JournalRow;
    expect(row.request.rail).toBeUndefined();
    expect(w.parks).toEqual({});
  });

  it("a delivery the vault refused anyway (it stays parked, ParkedConverted) is held, said loudly, and not sent again within its hold", async () => {
    const w = world();
    parkInWorld(w, doors(7n), { converted: true });
    w.vaultTakesParks = false;
    const r = await rounds(w, 20);
    expect(sent(w)).toEqual([["deliverParked", lower(ADDR.bitAdapter)]]);
    expect(r.lines).toContainEqual(expect.stringMatching(/^PARK HELD: the vault refused park 0x[0-9a-f]{8}… again \(it stays parked as TAO\): its delivery is tried again at .* UTC; it is refunded to its door after 14 days$/));
  });

  it("migrationNoticeConvertsEveryTokenParkFlushesOnceThenStopsClosing", async () => {
    const w = world();
    const t1 = parkInWorld(w, doors(5n), { amount: TAO });
    const t2 = parkInWorld(w, doors(6n, 3n * TAO), { amount: 3n * TAO });
    // a native park too, which the vault refuses: no conversion for it, and its delivery waits for its simulation
    const native = parkInWorld(w, doors(4n), { converted: true });
    w.parkSim = (k) => (k === lower(native.key) ? "ReentrancyGuardReentrantCall" : undefined);
    // the open batch has a deposit and can close (its fees short of the bridge fee: the close rule alone would hold it)
    w.alpha.migrationReadyAt = NOTICE;
    // four rounds: the close opens batch 8 (during the notice), and nothing is closed again
    closesOpenTheNext(w);
    const r = await rounds(w, 4);
    // both token parks converted first (tagged: the founder's exception), then the open batch closed once by its id
    expect(w.sends.map((s) => [s.fn, s.args[0]])).toEqual([
      ["deliverParked", ADDR.vault],
      ["deliverParked", ADDR.vault],
      ["closeBatch", 7n],
    ]);
    expect(w.sends.slice(0, 2).map((s) => s.args[2])).toEqual(expect.arrayContaining([batch(5n), batch(6n, 3n * TAO)]));
    // R12b: by its id, with minValue 0 (a 1-rao cancel must not void the notice's one close)
    expect(w.sends[2].args).toEqual([7n, 0n]);
    expect(r.journal.rows.slice(0, 2).map((x) => x.request.rail)).toEqual(["migration-conversion", "migration-conversion"]);
    expect(r.journal.rows[2].request.rail).toBeUndefined();
    expect(Object.keys(w.parks)).toEqual([lower(native.key)]);
    expect([t1, t2].every((t) => !w.parks[lower(t.key)])).toBe(true);
    // the batch closed (the door opens batch 8 then, during the notice: its start is the close's time): a new deposit, a
    // batch that can close, and nothing closes any more
    w.door.id = 8n;
    w.door.start = BigInt(T + 120);
    w.door.deposits = [{ user: at("de03"), amount: TAO }];
    w.door.totalDeposits = TAO;
    const r2 = await rounds(w, 8, { memory: r.memory, journal: r.journal, from: T + 600 });
    expect(w.sends.map((s) => s.fn)).toEqual(["deliverParked", "deliverParked", "closeBatch"]);
    expect(said([...r.lines, ...r2.lines], "MIGRATION NOTICE FLUSH:")).toBe(2);
    expect([...r.lines, ...r2.lines]).toContainEqual(`MIGRATION NOTICE FLUSH: batch 8 opened after ForeverMoney's notice began, so the batch open then has closed: the notice's one close is done`);
  });

  describe("the notice's one close: its deadline, and \"once\" from the chain, never from the memory (review I2)", () => {
    it("no flush within FLUSH_MARGIN_S (24 h) of migrationReadyAt, or after it: the batch stays on Base, said once; the conversions still go", async () => {
      expect(FLUSH_MARGIN_S).toBe(86_400);
      // the keeper back after days away (a hold, an outage): the batch the notice found open is open still
      const before = (readyAt: bigint) => readyAt - BigInt(FM_MIGRATION_DELAY_S) - 100n;
      for (const readyAt of [BigInt(T + 86_400), BigInt(T + 3_600), BigInt(T - 3_600)]) {
        const w = world();
        parkInWorld(w, doors(5n));
        w.alpha.migrationReadyAt = readyAt;
        w.door.start = before(readyAt);
        closesOpenTheNext(w);
        const r = await rounds(w, 4);
        expect(w.sends.map((s) => s.fn), String(readyAt)).toEqual(["deliverParked"]);
        const missed = r.lines.filter((l) => l.startsWith("MIGRATION NOTICE FLUSH MISSED:"));
        expect(missed).toEqual([
          `MIGRATION NOTICE FLUSH MISSED: ForeverMoney's migration can execute from ${new Date(Number(readyAt) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC (migrationReadyAt ${readyAt}), less than 24 hours from now: the open batch 7 is not closed, and stays on Base, safe, until the migration ends`,
        ]);
        // one-shot too
        const e = await flushV32(depsFor(w).deps, targetV32(d), 7n).catch((x: unknown) => x);
        expect([e instanceof NotNow, (e as Error).message]).toEqual([true, missed[0].replace("MIGRATION NOTICE FLUSH MISSED: ", "")]);
        expect(w.sends.map((s) => s.fn)).toEqual(["deliverParked"]);
      }
      // a second more than the margin: it goes
      const w = world();
      w.alpha.migrationReadyAt = BigInt(T + 86_401);
      w.door.start = before(BigInt(T + 86_401));
      closesOpenTheNext(w);
      await rounds(w, 2);
      expect(w.sends.map((s) => [s.fn, s.args[0]])).toEqual([["closeBatch", 7n]]);
    });

    it("R12b: the notice's one close names minValue 0, so a holder's 1-rao cancel of an aged entry before each send can't void it round after round until the deadline (the cooldown review)", async () => {
      const w = world();
      w.alpha.migrationReadyAt = NOTICE;
      closesOpenTheNext(w);
      // every closeBatch simulation finds a rao cancelled first, and the door holds the close to its minValue
      const RAO = 10n ** 9n;
      w.simulate = (c) => {
        if (c.fn !== "closeBatch") return 200_000n;
        w.door.totalDeposits -= RAO;
        w.door.deposits = [{ ...w.door.deposits[0], amount: w.door.totalDeposits }];
        return w.door.totalDeposits < (c.args[1] as bigint) ? { error: "BatchTooSmall" } : 200_000n;
      };
      await rounds(w, 2);
      expect(w.sends.map((s) => [s.fn, s.args])).toEqual([["closeBatch", [7n, 0n]]]);
    });

    it("R12f: a cancel between the notice's close's own read and its simulation (BatchNotReady): read again once, the batch not closable, the round's quiet skip, three rounds running; no breaker count; the next round's flush goes. A second BatchNotReady the re-read contradicts is counted", async () => {
      const w = world();
      w.alpha.migrationReadyAt = NOTICE;
      closesOpenTheNext(w);
      let cancel = false;
      let sims = 0;
      w.simulate = (c) => {
        if (c.fn !== "closeBatch") return 200_000n;
        sims++;
        if (cancel) w.door.canClose = false;
        return w.door.canClose ? 200_000n : { error: "BatchNotReady" };
      };
      const r = await rounds(w, 4, {
        between: (i) => {
          w.door.canClose = true;
          cancel = i < 3;
        },
      });
      expect(w.sends.map((s) => [s.fn, s.args])).toEqual([["closeBatch", [7n, 0n]]]);
      expect(r.lines.filter((l) => l.startsWith("Failed this round") || /SKIPPING/.test(l))).toEqual([]);
      expect(said(r.lines, "Not closed yet: the open batch can't close now (canClose() went false since the read: a cancel took it under every line that let it close, or a roll restarted its timer) (BatchNotReady); reading the open batch again")).toBe(3);
      expect(said(r.lines, "Skipped this round (closing batch 7 once (ForeverMoney's migration notice)): the open batch is not ready to close yet")).toBe(3);
      expect(r.memory.refusals.flush).toBeUndefined();
      expect(sims).toBe(4);
      // the door says it can close at the re-read too: simulated once more, and the second refusal is counted
      const v = world();
      v.alpha.migrationReadyAt = NOTICE;
      v.simulate = (c) => (c.fn === "closeBatch" ? { error: "BatchNotReady" } : 200_000n);
      const e = await flushV32(depsFor(v).deps, targetV32(d), 7n).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(SendRefused);
      expect((e as Error).message).toMatch(/\(BatchNotReady\(\)\)$/);
      expect(v.sends).toEqual([]);
    });

    it("no second flush after a memory loss: the batch open now opened after the notice began (by ForeverMoney's 7-day delay)", async () => {
      expect(FM_MIGRATION_DELAY_S).toBe(7 * 86_400);
      const w = world();
      w.alpha.migrationReadyAt = NOTICE;
      closesOpenTheNext(w);
      await rounds(w, 3);
      expect(w.sends.map((s) => [s.fn, s.args[0]])).toEqual([["closeBatch", 7n]]);
      // batch 8 (opened when 7 closed, after the notice began) has a deposit, and the keeper's memory is lost
      expect([w.door.id, w.door.start]).toEqual([8n, BigInt(T)]);
      w.door.deposits = [{ user: at("de03"), amount: TAO }];
      w.door.totalDeposits = TAO;
      const r = await rounds(w, 4, { from: T + 600 });
      expect(w.sends.map((s) => [s.fn, s.args[0]])).toEqual([["closeBatch", 7n]]);
      expect(r.lines).toContainEqual("MIGRATION NOTICE FLUSH: batch 8 opened after ForeverMoney's notice began, so the batch open then has closed: the notice's one close is done");
      const e = await flushV32(depsFor(w).deps, targetV32(d), 8n).catch((x: unknown) => x);
      expect((e as Error).message).toBe("batch 8 opened after ForeverMoney's notice began, so the batch open then has closed: the notice's one close is done");
      // a batch that opened a second before the notice began is the one the notice found open: it is flushed
      const v = world();
      v.alpha.migrationReadyAt = NOTICE;
      v.door.start = NOTICE - BigInt(FM_MIGRATION_DELAY_S) - 1n;
      closesOpenTheNext(v);
      await rounds(v, 2);
      expect(v.sends.map((s) => s.fn)).toEqual(["closeBatch"]);
    });

    it("N3: ForeverMoney's MIGRATION_DELAY() is read from the AlphaVault once, and the notice's start counted from it; when it can't be read, 7 days", async () => {
      // a 3-day delay: the notice began a day ago (migrationReadyAt in 2 days); the open batch opened 36 hours ago, before it
      const readyAt = BigInt(T + 2 * 86_400);
      const w = world();
      w.alpha.migrationReadyAt = readyAt;
      w.alpha.migrationDelay = 3n * DAY;
      w.door.start = BigInt(T - 36 * 3_600);
      closesOpenTheNext(w);
      await rounds(w, 4);
      expect(w.sends.map((s) => [s.fn, s.args[0]])).toEqual([["closeBatch", 7n]]);
      expect(w.calls.filter((c) => c.fn === "MIGRATION_DELAY")).toHaveLength(1);
      // an AlphaVault with no such getter: 7 days, so the same batch opened after the notice began (it would have begun 5
      // days ago): the one close is done, nothing is flushed
      const v = world();
      v.alpha.migrationReadyAt = readyAt;
      v.alpha.migrationDelay = undefined;
      v.door.start = BigInt(T - 36 * 3_600);
      closesOpenTheNext(v);
      const r = await rounds(v, 4);
      expect(v.sends).toEqual([]);
      expect(r.lines).toContainEqual("MIGRATION NOTICE FLUSH: batch 7 opened after ForeverMoney's notice began, so the batch open then has closed: the notice's one close is done");
      expect(r.lines.filter((l) => l.startsWith("ForeverMoney's MIGRATION_DELAY() can't be read"))).toEqual([
        "ForeverMoney's MIGRATION_DELAY() can't be read (the AlphaVault has no such getter): the notice is taken to have begun 7 days before migrationReadyAt",
      ]);
      // read once all the same: the answer is kept
      expect(v.calls.filter((c) => c.fn === "MIGRATION_DELAY")).toHaveLength(1);
      // the notice ends: what was kept is let go of, so the next notice reads it again, once (Task 52w fix M5)
      v.alpha.migrationReadyAt = 0n;
      const over = await rounds(v, 1, { memory: r.memory, from: T + 600 });
      v.alpha.migrationReadyAt = readyAt;
      v.alpha.migrationDelay = 3n * DAY;
      await rounds(v, 3, { memory: over.memory, from: T + 900 });
      expect(v.calls.filter((c) => c.fn === "MIGRATION_DELAY")).toHaveLength(2);
    });

    it("Task 52w fix: the flush waits while the vault would refuse the batch (paused, the launch door not Active, stake missing), said once, by hand too; once that clears before the deadline, it goes", async () => {
      const refusals: [string, (w: World, on: boolean) => void, string][] = [
        ["paused", (w, on) => void (w.vault.paused = on), "the vault is paused"],
        ["the launch door removed", (w, on) => void (w.vault.doorState = on ? 2 : 1), "the vault no longer takes the front door's batches (its door reads Removed there)"],
        ["stake missing", (w, on) => void (w.vault.stakeMissing = on), "some of the vault's stake is not on a listed hotkey (stake missing)"],
      ];
      const deadline = new Date((Number(NOTICE) - FLUSH_MARGIN_S) * 1000).toISOString().slice(0, 16).replace("T", " ");
      for (const [what, set, why] of refusals) {
        const w = world();
        w.alpha.migrationReadyAt = NOTICE;
        set(w, true);
        closesOpenTheNext(w);
        const r = await rounds(w, 4);
        expect(w.sends, what).toEqual([]);
        const waits = `ForeverMoney's migration is announced (migrationReadyAt ${NOTICE}): the open batch 7 waits on Base while ${why}, since a batch sent now would park on Bittensor as ForeverMoney's token; it is closed once the vault takes batches again, by ${deadline} UTC, and after that it stays on Base, safe, until the migration ends`;
        expect(r.lines.filter((l) => l.startsWith("MIGRATION NOTICE FLUSH")), what).toEqual([`MIGRATION NOTICE FLUSH WAITS: ${waits}`]);
        const e = await flushV32(depsFor(w).deps, targetV32(d), 7n).catch((x: unknown) => x);
        expect([e instanceof NotNow, (e as Error).message], what).toEqual([true, waits]);
        expect(w.sends, what).toEqual([]);
        // the vault takes batches again, before the deadline: the one close goes
        set(w, false);
        await rounds(w, 2, { memory: r.memory, journal: r.journal, from: T + 600 });
        expect(w.sends.map((s) => [s.fn, s.args[0]]), what).toEqual([["closeBatch", 7n]]);
      }
      // still refused within 24 hours of migrationReadyAt: missed, the batch stays on Base (the deadline first)
      const v = world();
      const soon = BigInt(T + 3_600);
      v.alpha.migrationReadyAt = soon;
      v.door.start = soon - BigInt(FM_MIGRATION_DELAY_S) - 100n;
      v.vault.paused = true;
      const r = await rounds(v, 3);
      expect(v.sends).toEqual([]);
      expect(r.lines.filter((l) => l.startsWith("MIGRATION NOTICE FLUSH"))).toEqual([expect.stringMatching(/^MIGRATION NOTICE FLUSH MISSED: /)]);
    });

    it("the migrationFinished guards (M2): after ForeverMoney's migration executed, no flush is offered or sent", async () => {
      const w = world();
      w.alpha.migrationReadyAt = NOTICE;
      w.alpha.migrationFinished = true;
      const r = await rounds(w, 3);
      expect(w.sends).toEqual([]);
      expect(r.lines).toContainEqual("MIGRATION NOTICE FLUSH: ForeverMoney's migration has executed: nothing is closed");
      const e = await flushV32(depsFor(w).deps, targetV32(d), 7n).catch((x: unknown) => x);
      expect((e as Error).message).toBe("ForeverMoney's migration has executed: nothing is closed");
      expect(w.sends).toEqual([]);
    });
  });

  describe("a park first seen long after its send (a fresh memory, a long outage) is rebuilt all the same (review I1)", () => {
    const WIDE = { base: 1_000_000n, bittensor: 1_000_000n };
    const idTopic = (id: Hex) => lower(padHex(id, { size: 32 }));
    const lookups = (w: World, id: Hex) => w.logQueries.filter((q) => lower(q.address) === lower(ADDR.baseAdapter) && q.topics[0] && lower(q.topics[0] as string) === idTopic(id));

    it("a park first seen 20 days after its send is rebuilt and refunded: the job pins every open park's send, so the index keeps it", async () => {
      const w = world();
      w.head.base = 9_000n + 864_000n + 100n;
      expect(w.head.base - 9_000n).toBeGreaterThan(blocksIn(SENT_RETAIN_S, w.blockS.base));
      const p = doors(7n);
      const park = parkInWorld(w, p, { converted: true, parkedAt: BigInt(T) - 20n * DAY + 1_800n });
      w.parkSim = () => "ReentrancyGuardReentrantCall";
      w.door.canClose = false;
      const r = await rounds(w, 6, { logsWindow: WIDE });
      expect(w.sends.map((s) => [s.fn, s.args])).toEqual([["refundParked", [p.recipient, p.sender, p.message]]]);
      expect(r.lines.filter((l) => l.startsWith("PARK NOT REBUILT") || l.startsWith("PARK SEND LOOKUP"))).toEqual([]);
      // found in the index, which kept it past its 15 days: no lookup by its id was needed
      expect(lookups(w, park.id)).toEqual([]);
    });

    it("in a notice, such a token park is converted", async () => {
      const w = world();
      w.head.base = 9_000n + 864_000n + 100n;
      const p = doors(7n);
      parkInWorld(w, p, { parkedAt: BigInt(T) - 20n * DAY + 1_800n });
      w.alpha.migrationReadyAt = NOTICE;
      w.door.canClose = false;
      const r = await rounds(w, 3, { logsWindow: WIDE });
      expect(w.sends.map((s) => [s.fn, s.args])).toEqual([["deliverParked", [p.recipient, p.sender, p.message]]]);
      expect(r.journal.rows[0].request.rail).toBe("migration-conversion");
    });

    it("a park whose send left the index first (a long outage) has it looked up by its id, chunk by chunk, resumably: then it is rebuilt and refunded", async () => {
      const w = world();
      w.head.base = 2_000_000n;
      const parkedAt = BigInt(T) - 20n * DAY + 1_800n;
      const p = doors(7n);
      const msg = laneMessage("Base → Bittensor", p, { amount: TAO, number: 1n });
      // its send, 20 days of Base's blocks back
      sendInWorld(w, "Base → Bittensor", msg, p, { block: 2_000_000n - 864_000n });
      // the index read on before the park was seen: the send, past its 15 days, left it
      const memory = freshMemory();
      const window = { base: 100_000n, bittensor: 1_000_000n };
      expect((await depsFor(w, memory, d, () => undefined, { logsWindow: window }).deps.cascadeSent()).map((x) => x.id)).toEqual([]);
      const park = parkInWorld(w, p, { converted: true, parkedAt, send: false, msg });
      w.parkSim = () => "ReentrancyGuardReentrantCall";
      w.door.canClose = false;
      // the second window of its lookup fails once (the run's read deadline): the next round reads on from there
      let n = 0;
      w.logsFail = (_i, chain, q) => (chain === "base" && q.topics[0] && lower(q.topics[0] as string) === idTopic(msg.id) && ++n === 2 ? new Error("the read deadline") : undefined);
      const r = await rounds(w, 3, { memory, logsWindow: window });
      expect(r.lines.filter((l) => l.startsWith("PARK SEND LOOKUP:"))).toEqual([
        `PARK SEND LOOKUP: park ${park.key.slice(0, 10)}… (bridge message ${msg.id.slice(0, 10)}…): its send is looked up by its id in Base's blocks 832700 to 1138700, read to 932699 so far (the read deadline); it goes on next round`,
      ]);
      expect(w.sends.map((s) => [s.fn, s.args])).toEqual([["refundParked", [p.recipient, p.sender, p.message]]]);
      // each window of the bounded range read once, the one cut off read again from where it stopped
      expect(lookups(w, msg.id).map((q) => [q.from, q.to])).toEqual([
        [832_700n, 932_699n],
        [932_700n, 1_032_699n],
        [1_032_700n, 1_132_699n],
        [1_132_700n, 1_138_700n],
      ]);
      expect(PARK_SENT_LOOKBACK_S).toBe(7 * 86_400);
    });

    it("a park whose send can't be found is said loudly, once, and waits: nothing is sent for it (looked up in the 7 days before it parked, then from the deployment's start)", async () => {
      const w = world();
      const parkedAt = BigInt(T) - 15n * DAY;
      parkInWorld(w, doors(7n), { converted: true, parkedAt, send: false });
      w.parkSim = () => "ReentrancyGuardReentrantCall";
      const r = await rounds(w, 11);
      expect(w.sends).toEqual([]);
      const lines = r.lines.filter((l) => l.startsWith("PARK NOT REBUILT"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/: its send was not found among Cascade's on Base, in the index or by its id in Base's blocks 100 to \d+ \(from the deployment's start\); nothing is sent for it$/);
    });

    it("N5: a park whose send is older than the 7 days before it parked (its message sat in FAILURE longer, then was re-run by hand) is looked up from the deployment's start: then it is rebuilt and refunded", async () => {
      const w = world();
      w.head.base = 2_000_000n;
      const parkedAt = BigInt(T) - 15n * DAY;
      const p = doors(7n);
      const msg = laneMessage("Base → Bittensor", p, { amount: TAO, number: 1n });
      // its send, 25 days of Base's blocks before it parked
      sendInWorld(w, "Base → Bittensor", msg, p, { block: 2_000_000n - (15n + 25n) * 43_200n });
      // the index read on before the park was seen: the send, past its 15 days, left it; nor do the 7 days hold it
      const memory = freshMemory();
      const window = { base: 100_000n, bittensor: 1_000_000n };
      expect((await depsFor(w, memory, d, () => undefined, { logsWindow: window }).deps.cascadeSent()).map((x) => x.id)).toEqual([]);
      parkInWorld(w, p, { converted: true, parkedAt, send: false, msg });
      w.parkSim = () => "ReentrancyGuardReentrantCall";
      w.door.canClose = false;
      const r = await rounds(w, 3, { memory, logsWindow: window });
      expect(w.sends.map((s) => [s.fn, s.args])).toEqual([["refundParked", [p.recipient, p.sender, p.message]]]);
      expect(r.lines.filter((l) => l.startsWith("PARK NOT REBUILT"))).toEqual([]);
      // looked up in its 7 days first, then from the deployment's start (block 100)
      const from = lookups(w, msg.id).map((q) => q.from);
      expect(from[0]).toBeGreaterThan(100n);
      expect(from).toContain(100n);
    });
  });

  describe("a refused park's hold doubles, 1 h up to 24 h, its count kept until the park's state changes (review I3)", () => {
    it("holdPark: 1, 2, 4, 8, 16, then 24 hours, on and on", () => {
      const memory = freshMemory();
      const key: Hex = `0x${"aa".repeat(32)}`;
      const holds = [0, 1, 2, 3, 4, 5, 6, 7].map(() => (holdPark(memory, key, T * 1000) - T * 1000) / PARK_HOLD_MS);
      expect(holds).toEqual([1, 2, 4, 8, 16, 24, 24, 24]);
    });

    /** The park job at the job level, pass by pass (every 5 minutes; with `jump`, straight to the park's hold's end), for
     * `days`: its deliveries sent. */
    async function passes(w: World, key: Hex, days: number, o: { jump?: boolean; between?: (now: number) => void } = {}) {
      const memory = freshMemory();
      let now = T * 1000;
      while (now < (T + days * 86_400) * 1000) {
        o.between?.(now);
        memory.tick = 5;
        w.time.bittensor = now / 1000;
        w.time.base = now / 1000;
        const { deps } = depsFor(w, memory, d);
        const got = await parksV32(deps, memory, await deps.readState(), { now, onlyConversions: false });
        const job = got?.parkJobs?.find((j) => j.job === "deliver");
        if (job) await parkJobV32(deps, targetV32(d), { kind: "park", ...job }, { memory, now }).catch(() => undefined);
        const held = (memory.reads.parks as { held?: Record<string, { until: number }> } | undefined)?.held?.[lower(key)];
        now = Math.max(now + 5 * 60_000, o.jump ? (held?.until ?? 0) : 0);
      }
      return w.sends.filter((s) => s.fn === "deliverParked").length;
    }

    it("a native park the vault keeps refusing costs at most about 18 sends over its 14 days", async () => {
      const w = world();
      const park = parkInWorld(w, doors(7n), { converted: true, parkedAt: BigInt(T) });
      w.vaultTakesParks = false;
      w.door.canClose = false;
      // sent at 0, 1, 3, 7, 15 and 31 hours, then a day apart: 18 before the refund is due
      expect(await passes(w, park.key, 14, { jump: true })).toBe(18);
    });

    it("the hold, and its count, end when the park's state changes (another caller converted it): its delivery is tried at once", async () => {
      const w = world();
      const park = parkInWorld(w, doors(7n), { parkedAt: BigInt(T) });
      w.door.canClose = false;
      // the first delivery reverts with nothing to explain it: held an hour
      let first = true;
      w.fate = (c) => (c.fn === "deliverParked" && first ? ((first = false), "revert") : "mine");
      const k = lower(park.key);
      const sent = await passes(w, park.key, 1 / 24 / 2, { between: (now) => {
        // at 10 minutes another caller's delivery converts it (the vault refused it): its record changes
        if (now === T * 1000 + 10 * 60_000) w.parks[k] = [TAO, BigInt(T), true];
      } });
      // the revert at 0, then the delivery at 10 minutes, not at the hour's end
      expect(sent).toBe(2);
      expect(w.parks[k]).toBeUndefined();
    });
  });

  it("refundsWithTheQuotedFeeAfter14Days", async () => {
    const w = world();
    const parkedAt = BigInt(T) - 13n * DAY;
    const p = doors(7n);
    const park = parkInWorld(w, p, { converted: true, parkedAt });
    // the vault refuses it all along
    w.parkSim = () => "ReentrancyGuardReentrantCall";
    await rounds(w, 6);
    expect(w.sends).toEqual([]);
    // 14 days after it parked (the record's parkedAt): refunded with quoteRefund's fee as its value (the open batch can't
    // close meanwhile, so nothing else is due)
    const later = Number(parkedAt + 14n * DAY);
    w.time.bittensor = later;
    w.time.base = later;
    w.door.canClose = false;
    const r = await rounds(w, 6, { from: later });
    expect(w.sends.map((s) => [s.fn, s.args, s.value])).toEqual([["refundParked", [p.recipient, p.sender, p.message], w.refundFee]]);
    expect(w.parks[lower(park.key)]).toBeUndefined();
    // its refund's bridge message is recorded with the send
    expect(r.journal.rows[0].messageId).toBe(keccak256(new TextEncoder().encode(`refund:${lower(park.key)}`)));
  });

  it("a refund whose quoted fee is above its cap waits, said once, and goes once the fee falls under it", async () => {
    const w = world();
    const parkedAt = BigInt(T) - 15n * DAY;
    parkInWorld(w, doors(7n), { parkedAt });
    w.parkSim = () => "ConversionShort";
    w.refundFee = PARK_REFUND_FEE_MAX + 1n;
    const r = await rounds(w, 11);
    expect(w.sends).toEqual([]);
    expect(said(r.lines, "PARK REFUND WAITS:")).toBe(1);
    // a deployment's own cap (the job reads again within five rounds)
    const roomy = deploymentFor({ parkRefundFeeMax: PARK_REFUND_FEE_MAX * 2n });
    await rounds(w, 5, { memory: r.memory, dep: roomy, from: T + 700 });
    expect(w.sends.map((s) => [s.fn, s.value])).toEqual([["refundParked", PARK_REFUND_FEE_MAX + 1n]]);
  });

  it("dropsAnEmptyPark: an empty park (a refused redeem-only batch) is dropped after the timeout, never before, with no value", async () => {
    const w = world();
    const parkedAt = BigInt(T) - 13n * DAY;
    const p = doors(7n, 0n);
    parkInWorld(w, p, { amount: 0n, converted: true, parkedAt });
    w.parkSim = () => "ReentrancyGuardReentrantCall";
    await rounds(w, 6);
    expect(w.sends).toEqual([]);
    const later = Number(parkedAt + 14n * DAY) + 60;
    w.time.bittensor = later;
    w.time.base = later;
    w.door.canClose = false;
    await rounds(w, 6, { from: later });
    expect(w.sends.map((s) => [s.fn, s.args, s.value])).toEqual([["dropParked", [p.recipient, p.sender, p.message], 0n]]);
    expect(w.parks).toEqual({});
  });
});

describe("the rails apply to every park send; a conversion during a live notice also passes the spend cap, counted (the controller's ruling)", () => {
  /** Bittensor already at its 24 h spend cap: a landed stake that cost it all */
  const capped = deploymentFor({ spendCap: { base: parseEther("0.0017"), bittensor: parseEther("0.033") } });
  const atCap = () => {
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
    return journal;
  };

  it("at Bittensor's cap during a notice, the conversion goes, and its cost is counted", async () => {
    const w = world();
    parkInWorld(w, doors(5n));
    w.alpha.migrationReadyAt = NOTICE;
    const journal = atCap();
    const before = spentOn(journal.rows, "bittensor", T * 1000);
    await rounds(w, 1, { dep: capped, journal });
    expect(w.sends.map((s) => s.fn)).toEqual(["deliverParked"]);
    const row = journal.rows.at(-1) as JournalRow;
    expect(row.request.rail).toBe("migration-conversion");
    expect(spentOn(journal.rows, "bittensor", T * 1000)).toBeGreaterThan(before);
  });

  it("at Bittensor's cap without a notice: a park delivery waits (the cap is for everything else)", async () => {
    const w = world();
    parkInWorld(w, doors(5n));
    await rounds(w, 3, { dep: capped, journal: atCap() });
    expect(w.sends).toEqual([]);
  });

  it("one-shot at the send path: a tagged conversion of a token park passes the cap during the notice; an untagged deliverParked does not", async () => {
    const w = world();
    const p = parkInWorld(w, doors(5n));
    w.alpha.migrationReadyAt = NOTICE;
    const ref = { key: p.key, ...doors(5n) };
    const t = targetV32(capped);
    const untagged = await keeperSend(depsFor(w, freshMemory(), capped, () => undefined, { journal: atCap() }).deps, deliverParkedRequest(t, ref, 5, 1_000_000n)).catch((x: unknown) => x);
    expect((untagged as SendRefused).reason).toBe("spend-cap");
    const { deps } = depsFor(w, freshMemory(), capped, () => undefined, { journal: atCap() });
    await keeperSend(deps, convertParkRequest(t, ref, 5, 1_000_000n));
    expect(w.sends.map((s) => s.fn)).toEqual(["deliverParked"]);
    // without a notice, the tag alone passes nothing
    const v = world();
    parkInWorld(v, doors(5n));
    const e = await keeperSend(depsFor(v, freshMemory(), capped, () => undefined, { journal: atCap() }).deps, convertParkRequest(t, ref, 5, 1_000_000n)).catch((x: unknown) => x);
    expect((e as SendRefused).reason).toBe("spend-cap");
    expect(v.sends).toEqual([]);
  });

  it("a stuck conversion on a capped Bittensor during the notice is sent again at a higher fee, not cancelled (T51 re-review's Minor)", async () => {
    const w = world();
    parkInWorld(w, doors(5n));
    w.alpha.migrationReadyAt = NOTICE;
    w.pooled = true;
    w.fate = () => "hold";
    const first = await rounds(w, 1);
    expect(w.sends.map((s) => s.fn)).toEqual(["deliverParked"]);
    const journal = first.journal;
    journal.rows.push(...atCap().rows);
    const r = await rounds(w, 1, { memory: first.memory, journal, dep: capped, from: T + REPLACE_AFTER_MS / 1000 + 60 });
    expect(r.lines).toContainEqual(expect.stringMatching(/^REPLACING transaction 0x[0-9a-f]{64} \(converting token park/));
    expect(w.sends.map((s) => s.fn)).toEqual(["deliverParked", "deliverParked"]);
  });

  it("a stuck conversion whose park another caller converted meanwhile: its replacement is refused at the cap, so its nonce is cancelled (review M3, Task 51's cancel)", async () => {
    const w = world();
    const p = parkInWorld(w, doors(5n));
    w.alpha.migrationReadyAt = NOTICE;
    // the open batch can't close: only the conversion and its nonce are in play here
    w.door.canClose = false;
    w.pooled = true;
    w.fate = () => "hold";
    const first = await rounds(w, 1);
    expect(w.sends.map((s) => s.fn)).toEqual(["deliverParked"]);
    // another caller's conversion of the same park lands meanwhile: it is no token park any more
    w.parks[lower(p.key)] = [TAO, BigInt(T - 3_600), true];
    const journal = first.journal;
    journal.rows.push(...atCap().rows);
    w.fate = () => "mine";
    const r = await rounds(w, 1, { memory: first.memory, journal, dep: capped, from: T + REPLACE_AFTER_MS / 1000 + 60 });
    expect(r.lines).toContainEqual(expect.stringMatching(/^CANCELLING transaction 0x[0-9a-f]{64} \(converting token park .*: the replacement was refused at the spend cap \(.*\), where only a cancel goes$/));
    // the stuck nonce is taken by a cancel (a transfer of nothing to the keeper itself), never left until the cap lifts
    expect(w.sends.map((s) => [s.fn, lower(s.to)])).toEqual([
      ["deliverParked", lower(ADDR.bitAdapter)],
      ["transfer", lower(KEY.address)],
    ]);
  });

  it("a hold stops the park jobs; under a hold during the notice, the conversion goes and the flush and the delivery wait", async () => {
    const w = world();
    const old = BigInt(T) - 15n * DAY;
    parkInWorld(w, doors(3n), { converted: true });
    parkInWorld(w, doors(4n, 0n), { amount: 0n, converted: true, parkedAt: old });
    parkInWorld(w, doors(2n), { converted: true, parkedAt: old });
    w.monitor.hold = ["h-1"];
    await rounds(w, 6);
    expect(w.sends).toEqual([]);
    // during the notice: only the token park's conversion
    const tp = parkInWorld(w, doors(5n));
    w.alpha.migrationReadyAt = NOTICE;
    await rounds(w, 6, { from: T + 600 });
    expect(w.sends.map((s) => [s.fn, s.args[2]])).toEqual([["deliverParked", batch(5n)]]);
    expect(w.parks[lower(tp.key)]).toBeUndefined();
    // and under the hold the native and empty parks cost nothing: never simulated nor quoted
    expect(w.calls.filter((c) => c.fn === "deliverParked" || c.fn === "quoteRefund")).toEqual([]);
  });
});
