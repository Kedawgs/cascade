import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
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
  keccak256,
  numberToHex,
  hexToNumber,
  parseAbi,
  stringToBytes,
  toFunctionSelector,
} from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "../src/args.ts";
import { type ChainName, PRECOMPILE, paths, targets } from "../src/config.ts";
import { type Payout, payoutsHash } from "../src/keeper/payouts.ts";
import { type Rpc, RpcError } from "../src/rpc.ts";
import { parseWalletFile } from "../src/wallet.ts";
import { BITTENSOR_TX_GAS_CEILING } from "../src/keeper/core/ceiling.ts";
import { RAIL_VIEW_CALL_GAS } from "../src/keeper/core/v32/reads.ts";
import { capsWarning } from "../src/v32/settings.ts";
import { type BuildRefV32, type BuildV32, buildErrorsV32, freezeBuildV32, type SourceV32, writeBuildV32 } from "../src/v32/build.ts";
import type { DeploymentRecordV32 } from "../src/v32/deploy.ts";
import type { PlanV32 } from "../src/v32/plan.ts";
import {
  cancelCall,
  cancelCommand,
  cancelPayoutsCommand,
  DIRECTIONS,
  executeCall,
  executeCommand,
  iso,
  WRITE_OFF_EXECUTE_GAS,
  lapsed,
  looseningOf,
  pendingCommand,
  pendingItems,
  SCHEDULED_IF_LOOSENS,
  SCHEDULER_ABI,
  type SchedulerContract,
  scheduleCall,
  scheduleCommand,
  stateOf,
} from "../src/v32/scheduler.ts";
import {
  pendingRailChanges,
  problemsText,
  RAIL_RESIDUAL,
  type RailState,
  railCancelCommand,
  railCoherence,
  railExecuteCommand,
  railScheduleCommand,
  railsFindings,
  railVerdict,
  readRails,
  residualFor,
} from "../src/v32/rails.ts";
import { schedulerFileCommand } from "../src/v32/commands.ts";
import { MONITOR_DIRECTIONS_SOURCE, monitorDirections } from "./monitor-directions.ts";
import { tempDir } from "./v32-chains.ts";
import { planV32, TAO_BOT, YUMA } from "./v32-fixtures.ts";

// Task 47: the owner's scheduled changes (spec §3.6) as wallet-call files for the sign page: schedule, the pending items
// (from the logs, judged by the lenses), execute and cancel, and the owner's cancel of a payout batch (ruling A16). Two
// fake chains answer the vault, the front door and their lenses with the frozen build's own ABIs; every refusal is
// checked to write no file. Nothing is sent, and no key, network or forge is used.

const CONTRACTS = paths({}).contractsDir;
const SOURCE: SourceV32 = { commit: "c0ffee".padEnd(40, "0"), tree: "7ee".padEnd(40, "0"), dirty: [] };
const LIVE = targets({}).live;
const E18 = 10n ** 18n;
const RAO = 10n ** 9n;
const H = 3_600;
const D = 86_400;
const DELAYS = [48 * H, 7 * D, 8 * D] as const; // Param, Registry, Guardian
const WINDOW = 7 * D;
const HEAD_TIME = 1_900_000_000;
/** Each chain's seconds a block: Bittensor's 12, Base's 0.2 since block 53,556,128 (five blocks to a whole-second timestamp). */
const SPB: Record<ChainName, number> = { bittensor: 12, base: 0.2 };
/** Each scheduler's MS_PER_BLOCK, the deploy's calibration (Revision 28): Bittensor 7,200 ms, Base 120 ms. */
const MS: Record<ChainName, number> = { bittensor: 7_200, base: 120 };
/** CascadeBase._halfInBlocks: ceil(secs * 1000 / (2 * MS_PER_BLOCK)). */
const halfBlocks = (secs: number, chain: ChainName) => Math.ceil((secs * 1000) / (2 * MS[chain]));
const CREATED: Record<ChainName, number> = { bittensor: 1_000_000, base: 10_000_000 };
const other = getAddress(`0x${"5e".repeat(20)}`);
const another = getAddress(`0x${"6f".repeat(20)}`);
const user1 = getAddress(`0x${"71".repeat(20)}`);
const user2 = getAddress(`0x${"72".repeat(20)}`);
const user3 = getAddress(`0x${"73".repeat(20)}`);
/** A second adapter pair (Task 47b): its Bittensor half and its Base half, each the other's peer. */
const BIT2 = getAddress(`0x${"b2".repeat(20)}`);
const BASE2 = getAddress(`0x${"a2".repeat(20)}`);
/** Each chain's lane settings every adapter there shares (R4, C-L4), and what a Bittensor adapter's parks owe (none) */
const LANE = {
  bittensor: { router: getAddress(`0x${"c1".repeat(20)}`), token: getAddress(`0x${"c2".repeat(20)}`), remoteSelector: 15_971_525_489_660_198_786n, alphaVault: getAddress(`0x${"c3".repeat(20)}`), parkedNative: 0n, parkedTokens: 0n },
  base: { router: getAddress(`0x${"c4".repeat(20)}`), token: getAddress(`0x${"c5".repeat(20)}`), remoteSelector: 2_135_107_236_357_186_872n },
};

let build: BuildV32;
let plan: PlanV32;
let buildsDir: string;
let ref: BuildRefV32;

beforeAll(async () => {
  build = (await freezeBuildV32(CONTRACTS, SOURCE)).build;
  plan = planV32();
  buildsDir = tempDir("scheduler-builds");
  const text = `${JSON.stringify(build, null, 2)}\n`;
  ref = writeBuildV32(buildsDir, { text, hash: keccak256(stringToBytes(text)) });
});

const CHAIN: Record<SchedulerContract, ChainName> = { vault: "bittensor", frontDoor: "base" };
const abiOf = (c: SchedulerContract): Abi => (c === "vault" ? build.vaultAbi : build.contracts.CascadeFrontDoor.abi);
const lensAbiOf = (c: SchedulerContract): Abi => build.contracts[c === "vault" ? "CascadeVaultLens" : "CascadeDoorLens"].abi;
const norm = (v: unknown): unknown => (typeof v === "number" ? BigInt(v) : typeof v === "string" ? v.toLowerCase() : v);

function record(p: PlanV32 = plan): DeploymentRecordV32 {
  const sent = (block: number, address: Address) => ({ hash: `0x${"ab".repeat(32)}` as Hex, block, gasUsed: 1n, costWei: 1n, address });
  return {
    target: "live",
    createdAt: "2026-11-07T00:00:00.000Z",
    plan: p,
    build: ref,
    done: { vault: sent(CREATED.bittensor, p.addresses.vault), frontDoor: sent(CREATED.base, p.addresses.frontDoor) },
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
  items: Record<SchedulerContract, Map<string, Item>>;
  clocks: Record<SchedulerContract, { owner: bigint; guardian: bigint }>;
  book: Record<string, { chain: ChainName; abi: Abi; answers: Record<string, Answer> }>;
  /** eth_getLogs on this chain fails (the node's own error) */
  logsFail?: ChainName;
  /** every Ordinary schedule reverts ExitsNotOpen */
  exitsClosed?: boolean;
  /** each chain's seconds a block in this world, when not SPB's (a chain slower than its calibration) */
  spb?: Record<ChainName, number>;
  calls: { chain: ChainName; method: string; to?: string; from?: string; data?: Hex; block?: string; gas?: string }[];
  /** the vault's payout batches, by key */
  batches: Map<string, Batch>;
  /** the vault coldkey's root stake on each hotkey, in rao */
  stakes: Map<string, bigint>;
  /** each address's code (eth_getCode), on either chain: none, a plain account, unless set */
  codes: Record<string, Hex>;
  /** each side's bridges (Task 47b): its primary, and the bridges enabled on it (lower-case) */
  rails: Record<SchedulerContract, { primary: Address; enabled: Set<string>; known: Set<string> }>;
}

const spbOf = (w: World, chain: ChainName) => (w.spb ?? SPB)[chain];
const timeOf = (w: World, chain: ChainName, n: number) => HEAD_TIME - Math.ceil(spbOf(w, chain) * (w.heads[chain] - n) - 1e-9);
const blockAt = (w: World, chain: ChainName, t: number) => w.heads[chain] - Math.ceil((HEAD_TIME - t) / spbOf(w, chain));
const revert = (name: string, args: unknown[] = []) => new RpcError("execution reverted", 3, encodeErrorResult({ abi: buildErrorsV32(build), errorName: name, args } as never));
const sameText = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

/** What each scheduler contract's _classify accepts and at how many words, written here from the contracts' source (as
 * test/v32-verify.test.ts does), not from ops's table. */
const CLASSIFY: Record<SchedulerContract, Record<string, number>> = {
  vault: {
    activateFrontDoor: 2,
    writeOffMissingStake: 1,
    setStakeHotkey: 1,
    setMaxTotalAssets: 1,
    setPayoutDelay: 1,
    setRewardVesting: 1,
    setIdleBuffer: 1,
    setFeeLimits: 2,
    setRewardCut: 2,
    moveStake: 3,
    setMessageLimits: 3,
    setOutflowLimits: 3,
    setGuardian: 1,
    transferOwnership: 1,
    activateBridge: 1,
  },
  frontDoor: { setOracle: 1, setSwapper: 1, setMaxDeliverySlippage: 1, setBatchInterval: 1, setMaxBatchValue: 1, setMinPoolLiquidity: 2, setGuardian: 1, transferOwnership: 1, activateBridge: 1 },
};

const fnBySelector = (abi: Abi, data: Hex) => abi.find((x): x is AbiFunction => x.type === "function" && toFunctionSelector(x) === data.slice(0, 10).toLowerCase());

/** A scheduler's `schedule`, as its contract decides: only from the owner; UnknownSelector for a selector it does not
 * classify, BadCalldata off its canonical length, ExitsNotOpen while the world's exits are closed; else the id. */
const scheduler = (c: SchedulerContract) => (args: readonly unknown[], from?: string) => {
  if (!sameText(from, plan.roles.owner)) return revert("OwnableUnauthorizedAccount", [from ?? other]);
  const data = args[0] as Hex;
  const fn = fnBySelector(abiOf(c), data)?.name;
  if (!fn || CLASSIFY[c][fn] === undefined) return revert("UnknownSelector");
  if ((data.length - 10) / 64 !== CLASSIFY[c][fn]) return revert("BadCalldata");
  if (fn !== "setGuardian" && fn !== "activateBridge" && worldNow?.exitsClosed) return revert("ExitsNotOpen");
  if (fn === "activateBridge" && worldNow?.rails[c].enabled.has(`0x${data.slice(34, 74)}`.toLowerCase())) return revert("AlreadyActive");
  return keccak256(data);
};

/** An eth_call's raw answer, given back as it is (not encoded by the function's ABI). */
class RawAnswer {
  readonly data: Hex;
  constructor(data: Hex) {
    this.data = data;
  }
}

let worldNow: World | undefined;

/** The scheduler's cancel as its contract decides: NoProposal for nothing pending, NotCanceller for a guardian's cancel of
 * a GuardianSwap or a Reopen, or for anyone else. */
const canceller = (c: SchedulerContract) => (args: readonly unknown[], from?: string) => {
  const it = worldNow!.items[c].get(String(args[0]).toLowerCase());
  if (!it || it.readyAt === 0n) return revert("NoProposal");
  if (sameText(from, plan.roles.owner)) return undefined;
  if (sameText(from, plan.roles.guardian) && it.kind === 0) return undefined;
  return revert("NotCanceller");
};

/** The vault's cancelPayoutBatch, as L3 decides: the list must hash to the batch's, and something must be left to
 * re-mint. */
const batchCanceller = (args: readonly unknown[], from?: string) => {
  if (!sameText(from, plan.roles.owner)) return revert("OwnableUnauthorizedAccount", [from ?? other]);
  const b = worldNow!.batches.get(String(args[0]).toLowerCase());
  const list = args[1] as readonly Payout[];
  if (!b || b.cursor >= b.count) return revert("NotPending");
  if (list.length !== b.count || payoutsHash(list) !== b.payoutsHash) return revert("PayoutsMismatch");
  if (list.slice(b.cursor).every((p) => p.shares === 0n)) return revert("NothingToCancel");
  return undefined;
};

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

/** A deployment on the two chains, nothing scheduled, every limit at a plain value. */
function world(): World {
  const a = plan.addresses;
  const r = plan.roles;
  const w: World = {
    heads: { bittensor: 3_000_000, base: 30_000_000 },
    logs: { bittensor: [], base: [] },
    items: { vault: new Map(), frontDoor: new Map() },
    clocks: { vault: { owner: 0n, guardian: 0n }, frontDoor: { owner: 0n, guardian: 0n } },
    book: {},
    calls: [],
    batches: new Map(),
    stakes: new Map(),
    codes: {},
    rails: {
      vault: { primary: a.bitAdapter, enabled: new Set([a.bitAdapter.toLowerCase()]), known: new Set([a.bitAdapter.toLowerCase()]) },
      frontDoor: { primary: a.baseAdapter, enabled: new Set([a.baseAdapter.toLowerCase()]), known: new Set([a.baseAdapter.toLowerCase()]) },
    },
  };
  const lensAnswers = (c: SchedulerContract): Record<string, Answer> => ({
    guardian: r.guardian,
    scheduled: (args: readonly unknown[]) => w.items[c].get(String(args[0]).toLowerCase()) ?? EMPTY_ITEM,
    lastOwnerClose: () => w.clocks[c].owner,
    lastGuardianClose: () => w.clocks[c].guardian,
    PARAM_DELAY: BigInt(DELAYS[0]),
    REGISTRY_DELAY: BigInt(DELAYS[1]),
    GUARDIAN_DELAY: BigInt(DELAYS[2]),
    EXECUTE_WINDOW: BigInt(WINDOW),
    MS_PER_BLOCK: BigInt(MS[CHAIN[c]]),
    bridgeKnown: (args: readonly unknown[]) => w.rails[c].known.has(String(args[0]).toLowerCase()) || sameText(args[0], another),
    primaryBridge: () => w.rails[c].primary,
    bridgeEnabled: (args: readonly unknown[]) => w.rails[c].enabled.has(String(args[0]).toLowerCase()),
  });
  // the owner's direct calls on the bridges, as CascadeBase decides them (disableBridge also takes the guardian's)
  const bridges = (c: SchedulerContract): Record<string, Answer> => ({
    disableBridge: (args: readonly unknown[], from?: string) =>
      !sameText(from, r.owner) && !sameText(from, r.guardian) ? revert("NotGuardian") : w.rails[c].enabled.has(String(args[0]).toLowerCase()) ? undefined : revert("BridgeNotEnabled"),
    setPrimaryBridge: (args: readonly unknown[], from?: string) =>
      !sameText(from, r.owner)
        ? revert("OwnableUnauthorizedAccount", [from ?? other])
        : w.rails[c].enabled.has(w.rails[c].primary.toLowerCase())
          ? revert("PrimaryStillEnabled")
          : w.rails[c].enabled.has(String(args[0]).toLowerCase())
            ? undefined
            : revert("BridgeNotEnabled"),
  });
  const lower = (m: World["book"]) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k.toLowerCase(), v]));
  w.book = lower({
    [a.vault]: {
      chain: "bittensor",
      abi: build.vaultAbi,
      answers: { owner: r.owner, launchChain: 8_453n, MS_PER_BLOCK: BigInt(MS.bittensor), schedule: scheduler("vault"), execute: undefined, cancel: canceller("vault"), cancelPayoutBatch: batchCanceller, ...bridges("vault") },
    },
    [a.vaultLens]: {
      chain: "bittensor",
      abi: lensAbiOf("vault"),
      answers: {
        ...lensAnswers("vault"),
        peerId: (args: readonly unknown[]) => keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }], [args[0] as bigint, args[1] as Address])),
        doorState: () => 0,
        maxTotalAssets: 1_000n * E18,
        maxDailyOutflowBps: 2_000n,
        minDailyOutflow: 10n * E18,
        globalOutflowBps: 3_000n,
        maxEntryValue: 10n * E18,
        maxMessageValue: 500n * E18,
        minChunk: 5,
        maxFeeBps: 100n,
        maxFeeAbs: E18 / 100n,
        payoutDelay: BigInt(24 * H),
        treasury: r.treasury,
        rewardCutBps: 1_000,
        rewardVesting: BigInt(7 * D),
        idleBufferBps: 500,
        stakeHotkey: TAO_BOT,
        bookedStake: 1_000n * RAO,
        coldkey: plan.vaultColdkey,
        missingStakeRao: 0n,
        unlistedStakeRao: 0n,
        getPayoutBatch: (args: readonly unknown[]) =>
          w.batches.get(String(args[0]).toLowerCase()) ?? { sourceChain: 0n, frontDoor: `0x${"00".repeat(20)}`, batchId: 0n, queuedAt: 0n, cursor: 0, count: 0, chunk: 0, remaining: 0n, payoutsHash: `0x${"00".repeat(32)}` },
      },
    },
    [PRECOMPILE.staking]: {
      chain: "bittensor",
      abi: [{ type: "function", name: "getStake", stateMutability: "view", inputs: [{ name: "hotkey", type: "bytes32" }, { name: "coldkey", type: "bytes32" }, { name: "netuid", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] }],
      answers: { getStake: (args: readonly unknown[]) => (sameText(args[1], plan.vaultColdkey) && args[2] === 0n ? (w.stakes.get(String(args[0]).toLowerCase()) ?? 0n) : 0n) },
    },
    // each adapter's lane settings (R4, C-L4: a new pair's are held to the deploy's) and the Bittensor adapters' parks (R4,
    // D-L1: a vault-side disable warns while its adapter holds any)
    // R11 (ChatGPT r3, claim 2): each Bittensor adapter's canSendPayouts() answers one word, as the vault reads it
    [a.bitAdapter]: { chain: "bittensor", abi: build.contracts.CcipBittensorAdapter.abi, answers: { remoteChainId: 8_453n, remoteAdapter: a.baseAdapter, canSendPayouts: true, ...LANE.bittensor } },
    [a.baseAdapter]: { chain: "base", abi: build.contracts.CcipBaseAdapter.abi, answers: { remoteChainId: 964n, remoteAdapter: a.bitAdapter, ...LANE.base } },
    // a second adapter pair, the rail a migration moves to (Task 47b)
    [BIT2]: { chain: "bittensor", abi: build.contracts.CcipBittensorAdapter.abi, answers: { remoteChainId: 8_453n, remoteAdapter: BASE2, canSendPayouts: true, ...LANE.bittensor } },
    [BASE2]: { chain: "base", abi: build.contracts.CcipBaseAdapter.abi, answers: { remoteChainId: 964n, remoteAdapter: BIT2, ...LANE.base } },
    // the deploy's AlphaVault: the target of a migration it announced (none here; R4-O round 2)
    [LANE.bittensor.alphaVault]: {
      chain: "bittensor",
      abi: [
        { type: "function", name: "migrationTarget", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
        { type: "function", name: "migrationFinished", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
      ],
      answers: { migrationTarget: `0x${"00".repeat(20)}`, migrationFinished: false },
    },
    [a.frontDoor]: {
      chain: "base",
      abi: abiOf("frontDoor"),
      answers: {
        owner: r.owner,
        MS_PER_BLOCK: BigInt(MS.base),
        schedule: scheduler("frontDoor"),
        execute: undefined,
        cancel: canceller("frontDoor"),
        ...bridges("frontDoor"),
        vaultChain: 964n,
        maxDeliverySlippageBps: 300,
        batchInterval: BigInt(H),
        maxBatchValue: 500n * E18,
        minPoolLiquidity: (args: readonly unknown[]) => [10n ** 20n, 10n ** 17n][Number(args[0])],
        oracle: a.oracle,
        swapper: a.staker,
      },
    },
    [a.doorLens]: { chain: "base", abi: lensAbiOf("frontDoor"), answers: lensAnswers("frontDoor") },
  });
  // the vault's constructor enables its first bridge in its creation block: what proves a log server keeps its history
  emit(w, "vault", "BridgeActivated", { bridge: a.bitAdapter }, CREATED.bittensor);
  worldNow = w;
  return w;
}

/** A fake RPC over `w`: eth_call from the book by the called contract's ABI (anything unplanned throws), eth_getLogs from
 * the logs, and the heads, the blocks' times and the chain ids. */
function rpcOf(w: World): Rpc {
  worldNow = w;
  return {
    async request(chain, method, params) {
      w.calls.push({
        chain,
        method,
        ...(method === "eth_call"
          ? { to: (params[0] as { to: string }).to, from: (params[0] as { from?: string }).from, data: (params[0] as { data: Hex }).data, block: params[1] as string, ...((params[0] as { gas?: string }).gas ? { gas: (params[0] as { gas: string }).gas } : {}) }
          : {}),
      });
      if (method === "eth_chainId") return numberToHex(LIVE[chain].chainId);
      if (method === "eth_blockNumber") return numberToHex(w.heads[chain]);
      if (method === "eth_getCode") return w.codes[String(params[0]).toLowerCase()] ?? "0x";
      if (method === "eth_getBlockByNumber") {
        const n = params[0] === "latest" ? w.heads[chain] : hexToNumber(params[0] as Hex);
        if (n > w.heads[chain]) return null;
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
      if (typeof v === "function") v = (v as (a: readonly unknown[], f?: string, tag?: unknown) => unknown)(args ?? [], from, (params as unknown[])[1]);
      if (v instanceof Error) throw v;
      // an answer as the node gives it, whatever the ABI says (R11: a view that answers nothing, or more than a word)
      if (v instanceof RawAnswer) return v.data;
      const f = c.abi.find((x): x is AbiFunction => x.type === "function" && x.name === functionName)!;
      if (!f.outputs.length) return "0x";
      return encodeFunctionResult({ abi: c.abi, functionName, result: v } as never);
    },
  };
}

const ctxOf = (w: World) => ({ rpc: rpcOf(w), targets: LIVE, logsWindow: { bittensor: 200_000n, base: 2_000_000n } });

let logIndex = 0;
/** `event` logged by the contract `c` in block `block`. */
function emit(w: World, c: SchedulerContract | "vaultRaw", event: string, args: Record<string, unknown>, block: number): void {
  const cc: SchedulerContract = c === "vaultRaw" ? "vault" : c;
  const ev = abiOf(cc).find((x): x is AbiEvent => x.type === "event" && x.name === event)!;
  const indexed = Object.fromEntries(ev.inputs.filter((i) => i.indexed).map((i) => [i.name!, args[i.name!]]));
  const topics = encodeEventTopics({ abi: [ev], eventName: event, args: indexed } as never) as Hex[];
  const plain = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain, plain.map((i) => args[i.name!]) as never);
  logIndex++;
  w.logs[CHAIN[cc]].push({ address: plan.addresses[cc], topics, data, blockNumber: numberToHex(block), logIndex: numberToHex(logIndex % 50), transactionHash: keccak256(numberToHex(logIndex)) });
}

const CLASS_OF: Record<string, number> = { writeOffMissingStake: 1, activateFrontDoor: 1, activateBridge: 1, setGuardian: 2, transferOwnership: 2 };
const KIND_OF: Record<string, number> = { setGuardian: 1 };

/** `fn(args)` scheduled on `c` at time `at`: its Scheduled log and its item in the lens, as the contract writes them. */
function put(w: World, c: SchedulerContract, fn: string, args: readonly unknown[], at: number, o: { kind?: number; log?: boolean; lens?: boolean } = {}): { id: Hex; data: Hex } {
  const data = encodeFunctionData({ abi: abiOf(c), functionName: fn, args } as never);
  const id = keccak256(data);
  const cls = CLASS_OF[fn] ?? 0;
  const kind = o.kind ?? KIND_OF[fn] ?? 0;
  const delay = DELAYS[cls];
  const chain = CHAIN[c];
  const block = blockAt(w, chain, at);
  const item: Item = { scheduledAt: BigInt(at), readyAt: BigInt(at + delay), class: cls, kind, selector: data.slice(0, 10) as Hex, readyBlock: BigInt(block + halfBlocks(delay, chain)) };
  if (o.lens !== false) w.items[c].set(id, item);
  if (o.log !== false) emit(w, c, "Scheduled", { id, kind, selector: item.selector, readyAt: item.readyAt, data }, block);
  return { id, data };
}

const filesIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);
const readFile = (dir: string, name: string) => parseWalletFile(JSON.parse(readFileSync(join(dir, name), "utf8")));
const opts = (dir: string) => ({ dir, name: "v3.2-launch", now: 1_800_000_000_000, buildsDir });

// ---- the tests ----

describe("Task 47: schedule, execute, cancel and pending items as sign-page files", () => {
  it("scheduleDataRoundTrips: the file's call decodes back to its function and arguments, under the id the contract gives", async () => {
    const cases: [SchedulerContract, string, unknown[]][] = [
      ["vault", "setMaxTotalAssets", [2_000n * E18]],
      ["vault", "setRewardCut", [other, 1_500n]],
      ["vault", "moveStake", [YUMA, TAO_BOT, 5n * RAO]],
      ["vault", "setMessageLimits", [20n * E18, 600n * E18, 3n]],
      ["vault", "setGuardian", [another]],
      ["vault", "activateFrontDoor", [10n, other]],
      ["frontDoor", "setMinPoolLiquidity", [1n, 10n ** 16n]],
      ["frontDoor", "setOracle", [other]],
      ["frontDoor", "transferOwnership", [another]],
    ];
    for (const [c, fn, args] of cases) {
      const call = scheduleCall(record(), c, fn, args, { buildsDir });
      expect(call.chainId).toBe(c === "vault" ? 964 : 8_453);
      expect(call.to).toBe(plan.addresses[c]);
      expect(call.from).toBe(plan.roles.owner);
      expect(call.value).toBe("0");
      const outer = decodeFunctionData({ abi: abiOf(c), data: call.data });
      expect(outer.functionName).toBe("schedule");
      const inner = (outer.args ?? [])[0] as Hex;
      const d = decodeFunctionData({ abi: abiOf(c), data: inner });
      expect(d.functionName, fn).toBe(fn);
      expect((d.args ?? []).map(norm), fn).toEqual(args.map(norm));
      // the canonical length _classify asks: one word an argument
      expect(inner.length, fn).toBe(10 + 64 * args.length);
      expect(call.label.startsWith("schedule("), fn).toBe(true);
      expect(call.label.length, fn).toBeLessThanOrEqual(200);
    }
    // the command: asked of the contract from the owner, the id is the contract's, keccak256 of the setter's calldata,
    // and the file is one the sign page reads, holding exactly that call
    const w = world();
    const dir = tempDir("schedule-files");
    const r = await scheduleCommand(ctxOf(w), record(), { ...opts(dir), contract: "vault", fn: "setMaxTotalAssets", args: ["2000000000000000000000"] });
    expect(r.ok).toBe(true);
    const inner = encodeFunctionData({ abi: build.vaultAbi, functionName: "setMaxTotalAssets", args: [2_000n * E18] });
    const id = keccak256(inner);
    const asked = w.calls.filter((x) => x.method === "eth_call" && x.data?.startsWith(toFunctionSelector("function schedule(bytes)")));
    expect(asked).toHaveLength(1);
    expect(asked[0].from?.toLowerCase()).toBe(plan.roles.owner.toLowerCase());
    expect(r.lines.join("\n")).toContain(id);
    expect(r.lines.join("\n")).toContain("48 hours");
    expect(r.lines.join("\n")).toContain("the owner or the guardian");
    expect(r.files).toHaveLength(1);
    const file = parseWalletFile(JSON.parse(readFileSync(r.files[0], "utf8")));
    expect(file.deployment).toBe("v3.2-launch");
    expect(file.calls).toHaveLength(1);
    expect(file.calls[0]).toEqual({ ...scheduleCall(record(), "vault", "setMaxTotalAssets", [2_000n * E18], { buildsDir }) });
    expect(file.title.length).toBeLessThanOrEqual(200);
  });

  it("schedule refuses, writing nothing, what the contract's class table doesn't know, and what it can't encode", async () => {
    const w = world();
    const dir = tempDir("schedule-refused");
    const run = (contract: string, fn: string, args: string[]) => scheduleCommand(ctxOf(w), record(), { ...opts(dir), contract, fn, args });
    // setKeeper is a direct owner call: the contract's own table refuses it (UnknownSelector)
    await expect(run("vault", "setKeeper", [other])).rejects.toThrow(/does not schedule setKeeper.*UnknownSelector/);
    await expect(run("front-door", "setCaps", ["30000000000000000", "0"])).rejects.toThrow(/does not schedule setCaps/);
    // no such function, the wrong count, a value out of its type, a list (no item carries one), the staker
    await expect(run("vault", "setNothing", ["1"])).rejects.toThrow(/has no function setNothing/);
    await expect(run("vault", "setFeeLimits", ["1"])).rejects.toThrow(/takes 2 arguments/);
    await expect(run("front-door", "setMaxDeliverySlippage", ["70000"])).rejects.toThrow(/refuses those arguments/);
    await expect(run("vault", "setMaxTotalAssets", ["2000 TAO"])).rejects.toThrow(/is not a whole number/);
    await expect(run("vault", "cancelPayoutBatch", ["0x" + "11".repeat(32), "[]"])).rejects.toThrow(/no scheduled item carries/);
    await expect(run("staker", "setFees", ["1"])).rejects.toThrow(/has no scheduler/);
    // while the exits are closed, an Ordinary item can't be scheduled: the contract says so, and nothing is written
    w.exitsClosed = true;
    await expect(run("vault", "setMaxTotalAssets", ["1"])).rejects.toThrow(/ExitsNotOpen/);
    w.exitsClosed = false;
    // the id is the contract's: one it answers other than keccak256 of the calldata is refused (review, Minor 1)
    w.book[plan.addresses.vault.toLowerCase()].answers.schedule = () => keccak256(stringToBytes("another id"));
    await expect(run("vault", "setMaxTotalAssets", ["1"])).rejects.toThrow(/not keccak256 of its calldata/);
    // an explicit write-off of 0 writes off nothing in 7 days (review, Minor 5)
    w.book[plan.addresses.vault.toLowerCase()].answers.schedule = scheduler("vault");
    w.book[plan.addresses.vaultLens.toLowerCase()].answers.missingStakeRao = 50n * RAO;
    await expect(run("vault", "writeOffMissingStake", ["0"])).rejects.toThrow(/nothing to write off/);
    expect(filesIn(dir)).toEqual([]);
  });

  it("a caps file above the founder level warns, quoting section 5, and is written all the same (Task 46b)", async () => {
    const w = world();
    const dir = tempDir("schedule-caps");
    const run = (amount: bigint) => scheduleCommand(ctxOf(w), record(), { ...opts(dir), contract: "vault", fn: "setMaxTotalAssets", args: [String(amount)] });
    // above the founder level (44 TAO), owned by a plain account: the warning, and the file
    const r = await run(100n * E18);
    expect(r.ok).toBe(true);
    expect(r.files).toHaveLength(1);
    const warning = capsWarning({ maxTotalAssets: 100n * E18 }, { kind: "account" })!;
    expect(r.lines.join("\n")).toContain(warning.split("\n").map((l) => `  ${l}`).join("\n"));
    expect(warning).toContain('Spec section 5: "Until the Safe, one Ledger owns every contract');
    // at the founder level: no warning, and the owner's kind not even read
    w.calls.length = 0;
    expect((await run(44n * E18)).lines.join("\n")).not.toContain("WARNING");
    expect(w.calls.some((c) => c.method === "eth_getCode")).toBe(false);
    // an owner delegated by EIP-7702 counts as an account: it warns
    w.codes[plan.roles.owner.toLowerCase()] = `0xef0100${"aa".repeat(20)}`;
    expect((await run(100n * E18)).lines.join("\n")).toContain("an account delegated to");
    // a 2-of-3 Safe owner: no warning
    w.codes[plan.roles.owner.toLowerCase()] = "0x6080604052";
    w.book[plan.roles.owner.toLowerCase()] = {
      chain: "bittensor",
      abi: parseAbi(["function getMinDelay() view returns (uint256)", "function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"]),
      answers: { getMinDelay: revert("InvalidParameter"), getThreshold: 2n, getOwners: [other, another, plan.roles.keeper] },
    };
    const safe = await run(100n * E18);
    expect(safe.lines.join("\n")).not.toContain("WARNING");
    expect(safe.files).toHaveLength(1);
  });

  it("schedule on the front door: the call to the front door on Base, and its loosening (review, Minor 6)", async () => {
    const w = world();
    const dir = tempDir("schedule-door");
    const r = await scheduleCommand(ctxOf(w), record(), { ...opts(dir), contract: "front-door", fn: "setMaxBatchValue", args: [String(600n * E18)] });
    const call = parseWalletFile(JSON.parse(readFileSync(r.files[0], "utf8"))).calls[0];
    expect(call).toMatchObject({ chainId: 8_453, to: plan.addresses.frontDoor, from: plan.roles.owner, value: "0" });
    const inner = decodeFunctionData({ abi: abiOf("frontDoor"), data: call.data }).args?.[0] as Hex;
    expect(decodeFunctionData({ abi: abiOf("frontDoor"), data: inner })).toMatchObject({ functionName: "setMaxBatchValue", args: [600n * E18] });
    const text = r.lines.join("\n");
    expect(text).toContain(`as item ${keccak256(inner)}`);
    expect(text).toContain("A Param item (48 hours), Ordinary");
    // half its delay in blocks at Base's calibrated 120 ms (Revision 28): ceil(172,800 * 1000 / 240)
    expect(text).toContain("It is ready 48 hours and 720,000 blocks after it lands");
    expect(text).toContain("maxBatchValue: 500 TAO now, 600 TAO then (loosens)");
  });

  it("a door's activation names its kind from the door's state, and warns when the primary bridge doesn't serve its chain", async () => {
    const w = world();
    const dir = tempDir("activate-door");
    const run = (chain: string) => scheduleCommand(ctxOf(w), record(), { ...opts(dir), contract: "vault", fn: "activateFrontDoor", args: [chain, other] });
    const onBase = (await run("8453")).lines.join("\n");
    expect(onBase).toContain("A Registry item (7 days), Ordinary: the owner or the guardian can cancel it");
    // half its delay in blocks at Bittensor's calibrated 7,200 ms (Revision 28): ceil(604,800 * 1000 / 14,400)
    expect(onBase).toContain("It is ready 7 days and 42,000 blocks after it lands");
    // the contract's own MS_PER_BLOCK, read, as the pending list reads it (review M-5): at 3,600 ms, 84,000
    const vaultAt = plan.addresses.vault.toLowerCase();
    const ms = w.book[vaultAt].answers.MS_PER_BLOCK;
    w.book[vaultAt].answers.MS_PER_BLOCK = 3_600n;
    expect((await run("8453")).lines.join("\n")).toContain("It is ready 7 days and 84,000 blocks after it lands");
    w.book[vaultAt].answers.MS_PER_BLOCK = ms;
    expect(onBase).not.toContain("WARNING");
    // a door the owner removed comes back as a Reopen, which only the owner can cancel
    w.book[plan.addresses.vaultLens.toLowerCase()].answers.doorState = () => 2;
    expect((await run("8453")).lines.join("\n")).toContain("A Registry item (7 days), Reopen: only the owner can cancel it");
    // every payout goes over the primary: a door on a chain it doesn't serve could not be paid
    expect((await run("10")).lines.join("\n")).toMatch(/WARNING — the vault's primary bridge 0x[0-9a-fA-F]{40} serves chain 8453, not 10/);
  });

  it("a log server without the vault's history is refused before any Bittensor scan, never read as nothing pending (Task 46b's fix round, I3)", async () => {
    const w = world();
    const item = put(w, "vault", "setMaxTotalAssets", [2_000n * E18], HEAD_TIME - D);
    // one id on both chains, for cancel's warning about the copy it can't see
    const twin = put(w, "vault", "transferOwnership", [another], HEAD_TIME - 2 * D);
    put(w, "frontDoor", "transferOwnership", [another], HEAD_TIME - 2 * D);
    // the constructor's BridgeActivated missing: a node that pruned the vault's creation block
    const topic = encodeEventTopics({ abi: build.vaultAbi, eventName: "BridgeActivated" } as never)[0] as Hex;
    w.logs.bittensor = w.logs.bittensor.filter((l) => !sameText(l.topics[0], topic));
    const history = `this RPC doesn't keep history; use an archive node (archive.chain.opentensor.ai is the known one): its logs show no BridgeActivated(${plan.addresses.bitAdapter}) in block ${CREATED.bittensor}, which the vault's constructor logged`;
    await expect(pendingItems(ctxOf(w), record(), { buildsDir })).rejects.toMatchObject({ message: history });
    // pending says so for the vault, and still lists the front door
    const r = await pendingCommand(ctxOf(w), record(), { buildsDir });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toBe(`Bittensor vault: ${history}. Its items are not known.`);
    expect(r.lines.slice(1).join("\n")).toContain(twin.id);
    // execute and cancel say so too, and never to try again: on this server it won't help (Task 46b's re-review, N5)
    const files = tempDir("history-execute-cancel");
    await expect(executeCommand(ctxOf(w), record(), { ...opts(files), id: item.id })).rejects.toMatchObject({
      message: `Couldn't read the vault (Bittensor): ${history}, so item ${item.id} was not found; nothing written`,
    });
    await expect(cancelCommand(ctxOf(w), record(), { ...opts(files), id: item.id, as: "owner" })).rejects.toMatchObject({
      message: `Couldn't read the vault (Bittensor): ${history}, so item ${item.id} was not found there; nothing written`,
    });
    expect(filesIn(files)).toEqual([]);
    // the copy it can read is cancelled; the warning names the other without "try again"
    const half = await cancelCommand(ctxOf(w), record(), { ...opts(files), id: twin.id, as: "owner" });
    expect(half.ok).toBe(false);
    expect(half.lines.at(-1)).toBe(`WARNING — Couldn't read the vault (Bittensor): ${history}, and item ${twin.id} may be pending there too.`);
    expect(half.lines.join("\n")).not.toMatch(/try again/);
    // the owner's batch cancel reads the vault's logs too: refused, nothing written
    const dir = tempDir("cancel-payouts-history");
    const key = keccak256(stringToBytes("a batch"));
    w.batches.set(key, { sourceChain: 8_453n, frontDoor: plan.addresses.frontDoor, batchId: 1n, queuedAt: BigInt(HEAD_TIME - H), cursor: 0, count: 1, chunk: 0, remaining: E18, payoutsHash: `0x${"12".repeat(32)}` });
    await expect(cancelPayoutsCommand(ctxOf(w), record(), { ...opts(dir), key })).rejects.toMatchObject({ message: history });
    expect(filesIn(dir)).toEqual([]);
  });

  it("pendingFromLogs: Scheduled less Executed, Cancelled and Lapsed, each re-read through the lens, which decides", async () => {
    const w = world();
    const at = HEAD_TIME - 3 * D;
    const block = (t: number) => blockAt(w, "bittensor", t);
    const a = put(w, "vault", "setMaxTotalAssets", [2_000n * E18], at);
    const b = put(w, "vault", "setPayoutDelay", [BigInt(12 * H)], at);
    emit(w, "vault", "Executed", { id: b.id }, block(at + 2 * D));
    w.items.vault.delete(b.id);
    const c = put(w, "vault", "setIdleBuffer", [100n], at);
    emit(w, "vault", "Cancelled", { id: c.id, by: plan.roles.guardian }, block(at + D));
    w.items.vault.delete(c.id);
    // executed, then scheduled again: pending under the same id
    const e = put(w, "vault", "setRewardVesting", [BigInt(3 * D)], at - 6 * D);
    emit(w, "vault", "Executed", { id: e.id }, block(at - 3 * D));
    put(w, "vault", "setRewardVesting", [BigInt(3 * D)], at);
    // the logs say pending, the lens holds nothing: gone (judged by the lens)
    const f = put(w, "vault", "setFeeLimits", [200n, E18 / 100n], at, { lens: false });
    // pruned after its window
    const g = put(w, "vault", "setMaxTotalAssets", [3_000n * E18], HEAD_TIME - 14 * D);
    emit(w, "vault", "Lapsed", { id: g.id }, block(HEAD_TIME - D));
    w.items.vault.delete(g.id);
    // the longest delay: a guardian swap scheduled 14 days ago is ready since day 8 and runs until tomorrow, so the
    // logs are read back that far (the longest delay and the window before the head)
    const s = put(w, "vault", "setGuardian", [another], HEAD_TIME - 14 * D);
    // one on the front door
    const h = put(w, "frontDoor", "setOracle", [other], HEAD_TIME - D);
    const items = await pendingItems(ctxOf(w), record(), { buildsDir });
    expect(items.map((i) => [i.contract, i.id]).sort()).toEqual(
      [
        ["vault", a.id],
        ["vault", e.id],
        ["vault", s.id],
        ["frontDoor", h.id],
      ].sort(),
    );
    expect(items.find((i) => i.id === s.id)).toMatchObject({ kind: "GuardianSwap", class: "Guardian", windowEnd: HEAD_TIME + D, dead: false });
    expect(items.map((i) => i.id)).not.toContain(f.id);
    const ia = items.find((i) => i.id === a.id)!;
    expect(ia).toMatchObject({ chain: "bittensor", address: plan.addresses.vault, chainId: 964, kind: "Ordinary", class: "Param", fn: "setMaxTotalAssets", data: a.data, canonical: true, scheduledAt: at, readyAt: at + 48 * H, windowEnd: at + 48 * H + WINDOW, dead: false });
    expect(norm(ia.args.amount)).toBe(2_000n * E18);
    expect(ia.unknown).toBeUndefined();
    expect(items.find((i) => i.id === h.id)).toMatchObject({ chain: "base", chainId: 8_453, fn: "setOracle", kind: "Ordinary" });
    // a lens read that fails makes the item unknown, never "not pending"
    const lensAt = plan.addresses.vaultLens.toLowerCase();
    const scheduled = w.book[lensAt].answers.scheduled as (args: readonly unknown[]) => unknown;
    w.book[lensAt].answers.scheduled = (args: readonly unknown[]) => (sameText(args[0], a.id) ? new RpcError("header not found", -32000) : scheduled(args));
    const again = await pendingItems(ctxOf(w), record(), { buildsDir });
    const ua = again.find((i) => i.id === a.id)!;
    expect(ua.unknown).toMatch(/could not read it/);
    expect(() => executeCall(ua)).toThrow(/could not be judged/);
    // an id the logs closed whose re-read fails is unknown too: the logs may have missed its rescheduling (Minor 3)
    w.book[lensAt].answers.scheduled = (args: readonly unknown[]) => (sameText(args[0], b.id) ? new RpcError("header not found", -32000) : scheduled(args));
    const closed = (await pendingItems(ctxOf(w), record(), { buildsDir })).find((i) => i.id === b.id);
    expect(closed?.unknown).toMatch(/the logs say it closed, but the lens could not confirm it/);
    // a kind the lens reads that this build lacks is unknown, and counts as owner-only (Minor 2)
    w.book[lensAt].answers.scheduled = (args: readonly unknown[]) => (sameText(args[0], a.id) ? { ...(scheduled(args) as Item), kind: 7 } : scheduled(args));
    const odd = (await pendingItems(ctxOf(w), record(), { buildsDir })).find((i) => i.id === a.id)!;
    expect(odd).toMatchObject({ kind: "unknown" });
    expect(odd.unknown).toMatch(/kind 7/);
    expect(() => cancelCall(odd, "guardian")).toThrow(/only the owner can cancel/);
    expect(cancelCall(odd, "owner").from).toBe(plan.roles.owner);
    w.book[lensAt].answers.scheduled = scheduled;
    // a log scan that fails lists nothing at all (it is never an empty list)
    w.logsFail = "base";
    await expect(pendingItems(ctxOf(w), record(), { buildsDir })).rejects.toThrow(/query timeout/);
    // pnpm ops pending prints each chain apart: the Bittensor items, and why Base could not be read
    const lines = (await pendingCommand(ctxOf(w), record(), { buildsDir })).lines.join("\n");
    expect(lines).toContain(e.id);
    expect(lines).toMatch(/Base front door: couldn't read it right now \(.*query timeout.*\); try again/);
  });

  it("one id pending on both chains: each copy listed, both chains' cancels in one file, executed only with --on", async () => {
    const w = world();
    const dir = tempDir("twins");
    const at = HEAD_TIME - 9 * D;
    // the roles are the same on both chains, so the same transfer has one calldata and one id on both
    const v = put(w, "vault", "transferOwnership", [another], at);
    const d = put(w, "frontDoor", "transferOwnership", [another], at);
    expect(v.id).toBe(d.id);
    const items = (await pendingItems(ctxOf(w), record(), { buildsDir })).filter((i) => i.id === v.id);
    expect(items.map((i) => i.contract).sort()).toEqual(["frontDoor", "vault"]);
    expect((await pendingCommand(ctxOf(w), record(), { buildsDir })).lines.filter((l) => l.includes(v.id))).toHaveLength(2);
    // the guardian stops both copies with one file holding both chains' cancels (as pause both does), so the sign page
    // shows them together and neither can be taken for the whole change (the re-review's Important A)
    const r = await cancelCommand(ctxOf(w), record(), { ...opts(dir), id: v.id, as: "guardian" });
    expect(r.files).toHaveLength(1);
    const file = parseWalletFile(JSON.parse(readFileSync(r.files[0], "utf8")));
    expect(file.calls.map((c) => `${c.chainId} ${c.to}`).sort()).toEqual([`8453 ${plan.addresses.frontDoor}`, `964 ${plan.addresses.vault}`].sort());
    expect(file.calls.every((c) => c.from === plan.roles.guardian && c.label.startsWith("cancel("))).toBe(true);
    expect(file.title).toMatch(/both chains.*sign both calls/);
    const text = r.lines.join("\n");
    expect(text).toContain("is pending on both the vault (Bittensor) and the front door (Base)");
    expect(text).toContain("Sign both calls");
    expect(text).toContain("(2 calls)");
    // Base can't be read: the vault's call is still written, the warning says the id may be pending on Base too, and no
    // "sign both" line names a call that isn't there (Minor B)
    w.logsFail = "base";
    const half = await cancelCommand(ctxOf(w), record(), { ...opts(tempDir("twins-half")), id: v.id, as: "guardian" });
    expect(half.ok).toBe(false);
    expect(half.files).toHaveLength(1);
    expect(parseWalletFile(JSON.parse(readFileSync(half.files[0], "utf8"))).calls).toHaveLength(1);
    expect(half.lines.join("\n")).toMatch(/WARNING — Couldn't read the front door \(Base\) right now \(.*\), and item 0x[0-9a-f]{64} may be pending there too: try again/);
    expect(half.lines.join("\n")).not.toMatch(/[Ss]ign both/);
    w.logsFail = undefined;
    // both read, but the front door's cancel can't be checked: one call written, the other NOT WRITTEN, no "sign both"
    const doorCancel = w.book[plan.addresses.frontDoor.toLowerCase()].answers.cancel;
    w.book[plan.addresses.frontDoor.toLowerCase()].answers.cancel = new RpcError("upstream request timeout", -32603);
    const one = await cancelCommand(ctxOf(w), record(), { ...opts(tempDir("twins-one")), id: v.id, as: "guardian" });
    expect(one.ok).toBe(false);
    expect(parseWalletFile(JSON.parse(readFileSync(one.files[0], "utf8"))).calls.map((c) => c.chainId)).toEqual([964]);
    expect(one.lines.join("\n")).toMatch(/NOT WRITTEN — Couldn't check cancel\(.*\) on the front door \(Base\) right now/);
    expect(one.lines.join("\n")).not.toMatch(/[Ss]ign both/);
    w.book[plan.addresses.frontDoor.toLowerCase()].answers.cancel = doorCancel;
    // a dead vault copy doesn't hide the front door's ready one: execute names its copy with --on
    w.clocks.vault.owner = BigInt(at);
    const exec = (on?: string) => executeCommand(ctxOf(w), record(), { ...opts(dir), id: v.id, ...(on ? { on } : {}) });
    await expect(exec()).rejects.toThrow(/pending on both .*the vault \(Bittensor\): dead.*the front door \(Base\): ready now.*--on vault or --on front-door/s);
    await expect(exec("vault")).rejects.toThrow(/is dead/);
    const e = await exec("front-door");
    const ec = parseWalletFile(JSON.parse(readFileSync(e.files[0], "utf8"))).calls[0];
    expect(ec).toMatchObject({ chainId: 8_453, to: plan.addresses.frontDoor, from: plan.roles.owner });
    expect(decodeFunctionData({ abi: abiOf("frontDoor"), data: ec.data }).args?.[0]).toBe(d.data);
  });

  it("the two cancels stay apart: cancel takes only a scheduler item, cancel-payouts only a payout batch", async () => {
    const w = world();
    const dir = tempDir("two-cancels");
    const key = keccak256(stringToBytes("a queued batch"));
    const list: Payout[] = [{ user: user3, shares: E18, assets: E18 }];
    emit(w, "vault", "Redeemed", { key, user: user3, shares: E18, assets: E18 }, blockAt(w, "bittensor", HEAD_TIME - H));
    w.batches.set(key, { sourceChain: 8_453n, frontDoor: plan.addresses.frontDoor, batchId: 1n, queuedAt: BigInt(HEAD_TIME - H), cursor: 0, count: 1, chunk: 0, remaining: E18, payoutsHash: payoutsHash(list) });
    const item = put(w, "vault", "setMaxTotalAssets", [2_000n * E18], HEAD_TIME - D);
    const selectors = () => w.calls.filter((x) => x.method === "eth_call").map((x) => x.data?.slice(0, 10));
    const sel = (abi: Abi, name: string) => toFunctionSelector(abi.find((x): x is AbiFunction => x.type === "function" && x.name === name)!);
    // a batch key given to cancel: no item under it, and the batch is never looked up
    w.calls = [];
    await expect(cancelCommand(ctxOf(w), record(), { ...opts(dir), id: key, as: "owner" })).rejects.toThrow(/no item is pending under .*cancel-payouts/);
    expect(selectors()).not.toContain(sel(lensAbiOf("vault"), "getPayoutBatch"));
    expect(selectors()).not.toContain(sel(build.vaultAbi, "cancelPayoutBatch"));
    // an item id given to cancel-payouts: no batch under it, and the scheduler is never asked
    w.calls = [];
    await expect(cancelPayoutsCommand(ctxOf(w), record(), { ...opts(dir), key: item.id })).rejects.toThrow(/no payout batch under .*pnpm ops cancel\)/);
    expect(selectors()).not.toContain(sel(lensAbiOf("vault"), "scheduled"));
    expect(selectors()).not.toContain(sel(build.vaultAbi, "cancel"));
    expect(filesIn(dir)).toEqual([]);
    // each takes its own: the item's cancel(id), the batch's cancelPayoutBatch(key, list)
    const c = parseWalletFile(JSON.parse(readFileSync((await cancelCommand(ctxOf(w), record(), { ...opts(dir), id: item.id, as: "owner" })).files[0], "utf8"))).calls[0];
    expect(decodeFunctionData({ abi: build.vaultAbi, data: c.data }).functionName).toBe("cancel");
    const p = parseWalletFile(JSON.parse(readFileSync((await cancelPayoutsCommand(ctxOf(w), record(), { ...opts(dir), key })).files[0], "utf8"))).calls[0];
    expect(decodeFunctionData({ abi: build.vaultAbi, data: p.data }).functionName).toBe("cancelPayoutBatch");
    // the owner's and the guardian's cancel of one item are two files, neither replacing the other (Minor 4)
    await cancelCommand(ctxOf(w), record(), { ...opts(dir), id: item.id, as: "guardian" });
    expect(filesIn(dir).filter((f) => f.includes("-cancel-") && !f.includes("payouts"))).toHaveLength(2);
  });

  it("a failed read is never final: it says to try again, and writes nothing", async () => {
    const w = world();
    const dir = tempDir("try-again");
    const key = keccak256(stringToBytes("a batch to cancel"));
    const list: Payout[] = [{ user: user3, shares: E18, assets: E18 }];
    emit(w, "vault", "Redeemed", { key, user: user3, shares: E18, assets: E18 }, blockAt(w, "bittensor", HEAD_TIME - H));
    w.batches.set(key, { sourceChain: 8_453n, frontDoor: plan.addresses.frontDoor, batchId: 1n, queuedAt: BigInt(HEAD_TIME - H), cursor: 0, count: 1, chunk: 0, remaining: E18, payoutsHash: payoutsHash(list) });
    const item = put(w, "vault", "setMaxTotalAssets", [2_000n * E18], HEAD_TIME - 3 * D);
    const vault = w.book[plan.addresses.vault.toLowerCase()].answers;
    const lens = w.book[plan.addresses.vaultLens.toLowerCase()].answers;
    const notFinal = async (p: Promise<unknown>, what: string) => {
      const e = await p.then(
        () => undefined,
        (x: unknown) => x as Error,
      );
      expect(e?.message, what).toMatch(/[Cc]ouldn't (read|check) .* right now .*try again/);
      expect(e?.message, what).not.toMatch(/final/);
    };
    const hiccup = () => new RpcError("upstream request timeout", -32603);
    // cancel-payouts: the batch's read, its logs, and the vault's answer
    const getBatch = lens.getPayoutBatch;
    lens.getPayoutBatch = hiccup();
    await notFinal(cancelPayoutsCommand(ctxOf(w), record(), { ...opts(dir), key }), "getPayoutBatch");
    lens.getPayoutBatch = getBatch;
    w.logsFail = "bittensor";
    await notFinal(cancelPayoutsCommand(ctxOf(w), record(), { ...opts(dir), key }), "the batch's logs");
    w.logsFail = undefined;
    vault.cancelPayoutBatch = hiccup();
    await notFinal(cancelPayoutsCommand(ctxOf(w), record(), { ...opts(dir), key }), "cancelPayoutBatch's eth_call");
    vault.cancelPayoutBatch = batchCanceller;
    // cancel: a chain that can't be read, and the contract's answer
    w.logsFail = "bittensor";
    await notFinal(cancelCommand(ctxOf(w), record(), { ...opts(dir), id: item.id, as: "owner" }), "the vault's logs, for cancel");
    w.logsFail = undefined;
    vault.cancel = hiccup();
    await notFinal(cancelCommand(ctxOf(w), record(), { ...opts(dir), id: item.id, as: "owner" }), "cancel's eth_call");
    vault.cancel = canceller("vault");
    // execute: a chain that can't be read, and the contract's answer
    w.logsFail = "bittensor";
    await notFinal(executeCommand(ctxOf(w), record(), { ...opts(dir), id: item.id }), "the vault's logs, for execute");
    w.logsFail = undefined;
    vault.execute = hiccup();
    await notFinal(executeCommand(ctxOf(w), record(), { ...opts(dir), id: item.id }), "execute's eth_call");
    expect(filesIn(dir)).toEqual([]);
  });

  it("deadAfterALaterStamp: an item dies when its kind's clock reaches its scheduling, the owner's for every kind", async () => {
    const w = world();
    const at = HEAD_TIME - 3 * D;
    const ord = put(w, "vault", "setMaxTotalAssets", [2_000n * E18], at);
    const swap = put(w, "vault", "setGuardian", [another], at);
    const reopen = put(w, "vault", "activateBridge", [another], at, { kind: 2 });
    const judge = async () => Object.fromEntries((await pendingItems(ctxOf(w), record(), { buildsDir })).map((i) => [i.id, i.dead]));
    expect(await judge()).toEqual({ [ord.id]: false, [swap.id]: false, [reopen.id]: false });
    // the guardian's clock kills only the Ordinary item
    w.clocks.vault.guardian = BigInt(at);
    expect(await judge()).toEqual({ [ord.id]: true, [swap.id]: false, [reopen.id]: false });
    // an owner stamp as of the scheduling second, or later, kills every kind; one before it kills nothing
    w.clocks.vault = { owner: BigInt(at - 1), guardian: 0n };
    expect(await judge()).toEqual({ [ord.id]: false, [swap.id]: false, [reopen.id]: false });
    w.clocks.vault.owner = BigInt(at);
    expect(await judge()).toEqual({ [ord.id]: true, [swap.id]: true, [reopen.id]: true });
    const items = await pendingItems(ctxOf(w), record(), { buildsDir });
    for (const i of items) expect(() => executeCall(i), i.fn).toThrow(/is dead/);
    // the front door's clocks are its own
    const door = put(w, "frontDoor", "setOracle", [other], at);
    expect((await pendingItems(ctxOf(w), record(), { buildsDir })).find((i) => i.id === door.id)?.dead).toBe(false);
  });

  it("an item lapses only past both its windows, as CascadeBase._lapsed (Revision 28): in time and in its calibrated blocks", async () => {
    const w = world();
    const head = w.heads.bittensor;
    // past readyAt + EXECUTE_WINDOW in time, and past readyBlock + ceil(EXECUTE_WINDOW * 1000 / (2 * 7,200)) in blocks
    const old = put(w, "vault", "setIdleBuffer", [100n], HEAD_TIME - 10 * D);
    const gone = (await pendingItems(ctxOf(w), record(), { buildsDir })).find((i) => i.id === old.id)!;
    expect(gone).toMatchObject({ windowEnd: HEAD_TIME - D, windowEndBlock: Number(w.items.vault.get(old.id)!.readyBlock) + halfBlocks(WINDOW, "bittensor") });
    expect(halfBlocks(WINDOW, "bittensor")).toBe(42_000);
    expect(lapsed(gone)).toBe(true);
    expect(stateOf(gone)).toMatch(/^past its window/);
    expect(() => executeCall(gone)).toThrow(/past its window/);
    // past its time window, but its blocks came slowly (readyBlock late): the contract still runs it, and so is it shown
    const slowReady = head - 1_000;
    w.items.vault.get(old.id)!.readyBlock = BigInt(slowReady);
    const slow = (await pendingItems(ctxOf(w), record(), { buildsDir })).find((i) => i.id === old.id)!;
    expect(slow.windowEndBlock).toBe(slowReady + 42_000);
    expect(lapsed(slow)).toBe(false);
    expect(stateOf(slow)).toBe("ready now");
    expect(executeCall(slow).from).toBe(plan.roles.owner);
    // it can run until the later of the two clocks: here its blocks, 41,000 of them at the chain's 12 s
    expect(slow.runsUntil).toBe(HEAD_TIME + 41_000 * 12);
    expect((await pendingCommand(ctxOf(w), record(), { buildsDir })).lines.join("\n")).toContain(`runs until about ${iso(HEAD_TIME + 41_000 * 12)}`);
    // the last block of its window: still runs; one past it (the head moved on, its time long past): lapsed
    w.items.vault.get(old.id)!.readyBlock = BigInt(head - 42_000);
    expect(lapsed((await pendingItems(ctxOf(w), record(), { buildsDir })).find((i) => i.id === old.id)!)).toBe(false);
    w.items.vault.get(old.id)!.readyBlock = BigInt(head - 42_001);
    expect(lapsed((await pendingItems(ctxOf(w), record(), { buildsDir })).find((i) => i.id === old.id)!)).toBe(true);
    // inside its time window, whatever its blocks: never lapsed, and it runs until its time window ends (the later clock)
    const fresh = put(w, "vault", "setPayoutDelay", [BigInt(12 * H)], HEAD_TIME - 3 * D);
    const f = (await pendingItems(ctxOf(w), record(), { buildsDir })).find((i) => i.id === fresh.id)!;
    expect(lapsed(f)).toBe(false);
    expect(f.runsUntil).toBe(HEAD_TIME - 3 * D + 48 * H + WINDOW);
  });

  it("the rails count a bridge activation that can still run by its blocks, though past its window in time, and drop one past both", async () => {
    const w = world();
    // a Registry item (7 days) scheduled 15 days ago: its window in time ended a day ago
    const act = put(w, "vault", "activateBridge", [BIT2], HEAD_TIME - 15 * D);
    const changes = async () => pendingRailChanges(await pendingItems(ctxOf(w), record(), { buildsDir }));
    expect(await changes()).toEqual([]);
    // its blocks came slowly: its window in blocks runs on, so the vault may still take the bridge
    w.items.vault.get(act.id)!.readyBlock = BigInt(w.heads.bittensor - 1_000);
    expect(await changes()).toEqual([{ contract: "vault", fn: "activateBridge", bridge: BIT2, source: "pending", id: act.id, kind: "Ordinary" }]);
  });

  it("a chain slower than twice its calibration: the logs are read back far enough in blocks to find an item still alive by its blocks", async () => {
    // Bittensor at 40 s a block, over five times its calibrated 7,200 ms: a Param item scheduled 20 days ago (its time
    // window ended 11 days ago, before the time look-back of 15 days and an hour) was ready 12,000 blocks on and lapses
    // 42,000 blocks after that, 54,000 blocks (25 days) on
    const w = world();
    w.spb = { bittensor: 40, base: 2 };
    const at = HEAD_TIME - 20 * D;
    const old = put(w, "vault", "setIdleBuffer", [100n], at);
    const items = await pendingItems(ctxOf(w), record(), { buildsDir });
    const i = items.find((x) => x.id === old.id);
    expect(i, "an item alive by its blocks is listed, though scheduled before the time look-back").toBeDefined();
    expect(lapsed(i!)).toBe(false);
    expect(stateOf(i!)).toBe("ready now");
  });

  it("executeRefusesAnUnknownOrDeadId: no file for an id not pending, dead, unknown, not ready, past its window or failing", async () => {
    const w = world();
    const dir = tempDir("execute-files");
    const run = (id: Hex) => executeCommand(ctxOf(w), record(), { ...opts(dir), id });
    const ready = put(w, "vault", "setMaxTotalAssets", [2_000n * E18], HEAD_TIME - 3 * D);
    const early = put(w, "vault", "setPayoutDelay", [BigInt(12 * H)], HEAD_TIME - D);
    const old = put(w, "vault", "setIdleBuffer", [100n], HEAD_TIME - 10 * D);
    await expect(run(`0x${"99".repeat(32)}`)).rejects.toThrow(/no pending item/);
    await expect(run(early.id)).rejects.toThrow(/is not ready: it may run from/);
    await expect(run(old.id)).rejects.toThrow(/past its window/);
    // ready in time, but half its delay in blocks has not passed (a halted chain: R1-A L-3)
    w.items.vault.get(ready.id)!.readyBlock = BigInt(w.heads.bittensor + 10);
    await expect(run(ready.id)).rejects.toThrow(/may run from block/);
    w.items.vault.get(ready.id)!.readyBlock = BigInt(w.heads.bittensor - 10);
    // the contract's own answer, by eth_call from the owner: a revert writes nothing
    w.book[plan.addresses.vault.toLowerCase()].answers.execute = revert("AboveBridgeCap");
    await expect(run(ready.id)).rejects.toThrow(/AboveBridgeCap/);
    w.book[plan.addresses.vault.toLowerCase()].answers.execute = undefined;
    // dead: an owner stamp after it was scheduled
    w.clocks.vault.owner = BigInt(HEAD_TIME - 2 * D);
    await expect(run(ready.id)).rejects.toThrow(/is dead/);
    expect(filesIn(dir)).toEqual([]);
    // alive and ready: execute(data) to the vault, from the owner, its loosening shown field by field
    w.clocks.vault.owner = 0n;
    const r = await run(ready.id);
    expect(r.files).toHaveLength(1);
    const file = parseWalletFile(JSON.parse(readFileSync(r.files[0], "utf8")));
    const call = file.calls[0];
    expect(call).toMatchObject({ chainId: 964, to: plan.addresses.vault, from: plan.roles.owner, value: "0" });
    const d = decodeFunctionData({ abi: build.vaultAbi, data: call.data });
    expect(d.functionName).toBe("execute");
    expect((d.args ?? [])[0]).toBe(ready.data);
    expect(call.label.startsWith("execute(")).toBe(true);
    const text = r.lines.join("\n");
    expect(text).toContain("maxTotalAssets: 1000 TAO now, 2000 TAO then (loosens)");
    // the simulation came from the owner, with exactly the file's calldata
    const sims = w.calls.filter((x) => x.method === "eth_call" && x.data === call.data);
    expect(sims.length).toBeGreaterThan(0);
    expect(sims.every((x) => sameText(x.from, plan.roles.owner))).toBe(true);
    // a transfer of ownership: the new owner accepts within the window after it runs (the 7a carry)
    const t = put(w, "vault", "transferOwnership", [another], HEAD_TIME - 9 * D);
    expect((await run(t.id)).lines.join("\n")).toContain("The new owner must then accept within 7 days");
  });

  it("guardianCancelRefusedForSwapAndReopen: only the owner cancels a guardian swap or a reopening", async () => {
    const w = world();
    const dir = tempDir("cancel-files");
    const at = HEAD_TIME - D;
    const swap = put(w, "vault", "setGuardian", [another], at);
    const reopen = put(w, "frontDoor", "activateBridge", [another], at, { kind: 2 });
    const ord = put(w, "vault", "setMaxTotalAssets", [2_000n * E18], at);
    const run = (id: Hex, as: "owner" | "guardian") => cancelCommand(ctxOf(w), record(), { ...opts(dir), id, as });
    await expect(run(swap.id, "guardian")).rejects.toThrow(/only the owner can cancel/);
    await expect(run(reopen.id, "guardian")).rejects.toThrow(/only the owner can cancel/);
    expect(filesIn(dir)).toEqual([]);
    const items = await pendingItems(ctxOf(w), record(), { buildsDir });
    for (const i of items.filter((x) => x.kind !== "Ordinary")) expect(() => cancelCall(i, "guardian")).toThrow(/only the owner can cancel/);
    // the guardian cancels an Ordinary item; the owner cancels any, a dead one too
    const g = await run(ord.id, "guardian");
    const gc = readFile(dir, filesIn(dir)[0]).calls[0];
    expect(gc).toMatchObject({ chainId: 964, to: plan.addresses.vault, from: plan.roles.guardian });
    expect(decodeFunctionData({ abi: build.vaultAbi, data: gc.data }).args).toEqual([ord.id]);
    expect(g.lines.join("\n")).toContain("setMaxTotalAssets");
    for (const id of [swap.id, reopen.id]) {
      const r = await run(id, "owner");
      const c = parseWalletFile(JSON.parse(readFileSync(r.files[0], "utf8"))).calls[0];
      expect(c.from).toBe(plan.roles.owner);
      expect(c.label.startsWith("cancel(")).toBe(true);
    }
    // nothing pending under the id: nothing to cancel, which is final (ruling A16): no file, no retry
    const before = filesIn(dir).length;
    await expect(run(`0x${"99".repeat(32)}`, "owner")).rejects.toThrow(/nothing to cancel.*final/);
    expect(filesIn(dir)).toHaveLength(before);
  });

  it("looseningPerParamSetter: each Param setter of Tasks 11, 15, 17, 20 and 32, judged against the current values as its contract judges it", () => {
    const item = (contract: SchedulerContract, fn: string, args: Record<string, unknown>) => ({ contract, fn, args });
    type Case = [SchedulerContract, string, Record<string, unknown>, Record<string, unknown>, boolean];
    const T = plan.roles.treasury;
    const cases: Case[] = [
      // vault (Task 11)
      ["vault", "setMaxTotalAssets", { amount: 2_000n * E18 }, { maxTotalAssets: 1_000n * E18 }, true],
      ["vault", "setMaxTotalAssets", { amount: 1_000n * E18 }, { maxTotalAssets: 1_000n * E18 }, false],
      ["vault", "setMessageLimits", { maxEntryValue_: 10n * E18, maxMessageValue_: 500n * E18, minChunk_: 4 }, { maxEntryValue: 10n * E18, maxMessageValue: 500n * E18, minChunk: 5 }, true],
      ["vault", "setMessageLimits", { maxEntryValue_: 10n * E18, maxMessageValue_: 400n * E18, minChunk_: 6 }, { maxEntryValue: 10n * E18, maxMessageValue: 500n * E18, minChunk: 5 }, false],
      ["vault", "setFeeLimits", { bps: 100n, abs_: (15n * E18) / 1_000n }, { maxFeeBps: 100n, maxFeeAbs: E18 / 100n }, true],
      ["vault", "setFeeLimits", { bps: 50n, abs_: E18 / 100n }, { maxFeeBps: 100n, maxFeeAbs: E18 / 100n }, false],
      ["vault", "setPayoutDelay", { delay: BigInt(12 * H) }, { payoutDelay: BigInt(24 * H) }, true],
      ["vault", "setPayoutDelay", { delay: BigInt(36 * H) }, { payoutDelay: BigInt(24 * H) }, false],
      ["vault", "setRewardCut", { treasury_: other, bps: 1_000 }, { treasury: T, rewardCutBps: 1_000 }, true],
      ["vault", "setRewardCut", { treasury_: T.toLowerCase(), bps: 500 }, { treasury: T, rewardCutBps: 1_000 }, false],
      // vault (Task 15, Task 17, Task 20)
      ["vault", "setRewardVesting", { period: BigInt(3 * D) }, { rewardVesting: BigInt(7 * D) }, true],
      ["vault", "setRewardVesting", { period: BigInt(10 * D) }, { rewardVesting: BigInt(7 * D) }, false],
      ["vault", "setOutflowLimits", { bps: 2_000n, minDaily: 10n * E18, globalBps: 3_500n }, { maxDailyOutflowBps: 2_000n, minDailyOutflow: 10n * E18, globalOutflowBps: 3_000n }, true],
      ["vault", "setOutflowLimits", { bps: 2_000n, minDaily: 10n * E18, globalBps: 3_000n }, { maxDailyOutflowBps: 2_000n, minDailyOutflow: 10n * E18, globalOutflowBps: 3_000n }, false],
      ["vault", "setIdleBuffer", { bps: 200n }, { idleBufferBps: 500 }, true],
      ["vault", "setIdleBuffer", { bps: 800n }, { idleBufferBps: 500 }, false],
      // front door (Task 11, Task 32)
      ["frontDoor", "setMaxDeliverySlippage", { bps: 400 }, { maxDeliverySlippageBps: 300 }, true],
      ["frontDoor", "setMaxDeliverySlippage", { bps: 300 }, { maxDeliverySlippageBps: 300 }, false],
      ["frontDoor", "setBatchInterval", { interval: BigInt(H / 2) }, { batchInterval: BigInt(H) }, true],
      ["frontDoor", "setBatchInterval", { interval: BigInt(2 * H) }, { batchInterval: BigInt(H) }, false],
      ["frontDoor", "setMaxBatchValue", { value: 600n * E18 }, { maxBatchValue: 500n * E18 }, true],
      ["frontDoor", "setMaxBatchValue", { value: 400n * E18 }, { maxBatchValue: 500n * E18 }, false],
      ["frontDoor", "setMinPoolLiquidity", { index: 1, value: 10n ** 16n }, { "minPoolLiquidity(1)": 10n ** 17n }, true],
      ["frontDoor", "setMinPoolLiquidity", { index: 0, value: 10n ** 21n }, { "minPoolLiquidity(0)": 10n ** 20n }, false],
    ];
    for (const [c, fn, args, current, loosens] of cases) {
      const l = looseningOf(item(c, fn, args), current);
      expect(l.loosens, `${fn} ${JSON.stringify(args, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`).toBe(loosens);
      expect(l.fields.length, fn).toBeGreaterThan(0);
      for (const f of l.fields) expect(Object.keys(current), fn).toContain(f.name === "stakeHotkey" ? "stakeHotkey" : f.name);
      if (loosens) expect(l.fields.some((f) => f.loosens), fn).toBe(true);
    }
    // a multi-field setter loosens when any field does, and names that field
    const m = looseningOf(item("vault", "setOutflowLimits", { bps: 2_000n, minDaily: 10n * E18, globalBps: 3_500n }), {
      maxDailyOutflowBps: 2_000n,
      minDailyOutflow: 10n * E18,
      globalOutflowBps: 3_000n,
    });
    expect(m.fields.filter((f) => f.loosens).map((f) => f.name)).toEqual(["globalOutflowBps"]);
    // the always-scheduled setters have no direction (their contracts take them only through execute): shown, never
    // "loosening", as the monitor's admin.item_loosens has them
    for (const [c, fn, args, current] of [
      ["vault", "moveStake", { from: YUMA, to: TAO_BOT, rao: RAO }, {}],
      ["frontDoor", "setOracle", { newOracle: other }, { oracle: another }],
      ["frontDoor", "setSwapper", { newSwapper: other }, { swapper: another }],
    ] as [SchedulerContract, string, Record<string, unknown>, Record<string, unknown>][]) {
      const l = looseningOf(item(c, fn, args), current);
      expect(l.loosens, fn).toBe(false);
      expect(l.note, fn).toMatch(/whatever its value/);
    }
    expect(looseningOf(item("frontDoor", "setOracle", { newOracle: other }), { oracle: another }).fields).toEqual([{ name: "oracle", now: another, then: other, loosens: false }]);
    // setStakeHotkey is not a limit (the controller's ruling): it never loosens; its scheduling rule (it waits unless it
    // follows stake that already moved, CascadeVault.setStakeHotkey) is said apart, from the stake read now
    const hotkey = item("vault", "setStakeHotkey", { h: YUMA });
    const little = looseningOf(hotkey, { stakeHotkey: TAO_BOT, newHotkeyStakeRao: 10n * RAO, stakeHotkeyStakeRao: 900n * RAO, bookedStake: 1_000n * RAO });
    expect(little).toMatchObject({ loosens: false, fields: [{ name: "stakeHotkey", now: TAO_BOT, then: YUMA, loosens: false }] });
    expect(little.note).toMatch(/^Not a limit/);
    expect(little.scheduling).toMatch(/A direct switch would need this schedule now: the new hotkey holds 10000000000 rao/);
    const moved = looseningOf(hotkey, { stakeHotkey: TAO_BOT, newHotkeyStakeRao: 600n * RAO, stakeHotkeyStakeRao: 400n * RAO, bookedStake: 1_000n * RAO });
    expect(moved.loosens).toBe(false);
    expect(moved.scheduling).toMatch(/A direct switch could be made at once now/);
    expect(looseningOf(hotkey, { stakeHotkey: TAO_BOT }).scheduling).toBeUndefined();
    // T11: an item at the current value doesn't loosen; after a direct tightening, the same item does
    const same = item("vault", "setMaxTotalAssets", { amount: 1_000n * E18 });
    expect(looseningOf(same, { maxTotalAssets: 1_000n * E18 }).loosens).toBe(false);
    expect(looseningOf(same, { maxTotalAssets: 800n * E18 }).loosens).toBe(true);
    // a pool index past 1 reverts at execute whatever the floors read
    expect(looseningOf(item("frontDoor", "setMinPoolLiquidity", { index: 2, value: 0n }), {}).reverts).toMatch(/names no pool/);
    // a value not read is never taken as "doesn't loosen"
    expect(() => looseningOf(same, {})).toThrow(/maxTotalAssets is not read/);
    // one case per Param setter, and the setters with a direction are exactly those whose contract calls
    // _requireScheduledIfLoosens (CascadeVault.sol, CascadeFrontDoor.sol)
    const judged = new Set(cases.map(([c, fn]) => `${c}.${fn}`));
    for (const fn of ["moveStake", "setStakeHotkey"]) judged.add(`vault.${fn}`);
    for (const fn of ["setOracle", "setSwapper"]) judged.add(`frontDoor.${fn}`);
    const params = (["vault", "frontDoor"] as const).flatMap((c) => Object.keys(CLASSIFY[c]).filter((fn) => (CLASS_OF[fn] ?? 0) === 0).map((fn) => `${c}.${fn}`));
    expect([...judged].sort()).toEqual(params.sort());
    const withDirection = (file: string) =>
      readFileSync(join(CONTRACTS, "src", file), "utf8")
        .split(/\n {4}function /)
        .filter((chunk) => chunk.split(/\n {4}\}\n/)[0].includes("_requireScheduledIfLoosens("))
        .map((chunk) => chunk.slice(0, chunk.indexOf("(")));
    // the contracts' own scheduling rules: the direction setters, and setStakeHotkey's stake rule
    expect([...SCHEDULED_IF_LOOSENS.vault].sort()).toEqual(withDirection("CascadeVault.sol").sort());
    expect([...SCHEDULED_IF_LOOSENS.frontDoor].sort()).toEqual(withDirection("CascadeFrontDoor.sol").sort());
    expect([...SCHEDULED_IF_LOOSENS.vault].sort()).toEqual([...Object.keys(DIRECTIONS.vault), "setStakeHotkey"].sort());
    expect([...SCHEDULED_IF_LOOSENS.frontDoor].sort()).toEqual(Object.keys(DIRECTIONS.frontDoor).sort());
  });

  it("the setter directions are the monitor's (Task 55's directionOf), field by field, so the two can't drift", () => {
    // the copy of the monitor's two tables (test/monitor-directions.ts names its source): 8 vault setters, 4 door ones
    const monitor = monitorDirections(MONITOR_DIRECTIONS_SOURCE);
    expect([Object.keys(monitor.vault).length, Object.keys(monitor.frontDoor).length]).toEqual([8, 4]);
    expect(DIRECTIONS).toEqual(monitor);
    // setStakeHotkey has no direction in either (the controller's ruling)
    expect(DIRECTIONS.vault.setStakeHotkey).toBeUndefined();
    // once the tracks merge, this checkout holds the monitor's own file: its tables, read from it, are ops's too
    const file = join(CONTRACTS, "..", "indexer", "src", "scheduler.ts");
    // (the file's presence alone decides: a renamed or moved table then throws, never skips; the re-review's Minor C)
    if (existsSync(file)) expect(DIRECTIONS).toEqual(monitorDirections(readFileSync(file, "utf8")));
    expect(() => monitorDirections(MONITOR_DIRECTIONS_SOURCE.replace("const VAULT_DIRECTIONS", "const VAULT_FIELDS"))).toThrow(/no VAULT_DIRECTIONS/);
  });

  it("A16: cancel-payouts, the owner's cancel of a payout batch: a file when it re-mints, refused as final when only bounces are left", async () => {
    const w = world();
    const dir = tempDir("batch-cancel");
    const key = keccak256(stringToBytes("a batch from the launch door"));
    const queuedAt = HEAD_TIME - 5 * H;
    const block = blockAt(w, "bittensor", queuedAt);
    const list: Payout[] = [
      { user: user1, shares: 0n, assets: 3n * E18 },
      { user: user2, shares: 0n, assets: 2n * E18 },
      { user: user3, shares: 9n * E18, assets: 10n * E18 },
    ];
    emit(w, "vault", "DepositBounced", { key, user: user1, assets: 3n * E18, reason: 0 }, block);
    emit(w, "vault", "DepositBounced", { key, user: user2, assets: 2n * E18, reason: 1 }, block);
    emit(w, "vault", "Redeemed", { key, user: user3, shares: 9n * E18, assets: 10n * E18 }, block);
    // another batch's entry, never in this one's list
    emit(w, "vault", "Redeemed", { key: keccak256(stringToBytes("another")), user: user1, shares: 1n, assets: 1n }, block);
    const batch: Batch = { sourceChain: 8_453n, frontDoor: plan.addresses.frontDoor, batchId: 7n, queuedAt: BigInt(queuedAt), cursor: 1, count: 3, chunk: 0, remaining: 12n * E18, payoutsHash: payoutsHash(list) };
    w.batches.set(key, batch);
    const run = () => cancelPayoutsCommand(ctxOf(w), record(), { ...opts(dir), key });
    // the cursor inside the bounces: it re-mints the redeem and carries the bounce left
    const r = await run();
    const call = parseWalletFile(JSON.parse(readFileSync(r.files[0], "utf8"))).calls[0];
    expect(call).toMatchObject({ chainId: 964, to: plan.addresses.vault, from: plan.roles.owner });
    const d = decodeFunctionData({ abi: build.vaultAbi, data: call.data });
    expect(d.functionName).toBe("cancelPayoutBatch");
    expect(d.args?.[0]).toBe(key);
    expect((d.args?.[1] as Payout[]).map((p) => [p.user, p.shares, p.assets])).toEqual(list.map((p) => [p.user, p.shares, p.assets]));
    const text = r.lines.join("\n");
    expect(text).toContain("re-mints 1 redeem (10 TAO)");
    expect(text).toContain("carries 1 bounced deposit");
    expect(text).toContain("returns each cancelled leaver to the vault at today's price");
    expect(text).toContain("stamps the owner's clock");
    // carried: the batch's list is now its last bounce; nothing to re-mint, which is final (A16)
    emit(w, "vault", "PayoutBatchCancelled", { key, reminted: 10n * E18, bouncesCarried: 1 }, block + 100);
    w.batches.set(key, { ...batch, cursor: 0, count: 1, remaining: 2n * E18, payoutsHash: payoutsHash([list[1]]) });
    const n = filesIn(dir).length;
    await expect(run()).rejects.toThrow(/nothing to cancel.*bounced deposit.*final/s);
    // a list the logs can't rebuild to the batch's hash writes nothing
    w.batches.set(key, { ...batch, payoutsHash: `0x${"12".repeat(32)}` });
    await expect(run()).rejects.toThrow(/does not match the batch's hash/);
    // a batch read whole and empty (sent, or deleted by a cancel that carried nothing) is final
    w.batches.delete(key);
    await expect(run()).rejects.toThrow(/nothing to cancel: the vault holds no payout batch under .*final/);
    expect(filesIn(dir)).toHaveLength(n);
  });

  it("T16: writeOffMissingStake is scheduled at the missing stake less the unlisted, as read now", async () => {
    const w = world();
    const dir = tempDir("write-off");
    const lens = w.book[plan.addresses.vaultLens.toLowerCase()].answers;
    lens.missingStakeRao = 50n * RAO;
    lens.unlistedStakeRao = 20n * RAO;
    const run = (args: string[]) => scheduleCommand(ctxOf(w), record(), { ...opts(dir), contract: "vault", fn: "writeOffMissingStake", args });
    const r = await run([]);
    const inner = decodeFunctionData({ abi: build.vaultAbi, data: parseWalletFile(JSON.parse(readFileSync(r.files[0], "utf8"))).calls[0].data }).args?.[0] as Hex;
    expect(decodeFunctionData({ abi: build.vaultAbi, data: inner }).args).toEqual([30n * RAO]);
    expect(r.lines.join("\n")).toContain("7 days");
    // more than that reverts WriteOffTooLarge at execute: refused
    await expect(run([String(31n * RAO)])).rejects.toThrow(/WriteOffTooLarge/);
    lens.unlistedStakeRao = 50n * RAO;
    await expect(run([])).rejects.toThrow(/nothing to write off/);
  });

  it("R6 (ChatGPT R2 claim C): a write-off's execute is checked again against the missing stake less the unlisted, read now, and goes with a fixed 47,000,000 gas limit, never a wallet's estimate", async () => {
    const w = world();
    const dir = tempDir("write-off-execute");
    const lens = w.book[plan.addresses.vaultLens.toLowerCase()].answers;
    lens.missingStakeRao = 50n * RAO;
    lens.unlistedStakeRao = 20n * RAO;
    const item = put(w, "vault", "writeOffMissingStake", [30n * RAO], HEAD_TIME - 8 * D);
    const run = () => executeCommand(ctxOf(w), record(), { ...opts(dir), id: item.id });
    const r = await run();
    const call = parseWalletFile(JSON.parse(readFileSync(r.files[0], "utf8"))).calls[0];
    // the contracts' write-off read gets 45,000,000 whole (requireGasFor), through execute's self-call: about 46.5M
    expect(WRITE_OFF_EXECUTE_GAS).toBe(47_000_000n);
    expect(WRITE_OFF_EXECUTE_GAS <= BITTENSOR_TX_GAS_CEILING).toBe(true);
    expect(call.gas).toBe("47000000");
    // the simulation sent that gas too
    const sims = w.calls.filter((x) => x.method === "eth_call" && x.data === call.data);
    expect(sims.length).toBeGreaterThan(0);
    expect(sims.every((x) => x.gas === numberToHex(47_000_000n))).toBe(true);
    const text = r.lines.join("\n");
    expect(text).toContain("The write-off is still at most the missing stake less the unlisted, read now: 30000000000 rao of 30000000000.");
    expect(text).toContain("It is sent with a gas limit of 47,000,000, set by the file: the owner's account on Bittensor must hold that gas at the gas price up front (only the gas used is paid).");
    // stake came back on an unlisted hotkey since it was scheduled: refused
    lens.unlistedStakeRao = 25n * RAO;
    await expect(run()).rejects.toThrow(
      "writeOffMissingStake(30000000000) is now more than the missing stake less the unlisted (25000000000 rao, read now): stake came back on a hotkey the vault doesn't list. Don't execute it: list that hotkey (addHotkey), and schedule a new write-off if any is still missing; nothing written",
    );
    // the unlisted stake unread: refused, never taken as 0
    lens.unlistedStakeRao = new RpcError("execution reverted", 3);
    await expect(run()).rejects.toThrow(/the missing and the unlisted stake/);
    // any other execute carries no gas limit of its own
    const other = put(w, "vault", "setMaxTotalAssets", [2_000n * E18], HEAD_TIME - 8 * D);
    const o = await executeCommand(ctxOf(w), record(), { ...opts(dir), id: other.id });
    expect(parseWalletFile(JSON.parse(readFileSync(o.files[0], "utf8"))).calls[0].gas).toBeUndefined();
  });

  it("the scheduler's own calls are the build's (schedule, execute, cancel)", () => {
    for (const abi of [build.vaultAbi, build.contracts.CascadeFrontDoor.abi]) {
      for (const f of SCHEDULER_ABI as readonly AbiFunction[]) {
        const mine = abi.find((x): x is AbiFunction => x.type === "function" && x.name === f.name);
        expect(mine && toFunctionSelector(mine), f.name).toBe(toFunctionSelector(f));
      }
    }
  });

  it("arguments: schedule, pending, execute and cancel", () => {
    const id = `0x${"ab".repeat(32)}`;
    expect(parseArgs(["schedule", "vault", "setMaxTotalAssets", "5", "--for-wallet", "--live"])).toEqual({ cmd: "schedule", live: true, users: [], forWallet: true, contract: "vault", fn: "setMaxTotalAssets", fnArgs: ["5"] });
    expect(parseArgs(["schedule", "front-door", "setMinPoolLiquidity", "1", "0", "--live", "--for-wallet"])).toMatchObject({ contract: "front-door", fn: "setMinPoolLiquidity", fnArgs: ["1", "0"] });
    expect(parseArgs(["schedule", "vault", "writeOffMissingStake", "--for-wallet", "--live"])).toMatchObject({ fnArgs: [] });
    expect(parseArgs(["pending"])).toEqual({ cmd: "pending", live: false, users: [] });
    expect(parseArgs(["pending", "--live"])).toEqual({ cmd: "pending", live: true, users: [] });
    expect(parseArgs(["execute", id, "--for-wallet", "--live"])).toEqual({ cmd: "execute", live: true, users: [], forWallet: true, id });
    expect(parseArgs(["cancel", id, "--as", "guardian", "--for-wallet", "--live"])).toEqual({ cmd: "cancel", live: true, users: [], forWallet: true, id, as: "guardian" });
    expect(parseArgs(["execute", id, "--on", "front-door", "--for-wallet", "--live"])).toEqual({ cmd: "execute", live: true, users: [], forWallet: true, id, on: "front-door" });
    expect(parseArgs(["cancel-payouts", id, "--for-wallet", "--live"])).toEqual({ cmd: "cancel-payouts", live: true, users: [], forWallet: true, id });
    expect(() => parseArgs(["execute", id, "--on", "staker", "--for-wallet", "--live"])).toThrow(/--on vault or --on front-door/);
    expect(() => parseArgs(["cancel", id, "--on", "vault", "--as", "owner", "--for-wallet", "--live"])).toThrow(UsageError);
    // the batch's cancel is the owner's alone, and the scheduler's cancel never takes a batch
    expect(() => parseArgs(["cancel-payouts", id, "--as", "owner", "--for-wallet", "--live"])).toThrow(UsageError);
    expect(() => parseArgs(["cancel-payouts", "--for-wallet", "--live"])).toThrow(/needs the payout batch's key/);
    expect(() => parseArgs(["cancel-payouts", id, "--live"])).toThrow(/--for-wallet/);
    // ops signs nothing here: the file is the only way out, and it is for the live deployment
    expect(() => parseArgs(["schedule", "vault", "setMaxTotalAssets", "5", "--live"])).toThrow(/--for-wallet/);
    expect(() => parseArgs(["execute", id, "--for-wallet"])).toThrow(/add --live/);
    expect(() => parseArgs(["schedule", "vault", "--for-wallet", "--live"])).toThrow(/needs the contract and the function/);
    expect(() => parseArgs(["execute", "0x1234", "--for-wallet", "--live"])).toThrow(/is not an item id/);
    expect(() => parseArgs(["cancel", id, "--for-wallet", "--live"])).toThrow(/--as owner or --as guardian/);
    expect(() => parseArgs(["cancel", id, "--as", "keeper", "--for-wallet", "--live"])).toThrow(/--as owner or --as guardian/);
    expect(() => parseArgs(["pending", "--for-wallet"])).toThrow(UsageError);
  });
});

// ---- Task 47b: the rail between the chains ----

describe("Task 47b: a one-sided rail switch is refused", () => {
  const A = () => plan.addresses.baseAdapter;
  const B = () => plan.addresses.bitAdapter;
  const low = (a: string) => a.toLowerCase();
  /** The two pairs' state by hand: the launch pair (A on Base, B on Bittensor) enabled and primary, the second (A2, B2)
   * not active, each adapter the other's peer. */
  const state = (o: { vault?: [Address, Address[]]; door?: [Address, Address[]]; known?: Address[]; pending?: RailState["pending"]; planned?: RailState["planned"] } = {}): RailState => {
    const [vp, ve] = o.vault ?? [B(), [B()]];
    const [dp, de] = o.door ?? [A(), [A()]];
    // the front door knows the launch pair's half, and whatever it has enabled since
    const known = o.known ?? [A(), ...de];
    return {
      heads: { vault: { block: 3_000_000, time: HEAD_TIME }, frontDoor: { block: 30_000_000, time: HEAD_TIME } },
      primary: { vault: vp, frontDoor: dp },
      sendsTo: { vault: 8_453n, frontDoor: 964n },
      peers: {
        vault: { [low(B())]: { peer: A(), chain: 8_453n }, [low(BIT2)]: { peer: BASE2, chain: 8_453n } },
        frontDoor: { [low(A())]: { peer: B(), chain: 964n }, [low(BASE2)]: { peer: BIT2, chain: 964n } },
      },
      enabled: {
        vault: { [low(B())]: ve.includes(B()), [low(BIT2)]: ve.includes(BIT2) },
        frontDoor: { [low(A())]: de.includes(A()), [low(BASE2)]: de.includes(BASE2) },
      },
      doorKnown: { [low(A())]: known.includes(A()), [low(BASE2)]: known.includes(BASE2) },
      pending: o.pending ?? [],
      planned: o.planned ?? [],
    };
  };
  const planned = (contract: SchedulerContract, fn: "activateBridge" | "disableBridge" | "setPrimaryBridge", bridge: Address) => ({ contract, fn, bridge, source: "planned" as const, by: "owner" as const });

  it("railCoherence: the rails once every pending and planned item has run, each pair that would be refused at one end named", () => {
    // coherent: each primary's other half enabled on the other side
    const honest = railCoherence(state());
    expect(honest.coherent).toBe(true);
    expect(honest.primary).toEqual({ vault: { bridge: B(), enabled: true, peer: A() }, frontDoor: { bridge: A(), enabled: true, peer: B() } });
    // a setPrimaryBridge on one side only: the vault on B2 (its primary B disabled), the front door still on A
    const oneSided = railCoherence(state({ vault: [B(), [BIT2]], door: [A(), [A()]], planned: [planned("vault", "setPrimaryBridge", BIT2)] }));
    expect(oneSided.coherent).toBe(false);
    expect(oneSided.incoherent).toEqual([
      { from: "frontDoor", primary: A(), peer: B(), chain: 964n },
      { from: "vault", primary: BIT2, peer: BASE2, chain: 8_453n },
    ]);
    // both sides in one file: coherent
    const both = state({ vault: [B(), [BIT2]], door: [A(), [BASE2]], planned: [planned("frontDoor", "setPrimaryBridge", BASE2), planned("vault", "setPrimaryBridge", BIT2)] });
    expect(railCoherence(both).coherent).toBe(true);
    expect(railCoherence(both).primary.vault).toEqual({ bridge: BIT2, enabled: true, peer: BASE2 });
    // a disable of the bridge the other side's primary uses: the vault's B, the front door's primary's half
    const off = railCoherence(state({ planned: [planned("vault", "disableBridge", B())] }));
    expect(off.incoherent).toEqual([{ from: "frontDoor", primary: A(), peer: B(), chain: 964n }]);
    // the front door takes a payout from any bridge it ever enabled (the coordinator's correction): its own disable of A,
    // the vault's primary's half, refuses nothing, and the halfway state of a switch made the front door first passes
    // (the front door on A2, A disabled there but known; the vault still on B, with B2 enabled for A2's batches)
    expect(railCoherence(state({ planned: [planned("frontDoor", "disableBridge", A())] })).coherent).toBe(true);
    const halfway = railCoherence(state({ vault: [B(), [B(), BIT2]], door: [BASE2, [BASE2]], known: [A(), BASE2] }));
    expect(halfway.coherent).toBe(true);
    expect(halfway.primary).toEqual({ vault: { bridge: B(), enabled: true, peer: A() }, frontDoor: { bridge: BASE2, enabled: true, peer: BIT2 } });
    // ... and a vault primary whose Base half the front door never enabled is refused there
    expect(railCoherence(state({ vault: [B(), [BIT2]], door: [A(), []], known: [A()], planned: [planned("vault", "setPrimaryBridge", BIT2)] })).incoherent).toEqual([
      { from: "vault", primary: BIT2, peer: BASE2, chain: 8_453n },
    ]);
    // ... and, mid-migration (the front door on A2, the vault still on B), the vault's disable of B2, a non-primary
    expect(railCoherence(state({ vault: [B(), [B(), BIT2]], door: [BASE2, [A(), BASE2]], planned: [planned("vault", "disableBridge", BIT2)] })).incoherent).toEqual([
      { from: "frontDoor", primary: BASE2, peer: BIT2, chain: 964n },
    ]);
    // both primaries disabled: nothing crosses, so no pair is refused
    expect(railCoherence(state({ planned: [planned("frontDoor", "disableBridge", A()), planned("vault", "disableBridge", B())] })).coherent).toBe(true);
    // an activation on one side only, of a bridge whose other half the other side hasn't: a half
    const half = railCoherence(state({ planned: [planned("vault", "activateBridge", BIT2)] }));
    expect(half.halves).toEqual([{ contract: "vault", bridge: BIT2, peer: BASE2 }]);
    expect(half.coherent).toBe(false);
    expect(railCoherence(state({ planned: [planned("frontDoor", "activateBridge", BASE2), planned("vault", "activateBridge", BIT2)] })).coherent).toBe(true);
    // the other half already pending on the front door: not a half
    const pendingA2 = { contract: "frontDoor" as const, fn: "activateBridge" as const, bridge: BASE2, source: "pending" as const, id: keccak256("0x01"), kind: "Ordinary" as const };
    expect(railCoherence(state({ pending: [pendingA2], planned: [planned("vault", "activateBridge", BIT2)] })).coherent).toBe(true);
    // a pending Reopen of a disabled primary counts: the vault's B back, so the front door's A is carried again
    const reopenB = { contract: "vault" as const, fn: "activateBridge" as const, bridge: B(), source: "pending" as const, id: keccak256("0x02"), kind: "Reopen" as const };
    expect(railCoherence(state({ vault: [B(), []] })).incoherent).toHaveLength(1);
    expect(railCoherence(state({ vault: [B(), []], pending: [reopenB] })).coherent).toBe(true);
    // a disable of a primary stamps its sender's clock: the activations pending on that side die and never run
    const pendingB2 = { contract: "vault" as const, fn: "activateBridge" as const, bridge: BIT2, source: "pending" as const, id: keccak256("0x03"), kind: "Ordinary" as const };
    const killed = railCoherence(state({ pending: [pendingB2], planned: [planned("frontDoor", "disableBridge", A()), planned("vault", "disableBridge", B())] }));
    expect(killed.killed).toEqual([pendingB2]);
    // a guardian's stamp kills only the Ordinary ones
    const byGuardian = { ...planned("vault", "disableBridge", B()), by: "guardian" as const };
    expect(railCoherence(state({ pending: [pendingB2, reopenB], planned: [byGuardian] })).killed).toEqual([pendingB2]);
    // a primary that sends to another chain is refused there too, and, as a half naming that chain as its source, it
    // takes nothing from the other side
    const wrong = state();
    wrong.peers.vault[low(B())] = { peer: A(), chain: 10n };
    expect(railCoherence(wrong).incoherent).toEqual([
      { from: "frontDoor", primary: A(), peer: B(), chain: 964n, back: { peer: A(), chain: 10n } },
      { from: "vault", primary: B(), peer: A(), chain: 10n },
    ]);
    // each pair's halves must name each other, as the monitor's rule reads them: B taking messages only from A2 refuses
    // the front door's A, and the vault's B then sends to A2, which names B2
    const crossed = state();
    crossed.peers.vault[low(B())] = { peer: BASE2, chain: 8_453n };
    expect(railCoherence(crossed).incoherent).toEqual([
      { from: "frontDoor", primary: A(), peer: B(), chain: 964n, back: { peer: BASE2, chain: 8_453n } },
      { from: "vault", primary: B(), peer: BASE2, chain: 8_453n, back: { peer: BIT2, chain: 964n } },
    ]);
    // and an activation whose other half names another sender is a half, though that half is enabled
    const named = state({ door: [A(), [A(), BASE2]], planned: [planned("vault", "activateBridge", BIT2)] });
    named.peers.frontDoor[low(BASE2)] = { peer: B(), chain: 964n };
    expect(railCoherence(named).halves).toEqual([{ contract: "vault", bridge: BIT2, peer: BASE2, back: { peer: B(), chain: 964n } }]);
    // a flag the state lacks is never taken as enabled: it throws
    const unread = state();
    delete unread.enabled.vault[low(B())];
    expect(() => railCoherence(unread)).toThrow(/was not read/);
    const unknown = state();
    delete unknown.doorKnown[low(A())];
    expect(() => railCoherence(unknown)).toThrow(/is known to the front door \(Base\) was not read/);
  });

  /** The world after both pairs' activations ran: B2 and A2 enabled beside the launch pair. */
  const activated = () => {
    const w = world();
    w.rails.vault.enabled.add(low(BIT2));
    w.rails.frontDoor.enabled.add(low(BASE2));
    w.rails.frontDoor.known.add(low(BASE2));
    return w;
  };
  const rail = (w: World, dir: string, contract: string, fn: string, args: string[], oneSided?: string) =>
    railScheduleCommand(ctxOf(w), record(), { ...opts(dir), contract, fn, args, ...(oneSided !== undefined ? { oneSided } : {}) });

  it("a one-sided setPrimaryBridge is refused, naming the pair and the both-chains file; nothing written", async () => {
    // the guardian disabled the vault's primary; B2 is enabled on the vault, A2 never activated on the front door
    const w = world();
    w.rails.vault.enabled = new Set([low(BIT2)]);
    const dir = tempDir("rails-one-sided");
    const e = await rail(w, dir, "vault", "setPrimaryBridge", [BIT2]).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe(
      `the two chains would disagree on the bridge once this file and the pending items run: the front door's primary ${A()} sends to ${B()} on Bittensor, which is not enabled on the vault; and the vault's primary ${BIT2} sends to ${BASE2} on Base, which the front door has never enabled. A rail switch is one two-sided operation: put both sides in one file: pnpm ops schedule both setPrimaryBridge ${BIT2} ${BASE2} --for-wallet --live; or, if one side must go first, add --one-sided "<reason>"; nothing written`,
    );
    expect(filesIn(dir)).toEqual([]);
    // the contract was asked first, from the owner: the call itself would succeed
    expect(w.calls.some((c) => c.method === "eth_call" && c.data?.startsWith(toFunctionSelector("setPrimaryBridge(address)")) && sameText(c.from, plan.roles.owner))).toBe(true);
    // pnpm ops schedule's own path never writes a rail call without the check
    await expect(scheduleCommand(ctxOf(w), record(), { ...opts(dir), contract: "vault", fn: "setPrimaryBridge", args: [BIT2] })).rejects.toThrow(/changes the bridges.*rail check/);
    await expect(scheduleCommand(ctxOf(w), record(), { ...opts(dir), contract: "vault", fn: "activateBridge", args: [BIT2] })).rejects.toThrow(/changes the bridges.*rail check/);
    expect(filesIn(dir)).toEqual([]);
  });

  it("a both-chains switch passes: the old pair disabled on both chains in one file, then the new pair made primary on both", async () => {
    const w = activated();
    const dir = tempDir("rails-both");
    // one side's disable alone is refused: the vault's B is the front door's primary's other half
    await expect(rail(w, dir, "vault", "disableBridge", [B()])).rejects.toThrow(
      `the two chains would disagree on the bridge once this file and the pending items run: the front door's primary ${A()} sends to ${B()} on Bittensor, which is not enabled on the vault. A rail switch is one two-sided operation: put both sides in one file: pnpm ops schedule both disableBridge ${B()} ${A()} --for-wallet --live`,
    );
    expect(filesIn(dir)).toEqual([]);
    // both sides in one file: the front door's call first, each from the owner, each asked of its contract
    const off = await rail(w, dir, "both", "disableBridge", [B(), A()]);
    expect(off.ok).toBe(true);
    const file = parseWalletFile(JSON.parse(readFileSync(off.files[0], "utf8")));
    expect(file.oneSided).toBeUndefined();
    // in order (the fix round's Critical 1): sent the vault's first, the front door's A would send to a disabled B
    expect(file.ordered).toBe(true);
    expect(file.calls).toEqual([
      { chainId: 8_453, to: plan.addresses.frontDoor, data: encodeFunctionData({ abi: abiOf("frontDoor"), functionName: "disableBridge", args: [A()] }), value: "0", label: `disableBridge(${A()}) on the front door (Base)`, from: plan.roles.owner },
      { chainId: 964, to: plan.addresses.vault, data: encodeFunctionData({ abi: abiOf("vault"), functionName: "disableBridge", args: [B()] }), value: "0", label: `disableBridge(${B()}) on the vault (Bittensor)`, from: plan.roles.owner },
    ]);
    expect(file.title).toBe(`Cascade v3.2-launch: disableBridge on both chains, ${A()} on the front door and ${B()} on the vault: sign both calls`);
    expect(off.lines).toContain("  It is the vault's primary bridge: disabling it closes the exits on Bittensor and stamps the owner's clock, until the owner makes another enabled bridge the primary (setPrimaryBridge).");
    expect(off.lines).toContain("  Once this file and the pending items run, the two chains agree on the bridge: both primaries are disabled, so nothing crosses either way until the owner makes an enabled bridge the primary on each chain.");
    expect(off.lines).toContain("  Right after each call is sent, in order, before any pending item runs, the two chains agree on the bridge too.");
    expect(off.lines.at(-1)).toBe("The file holds both chains' calls, in order, the front door's first: sign both. The page sends the vault's only once the front door's has succeeded.");
    // once both are sent: the new pair made primary on both chains in one file
    w.rails.vault.enabled.delete(low(B()));
    w.rails.frontDoor.enabled.delete(low(A()));
    const on = await rail(w, dir, "both", "setPrimaryBridge", [BIT2, BASE2]);
    expect(on.lines).toContain(
      `  Once this file and the pending items run, the two chains agree on the bridge: the front door's primary ${BASE2} sends to ${BIT2} on Bittensor, enabled on the vault; the vault's primary ${BIT2} sends to ${BASE2} on Base, which the front door has enabled.`,
    );
    expect(on.lines).toContain("  Right after each call is sent, in order, before any pending item runs, the two chains agree on the bridge too.");
    const onFile = parseWalletFile(JSON.parse(readFileSync(on.files[0], "utf8")));
    // the vault's switch first (R6, claim D): sent the other way, the front door's batches would reach the vault while its
    // primary is still disabled
    expect(onFile.calls.map((c) => c.label)).toEqual([`setPrimaryBridge(${BIT2}) on the vault (Bittensor)`, `setPrimaryBridge(${BASE2}) on the front door (Base)`]);
    expect(onFile.ordered).toBe(true);
    // the activations too: one side's alone is a half, both in one file pass, and a pending other half counts
    const fresh = world();
    const acts = tempDir("rails-activations");
    await expect(rail(fresh, acts, "vault", "activateBridge", [BIT2])).rejects.toThrow(
      `${BIT2} would be enabled on the vault alone: its other half, ${BASE2} on Base, the front door has never enabled, nor is it pending there or in this file. A rail switch is one two-sided operation: put both sides in one file: pnpm ops schedule both activateBridge ${BIT2} ${BASE2} --for-wallet --live`,
    );
    const pair = await rail(fresh, acts, "both", "activateBridge", [BIT2, BASE2]);
    const pairFile = parseWalletFile(JSON.parse(readFileSync(pair.files[0], "utf8")));
    expect(pairFile.calls).toEqual([scheduleCall(record(), "frontDoor", "activateBridge", [BASE2], { buildsDir }), scheduleCall(record(), "vault", "activateBridge", [BIT2], { buildsDir })]);
    expect(pair.lines.join("\n")).toContain("A Registry item (7 days), Ordinary");
    // two schedules take effect only when each is executed: in no fixed order, and nothing judged right after they're sent
    expect(pairFile.ordered).toBe(false);
    expect(pair.lines.join("\n")).not.toMatch(/Right after/);
    expect(pair.lines.at(-1)).toBe("The file holds both chains' calls, the front door's first: sign both. Signed alone, either one leaves the two chains disagreeing on the bridge.");
    put(fresh, "frontDoor", "activateBridge", [BASE2], HEAD_TIME - D);
    expect((await rail(fresh, acts, "vault", "activateBridge", [BIT2])).ok).toBe(true);
  });

  it("a switch made one side at a time passes each step: both disables, the front door's first, then the vault's switch, then the front door's", async () => {
    const w = activated();
    const dir = tempDir("rails-one-at-a-time");
    // each step is judged right after it is sent too, with no pending item counted (the fix round's Critical 1)
    const rightAfter = "  Right after it is sent, before any pending item runs, the two chains agree on the bridge too.";
    // the front door disables A, the vault's primary's half: the vault's payouts are still taken (A stays known)
    const first = await rail(w, dir, "front-door", "disableBridge", [A()]);
    expect(first.ok).toBe(true);
    expect(first.lines).toContain(rightAfter);
    w.rails.frontDoor.enabled.delete(low(A()));
    // the vault disables B: both primaries off, nothing crosses
    const second = await rail(w, dir, "vault", "disableBridge", [B()]);
    expect(second.lines).toContain(rightAfter);
    w.rails.vault.enabled.delete(low(B()));
    // the vault's switch to B2: its payouts go to A2, which the front door has enabled; the front door's A carries nothing
    const third = await rail(w, dir, "vault", "setPrimaryBridge", [BIT2]);
    expect(third.lines).toContain(
      `  Once this file and the pending items run, the two chains agree on the bridge: the front door's primary ${A()} is disabled, so it sends nothing; the vault's primary ${BIT2} sends to ${BASE2} on Base, which the front door has enabled.`,
    );
    expect(third.lines).toContain(rightAfter);
    w.rails.vault.primary = BIT2;
    // then the front door's switch to A2
    const done = await rail(w, dir, "front-door", "setPrimaryBridge", [BASE2]);
    expect(done.lines).toContain(
      `  Once this file and the pending items run, the two chains agree on the bridge: the front door's primary ${BASE2} sends to ${BIT2} on Bittensor, enabled on the vault; the vault's primary ${BIT2} sends to ${BASE2} on Base, which the front door has enabled.`,
    );
    expect(done.lines).toContain(rightAfter);
    expect(filesIn(dir)).toHaveLength(4);
    // the vault first is refused at its first step: its disable of B leaves the front door's A sending to a disabled bridge
    await expect(rail(activated(), dir, "vault", "disableBridge", [B()])).rejects.toThrow(/the front door's primary .* sends to .* on Bittensor, which is not enabled on the vault/);
  });

  it("R6 (ChatGPT R2 claim D): a disabled vault primary is no payout rail while the front door's primary carries batches to another bridge the vault has enabled; the front door's switch first is refused", async () => {
    const window = `the front door's primary ${BASE2} sends to ${BIT2} on Bittensor while the vault's primary ${B()} is disabled: the vault has no payout rail, so it defers every redeem those batches carry (switch the vault's primary first)`;
    // the state by hand: the vault's B disabled and still its primary, B2 enabled there; the front door on A2
    const s = railCoherence(state({ vault: [B(), [BIT2]], door: [BASE2, [BASE2]], known: [A(), BASE2] }));
    expect(s.coherent).toBe(false);
    expect(s.incoherent).toEqual([{ from: "frontDoor", primary: BASE2, peer: BIT2, chain: 964n, noPayoutRail: B() }]);
    expect(problemsText(s)).toBe(window);
    // its effect is said in its own words: no batch is parked, so the residual's words add nothing
    expect(residualFor(s)).toBe("");
    // the front door's own primary disabled: nothing is carried, so nothing is deferred
    expect(railCoherence(state({ vault: [B(), [BIT2]], door: [A(), [BASE2]], known: [A(), BASE2] })).coherent).toBe(true);
    // verify reads it now as a failure
    expect(railsFindings(state({ vault: [B(), [BIT2]], door: [BASE2, [BASE2]], known: [A(), BASE2] })).failures).toEqual([`The rails: now the two chains disagree on the bridge: ${window}.`]);

    // the commands: both old halves disabled, both new ones enabled
    const w = activated();
    w.rails.vault.enabled.delete(low(B()));
    w.rails.frontDoor.enabled.delete(low(A()));
    const dir = tempDir("rails-claim-d");
    // the front door's switch alone is refused: its batches would reach the vault while its primary is still disabled
    await expect(rail(w, dir, "front-door", "setPrimaryBridge", [BASE2])).rejects.toThrow(`the two chains would disagree on the bridge once this file and the pending items run: ${window}.`);
    expect(filesIn(dir)).toEqual([]);
    // both in one file: the vault's call first, then the front door's, and every state in between agrees
    const both = await rail(w, dir, "both", "setPrimaryBridge", [BIT2, BASE2]);
    const file = parseWalletFile(JSON.parse(readFileSync(both.files[0], "utf8")));
    expect(file.ordered).toBe(true);
    expect(file.calls.map((c) => c.label)).toEqual([`setPrimaryBridge(${BIT2}) on the vault (Bittensor)`, `setPrimaryBridge(${BASE2}) on the front door (Base)`]);
    expect(both.lines).toContain("  Right after each call is sent, in order, before any pending item runs, the two chains agree on the bridge too.");
    expect(both.lines.at(-1)).toBe("The file holds both chains' calls, in order, the vault's first: sign both. The page sends the front door's only once the vault's has succeeded.");
    // the front door already on A2 with the vault still on B: the vault's disable of B is refused, it opens the window
    const late = activated();
    late.rails.frontDoor.enabled.delete(low(A()));
    late.rails.frontDoor.primary = BASE2;
    await expect(rail(late, dir, "vault", "disableBridge", [B()])).rejects.toThrow(`the two chains would disagree on the bridge once this file and the pending items run: ${window}.`);
  });

  it("the runbook's switch (Task 53's fix round, the review's Important 2): the front door's disable alone, then the vault's alone once it has landed, then both primaries in one file, each passes", async () => {
    const w = activated();
    const dir = tempDir("rails-runbook-split");
    // closes stop on Base; the vault still takes a batch already crossing (its old bridge stays enabled)
    expect((await rail(w, dir, "front-door", "disableBridge", [A()])).ok).toBe(true);
    w.rails.frontDoor.enabled.delete(low(A()));
    // once no batch is in flight: the vault's disable, both primaries now off
    expect((await rail(w, dir, "vault", "disableBridge", [B()])).ok).toBe(true);
    w.rails.vault.enabled.delete(low(B()));
    const both = await rail(w, dir, "both", "setPrimaryBridge", [BIT2, BASE2]);
    expect(both.ok).toBe(true);
    expect(both.lines).toContain(
      `  Once this file and the pending items run, the two chains agree on the bridge: the front door's primary ${BASE2} sends to ${BIT2} on Bittensor, enabled on the vault; the vault's primary ${BIT2} sends to ${BASE2} on Base, which the front door has enabled.`,
    );
    expect(filesIn(dir)).toHaveLength(3);
  });

  it("a pair whose halves don't name each other is refused, as the monitor's rule reads it", async () => {
    // A2 was deployed naming the launch pair's B, not B2: neither new half takes the other's messages
    const w = world();
    w.book[BASE2.toLowerCase()].answers.remoteAdapter = B();
    const dir = tempDir("rails-crossed");
    await expect(rail(w, dir, "both", "activateBridge", [BIT2, BASE2])).rejects.toThrow(
      `the two chains would disagree on the bridge once this file and the pending items run: ${BASE2} would be enabled on the front door, but its other half, ${B()} on Bittensor, takes messages only from ${A()} on chain 8453; and ${BIT2} would be enabled on the vault, but its other half, ${BASE2} on Base, takes messages only from ${B()} on chain 964.`,
    );
    expect(filesIn(dir)).toEqual([]);
  });

  it("a disable of the bridge the other side's primary uses is refused, mid-migration too; a disable of the primary warns of the pending activations it kills", async () => {
    // the front door moved to A2 (one-sided, on purpose); the vault is still on B, with B2 enabled for A2's batches
    const w = activated();
    w.rails.frontDoor.primary = BASE2;
    const dir = tempDir("rails-disable");
    await expect(rail(w, dir, "vault", "disableBridge", [BIT2])).rejects.toThrow(
      `the front door's primary ${BASE2} sends to ${BIT2} on Bittensor, which is not enabled on the vault. A rail switch is one two-sided operation: put both sides in one file: pnpm ops schedule both disableBridge ${BIT2} ${BASE2} --for-wallet --live`,
    );
    expect(filesIn(dir)).toEqual([]);
    // the owner's disable of both primaries kills the activation pending on the vault: said, before anything is signed
    const k = world();
    const item = put(k, "vault", "activateBridge", [BIT2], HEAD_TIME - D);
    put(k, "frontDoor", "activateBridge", [BASE2], HEAD_TIME - D);
    const r = await rail(k, dir, "both", "disableBridge", [B(), A()]);
    expect(r.lines.join("\n")).toContain("WARNING — Disabling the primary stamps its sender's clock, so these pending activations die and never run: ");
    expect(r.lines.join("\n")).toContain(`item ${item.id}, activateBridge(${BIT2}) on the vault`);
  });

  it("--one-sided writes its reason into the file and prints the residual; it is refused where nothing would be refused", async () => {
    const w = world();
    w.rails.vault.enabled = new Set([low(BIT2)]);
    const dir = tempDir("rails-one-sided-reason");
    const why = "the vault moves first; the front door follows within the hour";
    const r = await rail(w, dir, "vault", "setPrimaryBridge", [BIT2], why);
    expect(r.ok).toBe(true);
    const file = parseWalletFile(JSON.parse(readFileSync(r.files[0], "utf8")));
    expect(file.oneSided).toBe(why);
    expect(file.title).toBe(`Cascade v3.2-launch: setPrimaryBridge(${BIT2}) on the vault (Bittensor) (one-sided)`);
    expect(file.calls).toEqual([
      { chainId: 964, to: plan.addresses.vault, data: encodeFunctionData({ abi: abiOf("vault"), functionName: "setPrimaryBridge", args: [BIT2] }), value: "0", label: `setPrimaryBridge(${BIT2}) on the vault (Bittensor)`, from: plan.roles.owner },
    ]);
    expect(r.lines).toContain(
      `WARNING — one-sided: once this file and the pending items run, the two chains disagree on the bridge: the front door's primary ${A()} sends to ${B()} on Bittensor, which is not enabled on the vault; and the vault's primary ${BIT2} sends to ${BASE2} on Base, which the front door has never enabled.`,
    );
    // the residual quoted whole, its payout half included (the spec at cc0f1ff; test/v32-rail-residual.test.ts)
    expect(r.lines).toContain(`  Spec section 5: "${RAIL_RESIDUAL[0]}" And: "${RAIL_RESIDUAL[1]} ${RAIL_RESIDUAL[2]}"`);
    expect(r.lines).toContain(`  Written all the same, with your reason in the file for the sign page to show: "${why}".`);
    // where the two chains would agree, --one-sided is refused: no reason is written that nothing needed
    const fine = tempDir("rails-one-sided-fine");
    await expect(rail(activated(), fine, "both", "disableBridge", [B(), A()], why)).rejects.toThrow(/--one-sided is for a file the rail check would refuse/);
    // and it goes only with the bridges' calls, as does both
    await expect(rail(world(), fine, "vault", "setPayoutDelay", ["43200"], why)).rejects.toThrow(/--one-sided goes only with a change to the bridges/);
    await expect(rail(world(), fine, "both", "setGuardian", [other, other])).rejects.toThrow(/both is for the bridges' calls/);
    await expect(rail(world(), fine, "both", "setPrimaryBridge", [BIT2])).rejects.toThrow(/takes two bridges: the vault's \(on Bittensor\), then the front door's/);
    expect(filesIn(fine)).toEqual([]);
  });

  it("R11 (ChatGPT r3, claim 2): a bridge the vault would read payouts through (its activation on the vault, or the vault's switch to it) must answer canSendPayouts() with one word, asked as the vault asks it; otherwise refused, nothing written", async () => {
    const VIEW = toFunctionSelector("canSendPayouts()");
    const asked = (w: World) => w.calls.filter((c) => c.method === "eth_call" && c.data === VIEW);
    // an honest new pair: the vault's half asked from the vault, with the gas the vault's staticcall gives the view
    // (RAIL_VIEW_GAS, 150,000, and what the call takes first); the front door's half is never asked
    const w = world();
    const ok = await rail(w, tempDir("rails-view-ok"), "both", "activateBridge", [BIT2, BASE2]);
    expect(ok.ok).toBe(true);
    expect(asked(w)).toEqual([{ chain: "bittensor", method: "eth_call", to: BIT2, from: plan.addresses.vault, data: VIEW, block: "latest", gas: numberToHex(RAIL_VIEW_CALL_GAS) }]);
    expect(ok.lines).toContain(`  ${BIT2} answers canSendPayouts() with one word (true: payouts open now), asked as the vault asks it (from the vault, with 150,000 gas).`);
    // the vault's switch to it is asked the same way, once the old pair is disabled; a false is one word too (payouts
    // closed now: a ForeverMoney pause)
    const switchable = () => {
      const x = activated();
      x.rails.vault.enabled.delete(low(B()));
      x.rails.frontDoor.enabled.delete(low(A()));
      return x;
    };
    const sw = switchable();
    sw.book[BIT2.toLowerCase()].answers.canSendPayouts = false;
    const on = await rail(sw, tempDir("rails-view-switch"), "both", "setPrimaryBridge", [BIT2, BASE2]);
    expect(asked(sw)).toHaveLength(1);
    expect(on.lines).toContain(`  ${BIT2} answers canSendPayouts() with one word (false: payouts closed now), asked as the vault asks it (from the vault, with 150,000 gas).`);
    // no such view (or one over the gas), no code at the address, two words: each refused, nothing written
    const dir = tempDir("rails-view-refused");
    const cases: [string, Answer, string][] = [
      ["a revert", new RpcError("execution reverted", 3, "0x"), "reverts (execution reverted)"],
      ["Bittensor's EVM halting it", new RpcError("evm error: OutOfGas", -32603), "reverts (evm error: OutOfGas)"],
      ["no code", new RawAnswer("0x"), "answers nothing"],
      ["two words", new RawAnswer(`0x${"00".repeat(63)}01`), "answers 64 bytes"],
    ];
    for (const [label, answer, says] of cases) {
      for (const [fn, sides] of [
        ["activateBridge", world],
        ["setPrimaryBridge", switchable],
      ] as const) {
        const x = sides();
        x.book[BIT2.toLowerCase()].answers.canSendPayouts = answer;
        const e = await rail(x, dir, "both", fn, [BIT2, BASE2]).catch((y: Error) => y);
        expect(e, `${label}, ${fn}`).toBeInstanceOf(Error);
        expect((e as Error).message, `${label}, ${fn}`).toBe(
          `${BIT2} doesn't answer canSendPayouts() with one word when the vault asks it (from the vault, with 150,000 gas): it ${says}. The vault reads that as payouts open, so it would take unstakes from Base into a queue this bridge may never pay; only a bridge that answers one word can carry the vault's payouts; nothing written`,
        );
      }
    }
    expect(filesIn(dir)).toEqual([]);
    // a node's own error is a read that failed: to try again
    const flaky = world();
    flaky.book[BIT2.toLowerCase()].answers.canSendPayouts = new RpcError("header not found", -32000);
    await expect(rail(flaky, dir, "vault", "activateBridge", [BIT2])).rejects.toThrow(`Couldn't read ${BIT2}'s canSendPayouts() right now (header not found); try again; nothing written`);
    expect(filesIn(dir)).toEqual([]);
  });

  it("a failed read refuses, to try again, and is never read as the two chains agreeing", async () => {
    const dir = tempDir("rails-unread");
    const flaky = new RpcError("header not found", -32000);
    const cases: [string, (w: World) => void, RegExp][] = [
      ["the front door's bridges", (w) => (w.book[plan.addresses.doorLens.toLowerCase()].answers.bridgeEnabled = flaky), /header not found/],
      ["the vault's primary", (w) => (w.book[plan.addresses.vaultLens.toLowerCase()].answers.primaryBridge = flaky), /header not found/],
      ["an adapter's peer", (w) => (w.book[plan.addresses.baseAdapter.toLowerCase()].answers.remoteAdapter = revert("InvalidParameter")), /execution reverted/],
      ["the front door's chain for the vault", (w) => (w.book[plan.addresses.frontDoor.toLowerCase()].answers.vaultChain = flaky), /header not found/],
      ["Base's pending items", (w) => (w.logsFail = "base"), /query timeout exceeded/],
    ];
    // a both-chains activation, which reads nothing of the rails before the rail check does
    for (const [label, fail, why] of cases) {
      const w = world();
      fail(w);
      const e = await rail(w, dir, "both", "activateBridge", [BIT2, BASE2]).catch((x: Error) => x);
      expect(e, label).toBeInstanceOf(Error);
      expect((e as Error).message, label).toMatch(/^Couldn't read the rails \(each chain's primary and bridges, and the pending items\) right now \(/);
      expect((e as Error).message, label).toMatch(why);
      expect((e as Error).message, label).toMatch(/; try again; nothing written$/);
    }
    // what the front door has ever enabled (an activation reads it first for its own kind, so a disable here)
    const k = activated();
    k.book[plan.addresses.doorLens.toLowerCase()].answers.bridgeKnown = flaky;
    await expect(rail(k, dir, "both", "disableBridge", [B(), A()])).rejects.toThrow(
      "Couldn't read the rails (each chain's primary and bridges, and the pending items) right now (header not found); try again; nothing written",
    );
    // an activation pending that the lens can't judge: the rails can't be known
    const w = activated();
    const item = put(w, "vault", "activateBridge", [another], HEAD_TIME - D);
    const items = w.items.vault;
    w.book[plan.addresses.vaultLens.toLowerCase()].answers.scheduled = (args: readonly unknown[]) => (sameText(args[0], item.id) ? flaky : (items.get(String(args[0]).toLowerCase()) ?? EMPTY_ITEM));
    await expect(rail(w, dir, "both", "disableBridge", [B(), A()])).rejects.toThrow(`item ${item.id} on the vault (Bittensor), an activation of a bridge, could not be judged (the lens could not read it (header not found))`);
    // a node without the vault's history: refused as it is
    const h = activated();
    h.logs.bittensor = [];
    await expect(rail(h, dir, "both", "disableBridge", [B(), A()])).rejects.toThrow(/this RPC doesn't keep history/);
    expect(filesIn(dir)).toEqual([]);
  });

  it("the rails are read at one pinned head a chain: every rail read at that block, the pending items' too", async () => {
    const w = activated();
    put(w, "frontDoor", "activateBridge", [another], HEAD_TIME - D);
    w.calls.length = 0;
    const s = await readRails(ctxOf(w), record(), { buildsDir });
    expect(s.heads).toEqual({ vault: { block: w.heads.bittensor, time: HEAD_TIME }, frontDoor: { block: w.heads.base, time: HEAD_TIME } });
    expect(s.pending.map((p) => [p.contract, p.bridge])).toEqual([["frontDoor", another]]);
    const rails = ["primaryBridge()", "bridgeEnabled(address)", "bridgeKnown(address)", "remoteAdapter()", "remoteChainId()", "launchChain()", "vaultChain()", "scheduled(bytes32)"].map((x) => toFunctionSelector(x));
    const read = w.calls.filter((c) => c.method === "eth_call" && rails.includes(c.data?.slice(0, 10) as Hex));
    expect(read.length).toBeGreaterThan(8);
    for (const c of read) expect(c.block, c.data).toBe(numberToHex(w.heads[c.chain]));
  });

  it("arguments: schedule both, and --one-sided with its reason", () => {
    expect(parseArgs(["schedule", "both", "setPrimaryBridge", BIT2, BASE2, "--one-sided", "the vault first", "--for-wallet", "--live"])).toEqual({
      cmd: "schedule",
      live: true,
      users: [],
      contract: "both",
      fn: "setPrimaryBridge",
      fnArgs: [BIT2, BASE2],
      oneSided: "the vault first",
      forWallet: true,
    });
    expect(() => parseArgs(["schedule", "vault", "setPrimaryBridge", BIT2, "--one-sided", "--for-wallet", "--live"])).toThrow(/--one-sided needs a value/);
    expect(() => parseArgs(["schedule", "vault", "setPrimaryBridge", BIT2, "--one-sided", "why\u202e", "--for-wallet", "--live"])).toThrow(/--one-sided's reason has a character outside printable ASCII/);
    expect(() => parseArgs(["schedule", "vault", "setPrimaryBridge", BIT2, "--one-sided", "x".repeat(201), "--for-wallet", "--live"])).toThrow(/--one-sided's reason is longer than 200 characters/);
    // execute takes it too (the fix round's ruling d), for an activation the rail check would refuse; cancel never does
    const id = `0x${"11".repeat(32)}`;
    expect(parseArgs(["execute", id, "--on", "front-door", "--one-sided", "the vault follows", "--for-wallet", "--live"])).toEqual({
      cmd: "execute",
      live: true,
      users: [],
      id,
      on: "front-door",
      oneSided: "the vault follows",
      forWallet: true,
    });
    expect(() => parseArgs(["execute", id, "--one-sided", "why‮", "--for-wallet", "--live"])).toThrow(/--one-sided's reason has a character outside printable ASCII/);
    expect(() => parseArgs(["cancel", id, "--as", "owner", "--one-sided", "why", "--for-wallet", "--live"])).toThrow(UsageError);
  });
});

describe("Task 47b's fix round: the rails judged right after a file's direct calls, execute checked, cancel warned", () => {
  const A = () => plan.addresses.baseAdapter;
  const B = () => plan.addresses.bitAdapter;
  const low = (a: string) => a.toLowerCase();
  const rail = (w: World, dir: string, contract: string, fn: string, args: string[], oneSided?: string) =>
    railScheduleCommand(ctxOf(w), record(), { ...opts(dir), contract, fn, args, ...(oneSided !== undefined ? { oneSided } : {}) });
  const fileAt = (path: string) => parseWalletFile(JSON.parse(readFileSync(path, "utf8")));
  const executeLine = (id: Hex, on: "vault" | "front-door") => `pnpm ops execute ${id} --on ${on} --for-wallet --live`;
  const residual = `  Spec section 5: "${RAIL_RESIDUAL[0]}" And: "${RAIL_RESIDUAL[1]} ${RAIL_RESIDUAL[2]}"`;

  /** Two pairs by hand: the launch pair (A on Base, B on Bittensor), the second (A2, B2), each adapter the other's peer. */
  const state = (o: { vault: [Address, Address[]]; door: [Address, Address[]]; known: Address[]; pending?: RailState["pending"]; planned?: RailState["planned"] }): RailState => ({
    heads: { vault: { block: 3_000_000, time: HEAD_TIME }, frontDoor: { block: 30_000_000, time: HEAD_TIME } },
    primary: { vault: o.vault[0], frontDoor: o.door[0] },
    sendsTo: { vault: 8_453n, frontDoor: 964n },
    peers: {
      vault: { [low(B())]: { peer: A(), chain: 8_453n }, [low(BIT2)]: { peer: BASE2, chain: 8_453n } },
      frontDoor: { [low(A())]: { peer: B(), chain: 964n }, [low(BASE2)]: { peer: BIT2, chain: 964n } },
    },
    enabled: {
      vault: { [low(B())]: o.vault[1].includes(B()), [low(BIT2)]: o.vault[1].includes(BIT2) },
      frontDoor: { [low(A())]: o.door[1].includes(A()), [low(BASE2)]: o.door[1].includes(BASE2) },
    },
    doorKnown: { [low(A())]: o.known.includes(A()), [low(BASE2)]: o.known.includes(BASE2) },
    pending: o.pending ?? [],
    planned: o.planned ?? [],
  });
  const change = (contract: SchedulerContract, fn: "activateBridge" | "disableBridge" | "setPrimaryBridge", bridge: Address, o: { by?: "owner" | "guardian"; kind?: "Ordinary" | "Reopen" } = {}) => ({
    contract,
    fn,
    bridge,
    source: "planned" as const,
    ...o,
  });
  const pendingB2 = { contract: "vault" as const, fn: "activateBridge" as const, bridge: BIT2, source: "pending" as const, id: keccak256("0x0b"), kind: "Ordinary" as const };

  it("railVerdict: the end, and each state right after the file's direct calls with no pending or planned activation counted, naming the item that would fix it", () => {
    // the review's case: the front door's A2 enabled there (its activation executed), the vault's B2 still pending; the
    // front door's switch to A2 agrees at the end, with B2 counted, but its batches go to B2 from the moment it is sent
    const s = state({ vault: [B(), [B()]], door: [A(), [BASE2]], known: [A(), BASE2], pending: [pendingB2], planned: [change("frontDoor", "setPrimaryBridge", BASE2)] });
    const v = railVerdict(s, true);
    expect(v.end.coherent).toBe(true);
    expect(v.step?.sent).toEqual([change("frontDoor", "setPrimaryBridge", BASE2)]);
    expect(v.step?.rails.incoherent).toEqual([{ from: "frontDoor", primary: BASE2, peer: BIT2, chain: 964n }]);
    expect(v.step?.fixes).toEqual([pendingB2]);
    // the activation executed: nothing in between, and nothing to fix
    expect(railVerdict(state({ vault: [B(), [B(), BIT2]], door: [A(), [BASE2]], known: [A(), BASE2], planned: [change("frontDoor", "setPrimaryBridge", BASE2)] }), true).step).toBeUndefined();
    // a file of schedules alone changes nothing at once: no state in between is judged
    expect(railVerdict(state({ vault: [B(), [B()]], door: [A(), [A()]], known: [A()], planned: [change("frontDoor", "activateBridge", BASE2), change("vault", "activateBridge", BIT2)] }), false).step).toBeUndefined();
    // both disables in the file's order, the front door's first: every state agrees
    const off = (ordered: boolean, calls: RailState["planned"]) => railVerdict(state({ vault: [B(), [B(), BIT2]], door: [A(), [A(), BASE2]], known: [A(), BASE2], planned: calls }), ordered);
    const doorFirst = [change("frontDoor", "disableBridge", A()), change("vault", "disableBridge", B())];
    expect(off(true, doorFirst).step).toBeUndefined();
    expect(off(true, doorFirst).end.coherent).toBe(true);
    // the vault's first: right after it, the front door's A sends to B, disabled
    const vaultFirst = [...doorFirst].reverse();
    expect(off(true, vaultFirst).step?.rails.incoherent).toEqual([{ from: "frontDoor", primary: A(), peer: B(), chain: 964n }]);
    expect(off(true, vaultFirst).step?.fixes).toEqual([]);
    // a file that fixes no order is judged in every order: the worst one, the vault's first, though the file lists the front door's first
    const any = off(false, doorFirst);
    expect(any.step?.sent).toEqual([change("vault", "disableBridge", B())]);
    expect(any.step?.own).toBe(false);
    expect(off(true, vaultFirst).step?.own).toBe(true);
    // both switches after both disables: the vault's first, every state agrees; the front door's first, right after it the
    // front door's batches reach a vault whose primary is still disabled (R6, claim D); in no fixed order, that is the worst
    const switches = [change("vault", "setPrimaryBridge", BIT2), change("frontDoor", "setPrimaryBridge", BASE2)];
    const on = (ordered: boolean, calls: RailState["planned"]) => railVerdict(state({ vault: [B(), [BIT2]], door: [A(), [BASE2]], known: [A(), BASE2], planned: calls }), ordered);
    expect(on(true, switches).step).toBeUndefined();
    const window = [{ from: "frontDoor", primary: BASE2, peer: BIT2, chain: 964n, noPayoutRail: B() }];
    expect(on(true, [...switches].reverse()).step?.rails.incoherent).toEqual(window);
    expect(on(true, [...switches].reverse()).step?.fixes).toEqual([]);
    expect(on(false, switches).step?.sent).toEqual([change("frontDoor", "setPrimaryBridge", BASE2)]);
    expect(on(false, switches).end.coherent).toBe(true);
  });

  it("railCoherence applies a file's calls in its own order: an activation the file schedules before it disables that side's primary dies by the stamp", () => {
    // the front door already on A2, whose batches go to B2; the vault, on B, schedules B2 and disables B
    const s = (planned: RailState["planned"]) => state({ vault: [B(), [B()]], door: [BASE2, [BASE2]], known: [A(), BASE2], planned });
    const act = change("vault", "activateBridge", BIT2);
    const off = change("vault", "disableBridge", B(), { by: "owner" });
    // the schedule first: the owner's stamp after it kills it, so B2 never runs and the front door's batches are refused
    expect(railCoherence(s([act, off])).incoherent).toEqual([{ from: "frontDoor", primary: BASE2, peer: BIT2, chain: 964n }]);
    // the disable first: the item is scheduled after the stamp and runs, so B2 takes the front door's batches; B, still the
    // vault's primary and disabled, leaves only the vault without a payout rail (R6, claim D)
    const runs = [{ from: "frontDoor", primary: BASE2, peer: BIT2, chain: 964n, noPayoutRail: B() }];
    expect(railCoherence(s([off, act])).incoherent).toEqual(runs);
    // the guardian's stamp kills an Ordinary activation, not a Reopen
    const byGuardian = change("vault", "disableBridge", B(), { by: "guardian" });
    expect(railCoherence(s([act, byGuardian])).incoherent).toEqual([{ from: "frontDoor", primary: BASE2, peer: BIT2, chain: 964n }]);
    expect(railCoherence(s([change("vault", "activateBridge", BIT2, { kind: "Reopen" }), byGuardian])).incoherent).toEqual(runs);
    // a file that fixes no order is judged at its worst: the schedule first
    expect(railVerdict(s([off, act]), false).end.coherent).toBe(false);
    expect(railVerdict(s([off, act]), true).end.incoherent).toEqual(runs);
  });

  it("a direct call is judged right after it is sent: the front door's switch while the vault's activation is still pending is refused, naming the item to execute first", async () => {
    // both halves of the new pair scheduled; the front door's executed (A2 enabled there), the vault's B2 still pending
    const w = world();
    w.rails.frontDoor.enabled.add(low(BASE2));
    w.rails.frontDoor.known.add(low(BASE2));
    const b2 = put(w, "vault", "activateBridge", [BIT2], HEAD_TIME - D);
    const dir = tempDir("rails-step");
    // the front door's disable of A, the right first step: right after it, the vault's payouts still reach A
    const off = await rail(w, dir, "front-door", "disableBridge", [A()]);
    expect(off.lines).toContain("  Right after it is sent, before any pending item runs, the two chains agree on the bridge too.");
    w.rails.frontDoor.enabled.delete(low(A()));
    // its switch to A2: the end, with B2's activation counted, agrees; but its batches go to B2 from the moment it is
    // sent, and the vault takes nothing from B2 until that item is executed
    const pair = `the front door's primary ${BASE2} sends to ${BIT2} on Bittensor, which is not enabled on the vault`;
    const fix = `Execute this pending item before this file: item ${b2.id}, activateBridge(${BIT2}) on the vault (${executeLine(b2.id, "vault")})`;
    await expect(rail(w, dir, "front-door", "setPrimaryBridge", [BASE2])).rejects.toMatchObject({
      message: `the two chains would disagree on the bridge right after setPrimaryBridge(${BASE2}) on the front door (Base) is sent, before any pending item runs: ${pair}. ${fix}; or, if this file must go first, add --one-sided "<reason>"; nothing written`,
    });
    expect(filesIn(dir)).toHaveLength(1);
    // --one-sided passes it: the warning, the residual, and the reason in the file
    const why = "B2's activation is executed within the hour";
    const one = await rail(w, dir, "front-door", "setPrimaryBridge", [BASE2], why);
    expect(fileAt(one.files[0]).oneSided).toBe(why);
    expect(one.lines).toContain(`WARNING — one-sided: right after setPrimaryBridge(${BASE2}) on the front door (Base) is sent, before any pending item runs, the two chains disagree on the bridge: ${pair}. ${fix}.`);
    expect(one.lines).toContain(residual);
    // the vault's activation executed: the same switch passes
    emit(w, "vault", "Executed", { id: b2.id }, w.heads.bittensor - 10);
    w.items.vault.delete(b2.id);
    w.rails.vault.enabled.add(low(BIT2));
    const on = await rail(w, tempDir("rails-step-done"), "front-door", "setPrimaryBridge", [BASE2]);
    expect(on.ok).toBe(true);
    expect(fileAt(on.files[0]).oneSided).toBeUndefined();
    expect(on.lines).toContain("  Right after it is sent, before any pending item runs, the two chains agree on the bridge too.");
  });

  it("pnpm ops execute of an activation is judged right after it runs: a Reopen whose other half the other side doesn't take is refused; --one-sided passes it", async () => {
    // both chains' launch halves disabled (both primaries); the owner reopens each, the front door's A and the vault's B
    const w = world();
    w.rails.frontDoor.enabled = new Set();
    w.rails.vault.enabled = new Set();
    const reopenA = put(w, "frontDoor", "activateBridge", [A()], HEAD_TIME - 8 * D, { kind: 2 });
    const reopenB = put(w, "vault", "activateBridge", [B()], HEAD_TIME - 8 * D, { kind: 2 });
    const dir = tempDir("rails-execute");
    const run = (id: Hex, oneSided?: string) => railExecuteCommand(ctxOf(w), record(), { ...opts(dir), id, ...(oneSided !== undefined ? { oneSided } : {}) });
    // A first: from the moment it runs the front door's batches go to B, which the vault takes only once B's Reopen runs
    const pair = `the front door's primary ${A()} sends to ${B()} on Bittensor, which is not enabled on the vault`;
    const fix = `Execute this pending item before this file: item ${reopenB.id}, activateBridge(${B()}) on the vault (${executeLine(reopenB.id, "vault")})`;
    await expect(run(reopenA.id)).rejects.toMatchObject({
      message: `the two chains would disagree on the bridge right after execute(activateBridge(${A()})) on the front door (Base) is sent, before any other pending item runs: ${pair}. ${fix}; or, if this file must go first, add --one-sided "<reason>"; nothing written`,
    });
    // the scheduler's own execute never writes an activation's execute without the check
    await expect(executeCommand(ctxOf(w), record(), { ...opts(dir), id: reopenA.id })).rejects.toThrow(/is written only after the rail check of both chains \(v32\/rails\.ts railExecuteCommand\); nothing written$/);
    expect(filesIn(dir)).toEqual([]);
    // B first: the vault's payouts reach A, a bridge the front door once enabled; the front door's A still sends nothing
    const b = await run(reopenB.id);
    expect(b.lines).toContain(
      `  Right after it runs, the two chains agree on the bridge: the front door's primary ${A()} is disabled, so it sends nothing; the vault's primary ${B()} sends to ${A()} on Base, which the front door has enabled.`,
    );
    expect(fileAt(b.files[0]).oneSided).toBeUndefined();
    // --one-sided is refused where the two chains agree, and on the execute of anything but an activation of a bridge
    await expect(run(reopenB.id, "why")).rejects.toThrow("--one-sided is for a file the rail check would refuse, and with this one the two chains agree on the bridge: drop it; nothing written");
    const caps = put(w, "vault", "setMaxTotalAssets", [2_000n * E18], HEAD_TIME - 3 * D);
    await expect(run(caps.id, "why")).rejects.toThrow("--one-sided goes only with the execute of an activation of a bridge; nothing written");
    // ... which goes through the same command as before, with no rails read
    w.calls.length = 0;
    const plain = await run(caps.id);
    expect(plain.lines.join("\n")).not.toMatch(/two chains/);
    expect(w.calls.some((c) => c.method === "eth_call" && c.data?.startsWith(toFunctionSelector("remoteAdapter()")))).toBe(false);
    // A first, one-sided: written with its reason, the warning and the residual
    const why = "B's Reopen is executed in the next block";
    const a = await run(reopenA.id, why);
    const file = fileAt(a.files[0]);
    expect(file.oneSided).toBe(why);
    expect(file.title).toBe(`Cascade v3.2-launch: execute activateBridge(${A()}) on the front door (Base) (one-sided)`);
    expect(a.lines).toContain(`WARNING — one-sided: right after execute(activateBridge(${A()})) on the front door (Base) is sent, before any other pending item runs, the two chains disagree on the bridge: ${pair}. ${fix}.`);
    expect(a.lines).toContain(residual);
    expect(a.lines).toContain(`  Written all the same, with your reason in the file for the sign page to show: "${why}".`);
    // a rail read that fails refuses, to try again, and is never read as agreeing
    const flaky = world();
    flaky.rails.frontDoor.enabled = new Set();
    flaky.rails.vault.enabled = new Set();
    const again = put(flaky, "vault", "activateBridge", [B()], HEAD_TIME - 8 * D, { kind: 2 });
    flaky.book[plan.addresses.doorLens.toLowerCase()].answers.bridgeKnown = new RpcError("header not found", -32000);
    const fdir = tempDir("rails-execute-unread");
    await expect(railExecuteCommand(ctxOf(flaky), record(), { ...opts(fdir), id: again.id })).rejects.toThrow(
      "Couldn't read the rails (each chain's primary and bridges, and the pending items) right now (header not found); try again; nothing written",
    );
    expect(filesIn(fdir)).toEqual([]);
  });

  it("pnpm ops cancel is never refused for the rails: it warns when the activation it drops is one a pending pair depends on", async () => {
    // both halves of the new pair pending; the guardian cancels the vault's
    const w = world();
    const b2 = put(w, "vault", "activateBridge", [BIT2], HEAD_TIME - D);
    put(w, "frontDoor", "activateBridge", [BASE2], HEAD_TIME - D);
    const dir = tempDir("rails-cancel");
    const r = await railCancelCommand(ctxOf(w), record(), { ...opts(dir), id: b2.id, as: "guardian" });
    expect(r.ok).toBe(true);
    expect(fileAt(r.files[0]).calls).toHaveLength(1);
    const after = "The cancel is written all the same: it is never refused.";
    // the half left alone is a pending item, not in any file: "nor pending there" (the T47b re-review's m3), where a
    // schedule's own refusal says "nor pending there or in this file" of the file it refuses (above)
    expect(r.lines.at(-1)).toBe(
      `WARNING — The rails depend on this activation: once the other pending items run without it, the two chains disagree on the bridge: ${BASE2} would be enabled on the front door alone: its other half, ${BIT2} on Bittensor, is not enabled on the vault, nor pending there. ${after}`,
    );
    // the same from the other side: the owner cancels the front door's half, the vault's left alone
    const mirror = world();
    put(mirror, "vault", "activateBridge", [BIT2], HEAD_TIME - D);
    const a2 = put(mirror, "frontDoor", "activateBridge", [BASE2], HEAD_TIME - D);
    const mr = await railCancelCommand(ctxOf(mirror), record(), { ...opts(dir), id: a2.id, as: "owner" });
    expect(mr.lines.at(-1)).toBe(
      `WARNING — The rails depend on this activation: once the other pending items run without it, the two chains disagree on the bridge: ${BIT2} would be enabled on the vault alone: its other half, ${BASE2} on Base, the front door has never enabled, nor is it pending there. ${after}`,
    );
    // the pair the front door's primary already uses: it moved to A2, so its batches go to B2, still pending on the vault
    const moved = world();
    moved.rails.frontDoor.enabled = new Set([low(BASE2)]);
    moved.rails.frontDoor.known.add(low(BASE2));
    moved.rails.frontDoor.primary = BASE2;
    const need = put(moved, "vault", "activateBridge", [BIT2], HEAD_TIME - D);
    const m = await railCancelCommand(ctxOf(moved), record(), { ...opts(dir), id: need.id, as: "owner" });
    expect(m.lines.at(-1)).toBe(
      `WARNING — The rails depend on this activation: once the other pending items run without it, the two chains disagree on the bridge: the front door's primary ${BASE2} sends to ${BIT2} on Bittensor, which is not enabled on the vault. ${after}`,
    );
    // a lone half, whose other half is not pending: nothing depends on it, so no warning
    const lone = world();
    const only = put(lone, "vault", "activateBridge", [BIT2], HEAD_TIME - D);
    const q = await railCancelCommand(ctxOf(lone), record(), { ...opts(dir), id: only.id, as: "guardian" });
    expect(q.ok).toBe(true);
    expect(q.lines.some((l) => l.startsWith("WARNING"))).toBe(false);
    // a cancel of anything else reads no rails
    const caps = put(lone, "vault", "setMaxTotalAssets", [2_000n * E18], HEAD_TIME - D);
    lone.calls.length = 0;
    const c = await railCancelCommand(ctxOf(lone), record(), { ...opts(dir), id: caps.id, as: "guardian" });
    expect(c.lines.some((l) => l.startsWith("WARNING"))).toBe(false);
    expect(lone.calls.some((x) => x.method === "eth_call" && x.data?.startsWith(toFunctionSelector("remoteAdapter()")))).toBe(false);
    // a rail read that fails, or a scheduler that can't be read: the cancel is still written, and the warning says so
    const flaky = world();
    const fb2 = put(flaky, "vault", "activateBridge", [BIT2], HEAD_TIME - D);
    flaky.book[plan.addresses.doorLens.toLowerCase()].answers.bridgeKnown = new RpcError("header not found", -32000);
    const fr = await railCancelCommand(ctxOf(flaky), record(), { ...opts(dir), id: fb2.id, as: "owner" });
    expect(fileAt(fr.files[0]).calls).toHaveLength(1);
    expect(fr.lines.at(-1)).toBe("WARNING — Whether the rails depend on this activation couldn't be read right now (header not found).");
    const half = world();
    const hb2 = put(half, "vault", "activateBridge", [BIT2], HEAD_TIME - D);
    half.logsFail = "base";
    const hr = await railCancelCommand(ctxOf(half), record(), { ...opts(dir), id: hb2.id, as: "owner" });
    expect(hr.files).toHaveLength(1);
    expect(hr.lines.at(-1)).toBe("WARNING — Whether the rails depend on this activation couldn't be read right now (a scheduler's pending items could not be read).");
  });

  it("pnpm ops execute refuses only a new disagreement: a partial repair goes with a warning, a break of a coherent pair is refused, a full repair goes clean", async () => {
    const dir = tempDir("rails-execute-worse");
    const run = (w: World, id: Hex, oneSided?: string) => railExecuteCommand(ctxOf(w), record(), { ...opts(dir), id, ...(oneSided !== undefined ? { oneSided } : {}) });
    const doorPair = `the front door's primary ${A()} sends to ${B()} on Bittensor, which is not enabled on the vault`;
    const vaultPair = `the vault's primary ${BIT2} sends to ${BASE2} on Base, which the front door has never enabled`;
    const still = `WARNING — Right after it runs, the two chains still disagree on the bridge, as they do now: ${vaultPair}.`;
    // both pairs disagree now: the vault moved to B2 alone (B disabled there, A2 never enabled on the front door), and
    // the front door still sends through A to B
    const split = () => {
      const w = world();
      w.rails.vault.primary = BIT2;
      w.rails.vault.enabled = new Set([low(BIT2)]);
      return w;
    };
    // a partial repair: the vault's Reopen of B takes the front door's batches again; the vault's own pair still
    // disagrees, as it does now
    const p = split();
    const reopenB = put(p, "vault", "activateBridge", [B()], HEAD_TIME - 8 * D, { kind: 2 });
    const part = await run(p, reopenB.id);
    expect(part.ok).toBe(true);
    expect(fileAt(part.files[0]).oneSided).toBeUndefined();
    expect(part.lines).toContain(still);
    expect(part.lines.join("\n")).not.toContain(doorPair);
    // ... where --one-sided has nothing to pass
    await expect(run(p, reopenB.id, "why")).rejects.toThrow("--one-sided is for an execute the rail check would refuse, and this one leaves no pair worse than it is now: drop it; nothing written");
    // a break of a pair that agrees now, though the rails already disagree elsewhere: the front door's primary A is
    // disabled (it sends nothing), and its Reopen would send to B, disabled on the vault
    const q = split();
    q.rails.frontDoor.enabled = new Set();
    const reopenA = put(q, "frontDoor", "activateBridge", [A()], HEAD_TIME - 8 * D, { kind: 2 });
    const qdir = tempDir("rails-execute-break");
    await expect(railExecuteCommand(ctxOf(q), record(), { ...opts(qdir), id: reopenA.id })).rejects.toMatchObject({
      message: `the two chains would disagree on the bridge right after execute(activateBridge(${A()})) on the front door (Base) is sent, before any other pending item runs: ${doorPair}. If this file must go first all the same, add --one-sided "<reason>"; nothing written`,
    });
    expect(filesIn(qdir)).toEqual([]);
    // --one-sided passes it, and names the pair that still disagrees too
    const why = "the vault's B is reopened next";
    const forced = await run(q, reopenA.id, why);
    expect(fileAt(forced.files[0]).oneSided).toBe(why);
    expect(forced.lines).toContain(`WARNING — one-sided: right after execute(activateBridge(${A()})) on the front door (Base) is sent, before any other pending item runs, the two chains disagree on the bridge: ${doorPair}.`);
    expect(forced.lines).toContain(still);
    // a full repair: the front door on A, the vault's B disabled; B's Reopen makes the two chains agree, with no warning
    const r = world();
    r.rails.vault.enabled = new Set();
    const fix = put(r, "vault", "activateBridge", [B()], HEAD_TIME - 8 * D, { kind: 2 });
    const full = await run(r, fix.id);
    expect(full.lines.some((l) => l.startsWith("WARNING"))).toBe(false);
    expect(full.lines).toContain(
      `  Right after it runs, the two chains agree on the bridge: the front door's primary ${A()} sends to ${B()} on Bittensor, enabled on the vault; the vault's primary ${B()} sends to ${A()} on Base, which the front door has enabled.`,
    );
  });

  it("the CLI's schedule, execute and cancel go through the rail checks and the cancel's warning (v32/commands.ts), and cli.ts runs none of them itself", async () => {
    const dir = tempDir("rails-routing");
    const cli = (w: World, argv: string[]) => schedulerFileCommand(parseArgs(argv), ctxOf(w), record(), opts(dir));
    // execute: an activation's execute that breaks a pair is refused by the rail check, and --one-sided reaches it
    const w = world();
    w.rails.frontDoor.enabled = new Set();
    w.rails.vault.enabled = new Set();
    const reopenA = put(w, "frontDoor", "activateBridge", [A()], HEAD_TIME - 8 * D, { kind: 2 });
    await expect(cli(w, ["execute", reopenA.id, "--on", "front-door", "--for-wallet", "--live"])).rejects.toThrow(/^the two chains would disagree on the bridge right after execute\(activateBridge\(/);
    const forced = await cli(w, ["execute", reopenA.id, "--one-sided", "the vault follows", "--for-wallet", "--live"]);
    expect(forced.lines).toContain(`  Written all the same, with your reason in the file for the sign page to show: "the vault follows".`);
    // cancel: one half of a pending pair, warned
    const c = world();
    const b2 = put(c, "vault", "activateBridge", [BIT2], HEAD_TIME - D);
    put(c, "frontDoor", "activateBridge", [BASE2], HEAD_TIME - D);
    const r = await cli(c, ["cancel", b2.id, "--as", "guardian", "--for-wallet", "--live"]);
    expect(r.lines.at(-1)).toMatch(/^WARNING — The rails depend on this activation: /);
    // schedule: a change to the bridges goes through the rail check; any other change through Task 47's
    await expect(cli(world(), ["schedule", "vault", "disableBridge", B(), "--for-wallet", "--live"])).rejects.toThrow(/^the two chains would disagree on the bridge once this file and the pending items run/);
    expect((await cli(world(), ["schedule", "vault", "setPayoutDelay", "43200", "--for-wallet", "--live"])).ok).toBe(true);
    // cli.ts hands each of these commands to schedulerFileCommand, and calls none of them itself
    const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(src).toMatch(/await schedulerFileCommand\(a, /);
    for (const fn of ["scheduleCommand", "pendingCommand", "executeCommand", "cancelCommand", "cancelPayoutsCommand", "railScheduleCommand", "railExecuteCommand", "railCancelCommand"]) {
      expect(src, fn).not.toMatch(new RegExp(`\\b${fn}\\(`));
    }
  });
});

describe("Task 53's fix round (the review's Important 3): pnpm ops schedule warns when a signed stamp stack reaches the item's schedule time", () => {
  const stack = (dir: string, chain: ChainName, contract: string, stamps: { asOf: number; sig: boolean; relayed?: boolean; covered?: boolean }[], deployment = "v3.2-launch") => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${chain}.json`),
      JSON.stringify({
        version: 1,
        deployment,
        target: "live",
        chain,
        chainId: chain === "bittensor" ? 964 : 8453,
        contract,
        stamps: stamps.map((x) => ({ asOf: String(x.asOf), digest: `0x${"11".repeat(32)}`, sig: x.sig ? `0x${"22".repeat(65)}` : null, ...(x.relayed ? { relayed: { hash: `0x${"33".repeat(32)}`, block: 1 } } : {}), ...(x.covered ? { coveredBy: `0x${"44".repeat(32)}` } : {}) })),
      }),
    );
  };
  const run = (stampsDir: string) => scheduleCommand(ctxOf(world()), record(), { ...opts(tempDir("schedule-stack-files")), stampsDir, contract: "vault", fn: "setMaxTotalAssets", args: ["2000000000000000000000"] });

  it("a signed stamp not relayed yet, as of the schedule time or later, would kill the item: warned before the file is written, with the stack's last asOf", async () => {
    const dir = tempDir("stamps-reach");
    stack(dir, "bittensor", plan.addresses.vault, [
      { asOf: HEAD_TIME - 3_600, sig: true, relayed: true },
      { asOf: HEAD_TIME + 12 * 3_600, sig: true },
      { asOf: HEAD_TIME + 24 * 3_600, sig: true },
      { asOf: HEAD_TIME + 36 * 3_600, sig: false },
    ]);
    const r = await run(dir);
    expect(r.ok).toBe(true);
    const last = new Date((HEAD_TIME + 24 * 3_600) * 1000).toISOString().slice(0, 16).replace("T", " ");
    expect(r.lines).toContainEqual(
      `  WARNING: the vault (Bittensor)'s signed stamp stack (${join(dir, "bittensor.json")}) holds 2 stamps as of this item's scheduling or later, the last as of ${last} UTC: the bot's relay of the first kills this item. Schedule it after the stack's last asOf, or sign no stack reaching past its schedule time until it has executed.`,
    );
    expect(r.files).toHaveLength(1);
  });

  it("the rail path's activations warn too: schedule both activateBridge, a reaching stack on each chain (Task 53's re-review, Minor 1)", async () => {
    const dir = tempDir("stamps-rail");
    stack(dir, "bittensor", plan.addresses.vault, [{ asOf: HEAD_TIME + 12 * 3_600, sig: true }]);
    stack(dir, "base", plan.addresses.frontDoor, [{ asOf: HEAD_TIME + 12 * 3_600, sig: true }]);
    const r = await railScheduleCommand(ctxOf(world()), record(), { ...opts(tempDir("stamps-rail-files")), stampsDir: dir, contract: "both", fn: "activateBridge", args: [BIT2, BASE2] });
    expect(r.ok).toBe(true);
    const warned = r.lines.filter((l) => l.startsWith("  WARNING: ") && l.includes("signed stamp stack"));
    expect(warned).toHaveLength(2);
    expect(warned[0]).toContain(`the front door (Base)'s signed stamp stack (${join(dir, "base.json")}) holds 1 stamp as of this item's scheduling or later`);
    expect(warned[1]).toContain(`the vault (Bittensor)'s signed stamp stack (${join(dir, "bittensor.json")}) holds 1 stamp as of this item's scheduling or later`);
  });

  it("a stamp relayed already, or covered by a later one relayed, has moved the clock: it is not warned of, even as of the head itself", async () => {
    const dir = tempDir("stamps-relayed");
    stack(dir, "bittensor", plan.addresses.vault, [
      { asOf: HEAD_TIME, sig: true, covered: true },
      { asOf: HEAD_TIME, sig: true, relayed: true },
    ]);
    expect((await run(dir)).lines.filter((l) => /stamp stack/.test(l))).toEqual([]);
  });

  it("a stack whose signed stamps all lie before the schedule time, or are relayed: no warning; no stack ops can read: check it by hand", async () => {
    const dir = tempDir("stamps-before");
    stack(dir, "bittensor", plan.addresses.vault, [{ asOf: HEAD_TIME - 7_200, sig: true }, { asOf: HEAD_TIME + 3_600, sig: false }]);
    const before = await run(dir);
    expect(before.lines.filter((l) => /stamp stack/.test(l))).toEqual([]);
    const empty = tempDir("stamps-none");
    const none = await run(empty);
    expect(none.lines).toContainEqual(
      `  No signed stamp stack for the vault (Bittensor) is on this PC (${join(empty, "bittensor.json")}): if the relayer's stack is kept elsewhere, check by hand that its last signed asOf is before now; a stamp relayed as of this item's scheduling or later kills it.`,
    );
    // another deployment's stack is not this one's: by hand too
    const other = tempDir("stamps-other");
    stack(other, "bittensor", plan.addresses.vault, [{ asOf: HEAD_TIME + 12 * 3_600, sig: true }], "v3-test");
    expect((await run(other)).lines.some((l) => l.startsWith("  No signed stamp stack for the vault (Bittensor) is on this PC"))).toBe(true);
  });
});

describe("R4: the vault-side disable warns of parks (D-L1, C-L3), and the rail checks hold a new pair to the deploy's lane settings (C-L4)", () => {
  const A = () => plan.addresses.baseAdapter;
  const B = () => plan.addresses.bitAdapter;
  const low = (a: string) => a.toLowerCase();
  const activated = () => {
    const w = world();
    w.rails.vault.enabled.add(low(BIT2));
    w.rails.frontDoor.enabled.add(low(BASE2));
    w.rails.frontDoor.known.add(low(BASE2));
    return w;
  };
  const rail = (w: World, dir: string, contract: string, fn: string, args: string[]) => railScheduleCommand(ctxOf(w), record(), { ...opts(dir), contract, fn, args });

  it("pnpm ops schedule vault disableBridge warns while the Bittensor adapter holds parks, and says nothing of them when it holds none", async () => {
    const w = activated();
    const dir = tempDir("r4-disable-parks");
    w.rails.frontDoor.enabled.delete(low(A()));
    const none = await rail(w, dir, "vault", "disableBridge", [B()]);
    expect(none.ok).toBe(true);
    expect(none.lines.some((l) => l.includes("holds parks"))).toBe(false);
    w.book[low(B())].answers.parkedNative = E18 / 2n;
    w.book[low(B())].answers.parkedTokens = E18 / 4n;
    const held = await rail(w, dir, "vault", "disableBridge", [B()]);
    expect(held.ok).toBe(true);
    expect(held.lines).toContain(
      `  WARNING — the Bittensor adapter ${B()} still holds parks (0.5 TAO as TAO, 0.25 TAO as tokens). Once the vault disables it, they can't be delivered, only refunded to Base after 14 days. Wait until it holds none (pnpm ops park --live).`,
    );
    // token parks alone are parks too
    w.book[low(B())].answers.parkedNative = 0n;
    const tokens = await rail(w, dir, "vault", "disableBridge", [B()]);
    expect(tokens.lines.some((l) => l.startsWith(`  WARNING — the Bittensor adapter ${B()} still holds parks (0 TAO as TAO, 0.25 TAO as tokens).`))).toBe(true);
    // unread: said, never taken as none
    w.book[low(B())].answers.parkedNative = revert("InvalidParameter");
    const unread = await rail(w, dir, "vault", "disableBridge", [B()]);
    expect(unread.lines.some((l) => l.startsWith(`  WARNING — the Bittensor adapter ${B()}'s parks couldn't be read (`) && l.endsWith("): check it holds none (pnpm ops park --live) before you sign."))).toBe(true);
    // the front door's disable names no park (its adapter holds none)
    const door = await rail(activated(), dir, "front-door", "disableBridge", [A()]);
    expect(door.lines.some((l) => l.includes("holds parks") || l.includes("parks couldn't be read"))).toBe(false);
  });

  for (const [field, chain, value] of [
    ["remoteSelector", "base", 99n],
    ["router", "base", getAddress(`0x${"d9".repeat(20)}`)],
    ["token", "bittensor", getAddress(`0x${"d8".repeat(20)}`)],
    ["alphaVault", "bittensor", getAddress(`0x${"d7".repeat(20)}`)],
  ] as const) {
    it(`a new pair whose ${chain === "base" ? "Base" : "Bittensor"} half has another ${field}() is refused, named: the rails read more than its peers`, async () => {
      const w = world();
      w.book[low(chain === "base" ? BASE2 : BIT2)].answers[field] = value;
      const dir = tempDir(`r4-fields-${field}`);
      const e = await rail(w, dir, "both", "activateBridge", [BIT2, BASE2]).catch((x: Error) => x);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain(`its ${field}() is ${String(value)}, not `);
      expect(filesIn(dir)).toEqual([]);
    });
  }

  it("a live primary pair whose Base half has another remoteSelector is incoherent now (as verify reads the rails), named, and the residual's halves aren't added: it is fixed at deploy", async () => {
    const w = activated();
    w.rails.frontDoor.primary = BASE2;
    w.rails.vault.primary = BIT2;
    w.rails.frontDoor.known.add(low(BASE2));
    w.book[low(BASE2)].answers.remoteSelector = 99n;
    const r = railCoherence(await readRails(ctxOf(w), record(), { buildsDir, pending: { vault: [], frontDoor: [] } }));
    expect(r.coherent).toBe(false);
    expect(r.incoherent.map((p) => [p.from, p.primary, p.config])).toEqual([
      ["frontDoor", BASE2, [`${BASE2} on Base: its remoteSelector() is 99, not ${LANE.base.remoteSelector} as the deploy's adapter's on Base`]],
      ["vault", BIT2, [`${BASE2} on Base: its remoteSelector() is 99, not ${LANE.base.remoteSelector} as the deploy's adapter's on Base`]],
    ]);
  });

  describe("R4-O round 2: a replacement pair naming ForeverMoney's new AlphaVault, the deploy's AlphaVault's announced migration target", () => {
    const NEW_AV = getAddress(`0x${"e1".repeat(20)}`);
    const OTHER_AV = getAddress(`0x${"e2".repeat(20)}`);
    const migrating = (w: World, bitAlphaVault: string) => {
      w.book[low(LANE.bittensor.alphaVault)].answers.migrationTarget = NEW_AV;
      w.book[low(BIT2)].answers.alphaVault = bitAlphaVault;
      return w;
    };

    it("schedule both activateBridge writes its file with no --one-sided", async () => {
      const dir = tempDir("r4o2-schedule");
      const r = await rail(migrating(world(), NEW_AV), dir, "both", "activateBridge", [BIT2, BASE2]);
      expect(r.ok).toBe(true);
      expect(filesIn(dir)).toHaveLength(1);
    });

    it("verify's rail check passes once it is the primary pair: the two chains agree", async () => {
      const w = migrating(activated(), NEW_AV);
      w.rails.frontDoor.primary = BASE2;
      w.rails.vault.primary = BIT2;
      const f = railsFindings(await readRails(ctxOf(w), record(), { buildsDir, pending: { vault: [], frontDoor: [] } }));
      expect(f.failures).toEqual([]);
      expect(f.info.join(" ")).toContain("The rails: now, the two chains agree on the bridge");
    });

    it("R4-O round 3: the live target cleared after add-pair recorded it: the schedule and verify still accept the pair, the target read again at the recorded block; a record the target never matched is refused", async () => {
      const AT = 2_900_000;
      const recorded = (block: number) => ({
        ...record(),
        pairs: [{ bitAdapter: BIT2, baseAdapter: BASE2, blocks: { base: 1, bittensor: 1 }, addedAt: "", alphaTarget: { vault: LANE.bittensor.alphaVault, target: NEW_AV, block } }],
      });
      const cleared = (w: World) => {
        w.book[low(LANE.bittensor.alphaVault)].answers.migrationTarget = (_a: readonly unknown[], _f?: string, tag?: unknown) => (tag === numberToHex(AT) ? NEW_AV : `0x${"00".repeat(20)}`);
        // finishMigration cleared it (R4-O round 4: a cleared target counts only once the migration finished)
        w.book[low(LANE.bittensor.alphaVault)].answers.migrationFinished = true;
        w.book[low(BIT2)].answers.alphaVault = NEW_AV;
        return w;
      };
      const dir = tempDir("r4o3-schedule");
      const r = await railScheduleCommand(ctxOf(cleared(world())), recorded(AT), { ...opts(dir), contract: "both", fn: "activateBridge", args: [BIT2, BASE2] });
      expect(r.ok).toBe(true);
      expect(filesIn(dir)).toHaveLength(1);
      const w = cleared(activated());
      w.rails.frontDoor.primary = BASE2;
      w.rails.vault.primary = BIT2;
      const f = railsFindings(await readRails(ctxOf(w), recorded(AT), { buildsDir, pending: { vault: [], frontDoor: [] } }));
      expect(f.failures).toEqual([]);
      // a record the target never matched at its block: refused by both
      const dir2 = tempDir("r4o3-forged");
      const e = await railScheduleCommand(ctxOf(cleared(world())), recorded(AT + 1), { ...opts(dir2), contract: "both", fn: "activateBridge", args: [BIT2, BASE2] }).catch((x: Error) => x);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain(`the address recorded for it at block ${AT + 1} was not its migration target then`);
      expect(filesIn(dir2)).toEqual([]);
      const g = railsFindings(await readRails(ctxOf(w), recorded(AT + 1), { buildsDir, pending: { vault: [], frontDoor: [] } }));
      expect(g.failures.join(" ")).toContain(`its alphaVault() is ${NEW_AV}`);
    });

    it("a pair naming any other AlphaVault is still refused, by the schedule and by verify, the target named", async () => {
      const dir = tempDir("r4o2-other");
      const e = await rail(migrating(world(), OTHER_AV), dir, "both", "activateBridge", [BIT2, BASE2]).catch((x: Error) => x);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain(`its alphaVault() is ${OTHER_AV}, not ${LANE.bittensor.alphaVault} as the deploy's adapter's on Bittensor, nor the announced migration target of ${LANE.bittensor.alphaVault} (${NEW_AV})`);
      expect(filesIn(dir)).toEqual([]);
      const w = migrating(activated(), OTHER_AV);
      w.rails.frontDoor.primary = BASE2;
      w.rails.vault.primary = BIT2;
      const f = railsFindings(await readRails(ctxOf(w), record(), { buildsDir, pending: { vault: [], frontDoor: [] } }));
      expect(f.failures.join(" ")).toContain(`its alphaVault() is ${OTHER_AV}`);
    });
  });

  it("readRails reads each bridge's lane settings at the pinned head: none for the deploy's pair, each field that differs for a new one", async () => {
    const w = world();
    w.book[low(BASE2)].answers.remoteSelector = 99n;
    const s = await readRails(ctxOf(w), record(), { buildsDir, planned: [{ contract: "frontDoor", fn: "activateBridge", bridge: BASE2, source: "planned" }] });
    expect(s.config?.frontDoor[low(A())]).toEqual([]);
    expect(s.config?.frontDoor[low(BASE2)]).toEqual([`its remoteSelector() is 99, not ${LANE.base.remoteSelector} as the deploy's adapter's on Base`]);
    // the default pair alone: every value as the deploy's
    const ok = await rail(world(), tempDir("r4-fields-ok"), "both", "activateBridge", [BIT2, BASE2]).catch((x: Error) => x);
    expect(ok).not.toBeInstanceOf(Error);
  });
});
