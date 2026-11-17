import { type Address, decodeErrorResult, decodeFunctionData, type Hex } from "viem";
import { CCV_ERRORS, ERRORS_V32, OFFRAMP_EXECUTE } from "../abi.ts";
import { type Done, type KeeperDeps, type KeeperTarget, keeperSend } from "../actions.ts";
import { type Action, actionKey, type DueReexec, type State } from "../due.ts";
import { RevertedOnChain, SendRefused } from "../errors.ts";
import { HeldRefusal, inWords, NotNow, oneLine } from "../failures.ts";
import type { DeploymentV32 } from "../deployment.ts";
import type { KeeperMemory } from "../memory.ts";
import { SKIP_MAX_MS, SKIP_MS } from "../round.ts";
import type { CallRequest, Sent } from "../types.ts";
import { type Direction, decodeMessageV1, type Lane, laneOf, pairOfSent, rebuildProblem } from "./ccip.ts";
import { emptyResult, executionInputsUrl, proofFromInputs } from "./ccip-api.ts";
import type { CascadeSent, KeeperDepsV32 } from "./reads.ts";
import { reexecRequest } from "./requests.ts";

// Task 52's CCIP FAILURE watch and re-execution (design-keeper-worker.md §8; R3 CC-L2, CC-L4, F5, c1), as the founder
// ruled it in fix round 1 ("we need to play very safe ... fail safe"). A message of Cascade's own can sit in CCIP FAILURE
// on its destination's OffRamp: a lock held around a stranger's code (F5, c1), the destination pool's inbound rate limit
// (CC-L4), a stranger's attempt with junk results, too little gas or from inside a lock (CC-L2), or a receiver that ran
// out of gas. Nothing is written in FAILURE, and a re-execution that passes delivers it exactly once. Every execution, a
// FAILURE's included, needs the committee's results for that message (the deployed OffRamp 2.0.0 checks the CCV quorum and
// each CCV's verifyMessage on every execute, OffRamp.sol:340-352): a re-execution takes them from the calldata of an
// attempt that wrote them (reexecProof). The job:
// - watches only Cascade's own messages: each source adapter's Sent whose payload runs from the door to the vault (Base →
//   Bittensor) or from the vault to the door (Bittensor → Base) (reads.ts cascadeSent), reading each one's state on its
//   destination's OffRamp until it is SUCCESS, a few a pass; someone else's FAILURE is never read, nor re-executed;
// - rebuilds a FAILURE's bytes from its source OnRamp's CCIPMessageSent and checks them against the failure's on-chain
//   record (ccip.ts rebuildProblem): a mismatch refuses, for good;
// - by default (the deployment's reexecAuto off: OPS_REEXEC_AUTO unset) re-executes nothing: it reports each FAILURE
//   loudly when first found, then about hourly, with its lane, its age and the hand command (pnpm ops reexec, reexec-hand.ts);
// - while one of them has been open LANE_WAIT_MS, says so to the round (laneWaits), which then sends nothing new on that
//   lane (due.ts decideNext): toward Bittensor no close and no flush, toward Base no payout and no park refund; but never for
//   a FAILURE whose failing attempt never reached Cascade's receiver (Task 65, the T61a review's I-1: a stranger's empty or
//   junk proof, refused inside the OffRamp: neverReachedReceiver), which says so and holds nothing;
// - with reexecAuto on (only after the rehearsals): re-executes it with OffRamp 2.0.0's execute(encodedMessage, ccvs,
//   verifierResults, gasLimitOverride), the committee's results taken from the attempt that wrote the FAILURE, checked to
//   cover getCCVsForMessage, a raised gas limit (reexecGasLimit), and an explicit simulation first (prepareReexec), through
//   the one send path (so the rails apply: a hold stops it, and the spend cap); on a back-off, SKIP_MS doubling to
//   SKIP_MAX_MS, each refusal reported (HeldRefusal), never a keeper stop.

/** The most gas a re-execution gives the receiver: twice the adapters' GAS_CAP (7,000,000). */
export const REEXEC_GAS_CEILING = 14_000_000;
/** How often the job reads when nothing is due (and whenever a back-off ends): every 5 rounds. */
export const REEXEC_EVERY_TICKS = 5;
/** The most message states read in one pass (the FAILUREs first, then the longest unread). */
export const STATES_PER_PASS = 8;
/** A Cascade FAILURE open this long on a lane stops new sends on that lane (review (iv), the cautious reading): toward
 * Bittensor the closes and the notice's flush, toward Base the payouts and the park refunds. Short of it, a stranger's
 * cheap FAILURE, which Chainlink's own attempt clears within minutes, stops nothing. */
export const LANE_WAIT_MS = 30 * 60_000;
/** How often an open FAILURE is reported again: about hourly. */
export const FAILURE_REPORT_MS = 60 * 60_000;
/** How long a FAILURE whose failing attempt never reached Cascade's receiver holds no lane (R5 Minor 1): Chainlink's
 * docs give its executor 8 hours to retry a FAILURE, and half an hour more. Past it the lane waits as for any FAILURE: an
 * honest attempt failing at the receiver after a stranger's empty proof logs nothing (NoStateProgressMade), and a
 * systemic refusal of the proof would otherwise let every new message fail too. */
export const OUTSIDE_WAIT_MS = 8.5 * 3_600_000;
/** OffRamp 2.0.0's execution states. */
const UNTOUCHED = "UNTOUCHED";
const SUCCESS = "SUCCESS";
const FAILURE = "FAILURE";

/** A re-execution's receiver gas limit (gasLimitOverride): 1.5 times the message's own (`limit`), half its own again at
 * each failed try before (`tries`), at most REEXEC_GAS_CEILING, never under the message's own (a lower non-zero override
 * reverts, OffRamp.sol:222-224). */
export function reexecGasLimit(limit: number, tries: number): number {
  const raised = Math.ceil((limit * (3 + tries)) / 2);
  return Math.max(limit, Math.min(raised, REEXEC_GAS_CEILING));
}

/** Why `gas` is not a re-execution's gas limit for a message whose own is `own`, or undefined: at least its own, at most
 * REEXEC_GAS_CEILING (reexecGasLimit's bounds). */
export function gasProblem(gas: number, own: number): string | undefined {
  if (!Number.isInteger(gas) || gas < own) return `a ${gas.toLocaleString("en-US")} gas limit is under the message's own ${own.toLocaleString("en-US")} (the OffRamp refuses it)`;
  if (gas > REEXEC_GAS_CEILING) return `a ${gas.toLocaleString("en-US")} gas limit is above the keeper's ceiling of ${REEXEC_GAS_CEILING.toLocaleString("en-US")}`;
  return undefined;
}

/** The committee's results a re-execution carries, and where they come from: an execution attempt's calldata (`source`,
 * its hash), or a proof file (pnpm ops reexec --proof: the re-review's N2); `from` says which, in words. */
export interface ReexecProof {
  ccvs: Address[];
  verifierResults: Hex[];
  source?: Hex;
  from: string;
}

/** The committee's results given whole, from a proof file or hex (reexec-hand.ts parseProofFile): its CCVs and results,
 * the message bytes it names when it names any (another execute's calldata, the CCIP API's answer: checked against this
 * message's), its name as typed, and `from` in words. */
export interface GivenProof {
  ccvs: Address[];
  verifierResults: Hex[];
  encoded?: Hex;
  file: string;
  from: string;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const short = (id: Hex) => `${id.slice(0, 10)}…`;
const at = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const chainName = (lane: Lane) => (lane.dest === "base" ? "Base" : "Bittensor");

/** A span of time in words: "under a minute", "12 min", "3 h 5 min", "2 days 4 h". */
export function span(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h${min % 60 ? ` ${min % 60} min` : ""}`;
  const days = Math.floor(h / 24);
  return `${days} day${days === 1 ? "" : "s"}${h % 24 ? ` ${h % 24} h` : ""}`;
}

/** The proof a re-execution of message `sent` (its `encoded` bytes, rebuilt and checked) on `lane` carries, from the first
 * of these that has it (Task 65 added the third):
 * 1. given whole, with --proof (a file, or another execute's calldata as hex: its bytes must be this message's);
 * 2. the calldata of an execution attempt on the destination's OffRamp: `fromTx`, else by default the transaction that
 *    wrote its FAILURE (found by the OffRamp's ExecutionStateChanged), unless it carried no committee results (a
 *    stranger's empty proof). Refused unless that transaction was sent to this OffRamp, calls its execute with exactly
 *    these bytes, and carries as many results as CCVs;
 * 3. when the attempt that wrote the FAILURE carries none (or can't be read) and no --from-tx is named: Chainlink's CCIP
 *    API (deps.executionInputs, ccip-api.ts: the committee's results the CCIP Indexer collected), its answer checked
 *    against these bytes and this lane's OffRamp.
 * The results are the committee's signatures over this message's id: they fit it only, and the OffRamp checks them again.
 * Also the error the FAILURE was written with (`firstError`), when its log is found. */
export async function reexecProof(
  deps: KeeperDepsV32,
  lane: Lane,
  sent: Pick<CascadeSent, "id" | "block">,
  encoded: Hex,
  o: { fromTx?: Hex; proof?: GivenProof; fresh?: boolean } = {},
): Promise<{ ok: ReexecProof; firstError?: Hex } | { problem: string; firstError?: Hex }> {
  const chain = chainName(lane);
  const f = await deps.failureOf(lane.direction, sent.id, sent.block, o.fresh ? { fresh: true } : {});
  const firstError = "found" in f ? f.found.returnData : undefined;
  const no = (problem: string) => ({ problem, ...(firstError ? { firstError } : {}) });
  // the results given whole (an executor that calls the OffRamp through its own contract: no calldata of an execute
  // carries them); checked as any proof is, after this: the CCVs they must cover, then the simulation (the OffRamp checks
  // them again: a bad one only makes the call revert)
  if (o.proof) {
    const p = o.proof;
    if (p.ccvs.length !== p.verifierResults.length) return no(`${p.from} carries ${p.ccvs.length} committees and ${p.verifierResults.length} results, which the OffRamp refuses`);
    if (p.encoded !== undefined && !same(p.encoded, encoded)) return no(`${p.from} executes other bytes than this message's: give the results of this message`);
    return { ok: { ccvs: [...p.ccvs], verifierResults: [...p.verifierResults], from: p.from }, ...(firstError ? { firstError } : {}) };
  }
  const attempt = await attemptProof(deps, lane, chain, f, encoded, o.fromTx);
  if (o.fromTx) return "ok" in attempt ? { ok: attempt.ok, ...(firstError ? { firstError } : {}) } : no(attempt.problem);
  const empty = "ok" in attempt && attempt.ok.verifierResults.some(emptyResult);
  if ("ok" in attempt && !empty) return { ok: attempt.ok, ...(firstError ? { firstError } : {}) };
  // nothing usable on chain: Chainlink's CCIP API, where the host reads it
  const url = executionInputsUrl(sent.id);
  let api: string | undefined;
  if (deps.executionInputs) {
    const a = await deps.executionInputs(sent.id.toLowerCase() as Hex);
    const p = "inputs" in a ? proofFromInputs(a.inputs, encoded, lane.offRamp, chain) : a;
    if (!("problem" in p)) return { ok: { ...p, from: `Chainlink's CCIP API (${url})` }, ...(firstError ? { firstError } : {}) };
    api = p.problem;
  }
  const elsewhere = "from another attempt that carries them (--from-tx <hash>), or give them with --proof <file | 0x…>";
  if (empty && "ok" in attempt) {
    const none = attempt.ok.verifierResults.every(emptyResult) ? "carried no committee results" : "carried an empty committee result";
    const what = `the attempt that wrote its FAILURE (${attempt.ok.from}) ${none}`;
    return no(api === undefined ? `${what} (a stranger's, most likely): take them from Chainlink's CCIP API (${url}; pnpm ops reexec reads it on this PC), ${elsewhere}` : `${what}, and Chainlink's CCIP API gave none (${api}): take them ${elsewhere}`);
  }
  const problem = (attempt as { problem: string }).problem;
  return no(api === undefined ? problem : `${problem}; Chainlink's CCIP API gave none either (${api})`);
}

/** The proof in the calldata of an execution attempt on `lane`'s OffRamp: `fromTx`, else the transaction that wrote the
 * FAILURE (`f`), as reexecProof's second source reads it. */
async function attemptProof(
  deps: KeeperDepsV32,
  lane: Lane,
  chain: string,
  f: Awaited<ReturnType<KeeperDepsV32["failureOf"]>>,
  encoded: Hex,
  fromTx: Hex | undefined,
): Promise<{ ok: ReexecProof } | { problem: string }> {
  const no = (problem: string) => ({ problem });
  const source = fromTx ?? ("found" in f ? f.found.tx : undefined);
  if (!source) {
    if ("partial" in f) {
      const p = f.partial;
      return no(`the transaction that wrote its FAILURE could not be looked for in full (${chain}'s blocks ${p.from} to ${p.to}, read to ${p.scannedTo}: ${oneLine((p.error as Error)?.message ?? String(p.error), 160)}); try again`);
    }
    const r = "none" in f ? f.none : { from: 0n, to: 0n };
    return no(`no transaction that wrote its FAILURE was found on ${chain}'s OffRamp (blocks ${r.from} to ${r.to}): name an honest attempt with --from-tx <hash>`);
  }
  const tx = await deps.transactionOf(lane.dest, source);
  if (!tx) return no(`${chain} knows no transaction ${source}`);
  if (!tx.to || !same(tx.to, lane.offRamp)) {
    return no(
      `transaction ${source} was not sent to ${chain}'s OffRamp ${lane.offRamp} (an executor's own contract, perhaps): name an attempt that calls the OffRamp's execute with --from-tx <hash>, or give the committee's results with --proof <file>`,
    );
  }
  let args: readonly [Hex, readonly Address[], readonly Hex[], number];
  try {
    args = decodeFunctionData({ abi: OFFRAMP_EXECUTE, data: tx.input }).args as typeof args;
  } catch {
    return no(`transaction ${source} does not call the OffRamp's execute: name one that does with --from-tx <hash>`);
  }
  const [bytes, ccvs, results] = args;
  if (!same(bytes, encoded)) return no(`transaction ${source} executes other bytes than this message's: name an attempt of this message with --from-tx <hash>`);
  if (ccvs.length !== results.length) return no(`transaction ${source} carries ${ccvs.length} committees and ${results.length} results, which the OffRamp refuses`);
  return { ok: { ccvs: [...ccvs], verifierResults: [...results], source, from: `transaction ${source}` } };
}

/** The OffRamp's own refusals of a proof, each before it calls the receiver (docs.chain.link manual execution, Phase B:
 * a required CCV missing, the optional quorum unmet, a result its resolver can't map, which an empty one is; and the
 * Committee Verifier's checks of the result itself). */
const PROOF_REFUSALS = new Set([
  "InboundImplementationNotFound",
  "RequiredCCVMissing",
  "OptionalCCVQuorumNotReached",
  "InvalidVerifierResults",
  "InvalidCCVVersion",
  "WrongNumberOfSignatures",
  "UnauthorizedSigner",
  "NonOrderedOrNonUniqueSignatures",
]);

/** Why the attempt that wrote a FAILURE never reached Cascade's receiver (Task 65, the T61a review's I-1), or undefined
 * when it did or that can't be told: from the error it logged (`returnData`, ExecutionStateChanged's), the OffRamp
 * refused its committee results before calling the receiver (PROOF_REFUSALS); or, from its calldata (`tx`, sent straight
 * to `offRamp`'s execute), it carried no committee results at all (each too short for a version tag: the docs' "Any
 * revert from verifyMessage ... the receiver is not called"). A receiver's or a token pool's failure (ReceiverError,
 * TokenHandlingError), an attempt through a contract, or nothing read, is undefined: the lane's rule as before. */
export function neverReachedReceiver(returnData: Hex | undefined, tx: { to: Address | null; input: Hex } | null | undefined, offRamp: Address): string | undefined {
  let name: string | undefined;
  if (returnData && returnData !== "0x") {
    try {
      name = decodeErrorResult({ abi: ALL_ERRORS, data: returnData }).errorName;
    } catch {
      name = undefined;
    }
  }
  if (name === "ReceiverError" || name === "TokenHandlingError") return undefined;
  if (name && PROOF_REFUSALS.has(name)) return `the OffRamp refused its committee results (${errorWords(returnData as Hex)}) before it called Cascade's receiver`;
  if (!tx?.to || !same(tx.to, offRamp)) return undefined;
  let results: readonly Hex[];
  try {
    results = (decodeFunctionData({ abi: OFFRAMP_EXECUTE, data: tx.input }).args as readonly [Hex, readonly Address[], readonly Hex[], number])[2];
  } catch {
    return undefined;
  }
  if (!results.every(emptyResult)) return undefined;
  return `it carried no committee results (${results.length ? `${results.length} empty` : "none"})`;
}

/** The failing attempt of FAILURE `id` on `lane`, read (the OffRamp's log of it, then its calldata): whether it never
 * reached Cascade's receiver (`outside`, why), or `{}` when it did or can't be told; undefined while its log isn't found
 * (read again at the next pass). */
async function attemptOf(deps: KeeperDepsV32, lane: Lane, sent: Pick<CascadeSent, "id" | "block">): Promise<{ outside?: string } | undefined> {
  const f = await deps.failureOf(lane.direction, sent.id, sent.block);
  if (!("found" in f)) return undefined;
  // a read that fails is thrown, so the next pass reads again (R5 Minor 7): never kept as "can't tell"
  const tx = await deps.transactionOf(lane.dest, f.found.tx);
  const why = neverReachedReceiver(f.found.returnData, tx, lane.offRamp);
  return why ? { outside: why } : {};
}

/** Why `proof`'s committees do not cover what the OffRamp requires for the message (getCCVsForMessage: every required
 * CCV, and `threshold` of the optional ones), or undefined. */
export function ccvProblem(proof: Pick<ReexecProof, "ccvs">, need: { required: readonly Address[]; optional: readonly Address[]; threshold: number }): string | undefined {
  const has = new Set(proof.ccvs.map((c) => c.toLowerCase()));
  const missing = need.required.filter((c) => !has.has(c.toLowerCase()));
  if (missing.length) return `lack the committee${missing.length === 1 ? "" : "s"} the OffRamp requires (${missing.join(", ")})`;
  const got = need.optional.filter((c) => has.has(c.toLowerCase())).length;
  if (got < need.threshold) return `cover ${got} of the ${need.threshold} optional committees the OffRamp requires`;
  return undefined;
}

const ALL_ERRORS = [...ERRORS_V32, ...CCV_ERRORS];

/** A revert's data in words: the error's name and arguments (the v3.2 errors, the OffRamp's, the committee's, an
 * Error(string)), "no reason given" for none, else its first bytes. */
function errorWords(data: Hex): string {
  if (data === "0x") return "no reason given";
  try {
    const d = decodeErrorResult({ abi: [...ALL_ERRORS, { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }], data });
    return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
  } catch {
    return `revert data ${data.slice(0, 74)}${data.length > 74 ? "…" : ""}`;
  }
}

/** What an execution attempt's inner error (NoStateProgressMade's, or ExecutionStateChanged's returnData) says: the
 * receiver failed, the token's pool failed, it failed with no reason (out of gas), or the proof was refused (the CCVs,
 * the committee's verifier, or anything else inside the OffRamp's checks). */
export function innerFailure(err: Hex): { kind: "receiver" | "pool" | "gas" | "proof"; words: string } {
  if (err === "0x") return { kind: "gas", words: "no reason given (out of gas, perhaps)" };
  try {
    const d = decodeErrorResult({ abi: ALL_ERRORS, data: err });
    if (d.errorName === "ReceiverError") return { kind: "receiver", words: `the receiver failed: ${errorWords(d.args[0] as Hex)}` };
    if (d.errorName === "TokenHandlingError") return { kind: "pool", words: `the token's pool failed: ${errorWords(d.args[1] as Hex)}` };
    return { kind: "proof", words: errorWords(err) };
  } catch {
    return { kind: "proof", words: errorWords(err) };
  }
}

/** Why a re-execution's simulation was refused, in words (review (iii) 6): from FAILURE a failed attempt reverts
 * NoStateProgressMade, whose inner error says whether the receiver failed again (its cause is still there), the token's
 * pool did, it ran out of gas, or the committee's results were refused (junk, or outdated). */
export function explainReexecRefusal(data: Hex | undefined, reason: string): { kind: "receiver" | "pool" | "gas" | "proof" | "other"; why: string } {
  if (data === undefined) return { kind: "other", why: `it could not be simulated (${reason})` };
  let d: ReturnType<typeof decodeErrorResult>;
  try {
    d = decodeErrorResult({ abi: ALL_ERRORS, data });
  } catch {
    return { kind: "other", why: `the OffRamp refused it (${reason})` };
  }
  if (d.errorName === "NoStateProgressMade") {
    const i = innerFailure(d.args[1] as Hex);
    if (i.kind === "receiver") return { kind: "receiver", why: `the receiver failed again (${i.words}): its cause is still there` };
    if (i.kind === "pool") return { kind: "pool", why: `the token's pool failed again (${i.words})` };
    if (i.kind === "gas") return { kind: "gas", why: "it failed again with no reason given (out of gas, perhaps: try more with --gas)" };
    return { kind: "proof", why: `the committee's results were refused (${i.words}): try --from-tx with a later honest attempt` };
  }
  if (["RequiredCCVMissing", "OptionalCCVQuorumNotReached", "InvalidVerifierResultsLength", "InboundImplementationNotFound"].includes(d.errorName)) {
    return { kind: "proof", why: `the committee's results were refused (${errorWords(data)}): try --from-tx with a later honest attempt` };
  }
  if (d.errorName === "SkippedAlreadyExecutedMessage") return { kind: "other", why: "it was delivered meanwhile (SkippedAlreadyExecutedMessage)" };
  return { kind: "other", why: `the OffRamp refused it (${errorWords(data)})` };
}

/** A re-execution ready to sign: its request, the proof it carries, the error its FAILURE was written with. */
export interface PreparedReexec {
  request: CallRequest;
  proof: ReexecProof;
  firstError?: Hex;
}

/** Everything a re-execution of message `sent` (its bytes `encoded`, rebuilt and checked) checks before it is signed,
 * after its state (review (iii) 3 to 6): its proof from an execution attempt's calldata (reexecProof), the proof covering
 * what the OffRamp requires (ccvProblem, getCCVsForMessage read now), the gas within reexecGasLimit's bounds
 * (gasProblem), then its simulation (an eth_call of the very request), a refusal explained (explainReexecRefusal). From
 * FAILURE a re-run either delivers or reverts, so a simulation that passes means the message is delivered. */
export async function prepareReexec(
  deps: KeeperDepsV32,
  lane: Lane,
  sent: Pick<CascadeSent, "id" | "block">,
  encoded: Hex,
  o: { gas: number; nonce: number; fromTx?: Hex; proof?: GivenProof; fresh?: boolean },
): Promise<{ ok: PreparedReexec } | { problem: string; firstError?: Hex }> {
  const p = await reexecProof(deps, lane, sent, encoded, { fromTx: o.fromTx, proof: o.proof, fresh: o.fresh });
  if ("problem" in p) return p;
  const fe = p.firstError ? { firstError: p.firstError } : {};
  const need = await deps.ccvsFor(lane.direction, encoded);
  const c = ccvProblem(p.ok, need);
  if (c) return { problem: `the committee's results in ${p.ok.from} ${c}: ${o.proof ? "correct the proof file so it carries them" : "name an attempt that carries them with --from-tx <hash>"}`, ...fe };
  // never sent with an empty result (Task 65): the OffRamp would only write another refusal, or revert
  const blank = p.ok.verifierResults.findIndex(emptyResult);
  if (blank >= 0) {
    return {
      problem: `the committee's results in ${p.ok.from} hold an empty result (for ${p.ok.ccvs[blank]}): the OffRamp would only refuse them; never sent empty: take them from Chainlink's CCIP API (${executionInputsUrl(sent.id)}), from another attempt (--from-tx <hash>), or give them with --proof <file | 0x…>`,
      ...fe,
    };
  }
  const g = gasProblem(o.gas, decodeMessageV1(encoded).ccipReceiveGasLimit);
  if (g) return { problem: g, ...fe };
  const request = reexecRequest(lane, sent.id, encoded, p.ok, o.gas, o.nonce);
  const sim = await deps.simulate(request);
  if (!sim.ok) return { problem: `its simulation refuses it: ${explainReexecRefusal(sim.data, sim.reason).why}`, ...fe };
  return { ok: { request, proof: p.ok, ...fe } };
}

interface Watched {
  /** Its lane, and its Sent's block and token amount (what its bytes are checked against) */
  direction?: Direction;
  /** The adapter that sent it (R4, D-M2: its pair); absent: the deploy's */
  adapter?: Address;
  block?: bigint;
  amount?: bigint;
  /** The state last read, and when (the round's clock, ms) */
  state?: string;
  checkedAt?: number;
  /** When the keeper first read it in FAILURE (ms): its age for the reports and the lane wait (a lower bound); or, read in
   * FAILURE the first time the keeper ever read it, its send's time (ageFrom "sent": the re-review's N4) */
  firstSeen?: number;
  ageFrom?: "sent";
  /** When it was last reported (ms) */
  reportedAt?: number;
  /** A FAILURE's bytes, rebuilt and checked */
  encoded?: Hex;
  /** Task 65: its failing attempt, once read: `outside` (why) when it never reached Cascade's receiver (it holds no lane),
   * `{}` when it did or can't be told */
  attempt?: { outside?: string };
}

interface ReexecMemory {
  said?: Record<string, string>;
  /** Cascade's messages not yet SUCCESS, by lowercase id */
  watch?: Record<string, Watched>;
  /** Cascade's messages read SUCCESS (lowercase ids), not read again */
  done?: string[];
  /** FAILUREs whose rebuild did not match: never re-executed (why) */
  refused?: Record<string, string>;
  /** Each FAILURE's failed tries in a row, and when it is tried again (ms): the automatic mode's back-off */
  tries?: Record<string, { n: number; nextAt: number }>;
  /** The last pass found one due, and the earliest a back-off ends: read again then (the automatic mode) */
  goable?: boolean;
  nextTry?: number;
}

const reexecMemory = (memory: KeeperMemory): ReexecMemory => (memory.reads.reexec ??= {}) as ReexecMemory;

const v32 = (deps: KeeperDeps): KeeperDepsV32 => {
  if (!("cascadeSent" in deps) || !("railsSeen" in deps)) throw new Error("v3.2's re-execution needs the v3.2 deps (v32/reads.ts depsV32); nothing sent");
  return deps as KeeperDepsV32;
};

/** The lane message `sent` runs on, through the pair that sent it (R4, D-M2), or why it can't be named. */
export function laneOfSent(d: DeploymentV32, sent: Pick<CascadeSent, "direction" | "adapter">): Lane | string {
  const pair = pairOfSent(d, sent);
  if (!pair) return `its adapter ${sent.adapter} is not one of the deployment's adapter pairs`;
  return laneOf(d, sent.direction, pair);
}

/** `sent`'s bytes, rebuilt from its source OnRamp and checked (ccip.ts rebuildProblem, with its Sent's amount), or why not. */
export async function rebuilt(deps: KeeperDepsV32, lane: Lane, sent: Pick<CascadeSent, "id" | "block" | "amount" | "direction" | "adapter">): Promise<{ encoded: Hex } | { problem: string }> {
  const encoded = await deps.onRampMessage(sent.direction, sent.block, sent.id, sent.adapter);
  if (!encoded) return { problem: `its source OnRamp logged no CCIPMessageSent for it at block ${sent.block}, where its Sent is` };
  const r = rebuildProblem(lane, sent.id, encoded, sent.amount);
  return "problem" in r ? r : { encoded };
}

/** The hand command for message `id` (reexec-hand.ts), as the reports name it: `live` names the live record (--live, as in
 * every command), `send` sends (--send; without it the command only checks). */
export const handCommand = (id: Hex, o: { live?: boolean; send?: boolean } = {}) => `pnpm ops reexec ${id.toLowerCase()}${o.live ? " --live" : ""}${o.send ? " --send" : ""}`;
/** Whether deployment `d` is on the live chains (Base 8453, Bittensor 964): its record is the live one, which the hand
 * command names with --live (a testnet's or a fork's is not). */
export const onLiveChains = (d: Pick<DeploymentV32, "chainIds">) => d.chainIds.base === 8453 && d.chainIds.bittensor === 964;
/** The chain a lane's messages are sent from. */
const sourceOf = (d: Direction): "base" | "bittensor" => (d === "Base → Bittensor" ? "base" : "bittensor");
/** What waits on each lane while one of Cascade's FAILUREs is open on it. */
const laneSends = (d: Direction) => (d === "Base → Bittensor" ? "closes and the migration notice's flush toward Bittensor" : "payouts and park refunds toward Base");

/** The round's FAILURE watch (core/actions.ts KeeperActions.bridgeWork's). It reads on the first round, every
 * REEXEC_EVERY_TICKS rounds, and (the automatic mode) each round while the last pass found one due and once a back-off
 * ends. Every round, from what it read: each FAILURE of Cascade's reported loudly when first found, then every
 * FAILURE_REPORT_MS, with its lane, its age and the hand command; the lanes that wait (laneWaits: a FAILURE open
 * LANE_WAIT_MS on them); and, only with the deployment's reexecAuto on, the re-executions due, oldest first. */
export async function reexecV32(depsIn: KeeperDeps, memory: KeeperMemory, o: { now: number }): Promise<Pick<State, "reexecs" | "laneWaits"> | undefined> {
  const deps = v32(depsIn);
  const mem = reexecMemory(memory);
  const said = (mem.said ??= {});
  const tell = (k: string, text: string | undefined) => {
    if (said[k] === text) return;
    if (text === undefined) delete said[k];
    else {
      said[k] = text;
      deps.log(text);
    }
  };
  const auto = deps.deployment.reexecAuto === true;
  const lanes: Record<Direction, Lane | string> = { "Base → Bittensor": laneOf(deps.deployment, "Base → Bittensor"), "Bittensor → Base": laneOf(deps.deployment, "Bittensor → Base") };
  const off = Object.values(lanes).find((l) => typeof l === "string");
  if (typeof off === "string") {
    tell("job", `REEXEC OFF: ${off}: no FAILURE is watched; the keeper's other work goes on`);
    return {};
  }
  tell("job", undefined);
  const due = memory.tick === 1 || memory.tick % REEXEC_EVERY_TICKS === 0 || (auto && (mem.goable || (mem.nextTry !== undefined && o.now >= mem.nextTry)));
  // a read that fails keeps what the last one read: its reports and its lanes' waits (the re-review's N1)
  if (due) {
    try {
      await readPass(deps, mem, lanes as Record<Direction, Lane>, o.now);
    } catch (e) {
      deps.log(`Could not read Cascade's bridge messages for FAILUREs (${oneLine((e as Error).message)}); the lanes' waits stand from the last reading; trying again later`);
    }
  }
  const live = onLiveChains(deps.deployment);

  const watch = mem.watch ?? {};
  const refused = mem.refused ?? {};
  const tries = (mem.tries ??= {});
  const reexecs: DueReexec[] = [];
  const laneWaits: NonNullable<State["laneWaits"]> = {};
  let nextTry: number | undefined;
  for (const [k, w] of Object.entries(watch)) {
    if (w.state !== FAILURE || !w.direction) continue;
    const id = k as Hex;
    // its own pair's lane (R4, D-M2)
    const own = laneOfSent(deps.deployment, { direction: w.direction, adapter: w.adapter });
    const lane = typeof own === "string" ? (lanes[w.direction] as Lane) : own;
    const first = w.firstSeen ?? o.now;
    const age = o.now - first;
    // a FAILURE whose failing attempt never reached Cascade's receiver (a stranger's empty or junk proof) holds no lane
    // while Chainlink's executor may still deliver it (OUTSIDE_WAIT_MS from first seen); after that, as any FAILURE
    const outside = w.attempt?.outside;
    const exempt = outside !== undefined && age < OUTSIDE_WAIT_MS;
    if (age >= LANE_WAIT_MS && !exempt) laneWaits[w.direction] ??= `bridge message ${short(id)} has been in CCIP FAILURE for ${span(age)} (see CCIP FAILURE above)`;
    const never = `Its failing attempt never reached Cascade's receiver (${outside}): a stranger's empty or junk proof, most likely (anyone may call the OffRamp).`;
    const waits = exempt
      ? `${never} The lane does not wait for it until ${span(OUTSIDE_WAIT_MS)} after it was first seen (Chainlink's docs say its executor retries a FAILURE for up to 8 hours; the canary checks it): new ${laneSends(w.direction)} go on meanwhile. If it is still open, re-execute it with the committee's results.`
      : outside !== undefined
        ? `${never} But it is still in FAILURE ${span(OUTSIDE_WAIT_MS)} after it was first seen, past the window Chainlink's docs give its executor: new ${laneSends(w.direction)} wait until it is delivered.`
        : age >= LANE_WAIT_MS
          ? `New ${laneSends(w.direction)} wait until it is delivered.`
          : `If it is still open at ${at(first + LANE_WAIT_MS)}, new ${laneSends(w.direction)} wait until it is delivered.`;
    const seen = `is in FAILURE on ${chainName(lane)}'s OffRamp (${w.ageFrom === "sent" ? `sent ${span(age)} ago, at ${at(first)}, and not read before` : `first seen ${span(age)} ago, at ${at(first)}`})`;
    if (w.reportedAt === undefined || o.now - w.reportedAt >= FAILURE_REPORT_MS) {
      // a rebuild that didn't check is checked again at each later report (the re-review's N6): its source's log may be
      // served now; a read that fails leaves the refusal for this hour
      if (refused[k] && w.reportedAt !== undefined && w.block !== undefined && w.amount !== undefined) {
        const again = await rebuilt(deps, lane, { id, block: w.block, amount: w.amount, direction: w.direction, adapter: w.adapter }).catch(() => undefined);
        if (again && "encoded" in again) {
          delete refused[k];
          w.encoded = again.encoded;
        } else if (again) refused[k] = again.problem;
      }
      w.reportedAt = o.now;
      if (refused[k]) {
        deps.log(
          `REEXEC REFUSED: bridge message ${id} (${w.direction}) ${seen}, but ${refused[k]}: the keeper doesn't re-execute it while its bytes don't check, and checks them again each hour. Check it by hand with: ${handCommand(id, { live })}. ${waits}`,
        );
      } else if (!auto) deps.log(`CCIP FAILURE: bridge message ${id} (${w.direction}) ${seen}. The keeper doesn't re-execute it by itself. ${waits} Check it with: ${handCommand(id, { live })}, then send it with: ${handCommand(id, { live, send: true })}`);
      else deps.log(`CCIP FAILURE: bridge message ${id} (${w.direction}) ${seen}. Automatic re-execution is on (OPS_REEXEC_AUTO): the keeper re-executes it with the failed attempt's committee results and more gas, once its simulation passes. ${waits}`);
    }
    if (!auto || refused[k] || !w.encoded) continue;
    const t = tries[k];
    if (t && o.now < t.nextAt) {
      nextTry = nextTry === undefined || t.nextAt < nextTry ? t.nextAt : nextTry;
      continue;
    }
    reexecs.push({ id, direction: w.direction, reason: `bridge message ${short(id)} (${w.direction}) is in CCIP FAILURE: re-executed with the failed attempt's committee results and a raised gas limit (OPS_REEXEC_AUTO)` });
  }
  mem.goable = reexecs.length > 0;
  mem.nextTry = nextTry;
  return { ...(reexecs.length ? { reexecs } : {}), ...(Object.keys(laneWaits).length ? { laneWaits } : {}) };
}

/** One read of the watch: Cascade's own messages (cascadeSent), a few states a pass (the FAILUREs first, re-read before
 * anything is sent; then the never read; then the longest unread); a SUCCESS is done and let go of; each FAILURE seen
 * first is stamped, and its bytes rebuilt and checked once (a mismatch refuses it for good). Every one of Cascade's
 * messages not read SUCCESS yet is pinned, so the reads keep it whatever its age. */
async function readPass(deps: KeeperDepsV32, mem: ReexecMemory, lanes: Record<Direction, Lane>, now: number): Promise<void> {
  const sent = await deps.cascadeSent();
  const watch = (mem.watch ??= {});
  const done = new Set(mem.done ?? []);
  const refused = (mem.refused ??= {});
  const tries = (mem.tries ??= {});
  const live = new Set(sent.map((x) => x.id.toLowerCase()));
  // what has left the reads' window is let go of here too
  for (const k of Object.keys(watch)) if (!live.has(k)) delete watch[k];
  for (const k of Object.keys(refused)) if (!live.has(k)) delete refused[k];
  for (const k of Object.keys(tries)) if (!live.has(k)) delete tries[k];
  const open = sent.filter((x) => !done.has(x.id.toLowerCase()));
  const rank = (x: CascadeSent) => {
    const w = watch[x.id.toLowerCase()];
    return w?.state === FAILURE ? 0 : w?.checkedAt === undefined ? 1 : 2;
  };
  const toRead = [...open].sort((x, y) => rank(x) - rank(y) || (watch[x.id.toLowerCase()]?.checkedAt ?? 0) - (watch[y.id.toLowerCase()]?.checkedAt ?? 0)).slice(0, STATES_PER_PASS);
  for (const x of toRead) {
    const k = x.id.toLowerCase();
    const state = await deps.messageState({ id: x.id, direction: x.direction });
    const readBefore = watch[k]?.checkedAt !== undefined;
    const w = (watch[k] ??= {});
    Object.assign(w, { direction: x.direction, block: x.block, amount: x.amount, state, checkedAt: now, ...(x.adapter ? { adapter: x.adapter } : {}) });
    if (state === SUCCESS) {
      done.add(k);
      delete watch[k];
      delete tries[k];
      delete refused[k];
      continue;
    }
    if (state === FAILURE) {
      if (w.firstSeen === undefined) {
        w.firstSeen = now;
        // in FAILURE the first time the keeper ever reads it (a memory lost, or a FAILURE from before): its age from its
        // send's block, which can only make the lane wait sooner (the re-review's N4); unread: from this reading
        if (!readBefore) {
          const sentAt = await deps.blockTimeAt(sourceOf(x.direction), x.block).then(
            (t) => t * 1000,
            () => undefined,
          );
          if (sentAt !== undefined && sentAt < now) {
            w.firstSeen = sentAt;
            w.ageFrom = "sent";
          }
        }
      }
    } else {
      delete w.firstSeen;
      delete w.ageFrom;
      delete w.reportedAt;
      delete w.attempt;
    }
  }
  // the pinned: every one of Cascade's messages not read SUCCESS yet is kept by the reads, whatever its age
  deps.pinSent(open.map((x) => x.id).filter((id) => !done.has(id.toLowerCase())));
  mem.done = [...done].filter((k) => live.has(k));
  // a FAILURE's bytes, rebuilt and checked once
  for (const [k, w] of Object.entries(watch)) {
    if (w.state !== FAILURE || w.encoded || refused[k] || !w.direction || w.block === undefined || w.amount === undefined) continue;
    const own = laneOfSent(deps.deployment, { direction: w.direction, adapter: w.adapter });
    if (typeof own === "string") {
      refused[k] = own;
      continue;
    }
    const r = await rebuilt(deps, own, { id: k as Hex, block: w.block, amount: w.amount, direction: w.direction, adapter: w.adapter });
    if ("problem" in r) refused[k] = r.problem;
    else w.encoded = r.encoded;
  }
  // Task 65 (the T61a review's I-1): each FAILURE's failing attempt, read once its log is found: one that never reached
  // Cascade's receiver (a stranger's empty or junk proof) holds no lane; a read that fails is tried at the next pass
  for (const [k, w] of Object.entries(watch)) {
    if (w.state !== FAILURE || w.attempt !== undefined || !w.direction || w.block === undefined) continue;
    const own = laneOfSent(deps.deployment, { direction: w.direction, adapter: w.adapter });
    if (typeof own === "string") continue;
    const a = await attemptOf(deps, own, { id: k as Hex, block: w.block }).catch(() => undefined);
    if (a) w.attempt = a;
  }
}

/** Re-executes Cascade's FAILURE `a.id` (Task 52), only with the deployment's reexecAuto on (else NotNow: by hand, with
 * pnpm ops reexec), when, read again now, it is still FAILURE on its destination's OffRamp (SUCCESS since: NotNow) and
 * its bytes rebuild and check (else NotNow, refused for good): prepareReexec (the proof from the attempt that wrote the
 * FAILURE, the CCVs it must cover, the gas, the explicit simulation), then OffRamp.execute with the raised gas limit for
 * this try, sent through the one send path on the destination chain. A refusal of any of those, or the chain reverting
 * it after the simulation passed (another caller's re-execution landing first is NotNow), puts it on its back-off
 * (SKIP_MS doubling to SKIP_MAX_MS), its gas raised again at the next try, and is reported (HeldRefusal): never a keeper
 * stop. */
export async function reexecActionV32(depsIn: KeeperDeps, t: KeeperTarget, a: Extract<Action, { kind: "reexec" }>, o: { memory?: KeeperMemory; now?: number } = {}): Promise<Done> {
  const deps = v32(depsIn);
  t.requireReady(deps.signer, deps);
  const named = `bridge message ${short(a.id)} (${a.direction})`;
  if (deps.deployment.reexecAuto !== true) {
    throw new NotNow(`${named}: automatic re-execution is off (OPS_REEXEC_AUTO): re-execute it by hand with ${handCommand(a.id, { live: onLiveChains(deps.deployment), send: true })}; nothing sent`);
  }
  const memory = o.memory;
  const mem = memory ? reexecMemory(memory) : ({} as ReexecMemory);
  const k = a.id.toLowerCase();
  if (typeof laneOf(deps.deployment, a.direction) === "string") throw new NotNow(`${named}: ${laneOf(deps.deployment, a.direction)}; nothing sent`);
  const markDone = () => {
    if (!memory) return;
    mem.done = [...new Set([...(mem.done ?? []), k])];
    delete mem.watch?.[k];
    delete mem.tries?.[k];
  };
  const state = await deps.messageState({ id: a.id, direction: a.direction });
  if (state === SUCCESS) {
    markDone();
    throw new NotNow(`${named} was delivered since (SUCCESS): nothing to re-execute`);
  }
  if (state !== FAILURE) throw new NotNow(`${named} is ${state === UNTOUCHED ? "untouched" : state.toLowerCase()} now, not in FAILURE: nothing to re-execute`);
  const w = mem.watch?.[k];
  let sent: Pick<CascadeSent, "id" | "block" | "amount" | "direction" | "adapter">;
  if (w?.block !== undefined && w.amount !== undefined) sent = { id: a.id, block: w.block, amount: w.amount, direction: a.direction, ...(w.adapter ? { adapter: w.adapter } : {}) };
  else {
    const x = (await deps.cascadeSent(a.direction)).find((s) => s.id.toLowerCase() === k);
    if (!x) throw new NotNow(`${named} is not among Cascade's own messages the keeper reads: nothing sent`);
    sent = x;
  }
  // its own pair's lane (R4, D-M2)
  const lane = laneOfSent(deps.deployment, sent);
  if (typeof lane === "string") throw new NotNow(`${named}: ${lane}; nothing sent`);
  let encoded = w?.encoded;
  if (!encoded) {
    const r = await rebuilt(deps, lane, sent);
    if ("problem" in r) {
      if (memory) (mem.refused ??= {})[k] = r.problem;
      throw new NotNow(`${named} can't be re-executed: ${r.problem}; nothing sent`);
    }
    encoded = r.encoded;
  } else {
    // checked when it was rebuilt; checked again, as cheap as it is, before it is sent
    const r = rebuildProblem(lane, a.id, encoded, sent.amount);
    if ("problem" in r) throw new NotNow(`${named} can't be re-executed: ${r.problem}; nothing sent`);
  }
  const before = mem.tries?.[k]?.n ?? 0;
  const gas = reexecGasLimit(decodeMessageV1(encoded).ccipReceiveGasLimit, before);
  const now = o.now ?? Date.now();
  /** On the back-off, said: the next try is SKIP_MS doubling to SKIP_MAX_MS after this failure. */
  const backOff = (why: string): HeldRefusal => {
    const n = before + 1;
    const waitMs = Math.min(SKIP_MS * 2 ** (n - 1), SKIP_MAX_MS);
    if (memory) (mem.tries ??= {})[k] = { n, nextAt: now + waitMs };
    return new HeldRefusal(
      actionKey(a),
      `REEXEC FAILED AGAIN: re-executing ${named} with a ${gas.toLocaleString("en-US")} gas limit: ${why}; tried again in ${inWords(waitMs)}, at ${at(now + waitMs)}, with more gas; the keeper's other work goes on`,
    );
  };
  const p = await prepareReexec(deps, lane, sent, encoded, { gas, nonce: await deps.nonce(lane.dest) });
  if ("problem" in p) throw backOff(p.problem);
  let done: Sent;
  try {
    done = await keeperSend(deps, p.ok.request);
  } catch (e) {
    if (e instanceof SendRefused && e.reason === "estimate") throw backOff(`it would fail (${oneLine(e.message)})`);
    if (e instanceof RevertedOnChain) {
      const after = await deps.messageState({ id: a.id, direction: a.direction }).catch(() => undefined);
      if (after === SUCCESS) {
        markDone();
        throw new NotNow(`another caller re-executed ${named} first; transaction ${e.hash} reverted on chain`);
      }
      throw backOff(`it reverted on chain (transaction ${e.hash}${e.reason ? `, ${e.reason}` : ""})`);
    }
    throw e;
  }
  markDone();
  deps.log(`Bridge message ${short(a.id)} (${a.direction}) re-executed with the committee's results from ${p.ok.proof.from}: delivered`);
  return { ...done };
}

/** Cascade's messages on lane `direction` in CCIP FAILURE now, among its sends of the last SENT_RETAIN_S (15 days) of
 * the source chain: a hand command's own check (Task 52w; the re-review's concern 4), so pnpm ops close and payouts warn of
 * one, as the round's lane wait would hold them. Reads only. */
export async function laneFailures(depsIn: KeeperDeps, direction: Direction): Promise<CascadeSent[]> {
  const deps = v32(depsIn);
  const out: CascadeSent[] = [];
  for (const x of await deps.cascadeSent(direction, { recent: true })) {
    if ((await deps.messageState({ id: x.id, direction })) === FAILURE) out.push(x);
  }
  return out;
}

/** What laneFailures' warning says, for a hand command sending `what` (a close, a payout) on lane `direction`. */
export const laneWarning = (deps: Pick<KeeperDepsV32, "deployment">, x: Pick<CascadeSent, "id" | "direction">, what: string) =>
  `WARNING: bridge message ${x.id.toLowerCase()} (${x.direction}) is in CCIP FAILURE on ${x.direction === "Base → Bittensor" ? "Bittensor" : "Base"}'s OffRamp. The keeper's own rounds send no ${what} on this lane while it is open; this command sends anyway, because you ran it. Check it with: ${handCommand(x.id, { live: onLiveChains(deps.deployment) })}`;
