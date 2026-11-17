import { formatUnits, type Hex } from "viem";
import { HALF_LAUNCH_SHARES_PER_WEI, UNDERWATER_TOLERANCE_WEI } from "../abi.ts";
import type { Finding } from "../alerts.ts";
import type { StoredLog } from "../logs.ts";
import type { BaseState, BitState } from "../snapshot.ts";
import { CONTRACT_NAMES, isNew, onset, type Readings, type RuleCtx, twice, txLink, unjudged } from "./context.ts";
import type { Rule } from "./index.ts";
import { deferralWhy } from "./r4.ts";

// Spec 6.1 and 6.2: what the front door and vault hold against what they owe, and the vault's edge cases.

const MARGIN_WEI = 10n ** 12n;
const RAO = 10n ** 9n;
const tao = (wei: bigint) => `${formatUnits(wei, 18)} TAO (${wei} wei)`;

/** What a contract holds against what it owes, and (v3.2's vault) the shortfall its own rule allows. */
type Side = { has: bigint; owes: bigint; allowed?: bigint } | undefined;

const fdTao = (s?: BaseState): Side =>
  s?.frontDoorTao === undefined || !s.openBatch || s.totalClaimable === undefined ? undefined : { has: s.frontDoorTao, owes: s.openBatch.totalDeposits + s.totalClaimable };
const fdEth = (s?: BaseState): Side =>
  s?.frontDoorEth === undefined || !s.openBatch || s.totalFeeCredit === undefined ? undefined : { has: s.frontDoorEth, owes: s.openBatch.feePot + s.totalFeeCredit };
const vaultSide = (s?: BitState): Side =>
  s?.rootStakeRao === undefined || s.balance === undefined || s.pendingPayouts === undefined
    ? undefined
    : { has: s.rootStakeRao * RAO + s.balance, owes: s.pendingPayouts + MARGIN_WEI };
/** v3.2: the vault's own underwater rule (CascadeFormulas.underwater, which every mint checks) on the lens's
 * grossAssets (min(visible, booked) stake and the balance, less ED_RESERVE), as the vault applies it. The unvested
 * rewards are the lens's unvestedRewards: both drips' sum, the claim schedule and the adoption drip (Revision 27). At a
 * supply of 0 they are no holder's: _unvestedForMint first writes both down, in all, to what the gross holds beyond the
 * queued payouts, so the vault owes the payouts alone, and a shortfall up to UNDERWATER_TOLERANCE is allowed (a
 * rounding of the chain's that the next minter absorbs), whatever was vesting. With shares outstanding they are the
 * holders' (never written down): the vault owes the payouts and the unvested rewards, and any shortfall counts (a mint
 * then refuses at assets 0). */
const vaultSide32 = (s?: BitState): Side =>
  s?.grossAssets === undefined || s.pendingPayouts === undefined || s.unvestedRewards === undefined || s.totalSupply === undefined
    ? undefined
    : s.totalSupply === 0n
      ? { has: s.grossAssets, owes: s.pendingPayouts, allowed: UNDERWATER_TOLERANCE_WEI }
      : { has: s.grossAssets, owes: s.pendingPayouts + s.unvestedRewards, allowed: 0n };
/** Short of what it owes, beyond what its rule allows; undefined while a side is unread. */
const short = (x: Side) => (x === undefined ? undefined : x.has + (x.allowed ?? 0n) < x.owes);

/** A shortfall found on two readings: one alert while it lasts, the hold raised on its first tick; unjudged while a
 * reading or a side is unread. */
function shortfall(ctx: RuleCtx, o: { chain: "base" | "bittensor"; side: (r: Readings) => Side; rule: "frontdoor.solvency" | "vault.solvency"; key: string; what: string; unit: string }): Finding[] {
  const cond = (r: Readings) => short(o.side(r));
  const held = twice(ctx, o.chain, cond);
  if (held === undefined) return unjudged(ctx, o.rule, o.key);
  if (!held) return [];
  const now = ctx.snap[o.chain]!;
  const p = ctx.previous[o.chain]!;
  const x = o.side({ [o.chain]: now.state }) as NonNullable<Side>;
  const f: Finding = {
    rule: o.rule,
    key: o.key,
    subject: `The ${o.what} holds less ${o.unit} than it owes`,
    facts: { holds: String(x.has), owes: String(x.owes), short: String(x.owes - x.has), block: String(now.block), since: String(p.block) },
  };
  if (x.allowed !== undefined) f.facts["allowed short"] = x.allowed === 0n ? "none" : `${tao(x.allowed)}, with no shares left`;
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

/** vault.solvency: rootStake × 1e9 + the vault's TAO below its pending payouts + 1e12 (v3.1); on v3.2 the vault's own
 * underwater rule on the lens's grossAssets (vaultSide32). On two readings. Holds. */
export const vaultSolvency: Rule = {
  name: "vault.solvency",
  run: (ctx) => {
    const side = ctx.cfg.deployment.version === "v3.2" ? vaultSide32 : vaultSide;
    return shortfall(ctx, { chain: "bittensor", side: (r) => side(r.bittensor), rule: "vault.solvency", key: "vault.solvency", what: "vault", unit: "TAO" });
  },
};

const newVault = (ctx: RuleCtx, events: readonly string[]) => ctx.logs.range("bittensor", "vault", events).filter((l) => isNew(ctx, l));

/** v3.2's DepositBounced reason (CascadeTypes.sol BounceReason): why, in the facts, and in short, in the subject. */
const BOUNCE_REASONS: Record<string, { fact: string; short: string }> = {
  "0": { fact: "Insolvent: the vault was below half the launch price, or underwater", short: "it was below half the launch price, or underwater" },
  "1": { fact: "ForeignOrigin: this address redeems through another chain's front doors", short: "the user redeems through another chain" },
};

/** deposits.bounced: each vault DepositBounced, on the tick it is first stored. */
export const depositsBounced: Rule = {
  name: "deposits.bounced",
  run: (ctx) =>
    newVault(ctx, ["DepositBounced"]).map((l) => {
      const facts: Record<string, string> = { user: String(l.args.user), amount: tao(BigInt(String(l.args.assets))), batch: String(l.args.key), transaction: txLink(l.chain, l.txHash) };
      // v3.2: why (its DepositBounced carries a reason; v3-launch's doesn't, and its email is today's)
      const why = ctx.cfg.deployment.version === "v3.2" && l.args.reason !== undefined ? (BOUNCE_REASONS[String(l.args.reason)] ?? { fact: `reason ${String(l.args.reason)}`, short: `reason ${String(l.args.reason)}` }) : undefined;
      if (why) facts.reason = why.fact;
      return { rule: "deposits.bounced" as const, key: `deposits.bounced:${l.uid}`, subject: why ? `The vault bounced a deposit: ${why.short}` : "The vault bounced a deposit", facts };
    }),
};

/** vault.deposits_refused (critical, v3.2): the vault below half its launch price on two readings: totalSupply above 0
 * and totalAssets (the lens's) × HALF_LAUNCH_SHARES_PER_WEI below it, the vault's own line, which depositDirect and a
 * batch delivery both check. Every deposit is then refused (a batch's bounce back to Base, BounceReason Insolvent; a
 * direct one reverts VaultInsolvent and logs nothing): assets were lost. price.drop sees a fall between readings and
 * misses a slow slide, and after its hold is cleared nothing stands while every deposit is refused: this is the
 * standing state (Task 54's re-review). An empty vault (no shares) is vault.solvency's. Unjudged without either
 * reading. Never a hold: the vault guards itself. */
export const depositsRefused: Rule = {
  name: "vault.deposits_refused",
  run(ctx) {
    if (ctx.cfg.deployment.version !== "v3.2") return [];
    const below = (r: Readings) => {
      const a = r.bittensor?.totalAssets;
      const sup = r.bittensor?.totalSupply;
      return a === undefined || sup === undefined ? undefined : sup > 0n && a * HALF_LAUNCH_SHARES_PER_WEI < sup;
    };
    const held = twice(ctx, "bittensor", below);
    if (held === undefined) return unjudged(ctx, "vault.deposits_refused", "vault.deposits_refused");
    if (!held) return [];
    const r = ctx.snap.bittensor!;
    const a = r.state.totalAssets as bigint;
    const sup = r.state.totalSupply as bigint;
    return [
      {
        rule: "vault.deposits_refused",
        key: "vault.deposits_refused",
        subject: "The vault refuses every deposit: its share price is below half the launch price",
        facts: {
          "total assets": tao(a),
          "total supply": `${formatUnits(sup, 18)} shares`,
          "share price": `${formatUnits((a * 10n ** 18n) / sup, 18)} TAO a share`,
          "the line": `${formatUnits(10n ** 18n / HALF_LAUNCH_SHARES_PER_WEI, 18)} TAO a share (half the launch price)`,
          block: String(r.block),
        },
      },
    ];
  },
};

const EDGE_CASES = ["RedeemDeferred", "PayoutDust", "DepositSkipped"];

/** vault.events: each vault RedeemDeferred, PayoutDust or DepositSkipped, and each log that didn't decode,
 * on the tick it is first stored. On v3.2 a RedeemDeferred's email names its likely cause (deferralWhy: R4's one-day
 * hold and closed rail beside the allowance and the minimum). */
export const vaultEvents: Rule = {
  name: "vault.events",
  run(ctx) {
    const unknown = ctx.logs.all().filter((l) => l.event === "unknown" && isNew(ctx, l));
    const logs: StoredLog[] = [...newVault(ctx, EDGE_CASES), ...unknown].sort((a, b) => (a.chain !== b.chain ? (a.chain < b.chain ? -1 : 1) : a.block < b.block ? -1 : a.block > b.block ? 1 : a.logIndex - b.logIndex));
    return logs.map((l) => {
      const name = `${CONTRACT_NAMES[l.contract]} ${l.event}`;
      const args = Object.fromEntries(Object.entries(l.args).map(([k, v]) => [k, String(v)]));
      const facts: Record<string, string> = { ...args, event: name, block: String(l.block), transaction: txLink(l.chain, l.txHash) };
      if (l.event === "unknown") facts.address = l.address as Hex;
      // v3.2: a deferral's causes are four since R4 (the hold, a closed rail, the allowance, the minimum), and it names none
      if (l.event === "RedeemDeferred" && ctx.cfg.deployment.version === "v3.2") Object.assign(facts, { "why (the likely cause)": deferralWhy(ctx, l), contracts: "v3.2" });
      return { rule: "vault.events" as const, key: `vault.events:${l.uid}`, subject: l.event === "unknown" ? `A ${CONTRACT_NAMES[l.contract]} log that didn't decode` : `Vault ${l.event}`, facts };
    });
  },
};

export const SOLVENCY_RULES: Rule[] = [frontDoorSolvency, vaultSolvency, depositsBounced, depositsRefused, vaultEvents];
