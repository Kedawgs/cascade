import {
  type Abi,
  type Address,
  decodeErrorResult,
  encodeFunctionData,
  formatEther,
  type Hex,
  hexToBigInt,
  hexToNumber,
  keccak256,
  numberToHex,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerializable,
} from "viem";
import { BITTENSOR_TX_GAS_CEILING } from "./ceiling.ts";
import { chainLabel, ReceiptTimeout, RevertedOnChain, SendRefused, SpendCapRefused, unit } from "./errors.ts";
import { type Journal, SPEND_WINDOW_MS, spendRows, spentOn } from "./journal.ts";
import { chainIdOf, gasPriceOf, isRevert, priorityFeeOf, type Rpc, RpcError } from "./rpc.ts";
import type { CallRequest, ChainName, Replacement, Sent } from "./types.ts";

// The core's one send path (design-keeper-worker.md §1): encode, estimate, the gas caps, the nonce guard, the signer,
// the write-ahead to the journal, eth_sendRawTransaction, then a bounded wait for the receipt. The same path for both
// hosts; only the Signer differs (the PC's cast keystore, keeper/cast-signer.ts; the Worker's viem account, Task 50b).
// v3-launch's live keeper keeps its `cast send` path (send.ts sendCall): nothing of it goes through here.

/** Who signs: its address, and a signature over a whole transaction (the signed, serialized transaction back).
 * sendRaw checks what comes back is that transaction from that address (signedCallProblem), whoever signed it. */
export interface Signer {
  address: Address;
  signTransaction(tx: TransactionSerializable): Promise<Hex>;
}

/** What a chain's transactions look like: its id, and whether it takes only legacy (gas price) transactions. */
export interface ChainSettings {
  chainId: number;
  legacy: boolean;
}

export interface SendCtx {
  rpc: Rpc;
  chains: Record<ChainName, ChainSettings>;
  /** The highest gas price a send goes out at, per chain, in wei (OPS_MAX_GAS_PRICE_*): over it the send is refused
   * ("fee") and tried again later; a fee cap over twice it is refused too. Absent: no cap. */
  maxGasPrice?: Partial<Record<ChainName, bigint>>;
  /** How long a send waits for its receipt before ReceiptTimeout (the Worker: 40 s) */
  receiptTimeoutMs: number;
  pollMs?: number;
  /** The custom errors an estimate's or a replay's revert is named from (the published vault ABI's, the door's) */
  errors?: Abi;
  journal: Journal;
  log(line: string): void;
  /** The host's clock (ms) and its wait, for the receipt's deadline */
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** The most the keeper may spend on each chain in 24 hours, gas plus value, in wei (Task 50a): summed from the
   * journal, a send (or a replacement) on a chain already at its cap is refused ("spend-cap"). The round's rails stop
   * that chain's sends first and say so; this is the backstop at the one send path. Absent: no cap. */
  spendCap?: Partial<Record<ChainName, bigint>>;
  /** What a mined call sent back to the keeper of the value it carried (v3.2: a close's refund, from its BatchClosed),
   * kept in the journal row for the spend cap. Absent: nothing. */
  returnedOf?(req: CallRequest, logs: Sent["logs"]): bigint;
  /** v3.2's rails at the one send path (T50a review I2): throws SendRefused "rails" unless the rails (the monitor's
   * hold or outage, the deliveries switch for a delivery, okKeys for a payout; the migration exception for a token
   * park's conversion) allow `req` now, so every v3.2 send is refused under them, whichever entry point made it. A
   * replacement passes it too. Required (re-review Minor 1): only depsV32 builds a SendCtx; v3-launch never comes here. */
  railsCheck(req: CallRequest, o?: { cancel?: boolean }): Promise<void>;
  /** Settles the journal's unsettled rows before the spend cap sums them (settlePending; v3.2's deps pass it). */
  settle?(): Promise<void>;
  /** v3.2 (the controller's ruling for Task 52): whether `req`, tagged as the migration conversion, passes the spend cap now
   * (a token park's conversion while ForeverMoney's migration notice runs, read on chain, fail closed), as a cancel does;
   * counted all the same (its row is written ahead). Asked only of a tagged request; absent: nothing tagged passes. */
  capExempt?(req: CallRequest): Promise<boolean>;
}

/** Whether `req` passes the spend cap (SendCtx.capExempt): only a request tagged as the migration conversion is asked. */
const passesCap = async (ctx: SendCtx, req: CallRequest): Promise<boolean> => req.rail === "migration-conversion" && ctx.capExempt !== undefined && (await ctx.capExempt(req));

const gwei = (wei: bigint) => `${Number(wei) / 1e9} gwei`;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** secp256k1's order over 2: a signature whose s is above it is the malleable twin, which nodes refuse. */
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** A failed call's reason: a contract's error by name (from `errors`), Error(string) with its text, else the node's
 * message. */
export function describeRevert(e: unknown, errors?: Abi): string {
  const raw = e instanceof RpcError ? e.data : undefined;
  const data = typeof raw === "string" ? raw : (raw as { data?: unknown } | undefined)?.data;
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    try {
      const d = decodeErrorResult({ abi: [...(errors ?? []), ...ERROR_STRING], data: data as Hex });
      return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
    } catch {
      return `${(e as Error).message}, revert data ${data}`;
    }
  }
  return (e as Error).message;
}

const ERROR_STRING: Abi = [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }];

/** The custom error's name a reason begins with ("WrongBatch(7)" -> "WrongBatch"), or undefined. */
export const errorName = (reason: string | undefined): string | undefined => reason?.match(/\b([A-Z][A-Za-z0-9]*)\(/)?.[1];

/** Why the signed transaction `raw` is not `tx` signed by `from`, or null. Decoded back, every field must be the one
 * sent for (the type, the chain id, the nonce, the recipient, the value, the data byte for byte, the gas, the fee
 * fields, no access list), its signature's s must be low (nodes refuse the malleable twin), and it must recover to
 * `from`. Whatever signed it (a keystore, a Worker secret), nothing else goes out. */
export async function signedCallProblem(tx: TransactionSerializable, raw: Hex, from: Address): Promise<string | null> {
  let got: ReturnType<typeof parseTransaction>;
  try {
    got = parseTransaction(raw);
  } catch (e) {
    return `it does not decode (${(e as Error).message.split("\n")[0]})`;
  }
  const fees = tx.type === "legacy" ? ["gasPrice"] : ["maxFeePerGas", "maxPriorityFeePerGas"];
  const field = (o: unknown, k: string) => (o as Record<string, unknown>)[k];
  const lower = (a: unknown) => (typeof a === "string" ? a.toLowerCase() : a);
  const pairs: [string, unknown, unknown][] = [
    ["type", got.type, tx.type],
    ["chainId", got.chainId, tx.chainId],
    ["nonce", got.nonce, tx.nonce],
    ["to", lower(got.to ?? null), lower(tx.to ?? null)],
    ["value", got.value ?? 0n, tx.value ?? 0n],
    ["data", (got.data ?? "0x").toLowerCase(), (tx.data ?? "0x").toLowerCase()],
    ["gas", got.gas, tx.gas],
    ...fees.map((f): [string, unknown, unknown] => [f, field(got, f), field(tx, f)]),
    ["access list's length", ((field(got, "accessList") as unknown[] | undefined) ?? []).length, 0],
  ];
  for (const [name, g, w] of pairs) {
    if (g !== w) return name === "data" ? "its data is not the call's" : `its ${name} is ${String(g)}, not ${String(w)}`;
  }
  if (!got.s || !got.r) return "it carries no signature";
  if (hexToBigInt(got.s) > HALF_N) return "its signature's s is high (the malleable twin), which nodes refuse";
  const by = await recoverTransactionAddress({ serializedTransaction: raw as never });
  return by.toLowerCase() === from.toLowerCase() ? null : `it recovers to ${by}, not ${from}`;
}

/** Why `price`, what the transaction would pay a gas now, is over the chain's cap; or undefined. */
function overCap(ctx: Pick<SendCtx, "maxGasPrice">, chain: ChainName, price: bigint): string | undefined {
  const cap = ctx.maxGasPrice?.[chain];
  if (cap === undefined || price <= cap) return undefined;
  return `${chainLabel(chain)}: the gas price is ${gwei(price)}, over the ${gwei(cap)} cap (OPS_MAX_GAS_PRICE_${chain.toUpperCase()})`;
}

/** The spend cap's check (Task 50a): refused ("spend-cap", a SpendCapRefused at the cap: the chain's other sends wait too)
 * when what the journal shows the keeper spent on the request's chain in the last 24 hours (gas plus value; an unsettled
 * send at its worst case) is at or over the chain's cap. What it read, for the check of the send's own worst case once its
 * gas is known (withinCap); undefined with no cap. */
async function underCap(ctx: SendCtx, req: CallRequest): Promise<{ cap: bigint; spent: bigint } | undefined> {
  const cap = ctx.spendCap?.[req.chain];
  if (cap === undefined) return undefined;
  // a send that can no longer land leaves the sum first (settlePending)
  await ctx.settle?.();
  const now = (ctx.now ?? Date.now)();
  const spent = spentOn(await spendRows(ctx.journal, now), req.chain, now);
  if (spent >= cap) {
    throw new SpendCapRefused(
      req.chain,
      true,
      `${chainLabel(req.chain)}: the keeper has sent ${formatEther(spent)} ${unit(req.chain)} in the last 24 hours, at or over its ${formatEther(cap)} ${unit(req.chain)} cap; ${req.label} not sent`,
    );
  }
  return { cap, spent };
}

/** What of a send's value the spend cap's check counts (R12a): what it is expected to keep (CallRequest.valueKept: a
 * close's quoted bridge fee less its batch's pot, R12d L-2), never more than its value; its whole value when that is
 * unset. */
const keptOf = (req: CallRequest): bigint => {
  const value = req.value ?? 0n;
  return req.valueKept !== undefined && req.valueKept < value ? req.valueKept : value;
};

/** The spend cap's check of the send itself (Task 65, the T61a review's spend-cap carry; R12a): refused ("spend-cap") when
 * its worst case, its gas limit at the fee cap it is signed with (Bittensor takes it all up front) and the value it keeps
 * (keptOf: a close's quoted bridge fee less its pot, the rest of its float sent back by the door; any other send's whole value), would
 * take what the keeper spent in the last 24 hours over the cap. So the cap is judged against what the send costs as its
 * row counts it once mined: what its receipt says it cost in gas (gasUsed × effectiveGasPrice), never the limit, and its
 * value less what came back (journal.ts spentOf). Before R12a its value was left out, so a close that fit by its gas
 * could land the keeper over the cap, and every send on that chain then waited up to 24 hours. Its refusal is a
 * SpendCapRefused not at the cap (R12d, M-1): only this send waits, and the round goes on to the rest, a smaller send on
 * the same chain included, since the chain itself is still under its cap. */
function withinCap(read: { cap: bigint; spent: bigint } | undefined, req: CallRequest, gas: bigint, feeCap: bigint): void {
  if (!read) return;
  const kept = keptOf(req);
  const worst = gas * feeCap + kept;
  if (read.spent + worst <= read.cap) return;
  const u = unit(req.chain);
  const value = req.value ?? 0n;
  const keeps = kept === 0n ? "" : kept === value ? `, and the ${formatEther(kept)} ${u} value it carries` : `, and the ${formatEther(kept)} ${u} of its ${formatEther(value)} ${u} value it keeps`;
  throw new SpendCapRefused(
    req.chain,
    false,
    `${chainLabel(req.chain)}: ${req.label} could cost up to ${formatEther(worst)} ${u} (a ${gas.toLocaleString("en-US")} gas limit at ${gwei(feeCap)}${keeps}), and the keeper has sent ${formatEther(read.spent)} ${u} in the last 24 hours: that would cross its ${formatEther(read.cap)} ${u} cap; nothing sent`,
  );
}

/** The sends whose gas used is logged beside their gas limit, one GAS USED line each (the carry of 2026-11-11: the gas
 * settings are tuned from live data): a claim and a payout (an exit's payment), each a call to the vault. */
const GAS_LOGGED = new Set(["claimRewards", "processPayouts"]);

/** A claim's or a payout's GAS USED line: what it used of its gas limit, and whether it reverted. */
function logGasUsed(ctx: Pick<SendCtx, "log">, req: CallRequest, label: string, gasUsed: bigint, limit: bigint | undefined, hash: Hex, reverted: boolean): void {
  if (!GAS_LOGGED.has(req.functionName)) return;
  const of = limit ? ` of its ${limit.toLocaleString("en-US")} gas limit (${(Number((gasUsed * 1000n + limit / 2n) / limit) / 10).toFixed(1)}%)` : "";
  ctx.log(`GAS USED: ${chainLabel(req.chain)}: ${label}: ${gasUsed.toLocaleString("en-US")}${of}${reverted ? ", reverted" : ""}; transaction ${hash}`);
}

/** A signed transaction's gas limit, or undefined when it doesn't decode. */
function gasOfRaw(raw: Hex): bigint | undefined {
  try {
    return parseTransaction(raw).gas;
  } catch {
    return undefined;
  }
}

/** The chain id, and the nonce guard: nothing of `from`'s pending on `chain` (its mined and pending nonces equal), and
 * that nonce the request's. So at most one transaction is in flight a chain, and a cut-off run's successor reuses the
 * unmined nonce: two can never both land. */
async function guard(ctx: SendCtx, from: Address, req: CallRequest): Promise<void> {
  const id = await chainIdOf(ctx.rpc, req.chain);
  if (id !== ctx.chains[req.chain].chainId) {
    throw new SendRefused("chain-id", `${chainLabel(req.chain)}: the RPC reports chain id ${id}, expected ${ctx.chains[req.chain].chainId}`);
  }
  const pending = hexToNumber((await ctx.rpc.request(req.chain, "eth_getTransactionCount", [from, "pending"])) as Hex);
  const mined = hexToNumber((await ctx.rpc.request(req.chain, "eth_getTransactionCount", [from, "latest"])) as Hex);
  if (mined !== pending) {
    throw new SendRefused("waiting", `${chainLabel(req.chain)}: an earlier transaction from the keeper (nonce ${mined}) is still waiting to be mined; nothing sent — try again once it is`);
  }
  if (pending !== req.nonce) throw new SendRefused("nonce", `${chainLabel(req.chain)}: the wallet's next nonce is ${pending}, the request expected ${req.nonce}`);
}

type Receipt = { status: Hex; blockNumber: Hex; gasUsed: Hex; effectiveGasPrice: Hex; logs?: Sent["logs"] };

/** Polls for one of `hashes`' receipts until the deadline (an RPC error is retried: the transaction is out). */
async function waitReceipt(ctx: SendCtx, req: CallRequest, hashes: readonly Hex[]): Promise<{ hash: Hex; r: Receipt }> {
  const now = ctx.now ?? Date.now;
  const pause = ctx.sleep ?? wait;
  const deadline = now() + ctx.receiptTimeoutMs;
  for (;;) {
    for (const hash of [...hashes].reverse()) {
      try {
        const r = (await ctx.rpc.request(req.chain, "eth_getTransactionReceipt", [hash])) as Receipt | null;
        if (r) return { hash, r };
      } catch {
        // keep waiting: the transaction was broadcast
      }
    }
    if (now() >= deadline) throw new ReceiptTimeout(req.chain, req.nonce, hashes.at(-1), req);
    await pause(ctx.pollMs ?? 3_000);
  }
}

/** Why a mined call reverted, as far as a replay can tell: its call at the block it was mined in, then the block
 * before; the first that reverts names the reason. Reads only. */
async function revertReason(ctx: SendCtx, req: CallRequest, tx: { from: Address; to: Address; data: Hex; value: Hex }, block: Hex): Promise<string | undefined> {
  const mined = hexToBigInt(block);
  for (const at of [mined, mined - 1n]) {
    if (at < 0n) break;
    try {
      await ctx.rpc.request(req.chain, "eth_call", [tx, numberToHex(at)]);
    } catch (e) {
      return isRevert(e) ? describeRevert(e, ctx.errors) : undefined;
    }
  }
  return undefined;
}

/** The receipt as a Sent, the journal moved on (a claim's or a payout's GAS USED said beside its `limit`); a revert throws
 * RevertedOnChain with its replayed reason. */
async function settle(ctx: SendCtx, req: CallRequest, call: { from: Address; to: Address; data: Hex; value: Hex }, label: string, hash: Hex, r: Receipt, limit?: bigint): Promise<Sent> {
  const gasUsed = hexToBigInt(r.gasUsed);
  const receipt = { hash, block: hexToNumber(r.blockNumber), gasUsed, costWei: gasUsed * hexToBigInt(r.effectiveGasPrice) };
  logGasUsed(ctx, req, label, gasUsed, limit, hash, r.status !== "0x1");
  if (r.status !== "0x1") {
    await ctx.journal.update(hash, { status: "reverted", receipt });
    throw new RevertedOnChain(req.chain, label, hash, await revertReason(ctx, req, call, r.blockNumber), hexToBigInt(r.blockNumber));
  }
  const returned = ctx.returnedOf ? ctx.returnedOf(req, r.logs ?? []) : 0n;
  await ctx.journal.update(hash, { status: "landed", receipt, ...(returned ? { returned } : {}) });
  return { hash, block: receipt.block, gasUsed, costWei: receipt.costWei, logs: r.logs ?? [] };
}

/** Settles the journal's unsettled rows (signed, sent), so the spend cap counts each only while it may still land (T50a
 * re-review B, round-2 R2-1):
 * - a receipt for one of its hashes (the newest first: a replacement that landed) settles it at its actual cost:
 *   `landed` (with what the call sent back: ctx.returnedOf), `reverted`, or `cancelled` for a cancel at its nonce;
 * - else, once the wallet's mined nonce (its transaction count at the chain's head, both read before the receipts, so a
 *   transaction mined meanwhile shows its receipt) is past the row's, nothing can land at it any more, unless the node
 *   that answered no receipt is behind the one that answered the nonce (a load-balanced or pruned RPC). So the first such
 *   reading only marks the row (`passedAt`, the head it was read at), and the row is marked `dropped`, which counts 0
 *   and is said once, only at a second reading in a row a block later or more, as the round's own watch ends one only
 *   on the second (round.ts lookUpReceipts). A reading that sees the nonce not past clears the mark;
 * - else it stays as it is, counted at its worst case.
 * A dropped row of the spend cap's window is looked up again too: a receipt found later settles it as above, at its
 * actual cost (a drop is never final while it still counts for the cap). A read that fails leaves its row as it is
 * (still counted: fail closed). The Worker's run-start settling (Task 50b) calls this too, through v3.2's deps
 * (settleJournal), so both hosts keep one rule. */
export async function settlePending(ctx: Pick<SendCtx, "rpc" | "journal" | "returnedOf" | "log" | "now">): Promise<void> {
  const nowMs = (ctx.now ?? Date.now)();
  const rows = await ctx.journal.pending();
  const dropped = (await ctx.journal.since(nowMs - SPEND_WINDOW_MS)).filter((r) => r.status === "dropped");
  const heads = new Map<ChainName, number>();
  const mined = new Map<string, number>();
  for (const row of [...rows, ...dropped]) {
    try {
      const unsettled = row.status === "signed" || row.status === "sent";
      let head: number | undefined;
      let nonce: number | undefined;
      if (unsettled) {
        head = heads.get(row.chain);
        if (head === undefined) {
          head = hexToNumber((await ctx.rpc.request(row.chain, "eth_blockNumber", [])) as Hex);
          heads.set(row.chain, head);
        }
        const account = `${row.chain}:${row.from.toLowerCase()}`;
        nonce = mined.get(account);
        if (nonce === undefined) {
          nonce = hexToNumber((await ctx.rpc.request(row.chain, "eth_getTransactionCount", [row.from, numberToHex(head)])) as Hex);
          mined.set(account, nonce);
        }
      }
      let found: { hash: Hex; r: Receipt & { to?: Address | null } } | undefined;
      for (const hash of [...row.hashes].reverse()) {
        const r = (await ctx.rpc.request(row.chain, "eth_getTransactionReceipt", [hash])) as (Receipt & { to?: Address | null }) | null;
        if (r) {
          found = { hash, r };
          break;
        }
      }
      if (found) {
        const gasUsed = hexToBigInt(found.r.gasUsed);
        const receipt = { hash: found.hash, block: hexToNumber(found.r.blockNumber), gasUsed, costWei: gasUsed * hexToBigInt(found.r.effectiveGasPrice) };
        const cancel = !!found.r.to && found.r.to.toLowerCase() === row.from.toLowerCase() && row.request.to.toLowerCase() !== row.from.toLowerCase();
        const reverted = found.r.status !== "0x1";
        // a late receipt of a claim or a payout says its GAS USED once, as the send's own wait would have
        if (unsettled && !cancel) logGasUsed(ctx, row.request, row.request.label, gasUsed, gasOfRaw(row.raw), found.hash, reverted);
        const returned = reverted || cancel || !ctx.returnedOf ? 0n : ctx.returnedOf(row.request, found.r.logs ?? []);
        await ctx.journal.update(found.hash, { status: reverted ? "reverted" : cancel ? "cancelled" : "landed", receipt, ...(returned ? { returned } : {}) });
        continue;
      }
      // a dropped row still without a receipt stays dropped
      if (!unsettled || head === undefined || nonce === undefined) continue;
      if (nonce <= row.nonce) {
        if (row.passedAt) await ctx.journal.update(row.hashes[0], { passedAt: 0 });
        continue;
      }
      if (!row.passedAt) {
        await ctx.journal.update(row.hashes[0], { passedAt: head });
        continue;
      }
      if (head > row.passedAt) {
        await ctx.journal.update(row.hashes[0], { status: "dropped" });
        ctx.log(
          `DROPPED: transaction${row.hashes.length === 1 ? "" : "s"} ${row.hashes.join(", ")} (${row.request.label}, nonce ${row.nonce} on ${chainLabel(row.chain)}): the wallet's mined nonce is past it and it has no receipt, so it can no longer land; it no longer counts toward the spend cap`,
        );
      }
    } catch {
      // read again next time; until then the row counts at its worst case
    }
  }
}

/** Why a mined call of `req` (sent from `from`) reverted, as far as its replay at the block it was mined in (then the
 * one before) can tell: for a receipt found later than the send's own wait (the round's late receipts). Reads only. */
export async function replayReason(ctx: Pick<SendCtx, "rpc" | "errors">, req: CallRequest, from: Address, block: Hex): Promise<string | undefined> {
  const data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args } as never);
  return revertReason(ctx as SendCtx, req, { from, to: req.to, data, value: numberToHex(req.value ?? 0n) }, block);
}

/** The gas limit a call goes out with (limitOf), never above Bittensor's per-transaction ceiling on Bittensor (Task 65:
 * its pool refuses a transaction whose limit is above about 64,998,400, whatever the block's 75,000,000): one that would
 * is refused ("estimate"), nothing signed. Every keeper request is held under it already; this is the last check. */
function gasLimitOf(req: CallRequest, estimate: bigint): bigint {
  const gas = limitOf(req, estimate);
  if (req.chain === "bittensor" && gas > BITTENSOR_TX_GAS_CEILING) {
    throw new SendRefused(
      "estimate",
      `${chainLabel(req.chain)}: ${req.label} would go with a ${gas.toLocaleString("en-US")} gas limit, above Bittensor's per-transaction ceiling of ${BITTENSOR_TX_GAS_CEILING.toLocaleString("en-US")} (its pool refuses more); nothing sent`,
    );
  }
  return gas;
}

/** The gas limit a call asks: exactly `gasLimit` (refused when the estimate is above it), else the estimate plus
 * `gasAbove` (v3.2's payout gas rule; R4's parked-delivery floor), at most `gasMax` (an estimate above it refused; with
 * `gasAboveWhole`, the estimate plus gasAbove above it refused too, never cut), else 1.25× the estimate, and at least the
 * estimate plus `gasFloor` (a call that catches an inner call's failure). */
function limitOf(req: CallRequest, estimate: bigint): bigint {
  if (req.gasLimit !== undefined) {
    if (estimate > req.gasLimit) {
      throw new SendRefused(
        "estimate",
        `${chainLabel(req.chain)}: ${req.label} needs ${estimate.toLocaleString("en-US")} gas, more than the ${req.gasLimit.toLocaleString("en-US")} it is sent with; nothing sent`,
      );
    }
    return req.gasLimit;
  }
  if (req.gasMax !== undefined && estimate > req.gasMax) {
    throw new SendRefused(
      "estimate",
      `${chainLabel(req.chain)}: ${req.label} needs ${estimate.toLocaleString("en-US")} gas, more than the ${req.gasMax.toLocaleString("en-US")} it may be sent with; nothing sent`,
    );
  }
  if (req.gasAbove !== undefined) {
    const limit = estimate + req.gasAbove;
    if (req.gasMax !== undefined && limit > req.gasMax && req.gasAboveWhole) {
      throw new SendRefused(
        "estimate",
        `${chainLabel(req.chain)}: ${req.label} needs ${estimate.toLocaleString("en-US")} gas and ${req.gasAbove.toLocaleString("en-US")} above it (its floor), more than the ${req.gasMax.toLocaleString("en-US")} it may be sent with; nothing sent`,
      );
    }
    return req.gasMax !== undefined && limit > req.gasMax ? req.gasMax : limit;
  }
  const scaled = (estimate * 125n + 99n) / 100n;
  return req.gasFloor !== undefined && estimate + req.gasFloor > scaled ? estimate + req.gasFloor : scaled;
}

/** Signs `tx` with `signer` and checks what came back (signedCallProblem): refused ("signer") otherwise. */
async function signed(signer: Signer, tx: TransactionSerializable): Promise<{ raw: Hex; hash: Hex }> {
  let raw: Hex;
  try {
    raw = await signer.signTransaction(tx);
  } catch (e) {
    if (e instanceof SendRefused) throw e;
    throw new SendRefused("signer", `the keeper's signer did not sign (${(e as Error).message.split("\n")[0]}); nothing sent`);
  }
  const problem = await signedCallProblem(tx, raw, signer.address);
  if (problem) throw new SendRefused("signer", `the signed transaction, decoded back, is not the call: ${problem}; nothing sent`);
  return { raw, hash: keccak256(raw) };
}

/** Broadcasts `raw`. A refusal whose transaction the node took all the same (its answer lost on the way back) is a
 * send; one no node knows, with the nonce still free, was never sent: the row says so, and the error is thrown. */
async function broadcast(ctx: SendCtx, from: Address, req: CallRequest, raw: Hex, hash: Hex): Promise<void> {
  try {
    await ctx.rpc.request(req.chain, "eth_sendRawTransaction", [raw]);
  } catch (e) {
    const known = await ctx.rpc.request(req.chain, "eth_getTransactionByHash", [hash]).catch(() => null);
    const pending = await ctx.rpc
      .request(req.chain, "eth_getTransactionCount", [from, "pending"])
      .then((n) => hexToNumber(n as Hex))
      .catch(() => undefined);
    if (!known && pending !== undefined && pending <= req.nonce) {
      await ctx.journal.update(hash, { status: "never-sent" });
      throw new Error(`${chainLabel(req.chain)}: ${req.label} was not sent, as far as the node says (${(e as Error).message.split("\n")[0]}); the next round decides again`);
    }
  }
  await ctx.journal.update(hash, { status: "sent" });
}

/** Sends `req` as `signer`, signed raw: the chain id and the nonce guard, the estimate (a revert refuses: "estimate",
 * named from ctx.errors), the gas limit (gasLimitOf), the gas price under the cap ("fee"), a tip no higher than the
 * price and a fee cap of twice the price, never over twice the cap; then signed and checked, written ahead to the
 * journal, broadcast, and its receipt waited for (ReceiptTimeout with its hash and request when none comes in time);
 * a revert throws RevertedOnChain with its reason. */
export async function sendRaw(ctx: SendCtx, signer: Signer, req: CallRequest): Promise<Sent> {
  const from = signer.address;
  await guard(ctx, from, req);
  // a token park's conversion during ForeverMoney's migration notice passes the cap (Task 52), still counted
  const capRead = (await passesCap(ctx, req)) ? undefined : await underCap(ctx, req);
  await ctx.railsCheck(req);
  const data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args } as never);
  const value = req.value ?? 0n;
  const call = { from, to: req.to, data, value: numberToHex(value) };
  let estimate: bigint;
  try {
    estimate = hexToBigInt((await ctx.rpc.request(req.chain, "eth_estimateGas", [call])) as Hex);
  } catch (e) {
    throw new SendRefused("estimate", `${chainLabel(req.chain)}: ${req.label} would fail, nothing sent (${describeRevert(e, ctx.errors)})`);
  }
  const gas = gasLimitOf(req, estimate);
  const price = await gasPriceOf(ctx.rpc, req.chain);
  const over = overCap(ctx, req.chain, price);
  if (over) throw new SendRefused("fee", `${over}; ${req.label} waits for it to fall; nothing sent`);
  const c = ctx.chains[req.chain];
  // a send whose room was checked at a fee cap (a claim): never signed above it (T51 re-review m1)
  const feeCapNow = c.legacy ? price : 2n * price;
  if (req.maxFeeCap !== undefined && feeCapNow > req.maxFeeCap) {
    throw new SendRefused(
      "fee",
      `${chainLabel(req.chain)}: the fee cap now, ${gwei(feeCapNow)}, is above the ${gwei(req.maxFeeCap)} the claim's room was checked at; ${req.label} waits for the next reading; nothing sent`,
    );
  }
  const tip = c.legacy ? 0n : await priorityFeeOf(ctx.rpc, req.chain);
  if (tip > price) throw new SendRefused("fee", `${chainLabel(req.chain)}: the node suggests a priority fee of ${gwei(tip)}, above its gas price of ${gwei(price)}; ${req.label} not sent`);
  const maxFee = 2n * price;
  const cap = ctx.maxGasPrice?.[req.chain];
  if (!c.legacy && cap !== undefined && maxFee > 2n * cap) {
    throw new SendRefused("fee", `${chainLabel(req.chain)}: a fee cap of ${gwei(maxFee)} is over twice the ${gwei(cap)} cap; ${req.label} not sent`);
  }
  // its own worst case within what is left of the spend cap (Task 65)
  withinCap(capRead, req, gas, c.legacy ? price : maxFee);
  ctx.log(`${chainLabel(req.chain)}: ${req.label} — est. ${estimate.toLocaleString("en-US")} gas ≈ ${formatEther(estimate * price)} ${unit(req.chain)}`);
  const tx: TransactionSerializable = c.legacy
    ? { type: "legacy", chainId: c.chainId, nonce: req.nonce, to: req.to, gas, gasPrice: price, data, value }
    : { type: "eip1559", chainId: c.chainId, nonce: req.nonce, to: req.to, gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, data, value };
  const { raw, hash } = await signed(signer, tx);
  await ctx.journal.writeAhead({ chain: req.chain, from, nonce: req.nonce, hashes: [hash], request: req, raw, status: "signed", at: (ctx.now ?? Date.now)() });
  await broadcast(ctx, from, req, raw, hash);
  const got = await waitReceipt(ctx, req, [hash]);
  return settle(ctx, req, call, req.label, got.hash, got.r, gas);
}

/** A replacement's fee over the pending transaction's: 12.5% (nodes take a replacement from 10% more). */
const bumped = (fee: bigint) => (fee * 1125n + 999n) / 1000n;
/** Gas for a plain transfer of nothing to oneself: the cancel. */
const CANCEL_GAS = 21_000n;

type PoolTx = { from: Address; nonce: Hex; blockNumber: Hex | null; gasPrice?: Hex; maxFeePerGas?: Hex; maxPriorityFeePerGas?: Hex };

/** Replaces the signer's own pending transaction at req.nonce (one of `pending`, its hashes oldest first) at the same
 * nonce with a higher fee, signed raw: send.ts replaceCall's rules (the same call when it still passes its estimate,
 * a cancel when that estimate is a genuine revert, nothing when the node didn't answer; nothing unless the newest
 * hash still in the pool is the signer's at req.nonce and nothing has been mined there; nothing over the price cap;
 * fees 12.5% over the pending one's, never under the node's). The replacement is written to the journal's row before
 * its broadcast. Two transactions at one nonce can't both be mined, so this never doubles a send.
 * With `cancel` (T51 re-review R1: a claim, never fee-bumped; any stuck send on a chain at its spend cap), it is the
 * cancel straight away, no estimate: 21,000 gas at the lowest replacement fee. A cancel passes the spend cap (its worst
 * case is tiny and it can only lower the sum; its row is counted at it), never the rails' hold. A cancel also goes when the
 * stuck transaction is in no node's pool any more while its nonce is still the wallet's next (T51 round-2 re-review r2-a,
 * Task 53), at 12.5% over the node's price: else that nonce could never be taken on a capped chain. */
export async function replaceRaw(ctx: SendCtx, signer: Signer, req: CallRequest, pending: readonly Hex[], o: { cancel?: boolean } = {}): Promise<Replacement> {
  const chain = req.chain;
  const from = signer.address;
  const id = await chainIdOf(ctx.rpc, chain);
  if (id !== ctx.chains[chain].chainId) throw new SendRefused("chain-id", `${chainLabel(chain)}: the RPC reports chain id ${id}, expected ${ctx.chains[chain].chainId}`);
  // a cancel passes the cap (T51 re-review R1), and so does a token park's conversion during the notice (Task 52)
  if (!o.cancel && !(await passesCap(ctx, req))) await underCap(ctx, req);
  await ctx.railsCheck(req, { cancel: o.cancel === true });
  let pooled: { hash: Hex; tx: PoolTx } | undefined;
  for (const hash of [...pending].reverse()) {
    const tx = (await ctx.rpc.request(chain, "eth_getTransactionByHash", [hash])) as PoolTx | null;
    if (!tx) continue;
    if (tx.blockNumber !== null) return { replaced: false, reason: `transaction ${hash} was mined meanwhile (block ${hexToNumber(tx.blockNumber)})` };
    if (tx.from.toLowerCase() !== from.toLowerCase() || hexToNumber(tx.nonce) !== req.nonce) {
      return { replaced: false, reason: `transaction ${hash} is not the keeper's at nonce ${req.nonce}: nothing to replace` };
    }
    pooled = { hash, tx };
    break;
  }
  const gone = `none of transaction${pending.length === 1 ? "" : "s"} ${pending.join(", ")} is in the node's pool any more`;
  // gone from every pool: a replacement waits for the wallet's nonce, but a cancel (a claim's, or any stuck send's on a
  // capped chain) takes that nonce while it is still free, so nothing can wait on it for good (T51 round-2 re-review r2-a):
  // one transaction a nonce, so the cancel and the original can never both land
  if (!pooled && !o.cancel) return { replaced: false, reason: `${gone} (dropped, or on another node): the wallet's nonce decides` };
  const mined = hexToNumber((await ctx.rpc.request(chain, "eth_getTransactionCount", [from, "latest"])) as Hex);
  if (mined !== req.nonce) return { replaced: false, reason: `${chainLabel(chain)}: the wallet's mined nonce is ${mined}, so nonce ${req.nonce} is no longer pending` };
  if (!pooled) ctx.log(`${chainLabel(chain)}: ${gone} and nonce ${req.nonce} is still the wallet's next: it is cancelled there, so nothing can wait on it`);
  const replacing = pooled?.hash ?? pending[pending.length - 1];
  const old: PoolTx = pooled?.tx ?? { from, nonce: numberToHex(req.nonce), blockNumber: null };
  const market = await gasPriceOf(ctx.rpc, chain);
  const c = ctx.chains[chain];
  const max = (a: bigint, b: bigint) => (a > b ? a : b);
  const nodeTip = c.legacy ? 0n : await priorityFeeOf(ctx.rpc, chain);
  // with no pooled transaction to go over, 12.5% over the node's own price and tip
  const tip = c.legacy ? 0n : max(bumped(hexToBigInt(old.maxPriorityFeePerGas ?? "0x0")), pooled ? nodeTip : bumped(nodeTip));
  const feeCap = max(max(bumped(hexToBigInt((c.legacy ? old.gasPrice : (old.maxFeePerGas ?? old.gasPrice)) ?? "0x0")), pooled ? market : bumped(market)), tip);
  const baseFee = market > nodeTip ? market - nodeTip : market;
  const effective = c.legacy ? feeCap : feeCap < baseFee + tip ? feeCap : baseFee + tip;
  const over = overCap(ctx, chain, effective);
  if (over) return { replaced: false, reason: `${over}; the replacement waits for it to fall` };
  const data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args } as never);
  const call = { from, to: req.to, data, value: numberToHex(req.value ?? 0n) };
  let cancelled = false;
  let tx: TransactionSerializable;
  const fees = c.legacy ? { type: "legacy" as const, gasPrice: feeCap } : { type: "eip1559" as const, maxFeePerGas: feeCap, maxPriorityFeePerGas: tip };
  const cancelTx = () => ({ ...fees, chainId: c.chainId, nonce: req.nonce, to: from, gas: CANCEL_GAS, data: "0x", value: 0n }) as TransactionSerializable;
  if (o.cancel) {
    cancelled = true;
    tx = cancelTx();
  } else {
    try {
      const estimate = hexToBigInt((await ctx.rpc.request(chain, "eth_estimateGas", [call])) as Hex);
      tx = { ...fees, chainId: c.chainId, nonce: req.nonce, to: req.to, gas: gasLimitOf(req, estimate), data, value: req.value ?? 0n } as TransactionSerializable;
    } catch (e) {
      if (e instanceof SendRefused) throw e;
      if (!isRevert(e)) return { replaced: false, reason: `${chainLabel(chain)}: the node didn't answer the estimate of ${req.label} (${(e as Error).message.split("\n")[0]}); nothing cancelled` };
      ctx.log(`${chainLabel(chain)}: ${req.label} would fail now (${describeRevert(e, ctx.errors)}): nonce ${req.nonce} is cancelled instead`);
      cancelled = true;
      tx = cancelTx();
    }
  }
  const label = cancelled ? `cancel nonce ${req.nonce} (${req.label})` : `${req.label} (replacing ${replacing})`;
  ctx.log(`${chainLabel(chain)}: ${label} — nonce ${req.nonce}, ${c.legacy ? `gas price ${gwei(feeCap)}` : `fee cap ${gwei(feeCap)}, tip ${gwei(tip)}`} (12.5% over the pending transaction's, never under the node's)`);
  const { raw, hash } = await signed(signer, tx);
  await ctx.journal.replaced(pending[0], { hash, raw });
  try {
    await ctx.rpc.request(chain, "eth_sendRawTransaction", [raw]);
  } catch (e) {
    throw new Error(`${chainLabel(chain)}: ${label} was not sent: ${(e as Error).message.split("\n")[0]}`);
  }
  const got = await waitReceipt(ctx, req, [hash]);
  if (cancelled) {
    const gasUsed = hexToBigInt(got.r.gasUsed);
    const receipt = { hash, block: hexToNumber(got.r.blockNumber), gasUsed, costWei: gasUsed * hexToBigInt(got.r.effectiveGasPrice) };
    await ctx.journal.update(hash, { status: got.r.status === "0x1" ? "cancelled" : "reverted", receipt });
    return { replaced: true, cancelled, hash, block: receipt.block, gasUsed, costWei: receipt.costWei, logs: got.r.logs ?? [] };
  }
  return { replaced: true, cancelled, ...(await settle(ctx, req, call, label, got.hash, got.r, tx.gas)) };
}
