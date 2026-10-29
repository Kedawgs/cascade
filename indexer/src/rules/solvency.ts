import { formatUnits, type Hex } from "viem";
import type { Finding } from "../alerts.ts";
import type { StoredLog } from "../logs.ts";
import type { BaseState, BitState } from "../snapshot.ts";
import { CONTRACT_NAMES, isFresh, onset, type Readings, type RuleCtx, twice, txLink } from "./context.ts";
import type { Rule } from "./index.ts";

// Spec 6.1 and 6.2: what the front door and vault hold against what they owe, and the vault's edge cases.

const MARGIN_WEI = 10n ** 12n;
const RAO = 10n ** 9n;
const tao = (wei: bigint) => `${formatUnits(wei, 18)} TAO (${wei} wei)`;

type Side = { has: bigint; owes: bigint } | undefined;

const fdTao = (s?: BaseState): Side =>
  s?.frontDoorTao === undefined || !s.openBatch || s.totalClaimable === undefined ? undefined : { has: s.frontDoorTao, owes: s.openBatch.totalDeposits + s.totalClaimable };
const fdEth = (s?: BaseState): Side =>
  s?.frontDoorEth === undefined || !s.openBatch || s.totalFeeCredit === undefined ? undefined : { has: s.frontDoorEth, owes: s.openBatch.feePot + s.totalFeeCredit };
const vaultSide = (s?: BitState): Side =>
  s?.rootStakeRao === undefined || s.balance === undefined || s.pendingPayouts === undefined
    ? undefined
    : { has: s.rootStakeRao * RAO + s.balance, owes: s.pendingPayouts + MARGIN_WEI };
const short = (x: Side) => x !== undefined && x.has < x.owes;

/** A shortfall found on two readings: one alert while it lasts, the hold raised on its first tick. */
function shortfall(ctx: RuleCtx, o: { chain: "base" | "bittensor"; side: (r: Readings) => Side; rule: "frontdoor.solvency" | "vault.solvency"; key: string; what: string; unit: string }): Finding[] {
  const cond = (r: Readings) => short(o.side(r));
  if (!twice(ctx, o.chain, cond)) return [];
  const now = ctx.snap[o.chain]!;
  const p = ctx.previous[o.chain]!;
  const x = o.side({ [o.chain]: now.state }) as { has: bigint; owes: bigint };
  const f: Finding = {
    rule: o.rule,
    key: o.key,
    subject: `The ${o.what} holds less ${o.unit} than it owes`,
    facts: { holds: String(x.has), owes: String(x.owes), short: String(x.owes - x.has), block: String(now.block), since: String(p.block) },
  };
  if (onset(ctx, o.chain, cond)) f.hold = { id: `${o.key}:${p.block}`, summary: `the ${o.what} is short of ${o.unit} it owes` };
  return [f];
}

/** frontdoor.solvency: the front door's FM-TAO below the open batch's deposits plus what is claimable, or
 * its ETH below the fee pot plus fee credit, in one block, on two readings. Holds. */
export const frontDoorSolvency: Rule = {
  name: "frontdoor.solvency",
  run: (ctx) => [
    ...shortfall(ctx, { chain: "base", side: (r) => fdTao(r.base), rule: "frontdoor.solvency", key: "frontdoor.solvency:tao", what: "front door", unit: "TAO" }),
    ...shortfall(ctx, { chain: "base", side: (r) => fdEth(r.base), rule: "frontdoor.solvency", key: "frontdoor.solvency:eth", what: "front door", unit: "ETH" }),
  ],
};

/** vault.solvency: rootStake × 1e9 + the vault's TAO below its pending payouts + 1e12, on two readings.
 * Holds. */
export const vaultSolvency: Rule = {
  name: "vault.solvency",
  run: (ctx) => shortfall(ctx, { chain: "bittensor", side: (r) => vaultSide(r.bittensor), rule: "vault.solvency", key: "vault.solvency", what: "vault", unit: "TAO" }),
};

const freshVault = (ctx: RuleCtx, events: readonly string[]) => ctx.logs.range("bittensor", "vault", events).filter((l) => isFresh(ctx, l));

/** deposits.bounced: each vault DepositBounced, on the tick it settles. */
export const depositsBounced: Rule = {
  name: "deposits.bounced",
  run: (ctx) =>
    freshVault(ctx, ["DepositBounced"]).map((l) => ({
      rule: "deposits.bounced",
      key: `deposits.bounced:${l.uid}`,
      subject: "The vault bounced a deposit",
      facts: { user: String(l.args.user), amount: tao(BigInt(String(l.args.assets))), batch: String(l.args.key), transaction: txLink(l.chain, l.txHash) },
    })),
};

const EDGE_CASES = ["RedeemDeferred", "PayoutDust", "DepositSkipped"];

/** vault.events: each vault RedeemDeferred, PayoutDust or DepositSkipped, and each log that didn't decode,
 * on the tick it settles. */
export const vaultEvents: Rule = {
  name: "vault.events",
  run(ctx) {
    const unknown = ctx.logs.all().filter((l) => l.event === "unknown" && isFresh(ctx, l));
    const logs: StoredLog[] = [...freshVault(ctx, EDGE_CASES), ...unknown].sort((a, b) => (a.chain !== b.chain ? (a.chain < b.chain ? -1 : 1) : a.block < b.block ? -1 : a.block > b.block ? 1 : a.logIndex - b.logIndex));
    return logs.map((l) => {
      const name = `${CONTRACT_NAMES[l.contract]} ${l.event}`;
      const args = Object.fromEntries(Object.entries(l.args).map(([k, v]) => [k, String(v)]));
      const facts: Record<string, string> = { ...args, event: name, block: String(l.block), transaction: txLink(l.chain, l.txHash) };
      if (l.event === "unknown") facts.address = l.address as Hex;
      return { rule: "vault.events" as const, key: `vault.events:${l.uid}`, subject: l.event === "unknown" ? `A ${CONTRACT_NAMES[l.contract]} log that didn't decode` : `Vault ${l.event}`, facts };
    });
  },
};

export const SOLVENCY_RULES: Rule[] = [frontDoorSolvency, vaultSolvency, depositsBounced, vaultEvents];
