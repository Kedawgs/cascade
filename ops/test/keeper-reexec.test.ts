import { readFileSync } from "node:fs";
import { type AbiEvent, type Address, encodeFunctionData, getAddress, type Hex, keccak256, padHex, parseEther, toEventSelector, toFunctionSignature, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { OFFRAMP_CCVS, OFFRAMP_EVENTS, OFFRAMP_EXECUTE } from "../src/keeper/core/abi.ts";
import { encodeBatch } from "../src/keeper/core/batch.ts";
import { decideNext, type State } from "../src/keeper/core/due.ts";
import { SendRefused } from "../src/keeper/core/errors.ts";
import { classifyFailure, HeldRefusal, NotNow } from "../src/keeper/core/failures.ts";
import { memoryJournal } from "../src/keeper/core/journal.ts";
import { encodeMemory, freshMemory, type KeeperMemory, loadMemory } from "../src/keeper/core/memory.ts";
import { runRound, SKIP_MAX_MS, SKIP_MS } from "../src/keeper/core/round.ts";
import { stakeRequest } from "../src/keeper/core/v32/requests.ts";
import type { V32Env } from "../src/keeper/core/v32/reads.ts";
import { targetV32 } from "../src/keeper/core/v32/actions.ts";
import {
  FAILURE_REPORT_MS,
  handCommand,
  LANE_WAIT_MS,
  neverReachedReceiver,
  OUTSIDE_WAIT_MS,
  REEXEC_GAS_CEILING,
  reexecActionV32,
  reexecGasLimit,
  reexecV32,
} from "../src/keeper/core/v32/reexec.ts";
import { USAGE } from "../src/args.ts";
import { emptyProofByHand, parseProofFile, parseReexecArgs, REEXEC_USAGE, reexecByHand, reexecHandInput } from "../src/keeper/core/v32/reexec-hand.ts";
import {
  ADDR,
  attemptInWorld,
  bridgeCallMined,
  COMMITTEE,
  committeeResult,
  deploymentFor,
  depsFor,
  failInWorld,
  KEY,
  laneMessage,
  offRampError,
  sendInWorld,
  T,
  TAO,
  type World,
  world,
} from "./keeper-v32-world.ts";

// Task 52's CCIP FAILURE watch and re-execution, as the founder ruled it in fix round 1 ("we need to play very safe ...
// fail safe"; design-keeper-worker.md §8; R3 CC-L2, CC-L4, F5, c1). Every execution needs the committee's results (the
// deployed OffRamp 2.0.0 checks the CCV quorum and verifyMessage on every execute): a re-execution takes them from the
// calldata of the attempt that wrote the FAILURE (or --from-tx), checks they cover getCCVsForMessage, and simulates first.
// At launch the keeper re-executes nothing by itself (reexecAuto off): it reports each FAILURE of Cascade's, with its lane,
// its age and the hand command (pnpm ops reexec), and a lane with a FAILURE open half an hour takes nothing new. The hand
// re-run checks everything before it signs, and sends only with --live, through the one send path. With OPS_REEXEC_AUTO=on
// (only after the rehearsals) the keeper re-executes on a back-off, with the same checks. On fake chains.

const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);
const lower = (a: string) => a.toLowerCase();
const d = deploymentFor();
const AUTO = deploymentFor({ reexecAuto: true });
const OPTS = { intervalMs: 60_000, policy: { claimCostTao: 57n * 10n ** 15n, claimMultiple: 25n, monthlyClaimMaxUsd: 20 }, rewardsEveryTicks: 1000 };
const STRANGER = at("5e7");
const FAILURE = 3;
const NOTICE = BigInt(T + 7 * 86_400);

/** `n` rounds on `w`, the memory through JSON between them, a minute apart from `from` (s), the chains' clocks (and so the
 * monitor's readings) moving with them. */
async function rounds(w: World, n: number, o: { from?: number; memory?: KeeperMemory; between?: (i: number) => void; dep?: typeof d } = {}) {
  const lines: string[] = [];
  const journal = memoryJournal();
  const dep = o.dep ?? d;
  let saved = encodeMemory(o.memory ?? freshMemory());
  let memory = freshMemory();
  for (let i = 0; i < n; i++) {
    o.between?.(i);
    memory = loadMemory(saved).memory;
    const now = ((o.from ?? T) + i * 60) * 1000;
    w.time.base = now / 1000;
    w.time.bittensor = now / 1000;
    const { deps } = depsFor(w, memory, dep, (l) => lines.push(l), { journal });
    const r = await runRound(deps, targetV32(dep), memory, { ...OPTS, now: () => now });
    expect(r.end, `round ${i + 1}: ${lines.at(-1)}`).toBeUndefined();
    saved = encodeMemory(r.memory);
  }
  return { lines, memory: loadMemory(saved).memory, journal };
}

type Msg = ReturnType<typeof laneMessage>;

/** Cascade's batch `n` from the door to the vault, sent on Base, in FAILURE on Bittensor's OffRamp (written by an honest
 * attempt unless `fail` says otherwise; `fail: false` sends it only) */
function failedBatch(
  w: World,
  n: bigint,
  o: { gas?: number; payload?: { recipient: Address; sender: Address }; over?: Partial<Msg["message"]>; encodedLogged?: Hex; sentAmount?: bigint; fail?: Parameters<typeof failInWorld>[3] | false } = {},
): Msg & { tx: Hex } {
  const payload = { recipient: ADDR.vault, sender: ADDR.frontDoor, message: encodeBatch(n, [{ user: at("de01"), amount: TAO }], []) };
  const msg = laneMessage("Base → Bittensor", payload, { amount: TAO, number: n, gas: o.gas ?? 900_000, over: o.over });
  sendInWorld(w, "Base → Bittensor", msg, o.payload ?? payload, { block: 9_000n + n, encodedLogged: o.encodedLogged, amount: o.sentAmount });
  const tx = o.fail === false ? (`0x${"00".repeat(32)}` as Hex) : failInWorld(w, "Base → Bittensor", msg, o.fail ?? {});
  return { ...msg, tx };
}

/** Cascade's payout chunk `n` from the vault to the door, sent on Bittensor, in FAILURE on Base's OffRamp */
function failedPayout(w: World, n: bigint): Msg & { tx: Hex } {
  const payload = { recipient: ADDR.frontDoor, sender: ADDR.vault, message: padHex(`0x${n.toString(16)}`, { size: 64 }) };
  const msg = laneMessage("Bittensor → Base", payload, { amount: 2n * TAO, number: n, gas: 300_000 });
  sendInWorld(w, "Bittensor → Base", msg, payload, { block: 9_000n + n });
  return { ...msg, tx: failInWorld(w, "Bittensor → Base", msg) };
}

const executes = (w: World) => w.sends.filter((s) => s.fn === "execute").map((s) => ({ to: lower(s.to), chain: s.chain, args: s.args }));
/** The explicit simulations asked (eth_call of the OffRamp's execute) */
const simulations = (w: World) => w.calls.filter((c) => c.fn === "execute");

/** pnpm ops reexec on `w` (the hand re-run): its exit code and what it said */
async function hand(
  w: World,
  o: { id: Hex; fromTx?: Hex; proof?: ReturnType<typeof parseProofFile>; gas?: number; send?: boolean; live?: boolean; dep?: typeof d; journal?: ReturnType<typeof memoryJournal>; executionInputs?: V32Env["executionInputs"] },
) {
  const lines: string[] = [];
  const dep = o.dep ?? d;
  const { deps, memory, journal } = depsFor(w, freshMemory(), dep, (l) => lines.push(l), { ...(o.journal ? { journal: o.journal } : {}), ...(o.executionInputs ? { executionInputs: o.executionInputs } : {}) });
  const code = await reexecByHand(deps, targetV32(dep), memory, {
    id: o.id,
    send: o.send ?? false,
    now: w.time.base * 1000,
    ...(o.fromTx ? { fromTx: o.fromTx } : {}),
    ...(o.proof ? { proof: o.proof } : {}),
    ...(o.gas !== undefined ? { gas: o.gas } : {}),
    ...(o.live !== undefined ? { live: o.live } : {}),
  });
  return { code, lines, journal };
}

describe("the OffRamp's calls are the deployed OffRamp 2.0.0's (R3 W2-2)", () => {
  const harness = JSON.parse(readFileSync(new URL("../../contracts/out/ForkBase.sol/IOffRamp20.json", import.meta.url), "utf8")) as { abi: { type: string; name: string; outputs?: { type: string }[] }[] };
  it("execute(bytes,address[],bytes[],uint32), as the fork harness's IOffRamp20 declares it", () => {
    const execute = harness.abi.find((x) => x.type === "function" && x.name === "execute");
    expect(toFunctionSignature(execute as never)).toBe("execute(bytes,address[],bytes[],uint32)");
    expect(toFunctionSignature(OFFRAMP_EXECUTE[0])).toBe("execute(bytes,address[],bytes[],uint32)");
  });

  it("getCCVsForMessage(bytes) returns (address[], address[], uint8), as IOffRamp20 declares it", () => {
    const ccvs = harness.abi.find((x) => x.type === "function" && x.name === "getCCVsForMessage");
    expect(toFunctionSignature(ccvs as never)).toBe(toFunctionSignature(OFFRAMP_CCVS[0]));
    expect(ccvs?.outputs?.map((x) => x.type)).toEqual(OFFRAMP_CCVS[0].outputs.map((x) => x.type));
  });

  it("ExecutionStateChanged is the signature the fork harness reads the deployed OffRamp's logs with; its first three are indexed", () => {
    const fork = readFileSync(new URL("../../contracts/test/fork/ForkBase.sol", import.meta.url), "utf8");
    const literal = /EXECUTION_STATE_CHANGED = keccak256\(\s*"([^"]+)"\s*\)/.exec(fork)?.[1];
    expect(literal).toBe("ExecutionStateChanged(uint64,uint64,bytes32,uint8,bytes)");
    const ev = OFFRAMP_EVENTS[0] as AbiEvent;
    expect(toEventSelector(ev)).toBe(keccak256(toHex(literal as string)));
    expect(ev.inputs.map((i) => [i.name, i.indexed === true])).toEqual([
      ["sourceChainSelector", true],
      ["messageNumber", true],
      ["messageId", true],
      ["state", false],
      ["returnData", false],
    ]);
  });

  it("the raised gas limit: 1.5 times the message's own, half as much again at each failed try, never under its own, at most the ceiling", () => {
    expect([0, 1, 2, 3].map((n) => reexecGasLimit(900_000, n))).toEqual([1_350_000, 1_800_000, 2_250_000, 2_700_000]);
    expect(reexecGasLimit(7_000_000, 0)).toBe(10_500_000);
    expect(reexecGasLimit(7_000_000, 5)).toBe(REEXEC_GAS_CEILING);
    expect(REEXEC_GAS_CEILING).toBe(14_000_000);
    for (const n of [0, 3, 50]) expect(reexecGasLimit(13_000_000, n)).toBeGreaterThanOrEqual(13_000_000);
  });
});

describe("automatic re-execution is off unless OPS_REEXEC_AUTO=on (the founder's ruling)", () => {
  it("the keeper sends and simulates nothing for Cascade's FAILUREs on either lane; each is reported when first found, with its lane, its age and the hand command", async () => {
    const w = world();
    const batch = failedBatch(w, 1n);
    const payout = failedPayout(w, 2n);
    // a stranger's message through Cascade's Base adapter (its payload's sender the stranger), in FAILURE too
    const strangers = laneMessage("Base → Bittensor", { recipient: ADDR.vault, sender: STRANGER, message: "0x01" }, { amount: TAO, number: 3n });
    sendInWorld(w, "Base → Bittensor", strangers, { recipient: ADDR.vault, sender: STRANGER }, { block: 9_003n });
    failInWorld(w, "Base → Bittensor", strangers);
    // Cascade's own, delivered or untouched: nothing to report
    const done = failedBatch(w, 4n, { fail: false });
    w.messageStates[lower(done.id)] = 2;
    const untouched = failedBatch(w, 5n, { fail: false });
    // and a node that ignores the topic filters: the Sent's own arguments are checked again
    w.logsIgnoreTopics = true;
    const r = await rounds(w, 12);
    expect(d.reexecAuto).toBeUndefined();
    expect(executes(w)).toEqual([]);
    expect(simulations(w)).toEqual([]);
    for (const [m, lane, chain] of [
      [batch, "Base → Bittensor", "Bittensor"],
      [payout, "Bittensor → Base", "Base"],
    ] as const) {
      const said = r.lines.filter((l) => l.includes(lower(m.id)));
      expect(said, lane).toHaveLength(1);
      expect(said[0]).toBe(
        `CCIP FAILURE: bridge message ${lower(m.id)} (${lane}) is in FAILURE on ${chain}'s OffRamp (first seen under a minute ago, at ${new Date(T * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC). The keeper doesn't re-execute it by itself. If it is still open at ${new Date(T * 1000 + LANE_WAIT_MS).toISOString().slice(0, 16).replace("T", " ")} UTC, new ${lane === "Base → Bittensor" ? "closes and the migration notice's flush toward Bittensor" : "payouts and park refunds toward Base"} wait until it is delivered. Check it with: pnpm ops reexec ${lower(m.id)} --live, then send it with: pnpm ops reexec ${lower(m.id)} --live --send`,
      );
    }
    // the stranger's, the delivered and the untouched are never named
    for (const m of [strangers, done, untouched]) expect(r.lines.filter((l) => l.includes(m.id.slice(0, 10)))).toEqual([]);
  });

  it("the report repeats about hourly, its age growing; the lane's wait is named once it has been open half an hour", async () => {
    const w = world();
    const m = failedBatch(w, 1n);
    const lines: string[] = [];
    const memory = freshMemory();
    const pass = async (minutes: number, tick: number) => {
      memory.tick = tick;
      w.time.base = T + minutes * 60;
      w.time.bittensor = T + minutes * 60;
      const { deps } = depsFor(w, memory, d, (l) => lines.push(l));
      return reexecV32(deps, memory, { now: (T + minutes * 60) * 1000 });
    };
    expect(await pass(0, 1)).toEqual({});
    expect(await pass(29, 30)).toEqual({});
    const waits = await pass(31, 35);
    expect(waits?.laneWaits).toEqual({ "Base → Bittensor": `bridge message ${m.id.slice(0, 10)}… has been in CCIP FAILURE for 31 min (see CCIP FAILURE above)` });
    expect(waits?.reexecs).toBeUndefined();
    // a round that doesn't read still says the lane waits, from what the last pass read
    expect((await pass(32, 36))?.laneWaits?.["Base → Bittensor"]).toMatch(/32 min/);
    await pass(61, 65);
    await pass(125, 125);
    const reports = lines.filter((l) => l.startsWith("CCIP FAILURE:"));
    expect(FAILURE_REPORT_MS).toBe(60 * 60_000);
    expect(reports).toHaveLength(3);
    expect(reports[1]).toMatch(/first seen 1 h 1 min ago, .*\. New closes and the migration notice's flush toward Bittensor wait until it is delivered\. Check it with/);
    expect(reports[2]).toMatch(/first seen 2 h 5 min ago/);
    // delivered since (someone ran the hand command): nothing more is said, and the lane is free
    w.messageStates[lower(m.id)] = 2;
    expect(await pass(130, 130)).toEqual({});
    expect(lines.filter((l) => l.startsWith("CCIP FAILURE:"))).toHaveLength(3);
  });

  it("the action refuses while the setting is off (no entry point can bypass it): nothing simulated, nothing sent", async () => {
    const w = world();
    const m = failedBatch(w, 1n);
    const { deps, memory } = depsFor(w);
    const e = await reexecActionV32(deps, targetV32(d), { kind: "reexec", id: m.id, direction: "Base → Bittensor" }, { memory, now: T * 1000 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NotNow);
    expect((e as Error).message).toMatch(new RegExp(`automatic re-execution is off \\(OPS_REEXEC_AUTO\\): re-execute it by hand with pnpm ops reexec ${lower(m.id)} --live --send; nothing sent`));
    expect([w.sends, simulations(w)]).toEqual([[], []]);
  });
});

describe("a lane with a FAILURE of Cascade's open half an hour takes nothing new (review (iv))", () => {
  const KEY_P: Hex = `0x${"ab".repeat(32)}`;
  const park = (job: "deliver" | "refund" | "drop") => ({ key: `0x${"cd".repeat(32)}` as Hex, recipient: ADDR.vault, sender: ADDR.frontDoor, message: "0x01" as Hex, job, reason: `a park's ${job}` });
  const base: State = {
    now: T,
    frontDoor: { canClose: true, nDeposits: 1, nRedeems: 0, paused: false, openStart: T - 600, batchInterval: 600, full: false, now: T },
    closeMaxWaitS: 0,
    alphaVault: { healthy: true },
    vault: { paused: false, available: 0n, minStakeWei: 2n * 10n ** 15n, rootStake: 0n, nominatorMinWei: 0n, batches: [{ key: KEY_P, queuedAt: T - 3600, cursor: 0, count: 1 }], payoutDelay: 3600 },
  };
  const toBittensor = { "Base → Bittensor": "bridge message 0x11111111… has been in CCIP FAILURE for 31 min" };
  const toBase = { "Bittensor → Base": "bridge message 0x22222222… has been in CCIP FAILURE for 40 min" };

  it("toward Bittensor: no close, roll or flush; the payouts, the stake and the park deliveries go on", () => {
    expect(decideNext({ ...base, laneWaits: toBittensor }).action).toEqual({ kind: "payouts", key: KEY_P });
    const noPayout = { ...base, vault: { ...base.vault, batches: [] }, laneWaits: toBittensor };
    expect(decideNext({ ...noPayout, laneWaits: {} }).action).toEqual({ kind: "close" });
    const r = decideNext(noPayout);
    expect(r).toEqual({ action: null, reason: `nothing due: new sends toward Bittensor wait (closing the batch): ${toBittensor["Base → Bittensor"]}` });
    expect(decideNext({ ...noPayout, flush: { id: 7n, minValue: TAO, reason: "the notice" } }).reason).toMatch(/new sends toward Bittensor wait \(closing the batch, closing batch 7 once\)/);
    expect(decideNext({ ...noPayout, parkJobs: [park("deliver")] }).action).toMatchObject({ kind: "park", job: "deliver" });
    // the conversions go first whatever the lanes say
    expect(decideNext({ ...noPayout, laneWaits: { ...toBittensor, ...toBase }, conversions: [park("deliver")] }).action).toMatchObject({ kind: "convertPark" });
    // the empty batch's roll waits too
    const empty = { ...noPayout, closeMaxWaitS: 86_400, frontDoor: { ...base.frontDoor, nDeposits: 0, openStart: T - 700 } };
    expect(decideNext({ ...empty, laneWaits: {} }).action).toEqual({ kind: "roll" });
    expect(decideNext(empty).reason).toMatch(/new sends toward Bittensor wait \(rolling the empty batch\)/);
  });

  it("toward Base: no payout and no park refund; the close and the park deliveries and drops go on", () => {
    const r = decideNext({ ...base, frontDoor: { ...base.frontDoor, canClose: false }, laneWaits: toBase, parkJobs: [park("refund")] });
    expect(r).toEqual({ action: null, reason: `nothing due: new sends toward Base wait (paying out batch ${KEY_P.slice(0, 10)}…, refunding park 0xcdcdcdcd…): ${toBase["Bittensor → Base"]}` });
    expect(decideNext({ ...base, laneWaits: toBase }).action).toEqual({ kind: "close" });
    expect(decideNext({ ...base, frontDoor: { ...base.frontDoor, canClose: false }, laneWaits: toBase, parkJobs: [park("refund"), park("drop")] }).action).toMatchObject({ kind: "park", job: "drop" });
  });

  it("in the round: closes go while the FAILURE is young, wait (said each round) once it is half an hour old, and go again once it is delivered", async () => {
    const w = world();
    const m = failedBatch(w, 1n);
    // a batch that can close at once (past its max wait); each close the world mines opens the next, with a deposit
    w.door.start = BigInt(T - 90_000);
    w.fate = (c) => {
      if (c.fn === "closeBatch") w.door.id++;
      return "mine";
    };
    const closes = () => w.sends.filter((s) => s.fn === "closeBatch").length;
    const r = await rounds(w, 40);
    // closed every round until the FAILURE was 30 minutes old (rounds 1 to 30), then nothing new toward Bittensor
    expect(closes()).toBe(30);
    const waiting = r.lines.filter((l) => l.startsWith("nothing due: new sends toward Bittensor wait (closing the batch): bridge message"));
    expect(waiting).toHaveLength(10);
    expect(waiting[0]).toBe(`nothing due: new sends toward Bittensor wait (closing the batch): bridge message ${m.id.slice(0, 10)}… has been in CCIP FAILURE for 30 min (see CCIP FAILURE above)`);
    // delivered (someone re-executed it): the next read lets the lane go
    w.messageStates[lower(m.id)] = 2;
    await rounds(w, 6, { memory: r.memory, from: T + 40 * 60 });
    expect(closes()).toBeGreaterThan(30);
  });
});

describe("Task 52's re-review minors (T52w)", () => {
  const iso = (s: number) => new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ");
  /** reexecV32 at `minutes` past T, as round `tick` would call it, on `memory` */
  const passOf = (w: World, memory: KeeperMemory, lines: string[], dep = d) => async (minutes: number, tick: number) => {
    memory.tick = tick;
    w.time.base = T + minutes * 60;
    w.time.bittensor = T + minutes * 60;
    const { deps } = depsFor(w, memory, dep, (l) => lines.push(l));
    return reexecV32(deps, memory, { now: (T + minutes * 60) * 1000 });
  };

  it("N1: a watch read that fails keeps the lanes' waits from what was last read, and says so: the lane still takes nothing new", async () => {
    const w = world();
    const m = failedBatch(w, 1n);
    const lines: string[] = [];
    const pass = passOf(w, freshMemory(), lines);
    await pass(0, 1);
    // a pass that reads (every 5 rounds), the logs server down
    w.logsFail = () => new Error("the logs server is down");
    const r = await pass(31, 35);
    expect(r?.laneWaits).toEqual({ "Base → Bittensor": `bridge message ${m.id.slice(0, 10)}… has been in CCIP FAILURE for 31 min (see CCIP FAILURE above)` });
    expect(lines).toContainEqual(expect.stringMatching(/^Could not read Cascade's bridge messages for FAILUREs \(.*the logs server is down.*\); the lanes' waits stand from the last reading; trying again later$/));
    // in the round: closes go for the FAILURE's first 30 minutes, then wait, the watch's reads failing or not
    const v = world();
    failedBatch(v, 1n);
    v.door.start = BigInt(T - 90_000);
    v.fate = (c) => {
      if (c.fn === "closeBatch") v.door.id++;
      return "mine";
    };
    const first = await rounds(v, 31);
    expect(v.sends.filter((s) => s.fn === "closeBatch").length).toBe(30);
    // the adapters' logs can't be read (the watch's Sent scans; the park job's too)
    v.logsFail = (_n, _chain, q) => ([ADDR.baseAdapter, ADDR.bitAdapter].some((a) => lower(a) === lower(q.address)) ? new Error("the logs server is down") : undefined);
    const later = await rounds(v, 5, { memory: first.memory, from: T + 31 * 60 });
    expect(v.sends.filter((s) => s.fn === "closeBatch").length).toBe(30);
    expect(later.lines.some((l) => l.startsWith("nothing due: new sends toward Bittensor wait (closing the batch)"))).toBe(true);
  });

  it("N4: a FAILURE the keeper never read before counts its age from its send's block, so a memory lost restarts nothing; one read before counts from the reading that found it", async () => {
    const w = world();
    const m = failedBatch(w, 1n);
    // its Sent, at Base block 9001, two hours ago
    w.blockTimes["base:9001"] = T - 2 * 3_600;
    const lines: string[] = [];
    const r = await passOf(w, freshMemory(), lines)(0, 1);
    expect(r?.laneWaits).toEqual({ "Base → Bittensor": `bridge message ${m.id.slice(0, 10)}… has been in CCIP FAILURE for 2 h (see CCIP FAILURE above)` });
    expect(lines.find((l) => l.startsWith("CCIP FAILURE:"))).toContain(`is in FAILURE on Bittensor's OffRamp (sent 2 h ago, at ${iso(T - 7_200)} UTC, and not read before). The keeper doesn't re-execute it by itself. New closes`);
    // read before (untouched), then in FAILURE: its age from the reading that found it
    const v = world();
    const n = failedBatch(v, 2n, { fail: false });
    v.blockTimes["base:9002"] = T - 2 * 3_600;
    const memory = freshMemory();
    const seen: string[] = [];
    const pass = passOf(v, memory, seen);
    await pass(0, 1);
    failInWorld(v, "Base → Bittensor", n);
    const r2 = await pass(5, 5);
    expect(r2?.laneWaits).toBeUndefined();
    expect(seen.find((l) => l.startsWith("CCIP FAILURE:"))).toContain(`(first seen under a minute ago, at ${iso(T + 300)} UTC)`);
  });

  it("N6: a FAILURE whose bytes didn't check (its OnRamp's log not served yet) is checked again at each hourly report; once it checks, it is reported as any FAILURE", async () => {
    for (const dep of [d, AUTO]) {
      const w = world();
      const m = failedBatch(w, 1n);
      const onRamp = w.logs.filter((l) => l.event === "CCIPMessageSent");
      w.logs = w.logs.filter((l) => l.event !== "CCIPMessageSent");
      const lines: string[] = [];
      const pass = passOf(w, freshMemory(), lines, dep);
      await pass(0, 1);
      const refused = lines.filter((l) => l.startsWith("REEXEC REFUSED:"));
      expect(refused).toEqual([
        `REEXEC REFUSED: bridge message ${lower(m.id)} (Base → Bittensor) is in FAILURE on Bittensor's OffRamp (first seen under a minute ago, at ${iso(T)} UTC), but its source OnRamp logged no CCIPMessageSent for it at block 9001, where its Sent is: the keeper doesn't re-execute it while its bytes don't check, and checks them again each hour. Check it by hand with: pnpm ops reexec ${lower(m.id)} --live. If it is still open at ${iso(T + 1_800)} UTC, new closes and the migration notice's flush toward Bittensor wait until it is delivered.`,
      ]);
      // the node catches up: at the next hourly report its bytes check
      w.logs.push(...onRamp);
      const r = await pass(61, 65);
      expect(lines.filter((l) => l.startsWith("REEXEC REFUSED:"))).toHaveLength(1);
      expect(lines.filter((l) => l.startsWith("CCIP FAILURE:"))).toHaveLength(1);
      // with the setting on, it is offered again
      expect(r?.reexecs?.map((x) => x.id), String(dep.reexecAuto)).toEqual(dep.reexecAuto ? [lower(m.id)] : undefined);
    }
  });

  it("N7: the world's OffRamp writes FAILURE when an untouched message's execution fails inside (a bad proof), as the deployed one does; with the committee's results it delivers", () => {
    const w = world();
    const m = failedBatch(w, 1n, { fail: false });
    const call = (msg: Msg, ccvs: Address[], results: Hex[], hash: Hex) =>
      bridgeCallMined(w, { chain: "bittensor", to: ADDR.offRampBittensor, fn: "execute", args: [msg.encoded, ccvs, results, 0], value: 0n, gas: 1_000_000n, hash }, hash, []);
    const junk = call(m, [], [], `0x${"01".repeat(32)}`);
    expect(junk.fate).toBe("mine");
    expect(w.messageStates[lower(m.id)]).toBe(FAILURE);
    expect(w.logs.at(-1)).toMatchObject({ event: "ExecutionStateChanged", args: { messageId: m.id, state: 3, returnData: offRampError("RequiredCCVMissing", [COMMITTEE]) } });
    expect(junk.logs).toHaveLength(1);
    // from FAILURE, a bad proof makes no progress: the call reverts, as before
    expect(call(m, [], [], `0x${"02".repeat(32)}`).fate).toBe("revert");
    const n = failedBatch(w, 2n, { fail: false });
    expect(call(n, [COMMITTEE], [committeeResult(n.id)], `0x${"03".repeat(32)}`).fate).toBe("mine");
    expect(w.messageStates[lower(n.id)]).toBe(2);
  });
});

describe("pnpm ops reexec, the hand re-run: every check before it signs (review (iii))", () => {
  it("without --send it checks, simulates and says what it would send: the committee's results from the attempt that wrote the FAILURE", async () => {
    const w = world();
    const m = failedBatch(w, 1n);
    const seen: unknown[][] = [];
    w.executeSim = (args) => {
      seen.push([...args]);
      return 400_000n;
    };
    const r = await hand(w, { id: m.id });
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([
      `Bridge message ${lower(m.id)}: Cascade's own, Base → Bittensor, sent at block 9001 on Base.`,
      "Its first failure: the receiver failed: ReentrancyGuardReentrantCall().",
      `Checked: in FAILURE now; its bytes rebuilt; 1 committee result from transaction ${m.tx}, covering what the OffRamp requires; a 1,350,000 gas limit (its own is 900,000). Its simulation passes: it would be delivered.`,
      `Nothing sent. To send it: pnpm ops reexec ${lower(m.id)} --live --send`,
    ]);
    // simulated with exactly the bytes and the attempt's proof; nothing sent
    expect(seen).toEqual([[m.encoded, [COMMITTEE], [committeeResult(m.id)], 1_350_000]]);
    expect(w.sends).toEqual([]);
  });

  it("with --send it sends that through the one send path, on either lane, and reads the state again: delivered", async () => {
    const w = world();
    const batch = failedBatch(w, 1n);
    const payout = failedPayout(w, 2n);
    const a = await hand(w, { id: batch.id, send: true });
    const b = await hand(w, { id: payout.id, send: true });
    expect([a.code, b.code]).toEqual([0, 0]);
    expect(executes(w)).toEqual([
      { to: lower(ADDR.offRampBittensor), chain: "bittensor", args: [batch.encoded, [COMMITTEE], [committeeResult(batch.id)], 1_350_000] },
      { to: lower(ADDR.offRampBase), chain: "base", args: [payout.encoded, [COMMITTEE], [committeeResult(payout.id)], 450_000] },
    ]);
    expect(a.journal.rows.map((x) => x.request.functionName)).toEqual(["execute"]);
    expect(a.lines.at(-1)).toMatch(new RegExp(`^Done \\(transaction 0x[0-9a-f]{64}\\): bridge message ${lower(batch.id)} is delivered\\.$`));
    expect([w.messageStates[lower(batch.id)], w.messageStates[lower(payout.id)]]).toEqual([2, 2]);
  });

  it("only Cascade's own, in FAILURE now: a stranger's or an unknown id, an untouched or a delivered message, or bytes that don't check: nothing simulated or sent", async () => {
    const cases: [string, (w: World) => Hex, RegExp][] = [
      [
        "a stranger's",
        (w) => {
          const s = laneMessage("Base → Bittensor", { recipient: ADDR.vault, sender: STRANGER, message: "0x01" }, { amount: TAO, number: 3n });
          sendInWorld(w, "Base → Bittensor", s, { recipient: ADDR.vault, sender: STRANGER }, { block: 9_003n });
          failInWorld(w, "Base → Bittensor", s);
          return s.id;
        },
        /is not one of Cascade's own \(no Sent from the door to the vault on Base, nor from the vault to the door on Bittensor\): the keeper never re-executes it$/,
      ],
      ["an unknown id", () => keccak256(toHex("nothing")), /is not one of Cascade's own/],
      ["an untouched one", (w) => failedBatch(w, 1n, { fail: false }).id, /^Not sent: it is untouched: it was never executed, and the keeper never makes a message's first execution \(Chainlink's executor does\)$/],
      [
        "a delivered one",
        (w) => {
          const m = failedBatch(w, 1n);
          w.messageStates[lower(m.id)] = 2;
          return m.id;
        },
        /^Not sent: it was delivered \(SUCCESS\): nothing to re-execute$/,
      ],
      ["bytes that don't hash to its id", (w) => failedBatch(w, 1n, { encodedLogged: laneMessage("Base → Bittensor", { recipient: ADDR.vault, sender: ADDR.frontDoor, message: "0x02" }, { number: 9n }).encoded }).id, /^Not sent: its bytes don't check: the bytes the Base OnRamp logged hash to/],
      ["another amount than its Sent's", (w) => failedBatch(w, 1n, { sentAmount: 2n * TAO }).id, /^Not sent: its bytes don't check: it carries 1000000000000000000 wei of the token, not the 2000000000000000000/],
    ];
    for (const [what, make, why] of cases) {
      const w = world();
      const id = make(w);
      const r = await hand(w, { id, send: true });
      expect(r.code, what).toBe(1);
      expect(r.lines.at(-1), what).toMatch(why);
      expect([w.sends, simulations(w)], what).toEqual([[], []]);
    }
  });

  it("the proof's source: by default the attempt that wrote the FAILURE; --from-tx names another; one not to the OffRamp, not its execute, or of other bytes is refused", async () => {
    const w = world();
    const m = failedBatch(w, 1n);
    const later = attemptInWorld(w, "Base → Bittensor", m);
    const r = await hand(w, { id: m.id, fromTx: later });
    expect(r.lines.find((l) => l.startsWith("Checked:"))).toContain(`from transaction ${later}`);
    expect(r.lines.at(-1)).toBe(`Nothing sent. To send it: pnpm ops reexec ${lower(m.id)} --from-tx ${later} --live --send`);
    const refused: [Hex, RegExp][] = [
      [attemptInWorld(w, "Base → Bittensor", m, { to: STRANGER }), /was not sent to Bittensor's OffRamp 0x[0-9a-fA-F]{40} \(an executor's own contract, perhaps\): name an attempt that calls the OffRamp's execute with --from-tx <hash>, or give the committee's results with --proof <file>$/],
      [attemptInWorld(w, "Base → Bittensor", m, { input: "0x12345678" }), /does not call the OffRamp's execute: name one that does with --from-tx <hash>$/],
      [attemptInWorld(w, "Base → Bittensor", m, { encoded: failedBatch(w, 2n).encoded }), /executes other bytes than this message's: name an attempt of this message with --from-tx <hash>$/],
      [keccak256(toHex("no such transaction")), /^Not sent: Bittensor knows no transaction 0x[0-9a-f]{64}$/],
    ];
    for (const [tx, why] of refused) {
      const x = await hand(w, { id: m.id, fromTx: tx, send: true });
      expect([x.code, x.lines.at(-1)], tx).toEqual([1, expect.stringMatching(why)]);
    }
    // a FAILURE whose writing attempt can't be found: --from-tx is named
    const v = world();
    const n = failedBatch(v, 1n, { fail: false });
    v.messageStates[lower(n.id)] = FAILURE;
    const y = await hand(v, { id: n.id, send: true });
    expect(y.lines.at(-1)).toMatch(/^Not sent: no transaction that wrote its FAILURE was found on Bittensor's OffRamp \(blocks \d+ to \d+\): name an honest attempt with --from-tx <hash>$/);
    expect([w.sends, v.sends, simulations(v)]).toEqual([[], [], []]);
  });

  it("the proof must cover getCCVsForMessage: a junk attempt's, or one short of the optional threshold, is refused before any simulation", async () => {
    const w = world();
    const junk = failedBatch(w, 1n, { fail: { ccvs: [], results: [] } });
    const r = await hand(w, { id: junk.id, send: true });
    expect(r.lines.at(-1)).toBe(`Not sent: the committee's results in transaction ${junk.tx} lack the committee the OffRamp requires (${COMMITTEE}): name an attempt that carries them with --from-tx <hash>`);
    const v = world();
    const m = failedBatch(v, 1n);
    v.ccvs = { required: [COMMITTEE], optional: [at("cc02"), at("cc03")], threshold: 1 };
    const x = await hand(v, { id: m.id, send: true });
    expect(x.lines.at(-1)).toMatch(/lack the committee|cover 0 of the 1 optional committees the OffRamp requires/);
    expect([w.sends, v.sends, simulations(w), simulations(v)]).toEqual([[], [], [], []]);
  });

  it("the gas limit is within reexecGasLimit's bounds: never under the message's own, never above the ceiling", async () => {
    const w = world();
    const m = failedBatch(w, 1n);
    expect((await hand(w, { id: m.id, gas: 899_999 })).lines.at(-1)).toBe("Not sent: a 899,999 gas limit is under the message's own 900,000 (the OffRamp refuses it)");
    expect((await hand(w, { id: m.id, gas: REEXEC_GAS_CEILING + 1 })).lines.at(-1)).toBe("Not sent: a 14,000,001 gas limit is above the keeper's ceiling of 14,000,000");
    expect(simulations(w)).toEqual([]);
    const ok = await hand(w, { id: m.id, gas: 2_000_000 });
    expect([ok.code, ok.lines.at(-1)]).toEqual([0, `Nothing sent. To send it: pnpm ops reexec ${lower(m.id)} --gas 2000000 --live --send`]);
  });

  it("the simulation must pass, a refusal explained: the receiver failed again, or the committee's results were refused (try --from-tx)", async () => {
    const w = world();
    const m = failedBatch(w, 1n);
    w.executeSim = () => ({ error: "NoStateProgressMade", args: [m.id, offRampError("ReceiverError", [offRampError("InvalidVerifierResults")])] });
    const r = await hand(w, { id: m.id, send: true });
    expect([r.code, r.lines.at(-1)]).toEqual([1, "Not sent: its simulation refuses it: the receiver failed again (the receiver failed: InvalidVerifierResults()): its cause is still there"]);
    w.executeSim = () => ({ error: "NoStateProgressMade", args: [m.id, offRampError("InvalidVerifierResults")] });
    const x = await hand(w, { id: m.id, send: true });
    expect(x.lines.at(-1)).toBe("Not sent: its simulation refuses it: the committee's results were refused (InvalidVerifierResults()): try --from-tx with a later honest attempt");
    w.executeSim = () => ({ error: "NoStateProgressMade", args: [m.id, "0x"] });
    expect((await hand(w, { id: m.id })).lines.at(-1)).toBe("Not sent: its simulation refuses it: it failed again with no reason given (out of gas, perhaps: try more with --gas)");
    expect(w.sends).toEqual([]);
  });

  it("during ForeverMoney's migration notice it shows migrationReadyAt", async () => {
    const w = world();
    const m = failedBatch(w, 1n);
    w.alpha.migrationReadyAt = NOTICE;
    const r = await hand(w, { id: m.id });
    expect(r.lines).toContain(
      `MIGRATION NOTICE: ForeverMoney's migration is announced (migrationReadyAt ${NOTICE}, ${new Date(Number(NOTICE) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC). A batch delivered after the migration executes parks as ForeverMoney's token, a claim ForeverMoney won't honour.`,
    );
  });

  it("it sends only through the one send path: a hold refuses it, and so does the spend cap", async () => {
    const w = world();
    const m = failedBatch(w, 1n);
    w.monitor.hold = ["h-1"];
    const r = await hand(w, { id: m.id, send: true });
    expect([r.code, r.lines.at(-1)]).toEqual([1, expect.stringMatching(/^Not sent: .*hold/i)]);
    w.monitor.hold = [];
    const capped = deploymentFor({ spendCap: { base: parseEther("0.0017"), bittensor: parseEther("0.033") } });
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
    const c = await hand(w, { id: m.id, send: true, dep: capped, journal });
    expect([c.code, c.lines.at(-1)]).toEqual([1, expect.stringMatching(/^Not sent: Bittensor is at the keeper's 24 h spend cap/)]);
    expect(w.sends).toEqual([]);
  });

  it("its arguments: one message id, --from-tx <hash> or --proof <file>, --gas <limit>, --send to send (never --live, which names the live record)", () => {
    const id = keccak256(toHex("m"));
    const tx = keccak256(toHex("t"));
    expect(parseReexecArgs([id])).toEqual({ id, live: false, send: false });
    // --live is the live record, as in every other command: it checks only
    expect(parseReexecArgs([id.toUpperCase().replace("0X", "0x"), "--from-tx", tx, "--gas", "2000000", "--live"])).toEqual({ id, fromTx: tx, gas: 2_000_000, live: true, send: false });
    expect(parseReexecArgs([id, "--proof", "proof.json", "--live", "--send"])).toEqual({ id, proofFile: "proof.json", live: true, send: true });
    for (const [args, why] of [
      [[], /needs a bridge message id/],
      [["0x12"], /is not a bridge message id/],
      [[id, id], /takes one bridge message id/],
      [[id, "--from-tx"], /--from-tx needs a transaction hash/],
      [[id, "--gas", "lots"], /--gas needs a gas limit/],
      [[id, "--proof"], /--proof needs a file/],
      [[id, "--from-tx", tx, "--proof", "p.json"], /takes the committee's results from --from-tx or --proof, not both/],
      [[id, "--force"], /--force is not one of its flags/],
    ] as [string[], RegExp][]) {
      expect(() => parseReexecArgs(args), args.join(" ")).toThrow(why);
      expect(() => parseReexecArgs(args)).toThrow(REEXEC_USAGE);
    }
    // the hand run's flags, taken as the other one-shots take them (Task 52w fix M3), are in its usage too
    expect(REEXEC_USAGE).toBe('pnpm ops reexec <messageId> [--from-tx <hash> | --proof <file | 0x…> | --empty-proof] [--gas <limit>] [--live] [--send] [--without-lease "<reason>"] [--ignore-monitor-outage --until <time>]');
  });

  it("pnpm ops's usage (args.ts USAGE) lists reexec with its flags as built, its own usage word for word (Task 52w review M8)", () => {
    // the entry: its first line and the lines indented under it, up to the next command or the blank line
    const lines = USAGE.split("\n");
    const at = lines.findIndex((l) => l.startsWith("  reexec "));
    expect(at, "a reexec entry in USAGE").toBeGreaterThan(-1);
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((l) => !/^ {29}\S/.test(l));
    const entry = [lines[at], ...rest.slice(0, end)].join(" ").replace(/\s+/g, " ").trim();
    expect(entry.startsWith(`${REEXEC_USAGE.replace(/^pnpm ops /, "")} v3.2: `), entry).toBe(true);
    // what it says the flags do: only --send sends, a check takes no lease, --live names the live record
    expect(entry).toContain("Only --send sends");
    expect(entry).toContain("takes no lease");
    expect(entry).toContain("--live names the live record");
  });

  it("N2: --proof <file>, the committee's results given whole (an executor that calls the OffRamp through its own contract): checked as any proof, never trusted", async () => {
    const w = world();
    // the attempt that wrote the FAILURE went through a contract: no transaction calls the OffRamp's execute directly
    const m = failedBatch(w, 1n, { fail: { to: STRANGER } });
    const plain = await hand(w, { id: m.id, send: true });
    expect(plain.lines.at(-1)).toMatch(/an executor's own contract, perhaps\): name an attempt that calls the OffRamp's execute with --from-tx <hash>, or give the committee's results with --proof <file>$/);
    const proof = parseProofFile(JSON.stringify({ ccvs: [COMMITTEE], verifierResults: [committeeResult(m.id)] }), "proof.json");
    const dry = await hand(w, { id: m.id, proof });
    expect(dry.code).toBe(0);
    expect(dry.lines.find((l) => l.startsWith("Checked:"))).toContain("1 committee result from the proof file proof.json, covering what the OffRamp requires");
    expect(dry.lines.at(-1)).toBe(`Nothing sent. To send it: pnpm ops reexec ${lower(m.id)} --proof proof.json --live --send`);
    expect(w.sends).toEqual([]);
    const sent = await hand(w, { id: m.id, proof, send: true });
    expect(sent.code).toBe(0);
    expect(executes(w)).toEqual([{ to: lower(ADDR.offRampBittensor), chain: "bittensor", args: [m.encoded, [COMMITTEE], [committeeResult(m.id)], 1_350_000] }]);
    // a junk file: the OffRamp's own checks refuse it in the simulation, or the keeper's CCV check before; nothing sent
    const v = world();
    const n = failedBatch(v, 1n, { fail: { to: STRANGER } });
    const junk = await hand(v, { id: n.id, proof: parseProofFile(JSON.stringify({ ccvs: [COMMITTEE], verifierResults: ["0xdeadbeef"] }), "junk.json"), send: true });
    expect(junk.lines.at(-1)).toBe("Not sent: its simulation refuses it: the committee's results were refused (InvalidVerifierResults()): try --from-tx with a later honest attempt");
    const short = await hand(v, { id: n.id, proof: parseProofFile(JSON.stringify({ ccvs: [at("cc09")], verifierResults: ["0x01"] }), "short.json"), send: true });
    expect(short.lines.at(-1)).toBe(`Not sent: the committee's results in the proof file short.json lack the committee the OffRamp requires (${COMMITTEE}): correct the proof file so it carries them`);
    expect(v.sends).toEqual([]);
    // the file itself: JSON, as many results as committees, addresses and hex
    for (const [text, why] of [
      ["{", /is not JSON/],
      [JSON.stringify({ ccvs: [COMMITTEE], verifierResults: [] }), /has 1 committees and 0 results/],
      [JSON.stringify({ ccvs: [], verifierResults: [] }), /names no committee/],
      [JSON.stringify({ ccvs: ["0x12"], verifierResults: ["0x01"] }), /0x12 is not an address/],
      [JSON.stringify({ ccvs: [COMMITTEE], verifierResults: ["zz"] }), /zz is not hex/],
    ] as [string, RegExp][]) {
      expect(() => parseProofFile(text, "p.json"), text).toThrow(why);
    }
  });

  it("N5: the hand re-run looks afresh: a lookup that found nothing within the day (a node whose index lagged) is read again", async () => {
    const w = world();
    const m = failedBatch(w, 1n);
    const lines: string[] = [];
    const memory = freshMemory();
    // a first lookup while the node had not indexed its Sent yet
    const sent = w.logs.filter((l) => l.event === "Sent");
    w.logs = w.logs.filter((l) => l.event !== "Sent");
    const { deps } = depsFor(w, memory, d, (l) => lines.push(l));
    expect("none" in (await deps.sentById(m.id))).toBe(true);
    w.logs.push(...sent);
    // the hand re-run on that same memory finds it
    const code = await reexecByHand(deps, targetV32(d), memory, { id: m.id, send: false, now: T * 1000 });
    expect([code, lines.at(-1)]).toEqual([0, `Nothing sent. To send it: pnpm ops reexec ${lower(m.id)} --live --send`]);
  });

  it("cli.ts's mapping (Task 52w fix M2): only --send sends; --live is the record; the proof, the attempt and the gas go as given", () => {
    const id = keccak256(toHex("m"));
    const tx = keccak256(toHex("t"));
    const proof = parseProofFile(JSON.stringify({ ccvs: [COMMITTEE], verifierResults: ["0x01"] }), "p.json");
    expect(reexecHandInput(parseReexecArgs([id, "--live"]))).toEqual({ live: true, reexec: { id, send: false } });
    expect(reexecHandInput(parseReexecArgs([id]))).toEqual({ live: false, reexec: { id, send: false } });
    expect(reexecHandInput(parseReexecArgs([id, "--send", "--from-tx", tx, "--gas", "2000000"]))).toEqual({ live: false, reexec: { id, send: true, fromTx: tx, gas: 2_000_000 } });
    expect(reexecHandInput(parseReexecArgs([id, "--proof", "p.json", "--live", "--send"]), proof)).toEqual({ live: true, reexec: { id, send: true, proof } });
    // a proof file named but not read is never sent without it
    expect(() => reexecHandInput(parseReexecArgs([id, "--proof", "p.json"]))).toThrow(/the proof file p\.json was not read; nothing sent/);
  });

  it("its words name the live record only on the live chains: a rehearsal's hand run says no --live", async () => {
    const w = world();
    const m = failedBatch(w, 1n);
    const r = await hand(w, { id: m.id, live: false });
    expect(r.lines.at(-1)).toBe(`Nothing sent. To send it: pnpm ops reexec ${lower(m.id)} --send`);
    expect(handCommand(m.id, { live: true })).toBe(`pnpm ops reexec ${lower(m.id)} --live`);
    expect(handCommand(m.id, { live: false, send: true })).toBe(`pnpm ops reexec ${lower(m.id)} --send`);
  });
});

describe("with automatic re-execution on (OPS_REEXEC_AUTO=on, only after the rehearsals)", () => {
  it("reexecutesOnlyOurFailures: Cascade's FAILUREs on either lane, rebuilt byte for byte, with the failed attempt's committee results and a raised gas limit", async () => {
    const w = world();
    const batch = failedBatch(w, 1n);
    const payout = failedPayout(w, 2n);
    const strangers = laneMessage("Base → Bittensor", { recipient: ADDR.vault, sender: STRANGER, message: "0x01" }, { amount: TAO, number: 3n });
    sendInWorld(w, "Base → Bittensor", strangers, { recipient: ADDR.vault, sender: STRANGER }, { block: 9_003n });
    failInWorld(w, "Base → Bittensor", strangers);
    const untouched = failedBatch(w, 5n, { fail: false });
    w.logsIgnoreTopics = true;
    const r = await rounds(w, 4, { dep: AUTO });
    expect(executes(w)).toEqual(
      expect.arrayContaining([
        { to: lower(ADDR.offRampBittensor), chain: "bittensor", args: [batch.encoded, [COMMITTEE], [committeeResult(batch.id)], 1_350_000] },
        { to: lower(ADDR.offRampBase), chain: "base", args: [payout.encoded, [COMMITTEE], [committeeResult(payout.id)], 450_000] },
      ]),
    );
    expect(executes(w)).toHaveLength(2);
    expect([w.messageStates[lower(batch.id)], w.messageStates[lower(payout.id)], w.messageStates[lower(strangers.id)]]).toEqual([2, 2, FAILURE]);
    expect(r.lines.filter((l) => l.includes(strangers.id.slice(0, 10)) || l.includes(untouched.id.slice(0, 10)))).toEqual([]);
    expect(r.lines).toContainEqual(expect.stringMatching(new RegExp(`^Bridge message ${batch.id.slice(0, 10)}… \\(Base → Bittensor\\) re-executed with the committee's results from transaction ${batch.tx}: delivered$`)));
  });

  it("reexecIsHeldByTheHold: under a hold no re-execution goes, in the round or one-shot; the migration exception is conversions only", async () => {
    const w = world();
    const m = failedBatch(w, 1n);
    w.monitor.hold = ["h-1"];
    await rounds(w, 6, { dep: AUTO });
    expect(w.sends).toEqual([]);
    w.alpha.migrationReadyAt = NOTICE;
    await rounds(w, 6, { dep: AUTO });
    expect(w.sends).toEqual([]);
    // one-shot through the one send path: the rails refuse it
    const { deps, memory } = depsFor(w, freshMemory(), AUTO);
    const e = await reexecActionV32(deps, targetV32(AUTO), { kind: "reexec", id: m.id, direction: "Base → Bittensor" }, { memory, now: T * 1000 }).catch((x: unknown) => x);
    expect((e as SendRefused).reason).toBe("rails");
    expect(w.sends).toEqual([]);
    // the hold lifts: it goes
    w.monitor.hold = [];
    w.alpha.migrationReadyAt = 0n;
    await rounds(w, 1, { dep: AUTO });
    expect(executes(w).map((x) => x.args[0])).toEqual([m.encoded]);
  });

  it("one-shot: a message delivered since, or untouched, is not re-executed (NotNow), nothing sent", async () => {
    const w = world();
    const m = failedBatch(w, 1n);
    for (const state of [2, 0]) {
      w.messageStates[lower(m.id)] = state;
      const { deps, memory } = depsFor(w, freshMemory(), AUTO);
      const e = await reexecActionV32(deps, targetV32(AUTO), { kind: "reexec", id: m.id, direction: "Base → Bittensor" }, { memory, now: T * 1000 }).catch((x: unknown) => x);
      expect((e as Error).message).toMatch(state === 2 ? /was delivered since \(SUCCESS\): nothing to re-execute/ : /is untouched now, not in FAILURE: nothing to re-execute/);
      expect(classifyFailure(e).stop).toBe(false);
    }
    expect(w.sends).toEqual([]);
  });

  it("a junk attempt's proof, or a simulation that refuses, puts it on its back-off, explained: nothing sent", async () => {
    const w = world();
    const junk = failedBatch(w, 1n, { fail: { ccvs: [], results: [] } });
    const { deps, memory } = depsFor(w, freshMemory(), AUTO);
    const a = { kind: "reexec" as const, id: junk.id, direction: "Base → Bittensor" as const };
    const e = await reexecActionV32(deps, targetV32(AUTO), a, { memory, now: T * 1000 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HeldRefusal);
    expect((e as Error).message).toMatch(/^REEXEC FAILED AGAIN: re-executing bridge message 0x[0-9a-f]{8}… \(Base → Bittensor\) with a 1,350,000 gas limit: the committee's results in transaction 0x[0-9a-f]{64} lack the committee the OffRamp requires/);
    const v = world();
    const m = failedBatch(v, 1n);
    v.executeSim = () => ({ error: "NoStateProgressMade", args: [m.id, offRampError("ReceiverError", ["0x"])] });
    const x = depsFor(v, freshMemory(), AUTO);
    const f = await reexecActionV32(x.deps, targetV32(AUTO), { ...a, id: m.id }, { memory: x.memory, now: T * 1000 }).catch((y: unknown) => y);
    expect((f as Error).message).toMatch(/: its simulation refuses it: the receiver failed again \(the receiver failed: no reason given\): its cause is still there; tried again in 5 min/);
    expect([w.sends, v.sends]).toEqual([[], []]);
  });

  it("a re-execution back-off, at the job level: 5 min doubling to 1 h, each try's gas raised, never a stop; then it goes once", async () => {
    const w = world();
    const m = failedBatch(w, 1n);
    let fails = true;
    const gases: unknown[] = [];
    w.executeSim = (args) => {
      gases.push(args[3]);
      return fails ? { error: "NoStateProgressMade", args: [m.id, offRampError("ReceiverError", ["0x"])] } : 400_000n;
    };
    const memory = freshMemory();
    const a = { kind: "reexec" as const, id: m.id, direction: "Base → Bittensor" as const };
    let now = T * 1000;
    const offered = async () => {
      memory.tick = 5;
      const { deps } = depsFor(w, memory, AUTO);
      return ((await reexecV32(deps, memory, { now }))?.reexecs ?? []).map((x) => x.id);
    };
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      expect(await offered(), `try ${i + 1}`).toEqual([m.id]);
      const { deps } = depsFor(w, memory, AUTO);
      const e = await reexecActionV32(deps, targetV32(AUTO), a, { memory, now }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(HeldRefusal);
      expect(classifyFailure(e).stop).toBe(false);
      const next = (memory.reads.reexec as { tries: Record<string, { nextAt: number }> }).tries[lower(m.id)].nextAt;
      waits.push(next - now);
      // not offered again before its back-off ends
      now = next - 1;
      expect(await offered()).toEqual([]);
      now = next;
    }
    expect([SKIP_MS, SKIP_MAX_MS]).toEqual([5 * 60_000, 60 * 60_000]);
    expect(waits).toEqual([5, 10, 20, 40, 60, 60, 60].map((x) => x * 60_000));
    expect(gases).toEqual([1_350_000, 1_800_000, 2_250_000, 2_700_000, 3_150_000, 3_600_000, 4_050_000]);
    // it would succeed now: sent once, with more gas, and the message is delivered
    fails = false;
    expect(await offered()).toEqual([m.id]);
    const { deps } = depsFor(w, memory, AUTO);
    await reexecActionV32(deps, targetV32(AUTO), a, { memory, now });
    expect(executes(w).map((x) => [x.args[0], x.args[3]])).toEqual([[m.encoded, 4_500_000]]);
    expect(w.messageStates[lower(m.id)]).toBe(2);
    expect(await offered()).toEqual([]);
  });

  it("a re-execution the chain reverts after its simulation passed: on the back-off, reported, never a stop", async () => {
    const w = world();
    failedBatch(w, 1n);
    w.fate = (c) => (c.fn === "execute" ? "revert" : "mine");
    const r = await rounds(w, 8, { dep: AUTO });
    expect(executes(w)).toHaveLength(2);
    expect(r.lines.filter((l) => l.startsWith("HELD: re-executing bridge message"))).toHaveLength(2);
  });
});

describe("the test world's OffRamp checks the proof as the deployed one does (review I4): every re-execution here runs against it", () => {
  it("it refuses an empty or a wrong proof, and takes only the results the committee signed for that very message", () => {
    const w = world();
    const m = failedBatch(w, 1n);
    const other = failedBatch(w, 2n);
    const exec = (ccvs: Address[], results: Hex[], gas = 1_350_000) => w.executeSim([m.encoded, ccvs, results, gas]);
    const refused = (inner: Hex) => ({ error: "NoStateProgressMade", args: [m.id, inner] });
    expect(exec([], [])).toEqual(refused(offRampError("RequiredCCVMissing", [COMMITTEE])));
    expect(exec([COMMITTEE], ["0x1234"])).toEqual(refused(offRampError("InvalidVerifierResults")));
    expect(exec([COMMITTEE], [committeeResult(other.id)])).toEqual(refused(offRampError("InvalidVerifierResults")));
    expect(exec([COMMITTEE], [])).toEqual({ error: "InvalidVerifierResultsLength", args: [1n, 0n] });
    expect(exec([COMMITTEE], [committeeResult(m.id)])).toBe(400_000n);
    // an optional threshold unmet; a receiver that fails again; an override under the message's own; a delivered message
    w.ccvs = { required: [COMMITTEE], optional: [at("cc02")], threshold: 1 };
    expect(exec([COMMITTEE], [committeeResult(m.id)])).toEqual(refused(offRampError("OptionalCCVQuorumNotReached", [1n, 0n])));
    w.ccvs = { required: [COMMITTEE], optional: [], threshold: 0 };
    w.receiverFails = () => "0x";
    expect(exec([COMMITTEE], [committeeResult(m.id)])).toEqual(refused(offRampError("ReceiverError", ["0x"])));
    w.receiverFails = () => undefined;
    expect(exec([COMMITTEE], [committeeResult(m.id)], 899_999)).toMatchObject({ error: "InvalidGasLimitOverride" });
    w.messageStates[lower(m.id)] = 2;
    expect(exec([COMMITTEE], [committeeResult(m.id)])).toMatchObject({ error: "SkippedAlreadyExecutedMessage" });
  });

  it("a FAILURE a stranger wrote with junk results under the committee's name: the hand re-run's simulation refuses it; --from-tx with an honest attempt goes", async () => {
    const w = world();
    const m = failedBatch(w, 1n, { fail: { ccvs: [COMMITTEE], results: ["0xdeadbeef"] } });
    const r = await hand(w, { id: m.id, send: true });
    expect([r.code, r.lines.at(-1)]).toEqual([1, "Not sent: its simulation refuses it: the committee's results were refused (InvalidVerifierResults()): try --from-tx with a later honest attempt"]);
    expect(w.sends).toEqual([]);
    // Chainlink's executor's own attempt (it reverted from FAILURE, so it left no log; its calldata is public)
    const honest = attemptInWorld(w, "Base → Bittensor", m);
    const x = await hand(w, { id: m.id, fromTx: honest, send: true });
    expect(x.code).toBe(0);
    expect(executes(w)).toEqual([{ to: lower(ADDR.offRampBittensor), chain: "bittensor", args: [m.encoded, [COMMITTEE], [committeeResult(m.id)], 1_350_000] }]);
    expect(w.messageStates[lower(m.id)]).toBe(2);
  });

  it("with the setting on, the keeper's own re-execution of that junk-written FAILURE is refused too (back-off, nothing sent)", async () => {
    const w = world();
    failedBatch(w, 1n, { fail: { ccvs: [COMMITTEE], results: ["0xdeadbeef"] } });
    const r = await rounds(w, 3, { dep: AUTO });
    expect(executes(w)).toEqual([]);
    expect(r.lines).toContainEqual(expect.stringMatching(/^HELD: re-executing bridge message .*: its simulation refuses it: the committee's results were refused \(InvalidVerifierResults\(\)\): try --from-tx/));
  });
});

describe("a mismatched rebuild refuses: never simulated or sent, said once", () => {
  async function refused(make: (w: World) => void, why: RegExp) {
    for (const dep of [d, AUTO]) {
      const w = world();
      make(w);
      const r = await rounds(w, 12, { dep });
      expect([executes(w), simulations(w)]).toEqual([[], []]);
      const lines = r.lines.filter((l) => l.startsWith("REEXEC REFUSED"));
      expect(lines, r.lines.join("\n")).toHaveLength(1);
      expect(lines[0]).toMatch(why);
    }
  }
  it("the OnRamp's bytes don't hash to the failed message's id", () =>
    refused((w) => failedBatch(w, 1n, { encodedLogged: laneMessage("Base → Bittensor", { recipient: ADDR.vault, sender: ADDR.frontDoor, message: "0x02" }, { number: 9n }).encoded }), /hash to 0x[0-9a-f]{64}, not the message id/));
  it("it is not for Cascade's adapter (its CCIP receiver)", () => refused((w) => failedBatch(w, 1n, { over: { receiver: STRANGER.toLowerCase() as Hex } }), /it is not for Cascade's adapter/));
  it("its payload runs from a stranger, though its Sent names the door", () =>
    refused((w) => failedBatch(w, 1n, { over: { data: laneMessage("Base → Bittensor", { recipient: ADDR.vault, sender: STRANGER, message: "0x03" }).message.data } }), /its payload runs from 0x[0-9a-fA-F]{40} to/));
  it("it carries another amount than its Sent", () => refused((w) => failedBatch(w, 1n, { sentAmount: 2n * TAO }), /it carries 1000000000000000000 wei of the token, not the 2000000000000000000/));
});

describe("Task 65: a stranger's empty-proof FAILURE (the T61a review's I-1): no lane held, the committee's results from elsewhere, never sent empty", () => {
  const EMPTY_FAIL = { ccvs: [COMMITTEE], results: ["0x" as Hex], err: offRampError("InboundImplementationNotFound", [COMMITTEE, "0x"]) };
  const iso = (s: number) => new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ");

  it("the failing attempt, read: committee results refused inside the OffRamp, or none carried, never reached Cascade's receiver; a receiver's or a pool's failure did; what can't be told counts as reached", () => {
    const encoded = failedBatch(world(), 1n, { fail: false }).encoded;
    const call = (results: Hex[], to: Address = ADDR.offRampBittensor) => ({ to, input: encodeFunctionData({ abi: OFFRAMP_EXECUTE, functionName: "execute", args: [encoded, results.map(() => COMMITTEE), results, 0] }) });
    const off = ADDR.offRampBittensor;
    // the OffRamp's own refusals of the proof, by the error it logged
    for (const err of [offRampError("InboundImplementationNotFound", [COMMITTEE, "0x"]), offRampError("RequiredCCVMissing", [COMMITTEE]), offRampError("InvalidVerifierResults"), offRampError("WrongNumberOfSignatures")]) {
      expect(neverReachedReceiver(err, call([committeeResult(keccak256(encoded))]), off), err).toMatch(/^the OffRamp refused its committee results \(.*\) before it called Cascade's receiver$/);
    }
    // no results at all, whatever the error says (a decode of empty bytes reverts with no data)
    expect(neverReachedReceiver("0x", call(["0x"]), off)).toBe("it carried no committee results (1 empty)");
    expect(neverReachedReceiver(undefined, call(["0x", "0x00"]), off)).toBe("it carried no committee results (2 empty)");
    // the receiver or the pool was reached, or failed: today's rule
    expect(neverReachedReceiver(offRampError("ReceiverError", ["0x"]), call(["0x"]), off)).toBeUndefined();
    expect(neverReachedReceiver(offRampError("TokenHandlingError", [COMMITTEE, "0x"]), call([committeeResult(keccak256(encoded))]), off)).toBeUndefined();
    // out of gas with real-looking results, an attempt through a contract, or nothing read: can't tell
    expect(neverReachedReceiver("0x", call([committeeResult(keccak256(encoded))]), off)).toBeUndefined();
    expect(neverReachedReceiver("0x", call(["0x"], STRANGER), off)).toBeUndefined();
    expect(neverReachedReceiver(undefined, null, off)).toBeUndefined();
  });

  it("in the round: an empty-proof FAILURE holds no lane, closes go on past half an hour; it is reported with what it is and the hand command", async () => {
    const w = world();
    const m = failedBatch(w, 1n, { fail: EMPTY_FAIL });
    w.door.start = BigInt(T - 90_000);
    w.fate = (c) => {
      if (c.fn === "closeBatch") w.door.id++;
      return "mine";
    };
    const r = await rounds(w, 40);
    expect(w.sends.filter((s) => s.fn === "closeBatch")).toHaveLength(40);
    expect(r.lines.filter((l) => l.includes("wait (closing the batch)"))).toEqual([]);
    const reports = r.lines.filter((l) => l.startsWith("CCIP FAILURE:"));
    expect(reports).toEqual([
      `CCIP FAILURE: bridge message ${lower(m.id)} (Base → Bittensor) is in FAILURE on Bittensor's OffRamp (first seen under a minute ago, at ${iso(T)} UTC). The keeper doesn't re-execute it by itself. Its failing attempt never reached Cascade's receiver (the OffRamp refused its committee results (InboundImplementationNotFound(${COMMITTEE}, 0x)) before it called Cascade's receiver): a stranger's empty or junk proof, most likely (anyone may call the OffRamp). The lane does not wait for it until 8 h 30 min after it was first seen (Chainlink's docs say its executor retries a FAILURE for up to 8 hours; the canary checks it): new closes and the migration notice's flush toward Bittensor go on meanwhile. If it is still open, re-execute it with the committee's results. Check it with: pnpm ops reexec ${lower(m.id)} --live, then send it with: pnpm ops reexec ${lower(m.id)} --live --send`,
    ]);
    // the payout lane too: an empty attempt with no error data
    const v = world();
    const payload = { recipient: ADDR.frontDoor, sender: ADDR.vault, message: padHex("0x02", { size: 64 }) };
    const pm = laneMessage("Bittensor → Base", payload, { amount: 2n * TAO, number: 2n, gas: 300_000 });
    sendInWorld(v, "Bittensor → Base", pm, payload, { block: 9_002n });
    failInWorld(v, "Bittensor → Base", pm, { ccvs: [COMMITTEE], results: ["0x"], err: "0x" });
    const memory = freshMemory();
    memory.tick = 1;
    const { deps } = depsFor(v, memory, d);
    await reexecV32(deps, memory, { now: T * 1000 });
    memory.tick = 35;
    expect(await reexecV32(deps, memory, { now: (T + 31 * 60) * 1000 })).toEqual({});
  });

  it("R5 Minor 1: the exemption lasts the executor's window, 8 h 30 min from first seen: at 2 h the lane still goes; at 9 h it waits as for any FAILURE, and the line says why", async () => {
    expect(OUTSIDE_WAIT_MS).toBe(8.5 * 3_600_000);
    const w = world();
    const m = failedBatch(w, 1n, { fail: EMPTY_FAIL });
    const lines: string[] = [];
    const memory = freshMemory();
    const { deps } = depsFor(w, memory, d, (l) => lines.push(l));
    const pass = async (minutes: number, tick: number) => {
      memory.tick = tick;
      return reexecV32(deps, memory, { now: (T + minutes * 60) * 1000 });
    };
    expect(await pass(0, 1)).toEqual({});
    expect(await pass(120, 5)).toEqual({});
    const late = await pass(540, 10);
    expect(late?.laneWaits).toEqual({ "Base → Bittensor": `bridge message ${m.id.slice(0, 10)}… has been in CCIP FAILURE for 9 h (see CCIP FAILURE above)` });
    const last = lines.filter((l) => l.startsWith("CCIP FAILURE:")).at(-1);
    expect(last).toContain(
      "Its failing attempt never reached Cascade's receiver (the OffRamp refused its committee results (InboundImplementationNotFound(",
    );
    expect(last).toContain("But it is still in FAILURE 8 h 30 min after it was first seen, past the window Chainlink's docs give its executor: new closes and the migration notice's flush toward Bittensor wait until it is delivered.");
  });

  it("R5 Minor 7: a failing attempt whose transaction can't be read is read again at the next pass, never kept as can't tell", async () => {
    const w = world();
    // no decodable error: the calldata decides
    const m = failedBatch(w, 1n, { fail: { ...EMPTY_FAIL, err: "0x" } });
    const memory = freshMemory();
    const { deps } = depsFor(w, memory, d);
    const real = deps.transactionOf.bind(deps);
    let reads = 0;
    deps.transactionOf = async (chain, hash) => {
      reads++;
      if (reads === 1) throw new Error("the node did not answer");
      return real(chain, hash);
    };
    memory.tick = 1;
    await reexecV32(deps, memory, { now: T * 1000 });
    memory.tick = 5;
    await reexecV32(deps, memory, { now: (T + 5 * 60) * 1000 });
    expect(reads).toBe(2);
    memory.tick = 35;
    expect(await reexecV32(deps, memory, { now: (T + 31 * 60) * 1000 })).toEqual({});
    void m;
  });

  it("a FAILURE whose attempt reached the receiver keeps today's rule (the lane waits after half an hour); so does one whose attempt can't be found", async () => {
    const makers = [
      (w: World) => failedBatch(w, 1n),
      (w: World) => {
        const n = failedBatch(w, 1n, { fail: false });
        w.messageStates[lower(n.id)] = FAILURE;
        return n;
      },
    ];
    for (const make of makers) {
      const w = world();
      const m = make(w);
      const memory = freshMemory();
      memory.tick = 1;
      const { deps } = depsFor(w, memory, d);
      await reexecV32(deps, memory, { now: T * 1000 });
      memory.tick = 35;
      expect((await reexecV32(deps, memory, { now: (T + 31 * 60) * 1000 }))?.laneWaits).toEqual({ "Base → Bittensor": `bridge message ${m.id.slice(0, 10)}… has been in CCIP FAILURE for 31 min (see CCIP FAILURE above)` });
    }
  });

  it("pnpm ops reexec after an empty-proof FAILURE: the committee's results from Chainlink's CCIP API (execution-inputs), checked against the rebuilt bytes and the lane's OffRamp; delivered", async () => {
    const w = world();
    const m = failedBatch(w, 1n, { fail: EMPTY_FAIL });
    const asked: Hex[] = [];
    const api =
      (over: Record<string, unknown> = {}) =>
      async (id: Hex) => {
        asked.push(id);
        return { inputs: { offramp: ADDR.offRampBittensor.toLowerCase(), encodedMessage: m.encoded, verifierAddresses: [COMMITTEE], ccvData: [committeeResult(m.id)], verificationComplete: true, ...over } };
      };
    const dry = await hand(w, { id: m.id, executionInputs: api() });
    expect(dry.code).toBe(0);
    expect(asked).toEqual([lower(m.id)]);
    expect(dry.lines).toContain(
      `Checked: in FAILURE now; its bytes rebuilt; 1 committee result from Chainlink's CCIP API (https://api.ccip.chain.link/v2/messages/${lower(m.id)}/execution-inputs), covering what the OffRamp requires; a 1,350,000 gas limit (its own is 900,000). Its simulation passes: it would be delivered.`,
    );
    const sent = await hand(w, { id: m.id, executionInputs: api(), send: true });
    expect(sent.code).toBe(0);
    expect(executes(w)).toEqual([{ to: lower(ADDR.offRampBittensor), chain: "bittensor", args: [m.encoded, [COMMITTEE], [committeeResult(m.id)], 1_350_000] }]);
    expect(w.messageStates[lower(m.id)]).toBe(2);
    // the API's answer checked: other bytes, another OffRamp, results missing or empty, or not complete: refused, nothing sent
    const v = world();
    const n = failedBatch(v, 1n, { fail: EMPTY_FAIL });
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ encodedMessage: failedBatch(v, 2n, { fail: false }).encoded }, /its encoded message is not this message's rebuilt bytes/],
      [{ offramp: STRANGER }, /it names the OffRamp 0x[0-9a-fA-F]{40}, not Bittensor's 0x[0-9a-fA-F]{40}/],
      [{ ccvData: [] }, /it carries 1 committee and 0 results/],
      [{ ccvData: ["0x"] }, /it carries an empty committee result/],
      [{ verificationComplete: false }, /it says the committee's verification is not complete yet \(verificationComplete false\): try again later/],
    ];
    for (const [over, why] of cases) {
      const x = await hand(v, { id: n.id, executionInputs: api(over), send: true });
      expect([x.code, x.lines.at(-1)], JSON.stringify(over)).toEqual([1, expect.stringMatching(why)]);
    }
    const down = await hand(v, { id: n.id, executionInputs: async () => ({ problem: "the CCIP API answered 503 Service Unavailable" }), send: true });
    expect(down.lines.at(-1)).toMatch(/^Not sent: the attempt that wrote its FAILURE \(transaction 0x[0-9a-f]{64}\) carried no committee results, and Chainlink's CCIP API gave none \(the CCIP API answered 503 Service Unavailable\): .*--from-tx <hash>.*--proof <file \| 0x…>/);
    expect(v.sends).toEqual([]);
  });

  it("never sends empty committee results: the attempt's, --from-tx's, or a proof's empty result is refused before any simulation, saying where the results come from", async () => {
    const w = world();
    const m = failedBatch(w, 1n, { fail: EMPTY_FAIL });
    const plain = await hand(w, { id: m.id, send: true });
    expect([plain.code, plain.lines.at(-1)]).toEqual([
      1,
      `Not sent: the attempt that wrote its FAILURE (transaction ${m.tx}) carried no committee results (a stranger's, most likely): take them from Chainlink's CCIP API (https://api.ccip.chain.link/v2/messages/${lower(m.id)}/execution-inputs; pnpm ops reexec reads it on this PC), from another attempt that carries them (--from-tx <hash>), or give them with --proof <file | 0x…>`,
    ]);
    const empty = attemptInWorld(w, "Base → Bittensor", m, { results: ["0x"] });
    expect((await hand(w, { id: m.id, fromTx: empty, send: true })).lines.at(-1)).toMatch(
      /^Not sent: the committee's results in transaction 0x[0-9a-f]{64} hold an empty result \(for 0x[0-9a-fA-F]{40}\): the OffRamp would only refuse them; never sent empty/,
    );
    const file = parseProofFile(JSON.stringify({ ccvs: [COMMITTEE], verifierResults: ["0x"] }), "empty.json");
    expect((await hand(w, { id: m.id, proof: file, send: true })).lines.at(-1)).toMatch(/^Not sent: the committee's results in the proof file empty\.json hold an empty result/);
    expect([w.sends, simulations(w)]).toEqual([[], []]);
  });

  it("--proof takes a file (the committees and their results, or the CCIP API's execution-inputs answer) or the hex calldata of another execute of the same message", async () => {
    const w = world();
    const m = failedBatch(w, 1n, { fail: EMPTY_FAIL });
    const calldata = encodeFunctionData({ abi: OFFRAMP_EXECUTE, functionName: "execute", args: [m.encoded, [COMMITTEE], [committeeResult(m.id)], 0] });
    const fromHex = parseProofFile(calldata, calldata);
    expect(fromHex).toMatchObject({ ccvs: [COMMITTEE], verifierResults: [committeeResult(m.id)], encoded: m.encoded });
    const apiFile = parseProofFile(
      JSON.stringify({ offramp: ADDR.offRampBittensor, encodedMessage: m.encoded, verifierAddresses: [COMMITTEE], ccvData: [committeeResult(m.id)], verificationComplete: true }),
      "inputs.json",
    );
    expect(apiFile).toMatchObject({ ccvs: [COMMITTEE], verifierResults: [committeeResult(m.id)], encoded: m.encoded, from: "the proof file inputs.json" });
    for (const proof of [fromHex, apiFile]) expect((await hand(w, { id: m.id, proof })).code).toBe(0);
    // another message's calldata: its bytes are not this message's
    const other = failedBatch(w, 2n, { fail: false });
    const wrong = parseProofFile(encodeFunctionData({ abi: OFFRAMP_EXECUTE, functionName: "execute", args: [other.encoded, [COMMITTEE], [committeeResult(other.id)], 0] }), "0xwrong");
    expect((await hand(w, { id: m.id, proof: wrong, send: true })).lines.at(-1)).toMatch(/^Not sent: the proof 0xwrong executes other bytes than this message's/);
    expect(() => parseProofFile("0x12345678", "0x12345678")).toThrow(/is not the calldata of an OffRamp execute/);
    // the argument: a file, or 0x and hex
    const id = keccak256(toHex("m"));
    expect(parseReexecArgs([id, "--proof", calldata])).toMatchObject({ proofHex: calldata });
    expect(parseReexecArgs([id, "--proof", "p.json"])).toMatchObject({ proofFile: "p.json" });
    expect(reexecHandInput(parseReexecArgs([id, "--proof", calldata]), fromHex).reexec.proof).toBe(fromHex);
    expect(w.sends).toEqual([]);
  });
});

describe("Task 65: pnpm ops reexec <messageId> --empty-proof, the canary's live empty-proof test (runbook 3.5)", () => {
  /** pnpm ops reexec <id> --empty-proof on `w`: its exit code and what it said */
  async function empty(w: World, o: { id: Hex; send?: boolean; live?: boolean }) {
    const lines: string[] = [];
    const { deps, memory } = depsFor(w, freshMemory(), d, (l) => lines.push(l));
    const code = await emptyProofByHand(deps, targetV32(d), memory, { id: o.id, send: o.send ?? false, now: w.time.base * 1000, ...(o.live !== undefined ? { live: o.live } : {}) });
    return { code, lines };
  }

  it("on an untouched message of Cascade's own: says what it would send; with --send, the OffRamp's execute with an empty result for each committee, which writes FAILURE; the keeper's watch then holds no lane", async () => {
    const w = world();
    const m = failedBatch(w, 1n, { fail: false });
    const dry = await empty(w, { id: m.id });
    expect(dry.code).toBe(0);
    expect(dry.lines).toEqual([
      `Bridge message ${lower(m.id)}: Cascade's own, Base → Bittensor, sent at block 9001 on Base.`,
      `Checked: untouched now; its bytes rebuilt; the 1 committee the OffRamp requires (${COMMITTEE}), each given an empty result. Its simulation passes: the OffRamp would write FAILURE without calling Cascade's receiver.`,
      `Nothing sent. To send it: pnpm ops reexec ${lower(m.id)} --empty-proof --live --send`,
    ]);
    expect(w.sends).toEqual([]);
    const sent = await empty(w, { id: m.id, send: true });
    expect(sent.code).toBe(0);
    expect(executes(w)).toEqual([{ to: lower(ADDR.offRampBittensor), chain: "bittensor", args: [m.encoded, [COMMITTEE], ["0x"], 0] }]);
    expect(w.messageStates[lower(m.id)]).toBe(FAILURE);
    expect(sent.lines.at(-1)).toMatch(
      new RegExp(
        `^Done \\(transaction 0x[0-9a-f]{64}\\): bridge message ${lower(m.id)} is in FAILURE, written by this empty proof\\. Watch whether Chainlink's executor delivers it \\(its docs say it retries a FAILURE for up to 8 hours\\): pnpm ops reexec ${lower(m.id)} --live reads its state\\. If it is still in FAILURE at .* UTC \\(2 hours from now\\), recover it with: pnpm ops reexec ${lower(m.id)} --live --send$`,
      ),
    );
    // the keeper's watch: the FAILURE its own empty proof wrote holds no lane
    const memory = freshMemory();
    memory.tick = 1;
    const lines: string[] = [];
    const { deps } = depsFor(w, memory, d, (l) => lines.push(l));
    await reexecV32(deps, memory, { now: T * 1000 });
    memory.tick = 35;
    expect(await reexecV32(deps, memory, { now: (T + 31 * 60) * 1000 })).toEqual({});
    expect(lines.filter((l) => l.startsWith("CCIP FAILURE:"))).toEqual([expect.stringContaining("Its failing attempt never reached Cascade's receiver (the OffRamp refused its committee results (InvalidVerifierResults()) before it called Cascade's receiver)")]);
  });

  it("refuses anything but an untouched message of Cascade's own on its own lane: a stranger's, an unknown id, one in FAILURE, a delivered one; nothing simulated or sent", async () => {
    const w = world();
    const strangers = laneMessage("Base → Bittensor", { recipient: ADDR.vault, sender: STRANGER, message: "0x01" }, { amount: TAO, number: 3n });
    sendInWorld(w, "Base → Bittensor", strangers, { recipient: ADDR.vault, sender: STRANGER }, { block: 9_003n });
    const failed = failedBatch(w, 4n);
    const done = failedBatch(w, 5n, { fail: false });
    w.messageStates[lower(done.id)] = 2;
    const cases: [Hex, RegExp][] = [
      [strangers.id, /^Not sent: bridge message 0x[0-9a-f]{64} is not one of Cascade's own .*: the keeper never executes it$/],
      [keccak256(toHex("no such message")), /^Not sent: bridge message 0x[0-9a-f]{64} is not one of Cascade's own/],
      [failed.id, /^Not sent: it is already in FAILURE: the test needs a message no one has executed yet \(use the next deposit\)$/],
      [done.id, /^Not sent: it was delivered \(SUCCESS\): the test needs a message no one has executed yet \(use the next deposit\)$/],
    ];
    for (const [id, why] of cases) {
      const r = await empty(w, { id, send: true });
      expect([r.code, r.lines.at(-1)], id).toEqual([1, expect.stringMatching(why)]);
    }
    expect([w.sends, simulations(w)]).toEqual([[], []]);
  });

  it("Chainlink's executor first: the message delivered before the empty proof lands is said, and the test is for the next deposit", async () => {
    const w = world();
    const m = failedBatch(w, 1n, { fail: false });
    // the executor's own execution lands first (the world's chain: our execute then answers SkippedAlreadyExecutedMessage)
    w.fate = (c) => {
      if (c.fn === "execute") w.messageStates[lower(m.id)] = 2;
      return "revert";
    };
    const r = await empty(w, { id: m.id, send: true });
    expect([r.code, r.lines.at(-1)]).toEqual([1, `Not done: Chainlink's executor delivered bridge message ${lower(m.id)} first (SUCCESS): the test did not run; try it with the next deposit`]);
  });

  it("its arguments: --empty-proof takes none of the proof flags (--from-tx, --proof, --gas); cli.ts passes it on", () => {
    const id = keccak256(toHex("m"));
    expect(parseReexecArgs([id, "--empty-proof", "--live", "--send"])).toEqual({ id, emptyProof: true, live: true, send: true });
    expect(reexecHandInput(parseReexecArgs([id, "--empty-proof", "--live"]))).toEqual({ live: true, reexec: { id, send: false, emptyProof: true } });
    for (const extra of [["--from-tx", keccak256(toHex("t"))], ["--proof", "p.json"], ["--gas", "2000000"]]) {
      expect(() => parseReexecArgs([id, "--empty-proof", ...extra]), extra[0]).toThrow(/--empty-proof takes no proof and no gas: it sends empty results, with the message's own gas/);
    }
  });
});
