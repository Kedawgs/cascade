import { type Address, encodeFunctionData, type Hex, keccak256, parseTransaction, serializeTransaction, type TransactionSerializable } from "viem";
import type { JournalRow } from "../../ops/src/keeper/core/journal.ts";
import { underCeiling } from "../../ops/src/keeper/core/ceiling.ts";
import { CLAIM_GAS_REQUIRED_MAX, claimGasLimit } from "../../ops/src/keeper/core/rewards.ts";
import { signedCallProblem } from "../../ops/src/keeper/core/send.ts";
import type { CallRequest, ChainName } from "../../ops/src/keeper/core/types.ts";

// A journal row proven by its own signed transaction (the review's Important 1): the row's request is only ever adopted,
// re-signed or replaced when a raw transaction of that request, signed by the keeper's key, proves it. A row written
// over the control route without such a raw is refused there, and one in the journal without it is never watched. So
// a leaked control token can't steer what the keeper signs: only the key can make a raw that passes.
//
// A cancel (Task 51: a transfer of nothing to the keeper itself at a stuck send's nonce, a legitimate keeper send) proves
// nothing but itself (Task 50b re-review N1, as re-ruled): a row whose transaction is a cancel is taken only when its
// request is that cancel. A cancel that replaced a row's transaction stands beside the row's first one, which still
// proves the row's request (the object keeps it: requestRaw).

export interface ProofCtx {
  keeper: Address;
  chainIds: Record<ChainName, number>;
  /** Each chain's transaction type: Bittensor's are legacy */
  legacy: Record<ChainName, boolean>;
}

/** A journal row as the Durable Object keeps it: once a replacement took the place of its first transaction, that first
 * one (which proves the row's request) is kept as `requestRaw`, and `raw` is the newest; `writer` is the lease holder that
 * wrote it ahead (the object sets it: a hand run changes only its own rows over the route, the review's W1). */
export type StoredRow = JournalRow & { requestRaw?: Hex; writer?: string };

/** The highest gas limit a keeper transaction carries: a claim's (Task 51), the vault's highest claimGasRequired (63.4M, its
 * CascadeConstants.MAX_CLAIM_GAS) plus the claim's margin, held to Bittensor's per-transaction ceiling (core/rewards.ts
 * claimGasLimit, core/ceiling.ts: 64.9M, Task 65); anything above is not the keeper's. Everything else it sends is far
 * below (a payout: its estimate plus 2.0M and its hotkeys' unstake gas, a few million). */
export const MAX_PROOF_GAS = underCeiling(claimGasLimit(CLAIM_GAS_REQUIRED_MAX));
/** A cancel's gas: a plain transfer (core/send.ts replaceRaw's). */
export const CANCEL_GAS = 21_000n;

const lower = (a: string | null | undefined) => (a ?? "").toLowerCase();
const isHex = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{2,}$/.test(v);

/** A cancel as a request: a transfer of nothing to the keeper at `nonce`, 21,000 gas, no function and no call data. */
export const cancelRequestOf = (chain: ChainName, nonce: number, keeper: Address): CallRequest => ({
  chain,
  nonce,
  label: `cancel nonce ${nonce}`,
  to: keeper,
  abi: [],
  functionName: "",
  args: [],
  value: 0n,
  gasLimit: CANCEL_GAS,
});

/** Whether `req` is a cancel (cancelRequestOf's shape): to the keeper, value 0, 21,000 gas, and no call at all. */
export const isCancelRequest = (req: CallRequest, keeper: Address): boolean =>
  lower(req.to) === lower(keeper) && (req.value ?? 0n) === 0n && req.gasLimit === CANCEL_GAS && req.functionName === "" && (req.args ?? []).length === 0;

/** The request's call data ("0x" for a cancel), or undefined when it doesn't encode. */
function dataOf(req: CallRequest, keeper: Address): Hex | undefined {
  if (isCancelRequest(req, keeper)) return "0x";
  try {
    return encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args } as never);
  } catch {
    return undefined;
  }
}

/** Why `raw`, at `nonce` on `chain`, is not exactly `req` signed by the keeper within the gas bound; or undefined. A cancel
 * raw proves only a cancel request (cancelRequestOf): never any other. */
export async function rawProblem(raw: unknown, req: CallRequest, chain: ChainName, nonce: number, c: ProofCtx): Promise<string | undefined> {
  if (!isHex(raw)) return "it carries no signed transaction";
  let got: ReturnType<typeof parseTransaction>;
  try {
    got = parseTransaction(raw);
  } catch {
    return "its signed transaction does not decode";
  }
  if (!req || req.chain !== chain || req.nonce !== nonce) return "its request is for another chain or nonce than the row";
  const data = dataOf(req, c.keeper);
  if (data === undefined) return "its request does not encode";
  const aCancel = lower(got.to) === lower(c.keeper) && (got.value ?? 0n) === 0n && lower(got.data ?? "0x") === "0x";
  if (aCancel && !isCancelRequest(req, c.keeper)) return "its signed transaction is a cancel (a transfer of nothing to the keeper), which proves no request but that cancel";
  const fees = c.legacy[chain] ? { type: "legacy" as const, gasPrice: got.gasPrice } : { type: "eip1559" as const, maxFeePerGas: got.maxFeePerGas, maxPriorityFeePerGas: got.maxPriorityFeePerGas };
  const want = {
    ...fees,
    chainId: c.chainIds[chain],
    nonce,
    to: req.to,
    value: req.value ?? 0n,
    data,
    gas: req.gasLimit ?? got.gas,
  } as TransactionSerializable;
  const problem = await signedCallProblem(want, raw, c.keeper);
  if (problem) return `its signed transaction is not its request signed by the keeper: ${problem}`;
  // the fees are the raw's own: only its signature and its call prove a row (the re-review's N3: a fee bound added no
  // security, and refused real sends near a gas price cap); the gas limit stays bounded, a claim's included
  if ((got.gas ?? 0n) > MAX_PROOF_GAS) return `its gas limit ${got.gas} is above ${MAX_PROOF_GAS}, more than any keeper transaction carries`;
  return undefined;
}

/** Why `raw` is not the keeper's cancel at `nonce` on `chain` (to itself, value 0, no data, 21,000 gas); or undefined. */
export const cancelProblem = (raw: unknown, chain: ChainName, nonce: number, c: ProofCtx) => rawProblem(raw, cancelRequestOf(chain, nonce, c.keeper), chain, nonce, c);

/** Why `raw` can't take the place of `row`'s transaction: it is neither the row's request again (a higher fee) nor the
 * keeper's cancel at the row's nonce; or undefined. The row's request itself is never proven by a cancel. */
export async function replacementProblem(raw: unknown, row: Pick<JournalRow, "request" | "chain" | "nonce">, c: ProofCtx): Promise<string | undefined> {
  const asRequest = await rawProblem(raw, row.request, row.chain, row.nonce, c);
  if (!asRequest) return undefined;
  if (!(await cancelProblem(raw, row.chain, row.nonce, c))) return undefined;
  return `${asRequest}; nor is it the keeper's cancel at nonce ${row.nonce}`;
}

/** Why `row` is not proven by its own raws: the keeper's; its request proven by its first transaction (its raw, or once
 * replaced, requestRaw at its first hash); its newest transaction its last hash, and that request or the keeper's cancel at
 * its nonce. Undefined when it is proven. */
export async function rowProblem(row: StoredRow, c: ProofCtx): Promise<string | undefined> {
  if (!row || typeof row !== "object" || !row.request || !Array.isArray(row.hashes) || !row.hashes.length) return "it is not a journal row";
  if (lower(row.from) !== lower(c.keeper)) return `it is from ${row.from}, not the keeper ${c.keeper}`;
  // the core journals a cancel as the replacement of its stuck send's row, never as a row of its own, which its replaceRaw
  // could not replace (the review's W2): such a row is never written over the route, nor adopted
  if (isCancelRequest(row.request, c.keeper)) return "its request is a cancel, which the keeper never journals as a row of its own (a cancel is the replacement of its stuck send's row)";
  if (!isHex(row.raw)) return "it carries no signed transaction";
  if (lower(keccak256(row.raw)) !== lower(row.hashes.at(-1))) return "its signed transaction is not its last hash";
  if (row.requestRaw === undefined) return rawProblem(row.raw, row.request, row.chain, row.nonce, c);
  // replaced since it was written: its first transaction proves the request, the newest is that request or a cancel
  if (!isHex(row.requestRaw)) return "its first signed transaction is unreadable";
  if (lower(keccak256(row.requestRaw)) !== lower(row.hashes[0])) return "its first signed transaction is not its first hash";
  const first = await rawProblem(row.requestRaw, row.request, row.chain, row.nonce, c);
  if (first) return `its first transaction: ${first}`;
  return replacementProblem(row.raw, row, c);
}

/** `raw` without its signature: the same call, gas and fees (what the 24 h spend cap reads of a row), but nothing any node
 * would take (the re-review's N5: the control route never serves a signed transaction a token holder could broadcast). */
export function unsignedOf(raw: Hex): Hex {
  try {
    const { r: _r, s: _s, v: _v, yParity: _y, ...rest } = parseTransaction(raw) as ReturnType<typeof parseTransaction> & { yParity?: number };
    return serializeTransaction(rest as TransactionSerializable);
  } catch {
    return "0x";
  }
}

/** A transaction a node holds, as eth_getTransactionByHash answers it. */
export interface PooledTx {
  from: Address;
  nonce: Hex;
  blockNumber: Hex | null;
  to?: Address | null;
  input?: Hex;
  value?: Hex;
}

/** Whether a pooled transaction is `req` itself (its to, input and value), or the keeper's cancel at its nonce: the only
 * ones the keeper replaces. */
export function poolMatches(tx: PooledTx, req: CallRequest, keeper: Address): boolean {
  const value = BigInt(tx.value ?? "0x0");
  if (lower(tx.to) === lower(keeper) && value === 0n && lower(tx.input ?? "0x") === "0x") return true;
  const data = dataOf(req, keeper);
  return data !== undefined && lower(tx.to) === lower(req.to) && lower(tx.input) === lower(data) && value === (req.value ?? 0n);
}
