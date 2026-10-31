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
  "stake.divergence": (f) =>
    `The vault's counted stake fell by what now sits on hotkey ${or(f.hotkey, "(see the facts)")} (${or(f.stake, "see the facts")}), which the vault doesn't list, so rootStakeRao() and the share price don't count it: a validator's hotkey swap (the stake moved to its new hotkey), or stake moved off a listed hotkey. Until it is listed again, shares mint cheaply at the depressed price (a batch delivery, depositDirect). Guardian: pause() the vault now (deliveries, direct deposits and payouts stop). Then owner, guardian or keeper: addHotkey(${or(f.hotkey, "<the hotkey>")}) to bring the stake back into the price (the set holds at most 4: owner removeHotkey an empty one first if it is full). Check on taostats${f.taostats ? ` (${f.taostats})` : ""} that the stake is there and who owns the hotkey now, check the price recovered, then clear the hold${f["the hold"]?.startsWith("on, from") ? ` (${f["the hold"].slice(9)}'s: this alert raised none of its own)` : ""} and unpause.`,
  "stake.unlisted": (f) =>
    `${or(f.stake, "Stake")} sits on hotkey ${or(f.hotkey, "(see the facts)")} under the vault's coldkey, which the vault doesn't list, and the vault's counted stake didn't fall by it: a stranger's transfer_stake (anyone can push stake onto any coldkey; the minimum is about 0.0005 TAO), not a swap, so nothing is held. Its depositors get it through their shares once it is counted: owner, guardian or keeper addHotkey(${or(f.hotkey, "<the hotkey>")}) (the set holds at most 4), then owner removeHotkey(${or(f.hotkey, "<the hotkey>")}, true), which moves the stake onto the stake hotkey (or unstakes dust below the chain's minimum). Not worth a transaction for dust; acknowledge it then. If the counted stake does fall later, stake.divergence takes over with a hold.`,
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
    "The site may be tampered with. Take it down (the cascade-site Worker: roll back its deployment, or remove its route), then check DNS, the build and the Worker. A page whose Content-Security-Policy differs in more than the inline scripts' hashes (those alone are site.stale_lists): compare its header (curl -sI the page) with that page's rules in web/out/_headers of the build deployed; a new host, 'unsafe-inline' or 'unsafe-eval', or a directive or policy gone is tampering until shown otherwise. If a file was over the byte cap and is a legitimate large chunk, raise SITE_MAX_BYTES; if a file stopped a run, that is the CPU limit (Workers Paid, or SITE_FILES_PER_RUN=1), not the byte cap. What Cloudflare itself injects must be approved too, once checked to be Cloudflare's: a script loaded from its host (the Web Analytics beacon) with pnpm site:approved ../web/out --extra-script-hosts <host>, a host one of its /cdn-cgi/ scripts names with --extra-hosts <host>, then redeploy. A script host the bundle merely names (a gateway such as arweave.net or ipfs.io in a dependency) is never approved as a script source by that. The limits of this check: it reads the scripts' text, so an address or host built at run time (by string concatenation, or fetched from elsewhere) isn't seen, and a site that serves the monitor a clean copy and users a tampered one can't be caught from outside.",
  "site.stale_lists": () =>
    "The site was deployed but the monitor's approved lists weren't regenerated (every build changes its inline scripts' hashes). Run pnpm --dir indexer site:approved ../web/out on the exact out/ that was deployed (a rebuild changes every hash), commit, and redeploy the monitor. If nobody deployed the site, treat it as site.integrity: a page now allows an inline script the approved build didn't have.",
  "site.no_approved_lists": () =>
    "The site check is running without approved lists, so it judges nothing. Run pnpm site:approved ../web/out on the build you deploy, review the lists, and redeploy the Worker.",
  "indexer.blind": () => "The monitor can't see a chain and the keeper is holding: fix the RPC (quota, outage, switch URLs).",
  "indexer.logs_omitted": (f) =>
    `The second ${or(f.chainName, "")} RPC served ${or(f.omitted, "a watched log")} that the primary never did, in blocks the tick had already re-read from a node well past them, so the monitor's history and its rules missed them (each is listed above with its block and transaction). Either the primary is pruning or lying, or the second served logs from a fork. Open the transactions on the explorer: if they are real, read the events and act on them as their own alerts would have had you (an admin event: see admin.event), and switch ${f.chain === "base" ? "BASE_LOGS_RPC_URL" : "BITTENSOR_RPC_URL"} (or its _SECRET) to another provider, then redeploy. The tick re-reads only ${f.chain === "base" ? "70" : "400"} blocks back, so a missed log is not added by itself; this alert is re-sent hourly until acknowledged, and resolves by itself once the store holds every log it named.`,
  "indexer.logs_extra": (f) =>
    `The store holds ${or(f.lacking, "a log")} that the second ${or(f.chainName, "")} RPC, ${f.chain === "base" ? "70" : "400"} blocks past them, doesn't serve (listed above). Usually the second node pruned them (a non-archive node) or lags its own log index: check a transaction on the explorer. If the explorer doesn't have it either, the primary served a log that isn't on the chain: treat the primary as compromised (switch ${f.chain === "base" ? "BASE_LOGS_RPC_URL" : "BITTENSOR_RPC_URL"}, then re-check what the rules decided on it). If it is the second node's pruning, set ${f.chain === "base" ? "BASE_LOGS_RPC_URL_2" : "BITTENSOR_RPC_URL_2"} (or its _SECRET) to an archive endpoint.`,
  "indexer.unverified": (f) =>
    `The second ${or(f.chainName, "")} RPC hasn't answered the hourly logs cross-check for ${or(f.for, "hours")}${f.error ? ` (last error: ${f.error})` : ""}, so the primary's logs aren't being verified meanwhile. Check ${f.chain === "base" ? "BASE_LOGS_RPC_URL_2" : "BITTENSOR_RPC_URL_2"}: the public default may be refusing Cloudflare's egress or the batch; set a keyed URL in its _SECRET (another provider than the primary's), then redeploy.`,
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
  "vault.stake_moved": (f) =>
    `The vault moved root stake onto its stake hotkey (moveStake or removeHotkey: owner only${f.sender && f.sender !== "not known yet" ? `, sent by ${f.sender}` : ""}). If it was your own change, acknowledge it. If not, treat the owner key as compromised: guardian pause() the vault, then rotate.`,
  "vault.stake_moved_unexpected": (f) =>
    `Stake was moved ${f.to && f["configured stake hotkey"] && f.to !== f["configured stake hotkey"] ? `to hotkey ${f.to}, which isn't the configured stake hotkey ${f["configured stake hotkey"]} (the vault's stake hotkey was changed first: see the StakeHotkeySet alert)` : `in a large amount (${or(f.asked, "see the facts")}) at once`}. Only the owner can move stake${f.sender && f.sender !== "not known yet" ? ` (sent by ${f.sender})` : ""}. If you didn't, assume the owner key is compromised: guardian pause() the vault now, then rotate; check where the stake sits on taostats${f.to ? ` (https://taostats.io/hotkey/${f.to})` : ""}.`,
  "vault.direct_use": (f) =>
    `Someone used the vault directly on Bittensor (depositDirect, redeemDirect or allowFrontDoorRedeems), which the launch doesn't offer: none is expected. Check the user${f.user ? ` (https://evm.taostats.io/address/${f.user})` : ""}. A direct deposit while the share price is depressed (a hotkey swap: see stake.divergence and price.drop) mints shares cheaply: if the price isn't right, guardian pause() the vault (depositDirect and redeemDirect stop while paused).`,
  "vault.direct_use_large": (f) =>
    `A direct ${f.event?.includes("Redeemed") ? "redeem" : "deposit"} above the size threshold${f.hold === "on" ? ", or while a hold is on (the share price is in doubt)" : ""}. Guardian: pause() the vault until the price is checked (depositDirect and redeemDirect stop while paused). If the price was depressed when a deposit minted, the shares it got are the loss: find the cause (stake.divergence, price.drop) before unpausing, and check the user${f.user ? ` (https://evm.taostats.io/address/${f.user})` : ""}.`,
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
