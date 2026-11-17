import { join } from "node:path";
import { type Address, getAddress, type Hex } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { type ChainName, paths, targets } from "../src/config.ts";
import type { Rpc } from "../src/rpc.ts";
import { type BuildRefV32, type BuildV32, freezeBuildV32, type SourceV32, writeBuildV32 } from "../src/v32/build.ts";
import { codeReadBacksV32, expectedRuntimeV32, stripMetadata } from "../src/v32/code.ts";
import type { PlanV32, V32StepId } from "../src/v32/plan.ts";
import { chainIdFor } from "../src/v32/scheduler.ts";
import type { DeploymentRecordV32 } from "../src/v32/deploy.ts";
import { LIVE } from "../src/config.ts";
import {
  differentBuild,
  FM_DEPOSIT,
  FORK_CHAIN_IDS,
  forksWithV32,
  gasLines,
  gasRows,
  NEGATIVES_V32,
  negativeProblems,
  onForks,
  REHEARSAL_CLAIM_GAS,
  rehearsalInputsV32,
  rehearseV32,
} from "../src/v32/rehearse.ts";
import { MEASURED_V32, ROLES_V32_LAUNCH } from "../src/v32/settings.ts";
import { tempDir } from "./v32-chains.ts";
import { planV32, TAO_BOT, YUMA } from "./v32-fixtures.ts";

// Task 61 step 3: `pnpm ops rehearse --v32`. The run itself needs two anvil forks (it is run by hand, and its output kept
// with the task's report); here, offline: its inputs (deploy --v32's, refused the same way before anything starts), the
// three negatives verify must fail (each change made on the frozen build and read back by Task 45's code read-back, which
// must fail for that change and nothing else), and the gas lines.

const CONTRACTS = paths({}).contractsDir;
const SOURCE: SourceV32 = { commit: "c0ffee".padEnd(40, "0"), tree: "7ee".padEnd(40, "0"), dirty: [] };
const IDS = { base: targets({}).rehearsal.base.chainId, bittensor: targets({}).rehearsal.bittensor.chainId };
const KEEPER = getAddress(`0x${"4b".repeat(20)}`);
const ENV = { OPS_DEPLOYMENT: "v3.2-launch", OPS_V32_PRIMARY_HOTKEY: TAO_BOT, OPS_V32_STANDBY_HOTKEY: YUMA, OPS_V32_KEEPER_ADDRESS: KEEPER };

let build: BuildV32;
let ref: BuildRefV32;
let buildsDir: string;
let plan: PlanV32;

beforeAll(async () => {
  const frozen = await freezeBuildV32(CONTRACTS, SOURCE);
  build = frozen.build;
  buildsDir = join(tempDir("rehearse"), "builds");
  ref = writeBuildV32(buildsDir, frozen);
  plan = planV32();
});

/** Bittensor and Base answering each planned address's code from `codes` (by step), nothing elsewhere. */
function chainsWith(p: PlanV32, codes: Record<V32StepId, Hex>): Rpc {
  return {
    async request(chain: ChainName, method: string, params: unknown[]) {
      if (method === "eth_getBalance") return "0x0";
      if (method === "eth_getCode") {
        const at = String(params[0]).toLowerCase();
        const id = (Object.keys(p.addresses) as V32StepId[]).find((k) => p.addresses[k].toLowerCase() === at && p.steps.find((s) => s.id === k)?.chain === chain);
        return id ? codes[id] : "0x";
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

const honestCodes = (p: PlanV32): Record<V32StepId, Hex> => Object.fromEntries(p.steps.map((s) => [s.id, expectedRuntimeV32(build, p, s.id, IDS)])) as Record<V32StepId, Hex>;

describe("pnpm ops rehearse --v32 (Task 61 step 3)", () => {
  it("plans from deploy --v32's inputs, refused the same way before any fork starts, with a stand-in claim gas until it is measured", async () => {
    expect(() => rehearsalInputsV32({ ...ENV, OPS_DEPLOYMENT: "v3-launch" })).toThrow(/set OPS_DEPLOYMENT=v3.2-launch; nothing started/);
    const { OPS_V32_KEEPER_ADDRESS: _k, ...noKeeper } = ENV;
    expect(() => rehearsalInputsV32(noKeeper)).toThrow(/OPS_V32_KEEPER_ADDRESS is not set/);
    const { OPS_V32_STANDBY_HOTKEY: _s, ...noStandby } = ENV;
    expect(() => rehearsalInputsV32(noStandby)).toThrow(/OPS_V32_STANDBY_HOTKEY is not set/);
    const i = rehearsalInputsV32(ENV);
    expect(i.roles).toEqual({ ...ROLES_V32_LAUNCH, keeper: KEEPER });
    expect(i.roles.guardian).not.toBe(i.roles.owner);
    expect(i.validators).toEqual({ primary: TAO_BOT, standby: YUMA });
    expect(i.poolFloors).toEqual(MEASURED_V32.poolFloors);
    // Task 65 set the launch value (55,000,000): the rehearsal plans with it, no stand-in
    expect(MEASURED_V32.claimGasRequired).toBe(55_000_000n);
    expect(i).toMatchObject({ claimGasRequired: 55_000_000n, claimGasStandIn: false });
    const launch = MEASURED_V32.claimGasRequired;
    delete MEASURED_V32.claimGasRequired;
    try {
      expect(rehearsalInputsV32(ENV)).toMatchObject({ claimGasRequired: REHEARSAL_CLAIM_GAS, claimGasStandIn: true });
    } finally {
      MEASURED_V32.claimGasRequired = launch;
    }
    const floors = MEASURED_V32.poolFloors;
    delete MEASURED_V32.poolFloors;
    try {
      expect(() => rehearsalInputsV32(ENV)).toThrow(/pool floors are not in .*MEASURED_V32 yet \(pnpm ops pool-floors measures them\); nothing started/);
    } finally {
      MEASURED_V32.poolFloors = floors;
    }
    // refused before a fork is started: no anvil, nothing logged
    const lines: string[] = [];
    await expect(rehearseV32({ ...ENV, OPS_DEPLOYMENT: "v3-x" }, (l) => lines.push(l))).rejects.toThrow(/nothing started/);
    expect(lines).toEqual([]);
    // the FM-TAO deposit is the chain's minimum stake, a whole number of rao
    expect(FM_DEPOSIT).toBe(2n * 10n ** 15n);
    expect(FM_DEPOSIT % 10n ** 9n).toBe(0n);
  });

  it("keeps the live chain ids on its forks (runbook section 6), so the call files carry them, the record on disk a rehearsal's", () => {
    expect(FORK_CHAIN_IDS).toEqual({ base: LIVE.base.CHAIN_ID, bittensor: LIVE.bittensor.CHAIN_ID });
    const rec = { target: "rehearsal", createdAt: "", plan, build: ref, done: {} } as DeploymentRecordV32;
    expect(chainIdFor(rec, "base")).toBe(31337);
    const view = onForks(rec);
    expect(chainIdFor(view, "base")).toBe(8453);
    expect(chainIdFor(view, "bittensor")).toBe(964);
    expect({ ...view, target: "rehearsal" }).toEqual(rec);
    expect(rec.target).toBe("rehearsal");
  });

  it("differentBuild changes one byte of a library's code, in its runtime and in the copy its creation code carries, never a metadata, link or immutable byte", () => {
    const { build: other, at } = differentBuild(build, "CascadeBatchLib");
    const c = build.contracts.CascadeBatchLib;
    const o = other.contracts.CascadeBatchLib;
    const diff = (a: string, b: string) => [...Array(a.length / 2).keys()].filter((i) => a.slice(2 + 2 * i, 4 + 2 * i) !== b.slice(2 + 2 * i, 4 + 2 * i));
    expect(diff(c.deployedBytecode.object, o.deployedBytecode.object)).toEqual([at]);
    expect(diff(c.bytecode.object, o.bytecode.object)).toHaveLength(1);
    expect(stripMetadata(o.deployedBytecode.object)).not.toBe(stripMetadata(c.deployedBytecode.object));
    for (const ranges of Object.values(c.deployedBytecode.immutableReferences)) for (const r of ranges) expect(at < r.start || at >= r.start + r.length).toBe(true);
    // every other contract is the build's own
    for (const name of Object.keys(build.contracts)) if (name !== "CascadeBatchLib") expect(other.contracts[name]).toBe(build.contracts[name]);
  });

  it("each negative fails Task 45's code read-back for its change and nothing else, and the honest deployment passes it", async () => {
    const ctx = (p: PlanV32, codes: Record<V32StepId, Hex>) => ({ rpc: chainsWith(p, codes), targets: targets({}).rehearsal });
    const rec = { plan, build: ref };
    const honest = honestCodes(plan);
    expect((await codeReadBacksV32(ctx(plan, honest), rec, buildsDir)).failures).toEqual([]);
    const otherL1: Address = getAddress(`0x${"1a".repeat(20)}`);
    const otherVault: Address = getAddress(`0x${"7f".repeat(20)}`);
    // the vault linked to otherL1: the plan's L1 address replaced at each of its references (it appears nowhere else)
    const planned = plan.addresses.batchLib.slice(2).toLowerCase();
    expect(honest.vault.split(planned).length - 1).toBe(Object.values(build.contracts.CascadeVault.deployedBytecode.linkReferences).flatMap((l) => l.CascadeBatchLib ?? []).length);
    const relinked = honest.vault.replaceAll(planned, otherL1.slice(2).toLowerCase()) as Hex;
    const tampered: Record<(typeof NEGATIVES_V32)[number]["id"], Record<V32StepId, Hex>> = {
      "l1-different-build": { ...honest, batchLib: expectedRuntimeV32(differentBuild(build, "CascadeBatchLib").build, plan, "batchLib", IDS) },
      "l1-other-address": { ...honest, vault: relinked },
      "lens-wrong-target": { ...honest, vaultLens: expectedRuntimeV32(build, { ...plan, addresses: { ...plan.addresses, vault: otherVault } }, "vaultLens", IDS) },
    };
    expect(NEGATIVES_V32.map((n) => n.id)).toEqual(["l1-different-build", "l1-other-address", "lens-wrong-target"]);
    for (const neg of NEGATIVES_V32) {
      const { failures } = await codeReadBacksV32(ctx(plan, tampered[neg.id]), rec, buildsDir);
      expect(failures.length).toBeGreaterThan(0);
      expect(negativeProblems(neg, failures)).toEqual([]);
    }
    // the check itself: a pass, a missing line, a failure for another reason
    const [n1] = NEGATIVES_V32;
    expect(negativeProblems(n1, [])).toEqual([expect.stringMatching(/^verify passed a vault linked to an L1/), expect.stringMatching(/^verify did not say/)]);
    expect(negativeProblems(n1, ["Bittensor CascadeBatchLib: its runtime code is not the frozen build's, filled in from the plan: they first differ at byte 9", "Bittensor CcipBittensorAdapter: its token cushion is not funded"])).toEqual([
      "verify failed for another reason too: Bittensor CcipBittensorAdapter: its token cushion is not funded",
    ]);
    // a lens bound to another vault reads that vault's bridges, so the rails (read through it) disagree: that is the change
    const rails = "The rails: now the two chains disagree on the bridge: the front door's primary 0xF sends to 0xB on Bittensor, which is not enabled on the vault";
    const lensLine = "Bittensor CascadeVaultLens: its runtime code is not the frozen build's, filled in from the plan: they first differ at byte 1364 (the immutable target)";
    expect(negativeProblems(NEGATIVES_V32[2], [lensLine, rails])).toEqual([]);
    expect(negativeProblems(NEGATIVES_V32[0], ["Bittensor CascadeBatchLib: its runtime code is not the frozen build's, filled in from the plan: they first differ at byte 9", rails])).toEqual([`verify failed for another reason too: ${rails}`]);
  });

  it("gives each create's gas against its ceiling and its constructor's allowance, and each chain's total", () => {
    const done = Object.fromEntries(plan.steps.map((s, i) => [s.id, { hash: "0x", block: 1, gasUsed: 1_000_000n + BigInt(i), costWei: 0n, address: plan.addresses[s.id] }])) as never;
    const rows = gasRows(plan, build, done);
    expect(rows.map((r) => r.step.id)).toEqual(plan.steps.map((s) => s.id));
    for (const r of rows) {
      // the ceiling counts 16 a byte of creation code; the exact count gives the constructor at least that much room
      expect(r.ceiling - r.allowance).toBeGreaterThanOrEqual(r.gasUsed - r.constructor);
    }
    const lines = gasLines(rows, plan);
    expect(lines[1]).toMatch(new RegExp(`^  Bittensor nonce 0: CcipBittensorAdapter at ${plan.addresses.bitAdapter}: 1,000,000 gas \\(ceiling [\\d,]+; constructor -?[\\d,]+ of 1,000,000\\)$`));
    expect(lines.at(-2)).toBe(`  Bittensor in all: ${(8_000_000 + 28).toLocaleString("en-US")} gas`);
    expect(lines.at(-1)).toBe(`  Base in all: ${(5_000_000 + 8 + 9 + 10 + 11 + 12).toLocaleString("en-US")} gas`);
  });
});

describe("forksWithV32: the rehearsal's forks, left running (Task 61 step 5's monitor and stamp drill)", () => {
  it("refuses what the rehearsal refuses before any fork starts, nothing logged", async () => {
    const lines: string[] = [];
    await expect(forksWithV32({ ...ENV, OPS_DEPLOYMENT: "v3-x" }, (l) => lines.push(l))).rejects.toThrow(/nothing started/);
    const { OPS_V32_KEEPER_ADDRESS: _k, ...noKeeper } = ENV;
    await expect(forksWithV32(noKeeper, (l) => lines.push(l))).rejects.toThrow(/OPS_V32_KEEPER_ADDRESS is not set/);
    expect(lines).toEqual([]);
  });

  it("stops the forks it started when bringing them up fails, so no anvil is left behind", async () => {
    let stopped = 0;
    const failing: Rpc = {
      async request() {
        throw new Error("the fork refused");
      },
    };
    const start = async () => ({ ctx: { rpc: failing, paths: paths({}) } as never, stop: () => void stopped++ });
    await expect(forksWithV32(ENV, () => {}, { startForks: start })).rejects.toThrow(/the fork refused/);
    expect(stopped).toBe(1);
  });
});
