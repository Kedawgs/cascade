import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import {
  toFunctionSignature,
  type Abi,
  type AbiEvent,
  type AbiFunction,
  type Address,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
  type Hex,
  hashTypedData,
  hexToNumber,
  keccak256,
  numberToHex,
  parseAbi,
  stringToBytes,
  toFunctionSelector,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { type ChainName, PRECOMPILE, paths, targets } from "../src/config.ts";
import { ReceiptTimeout, RevertedOnChain } from "../src/send.ts";
import { type Rpc, RpcError } from "../src/rpc.ts";
import { prepareSign, servePage } from "../src/sign.ts";
import { type BuildRefV32, type BuildV32, buildErrorsV32, freezeBuildV32, type SourceV32, writeBuildV32 } from "../src/v32/build.ts";
import { domainSeparatorV32 } from "../src/v32/code.ts";
import type { DeploymentRecordV32 } from "../src/v32/deploy.ts";
import { addressMapping, buildPlanV32, type PlanV32, plannedAddressesV32 } from "../src/v32/plan.ts";
import { SCHEDULER_ABI } from "../src/v32/scheduler.ts";
import { SETTINGS_V32_LAUNCH, SINGLE_KEY_RESIDUAL } from "../src/v32/settings.ts";
import { RAIL_RESIDUAL } from "../src/v32/rails.ts";
import type { SignV32Deps } from "../src/v32/sign.ts";
import { type StampStack, stampHashes, stampTypedDataJson } from "../src/v32/stamp.ts";
import { STAMP_TYPEHASH_V32 } from "../src/v32/verify.ts";
import { KNOWN_ABI, type NewWalletCall, type StampRequest, walletFile } from "../src/wallet.ts";
import { TAO_BOT, YUMA } from "./v32-fixtures.ts";

// Task 49: the sign page for v3.2's scheduler, its direct owner and guardian calls, and the owner's stamp (spec §3.6,
// §5). The page is the last thing the founder sees before the Ledger signs, maybe blind: what it shows must be what is
// signed, a dead or unknown item must never execute, a loosening or an owner's door removal or caps above the founder
// level must be said (never refused), and a stamp must be for the right chain and contract. Two fake chains answer the
// vault, the front door, their lenses and the Bittensor adapter with the frozen build's own ABIs; a fake MetaMask runs
// the page's own script, and signs a stamp with the contracts' public fixture key (makeAddrAndKey("owner")), never a
// real one. Nothing leaves the process: no key, network, keystore, .env or forge.

const CONTRACTS = paths({}).contractsDir;
const SOURCE: SourceV32 = { commit: "c0ffee".padEnd(40, "0"), tree: "7ee".padEnd(40, "0"), dirty: [] };
const LIVE = targets({}).live;
const E18 = 10n ** 18n;
/** Each chain's lane settings every Cascade adapter there shares (R4, C-L4: the rail checks hold a new pair's to the
 * deploy's): its router, token and remote selector, and on Bittensor its AlphaVault */
const LANE_BIT = { router: getAddress(`0x${"c1".repeat(20)}`), remoteSelector: 15_971_525_489_660_198_786n, alphaVault: getAddress(`0x${"c3".repeat(20)}`) };
const LANE_BASE = { router: getAddress(`0x${"c4".repeat(20)}`), token: getAddress(`0x${"c5".repeat(20)}`), remoteSelector: 2_135_107_236_357_186_872n };
const RAO = 10n ** 9n;
const H = 3_600;
const D = 86_400;
const DELAYS = [48 * H, 7 * D, 8 * D] as const; // Param, Registry, Guardian
const WINDOW = 7 * D;
const HEAD_TIME = 1_900_000_000;
const SPB: Record<ChainName, number> = { bittensor: 12, base: 2 };
const CREATED: Record<ChainName, number> = { bittensor: 1_000_000, base: 10_000_000 };
/** 2027-01-15T08:00:00.000Z, the files' time */
const NOW = 1_800_000_000_000;
/** The contracts' public fixture key, makeAddrAndKey("owner") (StampVector.sol's): the owner here, so a test signs as it. */
const OWNER_KEY: Hex = "0x02016836a56b71f0d02689e69e326f4f4c1b9057164ef592671cf0d37c8040c0";
const OWNER = privateKeyToAccount(OWNER_KEY);
const SOMEONE_KEY = keccak256(toHex("cascade v3.2 ops test, not the owner"));
const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);
const GUARDIAN = at("b0b1");
const other = getAddress(`0x${"5e".repeat(20)}`);
const another = getAddress(`0x${"6f".repeat(20)}`);
const SAFE = getAddress(`0x${"5a".repeat(20)}`);
const iso = (t: number | bigint) => new Date(Number(t) * 1000).toISOString().replace(".000Z", "Z");
const sameText = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

let build: BuildV32;
let plan: PlanV32;
let buildsDir: string;
let ref: BuildRefV32;

beforeAll(async () => {
  build = (await freezeBuildV32(CONTRACTS, SOURCE)).build;
  const deployers = { base: getAddress(`0x${"d1".repeat(20)}`), bittensor: getAddress(`0x${"d2".repeat(20)}`) };
  plan = buildPlanV32({
    deployers,
    roles: { owner: OWNER.address, guardian: GUARDIAN, keeper: at("c0c1"), treasury: SETTINGS_V32_LAUNCH.treasury },
    validators: { primary: TAO_BOT, standby: YUMA },
    vaultColdkey: addressMapping(plannedAddressesV32(deployers).vault),
    poolFloors: [10n ** 20n, 10n ** 17n],
    claimGasRequired: 55_000_000n,
  });
  buildsDir = mkdtempSync(join(tmpdir(), "ops-v32-signpage-builds-"));
  const text = `${JSON.stringify(build, null, 2)}\n`;
  ref = writeBuildV32(buildsDir, { text, hash: keccak256(stringToBytes(text)) });
});

type Contract = "vault" | "frontDoor";
const CHAIN: Record<Contract, ChainName> = { vault: "bittensor", frontDoor: "base" };
const CHAIN_ID: Record<Contract, number> = { vault: 964, frontDoor: 8_453 };
const abiOf = (c: Contract): Abi => (c === "vault" ? build.vaultAbi : build.contracts.CascadeFrontDoor.abi);

function record(buildRef: BuildRefV32 = ref): DeploymentRecordV32 {
  const sent = (block: number, address: Address) => ({ hash: `0x${"ab".repeat(32)}` as Hex, block, gasUsed: 1n, costWei: 1n, address });
  return {
    target: "live",
    createdAt: "2026-11-07T00:00:00.000Z",
    plan,
    build: buildRef,
    done: { vault: sent(CREATED.bittensor, plan.addresses.vault), frontDoor: sent(CREATED.base, plan.addresses.frontDoor), bitAdapter: sent(CREATED.bittensor, plan.addresses.bitAdapter) },
  };
}

// ---- the fake chains ----

interface Item {
  scheduledAt: bigint;
  readyAt: bigint;
  class: number;
  kind: number;
  selector: Hex;
  readyBlock: bigint;
}
const EMPTY_ITEM: Item = { scheduledAt: 0n, readyAt: 0n, class: 0, kind: 0, selector: "0x00000000", readyBlock: 0n };
interface Batch {
  sourceChain: bigint;
  frontDoor: Address;
  batchId: bigint;
  queuedAt: bigint;
  cursor: number;
  count: number;
  chunk: number;
  remaining: bigint;
  payoutsHash: Hex;
}
const EMPTY_BATCH: Batch = { sourceChain: 0n, frontDoor: at("0"), batchId: 0n, queuedAt: 0n, cursor: 0, count: 0, chunk: 0, remaining: 0n, payoutsHash: `0x${"00".repeat(32)}` };
interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  logIndex: Hex;
  transactionHash: Hex;
}
type Answer = unknown;
interface World {
  heads: Record<ChainName, number>;
  logs: Record<ChainName, RawLog[]>;
  items: Record<Contract, Map<string, Item>>;
  clocks: Record<Contract, { owner: bigint; guardian: bigint }>;
  book: Record<string, { chain: ChainName; abi: Abi; answers: Record<string, Answer> }>;
  codes: Record<string, Hex>;
  batches: Map<string, Batch>;
  parks: Map<string, [bigint, bigint, boolean]>;
  logsFail?: ChainName;
  /** every request to this chain's RPC fails (its node is down) */
  down?: ChainName;
  /** the chain id this chain's RPC answers, when it isn't the live one (a stale fork with the same addresses) */
  chainIds?: Partial<Record<ChainName, number>>;
  calls: { chain: ChainName; method: string; to?: string; data?: Hex }[];
}

const timeOf = (w: World, chain: ChainName, n: number) => HEAD_TIME - SPB[chain] * (w.heads[chain] - n);
const blockAt = (w: World, chain: ChainName, t: number) => w.heads[chain] - Math.ceil((HEAD_TIME - t) / SPB[chain]);
const revert = (name: string, args: unknown[] = []) => new RpcError("execution reverted", 3, encodeErrorResult({ abi: buildErrorsV32(build), errorName: name, args } as never));
const peerOf = (chain: bigint, door: Address) => keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }], [chain, door]));

/** A deployment on the two chains, nothing scheduled, nothing queued or parked, the owner a plain account. */
function world(): World {
  const a = plan.addresses;
  const r = plan.roles;
  const w: World = {
    heads: { bittensor: 3_000_000, base: 30_000_000 },
    logs: { bittensor: [], base: [] },
    items: { vault: new Map(), frontDoor: new Map() },
    clocks: { vault: { owner: 0n, guardian: 0n }, frontDoor: { owner: 0n, guardian: 0n } },
    book: {},
    codes: {},
    batches: new Map(),
    parks: new Map(),
    calls: [],
  };
  const ownerOrGuardian = (from?: string) => (sameText(from, r.owner) || sameText(from, r.guardian) ? undefined : revert("NotGuardian"));
  const lensAnswers = (c: Contract): Record<string, Answer> => ({
    guardian: r.guardian,
    scheduled: (args: readonly unknown[]) => w.items[c].get(String(args[0]).toLowerCase()) ?? EMPTY_ITEM,
    lastOwnerClose: () => w.clocks[c].owner,
    lastGuardianClose: () => w.clocks[c].guardian,
    PARAM_DELAY: BigInt(DELAYS[0]),
    REGISTRY_DELAY: BigInt(DELAYS[1]),
    GUARDIAN_DELAY: BigInt(DELAYS[2]),
    EXECUTE_WINDOW: BigInt(WINDOW),
    MS_PER_BLOCK: c === "vault" ? 7_200n : 120n,
    bridgeKnown: (args: readonly unknown[]) => sameText(args[0], c === "vault" ? a.bitAdapter : a.baseAdapter) || sameText(args[0], another),
    DOMAIN_SEPARATOR: domainSeparatorV32(CHAIN_ID[c], a[c]),
    STAMP_TYPEHASH: STAMP_TYPEHASH_V32,
    primaryBridge: c === "vault" ? a.bitAdapter : a.baseAdapter,
    bridgeEnabled: (args: readonly unknown[]) => sameText(args[0], c === "vault" ? a.bitAdapter : a.baseAdapter),
  });
  const lower = (m: World["book"]) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k.toLowerCase(), v]));
  const launchDoor = peerOf(8_453n, a.frontDoor);
  w.book = lower({
    [a.vault]: {
      chain: "bittensor",
      abi: build.vaultAbi,
      answers: {
        owner: r.owner,
        pendingOwner: at("0"),
        launchChain: 8_453n,
        MS_PER_BLOCK: 7_200n,
        removeFrontDoor: (args: readonly unknown[], from?: string) => ownerOrGuardian(from) ?? (sameText(peerOf(args[0] as bigint, args[1] as Address), launchDoor) ? undefined : revert("PeerNotActive")),
      },
    },
    [a.vaultLens]: {
      chain: "bittensor",
      abi: build.contracts.CascadeVaultLens.abi,
      answers: {
        ...lensAnswers("vault"),
        peerId: (args: readonly unknown[]) => peerOf(args[0] as bigint, args[1] as Address),
        doorState: (args: readonly unknown[]) => (sameText(args[0], launchDoor) ? 1 : 0),
        activeDoors: (args: readonly unknown[]) => (args[0] === 8_453n ? 1n : 0n),
        maxTotalAssets: 40n * E18,
        maxDailyOutflowBps: 2_000n,
        minDailyOutflow: 10n * E18,
        globalOutflowBps: 3_000n,
        stakeHotkey: TAO_BOT,
        bookedStake: 1_000n * RAO,
        coldkey: plan.vaultColdkey,
        getPayoutBatch: (args: readonly unknown[]) => w.batches.get(String(args[0]).toLowerCase()) ?? EMPTY_BATCH,
        pendingPayouts: () => [...w.batches.values()].reduce((s, b) => s + b.remaining, 0n),
      },
    },
    [PRECOMPILE.staking]: {
      chain: "bittensor",
      abi: parseAbi(["function getStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid) view returns (uint256)"]),
      answers: { getStake: () => 0n },
    },
    [a.bitAdapter]: {
      chain: "bittensor",
      abi: build.contracts.CcipBittensorAdapter.abi,
      answers: {
        remoteChainId: 8_453n,
        remoteAdapter: a.baseAdapter,
        token: getAddress(`0x${"c2".repeat(20)}`),
        ...LANE_BIT,
        parkedNative: () => [...w.parks.values()].filter((k) => k[2]).reduce((s, k) => s + k[0], 0n),
        parkedTokens: () => [...w.parks.values()].filter((k) => !k[2]).reduce((s, k) => s + k[0], 0n),
        parked: (args: readonly unknown[]) => w.parks.get(String(args[0]).toLowerCase()) ?? [0n, 0n, false],
      },
    },
    [a.frontDoor]: {
      chain: "base",
      abi: abiOf("frontDoor"),
      answers: {
        owner: r.owner,
        pendingOwner: at("0"),
        MS_PER_BLOCK: 120n,
        paused: true,
        // an open batch with nothing in it, started two hours ago: id, start, totalDeposits, feePot, nDeposits, nRedeems
        openBatch: () => [7n, BigInt(HEAD_TIME - 2 * H), 0n, 0n, 0n, 0n],
        depositCap: 40n * E18,
        minDeposit: E18 / 100n,
        vaultChain: 964n,
      },
    },
    [a.doorLens]: { chain: "base", abi: build.contracts.CascadeDoorLens.abi, answers: lensAnswers("frontDoor") },
    [a.baseAdapter]: { chain: "base", abi: build.contracts.CcipBaseAdapter.abi, answers: { remoteChainId: 964n, remoteAdapter: a.bitAdapter, ...LANE_BASE } },
  });
  // the vault's constructor enables its first bridge in its creation block: what proves a log server keeps its history
  emit(w, "bittensor", a.vault, build.vaultAbi, "BridgeActivated", { bridge: a.bitAdapter }, CREATED.bittensor);
  return w;
}

function rpcOf(w: World): Rpc {
  return {
    async request(chain, method, params) {
      w.calls.push({ chain, method, ...(method === "eth_call" ? { to: (params[0] as { to: string }).to, data: (params[0] as { data: Hex }).data } : {}) });
      if (w.down === chain) throw new RpcError("connect ECONNREFUSED", -32603);
      if (method === "eth_chainId") return numberToHex(w.chainIds?.[chain] ?? LIVE[chain].chainId);
      if (method === "eth_blockNumber") return numberToHex(w.heads[chain]);
      if (method === "eth_getCode") return w.codes[String(params[0]).toLowerCase()] ?? "0x";
      if (method === "eth_getBlockByNumber") {
        const n = params[0] === "latest" ? w.heads[chain] : hexToNumber(params[0] as Hex);
        if (n > w.heads[chain] || n < 0) return null;
        return { number: numberToHex(n), timestamp: numberToHex(timeOf(w, chain, n)) };
      }
      if (method === "eth_getLogs") {
        if (w.logsFail === chain) throw new RpcError("query timeout exceeded", -32005);
        const [f] = params as [{ address: string; fromBlock: Hex; toBlock: Hex; topics: (Hex | Hex[] | null)[] }];
        const t0 = ([] as Hex[]).concat(f.topics[0] ?? []).map((t) => t.toLowerCase());
        const t1 = f.topics[1];
        return w.logs[chain].filter(
          (l) =>
            sameText(l.address, f.address) &&
            hexToNumber(l.blockNumber) >= hexToNumber(f.fromBlock) &&
            hexToNumber(l.blockNumber) <= hexToNumber(f.toBlock) &&
            t0.includes(l.topics[0].toLowerCase()) &&
            (t1 === undefined || t1 === null || ([] as Hex[]).concat(t1).some((t) => sameText(t, l.topics[1]))),
        );
      }
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      const [{ to, data, from }] = params as [{ to: string; data: Hex; from?: string }];
      const c = w.book[to.toLowerCase()];
      if (!c || c.chain !== chain) throw new Error(`no contract at ${to} on ${chain}`);
      const { functionName, args } = decodeFunctionData({ abi: c.abi, data });
      if (!(functionName in c.answers)) throw new Error(`unexpected ${functionName} on ${to}`);
      let v = c.answers[functionName];
      if (typeof v === "function") v = (v as (a: readonly unknown[], f?: string) => unknown)(args ?? [], from);
      if (v instanceof Error) throw v;
      const f = c.abi.find((x): x is AbiFunction => x.type === "function" && x.name === functionName)!;
      if (!f.outputs.length) return "0x";
      return encodeFunctionResult({ abi: c.abi, functionName, result: v } as never);
    },
  };
}

const ctxOf = (w: World) => ({ rpc: rpcOf(w), targets: LIVE, logsWindow: { bittensor: 200_000n, base: 2_000_000n } });

let logIndex = 0;
function emit(w: World, chain: ChainName, address: Address, abi: Abi, event: string, args: Record<string, unknown>, block: number): void {
  const ev = abi.find((x): x is AbiEvent => x.type === "event" && x.name === event)!;
  const indexed = Object.fromEntries(ev.inputs.filter((i) => i.indexed).map((i) => [i.name!, args[i.name!]]));
  const topics = encodeEventTopics({ abi: [ev], eventName: event, args: indexed } as never) as Hex[];
  const plain = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain, plain.map((i) => args[i.name!]) as never);
  logIndex++;
  w.logs[chain].push({ address, topics, data, blockNumber: numberToHex(block), logIndex: numberToHex(logIndex % 50), transactionHash: keccak256(numberToHex(logIndex)) });
}

const CLASS_OF: Record<string, number> = { writeOffMissingStake: 1, activateFrontDoor: 1, activateBridge: 1, setGuardian: 2, transferOwnership: 2 };
const KIND_OF: Record<string, number> = { setGuardian: 1 };

/** `fn(args)` scheduled on `c` at time `at`: its Scheduled log and its item in the lens, as the contract writes them. */
function put(w: World, c: Contract, fn: string, args: readonly unknown[], at: number): { id: Hex; data: Hex } {
  const data = encodeFunctionData({ abi: abiOf(c), functionName: fn, args } as never);
  const id = keccak256(data);
  const cls = CLASS_OF[fn] ?? 0;
  const kind = KIND_OF[fn] ?? 0;
  const delay = DELAYS[cls];
  const chain = CHAIN[c];
  const block = blockAt(w, chain, at);
  const item: Item = { scheduledAt: BigInt(at), readyAt: BigInt(at + delay), class: cls, kind, selector: data.slice(0, 10) as Hex, readyBlock: BigInt(block + Math.ceil(delay / (2 * SPB[chain]))) };
  w.items[c].set(id, item);
  emit(w, chain, plan.addresses[c], abiOf(c), "Scheduled", { id, kind, selector: item.selector, readyAt: item.readyAt, data }, block);
  return { id, data };
}

/** A payout batch of the launch door queued on the vault in block `block`. */
function queue(w: World, key: Hex, remaining: bigint, block: number): void {
  w.batches.set(key.toLowerCase(), { ...EMPTY_BATCH, sourceChain: 8_453n, frontDoor: plan.addresses.frontDoor, batchId: 7n, queuedAt: BigInt(timeOf(w, "bittensor", block)), count: 2, remaining });
  emit(w, "bittensor", plan.addresses.vault, build.vaultAbi, "PayoutBatchQueued", { key, sourceChain: 8_453n, batchId: 7n, count: 2, total: remaining, price: E18 }, block);
}

// ---- the files ----

const tmp = () => mkdtempSync(join(tmpdir(), "ops-v32-signpage-"));
const write = (body: unknown) => {
  const path = join(tmp(), "calls.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
};
const fileOf = (calls: NewWalletCall[]) => walletFile({ title: "Cascade v3.2-launch: a test file", deployment: "v3.2-launch", now: NOW, calls });
const stampFileOf = (stamps: StampRequest[]) => walletFile({ title: "Cascade v3.2-launch: the owner's stamps", deployment: "v3.2-launch", now: NOW, calls: [], stamps });
const sched = (c: Contract, fn: "schedule" | "execute", inner: Hex, from: Address = OWNER.address): NewWalletCall => ({
  chainId: CHAIN_ID[c],
  to: plan.addresses[c],
  data: encodeFunctionData({ abi: SCHEDULER_ABI, functionName: fn, args: [inner] }),
  label: `${fn}(an item) on the ${c}`,
  from,
});
const direct = (c: Contract, fn: string, args: readonly unknown[], from: Address = OWNER.address): NewWalletCall => ({
  chainId: CHAIN_ID[c],
  to: plan.addresses[c],
  data: encodeFunctionData({ abi: KNOWN_ABI, functionName: fn, args } as never),
  label: `${fn}(...) by hand`,
  from,
});
const setter = (c: Contract, fn: string, args: readonly unknown[]) => encodeFunctionData({ abi: abiOf(c), functionName: fn, args } as never);

/** What submitStamp was handed, and the stamp deps that record it. */
function stampSink(answer: { ok: boolean; lines: string[] } | Error = { ok: true, lines: ["Bittensor vault: stamped (transaction 0x77)."] }) {
  const handed: { target: string; asOf: bigint; sig: Hex; mode: string }[] = [];
  const ready: string[] = [];
  const dir = tmp();
  return {
    handed,
    ready,
    dir,
    stamps: {
      dir,
      ready: (mode: "relay" | "stack") => {
        ready.push(mode);
      },
      submit: async (_rec: DeploymentRecordV32, s: { target: string; asOf: bigint; sig: Hex; mode: string }) => {
        handed.push(s);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

/** The relayer's stack for `c` in `dir`, as pnpm ops stamp --stack writes it: its times, unsigned. */
function stackOf(dir: string, c: Contract, asOfs: readonly bigint[], o: Partial<StampStack> = {}): string {
  const chain = CHAIN[c];
  const s: StampStack = {
    version: 1,
    deployment: "v3.2-launch",
    target: "live",
    chain,
    chainId: CHAIN_ID[c],
    contract: plan.addresses[c],
    stamps: asOfs.map((t) => ({ asOf: t.toString(), digest: stampHashes(CHAIN_ID[c], plan.addresses[c], t).digest, sig: null })),
    ...o,
  };
  const path = join(dir, `${chain}.json`);
  writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`);
  return path;
}

const deps = (w: World, o: Partial<SignV32Deps> = {}): SignV32Deps => ({ ctx: ctxOf(w), buildsDir, ...o });
const sign = (w: World, path: string, o: Partial<SignV32Deps> = {}, rec: DeploymentRecordV32 = record()) =>
  prepareSign(path, {
    deployment: "v3.2-launch",
    recordOf: () => rec,
    now: NOW,
    readRoles: async () => {
      throw new Error("no v3-launch read expected");
    },
    v32: deps(w, o),
  });
const failure = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a failure");
};

// ---- the page's own script, against a fake MetaMask and the real server ----

interface WalletOpts {
  accounts: string[];
  chainId: string;
  declineSwitch?: boolean;
  /** MetaMask answers the switch but stays where it was */
  stuck?: boolean;
  /** the key MetaMask signs with (the owner's by default) */
  key?: Hex;
}

function fakeWallet(o: WalletOpts) {
  const s = { connected: false, chainId: o.chainId };
  const requests: { method: string; chainId: string; params?: unknown[] }[] = [];
  const listeners: Record<string, ((x: unknown) => void)[]> = {};
  const eth = {
    isMetaMask: true,
    on: (event: string, f: (x: unknown) => void) => {
      listeners[event] = [...(listeners[event] ?? []), f];
    },
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      requests.push({ method, chainId: s.chainId, ...(params ? { params } : {}) });
      const p = (params ?? []) as { chainId: string }[];
      switch (method) {
        case "eth_accounts":
          return s.connected ? [...o.accounts] : [];
        case "eth_requestAccounts":
          s.connected = true;
          return [...o.accounts];
        case "eth_chainId":
          return s.chainId;
        case "wallet_switchEthereumChain":
          if (o.declineSwitch) throw { code: 4001, message: "User rejected the request." };
          if (!o.stuck) {
            s.chainId = p[0].chainId;
            for (const f of listeners.chainChanged ?? []) f(s.chainId);
          }
          return null;
        case "eth_signTypedData_v4": {
          // MetaMask's own rule: the typed data's chain id must be the network it is on
          const [, json] = params as [string, string];
          const t = JSON.parse(json);
          if (Number(t.domain.chainId) !== Number(BigInt(s.chainId))) {
            throw { code: -32602, message: `Provided chainId "${t.domain.chainId}" must match the active chainId "${Number(BigInt(s.chainId))}"` };
          }
          const digest = hashTypedData({ domain: t.domain, types: { OwnerStamp: t.types.OwnerStamp }, primaryType: "OwnerStamp", message: { asOf: BigInt(t.message.asOf) } });
          return privateKeyToAccount(o.key ?? OWNER_KEY).sign({ hash: digest });
        }
        case "eth_sendTransaction":
          return `0x${"ab".repeat(32)}`;
        case "eth_getTransactionReceipt":
          return { status: "0x1", blockNumber: "0x10" };
        case "eth_getTransactionByHash": {
          const tx = requests.find((r) => r.method === "eth_sendTransaction")?.params?.[0] as Record<string, string>;
          return { from: tx.from, to: tx.to, input: tx.data, value: tx.value, chainId: tx.chainId };
        }
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { eth, requests, of: (method: string) => requests.filter((r) => r.method === method) };
}

class FakeElement {
  textContent = "";
  className = "";
  disabled: boolean;
  private click_?: () => unknown;
  constructor(disabled: boolean) {
    this.disabled = disabled;
  }
  addEventListener(type: string, f: () => unknown) {
    if (type === "click") this.click_ = f;
  }
  async click() {
    if (!this.disabled) await this.click_?.();
  }
}

const settle = async (turns = 40) => {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
};

/** A POST to the page's server as the page makes it, with its origin. */
function post(port: number, path: string, headers: Record<string, string>, body: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { host: `127.0.0.1:${port}`, ...headers }, timeout: 10_000 }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

/** Serves the prepared page, and runs its script with a fake MetaMask whose fetch reaches the server as a browser on the
 * page would (its origin, the headers the page sets). */
async function openPage(p: Awaited<ReturnType<typeof sign>>, wallet: WalletOpts) {
  const server = await servePage(p.page, p.api);
  const script = p.page.html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (!script) throw new Error("no script");
  const els = new Map<string, FakeElement>();
  for (const m of p.page.html.matchAll(/<[a-z0-9]+ [^>]*id="([^"]+)"[^>]*>/g)) els.set(m[1], new FakeElement(/\sdisabled[\s>]/.test(m[0])));
  const w = fakeWallet(wallet);
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const win = {
    ethereum: w.eth,
    addEventListener: (type: string, f: (e: unknown) => void) => {
      listeners[type] = [...(listeners[type] ?? []), f];
    },
    dispatchEvent: (e: { type: string }) => {
      if (e.type === "eip6963:requestProvider") for (const f of listeners["eip6963:announceProvider"] ?? []) f({ detail: { info: { rdns: "io.metamask", name: "MetaMask" }, provider: w.eth } });
      return true;
    },
  };
  const fetches: string[] = [];
  const fetch = async (path: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    fetches.push(path);
    const r = await post(server.port, path, { origin: `http://127.0.0.1:${server.port}`, ...init.headers }, init.body);
    return { ok: r.status === 200, status: r.status, json: async () => JSON.parse(r.body) };
  };
  vm.runInNewContext(script, {
    window: win,
    document: { getElementById: (id: string) => els.get(id) ?? null },
    setTimeout: (f: () => void) => setImmediate(f),
    fetch,
    Event: class {
      readonly type: string;
      constructor(type: string) {
        this.type = type;
      }
    },
  });
  await settle();
  const el = (id: string) => {
    const e = els.get(id);
    if (!e) throw new Error(`no #${id}`);
    return e;
  };
  const click = async (id: string) => {
    await el(id).click();
    await settle(200);
  };
  return { el, w, fetches, click, server, close: () => server.close() };
}

// ---- the tests ----

describe("Task 49: the sign page for v3.2's scheduler", () => {
  it("executeRefusedUnlessItDecodesToALivePendingItem: read from the chain when the page is served", async () => {
    const w = world();
    const t = HEAD_TIME - 3 * D;
    const { id, data } = put(w, "vault", "setMaxTotalAssets", [44n * E18], t);
    const path = write(fileOf([sched("vault", "execute", data)]));
    const scansBefore = w.calls.filter((c) => c.method === "eth_getLogs").length;
    const p = await sign(w, path);
    // the items were read when the page was served
    expect(w.calls.filter((c) => c.method === "eth_getLogs").length).toBeGreaterThan(scansBefore);
    const call = p.view.calls[0];
    expect(call.heading).toBe("execute(setMaxTotalAssets(44000000000000000000)) on the Vault (Bittensor)");
    expect(call.details).toContainEqual({ name: "Item", lines: [id] });
    expect(call.details).toContainEqual({ name: "Now", lines: ["ready now"] });
    expect(p.page.html).toContain("execute(setMaxTotalAssets(44000000000000000000)) on the Vault (Bittensor)");
    // the same file once an owner stamp after its scheduling has killed it: refused, as the chain says when served
    w.clocks.vault.owner = BigInt(t + 1);
    expect((await failure(sign(w, path))).message).toBe(
      `call 1: item ${id} (setMaxTotalAssets(44000000000000000000)) on the vault (Bittensor) is dead: a closure or an owner stamp at ${iso(t + 1)} came after it was scheduled (${iso(t)}), so it can never run`,
    );
    // once it ran or was cancelled: nothing pending under its id
    w.clocks.vault.owner = 0n;
    w.items.vault.delete(id);
    expect((await failure(sign(w, path))).message).toBe(
      `call 1: no item ${id} is pending on the vault (Bittensor) now (it ran, was cancelled, lapsed or was never scheduled): the page executes only a live pending item`,
    );
    // not ready yet
    const soon = put(w, "vault", "setMaxTotalAssets", [43n * E18], HEAD_TIME - H);
    expect((await failure(sign(w, write(fileOf([sched("vault", "execute", soon.data)])))))).toMatchObject({
      message: `call 1: item ${soon.id} (setMaxTotalAssets(43000000000000000000)) on the vault (Bittensor) is not ready: it may run from ${iso(HEAD_TIME - H + 48 * H)}`,
    });
    // an item the lens can't judge (a kind this build doesn't have)
    const odd = put(w, "vault", "setMaxTotalAssets", [42n * E18], t);
    w.items.vault.set(odd.id, { ...w.items.vault.get(odd.id)!, kind: 9 });
    expect((await failure(sign(w, write(fileOf([sched("vault", "execute", odd.data)])))))).toMatchObject({ message: expect.stringMatching(/could not be judged \(the lens reads kind 9/) });
    // calldata that is no setter of the vault: refused, never shown raw
    expect((await failure(sign(w, write(fileOf([sched("vault", "execute", "0xdeadbeef")])))))).toMatchObject({
      message: "call 1: execute(0xdeadbeef) is not a call to a function of the vault (Bittensor): refusing calldata the page can't decode",
    });
    // the items can't be read: refused, to try again; never taken as "not pending"
    w.logsFail = "bittensor";
    expect((await failure(sign(w, write(fileOf([sched("vault", "execute", soon.data)])))))).toMatchObject({
      message: "call 1: the vault (Bittensor)'s scheduled items couldn't be read right now (query timeout exceeded): an item is executed only once it is read pending and alive; try again",
    });
    // the file's sender must be the owner the contract names now
    w.logsFail = undefined;
    const from = await failure(sign(w, write(fileOf([sched("vault", "execute", put(w, "vault", "setMaxTotalAssets", [41n * E18], t).data, GUARDIAN)]))));
    expect(from.message).toBe(
      `call 1: ${GUARDIAN} is not a role in the deployment record nor read from the contract now that may send execute() to the Vault on Bittensor (the owner the Vault names now, ${OWNER.address})`,
    );
  });

  it("a both-chains item shows each chain's copy", async () => {
    const w = world();
    const t = HEAD_TIME - 9 * D;
    const v = put(w, "vault", "transferOwnership", [another], t);
    put(w, "frontDoor", "transferOwnership", [another], HEAD_TIME - D);
    const p = await sign(w, write(fileOf([sched("vault", "execute", v.data)])));
    expect(p.view.calls[0].details).toContainEqual({
      name: "Copies",
      lines: ["the vault (Bittensor): ready now (this call)", `the front door (Base): waiting: ready at ${iso(HEAD_TIME - D + 8 * D)}`],
    });
    expect(p.view.calls[0].details).toContainEqual({
      name: "Then",
      lines: ["The new owner must then accept within 7 days, while the exits stay open and before any closure or owner stamp: run this only once the new owner is ready to accept."],
    });
    // a cancel of one copy while the other is pending says the other still runs
    const c = await sign(w, write(fileOf([{ ...direct("vault", "cancel", [v.id]), label: "cancel(it)" }])));
    expect(c.view.calls[0].callWarnings).toContain(`Item ${v.id} is pending on the front door (Base) too, and this file doesn't cancel that copy: it still runs there.`);
    expect(c.view.calls[0].heading).toBe(`cancel(${v.id}) on the Vault (Bittensor)`);
    expect(c.view.calls[0].effect).toBe(`cancel(${v.id}): drops transferOwnership(${another}) from the Vault's scheduler, so it never runs here`);
    // both cancels in one file: no such warning
    const both = await sign(w, write(fileOf([{ ...direct("vault", "cancel", [v.id]), label: "cancel(it)" }, { ...direct("frontDoor", "cancel", [v.id]), label: "cancel(it)" }])));
    expect(both.view.calls.flatMap((x) => x.callWarnings ?? [])).toEqual([]);
    expect(both.view.calls[0].details).toContainEqual({ name: "Copies", lines: ["the vault (Bittensor): ready now (this call)", `the front door (Base): waiting: ready at ${iso(HEAD_TIME - D + 8 * D)} (call 2 in this file)`] });
    // the other chain can't be read: the id may be pending there too, said
    w.logsFail = "base";
    const blind = await sign(w, write(fileOf([{ ...direct("vault", "cancel", [v.id]), label: "cancel(it)" }])));
    expect(blind.view.calls[0].callWarnings).toEqual([`the front door (Base) couldn't be read right now (query timeout exceeded): item ${v.id} may be pending there too, and this file doesn't cancel it there.`]);
    w.logsFail = undefined;
    // the guardian may not cancel a GuardianSwap
    const swap = put(w, "vault", "setGuardian", [other], HEAD_TIME - D);
    expect((await failure(sign(w, write(fileOf([{ ...direct("vault", "cancel", [swap.id], GUARDIAN), label: "cancel(it)" }])))))).toMatchObject({
      message: `call 1: the guardian cannot cancel item ${swap.id} (setGuardian(${other})) on the vault (Bittensor): it is a GuardianSwap, and only the owner can cancel a guardian swap or a reopening`,
    });
  });

  it("a cancel whose own chain can't be read still checks the other chain for a twin copy (review, M4)", async () => {
    const w = world();
    const v = put(w, "vault", "transferOwnership", [another], HEAD_TIME - 9 * D);
    put(w, "frontDoor", "transferOwnership", [another], HEAD_TIME - D);
    w.logsFail = "bittensor";
    const p = await sign(w, write(fileOf([{ ...direct("vault", "cancel", [v.id]), label: "cancel(it)" }])));
    expect(p.view.calls[0].callWarnings).toEqual([
      `What it drops couldn't be read right now (query timeout exceeded): it drops item ${v.id} if the vault (Bittensor) holds one.`,
      `Item ${v.id} is pending on the front door (Base) too, and this file doesn't cancel that copy: it still runs there.`,
    ]);
    expect(p.page.html).toContain('id="send-0"');
  });

  it("R6 (ChatGPT R2 claim C): a write-off's execute is served only with its own 47,000,000 gas limit and while it is at most the missing stake less the unlisted, read now; the page checks that again just before it sends", async () => {
    const w = world();
    const lens = w.book[plan.addresses.vaultLens.toLowerCase()].answers;
    lens.missingStakeRao = 50n * RAO;
    lens.unlistedStakeRao = 20n * RAO;
    const { data } = put(w, "vault", "writeOffMissingStake", [30n * RAO], HEAD_TIME - 8 * D);
    const call = { ...sched("vault", "execute", data), gas: 47_000_000 };
    const p = await sign(w, write(fileOf([call])));
    const cv = p.view.calls[0];
    expect(cv.gas).toBe("47000000");
    expect(cv.details).toContainEqual({ name: "Checked", lines: ["The write-off is at most the missing stake less the unlisted, read now: 30000000000 rao of 30000000000. The page checks again just before it sends."] });
    expect(cv.recheck).toBe("that the write-off is still at most the missing stake less the unlisted (pnpm ops execute's check)");
    expect(p.page.html).toContain("47,000,000, set by this page: leave it as it is in MetaMask (the owner's account must hold it at the gas price; only the gas used is paid)");
    expect(await p.api?.check(0)).toEqual({ ok: true, text: "Checked again just now: the write-off is at most the missing stake less the unlisted (30000000000 rao of 30000000000)." });
    // stake back on an unlisted hotkey after the page was served: the check before sending refuses
    lens.unlistedStakeRao = 25n * RAO;
    expect(await p.api?.check(0)).toEqual({
      ok: false,
      text: "writeOffMissingStake(30000000000) is now more than the missing stake less the unlisted (25000000000 rao, read now): stake came back on a hotkey the vault doesn't list. Don't execute it: list that hotkey (addHotkey), and schedule a new write-off if any is still missing",
    });
    // served then: refused before the page is shown
    expect((await failure(sign(w, write(fileOf([call])))))).toMatchObject({ message: expect.stringMatching(/^call 1: writeOffMissingStake\(30000000000\) is now more than the missing stake less the unlisted/) });
    lens.unlistedStakeRao = 20n * RAO;
    // no gas limit, or another than its own: refused
    expect((await failure(sign(w, write(fileOf([sched("vault", "execute", data)])))))).toMatchObject({
      message: "call 1: a write-off's execute goes with the gas limit pnpm ops execute sets in its file, never a wallet's estimate: this one sets none",
    });
    expect((await failure(sign(w, write(fileOf([{ ...call, gas: 30_000_000 }])))))).toMatchObject({
      message: "call 1: it sets a gas limit of 30,000,000, not the 47,000,000 a write-off's execute goes with",
    });
  });

  it("executeWarnsWhenItWouldLoosen: each changed field, now and then; a warning, never a refusal", async () => {
    const w = world();
    // maxDailyOutflowBps up (loosens), minDailyOutflow the same, globalOutflowBps down
    const { data } = put(w, "vault", "setOutflowLimits", [2_500n, 10n * E18, 2_500n], HEAD_TIME - 3 * D);
    const p = await sign(w, write(fileOf([sched("vault", "execute", data)])));
    const call = p.view.calls[0];
    expect(call.callWarnings).toEqual(["It loosens a limit when it runs: maxDailyOutflowBps: 2000 now, 2500 then (loosens); globalOutflowBps: 3000 now, 2500 then."]);
    expect(call.details).toContainEqual({
      name: "Changes",
      lines: ["maxDailyOutflowBps: 2000 now, 2500 then (loosens)", "minDailyOutflow: 10 TAO now, 10 TAO then", "globalOutflowBps: 3000 now, 2500 then", "It loosens a limit: that is why it waits."],
    });
    expect(p.page.html).toContain('<p class="warning">WARNING: It loosens a limit when it runs: maxDailyOutflowBps: 2000 now, 2500 then (loosens); globalOutflowBps: 3000 now, 2500 then.</p>');
    expect(p.page.html).toContain('id="send-0"');
    expect(p.lines).toContain("     WARNING: It loosens a limit when it runs: maxDailyOutflowBps: 2000 now, 2500 then (loosens); globalOutflowBps: 3000 now, 2500 then.");
    // a tightening: what it changes, and no warning
    const tight = put(w, "vault", "setMaxTotalAssets", [30n * E18], HEAD_TIME - 3 * D);
    const q = await sign(w, write(fileOf([sched("vault", "execute", tight.data)])));
    expect(q.view.calls[0].callWarnings ?? []).toEqual([]);
    expect(q.view.calls[0].details).toContainEqual({ name: "Changes", lines: ["maxTotalAssets: 40 TAO now, 30 TAO then", "It loosens nothing now: the same change could be made directly, at once."] });
    // the current values can't be read: said, and the call still shown
    w.book[plan.addresses.vaultLens.toLowerCase()].answers.maxTotalAssets = new RpcError("header not found", -32000);
    const r = await sign(w, write(fileOf([sched("vault", "execute", tight.data)])));
    expect(r.view.calls[0].callWarnings).toEqual(["Whether it loosens a limit couldn't be read right now (header not found)."]);
  });

  it("scheduleShowsKindClassReadyAtAndArgs", async () => {
    const w = world();
    const head = { block: w.heads.bittensor, time: HEAD_TIME };
    const inner = setter("vault", "setGuardian", [other]);
    const p = await sign(w, write(fileOf([sched("vault", "schedule", inner)])));
    const call = p.view.calls[0];
    expect(call.heading).toBe(`schedule(setGuardian(${other})) on the Vault (Bittensor)`);
    expect(call.effect).toBe(`schedule(setGuardian(${other})): starts its 8-day wait before setGuardian can run on the Vault; nothing changes until it is executed`);
    expect(call.details).toEqual([
      { name: "Scheduled call", lines: ["setGuardian(address)", `newGuardian (address) = ${other}`] },
      { name: "Item", lines: [`${keccak256(inner)} (keccak256 of the scheduled call)`] },
      { name: "Kind", lines: ["GuardianSwap: only the owner can cancel it"] },
      { name: "Class", lines: ["Guardian: it waits 8 days"] },
      {
        name: "Ready",
        lines: [
          `8 days and 48,000 blocks after it lands. If it lands now: from ${iso(head.time + 8 * D)} and block ${(head.block + 48_000).toLocaleString("en-US")}, then it can run for 7 days, until ${iso(head.time + 15 * D)}.`,
        ],
      },
      { name: "Dies", lines: ["A closure by the owner, or an owner stamp, dated at or after the second it lands kills it: schedule it after the asOf of the last stamp you signed."] },
      { name: "Changes", lines: [`guardian: ${GUARDIAN} now, ${other} then`, "No direction: this change waits its delay whatever its value."] },
    ]);
    for (const d of call.details ?? []) expect(p.page.html).toContain(`<dt>${d.name}</dt>`);
    // the contract's own MS_PER_BLOCK, read, as the pending list reads it (review M-5): at 3,600 ms, 96,000 blocks
    const vaultAt = plan.addresses.vault.toLowerCase();
    w.book[vaultAt].answers.MS_PER_BLOCK = 3_600n;
    const slower = await sign(w, write(fileOf([sched("vault", "schedule", inner)])));
    expect(slower.view.calls[0].details?.find((d) => d.name === "Ready")?.lines[0]).toMatch(/^8 days and 96,000 blocks after it lands/);
    w.book[vaultAt].answers.MS_PER_BLOCK = 7_200n;
    expect(p.page.html).toContain(`newGuardian (address) = ${other}`);
    // an Ordinary Param item, and an activation of a known bridge, a Reopen
    const max = await sign(w, write(fileOf([sched("vault", "schedule", setter("vault", "setMaxTotalAssets", [44n * E18]))])));
    expect(max.view.calls[0].details?.find((d) => d.name === "Kind")).toEqual({ name: "Kind", lines: ["Ordinary: the owner or the guardian can cancel it"] });
    expect(max.view.calls[0].details?.find((d) => d.name === "Class")).toEqual({ name: "Class", lines: ["Param: it waits 48 hours"] });
    const reopen = await sign(w, write(fileOf([sched("frontDoor", "schedule", setter("frontDoor", "activateBridge", [another]))])));
    expect(reopen.view.calls[0].details?.find((d) => d.name === "Kind")).toEqual({ name: "Kind", lines: ["Reopen: only the owner can cancel it"] });
    // this world's Base makes a block every 2 s, ten times its calibrated 0.2 s: its blocks are the later clock, so the
    // item can run until its window in blocks ends (Revision 28's lapse needs both)
    const baseHead = w.heads.base;
    expect(reopen.view.calls[0].details?.find((d) => d.name === "Ready")?.lines[0]).toBe(
      `7 days and 2,520,000 blocks after it lands. If it lands now: from ${iso(HEAD_TIME + 7 * D)} and block ${(baseHead + 2_520_000).toLocaleString("en-US")}, then it can run for 7 days, until about ${iso(HEAD_TIME + 5_040_000 * 2)} (block ${(baseHead + 5_040_000).toLocaleString("en-US")}: its blocks come slower than its time).`,
    );
    // what its scheduler doesn't take, or calldata that isn't one word an argument: refused
    expect((await failure(sign(w, write(fileOf([sched("vault", "schedule", setter("vault", "pause", []))])))))).toMatchObject({
      message: "call 1: the vault (Bittensor)'s scheduler doesn't take pause(): refusing a schedule it would revert",
    });
    expect((await failure(sign(w, write(fileOf([sched("vault", "schedule", `${setter("vault", "setMaxTotalAssets", [1n])}00`)])))))).toMatchObject({
      message: "call 1: schedule(setMaxTotalAssets) carries calldata that is not the exact encoding of its arguments, one word each: refusing calldata the contract would read differently",
    });
    expect((await failure(sign(w, write(fileOf([sched("vault", "schedule", "0x12345678")])))))).toMatchObject({
      message: "call 1: schedule(0x12345678) is not a call to a function of the vault (Bittensor): refusing calldata the page can't decode",
    });
    // only the owner schedules
    expect((await failure(sign(w, write(fileOf([sched("vault", "schedule", inner, GUARDIAN)])))))).toMatchObject({ message: expect.stringMatching(/may send schedule\(\) to the Vault on Bittensor/) });
  });

  it("transferOwnershipOnlyAsAScheduleCall", async () => {
    const w = world();
    expect(KNOWN_ABI.map((f) => f.name)).not.toContain("transferOwnership");
    // a direct transfer is refused, on either contract
    const transfer = encodeFunctionData({ abi: parseAbi(["function transferOwnership(address newOwner)"]), functionName: "transferOwnership", args: [another] });
    for (const c of ["vault", "frontDoor"] as const) {
      const e = await failure(sign(w, write(fileOf([{ chainId: CHAIN_ID[c], to: plan.addresses[c], data: transfer, label: "transferOwnership(x)", from: OWNER.address }]))));
      expect(e.message).toMatch(/^call 1: calldata 0xf2fde38b is not one of the known functions/);
    }
    // as a schedule call it is shown for what it is: an Ordinary Guardian-class item, 8 days under the guardian's veto
    const p = await sign(w, write(fileOf([sched("frontDoor", "schedule", setter("frontDoor", "transferOwnership", [another]))])));
    expect(p.view.calls[0].heading).toBe(`schedule(transferOwnership(${another})) on the Front door (Base)`);
    expect(p.view.calls[0].details?.find((d) => d.name === "Kind")?.lines).toEqual(["Ordinary: the owner or the guardian can cancel it"]);
    expect(p.view.calls[0].details?.find((d) => d.name === "Class")?.lines).toEqual(["Guardian: it waits 8 days"]);
  });

  it("refuses a function its contract's frozen ABI lacks, though the page's table knows it (review, I1)", async () => {
    // a frozen build whose front door has no setCaps: the table offers it, the frozen-ABI check alone refuses it
    const lacking = structuredClone(build);
    lacking.contracts.CascadeFrontDoor.abi = lacking.contracts.CascadeFrontDoor.abi.filter((x) => !(x.type === "function" && x.name === "setCaps"));
    const text = `${JSON.stringify(lacking, null, 2)}\n`;
    const otherRef = writeBuildV32(buildsDir, { text, hash: keccak256(stringToBytes(text)) });
    expect(otherRef.dir).not.toBe(ref.dir);
    const w = world();
    const file = write(fileOf([direct("frontDoor", "setCaps", [E18 / 100n, 40n * E18])]));
    const e = await failure(sign(w, file, {}, record(otherRef)));
    expect(e.message).toBe(
      "call 1: setCaps(uint256,uint256) is not in the Front door on Base's ABI (the deployment's frozen build): refusing to show calldata its contract would read differently",
    );
    // with the deployment's own build, the same file is shown
    expect((await sign(w, file)).view.calls[0].fn.name).toBe("setCaps");
  });

  it("R6b (U4): the owner's setBatchLimits is served on the front door, never on the vault, nor from the guardian", async () => {
    const w = world();
    const p = await sign(w, write(fileOf([direct("frontDoor", "setBatchLimits", [1, 50])])));
    expect(p.view.calls.map((c) => [c.heading, c.senderRole])).toEqual([["setBatchLimits(1, 50) on the Front door (Base)", "the owner the Front door names now"]]);
    expect((await failure(sign(w, write(fileOf([direct("vault", "setBatchLimits", [1, 50])])))))).toMatchObject({ message: "call 1: setBatchLimits() is not a call this tool makes to the Vault on Bittensor" });
    expect((await failure(sign(w, write(fileOf([direct("frontDoor", "setBatchLimits", [1, 50], GUARDIAN)])))))).toBeInstanceOf(Error);
  });

  it("what is shown is what is signed: each call is checked against the contract's own ABI from the frozen build", async () => {
    const w = world();
    // setCaps is the front door's: sent to the vault it is refused, though KNOWN_ABI decodes it
    expect((await failure(sign(w, write(fileOf([direct("vault", "setCaps", [E18, 50n * E18])])))))).toMatchObject({ message: "call 1: setCaps() is not a call this tool makes to the Vault on Bittensor" });
    const p = await sign(w, write(fileOf([direct("frontDoor", "setCaps", [E18 / 100n, 40n * E18]), direct("vault", "addHotkey", [YUMA], GUARDIAN)])));
    expect(p.view.calls.map((c) => c.heading)).toEqual([`setCaps(10000000000000000, 40000000000000000000) on the Front door (Base)`, `addHotkey(${YUMA}) on the Vault (Bittensor)`]);
    expect(p.view.calls[1].senderRole).toBe("the guardian the Vault names now");
    // Task 53: the owner's removal of a hotkey (pnpm ops remove-hotkey --as owner --for-wallet), forfeit or not
    const rm = await sign(w, write(fileOf([direct("vault", "removeHotkey", [YUMA, true]), direct("vault", "removeHotkey", [YUMA, false], GUARDIAN)])));
    expect(rm.view.calls.map((c) => [c.heading, c.senderRole])).toEqual([
      [`removeHotkey(${YUMA}, true) on the Vault (Bittensor)`, "the owner the Vault names now"],
      [`removeHotkey(${YUMA}, false) on the Vault (Bittensor)`, "the guardian the Vault names now"],
    ]);
    expect(rm.view.calls[0].effect).toBe(`removeHotkey(${YUMA}, true): removes the hotkey ${YUMA} from the Vault's list (the owner's removal moves any stake on it onto the stake hotkey; the guardian's takes only an empty one), giving up its unclaimed rewards (forfeit)`);
    // Task 53: the treasury's own redeem origin, from the treasury only (the record's treasury, the lens not answering it)
    const treasury = SETTINGS_V32_LAUNCH.treasury;
    const origin = await sign(w, write(fileOf([direct("vault", "setRedeemOrigin", [(1n << 64n) - 1n], treasury)])));
    expect([origin.view.calls[0].heading, origin.view.calls[0].senderRole]).toEqual(["setRedeemOrigin(18446744073709551615) on the Vault (Bittensor)", "the treasury on Bittensor, from the deployment record"]);
    expect(origin.view.calls[0].effect).toBe("setRedeemOrigin(18446744073709551615): makes the treasury's redeem origin Bittensor itself (DIRECT_ORIGIN): its shares are redeemed only on Bittensor (redeemDirect), never burned by a front door");
    expect((await failure(sign(w, write(fileOf([direct("vault", "setRedeemOrigin", [(1n << 64n) - 1n])])))))).toMatchObject({ message: expect.stringMatching(/^call 1: 0x[0-9a-fA-F]{40} is not a role .* that may send setRedeemOrigin\(\) to the Vault on Bittensor/) });
    // a payout batch's cancel: its list shown entry by entry
    const key = `0x${"4b".repeat(32)}` as Hex;
    const payouts = [{ user: other, shares: 2n * E18, assets: 3n * E18 }];
    const q = await sign(w, write(fileOf([direct("vault", "cancelPayoutBatch", [key, payouts])])));
    expect(q.view.calls[0].fn.args[1]).toEqual({ name: "payouts", type: "(address user, uint256 shares, uint256 assets)[]", value: `[{user: ${other}, shares: 2000000000000000000, assets: 3000000000000000000}]` });
  });
});

describe("Task 49: warnings that never refuse", () => {
  it("ownerAccountRemoveFrontDoorWarns", async () => {
    const w = world();
    const removal = (from: Address) => write(fileOf([{ ...direct("vault", "removeFrontDoor", [8_453n, plan.addresses.frontDoor], from), label: "removeFrontDoor(8453, door)" }]));
    const owner = await sign(w, removal(OWNER.address));
    expect(owner.view.calls[0].callWarnings).toContain(
      "This removal is the owner's: the door then stays Reopen-able by the owner alone, without the guardian's veto. A removal meant to last is the guardian's.",
    );
    expect(owner.page.html).toContain("the door then stays Reopen-able by the owner alone, without the guardian&#39;s veto");
    expect(owner.page.html).toContain('id="send-0"');
    const guardian = await sign(w, removal(GUARDIAN));
    expect(guardian.view.calls[0].callWarnings ?? []).not.toContainEqual(expect.stringMatching(/Reopen-able/));
    expect(guardian.view.calls[0].details).toContainEqual({
      name: "Checked",
      lines: [`No payout batch of the door is queued on the vault and no park from it is outstanding, as of Bittensor block ${w.heads.bittensor}. The page checks again just before it sends.`],
    });
  });

  it("says when a call stamps a clock, which kills every item pending on it (review, M6)", async () => {
    const w = world();
    const kills = (who: "owner" | "guardian") =>
      who === "owner"
        ? "it stamps the owner's clock on the Vault: every item pending there dies, your own scheduled transferOwnership included. Schedule what you mean to keep after it."
        : "it stamps the guardian's clock on the Vault: every Ordinary item pending there dies (not a guardian swap or a reopening), your own scheduled transferOwnership included. Schedule what you mean to keep after it.";
    // the vault's pause, by the guardian or the owner; the front door's pause stamps nothing
    const pauses = await sign(w, write(fileOf([direct("vault", "pause", [], GUARDIAN), direct("vault", "pause", []), direct("frontDoor", "pause", [], GUARDIAN)])));
    expect(pauses.view.calls.map((c) => c.callWarnings ?? [])).toEqual([[`Pausing the Vault: ${kills("guardian")}`], [`Pausing the Vault: ${kills("owner")}`], []]);
    // the launch door's payout batch, cancelled
    const key = `0x${"4b".repeat(32)}` as Hex;
    queue(w, key, 3n * E18, w.heads.bittensor - 5);
    const cancel = await sign(w, write(fileOf([direct("vault", "cancelPayoutBatch", [key, [{ user: other, shares: E18, assets: E18 }]])])));
    expect(cancel.view.calls[0].callWarnings).toEqual([`It is the launch door's batch, so ${kills("owner")}`]);
    // another door's batch stamps nothing
    w.batches.set(key, { ...w.batches.get(key)!, sourceChain: 10n });
    const away = await sign(w, write(fileOf([direct("vault", "cancelPayoutBatch", [key, [{ user: other, shares: E18, assets: E18 }]])])));
    expect(away.view.calls[0].callWarnings ?? []).toEqual([]);
    // the launch chain's last active door, removed
    w.batches.clear();
    const removal = await sign(w, write(fileOf([{ ...direct("vault", "removeFrontDoor", [8_453n, plan.addresses.frontDoor], GUARDIAN), label: "removeFrontDoor(8453, door)" }])));
    expect(removal.view.calls[0].callWarnings).toContain(`It is the launch chain's last active door: removing it closes the exits, and ${kills("guardian")}`);
    // the rare one (Task 49's re-review, N4): the guardian's removal of a launch-chain door the owner removed, while the
    // exits' hold is the owner's, makes the hold the guardian's and stamps the guardian's clock
    const lens = w.book[plan.addresses.vaultLens.toLowerCase()].answers;
    const launchPeer = peerOf(8_453n, plan.addresses.frontDoor);
    lens.doorState = (args: readonly unknown[]) => (sameText(args[0], launchPeer) ? 2 : 0);
    lens.activeDoors = () => 0n;
    lens.launchDoorRemovedBy = 1;
    const takeover = await sign(w, write(fileOf([{ ...direct("vault", "removeFrontDoor", [8_453n, plan.addresses.frontDoor], GUARDIAN), label: "removeFrontDoor(8453, door)" }])));
    expect(takeover.view.calls[0].callWarnings).toContain(`The owner removed this launch-chain door and the exits' hold is the owner's: the guardian's removal makes that hold the guardian's, and ${kills("guardian")}`);
    // the guardian's own earlier removal holds already (Actor.Guardian): nothing is stamped again
    lens.launchDoorRemovedBy = 2;
    const again = await sign(w, write(fileOf([{ ...direct("vault", "removeFrontDoor", [8_453n, plan.addresses.frontDoor], GUARDIAN), label: "removeFrontDoor(8453, door)" }])));
    expect((again.view.calls[0].callWarnings ?? []).filter((x) => x.includes("stamps"))).toEqual([]);
    lens.doorState = (args: readonly unknown[]) => (sameText(args[0], launchPeer) ? 1 : 0);
    lens.activeDoors = (args: readonly unknown[]) => (args[0] === 8_453n ? 1n : 0n);
    // a read that fails: said, never a refusal
    w.book[plan.addresses.vaultLens.toLowerCase()].answers.getPayoutBatch = new RpcError("header not found", -32000);
    const blind = await sign(w, write(fileOf([direct("vault", "cancelPayoutBatch", [key, [{ user: other, shares: E18, assets: E18 }]])])));
    expect(blind.view.calls[0].callWarnings).toEqual(["Whether it is the launch door's batch, whose cancel stamps the owner's clock, couldn't be read right now (header not found)."]);
  });

  it("capsAboveFounderLevelWithoutASafeWarnsNeverRefuses: quoting section 5", async () => {
    const w = world();
    const quote = `Spec section 5: "${SINGLE_KEY_RESIDUAL[0]}" Until then, "${SINGLE_KEY_RESIDUAL[1]}".`;
    const above = await sign(
      w,
      write(fileOf([direct("frontDoor", "setCaps", [E18 / 100n, 50n * E18]), sched("vault", "schedule", setter("vault", "setMaxTotalAssets", [100n * E18])), direct("vault", "setMaxTotalAssets", [45n * E18])])),
    );
    // capsWarning's own words (ruling B7a: the one helper), shown as the call's warning
    const warnings = above.view.calls.map((c) => (c.callWarnings ?? []).find((x) => x.includes("founder level")));
    expect(warnings[0]).toBe(`a deposit cap of 50 TAO (the founder level is 40) is above the founder level, and the owner is a plain account, not a Safe with at least 2 of 3 signers. ${quote} This is a warning: nothing is refused.`);
    expect(warnings[1]).toBe(`maxTotalAssets of 100 TAO (the founder level is 44) is above the founder level, and the owner is a plain account, not a Safe with at least 2 of 3 signers. ${quote} This is a warning: nothing is refused.`);
    expect(warnings[2]).toMatch(/^maxTotalAssets of 45 TAO \(the founder level is 44\) is above the founder level/);
    expect(above.page.html).toContain('<p class="warning">WARNING: a deposit cap of 50 TAO (the founder level is 40) is above the founder level');
    // never refused: every call has its send button
    for (const i of [0, 1, 2]) expect(above.page.html).toContain(`id="send-${i}"`);
    expect(above.page.html).toContain(SINGLE_KEY_RESIDUAL[0].replace(/'/g, "&#39;"));
    // an execute of a raise above the level warns too
    const item = put(w, "vault", "setMaxTotalAssets", [100n * E18], HEAD_TIME - 3 * D);
    const ex = await sign(w, write(fileOf([sched("vault", "execute", item.data)])));
    expect(ex.view.calls[0].callWarnings).toContainEqual(expect.stringMatching(/^maxTotalAssets of 100 TAO \(the founder level is 44\)/));
    // at the founder level: no Safe warning
    const level = await sign(w, write(fileOf([direct("frontDoor", "setCaps", [E18 / 100n, 40n * E18])])));
    expect(level.view.calls[0].callWarnings ?? []).toEqual([]);
    // an owner that is a 2-of-3 Safe: none
    const s = world();
    for (const c of ["vault", "frontDoor"] as const) s.book[plan.addresses[c].toLowerCase()].answers.owner = SAFE;
    s.codes[SAFE.toLowerCase()] = "0x6080604052";
    s.book[SAFE.toLowerCase()] = { chain: "base", abi: parseAbi(["function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"]), answers: { getThreshold: 2n, getOwners: [other, another, GUARDIAN] } };
    const safe = await sign(s, write(fileOf([direct("frontDoor", "setCaps", [E18 / 100n, 50n * E18], SAFE)])));
    expect(safe.view.calls[0].callWarnings ?? []).toEqual([]);
  });
});

describe("Task 49: the remove-door re-check, just before sending (Task 46b's review, I2)", () => {
  it("re-runs remove-door's guard against the chain just before the page sends; if it no longer passes, sends nothing and says why", async () => {
    const w = world();
    const p = await sign(w, write(fileOf([{ ...direct("vault", "removeFrontDoor", [8_453n, plan.addresses.frontDoor], GUARDIAN), label: "removeFrontDoor(8453, door)" }])));
    expect(p.view.calls[0].recheck).toBe("that no payout batch of the door is queued and no park from it is outstanding (pnpm ops remove-door's guard)");
    expect(p.page.csp).toContain("connect-src 'self'");
    // the guard passes again: the page sends
    const ok = await openPage(p, { accounts: [GUARDIAN], chainId: "0x3c4" });
    try {
      await ok.click("send-0");
      expect(ok.fetches).toEqual(["/check/0"]);
      expect(ok.w.of("eth_sendTransaction")).toHaveLength(1);
    } finally {
      await ok.close();
    }
    // a batch of the door lands on the vault after the page was served: the re-check refuses, nothing is sent
    queue(w, `0x${"4b".repeat(32)}`, 3n * E18, w.heads.bittensor - 5);
    const late = await openPage(p, { accounts: [GUARDIAN], chainId: "0x3c4" });
    try {
      await late.click("send-0");
      expect(late.fetches).toEqual(["/check/0"]);
      expect(late.w.of("eth_sendTransaction")).toEqual([]);
      expect(late.el("status-0").textContent).toBe(
        `Not sent: front door ${plan.addresses.frontDoor} on chain 8453 can't be removed yet: it has 1 payout batch queued on the vault, 0x${"4b".repeat(32)} (2 of 2 entries left, 3 TAO): each is paid first (processPayouts), carried bounces included`,
      );
      expect(late.el("status-0").className).toBe("status bad");
    } finally {
      await late.close();
    }
    // served with the batch already there: refused before the page is shown
    expect((await failure(sign(w, write(fileOf([{ ...direct("vault", "removeFrontDoor", [8_453n, plan.addresses.frontDoor], GUARDIAN), label: "removeFrontDoor(8453, door)" }])))))).toMatchObject({
      message: expect.stringMatching(/^call 1: front door 0x[0-9a-fA-F]{40} on chain 8453 can't be removed yet: it has 1 payout batch queued/),
    });
  });

  it("the page's server takes its two requests only from the page itself: its origin, its token, JSON", async () => {
    const w = world();
    const p = await sign(w, write(fileOf([{ ...direct("vault", "removeFrontDoor", [8_453n, plan.addresses.frontDoor], GUARDIAN), label: "removeFrontDoor(8453, door)" }])));
    const s = await servePage(p.page, p.api);
    try {
      const token = p.page.token as string;
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      const good = { origin: `http://127.0.0.1:${s.port}`, "content-type": "application/json", "x-cascade-token": token };
      expect((await post(s.port, "/check/0", good, "{}")).status).toBe(200);
      expect(JSON.parse((await post(s.port, "/check/0", good, "{}")).body)).toMatchObject({ ok: true });
      // another site's page, no token, the wrong token, or not JSON: refused, and nothing is asked of the chain
      const before = w.calls.length;
      expect((await post(s.port, "/check/0", { ...good, origin: "https://evil.example" }, "{}")).status).toBe(403);
      expect((await post(s.port, "/check/0", { origin: good.origin, "content-type": "application/json" }, "{}")).status).toBe(403);
      expect((await post(s.port, "/check/0", { ...good, "x-cascade-token": "0".repeat(32) }, "{}")).status).toBe(403);
      expect((await post(s.port, "/check/0", { ...good, "content-type": "text/plain" }, "{}")).status).toBe(415);
      expect((await post(s.port, "/nothing", good, "{}")).status).toBe(404);
      expect(w.calls.length).toBe(before);
      // a call with nothing to check again
      expect(JSON.parse((await post(s.port, "/check/1", good, "{}")).body)).toEqual({ ok: false, text: "call 2 is not in this file, or has nothing to check again" });
    } finally {
      await s.close();
    }
  });
});

describe("Task 49's re-review, N1: the other chain's copy is read only from an RPC that answers that chain's id", () => {
  it("a stale fork with the same addresses can't hide a twin: its 'not pending there' is never taken, the copy is unread", async () => {
    const w = world();
    const v = put(w, "vault", "setMaxTotalAssets", [44n * E18], HEAD_TIME - D);
    // Base's RPC is a fork of another chain (31337): its answer of the front door's scheduler is no answer of Base's
    w.chainIds = { base: 31_337 };
    const cancel = await sign(w, write(fileOf([{ ...direct("vault", "cancel", [v.id], GUARDIAN), label: "cancel(it)" }])));
    expect(cancel.view.calls[0].callWarnings).toEqual([
      `the front door (Base) couldn't be read right now (the RPC reports chain id 31337, not 8453): item ${v.id} may be pending there too, and this file doesn't cancel it there.`,
    ]);
    expect(cancel.view.calls[0].details).toContainEqual({ name: "Copies", lines: ["the vault (Bittensor): waiting: ready at " + iso(HEAD_TIME - D + 2 * D) + " (this call)", "the front door (Base): couldn't be read right now (the RPC reports chain id 31337, not 8453)"] });
    // the right chain id: read as before
    w.chainIds = undefined;
    const right = await sign(w, write(fileOf([{ ...direct("vault", "cancel", [v.id], GUARDIAN), label: "cancel(it)" }])));
    expect(right.view.calls[0].callWarnings ?? []).toEqual([]);
  });
});

describe("Task 49: a page needs only the chains its file names (review, M7)", () => {
  it("serves a Bittensor-only file while Base's RPC is down, and the other way round; refuses a file whose own chain is down", async () => {
    const w = world();
    w.down = "base";
    const sink = stampSink();
    const pause = await sign(w, write(fileOf([direct("vault", "pause", [], GUARDIAN)])));
    expect(pause.view.calls[0].heading).toBe("pause() on the Vault (Bittensor)");
    expect(pause.view.warnings).toEqual([]);
    const stamp = await sign(w, write(stampFileOf([{ chainId: 964, contract: plan.addresses.vault, asOf: String(HEAD_TIME), from: OWNER.address, mode: "relay", label: "x" }])), { stamps: sink.stamps });
    expect(stamp.view.stamps).toHaveLength(1);
    // a vault cancel says the front door couldn't be read for its twin
    const v = put(w, "vault", "setMaxTotalAssets", [44n * E18], HEAD_TIME - D);
    const cancel = await sign(w, write(fileOf([{ ...direct("vault", "cancel", [v.id], GUARDIAN), label: "cancel(it)" }])));
    expect(cancel.view.calls[0].callWarnings).toEqual([`the front door (Base) couldn't be read right now (connect ECONNREFUSED): item ${v.id} may be pending there too, and this file doesn't cancel it there.`]);
    // a front door file needs Base
    expect((await failure(sign(w, write(fileOf([direct("frontDoor", "pause", [], GUARDIAN)])))))).toMatchObject({
      message: "Couldn't read Base's chain id right now (connect ECONNREFUSED); try again; nothing served",
    });
    w.down = "bittensor";
    expect((await sign(w, write(fileOf([direct("frontDoor", "pause", [], GUARDIAN)])))).view.calls).toHaveLength(1);
  });
});

describe("Task 49: the owner's stamp on the sign page", () => {
  const head = (w: World, chain: ChainName) => BigInt(timeOf(w, chain, w.heads[chain]));
  const request = (c: Contract, asOf: bigint, o: Partial<StampRequest> = {}): StampRequest => ({
    chainId: CHAIN_ID[c],
    contract: plan.addresses[c],
    asOf: asOf.toString(),
    from: OWNER.address,
    mode: "relay",
    label: `the owner's stamp on the ${c}`,
    ...o,
  });

  it("stampRequestShowsContractsChainsAsOfAndBothHashes: the Ledger may blind-sign EIP-712", async () => {
    const w = world();
    const sink = stampSink();
    const asOf = head(w, "bittensor");
    const p = await sign(w, write(stampFileOf([request("vault", asOf), request("frontDoor", head(w, "base"))])), { stamps: sink.stamps });
    expect(sink.ready).toEqual(["relay"]);
    expect(p.view.heading).toBe("Cascade v3.2-launch: 2 stamps to sign with MetaMask");
    const [vault, door] = p.view.stamps ?? [];
    const hv = stampHashes(964, plan.addresses.vault, asOf);
    const hd = stampHashes(8_453, plan.addresses.frontDoor, head(w, "base"));
    expect(vault).toMatchObject({ contractName: "Vault on Bittensor", network: "Bittensor EVM", chainId: 964, asOfText: iso(asOf), domainHash: hv.domainHash, messageHash: hv.structHash, digest: hv.digest });
    expect(door).toMatchObject({ contractName: "Front door on Base", network: "Base", chainId: 8_453, domainHash: hd.domainHash, digest: hd.digest });
    // the typed data the page asks MetaMask to sign is ops's own, for the contract's chain and address
    expect(JSON.parse(vault.typedData)).toEqual(stampTypedDataJson(964, plan.addresses.vault, asOf));
    const html = p.page.html;
    for (const [s, h, chainId, name] of [
      [vault, hv, 964, "Bittensor EVM"],
      [door, hd, 8_453, "Base"],
    ] as const) {
      expect(html).toContain(`<dt>Contract</dt><dd>${s.contractName}<br><code>${s.contract}</code></dd>`);
      expect(html).toContain(`<dt>Network</dt><dd>${name} (chain id ${chainId})</dd>`);
      expect(html).toContain(`<dt>As of</dt><dd>${s.asOfText} (<code>${s.asOf}</code>)</dd>`);
      expect(html).toContain(`<dt>Domain hash</dt><dd><code>${h.domainHash}</code></dd>`);
      expect(html).toContain(`<dt>Message hash</dt><dd><code>${h.structHash}</code></dd>`);
      expect(html).toContain(`<dt>Digest</dt><dd><code>${h.digest}</code></dd>`);
    }
    expect(html).toContain('id="stamp-0"');
    expect(html).toContain('id="stamp-1"');
    expect(html).toMatch(/A Ledger may sign a stamp blind: it then shows only the domain hash and the message hash/);
    expect(p.lines).toContain(`     Domain hash ${hv.domainHash}, message hash ${hv.structHash}, digest ${hv.digest}`);
  });

  it("refuses a stamp for the wrong chain or contract, or for anyone but the owner, or over another hash than the contract's", async () => {
    const w = world();
    const sink = stampSink();
    const asOf = head(w, "bittensor");
    const go = (r: StampRequest) => sign(w, write(stampFileOf([r])), { stamps: sink.stamps });
    expect((await failure(go(request("vault", asOf, { chainId: 8_453 })))).message).toBe(
      `stamp 1: ${plan.addresses.vault} on Base (chain id 8453) is not this deployment's vault on Bittensor (964) nor its front door on Base (8453): refusing to ask for a stamp for it`,
    );
    expect((await failure(go(request("vault", asOf, { contract: plan.addresses.vaultLens })))).message).toMatch(/^stamp 1: 0x[0-9a-fA-F]{40} on Bittensor EVM \(chain id 964\) is not this deployment's vault/);
    expect((await failure(go(request("vault", asOf, { from: GUARDIAN })))).message).toBe(
      `stamp 1: it is to be signed by ${GUARDIAN}, but the vault (Bittensor)'s owner now is ${OWNER.address}: a stamp counts only when the owner signs it`,
    );
    w.book[plan.addresses.vaultLens.toLowerCase()].answers.DOMAIN_SEPARATOR = `0x${"0d".repeat(32)}`;
    expect((await failure(go(request("vault", asOf))))).toMatchObject({ message: expect.stringMatching(/^stamp 1: the vault \(Bittensor\)'s DOMAIN_SEPARATOR is 0x(0d){32}, not 0x/) });
    // a stamp to relay now that has expired by the head
    const v = world();
    expect((await failure(sign(v, write(stampFileOf([request("vault", head(v, "bittensor") - BigInt(D) - 1n)])), { stamps: sink.stamps })))).toMatchObject({
      message: expect.stringMatching(/^stamp 1: the stamp as of \d+ \(.*\) expired at .* by Bittensor's head .*: the contract refuses it \(StampOutOfWindow\); have the owner sign a new one$/),
    });
    // a run that can't hand a stamp on is refused before anything is signed
    expect((await failure(sign(v, write(stampFileOf([request("vault", head(v, "bittensor"))])))))).toMatchObject({
      message: "this run can't hand a signed stamp on (no relay path): run pnpm ops sign from the CLI",
    });
    const noRelayer = { stamps: { ...sink.stamps, ready: () => {
      throw new Error("the relayer's key is not named");
    } } };
    expect((await failure(sign(v, write(stampFileOf([request("vault", head(v, "bittensor"))])), noRelayer)))).toMatchObject({ message: "the relayer's key is not named" });
  });

  it("switches MetaMask to each stamp's own chain (964, then 8453) before it is signed, checks the signature is the owner's, then hands it on", async () => {
    const w = world();
    const sink = stampSink();
    stackOf(sink.dir, "frontDoor", [head(w, "base"), head(w, "base") + 12n * BigInt(H)]);
    const p = await sign(w, write(stampFileOf([request("vault", head(w, "bittensor")), request("frontDoor", head(w, "base"), { mode: "stack" })])), { stamps: sink.stamps });
    expect(sink.ready).toEqual(["relay", "stack"]);
    const page = await openPage(p, { accounts: [OWNER.address], chainId: "0x2105" });
    try {
      await page.click("stamp-0");
      // MetaMask was on Base: switched to Bittensor EVM first, then asked to sign there
      const order = page.w.requests.filter((r) => ["wallet_switchEthereumChain", "eth_signTypedData_v4"].includes(r.method)).map((r) => [r.method, r.chainId]);
      expect(order).toEqual([
        ["wallet_switchEthereumChain", "0x2105"],
        ["eth_signTypedData_v4", "0x3c4"],
      ]);
      expect(page.w.of("eth_signTypedData_v4")[0].params?.[0]).toBe(OWNER.address);
      expect(JSON.parse(page.w.of("eth_signTypedData_v4")[0].params?.[1] as string)).toEqual(stampTypedDataJson(964, plan.addresses.vault, head(w, "bittensor")));
      expect(sink.handed).toEqual([{ target: "vault", asOf: head(w, "bittensor"), sig: expect.stringMatching(/^0x[0-9a-f]{130}$/), mode: "relay" }]);
      expect(page.el("stamp-status-0").textContent).toBe("Signed by the owner. Bittensor vault: stamped (transaction 0x77).");
      expect(page.el("stamp-status-0").className).toBe("status good");
      expect(page.el("stamp-0").disabled).toBe(true);
      // then the front door's: back to Base
      await page.click("stamp-1");
      expect(page.w.of("eth_signTypedData_v4").map((r) => r.chainId)).toEqual(["0x3c4", "0x2105"]);
      expect(sink.handed.map((h) => [h.target, h.mode])).toEqual([
        ["vault", "relay"],
        ["frontDoor", "stack"],
      ]);
      // a stamp handed on once is not handed on again
      expect(await p.api?.stamp(0, sink.handed[0].sig)).toEqual({ ok: false, text: "Already handed on: Bittensor vault: stamped (transaction 0x77)." });
      expect(sink.handed).toHaveLength(2);
    } finally {
      await page.close();
    }
  });

  it("a signed stamp that couldn't be handed on says how to hand it on by hand, without signing again", async () => {
    const w = world();
    const sink = stampSink({ ok: false, lines: ["Bittensor vault: the relayer holds 0 TAO: fund it."] });
    const asOf = head(w, "bittensor");
    const p = await sign(w, write(stampFileOf([request("vault", asOf)])), { stamps: sink.stamps });
    const page = await openPage(p, { accounts: [OWNER.address], chainId: "0x3c4" });
    try {
      await page.click("stamp-0");
      const sig = sink.handed[0].sig;
      expect(page.el("stamp-status-0").textContent).toBe(
        `Signed by the owner, but not handed on: Bittensor vault: the relayer holds 0 TAO: fund it. To hand it on without signing again: pnpm ops stamp vault --as-of ${asOf} --sig ${sig} --live`,
      );
      expect(page.el("stamp-0").textContent).toBe("Sign and relay again");
      expect(page.el("stamp-0").disabled).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("a wallet that won't switch is told plainly, and nothing is signed; a signature that isn't the owner's is never handed on", async () => {
    const w = world();
    const sink = stampSink();
    const p = await sign(w, write(stampFileOf([request("vault", head(w, "bittensor"))])), { stamps: sink.stamps });
    const stuck = await openPage(p, { accounts: [OWNER.address], chainId: "0x2105", stuck: true });
    try {
      await stuck.click("stamp-0");
      expect(stuck.w.of("eth_signTypedData_v4")).toEqual([]);
      expect(stuck.el("stamp-status-0").textContent).toBe(
        "MetaMask is still on Base (chain id 8453), not Bittensor EVM (chain id 964). A stamp is signed only on its own chain: switch MetaMask to Bittensor EVM yourself, then click Sign again. Nothing was signed.",
      );
    } finally {
      await stuck.close();
    }
    const declined = await openPage(p, { accounts: [OWNER.address], chainId: "0x2105", declineSwitch: true });
    try {
      await declined.click("stamp-0");
      expect(declined.w.of("eth_signTypedData_v4")).toEqual([]);
      expect(declined.el("stamp-status-0").textContent).toBe(
        "MetaMask didn't switch to Bittensor EVM (chain id 964): you rejected it in MetaMask. A stamp is signed only on its own chain: switch MetaMask to Bittensor EVM yourself, then click Sign again. Nothing was signed.",
      );
    } finally {
      await declined.close();
    }
    // signed with another key (another account behind the owner's address in MetaMask): not handed on
    const wrong = await openPage(p, { accounts: [OWNER.address], chainId: "0x3c4", key: SOMEONE_KEY });
    try {
      await wrong.click("stamp-0");
      expect(wrong.w.of("eth_signTypedData_v4")).toHaveLength(1);
      expect(sink.handed).toEqual([]);
      expect(wrong.el("stamp-status-0").textContent).toBe(
        `Not handed on: the signature is ${privateKeyToAccount(SOMEONE_KEY).address}'s, not the owner ${OWNER.address}'s. Check that MetaMask signed with the owner's Ledger account.`,
      );
      expect(wrong.el("stamp-status-0").className).toBe("status bad");
    } finally {
      await wrong.close();
    }
    // another account selected in MetaMask: nothing asked
    const account = await openPage(p, { accounts: [GUARDIAN], chainId: "0x3c4" });
    try {
      await account.click("stamp-0");
      expect(account.w.of("eth_signTypedData_v4")).toEqual([]);
      expect(account.el("stamp-status-0").textContent).toBe(
        `MetaMask is using ${GUARDIAN}, but this stamp must be signed by the owner, ${OWNER.address}. Nothing was signed. Select that account in MetaMask (your Ledger's), then click Sign again.`,
      );
    } finally {
      await account.close();
    }
  });

  it("says on the button and before the click what the click sends: a relay stamp's also sends stampBySig from the relayer (review, M1)", async () => {
    const w = world();
    const sink = stampSink();
    stackOf(sink.dir, "frontDoor", [head(w, "base")]);
    const p = await sign(w, write(stampFileOf([request("vault", head(w, "bittensor")), request("frontDoor", head(w, "base"), { mode: "stack" })])), { stamps: sink.stamps });
    const html = p.page.html;
    const relay =
      '<p class="note">This click also sends stampBySig to the Vault on Bittensor from the relayer account (OPS_RELAYER_KEYSTORE), once the Ledger has signed: the relayer pays its gas, never the Ledger.</p>\n<button type="button" id="stamp-0" disabled>Sign and relay</button>';
    expect(html).toContain(relay);
    expect(html).toContain(
      '<p class="note">This click sends nothing: it adds the signature to the relayer&#39;s stack (ops/stamps/base.json), which relays it from its time.</p>\n<button type="button" id="stamp-1" disabled>Sign and add to the stack</button>',
    );
    expect(html).toMatch(/Signing a stamp to relay also sends it, from the relayer, on the same click\./);
    const page = await openPage(p, { accounts: [OWNER.address], chainId: "0x3c4" });
    try {
      expect(page.el("stamp-0").textContent).toBe("Sign and relay");
      expect(page.el("stamp-1").textContent).toBe("Sign and add to the stack");
    } finally {
      await page.close();
    }
  });

  it("checks each stack stamp against its stack file when the page is served, by --to-stack's rules, and offers none it would refuse (review, M2)", async () => {
    const w = world();
    const t = head(w, "bittensor") + BigInt(D);
    const go = (sink: ReturnType<typeof stampSink>, asOf = t) => sign(w, write(stampFileOf([request("vault", asOf, { mode: "stack" })])), { stamps: sink.stamps });
    // no stack on this computer (one written on the bot's machine, say)
    const none = stampSink();
    expect((await failure(go(none))).message).toBe(`stamp 1: no stack at ${join(none.dir, "bittensor.json")}: write one with pnpm ops stamp --stack <days>`);
    // another deployment's stack
    const otherDeployment = stampSink();
    const path = stackOf(otherDeployment.dir, "vault", [t], { deployment: "v3.2-other" });
    expect((await failure(go(otherDeployment))).message).toBe(
      `stamp 1: ${path} is for contract ${plan.addresses.vault} on chain 964 of v3.2-other (live), not this deployment's vault ${plan.addresses.vault} on chain 964 of v3.2-launch (live)`,
    );
    // a time that isn't one of the stack's
    const times = stampSink();
    const at = stackOf(times.dir, "vault", [t + 1n]);
    expect((await failure(go(times))).message).toBe(`stamp 1: ${t} is not one of the times in ${at}: sign one of its stamps, or write a new stack with --stack <days>`);
    // a digest that isn't ops's for that time
    const digest = stampSink();
    const d = stackOf(digest.dir, "vault", [t]);
    const s = JSON.parse(readFileSync(d, "utf8")) as StampStack;
    s.stamps[0].digest = `0x${"de".repeat(32)}`;
    writeFileSync(d, JSON.stringify(s));
    expect((await failure(go(digest))).message).toBe(`stamp 1: ${d} holds another digest for ${t} than ops computes: it is not this contract's stack`);
    // the stack's own time: offered
    const good = stampSink();
    stackOf(good.dir, "vault", [t]);
    expect((await go(good)).view.stamps).toHaveLength(1);
  });

  it("a relay that was sent but not confirmed says so, never \"not handed on\" (review, M5)", async () => {
    const w = world();
    const asOf = head(w, "bittensor");
    const hash = `0x${"ee".repeat(32)}` as Hex;
    const signed = async (sink: ReturnType<typeof stampSink>) => {
      const p = await sign(w, write(stampFileOf([request("vault", asOf)])), { stamps: sink.stamps });
      return p.api?.stamp(0, await OWNER.sign({ hash: p.view.stamps?.[0].digest as Hex }));
    };
    expect(await signed(stampSink(new ReceiptTimeout("bittensor", 3, hash)))).toEqual({
      ok: false,
      text: `Signed by the owner and sent (transaction ${hash}), but not confirmed yet: check it on the explorer (https://evm.taostats.io/tx/${hash}) before relaying it again.`,
    });
    const reverted = await signed(stampSink(new RevertedOnChain("bittensor", "the stamp", hash, "StampOutOfWindow()")));
    expect(reverted?.ok).toBe(false);
    expect(reverted?.text).toMatch(new RegExp(`^Signed by the owner and sent \\(transaction ${hash}\\), but it reverted \\(StampOutOfWindow\\(\\)\\)\\. To hand it on without signing again: pnpm ops stamp vault --as-of ${asOf} --sig 0x[0-9a-f]{130} --live$`));
  });
});

describe("Task 47b: the sign page shows the rails of a file of bridge calls, and warns, never refusing", () => {
  const A = () => plan.addresses.baseAdapter;
  const B = () => plan.addresses.bitAdapter;
  const BIT2 = getAddress(`0x${"b2".repeat(20)}`);
  const BASE2 = getAddress(`0x${"a2".repeat(20)}`);
  const withPair = () => {
    const w = world();
    w.book[BIT2.toLowerCase()] = { chain: "bittensor", abi: build.contracts.CcipBittensorAdapter.abi, answers: { remoteChainId: 8_453n, remoteAdapter: BASE2, token: getAddress(`0x${"c2".repeat(20)}`), ...LANE_BIT } };
    w.book[BASE2.toLowerCase()] = { chain: "base", abi: build.contracts.CcipBaseAdapter.abi, answers: { remoteChainId: 964n, remoteAdapter: BIT2, ...LANE_BASE } };
    return w;
  };
  const rails = (cv: { details?: { name: string; lines: string[] }[] }) => cv.details?.find((d) => d.name === "Rails")?.lines;
  const NOT_PASSED = "This file would not pass pnpm ops schedule's rail check now, and it was not written with --one-sided.";

  it("a one-sided disable is served with its warning; both sides in one file agree; a one-sided activation warns too", async () => {
    // the vault's primary disabled alone: the front door's batches go to a bridge the vault no longer takes
    const one = await sign(withPair(), write(fileOf([direct("vault", "disableBridge", [B()])])));
    const disagree = `Once this file and the pending items run, the two chains disagree on the bridge: the front door's primary ${A()} sends to ${B()} on Bittensor, which is not enabled on the vault.`;
    // right after it is sent it is the same pair, said once
    expect(rails(one.view.calls[0])).toEqual([disagree]);
    // a file with no one-sided reason says it would not pass pnpm ops schedule's check (the fix round's Minor 2)
    expect(one.view.warnings).toContain(`${disagree} ${RAIL_RESIDUAL[1]} ${NOT_PASSED}`);
    // the batches' pair alone: the residual's batch half, never its payout half (merge 7a's follow-up)
    expect(one.view.warnings.some((x) => x.includes(RAIL_RESIDUAL[2]))).toBe(false);
    // Task 49's own warning for a primary is still there
    expect(one.view.calls[0].callWarnings?.[0]).toMatch(/^It is the Vault's primary bridge: disabling it closes the exits on Bittensor/);
    // both chains' disables in one file, in order, the front door's first (as pnpm ops schedule both writes it): the two
    // chains agree at the end (nothing crosses) and right after each call, no rails warning
    const calls = [direct("frontDoor", "disableBridge", [A()]), direct("vault", "disableBridge", [B()])];
    const both = await sign(withPair(), write(walletFile({ title: "Cascade v3.2-launch: both disables", deployment: "v3.2-launch", now: NOW, ordered: true, calls })));
    const agree = "Once this file and the pending items run, the two chains agree on the bridge: both primaries are disabled, so nothing crosses either way until the owner makes an enabled bridge the primary on each chain.";
    const inOrder = "Right after each of its calls is sent, in order, before any pending item runs, the two chains agree on the bridge too.";
    expect(both.view.calls.map(rails)).toEqual([
      [agree, inOrder],
      [agree, inOrder],
    ]);
    expect(both.view.warnings.filter((x) => x.includes("bridge"))).toEqual([]);
    // the same file in no fixed order (as retire-pair writes it): judged at its worst order, the vault's call first
    const loose = await sign(withPair(), write(fileOf(calls)));
    const worst = `The file fixes no order: sent first, disableBridge(${B()}) on the vault (Bittensor) would leave the two chains disagreeing on the bridge before any pending item runs: the front door's primary ${A()} sends to ${B()} on Bittensor, which is not enabled on the vault.`;
    expect(loose.view.calls.map(rails)).toEqual([
      [agree, worst],
      [agree, worst],
    ]);
    expect(loose.view.warnings).toContain(`${worst} ${RAIL_RESIDUAL[1]}`);
    // the vault's activation of B2 alone: its other half A2 is one the front door has never enabled; nothing at once
    const half = await sign(withPair(), write(fileOf([sched("vault", "schedule", setter("vault", "activateBridge", [BIT2]))])));
    const alone = `Once this file and the pending items run, the two chains disagree on the bridge: ${BIT2} would be enabled on the vault alone: its other half, ${BASE2} on Base, the front door has never enabled, nor is it pending there or in this file.`;
    expect(rails(half.view.calls[0])).toEqual([alone]);
    // a half on the vault's side is the payouts' (the vault would send through it): the payout half
    expect(half.view.warnings).toContain(`${alone} ${RAIL_RESIDUAL[2]} ${NOT_PASSED}`);
    // a file of no bridge call reads no rails
    const w = withPair();
    await sign(w, write(fileOf([direct("vault", "pause", [])])));
    expect(w.calls.some((c) => c.method === "eth_call" && c.data?.startsWith(toFunctionSelector("remoteAdapter()")))).toBe(false);
  });

  it("the warning names the residual's half that applies (merge 7a's follow-up): the payout half for the payouts' pair alone, not the batch half; both halves when both pairs disagree", async () => {
    // the vault switches to B2 alone (enabled there, beside B); its Base half A2 the front door has never enabled
    const payouts = withPair();
    payouts.book[plan.addresses.vaultLens.toLowerCase()].answers.bridgeEnabled = (args: readonly unknown[]) => sameText(args[0], B()) || sameText(args[0], BIT2);
    const p = await sign(payouts, write(fileOf([direct("vault", "setPrimaryBridge", [BIT2])])));
    const what = `Once this file and the pending items run, the two chains disagree on the bridge: the vault's primary ${BIT2} sends to ${BASE2} on Base, which the front door has never enabled.`;
    expect(rails(p.view.calls[0])).toEqual([what]);
    expect(p.view.warnings).toContain(`${what} ${RAIL_RESIDUAL[2]} ${NOT_PASSED}`);
    expect(p.view.warnings.some((x) => x.includes(RAIL_RESIDUAL[1]))).toBe(false);
    // the same switch with B already disabled on the vault: the front door's batches are refused too, so both halves
    const both = withPair();
    both.book[plan.addresses.vaultLens.toLowerCase()].answers.bridgeEnabled = (args: readonly unknown[]) => sameText(args[0], BIT2);
    const q = await sign(both, write(fileOf([direct("vault", "setPrimaryBridge", [BIT2])])));
    const end = q.view.warnings.find((x) => x.startsWith("Once this file and the pending items run, the two chains disagree"));
    expect(end).toMatch(/the front door's primary .* is not enabled on the vault; and the vault's primary .* which the front door has never enabled\./);
    expect(end?.endsWith(`. ${RAIL_RESIDUAL[1]} ${RAIL_RESIDUAL[2]} ${NOT_PASSED}`)).toBe(true);
  });

  it("a file written one-sided shows its reason; rails that can't be read warn, never agreeing, and the page is still served", async () => {
    const why = "the vault moves first";
    const file = walletFile({ title: "Cascade v3.2-launch: one-sided", deployment: "v3.2-launch", now: NOW, calls: [direct("vault", "disableBridge", [B()])], oneSided: why });
    const p = await sign(withPair(), write(file));
    expect(p.view.warnings).toContain(`This file was written one-sided, past the rail check (pnpm ops schedule --one-sided), for this reason: "${why}".`);
    // its rails warning, with no word of a check it didn't pass: it was written past it
    expect(p.view.warnings).toContain(
      `Once this file and the pending items run, the two chains disagree on the bridge: the front door's primary ${A()} sends to ${B()} on Bittensor, which is not enabled on the vault. ${RAIL_RESIDUAL[1]}`,
    );
    expect(p.view.warnings.some((x) => x.includes(NOT_PASSED))).toBe(false);
    // unread: a warning and a row that say so
    const w = withPair();
    w.book[plan.addresses.doorLens.toLowerCase()].answers.bridgeEnabled = new RpcError("header not found", -32000);
    const u = await sign(w, write(fileOf([direct("frontDoor", "disableBridge", [A()]), direct("vault", "disableBridge", [B()])])));
    expect(rails(u.view.calls[0])).toEqual(["Couldn't be read right now (header not found)."]);
    expect(u.view.warnings).toContain("Whether the two chains will agree on the bridge once this file runs couldn't be read right now (header not found): don't take it that they will.");
    expect(u.view.warnings.some((x) => x.includes("agree on the bridge:"))).toBe(false);
  });

  it("a direct call is judged right after it is sent, as pnpm ops schedule judges it: the front door's switch while the vault's activation is pending warns, naming the item", async () => {
    // the front door's A disabled and A2 enabled there (its activation executed); the vault's B2 still pending
    const w = withPair();
    w.book[plan.addresses.doorLens.toLowerCase()].answers.bridgeEnabled = (args: readonly unknown[]) => sameText(args[0], BASE2);
    w.book[plan.addresses.doorLens.toLowerCase()].answers.bridgeKnown = (args: readonly unknown[]) => sameText(args[0], A()) || sameText(args[0], BASE2);
    const b2 = put(w, "vault", "activateBridge", [BIT2], HEAD_TIME - D);
    const p = await sign(w, write(fileOf([direct("frontDoor", "setPrimaryBridge", [BASE2])])));
    const step = `Right after setPrimaryBridge(${BASE2}) on the front door (Base) is sent, before any pending item runs, the two chains disagree on the bridge: the front door's primary ${BASE2} sends to ${BIT2} on Bittensor, which is not enabled on the vault. Execute this pending item before this file: item ${b2.id}, activateBridge(${BIT2}) on the vault (pnpm ops execute ${b2.id} --on vault --for-wallet --live).`;
    expect(rails(p.view.calls[0])).toEqual([
      `Once this file and the pending items run, the two chains agree on the bridge: the front door's primary ${BASE2} sends to ${BIT2} on Bittensor, enabled on the vault; the vault's primary ${B()} sends to ${A()} on Base, which the front door has enabled.`,
      step,
    ]);
    expect(p.view.warnings).toContain(`${step} ${RAIL_RESIDUAL[1]}`);
    // the activation executed: no warning, and the row says so
    const done = withPair();
    done.book[plan.addresses.doorLens.toLowerCase()].answers.bridgeEnabled = (args: readonly unknown[]) => sameText(args[0], BASE2);
    done.book[plan.addresses.doorLens.toLowerCase()].answers.bridgeKnown = (args: readonly unknown[]) => sameText(args[0], A()) || sameText(args[0], BASE2);
    done.book[plan.addresses.vaultLens.toLowerCase()].answers.bridgeEnabled = (args: readonly unknown[]) => sameText(args[0], B()) || sameText(args[0], BIT2);
    const q = await sign(done, write(fileOf([direct("frontDoor", "setPrimaryBridge", [BASE2])])));
    expect(rails(q.view.calls[0])?.[1]).toBe("Right after it is sent, before any pending item runs, the two chains agree on the bridge too.");
    expect(q.view.warnings.filter((x) => x.includes("bridge"))).toEqual([]);
  });

  it("an execute of an activation shows the rails right after it runs, and warns when the two chains would then disagree", async () => {
    // both launch halves disabled (both primaries); the front door's Reopen of A ready, the vault's B not reopened
    const w = withPair();
    w.book[plan.addresses.doorLens.toLowerCase()].answers.bridgeEnabled = false;
    w.book[plan.addresses.vaultLens.toLowerCase()].answers.bridgeEnabled = false;
    const reopenA = put(w, "frontDoor", "activateBridge", [A()], HEAD_TIME - 8 * D);
    const p = await sign(w, write(fileOf([sched("frontDoor", "execute", reopenA.data)])));
    const step = `Right after execute(activateBridge(${A()})) on the front door (Base) is sent, before any other pending item runs, the two chains disagree on the bridge: the front door's primary ${A()} sends to ${B()} on Bittensor, which is not enabled on the vault.`;
    expect(rails(p.view.calls[0])).toEqual([step]);
    expect(p.view.warnings).toContain(`${step} ${RAIL_RESIDUAL[1]}`);
    // the vault's Reopen of B instead: the vault's payouts reach A, which the front door once enabled
    const reopenB = put(w, "vault", "activateBridge", [B()], HEAD_TIME - 8 * D);
    const q = await sign(w, write(fileOf([sched("vault", "execute", reopenB.data)])));
    expect(rails(q.view.calls[0])).toEqual([
      `Right after it runs, the two chains agree on the bridge: the front door's primary ${A()} is disabled, so it sends nothing; the vault's primary ${B()} sends to ${A()} on Base, which the front door has enabled.`,
    ]);
    expect(q.view.warnings.filter((x) => x.includes("bridge"))).toEqual([]);
  });
});

describe("Task 53's fix round: the sign page's four missing calls (setKeeper, fundReserve, the guardian's disableBridge, an immediate setIdleBuffer raise)", () => {
  const NEW_KEEPER = at("4e4e");
  it("each is the contracts' own: its signature, who may send it, and whether it takes value, as contracts/src declares it", () => {
    const src = (path: string) => readFileSync(new URL(`../../contracts/src/${path}`, import.meta.url), "utf8");
    const sig = (name: string) => toFunctionSignature(KNOWN_ABI.find((f) => f.name === name) as never);
    expect([sig("setKeeper"), sig("fundReserve"), sig("disableBridge"), sig("setIdleBuffer")]).toEqual(["setKeeper(address)", "fundReserve()", "disableBridge(address)", "setIdleBuffer(uint256)"]);
    expect(src("CascadeVault.sol")).toContain("function setKeeper(address newKeeper) external onlyOwner {");
    expect(src("CascadeFrontDoor.sol")).toContain("function setKeeper(address newKeeper) external onlyOwner {");
    expect(src("CascadeVault.sol")).toContain("function setIdleBuffer(uint256 bps) external onlyOwner {");
    expect(src("CascadeBase.sol")).toMatch(/function disableBridge\(address bridge\) external \{\s+Actor a = _actor\(\);/);
    expect(src("adapters/CcipBittensorAdapter.sol")).toContain("function fundReserve() external payable {");
    expect((KNOWN_ABI.find((f) => f.name === "fundReserve") as { stateMutability: string }).stateMutability).toBe("payable");
  });

  it("setKeeper on both contracts, from the owner only, at once", async () => {
    const w = world();
    const p = await sign(w, write(fileOf([direct("frontDoor", "setKeeper", [NEW_KEEPER]), direct("vault", "setKeeper", [NEW_KEEPER])])));
    expect(p.view.calls.map((c) => [c.heading, c.senderRole])).toEqual([
      [`setKeeper(${NEW_KEEPER}) on the Front door (Base)`, "the owner the Front door names now"],
      [`setKeeper(${NEW_KEEPER}) on the Vault (Bittensor)`, "the owner the Vault names now"],
    ]);
    expect(p.view.calls[1].effect).toBe(`setKeeper(${NEW_KEEPER}): makes ${NEW_KEEPER} the Vault's keeper on Bittensor, at once (the keeper Worker sends nothing until its key is keeper() on both chains)`);
    expect((await failure(sign(w, write(fileOf([direct("vault", "setKeeper", [NEW_KEEPER], GUARDIAN)])))))).toMatchObject({ message: expect.stringMatching(/^call 1: 0x[0-9a-fA-F]{40} is not a role .* that may send setKeeper\(\) to the Vault on Bittensor/) });
  });

  it("fundReserve() on the Bittensor adapter: anyone, carrying value up to its reserve's target; value on any other call, or above it, refused", async () => {
    const w = world();
    const fund = (value: bigint, from: Address = other): NewWalletCall => ({ chainId: 964, to: plan.addresses.bitAdapter, data: encodeFunctionData({ abi: KNOWN_ABI, functionName: "fundReserve" }), label: "fundReserve() by hand", from, value });
    const p = await sign(w, write(fileOf([fund(1_000_500_000_000_000n)])));
    expect([p.view.calls[0].heading, p.view.calls[0].valueText, p.view.calls[0].senderRole]).toEqual([
      "fundReserve() on the Bittensor adapter (Bittensor)",
      "0.0010005 TAO",
      "the account given with --from; anyone may send this",
    ]);
    expect(p.page.html).toContain("<dt>Value</dt><dd>0.0010005 TAO</dd>");
    expect((await failure(sign(w, write(fileOf([fund(10n ** 16n)])))))).toMatchObject({ message: "call 1: it carries 0.01 TAO, more than the 0.0010005 TAO fundReserve() may carry" });
    expect((await failure(sign(w, write(fileOf([{ ...direct("vault", "setKeeper", [NEW_KEEPER]), value: 1n }])))))).toMatchObject({ message: "call 1: it carries 0.000000000000000001 TAO, but setKeeper() takes no value" });
  });

  it("merge 7b (R4, F-1): the token cushion's approve and fundCushion, from anyone: the approve only on the adapter's own token, only for the adapter, each at most the cushion's target", async () => {
    const w = world();
    // the adapter's bridged token, as its token() answers
    const TOKEN = getAddress(`0x${"c2".repeat(20)}`);
    const amount = 10n ** 15n;
    const approve = (o: { to?: Address; spender?: Address; amount?: bigint } = {}): NewWalletCall => ({
      chainId: 964,
      to: o.to ?? TOKEN,
      data: encodeFunctionData({ abi: KNOWN_ABI, functionName: "approve", args: [o.spender ?? plan.addresses.bitAdapter, o.amount ?? amount] }),
      label: "approve(the adapter) by hand",
      from: other,
    });
    const fund = (n: bigint = amount): NewWalletCall => ({ chainId: 964, to: plan.addresses.bitAdapter, data: encodeFunctionData({ abi: KNOWN_ABI, functionName: "fundCushion", args: [n] }), label: "fundCushion(...) by hand", from: other });
    // as pnpm ops fund-cushion writes them: one ordered file, approve then fundCushion of the same amount (merge 7b, M4)
    const pair = (calls: NewWalletCall[], ordered = true) => walletFile({ title: "Cascade v3.2-launch: fund the cushion", deployment: "v3.2-launch", now: NOW, calls, ordered });
    const p = await sign(w, write(pair([approve(), fund()])));
    expect(p.view.calls.map((c) => [c.heading, c.senderRole])).toEqual([
      [`approve(${plan.addresses.bitAdapter}, 1000000000000000) on the FM-TAO token (Bittensor)`, "the account given with --from; anyone may send this"],
      ["fundCushion(1000000000000000) on the Bittensor adapter (Bittensor)", "the account given with --from; anyone may send this"],
    ]);
    expect(p.view.calls[0].effect).toBe(
      `approve(${plan.addresses.bitAdapter}, 1000000000000000): lets ${plan.addresses.bitAdapter}, the Bittensor adapter, take up to 0.001 FM-TAO from the sender, for its token cushion (fundCushion, the next call)`,
    );
    expect(p.view.calls[1].effect).toBe(
      "fundCushion(1000000000000000): pulls 0.001 FM-TAO from the sender (the approve before it allows it) and books it in the Bittensor adapter's token cushion (tokenCushion; its target 0.001 FM-TAO)",
    );
    // an approve for anyone but the adapter, or above the target, or on another token; a fundCushion above the target
    expect((await failure(sign(w, write(pair([approve({ spender: other }), fund()])))))).toMatchObject({
      message: `call 1: approve() names ${other} as its spender, not the record's Bittensor adapter ${plan.addresses.bitAdapter}: the page approves FM-TAO only for the adapter's token cushion`,
    });
    expect((await failure(sign(w, write(pair([approve({ amount: amount + 1n }), fund(amount + 1n)])))))).toMatchObject({
      message: "call 1: approve() is for 0.001000000000000001 FM-TAO, more than the token cushion's 0.001 FM-TAO target",
    });
    expect((await failure(sign(w, write(pair([approve({ to: another }), fund()])))))).toMatchObject({
      message: `call 1: ${another} on Bittensor EVM is not one of this deployment's contracts nor an oracle pool: refusing to show it for signing`,
    });
    // merge 7b (M4): only that shape; anything else refused, saying what is wrong
    const shape = (why: string) => `the token cushion's calls go only as pnpm ops fund-cushion writes them: one ordered file of two calls, approve then fundCushion of the same amount (${why}); nothing served`;
    for (const [calls, ordered, why] of [
      [[approve(), fund()], false, "this file isn't ordered"],
      [[fund()], true, "this file holds 1 call"],
      [[approve()], true, "this file holds 1 call"],
      [[fund(), approve()], true, "its calls are fundCushion() then approve()"],
      [[approve(), approve()], true, "its calls are approve() then approve()"],
      [[approve(), fund(), fund()], true, "this file holds 3 calls"],
      [[approve({ amount: amount / 2n }), fund()], true, "the approve is for 0.0005 FM-TAO and fundCushion for 0.001"],
      [[approve(), fund(), { chainId: 964, to: plan.addresses.bitAdapter, data: encodeFunctionData({ abi: KNOWN_ABI, functionName: "fundReserve" }), label: "fundReserve() by hand", from: other }], true, "this file holds 3 calls"],
    ] as const) {
      expect((await failure(sign(w, write(pair([...calls], ordered))))).message, why).toBe(shape(why));
    }
    // the adapter's token() unread: nothing served
    w.book[plan.addresses.bitAdapter.toLowerCase()].answers.token = new RpcError("header not found", -32000);
    expect((await failure(sign(w, write(pair([approve(), fund()])))))).toMatchObject({ message: "the Bittensor adapter's token() could not be read (header not found): the page sends an approve only to it; nothing served" });
  });

  it("the guardian's disableBridge is shown as the guardian's, saying what it closes", async () => {
    const w = world();
    const p = await sign(w, write(fileOf([direct("frontDoor", "disableBridge", [plan.addresses.baseAdapter], GUARDIAN)])));
    expect([p.view.calls[0].heading, p.view.calls[0].senderRole]).toEqual([`disableBridge(${plan.addresses.baseAdapter}) on the Front door (Base)`, "the guardian the Front door names now"]);
  });

  it("R5 Minor 3: setClaimGasRequired, the owner's direct call: its move shown, a value outside the vault's bounds refused when the page is served", async () => {
    const src = readFileSync(new URL("../../contracts/src/CascadeVault.sol", import.meta.url), "utf8");
    expect(src).toContain("function setClaimGasRequired(uint256 gasRequired) external onlyOwner {");
    expect(toFunctionSignature(KNOWN_ABI.find((f) => f.name === "setClaimGasRequired") as never)).toBe("setClaimGasRequired(uint256)");
    const w = world();
    w.book[plan.addresses.vaultLens.toLowerCase()].answers.claimGasRequired = 55_000_000n;
    const up = await sign(w, write(fileOf([direct("vault", "setClaimGasRequired", [58_000_000n])])));
    expect(up.view.calls[0].effect).toBe("setClaimGasRequired(58000000): moves the Vault's claimGasRequired from 55,000,000 to 58,000,000 at once (immediate either way, within 54,100,000 to 63,400,000)");
    expect(await failure(sign(w, write(fileOf([direct("vault", "setClaimGasRequired", [63_400_001n])]))))).toMatchObject({
      message: "call 1: setClaimGasRequired(63400001) is outside the Vault's bounds, 54,100,000 to 63,400,000 (MIN_CLAIM_GAS and MAX_CLAIM_GAS): the Vault would refuse it",
    });
  });

  it("setIdleBuffer, the owner's direct call: a raise shown, a lowering refused when the page is served (it waits 48 hours, scheduled)", async () => {
    const w = world();
    w.book[plan.addresses.vaultLens.toLowerCase()].answers.idleBufferBps = 100;
    const up = await sign(w, write(fileOf([direct("vault", "setIdleBuffer", [240n])])));
    expect(up.view.calls[0].effect).toBe("setIdleBuffer(240): raises the Vault's idleBufferBps from 100 to 240 at once (a lowering waits 48 hours, scheduled)");
    expect((await failure(sign(w, write(fileOf([direct("vault", "setIdleBuffer", [50n])])))))).toMatchObject({
      message: "call 1: setIdleBuffer(50) would lower the Vault's idle buffer (100 now): a lowering is a scheduled item (pnpm ops schedule vault setIdleBuffer 50 --for-wallet --live), never a direct call",
    });
  });
});

describe("R4 (D-L4): the guardian's emergency pause, from an offline file, served while ops' RPCs are down", () => {
  /** Both chains' RPCs down: every request fails, and is counted */
  const dead = () => {
    const asked: string[] = [];
    const rpc: Rpc = {
      async request(chain, method) {
        asked.push(`${chain}:${method}`);
        throw new RpcError("connect ECONNREFUSED", -32603);
      },
    };
    return { asked, ctx: { rpc, targets: LIVE } };
  };
  const offline = (calls: NewWalletCall[]) => walletFile({ title: "Cascade v3.2-launch: pause both, offline", deployment: "v3.2-launch", now: NOW, calls, offline: true });

  it("serves the guardian's pause of both, with no chain read at all, the record's contracts, chain ids and guardian, and says so", async () => {
    const d = dead();
    const page = await sign(world(), write(offline([direct("frontDoor", "pause", [], GUARDIAN), direct("vault", "pause", [], GUARDIAN)])), { ctx: d.ctx });
    expect(d.asked).toEqual([]);
    expect(page.view.calls.map((c) => [c.chainId, c.to, c.from, c.heading])).toEqual([
      [8453, plan.addresses.frontDoor, GUARDIAN, "pause() on the Front door (Base)"],
      [964, plan.addresses.vault, GUARDIAN, "pause() on the Vault (Bittensor)"],
    ]);
    expect(page.view.warnings).toContain(
      "An offline file: nothing was read from the chains, when it was written or now. Its contracts, chain ids and sender are the deployment record's, and MetaMask sets the gas and fees over its own network. If the guardian has changed since, MetaMask won't send it from the old account, or the call reverts.",
    );
  });

  it("an offline file serves pause() alone, from the record's guardian or owner, on the record's contracts: anything else is refused, nothing served", async () => {
    const d = dead();
    for (const [calls, why] of [
      [[direct("vault", "unpause", [])], "call 1 is unpause() on the vault (Bittensor): an offline file serves pause() alone; nothing served"],
      [[direct("vault", "pause", [], at("5e7"))], `call 1 comes from ${at("5e7")}, not the record's guardian or owner: an offline file serves pause() alone; nothing served`],
      [[{ ...direct("vault", "pause", [], GUARDIAN), to: at("ba0d") }], `call 1 is sent to ${at("ba0d")}, not the record's vault or front door: an offline file serves pause() alone; nothing served`],
    ] as const) {
      expect((await failure(sign(world(), write(offline([...calls])), { ctx: d.ctx }))).message).toBe(why);
    }
    expect(d.asked).toEqual([]);
  });
});
