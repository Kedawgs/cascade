import { formatUnits, type Hex } from "viem";
import type { Finding } from "../alerts.ts";
import type { StoredLog } from "../logs.ts";
import { isNew, type RuleCtx, txLink } from "./context.ts";
import type { Rule } from "./index.ts";

// The vault's own actions that aren't admin events but must never pass unseen: stake moved between its hotkeys
// (an owner action), and the direct entry points (depositDirect, redeemDirect, allowFrontDoorRedeems), which
// the launch doesn't offer.

const RAO = 10n ** 9n;
const tao = (wei: bigint) => `${formatUnits(wei, 18)} TAO`;
const big = (x: unknown) => BigInt(String(x ?? "0"));
const lower = (x: unknown) => String(x).toLowerCase() as Hex;

/** The vault's logs of these events first stored this tick, after the deployment's baseline (its setup). */
function newVaultLogs(ctx: RuleCtx, events: readonly string[]): StoredLog[] {
  return ctx.logs.range("bittensor", "vault", events).filter((l) => isNew(ctx, l) && l.block > ctx.cfg.deployment.bittensor.baselineBlock);
}

const senderOf = (ctx: RuleCtx, l: StoredLog) => ctx.txs.get(`${l.chain}:${l.txHash}`)?.from ?? "not known yet";

/** vault.stake_moved (warning) and vault.stake_moved_unexpected (critical): every StakeMoved. The vault moves
 * stake only onto its stake hotkey (moveStake, removeHotkey: owner only), so a move to a hotkey that isn't the
 * configured one means the stake hotkey was changed first; that, or a move of stakeMoveCriticalRao or more at
 * once, is critical. The transaction is fetched (attribute.ts), so the sender is named. */
export const stakeMoved: Rule = {
  name: "vault.stake_moved",
  run(ctx) {
    const expected = ctx.cfg.deployment.stakeHotkey;
    return newVaultLogs(ctx, ["StakeMoved"]).map((l): Finding => {
      const to = lower(l.args.to);
      const rao = big(l.args.rao);
      const unexpected = to !== expected;
      const large = rao >= ctx.t.stakeMoveCriticalRao;
      const rule = unexpected || large ? "vault.stake_moved_unexpected" : "vault.stake_moved";
      const amount = tao(rao * RAO);
      const subject = unexpected
        ? `The vault moved ${amount} of stake to a hotkey that isn't the configured stake hotkey`
        : large
          ? `The vault moved ${amount} of stake, at or above the ${tao(ctx.t.stakeMoveCriticalRao * RAO)} alert threshold`
          : `The vault moved ${amount} of stake onto its stake hotkey`;
      return {
        rule,
        key: `${rule}:${l.uid}`,
        subject,
        facts: {
          from: lower(l.args.from),
          to,
          "configured stake hotkey": expected,
          asked: `${rao} rao`,
          moved: `${big(l.args.moved)} rao`,
          sender: senderOf(ctx, l),
          block: String(l.block),
          transaction: txLink(l.chain, l.txHash),
        },
      };
    });
  },
};

/** vault.direct_use (warning) and vault.direct_use_large (critical): every DepositedDirect, RedeemedDirect and
 * FrontDoorRedeemsAllowed (the launch expects none). A deposit or redeem of directCriticalWei or more is
 * critical; so is any direct deposit while a hold is on, when the share price is in doubt and a deposit mints
 * at it. The user is msg.sender, named by the event. */
export const directUse: Rule = {
  name: "vault.direct_use",
  run(ctx) {
    return newVaultLogs(ctx, ["DepositedDirect", "RedeemedDirect", "FrontDoorRedeemsAllowed"]).map((l): Finding => {
      const user = lower(l.args.user);
      const base = { user, hold: ctx.holdActive ? "on" : "off", event: `vault ${l.event}`, block: String(l.block), transaction: txLink(l.chain, l.txHash) };
      if (l.event === "FrontDoorRedeemsAllowed") {
        return { rule: "vault.direct_use", key: `vault.direct_use:${l.uid}`, subject: "A direct depositor opted back into front-door redeems", facts: base };
      }
      const assets = big(l.args.assets);
      const what = l.event === "DepositedDirect" ? "deposit" : "redeem";
      const large = assets >= ctx.t.directCriticalWei;
      const duringHold = l.event === "DepositedDirect" && ctx.holdActive;
      const rule = large || duringHold ? "vault.direct_use_large" : "vault.direct_use";
      const why = large ? `, at or above the ${tao(ctx.t.directCriticalWei)} alert threshold` : duringHold ? " while a hold is on" : "";
      return {
        rule,
        key: `${rule}:${l.uid}`,
        subject: `A direct ${what} of ${tao(assets)} at the vault${why}`,
        facts: { ...base, assets: tao(assets), shares: String(big(l.args.shares)) },
      };
    });
  },
};

export const VAULT_RULES: Rule[] = [stakeMoved, directUse];
