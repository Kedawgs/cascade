import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, type Hex, hexToBigInt, hexToNumber, keccak256, numberToHex, pad, toEventSelector } from "viem";
import { ADAPTER, ERC20, FRONT_DOOR, FRONT_DOOR_VIEWS, VAULT } from "../src/abi.ts";
import type { RawLog } from "../src/logs.ts";
import { ownerStorageKey, STORAGE_QUERY } from "../src/subtensor.ts";

// node scripts/record-fixtures.ts ../ops/deployments/v3-test.json   (pnpm fixtures:record …)
//
// Records real bytes from the live v3 test deployment for the tests (plan Task 30), with a handful of
// read-only JSON-RPC requests (at most MAX_REQUESTS; nothing is ever sent):
// - test/fixtures/v3-test-batches.json: the front door's logs of batches 1 and 2 (their requests and closes),
//   the closes' transactions, and their deliveries' transactions on Bittensor;
// - test/fixtures/v3-test-chunk.json: batch 2's chunk 0, its processPayouts transaction on Bittensor and its
//   landing on Base, with the front door's delivered(bridge, hash) answer at the landing block;
// - test/fixtures/v3-test-reads.json: the stake hotkey's Owner (SubtensorModule) read through the storage-query
//   precompile, an absent hotkey's, and FM-TAO's supply on Base against the Bittensor lock pool's FM-TAO.
// Logs are kept exactly as eth_getLogs and receipts answer them (only the RawLog fields).

const BASE = "https://base-rpc.publicnode.com";
const BITTENSOR = "https://archive.chain.opentensor.ai";
const MAX_REQUESTS = 30;
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
/** The public FM-TAO contracts (wrangler.jsonc TOKENS). */
const FM_TAO = { base: "0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67" as Hex, bittensor: "0xC5b6C1632d34901239396F5E1BDe54B342900256" as Hex, lockPool: "0xB66b9c085ab711ECC373aaF6dc959a4A6B42BE2e" as Hex };

const topic0 = (abi: readonly unknown[], name: string): Hex => {
  const e = (abi as { type: string; name: string }[]).find((x) => x.type === "event" && x.name === name);
  if (!e) throw new Error(`no event ${name}`);
  return toEventSelector(e as never);
};

let requests = 0;
/** One JSON-RPC batch, one request. */
async function batch(url: string, calls: { method: string; params: unknown[] }[]): Promise<unknown[]> {
  if (++requests > MAX_REQUESTS) throw new Error(`more than ${MAX_REQUESTS} requests: stopped`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, ...c }))),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  const out = (await res.json()) as { id: number; result?: unknown; error?: { message?: string } }[];
  return calls.map((c, i) => {
    const a = out.find((x) => x.id === i + 1);
    if (!a || a.error) throw new Error(`${new URL(url).host} ${c.method}: ${a?.error?.message ?? "no answer"}`);
    return a.result;
  });
}
const one = async (url: string, method: string, params: unknown[]) => (await batch(url, [{ method, params }]))[0];

/** CascadeMessages.encodePayouts, as src/crosscheck/payouts.ts encodes it (that module isn't Node-typed). */
const ENTRIES = { type: "tuple[]", components: [{ name: "user", type: "address" }, { name: "amount", type: "uint256" }] } as const;
const encodePayoutsMessage = (key: Hex, chunk: number, entries: readonly { user: Hex; amount: bigint }[]): Hex =>
  encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "uint32" }, ENTRIES], [2, key, chunk, entries]);

const raw = (l: Record<string, unknown>): RawLog => ({
  address: (l.address as string).toLowerCase() as Hex,
  topics: (l.topics as string[]).map((t) => t.toLowerCase() as Hex),
  data: (l.data as string).toLowerCase() as Hex,
  blockNumber: l.blockNumber as Hex,
  logIndex: l.logIndex as Hex,
  transactionHash: (l.transactionHash as string).toLowerCase() as Hex,
});

/** eth_getLogs over [from, to]: in one request if the node takes the range, else in windows of `step`. */
async function logs(url: string, filter: { address: Hex; topics: (Hex | Hex[] | null)[] }, from: bigint, to: bigint, step = 1000n): Promise<RawLog[]> {
  const get = async (a: bigint, b: bigint) =>
    ((await one(url, "eth_getLogs", [{ ...filter, fromBlock: numberToHex(a), toBlock: numberToHex(b) }])) as Record<string, unknown>[]).map(raw);
  try {
    return await get(from, to);
  } catch (e) {
    if (to - from < step) throw e;
    console.log(`${new URL(url).host} refused ${to - from + 1n} blocks at once (${e instanceof Error ? e.message : String(e)}): asking ${step} at a time`);
    const out: RawLog[] = [];
    for (let a = from; a <= to; a += step) out.push(...(await get(a, a + step - 1n < to ? a + step - 1n : to)));
    return out;
  }
}

const receiptLogs = (r: unknown): RawLog[] => ((r as { logs: Record<string, unknown>[] }).logs ?? []).map(raw);

export async function record(recordPath: string): Promise<void> {
  const rec = JSON.parse(readFileSync(recordPath, "utf8")) as {
    plan: { addresses: Record<string, string>; steps: { id: string; args?: unknown[] }[] };
    done: Record<string, { block?: number }>;
    messages?: { id: Hex; direction: string; hash: Hex }[];
  };
  const a = Object.fromEntries(Object.entries(rec.plan.addresses).map(([k, v]) => [k, v.toLowerCase() as Hex])) as Record<string, Hex>;
  const [, stakeHotkey] = rec.plan.steps.find((s) => s.id === "vault")?.args as [Hex, Hex];
  const messages = rec.messages ?? [];
  const toBit = messages.filter((m) => m.direction.startsWith("Base"));
  const toBase = messages.filter((m) => !m.direction.startsWith("Base"));
  if (toBit.length < 2 || toBase.length < 1) throw new Error("the record lists fewer than two batch closes and one payout");
  const baseStart = BigInt(rec.done.baseAdapter.block as number);
  const bitStart = BigInt(rec.done.bitAdapter.block as number);

  // 1. the two closes on Base (their transactions are in the record)
  const closes = await batch(BASE, toBit.slice(0, 2).map((m) => ({ method: "eth_getTransactionReceipt", params: [m.hash] })));
  const closeLogs = closes.flatMap(receiptLogs);
  const closed = topic0(FRONT_DOOR, "BatchClosed");
  const batchClose = closeLogs.filter((l) => l.address === a.frontDoor && l.topics[0] === closed);
  const ids = batchClose.map((l) => hexToBigInt(l.topics[1]));
  if (ids.join(",") !== "1,2") throw new Error(`the record's first two closes are batches ${ids.join(", ")}, not 1 and 2`);
  const close2Block = hexToBigInt(batchClose[1].blockNumber);

  // 2. every front door log of batches 1 and 2 (topic 1 is the batch id of each request, cancel and close)
  const frontDoorLogs = await logs(BASE, { address: a.frontDoor, topics: [null, [pad(numberToHex(1n)), pad(numberToHex(2n))]] }, baseStart, close2Block);

  // 3. their deliveries on Bittensor, and each delivery's whole transaction
  const delivered = await logs(BITTENSOR, { address: a.vault, topics: [topic0(VAULT, "BatchDelivered"), null, pad(numberToHex(8453n)), pad(a.frontDoor)] }, bitStart, bitStart + 999n);
  const deliveryOf = (id: bigint) => delivered.find((l) => hexToBigInt(`0x${l.data.slice(2, 66)}`) === id);
  const d1 = deliveryOf(1n);
  const d2 = deliveryOf(2n);
  if (!d1 || !d2) throw new Error("the deliveries of batches 1 and 2 aren't in the first 1,000 Bittensor blocks");
  const chunkMessage = toBase[0];
  const bitReceipts = await batch(BITTENSOR, [d1.transactionHash, d2.transactionHash, chunkMessage.hash].map((h) => ({ method: "eth_getTransactionReceipt", params: [h] })));
  const [deliveryLogs1, deliveryLogs2, chunkLogs] = bitReceipts.map(receiptLogs);
  const chunkBlock = hexToBigInt((bitReceipts[2] as { blockNumber: Hex }).blockNumber);

  // 4. the chunk's landing on Base: the Base adapter's Delivered of its message, found by time
  const [chunkHeader, close2Header] = await Promise.all([
    one(BITTENSOR, "eth_getBlockByNumber", [numberToHex(chunkBlock), false]) as Promise<{ timestamp: Hex }>,
    one(BASE, "eth_getBlockByNumber", [numberToHex(close2Block), false]) as Promise<{ timestamp: Hex }>,
  ]);
  const estimate = close2Block + BigInt(Math.floor((hexToNumber(chunkHeader.timestamp) - hexToNumber(close2Header.timestamp)) / 2));
  const landed = await logs(BASE, { address: a.baseAdapter, topics: [topic0(ADAPTER, "Delivered"), chunkMessage.id.toLowerCase() as Hex] }, estimate - 300n, estimate + 2700n);
  if (landed.length !== 1) throw new Error(`found ${landed.length} landings of the chunk's message`);
  const landingTx = landed[0].transactionHash;
  const landingBlock = hexToBigInt(landed[0].blockNumber);
  const landingLogs = receiptLogs((await batch(BASE, [{ method: "eth_getTransactionReceipt", params: [landingTx] }]))[0]);
  const payoutsDelivered = landingLogs.find((l) => l.address === a.frontDoor && l.topics[0] === topic0(FRONT_DOOR, "PayoutsDelivered"));
  if (!payoutsDelivered) throw new Error("the landing has no PayoutsDelivered");

  // 5. the reads: delivered(bridge, hash) for the message of the entries the landing paid (the tests rebuild the
  // entries from the vault's logs instead and must reach this hash), at the landing block and the one before
  const received = landingLogs.filter((l) => l.address === a.frontDoor && l.topics[0] === topic0(FRONT_DOOR, "PayoutReceived"));
  const key = payoutsDelivered.topics[1];
  const chunk = Number(hexToBigInt(`0x${payoutsDelivered.data.slice(2, 66)}`));
  const paid = received.map((l) => ({ user: getAddress(`0x${l.topics[2].slice(26)}`), amount: hexToBigInt(`0x${l.data.slice(66, 130)}`) }));
  const paidHash = keccak256(encodePayoutsMessage(key, chunk, paid));
  const deliveredCall = (hash: Hex) => ({ to: a.frontDoor, data: encodeFunctionData({ abi: FRONT_DOOR_VIEWS, functionName: "delivered", args: [a.baseAdapter, hash] }) });
  const [atLanding, beforeLanding, supply, baseHead] = await batch(BASE, [
    { method: "eth_call", params: [deliveredCall(paidHash), numberToHex(landingBlock)] },
    { method: "eth_call", params: [deliveredCall(paidHash), numberToHex(landingBlock - 1n)] },
    { method: "eth_call", params: [{ to: FM_TAO.base, data: encodeFunctionData({ abi: ERC20, functionName: "totalSupply" }) }, "latest"] },
    { method: "eth_blockNumber", params: [] },
  ]);
  const absent = `0x${"5a".repeat(32)}` as Hex;
  const [owner, nobody, lock, bitHead] = await batch(BITTENSOR, [
    { method: "eth_call", params: [{ to: STORAGE_QUERY, data: ownerStorageKey(stakeHotkey) }, "latest"] },
    { method: "eth_call", params: [{ to: STORAGE_QUERY, data: ownerStorageKey(absent) }, "latest"] },
    { method: "eth_call", params: [{ to: FM_TAO.bittensor, data: encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [FM_TAO.lockPool] }) }, "latest"] },
    { method: "eth_blockNumber", params: [] },
  ]);
  const bool = (x: unknown) => decodeFunctionResult({ abi: FRONT_DOOR_VIEWS, functionName: "delivered", data: x as Hex });
  const uint = (x: unknown) => decodeFunctionResult({ abi: ERC20, functionName: "totalSupply", data: x as Hex }).toString();

  const deployment = { frontDoor: a.frontDoor, baseAdapter: a.baseAdapter, staker: a.staker, vault: a.vault, bitAdapter: a.bitAdapter };
  const write = (name: string, value: unknown) => writeFileSync(join(FIXTURES, name), `${JSON.stringify(value, null, 2)}\n`);
  write("v3-test-batches.json", {
    note: "Recorded from the live v3 test deployment by scripts/record-fixtures.ts (read-only). Logs as eth_getLogs answers them.",
    deployment,
    batches: [
      { id: "1", closeTx: toBit[0].hash.toLowerCase(), deliveryTx: d1.transactionHash, deliveredKey: d1.topics[1], messageId: toBit[0].id.toLowerCase() },
      { id: "2", closeTx: toBit[1].hash.toLowerCase(), deliveryTx: d2.transactionHash, deliveredKey: d2.topics[1], messageId: toBit[1].id.toLowerCase() },
    ],
    base: dedupe([...frontDoorLogs, ...closeLogs]),
    bittensor: dedupe([...deliveryLogs1, ...deliveryLogs2]),
  });
  write("v3-test-chunk.json", {
    note: "Recorded from the live v3 test deployment by scripts/record-fixtures.ts (read-only): batch 2's chunk 0, its processPayouts transaction and its landing.",
    deployment,
    key,
    chunk,
    messageId: chunkMessage.id.toLowerCase(),
    chunkTx: chunkMessage.hash.toLowerCase(),
    landingTx,
    landingBlock: landingBlock.toString(),
    /** delivered(baseAdapter, keccak256(encodePayouts(key, chunk, the entries the landing paid))) */
    delivered: { hash: paidHash, atLanding: bool(atLanding), beforeLanding: bool(beforeLanding) },
    bittensor: chunkLogs,
    base: landingLogs,
  });
  write("v3-test-reads.json", {
    note: "Recorded from the live chains by scripts/record-fixtures.ts (read-only).",
    stakeHotkey: stakeHotkey.toLowerCase(),
    ownerOfStakeHotkey: owner,
    absentHotkey: absent,
    ownerOfAbsentHotkey: nobody,
    fmTao: { baseSupply: uint(supply), baseBlock: hexToBigInt(baseHead as Hex).toString(), lockPool: uint(lock), bittensorBlock: hexToBigInt(bitHead as Hex).toString() },
  });
  console.log(`recorded with ${requests} read-only requests`);
}

/** Each log once (a close's logs come both from the receipt and the front door's log query). */
function dedupe(xs: RawLog[]): RawLog[] {
  const seen = new Set<string>();
  return xs
    .filter((l) => {
      const k = `${l.transactionHash}:${l.logIndex}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((x, y) => (hexToBigInt(x.blockNumber) === hexToBigInt(y.blockNumber) ? hexToNumber(x.logIndex) - hexToNumber(y.logIndex) : hexToBigInt(x.blockNumber) < hexToBigInt(y.blockNumber) ? -1 : 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv.slice(2).filter((x) => x !== "--")[0];
  if (!path) {
    console.error("usage: pnpm fixtures:record <ops record, e.g. ../ops/deployments/v3-test.json>");
    process.exit(2);
  }
  record(path).then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(`nothing written: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
