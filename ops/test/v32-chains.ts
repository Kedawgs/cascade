import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Address,
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  type Hex,
  keccak256,
  numberToHex,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_V3, type ChainName, PRECOMPILE, paths, targets } from "../src/config.ts";
import { type Rpc, RpcError } from "../src/rpc.ts";
import type { Ctx, Runner, Signer } from "../src/send.ts";
import { addressMapping, buildPlanV32, type PlanV32 } from "../src/v32/plan.ts";
import { ROLES_V32, TAO_BOT, YUMA } from "./v32-fixtures.ts";

// Two fake chains for deployV32 and sendCreate's v3.2 path: they take signed raw transactions (eth_sendRawTransaction),
// recover their sender, keep each account's mined and pending nonces, mine a create at its CREATE address with the
// runtime code the test names, and answer receipts, code, balances, ADDRESS_MAPPING and a simulated create on Base.
// Each test decides what becomes of each transaction (mined, reverted, held in the pool, refused, at another address).
// The deployers' keys are throwaway test keys made here (keccak256 of a label): no keystore, password file or .env is
// read, and nothing leaves the process.

const key = (label: string): Hex => keccak256(toHex(`cascade v3.2 ops test deployer, ${label}`));
export const TEST_DEPLOYERS = { bittensor: privateKeyToAccount(key("bittensor")), base: privateKeyToAccount(key("base")) } as const;

/** The deployers' signers: the keystore and password file are names only (the fake runner signs with the test keys). */
export const SIGNERS: Record<ChainName, Signer> = {
  bittensor: { address: TEST_DEPLOYERS.bittensor.address, keystore: "Z:/test/bittensor.keystore", passwordFile: "Z:/test/bittensor.pw", name: "the Bittensor deployer" },
  base: { address: TEST_DEPLOYERS.base.address, keystore: "Z:/test/base.keystore", passwordFile: "Z:/test/base.pw", name: "the Base deployer" },
};

export const FLOORS: [bigint, bigint] = [10n ** 20n, 10n ** 17n];

/** The v3.2 plan from the test deployers. */
export const testPlan = (): PlanV32 =>
  buildPlanV32({
    deployers: { bittensor: TEST_DEPLOYERS.bittensor.address, base: TEST_DEPLOYERS.base.address },
    roles: ROLES_V32,
    validators: { primary: TAO_BOT, standby: YUMA },
    vaultColdkey: addressMapping(getContractAddress({ from: TEST_DEPLOYERS.bittensor.address, nonce: 6n })),
    poolFloors: FLOORS,
    claimGasRequired: 55_000_000n,
  });

export interface SentTx {
  chain: ChainName;
  hash: Hex;
  raw: Hex;
  from: Address;
  nonce: number;
  to: Address | null;
  data: Hex;
  type: string;
  chainId: number;
  value: bigint;
}

/** What becomes of a transaction: mined; mined and reverted; left in the pool; refused by the node (never taken); mined
 * with a receipt naming another address, or none; mined with no code left (or none seen yet); taken and mined while the
 * node's answer is lost and, once, its pool and pending nonce lag ("lost"). */
export type Fate = "mine" | "revert" | "hold" | "refuse" | "wrongAddress" | "noContractAddress" | "noCode" | "lost";

export interface FakeOpts {
  nonces?: Partial<Record<ChainName, { latest: number; pending: number }>>;
  balances?: Partial<Record<ChainName, bigint>>;
  fate?: (tx: SentTx, index: number) => Fate;
  /** The runtime code a create of `data` leaves. */
  codeFor?: (chain: ChainName, data: Hex) => Hex;
  /** What ADDRESS_MAPPING answers for an address (the real mapping by default). */
  coldkey?: (address: Address) => Hex;
  /** A simulated create on Base (eth_call without `to`): its runtime code; throw to revert. */
  simulate?: (data: Hex) => Hex;
  /** Code already on a chain. */
  code?: Partial<Record<ChainName, Record<string, Hex>>>;
  gasPrice?: bigint;
  estimate?: bigint;
  /** The fee tier each Base pool answers (Uniswap's fee()): TAO/WETH 3,000 and WETH/USDC 500 by default. */
  poolFees?: Record<string, number>;
  /** The chain ids the RPCs report (the forks' by default; the live ones for a --live test). */
  chainIds?: Record<ChainName, number>;
  /** eth_maxPriorityFeePerGas (1 mwei by default). */
  priorityFee?: bigint;
}

interface Pooled {
  tx: SentTx;
  fate: Fate;
  receipt?: Record<string, unknown>;
}

export function fakeChains(o: FakeOpts = {}) {
  const calls: { chain: ChainName; method: string; params: unknown[] }[] = [];
  const runs: { file: string; args: string[] }[] = [];
  const sent: SentTx[] = [];
  const minedTxs: SentTx[] = [];
  const logs: string[] = [];
  const nonce: Record<ChainName, Map<string, { latest: number; pending: number }>> = { bittensor: new Map(), base: new Map() };
  const code: Record<ChainName, Map<string, Hex>> = { bittensor: new Map(), base: new Map() };
  const txs: Record<ChainName, Map<string, Pooled>> = { bittensor: new Map(), base: new Map() };
  /** A "lost" transaction's lag: its hash unknown to the pool, and its sender's pending nonce as before it, for one read each. */
  const lagHash = new Set<string>();
  const lagNonce = new Map<string, number>();
  let block = 100;
  for (const chain of ["bittensor", "base"] as const) {
    const n = o.nonces?.[chain];
    if (n) nonce[chain].set(TEST_DEPLOYERS[chain].address.toLowerCase(), { ...n });
    for (const [a, c] of Object.entries(o.code?.[chain] ?? {})) code[chain].set(a.toLowerCase(), c);
  }
  const nonceOf = (chain: ChainName, a: string) => {
    const k = a.toLowerCase();
    if (!nonce[chain].has(k)) nonce[chain].set(k, { latest: 0, pending: 0 });
    return nonce[chain].get(k)!;
  };

  /** Mines a pooled transaction now (a held one, later). */
  function mine(chain: ChainName, p: Pooled) {
    const created = getContractAddress({ from: p.tx.from, nonce: BigInt(p.tx.nonce) });
    const n = nonceOf(chain, p.tx.from);
    n.latest = Math.max(n.latest, p.tx.nonce + 1);
    block++;
    minedTxs.push(p.tx);
    const left = p.fate !== "revert" && p.fate !== "noCode";
    if (left) code[chain].set(created.toLowerCase(), o.codeFor?.(chain, p.tx.data) ?? "0x6080");
    p.receipt = {
      status: p.fate === "revert" ? "0x0" : "0x1",
      blockNumber: numberToHex(block),
      gasUsed: numberToHex(250_000n),
      effectiveGasPrice: numberToHex(o.gasPrice ?? 10n ** 9n),
      contractAddress: p.fate === "noContractAddress" ? null : p.fate === "wrongAddress" ? getAddress(`0x${"ee".repeat(20)}`) : created,
      logs: [],
    };
  }

  const rpc: Rpc = {
    async request(chain, method, params) {
      calls.push({ chain, method, params });
      switch (method) {
        case "eth_chainId":
          return numberToHex(o.chainIds?.[chain] ?? targets({}).rehearsal[chain].chainId);
        case "eth_getTransactionCount": {
          const n = nonceOf(chain, params[0] as string);
          const lagKey = `${chain}:${(params[0] as string).toLowerCase()}`;
          if (params[1] !== "latest" && lagNonce.has(lagKey)) {
            const was = lagNonce.get(lagKey)!;
            lagNonce.delete(lagKey);
            return numberToHex(was);
          }
          return numberToHex(params[1] === "latest" ? n.latest : n.pending);
        }
        case "eth_getBalance": {
          const a = (params[0] as string).toLowerCase();
          const mine = TEST_DEPLOYERS[chain].address.toLowerCase() === a;
          return numberToHex(mine ? (o.balances?.[chain] ?? 10n ** 21n) : 0n);
        }
        case "eth_getCode":
          return code[chain].get((params[0] as string).toLowerCase()) ?? "0x";
        case "eth_gasPrice":
          return numberToHex(o.gasPrice ?? 10n ** 9n);
        case "eth_maxPriorityFeePerGas":
          return numberToHex(o.priorityFee ?? 10n ** 6n);
        case "eth_estimateGas":
          return numberToHex(o.estimate ?? 300_000n);
        case "eth_blockNumber":
          return numberToHex(block);
        case "eth_call": {
          const tx = params[0] as { to?: string; data: Hex };
          if (chain === "bittensor" && tx.to?.toLowerCase() === PRECOMPILE.addressMapping.toLowerCase()) {
            const [a] = decodeAbiParameters([{ type: "address" }], `0x${tx.data.slice(10)}`);
            return encodeAbiParameters([{ type: "bytes32" }], [(o.coldkey ?? addressMapping)(a)]);
          }
          if (!tx.to && chain === "base") return o.simulate ? o.simulate(tx.data) : "0x6080";
          const fees: Record<string, number> = { [BASE_V3.TAO_WETH_POOL.toLowerCase()]: 3_000, [BASE_V3.WETH_USDC_POOL.toLowerCase()]: 500, ...o.poolFees };
          // fee()
          if (chain === "base" && tx.to && tx.data === "0xddca3f43" && fees[tx.to.toLowerCase()] !== undefined) {
            return encodeAbiParameters([{ type: "uint24" }], [fees[tx.to.toLowerCase()]]);
          }
          // a reverted create's replay (send.ts revertReason)
          if (!tx.to) throw new RpcError("execution reverted", 3);
          throw new Error(`unexpected eth_call to ${tx.to} on ${chain}`);
        }
        case "eth_sendRawTransaction": {
          const raw = params[0] as Hex;
          const p = parseTransaction(raw);
          const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
          const tx: SentTx = {
            chain,
            hash: keccak256(raw),
            raw,
            from,
            nonce: p.nonce ?? -1,
            to: p.to ?? null,
            data: p.data ?? "0x",
            type: p.type ?? "",
            chainId: p.chainId ?? 0,
            value: p.value ?? 0n,
          };
          const fate = o.fate?.(tx, sent.length) ?? "mine";
          sent.push(tx);
          if (fate === "refuse") throw new RpcError("insufficient funds for gas * price + value", -32000);
          const n = nonceOf(chain, from);
          if (txs[chain].has(tx.hash)) throw new RpcError("already known", -32000);
          if (tx.nonce !== n.pending) throw new RpcError(`nonce ${tx.nonce} is not the account's next, ${n.pending}`, -32000);
          n.pending++;
          const pooled: Pooled = { tx, fate };
          txs[chain].set(tx.hash, pooled);
          if (fate !== "hold") mine(chain, pooled);
          if (fate === "lost") {
            // the node took it (and mined it), but its answer is lost, and its pool and pending nonce lag once
            lagHash.add(tx.hash);
            lagNonce.set(`${chain}:${from.toLowerCase()}`, tx.nonce);
            throw new RpcError("the connection was reset", -32603);
          }
          return tx.hash;
        }
        case "eth_getTransactionReceipt":
          return txs[chain].get(params[0] as string)?.receipt ?? null;
        case "eth_getTransactionByHash": {
          if (lagHash.delete(params[0] as string)) return null;
          const p = txs[chain].get(params[0] as string);
          return p ? { hash: p.tx.hash, nonce: numberToHex(p.tx.nonce), blockNumber: p.receipt ? p.receipt.blockNumber : null } : null;
        }
      }
      throw new Error(`unexpected ${method} on ${chain}`);
    },
  };

  const byKeystore = new Map(Object.entries(SIGNERS).map(([chain, s]) => [s.keystore, TEST_DEPLOYERS[chain as ChainName]]));
  const runner: Runner = {
    async run(file, args) {
      runs.push({ file, args });
      const ks = args[args.indexOf("--keystore") + 1];
      const account = byKeystore.get(ks);
      if (args[0] === "wallet" && args[1] === "address") return account ? { code: 0, stdout: `${account.address}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "no keystore" };
      if (args[0] === "wallet" && args[1] === "sign" && args[2] === "--no-hash" && account) {
        return { code: 0, stdout: `${await account.sign({ hash: args[3] as Hex })}\n`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${file} ${args.join(" ")}` };
    },
  };

  const ctx: Ctx = {
    live: false,
    targets: targets({}).rehearsal,
    rpc,
    runner,
    paths: paths({}),
    log: (l) => logs.push(l),
    receiptTimeoutMs: 30,
    pollMs: 1,
  };

  return {
    ctx,
    calls,
    runs,
    sent,
    logs,
    code,
    /** The mined transactions, in the order they were mined. */
    mined: () => [...minedTxs],
    /** Mines every transaction held in a pool. */
    mineHeld: () => {
      for (const chain of ["bittensor", "base"] as const) for (const p of txs[chain].values()) if (!p.receipt) mine(chain, p);
    },
    /** Drops every transaction held in a pool, as a node that evicts it: its nonce is free again. */
    dropHeld: () => {
      for (const chain of ["bittensor", "base"] as const) {
        for (const [h, p] of txs[chain]) {
          if (p.receipt) continue;
          txs[chain].delete(h);
          nonceOf(chain, p.tx.from).pending--;
        }
      }
    },
    setNonce: (chain: ChainName, n: { latest: number; pending: number }) => nonce[chain].set(TEST_DEPLOYERS[chain].address.toLowerCase(), n),
  };
}

export const tempDir = (label: string) => mkdtempSync(join(tmpdir(), `ops-v32-${label}-`));
