import type { RuleId } from "./rules/ids.ts";

// What to do, for every rule (spec section 6, "What to do"): every alert carries one. Values come from
// the finding's facts where a line needs them (a deadline, an address, a link). Actions are always done
// from the owner's own tools, never from a link in an email.

type Facts = Record<string, string>;
const or = (v: string | undefined, fallback: string) => (v && v.length ? v : fallback);

export const RUNBOOK: Record<RuleId, (f: Facts) => string> = {
  "price.drop": () =>
    "Find the cause before anything else moves (the stake hotkey and the vault's stake on taostats). If stake left the hotkey set or the drop is unexplained, guardian: pause() the vault so no batch is priced low; re-add a swapped hotkey with addHotkey.",
  "stake.unexplained_drop": (f) =>
    `Stake left the vault without a vault action: look up the hotkey ${or(f.hotkey, "")} on taostats (swap, slash, chain change). Guardian: pause the vault until it is explained.`,
  "stake.hotkey_changed": () =>
    "A hotkey change the owner didn't make means a validator-side swap: re-add the new hotkey with addHotkey (owner, guardian or keeper) and check the price.",
  "admin.event": (f) =>
    `An admin action on a Cascade contract${f.sender ? `, sent by ${f.sender}` : ""}. If it was a planned change, acknowledge it. If not: guardian pause() both contracts now, then rotate keys.`,
  "keys.unexplained_tx": (f) =>
    `A transaction left a Cascade admin key that didn't touch Cascade (or reverted). Open the address on the explorer${f.explorer ? ` (${f.explorer})` : ""}. If it isn't yours, treat the key as compromised: guardian pause, rotate. The rule is quiet only while these keys are used for Cascade alone; acknowledge your own other transactions. On v3-test owner, guardian and keeper are one address, so a reverted keeper call pages here: expect that noise there.`,
  "keys.delegated": (f) =>
    `A role wallet was delegated or its code changed.${f.address ? ` The wallet: ${f.address} (${or(f.roles, "a role")}), ${or(f.before, "before unknown")} then ${or(f.now, "now unknown")}${f.explorer ? `; ${f.explorer}` : ""}.` : ""} First check whether it was your own wallet's smart-account upgrade (then acknowledge, and clear the hold). If not, assume its key is compromised: Guardian pauses; rotate the role. If the guardian itself is the wallet, pause from the owner, and the other way round. Clear the hold only once the role is rotated.`,
  "keys.safe_unread": (f) =>
    `A watched Safe's nonce()${f.address ? ` (${f.address}, ${or(f.roles, "a role")})` : ""} hasn't answered for ${or(f.ticks, "many")} ticks, so the transactions it executes aren't being counted (keys.unexplained_tx can't see them). Check the Bittensor or Base RPC, and the address's code on the explorer${f.explorer ? ` (${f.explorer})` : ""}: a node misreading it, or the address no longer a Safe (then keys.delegated or keys.code_changed says so).`,
  "keys.code_changed": (f) =>
    `A role wallet's code changed in a way a stolen key alone can't cause${f.address ? ` (${f.address}, ${or(f.roles, "a role")}: ${or(f.before, "before unknown")} then ${or(f.now, "now unknown")})` : ""}: a contract deployed at an address that had none (a counterfactual Safe), or a 7702 delegation removed. First check whether it was your own wallet's smart-account change, and acknowledge it. If you didn't deploy it, treat it as critical: someone else can deploy a contract at a role address that wasn't deployed yet, as happened to Wintermute's Safe address on Optimism in 2022, and then controls it (guardian pauses; rotate the role). The new code is the baseline now: a later change of it is critical.`,
  "frontdoor.solvency": () =>
    "The front door holds less than it owes. Guardian: pause() the front door (claims and cancels still work); find the transfer that broke the identity.",
  "vault.solvency": () => "The vault can't cover its queued payouts. Guardian: pause the vault; do not process payouts.",
  "ccip.failure": (f) =>
    `The message and its tokens wait in CCIP. Open it on ccip.chain.link${f.ccip ? ` (${f.ccip})` : ""} and note the reason; it can be executed again by hand once the cause is fixed. Don't pause anything else for this alone, except: if an honest batch failed with DuplicateBatch, a byte-identical copy was delivered first, and this alert may be the only sign of it. Then treat it as bridge.batch_mismatch (guardian pause the vault, check the batch's deliveries).`,
  "ccip.unexpected_source": (f) =>
    `A Cascade contract accepted a message from an unexpected sender. Treat it as a forgery: follow the steps for ${f.side === "base" ? "bridge.payout_mismatch (guardian pause the front door; tell ForeverMoney and Chainlink)" : "bridge.batch_mismatch (guardian pause the vault; owner cancelPayoutBatch before the deadline)"}.`,
  "deposits.bounced": () =>
    "The vault read itself as insolvent and returned the deposits. Find out why (price, stake) before the next batch; process the bounced payout, never cancel it.",
  "fmtao.unbacked": () =>
    "TAO on Base isn't fully backed. Guardian: pause the front door (stops new batches and deliveries); tell ForeverMoney and Chainlink; hold payouts until it is explained.",
  "fmtao.depeg": () => "TAO on Base trades away from TAO. Guardian: pause the front door if it persists; deliveries' floors stop sales into a crashed pool.",
  "bridge.batch_mismatch": (f) =>
    `Possible forged batch. Guardian: pause() the vault now. Owner: cancelPayoutBatch(key, payouts) before ${or(f.deadline, "the payout delay ends (queued time + payoutDelay)")}, with the list rebuilt from the vault's events for this key. Keep the hold until the cancel lands.`,
  "bridge.payout_mismatch": () =>
    "Possible forged payout: TAO was minted on Base for it. Guardian: pause() the front door (deliveries stop; claims can't be stopped); tell ForeverMoney and Chainlink; keep the hold.",
  "bridge.duplicate": (f) =>
    `One message delivered twice under different content. As ${f.side === "base" ? "bridge.payout_mismatch (guardian pause the front door; keep the hold)" : `bridge.batch_mismatch (guardian pause the vault; owner cancelPayoutBatch before ${or(f.deadline, "the payout delay ends")})`}.`,
  "site.integrity": () =>
    "The site may be tampered with. Take it down (Pages: roll back or disable the project), then check DNS, the build and the Pages project. If a file was over the byte cap and is a legitimate large chunk, raise SITE_MAX_BYTES; if a file stopped a run, that is the CPU limit (Workers Paid, or SITE_FILES_PER_RUN=1), not the byte cap. What Cloudflare itself injects must be approved too, once checked to be Cloudflare's: a script loaded from its host (the Web Analytics beacon) with pnpm site:approved ../web/out --extra-script-hosts <host>, a host one of its /cdn-cgi/ scripts names with --extra-hosts <host>, then redeploy. A script host the bundle merely names (a gateway such as arweave.net or ipfs.io in a dependency) is never approved as a script source by that. The limits of this check: it reads the scripts' text, so an address or host built at run time (by string concatenation, or fetched from elsewhere) isn't seen, and a site that serves the monitor a clean copy and users a tampered one can't be caught from outside.",
  "site.no_approved_lists": () =>
    "The site check is running without approved lists, so it judges nothing. Run pnpm site:approved ../web/out on the build you deploy, review the lists, and redeploy the Worker.",
  "indexer.blind": () => "The monitor can't see a chain and the keeper is holding: fix the RPC (quota, outage, switch URLs).",
  "checks.owner_approved": () =>
    "Confirm it was you: a hand approval lets the keeper pay that batch. If it wasn't, rotate Cloudflare access now and hold the keeper (ops/hold.json).",
  "monitor.stalled": () => "Ticks aren't completing (likely the CPU limit): check Workers Observability for the error; the keeper is holding.",
  "monitor.db_failing": () => "The monitor can't write its database (D1 limit or error): check the D1 dashboard; the keeper is holding once the status goes stale.",
  "rail.alpha_vault": () =>
    "ForeverMoney's AlphaVault is paused or migrating: the keeper won't close batches into it. Guardian: pause the front door so no one else closes a batch into a rail that may not deliver, and follow the bridge runbook.",
  "fmtao.mint_surge": () => "FM-TAO on Base rose more than Cascade's payouts explain. Other people's bridging moves supply too: check the bridge's activity before acting.",
  "ccip.undelivered": (f) =>
    `Check the message on ccip.chain.link${f.ccip ? ` (${f.ccip})` : ""}; lanes are sometimes slow. If it stays stuck for hours, raise it with Chainlink.`,
  "ccip.foreign_send": () =>
    "Someone sent a message through our adapter at a Cascade contract; the contract will refuse it (its execution should end in FAILURE). Nothing to do unless it is delivered (then ccip.unexpected_source fires).",
  "keys.keeper_unexplained_tx": (f) =>
    `Usually a keeper call that reverted (it uses the nonce and emits nothing). Check the explorer${f.explorer ? ` (${f.explorer})` : ""}; if it isn't the keeper's, rotate the keeper key.`,
  "batch.past_max_wait": () => "The keeper isn't closing: check that it runs, its ETH, and the front door's state.",
  "payout.overdue": () => "The keeper isn't paying out: check it runs and its TAO; processPayouts is open to anyone after the delay.",
  "delivery.overdue": () => "The keeper can't deliver USDC: check the TWAP oracle and the floors in the keeper's log; the user can still claim.",
  "keeper.low_eth": () => "Top up the keeper wallet's ETH on Base.",
  "keeper.low_tao": () => "Top up the keeper wallet's TAO on Bittensor.",
  "keeper.idle_unstaked": () => "The keeper isn't staking (or isn't running): check it.",
  "adapter.low_reserve": () => "Top up the Bittensor adapter's reserve with fundReserve().",
  "twap.divergence": () => "Deliveries may stall (or the pool is being pushed). Watch the pool; users can claim by hand.",
  "price.reference_unavailable": () => "The depeg rule can't run; check the price sources (PRICE_SOURCES).",
  "pool.liquidity": () => "Swaps cost more; consider lowering batch and deposit limits.",
  "batch.one_wallet": () => "One wallet is filling batches; watch for griefing of the cap or the lists.",
  "cap.nearly_full": () => "New deposits will soon be refused; decide whether to raise the cap.",
  "unstakes.tiny_wave": () => "Someone may be pushing honest exits into later batches; watch the next batches.",
  "outflow.near_limit": () => "Exits beyond the allowance will be deferred; expect RedeemDeferred.",
  "rewards.uncollected": () => "Run pnpm ops claim --live.",
  "validator.not_earning": () => "The validator may have stopped earning (deregistered, offline): check it on taostats; consider moving stake.",
  "vault.events": () => "Read the event in the email; usually a user-level edge case.",
  "indexer.lag": () => "The monitor is behind on a chain and the keeper is holding: check the logs RPC first (state reads may still work).",
  "bridge.check_stuck": (f) =>
    `The keeper won't pay this batch until its check is ok. Find out why (usually Base lag); if you have verified the batch by hand: pnpm checks:approve -- --env <env> --key ${or(f.key, "<delivered key>")} --note "…".`,
  "bridge.payout_unchecked": () =>
    "A payout landing on Base hasn't been checked, and its TAO is already claimable there. Find out why (usually Bittensor lag, or the front door's delivered() read not answering). Verify the landing against the vault's PayoutChunkSent by hand; if you can't soon, guardian: pause() the front door.",
  "indexer.reorg": () => "Usually harmless; if it was a Cascade transaction, re-check its effects.",
  "site.unreachable": () => "Check that the site is up (Pages, DNS).",
  "monitor.chain_unreadable": () => "Check the RPC URLs (the readings of this chain have failed or gone backwards five ticks in a row).",
  "monitor.email_failing": () => "Check the email binding and the destination address (Email Routing).",
  "monitor.rule_failed": (f) => `A rule threw${f.error ? ` (${f.error})` : ""}: a bug to fix. The other rules still ran.`,
  "monitor.bridge_rule_failed": (f) =>
    `The bridge cross-check ${or(f.rule, "rule")} threw${f.error ? ` (${f.error})` : ""}. Nothing it would have decided this tick was written: new deliveries and payout landings stay waiting, so the keeper pays none of them out, and forged ones aren't being caught. Fix the bug and redeploy. Approve a delivery by hand (pnpm checks:approve) only after checking it yourself.`,
};
