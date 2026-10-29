import type { Hex } from "viem";
import type { ChainName, Deployment } from "./config.ts";
import type { StoredLog } from "./logs.ts";
import type { MessageRow } from "./store.ts";

// The bridge messages our contracts send (spec 6.1 ccip.failure, 6.3 ccip.undelivered): one row per adapter
// Sent from the front door or the vault, until the destination adapter's Delivered arrives. The OffRamp's
// execution state is read for the pending ones each tick (snapshot.ts), but a Delivered is what counts as
// arrived: an upgraded OffRamp can leave the old one's state at UNTOUCHED.

const same = (a: unknown, b: Hex) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const lower = (x: unknown) => String(x).toLowerCase() as Hex;

/** The messages in these logs: each adapter Sent whose sender is the front door (Base → Bittensor) or the
 * vault (Bittensor → Base). Its source time is its block's, or the tick's while that isn't known yet. */
export function messagesFrom(logs: readonly StoredLog[], d: Pick<Deployment, "frontDoor" | "vault">, blockTime: (chain: ChainName, block: bigint) => number | undefined, nowS: number): MessageRow[] {
  return logs.flatMap((l) => {
    if (l.event !== "Sent" || (l.contract !== "baseAdapter" && l.contract !== "bitAdapter")) return [];
    const fromFrontDoor = l.chain === "base" && same(l.args.sender, d.frontDoor);
    const fromVault = l.chain === "bittensor" && same(l.args.sender, d.vault);
    if (!fromFrontDoor && !fromVault) return [];
    return [
      {
        messageId: lower(l.args.messageId),
        direction: fromFrontDoor ? "base>bittensor" : "bittensor>base",
        sender: lower(l.args.sender),
        recipient: lower(l.args.recipient),
        amount: String(l.args.amount),
        srcTx: l.txHash,
        srcBlock: l.block,
        srcTime: blockTime(l.chain, l.block) ?? nowS,
        state: "UNTOUCHED",
        stateAt: null,
        dstTx: null,
        dstBlock: null,
      },
    ];
  });
}

/** Each adapter Delivered in these logs: the message it ends. */
export function arrivals(logs: readonly StoredLog[]): { messageId: Hex; dstTx: Hex; dstBlock: bigint }[] {
  return logs
    .filter((l) => l.event === "Delivered" && (l.contract === "baseAdapter" || l.contract === "bitAdapter"))
    .map((l) => ({ messageId: lower(l.args.messageId), dstTx: l.txHash, dstBlock: l.block }));
}

/** New messages; one already stored is left as it is. */
export function messageStatements(db: D1Database, rows: readonly MessageRow[]): D1PreparedStatement[] {
  const stmt = db.prepare(
    `INSERT INTO messages (message_id, direction, sender, recipient, amount, src_tx, src_block, src_time)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT (message_id) DO NOTHING`,
  );
  return rows.map((m) => stmt.bind(m.messageId, m.direction, m.sender, m.recipient, m.amount, m.srcTx, Number(m.srcBlock), m.srcTime));
}

/** Messages that arrived (the first Delivered wins). */
export function arrivalStatements(db: D1Database, rows: readonly { messageId: Hex; dstTx: Hex; dstBlock: bigint }[]): D1PreparedStatement[] {
  const stmt = db.prepare("UPDATE messages SET dst_tx = ?2, dst_block = ?3 WHERE message_id = ?1 AND dst_tx IS NULL");
  return rows.map((a) => stmt.bind(a.messageId, a.dstTx, Number(a.dstBlock)));
}

/** The OffRamp's execution states read this tick, for the messages still pending. */
export function stateStatements(db: D1Database, states: Readonly<Record<Hex, string>>, nowS: number): D1PreparedStatement[] {
  const stmt = db.prepare("UPDATE messages SET state = ?2, state_at = ?3 WHERE message_id = ?1 AND (state <> ?2 OR state_at IS NULL)");
  return Object.entries(states).map(([id, s]) => stmt.bind(id.toLowerCase(), s, nowS));
}
