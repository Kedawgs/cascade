import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, encodeFunctionResult, type Hex, numberToHex } from "viem";
import { describe, expect, it } from "vitest";
import { loadArtifact } from "../src/artifacts.ts";
import { type ChainName, paths, targets, WALLET } from "../src/config.ts";
import { type DeployDeps, deploy, effectPresent } from "../src/deploy.ts";
import { buildPlan, buildPlanV3 } from "../src/plan.ts";
import { type DeploymentRecord, loadRecord, saveRecord } from "../src/record.ts";
import type { Rpc } from "../src/rpc.ts";
import type { Ctx, Sent } from "../src/send.ts";
import type { PlannedStep, StepId } from "../src/types.ts";

const COLDKEY: Hex = `0x${"22".repeat(32)}`;
const HASH: Hex = `0x${"cd".repeat(32)}`;

function world(start: Record<ChainName, number>, opts: { latest?: Partial<Record<ChainName, number>>; known?: Set<Hex> } = {}) {
  const nonce = { ...start };
  const sentNonces: number[] = [];
  const receipts = new Map<Hex, unknown>();
  const sent: StepId[] = [];
  const logs: string[] = [];
  const effects = new Set<StepId>();
  const dir = mkdtempSync(join(tmpdir(), "ops-deploy-"));
  const recordPath = join(dir, "rec.json");
  const rpc: Rpc = {
    async request(chain, method, params) {
      if (method === "eth_getTransactionCount") {
        return numberToHex(params[1] === "latest" ? (opts.latest?.[chain] ?? nonce[chain]) : nonce[chain]);
      }
      if (method === "eth_getTransactionByHash") return opts.known?.has(params[0] as Hex) ? { hash: params[0] } : null;
      if (method === "eth_getTransactionReceipt") return receipts.get(params[0] as Hex) ?? null;
      throw new Error(`unexpected ${method}`);
    },
  };
  const ctx: Ctx = {
    live: false,
    targets: targets({}).rehearsal,
    rpc,
    runner: { run: async () => ({ code: 1, stdout: "", stderr: "not in tests" }) },
    paths: paths({}),
    log: (l) => void logs.push(l),
    receiptTimeoutMs: 10,
    pollMs: 1,
  };
  const fakeSend = async (step: PlannedStep): Promise<Sent> => {
    // saved after every step: the previous step is already on disk when this one is sent
    const onDisk = loadRecord(recordPath)!;
    const i = onDisk.plan.steps.findIndex((s) => s.id === step.id);
    if (i > 0) expect(onDisk.done[onDisk.plan.steps[i - 1].id]).toBeTruthy();
    sent.push(step.id);
    sentNonces.push(step.nonce);
    nonce[step.chain]++;
    effects.add(step.id);
    return { hash: HASH, block: 1, gasUsed: 21_000n, costWei: 1n };
  };
  const deps: DeployDeps = {
    sendCreate: (_c, req) => fakeSend(req as PlannedStep),
    sendCall: (_c, req) => fakeSend(req as PlannedStep),
    effectPresent: async (_c, _p, step) => effects.has(step.id),
    readColdkey: async () => COLDKEY,
    deployBlock: async () => 777,
  };
  return { ctx, deps, nonce, receipts, sent, sentNonces, effects, dir, recordPath, logs };
}

const ALL: StepId[] = ["baseAdapter", "frontDoor", "bitAdapter", "vault", "adapterReserve", "vaultReserve", "setKeeper", "setPayoutDelay"];

function recordWith(done: StepId[], extra: Partial<DeploymentRecord> = {}): DeploymentRecord {
  const sentStep: Sent = { hash: HASH, block: 1, gasUsed: 21_000n, costWei: 1n };
  return {
    target: "rehearsal",
    wallet: WALLET,
    createdAt: "2026-10-24T00:00:00Z",
    plan: buildPlan(0, 0, COLDKEY),
    done: Object.fromEntries(done.map((id) => [id, sentStep])),
    ...extra,
  };
}

describe("deploy", () => {
  it("deploys every step in order and saves after each", async () => {
    const w = world({ base: 0, bittensor: 0 });
    const rec = await deploy(w.ctx, w.recordPath, { newPlan: false }, w.deps);
    expect(w.sent).toEqual(ALL);
    expect(Object.keys(rec.done)).toEqual(ALL);
    expect(loadRecord(w.recordPath)!.done.setPayoutDelay!).toMatchObject({ gasUsed: 21_000n });
  });

  it("resume skips recorded steps", async () => {
    const w = world({ base: 2, bittensor: 1 });
    saveRecord(w.recordPath, recordWith(["baseAdapter", "frontDoor", "bitAdapter"]));
    await deploy(w.ctx, w.recordPath, { newPlan: false }, w.deps);
    expect(w.sent).toEqual(ALL.slice(3));
  });

  it("resume recovers a landed step whose record was lost", async () => {
    const w = world({ base: 1, bittensor: 0 });
    saveRecord(w.recordPath, recordWith([]));
    w.effects.add("baseAdapter");
    const rec = await deploy(w.ctx, w.recordPath, { newPlan: false }, w.deps);
    expect(w.sent).toEqual(ALL.slice(1));
    expect(rec.done.baseAdapter).toEqual({ recovered: true });
  });

  it("a recovered Bittensor create keeps the block it was created in, where the keeper's log scans start", async () => {
    const w = world({ base: 2, bittensor: 1 });
    saveRecord(w.recordPath, recordWith(["baseAdapter", "frontDoor"]));
    w.effects.add("bitAdapter");
    const asked: string[] = [];
    w.deps.deployBlock = async (_c, chain, address) => (asked.push(`${chain} ${address}`), 9_357_492);
    const rec = await deploy(w.ctx, w.recordPath, { newPlan: false }, w.deps);
    expect(rec.done.bitAdapter).toEqual({ recovered: true, block: 9_357_492 });
    expect(loadRecord(w.recordPath)!.done.bitAdapter).toEqual({ recovered: true, block: 9_357_492 });
    expect(asked).toEqual([`bittensor ${rec.plan.addresses.bitAdapter}`]);
    expect(w.sent).toEqual(ALL.slice(3));
  });

  it("a recovered Bittensor create whose block can't be found stops the run, recording nothing and sending nothing", async () => {
    const w = world({ base: 2, bittensor: 1 });
    saveRecord(w.recordPath, recordWith(["baseAdapter", "frontDoor"]));
    w.effects.add("bitAdapter");
    w.deps.deployBlock = async () => {
      throw new Error("missing trie node");
    };
    await expect(deploy(w.ctx, w.recordPath, { newPlan: false }, w.deps)).rejects.toThrow(
      /deploy the Bittensor bridge adapter is already on-chain, but the block it was created in could not be found \(missing trie node\): that reads old state, so OPS_BITTENSOR_RPC must be an archive node \(the default, archive\.chain\.opentensor\.ai, is one\); nothing sent — run deploy again/,
    );
    expect(loadRecord(w.recordPath)!.done.bitAdapter).toBeUndefined();
    expect(w.sent).toEqual([]);
  });

  it("looks up the block of the Bittensor adapter only: a recovered vault is recorded without one", async () => {
    const w = world({ base: 2, bittensor: 2 });
    saveRecord(w.recordPath, recordWith(["baseAdapter", "frontDoor", "bitAdapter"]));
    w.effects.add("vault");
    w.deps.deployBlock = async () => {
      throw new Error("missing trie node");
    };
    const rec = await deploy(w.ctx, w.recordPath, { newPlan: false }, w.deps);
    expect(rec.done.vault).toEqual({ recovered: true });
    expect(w.sent).toEqual(ALL.slice(4));
  });

  it("finds the block of a Bittensor create recovered by an earlier run that didn't keep it", async () => {
    const w = world({ base: 2, bittensor: 4 });
    saveRecord(w.recordPath, { ...recordWith(ALL.filter((id) => id !== "bitAdapter")), done: { ...recordWith(ALL).done, bitAdapter: { recovered: true } } });
    const rec = await deploy(w.ctx, w.recordPath, { newPlan: false }, w.deps);
    expect(loadRecord(w.recordPath)!.done.bitAdapter).toEqual({ recovered: true, block: 777 });
    expect(rec.done.bitAdapter).toEqual({ recovered: true, block: 777 });
    expect(w.sent).toEqual([]);
  });

  it("a nonce mismatch stops before sending", async () => {
    const w = world({ base: 7, bittensor: 0 });
    saveRecord(w.recordPath, recordWith([]));
    await expect(deploy(w.ctx, w.recordPath, { newPlan: false }, w.deps)).rejects.toThrow(
      /the plan no longer matches the wallet \(nonce 7, expected 0\).*deploy --new-plan/,
    );
    expect(w.sent).toEqual([]);
  });

  it("--new-plan archives the old record and plans from the current nonces", async () => {
    const w = world({ base: 2, bittensor: 3 });
    saveRecord(w.recordPath, recordWith([]));
    const rec = await deploy(w.ctx, w.recordPath, { newPlan: true }, w.deps);
    expect(readdirSync(w.dir).some((n) => /^rec\.abandoned-.*\.json$/.test(n))).toBe(true);
    expect([rec.plan.baseNonce, rec.plan.bitNonce]).toEqual([2, 3]);
    expect(rec.plan.steps[3].args[0]).toBe(COLDKEY);
  });

  it("a transaction still waiting says to run deploy again, not --new-plan", async () => {
    const w = world({ base: 1, bittensor: 0 }, { latest: { base: 0 } });
    saveRecord(w.recordPath, recordWith([]));
    const err = await deploy(w.ctx, w.recordPath, { newPlan: false }, w.deps).catch((e) => e);
    expect(err.message).toMatch(/still waiting to be mined.*run deploy again/);
    expect(err.message).not.toMatch(/new-plan/);
    expect(w.sent).toEqual([]);
  });

  it("an effect check that cannot read stops the run instead of resending", async () => {
    const w = world({ base: 0, bittensor: 0 });
    saveRecord(w.recordPath, recordWith([]));
    w.deps.effectPresent = async () => {
      throw new Error("fetch failed");
    };
    await expect(deploy(w.ctx, w.recordPath, { newPlan: false }, w.deps)).rejects.toThrow(/could not check .*nothing sent/);
    expect(w.sent).toEqual([]);
  });

  it("a configuration step runs at the wallet's current nonce", async () => {
    // a stray Bittensor transaction after the creates: the predicted addresses are safe, so carry on
    const w = world({ base: 2, bittensor: 3 });
    saveRecord(w.recordPath, recordWith(["baseAdapter", "frontDoor", "bitAdapter", "vault"]));
    await deploy(w.ctx, w.recordPath, { newPlan: false }, w.deps);
    expect(w.sent).toEqual(ALL.slice(4));
    expect(w.sentNonces).toEqual([3, 4, 5, 6]);
  });

  it("a create that landed but reads empty for a moment is recovered, not voided", async () => {
    const w = world({ base: 1, bittensor: 0 });
    saveRecord(w.recordPath, recordWith([]));
    let reads = 0;
    const real = w.deps.effectPresent;
    w.deps.effectPresent = async (c, p, step) => (step.id === "baseAdapter" ? reads++ > 0 : real(c, p, step));
    const rec = await deploy(w.ctx, w.recordPath, { newPlan: false }, w.deps);
    expect(rec.done.baseAdapter).toEqual({ recovered: true });
    expect(w.sent).toEqual(ALL.slice(1));
  });

  it("a dropped pending transaction is cleared and its step sent again", async () => {
    const w = world({ base: 1, bittensor: 0 });
    saveRecord(w.recordPath, recordWith(["baseAdapter"], { pending: { step: "frontDoor", chain: "base", nonce: 1, hash: HASH } }));
    const rec = await deploy(w.ctx, w.recordPath, { newPlan: false }, w.deps);
    expect(rec.pending).toBeUndefined();
    expect(w.sent).toEqual(ALL.slice(1));
  });

  it("a pending transaction replaced by another at its nonce is settled from the chain, not left pending forever", async () => {
    // sped up: the node no longer knows the recorded hash, the wallet moved past its nonce, and the step is done
    const sped = world({ base: 2, bittensor: 0 });
    saveRecord(sped.recordPath, recordWith(["baseAdapter"], { pending: { step: "frontDoor", chain: "base", nonce: 1, hash: HASH } }));
    sped.effects.add("frontDoor");
    const rec = await deploy(sped.ctx, sped.recordPath, { newPlan: false }, sped.deps);
    expect(rec.pending).toBeUndefined();
    expect(rec.done.frontDoor).toEqual({ recovered: true });
    expect(sped.sent).toEqual(ALL.slice(2));

    // cancelled: the step's effect is absent and the create's nonce is gone, so the plan is void
    const cancelled = world({ base: 2, bittensor: 0 });
    saveRecord(cancelled.recordPath, recordWith(["baseAdapter"], { pending: { step: "frontDoor", chain: "base", nonce: 1, hash: HASH } }));
    await expect(deploy(cancelled.ctx, cancelled.recordPath, { newPlan: false }, cancelled.deps)).rejects.toThrow(
      /the plan no longer matches the wallet \(nonce 2, expected 1\).*deploy --new-plan/,
    );
    expect(loadRecord(cancelled.recordPath)!.pending).toBeUndefined();
    expect(cancelled.sent).toEqual([]);

    // a replacement still waiting to be mined keeps the run waiting
    const waiting = world({ base: 2, bittensor: 0 }, { latest: { base: 1 } });
    saveRecord(waiting.recordPath, recordWith(["baseAdapter"], { pending: { step: "frontDoor", chain: "base", nonce: 1, hash: HASH } }));
    await expect(deploy(waiting.ctx, waiting.recordPath, { newPlan: false }, waiting.deps)).rejects.toThrow(/still pending/);
    expect(loadRecord(waiting.recordPath)!.pending).toMatchObject({ step: "frontDoor", hash: HASH });
    expect(waiting.sent).toEqual([]);
  });

  it("refuses a record of the other kind of run before archiving or sending anything", async () => {
    const w = world({ base: 0, bittensor: 0 });
    saveRecord(w.recordPath, recordWith([]));
    const live = { ...w.ctx, live: true };
    await expect(deploy(live, w.recordPath, { newPlan: true }, w.deps)).rejects.toThrow(/is a rehearsal record, but this is a --live run; nothing done/);
    expect(readdirSync(w.dir)).toEqual(["rec.json"]);
    expect(w.sent).toEqual([]);

    saveRecord(w.recordPath, { ...recordWith([]), target: "live" });
    await expect(deploy(w.ctx, w.recordPath, { newPlan: true }, w.deps)).rejects.toThrow(/is a live record, but this is a rehearsal/);
    expect(readdirSync(w.dir)).toEqual(["rec.json"]);
    expect(w.sent).toEqual([]);
  });

  it("a pending step blocks the run until its receipt exists", async () => {
    const w = world({ base: 2, bittensor: 0 }, { known: new Set([HASH]) });
    saveRecord(w.recordPath, recordWith(["baseAdapter"], { pending: { step: "frontDoor", chain: "base", nonce: 1, hash: HASH } }));
    await expect(deploy(w.ctx, w.recordPath, { newPlan: false }, w.deps)).rejects.toThrow(/still pending/);
    expect(w.sent).toEqual([]);

    w.receipts.set(HASH, { status: "0x1", blockNumber: "0x5", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null });
    w.effects.add("frontDoor");
    const rec = await deploy(w.ctx, w.recordPath, { newPlan: false }, w.deps);
    expect(rec.pending).toBeUndefined();
    expect(rec.done.frontDoor).toMatchObject({ hash: HASH, block: 5 });
    expect(w.sent).toEqual(ALL.slice(2));
    expect(existsSync(w.recordPath)).toBe(true);
  });
});

describe("effectPresent", () => {
  const plan = buildPlan(0, 0, COLDKEY);
  const step = (id: StepId) => plan.steps.find((s) => s.id === id)!;
  const ctxWith = (request: Rpc["request"]): Ctx => ({ ...world({ base: 0, bittensor: 0 }).ctx, rpc: { request } });

  it("answers no for a contract with no code, and for a setting on a vault not deployed yet", async () => {
    const ctx = ctxWith(async (_c, method) => (method === "eth_getCode" ? "0x" : "0x0"));
    expect(await effectPresent(ctx, plan, step("vault"))).toBe(false);
    expect(await effectPresent(ctx, plan, step("setKeeper"))).toBe(false);
  });

  it("throws when the chain cannot be read, rather than answering no", async () => {
    const ctx = ctxWith(async () => {
      throw new Error("fetch failed");
    });
    await expect(effectPresent(ctx, plan, step("vault"))).rejects.toThrow(/fetch failed/);
  });
});

const V3: StepId[] = [
  "baseAdapter",
  "oracle",
  "frontDoor",
  "staker",
  "fdSetKeeper",
  "fdSetSwapper",
  "fdSetOracle",
  "fdSetMaxBatchValue",
  "stakerSetRoute0",
  "stakerSetDeliveryRoute",
  "stakerSetFees",
  "bitAdapter",
  "vault",
  "adapterReserve",
  "vaultReserve",
  "setKeeper",
  "setPayoutDelay",
  "setRewardCut",
];

describe("deploy v3", () => {
  it("plans a new record with the v3 plan and sends its steps in order", async () => {
    const w = world({ base: 4, bittensor: 9 });
    const rec = await deploy(w.ctx, w.recordPath, { newPlan: false, v3: true }, w.deps);
    expect(rec.plan).toMatchObject({ version: 3, baseNonce: 4, bitNonce: 9 });
    expect(w.sent).toEqual(V3);
    expect(w.sentNonces).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 9, 10, 11, 12, 13, 14, 15]);
    expect(loadRecord(w.recordPath)!.plan).toMatchObject({ version: 3 });
  });

  it("refuses a record of the other version: a v3 record asked to plan v2, and a v2 record asked to plan v3", async () => {
    const w = world({ base: 0, bittensor: 0 });
    await deploy(w.ctx, w.recordPath, { newPlan: false, v3: true }, w.deps);
    await expect(deploy(w.ctx, w.recordPath, { newPlan: false }, w.deps)).rejects.toThrow(/holds a v3 plan.*OPS_DEPLOYMENT/);

    const v2 = world({ base: 0, bittensor: 0 });
    saveRecord(v2.recordPath, recordWith([]));
    await expect(deploy(v2.ctx, v2.recordPath, { newPlan: false, v3: true }, v2.deps)).rejects.toThrow(/holds a v2 plan.*OPS_DEPLOYMENT/);
    expect(v2.sent).toEqual([]);
  });
});

describe("effectPresent v3", () => {
  const plan = buildPlanV3(0, 40, COLDKEY);
  const step = (id: StepId) => plan.steps.find((s) => s.id === id)!;
  const dir = paths({}).contractsDir;
  const abi = ["CascadeFrontDoor", "CascadeStaker", "CascadeVault"].flatMap((n) => loadArtifact(dir, n).abi);
  const route = step("stakerSetRoute0").args[1] as { kind: number; router: Hex; buyPath: Hex; sellPath: Hex; active: boolean };
  const ZERO = "0x0000000000000000000000000000000000000000";
  const configured: Record<string, unknown> = {
    keeper: WALLET,
    swapper: plan.addresses.staker,
    oracle: plan.addresses.oracle,
    maxBatchValue: 10n ** 19n,
    routes: [route.kind, route.router, route.buyPath, route.sellPath, route.active],
    deliveryRouteId: 0,
    swapFeeBps: 15,
    depositFeeUsdc: 50_000n,
    treasury: WALLET,
    rewardCutBps: 1_000,
  };
  const ctxWith = (values: Record<string, unknown>, code: Hex = "0x6080"): Ctx => ({
    ...world({ base: 0, bittensor: 0 }).ctx,
    rpc: {
      async request(_c, method, params) {
        if (method === "eth_getCode") return code;
        if (method !== "eth_call") throw new Error(method);
        const { functionName } = decodeFunctionData({ abi, data: (params[0] as { data: Hex }).data });
        return encodeFunctionResult({ abi, functionName, result: values[functionName] } as never);
      },
    },
  });
  const ids: StepId[] = ["fdSetKeeper", "fdSetSwapper", "fdSetOracle", "fdSetMaxBatchValue", "stakerSetRoute0", "stakerSetFees", "setRewardCut"];

  it("finds each configuration already on-chain", async () => {
    const ctx = ctxWith(configured);
    for (const id of ids) expect(await effectPresent(ctx, plan, step(id)), id).toBe(true);
    expect(await effectPresent(ctx, plan, step("oracle"))).toBe(true);
    expect(await effectPresent(ctx, plan, step("staker"))).toBe(true);
  });

  it("answers no for a contract with no code yet", async () => {
    const ctx = ctxWith(configured, "0x");
    for (const id of [...ids, "oracle", "staker"] as StepId[]) expect(await effectPresent(ctx, plan, step(id)), id).toBe(false);
  });

  it("answers no when any part of a setting differs", async () => {
    const unset: Record<string, unknown> = {
      keeper: ZERO,
      swapper: ZERO,
      oracle: ZERO,
      maxBatchValue: 4_000n * 10n ** 18n,
      routes: [route.kind, route.router, route.buyPath, `${route.buyPath}`, route.active],
      swapFeeBps: 15,
      depositFeeUsdc: 0n,
      treasury: WALLET,
      rewardCutBps: 0,
    };
    const ctx = ctxWith(unset);
    for (const id of ids) expect(await effectPresent(ctx, plan, step(id)), id).toBe(false);
  });

  it("always sends the delivery route: 0 is also its default, so a read cannot tell", async () => {
    expect(await effectPresent(ctxWith(configured), plan, step("stakerSetDeliveryRoute"))).toBe(false);
  });
});

describe("deploy cadence", () => {
  it("plans a new v3 record with the chosen cadence, and a resumed record keeps its own", async () => {
    const w = world({ base: 4, bittensor: 9 });
    const rec = await deploy(w.ctx, w.recordPath, { newPlan: false, v3: true, cadence: "launch" }, w.deps);
    expect(rec.plan).toMatchObject({ version: 3, cadence: "launch" });
    // a later run reads the record, not the option
    const again = await deploy(w.ctx, w.recordPath, { newPlan: false, v3: true, cadence: "test" }, w.deps);
    expect(again.plan).toMatchObject({ cadence: "launch" });
  });

  it("names the cadence when planning a launch record, and leaves the test line as it was", async () => {
    const l = world({ base: 4, bittensor: 9 });
    await deploy(l.ctx, l.recordPath, { newPlan: false, v3: true, cadence: "launch" }, l.deps);
    expect(l.logs).toContain(
      "Planned the v3 deployment (launch cadence: 1-hour batches, 24-hour payout delay) from the wallet's nonces: Base 4, Bittensor 9",
    );
    const t = world({ base: 4, bittensor: 9 });
    await deploy(t.ctx, t.recordPath, { newPlan: false, v3: true, cadence: "test" }, t.deps);
    expect(t.logs).toContain("Planned the v3 deployment from the wallet's nonces: Base 4, Bittensor 9");
  });

  it("says once that OPS_CADENCE=launch is ignored when a test record is resumed", async () => {
    const w = world({ base: 4, bittensor: 9 });
    await deploy(w.ctx, w.recordPath, { newPlan: false, v3: true }, w.deps);
    w.logs.length = 0;
    await deploy(w.ctx, w.recordPath, { newPlan: false, v3: true, cadence: "launch" }, w.deps);
    const ignored = "OPS_CADENCE=launch ignored: the record's cadence is test; use --new-plan to plan anew";
    expect(w.logs.filter((x) => x === ignored)).toHaveLength(1);
    // a launch record resumed under launch, and a test record without it, say nothing
    const q = world({ base: 4, bittensor: 9 });
    await deploy(q.ctx, q.recordPath, { newPlan: false, v3: true, cadence: "launch" }, q.deps);
    await deploy(q.ctx, q.recordPath, { newPlan: false, v3: true, cadence: "launch" }, q.deps);
    expect(q.logs.some((x) => x.includes("ignored"))).toBe(false);
  });

  it("a new v3 record without a cadence has none stored", async () => {
    const w = world({ base: 4, bittensor: 9 });
    const rec = await deploy(w.ctx, w.recordPath, { newPlan: false, v3: true }, w.deps);
    expect("cadence" in rec.plan).toBe(false);
  });
});

describe("deploy and the contracts build a plan was made with", () => {
  const SENT_STEP: Sent = { hash: HASH, block: 1, gasUsed: 21_000n, costWei: 1n };
  /** A v3 record as the a2b4412 build planned it (no `build`), with `done` steps landed. */
  function a2b4412Record(done: StepId[], extra: Partial<DeploymentRecord> = {}): DeploymentRecord {
    const { build: _, ...plan } = buildPlanV3(4, 9, COLDKEY) as ReturnType<typeof buildPlanV3> & { build?: string };
    return { target: "rehearsal", wallet: WALLET, createdAt: "", plan, done: Object.fromEntries(done.map((id) => [id, SENT_STEP])), ...extra };
  }
  const REFUSED = /unfinished v3 plan from an earlier contracts build \(a2b4412\).*deploy --new-plan.*nothing sent/;

  it("a new v3 plan records this build", async () => {
    const w = world({ base: 4, bittensor: 9 });
    const rec = await deploy(w.ctx, w.recordPath, { newPlan: false, v3: true }, w.deps);
    expect(rec.plan).toMatchObject({ version: 3, build: "launch-cadence" });
    expect(loadRecord(w.recordPath)!.plan).toMatchObject({ build: "launch-cadence" });
  });

  it("refuses to resume an unfinished plan from the a2b4412 build: it would mix two builds' contracts", async () => {
    for (const rec of [
      a2b4412Record(["baseAdapter", "oracle"]),
      a2b4412Record([]),
      // every step landed but one still pending
      a2b4412Record(V3.slice(0, -1), { pending: { step: "setRewardCut", chain: "bittensor", nonce: 15, hash: HASH } }),
    ]) {
      const w = world({ base: 6, bittensor: 9 });
      saveRecord(w.recordPath, rec);
      const before = readFileSync(w.recordPath, "utf8");
      await expect(deploy(w.ctx, w.recordPath, { newPlan: false, v3: true }, w.deps)).rejects.toThrow(REFUSED);
      expect(w.sent).toEqual([]);
      expect(readFileSync(w.recordPath, "utf8")).toBe(before);
    }
  });

  it("a finished one has nothing to send; --new-plan archives it and plans anew with this build", async () => {
    const w = world({ base: 15, bittensor: 16 });
    saveRecord(w.recordPath, a2b4412Record(V3));
    const rec = await deploy(w.ctx, w.recordPath, { newPlan: false, v3: true }, w.deps);
    expect(w.sent).toEqual([]);
    expect("build" in rec.plan).toBe(false);

    saveRecord(w.recordPath, a2b4412Record(["baseAdapter"]));
    const fresh = await deploy(w.ctx, w.recordPath, { newPlan: true, v3: true }, w.deps);
    expect(readdirSync(w.dir).some((n) => /^rec\.abandoned-.*\.json$/.test(n))).toBe(true);
    expect(fresh.plan).toMatchObject({ version: 3, build: "launch-cadence", baseNonce: 15, bitNonce: 16 });
    expect(w.sent).toEqual(V3);
  });

  it("refuses to resume a plan from a build this tool does not know", async () => {
    const w = world({ base: 4, bittensor: 9 });
    const rec = a2b4412Record([]);
    saveRecord(w.recordPath, { ...rec, plan: { ...rec.plan, build: "someday" } as DeploymentRecord["plan"] });
    await expect(deploy(w.ctx, w.recordPath, { newPlan: false, v3: true }, w.deps)).rejects.toThrow(/contracts build "someday" this tool does not know/);
    expect(w.sent).toEqual([]);
  });
});
