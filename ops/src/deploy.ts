import { type Address, getContractAddress, type Hex, hexToBigInt, hexToNumber, parseAbi } from "viem";
import { type Cadence, type ChainName, PRECOMPILE, WALLET } from "./config.ts";
import {
  buildOf,
  buildPlan,
  buildPlanV3,
  CONTRACTS_BUILD,
  cadenceOf,
  isPlanV3,
  type Plan,
  type PlanV3,
  ROUTE_0,
  rolesOf,
  settingsOf,
  settingsV3Of,
} from "./plan.ts";
import { archiveRecord, type DeploymentRecord, type DoneStep, loadRecordFor, saveRecord } from "./record.ts";
import type { VerifyAllow } from "./registry.ts";
import { type Roles, rolesDiffer } from "./roles.ts";
import { balanceOf, codeAt, firstBlockWithCode, nonceOf, read } from "./rpc.ts";
import { type Ctx, chainLabel, ReceiptTimeout, type Sent, sendCall, sendCreate } from "./send.ts";
import type { CallRequest, CreateRequest, PlannedStep, StepId } from "./types.ts";
import { refuseV2Verify, verifyAndSave } from "./verify.ts";

export interface DeployDeps {
  sendCreate(ctx: Ctx, req: CreateRequest, predicted: Address): Promise<Sent>;
  sendCall(ctx: Ctx, req: CallRequest): Promise<Sent>;
  effectPresent(ctx: Ctx, plan: Plan | PlanV3, step: PlannedStep): Promise<boolean>;
  readColdkey(ctx: Ctx, vault: Address): Promise<Hex>;
  /** The block a contract was created in, from its code */
  deployBlock(ctx: Ctx, chain: ChainName, address: Address): Promise<number>;
}

const VIEWS = parseAbi([
  "function keeper() view returns (address)",
  "function payoutDelay() view returns (uint64)",
  "function addressMapping(address addr) view returns (bytes32)",
  "function swapper() view returns (address)",
  "function oracle() view returns (address)",
  "function maxBatchValue() view returns (uint256)",
  "function routes(uint8) view returns (uint8 kind, address router, bytes buyPath, bytes sellPath, bool active)",
  "function swapFeeBps() view returns (uint16)",
  "function depositFeeUsdc() view returns (uint256)",
  "function treasury() view returns (address)",
  "function rewardCutBps() view returns (uint16)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
]);

const eq = (x: unknown, y: unknown) => typeof x === "string" && typeof y === "string" && x.toLowerCase() === y.toLowerCase();

/** The address a create step deploys to. */
const createdAt = (plan: Plan | PlanV3, id: StepId): Address => {
  const a = (plan.addresses as Record<string, Address | undefined>)[id];
  if (!a) throw new Error(`the plan has no address for "${id}"`);
  return a;
};

/** Whether a step's result is already on-chain (so a lost record entry is recovered, not re-sent).
 * Answers no only when the chain says so; a failed read throws, so nothing is sent on a guess. */
export async function effectPresent(ctx: Ctx, plan: Plan | PlanV3, step: PlannedStep): Promise<boolean> {
  const a = plan.addresses;
  const s = settingsOf(plan);
  const hasCode = async (chain: ChainName, addr: Address) => (await codeAt(ctx.rpc, chain, addr)) !== "0x";
  const view = (chain: ChainName, address: Address, functionName: string, args?: unknown[]) =>
    read(ctx.rpc, chain, { address, abi: VIEWS, functionName, args });
  const v3 = () => {
    if (!isPlanV3(plan)) throw new Error(`"${step.id}" is a v3 step, but the plan is v2`);
    return plan.addresses;
  };
  const sv3 = () => (v3(), settingsV3Of(plan as PlanV3));
  const roles = rolesOf(plan);
  /** Ownable2Step: offered once the final owner is pending, and done for good once it has accepted. */
  const offered = async (chain: ChainName, at: Address) => {
    const final = roles.owner[chain];
    return (await hasCode(chain, at)) && (eq(await view(chain, at, "pendingOwner"), final) || eq(await view(chain, at, "owner"), final));
  };
  switch (step.id) {
    case "baseAdapter":
    case "frontDoor":
    case "bitAdapter":
    case "vault":
    case "oracle":
    case "staker":
      return hasCode(step.chain, createdAt(plan, step.id));
    // balances read 500 rao (5e11 wei) below what was sent (the existential deposit)
    case "adapterReserve":
      return (
        (await hasCode("bittensor", a.bitAdapter)) &&
        (await balanceOf(ctx.rpc, "bittensor", a.bitAdapter)) >= s.adapterReserve - 5n * 10n ** 11n
      );
    case "vaultReserve":
      return (
        (await hasCode("bittensor", a.vault)) &&
        (await balanceOf(ctx.rpc, "bittensor", a.vault)) >= s.vaultReserve - 5n * 10n ** 11n
      );
    case "setKeeper":
      return (await hasCode("bittensor", a.vault)) && eq(await view("bittensor", a.vault, "keeper"), roles.keeper);
    case "setPayoutDelay":
      return (await hasCode("bittensor", a.vault)) && (await view("bittensor", a.vault, "payoutDelay")) === BigInt(s.payoutDelay);
    case "setRewardCut":
      return (
        (await hasCode("bittensor", a.vault)) &&
        eq(await view("bittensor", a.vault, "treasury"), (v3(), roles.treasury)) &&
        (await view("bittensor", a.vault, "rewardCutBps")) === sv3().rewardCutBps
      );
    case "fdSetKeeper":
      return (await hasCode("base", a.frontDoor)) && eq(await view("base", a.frontDoor, "keeper"), roles.keeper);
    case "fdSetSwapper":
      return (await hasCode("base", a.frontDoor)) && eq(await view("base", a.frontDoor, "swapper"), v3().staker);
    case "fdSetOracle":
      return (await hasCode("base", a.frontDoor)) && eq(await view("base", a.frontDoor, "oracle"), v3().oracle);
    case "fdSetMaxBatchValue":
      return (await hasCode("base", a.frontDoor)) && (await view("base", a.frontDoor, "maxBatchValue")) === sv3().maxBatchValue;
    case "stakerSetRoute0": {
      if (!(await hasCode("base", v3().staker))) return false;
      const [kind, router, buyPath, sellPath, active] = (await view("base", v3().staker, "routes", [0])) as readonly unknown[];
      return (
        kind === ROUTE_0.kind && eq(router, ROUTE_0.router) && eq(buyPath, ROUTE_0.buyPath) && eq(sellPath, ROUTE_0.sellPath) && active === ROUTE_0.active
      );
    }
    // the delivery route id defaults to 0, the id it is set to, so no read can tell; sending it again is harmless
    case "stakerSetDeliveryRoute":
      return false;
    case "stakerSetFees":
      return (
        (await hasCode("base", v3().staker)) &&
        (await view("base", v3().staker, "swapFeeBps")) === sv3().swapFeeBps &&
        (await view("base", v3().staker, "depositFeeUsdc")) === sv3().depositFeeUsdc
      );
    case "fdTransferOwnership":
      return offered("base", a.frontDoor);
    case "stakerTransferOwnership":
      return offered("base", v3().staker);
    case "vaultTransferOwnership":
      return offered("bittensor", a.vault);
  }
}

export const readColdkey = async (ctx: Ctx, vault: Address): Promise<Hex> =>
  (await read(ctx.rpc, "bittensor", {
    address: PRECOMPILE.addressMapping,
    abi: VIEWS,
    functionName: "addressMapping",
    args: [vault],
  })) as Hex;

const realDeps: DeployDeps = {
  sendCreate,
  sendCall,
  effectPresent,
  readColdkey,
  deployBlock: (ctx, chain, address) => firstBlockWithCode(ctx.rpc, chain, address),
};

/** The Bittensor adapter, whose block every Bittensor log scan starts from (startBlock): the one create
 * whose block a recovery looks up, so a failed lookup for any other can't stop a deploy. */
const keepsBlock = (step: PlannedStep) => step.id === "bitAdapter";

/** A step found done on-chain, as the record keeps it: the Bittensor adapter with the block it was
 * created in. A block that can't be found stops the run; nothing is recorded on a guess. */
async function recovered(ctx: Ctx, plan: Plan | PlanV3, step: PlannedStep, deps: DeployDeps): Promise<DoneStep> {
  if (!keepsBlock(step)) return { recovered: true };
  try {
    return { recovered: true, block: await deps.deployBlock(ctx, step.chain, createdAt(plan, step.id)) };
  } catch (e) {
    throw new Error(
      `${chainLabel(step.chain)}: ${step.label} is already on-chain, but the block it was created in could not be found (${(e as Error).message}): that reads old state, so OPS_BITTENSOR_RPC must be an archive node (the default, archive.chain.opentensor.ai, is one); nothing sent — run deploy again`,
    );
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The wallet moved past a create's nonce but its code read empty: a load-balanced RPC can lag a
 * block behind, so look again for a few seconds before calling the plan void. */
async function landedAfterAll(ctx: Ctx, plan: Plan | PlanV3, step: PlannedStep, deps: DeployDeps): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    if (await deps.effectPresent(ctx, plan, step)) return true;
    await pause(ctx.pollMs ?? 3_000);
  }
  return false;
}

type Receipt = { status: Hex; blockNumber: Hex; gasUsed: Hex; effectiveGasPrice: Hex } | null;

const latestNonce = async (ctx: Ctx, chain: "base" | "bittensor") =>
  hexToNumber((await ctx.rpc.request(chain, "eth_getTransactionCount", [WALLET, "latest"])) as Hex);

/** Settles a transaction left pending by an earlier run; returns once nothing is pending. */
async function settlePending(ctx: Ctx, rec: DeploymentRecord, path: string): Promise<void> {
  const p = rec.pending;
  if (!p) return;
  const where = `${chainLabel(p.chain)} nonce ${p.nonce}`;
  if (p.hash) {
    const r = (await ctx.rpc.request(p.chain, "eth_getTransactionReceipt", [p.hash])) as Receipt;
    if (!r) {
      const known = await ctx.rpc.request(p.chain, "eth_getTransactionByHash", [p.hash]);
      if (!known && (await nonceOf(ctx.rpc, p.chain, WALLET)) <= p.nonce) {
        ctx.log(`${where}: transaction ${p.hash} was dropped by the network; sending that step again`);
        delete rec.pending;
        saveRecord(path, rec);
        return;
      }
      if (known || (await latestNonce(ctx, p.chain)) <= p.nonce) {
        throw new Error(`${where} (transaction ${p.hash}) is still pending; run deploy again once it is mined`);
      }
      // another transaction at its nonce was mined instead (sped up, replaced or cancelled): the effect
      // check below records the step as recovered, or the nonce check voids the plan
      ctx.log(`${where}: transaction ${p.hash} was replaced by another at its nonce; checking the step on-chain`);
      delete rec.pending;
      saveRecord(path, rec);
      return;
    }
    if (r.status !== "0x1") {
      throw new Error(`${where} (transaction ${p.hash}) reverted; the plan is void: run deploy --new-plan`);
    }
    const step = rec.plan.steps.find((s) => s.id === p.step)!;
    const gasUsed = hexToBigInt(r.gasUsed);
    rec.done[p.step] = {
      hash: p.hash,
      block: hexToNumber(r.blockNumber),
      gasUsed,
      costWei: gasUsed * hexToBigInt(r.effectiveGasPrice),
      ...(step.kind === "create" ? { address: createdAt(rec.plan, step.id) } : {}),
    };
  } else {
    if ((await latestNonce(ctx, p.chain)) <= p.nonce) {
      if ((await nonceOf(ctx.rpc, p.chain, WALLET)) <= p.nonce) {
        ctx.log(`${where}: the transaction was dropped by the network; sending that step again`);
        delete rec.pending;
        saveRecord(path, rec);
        return;
      }
      throw new Error(`${where} is still pending; run deploy again once it is mined`);
    }
    // mined: the effect check below records it as recovered, or the nonce check voids the plan
  }
  delete rec.pending;
  saveRecord(path, rec);
}

/** Every step landed and nothing pending. */
const finished = (rec: DeploymentRecord) => !rec.pending && rec.plan.steps.every((s) => rec.done[s.id]);

/** Deploys and configures everything, resuming after any stop; saves the record after every step.
 * A new record gets the v3 plan when `v3` is set (a deployment named v3…), else the v2 plan; an
 * existing record keeps its own plan. A record of the other version, or of the other kind of run (a
 * rehearsal record for a --live run, or a live one on the forks), is refused before anything else,
 * archiving included. An unfinished v3 plan from another contracts build is refused before anything is
 * read or sent (a finished one goes on to the read-back, against its own build). */
export interface DeployOpts {
  newPlan: boolean;
  v3?: boolean;
  cadence?: Cadence;
  /** A launch's roles (from the environment: launchRolesFromEnv), asked for only when a launch plan is made
   * or resumed; it throws when they are missing or wrong. */
  roles?: () => Roles;
}

/** A launch's roles before it is planned: every one given, and the treasury a plain account on both chains
 * (verify checks it again after the deploy, but the staker and the vault would already name it). */
async function rolesForNewLaunch(ctx: Ctx, opts: DeployOpts): Promise<Roles> {
  if (!opts.roles) throw new Error("a launch plan needs its roles: set the OPS_LAUNCH_… variables (see ops/LAUNCH-SETTINGS.md); nothing read or sent");
  const roles = opts.roles();
  for (const chain of ["base", "bittensor"] as const) {
    if ((await codeAt(ctx.rpc, chain, roles.treasury)) !== "0x") {
      throw new Error(
        `the treasury ${roles.treasury} has contract code on ${chainLabel(chain)}: it must be a plain account, the same owner on Base and Bittensor; nothing sent`,
      );
    }
  }
  return roles;
}

/** A resumed launch follows its record's roles; the environment naming others is refused (the operator
 * may have meant the new ones). Roles the environment can't give leave the record's in force. */
function checkResumedRoles(path: string, plan: Plan | PlanV3, opts: DeployOpts): void {
  if (!isPlanV3(plan) || !plan.roles || !opts.roles) return;
  let now: Roles;
  try {
    now = opts.roles();
  } catch {
    return;
  }
  const diff = rolesDiffer(plan.roles, now);
  if (diff) {
    throw new Error(`${path} plans ${diff}: deploy follows the record; put the record's roles back in .env, or plan anew with deploy --new-plan; nothing sent`);
  }
}

const formatRoles = (r: Roles) =>
  `owner ${r.owner.base} on Base and ${r.owner.bittensor} on Bittensor; guardian ${r.guardian.base} on Base and ${r.guardian.bittensor} on Bittensor; keeper ${r.keeper}; treasury ${r.treasury}`;

export async function deploy(ctx: Ctx, path: string, opts: DeployOpts, deps: DeployDeps = realDeps) {
  const v3 = opts.v3 ?? false;
  let rec = loadRecordFor(path, ctx.live);
  if (rec && isPlanV3(rec.plan) !== v3) {
    const [has, wants] = v3 ? ["v2", "v3"] : ["v3", "v2"];
    throw new Error(`${path} holds a ${has} plan, not ${wants}: check OPS_DEPLOYMENT (a deployment named v3-… is v3); nothing sent`);
  }
  if (rec && opts.newPlan) {
    ctx.log(`Archived the old plan to ${archiveRecord(path)}`);
    rec = null;
  }
  if (rec && isPlanV3(rec.plan) && buildOf(rec.plan) !== CONTRACTS_BUILD && !finished(rec)) {
    throw new Error(
      `${path} holds an unfinished v3 plan from an earlier contracts build (${buildOf(rec.plan)}); this build's front door and staker differ, so resuming it would mix the two: run deploy --new-plan to plan anew; nothing sent`,
    );
  }
  if (!rec) {
    const launch = v3 && opts.cadence === "launch";
    // refused before anything else is read: no plan without every role in place
    const roles = launch ? await rolesForNewLaunch(ctx, opts) : undefined;
    const baseNonce = await nonceOf(ctx.rpc, "base", WALLET);
    const bitNonce = await nonceOf(ctx.rpc, "bittensor", WALLET);
    // in both plans the vault is the second create on Bittensor
    const vault = getContractAddress({ from: WALLET, nonce: BigInt(bitNonce + 1) });
    const coldkey = await deps.readColdkey(ctx, vault);
    rec = {
      target: ctx.live ? "live" : "rehearsal",
      wallet: WALLET,
      createdAt: new Date().toISOString(),
      plan: v3 ? buildPlanV3(baseNonce, bitNonce, coldkey, opts.cadence, roles) : buildPlan(baseNonce, bitNonce, coldkey),
      done: {},
    };
    saveRecord(path, rec);
    const named = launch ? " (launch cadence: 1-hour batches, 24-hour payout delay)" : "";
    ctx.log(`Planned the ${v3 ? "v3 " : ""}deployment${named} from the wallet's nonces: Base ${baseNonce}, Bittensor ${bitNonce}`);
    if (roles) ctx.log(`Roles: ${formatRoles(roles)}. The test wallet deploys and owns everything until the final owners accept (pnpm ops handoff).`);
  }
  else if (opts.cadence === "launch" && cadenceOf(rec.plan) === "test") {
    ctx.log("OPS_CADENCE=launch ignored: the record's cadence is test; use --new-plan to plan anew");
  } else {
    checkResumedRoles(path, rec.plan, opts);
  }
  await settlePending(ctx, rec, path);

  for (const step of rec.plan.steps) {
    const done = rec.done[step.id];
    // recovered by an earlier run that didn't keep its block
    if (done && "recovered" in done && done.block === undefined && keepsBlock(step)) {
      rec.done[step.id] = await recovered(ctx, rec.plan, step, deps);
      saveRecord(path, rec);
      ctx.log(`${chainLabel(step.chain)}: ${step.label} — found the block it was created in, recorded`);
    }
    if (rec.done[step.id]) continue;
    let present: boolean;
    try {
      present = await deps.effectPresent(ctx, rec.plan, step);
    } catch (e) {
      throw new Error(
        `${chainLabel(step.chain)}: could not check whether "${step.label}" is already done (${(e as Error).message}); nothing sent — run deploy again`,
      );
    }
    if (present) {
      rec.done[step.id] = await recovered(ctx, rec.plan, step, deps);
      saveRecord(path, rec);
      ctx.log(`${chainLabel(step.chain)}: ${step.label} — already done on-chain, recorded`);
      continue;
    }
    const current = await nonceOf(ctx.rpc, step.chain, WALLET);
    const mined = await latestNonce(ctx, step.chain);
    if (mined < current) {
      throw new Error(
        `${chainLabel(step.chain)}: a transaction from the test wallet (nonce ${mined}) is still waiting to be mined; run deploy again once it is`,
      );
    }
    // creates must land at their predicted addresses; a configuration call can go at any nonce
    if (step.kind === "create" && current > step.nonce && (await landedAfterAll(ctx, rec.plan, step, deps))) {
      rec.done[step.id] = await recovered(ctx, rec.plan, step, deps);
      saveRecord(path, rec);
      ctx.log(`${chainLabel(step.chain)}: ${step.label} — already done on-chain, recorded`);
      continue;
    }
    if (step.kind === "create" && current !== step.nonce) {
      throw new Error(
        `${chainLabel(step.chain)}: the plan no longer matches the wallet (nonce ${current}, expected ${step.nonce}); run deploy --new-plan to start over from the current nonces`,
      );
    }
    try {
      rec.done[step.id] =
        step.kind === "create"
          ? await deps.sendCreate(ctx, step, createdAt(rec.plan, step.id))
          : await deps.sendCall(ctx, { ...step, nonce: current });
    } catch (e) {
      if (e instanceof ReceiptTimeout) {
        rec.pending = { step: step.id, chain: e.chain, nonce: e.nonce, hash: e.hash };
        saveRecord(path, rec);
      }
      throw e;
    }
    saveRecord(path, rec);
  }
  return rec;
}

/** `pnpm ops deploy`: deploys (or resumes) and then reads everything back into the record. A new
 * deployment or a new plan must be v3: the v2 plan's front door no longer matches the build, and planning
 * anew under the v2 name would archive the record that status, wind-down and sweep still read. An
 * existing v2 record is refused too, before anything is read or sent: resuming it would re-run the
 * read-back and save a failed code comparison into it. A record of the other kind of run is refused. */
export async function deployAndVerify(ctx: Ctx, path: string, opts: DeployOpts & { v3: boolean; allow?: VerifyAllow }, deps: DeployDeps = realDeps) {
  const existing = loadRecordFor(path, ctx.live);
  if (!opts.v3 && (opts.newPlan || !existing)) {
    throw new Error("a new deployment uses the v3 contracts: set OPS_DEPLOYMENT=v3-test (the v2 record is left as it is); nothing sent");
  }
  // (a v3 run that finds a v2 record is refused by deploy itself, which names OPS_DEPLOYMENT)
  if (existing && !opts.v3) refuseV2Verify(path, existing);
  return verifyAndSave(ctx, path, await deploy(ctx, path, opts, deps), { allow: opts.allow });
}
