import type { Hex } from "viem";
import type { Finding } from "../alerts.ts";
import type { ChainName, Role } from "../config.ts";
import type { MessageRow } from "../store.ts";
import { isNew, type RuleCtx, txLink, utc } from "./context.ts";
import type { Rule } from "./index.ts";

// Spec 6.1 ccip.failure, 6.3 ccip.undelivered and ccip.foreign_send: the bridge messages our contracts send.

const same = (a: unknown, b: Hex) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const ccipLink = (id: Hex) => `https://ccip.chain.link/msg/${id}`;

const destination = (m: MessageRow): { chain: ChainName; adapter: Role } =>
  m.direction === "base>bittensor" ? { chain: "bittensor", adapter: "bitAdapter" } : { chain: "base", adapter: "baseAdapter" };

/** The message has arrived: its destination adapter's Delivered is stored (now or before), whatever the
 * OffRamp says; or the OffRamp says SUCCESS. */
function arrived(ctx: RuleCtx, m: MessageRow): boolean {
  if (m.dstTx !== null) return true;
  const dst = destination(m);
  if (ctx.logs.range(dst.chain, dst.adapter, "Delivered").some((l) => same(l.args.messageId, m.messageId))) return true;
  return stateOf(ctx, m) === "SUCCESS";
}

/** This tick's OffRamp state, else the last one stored. */
const stateOf = (ctx: RuleCtx, m: MessageRow) => ctx.snap.messageStates[m.messageId] ?? m.state;

const facts = (m: MessageRow): Record<string, string> => ({
  direction: m.direction === "base>bittensor" ? "Base → Bittensor" : "Bittensor → Base",
  ccip: ccipLink(m.messageId),
  sender: m.sender,
  recipient: m.recipient,
  amount: `${m.amount} wei`,
  sent: utc(m.srcTime),
  source: txLink(m.direction === "base>bittensor" ? "base" : "bittensor", m.srcTx),
});

/** ccip.failure: the destination OffRamp says FAILURE for a message our front door or vault sent, and the
 * destination adapter has no Delivered for it. */
export const ccipFailure: Rule = {
  name: "ccip.failure",
  run: (ctx) =>
    ctx.messages
      .filter((m) => !arrived(ctx, m) && stateOf(ctx, m) === "FAILURE")
      .map((m) => ({ rule: "ccip.failure", key: `ccip.failure:${m.messageId}`, subject: "A Cascade bridge message failed on its destination", facts: facts(m) })),
};

/** ccip.undelivered: a message not arrived (and not failed) undeliveredS after its source block, by the
 * destination's settled time: judged only on what is stored, so lag alone can't raise it. */
export const ccipUndelivered: Rule = {
  name: "ccip.undelivered",
  run: (ctx) =>
    ctx.messages
      .filter((m) => !arrived(ctx, m) && stateOf(ctx, m) !== "FAILURE" && ctx.settled[destination(m).chain].time - m.srcTime >= ctx.t.undeliveredS)
      .map((m) => ({
        rule: "ccip.undelivered",
        key: `ccip.undelivered:${m.messageId}`,
        subject: `A Cascade bridge message hasn't arrived after ${Math.floor((ctx.settled[destination(m).chain].time - m.srcTime) / 60)} minutes`,
        facts: { ...facts(m), state: stateOf(ctx, m) },
      })),
};

/** ccip.foreign_send: an adapter Sent from anyone but the front door or the vault, to a Cascade contract,
 * on the tick it is first stored. */
export const ccipForeignSend: Rule = {
  name: "ccip.foreign_send",
  run(ctx) {
    const d = ctx.cfg.deployment;
    const ours = [d.frontDoor, d.vault, d.staker];
    const out: Finding[] = [];
    for (const chain of ["base", "bittensor"] as const) {
      for (const l of ctx.logs.range(chain, chain === "base" ? "baseAdapter" : "bitAdapter", "Sent")) {
        if (!isNew(ctx, l) || same(l.args.sender, d.frontDoor) || same(l.args.sender, d.vault)) continue;
        if (!ours.some((a) => same(l.args.recipient, a))) continue;
        out.push({
          rule: "ccip.foreign_send",
          key: `ccip.foreign_send:${l.uid}`,
          subject: "Someone sent a bridge message to a Cascade contract through our adapter",
          facts: { sender: String(l.args.sender), recipient: String(l.args.recipient), ccip: ccipLink(String(l.args.messageId) as Hex), transaction: txLink(chain, l.txHash) },
        });
      }
    }
    return out;
  },
};

export const CCIP_RULES: Rule[] = [ccipFailure, ccipUndelivered, ccipForeignSend];
