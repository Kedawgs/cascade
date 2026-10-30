import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getAddress } from "viem";
import { parseArgs } from "./d1.ts";

// pnpm config:from-record ../ops/deployments/v3-test.json [--setup-ends-base <block>] [--setup-ends-bittensor <block>]
//
// Prints the DEPLOYMENT var for wrangler.jsonc from a verified ops deployment record (spec section 11, step
// 6): the contracts' addresses checksummed (the Worker refuses any other spelling), each chain's start block
// (Bittensor's is the Bittensor adapter's creation block, exactly the site's NEXT_PUBLIC_CASCADE_BIT_BLOCK,
// so the seed's `from` matches the site's scans), each chain's baseline (the last block of the deployment's
// own setup, whose admin events aren't alerts: the record's last step on that chain, or a later block given
// with --setup-ends-<chain>, such as the final owner's acceptOwnership, which the record doesn't hold), the
// vault's coldkey and stake hotkey, and the keeper's close wait.
// It only reads the record; paste what it prints into the environment's vars.

/** The keeper's extra close wait by cadence (ops/src/config.ts CADENCE; a test compares them). */
export const CLOSE_MAX_WAIT_S: Readonly<Record<string, number>> = { test: 0, launch: 86_400 };

/** The ops record's JSON reviver: bigints are written as { $bigint: "…" } (ops/src/record.ts). */
const reviver = (_k: string, v: unknown) => (v && typeof v === "object" && "$bigint" in v ? BigInt((v as { $bigint: string }).$bigint) : v);

interface RecordLike {
  plan?: { version?: unknown; cadence?: unknown; addresses?: Record<string, unknown>; steps?: { id?: unknown; chain?: unknown; args?: unknown[] }[] };
  done?: Record<string, { block?: unknown; recovered?: unknown } | undefined>;
  verify?: { ok?: unknown; checkedAt?: unknown };
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const blockOf = (step: { block?: unknown } | undefined): number | undefined => (step && typeof step.block === "number" && Number.isSafeInteger(step.block) && step.block >= 0 ? step.block : undefined);

export interface FromRecord {
  deployment: {
    base: { chainId: 8453; startBlock: string; baselineBlock: string };
    bittensor: { chainId: 964; startBlock: string; baselineBlock: string };
    frontDoor: string;
    baseAdapter: string;
    staker: string;
    oracle: string;
    vault: string;
    bitAdapter: string;
    vaultColdkey: string;
    stakeHotkey: string;
    batchMaxWaitS: number;
  };
  /** the default BRIDGES: the deployment's own adapters */
  bridges: { base: string[]; bittensor: string[] };
  /** what the owner should know about how a value was found */
  notes: string[];
}

/** Where each chain's setup ends, when later than the record's last step there (--setup-ends-<chain>). */
export interface SetupEnds {
  base?: number;
  bittensor?: number;
}

/** The DEPLOYMENT var of a verified v3 record. Throws, saying why, for a record it won't use, or a setup
 * end before the record's own last step on that chain (that step's admin events would become alerts). */
export function deploymentFromRecord(raw: unknown, o: { setupEnds?: SetupEnds } = {}): FromRecord {
  if (!isObject(raw)) throw new Error("the file isn't a deployment record");
  const rec = raw as RecordLike;
  if (rec.verify?.ok !== true) throw new Error("the deployment's read-back hasn't passed (verify.ok): run pnpm ops verify first");
  const plan = rec.plan;
  if (!plan || plan.version !== 3) throw new Error("the record isn't a v3 deployment: the monitor watches v3 deployments only");
  const cadence = plan.cadence === undefined ? "test" : plan.cadence;
  if (typeof cadence !== "string" || !(cadence in CLOSE_MAX_WAIT_S)) throw new Error(`the record's plan has a cadence "${String(plan.cadence)}" this script doesn't know`);
  const a = plan.addresses ?? {};
  const address = (role: string) => {
    const x = a[role];
    if (typeof x !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(x)) throw new Error(`the record has no address for ${role}`);
    return getAddress(x);
  };
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
  const baseline = (chain: "base" | "bittensor", blocks: number[], start: number) => {
    const recorded = Math.max(start, ...blocks);
    const ends = o.setupEnds?.[chain];
    if (ends === undefined) return String(recorded);
    const label = chain === "base" ? "Base" : "Bittensor";
    if (ends < recorded) throw new Error(`--setup-ends-${chain} ${ends} is before the record's last ${label} step (${recorded}), whose events are setup`);
    if (ends > recorded) {
      notes.push(`${label}'s setup ends at block ${ends} (--setup-ends-${chain}), after the record's last ${label} step (${recorded}): no admin event up to it is an alert`);
    }
    return String(ends);
  };

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
  "usage: pnpm config:from-record <ops deployment record, e.g. ../ops/deployments/v3-test.json> [--setup-ends-base <block>] [--setup-ends-bittensor <block>]";

export async function main(argv: string[], o: { print: (line: string) => void; read: (path: string) => string }): Promise<number> {
  const a = parseArgs(argv, ["setup-ends-base", "setup-ends-bittensor"], []);
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
  let r: FromRecord;
  try {
    r = deploymentFromRecord(JSON.parse(o.read(path), reviver), { setupEnds });
  } catch (e) {
    o.print(`nothing printed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  o.print(`// DEPLOYMENT for the environment's "vars" in wrangler.jsonc, from ${path}`);
  for (const n of r.notes) o.print(`// note: ${n}`);
  o.print(`"DEPLOYMENT": ${JSON.stringify(r.deployment, null, 2)},`);
  o.print(`// BRIDGES needs no entry: it defaults to the deployment's own adapters, ${JSON.stringify(r.bridges)}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), { print: (l) => console.log(l), read: (p) => readFileSync(p, "utf8") }).then((c) => process.exit(c));
}
