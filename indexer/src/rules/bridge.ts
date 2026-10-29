import type { Hex } from "viem";
import type { Finding } from "../alerts.ts";
import { checkBatch, STEPS } from "../crosscheck/batches.ts";
import { groupDelivered } from "../crosscheck/pairing.ts";
import { checkPayout, PAYOUT_STEPS } from "../crosscheck/payouts.ts";
import type { StoredLog } from "../logs.ts";
import type { BatchCheckRow, BatchCheckWrite, ChunkCheckWrite } from "../store.ts";
import { afterSettled, isNew, type RuleCtx, txLink, utc } from "./context.ts";
import type { Rule } from "./index.ts";

// Spec 6.2: the bridge cross-check. Every stored delivery and landing has its check row from the moment
// its log is stored (store.ts upsertLogs), whatever its block. The rules decide the rows still waiting,
// and this tick's new deliveries and landings (their rows come in this tick's commit); a decided row is
// never decided again. A row's alerts are built before the row is pushed, and runRules drops a failed
// rule's writes, so a decided row never goes in without its alert.

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

/** The cancel deadline of a delivery that queued payouts: its queued time + payoutDelay; undefined when
 * either isn't known (the email then says "before the payout delay ends"). */
function deadline(ctx: RuleCtx, delivery: StoredLog, events: readonly StoredLog[]): string | undefined {
  const queued = events.find((e) => e.event === "PayoutBatchQueued" && same(e.args.key, lower(delivery.args.key)));
  const at = queued && ctx.blockTime("bittensor", queued.block);
  if (at === undefined) return undefined;
  const t = at + ctx.payoutDelayS;
  return Number.isFinite(t) ? utc(t) : undefined;
}

/** Adds a set member under a key. */
const note = (m: Map<string, Set<Hex>>, k: string, uid: Hex) => m.set(k, (m.get(k) ?? new Set<Hex>()).add(uid));

/** bridge.batch_mismatch, bridge.duplicate (batch side), ccip.unexpected_source (vault side) and
 * bridge.check_stuck. One batch_checks row per delivery. */
export const bridgeBatches: Rule = {
  name: "bridge.batches",
  run(ctx) {
    const d = ctx.cfg.deployment;
    const found = new Map<string, Finding>();
    const add = (f: Finding) => {
      if (!found.has(f.key)) found.set(f.key, f);
    };

    // ccip.unexpected_source: an adapter Delivered into the vault from anyone but our front door, reported
    // on the tick its log is first stored
    for (const l of ctx.logs.range("bittensor", "bitAdapter", "Delivered")) {
      if (isNew(ctx, l) && same(l.args.recipient, d.vault) && !same(l.args.sender, d.frontDoor)) add(unexpected("bittensor", l.txHash, l.args.sender, "the adapter delivered it from another sender"));
    }

    const ours = (l: StoredLog) => String(l.args.sourceChain) === "8453" && same(l.args.frontDoor, d.frontDoor);
    const rowOurs = (r: BatchCheckRow) => (r.sourceChain === null || r.sourceChain === 8453) && (r.frontDoor === null || same(r.frontDoor, d.frontDoor));
    const rows = new Map(ctx.checks.batches.map((r) => [r.deliveredUid, r]));
    const deliveries = ctx.logs.range("bittensor", "vault", "BatchDelivered");
    // a delivery whose row is still waiting, or a new one without a row yet
    const candidates = deliveries.filter((l) => {
      const r = rows.get(l.uid);
      return r ? r.status === "waiting" : isNew(ctx, l);
    });

    // our deliveries known for each batch id: a second one is bridge.duplicate, found as either is decided
    const known = new Map<string, Set<Hex>>();
    for (const r of ctx.checks.batches) if (rowOurs(r)) note(known, String(r.batchId), r.deliveredUid);
    for (const l of candidates) if (ours(l)) note(known, String(l.args.batchId), l.uid);

    const stuck = (id: bigint, key: Hex, since: number | undefined, tx: Hex) => {
      if (since === undefined || ctx.nowS - since < ctx.t.checkStuckS) return;
      add({
        rule: "bridge.check_stuck",
        key: `bridge.check_stuck:${id}:${key}`,
        subject: `Batch ${id}'s delivery check has waited ${Math.floor((ctx.nowS - since) / 60)} minutes`,
        facts: { batch: String(id), key, since: utc(since), delivery: txLink("bittensor", tx), "Base settled to": utc(ctx.settled.base.time) },
      });
    };

    const frontDoorLogs = ctx.logs.range("base", "frontDoor", BATCH_EVENTS);
    const looked = new Set<Hex>();
    for (const l of candidates) {
      looked.add(l.uid);
      const r = rows.get(l.uid);
      const id = BigInt(String(l.args.batchId));
      const key = lower(l.args.key);
      const group = groupDelivered(ctx.logs.inTx("bittensor", l.txHash), { opener: "vault:BatchDelivered", adapter: "bitAdapter", recipient: d.vault }).find((g) => g.opener.uid === l.uid);
      const queued = group?.events.find((e) => e.event === "PayoutBatchQueued" && same(e.args.key, key));
      const row: BatchCheckWrite = {
        batchId: id,
        deliveredKey: key,
        deliveredUid: l.uid,
        deliveredTx: l.txHash,
        status: "waiting",
        sourceChain: Number(l.args.sourceChain),
        frontDoor: lower(l.args.frontDoor),
        firstSeen: r?.firstSeen ?? ctx.nowS,
      };
      if (queued) row.queuedBlock = queued.block;

      // step 1, the source: decided at once, never ok
      if (!ours(l)) {
        const why = `a batch from chain ${l.args.sourceChain}, front door ${l.args.frontDoor}`;
        add(unexpected("bittensor", l.txHash, l.args.frontDoor, why));
        ctx.writes.batchChecks.push({ ...row, status: "mismatch", detail: `1: the source: ${why}` });
        continue;
      }

      const at = ctx.blockTime("bittensor", l.block);
      if (at === undefined || !afterSettled(ctx, "base", at)) {
        // still waiting: written when new, or to give it a first-seen time
        if (!r || r.firstSeen === null) ctx.writes.batchChecks.push(row);
        stuck(id, key, at ?? row.firstSeen, l.txHash);
        continue;
      }

      const v = checkBatch({ d, delivery: l, group, frontDoorLogs, baseTx: (hash) => ctx.logs.inTx("base", hash) });
      const due = deadline(ctx, l, group?.events ?? []);
      const findings: Finding[] = [];
      const deliveriesOfId = known.get(String(id))?.size ?? 1;
      if (deliveriesOfId > 1) {
        const facts: Record<string, string> = { side: "bittensor", batch: String(id), key, delivery: txLink("bittensor", l.txHash), deliveries: String(deliveriesOfId) };
        if (due) facts.deadline = due;
        findings.push({
          rule: "bridge.duplicate",
          key: `bridge.duplicate:batch:${id}:${deliveriesOfId}`,
          subject: `Batch ${id} was delivered ${deliveriesOfId} times, under different content`,
          facts,
          hold: { id: `bridge.duplicate:batch:${id}:${deliveriesOfId}`, summary: `batch ${id} was delivered ${deliveriesOfId} times` },
        });
      }
      if (v.status === "mismatch") {
        const facts: Record<string, string> = { side: "bittensor", step: v.step ?? STEPS.close, detail: v.detail ?? "", batch: String(id), key, delivery: txLink("bittensor", l.txHash) };
        if (due) facts.deadline = due;
        findings.push({
          rule: "bridge.batch_mismatch",
          key: `bridge.batch:${id}:${key}`,
          subject: v.cantRebuild ? `Batch ${id}: can't rebuild this batch from the front door's events` : `Batch ${id}'s delivery failed the cross-check at step ${v.step}`,
          facts,
          hold: { id: `bridge.batch:${id}:${key}`, summary: `batch ${id}'s delivery failed the cross-check (${v.step})` },
        });
      }
      const decided: BatchCheckWrite = { ...row, status: v.status };
      if (v.closedTx) decided.closedTx = v.closedTx;
      if (v.messageId) decided.messageId = v.messageId;
      if (v.expectedKey) decided.expectedKey = v.expectedKey;
      if (v.detail) decided.detail = `${v.step}: ${v.detail}`;
      for (const f of findings) add(f);
      ctx.writes.batchChecks.push(decided);
    }

    // waiting rows whose delivery isn't loaded: timed from when they were first seen
    for (const r of ctx.checks.batches) {
      if (r.status !== "waiting" || looked.has(r.deliveredUid)) continue;
      if (r.firstSeen === null) {
        ctx.writes.batchChecks.push({ batchId: r.batchId, deliveredKey: r.deliveredKey, deliveredUid: r.deliveredUid, deliveredTx: r.deliveredTx, status: "waiting", firstSeen: ctx.nowS });
      }
      stuck(r.batchId, r.deliveredKey, r.firstSeen ?? ctx.nowS, r.deliveredTx);
    }
    return [...found.values()];
  },
};

/** A failed payout landing: one alert and hold per landing. */
const payoutMismatch = (key: Hex, chunk: number, landedUid: Hex, landedTx: Hex, step: string, detail: string): Finding => ({
  rule: "bridge.payout_mismatch",
  key: `bridge.payout:${key}:${chunk}:${landedUid}`,
  subject: `A payout landing (chunk ${chunk}) failed the cross-check at step ${step}`,
  facts: { side: "base", step, detail, key, chunk: String(chunk), landing: txLink("base", landedTx) },
  hold: { id: `bridge.payout:${key}:${chunk}:${landedUid}`, summary: `a payout landing for chunk ${chunk} of ${key} failed the cross-check (${step})` },
});

/** bridge.payout_mismatch, bridge.duplicate (payout side) and ccip.unexpected_source (Base side). One
 * chunk_checks row per landing (its PayoutsDelivered log), waiting → awaiting_read → ok | mismatch, so a
 * forged duplicate landing is judged on its own row. */
export const bridgePayouts: Rule = {
  name: "bridge.payouts",
  run(ctx) {
    const d = ctx.cfg.deployment;
    const found = new Map<string, Finding>();
    const add = (f: Finding) => {
      if (!found.has(f.key)) found.set(f.key, f);
    };

    // ccip.unexpected_source: a message into the front door from anyone but the vault
    for (const l of ctx.logs.range("base", "baseAdapter", "Delivered")) {
      if (isNew(ctx, l) && same(l.args.recipient, d.frontDoor) && !same(l.args.sender, d.vault)) add(unexpected("base", l.txHash, l.args.sender, "the adapter delivered it from another sender"));
    }

    const rows = new Map(ctx.checks.chunks.map((r) => [r.landedUid, r]));
    const landings = ctx.logs.range("base", "frontDoor", "PayoutsDelivered");
    // a landing whose row is still waiting, or a new one without a row yet
    const candidates = landings.filter((l) => {
      const r = rows.get(l.uid);
      return r ? r.status === "waiting" : isNew(ctx, l);
    });

    // the landings known for each (key, chunk): a second one is bridge.duplicate, found as either is decided
    const known = new Map<string, Set<Hex>>();
    for (const r of ctx.checks.chunks) note(known, `${r.batchKey}:${r.chunk}`, r.landedUid);
    for (const l of candidates) note(known, `${lower(l.args.batchKey)}:${Number(l.args.chunk)}`, l.uid);

    // bridge.check_stuck: a landing still waiting or awaiting its read 60 minutes after it landed (or,
    // without its block time, after it was first seen). On Base a forged payout is claimable at once.
    const stuck = (r: { batchKey: Hex; chunk: number; landedUid: Hex; landedTx: Hex }, status: string, since: number | undefined) => {
      if (since === undefined || ctx.nowS - since < ctx.t.checkStuckS) return;
      add({
        rule: "bridge.check_stuck",
        key: `bridge.check_stuck:payout:${r.batchKey}:${r.chunk}:${r.landedUid}`,
        subject: `A payout landing's check (chunk ${r.chunk}) has been ${status} for ${Math.floor((ctx.nowS - since) / 60)} minutes`,
        facts: { side: "base", key: r.batchKey, chunk: String(r.chunk), status, since: utc(since), landing: txLink("base", r.landedTx), "Bittensor settled to": utc(ctx.settled.bittensor.time) },
      });
    };
    const decidedNow = new Set<Hex>();

    // step 5: the front door's delivered() read, from a reading at or after the landing's block
    for (const r of ctx.checks.chunks) {
      if (r.status !== "awaiting_read") continue;
      const row = { landedUid: r.landedUid, batchKey: r.batchKey, chunk: r.chunk, landedTx: r.landedTx, landedBlock: r.landedBlock };
      const read = ctx.snap.deliveredReads.find((x) => x.landedUid === r.landedUid && x.block >= r.landedBlock);
      if (!read) {
        if (r.firstSeen === null) ctx.writes.chunkChecks.push({ ...row, status: "awaiting_read", firstSeen: ctx.nowS });
        stuck(r, "awaiting its delivered() read", ctx.blockTime("base", r.landedBlock) ?? r.firstSeen ?? ctx.nowS);
        continue;
      }
      decidedNow.add(r.landedUid);
      if (read.value) {
        ctx.writes.chunkChecks.push({ ...row, status: "ok" });
      } else {
        const detail = `delivered(bridge, ${r.expectedHash}) is false at block ${read.block}`;
        add(payoutMismatch(r.batchKey, r.chunk, r.landedUid, r.landedTx, PAYOUT_STEPS.delivered, detail));
        ctx.writes.chunkChecks.push({ ...row, status: "mismatch", detail: `${PAYOUT_STEPS.delivered}: ${detail}` });
      }
    }

    // steps 1–4: the landings still waiting for Bittensor, and this tick's new ones
    const vaultLogs = ctx.logs.range("bittensor", "vault", ["PayoutChunkSent", "DepositBounced", "Redeemed"]);
    const looked = new Set<Hex>();
    for (const l of candidates) {
      looked.add(l.uid);
      const r = rows.get(l.uid);
      const key = lower(l.args.batchKey);
      const chunk = Number(l.args.chunk);
      const row: ChunkCheckWrite = { landedUid: l.uid, batchKey: key, chunk, landedTx: l.txHash, landedBlock: l.block, status: "waiting", firstSeen: r?.firstSeen ?? ctx.nowS };
      const at = ctx.blockTime("base", l.block);
      if (at === undefined || !afterSettled(ctx, "bittensor", at)) {
        // still waiting: written when new, or to give it a first-seen time
        if (!r || r.firstSeen === null) ctx.writes.chunkChecks.push(row);
        stuck(row, "waiting for Bittensor", at ?? row.firstSeen);
        continue;
      }
      const group = groupDelivered(ctx.logs.inTx("base", l.txHash), { opener: "frontDoor:PayoutsDelivered", adapter: "baseAdapter", recipient: d.frontDoor }).find((g) => g.opener.uid === l.uid);
      const v = checkPayout({ d, bridges: ctx.cfg.bridges.base, landing: l, group, vaultLogs, bitTx: (hash) => ctx.logs.inTx("bittensor", hash) });
      const landingsOfChunk = known.get(`${key}:${chunk}`)?.size ?? 1;
      if (landingsOfChunk > 1) {
        add({
          rule: "bridge.duplicate",
          key: `bridge.duplicate:payout:${key}:${chunk}:${landingsOfChunk}`,
          subject: `Payout chunk ${chunk} landed ${landingsOfChunk} times on Base`,
          facts: { side: "base", key, chunk: String(chunk), landing: txLink("base", l.txHash), landings: String(landingsOfChunk) },
          hold: { id: `bridge.duplicate:payout:${key}:${chunk}:${landingsOfChunk}`, summary: `payout chunk ${chunk} of ${key} landed ${landingsOfChunk} times` },
        });
      }
      if (v.status === "mismatch") add(payoutMismatch(key, chunk, l.uid, l.txHash, v.step ?? PAYOUT_STEPS.bridge, v.detail ?? ""));
      const decided: ChunkCheckWrite = { ...row, status: v.status };
      if (v.sentTx) decided.sentTx = v.sentTx;
      if (v.messageId) decided.messageId = v.messageId;
      if (v.expectedHash) decided.expectedHash = v.expectedHash;
      if (v.detail) decided.detail = `${v.step}: ${v.detail}`;
      ctx.writes.chunkChecks.push(decided);
    }

    // waiting rows whose landing log isn't loaded: timed from when they were first seen
    for (const r of ctx.checks.chunks) {
      if (r.status !== "waiting" || looked.has(r.landedUid) || decidedNow.has(r.landedUid)) continue;
      if (r.firstSeen === null) {
        ctx.writes.chunkChecks.push({ landedUid: r.landedUid, batchKey: r.batchKey, chunk: r.chunk, landedTx: r.landedTx, landedBlock: r.landedBlock, status: "waiting", firstSeen: ctx.nowS });
      }
      stuck(r, "waiting for Bittensor", ctx.blockTime("base", r.landedBlock) ?? r.firstSeen ?? ctx.nowS);
    }
    return [...found.values()];
  },
};

export const BRIDGE_RULES: Rule[] = [bridgeBatches, bridgePayouts];
