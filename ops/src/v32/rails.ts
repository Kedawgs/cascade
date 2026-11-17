import { type AbiFunction, type Address, encodeFunctionData, formatEther, getAddress, type Hex, numberToHex, parseAbi } from "viem";
import type { ChainName } from "../config.ts";
import { RAIL_VIEWS } from "../keeper/core/abi.ts";
import { RAIL_VIEW_CALL_GAS, RAIL_VIEW_GAS } from "../keeper/core/v32/reads.ts";
import { isEvmHalt, isRevert, read } from "../rpc.ts";
import { chainLabel, type Ctx } from "../send.ts";
import { type WalletCall, wroteLine } from "../wallet.ts";
import { type BuildV32, buildErrorsV32, loadBuildV32 } from "./build.ts";
import { isRailFn, RAIL_FNS, type RailFn } from "./classes.ts";
import { readDoor, readVault } from "./lens.ts";
import { pairFieldProblems } from "./pairs.ts";
import {
  abiOf,
  argsFrom,
  ask,
  type BuildsOpt,
  cancelCommand,
  checkChains,
  checkFailed,
  chainIdFor,
  executePart,
  type FileOpts,
  firstLine,
  fit,
  headOf,
  type ItemKind,
  lapsed,
  type PendingItem,
  pendingOn,
  readNow,
  type RecordV32,
  type SchedulerContract,
  type SchedulerCtx,
  schedulePart,
  schedulerOf,
  where,
  writeCalls,
  writeExecute,
} from "./scheduler.ts";

// The rail between the chains (spec §5, "The rail between the chains"; Task 39b's finding; plan Task 47b). Each chain
// keeps its own bridges and its own primary: the vault on Bittensor, the front door on Base. A launch batch goes out
// through the front door's primary and is taken by the vault only from a bridge enabled there now (CascadeBase's
// _requireBridge, NotBridge); a payout goes out through the vault's primary to its Base half, which the front door takes
// from any bridge it has ever enabled (CascadeFrontDoor's _requireBridge reads bridgeKnown, spec §3.2 H-2 i). So an
// owner's switch of one side's primary alone, or a disable on the vault of a bridge the front door's primary uses,
// leaves both chains OPEN while every batch one way is refused at the other end. The controller's rulings, each kept
// here (the second pair's reading is the coordinator's correction, which the monitor's rails.incoherent, Task 57c, uses
// too):
// - railCoherence(state) computes the rails as they will be once every pending and planned item has executed, and names
//   each pair that will carry traffic but be refused at one end: the front door's primary's Bittensor peer not enabled
//   now on the vault, or the vault's primary's Base peer never enabled on the front door (not known to it). A primary
//   that is disabled carries nothing (its chain's exits are closed, the exits report's business), and names no pair;
//   but while the vault's primary is disabled, a front door's pair the vault takes is named too (R6, ChatGPT R2 claim
//   D): those batches have no payout rail, and the vault defers every door redeem in them. So a two-sided switch made
//   one side at a time passes each step only the vault's side first: both disables (the front door's first), then the
//   vault's switch, then the front door's. And each pair's halves must
//   name each other, as the monitor's rule reads them: the sender sends only to its remoteChainId, and its half takes
//   messages only from its own remoteAdapter, on its own remoteChainId (CcipAdapterBase: WrongDestination, WrongSource);
// - readRails reads that state at one pinned head a chain (the logs server's, as the pending scan does), through the
//   lenses and the adapters' own peers (remoteAdapter, remoteChainId), fail-closed: a read that fails throws, and is
//   never "coherent";
// - pnpm ops schedule refuses a file that would leave the rails incoherent (a setPrimaryBridge on one side only, an
//   activation on one side only, a disableBridge of a bridge the other side's primary uses, anything else that ends
//   incoherent), naming the pair and saying to put both sides in one file (schedule both). The only way past is
//   --one-sided "<reason>", which prints the residual and writes the reason into the file;
// - the sign page shows the result for a file of rail calls and warns on an incoherent end, never refusing there;
// - verify reports the rails now, and the pending items that would change them.
// Task 47b's fix round (the controller's rulings on the review):
// - a disable or a switch takes effect when it is sent, a pending activation days later or never: so every file is
//   also judged right after its direct calls, with no pending item and none of its scheduled activations counted, after
//   each chain's part in the order the file is sent (every order, when it fixes none), and refused when any such state
//   disagrees, naming the pair and the pending item to execute first (railVerdict); --one-sided is still the only way
//   past. pnpm ops schedule both writes its direct calls in order: the disables the front door's first, the switches of
//   the primary the vault's first (R6, claim D);
// - a file's calls apply in its own order: an activation it schedules before it disables that side's primary dies;
// - verify always judges the rails now (a failure when they disagree); only what the pending items make of them may be
//   "not judged";
// - pnpm ops execute of an activation is judged right after it runs (railExecuteCommand), refused only when it makes
//   the rails worse (a pair that agrees right before disagrees right after), with --one-sided to pass; a disagreement
//   it leaves, or repairs in part, warns;
//   pnpm ops cancel is never refused, and warns when the activation it drops is one a pending pair depends on
//   (railCancelCommand).

/** The front door's and the vault's sides, as the rail check reads them. */
const CONTRACTS = ["frontDoor", "vault"] as const;
const CHAIN: Record<SchedulerContract, ChainName> = { vault: "bittensor", frontDoor: "base" };
const OTHER: Record<SchedulerContract, SchedulerContract> = { vault: "frontDoor", frontDoor: "vault" };
const NAME: Record<SchedulerContract, string> = { vault: "vault", frontDoor: "front door" };
const SIDE: Record<SchedulerContract, string> = { vault: "Bittensor", frontDoor: "Base" };
/** Each bridge's own peer: the CCIP adapters' immutables (CcipAdapterBase). */
const PEER_ABI = parseAbi(["function remoteAdapter() view returns (address)", "function remoteChainId() view returns (uint64)"]);
/** What a Bittensor adapter's parks owe (R4, D-L1: a vault-side disable warns while it holds any). */
const PARKS_ABI = parseAbi(["function parkedNative() view returns (uint256)", "function parkedTokens() view returns (uint256)"]);
const low = (a: string) => a.toLowerCase();
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

/** Section 5's residual, quoted (spec §5, "The rail between the chains (a residual; Task 39b, I-28)"), in the spec's own
 * words, its payout half included (test/v32-rail-residual.test.ts holds them to the spec): what a one-sided switch is,
 * what it does to the batches, and what a vault-side one does to the payouts, which holds only for a new primary the
 * front door has never activated (Task 39b's re-review, Minor 2: the spec's qualification, quoted at merge 7b). */
export const RAIL_RESIDUAL = [
  "The rail between the chains is coherent only by operation. Each chain keeps its own bridges and primary.",
  "Nothing is lost (the Bittensor adapter parks a refused batch, I-10 refunds it), but Base exits stop until the rails are made coherent again.",
  "After a vault-side switch alone, the front door also refuses every payout sent through the vault's new primary, and the Base adapter does not park: each such payout's delivery reverts (CCIP FAILURE) and waits for a retry until the front door activates that bridge. This holds only for a new primary the front door has never activated: a payout through a bridge it knows, even one it has disabled, is credited.",
] as const;

/** One change to a chain's bridges: an activation pending in its scheduler, or a call of a file. A file's call is
 * "planned" (a disable or a switch of the primary, which takes effect when it is sent; an activation's schedule, which
 * runs only after its delay) or "executed" (an activation's execute, which takes effect when it is sent: Task 47b's fix
 * round, ruling d). */
export interface RailChange {
  contract: SchedulerContract;
  fn: RailFn;
  bridge: Address;
  source: "pending" | "planned" | "executed";
  /** a pending or executed item's id; an activation's kind, when known (a guardian's stamp kills only an Ordinary item;
   * a planned activation of no kind is taken as Ordinary, as an activation of a bridge never enabled is) */
  id?: Hex;
  kind?: ItemKind;
  /** a planned disable's sender: an owner's stamp kills every item pending on that contract, a guardian's the Ordinary */
  by?: "owner" | "guardian";
}

/** Each chain's pinned head: the logs server's, where the pending scan ends and every rail read is made. */
export type RailHeads = Record<SchedulerContract, { block: number; time: number }>;

/** What railCoherence works on, each value read at its chain's pinned head. */
export interface RailState {
  heads: RailHeads;
  /** each side's primary now */
  primary: Record<SchedulerContract, Address>;
  /** the chain each side's bridges must send to: the vault's launchChain(), the front door's vaultChain() */
  sendsTo: Record<SchedulerContract, bigint>;
  /** each side's bridges whose peer matters (its primary now and at the end, each planned activation), and each of their
   * peers on the other side's chain, by lower-case address: the peer (remoteAdapter) and the chain it is on
   * (remoteChainId), read on that bridge's own chain */
  peers: Record<SchedulerContract, Record<string, { peer: Address; chain: bigint }>>;
  /** whether each bridge of interest is enabled on each side now, by lower-case address */
  enabled: Record<SchedulerContract, Record<string, boolean>>;
  /** whether each Base peer of the vault's bridges of interest is known to the front door (bridgeKnown: ever enabled),
   * by lower-case address: what the front door takes a payout from */
  doorKnown: Record<string, boolean>;
  /** the activations pending in either scheduler that can still run */
  pending: RailChange[];
  /** the calls of the file being written or signed, in its order */
  planned: RailChange[];
  /** R4 (C-L4): each bridge of interest's lane settings that differ from the deploy's adapter's on its chain (its router,
   * token and remote selector, and on Bittensor its AlphaVault: pairs.ts pairFieldProblems), by lower-case address; none
   * for the deploy's own. readRails reads them all; a state made by hand without them judges peers alone */
  config?: Record<SchedulerContract, Record<string, string[]>>;
}

/** A pair that will carry traffic but be refused at one end: `from`'s primary sends to `peer` on `chain`, which is not
 * the other side's chain, or which takes messages only from another sender (`back`, its own peer), or which the other
 * side does not take (the vault: not enabled now; the front door: never enabled). */
export interface RailPair {
  from: SchedulerContract;
  primary: Address;
  peer: Address;
  chain: bigint;
  back?: { peer: Address; chain: bigint };
  /** R4 (C-L4): each lane setting of the primary or its half that differs from the deploy's pair's (fixed at deploy) */
  config?: string[];
  /** R6 (ChatGPT R2 claim D): the vault's primary, disabled, while this pair (the front door's) carries batches to another
   * bridge the vault takes: the vault has no payout rail, so it defers every door redeem they carry */
  noPayoutRail?: Address;
}

/** A planned activation of a bridge whose other half the other side will not take, or which names another sender
 * (`back`), as for a pair. */
export interface RailHalf {
  contract: SchedulerContract;
  bridge: Address;
  peer: Address;
  back?: { peer: Address; chain: bigint };
  /** R4 (C-L4): as RailPair's */
  config?: string[];
}

/** The rails once every pending and planned item has executed. */
export interface Rails {
  coherent: boolean;
  /** each side's primary at the end: enabled or not, and its peer */
  primary: Record<SchedulerContract, { bridge: Address; enabled: boolean; peer: Address }>;
  incoherent: RailPair[];
  halves: RailHalf[];
  /** the pending activations a planned disable of a primary kills (its stamp): they never run */
  killed: RailChange[];
  sendsTo: Record<SchedulerContract, bigint>;
}

/** The rails as they will be once every pending and planned item has executed (the ruling's railCoherence): the file's
 * calls in the file's own order (Task 47b's fix round, Minor 1), those that take effect at once as they come (a disable;
 * the switch of the primary; an activation's execute), then every activation still to run, each after its delay (an
 * activation only enables, and makes the bridge known; a disable never unmakes that). A disable of a side's primary
 * stamps its sender's clock, so the items pending on that side die and never run, and so do the activations the file
 * schedules there before it (the stamp is dated after them): the owner's kills every one, the guardian's the Ordinary
 * ones. Then each enabled primary must send to the other side's chain, to a peer the other side takes: the vault one
 * enabled there now, the front door one it has ever enabled; and each activation the file schedules must have its other
 * half taken the same way. A flag the state lacks throws (fail-closed): readRails reads every one this needs. A file
 * whose order is not fixed is judged in every order by railVerdict. */
export function railCoherence(s: RailState): Rails {
  const enabled: Record<SchedulerContract, Record<string, boolean>> = { vault: { ...s.enabled.vault }, frontDoor: { ...s.enabled.frontDoor } };
  const known: Record<string, boolean> = { ...s.doorKnown };
  const primary = { ...s.primary };
  const stamped: Partial<Record<SchedulerContract, "owner" | "guardian">> = {};
  const kills = (by: "owner" | "guardian" | undefined, kind: ItemKind | undefined) => by === "owner" || (by === "guardian" && kind === "Ordinary");
  const enable = (ch: RailChange) => {
    enabled[ch.contract][low(ch.bridge)] = true;
    if (ch.contract === "frontDoor") known[low(ch.bridge)] = true;
  };
  // the file's activations scheduled so far, each to run after its delay unless a stamp the file makes later kills it
  let later: RailChange[] = [];
  for (const ch of s.planned) {
    const c = ch.contract;
    if (ch.fn === "disableBridge") {
      if (same(ch.bridge, primary[c]) && enabled[c][low(ch.bridge)]) {
        const by = ch.by === "guardian" ? "guardian" : "owner";
        stamped[c] = stamped[c] === "owner" || by === "owner" ? "owner" : "guardian";
        later = later.filter((p) => p.contract !== c || !kills(by, p.kind ?? "Ordinary"));
      }
      enabled[c][low(ch.bridge)] = false;
    } else if (ch.fn === "setPrimaryBridge") primary[c] = getAddress(ch.bridge);
    else if (ch.source === "executed") enable(ch);
    else later.push(ch);
  }
  const dies = (p: RailChange) => kills(stamped[p.contract], p.kind);
  const killed = s.pending.filter(dies);
  for (const ch of [...s.pending.filter((p) => !dies(p)), ...later]) enable(ch);
  const flag = (c: SchedulerContract, a: string): boolean => {
    const v = enabled[c][low(a)];
    if (v === undefined) throw new Error(`whether ${getAddress(a)} is enabled on ${where(c)} was not read`);
    return v;
  };
  /** Whether `to` takes a message from its bridge `a`: the vault from one enabled now, the front door from one it ever
   * enabled (each contract's _requireBridge). */
  const takes = (to: SchedulerContract, a: string): boolean => {
    if (to === "vault") return flag("vault", a);
    const v = known[low(a)];
    if (v === undefined) throw new Error(`whether ${getAddress(a)} is known to ${where("frontDoor")} was not read`);
    return v;
  };
  const peerOf = (c: SchedulerContract, a: string) => {
    const p = s.peers[c][low(a)];
    if (!p) throw new Error(`the peer of ${getAddress(a)} on ${where(c)} was not read`);
    return p;
  };
  /** What `a`'s half on `to`'s chain takes messages from, when not `a` on the chain `to`'s bridges send to: its own
   * peer, read (never taken as naming `a`). */
  const namesOther = (to: SchedulerContract, half: string, a: Address): { peer: Address; chain: bigint } | undefined => {
    const h = peerOf(to, half);
    return same(h.peer, a) && h.chain === s.sendsTo[to] ? undefined : h;
  };
  /** R4 (C-L4): the lane settings of bridge `a` on `c` and of its half `half` on the other side that differ from the deploy's
   * pair's, each named by its bridge (none read: none known) */
  const configOf = (c: SchedulerContract, a: string, half: string): string[] => [
    ...(s.config?.[c]?.[low(a)] ?? []).map((x) => `${getAddress(a)} on ${SIDE[c]}: ${x}`),
    ...(s.config?.[OTHER[c]]?.[low(half)] ?? []).map((x) => `${getAddress(half)} on ${SIDE[OTHER[c]]}: ${x}`),
  ];
  const incoherent: RailPair[] = [];
  const ends = {} as Rails["primary"];
  for (const from of CONTRACTS) {
    const b = primary[from];
    const on = flag(from, b);
    const p = peerOf(from, b);
    ends[from] = { bridge: getAddress(b), enabled: on, peer: p.peer };
    // a disabled primary carries nothing: its chain's exits are closed (the exits report's business)
    if (!on) continue;
    if (p.chain !== s.sendsTo[from]) {
      incoherent.push({ from, primary: getAddress(b), peer: p.peer, chain: p.chain });
      continue;
    }
    const back = namesOther(OTHER[from], p.peer, getAddress(b));
    const config = configOf(from, b, p.peer);
    if (back || config.length || !takes(OTHER[from], p.peer)) incoherent.push({ from, primary: getAddress(b), peer: p.peer, chain: p.chain, ...(back ? { back } : {}), ...(config.length ? { config } : {}) });
    // R6 (ChatGPT R2 claim D): batches the vault takes while its own primary is disabled have no payout rail: the vault
    // defers every door redeem in them (_payoutsOpen reads a disabled primary as closed). So a switch is made the vault's
    // side first
    else if (from === "frontDoor" && !flag("vault", primary.vault)) incoherent.push({ from, primary: getAddress(b), peer: p.peer, chain: p.chain, noPayoutRail: getAddress(primary.vault) });
  }
  const halves: RailHalf[] = [];
  // the file's scheduled activations that still run (an executed one is judged by the pairs alone: it is no plan)
  for (const ch of later) {
    const p = peerOf(ch.contract, ch.bridge);
    // a bridge to another chain is not on this rail
    if (p.chain !== s.sendsTo[ch.contract]) continue;
    const back = namesOther(OTHER[ch.contract], p.peer, getAddress(ch.bridge));
    const config = configOf(ch.contract, ch.bridge, p.peer);
    if (back || config.length || !takes(OTHER[ch.contract], p.peer)) halves.push({ contract: ch.contract, bridge: getAddress(ch.bridge), peer: p.peer, ...(back ? { back } : {}), ...(config.length ? { config } : {}) });
  }
  return { coherent: !incoherent.length && !halves.length, primary: ends, incoherent, halves, killed, sendsTo: s.sendsTo };
}

/** Whether a file's change takes effect when it is sent: a disable, a switch of the primary, an activation's execute (an
 * activation's schedule runs only after its delay). */
export const atOnce = (ch: RailChange): boolean => ch.source === "executed" || (ch.source === "planned" && ch.fn !== "activateBridge");

/** A state right after some of a file's calls that take effect at once are sent, with no pending item and none of the
 * file's scheduled activations counted (none has run yet), where the two chains disagree on the bridge. */
export interface RailStep {
  /** the calls sent so far, in the order judged */
  sent: RailChange[];
  rails: Rails;
  /** the pending activations that would make the refused pairs taken, if executed before this file */
  fixes: RailChange[];
  /** whether `sent` follows the file's own order (else the file fixes no order, and another order is the worst) */
  own: boolean;
}

/** What the rail check makes of a file (Task 47b's fix round, Critical 1). */
export interface RailVerdict {
  /** the rails once the file and every pending item have run (railCoherence), in the worst order the file allows */
  end: Rails;
  /** the first state, right after one of the file's calls that take effect at once, where the two chains disagree, in
   * the worst order the file allows (the file's own first); none when every such state agrees */
  step?: RailStep;
  /** the rails right after all those calls, in the file's own order, with no pending item counted */
  after: Rails;
}

/** At most this many calls on the bridges, in a file that fixes no order, are judged in every order (6! = 720). */
const MAX_ORDERS = 6;

/** Every order of `xs`, the given one first. */
function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

/** The rail check of a file: the end state, as railCoherence judges it, and each state right after the file's calls
 * that take effect at once, with no pending item and none of the file's scheduled activations counted (a disable or a
 * switch acts when it is sent, while a pending activation acts days later, or never). A file that is `ordered` is
 * judged in its own order; one that fixes no order is judged in every order (the sign page can't know the order a
 * hand-edited file is sent in), and the worst counts: its first state that disagrees, and an end that disagrees. A
 * state that disagrees names the pending activations that would fix it if executed first. */
export function railVerdict(s: RailState, ordered: boolean): RailVerdict {
  if (!ordered && s.planned.length > MAX_ORDERS) throw new Error(`the file has ${s.planned.length} calls on the bridges in no fixed order, too many to judge in every order`);
  const orders = ordered ? [[...s.planned]] : permutations(s.planned);
  // a pending item the file itself executes is no fix to execute first
  const executed = (p: RailChange) => s.planned.some((x) => x.source === "executed" && x.contract === p.contract && x.id !== undefined && same(x.id, p.id));
  const pending = s.pending.filter((p) => !executed(p));
  let end: Rails | undefined;
  let step: RailStep | undefined;
  for (const [n, order] of orders.entries()) {
    const e = railCoherence({ ...s, planned: order });
    if (!end || (end.coherent && !e.coherent)) end = e;
    const now = order.filter(atOnce);
    for (let k = 1; k <= now.length && !step; k++) {
      const r = railCoherence({ ...s, pending: [], planned: now.slice(0, k) });
      if (!r.coherent) step = { sent: now.slice(0, k), rails: r, fixes: fixesOf(r, pending), own: n === 0 };
    }
  }
  const after = railCoherence({ ...s, pending: [], planned: s.planned.filter(atOnce) });
  return { end: end ?? railCoherence(s), after, ...(step ? { step } : {}) };
}

/** The pending activations that would make the refused pairs of `r` taken: each pair's half, pending on the side that
 * refuses it (a pair whose half names another sender, or that sends to another chain, no activation fixes). */
function fixesOf(r: Rails, pending: readonly RailChange[]): RailChange[] {
  const out: RailChange[] = [];
  for (const p of r.incoherent) {
    // a vault without a payout rail is fixed by the vault's switch, not by an activation
    if (p.back || p.config || p.noPayoutRail || p.chain !== r.sendsTo[p.from]) continue;
    for (const x of pending) if (x.contract === OTHER[p.from] && same(x.bridge, p.peer) && !out.includes(x)) out.push(x);
  }
  return out;
}

/** Each chain's head, from the logs server (headOf), where the rail check pins its reads. */
export async function railHeads(ctx: Pick<Ctx, "rpc" | "logs">): Promise<RailHeads> {
  return { vault: await headOf(ctx, "bittensor"), frontDoor: await headOf(ctx, "base") };
}

/** The pending items that change the rails: each activation that can still run (not dead, its calldata canonical, not
 * lapsed: past both its window in time and its window in blocks, Revision 28). Throws for an activation the lens could not judge: it may run, so the rails can't be known. */
export function pendingRailChanges(items: readonly PendingItem[]): RailChange[] {
  const out: RailChange[] = [];
  for (const i of items) {
    if (i.fn !== "activateBridge") continue;
    if (i.unknown) throw new Error(`item ${i.id} on ${where(i.contract)}, an activation of a bridge, could not be judged (${i.unknown})`);
    if (i.dead || !i.canonical || lapsed(i)) continue;
    out.push({ contract: i.contract, fn: "activateBridge", bridge: getAddress(i.args.bridge as Address), source: "pending", id: i.id, kind: i.kind });
  }
  return out;
}

/** The rails' state, every value at its chain's pinned head (`o.heads`, else read now), with the pending items (`o.pending`,
 * read at those heads when not given) and the planned calls (`o.planned`). Fail-closed: any read that fails throws. */
export async function readRails(
  ctx: Pick<Ctx, "rpc" | "logs" | "logsWindow">,
  rec: RecordV32,
  o: BuildsOpt & { planned?: readonly RailChange[]; heads?: RailHeads; pending?: Record<SchedulerContract, readonly PendingItem[]> } = {},
): Promise<RailState> {
  const heads = o.heads ?? (await railHeads(ctx));
  const items = o.pending ?? {
    vault: await pendingOn(ctx, rec, "vault", { buildsDir: o.buildsDir, head: heads.vault }),
    frontDoor: await pendingOn(ctx, rec, "frontDoor", { buildsDir: o.buildsDir, head: heads.frontDoor }),
  };
  const pending = [...pendingRailChanges(items.vault), ...pendingRailChanges(items.frontDoor)];
  const planned = [...(o.planned ?? [])];
  const at = (c: SchedulerContract) => BigInt(heads[c].block);
  const lens = (c: SchedulerContract, fn: "primaryBridge" | "bridgeEnabled" | "bridgeKnown", args: readonly unknown[] = []) =>
    c === "vault" ? readVault(ctx, rec, fn, args, o.buildsDir, at(c)) : readDoor(ctx, rec, fn, args, o.buildsDir, at(c));
  const primary = { vault: getAddress((await lens("vault", "primaryBridge")) as Address), frontDoor: getAddress((await lens("frontDoor", "primaryBridge")) as Address) };
  const sendsTo = {
    vault: BigInt((await readVault(ctx, rec, "launchChain", [], o.buildsDir, at("vault"))) as bigint),
    frontDoor: BigInt((await readDoor(ctx, rec, "vaultChain", [], o.buildsDir, at("frontDoor"))) as bigint),
  };
  const peers: RailState["peers"] = { vault: {}, frontDoor: {} };
  const peerRead = async (c: SchedulerContract, b: Address) => {
    if (peers[c][low(b)]) return;
    const peer = getAddress((await read(ctx.rpc, CHAIN[c], { address: b, abi: PEER_ABI, functionName: "remoteAdapter" }, at(c))) as Address);
    const chain = BigInt((await read(ctx.rpc, CHAIN[c], { address: b, abi: PEER_ABI, functionName: "remoteChainId" }, at(c))) as bigint);
    peers[c][low(b)] = { peer, chain };
  };
  const ownBridges: Record<SchedulerContract, Address[]> = { vault: [], frontDoor: [] };
  for (const c of CONTRACTS) {
    // the primary now, each one the file switches to (in any order it may be sent: railVerdict), and each activation
    const mine = planned.filter((p) => p.contract === c);
    ownBridges[c] = uniq([primary[c], ...mine.filter((p) => p.fn !== "disableBridge").map((p) => p.bridge)]);
    for (const b of ownBridges[c]) await peerRead(c, b);
  }
  // each one's half on the other chain, whose own peer must name it back
  for (const c of CONTRACTS) {
    for (const b of ownBridges[c]) {
      const p = peers[c][low(b)];
      if (p.chain === sendsTo[c]) await peerRead(OTHER[c], p.peer);
    }
  }
  // the other side's bridges' peers that live on this side's chain: the vault takes one enabled now, the front door one
  // it ever enabled (known)
  const theirs = (c: SchedulerContract) =>
    ownBridges[OTHER[c]]
      .map((b) => peers[OTHER[c]][low(b)])
      .filter((p) => p.chain === sendsTo[OTHER[c]])
      .map((p) => p.peer);
  const enabled: RailState["enabled"] = { vault: {}, frontDoor: {} };
  for (const c of CONTRACTS) {
    const mine = planned.filter((p) => p.contract === c).map((p) => p.bridge);
    for (const b of uniq([...ownBridges[c], ...mine, ...(c === "vault" ? theirs(c) : [])])) enabled[c][low(b)] = Boolean(await lens(c, "bridgeEnabled", [getAddress(b)]));
  }
  const doorKnown: RailState["doorKnown"] = {};
  for (const b of uniq(theirs("frontDoor"))) doorKnown[low(b)] = Boolean(await lens("frontDoor", "bridgeKnown", [getAddress(b)]));
  // R4 (C-L4): every bridge whose peer was read, each its lane settings held to the deploy's adapter's on its chain (the
  // selector routes; remoteChainId is only a label)
  const config: NonNullable<RailState["config"]> = { vault: {}, frontDoor: {} };
  for (const c of CONTRACTS) for (const b of Object.keys(peers[c])) config[c][b] = await pairFieldProblems(ctx, rec, CHAIN[c], getAddress(b), at(c));
  return { heads, primary, sendsTo, peers, enabled, doorKnown, pending, planned, config };
}

const uniq = (xs: readonly string[]): Address[] => [...new Map(xs.map((x) => [low(x), getAddress(x)])).values()];

// ---- the words ----

/** One pair that will be refused at one end, in words. */
export function pairText(p: RailPair, sendsTo: Rails["sendsTo"]): string {
  const to = OTHER[p.from];
  if (p.noPayoutRail) {
    return `the front door's primary ${p.primary} sends to ${p.peer} on Bittensor while the vault's primary ${p.noPayoutRail} is disabled: the vault has no payout rail, so it defers every redeem those batches carry (switch the vault's primary first)`;
  }
  if (p.config) return `the ${NAME[p.from]}'s primary ${p.primary} and its other half ${p.peer} are not set up on Cascade's lane: ${p.config.join("; ")}`;
  if (p.chain !== sendsTo[p.from]) return `the ${NAME[p.from]}'s primary ${p.primary} sends to chain ${p.chain}, not to the ${NAME[to]}'s (${sendsTo[p.from]})`;
  if (p.back) return `the ${NAME[p.from]}'s primary ${p.primary} sends to ${p.peer} on ${SIDE[to]}, which ${takesOnly(p.back)}`;
  return `the ${NAME[p.from]}'s primary ${p.primary} sends to ${p.peer} on ${SIDE[to]}, which ${notTaken(to)}`;
}

/** A half that names another sender, in words. */
const takesOnly = (back: { peer: Address; chain: bigint }) => `takes messages only from ${back.peer} on chain ${back.chain}`;

/** Why `to` refuses a bridge: the vault takes one enabled now, the front door one it has ever enabled. */
const notTaken = (to: SchedulerContract) => (to === "vault" ? "is not enabled on the vault" : "the front door has never enabled");
/** What a peer `to` takes is, in words. */
const taken = (to: SchedulerContract) => (to === "vault" ? "enabled on the vault" : "which the front door has enabled");

/** Where an activation's plans come from: a file's calls (schedule, the sign page), or the pending items alone (a cancel,
 * whose file holds no activation: the T47b re-review's m3). */
type Plans = "file" | "pending";

/** One activation on one side only, in words: its other half is not pending there, nor in the file being written. */
export const halfText = (h: RailHalf, plans: Plans = "file"): string => {
  const to = OTHER[h.contract];
  if (h.config) return `${h.bridge} would be enabled on the ${NAME[h.contract]}, but it or its other half, ${h.peer} on ${SIDE[to]}, is not set up on Cascade's lane: ${h.config.join("; ")}`;
  if (h.back) return `${h.bridge} would be enabled on the ${NAME[h.contract]}, but its other half, ${h.peer} on ${SIDE[to]}, ${takesOnly(h.back)}`;
  const nor = plans === "file" ? "there or in this file" : "there";
  return `${h.bridge} would be enabled on the ${NAME[h.contract]} alone: its other half, ${h.peer} on ${SIDE[to]}, ${to === "vault" ? `is not enabled on the vault, nor pending ${nor}` : `the front door has never enabled, nor is it pending ${nor}`}`;
};

/** Each pair and half the rails name, in words. */
const problemsList = (r: Rails, plans: Plans = "file"): string[] => [...r.incoherent.map((p) => pairText(p, r.sendsTo)), ...r.halves.map((h) => halfText(h, plans))];
/** Every pair and half the rails name, in words. */
export const problemsText = (r: Rails): string => problemsList(r).join("; and ");

/** The residual's halves that apply to what the rails name (merge 7a's follow-up, the controller's ruling): the batch half
 * when the front door's pair disagrees (its batches to the vault), or a half the front door alone would enable; the
 * payout half when the vault's pair disagrees (its payouts to Base), or a half the vault alone would enable; both when
 * both do. A fault fixed at deploy (a pair or a half whose two ends don't name each other, or a primary that sends to
 * another chain) adds no half (merge 7a's review, M1): the residual's words would name the wrong fix, and the line before
 * them names the true cause; so the words may be none. So does a vault with no payout rail (R6, claim D): nothing is
 * parked, and its line says what happens. Naming nothing at all (never so for a warning), the batch half, as before. */
export function residualFor(r: Pick<Rails, "incoherent" | "halves" | "sendsTo">): string {
  const fixedAtDeploy = (p: RailPair) => p.back !== undefined || p.config !== undefined || p.noPayoutRail !== undefined || p.chain !== r.sendsTo[p.from];
  const pairs = r.incoherent.filter((p) => !fixedAtDeploy(p));
  const halves = r.halves.filter((h) => h.back === undefined && h.config === undefined);
  if (!pairs.length && !halves.length && (r.incoherent.length || r.halves.length)) return "";
  const on = (c: SchedulerContract) => pairs.some((p) => p.from === c) || halves.some((h) => h.contract === c);
  const payouts = on("vault");
  return [...(on("frontDoor") || !payouts ? [RAIL_RESIDUAL[1]] : []), ...(payouts ? [RAIL_RESIDUAL[2]] : [])].join(" ");
}

/** `text`, then the residual's halves that apply to `r` (residualFor), when there are any. */
const withResidual = (text: string, r: Pick<Rails, "incoherent" | "halves" | "sendsTo">) => {
  const residual = residualFor(r);
  return residual ? `${text} ${residual}` : text;
};

/** A call that takes effect when it is sent, in words: "setPrimaryBridge(0x…) on the front door (Base)",
 * "execute(activateBridge(0x…)) on the vault (Bittensor)". */
const changeText = (ch: RailChange) => `${ch.source === "executed" ? `execute(activateBridge(${ch.bridge}))` : `${ch.fn}(${ch.bridge})`} on ${where(ch.contract)}`;
/** "X is" or "X and then Y are". */
const sentText = (sent: readonly RailChange[]) => `${sent.map(changeText).join(" and then ")} ${sent.length === 1 ? "is" : "are"}`;
/** "before any pending item runs", "before any other pending item runs" after an execute. */
const beforeAny = (sent: readonly RailChange[]) => `before any ${sent.some((x) => x.source === "executed") ? "other " : ""}pending item runs`;

/** The pending items to execute before the file, in a sentence; none when no pending item fixes the step. */
function fixText(step: RailStep): string | undefined {
  if (!step.fixes.length) return undefined;
  const items = step.fixes.map((f) => `item ${f.id}, activateBridge(${f.bridge}) on the ${NAME[f.contract]} (pnpm ops execute ${f.id} --on ${f.contract === "vault" ? "vault" : "front-door"} --for-wallet --live)`);
  return `Execute ${items.length === 1 ? "this pending item" : "these pending items"} before this file: ${items.join("; ")}`;
}

/** A state right after some of a file's calls where the two chains disagree, in words (`lead`: "Right" to start a
 * sentence, "right" after "one-sided: "), with the pending items that would fix it. */
export function stepText(step: RailStep, lead: "Right" | "right"): string {
  const what = step.own
    ? `${lead} after ${sentText(step.sent)} sent, ${beforeAny(step.sent)}, the two chains disagree on the bridge: ${problemsText(step.rails)}.`
    : `The file fixes no order: sent first, ${step.sent.map(changeText).join(" and then ")} would leave the two chains disagreeing on the bridge ${beforeAny(step.sent)}: ${problemsText(step.rails)}.`;
  const fix = fixText(step);
  return fix ? `${what} ${fix}.` : what;
}

/** The refusal of a file whose calls would leave the two chains disagreeing right after they are sent. */
function stepRefusal(step: RailStep): string {
  const fix = fixText(step);
  const how = fix ? `${fix}; or, if this file must go first, add --one-sided "<reason>"` : `If this file must go first all the same, add --one-sided "<reason>"`;
  return `the two chains would disagree on the bridge right after ${sentText(step.sent)} sent, ${beforeAny(step.sent)}: ${problemsText(step.rails)}. ${how}; nothing written`;
}

/** The line that says every state right after the file's calls agrees (`n` calls, `ordered` or not). */
const agreeToo = (planned: readonly RailChange[], ordered: boolean, indent: string, page: boolean): string => {
  const n = planned.filter(atOnce).length;
  const each = page ? "each of its calls is" : "each call is";
  return `${indent}Right after ${n === 1 ? "it is" : each} sent${n > 1 ? (ordered ? ", in order" : ", in any order") : ""}, ${beforeAny(planned)}, the two chains agree on the bridge too.`;
};

/** What the sign page adds to the warning of a file whose end disagrees and that has no one-sided reason (the fix
 * round's Minor 2): true whoever wrote it, by hand, by retire-pair, or before the chains changed. */
export const NOT_PASSED = "This file would not pass pnpm ops schedule's rail check now, and it was not written with --one-sided.";

/** The one-sided lines: the residual quoted (its batch and payout halves, as the spec has them, one after the other), and
 * the reason written. */
const oneSidedTail = (why: string) => [`  Spec section 5: "${RAIL_RESIDUAL[0]}" And: "${RAIL_RESIDUAL[1]} ${RAIL_RESIDUAL[2]}"`, `  Written all the same, with your reason in the file for the sign page to show: "${why}".`];

/** Each side's primary at the end, in words: what it sends to, or that it is disabled. */
function primariesText(r: Rails): string {
  if (!r.primary.frontDoor.enabled && !r.primary.vault.enabled) {
    return "both primaries are disabled, so nothing crosses either way until the owner makes an enabled bridge the primary on each chain";
  }
  return CONTRACTS.map((c) => {
    const p = r.primary[c];
    return p.enabled ? `the ${NAME[c]}'s primary ${p.bridge} sends to ${p.peer} on ${SIDE[OTHER[c]]}, ${taken(OTHER[c])}` : `the ${NAME[c]}'s primary ${p.bridge} is disabled, so it sends nothing`;
  }).join("; ");
}

/** The rails, when the two chains agree on the bridge, in a sentence that starts with `when`. */
export const coherentText = (r: Rails, when: string): string => `${when}, the two chains agree on the bridge: ${primariesText(r)}.`;

/** The pending activations a planned disable of a primary kills, in a warning; none when it kills none. */
export function killedText(r: Rails): string | undefined {
  if (!r.killed.length) return undefined;
  const items = r.killed.map((k) => `item ${k.id}, activateBridge(${k.bridge}) on the ${NAME[k.contract]}`);
  return `Disabling the primary stamps its sender's clock, so ${r.killed.length === 1 ? "this pending activation dies" : "these pending activations die"} and never ${r.killed.length === 1 ? "runs" : "run"}: ${items.join("; ")}. Execute ${r.killed.length === 1 ? "it" : "them"} first if the switch needs ${r.killed.length === 1 ? "it" : "them"}.`;
}

// ---- pnpm ops schedule's rail files ----

/** One side's call of a rail file, its lines, and the change it plans. */
interface RailPart {
  contract: SchedulerContract;
  call: WalletCall;
  text: string;
  lines: string[];
  change: RailChange;
  /** the item's id, for an activation */
  id?: Hex;
}

/** canSendPayouts()'s calldata. */
const CAN_SEND_PAYOUTS = encodeFunctionData({ abi: RAIL_VIEWS, functionName: "canSendPayouts" });
const RAIL_GAS_TEXT = Number(RAIL_VIEW_GAS).toLocaleString("en-US");

/** R11 (ChatGPT r3, claim 2): the pre-activation rail check. A bridge the vault would read its payouts through (one it
 * activates, or makes its primary) must answer canSendPayouts() with one word, asked as the vault's _payoutsOpen asks
 * it: from the vault, with the gas its staticcall gives the view (RAIL_VIEW_CALL_GAS, as the keeper reads it). The
 * vault reads a call that reverts, runs out of that gas or halts, and any answer but one word, as payouts open, so door
 * redeems would be burned into a queue the bridge may never pay (runbook section 8, item 7): refused, nothing written.
 * A one-word answer passes either way (false is payouts closed now, a ForeverMoney pause), and its line says which. A
 * node's own error is a read that failed: refused, to try again. */
async function payoutsViewLines(ctx: Pick<SchedulerCtx, "rpc">, rec: RecordV32, bridge: Address): Promise<string[]> {
  let out: unknown;
  try {
    out = await ctx.rpc.request("bittensor", "eth_call", [{ from: getAddress(rec.plan.addresses.vault), to: bridge, data: CAN_SEND_PAYOUTS, gas: numberToHex(RAIL_VIEW_CALL_GAS) }, "latest"]);
  } catch (e) {
    if (!isRevert(e) && !isEvmHalt(e)) throw new Error(`Couldn't read ${bridge}'s canSendPayouts() right now (${firstLine(e)}); try again; nothing written`);
    throw new Error(payoutsViewRefusal(bridge, `reverts (${firstLine(e)})`));
  }
  if (typeof out !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(out) || out.length !== 66) {
    const bytes = typeof out === "string" && /^0x([0-9a-fA-F]{2})*$/.test(out) ? (out.length - 2) / 2 : 0;
    throw new Error(payoutsViewRefusal(bridge, bytes === 0 ? "answers nothing" : `answers ${bytes} bytes`));
  }
  const open = !/^0x0{64}$/.test(out);
  return [`  ${bridge} answers canSendPayouts() with one word (${open ? "true: payouts open now" : "false: payouts closed now"}), asked as the vault asks it (from the vault, with ${RAIL_GAS_TEXT} gas).`];
}

const payoutsViewRefusal = (bridge: Address, why: string) =>
  `${bridge} doesn't answer canSendPayouts() with one word when the vault asks it (from the vault, with ${RAIL_GAS_TEXT} gas): it ${why}. The vault reads that as payouts open, so it would take unstakes from Base into a queue this bridge may never pay; only a bridge that answers one word can carry the vault's payouts; nothing written`;

/** An activation on one side: Task 47's schedule(data), with its lines (schedulePart), the stamp stack's warning among
 * them: `o` carries the stacks' folder and the deployment's name to it, typed (Task 53's re-review, Minor 1). On the
 * vault, the bridge's payouts view is checked too (R11: payoutsViewLines). */
async function activationPart(ctx: SchedulerCtx, rec: RecordV32, c: SchedulerContract, words: readonly string[], o: BuildsOpt & { stampsDir?: string; name?: string }): Promise<RailPart> {
  const s = await schedulePart(ctx, rec, c, "activateBridge", words, o);
  const bridge = getAddress(s.args[0] as Address);
  const lines = c === "vault" ? [...s.lines, ...(await payoutsViewLines(ctx, rec, bridge))] : s.lines;
  return { contract: c, call: s.call, text: `schedule(${s.text})`, lines, id: s.id, change: { contract: c, fn: "activateBridge", bridge, source: "planned" } };
}

/** A disable or a switch of the primary on one side: the owner's direct call (neither is scheduled), asked of the
 * contract by eth_call from the owner it names now, as the file will send it. */
async function directPart(ctx: SchedulerCtx, rec: RecordV32, build: BuildV32, c: SchedulerContract, fn: "disableBridge" | "setPrimaryBridge", words: readonly string[], o: BuildsOpt): Promise<RailPart> {
  const f = abiOf(build, c).find((x): x is AbiFunction => x.type === "function" && x.name === fn);
  if (!f) throw new Error(`${where(c)} has no function ${fn}; nothing written`);
  const bridge = getAddress(argsFrom(f, words)[0] as Address);
  const get = (g: "owner" | "primaryBridge") => (c === "vault" ? readVault(ctx, rec, g, [], o.buildsDir) : readDoor(ctx, rec, g, [], o.buildsDir));
  const owner = getAddress((await readNow(`${where(c)}'s owner`, () => get("owner"))) as Address);
  const chain = CHAIN[c];
  const to = getAddress(rec.plan.addresses[c]);
  const data = encodeFunctionData({ abi: [f], functionName: fn, args: [bridge] } as never);
  const text = `${fn}(${bridge})`;
  const a = await ask(ctx, chain, { from: owner, to, data }, buildErrorsV32(build));
  if (a.kind === "unread") throw checkFailed(`${text} on ${where(c)}`, a.why);
  if (a.kind === "reverted") {
    const hint = a.name === "PrimaryStillEnabled" ? " (the switch needs the primary disabled first: pnpm ops schedule both disableBridge <the vault's primary> <the front door's primary>)" : "";
    throw new Error(`${text} on ${where(c)} from the owner ${owner} would revert: ${a.error}${hint}; nothing written`);
  }
  const lines = [`${chainLabel(chain)} ${NAME[c]} ${to}: ${text} from the owner ${owner} would succeed now. It is not scheduled: it takes effect when it is sent.`];
  if (owner.toLowerCase() !== rec.plan.roles.owner.toLowerCase()) lines.push(`  The owner is ${owner} now, not the record's ${rec.plan.roles.owner}: the file is from ${owner}.`);
  // R11 (ChatGPT r3, claim 2): the vault's new primary is the bridge it reads payouts through
  if (fn === "setPrimaryBridge" && c === "vault") lines.push(...(await payoutsViewLines(ctx, rec, bridge)));
  // R4 (D-L1, C-L3): the vault takes a batch only from a bridge enabled now, so once it disables a Bittensor adapter that
  // still holds parks, none can be delivered, only refunded after 14 days (spec §3.2: retire a pair only once it holds none)
  if (fn === "disableBridge" && c === "vault") lines.push(...(await parksWarning(ctx, bridge)));
  if (fn === "disableBridge" && same(await readNow(`${where(c)}'s primary bridge`, () => get("primaryBridge")), bridge)) {
    lines.push(
      `  It is the ${NAME[c]}'s primary bridge: disabling it closes the exits on ${chainLabel(chain)} and stamps the owner's clock, until the owner makes another enabled bridge the primary (setPrimaryBridge).`,
      `  The stamp kills every item pending on the ${NAME[c]}: execute first what you mean to keep.`,
    );
  }
  return { contract: c, call: { chainId: chainIdFor(rec, chain), to, data, value: "0", label: fit(`${text} on ${where(c)}`, `${fn} on ${where(c)}`), from: owner }, text, lines, change: { contract: c, fn, bridge, source: "planned", by: "owner" } };
}

/** R4 (D-L1, C-L3): the warning a vault-side disable of `bridge` carries while that Bittensor adapter holds parks (what its
 * parkedNative and parkedTokens owe, read now), or that they couldn't be read: never taken as none. None when it holds
 * none. */
async function parksWarning(ctx: Pick<SchedulerCtx, "rpc">, bridge: Address): Promise<string[]> {
  let native: bigint;
  let tokens: bigint;
  try {
    native = (await read(ctx.rpc, "bittensor", { address: bridge, abi: PARKS_ABI, functionName: "parkedNative" })) as bigint;
    tokens = (await read(ctx.rpc, "bittensor", { address: bridge, abi: PARKS_ABI, functionName: "parkedTokens" })) as bigint;
  } catch (e) {
    return [`  WARNING — the Bittensor adapter ${bridge}'s parks couldn't be read (${firstLine(e)}): check it holds none (pnpm ops park --live) before you sign.`];
  }
  if (native === 0n && tokens === 0n) return [];
  return [
    `  WARNING — the Bittensor adapter ${bridge} still holds parks (${formatEther(native)} TAO as TAO, ${formatEther(tokens)} TAO as tokens). Once the vault disables it, they can't be delivered, only refunded to Base after 14 days. Wait until it holds none (pnpm ops park --live).`,
  ];
}

/** `pnpm ops schedule <vault|front-door|both> <activateBridge|disableBridge|setPrimaryBridge> <bridge…> [--one-sided
 * "<reason>"] --for-wallet`: a change to the bridges, on one side, or on both in one file (`both`, the vault's bridge
 * then the front door's; the front door's call first in the file, but the vault's first for a switch of the primaries:
 * R6, claim D). Each side's call is Task 47's (an activation's
 * schedule(data), asked of the scheduler) or the owner's direct call (a disable, a switch of the primary), asked of the
 * contract by eth_call; then the rail check of both chains (readRails, railCoherence) with the pending items: a file that
 * would leave the two chains disagreeing on the bridge is refused, naming the pair, unless `oneSided` gives the reason,
 * which is written into the file. A read that fails refuses, to try again: it is never taken as agreeing. */
export async function railScheduleCommand(
  ctx: SchedulerCtx,
  rec: RecordV32,
  o: FileOpts & { contract: string; fn: string; args: readonly string[]; oneSided?: string },
): Promise<{ ok: boolean; lines: string[]; files: string[] }> {
  const both = o.contract === "both";
  if (!isRailFn(o.fn)) {
    if (both) throw new Error(`both is for the bridges' calls (${RAIL_FNS.join(", ")}): any other change is scheduled on each chain in a file of its own; nothing written`);
    throw new Error(`--one-sided goes only with a change to the bridges (${RAIL_FNS.join(", ")}); nothing written`);
  }
  const fn = o.fn;
  // a switch of both primaries goes the vault's first (R6, claim D); the disables and the activations the front door's first
  const sides: SchedulerContract[] = both ? (fn === "setPrimaryBridge" ? ["vault", "frontDoor"] : ["frontDoor", "vault"]) : [schedulerOf(o.contract)];
  if (both && o.args.length !== 2) throw new Error(`both ${fn} takes two bridges: the vault's (on Bittensor), then the front door's (on Base); nothing written`);
  await checkChains(ctx);
  const build = loadBuildV32(rec.build, o.buildsDir);
  const parts: RailPart[] = [];
  for (const c of sides) {
    const words = both ? [o.args[c === "vault" ? 0 : 1]] : o.args;
    parts.push(fn === "activateBridge" ? await activationPart(ctx, rec, c, words, o) : await directPart(ctx, rec, build, c, fn, words, o));
  }
  const planned = parts.map((p) => p.change);
  // both chains' direct calls go in order. The disables the front door's first: sent the other way, a disable of the
  // vault's half would refuse the front door's batches until the front door's call lands (Task 47b's fix round). The
  // switches the vault's first: sent the other way, the front door's batches would reach the vault while its primary is
  // still disabled, and the vault would defer their redeems, having no payout rail (R6, ChatGPT R2 claim D)
  const ordered = both && fn !== "activateBridge";
  const state = await readNow("the rails (each chain's primary and bridges, and the pending items)", () => readRails(ctx, rec, { buildsDir: o.buildsDir, planned }));
  const v = railVerdict(state, ordered);
  const end = v.end;
  const lines = parts.flatMap((p) => p.lines);
  const killed = killedText(end);
  if (killed) lines.push(`  WARNING — ${killed}`);
  if (end.coherent && !v.step) {
    if (o.oneSided !== undefined) throw new Error("--one-sided is for a file the rail check would refuse, and with this one the two chains agree on the bridge: drop it; nothing written");
    lines.push(`  ${coherentText(end, "Once this file and the pending items run")}`);
    if (planned.some(atOnce)) lines.push(agreeToo(planned, ordered, "  ", false));
  } else if (o.oneSided === undefined) {
    // the end first, as before; then what the file's direct calls leave until the pending items run
    throw new Error(!end.coherent ? refusal(end, state, fn, both) : stepRefusal(v.step!));
  } else {
    if (!end.coherent) lines.push(`WARNING — one-sided: once this file and the pending items run, the two chains disagree on the bridge: ${problemsText(end)}.`);
    // the state right after the file's calls, unless it is the end's own disagreement again
    if (v.step && (end.coherent || problemsText(v.step.rails) !== problemsText(end))) lines.push(`WARNING — one-sided: ${stepText(v.step, "right")}`);
    lines.push(...oneSidedTail(o.oneSided));
  }
  const one = parts[0];
  const vault = parts.find((p) => p.contract === "vault");
  const door = parts.find((p) => p.contract === "frontDoor");
  const tag = o.oneSided !== undefined ? " (one-sided)" : "";
  const stem = both
    ? `${o.name}-${fn}-both-${low(vault!.change.bridge).slice(2, 10)}-${low(door!.change.bridge).slice(2, 10)}`
    : one.id
      ? `${o.name}-schedule-${fn}-${one.id.slice(2, 10)}`
      : `${o.name}-${fn}-${CHAIN[one.contract]}-${low(one.change.bridge).slice(2, 10)}`;
  const title = both
    ? fit(`Cascade ${o.name}: ${fn} on both chains, ${door!.change.bridge} on the front door and ${vault!.change.bridge} on the vault: sign both calls${tag}`, `Cascade ${o.name}: ${fn} on both chains: sign both calls${tag}`)
    : fit(`Cascade ${o.name}: ${one.text} on ${where(one.contract)}${tag}`, `Cascade ${o.name}: ${fn} on ${where(one.contract)}${tag}`);
  const path = writeCalls(
    o,
    stem,
    title,
    parts.map((p) => p.call),
    { ...(o.oneSided !== undefined ? { oneSided: o.oneSided } : {}), ordered },
  );
  lines.push(wroteLine(path, parts.length));
  if (ordered) lines.push(`The file holds both chains' calls, in order, the ${NAME[sides[0]]}'s first: sign both. The page sends the ${NAME[sides[1]]}'s only once the ${NAME[sides[0]]}'s has succeeded.`);
  else if (both) lines.push("The file holds both chains' calls, the front door's first: sign both. Signed alone, either one leaves the two chains disagreeing on the bridge.");
  return { ok: true, lines, files: [path] };
}

/** `pnpm ops execute <id> [--on vault|front-door] [--one-sided "<reason>"] --for-wallet`: Task 47's execute (executePart,
 * every check of it), and, for an activation of a bridge (a Reopen too), the rails as they will be right after it runs,
 * with no other pending item counted (Task 47b's fix round, ruling d), against the rails right before it: refused only
 * when it makes them worse, a side's pair that agrees now (or carries nothing) disagreeing right after, naming that pair
 * and the pending item to execute first, unless `oneSided` gives the reason, which is written into the file; a
 * disagreement it leaves in place, or a partial repair, goes ahead with a warning naming the pair still disagreeing (the
 * controller's ruling on the fix round's concern 2). An execute of anything else reads no rails, and takes no
 * --one-sided. A read that fails refuses, to try again. */
export async function railExecuteCommand(ctx: SchedulerCtx, rec: RecordV32, o: FileOpts & { id: string; on?: string; oneSided?: string }): Promise<{ ok: boolean; lines: string[]; files: string[] }> {
  const p = await executePart(ctx, rec, o);
  const item = p.item;
  if (item.fn !== "activateBridge") {
    if (o.oneSided !== undefined) throw new Error("--one-sided goes only with the execute of an activation of a bridge; nothing written");
    return writeExecute(o, p);
  }
  const change: RailChange = { contract: item.contract, fn: "activateBridge", bridge: getAddress(item.args.bridge as Address), source: "executed", id: item.id, kind: item.kind };
  const what = "the rails (each chain's primary and bridges, and the pending items)";
  const state = await readNow(what, () => readRails(ctx, rec, { buildsDir: o.buildsDir, planned: [change], pending: { vault: [], frontDoor: [] } }));
  // the other pending activations, only to name one that would fix a pair (the check counts none of them); one the lens
  // could not judge is not named
  state.pending = pendingRailChanges(p.items.filter((i) => !(i.fn === "activateBridge" && i.unknown) && !(i.contract === item.contract && same(i.id, item.id))));
  // refused only when it makes the rails worse (the controller's ruling on the fix round's concern 2): a side's pair that
  // agrees right before it (or carries nothing) disagrees right after; a disagreement it leaves in place, or a partial
  // repair, goes ahead with a warning that names the pair still disagreeing
  const before = railCoherence({ ...state, pending: [], planned: [] });
  const after = railCoherence({ ...state, pending: [], planned: [change] });
  const was = new Set(before.incoherent.map((x) => x.from));
  const worse = after.incoherent.filter((x) => !was.has(x.from));
  const left = after.incoherent.filter((x) => was.has(x.from));
  const lines = [...p.lines];
  const still = left.length ? [`WARNING — Right after it runs, the two chains still disagree on the bridge, as they do now: ${problemsText({ ...after, incoherent: left, halves: [] })}.`] : [];
  if (!worse.length) {
    if (o.oneSided !== undefined) {
      throw new Error(
        left.length
          ? "--one-sided is for an execute the rail check would refuse, and this one leaves no pair worse than it is now: drop it; nothing written"
          : "--one-sided is for a file the rail check would refuse, and with this one the two chains agree on the bridge: drop it; nothing written",
      );
    }
    lines.push(...(left.length ? still : [`  ${coherentText(after, "Right after it runs")}`]));
    return writeExecute(o, { ...p, lines });
  }
  const broken = { ...after, incoherent: worse, halves: [] };
  const step: RailStep = { sent: [change], rails: broken, fixes: fixesOf(broken, state.pending), own: true };
  if (o.oneSided === undefined) throw new Error(stepRefusal(step));
  lines.push(`WARNING — one-sided: ${stepText(step, "right")}`, ...still, ...oneSidedTail(o.oneSided));
  return writeExecute(o, { ...p, lines }, o.oneSided);
}

/** `pnpm ops cancel <id> --as owner|guardian --for-wallet`: Task 47's cancel, never refused for the rails (it is the
 * guardian's veto: Task 47b's fix round, ruling d). When it drops an activation that can still run, it warns if a pair
 * depends on it: once the other pending items run without it, the two chains would disagree where with it they would
 * not (a primary sending to its bridge, or its other half pending or enabled alone). A read that fails says so. */
export async function railCancelCommand(ctx: SchedulerCtx, rec: RecordV32, o: FileOpts & { id: string; as: "owner" | "guardian" }): Promise<{ ok: boolean; lines: string[]; files: string[] }> {
  const r = await cancelCommand(ctx, rec, o);
  const out = { ok: r.ok, lines: r.lines, files: r.files };
  // an activation the lens could not judge may still run, so its cancel may matter too
  const mayRun = (i: PendingItem) => i.unknown !== undefined || !(i.dead || !i.canonical || lapsed(i));
  const dropped = r.cancelled.filter((i) => i.fn === "activateBridge" && mayRun(i));
  if (!dropped.length) return out;
  const it = dropped.length === 1 ? ["this activation", "it"] : ["these activations", "them"];
  try {
    if (!r.complete) throw new Error("a scheduler's pending items could not be read");
    // each pending activation as a plan, so a lone half is named; the dropped ones apart
    const rest = pendingRailChanges(r.items.filter((i) => !r.cancelled.includes(i))).map((x): RailChange => ({ ...x, source: "planned" }));
    const gone = dropped.map((i): RailChange => ({ contract: i.contract, fn: "activateBridge", bridge: getAddress(i.args.bridge as Address), source: "planned", id: i.id, kind: i.kind }));
    const s = await readRails(ctx, rec, { buildsDir: o.buildsDir, pending: { vault: [], frontDoor: [] }, planned: [...rest, ...gone] });
    // the plans here are the pending items, not a file's: a half's other half is "not pending there"
    const was = new Set(problemsList(railCoherence({ ...s, planned: [...rest, ...gone] }), "pending"));
    const left = problemsList(railCoherence({ ...s, planned: rest }), "pending").filter((x) => !was.has(x));
    if (left.length) {
      out.lines.push(`WARNING — The rails depend on ${it[0]}: once the other pending items run without ${it[1]}, the two chains disagree on the bridge: ${left.join("; and ")}. The cancel is written all the same: it is never refused.`);
    }
  } catch (e) {
    out.lines.push(`WARNING — Whether the rails depend on ${it[0]} couldn't be read right now (${firstLine(e)}).`);
  }
  return out;
}

/** The other side's half of a planned change's bridge: its own peer (read for a primary and an activation), else, for a
 * disable, the other side's primary when that one sends to it. */
function otherHalf(s: RailState, p: RailChange): Address | undefined {
  const mine = s.peers[p.contract][low(p.bridge)];
  if (mine) return mine.chain === s.sendsTo[p.contract] ? mine.peer : undefined;
  const them = OTHER[p.contract];
  return same(s.peers[them][low(s.primary[them])]?.peer, p.bridge) ? s.primary[them] : undefined;
}

/** The refusal of a file that would leave the rails incoherent: the pairs and halves, and the file to write instead. */
function refusal(end: Rails, s: RailState, fn: RailFn, both: boolean): string {
  let how = "this file names both sides, so check that its two bridges are one pair (each one's peer, its remoteAdapter, is the other) and what is pending on each";
  if (!both) {
    const p = s.planned[0];
    const half = otherHalf(s, p);
    const pair = half ? { [p.contract]: p.bridge, [OTHER[p.contract]]: half } : undefined;
    how = `put both sides in one file${pair ? `: pnpm ops schedule both ${fn} ${pair.vault} ${pair.frontDoor} --for-wallet --live` : " (pnpm ops schedule both)"}`;
  }
  return `the two chains would disagree on the bridge once this file and the pending items run: ${problemsText(end)}. A rail switch is one two-sided operation: ${how}; or, if one side must go first, add --one-sided "<reason>"; nothing written`;
}

// ---- the sign page and verify ----

/** What the sign page shows of a file's rail calls, as pnpm ops schedule and pnpm ops execute judge them (railVerdict),
 * in the file's order when it is `ordered`, else at its worst order: the rails once the file and the pending items run
 * (for a file that changes the bridges: a disable, a switch, an activation's schedule), and right after its calls that
 * take effect at once (those, and an activation's execute), each as a row; and a warning when the two chains would
 * disagree on the bridge, or when that couldn't be read (never "agreeing"). An end that disagrees in a file with no
 * one-sided reason says the file would not pass pnpm ops schedule's check now (NOT_PASSED). The page never refuses for
 * it: pnpm ops schedule and pnpm ops execute already did. */
export async function railsForPage(
  ctx: Pick<Ctx, "rpc" | "logs" | "logsWindow">,
  rec: RecordV32,
  planned: readonly RailChange[],
  o: BuildsOpt & { ordered: boolean; oneSided?: string },
): Promise<{ lines: string[]; warnings: string[] }> {
  let v: RailVerdict;
  try {
    v = railVerdict(await readRails(ctx, rec, { buildsDir: o.buildsDir, planned }), o.ordered);
  } catch (e) {
    return {
      lines: [`Couldn't be read right now (${firstLine(e)}).`],
      warnings: [`Whether the two chains will agree on the bridge once this file runs couldn't be read right now (${firstLine(e)}): don't take it that they will.`],
    };
  }
  const lines: string[] = [];
  const warnings: string[] = [];
  // the end is judged for a file that changes the bridges; an execute alone is judged right after it runs
  const changes = planned.some((p) => p.source !== "executed");
  if (changes) {
    const killed = killedText(v.end);
    if (v.end.coherent) lines.push(coherentText(v.end, "Once this file and the pending items run"));
    else {
      const what = `Once this file and the pending items run, the two chains disagree on the bridge: ${problemsText(v.end)}.`;
      lines.push(what);
      warnings.push(`${withResidual(what, v.end)}${o.oneSided === undefined ? ` ${NOT_PASSED}` : ""}`);
    }
    if (killed) {
      lines.push(killed);
      warnings.push(killed);
    }
  }
  if (v.step) {
    // said once when it is the end's own disagreement again
    if (!changes || v.end.coherent || problemsText(v.step.rails) !== problemsText(v.end)) {
      const t = stepText(v.step, "Right");
      lines.push(t);
      warnings.push(withResidual(t, v.step.rails));
    }
  } else if (planned.some(atOnce)) {
    lines.push(changes ? agreeToo(planned, o.ordered, "", true) : coherentText(v.after, planned.filter(atOnce).length === 1 ? "Right after it runs" : "Right after they run"));
  }
  return { lines, warnings };
}

/** verify's report of the rails (spec §5's residual): now, a failure when the two chains disagree on the bridge; and the
 * pending items that change them, with what they would make of them (a warning when the chains would then disagree). */
export function railsFindings(s: RailState): { failures: string[]; warnings: string[]; info: string[] } {
  const out = { failures: [] as string[], warnings: [] as string[], info: [] as string[] };
  const now = railCoherence({ ...s, pending: [], planned: [] });
  if (now.coherent) out.info.push(coherentText(now, "The rails: now"));
  else out.failures.push(withResidual(`The rails: now the two chains disagree on the bridge: ${problemsText(now)}.`, now));
  if (!s.pending.length) return out;
  const end = railCoherence({ ...s, planned: [] });
  const items = s.pending.map((p) => `item ${p.id}, activateBridge(${p.bridge}) on the ${NAME[p.contract]}`).join("; ");
  if (end.coherent) out.info.push(`The rails: the pending items that change them: ${items}. ${coherentText(end, "Once they run")}`);
  else out.warnings.push(`The rails: the pending items that change them: ${items}. Once they run, the two chains disagree on the bridge: ${problemsText(end)}.`);
  return out;
}
