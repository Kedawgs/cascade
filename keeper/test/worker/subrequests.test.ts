import { reset } from "cloudflare:test";
import { type Address, encodeEventTopics, getAddress, type Hex, padHex, toFunctionSelector } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADAPTER } from "../../../ops/src/keeper/core/abi.ts";
import { encodeDeployment } from "../../../ops/src/keeper/core/deployment.ts";
import { ADDR, deploymentFor, failInWorld, laneMessage, marketOf, parkInWorld, sendInWorld, T, TAO, type World } from "../../../ops/test/keeper-v32-world.ts";
import { DELIVERY_CHECKS_PER_ROUND } from "../../../ops/src/keeper/core/delivery.ts";
import { LOOKUP_WINDOWS_PER_RUN } from "../../src/config.ts";
import { RESERVE } from "../../src/rpc.ts";
import type { RunReport } from "../../src/run.ts";
import { chains, closeDue, keeperRun, ME, started, testEnv } from "./harness.ts";

// Task 52w's subrequest budget: the Worker's rounds with Task 52's work in them (the five park-event scans and the two
// Sent scans, the lookups by id, a migration notice with several parks, the FAILURE watch on both lanes), counted, and the
// split that keeps a round inside its run's budget (KEEPER_SUBREQUEST_BUDGET, 300; a send's own get RESERVE, 100, more) and
// far inside the platform's 1,000 subrequests: a lookup by id reads at most LOOKUP_WINDOWS_PER_RUN windows a run and reads
// on next run, and while the notice runs the park job is read before the deliveries, which a round with a conversion due
// doesn't read at all.

const quiet = { print: () => undefined };
let clock = Date.now();
const later = (ms = 120_000) => {
  clock += ms;
  const t = clock;
  return () => t;
};

beforeEach(async () => {
  await reset();
  clock = Date.now();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const ours = (message: Hex) => ({ recipient: ADDR.vault as Address, sender: ADDR.frontDoor as Address, message });
const SENT = encodeEventTopics({ abi: ADAPTER, eventName: "Sent" } as never)[0];
/** The eth_getLogs a lookup by id asked for message `id` (the Base adapter's Sent with the id as its first topic) */
const lookups = (w: World, id: Hex, from = 0) => w.logQueries.slice(from).filter((q) => q.topic0 === SENT && q.topics[0] === padHex(id.toLowerCase() as Hex, { size: 32 }));

/** `n` users credited on Base with a live delivery preference, from block `block` */
function candidates(w: World, n: number, block: bigint) {
  w.market = marketOf();
  for (let i = 0; i < n; i++) {
    const user = getAddress(`0x${(0xd0000 + i).toString(16).padStart(40, "0")}`);
    const pref = [300_000_000n, BigInt(T + 7 * 86_400), 6] as const;
    w.door.claimable[user.toLowerCase()] = 2n * TAO;
    w.door.prefs[user.toLowerCase()] = pref;
    w.logs.push({ chain: "base", address: ADDR.frontDoor, event: "DeliverySet", args: { user, minUsdcPerTao: pref[0], deadline: pref[1], destination: 6 }, block });
    w.logs.push({ chain: "base", address: ADDR.frontDoor, event: "PayoutReceived", args: { batchKey: `0x${"ab".repeat(32)}`, chunk: 0, user, amount: 2n * TAO }, block: block + 1n + BigInt(i) });
  }
}

/** A run's subrequests: its RPC requests (the monitor's included) and its calls to the object */
const subrequests = (r: RunReport) => (r.meter?.count ?? 0) + r.calls;

describe("the Worker's subrequests with Task 52's work", () => {
  it("measures the round that does the most: a notice with several parks, the park and Sent scans, a lookup by id, FAILUREs on both lanes, deliveries due; every round inside its budget, the conversions one a round", async () => {
    // a Base 30 days old (2 s blocks); the Worker's scans caught up by a first run (one window a scan)
    const c = chains((w) => {
      w.head.base = 1_300_000n;
      w.door.canClose = false;
    });
    await started();
    const warm = await keeperRun({ ...testEnv, BASE_LOG_WINDOW: "2000000", KEEPER_SUBREQUEST_BUDGET: "400" }, { ...quiet, now: later() });
    expect(warm.outcome, warm.lines.join(" | ")).toBe("ran");
    // then, in the new blocks: ForeverMoney's notice, the batch due its one close, six of Cascade's parks (four token parks,
    // two native, one of the token parks sent 25 days ago, outside the Sent index), a stranger's park, a close and a payout
    // in FAILURE, ten users owed a delivery
    const w = c.w;
    w.head.base += 1_000n;
    w.head.bittensor += 1_000n;
    const nb = w.head.base - 500n;
    const bb = w.head.bittensor - 500n;
    w.alpha.migrationReadyAt = BigInt(T + 6 * 86_400);
    closeDue(w);
    w.door.canClose = true;
    const parks = [
      parkInWorld(w, ours("0x01"), { sendBlock: 200_000n, block: bb }),
      ...(["0x02", "0x03", "0x04"] as const).map((m, i) => parkInWorld(w, ours(m), { sendBlock: nb + BigInt(i), block: bb + 1n + BigInt(i) })),
    ];
    for (const [i, m] of (["0x05", "0x06"] as const).entries()) parkInWorld(w, ours(m), { converted: true, sendBlock: nb + 10n + BigInt(i), block: bb + 10n + BigInt(i) });
    parkInWorld(w, { recipient: ADDR.vault, sender: getAddress(`0x${"5e".repeat(20)}`), message: "0x07" }, { sendBlock: nb + 20n, block: bb + 20n });
    const close = laneMessage("Base → Bittensor", ours("0x0a"), { amount: TAO, number: 900n });
    sendInWorld(w, "Base → Bittensor", close, ours("0x0a"), { block: nb + 30n });
    failInWorld(w, "Base → Bittensor", close, { block: bb + 30n });
    const payout = laneMessage("Bittensor → Base", { recipient: ADDR.frontDoor, sender: ADDR.vault, message: "0x0b" }, { number: 901n });
    sendInWorld(w, "Bittensor → Base", payout, { recipient: ADDR.frontDoor, sender: ADDR.vault }, { block: bb + 31n });
    failInWorld(w, "Bittensor → Base", payout, { block: nb + 31n });
    candidates(w, 10, nb + 40n);
    w.fate = (x) => {
      if (x.fn === "closeBatch") {
        // the batch closed; the next one opens empty, during the notice
        w.door.id += 1n;
        w.door.start = BigInt(w.time.base);
        w.door.deposits = [];
        w.door.totalDeposits = 0n;
      }
      return "mine";
    };

    // the production settings: Base's 10,000-block window, a budget of 300
    const runs: { r: RunReport; sends: string[] }[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await keeperRun(testEnv, { ...quiet, now: later() });
      runs.push({ r, sends: w.sends.splice(0).map((s) => (s.fn === "deliverParked" ? `deliverParked ${String(s.args[2])}` : s.fn)) });
    }
    const worst = runs.reduce((a, b) => (subrequests(b.r) > subrequests(a.r) ? b : a));
    console.warn(`measured (local workerd, fake RPC), the round that does the most (Task 52w):
${runs.map((x, i) => `  round ${i + 1}: ${x.r.meter?.count ?? 0} RPC requests, ${x.r.calls} coordinator calls (${subrequests(x.r)} subrequests), sends ${x.sends.join(", ") || "none"}, by method ${JSON.stringify(x.r.meter?.byMethod)}`).join("\n")}
  worst: ${subrequests(worst.r)} subrequests (${worst.r.meter?.count ?? 0} RPC, ${worst.r.calls} object calls) of the platform's 1,000; the run's budget 300 + ${RESERVE} for a send`);
    for (const x of runs) {
      expect(x.r.outcome, x.r.lines.join(" | ")).toBe("ran");
      expect(x.r.meter?.count ?? 0).toBeLessThanOrEqual(300 + RESERVE);
      expect(subrequests(x.r)).toBeLessThan(1_000);
      // a loose pin on what was measured (Task 52w fix M1): the busiest warm round is about 140
      expect(subrequests(x.r)).toBeLessThan(200);
    }
    // the conversions first, one a round: the token parks whose sends are in the index, and the old one once its lookup by
    // id, a share a run (the 7 days before it parked, then from the deployment's start: the re-review's N5), finds its send
    expect(runs.slice(0, 4).map((x) => x.sends)).toEqual([["deliverParked 0x02"], ["deliverParked 0x01"], ["deliverParked 0x03"], ["deliverParked 0x04"]]);
    expect(lookups(w, parks[0].id).length).toBeGreaterThan(LOOKUP_WINDOWS_PER_RUN);
    for (const x of runs) expect(x.r.lines.filter((l) => l.startsWith("Could not read the parks"))).toEqual([]);
  });

  it("a lookup by id reads at most LOOKUP_WINDOWS_PER_RUN windows a run and reads on next run; the conversions behind it go meanwhile", async () => {
    const c = chains((w) => {
      w.head.base = 1_300_000n;
      w.door.canClose = false;
    });
    await started();
    await keeperRun({ ...testEnv, BASE_LOG_WINDOW: "2000000", KEEPER_SUBREQUEST_BUDGET: "400" }, { ...quiet, now: later() });
    const w = c.w;
    w.head.base += 1_000n;
    w.head.bittensor += 1_000n;
    w.alpha.migrationReadyAt = BigInt(T + 6 * 86_400);
    // the older park (first in the job's order) was sent 25 days ago: looked up by its id over its 7 days, in 2,000-block
    // windows (153 of them)
    const old = parkInWorld(w, ours("0x01"), { sendBlock: 200_000n, block: w.head.bittensor - 400n });
    const fresh = parkInWorld(w, ours("0x02"), { sendBlock: w.head.base - 100n, block: w.head.bittensor - 300n });
    const env = { ...testEnv, BASE_LOG_WINDOW: "2000", KEEPER_SUBREQUEST_BUDGET: "200" };
    const before = w.logQueries.length;
    const one = await keeperRun(env, { ...quiet, now: later() });
    const first = lookups(w, old.id, before);
    expect(first.length).toBe(LOOKUP_WINDOWS_PER_RUN);
    expect(one.lines).toContainEqual(expect.stringMatching(/^PARK SEND LOOKUP: park 0x[0-9a-f]{8}… \(bridge message 0x[0-9a-f]{8}…\): its send is looked up by its id in Base's blocks \d+ to \d+, read to \d+ so far \(this run's share of lookups by id is read\); it goes on next round$/));
    // the conversion behind it goes in the same run
    expect(w.sends.map((s) => [s.fn, s.args[2]]), one.lines.join(" | ")).toEqual([["deliverParked", "0x02"]]);
    expect(w.parks[fresh.key.toLowerCase()]).toBeUndefined();
    // the next runs read on from where it stopped, a share each, until the 7 days are read
    const mid = w.logQueries.length;
    await keeperRun(env, { ...quiet, now: later() });
    const next = lookups(w, old.id, mid);
    expect(next.length).toBe(LOOKUP_WINDOWS_PER_RUN);
    expect(next[0].from).toBe((first.at(-1)?.to ?? 0n) + 1n);
  });

  it("outside a notice, 110 users owed a delivery: each round reads at most DELIVERY_CHECKS_PER_ROUND of them, in turn, the oldest first; every round runs inside its budget, and each user is read within 6 rounds (Task 52w fix)", async () => {
    const c = chains((w) => {
      w.door.canClose = false;
    });
    await started();
    // a first run reads the chains in (its scans, the for-life list); then the credits land
    await keeperRun(testEnv, { ...quiet, now: later() });
    c.w.head.base += 1_000n;
    candidates(c.w, 110, c.w.head.base - 800n);
    const sel = toFunctionSelector("deliveryOf(address)").slice(2);
    const users = Array.from({ length: 110 }, (_, i) => getAddress(`0x${(0xd0000 + i).toString(16).padStart(40, "0")}`));
    const rounds = Math.ceil(users.length / DELIVERY_CHECKS_PER_ROUND);
    const read = new Set<string>();
    const counts: string[] = [];
    for (let i = 0; i < rounds; i++) {
      const f0 = c.fetched.length;
      const r = await keeperRun(testEnv, { ...quiet, now: later() });
      counts.push(`${r.meter?.count ?? 0} RPC + ${r.calls} object calls`);
      expect(r.outcome, r.lines.join(" | ")).toBe("ran");
      expect(r.lines.filter((l) => l.startsWith("Failed this round") || l.startsWith("DELIVERIES READ IN PART")), `round ${i + 1}`).toEqual([]);
      expect(r.meter?.count ?? 0, `round ${i + 1}`).toBeLessThanOrEqual(300);
      // each user whose preference this run asked, directly or inside Multicall3's batch
      const data = c.fetched.slice(f0).filter((f) => f.method === "eth_call").map((f) => String((f.params[0] as { data?: string }).data ?? "").toLowerCase());
      for (const u of users) if (data.some((x) => x.includes(sel + padHex(u.toLowerCase() as Hex, { size: 32 }).slice(2)))) read.add(u);
    }
    console.warn(`measured (local workerd, fake RPC), 110 owed a delivery, the cap ${DELIVERY_CHECKS_PER_ROUND}: ${counts.join("; ")}`);
    expect(read.size).toBe(users.length);
    // one delivered a run
    expect(c.w.sends.filter((s) => s.fn === "deliver")).toHaveLength(rounds);
  });

  it("while the notice runs, the park job is read before the deliveries: with 60 users owed a delivery (a few thousand reads on a first run) and a budget of 200, the conversion still goes, and that round reads no delivery", async () => {
    const c = chains((w) => {
      w.door.canClose = false;
      w.alpha.migrationReadyAt = BigInt(T + 6 * 86_400);
      parkInWorld(w, ours("0x01"));
      candidates(w, 60, 9_800n);
    });
    await started();
    const r = await keeperRun({ ...testEnv, KEEPER_SUBREQUEST_BUDGET: "200" }, { ...quiet, now: later() });
    expect(c.w.sends.map((s) => s.fn), r.lines.join(" | ")).toEqual(["deliverParked"]);
    // no user's delivery preference read this round (directly or through Multicall3): the conversion went first
    const deliveryOf = toFunctionSelector("deliveryOf(address)").slice(2);
    expect(c.fetched.filter((f) => f.method === "eth_call" && String((f.params[0] as { data?: string }).data ?? "").includes(deliveryOf))).toEqual([]);
    expect(r.meter?.count ?? 0).toBeLessThanOrEqual(200 + RESERVE);
  });
});
