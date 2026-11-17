import type { Hex } from "viem";
import type { Journal, JournalRow, JournalStatus } from "../../ops/src/keeper/core/journal.ts";
import { fromJson, toJson } from "../../ops/src/keeper/core/memory.ts";
import type { Fenced, JournalPatch } from "./coordinator.ts";
import type { StoredRow } from "./proof.ts";

// The send journal as the Worker's run keeps it (design-keeper-worker.md §4, §5): the write-ahead and each replacement
// go to the Durable Object before their broadcast, fenced by the run's lease (refused: nothing is broadcast); a
// broadcast the node took is written through ("sent"); every later change (the receipt, the bridge message) moves in
// the run's commit, with the memory, so a run cut off after a receipt leaves the row for the next run to settle once.

/** The journal refused a write before a broadcast: the lease is lost, ran out, or the keeper was stopped. Nothing is
 * broadcast. */
export class NotSent extends Error {}

export interface JournalStub {
  writeAhead(req: { holder: string; token: number; row: string }): Promise<Fenced>;
  replaced(req: { holder: string; token: number; hash: string; next: { hash: string; raw: string } }): Promise<Fenced>;
  update(req: { holder: string; token: number; patch: string }): Promise<Fenced>;
  since(req: { sinceMs: number }): Promise<string>;
}

/** The only fields a journal patch changes (the re-review's N2), the object's applyPatches and the control route alike:
 * never a row's request, raws, hashes, sender, nonce or time. */
export const PATCH_FIELDS = ["status", "receipt", "messageId", "returned", "passedAt"] as const;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const MINED: readonly JournalStatus[] = ["landed", "reverted", "cancelled"];

/** A row's status after `next` is said of it (the review's Important 2): a receipt is final, and wins over anything not
 * mined; "never sent" only of a row still just signed (nothing later known of it); "dropped" only of an unsettled one;
 * "sent" over anything not mined (its raw was seen after all). Nothing ever moves a row back to "signed" here: only a
 * write-ahead of the same bytes reopens a row marked never sent. */
export function statusAfter(current: JournalStatus, next: JournalStatus): JournalStatus {
  if (MINED.includes(current)) return current;
  if (MINED.includes(next)) return next;
  if (next === "never-sent") return current === "signed" ? next : current;
  if (next === "dropped") return current === "signed" || current === "sent" ? next : current;
  if (next === "sent") return next;
  return current;
}

export function runJournal(stub: JournalStub, lease: { holder: string; token: number }, pending: StoredRow[], log: (line: string) => void) {
  /** Every row this run knows: the unsettled rows it loaded, and those it wrote */
  const rows: StoredRow[] = pending.map((r) => ({ ...r, hashes: [...r.hashes] }));
  const patches: JournalPatch[] = [];
  const holding = (hash: Hex) => rows.find((r) => r.hashes.some((h) => same(h, hash)));

  const journal: Journal = {
    async writeAhead(row) {
      const r = await stub.writeAhead({ ...lease, row: toJson(row) });
      if (!r.ok) throw new NotSent(`${row.request.label} not sent: ${r.why}`);
      // the same signed bytes as a row this run already holds (one marked never sent, say): that row, reopened
      const known = holding(row.hashes[0]);
      if (known) Object.assign(known, { ...row, hashes: known.hashes });
      else rows.push({ ...row, hashes: [...row.hashes] });
    },
    async replaced(hash, next) {
      const r = await stub.replaced({ ...lease, hash, next });
      if (!r.ok) throw new NotSent(`the replacement of ${hash} not sent: ${r.why}`);
      const row = holding(hash) as StoredRow | undefined;
      if (row) {
        // as the object keeps it: the first transaction, which proves the request, beside the newest
        row.requestRaw ??= row.raw;
        row.hashes.push(next.hash);
        row.raw = next.raw;
      }
    },
    async update(hash, patch) {
      const row = holding(hash);
      if (row) {
        const { status, ...rest } = patch;
        Object.assign(row, rest, status ? { status: statusAfter(row.status, status) } : {});
      }
      const p: JournalPatch = { hash, patch };
      if (patch.status === "sent" || patch.status === "never-sent") {
        // said at once: a broadcast that is out, so a run cut off before its receipt leaves a row the next run watches; a
        // row marked never sent, so the same bytes signed again in this run reopen it in the object
        const r = await stub.update({ ...lease, patch: toJson([p]) }).catch((e: unknown) => ({ ok: false as const, why: (e as Error).message }));
        if (!r.ok) log(`The journal didn't take transaction ${hash} as ${patch.status} (${r.why}); the next run settles it by its hash`);
        return;
      }
      patches.push(p);
    },
    async pending() {
      return rows.filter((r) => r.status === "signed" || r.status === "sent");
    },
    async since(sinceMs) {
      const stored = fromJson<JournalRow[]>(await stub.since({ sinceMs }));
      // this run's own changes, not committed yet, over what is stored
      return stored.map((s) => rows.find((r) => same(r.hashes[0], s.hashes[0])) ?? s);
    },
  };
  return { journal, rows, patches };
}
