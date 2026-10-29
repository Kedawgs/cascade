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
  "admin.event": critical("event"),
  "keys.unexplained_tx": critical("event"),
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
  "site.integrity": critical("condition"),
  "indexer.blind": critical("condition"),
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
  "indexer.lag": warning("condition"),
  "bridge.check_stuck": warning("condition"),
  "indexer.reorg": warning("event"),
  "site.unreachable": warning("condition"),
  "monitor.chain_unreadable": warning("condition"),
  "monitor.email_failing": warning("condition"),
  "monitor.rule_failed": warning("condition"),
} as const satisfies Record<string, RuleSpec>;

export type RuleId = keyof typeof RULES;
