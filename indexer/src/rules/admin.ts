import type { Hex } from "viem";
import { ADMIN_EVENTS } from "../abi.ts";
import type { Finding } from "../alerts.ts";
import type { ChainName } from "../config.ts";
import type { Snapshot } from "../snapshot.ts";
import type { NonceRow } from "../store.ts";
import { addressLink, CONTRACT_NAMES, isFresh, type RuleCtx, txLink } from "./context.ts";
import type { Rule } from "./index.ts";

// Spec 6.1: admin events and the admin keys' transactions.

const CHAINS: readonly ChainName[] = ["base", "bittensor"];
const ZERO = "0x0000000000000000000000000000000000000000";
const lower = (a: Hex) => a.toLowerCase() as Hex;

/** admin.event: an admin event (spec Facts) settled this tick, after the deployment's baseline block. */
export const adminEvent: Rule = {
  name: "admin.event",
  run(ctx) {
    const out: Finding[] = [];
    for (const l of ctx.logs.all()) {
      if (!ADMIN_EVENTS.has(`${l.contract}:${l.event}`) || !isFresh(ctx, l)) continue;
      if (l.block <= ctx.cfg.deployment[l.chain].baselineBlock) continue;
      const name = `${CONTRACT_NAMES[l.contract]} ${l.event}`;
      const sender = ctx.txs.get(`${l.chain}:${l.txHash}`)?.from;
      const args = Object.fromEntries(Object.entries(l.args).map(([k, v]) => [k, String(v)]));
      out.push({
        rule: "admin.event",
        key: `admin.event:${l.uid}`,
        subject: `Admin event: ${name}`,
        facts: { ...args, event: name, sender: sender ?? "not known yet", block: String(l.block), transaction: txLink(l.chain, l.txHash) },
      });
    }
    return out;
  },
};

/** Each chain's role holders now, as the readings name them (the zero address isn't a holder). */
export function watchedRoles(snap: Snapshot): { chain: ChainName; address: Hex; roles: string[] }[] {
  const out: { chain: ChainName; address: Hex; roles: string[] }[] = [];
  const add = (chain: ChainName, a: Hex | undefined, role: string) => {
    if (!a || lower(a) === ZERO) return;
    const w = out.find((x) => x.chain === chain && x.address === lower(a));
    if (w) w.roles.push(role);
    else out.push({ chain, address: lower(a), roles: [role] });
  };
  const b = snap.base?.state;
  if (b) {
    for (const r of ["owner", "pendingOwner", "guardian", "pendingGuardian", "keeper"] as const) add("base", b[r], `frontDoor.${r}`);
    add("base", b.stakerOwner, "staker.owner");
    add("base", b.stakerPendingOwner, "staker.pendingOwner");
  }
  const v = snap.bittensor?.state;
  if (v) for (const r of ["owner", "pendingOwner", "guardian", "pendingGuardian", "keeper"] as const) add("bittensor", v[r], `vault.${r}`);
  return out;
}

const sameRoles = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const keeperOnly = (roles: readonly string[]) => roles.every((r) => r.endsWith(".keeper"));

/** keys.unexplained_tx (critical: an address holding an owner, pending-owner or guardian role) and
 * keys.keeper_unexplained_tx (warning: an address holding only the keeper role): the address's count
 * (an account's transaction count, or a Safe's nonce()) is ahead of the transactions Cascade's logs
 * explain, and has been for unexplainedTxGraceS. The excess is then absorbed, so each one is reported
 * once. A newly watched address starts at its current count. Writes the watched rows that changed. */
export const keys: Rule = {
  name: "keys",
  run(ctx) {
    const out: Finding[] = [];
    const stored = new Map(ctx.nonces.map((r) => [`${r.chain}:${lower(r.address)}`, r]));
    const holders = watchedRoles(ctx.snap);
    for (const chain of CHAINS) {
      // roles from this tick's reading of the chain; without one, the roles last stored
      const now = ctx.snap[chain]
        ? holders.filter((h) => h.chain === chain)
        : ctx.nonces.filter((r) => r.chain === chain && r.roles.length > 0).map((r) => ({ chain, address: lower(r.address), roles: r.roles }));
      const counted = new Set(now.map((h) => h.address));
      // addresses that hold no role any more: stop watching
      for (const r of ctx.nonces) {
        if (r.chain === chain && r.roles.length > 0 && !counted.has(lower(r.address))) ctx.writes.nonces.push({ ...r, roles: [] });
      }
      const counts = Object.fromEntries(Object.entries(ctx.snap.nonces[chain]).map(([a, n]) => [lower(a as Hex), n]));
      const safes = Object.fromEntries(Object.entries(ctx.snap.safeNonces).map(([a, n]) => [lower(a as Hex), n]));
      for (const h of now) {
        const read = safes[h.address] ?? counts[h.address];
        const row = stored.get(`${chain}:${h.address}`);
        if (read === undefined) {
          if (row && !sameRoles(row.roles, h.roles)) ctx.writes.nonces.push({ ...row, roles: h.roles });
          continue;
        }
        const count = Number(read);
        if (!row) {
          ctx.writes.nonces.push({ chain, address: h.address, roles: h.roles, baseline: count, seen: 0, nonce: count, changedAt: ctx.nowS });
          continue;
        }
        const seenNow = ctx.newTxs.filter((t) => t.chain === chain && (lower(t.from) === h.address || (t.to !== undefined && lower(t.to) === h.address))).length;
        const next: NonceRow = { ...row, roles: h.roles, seen: row.seen + seenNow, nonce: count };
        let excess = count - next.baseline - next.seen;
        if (excess < 0) {
          // more seen than counted (a count read before the logs, or a reorg): start again from the count
          next.baseline = count - next.seen;
          excess = 0;
        }
        const before = row.nonce - row.baseline - row.seen;
        if (excess > 0 && before <= 0) next.changedAt = ctx.nowS;
        if (excess > 0 && ctx.nowS - next.changedAt >= ctx.t.unexplainedTxGraceS) {
          const rule = keeperOnly(h.roles) ? "keys.keeper_unexplained_tx" : "keys.unexplained_tx";
          out.push({
            rule,
            key: `${rule}:${chain}:${h.address}:${count}`,
            subject: `${excess} transaction${excess === 1 ? "" : "s"} from a Cascade ${keeperOnly(h.roles) ? "keeper" : "admin"} key that Cascade's logs don't explain`,
            facts: { address: h.address, chain, roles: h.roles.join(", "), count: String(count), unexplained: String(excess), explorer: addressLink(chain, h.address) },
          });
          next.baseline += excess;
        }
        const changed = next.baseline !== row.baseline || next.seen !== row.seen || next.nonce !== row.nonce || next.changedAt !== row.changedAt || !sameRoles(next.roles, row.roles);
        if (changed) ctx.writes.nonces.push(next);
      }
    }
    return out;
  },
};

export const ADMIN_RULES: Rule[] = [adminEvent, keys];
