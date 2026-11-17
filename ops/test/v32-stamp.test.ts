import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Abi,
  type Address,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  getAddress,
  type Hex,
  hashTypedData,
  hexToBigInt,
  keccak256,
  numberToHex,
  parseTransaction,
  recoverAddress,
  recoverTransactionAddress,
  size,
  slice,
  stringToBytes,
  toFunctionSelector,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "../src/args.ts";
import { type ChainName, paths, targets, UNCAPPED_COMMANDS, WALLET } from "../src/config.ts";
import { type Rpc, RpcError } from "../src/rpc.ts";
import { type Ctx, type Runner, type Signer, signedTransactionProblem } from "../src/send.ts";
import { type BuildRefV32, type BuildV32, freezeBuildV32, type SourceV32, writeBuildV32 } from "../src/v32/build.ts";
import { domainSeparatorV32 } from "../src/v32/code.ts";
import type { DeploymentRecordV32 } from "../src/v32/deploy.ts";
import { addressMapping, buildPlanV32, type PlanV32, plannedAddressesV32 } from "../src/v32/plan.ts";
import { SETTINGS_V32_LAUNCH, V3_LAUNCH_KEEPER } from "../src/v32/settings.ts";
import { GAP_RISK, STAMP_SPACING_HOURS } from "../src/v32/stamp-bounds.ts";
import {
  dueStamps,
  headTime,
  normaliseSignature,
  relayerFromEnv,
  relayerRefusals,
  type RelayOpts,
  relayStamp,
  signPageStamps,
  STAMP_ABI,
  STAMP_MAX_TTL,
  STAMP_TYPEHASH,
  type StampStack,
  stackAsOfs,
  stampCommand,
  stampHashes,
  type StampOpts,
  stampTypedData,
  stampTypedDataJson,
} from "../src/v32/stamp.ts";
import { STAMP_TYPEHASH_V32 } from "../src/v32/verify.ts";
import { parseWalletFile } from "../src/wallet.ts";
import { tempDir } from "./v32-chains.ts";
import { TAO_BOT, YUMA } from "./v32-fixtures.ts";
import { solConstant } from "./v32-sources.ts";

// Task 48: `pnpm ops stamp`, the owner's signed stamp (spec §3.6, stampBySig) relayed from a fresh account (plan Task
// 48; Review Focus 2). The library and a CLI that takes the signature as an argument (ruling C3: Task 49's sign page has
// the Ledger sign). Two fake chains answer the vault, the front door and their lenses, and check each stamp as
// CascadeBase.stampBySig does (65 bytes, v 27 or 28, a low s, the owner's signature over viem's EIP-712 digest, the
// window by the chain's head). Every key here is a test key made in-process: the owner's is the contracts' fixture key
// (makeAddrAndKey("owner"), public), the relayer's a throwaway. Nothing leaves the process; no keystore, password file,
// .env, network or forge is used.

// ---- the pinned vector (rulings B5, C4) ----

// Copied from contracts/test/governance/StampVector.sol, the owner-signed stamp's pinned vector, computed outside the
// contracts (viem 2.57.7 and cast 1.7.1), which Stamp.t.sol's test_domainAndTypehashMatchLocalComputation holds the
// vault, the front door and both lenses to. The owner's key is the fixtures' makeAddrAndKey("owner"),
// uint256(keccak256("owner")): a public test key, never a real one. "pinned to StampVector.sol" below checks these copies
// against that file's text, so a change there fails here.
const VECTOR = {
  ownerKey: "0x02016836a56b71f0d02689e69e326f4f4c1b9057164ef592671cf0d37c8040c0" as Hex,
  owner: "0x7c8999dC9a822c1f0Df42023113EDB4FDd543266" as Address,
  typehash: "0x4a2ff47f9ebab098e58b19433a88d005ec2123b12ee173beccfe13a7b0a94ebf" as Hex,
  /** 2027-01-01T00:00:00Z */
  asOf: 1_798_761_600n,
  structHash: "0xc758607de90d4c32798d08e2665888f960549e4056311f113a2ed144d52cea92" as Hex,
  vault: {
    chainId: 964,
    address: "0xCA5cADE000000000000000000000000000000964" as Address,
    domain: "0xf8fbbff19b87cd1783cd59e6bb525df7d8b0ae27bd5c6ef8e087a2688e10dc8f" as Hex,
    digest: "0x424b3ac38a739512242e3af08f69ef6a369425dfc523f081e86c899461ca299a" as Hex,
    sig: "0xa3a968c7f3f4fc461bbc512e2e7686a0fbedbecb06da1fb7c588ef7b998299cd62fe248d0304e4769d47608d4b72ff2bac69a214c64f4869b3eee7a0ee3b71761b" as Hex,
    fixture: "stamp-vector-vault.json",
  },
  door: {
    chainId: 8453,
    address: "0xcA5cAdE000000000000000000000000000008453" as Address,
    domain: "0x250114fdfbfaf4d09a0e86d6d983b53832962f05688abee0deb82861e448ed13" as Hex,
    digest: "0x5547690fc2a2a65c0cf61b749687f9f5b4e98680b030aedb9ede91afe17ef50b" as Hex,
    sig: "0xca8b6f10fdb3406e540f0024bd2b14bc75502b2c58e5855fd01ffad7bba189176b2dc80f685a9ae1958a260e530035735433e67d7cc4cceb7b6eef8f85a321f31b" as Hex,
    fixture: "stamp-vector-door.json",
  },
} as const;

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = N / 2n;
const OWNER = privateKeyToAccount(VECTOR.ownerKey);
/** The relayer: a throwaway test key, a fresh account of its own. */
const RELAYER = privateKeyToAccount(keccak256(toHex("cascade v3.2 ops test relayer")));
const RELAYER_KEY = { keystore: "Z:/test/relayer.keystore", passwordFile: "Z:/test/relayer.pw" };
const SOMEONE = privateKeyToAccount(keccak256(toHex("cascade v3.2 ops test, not the owner")));
const CONTRACTS = paths({}).contractsDir;
const SOURCE: SourceV32 = { commit: "c0ffee".padEnd(40, "0"), tree: "7ee".padEnd(40, "0"), dirty: [] };
const LIVE = targets({}).live;
const D = 86_400n;
const H = 3_600n;
const GWEI = 10n ** 9n;
const HEAD = 1_900_000_000n;
const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);
const sameText = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const repoText = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

let build: BuildV32;
let plan: PlanV32;
let buildsDir: string;
let ref: BuildRefV32;

beforeAll(async () => {
  build = (await freezeBuildV32(CONTRACTS, SOURCE)).build;
  const deployers = { base: getAddress(`0x${"d1".repeat(20)}`), bittensor: getAddress(`0x${"d2".repeat(20)}`) };
  // the owner is the vector's key, so a test can sign as it; the guardian and keeper are placeholders
  plan = buildPlanV32({
    deployers,
    roles: { owner: OWNER.address, guardian: at("b0b1"), keeper: at("c0c1"), treasury: SETTINGS_V32_LAUNCH.treasury },
    validators: { primary: TAO_BOT, standby: YUMA },
    vaultColdkey: addressMapping(plannedAddressesV32(deployers).vault),
    poolFloors: [10n ** 20n, 10n ** 17n],
    claimGasRequired: 55_000_000n,
  });
  buildsDir = tempDir("stamp-builds");
  const text = `${JSON.stringify(build, null, 2)}\n`;
  ref = writeBuildV32(buildsDir, { text, hash: keccak256(stringToBytes(text)) });
});

function record(): DeploymentRecordV32 {
  const sent = (block: number, address: Address) => ({ hash: `0x${"ab".repeat(32)}` as Hex, block, gasUsed: 1n, costWei: 1n, address });
  return {
    target: "live",
    createdAt: "2026-11-07T00:00:00.000Z",
    plan,
    build: ref,
    done: { vault: sent(1_000, plan.addresses.vault), frontDoor: sent(2_000, plan.addresses.frontDoor) },
  };
}

// ---- the fake chains ----

const CHAIN_OF = { vault: "bittensor", frontDoor: "base" } as const;
type Target = keyof typeof CHAIN_OF;

interface Mined {
  chain: ChainName;
  hash: Hex;
  from: Address;
  to: Address;
  nonce: number;
  type: string;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  asOf: bigint;
  sig: Hex;
  status: "0x1" | "0x0";
}

interface World {
  heads: Record<ChainName, bigint>;
  blocks: Record<ChainName, number>;
  owner: Record<ChainName, Address>;
  guardian: Record<ChainName, Address>;
  keeper: Record<ChainName, Address>;
  clocks: Record<ChainName, bigint>;
  /** The chain id the contract's own DOMAIN_SEPARATOR was made with (its immutable): the live one unless set. */
  contractChainId: Partial<Record<ChainName, number>>;
  domain: Partial<Record<ChainName, Hex>>;
  gasPrice: Record<ChainName, bigint>;
  priorityFee: bigint;
  balance: bigint;
  nonces: Record<ChainName, { latest: number; pending: number }>;
  /** An error the eth_call of stampBySig reverts with (for every stamp, or by its asOf), whatever it is asked. */
  simulate?: string | ((asOf: bigint) => string | undefined);
  /** The eth_call of stampBySig fails as an RPC error (no revert). */
  callFails?: boolean;
  calls: { chain: ChainName; method: string; params: unknown[] }[];
  sent: Mined[];
  receipts: Map<string, Record<string, unknown>>;
  /** What each keystore signs as (the fake `cast wallet`), and with which key. */
  keystores: Map<string, { address: Address; key?: Hex }>;
  logs: string[];
}

const RELAYER_PK = keccak256(toHex("cascade v3.2 ops test relayer"));

function world(o: Partial<Pick<World, "heads">> = {}): World {
  return {
    heads: o.heads ?? { bittensor: HEAD, base: HEAD + 5n },
    blocks: { bittensor: 5_000_000, base: 30_000_000 },
    owner: { bittensor: plan.roles.owner, base: plan.roles.owner },
    guardian: { bittensor: plan.roles.guardian, base: plan.roles.guardian },
    keeper: { bittensor: plan.roles.keeper, base: plan.roles.keeper },
    clocks: { bittensor: 0n, base: 0n },
    contractChainId: {},
    domain: {},
    gasPrice: { bittensor: 10n * GWEI, base: GWEI / 100n },
    priorityFee: GWEI / 1_000n,
    balance: 10n ** 18n,
    nonces: { bittensor: { latest: 3, pending: 3 }, base: { latest: 7, pending: 7 } },
    calls: [],
    sent: [],
    receipts: new Map(),
    keystores: new Map([[RELAYER_KEY.keystore, { address: RELAYER.address, key: RELAYER_PK }]]),
    logs: [],
  };
}

const contractOf = (chain: ChainName) => (chain === "bittensor" ? plan.addresses.vault : plan.addresses.frontDoor);
const lensOf = (chain: ChainName) => (chain === "bittensor" ? plan.addresses.vaultLens : plan.addresses.doorLens);
const reverts = (errorName: string) => new RpcError("execution reverted", 3, encodeErrorResult({ abi: STAMP_ABI, errorName } as never));

/** stampBySig as CascadeBase checks it, at the chain's head: its error's name, or none. The digest is viem's EIP-712
 * (hashTypedData), not ops's own stampHashes, so the two are held against each other. */
async function stampCheck(w: World, chain: ChainName, to: Address, asOf: bigint, sig: Hex): Promise<string | undefined> {
  if (size(sig) !== 65) return "BadStamp";
  const v = Number(hexToBigInt(slice(sig, 64, 65)));
  if ((v !== 27 && v !== 28) || hexToBigInt(slice(sig, 32, 64)) > HALF_N) return "BadStamp";
  const chainId = w.contractChainId[chain] ?? LIVE[chain].chainId;
  const digest = hashTypedData({
    domain: { name: "Cascade", version: "3.2", chainId, verifyingContract: to },
    types: { OwnerStamp: [{ name: "asOf", type: "uint64" }] },
    primaryType: "OwnerStamp",
    message: { asOf },
  });
  let signer: Address;
  try {
    signer = await recoverAddress({ hash: digest, signature: sig });
  } catch {
    return "BadStamp";
  }
  if (!sameText(signer, w.owner[chain])) return "BadStamp";
  const now = w.heads[chain];
  if (asOf > now || now > asOf + STAMP_MAX_TTL) return "StampOutOfWindow";
  return undefined;
}

function rpcOf(w: World): Rpc {
  return {
    async request(chain, method, params) {
      w.calls.push({ chain, method, params });
      const relayer = (a: unknown) => sameText(a, RELAYER.address) || [...w.keystores.values()].some((k) => sameText(k.address, a));
      switch (method) {
        case "eth_chainId":
          return numberToHex(LIVE[chain].chainId);
        case "eth_getBlockByNumber":
          return { number: numberToHex(w.blocks[chain]), timestamp: numberToHex(w.heads[chain]) };
        case "eth_gasPrice":
          return numberToHex(w.gasPrice[chain]);
        case "eth_maxPriorityFeePerGas":
          return numberToHex(w.priorityFee);
        case "eth_estimateGas":
          return numberToHex(48_000n);
        case "eth_getBalance":
          return numberToHex(w.balance);
        case "eth_getTransactionCount": {
          const [a, tag] = params as [Address, string];
          return numberToHex(relayer(a) ? w.nonces[chain][tag === "latest" ? "latest" : "pending"] : 0);
        }
        case "eth_getTransactionReceipt":
          return w.receipts.get(String(params[0]).toLowerCase()) ?? null;
        case "eth_getTransactionByHash":
          return w.receipts.has(String(params[0]).toLowerCase()) ? { hash: params[0] } : null;
        case "eth_call": {
          const [tx] = params as [{ to: Address; data: Hex; from?: Address }];
          const to = getAddress(tx.to);
          if (sameText(to, contractOf(chain))) {
            const abi: Abi = chain === "bittensor" ? build.vaultAbi : build.contracts.CascadeFrontDoor.abi;
            const call = decodeFunctionData({ abi, data: tx.data });
            if (call.functionName === "owner") return encodeFunctionResult({ abi, functionName: "owner", result: w.owner[chain] } as never);
            if (call.functionName === "keeper") return encodeFunctionResult({ abi, functionName: "keeper", result: w.keeper[chain] } as never);
            if (call.functionName === "stampBySig") {
              if (w.callFails) throw new RpcError("upstream request timeout", -32603);
              const [asOf, sig] = call.args as [bigint, Hex];
              const simulated = typeof w.simulate === "function" ? w.simulate(asOf) : w.simulate;
              if (simulated) throw reverts(simulated);
              const error = await stampCheck(w, chain, to, asOf, sig);
              if (error) throw reverts(error);
              return "0x";
            }
            throw new Error(`unexpected call ${call.functionName} on ${chain}'s contract`);
          }
          if (sameText(to, lensOf(chain))) {
            const abi: Abi = (chain === "bittensor" ? build.contracts.CascadeVaultLens : build.contracts.CascadeDoorLens).abi;
            const call = decodeFunctionData({ abi, data: tx.data });
            const answers: Record<string, unknown> = {
              guardian: w.guardian[chain],
              keeper: w.keeper[chain],
              lastOwnerClose: w.clocks[chain],
              DOMAIN_SEPARATOR: w.domain[chain] ?? domainSeparatorV32(LIVE[chain].chainId, contractOf(chain)),
              STAMP_TYPEHASH: STAMP_TYPEHASH_V32,
            };
            if (!(call.functionName in answers)) throw new Error(`unexpected call ${call.functionName} on ${chain}'s lens`);
            return encodeFunctionResult({ abi, functionName: call.functionName, result: answers[call.functionName] } as never);
          }
          throw new Error(`unexpected eth_call to ${to} on ${chain}`);
        }
        case "eth_sendRawTransaction": {
          const raw = params[0] as Hex;
          const tx = parseTransaction(raw);
          const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
          const n = w.nonces[chain];
          if ((tx.nonce ?? 0) < n.latest) throw new RpcError("nonce too low", -32000);
          const call = decodeFunctionData({ abi: STAMP_ABI, data: tx.data as Hex });
          const [asOf, sig] = call.args as [bigint, Hex];
          const error = await stampCheck(w, chain, getAddress(tx.to as Address), asOf, sig);
          const hash = keccak256(raw);
          const status = error ? "0x0" : "0x1";
          if (!error && asOf > w.clocks[chain]) w.clocks[chain] = asOf;
          n.latest = (tx.nonce ?? 0) + 1;
          n.pending = Math.max(n.pending, n.latest);
          w.sent.push({
            chain,
            hash,
            from,
            to: getAddress(tx.to as Address),
            nonce: tx.nonce ?? 0,
            type: tx.type ?? "legacy",
            gasPrice: tx.gasPrice,
            maxFeePerGas: tx.maxFeePerGas,
            maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
            asOf,
            sig,
            status,
          });
          w.receipts.set(hash.toLowerCase(), {
            status,
            blockNumber: numberToHex(w.blocks[chain] + 1),
            gasUsed: numberToHex(40_000n),
            effectiveGasPrice: numberToHex(tx.gasPrice ?? tx.maxFeePerGas ?? 0n),
            contractAddress: null,
            logs: [],
          });
          return hash;
        }
      }
      throw new Error(`unexpected ${method} on ${chain}`);
    },
  };
}

function runnerOf(w: World): Runner {
  return {
    async run(_file, args) {
      const ks = args[args.indexOf("--keystore") + 1];
      const k = w.keystores.get(ks);
      if (args[0] === "wallet" && args[1] === "address") return k ? { code: 0, stdout: `${k.address}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "no keystore" };
      if (args[0] === "wallet" && args[1] === "sign" && args[2] === "--no-hash" && k?.key) {
        return { code: 0, stdout: `${await privateKeyToAccount(k.key).sign({ hash: args[3] as Hex })}\n`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    },
  };
}

function ctxOf(w: World): Ctx {
  return { live: true, targets: LIVE, rpc: rpcOf(w), runner: runnerOf(w), paths: paths({}), log: (l) => w.logs.push(l), receiptTimeoutMs: 2_000, pollMs: 1 };
}
const relayerCtx = (w: World): Ctx => ({ ...ctxOf(w), signer: { address: RELAYER.address, ...RELAYER_KEY, name: "the relayer" } as Signer });
/** The accounts the relayer must not be, as the command reads them. */
const refusals = (w: World, target: Target) => relayerRefusals(ctxOf(w), record(), target, { buildsDir });
/** relayStamp from the relayer, with the refusals the command passes. */
const relay = async (w: World, target: Target, asOf: bigint, sig: Hex, o: Partial<RelayOpts> = {}) =>
  relayStamp(relayerCtx(w), CHAIN_OF[target], contractOf(CHAIN_OF[target]), asOf, sig, { ledger: await refusals(w, target), ...o });

/** The owner's signature (the vector's key) of `target`'s stamp as of `asOf`, as a wallet gives it: 65 bytes, v 27/28. */
const ownerSig = (target: Target, asOf: bigint, key: Hex = VECTOR.ownerKey) => {
  const chain = CHAIN_OF[target];
  return privateKeyToAccount(key).sign({ hash: stampHashes(LIVE[chain].chainId, contractOf(chain), asOf).digest });
};

const opts = (dir: string, o: Partial<StampOpts>): StampOpts => ({ mode: "prepare", targets: ["vault", "frontDoor"], dir, name: "v3.2-launch", buildsDir, relayer: RELAYER_KEY, ...o });
const run = (w: World, dir: string, o: Partial<StampOpts>) => stampCommand(ctxOf(w), record(), opts(dir, o));
const failure = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a failure");
};
const stampCalls = (w: World) => w.calls.filter((c) => c.method === "eth_call" && (c.params[0] as { data: Hex }).data.startsWith(toFunctionSelector("stampBySig(uint64,bytes)")));
const readStack = (dir: string, chain: ChainName): StampStack => JSON.parse(readFileSync(join(dir, `${chain}.json`), "utf8"));

/** A signature's r, s and v. */
const parts = (sig: Hex) => ({ r: hexToBigInt(slice(sig, 0, 32)), s: hexToBigInt(slice(sig, 32, 64)), v: Number(hexToBigInt(slice(sig, 64, 65))) });
const join65 = (r: bigint, s: bigint, v: number): Hex => `0x${r.toString(16).padStart(64, "0")}${s.toString(16).padStart(64, "0")}${v.toString(16).padStart(2, "0")}`;
/** A test signature whose v is 28 (y parity 1): the owner's key over some digest. */
async function sigWithV28(): Promise<{ digest: Hex; sig: Hex }> {
  for (let i = 0n; ; i++) {
    const digest = stampHashes(964, VECTOR.vault.address, VECTOR.asOf + i).digest;
    const sig = await OWNER.sign({ hash: digest });
    if (parts(sig).v === 28) return { digest, sig };
  }
}

describe("Task 48: the owner's stamp, its hashes and its signature", () => {
  it("hashesMatchTheContract: the domain, struct and digest as CascadeBase computes them, pinned to StampVector.sol's vector", () => {
    for (const t of [VECTOR.vault, VECTOR.door]) {
      expect(stampHashes(t.chainId, t.address, VECTOR.asOf)).toEqual({ domainHash: t.domain, structHash: VECTOR.structHash, digest: t.digest });
      // the typed data the Ledger signs (eth_signTypedData_v4) hashes, by viem's EIP-712, to the same digest
      expect(hashTypedData(stampTypedData(t.chainId, t.address, VECTOR.asOf))).toBe(t.digest);
      // and verify's domain separator (viem's hashDomain) is the same
      expect(domainSeparatorV32(t.chainId, t.address)).toBe(t.domain);
    }
    expect(STAMP_TYPEHASH).toBe(VECTOR.typehash);
    expect(STAMP_TYPEHASH_V32).toBe(VECTOR.typehash);
    expect(STAMP_TYPEHASH).toBe(keccak256(stringToBytes("OwnerStamp(uint64 asOf)")));
    // STAMP_MAX_TTL is the contracts' (CascadeConstants.sol, 1 days)
    expect(STAMP_MAX_TTL).toBe(solConstant("contracts/src/CascadeConstants.sol", "STAMP_MAX_TTL"));
    // a stamp for another chain, contract or time has another digest
    const d = stampHashes(964, VECTOR.vault.address, VECTOR.asOf).digest;
    expect(stampHashes(965, VECTOR.vault.address, VECTOR.asOf).digest).not.toBe(d);
    expect(stampHashes(964, VECTOR.door.address, VECTOR.asOf).digest).not.toBe(d);
    expect(stampHashes(964, VECTOR.vault.address, VECTOR.asOf + 1n).digest).not.toBe(d);
    // asOf is a uint64
    expect(() => stampHashes(964, VECTOR.vault.address, 1n << 64n)).toThrow(/uint64/);
    expect(() => stampHashes(964, VECTOR.vault.address, -1n)).toThrow(/uint64/);
  });

  it("pinned to StampVector.sol: the copies above are that file's constants", () => {
    const src = repoText("contracts/test/governance/StampVector.sol");
    const constant = (name: string) => {
      const m = src.match(new RegExp(`constant ${name}\\s*=\\s*(?:hex"([0-9a-fA-F]+)"|(0x[0-9a-fA-F]+)|(\\d+));`));
      if (!m) throw new Error(`StampVector.sol has no ${name}`);
      return m[1] ? `0x${m[1]}` : (m[2] ?? m[3]);
    };
    expect(constant("STAMP_VECTOR_OWNER_KEY")).toBe(VECTOR.ownerKey);
    expect(constant("STAMP_VECTOR_OWNER")).toBe(VECTOR.owner);
    expect(constant("STAMP_VECTOR_TYPEHASH")).toBe(VECTOR.typehash);
    expect(BigInt(constant("STAMP_VECTOR_AS_OF"))).toBe(VECTOR.asOf);
    expect(constant("STAMP_VECTOR_STRUCT_HASH")).toBe(VECTOR.structHash);
    for (const [k, t] of [
      ["VAULT", VECTOR.vault],
      ["DOOR", VECTOR.door],
    ] as const) {
      expect(Number(constant(`STAMP_VECTOR_${k}_CHAIN_ID`))).toBe(t.chainId);
      expect(constant(`STAMP_VECTOR_${k}_ADDRESS`)).toBe(t.address);
      expect(constant(`STAMP_VECTOR_${k}_DOMAIN_SEPARATOR`)).toBe(t.domain);
      expect(constant(`STAMP_VECTOR_${k}_DIGEST`)).toBe(t.digest);
      expect(constant(`STAMP_VECTOR_${k}_SIG`)).toBe(t.sig);
    }
    // the stamp's ABI is the contracts' (the published vault ABI and the front door's): each item's name, kind, types,
    // indexing and outputs
    const shape = (x: Abi[number]) => {
      const p = (ps: readonly { type: string; indexed?: boolean }[] = []) => ps.map((q) => `${q.type}${q.indexed ? " indexed" : ""}`).join(",");
      const f = x as { type: string; name: string; inputs?: { type: string; indexed?: boolean }[]; outputs?: { type: string }[]; stateMutability?: string };
      return `${f.type} ${f.name}(${p(f.inputs)}) -> (${p(f.outputs)}) ${f.stateMutability ?? ""}`;
    };
    for (const abi of [build.vaultAbi, build.contracts.CascadeFrontDoor.abi]) {
      for (const item of STAMP_ABI) {
        const theirs = abi.find((x) => x.type === item.type && "name" in x && x.name === (item as { name: string }).name);
        expect(theirs, shape(item)).toBeDefined();
        expect(shape(theirs as Abi[number])).toBe(shape(item));
      }
    }
  });

  it("the typed-data JSON fixtures reproduce StampVector.sol's signatures (the T9 review's carry)", async () => {
    for (const t of [VECTOR.vault, VECTOR.door]) {
      const json = fixture(t.fixture);
      // what ops asks the Ledger to sign is exactly this file, asOf as a decimal string (a wallet takes the number too)
      expect(stampTypedDataJson(t.chainId, t.address, VECTOR.asOf)).toEqual({ ...json, message: { asOf: String(json.message.asOf) } });
      const def = { ...json, message: { asOf: BigInt(json.message.asOf) } } as Parameters<typeof hashTypedData>[0];
      expect(hashTypedData(def)).toBe(t.digest);
      // the owner's key signs it to StampVector.sol's signature (RFC 6979: deterministic), as cast did
      expect(OWNER.address).toBe(VECTOR.owner);
      expect(await OWNER.signTypedData(def as never)).toBe(t.sig);
      expect(await OWNER.sign({ hash: t.digest })).toBe(t.sig);
      expect(normaliseSignature(t.sig)).toBe(t.sig);
      expect(await recoverAddress({ hash: t.digest, signature: t.sig })).toBe(VECTOR.owner);
    }
  });

  it("vZeroAndOneNormalised: a v of 0 or 1 is raised by 27; 27 and 28 kept; any other v refused", async () => {
    const body = VECTOR.vault.sig.slice(0, 130);
    expect(parts(VECTOR.vault.sig).v).toBe(27);
    expect(normaliseSignature(`${body}00`)).toBe(`${body}1b`);
    expect(normaliseSignature(`${body}1b`)).toBe(`${body}1b`);
    const { digest, sig } = await sigWithV28();
    const b28 = sig.slice(0, 130);
    expect(normaliseSignature(`${b28}01`)).toBe(`${b28}1c`);
    expect(normaliseSignature(`${b28}1c`)).toBe(sig);
    // each normalised form recovers to the owner, as the contract's ecrecover would
    expect(await recoverAddress({ hash: digest, signature: normaliseSignature(`${b28}01`) })).toBe(OWNER.address);
    expect(await recoverAddress({ hash: VECTOR.vault.digest, signature: normaliseSignature(`${body}00`) })).toBe(OWNER.address);
    // upper-case hex and spaces around it are taken
    expect(normaliseSignature(`  0x${VECTOR.vault.sig.slice(2).toUpperCase()} `)).toBe(VECTOR.vault.sig);
    for (const v of [2, 26, 29, 35, 36, 37, 38, 255]) {
      expect(() => normaliseSignature(`${body}${v.toString(16).padStart(2, "0")}`), `v ${v}`).toThrow(new RegExp(`the signature's v is ${v}: the contract takes 27 or 28`));
    }
  });

  it("compactSignatureExpanded: a 64-byte EIP-2098 signature becomes the 65-byte one, v from its top bit", async () => {
    const { digest, sig: sig28 } = await sigWithV28();
    for (const [sig, hash] of [
      [VECTOR.vault.sig, VECTOR.vault.digest],
      [sig28, digest],
    ] as const) {
      const { r, s, v } = parts(sig);
      const compact: Hex = `0x${r.toString(16).padStart(64, "0")}${(s | (BigInt(v - 27) << 255n)).toString(16).padStart(64, "0")}`;
      expect(size(compact)).toBe(64);
      expect(normaliseSignature(compact)).toBe(sig);
      expect(await recoverAddress({ hash, signature: normaliseSignature(compact) })).toBe(OWNER.address);
    }
  });

  it("highSAndOddLengthsRefused: a high s, a zero r or s, and any length but 65 and 64 bytes", () => {
    const { r, s, v } = parts(VECTOR.vault.sig);
    // the malleable twin (n - s, the other v): a valid ECDSA signature the contract refuses
    expect(() => normaliseSignature(join65(r, N - s, v === 27 ? 28 : 27))).toThrow(/high s.*the contract refuses it/);
    // the boundary: s = n/2 passes the shape check, n/2 + 1 does not
    expect(normaliseSignature(join65(r, HALF_N, 27))).toBe(join65(r, HALF_N, 27));
    expect(() => normaliseSignature(join65(r, HALF_N + 1n, 27))).toThrow(/high s/);
    // a compact signature whose s is high (its top bit cleared) too
    expect(() => normaliseSignature(join65(r, HALF_N + 1n, 27).slice(0, 130) as Hex)).toThrow(/high s/);
    // a zero r or s is no signature
    expect(() => normaliseSignature(join65(0n, s, 27))).toThrow(/r or s is zero/);
    expect(() => normaliseSignature(join65(r, 0n, 27))).toThrow(/r or s is zero/);
    expect(() => normaliseSignature(join65(N, s, 27))).toThrow(/r or s is zero or out of range/);
    // every other length, odd hex and non-hex
    const sig = VECTOR.vault.sig;
    for (const [bad, why] of [
      ["", /is not hex bytes/],
      ["0x", /is 0 bytes/],
      [sig.slice(0, 128), /is 63 bytes/],
      [`${sig}00`, /is 66 bytes/],
      [`${sig}0`, /is not hex bytes/],
      [sig.slice(2), /is not hex bytes/],
      [`0x${"zz".repeat(65)}`, /is not hex bytes/],
    ] as const) {
      expect(() => normaliseSignature(bad), bad).toThrow(why);
    }
    expect(() => normaliseSignature(`${sig}00`)).toThrow(/the contract takes 65 \(r, s, v\), and ops expands a 64-byte compact one \(EIP-2098\); nothing sent/);
  });
});

describe("Task 48: relaying a stamp", () => {
  it("asOfFromTheHeadNotTheWallClock: each stamp is dated by its chain's head, never the wall clock (Review Focus 2)", async () => {
    const wall = BigInt(Math.floor(Date.now() / 1000));
    const w = world({ heads: { bittensor: wall - 30n, base: wall - 2n } });
    const dir = tempDir("stamp-head");
    const r = await run(w, dir, { mode: "prepare" });
    expect(r.ok).toBe(true);
    expect(r.files).toHaveLength(2);
    const vault = JSON.parse(readFileSync(r.files[0], "utf8"));
    const door = JSON.parse(readFileSync(r.files[1], "utf8"));
    expect(vault).toEqual(stampTypedDataJson(964, plan.addresses.vault, wall - 30n));
    expect(door).toEqual(stampTypedDataJson(8453, plan.addresses.frontDoor, wall - 2n));
    expect(vault.message.asOf).not.toBe(String(wall));
    expect(await headTime(ctxOf(w), "bittensor")).toBe(wall - 30n);
    // what the founder compares on the Ledger (it may blind-sign EIP-712): the domain hash, the struct hash and the digest
    const h = stampHashes(964, plan.addresses.vault, wall - 30n);
    const text = r.lines.join("\n");
    expect(text).toContain(`Bittensor vault ${plan.addresses.vault} (chain 964): the owner's stamp as of ${wall - 30n}`);
    expect(text).toContain(`domain hash ${h.domainHash}, message hash ${h.structHash}, digest ${h.digest}`);
    expect(text).toContain(`pnpm ops stamp vault --as-of ${wall - 30n} --sig <the signature> --live`);
    expect(text).toContain(`pnpm ops stamp front-door --as-of ${wall - 2n} --sig <the signature> --live`);
    expect(w.sent).toEqual([]);
    // a stamp dated by the wall clock is 30 s in the future of Bittensor's head: refused before it is asked or sent
    const e = await failure(relay(w, "vault", wall, await ownerSig("vault", wall)));
    expect(e.message).toBe(
      `the stamp as of ${wall} (${iso(wall)}) is 30 seconds in the future of Bittensor's head (${iso(wall - 30n)}): the contract refuses it (StampOutOfWindow) until then; nothing sent`,
    );
    expect(stampCalls(w)).toEqual([]);
    expect(w.sent).toEqual([]);
    // dated by the head, it goes
    const sent = await relay(w, "vault", wall - 30n, await ownerSig("vault", wall - 30n));
    expect(sent.hash).toBe(w.sent[0].hash);
    expect(w.clocks.bittensor).toBe(wall - 30n);
  });

  it("the window by the chain's head: [asOf, asOf + STAMP_MAX_TTL], less a minute before expiry; refused before anything is asked outside it", async () => {
    const w = world();
    const head = w.heads.bittensor;
    const one = async (asOf: bigint) => relay(w, "vault", asOf, await ownerSig("vault", asOf));
    expect((await failure(one(head + 1n))).message).toMatch(/is 1 second in the future of Bittensor's head/);
    expect((await failure(one(head - STAMP_MAX_TTL - 1n))).message).toBe(
      `the stamp as of ${head - D - 1n} (${iso(head - D - 1n)}) expired at ${iso(head - 1n)} by Bittensor's head (${iso(head)}): the contract refuses it (StampOutOfWindow); have the owner sign a new one; nothing sent`,
    );
    // within a minute of expiring, its block could come too late: refused too (ruling M5), a day old exactly included
    for (const age of [STAMP_MAX_TTL, STAMP_MAX_TTL - 59n]) {
      expect((await failure(one(head - age))).message).toBe(
        `the stamp as of ${head - age} (${iso(head - age)}) expires at ${iso(head - age + D)}, less than a minute after Bittensor's head (${iso(head)}): its block could come too late (StampOutOfWindow); have the owner sign a new one; nothing sent`,
      );
    }
    expect(stampCalls(w)).toEqual([]);
    expect(w.sent).toEqual([]);
    // the boundaries pass: a minute from expiring, and as of now
    await one(head - STAMP_MAX_TTL + 60n);
    await one(head);
    expect(w.sent.map((s) => s.asOf)).toEqual([head - D + 60n, head]);
    expect(w.sent.every((s) => s.status === "0x1")).toBe(true);
    // relayStamp refuses a call without the accounts the relayer must not be (ruling M1)
    expect((await failure(relayStamp(relayerCtx(w), "bittensor", plan.addresses.vault, head, await ownerSig("vault", head), {} as RelayOpts))).message).toBe(
      "relayStamp needs the accounts the relayer must not be (relayerRefusals); nothing sent",
    );
  });

  it("simulates stampBySig by eth_call from the relayer before relaying: a revert is the contract's error, nothing sent", async () => {
    const w = world();
    const head = w.heads.bittensor;
    const sig = await ownerSig("vault", head);
    w.simulate = "StampOutOfWindow";
    expect((await failure(relay(w, "vault", head, sig))).message).toBe(
      `stampBySig(${head}) on Bittensor ${plan.addresses.vault} would revert: StampOutOfWindow(); nothing sent`,
    );
    w.simulate = "BadStamp";
    expect((await failure(relay(w, "vault", head, sig))).message).toMatch(/would revert: BadStamp\(\); nothing sent/);
    w.simulate = undefined;
    w.callFails = true;
    expect((await failure(relay(w, "vault", head, sig))).message).toMatch(
      /Couldn't check stampBySig\(\d+\) on Bittensor right now \(the RPC did not run it: upstream request timeout\); try again; nothing sent/,
    );
    w.callFails = false;
    expect(w.sent).toEqual([]);
    // a signature by anyone but the owner the contract names now: refused before the eth_call, naming who signed
    const other = await ownerSig("vault", head, keccak256(toHex("cascade v3.2 ops test, not the owner")));
    expect((await failure(relay(w, "vault", head, other))).message).toMatch(
      new RegExp(`the signature is ${SOMEONE.address}'s, not the owner ${plan.roles.owner}'s`),
    );
    // the front door's stamp on the vault: another digest, so another signer
    const door = await ownerSig("frontDoor", head);
    expect((await failure(relay(w, "vault", head, door))).message).toMatch(/it may be for another chain, contract or time; nothing sent/);
    expect(stampCalls(w)).toHaveLength(3);
    expect(w.sent).toEqual([]);
    // a good one: the eth_call from the relayer, then the send, of the same calldata
    const before = w.calls.length;
    await relay(w, "vault", head, sig);
    const after = w.calls.slice(before);
    const asked = after.findIndex((c) => c.method === "eth_call" && (c.params[0] as { data: Hex }).data.startsWith(toFunctionSelector("stampBySig(uint64,bytes)")));
    const sent = after.findIndex((c) => c.method === "eth_sendRawTransaction");
    expect(asked).toBeGreaterThanOrEqual(0);
    expect(sent).toBeGreaterThan(asked);
    expect((after[asked].params[0] as { from: Address }).from).toBe(RELAYER.address);
    expect(w.sent[0]).toMatchObject({ from: RELAYER.address, to: plan.addresses.vault, asOf: head, sig, status: "0x1" });
    // a wallet's v-0 and compact forms relay as the normalised signature
    const { r, s, v } = parts(sig);
    const w2 = world();
    await relay(w2, "vault", head, join65(r, s, v - 27));
    await relay(w2, "vault", head, `0x${r.toString(16).padStart(64, "0")}${(s | (BigInt(v - 27) << 255n)).toString(16).padStart(64, "0")}`);
    expect(w2.sent.map((x) => x.sig)).toEqual([sig, sig]);
    expect(w2.sent.every((x) => x.status === "0x1")).toBe(true);
  });

  it("relayerFromTheLedgerSeedRefused (ruling B10: relayerEqualToAKnownLedgerAccountRefused): never the owner, the guardian or the treasury, nor another hot key", async () => {
    const dir = tempDir("stamp-relayer");
    const w = world();
    const head = w.heads.bittensor;
    const sig = await ownerSig("vault", head);
    const newGuardian = at("9a9a");
    w.guardian.bittensor = newGuardian;
    for (const [name, address] of [
      ["the owner", plan.roles.owner],
      ["the plan's guardian", plan.roles.guardian],
      ["the treasury", plan.roles.treasury],
      ["the guardian", newGuardian],
    ] as const) {
      w.keystores.set(RELAYER_KEY.keystore, { address });
      const e = await failure(run(w, dir, { mode: "relay", targets: ["vault"], asOf: head, sig }));
      expect(e.message, name).toBe(
        `the relayer ${address} is ${name}, an account of the Ledger: a copied seed would sweep its gas too. Relay from a fresh key of its own (cast wallet new); nothing sent`,
      );
    }
    expect(stampCalls(w)).toEqual([]);
    expect(w.sent).toEqual([]);
    // relayStamp itself refuses each, given the list relayerRefusals reads (ruling M1): the owner it reads, and the
    // guardian and the treasury from the list
    const ledger = await refusals(w, "vault");
    for (const [name, address] of [
      ["the owner", plan.roles.owner],
      ["the guardian", newGuardian],
      ["the treasury", plan.roles.treasury],
    ] as const) {
      const as = { ...ctxOf(w), signer: { address, ...RELAYER_KEY, name: "the relayer" } };
      expect((await failure(relayStamp(as, "bittensor", plan.addresses.vault, head, sig, { ledger }))).message).toMatch(new RegExp(`is ${name}, an account of the Ledger`));
    }
    // and never a key with a job of its own (ruling M2): the keepers, the deployers, the test wallet
    const newKeeper = at("4e4e");
    w.keeper.bittensor = newKeeper;
    for (const [name, address] of [
      ["the keeper", newKeeper],
      ["the plan's keeper", plan.roles.keeper],
      ["v3-launch's keeper", V3_LAUNCH_KEEPER],
      ["the Base deployer", plan.deployers.base],
      ["the Bittensor deployer", plan.deployers.bittensor],
      ["the test wallet", WALLET],
    ] as const) {
      w.keystores.set(RELAYER_KEY.keystore, { address });
      const e = await failure(run(w, dir, { mode: "relay", targets: ["vault"], asOf: head, sig }));
      expect(e.message, name).toBe(
        `the relayer ${address} is ${name}, a key with a job of its own: a relay with --tip could replace that job's pending transaction. Relay from a fresh key of its own (cast wallet new); nothing sent`,
      );
    }
    expect(stampCalls(w)).toEqual([]);
    expect(w.sent).toEqual([]);
    // a keystore that doesn't open, and no keystore named
    w.keystores.delete(RELAYER_KEY.keystore);
    expect((await failure(run(w, dir, { mode: "relay", targets: ["vault"], asOf: head, sig }))).message).toMatch(/the relayer's keystore \(OPS_RELAYER_KEYSTORE\) does not open with its password file; nothing sent/);
    expect(() => relayerFromEnv({})).toThrow(/OPS_RELAYER_KEYSTORE is not set[\s\S]*OPS_RELAYER_PASSWORD_FILE is not set[\s\S]*nothing sent/);
    expect(relayerFromEnv({ OPS_RELAYER_KEYSTORE: "Z:/r.keystore", OPS_RELAYER_PASSWORD_FILE: "Z:/r.pw" })).toEqual({ keystore: "Z:/r.keystore", passwordFile: "Z:/r.pw" });
    // a fresh key relays, and the line says what the owner's clock reads now
    const ok = world();
    const r = await run(ok, dir, { mode: "relay", targets: ["vault"], asOf: head, sig });
    expect(r.ok).toBe(true);
    expect(ok.sent).toHaveLength(1);
    expect(r.lines.at(-1)).toBe(
      `Bittensor vault ${plan.addresses.vault}: stamped as of ${iso(head)} (transaction ${ok.sent[0].hash}). The owner's clock reads ${iso(head)}: every item scheduled there at or before then is dead.`,
    );
  });

  it("--tip for the halt-resumption race: the priority fee on Base, a higher gas price on Bittensor; a pending relay replaced only with one", async () => {
    const w = world();
    const head = w.heads.bittensor;
    // Bittensor sends legacy transactions: the gas price is the node's plus the tip
    await relay(w, "vault", head, await ownerSig("vault", head), { tipGwei: 50n });
    expect(w.sent[0]).toMatchObject({ type: "legacy", gasPrice: w.gasPrice.bittensor + 50n * GWEI });
    // without one, the node's price
    await relay(w, "vault", head, await ownerSig("vault", head));
    expect(w.sent[1]).toMatchObject({ type: "legacy", gasPrice: w.gasPrice.bittensor });
    // Base, EIP-1559: the tip is the priority fee, on top of twice the gas price
    const doorHead = w.heads.base;
    await relay(w, "frontDoor", doorHead, await ownerSig("frontDoor", doorHead), { tipGwei: 2n });
    expect(w.sent[2]).toMatchObject({ type: "eip1559", maxPriorityFeePerGas: 2n * GWEI, maxFeePerGas: 2n * w.gasPrice.base + 2n * GWEI });
    await relay(w, "frontDoor", doorHead, await ownerSig("frontDoor", doorHead));
    expect(w.sent[3]).toMatchObject({ type: "eip1559", maxPriorityFeePerGas: w.priorityFee, maxFeePerGas: 2n * w.gasPrice.base + w.priorityFee });
    // a relay still pending (a halted chain): refused without a tip, replaced at its nonce with one
    w.nonces.bittensor = { latest: 9, pending: 10 };
    const sig = await ownerSig("vault", head);
    expect((await failure(relay(w, "vault", head, sig))).message).toBe(
      "Bittensor: an earlier transaction from the relayer (nonce 9) is still waiting to be mined: wait for it, or replace it with --tip <gwei>; nothing sent",
    );
    await relay(w, "vault", head, sig, { tipGwei: 100n });
    expect(w.sent.at(-1)).toMatchObject({ nonce: 9, gasPrice: w.gasPrice.bittensor + 100n * GWEI });
    // the relayer must hold the gas: refused with the amounts
    const poor = world();
    poor.balance = 1_000n;
    expect((await failure(relay(poor, "vault", head, sig))).message).toMatch(
      new RegExp(`Bittensor: the relayer ${RELAYER.address} holds 0.000000000000001 TAO, but the stamp can cost up to 0.0006 TAO \\(60,000 gas at 10 gwei\\): fund it; nothing sent`),
    );
    expect(poor.sent).toEqual([]);
    // the stamp is a defence: it goes under no gas price cap
    expect(UNCAPPED_COMMANDS).toContain("stamp");
  });

  it("the relay's signed transaction is decoded back before it goes: another to, value or calldata is refused", async () => {
    const tx = { type: "legacy", chainId: 964, nonce: 3, gas: 60_000n, gasPrice: 10n * GWEI, to: plan.addresses.vault, data: "0x1234" as Hex, value: 0n } as const;
    const signed = (t: object) => RELAYER.signTransaction(t as never);
    expect(await signedTransactionProblem(tx, await signed(tx), RELAYER.address)).toBeNull();
    expect(await signedTransactionProblem(tx, await signed({ ...tx, to: plan.addresses.frontDoor }), RELAYER.address)).toBe(
      `its to is ${plan.addresses.frontDoor.toLowerCase()}, not the planned ${plan.addresses.vault.toLowerCase()}`,
    );
    expect(await signedTransactionProblem(tx, await signed({ ...tx, value: 1n }), RELAYER.address)).toBe("its value is 1, not the planned 0");
    expect(await signedTransactionProblem(tx, await signed({ ...tx, data: "0x1235" }), RELAYER.address)).toBe("its data is not the planned calldata");
    // a create is still refused any to at all (Task 44's check, unchanged)
    const create = { ...tx, to: undefined };
    expect(await signedTransactionProblem(create, await signed(tx), RELAYER.address)).toBe(`its to is ${plan.addresses.vault.toLowerCase()}, not the planned null`);
    expect(await signedTransactionProblem(create, await signed({ ...create, data: "0x1235" }), RELAYER.address)).toBe("its data is not the planned creation code and arguments");
  });
});

describe("Task 48: the stack and the bot", () => {
  /** A stack file for `chain`, written as the module writes one, with `stamps` (each signed by the owner unless `sig: null`). */
  async function stackFile(dir: string, chain: ChainName, stamps: { asOf: bigint; signed?: boolean; relayed?: boolean }[]): Promise<void> {
    const target: Target = chain === "bittensor" ? "vault" : "frontDoor";
    const s: StampStack = {
      version: 1,
      deployment: "v3.2-launch",
      target: "live",
      chain,
      chainId: LIVE[chain].chainId,
      contract: contractOf(chain),
      stamps: await Promise.all(
        stamps.map(async (x) => ({
          asOf: x.asOf.toString(),
          digest: stampHashes(LIVE[chain].chainId, contractOf(chain), x.asOf).digest,
          sig: x.signed === false ? null : await ownerSig(target, x.asOf),
          ...(x.relayed ? { relayed: { hash: `0x${"77".repeat(32)}` as Hex, block: 1 } } : {}),
        })),
      ),
    };
    writeFileSync(join(dir, `${chain}.json`), `${JSON.stringify(s, null, 2)}\n`);
  }

  it("stackHoldsNoFutureStamp: the stack is dated from each head, and a stamp is relayed only once the head has reached it", async () => {
    const wall = 1_900_000_000n;
    const w = world({ heads: { bittensor: wall - 30n, base: wall - 2n } });
    const dir = tempDir("stamp-stack");
    const r = await run(w, dir, { mode: "stack", days: 3 });
    expect(r.ok).toBe(true);
    const head = wall - 30n;
    // a stamp every 12 hours by default (ruling I1): 3 days are 6 stamps, the last 2.5 days after the head
    const H12 = 12n * H;
    const grid = (from: bigint) => [0n, 1n, 2n, 3n, 4n, 5n].map((i) => from + i * H12);
    expect(STAMP_SPACING_HOURS).toBe(12);
    expect(stackAsOfs(head, 3)).toEqual(grid(head));
    const vault = readStack(dir, "bittensor");
    expect(vault.stamps.map((s) => BigInt(s.asOf))).toEqual(grid(head));
    expect(vault.stamps.every((s) => s.sig === null && !s.relayed)).toBe(true);
    expect(vault.stamps.map((s) => s.digest)).toEqual(vault.stamps.map((s) => stampHashes(964, plan.addresses.vault, BigInt(s.asOf)).digest));
    expect(readStack(dir, "base").stamps.map((s) => BigInt(s.asOf))).toEqual(grid(wall - 2n));
    // each chain's own file and count (ruling M4), and the last as-of, the earliest a founder item can be scheduled to survive
    const text = r.lines.join("\n");
    expect(r.lines).toContain(`Bittensor vault ${plan.addresses.vault} (chain 964): wrote ${join(dir, "bittensor.json")}, 6 stamps to sign, every 12 hours from Bittensor's head (${iso(head)}):`);
    expect(r.lines).toContain(`Base front door ${plan.addresses.frontDoor} (chain 8453): wrote ${join(dir, "base.json")}, 6 stamps to sign, every 12 hours from Base's head (${iso(wall - 2n)}):`);
    expect(r.files).toEqual([join(dir, "bittensor.json"), join(dir, "base.json")]);
    expect(text).toContain(
      `The last stamp is as of ${iso(head + 5n * H12)}: anything scheduled on Bittensor at or before then dies to it. Schedule what you mean to keep after that.`,
    );
    expect(text).not.toContain("WARNING");
    expect(text).toContain(`pnpm ops stamp vault --as-of <time> --sig <the signature> --to-stack --live`);
    // the owner signs each, and each is added, the contract asked first (ruling M6): the stamp as of the head runs, a later
    // one answers StampOutOfWindow, which a good signature reaches
    for (const s of vault.stamps) {
      const asked = stampCalls(w).length;
      const a = await run(w, dir, { mode: "toStack", targets: ["vault"], asOf: BigInt(s.asOf), sig: await ownerSig("vault", BigInt(s.asOf)) });
      expect(a.ok).toBe(true);
      expect(stampCalls(w)).toHaveLength(asked + 1);
    }
    expect(readStack(dir, "bittensor").stamps.every((s) => s.sig !== null)).toBe(true);
    // at the head only the first is due: its asOf is the head, never the wall clock 30 s ahead of it
    expect(dueStamps(readStack(dir, "bittensor"), head).map((s) => BigInt(s.asOf))).toEqual([head]);
    const first = await run(w, dir, { mode: "relayDue", targets: ["vault"] });
    expect(first.ok).toBe(true);
    expect(w.sent.map((s) => s.asOf)).toEqual([head]);
    // a second before the next stamp's asOf by the head (though the wall clock is past it): nothing relayed, nothing asked
    w.heads.bittensor = head + H12 - 1n;
    const calls = stampCalls(w).length;
    const quiet = await run(w, dir, { mode: "relayDue", targets: ["vault"] });
    expect(quiet.lines).toContain(`Bittensor vault: nothing due now (head time ${iso(head + H12 - 1n)}); the next is due at ${iso(head + H12)}.`);
    expect(quiet.ok).toBe(true);
    expect(stampCalls(w)).toHaveLength(calls);
    expect(w.sent).toHaveLength(1);
    // relayStamp itself refuses it
    expect((await failure(relay(w, "vault", head + H12, await ownerSig("vault", head + H12)))).message).toMatch(/1 second in the future of Bittensor's head/);
    // once the head reaches it, it goes
    w.heads.bittensor = head + H12;
    await run(w, dir, { mode: "relayDue", targets: ["vault"] });
    expect(w.sent.map((s) => s.asOf)).toEqual([head, head + H12]);
    expect(w.sent.every((s) => s.status === "0x1")).toBe(true);
    // the file records each relay, so none is sent twice
    expect(readStack(dir, "bittensor").stamps.map((s) => s.relayed?.hash ?? null)).toEqual([w.sent[0].hash, w.sent[1].hash, null, null, null, null]);
    // adding a signature checks it: the owner's, for a time in the stack
    const bad = await run(w, dir, { mode: "toStack", targets: ["vault"], asOf: head + 2n * D, sig: await ownerSig("vault", head + 2n * D, keccak256(toHex("cascade v3.2 ops test, not the owner"))) }).catch((e: Error) => e);
    expect((bad as Error).message).toMatch(new RegExp(`the signature is ${SOMEONE.address}'s, not the owner ${plan.roles.owner}'s`));
    const off = await run(w, dir, { mode: "toStack", targets: ["vault"], asOf: head + 5n, sig: await ownerSig("vault", head + 5n) }).catch((e: Error) => e);
    expect((off as Error).message).toBe(`${head + 5n} is not one of the times in ${join(dir, "bittensor.json")}: sign one of its stamps, or write a new stack with --stack <days>; nothing added`);
  });

  it("relayDuePicksExactlyTheDueOnes: as of now or before, more than a minute from expiring, signed and not relayed yet; the newest relayed", async () => {
    const w = world();
    const dir = tempDir("stamp-due");
    const now = w.heads.bittensor;
    const stamps = [
      { asOf: now - D - 1n }, // expired, never relayed
      { asOf: now - D }, // a day old: expiring now
      { asOf: now - D + 59n }, // 59 s from expiring: too close (ruling M5)
      { asOf: now - D + 60n }, // a minute from expiring: due
      { asOf: now - 12n * H, relayed: true }, // relayed already
      { asOf: now - 6n * H, signed: false }, // due, but not signed
      { asOf: now - 1n }, // due
      { asOf: now }, // due: as of now, the newest
      { asOf: now + 1n }, // a second in the future
      { asOf: now + D }, // tomorrow's
    ];
    await stackFile(dir, "bittensor", stamps);
    // exactly the due ones, newest first
    expect(dueStamps(readStack(dir, "bittensor"), now).map((s) => BigInt(s.asOf))).toEqual([now, now - 1n, now - D + 60n]);
    const r = await run(w, dir, { mode: "relayDue", targets: ["vault"] });
    // the newest is relayed; it covers the older due ones (the clock only moves to the latest), which are not sent
    expect(w.sent.map((s) => s.asOf)).toEqual([now]);
    expect(w.sent[0]).toMatchObject({ status: "0x1", from: RELAYER.address });
    expect(stampCalls(w)).toHaveLength(1);
    expect(r.lines).toContain(`Bittensor vault: relayed the stamp as of ${iso(now)} (transaction ${w.sent[0].hash}).`);
    expect(r.lines).toContain(`Bittensor vault: 2 older due stamps (as of ${iso(now - 1n)}, ${iso(now - D + 60n)}) not sent: the stamp as of ${iso(now)} covers them.`);
    const after = readStack(dir, "bittensor").stamps;
    expect(after.filter((x) => x.relayed?.hash === w.sent[0].hash).map((x) => BigInt(x.asOf))).toEqual([now]);
    expect(after.filter((x) => x.coveredBy === w.sent[0].hash).map((x) => BigInt(x.asOf))).toEqual([now - D + 60n, now - 1n]);
    // what it couldn't relay is said (ruling M3): the ones that left their window unrelayed, each covered by the stamp
    // relayed now, so they fail nothing (Task 48's re-review, N2), and the one never signed, which fails the run; and the
    // stack's last day ahead is warned of
    expect(r.ok).toBe(false);
    for (const t of [now - D - 1n, now - D, now - D + 59n]) {
      expect(r.lines).toContain(`Bittensor vault: the stamp as of ${iso(t)} was not relayed in its window; the stamp as of ${iso(now)}, relayed since, covers it.`);
    }
    expect(r.lines.join("\n")).not.toContain("was not relayed in its window.");
    expect(r.lines).toContain(`  WARNING — Bittensor vault: the stamp as of ${iso(now - 6n * H)} is due but not signed.`);
    expect(r.lines).toContain(`  WARNING — Bittensor vault: the stack has less than 2 days left: its last stamp is as of ${iso(now + D)}. Write and sign a new stack before then.`);
    expect(r.lines.at(-1)).toBe("This run fails: see the lines above.");
    // a second run sends nothing more: each relay, and what it covered, is in the file
    const again = await run(w, dir, { mode: "relayDue", targets: ["vault"] });
    expect(w.sent).toHaveLength(1);
    expect(again.lines).toContain(`Bittensor vault: nothing due now (head time ${iso(now)}); the next is due at ${iso(now + 1n)}.`);
    // the newest failing, the next newest is relayed in its place
    const f = world();
    const dir5 = tempDir("stamp-fallback");
    await stackFile(dir5, "bittensor", [{ asOf: now - 1n }, { asOf: now }, { asOf: now + 3n * D }]);
    f.simulate = (asOf) => (asOf === now ? "BadStamp" : undefined);
    const fb = await run(f, dir5, { mode: "relayDue", targets: ["vault"] });
    expect(f.sent.map((s) => s.asOf)).toEqual([now - 1n]);
    expect(fb.lines[0]).toMatch(new RegExp(`^Bittensor vault: the stamp as of ${iso(now)} was not relayed: stampBySig\\(${now}\\) on Bittensor .* would revert: BadStamp\\(\\); nothing sent$`));
    expect(fb.lines[1]).toBe(`Bittensor vault: relayed the stamp as of ${iso(now - 1n)} (transaction ${f.sent[0].hash}).`);
    expect(fb.ok).toBe(false);
    // the stack running out is said loudly, and fails the run (the bot's alarm)
    const end = world();
    const dir2 = tempDir("stamp-end");
    await stackFile(dir2, "bittensor", [{ asOf: end.heads.bittensor - 10n }]);
    const last = await run(end, dir2, { mode: "relayDue", targets: ["vault"] });
    expect(end.sent).toHaveLength(1);
    expect(last.ok).toBe(false);
    expect(last.lines).toContain(
      `  WARNING — Bittensor vault: the stack's last stamp is as of ${iso(end.heads.bittensor - 10n)}: write and sign a new stack before ${iso(end.heads.bittensor - 10n + D)}, or items scheduled after it survive.`,
    );
    // a relayer key that doesn't open: each due stamp says so, nothing sent, not ok
    const nokey = world();
    nokey.keystores.clear();
    const dir4 = tempDir("stamp-nokey");
    await stackFile(dir4, "bittensor", [{ asOf: nokey.heads.bittensor }, { asOf: nokey.heads.bittensor + D }]);
    const k = await run(nokey, dir4, { mode: "relayDue", targets: ["vault"] });
    expect(k.ok).toBe(false);
    expect(k.lines[0]).toBe(
      `Bittensor vault: the stamp as of ${iso(nokey.heads.bittensor)} was not relayed: the relayer's keystore (OPS_RELAYER_KEYSTORE) does not open with its password file; nothing sent`,
    );
    expect(k.lines.at(-1)).toBe("This run fails: see the lines above.");
    expect(nokey.sent).toEqual([]);
    expect(readStack(dir4, "bittensor").stamps.every((x) => !x.relayed)).toBe(true);
    // no stack: said, and not ok
    const none = await run(world(), tempDir("stamp-none"), { mode: "relayDue", targets: ["vault"] });
    expect(none.ok).toBe(false);
    expect(none.lines[0]).toMatch(/^Bittensor vault: no stack at .*bittensor\.json: write one with pnpm ops stamp --stack <days>\.$/);
    // a stack for another contract or chain is refused, nothing relayed
    const dir3 = tempDir("stamp-other");
    await stackFile(dir3, "bittensor", [{ asOf: now }]);
    const s = readStack(dir3, "bittensor");
    writeFileSync(join(dir3, "bittensor.json"), JSON.stringify({ ...s, contract: at("dead") }));
    const other = world();
    const refused = await run(other, dir3, { mode: "relayDue", targets: ["vault"] });
    expect(refused.ok).toBe(false);
    expect(refused.lines[0]).toMatch(/is for contract 0x0{36}dEaD on chain 964 of v3.2-launch \(live\), not this deployment's vault/);
    expect(other.sent).toEqual([]);
  });

  it("the 2-day lead-time warning alone leaves the run ok, and a missed stamp a later relay covers fails nothing (Task 48's re-review, N1 and N2)", async () => {
    const now = HEAD;
    // N1: a healthy stack whose last signed stamp is less than 2 days ahead: it warns, and the run stays ok
    const w = world();
    const dir = tempDir("stamp-lead");
    await stackFile(dir, "bittensor", [{ asOf: now }, { asOf: now + 12n * H }, { asOf: now + D }]);
    const lead = await run(w, dir, { mode: "relayDue", targets: ["vault"] });
    expect(w.sent.map((s) => s.asOf)).toEqual([now]);
    expect(lead.lines).toContain(`  WARNING — Bittensor vault: the stack has less than 2 days left: its last stamp is as of ${iso(now + D)}. Write and sign a new stack before then.`);
    expect(lead.lines).not.toContain("This run fails: see the lines above.");
    expect(lead.ok).toBe(true);
    // N2: a stamp that left its window unrelayed, with a later stamp relayed since: said, without WARNING, and ok
    const c = world();
    const dir2 = tempDir("stamp-covered");
    await stackFile(dir2, "bittensor", [{ asOf: now - D - 2n * H }, { asOf: now - 12n * H, relayed: true }, { asOf: now + 3n * D }]);
    const covered = await run(c, dir2, { mode: "relayDue", targets: ["vault"] });
    expect(covered.lines).toContain(`Bittensor vault: the stamp as of ${iso(now - D - 2n * H)} was not relayed in its window; the stamp as of ${iso(now - 12n * H)}, relayed since, covers it.`);
    expect(covered.lines.join("\n")).not.toContain("WARNING");
    expect(covered.ok).toBe(true);
    expect(c.sent).toEqual([]);
    // a missed stamp no later relay covers (the only relayed one is older) still fails the run
    const m = world();
    const dir3 = tempDir("stamp-missed");
    await stackFile(dir3, "bittensor", [{ asOf: now - D - 10n * H, relayed: true }, { asOf: now - D - 2n * H }, { asOf: now + 3n * D }]);
    const missed = await run(m, dir3, { mode: "relayDue", targets: ["vault"] });
    expect(missed.lines).toContain(`  WARNING — Bittensor vault: the stamp as of ${iso(now - D - 2n * H)} was not relayed in its window.`);
    expect(missed.ok).toBe(false);
    expect(missed.lines.at(-1)).toBe("This run fails: see the lines above.");
  });

  it("a stack keeps what is signed: a new --stack adds its times and never drops a signed stamp that can still be relayed", async () => {
    const w = world();
    const dir = tempDir("stamp-restack");
    const now = w.heads.bittensor;
    await stackFile(dir, "bittensor", [{ asOf: now - 2n * D }, { asOf: now + 5n * D }, { asOf: now + 6n * D, signed: false }]);
    await run(w, dir, { mode: "stack", targets: ["vault"], days: 2, everyHours: 12 });
    const s = readStack(dir, "bittensor");
    // the expired one goes, the signed future one stays, the unsigned old time is replaced by the new times
    expect(s.stamps.map((x) => [BigInt(x.asOf), x.sig !== null])).toEqual([
      [now, false],
      [now + 12n * H, false],
      [now + D, false],
      [now + D + 12n * H, false],
      [now + 5n * D, true],
    ]);
    // and the earliest a founder item survives is after the signed one, the latest in the file
    expect(stackAsOfs(now, 2, 12)).toEqual([now, now + 12n * H, now + D, now + D + 12n * H]);
    expect(() => stackAsOfs(now, 0)).toThrow(/--stack takes 1 to 30 days/);
    expect(() => stackAsOfs(now, 31)).toThrow(/--stack takes 1 to 30 days/);
    expect(() => stackAsOfs(now, 2, 5)).toThrow("--every takes 1, 2, 3, 4, 6, 8 or 12 hours (24 only with --accept-gap-risk), not 5");
  });

  it("stamps more than 12 hours apart only with --accept-gap-risk, which prints the risk; the bounds checked before anything is read", async () => {
    const now = HEAD;
    expect(() => stackAsOfs(now, 1, 24)).toThrow(`--every 24 is more than 12 hours: ${GAP_RISK}. To accept that, add --accept-gap-risk "<why>"`);
    expect(GAP_RISK).toBe("stamps more than 12 hours apart can leave a thief's item a race against its last stamp");
    expect(stackAsOfs(now, 2, 24, "fewer Ledger signatures on testnet")).toEqual([now, now + D]);
    expect(() => stackAsOfs(now, 2, 12, "no reason")).toThrow("--accept-gap-risk is only for --every above 12 hours: --every 12 has no gap to accept");
    // refused before anything is read
    const w = world();
    const dir = tempDir("stamp-gap");
    expect((await failure(run(w, dir, { mode: "stack", targets: ["vault"], days: 2, everyHours: 24 }))).message).toMatch(/--every 24 is more than 12 hours/);
    expect((await failure(run(w, dir, { mode: "stack", targets: ["vault"], days: 31 }))).message).toBe("--stack takes 1 to 30 days, not 31; nothing read or written");
    expect(w.calls).toEqual([]);
    // accepted: written a day apart, and the risk printed with the reason
    const r = await run(w, dir, { mode: "stack", targets: ["vault"], days: 2, everyHours: 24, acceptGapRisk: "fewer Ledger signatures on testnet" });
    expect(readStack(dir, "bittensor").stamps.map((x) => BigInt(x.asOf))).toEqual([now, now + D]);
    expect(r.lines).toContain(`  WARNING — a stamp every 24 hours: ${GAP_RISK}. Accepted: fewer Ledger signatures on testnet.`);
  });

  it("--stack for both chains writes neither while either chain's old stack is refused (ruling M4)", async () => {
    const w = world();
    const dir = tempDir("stamp-both");
    await stackFile(dir, "base", [{ asOf: w.heads.base + D }]);
    const s = readStack(dir, "base");
    writeFileSync(join(dir, "base.json"), JSON.stringify({ ...s, deployment: "v3.2-other" }));
    const e = await failure(run(w, dir, { mode: "stack", days: 1 }));
    expect(e.message).toBe(
      `${join(dir, "base.json")} is for contract ${plan.addresses.frontDoor} on chain 8453 of v3.2-other (live), not this deployment's front door ${plan.addresses.frontDoor} on chain 8453 of v3.2-launch (live): move it away first; nothing written`,
    );
    expect(existsSync(join(dir, "bittensor.json"))).toBe(false);
  });

  it("--to-stack asks the contract by eth_call: BadStamp, a signature over another hash than its own, is refused (ruling M6)", async () => {
    const w = world();
    const dir = tempDir("stamp-tostack");
    const head = w.heads.bittensor;
    await stackFile(dir, "bittensor", [{ asOf: head + D, signed: false }]);
    const sig = await ownerSig("vault", head + D);
    // the contract's own DOMAIN_SEPARATOR made with another chain id: ops's hash is not the one it checks
    w.contractChainId.bittensor = 965;
    expect((await failure(run(w, dir, { mode: "toStack", targets: ["vault"], asOf: head + D, sig }))).message).toBe(
      `the vault (Bittensor) answers BadStamp() to this signature by eth_call: it is not over the contract's own hash, so it would never stamp; nothing added`,
    );
    w.contractChainId = {};
    w.callFails = true;
    expect((await failure(run(w, dir, { mode: "toStack", targets: ["vault"], asOf: head + D, sig }))).message).toMatch(
      /^Couldn't check stampBySig\(\d+\) on the vault \(Bittensor\) right now \(the RPC did not run it: upstream request timeout\); try again; nothing added$/,
    );
    w.callFails = false;
    expect(readStack(dir, "bittensor").stamps[0].sig).toBeNull();
    // a good one answers StampOutOfWindow (it is for later), and is added
    expect((await run(w, dir, { mode: "toStack", targets: ["vault"], asOf: head + D, sig })).ok).toBe(true);
    expect(readStack(dir, "bittensor").stamps[0].sig).toBe(sig);
    expect(w.sent).toEqual([]);
  });

  it("writes the stamps for the sign page, which has the owner's Ledger sign them (ruling C3: Task 49 wires the page)", async () => {
    const w = world();
    const dir = tempDir("stamp-page");
    const walletDir = join(dir, "wallet");
    const now = 1_800_000_000_000;
    // what the owner signs now, as of each chain's head: relayed at once once signed
    const r = await run(w, dir, { mode: "prepare", walletDir, now });
    const path = join(walletDir, `v3.2-launch-stamp-${HEAD}.json`);
    const f = parseWalletFile(JSON.parse(readFileSync(path, "utf8")));
    expect(f).toEqual({
      format: "cascade-wallet-calls",
      version: 1,
      title: "Cascade v3.2-launch: the owner's stamps as of each chain's head, to relay at once",
      createdAt: now,
      deployment: "v3.2-launch",
      ordered: false,
      calls: [],
      stamps: [
        { chainId: 964, contract: plan.addresses.vault, asOf: HEAD.toString(), from: plan.roles.owner, mode: "relay", label: `the owner's stamp as of ${HEAD} on the vault (Bittensor)` },
        { chainId: 8_453, contract: plan.addresses.frontDoor, asOf: (HEAD + 5n).toString(), from: plan.roles.owner, mode: "relay", label: `the owner's stamp as of ${HEAD + 5n} on the front door (Base)` },
      ],
    });
    expect(r.lines).toContain(`Wrote ${path} (2 stamps): have the owner's Ledger sign them on the sign page, which relays each at once from the relayer: pnpm ops sign ${path}`);
    expect(r.files).toContain(path);
    // a stack's stamps, to add to the stack as each is signed
    const s = await run(w, dir, { mode: "stack", days: 1, walletDir, now });
    const stackPath = join(walletDir, `v3.2-launch-stack-${HEAD}.json`);
    const g = parseWalletFile(JSON.parse(readFileSync(stackPath, "utf8")));
    expect(g.stamps?.map((x) => [x.chainId, BigInt(x.asOf), x.mode])).toEqual([
      [964, HEAD, "stack"],
      [964, HEAD + 12n * H, "stack"],
      [8_453, HEAD + 5n, "stack"],
      [8_453, HEAD + 5n + 12n * H, "stack"],
    ]);
    expect(g.title).toBe("Cascade v3.2-launch: the stack's 4 stamps to sign");
    expect(s.lines).toContain(`Wrote ${stackPath} (4 stamps): have the owner's Ledger sign them on the sign page, which adds each to its stack: pnpm ops sign ${stackPath}`);
    // without a wallet folder (the library as Task 48 left it), no file for the page
    const plain = tempDir("stamp-plain");
    expect((await run(w, plain, { mode: "prepare" })).files).toHaveLength(2);
    // nor for a rehearsal (the forks): the page signs only on Base and Bittensor EVM
    const forks = targets({}).rehearsal;
    w.domain = { bittensor: domainSeparatorV32(forks.bittensor.chainId, plan.addresses.vault), base: domainSeparatorV32(forks.base.chainId, plan.addresses.frontDoor) };
    const rehearsal = tempDir("stamp-rehearsal");
    const rh = await stampCommand(ctxOf(w), { ...record(), target: "rehearsal" }, opts(rehearsal, { mode: "prepare", walletDir: join(rehearsal, "wallet"), now }));
    expect(rh.files).toHaveLength(2);
    expect(existsSync(join(rehearsal, "wallet"))).toBe(false);
    expect(w.sent).toEqual([]);
  });

  it("the sign page's hand-off: a relay goes through relayStamp's refusals, a stack stamp only writes its stack (Task 49's review, M3)", async () => {
    const env = { OPS_RELAYER_KEYSTORE: RELAYER_KEY.keystore, OPS_RELAYER_PASSWORD_FILE: RELAYER_KEY.passwordFile };
    const w = world();
    const dir = tempDir("stamp-handoff");
    const h = signPageStamps(ctxOf(w), env, { dir, name: "v3.2-launch", buildsDir });
    expect(h.dir).toBe(dir);
    // the relayer's key named before the page is served, for a relay; a stack needs none
    await h.ready("relay");
    const unnamed = signPageStamps(ctxOf(w), {}, { dir, name: "v3.2-launch", buildsDir });
    await expect(unnamed.ready("relay")).rejects.toThrow(/^the relayer's key is not named:/);
    await unnamed.ready("stack");
    const raw = () => w.calls.filter((c) => c.method === "eth_sendRawTransaction");
    // a relayer whose keystore opens as the owner: relayStamp refuses it, and nothing is sent
    const asOf = w.heads.bittensor;
    const sig = await ownerSig("vault", asOf);
    w.keystores.set(RELAYER_KEY.keystore, { address: plan.roles.owner });
    expect((await failure(h.submit(record(), { target: "vault", asOf, sig, mode: "relay" }))).message).toBe(
      `the relayer ${plan.roles.owner} is the owner, an account of the Ledger: a copied seed would sweep its gas too. Relay from a fresh key of its own (cast wallet new); nothing sent`,
    );
    expect(raw()).toEqual([]);
    // a fresh relayer: relayed, from it
    w.keystores.set(RELAYER_KEY.keystore, { address: RELAYER.address, key: RELAYER_PK });
    const r = await h.submit(record(), { target: "vault", asOf, sig, mode: "relay" });
    expect(r.ok).toBe(true);
    expect(w.sent.map((x) => [x.from, x.asOf])).toEqual([[RELAYER.address, asOf]]);
    // a stack stamp: added to its stack, nothing sent, no relayer opened
    const later = w.heads.base + D;
    await stackFile(dir, "base", [{ asOf: later, signed: false }]);
    const keyRuns = () => w.calls.length;
    const before = keyRuns();
    const s = await signPageStamps(ctxOf(w), {}, { dir, name: "v3.2-launch", buildsDir }).submit(record(), { target: "frontDoor", asOf: later, sig: await ownerSig("frontDoor", later), mode: "stack" });
    expect(s.ok).toBe(true);
    expect(readStack(dir, "base").stamps[0].sig).toBe(await ownerSig("frontDoor", later));
    expect(raw()).toHaveLength(1);
    expect(w.calls.slice(before).map((c) => c.method)).not.toContain("eth_sendRawTransaction");
  });

  it("pnpm ops stamp for one contract needs only its chain (Task 49's review, M7)", async () => {
    const w = world();
    const c = ctxOf(w);
    const down: Ctx = { ...c, rpc: { request: (chain, method, params) => (chain === "base" ? Promise.reject(new RpcError("connect ECONNREFUSED", -32603)) : c.rpc.request(chain, method, params)) } };
    const dir = tempDir("stamp-one-chain");
    const r = await stampCommand(down, record(), opts(dir, { mode: "prepare", targets: ["vault"], walletDir: join(dir, "wallet"), now: 1_800_000_000_000 }));
    expect(r.ok).toBe(true);
    expect(r.lines[0]).toMatch(/^Bittensor vault 0x[0-9a-fA-F]{40} \(chain 964\): the owner's stamp as of/);
    expect((await stampCommand(down, record(), opts(dir, { mode: "stack", targets: ["vault"], days: 1 }))).ok).toBe(true);
    // both contracts need both chains
    expect((await failure(stampCommand(down, record(), opts(dir, { mode: "prepare" })))).message).toMatch(/^Couldn't read Base's chain id right now \(connect ECONNREFUSED\)/);
  });

  it("the stack's lock names a stamp run, not a keeper (ruling M7)", async () => {
    const w = world();
    const dir = tempDir("stamp-lock");
    writeFileSync(join(dir, "stamps.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const e = await failure(run(w, dir, { mode: "relayDue", targets: ["vault"] }));
    expect(e.message).toBe(
      `another stamp run (PID ${process.pid}) is already running for this deployment: it holds ${join(dir, "stamps.lock")}; never run two stamp runs at once. If no stamp run is running (Windows reused that PID), delete ${join(dir, "stamps.lock")}; nothing started`,
    );
  });

  it("refuses to ask for a signature over another hash than the contract's: the lens's DOMAIN_SEPARATOR is checked first", async () => {
    const w = world();
    w.domain.bittensor = `0x${"0d".repeat(32)}`;
    const dir = tempDir("stamp-domain");
    const e = await failure(run(w, dir, { mode: "prepare", targets: ["vault"] }));
    expect(e.message).toBe(
      `the vault (Bittensor)'s DOMAIN_SEPARATOR is 0x${"0d".repeat(32)}, not ${domainSeparatorV32(964, plan.addresses.vault)}, the one ops computes for chain 964 and ${plan.addresses.vault}: a stamp signed for it would be over the wrong hash; nothing to sign`,
    );
    expect(await failure(run(w, dir, { mode: "stack", targets: ["vault"], days: 1 }))).toMatchObject({ message: e.message });
    expect(existsSync(join(dir, "bittensor.json"))).toBe(false);
    expect(existsSync(join(dir, "sign")) ? readdirSync(join(dir, "sign")) : []).toEqual([]);
  });

  it("parses pnpm ops stamp, and keeps the stack out of git", () => {
    expect(parseArgs(["stamp"])).toMatchObject({ cmd: "stamp", target: "both", live: false });
    expect(parseArgs(["stamp", "vault", "--as-of", "1900000000", "--sig", `0x${"ab".repeat(65)}`, "--tip", "50", "--live"])).toMatchObject({
      cmd: "stamp",
      target: "vault",
      asOf: "1900000000",
      sig: `0x${"ab".repeat(65)}`,
      tip: "50",
      live: true,
    });
    expect(parseArgs(["stamp", "front-door", "--as-of", "1", "--sig", "0x12", "--to-stack"])).toMatchObject({ target: "front-door", toStack: true });
    expect(parseArgs(["stamp", "--stack", "7", "--every", "12"])).toMatchObject({ stack: "7", every: "12", target: "both" });
    expect(parseArgs(["stamp", "--relay-due", "--tip", "5", "--live"])).toMatchObject({ relayDue: true, tip: "5", target: "both" });
    const refused = (argv: string[], why: RegExp) => {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(UsageError);
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(why);
    };
    refused(["stamp", "--sig", "0x12"], /--sig needs --as-of/);
    refused(["stamp", "--as-of", "1"], /--as-of goes with --sig/);
    refused(["stamp", "--as-of", "1", "--sig", "0x12"], /--sig is for one contract: stamp vault or stamp front-door/);
    refused(["stamp", "vault", "--as-of", "soon", "--sig", "0x12"], /--as-of soon is not a time in seconds/);
    refused(["stamp", "vault", "--as-of", (1n << 64n).toString(), "--sig", "0x12"], /is not a time in seconds/);
    refused(["stamp", "vault", "--as-of", "1", "--sig", "12"], /--sig 12 is not a signature in hex/);
    refused(["stamp", "--to-stack"], /--to-stack goes with --sig/);
    refused(["stamp", "--stack", "seven"], /--stack seven is not a number of days/);
    refused(["stamp", "--every", "12"], /--every goes with --stack/);
    refused(["stamp", "--stack", "3", "--relay-due"], /--stack, --relay-due and --sig are three different runs: give one/);
    refused(["stamp", "--tip", "5"], /--tip goes with --sig or --relay-due/);
    refused(["stamp", "--relay-due", "--tip", "0"], /--tip 0 is not a tip in whole gwei from 1 to 1000/);
    refused(["stamp", "--relay-due", "--tip", "1001"], /--tip 1001 is not a tip in whole gwei from 1 to 1000/);
    refused(["stamp", "--relay-due", "--tip", "1.5"], /--tip 1.5 is not a tip in whole gwei/);
    refused(["pause", "--stack", "3"], /unexpected argument --stack/);
    // the stack's bounds, before anything is read (ruling I1)
    refused(["stamp", "--stack", "0"], /--stack takes 1 to 30 days, not 0/);
    refused(["stamp", "--stack", "31"], /--stack takes 1 to 30 days, not 31/);
    refused(["stamp", "--stack", "3", "--every", "5"], /--every takes 1, 2, 3, 4, 6, 8 or 12 hours \(24 only with --accept-gap-risk\), not 5/);
    refused(["stamp", "--stack", "3", "--every", "13"], /not 13/);
    refused(["stamp", "--stack", "3", "--every", "24"], /--every 24 is more than 12 hours: stamps more than 12 hours apart can leave a thief's item a race against its last stamp\. To accept that, add --accept-gap-risk/);
    refused(["stamp", "--stack", "3", "--every", "12", "--accept-gap-risk", "why"], /--accept-gap-risk is only for --every above 12 hours/);
    refused(["stamp", "--accept-gap-risk", "why"], /--accept-gap-risk goes with --stack and --every/);
    expect(parseArgs(["stamp", "--stack", "3", "--every", "24", "--accept-gap-risk", "testnet only"])).toMatchObject({ stack: "3", every: "24", acceptGapRisk: "testnet only" });
    // ops/stamps/ is git-ignored: the stack stays on the relayer's machine
    expect(readFileSync(new URL("../.gitignore", import.meta.url), "utf8").split(/\r?\n/)).toContain("stamps/");
  });
});

const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString().replace(".000Z", "Z");
