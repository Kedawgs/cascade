import {
  type AbiFunction,
  type Address,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  type Hex,
  keccak256,
  numberToHex,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  toFunctionSelector,
} from "viem";
import { DOOR, KEEPER_CALLS_V32, OFFRAMP_EXECUTE, PARK_CALLS, PARK_JOBS } from "../../ops/src/keeper/core/abi.ts";
import { RpcError } from "../../ops/src/keeper/core/rpc.ts";
import type { ChainName } from "../../ops/src/keeper/core/types.ts";
import { ADDR, bridgeCallMined, claimMined, doorDeliver, rpcOf, type SentCall, world, type World } from "../../ops/test/keeper-v32-world.ts";
import { MULTICALL3 } from "../src/config.ts";

// The keeper's fake chains, for the worker tests (behind a spied fetch) and the node tests (as Miniflare's outbound
// service): ops' fake v3.2 world (test/keeper-v32-world.ts) answering the Worker's real JSON-RPC requests (Multicall3's
// aggregate3 too), with raw transactions signed by `me` (the tests' throwaway key) recovered, recorded and settled as
// the world says. A test can hold any request forever, to cut a run off at that point.

export const HOSTS: Record<string, ChainName> = { "base.rpc.test": "base", "base-logs.rpc.test": "base", "bittensor.rpc.test": "bittensor" };

const KEEPER_FNS = ([...KEEPER_CALLS_V32, ...PARK_CALLS, ...PARK_JOBS, ...OFFRAMP_EXECUTE] as readonly AbiFunction[]).filter((i) => i.type === "function" && i.stateMutability !== "view");
const DELIVERED = DOOR.filter((x) => x.type === "event" && x.name === "Delivered");

const MULTICALL = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  "function getEthBalance(address addr) view returns (uint256 balance)",
]);

export interface Fetched {
  chain: ChainName;
  host: string;
  method: string;
  params: unknown[];
}

/** A fake world whose keeper is `me`, and the fetch that answers every RPC request the Worker makes from it. */
export function fakeChains(me: Address, over: (w: World) => void = () => undefined) {
  const w = world();
  w.door.keeper = me;
  w.vault.keeper = me;
  over(w);
  const inner = rpcOf(w);
  const fetched: Fetched[] = [];
  /** Pending (held) transactions by hash: the nonce they took, their call and their fees */
  const pool = new Map<string, { chain: ChainName; nonce: number; to: Address | null; input: Hex; value: bigint; fees: Record<string, Hex>; call: SentCall }>();
  /** Each mined transaction's recipient, as its receipt names it (a cancel's is the keeper itself) */
  const minedTo = new Map<string, Address | null>();
  /** A claim, an adoption or a hotkey's listing or removal mined, as the vault does it (as the world's own rpcOf):
   * claimRewards pays the hotkey's credits and stamps its claim; adoptStake books the surplus and stamps the adoption */
  function rewardsMined(c: SentCall) {
    // the world's own claim (R6b: it restarts the claim schedule when it pays)
    if (c.fn === "claimRewards") claimMined(w, c.args[0] as Hex);
    // a hotkey listed or removed, as the vault's L4 does it (as the world's own rpcOf; Task 53)
    if (c.fn === "addHotkey") {
      const h = c.args[0] as Hex;
      w.vault.hotkeys.splice(w.vault.hotkeyCount, 0, { hotkey: h, stakeRao: w.vault.offList[h.toLowerCase()] ?? 0n, credits: 0n, lastClaimAt: BigInt(w.time.bittensor) });
      w.vault.hotkeyCount++;
    }
    if (c.fn === "removeHotkey") {
      const i = w.vault.hotkeys.slice(0, w.vault.hotkeyCount).findIndex((x) => x.hotkey.toLowerCase() === String(c.args[0]).toLowerCase());
      if (i >= 0) {
        w.vault.hotkeys[i] = w.vault.hotkeys[w.vault.hotkeyCount - 1];
        w.vault.hotkeys.splice(w.vault.hotkeyCount - 1, 1);
        w.vault.hotkeyCount--;
      }
    }
    if (c.fn === "adoptStake") {
      w.vault.bookedStake += w.vault.surplusStakeRao;
      w.vault.surplusStakeRao = 0n;
      w.vault.lastAdoptAt = BigInt(w.time.bittensor);
    }
  }
  /** A request held forever when this says so: the run that made it is cut off there */
  const hold = { when: (_f: Fetched): boolean => false, wait: async (_f: Fetched): Promise<void> => undefined };

  async function send(chain: ChainName, raw: Hex): Promise<Hex> {
    const tx = parseTransaction(raw);
    const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
    if (from.toLowerCase() !== me.toLowerCase()) throw new RpcError("not the keeper's");
    const fn = KEEPER_FNS.find((x) => toFunctionSelector(x) === (tx.data ?? "0x").slice(0, 10));
    const { args } = fn ? decodeFunctionData({ abi: [fn], data: tx.data as Hex }) : { args: [] };
    const hash = keccak256(raw);
    const c: SentCall = { chain, to: tx.to as Address, fn: fn?.name ?? "transfer", args: args ?? [], value: tx.value ?? 0n, gas: tx.gas ?? 0n, hash };
    w.sends.push(c);
    let fate = w.fate(c);
    // a transaction at a nonce one in the pool holds takes its place there (a replacement): the pending nonce stays
    const replacing = [...pool].find(([, p]) => p.chain === chain && p.nonce === (tx.nonce ?? 0));
    if (replacing) pool.delete(replacing[0]);
    else w.nonce[chain].pending++;
    let logs = fate === "hold" ? [] : w.receiptLogs(c);
    if (fate === "mine") rewardsMined(c);
    // a park call or a manual execution mined, as the world's adapter and OffRamp take it (Task 52)
    if (fate === "mine") ({ fate, logs } = bridgeCallMined(w, c, hash, logs));
    // a delivery mined: the door's checks on the world as it is then, and its effects (as the world's own rpcOf)
    if (c.fn === "deliver" && fate === "mine") {
      const [user, keeperMinOut] = c.args as [Address, bigint];
      try {
        const amount = w.door.claimable[user.toLowerCase()] ?? 0n;
        const received = doorDeliver(w, user, keeperMinOut);
        w.door.claimable[user.toLowerCase()] = 0n;
        w.logs.push({ chain: "base", address: ADDR.frontDoor, event: "Delivered", args: { user, taoIn: amount, usdcOut: received }, block: w.head.base, tx: hash });
        const topics = encodeEventTopics({ abi: DELIVERED, eventName: "Delivered", args: { user } } as never) as Hex[];
        logs = [...logs, { address: ADDR.frontDoor, topics, data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [amount, received]) }];
      } catch {
        fate = "revert";
      }
    }
    const fees: Record<string, Hex> =
      tx.gasPrice !== undefined ? { gasPrice: numberToHex(tx.gasPrice) } : { maxFeePerGas: numberToHex(tx.maxFeePerGas ?? 0n), maxPriorityFeePerGas: numberToHex(tx.maxPriorityFeePerGas ?? 0n) };
    if (fate === "hold") pool.set(hash, { chain, nonce: tx.nonce ?? 0, to: (tx.to ?? null) as Address | null, input: (tx.data ?? "0x") as Hex, value: tx.value ?? 0n, fees, call: c });
    else {
      w.nonce[chain].latest++;
      w.receipts[hash] = { status: fate === "mine" ? "0x1" : "0x0", logs };
      minedTo.set(hash, (tx.to ?? null) as Address | null);
    }
    return hash;
  }

  async function aggregate(chain: ChainName, data: Hex): Promise<Hex> {
    const { args } = decodeFunctionData({ abi: MULTICALL, data });
    const calls = args[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[];
    const out: { success: boolean; returnData: Hex }[] = [];
    for (const c of calls) {
      try {
        if (c.target.toLowerCase() === MULTICALL3.toLowerCase()) {
          const { args: a } = decodeFunctionData({ abi: MULTICALL, data: c.callData });
          const bal = BigInt((await inner.request(chain, "eth_getBalance", [a[0], "latest"])) as Hex);
          out.push({ success: true, returnData: encodeFunctionResult({ abi: MULTICALL, functionName: "getEthBalance", result: bal }) });
        } else out.push({ success: true, returnData: (await inner.request(chain, "eth_call", [{ to: c.target, data: c.callData }, "latest"])) as Hex });
      } catch {
        out.push({ success: false, returnData: "0x" });
      }
    }
    return encodeFunctionResult({ abi: MULTICALL, functionName: "aggregate3", result: out });
  }

  async function answer(chain: ChainName, method: string, params: unknown[]): Promise<unknown> {
    if (method === "eth_sendRawTransaction") return send(chain, params[0] as Hex);
    if (method === "eth_getTransactionByHash") {
      const h = params[0] as string;
      if (w.receipts[h]) return { from: me, nonce: "0x0", blockNumber: numberToHex(w.head[chain]) };
      const p = pool.get(h);
      // anyone else's the world knows (an execution attempt of a bridge message), as the world answers it
      return p ? { from: me, nonce: numberToHex(p.nonce), blockNumber: null, to: p.to, input: p.input, value: numberToHex(p.value), ...p.fees } : inner.request(chain, method, params);
    }
    if (method === "eth_call" && (params[0] as { to: string }).to.toLowerCase() === MULTICALL3.toLowerCase()) return aggregate(chain, (params[0] as { data: Hex }).data);
    if (method === "eth_getTransactionReceipt") {
      const r = w.receipts[params[0] as string];
      return r ? { status: r.status, blockNumber: numberToHex(w.head[chain]), gasUsed: "0x30d40", effectiveGasPrice: numberToHex(10n ** 9n), to: minedTo.get(params[0] as string) ?? null, logs: r.logs } : null;
    }
    return inner.request(chain, method, params);
  }

  const fetchFake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const chain = HOSTS[url.hostname];
    if (!chain) throw new TypeError(`no network in tests (${url.hostname})`);
    const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string; params: unknown[] };
    const f: Fetched = { chain, host: url.hostname, method: body.method, params: body.params };
    fetched.push(f);
    if (hold.when(f)) return new Promise<Response>(() => undefined);
    await hold.wait(f);
    try {
      const result = await answer(chain, body.method, body.params);
      return Response.json({ jsonrpc: "2.0", id: body.id, result: result ?? null });
    } catch (e) {
      const err = e instanceof RpcError ? { code: e.code ?? -32000, message: e.message, data: e.data } : { code: -32000, message: (e as Error).message };
      return Response.json({ jsonrpc: "2.0", id: body.id, error: err });
    }
  };

  /** Mines a held transaction: its receipt (status 1 unless `reverted`), the nonce, and a claim's, an adoption's, a park
   * call's or a manual execution's effects */
  const mine = (hash: Hex, o: { reverted?: boolean } = {}) => {
    const p = pool.get(hash);
    if (!p) throw new Error(`no held transaction ${hash}`);
    pool.delete(hash);
    w.nonce[p.chain].latest++;
    let reverted = o.reverted === true;
    let logs: { address: Address; topics: Hex[]; data: Hex }[] = [];
    if (!reverted) {
      rewardsMined(p.call);
      const b = bridgeCallMined(w, p.call, hash, []);
      reverted = b.fate === "revert";
      logs = b.logs;
    }
    w.receipts[hash] = { status: reverted ? "0x0" : "0x1", logs };
    minedTo.set(hash, p.to);
  };
  /** Drops a held transaction from the pool: no node knows it, its nonce free again */
  const drop = (hash: Hex) => {
    const p = pool.get(hash);
    if (!p) throw new Error(`no held transaction ${hash}`);
    pool.delete(hash);
    w.nonce[p.chain].pending--;
  };
  return { w, fetched, hold, mine, drop, pool, fetch: fetchFake as typeof fetch };
}
