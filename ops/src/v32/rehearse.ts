import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, encodeFunctionData, formatEther, getAddress, getContractAddress, type Hex, hexToBigInt, numberToHex, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadArtifact } from "../artifacts.ts";
import { type ChainName, type Env, LIVE, PRECOMPILE, recordPath } from "../config.ts";
import { type Receipt, type Rehearsal, receiptOf, settleDebits, startForks } from "../rehearse.ts";
import { saveRecord, type VerifyResult } from "../record.ts";
import { balanceOf, createRpc, read, type Rpc } from "../rpc.ts";
import { bin, type Ctx, chainLabel, describeRevert, type Sent, type Signer } from "../send.ts";
import { parseWalletFile } from "../wallet.ts";
import type { CreateRequestV32 } from "../types.ts";
import { type BuildV32, deployDataV32, frozenContract, loadBuildV32 } from "./build.ts";
import { CONSTRUCTOR_GAS, type DeployDepsV32, type DeploymentRecordV32, deployV32, gasCeiling, realDepsV32 } from "./deploy.ts";
import { installStandInsV32, listHotkeys, mapVault, replayStorage } from "./fork-standins.ts";
import { disableBridgeFileCommand, fundCushionFileCommand, fundReserveFileCommand, idleBufferFileCommand, pauseFileCommand, redeemOriginFileCommand, setKeeperFileCommand } from "./hotkey-files.ts";
import { readDoor, readVault } from "./lens.ts";
import { addressMapping, buildPlanV32, CONTRACTS_V32, type PlannedStepV32, type PlanV32, plannedAddressesV32, type V32StepId } from "./plan.ts";
import { prepareSignV32 } from "./sign.ts";
import { FUNDING_V32, isV32Deployment, MEASURED_V32, rolesV32FromEnv, type V32Roles, type V32Validators, validatorsFromEnv } from "./settings.ts";
import { delegatesKey, totalHotkeyAlphaKey, uidsKey } from "./validators.ts";
import { verifyV32 } from "./verify.ts";

// `pnpm ops rehearse --v32` (plan Task 61 step 3; spec §9.4): v3.2's deployment on two local anvil forks of the live
// chains, which keep the live chain ids (runbook section 6: the sign page serves files for 8453 and 964 only, and the
// founder's step 5 points the Ledger at these forks), exactly as `pnpm ops deploy --v32` sends it live. What is signed
// here is signed by fresh keys made for the run and deleted after it, holding nothing on either chain; the Ledger's
// accounts are impersonated, never signed for. The record stays a rehearsal's (rehearsal-<name>.json). the same plan from the same inputs (the validators, the roles with a guardian apart from
// the owner, the keeper's address, the measured pool floors), every contract by plain CREATE from fresh keys at nonce 0
// on each chain, signed by their keystores through the raw-signed path, the four libraries and both lenses included.
// Then:
// - the founder's steps of runbook 3.2 to 3.4 on the forks: the vault's ED_RESERVE, fund-reserve, the FM-TAO for the
//   cushion from ForeverMoney's depositLiquid by a plain account, fund-cushion, the treasury's redeem origin, each file
//   checked by the sign page's own checks (prepareSignV32 and its re-check before each call) and sent by its account;
// - verify, code and state, which must pass;
// - the three deployments verify must fail (spec §9.4), each from fresh keys with one create changed and funded like
//   the real one, so its only failures are the change: a vault linked to an L1 built from different code, a correct L1
//   at an address other than the plan's, and the vault's lens bound to another vault;
// - the owner's and the guardian's settings on the sign page (set-keeper, the front door's pause and the owner's
//   unpause, set-idle-buffer, the guardian's disable-bridge), on a snapshot the run then reverts.
// The record (rehearsal-<name>.json) keeps each create's gas and the read-back, and names the build as `rehearsed` only
// when all of it passed: a live deploy sends only that build, of that plan (deploy.ts rehearsalProblem). The precompiles
// are stand-ins (fork-standins.ts): gas measured against them is not Bittensor's.

const TAO = 10n ** 18n;
/** What claimGasRequired the rehearsal plans with while Tasks 64 and 65 have measured none: the vault's former default,
 * inside its bounds. A live deploy then refuses this rehearsal (its plan differs), so it runs again once one is set. */
export const REHEARSAL_CLAIM_GAS = 55_000_000n;
/** The deployers' balance on the forks: far above any plan's gas. */
const DEPLOYER_FUNDS: Record<ChainName, bigint> = { base: 10n * TAO, bittensor: 1_000n * TAO };
/** The FM-TAO deposit (runbook 3.2 step 3): the chain's minimum stake, 0.002 TAO, as a whole number of rao. */
export const FM_DEPOSIT = 2n * 10n ** 15n;
/** ForeverMoney's AlphaVault's position in the staking stand-in (20,000 TAO, in rao), as v3-launch's rehearsal seeds it. */
const ALPHA_SEED_RAO = 20_000n * 10n ** 9n;
/** Calls the stand-in's setup functions; any account will do on a fork. */
const HARNESS: Address = "0x00000000000000000000000000000000c0ffee01";

const ALPHA = parseAbi([
  "function positionOf(address token) view returns (bytes32 validator, uint256 netuid)",
  "function vaultColdkey() view returns (bytes32)",
  "function depositLiquid(address token, uint256 minAlphaRao) payable returns (uint256 minted)",
]);
const STAND_IN = parseAbi(["function setColdkeyAlias(address who, bytes32 coldkey)", "function seedStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid, uint256 rao)"]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** What the rehearsal plans with, from the environment as deploy --v32 takes it; refused, nothing started, when not ready. */
export interface RehearsalInputsV32 {
  validators: V32Validators;
  roles: V32Roles;
  poolFloors: [bigint, bigint];
  claimGasRequired: bigint;
  /** claimGasRequired is REHEARSAL_CLAIM_GAS, not a measurement. */
  claimGasStandIn: boolean;
}

export function rehearsalInputsV32(env: Env): RehearsalInputsV32 {
  if (!isV32Deployment(env)) throw new Error("rehearse --v32 rehearses a v3.2 deployment, whose record is its own: set OPS_DEPLOYMENT=v3.2-launch; nothing started");
  const floors = MEASURED_V32.poolFloors;
  if (!floors) throw new Error("the pool floors are not in ops/src/v32/settings.ts MEASURED_V32 yet (pnpm ops pool-floors measures them); nothing started");
  const validators = validatorsFromEnv(env);
  const roles = rolesV32FromEnv(env);
  const measured = MEASURED_V32.claimGasRequired;
  return { validators, roles, poolFloors: [floors[0], floors[1]], claimGasRequired: measured ?? REHEARSAL_CLAIM_GAS, claimGasStandIn: measured === undefined };
}

// ---- the forks' plumbing ----

/** A fresh key for the forks, in a keystore of its own (cast wallet new) in `dir`, with its password file. */
async function freshSigner(ctx: Ctx, dir: string, name: string): Promise<Signer> {
  const pw = join(dir, `${name}.pw`);
  writeFileSync(pw, `rehearsal-${name}`);
  const out = await ctx.runner.run(bin(ctx, "cast"), ["wallet", "new", dir, name, "--unsafe-password", `rehearsal-${name}`], { cwd: ctx.paths.contractsDir });
  const address = out.stdout.match(/0x[0-9a-fA-F]{40}/)?.[0];
  if (out.code !== 0 || !address) throw new Error(`cast wallet new could not make the fork key ${name} (${(out.stderr || out.stdout).trim().split("\n")[0]})`);
  return { address: getAddress(address), keystore: join(dir, name), passwordFile: pw, name: `the fork's ${name}` };
}

const setBalance = (rpc: Rpc, chain: ChainName, who: Address, wei: bigint) => rpc.request(chain, "anvil_setBalance", [who, numberToHex(wei)]);

/** One transaction from `from`, impersonated (the Ledger's accounts and the fork's plain accounts alike), its balance
 * raised first when it can't pay the value and the gas. */
export async function sendFrom(ctx: Pick<Ctx, "rpc">, chain: ChainName, from: Address, tx: { to?: Address; data: Hex; value?: bigint; gas?: bigint }, label: string): Promise<Receipt> {
  const { rpc } = ctx;
  const value = tx.value ?? 0n;
  const need = value + TAO;
  if ((await balanceOf(rpc, chain, from)) < need) await setBalance(rpc, chain, from, need);
  await rpc.request(chain, "anvil_impersonateAccount", [from]);
  try {
    let hash: Hex;
    try {
      hash = (await rpc.request(chain, "eth_sendTransaction", [
        { from, ...(tx.to ? { to: tx.to } : {}), data: tx.data, value: numberToHex(value), ...(tx.gas ? { gas: numberToHex(tx.gas) } : {}) },
      ])) as Hex;
    } catch (e) {
      throw new Error(`${label} would fail (${describeRevert(e)})`);
    }
    const r = await receiptOf(rpc, chain, hash);
    if (r.status !== "0x1") throw new Error(`${label} reverted (transaction ${hash})`);
    return r;
  } finally {
    await rpc.request(chain, "anvil_stopImpersonatingAccount", [from]);
  }
}

const chainOfId = (rec: Pick<DeploymentRecordV32, "target">, id: number): ChainName => (id === (rec.target === "live" ? 8453 : 31337) ? "base" : "bittensor");

/** A call file as the founder would sign it: checked by the sign page's own checks (prepareSignV32: it refuses what the
 * page would not serve), a call the page re-checks just before it goes asked again there (api.check, as the page's
 * POST /check), then each call sent from the account the file names, in order. Returns each call's gas. */
export async function signFile(ctx: Ctx, rec: DeploymentRecordV32, file: string, log: (l: string) => void): Promise<bigint[]> {
  const f = parseWalletFile(JSON.parse(readFileSync(file, "utf8")));
  const { view, api } = await prepareSignV32(f, onForks(rec), { ctx }, Date.now());
  for (const w of view.warnings) log(`  the sign page warns: ${w.split(/\r?\n/)[0]}`);
  const gas: bigint[] = [];
  for (const [i, c] of f.calls.entries()) {
    const a = view.calls[i]?.recheck ? await api.check(i) : { ok: true, text: "" };
    if (!a.ok) throw new Error(`the sign page refuses ${c.label} (call ${i + 1} of ${f.calls.length}): ${a.text}`);
    const chain = chainOfId(onForks(rec), c.chainId);
    const r = await sendFrom(ctx, chain, getAddress(c.from), { to: getAddress(c.to), data: c.data, value: BigInt(c.value) }, c.label);
    if (chain === "bittensor") await settleDebits(ctx.rpc, r.logs);
    gas.push(hexToBigInt(r.gasUsed));
    log(`  ${chainLabel(chain)}: ${c.label}, from ${getAddress(c.from)}: sent (${hexToBigInt(r.gasUsed).toLocaleString("en-US")} gas)`);
  }
  return gas;
}

/** The forks' chain ids: the live ones (see the top of this file). */
export const FORK_CHAIN_IDS: Record<ChainName, number> = { base: LIVE.base.CHAIN_ID, bittensor: LIVE.bittensor.CHAIN_ID };

/** The record as the call-file writers and the sign page see it on these forks: its chain ids the live ones (chainIdFor
 * reads them off `target`). Only in memory: the record on disk stays a rehearsal's. */
export const onForks = (rec: DeploymentRecordV32): DeploymentRecordV32 => ({ ...rec, target: "live" });

/** The v3.2 stand-ins over startForks' (fork-standins.ts), ForeverMoney's AlphaVault's position in the staking stand-in,
 * and the validators' storage replayed from the live chain (read now from the public archive node). */
async function prepareForks(r: Rehearsal, validators: V32Validators, log: (l: string) => void): Promise<void> {
  const { ctx } = r;
  await installStandInsV32(ctx.rpc, loadArtifact(ctx.paths.contractsDir, "RehearsalStaking").deployedBytecode as Hex);
  const live = createRpc({ base: { rpcUrl: "https://mainnet.base.org" }, bittensor: { rpcUrl: "https://archive.chain.opentensor.ai" } });
  const keys = [validators.primary, validators.standby].flatMap((h) => [delegatesKey(h), totalHotkeyAlphaKey(h, 0), uidsKey(0, h)]);
  await replayStorage(ctx.rpc, live, keys);
  await listHotkeys(ctx.rpc, [validators.primary, validators.standby]);
  const [validator, netuid] = (await read(ctx.rpc, "bittensor", { address: LIVE.ALPHA_VAULT, abi: ALPHA, functionName: "positionOf", args: [LIVE.bittensor.TOKEN] })) as readonly [Hex, bigint];
  const avColdkey = (await read(ctx.rpc, "bittensor", { address: LIVE.ALPHA_VAULT, abi: ALPHA, functionName: "vaultColdkey" })) as Hex;
  const setup = (functionName: string, args: unknown[]) =>
    sendFrom(ctx, "bittensor", HARNESS, { to: PRECOMPILE.staking, data: encodeFunctionData({ abi: STAND_IN, functionName, args } as never) }, `the stand-in's ${functionName}`);
  await setup("setColdkeyAlias", [LIVE.ALPHA_VAULT, avColdkey]);
  await setup("seedStake", [validator, avColdkey, netuid, ALPHA_SEED_RAO]);
  log("Installed v3.2's precompile stand-ins on the Bittensor fork (the address mapping's table, the staking front, the storage replay of both validators read live) and ForeverMoney's AlphaVault's position");
}

// ---- the deployment ----

export interface Deployed {
  rec: DeploymentRecordV32;
  path: string;
  build: BuildV32;
}

/** One deployment on the forks through deployV32, from two fresh keys, of the plan the inputs make; `tamper` changes one
 * create on its way (a negative run). */
async function deployOnForks(
  r: Rehearsal,
  inputs: RehearsalInputsV32,
  o: { path: string; keysDir: string; tag: string; noBuild: boolean; tamper?: (req: CreateRequestV32, predicted: Address) => Promise<CreateRequestV32> },
): Promise<Deployed> {
  const { ctx } = r;
  const signers = { bittensor: await freshSigner(ctx, o.keysDir, `${o.tag}-bittensor-deployer`), base: await freshSigner(ctx, o.keysDir, `${o.tag}-base-deployer`) };
  for (const chain of ["bittensor", "base"] as const) await setBalance(ctx.rpc, chain, signers[chain].address, DEPLOYER_FUNDS[chain]);
  const deployers = { bittensor: signers.bittensor.address, base: signers.base.address };
  const vault = plannedAddressesV32(deployers).vault;
  // the stand-ins answer the planned vault's real coldkey before its CREATE (deploy reads it first)
  await mapVault(ctx.rpc, vault);
  const plan = buildPlanV32({ deployers, roles: inputs.roles, validators: inputs.validators, vaultColdkey: addressMapping(vault), poolFloors: inputs.poolFloors, claimGasRequired: inputs.claimGasRequired });
  const deps: DeployDepsV32 = {
    ...realDepsV32,
    buildContracts: o.noBuild
      ? async (c) => c.log("Not building contracts/ (--no-build): freezing contracts/out as it is; a live deploy builds, and refuses unless its build is the one rehearsed")
      : realDepsV32.buildContracts,
    sendCreate: async (c, req, predicted, hooks) => realDepsV32.sendCreate(c, o.tamper ? await o.tamper(req, predicted) : req, predicted, hooks),
  };
  const rec = await deployV32(ctx, o.path, plan, deps, { signers, newPlan: true });
  return { rec, path: o.path, build: loadBuildV32(rec.build, deps.buildsDir) };
}

/** The founder's steps of runbook 3.2 and 3.4 on the forks, each a file checked by the sign page and sent by its
 * account: the vault's ED_RESERVE (a substrate transfer there; its balance here), fundReserve from a plain account, that
 * account's FM-TAO from ForeverMoney's depositLiquid, the cushion's approve and fundCushion, the treasury's redeem
 * origin. Returns what it saw. */
async function founderSteps(r: Rehearsal, d: Deployed, o: { walletDir: string; name: string }, log: (l: string) => void): Promise<{ minted: bigint; gas: Record<string, bigint> }> {
  const { ctx } = r;
  const { rec } = d;
  const a = rec.plan.addresses;
  const files = { dir: o.walletDir, name: o.name, now: Date.now() };
  const gas: Record<string, bigint> = {};
  const sum = (xs: bigint[]) => xs.reduce((t, x) => t + x, 0n);
  // 1. the vault's ED_RESERVE: on Bittensor a substrate transfer of 1,500 rao, which its EVM reads as 1,000 (ED_RESERVE)
  await setBalance(ctx.rpc, "bittensor", a.vault, (await balanceOf(ctx.rpc, "bittensor", a.vault)) + FUNDING_V32.edReserve);
  log(`Runbook 3.2 step 1: the vault ${a.vault} holds its ED_RESERVE, ${formatEther(FUNDING_V32.edReserve)} TAO (a substrate transfer on Bittensor; its balance set here)`);
  // 2. fundReserve() from a plain account
  const funder = privateKeyToAccount(generatePrivateKey()).address;
  await setBalance(ctx.rpc, "bittensor", funder, TAO);
  const reserve = await fundReserveFileCommand(ctx, onForks(rec), { ...files, from: funder });
  log(`Runbook 3.2 step 2: pnpm ops fund-reserve --from ${funder} --for-wallet: ${reserve.lines[0]}`);
  gas.fundReserve = sum(await signFile(ctx, rec, reserve.files[0], log));
  // 3. the FM-TAO from ForeverMoney: depositLiquid from the same plain account, then the cushion's two calls
  const before = (await read(ctx.rpc, "bittensor", { address: LIVE.bittensor.TOKEN, abi: ERC20, functionName: "balanceOf", args: [funder] })) as bigint;
  const minAlphaRao = FM_DEPOSIT / 10n ** 9n - 1n;
  const dep = await sendFrom(
    ctx,
    "bittensor",
    funder,
    { to: LIVE.ALPHA_VAULT, data: encodeFunctionData({ abi: ALPHA, functionName: "depositLiquid", args: [LIVE.bittensor.TOKEN, minAlphaRao] }), value: FM_DEPOSIT },
    `depositLiquid(${LIVE.bittensor.TOKEN}, ${minAlphaRao}) on ForeverMoney's AlphaVault`,
  );
  await settleDebits(ctx.rpc, dep.logs);
  const minted = ((await read(ctx.rpc, "bittensor", { address: LIVE.bittensor.TOKEN, abi: ERC20, functionName: "balanceOf", args: [funder] })) as bigint) - before;
  gas.depositLiquid = hexToBigInt(dep.gasUsed);
  log(
    `Runbook 3.2 step 3: the plain account ${funder} (no code, no role) called depositLiquid(token, ${minAlphaRao}) on ForeverMoney's AlphaVault ${LIVE.ALPHA_VAULT} with ${formatEther(FM_DEPOSIT)} TAO: it minted ${formatEther(minted)} FM-TAO to the sender (${hexToBigInt(dep.gasUsed).toLocaleString("en-US")} gas, against the staking stand-in)`,
  );
  const cushion = await fundCushionFileCommand(ctx, onForks(rec), { ...files, from: funder });
  log(`Runbook 3.2 step 3: pnpm ops fund-cushion --from ${funder} --for-wallet: ${cushion.lines[0]}`);
  gas.fundCushion = sum(await signFile(ctx, rec, cushion.files[0], log));
  // 3.4: the treasury's redeem origin
  const origin = await redeemOriginFileCommand(ctx, onForks(rec), files);
  log(`Runbook 3.4: pnpm ops set-redeem-origin --for-wallet: ${origin.lines[0]}`);
  if (origin.files[0]) gas.setRedeemOrigin = sum(await signFile(ctx, rec, origin.files[0], log));
  return { minted, gas };
}

// ---- the negatives (spec §9.4) ----

/** `build` with one byte of `name`'s code changed, as an edit to its source would change it: the first PUSH4's first
 * byte past the immutables and links, in its runtime code and in the copy of it its creation code carries. */
export function differentBuild(build: BuildV32, name: string): { build: BuildV32; at: number } {
  const c = build.contracts[name];
  const runtime = c.deployedBytecode.object.slice(2);
  const creation = c.bytecode.object.slice(2);
  const start = creation.indexOf(runtime);
  if (start < 0 || start % 2) throw new Error(`${name}'s creation code does not carry its runtime code as it is`);
  const taken = new Set<number>();
  for (const ranges of Object.values(c.deployedBytecode.immutableReferences)) for (const x of ranges) for (let i = x.start; i < x.start + x.length; i++) taken.add(i);
  for (const libs of Object.values(c.deployedBytecode.linkReferences)) for (const offs of Object.values(libs)) for (const x of offs) for (let i = x.start; i < x.start + x.length; i++) taken.add(i);
  const bytes = runtime.length / 2;
  let at = -1;
  for (let i = 0; i < bytes; i++) {
    const op = Number.parseInt(runtime.slice(2 * i, 2 * i + 2), 16);
    if (op === 0x63 && !taken.has(i + 1)) {
      at = i + 1;
      break;
    }
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  if (at < 0) throw new Error(`${name}'s runtime code has no PUSH4 to change`);
  const flip = (hex: string, byte: number) => {
    const v = Number.parseInt(hex.slice(2 * byte, 2 * byte + 2), 16) ^ 0x01;
    return `${hex.slice(0, 2 * byte)}${v.toString(16).padStart(2, "0")}${hex.slice(2 * byte + 2)}`;
  };
  const changed = {
    ...c,
    bytecode: { ...c.bytecode, object: `0x${flip(creation, start / 2 + at)}` as Hex },
    deployedBytecode: { ...c.deployedBytecode, object: `0x${flip(runtime, at)}` as Hex },
  };
  return { build: { ...build, contracts: { ...build.contracts, [name]: changed } }, at };
}

export interface NegativeV32 {
  id: "l1-different-build" | "l1-other-address" | "lens-wrong-target";
  what: string;
  /** The failure lines that prove verify caught it: each must name the changed contract. */
  expect: RegExp[];
  /** Every failure must be about the change, so it fails for no other reason. */
  about: RegExp;
}

export const NEGATIVES_V32: readonly NegativeV32[] = [
  {
    id: "l1-different-build",
    what: "a vault linked to an L1 (CascadeBatchLib) built from different code, at the plan's address",
    expect: [/^Bittensor CascadeBatchLib: its runtime code is not the frozen build's, filled in from the plan: they first differ at byte \d+$/],
    about: /CascadeBatchLib/,
  },
  {
    id: "l1-other-address",
    what: "a vault linked to a correct L1 build deployed at an address other than the plan's",
    expect: [/^Bittensor CascadeVault's reference to CascadeBatchLib at byte \d+ names 0x[0-9a-fA-F]{40}, not the plan's 0x[0-9a-fA-F]{40}$/, /^Bittensor CascadeVault: its runtime code is not the frozen build's.*\(the reference to CascadeBatchLib\)/],
    about: /CascadeBatchLib/,
  },
  {
    id: "lens-wrong-target",
    what: "the vault's lens bound to the wrong target (another deployment's vault)",
    expect: [/^Bittensor CascadeVaultLens: its runtime code is not the frozen build's.*\(the immutable target\)/],
    // the rails read the vault's bridges through its lens, so they read the other vault's and disagree
    about: /CascadeVaultLens|^The rails: now the two chains disagree on the bridge/,
  },
];

/** The tampered create for a negative run. `otherVault` is the real deployment's vault (the wrong target); `deployL1`
 * deploys a correct L1 elsewhere and gives its address. */
function tamperFor(n: NegativeV32, o: { build: BuildV32; otherVault: Address; deployL1: () => Promise<Address> }): (req: CreateRequestV32) => Promise<CreateRequestV32> {
  const l1 = CONTRACTS_V32.batchLib.contract;
  return async (req) => {
    // deployV32 hands each create over as its planned step, so the request carries the step's id
    const id = (req as CreateRequestV32 & { id?: V32StepId }).id;
    if (n.id === "l1-different-build" && id === "batchLib") return { ...req, build: differentBuild(req.build, "CascadeBatchLib").build };
    if (n.id === "l1-other-address" && id === "vault") return { ...req, libraries: { ...(req.libraries ?? {}), [l1]: await o.deployL1() } };
    if (n.id === "lens-wrong-target" && id === "vaultLens") return { ...req, args: [o.otherVault] };
    return req;
  };
}

/** What verify said of a negative run against what it must say: every expected line present, and every failure about
 * the change. */
export function negativeProblems(n: NegativeV32, failures: readonly string[]): string[] {
  const out: string[] = [];
  if (!failures.length) out.push(`verify passed ${n.what}: it must fail`);
  for (const e of n.expect) if (!failures.some((f) => e.test(f))) out.push(`verify did not say ${e.source}`);
  for (const f of failures) if (!n.about.test(f)) out.push(`verify failed for another reason too: ${f}`);
  return out;
}

// ---- the gas ----

/** Each create's gas as measured on the forks, against its ceiling and its constructor's allowance (CONSTRUCTOR_GAS): the
 * intrinsic gas and the code deposit counted exactly (4 a zero byte, 16 another), the rest the constructor's. */
export function gasRows(plan: PlanV32, build: BuildV32, done: Partial<Record<V32StepId, Sent>>): { step: PlannedStepV32; gasUsed: bigint; ceiling: bigint; constructor: bigint; allowance: bigint }[] {
  return plan.steps.map((step) => {
    const data = deployDataV32(build, step).slice(2);
    let calldata = 0n;
    for (let i = 0; i < data.length; i += 2) calldata += data.slice(i, i + 2) === "00" ? 4n : 16n;
    const bytes = BigInt(data.length / 2);
    const runtime = BigInt((frozenContract(build, step).deployedBytecode.object.length - 2) / 2);
    const fixed = 53_000n + calldata + 2n * ((bytes + 31n) / 32n) + 200n * runtime;
    const gasUsed = done[step.id]?.gasUsed ?? 0n;
    return { step, gasUsed, ceiling: gasCeiling(build, step), constructor: gasUsed - fixed, allowance: CONSTRUCTOR_GAS[step.id] };
  });
}

const n = (x: bigint) => x.toLocaleString("en-US");

export function gasLines(rows: ReturnType<typeof gasRows>, plan: PlanV32): string[] {
  const out = ["Each create's gas on the forks (its address; gas used; the plan's ceiling; the constructor's share against its CONSTRUCTOR_GAS allowance):"];
  for (const r of rows) {
    out.push(
      `  ${chainLabel(r.step.chain)} nonce ${r.step.nonce}: ${CONTRACTS_V32[r.step.id].contract.split(":")[1]} at ${plan.addresses[r.step.id]}: ${n(r.gasUsed)} gas (ceiling ${n(r.ceiling)}; constructor ${n(r.constructor)} of ${n(r.allowance)})`,
    );
  }
  for (const chain of ["bittensor", "base"] as const) out.push(`  ${chainLabel(chain)} in all: ${n(rows.filter((r) => r.step.chain === chain).reduce((t, r) => t + r.gasUsed, 0n))} gas`);
  return out;
}

// ---- the run ----

const verifyResult = (f: { failures: string[]; warnings: string[] }): VerifyResult => ({
  ok: f.failures.length === 0,
  failures: f.failures,
  ...(f.warnings.length ? { warnings: f.warnings } : {}),
  checkedAt: new Date().toISOString(),
});

async function snapshot(rpc: Rpc): Promise<Record<ChainName, Hex>> {
  return { base: (await rpc.request("base", "evm_snapshot", [])) as Hex, bittensor: (await rpc.request("bittensor", "evm_snapshot", [])) as Hex };
}

async function revert(rpc: Rpc, s: Record<ChainName, Hex>): Promise<void> {
  for (const chain of ["base", "bittensor"] as const) {
    if (!(await rpc.request(chain, "evm_revert", [s[chain]]))) throw new Error(`the ${chainLabel(chain)} fork did not go back to its snapshot`);
  }
}

/** The owner's and the guardian's settings from the sign page (runbook 2.6, 7.1, 7.6; section 11's T61 list), on a
 * snapshot reverted after: each file checked by the page and sent, and what the contracts and verify then say. */
async function settingsSteps(r: Rehearsal, d: Deployed, o: { walletDir: string; name: string }, log: (l: string) => void): Promise<string[]> {
  const { ctx } = r;
  const { rec } = d;
  const files = { dir: o.walletDir, name: o.name, now: Date.now() };
  const a = rec.plan.addresses;
  const said: string[] = [];
  const s = await snapshot(ctx.rpc);
  try {
    // 2.6: the keeper's rotation, one file, both chains
    const fresh = privateKeyToAccount(generatePrivateKey()).address;
    const k = await setKeeperFileCommand(ctx, onForks(rec), { ...files, keeper: fresh });
    log(`Runbook 2.6 step 3: pnpm ops set-keeper ${fresh} --for-wallet`);
    await signFile(ctx, rec, k.files[0], log);
    const keepers = [await readVault(ctx, rec, "keeper"), await readDoor(ctx, rec, "keeper")].map((x) => getAddress(x as Address));
    const v1 = await verifyV32(ctx, rec);
    const rotated = v1.info.find((l) => l.startsWith("The keeper: keeper() is"));
    said.push(`set-keeper: keeper() is ${keepers[0]} on the vault and ${keepers[1]} on the front door; verify: ${v1.failures.length} failures${rotated ? `, "${rotated.slice(0, 90)}…"` : ""}`);
    // 7.1 step 1: the guardian's pause of the front door, then the owner's unpause
    const p = await pauseFileCommand(ctx, onForks(rec), { ...files, action: "pause", target: "front-door", as: "guardian" });
    log("Runbook 7.1 step 1: pnpm ops pause front-door --for-wallet (the guardian's)");
    await signFile(ctx, rec, p.files[0], log);
    const paused = (await readDoor(ctx, rec, "paused")) as boolean;
    const v2 = await verifyV32(ctx, rec);
    const exits = v2.info.find((l) => l.startsWith("Base CascadeFrontDoor:"));
    said.push(`the guardian's pause() of the front door: paused() reads ${paused}; verify: ${v2.failures.length} failures; "${exits ?? "no exits line"}"`);
    const u = await pauseFileCommand(ctx, onForks(rec), { ...files, action: "unpause", target: "front-door", as: "owner" });
    await signFile(ctx, rec, u.files[0], log);
    said.push(`the owner's unpause(): paused() reads ${(await readDoor(ctx, rec, "paused")) as boolean}`);
    // 7.6: the owner's immediate raise of the idle buffer
    const ib = await idleBufferFileCommand(ctx, onForks(rec), { ...files, bps: 500n });
    log("Runbook 7.6: pnpm ops set-idle-buffer 500 --for-wallet");
    await signFile(ctx, rec, ib.files[0], log);
    said.push(`set-idle-buffer 500: idleBufferBps reads ${String(await readVault(ctx, rec, "idleBufferBps"))}`);
    // 7.1 step 2: the guardian's disable of both primaries, one ordered file
    const db = await disableBridgeFileCommand(ctx, onForks(rec), { ...files, target: "both", bridges: [a.bitAdapter, a.baseAdapter], as: "guardian" });
    log(`Runbook 7.1 step 2: pnpm ops disable-bridge both ${a.bitAdapter} ${a.baseAdapter} --as guardian --for-wallet`);
    await signFile(ctx, rec, db.files[0], log);
    const v3 = await verifyV32(ctx, rec);
    said.push(`the guardian's disable-bridge both: verify fails as it must while the exits are closed (${v3.failures.filter((f) => /exitsOpen|bridgeEnabled/.test(f)).length} lines on exitsOpen and bridgeEnabled; ${v3.failures.length} in all)`);
  } finally {
    await revert(ctx.rpc, s);
  }
  said.push(...(await rollSteps(r, d)));
  return said;
}

const UINT256_MAX = (1n << 256n) - 1n;

/** Runbook 7.2 step 2 (both keys stolen): a small redeem request of the founder's own waiting in the open batch stops a
 * thief from rolling it empty (restarting its timer). On a snapshot: a due empty batch rolls (closeBatch from anyone,
 * asked by eth_call); with one redeem request in it, the same call is refused (BatchTooSmall), so it can only be sent. */
async function rollSteps(r: Rehearsal, d: Deployed): Promise<string[]> {
  const { ctx } = r;
  const door = d.rec.plan.addresses.frontDoor;
  const abi = d.build.contracts.CascadeFrontDoor.abi;
  const s = await snapshot(ctx.rpc);
  try {
    const interval = (await read(ctx.rpc, "base", { address: door, abi, functionName: "batchInterval" })) as bigint;
    await ctx.rpc.request("base", "evm_increaseTime", [Number(interval)]);
    await ctx.rpc.request("base", "evm_mine", []);
    const [id] = (await read(ctx.rpc, "base", { address: door, abi, functionName: "openBatch" })) as readonly [bigint];
    const thief = privateKeyToAccount(generatePrivateKey()).address;
    const close = encodeFunctionData({ abi, functionName: "closeBatch", args: [id, UINT256_MAX] } as never);
    const ask = async () => {
      try {
        await ctx.rpc.request("base", "eth_call", [{ from: thief, to: door, data: close }, "latest"]);
        return "it rolls";
      } catch (e) {
        return `refused (${describeRevert(e, abi)})`;
      }
    };
    const empty = await ask();
    const founder = privateKeyToAccount(generatePrivateKey()).address;
    const fee = (await read(ctx.rpc, "base", { address: door, abi, functionName: "redeemRequestFee" })) as bigint;
    await sendFrom(ctx, "base", founder, { to: door, data: encodeFunctionData({ abi, functionName: "requestRedeem", args: [1n] } as never), value: fee }, "requestRedeem(1)");
    const waiting = await ask();
    return [`runbook 7.2 step 2: a due empty batch ${id}, closeBatch(${id}, max) from a stranger: ${empty}; with one redeem request of 1 share waiting in it: ${waiting}`];
  } finally {
    await revert(ctx.rpc, s);
  }
}

/** The forks up with v3.2 deployed, funded and verified (forksWithV32), still running: the caller stops them. */
export interface ForksV32 {
  r: Rehearsal;
  main: Deployed;
  inputs: RehearsalInputsV32;
  /** the deployment's name (OPS_DEPLOYMENT) and its record, rehearsal-<name>.json */
  name: string;
  path: string;
  /** where the founder's call files are written (rehearsal-wallet-<name>) */
  walletDir: string;
  funded: { minted: bigint; gas: Record<string, bigint> };
  /** verify after the funding: no failures when everything matches the plan */
  failures: string[];
}

/** The first half of `pnpm ops rehearse --v32`, which it runs as it is: two forks started (startForks, with the live
 * chain ids), the stand-ins and the validators' storage, the deployment from fresh keys (in `keysDir`, a temporary
 * folder deleted after the deploy when none is given), the founder's funding steps and verify, the record saved. The
 * forks are handed back running, for a caller that works on them after (Task 61 step 5: the monitor against them and the
 * founder's stamp drill), which stops them (r.stop()); a bring-up that fails stops them itself. Refused, nothing
 * started, on the inputs the rehearsal refuses. */
export async function forksWithV32(
  env: Env,
  log: (l: string) => void,
  o: { noBuild?: boolean; keysDir?: string; inputs?: RehearsalInputsV32; startForks?: typeof startForks } = {},
): Promise<ForksV32> {
  const inputs = o.inputs ?? rehearsalInputsV32(env);
  const path = recordPath(env, false);
  const r = await (o.startForks ?? startForks)(env, log, { chainIds: FORK_CHAIN_IDS });
  const keysDir = o.keysDir ?? mkdtempSync(join(tmpdir(), "cascade-rehearsal-keys-"));
  try {
    await prepareForks(r, inputs.validators, log);
    const name = (env.OPS_DEPLOYMENT ?? "v3.2-launch").trim();
    const walletDir = join(r.ctx.paths.deploymentsDir, `rehearsal-wallet-${name}`);
    mkdirSync(walletDir, { recursive: true });
    // the deployment, as deploy --v32 sends it
    log("The deployment, from fresh keys at nonce 0 on each fork:");
    const main = await deployOnForks(r, inputs, { path, keysDir, tag: "main", noBuild: o.noBuild ?? false });
    for (const line of gasLines(gasRows(main.rec.plan, main.build, main.rec.done), main.rec.plan)) log(line);
    const before = await verifyV32(r.ctx, main.rec);
    log(`Verify before the funding: ${before.failures.length} failures (${before.failures.map((f) => f.split(":")[0]).join("; ") || "none"})`);
    // the founder's funding and the treasury's redeem origin
    const funded = await founderSteps(r, main, { walletDir, name }, log);
    const v = await verifyV32(r.ctx, main.rec);
    main.rec.verify = verifyResult(v);
    saveRecord(path, main.rec);
    const cushionLine = v.info.find((l) => l.includes("booked token cushion (tokenCushion)"));
    log(`Verify after the funding: ${v.failures.length ? `FAILED:\n  ${v.failures.join("\n  ")}` : "everything matches the plan"}`);
    if (cushionLine) log(`  ${cushionLine}`);
    if (v.warnings.length) log(`  Warnings (not failures):\n    ${v.warnings.join("\n    ")}`);
    if (v.info.length) log(`  For information:\n    ${v.info.join("\n    ")}`);
    return { r, main, inputs, name, path, walletDir, funded, failures: v.failures };
  } catch (e) {
    r.stop();
    throw e;
  } finally {
    if (!o.keysDir) rmSync(keysDir, { recursive: true, force: true });
  }
}

/** `pnpm ops rehearse --v32`: see the top of this file. True when the deployment, its funding and verify passed and
 * each negative failed as it must. */
export async function rehearseV32(env: Env, log: (l: string) => void, o: { noBuild?: boolean } = {}): Promise<boolean> {
  const inputs = rehearsalInputsV32(env);
  if (inputs.claimGasStandIn) {
    log(
      `claimGasRequired is not measured yet (Tasks 64 and 65): the rehearsal plans with ${n(REHEARSAL_CLAIM_GAS)}, a stand-in. A live deploy refuses a rehearsal of another plan, so rehearse again once MEASURED_V32.claimGasRequired is set.`,
    );
  }
  const keysDir = mkdtempSync(join(tmpdir(), "cascade-rehearsal-keys-"));
  let up: ForksV32 | undefined;
  try {
    up = await forksWithV32(env, log, { noBuild: o.noBuild ?? false, keysDir, inputs });
    const { r, main, path, walletDir, name, funded } = up;
    let ok = up.failures.length === 0;
    // the owner's and the guardian's settings, on a snapshot
    try {
      for (const line of await settingsSteps(r, main, { walletDir, name }, log)) log(`Settings: ${line}`);
    } catch (e) {
      ok = false;
      log(`Settings: FAILED: ${(e as Error).message.split("\n")[0]}`);
    }
    // the negatives: each must fail, for its change alone
    for (const neg of NEGATIVES_V32) {
      log(`Negative run: ${neg.what}`);
      const negPath = path.replace(/\.json$/, `-negative-${neg.id}.json`);
      let l1At: Address | undefined;
      const deployL1 = async () => {
        const who = privateKeyToAccount(generatePrivateKey()).address;
        const step = main.rec.plan.steps.find((s) => s.id === "batchLib")!;
        const rc = await sendFrom(r.ctx, "bittensor", who, { data: deployDataV32(main.build, step) }, "a correct CascadeBatchLib from another key");
        l1At = getAddress(rc.contractAddress ?? getContractAddress({ from: who, nonce: 0n }));
        log(`  a correct CascadeBatchLib deployed at ${l1At} by ${who}, not the plan's address`);
        return l1At;
      };
      const tamper = tamperFor(neg, { build: main.build, otherVault: main.rec.plan.addresses.vault, deployL1 });
      try {
        const d = await deployOnForks(r, inputs, { path: negPath, keysDir, tag: neg.id, noBuild: true, tamper });
        await founderSteps(r, d, { walletDir, name: `${name}-negative-${neg.id}` }, () => {});
        const nv = await verifyV32(r.ctx, d.rec);
        d.rec.verify = verifyResult(nv);
        saveRecord(negPath, d.rec);
        const problems = negativeProblems(neg, nv.failures);
        log(`  verify ${nv.failures.length ? "FAILED, as it must" : "PASSED"}: ${nv.failures.length} failures:\n    ${nv.failures.join("\n    ")}`);
        if (problems.length) {
          ok = false;
          log(`  NOT AS EXPECTED:\n    ${problems.join("\n    ")}`);
        }
      } catch (e) {
        ok = false;
        log(`  the negative run did not complete: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    if (ok) {
      main.rec.rehearsed = { buildHash: main.rec.build.hash, at: new Date().toISOString() };
      saveRecord(path, main.rec);
      log(`Rehearsed: ${path} names build ${main.rec.build.hash} as rehearsed (a live deploy sends only it, of this plan but its keys)`);
    } else log(`Not rehearsed: ${path} names no rehearsed build (something above did not pass)`);
    log(`FM-TAO minted by the depositLiquid of ${formatEther(FM_DEPOSIT)} TAO: ${formatEther(funded.minted)}; the funding's gas: ${Object.entries(funded.gas).map(([k, g]) => `${k} ${n(g)}`).join(", ")}`);
    return ok;
  } finally {
    up?.r.stop();
    rmSync(keysDir, { recursive: true, force: true });
  }
}
