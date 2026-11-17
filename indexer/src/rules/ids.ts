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
  // v3.2: the vault below half its launch price (totalAssets × 2,000,000 < totalSupply, its own line): it refuses every
  // deposit, a standing state price.drop's fall between readings misses on a slow slide
  "vault.deposits_refused": critical("condition"),
  // R11 (ChatGPT r3, claim 1; src/rules/vault.ts): the vault lens's read of the unlisted stake reverts on two readings: the
  // precompile read the write-off's bound makes fails (a runtime change?), and the vault takes a failed read as 0, so a
  // write-off would run unbounded
  "stake.writeoff_bound_off": critical("condition"),
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
  // critical conditions their rules couldn't judge (a reading or a field missing, the rule throwing) for
  // unjudgedCriticalS: one alert for all of them, so a decode broken for good can't blind a critical in silence
  "monitor.unjudged": critical("condition"),
  // 6.4, proposed (switchable in THRESHOLDS rules.off)
  "rail.alpha_vault": critical("condition"),
  "fmtao.mint_surge": warning("event"),
  // what Cascade depends on and doesn't control (src/rules/deps.ts). Only the AlphaVault's backing short of wTAO can
  // hold, and only once BACKING_HOLD is on: a payout sends TAO into that rail, and no stranger can cause it
  "fmtao.backing_true": critical("condition", true),
  // a new way to mint or release (a MINTER grant, a remote pool, lane or router added), an admin moving, a lane's
  // bucket at capacity 0 or Cascade's lane removed, the lock pool's liquidity withdrawn
  "fmtao.role_change_critical": critical("event"),
  // what no event shows (R3 FM-L2): the registry naming another pool for the rail's token, the batch lane's bucket off,
  // removed or below a full batch; the lock pool's rebalancer set (setRebalancer logs nothing); a registry administrator
  // transfer pending
  "rail.pool": critical("condition"),
  "fmtao.rebalancer_set": critical("condition"),
  "fmtao.registry_admin": critical("condition"),
  "validator.take_high": critical("condition"),
  "validator.root_uid_lost": critical("condition"),
  // RootStakeUnlockInterval set (today's root.unlock_interval, renamed on every deployment: plan Task 57)
  "root.hold_interval": critical("condition"),
  // the TWAP oracle's usdcValue reverts: deliveries to USDC stop (claims still work)
  "oracle.reverted": critical("condition"),
  // v3.2 (src/rules/admin.ts): every scheduled, executed and cancelled owner change, at once, on both chains (the
  // single-key mitigation); a pending item that would now loosen a limit at execute (a direct tightening since it was
  // scheduled); the stake hotkey switched at once, with no scheduled item
  "admin.scheduled": critical("event"),
  "admin.executed": critical("event"),
  "admin.cancelled": critical("event"),
  "admin.item_loosens": critical("event"),
  "admin.hotkey_switched": critical("event"),
  // v3.2: either chain's exits machine not OPEN, or the launch chain with no active front door
  "admin.exits_state": critical("condition"),
  // v3.2 (src/rules/rails.ts, Task 57c): the two chains disagree on the bridge while both may read OPEN: the front
  // door's primary's Bittensor half not enabled on the vault, or the vault's primary's Base half unknown to the front
  // door, so every batch (or payout) is refused at one end; or a primary disabled on a chain whose exits read OPEN (or
  // the vault's, closed or not, while the front door still sends through it). Holds: the keeper's closes would park
  // batches for 14 days
  "rails.incoherent": critical("condition", true),
  // v3.2: an ownership transfer has run; the new owner can accept until pendingSince + 7 days
  "admin.owner_pending": critical("condition"),
  // v3.2: stake missing, the hotkey set full, and only the owner can free a slot for the swap's new hotkey
  "stake.set_full": critical("condition"),
  // v3.2: more items scheduled than the record tracks (each still emailed; those past it aren't judged or shown)
  "admin.record_full": critical("condition"),
  // v3.2 (src/rules/vault.ts): the stake guard holds (the vault's booked stake isn't on its hotkeys: a swap), naming the
  // hotkey whose stake fell; v3.2's stake.divergence. Never a hold: the vault mints nothing meanwhile
  "stake.missing": critical("condition"),
  // v3.2 (src/rules/bridge.ts): a front-door batch parked in a Bittensor adapter for an hour (or the adapter's totals
  // owing more than the parks seen); a token park while ForeverMoney's migration notice runs
  "bridge.parked": critical("condition"),
  "bridge.parked_tokens_during_migration": critical("condition"),
  // R4 (src/rules/r4.ts): the stamp bot quiet past THRESHOLDS stampQuietS (off at 0; D-L3); every deposit refused by an
  // open batch with less room than one deposit that can't close (A-L1); Bittensor's minimum stake at 80% of the redeem
  // floor; payouts the vault's primary bridge can't send (S-H1: its canSendPayouts() false); a bounce-only payout queue
  // on a door or bridge that is going (S-L4)
  "admin.stamp_quiet": critical("condition"),
  "batch.deposits_blocked": critical("condition"),
  "stake.min_at_floor": critical("condition"),
  "rail.payouts_closed": critical("condition"),
  // R4 (the stuck review's S-H1 monitor rule): a front-door Redeemed stored after the monitor saw the vault's primary
  // bridge closed: the vault should have deferred it (its guard failed open). rail.payouts_closed covers the queued
  // batch itself; critical, so no hold mutes either
  "payout.no_rail": critical("event"),
  "payout.bounces_stranded": critical("condition"),
  "fmtao.role_change": warning("event"),
  // v3.2: a scheduled item that can no longer run (its window passed, a closure or stamp killed it, it reverts at
  // execute, or it was pruned)
  "admin.lapsed": warning("event"),
  // v3.2: the vault adopted a surplus of stake into the price (adoptStake: the keeper's, at most daily)
  "vault.stake_adopted": warning("event"),
  // v3.2: an owner that isn't a 2-of-3 Safe while Cascade is past the founder level (the stage above early, or a cap)
  "admin.owner_kind": warning("condition"),
  // v3.2: a surplus of stake (at least the chain's minimum) not adopted into the price for more than a day
  "stake.surplus_unadopted": warning("condition"),
  // v3.2: the unstake walk skipped one hotkey repeatedly (a root hold on the pair, or its gas share burned), not once
  "stake.unstake_skipped": warning("condition"),
  // v3.2: the chain's minimum stake rose: a smaller position can't be unstaked, nor a swapped one listed by a stranger
  "stake.min_raised": warning("event"),
  // v3.2: the chain kept part of a root unstake (PayoutChunkSent.unstakeCost or ShortfallAbsorbed above 0): a removal
  // fee, which the leaver pays (Task 36b)
  "stake.removal_fee": warning("event"),
  // R4 (the vault-favour review's Low 1): the chain kept part of a stake add (Staked's measured short of its rao by more
  // than 1 rao): stakeIdle books the measured, so every holder bears it
  "stake.add_fee": warning("event"),
  // v3.2: a stake or USDC delivery settled more than swapBelowOracleBps below the oracle's price (or a delivery below the
  // pools' price before it)
  "swap.below_oracle": warning("event"),
  // v3.2: a queued payout entry bigger than the primary bridge carries in one message (its chunk can't be sent)
  "payout.entry_above_cap": warning("condition"),
  // v3.2: an adapter's native reserve or token cushion below its target (above what it owes its parks)
  "bridge.cushion_low": warning("condition"),
  // v3.2: a park refunded to its door on Base, or an empty one dropped
  "bridge.refunded": warning("event"),
  "bridge.dropped": warning("event"),
  // v3.2: a Bittensor adapter that is no longer the vault's primary bridge still holds parks: the pair can't retire
  "bridge.retire_blocked": warning("condition"),
  // v3.2: a stranger's batch parked (not the front door's, or not to the vault: R3 A-L2), never critical
  "bridge.parked_stranger": warning("event"),
  // 100 TAO or more of wTAO outside the lock pool for an hour: anyone can mint and keep wTAO, so a warning (more than
  // 5% of its supply for an hour is fmtao.backing_true's critical lock side)
  "fmtao.lock_outside": warning("condition"),
  "rail.alpha_vault_admin": warning("condition"),
  // the batch lane's bucket below a full batch for an hour (R3 FM-L2): the next one waits for it to refill
  "rail.pool_low": warning("condition"),
  "validator.take_changed": warning("event"),
  "validator.root_stake_drop": warning("condition"),
  "ccip.rate_limited": warning("condition"),
  "oracle.cardinality": warning("condition"),
  // v3.2: a pool the oracle reads thinner than the front door's floor (deliveries refused ThinPool; claims work), and
  // held so for hours (R3 C-L1: the keeper's deliveries skipped round after round)
  "oracle.thin_pool": warning("condition"),
  "oracle.thin_pool_repeated": warning("condition"),
  // v3.2: a root hold stamp on one of the pairs the deployment depends on; unjudged until Task 62 confirms its storage key
  "root.pair_stamped": warning("event"),
  "payout.fee_ceiling": warning("condition"),
  // R12a: a full redeem list's fees cover a full batch's close quote less than 1.5 times (fake requests' margin)
  "batch.redeem_fee_thin": warning("condition"),
  // 6.3 warning
  "ccip.undelivered": warning("condition"),
  "ccip.foreign_send": warning("event"),
  "keys.keeper_unexplained_tx": warning("event"),
  // a role wallet's code changed in a way no stolen key can: a contract deployed at an account, a delegation removed
  "keys.code_changed": warning("event"),
  // a watched Safe's nonce() unread for many ticks: its transactions aren't being counted meanwhile
  "keys.safe_unread": warning("condition"),
  // a chain's watched transaction counts unread for many ticks (their batch failing): keys.unexplained_tx judges
  // nothing meanwhile, and keys.delegated (its code reads in the same batch) is blind
  "keys.count_unread": warning("condition"),
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
  // R4 (src/rules/r4.ts): the deposit cap counting TAO direct exits took out (A-L2); Bittensor's minimum stake at half
  // the redeem floor
  "cap.exits_consumed": warning("condition"),
  "stake.min_near_floor": warning("condition"),
  // R6 (ChatGPT R2 claim E; src/rules/vault.ts): stake missing above dust but inside the vault's tolerance (stakeMissing()
  // false): mints still run, at a price that leaves the gap out, so the minters gain from the holders once it is listed
  "stake.missing_small": warning("condition"),
  // R6 (ChatGPT R2 claim C; src/rules/vault.ts): the write-off's check of the unlisted stake, one precompile read the vault
  // caps at 45,000,000 gas, costs more than THRESHOLDS writeOffReadGasWarn (positions anyone can add on the coldkey)
  "stake.writeoff_read_gas": warning("condition"),
  // R6 (Fable's full review, L-2; src/rules/r4.ts): the open batch's deposit list full of deposits near the minimum on two
  // readings: every other deposit refused until it closes, and the slots free to hold (deposits are cancellable)
  "batch.deposits_full": warning("condition"),
  // R8 (the contracts review's L-1; src/rules/r4.ts): one address cancelling deposits in the open batch, half its value
  // limit together or three times: a holder keeping it full between the keeper's once-a-minute rounds
  "batch.cancel_churn": warning("condition"),
  "unstakes.tiny_wave": warning("condition"),
  // R4 (B-H1's monitor rule): a holder's deposit and unstake under one key, or within the hold's day (a deferral) or two
  // (a burn): the spec's residual, crowding the first-come allowance with a day's exposure; never a hold
  "unstakes.wash": warning("event"),
  "outflow.near_limit": warning("condition"),
  "rewards.uncollected": warning("condition"),
  "validator.not_earning": warning("condition"),
  "vault.events": warning("event"),
  // stake on a hotkey the vault doesn't list without a matching fall in its counted stake: a stranger's
  // transfer_stake gift (anyone can push stake onto the vault's coldkey), to be swept, never a hold
  "stake.unlisted": warning("event"),
  // the hourly cross-check: the store holds a log the second RPC (the re-read margin past it) lacks
  "indexer.logs_extra": warning("event"),
  // the second RPC of a chain hasn't answered the cross-check for logsCheckUnverifiedS: its logs go unverified
  "indexer.unverified": warning("condition"),
  // the owner moved stake onto the stake hotkey (moveStake, removeHotkey): an owner action, every one reported
  "vault.stake_moved": warning("event"),
  // depositDirect, redeemDirect or allowFrontDoorRedeems (v3.2: setRedeemOrigin, ruling A3): the launch offers none of them
  "vault.direct_use": warning("event"),
  "indexer.lag": warning("condition"),
  "bridge.check_stuck": warning("condition"),
  "indexer.reorg": warning("event"),
  "site.unreachable": warning("condition"),
  "site.no_approved_lists": warning("condition"),
  // a page's CSP differs from the approved one only in its inline-script hashes: a site deployed without new lists
  "site.stale_lists": warning("condition"),
  // files dropped as gone with a redeployed build, in each of the last few passes
  "site.redeploy_race": warning("condition"),
  "monitor.chain_unreadable": warning("condition"),
  "monitor.email_failing": warning("condition"),
  "monitor.rule_failed": warning("condition"),
} as const satisfies Record<string, RuleSpec>;

export type RuleId = keyof typeof RULES;
