import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Hex, numberToHex } from "viem";
import { describe, expect, it } from "vitest";
import { type ChainName, paths, targets, WALLET } from "../src/config.ts";
import { type DeployDeps, deploy, effectPresent } from "../src/deploy.ts";
import { buildPlan } from "../src/plan.ts";
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
