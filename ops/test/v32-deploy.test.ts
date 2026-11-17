import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type Address,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  type Hex,
  keccak256,
  parseSignature,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  type Signature,
  stringToBytes,
  type TransactionSerializable,
} from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.ts";
import { BASE_V3, LIVE, paths, targets } from "../src/config.ts";
import { refuseV32Record } from "../src/deploy.ts";
import { RunLockHeld, runLockPath, takeRunLock } from "../src/keeper/runlock.ts";
import { buildPlan } from "../src/plan.ts";
import { simulationInputs } from "../src/preflight.ts";
import { loadRecord, saveRecord } from "../src/record.ts";
import { RpcError } from "../src/rpc.ts";
import { createRoute, type Ctx, type Runner, SendRefused, sendCreate, signedTransactionProblem, signTransaction } from "../src/send.ts";
import { encodeSs58 } from "../src/ss58.ts";
import type { CreateRequest } from "../src/types.ts";
import {
  type BuildV32,
  COMPILER_V32,
  creationCodeV32,
  deployDataV32,
  foundryCompiler,
  freezeBuildV32,
  buildIdentityV32,
  linkedLibraries,
  linkLibraries,
  loadBuildV32,
  placeholderOf,
  runtimeCodeV32,
  type SourceV32,
  writeBuildV32,
} from "../src/v32/build.ts";
import {
  CONSTRUCTOR_GAS,
  type DeployDepsV32,
  type DeploymentRecordV32,
  deployV32,
  deployV32FromEnv,
  FRESH_KEYS,
  fundingStepsV32,
  gasCeiling,
  PlanVoid,
  planDifference,
  planShapeV32,
  realDepsV32,
  rehearsalProblem,
  SOURCE_PATHS,
  sourceOf,
} from "../src/v32/deploy.ts";
import { readVault } from "../src/v32/lens.ts";
import { addressMapping, buildPlanV32, CONTRACTS_V32, LINKS_V32, NONCE_PLAN, type PlannedStepV32, type PlanV32, type V32StepId } from "../src/v32/plan.ts";
import { FUNDING_V32, liveGasProblem, MEASURED_V32, ROLES_V32_LAUNCH, SETTINGS_V32_LAUNCH, type SettingsV32, V3_LAUNCH_KEEPER } from "../src/v32/settings.ts";
import { fakeChains, type FakeOpts, type SentTx, SIGNERS, TEST_DEPLOYERS, tempDir, testPlan } from "./v32-chains.ts";
import { TAO_BOT, YUMA } from "./v32-fixtures.ts";
import { artifact, libraryLinks, solConstant } from "./v32-sources.ts";

// Task 44: v3.2 deployed by plain CREATE from fresh keys, Bittensor first (spec §7 step 2; Review Focus 5), every create
// sent from the frozen build, linked by build.ts, the one link path. Every test runs on fake chains (v32-chains.ts):
// nothing is sent, and no keystore, password file or .env is read.

const CONTRACTS = paths({}).contractsDir;
const LIVE_POOLS = { taoWeth: BASE_V3.TAO_WETH_POOL, wethUsdc: BASE_V3.WETH_USDC_POOL };
let build: BuildV32;
let plan: PlanV32;
/** Each step's deploy data and the runtime code its create leaves (immutables 0, as the build has them). */
let runtimeOf: Map<string, Hex>;

/** A placeholder for the v3.2 keeper, a fresh key (never v3-launch's live keeper, never a real account). */
const FRESH_KEEPER = getAddress(`0x${"cee9".repeat(10)}`);

/** deploy --v32's environment: the deployment's name, the deployers' keystores (names only: the fake runner signs),
 * the validators and the keeper's address. */
const ENV_V32 = {
  OPS_DEPLOYMENT: "v3.2-launch",
  OPS_V32_DEPLOYER_BASE_KEYSTORE: SIGNERS.base.keystore,
  OPS_V32_DEPLOYER_BASE_PASSWORD_FILE: SIGNERS.base.passwordFile,
  OPS_V32_DEPLOYER_BITTENSOR_KEYSTORE: SIGNERS.bittensor.keystore,
  OPS_V32_DEPLOYER_BITTENSOR_PASSWORD_FILE: SIGNERS.bittensor.passwordFile,
  OPS_V32_PRIMARY_HOTKEY: TAO_BOT,
  OPS_V32_STANDBY_HOTKEY: YUMA,
  OPS_V32_KEEPER_ADDRESS: FRESH_KEEPER,
};

/** The checkout the fake deps report: a commit, contracts/' tree at it, and nothing under contracts/ that differs. */
const SOURCE: SourceV32 = { commit: "c0ffee".padEnd(40, "0"), tree: "7ee".padEnd(40, "0"), dirty: [] };
const LIVE_IDS = { bittensor: targets({}).live.bittensor.chainId, base: targets({}).live.base.chainId };

beforeAll(async () => {
  build = (await freezeBuildV32(CONTRACTS, SOURCE)).build;
  plan = testPlan();
  runtimeOf = new Map(plan.steps.map((s) => [deployDataV32(build, s), runtimeCodeV32(build, s)]));
});

const step = (p: PlanV32, id: V32StepId): PlannedStepV32 => p.steps.find((s) => s.id === id)!;
const stepOfTx = (p: PlanV32, tx: SentTx): PlannedStepV32 | undefined => p.steps.find((s) => s.chain === tx.chain && deployDataV32(build, s) === tx.data);

/** A run's world: fake chains that leave each create's runtime code, a frozen-builds folder and a record path of its
 * own (the live one with `live`, beside the rehearsal's), and the deps with git and forge's build faked. */
function world(o: FakeOpts = {}, w: { contractsDir?: string; live?: boolean; source?: SourceV32; dir?: string } = {}) {
  const f = fakeChains({ codeFor: (_chain, data) => runtimeOf.get(data) ?? "0x60dead", ...(w.live ? { chainIds: LIVE_IDS } : {}), ...o });
  const dir = w.dir ?? tempDir("deploy");
  const buildsDir = join(dir, "builds");
  const rehearsalPath = join(dir, "rehearsal-v3.2-launch.json");
  const path = w.live ? join(dir, "v3.2-launch.json") : rehearsalPath;
  let built = 0;
  const deps: DeployDepsV32 = {
    ...realDepsV32,
    buildsDir,
    source: async () => w.source ?? SOURCE,
    buildContracts: async () => {
      built++;
    },
  };
  if (w.contractsDir) f.ctx.paths = { ...f.ctx.paths, contractsDir: w.contractsDir };
  if (w.live) Object.assign(f.ctx, { live: true, targets: targets({}).live });
  const run = (p: PlanV32 = plan, opts: { newPlan?: boolean } = {}, ctx: Ctx = f.ctx) => deployV32(ctx, path, p, deps, { signers: SIGNERS, rehearsalPath, ...opts });
  const record = () => loadRecord(path) as unknown as DeploymentRecordV32;
  return { ...f, dir, buildsDir, path, rehearsalPath, deps, run, record, built: () => built };
}

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a failure");
}

/** A copy of the build's planned artifacts and the published vault ABI, to change without touching contracts/. */
function copyOfContracts(): string {
  const to = tempDir("contracts");
  for (const { contract } of Object.values(CONTRACTS_V32)) {
    const [path, name] = contract.split(":");
    mkdirSync(join(to, "out", basename(path)), { recursive: true });
    copyFileSync(join(CONTRACTS, "out", basename(path), `${name}.json`), join(to, "out", basename(path), `${name}.json`));
  }
  // and the artifacts of the files that declare their immutables (a base contract's), whose ASTs name them (Task 45)
  for (const file of new Set(Object.values(build.contracts).flatMap((c) => Object.values(c.immutables).map((v) => v.declaredIn.split(":")[0])))) {
    const dir = join(CONTRACTS, "out", basename(file));
    mkdirSync(join(to, "out", basename(file)), { recursive: true });
    for (const f of readdirSync(dir)) copyFileSync(join(dir, f), join(to, "out", basename(file), f));
  }
  mkdirSync(join(to, "abi"));
  copyFileSync(join(CONTRACTS, "abi", "CascadeVault.json"), join(to, "abi", "CascadeVault.json"));
  copyFileSync(join(CONTRACTS, "foundry.toml"), join(to, "foundry.toml"));
  return to;
}

const editArtifact = (contractsDir: string, name: string, edit: (j: Record<string, unknown>) => void) => {
  const fqn = Object.values(CONTRACTS_V32).find((c) => c.contract.endsWith(`:${name}`))!.contract;
  const file = join(contractsDir, "out", basename(fqn.split(":")[0]), `${name}.json`);
  const j = JSON.parse(readFileSync(file, "utf8"));
  edit(j);
  writeFileSync(file, JSON.stringify(j));
};

/** The byte offsets each library in `refs` sits at. */
const offsetsOf = (refs: Record<string, Record<string, { start: number; length: number }[]>>) =>
  Object.fromEntries(Object.entries(refs).flatMap(([file, libs]) => Object.entries(libs).map(([lib, at]) => [`${file}:${lib}`, at.map((r) => r.start)])));
const at20 = (code: Hex, start: number) => getAddress(`0x${code.slice(2 + start * 2, 2 + start * 2 + 40)}`);

/** The runtime offsets LibraryLinks.sol names for a linking contract (the build's generated link graph). */
function generatedOffsets(fn: string): Record<string, number[]> {
  const src = readFileSync(join(CONTRACTS, "test", "utils", "generated", "LibraryLinks.sol"), "utf8");
  const body = src.match(new RegExp(`function ${fn}\\(\\)[^{]*\\{([\\s\\S]*?)\\n {4}\\}`))![1];
  const out: Record<string, number[]> = {};
  const names = [...body.matchAll(/links\[(\d+)\]\.name = "(\w+)";/g)].map((m) => m[2]);
  for (const m of body.matchAll(/links\[(\d+)\]\.offsets\[\d+\] = (\d+);/g)) (out[names[Number(m[1])]] ??= []).push(Number(m[2]));
  return out;
}

describe("linking: one link path (rulings C1, DB4)", () => {
  it("linkReplacesThePlaceholder: each placeholder becomes the address; a wrong, missing or extra library is refused", () => {
    const a = build.contracts.CascadePayoutLib;
    const math = "src/libraries/CascadePayoutMath.sol:CascadePayoutMath";
    // solc's placeholder: __$ + 34 hex of keccak256("path:Name") + $__
    expect(placeholderOf(math)).toBe(`__$${keccak256(stringToBytes(math)).slice(2, 36)}$__`);
    const refs = a.bytecode.linkReferences;
    for (const start of offsetsOf(refs)[math]) expect(a.bytecode.object.slice(2 + start * 2, 2 + start * 2 + 40)).toBe(placeholderOf(math));
    const lib = getAddress(`0x${"4b".repeat(20)}`);
    const linked = linkLibraries(a.bytecode.object, refs, { [math]: lib });
    expect(linked).not.toContain("__$");
    expect(linked.length).toBe(a.bytecode.object.length);
    for (const start of offsetsOf(refs)[math]) expect(at20(linked, start)).toBe(lib);
    // every other byte is the build's
    let rest = linked.toLowerCase();
    for (const start of offsetsOf(refs)[math]) rest = rest.slice(0, 2 + start * 2) + placeholderOf(math) + rest.slice(2 + start * 2 + 40);
    expect(rest).toBe(a.bytecode.object.toLowerCase());
    expect(() => linkLibraries(a.bytecode.object, refs, {})).toThrow(/missing src\/libraries\/CascadePayoutMath.sol:CascadePayoutMath/);
    expect(() => linkLibraries(a.bytecode.object, refs, { [math]: lib, "src/libraries/CascadeStakeLib.sol:CascadeStakeLib": lib })).toThrow(/not in the code's link set: .*CascadeStakeLib/);
    // an offset that holds no placeholder of that library
    const shifted = { "src/libraries/CascadePayoutMath.sol": { CascadePayoutMath: [{ start: refs["src/libraries/CascadePayoutMath.sol"].CascadePayoutMath[0].start + 1, length: 20 }] } };
    expect(() => linkLibraries(a.bytecode.object, shifted, { [math]: lib })).toThrow(/is not .*CascadePayoutMath's placeholder/);
  });

  it("linksEveryLibraryAtItsPredictedAddress: L3's and the vault's creation and runtime code, at every placeholder offset, the plan's address", () => {
    for (const [id, fn] of [
      ["payoutLib", "cascadePayoutLib"],
      ["vault", "cascadeVault"],
    ] as const) {
      const s = step(plan, id);
      const c = build.contracts[s.contract.split(":")[1]];
      // the libraries the build links, and only those (the plan text's "L3 with L2" is not the build's: Task 43 review M5)
      expect(Object.keys(s.libraries!).sort()).toEqual(linkedLibraries(c.bytecode.linkReferences));
      expect(Object.keys(s.libraries!).map((k) => k.split(":")[1]).sort()).toEqual([...LINKS_V32[id]].map((l) => CONTRACTS_V32[l].contract.split(":")[1]).sort());
      const creation = creationCodeV32(build, s);
      const runtime = runtimeCodeV32(build, s);
      const cOff = offsetsOf(c.bytecode.linkReferences);
      const rOff = offsetsOf(c.deployedBytecode.linkReferences);
      // the runtime offsets are LibraryLinks.sol's, and they are not the creation code's
      const generated = generatedOffsets(fn);
      expect(Object.fromEntries(Object.entries(rOff).map(([k, v]) => [k.split(":")[1], v]))).toEqual(generated);
      expect(cOff).not.toEqual(rOff);
      for (const [lib, starts] of Object.entries(cOff)) for (const start of starts) expect(at20(creation, start), `${id} creation ${lib}@${start}`).toBe(s.libraries![lib]);
      for (const [lib, starts] of Object.entries(rOff)) for (const start of starts) expect(at20(runtime, start), `${id} runtime ${lib}@${start}`).toBe(s.libraries![lib]);
      for (const [lib, address] of Object.entries(s.libraries!)) expect(address).toBe(plan.addresses[(Object.keys(CONTRACTS_V32) as V32StepId[]).find((k) => CONTRACTS_V32[k].contract === lib)!]);
      expect(creation).not.toContain("__$");
      expect(runtime).not.toContain("__$");
    }
    // the vault's constructor calls L4 once more than its runtime code (CascadeHotkeyLib.add): four creation references, three runtime ones
    const v = build.contracts.CascadeVault;
    expect(offsetsOf(v.bytecode.linkReferences)["src/libraries/CascadeHotkeyLib.sol:CascadeHotkeyLib"]).toHaveLength(4);
    expect(offsetsOf(v.deployedBytecode.linkReferences)["src/libraries/CascadeHotkeyLib.sol:CascadeHotkeyLib"]).toHaveLength(3);
  });

  it("sentCodeEqualsTheLinkedArtifact: each create estimates and sends exactly its build's linked creation code and arguments", async () => {
    const w = world();
    await w.run();
    expect(w.sent).toHaveLength(plan.steps.length);
    const estimates = w.calls.filter((c) => c.method === "eth_estimateGas").map((c) => (c.params[0] as { data: Hex }).data);
    plan.steps.forEach((s, i) => {
      const want = deployDataV32(build, s);
      expect(w.sent[i].data, s.id).toBe(want);
      expect(estimates[i], `${s.id}'s estimate`).toBe(want);
    });
    // and the frozen copy is the build in contracts/out, byte for byte
    for (const { contract } of Object.values(CONTRACTS_V32)) {
      const name = contract.split(":")[1];
      const a = artifact(name) as unknown as { bytecode: { object: Hex }; deployedBytecode: { object: Hex } };
      expect(build.contracts[name].bytecode.object, name).toBe(a.bytecode.object);
      expect(build.contracts[name].deployedBytecode.object, name).toBe(a.deployedBytecode.object);
    }
  });
});

describe("sendCreate routes by build (Task 43 review, M3)", () => {
  const v3launch = buildPlan(0, 0, `0x${"11".repeat(32)}`).steps.find((s) => s.id === "bitAdapter") as CreateRequest & { kind: string };

  it("a version-32 request takes v3.2's frozen build, linked, never forge and never ops/builds/preaudit", async () => {
    const f = fakeChains({ codeFor: (_c, data) => runtimeOf.get(data) ?? "0x60dead" });
    const ctx = { ...f.ctx, signer: SIGNERS.bittensor };
    const s = step(plan, "bitAdapter");
    expect(createRoute({ ...s, build, gasCeiling: gasCeiling(build, s) })).toBe("v3.2");
    const sent = await sendCreate(ctx, { ...s, build, gasCeiling: gasCeiling(build, s) }, plan.addresses.bitAdapter);
    expect(sent.address).toBe(plan.addresses.bitAdapter);
    // v3.2's adapter takes a ten-field Config (with treasury); v3-launch's frozen one nine: the bytes are v3.2's
    expect(f.sent[0].data).toBe(deployDataV32(build, s));
    expect(f.sent[0].to).toBeNull();
    expect(f.runs.some((r) => r.file.includes("forge") || r.args.includes("create"))).toBe(false);
    // the transaction is the deployer's, at its planned nonce, on the target chain, legacy on Bittensor
    expect(f.sent[0].from).toBe(TEST_DEPLOYERS.bittensor.address);
    expect(f.sent[0].nonce).toBe(0);
    expect(f.sent[0].chainId).toBe(targets({}).rehearsal.bittensor.chainId);
    expect(f.sent[0].type).toBe("legacy");
  });

  it("a request that cannot be tied to one build is refused before anything is read: v3-launch's never carries libraries", async () => {
    const f = fakeChains();
    const refused = async (req: unknown, why: RegExp) => {
      const e = await failure(sendCreate(f.ctx, req as CreateRequest, plan.addresses.bitAdapter));
      expect(e).toBeInstanceOf(SendRefused);
      expect((e as SendRefused).reason).toBe("build");
      expect(e.message).toMatch(why);
    };
    // v3-launch's create with libraries, or with a build
    await refused({ ...v3launch, libraries: { "src/libraries/CascadePayoutMath.sol:CascadePayoutMath": plan.addresses.payoutMath } }, /cannot be tied to one build/);
    await refused({ ...v3launch, build }, /cannot be tied to one build/);
    // a version other than 32, and a v3.2 step without its build (a plan's step passed as it is)
    await refused({ ...v3launch, version: 3 }, /cannot be tied to one build \(version 3\)/);
    await refused(step(plan, "vault"), /a v3.2 create without v3.2's frozen build/);
    await refused(step(plan, "bitAdapter"), /a v3.2 create without v3.2's frozen build/);
    expect(f.calls).toEqual([]);
    expect(f.runs).toEqual([]);
    // the other direction: a v3-launch create, as its plan has it, stays v3-launch's (forge create from ops/builds/preaudit)
    expect(createRoute(v3launch)).toBe("v3-launch");
    // every v3.2 step carries version 32, so none can reach v3-launch's path
    expect(plan.steps.every((s) => s.version === 32)).toBe(true);
  });

  it("refuses a signature from another key, and a create whose estimate is above its ceiling, sending nothing", async () => {
    const f = fakeChains();
    const s = step(plan, "bitAdapter");
    const wrong = { ...f.ctx, signer: { ...SIGNERS.bittensor, keystore: SIGNERS.base.keystore } };
    const e = await failure(sendCreate(wrong, { ...s, build, gasCeiling: gasCeiling(build, s) }, plan.addresses.bitAdapter));
    expect((e as SendRefused).reason).toBe("signer");
    const g = fakeChains({ estimate: gasCeiling(build, s) + 1n });
    const e2 = await failure(sendCreate({ ...g.ctx, signer: SIGNERS.bittensor }, { ...s, build, gasCeiling: gasCeiling(build, s) }, plan.addresses.bitAdapter));
    expect(e2.message).toMatch(/more than the .* the plan's funding counts for it; nothing sent/);
    // a keystore that answers as the deployer but signs as another key, or gives a high-s signature
    const h = fakeChains();
    const inner = h.ctx.runner;
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const signing = (sign: (hash: Hex) => Promise<Hex>) => ({
      ...h.ctx,
      signer: SIGNERS.bittensor,
      runner: { run: async (file: string, args: string[], o: { cwd: string }) => (args[1] === "sign" ? { code: 0, stdout: await sign(args[3] as Hex), stderr: "" } : inner.run(file, args, o)) },
    });
    const req = { ...s, build, gasCeiling: gasCeiling(build, s) };
    const other = await failure(sendCreate(signing((hash) => TEST_DEPLOYERS.base.sign({ hash })), req, plan.addresses.bitAdapter));
    expect(other.message).toMatch(new RegExp(`the keystore signed as ${TEST_DEPLOYERS.base.address}, not the Bittensor deployer`));
    const highS = async (hash: Hex): Promise<Hex> => {
      const sig = await TEST_DEPLOYERS.bittensor.sign({ hash });
      const sv = N - BigInt(`0x${sig.slice(66, 130)}`);
      const v = sig.slice(130) === "1b" ? "1c" : "1b";
      return `${sig.slice(0, 66)}${sv.toString(16).padStart(64, "0")}${v}` as Hex;
    };
    expect((await failure(sendCreate(signing(highS), req, plan.addresses.bitAdapter))).message).toMatch(/a high-s signature, which nodes refuse; nothing sent/);
    expect([...f.sent, ...g.sent, ...h.sent]).toEqual([]);
  });
});

describe("deployV32: Bittensor first, from fresh keys", () => {
  it("bittensorBeforeBase, adapterFirstOnEachChain, librariesBeforeTheVaultLensesAfterTheirTargets: the order sent", async () => {
    // Task 44's review, M4: each hash is in the saved record when its transaction reaches the node
    let checked = 0;
    const w = world({
      fate: (t) => {
        expect((loadRecord(w.path) as unknown as DeploymentRecordV32).pending?.hashes, `${t.chain} nonce ${t.nonce}`).toContain(t.hash);
        checked++;
        return "mine";
      },
    });
    const rec = await w.run();
    expect(checked).toBe(13);
    const order = w.sent.map((t) => stepOfTx(plan, t)?.id);
    expect(order).toEqual([...NONCE_PLAN.bittensor, ...NONCE_PLAN.base]);
    // every Bittensor create before the first Base one
    const firstBase = w.sent.findIndex((t) => t.chain === "base");
    expect(w.sent.slice(0, firstBase).every((t) => t.chain === "bittensor")).toBe(true);
    expect(w.sent.slice(firstBase).every((t) => t.chain === "base")).toBe(true);
    // the adapter first on each chain (the constructors read its maxMessageValue)
    expect(order[0]).toBe("bitAdapter");
    expect(order[firstBase]).toBe("baseAdapter");
    // the five libraries before the vault; each lens after its target
    const pos = (id: V32StepId) => order.indexOf(id);
    for (const lib of ["payoutMath", "stakeLib", "payoutLib", "batchLib", "hotkeyLib"] as const) expect(pos(lib)).toBeLessThan(pos("vault"));
    expect(pos("payoutMath")).toBeLessThan(pos("payoutLib"));
    expect(pos("vaultLens")).toBeGreaterThan(pos("vault"));
    expect(pos("doorLens")).toBeGreaterThan(pos("frontDoor"));
    // each from its chain's deployer, at its planned nonce, landing at its planned address
    for (const t of w.sent) {
      const s = stepOfTx(plan, t)!;
      expect(t.from).toBe(plan.deployers[s.chain]);
      expect(t.nonce).toBe(s.nonce);
      expect(t.to).toBeNull();
      expect(t.value).toBe(0n);
      expect(t.chainId).toBe(targets({}).rehearsal[s.chain].chainId);
      expect(rec.done[s.id]?.address).toBe(plan.addresses[s.id]);
    }
    expect(w.sent.filter((t) => t.chain === "base").every((t) => t.type === "eip1559" && t.chainId === 31337)).toBe(true);
    expect(w.sent.filter((t) => t.chain === "bittensor").every((t) => t.type === "legacy" && t.chainId === 31338)).toBe(true);
  });

  it("neverDeploysALibraryOutsideThePlan: thirteen creates, each one of the plan's; the libraries exactly the build's link graph; no forge", async () => {
    const w = world();
    await w.run();
    expect(w.sent).toHaveLength(13);
    expect(w.sent.every((t) => stepOfTx(plan, t))).toBe(true);
    const libs = w.sent.map((t) => stepOfTx(plan, t)!).filter((s) => s.contract.startsWith("src/libraries/")).map((s) => s.contract.split(":")[1]);
    // exactly the libraries reachable from the vault in the build's generated link graph
    const graph = libraryLinks();
    const reach = new Set<string>();
    const walk = (n: string) => {
      for (const l of graph[n] ?? []) if (!reach.has(l)) reach.add(l), walk(l);
    };
    walk("CascadeVault");
    expect(libs.sort()).toEqual([...reach].sort());
    // the frozen link set is the plan's
    expect(build.links).toEqual({
      CascadePayoutLib: ["src/libraries/CascadePayoutMath.sol:CascadePayoutMath"],
      CascadeVault: Object.keys(step(plan, "vault").libraries!).sort(),
    });
    // nothing ran forge: no forge create, no forge script, no --libraries
    expect(w.runs.every((r) => r.file.endsWith(process.platform === "win32" ? "cast.exe" : "cast") && r.args[0] === "wallet")).toBe(true);
    expect(w.runs.some((r) => r.args.includes("--libraries"))).toBe(false);
  });

  it("a plan whose links are not the build's is refused before anything is frozen or sent", async () => {
    for (const libraries of [
      { ...step(plan, "vault").libraries, "src/libraries/CascadePayoutMath.sol:CascadePayoutMath": plan.addresses.payoutMath },
      Object.fromEntries(Object.entries(step(plan, "vault").libraries!).slice(1)),
    ]) {
      const w = world();
      const bad = { ...plan, steps: plan.steps.map((s) => (s.id === "vault" ? { ...s, libraries } : s)) };
      const e = await failure(w.run(bad));
      expect(e.message).toMatch(/the plan does not fit the build:[\s\S]*deploy the vault: the code links[\s\S]*nothing frozen or sent/);
      expect(w.sent).toEqual([]);
      expect(existsSync(w.buildsDir)).toBe(false);
      expect(existsSync(w.path)).toBe(false);
    }
  });

  it("a plan whose block times are not the pins in milliseconds (a seconds value, 12 or 2) is refused before anything is read, frozen or sent", async () => {
    for (const [id, v] of [
      ["vault", 12n],
      ["frontDoor", 2n],
    ] as const) {
      const w = world();
      const bad = { ...plan, steps: plan.steps.map((s) => (s.id === id ? { ...s, args: [{ ...(s.args[0] as object), msPerBlock: v }, ...s.args.slice(1)] } : s)) };
      const e = await failure(w.run(bad));
      expect(e.message).toMatch(/^the plan's block times are not the pins:\n/);
      expect(e.message).toContain(`the ${id === "vault" ? "vault" : "front door"}'s msPerBlock is ${v}, not ${id === "vault" ? "Bittensor's pin of 7200" : "Base's pin of 120"} ms`);
      expect(e.message).toMatch(/\nnothing read, frozen or sent$/);
      expect(w.calls).toEqual([]);
      expect(w.sent).toEqual([]);
      expect(existsSync(w.buildsDir)).toBe(false);
      expect(existsSync(w.path)).toBe(false);
    }
  });

  it("refusesANonFreshDeployer: a deployer that has sent anything voids the plan, and nothing is sent on either chain", async () => {
    for (const chain of ["bittensor", "base"] as const) {
      const w = world({ nonces: { [chain]: { latest: 1, pending: 1 } } });
      const e = await failure(w.run());
      expect(e).toBeInstanceOf(PlanVoid);
      expect(e.message).toMatch(new RegExp(`the ${chain === "base" ? "Base" : "Bittensor"} deployer .* has sent 1 transaction, .* it is not a fresh key[\\s\\S]*${FRESH_KEYS}`));
      expect(w.sent).toEqual([]);
      expect(w.record().void?.reason).toMatch(/not a fresh key/);
      // and the record refuses every later run
      expect((await failure(w.run())).message).toMatch(/is void .*fresh keys and a new plan/);
      expect(w.sent).toEqual([]);
    }
  });

  it("refusesAPendingTransactionAtNonceZero: a transaction waiting at nonce 0 stops the run with nothing sent on either chain", async () => {
    for (const chain of ["bittensor", "base"] as const) {
      const w = world({ nonces: { [chain]: { latest: 0, pending: 1 } } });
      const e = await failure(w.run());
      expect(e).not.toBeInstanceOf(PlanVoid);
      expect(e.message).toMatch(/has a transaction waiting at nonce 0 that this record did not sign: it is not a fresh key[\s\S]*Nothing sent on either chain/);
      expect(w.sent).toEqual([]);
    }
  });

  it("a deployer that cannot pay for its creates stops the run with nothing sent, naming what to send", async () => {
    const w = world({ balances: { base: 10n ** 12n } });
    const e = await failure(w.run());
    expect(e.message).toMatch(/the Base deployer .* holds 0.000001 ETH; its 5 creates left can cost up to .* ETH \(the plan's gas at twice today's price, and Base's L1 fee\): send it at least .* ETH more[\s\S]*Nothing sent on either chain/);
    expect(w.sent).toEqual([]);
    // what the plan counts: every create's ceiling at twice the price, and the L1 allowance on Base
    const left = plan.steps.filter((s) => s.chain === "base");
    const ceiling = left.reduce((t, s) => t + gasCeiling(build, s), 0n);
    expect(e.message).toContain(`up to ${Number(ceiling * 10n ** 9n * 2n + 5n * 10n ** 14n) / 1e18} ETH`);
    expect(Object.keys(CONSTRUCTOR_GAS).sort()).toEqual(plan.steps.map((s) => s.id).sort());
  });

  it("the oracle is simulated on Base before Bittensor's first CREATE (Task 43 review, M6): a pool below the oracle's 1,801 observations stops the run", async () => {
    const pool = getAddress("0x82dD34C6631C286cDD1dB16f2c232f60E402Dd5A");
    const tooFew = `0x${keccak256(stringToBytes("TooFewObservations(address,uint16)")).slice(2, 10)}${encodeAbiParameters([{ type: "address" }, { type: "uint16" }], [pool, 1_800]).slice(2)}` as Hex;
    const oracleData = deployDataV32(build, step(plan, "oracle"));
    const w = world({
      simulate: (data) => {
        if (data === oracleData) throw new RpcError("execution reverted", 3, tooFew);
        return "0x6080";
      },
    });
    const e = await failure(w.run());
    expect(e.message).toMatch(new RegExp(`Base: deploy the TWAP oracle, simulated, reverts \\(TooFewObservations\\(${pool}, 1800\\)\\)[\\s\\S]*Nothing sent on either chain`));
    expect(w.sent).toEqual([]);
    // the simulation is the oracle's create itself, from the Base deployer
    const sim = w.calls.find((c) => c.chain === "base" && c.method === "eth_call" && (c.params[0] as { data: Hex }).data === oracleData);
    expect((sim?.params[0] as { from: Address }).from).toBe(plan.deployers.base);
    // and the Base adapter's too; neither once it is done
    expect(w.calls.some((c) => c.chain === "base" && c.method === "eth_call" && (c.params[0] as { data: Hex }).data === deployDataV32(build, step(plan, "baseAdapter")))).toBe(true);
  });

  it("the oracle prices what the door and the staker trade (R3 C-I4): its tokens are theirs, its pools route 0's by fee tier", async () => {
    const w = world({ poolFees: { [LIVE_POOLS.taoWeth.toLowerCase()]: 10_000 } });
    const e = await failure(w.run());
    expect(e.message).toMatch(/the oracle's TAO\/WETH pool .* has the fee tier 10000, not route 0's 3000[\s\S]*Nothing sent on either chain/);
    expect(w.sent).toEqual([]);
    // an oracle on other tokens than the front door's
    const other = getAddress(`0x${"7a".repeat(20)}`);
    const bad = { ...plan, steps: plan.steps.map((s) => (s.id === "oracle" ? { ...s, args: [s.args[0], s.args[1], other, s.args[3], s.args[4]] } : s)) };
    const v = world();
    expect((await failure(v.run(bad))).message).toMatch(/the oracle's TAO 0x7[aA].* is not the front door's asset/);
    expect(v.sent).toEqual([]);
  });

  it("the planned vault's coldkey must be the chain's ADDRESS_MAPPING (DA14), or nothing is sent", async () => {
    const w = world({ coldkey: () => `0x${"0c".repeat(32)}` });
    const e = await failure(w.run());
    expect(e.message).toMatch(/ADDRESS_MAPPING gives the planned vault .* the coldkey 0x0c0c.*, not the plan's .*the vault's CREATE would revert/);
    expect(w.sent).toEqual([]);
  });

  it("stopsAtTheFirstRevertAndNeverContinues: a create that reverts voids the plan; nothing more is sent, now or later", async () => {
    for (const index of [3, 10]) {
      const w = world({ fate: (_t, i) => (i === index ? "revert" : "mine") });
      const e = await failure(w.run());
      expect(e).toBeInstanceOf(PlanVoid);
      expect(e.message).toMatch(new RegExp(`reverted on chain .*its nonce is spent, so every later .* address moves\\. The plan is void: ${FRESH_KEYS}; nothing more is sent`));
      expect(w.sent).toHaveLength(index + 1);
      const rec = w.record();
      expect(rec.void?.reason).toMatch(/reverted on chain/);
      expect(Object.keys(rec.done)).toHaveLength(index);
      expect(rec.pending).toBeUndefined();
      const again = await failure(w.run());
      expect(again).toBeInstanceOf(PlanVoid);
      expect(again.message).toMatch(/plan is void .*fresh keys and a new plan .*nothing sent/);
      expect(w.sent).toHaveLength(index + 1);
    }
  });

  it("addressMismatchStops: a receipt at another address, or with no contract, voids the plan", async () => {
    for (const [fate, why] of [
      ["wrongAddress", /was planned at .*, but its receipt names 0xEeeE/i],
      ["noContractAddress", /its receipt names no contract/],
    ] as const) {
      const w = world({ fate: (_t, i) => (i === 3 ? fate : "mine") });
      const e = await failure(w.run());
      expect(e, fate).toBeInstanceOf(PlanVoid);
      expect(e.message).toMatch(why);
      expect(e.message).toContain(FRESH_KEYS);
      expect(w.sent).toHaveLength(4);
      expect(w.record().void).toBeDefined();
    }
  });

  it("resumeSendsOnlyMissingSteps: after a send the node refused, the next run sends each missing create once", async () => {
    const w = world({ fate: (_t, i) => (i === 5 ? "refuse" : "mine") });
    const e = await failure(w.run());
    expect(e.message).toMatch(/Bittensor: deploy the hotkey library was not sent, as far as the node says .*its hash is kept/);
    // the hash stays (Task 44's review, M2): the next run settles it first, finds it dropped, and signs it again
    expect(w.record().pending).toEqual({ step: "hotkeyLib", chain: "bittensor", nonce: 5, hashes: [w.sent[5].hash] });
    expect(Object.keys(w.record().done)).toEqual(["bitAdapter", "payoutMath", "stakeLib", "payoutLib", "batchLib"]);
    const rec = await w.run();
    expect(Object.keys(rec.done)).toHaveLength(13);
    // each create mined once, in the plan's order; the refused one sent again, nothing else twice
    expect(w.mined().map((t) => stepOfTx(plan, t)!.id)).toEqual(plan.steps.map((s) => s.id));
    expect(w.sent).toHaveLength(14);
    // a finished deployment sends nothing more
    await w.run();
    expect(w.sent).toHaveLength(14);
  });

  it("a create left in the pool is kept by its hash and settled by the next run, never sent twice", async () => {
    let hold = true;
    const w = world({ fate: (_t, i) => (i === 2 && hold ? "hold" : "mine") });
    const e = await failure(w.run());
    expect(e.message).toMatch(/no receipt yet for nonce 2 .*The record keeps its hash: run deploy --v32 again once it is mined/);
    const held = w.sent[2];
    expect(w.record().pending).toEqual({ step: "stakeLib", chain: "bittensor", nonce: 2, hashes: [held.hash] });
    // still in the pool: nothing sent
    expect((await failure(w.run())).message).toMatch(/deploy the unstake library \(nonce 2\), transaction 0x[0-9a-f]+, is still waiting to be mined: .*nothing sent/);
    expect(w.sent).toHaveLength(3);
    hold = false;
    w.mineHeld();
    const rec = await w.run();
    expect(rec.done.stakeLib?.hash).toBe(held.hash);
    expect(w.sent).toHaveLength(13);
    expect(new Set(w.sent.map((t) => t.data)).size).toBe(13);
  });

  it("a create the network dropped is signed again at its nonce, and both hashes are kept until one is mined", async () => {
    let hold = true;
    const w = world({ fate: (_t, i) => (i === 2 && hold ? "hold" : "mine") });
    await failure(w.run());
    w.dropHeld();
    hold = false;
    const rec = await w.run();
    expect(w.logs.some((l) => /the network dropped it; it is signed and sent again/.test(l))).toBe(true);
    expect(w.sent.filter((t) => t.nonce === 2 && t.chain === "bittensor")).toHaveLength(2);
    expect(Object.keys(rec.done)).toHaveLength(13);
  });

  it("refuses to resume when a present step differs from the plan: another plan, code it did not send, code that is not the build's", async () => {
    const w = world({ fate: (_t, i) => (i === 4 ? "refuse" : "mine") });
    await failure(w.run());
    // another plan (other inputs) for the same record
    const other = { ...plan, claimGasRequired: 56_000_000n, steps: plan.steps.map((s) => (s.id === "vault" ? { ...s, args: [{ ...(s.args[0] as object), claimGasRequired: 56_000_000n }] } : s)) };
    expect((await failure(w.run(other))).message).toMatch(/plans another deployment \(plan.claimGasRequired differs\).*nothing sent/);
    // code at a planned address the record did not send
    w.code.base.set(plan.addresses.oracle.toLowerCase(), "0x6001");
    expect((await failure(w.run())).message).toMatch(/where the plan puts deploy the TWAP oracle, already holds code this record did not send: it is not the plan's[\s\S]*Nothing sent on either chain/);
    w.code.base.delete(plan.addresses.oracle.toLowerCase());
    // a step the record has done whose code is not the frozen build's: a real mismatch, which voids the plan
    w.code.bittensor.set(plan.addresses.payoutMath.toLowerCase(), runtimeOf.get(deployDataV32(build, step(plan, "stakeLib")))!);
    const e = await failure(w.run());
    expect(e).toBeInstanceOf(PlanVoid);
    expect(e.message).toMatch(/deploy the payout math library at .* is deployed, but its code is not the frozen build's .*CascadePayoutMath\. The plan is void: fresh keys/);
    expect(w.sent).toHaveLength(5);
    expect(planDifference(plan, JSON.parse(JSON.stringify(plan, (_k, v) => (typeof v === "bigint" ? Number.NaN : v))))).not.toBeNull();
    expect(planDifference(plan, testPlan())).toBeNull();
  });

  it("refuses signers that are not the plan's deployers, and a record of another version", async () => {
    const w = world();
    const e = await failure(deployV32(w.ctx, w.path, plan, w.deps, { signers: { ...SIGNERS, base: { ...SIGNERS.base, address: TEST_DEPLOYERS.bittensor.address } } }));
    expect(e.message).toMatch(/the Base deployer's keystore signs as .*, not the plan's deployer/);
    saveRecord(w.path, { target: "rehearsal", wallet: TEST_DEPLOYERS.base.address, createdAt: "", plan: buildPlan(0, 0, `0x${"11".repeat(32)}`), done: {} });
    expect((await failure(w.run())).message).toMatch(/holds a v2 deployment, not a v3.2 one/);
    expect(() => refuseV32Record(w.path, { plan } as never)).toThrow(/holds a v3.2 plan: deploy it with deploy --v32/);
    expect(w.sent).toEqual([]);
    // an RPC on another chain is refused before anything is read from it
    const v = world();
    const t = v.ctx.targets;
    const e2 = await failure(v.run(plan, {}, { ...v.ctx, targets: { ...t, bittensor: { ...t.bittensor, chainId: 964 } } }));
    expect(e2.message).toMatch(/Bittensor: the RPC reports chain id 31338, expected 964/);
    expect(v.calls.map((c) => c.method)).toEqual(["eth_chainId"]);
  });
});

describe("the frozen build (Task 43a review, M1)", () => {
  it("is written before the first CREATE, its hash in the record; every create is sent from it", async () => {
    let checked = false;
    const w = world({
      fate: (_t, i) => {
        if (i === 0) {
          // at the first broadcast the copy is on disk and the record names it
          const rec = loadRecord(w.path) as unknown as DeploymentRecordV32;
          const file = join(w.buildsDir, rec.build.dir, "build.json");
          expect(existsSync(file)).toBe(true);
          expect(keccak256(stringToBytes(readFileSync(file, "utf8")))).toBe(rec.build.hash);
          expect(rec.build.dir).toBe(`v32-${rec.build.hash.slice(2, 14)}`);
          checked = true;
        }
        return "mine";
      },
    });
    const rec = await w.run();
    expect(checked).toBe(true);
    expect(w.built()).toBe(1);
    expect(loadBuildV32(rec.build, w.buildsDir)).toEqual(build);
    expect(w.logs.some((l) => l.includes(`ops/builds/${rec.build.dir}/build.json`))).toBe(true);
  });

  it("a resumed run sends the frozen copy, not what contracts/out holds now", async () => {
    const contractsDir = copyOfContracts();
    const w = world({ fate: (_t, i) => (i === 3 ? "refuse" : "mine") }, { contractsDir });
    await failure(w.run());
    // contracts/out changes under the record: the vault's creation code
    editArtifact(contractsDir, "CascadeVault", (j) => {
      const b = j.bytecode as { object: string };
      b.object = b.object.replace(/^0x60/, "0x61");
    });
    await w.run();
    const vault = w.sent.find((t) => t.chain === "bittensor" && t.nonce === 6)!;
    expect(vault.data).toBe(deployDataV32(build, step(plan, "vault")));
    expect(w.built()).toBe(1);
  });

  it("a v3.2 record's reads decode with its frozen ABIs, never contracts/out's", async () => {
    const contractsDir = copyOfContracts();
    editArtifact(contractsDir, "CascadeVaultLens", (j) => {
      j.abi = (j.abi as { name?: string }[]).filter((x) => x.name !== "guardian");
    });
    const frozen = await freezeBuildV32(contractsDir);
    const buildsDir = tempDir("builds");
    const ref = writeBuildV32(buildsDir, frozen);
    const absolute = { dir: join(buildsDir, ref.dir), hash: ref.hash };
    const guardian = getAddress(`0x${"9a".repeat(20)}`);
    const reads: { to: string }[] = [];
    const ctx = {
      rpc: {
        async request(_c: string, method: string, params: unknown[]) {
          if (method !== "eth_call") throw new Error(method);
          reads.push(params[0] as { to: string });
          return encodeAbiParameters([{ type: "address" }], [guardian]);
        },
      },
    };
    // the frozen lens has no guardian: refused, nothing read
    await expect(readVault(ctx, { plan, build: absolute }, "guardian")).rejects.toThrow(/neither the vault nor its lens has a getter guardian/);
    expect(reads).toEqual([]);
    // without a record's build (a plan alone) this checkout's lens is read
    expect(await readVault(ctx, { plan }, "guardian")).toBe(guardian);
    expect(reads[0].to).toBe(plan.addresses.vaultLens);
    // with the real build frozen, the lens's guardian is read through the copy
    const real = writeBuildV32(buildsDir, await freezeBuildV32(CONTRACTS));
    expect(await readVault(ctx, { plan, build: { dir: join(buildsDir, real.dir), hash: real.hash } }, "guardian")).toBe(guardian);
    // a copy whose text is not the record's hash is refused
    const file = join(buildsDir, real.dir, "build.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"build": "v3.2"', '"build": "v3.2 "'));
    expect(() => loadBuildV32({ dir: join(buildsDir, real.dir), hash: `0x${"00".repeat(32)}` })).toThrow(/is not the build the deployment's record names/);
    expect(() => writeBuildV32(buildsDir, { text: "{}", hash: real.hash })).toThrow(/is there and is another build/);
  });

  it("refuses a build whose published vault ABI is stale, or whose contract is compiled for another path", async () => {
    const stale = copyOfContracts();
    writeFileSync(join(stale, "abi", "CascadeVault.json"), "[]\n");
    await expect(freezeBuildV32(stale)).rejects.toThrow(/contracts\/abi\/CascadeVault.json is not this build's merge/);
    const moved = copyOfContracts();
    editArtifact(moved, "CascadeStaker", (j) => {
      (j.metadata as { settings: { compilationTarget: object } }).settings.compilationTarget = { "src/Other.sol": "CascadeStaker" };
    });
    await expect(freezeBuildV32(moved)).rejects.toThrow(/was not compiled as src\/CascadeStaker.sol:CascadeStaker/);
  });
});

describe("what deploy --v32 refuses, warns and prints", () => {
  it("--live refuses the adapters' gas models without a measurement record (Task 43 review, M1), reading nothing; Task 65 set the record, so a live deploy no longer refuses for it", async () => {
    // Task 65: the figures are Task 61a's fork measurement, written in by Task 65, and the record says so
    const g = SETTINGS_V32_LAUNCH.gas as SettingsV32["gas"];
    const source = g.source;
    expect(source).toMatch(/Task 61a/);
    expect(source).toMatch(/Task 65/);
    expect(liveGasProblem(source)).toBeNull();
    expect(testPlan().gasSource).toBe(source);
    // without one, a live deploy refuses before reading anything
    delete g.source;
    try {
      const unmeasured = testPlan();
      expect(unmeasured.gasSource).toBeUndefined();
      const w = world();
      const live = { ...w.ctx, live: true, targets: targets({}).live };
      const e = await failure(w.run(unmeasured, {}, live));
      expect(e.message).toMatch(/the adapters' gas models are not measured yet: SETTINGS_V32_LAUNCH.gas has no source, .* Tasks 61, 64 and 65 .*nothing read or sent/);
      expect(w.calls).toEqual([]);
      expect(existsSync(w.path)).toBe(false);
    } finally {
      g.source = source;
    }
    expect(liveGasProblem(undefined)).toMatch(/gas.source|has no source/);
    expect(liveGasProblem("Task 64: testnet 945, block 1,234,567")).toBeNull();
  });

  it("prints the founder's three funding steps, and sends none of them", async () => {
    const w = world();
    await w.run();
    // thirteen creates and nothing else: no transfer, no fundReserve
    expect(w.sent).toHaveLength(13);
    expect(w.sent.every((t) => t.to === null)).toBe(true);
    const lines = fundingStepsV32(plan, false);
    for (const l of lines) expect(w.logs).toContain(l);
    expect(lines.join("\n")).toBe(
      [
        "Now fund it. These three are yours to send; this tool sends none of them:",
        `  1. Send 0.0000015 TAO (1,500,000,000,000 wei) by substrate transfer to the vault's account ${encodeSs58(plan.vaultColdkey)}: its ED_RESERVE, 0.000001 TAO, plus the 0.0000005 TAO Bittensor keeps back. The vault refuses an EVM transfer.`,
        `  2. Call fundReserve() on the Bittensor adapter ${plan.addresses.bitAdapter} with 0.0010005 TAO (1,000,500,000,000,000 wei): its RESERVE_TARGET, 0.001 TAO, plus the same 0.0000005 TAO.`,
        // merge 7b (R4, F-1): the cushion is booked by approve and fundCushion; a plain transfer is surplus, swept
        `  3. Fund the Bittensor adapter ${plan.addresses.bitAdapter}'s token cushion with 0.001 FM-TAO (1,000,000,000,000,000 wei of ${LIVE.bittensor.TOKEN} on Bittensor), its TOKEN_RESERVE_TARGET: approve the adapter for it on that token, then call fundCushion(1000000000000000) on the adapter, from any account that holds it. Never by a plain transfer: that is surplus, and anyone's sweepSurplus() sends it to the treasury.`,
        "Then: pnpm ops verify",
      ].join("\n"),
    );
    expect(fundingStepsV32(plan, true).at(-1)).toBe("Then: pnpm ops verify --live");
    // live, steps 2 and 3 name the call files that send them from the sign page (Task 53's re-review, Minor 2; merge
    // 7b); a fork's have none
    expect(fundingStepsV32(plan, true)[2]).toBe(
      `  2. Call fundReserve() on the Bittensor adapter ${plan.addresses.bitAdapter} with 0.0010005 TAO (1,000,500,000,000,000 wei): its RESERVE_TARGET, 0.001 TAO, plus the same 0.0000005 TAO. pnpm ops fund-reserve --from <0x…> --for-wallet --live writes it for the sign page.`,
    );
    expect(fundingStepsV32(plan, true)[3]).toMatch(/fundCushion\(1000000000000000\) on the adapter.* pnpm ops fund-cushion --from <0x…> --for-wallet --live writes both for the sign page\.$/);
    expect(fundingStepsV32(plan, true).join("\n")).not.toMatch(/Transfer .* FM-TAO/);
    // the amounts are the contracts' constants: the vault and the native reserve with no margin (sweepSurplus leaves
    // exactly the native target), each reading exactly its constant once Bittensor keeps back its 500 rao; the cushion
    // its target, booked (spec §3.2, §7)
    expect(FUNDING_V32.edReserve).toBe(solConstant("contracts/src/CascadeConstants.sol", "ED_RESERVE"));
    expect(FUNDING_V32.reserveTarget).toBe(solConstant("contracts/src/adapters/CcipBittensorAdapter.sol", "RESERVE_TARGET"));
    expect(FUNDING_V32.tokenReserveTarget).toBe(solConstant("contracts/src/adapters/CcipBittensorAdapter.sol", "TOKEN_RESERVE_TARGET"));
    expect(FUNDING_V32.adapterReserve - FUNDING_V32.existentialDeposit).toBe(FUNDING_V32.reserveTarget);
    expect(FUNDING_V32.adapterCushion).toBe(FUNDING_V32.tokenReserveTarget);
  });

  it("warns, never refuses, for caps above the founder level without a Safe (ruling B7a); reads no owner at the launch caps", async () => {
    const w = world();
    await w.run();
    expect(w.logs.some((l) => l.includes("WARNING"))).toBe(false);
    expect(w.calls.some((c) => c.method === "eth_getCode" && (c.params[0] as string).toLowerCase() === plan.roles.owner.toLowerCase())).toBe(false);
    const TAO = 10n ** 18n;
    const high = { ...plan, steps: plan.steps.map((s) => (s.id === "frontDoor" ? { ...s, args: [{ ...(s.args[0] as object), depositCap: 41n * TAO }] } : s)) };
    const v = world();
    await v.run(high);
    expect(v.logs.find((l) => l.startsWith("Base: WARNING: a deposit cap of 41 TAO"))).toMatch(/a plain account, not a Safe[\s\S]*nothing is refused/);
    expect(v.sent).toHaveLength(13);
  });

  it("deployV32FromEnv: a v3.2 name, the measured inputs, the keystores by path, then the plan from them", async () => {
    const w = world();
    const env = ENV_V32;
    expect((await failure(deployV32FromEnv(w.ctx, { ...env, OPS_DEPLOYMENT: "v3-launch" }, w.path, { newPlan: false }, w.deps))).message).toMatch(/set OPS_DEPLOYMENT=v3.2-launch/);
    // Task 61 step 4 measured the pool floors (settings.ts); Task 65 set the launch claimGasRequired, 55,000,000 (the
    // controller's ruling: v3-launch's value, 0.9M over MIN_CLAIM_GAS, 54.1M: the measured 53.2M need at 63/64 forwarding)
    const measured = { ...MEASURED_V32 };
    expect(measured.poolFloors).toEqual([840_821_765_121_181_246_191n, 225_756_018_589_565_184n]);
    expect(measured.claimGasRequired).toBe(55_000_000n);
    // without it, it alone is named
    delete MEASURED_V32.claimGasRequired;
    try {
      const missing = (await failure(deployV32FromEnv(w.ctx, env, w.path, { newPlan: false }, w.deps))).message;
      expect(missing).toMatch(/measured inputs are not in .*MEASURED_V32 yet: claimGasRequired \(Tasks 64 and 65\); nothing read or sent/);
      expect(missing).not.toMatch(/pool floors/);
      delete MEASURED_V32.poolFloors;
      expect((await failure(deployV32FromEnv(w.ctx, env, w.path, { newPlan: false }, w.deps))).message).toMatch(/MEASURED_V32 yet: the pool floors \(Task 61 step 4 measures them\) and claimGasRequired/);
    } finally {
      MEASURED_V32.poolFloors = measured.poolFloors;
      MEASURED_V32.claimGasRequired = measured.claimGasRequired;
    }
    // with no measurement record for the adapters' gas, --live still refuses first
    const g = SETTINGS_V32_LAUNCH.gas as SettingsV32["gas"];
    const source = g.source;
    delete g.source;
    try {
      const live = { ...w.ctx, live: true, targets: targets({}).live };
      expect((await failure(deployV32FromEnv(live, env, w.path, { newPlan: false }, w.deps))).message).toMatch(/gas models are not measured yet/);
    } finally {
      g.source = source;
    }
    expect(w.runs).toEqual([]);
    MEASURED_V32.poolFloors = [10n ** 20n, 10n ** 17n];
    MEASURED_V32.claimGasRequired = 55_000_000n;
    try {
      // the keeper is a plan input with no default, and never v3-launch's: refused before any keystore is opened
      const { OPS_V32_KEEPER_ADDRESS: _keeper, ...noKeeper } = env;
      expect((await failure(deployV32FromEnv(w.ctx, noKeeper, w.path, { newPlan: false }, w.deps))).message).toMatch(/OPS_V32_KEEPER_ADDRESS is not set[\s\S]*nothing read or sent/);
      expect((await failure(deployV32FromEnv(w.ctx, { ...env, OPS_V32_KEEPER_ADDRESS: V3_LAUNCH_KEEPER }, w.path, { newPlan: false }, w.deps))).message).toMatch(/is v3-launch's live keeper/);
      expect(w.runs).toEqual([]);
      expect(w.sent).toEqual([]);
      const rec = await deployV32FromEnv(w.ctx, env, w.path, { newPlan: false }, w.deps);
      expect(rec.plan.deployers).toEqual({ bittensor: TEST_DEPLOYERS.bittensor.address, base: TEST_DEPLOYERS.base.address });
      expect(rec.plan.roles).toEqual({ ...ROLES_V32_LAUNCH, keeper: FRESH_KEEPER });
      expect(w.sent).toHaveLength(13);
    } finally {
      MEASURED_V32.poolFloors = measured.poolFloors;
      MEASURED_V32.claimGasRequired = measured.claimGasRequired;
    }
  });

  it("the launch roles are the founder's (the plan's Global Constraints, Keys); the keeper a fresh key, never v3-launch's", () => {
    const text = readFileSync(new URL("../../docs/superpowers/plans/2026-11-01-cascade-v3.2-implementation.md", import.meta.url), "utf8");
    const keys = text.split("\n").find((l) => l.startsWith("- Keys (founder decisions):"))!;
    const named = (role: string) => keys.match(new RegExp(`${role} \`(0x[0-9a-fA-F]{40})\``))![1];
    expect(ROLES_V32_LAUNCH).toEqual({ owner: named("owner"), guardian: named("guardian"), treasury: named("treasury") });
    expect("keeper" in ROLES_V32_LAUNCH).toBe(false);
    // the Keys line names v3-launch's live keeper only as the one v3.2 never uses (the founder's 2026-11-07 decision)
    expect(keys).toContain("keeper: a fresh key of its own, its address from `OPS_V32_KEEPER_ADDRESS` (no default)");
    expect(named("never v3-launch's live keeper")).toBe(V3_LAUNCH_KEEPER);
  });

  it("parses deploy --v32, and only for deploy", () => {
    expect(parseArgs(["deploy", "--v32", "--live"])).toEqual({ cmd: "deploy", live: true, v32: true, newPlan: false, users: [] });
    expect(parseArgs(["deploy", "--v32", "--new-plan"]).newPlan).toBe(true);
    expect(() => parseArgs(["verify", "--v32"])).toThrow(/unexpected argument --v32/);
  });
});

describe("preflight's inbound simulation, routed by plan (the 5d-1 carry)", () => {
  it("a v3.2 deployment simulates with v3.2's values; any other is refused, since this checkout's adapter is v3.2's", () => {
    const rec = { plan, build: { dir: "x", hash: "0x" as Hex }, target: "live", createdAt: "", done: {} } as DeploymentRecordV32;
    const g = SETTINGS_V32_LAUNCH.gas.towardBase;
    const want = {
      GAS_BASE: g.base.toString(),
      GAS_PER_ENTRY: g.perEntry.toString(),
      INBOUND_GAS_BASE: SETTINGS_V32_LAUNCH.gas.towardBittensor.base.toString(),
      INBOUND_GAS_PER_ENTRY: SETTINGS_V32_LAUNCH.gas.towardBittensor.perEntry.toString(),
      MAX_MESSAGE: (50n * 10n ** 18n).toString(),
      TREASURY: SETTINGS_V32_LAUNCH.treasury,
      RESERVE: (10n ** 15n + 5n * 10n ** 11n).toString(),
    };
    expect(simulationInputs(rec, true)).toEqual({ env: { REMOTE_ADAPTER: plan.addresses.baseAdapter, ...want } });
    // before the v3.2 record exists, by its name
    expect(simulationInputs(null, true)).toEqual({ env: want });
    // v3-launch's record, or none for a v3-launch deployment
    const v3launch = { plan: buildPlan(0, 0, `0x${"11".repeat(32)}`), done: {} } as never;
    expect(simulationInputs(v3launch, false)).toEqual({ skip: expect.stringMatching(/this checkout's adapter is v3.2's, not the one v3-launch deployed/) });
    expect(simulationInputs(null, false)).toHaveProperty("skip");
    // the gas toward Base is the adapter's own model (the Bittensor adapter sends toward Base)
    expect((step(plan, "bitAdapter").args[0] as { gasBase: bigint }).gasBase).toBe(g.base);
  });
});

describe("Task 44's review, fix round 1", () => {
  const data = () => deployDataV32(build, step(plan, "payoutMath"));
  const legacy = (): TransactionSerializable => ({ type: "legacy", chainId: 31338, nonce: 1, gas: 500_000n, gasPrice: 10n ** 9n, data: data(), value: 0n });
  const eip1559 = (): TransactionSerializable => ({
    type: "eip1559",
    chainId: 31337,
    nonce: 0,
    gas: 500_000n,
    maxFeePerGas: 2n * 10n ** 9n,
    maxPriorityFeePerGas: 10n ** 6n,
    data: data(),
    value: 0n,
  });
  type Sig = Signature;

  it("I-1: the signed transaction is decoded back before it is sent; a field assembled wrong, or another key's signature, is refused", async () => {
    const f = fakeChains();
    const ctx = { ...f.ctx, signer: SIGNERS.bittensor };
    // as viem assembles them, both kinds pass, a create from the signer
    for (const tx of [legacy(), eip1559()]) {
      const raw = await signTransaction(ctx, tx);
      expect(await signedTransactionProblem(tx, raw, SIGNERS.bittensor.address)).toBeNull();
      expect(parseTransaction(raw).to).toBeUndefined();
    }
    const refused = async (tx: TransactionSerializable, assemble: (t: TransactionSerializable, sig: Sig) => Hex, why: RegExp) => {
      const e = await failure(signTransaction(ctx, tx, assemble));
      expect(e, String(why)).toBeInstanceOf(SendRefused);
      expect((e as SendRefused).reason).toBe("signer");
      expect(e.message).toMatch(/the signed transaction, decoded back, is not the planned one: /);
      expect(e.message).toMatch(why);
    };
    const changed = (over: Record<string, unknown>) => (t: TransactionSerializable, sig: Sig) => serializeTransaction({ ...t, ...over } as TransactionSerializable, sig);
    const L = legacy();
    const d = L.data as Hex;
    const flipped = `${d.slice(0, 100)}${d[100] === "0" ? "1" : "0"}${d.slice(101)}` as Hex;
    // a legacy v without the chain id (pre-EIP-155)
    await refused(L, changed({ chainId: undefined }), /its chainId is undefined, not the planned 31338/);
    await refused(L, changed({ type: "eip2930", accessList: [] }), /its type is eip2930, not the planned legacy/);
    await refused(L, changed({ nonce: 2 }), /its nonce is 2, not the planned 1/);
    await refused(L, changed({ to: TEST_DEPLOYERS.base.address }), /its to is 0x.*, not the planned null/);
    await refused(L, changed({ value: 1n }), /its value is 1, not the planned 0/);
    await refused(L, changed({ data: flipped }), /its data is not the planned creation code and arguments/);
    await refused(L, changed({ gas: 500_001n }), /its gas is 500001, not the planned 500000/);
    await refused(L, changed({ gasPrice: 10n ** 9n + 1n }), /its gasPrice is 1000000001, not the planned 1000000000/);
    const E = eip1559();
    await refused(E, changed({ chainId: 8453 }), /its chainId is 8453, not the planned 31337/);
    await refused(E, changed({ maxFeePerGas: 2n * 10n ** 9n + 1n }), /its maxFeePerGas is 2000000001/);
    await refused(E, changed({ maxPriorityFeePerGas: 10n ** 6n + 1n }), /its maxPriorityFeePerGas is 1000001/);
    await refused(E, changed({ accessList: [{ address: TEST_DEPLOYERS.base.address, storageKeys: [] }] }), /its access list's length is 1, not the planned 0/);
    // every field right, but signed by another key
    const other = parseSignature(await TEST_DEPLOYERS.base.sign({ hash: keccak256(serializeTransaction(L)) }));
    const byOther = (t: TransactionSerializable) => serializeTransaction(t, { ...other, v: 27n + BigInt(other.yParity ?? 0) });
    await refused(L, byOther, new RegExp(`it recovers to ${TEST_DEPLOYERS.base.address}, not ${SIGNERS.bittensor.address}`));
    // Task 44's re-review, N1: the malleable twin (s turned high, the parity flipped) still recovers to the signer, but
    // nodes refuse it (EIP-2), so the decoded transaction's s is checked low too
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const twin = (t: TransactionSerializable, sig: Sig) => {
      const s = `0x${(N - BigInt(sig.s)).toString(16).padStart(64, "0")}` as Hex;
      const yParity = sig.yParity === 0 ? 1 : 0;
      return serializeTransaction(t, { r: sig.r, s, yParity, v: 27n + BigInt(yParity) });
    };
    for (const tx of [L, E]) {
      const raw = twin(tx, parseSignature(await TEST_DEPLOYERS.bittensor.sign({ hash: keccak256(serializeTransaction(tx)) })));
      expect((await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase()).toBe(SIGNERS.bittensor.address.toLowerCase());
      await refused(tx, twin, /its signature's s is high \(the malleable twin\), which nodes refuse/);
      // Task 45's review, M5: the transaction assembled without its signature says so
      await refused(tx, (u) => serializeTransaction(u), /it carries no signature/);
    }
    expect(f.sent).toEqual([]);
  });

  it("I-2: build.json records the commit, each contract's metadata hash and the compiler's settings", () => {
    expect(build.source).toEqual(SOURCE);
    for (const c of Object.values(build.contracts)) {
      const [path, name] = c.contract.split(":");
      const raw = JSON.parse(readFileSync(join(CONTRACTS, "out", basename(path), `${name}.json`), "utf8")).rawMetadata as string;
      expect(c.metadataHash, name).toBe(keccak256(stringToBytes(raw)));
    }
    expect(build.compiler.settings).toMatchObject({ evmVersion: "cancun", viaIR: true, optimizer: { enabled: true, runs: 200 } });
    expect(build.compiler.settings).toHaveProperty("remappings");
    expect(build.compiler.settings).not.toHaveProperty("compilationTarget");
  });

  it("I-2: a live run from uncommitted contracts/ is refused before anything is built or frozen; a rehearsal records what differs", async () => {
    const dirty: SourceV32 = { ...SOURCE, dirty: [" M contracts/src/CascadeVault.sol", "?? contracts/src/Extra.sol"] };
    const w = world({}, { live: true, source: dirty });
    const e = await failure(w.run({ ...plan, gasSource: "Task 64: testnet 945" }));
    expect(e.message).toBe(
      [
        `contracts/ differs from the commit ${SOURCE.commit}:`,
        "   M contracts/src/CascadeVault.sol",
        "  ?? contracts/src/Extra.sol",
        `a live deploy sends only committed source (${SOURCE_PATHS.join(", ")}): commit or undo these; nothing frozen or sent`,
      ].join("\n"),
    );
    expect(w.built()).toBe(0);
    expect(existsSync(w.buildsDir)).toBe(false);
    expect(existsSync(w.path)).toBe(false);
    expect(w.sent).toEqual([]);
    // on the forks the tree may differ, and the frozen build says how
    const r = world({}, { source: dirty });
    const rec = await r.run();
    expect(loadBuildV32(rec.build, r.buildsDir).source).toEqual(dirty);
  });

  it("I-2: a live run sends only what a completed rehearsal names as rehearsed, and names both identities otherwise", async () => {
    const livePlan = { ...plan, gasSource: "Task 64: testnet 945" };
    const tail = /a live deploy sends only the build Task 61's rehearsal deployed and verified on the forks; nothing frozen or sent/;
    const dir = tempDir("live");
    const noRehearsal = world({}, { live: true, dir });
    const e1 = await failure(noRehearsal.run(livePlan));
    expect(e1.message).toMatch(/there is no rehearsal record at .*rehearsal-v3.2-launch.json: /);
    expect(e1.message).toMatch(tail);
    expect(existsSync(noRehearsal.path)).toBe(false);
    expect(noRehearsal.sent).toEqual([]);
    // the rehearsal on the forks, deployed in full, of the plan the live run will send
    const reh = world({}, { dir });
    const rehearsed = await reh.run(livePlan);
    const e2 = await failure(world({}, { live: true, dir }).run(livePlan));
    expect(e2.message).toMatch(/names no rehearsed build \(its "rehearsed" field, which Task 61's rehearse --v32 writes/);
    expect(e2.message).toMatch(tail);
    // a rehearsal not complete
    const { vaultLens: _, ...partial } = rehearsed.done;
    const at = "2026-11-08T00:00:00Z";
    const verified = { ok: true, failures: [], checkedAt: at };
    saveRecord(reh.path, { ...rehearsed, done: partial, rehearsed: { buildHash: rehearsed.build.hash, at }, verify: verified });
    expect((await failure(world({}, { live: true, dir }).run(livePlan))).message).toMatch(/rehearsal is not complete/);
    saveRecord(reh.path, { ...rehearsed, rehearsed: { buildHash: rehearsed.build.hash, at }, verify: verified });
    const identity = buildIdentityV32(loadBuildV32(rehearsed.build, reh.buildsDir));
    const refusedFor = async (w: ReturnType<typeof world>) => {
      const e = await failure(w.run(livePlan));
      expect(e.message).toMatch(new RegExp(`this checkout's contracts and build are 0x[0-9a-f]{64} \\(the contracts tree, the code, the links and the compiler\\), but the ones rehearsed in .*rehearsal-v3.2-launch.json are ${identity}: `));
      expect(e.message).not.toContain(`build are ${identity}`);
      expect(w.sent).toEqual([]);
      expect(existsSync(w.path)).toBe(false);
    };
    // a one-byte change under contracts/, committed: another contracts tree (uncommitted, the dirty-tree test refuses it)
    await refusedFor(world({}, { live: true, dir, source: { ...SOURCE, commit: "e".repeat(40), tree: `${SOURCE.tree.slice(0, 39)}1` } }));
    // another compiler setting (every artifact alike, so the freeze itself takes it)
    const remapped = copyOfContracts();
    for (const { contract } of Object.values(CONTRACTS_V32)) {
      editArtifact(remapped, contract.split(":")[1], (j) => {
        const st = (j.metadata as { settings: { remappings: string[] } }).settings;
        st.remappings = [...st.remappings, "extra/=lib/extra/"];
      });
    }
    await refusedFor(world({}, { live: true, dir, contractsDir: remapped }));
    // other code from the same tree and compiler (a contracts/out that is not the tree's build)
    const otherCode = copyOfContracts();
    editArtifact(otherCode, "CascadeTwapOracle", (j) => {
      const b = j.bytecode as { object: string };
      b.object = `${b.object.slice(0, -2)}${b.object.endsWith("00") ? "01" : "00"}`;
    });
    await refusedFor(world({}, { live: true, dir, contractsDir: otherCode }));
    // a docs or ops commit after the rehearsal: the same contracts tree and build, another commit; the live run goes
    const docs: SourceV32 = { ...SOURCE, commit: "d".repeat(40) };
    const ok = world({}, { live: true, dir, source: docs });
    const live = await ok.run(livePlan);
    expect(live.target).toBe("live");
    // its build.json still records its own commit, so its file and hash are not the rehearsal's
    expect(live.build.hash).not.toBe(rehearsed.build.hash);
    expect(loadBuildV32(live.build, ok.buildsDir).source).toEqual(docs);
    expect(buildIdentityV32(loadBuildV32(live.build, ok.buildsDir))).toBe(identity);
    expect(ok.sent).toHaveLength(13);
    expect(ok.sent.map((t) => t.chainId)).toEqual([...Array(8).fill(964), ...Array(5).fill(8453)]);
  });

  it("N2/N3 (Task 44's re-review, Task 61): the rehearsal must be verified and not void, and of the live plan but its keys", async () => {
    const tail = /a live deploy sends only the build Task 61's rehearsal deployed and verified on the forks; nothing frozen or sent/;
    const dir = tempDir("n2n3");
    const reh = world({}, { dir });
    const rehearsed = await reh.run(plan);
    const build = loadBuildV32(rehearsed.build, reh.buildsDir);
    const at = "2026-11-13T00:00:00Z";
    const done = { ...rehearsed, rehearsed: { buildHash: rehearsed.build.hash, at } };
    const problem = (live: PlanV32 = plan) => rehearsalProblem(reh.path, build, reh.buildsDir, live);
    // N3: never verified, verified with a failure, or void
    saveRecord(reh.path, done);
    expect(problem()).toMatch(/rehearsal-v3.2-launch.json's rehearsal was never verified \(pnpm ops rehearse --v32 verifies it on the forks\): /);
    saveRecord(reh.path, { ...done, verify: { ok: false, failures: ["Bittensor CascadeVault.owner(): expected A, found B"], checkedAt: at } });
    expect(problem()).toMatch(/rehearsal-v3.2-launch.json's verify failed \(Bittensor CascadeVault.owner\(\): expected A, found B\): /);
    saveRecord(reh.path, { ...done, verify: { ok: true, failures: [], checkedAt: at }, void: { at, reason: "a create reverted" } });
    expect(problem()).toMatch(/rehearsal-v3.2-launch.json's plan is void \(a create reverted\): /);
    expect(problem()).toMatch(tail);
    saveRecord(reh.path, { ...done, verify: { ok: true, failures: [], checkedAt: at } });
    expect(problem()).toBeNull();
    // N2: the live plan is the rehearsal's but for its deployers: fresh keys move every address, the vault's coldkey and
    // the links, and the plan is still the one rehearsed
    const fresh = { bittensor: getAddress(`0x${"e2".repeat(20)}`), base: getAddress(`0x${"e1".repeat(20)}`) };
    const vault = getContractAddress({ from: fresh.bittensor, nonce: 6n });
    const inputs = { roles: plan.roles, validators: plan.validators, poolFloors: plan.poolFloors, claimGasRequired: plan.claimGasRequired };
    const freshPlan = buildPlanV32({ ...inputs, deployers: fresh, vaultColdkey: addressMapping(vault) });
    expect(freshPlan.addresses.vault).not.toBe(plan.addresses.vault);
    expect(planDifference(plan, freshPlan)).not.toBeNull();
    expect(planShapeV32(freshPlan)).toEqual(planShapeV32(plan));
    expect(problem(freshPlan)).toBeNull();
    // a setting changed after the rehearsal (ops/ only: the build is the same) is refused, naming where
    const changed = (o: Partial<typeof inputs>) => buildPlanV32({ ...inputs, ...o, deployers: fresh, vaultColdkey: addressMapping(vault) });
    expect(problem(changed({ claimGasRequired: 56_000_000n }))).toMatch(/the live plan is not the one rehearsed in .*rehearsal-v3.2-launch.json \(plan.claimGasRequired differs\): /);
    expect(problem(changed({ poolFloors: [plan.poolFloors[0], plan.poolFloors[1] + 1n] }))).toMatch(/\(plan.poolFloors\[1\] differs\)/);
    expect(problem(changed({ roles: { ...plan.roles, guardian: getAddress(`0x${"0b".repeat(20)}`) } }))).toMatch(/\(plan.roles.guardian differs\)/);
    expect(problem({ ...freshPlan, gasSource: "Task 64" })).toMatch(/\(plan.gasSource differs\)/);
    const doorArgs = freshPlan.steps.find((x) => x.id === "frontDoor")!.args[0] as Record<string, unknown>;
    const bigger = { ...freshPlan, steps: freshPlan.steps.map((x) => (x.id === "frontDoor" ? { ...x, args: [{ ...doorArgs, depositCap: 41n * 10n ** 18n }] } : x)) };
    expect(problem(bigger)).toMatch(/\(plan.steps\[10\].args\[0\].depositCap differs\)/);
    expect(problem(changed({}))).toBeNull();
  });

  it("I-2: sourceOf reads the commit and every change under contracts/'s sources from git, untracked files too", async () => {
    const runs: { file: string; args: string[]; cwd: string }[] = [];
    const answers: Record<string, { code: number; stdout: string; stderr: string }> = {
      "rev-parse HEAD": { code: 0, stdout: `${"ab".repeat(20)}\n`, stderr: "" },
      "rev-parse HEAD:contracts": { code: 0, stdout: `${"cd".repeat(20)}\n`, stderr: "" },
      status: { code: 0, stdout: " M contracts/src/CascadeVault.sol\n?? contracts/src/New.sol\n", stderr: "" },
    };
    const runner: Runner = {
      async run(file, args, o) {
        runs.push({ file, args, cwd: o.cwd });
        return answers[args[0] === "status" ? "status" : args.join(" ")];
      },
    };
    const ctx = { ...fakeChains().ctx, runner };
    expect(await sourceOf(ctx)).toEqual({ commit: "ab".repeat(20), tree: "cd".repeat(20), dirty: [" M contracts/src/CascadeVault.sol", "?? contracts/src/New.sol"] });
    expect(runs.map((r) => [r.file, ...r.args])).toEqual([
      ["git", "rev-parse", "HEAD"],
      ["git", "rev-parse", "HEAD:contracts"],
      // Task 44's re-review, N4: a moved submodule pin is reported whatever the user's git config ignores
      ["git", "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none", "--", ...SOURCE_PATHS],
    ]);
    expect([...SOURCE_PATHS]).toEqual(["contracts/src", "contracts/lib", "contracts/foundry.toml", "contracts/remappings.txt", "contracts/abi"]);
    const norm = (p: string) => p.replaceAll("\\", "/").replace(/\/$/, "");
    expect(norm(runs[0].cwd)).toBe(norm(join(CONTRACTS, "..")));
    answers["rev-parse HEAD"] = { code: 128, stdout: "", stderr: "fatal: not a git repository" };
    await expect(sourceOf(ctx)).rejects.toThrow(/git rev-parse failed \(fatal: not a git repository\): the build's source cannot be named; nothing frozen or sent/);
  });

  it("M1: a priority fee above the gas price is refused, nothing sent; an honest one keeps the fee cap within twice the cap", async () => {
    const s = step(plan, "baseAdapter");
    const req = { ...s, build, gasCeiling: gasCeiling(build, s) };
    const hostile = fakeChains({ priorityFee: 10n ** 10n });
    const e = await failure(sendCreate({ ...hostile.ctx, signer: SIGNERS.base, maxGasPrice: { base: 5n * 10n ** 9n } }, req, plan.addresses.baseAdapter));
    expect((e as SendRefused).reason).toBe("fee");
    expect(e.message).toMatch(/Base: the node suggests a priority fee of 10 gwei, above its gas price of 1 gwei; deploy the Base bridge adapter not sent/);
    expect(hostile.sent).toEqual([]);
    const honest = fakeChains({ codeFor: (_c, d) => runtimeOf.get(d) ?? "0x60dead" });
    await sendCreate({ ...honest.ctx, signer: SIGNERS.base, maxGasPrice: { base: 5n * 10n ** 9n } }, req, plan.addresses.baseAdapter);
    const tx = parseTransaction(honest.sent[0].raw);
    expect(tx.maxFeePerGas).toBe(2n * 10n ** 9n);
    expect(tx.maxPriorityFeePerGas).toBe(10n ** 6n);
    expect((tx.maxFeePerGas ?? 0n) <= 2n * 5n * 10n ** 9n).toBe(true);
  });

  it("M2: a broadcast whose answer was lost, the node having taken it, keeps its hash: the next run settles it, voiding nothing", async () => {
    const w = world({ fate: (_t, i) => (i === 2 ? "lost" : "mine") });
    const e = await failure(w.run());
    expect(e.message).toMatch(/Bittensor: deploy the unstake library was not sent, as far as the node says \(.*the connection was reset\); its hash is kept/);
    const lost = w.sent[2];
    expect(w.record().pending).toEqual({ step: "stakeLib", chain: "bittensor", nonce: 2, hashes: [lost.hash] });
    const rec = await w.run();
    expect(rec.void).toBeUndefined();
    expect(rec.done.stakeLib?.hash).toBe(lost.hash);
    expect(w.logs.some((l) => l.includes("mined after the last run stopped"))).toBe(true);
    expect(w.sent).toHaveLength(13);
    expect(w.mined().map((t) => stepOfTx(plan, t)!.id)).toEqual(plan.steps.map((s) => s.id));
  });

  it("M3: a good receipt with no code seen yet is recorded from its receipt and stops the run unvoided; the next runs check the code", async () => {
    for (const index of [3, 12]) {
      const s = plan.steps[index];
      const w = world({ fate: (_t, i) => (i === index ? "noCode" : "mine") });
      const e = await failure(w.run());
      expect(e).not.toBeInstanceOf(PlanVoid);
      expect(e.message).toContain(`${s.label}'s receipt`);
      expect(e.message).toMatch(/is good, at 0x[0-9a-fA-F]{40}, but the RPC shows no code there yet\. It is recorded from its receipt/);
      const rec = w.record();
      expect(rec.done[s.id]?.address).toBe(plan.addresses[s.id]);
      expect(rec.void).toBeUndefined();
      expect(rec.pending).toBeUndefined();
      // still no code seen: refused, nothing sent, nothing voided (a finished record too)
      const again = await failure(w.run());
      expect(again.message).toContain(`the record has ${s.label} at ${plan.addresses[s.id]} from its receipt, but the RPC shows no code there yet`);
      expect(again).not.toBeInstanceOf(PlanVoid);
      expect(w.sent).toHaveLength(index + 1);
      expect(w.record().void).toBeUndefined();
      // the code shows, the build's: the run goes on
      w.code[s.chain].set(plan.addresses[s.id].toLowerCase(), runtimeOf.get(deployDataV32(build, s))!);
      const done = await w.run();
      expect(Object.keys(done.done)).toHaveLength(13);
      expect(w.sent).toHaveLength(13);
    }
  });

  it("M5: deploy --v32 holds the deployment's run lock: refused while another run holds it, released after", async () => {
    const w = world();
    const release = takeRunLock(runLockPath(w.path));
    try {
      const e = await failure(deployV32FromEnv(w.ctx, ENV_V32, w.path, { newPlan: false }, w.deps));
      expect(e).toBeInstanceOf(RunLockHeld);
      expect(w.calls).toEqual([]);
      expect(w.runs).toEqual([]);
    } finally {
      release();
    }
    // free: it runs (Task 65 set the measured inputs, so through to the record), and lets the lock go after
    expect((await deployV32FromEnv(w.ctx, ENV_V32, w.path, { newPlan: false }, w.deps)).plan.claimGasRequired).toBe(55_000_000n);
    expect(existsSync(runLockPath(w.path))).toBe(false);
  });

  it("M6: the freeze holds the compiler to the plan's (solc 0.8.38, cancun, via-IR, 200 runs), in foundry.toml and in every artifact", async () => {
    expect(COMPILER_V32).toEqual({ version: "0.8.38", evmVersion: "cancun", viaIR: true, optimizer: { enabled: true, runs: 200 } });
    const constraints = readFileSync(new URL("../../docs/superpowers/plans/2026-11-01-cascade-v3.2-implementation.md", import.meta.url), "utf8");
    for (const s of ['solc_version = "0.8.38"', 'evm_version = "cancun"', "via_ir = true", "optimizer = true", "optimizer_runs = 200"]) expect(constraints).toContain(`\`${s}\``);
    expect(foundryCompiler(CONTRACTS)).toEqual(COMPILER_V32);
    const toml = copyOfContracts();
    writeFileSync(join(toml, "foundry.toml"), readFileSync(join(toml, "foundry.toml"), "utf8").replace('solc_version = "0.8.38"', 'solc_version = "0.8.39"'));
    await expect(freezeBuildV32(toml)).rejects.toThrow(/contracts\/foundry.toml compiles with .*0\.8\.39.*, not the plan's/);
    const runs = copyOfContracts();
    editArtifact(runs, "CascadeStaker", (j) => {
      (j.metadata as { settings: { optimizer: { runs: number } } }).settings.optimizer.runs = 201;
    });
    await expect(freezeBuildV32(runs)).rejects.toThrow(/contracts\/out's CascadeStaker was compiled with .*"runs":201.*, not the plan's/);
  });
});
