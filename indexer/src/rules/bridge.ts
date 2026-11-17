import { formatUnits, type Hex } from "viem";
import type { Finding } from "../alerts.ts";
import { checkBatch, STEPS } from "../crosscheck/batches.ts";
import { groupDelivered } from "../crosscheck/pairing.ts";
import { checkPayout, PAYOUT_STEPS } from "../crosscheck/payouts.ts";
import { checkRefund } from "../crosscheck/refunds.ts";
import type { StoredLog } from "../logs.ts";
import { BITTENSOR_BLOCK_S, PARK_EVENTS, PARK_TIMEOUT_S, type Park, parksOf, REFUND_CHUNK, reasonOf } from "../parks.ts";
import type { BatchCheckRow, BatchCheckWrite, ChunkCheckWrite } from "../store.ts";
import { afterSettled, isNew, type RuleCtx, txLink, unjudged, utc } from "./context.ts";
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
  raises: ["bridge.batch_mismatch", "bridge.duplicate", "ccip.unexpected_source", "bridge.check_stuck"],
  run(ctx) {
    const d = ctx.cfg.deployment;
    const isV32 = d.version === "v3.2";
    const found = new Map<string, Finding>();
    const add = (f: Finding) => {
      if (!found.has(f.key)) found.set(f.key, f);
    };

    // ccip.unexpected_source: an adapter Delivered into the vault from anyone but our front door, reported
    // on the tick its log is first stored. On v3.2 a Delivered is logged after a park too (R3 B-I3): one whose own
    // transaction parked that message is a refusal, not an acceptance (a stranger's park, R3 A-L2: bridge.parked_stranger)
    for (const l of ctx.logs.range("bittensor", "bitAdapter", "Delivered")) {
      if (!isNew(ctx, l) || !same(l.args.recipient, d.vault) || same(l.args.sender, d.frontDoor)) continue;
      if (isV32 && parkedIn(ctx, l)) continue;
      add(unexpected("bittensor", l.txHash, l.args.sender, "the adapter delivered it from another sender"));
    }
    const parks = isV32 ? parksIn(ctx) : undefined;

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
      const group = groupDelivered(ctx.logs.inTx("bittensor", l.txHash), { opener: "vault:BatchDelivered", adapter: "bitAdapter", recipient: d.vault, parked: isV32 }).find((g) => g.opener.uid === l.uid);
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

      const v = checkBatch({ d, delivery: l, group, frontDoorLogs, baseTx: (hash) => ctx.logs.inTx("base", hash), parks });
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
        // v3.2: a cancel re-mints at min(visible, booked): the runbook says to restore missing stake first if it can wait
        if (isV32) facts.contracts = "v3.2";
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
  raises: ["bridge.payout_mismatch", "bridge.duplicate", "ccip.unexpected_source", "bridge.payout_unchecked"],
  run(ctx) {
    const d = ctx.cfg.deployment;
    const isV32 = d.version === "v3.2";
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

    // bridge.payout_unchecked (critical, where the batch side's bridge.check_stuck is a warning: on Base a
    // landing's TAO is claimable at once): a landing still waiting or awaiting its read checkStuckS after
    // it landed (or, without its block time, after it was first seen)
    const stuck = (r: { batchKey: Hex; chunk: number; landedUid: Hex; landedTx: Hex }, status: string, since: number | undefined) => {
      if (since === undefined || ctx.nowS - since < ctx.t.checkStuckS) return;
      add({
        rule: "bridge.payout_unchecked",
        key: `bridge.payout_unchecked:${r.batchKey}:${r.chunk}:${r.landedUid}`,
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
      // v3.2: a park's refund lands as chunk REFUND_CHUNK with no PayoutChunkSent (T27 c4): checked against its park
      const v =
        isV32 && chunk === REFUND_CHUNK
          ? checkRefund({
              d,
              bridges: ctx.cfg.bridges.base,
              bitBridges: ctx.cfg.bridges.bittensor,
              landing: l,
              group,
              parks: parksIn(ctx),
              bitTx: (hash) => ctx.logs.inTx("bittensor", hash),
              baseTx: (hash) => ctx.logs.inTx("base", hash),
              baseSent: ctx.logs.range("base", "baseAdapter", "Sent"),
              frontDoorLogs: ctx.logs.range("base", "frontDoor", BATCH_EVENTS),
            })
          : checkPayout({ d, bridges: ctx.cfg.bridges.base, landing: l, group, vaultLogs, bitTx: (hash) => ctx.logs.inTx("bittensor", hash) });
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

// ---- v3.2: the parks (spec §3.2; §7's monitor lines) ----

const tao = (wei: bigint) => `${formatUnits(wei, 18)} TAO`;
const ccipLink = (id: unknown) => `https://ccip.chain.link/msg/${String(id)}`;
const num = (s: string | undefined) => (s === undefined || s === "" || !Number.isFinite(Number(s)) ? undefined : Number(s));
const v32 = (ctx: RuleCtx) => ctx.cfg.deployment.version === "v3.2";
const afterBaseline = (ctx: RuleCtx, l: StoredLog) => l.block > ctx.cfg.deployment[l.chain].baselineBlock;

/** The parks the loaded logs show (src/parks.ts): the prefetch loads every event of each park still open, of this
 * tick's park events, of the deliveries checked and of the refund landings, and this tick's own are in the logs. */
export const parksIn = (ctx: RuleCtx): Park[] => parksOf(ctx.logs.range("bittensor", "bitAdapter", PARK_EVENTS), ctx.cfg.deployment);

/** Whether a Bittensor adapter's Delivered is a park's: its own transaction parked that message (ccipReceive logs
 * Delivered after _deliver, which parked it). */
export const parkedIn = (ctx: RuleCtx, delivered: StoredLog): boolean =>
  ctx.logs.inTx("bittensor", delivered.txHash).some((x) => x.contract === "bitAdapter" && x.event === "BatchParked" && same(x.args.messageId, lower(delivered.args.messageId)));

/** When a park began: its BatchParked's block time, else told by its block back from the settled history's, at Bittensor's
 * block time as the readings measure it (its nominal 12 s while that is unread). */
const parkedAt = (ctx: RuleCtx, p: Park): number =>
  ctx.blockTime("bittensor", p.parked.block) ?? ctx.settled.bittensor.time - Number(ctx.settled.bittensor.block - p.parked.block) * (ctx.blockS.bittensor ?? BITTENSOR_BLOCK_S);

const heldAs = (p: Park): string =>
  !p.converted
    ? "tokens (wTAO: the conversion failed)"
    : String(p.parked.args.converted) === "true"
      ? `native TAO (${p.door ? "the vault" : "its recipient"} refused it)`
      : "native TAO (converted; its recipient refused it since)";

const duration = (s: number) => (s < 7200 ? `${Math.floor(s / 60)} minutes` : s < 2 * 86_400 ? `${Math.floor(s / 3600)} hours` : `${Math.floor(s / 86_400)} days`);

/** A park's facts: where, what, why, since when, when it can be refunded (or dropped), its message and transaction. */
function parkFacts(ctx: RuleCtx, p: Park): Record<string, string> {
  const at = parkedAt(ctx, p);
  return {
    adapter: p.adapter,
    key: p.key,
    amount: tao(p.amount),
    "held as": heldAs(p),
    why: reasonOf(p.reason),
    sender: p.sender,
    recipient: p.recipient,
    "parked at": utc(at),
    [p.amount > 0n ? "refundable from" : "droppable from"]: utc(at + PARK_TIMEOUT_S),
    ccip: ccipLink(p.messageId),
    transaction: txLink("bittensor", p.parked.txHash),
  };
}

/** bridge.parked (critical condition, v3.2) and bridge.parked_stranger (warning event). A front-door batch to the vault
 * parked (the vault refused it: stake missing, paused, an unknown door; or the conversion failed) for parkedCriticalS
 * (spec §7: "critical after one hour"), timed by the settled history, so a park the scan hasn't seen end yet isn't
 * counted against the hour: one alert per park while it lasts (its key, its BatchParked), resolved once it is
 * delivered, refunded or dropped. A stranger's park (another sender, or another recipient: R3 A-L2, anyone can send
 * through the Base adapter) owes nothing of Cascade's: the warning, once, on the tick it is stored. And a park the logs
 * missed: an adapter whose totals (parkedNative + parkedTokens) owe more than the open parks seen, for parkedCriticalS
 * (since: meta parks_unseen_since:{adapter}), is critical too; unjudged while its totals are unread. */
export const bridgeParked: Rule = {
  name: "bridge.parked",
  raises: ["bridge.parked_stranger"],
  run(ctx) {
    if (!v32(ctx)) return [];
    const out: Finding[] = [];
    const parks = parksIn(ctx);
    const settled = ctx.settled.bittensor.time;
    for (const p of parks) {
      if (p.ended) continue;
      if (!p.door) {
        if (isNew(ctx, p.parked) && afterBaseline(ctx, p.parked)) {
          out.push({ rule: "bridge.parked_stranger", key: `bridge.parked_stranger:${p.parked.uid}`, subject: "Someone else's batch parked in the Bittensor adapter", facts: parkFacts(ctx, p) });
        }
        continue;
      }
      const age = settled - parkedAt(ctx, p);
      if (age < ctx.t.parkedCriticalS) continue;
      out.push({
        rule: "bridge.parked",
        key: `bridge.parked:${p.adapter}:${p.key}:${p.parked.uid}`,
        subject: `A front-door batch of ${tao(p.amount)} has been parked in the Bittensor adapter for ${duration(age)}`,
        facts: parkFacts(ctx, p),
      });
    }
    for (const a of ctx.cfg.bridges.bittensor.map(lower)) {
      const key = `bridge.parked:${a}:unseen`;
      const s = ctx.snap.bittensor?.state.adapters?.[a];
      if (s?.parkedNative === undefined || s.parkedTokens === undefined) {
        unjudged(ctx, "bridge.parked", key);
        continue;
      }
      const seen = parks.filter((p) => !p.ended && p.adapter === a).reduce((x, p) => x + p.amount, 0n);
      const owes = s.parkedNative + s.parkedTokens;
      const k = `parks_unseen_since:${a}`;
      const since = num(ctx.meta[k]);
      if (owes <= seen) {
        if (since !== undefined) ctx.writes.meta.push({ k, v: "" });
        continue;
      }
      if (since === undefined) {
        ctx.writes.meta.push({ k, v: String(ctx.nowS) });
        continue;
      }
      if (ctx.nowS - since < ctx.t.parkedCriticalS) continue;
      out.push({
        rule: "bridge.parked",
        key,
        subject: `The Bittensor adapter owes ${tao(owes - seen)} more to its parks than the parks the monitor has seen`,
        facts: { adapter: a, unseen: tao(owes - seen), "it owes": `${tao(s.parkedNative)} as native TAO, ${tao(s.parkedTokens)} as tokens`, "the parks seen": tao(seen), since: utc(since) },
      });
    }
    return out;
  },
};

/** bridge.parked_tokens_during_migration (critical condition, v3.2): ForeverMoney's migration notice runs
 * (migrationReadyAt != 0) while an adapter holds a token park (parkedTokens > 0, read beside it): a token park left
 * when the migration executes is a claim ForeverMoney won't honour (spec §3.2, M-7), so the moment the notice starts
 * every token park must be converted (deliverParked). At once, one alert per adapter. Unjudged while either is unread
 * (unless one of them alone says it can't hold). */
export const parkedTokensDuringMigration: Rule = {
  name: "bridge.parked_tokens_during_migration",
  run(ctx) {
    if (!v32(ctx)) return [];
    const r = ctx.snap.bittensor;
    const ready = r?.state.alpha.migrationReadyAt;
    const parks = parksIn(ctx);
    return ctx.cfg.bridges.bittensor.map(lower).flatMap((a): Finding[] => {
      const key = `bridge.parked_tokens_during_migration:${a}`;
      const tokens = r?.state.adapters?.[a]?.parkedTokens;
      if (tokens === 0n || ready === 0n) return [];
      if (!r || tokens === undefined || ready === undefined) return unjudged(ctx, "bridge.parked_tokens_during_migration", key);
      const list = parks.filter((p) => !p.ended && p.adapter === a && !p.converted && p.amount > 0n);
      return [
        {
          rule: "bridge.parked_tokens_during_migration",
          key,
          subject: `${tao(tokens)} is parked as tokens while ForeverMoney's migration notice runs`,
          facts: {
            adapter: a,
            "migration ready at": utc(Number(ready)),
            "migration target": r.state.alpha.migrationTarget ?? "not read",
            "parked as tokens": tao(tokens),
            "token parks": list.length ? list.map((p) => `${p.key}: ${tao(p.amount)}`).join("; ") : "none seen in the logs",
          },
        },
      ];
    });
  },
};

/** bridge.cushion_low warns below each target divided by this (half of it), not at the target (the controller's ruling on
 * Task 56's review, Minor 1): anyone's sweepSurplus leaves exactly the reserve's target (CcipBittensorAdapter.sol's
 * sweep), the booked cushion falls by a rao for each shortfall it covers, and 0.001 TAO covers about a million 1-rao
 * shortfalls, so either a few rao under its target is expected, and a warning there would stand for good. */
export const CUSHION_LOW_DIVISOR = 2n;

/** bridge.cushion_low (warning condition, v3.2): an adapter's native reserve (its TAO above parkedNative) or token
 * cushion below half its target (RESERVE_TARGET, TOKEN_RESERVE_TARGET: 0.001 TAO each; CUSHION_LOW_DIVISOR). The reserve
 * covers a delivery's conversion at most 1 rao short and logs nothing when it does (T28 c2, R3 B-I2), so its balance is
 * what is watched; the cushion covers a send's or a converted refund's (ShortfallCovered), and since R4 (F-1) it is the
 * adapter's booked tokenCushion(), what fundCushion brought in (CushionFunded), never its wTAO above the parks: a plain
 * transfer is surplus, which anyone's sweep sends to the treasury, and its amount is shown as a fact. An empty booked
 * cushion on a live deployment is the deploy's funding step left out: said so in the subject. Empty, a short delivery
 * parks as tokens and a short send reverts, until topped up. Unjudged while a field it judges by is unread (the wTAO
 * balance, a fact only, may be). */
export const bridgeCushionLow: Rule = {
  name: "bridge.cushion_low",
  run(ctx) {
    if (!v32(ctx)) return [];
    return ctx.cfg.bridges.bittensor.map(lower).flatMap((a): Finding[] => {
      const key = `bridge.cushion_low:${a}`;
      const s = ctx.snap.bittensor?.state.adapters?.[a];
      if (
        s?.balance === undefined ||
        s.parkedNative === undefined ||
        s.reserveTarget === undefined ||
        s.tokenCushion === undefined ||
        s.parkedTokens === undefined ||
        s.tokenReserveTarget === undefined
      ) {
        return unjudged(ctx, "bridge.cushion_low", key);
      }
      const native = s.balance > s.parkedNative ? s.balance - s.parkedNative : 0n;
      const booked = s.tokenCushion;
      const nativeShort = native < s.reserveTarget / CUSHION_LOW_DIVISOR;
      const cushionShort = booked < s.tokenReserveTarget / CUSHION_LOW_DIVISOR;
      const short = [nativeShort ? "native reserve" : "", cushionShort ? "token cushion" : ""].filter(Boolean);
      if (!short.length) return [];
      const empty = "its token cushion is empty: nothing is booked by fundCushion";
      const subject =
        booked === 0n
          ? nativeShort
            ? `The Bittensor adapter's native reserve is below half its target, and ${empty}`
            : `The Bittensor adapter's token cushion is empty: nothing is booked by fundCushion`
          : short.length === 2
            ? "The Bittensor adapter's native reserve and token cushion are below half their targets"
            : `The Bittensor adapter's ${short[0]} is below half its target`;
      const owed = s.parkedTokens + booked;
      return [
        {
          rule: "bridge.cushion_low",
          key,
          subject,
          facts: {
            adapter: a,
            short: short.join(" and "),
            "native reserve": `${tao(native)} of ${tao(s.reserveTarget)} (above ${tao(s.parkedNative)} owed to parks)`,
            "token cushion": `${tao(booked)} booked of ${tao(s.tokenReserveTarget)} (fundCushion; beside ${tao(s.parkedTokens)} owed to parks)`,
            "unbooked surplus (the sweep's)": s.tokens === undefined ? "not read" : tao(s.tokens > owed ? s.tokens - owed : 0n),
          },
        },
      ];
    });
  },
};

/** bridge.refunded and bridge.dropped (warning events, v3.2): each ParkedRefunded (a park refunded to its door on
 * Base after PARK_TIMEOUT: each depositor credited there, its redeem requests gone) and each ParkedDropped (an empty
 * park deleted), on the tick it is stored, after the baseline, naming the park it ended. The refund's landing on Base
 * is checked by bridge.payout_mismatch (src/crosscheck/refunds.ts). */
export const bridgeRefundsAndDrops: Rule = {
  name: "bridge.refunded",
  raises: ["bridge.dropped"],
  run(ctx) {
    if (!v32(ctx)) return [];
    const parks = parksIn(ctx);
    return ctx.logs
      .range("bittensor", "bitAdapter", ["ParkedRefunded", "ParkedDropped"])
      .filter((l) => isNew(ctx, l) && afterBaseline(ctx, l))
      .map((l): Finding => {
        const p = parks.find((x) => x.ended?.uid === l.uid);
        const common: Record<string, string> = {
          key: lower(l.args.key),
          adapter: lower(l.address),
          door: p ? (p.door ? "yes" : "no") : "not known",
          ...(p ? { sender: p.sender, recipient: p.recipient, "parked at": utc(parkedAt(ctx, p)) } : {}),
          "called by": ctx.txs.get(`${l.chain}:${l.txHash}`)?.from ?? "not known yet",
          transaction: txLink("bittensor", l.txHash),
        };
        if (l.event === "ParkedDropped") {
          return { rule: "bridge.dropped", key: `bridge.dropped:${l.uid}`, subject: "An empty parked batch was dropped", facts: common };
        }
        const subject = !p
          ? "A parked batch was refunded to Base"
          : p.door
            ? `A parked batch of ${tao(p.amount)} was refunded to its depositors on Base`
            : `A stranger's parked batch of ${tao(p.amount)} was refunded to its sender on Base`;
        return {
          rule: "bridge.refunded",
          key: `bridge.refunded:${l.uid}`,
          subject,
          facts: {
            ...common,
            amount: p ? tao(p.amount) : "not known (its BatchParked isn't loaded)",
            "held as": p ? heldAs(p) : "not known",
            "refund message": ccipLink(lower(l.args.messageId)),
          },
        };
      });
  },
};

/** bridge.retire_blocked (warning condition, v3.2): a Bittensor bridge in BRIDGES that is no longer the vault's primary
 * bridge (a pair being retired) still owes parks (parkedNative or parkedTokens above 0). Never retire a pair until both
 * read 0 (spec §3.2; verify enforces it). Unjudged while the primary bridge or a total is unread. */
export const bridgeRetireBlocked: Rule = {
  name: "bridge.retire_blocked",
  run(ctx) {
    if (!v32(ctx)) return [];
    const r = ctx.snap.bittensor;
    const primary = r?.state.primaryBridge;
    if (!r || primary === undefined) return unjudged(ctx, "bridge.retire_blocked");
    const parks = parksIn(ctx);
    return ctx.cfg.bridges.bittensor.map(lower).flatMap((a): Finding[] => {
      if (a === lower(primary)) return [];
      const key = `bridge.retire_blocked:${a}`;
      const s = r.state.adapters?.[a];
      if (s?.parkedNative === undefined || s.parkedTokens === undefined) return unjudged(ctx, "bridge.retire_blocked", key);
      if (s.parkedNative === 0n && s.parkedTokens === 0n) return [];
      const list = parks.filter((p) => !p.ended && p.adapter === a);
      return [
        {
          rule: "bridge.retire_blocked",
          key,
          subject: `A retiring Bittensor adapter still holds parks: ${tao(s.parkedNative + s.parkedTokens)}`,
          facts: {
            adapter: a,
            "the vault's primary bridge": lower(primary),
            parked: `${tao(s.parkedNative)} as native TAO, ${tao(s.parkedTokens)} as tokens`,
            parks: list.length ? list.map((p) => `${p.key}: ${tao(p.amount)} (${p.door ? "the front door's" : "a stranger's"})`).join("; ") : "none seen in the logs",
          },
        },
      ];
    });
  },
};

export const BRIDGE_RULES: Rule[] = [bridgeBatches, bridgePayouts, bridgeParked, parkedTokensDuringMigration, bridgeCushionLow, bridgeRefundsAndDrops, bridgeRetireBlocked];
