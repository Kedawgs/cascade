import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AbiFunction,
  type AbiParameter,
  encodeFunctionResult,
  type Hex,
  hexToBigInt,
  numberToHex,
  toFunctionSelector,
} from "viem";
import { describe, expect, it } from "vitest";
import { type ChainName, paths, targets, WALLET } from "../src/config.ts";
import { KEEPER_READ_ABIS, keeperDeps, scanLogs } from "../src/keeper/state.ts";
import { buildPlan } from "../src/plan.ts";
import type { DeploymentRecord } from "../src/record.ts";
import type { Rpc } from "../src/rpc.ts";
import type { Ctx } from "../src/send.ts";

const ZERO32: Hex = `0x${"00".repeat(32)}`;
const MSG: Hex = `0x${"5a".repeat(32)}`;

function defaultFor(p: AbiParameter): unknown {
  if (p.type.endsWith("]")) return [];
  if (p.type === "tuple") {
    return Object.fromEntries((p as { components: readonly AbiParameter[] }).components.map((c) => [c.name, defaultFor(c)]));
  }
  if (p.type === "bool") return false;
  if (p.type === "address") return "0x0000000000000000000000000000000000000000";
  if (p.type.startsWith("bytes")) return ZERO32;
  if (p.type === "string") return "";
  return 0n;
}

/** Answers every view the keeper reads with zero values; getExecutionState answers SUCCESS. */
function fakeChains(onLogs: (chain: ChainName, from: bigint, to: bigint) => unknown[] = () => []) {
  const fns = (Object.values(KEEPER_READ_ABIS).flat() as unknown as AbiFunction[]).filter((i) => i.type === "function");
  const calls: { chain: ChainName; method: string }[] = [];
  const rpc: Rpc = {
    async request(chain, method, params) {
      calls.push({ chain, method });
      switch (method) {
        case "eth_call": {
          const data = (params[0] as { data: Hex }).data;
          const fn = fns.find((f) => toFunctionSelector(f) === data.slice(0, 10));
          if (!fn) throw new Error(`unexpected call ${data.slice(0, 10)}`);
          const result = fn.name === "getExecutionState" ? 2 : fn.outputs.length === 1 ? defaultFor(fn.outputs[0]) : fn.outputs.map(defaultFor);
          return encodeFunctionResult({ abi: [fn], functionName: fn.name, result } as never);
        }
        case "eth_getBalance":
          return "0x0";
        case "eth_blockNumber":
          return numberToHex(1_000);
        case "eth_getBlockByNumber":
          return { timestamp: "0x1" };
        case "eth_getLogs": {
          const q = params[0] as { fromBlock: Hex; toBlock: Hex };
          return onLogs(chain, hexToBigInt(q.fromBlock), hexToBigInt(q.toBlock));
        }
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const ctx: Ctx = { live: true, targets: targets({}).live, rpc, runner: { run: async () => ({ code: 1, stdout: "", stderr: "" }) }, paths: paths({}), log: () => undefined, receiptTimeoutMs: 10 };
  return { ctx, calls };
}

const plan = buildPlan(0, 0, ZERO32);
const sent = { hash: ZERO32, block: 10, gasUsed: 1n, costWei: 1n };
const rec: DeploymentRecord = {
  target: "live",
  wallet: WALLET,
  createdAt: "",
  plan,
  done: Object.fromEntries(plan.steps.map((s) => [s.id, sent])),
  messages: [{ id: MSG, direction: "Base → Bittensor", hash: ZERO32, at: "" }],
};

describe("keeper reads", () => {
  it("scans Base in windows the public RPC accepts (it refuses more than 200 blocks)", async () => {
    const f = fakeChains((chain, from, to) => {
      if (chain === "base" && to - from + 1n > 200n) throw new Error("eth_getLogs is limited to a 200 range");
      return [];
    });
    const ev = KEEPER_READ_ABIS.FRONT.find((i) => (i as { name?: string }).name === "BatchClosed") as never;
    await expect(scanLogs(f.ctx, "base", plan.addresses.frontDoor, ev, 0n)).resolves.toEqual([]);
  });

  it("reads the state with no Base log scan, taking bridge messages from the record", async () => {
    const f = fakeChains((chain) => {
      if (chain === "base") throw new Error("eth_getLogs is limited to a 200 range");
      return [];
    });
    const recordPath = join(mkdtempSync(join(tmpdir(), "ops-state-")), "rec.json");
    const s = await keeperDeps(f.ctx, rec, recordPath).readState();
    expect(f.calls.some((c) => c.chain === "base" && c.method === "eth_getLogs")).toBe(false);
    expect(s.detail.messages).toEqual([{ id: MSG, direction: "Base → Bittensor", state: "SUCCESS" }]);
  });
});
