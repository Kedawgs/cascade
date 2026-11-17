import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  hashDomain,
  hexToNumber,
  keccak256,
  numberToHex,
  parseAbi,
  stringToBytes,
  toFunctionSelector,
} from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { POOL_ABI } from "../src/cardinality.ts";
import { BASE_V3, type ChainName, LIVE, PRECOMPILE, paths, targets } from "../src/config.ts";
import { parseArgs, UsageError } from "../src/args.ts";
import { loadRecord, saveRecord } from "../src/record.ts";
import { type Rpc, RpcError } from "../src/rpc.ts";
import { encodeSs58 } from "../src/ss58.ts";
import { type BuildRefV32, type BuildV32, buildErrorsV32, freezeBuildV32, type SourceV32, writeBuildV32 } from "../src/v32/build.ts";
import { domainSeparatorV32, expectedRuntimeV32 } from "../src/v32/code.ts";
import type { DeploymentRecordV32 } from "../src/v32/deploy.ts";
import { addressMapping, type PlannedStepV32, type PlanV32, type V32StepId } from "../src/v32/plan.ts";
import { RAIL_RESIDUAL, type RailPair, type RailState, railsFindings, residualFor } from "../src/v32/rails.ts";
import { batchLimitsFileCommand, capsFileCommand, claimGasFileCommand, disableBridgeFileCommand, fundCushionFileCommand, fundReserveFileCommand, hotkeyFileCommand, idleBufferFileCommand, pauseFileCommand, redeemOriginFileCommand, setKeeperFileCommand } from "../src/v32/hotkey-files.ts";
import { removeDoorCommand, retirePairCommand } from "../src/v32/retire.ts";
import { ALPHA_READ_GAS, BOUNDS_V32, capsWarning, FUNDING_V32, SETTINGS_V32_LAUNCH, WRITE_OFF_READ_GAS } from "../src/v32/settings.ts";
import { delegatesKey, STORAGE_QUERY, totalHotkeyAlphaKey, uidsKey } from "../src/v32/validators.ts";
import { SYSTEM_NUMBER_KEY } from "../src/keeper/core/abi.ts";
import { deferredCashKey } from "../src/keeper/core/v32/deferred.ts";
import { KNOWN_ABI, parseWalletFile } from "../src/wallet.ts";
import {
  DIRECT_ORIGIN,
  DOOR_SETTINGS,
  probeAddress,
  SCHEDULED_V32,
  MS_PER_BLOCK_PINS,
  STAMP_TYPEHASH_V32,
  UNKNOWN_PROBES,
  VAULT_LIMITS,
  verifyV32,
  verifyV32AndSave,
} from "../src/v32/verify.ts";
import { tempDir } from "./v32-chains.ts";
import { le, planV32, TAO_BOT, YUMA } from "./v32-fixtures.ts";

// Task 46a: `pnpm ops verify` on a v3.2 record (spec §7 step 3). The code read-backs (Task 45) and every state
// read-back, through the lenses where the getter moved, on fake chains that answer each contract with the frozen
// build's own ABI: an honest deployment passes, and each wrong value is one failure naming the chain, the contract, the
// read, what was expected and what was found. Nothing is sent, and no key, network or forge is used.

const CONTRACTS = paths({}).contractsDir;
const SOURCE: SourceV32 = { commit: "c0ffee".padEnd(40, "0"), tree: "7ee".padEnd(40, "0"), dirty: [] };
const T = targets({}).rehearsal;
const LIVE_T = targets({}).live;
const IDS: Record<ChainName, number> = { base: T.base.chainId, bittensor: T.bittensor.chainId };
const CREATED_BLOCK = 4_000;
const CREATED_AT = 1_800_000_000;
const HEAD_AT = CREATED_AT + 3_600;
/** Each chain's head: an hour after the vault's create on Bittensor (12-second blocks), and on Base (2-second blocks)
 * an hour after block 1, where the record puts every other create. */
const HEADS: Record<ChainName, number> = { bittensor: CREATED_BLOCK + 300, base: 1 + 1_800 };
const SPB: Record<ChainName, number> = { bittensor: 12, base: 2 };
/** Block `n`'s time on `chain`. */
const timeOf = (chain: ChainName, n: number) => HEAD_AT - SPB[chain] * (HEADS[chain] - n);
const blockAt = (chain: ChainName, t: number) => HEADS[chain] - Math.ceil((HEAD_AT - t) / SPB[chain]);
const E18 = 10n ** 18n;
const H = 3_600;
const D = 86_400;
const DELAYS = [48 * H, 7 * D, 8 * D] as const; // Param, Registry, Guardian
const WINDOW = 7 * D;
const other = getAddress(`0x${"5e".repeat(20)}`);
const another = getAddress(`0x${"6f".repeat(20)}`);
const otherWord = keccak256(stringToBytes("another hotkey"));
/** The bridged token the Bittensor adapter converts (its token()): a stand-in address on the fake chain. */
const BIT_TOKEN = getAddress(`0x${"7a".repeat(20)}`);
/** Each chain's lane settings every Cascade adapter there shares (R4, C-L4: the rail checks hold a new pair's to the
 * deploy's): its router, token and remote selector, and on Bittensor its AlphaVault */
const LANE_BIT = { router: getAddress(`0x${"c1".repeat(20)}`), remoteSelector: 15_971_525_489_660_198_786n, alphaVault: getAddress(`0x${"c3".repeat(20)}`) };
const LANE_BASE = { router: getAddress(`0x${"c4".repeat(20)}`), token: getAddress(`0x${"c5".repeat(20)}`), remoteSelector: 2_135_107_236_357_186_872n };

let build: BuildV32;
let plan: PlanV32;
let honestCode: Record<V32StepId, Hex>;
let buildsDir: string;
let ref: BuildRefV32;

beforeAll(async () => {
  build = (await freezeBuildV32(CONTRACTS, SOURCE)).build;
  plan = planV32();
  honestCode = codesOf(plan);
  buildsDir = tempDir("verify-builds");
  const text = `${JSON.stringify(build, null, 2)}\n`;
  ref = writeBuildV32(buildsDir, { text, hash: keccak256(stringToBytes(text)) });
});

const codesOf = (p: PlanV32) => Object.fromEntries(p.steps.map((s) => [s.id, expectedRuntimeV32(build, p, s.id, IDS)])) as Record<V32StepId, Hex>;
const step = (p: PlanV32, id: V32StepId): PlannedStepV32 => p.steps.find((s) => s.id === id)!;
const abiOf = (name: string): Abi => build.contracts[name].abi;

/** The record of an honest deployment of `p`: every create done, the vault's in CREATED_BLOCK. */
function record(p: PlanV32 = plan): DeploymentRecordV32 {
  const done = Object.fromEntries(p.steps.map((s) => [s.id, { hash: `0x${"ab".repeat(32)}` as Hex, block: s.id === "vault" ? CREATED_BLOCK : 1, gasUsed: 1n, costWei: 1n, address: p.addresses[s.id] }]));
  return { target: "rehearsal", createdAt: "2026-11-07T00:00:00.000Z", plan: p, build: ref, done };
}

// ---- the fake chains ----

/** What a contract answers: a value (or an Error, thrown), or a function of the call's arguments and sender. */
type Answer = unknown;
type Book = Record<ChainName, Record<string, { abi: Abi; answers: Record<string, Answer> }>>;

interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  logIndex: Hex;
  transactionHash: Hex;
}

/** A scheduled item as the lens reads it (scheduled(id)). */
interface Item {
  scheduledAt: bigint;
  readyAt: bigint;
  class: number;
  kind: number;
  selector: Hex;
  readyBlock: bigint;
}
const EMPTY_ITEM: Item = { scheduledAt: 0n, readyAt: 0n, class: 0, kind: 0, selector: "0x00000000", readyBlock: 0n };

/** A payout batch as the vault lens reads it (getPayoutBatch). */
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
const EMPTY_BATCH: Batch = { sourceChain: 0n, frontDoor: `0x${"00".repeat(20)}`, batchId: 0n, queuedAt: 0n, cursor: 0, count: 0, chunk: 0, remaining: 0n, payoutsHash: `0x${"00".repeat(32)}` };

/** A park as the Bittensor adapter reads it (parked(key)): amount, parkedAt, converted. */
type Park = [bigint, bigint, boolean];

interface World {
  book: Book;
  storage: Record<string, Hex | Error>;
  codes: Record<ChainName, Record<string, Hex>>;
  balances: Record<ChainName, Record<string, bigint>>;
  chainIds: Record<ChainName, number>;
  /** each contract's logs, by chain */
  logs: Record<ChainName, RawLog[]>;
  /** eth_getLogs on this chain fails (the node's own error) */
  logsFail?: ChainName;
  /** a node that prunes: it answers eth_getLogs with nothing before this block (a lite node's minutes of history) */
  prunedBefore?: Partial<Record<ChainName, number>>;
  /** the scheduled items each scheduler's lens holds, by id */
  items: Record<"vault" | "frontDoor", Map<string, Item>>;
  /** the vault's payout batches, by key */
  batches: Map<string, Batch>;
  /** the Bittensor adapter's parks, by key */
  parks: Map<string, Park>;
  /** R11: what eth_estimateGas answers for the write-off's read (getTotalColdkeyStakeOnSubnet), or its error */
  estimate: bigint | Error;
}

/** An eth_call's raw answer, given back as it is (not encoded by the function's ABI). */
class RawAnswer {
  readonly data: Hex;
  constructor(data: Hex) {
    this.data = data;
  }
}

const STAKING = parseAbi(["function getRejectStakingHotkeyGrowth(bytes32 coldkey) view returns (bool)"]);
/** R11: ForeverMoney's AlphaVault, the three getters the Bittensor adapter's canSendPayouts() reads */
const ALPHA = parseAbi(["function isPaused() view returns (bool)", "function migrationReadyAt() view returns (uint256)", "function migrationFinished() view returns (bool)"]);
const TOTAL_COLDKEY = parseAbi(["function getTotalColdkeyStakeOnSubnet(bytes32 coldkey, uint256 netuid) view returns (uint256)"]);
/** What a call takes before its code runs: 21,000, and 4 gas a zero byte of its calldata, 16 any other (written here
 * from the yellow paper's rule, not from verify.ts). */
const intrinsic = (data: Hex): bigint => {
  let g = 21_000n;
  for (let i = 2; i < data.length; i += 2) g += data.slice(i, i + 2) === "00" ? 4n : 16n;
  return g;
};
/** The write-off read's own gas in the honest world (the indexer's fixture's live figure) */
const READ_GAS = 16_875n;
const ERC20 = parseAbi(["function balanceOf(address account) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)"]);
const POOL = [...POOL_ABI, ...parseAbi(["function fee() view returns (uint24)"])] as Abi;
const OWNER_CONTRACT = parseAbi([
  "function getMinDelay() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
]);
const revert = (name: string, args: unknown[] = []) => new RpcError("execution reverted", 3, encodeErrorResult({ abi: buildErrorsV32(build), errorName: name, args } as never));
const sameText = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

/** What each scheduler contract's _classify accepts, and at how many words, written here from the contracts' source
 * (CascadeVault.sol's, CascadeFrontDoor.sol's and CascadeBase.sol's _classify), not from verify.ts's table. */
const CLASSIFY: Record<"vault" | "frontDoor", Record<string, number>> = {
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

/** A scheduler's `schedule`, as its contract decides: only from the owner; UnknownSelector for a selector it does not
 * classify, BadCalldata off its canonical length, AlreadyActive for an activation of the live door or bridge (so a
 * probe of either fails: ruling B19), InvalidParameter for a guardian that is the owner or an owner that is the
 * guardian; else the id. */
function scheduler(p: PlanV32, which: "vault" | "frontDoor", table: Record<string, number> = CLASSIFY[which]) {
  const abi = which === "vault" ? build.vaultAbi : abiOf("CascadeFrontDoor");
  return (args: readonly unknown[], from?: string) => {
    if (!sameText(from, p.roles.owner)) return revert("OwnableUnauthorizedAccount", [from ?? other]);
    const data = args[0] as Hex;
    const fn = Object.keys(table).find((f) => toFunctionSelector(abi.find((x): x is AbiFunction => x.type === "function" && x.name === f)!) === data.slice(0, 10));
    if (!fn) return revert("UnknownSelector");
    if ((data.length - 10) / 64 !== table[fn]) return revert("BadCalldata");
    const inner = decodeFunctionData({ abi, data }).args ?? [];
    const live = which === "vault" ? p.addresses.bitAdapter : p.addresses.baseAdapter;
    if (fn === "activateFrontDoor" && sameText(inner[1], p.addresses.frontDoor)) return revert("AlreadyActive");
    if (fn === "activateBridge" && sameText(inner[0], live)) return revert("AlreadyActive");
    if (fn === "setGuardian" && sameText(inner[0], p.roles.owner)) return revert("InvalidParameter");
    if (fn === "transferOwnership" && sameText(inner[0], p.roles.guardian)) return revert("InvalidParameter");
    return keccak256(data);
  };
}

/** An honest v3.2 deployment of `p` on the forks, every contract as its constructor left it. */
function world(p: PlanV32 = plan, codes: Record<V32StepId, Hex> = honestCode): World {
  const a = p.addresses;
  const r = p.roles;
  const vp = step(p, "vault").args[0] as Record<string, unknown>;
  const dp = step(p, "frontDoor").args[0] as Record<string, unknown>;
  const sp = step(p, "staker").args[0] as { swapFeeBps: number; depositFeeUsdc: bigint; deliveryRouteId: number; route0: { kind: number; router: Address; buyPath: Hex; sellPath: Hex; active: boolean } };
  const launchDoor = keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }], [8_453n, a.frontDoor]));
  const lower = (m: Record<string, { abi: Abi; answers: Record<string, Answer> }>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k.toLowerCase(), v]));
  const items: World["items"] = { vault: new Map(), frontDoor: new Map() };
  const batches = new Map<string, Batch>();
  const parks = new Map<string, Park>();
  /** what the owner or the guardian may call: anyone else reverts NotGuardian, as CascadeBase's _actor */
  const ownerOrGuardian = (from?: string) => (sameText(from, r.owner) || sameText(from, r.guardian) ? undefined : revert("NotGuardian"));
  // the scheduler's reads, on each lens: its delays, window and clocks, and its items
  const schedulerReads = (c: "vault" | "frontDoor"): Record<string, Answer> => ({
    PARAM_DELAY: BigInt(DELAYS[0]),
    REGISTRY_DELAY: BigInt(DELAYS[1]),
    GUARDIAN_DELAY: BigInt(DELAYS[2]),
    EXECUTE_WINDOW: BigInt(WINDOW),
    MS_PER_BLOCK: c === "vault" ? 7_200n : 120n,
    lastOwnerClose: 0n,
    lastGuardianClose: 0n,
    primaryDisabledBy: 0,
    scheduled: (args: readonly unknown[]) => items[c].get(String(args[0]).toLowerCase()) ?? EMPTY_ITEM,
  });
  const book: Book = {
    bittensor: lower({
      [a.vault]: {
        abi: build.vaultAbi,
        answers: {
          owner: r.owner,
          launchChain: 8_453n,
          MS_PER_BLOCK: 7_200n,
          schedule: scheduler(p, "vault"),
          // the instruments the retirement files call, as the vault decides
          removeFrontDoor: (args: readonly unknown[], from?: string) =>
            ownerOrGuardian(from) ?? (sameText(keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }], [args[0] as bigint, args[1] as Address])), launchDoor) ? undefined : revert("PeerNotActive")),
          disableBridge: (args: readonly unknown[], from?: string) => ownerOrGuardian(from) ?? (sameText(args[0], a.bitAdapter) ? undefined : revert("BridgeNotEnabled")),
        },
      },
      [a.vaultLens]: {
        abi: abiOf("CascadeVaultLens"),
        answers: {
          guardian: r.guardian,
          keeper: r.keeper,
          treasury: r.treasury,
          hotkeys: (args: readonly unknown[]) => (args[0] === 0n ? p.validators.primary : revert("InvalidParameter")),
          stakeHotkey: p.validators.primary,
          doorState: (args: readonly unknown[]) => (sameText(args[0], launchDoor) ? 1 : 0),
          activeDoors: (args: readonly unknown[]) => (args[0] === 8_453n ? 1n : 0n),
          primaryBridge: a.bitAdapter,
          bridgeEnabled: (args: readonly unknown[]) => sameText(args[0], a.bitAdapter),
          lastStakeAt: BigInt(CREATED_AT),
          exitsOpen: true,
          stakeMissing: false,
          bookedStake: 0n,
          redeemOrigin: (args: readonly unknown[]) => (sameText(args[0], r.treasury) ? DIRECT_ORIGIN : 0n),
          DOMAIN_SEPARATOR: domainSeparatorV32(IDS.bittensor, a.vault),
          STAMP_TYPEHASH: STAMP_TYPEHASH_V32,
          // the vault's constant, served by its lens (Task 65): the keeper's own payout gas rule
          EXIT_GAS_RESERVE: 2_000_000n,
          ...Object.fromEntries(VAULT_LIMITS.map((n) => [n, vp[n]])),
          // the exits machine's holds and the scheduler (Task 46b's reports)
          ...schedulerReads("vault"),
          pausedBy: 0,
          launchDoorRemovedBy: 0,
          // the payout queue: each batch, and what they still hold together (Ledger.pending)
          getPayoutBatch: (args: readonly unknown[]) => batches.get(String(args[0]).toLowerCase()) ?? EMPTY_BATCH,
          pendingPayouts: () => [...batches.values()].reduce((s, b) => s + b.remaining, 0n),
        },
      },
      [PRECOMPILE.staking]: {
        abi: [...STAKING, ...TOTAL_COLDKEY],
        // R12d: the write-off read answers one word (the coldkey's total on root)
        answers: { getRejectStakingHotkeyGrowth: (args: readonly unknown[]) => sameText(args[0], p.vaultColdkey), getTotalColdkeyStakeOnSubnet: 50_000_000_000n },
      },
      [a.bitAdapter]: {
        abi: abiOf("CcipBittensorAdapter"),
        answers: {
          treasury: r.treasury,
          maxMessageValue: (step(p, "bitAdapter").args[0] as { maxMessageValue: bigint }).maxMessageValue,
          // the lane's inbound gas model, the Base adapter's own pair (R4)
          inboundGasBase: step(p, "bitAdapter").args[2],
          inboundGasPerEntry: step(p, "bitAdapter").args[3],
          remoteChainId: 8_453n,
          remoteAdapter: a.baseAdapter,
          token: BIT_TOKEN,
          ...LANE_BIT,
          // what the parks owe, as the adapter keeps it: the sums over its records
          parkedNative: () => [...parks.values()].filter((k) => k[2]).reduce((s, k) => s + k[0], 0n),
          parkedTokens: () => [...parks.values()].filter((k) => !k[2]).reduce((s, k) => s + k[0], 0n),
          parked: (args: readonly unknown[]) => parks.get(String(args[0]).toLowerCase()) ?? [0n, 0n, false],
          // R4 (F-1): the token cushion as the adapter books it, funded with fundCushion: exactly its target
          tokenCushion: 10n ** 15n,
          // R11: the payouts view the vault reads, open
          canSendPayouts: true,
        },
      },
      // R11: ForeverMoney's AlphaVault as the adapter reads it: open, no migration
      [LANE_BIT.alphaVault]: { abi: ALPHA, answers: { isPaused: false, migrationReadyAt: 0n, migrationFinished: false } },
      // the adapter's token balance: exactly its booked cushion, as funded
      [BIT_TOKEN]: { abi: ERC20, answers: { balanceOf: (args: readonly unknown[]) => (sameText(args[0], a.bitAdapter) ? 10n ** 15n : 0n) } },
    }),
    base: lower({
      [a.frontDoor]: {
        abi: abiOf("CascadeFrontDoor"),
        answers: {
          owner: r.owner,
          keeper: r.keeper,
          vault: a.vault,
          vaultChain: 964n,
          oracle: a.oracle,
          swapper: a.staker,
          treasury: r.treasury,
          asset: LIVE.base.TOKEN,
          usdc: BASE_V3.USDC,
          minPoolLiquidity: (args: readonly unknown[]) => p.poolFloors[Number(args[0])],
          MS_PER_BLOCK: 120n,
          schedule: scheduler(p, "frontDoor"),
          ...Object.fromEntries(DOOR_SETTINGS.map((n) => [n, dp[n]])),
          paused: false,
          // an open batch with nothing in it, started two hours ago: id, start, totalDeposits, feePot, nDeposits, nRedeems
          openBatch: [7n, BigInt(HEAD_AT - 2 * H), 0n, 0n, 0n, 0n],
          disableBridge: (args: readonly unknown[], from?: string) => ownerOrGuardian(from) ?? (sameText(args[0], a.baseAdapter) ? undefined : revert("BridgeNotEnabled")),
        },
      },
      [a.doorLens]: {
        abi: abiOf("CascadeDoorLens"),
        answers: {
          guardian: r.guardian,
          keeper: r.keeper,
          primaryBridge: a.baseAdapter,
          bridgeEnabled: (args: readonly unknown[]) => sameText(args[0], a.baseAdapter),
          // what the front door has ever enabled: what it takes a payout from (Task 47b)
          bridgeKnown: (args: readonly unknown[]) => sameText(args[0], a.baseAdapter),
          exitsOpen: true,
          DOMAIN_SEPARATOR: domainSeparatorV32(IDS.base, a.frontDoor),
          STAMP_TYPEHASH: STAMP_TYPEHASH_V32,
          ...schedulerReads("frontDoor"),
        },
      },
      [a.staker]: {
        abi: abiOf("CascadeStaker"),
        answers: {
          owner: r.owner,
          treasury: r.treasury,
          frontDoor: a.frontDoor,
          tao: LIVE.base.TOKEN,
          usdc: BASE_V3.USDC,
          swapFeeBps: sp.swapFeeBps,
          depositFeeUsdc: sp.depositFeeUsdc,
          deliveryRouteId: sp.deliveryRouteId,
          routes: (args: readonly unknown[]) => (args[0] === 0 ? [sp.route0.kind, sp.route0.router, sp.route0.buyPath, sp.route0.sellPath, sp.route0.active] : revert("InvalidParameter")),
        },
      },
      [a.oracle]: {
        abi: abiOf("CascadeTwapOracle"),
        answers: { tao: LIVE.base.TOKEN, usdc: BASE_V3.USDC, weth: BASE_V3.WETH, taoWethPool: BASE_V3.TAO_WETH_POOL, wethUsdcPool: BASE_V3.WETH_USDC_POOL, meanLiquidity: [p.poolFloors[0] * 3n, p.poolFloors[1] * 3n] },
      },
      [BASE_V3.TAO_WETH_POOL]: { abi: POOL, answers: { fee: 3000, slot0: [1n, 0, 0, 2000, 2000, 0, true] } },
      [BASE_V3.WETH_USDC_POOL]: { abi: POOL, answers: { fee: 500, slot0: [1n, 0, 0, 1200, 1200, 0, true] } },
      [a.baseAdapter]: {
        abi: abiOf("CcipBaseAdapter"),
        answers: {
          treasury: r.treasury,
          maxMessageValue: (step(p, "baseAdapter").args[0] as { maxMessageValue: bigint }).maxMessageValue,
          minSendAmount: step(p, "baseAdapter").args[1],
          gasBase: (step(p, "baseAdapter").args[0] as { gasBase: bigint }).gasBase,
          gasPerEntry: (step(p, "baseAdapter").args[0] as { gasPerEntry: bigint }).gasPerEntry,
          remoteChainId: 964n,
          remoteAdapter: a.bitAdapter,
          ...LANE_BASE,
        },
      },
    }),
  };
  const codesBy: Record<ChainName, Record<string, Hex>> = { base: {}, bittensor: {} };
  for (const s of p.steps) codesBy[s.chain][a[s.id].toLowerCase()] = codes[s.id];
  const w: World = {
    book,
    storage: {
      [delegatesKey(TAO_BOT)]: le(5_898, 2),
      [totalHotkeyAlphaKey(TAO_BOT, 0)]: le(1_234_567_000_000_000n, 8),
      [uidsKey(0, TAO_BOT)]: le(3, 2),
      [totalHotkeyAlphaKey(YUMA, 0)]: le(987_650_000_000n, 8),
      [uidsKey(0, YUMA)]: le(7, 2),
    },
    codes: codesBy,
    // the Bittensor adapter's native reserve, exactly its target, as funded
    balances: { base: {}, bittensor: { [a.bitAdapter.toLowerCase()]: 10n ** 15n } },
    chainIds: { ...IDS },
    logs: { bittensor: [], base: [] },
    items,
    batches,
    parks,
    estimate: intrinsic(encodeFunctionData({ abi: TOTAL_COLDKEY, functionName: "getTotalColdkeyStakeOnSubnet", args: [addressMapping(a.vault), 0n] })) + READ_GAS,
  };
  // the vault's constructor enables its first bridge, the Bittensor adapter, in its creation block (CascadeBase)
  emit(w, "bittensor", a.vault, build.vaultAbi, "BridgeActivated", { bridge: a.bitAdapter }, CREATED_BLOCK);
  return w;
}

/** A fake RPC over `w`: eth_call answers from the book by the called contract's ABI (anything unplanned throws, so a
 * read the honest world does not expect shows as a failure), eth_getCode from the codes, the storage-query precompile
 * from the storage, and the chain ids, balances and blocks. */
function rpcOf(w: World) {
  const calls: { chain: ChainName; method: string; params: unknown[] }[] = [];
  const rpc: Rpc = {
    async request(chain, method, params) {
      calls.push({ chain, method, params });
      if (method === "eth_chainId") return numberToHex(w.chainIds[chain]);
      if (method === "eth_getCode") return w.codes[chain][String(params[0]).toLowerCase()] ?? "0x";
      if (method === "eth_getBalance") return numberToHex(w.balances[chain][String(params[0]).toLowerCase()] ?? 0n);
      if (method === "eth_getBlockByNumber") {
        const n = params[0] === "latest" ? HEADS[chain] : hexToNumber(params[0] as Hex);
        return n > HEADS[chain] || n < 0 ? null : { number: numberToHex(n), timestamp: numberToHex(timeOf(chain, n)) };
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
            hexToNumber(l.blockNumber) >= (w.prunedBefore?.[chain] ?? 0) &&
            t0.includes(l.topics[0].toLowerCase()) &&
            (t1 === undefined || t1 === null || ([] as Hex[]).concat(t1).some((t) => sameText(t, l.topics[1]))),
        );
      }
      // R11: the write-off read's price, asked of the staking precompile alone
      if (method === "eth_estimateGas") {
        const [{ to }] = params as [{ to: string }];
        if (chain !== "bittensor" || to.toLowerCase() !== PRECOMPILE.staking.toLowerCase()) throw new Error(`unexpected eth_estimateGas of ${to} on ${chain}`);
        if (w.estimate instanceof Error) throw w.estimate;
        return numberToHex(w.estimate);
      }
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      const [{ to, data, from }] = params as [{ to: string; data: Hex; from?: string }];
      if (chain === "bittensor" && to.toLowerCase() === STORAGE_QUERY) {
        const v = w.storage[data.toLowerCase()] ?? w.storage[data];
        if (v instanceof Error) throw v;
        return v ?? "0x";
      }
      const c = w.book[chain][to.toLowerCase()];
      if (!c) throw new Error(`no contract at ${to} on ${chain}`);
      const { functionName, args } = decodeFunctionData({ abi: c.abi, data });
      let v = c.answers[functionName];
      if (v === undefined) throw new Error(`unexpected ${functionName} on ${to}`);
      if (typeof v === "function") v = (v as (a: readonly unknown[], f?: string) => unknown)(args ?? [], from);
      if (v instanceof Error) throw v;
      // an answer as the node gives it, whatever the ABI says (R11: a view that answers nothing, or more than a word)
      if (v instanceof RawAnswer) return v.data;
      // a call that returns nothing (an instrument asked by eth_call) answers nothing
      if (!c.abi.find((x): x is AbiFunction => x.type === "function" && x.name === functionName)?.outputs.length) return "0x";
      return encodeFunctionResult({ abi: c.abi, functionName, result: v } as never);
    },
  };
  // the targets are the chain ids the world reports: the forks' (verify), or the live chains' (the call files)
  const live = w.chainIds.base === LIVE_T.base.chainId && w.chainIds.bittensor === LIVE_T.bittensor.chainId;
  return { rpc, calls, ctx: { rpc, targets: live ? LIVE_T : T } };
}

let logIndex = 0;
/** `event` logged by `contract` (its ABI `abi`) at `address` on `chain`, in block `block`, as the contract encodes it. */
function emit(w: World, chain: ChainName, address: Address, abi: Abi, event: string, args: Record<string, unknown>, block: number): void {
  const ev = abi.find((x): x is AbiEvent => x.type === "event" && x.name === event)!;
  const indexed = Object.fromEntries(ev.inputs.filter((i) => i.indexed).map((i) => [i.name!, args[i.name!]]));
  const topics = encodeEventTopics({ abi: [ev], eventName: event, args: indexed } as never) as Hex[];
  const plain = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain, plain.map((i) => args[i.name!]) as never);
  logIndex++;
  w.logs[chain].push({ address, topics, data, blockNumber: numberToHex(block), logIndex: numberToHex(logIndex % 50), transactionHash: keccak256(numberToHex(logIndex)) });
}

const SCHED_CLASS: Record<string, number> = { writeOffMissingStake: 1, activateFrontDoor: 1, activateBridge: 1, setGuardian: 2, transferOwnership: 2 };
const SCHED_KIND: Record<string, number> = { setGuardian: 1 };

/** `fn(args)` scheduled on the vault or the front door at time `at`: its Scheduled log and its item in the lens, as the
 * contract writes them. */
function put(w: World, p: PlanV32, c: "vault" | "frontDoor", fn: string, args: readonly unknown[], at: number): { id: Hex; data: Hex } {
  const abi = c === "vault" ? build.vaultAbi : abiOf("CascadeFrontDoor");
  const chain: ChainName = c === "vault" ? "bittensor" : "base";
  const data = encodeFunctionData({ abi, functionName: fn, args } as never);
  const id = keccak256(data);
  const cls = SCHED_CLASS[fn] ?? 0;
  const kind = SCHED_KIND[fn] ?? 0;
  const block = blockAt(chain, at);
  const item: Item = { scheduledAt: BigInt(at), readyAt: BigInt(at + DELAYS[cls]), class: cls, kind, selector: data.slice(0, 10) as Hex, readyBlock: BigInt(block + Math.ceil((DELAYS[cls] * 1000) / (2 * (chain === "bittensor" ? 7_200 : 120)))) };
  w.items[c].set(id, item);
  emit(w, chain, p.addresses[c], abi, "Scheduled", { id, kind, selector: item.selector, readyAt: item.readyAt, data }, block);
  return { id, data };
}

/** A payout batch of `door` on `chain` queued on the vault in block `block` (its PayoutBatchQueued log), held as `b`. */
function queue(w: World, p: PlanV32, key: Hex, b: Partial<Batch> & { remaining: bigint; count: number }, block: number, door: Address = p.addresses.frontDoor, chain = 8_453n): Batch {
  const batch: Batch = { ...EMPTY_BATCH, sourceChain: chain, frontDoor: door, batchId: 7n, queuedAt: BigInt(timeOf("bittensor", block)), ...b };
  w.batches.set(key.toLowerCase(), batch);
  emit(w, "bittensor", p.addresses.vault, build.vaultAbi, "PayoutBatchQueued", { key, sourceChain: chain, batchId: batch.batchId, count: b.count, total: b.remaining, price: E18 }, block);
  return batch;
}

/** A batch from `sender` parked in the Bittensor adapter in block `block` (its BatchParked log), held as `park`. */
function park(w: World, p: PlanV32, key: Hex, amount: bigint, converted: boolean, block: number, sender: Address = p.addresses.frontDoor): void {
  w.parks.set(key.toLowerCase(), [amount, BigInt(timeOf("bittensor", block)), converted]);
  emit(w, "bittensor", p.addresses.bitAdapter, abiOf("CcipBittensorAdapter"), "BatchParked", { key, messageId: keccak256(key), recipient: p.addresses.vault, sender, amount, converted, reason: "0x00000000" }, block);
}

const verify = async (w: World = world(), rec: DeploymentRecordV32 = record()) => {
  const f = rpcOf(w);
  return { ...(await verifyV32(f.ctx, rec, { buildsDir })), calls: f.calls };
};

/** `w` with `fn` on the contract at `address` answering `v`. */
function answer(w: World, chain: ChainName, address: Address, fn: string, v: Answer): World {
  w.book[chain][address.toLowerCase()].answers[fn] = v;
  return w;
}

const line = (chain: string, contract: string, read: string, expected: unknown, found: unknown) => `${chain} ${contract}.${read}: expected ${expected}, found ${found}`;

/** R11: the write-off read's calldata, for the vault's own coldkey on root */
const writeOffRead = () => encodeFunctionData({ abi: TOTAL_COLDKEY, functionName: "getTotalColdkeyStakeOnSubnet", args: [addressMapping(plan.addresses.vault), 0n] });
/** R11: what verify reports of the payouts rail and the write-off read in the honest world (the read's own gas `own`) */
const canaryInfo = (own = READ_GAS) => [
  "Bittensor CcipBittensorAdapter.canSendPayouts(): true, one word, asked as the vault asks it (from the vault, with the 150,000 gas it gives the view: RAIL_VIEW_GAS)",
  `Bittensor ForeverMoney's AlphaVault ${LANE_BIT.alphaVault}: isPaused() false, migrationReadyAt() 0, migrationFinished() false, each one word within the 30,000 gas the Bittensor adapter gives each read (RAIL_READ_GAS)`,
  `Bittensor: the write-off's read of the unlisted stake (the staking precompile's getTotalColdkeyStakeOnSubnet, the vault's coldkey on root) costs ${own.toLocaleString("en-US")} gas by eth_estimateGas (less the ${intrinsic(writeOffRead()).toLocaleString("en-US")} a call takes first), of the vault's 45,000,000 cap (WRITE_OFF_READ_GAS), and answers one word by eth_call`,
];

describe("Task 46a: pnpm ops verify on a v3.2 record", () => {
  it("each oracle pool's history is judged at Base's block time, read from two headers: on 200 ms blocks (one observation a second at most) 1,200 slots fall short of 1,801", async () => {
    const f = rpcOf(world());
    // Base since block 53,556,128: five blocks to a whole second
    const fast: Rpc = {
      request: (c, m, p) => {
        if (c !== "base" || m !== "eth_getBlockByNumber") return f.ctx.rpc.request(c, m, p);
        const n = p[0] === "latest" ? HEADS.base : hexToNumber(p[0] as Hex);
        return Promise.resolve({ number: numberToHex(n), timestamp: numberToHex(HEAD_AT - Math.floor((HEADS.base - n) / 5)) });
      },
    };
    const r = await verifyV32({ ...f.ctx, rpc: fast }, record(), { buildsDir });
    expect(r.failures).toEqual([line("Base", `the oracle's WETH/USDC pool ${BASE_V3.WETH_USDC_POOL}`, "slot0().observationCardinality", "at least 1801", 1200)]);
    expect(r.info).toContain("Base: the oracle's TAO/WETH pool has 2000 observation slots in use (its 30-minute window needs 1801)");
  });

  it("an honest deployment passes, and what is reported only is printed", async () => {
    const r = await verify();
    expect(r.failures).toEqual([]);
    expect(r.warnings).toEqual([]);
    const a = plan.addresses;
    expect(r.info).toEqual([
      `Bittensor: the owner ${plan.roles.owner} is a plain account`,
      `Bittensor CascadeVault's stamp domain, as its lens recomputes it: DOMAIN_SEPARATOR ${domainSeparatorV32(IDS.bittensor, a.vault)} and STAMP_TYPEHASH ${STAMP_TYPEHASH_V32}, which viem gives too`,
      "Bittensor CascadeVault's scheduler: its 15 schedulable functions are accepted at their canonical length and refused with one word more (BadCalldata); 4 other selectors are refused (UnknownSelector)",
      // R11 (ChatGPT r3): the payouts rail as the vault reads it, and the write-off read's price on the live chain
      ...canaryInfo(),
      `Base: the owner ${plan.roles.owner} is a plain account`,
      `Base CascadeFrontDoor's stamp domain, as its lens recomputes it: DOMAIN_SEPARATOR ${domainSeparatorV32(IDS.base, a.frontDoor)} and STAMP_TYPEHASH ${STAMP_TYPEHASH_V32}, which viem gives too`,
      "Base CascadeFrontDoor's scheduler: its 9 schedulable functions are accepted at their canonical length and refused with one word more (BadCalldata); 4 other selectors are refused (UnknownSelector)",
      "Base: the oracle's WETH/USDC pool has 1200 observation slots in use (its 30-minute window needs 901)",
      "Base: the oracle's TAO/WETH pool has 2000 observation slots in use (its 30-minute window needs 901)",
      `Base CascadeTwapOracle.meanLiquidity(): the TAO/WETH pool's is ${plan.poolFloors[0] * 3n} (the front door's floor is ${plan.poolFloors[0]})`,
      `Base CascadeTwapOracle.meanLiquidity(): the WETH/USDC pool's is ${plan.poolFloors[1] * 3n} (the front door's floor is ${plan.poolFloors[1]})`,
      `Bittensor validator (the primary) ${encodeSs58(TAO_BOT)}: take 9.00% (5,898 of 65,535), root stake 1,234,567 TAO, root uid 3`,
      `Bittensor validator (the standby) ${encodeSs58(YUMA)}: take 18.00% (11,796 of 65,535, the chain's default), root stake 987.65 TAO, root uid 7`,
      // Task 46b: the exits on both chains, the parks and the cushion, and the scheduler's pending items, reported
      "Bittensor CascadeVault: the exits are open. The owner's last closure or stamp: none; the guardian's last closure: none.",
      "Base CascadeFrontDoor: the exits are open; deposits are open. The owner's last closure or stamp: none; the guardian's last closure: none.",
      "Bittensor CcipBittensorAdapter: its parks hold 0 TAO as native TAO (parkedNative) and 0 TAO as tokens (parkedTokens)",
      "Bittensor CcipBittensorAdapter: beyond its parks, its native reserve is 0.001 TAO and its booked token cushion (tokenCushion) 0.001 FM-TAO (the target of each is 0.001)",
      "Bittensor CascadeVault's scheduler: nothing scheduled that can still run",
      "Base CascadeFrontDoor's scheduler: nothing scheduled that can still run",
      // Task 47b: the rails between the chains
      `The rails: now, the two chains agree on the bridge: the front door's primary ${a.baseAdapter} sends to ${a.bitAdapter} on Bittensor, enabled on the vault; the vault's primary ${a.bitAdapter} sends to ${a.baseAdapter} on Base, which the front door has enabled.`,
    ]);
    expect(r.owners).toEqual({ bittensor: { kind: "account" }, base: { kind: "account" } });
    // the code read-backs ran: every planned address's code read once
    expect(r.calls.filter((c) => c.method === "eth_getCode" && plan.steps.some((s) => sameText(plan.addresses[s.id], c.params[0])))).toHaveLength(13);
    // nothing but reads: no transaction of any kind
    expect(r.calls.every((c) => ["eth_chainId", "eth_getCode", "eth_getBalance", "eth_getBlockByNumber", "eth_getLogs", "eth_call", "eth_estimateGas"].includes(c.method))).toBe(true);
  });

  it("one failure per wrong value, naming the chain, the contract, the read, the expected and the found", async () => {
    const a = () => plan.addresses;
    const r = plan.roles;
    const vp = step(plan, "vault").args[0] as Record<string, unknown>;
    const dp = step(plan, "frontDoor").args[0] as Record<string, unknown>;
    const sp = step(plan, "staker").args[0] as { swapFeeBps: number; depositFeeUsdc: bigint; deliveryRouteId: number; route0: { kind: number; router: Address; buyPath: Hex; sellPath: Hex; active: boolean } };
    const bump = (x: unknown) => (typeof x === "bigint" ? x + 1n : (x as number) + 1);
    // the rails' own finding where the change also breaks them (Task 47b)
    // the residual's half that applies: the batch half for the front door's pair; none for a fault fixed at deploy (halves
    // that don't name each other, a wrong chain: merge 7a's review, M1), whose own words name the cause
    const disagree = (pair: string, residual: string = RAIL_RESIDUAL[1]) => `The rails: now the two chains disagree on the bridge: ${pair}.${residual ? ` ${residual}` : ""}`;
    const unread = (why: string) => `The rails could not be read (${why}): whether the two chains agree on the bridge is not known`;
    const rails: Record<string, string> = {
      // each half names its sender on its own chain, which a wrong launchChain or vaultChain no longer is
      "launch chain": disagree(
        `the front door's primary ${a().baseAdapter} sends to ${a().bitAdapter} on Bittensor, which takes messages only from ${a().baseAdapter} on chain 8453; and the vault's primary ${a().bitAdapter} sends to chain 8453, not to the front door's (964)`,
        "",
      ),
      "vault bridge": unread(`no contract at ${other} on bittensor`),
      "vault bridge off": disagree(`the front door's primary ${a().baseAdapter} sends to ${a().bitAdapter} on Bittensor, which is not enabled on the vault`),
      "door bridge": unread(`no contract at ${other} on base`),
      "door's vault chain": disagree(
        `the front door's primary ${a().baseAdapter} sends to chain 964, not to the vault's (945); and the vault's primary ${a().bitAdapter} sends to ${a().baseAdapter} on Base, which takes messages only from ${a().bitAdapter} on chain 964`,
        "",
      ),
    };
    const cases: [string, (w: World) => World, string][] = [
      // the roles
      ["vault owner", (w) => answer(w, "bittensor", a().vault, "owner", other), line("Bittensor", "CascadeVault", "owner()", r.owner, other)],
      ["vault guardian", (w) => answer(w, "bittensor", a().vaultLens, "guardian", other), line("Bittensor", "CascadeVaultLens", "guardian()", r.guardian, other)],
      // the keeper: its own test below (merge 7b: keeper() as the chains name it, after a rotation too)
      ["vault treasury", (w) => answer(w, "bittensor", a().vaultLens, "treasury", other), line("Bittensor", "CascadeVaultLens", "treasury()", r.treasury, other)],
      ["door owner", (w) => answer(w, "base", a().frontDoor, "owner", other), line("Base", "CascadeFrontDoor", "owner()", r.owner, other)],
      ["door guardian", (w) => answer(w, "base", a().doorLens, "guardian", other), line("Base", "CascadeDoorLens", "guardian()", r.guardian, other)],
      ["staker owner", (w) => answer(w, "base", a().staker, "owner", other), line("Base", "CascadeStaker", "owner()", r.owner, other)],
      // the launch chain and its door
      ["launch chain", (w) => answer(w, "bittensor", a().vault, "launchChain", 964n), line("Bittensor", "CascadeVault", "launchChain()", 8453, 964)],
      ["launch door removed", (w) => answer(w, "bittensor", a().vaultLens, "doorState", 2), line("Bittensor", "CascadeVaultLens", `doorState(the launch door ${a().frontDoor} on 8453)`, 1, 2)],
      ["two doors", (w) => answer(w, "bittensor", a().vaultLens, "activeDoors", 2n), line("Bittensor", "CascadeVaultLens", "activeDoors(8453)", 1, 2)],
      ["vault bridge", (w) => answer(w, "bittensor", a().vaultLens, "primaryBridge", other), line("Bittensor", "CascadeVaultLens", "primaryBridge()", a().bitAdapter, other)],
      ["vault bridge off", (w) => answer(w, "bittensor", a().vaultLens, "bridgeEnabled", false), line("Bittensor", "CascadeVaultLens", `bridgeEnabled(${a().bitAdapter})`, true, false)],
      ["door bridge", (w) => answer(w, "base", a().doorLens, "primaryBridge", other), line("Base", "CascadeDoorLens", "primaryBridge()", a().baseAdapter, other)],
      ["door bridge off", (w) => answer(w, "base", a().doorLens, "bridgeEnabled", false), line("Base", "CascadeDoorLens", `bridgeEnabled(${a().baseAdapter})`, true, false)],
      ["door's vault", (w) => answer(w, "base", a().frontDoor, "vault", other), line("Base", "CascadeFrontDoor", "vault()", a().vault, other)],
      ["door's vault chain", (w) => answer(w, "base", a().frontDoor, "vaultChain", 945n), line("Base", "CascadeFrontDoor", "vaultChain()", 964, 945)],
      // the exits, the stake and its hotkey
      ["vault exits closed", (w) => answer(w, "bittensor", a().vaultLens, "exitsOpen", false), line("Bittensor", "CascadeVaultLens", "exitsOpen()", true, false)],
      ["door exits closed", (w) => answer(w, "base", a().doorLens, "exitsOpen", false), line("Base", "CascadeDoorLens", "exitsOpen()", true, false)],
      ["stake missing", (w) => answer(w, "bittensor", a().vaultLens, "stakeMissing", true), line("Bittensor", "CascadeVaultLens", "stakeMissing()", false, true)],
      ["booked before a stake", (w) => answer(w, "bittensor", a().vaultLens, "bookedStake", 5n), line("Bittensor", "CascadeVaultLens", "bookedStake()", 0, 5)],
      ["hotkeys(0)", (w) => answer(w, "bittensor", a().vaultLens, "hotkeys", otherWord), line("Bittensor", "CascadeVaultLens", "hotkeys(0)", plan.validators.primary, otherWord)],
      ["stake hotkey", (w) => answer(w, "bittensor", a().vaultLens, "stakeHotkey", otherWord), line("Bittensor", "CascadeVaultLens", "stakeHotkey()", plan.validators.primary, otherWord)],
      [
        "lastStakeAt zero",
        (w) => answer(w, "bittensor", a().vaultLens, "lastStakeAt", 0n),
        line("Bittensor", "CascadeVaultLens", "lastStakeAt()", `the vault's creation time ${CREATED_AT} (block ${CREATED_BLOCK}) or a later stake's, at most the head's ${HEAD_AT}`, 0),
      ],
      [
        "lastStakeAt ahead",
        (w) => answer(w, "bittensor", a().vaultLens, "lastStakeAt", BigInt(HEAD_AT + 1)),
        line("Bittensor", "CascadeVaultLens", "lastStakeAt()", `the vault's creation time ${CREATED_AT} (block ${CREATED_BLOCK}) or a later stake's, at most the head's ${HEAD_AT}`, HEAD_AT + 1),
      ],
      [
        "staking hotkey growth",
        (w) => answer(w, "bittensor", PRECOMPILE.staking, "getRejectStakingHotkeyGrowth", false),
        line("Bittensor", "the staking precompile", `getRejectStakingHotkeyGrowth(the vault's coldkey ${plan.vaultColdkey})`, true, false),
      ],
      // the treasuries and the constructor-set wiring
      ["door treasury", (w) => answer(w, "base", a().frontDoor, "treasury", other), line("Base", "CascadeFrontDoor", "treasury()", r.treasury, other)],
      ["staker treasury", (w) => answer(w, "base", a().staker, "treasury", other), line("Base", "CascadeStaker", "treasury()", r.treasury, other)],
      ["Base adapter treasury", (w) => answer(w, "base", a().baseAdapter, "treasury", other), line("Base", "CcipBaseAdapter", "treasury()", r.treasury, other)],
      ["Bittensor adapter treasury", (w) => answer(w, "bittensor", a().bitAdapter, "treasury", other), line("Bittensor", "CcipBittensorAdapter", "treasury()", r.treasury, other)],
      ["door oracle", (w) => answer(w, "base", a().frontDoor, "oracle", other), line("Base", "CascadeFrontDoor", "oracle()", a().oracle, other)],
      ["door swapper", (w) => answer(w, "base", a().frontDoor, "swapper", other), line("Base", "CascadeFrontDoor", "swapper()", a().staker, other)],
      ["staker's door", (w) => answer(w, "base", a().staker, "frontDoor", other), line("Base", "CascadeStaker", "frontDoor()", a().frontDoor, other)],
      ["staker fee", (w) => answer(w, "base", a().staker, "swapFeeBps", 16), line("Base", "CascadeStaker", "swapFeeBps()", sp.swapFeeBps, 16)],
      ["staker deposit fee", (w) => answer(w, "base", a().staker, "depositFeeUsdc", 1n), line("Base", "CascadeStaker", "depositFeeUsdc()", sp.depositFeeUsdc, 1)],
      ["staker delivery route", (w) => answer(w, "base", a().staker, "deliveryRouteId", 1), line("Base", "CascadeStaker", "deliveryRouteId()", 0, 1)],
      [
        "route 0 off",
        (w) => answer(w, "base", a().staker, "routes", [sp.route0.kind, sp.route0.router, sp.route0.buyPath, sp.route0.sellPath, false]),
        line("Base", "CascadeStaker", "routes(0)", `(0, ${sp.route0.router}, ${sp.route0.buyPath}, ${sp.route0.sellPath}, true)`, `(0, ${sp.route0.router}, ${sp.route0.buyPath}, ${sp.route0.sellPath}, false)`),
      ],
      // the oracle: its pools, their tiers and history (its tokens below, with the cross-checks)
      ["oracle TAO/WETH pool", (w) => answer(w, "base", a().oracle, "taoWethPool", other), line("Base", "CascadeTwapOracle", "taoWethPool()", BASE_V3.TAO_WETH_POOL, other)],
      ["oracle WETH/USDC pool", (w) => answer(w, "base", a().oracle, "wethUsdcPool", other), line("Base", "CascadeTwapOracle", "wethUsdcPool()", BASE_V3.WETH_USDC_POOL, other)],
      ["TAO/WETH fee tier", (w) => answer(w, "base", BASE_V3.TAO_WETH_POOL, "fee", 10000), line("Base", `the oracle's TAO/WETH pool ${BASE_V3.TAO_WETH_POOL}`, "fee()", "3000, route 0's fee tier", 10000)],
      ["WETH/USDC fee tier", (w) => answer(w, "base", BASE_V3.WETH_USDC_POOL, "fee", 3000), line("Base", `the oracle's WETH/USDC pool ${BASE_V3.WETH_USDC_POOL}`, "fee()", "500, route 0's fee tier", 3000)],
      [
        "short history",
        (w) => answer(w, "base", BASE_V3.TAO_WETH_POOL, "slot0", [1n, 0, 0, 600, 2000, 0, true]),
        line("Base", `the oracle's TAO/WETH pool ${BASE_V3.TAO_WETH_POOL}`, "slot0().observationCardinality", "at least 901", 600),
      ],
      // the other pool's history too (Task 46a's review, Minor 3)
      [
        "short WETH/USDC history",
        (w) => answer(w, "base", BASE_V3.WETH_USDC_POOL, "slot0", [1n, 0, 0, 600, 1200, 0, true]),
        line("Base", `the oracle's WETH/USDC pool ${BASE_V3.WETH_USDC_POOL}`, "slot0().observationCardinality", "at least 901", 600),
      ],
      ["the oracle's depth unread", (w) => answer(w, "base", a().oracle, "meanLiquidity", revert("InvalidParameter")), "Base CascadeTwapOracle.meanLiquidity(): could not be read (execution reverted)"],
      // the floors and the block times (the chains' real ones)
      ["floor 0", (w) => answer(w, "base", a().frontDoor, "minPoolLiquidity", (x: readonly unknown[]) => (x[0] === 0n ? 7n : plan.poolFloors[1])), line("Base", "CascadeFrontDoor", "minPoolLiquidity(0)", plan.poolFloors[0], 7)],
      ["floor 1", (w) => answer(w, "base", a().frontDoor, "minPoolLiquidity", (x: readonly unknown[]) => (x[0] === 1n ? 7n : plan.poolFloors[0])), line("Base", "CascadeFrontDoor", "minPoolLiquidity(1)", plan.poolFloors[1], 7)],
      // a block time in seconds where the constructor took milliseconds (Revision 28): Bittensor's 12, Base's 2
      ["vault block time", (w) => answer(w, "bittensor", a().vault, "MS_PER_BLOCK", 12n), line("Bittensor", "CascadeVault", "MS_PER_BLOCK()", 7200, 12)],
      // Task 65: the vault's EXIT_GAS_RESERVE is the keeper's own (a vault built with the old 1,200,000 fails)
      ["exit gas reserve", (w) => answer(w, "bittensor", a().vaultLens, "EXIT_GAS_RESERVE", 1_200_000n), line("Bittensor", "CascadeVaultLens", "EXIT_GAS_RESERVE()", 2000000, 1200000)],
      ["door block time", (w) => answer(w, "base", a().frontDoor, "MS_PER_BLOCK", 2n), line("Base", "CascadeFrontDoor", "MS_PER_BLOCK()", 120, 2)],
      // the stamp's domain (domainSeparatorMatchesViem has more)
      ["vault type hash", (w) => answer(w, "bittensor", a().vaultLens, "STAMP_TYPEHASH", otherWord), line("Bittensor", "CascadeVaultLens", "STAMP_TYPEHASH()", STAMP_TYPEHASH_V32, otherWord)],
      ["door type hash", (w) => answer(w, "base", a().doorLens, "STAMP_TYPEHASH", otherWord), line("Base", "CascadeDoorLens", "STAMP_TYPEHASH()", STAMP_TYPEHASH_V32, otherWord)],
      // the adapters' caps as planned (and the cap relations, which still hold one wei up)
      [
        "Bittensor adapter cap",
        (w) => answer(w, "bittensor", a().bitAdapter, "maxMessageValue", 50n * 10n ** 18n + 1n),
        line("Bittensor", "CcipBittensorAdapter", "maxMessageValue()", 50n * 10n ** 18n, 50n * 10n ** 18n + 1n),
      ],
      ["Base adapter cap", (w) => answer(w, "base", a().baseAdapter, "maxMessageValue", 50n * 10n ** 18n + 1n), line("Base", "CcipBaseAdapter", "maxMessageValue()", 50n * 10n ** 18n, 50n * 10n ** 18n + 1n)],
      ["Base adapter minimum", (w) => answer(w, "base", a().baseAdapter, "minSendAmount", 1n), line("Base", "CcipBaseAdapter", "minSendAmount()", step(plan, "baseAdapter").args[1], 1)],
      // every constructor limit of the vault, and every batch and cap setting of the front door
      ...VAULT_LIMITS.map((n): [string, (w: World) => World, string] => [`vault ${n}`, (w) => answer(w, "bittensor", a().vaultLens, n, bump(vp[n])), line("Bittensor", "CascadeVaultLens", `${n}()`, vp[n], bump(vp[n]))]),
      ...DOOR_SETTINGS.map((n): [string, (w: World) => World, string] => [`door ${n}`, (w) => answer(w, "base", a().frontDoor, n, bump(dp[n])), line("Base", "CascadeFrontDoor", `${n}()`, dp[n], bump(dp[n]))]),
    ];
    // R12d: the payouts view and its AlphaVault are asked of the vault's primary as read, so a stranger there fails them too
    const ofStranger = ` of the vault's primary bridge ${other} (not the record's adapter ${a().bitAdapter})`;
    const asked: Record<string, string[]> = {
      "vault bridge": [
        `Bittensor CcipBittensorAdapter.canSendPayouts()${ofStranger}: could not be read (no contract at ${other} on bittensor)`,
        `Bittensor CcipBittensorAdapter.alphaVault()${ofStranger}: could not be read (no contract at ${other} on bittensor)`,
      ],
    };
    for (const [label, change, want] of cases) {
      const r = await verify(change(world()));
      expect(r.failures, label).toEqual([want, ...(asked[label] ?? []), ...(rails[label] ? [rails[label]] : [])]);
    }
  }, 60_000);

  it("merge 7b (R4-O concern 2): keeper() as the chains name it: a whole rotation is said, never failed; a half one, a lens that disagrees with its door, or an unread one fails; a revoked one warns", async () => {
    const a = plan.addresses;
    const first = plan.roles.keeper;
    const NEW = getAddress(`0x${"4e".repeat(20)}`);
    const ZERO = getAddress(`0x${"00".repeat(20)}`);
    /** keeper() answered as `k` where named: the vault (through its lens), the front door, and the door lens (which reads
     * the front door's storage, so it answers as the door does) */
    const keeperIs = (w: World, k: Address, where: readonly ("vault" | "door")[] = ["vault", "door"]) => {
      if (where.includes("vault")) answer(w, "bittensor", a.vaultLens, "keeper", k);
      if (where.includes("door")) answer(answer(w, "base", a.frontDoor, "keeper", k), "base", a.doorLens, "keeper", k);
      return w;
    };
    // the plan's first keeper on both: nothing is said of it
    const honest = await verify();
    expect(honest.info.filter((l) => l.startsWith("The keeper"))).toEqual([]);
    // a whole rotation (setKeeper on both, runbook 2.6): no failure, said as information
    const rotated = await verify(keeperIs(world(), NEW));
    expect([rotated.failures, rotated.warnings]).toEqual([[], []]);
    expect(rotated.info).toContain(
      `The keeper: keeper() is ${NEW} on both chains, not the plan's first keeper ${first}: a rotation (setKeeper on both, runbook 2.6). The keeper Worker holds its key to keeper() on both, never to the plan's.`,
    );
    // half a rotation (the vault's call landed, the front door's not), either way round: a failure
    for (const [where, vault, door] of [
      [["vault"], NEW, first],
      [["door"], first, NEW],
    ] as const) {
      const half = await verify(keeperIs(world(), NEW, where));
      expect(half.failures, where[0]).toEqual([
        `The keeper: keeper() is ${vault} on the vault (Bittensor) and ${door} on the front door (Base): one key must be keeper() on both (a rotation half done, runbook 2.6: the keeper Worker sends nothing until both calls have landed)`,
      ]);
    }
    // the door lens reading another keeper than its front door (Task 43a's review, M5): a failure
    const lens = await verify(answer(world(), "base", a.doorLens, "keeper", other));
    expect(lens.failures).toEqual([`Base CascadeDoorLens.keeper(): expected ${first} (the front door's own keeper()), found ${other}`]);
    // revoked on both (setKeeper(0)): a warning, not a failure
    const revoked = await verify(keeperIs(world(), ZERO));
    expect(revoked.failures).toEqual([]);
    expect(revoked.warnings).toContain(
      "The keeper: keeper() is 0 on both chains (setKeeper(0), the keeper revoked): no delivery goes, and stakes, claims and adoptions wait for their 7-day fallbacks",
    );
    // a keeper() that can't be read: a failure, and nothing more is judged of the keeper
    const unread = await verify(answer(world(), "bittensor", a.vaultLens, "keeper", new RpcError("header not found", -32000)));
    expect(unread.failures).toEqual(["Bittensor CascadeVaultLens.keeper(): could not be read (header not found)"]);
  });

  it("the lane's inbound gas model is one model (R4): the Bittensor adapter's copy differing from the Base adapter's own pair fails, as read, whatever the plan said; unread, it is not checked and fails", async () => {
    const bitArgs = step(plan, "bitAdapter").args;
    const [base, perEntry] = [bitArgs[2] as bigint, bitArgs[3] as bigint];
    // the setting toward Bittensor (the R4 review's 1,300,000 + 57,000, the park reserve included)
    expect(base).toBe(SETTINGS_V32_LAUNCH.gas.towardBittensor.base);
    expect(perEntry).toBe(SETTINGS_V32_LAUNCH.gas.towardBittensor.perEntry);
    expect([base, perEntry]).toEqual([1_300_000n, 57_000n]);
    // the plan feeds both adapters from the one setting
    expect((step(plan, "baseAdapter").args[0] as { gasBase: bigint; gasPerEntry: bigint }).gasBase).toBe(base);
    expect((step(plan, "baseAdapter").args[0] as { gasBase: bigint; gasPerEntry: bigint }).gasPerEntry).toBe(perEntry);
    // the Bittensor adapter's per-entry figure one lower than planned: its own read fails, and so does the model
    let r = await verify(answer(world(), "bittensor", plan.addresses.bitAdapter, "inboundGasPerEntry", perEntry - 1n));
    expect(r.failures).toEqual([
      line("Bittensor", "CcipBittensorAdapter", "inboundGasPerEntry()", perEntry, perEntry - 1n),
      `Bittensor CcipBittensorAdapter.inboundGasPerEntry (${perEntry - 1n}) is not Base CcipBaseAdapter.gasPerEntry (${perEntry}): the lane's inbound gas model is one model, and deliverParked's gas requirement would not be what CCIP gives a delivery`,
    ]);
    // both adapters as a hand-edited plan said, the base's model differing from the copy: only the model check fails
    const edited = structuredClone(plan);
    (step(edited, "baseAdapter").args[0] as { gasBase: bigint }).gasBase = base + 1n;
    r = await verify(answer(world(), "base", plan.addresses.baseAdapter, "gasBase", base + 1n), record(edited));
    expect(r.failures.filter((f) => f.includes("inbound gas model"))).toEqual([
      `Bittensor CcipBittensorAdapter.inboundGasBase (${base}) is not Base CcipBaseAdapter.gasBase (${base + 1n}): the lane's inbound gas model is one model, and deliverParked's gas requirement would not be what CCIP gives a delivery`,
    ]);
    expect(r.failures.some((f) => f.startsWith("Base CcipBaseAdapter.gasBase()"))).toBe(false);
    // an unread copy: the read fails, and the model is not checked
    r = await verify(answer(world(), "bittensor", plan.addresses.bitAdapter, "inboundGasBase", revert("InvalidParameter")));
    expect(r.failures).toEqual([
      "Bittensor CcipBittensorAdapter.inboundGasBase(): could not be read (execution reverted)",
      "the lane's inbound gas model is not checked: Bittensor CcipBittensorAdapter.inboundGasBase() could not be read",
    ]);
  });

  it("a read that fails is a failure, never a pass; an unreadable cap fails the cap relations too", async () => {
    let r = await verify(answer(world(), "bittensor", plan.addresses.vaultLens, "guardian", new RpcError("header not found", -32000)));
    expect(r.failures).toEqual(["Bittensor CascadeVaultLens.guardian(): could not be read (header not found)"]);
    r = await verify(answer(world(), "base", plan.addresses.frontDoor, "maxBatchValue", revert("InvalidParameter")));
    expect(r.failures).toEqual([
      "Base CascadeFrontDoor.maxBatchValue(): could not be read (execution reverted)",
      "the cap relations across the pair are not checked: Base CascadeFrontDoor.maxBatchValue() could not be read",
    ]);
  });

  it("nonZeroByConstruction: a lens that reads an empty target fails every check, and its zero reads say they prove nothing", async () => {
    // the vault lens answering as for an empty target: zeros, false, the zero address, and OPEN
    const w = world();
    const zero = `0x${"00".repeat(20)}`;
    const empty = { ...w.book.bittensor[plan.addresses.vaultLens.toLowerCase()].answers };
    for (const k of Object.keys(empty)) {
      if (["DOMAIN_SEPARATOR", "STAMP_TYPEHASH"].includes(k)) continue;
      empty[k] = k === "exitsOpen" ? true : k === "stakeMissing" || k === "bridgeEnabled" ? false : ["guardian", "keeper", "treasury", "primaryBridge"].includes(k) ? zero : k === "hotkeys" || k === "stakeHotkey" ? `0x${"00".repeat(32)}` : k === "doorState" ? 0 : 0n;
    }
    w.book.bittensor[plan.addresses.vaultLens.toLowerCase()].answers = empty;
    const r = await verify(w);
    // every zero read an empty slot shares with the plan is refused, saying why; never passed
    const unproven = (read: string, v: string) => `Bittensor CascadeVaultLens.${read}: reads ${v}, as planned, but so would an empty slot, and none of this lens's non-zero reads matched the plan: not checked`;
    for (const l of [unproven("exitsOpen()", "true"), unproven("stakeMissing()", "false"), unproven("bookedStake()", "0"), unproven("unstakeMarginRao()", "0"), unproven("idleBufferBps()", "0")]) {
      expect(r.failures, l).toContain(l);
    }
    // and each non-zero read fails as itself
    expect(r.failures).toContain(line("Bittensor", "CascadeVaultLens", "guardian()", plan.roles.guardian, zero));
    expect(r.failures).toContain(line("Bittensor", "CascadeVaultLens", "payoutDelay()", 86400, 0));
    expect(r.failures).toContain(line("Bittensor", "CascadeVaultLens", "maxEntryValue()", 10n * 10n ** 18n, 0));
    expect(r.failures.filter((f) => f.startsWith("Bittensor CascadeVaultLens.") && !f.includes("not checked"))).toHaveLength(
      // guardian, treasury, the door, the doors, the bridge and its enabling, hotkeys(0), stakeHotkey, lastStakeAt, the
      // exit gas reserve (Task 65) and the limits that are not 0
      10 + VAULT_LIMITS.length - 2,
    );
    // and its keeper(), the zero address, is not the front door's (merge 7b: judged across the chains)
    expect(r.failures).toContain(
      `The keeper: keeper() is ${zero} on the vault (Bittensor) and ${plan.roles.keeper} on the front door (Base): one key must be keeper() on both (a rotation half done, runbook 2.6: the keeper Worker sends nothing until both calls have landed)`,
    );
    // the door lens alike: its exits read OPEN, which proves nothing while its guardian, keeper and bridge read empty
    const d = world();
    Object.assign(d.book.base[plan.addresses.doorLens.toLowerCase()].answers, { guardian: zero, keeper: zero, primaryBridge: zero, bridgeEnabled: false });
    const rd = await verify(d);
    expect(rd.failures).toContain("Base CascadeDoorLens.exitsOpen(): reads true, as planned, but so would an empty slot, and none of this lens's non-zero reads matched the plan: not checked");
    // and the rails, whose front door primary reads as the zero address, which holds no adapter (Task 47b)
    expect(rd.failures).toContain(`The rails could not be read (no contract at ${zero} on base): whether the two chains agree on the bridge is not known`);
    expect(rd.failures).toHaveLength(6);
    // one wrong non-zero read leaves the lens proven to read its target: one failure, no more
    expect((await verify(answer(world(), "base", plan.addresses.doorLens, "guardian", other))).failures).toHaveLength(1);
  });

  it("C-I4: the oracle's tokens are the front door's and the staker's, and route 0 swaps through its pools", async () => {
    // the oracle on another TAO: its own read, its token against the door's and the staker's, and route 0's path
    let r = await verify(answer(world(), "base", plan.addresses.oracle, "tao", other));
    expect(r.failures).toEqual([
      line("Base", "CascadeTwapOracle", "tao()", LIVE.base.TOKEN, other),
      `Base CascadeTwapOracle: its TAO ${other} is not the front door's (${LIVE.base.TOKEN}) and the staker's (${LIVE.base.TOKEN}): it would price another token`,
      `Base CascadeStaker.routes(0): its buy path ${(step(plan, "staker").args[0] as { route0: { buyPath: Hex } }).route0.buyPath} is not USDC, WETH, TAO, the oracle's tokens`,
    ]);
    // the front door on another USDC: its own read and the cross-check
    r = await verify(answer(world(), "base", plan.addresses.frontDoor, "usdc", other));
    expect(r.failures).toEqual([
      line("Base", "CascadeFrontDoor", "usdc()", BASE_V3.USDC, other),
      `Base CascadeTwapOracle: its USDC ${BASE_V3.USDC} is not the front door's (${other}) and the staker's (${BASE_V3.USDC}): it would price another token`,
    ]);
    // the staker on another TAO
    r = await verify(answer(world(), "base", plan.addresses.staker, "tao", other));
    expect(r.failures).toEqual([
      line("Base", "CascadeStaker", "tao()", LIVE.base.TOKEN, other),
      `Base CascadeTwapOracle: its TAO ${LIVE.base.TOKEN} is not the front door's (${LIVE.base.TOKEN}) and the staker's (${other}): it would price another token`,
    ]);
    // the oracle on another WETH: its read and route 0's path
    r = await verify(answer(world(), "base", plan.addresses.oracle, "weth", other));
    expect(r.failures).toHaveLength(2);
    expect(r.failures[0]).toBe(line("Base", "CascadeTwapOracle", "weth()", BASE_V3.WETH, other));
    // Task 46a's review, Minor 3: the three token reads that had no fail case
    // the front door on another TAO: its own read, and the oracle's TAO against it
    r = await verify(answer(world(), "base", plan.addresses.frontDoor, "asset", other));
    expect(r.failures).toEqual([
      line("Base", "CascadeFrontDoor", "asset()", LIVE.base.TOKEN, other),
      `Base CascadeTwapOracle: its TAO ${LIVE.base.TOKEN} is not the front door's (${other}) and the staker's (${LIVE.base.TOKEN}): it would price another token`,
    ]);
    // the staker on another USDC
    r = await verify(answer(world(), "base", plan.addresses.staker, "usdc", other));
    expect(r.failures).toEqual([
      line("Base", "CascadeStaker", "usdc()", BASE_V3.USDC, other),
      `Base CascadeTwapOracle: its USDC ${BASE_V3.USDC} is not the front door's (${BASE_V3.USDC}) and the staker's (${other}): it would price another token`,
    ]);
    // the oracle on another USDC: its read, the cross-check and route 0's path
    r = await verify(answer(world(), "base", plan.addresses.oracle, "usdc", other));
    expect(r.failures).toEqual([
      line("Base", "CascadeTwapOracle", "usdc()", BASE_V3.USDC, other),
      `Base CascadeTwapOracle: its USDC ${other} is not the front door's (${BASE_V3.USDC}) and the staker's (${BASE_V3.USDC}): it would price another token`,
      `Base CascadeStaker.routes(0): its buy path ${(step(plan, "staker").args[0] as { route0: { buyPath: Hex } }).route0.buyPath} is not USDC, WETH, TAO, the oracle's tokens`,
    ]);
  });

  it("the cap relations across the pair, as read: an adapter below what it must carry fails", async () => {
    const r = await verify(answer(world(), "base", plan.addresses.baseAdapter, "maxMessageValue", 5n * 10n ** 18n));
    expect(r.failures).toEqual([
      line("Base", "CcipBaseAdapter", "maxMessageValue()", 50n * 10n ** 18n, 5n * 10n ** 18n),
      "Base CcipBaseAdapter.maxMessageValue (5 TAO) is below the front door's maxBatchValue (10 TAO): a full batch could never be sent",
    ]);
    const b = await verify(answer(world(), "bittensor", plan.addresses.bitAdapter, "maxMessageValue", 12n * 10n ** 18n));
    expect(b.failures).toEqual([
      line("Bittensor", "CcipBittensorAdapter", "maxMessageValue()", 50n * 10n ** 18n, 12n * 10n ** 18n),
      "Bittensor CcipBittensorAdapter.maxMessageValue (12 TAO) is below the vault's maxMessageValue (15 TAO): a payout message that size could never be sent",
    ]);
  });

  it("the block times are the chains' calibrated ones in milliseconds (the pins), never the plan's: a plan in seconds (12 and 2), deployed so, fails", async () => {
    expect(MS_PER_BLOCK_PINS).toEqual({ bittensor: 7_200n, base: 120n });
    const p = structuredClone(plan);
    (step(p, "vault").args[0] as { msPerBlock: bigint }).msPerBlock = 12n;
    (step(p, "frontDoor").args[0] as { msPerBlock: bigint }).msPerBlock = 2n;
    // its code holds 12 and 2, as its constructor arguments said: the code read-back passes it
    const w = world(p, codesOf(p));
    answer(w, "bittensor", p.addresses.vault, "MS_PER_BLOCK", 12n);
    answer(w, "base", p.addresses.frontDoor, "MS_PER_BLOCK", 2n);
    const r = await verify(w, record(p));
    expect(r.failures).toEqual([line("Bittensor", "CascadeVault", "MS_PER_BLOCK()", 7200, 12), line("Base", "CascadeFrontDoor", "MS_PER_BLOCK()", 120, 2)]);
  });

  it("domainSeparatorMatchesViem: each lens's DOMAIN_SEPARATOR is viem's hashDomain for its chain and target, and STAMP_TYPEHASH the source's", async () => {
    // viem's hashDomain, as the contracts' CascadeFormulas has it: "Cascade", "3.2", the chain id, the contract
    const types = {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    } as const;
    for (const [chain, at] of [
      ["bittensor", plan.addresses.vault],
      ["base", plan.addresses.frontDoor],
    ] as const) {
      expect(domainSeparatorV32(IDS[chain], at)).toBe(hashDomain({ domain: { name: "Cascade", version: "3.2", chainId: BigInt(IDS[chain]), verifyingContract: at }, types }));
    }
    const src = readFileSync(join(CONTRACTS, "src", "CascadeConstants.sol"), "utf8");
    expect(src).toContain('bytes32 constant STAMP_TYPEHASH = keccak256("OwnerStamp(uint64 asOf)");');
    expect(STAMP_TYPEHASH_V32).toBe(keccak256(stringToBytes("OwnerStamp(uint64 asOf)")));
    // a lens answering another chain's separator (mainnet's, read on the forks), or another contract's, fails
    for (const [chain, lensAt, target, contract] of [
      ["bittensor", plan.addresses.vaultLens, plan.addresses.vault, "CascadeVaultLens"],
      ["base", plan.addresses.doorLens, plan.addresses.frontDoor, "CascadeDoorLens"],
    ] as const) {
      for (const wrong of [domainSeparatorV32(chain === "base" ? 8453 : 964, target), domainSeparatorV32(IDS[chain], other)]) {
        const r = await verify(answer(world(), chain, lensAt, "DOMAIN_SEPARATOR", wrong));
        expect(r.failures).toEqual([line(chain === "base" ? "Base" : "Bittensor", contract, "DOMAIN_SEPARATOR()", domainSeparatorV32(IDS[chain], target), wrong)]);
        // and its domain is not printed as matching
        expect(r.info.some((l) => l.includes(`${chain === "base" ? "CascadeFrontDoor" : "CascadeVault"}'s stamp domain`))).toBe(false);
      }
    }
  });

  it("the scheduler's class table by eth_call from the owner: every known selector accepted, one word more BadCalldata, the rest UnknownSelector", async () => {
    // the table is the contracts' _classify: each selector it names, CascadeBase's after each contract's own
    const classify = (file: string) => {
      const text = readFileSync(join(CONTRACTS, "src", file), "utf8");
      const body = text.slice(text.indexOf("function _classify("), text.indexOf("\n    }\n", text.indexOf("function _classify(")));
      return [...body.matchAll(/this\.(\w+)\.selector/g)].map((m) => m[1]);
    };
    const base = classify("CascadeBase.sol");
    expect(base).toEqual(["setGuardian", "transferOwnership", "activateBridge"]);
    expect(SCHEDULED_V32.vault.map((s) => s.fn).sort()).toEqual([...new Set([...classify("CascadeVault.sol"), ...base])].sort());
    expect(SCHEDULED_V32.frontDoor.map((s) => s.fn).sort()).toEqual([...new Set([...classify("CascadeFrontDoor.sol"), ...base])].sort());
    // Task 46a's review, Minor 4: each entry's delay class and kind, as the source's _classify returns them. A selector's
    // branch runs from its `this.X.selector` to the next selector named: the first Delay.<class> in it is its class
    // (none: the vault's default, Param), and its kind is "Ordinary or Reopen" where it can return Kind.Reopen, else
    // GuardianSwap where it returns that, else Ordinary. (An eth_call sees only the id: T61 compares each class's delay
    // with readyAt - scheduledAt of a fork's Scheduled item.)
    const classes = (file: string) => {
      const text = readFileSync(join(CONTRACTS, "src", file), "utf8");
      const body = text.slice(text.indexOf("function _classify("), text.indexOf("\n    }\n", text.indexOf("function _classify(")));
      const at = [...body.matchAll(/this\.(\w+)\.selector/g)];
      return at.map((m, i) => {
        const branch = body.slice(m.index, at[i + 1]?.index ?? body.length);
        const delay = branch.match(/Delay\.(Param|Registry|Guardian)/)?.[1] ?? "Param";
        const kind = branch.includes("Kind.Reopen") ? "Ordinary or Reopen" : branch.includes("Kind.GuardianSwap") ? "GuardianSwap" : "Ordinary";
        return { fn: m[1], delay, kind };
      });
    };
    const byFn = (rows: readonly { fn: string; delay: string; kind: string }[]) => Object.fromEntries(rows.map((s) => [s.fn, `${s.delay}, ${s.kind}`]));
    expect(byFn(SCHEDULED_V32.vault)).toEqual(byFn([...classes("CascadeVault.sol"), ...classes("CascadeBase.sol")]));
    expect(byFn(SCHEDULED_V32.frontDoor)).toEqual(byFn([...classes("CascadeFrontDoor.sol"), ...classes("CascadeBase.sol")]));
    // the parse itself, on the rows the review named: the Registry and Guardian entries
    expect(byFn(SCHEDULED_V32.vault)).toMatchObject({
      activateFrontDoor: "Registry, Ordinary or Reopen",
      writeOffMissingStake: "Registry, Ordinary",
      activateBridge: "Registry, Ordinary or Reopen",
      setGuardian: "Guardian, GuardianSwap",
      transferOwnership: "Guardian, Ordinary",
      setMaxTotalAssets: "Param, Ordinary",
    });
    // and this test's own classifier (the fake chains') holds the same, one word an argument
    for (const [which, abi] of [
      ["vault", build.vaultAbi],
      ["frontDoor", abiOf("CascadeFrontDoor")],
    ] as const) {
      expect(Object.keys(CLASSIFY[which]).sort()).toEqual(SCHEDULED_V32[which].map((s) => s.fn).sort());
      for (const [fn, words] of Object.entries(CLASSIFY[which])) expect(abi.find((x): x is AbiFunction => x.type === "function" && x.name === fn)!.inputs, fn).toHaveLength(words);
      // an unknown probe is none of its selectors
      expect(abi.some((x) => x.type === "function" && toFunctionSelector(x) === UNKNOWN_PROBES[0])).toBe(false);
    }
    // the honest chains: every probe answered as the contract would, each from the owner
    const honest = await verify();
    const probes = honest.calls.filter((c) => c.method === "eth_call" && [plan.addresses.vault, plan.addresses.frontDoor].some((x) => sameText(x, (c.params[0] as { to: string }).to)));
    const scheduled = probes.filter((c) => (c.params[0] as { data: Hex }).data.startsWith(toFunctionSelector("schedule(bytes)")));
    expect(scheduled).toHaveLength(2 * 15 + 4 + 2 * 9 + 4);
    expect(scheduled.every((c) => sameText((c.params[0] as { from: string }).from, plan.roles.owner))).toBe(true);
    // B19: each activation (and guardian and owner) probe names a fresh address, none of the deployment's
    const known = [...Object.values(plan.addresses), ...Object.values(plan.roles), ...Object.values(plan.deployers)].map((x) => x.toLowerCase());
    for (const c of scheduled) {
      const outer = decodeFunctionData({ abi: build.vaultAbi, data: (c.params[0] as { data: Hex }).data }).args![0] as Hex;
      const words = outer.slice(10).match(/.{64}/g) ?? [];
      for (const w of words) expect(known).not.toContain(`0x${w.slice(24)}`);
    }
    expect(probeAddress("vault.activateFrontDoor.1")).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // a known selector the vault refuses
    const vaultTable = { ...CLASSIFY.vault };
    delete (vaultTable as Record<string, number>).setPayoutDelay;
    let r = await verify(answer(world(), "bittensor", plan.addresses.vault, "schedule", scheduler(plan, "vault", vaultTable)));
    const delay = encodeFunctionCall(build.vaultAbi, "setPayoutDelay", [1n]);
    expect(r.failures).toEqual([
      `Bittensor CascadeVault.schedule(setPayoutDelay(uint64)), from the owner: expected it scheduled under ${keccak256(delay)} (Param, Ordinary), found a revert, UnknownSelector()`,
      `Bittensor CascadeVault.schedule(setPayoutDelay(uint64) and one word more), from the owner: expected the revert BadCalldata(), found a revert, UnknownSelector()`,
    ]);
    // the front door accepting setOracle at any length
    const loose = scheduler(plan, "frontDoor");
    r = await verify(
      answer(world(), "base", plan.addresses.frontDoor, "schedule", (args: readonly unknown[], from?: string) =>
        (args[0] as Hex).startsWith(toFunctionSelector("setOracle(address)")) ? keccak256(args[0] as Hex) : loose(args, from),
      ),
    );
    const oracle = encodeFunctionCall(abiOf("CascadeFrontDoor"), "setOracle", [probeAddress("frontDoor.setOracle.0")]);
    expect(r.failures).toEqual([
      `Base CascadeFrontDoor.schedule(setOracle(address) and one word more), from the owner: expected the revert BadCalldata(), found it scheduled under ${keccak256(`${oracle}${"00".repeat(32)}`)}`,
    ]);
    // and the table's information line, which says the long probes are refused, is not printed then (Task 46a's
    // review, Minor 1); the vault's, all of whose probes answered right, still is
    expect(r.info.filter((l) => l.includes("'s scheduler: its "))).toEqual([
      "Bittensor CascadeVault's scheduler: its 15 schedulable functions are accepted at their canonical length and refused with one word more (BadCalldata); 4 other selectors are refused (UnknownSelector)",
    ]);
    // the vault scheduling an owner setter that acts at once
    r = await verify(answer(world(), "bittensor", plan.addresses.vault, "schedule", scheduler(plan, "vault", { ...CLASSIFY.vault, setKeeper: 1 })));
    const keeper = encodeFunctionCall(build.vaultAbi, "setKeeper", [probeAddress("vault.setKeeper.0")]);
    expect(r.failures).toEqual([`Bittensor CascadeVault.schedule(setKeeper(address)), from the owner: expected the revert UnknownSelector(), found it scheduled under ${keccak256(keeper)}`]);
    // an id other than keccak256 of the calldata
    r = await verify(answer(world(), "base", plan.addresses.frontDoor, "schedule", (args: readonly unknown[], from?: string) => {
      const v = loose(args, from);
      return typeof v === "string" && (args[0] as Hex).startsWith(toFunctionSelector("setSwapper(address)")) ? otherWord : v;
    }));
    const swapper = encodeFunctionCall(abiOf("CascadeFrontDoor"), "setSwapper", [probeAddress("frontDoor.setSwapper.0")]);
    expect(r.failures).toEqual([`Base CascadeFrontDoor.schedule(setSwapper(address)), from the owner: expected it scheduled under ${keccak256(swapper)} (Param, Ordinary), found it scheduled under ${otherWord}`]);
    // a node that does not answer: not read, a failure
    r = await verify(answer(world(), "base", plan.addresses.frontDoor, "schedule", new RpcError("header not found", -32000)));
    expect(r.failures).toHaveLength(9 * 2 + 4);
    expect(r.failures[0]).toBe("Base CascadeFrontDoor.schedule(setOracle(address)), from the owner: could not be read (header not found)");
  });

  it("the stake: nothing booked before the first stake; after one, the booked stake is reported", async () => {
    const staked = answer(answer(world(), "bittensor", plan.addresses.vaultLens, "lastStakeAt", BigInt(CREATED_AT + 600)), "bittensor", plan.addresses.vaultLens, "bookedStake", 5_000_000_000n);
    const r = await verify(staked);
    expect(r.failures).toEqual([]);
    expect(r.info).toContain(`Bittensor CascadeVaultLens.bookedStake(): 5000000000 rao, staked since its deploy (lastStakeAt ${CREATED_AT + 600})`);
    // a record without the vault's create block: lastStakeAt is still checked non-zero and before the head, and it fails
    const rec = record();
    delete rec.done.vault;
    const n = await verify(world(), rec);
    expect(n.failures).toEqual([
      "Bittensor CascadeVault: the record has no block for its create, so lastStakeAt is not compared with its creation time",
      // nor can the scheduler's logs be read from it (Task 46b)
      "Bittensor CascadeVault's scheduler: its pending items could not be read (the record has no block for the vault (Bittensor)'s creation, where its scheduler's logs start; nothing read)",
    ]);
  });

  it("getRejectStakingHotkeyGrowth reads the vault's own coldkey, its address's mapping, and a record naming another fails (Task 46a's review, Minor 5)", async () => {
    const derived = addressMapping(plan.addresses.vault);
    expect(plan.vaultColdkey).toBe(derived);
    // a record whose coldkey was changed after its deploy: the flag is still read for the vault's own coldkey, which
    // holds it, and the record's is a failure of its own
    const rec = record({ ...plan, vaultColdkey: otherWord });
    const r = await verify(world(), rec);
    expect(r.failures).toEqual([
      `Bittensor CascadeVault: the record's vaultColdkey ${otherWord} is not the vault's coldkey ${derived}, the address mapping of ${plan.addresses.vault} (the one its code holds): the record was changed after its deploy`,
    ]);
    const asked = r.calls.filter((c) => c.method === "eth_call" && sameText((c.params[0] as { to: string }).to, PRECOMPILE.staking) && (c.params[0] as { data: Hex }).data.startsWith(toFunctionSelector("getRejectStakingHotkeyGrowth(bytes32)")));
    expect(asked).toHaveLength(1);
    expect(decodeFunctionData({ abi: STAKING, data: (asked[0].params[0] as { data: Hex }).data }).args).toEqual([derived]);
  });

  it("R11 (ChatGPT r3, claims 1 and 2): what only the live chain shows of two reads the vault trusts: the payouts view asked as the vault asks it, ForeverMoney's three getters as the adapter asks them, and the write-off read's price against its cap", async () => {
    const a = plan.addresses;
    const src = (p: string) => readFileSync(join(CONTRACTS, "src", p), "utf8");
    // the gas each is asked with is the contracts' own: the vault's 150,000 for the view, the adapter's 30,000 a getter
    expect(src("CascadeVault.sol")).toMatch(/uint256 internal constant RAIL_VIEW_GAS = 150_000;/);
    expect(src("adapters/CcipBittensorAdapter.sol")).toContain("uint256 public constant RAIL_READ_GAS = 30_000;");
    expect(src("libraries/CascadeFormulas.sol")).toContain("uint256 internal constant WRITE_OFF_READ_GAS = 45_000_000;");
    expect([WRITE_OFF_READ_GAS, ALPHA_READ_GAS]).toEqual([45_000_000n, 30_000n]);
    const honest = await verify();
    expect(honest.failures).toEqual([]);
    const asked = honest.calls.filter((c) => c.method === "eth_call").map((c) => c.params[0] as { to: string; data: Hex });
    const VIEW = toFunctionSelector("canSendPayouts()");
    // canSendPayouts() from the vault, with its 150,000 and what the call takes first (as the keeper reads it)
    expect(asked.filter((c) => c.data === VIEW)).toEqual([{ from: a.vault, to: a.bitAdapter, data: VIEW, gas: numberToHex(150_000n + intrinsic(VIEW)) }]);
    // each getter from the adapter, with its 30,000 and what the call takes first
    for (const fn of ["isPaused", "migrationReadyAt", "migrationFinished"] as const) {
      const data = encodeFunctionData({ abi: ALPHA, functionName: fn });
      expect(asked.filter((c) => c.data === data), fn).toEqual([{ from: a.bitAdapter, to: LANE_BIT.alphaVault, data, gas: numberToHex(30_000n + intrinsic(data)) }]);
    }
    // the write-off read priced for the vault's own coldkey on root (its cost doesn't depend on the caller)
    expect(honest.calls.filter((c) => c.method === "eth_estimateGas").map((c) => c.params[0])).toEqual([{ to: PRECOMPILE.staking, data: writeOffRead() }]);

    // the view: false is one word (payouts closed now: a ForeverMoney pause), a warning; the canary expects true
    const view = (v: Answer) => verify(answer(world(), "bittensor", a.bitAdapter, "canSendPayouts", v));
    const asVault = "Bittensor CcipBittensorAdapter.canSendPayouts(), asked as the vault asks it (from the vault, with the 150,000 gas it gives the view: RAIL_VIEW_GAS)";
    const closed = await view(false);
    expect(closed.failures).toEqual([]);
    expect(closed.warnings).toEqual([
      `${asVault}: false, so the vault reads its payouts closed and defers every door unstake (ForeverMoney's AlphaVault paused or migrating, or one of the adapter's reads of it failing: its line says which); the canary expects true`,
    ]);
    // a revert, Bittensor's EVM halting it, nothing, two words: the vault reads each as payouts open, a failure
    const open: [Answer, string][] = [
      [new RpcError("execution reverted", 3, "0x"), "reverts (execution reverted)"],
      [new RpcError("evm error: OutOfGas", -32603), "reverts (evm error: OutOfGas)"],
      [new RawAnswer("0x"), "answers nothing, not one word"],
      [new RawAnswer(`0x${"00".repeat(63)}01`), "answers 64 bytes, not one word"],
    ];
    for (const [v, says] of open) {
      expect((await view(v)).failures, says).toEqual([`${asVault}: ${says}; the vault reads that as payouts open, so door unstakes would be taken into a queue its rail may not pay`]);
    }
    // a node's own error: not read
    expect((await view(new RpcError("header not found", -32000))).failures).toEqual(["Bittensor CcipBittensorAdapter.canSendPayouts(): could not be read (header not found)"]);

    // ForeverMoney's getters: a missing selector, one over the 30,000, an answer short of a word: canSendPayouts false for good
    const asAdapter = (fn: string) => `Bittensor ForeverMoney's AlphaVault ${LANE_BIT.alphaVault}.${fn}(), asked as the Bittensor adapter asks it (from the adapter, with the 30,000 gas it gives each read: RAIL_READ_GAS)`;
    const short: [Answer, string][] = [
      [new RpcError("execution reverted", 3, "0x"), "reverts (execution reverted)"],
      [new RpcError("evm error: OutOfGas", -32603), "reverts (evm error: OutOfGas)"],
      [new RawAnswer("0x"), "answers nothing, short of a word"],
      [new RawAnswer("0x01"), "answers 1 byte, short of a word"],
    ];
    for (const fn of ["isPaused", "migrationReadyAt", "migrationFinished"]) {
      for (const [v, says] of short) {
        expect((await verify(answer(world(), "bittensor", LANE_BIT.alphaVault, fn, v))).failures, `${fn}: ${says}`).toEqual([
          `${asAdapter(fn)}: ${says}. The adapter takes that as payouts closed, so its canSendPayouts() would read false for good: the vault would defer every door unstake, its fee lost`,
        ]);
      }
    }
    expect((await verify(answer(world(), "bittensor", LANE_BIT.alphaVault, "isPaused", new RpcError("header not found", -32000)))).failures).toEqual([
      `Bittensor ForeverMoney's AlphaVault ${LANE_BIT.alphaVault}.isPaused(): could not be read (header not found)`,
    ]);
    // a paused one is reported as read (the view's own warning says what it does)
    expect((await verify(answer(world(), "bittensor", LANE_BIT.alphaVault, "isPaused", true))).info).toContain(
      `Bittensor ForeverMoney's AlphaVault ${LANE_BIT.alphaVault}: isPaused() true, migrationReadyAt() 0, migrationFinished() false, each one word within the 30,000 gas the Bittensor adapter gives each read (RAIL_READ_GAS)`,
    );
    // the adapter's alphaVault() unread: its getters are not asked
    const lost = await verify(answer(world(), "bittensor", a.bitAdapter, "alphaVault", new RpcError("header not found", -32000)));
    expect(lost.failures).toEqual(["Bittensor CcipBittensorAdapter.alphaVault(): could not be read (header not found)"]);

    // the write-off read: at the cap reported, over it a failure, refused a failure
    const priced = (e: bigint | Error) => {
      const w = world();
      w.estimate = e;
      return verify(w);
    };
    const what = "Bittensor: the write-off's read of the unlisted stake (the staking precompile's getTotalColdkeyStakeOnSubnet, the vault's coldkey on root)";
    const at = await priced(intrinsic(writeOffRead()) + 45_000_000n);
    expect(at.failures).toEqual([]);
    expect(at.info).toContain(canaryInfo(45_000_000n)[2]);
    expect((await priced(intrinsic(writeOffRead()) + 45_000_001n)).failures).toEqual([
      `${what} costs 45,000,001 gas by eth_estimateGas (less the ${intrinsic(writeOffRead()).toLocaleString("en-US")} a call takes first), over the vault's 45,000,000 cap (WRITE_OFF_READ_GAS): the vault's own read fails and reads 0, so a write-off would run with no bound`,
    ]);
    expect((await priced(new RpcError("execution reverted", 3, "0x"))).failures).toEqual([
      `${what} could not be priced (eth_estimateGas: execution reverted): should the vault's own read fail, it reads 0, and a write-off runs with no bound`,
    ]);
  });

  it("R12d (a nit): the write-off read is asked once by eth_call beside its estimate: anything but one word fails (an address with no precompile prices at 0 gas, and answers nothing)", async () => {
    const what = "Bittensor: the write-off's read of the unlisted stake (the staking precompile's getTotalColdkeyStakeOnSubnet, the vault's coldkey on root)";
    const honest = await verify();
    expect(honest.calls.filter((c) => c.method === "eth_call" && (c.params[0] as { data: Hex }).data === writeOffRead()).map((c) => c.params[0])).toEqual([{ to: PRECOMPILE.staking, data: writeOffRead() }]);
    expect(honest.info).toContain(canaryInfo()[2]);
    // no precompile there: the estimate prices only the call itself (0 gas of its own), and the call answers nothing
    const none = world();
    none.estimate = intrinsic(writeOffRead());
    answer(none, "bittensor", PRECOMPILE.staking, "getTotalColdkeyStakeOnSubnet", new RawAnswer("0x"));
    const r = await verify(none);
    expect(r.failures).toEqual([
      `${what} answers nothing by eth_call, not one word: no staking precompile answers there, so its price says nothing (a call to no code costs 0 gas of its own); the vault would read 0, and a write-off would run with no bound`,
    ]);
    expect(r.info.some((l) => l.startsWith(`${what} costs`))).toBe(false);
    // two words, a revert, a node's error
    const two = answer(world(), "bittensor", PRECOMPILE.staking, "getTotalColdkeyStakeOnSubnet", new RawAnswer(`0x${"00".repeat(63)}01`));
    expect((await verify(two)).failures).toEqual([
      `${what} answers 64 bytes by eth_call, not one word: no staking precompile answers there, so its price says nothing (a call to no code costs 0 gas of its own); the vault would read 0, and a write-off would run with no bound`,
    ]);
    const reverts = answer(world(), "bittensor", PRECOMPILE.staking, "getTotalColdkeyStakeOnSubnet", new RpcError("execution reverted", 3, "0x"));
    expect((await verify(reverts)).failures).toEqual([`${what} reverts by eth_call (execution reverted): the vault would read 0, and a write-off would run with no bound`]);
    const lost = answer(world(), "bittensor", PRECOMPILE.staking, "getTotalColdkeyStakeOnSubnet", new RpcError("header not found", -32000));
    expect((await verify(lost)).failures).toEqual([`${what} could not be read by eth_call (header not found)`]);
  });

  it("R12d (a nit): the payouts view and ForeverMoney's getters are asked of the vault's current primary bridge, named when it isn't the record's adapter; with the primary unread, of the record's adapter, said", async () => {
    const a = plan.addresses;
    const VIEW = toFunctionSelector("canSendPayouts()");
    const NEW = getAddress(`0x${"b7".repeat(20)}`);
    const w = world();
    const old = w.book.bittensor[a.bitAdapter.toLowerCase()];
    w.book.bittensor[NEW.toLowerCase()] = { abi: old.abi, answers: { ...old.answers } };
    answer(w, "bittensor", a.vaultLens, "primaryBridge", NEW);
    const r = await verify(w);
    const asked = r.calls.filter((c) => c.method === "eth_call").map((c) => c.params[0] as { to: string; data: Hex; from?: string });
    expect(asked.filter((c) => c.data === VIEW)).toEqual([{ from: a.vault, to: NEW, data: VIEW, gas: numberToHex(150_000n + intrinsic(VIEW)) }]);
    const isPaused = encodeFunctionData({ abi: ALPHA, functionName: "isPaused" });
    expect(asked.filter((c) => c.data === isPaused).map((c) => c.from)).toEqual([NEW]);
    expect(r.info).toContain(
      `Bittensor CcipBittensorAdapter.canSendPayouts() of the vault's primary bridge ${NEW} (not the record's adapter ${a.bitAdapter}): true, one word, asked as the vault asks it (from the vault, with the 150,000 gas it gives the view: RAIL_VIEW_GAS)`,
    );
    // the primary unread: the record's adapter is asked, and the line says so
    const lost = answer(world(), "bittensor", a.vaultLens, "primaryBridge", new RpcError("header not found", -32000));
    const u = await verify(lost);
    expect(u.info).toContain(
      `Bittensor CcipBittensorAdapter.canSendPayouts() of the record's adapter ${a.bitAdapter} (the vault's primaryBridge() could not be read): true, one word, asked as the vault asks it (from the vault, with the 150,000 gas it gives the view: RAIL_VIEW_GAS)`,
    );
    // the honest world: the primary is the record's adapter, said as before
    expect((await verify()).info).toContain(canaryInfo()[0]);
  });

  it("the treasury's redeem origin, unset, warns and never fails (the T18 ruling)", async () => {
    const r = await verify(answer(world(), "bittensor", plan.addresses.vaultLens, "redeemOrigin", 0n));
    expect(r.failures).toEqual([]);
    expect(r.warnings).toEqual([
      `Bittensor CascadeVaultLens.redeemOrigin(the treasury ${plan.roles.treasury}): expected DIRECT_ORIGIN, 18446744073709551615 (the treasury calls setRedeemOrigin(18446744073709551615) on the vault before the first reward cut), found 0`,
    ]);
  });

  it("the owner's kind on each chain: a delegated account counts as an account, a Safe with its threshold and signers", async () => {
    const w = world();
    const owner = plan.roles.owner.toLowerCase();
    // on Base an EIP-7702 delegated account; on Bittensor a Safe of 2 of 3
    w.codes.base[owner] = `0xef0100${"aa".repeat(20)}`;
    w.codes.bittensor[owner] = "0x6080604052";
    w.book.bittensor[owner] = { abi: OWNER_CONTRACT, answers: { getMinDelay: revert("InvalidParameter"), getThreshold: 2n, getOwners: [other, plan.roles.guardian, plan.roles.keeper] } };
    const r = await verify(w);
    expect(r.failures).toEqual([]);
    expect(r.info).toContain(`Base: the owner ${plan.roles.owner} is an account delegated to ${getAddress(`0x${"aa".repeat(20)}`)} by EIP-7702 (it counts as an account)`);
    expect(r.info).toContain(`Bittensor: the owner ${plan.roles.owner} is a Safe with a threshold of 2 and 3 signers`);
    expect(r.owners).toEqual({ base: { kind: "account", delegation: getAddress(`0x${"aa".repeat(20)}`) }, bittensor: { kind: "safe", threshold: 2n, owners: 3 } });
  });

  it("balances are reported, never failures; a pool below its floor warns; a validator with no root uid warns", async () => {
    const w = world();
    w.balances.bittensor[plan.addresses.payoutLib.toLowerCase()] = 10n ** 15n;
    answer(w, "base", plan.addresses.oracle, "meanLiquidity", [plan.poolFloors[0] - 1n, plan.poolFloors[1] * 3n]);
    delete w.storage[uidsKey(0, YUMA)];
    const r = await verify(w);
    expect(r.failures).toEqual([]);
    expect(r.info).toContain(`Bittensor CascadePayoutLib at ${plan.addresses.payoutLib} holds 0.001 TAO: information only (a library or a lens holds nothing by design; a forced balance changes nothing)`);
    expect(r.warnings).toEqual([
      `Base CascadeTwapOracle.meanLiquidity(): the TAO/WETH pool's ${plan.poolFloors[0] - 1n} is below the front door's floor ${plan.poolFloors[0]}: USDC deliveries are refused (ThinPool) until it deepens`,
      `Bittensor validator (the standby) ${encodeSs58(YUMA)} has no uid on the root network: check it is still a root validator before staking with it`,
    ]);
    // the WETH/USDC pool below its own floor (Task 46a's review, Minor 3), its floor the second
    const thin = await verify(answer(world(), "base", plan.addresses.oracle, "meanLiquidity", [plan.poolFloors[0] * 3n, plan.poolFloors[1] - 1n]));
    expect(thin.failures).toEqual([]);
    expect(thin.warnings).toEqual([
      `Base CascadeTwapOracle.meanLiquidity(): the WETH/USDC pool's ${plan.poolFloors[1] - 1n} is below the front door's floor ${plan.poolFloors[1]}: USDC deliveries are refused (ThinPool) until it deepens`,
    ]);
  });

  it("the code read-backs run first: a wrong lens fails there, and a void plan says so", async () => {
    const w = world();
    w.codes.base[plan.addresses.doorLens.toLowerCase()] = honestCode.vaultLens;
    const r = await verify(w);
    expect(r.failures).toEqual([expect.stringMatching(/^Base CascadeDoorLens: its runtime code is not the frozen build's, filled in from the plan: they first differ at byte \d+/)]);
    const rec = { ...record(), void: { at: "2026-11-07T00:00:00.000Z", reason: "a revert" } };
    expect((await verify(world(), rec)).failures).toEqual(["the record's plan is void (a revert): fresh keys and a new plan"]);
  });

  it("refused, nothing read but the chain ids, for another chain; and for a frozen build that is missing", async () => {
    const w = world();
    w.chainIds.base = 8453;
    const f = rpcOf(w);
    await expect(verifyV32(f.ctx, record(), { buildsDir })).rejects.toThrow("Base: the RPC reports chain id 8453, not 31337; nothing read");
    expect(f.calls.map((c) => c.method)).toEqual(["eth_chainId", "eth_chainId"]);
    const g = rpcOf(world());
    await expect(verifyV32(g.ctx, { ...record(), build: { dir: "v32-000000000000", hash: `0x${"00".repeat(32)}` } }, { buildsDir })).rejects.toThrow(/frozen build .* is missing/);
    expect(g.calls.map((c) => c.method)).toEqual(["eth_chainId", "eth_chainId"]);
  });

  it("verifyV32AndSave: the result saved into the record as it is on disk, never into another deployment's", async () => {
    const dir = tempDir("verify-save");
    const path = join(dir, "rehearsal-v3.2-launch.json");
    saveRecord(path, record());
    const logs: string[] = [];
    const f = rpcOf(world());
    const ctx = { ...f.ctx, live: false, log: (l: string) => logs.push(l) };
    expect(await verifyV32AndSave(ctx, path, { buildsDir })).toBe(true);
    const saved = loadRecord(path) as unknown as DeploymentRecordV32;
    expect(saved.verify?.ok).toBe(true);
    expect(saved.verify?.failures).toEqual([]);
    expect(logs.at(-1)).toBe("Read-back check: everything matches the plan");
    expect(logs[0].startsWith("For information:\n  Bittensor: the owner")).toBe(true);
    // a failure is saved and printed
    const bad = rpcOf(answer(world(), "bittensor", plan.addresses.vaultLens, "keeper", other));
    expect(await verifyV32AndSave({ ...bad.ctx, live: false, log: (l: string) => logs.push(l) }, path, { buildsDir })).toBe(false);
    expect((loadRecord(path) as unknown as DeploymentRecordV32).verify?.ok).toBe(false);
    expect(logs.at(-1)).toBe(
      `Read-back check FAILED:\n  The keeper: keeper() is ${other} on the vault (Bittensor) and ${plan.roles.keeper} on the front door (Base): one key must be keeper() on both (a rotation half done, runbook 2.6: the keeper Worker sends nothing until both calls have landed)`,
    );
    // the file replaced by another deployment while it read: nothing saved
    const swap = rpcOf(world());
    let once = true;
    const replacing: Rpc = {
      async request(chain, method, params) {
        if (once && method === "eth_getCode") {
          once = false;
          saveRecord(path, { ...record(), build: { ...ref, hash: `0x${"11".repeat(32)}` } });
        }
        return swap.rpc.request(chain, method, params);
      },
    };
    await expect(verifyV32AndSave({ rpc: replacing, targets: T, live: false, log: () => {} }, path, { buildsDir })).rejects.toThrow(/now holds another deployment; the read-back was not saved/);
    // no record, or a record of v3-launch's: refused
    await expect(verifyV32AndSave({ ...f.ctx, live: false, log: () => {} }, join(dir, "none.json"), { buildsDir })).rejects.toThrow(/no rehearsal v3.2 deployment record at/);
  });

  it("verify --validators parses for verify alone", () => {
    expect(parseArgs(["verify", "--validators", "--live"])).toEqual({ cmd: "verify", live: true, validators: true, users: [] });
    expect(() => parseArgs(["status", "--validators"])).toThrow(UsageError);
  });
});

// ---- Task 46b ----

const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");
/** A multi-line warning as verify lists it: its later lines indented under the first. */
const indented = (w: string) => w.split("\n").join("\n    ");
const NOW = 1_800_000_000_000;
const filesIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);
const readFile = (path: string) => parseWalletFile(JSON.parse(readFileSync(path, "utf8")));
/** The world on the live chains' ids, for the commands that write call files (the page sends on 964 and 8453 only). */
function liveWorld(p: PlanV32 = plan): World {
  const w = world(p);
  w.chainIds = { base: LIVE_T.base.chainId, bittensor: LIVE_T.bittensor.chainId };
  return w;
}
const liveRecord = (p: PlanV32 = plan): DeploymentRecordV32 => ({ ...record(p), target: "live" });
/** A plan deployed with caps above the founder level: a 50 TAO deposit cap and 100 TAO maxTotalAssets. */
function capsAbove(): PlanV32 {
  const p = structuredClone(plan);
  (step(p, "vault").args[0] as { maxTotalAssets: bigint }).maxTotalAssets = 100n * E18;
  (step(p, "frontDoor").args[0] as { depositCap: bigint }).depositCap = 50n * E18;
  return p;
}
/** The owner (or `who`), on both chains, a contract answering as given (a Safe, a timelock, or neither). */
function ownerContract(w: World, answers: Record<string, Answer>, code: Hex = "0x6080604052", who: Address = plan.roles.owner): World {
  const owner = who.toLowerCase();
  for (const chain of ["bittensor", "base"] as const) {
    w.codes[chain][owner] = code;
    w.book[chain][owner] = { abi: OWNER_CONTRACT, answers: { getMinDelay: revert("InvalidParameter"), getThreshold: revert("InvalidParameter"), getOwners: revert("InvalidParameter"), ...answers } };
  }
  return w;
}

describe("Task 46b: verify's pending items, the exits, the parks, the Safe warning and the retirement guards", () => {
  it("the exits state on both chains is reported: who holds them closed, and each clock", async () => {
    const w = world();
    const t1 = CREATED_AT + 600;
    const t2 = CREATED_AT + 1_200;
    // the vault paused by the guardian and its primary disabled by the owner; the front door's primary disabled by the
    // owner, and its deposits paused
    Object.assign(w.book.bittensor[plan.addresses.vaultLens.toLowerCase()].answers, { exitsOpen: false, pausedBy: 2, primaryDisabledBy: 1, lastOwnerClose: BigInt(t2), lastGuardianClose: BigInt(t1) });
    Object.assign(w.book.base[plan.addresses.doorLens.toLowerCase()].answers, { exitsOpen: false, primaryDisabledBy: 1, lastOwnerClose: BigInt(t2) });
    answer(w, "base", plan.addresses.frontDoor, "paused", true);
    const r = await verify(w);
    // the exits closed fail as 46a's read-backs, once each; the report says why, never failing again
    expect(r.failures).toEqual([line("Bittensor", "CascadeVaultLens", "exitsOpen()", true, false), line("Base", "CascadeDoorLens", "exitsOpen()", true, false)]);
    expect(r.info).toContain(
      `Bittensor CascadeVault: the exits are closed, held by the pause (the guardian's) and the primary bridge's disable (the owner's). The owner's last closure or stamp: ${iso(t2)}; the guardian's last closure: ${iso(t1)}.`,
    );
    expect(r.info).toContain(`Base CascadeFrontDoor: the exits are closed, held by the primary bridge's disable (the owner's); deposits are paused. The owner's last closure or stamp: ${iso(t2)}; the guardian's last closure: none.`);
    // the launch door's hold too
    const d = world();
    Object.assign(d.book.bittensor[plan.addresses.vaultLens.toLowerCase()].answers, { exitsOpen: false, launchDoorRemovedBy: 1 });
    expect((await verify(d)).info).toContain(
      "Bittensor CascadeVault: the exits are closed, held by the launch door's removal (the owner's). The owner's last closure or stamp: none; the guardian's last closure: none.",
    );
    // a hold that can't be read is a failure, never a silence
    const u = answer(world(), "bittensor", plan.addresses.vaultLens, "pausedBy", new RpcError("header not found", -32000));
    expect((await verify(u)).failures).toEqual(["Bittensor CascadeVault: its exits state could not be read (header not found)"]);
  });

  it("the park totals and the cushion are reported; a park or a reserve below half its target warns; less than the parks owe fails", async () => {
    const w = world();
    const a = plan.addresses.bitAdapter.toLowerCase();
    park(w, plan, keccak256(stringToBytes("park 1")), (3n * E18) / 100n, true, CREATED_BLOCK + 10);
    park(w, plan, keccak256(stringToBytes("park 2")), (2n * E18) / 100n, false, CREATED_BLOCK + 20);
    // the native reserve 1 wei under half its target (Phase 2a concern 1: the monitor's bridge.cushion_low line, as the
    // cushion's since merge 7b, M7); the booked cushion under half its own, the token balance exactly it and the token parks
    w.balances.bittensor[a] = 5n * 10n ** 14n - 1n + (3n * E18) / 100n;
    answer(w, "bittensor", plan.addresses.bitAdapter, "tokenCushion", 4n * 10n ** 14n);
    answer(w, "bittensor", BIT_TOKEN, "balanceOf", () => 4n * 10n ** 14n + (2n * E18) / 100n);
    const r = await verify(w);
    expect(r.failures).toEqual([]);
    expect(r.info).toContain("Bittensor CcipBittensorAdapter: its parks hold 0.03 TAO as native TAO (parkedNative) and 0.02 TAO as tokens (parkedTokens)");
    expect(r.info).toContain("Bittensor CcipBittensorAdapter: beyond its parks, its native reserve is 0.000499999999999999 TAO and its booked token cushion (tokenCushion) 0.0004 FM-TAO (the target of each is 0.001)");
    expect(r.warnings).toEqual([
      "Bittensor CcipBittensorAdapter: 0.03 TAO is parked as native TAO and 0.02 TAO as tokens: refused deliveries wait there to be delivered again (deliverParked) or, after 14 days, refunded (refundParked)",
      "Bittensor CcipBittensorAdapter: its native reserve is 0.000499999999999999 TAO, below half its 0.001 TAO target (0.0005 TAO): fund it with fundReserve() (for the live deployment, pnpm ops fund-reserve --from <0x…> --for-wallet --live writes it for the sign page)",
      "Bittensor CcipBittensorAdapter: its booked token cushion is 0.0004 FM-TAO, below half its 0.001 target: top it up with approve and fundCushion (for the live deployment, pnpm ops fund-cushion --from <0x…> --for-wallet --live writes both for the sign page)",
    ]);
    // a native reserve a few rao or wei under its target, but at or above half of it (each short conversion it covered,
    // up to 1 rao, logs nothing): no warning
    for (const reserve of [10n ** 15n - 1n, 10n ** 15n - 3n * 10n ** 9n, 5n * 10n ** 14n]) {
      const q = world();
      q.balances.bittensor[a] = reserve;
      expect((await verify(q)).warnings, String(reserve)).toEqual([]);
    }
    // under the 1 rao a delivery's conversion can come out short (the adapter's SHORTFALL_TOLERANCE_WEI), empty included:
    // it covers no short conversion, so such a delivery parks as tokens (ConversionShort) and can't be delivered again;
    // a failure, as a booked cushion under 1 rao is (the review of 9f4c10f); from 1 rao up, the warning below half
    const reserveOf = async (reserve: bigint) => {
      const q = world();
      q.balances.bittensor[a] = reserve;
      return verify(q);
    };
    const tooLow = (tao: string) =>
      `Bittensor CcipBittensorAdapter: its native reserve (beyond its native parks) is ${tao} TAO, less than the 1 rao a delivery's conversion can come out short (SHORTFALL_TOLERANCE_WEI): a delivery whose conversion comes out 1 rao short parks as tokens (ConversionShort), and deliverParked can't deliver it, until the reserve is funded. Fund it with fundReserve() (for the live deployment, pnpm ops fund-reserve --from <0x…> --for-wallet --live writes it for the sign page)`;
    expect(await reserveOf(0n)).toMatchObject({ failures: [tooLow("0")], warnings: [] });
    expect(await reserveOf(10n ** 9n - 1n)).toMatchObject({ failures: [tooLow("0.000000000999999999")], warnings: [] });
    expect(await reserveOf(10n ** 9n)).toMatchObject({
      failures: [],
      warnings: [
        "Bittensor CcipBittensorAdapter: its native reserve is 0.000000001 TAO, below half its 0.001 TAO target (0.0005 TAO): fund it with fundReserve() (for the live deployment, pnpm ops fund-reserve --from <0x…> --for-wallet --live writes it for the sign page)",
      ],
    });
    // a booked cushion a few rao under its target, but at or above half of it (the shortfalls it covered): no warning
    for (const booked of [10n ** 15n - 3n * 10n ** 9n, 5n * 10n ** 14n]) {
      const q = answer(answer(world(), "bittensor", plan.addresses.bitAdapter, "tokenCushion", booked), "bittensor", BIT_TOKEN, "balanceOf", () => booked);
      expect((await verify(q)).warnings, String(booked)).toEqual([]);
    }
    // holding less than its parks owe (I-7), or than its token parks and its booked cushion together, is a failure
    w.balances.bittensor[a] = E18 / 100n;
    answer(w, "bittensor", BIT_TOKEN, "balanceOf", () => E18 / 100n);
    const short = await verify(w);
    expect(short.failures).toEqual([
      "Bittensor CcipBittensorAdapter holds 0.01 TAO, less than its native parks owe (0.03 TAO): it can't pay them all",
      "Bittensor CcipBittensorAdapter holds 0.01 FM-TAO, less than its token parks (0.02 TAO) and its booked cushion (0.0004 FM-TAO) together: it can't cover them all",
    ]);
    // enough for the token parks but a wei short of the booked cushion beside them: a failure too
    answer(w, "bittensor", BIT_TOKEN, "balanceOf", () => (2n * E18) / 100n + 4n * 10n ** 14n - 1n);
    expect((await verify(w)).failures).toContain(
      "Bittensor CcipBittensorAdapter holds 0.020399999999999999 FM-TAO, less than its token parks (0.02 TAO) and its booked cushion (0.0004 FM-TAO) together: it can't cover them all",
    );
    // a read that fails is a failure
    const u = answer(world(), "bittensor", plan.addresses.bitAdapter, "parkedNative", new RpcError("header not found", -32000));
    expect((await verify(u)).failures).toEqual(["Bittensor CcipBittensorAdapter: its parks and reserves could not be read (header not found)"]);
    const v = answer(world(), "bittensor", plan.addresses.bitAdapter, "tokenCushion", new RpcError("header not found", -32000));
    expect((await verify(v)).failures).toEqual(["Bittensor CcipBittensorAdapter: its parks and reserves could not be read (header not found)"]);
  });

  it("R4 (F-1): the cushion is what fundCushion booked (tokenCushion), never the balance less the parks: a plain transfer fails, and any surplus is said sweepable", async () => {
    // the cushion sent by a plain transfer: the balance holds it, the books don't, and anyone's sweepSurplus() takes it
    const plain = answer(world(), "bittensor", plan.addresses.bitAdapter, "tokenCushion", 0n);
    const r = await verify(plain);
    expect(r.failures).toEqual([
      "Bittensor CcipBittensorAdapter: its token cushion is not funded (tokenCushion() is 0): a payout or a converted refund whose mint comes out 1 rao short reverts ConversionShort until it is. Fund it with approve and fundCushion (for the live deployment, pnpm ops fund-cushion --from <0x…> --for-wallet --live writes both for the sign page). A plain transfer is not the cushion: anyone's sweepSurplus() sends it to the treasury",
    ]);
    expect(r.warnings).toEqual([
      "Bittensor CcipBittensorAdapter holds 0.001 FM-TAO beyond its token parks and its booked cushion: surplus, not the cushion (said from 1,000 rao up: a plain transfer, or many mints' rounding); anyone's sweepSurplus() sends it to the treasury",
    ]);
    expect(r.info).toContain("Bittensor CcipBittensorAdapter: beyond its parks, its native reserve is 0.001 TAO and its booked token cushion (tokenCushion) 0 FM-TAO (the target of each is 0.001)");
    // merge 7b (M7): booked, with surplus beside it under 1,000 rao (a mint's rounding in the adapter's favour, a rao or
    // so each): passes, unsaid; from 1,000 rao up it is said
    const beside = (surplus: bigint) => answer(world(), "bittensor", BIT_TOKEN, "balanceOf", (args: readonly unknown[]) => (sameText(args[0], plan.addresses.bitAdapter) ? 10n ** 15n + surplus : 0n));
    for (const surplus of [7n, 1_000n * 10n ** 9n - 1n]) expect(await verify(beside(surplus)), String(surplus)).toMatchObject({ failures: [], warnings: [] });
    const x = await verify(beside(1_000n * 10n ** 9n));
    expect(x.failures).toEqual([]);
    expect(x.warnings).toEqual([
      "Bittensor CcipBittensorAdapter holds 0.000001 FM-TAO beyond its token parks and its booked cushion: surplus, not the cushion (said from 1,000 rao up: a plain transfer, or many mints' rounding); anyone's sweepSurplus() sends it to the treasury",
    ]);
    // booked above its target: no warning (the sweep leaves the booked cushion, whatever it is)
    const above = answer(answer(world(), "bittensor", plan.addresses.bitAdapter, "tokenCushion", 2n * 10n ** 15n), "bittensor", BIT_TOKEN, "balanceOf", () => 2n * 10n ** 15n);
    const y = await verify(above);
    expect([y.failures, y.warnings]).toEqual([[], []]);
  });

  it("merge 7b (M3): a booked cushion under 1 rao (the adapter's SHORTFALL_TOLERANCE_WEI) covers no short mint, so it fails as an empty one does; 1 rao passes, below half its target", async () => {
    const booked = (n: bigint) => answer(answer(world(), "bittensor", plan.addresses.bitAdapter, "tokenCushion", n), "bittensor", BIT_TOKEN, "balanceOf", () => n);
    const under = await verify(booked(10n ** 9n - 1n));
    expect(under.failures).toEqual([
      "Bittensor CcipBittensorAdapter: its booked token cushion (tokenCushion()) is 0.000000000999999999 FM-TAO, less than the 1 rao a mint can come out short (SHORTFALL_TOLERANCE_WEI): a payout or a converted refund whose mint comes out 1 rao short reverts ConversionShort until it is topped up. Top it up with approve and fundCushion (for the live deployment, pnpm ops fund-cushion --from <0x…> --for-wallet --live writes both for the sign page)",
    ]);
    const one = await verify(booked(10n ** 9n));
    expect(one.failures).toEqual([]);
    expect(one.warnings).toEqual([
      "Bittensor CcipBittensorAdapter: its booked token cushion is 0.000000001 FM-TAO, below half its 0.001 target: top it up with approve and fundCushion (for the live deployment, pnpm ops fund-cushion --from <0x…> --for-wallet --live writes both for the sign page)",
    ]);
    // the tolerance is the adapter's own constant, and ops' FUNDING_V32 carries it
    expect(FUNDING_V32.shortfallTolerance).toBe(10n ** 9n);
    expect(readFileSync(join(CONTRACTS, "src/adapters/CcipBittensorAdapter.sol"), "utf8")).toContain("uint256 public constant SHORTFALL_TOLERANCE_WEI = 1e9;");
  });

  it("the scheduler's pending items, chain by chain: an id pending on both is listed on each, one the lens can't judge warns, a failed log scan fails", async () => {
    const w = world();
    const at = HEAD_AT - 1_800;
    const a = put(w, plan, "vault", "setPayoutDelay", [43_200n], at);
    // one calldata on both schedulers: one id, listed on each chain
    const g = put(w, plan, "vault", "setGuardian", [another], at);
    expect(put(w, plan, "frontDoor", "setGuardian", [another], at).id).toBe(g.id);
    const r = await verify(w);
    expect(r.failures).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.info.filter((l) => l.includes("'s scheduler: "))).toEqual([
      expect.stringContaining("Bittensor CascadeVault's scheduler: its 15 schedulable functions"),
      expect.stringContaining("Base CascadeFrontDoor's scheduler: its 9 schedulable functions"),
      `Bittensor CascadeVault's scheduler: item ${a.id}, setPayoutDelay(43200) (Param, Ordinary): waiting: ready at ${iso(at + DELAYS[0])}`,
      `Bittensor CascadeVault's scheduler: item ${g.id}, setGuardian(${another}) (Guardian, GuardianSwap): waiting: ready at ${iso(at + DELAYS[2])}`,
      `Base CascadeFrontDoor's scheduler: item ${g.id}, setGuardian(${another}) (Guardian, GuardianSwap): waiting: ready at ${iso(at + DELAYS[2])}`,
    ]);
    // the lens can't read one item: it is not "not pending", it warns
    const items = w.items.vault;
    answer(w, "bittensor", plan.addresses.vaultLens, "scheduled", (args: readonly unknown[]) => (sameText(args[0], a.id) ? new RpcError("header not found", -32000) : (items.get(String(args[0]).toLowerCase()) ?? EMPTY_ITEM)));
    const u = await verify(w);
    expect(u.failures).toEqual([]);
    expect(u.warnings).toEqual([`Bittensor CascadeVault's scheduler: item ${a.id}, setPayoutDelay(43200) (Ordinary): unknown: the lens could not read it (header not found): check it with pnpm ops pending`]);
    // a log scan that fails: its items are not known, a failure; the other chain is still listed
    const f = world();
    put(f, plan, "vault", "setPayoutDelay", [43_200n], at);
    f.logsFail = "base";
    const s = await verify(f);
    expect(s.failures).toEqual(["Base CascadeFrontDoor's scheduler: its pending items could not be read (query timeout exceeded)"]);
    expect(s.info.some((l) => l.startsWith(`Bittensor CascadeVault's scheduler: item ${a.id}`))).toBe(true);
  });

  it("warnsNeverRefusesAboveFounderLevelWithoutASafe: caps above the founder level, read now or pending, warn quoting section 5, and fail nothing", async () => {
    // a deployment whose caps are above the founder level, as planned: every read-back passes, and each cap warns with
    // its own chain's owner
    const p = capsAbove();
    const r = await verify(world(p, codesOf(p)), record(p));
    expect(r.failures).toEqual([]);
    expect(r.warnings).toEqual([`Base: ${indented(capsWarning({ depositCap: 50n * E18 }, { kind: "account" })!)}`, `Bittensor: ${indented(capsWarning({ maxTotalAssets: 100n * E18 }, { kind: "account" })!)}`]);
    expect(r.warnings[0]).toContain("WARNING: a deposit cap of 50 TAO (the founder level is 40) is above the founder level, and the owner is a plain account, not a Safe with at least 2 of 3 signers.");
    expect(r.warnings[1]).toContain('Spec section 5: "Until the Safe, one Ledger owns every contract on both chains and its second account is the guardian, so a copied seed copies both and the guardian is no check on the owner."');
    expect(r.warnings[1]).toContain("This is a warning: nothing is refused.");
    // at the founder level, nothing (the honest deployment's caps are the founder level itself)
    expect((await verify()).warnings).toEqual([]);
    // a pending item that raises maxTotalAssets above the founder level warns too; one at the level does not
    const w = world();
    const up = put(w, plan, "vault", "setMaxTotalAssets", [100n * E18], HEAD_AT - 600);
    put(w, plan, "vault", "setMaxTotalAssets", [44n * E18], HEAD_AT - 300);
    const q = await verify(w);
    expect(q.failures).toEqual([]);
    expect(q.warnings).toEqual([`Bittensor CascadeVault's scheduler, item ${up.id}, setMaxTotalAssets(100000000000000000000): ${indented(capsWarning({ maxTotalAssets: 100n * E18 }, { kind: "account" })!)}`]);
    // past its window in time but not in blocks (its blocks came slowly): it can still run, so it still warns (Revision 28's
    // lapse needs both; this world's vault is too young for an item past both)
    w.items.vault.get(up.id)!.readyAt = BigInt(HEAD_AT - 8 * 86_400);
    expect((await verify(w)).warnings).toEqual(q.warnings);
    // a 2-of-3 Safe owning both: nothing warns
    const safe = await verify(ownerContract(world(p, codesOf(p)), { getThreshold: 2n, getOwners: [other, another, plan.roles.keeper] }), record(p));
    expect(safe.failures).toEqual([]);
    expect(safe.warnings).toEqual([]);
    // a Safe of 1, or of 2 signers, is not enough
    const one = await verify(ownerContract(world(p, codesOf(p)), { getThreshold: 1n, getOwners: [other, another, plan.roles.keeper] }), record(p));
    expect(one.warnings[1]).toContain("the owner is a Safe with a threshold of 1 and 3 signers, not a Safe with at least 2 of 3 signers");
    // a contract that is not a Safe is said so
    const contract = await verify(ownerContract(world(p, codesOf(p)), {}), record(p));
    expect(contract.failures).toEqual([]);
    expect(contract.warnings[0]).toContain("the owner is a contract that is not a Safe, not a Safe with at least 2 of 3 signers");
    // an owner whose kind can't be read: the read fails (46a's), and the cap still warns, saying so
    const unread = world(p, codesOf(p));
    unread.codes.bittensor[plan.roles.owner.toLowerCase()] = "0x6080604052";
    unread.book.bittensor[plan.roles.owner.toLowerCase()] = { abi: OWNER_CONTRACT, answers: { getMinDelay: revert("InvalidParameter"), getThreshold: 2n, getOwners: new RpcError("header not found", -32000) } };
    const k = await verify(unread, record(p));
    expect(k.failures).toEqual([`Bittensor: the owner ${plan.roles.owner}'s kind could not be read (header not found)`]);
    expect(k.warnings[1]).toContain("the owner is of a kind that could not be read, not a Safe with at least 2 of 3 signers");
    // each cap with its own chain's owner: Base's is a plain account
    expect(k.warnings[0]).toContain("the owner is a plain account");
  });

  it("delegatedEoaCountsAsAnAccount: an owner delegated by EIP-7702 is an account, so caps above the founder level warn", async () => {
    const p = capsAbove();
    const w = world(p, codesOf(p));
    const delegate = getAddress(`0x${"aa".repeat(20)}`);
    for (const chain of ["bittensor", "base"] as const) w.codes[chain][plan.roles.owner.toLowerCase()] = `0xef0100${"aa".repeat(20)}`;
    const r = await verify(w, record(p));
    expect(r.failures).toEqual([]);
    expect(r.owners).toEqual({ bittensor: { kind: "account", delegation: delegate }, base: { kind: "account", delegation: delegate } });
    expect(r.warnings).toHaveLength(2);
    for (const warning of r.warnings) expect(warning).toContain(`the owner is an account delegated to ${delegate} by EIP-7702 (it counts as an account), not a Safe with at least 2 of 3 signers`);
  });

  it("retireRefusedWhileParked: the pair's retirement file is refused, with the amounts, while the Bittensor adapter holds a park; a failed read refuses", async () => {
    const dir = tempDir("retire-pair");
    const run = (w: World, as: "owner" | "guardian") => retirePairCommand(rpcOf(w).ctx, liveRecord(), { dir, name: "v3.2-launch", now: NOW, buildsDir, as });
    // a native park
    const w = liveWorld();
    park(w, plan, keccak256(stringToBytes("park 1")), (3n * E18) / 100n, true, CREATED_BLOCK + 10);
    await expect(run(w, "guardian")).rejects.toThrow(
      `the adapter pair can't be retired yet: the Bittensor adapter ${plan.addresses.bitAdapter} still holds parks, 0.03 TAO as native TAO (parkedNative) and 0 TAO as tokens (parkedTokens). Each park must be delivered (deliverParked) or, after 14 days, refunded (refundParked) first; nothing written`,
    );
    // a token park
    const t = liveWorld();
    park(t, plan, keccak256(stringToBytes("park 2")), (2n * E18) / 100n, false, CREATED_BLOCK + 20);
    await expect(run(t, "owner")).rejects.toThrow("0 TAO as native TAO (parkedNative) and 0.02 TAO as tokens (parkedTokens)");
    // an empty park (a redeem-only batch) owes nothing: the totals decide, as the ops rule says
    // the totals unread: it can't confirm, and writes nothing
    const u = answer(liveWorld(), "bittensor", plan.addresses.bitAdapter, "parkedTokens", new RpcError("header not found", -32000));
    await expect(run(u, "owner")).rejects.toThrow("Can't confirm it's safe right now: the Bittensor adapter's parks (parkedNative, parkedTokens) could not be read (header not found); try again; nothing written");
    expect(filesIn(dir)).toEqual([]);
    // no park: one file, both chains' disableBridge, each from that chain's guardian, asked first by eth_call
    const ok = liveWorld();
    const f = rpcOf(ok);
    const r = await retirePairCommand(f.ctx, liveRecord(), { dir, name: "v3.2-launch", now: NOW, buildsDir, as: "guardian" });
    expect(r.ok).toBe(true);
    const a = plan.addresses;
    const g = plan.roles.guardian;
    // the front door's call first (review, M2): a batch it closes before the vault's is signed lands while the vault still takes it
    expect(r.lines).toEqual([
      `Base front door ${a.frontDoor}: disableBridge(${a.baseAdapter}) from the guardian ${g} would succeed now.`,
      "  It is the front door's primary bridge: disabling it closes the exits on Base and stamps the guardian's clock, until the owner makes another enabled bridge the primary (setPrimaryBridge).",
      `Bittensor vault ${a.vault}: disableBridge(${a.bitAdapter}) from the guardian ${g} would succeed now.`,
      "  It is the vault's primary bridge: disabling it closes the exits on Bittensor and stamps the guardian's clock, until the owner makes another enabled bridge the primary (setPrimaryBridge).",
      `The Bittensor adapter holds no park (parkedNative and parkedTokens are 0, at Bittensor block ${HEADS.bittensor}). The file holds both calls: sign the front door's first, and the vault's once the Base adapter's last sends have landed.`,
      `Wrote ${r.files[0]} (2 calls): send them from MetaMask with: pnpm ops sign ${r.files[0]}`,
    ]);
    const file = readFile(r.files[0]);
    expect(file.deployment).toBe("v3.2-launch");
    expect(file.title).toBe("Cascade v3.2-launch: retire the adapter pair (disableBridge on both chains): sign both calls");
    expect(file.calls).toEqual([
      { chainId: 8_453, to: a.frontDoor, data: encodeFunctionData({ abi: abiOf("CascadeFrontDoor"), functionName: "disableBridge", args: [a.baseAdapter] }), value: "0", label: `disableBridge(${a.baseAdapter}) on the front door (Base): retires the adapter pair`, from: g },
      { chainId: 964, to: a.vault, data: encodeFunctionData({ abi: build.vaultAbi, functionName: "disableBridge", args: [a.bitAdapter] }), value: "0", label: `disableBridge(${a.bitAdapter}) on the vault (Bittensor): retires the adapter pair`, from: g },
    ]);
    // the totals read at one block, the head (review, I2)
    const totals = [toFunctionSelector("parkedNative()"), toFunctionSelector("parkedTokens()")];
    expect(f.calls.filter((c) => c.method === "eth_call" && totals.includes((c.params[0] as { data: Hex }).data)).map((c) => c.params[1])).toEqual([numberToHex(HEADS.bittensor), numberToHex(HEADS.bittensor)]);
    // each call asked of its contract by eth_call from its sender before the file was written
    const asked = f.calls.filter((c) => c.method === "eth_call" && (c.params[0] as { data: Hex }).data.startsWith(toFunctionSelector("disableBridge(address)")));
    expect(asked.map((c) => [c.chain, (c.params[0] as { from: string }).from])).toEqual([
      ["base", g],
      ["bittensor", g],
    ]);
    // a call the contract would refuse is not written
    const off = answer(liveWorld(), "base", a.frontDoor, "disableBridge", revert("BridgeNotEnabled"));
    await expect(run(off, "owner")).rejects.toThrow(`disableBridge(${a.baseAdapter}) on the front door (Base) from the owner ${plan.roles.owner} would revert: BridgeNotEnabled(); nothing written`);
    expect(filesIn(dir)).toHaveLength(1);
  });

  it("doorRemovalRefusedWithPendingBatches: a door's removal file is refused while the vault holds a payout batch of it, carried bounces included, or a park from it is outstanding", async () => {
    const dir = tempDir("remove-door");
    const door = plan.addresses.frontDoor;
    const run = (w: World, as: "owner" | "guardian", o: { chain?: bigint; door?: Address } = {}) =>
      removeDoorCommand(rpcOf(w).ctx, liveRecord(), { dir, name: "v3.2-launch", now: NOW, buildsDir, chain: o.chain ?? 8_453n, door: o.door ?? door, as });
    const k1 = keccak256(stringToBytes("batch 1"));
    // a batch with entries left
    const w = liveWorld();
    queue(w, plan, k1, { count: 3, cursor: 1, remaining: (2n * E18) / 100n }, CREATED_BLOCK + 50);
    await expect(run(w, "guardian")).rejects.toThrow(
      `front door ${door} on chain 8453 can't be removed yet: it has 1 payout batch queued on the vault, ${k1} (2 of 3 entries left, 0.02 TAO): each is paid first (processPayouts), carried bounces included; nothing written`,
    );
    // a batch a cancel left with its bounces (the T22 carry): pending too
    const c = liveWorld();
    queue(c, plan, k1, { count: 2, cursor: 0, remaining: E18 / 100n }, CREATED_BLOCK + 50);
    emit(c, "bittensor", plan.addresses.vault, build.vaultAbi, "PayoutBatchCancelled", { key: k1, reminted: E18 / 100n, bouncesCarried: 2 }, CREATED_BLOCK + 60);
    await expect(run(c, "owner")).rejects.toThrow(`it has 1 payout batch queued on the vault, ${k1} (2 of 2 entries left, 0.01 TAO)`);
    // a park from the door, with a batch: both reasons, in one refusal
    const kp = keccak256(stringToBytes("park 1"));
    park(c, plan, kp, (3n * E18) / 100n, false, CREATED_BLOCK + 70);
    await expect(run(c, "guardian")).rejects.toThrow(
      `front door ${door} on chain 8453 can't be removed yet: it has 1 payout batch queued on the vault, ${k1} (2 of 2 entries left, 0.01 TAO): each is paid first (processPayouts), carried bounces included; and it has 1 park outstanding in the Bittensor adapter, ${kp} (0.03 TAO as tokens, parked ${iso(timeOf("bittensor", CREATED_BLOCK + 70))}): each is delivered (deliverParked), or after 14 days refunded (refundParked) or dropped (dropParked), first; nothing written`,
    );
    // an empty park from the door (a redeem-only batch, amount 0) blocks it too, though the totals can't see it (review, M1)
    const e = liveWorld();
    const ke = keccak256(stringToBytes("empty park"));
    park(e, plan, ke, 0n, true, CREATED_BLOCK + 80);
    await expect(run(e, "guardian")).rejects.toThrow(
      `front door ${door} on chain 8453 can't be removed yet: it has 1 park outstanding in the Bittensor adapter, ${ke} (0 TAO as native TAO, parked ${iso(timeOf("bittensor", CREATED_BLOCK + 80))}): each is delivered (deliverParked), or after 14 days refunded (refundParked) or dropped (dropParked), first; nothing written`,
    );
    // another door's batch and park are not this door's (though they count in the totals): the removal is written
    const o = liveWorld();
    queue(o, plan, k1, { count: 1, remaining: E18 / 100n }, CREATED_BLOCK + 50, other);
    park(o, plan, kp, E18 / 100n, true, CREATED_BLOCK + 70, other);
    expect((await run(o, "guardian")).ok).toBe(true);
    // the logs read short: the batches found don't add up to the vault's pending payouts; nor the parks to the totals
    const s = liveWorld();
    answer(s, "bittensor", plan.addresses.vaultLens, "pendingPayouts", E18 / 100n);
    await expect(run(s, "owner")).rejects.toThrow(
      "Can't confirm it's safe right now: the payout batches read from the vault's logs hold 0 TAO, not the 0.01 TAO of pendingPayouts(): the logs read short; try again; nothing written",
    );
    const sp = answer(liveWorld(), "bittensor", plan.addresses.bitAdapter, "parkedNative", E18 / 100n);
    await expect(run(sp, "owner")).rejects.toThrow(
      "Can't confirm it's safe right now: the parks read from the Bittensor adapter's logs hold 0 TAO as native TAO and 0 TAO as tokens, not its parkedNative (0.01 TAO) and parkedTokens (0 TAO): the logs read short; try again; nothing written",
    );
    // a log scan that fails, and a re-read that fails
    const lf = liveWorld();
    lf.logsFail = "bittensor";
    await expect(run(lf, "owner")).rejects.toThrow("Can't confirm it's safe right now: the vault's logs (its payout batches and bridges) could not be read (query timeout exceeded); try again; nothing written");
    const rf = liveWorld();
    queue(rf, plan, k1, { count: 1, remaining: E18 / 100n }, CREATED_BLOCK + 50);
    answer(rf, "bittensor", plan.addresses.vaultLens, "getPayoutBatch", new RpcError("header not found", -32000));
    await expect(run(rf, "owner")).rejects.toThrow("Can't confirm it's safe right now: the vault's payout batches could not be read (header not found); try again; nothing written");
    const pf = liveWorld();
    park(pf, plan, kp, E18 / 100n, true, CREATED_BLOCK + 70, other);
    answer(pf, "bittensor", plan.addresses.bitAdapter, "parked", new RpcError("header not found", -32000));
    await expect(run(pf, "owner")).rejects.toThrow("Can't confirm it's safe right now: the Bittensor adapter's parks could not be read (header not found); try again; nothing written");
    // a door on a chain the record's adapter pair doesn't serve: its parks can't be read from here
    await expect(run(liveWorld(), "guardian", { chain: 10n })).rejects.toThrow(
      `Can't confirm it's safe: remove-door serves only doors on chain 8453, the one ops' RPCs and this deployment's Bittensor adapter ${plan.addresses.bitAdapter} reach, not chain 10; nothing written`,
    );
    // a door that is not active: the vault's own answer
    await expect(run(liveWorld(), "guardian", { door: other })).rejects.toThrow(`the vault has no active front door ${other} on chain 8453 (PeerNotActive()): nothing to remove; nothing written`);
    expect(filesIn(dir)).toHaveLength(1);
    // nothing queued and nothing parked, the door paused with nothing open: the owner's file, warning that an owner's
    // removal stays Reopen-able
    const ok = answer(liveWorld(), "base", door, "paused", true);
    const r = await run(ok, "owner");
    const vault = plan.addresses.vault;
    expect(r.lines).toEqual([
      `Bittensor vault ${vault}: removeFrontDoor(8453, ${door}) from the owner ${plan.roles.owner} would succeed now. No payout batch is queued for the door, and no park is outstanding from it, as of Bittensor block ${HEADS.bittensor}.`,
      "  It is the launch chain's last active door: removing it closes the exits and stamps the owner's clock.",
      "  WARNING — the owner's removal leaves the door Removed: the door then stays Reopen-able by the owner alone, without the guardian's veto. A removal meant to last is the guardian's.",
      `  Ops reads parks only in the vault's one bridge, ${plan.addresses.bitAdapter}: a door that sends through an adapter the vault never enabled would park there unseen.`,
      `Wrote ${r.files[0]} (1 call): send them from MetaMask with: pnpm ops sign ${r.files[0]}`,
    ]);
    const file = readFile(r.files[0]);
    expect(file.title).toBe(`Cascade v3.2-launch: remove front door ${door} (chain 8453) from the vault`);
    expect(file.calls).toEqual([
      { chainId: 964, to: vault, data: encodeFunctionData({ abi: build.vaultAbi, functionName: "removeFrontDoor", args: [8_453n, door] }), value: "0", label: `removeFrontDoor(8453, ${door}) on the vault (Bittensor)`, from: plan.roles.owner },
    ]);
    // the guardian's: no such warning
    const gr = await run(answer(liveWorld(), "base", door, "paused", true), "guardian");
    expect(gr.lines.join("\n")).not.toContain("WARNING");
    expect(readFile(gr.files[0]).calls[0].from).toBe(plan.roles.guardian);
  });

  // ---- fix round 1 ----

  /** The refusal on a log server that kept no history (the review's I3): the constructor's activation isn't there. */
  const noHistory = () =>
    `this RPC doesn't keep history; use an archive node (archive.chain.opentensor.ai is the known one): its logs show no BridgeActivated(${plan.addresses.bitAdapter}) in block ${CREATED_BLOCK}, which the vault's constructor logged`;

  it("remove-door reads every bridge the vault enabled, and refuses a history without its constructor's (review, C1 and I3)", async () => {
    const dir = tempDir("remove-door-bridges");
    const door = plan.addresses.frontDoor;
    const run = (w: World) => removeDoorCommand(rpcOf(w).ctx, liveRecord(), { dir, name: "v3.2-launch", now: NOW, buildsDir, chain: 8_453n, door, as: "guardian" });
    // a second adapter the vault enabled (a pair migration, or a second door's own pair) whose parks can't be read: it
    // refuses, naming it (Task 49's review, M8: every bridge's park totals are read); with no code there, trying again
    // can't help, so it says so (the re-review's N3)
    const w = liveWorld();
    emit(w, "bittensor", plan.addresses.vault, build.vaultAbi, "BridgeActivated", { bridge: another }, CREATED_BLOCK + 100);
    await expect(run(w)).rejects.toThrow(
      `Can't confirm it's safe: the bridge ${another}, which the vault enabled, holds no adapter code (no contract there on Bittensor), so its parks can't be read; nothing written`,
    );
    // the record's adapter enabled again later is still the one bridge
    const again = liveWorld();
    emit(again, "bittensor", plan.addresses.vault, build.vaultAbi, "BridgeActivated", { bridge: plan.addresses.bitAdapter }, CREATED_BLOCK + 100);
    expect((await run(answer(again, "base", door, "paused", true))).ok).toBe(true);
    // a primary bridge the logs never show the vault enabling: logs with a gap, so refused too (the re-review's N1); the
    // refusal points to what helps, one archive node (Task 49's review, M8)
    const gap = answer(liveWorld(), "bittensor", plan.addresses.vaultLens, "primaryBridge", another);
    await expect(run(gap)).rejects.toThrow(
      `Can't confirm it's safe: the vault's primary bridge is ${another}, but its logs never show the vault enabling it (they may have gaps): read them from one archive node (archive.chain.opentensor.ai) and try again; nothing written`,
    );
    // the constructor's activation missing from the history: the server dropped it, so nothing it answers is trusted
    const m = liveWorld();
    m.logs.bittensor = [];
    await expect(run(m)).rejects.toMatchObject({ message: noHistory() });
    // a node that prunes (a lite node keeps minutes): the same refusal, never "nothing queued"
    const pr = liveWorld();
    queue(pr, plan, keccak256(stringToBytes("old batch")), { count: 1, remaining: E18 / 100n }, CREATED_BLOCK + 50);
    pr.prunedBefore = { bittensor: HEADS.bittensor - 10 };
    await expect(run(pr)).rejects.toMatchObject({ message: noHistory() });
    expect(filesIn(dir)).toHaveLength(1);
  });

  it("remove-door reads the park totals of every bridge the vault enabled: one at zero passes, one holding parks or unreadable refuses, naming it (Task 49's review, M8)", async () => {
    const dir = tempDir("remove-door-every-bridge");
    const door = plan.addresses.frontDoor;
    const run = (w: World) => removeDoorCommand(rpcOf(w).ctx, liveRecord(), { dir, name: "v3.2-launch", now: NOW, buildsDir, chain: 8_453n, door, as: "guardian" });
    /** A world where the vault also enabled `another`, an adapter whose park totals answer `totals`. */
    const second = (totals: { parkedNative: unknown; parkedTokens: unknown }) => {
      const w = answer(liveWorld(), "base", door, "paused", true);
      emit(w, "bittensor", plan.addresses.vault, build.vaultAbi, "BridgeActivated", { bridge: another }, CREATED_BLOCK + 100);
      w.book.bittensor[another.toLowerCase()] = { abi: abiOf("CcipBittensorAdapter"), answers: totals };
      // an adapter has code (a read of it that fails is a node's, to try again)
      w.codes.bittensor[another.toLowerCase()] = "0x6080";
      return w;
    };
    // at zero: it holds no park from any door, so the removal is written, and the line says what was read
    const zero = await run(second({ parkedNative: 0n, parkedTokens: 0n }));
    expect(zero.ok).toBe(true);
    expect(zero.lines).toContain(
      `  Ops reads which door each park came from only in ${plan.addresses.bitAdapter}; the other bridge the vault enabled, ${another}, holds no park (as of Bittensor block ${HEADS.bittensor}). A door that sends through an adapter the vault never enabled would park there unseen.`,
    );
    // made the primary by a migration, and at zero: passes too (the logs show it enabled)
    const migrated = second({ parkedNative: 0n, parkedTokens: 0n });
    answer(migrated, "bittensor", plan.addresses.vaultLens, "primaryBridge", another);
    expect((await run(migrated)).ok).toBe(true);
    // holding parks: refused, naming it, whatever door they came from
    await expect(run(second({ parkedNative: E18 / 100n, parkedTokens: 0n }))).rejects.toThrow(
      `Can't confirm it's safe: the bridge ${another}, which the vault enabled, holds parks (0.01 TAO as native TAO and 0 TAO as tokens), and ops reads which door a park came from only in this deployment's Bittensor adapter ${plan.addresses.bitAdapter}: each of that bridge's parks is delivered (deliverParked), or after 14 days refunded (refundParked) or dropped (dropParked), first; nothing written`,
    );
    await expect(run(second({ parkedNative: 0n, parkedTokens: 1n }))).rejects.toThrow(/holds parks \(0 TAO as native TAO and 0\.000000000000000001 TAO as tokens\)/);
    // a bridge whose totals revert (no such views): refused, naming it, with no "try again"
    await expect(run(second({ parkedNative: revert("InvalidParameter"), parkedTokens: 0n }))).rejects.toThrow(
      `Can't confirm it's safe: the bridge ${another}, which the vault enabled, does not report its parks (parkedNative() and parkedTokens() revert there: InvalidParameter()), so ops can't confirm it holds none; nothing written`,
    );
    // a read that fails: refused, to try again
    await expect(run(second({ parkedNative: new RpcError("header not found", -32000), parkedTokens: 0n }))).rejects.toThrow(
      `Can't confirm it's safe right now: the parks of the bridge ${another}, which the vault enabled, could not be read (header not found); try again; nothing written`,
    );
  });

  it("the removal guard reads at the scanned head, and warns while a batch of the door can still land (review, I2)", async () => {
    const dir = tempDir("remove-door-head");
    const door = plan.addresses.frontDoor;
    const opts = { dir, name: "v3.2-launch", now: NOW, buildsDir, chain: 8_453n, door, as: "guardian" as const };
    // another door's batch and park, so that every guard read runs once
    const w = answer(liveWorld(), "base", door, "paused", true);
    queue(w, plan, keccak256(stringToBytes("batch 1")), { count: 1, remaining: E18 / 100n }, CREATED_BLOCK + 50, other);
    park(w, plan, keccak256(stringToBytes("park 1")), E18 / 100n, true, CREATED_BLOCK + 70, other);
    const f = rpcOf(w);
    const r = await removeDoorCommand(f.ctx, liveRecord(), opts);
    const guard = ["primaryBridge()", "getPayoutBatch(bytes32)", "pendingPayouts()", "parked(bytes32)", "parkedNative()", "parkedTokens()"].map((x) => toFunctionSelector(x));
    const reads = f.calls.filter((c) => c.method === "eth_call" && c.chain === "bittensor" && guard.includes((c.params[0] as { data: Hex }).data.slice(0, 10) as Hex));
    expect(reads).toHaveLength(6);
    expect(reads.map((c) => c.params[1])).toEqual(Array(6).fill(numberToHex(HEADS.bittensor)));
    // and every Bittensor scan ends at that head
    const scans = f.calls.filter((c) => c.method === "eth_getLogs" && c.chain === "bittensor");
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.every((c) => hexToNumber((c.params[0] as { toBlock: Hex }).toBlock) <= HEADS.bittensor)).toBe(true);
    // a paused door with nothing open: no warning about it
    expect(r.lines.some((l) => l.includes("WARNING — the door") || l.includes("WARNING — whether the door"))).toBe(false);
    // the door not paused, or with an open batch, or unread: a warning, and the file is written all the same
    const warned = async (x: World) => {
      const out = await removeDoorCommand(rpcOf(x).ctx, liveRecord(), opts);
      expect(out.files).toHaveLength(1);
      return out.lines.filter((l) => l.startsWith("  WARNING — the door") || l.startsWith("  WARNING — whether the door"));
    };
    // what a pause stops, and the batch in flight (the re-review's N2)
    const tail =
      ": a batch of it can still land on the vault before this file is signed. A pause stops deposits only (redeem requests still batch), and a batch closed in the last ~30 minutes may still be crossing. Pause the door and let its last batch land first.";
    expect(await warned(liveWorld())).toEqual([`  WARNING — the door is not paused${tail}`]);
    const open = answer(answer(liveWorld(), "base", door, "paused", true), "base", door, "openBatch", [7n, BigInt(HEAD_AT - 600), E18, 0n, 2n, 1n]);
    expect(await warned(open)).toEqual([`  WARNING — the door has an open batch (2 deposits, 1 redeem)${tail}`]);
    const both = answer(liveWorld(), "base", door, "openBatch", [7n, BigInt(HEAD_AT - 600), E18, 0n, 1n, 0n]);
    expect(await warned(both)).toEqual([`  WARNING — the door is not paused and has an open batch (1 deposit, 0 redeems)${tail}`]);
    const unread = answer(liveWorld(), "base", door, "paused", new RpcError("header not found", -32000));
    expect(await warned(unread)).toEqual([`  WARNING — whether the door is paused, or has an open batch, could not be read (header not found)${tail}`]);
    // paused with nothing open, but its open batch started minutes ago: the last batch may have just closed, and be
    // crossing (the re-review's N2); by Base's head time, never the wall clock
    const recent = (ago: number) => answer(answer(liveWorld(), "base", door, "paused", true), "base", door, "openBatch", [8n, BigInt(HEAD_AT - ago), 0n, 0n, 0n, 0n]);
    expect(await warned(recent(10 * 60))).toEqual([`  WARNING — the door's last batch may have closed 10 minutes ago (its open batch started then)${tail}`]);
    expect(await warned(recent(30 * 60 - 1))).toEqual([`  WARNING — the door's last batch may have closed 29 minutes ago (its open batch started then)${tail}`]);
    expect(await warned(recent(20))).toEqual([`  WARNING — the door's last batch may have closed less than a minute ago (its open batch started then)${tail}`]);
    expect(await warned(recent(30 * 60))).toEqual([]);
  });

  it("the Safe warning judges the owner the contracts name now, never the plan's (review, I1)", async () => {
    const p = capsAbove();
    const safe = getAddress(`0x${"5a".repeat(20)}`);
    const twoOfThree = { getThreshold: 2n, getOwners: [other, another, plan.roles.keeper] };
    // the owner moved to a 2-of-3 Safe on both chains: owner() fails against the plan (list A of the report), and the
    // caps above the founder level warn no more
    const w = ownerContract(world(p, codesOf(p)), twoOfThree, "0x6080604052", safe);
    answer(w, "bittensor", p.addresses.vault, "owner", safe);
    answer(w, "base", p.addresses.frontDoor, "owner", safe);
    const r = await verify(w, record(p));
    expect(r.failures).toEqual([line("Bittensor", "CascadeVault", "owner()", plan.roles.owner, safe), line("Base", "CascadeFrontDoor", "owner()", plan.roles.owner, safe)]);
    expect(r.warnings).toEqual([]);
    expect(r.owners).toEqual({ bittensor: { kind: "safe", threshold: 2n, owners: 3 }, base: { kind: "safe", threshold: 2n, owners: 3 } });
    expect(r.info).toContain(`Bittensor: the owner ${safe} is a Safe with a threshold of 2 and 3 signers, not the plan's ${plan.roles.owner}`);
    // a planned Safe replaced by a plain account: it warns on both chains, naming the account
    const e = ownerContract(world(p, codesOf(p)), twoOfThree);
    answer(e, "bittensor", p.addresses.vault, "owner", another);
    answer(e, "base", p.addresses.frontDoor, "owner", another);
    const q = await verify(e, record(p));
    expect(q.failures).toHaveLength(2);
    expect(q.warnings).toHaveLength(2);
    for (const warning of q.warnings) expect(warning).toContain("and the owner is a plain account, not a Safe with at least 2 of 3 signers");
    expect(q.info).toContain(`Base: the owner ${another} is a plain account, not the plan's ${plan.roles.owner}`);
    // an owner() that can't be read: its failure, and the caps warn, the owner not known to be a Safe
    const u = answer(world(p, codesOf(p)), "bittensor", p.addresses.vault, "owner", new RpcError("header not found", -32000));
    const k = await verify(u, record(p));
    expect(k.failures).toEqual(["Bittensor CascadeVault.owner(): could not be read (header not found)"]);
    expect(k.warnings[1]).toContain("the owner is of a kind that could not be read");
  });

  it("a log server that prunes its history fails verify's pending report, never 'nothing scheduled' (review, I3)", async () => {
    const w = world();
    put(w, plan, "vault", "setMaxTotalAssets", [100n * E18], HEAD_AT - 600);
    w.prunedBefore = { bittensor: HEADS.bittensor - 10 };
    const r = await verify(w);
    expect(r.failures).toEqual([`Bittensor CascadeVault's scheduler: its pending items could not be read (${noHistory()})`]);
    expect(r.info.some((l) => l.startsWith("Bittensor CascadeVault's scheduler: nothing scheduled"))).toBe(false);
    // Base's scheduler is still read
    expect(r.info).toContain("Base CascadeFrontDoor's scheduler: nothing scheduled that can still run");
  });

  it("retire-pair and remove-door parse, as call files for the live deployment only", () => {
    expect(parseArgs(["retire-pair", "--as", "guardian", "--for-wallet", "--live"])).toEqual({ cmd: "retire-pair", live: true, users: [], as: "guardian", forWallet: true });
    expect(parseArgs(["remove-door", "8453", plan.addresses.frontDoor, "--as", "owner", "--for-wallet", "--live"])).toEqual({
      cmd: "remove-door",
      live: true,
      users: [],
      doorChain: "8453",
      door: plan.addresses.frontDoor,
      as: "owner",
      forWallet: true,
    });
    expect(() => parseArgs(["retire-pair", "--for-wallet", "--live"])).toThrow(/retire-pair needs --as owner or --as guardian/);
    expect(() => parseArgs(["retire-pair", "--as", "guardian", "--live"])).toThrow(/add --for-wallet/);
    expect(() => parseArgs(["retire-pair", "--as", "guardian", "--for-wallet"])).toThrow(/add --live/);
    expect(() => parseArgs(["remove-door", "8453", "--as", "owner", "--for-wallet", "--live"])).toThrow(/remove-door needs the door's chain and address/);
    expect(() => parseArgs(["remove-door", "base", plan.addresses.frontDoor, "--as", "owner", "--for-wallet", "--live"])).toThrow(/base is not a chain id/);
    expect(() => parseArgs(["remove-door", "8453", "0x1234", "--as", "owner", "--for-wallet", "--live"])).toThrow(/0x1234 is not an address/);
    expect(() => parseArgs(["remove-door", "8453", plan.addresses.frontDoor, "--for-wallet", "--live"])).toThrow(/remove-door needs --as owner or --as guardian/);
  });
});

/** `fn`'s calldata with `args`, by the ABI. */
function encodeFunctionCall(abi: Abi, fn: string, args: unknown[]): Hex {
  const f = abi.find((x): x is AbiFunction => x.type === "function" && x.name === fn)!;
  return `${toFunctionSelector(f)}${encodeAbiParameters(f.inputs, args as never).slice(2)}` as Hex;
}

describe("Task 47b: verify reports the rails between the chains", () => {
  const BIT2 = getAddress(`0x${"b2".repeat(20)}`);
  const BASE2 = getAddress(`0x${"a2".repeat(20)}`);
  /** The honest world with a second adapter pair deployed (B2 on Bittensor, A2 on Base), each the other's peer. */
  const withPair = () => {
    const w = world();
    w.book.bittensor[BIT2.toLowerCase()] = { abi: abiOf("CcipBittensorAdapter"), answers: { remoteAdapter: BASE2, remoteChainId: 8_453n, token: BIT_TOKEN, ...LANE_BIT } };
    w.book.base[BASE2.toLowerCase()] = { abi: abiOf("CcipBaseAdapter"), answers: { remoteAdapter: BIT2, remoteChainId: 964n, ...LANE_BASE } };
    return w;
  };
  const enabledOnly = (...xs: Address[]) => (args: readonly unknown[]) => xs.some((x) => sameText(args[0], x));
  const a = () => plan.addresses;

  it("coherent rails are reported as the two chains agreeing; incoherent ones fail, naming the pair, with the pending items that would change that", async () => {
    // the honest deployment agrees (the 46a honest test lists the line among the rest)
    const ok = await verify();
    expect(ok.info).toContain(
      `The rails: now, the two chains agree on the bridge: the front door's primary ${a().baseAdapter} sends to ${a().bitAdapter} on Bittensor, enabled on the vault; the vault's primary ${a().bitAdapter} sends to ${a().baseAdapter} on Base, which the front door has enabled.`,
    );
    // the front door switched to A2 alone: its batches go to B2, which the vault never enabled
    const w = withPair();
    answer(w, "base", a().doorLens, "primaryBridge", BASE2);
    answer(w, "base", a().doorLens, "bridgeEnabled", enabledOnly(a().baseAdapter, BASE2));
    const r = await verify(w);
    expect(r.failures).toEqual([
      line("Base", "CascadeDoorLens", "primaryBridge()", a().baseAdapter, BASE2),
      `The rails: now the two chains disagree on the bridge: the front door's primary ${BASE2} sends to ${BIT2} on Bittensor, which is not enabled on the vault. ${RAIL_RESIDUAL[1]}`,
    ]);
    expect(r.info.some((l) => l.startsWith("The rails:"))).toBe(false);
    // the vault's activation of B2, pending: listed, with the rails it leaves once it runs
    const item = put(w, plan, "vault", "activateBridge", [BIT2], HEAD_AT - 600);
    const p = await verify(w);
    expect(p.failures.at(-1)).toMatch(/^The rails: now the two chains disagree on the bridge/);
    expect(p.info).toContain(
      `The rails: the pending items that change them: item ${item.id}, activateBridge(${BIT2}) on the vault. Once they run, the two chains agree on the bridge: the front door's primary ${BASE2} sends to ${BIT2} on Bittensor, enabled on the vault; the vault's primary ${a().bitAdapter} sends to ${a().baseAdapter} on Base, which the front door has enabled.`,
    );
    // both primaries disabled (nothing crosses, so the two chains agree), and the front door's Reopen of its own alone
    // pending: once it runs, the front door's batches go to the vault's B, still disabled there, a warning
    const off = withPair();
    answer(off, "bittensor", a().vaultLens, "bridgeEnabled", false);
    answer(off, "base", a().doorLens, "bridgeEnabled", false);
    const reopen = put(off, plan, "frontDoor", "activateBridge", [a().baseAdapter], HEAD_AT - 600);
    const q = await verify(off);
    expect(q.info).toContain("The rails: now, the two chains agree on the bridge: both primaries are disabled, so nothing crosses either way until the owner makes an enabled bridge the primary on each chain.");
    expect(q.warnings).toContain(
      `The rails: the pending items that change them: item ${reopen.id}, activateBridge(${a().baseAdapter}) on the front door. Once they run, the two chains disagree on the bridge: the front door's primary ${a().baseAdapter} sends to ${a().bitAdapter} on Bittensor, which is not enabled on the vault.`,
    );
    // the front door's own primary disabled alone: the vault's payouts still reach it (a bridge it once enabled), so the
    // two chains agree (the coordinator's correction)
    const door = await verify(answer(world(), "base", a().doorLens, "bridgeEnabled", false));
    expect(door.info).toContain(
      `The rails: now, the two chains agree on the bridge: the front door's primary ${a().baseAdapter} is disabled, so it sends nothing; the vault's primary ${a().bitAdapter} sends to ${a().baseAdapter} on Base, which the front door has enabled.`,
    );
  });

  it("a failed read fails, and the rails are never reported as agreeing when they can't be read or judged", async () => {
    // an adapter's peer, a bridge's flag: unread, a failure
    for (const [label, w, why] of [
      ["the Bittensor adapter's peer", answer(world(), "bittensor", a().bitAdapter, "remoteAdapter", new RpcError("header not found", -32000)), "header not found"],
      ["the front door's bridges", answer(world(), "base", a().doorLens, "bridgeEnabled", new RpcError("header not found", -32000)), "header not found"],
      ["what the front door has ever enabled", answer(world(), "base", a().doorLens, "bridgeKnown", new RpcError("header not found", -32000)), "header not found"],
    ] as const) {
      const r = await verify(w);
      expect(r.failures, label).toContain(`The rails could not be read (${why}): whether the two chains agree on the bridge is not known`);
      expect(r.info.some((l) => l.startsWith("The rails:")), label).toBe(false);
    }
    // a scheduler whose items could not be read (its own failure): the rails once the pending items run are not judged;
    // the rails now are (the fix round's Important 1), and agree
    const now = `The rails: now, the two chains agree on the bridge: the front door's primary ${a().baseAdapter} sends to ${a().bitAdapter} on Bittensor, enabled on the vault; the vault's primary ${a().bitAdapter} sends to ${a().baseAdapter} on Base, which the front door has enabled.`;
    const f = world();
    f.logsFail = "base";
    const s = await verify(f);
    expect(s.warnings).toContain(
      "The rails once the pending items run are not judged: the front door's pending items could not be read (above), so whether the two chains will agree on the bridge then is not known",
    );
    expect(s.info.filter((l) => l.startsWith("The rails:"))).toEqual([now]);
    expect([...s.info, ...s.warnings].some((l) => l.includes("Once they run"))).toBe(false);
    // an activation the lens can't judge: the same
    const u = withPair();
    const item = put(u, plan, "vault", "activateBridge", [BIT2], HEAD_AT - 600);
    answer(u, "bittensor", a().vaultLens, "scheduled", (args: readonly unknown[]) => (sameText(args[0], item.id) ? new RpcError("header not found", -32000) : EMPTY_ITEM));
    const v = await verify(u);
    expect(v.warnings).toContain(
      `The rails once the pending items run are not judged: item ${item.id}, an activation of a bridge, could not be judged (the lens could not read it (header not found)), so whether the two chains will agree on the bridge then is not known`,
    );
    expect(v.info.filter((l) => l.startsWith("The rails:"))).toEqual([now]);
    expect([...v.info, ...v.warnings].some((l) => l.includes("Once they run"))).toBe(false);
  });

  it("the rails now are always judged: the two chains disagreeing now fails verify, whatever the pending items, even when they can't be judged", async () => {
    // the front door switched to A2 alone (the two chains disagree now), and the vault's activation of B2, which would fix
    // it, pending but unjudgeable (a failed lens read of that item)
    const disagree = `The rails: now the two chains disagree on the bridge: the front door's primary ${BASE2} sends to ${BIT2} on Bittensor, which is not enabled on the vault. ${RAIL_RESIDUAL[1]}`;
    const split = () => {
      const w = withPair();
      answer(w, "base", a().doorLens, "primaryBridge", BASE2);
      answer(w, "base", a().doorLens, "bridgeEnabled", enabledOnly(a().baseAdapter, BASE2));
      return w;
    };
    const u = split();
    const item = put(u, plan, "vault", "activateBridge", [BIT2], HEAD_AT - 600);
    answer(u, "bittensor", a().vaultLens, "scheduled", (args: readonly unknown[]) => (sameText(args[0], item.id) ? new RpcError("header not found", -32000) : EMPTY_ITEM));
    const r = await verify(u);
    expect(r.failures).toContain(disagree);
    expect(r.warnings).toContain(
      `The rails once the pending items run are not judged: item ${item.id}, an activation of a bridge, could not be judged (the lens could not read it (header not found)), so whether the two chains will agree on the bridge then is not known`,
    );
    // ... and when a scheduler's items could not be read at all
    const f = split();
    f.logsFail = "bittensor";
    const s = await verify(f);
    expect(s.failures).toContain(disagree);
    expect(s.warnings).toContain(
      "The rails once the pending items run are not judged: the vault's pending items could not be read (above), so whether the two chains will agree on the bridge then is not known",
    );
  });
});

describe("merge 7a's follow-up: verify's rails line names the residual half that applies", () => {
  // the launch pair (A on Base, B on Bittensor) and a second (A2, B2), each adapter the other's peer
  const A = getAddress("0x0000000000000000000000000000000000ba5e01");
  const B = getAddress("0x0000000000000000000000000000000000b17701");
  const A2 = getAddress("0x0000000000000000000000000000000000ba5e02");
  const B2 = getAddress("0x0000000000000000000000000000000000b17702");
  const low = (x: string) => x.toLowerCase();
  /** Both chains' rails, read now: each side's primary, the vault's enabled bridges, the front door's known ones. */
  const state = (o: { door: Address; vault: Address; vaultEnabled: Address[]; doorKnown: Address[] }): RailState => ({
    heads: { vault: { block: 1, time: 1 }, frontDoor: { block: 1, time: 1 } },
    primary: { frontDoor: o.door, vault: o.vault },
    sendsTo: { vault: 8_453n, frontDoor: 964n },
    peers: {
      frontDoor: { [low(A)]: { peer: B, chain: 964n }, [low(A2)]: { peer: B2, chain: 964n } },
      vault: { [low(B)]: { peer: A, chain: 8_453n }, [low(B2)]: { peer: A2, chain: 8_453n } },
    },
    enabled: { frontDoor: { [low(A)]: o.door === A, [low(A2)]: o.door === A2 }, vault: { [low(B)]: o.vaultEnabled.includes(B), [low(B2)]: o.vaultEnabled.includes(B2) } },
    doorKnown: { [low(A)]: o.doorKnown.includes(A), [low(A2)]: o.doorKnown.includes(A2) },
    pending: [],
    planned: [],
  });
  const [BATCH, PAYOUT] = [RAIL_RESIDUAL[1], RAIL_RESIDUAL[2]];

  it("the payouts pair alone: the payout half, not the batch half; the batches pair alone: the batch half, not the payout half; both: both", () => {
    // the vault switched to B2, whose Base half A2 the front door never enabled; the front door still on the launch pair
    const payouts = railsFindings(state({ door: A, vault: B2, vaultEnabled: [B, B2], doorKnown: [A] })).failures;
    expect(payouts).toEqual([`The rails: now the two chains disagree on the bridge: the vault's primary ${B2} sends to ${A2} on Base, which the front door has never enabled. ${PAYOUT}`]);
    expect(payouts[0]).not.toContain(BATCH);
    // the mirror: the front door switched to A2, whose Bittensor half B2 the vault hasn't enabled; the vault on the launch pair
    const batches = railsFindings(state({ door: A2, vault: B, vaultEnabled: [B], doorKnown: [A, A2] })).failures;
    expect(batches).toEqual([`The rails: now the two chains disagree on the bridge: the front door's primary ${A2} sends to ${B2} on Bittensor, which is not enabled on the vault. ${BATCH}`]);
    expect(batches[0]).not.toContain(PAYOUT);
    // both: the vault switched alone to B2 (B disabled there), A2 never enabled on the front door
    const both = railsFindings(state({ door: A, vault: B2, vaultEnabled: [B2], doorKnown: [A] })).failures;
    expect(both).toHaveLength(1);
    expect(both[0]).toMatch(/^The rails: now the two chains disagree on the bridge: the front door's primary .*; and the vault's primary /);
    expect(both[0].endsWith(`. ${BATCH} ${PAYOUT}`)).toBe(true);
  });

  it("a fault fixed at deploy adds no half (merge 7a's review, M1): a pair whose ends don't name each other, or a wrong chain, is named by its own words alone; beside a pair a switch can fix, only that pair's half", () => {
    const pair = (o: Partial<RailPair>): RailPair => ({ from: "vault", primary: B2, peer: A2, chain: 8_453n, ...o });
    const sendsTo = { vault: 8_453n, frontDoor: 964n };
    // the vault's pair names another sender back (a misdeployed adapter): no payout half
    expect(residualFor({ incoherent: [pair({ back: { peer: B, chain: 964n } })], halves: [], sendsTo })).toBe("");
    // the front door's pair sends to another chain: no batch half
    expect(residualFor({ incoherent: [pair({ from: "frontDoor", primary: A2, peer: B2, chain: 10n })], halves: [], sendsTo })).toBe("");
    // a half that names another sender: none
    expect(residualFor({ incoherent: [], halves: [{ contract: "vault", bridge: B2, peer: A2, back: { peer: B, chain: 964n } }], sendsTo })).toBe("");
    // beside a pair a two-sided switch can fix: that pair's half only
    expect(residualFor({ incoherent: [pair({ from: "frontDoor", primary: A2, peer: B2, chain: 964n }), pair({ back: { peer: B, chain: 964n } })], halves: [], sendsTo })).toBe(BATCH);
    // a vault pair the front door never enabled (fixable): the payout half, as before
    expect(residualFor({ incoherent: [pair({})], halves: [], sendsTo })).toBe(PAYOUT);
  });
});

describe("Task 53: the owner's and the guardian's hotkey calls, as call files for the sign page (pnpm ops add-hotkey | remove-hotkey | set-stake-hotkey --for-wallet)", () => {
  const HK: Hex = `0x${"5e".repeat(32)}`;
  const run = (w: World, o: { fn: "addHotkey" | "removeHotkey" | "setStakeHotkey"; as: "owner" | "guardian"; forfeit?: boolean }, dir = tempDir("hotkey-files")) =>
    hotkeyFileCommand(rpcOf(w).ctx, liveRecord(), { dir, name: "v3.2-launch", now: NOW, buildsDir, hotkey: HK, ...o });
  /** The vault answering `fn` from the owner and the guardian as `v` says (a revert, or nothing). */
  const vaultAnswers = (fn: string, v: (from?: string) => unknown) => {
    const w = liveWorld();
    w.book.bittensor[plan.addresses.vault.toLowerCase()].answers[fn] = (_a: readonly unknown[], from?: string) => v(from);
    return w;
  };

  it("each call asked of the vault by eth_call from the role read now, then written for the sign page; the effect said", async () => {
    const dir = tempDir("hotkey-files-ok");
    const add = await run(vaultAnswers("addHotkey", () => undefined), { fn: "addHotkey", as: "guardian" }, dir);
    expect(add.lines[0]).toBe(`Bittensor vault ${plan.addresses.vault}: addHotkey(${HK}) from the guardian ${plan.roles.guardian} would succeed now. It lists hotkey ${HK} (${encodeSs58(HK)}) on the vault: its stake counts in the price; new stake still goes to the stake hotkey.`);
    const f = readFile(add.files[0]);
    expect(f.calls.map((c) => [c.chainId, c.to, c.from, c.data])).toEqual([[964, plan.addresses.vault, plan.roles.guardian, encodeFunctionData({ abi: build.vaultAbi, functionName: "addHotkey", args: [HK] })]]);
    const remove = await run(vaultAnswers("removeHotkey", () => undefined), { fn: "removeHotkey", as: "owner", forfeit: true }, dir);
    expect(remove.lines[0]).toContain(`removeHotkey(${HK}, true) from the owner ${plan.roles.owner} would succeed now. It removes hotkey ${HK} (${encodeSs58(HK)}) from the vault's list: any of the vault's stake on it moves onto the stake hotkey, and its unclaimed rewards are given up (forfeit).`);
    expect(remove.lines[1]).toBe(`  Its stake, if any, moves onto the stake hotkey ${TAO_BOT} (below the chain's minimum it becomes the vault's balance instead).`);
    const set = await run(vaultAnswers("setStakeHotkey", () => undefined), { fn: "setStakeHotkey", as: "owner" }, dir);
    expect(set.lines.at(-1)).toMatch(/^Wrote .*v3\.2-launch-set-stake-hotkey-owner\.json \(1 call\): send them from MetaMask with: pnpm ops sign /);
    expect(filesIn(dir)).toHaveLength(3);
  });

  it("refused, nothing written, when the vault would revert, each in words; setStakeHotkey's NotScheduled points to the scheduler", async () => {
    const dir = tempDir("hotkey-files-refused");
    await expect(run(vaultAnswers("setStakeHotkey", () => revert("NotScheduled")), { fn: "setStakeHotkey", as: "owner" }, dir)).rejects.toThrow(
      `setStakeHotkey(${HK}) doesn't apply at once now (NotScheduled): the new hotkey must hold more of the vault's stake than the stake hotkey and at least half the booked stake. Schedule it instead (48 hours, the guardian may veto): pnpm ops schedule vault setStakeHotkey ${HK} --for-wallet --live; nothing written`,
    );
    await expect(run(vaultAnswers("removeHotkey", () => revert("HotkeyHasRewards")), { fn: "removeHotkey", as: "owner" }, dir)).rejects.toThrow(
      `removeHotkey(${HK}) from the owner would revert: HotkeyHasRewards(): unclaimed rewards above the dust allowance wait on it: claim them first (pnpm ops claim <hotkey> --live --send), or give them up with --forfeit; nothing written`,
    );
    await expect(run(vaultAnswers("removeHotkey", () => revert("NotAuthorized")), { fn: "removeHotkey", as: "guardian" }, dir)).rejects.toThrow(
      `removeHotkey(${HK}) from the guardian would revert: NotAuthorized(): the guardian may not remove it: it holds stake, or unclaimed rewards above the dust allowance (only the owner's removal moves stake); nothing written`,
    );
    await expect(run(vaultAnswers("addHotkey", () => revert("SlotReserved")), { fn: "addHotkey", as: "owner" }, dir)).rejects.toThrow(/SlotReserved\(\): the last of the 4 slots is kept for a swap's new hotkey/);
    await expect(run(vaultAnswers("addHotkey", () => undefined), { fn: "setStakeHotkey", as: "guardian" }, dir)).rejects.toThrow("setStakeHotkey is the owner's; nothing written");
    expect(filesIn(dir)).toEqual([]);
  });

  it("R6b (U9): the guardian's removal is refused, nothing written, while Bittensor still owes the vault deferred rewards on the hotkey above the dust allowance (the vault's own check reads only the unclaimed view), or they can't be read", async () => {
    const dir = tempDir("hotkey-files-deferred");
    const w = vaultAnswers("removeHotkey", () => undefined);
    w.storage[SYSTEM_NUMBER_KEY.toLowerCase()] = "0x10270000";
    // 0.003 TAO of a dissolved origin's cash still owed: DeferredBasketCashClaimed at -3,000,000 rao (an i128)
    w.storage[deferredCashKey(HK, plan.vaultColdkey).toLowerCase()] = `0x${(((1n << 128n) - 3_000_000n).toString(16).match(/../g) ?? []).reverse().join("")}` as Hex;
    await expect(run(w, { fn: "removeHotkey", as: "guardian" }, dir)).rejects.toThrow(
      `removeHotkey(${HK}) from the guardian is refused here: Bittensor still owes the vault deferred rewards on hotkey ${HK} (0 rao of subnet alpha and 3,000,000 rao of TAO, which the unclaimed-rewards read leaves out), more than the 1,000,000 rao dust allowance: a removal now would strand them.`,
    );
    // unread (no answer for the block number): refused
    delete w.storage[SYSTEM_NUMBER_KEY.toLowerCase()];
    await expect(run(w, { fn: "removeHotkey", as: "guardian" }, dir)).rejects.toThrow(/from the guardian is refused here: the vault's deferred rewards on hotkey .* can't be read now/);
    expect(filesIn(dir)).toEqual([]);
    // paid: the file is written
    w.storage[SYSTEM_NUMBER_KEY.toLowerCase()] = "0x10270000";
    delete w.storage[deferredCashKey(HK, plan.vaultColdkey).toLowerCase()];
    const ok = await run(w, { fn: "removeHotkey", as: "guardian" }, dir);
    expect(ok.lines[0]).toContain(`removeHotkey(${HK}, false) from the guardian ${plan.roles.guardian} would succeed now.`);
  });

  it("pause | unpause --for-wallet on v3.2: the guardian's pause of both, the front door's first, in one file; the owner's unpause; one already paused gets no call", async () => {
    const dir = tempDir("pause-files");
    const w = liveWorld();
    w.book.bittensor[plan.addresses.vault.toLowerCase()].answers.pause = (_a: readonly unknown[], from?: string) => (sameText(from, plan.roles.guardian) || sameText(from, plan.roles.owner) ? undefined : revert("NotGuardian"));
    w.book.base[plan.addresses.frontDoor.toLowerCase()].answers.pause = w.book.bittensor[plan.addresses.vault.toLowerCase()].answers.pause;
    w.book.base[plan.addresses.frontDoor.toLowerCase()].answers.paused = false;
    w.book.bittensor[plan.addresses.vault.toLowerCase()].answers.paused = false;
    const r = await pauseFileCommand(rpcOf(w).ctx, liveRecord(), { dir, name: "v3.2-launch", now: NOW, buildsDir, action: "pause", target: "both", as: "guardian" });
    expect(r.lines[0]).toBe(`the front door (Base) ${plan.addresses.frontDoor}: pause() from the guardian ${plan.roles.guardian} would succeed now. It stops deposits (redeem requests still batch, claims stay open, and a batch still closes); it stamps nothing.`);
    expect(r.lines[1]).toContain("It stops payouts, direct deposits and direct exits, and stamps the guardian's clock: every Ordinary item pending on the vault dies (not a guardian swap or a reopening).");
    const f = readFile(r.files[0]);
    expect(f.title).toBe("Cascade v3.2-launch: pause on both chains: sign both calls, signed by the guardian");
    expect(f.calls.map((c) => [c.chainId, c.to, c.from])).toEqual([
      [8453, plan.addresses.frontDoor, plan.roles.guardian],
      [964, plan.addresses.vault, plan.roles.guardian],
    ]);
    // the vault paused already: the front door's call alone
    w.book.bittensor[plan.addresses.vault.toLowerCase()].answers.paused = true;
    const one = await pauseFileCommand(rpcOf(w).ctx, liveRecord(), { dir, name: "v3.2-launch", now: NOW, buildsDir, action: "pause", target: "both", as: "guardian" });
    expect(one.lines).toContain("the vault (Bittensor) is paused already: no call for it.");
    expect(readFile(one.files[0]).calls).toHaveLength(1);
    await expect(pauseFileCommand(rpcOf(w).ctx, liveRecord(), { dir, name: "v3.2-launch", now: NOW, buildsDir, action: "unpause", target: "vault", as: "guardian" })).rejects.toThrow("unpause is the owner's; nothing written");
  });

  it("pause --offline (R4, D-L4): the guardian's pause of both written with no chain read, from the record, and marked offline; never an unpause", async () => {
    const dir = tempDir("pause-offline");
    const asked: string[] = [];
    const dead = { rpc: { request: async (chain: string, method: string) => (asked.push(`${chain}:${method}`), Promise.reject(new RpcError("connect ECONNREFUSED", -32603))) }, targets: LIVE_T } as never;
    const r = await pauseFileCommand(dead, liveRecord(), { dir, name: "v3.2-launch", now: NOW, buildsDir, action: "pause", target: "both", as: "guardian", offline: true });
    expect(asked).toEqual([]);
    const f = readFile(r.files[0]);
    expect(f.offline).toBe(true);
    expect(f.title).toBe("Cascade v3.2-launch: pause on both chains, offline (no chain read): sign both calls, signed by the guardian");
    expect(f.calls.map((c) => [c.chainId, c.to, c.from, c.data])).toEqual([
      [8453, plan.addresses.frontDoor, plan.roles.guardian, encodeFunctionData({ abi: build.contracts.CascadeFrontDoor.abi, functionName: "pause", args: [] })],
      [964, plan.addresses.vault, plan.roles.guardian, encodeFunctionData({ abi: build.vaultAbi, functionName: "pause", args: [] })],
    ]);
    expect(r.lines).toContain(
      `Offline: nothing was read from the chains. The file names the record's front door and vault, their chain ids, and the record's guardian ${plan.roles.guardian}; it doesn't check either is unpaused or who the guardian is now. Keep it ready: pnpm ops sign serves it with no chain read.`,
    );
    await expect(pauseFileCommand(dead, liveRecord(), { dir, name: "v3.2-launch", now: NOW, buildsDir, action: "unpause", target: "both", as: "owner", offline: true })).rejects.toThrow("--offline is for the pause alone: an unpause waits until the chains can be read; nothing written");
    expect(asked).toEqual([]);
  });

  it("set-redeem-origin: the treasury's own setRedeemOrigin(DIRECT_ORIGIN), from the treasury the vault names now; nothing written once it is set (the T18 ruling)", async () => {
    const dir = tempDir("redeem-origin");
    // a fresh deployment: the treasury's origin is still 0
    const w = answer(liveWorld(), "bittensor", plan.addresses.vaultLens, "redeemOrigin", 0n);
    w.book.bittensor[plan.addresses.vault.toLowerCase()].answers.setRedeemOrigin = (_a: readonly unknown[], from?: string) => (sameText(from, plan.roles.treasury) ? undefined : revert("NotAuthorized"));
    const r = await redeemOriginFileCommand(rpcOf(w).ctx, liveRecord(), { dir, name: "v3.2-launch", now: NOW, buildsDir });
    expect(r.lines[0]).toBe(
      `Bittensor vault ${plan.addresses.vault}: setRedeemOrigin(18446744073709551615) from the treasury ${plan.roles.treasury} would succeed now (its redeem origin is 0 now). It makes the treasury's redeem origin Bittensor itself: no front door can burn its reward-cut shares; it redeems them on Bittensor (redeemDirect).`,
    );
    const f = readFile(r.files[0]);
    expect(f.calls.map((c) => [c.chainId, c.to, c.from, c.data])).toEqual([[964, plan.addresses.vault, plan.roles.treasury, encodeFunctionData({ abi: build.vaultAbi, functionName: "setRedeemOrigin", args: [(1n << 64n) - 1n] })]]);
    // already set: nothing to do
    const done = await redeemOriginFileCommand(rpcOf(liveWorld()).ctx, liveRecord(), { dir: tempDir("redeem-origin-done"), name: "v3.2-launch", now: NOW, buildsDir });
    expect(done).toEqual({ ok: true, lines: [`The treasury ${plan.roles.treasury}'s redeem origin is Bittensor itself already (DIRECT_ORIGIN): nothing to do; nothing written.`], files: [] });
  });
});

describe("Task 53's fix round: the sign page's four missing calls, as call files (set-keeper, fund-reserve, disable-bridge, set-idle-buffer)", () => {
  const NEW_KEEPER = getAddress(`0x${"4e".repeat(20)}`);
  const files = (label: string) => ({ dir: tempDir(label), name: "v3.2-launch", now: NOW, buildsDir });
  const call = (w: World, chain: ChainName, address: Address, fn: string, v: (args: readonly unknown[], from?: string) => unknown) => {
    w.book[chain][address.toLowerCase()].answers[fn] = v;
    return w;
  };
  const owner = (from?: string) => (sameText(from, plan.roles.owner) ? undefined : revert("NotOwner"));

  it("set-keeper: setKeeper(new) from the owner on the front door and the vault, one file, the front door's first; both at once", async () => {
    const w = liveWorld();
    call(w, "base", plan.addresses.frontDoor, "setKeeper", (_a, from) => owner(from));
    call(w, "bittensor", plan.addresses.vault, "setKeeper", (_a, from) => owner(from));
    const r = await setKeeperFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("set-keeper"), keeper: NEW_KEEPER });
    const f = readFile(r.files[0]);
    expect(f.calls.map((c) => [c.chainId, c.to, c.from, c.data])).toEqual([
      [8453, plan.addresses.frontDoor, plan.roles.owner, encodeFunctionData({ abi: abiOf("CascadeFrontDoor"), functionName: "setKeeper", args: [NEW_KEEPER] })],
      [964, plan.addresses.vault, plan.roles.owner, encodeFunctionData({ abi: build.vaultAbi, functionName: "setKeeper", args: [NEW_KEEPER] })],
    ]);
    expect(r.lines).toContain(`The new keeper ${NEW_KEEPER}, in place of ${plan.roles.keeper}: until both calls have landed, the keeper Worker sends nothing (its key isn't keeper() on both chains).`);
    // the same keeper on both: nothing to do
    await expect(setKeeperFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("set-keeper-same"), keeper: plan.roles.keeper })).rejects.toThrow(`${plan.roles.keeper} is the keeper on both chains already; nothing written`);
    // the keeper revoked (the runbook's last resort, 2.4): said for what it stops
    const zero = await setKeeperFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("set-keeper-zero"), keeper: "0x0000000000000000000000000000000000000000" });
    expect(zero.lines).toContain("setKeeper(0) stops the keeper's key wherever it is: no delivery goes, and stakes, claims and adoptions wait for their 7-day fallbacks.");
  });

  it("fund-reserve: fundReserve() on the Bittensor adapter carrying what its reserve lacks, from the account named; none when it holds its target", async () => {
    const w = liveWorld();
    w.balances.bittensor[plan.addresses.bitAdapter.toLowerCase()] = 0n;
    call(w, "bittensor", plan.addresses.bitAdapter, "fundReserve", () => undefined);
    const from = getAddress(`0x${"f0".repeat(20)}`);
    const r = await fundReserveFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("fund-reserve"), from });
    const f = readFile(r.files[0]);
    expect(f.calls.map((c) => [c.chainId, c.to, c.from, c.data, c.value])).toEqual([[964, plan.addresses.bitAdapter, from, encodeFunctionData({ abi: abiOf("CcipBittensorAdapter"), functionName: "fundReserve" }), "1000500000000000"]]);
    expect(r.lines[0]).toContain(`fundReserve() with 0.0010005 TAO from ${from} would succeed now`);
    const done = await fundReserveFileCommand(rpcOf(liveWorld()).ctx, liveRecord(), { ...files("fund-reserve-full"), from });
    expect(done.files).toEqual([]);
    expect(done.lines).toEqual([`The Bittensor adapter ${plan.addresses.bitAdapter}'s reserve is 0.001 TAO, its target already: nothing to send; nothing written.`]);
  });

  it("fund-cushion (merge 7b, R4 F-1): approve, then fundCushion, for what the booked cushion lacks, one ordered file from the account named; none at its target; refused when the account holds too little", async () => {
    const w = liveWorld();
    const from = getAddress(`0x${"f0".repeat(20)}`);
    const adapter = plan.addresses.bitAdapter;
    // the booked cushion 0.0004 short of its target; the account holds 0.01 FM-TAO; the approve asked from it
    call(w, "bittensor", adapter, "tokenCushion", () => 6n * 10n ** 14n);
    call(w, "bittensor", BIT_TOKEN, "balanceOf", (args) => (sameText(args[0], from) ? E18 / 100n : sameText(args[0], adapter) ? 6n * 10n ** 14n : 0n));
    const asked: unknown[][] = [];
    call(w, "bittensor", BIT_TOKEN, "approve", (args, sender) => {
      asked.push([sender, ...args]);
      return true;
    });
    const r = await fundCushionFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("fund-cushion"), from });
    const f = readFile(r.files[0]);
    expect(f.ordered).toBe(true);
    expect(f.calls.map((c) => [c.chainId, c.to, c.from, c.data, c.value])).toEqual([
      [964, BIT_TOKEN, from, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [adapter, 4n * 10n ** 14n] }), "0"],
      [964, adapter, from, encodeFunctionData({ abi: abiOf("CcipBittensorAdapter"), functionName: "fundCushion", args: [4n * 10n ** 14n] }), "0"],
    ]);
    expect(asked.map((x) => x.map((v) => String(v).toLowerCase()))).toEqual([[from.toLowerCase(), adapter.toLowerCase(), "400000000000000"]]);
    expect(r.lines.slice(0, 2)).toEqual([
      `Bittensor adapter ${adapter}: its booked token cushion is 0.0006 FM-TAO, its target 0.001. The file approves the adapter for 0.0004 FM-TAO from ${from} (it would succeed now; the account holds 0.01), then calls fundCushion(400000000000000), which pulls it and books it. Sign them in order: fundCushion needs the approve to have landed.`,
      "Never fund the cushion by a plain transfer: that is surplus, and anyone's sweepSurplus() sends it to the treasury.",
    ]);
    // the deploy's empty cushion: the whole target
    const empty = call(liveWorld(), "bittensor", adapter, "tokenCushion", () => 0n);
    call(empty, "bittensor", BIT_TOKEN, "balanceOf", () => E18);
    call(empty, "bittensor", BIT_TOKEN, "approve", () => true);
    const e = await fundCushionFileCommand(rpcOf(empty).ctx, liveRecord(), { ...files("fund-cushion-empty"), from });
    expect(readFile(e.files[0]).calls.map((c) => c.label)).toEqual([
      `approve(${adapter}, 1000000000000000) on FM-TAO, for the Bittensor adapter's token cushion`,
      "fundCushion(1000000000000000) on the Bittensor adapter (0.001 FM-TAO)",
    ]);
    // at its target: nothing written
    const done = await fundCushionFileCommand(rpcOf(liveWorld()).ctx, liveRecord(), { ...files("fund-cushion-full"), from });
    expect(done.files).toEqual([]);
    expect(done.lines).toEqual([`The Bittensor adapter ${adapter}'s booked token cushion is 0.001 FM-TAO, its target already: nothing to send; nothing written.`]);
    // the account holds less than the cushion lacks: refused, nothing written
    call(w, "bittensor", BIT_TOKEN, "balanceOf", () => 10n ** 14n);
    await expect(fundCushionFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("fund-cushion-short"), from })).rejects.toThrow(
      `${from} holds 0.0001 FM-TAO (${BIT_TOKEN} on Bittensor), less than the 0.0004 FM-TAO the cushion lacks: get FM-TAO into that account first; nothing written`,
    );
    // the CLI: --from is required, and it is a call file for the live deployment
    expect(parseArgs(["fund-cushion", "--from", from, "--for-wallet", "--live"])).toMatchObject({ cmd: "fund-cushion", from, forWallet: true, live: true });
    expect(() => parseArgs(["fund-cushion", "--for-wallet", "--live"])).toThrow("fund-cushion needs --from <0x…>, the account that will send it from MetaMask");
    expect(() => parseArgs(["fund-cushion", "--from", from, "--live"])).toThrow("fund-cushion writes a call for the sign page and sends nothing: add --for-wallet");
  });

  it("disable-bridge: the guardian's disableBridge, front door first in one ordered file, each said for what it closes and stamps, with the way back", async () => {
    const w = liveWorld();
    call(w, "base", plan.addresses.frontDoor, "disableBridge", (_a, from) => (sameText(from, plan.roles.guardian) || sameText(from, plan.roles.owner) ? undefined : revert("NotGuardian")));
    const r = await disableBridgeFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("disable-bridge"), target: "both", bridges: [plan.addresses.bitAdapter, plan.addresses.baseAdapter], as: "guardian" });
    const f = readFile(r.files[0]);
    expect(f.ordered).toBe(true);
    expect(f.calls.map((c) => [c.chainId, c.to, c.from])).toEqual([
      [8453, plan.addresses.frontDoor, plan.roles.guardian],
      [964, plan.addresses.vault, plan.roles.guardian],
    ]);
    expect(r.lines).toContain(
      `the front door (Base) ${plan.addresses.frontDoor}: disableBridge(${plan.addresses.baseAdapter}) from the guardian ${plan.roles.guardian} would succeed now. It is the primary: it closes the exits on Base and stamps the guardian's clock (every Ordinary item pending there dies; a guardian swap and a Reopen are spared).`,
    );
    // both primaries off: the way back is one two-sided Reopen file (a one-sided activation would leave the rails
    // disagreeing, which pnpm ops schedule refuses)
    expect(r.lines).toContain(
      `The way back is a 7-day Reopen on each chain, which reopens the exits when it runs (until then no batch closes on Base and no payout is sent): pnpm ops schedule both activateBridge ${plan.addresses.bitAdapter} ${plan.addresses.baseAdapter} --for-wallet --live.`,
    );
    // one chain only, as the owner: it stamps the owner's clock, and its way back is that chain's Reopen
    const o = await disableBridgeFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("disable-bridge-owner"), target: "vault", bridges: [plan.addresses.bitAdapter], as: "owner" });
    expect(o.lines[0]).toContain("stamps the owner's clock (every item pending there dies, a pending setGuardian included)");
    expect(o.lines[0]).toContain(`The way back is a 7-day Reopen, which reopens the exits when it runs: pnpm ops schedule vault activateBridge ${plan.addresses.bitAdapter} --for-wallet --live.`);
  });

  it("set-caps (R4): the owner's immediate setCaps on the front door, the minimum deposit and the cap as typed in TAO, said from and to", async () => {
    const w = liveWorld();
    call(w, "base", plan.addresses.frontDoor, "setCaps", (args, from) => owner(from) ?? (BigInt(args[0] as bigint) < 3n * 10n ** 16n ? revert("InvalidParameter") : undefined));
    w.book.base[plan.addresses.frontDoor.toLowerCase()].answers.minDeposit = 4n * 10n ** 16n;
    w.book.base[plan.addresses.frontDoor.toLowerCase()].answers.depositCap = 40n * 10n ** 18n;
    const r = await capsFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("set-caps"), minDeposit: 6n * 10n ** 16n, depositCap: 45n * 10n ** 18n });
    expect(readFile(r.files[0]).calls.map((c) => [c.chainId, c.to, c.from, c.data])).toEqual([
      [8453, plan.addresses.frontDoor, plan.roles.owner, encodeFunctionData({ abi: build.contracts.CascadeFrontDoor.abi, functionName: "setCaps", args: [6n * 10n ** 16n, 45n * 10n ** 18n] })],
    ]);
    expect(r.lines[0]).toBe(
      `Base front door ${plan.addresses.frontDoor}: setCaps(60000000000000000, 45000000000000000000) from the owner ${plan.roles.owner} would succeed now: the minimum deposit from 0.04 to 0.06 TAO and the deposit cap from 40 to 45 TAO, at once (setCaps is immediate either way).`,
    );
    const dir = tempDir("set-caps-refused");
    await expect(capsFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("x"), dir, minDeposit: 10n ** 16n, depositCap: 45n * 10n ** 18n })).rejects.toThrow(/would revert: InvalidParameter\(\)/);
    expect(parseArgs(["set-caps", "0.06", "45", "--for-wallet", "--live"])).toMatchObject({ cmd: "set-caps", caps: ["0.06", "45"], forWallet: true, live: true });
    expect(() => parseArgs(["set-caps", "0.06", "--for-wallet", "--live"])).toThrow("set-caps needs the minimum deposit and the deposit cap, in TAO: set-caps <minDeposit> <depositCap>");
    expect(() => parseArgs(["set-caps", "0.06", "4e1", "--for-wallet", "--live"])).toThrow("set-caps: 4e1 is not an amount of TAO (e.g. 0.06)");
  });

  it("R7: set-caps refuses a minimum deposit above the front door's MAX_BATCH_VALUE (5,000 TAO), as setCaps does, in plain words, before any read; 5,000 itself is asked as usual", async () => {
    const w = liveWorld();
    let asked = 0;
    call(w, "base", plan.addresses.frontDoor, "setCaps", (_args, from) => {
      asked++;
      return owner(from);
    });
    const dir = tempDir("set-caps-max");
    const above = 5_000n * 10n ** 18n + 10n ** 9n;
    await expect(capsFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("x"), dir, minDeposit: above, depositCap: 45n * 10n ** 18n })).rejects.toThrow(
      "a minimum deposit of 5000.000000001 TAO is above the front door's MAX_BATCH_VALUE, 5,000 TAO, and setCaps refuses it (no batch could hold one). To stop deposits, the guardian pauses the front door (pnpm ops pause front-door --for-wallet) or the owner sets the deposit cap to 0; nothing written",
    );
    expect(asked).toBe(0);
    expect(filesIn(dir)).toEqual([]);
    const r = await capsFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("set-caps-max-ok"), minDeposit: BOUNDS_V32.maxBatchValue, depositCap: 45n * 10n ** 18n });
    expect(r.ok).toBe(true);
    expect(asked).toBe(1);
  });

  it("R6b (U4): set-batch-limits: the owner's immediate setBatchLimits on the front door, said from and to (since R7 not a lever on a held batch: runbook 7.10)", async () => {
    const w = liveWorld();
    call(w, "base", plan.addresses.frontDoor, "setBatchLimits", (args, from) => owner(from) ?? (Number(args[0]) === 0 || Number(args[0]) > 50 || Number(args[1]) === 0 || Number(args[1]) > 50 ? revert("InvalidParameter") : undefined));
    w.book.base[plan.addresses.frontDoor.toLowerCase()].answers.maxDeposits = 50;
    w.book.base[plan.addresses.frontDoor.toLowerCase()].answers.maxRedeems = 50;
    const r = await batchLimitsFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("set-batch-limits"), maxDeposits: 1, maxRedeems: 50 });
    expect(readFile(r.files[0]).calls.map((c) => [c.chainId, c.to, c.from, c.data])).toEqual([
      [8453, plan.addresses.frontDoor, plan.roles.owner, encodeFunctionData({ abi: build.contracts.CascadeFrontDoor.abi, functionName: "setBatchLimits", args: [1, 50] })],
    ]);
    expect(r.lines[0]).toBe(
      `Base front door ${plan.addresses.frontDoor}: setBatchLimits(1, 50) from the owner ${plan.roles.owner} would succeed now: a batch's deposit list from 50 to 1 entries and its redeem list from 50 to 50, at once (setBatchLimits is immediate either way).`,
    );
    const dir = tempDir("set-batch-limits-same");
    await expect(batchLimitsFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("x"), dir, maxDeposits: 50, maxRedeems: 50 })).rejects.toThrow("a batch holds at most 50 deposits and 50 redeem requests already; nothing written");
    expect(parseArgs(["set-batch-limits", "1", "50", "--for-wallet", "--live"])).toMatchObject({ cmd: "set-batch-limits", batchLimits: ["1", "50"], forWallet: true, live: true });
    expect(() => parseArgs(["set-batch-limits", "1", "--for-wallet", "--live"])).toThrow("set-batch-limits needs the most deposits and the most redeem requests a batch holds, each 1 to 50: set-batch-limits <maxDeposits> <maxRedeems>");
    expect(() => parseArgs(["set-batch-limits", "0", "50", "--for-wallet", "--live"])).toThrow("set-batch-limits: 0 is not a whole number from 1 to 50");
    // the sign page sends it, the front door's alone
    expect(KNOWN_ABI.map((f) => f.name)).toContain("setBatchLimits");
  });

  it("R5 Minor 3: set-claim-gas: the owner's setClaimGasRequired(gas) to the vault, one call, at once either way; outside 54,100,000 to 63,400,000, or the same value, refused, writing nothing", async () => {
    const w = liveWorld();
    call(w, "bittensor", plan.addresses.vault, "setClaimGasRequired", (args, from) => owner(from) ?? (BigInt(args[0] as bigint) < 54_100_000n || BigInt(args[0] as bigint) > 63_400_000n ? revert("InvalidParameter") : undefined));
    w.book.bittensor[plan.addresses.vaultLens.toLowerCase()].answers.claimGasRequired = 55_000_000n;
    const r = await claimGasFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("claim-gas"), gas: 58_000_000n });
    expect(readFile(r.files[0]).calls.map((c) => [c.chainId, c.to, c.from, c.data])).toEqual([[964, plan.addresses.vault, plan.roles.owner, encodeFunctionData({ abi: build.vaultAbi, functionName: "setClaimGasRequired", args: [58_000_000n] })]]);
    expect(r.lines[0]).toBe(
      `Bittensor vault ${plan.addresses.vault}: setClaimGasRequired(58000000) from the owner ${plan.roles.owner} would succeed now: it moves claimGasRequired from 55,000,000 to 58,000,000 at once (immediate either way, within 54,100,000 to 63,400,000); the keeper then sends each claim with 60,000,000 gas.`,
    );
    const dir = tempDir("claim-gas-refused");
    for (const [gas, why] of [
      [54_099_999n, "setClaimGasRequired(54099999) is outside the vault's bounds, 54,100,000 to 63,400,000 (MIN_CLAIM_GAS and MAX_CLAIM_GAS); nothing written"],
      [63_400_001n, "setClaimGasRequired(63400001) is outside the vault's bounds, 54,100,000 to 63,400,000 (MIN_CLAIM_GAS and MAX_CLAIM_GAS); nothing written"],
      [55_000_000n, "claimGasRequired is 55,000,000 already; nothing written"],
    ] as [bigint, string][]) {
      await expect(claimGasFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("x"), dir, gas }), String(gas)).rejects.toThrow(why);
    }
    expect(filesIn(dir)).toEqual([]);
  });

  it("set-idle-buffer: the owner's immediate raise; a lowering, or the same value, refused, writing nothing", async () => {
    const w = liveWorld();
    call(w, "bittensor", plan.addresses.vault, "setIdleBuffer", (args, from) => owner(from) ?? (BigInt(args[0] as bigint) > 1_000n ? revert("InvalidParameter") : undefined));
    w.book.bittensor[plan.addresses.vaultLens.toLowerCase()].answers.idleBufferBps = 100;
    const r = await idleBufferFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("idle-buffer"), bps: 240n });
    expect(readFile(r.files[0]).calls.map((c) => [c.to, c.from, c.data])).toEqual([[plan.addresses.vault, plan.roles.owner, encodeFunctionData({ abi: build.vaultAbi, functionName: "setIdleBuffer", args: [240n] })]]);
    expect(r.lines[0]).toContain("setIdleBuffer(240) from the owner");
    expect(r.lines[0]).toContain("raises idleBufferBps from 100 to 240 at once");
    const dir = tempDir("idle-buffer-refused");
    await expect(idleBufferFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("x"), dir, bps: 50n })).rejects.toThrow(
      "setIdleBuffer(50) lowers the idle buffer (100 now): a lowering waits 48 hours, the guardian may veto it: pnpm ops schedule vault setIdleBuffer 50 --for-wallet --live; nothing written",
    );
    await expect(idleBufferFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("x"), dir, bps: 100n })).rejects.toThrow("idleBufferBps is 100 already; nothing written");
    await expect(idleBufferFileCommand(rpcOf(w).ctx, liveRecord(), { ...files("x"), dir, bps: 1_001n })).rejects.toThrow("setIdleBuffer(1001) is above the most idleBufferBps may be (1,000: 10%); nothing written");
    expect(filesIn(dir)).toEqual([]);
  });
});
