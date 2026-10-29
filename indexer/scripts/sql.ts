// The SQL the owner's scripts run (spec 8 and 7: clearing a hold, acknowledging an alert, approving a delivery
// check). Only these scripts, run with Cloudflare account access, clear or approve: the Worker never does
// (test/node/no-auto-clear.test.ts). Every value spliced in is checked against these patterns first, so the
// statements need no escaping. No imports: the Worker's tests apply these statements to the test D1.

/** A note: letters, digits, spaces and . , : ; ( ) _ - only (no quote, no backtick). */
export const NOTE_RE = /^[A-Za-z0-9 .,:;()_-]{1,200}$/;
/** A hold id (e.g. `bridge.batch:42:0x…`) or a public id (`h_3f9a0c1e`). */
export const HOLD_ID_RE = /^[a-z0-9_.:-]{1,120}$/;
/** A delivered batch key. */
export const KEY_RE = /^0x[0-9a-f]{64}$/;
export const ALERT_ID_RE = /^[0-9]{1,12}$/;
export const ENVS = ["test", "production"] as const;
export type Env = (typeof ENVS)[number];

export const ACK_USAGE = "usage: pnpm alerts:ack -- --env <test|production> <alert id> [--dry-run]";

export const ACTIVE_HOLDS_SQL = "SELECT id, public_id, rule, summary, raised_at FROM holds WHERE cleared_at IS NULL";

/** Clears one active hold, by id or public id, or every active hold. */
export const clearHoldSql = (target: { id: string } | { all: true }, note: string, nowS: number): string =>
  `UPDATE holds SET cleared_at = ${nowS}, cleared_note = '${note}' WHERE ${"id" in target ? `(id = '${target.id}' OR public_id = '${target.id}') AND ` : ""}cleared_at IS NULL`;

export const ackSql = (id: string, nowS: number): string => `UPDATE alerts SET acknowledged_at = ${nowS} WHERE id = ${id} AND acknowledged_at IS NULL`;

/** The delivery checks of a key, with what the owner must compare before approving. */
export const checksOfKeySql = (key: string): string =>
  `SELECT batch_id, delivered_key, expected_key, status, detail, delivered_tx, closed_tx, message_id FROM batch_checks WHERE delivered_key = '${key}'`;

/** Marks a key's delivery checks approved by the owner: the keeper may then pay the batch, and the next tick
 * emails checks.owner_approved. */
export const approveSql = (key: string, note: string, nowS: number): string =>
  `UPDATE batch_checks SET status = 'ok_by_owner', approved_note = '${note}', approved_at = ${nowS} WHERE delivered_key = '${key}'`;
