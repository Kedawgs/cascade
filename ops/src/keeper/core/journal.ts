import { type Address, type Hex, parseTransaction } from "viem";
import type { CallRequest, ChainName } from "./types.ts";

// The send journal (design-keeper-worker.md §4, §5): every send the core's raw path makes, written before its
// broadcast (the write-ahead), then moved on as the send learns its fate. A run cut off anywhere leaves a row the next
// run settles by its hash; the 24 h spend cap (Task 50a) sums it. In the Worker it is the Durable Object's `journal`
// table (Task 50b); on the PC and in tests, memoryJournal.

/** What became of a send: `signed` (written ahead, not yet broadcast), `sent` (the node took it), `landed`
 * (mined, status 1), `reverted` (mined, status 0), `never-sent` (no node knows it and its nonce is still free),
 * `cancelled` (a cancel took its nonce: the call never ran), `dropped` (its nonce passed with no receipt, at two readings a
 * block apart; a receipt found later still settles it as landed, reverted or cancelled). */
export type JournalStatus = "signed" | "sent" | "landed" | "reverted" | "never-sent" | "cancelled" | "dropped";

export interface JournalRow {
  chain: ChainName;
  /** Who signed it, and at which nonce: one row per nonce while it is unsettled */
  from: Address;
  nonce: number;
  /** The first signed transaction's hash, then each replacement's */
  hashes: Hex[];
  /** The call (its label says what it was) and the value it carried */
  request: CallRequest;
  /** The last signed transaction, as broadcast */
  raw: Hex;
  status: JournalStatus;
  /** When it was written ahead (ms, the host's clock) */
  at: number;
  /** The receipt's hash (one of `hashes`), block, gas and fee, once mined */
  receipt?: { hash: Hex; block: number; gasUsed: bigint; costWei: bigint };
  /** The bridge message it sent, once known */
  messageId?: Hex;
  /** What the call sent back to the keeper of the value it carried, once mined (a close's fee float less the bridge fee
   * its closer paid: the door refunds the rest; Task 50a's spend cap counts the value net of it) */
  returned?: bigint;
  /** The block (the chain's head) at which the settling (core/send.ts settlePending) last read the wallet's mined nonce
   * past this row's with no receipt for any of its hashes: the first of the two readings, a block apart and in a row, a
   * drop needs (T50a round-2 R2-1). Absent or 0: not seen so (a reading that sees the nonce not past writes 0). */
  passedAt?: number;
}

export interface Journal {
  /** The row, before its transaction is broadcast: what a cut-off run leaves for the next. */
  writeAhead(row: JournalRow): Promise<void>;
  /** A replacement at the row's nonce: its hash and its signed transaction, before it is broadcast. */
  replaced(hash: Hex, next: { hash: Hex; raw: Hex }): Promise<void>;
  /** The row holding `hash`, moved on (its status, its receipt, its bridge message). */
  update(hash: Hex, patch: Partial<Pick<JournalRow, "status" | "receipt" | "messageId" | "returned" | "passedAt">>): Promise<void>;
  /** The rows not settled yet (signed or sent), oldest first. */
  pending(): Promise<JournalRow[]>;
  /** Every row written at or after `sinceMs`, oldest first (the 24 h spend cap). */
  since(sinceMs: number): Promise<JournalRow[]>;
}

/** A journal in memory (the PC's hand run, tests): every row, oldest first. */
export function memoryJournal(): Journal & { rows: JournalRow[] } {
  const rows: JournalRow[] = [];
  const holding = (hash: Hex) => {
    const r = rows.find((x) => x.hashes.some((h) => h.toLowerCase() === hash.toLowerCase()));
    if (!r) throw new Error(`the journal has no send with transaction ${hash}`);
    return r;
  };
  return {
    rows,
    async writeAhead(row) {
      rows.push({ ...row, hashes: [...row.hashes] });
    },
    async replaced(hash, next) {
      const r = holding(hash);
      r.hashes.push(next.hash);
      r.raw = next.raw;
    },
    async update(hash, patch) {
      Object.assign(holding(hash), patch);
    },
    async pending() {
      return rows.filter((r) => r.status === "signed" || r.status === "sent");
    },
    async since(sinceMs) {
      return rows.filter((r) => r.at >= sinceMs);
    },
  };
}

/** The spend cap's window (Task 50a): the last 24 hours. */
export const SPEND_WINDOW_MS = 24 * 3_600_000;

/** The most a signed transaction can cost in gas: its gas limit at its fee cap (or its gas price). */
function worstGas(row: JournalRow): bigint {
  try {
    const tx = parseTransaction(row.raw);
    const fee = tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
    return (tx.gas ?? 0n) * fee;
  } catch {
    // a row whose signed transaction can't be read back counts its whole value (below) and no gas: never a negative
    return 0n;
  }
}

/** What a send has cost the keeper's wallet, or may still (Task 50a's spend cap: gas plus value): mined and through,
 * its gas and the value it carried less what came back (a close's refund); mined and reverted, or cancelled, its gas
 * alone (a revert or a cancel moves no value); never sent, or dropped (its nonce passed with no receipt: it can no
 * longer land, core/send.ts settlePending), nothing; not settled yet (signed, sent), its worst case: its gas limit at
 * its fee cap, and all its value. */
export function spentOf(row: JournalRow): bigint {
  const value = row.request.value ?? 0n;
  switch (row.status) {
    case "never-sent":
    case "dropped":
      return 0n;
    case "landed": {
      const net = value - (row.returned ?? 0n);
      return (row.receipt?.costWei ?? worstGas(row)) + (net > 0n ? net : 0n);
    }
    case "reverted":
    case "cancelled":
      return row.receipt?.costWei ?? worstGas(row);
    default:
      return worstGas(row) + value;
  }
}

/** Not settled yet (written ahead or broadcast, no receipt): counted whatever its age, until it settles. */
const unsettled = (r: JournalRow) => r.status === "signed" || r.status === "sent";

/** What the keeper has spent on `chain` within the window ending at `nowMs`: the rows written at or after its start,
 * and every row not settled yet, however old (a send still pending 24 h on stays in the sum until it settles: T50a
 * review M4). */
export function spentOn(rows: readonly JournalRow[], chain: ChainName, nowMs: number): bigint {
  const since = nowMs - SPEND_WINDOW_MS;
  return rows.filter((r) => r.chain === chain && (r.at >= since || unsettled(r))).reduce((t, r) => t + spentOf(r), 0n);
}

/** The rows the spend cap sums at `nowMs`: the window's, and every unsettled one (each row once). */
export async function spendRows(journal: Pick<Journal, "since" | "pending">, nowMs: number): Promise<JournalRow[]> {
  const rows = await journal.since(nowMs - SPEND_WINDOW_MS);
  const seen = new Set(rows.map((r) => `${r.chain}:${r.nonce}:${r.hashes[0]}`));
  for (const r of await journal.pending()) if (!seen.has(`${r.chain}:${r.nonce}:${r.hashes[0]}`)) rows.push(r);
  return rows;
}
