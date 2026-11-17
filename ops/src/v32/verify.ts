import {
  type Abi,
  type AbiFunction,
  type Address,
  decodeErrorResult,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  getAddress,
  type Hex,
  hexToBigInt,
  hexToNumber,
  isAddress,
  keccak256,
  numberToHex,
  parseAbi,
  stringToBytes,
  zeroAddress,
} from "viem";
import { cardinalityNeededNow, POOL_ABI } from "../cardinality.ts";
import { BASE_V3, type ChainName, LIVE, PRECOMPILE } from "../config.ts";
import { adapterCapProblems, type AdapterCapInputs } from "../plan.ts";
import { loadRecord, saveRecord, type VerifyResult } from "../record.ts";
import { balanceOf, chainIdOf, isEvmHalt, isRevert, read, RpcError } from "../rpc.ts";
import { RAIL_VIEWS } from "../keeper/core/abi.ts";
import { RAIL_VIEW_CALL_GAS, RAIL_VIEW_GAS } from "../keeper/core/v32/reads.ts";
import { type Ctx, chainLabel } from "../send.ts";
import { BUILDS_DIR, type BuildV32, buildErrorsV32, loadBuildV32 } from "./build.ts";
import { MS_PER_BLOCK_PINS, SCHEDULED_V32, type SchedulableV32 } from "./classes.ts";
import { codeReadBacksV32, domainSeparatorV32 } from "./code.ts";
import { type DeploymentRecordV32, FRESH_KEYS, loadRecordV32For, ownerKindOf } from "./deploy.ts";
import { type DoorRead, readDoor, readDoorLens, readVault, readVaultLens, type VaultRead } from "./lens.ts";
import { addressMapping, type V32StepId } from "./plan.ts";
import { pendingRailChanges, type RailHeads, type RailState, railHeads, railsFindings, readRails } from "./rails.ts";
import { firstLine, iso, itemText, lapsed, type PendingItem, pendingOn, type SchedulerContract, stateOf } from "./scheduler.ts";
import { ALPHA_READ_GAS, capsWarning, FUNDING_V32, type OwnerKind, ownerDescription, WRITE_OFF_READ_GAS } from "./settings.ts";
import { EXIT_GAS_RESERVE } from "../keeper/core/v32/payout.ts";
import { validatorFindings } from "./validators.ts";

// the tables that moved to classes.ts (Task 46b), under the names they had here
export { MS_PER_BLOCK_PINS, SCHEDULED_V32, type SchedulableV32 };

// v3.2's `pnpm ops verify` (spec §7 step 3; plan Task 46, dispatched as 46a): what the founder runs before trusting a
// deployment with money. It proves the deployment is exactly what was planned:
// - the code, through Task 45's read-backs (code.ts codeReadBacksV32): every contract, library and lens, filled in from
//   the plan, never blanked;
// - the state, read through the lenses where the getter moved (spec §8.1, ruling C2) and from the contracts where they
//   kept it: the roles and the owner's kind, the launch chain and its door, the exits open, no stake missing, the stake
//   hotkey, the treasuries, the oracle (its tokens are the front door's and the staker's, its pools and fee tiers are
//   route 0's: R3 C-I4) with its pools' history and depth, the floors, the constructor's limits, the block times (each
//   chain's as the deploy calibrates it, in milliseconds, 7,200 and 120, whatever the plan says: the R1 re-review's pins
//   since Revision 28), the scheduler's class table,
//   the stamp's domain, the cap relations across the pair, the lane's inbound gas model (the Bittensor adapter's copy
//   is the Base adapter's own pair, R4) and the validators.
// The rules (the controller's, for 46a):
// - every lens check reads a value that is non-zero by construction (rev 12 M-2): on the vault lens its guardian,
//   keeper, treasury, hotkeys(0), stakeHotkey, payoutDelay, maxEntryValue, the launch door's state (Active) and
//   lastStakeAt (the vault's creation time), with the other limits and bridges; on the door lens its guardian, keeper,
//   primaryBridge and that bridge's bridgeEnabled. A lens check whose planned value an empty slot also reads (0, false,
//   OPEN: the exits, the stake guard, the booked stake, a zero limit) proves nothing on its own, so it passes only once
//   one of its lens's non-zero reads has matched the plan, which no lens reading an empty target can; otherwise it
//   fails, saying so;
// - what the vault outgrows after its deploy is read as it grows, so a later verify still passes a healthy vault:
//   lastStakeAt is its creation time or a later stake's (never 0, never after the head), and the booked stake is 0
//   until its first stake and is reported after it;
// - one failure line per wrong value, naming the chain, the contract, the read, the expected and the actual; a read that
//   fails is a failure, never a pass, and nothing is skipped silently;
// - a library's or a lens's balance is reported, never a failure (rev 12 L-4).
// Task 46b adds what is reported, never compared with the plan: the exits on both chains (who holds them closed, and
// each clock), the Bittensor adapter's parks and its reserve and cushion beyond them, and the scheduler's pending items
// (Task 47's pendingOn, chain by chain, so an id pending on both is listed on each); and the Safe warning (spec §7): a
// deposit cap or maxTotalAssets above the founder level, read now or in a pending item, while that chain's owner (its
// owner() as read now) is not a Safe of at least 2 of 3, warns, quoting section 5, and never fails (an EIP-7702 delegated account is an account).
// A report's read that fails is a failure, as every read here is. The retirement guards are retire.ts's.

export interface FindingsV32 {
  failures: string[];
  warnings: string[];
  /** Reported only: what the founder reads (the owner's kind, the validators, the pools' depth, a forced balance). */
  info: string[];
}

export interface VerifyV32Result extends FindingsV32 {
  /** What signs for the owner on each chain, as read (Task 46b's Safe warning reads it). */
  owners: Partial<Record<ChainName, OwnerKind>>;
}

/** The owner stamp's EIP-712 type hash (CascadeConstants.STAMP_TYPEHASH). */
export const STAMP_TYPEHASH_V32: Hex = keccak256(stringToBytes("OwnerStamp(uint64 asOf)"));

/** CascadeConstants.DIRECT_ORIGIN: the redeem origin of a holder on Bittensor itself. */
export const DIRECT_ORIGIN = (1n << 64n) - 1n;

/** CascadeTypes.DoorState.Active. */
const DOOR_ACTIVE = 1;

const STAKING_VIEWS = parseAbi(["function getRejectStakingHotkeyGrowth(bytes32 coldkey) view returns (bool)"]);
const POOL_FEE = parseAbi(["function fee() view returns (uint24)"]);

// ---- the scheduler's class table (spec §3.6): SCHEDULED_V32, in classes.ts ----

/** Calldata `schedule` must refuse with UnknownSelector, besides any selector of its own: a made-up selector, the
 * scheduler's own entry points (I-25: nothing reaches schedule or execute through execute) and an owner setter that
 * acts at once (setKeeper). */
export const UNKNOWN_PROBES = ["0xdeadbeef", "schedule", "execute", "setKeeper"] as const;

/** A fresh address for a probe (ruling B19): no contract, no role and no door, so an activation's probe never meets
 * AlreadyActive and a guardian's never the owner. Derived from `label`, so every run probes the same one. */
export const probeAddress = (label: string): Address => getAddress(keccak256(stringToBytes(`cascade v3.2 verify probe: ${label}`)).slice(0, 42));

const fnOf = (abi: Abi, name: string): AbiFunction => {
  const f = abi.filter((x): x is AbiFunction => x.type === "function" && x.name === name);
  if (f.length !== 1) throw new Error(`the frozen build's ABI has ${f.length} functions ${name}: the class table cannot be probed; nothing read`);
  return f[0];
};

const signatureOf = (f: AbiFunction) => `${f.name}(${f.inputs.map((p) => p.type).join(",")})`;

/** `fn`'s canonical calldata for a probe: fresh addresses and words (B19), 1 for a number, and for activateFrontDoor
 * the launch chain (`launchChain`), which is the only chain a door is planned on. */
export function probeCalldata(abi: Abi, contract: string, fn: string, launchChain: bigint): Hex {
  const f = fnOf(abi, fn);
  const args = f.inputs.map((p, i) => {
    const label = `${contract}.${fn}.${i}`;
    if (fn === "activateFrontDoor" && i === 0) return launchChain;
    if (p.type === "address") return probeAddress(label);
    if (p.type === "bytes32") return keccak256(stringToBytes(`cascade v3.2 verify probe: ${label}`));
    if (/^u?int\d*$/.test(p.type)) return 1n;
    if (p.type === "bool") return true;
    if (p.type === "bytes") return "0x";
    throw new Error(`${signatureOf(f)} takes a ${p.type}, which a probe cannot make: nothing read`);
  });
  return encodeFunctionData({ abi, functionName: fn, args } as never);
}

/** What one `schedule(data)` from `from` answers by eth_call: the id it would schedule under, or the error it reverts
 * with (named from the build's errors), or a read that failed (the node did not run it). */
type ScheduleAnswer = { kind: "scheduled"; id: Hex } | { kind: "reverted"; error: string } | { kind: "unread"; why: string };

async function scheduleAnswer(ctx: Pick<Ctx, "rpc">, chain: ChainName, to: Address, from: Address, abi: Abi, errors: Abi, data: Hex): Promise<ScheduleAnswer> {
  const call = encodeFunctionData({ abi, functionName: "schedule", args: [data] } as never);
  try {
    const out = (await ctx.rpc.request(chain, "eth_call", [{ from, to, data: call }, "latest"])) as Hex;
    return { kind: "scheduled", id: decodeFunctionResult({ abi, functionName: "schedule", data: out } as never) as Hex };
  } catch (e) {
    if (!isRevert(e)) return { kind: "unread", why: (e as Error).message.split("\n")[0] };
    const raw = e instanceof RpcError ? e.data : undefined;
    const revert = typeof raw === "string" ? raw : (raw as { data?: unknown } | undefined)?.data;
    if (typeof revert === "string" && /^0x[0-9a-fA-F]{8,}$/.test(revert)) {
      try {
        const d = decodeErrorResult({ abi: errors, data: revert as Hex });
        return { kind: "reverted", error: `${d.errorName}(${(d.args ?? []).map(String).join(", ")})` };
      } catch {
        return { kind: "reverted", error: `revert data ${revert}` };
      }
    }
    return { kind: "reverted", error: (e as Error).message.split("\n")[0] };
  }
}

const told = (a: ScheduleAnswer) => (a.kind === "scheduled" ? `it scheduled under ${a.id}` : a.kind === "reverted" ? `a revert, ${a.error}` : `no answer (${a.why})`);

/** The scheduler's class table, by eth_call from the owner (spec §7 step 3; ruling B19): each schedulable function at its
 * canonical length is scheduled (under the id keccak256 of its calldata), the same with one word more reverts
 * BadCalldata, and each of UNKNOWN_PROBES reverts UnknownSelector. Nothing is sent: an eth_call changes nothing. */
export async function classTableFindings(
  ctx: Pick<Ctx, "rpc">,
  o: { chain: ChainName; name: string; table: readonly SchedulableV32[]; contract: "vault" | "frontDoor"; to: Address; owner: Address; abi: Abi; errors: Abi; launchChain: bigint },
): Promise<FindingsV32> {
  const out: FindingsV32 = { failures: [], warnings: [], info: [] };
  const who = (what: string) => `${chainLabel(o.chain)} ${o.name}.schedule(${what}), from the owner`;
  const unread = (what: string, a: ScheduleAnswer & { kind: "unread" }) => out.failures.push(`${who(what)}: could not be read (${a.why})`);
  let accepted = 0;
  for (const s of o.table) {
    const sig = signatureOf(fnOf(o.abi, s.fn));
    const data = probeCalldata(o.abi, o.contract, s.fn, o.launchChain);
    const id = keccak256(data);
    const a = await scheduleAnswer(ctx, o.chain, o.to, o.owner, o.abi, o.errors, data);
    if (a.kind === "unread") unread(sig, a);
    else if (a.kind !== "scheduled" || a.id.toLowerCase() !== id) out.failures.push(`${who(sig)}: expected it scheduled under ${id} (${s.delay}, ${s.kind}), found ${told(a)}`);
    else accepted++;
    const long = await scheduleAnswer(ctx, o.chain, o.to, o.owner, o.abi, o.errors, `${data}${"00".repeat(32)}`);
    if (long.kind === "unread") unread(`${sig} and one word more`, long);
    else if (long.kind !== "reverted" || long.error !== "BadCalldata()") out.failures.push(`${who(`${sig} and one word more`)}: expected the revert BadCalldata(), found ${told(long)}`);
  }
  for (const probe of UNKNOWN_PROBES) {
    const data = probe.startsWith("0x") ? (probe as Hex) : probeCalldata(o.abi, o.contract, probe, o.launchChain);
    const what = probe.startsWith("0x") ? probe : signatureOf(fnOf(o.abi, probe));
    const a = await scheduleAnswer(ctx, o.chain, o.to, o.owner, o.abi, o.errors, data);
    if (a.kind === "unread") unread(what, a);
    else if (a.kind !== "reverted" || a.error !== "UnknownSelector()") out.failures.push(`${who(what)}: expected the revert UnknownSelector(), found ${told(a)}`);
  }
  // only when every probe answered as the table says: the line names the long and the unknown probes too (Task 46a's
  // review, Minor 1)
  if (accepted === o.table.length && out.failures.length === 0) {
    out.info.push(
      `${chainLabel(o.chain)} ${o.name}'s scheduler: its ${o.table.length} schedulable functions are accepted at their canonical length and refused with one word more (BadCalldata); ${UNKNOWN_PROBES.length} other selectors are refused (UnknownSelector)`,
    );
  }
  return out;
}

// ---- the read-backs ----

const whole = (x: unknown): x is bigint | number => typeof x === "bigint" || (typeof x === "number" && Number.isInteger(x));

/** Addresses and hex without regard to case; integers by value (viem reads small ones as numbers); lists item by item. */
function same(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (whole(a) && whole(b)) return BigInt(a) === BigInt(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  return a === b;
}

/** A value as a failure shows it: an address checksummed, a list in parentheses. */
function show(x: unknown): string {
  if (typeof x === "string" && isAddress(x, { strict: false })) return getAddress(x);
  if (Array.isArray(x)) return `(${x.map(show).join(", ")})`;
  if (x === undefined) return "nothing";
  return String(x);
}

/** A value an empty slot also reads: 0, false, the zero address or word, nothing. */
const readsEmpty = (x: unknown): boolean =>
  x === false || x === undefined || (whole(x) && BigInt(x) === 0n) || (typeof x === "string" && /^0x0*$/.test(x)) || (Array.isArray(x) && x.every(readsEmpty));

type Lens = "vaultLens" | "doorLens";

/** One read-back: where it reads (`chain`, `contract`, `read`, its words) and what it must answer, `want` exactly or
 * `rule`. A lens check names its `lens`: one whose planned value an empty slot also reads (`empty`, by default when
 * `want` is such a value) proves nothing on its own, so it passes only once at least one of that lens's non-zero
 * checks has matched the plan (ReadBacks.settle). `warn`: a mismatch warns. */
interface Check {
  chain: ChainName;
  contract: string;
  read: string;
  get: () => Promise<unknown>;
  want?: unknown;
  rule?: { test: (v: unknown) => boolean; expected: string };
  lens?: Lens;
  empty?: boolean;
  warn?: boolean;
}

/** The read-backs as they run: their findings, the values read (for the cross-checks), and each lens's non-zero checks. */
class ReadBacks {
  readonly out: FindingsV32 = { failures: [], warnings: [], info: [] };
  readonly values = new Map<string, unknown>();
  /** How many of each lens's non-zero checks matched the plan. */
  private readonly anchored: Record<Lens, number> = { vaultLens: 0, doorLens: 0 };
  private readonly unanchored: { lens: Lens; who: string; value: unknown }[] = [];

  /** Runs `c`, keeping its value under `key` when given. */
  async check(c: Check, key?: string): Promise<unknown> {
    const who = `${chainLabel(c.chain)} ${c.contract}.${c.read}`;
    const empty = c.empty ?? (c.rule === undefined && readsEmpty(c.want));
    let v: unknown;
    try {
      v = await c.get();
    } catch (e) {
      this.out.failures.push(`${who}: could not be read (${(e as Error).message.split("\n")[0]})`);
      return undefined;
    }
    if (key) this.values.set(key, v);
    const ok = c.rule ? c.rule.test(v) : same(v, c.want);
    if (!ok) (c.warn ? this.out.warnings : this.out.failures).push(`${who}: expected ${c.rule ? c.rule.expected : show(c.want)}, found ${show(v)}`);
    // a non-zero value matched shows the lens reads its target's live storage; a value an empty slot also reads waits
    if (c.lens && ok) {
      if (!empty) this.anchored[c.lens]++;
      else this.unanchored.push({ lens: c.lens, who, value: v });
    }
    return v;
  }

  /** Each passing lens check an empty slot would also pass, failed unless one of its lens's non-zero checks passed:
   * then the lens reads its target's live storage, not an empty one. */
  settle(): void {
    for (const u of this.unanchored) {
      if (!this.anchored[u.lens]) {
        this.out.failures.push(`${u.who}: reads ${show(u.value)}, as planned, but so would an empty slot, and none of this lens's non-zero reads matched the plan: not checked`);
      }
    }
  }

  add(f: FindingsV32): void {
    this.out.failures.push(...f.failures);
    this.out.warnings.push(...f.warnings);
    this.out.info.push(...f.info);
  }
}

/** A path of route 0's form: a token, a 3-byte fee tier, a token, a fee tier, a token. */
function pathOf(path: unknown): { tokens: Address[]; fees: number[] } | null {
  if (typeof path !== "string" || !/^0x[0-9a-fA-F]{132}$/.test(path)) return null;
  const p = path.slice(2);
  return { tokens: [p.slice(0, 40), p.slice(46, 86), p.slice(92, 132)].map((t) => getAddress(`0x${t}`)), fees: [Number.parseInt(p.slice(40, 46), 16), Number.parseInt(p.slice(86, 92), 16)] };
}

const blockTime = async (ctx: Pick<Ctx, "rpc">, chain: ChainName, block: number | "latest"): Promise<number> => {
  const b = (await ctx.rpc.request(chain, "eth_getBlockByNumber", [block === "latest" ? "latest" : numberToHex(block), false])) as { timestamp: Hex } | null;
  if (!b) throw new Error(`${chainLabel(chain)} has no block ${block}`);
  return hexToNumber(b.timestamp);
};

/** Every read-back of spec §7 step 3 (see the top of this file) on a v3.2 record, with the record's frozen build (from
 * `buildsDir`, ops/builds/ by default). Refused, nothing read, when an RPC answers another chain's id than `ctx`'s, and
 * when the frozen build is missing or is not the record's. Saves nothing (verifyV32AndSave saves). */
export async function verifyV32(ctx: Pick<Ctx, "rpc" | "targets" | "logs" | "logsWindow">, rec: DeploymentRecordV32, opts: { buildsDir?: string } = {}): Promise<VerifyV32Result> {
  const buildsDir = opts.buildsDir ?? BUILDS_DIR;
  for (const chain of ["bittensor", "base"] as const) {
    const id = await chainIdOf(ctx.rpc, chain);
    if (id !== ctx.targets[chain].chainId) throw new Error(`${chainLabel(chain)}: the RPC reports chain id ${id}, not ${ctx.targets[chain].chainId}; nothing read`);
  }
  const build = loadBuildV32(rec.build, buildsDir);
  const plan = rec.plan;
  const r = new ReadBacks();
  const owners: Partial<Record<ChainName, OwnerKind>> = {};
  if (rec.void) r.out.failures.push(`the record's plan is void (${rec.void.reason}): ${FRESH_KEYS}`);

  // the code (Task 45): every contract, library and lens, filled in from the plan; balances as information
  const code = await codeReadBacksV32(ctx, rec, buildsDir);
  r.add({ failures: code.failures, warnings: [], info: code.info });

  const argsOf = (id: V32StepId) => plan.steps.find((s) => s.id === id)?.args;
  const missing = (["vault", "frontDoor", "staker"] as const).filter((id) => !argsOf(id));
  for (const id of missing) r.out.failures.push(`the record has no ${id} step: its constructor's settings are not compared`);

  await bittensorReadBacks(ctx, rec, build, buildsDir, r, owners);
  await baseReadBacks(ctx, rec, build, buildsDir, r, owners);

  // the cap relations across the pair (spec §3.9), as read now
  const caps: [keyof AdapterCapInputs, string][] = [
    ["baseCap", "Base CcipBaseAdapter.maxMessageValue()"],
    ["bitCap", "Bittensor CcipBittensorAdapter.maxMessageValue()"],
    ["minSendAmount", "Base CcipBaseAdapter.minSendAmount()"],
    ["maxBatchValue", "Base CascadeFrontDoor.maxBatchValue()"],
    ["vaultMaxMessageValue", "Bittensor CascadeVaultLens.maxMessageValue()"],
    ["maxEntryValue", "Bittensor CascadeVaultLens.maxEntryValue()"],
  ];
  const unread = caps.filter(([k]) => !whole(r.values.get(k))).map(([, what]) => what);
  if (unread.length) r.out.failures.push(`the cap relations across the pair are not checked: ${unread.join(", ")} could not be read`);
  else r.out.failures.push(...adapterCapProblems(Object.fromEntries(caps.map(([k]) => [k, BigInt(r.values.get(k) as bigint)])) as unknown as AdapterCapInputs));
  // the lane's inbound gas model, as read on both chains (R4): the Bittensor adapter's copy is the Base adapter's own
  const model: [string, string][] = [
    ["inboundGasBase", "Bittensor CcipBittensorAdapter.inboundGasBase()"],
    ["inboundGasPerEntry", "Bittensor CcipBittensorAdapter.inboundGasPerEntry()"],
    ["baseGasBase", "Base CcipBaseAdapter.gasBase()"],
    ["baseGasPerEntry", "Base CcipBaseAdapter.gasPerEntry()"],
  ];
  const modelUnread = model.filter(([k]) => !whole(r.values.get(k))).map(([, what]) => what);
  if (modelUnread.length) r.out.failures.push(`the lane's inbound gas model is not checked: ${modelUnread.join(", ")} could not be read`);
  else {
    const v = (k: string) => BigInt(r.values.get(k) as bigint);
    r.out.failures.push(...inboundModelProblems({ inboundGasBase: v("inboundGasBase"), inboundGasPerEntry: v("inboundGasPerEntry"), gasBase: v("baseGasBase"), gasPerEntry: v("baseGasPerEntry") }));
  }

  // the keeper, as both chains name it now (merge 7b, R4-O concern 2)
  keeperReport(r, plan.roles.keeper);

  // the validators: read and printed (spec §7 step 3; A8)
  r.add(await validatorFindings(ctx, plan.validators));
  // what is reported only (Task 46b): the exits, the parks and the cushion, the pending items, and the Safe warning; and
  // the rails (Task 47b), read with the pending items at one pinned head a chain
  await exitsReport(ctx, rec, buildsDir, r);
  await parksReport(ctx, rec, build, r);
  let heads: RailHeads | string;
  try {
    heads = await railHeads(ctx);
  } catch (e) {
    heads = firstLine(e);
  }
  const pending = await pendingReport(ctx, rec, buildsDir, r, typeof heads === "string" ? undefined : heads);
  await railsReport(ctx, rec, buildsDir, r, heads, pending);
  safeWarnings(r, owners, [...(pending.vault ?? []), ...(pending.frontDoor ?? [])]);
  r.settle();
  return { ...r.out, owners };
}

/** What signs for the owner the contract names now (`current`, its owner() as read), for the Safe warning (the
 * review's I1: the owner now, never the plan's): reported, and named apart from the plan's when it differs. An owner()
 * that could not be read is a failure already, and leaves the kind unknown. */
async function ownerKindFindings(ctx: Pick<Ctx, "rpc">, chain: ChainName, current: unknown, planned: Address, r: ReadBacks, owners: Partial<Record<ChainName, OwnerKind>>): Promise<void> {
  if (typeof current !== "string" || !isAddress(current, { strict: false })) return;
  const owner = getAddress(current);
  try {
    const k = await ownerKindOf(ctx, chain, owner);
    owners[chain] = k;
    r.out.info.push(`${chainLabel(chain)}: the owner ${owner} is ${ownerDescription(k)}${same(owner, planned) ? "" : `, not the plan's ${getAddress(planned)}`}`);
  } catch (e) {
    r.out.failures.push(`${chainLabel(chain)}: the owner ${getAddress(owner)}'s kind could not be read (${(e as Error).message.split("\n")[0]})`);
  }
}

/** The vault, its lens, the staking precompile and the Bittensor adapter. */
async function bittensorReadBacks(ctx: Pick<Ctx, "rpc" | "targets">, rec: DeploymentRecordV32, build: BuildV32, buildsDir: string, r: ReadBacks, owners: Partial<Record<ChainName, OwnerKind>>): Promise<void> {
  const plan = rec.plan;
  const a = plan.addresses;
  const roles = plan.roles;
  const launchChain = BigInt(LIVE.base.CHAIN_ID);
  const vaultP = plan.steps.find((s) => s.id === "vault")?.args[0] as Record<string, unknown> | undefined;
  const vault = (fn: VaultRead, args: readonly unknown[] = []) => () => readVault(ctx, rec, fn, args, buildsDir);
  const lens = (fn: VaultRead, args: readonly unknown[] = []) => () => readVaultLens(ctx, rec, fn, args, buildsDir);
  const onVault = { chain: "bittensor" as const, contract: "CascadeVault" };
  const onLens = { chain: "bittensor" as const, contract: "CascadeVaultLens", lens: "vaultLens" as const };

  // the roles, and what signs for the owner
  const owner = await r.check({ ...onVault, read: "owner()", get: vault("owner"), want: roles.owner });
  await ownerKindFindings(ctx, "bittensor", owner, roles.owner, r, owners);
  await r.check({ ...onLens, read: "guardian()", get: lens("guardian"), want: roles.guardian });
  // the keeper as the vault names it now (merge 7b, R4-O concern 2: the owner rotates it at once): judged with the front
  // door's in keeperReport, never against the plan's first keeper alone
  await r.check({ chain: "bittensor", contract: "CascadeVaultLens", read: "keeper()", get: lens("keeper"), rule: AN_ADDRESS }, "vault.keeper");
  await r.check({ ...onLens, read: "treasury()", get: lens("treasury"), want: roles.treasury });
  // the launch chain (from the vault itself, so the check is not circular: spec §8.1) and its door
  await r.check({ ...onVault, read: "launchChain()", get: vault("launchChain"), want: launchChain });
  // the door's peer id, CascadeFormulas.peerId's: keccak256(abi.encode(uint64 chain, address door))
  const door = keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }], [launchChain, a.frontDoor]));
  await r.check({ ...onLens, read: `doorState(the launch door ${getAddress(a.frontDoor)} on ${launchChain})`, get: lens("doorState", [door]), want: DOOR_ACTIVE });
  await r.check({ ...onLens, read: `activeDoors(${launchChain})`, get: lens("activeDoors", [launchChain]), want: 1n });
  await r.check({ ...onLens, read: "primaryBridge()", get: lens("primaryBridge"), want: a.bitAdapter }, "vault.primaryBridge");
  await r.check({ ...onLens, read: `bridgeEnabled(${getAddress(a.bitAdapter)})`, get: lens("bridgeEnabled", [a.bitAdapter]), want: true });
  // the stake and its hotkey
  await r.check({ ...onLens, read: "hotkeys(0)", get: lens("hotkeys", [0n]), want: plan.validators.primary });
  await r.check({ ...onLens, read: "stakeHotkey()", get: lens("stakeHotkey"), want: plan.validators.primary });
  // lastStakeAt: the vault's creation time until its first stake, then a later one (never 0, never after the head)
  let created: number | undefined;
  const block = rec.done.vault?.block;
  let head: number | undefined;
  try {
    head = await blockTime(ctx, "bittensor", "latest");
    if (block !== undefined) created = await blockTime(ctx, "bittensor", block);
  } catch (e) {
    r.out.failures.push(`Bittensor: the vault's creation time and the head's could not be read (${(e as Error).message.split("\n")[0]})`);
  }
  if (block === undefined) r.out.failures.push("Bittensor CascadeVault: the record has no block for its create, so lastStakeAt is not compared with its creation time");
  const lastStakeAt = await r.check({
    ...onLens,
    read: "lastStakeAt()",
    get: lens("lastStakeAt"),
    rule: {
      test: (v) => whole(v) && Number(v) >= (created ?? 1) && head !== undefined && Number(v) <= head,
      expected: `the vault's creation time${created === undefined ? "" : ` ${created} (block ${block})`} or a later stake's, at most the head's ${head ?? "?"}`,
    },
  });
  await r.check({ ...onLens, read: "exitsOpen()", get: lens("exitsOpen"), want: true, empty: true }, "vault.exitsOpen");
  await r.check({ ...onLens, read: "stakeMissing()", get: lens("stakeMissing"), want: false });
  // nothing is booked before the first stake (spec §7 step 3); after it, the booked stake is the stake's, reported
  if (created !== undefined && whole(lastStakeAt) && Number(lastStakeAt) > created) {
    try {
      r.out.info.push(`Bittensor CascadeVaultLens.bookedStake(): ${await readVaultLens(ctx, rec, "bookedStake", [], buildsDir)} rao, staked since its deploy (lastStakeAt ${lastStakeAt})`);
    } catch (e) {
      r.out.failures.push(`Bittensor CascadeVaultLens.bookedStake(): could not be read (${(e as Error).message.split("\n")[0]})`);
    }
  } else {
    await r.check({ ...onLens, read: "bookedStake()", get: lens("bookedStake"), want: 0n });
  }
  // the vault's own coldkey, its address's mapping (as the code read-back fills it), never the record's word for it
  // (Task 46a's review, Minor 5): a record changed after its deploy fails, and the flag is still read for the vault
  const coldkey = addressMapping(a.vault);
  if (plan.vaultColdkey.toLowerCase() !== coldkey.toLowerCase()) {
    r.out.failures.push(
      `Bittensor CascadeVault: the record's vaultColdkey ${plan.vaultColdkey} is not the vault's coldkey ${coldkey}, the address mapping of ${getAddress(a.vault)} (the one its code holds): the record was changed after its deploy`,
    );
  }
  await r.check({
    chain: "bittensor",
    contract: "the staking precompile",
    read: `getRejectStakingHotkeyGrowth(the vault's coldkey ${coldkey})`,
    get: () => read(ctx.rpc, "bittensor", { address: PRECOMPILE.staking, abi: STAKING_VIEWS, functionName: "getRejectStakingHotkeyGrowth", args: [coldkey] }),
    want: true,
  });
  // the treasury redeems on Bittensor: its origin set to DIRECT_ORIGIN before the first cut (the T18 ruling; a warning)
  await r.check({
    ...onLens,
    read: `redeemOrigin(the treasury ${getAddress(roles.treasury)})`,
    get: lens("redeemOrigin", [roles.treasury]),
    rule: {
      test: (v) => same(v, DIRECT_ORIGIN),
      expected: `DIRECT_ORIGIN, ${DIRECT_ORIGIN} (the treasury calls setRedeemOrigin(${DIRECT_ORIGIN}) on the vault before the first reward cut)`,
    },
    warn: true,
  });
  // the constructor's limits, each as planned (their names are the lens's getters)
  if (vaultP) {
    for (const name of VAULT_LIMITS) {
      await r.check({ ...onLens, read: `${name}()`, get: lens(name), want: vaultP[name] }, VALUE_KEYS[name]);
    }
  }
  // the block time: the chain's as the deploy calibrates it, in milliseconds, whatever the plan says (the R1 re-review's
  // pin; Revision 28: 7,200, twice as fast as Bittensor's 12 s; a seconds value such as 12 fails here)
  await r.check({ ...onVault, read: "MS_PER_BLOCK()", get: vault("MS_PER_BLOCK"), want: MS_PER_BLOCK_PINS.bittensor });
  // the vault's EXIT_GAS_RESERVE (a constant its lens serves): the keeper sends every payout with at least that much above
  // its estimate (keeper/core/v32/payout.ts), so the two must be one (Task 65), or burning removals can eat the reserve
  await r.check({ ...onLens, read: "EXIT_GAS_RESERVE()", get: lens("EXIT_GAS_RESERVE"), want: EXIT_GAS_RESERVE });
  // the stamp's domain, as the lens recomputes it (an immutable and a constant on the vault, covered by the code
  // comparison: ruling DA13); printed, and compared with viem's
  await stampDomain(ctx, r, "bittensor", "CascadeVault", "CascadeVaultLens", a.vault, (fn) => readVaultLens(ctx, rec, fn, [], buildsDir));
  // the scheduler's class table
  r.add(
    await classTableFindings(ctx, {
      chain: "bittensor",
      name: "CascadeVault",
      table: SCHEDULED_V32.vault,
      contract: "vault",
      to: a.vault,
      owner: roles.owner,
      abi: build.vaultAbi,
      errors: buildErrorsV32(build),
      launchChain,
    }),
  );
  // the Bittensor adapter: its treasury, its cap for the cap relations, and its copy of the lane's inbound gas model
  // (R4), for the one check that it is the Base adapter's own
  const bitAbi = build.contracts.CcipBittensorAdapter.abi;
  const bit = (fn: string) => () => read(ctx.rpc, "bittensor", { address: a.bitAdapter, abi: bitAbi, functionName: fn });
  const bitArgs = plan.steps.find((s) => s.id === "bitAdapter")?.args;
  const bitP = bitArgs?.[0] as { maxMessageValue?: bigint } | undefined;
  await r.check({ chain: "bittensor", contract: "CcipBittensorAdapter", read: "treasury()", get: bit("treasury"), want: roles.treasury });
  await r.check({ chain: "bittensor", contract: "CcipBittensorAdapter", read: "maxMessageValue()", get: bit("maxMessageValue"), want: bitP?.maxMessageValue }, "bitCap");
  await r.check({ chain: "bittensor", contract: "CcipBittensorAdapter", read: "inboundGasBase()", get: bit("inboundGasBase"), want: bitArgs?.[2] }, "inboundGasBase");
  await r.check({ chain: "bittensor", contract: "CcipBittensorAdapter", read: "inboundGasPerEntry()", get: bit("inboundGasPerEntry"), want: bitArgs?.[3] }, "inboundGasPerEntry");
  // R11 (ChatGPT r3): what only the live chain shows of two reads the vault's code trusts
  await payoutsRailReadBacks(ctx, rec, bitAbi, r, r.values.get("vault.primaryBridge"));
  await writeOffReadPrice(ctx, rec, r);
}

/** canSendPayouts()'s calldata. */
const CAN_SEND_PAYOUTS = encodeFunctionData({ abi: RAIL_VIEWS, functionName: "canSendPayouts" });
/** ForeverMoney's AlphaVault: the three getters the Bittensor adapter's canSendPayouts() reads. */
const ALPHA_GETTERS = parseAbi(["function isPaused() view returns (bool)", "function migrationReadyAt() view returns (uint256)", "function migrationFinished() view returns (bool)"]);
const TOTAL_COLDKEY = parseAbi(["function getTotalColdkeyStakeOnSubnet(bytes32 coldkey, uint256 netuid) view returns (uint256)"]);
const gasText = (g: bigint) => g.toLocaleString("en-US");
const errLine = (e: unknown) => (e as Error).message.split("\n")[0];

/** What a call takes before its code runs: 21,000, and 4 gas a zero byte of its calldata, 16 any other. A read given
 * `cap` of its own is asked with cap + this, so its code has what a capped staticcall would give it. */
export function intrinsicGas(data: Hex): bigint {
  let gas = 21_000n;
  for (let i = 2; i < data.length; i += 2) gas += data.slice(i, i + 2) === "00" ? 4n : 16n;
  return gas;
}

/** An answer's length in bytes, or undefined for anything but whole bytes of hex. */
const bytesOf = (out: unknown): number | undefined => (typeof out === "string" && /^0x([0-9a-fA-F]{2})*$/.test(out) ? (out.length - 2) / 2 : undefined);
const answered = (n: number | undefined) => (!n ? "answers nothing" : `answers ${n} byte${n === 1 ? "" : "s"}`);

/** R11 (ChatGPT r3, claim 2): the payouts rail as the vault reads it, for the canary (runbook 3.5) and every verify after,
 * on the vault's primary bridge as read now (`primary`, its lens's primaryBridge(): R12d, the payouts go through it,
 * whatever the record names), each line naming it when it isn't the record's adapter; with the primary unread, the
 * record's adapter, said.
 * - That bridge's canSendPayouts(), asked as the vault's _payoutsOpen asks it: from the vault, with
 *   the gas its staticcall gives the view (RAIL_VIEW_CALL_GAS, as the keeper reads it). Anything but one word (a revert,
 *   Bittensor's EVM halting it, no answer, more) fails: the vault reads that as payouts open. false warns: the payouts
 *   read closed now (a ForeverMoney pause or notice; the canary expects true).
 * - Each of ForeverMoney's three getters the view reads, asked as the adapter asks them: from the adapter, with the
 *   ALPHA_READ_GAS (30,000) its staticcall gives each. One that reverts, runs over it or answers short of a word fails:
 *   the adapter reads that as closed, so canSendPayouts() would read false for good, and the vault would defer every
 *   door unstake (its fee lost). Their answers are reported.
 * A node's own error is a read that failed: a failure, as every read here is. */
async function payoutsRailReadBacks(ctx: Pick<Ctx, "rpc">, rec: DeploymentRecordV32, bitAbi: Abi, r: ReadBacks, primary: unknown): Promise<void> {
  const a = rec.plan.addresses;
  const current = typeof primary === "string" && isAddress(primary, { strict: false }) && BigInt(primary) !== 0n ? getAddress(primary) : undefined;
  const bridge = current ?? getAddress(a.bitAdapter);
  /** which bridge was asked, when it isn't the record's adapter as the vault's primary */
  const of =
    current === undefined
      ? ` of the record's adapter ${getAddress(a.bitAdapter)} (the vault's primaryBridge() could not be read)`
      : current.toLowerCase() === a.bitAdapter.toLowerCase()
        ? ""
        : ` of the vault's primary bridge ${current} (not the record's adapter ${getAddress(a.bitAdapter)})`;
  const view = `Bittensor CcipBittensorAdapter.canSendPayouts()${of}`;
  const asVault = `${view}, asked as the vault asks it (from the vault, with the ${gasText(RAIL_VIEW_GAS)} gas it gives the view: RAIL_VIEW_GAS)`;
  const opensIt = "; the vault reads that as payouts open, so door unstakes would be taken into a queue its rail may not pay";
  try {
    const out = await ctx.rpc.request("bittensor", "eth_call", [{ from: a.vault, to: bridge, data: CAN_SEND_PAYOUTS, gas: numberToHex(RAIL_VIEW_CALL_GAS) }, "latest"]);
    const n = bytesOf(out);
    if (n !== 32) r.out.failures.push(`${asVault}: ${answered(n)}, not one word${opensIt}`);
    else if (/^0x0{64}$/.test(out as string)) {
      r.out.warnings.push(
        `${asVault}: false, so the vault reads its payouts closed and defers every door unstake (ForeverMoney's AlphaVault paused or migrating, or one of the adapter's reads of it failing: its line says which); the canary expects true`,
      );
    } else r.out.info.push(`${view}: true, one word, asked as the vault asks it (from the vault, with the ${gasText(RAIL_VIEW_GAS)} gas it gives the view: RAIL_VIEW_GAS)`);
  } catch (e) {
    if (isRevert(e) || isEvmHalt(e)) r.out.failures.push(`${asVault}: reverts (${errLine(e)})${opensIt}`);
    else r.out.failures.push(`${view}: could not be read (${errLine(e)})`);
  }
  const av = await r.check({ chain: "bittensor", contract: "CcipBittensorAdapter", read: `alphaVault()${of}`, get: () => read(ctx.rpc, "bittensor", { address: bridge, abi: bitAbi, functionName: "alphaVault" }), rule: AN_ADDRESS });
  if (typeof av !== "string") return;
  const vault = getAddress(av);
  const said: string[] = [];
  for (const fn of ["isPaused", "migrationReadyAt", "migrationFinished"] as const) {
    const data = encodeFunctionData({ abi: ALPHA_GETTERS, functionName: fn });
    const who = `Bittensor ForeverMoney's AlphaVault ${vault}.${fn}()`;
    const asAdapter = `${who}, asked as the Bittensor adapter asks it (from the adapter, with the ${gasText(ALPHA_READ_GAS)} gas it gives each read: RAIL_READ_GAS)`;
    const closesIt = ". The adapter takes that as payouts closed, so its canSendPayouts() would read false for good: the vault would defer every door unstake, its fee lost";
    try {
      const out = await ctx.rpc.request("bittensor", "eth_call", [{ from: bridge, to: vault, data, gas: numberToHex(ALPHA_READ_GAS + intrinsicGas(data)) }, "latest"]);
      const n = bytesOf(out);
      // the adapter takes the first word of an answer at least a word long (CcipBittensorAdapter._railRead)
      if (n === undefined || n < 32) {
        r.out.failures.push(`${asAdapter}: ${answered(n)}, short of a word${closesIt}`);
        continue;
      }
      const word = hexToBigInt(`0x${(out as string).slice(2, 66)}`);
      said.push(`${fn}() ${fn === "migrationReadyAt" ? word.toString() : String(word !== 0n)}`);
    } catch (e) {
      if (isRevert(e) || isEvmHalt(e)) r.out.failures.push(`${asAdapter}: reverts (${errLine(e)})${closesIt}`);
      else r.out.failures.push(`${who}: could not be read (${errLine(e)})`);
    }
  }
  if (said.length === 3) r.out.info.push(`Bittensor ForeverMoney's AlphaVault ${vault}: ${said.join(", ")}, each one word within the ${gasText(ALPHA_READ_GAS)} gas the Bittensor adapter gives each read (RAIL_READ_GAS)`);
}

/** R11 (ChatGPT r3, claim 1): the write-off's read of the unlisted stake priced on the live chain, for the canary
 * (runbook 3.5) and every verify after: eth_estimateGas of the staking precompile's getTotalColdkeyStakeOnSubnet(the
 * vault's coldkey, root), less what the call takes first, against the vault's WRITE_OFF_READ_GAS (45,000,000). The
 * vault reads a failed read as 0, so a write-off runs with no bound: over the cap, or an estimate the node refuses,
 * fails; under it, reported. Its cost grows with the positions on the coldkey (the monitor's stake.writeoff_read_gas
 * watches it after the deploy). R12d: the read is asked once by eth_call too, and must answer one word (the total): an
 * address with no precompile (or code that isn't it) answers nothing, and its estimate is only the call's own, so it would
 * read as costing 0 gas; anything but one word fails, and its price is not reported. */
async function writeOffReadPrice(ctx: Pick<Ctx, "rpc">, rec: DeploymentRecordV32, r: ReadBacks): Promise<void> {
  const data = encodeFunctionData({ abi: TOTAL_COLDKEY, functionName: "getTotalColdkeyStakeOnSubnet", args: [addressMapping(rec.plan.addresses.vault), 0n] });
  const what = "Bittensor: the write-off's read of the unlisted stake (the staking precompile's getTotalColdkeyStakeOnSubnet, the vault's coldkey on root)";
  const cap = `the vault's ${gasText(WRITE_OFF_READ_GAS)} cap (WRITE_OFF_READ_GAS)`;
  const unbounded = "the vault would read 0, and a write-off would run with no bound";
  try {
    const n = bytesOf(await ctx.rpc.request("bittensor", "eth_call", [{ to: PRECOMPILE.staking, data }, "latest"]));
    if (n !== 32) {
      r.out.failures.push(`${what} ${answered(n)} by eth_call, not one word: no staking precompile answers there, so its price says nothing (a call to no code costs 0 gas of its own); ${unbounded}`);
      return;
    }
  } catch (e) {
    r.out.failures.push(isRevert(e) || isEvmHalt(e) ? `${what} reverts by eth_call (${errLine(e)}): ${unbounded}` : `${what} could not be read by eth_call (${errLine(e)})`);
    return;
  }
  let est: bigint;
  try {
    est = hexToBigInt((await ctx.rpc.request("bittensor", "eth_estimateGas", [{ to: PRECOMPILE.staking, data }])) as Hex);
  } catch (e) {
    r.out.failures.push(`${what} could not be priced (eth_estimateGas: ${errLine(e)}): should the vault's own read fail, it reads 0, and a write-off runs with no bound`);
    return;
  }
  const first = intrinsicGas(data);
  const own = est > first ? est - first : 0n;
  const priced = `${what} costs ${gasText(own)} gas by eth_estimateGas (less the ${gasText(first)} a call takes first)`;
  if (own > WRITE_OFF_READ_GAS) r.out.failures.push(`${priced}, over ${cap}: the vault's own read fails and reads 0, so a write-off would run with no bound`);
  else r.out.info.push(`${priced}, of ${cap}, and answers one word by eth_call`);
}

/** The constructor's limits the vault lens serves under their Params names (Appendix B). */
export const VAULT_LIMITS = [
  "rewardCutBps",
  "payoutDelay",
  "maxDailyOutflowBps",
  "minDailyOutflow",
  "globalOutflowBps",
  "maxEntryValue",
  "maxMessageValue",
  "minChunk",
  "maxFeeBps",
  "maxFeeAbs",
  "maxTotalAssets",
  "minDirectDeposit",
  "claimGasRequired",
  "hotkeyDustRao",
  "unstakeMarginRao",
  "rewardVesting",
  "idleBufferBps",
  "unstakeGas",
] as const satisfies readonly VaultRead[];

/** The front door's batch and cap settings, each read from the door, which kept them. */
export const DOOR_SETTINGS = ["batchInterval", "minDeposit", "depositCap", "redeemRequestFee", "maxDeposits", "maxRedeems", "maxBatchValue", "maxDeliverySlippageBps"] as const;

/** The limits and settings whose values, as read, the cap relations and the Safe warning read again: the key each is
 * kept under. */
const VALUE_KEYS: Partial<Record<string, string>> = {
  maxMessageValue: "vaultMaxMessageValue",
  maxEntryValue: "maxEntryValue",
  maxTotalAssets: "maxTotalAssets",
  maxBatchValue: "maxBatchValue",
  depositCap: "depositCap",
};

// ---- what is reported, never compared with the plan (Task 46b) ----

/** CascadeTypes.Actor, as a hold's maker is named. */
const HELD_BY = ["no one's", "the owner's", "the guardian's"] as const;
const heldBy = (actor: unknown) => HELD_BY[Number(actor)] ?? `actor ${String(actor)}'s`;
/** A clock as a line shows it: its time, or none when it never ran. */
const clockText = (t: unknown) => (whole(t) && BigInt(t) !== 0n ? iso(Number(t)) : "none");
/** "a", "a and b", "a, b and c". */
const listed = (xs: readonly string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
/** A warning of several lines, as verify lists it: its later lines indented under the first. */
const indented = (w: string) => w.split("\n").join("\n    ");

/** The exits on each chain, reported: open or closed, and by which hold whose (the vault's pause, the launch door's
 * removal and the primary bridge's disable; the front door's primary only, with its deposits' pause), and each clock (the
 * owner's last closure or stamp, the guardian's last closure: an item scheduled at or before its kind's clock is dead).
 * Whether the exits are open is 46a's read-back, which fails when they are not; a chain whose read-back could not be
 * read is not reported again. A read that fails here is a failure. */
async function exitsReport(ctx: Pick<Ctx, "rpc">, rec: DeploymentRecordV32, buildsDir: string, r: ReadBacks): Promise<void> {
  for (const which of ["vault", "door"] as const) {
    const chain: ChainName = which === "vault" ? "bittensor" : "base";
    const name = which === "vault" ? "CascadeVault" : "CascadeFrontDoor";
    const open = r.values.get(`${which}.exitsOpen`);
    if (typeof open !== "boolean") continue;
    const get = (fn: VaultRead & DoorRead) => (which === "vault" ? readVaultLens(ctx, rec, fn, [], buildsDir) : readDoorLens(ctx, rec, fn, [], buildsDir));
    try {
      const holds: [string, unknown][] =
        which === "vault"
          ? [
              ["the pause", await readVaultLens(ctx, rec, "pausedBy", [], buildsDir)],
              ["the launch door's removal", await readVaultLens(ctx, rec, "launchDoorRemovedBy", [], buildsDir)],
              ["the primary bridge's disable", await get("primaryDisabledBy")],
            ]
          : [["the primary bridge's disable", await get("primaryDisabledBy")]];
      const owner = await get("lastOwnerClose");
      const guardian = await get("lastGuardianClose");
      const deposits = which === "door" ? `; deposits are ${(await readDoor(ctx, rec, "paused", [], buildsDir)) ? "paused" : "open"}` : "";
      const held = holds.filter(([, actor]) => Number(actor) !== 0).map(([what, actor]) => `${what} (${heldBy(actor)})`);
      const state = open ? "the exits are open" : held.length ? `the exits are closed, held by ${listed(held)}` : "the exits are closed";
      r.out.info.push(`${chainLabel(chain)} ${name}: ${state}${deposits}. The owner's last closure or stamp: ${clockText(owner)}; the guardian's last closure: ${clockText(guardian)}.`);
    } catch (e) {
      r.out.failures.push(`${chainLabel(chain)} ${name}: its exits state could not be read (${firstLine(e)})`);
    }
  }
}

const ERC20_BALANCE = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

/** A read-back that only has to be an address (keeper(): judged across the contracts by keeperReport). */
const AN_ADDRESS = { test: (v: unknown) => typeof v === "string" && isAddress(v, { strict: false }), expected: "an address" };

/** The keeper as the chains name it now (merge 7b, R4-O concern 2): the owner rotates it at once with setKeeper on both
 * contracts (runbook 2.6), and the keeper Worker holds its key to keeper() on both, never to the plan's first keeper, so
 * verify does the same. The door lens reads the front door's storage, so its keeper() must be the door's (Task 43a's
 * review, M5); the vault's and the front door's must be one key (a rotation half done stops every send). One key on
 * both: the plan's first, nothing said; another, said as information (a rotation); 0, a warning (revoked). A keeper()
 * that could not be read is a failure already, and nothing more is judged. */
function keeperReport(r: ReadBacks, first: Address): void {
  const [vault, door, lens] = ["vault.keeper", "door.keeper", "doorLens.keeper"].map((k) => r.values.get(k));
  if (![vault, door, lens].every((v) => typeof v === "string" && isAddress(v, { strict: false }))) return;
  const [v, d, l] = [vault, door, lens].map((x) => getAddress(x as Address));
  if (!same(l, d)) r.out.failures.push(`Base CascadeDoorLens.keeper(): expected ${d} (the front door's own keeper()), found ${l}`);
  if (!same(v, d)) {
    r.out.failures.push(
      `The keeper: keeper() is ${v} on the vault (Bittensor) and ${d} on the front door (Base): one key must be keeper() on both (a rotation half done, runbook 2.6: the keeper Worker sends nothing until both calls have landed)`,
    );
    return;
  }
  if (same(v, first)) return;
  if (same(v, zeroAddress)) {
    r.out.warnings.push("The keeper: keeper() is 0 on both chains (setKeeper(0), the keeper revoked): no delivery goes, and stakes, claims and adoptions wait for their 7-day fallbacks");
    return;
  }
  r.out.info.push(
    `The keeper: keeper() is ${v} on both chains, not the plan's first keeper ${getAddress(first)}: a rotation (setKeeper on both, runbook 2.6). The keeper Worker holds its key to keeper() on both, never to the plan's.`,
  );
}

/** verify warns of a booked token cushion (merge 7b, M7), and of a native reserve (Phase 2a, concern 1), below its target
 * divided by this, half of it: the monitor's bridge.cushion_low line (indexer/src/rules/bridge.ts CUSHION_LOW_DIVISOR, on
 * the native reserve and, since phase 2b, the booked tokenCushion). */
const CUSHION_LOW_DIVISOR = 2n;

/** How the founder funds the adapter's token cushion (R4, F-1): its booked tokenCushion, never a plain transfer. */
const FUND_CUSHION = "approve and fundCushion (for the live deployment, pnpm ops fund-cushion --from <0x…> --for-wallet --live writes both for the sign page)";

/** The Bittensor adapter's parks and what it holds beyond them, reported (spec §3.2; the monitor's bridge.parked and
 * bridge.cushion_low): what its parks owe (parkedNative, parkedTokens), its native reserve beyond them, and its token
 * cushion as the adapter books it (R4, F-1: tokenCushion, what fundCushion brought in; never the balance less the parks,
 * which a plain transfer would fill and anyone's sweepSurplus empty), each against its target (RESERVE_TARGET,
 * TOKEN_RESERVE_TARGET). A park warns (a refused delivery waits there), as does a native reserve or a booked cushion below
 * half its target, and any token surplus beyond the token parks and the booked cushion (sweepable); a native reserve under
 * 1 rao fails (a delivery's conversion 1 rao short then parks), as does a booked cushion of 0
 * (a mint 1 rao short reverts ConversionShort), as does holding less than the parks owe (I-7) or than the token parks
 * and the booked cushion together; a read that fails fails. */
async function parksReport(ctx: Pick<Ctx, "rpc">, rec: DeploymentRecordV32, build: BuildV32, r: ReadBacks): Promise<void> {
  const at = getAddress(rec.plan.addresses.bitAdapter);
  const abi = build.contracts.CcipBittensorAdapter.abi;
  const who = "Bittensor CcipBittensorAdapter";
  let native: bigint;
  let tokens: bigint;
  let booked: bigint;
  let balance: bigint;
  let held: bigint;
  try {
    native = (await read(ctx.rpc, "bittensor", { address: at, abi, functionName: "parkedNative" })) as bigint;
    tokens = (await read(ctx.rpc, "bittensor", { address: at, abi, functionName: "parkedTokens" })) as bigint;
    booked = (await read(ctx.rpc, "bittensor", { address: at, abi, functionName: "tokenCushion" })) as bigint;
    const token = (await read(ctx.rpc, "bittensor", { address: at, abi, functionName: "token" })) as Address;
    balance = await balanceOf(ctx.rpc, "bittensor", at);
    held = (await read(ctx.rpc, "bittensor", { address: token, abi: ERC20_BALANCE, functionName: "balanceOf", args: [at] })) as bigint;
  } catch (e) {
    r.out.failures.push(`${who}: its parks and reserves could not be read (${firstLine(e)})`);
    return;
  }
  const reserve = balance - native;
  const { reserveTarget, tokenReserveTarget, shortfallTolerance, tokenSurplusWarn } = FUNDING_V32;
  r.out.info.push(`${who}: its parks hold ${formatEther(native)} TAO as native TAO (parkedNative) and ${formatEther(tokens)} TAO as tokens (parkedTokens)`);
  r.out.info.push(
    `${who}: beyond its parks, its native reserve is ${formatEther(reserve)} TAO and its booked token cushion (tokenCushion) ${formatEther(booked)} FM-TAO (the target of each is ${formatEther(reserveTarget)})`,
  );
  if (native !== 0n || tokens !== 0n) {
    r.out.warnings.push(
      `${who}: ${formatEther(native)} TAO is parked as native TAO and ${formatEther(tokens)} TAO as tokens: refused deliveries wait there to be delivered again (deliverParked) or, after 14 days, refunded (refundParked)`,
    );
  }
  if (reserve < 0n) r.out.failures.push(`${who} holds ${formatEther(balance)} TAO, less than its native parks owe (${formatEther(native)} TAO): it can't pay them all`);
  else if (reserve < shortfallTolerance) {
    // the review of 9f4c10f: convertExact's covering rao comes from the reserve, never a park, so under 1 rao (empty
    // included) a delivery whose conversion comes out 1 rao short is refused (ConversionShort) and parks as tokens, and
    // deliverParked reverts with it: the same effect as a booked cushion under 1 rao, which fails below
    r.out.failures.push(
      `${who}: its native reserve (beyond its native parks) is ${formatEther(reserve)} TAO, less than the 1 rao a delivery's conversion can come out short (SHORTFALL_TOLERANCE_WEI): a delivery whose conversion comes out 1 rao short parks as tokens (ConversionShort), and deliverParked can't deliver it, until the reserve is funded. Fund it with fundReserve() (for the live deployment, pnpm ops fund-reserve --from <0x…> --for-wallet --live writes it for the sign page)`,
    );
  } else if (reserve < reserveTarget / CUSHION_LOW_DIVISOR) {
    // Phase 2a (concern 1): below half its target, as the monitor's bridge.cushion_low line and the booked cushion's (M7):
    // each delivery conversion it covers takes up to 1 rao and logs nothing, so a few rao under the target is expected
    r.out.warnings.push(
      `${who}: its native reserve is ${formatEther(reserve)} TAO, below half its ${formatEther(reserveTarget)} TAO target (${formatEther(reserveTarget / CUSHION_LOW_DIVISOR)} TAO): fund it with fundReserve() (for the live deployment, pnpm ops fund-reserve --from <0x…> --for-wallet --live writes it for the sign page)`,
    );
  }
  if (booked === 0n) {
    r.out.failures.push(
      `${who}: its token cushion is not funded (tokenCushion() is 0): a payout or a converted refund whose mint comes out 1 rao short reverts ConversionShort until it is. Fund it with ${FUND_CUSHION}. A plain transfer is not the cushion: anyone's sweepSurplus() sends it to the treasury`,
    );
  } else if (booked < shortfallTolerance) {
    // merge 7b (M3): _collect reverts ConversionShort when the shortfall is above the booked cushion, and a mint is whole
    // rao, so a cushion under 1 rao covers no short mint at all: as empty as 0
    r.out.failures.push(
      `${who}: its booked token cushion (tokenCushion()) is ${formatEther(booked)} FM-TAO, less than the 1 rao a mint can come out short (SHORTFALL_TOLERANCE_WEI): a payout or a converted refund whose mint comes out 1 rao short reverts ConversionShort until it is topped up. Top it up with ${FUND_CUSHION}`,
    );
  } else if (booked < tokenReserveTarget / CUSHION_LOW_DIVISOR) {
    // merge 7b (M7): below half its target, as the monitor's bridge.cushion_low line: each 1-rao shortfall it covers
    // lowers it by a rao, so a few rao under the target is expected and would warn for good
    r.out.warnings.push(`${who}: its booked token cushion is ${formatEther(booked)} FM-TAO, below half its ${formatEther(tokenReserveTarget)} target: top it up with ${FUND_CUSHION}`);
  }
  if (held < tokens + booked) {
    r.out.failures.push(`${who} holds ${formatEther(held)} FM-TAO, less than its token parks (${formatEther(tokens)} TAO) and its booked cushion (${formatEther(booked)} FM-TAO) together: it can't cover them all`);
  } else if (held - tokens - booked >= tokenSurplusWarn) {
    // merge 7b (M7): from FUNDING_V32.tokenSurplusWarn (1,000 rao) up, never a mint's rounding alone
    r.out.warnings.push(
      `${who} holds ${formatEther(held - tokens - booked)} FM-TAO beyond its token parks and its booked cushion: surplus, not the cushion (said from 1,000 rao up: a plain transfer, or many mints' rounding); anyone's sweepSurplus() sends it to the treasury`,
    );
  }
}

/** The scheduler's pending items on each chain (Task 47's pendingOn: Scheduled less Executed, Cancelled and Lapsed,
 * judged by the lens), reported one line each with its state; an id pending on both schedulers is listed on each. An
 * item the lens could not judge warns (it is neither pending nor gone); a scheduler whose items could not be read fails
 * (no list is better than a short one). Read at `heads` when given (the rails' pinned heads, Task 47b). Returns the
 * items read on each chain (none where they could not be read), for the rails and the Safe warning. */
async function pendingReport(ctx: Pick<Ctx, "rpc" | "logs" | "logsWindow">, rec: DeploymentRecordV32, buildsDir: string, r: ReadBacks, heads?: RailHeads): Promise<Partial<Record<SchedulerContract, PendingItem[]>>> {
  const out: Partial<Record<SchedulerContract, PendingItem[]>> = {};
  for (const [c, chain, name] of [
    ["vault", "bittensor", "CascadeVault"],
    ["frontDoor", "base", "CascadeFrontDoor"],
  ] as const) {
    const label = `${chainLabel(chain)} ${name}'s scheduler`;
    let items: PendingItem[];
    try {
      items = await pendingOn(ctx, rec, c, { buildsDir, ...(heads ? { head: heads[c] } : {}) });
    } catch (e) {
      r.out.failures.push(`${label}: its pending items could not be read (${firstLine(e)})`);
      continue;
    }
    if (!items.length) r.out.info.push(`${label}: nothing scheduled that can still run`);
    for (const i of items) {
      const line = `${label}: item ${i.id}, ${itemText(i)} (${i.class ? `${i.class}, ` : ""}${i.kind}): ${stateOf(i)}`;
      if (i.unknown) r.out.warnings.push(`${line}: check it with pnpm ops pending`);
      else r.out.info.push(line);
    }
    out[c] = items;
  }
  return out;
}

/** The rails between the chains (spec §5's residual; Task 47b's rails.ts), reported: whether the two chains agree on the
 * bridge now (a failure when they don't: every batch one way is refused at the other end), and the pending items that
 * change that, with what they would make of it (a warning when the chains would then disagree). Read at the pinned
 * heads, with the pending items read there. A read that fails is a failure. The rails now depend on no pending item, so
 * they are always judged (Task 47b's fix round, Important 1): only what the pending items would make of them can be
 * "not judged", a warning, when a scheduler's items could not be read (a failure of its own) or an activation could not
 * be judged: never "agreeing". */
async function railsReport(
  ctx: Pick<Ctx, "rpc" | "logs" | "logsWindow">,
  rec: DeploymentRecordV32,
  buildsDir: string,
  r: ReadBacks,
  heads: RailHeads | string,
  pending: Partial<Record<SchedulerContract, PendingItem[]>>,
): Promise<void> {
  const unknown = "whether the two chains agree on the bridge is not known";
  if (typeof heads === "string") {
    r.out.failures.push(`The rails could not be read (${heads}): ${unknown}`);
    return;
  }
  let s: RailState;
  try {
    s = await readRails(ctx, rec, { buildsDir, heads, pending: { vault: [], frontDoor: [] } });
  } catch (e) {
    r.out.failures.push(`The rails could not be read (${firstLine(e)}): ${unknown}`);
    return;
  }
  const then = "so whether the two chains will agree on the bridge then is not known";
  if (!pending.vault || !pending.frontDoor) {
    r.add(railsFindings(s));
    r.out.warnings.push(
      `The rails once the pending items run are not judged: ${listed([!pending.vault ? "the vault's" : "", !pending.frontDoor ? "the front door's" : ""].filter(Boolean))} pending items could not be read (above), ${then}`,
    );
    return;
  }
  const unjudged = [...pending.vault, ...pending.frontDoor].find((i) => i.fn === "activateBridge" && i.unknown);
  if (unjudged) {
    r.add(railsFindings(s));
    r.out.warnings.push(`The rails once the pending items run are not judged: item ${unjudged.id}, an activation of a bridge, could not be judged (${unjudged.unknown}), ${then}`);
    return;
  }
  r.add(railsFindings({ ...s, pending: pendingRailChanges([...pending.vault, ...pending.frontDoor]) }));
}

/** The Safe warning (spec §7; ruling B7a's capsWarning): the front door's deposit cap (with Base's owner) and the vault's
 * maxTotalAssets (with Bittensor's), as read now, and each pending setMaxTotalAssets that can still run (a caps file
 * already scheduled), above the founder level while that chain's owner, the one its owner() names now (the review's
 * I1), is not a Safe of at least 2 of 3: a warning quoting section 5, never a failure. An owner whose kind could not be read (a failure of its own) is not known to be a Safe. */
function safeWarnings(r: ReadBacks, owners: Partial<Record<ChainName, OwnerKind>>, pending: readonly PendingItem[]): void {
  for (const [chain, key] of [
    ["base", "depositCap"],
    ["bittensor", "maxTotalAssets"],
  ] as const) {
    const v = r.values.get(key);
    if (!whole(v)) continue;
    const w = capsWarning({ [key]: BigInt(v) }, owners[chain]);
    if (w) r.out.warnings.push(`${chainLabel(chain)}: ${indented(w)}`);
  }
  for (const i of pending) {
    if (i.contract !== "vault" || i.fn !== "setMaxTotalAssets" || i.dead || !i.canonical || lapsed(i) || !whole(i.args.amount)) continue;
    const w = capsWarning({ maxTotalAssets: BigInt(i.args.amount) }, owners.bittensor);
    if (w) r.out.warnings.push(`Bittensor CascadeVault's scheduler, item ${i.id}, ${itemText(i)}: ${indented(w)}`);
  }
}

async function stampDomain(
  ctx: Pick<Ctx, "targets">,
  r: ReadBacks,
  chain: ChainName,
  target: string,
  lensName: string,
  at: Address,
  get: (fn: "DOMAIN_SEPARATOR" | "STAMP_TYPEHASH") => Promise<unknown>,
): Promise<void> {
  const separator = domainSeparatorV32(ctx.targets[chain].chainId, at);
  const s = await r.check({ chain, contract: lensName, read: "DOMAIN_SEPARATOR()", get: () => get("DOMAIN_SEPARATOR"), want: separator });
  const t = await r.check({ chain, contract: lensName, read: "STAMP_TYPEHASH()", get: () => get("STAMP_TYPEHASH"), want: STAMP_TYPEHASH_V32 });
  if (same(s, separator) && same(t, STAMP_TYPEHASH_V32)) {
    r.out.info.push(`${chainLabel(chain)} ${target}'s stamp domain, as its lens recomputes it: DOMAIN_SEPARATOR ${separator} and STAMP_TYPEHASH ${STAMP_TYPEHASH_V32}, which viem gives too`);
  }
}

/** The front door, its lens, the staker, the oracle and its pools, and the Base adapter. */
async function baseReadBacks(ctx: Pick<Ctx, "rpc" | "targets">, rec: DeploymentRecordV32, build: BuildV32, buildsDir: string, r: ReadBacks, owners: Partial<Record<ChainName, OwnerKind>>): Promise<void> {
  const plan = rec.plan;
  const a = plan.addresses;
  const roles = plan.roles;
  const doorP = plan.steps.find((s) => s.id === "frontDoor")?.args[0] as Record<string, unknown> | undefined;
  const stakerP = plan.steps.find((s) => s.id === "staker")?.args[0] as
    | { swapFeeBps: number; depositFeeUsdc: bigint; deliveryRouteId: number; route0: { kind: number; router: Address; buyPath: Hex; sellPath: Hex; active: boolean } }
    | undefined;
  const baseP = plan.steps.find((s) => s.id === "baseAdapter")?.args as [{ maxMessageValue?: bigint; gasBase?: bigint; gasPerEntry?: bigint }, bigint] | undefined;
  const door = (fn: Parameters<typeof readDoor>[2], args: readonly unknown[] = []) => () => readDoor(ctx, rec, fn, args, buildsDir);
  const lens = (fn: Parameters<typeof readDoorLens>[2], args: readonly unknown[] = []) => () => readDoorLens(ctx, rec, fn, args, buildsDir);
  const onDoor = { chain: "base" as const, contract: "CascadeFrontDoor" };
  const onLens = { chain: "base" as const, contract: "CascadeDoorLens", lens: "doorLens" as const };

  // the roles
  const owner = await r.check({ ...onDoor, read: "owner()", get: door("owner"), want: roles.owner });
  await ownerKindFindings(ctx, "base", owner, roles.owner, r, owners);
  // the keeper as the front door names it now (merge 7b: keeperReport judges it with the vault's)
  await r.check({ ...onDoor, read: "keeper()", get: door("keeper"), rule: AN_ADDRESS }, "door.keeper");
  await r.check({ ...onLens, read: "guardian()", get: lens("guardian"), want: roles.guardian });
  // the door lens's own keeper, read from the lens (Task 43a's review, M5: the door kept one too), held to the door's
  await r.check({ chain: "base", contract: "CascadeDoorLens", read: "keeper()", get: lens("keeper"), rule: AN_ADDRESS }, "doorLens.keeper");
  await r.check({ ...onLens, read: "primaryBridge()", get: lens("primaryBridge"), want: a.baseAdapter });
  await r.check({ ...onLens, read: `bridgeEnabled(${getAddress(a.baseAdapter)})`, get: lens("bridgeEnabled", [a.baseAdapter]), want: true });
  await r.check({ ...onLens, read: "exitsOpen()", get: lens("exitsOpen"), want: true, empty: true }, "door.exitsOpen");
  // the constructor-set wiring: the vault it serves, the oracle, the swapper, the treasury and the tokens
  await r.check({ ...onDoor, read: "vault()", get: door("vault"), want: a.vault });
  await r.check({ ...onDoor, read: "vaultChain()", get: door("vaultChain"), want: BigInt(LIVE.bittensor.CHAIN_ID) });
  await r.check({ ...onDoor, read: "oracle()", get: door("oracle"), want: a.oracle });
  await r.check({ ...onDoor, read: "swapper()", get: door("swapper"), want: a.staker });
  await r.check({ ...onDoor, read: "treasury()", get: door("treasury"), want: roles.treasury });
  await r.check({ ...onDoor, read: "asset()", get: door("asset"), want: LIVE.base.TOKEN }, "door.asset");
  await r.check({ ...onDoor, read: "usdc()", get: door("usdc"), want: BASE_V3.USDC }, "door.usdc");
  // the floors and the batch settings, as planned
  if (doorP) {
    const floors = plan.poolFloors;
    await r.check({ ...onDoor, read: "minPoolLiquidity(0)", get: door("minPoolLiquidity", [0n]), want: floors[0] }, "floor0");
    await r.check({ ...onDoor, read: "minPoolLiquidity(1)", get: door("minPoolLiquidity", [1n]), want: floors[1] }, "floor1");
    for (const name of DOOR_SETTINGS) await r.check({ ...onDoor, read: `${name}()`, get: door(name), want: doorP[name] }, VALUE_KEYS[name]);
  }
  // Revision 28: 120 ms, twice as fast as Base's 0.2 s; a seconds value such as 2 fails here
  await r.check({ ...onDoor, read: "MS_PER_BLOCK()", get: door("MS_PER_BLOCK"), want: MS_PER_BLOCK_PINS.base });
  await stampDomain(ctx, r, "base", "CascadeFrontDoor", "CascadeDoorLens", a.frontDoor, (fn) => readDoorLens(ctx, rec, fn, [], buildsDir));
  r.add(
    await classTableFindings(ctx, {
      chain: "base",
      name: "CascadeFrontDoor",
      table: SCHEDULED_V32.frontDoor,
      contract: "frontDoor",
      to: a.frontDoor,
      owner: roles.owner,
      abi: build.contracts.CascadeFrontDoor.abi,
      errors: buildErrorsV32(build),
      launchChain: BigInt(LIVE.base.CHAIN_ID),
    }),
  );

  // the staker: its owner, treasury, tokens, fees and route 0
  const stakerAbi = build.contracts.CascadeStaker.abi;
  const staker = (fn: string, args: readonly unknown[] = []) => () => read(ctx.rpc, "base", { address: a.staker, abi: stakerAbi, functionName: fn, args });
  const onStaker = { chain: "base" as const, contract: "CascadeStaker" };
  await r.check({ ...onStaker, read: "owner()", get: staker("owner"), want: roles.owner });
  await r.check({ ...onStaker, read: "treasury()", get: staker("treasury"), want: roles.treasury });
  await r.check({ ...onStaker, read: "frontDoor()", get: staker("frontDoor"), want: a.frontDoor });
  await r.check({ ...onStaker, read: "tao()", get: staker("tao"), want: LIVE.base.TOKEN }, "staker.tao");
  await r.check({ ...onStaker, read: "usdc()", get: staker("usdc"), want: BASE_V3.USDC }, "staker.usdc");
  if (stakerP) {
    await r.check({ ...onStaker, read: "swapFeeBps()", get: staker("swapFeeBps"), want: stakerP.swapFeeBps });
    await r.check({ ...onStaker, read: "depositFeeUsdc()", get: staker("depositFeeUsdc"), want: stakerP.depositFeeUsdc });
    await r.check({ ...onStaker, read: "deliveryRouteId()", get: staker("deliveryRouteId"), want: stakerP.deliveryRouteId });
    const route = stakerP.route0;
    await r.check({ ...onStaker, read: "routes(0)", get: staker("routes", [0]), want: [route.kind, route.router, route.buyPath, route.sellPath, route.active] }, "route0");
  }

  // the oracle (R3 C-I4): its tokens and pools as planned, its tokens the front door's and the staker's
  const oracleAbi = build.contracts.CascadeTwapOracle.abi;
  const oracle = (fn: string) => () => read(ctx.rpc, "base", { address: a.oracle, abi: oracleAbi, functionName: fn });
  const onOracle = { chain: "base" as const, contract: "CascadeTwapOracle" };
  const [taoWethPool, wethUsdcPool, tao, weth, usdc] = (plan.steps.find((s) => s.id === "oracle")?.args ?? []) as Address[];
  await r.check({ ...onOracle, read: "taoWethPool()", get: oracle("taoWethPool"), want: taoWethPool ?? BASE_V3.TAO_WETH_POOL });
  await r.check({ ...onOracle, read: "wethUsdcPool()", get: oracle("wethUsdcPool"), want: wethUsdcPool ?? BASE_V3.WETH_USDC_POOL });
  const oTao = await r.check({ ...onOracle, read: "tao()", get: oracle("tao"), want: tao ?? LIVE.base.TOKEN });
  const oWeth = await r.check({ ...onOracle, read: "weth()", get: oracle("weth"), want: weth ?? BASE_V3.WETH });
  const oUsdc = await r.check({ ...onOracle, read: "usdc()", get: oracle("usdc"), want: usdc ?? BASE_V3.USDC });
  for (const [what, mine, theirs] of [
    ["TAO", oTao, [r.values.get("door.asset"), r.values.get("staker.tao")]],
    ["USDC", oUsdc, [r.values.get("door.usdc"), r.values.get("staker.usdc")]],
  ] as const) {
    if (typeof mine !== "string" || theirs.some((x) => typeof x !== "string")) continue;
    if (!theirs.every((x) => same(x, mine))) {
      r.out.failures.push(`Base CascadeTwapOracle: its ${what} ${show(mine)} is not the front door's (${show(theirs[0])}) and the staker's (${show(theirs[1])}): it would price another token`);
    }
  }
  // route 0 swaps through the oracle's pools: USDC, WETH, TAO by the fee tiers the pools have
  const route = r.values.get("route0") as readonly unknown[] | undefined;
  const buy = pathOf(route?.[2]);
  const pools: [string, Address, number | undefined][] = [
    ["WETH/USDC", wethUsdcPool ?? BASE_V3.WETH_USDC_POOL, buy?.fees[0]],
    ["TAO/WETH", taoWethPool ?? BASE_V3.TAO_WETH_POOL, buy?.fees[1]],
  ];
  if (route && (!buy || !same(buy.tokens, [oUsdc, oWeth, oTao]))) {
    r.out.failures.push(`Base CascadeStaker.routes(0): its buy path ${show(route[2])} is not USDC, WETH, TAO, the oracle's tokens`);
  }
  // the pools' history: observation slots in use to cover the oracle's 30 minutes at Base's block time, measured
  const need = await cardinalityNeededNow(ctx).catch((e: Error) => {
    r.out.failures.push(`Base: the block time could not be read (${e.message.split("\n")[0]}), so neither pool's history is checked`);
    return undefined;
  });
  for (const [pair, pool, tier] of pools) {
    await r.check({
      chain: "base",
      contract: `the oracle's ${pair} pool ${getAddress(pool)}`,
      read: "fee()",
      get: () => read(ctx.rpc, "base", { address: pool, abi: POOL_FEE, functionName: "fee" }),
      rule: { test: (v) => whole(v) && tier !== undefined && Number(v) === tier, expected: tier === undefined ? "route 0's fee tier (unread)" : `${tier}, route 0's fee tier` },
    });
    if (need === undefined) continue;
    const slots = await r.check({
      chain: "base",
      contract: `the oracle's ${pair} pool ${getAddress(pool)}`,
      read: "slot0().observationCardinality",
      get: async () => Number(((await read(ctx.rpc, "base", { address: pool, abi: POOL_ABI, functionName: "slot0" })) as readonly unknown[])[3]),
      rule: { test: (v) => whole(v) && Number(v) >= need, expected: `at least ${need}` },
    });
    if (whole(slots) && Number(slots) >= need) r.out.info.push(`Base: the oracle's ${pair} pool has ${slots} observation slots in use (its 30-minute window needs ${need})`);
  }
  // its pools' depth over the window, against the front door's floors: a pool below its floor makes deliver refuse
  // (ThinPool) until it deepens, so it warns; a revert ("OLD": history short of the window) fails
  try {
    const [taoWeth, wethUsdc] = (await read(ctx.rpc, "base", { address: a.oracle, abi: oracleAbi, functionName: "meanLiquidity" })) as readonly [bigint, bigint];
    for (const [pair, depth, floorKey] of [
      ["TAO/WETH", taoWeth, "floor0"],
      ["WETH/USDC", wethUsdc, "floor1"],
    ] as const) {
      const floor = r.values.get(floorKey);
      r.out.info.push(`Base CascadeTwapOracle.meanLiquidity(): the ${pair} pool's is ${depth}${whole(floor) ? ` (the front door's floor is ${floor})` : ""}`);
      if (whole(floor) && depth < BigInt(floor)) {
        r.out.warnings.push(`Base CascadeTwapOracle.meanLiquidity(): the ${pair} pool's ${depth} is below the front door's floor ${floor}: USDC deliveries are refused (ThinPool) until it deepens`);
      }
    }
  } catch (e) {
    r.out.failures.push(`Base CascadeTwapOracle.meanLiquidity(): could not be read (${(e as Error).message.split("\n")[0]})`);
  }

  // the Base adapter: its treasury, and its cap and send minimum for the cap relations
  const baseAbi = build.contracts.CcipBaseAdapter.abi;
  const base = (fn: string) => () => read(ctx.rpc, "base", { address: a.baseAdapter, abi: baseAbi, functionName: fn });
  const onBase = { chain: "base" as const, contract: "CcipBaseAdapter" };
  await r.check({ ...onBase, read: "treasury()", get: base("treasury"), want: roles.treasury });
  await r.check({ ...onBase, read: "maxMessageValue()", get: base("maxMessageValue"), want: baseP?.[0]?.maxMessageValue }, "baseCap");
  await r.check({ ...onBase, read: "minSendAmount()", get: base("minSendAmount"), want: baseP?.[1] }, "minSendAmount");
  // its gas model toward Bittensor, the lane's inbound model, for the check that the Bittensor adapter holds the same
  await r.check({ ...onBase, read: "gasBase()", get: base("gasBase"), want: baseP?.[0]?.gasBase }, "baseGasBase");
  await r.check({ ...onBase, read: "gasPerEntry()", get: base("gasPerEntry"), want: baseP?.[0]?.gasPerEntry }, "baseGasPerEntry");
}

/** The lane's inbound gas model, one model in two copies (spec §3.2, R4): the Bittensor adapter's inboundGasBase and
 * inboundGasPerEntry, which deliverParked requires above PARK_GAS_RESERVE, must be the Base adapter's own gasBase and
 * gasPerEntry, what CCIP gives a delivery toward Bittensor. Each difference is a failure (a lower copy lets a keeper's
 * deliverParked starve the vault into a re-park; a higher one asks more gas than any delivery needs). */
export function inboundModelProblems(m: { inboundGasBase: bigint; inboundGasPerEntry: bigint; gasBase: bigint; gasPerEntry: bigint }): string[] {
  const out: string[] = [];
  for (const [mine, theirs, a, b] of [
    [m.inboundGasBase, m.gasBase, "inboundGasBase", "gasBase"],
    [m.inboundGasPerEntry, m.gasPerEntry, "inboundGasPerEntry", "gasPerEntry"],
  ] as const) {
    if (mine !== theirs) {
      out.push(`Bittensor CcipBittensorAdapter.${a} (${mine}) is not Base CcipBaseAdapter.${b} (${theirs}): the lane's inbound gas model is one model, and deliverParked's gas requirement would not be what CCIP gives a delivery`);
    }
  }
  return out;
}

/** `pnpm ops verify` on a v3.2 record (the one at `path`, for this kind of run): verifyV32, printed, and its result saved
 * into the record as it is on disk by then (the read-back is slow: only `verify` is set, never in another deployment's
 * record). True when nothing failed. */
export async function verifyV32AndSave(ctx: Pick<Ctx, "rpc" | "targets" | "logs" | "logsWindow" | "live" | "log">, path: string, opts: { buildsDir?: string } = {}): Promise<boolean> {
  const rec = loadRecordV32For(path, ctx.live);
  if (!rec) throw new Error(`no ${ctx.live ? "live" : "rehearsal"} v3.2 deployment record at ${path}: run deploy --v32${ctx.live ? " --live" : ""} first`);
  const r = await verifyV32(ctx, rec, opts);
  const result: VerifyResult = { ok: r.failures.length === 0, failures: r.failures, ...(r.warnings.length ? { warnings: r.warnings } : {}), checkedAt: new Date().toISOString() };
  const now = loadRecord(path) as unknown as DeploymentRecordV32 | null;
  const sameDeployment =
    now?.target === rec.target && now.build?.hash === rec.build.hash && Object.keys(rec.plan.addresses).every((k) => same(now.plan?.addresses?.[k as V32StepId], rec.plan.addresses[k as V32StepId]));
  if (!sameDeployment) throw new Error(`${path} now holds another deployment; the read-back was not saved`);
  saveRecord(path, { ...now, verify: result });
  if (r.info.length) ctx.log(`For information:\n  ${r.info.join("\n  ")}`);
  if (result.ok) ctx.log("Read-back check: everything matches the plan");
  else ctx.log(`Read-back check FAILED:\n  ${result.failures.join("\n  ")}`);
  if (r.warnings.length) ctx.log(`Warnings (not failures):\n  ${r.warnings.join("\n  ")}`);
  return result.ok;
}
