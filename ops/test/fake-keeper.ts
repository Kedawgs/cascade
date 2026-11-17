import {
  type Abi,
  type AbiFunction,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  type Hex,
  numberToHex,
  parseAbi,
  toFunctionSelector,
} from "viem";
import { type ChainName, paths, targets, WALLET } from "../src/config.ts";
import type { KeeperDeps } from "../src/keeper/actions.ts";
import { buildPlanV3 } from "../src/plan.ts";
import type { DeploymentRecord } from "../src/record.ts";
import { type Rpc, RpcError } from "../src/rpc.ts";
import type { Ctx, Sent } from "../src/send.ts";

export const COLDKEY: Hex = `0x${"44".repeat(32)}`;
export const SENT: Sent = { hash: `0x${"cc".repeat(32)}`, block: 1, gasUsed: 1n, costWei: 1n };

/** A complete, verified v3 deployment: the test plan, or `plan` with every one of its steps done (a
 * launch's hand-off accepted). */
export function v3Record(target: DeploymentRecord["target"] = "live", plan = buildPlanV3(0, 0, COLDKEY)): DeploymentRecord {
  return {
    target,
    wallet: WALLET,
    createdAt: "",
    plan,
    done: Object.fromEntries(plan.steps.map((s) => [s.id, SENT])),
    verify: { ok: true, failures: [], checkedAt: "", ...(plan.cadence === "launch" ? { handoff: "accepted" as const } : {}) },
  };
}

const ERROR_STRING = parseAbi(["error Error(string)"]);

/** What a node answers for a call that reverts with `require(false, reason)`. */
export const revert = (reason: string, chain: ChainName = "base") =>
  new RpcError(`${chain} eth_call: execution reverted: ${reason}`, 3, encodeErrorResult({ abi: ERROR_STRING, errorName: "Error", args: [reason] }));

/** The fake chains' heads: block FAKE_HEAD[chain] (or `head`) at 1,800,000,000, earlier blocks at each chain's block time (Base's
 * 200 ms, five to a whole second; Bittensor's 12 s), each block holding 40M gas. */
export const FAKE_HEAD: Record<ChainName, number> = { base: 60_000_000, bittensor: 7_000_000 };
export const FAKE_BLOCK_S: Record<ChainName, number> = { base: 0.2, bittensor: 12 };
export function fakeHeader(chain: ChainName, tag: unknown, head = FAKE_HEAD[chain]): { number: Hex; timestamp: Hex; gasLimit: Hex } {
  const n = tag === "latest" || tag === undefined ? head : Number(BigInt(tag as Hex));
  return { number: numberToHex(n), timestamp: numberToHex(1_800_000_000 - Math.floor((head - n) * FAKE_BLOCK_S[chain])), gasLimit: numberToHex(40_000_000) };
}

export type Answer = (args: readonly unknown[], call: { chain: ChainName; to: Hex; from?: Hex }) => unknown;

/** A chain that answers eth_call by function name (from `abis`); an answer may throw to revert. Other
 * methods come from `methods`. Every request is recorded. */
export function fakeChain(abis: readonly Abi[], answers: Record<string, Answer>, methods: Record<string, (chain: ChainName, params: unknown[]) => unknown> = {}) {
  const fns = abis.flat().filter((i): i is AbiFunction => i.type === "function");
  const calls: { chain: ChainName; method: string; fn?: string; args?: readonly unknown[]; to?: Hex }[] = [];
  const rpc: Rpc = {
    async request(chain, method, params) {
      if (method === "eth_call") {
        const tx = params[0] as { to: Hex; data: Hex; from?: Hex };
        const fn = fns.find((f) => toFunctionSelector(f) === tx.data.slice(0, 10));
        if (!fn) throw new Error(`unexpected call ${tx.data.slice(0, 10)}`);
        const { args } = decodeFunctionData({ abi: [fn], data: tx.data });
        calls.push({ chain, method, fn: fn.name, args: args ?? [], to: tx.to });
        const answer = answers[fn.name];
        if (!answer) throw new Error(`no answer for ${fn.name}`);
        const result = answer(args ?? [], { chain, to: tx.to, from: tx.from });
        return encodeFunctionResult({ abi: [fn], functionName: fn.name, result } as never);
      }
      calls.push({ chain, method });
      const m = methods[method];
      if (m) return m(chain, params);
      if (method === "eth_getBlockByNumber") return fakeHeader(chain, params[0]);
      throw new Error(`unexpected ${method}`);
    },
  };
  const ctx: Ctx = {
    live: true,
    targets: targets({}).live,
    rpc,
    runner: { run: async () => ({ code: 1, stdout: "", stderr: "not in tests" }) },
    paths: paths({}),
    log: () => undefined,
    receiptTimeoutMs: 10,
  };
  return { ctx, calls };
}

const missing = (name: string) => () => {
  throw new Error(`${name} is not stubbed`);
};

/** Keeper dependencies that fail loudly unless a test provides them; the keeper wallet a plain account. */
export function stubDeps(over: Partial<KeeperDeps>): KeeperDeps {
  return {
    readState: missing("readState"),
    signer: WALLET,
    signerCode: async () => "0x",
    sendCall: missing("sendCall"),
    nonce: async () => 4,
    quoteClose: missing("quoteClose"),
    payoutLogs: missing("payoutLogs"),
    batchInfo: missing("batchInfo"),
    rescanPayoutLogs: () => undefined,
    readClaimable: missing("readClaimable"),
    readMinDeposit: missing("readMinDeposit"),
    messageState: missing("messageState"),
    recordMessage: () => undefined,
    refresh: () => undefined,
    readRewards: missing("readRewards"),
    deliveryCandidates: async () => [],
    readDelivery: missing("readDelivery"),
    simulateDeliver: missing("simulateDeliver"),
    log: () => undefined,
    ...over,
  };
}
