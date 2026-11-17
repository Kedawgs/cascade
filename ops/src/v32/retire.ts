import { type Address, encodeAbiParameters, encodeFunctionData, getAddress, type Hex, hexToNumber, keccak256, numberToHex } from "viem";
import type { ChainName } from "../config.ts";
import { isRevert, read } from "../rpc.ts";
import { type Ctx, chainLabel, describeRevert } from "../send.ts";
import { type WalletCall, wroteLine } from "../wallet.ts";
import { buildErrorsV32, loadBuildV32 } from "./build.ts";
import { readDoor, readVault } from "./lens.ts";
import {
  ARCHIVE_NODE,
  ask,
  type BuildsOpt,
  checkChains,
  checkFailed,
  chainIdFor,
  type FileOpts,
  firstLine,
  HistoryMissing,
  headOf,
  historyMissing,
  iso,
  type PayoutBatchRead,
  proveBittensorHistory,
  type RecordV32,
  readNow,
  type SchedulerContract,
  type SchedulerCtx,
  scanEvents,
  tao,
  where,
  writeCalls,
} from "./scheduler.ts";

// v3.2's retirement guards (spec §3.2's ops rule; plan Task 46, dispatched as 46b): "never removeFrontDoor for a door
// with a park outstanding, and never retire an adapter pair until parkedNative == 0 && parkedTokens == 0", and a door is
// removed only once its payout queue has drained, carried bounces included (the T22 ruling). Two commands write the
// call files for the sign page, and each refuses before writing, with the reason and the amounts:
// - retire-pair: disableBridge of the record's adapter pair on both chains, one file (as pause both), while the
//   Bittensor adapter's parkedNative and parkedTokens are both 0;
// - remove-door: the vault's removeFrontDoor(chain, door), while the vault holds no payout batch of that door (any with
//   entries left, a cancel's carried bounces included) and the Bittensor adapter holds no park from it.
// A read the guard needs that fails refuses ("can't confirm it's safe right now"), never writes; the lists read from the
// logs are held to the contracts' own totals (pendingPayouts, parkedNative and parkedTokens), so logs read short refuse
// too. Each call is asked of its contract by eth_call from its sender first. Nothing is signed or sent.
// The fix round's rulings (Task 46b's review):
// - remove-door reads every bridge the vault ever enabled (BridgeActivated since its creation): the record's adapter is
//   the only one whose parks ops reads, so any other refuses (C1);
// - every guard read is at the head its scans reached, never "latest" (I2), and a door not paused, or with an open
//   batch, warns: a batch of it can still land before the file is signed;
// - the log server must keep the vault's history: its constructor's BridgeActivated in its creation block, else
//   HistoryMissing (I3), never "nothing queued".
// The re-review's minors: remove-door also refuses unless the logs show the vault enabling its primary bridge (N1: a
// log server with gaps could hide an activation, and a migration makes the new bridge the primary); the door's warning
// says a pause stops deposits only, and warns too while the door's last batch may still be crossing (N2).
// Task 49's review, M8 (the controller's ruling): every other bridge the vault ever enabled must hold no park at all,
// its park totals (parkedNative, parkedTokens) read at the guard's head, since ops can tell which door a park came from
// only in the record's adapter; one that holds parks, or can't be read, refuses, naming it. No refusal points to a
// path that would refuse too (the hand-made file N3 named is gone: the sign page runs this same guard).

/** A guard's read that failed: it can't confirm the file is safe, so it writes nothing. */
const cantConfirm = (what: string, e: unknown) => new Error(`Can't confirm it's safe right now: ${what} could not be read (${firstLine(e)}); try again; nothing written`);

/** `get()`, or cantConfirm(`what`) when it fails; a log server without the history is refused as it is. */
async function confirmed<T>(what: string, get: () => Promise<T>): Promise<T> {
  try {
    return await get();
  } catch (e) {
    if (e instanceof HistoryMissing) throw e;
    throw cantConfirm(what, e);
  }
}

const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const CHAIN: Record<SchedulerContract, ChainName> = { vault: "bittensor", frontDoor: "base" };
const NAME: Record<SchedulerContract, string> = { vault: "vault", frontDoor: "front door" };

/** A payout batch the vault holds, with its key. */
export interface QueuedBatch extends PayoutBatchRead {
  key: Hex;
}

/** A park the Bittensor adapter holds: its key, its sender (the front door whose batch it is, from its BatchParked log)
 * and its record. */
export interface HeldPark {
  key: Hex;
  sender: Address;
  amount: bigint;
  parkedAt: number;
  converted: boolean;
}

/** The vault's logs the removal guard reads, in one scan from its creation to block `head`: the keys of its payout
 * batches (PayoutBatchQueued) and every bridge it ever enabled (BridgeActivated). Its constructor's activation of the
 * record's Bittensor adapter, in its creation block, must be among them: that proves the log server kept the history
 * (HistoryMissing otherwise). A failed read throws. */
export async function vaultHistory(ctx: Pick<Ctx, "rpc" | "logs" | "logsWindow">, rec: RecordV32, head: bigint, o: BuildsOpt = {}): Promise<{ keys: Hex[]; bridges: Address[] }> {
  const build = loadBuildV32(rec.build, o.buildsDir);
  const created = rec.done.vault?.block;
  if (created === undefined) throw new Error("the record has no block for the vault's creation, where its logs start");
  const logs = await scanEvents(ctx, "bittensor", getAddress(rec.plan.addresses.vault), build.vaultAbi, ["PayoutBatchQueued", "BridgeActivated"], BigInt(created), head);
  const activations = logs.filter((l) => l.eventName === "BridgeActivated");
  if (!activations.some((l) => l.block === BigInt(created) && same(l.args.bridge, rec.plan.addresses.bitAdapter))) throw historyMissing(rec, created);
  return {
    keys: [...new Set(logs.filter((l) => l.eventName === "PayoutBatchQueued").map((l) => String(l.args.key).toLowerCase() as Hex))],
    bridges: [...new Set(activations.map((l) => getAddress(l.args.bridge as Address)))],
  };
}

/** The payout batches under `keys` the vault holds at block `head`, of any door, each re-read through the lens
 * (getPayoutBatch), which decides: one with entries left (its count above its cursor) is held, a cancel's carried
 * bounces included (they stay queued as the batch's list). A failed read throws. */
export async function queuedBatches(ctx: Pick<Ctx, "rpc">, rec: RecordV32, keys: readonly Hex[], head: bigint, o: BuildsOpt = {}): Promise<QueuedBatch[]> {
  const out: QueuedBatch[] = [];
  for (const key of keys) {
    const b = (await readVault(ctx, rec, "getPayoutBatch", [key], o.buildsDir, head)) as PayoutBatchRead;
    if (b.count > b.cursor) out.push({ ...b, key });
  }
  return out;
}

/** Every park the Bittensor adapter holds at block `head`: each key its BatchParked logs name from its creation to
 * `head` (the log server's history proven first), re-read there (parked(key)), which decides: a record with a parkedAt
 * is held, converted or not (a park that failed to deliver again stays under its key). A failed read throws. */
export async function heldParks(ctx: Pick<Ctx, "rpc" | "logs" | "logsWindow">, rec: RecordV32, head: bigint, o: BuildsOpt = {}): Promise<HeldPark[]> {
  await proveBittensorHistory(ctx, rec, o);
  const build = loadBuildV32(rec.build, o.buildsDir);
  const abi = build.contracts.CcipBittensorAdapter.abi;
  const adapter = getAddress(rec.plan.addresses.bitAdapter);
  const created = rec.done.bitAdapter?.block;
  if (created === undefined) throw new Error("the record has no block for the Bittensor adapter's creation, where its logs start");
  const logs = await scanEvents(ctx, "bittensor", adapter, abi, ["BatchParked"], BigInt(created), head);
  const senders = new Map<Hex, Address>();
  for (const l of logs) senders.set(String(l.args.key).toLowerCase() as Hex, getAddress(l.args.sender as Address));
  const out: HeldPark[] = [];
  for (const [key, sender] of senders) {
    const [amount, parkedAt, converted] = (await read(ctx.rpc, "bittensor", { address: adapter, abi, functionName: "parked", args: [key] }, head)) as readonly [bigint, bigint, boolean];
    if (parkedAt !== 0n) out.push({ key, sender, amount, parkedAt: Number(parkedAt), converted });
  }
  return out;
}

/** What the Bittensor adapter owes its parks at block `head`: parkedNative and parkedTokens. */
async function parkTotals(ctx: Pick<Ctx, "rpc">, rec: RecordV32, head: bigint, o: BuildsOpt): Promise<{ native: bigint; tokens: bigint }> {
  const abi = loadBuildV32(rec.build, o.buildsDir).contracts.CcipBittensorAdapter.abi;
  const address = getAddress(rec.plan.addresses.bitAdapter);
  return {
    native: (await read(ctx.rpc, "bittensor", { address, abi, functionName: "parkedNative" }, head)) as bigint,
    tokens: (await read(ctx.rpc, "bittensor", { address, abi, functionName: "parkedTokens" }, head)) as bigint,
  };
}

/** Bittensor's head block, which every guard read and scan is pinned to (the review's I2). */
const headBlock = async (ctx: Pick<Ctx, "rpc" | "logs">): Promise<bigint> => BigInt((await confirmed("Bittensor's head", () => headOf(ctx, "bittensor"))).block);

/** How long a batch the door closed may take to cross to the vault: a batch closed this recently may still be on CCIP
 * (the re-review's N2, the controller's ~30 minutes). */
const CROSSING_SECONDS = 30 * 60;

/** The warning when a batch of `door` can still land before its removal is signed: the door is not paused, or holds an
 * open batch, or its open batch started less than CROSSING_SECONDS ago by Base's head time, so its last batch may have
 * just closed and still be crossing (read on Base now); one that can't be read warns too. None for a paused door with
 * nothing open whose open batch is older. A pause stops the door's deposits only: redeem requests still batch, and a
 * close still sends (I-20). */
export async function doorWarning(ctx: Pick<Ctx, "rpc">, rec: RecordV32, door: Address, o: BuildsOpt): Promise<string | undefined> {
  const abi = loadBuildV32(rec.build, o.buildsDir).contracts.CascadeFrontDoor.abi;
  const tail =
    ": a batch of it can still land on the vault before this file is signed. A pause stops deposits only (redeem requests still batch), and a batch closed in the last ~30 minutes may still be crossing. Pause the door and let its last batch land first.";
  let batch: readonly bigint[];
  try {
    const paused = (await read(ctx.rpc, "base", { address: door, abi, functionName: "paused" })) as boolean;
    batch = (await read(ctx.rpc, "base", { address: door, abi, functionName: "openBatch" })) as readonly bigint[];
    const [deposits, redeems] = [Number(batch[4]), Number(batch[5])];
    const open = deposits + redeems > 0;
    if (!paused || open) {
      const held = `an open batch (${plural(deposits, "deposit", "deposits")}, ${plural(redeems, "redeem", "redeems")})`;
      return `  WARNING — the door ${!paused && open ? `is not paused and has ${held}` : !paused ? "is not paused" : `has ${held}`}${tail}`;
    }
  } catch (e) {
    return `  WARNING — whether the door is paused, or has an open batch, could not be read (${firstLine(e)})${tail}`;
  }
  try {
    const head = (await ctx.rpc.request("base", "eth_getBlockByNumber", ["latest", false])) as { timestamp: Hex } | null;
    if (!head) throw new Error("Base has no latest block");
    const ago = hexToNumber(head.timestamp) - Number(batch[1]);
    if (ago >= CROSSING_SECONDS) return undefined;
    const minutes = Math.floor(Math.max(0, ago) / 60);
    return `  WARNING — the door's last batch may have closed ${minutes === 0 ? "less than a minute" : plural(minutes, "minute", "minutes")} ago (its open batch started then)${tail}`;
  } catch (e) {
    return `  WARNING — when the door's last batch closed could not be read (${firstLine(e)})${tail}`;
  }
}

/** Who sends the call on `c`'s chain: the owner or the guardian the contract names now. */
async function senderOf(ctx: Pick<Ctx, "rpc">, rec: RecordV32, c: SchedulerContract, as: "owner" | "guardian", o: BuildsOpt): Promise<Address> {
  const get = () => (c === "vault" ? readVault(ctx, rec, as, [], o.buildsDir) : readDoor(ctx, rec, as, [], o.buildsDir));
  return getAddress((await readNow(`${where(c)}'s ${as}`, get)) as Address);
}

/** `data` from `from` to `to`, asked of the contract by eth_call: refused, writing nothing, when it would revert (named
 * by `refusal` when it gives a line for that error) or when the node did not run it. */
async function mustRun(ctx: Pick<Ctx, "rpc">, rec: RecordV32, c: SchedulerContract, tx: { from: Address; to: Address; data: Hex }, text: string, as: string, o: BuildsOpt, refusal?: (error: string) => string | undefined): Promise<void> {
  const a = await ask(ctx, CHAIN[c], tx, buildErrorsV32(loadBuildV32(rec.build, o.buildsDir)));
  if (a.kind === "unread") throw checkFailed(`${text} on ${where(c)}`, a.why);
  if (a.kind === "reverted") throw new Error(refusal?.(a.error) ?? `${text} on ${where(c)} from the ${as} ${tx.from} would revert: ${a.error}; nothing written`);
}

/** `pnpm ops retire-pair --as owner|guardian --for-wallet`: disableBridge of the record's adapter pair on both chains, the
 * vault's of the Bittensor adapter and the front door's of the Base adapter, in one file (sign both), refused while the
 * Bittensor adapter holds any park (parkedNative or parkedTokens not 0), with the amounts. Each call is asked of its
 * contract by eth_call from that chain's owner or guardian first. Disabling a primary bridge closes that chain's exits. */
export async function retirePairCommand(ctx: SchedulerCtx, rec: RecordV32, o: FileOpts & { as: "owner" | "guardian" }): Promise<{ ok: boolean; lines: string[]; files: string[] }> {
  await checkChains(ctx);
  const build = loadBuildV32(rec.build, o.buildsDir);
  const a = rec.plan.addresses;
  const head = await headBlock(ctx);
  const totals = await confirmed("the Bittensor adapter's parks (parkedNative, parkedTokens)", () => parkTotals(ctx, rec, head, o));
  if (totals.native !== 0n || totals.tokens !== 0n) {
    throw new Error(
      `the adapter pair can't be retired yet: the Bittensor adapter ${getAddress(a.bitAdapter)} still holds parks, ${tao(totals.native)} TAO as native TAO (parkedNative) and ${tao(totals.tokens)} TAO as tokens (parkedTokens). Each park must be delivered (deliverParked) or, after 14 days, refunded (refundParked) first; nothing written`,
    );
  }
  const lines: string[] = [];
  const calls: WalletCall[] = [];
  // the front door's first (the review's M2): a batch the door closes before the vault's call is signed still lands
  // while the vault takes it, instead of parking in the pair being retired
  for (const [c, bridge] of [
    ["frontDoor", getAddress(a.baseAdapter)],
    ["vault", getAddress(a.bitAdapter)],
  ] as const) {
    const chain = CHAIN[c];
    const to = getAddress(a[c]);
    const from = await senderOf(ctx, rec, c, o.as, o);
    const abi = c === "vault" ? build.vaultAbi : build.contracts.CascadeFrontDoor.abi;
    const data = encodeFunctionData({ abi, functionName: "disableBridge", args: [bridge] } as never);
    const text = `disableBridge(${bridge})`;
    await mustRun(ctx, rec, c, { from, to, data }, text, o.as, o);
    lines.push(`${chainLabel(chain)} ${NAME[c]} ${to}: ${text} from the ${o.as} ${from} would succeed now.`);
    const primary = await readNow(`${where(c)}'s primary bridge`, () => (c === "vault" ? readVault(ctx, rec, "primaryBridge", [], o.buildsDir) : readDoor(ctx, rec, "primaryBridge", [], o.buildsDir)));
    if (same(primary, bridge)) {
      lines.push(`  It is the ${NAME[c]}'s primary bridge: disabling it closes the exits on ${chainLabel(chain)} and stamps the ${o.as}'s clock, until the owner makes another enabled bridge the primary (setPrimaryBridge).`);
    }
    calls.push({ chainId: chainIdFor(rec, chain), to, data, value: "0", label: `${text} on ${where(c)}: retires the adapter pair`, from });
  }
  lines.push(
    `The Bittensor adapter holds no park (parkedNative and parkedTokens are 0, at Bittensor block ${head}). The file holds both calls: sign the front door's first, and the vault's once the Base adapter's last sends have landed.`,
  );
  const path = writeCalls(o, `${o.name}-retire-pair-${o.as}`, `Cascade ${o.name}: retire the adapter pair (disableBridge on both chains): sign both calls`, calls);
  lines.push(wroteLine(path, calls.length));
  return { ok: true, lines, files: [path] };
}

/** `pnpm ops remove-door <chain> <door> --as owner|guardian --for-wallet`: the vault's removeFrontDoor(chain, door),
 * asked of the vault by eth_call from the owner or the guardian, and refused while the vault holds a payout batch of
 * that door (entries left, a cancel's carried bounces included) or the Bittensor adapter a park from it, each named with
 * its amounts. Ops reads parks only in the record's adapter pair, so a door on a chain that pair doesn't serve is
 * refused: its parks can't be confirmed. An owner's removal leaves the door Reopen-able by the owner alone: it warns. */
export async function removeDoorCommand(
  ctx: SchedulerCtx,
  rec: RecordV32,
  o: FileOpts & { chain: bigint; door: Address; as: "owner" | "guardian" },
): Promise<{ ok: boolean; lines: string[]; files: string[] }> {
  const { from, text, data, head, door, vault, others } = await removeDoorGuard(ctx, rec, o);
  // what the removal does: the launch chain's last door closes the exits
  const launchChain = BigInt((await readNow("the vault's launch chain", () => readVault(ctx, rec, "launchChain", [], o.buildsDir))) as bigint);
  const active = BigInt((await readNow(`the vault's active doors on chain ${o.chain}`, () => readVault(ctx, rec, "activeDoors", [o.chain], o.buildsDir))) as bigint);
  const peer = keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }], [o.chain, door]));
  const state = Number(await readNow("the door's state", () => readVault(ctx, rec, "doorState", [peer], o.buildsDir)));
  const lines = [
    `Bittensor vault ${vault}: ${text} from the ${o.as} ${from} would succeed now. No payout batch is queued for the door, and no park is outstanding from it, as of Bittensor block ${head}.`,
  ];
  // CascadeTypes.DoorState.Active
  if (o.chain === launchChain && active === 1n && state === 1) lines.push(`  It is the launch chain's last active door: removing it closes the exits and stamps the ${o.as}'s clock.`);
  // spec §7: the sign page warns on an owner-account removeFrontDoor; so does the file's writer
  if (o.as === "owner") {
    lines.push("  WARNING — the owner's removal leaves the door Removed: the door then stays Reopen-able by the owner alone, without the guardian's veto. A removal meant to last is the guardian's.");
  }
  // the guard holds as of its head: a batch of the door can still land before the file is signed (the review's I2)
  const warning = await doorWarning(ctx, rec, door, o);
  if (warning) lines.push(warning);
  // what the guard cannot see (the review's C1): parks in an adapter the vault never enabled; and what it read of the
  // other bridges the vault enabled (Task 49's review, M8)
  const adapter = getAddress(rec.plan.addresses.bitAdapter);
  lines.push(
    others.length
      ? `  Ops reads which door each park came from only in ${adapter}; the other bridge${others.length === 1 ? "" : "s"} the vault enabled, ${others.join(", ")}, hold${others.length === 1 ? "s" : ""} no park (as of Bittensor block ${head}). A door that sends through an adapter the vault never enabled would park there unseen.`
      : `  Ops reads parks only in the vault's one bridge, ${adapter}: a door that sends through an adapter the vault never enabled would park there unseen.`,
  );
  const call: WalletCall = { chainId: chainIdFor(rec, "bittensor"), to: vault, data, value: "0", label: `${text} on ${where("vault")}`, from };
  const path = writeCalls(o, `${o.name}-remove-door-${o.as}-${o.chain}-${door.slice(2, 10).toLowerCase()}`, `Cascade ${o.name}: remove front door ${door} (chain ${o.chain}) from the vault`, [call]);
  lines.push(wroteLine(path, 1));
  return { ok: true, lines, files: [path] };
}

/** What remove-door's guard found: the call it checked (from the owner or the guardian the vault names now, asked of
 * the vault by eth_call), and the Bittensor head every guard read was pinned to. */
export interface DoorGuard {
  from: Address;
  /** removeFrontDoor(chain, door), as a line names it */
  text: string;
  data: Hex;
  head: bigint;
  door: Address;
  vault: Address;
  /** the other bridges the vault ever enabled, each read holding no park */
  others: Address[];
}

/** remove-door's guard (spec §3.2's ops rule; Task 46b), alone, so the sign page can run it again just before it sends
 * (Task 46b's review, I2; Task 49): the vault's removeFrontDoor(chain, door) from the `as` the vault names now must
 * succeed by eth_call, and, every read at one Bittensor head, the vault must hold no payout batch of that door (entries
 * left, a cancel's carried bounces included) and the Bittensor adapter no park from it, the logs held to the contracts'
 * totals; every other bridge the vault ever enabled must hold no park at all (its totals, Task 49's review, M8). Throws
 * why it can't confirm it, or what still waits, as remove-door says it; a read that fails says to try again. */
export async function removeDoorGuard(ctx: SchedulerCtx, rec: RecordV32, o: BuildsOpt & { chain: bigint; door: Address; as: "owner" | "guardian" }): Promise<DoorGuard> {
  await checkChains(ctx);
  const build = loadBuildV32(rec.build, o.buildsDir);
  const a = rec.plan.addresses;
  const door = getAddress(o.door);
  const vault = getAddress(a.vault);
  // the only parks ops can read are the record's Bittensor adapter's, which serves one chain
  const remote = (await confirmed("the Bittensor adapter's remote chain", () =>
    read(ctx.rpc, "bittensor", { address: getAddress(a.bitAdapter), abi: build.contracts.CcipBittensorAdapter.abi, functionName: "remoteChainId" }),
  )) as bigint;
  if (remote !== o.chain) {
    // the words as the Task 49 re-review's N2 has them: relaxing this waits for the task that adds a chain
    throw new Error(`Can't confirm it's safe: remove-door serves only doors on chain ${remote}, the one ops' RPCs and this deployment's Bittensor adapter ${getAddress(a.bitAdapter)} reach, not chain ${o.chain}; nothing written`);
  }
  // the vault's own answer, from the sender, before the logs are read
  const from = await senderOf(ctx, rec, "vault", o.as, o);
  const text = `removeFrontDoor(${o.chain}, ${door})`;
  const data = encodeFunctionData({ abi: build.vaultAbi, functionName: "removeFrontDoor", args: [o.chain, door] } as never);
  await mustRun(ctx, rec, "vault", { from, to: vault, data }, text, o.as, o, (error) =>
    error === "PeerNotActive()" ? `the vault has no active front door ${door} on chain ${o.chain} (PeerNotActive()): nothing to remove; nothing written` : undefined,
  );
  // the guards, every read at one head block (the review's I2): the vault's history, proven whole by its constructor's
  // activation (I3), and every bridge it ever enabled (C1), each other than the record's adapter holding no park (M8);
  // its payout batches, held to its pending payouts; and the adapter's parks, held to its totals
  const head = await headBlock(ctx);
  const history = await confirmed("the vault's logs (its payout batches and bridges)", () => vaultHistory(ctx, rec, head, o));
  const others = history.bridges.filter((b) => !same(b, a.bitAdapter));
  const adapterAbi = build.contracts.CcipBittensorAdapter.abi;
  for (const b of others) {
    let native: bigint;
    let tokens: bigint;
    try {
      native = (await read(ctx.rpc, "bittensor", { address: b, abi: adapterAbi, functionName: "parkedNative" }, head)) as bigint;
      tokens = (await read(ctx.rpc, "bittensor", { address: b, abi: adapterAbi, functionName: "parkedTokens" }, head)) as bigint;
    } catch (e) {
      if (isRevert(e)) {
        throw new Error(
          `Can't confirm it's safe: the bridge ${b}, which the vault enabled, does not report its parks (parkedNative() and parkedTokens() revert there: ${describeRevert(e, buildErrorsV32(build))}), so ops can't confirm it holds none; nothing written`,
        );
      }
      // a bridge with no code can't answer, now or later: trying again won't help (the Task 49 re-review's N3)
      const code = await ctx.rpc.request("bittensor", "eth_getCode", [b, numberToHex(head)]).catch(() => undefined);
      if (code === "0x") throw new Error(`Can't confirm it's safe: the bridge ${b}, which the vault enabled, holds no adapter code (no contract there on Bittensor), so its parks can't be read; nothing written`);
      throw new Error(`Can't confirm it's safe right now: the parks of the bridge ${b}, which the vault enabled, could not be read (${firstLine(e)}); try again; nothing written`);
    }
    if (native !== 0n || tokens !== 0n) {
      throw new Error(
        `Can't confirm it's safe: the bridge ${b}, which the vault enabled, holds parks (${tao(native)} TAO as native TAO and ${tao(tokens)} TAO as tokens), and ops reads which door a park came from only in this deployment's Bittensor adapter ${getAddress(a.bitAdapter)}: each of that bridge's parks is delivered (deliverParked), or after 14 days refunded (refundParked) or dropped (dropParked), first; nothing written`,
      );
    }
  }
  // a belt for a log server with gaps (the re-review's N1): a migration makes the new adapter the primary, so a primary
  // the logs never show the vault enabling means an activation they missed
  const primary = getAddress((await confirmed("the vault's primary bridge", () => readVault(ctx, rec, "primaryBridge", [], o.buildsDir, head))) as Address);
  if (!history.bridges.some((b) => same(b, primary))) {
    throw new Error(
      `Can't confirm it's safe: the vault's primary bridge is ${primary}, but its logs never show the vault enabling it (they may have gaps): read them from one archive node (${ARCHIVE_NODE}) and try again; nothing written`,
    );
  }
  const batches = await confirmed("the vault's payout batches", () => queuedBatches(ctx, rec, history.keys, head, o));
  const pending = (await confirmed("the vault's pending payouts (pendingPayouts)", () => readVault(ctx, rec, "pendingPayouts", [], o.buildsDir, head))) as bigint;
  const queued = batches.reduce((s, b) => s + b.remaining, 0n);
  if (queued !== pending) {
    throw new Error(`Can't confirm it's safe right now: the payout batches read from the vault's logs hold ${tao(queued)} TAO, not the ${tao(pending)} TAO of pendingPayouts(): the logs read short; try again; nothing written`);
  }
  const parks = await confirmed("the Bittensor adapter's parks", () => heldParks(ctx, rec, head, o));
  const totals = await confirmed("the Bittensor adapter's parks (parkedNative, parkedTokens)", () => parkTotals(ctx, rec, head, o));
  const native = parks.filter((p) => p.converted).reduce((s, p) => s + p.amount, 0n);
  const tokens = parks.filter((p) => !p.converted).reduce((s, p) => s + p.amount, 0n);
  if (native !== totals.native || tokens !== totals.tokens) {
    throw new Error(
      `Can't confirm it's safe right now: the parks read from the Bittensor adapter's logs hold ${tao(native)} TAO as native TAO and ${tao(tokens)} TAO as tokens, not its parkedNative (${tao(totals.native)} TAO) and parkedTokens (${tao(totals.tokens)} TAO): the logs read short; try again; nothing written`,
    );
  }
  const its = batches.filter((b) => BigInt(b.sourceChain) === o.chain && same(b.frontDoor, door));
  const from_ = parks.filter((p) => same(p.sender, door));
  const reasons: string[] = [];
  if (its.length) {
    reasons.push(
      `it has ${plural(its.length, "payout batch", "payout batches")} queued on the vault, ${its.map((b) => `${b.key} (${b.count - b.cursor} of ${b.count} entries left, ${tao(b.remaining)} TAO)`).join(", ")}: each is paid first (processPayouts), carried bounces included`,
    );
  }
  if (from_.length) {
    reasons.push(
      `it has ${plural(from_.length, "park", "parks")} outstanding in the Bittensor adapter, ${from_.map((p) => `${p.key} (${tao(p.amount)} TAO as ${p.converted ? "native TAO" : "tokens"}, parked ${iso(p.parkedAt)})`).join(", ")}: each is delivered (deliverParked), or after 14 days refunded (refundParked) or dropped (dropParked), first`,
    );
  }
  if (reasons.length) throw new Error(`front door ${door} on chain ${o.chain} can't be removed yet: ${reasons.join("; and ")}; nothing written`);
  return { from, text, data, head, door, vault, others };
}
