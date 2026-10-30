import { type Hex, keccak256 } from "viem";
import { ADMIN_EVENTS } from "../abi.ts";
import type { Finding } from "../alerts.ts";
import type { ChainName } from "../config.ts";
import type { Snapshot } from "../snapshot.ts";
import type { NonceRow, TxRow } from "../store.ts";
import { addressLink, CONTRACT_NAMES, isNew, type RuleCtx, txLink } from "./context.ts";
import type { Rule } from "./index.ts";

// Spec 6.1: admin events and the admin keys' transactions.

const CHAINS: readonly ChainName[] = ["base", "bittensor"];
const ZERO = "0x0000000000000000000000000000000000000000";
const lower = (a: Hex) => a.toLowerCase() as Hex;

/** admin.event: an admin event (spec Facts) first stored this tick, after the deployment's baseline block. */
export const adminEvent: Rule = {
  name: "admin.event",
  run(ctx) {
    const out: Finding[] = [];
    for (const l of ctx.logs.all()) {
      if (!ADMIN_EVENTS.has(`${l.contract}:${l.event}`) || !isNew(ctx, l)) continue;
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

/** Every role wallet whose code keys.delegated watches: the role holders, and the staker's and the vault's
 * treasuries. */
export function roleWallets(snap: Snapshot): { chain: ChainName; address: Hex; roles: string[] }[] {
  const out = watchedRoles(snap);
  const add = (chain: ChainName, a: Hex | undefined, role: string) => {
    if (!a || lower(a) === ZERO) return;
    const w = out.find((x) => x.chain === chain && x.address === lower(a));
    if (w) w.roles.push(role);
    else out.push({ chain, address: lower(a), roles: [role] });
  };
  add("base", snap.base?.state.stakerTreasury, "staker.treasury");
  add("bittensor", snap.bittensor?.state.treasury, "vault.treasury");
  return out;
}

/** What a code is, as an email says it. */
function codeIs(code: Hex): string {
  if (code === "0x") return "no code (an account)";
  if (DELEGATION.test(code)) return `an EIP-7702 delegation to 0x${code.slice(8)}`;
  return `contract code (${(code.length - 2) / 2} bytes, hash ${keccak256(code).slice(0, 10)}…)`;
}
/** An EIP-7702 delegation designator: 0xef0100 and the delegate's 20-byte address. */
const DELEGATION = /^0xef0100[0-9a-f]{40}$/;

interface CodeSeen {
  /** the baseline: the code first seen, or since its last change (its hash, and what it was) */
  first?: { hash: Hex; what: string };
  /** a code differing from the baseline, read on the last tick (a change counts once read twice in a row) */
  pending?: { hash: Hex; what: string };
}

type CodeKind = "account" | "delegation" | "contract";
/** What kind of code an email's description (codeIs) names. */
const kindOf = (what: string): CodeKind => (what.startsWith("no code") ? "account" : what.startsWith("an EIP-7702") ? "delegation" : "contract");

/** keys.delegated (critical, holds) and keys.code_changed (warning): a role wallet's code (read every tick, in the
 * same batch as the transaction counts) differs from its baseline, the code first seen or since its last change,
 * on two readings in a row. Critical: an EIP-7702 delegation designator appearing on an account, a delegation to
 * another target, a contract's code changing, and anything else unexpected; a wallet already delegated when first
 * seen too (the monitor may start after the delegation). Only a warning: plain contract code appearing on an
 * account (a counterfactual Safe deployed at a role address: no key can put contract code there), and a
 * delegation removed. Each confirmed change becomes the baseline, so it is one alert, open until acknowledged.
 * Kept in meta (code_seen:{chain}:{address}), written only when it changes. */
export const keysDelegated: Rule = {
  name: "keys.delegated",
  run(ctx) {
    const out: Finding[] = [];
    for (const w of roleWallets(ctx.snap)) {
      const read = ctx.snap.codes?.[w.chain]?.[w.address];
      if (read === undefined) continue;
      const code = read.toLowerCase() as Hex;
      const now = { hash: keccak256(code), what: codeIs(code) };
      const k = `code_seen:${w.chain}:${w.address}`;
      let s: CodeSeen = {};
      try {
        s = ctx.meta[k] ? (JSON.parse(ctx.meta[k]) as CodeSeen) : {};
      } catch {
        s = {};
      }
      const save = (next: CodeSeen) => ctx.writes.meta.push({ k, v: JSON.stringify(next) });
      const facts = (before: string) => ({ address: w.address, chain: w.chain, roles: w.roles.join(", "), before, now: now.what, explorer: addressLink(w.chain, w.address) });
      const critical = (before: string) => {
        const id = `keys.delegated:${w.chain}:${w.address}:${now.hash}`;
        out.push({
          rule: "keys.delegated",
          key: id,
          subject: `A Cascade role wallet's code changed (${w.roles.join(", ")}): assume its key is compromised`,
          facts: facts(before),
          hold: { id, summary: `the role wallet ${w.address} (${w.roles.join(", ")}) was delegated or its code changed` },
        });
      };
      const warning = (before: string) =>
        out.push({ rule: "keys.code_changed", key: `keys.code_changed:${w.chain}:${w.address}:${now.hash}`, subject: `A Cascade role wallet's code changed (${w.roles.join(", ")})`, facts: facts(before) });
      const twice = s.pending?.hash === now.hash;
      if (!s.first) {
        // first sight: an account or a contract is the baseline; a delegation is confirmed on the next read
        if (!DELEGATION.test(code)) save({ first: now });
        else if (twice) {
          critical("not seen before");
          save({ first: now });
        } else save({ pending: now });
      } else if (now.hash === s.first.hash) {
        if (s.pending) save({ first: s.first });
      } else if (!twice) {
        save({ first: s.first, pending: now });
      } else {
        // a change, read twice: judged by what the code was and is, then taken as the baseline (one alert each)
        const was = kindOf(s.first.what);
        const is = kindOf(now.what);
        // benign: plain contract code on an account (a counterfactual Safe deployed: no key can put it there),
        // or a delegation removed; everything else (a delegation set or moved, a contract's code changed) is not
        if ((was === "account" && is === "contract") || (was === "delegation" && is === "account")) warning(s.first.what);
        else critical(s.first.what);
        save({ first: now });
      }
    }
    return out;
  },
};

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
        // an account's count moves only for what it sends; a Safe's nonce for what it executes, which
        // arrives as a transaction sent to it (or names it as the caller in an event's args)
        const isSafe = safes[h.address] !== undefined;
        const mine = (t: TxRow) => lower(t.from) === h.address || (isSafe && t.to !== undefined && lower(t.to) === h.address);
        const seenNow = ctx.newTxs.filter((t) => t.chain === chain && mine(t)).length;
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

export const ADMIN_RULES: Rule[] = [adminEvent, keys, keysDelegated];
