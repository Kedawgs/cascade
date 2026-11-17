import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Address, formatEther, getAddress, type Hex, hexToBigInt, hexToNumber, parseAbi } from "viem";
import { type ChainName, type Env, LIVE, recordPath as recordPathOf } from "../config.ts";
import { readColdkey } from "../deploy.ts";
import { runLockPath, takeRunLock } from "../keeper/runlock.ts";
import { isPlanV3 } from "../plan.ts";
import { archiveRecord, type DeploymentRecord, loadRecordFor, saveRecord, type VerifyResult } from "../record.ts";
import { balanceOf, codeAt, gasPriceOf, isRevert, nonceOf, read } from "../rpc.ts";
import { accountKind } from "../safe.ts";
import {
  bin,
  CodeNotYetSeen,
  type CreateHooks,
  type Ctx,
  chainLabel,
  describeRevert,
  gate,
  ReceiptTimeout,
  RevertedOnChain,
  type Sent,
  type Signer,
  sendCreate,
  signingAccount,
  UnexpectedReceipt,
  unit,
} from "../send.ts";
import { encodeSs58 } from "../ss58.ts";
import type { CreateRequestV32 } from "../types.ts";
import {
  BUILDS_DIR,
  type BuildRefV32,
  type BuildV32,
  buildErrorsV32,
  buildIdentityV32,
  codeProblemV32,
  deployDataV32,
  freezeBuildV32,
  frozenContract,
  loadBuildV32,
  runtimeCodeV32,
  type SourceV32,
  writeBuildV32,
} from "./build.ts";
import { addressMapping, buildPlanV32, isPlanV32, type PlannedStepV32, type PlanV32, plannedAddressesV32, type V32StepId } from "./plan.ts";
import {
  capsWarning,
  deployerKeysFromEnv,
  FUNDING_V32,
  isV32Deployment,
  liveGasProblem,
  MEASURED_V32,
  msPerBlockProblems,
  type OwnerKind,
  rolesV32FromEnv,
  SETTINGS_V32_LAUNCH,
  type SettingsV32,
  V32_ENV,
  validatorsFromEnv,
} from "./settings.ts";

// v3.2's deployment (spec §7 step 2; plan Task 44): every contract by plain CREATE from one fresh, single-use deployer
// key per chain, each at the address its nonce predicts (plan.ts), Bittensor first (a revert there costs nothing on
// Base), then Base. The addresses are baked into the other contracts' immutables, across the chains too, so a create at
// the wrong nonce, a library linked at the wrong address or a create that reverts (its nonce still spent) leaves
// contracts that point at the wrong addresses, for good: the only way on is fresh keys and a new plan. So this refuses
// rather than sends:
// - before the first CREATE, the build is frozen (build.ts) and every create is sent from that copy, linked there;
// - before anything is sent, each chain's deployer must have sent exactly what the record has (both of its nonces 0 on
//   a chain not started: a fresh key), and hold enough for the creates left; the planned vault's coldkey must be the
//   chain's ADDRESS_MAPPING; Base's creates that read no other planned contract (the adapter and the oracle) are
//   simulated there, so a pool below the oracle's MIN_CARDINALITY stops the run while nothing is deployed; and every present step
//   must be the record's, with the frozen build's code;
// - after each CREATE its address must be the planned one and hold code;
// - a revert, another address or a nonce spent outside the plan voids the plan: the record says so, and nothing more is
//   ever sent from it;
// - a resumed run sends only the steps not yet done, after settling a create it signed and may have sent.
// Nothing here funds anything: the three funding steps are printed for the founder.

/** What every refusal that voids a plan ends with. */
export const FRESH_KEYS = "fresh keys and a new plan";

const CHAINS = ["bittensor", "base"] as const;

/** A v3.2 deployment's record (deployments/<name>.json, rehearsal-<name>.json on the forks). */
export interface DeploymentRecordV32 {
  target: "live" | "rehearsal";
  createdAt: string;
  plan: PlanV32;
  /** The frozen build every create is sent from and every read decodes with, written before the first CREATE. */
  build: BuildRefV32;
  done: Partial<Record<V32StepId, Sent>>;
  /** A create signed and maybe broadcast, by every hash it was ever signed with (none is dropped: a broadcast whose
   * answer was lost may still be mined; a dropped one is signed again at its nonce); the next run settles it from the
   * chain before anything else. */
  pending?: { step: V32StepId; chain: ChainName; nonce: number; hashes: Hex[] };
  /** Set when the plan can no longer be deployed (a revert, an address that is not the plan's, a nonce spent outside
   * it, code that is not the build's); nothing is sent from this record again. */
  void?: { at: string; reason: string };
  /** Task 46's read-back. */
  verify?: VerifyResult;
  /** On a rehearsal record (the forks): the build it deployed and verified, which Task 61's `rehearse --v32` writes
   * once its deploy and its verify pass. A live deploy sends only a build of this hash (rehearsalProblem). */
  rehearsed?: { buildHash: Hex; at: string };
  /** R4 (D-M2, C-M2): the adapter pairs added after the deploy (runbook section 8's switch), oldest first, each written by
   * `pnpm ops add-pair` after its checks (v32/pairs.ts): the keeper works each one's parks and CCIP FAILUREs too. */
  pairs?: {
    bitAdapter: Address;
    baseAdapter: Address;
    blocks: { base: number; bittensor: number };
    addedAt: string;
    /** R4-O round 3: the deploy's AlphaVault's announced migration target this pair's Bittensor adapter names, read live by
     * add-pair at `block` (Bittensor) and equal then: the checks accept it after the live target is cleared */
    alphaTarget?: { vault: Address; target: Address; block: number };
  }[];
}

/** The plan can no longer be deployed: nothing more is sent. */
export class PlanVoid extends Error {}

/** What a v3.2 deployment needs from outside: the checkout's commit and what differs from it under contracts/, forge's
 * build of contracts/ before it is frozen, where frozen builds live, the send of one create, and Bittensor's
 * ADDRESS_MAPPING. */
export interface DeployDepsV32 {
  source(ctx: Ctx): Promise<SourceV32>;
  buildContracts(ctx: Ctx): Promise<void>;
  buildsDir: string;
  sendCreate(ctx: Ctx, req: CreateRequestV32, predicted: Address, hooks: CreateHooks): Promise<Sent>;
  readColdkey(ctx: Ctx, vault: Address): Promise<Hex>;
}

/** What a live deploy's build must come from, all committed (Task 44's review, I-2): the sources, the library pins,
 * the compiler's settings and remappings, and the published ABI. */
export const SOURCE_PATHS = ["contracts/src", "contracts/lib", "contracts/foundry.toml", "contracts/remappings.txt", "contracts/abi"] as const;

/** The checkout's commit (git rev-parse HEAD) and every path under SOURCE_PATHS that differs from it, tracked or not
 * (git status --porcelain, every untracked file named). A checkout git cannot read is refused. */
export async function sourceOf(ctx: Ctx): Promise<SourceV32> {
  const repo = join(ctx.paths.contractsDir, "..");
  const git = async (args: string[]) => {
    const out = await ctx.runner.run("git", args, { cwd: repo });
    if (out.code !== 0) throw new Error(`git ${args[0]} failed (${(out.stderr.trim() || out.stdout.trim()).split("\n")[0]}): the build's source cannot be named; nothing frozen or sent`);
    return out.stdout;
  };
  const commit = (await git(["rev-parse", "HEAD"])).trim();
  const tree = (await git(["rev-parse", "HEAD:contracts"])).trim();
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error(`git rev-parse HEAD:contracts gave "${tree}", not a tree; nothing frozen or sent`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`git rev-parse HEAD gave "${commit}", not a commit; nothing frozen or sent`);
  // --ignore-submodules=none: a moved contracts/lib pin is reported whatever the user's git config says (Task 44's
  // re-review, N4)
  const dirty = (await git(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none", "--", ...SOURCE_PATHS]))
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);
  return { commit, tree, dirty };
}

/** forge build in contracts/, so the build frozen is the checkout's sources' (a stale contracts/out would freeze and send
 * code the sources no longer hold). A checkout that does not build is refused. */
export async function buildContracts(ctx: Ctx): Promise<void> {
  const out = await ctx.runner.run(bin(ctx, "forge"), ["build"], { cwd: ctx.paths.contractsDir });
  if (out.code !== 0) {
    const why = (out.stderr.trim() || out.stdout.trim()).split("\n")[0] || `exit ${out.code}`;
    throw new Error(`could not build contracts/ (forge build: ${why}); the deploy freezes and sends that build, so nothing frozen or sent`);
  }
}

export const realDepsV32: DeployDepsV32 = { source: sourceOf, buildContracts, buildsDir: BUILDS_DIR, sendCreate, readColdkey };

// ---- the plan's gas, and what the deployers must hold ----

/** What each create's constructor may spend beyond its transaction's intrinsic gas and its code deposit (gasCeiling),
 * each about twice its work: a library sets its own address, a lens its target; the oracle checks its two pools; an
 * adapter or the staker checks its arguments and writes a few slots; the front door writes about 35 slots and the vault
 * about 60, with an event for each setting, the vault through L4 and two precompiles as well. */
export const CONSTRUCTOR_GAS: Record<V32StepId, bigint> = {
  bitAdapter: 1_000_000n,
  payoutMath: 100_000n,
  stakeLib: 100_000n,
  payoutLib: 100_000n,
  batchLib: 100_000n,
  hotkeyLib: 100_000n,
  vault: 3_000_000n,
  vaultLens: 100_000n,
  baseAdapter: 1_000_000n,
  oracle: 500_000n,
  frontDoor: 2_000_000n,
  staker: 1_000_000n,
  doorLens: 100_000n,
};

/** The most gas a step's create may use: its transaction's intrinsic gas (21,000, the create's 32,000, 16 a byte of its
 * creation code and arguments as if none were zero, and EIP-3860's 2 a word of initcode), the deposit of its runtime
 * code (200 a byte) and its constructor's allowance (CONSTRUCTOR_GAS). The create is refused, unsent, above it. */
export function gasCeiling(build: BuildV32, step: PlannedStepV32): bigint {
  const bytes = BigInt((deployDataV32(build, step).length - 2) / 2);
  const runtime = BigInt((frozenContract(build, step).deployedBytecode.object.length - 2) / 2);
  return 53_000n + 16n * bytes + 2n * ((bytes + 31n) / 32n) + 200n * runtime + CONSTRUCTOR_GAS[step.id];
}

/** Base's L1 data fee, which its gas price leaves out: an allowance for each Base create. */
export const BASE_L1_ALLOWANCE = 10n ** 14n;

/** What a deployer must hold for `steps`: their gas ceilings at twice the gas price now (a Base create offers up to
 * twice it, and the node wants the balance to cover that), plus Base's L1 allowance for each. */
export function fundingNeed(build: BuildV32, steps: PlannedStepV32[], chain: ChainName, price: bigint): bigint {
  return fundingNeedFor(
    steps.reduce((t, s) => t + gasCeiling(build, s), 0n),
    steps.length,
    chain,
    price,
  );
}

/** fundingNeed's arithmetic for `creates` creates whose ceilings add up to `ceilingGas` (pnpm ops budget's too: v32/budget.ts). */
export const fundingNeedFor = (ceilingGas: bigint, creates: number, chain: ChainName, price: bigint): bigint =>
  ceilingGas * price * 2n + (chain === "base" ? BigInt(creates) * BASE_L1_ALLOWANCE : 0n);

// ---- the founder's funding, printed ----

const wei = (n: bigint) => `${n.toLocaleString("en-US")} wei`;

/** The three funding steps (spec §7 step 2), the founder's: printed, never sent, each amount in TAO and in wei. The
 * vault's is ED_RESERVE and the adapter's reserve RESERVE_TARGET, each plus the 500 rao Bittensor keeps back, so each
 * reads exactly its constant, with no margin (sweepSurplus would sweep it). The token cushion is TOKEN_RESERVE_TARGET
 * (spec §3.2's target for the booked cushion; §7's fundCushion(0.001 FM-TAO)), booked by approve then fundCushion
 * (R4, F-1): a plain transfer of the token is surplus, which anyone's sweepSurplus sends to the treasury, and verify
 * fails while the booked cushion is 0. */
export function fundingStepsV32(plan: PlanV32, live: boolean): string[] {
  const f = FUNDING_V32;
  const adapter = plan.addresses.bitAdapter;
  const vault = f.edReserve + f.existentialDeposit;
  return [
    "Now fund it. These three are yours to send; this tool sends none of them:",
    `  1. Send ${formatEther(vault)} TAO (${wei(vault)}) by substrate transfer to the vault's account ${encodeSs58(plan.vaultColdkey)}: its ED_RESERVE, ${formatEther(f.edReserve)} TAO, plus the ${formatEther(f.existentialDeposit)} TAO Bittensor keeps back. The vault refuses an EVM transfer.`,
    // live, the call file that sends it from the sign page (Task 53's re-review, Minor 2); a fork's rehearsal has none
    `  2. Call fundReserve() on the Bittensor adapter ${adapter} with ${formatEther(f.adapterReserve)} TAO (${wei(f.adapterReserve)}): its RESERVE_TARGET, ${formatEther(f.reserveTarget)} TAO, plus the same ${formatEther(f.existentialDeposit)} TAO.${live ? " pnpm ops fund-reserve --from <0x…> --for-wallet --live writes it for the sign page." : ""}`,
    `  3. Fund the Bittensor adapter ${adapter}'s token cushion with ${formatEther(f.adapterCushion)} FM-TAO (${wei(f.adapterCushion)} of ${LIVE.bittensor.TOKEN} on Bittensor), its TOKEN_RESERVE_TARGET: approve the adapter for it on that token, then call fundCushion(${f.adapterCushion}) on the adapter, from any account that holds it. Never by a plain transfer: that is surplus, and anyone's sweepSurplus() sends it to the treasury.${live ? " pnpm ops fund-cushion --from <0x…> --for-wallet --live writes both for the sign page." : ""}`,
    `Then: pnpm ops verify${live ? " --live" : ""}`,
  ];
}

// ---- the Safe warning (ruling B7a) ----

const SAFE_VIEWS = parseAbi(["function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"]);

/** What signs for `owner` on `chain`, as capsWarning reads it: an account (an EIP-7702 delegated one too), a Safe with
 * its threshold and signer count, a timelock or another contract. */
export async function ownerKindOf(ctx: Pick<Ctx, "rpc">, chain: ChainName, owner: Address): Promise<OwnerKind> {
  const k = await accountKind(ctx, chain, owner);
  if (k.kind === "account") return k.delegation ? { kind: "account", delegation: k.delegation } : { kind: "account" };
  if (k.kind !== "safe") return { kind: k.kind };
  const threshold = (await read(ctx.rpc, chain, { address: owner, abi: SAFE_VIEWS, functionName: "getThreshold" })) as bigint;
  const owners = (await read(ctx.rpc, chain, { address: owner, abi: SAFE_VIEWS, functionName: "getOwners" })) as readonly Address[];
  return { kind: "safe", threshold, owners: owners.length };
}

/** capsWarning for the plan's caps, the deposit cap with Base's owner and maxTotalAssets with Bittensor's: the owner's
 * kind is read only for a cap above the founder level. Warnings only. */
async function capsWarningsV32(ctx: Pick<Ctx, "rpc">, plan: PlanV32): Promise<string[]> {
  const door = stepOf(plan, "frontDoor").args[0] as { depositCap: bigint };
  const vault = stepOf(plan, "vault").args[0] as { maxTotalAssets: bigint };
  const out: string[] = [];
  for (const [chain, caps] of [
    ["base", { depositCap: door.depositCap }],
    ["bittensor", { maxTotalAssets: vault.maxTotalAssets }],
  ] as const) {
    if (capsWarning(caps, { kind: "account" }) === null) continue;
    const w = capsWarning(caps, await ownerKindOf(ctx, chain, plan.roles.owner));
    if (w) out.push(`${chainLabel(chain)}: ${w}`);
  }
  return out;
}

// ---- the record ----

const stepOf = (plan: PlanV32, id: V32StepId): PlannedStepV32 => plan.steps.find((s) => s.id === id)!;
const same = (a: string | null | undefined, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** The v3.2 record at `path` for this kind of run, or null when there is none. A record of the other kind of run, of
 * another version (v3-launch's, v3-test's, v2's) or without its frozen build is refused. */
export function loadRecordV32For(path: string, live: boolean): DeploymentRecordV32 | null {
  const rec = loadRecordFor(path, live) as unknown as DeploymentRecord | DeploymentRecordV32 | null;
  if (!rec) return null;
  if (!isPlanV32(rec.plan)) {
    const v = isPlanV3(rec.plan) ? "v3" : "v2";
    throw new Error(`${path} holds a ${v} deployment, not a v3.2 one: a v3.2 deployment has a name of its own (OPS_DEPLOYMENT=v3.2-launch); nothing sent`);
  }
  const r = rec as DeploymentRecordV32;
  if (!r.build?.dir || !r.build?.hash) throw new Error(`${path} names no frozen build, which a v3.2 record holds from its start; nothing read or sent`);
  return r;
}

/** Where two plans first differ, as a path ("plan.deployers.base"), or null when they are one plan. Addresses and hex
 * compare without case. */
export function planDifference(a: unknown, b: unknown, at = "plan"): string | null {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase() ? null : at;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return at;
    for (let i = 0; i < a.length; i++) {
      const d = planDifference(a[i], b[i], `${at}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const d = planDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return a === b ? null : at;
}

/** Each create's contract is in the build, its planned libraries are exactly its code's link set (no library outside
 * the plan, none left unlinked) and its arguments encode against its constructor: refused, naming each, otherwise. */
function planBuildProblems(plan: PlanV32, build: BuildV32): string[] {
  const out: string[] = [];
  for (const s of plan.steps) {
    try {
      deployDataV32(build, s);
      runtimeCodeV32(build, s);
    } catch (e) {
      out.push(`${chainLabel(s.chain)}: ${s.label}: ${(e as Error).message}`);
    }
  }
  return out;
}

const latestNonce = async (ctx: Pick<Ctx, "rpc">, chain: ChainName, who: Address) =>
  hexToNumber((await ctx.rpc.request(chain, "eth_getTransactionCount", [who, "latest"])) as Hex);

type Receipt = { status: Hex; blockNumber: Hex; gasUsed: Hex; effectiveGasPrice: Hex; contractAddress: Address | null } | null;

/** Settles a create an earlier run signed: mined at the planned address, it is done; still in the pool, the run stops
 * (nothing sent); dropped (unknown, its nonce not taken), it is signed and sent again below; mined and reverted, at
 * another address, or its nonce taken by another transaction, the plan is void. */
async function settlePending(ctx: Ctx, rec: DeploymentRecordV32, save: () => void, voidPlan: (why: string) => PlanVoid): Promise<void> {
  const p = rec.pending;
  if (!p) return;
  const step = stepOf(rec.plan, p.step);
  const planned = rec.plan.addresses[p.step];
  const where = `${chainLabel(p.chain)}: ${step.label} (nonce ${p.nonce})`;
  for (const hash of [...p.hashes].reverse()) {
    const r = (await ctx.rpc.request(p.chain, "eth_getTransactionReceipt", [hash])) as Receipt;
    if (!r) continue;
    if (r.status !== "0x1") throw voidPlan(`${where}, transaction ${hash}, reverted on chain: its nonce is spent, so every later ${chainLabel(p.chain)} address moves`);
    if (!same(r.contractAddress, planned)) throw voidPlan(`${where}, transaction ${hash}, created ${r.contractAddress ?? "no contract"}, not the planned ${planned}`);
    const gasUsed = hexToBigInt(r.gasUsed);
    rec.done[p.step] = { hash, block: hexToNumber(r.blockNumber), gasUsed, costWei: gasUsed * hexToBigInt(r.effectiveGasPrice), address: planned };
    delete rec.pending;
    save();
    ctx.log(`${where}: mined after the last run stopped, at ${planned}; recorded`);
    return;
  }
  for (const hash of p.hashes) {
    if (await ctx.rpc.request(p.chain, "eth_getTransactionByHash", [hash])) {
      throw new Error(`${where}, transaction ${hash}, is still waiting to be mined: run deploy --v32 again once it is; nothing sent`);
    }
  }
  if ((await latestNonce(ctx, p.chain, rec.plan.deployers[p.chain])) > p.nonce) {
    throw voidPlan(`${where}: the nonce was taken by a transaction this record did not sign`);
  }
  // dropped: the loop signs it again at the same nonce, with the same bytes, and keeps every hash
  ctx.log(`${where}: the network dropped it; it is signed and sent again`);
}

/** `plan` with what its keys decide replaced by names: each deployer, each planned address and the vault's coldkey,
 * wherever they appear (the addresses, the constructors' arguments, the links). Two plans of one shape differ only in
 * their fresh keys: the rehearsal's on the forks and the live one (Task 44's re-review, N2). */
export function planShapeV32(plan: PlanV32): unknown {
  const names = new Map<string, string>();
  for (const chain of CHAINS) names.set(plan.deployers[chain].toLowerCase(), `<the ${chain} deployer>`);
  for (const [id, a] of Object.entries(plan.addresses)) names.set(a.toLowerCase(), `<${id}>`);
  names.set(plan.vaultColdkey.toLowerCase(), "<the vault's coldkey>");
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return names.get(x.toLowerCase()) ?? x;
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [names.get(k.toLowerCase()) ?? k, walk(v)]));
    return x;
  };
  return walk(plan);
}

/** Why a live deploy must not send its `build` (Task 44's review, I-2), or null. It sends only what a rehearsal on the
 * forks deployed in full and verified: the rehearsal record at `path` names that build in its `rehearsed` field (Task
 * 61's `rehearse --v32` writes it once the forks' deploy and verify pass), and the two builds must have one identity
 * (buildIdentityV32: the contracts tree, the code, the links and the compiler; not the commit). The rehearsal must also
 * be verified, its read-back passed, and not void (Task 44's re-review, N3), and, given the live `plan`, of that plan but
 * its fresh keys (planShapeV32; N2: a setting changed in ops/ after the rehearsal is refused, though the build is the
 * same). */
export function rehearsalProblem(path: string | undefined, build: BuildV32, buildsDir: string, plan?: PlanV32): string | null {
  const tail = "a live deploy sends only the build Task 61's rehearsal deployed and verified on the forks; nothing frozen or sent";
  if (!path) return `no rehearsal record is named: ${tail}`;
  let reh: DeploymentRecordV32 | null;
  try {
    reh = loadRecordV32For(path, false);
  } catch (e) {
    return `${(e as Error).message.replace(/; nothing.*$/s, "")}: ${tail}`;
  }
  if (!reh) return `there is no rehearsal record at ${path}: ${tail}`;
  const r = reh;
  if (!r.rehearsed) return `${path} names no rehearsed build (its "rehearsed" field, which Task 61's rehearse --v32 writes once the forks' deploy and verify pass): ${tail}`;
  if (r.void) return `${path}'s plan is void (${r.void.reason}): ${tail}`;
  if (!r.verify) return `${path}'s rehearsal was never verified (pnpm ops rehearse --v32 verifies it on the forks): ${tail}`;
  if (!r.verify.ok) return `${path}'s verify failed (${r.verify.failures[0] ?? "no failure named"}): ${tail}`;
  if (r.plan.steps.some((s) => !r.done[s.id]) || !same(r.build.hash, r.rehearsed.buildHash)) {
    return `${path}'s rehearsal is not complete (every create done, and its build the one it names as rehearsed): ${tail}`;
  }
  let rehearsedBuild: BuildV32;
  try {
    rehearsedBuild = loadBuildV32(r.build, buildsDir);
  } catch (e) {
    return `${(e as Error).message.replace(/; nothing.*$/s, "")}: ${tail}`;
  }
  const want = buildIdentityV32(rehearsedBuild);
  const got = buildIdentityV32(build);
  if (got !== want) {
    return `this checkout's contracts and build are ${got} (the contracts tree, the code, the links and the compiler), but the ones rehearsed in ${path} are ${want}: ${tail}`;
  }
  if (plan) {
    const diff = planDifference(planShapeV32(r.plan), planShapeV32(plan));
    if (diff) return `the live plan is not the one rehearsed in ${path} (${diff} differs): a setting changed after the rehearsal, so rehearse again (pnpm ops rehearse --v32): ${tail}`;
  }
  return null;
}

/** Every planned address against the record, on every run (a finished one too): a done step must hold the frozen
 * build's code, and code that is not voids the plan; no code seen yet at a done step (its receipt was good: the RPC is
 * behind) only refuses; an absent step must hold nothing, and code there this record did not send refuses. */
async function presentProblems(ctx: Ctx, rec: DeploymentRecordV32, build: BuildV32, voidPlan: (why: string) => PlanVoid): Promise<string[]> {
  const out: string[] = [];
  for (const s of rec.plan.steps) {
    const at = rec.plan.addresses[s.id];
    const code = await codeAt(ctx.rpc, s.chain, at);
    if (rec.done[s.id]) {
      if (code === "0x") {
        out.push(`${chainLabel(s.chain)}: the record has ${s.label} at ${at} from its receipt, but the RPC shows no code there yet: run deploy --v32 again in a minute`);
        continue;
      }
      const p = codeProblemV32(build, s, code);
      if (p) throw voidPlan(`${chainLabel(s.chain)}: ${s.label} at ${at} is deployed, but ${p}`);
    } else if (code !== "0x") {
      out.push(`${chainLabel(s.chain)}: ${at}, where the plan puts ${s.label}, already holds code this record did not send: it is not the plan's`);
    }
  }
  return out;
}

/** Every check before this run sends anything, after presentProblems' (`present`); each problem named, and nothing sent
 * on either chain when there is one. A deployer that has sent more than the record holds (a key that is not fresh, or a
 * nonce spent outside the plan) voids the plan. */
async function checkBeforeSending(
  ctx: Ctx,
  rec: DeploymentRecordV32,
  build: BuildV32,
  deps: DeployDepsV32,
  voidPlan: (why: string) => PlanVoid,
  present: string[],
): Promise<void> {
  const plan = rec.plan;
  const problems: string[] = [...present];
  let spent: string | undefined;
  for (const chain of CHAINS) {
    const steps = plan.steps.filter((s) => s.chain === chain);
    const left = steps.filter((s) => !rec.done[s.id]);
    if (!left.length) continue;
    const next = left[0];
    const deployer = plan.deployers[chain];
    const who = `the ${chainLabel(chain)} deployer ${deployer}`;
    const latest = await latestNonce(ctx, chain, deployer);
    const pending = await nonceOf(ctx.rpc, chain, deployer);
    if (latest > next.nonce) {
      spent ??= `${who} has sent ${latest} transaction${latest === 1 ? "" : "s"}, and the plan's next create is its nonce ${next.nonce}: ${next.nonce === 0 ? "it is not a fresh key" : "a nonce was spent outside the plan"}`;
    } else if (latest < next.nonce) {
      problems.push(`${who} has sent ${latest} transactions, fewer than the ${next.nonce} this record holds`);
    } else if (pending !== latest) {
      problems.push(`${who} has a transaction waiting at nonce ${latest} that this record did not sign${latest === 0 ? ": it is not a fresh key" : ""}`);
    }
    const price = await gasPriceOf(ctx.rpc, chain);
    const need = fundingNeed(build, left, chain, price);
    const have = await balanceOf(ctx.rpc, chain, deployer);
    if (have < need) {
      problems.push(
        `${who} holds ${formatEther(have)} ${unit(chain)}; its ${left.length} create${left.length === 1 ? "" : "s"} left can cost up to ${formatEther(need)} ${unit(chain)} (the plan's gas at twice today's price${chain === "base" ? ", and Base's L1 fee" : ""}): send it at least ${formatEther(need - have)} ${unit(chain)} more`,
      );
    }
  }
  if (spent) throw voidPlan(spent);
  // DA14: the vault's coldkey is the chain's own mapping of its planned address, or its CREATE reverts
  if (!rec.done.vault) {
    try {
      const got = await deps.readColdkey(ctx, plan.addresses.vault);
      if (!same(got, plan.vaultColdkey)) {
        problems.push(`Bittensor's ADDRESS_MAPPING gives the planned vault ${plan.addresses.vault} the coldkey ${got}, not the plan's ${plan.vaultColdkey}: the vault's CREATE would revert`);
      }
    } catch (e) {
      problems.push(`Bittensor: could not read ADDRESS_MAPPING for the planned vault (${(e as Error).message})`);
    }
  }
  if (!rec.done.oracle) problems.push(...(await oracleProblems(ctx, plan)));
  // Base's creates that read no other planned contract, simulated there now (Task 43's review, M6): the oracle refuses a
  // pool below its MIN_CARDINALITY observations, which would spend Base's nonce 1 after Bittensor is deployed
  const errors = buildErrorsV32(build);
  for (const id of ["baseAdapter", "oracle"] as const) {
    if (rec.done[id]) continue;
    const s = stepOf(plan, id);
    try {
      const out = (await ctx.rpc.request("base", "eth_call", [{ from: plan.deployers.base, data: deployDataV32(build, s) }, "latest"])) as Hex;
      if (!out || out === "0x") problems.push(`Base: ${s.label}, simulated, leaves no code`);
    } catch (e) {
      problems.push(
        isRevert(e)
          ? `Base: ${s.label}, simulated, reverts (${describeRevert(e, errors)}); it must not, once Bittensor is deployed`
          : `Base: could not simulate ${s.label} (${(e as Error).message})`,
      );
    }
  }
  if (problems.length) throw new Error(`The v3.2 deployment cannot go on:\n  ${problems.join("\n  ")}\nNothing sent on either chain.`);
}

const POOL_VIEWS = parseAbi(["function fee() view returns (uint24)"]);

/** The oracle prices what the front door and the staker trade (R3 C-I4; Task 46 reads the deployed values back): its TAO
 * and USDC are the door's and the staker's, and its two pools are the ones route 0 swaps through, by their tokens in the
 * path and by their fee tiers, read on Base. What differs, named. */
async function oracleProblems(ctx: Pick<Ctx, "rpc">, plan: PlanV32): Promise<string[]> {
  const [taoWeth, wethUsdc, tao, weth, usdc] = stepOf(plan, "oracle").args as Address[];
  const door = stepOf(plan, "frontDoor").args[0] as { asset: Address; usdc: Address };
  const staker = stepOf(plan, "staker").args[0] as { tao: Address; usdc: Address; route0: { buyPath: Hex } };
  const out: string[] = [];
  if (!same(tao, door.asset) || !same(tao, staker.tao)) out.push(`Base: the oracle's TAO ${tao} is not the front door's asset ${door.asset} and the staker's TAO ${staker.tao}`);
  if (!same(usdc, door.usdc) || !same(usdc, staker.usdc)) out.push(`Base: the oracle's USDC ${usdc} is not the front door's ${door.usdc} and the staker's ${staker.usdc}`);
  // route 0 buys USDC -> WETH -> TAO: 20-byte tokens with a 3-byte fee tier between each
  const p = staker.route0.buyPath.slice(2).toLowerCase();
  const tokens = [p.slice(0, 40), p.slice(46, 86), p.slice(92, 132)].map((t) => `0x${t}`);
  const fees = [Number.parseInt(p.slice(40, 46), 16), Number.parseInt(p.slice(86, 92), 16)];
  if (p.length !== 132 || !same(tokens[0], usdc) || !same(tokens[1], weth) || !same(tokens[2], tao)) {
    out.push(`Base: route 0's path (${staker.route0.buyPath}) is not USDC, WETH, TAO, the oracle's tokens`);
    return out;
  }
  for (const [pool, fee, pair] of [
    [wethUsdc, fees[0], "WETH/USDC"],
    [taoWeth, fees[1], "TAO/WETH"],
  ] as const) {
    try {
      const got = Number(await read(ctx.rpc, "base", { address: pool, abi: POOL_VIEWS, functionName: "fee" }));
      if (got !== fee) out.push(`Base: the oracle's ${pair} pool ${pool} has the fee tier ${got}, not route 0's ${fee}: the oracle would price another pool than the staker swaps through`);
    } catch (e) {
      out.push(`Base: could not read the fee tier of the oracle's ${pair} pool ${pool} (${(e as Error).message})`);
    }
  }
  return out;
}

const finished = (rec: DeploymentRecordV32) => !rec.pending && rec.plan.steps.every((s) => rec.done[s.id]);

export interface DeployV32Opts {
  /** Each chain's deployer: its keystore and password file, by path, and the address they sign as (the plan's). */
  signers: Record<ChainName, Signer>;
  /** Archive the record and start this plan instead (fresh keys). */
  newPlan?: boolean;
  /** A live deploy: the rehearsal record whose `rehearsed` build the new record's must be (rehearsalProblem). */
  rehearsalPath?: string;
}

/** Deploys `plan` (or resumes it), Bittensor first, saving the record after every step; prints the founder's funding
 * steps when every create is done. A new record freezes the build first (forge build, then build.ts), before anything
 * is sent; a record that exists must hold this very plan. See the top of this file for what is refused. */
export async function deployV32(ctx: Ctx, path: string, plan: PlanV32, deps: DeployDepsV32, opts: DeployV32Opts): Promise<DeploymentRecordV32> {
  // Task 43's review, M1: the adapters' gas is immutable, and the mock figures must not reach mainnet
  if (ctx.live) {
    const p = liveGasProblem(plan.gasSource);
    if (p) throw new Error(p);
  }
  // Revision 28: each scheduler contract's block time is its chain's pin in milliseconds (immutable), never a seconds value
  const msOf = (id: "vault" | "frontDoor") => (plan.steps.find((s) => s.id === id)?.args[0] as { msPerBlock?: bigint } | undefined)?.msPerBlock;
  const blockTimes = msPerBlockProblems({ vault: { msPerBlock: msOf("vault") }, frontDoor: { msPerBlock: msOf("frontDoor") } });
  if (blockTimes.length) throw new Error(`the plan's block times are not the pins:\n  ${blockTimes.join("\n  ")}\nnothing read, frozen or sent`);
  for (const chain of CHAINS) {
    const s = opts.signers[chain];
    if (!same(s.address, plan.deployers[chain])) {
      throw new Error(`the ${chainLabel(chain)} deployer's keystore signs as ${s.address}, not the plan's deployer ${plan.deployers[chain]}; nothing sent`);
    }
  }
  // the live gate and each chain's id, before anything is frozen, planned or read from either chain
  for (const chain of CHAINS) await gate(ctx, chain);
  let rec = loadRecordV32For(path, ctx.live);
  if (rec && opts.newPlan) {
    ctx.log(`Archived the old plan to ${archiveRecord(path)}`);
    rec = null;
  }
  let build: BuildV32;
  if (rec) {
    if (rec.void) throw new PlanVoid(`${path}'s plan is void (${rec.void.reason}): ${FRESH_KEYS} (new deployer keystores, then deploy --v32 --new-plan); nothing sent`);
    const diff = planDifference(rec.plan, plan);
    if (diff) {
      throw new Error(`${path} plans another deployment (${diff} differs): resume it with the inputs it was planned with, or start anew with fresh keys and deploy --v32 --new-plan; nothing sent`);
    }
    build = loadBuildV32(rec.build, deps.buildsDir);
  } else {
    // Task 44's review, I-2: a live build is committed source, recorded, and the very build rehearsed on the forks
    const source = await deps.source(ctx);
    if (ctx.live && source.dirty.length) {
      throw new Error(
        `contracts/ differs from the commit ${source.commit}:\n  ${source.dirty.join("\n  ")}\na live deploy sends only committed source (${SOURCE_PATHS.join(", ")}): commit or undo these; nothing frozen or sent`,
      );
    }
    await deps.buildContracts(ctx);
    const frozen = await freezeBuildV32(ctx.paths.contractsDir, source);
    const problems = planBuildProblems(plan, frozen.build);
    if (problems.length) throw new Error(`the plan does not fit the build:\n  ${problems.join("\n  ")}\nnothing frozen or sent`);
    if (ctx.live) {
      const p = rehearsalProblem(opts.rehearsalPath, frozen.build, deps.buildsDir, plan);
      if (p) throw new Error(p);
    }
    const ref = writeBuildV32(deps.buildsDir, frozen);
    rec = { target: ctx.live ? "live" : "rehearsal", createdAt: new Date().toISOString(), plan, build: ref, done: {} };
    saveRecord(path, rec);
    ctx.log(`Froze the build it sends: ops/builds/${ref.dir}/build.json (keccak256 ${ref.hash})`);
    build = frozen.build;
  }
  const problems = planBuildProblems(plan, build);
  if (problems.length) throw new Error(`the plan does not fit its frozen build:\n  ${problems.join("\n  ")}\nnothing sent`);
  const r = rec;
  const save = () => saveRecord(path, r);
  const voidPlan = (why: string) => {
    r.void = { at: new Date().toISOString(), reason: why };
    delete r.pending;
    save();
    return new PlanVoid(`${why}. The plan is void: ${FRESH_KEYS}; nothing more is sent.`);
  };
  await settlePending(ctx, r, save, voidPlan);
  const present = await presentProblems(ctx, r, build, voidPlan);
  if (!finished(r)) {
    await checkBeforeSending(ctx, r, build, deps, voidPlan, present);
    for (const line of await capsWarningsV32(ctx, plan)) ctx.log(line);
    const count = (chain: ChainName) => plan.steps.filter((s) => s.chain === chain && !r.done[s.id]).length;
    ctx.log(`Deploying v3.2, Bittensor first: ${count("bittensor")} creates from ${plan.deployers.bittensor}, then ${count("base")} on Base from ${plan.deployers.base}.`);
    const ctxOf = { bittensor: { ...ctx, signer: opts.signers.bittensor }, base: { ...ctx, signer: opts.signers.base } };
    for (const step of plan.steps) {
      if (r.done[step.id]) continue;
      const at = plan.addresses[step.id];
      try {
        r.done[step.id] = await deps.sendCreate(ctxOf[step.chain], { ...step, build, gasCeiling: gasCeiling(build, step) }, at, {
          // every hash it is signed with stays until a receipt settles it (Task 44's review, M2)
          signed: (hash) => {
            const kept = r.pending?.step === step.id ? r.pending.hashes.filter((h) => h !== hash) : [];
            r.pending = { step: step.id, chain: step.chain, nonce: step.nonce, hashes: [...kept, hash] };
            save();
          },
        });
      } catch (e) {
        if (e instanceof RevertedOnChain) throw voidPlan(`${e.message}: its nonce is spent, so every later ${chainLabel(step.chain)} address moves`);
        if (e instanceof UnexpectedReceipt) throw voidPlan(e.message);
        if (e instanceof CodeNotYetSeen) {
          // the controller's ruling on M3: done from its receipt; the next run checks the code before anything is sent
          r.done[step.id] = e.sent;
          delete r.pending;
          save();
          throw new Error(`${e.message}. It is recorded from its receipt, and the next run checks its code before anything more is sent: run deploy --v32 again in a minute.`);
        }
        if (e instanceof ReceiptTimeout) throw new Error(`${e.message}. The record keeps its hash: run deploy --v32 again once it is mined.`);
        throw e;
      }
      delete r.pending;
      save();
      ctx.log(`${chainLabel(step.chain)}: ${step.label} — done, at ${at}`);
    }
  } else {
    if (present.length) throw new Error(`The v3.2 deployment's code cannot be checked yet:\n  ${present.join("\n  ")}\nNothing sent.`);
    ctx.log("Every create of the plan is done.");
  }
  for (const line of fundingStepsV32(plan, ctx.live)) ctx.log(line);
  return r;
}

/** `pnpm ops deploy --v32`: the plan from the environment (the deployers' keystores, by path, the validators and the
 * keeper's address, a fresh key), the founder's other roles and the measured inputs, then deployV32, holding the
 * deployment's run lock throughout (Task 44's review, M5: two runs at once would overwrite each other's record), the one
 * `pnpm ops run` takes. Refused, reading nothing, for a deployment not named v3.2-…, while the lock is held, while the
 * plan's measured inputs or the keeper's address are missing, and, with --live, while the adapters' gas models are the
 * mock ones. A live run's build must be the rehearsal record's (recordPath(env, false)). */
export async function deployV32FromEnv(ctx: Ctx, env: Env, path: string, o: { newPlan: boolean }, deps: DeployDepsV32 = realDepsV32): Promise<DeploymentRecordV32> {
  if (!isV32Deployment(env)) throw new Error("deploy --v32 is for a v3.2 deployment, whose record is its own: set OPS_DEPLOYMENT=v3.2-launch; nothing read or sent");
  mkdirSync(dirname(path), { recursive: true });
  const release = takeRunLock(runLockPath(path), { log: ctx.log });
  try {
    return await planAndDeploy(ctx, env, path, o, deps);
  } finally {
    release();
  }
}

async function planAndDeploy(ctx: Ctx, env: Env, path: string, o: { newPlan: boolean }, deps: DeployDepsV32): Promise<DeploymentRecordV32> {
  if (ctx.live) {
    const p = liveGasProblem((SETTINGS_V32_LAUNCH.gas as SettingsV32["gas"]).source);
    if (p) throw new Error(p);
  }
  const floors = MEASURED_V32.poolFloors;
  const claimGas = MEASURED_V32.claimGasRequired;
  if (!floors || claimGas === undefined) {
    const missing = [!floors ? "the pool floors (Task 61 step 4 measures them)" : "", claimGas === undefined ? "claimGasRequired (Tasks 64 and 65)" : ""].filter(Boolean).join(" and ");
    throw new Error(`the v3.2 plan's measured inputs are not in ops/src/v32/settings.ts MEASURED_V32 yet: ${missing}; nothing read or sent`);
  }
  const keys = deployerKeysFromEnv(env);
  const validators = validatorsFromEnv(env);
  const roles = rolesV32FromEnv(env);
  const signers = {} as Record<ChainName, Signer>;
  for (const chain of CHAINS) {
    const address = await signingAccount(ctx, keys[chain]);
    const envName = chain === "base" ? V32_ENV.baseKeystore : V32_ENV.bittensorKeystore;
    if (!address) throw new Error(`the ${chainLabel(chain)} deployer's keystore (${envName}) does not open with its password file; nothing read or sent`);
    signers[chain] = { address: getAddress(address), keystore: keys[chain].keystore, passwordFile: keys[chain].passwordFile, name: `the ${chainLabel(chain)} deployer` };
  }
  const deployers = { base: signers.base.address, bittensor: signers.bittensor.address };
  const vault = plannedAddressesV32(deployers).vault;
  const plan = buildPlanV32({ deployers, roles, validators, vaultColdkey: addressMapping(vault), poolFloors: floors, claimGasRequired: claimGas });
  return deployV32(ctx, path, plan, deps, { signers, newPlan: o.newPlan, rehearsalPath: recordPathOf(env, false) });
}
