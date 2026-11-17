import { type Abi, type AbiFunction, type Address, decodeFunctionData, encodeAbiParameters, getAddress, type Hex, keccak256, recoverAddress, toFunctionSelector, zeroAddress } from "viem";
import type { ChainName } from "../config.ts";
import { blockTimeOf } from "../keeper/core/blocktime.ts";
import { chainIdOf, read } from "../rpc.ts";
import { chainLabel, ReceiptTimeout, RevertedOnChain } from "../send.ts";
import type { PageAnswer, PageApi } from "../sign.ts";
import {
  type CallDetail,
  type CallView,
  checkCalls,
  type KnownCall,
  type KnownContract,
  type KnownFunction,
  type Sender,
  type StampView,
  valueText as argText,
  WALLET_CHAINS,
  type WalletFile,
  type WalletView,
} from "../wallet.ts";
import { loadBuildV32 } from "./build.ts";
import { halfInBlocks, SCHEDULED_V32 } from "./classes.ts";
import { type DeploymentRecordV32, ownerKindOf } from "./deploy.ts";
import { readDoor, readVault } from "./lens.ts";
import { type RailChange, railsForPage } from "./rails.ts";
import { doorWarning, removeDoorGuard } from "./retire.ts";
import {
  abiOf,
  cancelCall,
  cancellers,
  chainIdFor,
  checkChains,
  classOf,
  currentValues,
  decodeSetter,
  delaysOf,
  executeCall,
  firstLine,
  headOf,
  HistoryMissing,
  innerOf,
  iso,
  isWriteOff,
  itemText,
  looseningLines,
  looseningOf,
  type PendingItem,
  pendingOn,
  type SchedulerContract,
  type SchedulerCtx,
  span,
  stateOf,
  tao,
  untilText,
  valueText,
  where,
  writeOffStillFits,
} from "./scheduler.ts";
import { BOUNDS_V32, capsWarning, FUNDING_V32, type OwnerKind } from "./settings.ts";
import { headTime, normaliseSignature, STAMP_MAX_TTL, STAMP_TYPEHASH, stackEntryProblem, stampHashes, stampTypedDataJson, windowProblem } from "./stamp.ts";

// The sign page for a v3.2 deployment (plan Task 49): the founder's last look before the Ledger signs, maybe blind. The
// controller's rulings, each kept here:
// - what is shown is what is signed: every call is decoded with KNOWN_ABI and confirmed against its contract's own ABI
//   from the deployment's frozen build (wallet.ts checkCalls, KnownContract.abi), and a schedule(data) or execute(data)
//   decodes its setter with that ABI too; calldata the page can't decode is refused, never shown raw;
// - execute only a live pending item: the items are read from the chain when the page is served (Task 47's pendingOn),
//   and the item must pass executeCall's rules (pending, alive, ready, in its window); each chain's copy is shown;
// - warnings that never refuse: an execute that loosens a limit (each changed field, now and then, by Task 47's
//   looseningOf), the owner's removeFrontDoor, and caps above the founder level without a Safe (capsWarning, ruling
//   B7a, quoting section 5);
// - the remove-door re-check: Task 46b's guard runs when the page is served and again, through pnpm ops sign's server,
//   just before the page sends (Task 46b's review, I2): if it no longer passes, nothing is sent and the page says why;
// - stamps: each is for this deployment's vault on Bittensor or its front door on Base, signed by the owner the
//   contract names now, over the contract's own domain; the page switches MetaMask to the stamp's chain, and pnpm ops
//   sign checks the signature recovers to the owner before handing it to pnpm ops stamp's relay or --to-stack (ruling C3;
//   Task 48's review's carry);
// - transferOwnership is never a call of its own (KNOWN_ABI lacks it): only the calldata of schedule(data) or execute(data);
// - the rails (Task 47b): a file of calls on the bridges (an activation's schedule, a disable, a switch of the primary)
//   shows what it makes of the rail between the chains once it and the pending items run (rails.ts), and warns when the
//   two chains would disagree on the bridge, or when that couldn't be read; it never refuses for it (pnpm ops schedule
//   already did). A file written past that check with --one-sided shows its reason. Task 47b's fix round: it also
//   shows the rails right after the file's calls that take effect at once (a disable, a switch, an activation's
//   execute), in the file's order, or at its worst order when the file fixes none (a hand-edited file's or
//   retire-pair's), as pnpm ops schedule and pnpm ops execute judge them; and an end that disagrees, in a file with no
//   one-sided reason, says the file would not pass pnpm ops schedule's check now.
// The roles a call may come from are the ones the contract names now; when they can't be read, the record's, said so.

/** What a signed stamp is handed on as: its contract, its time, the owner's signature (normalised), and what is done. */
export interface StampSubmission {
  target: SchedulerContract;
  asOf: bigint;
  sig: Hex;
  mode: "relay" | "stack";
}

/** What the v3.2 sign page reads with and hands stamps to. */
export interface SignV32Deps {
  /** The live chains' RPC and log server: every read when the page is served, and its re-checks. */
  ctx: SchedulerCtx;
  /** Where the frozen builds are (ops/builds/ by default). */
  buildsDir?: string;
  /** pnpm ops stamp's relay path, for a file of stamps: absent, such a file is refused. */
  stamps?: {
    /** The relayer's stacks (ops/stamps): a stack stamp is checked against its stack when the page is served. */
    dir: string;
    /** Asked once per mode before the page is served (the relayer's key named, for `relay`): it throws to refuse. */
    ready?(mode: "relay" | "stack"): Promise<void> | void;
    /** The owner's signature, checked here, handed to pnpm ops stamp's relay (mode relay) or --to-stack (mode stack). */
    submit(rec: DeploymentRecordV32, s: StampSubmission): Promise<{ ok: boolean; lines: string[] }>;
  };
}

const NAMES: Record<SchedulerContract, { chain: ChainName; name: string; short: string }> = {
  vault: { chain: "bittensor", name: "Vault", short: "Bittensor" },
  frontDoor: { chain: "base", name: "Front door", short: "Base" },
};
const CONTRACTS = ["vault", "frontDoor"] as const;
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

/** An error's text as the page says it: its first line, without the CLI's "; nothing written" and the like. */
export const pageText = (e: unknown): string => firstLine(e).replace(/; nothing (written|sent|added|signed or sent|read or written|to sign)$/, "");

/** What a call that stamps `who`'s clock on the vault does to the items pending there (spec §3.6, Ordering; Task 49's
 * review, M6): the owner's clock kills every item, the guardian's every Ordinary one. */
const kills = (who: "owner" | "guardian") =>
  who === "owner"
    ? "it stamps the owner's clock on the Vault: every item pending there dies, your own scheduled transferOwnership included. Schedule what you mean to keep after it."
    : "it stamps the guardian's clock on the Vault: every Ordinary item pending there dies (not a guardian swap or a reopening), your own scheduled transferOwnership included. Schedule what you mean to keep after it.";

const EXPLORERS: Record<ChainName, string> = { bittensor: "https://evm.taostats.io", base: "https://basescan.org" };

/** "48-hour", "8-day": a delay as one word. */
const asWord = (s: number) => span(s).replace(/ (day|hour|second)s$/, "-$1");

/** The owner, the guardian, the pending owner and the treasury a contract names now, or why they couldn't be read. */
interface Roles {
  owner?: Address;
  guardian?: Address;
  pendingOwner?: Address;
  treasury?: Address;
  problem?: string;
}

/** The roles that send the page's calls (the treasury: its own setRedeemOrigin on the vault, Task 53). */
type Role = "owner" | "guardian" | "pendingOwner" | "treasury";

async function rolesOf(ctx: SchedulerCtx, rec: DeploymentRecordV32, c: SchedulerContract, buildsDir?: string): Promise<Roles> {
  const get = (fn: Role) => (c === "vault" ? readVault(ctx, rec, fn, [], buildsDir) : readDoor(ctx, rec, fn, [], buildsDir));
  try {
    const roles: Roles = { owner: getAddress((await get("owner")) as Address), guardian: getAddress((await get("guardian")) as Address), pendingOwner: getAddress((await get("pendingOwner")) as Address) };
    // the treasury on its own (Task 53): a read that fails leaves the record's treasury for its one call, and nothing else
    try {
      roles.treasury = getAddress((await get("treasury")) as Address);
    } catch {
      // the record's (by)
    }
    return roles;
  } catch (e) {
    return { problem: firstLine(e) };
  }
}

/** What the page may send to the vault and the front door of a v3.2 deployment, from whom, and what each does in a line:
 * each from the role the contract names now (the record's when that couldn't be read), to the contract whose frozen ABI
 * has it. */
function knownV32(rec: DeploymentRecordV32, c: SchedulerContract, r: Roles, abi: Abi): KnownContract {
  const { name, short } = NAMES[c];
  const now = (role: Role): Sender[] => {
    const a = r[role];
    if (!a || a === zeroAddress) return [];
    return [{ address: a, role: role === "pendingOwner" ? `the pending owner the ${name} names now` : `the ${role} the ${name} names now` }];
  };
  const by = (roles: Role[]): Pick<KnownCall, "senders" | "live" | "liveProblem"> =>
    r.problem === undefined
      ? // the treasury unread (its own read failed): the record's, for its one call
        roles.includes("treasury") && r.treasury === undefined
        ? { senders: [{ address: getAddress(rec.plan.roles.treasury), role: `the treasury on ${short}` }], live: roles.filter((x) => x !== "treasury").flatMap(now) }
        : { senders: [], live: roles.flatMap(now) }
      : {
          senders: roles.filter((x): x is "owner" | "guardian" | "treasury" => x !== "pendingOwner").map((x) => ({ address: getAddress(rec.plan.roles[x]), role: `the ${x} on ${short}` })),
          liveProblem: r.problem,
        };
  const call = (roles: Role[], effect: KnownCall["effect"]): KnownCall => ({ ...by(roles), effect });
  const arg = (fn: { args: { value: string }[] }, i: number) => fn.args[i]?.value ?? "";
  const calls: Partial<Record<KnownFunction, KnownCall>> = {
    pause: call(["guardian", "owner"], () =>
      c === "vault" ? "pauses the Vault on Bittensor until the owner unpauses" : "pauses the Front door on Base until the owner unpauses: it stops deposits (redeem requests still batch, and claims stay open)",
    ),
    unpause: call(["owner"], () => `lets the ${name} on ${short} run again (undoes pause())`),
    acceptOwnership: call(["pendingOwner"], (from) => `makes ${from} the owner of the ${name} on ${short}: the last step of a scheduled transferOwnership`),
    schedule: call(["owner"], () => `schedules a change on the ${name}`),
    execute: call(["owner"], () => `runs a scheduled change on the ${name}`),
    cancel: call(["owner", "guardian"], (_f, fn) => `drops item ${arg(fn, 0)} from the ${name}'s scheduler, so it never runs here`),
    disableBridge: call(["owner", "guardian"], (_f, fn) => `stops the bridge ${arg(fn, 0)} on the ${name}: it carries no more messages`),
    // Task 53's fix round: the keeper's rotation (or, at 0, its revocation), the owner's, at once
    setKeeper: call(["owner"], (_f, fn) => `makes ${arg(fn, 0)} the ${name}'s keeper on ${short}, at once (the keeper Worker sends nothing until its key is keeper() on both chains)`),
    setPrimaryBridge: call(["owner"], (_f, fn) => `makes ${arg(fn, 0)} the ${name}'s primary bridge`),
  };
  if (c === "vault") {
    Object.assign(calls, {
      removeFrontDoor: call(["owner", "guardian"], (_f, fn) => `removes the front door ${arg(fn, 1)} (chain ${arg(fn, 0)}) from the Vault, which then takes nothing more from it`),
      cancelPayoutBatch: call(["owner"], (_f, fn) => `cancels the Vault's payout batch ${arg(fn, 0)}: each redeem not yet paid returns its leaver to the vault at today's price, and each bounced deposit stays queued to be paid`),
      setMaxTotalAssets: call(["owner"], (_f, fn) => `sets the Vault's maxTotalAssets to ${tao(BigInt(arg(fn, 0)))} TAO (a raise goes only through the scheduler)`),
      addHotkey: call(["owner", "guardian"], (_f, fn) => `adds the hotkey ${arg(fn, 0)} to the Vault's list`),
      // Task 53: the owner's moves any stake on it onto the stake hotkey; the guardian's removes an empty hotkey only
      removeHotkey: call(["owner", "guardian"], (_f, fn) =>
        `removes the hotkey ${arg(fn, 0)} from the Vault's list (the owner's removal moves any stake on it onto the stake hotkey; the guardian's takes only an empty one)${arg(fn, 1) === "true" ? ", giving up its unclaimed rewards (forfeit)" : ""}`,
      ),
      setStakeHotkey: call(["owner"], (_f, fn) => `makes ${arg(fn, 0)} the hotkey the Vault stakes new TAO to`),
      // Task 53's fix round: a raise of the idle buffer, at once (a lowering is refused when the page is served: it is
      // a scheduled item); its words, with the value now, come from that check
      setIdleBuffer: call(["owner"], (_f, fn) => `sets the Vault's idleBufferBps to ${arg(fn, 0)}`),
      // R5 Minor 3: the owner's claimGasRequired, at once either way; a value outside the vault's bounds is refused when
      // the page is served, and its words, with the value now, come from that check
      setClaimGasRequired: call(["owner"], (_f, fn) => `sets the Vault's claimGasRequired to ${arg(fn, 0)} gas`),
      // Task 53: the treasury's own redeem origin, Bittensor itself (spec §3.4; the T18 ruling: before the first reward cut)
      setRedeemOrigin: call(["treasury"], (_f, fn) =>
        BigInt(arg(fn, 0) || "0") === (1n << 64n) - 1n
          ? "makes the treasury's redeem origin Bittensor itself (DIRECT_ORIGIN): its shares are redeemed only on Bittensor (redeemDirect), never burned by a front door"
          : `makes the treasury's redeem origin chain ${arg(fn, 0)}: that chain's front doors may burn its shares`,
      ),
    } satisfies Partial<Record<KnownFunction, KnownCall>>);
  } else {
    calls.setCaps = call(["owner"], (_f, fn) => `sets the Front door's minimum deposit to ${tao(BigInt(arg(fn, 0)))} TAO and its deposit cap to ${tao(BigInt(arg(fn, 1)))} TAO`);
    // R6b (U4): the owner's batch limits, at once either way (runbook 7.10's fallback)
    calls.setBatchLimits = call(["owner"], (_f, fn) => `sets the most deposits a Front door batch holds to ${arg(fn, 0)} and the most redeem requests to ${arg(fn, 1)}, at once`);
  }
  return { chainId: chainIdFor(rec, NAMES[c].chain), address: getAddress(rec.plan.addresses[c]), name, calls, abi };
}

/** The Bittensor adapter, for the calls the page sends it (Task 53's fix round; merge 7b): fundReserve(), payable, from
 * anyone, carrying at most what an empty adapter's reserve takes (RESERVE_TARGET plus the 500 rao Bittensor keeps
 * back); and fundCushion(amount), from anyone, which books what the approve before it lets the adapter pull into its
 * token cushion (R4, F-1), at most the cushion's target (the page's own check). */
function knownAdapterV32(rec: DeploymentRecordV32, abi: Abi): KnownContract {
  return {
    chainId: chainIdFor(rec, "bittensor"),
    address: getAddress(rec.plan.addresses.bitAdapter),
    name: "Bittensor adapter",
    calls: {
      fundReserve: {
        senders: "anyone",
        effect: () => `adds the TAO it carries to the Bittensor adapter's native reserve (its target ${tao(FUNDING_V32.reserveTarget)} TAO; anything above it is the treasury's, sweepSurplus)`,
        maxValue: FUNDING_V32.adapterReserve,
      },
      fundCushion: {
        senders: "anyone",
        effect: (_f, fn) =>
          `pulls ${tao(BigInt(fn.args[0]?.value ?? "0"))} FM-TAO from the sender (the approve before it allows it) and books it in the Bittensor adapter's token cushion (tokenCushion; its target ${tao(FUNDING_V32.tokenReserveTarget)} FM-TAO)`,
      },
    },
    abi,
  };
}

/** ERC-20's approve, as the bridged token's ABI the page holds a call to it to (no build of ours has the token's). */
const TOKEN_ABI: Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
];
const APPROVE = toFunctionSelector("approve(address,uint256)");

/** The Bittensor adapter's bridged token (its token(), read when the page is served: what fundCushion pulls), for its one
 * call the page sends (merge 7b, R4 F-1): approve(spender, amount) from anyone, which the page sends only with the
 * record's Bittensor adapter as the spender and for at most the cushion's target (prepareSignV32's own check). */
function knownTokenV32(rec: DeploymentRecordV32, token: Address): KnownContract {
  return {
    chainId: chainIdFor(rec, "bittensor"),
    address: getAddress(token),
    name: "FM-TAO token",
    calls: {
      approve: {
        senders: "anyone",
        effect: (_f, fn) => `lets ${fn.args[0]?.value ?? ""}, the Bittensor adapter, take up to ${tao(BigInt(fn.args[1]?.value ?? "0"))} FM-TAO from the sender, for its token cushion (fundCushion, the next call)`,
      },
    },
    abi: TOKEN_ABI,
  };
}

/** The setter `inner` calls on `c`, decoded with the contract's own ABI: its function, its arguments by name and in
 * order, and whether the calldata is their exact encoding, one word each. */
function setterIn(abi: Abi, inner: Hex): { f?: AbiFunction; args: Record<string, unknown>; values: unknown[]; exact: boolean } {
  const f = abi.find((x): x is AbiFunction => x.type === "function" && toFunctionSelector(x) === inner.slice(0, 10).toLowerCase());
  if (!f) return { args: {}, values: [], exact: false };
  const d = decodeSetter(abi, inner);
  const values = f.inputs.map((p, i) => d.args[p.name || `arg${i}`]);
  return { f, args: d.args, values, exact: d.canonical && inner.length === 10 + 64 * f.inputs.length };
}

const signatureOf = (f: AbiFunction) => `${f.name}(${f.inputs.map((p) => p.type).join(",")})`;
const argLines = (f: AbiFunction, values: readonly unknown[]) => f.inputs.map((p, i) => `${p.name || `arg${i}`} (${p.type}) = ${argText(values[i])}`);

/** A file for a v3.2 deployment, checked against its record, its frozen build and the chains now: the page's view, and
 * what its server answers (the re-checks before a send, the stamps' signatures). */
export async function prepareSignV32(file: WalletFile, rec: DeploymentRecordV32, deps: SignV32Deps, now: number): Promise<{ view: WalletView; api: PageApi }> {
  if (!rec.build?.dir || !rec.build?.hash) throw new Error("the deployment record names no frozen build, which a v3.2 record holds from its start; nothing served");
  const ctx = deps.ctx;
  const o = { buildsDir: deps.buildsDir };
  // R4 (D-L4): the guardian's emergency pause from an offline file is served with no chain read
  if (file.offline) return offlineV32(file, rec, o.buildsDir, now);
  // only the chains the file names (Task 49's review, M7): a Bittensor-only stamp, cancel or pause is not held up by Base
  const named = CONTRACTS.filter((c) => [...file.calls, ...(file.stamps ?? [])].some((x) => x.chainId === chainIdFor(rec, NAMES[c].chain)));
  try {
    await checkChains(ctx, named.map((c) => NAMES[c].chain));
  } catch (e) {
    throw new Error(`${pageText(e)}; nothing served`);
  }
  const build = loadBuildV32(rec.build, o.buildsDir);
  const roles: Record<SchedulerContract, Roles> = { vault: { problem: "not read" }, frontDoor: { problem: "not read" } };
  for (const c of named) roles[c] = await rolesOf(ctx, rec, c, o.buildsDir);
  if (file.stamps) return stampsV32(file, rec, deps, roles);
  // merge 7b (R4, F-1): a file with an approve (pnpm ops fund-cushion's) names the adapter's bridged token, read now:
  // the one token the page sends an approve to
  const known = [knownV32(rec, "vault", roles.vault, abiOf(build, "vault")), knownV32(rec, "frontDoor", roles.frontDoor, abiOf(build, "frontDoor")), knownAdapterV32(rec, build.contracts.CcipBittensorAdapter.abi)];
  if (file.calls.some((c) => c.data.slice(0, 10).toLowerCase() === APPROVE)) {
    let token: Address;
    try {
      token = getAddress((await read(ctx.rpc, "bittensor", { address: getAddress(rec.plan.addresses.bitAdapter), abi: build.contracts.CcipBittensorAdapter.abi, functionName: "token" })) as Address);
    } catch (e) {
      throw new Error(`the Bittensor adapter's token() could not be read (${firstLine(e)}): the page sends an approve only to it; nothing served`);
    }
    known.push(knownTokenV32(rec, token));
  }
  const view = checkCalls(file, known, now);
  // merge 7b (review M4): the cushion's calls only in the shape pnpm ops fund-cushion writes, so none goes alone, out of
  // order or repeated (each still checked on its own below)
  const cushion = view.calls.filter((c) => c.fn.name === "approve" || c.fn.name === "fundCushion");
  if (cushion.length) {
    const n = view.calls.length;
    const [a, b] = view.calls;
    const amountOf = (c: CallView) => BigInt(c.fn.args[c.fn.name === "approve" ? 1 : 0]?.value ?? "0");
    const why = !file.ordered
      ? "this file isn't ordered"
      : n !== 2
        ? `this file holds ${n} call${n === 1 ? "" : "s"}`
        : a.fn.name !== "approve" || b.fn.name !== "fundCushion"
          ? `its calls are ${a.fn.name}() then ${b.fn.name}()`
          : amountOf(a) !== amountOf(b)
            ? `the approve is for ${tao(amountOf(a))} FM-TAO and fundCushion for ${tao(amountOf(b))}`
            : undefined;
    if (why) throw new Error(`the token cushion's calls go only as pnpm ops fund-cushion writes them: one ordered file of two calls, approve then fundCushion of the same amount (${why}); nothing served`);
  }
  for (const c of named) {
    const p = roles[c].problem;
    if (p !== undefined) view.warnings.push(`Couldn't read the ${NAMES[c].name}'s owner and guardian on ${NAMES[c].short} now (${p}): its calls are checked against the deployment record's roles only.`);
  }
  // each scheduler's items, read once when the page is served
  const items = new Map<SchedulerContract, Promise<PendingItem[]>>();
  const itemsOf = (c: SchedulerContract): Promise<PendingItem[]> => {
    let p = items.get(c);
    if (!p) {
      p = pendingOn(ctx, rec, c, o);
      p.catch(() => undefined);
      items.set(c, p);
    }
    return p;
  };
  const checks = new Map<number, () => Promise<PageAnswer>>();
  // for the rails (Task 47b's fix round): each scheduled call's kind, and each pending item an execute of the file runs
  const kinds = new Map<number, PendingItem["kind"]>();
  const executes = new Map<number, PendingItem>();
  const contractOf = (cv: CallView): SchedulerContract => (cv.chainId === chainIdFor(rec, "bittensor") && same(cv.to, rec.plan.addresses.vault) ? "vault" : "frontDoor");
  /** The role of `from` on `c`: the owner, else the guardian (checkCalls let nothing else through). */
  const roleOf = (c: SchedulerContract, from: Address): "owner" | "guardian" => (same(from, roles[c].owner ?? rec.plan.roles.owner) ? "owner" : "guardian");
  const ownerOf = (c: SchedulerContract): Address => roles[c].owner ?? getAddress(rec.plan.roles.owner);
  /** The Safe warning for caps above the founder level (capsWarning, ruling B7a): the owner's kind read only above it. */
  const capsWarnings = async (c: SchedulerContract, caps: { depositCap?: bigint; maxTotalAssets?: bigint }): Promise<string[]> => {
    if (capsWarning(caps, { kind: "account" }) === null) return [];
    let kind: OwnerKind | undefined;
    try {
      kind = await ownerKindOf(ctx, NAMES[c].chain, ownerOf(c));
    } catch {
      kind = undefined;
    }
    const w = capsWarning(caps, kind);
    return w ? [w.split("\n").join(" ").replace(/^WARNING: /, "")] : [];
  };
  /** A chain the file doesn't name was never checked by the page: its RPC's chain id, once, before its copy is read (Task 49's
   * re-review, N1: a stale fork with the same addresses would answer "not pending there", and the twin's warning would be
   * lost). Throws, as an unread copy, when it answers another chain's id. */
  const idChecks = new Map<SchedulerContract, Promise<void>>();
  const chainChecked = (c: SchedulerContract): Promise<void> => {
    if (named.includes(c)) return Promise.resolve();
    let p = idChecks.get(c);
    if (!p) {
      const chain = NAMES[c].chain;
      p = chainIdOf(ctx.rpc, chain).then((id) => {
        if (id !== ctx.targets[chain].chainId) throw new Error(`the RPC reports chain id ${id}, not ${ctx.targets[chain].chainId}`);
      });
      p.catch(() => undefined);
      idChecks.set(c, p);
    }
    return p;
  };
  /** Each chain's copy of item `id`, and which call of this file stops or runs it. */
  const copies = async (id: Hex, fn: "execute" | "cancel", self: number): Promise<{ lines: string[]; unhandled: SchedulerContract[]; unread: { c: SchedulerContract; why: string }[] }> => {
    const lines: string[] = [];
    const unhandled: SchedulerContract[] = [];
    const unread: { c: SchedulerContract; why: string }[] = [];
    for (const c of CONTRACTS) {
      let found: PendingItem | undefined;
      try {
        await chainChecked(c);
        found = (await itemsOf(c)).find((x) => same(x.id, id));
      } catch (e) {
        lines.push(`${where(c)}: couldn't be read right now (${firstLine(e)})`);
        unread.push({ c, why: firstLine(e) });
        continue;
      }
      const j = view.calls.findIndex((x) => x.fn.name === fn && contractOf(x) === c && same(fn === "cancel" ? x.fn.args[0]?.value : keccak256(innerOf(x.data)), id));
      const which = j === self ? " (this call)" : j >= 0 ? ` (call ${j + 1} in this file)` : "";
      if (!found) lines.push(`${where(c)}: not pending there`);
      else {
        lines.push(`${where(c)}: ${stateOf(found)}${which}`);
        if (j < 0) unhandled.push(c);
      }
    }
    return { lines, unhandled, unread };
  };
  for (const [i, cv] of view.calls.entries()) {
    const fail = (why: string) => new Error(`call ${i + 1}: ${why}`);
    // the adapter's fundReserve() (checkCalls held its value to its cap): nothing of the schedulers' to read
    if (cv.fn.name === "fundReserve") continue;
    // merge 7b (R4, F-1): the cushion's funding, pnpm ops fund-cushion's two calls: the approve only for the record's
    // Bittensor adapter (checkCalls held it to the adapter's own token), and each amount at most the cushion's target,
    // what an empty cushion lacks; nothing of the schedulers' to read
    if (cv.fn.name === "approve" || cv.fn.name === "fundCushion") {
      const amount = BigInt(cv.fn.args[cv.fn.name === "approve" ? 1 : 0]?.value ?? "0");
      const spender = cv.fn.args[0]?.value ?? "";
      if (cv.fn.name === "approve" && !same(spender, rec.plan.addresses.bitAdapter)) {
        throw fail(`approve() names ${spender} as its spender, not the record's Bittensor adapter ${getAddress(rec.plan.addresses.bitAdapter)}: the page approves FM-TAO only for the adapter's token cushion`);
      }
      if (amount > FUNDING_V32.tokenReserveTarget) throw fail(`${cv.fn.name}() is for ${tao(amount)} FM-TAO, more than the token cushion's ${tao(FUNDING_V32.tokenReserveTarget)} FM-TAO target`);
      continue;
    }
    const c = contractOf(cv);
    const { name, short } = NAMES[c];
    const abi = abiOf(build, c);
    const details: CallDetail[] = [];
    const warnings: string[] = [];
    switch (cv.fn.name) {
      case "schedule": {
        const inner = innerOf(cv.data);
        const s = setterIn(abi, inner);
        if (!s.f) throw fail(`schedule(${inner.slice(0, 10)}) is not a call to a function of ${where(c)}: refusing calldata the page can't decode`);
        if (!SCHEDULED_V32[c].some((x) => x.fn === s.f?.name)) throw fail(`${where(c)}'s scheduler doesn't take ${s.f.name}(): refusing a schedule it would revert`);
        if (!s.exact) throw fail(`schedule(${s.f.name}) carries calldata that is not the exact encoding of its arguments, one word each: refusing calldata the contract would read differently`);
        const read = async <T>(get: () => Promise<T>): Promise<T> => {
          try {
            return await get();
          } catch (e) {
            throw fail(pageText(e));
          }
        };
        const { cls, kind } = await read(() => classOf(ctx, rec, c, s.f!.name, s.values, o));
        kinds.set(i, kind);
        const delay = (await read(() => delaysOf(ctx, rec, c, o)))[cls];
        const window = Number(await read(() => (c === "vault" ? readVault(ctx, rec, "EXECUTE_WINDOW", [], o.buildsDir) : readDoor(ctx, rec, "EXECUTE_WINDOW", [], o.buildsDir))));
        const head = await read(() => headOf(ctx, NAMES[c].chain));
        // half its delay in the contract's calibrated blocks (CascadeBase._halfInBlocks, Revision 28): its own MS_PER_BLOCK,
        // as the pending list reads it (review M-5; verify holds it to the pin)
        const ms = Number(await read(() => (c === "vault" ? readVault(ctx, rec, "MS_PER_BLOCK", [], o.buildsDir) : readDoor(ctx, rec, "MS_PER_BLOCK", [], o.buildsDir))));
        const blocks = halfInBlocks(delay, ms);
        // it lapses only past both its window in time and its window in blocks (half EXECUTE_WINDOW in calibrated blocks
        // after its readyBlock): it can run until the later of the two, the blocks' told at the chain's block time
        const lastBlock = head.block + blocks + halfInBlocks(window, ms);
        const blockS = await blockTimeOf(ctx.rpc, NAMES[c].chain, { block: BigInt(head.block), time: head.time }).catch(() => undefined);
        const byTime = head.time + delay + window;
        const byBlocks = blockS === undefined ? undefined : head.time + Math.ceil((lastBlock - head.block) * blockS);
        const until = byBlocks === undefined
          ? `until ${iso(byTime)} or block ${lastBlock.toLocaleString("en-US")}, whichever is later`
          : byBlocks > byTime
            ? `until about ${iso(byBlocks)} (block ${lastBlock.toLocaleString("en-US")}: its blocks come slower than its time)`
            : `until ${iso(byTime)}`;
        const text = itemText({ fn: s.f.name, args: s.args, selector: inner.slice(0, 10) as Hex });
        cv.heading = `schedule(${text}) on the ${name} (${short})`;
        cv.effect = `schedule(${text}): starts its ${asWord(delay)} wait before ${s.f.name} can run on the ${name}; nothing changes until it is executed`;
        details.push(
          { name: "Scheduled call", lines: [signatureOf(s.f), ...argLines(s.f, s.values)] },
          { name: "Item", lines: [`${keccak256(inner)} (keccak256 of the scheduled call)`] },
          { name: "Kind", lines: [`${kind}: ${cancellers(kind)} can cancel it`] },
          { name: "Class", lines: [`${cls}: it waits ${span(delay)}`] },
          {
            name: "Ready",
            lines: [
              `${span(delay)} and ${blocks.toLocaleString("en-US")} blocks after it lands. If it lands now: from ${iso(head.time + delay)} and block ${(head.block + blocks).toLocaleString("en-US")}, then it can run for ${span(window)}, ${until}.`,
            ],
          },
          {
            name: "Dies",
            lines: [
              kind === "Ordinary"
                ? "A closure by the owner or the guardian, or an owner stamp, dated at or after the second it lands kills it: schedule it after the asOf of the last stamp you signed."
                : "A closure by the owner, or an owner stamp, dated at or after the second it lands kills it: schedule it after the asOf of the last stamp you signed.",
            ],
          },
        );
        const item = { contract: c, fn: s.f.name, args: s.args };
        try {
          details.push({ name: "Changes", lines: looseningLines(looseningOf(item, await currentValues(ctx, rec, item, o))).map((x) => x.trim()) });
        } catch (e) {
          details.push({ name: "Changes", lines: [`Whether it loosens a limit couldn't be read right now (${firstLine(e)}).`] });
        }
        if (c === "vault" && s.f.name === "setMaxTotalAssets") warnings.push(...(await capsWarnings(c, { maxTotalAssets: s.values[0] as bigint })));
        break;
      }
      case "execute": {
        const inner = innerOf(cv.data);
        const s = setterIn(abi, inner);
        if (!s.f) throw fail(`execute(${inner.slice(0, 10)}) is not a call to a function of ${where(c)}: refusing calldata the page can't decode`);
        const id = keccak256(inner);
        let list: PendingItem[];
        try {
          list = await itemsOf(c);
        } catch (e) {
          throw fail(
            e instanceof HistoryMissing
              ? `${where(c)}'s scheduled items couldn't be read: ${firstLine(e)}. An item is executed only once it is read pending and alive`
              : `${where(c)}'s scheduled items couldn't be read right now (${firstLine(e)}): an item is executed only once it is read pending and alive; try again`,
          );
        }
        const item = list.find((x) => same(x.id, id));
        if (!item) throw fail(`no item ${id} is pending on ${where(c)} now (it ran, was cancelled, lapsed or was never scheduled): the page executes only a live pending item`);
        let expected: ReturnType<typeof executeCall>;
        try {
          expected = executeCall(item);
        } catch (e) {
          throw fail(pageText(e));
        }
        if (expected.data !== cv.data.toLowerCase() || !same(expected.to, cv.to) || expected.chainId !== cv.chainId) throw fail(`the file's execute is not item ${id}'s own call: refusing it`);
        if (!same(expected.from, cv.from)) throw fail(`it comes from ${cv.from}, but item ${id}'s owner now is ${expected.from}`);
        // R6 (ChatGPT R2 claim C): a write-off's execute goes with its own gas limit (checkCalls refused one with none)
        if (cv.gas !== expected.gas) {
          throw fail(`it sets a gas limit of ${Number(cv.gas).toLocaleString("en-US")}, not the ${Number(expected.gas ?? 0).toLocaleString("en-US")} a write-off's execute goes with`);
        }
        // ... and only while it is at most the missing stake less the unlisted, read now, and again just before it is sent
        if (isWriteOff(item)) {
          let fits: { amount: bigint; most: bigint };
          try {
            fits = await writeOffStillFits(ctx, rec, item, o.buildsDir);
          } catch (e) {
            throw fail(pageText(e));
          }
          details.push({ name: "Checked", lines: [`The write-off is at most the missing stake less the unlisted, read now: ${fits.amount} rao of ${fits.most}. The page checks again just before it sends.`] });
          cv.recheck = "that the write-off is still at most the missing stake less the unlisted (pnpm ops execute's check)";
          checks.set(i, async () => {
            try {
              const f = await writeOffStillFits(ctx, rec, item, o.buildsDir);
              return { ok: true, text: `Checked again just now: the write-off is at most the missing stake less the unlisted (${f.amount} rao of ${f.most}).` };
            } catch (e) {
              return { ok: false, text: pageText(e) };
            }
          });
        }
        const text = itemText(item);
        cv.heading = `execute(${text}) on the ${name} (${short})`;
        cv.effect = `execute(${text}): runs item ${item.id} on the ${name} now, and ${s.f.name} takes effect at once`;
        details.push(
          { name: "Item", lines: [item.id] },
          { name: "Scheduled call", lines: [signatureOf(s.f), ...argLines(s.f, s.values)] },
          { name: "Kind", lines: [`${item.kind}: ${cancellers(item.kind)} can cancel it`] },
          { name: "Class", lines: [item.class ?? "unknown"] },
          { name: "Scheduled", lines: [iso(item.scheduledAt)] },
          { name: "Ready", lines: [`since ${iso(item.readyAt)} and block ${item.readyBlock.toLocaleString("en-US")}; it can run until ${untilText(item)}`] },
          { name: "Now", lines: [stateOf(item)] },
          { name: "Copies", lines: (await copies(item.id, "execute", i)).lines },
        );
        try {
          const l = looseningOf(item, await currentValues(ctx, rec, item, o));
          details.push({ name: "Changes", lines: looseningLines(l).map((x) => x.trim()) });
          if (l.loosens) {
            const changed = l.fields.filter((f) => !same(f.now, f.then));
            warnings.push(`It loosens a limit when it runs: ${changed.map((f) => `${f.name}: ${valueText(f.name, f.now)} now, ${valueText(f.name, f.then)} then${f.loosens ? " (loosens)" : ""}`).join("; ")}.`);
          }
        } catch (e) {
          warnings.push(`Whether it loosens a limit couldn't be read right now (${firstLine(e)}).`);
        }
        if (item.fn === "transferOwnership") {
          details.push({
            name: "Then",
            lines: [`The new owner must then accept within ${span(item.windowEnd - item.readyAt)}, while the exits stay open and before any closure or owner stamp: run this only once the new owner is ready to accept.`],
          });
        }
        if (c === "vault" && item.fn === "setMaxTotalAssets") warnings.push(...(await capsWarnings(c, { maxTotalAssets: s.values[0] as bigint })));
        if (item.fn === "activateBridge") executes.set(i, item);
        break;
      }
      case "cancel": {
        const id = cv.fn.args[0].value as Hex;
        let list: PendingItem[] | undefined;
        try {
          list = await itemsOf(c);
        } catch (e) {
          warnings.push(`What it drops couldn't be read right now (${firstLine(e)}): it drops item ${id} if ${where(c)} holds one.`);
        }
        const item = list?.find((x) => same(x.id, id));
        if (list && !item) throw fail(`no item ${id} is pending on ${where(c)} now: nothing to cancel`);
        if (item) {
          try {
            cancelCall(item, roleOf(c, cv.from));
          } catch (e) {
            throw fail(pageText(e));
          }
          cv.effect = `cancel(${item.id}): drops ${itemText(item)} from the ${name}'s scheduler, so it never runs here`;
          details.push({ name: "Drops", lines: [`${itemText(item)}: ${item.kind}${item.class ? `, ${item.class}` : ""}; now ${stateOf(item)}`] });
        }
        // the other chain's copy, read even when this chain's could not be (Task 49's review, M4)
        const both = await copies(id, "cancel", i);
        details.push({ name: "Copies", lines: both.lines });
        for (const other of both.unhandled.filter((x) => x !== c)) {
          warnings.push(`Item ${id} is pending on ${where(other)} too, and this file doesn't cancel that copy: it still runs there.`);
        }
        for (const u of both.unread.filter((x) => x.c !== c)) {
          warnings.push(`${where(u.c)} couldn't be read right now (${u.why}): item ${id} may be pending there too, and this file doesn't cancel it there.`);
        }
        break;
      }
      case "removeFrontDoor": {
        const chain = BigInt(cv.fn.args[0].value);
        const door = getAddress(cv.fn.args[1].value);
        const as = roleOf("vault", cv.from);
        const guard = async () => {
          const g = await removeDoorGuard(ctx, rec, { buildsDir: o.buildsDir, chain, door, as });
          if (!same(g.from, cv.from) || g.data.toLowerCase() !== cv.data) throw new Error(`the vault's ${as} now is ${g.from}, and this call comes from ${cv.from}: refusing it`);
          return g;
        };
        let head: bigint;
        try {
          head = (await guard()).head;
        } catch (e) {
          throw fail(pageText(e));
        }
        details.push({
          name: "Checked",
          lines: [`No payout batch of the door is queued on the vault and no park from it is outstanding, as of Bittensor block ${head}. The page checks again just before it sends.`],
        });
        if (as === "owner") warnings.push("This removal is the owner's: the door then stays Reopen-able by the owner alone, without the guardian's veto. A removal meant to last is the guardian's.");
        try {
          const launch = BigInt((await readVault(ctx, rec, "launchChain", [], o.buildsDir)) as bigint);
          const active = BigInt((await readVault(ctx, rec, "activeDoors", [chain], o.buildsDir)) as bigint);
          const peer = keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }], [chain, door]));
          const state = Number(await readVault(ctx, rec, "doorState", [peer], o.buildsDir));
          // CascadeTypes.DoorState.Active
          if (chain === launch && active === 1n && state === 1) {
            warnings.push(`It is the launch chain's last active door: removing it closes the exits, and ${kills(as)}`);
          }
          // the rare one (Task 49's re-review, N4; Task 10b): the guardian's removal of an owner-removed (DoorState.Removed)
          // launch-chain door while the launch door's hold is the owner's (Actor.Owner) makes that hold the guardian's,
          // and stamps the guardian's clock
          else if (chain === launch && as === "guardian" && state === 2 && Number(await readVault(ctx, rec, "launchDoorRemovedBy", [], o.buildsDir)) === 1) {
            warnings.push(`The owner removed this launch-chain door and the exits' hold is the owner's: the guardian's removal makes that hold the guardian's, and ${kills("guardian")}`);
          }
        } catch (e) {
          warnings.push(`Whether it is the launch chain's last active door, whose removal stamps the ${as}'s clock, couldn't be read right now (${firstLine(e)}).`);
        }
        const dw = await doorWarning(ctx, rec, door, o);
        if (dw) warnings.push(dw.replace(/^\s*WARNING — /, ""));
        cv.recheck = "that no payout batch of the door is queued and no park from it is outstanding (pnpm ops remove-door's guard)";
        checks.set(i, async () => {
          try {
            const g = await guard();
            return { ok: true, text: `Checked again just now: no payout batch of the door is queued and no park from it is outstanding (Bittensor block ${g.head}).` };
          } catch (e) {
            return { ok: false, text: pageText(e) };
          }
        });
        break;
      }
      case "disableBridge": {
        try {
          const primary = c === "vault" ? await readVault(ctx, rec, "primaryBridge", [], o.buildsDir) : await readDoor(ctx, rec, "primaryBridge", [], o.buildsDir);
          if (same(primary, cv.fn.args[0].value)) {
            warnings.push(
              `It is the ${name}'s primary bridge: disabling it closes the exits on ${short} and stamps the ${roleOf(c, cv.from)}'s clock, until the owner makes another enabled bridge the primary (setPrimaryBridge).`,
            );
          }
        } catch (e) {
          warnings.push(`Whether it is the ${name}'s primary bridge couldn't be read right now (${firstLine(e)}): disabling the primary closes the exits on ${short}.`);
        }
        break;
      }
      case "setCaps":
        warnings.push(...(await capsWarnings("frontDoor", { depositCap: BigInt(cv.fn.args[1].value) })));
        break;
      // the calls that stamp a clock (Task 49's review, M6): the vault's pause, by whoever pauses (CascadeVault.pause);
      // a cancel of the launch door's payout batch, the owner's (spec §5)
      case "pause":
        if (c === "vault") warnings.push(`Pausing the Vault: ${kills(roleOf(c, cv.from))}`);
        break;
      case "cancelPayoutBatch":
        try {
          const batch = (await readVault(ctx, rec, "getPayoutBatch", [cv.fn.args[0].value], o.buildsDir)) as { sourceChain: bigint };
          const launch = BigInt((await readVault(ctx, rec, "launchChain", [], o.buildsDir)) as bigint);
          if (BigInt(batch.sourceChain) === launch) warnings.push(`It is the launch door's batch, so ${kills("owner")}`);
        } catch (e) {
          warnings.push(`Whether it is the launch door's batch, whose cancel stamps the owner's clock, couldn't be read right now (${firstLine(e)}).`);
        }
        break;
      case "setMaxTotalAssets":
        warnings.push(...(await capsWarnings("vault", { maxTotalAssets: BigInt(cv.fn.args[0].value) })));
        break;
      // Task 53's fix round: only a raise is a direct call (CascadeVault.setIdleBuffer: a lowering must be scheduled)
      case "setIdleBuffer": {
        const bps = BigInt(cv.fn.args[0].value);
        let now: bigint;
        try {
          now = BigInt((await readVault(ctx, rec, "idleBufferBps", [], o.buildsDir)) as number | bigint);
        } catch (e) {
          throw fail(`the Vault's idleBufferBps couldn't be read right now (${firstLine(e)}): a raise is sent only once it is read; try again`);
        }
        if (bps < now) throw fail(`setIdleBuffer(${bps}) would lower the Vault's idle buffer (${now} now): a lowering is a scheduled item (pnpm ops schedule vault setIdleBuffer ${bps} --for-wallet --live), never a direct call`);
        cv.effect = `setIdleBuffer(${bps}): raises the Vault's idleBufferBps from ${now} to ${bps} at once (a lowering waits 48 hours, scheduled)`;
        break;
      }
      // R5 Minor 3: within MIN_CLAIM_GAS and MAX_CLAIM_GAS, or the vault would refuse it
      case "setClaimGasRequired": {
        const gas = BigInt(cv.fn.args[0].value);
        const n = (x: bigint) => x.toLocaleString("en-US");
        const bounds = `${n(BOUNDS_V32.minClaimGas)} to ${n(BOUNDS_V32.maxClaimGas)}`;
        if (gas < BOUNDS_V32.minClaimGas || gas > BOUNDS_V32.maxClaimGas) throw fail(`setClaimGasRequired(${gas}) is outside the Vault's bounds, ${bounds} (MIN_CLAIM_GAS and MAX_CLAIM_GAS): the Vault would refuse it`);
        let now: bigint;
        try {
          now = BigInt((await readVault(ctx, rec, "claimGasRequired", [], o.buildsDir)) as bigint);
        } catch (e) {
          throw fail(`the Vault's claimGasRequired couldn't be read right now (${firstLine(e)}): try again`);
        }
        cv.effect = `setClaimGasRequired(${gas}): moves the Vault's claimGasRequired from ${n(now)} to ${n(gas)} at once (immediate either way, within ${bounds})`;
        break;
      }
    }
    if (details.length) cv.details = details;
    if (warnings.length) cv.callWarnings = warnings;
  }
  // the rails (Task 47b), once this file and the pending items run and right after its calls that take effect at once,
  // in the file's order (its worst when it fixes none: Task 47b's fix round): a row on each call on the bridges, an
  // activation's execute among them, and a warning
  const planned: RailChange[] = [];
  const railCalls: CallView[] = [];
  for (const [i, cv] of view.calls.entries()) {
    const c = contractOf(cv);
    if (cv.fn.name === "disableBridge" || cv.fn.name === "setPrimaryBridge") {
      planned.push({ contract: c, fn: cv.fn.name, bridge: getAddress(cv.fn.args[0].value), source: "planned", ...(cv.fn.name === "disableBridge" ? { by: roleOf(c, cv.from) } : {}) });
      railCalls.push(cv);
    } else if (cv.fn.name === "schedule") {
      const s = setterIn(abiOf(build, c), innerOf(cv.data));
      if (s.f?.name === "activateBridge") {
        const kind = kinds.get(i);
        planned.push({ contract: c, fn: "activateBridge", bridge: getAddress(s.values[0] as Address), source: "planned", ...(kind ? { kind } : {}) });
        railCalls.push(cv);
      }
    } else if (cv.fn.name === "execute") {
      const item = executes.get(i);
      if (item) {
        planned.push({ contract: c, fn: "activateBridge", bridge: getAddress(item.args.bridge as Address), source: "executed", id: item.id, kind: item.kind });
        railCalls.push(cv);
      }
    }
  }
  if (planned.length) {
    const rails = await railsForPage(ctx, rec, planned, { buildsDir: o.buildsDir, ordered: file.ordered, ...(file.oneSided !== undefined ? { oneSided: file.oneSided } : {}) });
    for (const cv of railCalls) cv.details = [...(cv.details ?? []), { name: "Rails", lines: rails.lines }];
    view.warnings.push(...rails.warnings);
  }
  if (file.oneSided !== undefined) view.warnings.push(`This file was written one-sided, past the rail check (pnpm ops schedule --one-sided), for this reason: "${file.oneSided}".`);
  return {
    view,
    api: {
      check: async (i) => checks.get(i)?.() ?? { ok: false, text: `call ${i + 1} is not in this file, or has nothing to check again` },
      stamp: async () => ({ ok: false, text: "this file holds no stamps" }),
    },
  };
}

/** R4 (D-L4): a file marked offline (pnpm ops pause --for-wallet --offline), served with no chain read, for an incident in
 * which ops' RPC for a chain is down while MetaMask's own network still carries the call: only while every call is pause()
 * on the record's vault or front door, at the record's chain id, from the record's guardian or owner (anything else is
 * refused, nothing served); each checked against the record's roles alone (checkCalls), its warnings as the page's own,
 * and the page says what was not read. */
function offlineV32(file: WalletFile, rec: DeploymentRecordV32, buildsDir: string | undefined, now: number): { view: WalletView; api: PageApi } {
  const build = loadBuildV32(rec.build, buildsDir);
  const pause = toFunctionSelector("pause()");
  const roles = [rec.plan.roles.guardian, rec.plan.roles.owner];
  const only = "an offline file serves pause() alone; nothing served";
  for (const [i, cv] of file.calls.entries()) {
    const c = CONTRACTS.find((x) => cv.chainId === chainIdFor(rec, NAMES[x].chain) && same(cv.to, rec.plan.addresses[x]));
    if (!c) throw new Error(`call ${i + 1} is sent to ${getAddress(cv.to)}, not the record's vault or front door: ${only}`);
    if (cv.data.toLowerCase() !== pause.toLowerCase()) {
      let fn = "a call the page can't decode";
      try {
        fn = `${decodeFunctionData({ abi: abiOf(build, c), data: cv.data }).functionName}()`;
      } catch {
        // named as one the page can't decode
      }
      throw new Error(`call ${i + 1} is ${fn} on ${where(c)}: ${only}`);
    }
    if (!roles.some((r) => same(r, cv.from))) throw new Error(`call ${i + 1} comes from ${getAddress(cv.from)}, not the record's guardian or owner: ${only}`);
  }
  const unread: Roles = { problem: "an offline file: nothing is read" };
  const view = checkCalls(file, [knownV32(rec, "vault", unread, abiOf(build, "vault")), knownV32(rec, "frontDoor", unread, abiOf(build, "frontDoor"))], now);
  for (const cv of view.calls) {
    if (same(cv.to, rec.plan.addresses.vault)) cv.callWarnings = [`Pausing the Vault: ${kills(same(cv.from, rec.plan.roles.owner) ? "owner" : "guardian")}`];
  }
  view.warnings.push(
    "An offline file: nothing was read from the chains, when it was written or now. Its contracts, chain ids and sender are the deployment record's, and MetaMask sets the gas and fees over its own network. If the guardian has changed since, MetaMask won't send it from the old account, or the call reverts.",
  );
  return {
    view,
    api: {
      check: async (i) => ({ ok: false, text: `call ${i + 1} has nothing to check again: an offline file is served with no chain read` }),
      stamp: async () => ({ ok: false, text: "this file holds no stamps" }),
    },
  };
}

/** A file of stamps, each checked when the page is served: for this deployment's vault on Bittensor or its front door
 * on Base, to be signed by the owner the contract names now, over the contract's own DOMAIN_SEPARATOR and
 * STAMP_TYPEHASH, and still in its window by the chain's head (a stack's may be for later). The typed data the page asks
 * MetaMask to sign is ops's own (stampTypedDataJson). */
async function stampsV32(file: WalletFile, rec: DeploymentRecordV32, deps: SignV32Deps, roles: Record<SchedulerContract, Roles>): Promise<{ view: WalletView; api: PageApi }> {
  const sink = deps.stamps;
  if (!sink) throw new Error("this run can't hand a signed stamp on (no relay path): run pnpm ops sign from the CLI");
  const ctx = deps.ctx;
  const stamps: (StampView & { target: SchedulerContract })[] = [];
  for (const [i, s] of (file.stamps ?? []).entries()) {
    const fail = (why: string) => new Error(`stamp ${i + 1}: ${why}`);
    const c = CONTRACTS.find((x) => chainIdFor(rec, NAMES[x].chain) === s.chainId && same(rec.plan.addresses[x], s.contract));
    if (!c) {
      throw fail(
        `${getAddress(s.contract)} on ${WALLET_CHAINS[s.chainId].name} (chain id ${s.chainId}) is not this deployment's vault on Bittensor (964) nor its front door on Base (8453): refusing to ask for a stamp for it`,
      );
    }
    const { chain, name, short } = NAMES[c];
    const r = roles[c];
    if (!r.owner) throw fail(`${where(c)}'s owner couldn't be read right now (${r.problem}); try again`);
    if (!same(s.from, r.owner)) throw fail(`it is to be signed by ${getAddress(s.from)}, but ${where(c)}'s owner now is ${r.owner}: a stamp counts only when the owner signs it`);
    const contract = getAddress(s.contract);
    const asOf = BigInt(s.asOf);
    const lens = async (fn: "DOMAIN_SEPARATOR" | "STAMP_TYPEHASH") => {
      try {
        return (await (c === "vault" ? readVault(ctx, rec, fn, [], deps.buildsDir) : readDoor(ctx, rec, fn, [], deps.buildsDir))) as Hex;
      } catch (e) {
        throw fail(`${where(c)}'s ${fn} couldn't be read right now (${firstLine(e)}); try again`);
      }
    };
    const want = stampHashes(s.chainId, contract, 0n).domainHash;
    const domain = await lens("DOMAIN_SEPARATOR");
    if (!same(domain, want)) {
      throw fail(`${where(c)}'s DOMAIN_SEPARATOR is ${domain}, not ${want}, the one ops computes for chain ${s.chainId} and ${contract}: a stamp signed for it would be over the wrong hash`);
    }
    const type = await lens("STAMP_TYPEHASH");
    if (!same(type, STAMP_TYPEHASH)) throw fail(`${where(c)}'s STAMP_TYPEHASH is ${type}, not keccak256("OwnerStamp(uint64 asOf)"): a stamp signed for it would be over the wrong hash`);
    let head: bigint;
    try {
      head = await headTime(ctx, chain);
    } catch (e) {
      throw fail(`${chainLabel(chain)}'s head couldn't be read right now (${firstLine(e)}); try again`);
    }
    if (s.mode === "relay") {
      const late = windowProblem(asOf, head, chain);
      if (late) throw fail(pageText(late));
    } else {
      if (head - asOf >= STAMP_MAX_TTL) {
        throw fail(`the stamp as of ${asOf} (${iso(Number(asOf))}) has expired by ${chainLabel(chain)}'s head (${iso(Number(head))}): write a new stack with pnpm ops stamp --stack <days>`);
      }
      // the stack it goes to, by --to-stack's own rules (Task 49's review, M2): no Ledger approval for a stamp it refuses
      let problem: string | null;
      try {
        problem = stackEntryProblem(sink.dir, rec, c, file.deployment ?? "", asOf);
      } catch (e) {
        problem = pageText(e);
      }
      if (problem) throw fail(problem);
    }
    const h = stampHashes(s.chainId, contract, asOf);
    const asOfText = iso(Number(asOf));
    stamps.push({
      ...s,
      contract,
      from: getAddress(s.from),
      target: c,
      network: WALLET_CHAINS[s.chainId].name,
      contractName: `${name} on ${short}`,
      heading: `The owner's stamp on the ${name} (${short}), as of ${asOfText}`,
      effect: `moves the owner's clock on the ${name} to ${asOfText}: every item scheduled there at or before then dies`,
      asOfText,
      domainHash: h.domainHash,
      messageHash: h.structHash,
      digest: h.digest,
      then:
        s.mode === "relay"
          ? "pnpm ops sign checks that it is the owner's signature, then relays it at once from the relayer (OPS_RELAYER_KEYSTORE), never from the Ledger"
          : `pnpm ops sign checks that it is the owner's signature, then adds it to the relayer's stack (ops/stamps/${chain}.json), which pnpm ops stamp --relay-due relays from its time`,
      // what the click does besides signing, said before it (Task 49's review, M1)
      click:
        s.mode === "relay"
          ? `This click also sends stampBySig to the ${name} on ${short} from the relayer account (OPS_RELAYER_KEYSTORE), once the Ledger has signed: the relayer pays its gas, never the Ledger.`
          : `This click sends nothing: it adds the signature to the relayer's stack (ops/stamps/${chain}.json), which relays it from its time.`,
      typedData: JSON.stringify(stampTypedDataJson(s.chainId, contract, asOf)),
    });
  }
  // the relayer's key named before anything is signed, for a stamp to relay
  for (const mode of new Set(stamps.map((s) => s.mode))) await sink.ready?.(mode);
  const n = stamps.length;
  const { stamps: _requests, calls: _calls, ...rest } = file;
  const view: WalletView = {
    ...rest,
    ordered: false,
    heading: `Cascade${file.deployment ? ` ${file.deployment}` : ""}: ${n} stamp${n === 1 ? "" : "s"} to sign with MetaMask`,
    calls: [],
    stamps: stamps.map(({ target: _t, ...v }) => v),
    warnings: [],
  };
  const handed = new Map<number, string>();
  return {
    view,
    api: {
      check: async (i) => ({ ok: false, text: `call ${i + 1} is not in this file, or has nothing to check again` }),
      stamp: async (i, sig) => {
        const s = stamps[i];
        if (!s) return { ok: false, text: `stamp ${i + 1} is not in this file` };
        const done = handed.get(i);
        if (done !== undefined) return { ok: false, text: `Already handed on: ${done}` };
        if (typeof sig !== "string") return { ok: false, text: "Not handed on: MetaMask gave no signature." };
        let n: Hex;
        try {
          n = normaliseSignature(sig);
        } catch (e) {
          return { ok: false, text: `Not handed on: ${pageText(e)}.` };
        }
        let by: Address;
        try {
          by = await recoverAddress({ hash: s.digest, signature: n });
        } catch {
          return { ok: false, text: "Not handed on: the signature recovers to no account." };
        }
        if (!same(by, s.from)) return { ok: false, text: `Not handed on: the signature is ${by}'s, not the owner ${s.from}'s. Check that MetaMask signed with the owner's Ledger account.` };
        // the signature is no secret (anyone may relay it, and it only kills items): said, so it need not be signed again
        const byHand = `To hand it on without signing again: pnpm ops stamp ${s.target === "vault" ? "vault" : "front-door"} --as-of ${s.asOf} --sig ${n}${s.mode === "stack" ? " --to-stack" : ""} --live`;
        try {
          const r = await sink.submit(rec, { target: s.target, asOf: BigInt(s.asOf), sig: n, mode: s.mode });
          const text = r.lines.join(" ");
          if (!r.ok) return { ok: false, text: `Signed by the owner, but not handed on: ${text} ${byHand}` };
          handed.set(i, text);
          return { ok: true, text: `Signed by the owner. ${text}` };
        } catch (e) {
          // sent, but not confirmed or reverted on chain (Task 49's review, M5): said as it is
          if (e instanceof ReceiptTimeout) {
            return {
              ok: false,
              text: e.hash
                ? `Signed by the owner and sent (transaction ${e.hash}), but not confirmed yet: check it on the explorer (${EXPLORERS[e.chain]}/tx/${e.hash}) before relaying it again.`
                : "Signed by the owner and sent, but not confirmed yet: check the relayer's latest transaction on the explorer before relaying it again.",
            };
          }
          if (e instanceof RevertedOnChain) return { ok: false, text: `Signed by the owner and sent (transaction ${e.hash}), but it reverted${e.reason ? ` (${e.reason})` : ""}. ${byHand}` };
          return { ok: false, text: `Signed by the owner, but not handed on: ${pageText(e).replace(/\.$/, "")}. ${byHand}` };
        }
      },
    },
  };
}
