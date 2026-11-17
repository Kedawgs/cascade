import { errorName } from "../send.ts";

// How the v3.2 keeper takes each revert the contracts added (plan Task 50, ruling B11 and A16): what it does when its
// simulation, or the chain, answers with one.

/** - `reread`: the batch changed under the call; read it again once (and send once more with what it reads), then wait;
 * - `stop-staking`: staking stops while the stake is missing, said loudly; the rest goes on;
 * - `wait`: try again later (for UnstakeShort: liquid TAO, a deposit, a stake or a reward; the buffer rule);
 * - `top-up`: the bridge fee is above what the entries pay: add it within OPS_PAYOUT_TOPUP_MAX, else wait (B11: the
 *   same error also means a walk's cost would leave an entry nothing, which no top-up fixes: it waits too);
 * - `full-top-up` (merge 7b, spec §3.3): a payout chunk's net is below the chain's conversion floor: refused by its
 *   simulation, the keeper sends it again with the whole fee as its value (the full top-up: its entries sent their gross),
 *   unless the floor is above the gross too (no top-up helps: it waits); mined (the floor rose after the simulation), it
 *   waits and the next round decides;
 * - `final`: nothing will change it: never tried again;
 * - `skip-delivery`: that user's delivery is skipped and retried, never counted against their revert budget (Task
 *   50a wires the delivery path);
 * - `report`: no keeper call should ever meet it: said loudly, and the call is not tried again;
 * - `stop`: the keeper's own mistake: `run` stops;
 * - `not-closable` (R12f): the batch can't close now (canClose() false at the call, true at the read before it: a cancel
 *   since took it under every line that let it close); the close reads it again once: no longer closable there, that is
 *   the round's quiet skip (never a count for the breaker); still closable, a refused simulation is sent once more (a
 *   second refusal counts) and a mined revert waits, counted (the notice's close the same; a roll's mined one is read
 *   again as before R12f). R12g: every mined revert of a close is read again so, whatever its class or none (v32/actions.ts
 *   minedClose): a batch that moved or shrank is the round's quiet skip, never a stop. */
export type RevertClass = "reread" | "stop-staking" | "wait" | "top-up" | "full-top-up" | "final" | "skip-delivery" | "report" | "stop" | "not-closable";

export const REVERTS_V32: Record<string, { class: RevertClass; why: string }> = {
  WrongBatch: { class: "reread", why: "the open batch is another one now (another close landed first)" },
  BatchTooSmall: { class: "reread", why: "the open batch holds less than when it was read (a deposit was cancelled)" },
  StakeMissing: { class: "stop-staking", why: "some of the vault's stake is not on a listed hotkey" },
  UnstakeShort: { class: "wait", why: "the free TAO and the stake the walk can take don't cover the chunk" },
  FeeTooHigh: { class: "top-up", why: "the bridge fee is above what the entries pay, or a walk's cost would leave an entry nothing" },
  NothingToCancel: { class: "final", why: "what is left is bounced deposits, which a cancel never undoes" },
  ThinPool: { class: "skip-delivery", why: "a pool is thinner than the front door's floor" },
  NotScheduled: { class: "report", why: "only the owner's scheduler reverts it; no keeper call should" },
  AboveBridgeCap: { class: "report", why: "only a limit setter reverts it; no keeper call should" },
  BadValue: { class: "stop", why: "the keeper's top-up is not whole rao" },
  BelowConversionFloor: { class: "full-top-up", why: "the chunk's net, after the entries' fee, is below the chain's conversion floor (the adapter's floor(), the minimum stake)" },
  // Revision 28's gas guard: a capped read of the chain's minimums (or the write-off's) reverts InsufficientGas unless it can
  // be given its whole 100,000 (about 106,600 left when it starts), as a claim does below its claimGasRequired; the
  // keeper's estimate covers it, so only a send that ran short after its estimate meets it, and the next round estimates
  // again. Named so a mined one waits rather than stopping the keeper as a revert nothing explains.
  InsufficientGas: { class: "wait", why: "the call ran short of gas (the contract's gas guard: a capped read must start with its whole 100,000, a claim with its claimGasRequired)" },
  // R11, the cancel cooldown: only a depositor's own cancelDeposit before its cancelableAt reverts it (classifyRevert adds
  // the second it names); no keeper call cancels a deposit
  CancelTooSoon: { class: "report", why: "a depositor's cancel inside its five-minute cooldown (CANCEL_COOLDOWN after its last deposit); no keeper call cancels" },
  // R12f: a holder's cancel landing between the close's own read and its simulation (or after the simulation, mined), timed
  // against a keeper that runs each minute on Base's 2-second blocks: named so the close reads the batch again rather than
  // counting it for the breaker as a refusal nothing explains (three of those skip the close 5 to 60 minutes)
  BatchNotReady: { class: "not-closable", why: "the open batch can't close now (canClose() went false since the read: a cancel took it under every line that let it close, or a roll restarted its timer)" },
};

/** The second a CancelTooSoon(cancelableAt) in `reason` names (its one argument, by position), or undefined. */
export function cancelableAtIn(reason: string | undefined): number | undefined {
  const m = /\bCancelTooSoon\((\d+)\)/.exec(reason ?? "");
  return m ? Number(m[1]) : undefined;
}

/** The net and the floor a BelowConversionFloor(amount, floor) in `reason` names, or undefined. */
export function conversionFloorIn(reason: string | undefined): { net: bigint; floor: bigint } | undefined {
  const m = /\bBelowConversionFloor\((\d+), (\d+)\)/.exec(reason ?? "");
  return m ? { net: BigInt(m[1]), floor: BigInt(m[2]) } : undefined;
}

/** What a revert's reason ("WrongBatch(9)", "Base: … would fail, nothing sent (FeeTooHigh())") says: the error's name
 * and how the keeper takes it, when it is one REVERTS_V32 names. */
export function classifyRevert(reason: string | undefined): { name?: string; class?: RevertClass; why?: string } {
  const names = [...(reason ?? "").matchAll(/\b([A-Z][A-Za-z0-9]*)\(/g)].map((m) => m[1]);
  const name = names.reverse().find((n) => n in REVERTS_V32) ?? errorName(reason);
  const r = name ? REVERTS_V32[name] : undefined;
  // R11: a cancel refused for its cooldown says when it works, in UTC
  const at = name === "CancelTooSoon" ? cancelableAtIn(reason) : undefined;
  const why = at !== undefined && r ? r.why.replace("; no keeper", `: it works from ${new Date(at * 1000).toISOString()} (unix ${at}); no keeper`) : r?.why;
  return { name, class: r?.class, why };
}
