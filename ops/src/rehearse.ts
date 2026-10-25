import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { type Address, decodeEventLog, encodeFunctionData, formatEther, type Hex, numberToHex, parseAbi } from "viem";
import { loadArtifact } from "./artifacts.ts";
import { type ChainName, type Env, LIVE, PRECOMPILE, paths, targets, WALLET } from "./config.ts";
import { deploy } from "./deploy.ts";
import { close } from "./keeper/actions.ts";
import { keeperDeps } from "./keeper/state.ts";
import { type DeploymentRecord, saveRecord } from "./record.ts";
import { chainIdOf, createRpc, type Rpc } from "./rpc.ts";
import { type Ctx, execFileRunner } from "./send.ts";
import { verify } from "./verify.ts";

const BITTENSOR_ARCHIVE = "https://archive.chain.opentensor.ai";
/** Forks always use the public Base RPC, so a keyed RPC from .env never lands in anvil's log. */
const PUBLIC_BASE_RPC = "https://mainnet.base.org";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUp(rpc: Rpc, chain: ChainName, ms = 180_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await chainIdOf(rpc, chain);
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`the local ${chain} fork did not start: ${(e as Error).message}`);
      await sleep(1_000);
    }
  }
}

export interface Rehearsal {
  ctx: Ctx;
  recordPath: string;
  stop(): void;
}

/** Two local anvil forks at the live state with their own chain ids (31337, 31338), so nothing signed
 * here can be replayed on Base or Bittensor; stand-ins at Bittensor's precompile addresses. */
export async function startForks(env: Env, log: (l: string) => void): Promise<Rehearsal> {
  const p = paths(env);
  const t = targets(env);
  mkdirSync(p.deploymentsDir, { recursive: true });
  const anvil = join(p.foundryBin, process.platform === "win32" ? "anvil.exe" : "anvil");
  const procs: ChildProcess[] = [];
  const start = (args: string[], name: string) => {
    const out = openSync(join(p.deploymentsDir, name), "w");
    procs.push(spawn(anvil, args, { stdio: ["ignore", out, out], windowsHide: true }));
  };
  const stop = () => {
    for (const c of procs) c.kill();
  };
  try {
    start(["--fork-url", PUBLIC_BASE_RPC, "--port", "8545", "--chain-id", "31337"], "rehearsal-anvil-base.log");
    start(
      ["--fork-url", BITTENSOR_ARCHIVE, "--port", "8547", "--chain-id", "31338", "--retries", "12", "--fork-retry-backoff", "20000", "--timeout", "60000"],
      "rehearsal-anvil-bittensor.log",
    );
    const rpc = createRpc(t.rehearsal, { minIntervalMs: { bittensor: 0 } });
    await waitUp(rpc, "base");
    await waitUp(rpc, "bittensor");
    const standIns: [string, string][] = [
      ["RehearsalAddressMapping", PRECOMPILE.addressMapping],
      ["RehearsalStaking", PRECOMPILE.staking],
      ["RehearsalBalanceTransfer", PRECOMPILE.balanceTransfer],
    ];
    for (const [name, addr] of standIns) {
      await rpc.request("bittensor", "anvil_setCode", [addr, loadArtifact(p.contractsDir, name).deployedBytecode]);
    }
    for (const chain of ["base", "bittensor"] as const) {
      await rpc.request(chain, "anvil_setBalance", [WALLET, numberToHex(10n ** 18n)]);
      // the forked Bittensor block has no prevrandao, which anvil's EVM requires; a local block has one
      await rpc.request(chain, "evm_mine", []);
    }
    log("Started local forks of Base and Bittensor (chain ids 31337 and 31338)");
    const ctx: Ctx = { live: false, targets: t.rehearsal, rpc, runner: execFileRunner, paths: p, log, receiptTimeoutMs: 120_000, pollMs: 500 };
    return { ctx, recordPath: join(p.deploymentsDir, "rehearsal.json"), stop };
  } catch (e) {
    stop();
    throw e;
  }
}

const REHEARSAL_ABI = parseAbi([
  "function mint(address account, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function deposit(uint256 amount)",
  "event BatchClosed(uint64 indexed id, uint256 totalDeposits, uint256 nDeposits, uint256 nRedeems, uint256 fee, uint256 potUsed)",
  "event Sent(bytes32 indexed messageId, uint64 destChain, address indexed sender, address indexed recipient, uint256 amount, uint256 fee, uint256 gasLimit)",
]);
/** anvil's first default account, unlocked on every fork; it plays the depositor. */
const DEPOSITOR: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

type Log = { address: Address; topics: Hex[]; data: Hex };

async function sendAs(rpc: Rpc, from: Address, to: Address, data: Hex) {
  const hash = (await rpc.request("base", "eth_sendTransaction", [{ from, to, data }])) as Hex;
  for (let i = 0; i < 60; i++) {
    const r = (await rpc.request("base", "eth_getTransactionReceipt", [hash])) as { status: Hex } | null;
    if (r) {
      if (r.status !== "0x1") throw new Error(`rehearsal transaction from ${from} reverted (${hash})`);
      return;
    }
    await sleep(500);
  }
  throw new Error(`rehearsal transaction from ${from} was not mined (${hash})`);
}

/** On the Base fork: the CCIP token pool (the token's minter) mints 0.01 TAO to an unlocked account,
 * which deposits it; ten minutes later the keeper's
 * close through the real Router; records its gas and fee for the budget. */
async function rehearseClose(r: Rehearsal, rec: DeploymentRecord, log: (l: string) => void) {
  const { rpc } = r.ctx;
  const fd = rec.plan.addresses.frontDoor;
  const call = (functionName: string, args: unknown[]) => encodeFunctionData({ abi: REHEARSAL_ABI, functionName, args } as never);
  await rpc.request("base", "anvil_impersonateAccount", [LIVE.base.POOL]);
  await rpc.request("base", "anvil_setBalance", [LIVE.base.POOL, numberToHex(10n ** 18n)]);
  await sendAs(rpc, LIVE.base.POOL, LIVE.base.TOKEN, call("mint", [DEPOSITOR, 10n ** 16n]));
  await sendAs(rpc, DEPOSITOR, LIVE.base.TOKEN, call("approve", [fd, 10n ** 16n]));
  await sendAs(rpc, DEPOSITOR, fd, call("deposit", [10n ** 16n]));
  await rpc.request("base", "evm_increaseTime", [600]);
  await rpc.request("base", "evm_mine", []);

  const sent = await close(keeperDeps(r.ctx, rec, r.recordPath), rec);
  const receipt = (await rpc.request("base", "eth_getTransactionReceipt", [sent.hash])) as { logs: Log[] };
  const decoded = receipt.logs.flatMap((l) => {
    try {
      return [{ address: l.address, ...decodeEventLog({ abi: REHEARSAL_ABI, topics: l.topics as [Hex, ...Hex[]], data: l.data }) }];
    } catch {
      return [];
    }
  });
  const msg = decoded.find((d) => d.eventName === "Sent" && d.address.toLowerCase() === rec.plan.addresses.baseAdapter.toLowerCase());
  const closed = decoded.find((d) => d.eventName === "BatchClosed");
  if (!msg || !closed) throw new Error("the rehearsed close sent no bridge message");
  const fee = (closed.args as { fee: bigint }).fee;
  rec.rehearsalClose = { gasUsed: sent.gasUsed, fee };
  saveRecord(r.recordPath, rec);
  log(`Rehearsed a batch close: message ${(msg.args as { messageId: Hex }).messageId} sent, bridge fee ${formatEther(fee)} ETH`);
}

/** The full deployment and read-back on the local forks. Each run starts from fresh forks, so it
 * always plans anew; then a batch close. */
export async function rehearse(env: Env, log: (l: string) => void) {
  const r = await startForks(env, log);
  try {
    const rec = await deploy(r.ctx, r.recordPath, { newPlan: true });
    rec.verify = await verify(r.ctx, rec);
    saveRecord(r.recordPath, rec);
    log(
      rec.verify.ok
        ? "Read-back check: everything matches the plan"
        : `Read-back check failed:\n  ${rec.verify.failures.join("\n  ")}`,
    );
    if (rec.verify.ok) await rehearseClose(r, rec, log);
    return rec;
  } finally {
    r.stop();
  }
}
