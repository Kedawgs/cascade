// Every rule the monitor runs (spec section 6), with its tier and kind. A *condition* holds or not (its
// alert resolves when it clears); an *event* happened (its alert stays open until acknowledged, or closes
// quietly after 7 days). `canHold`: its findings may raise the keeper's hold. `mutedByHold`: dropped while
// a hold is on (the keeper is holding on purpose).

export interface RuleSpec {
  tier: "critical" | "warning";
  kind: "condition" | "event";
  canHold: boolean;
  mutedByHold: boolean;
}

const critical = (kind: RuleSpec["kind"], canHold = false): RuleSpec => ({ tier: "critical", kind, canHold, mutedByHold: false });
const warning = (kind: RuleSpec["kind"], mutedByHold = false): RuleSpec => ({ tier: "warning", kind, canHold: false, mutedByHold });

export const RULES = {
  // 6.1 critical
  "price.drop": critical("event", true),
  "stake.unexplained_drop": critical("event", true),
  "stake.hotkey_changed": critical("event", true),
  // the vault's counted stake fell by what now sits on a hotkey the vault doesn't list (a validator's hotkey
  // swap): the price doesn't count it, so shares mint cheaply until it is re-added
  "stake.divergence": critical("event", true),
  "admin.event": critical("event"),
  // the owner moved stake to a hotkey that isn't the configured stake hotkey, or a large amount at once
  "vault.stake_moved_unexpected": critical("event"),
  // a direct deposit or redeem above the size threshold, or a direct deposit while a hold is on
  "vault.direct_use_large": critical("event"),
  "keys.unexplained_tx": critical("event"),
  // a role wallet delegated (EIP-7702) or its code changed: assume the key is compromised
  "keys.delegated": critical("event", true),
  "frontdoor.solvency": critical("condition", true),
  "vault.solvency": critical("condition", true),
  "ccip.failure": critical("condition"),
  "ccip.unexpected_source": critical("event", true),
  "deposits.bounced": critical("event"),
  "fmtao.unbacked": critical("condition"),
  "fmtao.depeg": critical("condition"),
  "bridge.batch_mismatch": critical("event", true),
  "bridge.payout_mismatch": critical("event", true),
  "bridge.duplicate": critical("event", true),
  // a payout landing on Base left unchecked: its TAO is claimable already (Tasks 11-20 review)
  "bridge.payout_unchecked": critical("condition"),
  "site.integrity": critical("condition"),
  "indexer.blind": critical("condition"),
  // the hourly cross-check: a second RPC served a watched log the primary never did (the primary is lying or
  // pruning): raised by the hourly job itself
  "indexer.logs_omitted": critical("event"),
  "checks.owner_approved": critical("event"),
  "monitor.stalled": critical("condition"),
  "monitor.db_failing": critical("condition"),
  // a bridge cross-check rule threw: its deliveries and landings stay waiting, unchecked (review C1)
  "monitor.bridge_rule_failed": critical("condition"),
  // 6.4, proposed (switchable in THRESHOLDS rules.off)
  "rail.alpha_vault": critical("condition"),
  "fmtao.mint_surge": warning("event"),
  // 6.3 warning
  "ccip.undelivered": warning("condition"),
  "ccip.foreign_send": warning("event"),
  "keys.keeper_unexplained_tx": warning("event"),
  // a role wallet's code changed in a way no stolen key can: a contract deployed at an account, a delegation removed
  "keys.code_changed": warning("event"),
  // a watched Safe's nonce() unread for many ticks: its transactions aren't being counted meanwhile
  "keys.safe_unread": warning("condition"),
  "batch.past_max_wait": warning("condition", true),
  "payout.overdue": warning("condition", true),
  "delivery.overdue": warning("condition"),
  "keeper.low_eth": warning("condition"),
  "keeper.low_tao": warning("condition"),
  "keeper.idle_unstaked": warning("condition"),
  "adapter.low_reserve": warning("condition"),
  "twap.divergence": warning("condition"),
  "price.reference_unavailable": warning("condition"),
  "pool.liquidity": warning("condition"),
  "batch.one_wallet": warning("condition"),
  "cap.nearly_full": warning("condition"),
  "unstakes.tiny_wave": warning("condition"),
  "outflow.near_limit": warning("condition"),
  "rewards.uncollected": warning("condition"),
  "validator.not_earning": warning("condition"),
  "vault.events": warning("event"),
  // stake on a hotkey the vault doesn't list without a matching fall in its counted stake: a stranger's
  // transfer_stake gift (anyone can push stake onto the vault's coldkey), to be swept, never a hold
  "stake.unlisted": warning("event"),
  // the hourly cross-check: the store holds a log the second RPC (REREAD blocks past it) lacks
  "indexer.logs_extra": warning("event"),
  // the second RPC of a chain hasn't answered the cross-check for logsCheckUnverifiedS: its logs go unverified
  "indexer.unverified": warning("condition"),
  // the owner moved stake onto the stake hotkey (moveStake, removeHotkey): an owner action, every one reported
  "vault.stake_moved": warning("event"),
  // depositDirect, redeemDirect or allowFrontDoorRedeems: the launch offers none of them
  "vault.direct_use": warning("event"),
  "indexer.lag": warning("condition"),
  "bridge.check_stuck": warning("condition"),
  "indexer.reorg": warning("event"),
  "site.unreachable": warning("condition"),
  "site.no_approved_lists": warning("condition"),
  // a page's CSP differs from the approved one only in its inline-script hashes: a site deployed without new lists
  "site.stale_lists": warning("condition"),
  "monitor.chain_unreadable": warning("condition"),
  "monitor.email_failing": warning("condition"),
  "monitor.rule_failed": warning("condition"),
} as const satisfies Record<string, RuleSpec>;

export type RuleId = keyof typeof RULES;
