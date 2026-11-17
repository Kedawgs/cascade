import type { Hex } from "viem";
import type { CallRequest, ChainName } from "./types.ts";

// The send and record errors the keeper classifies (failures.ts), shared with ops/src/send.ts and record.ts, which
// re-export them: one class each, so `instanceof` holds whichever module threw it.

export const chainLabel = (chain: ChainName) => (chain === "base" ? "Base" : "Bittensor");
export const unit = (chain: ChainName) => (chain === "base" ? "ETH" : "TAO");

/** Why a send was refused before anything was signed; "fee": the chain's gas price is over the cap; "build": a create
 * that cannot be tied to one build; "spend-cap": the keeper's 24 h spend on the chain is at its cap (v3.2, Task 50a);
 * "rails": v3.2's rails refuse it (a hold, the monitor can't see, deliveries off, a payout the monitor never confirmed). */
export type RefusalReason = "not-live" | "chain-id" | "nonce" | "waiting" | "estimate" | "signer" | "fee" | "build" | "spend-cap" | "rails";

export class SendRefused extends Error {
  readonly reason: RefusalReason;

  constructor(reason: RefusalReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** v3.2's spend cap refusing a send at the one send path (Task 50a; R12d, M-1): a SendRefused "spend-cap" that says on
 * which chain, and whether that chain is at its cap (`atCap`: its 24 h sum reads at or over it, so nothing more goes
 * there) or only this send's own worst case would cross what is left (`atCap` false: a smaller send may still fit). The
 * round takes either as a wait, never a failed round: the one chain's sends, or the one send, for the rest of the round. */
export class SpendCapRefused extends SendRefused {
  readonly chain: ChainName;
  readonly atCap: boolean;

  constructor(chain: ChainName, atCap: boolean, message: string) {
    super("spend-cap", message);
    this.chain = chain;
    this.atCap = atCap;
  }
}

/** The transaction was mined and reverted: its receipt's status is not 1. `reason` is why, when the
 * call, replayed at the block it reverted in (revertReason), reverts too: a Cascade contract's error by
 * name (BelowMinimum()), Error(string) with its text ("Too little received"); unset when the replay goes
 * through (the state moved within the block) or the node didn't answer it. `block`, the block it was mined in, when the
 * receipt gave it (R12h: a v3.2 close reads its batch's cancels up to it). */
export class RevertedOnChain extends Error {
  readonly chain: ChainName;
  readonly hash: Hex;
  readonly reason?: string;
  readonly block?: bigint;

  constructor(chain: ChainName, label: string, hash: Hex, reason?: string, block?: bigint) {
    super(`${chainLabel(chain)}: ${label} reverted on chain (transaction ${hash}${reason ? `, ${reason}` : ""})`);
    this.chain = chain;
    this.hash = hash;
    this.reason = reason;
    if (block !== undefined) this.block = block;
  }
}

/** The transaction was sent but no receipt came within the wait. `hash` is unknown when forge timed out.
 * `request` is the call it carries (sendCall's), for a replacement at the same nonce (replaceCall). */
export class ReceiptTimeout extends Error {
  readonly hash?: Hex;
  readonly chain: ChainName;
  readonly nonce: number;
  readonly request?: CallRequest;

  constructor(chain: ChainName, nonce: number, hash?: Hex, request?: CallRequest) {
    super(`${chainLabel(chain)}: no receipt yet for nonce ${nonce}${hash ? ` (transaction ${hash})` : ""}; nothing more will be sent until it is mined or dropped`);
    this.hash = hash;
    this.chain = chain;
    this.nonce = nonce;
    this.request = request;
  }
}

/** The record file a command works from is gone, or now holds another deployment (planned anew, or
 * replaced): `run` stops on it rather than act for a deployment it can no longer see. */
export class RecordMismatch extends Error {}

/** A URL: its scheme, its authority (user info, host, port), and the rest (path, query, fragment). */
const URL_IN_TEXT = /\b([a-z][a-z0-9+.-]*):\/\/([^\s/?#"'<>()[\]]+)([^\s"'<>()[\]]*)/gi;

/** `text` with every URL cut down to its scheme, its host's last two labels and its port (no user info,
 * subdomain, path or query, where a provider's key can sit; a bare "/" carries none and stays, so the
 * sign page's http://127.0.0.1:<port>/ still opens), and every key-like `name=value` value dropped.
 * Unlike redact it needs no list of RPCs: every line the CLI prints goes through it (output.ts). */
export function scrubSecrets(text: string): string {
  return text
    .replace(URL_IN_TEXT, (_m, scheme: string, authority: string, rest: string) => {
      const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
      const colon = hostPort.lastIndexOf(":");
      const host = colon > 0 && !hostPort.endsWith("]") ? hostPort.slice(0, colon) : hostPort;
      const port = host === hostPort ? "" : hostPort.slice(colon);
      const labels = host.split(".");
      const shown = /^[\d.]+$/.test(host) || host.startsWith("[") || labels.length <= 2 ? host : `…${labels.slice(-2).join(".")}`;
      return `${scheme}://${shown}${port}${rest === "" || rest === "/" ? rest : "/…"}`;
    })
    .replace(/\b((?:d|api_?)?key|token|secret|password|passwd)=[^&\s)"']+/gi, "$1=…");
}
