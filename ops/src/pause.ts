import { type Address, encodeFunctionData, formatEther, type Hex, hexToBigInt, parseAbi } from "viem";
import type { ChainName, Env, Paths } from "./config.ts";
import { emitCalls } from "./handoff.ts";
import type { DeploymentRecord } from "./record.ts";
import { balanceOf, gasPriceOf, nonceOf, read } from "./rpc.ts";
import { accountKind } from "./safe.ts";
import { type Ctx, chainLabel, describeRevert, type Sent, type Signer, sendCall, signingAccount, unit } from "./send.ts";
import { type NewWalletCall, walletFile, writeWalletFile, wroteLine } from "./wallet.ts";

export type PauseTarget = "front-door" | "vault" | "both";
export const PAUSE_TARGETS: readonly PauseTarget[] = ["front-door", "vault", "both"];

export const PAUSE_ABI = parseAbi([
  "function pause()",
  "function unpause()",
  "function paused() view returns (bool)",
  "function guardian() view returns (address)",
  "function owner() view returns (address)",
]);

type Role = "guardian" | "owner";

export interface PauseOpts {
  action: "pause" | "unpause";
  target: PauseTarget;
  /** --live: send. Otherwise a dry run: reads, an estimate and the keystore check, nothing sent. */
  send: boolean;
  /** The keystore that signs for the guardian (pause) or the owner (unpause), once its address is read. */
  signer: (role: Role, address: Address) => Signer;
  outDir: string;
  /** --for-wallet: a plain account's call is checked (the estimate and its gas money, no keystore) and
   * written to a call file here, for pnpm ops sign to send from MetaMask. Nothing is sent, even with send. */
  walletDir?: string;
  /** The deployment's name, for the files' names */
  name: string;
  now: number;
}

/** The guardian's keystore from OPS_GUARDIAN_KEYSTORE and OPS_GUARDIAN_PASSWORD_FILE, the owner's from
 * OPS_OWNER_KEYSTORE and OPS_OWNER_PASSWORD_FILE; either falls back to the test wallet's (OPS_KEYSTORE),
 * which the signer check then refuses unless it really signs as that address. */
export function pauseSigner(env: Env, p: Pick<Paths, "keystore" | "passwordFile">, role: Role, address: Address): Signer {
  const prefix = role === "guardian" ? "OPS_GUARDIAN" : "OPS_OWNER";
  return {
    address,
    keystore: env[`${prefix}_KEYSTORE`] ?? p.keystore,
    passwordFile: env[`${prefix}_PASSWORD_FILE`] ?? p.passwordFile,
    name: `the ${role}`,
  };
}

/** `pnpm ops pause [front-door|vault|both] [--live]` and `unpause`: pause (as the guardian) or unpause (as
 * the owner, its only caller) the front door on Base, the vault on Bittensor, or both, front door first.
 * Who calls is read from each contract (guardian(), owner()), not the plan, so it follows any change
 * since. A plain account signs with its keystore (pauseSigner): a dry run estimates the call and checks
 * the keystore signs as that account, and --live sends it through the usual send checks; with
 * --for-wallet (walletDir) its call is estimated and written to a call file for pnpm ops sign to send from
 * MetaMask (a Ledger), and no keystore is used. A Safe gets a
 * Transaction Builder file (a timelock a schedule and an execute file) and nothing is sent. A plain account
 * holding an EIP-7702 delegation is warned about (its key may be a thief's too) but still signs: an
 * emergency pause is never held up by it. Each chain stands alone: a problem on one is reported and the
 * other still goes ahead. */
export async function pauseCommand(
  ctx: Ctx,
  rec: DeploymentRecord,
  o: PauseOpts,
  deps: { sendCall: (ctx: Ctx, req: Parameters<typeof sendCall>[1]) => Promise<Sent> } = { sendCall },
): Promise<{ ok: boolean; lines: string[]; files: string[]; sent: Sent[] }> {
  const a = rec.plan.addresses;
  const role: Role = o.action === "pause" ? "guardian" : "owner";
  const targets: [ChainName, string, Address][] = [
    ...(o.target !== "vault" ? [["base", "front door", a.frontDoor] as [ChainName, string, Address]] : []),
    ...(o.target !== "front-door" ? [["bittensor", "vault", a.vault] as [ChainName, string, Address]] : []),
  ];
  const lines: string[] = [];
  const files: string[] = [];
  const sent: Sent[] = [];
  const wallet: NewWalletCall[] = [];
  let ok = true;
  const problem = (line: string) => {
    ok = false;
    lines.push(`PROBLEM — ${line}`);
  };
  const call = `${o.action}()`;
  const data = encodeFunctionData({ abi: PAUSE_ABI, functionName: o.action });

  for (const [chain, what, address] of targets) {
    const where = `${chainLabel(chain)} ${what} ${address}`;
    try {
      const paused = (await read(ctx.rpc, chain, { address, abi: PAUSE_ABI, functionName: "paused" })) as boolean;
      if (paused === (o.action === "pause")) {
        lines.push(`${where}: already ${o.action === "pause" ? "paused" : "running (not paused)"}`);
        continue;
      }
      const who = (await read(ctx.rpc, chain, { address, abi: PAUSE_ABI, functionName: role })) as Address;
      const kind = await accountKind(ctx, chain, who);
      if (kind.kind !== "account") {
        if (role === "guardian" && kind.kind === "timelock") lines.push(`${where}: the guardian ${who} is a timelock, so it can't pause quickly; a guardian should be a Safe or a plain account`);
        const out = await emitCalls(ctx, chain, who, [{ to: address, data, description: `${call} on the ${what}` }], {
          outDir: o.outDir,
          stem: `${o.name}-${o.action}-${chain}`,
          title: `Cascade ${o.name}: ${o.action} the ${what} on ${chainLabel(chain)}`,
          now: o.now,
          // pause and unpause happen more than once: a timelock needs a new operation id each time
          saltLabel: `${o.name}-${o.action}-${chain}:${o.now}`,
        });
        lines.push(...out.lines);
        files.push(...out.files);
        continue;
      }
      // a plain account whose key has signed an EIP-7702 delegation: said loudly, never in the way of the call
      if (kind.delegation) {
        lines.push(
          `WARNING — ${where}: the ${role} ${who} has code, an EIP-7702 delegation to ${kind.delegation}: assume its key is compromised and rotate the ${role}. This doesn't stop ${call}, which its key still signs.`,
        );
      }
      let gas: bigint;
      try {
        gas = hexToBigInt((await ctx.rpc.request(chain, "eth_estimateGas", [{ from: who, to: address, data }])) as Hex);
      } catch (e) {
        problem(`${where}: ${call} from the ${role} ${who} would fail (${describeRevert(ctx, e)}); nothing sent`);
        continue;
      }
      // the node takes a transaction only when the key can pay its whole gas limit (the send's 1.25×
      // the estimate) at the going price; an empty guardian key can't pause
      const checkGasMoney = async () => {
        const limit = (gas * 125n + 99n) / 100n;
        const need = limit * (await gasPriceOf(ctx.rpc, chain));
        const holds = await balanceOf(ctx.rpc, chain, who);
        if (holds < need) {
          lines.push(
            `WARNING — ${where}: the ${role} ${who} holds ${formatEther(holds)} ${unit(chain)}, but ${call} needs about ${formatEther(need)} ${unit(chain)} of gas (its ${limit.toLocaleString("en-US")} gas limit at today's price): fund it now, before you need it`,
          );
        }
      };
      if (o.walletDir) {
        // signed in MetaMask, not with a keystore: no keystore is opened, nothing is sent
        wallet.push({ chainId: ctx.targets[chain].chainId, to: address, data, label: `${call} on the ${what}`, from: who });
        lines.push(`${where}: ${call} from the ${role} ${who} would succeed (about ${gas.toLocaleString("en-US")} gas): added to the wallet file.`);
        await checkGasMoney();
        continue;
      }
      const signer = o.signer(role, who);
      if (!o.send) {
        const signs = await signingAccount(ctx, signer);
        if (!signs || signs.toLowerCase() !== who.toLowerCase()) {
          const env = role === "guardian" ? "OPS_GUARDIAN" : "OPS_OWNER";
          problem(`${where}: the keystore ${signer.keystore} signs as ${signs ?? "no account (it can't be opened)"}, not the ${role} ${who}: set ${env}_KEYSTORE and ${env}_PASSWORD_FILE to its key`);
          continue;
        }
        lines.push(
          `${where}: dry run: ${call} from the ${role} ${who} would succeed (about ${gas.toLocaleString("en-US")} gas), and ${signer.keystore} signs as it. Add --live to send it.`,
        );
        await checkGasMoney();
        continue;
      }
      const done = await deps.sendCall(
        { ...ctx, signer },
        { chain, nonce: await nonceOf(ctx.rpc, chain, who), label: `${o.action} the ${what}`, to: address, abi: PAUSE_ABI, functionName: o.action, args: [] },
      );
      sent.push(done);
      lines.push(`${where}: ${o.action === "pause" ? "paused" : "unpaused"} (transaction ${done.hash})`);
    } catch (e) {
      problem(`${where}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  if (o.walletDir && wallet.length) {
    const file = walletFile({ title: `Cascade ${o.name}: ${o.action}`, deployment: o.name, now: o.now, calls: wallet });
    const path = writeWalletFile(o.walletDir, `${o.name}-${o.action}`, file);
    files.push(path);
    lines.push(wroteLine(path, wallet.length));
  }
  return { ok, lines, files, sent };
}
