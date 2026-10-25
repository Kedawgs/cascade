import { type Address, getContractAddress, type Hex, hexToBigInt, hexToNumber, parseAbi } from "viem";
import { PRECOMPILE, SETTINGS, WALLET } from "./config.ts";
import { buildPlan, type Plan } from "./plan.ts";
import { archiveRecord, type DeploymentRecord, loadRecord, saveRecord } from "./record.ts";
import { balanceOf, codeAt, nonceOf, read } from "./rpc.ts";
import { type Ctx, chainLabel, ReceiptTimeout, type Sent, sendCall, sendCreate } from "./send.ts";
import type { CallRequest, CreateRequest, PlannedStep } from "./types.ts";

export interface DeployDeps {
  sendCreate(ctx: Ctx, req: CreateRequest, predicted: Address): Promise<Sent>;
  sendCall(ctx: Ctx, req: CallRequest): Promise<Sent>;
  effectPresent(ctx: Ctx, plan: Plan, step: PlannedStep): Promise<boolean>;
  readColdkey(ctx: Ctx, vault: Address): Promise<Hex>;
}

const VIEWS = parseAbi([
  "function keeper() view returns (address)",
  "function payoutDelay() view returns (uint64)",
  "function addressMapping(address addr) view returns (bytes32)",
]);

/** Whether a step's result is already on-chain (so a lost record entry is recovered, not re-sent). */
export async function effectPresent(ctx: Ctx, plan: Plan, step: PlannedStep): Promise<boolean> {
  const a = plan.addresses;
  try {
    switch (step.id) {
      case "baseAdapter":
      case "frontDoor":
      case "bitAdapter":
      case "vault":
        return (await codeAt(ctx.rpc, step.chain, a[step.id])) !== "0x";
      // balances read 500 rao (5e11 wei) below what was sent (the existential deposit)
      case "adapterReserve":
        return (await balanceOf(ctx.rpc, "bittensor", a.bitAdapter)) >= SETTINGS.adapterReserve - 5n * 10n ** 11n;
      case "vaultReserve":
        return (await balanceOf(ctx.rpc, "bittensor", a.vault)) >= SETTINGS.vaultReserve - 5n * 10n ** 11n;
      case "setKeeper":
        return (await read(ctx.rpc, "bittensor", { address: a.vault, abi: VIEWS, functionName: "keeper" })) === WALLET;
      case "setPayoutDelay":
        return (
          (await read(ctx.rpc, "bittensor", { address: a.vault, abi: VIEWS, functionName: "payoutDelay" })) ===
          BigInt(SETTINGS.payoutDelay)
        );
    }
  } catch {
    // a read from a contract that does not exist yet
    return false;
  }
}

export const readColdkey = async (ctx: Ctx, vault: Address): Promise<Hex> =>
  (await read(ctx.rpc, "bittensor", {
    address: PRECOMPILE.addressMapping,
    abi: VIEWS,
    functionName: "addressMapping",
    args: [vault],
  })) as Hex;

const realDeps: DeployDeps = { sendCreate, sendCall, effectPresent, readColdkey };

type Receipt = { status: Hex; blockNumber: Hex; gasUsed: Hex; effectiveGasPrice: Hex } | null;

/** Settles a transaction left pending by an earlier run; returns once nothing is pending. */
async function settlePending(ctx: Ctx, rec: DeploymentRecord, path: string): Promise<void> {
  const p = rec.pending;
  if (!p) return;
  const where = `${chainLabel(p.chain)} nonce ${p.nonce}`;
  if (p.hash) {
    const r = (await ctx.rpc.request(p.chain, "eth_getTransactionReceipt", [p.hash])) as Receipt;
    if (!r) throw new Error(`${where} (transaction ${p.hash}) is still pending; run deploy again once it is mined`);
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
      ...(step.kind === "create" ? { address: rec.plan.addresses[step.id as keyof Plan["addresses"]] } : {}),
    };
  } else {
    const mined = hexToNumber((await ctx.rpc.request(p.chain, "eth_getTransactionCount", [WALLET, "latest"])) as Hex);
    if (mined <= p.nonce) throw new Error(`${where} is still pending; run deploy again once it is mined`);
    // mined: the effect check below records it as recovered, or the nonce check voids the plan
  }
  delete rec.pending;
  saveRecord(path, rec);
}

/** Deploys and configures everything, resuming after any stop; saves the record after every step. */
export async function deploy(ctx: Ctx, path: string, opts: { newPlan: boolean }, deps: DeployDeps = realDeps) {
  let rec = loadRecord(path);
  if (rec && opts.newPlan) {
    ctx.log(`Archived the old plan to ${archiveRecord(path)}`);
    rec = null;
  }
  if (!rec) {
    const baseNonce = await nonceOf(ctx.rpc, "base", WALLET);
    const bitNonce = await nonceOf(ctx.rpc, "bittensor", WALLET);
    const vault = getContractAddress({ from: WALLET, nonce: BigInt(bitNonce + 1) });
    rec = {
      target: ctx.live ? "live" : "rehearsal",
      wallet: WALLET,
      createdAt: new Date().toISOString(),
      plan: buildPlan(baseNonce, bitNonce, await deps.readColdkey(ctx, vault)),
      done: {},
    };
    saveRecord(path, rec);
    ctx.log(`Planned the deployment from the wallet's nonces: Base ${baseNonce}, Bittensor ${bitNonce}`);
  }
  if (rec.target !== (ctx.live ? "live" : "rehearsal")) {
    throw new Error(`${path} is a ${rec.target} record; it cannot be used for this run`);
  }
  await settlePending(ctx, rec, path);

  for (const step of rec.plan.steps) {
    if (rec.done[step.id]) continue;
    if (await deps.effectPresent(ctx, rec.plan, step)) {
      rec.done[step.id] = { recovered: true };
      saveRecord(path, rec);
      ctx.log(`${chainLabel(step.chain)}: ${step.label} — already done on-chain, recorded`);
      continue;
    }
    const current = await nonceOf(ctx.rpc, step.chain, WALLET);
    if (current !== step.nonce) {
      throw new Error(
        `${chainLabel(step.chain)}: the plan no longer matches the wallet (nonce ${current}, expected ${step.nonce}); run deploy --new-plan to start over from the current nonces`,
      );
    }
    try {
      rec.done[step.id] =
        step.kind === "create"
          ? await deps.sendCreate(ctx, step, rec.plan.addresses[step.id as keyof Plan["addresses"]])
          : await deps.sendCall(ctx, step);
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
