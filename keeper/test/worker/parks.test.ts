import { reset } from "cloudflare:test";
import { type Address, encodeEventTopics, type Hex, keccak256, padHex, stringToHex, toFunctionSelector } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADAPTER, OFFRAMP_EXECUTE } from "../../../ops/src/keeper/core/abi.ts";
import { type DeploymentV32, encodeDeployment } from "../../../ops/src/keeper/core/deployment.ts";
import { type JournalRow, spentOn } from "../../../ops/src/keeper/core/journal.ts";
import { fromJson } from "../../../ops/src/keeper/core/memory.ts";
import { ADDR, deploymentFor, failInWorld, laneMessage, parkInWorld, sendInWorld, T, TAO, type World } from "../../../ops/test/keeper-v32-world.ts";
import type { KeeperEnv } from "../../src/config.ts";
import { chains, closeDue, coordinator, keeperRun, ME, savedMemory, sleep, started, testEnv } from "./harness.ts";

// Task 52 through the Worker (the wiring task, 52w): the park job, the CCIP FAILURE watch and the lane wait run from a
// cron round on the real core (no seam: Task 50b's concern 2), with the deployment's lane ends, its park refund cap and the
// Worker's own OPS_REEXEC_AUTO var, off unless it says on; the Sent index and the parks' pins live in the object's memory
// across runs; and during ForeverMoney's migration notice a token park's conversion passes Bittensor's spend cap (counted),
// never the kill switch or the lease.

const quiet = { print: () => undefined };
const rows = async () => fromJson<JournalRow[]>(await coordinator().since({ sinceMs: 0 }));
const status = async () => fromJson<{ runs: { line: string }[] }>(await coordinator().status({ runs: 200 }));

/** Each run's clock, two minutes after the last (a round is due a minute after the one before) */
let clock = Date.now();
const later = (ms = 120_000) => {
  clock += ms;
  const t = clock;
  return () => t;
};

/** The Worker on deployment `d` (the tests' keeper), its other settings the test environment's */
const on = (d: Partial<DeploymentV32>, more: Partial<KeeperEnv> = {}): KeeperEnv => ({ ...testEnv, DEPLOYMENT: encodeDeployment(deploymentFor({ keeper: ME, ...d })), ...more });

const ours = (message: Hex) => ({ recipient: ADDR.vault as Address, sender: ADDR.frontDoor as Address, message });
/** ForeverMoney's notice in the world: migrationReadyAt six days ahead (it began a day ago) */
const notice = (w: World) => {
  w.alpha.migrationReadyAt = BigInt(T + 6 * 86_400);
};

beforeEach(async () => {
  await reset();
  clock = Date.now();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the CCIP FAILURE watch from a Worker round", () => {
  /** One of Cascade's closes in FAILURE on Bittensor's OffRamp, written by Chainlink's honest attempt: a re-execution
   * would pass its checks and its simulation */
  const failing = (w: World) => {
    w.door.canClose = false;
    const msg = laneMessage("Base → Bittensor", ours("0x0a0b"), { amount: TAO, number: 77n });
    sendInWorld(w, "Base → Bittensor", msg, ours("0x0a0b"), { block: 9_000n });
    failInWorld(w, "Base → Bittensor", msg);
    return msg;
  };
  /** And one of Cascade's payouts in FAILURE on Base's OffRamp (the other lane) */
  const failingPayout = (w: World) => {
    const payload = { recipient: ADDR.frontDoor as Address, sender: ADDR.vault as Address, message: "0x0c0d" as Hex };
    const msg = laneMessage("Bittensor → Base", payload, { amount: TAO, number: 78n });
    sendInWorld(w, "Bittensor → Base", msg, payload, { block: 9_001n });
    failInWorld(w, "Bittensor → Base", msg);
    return msg;
  };
  const EXECUTE = toFunctionSelector(OFFRAMP_EXECUTE[0] as never);

  it("OPS_REEXEC_AUTO off (wrangler.jsonc's): a due FAILURE is reported with the hand command, kept in the runs table, and never re-executed nor simulated, whatever DEPLOYMENT says", async () => {
    let msg: ReturnType<typeof failing> | undefined;
    let payout: ReturnType<typeof failingPayout> | undefined;
    const c = chains((w) => {
      msg = failing(w);
      payout = failingPayout(w);
    });
    await started();
    // the deployment asks for it: the Worker's own var decides, and it is off
    expect(testEnv.OPS_REEXEC_AUTO).toBe("off");
    const env = on({ reexecAuto: true });
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) lines.push(...(await keeperRun(env, { ...quiet, now: later() })).lines);
    expect(c.w.sends.filter((s) => s.fn === "execute")).toEqual([]);
    // nothing asked of the OffRamp's execute at all: no simulation, no estimate
    const asked = c.fetched.filter((f) => (f.method === "eth_call" || f.method === "eth_estimateGas") && String((f.params[0] as { data?: string }).data ?? "").startsWith(EXECUTE));
    expect(asked).toEqual([]);
    const id = (msg?.id ?? "0x").toLowerCase();
    const report = lines.find((l) => l.startsWith(`CCIP FAILURE: bridge message ${id} (Base → Bittensor)`));
    expect(report, lines.join(" | ")).toContain("The keeper doesn't re-execute it by itself.");
    expect(report).toContain(`pnpm ops reexec ${id}`);
    // the other lane alike (Task 52w fix M6)
    const other = lines.find((l) => l.startsWith(`CCIP FAILURE: bridge message ${(payout?.id ?? "0x").toLowerCase()} (Bittensor → Base)`));
    expect(other, lines.join(" | ")).toContain("The keeper doesn't re-execute it by itself.");
    // loud: in the object's runs table, which pnpm ops keeper status shows
    expect((await status()).runs.some((r) => r.line.startsWith("CCIP FAILURE: bridge message"))).toBe(true);
  });

  it("the positive control: OPS_REEXEC_AUTO on, the same FAILURE is re-executed from the round, delivered", async () => {
    let msg: ReturnType<typeof failing> | undefined;
    const c = chains((w) => {
      msg = failing(w);
    });
    await started();
    await keeperRun(on({}, { OPS_REEXEC_AUTO: "on" }), { ...quiet, now: later() });
    expect(c.w.sends.map((s) => s.fn)).toEqual(["execute"]);
    expect(c.w.messageStates[(msg?.id ?? "0x").toLowerCase()]).toBe(2);
  });

  it("a Worker var that is neither on nor off: the Worker runs nothing and says why", async () => {
    const c = chains((w) => closeDue(w));
    await started();
    const r = await keeperRun(on({}, { OPS_REEXEC_AUTO: "maybe" }), quiet);
    expect(r.outcome).toBe("not-configured");
    expect(r.lines).toEqual(['NOT RUNNING: OPS_REEXEC_AUTO "maybe" is not on or off']);
    expect(c.w.sends).toEqual([]);
  });
});

describe("the park job from a Worker round", () => {
  it("during ForeverMoney's notice: the token park's conversion goes first, then the notice's one close, then nothing more is closed", async () => {
    let park: ReturnType<typeof parkInWorld> | undefined;
    const c = chains((w) => {
      closeDue(w);
      notice(w);
      park = parkInWorld(w, ours("0x0c0d"));
      w.fate = (x) => {
        if (x.fn === "closeBatch") {
          // the close takes its batch; the next one opens now, during the notice
          w.door.id += 1n;
          w.door.start = BigInt(w.time.base);
        }
        return "mine";
      };
    });
    await started();
    const one = await keeperRun(testEnv, { ...quiet, now: later() });
    expect(c.w.sends.map((s) => s.fn), one.lines.join(" | ")).toEqual(["deliverParked"]);
    expect(c.w.sends[0].args).toEqual([ADDR.vault, ADDR.frontDoor, "0x0c0d"]);
    expect(c.w.parks[(park?.key ?? "0x").toLowerCase()]).toBeUndefined();
    expect(one.lines).toContainEqual(expect.stringMatching(/^Park 0x[0-9a-f]{8}… converted and delivered to the vault$/));
    const two = await keeperRun(testEnv, { ...quiet, now: later() });
    expect(c.w.sends.map((s) => [s.fn, s.args[0]]), two.lines.join(" | ")).toEqual([
      ["deliverParked", ADDR.vault],
      ["closeBatch", 7n],
    ]);
    expect([...one.lines, ...two.lines]).toContainEqual(expect.stringMatching(/^MIGRATION NOTICE FLUSH: ForeverMoney's migration is announced .*the open batch 7 is closed once, at once/));
    // the batch open since then opened during the notice: nothing more is closed
    for (let i = 0; i < 3; i++) await keeperRun(testEnv, { ...quiet, now: later() });
    expect(c.w.sends.map((s) => s.fn)).toEqual(["deliverParked", "closeBatch"]);
    expect((await rows()).map((r) => [r.request.functionName, r.status])).toEqual([
      ["deliverParked", "landed"],
      ["closeBatch", "landed"],
    ]);
  });

  it("the workerd conversion test: at Bittensor's spend cap during the notice, a token park's conversion goes, counted; never through the kill switch, a hand run's lease, or a stop that lands mid-round", async () => {
    const parks: Hex[] = [];
    const c = chains((w) => {
      w.door.canClose = false;
      notice(w);
      for (const m of ["0x01", "0x02", "0x03"] as const) parks.push(parkInWorld(w, ours(m)).key);
    });
    await started();
    // a Bittensor cap of 1 wei: the first conversion alone goes past it
    const env = on({ spendCap: { base: 10n ** 18n, bittensor: 1n } });
    const converted = () => c.w.sends.filter((s) => s.fn === "deliverParked").length;
    await keeperRun(env, { ...quiet, now: later() });
    expect(converted()).toBe(1);
    // now at the cap (said), the next conversion goes all the same
    const two = await keeperRun(env, { ...quiet, now: later() });
    expect(two.lines).toContainEqual(expect.stringMatching(/^SPEND CAP: Bittensor: the keeper has sent /));
    expect(converted()).toBe(2);
    const counted = await rows();
    expect(counted.map((r) => [r.request.functionName, r.request.rail, r.status])).toEqual([
      ["deliverParked", "migration-conversion", "landed"],
      ["deliverParked", "migration-conversion", "landed"],
    ]);
    expect(spentOn(counted, "bittensor", Date.now())).toBeGreaterThan(1n);
    // the kill switch: the cron doesn't run at all
    await coordinator().stop({ reason: "the test's stop", by: "the tests" });
    expect((await keeperRun(env, { ...quiet, now: later() })).outcome).toBe("stopped");
    expect(converted()).toBe(2);
    // a hand run's lease: the cron doesn't take it
    await coordinator().start({ by: "the tests" });
    const hand = await coordinator().acquire({ holder: "hand:test", kind: "hand", ttlMs: 60_000 });
    expect(hand.granted).toBe(true);
    expect((await keeperRun(env, { ...quiet, now: later() })).outcome).toBe("held");
    expect(converted()).toBe(2);
    await coordinator().release({ holder: "hand:test", token: (hand as { token: number }).token });
    // a stop that lands after the round began, just before the send: the send's renew is refused, nothing is signed
    const mid = await keeperRun(env, {
      ...quiet,
      now: later(),
      wrapDeps: (deps) => {
        const send = deps.sendCall;
        deps.sendCall = async (req) => {
          await coordinator().stop({ reason: "a stop mid-round", by: "the tests" });
          return send(req);
        };
      },
    });
    expect(converted(), mid.lines.join(" | ")).toBe(2);
    expect(mid.lines.join(" | ")).toContain("not sent: the keeper is stopped (a stop mid-round)");
    expect((await rows()).length).toBe(2);
    // started again, past the failed round's back-off: the last park converts
    await coordinator().start({ by: "the tests" });
    await keeperRun(env, { ...quiet, now: later(30 * 60_000) });
    expect(converted()).toBe(3);
    for (const k of parks) expect(c.w.parks[k.toLowerCase()]).toBeUndefined();
  });

  it("a park's refund cut off after its broadcast: the next run watches it from the journal and records its bridge message once it lands", async () => {
    let park: ReturnType<typeof parkInWorld> | undefined;
    const c = chains((w) => {
      w.door.canClose = false;
      // a park held as TAO for 15 days, whose delivery the vault keeps refusing: refunded to its door
      park = parkInWorld(w, ours("0x0909"), { converted: true, parkedAt: BigInt(T - 15 * 86_400) });
      w.parkSim = () => "ReentrancyGuardReentrantCall";
      w.fate = () => "hold";
    });
    await started();
    let cut = true;
    c.hold.when = (f) => cut && f.method === "eth_getTransactionReceipt";
    void keeperRun(testEnv, { ...quiet, leaseMs: 1_000 });
    for (let i = 0; i < 200 && (await rows())[0]?.status !== "sent"; i++) await sleep(10);
    expect(c.w.sends.map((s) => s.fn)).toEqual(["refundParked"]);
    cut = false;
    await sleep(1_100);
    // it lands: its receipt carries the adapter's Sent, toward Base
    c.mine(c.w.sends[0].hash);
    const next = await keeperRun(testEnv, { ...quiet, now: later() });
    expect(next.lines.some((l) => l.startsWith("Settling: refund park") && l.includes("it is watched from now")), next.lines.join(" | ")).toBe(true);
    const [row] = await rows();
    const id = keccak256(stringToHex(`refund:${(park?.key ?? "0x").toLowerCase()}`));
    expect([row.request.functionName, row.status, row.messageId]).toEqual(["refundParked", "landed", id]);
    expect(c.w.sends).toHaveLength(1);
  });

  it("the Sent index and the parks' pins are saved in the object: a run that starts after the send left the 15 days still rebuilds the park from them, with no lookup by id", async () => {
    let park: ReturnType<typeof parkInWorld> | undefined;
    const c = chains((w) => {
      w.door.canClose = false;
      park = parkInWorld(w, ours("0x0e0f"), { converted: true });
      // the Base OnRamp's logs can't be read this run: the park is seen and pinned, but not rebuilt
      w.logsFail = (_n, _chain, q) => (q.address.toLowerCase() === ADDR.onRampBase.toLowerCase() ? new Error("the OnRamp's logs server is down") : undefined);
    });
    await started();
    // one window per Base scan: the head moves 700,000 blocks below
    const env = on({}, { BASE_LOG_WINDOW: "2000000" });
    await keeperRun(env, { ...quiet, now: later() });
    const saved = fromJson<{ reads: { v32: { sentPinnedParks?: string[]; sent?: { base?: { kept: { id: string }[] } } } } }>(await savedMemory());
    const id = (park?.id ?? "0x").toLowerCase();
    expect(saved.reads.v32.sentPinnedParks).toEqual([id]);
    expect(saved.reads.v32.sent?.base?.kept.map((x) => x.id)).toEqual([id]);
    expect(c.w.sends).toEqual([]);
    // 700,000 Base blocks on (16 days: past SENT_RETAIN_BLOCKS), the OnRamp readable again, a new run
    c.w.logsFail = undefined;
    c.w.head.base += 700_000n;
    const queries = c.w.logQueries.length;
    const r = await keeperRun(env, { ...quiet, now: later() });
    // no Sent looked up by its id: the index kept it, pinned
    const sentTopic = encodeEventTopics({ abi: ADAPTER, eventName: "Sent" } as never)[0];
    const byId = c.w.logQueries.slice(queries).filter((q) => q.topic0 === sentTopic && q.topics[0] === padHex(id as Hex, { size: 32 }));
    expect(byId).toEqual([]);
    expect(r.lines.filter((l) => l.startsWith("PARK NOT REBUILT") || l.startsWith("PARK SEND LOOKUP"))).toEqual([]);
    // rebuilt, so its delivery is simulated and sent
    expect(c.w.sends.map((s) => [s.fn, s.args[2]]), r.lines.join(" | ")).toEqual([["deliverParked", "0x0e0f"]]);
  });
});
