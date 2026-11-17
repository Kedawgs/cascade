import { type Address, getAddress, type Hex, isAddress } from "viem";

// Chainlink's CCIP API, where a CCIP 2.0 message's committee results are public (Task 65; the T61a review's I-1): the
// execution-inputs endpoint answers the encoded message, the committees (verifierAddresses) and their results (ccvData,
// what OffRamp.execute takes as verifierResults) for a message id, from the CCIP Indexer, which collects the Committee
// Verifier's results from its Aggregator (docs.chain.link/ccip/concepts/manual-execution, "CCV Data Available Through
// the CCIP API"; docs.chain.link/ccip/concepts/message-lifecycle, phases 2.2 and 3; Chainlink's own SDK reads the same
// path, @chainlink/ccip-sdk src/api/index.ts fetchExecutionInputs). pnpm ops reexec reads it when the attempt that wrote a
// FAILURE carried no committee results (a stranger's empty proof). Reads only, with no key; the message id is public.

/** The API's base, as Chainlink's docs and SDK name it (DEFAULT_API_BASE_URL). */
export const CCIP_API_BASE = "https://api.ccip.chain.link";

/** Where message `id`'s execution inputs are read. */
export const executionInputsUrl = (id: Hex): string => `${CCIP_API_BASE}/v2/messages/${id.toLowerCase()}/execution-inputs`;

/** The API's ExecutionInputsV2 (lane version 2.0+), as it answers it: unchecked. */
export interface ExecutionInputs {
  offramp?: unknown;
  encodedMessage?: unknown;
  verifierAddresses?: unknown;
  ccvData?: unknown;
  verificationComplete?: unknown;
}

/** What a read of the API gives: its answer, or why there is none (in words). */
export type ExecutionInputsAnswer = { inputs: ExecutionInputs } | { problem: string };

/** The longest a read waits for the API (ms). */
export const CCIP_API_TIMEOUT_MS = 15_000;

/** Message `id`'s execution inputs from the API (GET executionInputsUrl), or why not: not known to it (404), not ready
 * (409: not verified yet), another answer, or no answer in time. */
export async function fetchExecutionInputs(id: Hex, fetchFn: typeof fetch = fetch): Promise<ExecutionInputsAnswer> {
  const url = executionInputsUrl(id);
  let r: Response;
  try {
    r = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(CCIP_API_TIMEOUT_MS) });
  } catch (e) {
    return { problem: `the CCIP API could not be read (${(e as Error).message.split("\n")[0]})` };
  }
  if (r.status === 404) return { problem: "the CCIP API does not know this message (404)" };
  if (r.status === 409) return { problem: "the CCIP API has no execution inputs for it yet (409: not verified yet); try again later" };
  if (!r.ok) return { problem: `the CCIP API answered ${r.status}${r.statusText ? ` ${r.statusText}` : ""}` };
  try {
    return { inputs: (await r.json()) as ExecutionInputs };
  } catch {
    return { problem: "the CCIP API's answer is not JSON" };
  }
}

const isHex = (v: unknown): v is Hex => typeof v === "string" && /^0x([0-9a-fA-F]{2})*$/.test(v);
/** A committee result too short to carry even a verifier's version tag (4 bytes): an empty proof. */
export const emptyResult = (r: Hex): boolean => (r.length - 2) / 2 < 4;

/** The committees and their results the API's answer gives for the message whose rebuilt bytes are `encoded`, on the
 * lane whose OffRamp is `offRamp` (named `chain`), or why they can't be used: its encoded message must be those bytes,
 * its OffRamp the lane's, as many results as committees, none empty, and the verification complete. The OffRamp checks
 * the results again (and the keeper's simulation first): a bad one only makes the call revert. */
export function proofFromInputs(i: ExecutionInputs, encoded: Hex, offRamp: Address, chain: string): { ccvs: Address[]; verifierResults: Hex[] } | { problem: string } {
  if (!isHex(i.encodedMessage) || i.encodedMessage.toLowerCase() !== encoded.toLowerCase()) return { problem: "its encoded message is not this message's rebuilt bytes" };
  if (typeof i.offramp !== "string" || !isAddress(i.offramp, { strict: false }) || getAddress(i.offramp) !== getAddress(offRamp)) {
    return { problem: `it names the OffRamp ${String(i.offramp)}, not ${chain}'s ${getAddress(offRamp)}` };
  }
  const ccvs = Array.isArray(i.verifierAddresses) ? i.verifierAddresses : [];
  const results = Array.isArray(i.ccvData) ? i.ccvData : [];
  if (!ccvs.length || ccvs.length !== results.length) return { problem: `it carries ${ccvs.length} committee${ccvs.length === 1 ? "" : "s"} and ${results.length} result${results.length === 1 ? "" : "s"}` };
  for (const c of ccvs) if (typeof c !== "string" || !isAddress(c, { strict: false })) return { problem: `it names ${String(c)}, not an address, as a committee` };
  for (const r of results) if (!isHex(r)) return { problem: `it carries ${String(r)}, not hex, as a result` };
  if ((results as Hex[]).some(emptyResult)) return { problem: "it carries an empty committee result" };
  if (i.verificationComplete === false) return { problem: "it says the committee's verification is not complete yet (verificationComplete false): try again later" };
  return { ccvs: ccvs.map((c) => getAddress(c as string)), verifierResults: results as Hex[] };
}
