import { formatEther, type Hex } from "viem";
import type { KeeperDeps, KeeperTarget } from "../actions.ts";
import type { ParkJob, ParkRef } from "../due.ts";
import { RevertedOnChain, SendRefused } from "../errors.ts";
import { HeldRefusal, NotNow, oneLine } from "../failures.ts";
import type { KeeperMemory } from "../memory.ts";
import { adoptionDue, type ClaimPolicy, claimFor, claimGasLimit } from "../rewards.ts";
import type { CallRequest, ChainName } from "../types.ts";
import type { Done } from "../actions.ts";
import { adoptV32, claimV32, closeV32, flushV32 } from "./actions.ts";
import { claimRoom } from "./claims.ts";
import { addHotkeyV32, addProblem, freeProblem, freeV32, rootHoldWords } from "./hotkeys.ts";
import { convertV32, parkGasAbove, parkJobV32, parksV32 } from "./parked.ts";
import { railsRefusal, railsV32 } from "./rails.ts";
import type { KeeperDepsV32 } from "./reads.ts";
import { laneFailures, laneWarning } from "./reexec.ts";
import { addHotkeyRequest, adoptRequest, claimRequest, convertParkRequest, deliverParkedRequest, dropParkedRequest, refundParkedRequest, removeHotkeyRequest } from "./requests.ts";

// The v3.2 keeper's hand one-shots beside pnpm ops reexec (Task 53): claim, adopt, add-hotkey, remove-hotkey and park. Each
// checks what the keeper's own round would check and says it, simulates its call, and sends only with --send (`o.send`),
// through the one send path: the live readiness first (handCommandV32), then the rails read now (a hold refuses everything
// but a token park's conversion during ForeverMoney's notice), the spend cap, and the Worker's lease (taken only to send:
// lease-client.ts). A check takes no lease and signs nothing. Each returns 0 (checked, or done) or 1 (refused: "Not sent:
// …", or nothing due).

const v32 = (deps: KeeperDeps): KeeperDepsV32 => {
  if (!("readWatch" in deps) || !("railsSeen" in deps)) throw new Error("a v3.2 hand command needs the v3.2 deps (v32/reads.ts depsV32); nothing sent");
  return deps as KeeperDepsV32;
};
const tao = (wei: bigint) => `${formatEther(wei)} TAO`;
const lower = (h: string) => h.toLowerCase();
const short = (h: Hex) => `${h.slice(0, 10)}…`;

/** The hand one-shot's own options: what it names (a hotkey, a park's key), whether it sends, how its words name the
 * record (--live), and the clock (ms). */
export interface HandOneShot {
  hotkey?: Hex;
  key?: Hex;
  send: boolean;
  live: boolean;
  now?: number;
}

/** How a one-shot is said, refused or sent: a line for the founder, "Not sent: …" with 1, and the send itself (a refusal
 * the send path makes, or a race the action names, is said as a refusal, never thrown). */
function speaker(deps: KeeperDepsV32) {
  const say = (line: string) => deps.log(line);
  const no = (why: string) => {
    say(`Not sent: ${why}`);
    return 1;
  };
  return { say, no };
}

/** The command again with --send, as the founder types it. */
const again = (cmd: string, live: boolean) => `Nothing sent. To send it: pnpm ops ${cmd}${live ? " --live" : ""} --send`;

/** `req` simulated from the keeper now: said, and whether it passes. */
async function simulated(deps: KeeperDepsV32, req: CallRequest, what: string): Promise<boolean> {
  const sim = await deps.simulate(req);
  if (sim.ok) deps.log(`Checked: ${what}: its simulation passes.`);
  else deps.log(`Not sent: ${what} would revert now (${sim.reason}).`);
  return sim.ok;
}

/** The rails read now, for a send on `chain`: why they refuse it, or undefined. */
async function railsSay(deps: KeeperDepsV32, memory: KeeperMemory, chain: ChainName, now: number, conversion = false): Promise<string | undefined> {
  return railsRefusal(await railsV32(deps, memory, now), { chain, ...(conversion ? { conversion: true } : {}) });
}

/** A send's own refusal or race, said: 1. A sent transaction: 0. */
async function sent(deps: KeeperDepsV32, f: () => Promise<{ hash: string; costWei: bigint; messageId?: string }>, live: boolean): Promise<number> {
  const { no, say } = speaker(deps);
  try {
    const d = await f();
    say(`Done (transaction ${d.hash}, cost ${formatEther(d.costWei)} TAO)`);
    if (d.messageId) say(`Bridge message ${d.messageId} sent. Follow it with: pnpm ops track ${d.messageId}${live ? " --live" : ""}`);
    return 0;
  } catch (e) {
    if (e instanceof NotNow || e instanceof HeldRefusal || e instanceof SendRefused) return no(oneLine(e.message));
    if (e instanceof RevertedOnChain) return no(`transaction ${e.hash} reverted on chain${e.reason ? ` (${e.reason})` : ""}`);
    throw e;
  }
}

/** pnpm ops close (v3.2; R4, C's unconfirmed item): the round's close, or while ForeverMoney's migration notice runs, the
 * notice's one close (flushV32: by its id, while flushProblem allows it). The round holds that flush while one of
 * Cascade's CCIP FAILUREs toward Bittensor has been open 30 minutes (its lane wait), and a stranger can force one; by
 * hand it goes after the lane's warning (lease-client.ts), the operator's call. Its redeem requests go with it (merge 7b):
 * R4-O's fix round refused them until the contract round's deferral, which landed (S-H1): while the vault's primary bridge
 * can't send payouts (canSendPayouts() false, from ForeverMoney's notice) the vault defers every door redeem
 * (RedeemDeferred), so none is burned into a queue the rail can't pay; refusing them would only hold the deposits back
 * from their last close before the migration. */
export async function closeByHand(depsIn: KeeperDeps, t: KeeperTarget): Promise<Done> {
  const deps = v32(depsIn);
  const s = await deps.readState();
  // the operator's own call: the close rule doesn't hold it at its first read, its floors are the round's (R12d, L-1)
  if (s.v32.alpha.migrationReadyAt === 0n) return closeV32(deps, t, { byHand: true });
  const n = s.frontDoor.nRedeems;
  if (n > 0) {
    deps.log(
      `The open batch ${s.v32.openId} holds ${n} redeem request${n === 1 ? "" : "s"}: while ForeverMoney's notice runs the vault defers ${n === 1 ? "it" : "each"} (RedeemDeferred: the old rail can't pay ${n === 1 ? "it" : "them"}), so the requester${n === 1 ? " keeps the shares and asks" : "s keep their shares and ask"} again once the replacement rail runs; the batch's deposits go across`,
    );
  }
  return flushV32(deps, t, s.v32.openId);
}

/** pnpm ops claim [<hotkey>] (v3.2): each listed hotkey's claim by the claim policy (a hotkey with none of the vault's stake
 * whenever credits wait on it, A17), the cap's room for its worst case, and the buffer rule (no claim while Bittensor's
 * root hold is set and a payout is due); with --send, the named hotkey's claim, or the first one due. */
export async function claimByHand(depsIn: KeeperDeps, t: KeeperTarget, memory: KeeperMemory, o: HandOneShot & { policy: ClaimPolicy }): Promise<number> {
  const deps = v32(depsIn);
  t.requireReady(deps.signer, deps);
  const { say, no } = speaker(deps);
  const r = await deps.readClaims();
  const room = await claimRoom(deps, r);
  const named = o.hotkey ? r.hotkeys.find((h) => lower(h.hotkey) === lower(o.hotkey as Hex)) : undefined;
  if (o.hotkey && !named) return no(`hotkey ${o.hotkey} is not listed on the vault`);
  const due: Hex[] = [];
  for (const h of named ? [named] : r.hotkeys) {
    const c = claimFor(h, r, o.policy);
    say(`Rewards on hotkey ${h.hotkey}: ${tao(h.waitingWei)} wait; ${c.claim ? "a claim is due" : "no claim due"} (${c.reason})`);
    if (c.claim) due.push(h.hotkey);
  }
  const hotkey = due[0];
  if (!hotkey) return no("no claim is due by the claim policy");
  if (room) return no(`the claim waits: ${room}`);
  // the buffer rule (Task 53): a claim stamps the pair it claims on, so none while the root hold is set and a payout is due
  const w = await deps.readWatch();
  const s = await deps.readState();
  const payoutDue = s.vault.batches.some((b) => b.cursor < b.count && s.now >= b.queuedAt + s.vault.payoutDelay);
  const hold = w.rootHoldBlocks === undefined ? "Bittensor's root stake hold (RootStakeUnlockInterval) can't be read" : w.rootHoldBlocks > 0n ? rootHoldWords(w.rootHoldBlocks, w.bittensorBlockS) : undefined;
  if (hold && payoutDue) return no(`claims wait while a payout is due: ${hold}, and a claim stamps the pair it claims on (the buffer rule); pay the batch out first (pnpm ops payouts${o.live ? " --live" : ""})`);
  const req = claimRequest(t, hotkey, claimGasLimit(r.claimGasRequired), await deps.nonce("bittensor"), r.feeCapWei);
  if (!(await simulated(deps, req, `the claim on hotkey ${hotkey} (a ${claimGasLimit(r.claimGasRequired).toLocaleString("en-US")} gas limit, ${tao(claimGasLimit(r.claimGasRequired) * r.feeCapWei)} up front at most)`))) return 1;
  if (!o.send) {
    say(again(`claim ${hotkey}`, o.live));
    return 0;
  }
  const why = await railsSay(deps, memory, "bittensor", o.now ?? Date.now());
  if (why) return no(why);
  return sent(deps, () => claimV32(deps, t, hotkey, o.policy, { memory, now: o.now ?? Date.now() }), o.live);
}

/** pnpm ops adopt (v3.2): whether the vault's surplus is due its adoption (at least the chain's minimum, the vault not
 * paused, no stake missing, a STAKE_RAMP since the last); with --send, adoptStake. */
export async function adoptByHand(depsIn: KeeperDeps, t: KeeperTarget, memory: KeeperMemory, o: HandOneShot): Promise<number> {
  const deps = v32(depsIn);
  t.requireReady(deps.signer, deps);
  const { say, no } = speaker(deps);
  const a = adoptionDue(await deps.readAdoption());
  say(`Adoption: ${a.adopt ? "due" : "not due"} (${a.reason})`);
  if (!a.adopt) return no("there is no surplus to adopt now");
  if (!(await simulated(deps, adoptRequest(t, await deps.nonce("bittensor")), "the adoption (adoptStake)"))) return 1;
  if (!o.send) {
    say(again("adopt", o.live));
    return 0;
  }
  const why = await railsSay(deps, memory, "bittensor", o.now ?? Date.now());
  if (why) return no(why);
  return sent(deps, () => adoptV32(deps, t), o.live);
}

/** pnpm ops add-hotkey <hotkey> (v3.2): the keeper's listing (addHotkey: privileged, at any time), refused when the hotkey
 * is listed already or the set is full; the vault decides the reserved last slot, which the simulation names. */
export async function addHotkeyByHand(depsIn: KeeperDeps, t: KeeperTarget, memory: KeeperMemory, o: HandOneShot): Promise<number> {
  const deps = v32(depsIn);
  t.requireReady(deps.signer, deps);
  const { say, no } = speaker(deps);
  const hotkey = o.hotkey as Hex;
  const r = await deps.readClaims();
  const problem = addProblem(r, hotkey);
  if (problem) return no(problem);
  const w = await deps.readWatch();
  say(`The vault lists ${r.hotkeys.length} of 4 hotkeys; stake is ${w.stakeMissing ? `missing (${tao(w.missingStakeRao * 10n ** 9n)})` : "not missing"}.`);
  if (!(await simulated(deps, addHotkeyRequest(t, hotkey, await deps.nonce("bittensor")), `listing hotkey ${hotkey} (addHotkey, as the keeper)`))) return 1;
  if (!o.send) {
    say(again(`add-hotkey ${hotkey}`, o.live));
    return 0;
  }
  const why = await railsSay(deps, memory, "bittensor", o.now ?? Date.now());
  if (why) return no(why);
  return sent(deps, () => addHotkeyV32(deps, t, hotkey), o.live);
}

/** pnpm ops remove-hotkey <hotkey> (v3.2): the keeper's removal (removeHotkey(h, false)), only of a listed hotkey that is
 * not the stake hotkey, holds none of the vault's stake and has no credits waiting (freeProblem); the owner's removal,
 * which moves stake, is a call file (pnpm ops remove-hotkey <hotkey> --as owner --for-wallet --live). */
export async function removeHotkeyByHand(depsIn: KeeperDeps, t: KeeperTarget, memory: KeeperMemory, o: HandOneShot): Promise<number> {
  const deps = v32(depsIn);
  t.requireReady(deps.signer, deps);
  const { say, no } = speaker(deps);
  const hotkey = o.hotkey as Hex;
  const r = await deps.readClaims();
  const h = r.hotkeys.find((x) => lower(x.hotkey) === lower(hotkey));
  const problem = freeProblem(h, hotkey);
  if (problem) return no(problem);
  if (!(await simulated(deps, removeHotkeyRequest(t, hotkey, await deps.nonce("bittensor")), `removing hotkey ${hotkey} (removeHotkey(h, false), as the keeper)`))) return 1;
  if (!o.send) {
    say(again(`remove-hotkey ${hotkey}`, o.live));
    return 0;
  }
  const why = await railsSay(deps, memory, "bittensor", o.now ?? Date.now());
  if (why) return no(why);
  return sent(deps, () => freeV32(deps, t, hotkey, { memory, now: o.now ?? Date.now() }), o.live);
}

/** pnpm ops park [<key>] (v3.2): the park job's own reading (parked.ts parksV32: only the registered door's parks to the
 * vault, each message rebuilt and checked; a delivery when its simulation passes, every token park's conversion while
 * ForeverMoney's notice runs, a refund at quoteRefund's fee under the cap after 14 days, an empty park dropped after it),
 * each due job said; with a park's key and --send, that park's job. Under a hold only a token park's conversion during
 * the notice goes (the founder's one exception). */
export async function parkByHand(depsIn: KeeperDeps, t: KeeperTarget, memory: KeeperMemory, o: HandOneShot): Promise<number> {
  const deps = v32(depsIn);
  t.requireReady(deps.signer, deps);
  const { say, no } = speaker(deps);
  const now = o.now ?? Date.now();
  const s = await deps.readState();
  const rails = await railsV32(deps, memory, now);
  const onlyConversions = rails.stop !== undefined && rails.migrationConversions === true;
  const work = (await parksV32(deps, memory, s, { now, onlyConversions })) ?? {};
  const due: (ParkRef & { job: "convert" | ParkJob["job"]; fee?: bigint; reason: string })[] = [
    ...(work.conversions ?? []).map((p) => ({ ...p, job: "convert" as const, reason: `token park ${short(p.key)} is due its conversion during ForeverMoney's migration notice` })),
    ...(work.parkJobs ?? []),
  ];
  for (const p of due) say(`Park ${p.key}: ${p.job === "convert" ? "convert (deliverParked during the notice)" : p.job} due: ${p.reason}${p.fee !== undefined ? ` (bridge fee ${tao(p.fee)})` : ""}`);
  if (!due.length) say("No park of Cascade's is due a job now.");
  if (!o.key) {
    if (o.send) return no("--send needs the park's key: pnpm ops park <key> --send");
    return due.length ? 0 : 1;
  }
  const p = due.find((x) => lower(x.key) === lower(o.key as Hex));
  if (!p) return no(`park ${o.key} is due no job now (see above)`);
  const ref: ParkRef = { key: p.key, recipient: p.recipient, sender: p.sender, message: p.message, ...(p.adapter ? { adapter: p.adapter } : {}) };
  const nonce = await deps.nonce("bittensor");
  const req =
    p.job === "convert"
      ? convertParkRequest(t, ref, nonce, await parkGasAbove(deps, ref))
      : p.job === "deliver"
        ? deliverParkedRequest(t, ref, nonce, await parkGasAbove(deps, ref))
        : p.job === "refund"
          ? refundParkedRequest(t, ref, p.fee ?? 0n, nonce)
          : dropParkedRequest(t, ref, nonce);
  if (!(await simulated(deps, req, `the ${p.job === "convert" ? "conversion" : p.job} of park ${short(p.key)}`))) return 1;
  // a refund goes toward Base: a CCIP FAILURE of Cascade's open on that lane is said (the round would hold it)
  if (p.job === "refund") {
    try {
      for (const f of await laneFailures(deps, "Bittensor → Base")) say(laneWarning(deps, f, "park refund"));
    } catch (e) {
      say(`WARNING: this command's lane (Bittensor → Base) could not be checked for a CCIP FAILURE of Cascade's (${oneLine((e as Error).message, 160)}); it goes on`);
    }
  }
  if (!o.send) {
    say(again(`park ${p.key}`, o.live));
    return 0;
  }
  const why = railsRefusal(await railsV32(deps, memory, now), { chain: "bittensor", ...(p.job === "convert" ? { conversion: true } : {}) });
  if (why) return no(why);
  return sent(
    deps,
    () => (p.job === "convert" ? convertV32(deps, t, ref) : parkJobV32(deps, t, { kind: "park", job: p.job as ParkJob["job"], ...ref, ...(p.fee !== undefined ? { fee: p.fee } : {}) }, { memory, now })),
    o.live,
  );
}
