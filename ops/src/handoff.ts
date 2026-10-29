import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, encodeFunctionData, type Hex, keccak256, parseAbi, stringToBytes, zeroAddress } from "viem";
import { type ChainName, WALLET } from "./config.ts";
import { cadenceOf, isPlanV3, type PlanV3, rolesOf } from "./plan.ts";
import type { DeploymentRecord } from "./record.ts";
import { read } from "./rpc.ts";
import { accountKind, type SafeCall, safeBatch, timelockCalls } from "./safe.ts";
import { type Ctx, chainLabel } from "./send.ts";
import { ownedContracts } from "./verify.ts";

const OWNABLE = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function acceptOwnership()",
]);
const ACCEPT = encodeFunctionData({ abi: OWNABLE, functionName: "acceptOwnership" });

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** "the front door" for CascadeFrontDoor, and so on. */
export const contractName = (name: string) =>
  ({ CascadeFrontDoor: "the front door", CascadeStaker: "the staker", CascadeVault: "the vault" })[name] ?? name;

export interface EmitOpts {
  outDir: string;
  /** The file name without .json, e.g. v3-launch-accept-ownership-base */
  stem: string;
  /** The batch's name in the Safe app */
  title: string;
  /** createdAt, in ms */
  now: number;
  /** What a timelock's salt is hashed from (default: the stem). A call that can be made again (pause,
   * unpause) needs a new one each time: the timelock refuses an operation id it has seen. */
  saltLabel?: string;
}

/** `calls` for `signer` on `chain` to make, in the form it can use: a plain account gets the transactions
 * printed, to send from it; a Safe (or another contract) one Transaction Builder batch file; an
 * OpenZeppelin timelock two, the schedule batch for its proposer and the execute batch for its executor
 * once the timelock's delay has passed. Reads only. */
export async function emitCalls(ctx: Pick<Ctx, "rpc" | "targets">, chain: ChainName, signer: Address, calls: SafeCall[], o: EmitOpts): Promise<{ lines: string[]; files: string[] }> {
  const where = chainLabel(chain);
  const chainId = ctx.targets[chain].chainId;
  const lines: string[] = [];
  const files: string[] = [];
  const write = (stem: string, title: string, batch: SafeCall[], safe?: Address) => {
    mkdirSync(o.outDir, { recursive: true });
    const path = join(o.outDir, `${stem}.json`);
    writeFileSync(path, `${JSON.stringify(safeBatch({ chainId, name: title, calls: batch, createdAt: o.now, safe }), null, 2)}\n`);
    files.push(path);
    return path;
  };
  const kind = await accountKind(ctx, chain, signer);
  if (kind.kind === "account") {
    lines.push(`${where}: ${signer} is a plain account (no code): send these from it, from any wallet that holds its key:`);
    for (const c of calls) lines.push(`  to ${c.to} data ${c.data}  (${c.description})`);
    return { lines, files };
  }
  if (kind.kind === "timelock") {
    const salt = keccak256(stringToBytes(`cascade:${o.saltLabel ?? o.stem}`));
    const t = timelockCalls(signer, calls, salt, kind.minDelay);
    const s = write(`${o.stem}-1-schedule`, `${o.title} (1 of 2: schedule)`, [t.schedule]);
    const e = write(`${o.stem}-2-execute`, `${o.title} (2 of 2: execute)`, [t.execute]);
    lines.push(
      `${where}: ${signer} is a timelock (minimum delay ${kind.minDelay} s). Its proposer's Safe loads ${s} in the Transaction Builder; once the delay has passed, its executor loads ${e}. The batch's salt ${salt}, operation id ${t.id}.`,
    );
    return { lines, files };
  }
  const path = write(o.stem, o.title, calls, kind.kind === "safe" ? signer : undefined);
  lines.push(
    kind.kind === "safe"
      ? `${where}: ${signer} is a Safe: load ${path} in its Transaction Builder (Safe{Wallet} → Apps → Transaction Builder → drag the file in), check the calls, then sign and execute.`
      : `${where}: ${signer} is a contract but neither a Safe nor a timelock this tool knows: ${path} holds the calls (to, value, data) for whatever controls it.`,
  );
  return { lines, files };
}

const ownership = async (ctx: Pick<Ctx, "rpc">, chain: ChainName, address: Address) => ({
  owner: (await read(ctx.rpc, chain, { address, abi: OWNABLE, functionName: "owner" })) as Address,
  pending: (await read(ctx.rpc, chain, { address, abi: OWNABLE, functionName: "pendingOwner" })) as Address,
});

function launchPlan(rec: DeploymentRecord): PlanV3 {
  const plan = rec.plan;
  if (!isPlanV3(plan) || cadenceOf(plan) !== "launch") throw new Error("the test plan keeps the test wallet as owner: nothing to hand off");
  return plan;
}

/** `pnpm ops handoff`: for each chain, the final owner's acceptOwnership() on each contract offered to
 * it (the front door and the staker on Base, the vault on Bittensor), as emitCalls gives them. A contract
 * already accepted is skipped; one not offered to the final owner yet is reported (deploy finishes the
 * plan). Sends nothing. */
export async function handoff(ctx: Pick<Ctx, "rpc" | "targets">, rec: DeploymentRecord, o: { outDir: string; name: string; now: number }) {
  const plan = launchPlan(rec);
  const roles = rolesOf(plan);
  const lines: string[] = [];
  const files: string[] = [];
  for (const chain of ["base", "bittensor"] as const) {
    const final = roles.owner[chain];
    const calls: SafeCall[] = [];
    for (const [c, name, address] of ownedContracts(plan).filter(([c]) => c === chain)) {
      const { owner, pending } = await ownership(ctx, c, address);
      if (same(owner, final)) {
        lines.push(`${chainLabel(c)} ${name}: already accepted by ${final}`);
        continue;
      }
      if (!same(pending, final)) {
        lines.push(`${chainLabel(c)} ${name}: not offered to ${final} yet (owner ${owner}, pendingOwner ${pending}): run deploy to finish the plan`);
        continue;
      }
      calls.push({ to: address, data: ACCEPT as Hex, description: `acceptOwnership() on ${contractName(name)}` });
    }
    if (!calls.length) continue;
    const out = await emitCalls(ctx, chain, final, calls, {
      outDir: o.outDir,
      stem: `${o.name}-accept-ownership-${chain}`,
      title: `Cascade ${o.name}: accept ownership on ${chainLabel(chain)}`,
      now: o.now,
    });
    lines.push(...out.lines);
    files.push(...out.files);
  }
  lines.push("After the owners accept, run pnpm ops ownership (and verify) to confirm.");
  return { lines, files };
}

/** `pnpm ops ownership`: each owned contract's owner and pending owner, against the plan. Not ok only
 * when something is neither the plan's state nor a step on the way to it. */
export async function ownershipStatus(ctx: Pick<Ctx, "rpc">, rec: DeploymentRecord): Promise<{ ok: boolean; lines: string[] }> {
  const plan = rec.plan;
  if (!isPlanV3(plan)) throw new Error("the v2 deployment has no hand-off");
  const launch = cadenceOf(plan) === "launch";
  const roles = rolesOf(plan);
  let ok = true;
  const lines: string[] = [];
  for (const [chain, name, address] of ownedContracts(plan)) {
    const final = roles.owner[chain];
    const { owner, pending } = await ownership(ctx, chain, address);
    const none = same(pending, zeroAddress);
    let status: string;
    if (!launch) status = same(owner, WALLET) && none ? "the test plan keeps the test wallet as owner" : "UNEXPECTED: the test plan keeps the test wallet as owner";
    else if (same(owner, final) && none) status = "accepted by the final owner";
    else if (same(owner, WALLET) && same(pending, final)) status = `offered, waiting for ${final} to accept`;
    else if (same(owner, WALLET) && none) status = "not offered yet: run deploy to finish the plan";
    else status = `UNEXPECTED: the plan hands it to ${final}`;
    if (status.startsWith("UNEXPECTED")) ok = false;
    lines.push(`${chainLabel(chain)} ${name} ${address}: owner ${owner}, pendingOwner ${pending} — ${status}`);
  }
  lines.push("The oracle and both adapters have no owner.");
  return { ok, lines };
}
