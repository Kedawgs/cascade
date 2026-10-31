import type { Address, Hex } from "viem";
import type { ChainName } from "../config.ts";
import { RecordMismatch } from "../record.ts";
import { describeCode, RpcError } from "../rpc.ts";
import { chainLabel, ReceiptTimeout, RevertedOnChain, SendRefused, scrubSecrets } from "../send.ts";

export { scrubSecrets } from "../send.ts";

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

/** The payout list rebuilt from the vault's events doesn't match the one the vault stored, on two full
 * scans of those events (payouts rescans once, so a short eth_getLogs answer never gets here). The
 * keeper's view of the vault's events is wrong, which no other action can be trusted on either, so `run`
 * stops on it. */
export class PayoutListMismatch extends Error {}

/** A delivery reverted on chain while its simulation still passed on the same facts, and its revert
 * decoded to nothing that explains it. A passing failure: `run` fails the round for it (so the log and
 * the back-off show it) and holds that user's delivery; one user's delivery never stops the keeper, and
 * repeated reverts of it, explained or not, only hold that user longer (the revert budget). */
export class DeliveryReverted extends Error {
  readonly user: Address;

  constructor(user: Address, revert: RevertedOnChain) {
    super(`${revert.message}, while its simulation still passes on the same facts and nothing explains it; held for 30 minutes, or until the user's facts change`);
    this.user = user;
  }
}

/** A close, payout, stake or roll reverted on chain, and the chain couldn't be read again to tell why.
 * A passing failure: the next round's read decides (a lost race is a skip; nothing to explain it, or
 * another failed read, stops the keeper with the revert). */
export class RevertUnread extends Error {
  readonly revert: RevertedOnChain;

  constructor(revert: RevertedOnChain, cause: unknown) {
    super(`${revert.message}; the chain couldn't be read again to tell why (${cause instanceof Error ? cause.message : String(cause)}): the next round's read decides`);
    this.revert = revert;
  }
}

/** What a keeper failure is. Those classifyFailure marks `stop` end `run`; the rest wait a round. */
export type FailureKind =
  | "keeper-has-code"
  | "not-ready"
  | "record"
  | "signer"
  | "chain-id"
  | "not-live"
  | "reverted"
  | "payout-list"
  | "waiting"
  | "nonce"
  | "estimate"
  | "receipt"
  | "not-now"
  | "revert-unread"
  | "delivery-reverted"
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
 * keystore signs as another account; an RPC answers for another chain; the live gate; a transaction
 * that reverted on chain with nothing to explain it (`run` re-reads first: a lost race never gets here);
 * and a payout list that doesn't match the vault's on two full scans of its events. (`run` also stops
 * after 30 rounds in a row of "unexpected".) These are states that are unsafe, or wrong, for everyone;
 * one user's delivery never stops the keeper: its reverts only hold that user (the revert budget).
 *
 * Wait (log, back off, next round): an earlier transaction still pending, a nonce race, a simulation
 * that refused the send (the chain changed under it), no receipt yet (the send guard then holds every
 * send until it is mined or dropped), the chain changed since the round's read, a revert whose re-read
 * failed (the next round's read decides), a delivery revert nothing explains, an RPC error or a network
 * failure, and anything else: none of these can send twice, since every send goes through the guards
 * again. The message has any URL's secrets stripped (scrubSecrets). */
export function classifyFailure(e: unknown): Failure {
  // a message can quote an RPC's URL, where a provider's key can sit
  const message = scrubSecrets(e instanceof Error ? e.message : String(e));
  const as = (stop: boolean, kind: FailureKind, label: string, m = message): Failure => ({ stop, kind, label, message: m });
  if (e instanceof KeeperHasCode) return as(true, "keeper-has-code", "the keeper wallet has code");
  if (e instanceof KeeperNotReady) return as(true, "not-ready", "the record isn't ready");
  if (e instanceof RecordMismatch) return as(true, "record", "the record changed");
  if (e instanceof RevertedOnChain) return as(true, "reverted", "an unexplained revert");
  if (e instanceof PayoutListMismatch) return as(true, "payout-list", "the payout list doesn't match the vault");
  if (e instanceof DeliveryReverted) return as(false, "delivery-reverted", "an unexplained delivery revert");
  if (e instanceof RevertUnread) return as(false, "revert-unread", "a revert not yet explained");
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
