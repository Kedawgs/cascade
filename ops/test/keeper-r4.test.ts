import { readFileSync } from "node:fs";
import { type Address, encodeAbiParameters, encodeEventTopics, getAddress, type Hex, parseAbi, parseAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { encodeBatch, type Entry } from "../src/keeper/core/batch.ts";
import type { DeploymentV32 } from "../src/keeper/core/deployment.ts";
import { type JournalRow, memoryJournal } from "../src/keeper/core/journal.ts";
import { encodeMemory, freshMemory, type KeeperMemory, loadMemory } from "../src/keeper/core/memory.ts";
import { type Payout, payoutsHash } from "../src/keeper/core/payouts.ts";
import { runRound } from "../src/keeper/core/round.ts";
import { claimGasLimit } from "../src/keeper/core/rewards.ts";
import { payoutsV32, targetV32 } from "../src/keeper/core/v32/actions.ts";
import { closeByHand, parkByHand } from "../src/keeper/core/v32/hand.ts";
import { INBOUND_GAS_CAP, PARK_GAS_MARGIN, PARK_TIMEOUT_S } from "../src/keeper/core/v32/parked.ts";
import { convertParkRequest, deliverParkedRequest } from "../src/keeper/core/v32/requests.ts";
import { BITTENSOR_BLOCK_GAS_LIMIT, EXIT_GAS_RESERVE, MAX_HOTKEYS, MAX_KEEPER_GAS, MAX_UNSTAKE_GAS } from "../src/keeper/core/v32/payout.ts";
import { BITTENSOR_TX_GAS_CEILING } from "../src/keeper/core/ceiling.ts";
import { forLifeProblems } from "../src/keeper/core/v32/readiness.ts";
import { reexecByHand } from "../src/keeper/core/v32/reexec-hand.ts";
import { ADDR, type Batch, deploymentFor, depsFor, failInWorld, laneMessage, PAIR2, parkInWorld, RAO, sendInWorld, storeOf, T, TAO, type World, world } from "./keeper-v32-world.ts";

// Checkpoint R4's keeper fixes (r4o-dispatch.md; the reviews r4-A to r4-D):
// - A-M1 and C-M1: a parked delivery and a token park's conversion go out with a gas floor (the adapter's own
//   parkedDeliveryGas(message), read live since merge 7b, plus PARK_GAS_MARGIN) above the estimate, never at 1.25 × it, so
//   the vault's call can't be starved into a re-park;
// - D-M2 and C-M2: every adapter pair the deployment lists, its parks, its conversions and its FAILUREs;
// - B-L2: a payout batch is forgotten only on a read made at a block at or past its queue log's;
// - C-L2: no park delivery is simulated while the vault refuses batches or the park's adapter is not enabled on it;
// - Task 41a's Minor 6: processPayouts' gas covers MAX_UNSTAKE_GAS × positions + EXIT_GAS_RESERVE, under the keeper's
//   and Bittensor's bounds (Task 65: the reserve 2,000,000, the bound Bittensor's per-transaction ceiling).
// On fake chains (keeper-v32-world.ts).

const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);
const lower = (a: string) => a.toLowerCase();
const OPTS = { intervalMs: 60_000, policy: { claimCostTao: 57n * 10n ** 15n, claimMultiple: 25n, monthlyClaimMaxUsd: 20 }, rewardsEveryTicks: 1000 };
const NOTICE = BigInt(T + 7 * 86_400);
/** The world's estimate of every call (w.simulate's default) */
const ESTIMATE = 200_000n;
const users = (n: number, tag: string): Entry[] => Array.from({ length: n }, (_, i) => ({ user: at(`${tag}${(i + 1).toString(16).padStart(3, "0")}`), amount: TAO / 100n }));
/** The door's batch `id`, parked on its way to the vault: `n` deposits of 0.01 TAO each */
const doorsN = (id: bigint, n: number) => ({ recipient: ADDR.vault, sender: ADDR.frontDoor, message: encodeBatch(id, users(n, "de"), []) });
/** The inbound requirement of a delivery of `entries` entries on the adapter whose inbound pair is `model`: what its
 * parkedDeliveryGas(message) answers (merge 7b: the pair includes PARK_GAS_RESERVE, counted once, in the pair) */
const requirement = (model: readonly [bigint, bigint], entries: number) => model[0] + BigInt(entries) * model[1];
/** The world's two Bittensor adapters' inbound pairs (keeper-v32-world.ts parkModel): the launch pair, and another */
const MODEL1 = [1_300_000n, 57_000n] as const;
const MODEL2 = [1_400_000n, 55_000n] as const;

async function rounds(w: World, n: number, o: { dep?: DeploymentV32; memory?: KeeperMemory; from?: number; journal?: ReturnType<typeof memoryJournal> } = {}) {
  const lines: string[] = [];
  const journal = o.journal ?? memoryJournal();
  let saved = encodeMemory(o.memory ?? freshMemory());
  let memory = freshMemory();
  const dep = o.dep ?? deploymentFor();
  for (let i = 0; i < n; i++) {
    memory = loadMemory(saved).memory;
    const now = ((o.from ?? T) + i * 60) * 1000;
    const { deps } = depsFor(w, memory, dep, (l) => lines.push(l), { journal });
    const r = await runRound(deps, targetV32(dep), memory, { ...OPTS, now: () => now });
    expect(r.end, `round ${i + 1}: ${lines.at(-1)}`).toBeUndefined();
    saved = encodeMemory(r.memory);
  }
  return { lines, memory, journal };
}

/** A quiet world: the open batch can't close (nothing else is due) */
function quiet(): World {
  const w = world();
  w.door.canClose = false;
  return w;
}

/** The world's vault as the adapter's catch meets it (A-M1): a delivery mined with less gas than the call's own work (the
 * estimate) and the adapter's requirement (its inbound model for the entries, the reserve included) is starved, and the
 * park kept */
const starvesBelow = (w: World, model: readonly [bigint, bigint]) => {
  w.deliverStarvedBelow = (c) => {
    const message = c.args[2] as Hex;
    const entries = (message.length - 2) / 64 - 6;
    return ESTIMATE + requirement(model, entries / 2);
  };
};

describe("A-M1 and C-M1: a parked delivery's gas floor (the keeper half)", () => {
  for (const n of [1, 50]) {
    it(`deliverParked of a ${n}-entry park goes with the estimate, the adapter's parkedDeliveryGas for its ${n} entr${n === 1 ? "y" : "ies"} and the margin: the vault is not starved`, async () => {
      const w = quiet();
      starvesBelow(w, MODEL1);
      parkInWorld(w, doorsN(7n, n), { amount: (TAO / 100n) * BigInt(n), converted: true });
      const r = await rounds(w, 6);
      const d = w.sends.filter((s) => s.fn === "deliverParked");
      expect(d).toHaveLength(1);
      expect(d[0].gas).toBe(ESTIMATE + requirement(MODEL1, n) + PARK_GAS_MARGIN);
      // never 1.25 × the estimate, which starves it
      expect(d[0].gas).toBeGreaterThan((ESTIMATE * 125n) / 100n);
      expect(w.parks).toEqual({});
      expect(r.lines).toContainEqual(expect.stringMatching(/^Park 0x[0-9a-f]{8}… delivered to the vault$/));
    });
  }

  it("the notice's conversion of a 50-entry token park carries the same floor, read from the park's own pair", async () => {
    const w = quiet();
    starvesBelow(w, MODEL1);
    parkInWorld(w, doorsN(5n, 50), { amount: TAO / 2n });
    w.alpha.migrationReadyAt = NOTICE;
    const r = await rounds(w, 2);
    const c = w.sends.filter((s) => s.fn === "deliverParked");
    expect(c).toHaveLength(1);
    expect(r.journal.rows[0].request.rail).toBe("migration-conversion");
    expect(c[0].gas).toBe(ESTIMATE + requirement(MODEL1, 50) + PARK_GAS_MARGIN);
    expect(w.parks).toEqual({});
  });

  it("pnpm ops park <key> --send sends the delivery with the floor too", async () => {
    const w = quiet();
    starvesBelow(w, MODEL1);
    const p = parkInWorld(w, doorsN(9n, 1), { amount: TAO / 100n, converted: true });
    const lines: string[] = [];
    const dep = deploymentFor();
    const { deps } = depsFor(w, freshMemory(), dep, (l) => lines.push(l));
    expect(await parkByHand(deps, targetV32(dep), freshMemory(), { key: p.key, send: true, live: true, now: T * 1000 })).toBe(0);
    expect(w.sends.map((s) => [s.fn, s.gas])).toEqual([["deliverParked", ESTIMATE + requirement(MODEL1, 1) + PARK_GAS_MARGIN]]);
    expect(w.parks).toEqual({});
  });

  it("merge 7b: the floor is the adapter's own parkedDeliveryGas(message), read live, never recomputed: the Base pair, the reserve and Base's RPC play no part", async () => {
    const w = quiet();
    // the adapter answers its own model, here one the keeper couldn't rebuild from the Base adapter's pair; the Base pair's
    // reads fail, and the world answers no PARK_GAS_RESERVE at all
    w.parkModel[lower(ADDR.bitAdapter)] = [2_000_000n, 40_000n];
    starvesBelow(w, [2_000_000n, 40_000n]);
    w.callAt = (c) => (c.chain === "base" && (c.fn === "gasBase" || c.fn === "gasPerEntry") ? new Error("Base's RPC is down") : undefined);
    parkInWorld(w, doorsN(7n, 2), { amount: TAO / 50n, converted: true });
    const r = await rounds(w, 6);
    expect(w.sends.filter((s) => s.fn === "deliverParked").map((s) => s.gas)).toEqual([ESTIMATE + 2_000_000n + 2n * 40_000n + PARK_GAS_MARGIN]);
    expect(w.parks).toEqual({});
    expect(r.lines.some((l) => l.startsWith("PARK GAS AT THE CAP"))).toBe(false);
    // the view is the contract's, as built: the inbound pair, the reserve counted once in it (R4-K round 3, Minor 5)
    expect(readFileSync(new URL("../../contracts/src/adapters/CcipBittensorAdapter.sol", import.meta.url), "utf8")).toMatch(
      /function parkedDeliveryGas\(bytes memory message\) public view returns \(uint256\) \{\s+return _gasModel\(message, inboundGasBase, inboundGasPerEntry\);/,
    );
  });
});

describe("D-M2 and C-M2: every adapter pair the deployment lists", () => {
  const two = deploymentFor({ pairs: [PAIR2] });

  it("a park on the second pair is found, rebuilt from the second Base adapter's send, and delivered through the second Bittensor adapter, with that pair's gas model", async () => {
    const w = quiet();
    starvesBelow(w, MODEL2);
    const p = parkInWorld(w, doorsN(8n, 2), { amount: TAO / 50n, converted: true, pair: 2 });
    // the deploy's pair alone: the second pair's park is never seen
    await rounds(w, 6);
    expect(w.sends).toEqual([]);
    const r = await rounds(w, 6, { dep: two });
    expect(w.sends.map((s) => [s.fn, lower(s.to), s.gas])).toEqual([["deliverParked", lower(ADDR.bitAdapter2), ESTIMATE + requirement(MODEL2, 2) + PARK_GAS_MARGIN]]);
    expect(storeOf(w, ADDR.bitAdapter2).parks).toEqual({});
    expect(r.lines).toContainEqual(`Park ${p.key.slice(0, 10)}… delivered to the vault`);
  });

  it("a token park on the second pair is converted at the notice (the rails' exception checks it on its own adapter), and one 14 days old is refunded there", async () => {
    const w = quiet();
    const tok = parkInWorld(w, doorsN(3n, 1), { amount: TAO / 100n, pair: 2 });
    const old = parkInWorld(w, doorsN(4n, 1), { amount: TAO / 100n, converted: true, pair: 2, parkedAt: BigInt(T - PARK_TIMEOUT_S - 60) });
    w.parkSim = (k) => (k === lower(old.key) ? "ReentrancyGuardReentrantCall" : undefined);
    w.alpha.migrationReadyAt = NOTICE;
    // a hold: only the conversion may go, and only once checked on chain as a token park of the door's
    w.monitor.hold = ["vault.share_price_drop"];
    const r1 = await rounds(w, 2, { dep: two });
    expect(w.sends.map((s) => [s.fn, lower(s.to)])).toEqual([["deliverParked", lower(ADDR.bitAdapter2)]]);
    expect(r1.journal.rows[0].request.rail).toBe("migration-conversion");
    expect(storeOf(w, ADDR.bitAdapter2).parks[lower(tok.key)]).toBeUndefined();
    // the hold and the notice over: the old one is refunded through its own adapter
    w.monitor.hold = [];
    w.alpha.migrationReadyAt = 0n;
    await rounds(w, 6, { dep: two, memory: r1.memory, from: T + 600 });
    expect(w.sends.map((s) => [s.fn, lower(s.to)]).slice(1)).toEqual([["refundParked", lower(ADDR.bitAdapter2)]]);
    expect(storeOf(w, ADDR.bitAdapter2).parks).toEqual({});
  });

  it("pnpm ops park lists the second pair's park and sends its job to its own adapter", async () => {
    const w = quiet();
    const p = parkInWorld(w, doorsN(6n, 1), { amount: TAO / 100n, converted: true, pair: 2 });
    const lines: string[] = [];
    const { deps } = depsFor(w, freshMemory(), two, (l) => lines.push(l));
    expect(await parkByHand(deps, targetV32(two), freshMemory(), { key: p.key, send: true, live: true, now: T * 1000 })).toBe(0);
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^Park ${p.key}: deliver due: `)));
    expect(w.sends.map((s) => [s.fn, lower(s.to)])).toEqual([["deliverParked", lower(ADDR.bitAdapter2)]]);
  });

  it("a FAILURE on the second pair is reported, holds its lane after 30 minutes, and pnpm ops reexec re-executes it", async () => {
    const w = quiet();
    const payload = { recipient: ADDR.vault, sender: ADDR.frontDoor, message: encodeBatch(11n, users(1, "de"), []) };
    const msg = laneMessage("Base → Bittensor", payload, { amount: TAO / 100n, number: 77n, pair: 2 });
    sendInWorld(w, "Base → Bittensor", msg, payload, { pair: 2 });
    failInWorld(w, "Base → Bittensor", msg);
    // the deploy's pair alone: it is not one of Cascade's
    const r0 = await rounds(w, 1);
    expect(r0.lines.some((l) => l.startsWith("CCIP FAILURE"))).toBe(false);
    const r = await rounds(w, 1, { dep: two });
    expect(r.lines).toContainEqual(expect.stringMatching(new RegExp(`^CCIP FAILURE: bridge message ${lower(msg.id)} \\(Base → Bittensor\\) is in FAILURE on Bittensor's OffRamp`)));
    // by hand: found among Cascade's own (the second pair's send), rebuilt against the second pair, and sent
    const lines: string[] = [];
    const { deps } = depsFor(w, freshMemory(), two, (l) => lines.push(l));
    const code = await reexecByHand(deps, targetV32(two), freshMemory(), { id: msg.id, send: true, live: true, now: T * 1000 });
    expect(code, lines.join("\n")).toBe(0);
    expect(w.sends.map((s) => s.fn)).toEqual(["execute"]);
    expect(w.messageStates[lower(msg.id)]).toBe(2);
  });

  it("the hourly I-7 check reads every pair's Bittensor adapter", async () => {
    const w = quiet();
    w.answers[`${lower(ADDR.bitAdapter2)}:parkedNative`] = () => 5n * TAO;
    w.balances[lower(ADDR.bitAdapter2)] = TAO;
    const { deps } = depsFor(w, freshMemory(), two);
    expect(await forLifeProblems(deps)).toContainEqual(`the Bittensor adapter ${ADDR.bitAdapter2} holds ${TAO} wei of TAO, less than the ${5n * TAO} its parks owe`);
    expect(await forLifeProblems(depsFor(w, freshMemory(), deploymentFor()).deps)).toEqual([]);
  });

  it("a live primary the deployment doesn't list is said loudly: its parks and FAILUREs are not watched until the pair is added", async () => {
    const w = quiet();
    w.answers[`${lower(ADDR.vaultLens)}:primaryBridge`] = () => ADDR.bitAdapter2;
    const r = await rounds(w, 1);
    expect(r.lines).toContainEqual(
      `RAILS NOT LISTED: the vault's primary bridge ${ADDR.bitAdapter2} is not one of the keeper's adapter pairs: its parks and CCIP FAILUREs are not watched. Add the pair (pnpm ops add-pair <bridge> <bridge> --live), print DEPLOYMENT again and deploy the keeper (runbook section 8)`,
    );
    const r2 = await rounds(w, 1, { dep: two });
    expect(r2.lines.some((l) => l.startsWith("RAILS NOT LISTED"))).toBe(false);
  });
});

/** A payout batch queued in the world: its redeems' logs and its queue log (at `block`), and the vault's record. */
function queue(w: World, key: Hex, list: Payout[], block = 5_000n): Batch {
  list.forEach((p, i) => w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "Redeemed", args: { key, user: p.user, shares: p.shares, assets: p.assets }, block: block + BigInt(i) }));
  const total = list.reduce((t, p) => t + p.assets, 0n);
  w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "PayoutBatchQueued", args: { key, sourceChain: 8453n, batchId: 7n, count: list.length, total, price: 10n ** 12n }, block: block + 50n });
  const b: Batch = { sourceChain: 8453n, frontDoor: ADDR.frontDoor, batchId: 7n, queuedAt: BigInt(T - 2 * 86_400), cursor: 0, count: list.length, chunk: 0, remaining: total, payoutsHash: payoutsHash(list) };
  w.vault.batches[lower(key)] = b;
  w.vault.pending += total;
  return b;
}
const KEY_A: Hex = `0x${"ab".repeat(32)}`;
const ALICE = at("a11c");

describe("B-L2: a payout batch is forgotten only on a read at a block at or past its queue log's", () => {
  /** A lens node behind the logs' node: its latest block is before the queue log, so getPayoutBatch reads empty there */
  const lagging = (w: World, o: { pinned?: "answers" | "fails" } = {}) => {
    w.callAt = (c) => {
      if (c.fn !== "getPayoutBatch") return undefined;
      if (c.tag === "latest") return { result: { sourceChain: 0n, frontDoor: at("0"), batchId: 0n, queuedAt: 0n, cursor: 0, count: 0, chunk: 0, remaining: 0n, payoutsHash: `0x${"00".repeat(32)}` } };
      // read at a block: the scan's head, which this node has, or not
      return o.pinned === "fails" ? new Error("header not found") : undefined;
    };
  };

  it("a lagging lens read doesn't forget a live batch: the read pinned at the scan's head lists it, and it is paid once due", async () => {
    const w = quiet();
    queue(w, KEY_A, [{ user: ALICE, shares: TAO, assets: TAO }]);
    lagging(w);
    const memory = freshMemory();
    const s = await depsFor(w, memory).deps.readState();
    expect(s.vault.batches.map((b) => lower(b.key))).toEqual([lower(KEY_A)]);
    expect((memory.reads.v32 as { deleted?: string[] }).deleted ?? []).toEqual([]);
  });

  it("a pinned read the node can't answer neither forgets the batch nor lists it: the next round reads it again", async () => {
    const w = quiet();
    queue(w, KEY_A, [{ user: ALICE, shares: TAO, assets: TAO }]);
    lagging(w, { pinned: "fails" });
    const memory = freshMemory();
    const s = await depsFor(w, memory).deps.readState();
    expect(s.vault.batches).toEqual([]);
    expect((memory.reads.v32 as { deleted?: string[] }).deleted ?? []).toEqual([]);
    // the lag over: it is read live again, and paid
    w.callAt = undefined;
    const s2 = await depsFor(w, memory).deps.readState();
    expect(s2.vault.batches.map((b) => lower(b.key))).toEqual([lower(KEY_A)]);
  });

  it("a deleted batch is forgotten only once its queue log is the re-read margin deep, counted at the last block time measured when this run can't read it", async () => {
    // Bittensor's headers flat from the head back: its block time can't be read this run
    const unreadable = (w: World) => {
      for (const back of [0n, 300n, 600n]) w.blockTimes[`bittensor:${w.head.bittensor - back}`] = w.time.bittensor;
    };
    // the queue log 600 blocks deep: past 400 (4,800 s at the old 12 s), short of 800 (at 6 s, the last measured)
    const deleted = (blockS?: number) => {
      const w = quiet();
      queue(w, KEY_A, [{ user: ALICE, shares: TAO, assets: TAO }], w.head.bittensor - 650n);
      delete w.vault.batches[lower(KEY_A)];
      unreadable(w);
      return { w, memory: freshMemory() };
    };
    const kept = deleted();
    kept.memory.reads.v32 = { blockS: { bittensor: 6 } };
    await depsFor(kept.w, kept.memory).deps.readState();
    expect((kept.memory.reads.v32 as { deleted?: string[] }).deleted ?? []).toEqual([]);
    // never measured: the old 12 s, so 400 blocks: forgotten
    const gone = deleted();
    await depsFor(gone.w, gone.memory).deps.readState();
    expect((gone.memory.reads.v32 as { deleted?: string[] }).deleted).toEqual([lower(KEY_A)]);
  });

  it("a batch deleted on chain (read empty at the scan's head) is still forgotten", async () => {
    const w = quiet();
    queue(w, KEY_A, [{ user: ALICE, shares: TAO, assets: TAO }]);
    delete w.vault.batches[lower(KEY_A)];
    const memory = freshMemory();
    await depsFor(w, memory).deps.readState();
    expect((memory.reads.v32 as { deleted?: string[] }).deleted).toEqual([lower(KEY_A)]);
  });
});

describe("C-L2: no park delivery is simulated while the vault refuses batches, or the park's adapter is not enabled on it", () => {
  const sims = (w: World) => w.calls.filter((c) => c.fn === "deliverParked").length;

  it("the launch door not Active on the vault: a token park is neither simulated nor converted; once Active again, delivered", async () => {
    const w = quiet();
    parkInWorld(w, doorsN(7n, 1), { amount: TAO / 100n });
    w.vault.doorState = 2;
    const r = await rounds(w, 6);
    expect(sims(w)).toBe(0);
    expect(w.sends).toEqual([]);
    expect(Object.values(w.parks)[0][2]).toBe(false);
    w.vault.doorState = 1;
    await rounds(w, 6, { memory: r.memory, from: T + 600 });
    expect(w.sends.map((s) => s.fn)).toEqual(["deliverParked"]);
  });

  it("the park's Bittensor adapter disabled on the vault: not simulated, not sent", async () => {
    const w = quiet();
    parkInWorld(w, doorsN(7n, 1), { amount: TAO / 100n });
    w.bridgeEnabled[lower(ADDR.bitAdapter)] = false;
    await rounds(w, 6);
    expect(sims(w)).toBe(0);
    expect(w.sends).toEqual([]);
    expect(Object.values(w.parks)[0][2]).toBe(false);
  });
});

describe("Task 41a's Minor 6: processPayouts' gas covers MAX_UNSTAKE_GAS × positions + EXIT_GAS_RESERVE, under the keeper's and Bittensor's bounds", () => {
  const src = (path: string) => readFileSync(new URL(`../../contracts/src/${path}`, import.meta.url), "utf8");

  it("the vault's figures, pinned: 4 hotkeys at most, 5,000,000 gas a removal at most, a 2,000,000 reserve (Task 65): 22,000,000 at the maximum, under Bittensor's per-transaction ceiling", () => {
    expect(src("CascadeConstants.sol")).toMatch(/uint256 constant MAX_HOTKEYS = 4;/);
    expect(src("CascadeVault.sol")).toMatch(/uint256 internal constant MAX_UNSTAKE_GAS = 5_000_000;/);
    expect([MAX_HOTKEYS, MAX_UNSTAKE_GAS, EXIT_GAS_RESERVE]).toEqual([4, 5_000_000n, 2_000_000n]);
    expect(EXIT_GAS_RESERVE + BigInt(MAX_HOTKEYS) * MAX_UNSTAKE_GAS).toBe(22_000_000n);
    // the keeper's highest gas limit is a claim's at the vault's MAX_CLAIM_GAS (the Worker's proof bound), which the
    // per-transaction ceiling holds (the T65 review's I-1: the pool refuses a limit above about 64,998,400, whatever the
    // block's 75,000,000)
    expect(BITTENSOR_TX_GAS_CEILING).toBe(64_900_000n);
    expect(BITTENSOR_BLOCK_GAS_LIMIT).toBe(75_000_000n);
    expect(MAX_KEEPER_GAS).toBe(claimGasLimit(63_400_000n));
    expect(MAX_KEEPER_GAS).toBe(BITTENSOR_TX_GAS_CEILING);
    expect(EXIT_GAS_RESERVE + BigInt(MAX_HOTKEYS) * MAX_UNSTAKE_GAS < MAX_KEEPER_GAS).toBe(true);
  });

  it("at the maximum (4 hotkeys, unstakeGas 5,000,000) a payout goes with the estimate plus 22,000,000", async () => {
    const w = quiet();
    queue(w, KEY_A, [{ user: ALICE, shares: TAO, assets: TAO }]);
    w.vault.hotkeyCount = 4;
    w.vault.unstakeGas = 5_000_000n;
    await payoutsV32(depsFor(w).deps, targetV32(deploymentFor()), KEY_A);
    expect(w.sends[0].gas).toBe(ESTIMATE + 22_000_000n);
  });

  it("an estimate that would take it past the keeper's bound goes at the bound (64,900,000, the per-transaction ceiling), never above, and one above the bound is refused", async () => {
    const w = quiet();
    queue(w, KEY_A, [{ user: ALICE, shares: TAO, assets: TAO }]);
    w.vault.hotkeyCount = 4;
    w.vault.unstakeGas = 5_000_000n;
    w.simulate = (c) => (c.fn === "processPayouts" ? 50_000_000n : 200_000n);
    await payoutsV32(depsFor(w).deps, targetV32(deploymentFor()), KEY_A);
    expect(w.sends[0].gas).toBe(MAX_KEEPER_GAS);
    const w2 = quiet();
    queue(w2, KEY_A, [{ user: ALICE, shares: TAO, assets: TAO }]);
    w2.simulate = (c) => (c.fn === "processPayouts" ? MAX_KEEPER_GAS + 1n : 200_000n);
    await expect(payoutsV32(depsFor(w2).deps, targetV32(deploymentFor()), KEY_A)).rejects.toThrow(/needs 64,900,001 gas, more than the 64,900,000 it may be sent with; nothing sent/);
    expect(w2.sends).toEqual([]);
  });
});

describe("S-H1 (the keeper): during ForeverMoney's migration notice no payout is sent and no batch closes but the notice's one close, said each round", () => {
  it("a due payout batch and the open batch's redeem requests wait on Base: nothing is sent for them, and each round says why", async () => {
    const w = quiet();
    queue(w, KEY_A, [{ user: ALICE, shares: TAO, assets: TAO }]);
    // the notice began two days ago (migrationReadyAt is its start plus ForeverMoney's 7 days), and the open batch opened
    // after it (the notice's one close is done), 25 hours ago: past its 24 h max wait, so its close would be due
    w.alpha.migrationReadyAt = BigInt(T + 5 * 86_400);
    w.door.start = BigInt(T - 25 * 3_600);
    w.door.canClose = true;
    w.door.deposits = [];
    w.door.totalDeposits = 0n;
    w.door.redeems = [{ user: ALICE, amount: TAO / 10n }];
    const r = await rounds(w, 2);
    expect(w.sends.filter((x) => x.fn === "processPayouts" || x.fn === "closeBatch")).toEqual([]);
    const said = r.lines.filter((l) => l.startsWith("MIGRATION NOTICE: while it runs"));
    expect(said).toEqual([
      "MIGRATION NOTICE: while it runs no payout is sent (its send would revert on ForeverMoney's closed depositLiquid; 1 payout batch waits) and no batch closes but the notice's one close (1 redeem request waits on Base)",
      "MIGRATION NOTICE: while it runs no payout is sent (its send would revert on ForeverMoney's closed depositLiquid; 1 payout batch waits) and no batch closes but the notice's one close (1 redeem request waits on Base)",
    ]);
    // the notice over: the payout goes
    w.alpha.migrationReadyAt = 0n;
    await rounds(w, 1, { from: T + 600 });
    expect(w.sends.map((x) => x.fn)).toContain("processPayouts");
  });

  it("merge 7b (the stuck review's keeper line): the first round of a notice names each queued payout batch to cancel, once; a batch queued later is named again; nothing when none waits", async () => {
    const KEY_B: Hex = `0x${"cd".repeat(32)}`;
    const w = quiet();
    queue(w, KEY_A, [{ user: ALICE, shares: TAO, assets: TAO }]);
    w.alpha.migrationReadyAt = BigInt(T + 5 * 86_400);
    const cancel = (lines: string[]) => lines.filter((l) => l.startsWith("MIGRATION NOTICE: cancel"));
    const line = (keys: Hex[]) =>
      `MIGRATION NOTICE: cancel ${keys.length === 1 ? "this queued payout batch" : "these queued payout batches"}, which can never be paid through this rail (no payout goes through it while the notice runs or after the migration): ${keys.join(", ")}. Cancel each before the replacement rail is scheduled (pnpm ops cancel-payouts <key> --for-wallet --live; runbook 7.7 step 3); a batch of bounced deposits alone can't be cancelled, and waits for the replacement rail`;
    const r = await rounds(w, 3);
    expect(cancel(r.lines)).toEqual([line([KEY_A])]);
    // a second batch queued during the notice (its logs past the head the scans have read): both named, once more
    queue(w, KEY_B, [{ user: at("4e02"), shares: TAO / 10n, assets: TAO / 10n }], 10_100n);
    w.head.bittensor += 500n;
    const r2 = await rounds(w, 2, { memory: r.memory, from: T + 600 });
    expect(cancel(r2.lines)).toEqual([line([KEY_A, KEY_B])]);
    // the notice cancelled, then announced again with the same queue: named again for the new notice
    w.alpha.migrationReadyAt = 0n;
    const off = await rounds(w, 1, { memory: r2.memory, from: T + 1_200 });
    expect(cancel(off.lines)).toEqual([]);
    w.alpha.migrationReadyAt = BigInt(T + 6 * 86_400);
    const again = await rounds(w, 1, { memory: off.memory, from: T + 1_260 });
    expect(cancel(again.lines)).toEqual([line([KEY_A, KEY_B])]);
    // no notice: nothing said, and nothing kept to say
    const quietOne = quiet();
    queue(quietOne, KEY_A, [{ user: ALICE, shares: TAO, assets: TAO }]);
    expect(cancel((await rounds(quietOne, 2)).lines)).toEqual([]);
    // a notice with nothing queued: nothing said
    const none = quiet();
    none.alpha.migrationReadyAt = BigInt(T + 5 * 86_400);
    expect(cancel((await rounds(none, 2)).lines)).toEqual([]);
  });
});

describe("C's unconfirmed item (R4): a CCIP FAILURE toward Bittensor open 30 minutes holds the notice's flush; pnpm ops close flushes by hand", () => {
  it("the round holds the flush while the FAILURE stands (a stranger can force one); by hand, during the notice, close is the notice's one close", async () => {
    const w = world();
    // the notice runs; the open batch opened before it began (two days in): its one close is due
    w.alpha.migrationReadyAt = BigInt(T + 5 * 86_400);
    w.door.start = BigInt(T - 3 * 86_400);
    const payload = { recipient: ADDR.vault, sender: ADDR.frontDoor, message: encodeBatch(6n, users(1, "de"), []) };
    const msg = laneMessage("Base → Bittensor", payload, { amount: TAO / 100n, number: 66n });
    sendInWorld(w, "Base → Bittensor", msg, payload, { block: 9_000n });
    failInWorld(w, "Base → Bittensor", msg);
    // the FAILURE was first seen over 30 minutes ago (its send's time, read once): the lane waits, and the flush with it
    w.blockTimes["base:9000"] = T - 3_600;
    const r = await rounds(w, 3);
    expect(w.sends.filter((x) => x.fn === "closeBatch")).toEqual([]);
    expect(r.lines.some((l) => l.startsWith("CCIP FAILURE: ") && l.includes("New closes and the migration notice's flush toward Bittensor wait until it is delivered."))).toBe(true);
    // by hand: the notice's one close, by its id, with minValue 0 (R12b: a 1-rao cancel must not void it)
    const { deps } = depsFor(w, freshMemory(), deploymentFor());
    await closeByHand(deps, targetV32(deploymentFor()));
    expect(w.sends.map((x) => [x.fn, x.args])).toEqual([["closeBatch", [7n, 0n]]]);
  });

  it("merge 7b (S-H1's deferral; R4-O's Minor 11 revisited): during the notice a hand close goes with the open batch's redeem requests, said: the vault defers each (the rail can't pay it), so none is burned", async () => {
    const w = world();
    w.alpha.migrationReadyAt = BigInt(T + 5 * 86_400);
    w.door.start = BigInt(T - 3 * 86_400);
    w.door.redeems = [{ user: at("4e01"), amount: TAO }];
    const lines: string[] = [];
    const { deps } = depsFor(w, freshMemory(), deploymentFor(), (l) => lines.push(l));
    await closeByHand(deps, targetV32(deploymentFor()));
    // the notice's one close, by its id with minValue 0 (R12b), its redeem request with it
    expect(w.sends.map((x) => [x.fn, x.args])).toEqual([["closeBatch", [7n, 0n]]]);
    expect(lines).toContain(
      "The open batch 7 holds 1 redeem request: while ForeverMoney's notice runs the vault defers it (RedeemDeferred: the old rail can't pay it), so the requester keeps the shares and asks again once the replacement rail runs; the batch's deposits go across",
    );
    // and the contract defers it, as the keeper says: no door burn while the vault's primary can't send payouts (since R6
    // D, e636241, a primary disabled on the vault reads closed before its view is asked)
    const src = (p: string) => readFileSync(new URL(`../../contracts/src/${p}`, import.meta.url), "utf8");
    expect(src("CascadeVault.sol")).toContain("if (!bridgeEnabled[p]) return false;");
    expect(src("CascadeVault.sol")).toContain('p.staticcall{gas: RAIL_VIEW_GAS}(abi.encodeWithSignature("canSendPayouts()"))');
    expect(src("libraries/CascadeBatchLib.sol")).toContain("uint256 allowance = input.payoutsOpen");
  });

  it("with no notice, pnpm ops close is the round's close as before", async () => {
    const w = world();
    w.door.start = BigInt(T - 2 * 86_400);
    const { deps } = depsFor(w, freshMemory(), deploymentFor());
    await closeByHand(deps, targetV32(deploymentFor()));
    expect(w.sends.map((x) => x.fn)).toEqual(["closeBatch"]);
  });
});

describe("R4-O's fix round (r4o-review.md): the park requests' bound, Base down at the first send, a send by its own pair, late receipts on any pair", () => {
  const src = (path: string) => readFileSync(new URL(`../../contracts/src/${path}`, import.meta.url), "utf8");
  const SENT_EVENT = parseAbi(["event Sent(bytes32 indexed messageId, uint64 destChain, address indexed sender, address indexed recipient, uint256 amount, uint256 fee, uint256 gasLimit)"]);
  const sentLog = (adapter: Address, messageId: Hex) => ({
    address: adapter,
    topics: encodeEventTopics({ abi: SENT_EVENT, args: { messageId, sender: ADDR.frontDoor, recipient: ADDR.vault } }) as Hex[],
    data: encodeAbiParameters(parseAbiParameters("uint64, uint256, uint256, uint256"), [964n, 10n ** 16n, 10n ** 15n, 900_000n]),
  });

  it("Minor 2: both park requests carry the keeper's bound (MAX_KEEPER_GAS), and the largest floor the keeper can send fits under it with an estimate that already counts it", () => {
    const ref = { key: `0x${"ab".repeat(32)}` as Hex, ...doorsN(1n, 1) };
    const t = targetV32(deploymentFor());
    expect(deliverParkedRequest(t, ref, 0, 1n).gasMax).toBe(MAX_KEEPER_GAS);
    expect(convertParkRequest(t, ref, 0, 1n).gasMax).toBe(MAX_KEEPER_GAS);
    // a batch holds at most 50 deposits and 50 redeems (CascadeMessages.MAX_ENTRIES twice): the real maximum is 100
    // entries; parkedDeliveryGas never answers more than GAS_CAP (CcipAdapterBase _gasModel caps it, the reserve inside
    // it), and the fallback below asks exactly that. Doubled (an estimate that includes the contract's own requirement,
    // R4-K), it is still under it
    const largest = INBOUND_GAS_CAP + PARK_GAS_MARGIN;
    expect(largest).toBe(7_100_000n);
    expect(2n * largest).toBeLessThan(MAX_KEEPER_GAS);
    expect(requirement(MODEL1, 100) + PARK_GAS_MARGIN).toBeLessThanOrEqual(largest);
  });

  it("Minor 2: a delivery whose estimate plus its floor is above the bound is refused, said, and never cut to the bound (a cut floor starves the vault)", async () => {
    const w = quiet();
    const sim = w.simulate;
    // the estimate itself is under the bound; with the floor above it, it isn't
    w.simulate = (c) => (c.fn === "deliverParked" ? MAX_KEEPER_GAS - requirement(MODEL1, 1) : sim(c));
    parkInWorld(w, doorsN(7n, 1), { amount: TAO / 100n, converted: true });
    const r = await rounds(w, 6);
    expect(w.sends.filter((s) => s.fn === "deliverParked")).toEqual([]);
    expect(r.lines.some((l) => /needs [\d,]+ gas and [\d,]+ above it \(its floor\), more than the 64,900,000 it may be sent with; nothing sent/.test(l))).toBe(true);
    expect(Object.keys(w.parks)).toHaveLength(1);
  });

  it("Minor 3: the adapter's parkedDeliveryGas unread: the delivery goes with the CCIP adapters' cap, the most the view can answer, said loudly; and the view is read again for the next", async () => {
    const w = quiet();
    let unread = true;
    w.callAt = (c) => (unread && c.chain === "bittensor" && c.fn === "parkedDeliveryGas" ? new Error("header not found") : undefined);
    const p = parkInWorld(w, doorsN(7n, 3), { amount: (TAO / 100n) * 3n, converted: true });
    const r = await rounds(w, 6);
    const d = w.sends.filter((s) => s.fn === "deliverParked");
    expect(d.map((x) => x.gas)).toEqual([ESTIMATE + 7_000_000n + PARK_GAS_MARGIN]);
    expect(w.parks).toEqual({});
    const loud = r.lines.filter((l) => l.startsWith("PARK GAS AT THE CAP: "));
    expect(loud).toEqual([
      `PARK GAS AT THE CAP: park ${p.key.slice(0, 10)}…'s gas requirement couldn't be read (header not found): it goes with the CCIP adapters' cap, 7,000,000 gas, the most the adapter's parkedDeliveryGas can answer (CcipAdapterBase GAS_CAP, the park reserve inside it), plus the 100,000 margin; unused gas is not charged`,
    ]);
    // the pin: the cap as the contracts have it
    expect(src("adapters/CcipAdapterBase.sol")).toMatch(/uint256 public constant GAS_CAP = 7_000_000;/);
    // the view answering again: the next park's floor is its own requirement
    unread = false;
    parkInWorld(w, doorsN(8n, 1), { amount: TAO / 100n, converted: true });
    await rounds(w, 6, { from: T + 600 });
    expect(w.sends.filter((s) => s.fn === "deliverParked").map((x) => x.gas)[1]).toBe(ESTIMATE + requirement(MODEL1, 1) + PARK_GAS_MARGIN);
  });

  it("Minor 4: a park on the second pair is matched to its own pair's send only: a deploy-pair Sent carrying its id is passed over", async () => {
    const w = quiet();
    const p = parkInWorld(w, doorsN(8n, 2), { amount: TAO / 50n, converted: true, pair: 2 });
    // a Sent of the deploy's Base adapter with the park's id, earlier: never this park's send
    w.logs.push({
      chain: "base",
      address: ADDR.baseAdapter,
      event: "Sent",
      args: { messageId: p.id, destChain: 964n, sender: ADDR.frontDoor, recipient: ADDR.vault, amount: TAO / 50n, fee: 10n ** 15n, gasLimit: 900_000n },
      block: 8_000n,
      tx: `0x${"de".repeat(32)}`,
    });
    const r = await rounds(w, 6, { dep: deploymentFor({ pairs: [PAIR2] }) });
    expect(w.sends.map((s) => [s.fn, lower(s.to)])).toEqual([["deliverParked", lower(ADDR.bitAdapter2)]]);
    expect(r.lines).toContainEqual(`Park ${p.key.slice(0, 10)}… delivered to the vault`);
  });

  it("Minor 5: a close's late receipt after a switch: its bridge message is found at the second pair's Base adapter and recorded", async () => {
    const w = world();
    w.door.start = BigInt(T - 2 * 86_400);
    w.fate = (c) => (c.fn === "closeBatch" ? "hold" : "mine");
    const journal = memoryJournal();
    const dep = deploymentFor({ pairs: [PAIR2] });
    const r1 = await rounds(w, 1, { dep, journal });
    const close = w.sends.find((s) => s.fn === "closeBatch")!;
    expect(close).toBeDefined();
    const id = `0x${"5b".repeat(32)}` as Hex;
    w.receipts[close.hash] = { status: "0x1", logs: [sentLog(ADDR.baseAdapter2, id)] };
    w.nonce.base.latest++;
    w.nonce.base.pending = w.nonce.base.latest;
    w.fate = () => "mine";
    w.door.canClose = false;
    const r2 = await rounds(w, 1, { dep, journal, memory: r1.memory, from: T + 60 });
    expect(r2.lines).toContain(`Late receipt: closing the batch went through (transaction ${close.hash}, bridge message ${id})`);
    expect(journal.rows.find((x) => x.hashes.includes(close.hash))?.messageId).toBe(id);
  });
});

describe("R4-O round 3: ForeverMoney's AlphaVault is read where the rail now primary on each chain converts", () => {
  const two = deploymentFor({ pairs: [PAIR2] });
  const NEW_AV = at("a2fa");
  /** The deploy's AlphaVault: its migration finished (its position moved on); the replacement pair's Bittensor adapter
   * names ForeverMoney's new vault, healthy. A payout batch is due and the open batch's close is due. */
  const migrated = () => {
    const w = world();
    w.alpha.migrationFinished = true;
    w.vaults[lower(NEW_AV)] = { paused: false, migrationReadyAt: 0n, migrationFinished: false, migrationDelay: 7n * 86_400n };
    w.adapterVault[lower(ADDR.bitAdapter2)] = NEW_AV;
    queue(w, KEY_A, [{ user: ALICE, shares: TAO, assets: TAO }]);
    w.door.start = BigInt(T - 2 * 86_400);
    return w;
  };
  const closesAndPays = (w: World) => w.sends.filter((x) => x.fn === "closeBatch" || x.fn === "processPayouts").map((x) => x.fn);

  for (const what of ["pays", "closes"] as const) {
    it(`a migration finished and the replacement made primary on both chains: the round ${what} again, reading the new vault`, async () => {
      const w = migrated();
      // one due action at a time (the fake vault doesn't consume a paid batch): the payout, or the close
      if (what === "closes") w.vault.batches = {};
      else w.door.canClose = false;
      const fn = what === "pays" ? "processPayouts" : "closeBatch";
      // the primaries still the deploy's pair: its vault's migration finished, so nothing goes
      const before = await rounds(w, 2, { dep: two });
      expect(closesAndPays(w)).toEqual([]);
      expect(before.lines).toContain("AlphaVault is paused or migrating — not paying out or closing batches");
      // the switch (runbook section 8): both primaries the replacement pair's
      w.primary = { base: ADDR.baseAdapter2, bittensor: ADDR.bitAdapter2 };
      w.calls.length = 0;
      const after = await rounds(w, 1, { dep: two, from: T + 600 });
      expect(closesAndPays(w), after.lines.join(" | ")).toEqual([fn]);
      // its health read at the new vault, not the old one
      const health = w.calls.filter((c) => c.fn === "migrationFinished").map((c) => lower(c.to));
      expect(health).toContain(lower(NEW_AV));
      expect(health).not.toContain(lower(ADDR.alphaVault));
    });
  }

  it("before the switch, the old vault's notice governs: the S-H1 waits stand, though the new vault is healthy", async () => {
    const w = migrated();
    w.alpha.migrationFinished = false;
    w.alpha.migrationReadyAt = BigInt(T + 5 * 86_400);
    w.door.start = BigInt(T - 25 * 3_600);
    w.door.deposits = [];
    w.door.totalDeposits = 0n;
    w.door.redeems = [{ user: ALICE, amount: TAO / 10n }];
    const r = await rounds(w, 2, { dep: two });
    expect(closesAndPays(w)).toEqual([]);
    expect(r.lines.filter((l) => l.startsWith("MIGRATION NOTICE: while it runs"))).toHaveLength(2);
    // and the queued batch, named once to cancel (merge 7b)
    expect(r.lines.filter((l) => l.startsWith("MIGRATION NOTICE: cancel this queued payout batch"))).toHaveLength(1);
  });

  it("the rails' notice (the conversion exception) reads the primary pair's vault too", async () => {
    const w = migrated();
    w.vaults[lower(NEW_AV)].migrationReadyAt = BigInt(T + 5 * 86_400);
    w.primary = { base: ADDR.baseAdapter2, bittensor: ADDR.bitAdapter2 };
    const { deps } = depsFor(w, freshMemory(), two);
    expect(await deps.migrationNotice()).toBe(BigInt(T + 5 * 86_400));
    w.primary = { base: ADDR.baseAdapter, bittensor: ADDR.bitAdapter };
    expect(await deps.migrationNotice()).toBe(0n);
  });
});

void RAO;
void ({} as JournalRow);
