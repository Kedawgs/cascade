import { formatEther, type Hex } from "viem";
import { type Done, type KeeperDeps, type KeeperTarget, keeperSend } from "../actions.ts";
import { actionKey, type DueFree } from "../due.ts";
import { RevertedOnChain, SendRefused } from "../errors.ts";
import { HeldRefusal, NotNow, Waits } from "../failures.ts";
import type { KeeperMemory } from "../memory.ts";
import { type ClaimsRead, type HotkeyRead, slotFreeable } from "../rewards.ts";
import { errorName } from "../send.ts";
import type { Sent } from "../types.ts";
import type { KeeperDepsV32 } from "./reads.ts";
import { addHotkeyRequest, removeHotkeyRequest } from "./requests.ts";

// The hotkey watch and the buffer rule (plan Task 53; spec §3.1, §3.8, §7 keeper changes), read with the claims (claims.ts
// rewardsV32), so on the same cadence, and at once when the vault's stake goes missing or comes back:
// - stake missing, said naming the hotkey whose stake left (against the last reading that found nothing missing, kept in
//   the memory), else what each listed hotkey holds;
// - stake on the vault's coldkey off its list (unlistedStakeRao above 0), said with what to do;
// - a swap's old hotkey freed (the keeper's removeHotkey(h, false)) only once the owner's setStakeHotkey moved off it, it
//   holds none of the vault's stake and its credits, claimed first (A17), read 0; only a hotkey the watch itself saw lose
//   its stake while stake was missing is ever freed, never a standby listed and waiting for its stake (T51 review M3), nor
//   one a claim paid its credits onto as stake (only the owner's removeHotkey moves stake: I-6);
// - Bittensor's root hold (RootStakeUnlockInterval, through the storage-query precompile): while it is set, or can't be
//   read, claims wait while any payout is due (a claim stamps the pair it claims on), and the buffer rule is said: the
//   idleBufferBps that keeps the queued payouts and a day's floor (minDailyOutflow) liquid.
// Each line is said once, when it changes.

/** What the hotkey watch reads (KeeperDepsV32.readWatch): whether the vault reads stake missing and how much is missing
 * (rao); its root stake off the list (rao; undefined: the lens reverted, the precompile can't total it); Bittensor's root
 * hold in blocks (undefined: it can't be read); and what the buffer rule computes from: idleBufferBps, the booked stake
 * (rao), the queued payouts and minDailyOutflow (wei). */
export interface WatchRead {
  stakeMissing: boolean;
  missingStakeRao: bigint;
  unlistedStakeRao: bigint | undefined;
  rootHoldBlocks: bigint | undefined;
  /** Why the root hold is unread, when it is (said in the watch's line) */
  rootHoldUnread?: string;
  /** Bittensor's seconds a block, measured from two headers (blocktime.ts), to tell how long the hold lasts; absent unread */
  bittensorBlockS?: number;
  idleBufferBps: number;
  bookedRao: bigint;
  pendingPayouts: bigint;
  minDailyOutflow: bigint;
}

interface WatchMemory {
  /** Each listed hotkey's stake (rao) at the last reading that found nothing missing, by lowercase hotkey */
  stakes?: Record<string, bigint>;
  /** Hotkeys the watch saw emptied (from a positive baseline to 0) while the vault read stake missing (a swap's old
   * hotkeys), lowercase: the only ones the keeper ever frees. A dip that leaves stake (a payout's walk in the same
   * reading) marks nothing; a mark is let go of once the hotkey holds stake again in a reading with nothing missing
   * (Task 53's fix round, the review's Important 5) */
  swapped?: string[];
  /** Whether the last reading found stake missing (the round reads again at once when it changes) */
  missing?: boolean;
  /** What was last said, by line */
  said?: Record<string, string>;
  /** A removal that reverted with nothing to explain it holds that hotkey's removal until then (ms, the round's clock) */
  held?: Record<string, number>;
}

/** CascadeVault's MAX_IDLE_BUFFER_BPS: the most idleBufferBps may be (10%). */
export const MAX_IDLE_BUFFER_BPS = 1_000;
/** How long a removal that reverted with nothing to explain it holds that hotkey's removal: a day. */
export const FREE_HOLD_MS = 24 * 3_600_000;
const RAO = 10n ** 9n;

const v32 = (deps: KeeperDeps): KeeperDepsV32 => {
  if (!("readWatch" in deps) || !("railsSeen" in deps)) throw new Error("v3.2's hotkey watch needs the v3.2 deps (v32/reads.ts depsV32); nothing sent");
  return deps as KeeperDepsV32;
};
const tao = (wei: bigint) => `${formatEther(wei)} TAO`;
const raoTao = (rao: bigint) => tao(rao * RAO);
const lower = (h: string) => h.toLowerCase();
const at = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** About how long `blocks` of Bittensor's blocks last at `blockS` seconds a block (measured): "about 24 hours", "about 1
 * hour", "about 15 minutes". */
function aboutBlocks(blocks: bigint, blockS: number): string {
  const s = Number(blocks) * blockS;
  if (s < 3_600) return `about ${Math.max(1, Math.round(s / 60))} minute${Math.round(s / 60) === 1 ? "" : "s"}`;
  const h = Math.round(s / 3_600);
  return `about ${h} hour${h === 1 ? "" : "s"}`;
}

/** The root hold, in words: what Bittensor holds and for how long (in time at `blockS`, Bittensor's block time measured;
 * in blocks only when that is unread). */
export const rootHoldWords = (blocks: bigint, blockS?: number) =>
  `Bittensor holds root stake ${blocks} blocks${blockS ? ` (${aboutBlocks(blocks, blockS)})` : ""} after each add, remove or claim on a hotkey (RootStakeUnlockInterval)`;

/** The buffer rule (spec §3.8: "once the monitor reports a non-zero interval the owner raises it so the buffer covers
 * pendingPayouts plus a day's floor"): the idleBufferBps whose share of the booked stake is at least the queued payouts
 * plus minDailyOutflow, rounded up; at most MAX_IDLE_BUFFER_BPS. In words, for the founder. */
export function bufferRule(w: Pick<WatchRead, "idleBufferBps" | "bookedRao" | "pendingPayouts" | "minDailyOutflow">): { bps?: number; text: string } {
  const covers = `the queued payouts (${tao(w.pendingPayouts)}) and a day's floor (minDailyOutflow, ${tao(w.minDailyOutflow)})`;
  const booked = w.bookedRao * RAO;
  if (booked === 0n) return { text: "BUFFER RULE: nothing is staked, so nothing needs a buffer" };
  const need = w.pendingPayouts + w.minDailyOutflow;
  const bps = Number((need * 10_000n + booked - 1n) / booked);
  // the buffer is idleBufferBps of the booked stake, at least minDailyOutflow once it is above 0 (CascadeVault._idleBuffer)
  if (w.idleBufferBps >= bps) return { bps: w.idleBufferBps, text: `BUFFER RULE: the vault's idleBufferBps (${w.idleBufferBps}) already covers ${covers}` };
  if (bps > MAX_IDLE_BUFFER_BPS) {
    return {
      bps: MAX_IDLE_BUFFER_BPS,
      text: `BUFFER RULE: covering ${covers} needs ${tao(need)} of the ${tao(booked)} booked stake, more than the most idleBufferBps keeps (1,000: 10%): the owner raises it from ${w.idleBufferBps} to 1,000, and the payouts it can't cover wait for deposits or for the hold to pass`,
    };
  }
  return { bps, text: `BUFFER RULE: the owner raises the vault's idleBufferBps from ${w.idleBufferBps} to ${bps}, so its idle buffer covers ${covers}: ${tao(need)} of the ${tao(booked)} booked stake` };
}

const LIST_NEW = "List the new hotkey: pnpm ops add-hotkey <hotkey> --live --send";
const CLOSES_WAIT =
  "Most likely a validator's hotkey swap moved it. Until a hotkey that holds it is listed, the vault takes no batch, so the keeper closes, rolls and stakes nothing (payouts, claims and deliveries go on).";

/** The hotkey watch for this reading: what is said (each once a change), and the slots due their freeing and the root
 * hold the round's decision takes. `r` is the claims' reading of every listed hotkey; `now` the round's clock (ms). */
export function watchHotkeys(depsIn: KeeperDeps, memory: KeeperMemory, r: Pick<ClaimsRead, "hotkeys">, w: WatchRead, now: number): { frees: DueFree[]; rootHold?: string } {
  const deps = v32(depsIn);
  const mem = (memory.reads.hotkeys ??= {}) as WatchMemory;
  const said = (mem.said ??= {});
  const tell = (key: string, text: string | undefined) => {
    if (said[key] === text) return;
    if (text === undefined) delete said[key];
    else {
      said[key] = text;
      deps.log(text);
    }
  };
  const swapped = new Set(mem.swapped ?? []);

  // stake missing, naming the hotkey it left; once it is back, said once
  if (w.stakeMissing) {
    const stakes = mem.stakes ?? {};
    const fell = r.hotkeys
      .filter((h) => stakes[lower(h.hotkey)] !== undefined && h.stakeRao < (stakes[lower(h.hotkey)] as bigint))
      .sort((x, y) => {
        const dx = (stakes[lower(x.hotkey)] as bigint) - x.stakeRao;
        const dy = (stakes[lower(y.hotkey)] as bigint) - y.stakeRao;
        return dx > dy ? -1 : dx < dy ? 1 : 0;
      });
    // a swap moves all of a hotkey's stake: only a hotkey emptied is marked, and named (a dip beside it, from a payout's
    // walk in the same reading, is neither); with none emptied, the hotkeys that fell are named, marking nothing
    // Accepted (Task 53's re-review, Minor 3): a hotkey a payout's walk empties fully in a reading with stake missing is
    // marked too, since an emptied hotkey reads as a swap's. Harmless: the keeper frees its slot only once it is not the
    // stake hotkey and holds no stake and no credits, an empty slot the keeper (or anyone) can list again.
    const emptied = fell.filter((h) => h.stakeRao === 0n);
    for (const h of emptied) swapped.add(lower(h.hotkey));
    const named = emptied.length ? emptied : fell;
    const left = named.length
      ? `: it left ${named.length === 1 ? "hotkey" : "hotkeys"} ${named.map((h) => `${h.hotkey} (${raoTao(stakes[lower(h.hotkey)] as bigint)} before, ${raoTao(h.stakeRao)} now)`).join(", ")}`
      : `; no earlier reading says which hotkey it left (${r.hotkeys.map((h) => `${h.stakeHotkey ? "the stake hotkey " : ""}${h.hotkey} holds ${raoTao(h.stakeRao)}`).join("; ")})`;
    tell("missing", `STAKE MISSING: ${raoTao(w.missingStakeRao)} of the vault's booked stake is not on its listed hotkeys${left}. ${CLOSES_WAIT} ${LIST_NEW}`);
  } else {
    // the baseline the next missing reading compares with
    mem.stakes = Object.fromEntries(r.hotkeys.map((h) => [lower(h.hotkey), h.stakeRao]));
    // a marked hotkey holding stake again, nothing missing (the swap undone, new stake on it, or a claim paid onto it as
    // stake): the mark is let go of, so the keeper never frees it on that mark; off the stake hotkey, the owner's
    // removeHotkey is said once (the T51 carry)
    for (const h of r.hotkeys) {
      const k = lower(h.hotkey);
      if (h.stakeRao > 0n && swapped.delete(k)) {
        const text = h.stakeHotkey ? undefined : freeWords(h);
        if (text !== undefined && said[`free:${k}`] !== text) deps.log(text);
        delete (mem.held ??= {})[k];
        delete said[`free:${k}`];
      }
    }
    if (said.missing) {
      delete said.missing;
      deps.log("Stake is no longer missing: all of the vault's booked stake is on its listed hotkeys again; closes and staking go on");
    }
  }
  mem.missing = w.stakeMissing;

  // stake on the vault's coldkey off its list
  if (w.unlistedStakeRao === undefined) {
    tell("unlisted", "Unlisted stake can't be read now (unlistedStakeRao reverted: the staking precompile can't total the vault's root stake); the monitor's stake.unlisted watches it");
  } else if (w.unlistedStakeRao > 0n) {
    tell(
      "unlisted",
      `UNLISTED STAKE: ${raoTao(w.unlistedStakeRao)} of the vault's root stake is on hotkeys it doesn't list (unlistedStakeRao). ${
        w.stakeMissing
          ? "Most likely the swap's new hotkey: list it and the stake counts again (pnpm ops add-hotkey <hotkey> --live --send; taostats shows the hotkey)"
          : "It is outside the books and the price (a gift, or stake sent to the vault's coldkey): nothing is lost; the monitor's stake.unlisted names the hotkey"
      }`,
    );
  } else tell("unlisted", undefined);

  // a swap's old hotkey: freed once it is no longer the stake hotkey, holds no stake and its credits read 0
  const frees: DueFree[] = [];
  const held = (mem.held ??= {});
  const listed = new Set(r.hotkeys.map((h) => lower(h.hotkey)));
  for (const h of r.hotkeys) {
    const k = lower(h.hotkey);
    if (!swapped.has(k)) continue;
    if (held[k] !== undefined && now >= held[k]) delete held[k];
    tell(`free:${k}`, freeWords(h));
    if (slotFreeable(h) && held[k] === undefined) {
      frees.push({ hotkey: h.hotkey, reason: `hotkey ${h.hotkey.slice(0, 10)}… (a swap's old hotkey) holds none of the vault's stake and its credits read 0: its slot is freed` });
    }
  }
  // a hotkey no longer listed (freed, or removed by anyone) is let go of
  for (const k of swapped) {
    if (listed.has(k)) continue;
    swapped.delete(k);
    delete held[k];
    delete said[`free:${k}`];
  }
  mem.swapped = [...swapped];

  // the root hold and the buffer rule
  let rootHold: string | undefined;
  if (w.rootHoldBlocks === undefined) {
    rootHold = "Bittensor's root stake hold (RootStakeUnlockInterval) can't be read, so the keeper takes it as set";
    tell(
      "hold",
      `ROOT HOLD UNREAD: Bittensor's RootStakeUnlockInterval can't be read now (${w.rootHoldUnread ?? "the storage-query precompile refused it"}): the keeper takes it as set, so claims wait while a payout is due; the monitor's root.hold_interval watches it`,
    );
  } else if (w.rootHoldBlocks > 0n) {
    rootHold = rootHoldWords(w.rootHoldBlocks, w.bittensorBlockS);
    tell("hold", `ROOT HOLD: ${rootHold}. ${bufferRule(w).text}. Claims wait while a payout is due`);
  } else tell("hold", undefined);
  return { frees, ...(rootHold !== undefined ? { rootHold } : {}) };
}

/** What the watch says of a swap's old hotkey, by where it stands. */
function freeWords(h: HotkeyRead): string {
  if (h.stakeHotkey) {
    return `Hotkey ${h.hotkey} lost its stake while stake was missing (a swap's old hotkey): it is still the stake hotkey, so its slot is freed only after the owner's setStakeHotkey moves new stake to another listed hotkey, and once its credits read 0`;
  }
  if (h.stakeRao > 0n) {
    return `Hotkey ${h.hotkey} (a swap's old hotkey) holds ${raoTao(h.stakeRao)} of the vault's stake again: the keeper never removes a hotkey with stake; the owner's removeHotkey frees it (pnpm ops remove-hotkey ${h.hotkey} --as owner --for-wallet --live), which moves that stake onto the stake hotkey`;
  }
  if (h.waitingWei > 0n) return `Hotkey ${h.hotkey} (a swap's old hotkey): ${tao(h.waitingWei)} of credits wait on it; they are claimed first, and its slot is freed once they read 0`;
  if (h.deferredProblem) return `Hotkey ${h.hotkey} (a swap's old hotkey) holds none of the vault's stake and its credits read 0, but its slot waits: ${h.deferredProblem}`;
  return `Hotkey ${h.hotkey} (a swap's old hotkey) holds none of the vault's stake and its credits read 0: the keeper frees its slot (removeHotkey)`;
}

/** Why the keeper can't remove `h` now (its own path: listed, not the stake hotkey, none of the vault's stake, credits 0),
 * or undefined. */
export function freeProblem(h: HotkeyRead | undefined, hotkey: Hex): string | undefined {
  const named = `hotkey ${hotkey}`;
  if (!h) return `${named} is not listed: there is nothing to free`;
  if (h.stakeHotkey) return `${named} is the stake hotkey: the owner's setStakeHotkey to another listed hotkey comes first`;
  if (h.stakeRao > 0n) return `${named} holds ${raoTao(h.stakeRao)} of the vault's stake: only the owner's removeHotkey moves it (pnpm ops remove-hotkey ${hotkey} --as owner --for-wallet --live)`;
  if (h.waitingWei > 0n) return `${tao(h.waitingWei)} of credits wait on ${named}: claim them first (pnpm ops claim ${hotkey} --live --send), and remove it once they read 0`;
  // R6b (U9): the deferred rewards the credits leave out
  if (h.deferredProblem) return h.deferredProblem;
  return undefined;
}

/** The reverts a removal or a listing can meet once it was decided (the chain moved under it), each a wait. */
const HOTKEY_REVERTS: Record<string, string> = {
  UnknownHotkey: "the hotkey is not listed (removed since)",
  HotkeyInUse: "the hotkey is the stake hotkey",
  NotAuthorized: "the hotkey holds stake, or unclaimed rewards above the dust allowance, so only the owner may remove it",
  HotkeyKnown: "the hotkey is listed already",
  TooManyHotkeys: "the vault's set of hotkeys is full (4)",
  SlotReserved: "the last of the 4 slots is kept for a swap's new hotkey: it takes a hotkey only while stake is missing and the hotkey holds at least the chain's minimum",
  ZeroHotkey: "the hotkey is zero",
};

/** A listing's or a removal's revert HOTKEY_REVERTS names (its simulation refused it, or the chain reverted it after it),
 * in words; undefined for anything else. */
function hotkeyRevert(e: unknown): { name: string; why: string; mined?: RevertedOnChain } | undefined {
  const reason = e instanceof SendRefused && e.reason === "estimate" ? e.message : e instanceof RevertedOnChain ? e.reason : undefined;
  const names = [...(reason ?? "").matchAll(/\b([A-Z][A-Za-z0-9]*)\(/g)].map((m) => m[1]);
  const name = names.reverse().find((n) => n in HOTKEY_REVERTS) ?? errorName(reason);
  if (!name || !(name in HOTKEY_REVERTS)) return undefined;
  return { name, why: HOTKEY_REVERTS[name], ...(e instanceof RevertedOnChain ? { mined: e } : {}) };
}

/** Frees `hotkey`'s slot (removeHotkey(hotkey, false), the keeper's removal; Task 53) when, read again now, the keeper may:
 * listed, not the stake hotkey, none of the vault's stake, credits 0 (freeProblem; else NotNow). A revert the table names
 * waits (the next round decides again); one with nothing to explain it, read again, holds that hotkey's removal a day
 * (HeldRefusal: never a stop, nothing is at risk), kept in `memory` (the round's). The round's frees come only from the
 * watch (a swap's old hotkey); the founder's hand remove-hotkey names its own. */
export async function freeV32(depsIn: KeeperDeps, t: KeeperTarget, hotkey: Hex, o: { memory?: KeeperMemory; now?: number } = {}): Promise<Done> {
  const deps = v32(depsIn);
  t.requireReady(deps.signer, deps);
  const r = await deps.readClaims();
  const h = r.hotkeys.find((x) => lower(x.hotkey) === lower(hotkey));
  const no = freeProblem(h, hotkey);
  if (no) throw new NotNow(`not freeing the slot: ${no}; nothing sent`);
  let sent: Sent;
  try {
    sent = await keeperSend(deps, removeHotkeyRequest(t, hotkey, await deps.nonce("bittensor")));
  } catch (e) {
    const x = hotkeyRevert(e);
    if (x) throw new Waits(`freeing hotkey ${hotkey.slice(0, 10)}…'s slot waits: ${x.why} (${x.name})${x.mined ? `; transaction ${x.mined.hash} reverted on chain` : ""}; the next round decides again`);
    if (e instanceof RevertedOnChain) {
      const after = await deps.readClaims().catch(() => undefined);
      if (after && !after.hotkeys.some((y) => lower(y.hotkey) === lower(hotkey))) throw new NotNow(`hotkey ${hotkey.slice(0, 10)}… was removed under the keeper's removal; transaction ${e.hash} reverted on chain`);
      const until = (o.now ?? Date.now()) + FREE_HOLD_MS;
      if (o.memory) (((o.memory.reads.hotkeys ??= {}) as WatchMemory).held ??= {})[lower(hotkey)] = until;
      throw new HeldRefusal(
        actionKey({ kind: "free", hotkey }),
        `the removal of hotkey ${hotkey.slice(0, 10)}… reverted on chain with nothing to explain it (transaction ${e.hash}): it waits until ${at(until)}; the keeper's other work goes on`,
      );
    }
    throw e;
  }
  deps.log(`Hotkey ${hotkey} removed from the vault's list (removeHotkey): its slot is free`);
  return { ...sent };
}

/** Why the keeper can't list `hotkey` now, read from the claims' reading, or undefined: listed already, or the set full. The
 * vault decides the rest (the reserved last slot), which the simulation names. */
export function addProblem(r: Pick<ClaimsRead, "hotkeys">, hotkey: Hex): string | undefined {
  if (r.hotkeys.some((h) => lower(h.hotkey) === lower(hotkey))) return `hotkey ${hotkey} is listed already`;
  if (r.hotkeys.length >= 4) return "the vault's set of hotkeys is full (4): a slot is freed first (pnpm ops remove-hotkey <hotkey> --live --send, or the owner's)";
  return undefined;
}

/** Lists `hotkey` on the vault (addHotkey, the keeper's: privileged, at any time; Task 53's hand add-hotkey), when, read
 * again now, it isn't listed and the set has room (addProblem; else NotNow). A revert the table names (the reserved last
 * slot, a hotkey listed meanwhile) is NotNow, said; anything else is thrown as it is. */
export async function addHotkeyV32(depsIn: KeeperDeps, t: KeeperTarget, hotkey: Hex): Promise<Done> {
  const deps = v32(depsIn);
  t.requireReady(deps.signer, deps);
  const no = addProblem(await deps.readClaims(), hotkey);
  if (no) throw new NotNow(`not listing it: ${no}; nothing sent`);
  let sent: Sent;
  try {
    sent = await keeperSend(deps, addHotkeyRequest(t, hotkey, await deps.nonce("bittensor")));
  } catch (e) {
    const x = hotkeyRevert(e);
    if (x) throw new NotNow(`not listed: ${x.why} (${x.name})${x.mined ? `; transaction ${x.mined.hash} reverted on chain` : ""}; nothing more sent`);
    throw e;
  }
  deps.log(`Hotkey ${hotkey} listed on the vault (addHotkey)`);
  return { ...sent };
}

/** Decodes a little-endian SCALE u64 as the storage-query precompile answers it: 0 for no entry ("0x"), undefined for
 * anything that isn't exactly 8 bytes of hex. */
export function decodeU64(data: unknown): bigint | undefined {
  if (data === "0x") return 0n;
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{16}$/.test(data)) return undefined;
  let x = 0n;
  for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(Number.parseInt(data.slice(2 + 2 * i, 4 + 2 * i), 16));
  return x;
}

/** Whether `data` is a SCALE u32 as the storage-query precompile answers one (exactly 4 bytes of hex): System.Number's
 * answer, which proves the precompile is there (readWatch). */
export function answersU32(data: unknown): boolean {
  return typeof data === "string" && /^0x[0-9a-fA-F]{8}$/.test(data);
}

/** Whether the watch would read again now: the vault's stake went missing or came back since its last reading. */
export function missingChanged(memory: KeeperMemory, stakeMissing: boolean | undefined): boolean {
  const mem = memory.reads.hotkeys as WatchMemory | undefined;
  return stakeMissing !== undefined && (mem?.missing ?? false) !== stakeMissing;
}
