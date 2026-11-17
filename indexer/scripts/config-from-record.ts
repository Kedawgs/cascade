import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getAddress } from "viem";
import { parseArgs } from "./d1.ts";

// pnpm config:from-record ../ops/deployments/v3-test.json [--setup-ends-base <block>] [--setup-ends-bittensor <block>] [--force]
//
// Prints the DEPLOYMENT var for wrangler.jsonc from a verified ops deployment record (spec section 11, step
// 6): the contracts' addresses checksummed (the Worker refuses any other spelling), each chain's start block
// (Bittensor's is the Bittensor adapter's creation block, exactly the site's NEXT_PUBLIC_CASCADE_BIT_BLOCK,
// so the seed's `from` matches the site's scans), each chain's baseline (the last block of the deployment's
// own setup, whose admin events aren't alerts: the record's last step on that chain, or a later block given
// with --setup-ends-<chain>, such as the final owner's acceptOwnership, which the record doesn't hold), the
// vault's coldkey and stake hotkey, and the keeper's close wait.
// A v3.2 record (plan version 32, ops/src/v32/deploy.ts's DeploymentRecordV32 as the v3.2-ops branch has it, Task 43):
// also `version` "v3.2", both lenses, `stage` "early" (the founder level: Task 55's admin.owner_kind reads it), each
// chain's start at its first create (the constructors log their settings, so the scans must start at or before it),
// the coldkey and stake hotkey from the plan (the vault's constructor takes a struct), and STANDBY_HOTKEY from the
// plan's standby validator. Only a live record whose every create is done; a rehearsal's or a voided plan is refused.
// It only reads the record; paste what it prints into the environment's vars.

/** The keeper's extra close wait by cadence (ops/src/config.ts CADENCE; a test compares them). */
export const CLOSE_MAX_WAIT_S: Readonly<Record<string, number>> = { test: 0, launch: 86_400 };

/** The ops record's JSON reviver: bigints are written as { $bigint: "…" } (ops/src/record.ts). */
const reviver = (_k: string, v: unknown) => (v && typeof v === "object" && "$bigint" in v ? BigInt((v as { $bigint: string }).$bigint) : v);

interface RecordLike {
  /** v3.2: "live", or "rehearsal" (the forks) */
  target?: unknown;
  plan?: {
    version?: unknown;
    cadence?: unknown;
    addresses?: Record<string, unknown>;
    steps?: { id?: unknown; chain?: unknown; args?: unknown[] }[];
    /** v3.2: the vault's coldkey and the validators (the primary is the stake hotkey; the standby is recorded only) */
    vaultColdkey?: unknown;
    validators?: { primary?: unknown; standby?: unknown };
  };
  done?: Record<string, { block?: unknown; recovered?: unknown } | undefined>;
  verify?: { ok?: unknown; checkedAt?: unknown };
  /** v3.2: set when the plan can no longer be deployed */
  void?: { reason?: unknown };
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const blockOf = (step: { block?: unknown } | undefined): number | undefined => (step && typeof step.block === "number" && Number.isSafeInteger(step.block) && step.block >= 0 ? step.block : undefined);

export interface FromRecord {
  deployment: {
    /** v3.2 only: the contracts' version, the site's stage, and the two lenses */
    version?: "v3.2";
    stage?: "early";
    base: { chainId: 8453; startBlock: string; baselineBlock: string };
    bittensor: { chainId: 964; startBlock: string; baselineBlock: string };
    frontDoor: string;
    doorLens?: string;
    baseAdapter: string;
    staker: string;
    oracle: string;
    vault: string;
    vaultLens?: string;
    bitAdapter: string;
    vaultColdkey: string;
    stakeHotkey: string;
    batchMaxWaitS: number;
  };
  /** v3.2: the STANDBY_HOTKEY var, the plan's standby validator (absent when none is recorded) */
  standbyHotkey?: string;
  /** the default BRIDGES: the deployment's own adapters */
  bridges: { base: string[]; bittensor: string[] };
  /** what the owner should know about how a value was found */
  notes: string[];
}

/** How far past the record's last step a setup end may be without --force, in time: about 2.3 days on Base and 14 on
 * Bittensor, what 100,000 blocks meant on Base's 2-second and Bittensor's 12-second blocks. Further is likely a typo or the
 * other chain's block, and every admin event up to it would be hidden. In blocks at the chain's block time, measured
 * (setupEndsMaxPast): Base's went to 200 ms at block 53,556,128, where 100,000 blocks are about 5.5 hours. */
export const SETUP_ENDS_MAX_PAST_S: Record<"base" | "bittensor", number> = { base: 200_000, bittensor: 1_200_000 };
/** The block times the limit was set at, which count it while a chain's own can't be read (100,000 blocks either way). */
const SET_AT_S: Record<"base" | "bittensor", number> = { base: 2, bittensor: 12 };

/** SETUP_ENDS_MAX_PAST_S in `chain`'s blocks at `blockS` seconds a block (measured), or at the block time it was set at
 * while that is unknown. */
export const setupEndsMaxPast = (chain: "base" | "bittensor", blockS: number | undefined): number => Math.ceil(SETUP_ENDS_MAX_PAST_S[chain] / (blockS ?? SET_AT_S[chain]));

/** About how long `seconds` is, in words: "about 2.3 days", "about 5.5 hours". */
const about = (seconds: number) => (seconds >= 86_400 ? `about ${(seconds / 86_400).toFixed(1)} days` : `about ${(seconds / 3600).toFixed(1)} hours`);

/** Public RPCs that answer a header with no key (read-only): each chain's block time is read there for a setup end. */
export const PUBLIC_RPC: Record<"base" | "bittensor", string> = { base: "https://mainnet.base.org", bittensor: "https://lite.chain.opentensor.ai" };

/** How long one header read may take before it counts as failed. */
const HEADER_TIMEOUT_MS = 10_000;
/** The block times a reading is believed between (seconds a block): anything outside is a node's error, read as unread. */
const BLOCK_S_BOUNDS = { min: 0.05, max: 60 };

/** A chain's seconds a block, from a public RPC's headers: the faster of two spans back from the head (Base 1,000 blocks
 * each, Bittensor 300), so a halt in one never reads it slow. Throws (the caller then holds the limit as it was set) when a
 * header can't be read within HEADER_TIMEOUT_MS, or the block time it gives is outside BLOCK_S_BOUNDS. */
export async function publicBlockTimeOf(chain: "base" | "bittensor", fetchFn: typeof fetch = fetch): Promise<number> {
  const header = async (tag: string): Promise<{ block: number; time: number }> => {
    const res = await fetchFn(PUBLIC_RPC[chain], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [tag, false] }),
      signal: AbortSignal.timeout(HEADER_TIMEOUT_MS),
    });
    const json = (await res.json()) as { result?: { number: string; timestamp: string } | null };
    if (!json.result) throw new Error(`${chain}: no header for ${tag}`);
    return { block: Number(BigInt(json.result.number)), time: Number(BigInt(json.result.timestamp)) };
  };
  const span = chain === "base" ? 1_000 : 300;
  const head = await header("latest");
  const mid = await header(`0x${Math.max(0, head.block - span).toString(16)}`);
  const old = await header(`0x${Math.max(0, mid.block - span).toString(16)}`);
  const rates = [
    [old, mid],
    [mid, head],
  ]
    .filter(([a, b]) => b.block > a.block && b.time > a.time)
    .map(([a, b]) => (b.time - a.time) / (b.block - a.block));
  if (!rates.length) throw new Error(`${chain}: its blocks are not apart in time`);
  const s = Math.min(...rates);
  if (!(s >= BLOCK_S_BOUNDS.min && s <= BLOCK_S_BOUNDS.max)) throw new Error(`${chain}: ${s} s a block is outside ${BLOCK_S_BOUNDS.min} to ${BLOCK_S_BOUNDS.max} s`);
  return s;
}

/** Where each chain's setup ends, when later than the record's last step there (--setup-ends-<chain>). */
export interface SetupEnds {
  base?: number;
  bittensor?: number;
}

/** `blockS`: each chain's seconds a block, measured (main reads it for a setup end given on that chain). */
type Options = { setupEnds?: SetupEnds; force?: boolean; blockS?: Partial<Record<"base" | "bittensor", number>> };

/** A chain's baseline: the record's last step there (at least `start`), or a later --setup-ends-<chain>, which may not
 * come before it, nor more than SETUP_ENDS_MAX_PAST_S after it (in blocks at the chain's block time: setupEndsMaxPast)
 * without --force. */
function baselineOf(chain: "base" | "bittensor", blocks: number[], start: number, o: Options, notes: string[]): string {
  const recorded = Math.max(start, ...blocks);
  const ends = o.setupEnds?.[chain];
  if (ends === undefined) return String(recorded);
  const label = chain === "base" ? "Base" : "Bittensor";
  if (ends < recorded) throw new Error(`--setup-ends-${chain} ${ends} is before the record's last ${label} step (${recorded}), whose events are setup`);
  const past = ends - recorded;
  const blockS = o.blockS?.[chain];
  const maxPast = setupEndsMaxPast(chain, blockS);
  if (past > maxPast && !o.force) {
    const how = blockS === undefined ? `${SET_AT_S[chain]} s, the block time it was set at: ${label}'s block time wasn't read` : `${blockS} s`;
    throw new Error(
      `--setup-ends-${chain} ${ends} is ${past.toLocaleString("en-US")} blocks past the record's last ${label} step (${recorded}), more than ${maxPast.toLocaleString("en-US")} (${about(SETUP_ENDS_MAX_PAST_S[chain])} of ${label}'s blocks at ${how}): check the block, or pass --force`,
    );
  }
  if (ends > recorded) {
    notes.push(`${label}'s setup ends at block ${ends} (--setup-ends-${chain}), after the record's last ${label} step (${recorded}): no admin event up to it is an alert`);
  }
  if (past > maxPast) notes.push(`--force: ${label}'s setup end is ${past.toLocaleString("en-US")} blocks past the record's last ${label} step`);
  return String(ends);
}

const addressIn = (a: Record<string, unknown>, role: string) => {
  const x = a[role];
  if (typeof x !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(x)) throw new Error(`the record has no address for ${role}`);
  return getAddress(x);
};
const bytes32Of = (x: unknown, what: string) => {
  if (typeof x !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(x)) throw new Error(`the record has no ${what} (32 bytes of hex)`);
  return x.toLowerCase();
};

/** The DEPLOYMENT var (and STANDBY_HOTKEY) of a verified, finished, live v3.2 record. */
function fromV32(rec: RecordLike, o: Options): FromRecord {
  const plan = rec.plan as NonNullable<RecordLike["plan"]>;
  if (rec.target !== "live") throw new Error(`the record is a ${String(rec.target)} record (a rehearsal runs on the forks): the monitor watches a live deployment only`);
  if (rec.void) throw new Error(`the record's plan is void (${String(rec.void.reason ?? "no reason recorded")}): there is no deployment to watch`);
  const done = rec.done ?? {};
  const steps = plan.steps ?? [];
  const blocks: Record<"base" | "bittensor", { id: string; block: number }[]> = { base: [], bittensor: [] };
  for (const s of steps) {
    const block = typeof s.id === "string" ? blockOf(done[s.id]) : undefined;
    if (block === undefined) throw new Error(`the deployment isn't finished: ${String(s.id)} has no block in the record (run deploy again)`);
    if (s.chain === "base" || s.chain === "bittensor") blocks[s.chain].push({ id: s.id as string, block });
  }
  const notes: string[] = [];
  const LABEL = { base: "Base", bittensor: "Bittensor" } as const;
  const ADAPTER = { base: "baseAdapter", bittensor: "bitAdapter" } as const;
  // each chain from its first create: the constructors log their settings (the vault its hotkey and door too)
  const startOf = (chain: "base" | "bittensor") => {
    if (blocks[chain].length === 0) throw new Error(`the record has no ${LABEL[chain]} step`);
    const first = blocks[chain].reduce((a, b) => (b.block < a.block ? b : a));
    if (first.id !== ADAPTER[chain]) notes.push(`the first create on ${LABEL[chain]} is the ${first.id}'s, at block ${first.block}, before the adapter's: ${LABEL[chain]} starts there, so its constructor's events are read`);
    return first.block;
  };
  const baseStart = startOf("base");
  const bitStart = startOf("bittensor");
  const a = plan.addresses ?? {};
  const standby = plan.validators?.standby;
  notes.push('stage "early": the founder level; set it to "live" once Cascade is past it (admin.owner_kind warns then without a Safe)');
  const deployment: FromRecord["deployment"] = {
    version: "v3.2",
    stage: "early",
    base: { chainId: 8453, startBlock: String(baseStart), baselineBlock: baselineOf("base", blocks.base.map((b) => b.block), baseStart, o, notes) },
    bittensor: { chainId: 964, startBlock: String(bitStart), baselineBlock: baselineOf("bittensor", blocks.bittensor.map((b) => b.block), bitStart, o, notes) },
    frontDoor: addressIn(a, "frontDoor"),
    doorLens: addressIn(a, "doorLens"),
    baseAdapter: addressIn(a, "baseAdapter"),
    staker: addressIn(a, "staker"),
    oracle: addressIn(a, "oracle"),
    vault: addressIn(a, "vault"),
    vaultLens: addressIn(a, "vaultLens"),
    bitAdapter: addressIn(a, "bitAdapter"),
    vaultColdkey: bytes32Of(plan.vaultColdkey, "vault coldkey in its plan"),
    stakeHotkey: bytes32Of(plan.validators?.primary, "stake hotkey (the plan's primary validator)"),
    // a v3.2 plan has no cadence: v3.2 is the launch
    batchMaxWaitS: CLOSE_MAX_WAIT_S.launch,
  };
  return {
    deployment,
    ...(standby === undefined ? {} : { standbyHotkey: bytes32Of(standby, "standby validator hotkey in its plan") }),
    bridges: { base: [deployment.baseAdapter], bittensor: [deployment.bitAdapter] },
    notes,
  };
}

/** The DEPLOYMENT var of a verified v3 or v3.2 record. Throws, saying why, for a record it won't use, or a setup
 * end before the record's own last step on that chain (that step's admin events would become alerts). */
export function deploymentFromRecord(raw: unknown, o: Options = {}): FromRecord {
  if (!isObject(raw)) throw new Error("the file isn't a deployment record");
  const rec = raw as RecordLike;
  if (rec.verify?.ok !== true) throw new Error("the deployment's read-back hasn't passed (verify.ok): run pnpm ops verify first");
  const plan = rec.plan;
  if (plan?.version === 32) return fromV32(rec, o);
  if (!plan || plan.version !== 3) throw new Error("the record isn't a v3 or v3.2 deployment: the monitor watches those only");
  const cadence = plan.cadence === undefined ? "test" : plan.cadence;
  if (typeof cadence !== "string" || !(cadence in CLOSE_MAX_WAIT_S)) throw new Error(`the record's plan has a cadence "${String(plan.cadence)}" this script doesn't know`);
  const a = plan.addresses ?? {};
  const address = (role: string) => addressIn(a, role);
  const done = rec.done ?? {};
  const steps = plan.steps ?? [];

  const bit = done.bitAdapter;
  const bitStart = blockOf(bit);
  if (bitStart === undefined) {
    throw new Error(
      `the record has no block for the Bittensor adapter's creation${bit?.recovered ? " (it was recovered, not recorded)" : ""}, where every Bittensor log scan starts: run deploy again to find it`,
    );
  }
  const notes: string[] = [];
  const chainBlocks = (chain: string) => steps.filter((s) => s.chain === chain).flatMap((s) => (typeof s.id === "string" ? [blockOf(done[s.id])] : [])).filter((b): b is number => b !== undefined);
  const baseBlocks = chainBlocks("base");
  let baseStart = blockOf(done.baseAdapter);
  if (baseStart === undefined) {
    if (baseBlocks.length === 0) throw new Error("the record has no block for any Base step: run deploy again to record them");
    baseStart = Math.min(...baseBlocks);
    notes.push(`the Base adapter's creation block isn't in the record (it was recovered): Base starts at the first Base step recorded, block ${baseStart}`);
  }
  const bitBlocks = chainBlocks("bittensor");
  const baseline = (chain: "base" | "bittensor", blocks: number[], start: number) => baselineOf(chain, blocks, start, o, notes);

  const vaultStep = steps.find((s) => s.id === "vault");
  const [coldkey, hotkey] = (vaultStep?.args ?? []) as unknown[];
  const bytes32 = (x: unknown, what: string) => {
    if (typeof x !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(x)) throw new Error(`the record's vault step has no ${what}`);
    return x.toLowerCase();
  };

  const deployment: FromRecord["deployment"] = {
    base: { chainId: 8453, startBlock: String(baseStart), baselineBlock: baseline("base", baseBlocks, baseStart) },
    bittensor: { chainId: 964, startBlock: String(bitStart), baselineBlock: baseline("bittensor", bitBlocks, bitStart) },
    frontDoor: address("frontDoor"),
    baseAdapter: address("baseAdapter"),
    staker: address("staker"),
    oracle: address("oracle"),
    vault: address("vault"),
    bitAdapter: address("bitAdapter"),
    vaultColdkey: bytes32(coldkey, "vault coldkey"),
    stakeHotkey: bytes32(hotkey, "stake hotkey"),
    batchMaxWaitS: CLOSE_MAX_WAIT_S[cadence],
  };
  return { deployment, bridges: { base: [deployment.baseAdapter], bittensor: [deployment.bitAdapter] }, notes };
}

const USAGE =
  "usage: pnpm config:from-record <ops deployment record, e.g. ../ops/deployments/v3-test.json> [--setup-ends-base <block>] [--setup-ends-bittensor <block>] [--force]";

export async function main(
  argv: string[],
  o: { print: (line: string) => void; read: (path: string) => string; blockTimeOf?: (chain: "base" | "bittensor") => Promise<number> },
): Promise<number> {
  const a = parseArgs(argv, ["setup-ends-base", "setup-ends-bittensor"], ["force"]);
  const usage = (why?: string) => {
    if (why) o.print(why);
    o.print(USAGE);
    return 2;
  };
  if ("error" in a) return usage(a.error);
  const path = a.words[0];
  if (!path || a.words.length > 1) return usage();
  const setupEnds: SetupEnds = {};
  for (const chain of ["base", "bittensor"] as const) {
    const v = a.opts[`setup-ends-${chain}`];
    if (v === undefined) continue;
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) return usage(`--setup-ends-${chain} must be a block number, not ${v}`);
    setupEnds[chain] = Number(v);
  }
  // each chain's block time, for a setup end given on it (its limit is a time): read from its public RPC; unread, the
  // limit counts at the block time it was set at
  const blockS: Partial<Record<"base" | "bittensor", number>> = {};
  for (const chain of ["base", "bittensor"] as const) {
    if (setupEnds[chain] === undefined) continue;
    try {
      blockS[chain] = await (o.blockTimeOf ?? publicBlockTimeOf)(chain);
    } catch (e) {
      o.print(`// note: ${chain === "base" ? "Base" : "Bittensor"}'s block time couldn't be read (${e instanceof Error ? e.message : String(e)}): its setup end is held to the limit as it was set`);
    }
  }
  let r: FromRecord;
  try {
    r = deploymentFromRecord(JSON.parse(o.read(path), reviver), { setupEnds, force: a.flags.has("force"), blockS });
  } catch (e) {
    o.print(`nothing printed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  o.print(`// DEPLOYMENT for the environment's "vars" in wrangler.jsonc, from ${path}`);
  for (const n of r.notes) o.print(`// note: ${n}`);
  o.print(`"DEPLOYMENT": ${JSON.stringify(r.deployment, null, 2)},`);
  if (r.standbyHotkey) {
    o.print("// the standby validator the plan recorded: its take, root stake and root uid are read and judged beside the stake hotkey's");
    o.print(`"STANDBY_HOTKEY": ${JSON.stringify(r.standbyHotkey)},`);
  }
  o.print(`// BRIDGES needs no entry: it defaults to the deployment's own adapters, ${JSON.stringify(r.bridges)}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), { print: (l) => console.log(l), read: (p) => readFileSync(p, "utf8") }).then((c) => process.exit(c));
}
