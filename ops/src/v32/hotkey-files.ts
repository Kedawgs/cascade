import { type Address, encodeFunctionData, formatEther, getAddress, type Hex, numberToHex, parseAbi } from "viem";
import { read } from "../rpc.ts";
import { encodeSs58 } from "../ss58.ts";
import { type WalletCall, wroteLine } from "../wallet.ts";
import { buildErrorsV32, loadBuildV32 } from "./build.ts";
import { readDoor, readVault } from "./lens.ts";
import { BOUNDS_V32, FUNDING_V32 } from "./settings.ts";
import { claimGasLimit } from "../keeper/core/rewards.ts";
import { deferredProblem, readDeferred } from "../keeper/core/v32/deferred.ts";
import { STORAGE_QUERY } from "./validators.ts";
import { ask, checkChains, checkFailed, chainIdFor, type FileOpts, type RecordV32, readNow, type SchedulerCtx, where, writeCalls } from "./scheduler.ts";

// The owner's and the guardian's hotkey calls on the vault, as call files for the sign page (Task 53; the keeper's own
// listing and removal are its one-shots, core/v32/hand.ts): pnpm ops add-hotkey <hotkey> --as owner|guardian, pnpm ops
// remove-hotkey <hotkey> [--forfeit] --as owner|guardian, and pnpm ops set-stake-hotkey <hotkey> (the owner's, when it
// applies at once). Each is asked of the vault by eth_call from the role it names, read now, before a file is written;
// ops signs and sends nothing. The roles (spec §5): the owner or the guardian lists any hotkey (the last of the 4 slots
// only while stake is missing); the owner removes any hotkey but the stake hotkey, moving its stake onto the stake hotkey
// (refused while its unclaimed rewards are above the dust allowance, unless --forfeit), the guardian only an empty one;
// setStakeHotkey is the owner's, at once only when the new hotkey holds more than the stake hotkey and at least half the
// booked stake (else NotScheduled: a 48-hour item, pnpm ops schedule vault setStakeHotkey <hotkey>).

export type HotkeyFn = "addHotkey" | "removeHotkey" | "setStakeHotkey";

const NOT_SCHEDULED = /^NotScheduled\(/;

/** What each call does, in a line for the file and the terminal. */
function effect(fn: HotkeyFn, hotkey: Hex, forfeit: boolean, as: "owner" | "guardian"): string {
  const ss58 = encodeSs58(hotkey);
  if (fn === "addHotkey") return `lists hotkey ${hotkey} (${ss58}) on the vault: its stake counts in the price; new stake still goes to the stake hotkey`;
  if (fn === "setStakeHotkey") return `makes hotkey ${hotkey} (${ss58}) the vault's stake hotkey: new stake goes to it from now on`;
  return as === "owner"
    ? `removes hotkey ${hotkey} (${ss58}) from the vault's list: any of the vault's stake on it moves onto the stake hotkey${forfeit ? ", and its unclaimed rewards are given up (forfeit)" : ""}`
    : `removes the empty hotkey ${hotkey} (${ss58}) from the vault's list (the guardian's removal: no stake on it, unclaimed rewards within the dust allowance)`;
}

/** The founder's next step when the vault refuses a call: in words, for its error. */
function refusal(fn: HotkeyFn, hotkey: Hex, as: string, error: string): string | undefined {
  if (fn === "setStakeHotkey" && NOT_SCHEDULED.test(error)) {
    return `setStakeHotkey(${hotkey}) doesn't apply at once now (NotScheduled): the new hotkey must hold more of the vault's stake than the stake hotkey and at least half the booked stake. Schedule it instead (48 hours, the guardian may veto): pnpm ops schedule vault setStakeHotkey ${hotkey} --for-wallet --live; nothing written`;
  }
  const words: Record<string, string> = {
    HotkeyKnown: "it is listed already",
    TooManyHotkeys: "the vault's set of hotkeys is full (4): free a slot first",
    SlotReserved: "the last of the 4 slots is kept for a swap's new hotkey: it takes a hotkey only while stake is missing and the hotkey holds at least the chain's minimum",
    UnknownHotkey: "it is not listed",
    HotkeyInUse: "it is the stake hotkey: make another listed hotkey the stake hotkey first (pnpm ops set-stake-hotkey)",
    HotkeyHasRewards: "unclaimed rewards above the dust allowance wait on it: claim them first (pnpm ops claim <hotkey> --live --send), or give them up with --forfeit",
    NotAuthorized: `the ${as} may not remove it: it holds stake, or unclaimed rewards above the dust allowance (only the owner's removal moves stake)`,
    NotListed: "it is not listed: list it first (pnpm ops add-hotkey)",
    ZeroHotkey: "it is the zero hotkey",
  };
  const name = /^([A-Za-z0-9]+)\(/.exec(error)?.[1];
  return name && words[name] ? `${fn}(${hotkey}) from the ${as} would revert: ${error}: ${words[name]}; nothing written` : undefined;
}

/** `pnpm ops pause | unpause [front-door|vault|both] --for-wallet` on a v3.2 deployment (Task 53): the guardian's pause() (or
 * the owner's, --as owner) and the owner's unpause(), as one call file for the sign page (the front door's first, so a
 * pause stops deposits before the vault's pause stops payouts; one file for both, "sign both calls"). Each asked of its
 * contract by eth_call from the role read now. The front door's pause stamps nothing and stops deposits only (a close
 * still goes, I-20); the vault's stamps its pauser's clock (every item pending on the owner's clock dies with the
 * owner's; the guardian's kills the Ordinary ones), and stops payouts and direct exits. */
export async function pauseFileCommand(
  ctx: SchedulerCtx,
  rec: RecordV32,
  o: FileOpts & { action: "pause" | "unpause"; target: "front-door" | "vault" | "both"; as: "owner" | "guardian"; offline?: boolean },
): Promise<{ ok: boolean; lines: string[]; files: string[] }> {
  if (o.action === "unpause" && o.as !== "owner") throw new Error("unpause is the owner's; nothing written");
  const contracts = (o.target === "both" ? ["frontDoor", "vault"] : o.target === "vault" ? ["vault"] : ["frontDoor"]) as ("frontDoor" | "vault")[];
  if (o.offline) return offlinePauseFile(rec, { ...o, contracts });
  await checkChains(ctx, contracts.map((c) => (c === "vault" ? "bittensor" : "base")));
  const build = loadBuildV32(rec.build, o.buildsDir);
  const lines: string[] = [];
  const calls: WalletCall[] = [];
  for (const c of contracts) {
    const chain = c === "vault" ? "bittensor" : "base";
    const to = getAddress(rec.plan.addresses[c]);
    const read = (fn: "owner" | "guardian" | "paused") => (c === "vault" ? readVault(ctx, rec, fn, [], o.buildsDir) : readDoor(ctx, rec, fn, [], o.buildsDir));
    const paused = (await readNow(`${where(c)}'s pause`, () => read("paused"))) as boolean;
    if (paused === (o.action === "pause")) {
      lines.push(`${where(c)} is ${paused ? "paused" : "not paused"} already: no call for it.`);
      continue;
    }
    const from = getAddress((await readNow(`${where(c)}'s ${o.as}`, () => read(o.as))) as Address);
    const abi = c === "vault" ? build.vaultAbi : build.contracts.CascadeFrontDoor.abi;
    const data = encodeFunctionData({ abi, functionName: o.action, args: [] } as never) as Hex;
    const a = await ask(ctx, chain, { from, to, data }, buildErrorsV32(build));
    if (a.kind === "unread") throw checkFailed(`${o.action}() on ${where(c)}`, a.why);
    if (a.kind === "reverted") throw new Error(`${o.action}() on ${where(c)} from the ${o.as} ${from} would revert: ${a.error}; nothing written`);
    lines.push(
      `${where(c)} ${to}: ${o.action}() from the ${o.as} ${from} would succeed now. ${
        o.action === "unpause"
          ? "It lets it run again."
          : c === "vault"
            ? `It stops payouts, direct deposits and direct exits, and stamps the ${o.as}'s clock: ${o.as === "owner" ? "every item pending on the vault dies" : "every Ordinary item pending on the vault dies (not a guardian swap or a reopening)"}.`
            : "It stops deposits (redeem requests still batch, claims stay open, and a batch still closes); it stamps nothing."
      }`,
    );
    calls.push({ chainId: chainIdFor(rec, chain), to, data, value: "0", label: `${o.action}() on ${where(c)}`, from });
  }
  if (!calls.length) return { ok: true, lines: [...lines, "Nothing written."], files: [] };
  const both = calls.length > 1;
  const title = `Cascade ${o.name}: ${o.action} ${both ? "on both chains: sign both calls" : `the ${contracts.length === 1 && contracts[0] === "vault" ? "vault" : "front door"}`}, signed by the ${o.as}`;
  const path = writeCalls(o, `${o.name}-${o.action}-${o.target}-${o.as}`, title, calls);
  lines.push(wroteLine(path, calls.length));
  return { ok: true, lines, files: [path] };
}

/** `pnpm ops pause [front-door|vault|both] --for-wallet --offline [--as owner]` (R4, D-L4): the guardian's (or the owner's)
 * emergency pause written with no chain read, for an incident in which ops' RPC for a chain is down while MetaMask's own
 * network still carries the call. It fixes in advance only what the deploy fixed for life: each contract's address and
 * chain id (the record's), the call (pause(), no argument), and its sender (the record's guardian, or owner). It fixes no
 * gas, fee or nonce: MetaMask sets those over its own network when it signs (a gas limit in a call file is the pool steps'
 * alone, wallet.ts). Safe to keep ready: pause() only stops (deposits on Base; payouts and direct exits on Bittensor, the
 * guardian's clock stamped as by any pause) and the owner's unpause undoes it; the contracts take it only from the
 * guardian or the owner, so after a setGuardian the stale file's call is refused (NotGuardian), and the page serves a
 * file marked offline only while every call is a pause() of the record's contracts from the record's guardian or owner
 * (v32/sign.ts). It doesn't check either contract is unpaused (a pause of a paused one reverts, harmlessly). */
function offlinePauseFile(
  rec: RecordV32,
  o: FileOpts & { action: "pause" | "unpause"; as: "owner" | "guardian"; target: string; contracts: ("frontDoor" | "vault")[] },
): { ok: boolean; lines: string[]; files: string[] } {
  if (o.action !== "pause") throw new Error("--offline is for the pause alone: an unpause waits until the chains can be read; nothing written");
  const from = getAddress(o.as === "owner" ? rec.plan.roles.owner : rec.plan.roles.guardian);
  const data = encodeFunctionData({ abi: PAUSE_ABI, functionName: "pause", args: [] }) as Hex;
  const calls: WalletCall[] = o.contracts.map((c) => {
    const chain = c === "vault" ? "bittensor" : "base";
    return { chainId: chainIdFor(rec, chain), to: getAddress(rec.plan.addresses[c]), data, value: "0", label: `pause() on ${where(c)}`, from };
  });
  const both = calls.length > 1;
  const title = `Cascade ${o.name}: pause ${both ? "on both chains, offline (no chain read): sign both calls" : `the ${o.contracts[0] === "vault" ? "vault" : "front door"}, offline (no chain read)`}, signed by the ${o.as}`;
  const path = writeCalls(o, `${o.name}-pause-${o.target}-${o.as}-offline`, title, calls, { offline: true });
  const names = o.contracts.map((c) => (c === "vault" ? "vault" : "front door")).join(" and ");
  return {
    ok: true,
    lines: [
      `Offline: nothing was read from the chains. The file names the record's ${names}, ${both ? "their chain ids" : "its chain id"}, and the record's ${o.as} ${from}; it doesn't check ${both ? "either" : "it"} is unpaused or who the ${o.as} is now. Keep it ready: pnpm ops sign serves it with no chain read.`,
      wroteLine(path, calls.length),
    ],
    files: [path],
  };
}

/** pause() as both contracts declare it (CascadeBase): no argument. */
const PAUSE_ABI = [{ type: "function", name: "pause", stateMutability: "nonpayable", inputs: [], outputs: [] }] as const;

/** CascadeConstants.DIRECT_ORIGIN: the redeem origin of a holder on Bittensor itself. */
export const DIRECT_ORIGIN = (1n << 64n) - 1n;

/** `pnpm ops set-redeem-origin --for-wallet --live` (Task 53; the T18 ruling): the treasury's own setRedeemOrigin(DIRECT_ORIGIN)
 * on the vault, right after deploy and before the first reward cut, so no front door can ever burn its cut shares (they
 * are redeemed on Bittensor alone). From the treasury the vault names now, asked by eth_call, then written for the sign
 * page; already set, nothing is written. */
export async function redeemOriginFileCommand(ctx: SchedulerCtx, rec: RecordV32, o: FileOpts): Promise<{ ok: boolean; lines: string[]; files: string[] }> {
  await checkChains(ctx, ["bittensor"]);
  const build = loadBuildV32(rec.build, o.buildsDir);
  const vault = getAddress(rec.plan.addresses.vault);
  const from = getAddress((await readNow(`${where("vault")}'s treasury`, () => readVault(ctx, rec, "treasury", [], o.buildsDir))) as Address);
  const origin = BigInt((await readNow("the treasury's redeem origin", () => readVault(ctx, rec, "redeemOrigin", [from], o.buildsDir))) as bigint);
  if (origin === DIRECT_ORIGIN) return { ok: true, lines: [`The treasury ${from}'s redeem origin is Bittensor itself already (DIRECT_ORIGIN): nothing to do; nothing written.`], files: [] };
  const data = encodeFunctionData({ abi: build.vaultAbi, functionName: "setRedeemOrigin", args: [DIRECT_ORIGIN] } as never) as Hex;
  const text = `setRedeemOrigin(${DIRECT_ORIGIN})`;
  const a = await ask(ctx, "bittensor", { from, to: vault, data }, buildErrorsV32(build));
  if (a.kind === "unread") throw checkFailed(`${text} on ${where("vault")}`, a.why);
  if (a.kind === "reverted") throw new Error(`${text} on ${where("vault")} from the treasury ${from} would revert: ${a.error}; nothing written`);
  const call: WalletCall = { chainId: chainIdFor(rec, "bittensor"), to: vault, data, value: "0", label: `${text} on ${where("vault")}`, from };
  const path = writeCalls(o, `${o.name}-set-redeem-origin-treasury`, `Cascade ${o.name}: the treasury's redeem origin set to Bittensor itself (DIRECT_ORIGIN), signed by the treasury`, [call]);
  return {
    ok: true,
    lines: [
      `Bittensor vault ${vault}: ${text} from the treasury ${from} would succeed now (its redeem origin is ${origin} now). It makes the treasury's redeem origin Bittensor itself: no front door can burn its reward-cut shares; it redeems them on Bittensor (redeemDirect).`,
      wroteLine(path, 1),
    ],
    files: [path],
  };
}

/** `pnpm ops add-hotkey | remove-hotkey | set-stake-hotkey <hotkey> --as owner|guardian --for-wallet --live`: the call from
 * the vault's owner or guardian as read now, asked of the vault by eth_call (refused, writing nothing, when it would
 * revert, named; or when the node didn't run it), then written for the sign page. */
export async function hotkeyFileCommand(
  ctx: SchedulerCtx,
  rec: RecordV32,
  o: FileOpts & { fn: HotkeyFn; hotkey: Hex; as: "owner" | "guardian"; forfeit?: boolean },
): Promise<{ ok: boolean; lines: string[]; files: string[] }> {
  if (o.fn === "setStakeHotkey" && o.as !== "owner") throw new Error("setStakeHotkey is the owner's; nothing written");
  if (o.forfeit && !(o.fn === "removeHotkey" && o.as === "owner")) throw new Error("--forfeit is the owner's removal's; nothing written");
  await checkChains(ctx, ["bittensor"]);
  const build = loadBuildV32(rec.build, o.buildsDir);
  const vault = getAddress(rec.plan.addresses.vault);
  const from = getAddress((await readNow(`${where("vault")}'s ${o.as}`, () => readVault(ctx, rec, o.as, [], o.buildsDir))) as Address);
  const args = o.fn === "removeHotkey" ? [o.hotkey, o.forfeit === true] : [o.hotkey];
  const data = encodeFunctionData({ abi: build.vaultAbi, functionName: o.fn, args } as never) as Hex;
  const text = `${o.fn}(${args.map(String).join(", ")})`;
  const a = await ask(ctx, "bittensor", { from, to: vault, data }, buildErrorsV32(build));
  if (a.kind === "unread") throw checkFailed(`${text} on ${where("vault")}`, a.why);
  if (a.kind === "reverted") throw new Error(refusal(o.fn, o.hotkey, o.as, a.error) ?? `${text} on ${where("vault")} from the ${o.as} ${from} would revert: ${a.error}; nothing written`);
  // R6b (U9): the vault's dust check reads only the unclaimed view, which leaves out a deferred entitlement; the guardian's
  // removal (of a hotkey with none of the vault's stake) waits until those read as paid (keeper/core/v32/deferred.ts)
  if (o.fn === "removeHotkey" && o.as === "guardian") {
    const dust = BigInt((await readNow("the vault's hotkeyDustRao", () => readVault(ctx, rec, "hotkeyDustRao", [], o.buildsDir))) as bigint);
    const storage = (key: Hex) => ctx.rpc.request("bittensor", "eth_call", [{ to: STORAGE_QUERY, data: key }, "latest"]);
    const problem = deferredProblem(await readDeferred(storage, o.hotkey, rec.plan.vaultColdkey), dust, 0n, o.hotkey);
    if (problem) throw new Error(`${o.fn}(${o.hotkey}) from the guardian is refused here: ${problem}; nothing written`);
  }
  const lines = [`Bittensor vault ${vault}: ${text} from the ${o.as} ${from} would succeed now. It ${effect(o.fn, o.hotkey, o.forfeit === true, o.as)}.`];
  if (o.fn === "removeHotkey" && o.as === "owner") {
    const stake = (await readNow(`the vault's stake hotkey`, () => readVault(ctx, rec, "stakeHotkey", [], o.buildsDir))) as Hex;
    lines.push(`  Its stake, if any, moves onto the stake hotkey ${stake} (below the chain's minimum it becomes the vault's balance instead).`);
  }
  const call: WalletCall = { chainId: chainIdFor(rec, "bittensor"), to: vault, data, value: "0", label: `${text} on ${where("vault")}`, from };
  const stem = `${o.name}-${o.fn === "addHotkey" ? "add-hotkey" : o.fn === "removeHotkey" ? "remove-hotkey" : "set-stake-hotkey"}-${o.as}`;
  // printable ASCII only: the sign page refuses anything else in a file's words
  const title = `Cascade ${o.name}: ${o.fn}(${o.hotkey}) on the vault, signed by the ${o.as}`;
  const path = writeCalls(o, stem, title, [call]);
  lines.push(wroteLine(path, 1));
  return { ok: true, lines, files: [path] };
}

// ---- Task 53's fix round: the sign page's four missing calls ----

const CHAIN_OF = { vault: "bittensor", frontDoor: "base" } as const;
const read2 = (ctx: SchedulerCtx, rec: RecordV32, c: "vault" | "frontDoor", fn: "owner" | "guardian" | "keeper" | "primaryBridge", o: FileOpts) =>
  c === "vault" ? readVault(ctx, rec, fn, [], o.buildsDir) : readDoor(ctx, rec, fn, [], o.buildsDir);
const abiFor = (build: ReturnType<typeof loadBuildV32>, c: "vault" | "frontDoor") => (c === "vault" ? build.vaultAbi : build.contracts.CascadeFrontDoor.abi);

/** `data` from `from` to `to` on `c`'s chain, asked by eth_call: refused (writing nothing) when it would revert or the
 * node didn't run it. */
async function mustAsk(ctx: SchedulerCtx, build: ReturnType<typeof loadBuildV32>, chain: "bittensor" | "base", tx: { from: Address; to: Address; data: Hex; value?: Hex }, text: string, who: string): Promise<void> {
  const a = await ask(ctx, chain, tx, buildErrorsV32(build));
  if (a.kind === "unread") throw checkFailed(text, a.why);
  if (a.kind === "reverted") throw new Error(`${text} from ${who} ${tx.from} would revert: ${a.error}; nothing written`);
}

/** `pnpm ops set-caps <minDeposit> <depositCap> --for-wallet --live` (R4: runbook 7.10 and 7.11): the owner's setCaps on
 * the front door, the minimum deposit and the deposit cap in TAO as typed, immediate either way (CascadeFrontDoor
 * _setCaps: the minimum at least MIN_DEPOSIT_FLOOR, 0.03 TAO, and since R7 at most MAX_BATCH_VALUE, 5,000 TAO, which
 * this refuses first, before any read; the cap unbounded), asked by eth_call from the owner read now. For a
 * minimum-stake change Bittensor announces, and a cap a direct exit consumed. Never the way to stop deposits: the
 * guardian's pause or a cap of 0 is (runbook 7.10). */
export async function capsFileCommand(ctx: SchedulerCtx, rec: RecordV32, o: FileOpts & { minDeposit: bigint; depositCap: bigint }): Promise<{ ok: boolean; lines: string[]; files: string[] }> {
  if (o.minDeposit > BOUNDS_V32.maxBatchValue) {
    throw new Error(
      `a minimum deposit of ${formatEther(o.minDeposit)} TAO is above the front door's MAX_BATCH_VALUE, ${Number(formatEther(BOUNDS_V32.maxBatchValue)).toLocaleString("en-US")} TAO, and setCaps refuses it (no batch could hold one). To stop deposits, the guardian pauses the front door (pnpm ops pause front-door --for-wallet) or the owner sets the deposit cap to 0; nothing written`,
    );
  }
  await checkChains(ctx, ["base"]);
  const build = loadBuildV32(rec.build, o.buildsDir);
  const door = getAddress(rec.plan.addresses.frontDoor);
  const read = (fn: "owner" | "minDeposit" | "depositCap") => readNow(`${where("frontDoor")}'s ${fn}`, () => readDoor(ctx, rec, fn, [], o.buildsDir));
  const owner = getAddress((await read("owner")) as Address);
  const min = BigInt((await read("minDeposit")) as bigint);
  const cap = BigInt((await read("depositCap")) as bigint);
  if (min === o.minDeposit && cap === o.depositCap) throw new Error(`the minimum deposit is ${formatEther(min)} TAO and the deposit cap ${formatEther(cap)} TAO already; nothing written`);
  const text = `setCaps(${o.minDeposit}, ${o.depositCap})`;
  const data = encodeFunctionData({ abi: build.contracts.CascadeFrontDoor.abi, functionName: "setCaps", args: [o.minDeposit, o.depositCap] } as never) as Hex;
  await mustAsk(ctx, build, "base", { from: owner, to: door, data }, `${text} on ${where("frontDoor")}`, "the owner");
  const call: WalletCall = { chainId: chainIdFor(rec, "base"), to: door, data, value: "0", label: `${text} on ${where("frontDoor")}`, from: owner };
  const path = writeCalls(o, `${o.name}-set-caps-owner`, `Cascade ${o.name}: the front door's minimum deposit ${formatEther(o.minDeposit)} TAO and deposit cap ${formatEther(o.depositCap)} TAO, signed by the owner`, [call]);
  return {
    ok: true,
    lines: [
      `Base front door ${door}: ${text} from the owner ${owner} would succeed now: the minimum deposit from ${formatEther(min)} to ${formatEther(o.minDeposit)} TAO and the deposit cap from ${formatEther(cap)} to ${formatEther(o.depositCap)} TAO, at once (setCaps is immediate either way).`,
      wroteLine(path, 1),
    ],
    files: [path],
  };
}

/** `pnpm ops set-batch-limits <maxDeposits> <maxRedeems> --for-wallet --live` (R6b, U4: runbook 7.10): the owner's
 * setBatchLimits on the front door, immediate either way (CascadeFrontDoor _setBatchLimits: each 1 to MAX_ENTRIES, 50),
 * asked by eth_call from the owner read now. Not a lever on a batch someone holds (R7, L2): a batch with no room left for
 * a minimum deposit, or at half its limits, is closable at once already, so a limit of 1 deposit adds nothing; runbook
 * 7.10's levers are minDeposit (set-caps) and the guardian's deposit pause. A limit changed is set back in the same
 * sitting: left at 1, every deposit closes a batch at once at the keeper's cost. */
export async function batchLimitsFileCommand(ctx: SchedulerCtx, rec: RecordV32, o: FileOpts & { maxDeposits: number; maxRedeems: number }): Promise<{ ok: boolean; lines: string[]; files: string[] }> {
  await checkChains(ctx, ["base"]);
  const build = loadBuildV32(rec.build, o.buildsDir);
  const door = getAddress(rec.plan.addresses.frontDoor);
  const read = (fn: "owner" | "maxDeposits" | "maxRedeems") => readNow(`${where("frontDoor")}'s ${fn}`, () => readDoor(ctx, rec, fn, [], o.buildsDir));
  const owner = getAddress((await read("owner")) as Address);
  const deposits = Number(await read("maxDeposits"));
  const redeems = Number(await read("maxRedeems"));
  if (deposits === o.maxDeposits && redeems === o.maxRedeems) throw new Error(`a batch holds at most ${deposits} deposits and ${redeems} redeem requests already; nothing written`);
  const text = `setBatchLimits(${o.maxDeposits}, ${o.maxRedeems})`;
  const data = encodeFunctionData({ abi: build.contracts.CascadeFrontDoor.abi, functionName: "setBatchLimits", args: [o.maxDeposits, o.maxRedeems] } as never) as Hex;
  await mustAsk(ctx, build, "base", { from: owner, to: door, data }, `${text} on ${where("frontDoor")}`, "the owner");
  const call: WalletCall = { chainId: chainIdFor(rec, "base"), to: door, data, value: "0", label: `${text} on ${where("frontDoor")}`, from: owner };
  const path = writeCalls(o, `${o.name}-set-batch-limits-owner`, `Cascade ${o.name}: the front door's batch limits, ${o.maxDeposits} deposits and ${o.maxRedeems} redeem requests, signed by the owner`, [call]);
  return {
    ok: true,
    lines: [
      `Base front door ${door}: ${text} from the owner ${owner} would succeed now: a batch's deposit list from ${deposits} to ${o.maxDeposits} entries and its redeem list from ${redeems} to ${o.maxRedeems}, at once (setBatchLimits is immediate either way).`,
      wroteLine(path, 1),
    ],
    files: [path],
  };
}

/** `pnpm ops set-keeper <0x…> --for-wallet --live`: the owner's setKeeper(new) on the front door (Base) and the vault
 * (Bittensor), at once on each, one file: the keeper's rotation (or, at 0, its revocation). Each asked by eth_call from
 * the owner read now. Refused when the address is the keeper on both chains already. */
export async function setKeeperFileCommand(ctx: SchedulerCtx, rec: RecordV32, o: FileOpts & { keeper: Address }): Promise<{ ok: boolean; lines: string[]; files: string[] }> {
  await checkChains(ctx);
  const build = loadBuildV32(rec.build, o.buildsDir);
  const keeper = getAddress(o.keeper);
  const lines: string[] = [];
  const calls: WalletCall[] = [];
  const now: Address[] = [];
  for (const c of ["frontDoor", "vault"] as const) {
    const to = getAddress(rec.plan.addresses[c]);
    const owner = getAddress((await readNow(`${where(c)}'s owner`, () => read2(ctx, rec, c, "owner", o))) as Address);
    const current = getAddress((await readNow(`${where(c)}'s keeper`, () => read2(ctx, rec, c, "keeper", o))) as Address);
    now.push(current);
    const data = encodeFunctionData({ abi: abiFor(build, c), functionName: "setKeeper", args: [keeper] } as never) as Hex;
    await mustAsk(ctx, build, CHAIN_OF[c], { from: owner, to, data }, `setKeeper(${keeper}) on ${where(c)}`, "the owner");
    lines.push(`${where(c)} ${to}: setKeeper(${keeper}) from the owner ${owner} would succeed now; it applies at once (its keeper is ${current} now).`);
    calls.push({ chainId: chainIdFor(rec, CHAIN_OF[c]), to, data, value: "0", label: `setKeeper(${keeper}) on ${where(c)}`, from: owner });
  }
  if (now.every((k) => k.toLowerCase() === keeper.toLowerCase())) throw new Error(`${keeper} is the keeper on both chains already; nothing written`);
  lines.push(
    keeper === "0x0000000000000000000000000000000000000000"
      ? "setKeeper(0) stops the keeper's key wherever it is: no delivery goes, and stakes, claims and adoptions wait for their 7-day fallbacks."
      : `The new keeper ${keeper}, in place of ${now[1]}: until both calls have landed, the keeper Worker sends nothing (its key isn't keeper() on both chains).`,
  );
  const path = writeCalls(o, `${o.name}-set-keeper-owner`, `Cascade ${o.name}: setKeeper(${keeper}) on both chains: sign both calls, signed by the owner`, calls);
  lines.push(wroteLine(path, calls.length));
  return { ok: true, lines, files: [path] };
}

/** `pnpm ops fund-reserve --from <0x…> --for-wallet --live`: fundReserve() on the Bittensor adapter (payable, anyone),
 * carrying what its native reserve (its balance less its native parks) lacks of RESERVE_TARGET, plus the 500 rao Bittensor
 * keeps back of an empty account: the deploy's funding step 2 (spec §7) on the sign page. Asked by eth_call from `from`
 * with that value. At its target already, nothing is written. */
export async function fundReserveFileCommand(ctx: SchedulerCtx, rec: RecordV32, o: FileOpts & { from: Address }): Promise<{ ok: boolean; lines: string[]; files: string[] }> {
  await checkChains(ctx, ["bittensor"]);
  const build = loadBuildV32(rec.build, o.buildsDir);
  const adapter = getAddress(rec.plan.addresses.bitAdapter);
  const from = getAddress(o.from);
  const abi = build.contracts.CcipBittensorAdapter.abi;
  const balance = await readNow("the Bittensor adapter's balance", async () => BigInt((await ctx.rpc.request("bittensor", "eth_getBalance", [adapter, "latest"])) as Hex));
  const native = (await readNow("the Bittensor adapter's native parks", () => read(ctx.rpc, "bittensor", { address: adapter, abi, functionName: "parkedNative" }))) as bigint;
  const reserve = balance > native ? balance - native : 0n;
  const f = FUNDING_V32;
  if (reserve >= f.reserveTarget) return { ok: true, lines: [`The Bittensor adapter ${adapter}'s reserve is ${formatEther(reserve)} TAO, its target already: nothing to send; nothing written.`], files: [] };
  const value = f.reserveTarget - reserve + (balance === 0n ? f.existentialDeposit : 0n);
  const data = encodeFunctionData({ abi, functionName: "fundReserve" } as never) as Hex;
  await mustAsk(ctx, build, "bittensor", { from, to: adapter, data, value: numberToHex(value) }, `fundReserve() on the Bittensor adapter ${adapter}`, "the account");
  const call: WalletCall = { chainId: chainIdFor(rec, "bittensor"), to: adapter, data, value: value.toString(), label: `fundReserve() on the Bittensor adapter (${formatEther(value)} TAO)`, from };
  const path = writeCalls(o, `${o.name}-fund-reserve`, `Cascade ${o.name}: fund the Bittensor adapter's reserve (fundReserve(), ${formatEther(value)} TAO)`, [call]);
  return {
    ok: true,
    lines: [
      `Bittensor adapter ${adapter}: fundReserve() with ${formatEther(value)} TAO from ${from} would succeed now (its reserve is ${formatEther(reserve)} TAO; the target ${formatEther(f.reserveTarget)}${balance === 0n ? `, plus the ${formatEther(f.existentialDeposit)} TAO Bittensor keeps back of an empty account` : ""}). Anything above the target is the treasury's (sweepSurplus).`,
      wroteLine(path, 1),
    ],
    files: [path],
  };
}

const CUSHION_TOKEN = parseAbi(["function balanceOf(address account) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)"]);

/** `pnpm ops fund-cushion --from <0x…> --for-wallet --live` (merge 7b, R4 F-1; the deploy's funding step 3, spec §7): the
 * Bittensor adapter's token cushion, booked: approve(the adapter, amount) on the adapter's bridged token (its token()),
 * then fundCushion(amount) on the adapter, one ordered file from `from` (anyone may), `amount` what the booked cushion
 * (tokenCushion) lacks of TOKEN_RESERVE_TARGET. A plain transfer of the token is not the cushion: it is surplus, which
 * anyone's sweepSurplus() sends to the treasury. Read now: the booked cushion and the account's token balance (it must
 * hold the amount); the approve asked by eth_call from `from`. fundCushion can't be asked before the approve has landed
 * (it pulls with transferFrom), so the page sends the two in order. At its target already, nothing is written. */
export async function fundCushionFileCommand(ctx: SchedulerCtx, rec: RecordV32, o: FileOpts & { from: Address }): Promise<{ ok: boolean; lines: string[]; files: string[] }> {
  await checkChains(ctx, ["bittensor"]);
  const build = loadBuildV32(rec.build, o.buildsDir);
  const adapter = getAddress(rec.plan.addresses.bitAdapter);
  const from = getAddress(o.from);
  const abi = build.contracts.CcipBittensorAdapter.abi;
  const booked = (await readNow("the Bittensor adapter's booked token cushion (tokenCushion)", () => read(ctx.rpc, "bittensor", { address: adapter, abi, functionName: "tokenCushion" }))) as bigint;
  const f = FUNDING_V32;
  if (booked >= f.tokenReserveTarget) {
    return { ok: true, lines: [`The Bittensor adapter ${adapter}'s booked token cushion is ${formatEther(booked)} FM-TAO, its target already: nothing to send; nothing written.`], files: [] };
  }
  const amount = f.tokenReserveTarget - booked;
  const token = getAddress((await readNow("the Bittensor adapter's token", () => read(ctx.rpc, "bittensor", { address: adapter, abi, functionName: "token" }))) as Address);
  const held = (await readNow(`${from}'s FM-TAO`, () => read(ctx.rpc, "bittensor", { address: token, abi: CUSHION_TOKEN, functionName: "balanceOf", args: [from] }))) as bigint;
  if (held < amount) {
    throw new Error(`${from} holds ${formatEther(held)} FM-TAO (${token} on Bittensor), less than the ${formatEther(amount)} FM-TAO the cushion lacks: get FM-TAO into that account first; nothing written`);
  }
  const approve = encodeFunctionData({ abi: CUSHION_TOKEN, functionName: "approve", args: [adapter, amount] });
  await mustAsk(ctx, build, "bittensor", { from, to: token, data: approve }, `approve(${adapter}, ${amount}) on FM-TAO ${token}`, "the account");
  const fund = encodeFunctionData({ abi, functionName: "fundCushion", args: [amount] } as never) as Hex;
  const chainId = chainIdFor(rec, "bittensor");
  const calls: WalletCall[] = [
    { chainId, to: token, data: approve, value: "0", label: `approve(${adapter}, ${amount}) on FM-TAO, for the Bittensor adapter's token cushion`, from },
    { chainId, to: adapter, data: fund, value: "0", label: `fundCushion(${amount}) on the Bittensor adapter (${formatEther(amount)} FM-TAO)`, from },
  ];
  const path = writeCalls(o, `${o.name}-fund-cushion`, `Cascade ${o.name}: fund the Bittensor adapter's token cushion (approve, then fundCushion, ${formatEther(amount)} FM-TAO)`, calls, { ordered: true });
  return {
    ok: true,
    lines: [
      `Bittensor adapter ${adapter}: its booked token cushion is ${formatEther(booked)} FM-TAO, its target ${formatEther(f.tokenReserveTarget)}. The file approves the adapter for ${formatEther(amount)} FM-TAO from ${from} (it would succeed now; the account holds ${formatEther(held)}), then calls fundCushion(${amount}), which pulls it and books it. Sign them in order: fundCushion needs the approve to have landed.`,
      "Never fund the cushion by a plain transfer: that is surplus, and anyone's sweepSurplus() sends it to the treasury.",
      wroteLine(path, calls.length),
    ],
    files: [path],
  };
}

/** `pnpm ops disable-bridge <vault|front-door|both> <bridge…> --as owner|guardian --for-wallet --live` (spec §7's incident:
 * "pause and disable the primary with the guardian account"): disableBridge from the role read now, the front door's
 * first in one ordered file. The primary's disable closes that chain's exits and stamps its sender's clock (the
 * guardian's kills only Ordinary items; the owner's every item, a pending setGuardian included); a spare's records and
 * stamps nothing. Not rail-checked: it is the incident's stop, not a switch (a switch is pnpm ops schedule both …). */
export async function disableBridgeFileCommand(
  ctx: SchedulerCtx,
  rec: RecordV32,
  o: FileOpts & { target: "vault" | "front-door" | "both"; bridges: readonly Address[]; as: "owner" | "guardian" },
): Promise<{ ok: boolean; lines: string[]; files: string[] }> {
  const contracts = (o.target === "both" ? ["vault", "frontDoor"] : o.target === "vault" ? ["vault"] : ["frontDoor"]) as ("vault" | "frontDoor")[];
  if (o.bridges.length !== contracts.length) {
    throw new Error(o.target === "both" ? "disable-bridge both needs two bridges: the vault's, then the front door's; nothing written" : "disable-bridge needs one bridge; nothing written");
  }
  await checkChains(ctx, contracts.map((c) => CHAIN_OF[c]));
  const build = loadBuildV32(rec.build, o.buildsDir);
  // the front door's first: closes stop on Base before the vault's side moves
  const order = contracts.map((c, i) => ({ c, bridge: getAddress(o.bridges[i]) })).sort((x, y) => (x.c === "frontDoor" ? -1 : y.c === "frontDoor" ? 1 : 0));
  const lines: string[] = [];
  const calls: WalletCall[] = [];
  const off: Partial<Record<"vault" | "frontDoor", Address>> = {};
  for (const { c, bridge } of order) {
    const chain = CHAIN_OF[c];
    const to = getAddress(rec.plan.addresses[c]);
    const from = getAddress((await readNow(`${where(c)}'s ${o.as}`, () => read2(ctx, rec, c, o.as, o))) as Address);
    const primary = getAddress((await readNow(`${where(c)}'s primary bridge`, () => read2(ctx, rec, c, "primaryBridge", o))) as Address);
    const data = encodeFunctionData({ abi: abiFor(build, c), functionName: "disableBridge", args: [bridge] } as never) as Hex;
    await mustAsk(ctx, build, chain, { from, to, data }, `disableBridge(${bridge}) on ${where(c)}`, `the ${o.as}`);
    const contract = c === "vault" ? "vault" : "front-door";
    const isPrimary = primary.toLowerCase() === bridge.toLowerCase();
    if (isPrimary) off[c] = bridge;
    lines.push(
      `${where(c)} ${to}: disableBridge(${bridge}) from the ${o.as} ${from} would succeed now. ${
        isPrimary
          ? `It is the primary: it closes the exits on ${chain === "base" ? "Base" : "Bittensor"} and stamps the ${o.as}'s clock (${o.as === "owner" ? "every item pending there dies, a pending setGuardian included" : "every Ordinary item pending there dies; a guardian swap and a Reopen are spared"}).${
              contracts.length === 1 ? ` The way back is a 7-day Reopen, which reopens the exits when it runs: pnpm ops schedule ${contract} activateBridge ${bridge} --for-wallet --live.` : ""
            }`
          : "It is not the primary: its disable records nothing and stamps nothing."
      }`,
    );
    calls.push({ chainId: chainIdFor(rec, chain), to, data, value: "0", label: `disableBridge(${bridge}) on ${where(c)}`, from });
  }
  const both = calls.length > 1;
  // both primaries off: one two-sided Reopen file brings them back (a one-sided activation would leave the rails
  // disagreeing, which pnpm ops schedule refuses); one primary of the two: its own chain's Reopen
  if (both && off.vault && off.frontDoor) {
    lines.push(
      `The way back is a 7-day Reopen on each chain, which reopens the exits when it runs (until then no batch closes on Base and no payout is sent): pnpm ops schedule both activateBridge ${off.vault} ${off.frontDoor} --for-wallet --live.`,
    );
  } else if (both) {
    for (const [c, b] of Object.entries(off) as ["vault" | "frontDoor", Address][]) {
      lines.push(`The way back for ${where(c)}'s primary is a 7-day Reopen: pnpm ops schedule ${c === "vault" ? "vault" : "front-door"} activateBridge ${b} --for-wallet --live.`);
    }
  }
  const path = writeCalls(o, `${o.name}-disable-bridge-${o.target}-${o.as}`, `Cascade ${o.name}: disableBridge ${both ? "on both chains: sign both calls, the front door's first" : `on the ${o.target}`}, signed by the ${o.as}`, calls, { ordered: both });
  lines.push(wroteLine(path, calls.length));
  return { ok: true, lines, files: [path] };
}

/** `pnpm ops set-claim-gas <gas> --for-wallet --live` (R5 Minor 3; runbook 3.5 step 7): the owner's direct
 * setClaimGasRequired(gas) on the vault, immediate either way within its bounds (MIN_CLAIM_GAS to MAX_CLAIM_GAS, 54,100,000
 * to 63,400,000): refused, writing nothing, outside them or at the value it has. Asked by eth_call from the owner read
 * now. */
export async function claimGasFileCommand(ctx: SchedulerCtx, rec: RecordV32, o: FileOpts & { gas: bigint }): Promise<{ ok: boolean; lines: string[]; files: string[] }> {
  await checkChains(ctx, ["bittensor"]);
  const build = loadBuildV32(rec.build, o.buildsDir);
  const vault = getAddress(rec.plan.addresses.vault);
  const n = (x: bigint) => x.toLocaleString("en-US");
  const bounds = `${n(BOUNDS_V32.minClaimGas)} to ${n(BOUNDS_V32.maxClaimGas)}`;
  if (o.gas < BOUNDS_V32.minClaimGas || o.gas > BOUNDS_V32.maxClaimGas) {
    throw new Error(`setClaimGasRequired(${o.gas}) is outside the vault's bounds, ${bounds} (MIN_CLAIM_GAS and MAX_CLAIM_GAS); nothing written`);
  }
  const now = BigInt((await readNow("the vault's claimGasRequired", () => readVault(ctx, rec, "claimGasRequired", [], o.buildsDir))) as bigint);
  if (o.gas === now) throw new Error(`claimGasRequired is ${n(now)} already; nothing written`);
  const owner = getAddress((await readNow(`${where("vault")}'s owner`, () => readVault(ctx, rec, "owner", [], o.buildsDir))) as Address);
  const data = encodeFunctionData({ abi: build.vaultAbi, functionName: "setClaimGasRequired", args: [o.gas] } as never) as Hex;
  await mustAsk(ctx, build, "bittensor", { from: owner, to: vault, data }, `setClaimGasRequired(${o.gas}) on ${where("vault")}`, "the owner");
  const call: WalletCall = { chainId: chainIdFor(rec, "bittensor"), to: vault, data, value: "0", label: `setClaimGasRequired(${o.gas}) on ${where("vault")}`, from: owner };
  const path = writeCalls(o, `${o.name}-set-claim-gas-owner`, `Cascade ${o.name}: the vault's claimGasRequired to ${n(o.gas)}, signed by the owner`, [call]);
  return {
    ok: true,
    lines: [
      `Bittensor vault ${vault}: setClaimGasRequired(${o.gas}) from the owner ${owner} would succeed now: it moves claimGasRequired from ${n(now)} to ${n(o.gas)} at once (immediate either way, within ${bounds}); the keeper then sends each claim with ${n(claimGasLimit(o.gas))} gas.`,
      wroteLine(path, 1),
    ],
    files: [path],
  };
}

/** `pnpm ops set-idle-buffer <bps> --for-wallet --live`: the owner's direct setIdleBuffer(bps), which applies at once only
 * as a raise (spec §3.8: "increase immediate, decrease scheduled"): refused, writing nothing, when it would lower the
 * buffer (the 48-hour scheduled item instead), keep it as it is, or exceed MAX_IDLE_BUFFER_BPS (1,000). Asked by
 * eth_call from the owner read now. */
export async function idleBufferFileCommand(ctx: SchedulerCtx, rec: RecordV32, o: FileOpts & { bps: bigint }): Promise<{ ok: boolean; lines: string[]; files: string[] }> {
  await checkChains(ctx, ["bittensor"]);
  const build = loadBuildV32(rec.build, o.buildsDir);
  const vault = getAddress(rec.plan.addresses.vault);
  if (o.bps > 1_000n) throw new Error(`setIdleBuffer(${o.bps}) is above the most idleBufferBps may be (1,000: 10%); nothing written`);
  const now = BigInt((await readNow("the vault's idleBufferBps", () => readVault(ctx, rec, "idleBufferBps", [], o.buildsDir))) as number | bigint);
  if (o.bps < now) {
    throw new Error(`setIdleBuffer(${o.bps}) lowers the idle buffer (${now} now): a lowering waits 48 hours, the guardian may veto it: pnpm ops schedule vault setIdleBuffer ${o.bps} --for-wallet --live; nothing written`);
  }
  if (o.bps === now) throw new Error(`idleBufferBps is ${now} already; nothing written`);
  const owner = getAddress((await readNow(`${where("vault")}'s owner`, () => readVault(ctx, rec, "owner", [], o.buildsDir))) as Address);
  const data = encodeFunctionData({ abi: build.vaultAbi, functionName: "setIdleBuffer", args: [o.bps] } as never) as Hex;
  await mustAsk(ctx, build, "bittensor", { from: owner, to: vault, data }, `setIdleBuffer(${o.bps}) on ${where("vault")}`, "the owner");
  const call: WalletCall = { chainId: chainIdFor(rec, "bittensor"), to: vault, data, value: "0", label: `setIdleBuffer(${o.bps}) on ${where("vault")}`, from: owner };
  const path = writeCalls(o, `${o.name}-set-idle-buffer-owner`, `Cascade ${o.name}: raise the vault's idle buffer to ${o.bps} bps, signed by the owner`, [call]);
  return {
    ok: true,
    lines: [
      `Bittensor vault ${vault}: setIdleBuffer(${o.bps}) from the owner ${owner} would succeed now: it raises idleBufferBps from ${now} to ${o.bps} at once (the buffer keeps that share of the booked stake, at least minDailyOutflow, liquid; lowering it later waits 48 hours).`,
      wroteLine(path, 1),
    ],
    files: [path],
  };
}
