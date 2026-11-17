import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Abi,
  type AbiEvent,
  type AbiFunction,
  type Address,
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionData,
  decodeFunctionResult,
  encodeEventTopics,
  encodeFunctionData,
  formatUnits,
  getAddress,
  type Hex,
  hexToBigInt,
  hexToNumber,
  isAddress,
  keccak256,
  numberToHex,
  parseAbi,
  toFunctionSelector,
} from "viem";
import { type ChainName, PRECOMPILE, targets } from "../config.ts";
import { type Payout, type PayoutLog, payoutsHash, rebuildPayouts } from "../keeper/payouts.ts";
import { blockTimeOf } from "../keeper/core/blocktime.ts";
import { BITTENSOR_TX_GAS_CEILING } from "../keeper/core/ceiling.ts";
import { blockAtOrAfter, windowOf } from "../keeper/state.ts";
import { chainIdOf, isRevert, read, RpcError } from "../rpc.ts";
import { type Ctx, chainLabel, logsOf } from "../send.ts";
import { type NewWalletCall, type WalletCall, walletFile, writeWalletFile, wroteLine } from "../wallet.ts";
import { type BuildV32, buildErrorsV32, loadBuildV32 } from "./build.ts";
import { halfInBlocks, isRailFn, SCHEDULED_V32 } from "./classes.ts";
import { type DeploymentRecordV32, ownerKindOf } from "./deploy.ts";
import { type DoorRead, readDoor, readVault, type VaultRead, writeOffMissingStakeRao } from "./lens.ts";
import { capsWarning, type OwnerKind, parseHotkey, WRITE_OFF_EXECUTE_GAS } from "./settings.ts";

// v3.2's scheduler from ops (spec §3.6; plan Task 47). Every loosening change, guardian swap, transfer of ownership and
// activation waits as an item in the vault's or the front door's scheduler: the owner schedules it (schedule(data)), the
// guardian may cancel an Ordinary one during its delay (only the owner a GuardianSwap or a Reopen), it runs from readyAt
// (and readyBlock) until its window ends, and an owner stamp or closure after its scheduling kills it. Ops writes each
// of the founder's calls as a wallet-call file for the sign page (`--for-wallet`; Task 49 decodes them there), and signs
// and sends nothing itself. The rulings (the controller's, for Task 47):
// - the id is the contract's: schedule(data) carries the setter's exact calldata, and the item's id is keccak256 of it,
//   which the contract itself answers when asked by eth_call from the owner, before any file is written;
// - what the scheduler takes is the contract's own class table, asked by that eth_call (UnknownSelector for anything
//   else), never a list kept here; the class and kind a file names before it is scheduled come from verify.ts's table
//   (held to the contracts' _classify by its test), and the lens's afterwards;
// - pending items come from the logs (Scheduled less Executed, Cancelled and Lapsed) and are judged by the lens
//   (scheduled(id), the clocks): an item it can't read is unknown, never "not pending", and never executed from here;
// - an item is its contract and its id: the roles are the same on both chains, so one calldata scheduled on both is one
//   id twice; cancel writes a file per copy, execute needs --on for an id pending on both, pending lists each copy;
// - execute refuses an item unknown, not ready, past its window or dead; cancel --as guardian a GuardianSwap or a Reopen
//   (or an unknown kind);
// - the owner's cancel of a payout batch (ruling A16) is its own command, cancel-payouts, which never reads the scheduler
//   (nor cancel the batches): it refuses, as final, a batch read empty or with nothing left to re-mint;
// - a failed read is never final, nor "not there": it says to try again (the fix round's ruling);
// - looseningOf judges a setter's item against the current values as its contract's _requireScheduledIfLoosens does,
//   field by field, with the monitor's directions (Task 55's directionOf, held to by test); setStakeHotkey is not a limit.

/** The two contracts with a scheduler. */
export type SchedulerContract = "vault" | "frontDoor";

/** CascadeTypes.sol's Kind and Delay, by their uint8. */
export const KINDS = ["Ordinary", "GuardianSwap", "Reopen"] as const;
export type Kind = (typeof KINDS)[number];
/** An item's kind as read: one of KINDS, or "unknown" when the read named none of them (then only the owner may cancel
 * it, as for any kind but Ordinary). */
export type ItemKind = Kind | "unknown";
export const CLASSES = ["Param", "Registry", "Guardian"] as const;
export type DelayClass = (typeof CLASSES)[number];

const SCHEDULERS: Record<SchedulerContract, { chain: ChainName; name: string }> = {
  vault: { chain: "bittensor", name: "vault" },
  frontDoor: { chain: "base", name: "front door" },
};

/** The scheduler's own entry points (CascadeBase), which the test holds to both contracts' build. */
export const SCHEDULER_ABI = parseAbi(["function schedule(bytes data) returns (bytes32 id)", "function execute(bytes data)", "function cancel(bytes32 id)"]);

/** How far back the logs are read past the longest delay and the window: a margin for clocks that differ by seconds. */
const LOOKBACK_MARGIN_S = 3_600;
/** How far before a payout batch's queuing its logs are read from. */
const BATCH_MARGIN_S = 600;
/** A label's and a title's most characters (wallet.ts parseWalletFile). */
const TEXT_MAX = 200;

/** What the scheduler reads of a v3.2 deployment record. */
export type RecordV32 = Pick<DeploymentRecordV32, "target" | "plan" | "build" | "done" | "pairs">;
/** The context the scheduler reads with: the RPC, the log server and its window, and the chains' ids. */
export type SchedulerCtx = Pick<Ctx, "rpc" | "logs" | "logsWindow" | "targets">;
/** Where the frozen builds are (ops/builds/ by default). */
export interface BuildsOpt {
  buildsDir?: string;
}
/** Where a command writes its call file, the deployment's name, and the time it is made (ms); and where the relayer's
 * signed stamp stacks are on this PC (ops/stamps/: pnpm ops schedule warns when one reaches an item's schedule time;
 * Task 53's fix round), absent where the caller has none to name. */
export interface FileOpts extends BuildsOpt {
  dir: string;
  name: string;
  now: number;
  stampsDir?: string;
}

/** The stamp stack's lines for an item scheduled on `c` now (Task 53's fix round; the review's Important 3): a stamp
 * relayed with an asOf at or after an item's scheduling kills it (CascadeBase's stamp moves the owner's clock), so a
 * signed stamp of the stack not relayed yet, as of the chain's head or later, is warned of, with the stack's last asOf;
 * a stack ops can't read here (none on this PC, another deployment's or contract's, unreadable) says to check it by
 * hand. Nothing when `stampsDir` isn't named. */
export async function stackWarning(ctx: Pick<Ctx, "rpc" | "logs">, rec: RecordV32, c: SchedulerContract, o: { stampsDir?: string; name?: string }): Promise<string[]> {
  if (o.stampsDir === undefined) return [];
  const chain = SCHEDULERS[c].chain;
  const path = join(o.stampsDir, `${chain}.json`);
  const byHand = [
    `  No signed stamp stack for ${where(c)} is on this PC (${path}): if the relayer's stack is kept elsewhere, check by hand that its last signed asOf is before now; a stamp relayed as of this item's scheduling or later kills it.`,
  ];
  let stack: { deployment?: unknown; contract?: unknown; stamps?: { asOf: string; sig: string | null; relayed?: unknown; coveredBy?: unknown }[] };
  try {
    if (!existsSync(path)) return byHand;
    stack = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return byHand;
  }
  if (stack.deployment !== o.name || typeof stack.contract !== "string" || stack.contract.toLowerCase() !== rec.plan.addresses[c].toLowerCase() || !Array.isArray(stack.stamps)) return byHand;
  const head = BigInt((await readNow(`${chainLabel(chain)}'s head`, () => headOf(ctx, chain))).time);
  const reaching = stack.stamps.filter((s) => s.sig !== null && !s.relayed && !s.coveredBy && /^\d+$/.test(s.asOf) && BigInt(s.asOf) >= head);
  if (!reaching.length) return [];
  const last = reaching.reduce((m, s) => (BigInt(s.asOf) > m ? BigInt(s.asOf) : m), 0n);
  return [
    `  WARNING: ${where(c)}'s signed stamp stack (${path}) holds ${reaching.length} stamp${reaching.length === 1 ? "" : "s"} as of this item's scheduling or later, the last as of ${new Date(Number(last) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC: the bot's relay of the first kills this item. Schedule it after the stack's last asOf, or sign no stack reaching past its schedule time until it has executed.`,
  ];
}

/** "vault", "front-door" or "frontDoor" as a scheduler contract. Refused for anything else. */
export function schedulerOf(contract: string): SchedulerContract {
  if (contract === "vault") return "vault";
  if (contract === "front-door" || contract === "frontDoor") return "frontDoor";
  throw new Error(`${contract} has no scheduler: only the vault and the front door do (the staker's owner changes are immediate, within their caps); nothing written`);
}

export const where = (c: SchedulerContract) => `the ${SCHEDULERS[c].name} (${chainLabel(SCHEDULERS[c].chain)})`;
export const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];

/** A read that failed (the controller's ruling for the fix round: a failed read is never "final", nor "not there"):
 * the error that says so, and to try again. */
const readFailed = (what: string, e: unknown) => new Error(`Couldn't read ${what} right now (${firstLine(e)}); try again; nothing written`);
/** `read()`, or readFailed(`what`) when it fails. */
export async function readNow<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (e instanceof HistoryMissing) throw e;
    throw readFailed(what, e);
  }
}

/** A log server that kept no history back to the vault's creation (Task 46b's fix round, I3): a scan on it would read
 * "nothing" where there is something, so whatever asked is refused, and trying again on it won't help. */
export class HistoryMissing extends Error {}

/** The archive node known to keep Bittensor's whole history (config.ts's default OPS_BITTENSOR_RPC). */
export const ARCHIVE_NODE = "archive.chain.opentensor.ai";

/** The refusal for a log server whose logs lack the vault's constructor's BridgeActivated in its creation block. */
export const historyMissing = (rec: Pick<RecordV32, "plan">, created: number) =>
  new HistoryMissing(
    `this RPC doesn't keep history; use an archive node (${ARCHIVE_NODE} is the known one): its logs show no BridgeActivated(${getAddress(rec.plan.addresses.bitAdapter)}) in block ${created}, which the vault's constructor logged`,
  );

/** Proves, before a Bittensor log scan, that the log server keeps the vault's history back to its creation: the
 * vault's constructor enabled the record's Bittensor adapter there (CascadeBase's BridgeActivated), so a server whose
 * logs lack it has pruned them (a lite node keeps minutes). Throws HistoryMissing; a read that fails throws as it is.
 * It proves a node that prunes oldest first, not a server with gaps in between (a load-balanced or aggregator endpoint
 * that answers this from an archive backend and a later window from a pruned one): OPS_BITTENSOR_RPC must be one
 * archive node (Task 46b's re-review, N1; the runbook's line is Task 53's). */
export async function proveBittensorHistory(ctx: Pick<Ctx, "rpc" | "logs" | "logsWindow">, rec: RecordV32, o: BuildsOpt = {}): Promise<void> {
  const created = rec.done.vault?.block;
  if (created === undefined) throw new Error("the record has no block for the vault's creation, where its logs start; nothing read");
  const build = loadBuildV32(rec.build, o.buildsDir);
  const logs = await scanEvents(ctx, "bittensor", getAddress(rec.plan.addresses.vault), build.vaultAbi, ["BridgeActivated"], BigInt(created), BigInt(created));
  if (!logs.some((l) => String(l.args.bridge).toLowerCase() === rec.plan.addresses.bitAdapter.toLowerCase())) throw historyMissing(rec, created);
}
/** An eth_call the node did not run: the error that says so, and to try again. */
export const checkFailed = (what: string, why: string) => new Error(`Couldn't check ${what} right now (the RPC did not run it: ${why}); try again; nothing written`);
export const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");
/** A delay as the spec says it: 48 hours, 7 days, 8 days. */
export const span = (s: number) => (s % 86_400 === 0 && s >= 3 * 86_400 ? `${s / 86_400} days` : s % 3_600 === 0 ? `${s / 3_600} hours` : `${s} seconds`);
export const fit = (full: string, short: string) => (full.length <= TEXT_MAX ? full : short.length <= TEXT_MAX ? short : short.slice(0, TEXT_MAX));
export const abiOf = (build: BuildV32, c: SchedulerContract): Abi => (c === "vault" ? build.vaultAbi : build.contracts.CascadeFrontDoor.abi);

/** The chain id a wallet call names: the live chains' for a live record, else the forks' (which walletFile refuses). */
export const chainIdFor = (rec: Pick<RecordV32, "target">, chain: ChainName): number => targets({})[rec.target === "live" ? "live" : "rehearsal"][chain].chainId;

/** A value as a label and a line show it: integers in decimal, addresses checksummed, anything else as it is. */
function shown(v: unknown): string {
  if (typeof v === "string" && isAddress(v, { strict: false })) return getAddress(v);
  return String(v);
}
const callText = (fn: string, args: readonly unknown[]) => `${fn}(${args.map(shown).join(", ")})`;

/** A getter of the scheduler contract `c`, through its lens when it moved there (lens.ts), at `block` when given. */
function readOf(ctx: Pick<Ctx, "rpc">, rec: RecordV32, c: SchedulerContract, fn: string, args: readonly unknown[], o: BuildsOpt, block?: bigint): Promise<unknown> {
  return c === "vault" ? readVault(ctx, rec, fn as VaultRead, args, o.buildsDir, block) : readDoor(ctx, rec, fn as DoorRead, args, o.buildsDir, block);
}

/** Refuses, nothing read, an RPC that answers another chain's id than the context's: both chains', or only `chains`'
 * (a run that needs one chain is not held up by the other's RPC, Task 49's review, M7). */
export async function checkChains(ctx: SchedulerCtx, chains: readonly ChainName[] = ["bittensor", "base"]): Promise<void> {
  for (const chain of (["bittensor", "base"] as const).filter((c) => chains.includes(c))) {
    const id = await readNow(`${chainLabel(chain)}'s chain id`, () => chainIdOf(ctx.rpc, chain));
    if (id !== ctx.targets[chain].chainId) throw new Error(`${chainLabel(chain)}: the RPC reports chain id ${id}, not ${ctx.targets[chain].chainId}; nothing read or written`);
  }
}

// ---- asking the contract ----

/** What one eth_call answers: its return data, the error it reverts with (named from the build's errors), or nothing,
 * the node not having run it. */
export type Answer = { kind: "ok"; out: Hex } | { kind: "reverted"; name?: string; error: string } | { kind: "unread"; why: string };

export async function ask(ctx: Pick<Ctx, "rpc">, chain: ChainName, tx: { from: Address; to: Address; data: Hex; value?: Hex; gas?: Hex }, errors: Abi): Promise<Answer> {
  try {
    return { kind: "ok", out: (await ctx.rpc.request(chain, "eth_call", [tx, "latest"])) as Hex };
  } catch (e) {
    if (!isRevert(e)) return { kind: "unread", why: firstLine(e) };
    const raw = e instanceof RpcError ? e.data : undefined;
    const data = typeof raw === "string" ? raw : (raw as { data?: unknown } | undefined)?.data;
    if (typeof data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(data)) {
      try {
        const d = decodeErrorResult({ abi: errors, data: data as Hex });
        return { kind: "reverted", name: d.errorName, error: `${d.errorName}(${(d.args ?? []).map(String).join(", ")})` };
      } catch {
        return { kind: "reverted", error: `revert data ${data}` };
      }
    }
    return { kind: "reverted", error: firstLine(e) };
  }
}

/** The call `tx` must succeed by eth_call: refused, with `what` and the contract's error, when it would revert, and when
 * the node did not answer (a call that can't be checked is not written). */
async function mustSucceed(ctx: Pick<Ctx, "rpc">, chain: ChainName, tx: { from: Address; to: Address; data: Hex; gas?: Hex }, errors: Abi, what: string): Promise<Hex> {
  const a = await ask(ctx, chain, tx, errors);
  if (a.kind === "unread") throw checkFailed(what, a.why);
  if (a.kind === "reverted") throw new Error(`${what} would revert: ${a.error}; nothing written`);
  return a.out;
}

// ---- schedule ----

/** A word-sized static ABI type: what an item's canonical calldata carries, one word an argument (_requireArgs). */
const ONE_WORD = /^(u?int\d*|address|bool|bytes([1-9]|[12]\d|3[0-2]))$/;
const signatureOf = (f: AbiFunction) => `${f.name}(${f.inputs.map((p) => p.type).join(",")})`;

/** The setter `fn` of `abi`: exactly one function by that name, changing state, whose arguments are each one word. */
function setterOf(abi: Abi, c: SchedulerContract, fn: string): AbiFunction {
  const fs = abi.filter((x): x is AbiFunction => x.type === "function" && x.name === fn);
  if (fs.length === 0) throw new Error(`${where(c)} has no function ${fn}; nothing written`);
  if (fs.length > 1) throw new Error(`${where(c)} has ${fs.length} functions named ${fn}; nothing written`);
  const f = fs[0];
  if (f.stateMutability === "view" || f.stateMutability === "pure") throw new Error(`${signatureOf(f)} on ${where(c)} reads, it changes nothing: nothing to schedule; nothing written`);
  const wide = f.inputs.filter((p) => !ONE_WORD.test(p.type));
  if (wide.length) throw new Error(`${signatureOf(f)} takes ${wide.map((p) => p.type).join(", ")}, which no scheduled item carries (one word an argument); nothing written`);
  return f;
}

/** The arguments of `f` from the words typed after it: an address, a whole number (decimal or 0x hex), true or false, a
 * hotkey (an SS58 address or 32 bytes of hex) for a bytes32, exact hex for a shorter bytesN. Each one's range is the
 * encoder's to check. */
export function argsFrom(f: AbiFunction, words: readonly string[]): unknown[] {
  const names = f.inputs.map((p, i) => p.name || `argument ${i + 1}`);
  if (words.length !== f.inputs.length) {
    throw new Error(`${signatureOf(f)} takes ${f.inputs.length} argument${f.inputs.length === 1 ? "" : "s"} (${names.join(", ") || "none"}), not ${words.length}; nothing written`);
  }
  return f.inputs.map((p, i) => {
    const w = words[i].trim();
    const name = names[i];
    if (p.type === "address") {
      if (!isAddress(w)) throw new Error(`${name} ${w} is not an address (or its checksum is wrong); nothing written`);
      return getAddress(w);
    }
    if (p.type === "bool") {
      if (w !== "true" && w !== "false") throw new Error(`${name} ${w} is not true or false; nothing written`);
      return w === "true";
    }
    if (/^u?int/.test(p.type)) {
      if (!/^(\d+|0x[0-9a-fA-F]+)$/.test(w)) throw new Error(`${name} ${w} is not a whole number (in wei, rao, seconds or bps, as the setter takes it); nothing written`);
      return BigInt(w);
    }
    if (p.type === "bytes32") return parseHotkey(name, w);
    const size = Number(p.type.slice("bytes".length));
    if (!new RegExp(`^0x[0-9a-fA-F]{${size * 2}}$`).test(w)) throw new Error(`${name} ${w} is not ${size} bytes of hex; nothing written`);
    return w.toLowerCase();
  });
}

/** The owner's schedule(data) of `fn(args)` on the vault or the front door, as a wallet call: `data` is the setter's
 * exact calldata (its canonical encoding, one word an argument), sent to the contract on its chain from the record's
 * owner (or `o.from`, the owner the contract names now). Whether the scheduler takes it is the contract's to say
 * (scheduleCommand asks it before writing). */
export function scheduleCall(rec: RecordV32, contract: string, fn: string, args: readonly unknown[], o: BuildsOpt & { from?: Address } = {}): WalletCall {
  const c = schedulerOf(contract);
  const abi = abiOf(loadBuildV32(rec.build, o.buildsDir), c);
  const f = setterOf(abi, c, fn);
  if (args.length !== f.inputs.length) throw new Error(`${signatureOf(f)} takes ${f.inputs.length} arguments, not ${args.length}; nothing written`);
  let inner: Hex;
  try {
    inner = encodeFunctionData({ abi: [f], functionName: f.name, args } as never);
  } catch (e) {
    throw new Error(`${signatureOf(f)} refuses those arguments (${firstLine(e)}); nothing written`);
  }
  if (inner.length !== 10 + 64 * f.inputs.length) throw new Error(`${signatureOf(f)}'s calldata is not one word an argument; nothing written`);
  const data = encodeFunctionData({ abi, functionName: "schedule", args: [inner] } as never);
  const chain = SCHEDULERS[c].chain;
  return {
    chainId: chainIdFor(rec, chain),
    to: getAddress(rec.plan.addresses[c]),
    data,
    value: "0",
    label: fit(`schedule(${callText(f.name, args)}) on ${where(c)}`, `schedule(${f.name}) on ${where(c)}`),
    from: getAddress(o.from ?? rec.plan.roles.owner),
  };
}

/** The setter calldata a schedule(data) call carries. */
export const innerOf = (data: Hex): Hex => (decodeFunctionData({ abi: SCHEDULER_ABI, data }).args?.[0] as Hex) ?? "0x";

/** Who may cancel an item of `kind` (I-24): only the owner, but for an Ordinary item (an unknown kind counts as owner-only). */
export const cancellers = (kind: ItemKind) => (kind === "Ordinary" ? "the owner or the guardian" : "only the owner");

/** Why `c`'s scheduler refuses an item, in words, from the contract's error. */
function scheduleRefusal(c: SchedulerContract, text: string, owner: Address, a: Answer & { kind: "reverted" }): string {
  if (a.name === "UnknownSelector") return `${where(c)} does not schedule ${text.slice(0, text.indexOf("("))}: its scheduler answers ${a.error}, so it is not a scheduled change (a direct owner call needs no schedule); nothing written`;
  if (a.name === "ExitsNotOpen") {
    return `${where(c)}'s scheduler refuses schedule(${text}) now (${a.error}): an Ordinary item needs the exits open and no closure or owner stamp in this second, a guardian swap no owner hold; nothing written`;
  }
  return `${where(c)}'s scheduler refuses schedule(${text}) from the owner ${owner}: ${a.error}; nothing written`;
}

/** The delays of the three classes, from `c`'s lens. */
export async function delaysOf(ctx: Pick<Ctx, "rpc">, rec: RecordV32, c: SchedulerContract, o: BuildsOpt): Promise<Record<DelayClass, number>> {
  return {
    Param: Number(await readOf(ctx, rec, c, "PARAM_DELAY", [], o)),
    Registry: Number(await readOf(ctx, rec, c, "REGISTRY_DELAY", [], o)),
    Guardian: Number(await readOf(ctx, rec, c, "GUARDIAN_DELAY", [], o)),
  };
}

/** The class and kind `fn(args)` takes when scheduled now: the class from classes.ts's table (SCHEDULED_V32, held to the
 * contracts' _classify by test/v32-verify.test.ts), an activation's kind from the target's state through the lens (a
 * bridge active before, or a door the owner removed: a Reopen). Refused when the table has no such function: ops writes
 * no item it can't describe. */
export async function classOf(ctx: Pick<Ctx, "rpc">, rec: RecordV32, c: SchedulerContract, fn: string, args: readonly unknown[], o: BuildsOpt): Promise<{ cls: DelayClass; kind: Kind }> {
  const entry = SCHEDULED_V32[c].find((s) => s.fn === fn);
  if (!entry) throw new Error(`${where(c)} takes ${fn} into its scheduler, but ops's class table (classes.ts SCHEDULED_V32) has no ${fn}, so its delay and who can cancel it can't be shown; nothing written`);
  if (entry.kind !== "Ordinary or Reopen") return { cls: entry.delay, kind: entry.kind };
  if (fn === "activateBridge") {
    const known = await readNow("whether the bridge was active before", () => readOf(ctx, rec, c, "bridgeKnown", [args[0]], o));
    return { cls: entry.delay, kind: known ? "Reopen" : "Ordinary" };
  }
  const state = await readNow("the door's state", async () => readVault(ctx, rec, "doorState", [await readVault(ctx, rec, "peerId", [args[0], args[1]], o.buildsDir)], o.buildsDir));
  // CascadeTypes.DoorState.Removed: a door the owner removed, which the guardian has not removed since
  return { cls: entry.delay, kind: Number(state) === 2 ? "Reopen" : "Ordinary" };
}

/** `pnpm ops schedule <vault|front-door> <function> <args…> --for-wallet`: the owner's schedule(data) of the setter call,
 * asked of the contract by eth_call from the owner it names now (its class table decides, and the id it answers must be
 * keccak256 of the calldata), then written to a call file for the sign page. writeOffMissingStake with no amount takes
 * the missing stake less the unlisted, read now (the T16 carry; lens.ts writeOffMissingStakeRao). Refused, nothing
 * written, whenever the contract would refuse it. A change to the bridges (activateBridge, disableBridge,
 * setPrimaryBridge), and `both`, go through the rail check instead (rails.ts railScheduleCommand, Task 47b): refused
 * here, so none is written without it. */
export async function scheduleCommand(ctx: SchedulerCtx, rec: RecordV32, o: FileOpts & { contract: string; fn: string; args: readonly string[] }): Promise<{ ok: boolean; lines: string[]; files: string[] }> {
  if (o.contract === "both" || isRailFn(o.fn)) {
    throw new Error(`${o.contract === "both" ? `both ${o.fn}` : o.fn} changes the bridges, which each chain keeps its own: it is written only after the rail check of both chains (v32/rails.ts railScheduleCommand); nothing written`);
  }
  const c = schedulerOf(o.contract);
  await checkChains(ctx);
  const s = await schedulePart(ctx, rec, c, o.fn, o.args, o);
  const title = fit(`Cascade ${o.name}: schedule ${s.text} on ${where(c)}`, `Cascade ${o.name}: schedule ${s.fn} on ${where(c)}, item ${s.id}`);
  const path = writeOne(o, `${o.name}-schedule-${s.fn}-${s.id.slice(2, 10)}`, title, s.call);
  return { ok: true, lines: [...s.lines, wroteLine(path, 1)], files: [path] };
}

/** One contract's schedule(data) of `fn(words)`, checked as scheduleCommand checks it, with its lines, and not written:
 * scheduleCommand writes it alone, the rail check (rails.ts) writes an activation with the other chain's in one file. */
export interface SchedulePart {
  contract: SchedulerContract;
  call: WalletCall;
  /** the item's id, keccak256 of the setter's calldata */
  id: Hex;
  fn: string;
  args: unknown[];
  /** "setMaxTotalAssets(2000000000000000000000)" */
  text: string;
  lines: string[];
}

/** The checks and lines of `pnpm ops schedule` on one contract (the chain ids are the caller's to check first). */
export async function schedulePart(ctx: SchedulerCtx, rec: RecordV32, c: SchedulerContract, fn: string, typed: readonly string[], o: BuildsOpt & { stampsDir?: string; name?: string }): Promise<SchedulePart> {
  const build = loadBuildV32(rec.build, o.buildsDir);
  const abi = abiOf(build, c);
  const chain = SCHEDULERS[c].chain;
  const f = setterOf(abi, c, fn);
  const lines: string[] = [];
  let words = typed;
  if (c === "vault" && f.name === "writeOffMissingStake") {
    const amount = await readNow("the missing and the unlisted stake", () => writeOffMissingStakeRao(ctx, rec, o.buildsDir));
    if (amount === 0n) throw new Error("nothing to write off: no stake is missing, or listing the vault's other hotkeys could bring all of it back (the missing stake is at most the unlisted); nothing written");
    if (!words.length) {
      words = [amount.toString()];
      lines.push(`The write-off is the missing stake less the unlisted, read now: ${amount} rao (${formatUnits(amount, 9)} TAO).`);
    } else if (BigInt(argsFrom(f, words)[0] as bigint) === 0n) {
      throw new Error("nothing to write off: writeOffMissingStake(0) writes off nothing; give no amount to take the missing stake less the unlisted; nothing written");
    } else if (BigInt(argsFrom(f, words)[0] as bigint) > amount) {
      throw new Error(
        `writeOffMissingStake(${words[0]}) is more than the missing stake less the unlisted (${amount} rao, read now), the most a write-off can take: pnpm ops execute refuses more, and the vault reverts WriteOffTooLarge too, but only while its own capped read of the unlisted stake succeeds, so don't count on that alone; schedule at most that, or give no amount; nothing written`,
      );
    }
  }
  const args = argsFrom(f, words);
  const owner = getAddress((await readNow(`${where(c)}'s owner`, () => readOf(ctx, rec, c, "owner", [], o))) as Address);
  const call = scheduleCall(rec, c, f.name, args, { buildsDir: o.buildsDir, from: owner });
  const inner = innerOf(call.data);
  const id = keccak256(inner);
  const text = callText(f.name, args);
  // the contract's own class table, and its id
  const a = await ask(ctx, chain, { from: owner, to: call.to, data: call.data }, buildErrorsV32(build));
  if (a.kind === "unread") throw checkFailed(`schedule(${text}) on ${where(c)}`, a.why);
  if (a.kind === "reverted") throw new Error(scheduleRefusal(c, text, owner, a));
  const answered = (decodeFunctionResult({ abi: SCHEDULER_ABI, functionName: "schedule", data: a.out }) as Hex).toLowerCase();
  if (answered !== id) throw new Error(`${where(c)} would schedule ${text} under ${answered}, not keccak256 of its calldata (${id}); nothing written`);
  const { cls, kind } = await classOf(ctx, rec, c, f.name, args, o);
  const delay = (await readNow(`${where(c)}'s delays`, () => delaysOf(ctx, rec, c, o)))[cls];
  const window = Number(await readNow(`${where(c)}'s window`, () => readOf(ctx, rec, c, "EXECUTE_WINDOW", [], o)));
  // half its delay in the contract's calibrated blocks (CascadeBase._halfInBlocks, Revision 28): its own MS_PER_BLOCK, as
  // the pending list reads it, so the two never disagree (review M-5; verify holds it to the pin)
  const ms = Number(await readNow(`${where(c)}'s MS_PER_BLOCK`, () => readOf(ctx, rec, c, "MS_PER_BLOCK", [], o)));
  const blocks = halfInBlocks(delay, ms);
  lines.unshift(
    `${chainLabel(chain)} ${SCHEDULERS[c].name} ${call.to}: schedule(${text}) from the owner ${owner} is accepted, as item ${id}.`,
    `  A ${cls} item (${span(delay)}), ${kind}: ${cancellers(kind)} can cancel it. It is ready ${span(delay)} and ${blocks.toLocaleString("en-US")} blocks after it lands, then can run for ${span(window)}.`,
  );
  if (owner.toLowerCase() !== rec.plan.roles.owner.toLowerCase()) lines.push(`  The owner is ${owner} now, not the record's ${rec.plan.roles.owner}: the file is from ${owner}.`);
  if (c === "vault" && f.name === "activateFrontDoor") lines.push(...(await doorChainWarning(ctx, rec, args[0] as bigint, o)));
  try {
    const l = looseningOf({ contract: c, fn: f.name, args: argsRecord(f, args) }, await currentValues(ctx, rec, { contract: c, fn: f.name, args: argsRecord(f, args) }, o));
    lines.push(...looseningLines(l));
  } catch (e) {
    lines.push(`  Whether it loosens a limit could not be read (${firstLine(e)}).`);
  }
  // a caps file above the founder level (Task 46b; ruling B7a's one helper): the Safe warning, never a refusal
  if (c === "vault" && f.name === "setMaxTotalAssets") lines.push(...(await capsFileWarning(ctx, owner, args[0] as bigint)));
  lines.push(
    kind === "Ordinary"
      ? "  A closure by the owner or the guardian, or an owner stamp, dated at or after the second it lands kills it: schedule it after the asOf of the last stamp you signed."
      : "  A closure by the owner, or an owner stamp, dated at or after the second it lands kills it: schedule it after the asOf of the last stamp you signed.",
  );
  // the relayer's stamp stack, before the file is written (Task 53's fix round)
  lines.push(...(await stackWarning(ctx, rec, c, o)));
  return { contract: c, call, id, fn: f.name, args, text, lines };
}

/** The Safe warning for a schedule of setMaxTotalAssets(`amount`) above the founder level (spec §7: a caps file above
 * the founder level while the owner is not a Safe of at least 2 of 3 warns, quoting section 5, and never refuses), as
 * indented lines; none at or below the level, or for a 2-of-3 Safe. The owner's kind is read only above the level, and
 * one that can't be read still warns, saying so. */
async function capsFileWarning(ctx: Pick<Ctx, "rpc">, owner: Address, amount: bigint): Promise<string[]> {
  if (capsWarning({ maxTotalAssets: amount }, { kind: "account" }) === null) return [];
  let kind: OwnerKind | undefined;
  try {
    kind = await ownerKindOf(ctx, "bittensor", owner);
  } catch {
    kind = undefined;
  }
  const w = capsWarning({ maxTotalAssets: amount }, kind);
  return w ? w.split("\n").map((l) => `  ${l}`) : [];
}

const REMOTE_CHAIN = parseAbi(["function remoteChainId() view returns (uint64)"]);

/** A warning when the vault's primary bridge does not serve `chain` (the R2 runbook carry: never activate a door on a
 * chain the primary does not serve): every payout goes over the primary, so that door's redeems could not be paid. */
async function doorChainWarning(ctx: Pick<Ctx, "rpc">, rec: RecordV32, chain: bigint, o: BuildsOpt): Promise<string[]> {
  try {
    const primary = (await readVault(ctx, rec, "primaryBridge", [], o.buildsDir)) as Address;
    const serves = (await read(ctx.rpc, "bittensor", { address: primary, abi: REMOTE_CHAIN, functionName: "remoteChainId" })) as bigint;
    if (serves === chain) return [];
    return [`  WARNING — the vault's primary bridge ${getAddress(primary)} serves chain ${serves}, not ${chain}: every payout goes over it, so this door's redeems could not be paid.`];
  } catch (e) {
    return [`  WARNING — whether the vault's primary bridge serves chain ${chain} could not be read (${firstLine(e)}): check it before this item runs.`];
  }
}

/** A setter's arguments by their parameters' names. */
const argsRecord = (f: AbiFunction, values: readonly unknown[]): Record<string, unknown> => Object.fromEntries(f.inputs.map((p, i) => [p.name || `arg${i}`, values[i]]));

/** Writes one call to its own file and returns its path. */
function writeOne(o: FileOpts, stem: string, title: string, call: WalletCall): string {
  return writeCalls(o, stem, title, [call]);
}

/** Writes calls (one, or a both-chains cancel's two, each on its own chain and none waiting on another) to one file and
 * returns its path. `oneSided`: the founder's reason for a rail change the rail check would refuse (Task 47b), written
 * into the file for the sign page to show. `ordered`: each call waits for the one before it to succeed (a both-chains
 * switch's direct calls, the front door's first: Task 47b's fix round). */
export function writeCalls(o: FileOpts, stem: string, title: string, calls: readonly WalletCall[], extra: { oneSided?: string; ordered?: boolean; offline?: true } = {}): string {
  // a call's own gas limit kept (R6, claim C: a write-off's execute)
  const out: NewWalletCall[] = calls.map(({ value, gas, ...rest }) => ({ ...rest, ...(value !== "0" ? { value: BigInt(value) } : {}), ...(gas !== undefined ? { gas: BigInt(gas) } : {}) }));
  return writeWalletFile(
    o.dir,
    stem,
    walletFile({
      title,
      deployment: o.name,
      now: o.now,
      calls: out,
      ...(extra.ordered ? { ordered: true } : {}),
      ...(extra.oneSided !== undefined ? { oneSided: extra.oneSided } : {}),
      ...(extra.offline ? { offline: true as const } : {}),
    }),
  );
}

// ---- the pending items ----

/** One scheduled item, as the logs name it and the lens judges it. */
export interface PendingItem {
  chain: ChainName;
  contract: SchedulerContract;
  address: Address;
  chainId: number;
  /** keccak256 of its calldata: the same calldata on both schedulers is one id, so an item is its contract and its id */
  id: Hex;
  kind: ItemKind;
  /** its delay class, from the lens (absent when unknown) */
  class?: DelayClass;
  selector: Hex;
  /** the setter its calldata calls, and its arguments by name (absent, and none, when it doesn't decode) */
  fn?: string;
  data: Hex;
  args: Record<string, unknown>;
  /** false when the calldata isn't the exact encoding of its arguments (dirty bits): the setter refuses it at execute */
  canonical: boolean;
  scheduledAt: number;
  readyAt: number;
  readyBlock: number;
  /** the end of its window in time: readyAt + EXECUTE_WINDOW */
  windowEnd: number;
  /** the end of its window in blocks: readyBlock + ceil(EXECUTE_WINDOW * 1000 / (2 * MS_PER_BLOCK)) (Revision 28). It
   * lapses only past both (CascadeBase._lapsed, `lapsed`) */
  windowEndBlock: number;
  /** about when it can last run: the later of windowEnd and windowEndBlock's time at the chain's block time as measured
   * (`until`: which clock, or "unread" when the block time could not be read and windowEnd stands in) */
  runsUntil: number;
  until: "time" | "blocks" | "unread";
  dead: boolean;
  /** the clock that killed it, when dead */
  deadBy?: number;
  /** why the lens could not judge it, when it could not: the item is neither pending nor gone, and is never executed */
  unknown?: string;
  /** the chain's head when it was read, at which its readiness and window are judged */
  head: { block: number; time: number };
  /** the owner and the guardian the contract names now (absent when they could not be read) */
  owner?: Address;
  guardian?: Address;
}

const SCHEDULER_EVENTS = ["Scheduled", "Executed", "Cancelled", "Lapsed"] as const;

export interface Scanned {
  eventName: string;
  args: Record<string, unknown>;
  block: bigint;
  index: number;
  tx: Hex;
}

const eventOf = (abi: Abi, name: string): AbiEvent => {
  const e = abi.filter((x): x is AbiEvent => x.type === "event" && x.name === name);
  if (e.length !== 1) throw new Error(`the build's ABI has ${e.length} events ${name}; nothing read`);
  return e[0];
};

/** The events `names` of the contract at `address`, from block `from` to `to`, in windows the log server accepts (one
 * query a window for every name at once, and `topic1` when given), in log order. A failed query throws. */
export async function scanEvents(ctx: Pick<Ctx, "rpc" | "logs" | "logsWindow">, chain: ChainName, address: Address, abi: Abi, names: readonly string[], from: bigint, to: bigint, topic1?: Hex): Promise<Scanned[]> {
  const evs = names.map((n) => eventOf(abi, n));
  const topic0s = evs.map((e) => (encodeEventTopics({ abi: [e], eventName: e.name } as never) as Hex[])[0]);
  const step = windowOf(ctx, chain);
  const rpc = logsOf(ctx);
  const out: Scanned[] = [];
  for (let start = from; start <= to; start += step) {
    const end = start + step - 1n < to ? start + step - 1n : to;
    const logs = (await rpc.request(chain, "eth_getLogs", [{ address, fromBlock: numberToHex(start), toBlock: numberToHex(end), topics: [topic0s, ...(topic1 ? [topic1] : [])] }])) as {
      address: Address;
      topics: Hex[];
      data: Hex;
      blockNumber: Hex;
      logIndex: Hex;
      transactionHash: Hex;
    }[];
    for (const l of logs) {
      if (l.address.toLowerCase() !== address.toLowerCase()) continue;
      const ev = evs[topic0s.findIndex((t) => t.toLowerCase() === l.topics[0]?.toLowerCase())];
      if (!ev) continue;
      const d = decodeEventLog({ abi: [ev], topics: l.topics as [Hex, ...Hex[]], data: l.data });
      out.push({ eventName: ev.name, args: d.args as Record<string, unknown>, block: hexToBigInt(l.blockNumber), index: hexToNumber(l.logIndex), tx: l.transactionHash });
    }
  }
  return out.sort((a, b) => (a.block === b.block ? a.index - b.index : a.block < b.block ? -1 : 1));
}

/** The chain's head, from the server the logs come from (one that lags then can't answer an older head's range as "no
 * logs"). */
export async function headOf(ctx: Pick<Ctx, "rpc" | "logs">, chain: ChainName): Promise<{ block: number; time: number }> {
  const b = (await logsOf(ctx).request(chain, "eth_getBlockByNumber", ["latest", false])) as { number: Hex; timestamp: Hex } | null;
  if (!b) throw new Error(`${chainLabel(chain)} has no latest block; nothing read`);
  return { block: hexToNumber(b.number), time: hexToNumber(b.timestamp) };
}

/** A setter call decoded with its contract's ABI: the setter, its arguments by name, and whether the calldata is exactly
 * their canonical encoding. No setter, and no arguments, for calldata that doesn't decode. */
export function decodeSetter(abi: Abi, data: Hex): { fn?: string; args: Record<string, unknown>; canonical: boolean } {
  const f = abi.find((x): x is AbiFunction => x.type === "function" && toFunctionSelector(x) === data.slice(0, 10).toLowerCase());
  if (!f) return { args: {}, canonical: false };
  try {
    const values = (decodeFunctionData({ abi: [f], data }).args ?? []) as readonly unknown[];
    let canonical = false;
    try {
      canonical = encodeFunctionData({ abi: [f], functionName: f.name, args: values } as never).toLowerCase() === data.toLowerCase();
    } catch {
      canonical = false;
    }
    return { fn: f.name, args: argsRecord(f, values), canonical };
  } catch {
    return { fn: f.name, args: {}, canonical: false };
  }
}

/** The items of `c`'s scheduler that may still run (spec §3.6): from its Scheduled logs less those an Executed, a
 * Cancelled or a Lapsed closed since, over the blocks back to the longest delay and the window before the head (an item
 * scheduled earlier is past its window), each re-read through the lens (scheduled(id)), which decides: nothing under its
 * id is gone; an item the lens can't read, or whose clocks can't be read, is unknown (never "not pending"). An item is
 * dead once its kind's clock reaches its scheduledAt (an Ordinary item's both clocks, the others' the owner's): it can
 * never run. A failed log scan throws: no list is better than a short one. Ids the logs closed are re-read too: one the
 * lens still holds was scheduled again in a block the logs missed, and is listed; one whose re-read fails is unknown,
 * since the lens can't confirm it closed. A kind the read names none of KINDS is "unknown" (owner-only to cancel).
 * With `o.head` (the rail check's pinned head, Task 47b) the scan ends there and the lens is read at that block. */
export async function pendingOn(ctx: Pick<Ctx, "rpc" | "logs" | "logsWindow">, rec: RecordV32, c: SchedulerContract, o: BuildsOpt & { head?: { block: number; time: number } } = {}): Promise<PendingItem[]> {
  const build = loadBuildV32(rec.build, o.buildsDir);
  const abi = abiOf(build, c);
  const chain = SCHEDULERS[c].chain;
  const address = getAddress(rec.plan.addresses[c]);
  const created = rec.done[c]?.block;
  if (created === undefined) throw new Error(`the record has no block for ${where(c)}'s creation, where its scheduler's logs start; nothing read`);
  if (chain === "bittensor") await proveBittensorHistory(ctx, rec, o);
  const at = o.head ? BigInt(o.head.block) : undefined;
  const get = (fn: string, args: readonly unknown[] = []) => readOf(ctx, rec, c, fn, args, o, at);
  const head = o.head ?? (await headOf(ctx, chain));
  const window = Number(await get("EXECUTE_WINDOW"));
  // the contract's own block time (its immutable, through the lens): the block windows are counted in it (Revision 28)
  const ms = Number(await get("MS_PER_BLOCK"));
  const delays = await delaysOf(ctx, rec, c, o);
  const longest = Math.max(...Object.values(delays));
  // an item that may still run was scheduled after both look-backs' starts: in time (its window in time), and in blocks
  // (its window in blocks: half the longest delay and half the window, which reaches further back only while the chain's
  // blocks come slower than twice its calibration)
  const since = head.time - longest - window - LOOKBACK_MARGIN_S;
  const fromTime = await blockAtOrAfter(ctx.rpc, chain, since, BigInt(head.block), head.time);
  const backBlocks = BigInt(halfInBlocks(longest, ms) + halfInBlocks(window, ms) + halfInBlocks(LOOKBACK_MARGIN_S, ms));
  const fromBlocks = BigInt(head.block) > backBlocks ? BigInt(head.block) - backBlocks : 0n;
  const earliest = fromBlocks < fromTime ? fromBlocks : fromTime;
  const from = earliest > BigInt(created) ? earliest : BigInt(created);
  // the chain's block time, to tell when the last block of an item's window comes; undefined when it can't be read
  const blockS = await blockTimeOf(ctx.rpc, chain, { block: BigInt(head.block), time: head.time }).catch(() => undefined);
  const windows = (readyAt: number, readyBlock: number) => {
    const windowEnd = readyAt + window;
    const windowEndBlock = readyBlock + halfInBlocks(window, ms);
    if (blockS === undefined) return { windowEnd, windowEndBlock, runsUntil: windowEnd, until: "unread" as const };
    const byBlocks = head.time + Math.ceil((windowEndBlock - head.block) * blockS);
    return byBlocks > windowEnd ? { windowEnd, windowEndBlock, runsUntil: byBlocks, until: "blocks" as const } : { windowEnd, windowEndBlock, runsUntil: windowEnd, until: "time" as const };
  };
  const logs = await scanEvents(ctx, chain, address, abi, SCHEDULER_EVENTS, from, BigInt(head.block));
  let clocks: { owner: number; guardian: number } | string;
  try {
    clocks = { owner: Number(await get("lastOwnerClose")), guardian: Number(await get("lastGuardianClose")) };
  } catch (e) {
    clocks = `its clocks could not be read (${firstLine(e)})`;
  }
  const role = async (fn: string): Promise<Address | undefined> => {
    try {
      return getAddress((await get(fn)) as Address);
    } catch {
      return undefined;
    }
  };
  const owner = await role("owner");
  const guardian = await role("guardian");
  const ids = new Map<string, { scheduled?: Scanned; last: Scanned }>();
  for (const l of logs) {
    const id = String(l.args.id).toLowerCase();
    const e = ids.get(id) ?? { last: l };
    e.last = l;
    if (l.eventName === "Scheduled") e.scheduled = l;
    ids.set(id, e);
  }
  const out: PendingItem[] = [];
  for (const [id, e] of ids) {
    if (!e.scheduled) continue;
    const s = e.scheduled;
    const candidate = e.last.eventName === "Scheduled";
    const data = (s.args.data as Hex).toLowerCase() as Hex;
    const decoded = decodeSetter(abi, data);
    const base = { chain, contract: c, address, chainId: chainIdFor(rec, chain), id: id as Hex, data, fn: decoded.fn, args: decoded.args, canonical: decoded.canonical, head, owner, guardian };
    const readyAt = Number(s.args.readyAt);
    const asLogged = (why: string): PendingItem => ({
      ...base,
      kind: KINDS[Number(s.args.kind)] ?? "unknown",
      selector: String(s.args.selector).toLowerCase() as Hex,
      scheduledAt: 0,
      readyAt,
      readyBlock: 0,
      ...windows(readyAt, 0),
      dead: false,
      unknown: why,
    });
    if (keccak256(data).toLowerCase() !== id) {
      if (candidate) out.push(asLogged("its Scheduled log's calldata does not hash to its id"));
      continue;
    }
    let item: { scheduledAt: bigint; readyAt: bigint; class: number; kind: number; selector: Hex; readyBlock: bigint };
    try {
      item = (await get("scheduled", [id])) as typeof item;
    } catch (err) {
      out.push(asLogged(candidate ? `the lens could not read it (${firstLine(err)})` : `the logs say it closed, but the lens could not confirm it (${firstLine(err)})`));
      continue;
    }
    // nothing under its id: executed, cancelled or pruned
    if (item.readyAt === 0n) continue;
    const kind = KINDS[Number(item.kind)];
    const cls = CLASSES[Number(item.class)];
    const lensed = {
      ...base,
      kind: kind ?? ("unknown" as const),
      ...(cls ? { class: cls } : {}),
      selector: item.selector.toLowerCase() as Hex,
      scheduledAt: Number(item.scheduledAt),
      readyAt: Number(item.readyAt),
      readyBlock: Number(item.readyBlock),
      ...windows(Number(item.readyAt), Number(item.readyBlock)),
    };
    if (!kind || !cls) {
      out.push({ ...lensed, dead: false, unknown: `the lens reads kind ${item.kind} and class ${item.class}, which this build does not have` });
      continue;
    }
    if (lensed.selector !== data.slice(0, 10)) {
      out.push({ ...lensed, dead: false, unknown: `the lens reads selector ${lensed.selector}, not its calldata's ${data.slice(0, 10)}` });
      continue;
    }
    if (typeof clocks === "string") {
      out.push({ ...lensed, dead: false, unknown: clocks });
      continue;
    }
    const clock = kind === "Ordinary" ? Math.max(clocks.owner, clocks.guardian) : clocks.owner;
    const dead = clock >= lensed.scheduledAt;
    out.push({ ...lensed, dead, ...(dead ? { deadBy: clock } : {}) });
  }
  return out;
}

/** Every item that may still run on both schedulers: the vault's, then the front door's (pendingOn). A chain that can't be
 * read throws: nothing is listed as "not pending" for want of a read. */
export async function pendingItems(ctx: Pick<Ctx, "rpc" | "logs" | "logsWindow">, rec: RecordV32, o: BuildsOpt = {}): Promise<PendingItem[]> {
  return [...(await pendingOn(ctx, rec, "vault", o)), ...(await pendingOn(ctx, rec, "frontDoor", o))];
}

/** The item's call as a line shows it: "setMaxTotalAssets(2000000000000000000000)", or its selector when it doesn't
 * decode. */
export const itemText = (i: Pick<PendingItem, "fn" | "args" | "selector">) => (i.fn ? callText(i.fn, Object.values(i.args)) : `selector ${i.selector}`);

/** Whether an item has lapsed at its head, as CascadeBase._lapsed decides: past its window in time (readyAt +
 * EXECUTE_WINDOW) and past its window in blocks (readyBlock + ceil(EXECUTE_WINDOW * 1000 / (2 * MS_PER_BLOCK))), both
 * (Revision 28). An item past one of them only can still run. */
export const lapsed = (i: Pick<PendingItem, "head" | "windowEnd" | "windowEndBlock">): boolean => i.head.time > i.windowEnd && i.head.block > i.windowEndBlock;

/** Until when an item can run, in words: its window in time's end; about when its window in blocks ends, when that comes
 * later; or, while the chain's block time can't be read, its time's end and its last block, whichever is later. */
export const untilText = (i: Pick<PendingItem, "windowEnd" | "windowEndBlock" | "runsUntil" | "until">): string =>
  i.until === "blocks"
    ? `about ${iso(i.runsUntil)} (block ${i.windowEndBlock.toLocaleString("en-US")}: its blocks come slower than its time)`
    : i.until === "unread"
      ? `${iso(i.windowEnd)} or block ${i.windowEndBlock.toLocaleString("en-US")}, whichever is later`
      : iso(i.windowEnd);

/** What a list says of an item: dead, unknown, past its window, waiting, or ready now. */
export function stateOf(i: PendingItem): string {
  if (i.unknown) return `unknown: ${i.unknown}`;
  if (i.dead) return `dead: a closure or an owner stamp at ${iso(i.deadBy ?? 0)} came after it was scheduled, so it can never run`;
  if (!i.canonical) return "it can never run: its calldata is not the exact encoding of its arguments";
  if (lapsed(i)) return `past its window (it ended ${untilText(i)}): it can no longer run, and anyone may prune it`;
  if (i.head.time < i.readyAt) return `waiting: ready at ${iso(i.readyAt)}`;
  if (i.head.block < i.readyBlock) return `waiting: ready at block ${i.readyBlock} (the chain is at ${i.head.block})`;
  return "ready now";
}

/** `pnpm ops pending`: each scheduler's items, with what each does, when it is ready, who can cancel it and whether it
 * would loosen a limit now. Each chain stands alone: one that can't be read says why, and the other is still listed. */
export async function pendingCommand(ctx: SchedulerCtx, rec: RecordV32, o: BuildsOpt = {}): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  for (const c of ["vault", "frontDoor"] as const) {
    const label = `${chainLabel(SCHEDULERS[c].chain)} ${SCHEDULERS[c].name}`;
    let items: PendingItem[];
    try {
      items = await pendingOn(ctx, rec, c, o);
    } catch (e) {
      ok = false;
      lines.push(e instanceof HistoryMissing ? `${label}: ${e.message}. Its items are not known.` : `${label}: couldn't read it right now (${firstLine(e)}); try again. Its items are not known.`);
      continue;
    }
    if (!items.length) {
      lines.push(`${label}: nothing scheduled that can still run`);
      continue;
    }
    lines.push(`${label}: ${items.length} item${items.length === 1 ? "" : "s"}`);
    for (const i of items) {
      if (i.unknown) ok = false;
      lines.push(
        `  ${i.id} ${itemText(i)}`,
        `    ${i.class ? `${i.class}, ` : ""}${i.kind}: ${cancellers(i.kind)} can cancel it. Scheduled ${i.scheduledAt ? iso(i.scheduledAt) : "(unknown)"}; ready ${iso(i.readyAt)}${i.readyBlock ? ` and block ${i.readyBlock}` : ""}; runs until ${untilText(i)}.`,
        `    Now: ${stateOf(i)}.`,
      );
      if (i.unknown || i.dead || !i.fn) continue;
      try {
        const l = looseningOf(i, await currentValues(ctx, rec, i, o));
        lines.push(...looseningLines(l).map((x) => `  ${x}`));
      } catch (e) {
        lines.push(`    Whether it loosens a limit could not be read (${firstLine(e)}).`);
      }
    }
  }
  return { ok, lines };
}

// ---- execute and cancel ----

// R6 (ChatGPT R2 claim C): a write-off's execute goes with the file's own gas limit (settings.ts WRITE_OFF_EXECUTE_GAS),
// under Bittensor's per-transaction ceiling
export { WRITE_OFF_EXECUTE_GAS };
if (WRITE_OFF_EXECUTE_GAS > BITTENSOR_TX_GAS_CEILING) throw new Error("WRITE_OFF_EXECUTE_GAS is above Bittensor's per-transaction ceiling");

/** An item that runs the vault's writeOffMissingStake. */
export const isWriteOff = (item: Pick<PendingItem, "contract" | "fn">): boolean => item.contract === "vault" && item.fn === "writeOffMissingStake";

/** R6 (claim C): a write-off's amount, checked again against the missing stake less the unlisted, read now through the
 * lens (uncapped), as at scheduling: refused when more, since the vault's own check rests on a capped read; the amount
 * and that most. A failed read is refused, never taken as 0. pnpm ops execute's, and the sign page's when it is served
 * and again just before it sends. */
export async function writeOffStillFits(ctx: Pick<Ctx, "rpc">, rec: RecordV32, item: Pick<PendingItem, "args">, buildsDir?: string): Promise<{ amount: bigint; most: bigint }> {
  const amount = BigInt(String(item.args.rao));
  const now = await readNow("the missing and the unlisted stake", () => writeOffMissingStakeRao(ctx, rec, buildsDir));
  if (amount > now) {
    throw new Error(
      `writeOffMissingStake(${amount}) is now more than the missing stake less the unlisted (${now} rao, read now): stake came back on a hotkey the vault doesn't list. Don't execute it: list that hotkey (addHotkey), and schedule a new write-off if any is still missing; nothing written`,
    );
  }
  return { amount, most: now };
}

/** The owner's execute(data) of a pending item, as a wallet call (a write-off's with its own gas limit). Refused when the
 * item is unknown, dead, not the exact encoding of its setter's arguments, past its window, or not ready (in time, and
 * in blocks: readyBlock), as read at the item's head, and when its owner could not be read. */
export function executeCall(item: PendingItem): WalletCall {
  const at = `item ${item.id} (${itemText(item)}) on ${where(item.contract)}`;
  if (item.unknown) throw new Error(`${at} could not be judged (${item.unknown}): an item is executed only once the lens reads it pending and alive; nothing written`);
  if (item.dead) throw new Error(`${at} is dead: a closure or an owner stamp at ${iso(item.deadBy ?? 0)} came after it was scheduled (${iso(item.scheduledAt)}), so it can never run; nothing written`);
  if (!item.fn || !item.canonical) throw new Error(`${at} can never run: its calldata is not the exact encoding of a setter's arguments, which the setter refuses at execute; nothing written`);
  if (lapsed(item)) throw new Error(`${at} is past its window (it ended ${untilText(item)}): it can no longer run, and anyone may prune it; nothing written`);
  if (item.head.time < item.readyAt) throw new Error(`${at} is not ready: it may run from ${iso(item.readyAt)}; nothing written`);
  if (item.head.block < item.readyBlock) throw new Error(`${at} is not ready: it may run from block ${item.readyBlock} (the chain is at block ${item.head.block}); nothing written`);
  if (!item.owner) throw new Error(`${at}: the owner could not be read, so the file can't name who sends it; nothing written`);
  return {
    chainId: item.chainId,
    to: item.address,
    data: encodeFunctionData({ abi: SCHEDULER_ABI, functionName: "execute", args: [item.data] }),
    value: "0",
    ...(isWriteOff(item) ? { gas: WRITE_OFF_EXECUTE_GAS.toString() } : {}),
    label: fit(`execute(${itemText(item)}) on ${where(item.contract)}: item ${item.id}`, `execute(${item.fn}) on ${where(item.contract)}: item ${item.id}`),
    from: item.owner,
  };
}

/** The cancel(id) of a pending item by the owner or the guardian, as a wallet call. The guardian may cancel only an
 * Ordinary item (I-24): a GuardianSwap or a Reopen is refused. */
export function cancelCall(item: PendingItem, as: "owner" | "guardian"): WalletCall {
  const at = `item ${item.id} (${itemText(item)}) on ${where(item.contract)}`;
  if (as === "guardian" && item.kind !== "Ordinary") {
    throw new Error(`the guardian cannot cancel ${at}: it is a ${item.kind}, and only the owner can cancel a guardian swap or a reopening; nothing written`);
  }
  const from = as === "owner" ? item.owner : item.guardian;
  if (!from) throw new Error(`${at}: the ${as} could not be read, so the file can't name who sends it; nothing written`);
  return {
    chainId: item.chainId,
    to: item.address,
    data: encodeFunctionData({ abi: SCHEDULER_ABI, functionName: "cancel", args: [item.id] }),
    value: "0",
    label: fit(`cancel(${item.id}) on ${where(item.contract)}: drops ${itemText(item)}`, `cancel(${item.id}) on ${where(item.contract)}: drops ${item.fn ?? item.selector}`),
    from,
  };
}

/** A scheduler that couldn't be read for a command, with why, and whether it was a log server without the vault's
 * history (HistoryMissing), where trying again won't help. */
interface Unread {
  contract: SchedulerContract;
  why: string;
  history: boolean;
}

/** Each scheduler's items, read for one command: a scheduler that can't be read is kept with why. */
async function itemsByChain(ctx: SchedulerCtx, rec: RecordV32, o: BuildsOpt): Promise<{ items: PendingItem[]; unread: Unread[] }> {
  const items: PendingItem[] = [];
  const unread: Unread[] = [];
  for (const c of ["vault", "frontDoor"] as const) {
    try {
      items.push(...(await pendingOn(ctx, rec, c, o)));
    } catch (e) {
      unread.push({ contract: c, why: firstLine(e), history: e instanceof HistoryMissing });
    }
  }
  return { items, unread };
}

const isId = (id: string): id is Hex => /^0x[0-9a-fA-F]{64}$/.test(id);
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Each copy of `id`: the roles are the same on both chains, so one calldata scheduled on both is one id twice. */
const copiesOf = (items: readonly PendingItem[], id: string) => items.filter((i) => sameId(i.id, id));
/** "Couldn't read the vault (Bittensor) right now (why)", for each scheduler that couldn't be read; one without the
 * vault's history is "Couldn't read the vault (Bittensor): why", with no "right now" (Task 46b's re-review, N5). */
const unreadText = (us: readonly Unread[]) => {
  const now = us.filter((u) => !u.history);
  const parts = us.filter((u) => u.history).map((u) => `Couldn't read ${where(u.contract)}: ${u.why}`);
  if (now.length) parts.unshift(`Couldn't read ${now.map((u) => where(u.contract)).join(" or ")} right now (${now.map((u) => u.why).join("; ")})`);
  return parts.join("; and ");
};
/** "; try again" when a read that failed may work next time; none when every one is a log server without the history. */
const tryAgain = (us: readonly Unread[]) => (us.some((u) => !u.history) ? "; try again" : "");

/** One execute, checked as `pnpm ops execute` checks it, with its lines, and not written: the item, its call, and the
 * items read on both chains (for the rail check of an activation's execute: rails.ts railExecuteCommand). */
export interface ExecutePart {
  item: PendingItem;
  call: WalletCall;
  lines: string[];
  /** every item read pending on the chains that could be read */
  items: PendingItem[];
}

/** `pnpm ops execute <id> [--on vault|front-door] --for-wallet`: the owner's execute(data) of a pending item, matched on
 * its contract and its id, refused (executeCall) unless the lens reads it alive and ready; then asked of the contract by
 * eth_call from the owner, exactly as the file will send it, and written. An id pending on both schedulers needs `--on`,
 * naming which copy runs (each runs on its own chain). What it changes is shown field by field (looseningOf). The
 * execute of an activation of a bridge goes through the rail check instead (rails.ts railExecuteCommand, Task 47b's fix
 * round): refused here, so none is written without it. */
export async function executeCommand(ctx: SchedulerCtx, rec: RecordV32, o: FileOpts & { id: string; on?: string }): Promise<{ ok: boolean; lines: string[]; files: string[] }> {
  const p = await executePart(ctx, rec, o);
  if (p.item.fn === "activateBridge") {
    throw new Error(
      `execute(${itemText(p.item)}) on ${where(p.item.contract)} changes the bridges, which each chain keeps its own: it is written only after the rail check of both chains (v32/rails.ts railExecuteCommand); nothing written`,
    );
  }
  return writeExecute(o, p);
}

/** An execute's file, written: `oneSided`, the founder's reason for an activation's execute the rail check would refuse,
 * goes into the file, and its title says "(one-sided)". */
export function writeExecute(o: FileOpts, p: Pick<ExecutePart, "item" | "call" | "lines">, oneSided?: string): { ok: boolean; lines: string[]; files: string[] } {
  const { item, call } = p;
  const tag = oneSided !== undefined ? " (one-sided)" : "";
  const stem = `${o.name}-execute-${item.chain}-${item.id.slice(2, 10)}`;
  const title = fit(`Cascade ${o.name}: execute ${itemText(item)} on ${where(item.contract)}${tag}`, `Cascade ${o.name}: execute item ${item.id} on ${where(item.contract)}${tag}`);
  const path = writeCalls(o, stem, title, [call], oneSided !== undefined ? { oneSided } : {});
  return { ok: true, lines: [...p.lines, wroteLine(path, 1)], files: [path] };
}

/** The checks and lines of `pnpm ops execute` (executeCommand's, before the file is written). */
export async function executePart(ctx: SchedulerCtx, rec: RecordV32, o: BuildsOpt & { id: string; on?: string }): Promise<ExecutePart> {
  if (!isId(o.id)) throw new Error(`${o.id} is not an item id (32 bytes of hex); nothing written`);
  const on = o.on === undefined ? undefined : schedulerOf(o.on);
  await checkChains(ctx);
  const { items, unread } = await itemsByChain(ctx, rec, o);
  const copies = copiesOf(items, o.id).filter((i) => on === undefined || i.contract === on);
  const missed = unread.filter((u) => on === undefined || u.contract === on);
  if (!copies.length) {
    if (missed.length) throw new Error(`${unreadText(missed)}, so item ${o.id} was not found${tryAgain(missed)}; nothing written`);
    throw new Error(`no pending item ${o.id} on ${on ? where(on) : "the vault or the front door"}: nothing to execute; nothing written`);
  }
  if (copies.length > 1) {
    throw new Error(`item ${o.id} is pending on both the vault and the front door (${copies.map((i) => `${where(i.contract)}: ${stateOf(i)}`).join("; ")}): say which copy to execute with --on vault or --on front-door; nothing written`);
  }
  const item = copies[0];
  const call = executeCall(item);
  const build = loadBuildV32(rec.build, o.buildsDir);
  const fits = isWriteOff(item) ? await writeOffStillFits(ctx, rec, item, o.buildsDir) : undefined;
  const gas = call.gas !== undefined ? { gas: numberToHex(BigInt(call.gas)) } : {};
  await mustSucceed(ctx, item.chain, { from: call.from, to: call.to, data: call.data, ...gas }, buildErrorsV32(build), `execute(${itemText(item)}) on ${where(item.contract)} from the owner ${call.from}`);
  const lines = [
    `${chainLabel(item.chain)} ${SCHEDULERS[item.contract].name} ${item.address}: execute(${itemText(item)}) from the owner ${call.from} would succeed now (item ${item.id}, ready since ${iso(item.readyAt)}, until ${untilText(item)}).`,
  ];
  if (fits) {
    lines.push(
      `  The write-off is still at most the missing stake less the unlisted, read now: ${fits.amount} rao of ${fits.most}.`,
      `  It is sent with a gas limit of ${Number(WRITE_OFF_EXECUTE_GAS).toLocaleString("en-US")}, set by the file: the owner's account on Bittensor must hold that gas at the gas price up front (only the gas used is paid).`,
    );
  }
  try {
    lines.push(...looseningLines(looseningOf(item, await currentValues(ctx, rec, item, o))));
  } catch (e) {
    lines.push(`  Whether it loosens a limit could not be read (${firstLine(e)}).`);
  }
  // the 7a carry: the transfer's tail is the new owner's acceptOwnership, inside EXECUTE_WINDOW of this execute (R1-A L-1)
  if (item.fn === "transferOwnership") {
    lines.push(
      // acceptOwnership's window is time only (pendingSince + EXECUTE_WINDOW): windowEnd - readyAt is EXECUTE_WINDOW
      `  The new owner must then accept within ${span(item.windowEnd - item.readyAt)}, while the exits stay open and before any closure or owner stamp: run this only once the new owner is ready to accept.`,
    );
  }
  return { item, call, lines, items };
}

/** One copy's cancel call: cancelCall's refusals, then the contract's own answer by eth_call from the sender. Nothing
 * held under the id (NoProposal, a successful read) is nothing to cancel, which is final; a call the node did not run is
 * not, and says to try again. */
async function cancelOne(ctx: SchedulerCtx, item: PendingItem, build: BuildV32, o: { as: "owner" | "guardian" }): Promise<{ lines: string[]; call: WalletCall }> {
  const call = cancelCall(item, o.as);
  const a = await ask(ctx, item.chain, { from: call.from, to: call.to, data: call.data }, buildErrorsV32(build));
  if (a.kind === "unread") throw checkFailed(`cancel(${item.id}) on ${where(item.contract)}`, a.why);
  if (a.kind === "reverted" && a.name === "NoProposal") {
    throw new Error(`nothing to cancel on ${where(item.contract)}: it holds no item ${item.id} now (it ran, was cancelled or was pruned). This is final: there is nothing to try again`);
  }
  if (a.kind === "reverted") throw new Error(`cancel(${item.id}) on ${where(item.contract)} from the ${o.as} ${call.from} would revert: ${a.error}; nothing written`);
  const lines = [
    `${chainLabel(item.chain)} ${SCHEDULERS[item.contract].name} ${item.address}: cancel(${item.id}) from the ${o.as} ${call.from} would succeed now. It drops this copy of ${itemText(item)}, which then never runs here.`,
  ];
  if (item.unknown) lines.push(`  The lens could not judge the item (${item.unknown}); the contract still holds it, and the cancel removes it.`);
  else if (item.dead) lines.push("  This copy is dead already (it can never run): the cancel only tidies it away.");
  return { lines, call };
}

/** `pnpm ops cancel <id> --as owner|guardian --for-wallet`: the scheduler's cancel(id) of a pending item (the guardian an
 * Ordinary one only), and nothing else (a payout batch is cancel-payouts'). Matched on the contract and the id: an id
 * pending on both schedulers gets both chains' cancels in one file (as pause both does), since a copy left uncancelled
 * still runs, and the sign page then shows both together; the line saying both must be signed is printed only when both
 * were written. Each copy is asked of its contract by eth_call from the sender first. A scheduler that can't be read is
 * said so, to try again: the id may be pending there too. Nothing pending under the id, where both were read, is nothing
 * to cancel, which is final. Returns too what it read (`items`, and whether both chains were read: `complete`) and the
 * copies it wrote cancels for (`cancelled`), for the rails' warning (rails.ts railCancelCommand, Task 47b's fix round). */
export async function cancelCommand(
  ctx: SchedulerCtx,
  rec: RecordV32,
  o: FileOpts & { id: string; as: "owner" | "guardian" },
): Promise<{ ok: boolean; lines: string[]; files: string[]; items: PendingItem[]; cancelled: PendingItem[]; complete: boolean }> {
  if (!isId(o.id)) throw new Error(`${o.id} is not an item id (32 bytes of hex); nothing written`);
  await checkChains(ctx);
  const build = loadBuildV32(rec.build, o.buildsDir);
  const { items, unread } = await itemsByChain(ctx, rec, o);
  const copies = copiesOf(items, o.id);
  if (!copies.length) {
    if (unread.length) throw new Error(`${unreadText(unread)}, so item ${o.id} was not found there${tryAgain(unread)}; nothing written`);
    throw new Error(
      `nothing to cancel: no item is pending under ${o.id} on the vault or the front door. This is final: there is nothing to try again (a payout batch is cancelled with pnpm ops cancel-payouts)`,
    );
  }
  const lines: string[] = [];
  const calls: { item: PendingItem; call: WalletCall }[] = [];
  const refused: string[] = [];
  for (const item of copies) {
    try {
      const one = await cancelOne(ctx, item, build, o);
      lines.push(...one.lines);
      calls.push({ item, call: one.call });
    } catch (e) {
      refused.push(firstLine(e));
    }
  }
  if (!calls.length) throw new Error(refused.join("; and "));
  const both = calls.length > 1;
  if (both) lines.unshift(`Item ${o.id} is pending on both the vault (Bittensor) and the front door (Base): the file holds both cancels. Sign both calls to stop it: a copy left uncancelled still runs on its own chain.`);
  const one = calls[0].item;
  // the role and the chain (or both) in the name, so neither the owner's and the guardian's files nor two runs replace each other
  const stem = `${o.name}-cancel-${o.as}-${both ? "both" : one.chain}-${o.id.slice(2, 10).toLowerCase()}`;
  const title = both
    ? `Cascade ${o.name}: cancel item ${o.id} on both chains: sign both calls to stop it`
    : fit(`Cascade ${o.name}: cancel ${itemText(one)} on ${where(one.contract)}`, `Cascade ${o.name}: cancel item ${one.id} on ${where(one.contract)}`);
  const path = writeCalls(o, stem, title, calls.map((c) => c.call));
  lines.push(wroteLine(path, calls.length));
  for (const r of refused) lines.push(`NOT WRITTEN — ${r}`);
  for (const u of unread) lines.push(`WARNING — ${unreadText([u])}, and item ${o.id} may be pending there too${u.history ? "" : ": try again once it can be read"}.`);
  return { ok: refused.length === 0 && unread.length === 0, lines, files: [path], items, cancelled: calls.map((c) => c.item), complete: unread.length === 0 };
}

// ---- the owner's cancel of a payout batch (ruling A16): its own command ----

/** A payout batch as the vault lens reads it (CascadeTypes.PayoutBatch). */
export interface PayoutBatchRead {
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

/** A batch's payout list from its logs: its DepositBounced entries (0 shares) then its Redeemed ones, in log order (L1's
 * queue, keeper/payouts.ts rebuildPayouts); after a PayoutBatchCancelled that carried bounces, the last `bouncesCarried`
 * of its DepositBounced entries, in their order (spec §3.10.15). */
function payoutListOf(logs: readonly Scanned[], key: Hex): Payout[] {
  const entries: PayoutLog[] = logs
    .filter((l) => (l.eventName === "DepositBounced" || l.eventName === "Redeemed") && String(l.args.key).toLowerCase() === key.toLowerCase())
    .map((l) => ({
      kind: l.eventName === "DepositBounced" ? "bounced" : "redeemed",
      key,
      user: getAddress(l.args.user as Address),
      shares: l.eventName === "Redeemed" ? (l.args.shares as bigint) : 0n,
      assets: l.args.assets as bigint,
      blockNumber: l.block,
      logIndex: l.index,
    }));
  const cancelled = logs.filter((l) => l.eventName === "PayoutBatchCancelled" && String(l.args.key).toLowerCase() === key.toLowerCase()).at(-1);
  const list = rebuildPayouts(entries, key);
  if (!cancelled) return list;
  const carried = Number(cancelled.args.bouncesCarried);
  const bounces = list.filter((p) => p.shares === 0n);
  return carried === 0 ? [] : bounces.slice(-carried);
}

export const tao = (wei: bigint) => formatUnits(wei, 18);

/** `pnpm ops cancel-payouts <key> --for-wallet`: the owner's cancelPayoutBatch(key, payouts) of the vault's payout batch
 * under `key` (ruling A16), its own command: it reads the batch (getPayoutBatch, through the lens) and never the
 * scheduler. The list is rebuilt from the vault's DepositBounced, Redeemed and PayoutBatchCancelled logs for that key since
 * the batch was queued, and held to the batch's count and hash. A batch read whole and empty, or with every entry sent,
 * or with nothing left to re-mint (every entry from the cursor a bounced deposit, owed its TAO and never cancelled:
 * NothingToCancel), is nothing to cancel, which is final. Any read that fails, the batch's, its logs' or the vault's
 * answer, says to try again: never final. Then asked of the vault by eth_call from the owner, and written. */
export async function cancelPayoutsCommand(ctx: SchedulerCtx, rec: RecordV32, o: FileOpts & { key: string }): Promise<{ ok: boolean; lines: string[]; files: string[] }> {
  if (!isId(o.key)) throw new Error(`${o.key} is not a payout batch's key (32 bytes of hex); nothing written`);
  const key = o.key.toLowerCase() as Hex;
  await checkChains(ctx);
  const build = loadBuildV32(rec.build, o.buildsDir);
  const vault = getAddress(rec.plan.addresses.vault);
  const b = (await readNow(`payout batch ${key}`, () => readVault(ctx, rec, "getPayoutBatch", [key], o.buildsDir))) as PayoutBatchRead;
  if (b.queuedAt === 0n && b.count === 0) {
    throw new Error(`nothing to cancel: the vault holds no payout batch under ${key} (sent in full, cancelled, or never queued). This is final: there is nothing to try again (a scheduled item is cancelled with pnpm ops cancel)`);
  }
  const created = rec.done.vault?.block;
  if (created === undefined) throw new Error("the record has no block for the vault's creation, where its logs start; nothing written");
  await readNow("the vault's history", () => proveBittensorHistory(ctx, rec, o));
  const logs = await readNow(`payout batch ${key}'s logs`, async () => {
    const head = await headOf(ctx, "bittensor");
    const queued = await blockAtOrAfter(ctx.rpc, "bittensor", Number(b.queuedAt) - BATCH_MARGIN_S, BigInt(head.block), head.time);
    return scanEvents(ctx, "bittensor", vault, build.vaultAbi, ["DepositBounced", "Redeemed", "PayoutBatchCancelled"], queued > BigInt(created) ? queued : BigInt(created), BigInt(head.block), key);
  });
  const list = payoutListOf(logs, key);
  if (list.length !== b.count || payoutsHash(list).toLowerCase() !== b.payoutsHash.toLowerCase()) {
    throw new Error(`payout batch ${key}'s list, rebuilt from the vault's logs (${list.length} entries), does not match the batch's hash (${b.count} entries): the logs read short; try again; nothing written`);
  }
  const rest = list.slice(b.cursor);
  if (!rest.length) throw new Error(`nothing to cancel: payout batch ${key} has sent every entry. This is final: there is nothing to try again`);
  const redeems = rest.filter((p) => p.shares !== 0n);
  const bounces = rest.length - redeems.length;
  if (!redeems.length) {
    throw new Error(
      `nothing to cancel: what is left of payout batch ${key} is ${bounces} bounced deposit${bounces === 1 ? "" : "s"}, each owed its TAO, which a cancel never undoes (NothingToCancel); the next payout sends ${bounces === 1 ? "it" : "them"}. This is final: there is nothing to try again`,
    );
  }
  const owner = getAddress((await readNow("the vault's owner", () => readVault(ctx, rec, "owner", [], o.buildsDir))) as Address);
  const data = encodeFunctionData({ abi: build.vaultAbi, functionName: "cancelPayoutBatch", args: [key, list] } as never);
  const a = await ask(ctx, "bittensor", { from: owner, to: vault, data }, buildErrorsV32(build));
  if (a.kind === "unread") throw checkFailed(`cancelPayoutBatch(${key})`, a.why);
  if (a.kind === "reverted" && a.name === "NothingToCancel") throw new Error(`nothing to cancel: the vault answers NothingToCancel for payout batch ${key}. This is final: there is nothing to try again`);
  if (a.kind === "reverted") throw new Error(`cancelPayoutBatch(${key}) from the owner ${owner} would revert: ${a.error}; nothing written`);
  const launchChain = BigInt((await readNow("the vault's launch chain", () => readVault(ctx, rec, "launchChain", [], o.buildsDir))) as bigint);
  const value = redeems.reduce((s, p) => s + p.assets, 0n);
  const lines = [
    `Bittensor vault ${vault}: cancelPayoutBatch(${key}, its ${list.length} entries) from the owner ${owner} would succeed now.`,
    `  It re-mints ${redeems.length} redeem${redeems.length === 1 ? "" : "s"} (${tao(value)} TAO) and carries ${bounces} bounced deposit${bounces === 1 ? "" : "s"}, which stay queued to be paid.`,
    "  A cancel returns each cancelled leaver to the vault at today's price: after a loss it costs those leavers, after a claim it costs the stayers. Cancel only a rogue door's batch; let honest ones be paid.",
  ];
  if (b.sourceChain === launchChain) lines.push("  It is the launch door's batch, so it stamps the owner's clock: every item scheduled until then dies.");
  const call: WalletCall = { chainId: chainIdFor(rec, "bittensor"), to: vault, data, value: "0", label: `cancelPayoutBatch(${key}, ${list.length} entries) on ${where("vault")}`, from: owner };
  const path = writeOne(o, `${o.name}-cancel-payouts-${key.slice(2, 10)}`, `Cascade ${o.name}: cancel payout batch ${key} on ${where("vault")}`, call);
  lines.push(wroteLine(path, 1));
  return { ok: true, lines, files: [path] };
}

// ---- loosening ----

/** One limit a setter writes: its name (the getter that reads it now), the argument that sets it, and which way loosens
 * it (spec §3.6, each setter's _requireScheduledIfLoosens): up, down, any change ("change"), or none (the setter takes
 * every value only through execute, or is not a limit). */
interface FieldRule {
  name: (args: Record<string, unknown>) => string;
  param: string;
  dir: "up" | "down" | "change" | "none";
  /** the getter and its arguments that read the current value */
  getter: string;
  getterArgs?: (args: Record<string, unknown>) => unknown[];
}

const field = (name: string, param: string, dir: FieldRule["dir"], getter = name): FieldRule => ({ name: () => name, param, dir, getter });

/** Each setter an item may call, with the limits it writes: the direction setters as their contracts judge them (and as
 * the monitor's admin.item_loosens does, Task 55: DIRECTIONS, held to its tables by test), the rest shown without a
 * direction. setStakeHotkey is not a limit (the controller's ruling): no direction; its contract's scheduling rule, which
 * reads stake, is said apart (stakeHotkeyScheduling). */
const FIELDS: Record<SchedulerContract, Record<string, FieldRule[]>> = {
  vault: {
    setOutflowLimits: [field("maxDailyOutflowBps", "bps", "up"), field("minDailyOutflow", "minDaily", "up"), field("globalOutflowBps", "globalBps", "up")],
    setMessageLimits: [field("maxEntryValue", "maxEntryValue_", "up"), field("maxMessageValue", "maxMessageValue_", "up"), field("minChunk", "minChunk_", "down")],
    setFeeLimits: [field("maxFeeBps", "bps", "up"), field("maxFeeAbs", "abs_", "up")],
    setPayoutDelay: [field("payoutDelay", "delay", "down")],
    setRewardCut: [field("treasury", "treasury_", "change"), field("rewardCutBps", "bps", "up")],
    setRewardVesting: [field("rewardVesting", "period", "down")],
    setMaxTotalAssets: [field("maxTotalAssets", "amount", "up")],
    setIdleBuffer: [field("idleBufferBps", "bps", "down")],
    setStakeHotkey: [field("stakeHotkey", "h", "none")],
    moveStake: [],
    writeOffMissingStake: [field("missingStakeRao", "rao", "none")],
    activateFrontDoor: [],
    activateBridge: [],
    setGuardian: [field("guardian", "newGuardian", "none")],
    transferOwnership: [field("owner", "newOwner", "none")],
  },
  frontDoor: {
    setMaxDeliverySlippage: [field("maxDeliverySlippageBps", "bps", "up")],
    setBatchInterval: [field("batchInterval", "interval", "down")],
    setMaxBatchValue: [field("maxBatchValue", "value", "up")],
    setMinPoolLiquidity: [{ name: (a) => `minPoolLiquidity(${a.index})`, param: "value", dir: "down", getter: "minPoolLiquidity", getterArgs: (a) => [BigInt(a.index as bigint)] }],
    setOracle: [field("oracle", "newOracle", "none")],
    setSwapper: [field("swapper", "newSwapper", "none")],
    setGuardian: [field("guardian", "newGuardian", "none")],
    transferOwnership: [field("owner", "newOwner", "none")],
    activateBridge: [],
  },
};

/** Each field's name as a list shows it: a pool's floor as "minPoolLiquidity(index)". */
const NAMES_AS_PARAMS = new Proxy({}, { get: (_, k) => String(k) }) as Record<string, unknown>;

/** The direction setters and their fields (the limit, the argument that sets it, which way loosens it), by contract: the
 * list the monitor's directionOf has too (test/v32-scheduler.test.ts holds it to the monitor's tables). */
export const DIRECTIONS: Record<SchedulerContract, Record<string, { name: string; param: string; dir: string }[]>> = {
  vault: directionsOf(FIELDS.vault),
  frontDoor: directionsOf(FIELDS.frontDoor),
};
function directionsOf(fields: Record<string, FieldRule[]>): Record<string, { name: string; param: string; dir: string }[]> {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, f]) => f.some((r) => r.dir !== "none"))
      .map(([fn, f]) => [fn, f.map((r) => ({ name: r.name(NAMES_AS_PARAMS), param: r.param, dir: r.dir }))]),
  );
}

/** The setters whose contract calls _requireScheduledIfLoosens, waiting only when they loosen: the direction setters,
 * and setStakeHotkey, whose rule is where stake sits, not a limit (the test holds these to the contracts' source). */
export const SCHEDULED_IF_LOOSENS: Record<SchedulerContract, readonly string[]> = {
  vault: [...Object.keys(DIRECTIONS.vault), "setStakeHotkey"],
  frontDoor: Object.keys(DIRECTIONS.frontDoor),
};

/** What an item would change, field by field, against the current values. */
export interface Loosening {
  /** whether any field loosens a limit: a direct call of the same setter would need the schedule now */
  loosens: boolean;
  fields: { name: string; now: unknown; then: unknown; loosens: boolean }[];
  /** for a change with no direction, or not a limit: what it means */
  note?: string;
  /** setStakeHotkey's own scheduling rule, read now: whether a direct switch would need the schedule (it is not a limit) */
  scheduling?: string;
  /** set when the item can't run at all, whatever the values */
  reverts?: string;
}

const NO_DIRECTION = "No direction: this change waits its delay whatever its value.";
const NOT_A_LIMIT = "Not a limit: where new stake goes, so it never loosens one.";

const int = (v: unknown): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^(\d+|0x[0-9a-fA-F]+)$/.test(v)) return BigInt(v);
  throw new Error(`${String(v)} is not a whole number`);
};
const sameValue = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

/** Whether the item `item` would loosen a limit if it ran now (spec §3.6: a multi-field setter loosens when any field
 * does; the direction is judged at execute, so an item at the current value becomes a loosening after a direct
 * tightening, the T11 carry), against `current`, keyed by each field's name ("maxTotalAssets", "minPoolLiquidity(1)").
 * A value it needs and `current` lacks throws: it is never taken as "doesn't loosen". setMinPoolLiquidity of an index past
 * 1 names no pool and reverts at execute (`reverts`). setStakeHotkey is not a limit and never loosens; with
 * "newHotkeyStakeRao", "stakeHotkeyStakeRao" and "bookedStake" (rao) in `current`, its contract's scheduling rule is
 * said in `scheduling`. */
export function looseningOf(item: Pick<PendingItem, "contract" | "fn" | "args">, current: Record<string, unknown>): Loosening {
  const fn = item.fn ?? "";
  const rules = FIELDS[item.contract][fn];
  if (!rules) throw new Error(`${fn || "this calldata"} is not a change ${where(item.contract)}'s scheduler takes`);
  if (item.contract === "frontDoor" && fn === "setMinPoolLiquidity" && int(item.args.index) > 1n) {
    return { loosens: false, fields: [], reverts: `index ${item.args.index} names no pool: it reverts InvalidParameter at execute` };
  }
  const fields = rules.map((r) => {
    const name = r.name(item.args);
    if (!(name in current)) throw new Error(`${name} is not read`);
    if (!(r.param in item.args)) throw new Error(`the item has no ${r.param}`);
    const now = current[name];
    const then = item.args[r.param];
    const loosens = r.dir === "up" ? int(then) > int(now) : r.dir === "down" ? int(then) < int(now) : r.dir === "change" ? !sameValue(now, then) : false;
    return { name, now, then, loosens };
  });
  if (fn === "setStakeHotkey") {
    const scheduling = stakeHotkeyScheduling(current);
    return { loosens: false, fields, note: NOT_A_LIMIT, ...(scheduling ? { scheduling } : {}) };
  }
  const directed = rules.some((r) => r.dir !== "none");
  return { loosens: fields.some((f) => f.loosens), fields, ...(directed ? {} : { note: NO_DIRECTION }) };
}

/** setStakeHotkey's scheduling rule (CascadeVault.setStakeHotkey), not a loosening: a direct switch needs the schedule
 * unless it follows stake that already moved (the new hotkey holds more than the stake hotkey and at least half the
 * booked stake). Undefined when the stake was not read. */
function stakeHotkeyScheduling(current: Record<string, unknown>): string | undefined {
  if (!["newHotkeyStakeRao", "stakeHotkeyStakeRao", "bookedStake"].every((k) => k in current)) return undefined;
  const s = int(current.newHotkeyStakeRao);
  const cur = int(current.stakeHotkeyStakeRao);
  const booked = int(current.bookedStake);
  const held = `the new hotkey holds ${s} rao, the current one ${cur} rao, of ${booked} rao booked`;
  return s <= cur || s < booked / 2n
    ? `A direct switch would need this schedule now: ${held} (it is immediate only once the new hotkey holds more than the current one and at least half the booked stake).`
    : `A direct switch could be made at once now: ${held}.`;
}

const STAKING_VIEW = parseAbi(["function getStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid) view returns (uint256)"]);

/** The current values looseningOf needs for `item`, each read through its contract or lens now (setStakeHotkey's stake
 * from the staking precompile, as the vault reads it). A read that fails throws. */
export async function currentValues(ctx: Pick<Ctx, "rpc">, rec: RecordV32, item: Pick<PendingItem, "contract" | "fn" | "args">, o: BuildsOpt = {}): Promise<Record<string, unknown>> {
  const rules = FIELDS[item.contract][item.fn ?? ""];
  if (!rules) throw new Error(`${item.fn ?? "this calldata"} is not a change ${where(item.contract)}'s scheduler takes`);
  if (item.contract === "frontDoor" && item.fn === "setMinPoolLiquidity" && int(item.args.index) > 1n) return {};
  const out: Record<string, unknown> = {};
  for (const r of rules) out[r.name(item.args)] = await readOf(ctx, rec, item.contract, r.getter, r.getterArgs?.(item.args) ?? [], o);
  if (item.fn === "setStakeHotkey") {
    const coldkey = (await readVault(ctx, rec, "coldkey", [], o.buildsDir)) as Hex;
    const stake = async (h: unknown) => (await read(ctx.rpc, "bittensor", { address: PRECOMPILE.staking, abi: STAKING_VIEW, functionName: "getStake", args: [h, coldkey, 0n] })) as bigint;
    out.newHotkeyStakeRao = await stake(item.args.h);
    out.stakeHotkeyStakeRao = await stake(out.stakeHotkey);
    out.bookedStake = await readVault(ctx, rec, "bookedStake", [], o.buildsDir);
  }
  return out;
}

/** A field's value as a line shows it: TAO for an amount in wei, rao or the like are left as numbers. */
export function valueText(name: string, v: unknown): string {
  const wei = ["maxTotalAssets", "minDailyOutflow", "maxEntryValue", "maxMessageValue", "maxFeeAbs", "maxBatchValue"];
  if (wei.includes(name) && (typeof v === "bigint" || typeof v === "number")) return `${tao(BigInt(v))} TAO`;
  return shown(v);
}

/** The lines a loosening reads as: one per field, now and then, marked where it loosens. */
export function looseningLines(l: Loosening): string[] {
  if (l.reverts) return [`  It can never run: ${l.reverts}.`];
  const lines = l.fields.map((f) => `  ${f.name}: ${valueText(f.name, f.now)} now, ${valueText(f.name, f.then)} then${f.loosens ? " (loosens)" : ""}`);
  if (l.note) lines.push(`  ${l.note}`);
  if (l.scheduling) lines.push(`  ${l.scheduling}`);
  if (!l.note) lines.push(l.loosens ? "  It loosens a limit: that is why it waits." : "  It loosens nothing now: the same change could be made directly, at once.");
  return lines;
}
