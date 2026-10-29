import type { Hex } from "viem";
import type { Role } from "../config.ts";
import type { StoredLog } from "../logs.ts";

// Pairing by log order (spec 6.2): one transaction can carry several messages, so a message's events are
// told apart by where they sit in the transaction's logs, never by their content.

const byIndex = (a: StoredLog, b: StoredLog) => a.logIndex - b.logIndex;
const is = (l: StoredLog, x: `${Role}:${string}`) => `${l.contract}:${l.event}` === x;
const same = (a: unknown, b: Hex) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** Each closer (a front door BatchClosed, or a vault PayoutChunkSent) with the adapter Sent it caused:
 * the nearest earlier Sent from `sender` not already paired and after the previous closer. A
 * PayoutChunkSent with net = 0 sent nothing, so it pairs with none (but still bounds the next). Keyed by
 * the closer's uid. */
export function pairSent(
  txLogs: readonly StoredLog[],
  o: { closer: "frontDoor:BatchClosed" | "vault:PayoutChunkSent"; adapter: Role; sender: Hex },
): Map<Hex, StoredLog | undefined> {
  const logs = [...txLogs].sort(byIndex);
  const out = new Map<Hex, StoredLog | undefined>();
  const paired = new Set<Hex>();
  let after = -1;
  logs.forEach((l, i) => {
    if (!is(l, o.closer)) return;
    let found: StoredLog | undefined;
    const sends = !(o.closer === "vault:PayoutChunkSent" && String(l.args.net) === "0");
    for (let j = i - 1; sends && j > after; j--) {
      const s = logs[j];
      if (s.contract === o.adapter && s.event === "Sent" && same(s.args.sender, o.sender) && !paired.has(s.uid)) {
        found = s;
        paired.add(s.uid);
        break;
      }
    }
    out.set(l.uid, found);
    after = i;
  });
  return out;
}

/** A delivery on the receiving side: its opener (a vault BatchDelivered, or a front door
 * PayoutsDelivered), the receiver's events after it, and the adapter Delivered that closed it. */
export interface DeliveryGroup {
  opener: StoredLog;
  events: StoredLog[];
  delivered?: StoredLog;
}

/** The transaction's deliveries: each opener's group holds the receiver's events after it, up to the
 * first adapter Delivered to `recipient`, which closes it. */
export function groupDelivered(
  txLogs: readonly StoredLog[],
  o: { opener: "vault:BatchDelivered" | "frontDoor:PayoutsDelivered"; adapter: Role; recipient: Hex },
): DeliveryGroup[] {
  const receiver = o.opener.split(":")[0] as Role;
  const out: DeliveryGroup[] = [];
  let open: DeliveryGroup | undefined;
  for (const l of [...txLogs].sort(byIndex)) {
    if (is(l, o.opener)) {
      open = { opener: l, events: [] };
      out.push(open);
    } else if (open && l.contract === o.adapter && l.event === "Delivered" && same(l.args.recipient, o.recipient)) {
      open.delivered = l;
      open = undefined;
    } else if (open && l.contract === receiver) {
      open.events.push(l);
    }
  }
  return out;
}
