import { decodeFunctionResult, encodeFunctionData, type Hex, hexToNumber, numberToHex, parseAbi } from "viem";
import { type Deps, d1Args, isEnv, parseArgs, rowsOf, runIfMain, shown } from "./d1.ts";

// pnpm alpha-target -- --env <test|production> --vault <0x…> (--show | --block <n|latest> [--rpc <url>]) [--dry-run]
//
// The monitor's own record of the deploy's AlphaVault's migration target (R4-O rounds 3 and 4: rails.incoherent writes it
// to meta, alpha_target_seen:<vault>, whenever it reads a non-zero target live, and accepts that address for the
// replacement pair once ForeverMoney's finishMigration clears the target). --show prints it. If it was lost (the
// database wiped, or the monitor not running through the notice), --block restores it from a read of the chain: the
// vault's migrationTarget() at that block, on Bittensor's archive node (the default RPC), or at the latest block while
// the target still reads. It writes only an address the vault announced at that block, never one typed in, so the record
// stays something the vault announced (runbook 7.7). Needs Cloudflare account access (wrangler logged in); with --dry-run
// it reads the chain and prints the statement, running nothing on D1.

const USAGE = "usage: pnpm alpha-target -- --env <test|production> --vault <0x…> (--show | --block <n|latest> [--rpc <url>]) [--dry-run]";
const ARCHIVE = "https://archive.chain.opentensor.ai";
const ABI = parseAbi(["function migrationTarget() view returns (address)"]);
const ZERO = "0x0000000000000000000000000000000000000000";
const VAULT_RE = /^0x[0-9a-fA-F]{40}$/;
const BITTENSOR_CHAIN_ID = 964;

export interface AlphaTargetDeps extends Deps {
  /** eth_chainId of `rpc` (R4-O's last Minors: only Bittensor's, 964, is read or written from) */
  chainId: (rpc: string) => Promise<number>;
  /** eth_call `data` to `to` at block `tag` on `rpc`: the answer's bytes */
  ethCall: (rpc: string, to: string, data: Hex, tag: string) => Promise<Hex>;
}

/** The meta key rails.incoherent keeps the record under (src/rules/rails.ts alphaTargetKey). */
const keyOf = (vault: string) => `alpha_target_seen:${vault.toLowerCase()}`;

export async function main(argv: string[], deps: AlphaTargetDeps): Promise<number> {
  const a = parseArgs(argv, ["env", "vault", "block", "rpc"], ["show", "dry-run"]);
  const refuse = (why: string) => {
    deps.print(`${why}\n${USAGE}`);
    return 2;
  };
  if ("error" in a) return refuse(a.error);
  const env = a.opts.env;
  if (!isEnv(env)) return refuse("--env must be test or production");
  const vault = a.opts.vault ?? "";
  if (!VAULT_RE.test(vault)) return refuse("--vault must be the deploy's AlphaVault, an address (0x and 40 hex digits)");
  const show = a.flags.has("show");
  if (show === (a.opts.block !== undefined)) return refuse("give exactly one of --show and --block");
  const key = keyOf(vault);
  if (show) {
    const rows = rowsOf(await deps.wrangler(d1Args(env, `SELECT k, v FROM meta WHERE k = '${key}'`, true)));
    deps.print(rows.length ? `the monitor's record of ${vault.toLowerCase()}'s migration target: ${String(rows[0].v)}` : `${vault.toLowerCase()}: the monitor has no record of its migration target`);
    return 0;
  }
  const block = a.opts.block as string;
  if (block !== "latest" && !/^\d+$/.test(block)) return refuse("--block must be a Bittensor block number, or latest");
  const tag = block === "latest" ? "latest" : numberToHex(BigInt(block));
  const rpc = a.opts.rpc ?? ARCHIVE;
  // Bittensor's chain only: another chain's vault at the same address would seed a target the deploy's never announced
  const chain = await deps.chainId(rpc);
  if (chain !== BITTENSOR_CHAIN_ID) return refuse(`${rpc} is chain ${chain}, not Bittensor's (${BITTENSOR_CHAIN_ID}): nothing read or written`);
  const out = await deps.ethCall(rpc, vault.toLowerCase(), encodeFunctionData({ abi: ABI, functionName: "migrationTarget" }), tag);
  const target = String(decodeFunctionResult({ abi: ABI, functionName: "migrationTarget", data: out })).toLowerCase();
  deps.print(`${vault.toLowerCase()}'s migrationTarget() at block ${block}: ${target}`);
  if (target === ZERO) {
    deps.print(`${vault.toLowerCase()} announced no migration target at block ${block}: nothing written`);
    return 1;
  }
  const write = d1Args(env, `INSERT INTO meta (k, v) VALUES ('${key}', '${target}') ON CONFLICT (k) DO UPDATE SET v = excluded.v`);
  if (a.flags.has("dry-run")) {
    deps.print(`would write the monitor's record:\n  ${shown(write)}`);
    return 0;
  }
  deps.print(await deps.wrangler(write));
  deps.print(`the monitor's record of ${vault.toLowerCase()}'s migration target is ${target} (read at block ${block})`);
  return 0;
}

/** One JSON-RPC request (no key: Bittensor's public archive node by default). */
async function request(rpc: string, method: string, params: unknown[]): Promise<Hex> {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: Hex; error?: { message?: string } };
  if (!j.result) throw new Error(`${method} failed: ${j.error?.message ?? r.status}`);
  return j.result;
}
const ethCall = (rpc: string, to: string, data: Hex, tag: string) => request(rpc, "eth_call", [{ to, data }, tag]);
const chainId = async (rpc: string) => hexToNumber(await request(rpc, "eth_chainId", []));

runIfMain(import.meta.url, (argv, deps) => main(argv, { ...deps, ethCall, chainId }));
