import { type Address, decodeEventLog, type Hex, parseAbi } from "viem";
import { type Artifact, loadArtifact, maskImmutables } from "./artifacts.ts";
import { type ChainName, LIVE, PRECOMPILE, SETTINGS, WALLET } from "./config.ts";
import type { Plan } from "./plan.ts";
import type { DeploymentRecord, VerifyResult } from "./record.ts";
import { balanceOf, codeAt, read } from "./rpc.ts";
import { scanLogs, startBlock } from "./keeper/state.ts";
import { type Ctx, chainLabel } from "./send.ts";

export type { VerifyResult } from "./record.ts";

export interface Expectation {
  chain: ChainName;
  contract: string;
  address: Address;
  field: string;
  args?: readonly unknown[];
  expected: unknown;
}

export const keyOf = (e: Pick<Expectation, "chain" | "contract" | "field">) => `${e.chain}:${e.contract}.${e.field}`;

const same = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Every setting the spec's read-back lists, from the plan. */
export function expectations(plan: Plan): Expectation[] {
  const a = plan.addresses;
  const out: Expectation[] = [];
  const add = (chain: ChainName, contract: string, address: Address, fields: Record<string, unknown>) => {
    for (const [field, expected] of Object.entries(fields)) out.push({ chain, contract, address, field, expected });
  };
  const adapter = (local: "base" | "bittensor", remoteAdapter: Address, gas: { base: bigint; perEntry: bigint }) => {
    const remote = local === "base" ? LIVE.bittensor : LIVE.base;
    return {
      router: LIVE[local].ROUTER,
      token: LIVE[local].TOKEN,
      localChainId: BigInt(LIVE[local].CHAIN_ID),
      remoteChainId: BigInt(remote.CHAIN_ID),
      remoteSelector: remote.SELECTOR,
      remoteAdapter,
      gasBase: gas.base,
      gasPerEntry: gas.perEntry,
    };
  };
  add("base", "CcipBaseAdapter", a.baseAdapter, {
    ...adapter("base", a.bitAdapter, SETTINGS.baseGas),
    minSendAmount: SETTINGS.minSendAmount,
  });
  add("bittensor", "CcipBittensorAdapter", a.bitAdapter, {
    ...adapter("bittensor", a.baseAdapter, SETTINGS.bitGas),
    alphaVault: LIVE.ALPHA_VAULT,
  });
  add("base", "CascadeFrontDoor", a.frontDoor, {
    vault: a.vault,
    vaultChain: BigInt(LIVE.bittensor.CHAIN_ID),
    primaryBridge: a.baseAdapter,
    asset: LIVE.base.TOKEN,
    owner: WALLET,
    guardian: WALLET,
    batchInterval: BigInt(SETTINGS.batchInterval),
    minDeposit: SETTINGS.minDeposit,
    depositCap: SETTINGS.depositCap,
    redeemRequestFee: SETTINGS.redeemRequestFee,
  });
  add("bittensor", "CascadeVault", a.vault, {
    stakeHotkey: SETTINGS.hotkey,
    primaryBridge: a.bitAdapter,
    owner: WALLET,
    guardian: WALLET,
    keeper: WALLET,
    payoutDelay: BigInt(SETTINGS.payoutDelay),
  });
  return out;
}

export function compare(expected: Expectation[], actual: Map<string, unknown>): string[] {
  return expected
    .filter((e) => !same(e.expected, actual.get(keyOf(e))))
    .map((e) => `${chainLabel(e.chain)} ${e.contract}.${e.field}: expected ${e.expected}, found ${actual.get(keyOf(e))}`);
}

export function codeMismatch(
  chain: ChainName,
  contract: string,
  onchain: Hex,
  artifact: Pick<Artifact, "deployedBytecode" | "immutableRanges">,
): string | null {
  const want = maskImmutables(artifact.deployedBytecode, artifact.immutableRanges).toLowerCase();
  const got = maskImmutables(onchain, artifact.immutableRanges).toLowerCase();
  return want === got ? null : `${chainLabel(chain)} ${contract}: deployed code differs from the build`;
}

const ACTIVATED = parseAbi(["event FrontDoorActivated(uint64 indexed chain, address indexed addr)"]);

export function frontDoorActivationFailures(logs: { address: Address; topics: Hex[]; data: Hex }[], plan: Plan): string[] {
  const hits = logs
    .filter((l) => same(l.address, plan.addresses.vault))
    .flatMap((l) => {
      try {
        return [decodeEventLog({ abi: ACTIVATED, topics: l.topics as [Hex, ...Hex[]], data: l.data }).args];
      } catch {
        return [];
      }
    });
  const ok = hits.length === 1 && hits[0].chain === BigInt(LIVE.base.CHAIN_ID) && same(hits[0].addr, plan.addresses.frontDoor);
  return ok ? [] : [`Bittensor CascadeVault: expected exactly one FrontDoorActivated(8453, front door) at deploy, found ${hits.length}`];
}

/** The vault's FrontDoorActivated logs: from its creation receipt, or (a recovered creation, whose
 * transaction was never recorded) from its logs, which only its constructor can have emitted. */
export async function activationLogs(ctx: Ctx, rec: DeploymentRecord): Promise<{ address: Address; topics: Hex[]; data: Hex }[]> {
  const created = rec.done.vault;
  if (created && "hash" in created) {
    const r = (await ctx.rpc.request("bittensor", "eth_getTransactionReceipt", [created.hash])) as {
      logs: { address: Address; topics: Hex[]; data: Hex }[];
    };
    return r.logs;
  }
  const ev = ACTIVATED[0];
  const logs = await scanLogs(ctx, "bittensor", rec.plan.addresses.vault, ev, await startBlock(ctx, rec, "bittensor"));
  return logs.map((l) => l.raw);
}

/** Balances read 500 rao (5e11 wei) below what was sent. */
export function reserveFailures(adapterBalance: bigint, vaultBalance: bigint): string[] {
  const out: string[] = [];
  const ed = 5n * 10n ** 11n;
  if (adapterBalance < SETTINGS.adapterReserve - ed) out.push(`Bittensor CcipBittensorAdapter: reserve reads ${adapterBalance} wei, expected at least ${SETTINGS.adapterReserve - ed}`);
  if (vaultBalance < SETTINGS.vaultReserve - ed) out.push(`Bittensor CascadeVault: reserve reads ${vaultBalance} wei, expected at least ${SETTINGS.vaultReserve - ed}`);
  return out;
}

const VAULT_EXTRA = parseAbi([
  "function coldkey() view returns (bytes32)",
  "function peerId(uint64 chain, address addr) pure returns (bytes32)",
  "function frontDoorActive(bytes32) view returns (bool)",
  "function addressMapping(address addr) view returns (bytes32)",
]);

/** Reads everything back on both chains and compares it with the plan; saves nothing itself. */
export async function verify(ctx: Ctx, rec: DeploymentRecord): Promise<VerifyResult> {
  const plan = rec.plan;
  const exp = expectations(plan);
  const actual = new Map<string, unknown>();
  const artifacts = new Map<string, Artifact>();
  const art = (name: string) => artifacts.get(name) ?? artifacts.set(name, loadArtifact(ctx.paths.contractsDir, name)).get(name)!;
  for (const e of exp) {
    try {
      actual.set(keyOf(e), await read(ctx.rpc, e.chain, { address: e.address, abi: art(e.contract).abi, functionName: e.field }));
    } catch (err) {
      actual.set(keyOf(e), `unreadable (${(err as Error).message.split("\n")[0]})`);
    }
  }
  const failures = compare(exp, actual);

  const v = plan.addresses.vault;
  const coldkey = await read(ctx.rpc, "bittensor", { address: v, abi: VAULT_EXTRA, functionName: "coldkey" });
  const mapped = await read(ctx.rpc, "bittensor", { address: PRECOMPILE.addressMapping, abi: VAULT_EXTRA, functionName: "addressMapping", args: [v] });
  if (!same(coldkey, mapped)) failures.push(`Bittensor CascadeVault.coldkey: expected ${mapped}, found ${coldkey}`);
  const chain = actual.get(keyOf({ chain: "bittensor", contract: "CcipBittensorAdapter", field: "remoteChainId" }));
  const peer = await read(ctx.rpc, "bittensor", { address: v, abi: VAULT_EXTRA, functionName: "peerId", args: [chain, plan.addresses.frontDoor] });
  if ((await read(ctx.rpc, "bittensor", { address: v, abi: VAULT_EXTRA, functionName: "frontDoorActive", args: [peer] })) !== true) {
    failures.push("Bittensor CascadeVault: the front door is not active under the adapter's remote chain id");
  }

  failures.push(...frontDoorActivationFailures(await activationLogs(ctx, rec), plan));

  failures.push(
    ...reserveFailures(await balanceOf(ctx.rpc, "bittensor", plan.addresses.bitAdapter), await balanceOf(ctx.rpc, "bittensor", v)),
  );

  const contracts: [ChainName, string, Address][] = [
    ["base", "CcipBaseAdapter", plan.addresses.baseAdapter],
    ["base", "CascadeFrontDoor", plan.addresses.frontDoor],
    ["bittensor", "CcipBittensorAdapter", plan.addresses.bitAdapter],
    ["bittensor", "CascadeVault", v],
  ];
  for (const [c, name, addr] of contracts) {
    const m = codeMismatch(c, name, await codeAt(ctx.rpc, c, addr), art(name));
    if (m) failures.push(m);
  }
  return { ok: failures.length === 0, failures, checkedAt: new Date().toISOString() };
}
