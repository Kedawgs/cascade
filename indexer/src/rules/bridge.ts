import type { Hex } from "viem";
import type { Finding } from "../alerts.ts";
import { checkBatch, STEPS } from "../crosscheck/batches.ts";
import { groupDelivered } from "../crosscheck/pairing.ts";
import type { StoredLog } from "../logs.ts";
import type { BatchCheckWrite } from "../store.ts";
import { afterSettled, isFresh, type RuleCtx, txLink, utc } from "./context.ts";
import type { Rule } from "./index.ts";

// Spec 6.2: the bridge cross-check. Each delivery is checked once: on the tick its block settles, and
// again each tick while its row is `waiting` (Base not yet settled past it).

const same = (a: unknown, b: Hex) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const lower = (x: unknown) => String(x).toLowerCase() as Hex;
/** The front door's events that make up a batch. */
const BATCH_EVENTS = ["DepositRequested", "DepositCancelled", "RedeemRequested", "RedeemCancelled", "BatchClosed", "BatchRolled"];

/** A message from an unexpected sender, one alert per transaction. */
const unexpected = (side: "base" | "bittensor", tx: Hex, sender: unknown, why: string): Finding => ({
  rule: "ccip.unexpected_source",
  key: `ccip.unexpected_source:${side}:${tx}`,
  subject: `A Cascade contract on ${side === "base" ? "Base" : "Bittensor"} accepted a message from an unexpected sender`,
  facts: { side, sender: String(sender), why, transaction: txLink(side, tx) },
  hold: { id: `ccip.unexpected_source:${side}:${tx}`, summary: `a message from ${String(sender)} was accepted on ${side}` },
});

/** The cancel deadline of a delivery that queued payouts: its queued time + payoutDelay. */
function deadline(ctx: RuleCtx, delivery: StoredLog, events: readonly StoredLog[]): string | undefined {
  const queued = events.find((e) => e.event === "PayoutBatchQueued" && same(e.args.key, lower(delivery.args.key)));
  const at = queued && ctx.blockTime("bittensor", queued.block);
  return at === undefined ? undefined : utc(at + ctx.payoutDelayS);
}

/** bridge.batch_mismatch, bridge.duplicate (batch side), ccip.unexpected_source (vault side) and
 * bridge.check_stuck. One batch_checks row per delivery from our front door, written as it is decided. */
export const bridgeBatches: Rule = {
  name: "bridge.batches",
  run(ctx) {
    const d = ctx.cfg.deployment;
    const found = new Map<string, Finding>();
    const add = (f: Finding) => {
      if (!found.has(f.key)) found.set(f.key, f);
    };

    // ccip.unexpected_source: a message into the vault from anyone but our front door on Base
    for (const l of ctx.logs.range("bittensor", "bitAdapter", "Delivered")) {
      if (isFresh(ctx, l) && same(l.args.recipient, d.vault) && !same(l.args.sender, d.frontDoor)) add(unexpected("bittensor", l.txHash, l.args.sender, "the adapter delivered it from another sender"));
    }
    const ours = (l: StoredLog) => String(l.args.sourceChain) === "8453" && same(l.args.frontDoor, d.frontDoor);
    const deliveries = ctx.logs.range("bittensor", "vault", "BatchDelivered");
    const checked = new Set(ctx.checks.batches.map((r) => r.deliveredUid));
    const fresh = deliveries.filter((l) => isFresh(ctx, l) && !checked.has(l.uid));
    for (const l of fresh.filter((x) => !ours(x))) add(unexpected("bittensor", l.txHash, l.args.frontDoor, `a batch from chain ${l.args.sourceChain}, front door ${l.args.frontDoor}`));

    // bridge.duplicate: a second delivery of one batch id from our front door, found when it is first seen
    const byBatch = new Map<string, Set<Hex>>();
    for (const r of ctx.checks.batches) {
      const s = byBatch.get(String(r.batchId)) ?? new Set<Hex>();
      byBatch.set(String(r.batchId), s.add(r.deliveredUid));
    }
    const fresh0 = fresh.filter(ours);
    for (const l of fresh0) {
      const id = String(l.args.batchId);
      const before = byBatch.get(id) ?? new Set<Hex>();
      if ([...before].some((u) => u !== l.uid)) {
        const key = lower(l.args.key);
        const group = groupDelivered(ctx.logs.inTx("bittensor", l.txHash), { opener: "vault:BatchDelivered", adapter: "bitAdapter", recipient: d.vault }).find((g) => g.opener.uid === l.uid);
        const facts: Record<string, string> = { side: "bittensor", batch: id, key, delivery: txLink("bittensor", l.txHash), deliveries: String(before.size + 1) };
        const due = deadline(ctx, l, group?.events ?? []);
        if (due) facts.deadline = due;
        add({
          rule: "bridge.duplicate",
          key: `bridge.duplicate:batch:${id}:${key}`,
          subject: `Batch ${id} was delivered again, under different content`,
          facts,
          hold: { id: `bridge.duplicate:batch:${id}:${key}`, summary: `batch ${id} was delivered ${before.size + 1} times` },
        });
      }
      byBatch.set(id, before.add(l.uid));
    }

    // the checks: this tick's new deliveries, and the ones still waiting
    const waiting = ctx.checks.batches
      .filter((r) => r.status === "waiting")
      .flatMap((r) => deliveries.filter((l) => l.uid === r.deliveredUid));
    const frontDoorLogs = ctx.logs.range("base", "frontDoor", BATCH_EVENTS);
    for (const l of [...waiting, ...fresh0]) {
      const isNew = !checked.has(l.uid);
      const id = BigInt(String(l.args.batchId));
      const key = lower(l.args.key);
      const group = groupDelivered(ctx.logs.inTx("bittensor", l.txHash), { opener: "vault:BatchDelivered", adapter: "bitAdapter", recipient: d.vault }).find((g) => g.opener.uid === l.uid);
      const queued = group?.events.find((e) => e.event === "PayoutBatchQueued" && same(e.args.key, key));
      const row: BatchCheckWrite = { batchId: id, deliveredKey: key, deliveredUid: l.uid, deliveredTx: l.txHash, status: "waiting" };
      if (queued) row.queuedBlock = queued.block;
      const at = ctx.blockTime("bittensor", l.block);
      if (at === undefined || !afterSettled(ctx, "base", at)) {
        if (isNew) ctx.writes.batchChecks.push(row);
        if (at !== undefined && ctx.nowS - at >= ctx.t.checkStuckS) {
          add({
            rule: "bridge.check_stuck",
            key: `bridge.check_stuck:${id}:${key}`,
            subject: `Batch ${id}'s delivery check has waited ${Math.floor((ctx.nowS - at) / 60)} minutes`,
            facts: { batch: String(id), key, delivered: utc(at), delivery: txLink("bittensor", l.txHash), "Base settled to": utc(ctx.settled.base.time) },
          });
        }
        continue;
      }
      const v = checkBatch({ d, delivery: l, group, frontDoorLogs, baseTx: (hash) => ctx.logs.inTx("base", hash) });
      const decided: BatchCheckWrite = { ...row, status: v.status };
      if (v.closedTx) decided.closedTx = v.closedTx;
      if (v.messageId) decided.messageId = v.messageId;
      if (v.expectedKey) decided.expectedKey = v.expectedKey;
      if (v.detail) decided.detail = `${v.step}: ${v.detail}`;
      ctx.writes.batchChecks.push(decided);
      if (v.status === "mismatch") {
        const facts: Record<string, string> = { side: "bittensor", step: v.step ?? STEPS.close, detail: v.detail ?? "", batch: String(id), key, delivery: txLink("bittensor", l.txHash) };
        const due = deadline(ctx, l, group?.events ?? []);
        if (due) facts.deadline = due;
        add({
          rule: "bridge.batch_mismatch",
          key: `bridge.batch:${id}:${key}`,
          subject: v.cantRebuild ? `Batch ${id}: can't rebuild this batch from the front door's events` : `Batch ${id}'s delivery failed the cross-check at step ${v.step}`,
          facts,
          hold: { id: `bridge.batch:${id}:${key}`, summary: `batch ${id}'s delivery failed the cross-check (${v.step})` },
        });
      }
    }
    return [...found.values()];
  },
};

export const BRIDGE_RULES: Rule[] = [bridgeBatches];
