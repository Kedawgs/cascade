import { insertHold } from "./store.ts";

// The keeper's hold (spec 8): raised by the findings of rules that can hold, cleared only by the owner's
// `pnpm hold:clear` (scripts/hold-clear.ts), never by the Worker.

/** A hold to raise for each id never raised before (cleared or not: a cleared id is never raised again,
 * which is why rules give each occurrence its own id). Each gets a fresh opaque public id for the status. */
export function holdStatements(
  db: D1Database,
  holds: readonly { id: string; rule: string; summary: string }[],
  existingHoldIds: readonly string[],
  nowS: number,
): D1PreparedStatement[] {
  const seen = new Set(existingHoldIds);
  const out: D1PreparedStatement[] = [];
  for (const h of holds) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    out.push(insertHold(db, { ...h, raisedAt: nowS }));
  }
  return out;
}
