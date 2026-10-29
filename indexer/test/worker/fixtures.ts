import { env } from "cloudflare:workers";
import { type Abi, encodeAbiParameters, encodeEventTopics, type Hex, numberToHex } from "viem";
import { type Config, parseConfig, VAR_NAMES } from "../../src/config.ts";
import type { RawLog } from "../../src/logs.ts";

/** The test environment's vars (wrangler.jsonc's env.test with the fixture deployment), as a plain
 * object a test can change. */
export const testVars = (): Record<string, unknown> =>
  Object.fromEntries(VAR_NAMES.map((n) => [n, (env as unknown as Record<string, unknown>)[n]]));

/** The parsed test configuration (fake deployment, real public token addresses). */
export const testConfig = (over: Record<string, unknown> = {}): Config => parseConfig({ ...testVars(), ...over });

/** A raw log as eth_getLogs returns it, built with viem's encoders. */
export function rawLog(o: {
  address: Hex;
  abi: Abi;
  eventName: string;
  args: Record<string, unknown>;
  block: bigint;
  logIndex: number;
  txHash: Hex;
}): RawLog {
  const item = o.abi.find((x) => x.type === "event" && x.name === o.eventName);
  if (!item || item.type !== "event") throw new Error(`no event ${o.eventName}`);
  const topics = encodeEventTopics({ abi: [item], eventName: o.eventName, args: o.args } as never) as Hex[];
  const plain = item.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain, plain.map((i) => o.args[i.name!]));
  return {
    address: o.address.toLowerCase() as Hex,
    topics,
    data,
    blockNumber: numberToHex(o.block),
    logIndex: numberToHex(o.logIndex),
    transactionHash: o.txHash,
  };
}

/** A transaction hash made from a number, for readable tests. */
export const tx = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
