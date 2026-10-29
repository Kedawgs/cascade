import { type Abi, decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import { MULTICALL3 } from "./abi.ts";
import type { ChainName } from "./config.ts";
import type { Rpc } from "./rpc.ts";

/** Multicall3, at one address on both chains. */
export const MULTICALL3_ADDRESS = "0xca11bde05977b3631167028862be2a173976ca11" as Hex;

/** One view to read: a contract call, or an address's native balance. */
export type Read = { address: Hex; abi: Abi; functionName: string; args?: readonly unknown[] } | { ethBalance: Hex };
export type ReadResult = { ok: true; value: unknown } | { ok: false };

/** Every read in one eth_call to Multicall3's aggregate3 at the latest block, each allowed to fail on
 * its own (a reverted call, or an answer that doesn't decode, is `{ ok: false }`). The block number and
 * time are read in the same call, so the answer names the block it was computed at: a load-balanced
 * node that answers from an older block says so, and the caller drops the reading (`newerThan`). */
export async function multicall(
  rpc: Rpc,
  chain: ChainName,
  reads: readonly Read[],
  multicall3: Hex = MULTICALL3_ADDRESS,
): Promise<{ block: bigint; time: number; results: ReadResult[] }> {
  const own = (functionName: "getBlockNumber" | "getCurrentBlockTimestamp") => ({
    target: multicall3,
    allowFailure: false,
    callData: encodeFunctionData({ abi: MULTICALL3, functionName }),
  });
  const calls = [
    own("getBlockNumber"),
    own("getCurrentBlockTimestamp"),
    ...reads.map((r) =>
      "ethBalance" in r
        ? { target: multicall3, allowFailure: true, callData: encodeFunctionData({ abi: MULTICALL3, functionName: "getEthBalance", args: [r.ethBalance] }) }
        : { target: r.address, allowFailure: true, callData: encodeFunctionData({ abi: r.abi, functionName: r.functionName, args: r.args } as never) },
    ),
  ];
  const data = encodeFunctionData({ abi: MULTICALL3, functionName: "aggregate3", args: [calls] });
  const out = (await rpc.call(chain, "eth_call", [{ to: multicall3, data }, "latest"])) as Hex;
  const answers = decodeFunctionResult({ abi: MULTICALL3, functionName: "aggregate3", data: out });
  if (answers.length !== calls.length) throw new Error(`${chain} multicall: ${answers.length} answers to ${calls.length} calls`);
  const block = decodeFunctionResult({ abi: MULTICALL3, functionName: "getBlockNumber", data: answers[0].returnData });
  const time = decodeFunctionResult({ abi: MULTICALL3, functionName: "getCurrentBlockTimestamp", data: answers[1].returnData });
  const results = reads.map((r, i): ReadResult => {
    const a = answers[i + 2];
    if (!a.success) return { ok: false };
    try {
      const value =
        "ethBalance" in r
          ? decodeFunctionResult({ abi: MULTICALL3, functionName: "getEthBalance", data: a.returnData })
          : decodeFunctionResult({ abi: r.abi, functionName: r.functionName, data: a.returnData } as never);
      return { ok: true, value };
    } catch {
      return { ok: false };
    }
  });
  return { block, time: Number(time), results };
}

/** Readings only move forward: a reading counts only when its block is after the last one kept. */
export const newerThan = (last: bigint | undefined, read: { block: bigint }): boolean => last === undefined || read.block > last;
