import type { Abi, Address } from "viem";
import { artifactFor } from "../builds.ts";
import type { ChainName } from "../config.ts";
import type { Plan, PlanV3 } from "../plan.ts";
import { read } from "../rpc.ts";
import type { Ctx } from "../send.ts";
import { doorLensAbi, frontDoorAbiV32, gettersNamed, shapeOf, VAULT_ABI_V32, vaultLensAbi } from "./abi.ts";
import { type BuildRefV32, loadBuildV32 } from "./build.ts";
import { isPlanV32, type PlanV32 } from "./plan.ts";

// v3.2's reads (spec §8.1). The vault kept only what wallets, explorers, Safe tooling and verify read from it
// directly, and the front door kept its own getters; every other view moved behind `extsload` to the two lenses,
// CascadeVaultLens and CascadeDoorLens. readVault and readDoor send each getter where it is: to the contract when the
// contract's ABI has it, else to its lens. The kept list is the ABIs themselves (the published vault ABI, the front
// door's and the lenses' builds), never a list kept by hand. A record that is not v3.2's (v3-launch, live until Task
// 69; v3-test; v2) has no lens: it reads everything from its contracts, with the frozen ABI of its build
// (builds.ts), as ops always has.

/** What the readers need of a deployment record: its plan (v3.2's, or a build before it) and, for a v3.2 deployment,
 * the frozen build it was sent from (v32/deploy.ts writes it before the first CREATE). */
export interface PlannedRecord {
  plan: Plan | PlanV3 | PlanV32;
  build?: BuildRefV32;
}

/** The four ABIs a v3.2 read decodes with. */
interface AbisV32 {
  vault: Abi;
  vaultLens: Abi;
  frontDoor: Abi;
  doorLens: Abi;
}

/** A v3.2 record's ABIs: its frozen build's once it names one (every deployment record does, from before its first
 * CREATE: what was deployed, never contracts/out), from `buildsDir` (ops/builds/ by default), else this checkout's (a
 * plan with no deployment yet). */
function abisOf(rec: PlannedRecord, buildsDir?: string): AbisV32 {
  if (rec.build) {
    const b = loadBuildV32(rec.build, buildsDir);
    return { vault: b.vaultAbi, vaultLens: b.contracts.CascadeVaultLens.abi, frontDoor: b.contracts.CascadeFrontDoor.abi, doorLens: b.contracts.CascadeDoorLens.abi };
  }
  return { vault: VAULT_ABI_V32, vaultLens: vaultLensAbi(), frontDoor: frontDoorAbiV32(), doorLens: doorLensAbi() };
}

/** The vault getters ops's v3.2 paths read: verify's read-backs, the scheduler's items and clocks, the keeper's state
 * and the rehearsal's (Tasks 44 to 53 add theirs here). readVault takes only these, so test/v32-lens.test.ts holds
 * every one to the build: on the vault or its lens, and with one shape where both serve it. Stake reads are in rao
 * (visibleStakeRao, v3-launch's rootStakeRao renamed in Task 12, and bookedStake), as are missingStakeRao and
 * unlistedStakeRao; the share and asset reads are in wei. */
export const VAULT_READS = [
  // kept on the vault (spec §8.1)
  "owner",
  "pendingOwner",
  "paused",
  "launchChain",
  "balanceOf",
  "totalSupply",
  "MS_PER_BLOCK",
  // the vault's EXIT_GAS_RESERVE, served by its lens: the keeper's payout gas rule copies it (Task 65)
  "EXIT_GAS_RESERVE",
  // the roles and the constructor's limits (Appendix B), each read back by verify and before a scheduled change
  "guardian",
  "keeper",
  "treasury",
  "rewardCutBps",
  "payoutDelay",
  "maxDailyOutflowBps",
  "minDailyOutflow",
  "globalOutflowBps",
  "maxEntryValue",
  "maxMessageValue",
  "minChunk",
  "maxFeeBps",
  "maxFeeAbs",
  "maxTotalAssets",
  "minDirectDeposit",
  "claimGasRequired",
  "hotkeyDustRao",
  "unstakeMarginRao",
  "rewardVesting",
  "idleBufferBps",
  "unstakeGas",
  // front doors, bridges, the exits machine and the scheduler
  "activeDoors",
  "doorState",
  "peerId",
  "redeemOrigin",
  "primaryBridge",
  "bridgeEnabled",
  "exitsOpen",
  // the exits machine's holds, each its actor (Task 46b's exits report)
  "pausedBy",
  "launchDoorRemovedBy",
  "primaryDisabledBy",
  "scheduled",
  "lastOwnerClose",
  "lastGuardianClose",
  "pendingSince",
  "DOMAIN_SEPARATOR",
  "STAMP_TYPEHASH",
  // the scheduler's delays and window, and whether a bridge was ever active (an activation's kind; Task 47)
  "PARAM_DELAY",
  "REGISTRY_DELAY",
  "GUARDIAN_DELAY",
  "EXECUTE_WINDOW",
  "bridgeKnown",
  // the stake and its hotkeys
  "coldkey",
  "hotkeys",
  "hotkeyCount",
  "stakeHotkey",
  "lastClaimAt",
  "lastStakeAt",
  "visibleStakeRao",
  "bookedStake",
  "missingStakeRao",
  "unlistedStakeRao",
  "stakeMissing",
  "minStakeRao",
  // assets and the payout queue
  "totalAssets",
  "price",
  "pendingPayouts",
  "getPayoutBatch",
] as const;
export type VaultRead = (typeof VAULT_READS)[number];

/** The front door getters ops's v3.2 paths read (as VAULT_READS). */
export const DOOR_READS = [
  // the front door's own, which it kept (spec §8.1)
  "owner",
  "pendingOwner",
  "paused",
  "keeper",
  "treasury",
  "oracle",
  "swapper",
  "asset",
  "usdc",
  "vault",
  "vaultChain",
  "MS_PER_BLOCK",
  "minPoolLiquidity",
  "batchInterval",
  "minDeposit",
  "depositCap",
  "redeemRequestFee",
  "maxDeposits",
  "maxRedeems",
  "maxBatchValue",
  "maxDeliverySlippageBps",
  "canClose",
  "openBatch",
  "openDeposits",
  "openRedeems",
  "claimable",
  "deliveryOf",
  // CascadeBase's, which moved to the door lens
  "guardian",
  "primaryBridge",
  "bridgeEnabled",
  "exitsOpen",
  "primaryDisabledBy",
  "scheduled",
  "lastOwnerClose",
  "lastGuardianClose",
  "pendingSince",
  "DOMAIN_SEPARATOR",
  "STAMP_TYPEHASH",
  "PARAM_DELAY",
  "REGISTRY_DELAY",
  "GUARDIAN_DELAY",
  "EXECUTE_WINDOW",
  "bridgeKnown",
] as const;
export type DoorRead = (typeof DOOR_READS)[number];

/** Where a v3.2 getter is read: its contract, or that contract's lens. */
export type Route = "contract" | "lens";

/** Where the getter `fn` is read, from the two ABIs alone: from the contract when the contract's ABI has it (what it
 * kept), else from the lens. Refused when neither has it, and when both do with different types, which would read
 * it differently. `contract` names the contract in the refusal. */
export function routeOf(contractAbi: Abi, lensAbi: Abi, fn: string, contract = "contract"): Route {
  const onContract = gettersNamed(contractAbi, fn);
  const onLens = gettersNamed(lensAbi, fn);
  if (onContract.length && onLens.length) {
    const a = onContract.map(shapeOf).sort().join("; ");
    const b = onLens.map(shapeOf).sort().join("; ");
    if (a !== b) throw new Error(`the ${contract} and its lens read ${fn} differently (${a}, and ${b}): nothing read`);
  }
  if (onContract.length) return "contract";
  if (onLens.length) return "lens";
  throw new Error(`neither the ${contract} nor its lens has a getter ${fn}: nothing read`);
}

/** Where a v3.2 vault getter is read (routeOf over the published vault ABI and CascadeVaultLens's). */
export const vaultRoute = (fn: string): Route => routeOf(VAULT_ABI_V32, vaultLensAbi(), fn, "vault");
/** Where a v3.2 front door getter is read (routeOf over CascadeFrontDoor's and CascadeDoorLens's ABIs). */
export const doorRoute = (fn: string): Route => routeOf(frontDoorAbiV32(), doorLensAbi(), fn, "front door");

const NO_LENS = "is not v3.2's: its contracts serve every getter themselves, and it has no lens";

/** The v3.2 vault's lens (CascadeVaultLens, constructed on the vault). Refused for a record that is not v3.2's. */
export function vaultLens(rec: PlannedRecord): Address {
  if (!isPlanV32(rec.plan)) throw new Error(`this deployment ${NO_LENS}`);
  return rec.plan.addresses.vaultLens;
}

/** The v3.2 front door's lens (CascadeDoorLens, constructed on the front door). Refused for a record that is not v3.2's. */
export function doorLens(rec: PlannedRecord): Address {
  if (!isPlanV32(rec.plan)) throw new Error(`this deployment ${NO_LENS}`);
  return rec.plan.addresses.doorLens;
}

/** A read from a contract of a build before v3.2, with that build's frozen ABI: refused, reading nothing, when the
 * build has no such getter (one v3.2 added, such as doorState). */
function readOlder(ctx: Pick<Ctx, "rpc">, chain: ChainName, address: Address, abi: Abi, contract: string, fn: string, args: readonly unknown[]): Promise<unknown> {
  if (!gettersNamed(abi, fn).length) throw new Error(`this deployment's ${contract} (a build before v3.2) has no getter ${fn}: nothing read`);
  return read(ctx.rpc, chain, { address, abi, functionName: fn, args });
}

/** Reads the vault getter `fn`: on a v3.2 record from the vault when it kept the getter, else from its lens (with
 * that contract's ABI, the frozen build's once the record names it, from `buildsDir`: abisOf); on any other record from
 * the vault, with its build's frozen ABI. At `block` when given (a v3.2 read only), else the latest. */
export async function readVault(ctx: Pick<Ctx, "rpc">, rec: PlannedRecord, fn: VaultRead, args: readonly unknown[] = [], buildsDir?: string, block?: bigint): Promise<unknown> {
  const plan = rec.plan;
  if (!isPlanV32(plan)) return readOlder(ctx, "bittensor", plan.addresses.vault, artifactFor(plan, "CascadeVault").abi, "vault", fn, args);
  const abis = abisOf(rec, buildsDir);
  const lens = routeOf(abis.vault, abis.vaultLens, fn, "vault") === "lens";
  return read(ctx.rpc, "bittensor", { address: lens ? plan.addresses.vaultLens : plan.addresses.vault, abi: lens ? abis.vaultLens : abis.vault, functionName: fn, args }, block);
}

/** Reads the front door getter `fn`, as readVault does the vault's (at `block` when given, a v3.2 read only). */
export async function readDoor(ctx: Pick<Ctx, "rpc">, rec: PlannedRecord, fn: DoorRead, args: readonly unknown[] = [], buildsDir?: string, block?: bigint): Promise<unknown> {
  const plan = rec.plan;
  if (!isPlanV32(plan)) return readOlder(ctx, "base", plan.addresses.frontDoor, artifactFor(plan, "CascadeFrontDoor").abi, "front door", fn, args);
  const abis = abisOf(rec, buildsDir);
  const lens = routeOf(abis.frontDoor, abis.doorLens, fn, "front door") === "lens";
  return read(ctx.rpc, "base", { address: lens ? plan.addresses.doorLens : plan.addresses.frontDoor, abi: lens ? abis.doorLens : abis.frontDoor, functionName: fn, args }, block);
}

/** Reads `fn` from the lens itself, whichever contract keeps a getter of that name too: the deploy-time lens checks
 * (spec §7 step 3) read the lens, so that a lens bound to the wrong target, or reading the wrong slots, shows. The front
 * door kept its keeper, which readDoor reads from the door; the door lens's own keeper is read here (Task 43a's review,
 * M5). Refused, reading nothing, for a record that is not v3.2's and a getter the lens lacks. */
async function readLens(ctx: Pick<Ctx, "rpc">, rec: PlannedRecord, which: "vault" | "door", fn: string, args: readonly unknown[], buildsDir?: string): Promise<unknown> {
  const address = which === "vault" ? vaultLens(rec) : doorLens(rec);
  const abis = abisOf(rec, buildsDir);
  const abi = which === "vault" ? abis.vaultLens : abis.doorLens;
  if (!gettersNamed(abi, fn).length) throw new Error(`the ${which === "vault" ? "vault's" : "front door's"} lens has no getter ${fn}: nothing read`);
  return read(ctx.rpc, which === "vault" ? "bittensor" : "base", { address, abi, functionName: fn, args });
}

/** Reads the vault getter `fn` from the vault's lens (CascadeVaultLens), never the vault. */
export const readVaultLens = (ctx: Pick<Ctx, "rpc">, rec: PlannedRecord, fn: VaultRead, args: readonly unknown[] = [], buildsDir?: string): Promise<unknown> =>
  readLens(ctx, rec, "vault", fn, args, buildsDir);

/** Reads the front door getter `fn` from the front door's lens (CascadeDoorLens), never the front door. */
export const readDoorLens = (ctx: Pick<Ctx, "rpc">, rec: PlannedRecord, fn: DoorRead, args: readonly unknown[] = [], buildsDir?: string): Promise<unknown> =>
  readLens(ctx, rec, "door", fn, args, buildsDir);

/** The amount, in rao, the owner schedules writeOffMissingStake with (spec §3.1): the missing stake less the
 * unlisted, both read now through the lens. Schedule exactly this, as read at scheduling: the vault writes off
 * w = min(rao, missing) only while unlisted <= missing - w, so this amount passes, while the whole missing stake (or
 * more) reverts WriteOffTooLarge whenever any unlisted stake exists; should unlisted stake grow before the item runs,
 * it reverts WriteOffTooLarge too, and the item stays. 0 when listing hotkeys could bring all of it back: nothing to
 * write off. A failed read of the unlisted stake (the lens reverts when the precompile cannot total it) is refused,
 * never taken as 0. */
export async function writeOffMissingStakeRao(ctx: Pick<Ctx, "rpc">, rec: { plan: PlanV32; build?: BuildRefV32 }, buildsDir?: string): Promise<bigint> {
  const missing = (await readVault(ctx, rec, "missingStakeRao", [], buildsDir)) as bigint;
  const unlisted = (await readVault(ctx, rec, "unlistedStakeRao", [], buildsDir)) as bigint;
  return missing > unlisted ? missing - unlisted : 0n;
}
