import { type Address, decodeEventLog, decodeFunctionData, getAddress, type Hex, isAddress } from "viem";
import { OFFRAMP_EXECUTE, PARK_EVENTS } from "../abi.ts";
import { type KeeperDeps, type KeeperTarget, keeperSend } from "../actions.ts";
import { RevertedOnChain, SendRefused } from "../errors.ts";
import { oneLine } from "../failures.ts";
import type { KeeperMemory } from "../memory.ts";
import type { Sent } from "../types.ts";
import { decodeMessageV1, pairOfSent } from "./ccip.ts";
import { railsRefusal, railsV32 } from "./rails.ts";
import type { KeeperDepsV32 } from "./reads.ts";
import { explainReexecRefusal, type GivenProof, handCommand, innerFailure, laneOfSent, onLiveChains, prepareReexec, rebuilt, reexecGasLimit } from "./reexec.ts";
import { reexecRequest } from "./requests.ts";

// Task 52 fix round 1: the hand re-run of a CCIP FAILURE of Cascade's own, the function behind
//   pnpm ops reexec <messageId> [--from-tx <hash> | --proof <file>] [--gas <limit>] [--live] [--send] [--without-lease "<reason>"]
//     [--ignore-monitor-outage --until <time>]
// (Task 52w registers it in cli.ts, on handCommandV32 as a one-shot command: the live readiness first, then with --send the
// Worker's lease or --without-lease "<reason>", every send renewing it first; --live names the live record, as in every
// command, and only --send sends). The founder's ruling: at launch a FAILURE is re-executed by hand only, very carefully,
// failing safe. Before anything is signed it checks (review (iii)):
// 1. the id is one of Cascade's own: its source adapter's Sent from the door to the vault (Base → Bittensor) or from the
//    vault to the door (Bittensor → Base), looked up by its id; its bytes rebuilt from the source OnRamp's CCIPMessageSent
//    and checked as the keeper does (ccip.ts rebuildProblem, with its Sent's amount);
// 2. the OffRamp reads FAILURE now: an UNTOUCHED message (its first execution is Chainlink's) and a SUCCESS are never
//    executed;
// 3. the proof: the CCVs and results from an attempt's calldata, by default the transaction that wrote the FAILURE (the
//    OffRamp's ExecutionStateChanged), else --from-tx; sent to the OffRamp, calling its execute with the same bytes; or,
//    when an executor called the OffRamp through its own contract, given whole with --proof <file | 0x…> (the re-review's
//    N2); or (Task 65), when the attempt that wrote the FAILURE carried none (a stranger's empty proof), Chainlink's CCIP
//    API's execution inputs for the message (reexec.ts reexecProof, ccip-api.ts); never empty results;
// 4. the proof covers getCCVsForMessage; 5. the gas is within reexecGasLimit's bounds; 6. its simulation passes, a
//    refusal explained (the receiver failed again, or the committee's results were refused);
// 7. the first failure's own error is shown; 8. during ForeverMoney's migration notice, migrationReadyAt is shown.
// Without --send it only checks, simulates and says what it would send. With --send it sends, through the one send path
// (so the hold, the kill switch and the lease (the host's), and the spend cap apply), and reads the state again after. Its
// lookups by id read afresh (the re-review's N5).

/** Its usage, every flag as built: the hand run's two (--without-lease, --ignore-monitor-outage --until) are taken off by
 * cli.ts as the other one-shots' are (lease-client.ts takeHandFlags). args.ts USAGE lists it too. */
export const REEXEC_USAGE =
  'pnpm ops reexec <messageId> [--from-tx <hash> | --proof <file | 0x…> | --empty-proof] [--gas <limit>] [--live] [--send] [--without-lease "<reason>"] [--ignore-monitor-outage --until <time>]';

/** pnpm ops reexec's arguments: --live names the live record (as in every command), --send sends. --proof names a file,
 * or gives another execute's calldata as hex (proofHex: 0x and hex). */
export interface ReexecHandArgs {
  id: Hex;
  fromTx?: Hex;
  proofFile?: string;
  proofHex?: Hex;
  gas?: number;
  /** Task 65: the canary's live empty-proof test (emptyProofByHand): an untouched message of Cascade's own executed with an
   * empty result for each committee, so the OffRamp writes FAILURE */
  emptyProof?: true;
  live: boolean;
  send: boolean;
}

const WORD = /^0x[0-9a-fA-F]{64}$/;

/** pnpm ops reexec's arguments from `argv` (after the command's name), or throws naming what is wrong and the usage. */
export function parseReexecArgs(argv: readonly string[]): ReexecHandArgs {
  const bad = (why: string) => new Error(`pnpm ops reexec: ${why}. ${REEXEC_USAGE}`);
  let id: Hex | undefined;
  let fromTx: Hex | undefined;
  let proofFile: string | undefined;
  let proofHex: Hex | undefined;
  let gas: number | undefined;
  let emptyProof = false;
  let live = false;
  let send = false;
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--live") live = true;
    else if (x === "--send") send = true;
    else if (x === "--empty-proof") emptyProof = true;
    else if (x === "--proof") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw bad("--proof needs a file (JSON: the committees and their results) or another execute's calldata (0x and hex)");
      if (v.startsWith("0x")) {
        if (!/^0x([0-9a-fA-F]{2})+$/.test(v)) throw bad("--proof's 0x… is not hex (another execute's calldata)");
        proofHex = v as Hex;
      } else proofFile = v;
    } else if (x === "--from-tx") {
      const v = argv[++i];
      if (!v || !WORD.test(v)) throw bad("--from-tx needs a transaction hash (0x and 64 hex digits)");
      fromTx = v.toLowerCase() as Hex;
    } else if (x === "--gas") {
      const v = argv[++i];
      if (!v || !/^\d+$/.test(v) || Number(v) <= 0 || !Number.isSafeInteger(Number(v))) throw bad("--gas needs a gas limit (a whole number)");
      gas = Number(v);
    } else if (x.startsWith("--")) throw bad(`${x} is not one of its flags`);
    else if (id === undefined) {
      if (!WORD.test(x)) throw bad(`${x} is not a bridge message id (0x and 64 hex digits)`);
      id = x.toLowerCase() as Hex;
    } else throw bad(`it takes one bridge message id, not ${x} as well`);
  }
  if (!id) throw bad("it needs a bridge message id");
  if (fromTx && (proofFile || proofHex)) throw bad("it takes the committee's results from --from-tx or --proof, not both");
  if (emptyProof && (fromTx || proofFile || proofHex || gas !== undefined)) throw bad("--empty-proof takes no proof and no gas: it sends empty results, with the message's own gas");
  return {
    id,
    ...(fromTx ? { fromTx } : {}),
    ...(proofFile ? { proofFile } : {}),
    ...(proofHex ? { proofHex } : {}),
    ...(gas !== undefined ? { gas } : {}),
    ...(emptyProof ? { emptyProof: true as const } : {}),
    live,
    send,
  };
}

/** What cli.ts hands its v3.2 hand command for pnpm ops reexec (Task 52w fix M2): the record (--live) and the re-run's
 * own input, `send` only from --send. A proof file named must have been read (`proof`), never dropped. */
export function reexecHandInput(
  r: ReexecHandArgs,
  proof?: GivenProof,
): { live: boolean; reexec: { id: Hex; send: boolean; fromTx?: Hex; proof?: GivenProof; gas?: number; emptyProof?: true } } {
  if (r.proofFile && !proof) throw new Error(`the proof file ${r.proofFile} was not read; nothing sent`);
  if (r.proofHex && !proof) throw new Error("the proof given as hex was not read; nothing sent");
  return {
    live: r.live,
    reexec: {
      id: r.id,
      send: r.send,
      ...(r.fromTx ? { fromTx: r.fromTx } : {}),
      ...(proof ? { proof } : {}),
      ...(r.gas !== undefined ? { gas: r.gas } : {}),
      ...(r.emptyProof ? { emptyProof: true as const } : {}),
    },
  };
}

/** A proof's committee results (pnpm ops reexec --proof: the re-review's N2; Task 65), for a FAILURE whose writing
 * attempt carries none usable (it called the OffRamp through a contract of its own, or a stranger's empty proof), in one
 * of three forms:
 * - JSON {"ccvs": [address, …], "verifierResults": [hex, …]}, as many of each, from a trace or Chainlink's own records;
 * - JSON as Chainlink's CCIP API answers it (GET https://api.ccip.chain.link/v2/messages/<id>/execution-inputs:
 *   {"encodedMessage", "verifierAddresses", "ccvData", …}): its encodedMessage must be this message's;
 * - the hex calldata of another OffRamp execute of the same message (0x…, given inline or in the file): its bytes must be
 *   this message's.
 * Checked here for its shape only: the bytes, the CCVs the OffRamp requires and the simulation decide, as for any proof
 * (the OffRamp checks the results again, and a bad one only makes the call revert); an empty result is refused before it
 * is signed (reexec.ts prepareReexec). `name` is the file, or the hex, as typed. */
export function parseProofFile(text: string, name: string): GivenProof {
  const inline = name.startsWith("0x");
  const words = inline ? `the proof ${name.length > 14 ? `${name.slice(0, 10)}…` : name}` : `the proof file ${name}`;
  const bad = (why: string) => new Error(`${words} ${why}; nothing sent`);
  const t = text.trim();
  if (t.startsWith("0x")) {
    let args: readonly [Hex, readonly Address[], readonly Hex[], number];
    try {
      args = decodeFunctionData({ abi: OFFRAMP_EXECUTE, data: t as Hex }).args as typeof args;
    } catch {
      throw bad("is not the calldata of an OffRamp execute(encodedMessage, ccvs, verifierResults, gasLimitOverride)");
    }
    const [encoded, ccvs, results] = args;
    if (!ccvs.length) throw bad("names no committee");
    if (ccvs.length !== results.length) throw bad(`has ${ccvs.length} committees and ${results.length} results: it needs one result for each committee`);
    return { ccvs: ccvs.map((c) => getAddress(c)), verifierResults: [...results], encoded, file: name, from: words };
  }
  let j: unknown;
  try {
    j = JSON.parse(t);
  } catch {
    throw bad("is not JSON");
  }
  const api = j as { encodedMessage?: unknown; verifierAddresses?: unknown; ccvData?: unknown } | null;
  const fromApi = !!api && typeof api === "object" && Array.isArray(api.verifierAddresses);
  const o = (fromApi ? { ccvs: api.verifierAddresses, verifierResults: api.ccvData } : j) as { ccvs?: unknown; verifierResults?: unknown } | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.ccvs) || !Array.isArray(o.verifierResults)) throw bad('is not {"ccvs": [address, …], "verifierResults": [hex, …]}, nor the CCIP API\'s execution inputs');
  if (!o.ccvs.length) throw bad("names no committee");
  if (o.ccvs.length !== o.verifierResults.length) throw bad(`has ${o.ccvs.length} committees and ${o.verifierResults.length} results: it needs one result for each committee`);
  for (const c of o.ccvs) if (typeof c !== "string" || !isAddress(c, { strict: false })) throw bad(`names ${String(c)}: ${String(c)} is not an address`);
  for (const r of o.verifierResults) if (typeof r !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(r)) throw bad(`holds ${String(r)}: ${String(r)} is not hex`);
  const encoded = fromApi ? api.encodedMessage : undefined;
  if (fromApi && (typeof encoded !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(encoded))) throw bad("is the CCIP API's answer with no encodedMessage");
  return {
    ccvs: o.ccvs.map((c) => getAddress(c as string) as Address),
    verifierResults: o.verifierResults as Hex[],
    ...(fromApi ? { encoded: encoded as Hex } : {}),
    file: name,
    from: words,
  };
}

const v32 = (deps: KeeperDeps): KeeperDepsV32 => {
  if (!("sentById" in deps) || !("railsSeen" in deps)) throw new Error("pnpm ops reexec needs the v3.2 deps (v32/reads.ts depsV32); nothing sent");
  return deps as KeeperDepsV32;
};

const SUCCESS = "SUCCESS";
const FAILURE = "FAILURE";
const UNTOUCHED = "UNTOUCHED";
/** How long the canary waits for Chainlink's executor to deliver a FAILURE its empty proof wrote, before recovering it by
 * hand (runbook 3.5): 2 hours (its docs say it retries a FAILURE for up to 8). */
export const EMPTY_PROOF_WAIT_MS = 2 * 3_600_000;

/** Whether `sent`'s receipt has the Bittensor adapter's BatchParked: the batch arrived, but was parked. */
function parkedIn(sent: Sent, adapter: Hex): boolean {
  for (const l of sent.logs ?? []) {
    if (l.address.toLowerCase() !== adapter.toLowerCase()) continue;
    try {
      if (decodeEventLog({ abi: PARK_EVENTS, topics: l.topics as [Hex, ...Hex[]], data: l.data }).eventName === "BatchParked") return true;
    } catch {
      // another of the adapter's events
    }
  }
  return false;
}

/** pnpm ops reexec <messageId> --empty-proof (Task 65): the mainnet canary's live empty-proof test (runbook 3.5, the
 * founder's 2026-11-14 agreement), on one message of Cascade's own that no one has executed yet: its OffRamp's
 * execute(encodedMessage, ccvs, verifierResults, 0) with each committee the OffRamp requires (getCCVsForMessage) given an
 * empty result, as a stranger could send it; the OffRamp writes FAILURE without calling Cascade's receiver. It refuses
 * anything but an untouched message of Cascade's own on a lane of Cascade's own (looked up afresh, its bytes rebuilt and
 * checked as a re-execution's are), simulates first, and sends only with `o.send`, through the one send path (the
 * rails, the spend cap). Then: whether Chainlink's executor delivers it (it retries a FAILURE, its docs say), and if not by
 * EMPTY_PROOF_WAIT_MS, the recovery with the real results (pnpm ops reexec <id> --live --send). Returns 0 when the dry run
 * passes or the FAILURE is written, 1 otherwise. */
export async function emptyProofByHand(depsIn: KeeperDeps, t: KeeperTarget, memory: KeeperMemory, o: { id: Hex; send: boolean; live?: boolean; now?: number }): Promise<number> {
  const deps = v32(depsIn);
  t.requireReady(deps.signer, deps);
  const say = (line: string) => deps.log(line);
  const no = (why: string) => {
    say(`Not sent: ${why}`);
    return 1;
  };
  const id = o.id.toLowerCase() as Hex;
  const live = o.live ?? onLiveChains(deps.deployment);
  const found = await deps.sentById(id, { fresh: true });
  if ("partial" in found) {
    const p = found.partial;
    return no(`Cascade's sends could not be read in full (blocks ${p.from} to ${p.to}, read to ${p.scannedTo}: ${oneLine((p.error as Error)?.message ?? String(p.error), 160)}); try again`);
  }
  if ("none" in found) {
    return no(`bridge message ${id} is not one of Cascade's own (no Sent from the door to the vault on Base, nor from the vault to the door on Bittensor): the keeper never executes it`);
  }
  const x = found.found;
  const lane = laneOfSent(deps.deployment, x);
  if (typeof lane === "string") return no(lane);
  say(`Bridge message ${id}: Cascade's own, ${x.direction}, sent at block ${x.block} on ${lane.source === "base" ? "Base" : "Bittensor"}.`);
  const r = await rebuilt(deps, lane, x);
  if ("problem" in r) return no(`its bytes don't check: ${r.problem}`);
  const fresh = "the test needs a message no one has executed yet (use the next deposit)";
  const state = await deps.messageState({ id, direction: x.direction });
  if (state === SUCCESS) return no(`it was delivered (SUCCESS): ${fresh}`);
  if (state === FAILURE) return no(`it is already in FAILURE: ${fresh}`);
  if (state !== UNTOUCHED) return no(`it is ${state.toLowerCase()}: ${fresh}`);
  const need = await deps.ccvsFor(x.direction, r.encoded);
  const ccvs = [...need.required, ...need.optional];
  if (!ccvs.length) return no("the OffRamp names no committee for it, so an empty proof would test nothing");
  const request = reexecRequest(lane, id, r.encoded, { ccvs, verifierResults: ccvs.map(() => "0x" as Hex) }, 0, await deps.nonce(lane.dest));
  request.label = `execute bridge message ${id.slice(0, 10)}… (${lane.direction}) on its OffRamp with an empty proof (the canary's live test)`;
  const sim = await deps.simulate(request);
  if (!sim.ok) return no(`its simulation refuses it: ${explainReexecRefusal(sim.data, sim.reason).why}`);
  say(
    `Checked: untouched now; its bytes rebuilt; the ${ccvs.length} committee${ccvs.length === 1 ? "" : "s"} the OffRamp requires (${ccvs.join(", ")}), each given an empty result. Its simulation passes: the OffRamp would write FAILURE without calling Cascade's receiver.`,
  );
  if (!o.send) {
    say(`Nothing sent. To send it: ${handCommand(id)} --empty-proof${live ? " --live" : ""} --send`);
    return 0;
  }
  const why = railsRefusal(await railsV32(deps, memory, o.now ?? Date.now()), { chain: lane.dest });
  if (why) return no(why);
  let sent: Sent | undefined;
  try {
    sent = await keeperSend(deps, request);
  } catch (e) {
    if (e instanceof SendRefused) return no(oneLine(e.message));
    if (!(e instanceof RevertedOnChain)) throw e;
  }
  const after = await deps.messageState({ id, direction: x.direction }).catch(() => undefined);
  if (after === SUCCESS) {
    say(`Not done: Chainlink's executor delivered bridge message ${id} first (SUCCESS): the test did not run; try it with the next deposit`);
    return 1;
  }
  if (!sent || after !== FAILURE) {
    say(`Not done: ${sent ? `transaction ${sent.hash} landed` : "the transaction reverted"}, and bridge message ${id} reads ${after ? after.toLowerCase() : "unread"}, not FAILURE; read it again with: ${handCommand(id, { live })}`);
    return 1;
  }
  const until = new Date((o.now ?? Date.now()) + EMPTY_PROOF_WAIT_MS).toISOString().slice(0, 16).replace("T", " ");
  say(
    `Done (transaction ${sent.hash}): bridge message ${id} is in FAILURE, written by this empty proof. Watch whether Chainlink's executor delivers it (its docs say it retries a FAILURE for up to 8 hours): ${handCommand(id, { live })} reads its state. If it is still in FAILURE at ${until} UTC (2 hours from now), recover it with: ${handCommand(id, { live, send: true })}`,
  );
  return 0;
}

/** pnpm ops reexec: checks a re-execution of bridge message `o.id` (see above), says what it would send, and with
 * `o.send` (the command's --send) sends it through the one send path. Every check that fails says why ("Not sent: …")
 * and returns 1; a dry run that passes every check, or a re-execution sent, returns 0. `memory` is the command's own (the
 * rails' readings, the lookups' progress); `o.live` (the command's --live, by default whether the deployment is on the
 * live chains) is how its words name the record. */
export async function reexecByHand(
  depsIn: KeeperDeps,
  t: KeeperTarget,
  memory: KeeperMemory,
  o: { id: Hex; fromTx?: Hex; proof?: GivenProof; gas?: number; send: boolean; live?: boolean; now?: number },
): Promise<number> {
  const deps = v32(depsIn);
  t.requireReady(deps.signer, deps);
  const say = (line: string) => deps.log(line);
  const no = (why: string) => {
    say(`Not sent: ${why}`);
    return 1;
  };
  const id = o.id.toLowerCase() as Hex;
  const live = o.live ?? onLiveChains(deps.deployment);
  // 1. one of Cascade's own, on its own lane, its bytes rebuilt and checked; looked up afresh (N5)
  const found = await deps.sentById(id, { fresh: true });
  if ("partial" in found) {
    const p = found.partial;
    return no(`Cascade's sends could not be read in full (blocks ${p.from} to ${p.to}, read to ${p.scannedTo}: ${oneLine((p.error as Error)?.message ?? String(p.error), 160)}); try again`);
  }
  if ("none" in found) {
    return no(`bridge message ${id} is not one of Cascade's own (no Sent from the door to the vault on Base, nor from the vault to the door on Bittensor): the keeper never re-executes it`);
  }
  const x = found.found;
  // its own pair's lane (R4, D-M2: any pair the deployment lists)
  const lane = laneOfSent(deps.deployment, x);
  if (typeof lane === "string") return no(lane);
  say(`Bridge message ${id}: Cascade's own, ${x.direction}, sent at block ${x.block} on ${lane.source === "base" ? "Base" : "Bittensor"}.`);
  const r = await rebuilt(deps, lane, x);
  if ("problem" in r) return no(`its bytes don't check: ${r.problem}`);
  // 2. in FAILURE now: never an untouched message, never a delivered one
  const state = await deps.messageState({ id, direction: x.direction });
  if (state === SUCCESS) return no("it was delivered (SUCCESS): nothing to re-execute");
  if (state === "UNTOUCHED") return no("it is untouched: it was never executed, and the keeper never makes a message's first execution (Chainlink's executor does)");
  if (state !== FAILURE) return no(`it is ${state.toLowerCase()}, not in FAILURE`);
  // 8. ForeverMoney's migration notice
  try {
    const readyAt = await deps.migrationNotice();
    if (readyAt !== 0n) {
      say(
        `MIGRATION NOTICE: ForeverMoney's migration is announced (migrationReadyAt ${readyAt}, ${new Date(Number(readyAt) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC).${x.direction === "Base → Bittensor" ? " A batch delivered after the migration executes parks as ForeverMoney's token, a claim ForeverMoney won't honour." : ""}`,
      );
    }
  } catch (e) {
    say(`ForeverMoney's migration notice could not be read (${oneLine((e as Error).message, 160)}).`);
  }
  // 3 to 6: the proof from an attempt's calldata, the CCVs, the gas, the simulation
  const own = decodeMessageV1(r.encoded).ccipReceiveGasLimit;
  const gas = o.gas ?? reexecGasLimit(own, 0);
  const p = await prepareReexec(deps, lane, x, r.encoded, { gas, nonce: await deps.nonce(lane.dest), fresh: true, ...(o.fromTx ? { fromTx: o.fromTx } : {}), ...(o.proof ? { proof: o.proof } : {}) });
  // 7. the first failure's own error (a permanent cause, a malformed batch, is not worth a retry)
  const firstError = "problem" in p ? p.firstError : p.ok.firstError;
  if (firstError) say(`Its first failure: ${innerFailure(firstError).words}.`);
  if ("problem" in p) return no(p.problem);
  const { request, proof } = p.ok;
  say(
    `Checked: in FAILURE now; its bytes rebuilt; ${proof.ccvs.length} committee result${proof.ccvs.length === 1 ? "" : "s"} from ${proof.from}, covering what the OffRamp requires; a ${gas.toLocaleString("en-US")} gas limit (its own is ${own.toLocaleString("en-US")}). Its simulation passes: it would be delivered.`,
  );
  if (!o.send) {
    const flags = `${o.fromTx ? ` --from-tx ${o.fromTx}` : ""}${o.proof ? ` --proof ${o.proof.file}` : ""}${o.gas !== undefined ? ` --gas ${o.gas}` : ""}`;
    say(`Nothing sent. To send it: ${handCommand(id)}${flags}${live ? " --live" : ""} --send`);
    return 0;
  }
  // the rails first, read now (the one send path checks them again)
  const why = railsRefusal(await railsV32(deps, memory, o.now ?? Date.now()), { chain: lane.dest });
  if (why) return no(why);
  let sent: Sent;
  try {
    sent = await keeperSend(deps, request);
  } catch (e) {
    if (e instanceof SendRefused) return no(oneLine(e.message));
    if (e instanceof RevertedOnChain) {
      say(`Not delivered: transaction ${e.hash} reverted on chain${e.reason ? ` (${e.reason})` : ""}; bridge message ${id} is still in FAILURE.`);
      return 1;
    }
    throw e;
  }
  const after = await deps.messageState({ id, direction: x.direction }).catch(() => undefined);
  const parked = x.direction === "Base → Bittensor" && parkedIn(sent, pairOfSent(deps.deployment, x)?.bitAdapter ?? t.plan.addresses.bitAdapter);
  say(
    `Done (transaction ${sent.hash}): bridge message ${id} is ${after === SUCCESS ? "delivered" : after ? `${after.toLowerCase()} (read again)` : "sent (its state could not be read again)"}${parked ? "; the Bittensor adapter parked its batch, which the park job delivers or refunds" : ""}.`,
  );
  return 0;
}
