import { existsSync, mkdtempSync, readdirSync } from "node:fs";
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
    log: () => undefined,
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
  };
  return { ctx, deps, nonce, receipts, sent, sentNonces, effects, dir, recordPath };
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
