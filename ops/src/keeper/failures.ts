import type { Address, Hex } from "viem";
import type { ChainName } from "../config.ts";
import { RecordMismatch } from "../record.ts";
import { describeCode, RpcError } from "../rpc.ts";
import { chainLabel, ReceiptTimeout, RevertedOnChain, SendRefused } from "../send.ts";

/** The keeper wallet has code on `chain` (either chain stops a send on either). Not a SendRefused: a
 * run's delivery treats most of those as a wait for the next round, and this must stop the run. */
export class KeeperHasCode extends Error {
  readonly chain: ChainName;
  readonly code: Hex;

  constructor(chain: ChainName, keeper: Address, code: Hex) {
    super(
      `${chainLabel(chain)}: the keeper wallet ${keeper} has code (an EIP-7702 delegation or a contract): ${describeCode(code)}; assume its key is compromised; stop and rotate the keeper; nothing sent`,
    );
    this.chain = chain;
    this.code = code;
  }
}

/** requireReady's refusal: the deployment isn't complete and verified (or a read-back since has failed),
 * a launch's hand-off isn't accepted, or the keeper commands sign as someone other than its keeper. */
export class KeeperNotReady extends Error {}

/** The chain, as re-read just before a send, doesn't allow it now: a pause, an empty batch, a payout not
 * due or already made. A hand-run command fails with it; `run` takes it for a race lost since its round's
 * read, and decides again the next round. */
export class NotNow extends Error {}

/** What a keeper failure is. The first seven stop `run` (see classifyFailure); the rest wait a round. */
export type FailureKind =
  | "keeper-has-code"
  | "not-ready"
  | "record"
  | "signer"
  | "chain-id"
  | "not-live"
  | "reverted"
  | "waiting"
  | "nonce"
  | "estimate"
  | "receipt"
  | "not-now"
  | "rpc"
  | "network"
  | "unexpected";

export interface Failure {
  /** true: `run` stops (exit 3, never restarted); false: it logs, backs off and tries the next round */
  stop: boolean;
  kind: FailureKind;
  /** A few words for the log line */
  label: string;
  message: string;
}

/** Error codes of a connection that failed or timed out (Node's, and undici's under fetch). */
const NETWORK_CODE = /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR_[A-Z_]+)$/;

/** A connection that failed or timed out: its code ("" when it has none), or undefined for any other
 * error. Only the code: the cause's message can name the RPC's URL, where a provider's key can sit. */
function networkCode(e: unknown): string | undefined {
  if (!(e instanceof Error)) return undefined;
  const code = (x: unknown) => {
    const c = (x as { code?: unknown } | undefined)?.code;
    return typeof c === "string" && NETWORK_CODE.test(c) ? c : undefined;
  };
  const own = code(e);
  if (own) return own;
  if (e instanceof TypeError && e.message === "fetch failed") return code(e.cause) ?? "";
  if (e.name === "TimeoutError" || e.name === "AbortError") return "";
  return undefined;
}

/** Whether a failure inside one of `run`'s rounds stops the keeper or waits for the next round.
 *
 * Stop (deliberately, exit 3, never restarted): the keeper wallet has code (the EIP-7702 guard: assume
 * its key is compromised); the record isn't ready (unverified, a failed read-back since, a launch's
 * hand-off not accepted, another keeper); the record file is gone or holds another deployment; the
 * keystore signs as another account; an RPC answers for another chain; the live gate; and a transaction
 * that reverted on chain with nothing to explain it (`run` re-reads first: a lost race never gets here).
 *
 * Wait (log, back off, next round): an earlier transaction still pending, a nonce race, a simulation
 * that refused the send (the chain changed under it), no receipt yet (the send guard then holds every
 * send until it is mined or dropped), the chain changed since the round's read, an RPC error or a
 * network failure, and anything else: none of these can send twice, since every send goes through the
 * guards again. */
export function classifyFailure(e: unknown): Failure {
  const message = e instanceof Error ? e.message : String(e);
  const as = (stop: boolean, kind: FailureKind, label: string, m = message): Failure => ({ stop, kind, label, message: m });
  if (e instanceof KeeperHasCode) return as(true, "keeper-has-code", "the keeper wallet has code");
  if (e instanceof KeeperNotReady) return as(true, "not-ready", "the record isn't ready");
  if (e instanceof RecordMismatch) return as(true, "record", "the record changed");
  if (e instanceof RevertedOnChain) return as(true, "reverted", "an unexplained revert");
  if (e instanceof SendRefused) {
    switch (e.reason) {
      case "signer":
        return as(true, "signer", "the wrong keeper key");
      case "chain-id":
        return as(true, "chain-id", "an RPC on another chain");
      case "not-live":
        return as(true, "not-live", "the live gate");
      case "waiting":
        return as(false, "waiting", "a transaction pending");
      case "nonce":
        return as(false, "nonce", "a nonce race");
      case "estimate":
        return as(false, "estimate", "refused by simulation");
    }
  }
  if (e instanceof ReceiptTimeout) return as(false, "receipt", "no receipt yet");
  if (e instanceof NotNow) return as(false, "not-now", "the chain changed");
  if (e instanceof RpcError) return as(false, "rpc", "RPC error");
  const net = networkCode(e);
  if (net !== undefined) return as(false, "network", "network error", net ? `${message} (${net})` : message);
  return as(false, "unexpected", "unexpected error");
}

/** The wait after a round, with `failing` rounds failed in a row: the interval; then doubled for each
 * further failure, up to `capMs` (5 minutes), but never shorter than the interval. */
export function nextWaitMs(intervalMs: number, failing: number, capMs = 300_000): number {
  if (failing <= 1) return intervalMs;
  return Math.max(intervalMs, Math.min(intervalMs * 2 ** (failing - 1), capMs));
}

/** A wait in words for the log: "30 s", "2 min", "2.5 min". */
export function inWords(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Number((ms / 60_000).toFixed(1))} min`;
}

/** An error's message on one line, at most `max` characters (a send's stderr can run to many). */
export function oneLine(text: string, max = 600): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
