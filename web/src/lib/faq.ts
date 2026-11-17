import { formatUnits } from "viem";
import { FM_TAO_BY_HAND } from "./add-to-wallet";
import { CANCEL_COOLDOWN_S } from "./cascade/abi";
import { SOURCE_CHAINS, type SourceChainInfo } from "./cascade/chains";
import {
  DELIVERY_TOLERANCE_BPS,
  DELIVERY_VALIDITY_S,
  DEPLOYMENT,
  type Deployment,
  deploymentEntry,
  deploymentStage,
  explorer,
  isV32,
  minUnstakeWei,
  retiredWording,
  sourcePublished,
  type Stage,
} from "./cascade/config";
import { AUDIT_STATUS, type AuditStatus, SITE_LINKS } from "./site";
import { POOL_FEE_PCT, POOL_FEES_TEXT } from "./stake-form";

/** One question. Answers are paragraphs; `[label](https://…)` or `[label](/page/)` makes a link. */
export interface FaqItem {
  id: string;
  q: string;
  a: readonly string[];
  /** Also shown under the Stake and Unstake forms. */
  inApp?: boolean;
  /** A button under the answer: "add-fm-tao" is Add to wallet for ForeverMoney's TAO on Base (AddToWallet.tsx). */
  action?: "add-fm-tao";
}

export interface FaqSection {
  id: string;
  title: string;
  items: readonly FaqItem[];
}

/** Shown at the foot of the FAQ page. Change it whenever an answer changes. */
export const FAQ_UPDATED = "November 16, 2026";

export type { Stage };

/**
 * The numbers the answers quote. When a fee, the claim policy or a limit changes, change it here;
 * faq.test.ts checks them against the contracts (contracts/src), the deployment settings and the
 * keeper's claim policy (ops/src/config.ts) and the site's own constants. The stage comes from the
 * deployment the site is built for (deployments.json).
 */
export const FAQ_FACTS = {
  depositFeeUsd: 0.05,
  swapFeePct: 0.15,
  rewardCutPct: 10,
  /** Hard caps written into the contracts, the unstake request fee's included. */
  caps: { swapFeePct: 0.5, depositFeeUsd: 0.25, rewardCutPct: 20, requestFeeEth: 0.001 },
  /** The front door's cap on deposits in total (an owner setting): 40 TAO at launch. */
  depositCapTao: 40,
  /** Other hard limits written into the contracts, which no owner setting can pass: the payout delay's
   * range, the daily outflow (the larger of a share of the stake and a floor), and one batch's value. */
  hardLimits: { payoutDelayMinH: 1, payoutDelayMaxDays: 7, outflowMaxPct: 50, outflowFloorMaxTao: 100, batchMaxTao: 5_000 },
  /** Uniswap's 0.05% USDC/WETH and 0.3% WETH/TAO pools: the stake form's figure. */
  poolFeePct: POOL_FEE_PCT,
  requestFeeEth: 0.0001,
  /** The fixed costs of a round trip at November 2026 prices (ETH about $1,816): the deposit fee, the
   * request fee (about $0.18) and the measured bridge fee back (about $0.27). */
  requestFeeUsd: 0.18,
  fixedFeesUsd: 0.5,
  minStakeTao: 0.04,
  /** The deployment the site is built for: v3.2 asks for more than v3-launch (config.minUnstakeWei). */
  minUnstakeTao: Number(formatUnits(minUnstakeWei(DEPLOYMENT), 18)),
  /** The most one batch carries (an owner setting). */
  maxBatchTao: 10,
  /** Collect when waiting ≥ multiple × cost, or after everyDays while a claim costs < maxCostUsd and < what's waiting. */
  claim: { costTao: 0.057, multiple: 25, everyDays: 30, maxCostUsd: 20 },
  vestingDays: 7,
  /** The launch cadence pairs a 24-hour payout delay with its 24-hour batch max wait; the test cadence uses 1 hour. */
  payoutDelayH: { launch: 24, test: 1 },
  /** The front door's batch interval each cadence deploys with: anyone may send a batch once it's this old. */
  batchIntervalS: { launch: 3_600, test: 600 },
  registryDelayDays: 7,
  keeperFallbackDays: 7,
  timelockH: 48,
  /** v3.2's own, said only on a v3.2 deployment (faq.test.ts holds them to contracts/src and ops/src/v32/settings.ts):
   * the owner scheduler's waits by kind (a setting that loosens a protection; a new bridge or front door, or turning a
   * switched-off one back on; a new owner or guardian), its hard limits, how long a deposit the vault can't take waits on
   * Bittensor before it goes back to Base, the smallest unstake the vault takes, the cap on a leaver's share of the bridge
   * fee back (the larger of a share of the payout and an amount), and the launch's unstake limits, for a deployment whose
   * entry doesn't list its own. */
  v32: {
    /** R6b (U1, U2): the keeper collects every validator's rewards together at least this often, whatever it costs (ops'
     * CLAIM_GAP_MAX_S less CLAIM_LEAD_S) */
    claimRoundDays: 28,
    delay: { settingH: 48, routeDays: 7, rolesDays: 8 },
    hardLimits: { payoutDelayMinH: 1, payoutDelayMaxH: 48, outflowMinPct: 20, outflowFloorMinTao: 10, outflowMaxPct: 50, outflowFloorMaxTao: 100, batchMaxTao: 5_000 },
    parkDays: 14,
    minRedeemTao: 0.03,
    payoutFeeCap: { pct: 1, tao: 0.015 },
    unstakeLimits: { maxEntryTao: 10, dailyOutflowPct: 20, dailyFloorTao: 10 },
    /** The launch's unstake request fee (SETTINGS_V32_LAUNCH: the founder's 0.0002 ETH, 2026-11-16; v3-launch's is
     * 0.0001), and the round trip's fixed costs with it at the prices above: about $0.36 for it, $0.68 in all. */
    requestFeeEth: 0.0002,
    requestFeeUsd: 0.36,
    fixedFeesUsd: 0.68,
  },
} as const;

/** The unstake request fee a deployment launched with, in ETH, for copy that names it: v3.2's own (FAQ_FACTS.v32), else
 * v3-launch's. The forms say the fee the front door reads now. */
export const requestFeeEth = (v32: boolean): number => (v32 ? FAQ_FACTS.v32.requestFeeEth : FAQ_FACTS.requestFeeEth);

/** What the answers may say about a validator, by its hotkey. A hotkey not listed gets no name or take. */
export const VALIDATORS: Readonly<Record<string, { name: string; takePct: number }>> = {
  "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u": { name: "tao.bot", takePct: 0 },
};

const validatorOf = (hotkey: string | undefined) => (hotkey && Object.hasOwn(VALIDATORS, hotkey) ? VALIDATORS[hotkey] : undefined);

const F = FAQ_FACTS;
const pct = (bps: number) => `${bps / 100}%`;
const list = (xs: readonly string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : (xs[0] ?? ""));

const MINUTE_S = 60;
const HOUR_S = 3_600;
const DAY_S = 86_400;
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** A wait in words: minutes under an hour, hours under 48 hours, then days. Minutes and hours round up,
 * so a limit is never understated; days round to the nearest ("about two days" for 49 hours). With
 * `adjective`, "24-hour". */
export function waitText(s: number, adjective = false): string {
  const [n, unit] =
    s < HOUR_S
      ? [Math.max(1, Math.ceil(s / MINUTE_S)), "minute"]
      : s < 48 * HOUR_S
        ? [Math.ceil(s / HOUR_S), "hour"]
        : [Math.round(s / DAY_S), "day"];
  return adjective ? `${n}-${unit}` : plural(n, unit);
}

const DOCS = {
  bittensor: "https://www.bittensor.com/",
  docs: "https://www.bittensor.com/docs",
  root: "https://www.bittensor.com/docs/guides/root-reborn",
  staking: "https://www.bittensor.com/docs/guides/staking",
  taostats: "https://taostats.io/",
  ccip: "https://docs.chain.link/ccip",
  foreverMoney: "https://forevermoney.ai/",
  report: "https://github.com/Kedawgs/cascade/security/advisories/new",
};

/** What the answers depend on besides the deployment; tests vary them, the site uses the defaults. */
export interface FaqOptions {
  stage?: Stage;
  audit?: AuditStatus;
  chains?: readonly SourceChainInfo[];
  /** v3.2: the owner's reward vesting period, in seconds, as the vault lens reads it (reads.ts readRewardVesting); none
   * until it is read. Every other deployment's is its vault's constant (FAQ_FACTS.vestingDays), whatever this says. */
  vestingS?: number;
  /** v3.2: the running schedule's period, in seconds (the lens's vestingPeriod; 0 before the first claim). After the
   * owner lowers `vestingS` it stays longer until the old schedule ends, so the leaving answer says the longer of the
   * two (Task 60 review, Minor 4). Said only with `vestingS`; ignored on every other deployment. */
  vestingPeriodS?: number;
  /** v3.2: the adoption drip's period while it still runs, in seconds (reads.ts readRewardVesting; 0 once it has ended,
   * or before the first adoption). An adopted gift vests on its own drip, never restarting the claim schedule
   * (Revision 27); after a lowering it can run longer than both of the above, so the leaving answer says the longest
   * of the three. Said only with `vestingS`; ignored on every other deployment. */
  adoptVestingPeriodS?: number;
  /** With `stage` "retired": the stage it was retired from (else its entry's, deployments.json `retiredFrom`). */
  retiredFrom?: Exclude<Stage, "retired">;
  /** Whether the deployment's contract source is published (else its entry's, deployments.json `sourcePublished`).
   * Until it is, no answer calls the contracts public or open source: they say when the code comes. */
  sourcePublished?: boolean;
}

/** Every question, worded for the deployment the site talks to (its stage, batch wait, payout delay, validator and vault). */
export function faqSections(d: Deployment | null = DEPLOYMENT, o: FaqOptions = {}): FaqSection[] {
  const given = o.stage ?? deploymentStage(d);
  // a retired deployment is worded as the stage it was retired from, whose owner and guardian it still has (Task 69
  // retires v3-launch from early), failing closed to testing when its entry doesn't say (config.wordingStage)
  const stage = given === "retired" ? retiredWording(o.retiredFrom ?? deploymentEntry(d)?.retiredFrom) : given;
  // fail closed: the live and early wording only for exactly those stages, the testing wording otherwise
  const liveStage = stage === "live";
  const early = stage === "early";
  const testing = !liveStage && !early;
  const H = F.hardLimits;
  /** The deployment's own unstake limits, when deployments.json lists them. */
  const unstakeLimits = deploymentEntry(d)?.unstakeLimits;
  const audit = o.audit ?? AUDIT_STATUS;
  const published = o.sourcePublished ?? sourcePublished(d);
  /** Said in place of "public on GitHub" until the deployment's code is published. */
  const codeComes = `it goes on [GitHub](${SITE_LINKS.github}) once its launch checks are done`;
  const chains = o.chains ?? SOURCE_CHAINS;
  // v3.2's answers (the web copy audit, 2026-11-11): its timelock, the one-day hold, ForeverMoney's pause, the keys, the
  // daily limit and parks. Every other deployment keeps the words that are true of its own contracts.
  // The clarity pass (2026-11-16) reworded v3.2's answers: the direct answer first, one idea to a sentence, a term
  // explained where it is first used. An earlier deployment gets the new shape only where its words were the same
  // and none of them is lost (leaving before a collection, Cascade's fees, the break-even, Send it now, a USDC that
  // doesn't arrive); everywhere else it keeps its wording as it was.
  const v32 = isV32(d);
  const V = F.v32;
  const VH = V.hardLimits;
  /** The request fee the deployment launched with, and the round trip's fixed costs with it: v3.2's own, else v3-launch's. */
  const feeEth = requestFeeEth(v32);
  const feeUsd = v32 ? V.requestFeeUsd : F.requestFeeUsd;
  const fixedUsd = v32 ? V.fixedFeesUsd : F.fixedFeesUsd;
  /** v3.2's unstake limits: the deployment's own when its entry lists them, else the launch's. */
  const lim = unstakeLimits ?? V.unstakeLimits;
  const settingWait = plural(V.delay.settingH, "hour");
  const routeWait = plural(V.delay.routeDays, "day");
  const rolesWait = plural(V.delay.rolesDays, "day");

  const launch = Boolean(d?.batchMaxWaitS);
  const batchWaitS = d?.batchMaxWaitS ?? 0;
  const payoutDelayS = d?.payoutDelayS ?? (launch ? F.payoutDelayH.launch : F.payoutDelayH.test) * HOUR_S;
  /** The batch's longest wait, the payout delay, and about an hour for the crossings and the sale. */
  const exitS = batchWaitS + payoutDelayS + HOUR_S;

  const validator = validatorOf(d?.hotkeySs58);
  const validatorName = validator?.name ?? "Cascade's validator";
  const validatorUrl = d ? `https://taostats.io/validators/${d.hotkeySs58}` : "https://taostats.io/validators";
  const stakeUrl = d ? explorer.account(d.vaultSs58) : DOCS.taostats;

  const live = chains.filter((c) => c.status === "live").map((c) => c.label);
  const soon = chains.some((c) => c.status === "soon");
  /** " on Base", or nothing while no chain is live. */
  const onLive = live.length > 0 ? ` on ${list(live)}` : "";
  /** " to Base", or nothing while no chain is live. */
  const toLive = live.length > 0 ? ` to ${list(live)}` : "";
  /** The smallest unstake the answered deployment's form takes (v3.2's asks 0.033 TAO, v3-launch's 0.011). */
  const minUnstakeTao = Number(formatUnits(minUnstakeWei(d), 18));

  // round-figure helpers for the answers
  const ceilingUsd = Math.floor(F.claim.maxCostUsd / F.claim.costTao / 10) * 10;
  // rounded to the nearest percent (floored, 7.9% was shown as "about 7%")
  const fixedShareOf10 = Math.round((fixedUsd / 10) * 100);
  // the reward vesting period: v3-launch's vault has it as a constant (7 days); v3.2's owner sets it, 1 to 30 days, so
  // the answers say the lens's reading, or no figure at all before it is read (Task 58 concern 5; Task 60)
  const vestingS = isV32(d) ? o.vestingS : F.vestingDays * DAY_S;
  const vestingKnown = vestingS !== undefined && Number.isFinite(vestingS) && vestingS > 0;
  const vestingOver = vestingKnown ? `over ${waitText(vestingS)}` : "over a period Cascade sets, from 1 to 30 days";
  // leaving: what is still being added follows the running schedule, which stays longer than the owner's period after a
  // lowering until it ends (the lens's vestingPeriod), and an adopted gift's own drip while it runs (Revision 27), so
  // the longest of the three (Task 60 review, Minor 4)
  const running = isV32(d) && o.vestingPeriodS !== undefined && Number.isFinite(o.vestingPeriodS) ? o.vestingPeriodS : 0;
  const adopting = isV32(d) && o.adoptVestingPeriodS !== undefined && Number.isFinite(o.adoptVestingPeriodS) ? o.adoptVestingPeriodS : 0;
  const leavingS = vestingKnown ? Math.max(vestingS, running, adopting) : undefined;
  const addedOver = leavingS !== undefined ? `over ${waitText(leavingS)}` : "over a period Cascade sets (1 to 30 days)";
  const leaveBound =
    leavingS !== undefined ? `up to about ${Math.round((F.claim.everyDays * DAY_S + leavingS) / (7 * DAY_S))} weeks of yield` : "up to about a month of yield plus that period";

  return [
    {
      id: "tao",
      title: "TAO and staking",
      items: [
        {
          id: "what-is-tao",
          q: "What is TAO?",
          a: [
            `TAO is the token of [Bittensor](${DOCS.bittensor}), an open network that pays TAO to the people running useful AI work on it. You can stake TAO with a validator, whose stake decides how the network's rewards are shared, and earn more TAO in return.`,
          ],
        },
        {
          id: "what-is-root-staking",
          q: "What is root staking?",
          a: [
            // v3.2 has waits of its own (the one-day hold, the daily limit), so it says "no lock-up" of Bittensor only
            // and sends the reader to Cascade's waits
            `Staking means putting TAO with a validator, an operator that helps run the network, in return for a share of the TAO the network pays out. ${
              v32 ? "Bittensor itself has no lock-up; Cascade's own waits are in [Is there a lock-up?](/faq/#lock-up)." : "There's no lock-up."
            } Staked directly, your TAO stays under your own key; through Cascade, its vault stakes the TAO and you hold shares in the vault.`,
            `Cascade stakes on Bittensor's root network, which earns from across the subnets instead of betting on one. [How root staking works](${DOCS.root}).`,
          ],
        },
        {
          id: "what-is-cascade",
          q: "What does Cascade do?",
          inApp: true,
          a: [
            `Cascade gets you TAO staking from the wallet you already use. You deposit USDC${onLive}; Cascade swaps it to TAO, carries it to Bittensor over [Chainlink CCIP](${DOCS.ccip}) and stakes it for you. Unstaking does the reverse and sends USDC back to your wallet.`,
          ],
        },
        {
          id: "bittensor-wallet",
          q: "Do I need a Bittensor wallet?",
          inApp: true,
          a: [
            `No. Everything happens from your wallet${onLive}, such as MetaMask, Coinbase Wallet or Rabby. You only need a little ETH there for network fees and the ${feeEth} ETH unstake fee.`,
          ],
        },
        {
          id: "tao-or-dollars",
          q: "Is my balance in TAO or dollars?",
          a: [
            "TAO. Your USDC becomes TAO, so your balance grows with staking rewards and its dollar value rises and falls with TAO's price. If TAO falls, you can get back less USDC than you put in.",
          ],
        },
        {
          id: "validator",
          q: "Which validator stakes my TAO?",
          a: [
            validator
              ? `[${validator.name}](${validatorUrl}), a validator on Bittensor's root network. It keeps ${validator.takePct}% of rewards for itself. Cascade can move the stake to another validator${v32 ? `, with ${settingWait}' public notice` : " if that ever changes"}; the move needs no unstaking and costs you nothing.`
              : `Cascade's validator, on Bittensor's root network: [Taostats](${validatorUrl}) shows which one it is and what it keeps. Cascade can move the stake to another validator${v32 ? `, with ${settingWait}' public notice` : ""}; the move needs no unstaking and costs you nothing.`,
          ],
        },
        {
          id: "token",
          q: "Do I get a token?",
          a: [
            // v3.2: the answer first, and the shares' owner is the address a deposit names (a gift's is not the wallet
            // that paid for it)
            v32
              ? "Not one you can send or trade. Your deposit is recorded as shares in Cascade's vault on Bittensor, shown in the app as your TAO balance. Only the wallet the shares belong to can unstake them."
              : "Your deposit is recorded as shares in Cascade's vault on Bittensor, shown in the app as your TAO balance. The shares can't be sent or traded; only the wallet that deposited can unstake them.",
          ],
        },
        {
          id: "learn-more",
          q: "Where can I learn more?",
          a: [
            `[Bittensor's docs](${DOCS.docs}) explain the network, and [how staking works](${DOCS.staking}). [Taostats](${DOCS.taostats}) shows live network data and validators. [Chainlink CCIP](${DOCS.ccip}) is the bridge that carries TAO ${live.length > 0 ? `between ${list(live)} and Bittensor` : "to and from Bittensor"}.`,
          ],
        },
      ],
    },
    {
      id: "rewards",
      title: "Rewards and APY",
      items: [
        {
          id: "apy",
          q: "Where does the APY come from?",
          a: [
            `It's what root staking with ${validatorName} earned over the last 30 days, read straight from the validator's on-chain record on Bittensor, after its own fee and Cascade's ${F.rewardCutPct}% cut, assuming rewards are collected and restaked monthly (they may be collected less often).`,
            "It's a yield in TAO, before deposit and withdrawal costs, and it changes with the network. Past yield isn't a promise.",
          ],
        },
        {
          id: "how-rewards-arrive",
          q: "How do rewards reach my balance?",
          a: [
            "Rewards build up at the validator as small amounts of each subnet's token. When Cascade collects them, they're turned into TAO and staked again.",
            `Cascade keeps ${F.rewardCutPct}%. The other ${100 - F.rewardCutPct}% is added to balances gradually ${vestingOver}, so it goes only to people still staked as it's added. Someone who joins just before a collection still shares in it; someone who leaves before it's added leaves it behind.`,
          ],
        },
        {
          id: "how-often-collected",
          q: "How often are rewards collected?",
          a: [
            ...(v32
              ? [
                  // R6b (U1, U2): one round for every validator, at least every claimRoundDays, whatever it costs
                  `Each collection costs about ${F.claim.costTao} TAO in network fees, paid by Cascade. Cascade collects every validator's rewards together at least every ${F.v32.claimRoundDays} days, and sooner once the rewards waiting are worth at least ${F.claim.multiple} times that.${testing ? " During testing they're run by hand." : ""}`,
                ]
              : [
                  `Each collection costs about ${F.claim.costTao} TAO in network fees, paid by Cascade, so Cascade waits until it's worth it: when the rewards waiting are worth at least ${F.claim.multiple} times that, or after ${F.claim.everyDays} days as long as more than that is waiting and a collection costs under $${F.claim.maxCostUsd}.`,
                  `While little is staked, or if TAO rises above about $${ceilingUsd} (a collection then costs over $${F.claim.maxCostUsd}), collections can be many months apart.${testing ? " During testing they're run by hand." : ""}`,
                ]),
            "Until they're collected, rewards are held as subnet tokens, so their value in TAO can rise or fall, and if you unstake first you leave them behind. [Rewards](/rewards/) shows what's waiting for you.",
          ],
        },
        {
          id: "leave-before-collection",
          q: "What if I unstake before rewards are collected?",
          a: [
            // the answer first, then the two kinds of reward left behind: not collected yet, and collected but still
            // being added to balances
            `You leave them behind. Rewards still waiting to be collected stay with the people who remain staked. So do collected rewards that are still being added to balances ${addedOver}.`,
            `With monthly collections that's ${leaveBound}. While collections are rarer, it can be more.`,
          ],
        },
      ],
    },
    {
      id: "fees",
      title: "Fees",
      items: [
        {
          id: "cascade-fees",
          q: "What does Cascade charge?",
          inApp: true,
          a: [
            // by what you do: staking, unstaking, earning. The request fee goes into its batch's fee pot, which pays the
            // bridge fee for the trip to Bittensor
            `Staking: $${F.depositFeeUsd.toFixed(2)} plus ${F.swapFeePct}%. Unstaking: a ${feeEth} ETH request fee, which goes toward the bridge fee that carries your request to Bittensor, plus ${F.swapFeePct}% when your TAO is sold back to USDC. Rewards: ${F.rewardCutPct}% of staking rewards when they're collected.`,
            `Each fee has a cap in the contracts: ${F.caps.swapFeePct}% per swap, $${F.caps.depositFeeUsd.toFixed(2)} per deposit, ${F.caps.rewardCutPct}% of rewards, and ${F.caps.requestFeeEth} ETH for the request fee.`,
            `Whatever the settings, a trade Cascade makes for you never goes below the minimum you approve. When you stake, that is the least TAO shown. When you unstake, it is today's price less ${pct(DELIVERY_TOLERANCE_BPS)}.`,
          ],
        },
        {
          id: "other-costs",
          q: "What other costs are there?",
          a: v32
            ? [
                // the list first, then each cost; v3.2 caps a leaver's share of the bridge fee back (over the cap the
                // leaver pays no more, and the payout waits for a lower fee or for Cascade to pay the rest: it is not
                // promised that Cascade pays), and its vault's unstaking cost comes out of the payout
                `Swap fees, network fees and, when you unstake, a request fee and a bridge fee. Uniswap, the exchange that does the swap, charges pool fees of ${POOL_FEES_TEXT} each way. On top of that comes price impact, which grows with the amount: a larger swap gets a worse price. Network fees${onLive} are usually a cent or two.`,
                `Cascade pays the bridge fee that carries deposits to Bittensor. To unstake, you pay the ${feeEth} ETH request fee and the bridge fee that carries your TAO back${toLive}. That bridge fee is taken from your TAO and shared when several people unstake together. Your share of it is capped at ${V.payoutFeeCap.pct}% of the payout or ${V.payoutFeeCap.tao} TAO, whichever is larger. If the fee is ever higher than that, you pay no more. The payout waits until the fee falls or Cascade pays the difference.`,
                "If the vault, Cascade's contract on Bittensor, has to unstake to pay you, the small amount the network keeps comes out of your payout too. The form shows an estimate before you confirm.",
              ]
            : [
                `Uniswap's pool fees, ${POOL_FEES_TEXT} each way plus price impact, which grows with the amount, and network fees${onLive}, usually a cent or two. Cascade pays the bridge fee that carries deposits to Bittensor.`,
                `To unstake there's a ${feeEth} ETH request fee, and the bridge fee for the trip back, taken from your TAO and shared when several people unstake together. Every amount is shown before you confirm.`,
              ],
        },
        {
          id: "break-even",
          q: "How long until rewards cover the costs?",
          a: [
            // the answer first (it depends, and the form works it out), then the round trip's costs, then what the fixed
            // ones do to a small stake
            "It depends on the amount. The stake form shows how long your amount takes to cover its fees at today's yield.",
            `A round trip, staking and later unstaking, costs about 1%, plus fixed fees of about $${fixedUsd.toFixed(2)} all in. The fixed fees are the $${F.depositFeeUsd.toFixed(2)} deposit fee, the ${feeEth} ETH request fee (about $${feeUsd.toFixed(2)}) and the bridge fee back.`,
            `Those fixed fees are about ${fixedShareOf10}% of a $10 stake. So a small amount staked briefly can come back as less than you put in, even if TAO's price doesn't move.`,
          ],
        },
      ],
    },
    {
      id: "timing",
      title: "Staking and unstaking",
      items: [
        {
          id: "how-long-to-stake",
          q: "How long until my deposit is staked?",
          inApp: true,
          a:
            launch && v32
              ? [
                  // the longest it normally takes first ("normally": a pause, or a deposit the vault can't take yet, makes
                  // it longer, as "What if my deposit can't be delivered?" says), then why: a batch is explained where it
                  // is first named, and v3.2 credits the balance on arrival
                  `Normally up to ${waitText(batchWaitS)}, plus about 20 minutes to cross. The stake form shows the expected time, and your receipt follows each step.`,
                  `Deposits travel to Bittensor together in groups called batches, so each batch shares one bridge fee. A batch leaves once the fees it carries cover the trip, and after ${waitText(batchWaitS)} at the latest. It then takes about 20 minutes to cross. Your balance is credited as soon as it arrives.`,
                ]
              : [
                  launch
                    ? `Deposits travel to Bittensor together in batches, which shares the bridge fee. A batch leaves once the fees it carries cover the trip, and after ${waitText(batchWaitS)} at the latest. It then takes about 20 minutes to cross and is staked straight away.`
                    : "Deposits travel to Bittensor together in batches that leave every few minutes, then take about 20 minutes to cross and are staked straight away. Most deposits are staked within the hour.",
                  "The stake form shows the expected time, and your receipt follows each step.",
                ],
        },
        {
          id: "send-sooner",
          q: "Can I make my deposit leave sooner?",
          a: launch
            ? [
                // when and how first; what it costs, and what happens if you don't, second
                `Yes, a few minutes after its batch is ${waitText(F.batchIntervalS.launch)} old. A batch is the group of deposits that travels to Bittensor together. From then, you can choose Send it now, on the Stake page or on the deposit's receipt, to send the batch at once.`,
                `You pay the whole batch's bridge fee in ETH, usually a dollar or two. Anything extra is refunded. If you don't, the batch leaves on its own within ${waitText(batchWaitS)}, or sooner once its fees cover the bridge fee.`,
              ]
            : ["There's no need: batches leave on their own every few minutes, as soon as they can."],
        },
        // v3.2 only: a batch the vault can't take is parked on Bittensor, then refunded to Base (the web copy audit, M4)
        ...(v32
          ? [
              {
                id: "deposit-not-delivered",
                q: "What if my deposit can't be delivered?",
                a: [
                  `If your deposit reaches Bittensor but the vault can't take it (for example during a pause), it waits there, set aside for you, and is delivered as soon as it can be. If it still can't be delivered after ${plural(V.parkDays, "day")}, it is sent back to Base as TAO for you to claim, and Cascade pays that bridge fee. Until your batch leaves Base you can also just cancel. One rare case: if Bittensor raised its minimum stake above the size of a small deposit, a refund that small could wait until the minimum comes back down.`,
                ],
              },
            ]
          : []),
        {
          id: "how-to-unstake",
          q: "How do I unstake, and how long does it take?",
          inApp: true,
          a: v32
            ? [
                // how, and how long, first; then the trip a step to a sentence, the price the sale is held to, and a
                // request v3.2's vault can't process (its one-day hold, its daily limit, a bridge that can't send payouts:
                // the same three as "Why wasn't my unstake processed", never "on hold", which a pause is too, and under a
                // pause the request waits)
                `Open [Unstake](/unstake/) and enter how much USDC you want. All in, it can take up to about ${waitText(exitS)}, usually less. The form shows the expected time.`,
                `Your request travels to Bittensor in the next batch, a group sent together.${
                  payoutDelayS > 0 ? ` It then waits out a ${waitText(payoutDelayS, true)} waiting period. After that your TAO comes back` : " Your TAO then comes back"
                }${toLive}, where it's sold for USDC and the USDC is sent to your wallet.`,
                `The sale is made at today's price less ${pct(DELIVERY_TOLERANCE_BPS)} or better. If TAO falls further than that, your TAO waits for you to claim it instead.`,
                "If your request can't be processed when it arrives, nothing is taken from your stake. That happens when your deposit is less than a day old, the day's limit is used up, or the bridge can't send payouts. You ask again later, and the request fee is paid again.",
              ]
            : [
                `Open [Unstake](/unstake/) and enter how much USDC you want. Your request travels to Bittensor in the next batch${payoutDelayS > 0 ? `, waits out a ${waitText(payoutDelayS, true)} waiting period,` : ""} and comes back${toLive}, where it's sold for USDC and sent to your wallet at today's price less ${pct(DELIVERY_TOLERANCE_BPS)} or better. If TAO falls further, it waits for you to claim it instead.`,
                `All in, it can take up to about ${waitText(exitS)}, usually less. The form shows the expected time.`,
              ],
        },
        // v3.2 only: the one-day hold on new shares, the shared daily limit, and a deferred or trimmed unstake (the web
        // copy audit, M1, M2 and M8)
        ...(v32
          ? [
              {
                id: "unstake-after-deposit",
                q: "Can I unstake right after I deposit?",
                inApp: true,
                a: [
                  // the hold, a second deposit inside it, and a request made too early (which costs its request fee), a
                  // paragraph each. The held shares have one clock, the share-weighted mean of their mints' times
                  // (CascadeShares.addFresh): a top-up inside the day moves it for all of them, a large one nearly to now.
                  // So a share is "past its day" or not, never "held for more than a day"
                  "Not through Base for about a day. Shares from a new deposit are held for a day before they can be unstaked through Base. Shares already past their day aren't affected.",
                  "If you deposit again while an earlier deposit is still inside its day, the day is counted from a blend of the two, weighted by size. A small top-up barely moves it, and a large one nearly restarts it.",
                  "A request made too early isn't processed: you keep your stake and ask again, and the request fee is paid again. With a regular wallet you can [withdraw on Bittensor](/unstake/bittensor/) without the wait.",
                ],
              },
              {
                id: "daily-limit",
                q: "What is the daily unstake limit?",
                a: [
                  `Unstakes through Base are limited to ${lim.dailyOutflowPct}% of the staked TAO a day, or ${lim.dailyFloorTao} TAO if that's more, shared by everyone, first come first served. One request can take at most ${lim.maxEntryTao} TAO. If the day's allowance is used up before your request arrives, the rest stays staked and you ask again, paying the request fee again. The Unstake form shows roughly how much is left today; it's a guide, not a reservation, because others may get there first. Withdrawing directly on Bittensor has no limit.`,
                ],
              },
              {
                id: "unstake-not-processed",
                q: "Why wasn't my unstake processed, or why was it smaller than I asked?",
                inApp: true,
                a: [
                  // the three usual reasons (the least the vault unstakes through Base sits under the form's minimum, which
                  // leaves room for it: config.MIN_UNSTAKE_WEI), then the one hold that drops a request too (the bridge
                  // can't send payouts: ForeverMoney's pause or move), then what a dropped request means for you. Last, the
                  // holds under which a request waits instead (a pause, a validator key change, the route switched off):
                  // there the reader is told not to ask again, so this answer names the two kinds itself and doesn't link
                  // to the lock-up answer's list, which has both
                  `Usually for one of three reasons. Your deposit was less than a day old. The day's limit, or the ${lim.maxEntryTao} TAO limit per request, was reached, so only part went through. Or the amount was worth less than ${V.minRedeemTao} TAO when it arrived, the least the vault unstakes through Base (the form asks for at least ${minUnstakeTao} TAO to leave room for that).`,
                  "It also happens when a request reaches Bittensor while the bridge can't send payouts. That is the case while ForeverMoney is paused or moving to new contracts.",
                  "In each case what wasn't unstaked is still yours and still staked; ask again later. The request fee isn't refunded.",
                  "An emergency pause, a validator key change or Cascade's route being switched off is different. Your request waits. Don't ask again unless your receipt says it was dropped.",
                ],
              },
            ]
          : []),
        {
          id: "lock-up",
          q: "Is there a lock-up?",
          inApp: true,
          a: v32
            ? [
                // the answer first, the time an unstake takes named by its link, never "above"; then Cascade's own holds,
                // then the two that come from outside it (under ForeverMoney's pause or move unstakes through Base
                // "stop": a request made then isn't processed, where under a key change it waits), then the way out that
                // skips most of them
                "No fixed lock-up. But a new deposit can't be unstaked through Base for about a day after it's staked. After that you can unstake whenever you like; it takes the time given in [How do I unstake](/faq/#how-to-unstake) to come back.",
                `A few things can make an unstake wait. The daily unstake limit: anything over it stays staked, for you to unstake again later. An emergency pause: it holds unstakes for as long as it lasts. Cascade's route being switched off: turning it back on takes at least ${routeWait}' public notice. The route is the bridge and front door your TAO travels through.`,
                "Two things outside Cascade can also make it wait. If ForeverMoney, which issues the TAO used on Base, pauses or announces a move to new contracts, unstakes through Base stop until that is resolved, and you keep your stake. If the validator changes its key, unstakes wait until the new key is listed, which Cascade or, failing that, anyone can do.",
                "In most of these cases a regular wallet can still [withdraw on Bittensor](/unstake/bittensor/).",
              ]
            : [
                `No. You can unstake whenever you like; it just takes the time above to come back. Only three things hold an unstake back: the daily unstake limit, which leaves anything over it staked for you to unstake again later; an emergency pause, for as long as it lasts; and the guardian switching off Cascade's route, which takes at least ${F.registryDelayDays} days' public notice to undo.`,
              ],
        },
        {
          id: "usdc-not-arrived",
          q: "What if my USDC doesn't arrive?",
          a: [
            // what you can do first; then what Claim as USDC does and costs; then the other choice, and that a pause
            // doesn't stop either
            `You can claim it yourself from your receipt. If the USDC hasn't arrived an hour after your TAO is back, or the price has fallen below your minimum, your receipt offers Claim as USDC. Your minimum price, the one you approved when you unstaked, holds for ${DELIVERY_VALIDITY_S / DAY_S} days.`,
            `Claim as USDC sends the TAO to your wallet and sells it on Uniswap at the current price. That price may be below your minimum. Your wallet also asks you to let Uniswap spend that amount of TAO. You pay the network fees${onLive}, and Cascade's ${F.swapFeePct}% doesn't apply.`,
            `You can keep it as TAO instead. TAO already back${onLive} can be claimed even while Cascade is paused.`,
          ],
        },
        {
          id: "cancel",
          q: "Can I cancel?",
          a: v32
            ? [
                // v3.2 (R11): the front door's cancel cooldown, CANCEL_COOLDOWN after the last deposit to the entry, anyone's;
                // build B: none while the door is paused (cancelableAt 0). A batch is explained where it is first named,
                // and a batch that leaves inside the cooldown takes the deposit with it: there was never a moment to cancel
                "Yes, until your batch leaves. Deposits and unstake requests travel to Bittensor in groups, called batches.",
                `A deposit can be cancelled from ${CANCEL_COOLDOWN_S / 60} minutes after you make it. If more is deposited for your address before the batch leaves, by you or as a gift from someone else, the ${CANCEL_COOLDOWN_S / 60} minutes start again. If the batch leaves within those ${CANCEL_COOLDOWN_S / 60} minutes, the deposit can no longer be cancelled. While deposits are paused, it can be cancelled at once. A cancelled deposit comes back as TAO, not USDC, and the fees already paid aren't refunded.`,
                "If you cancel an unstake, you keep your balance but not the request fee.",
              ]
            : [
                "Yes, until your batch leaves. A cancelled deposit comes back as TAO, not USDC, and the fees already paid aren't refunded. A cancelled unstake keeps your balance but not the request fee.",
              ],
        },
        {
          id: "limits",
          q: "Is there a minimum or a maximum?",
          a:
            v32 && early
              ? [
                  // v3.2 at the launch: the answer first, then the smallest amounts, the limits on deposits, the limits
                  // on unstakes (W14: its entry's, or the launch's while deployments.json lists none) and what happens
                  // over a limit, a paragraph each
                  `Yes, both. The smallest stake is ${F.minStakeTao} TAO (the stake form shows it in dollars). The smallest unstake is ${minUnstakeTao} TAO.`,
                  `Deposits: one batch, the group of deposits that travels to Bittensor together, carries at most ${F.maxBatchTao} TAO. While Cascade is early, total deposits are capped at ${F.depositCapTao} TAO.`,
                  `Unstakes: one unstake carries at most ${lim.maxEntryTao} TAO. Unstakes through Base are also limited to ${lim.dailyOutflowPct}% of the staked TAO a day, or ${lim.dailyFloorTao} TAO if that's more. That daily limit is shared, first come first served.`,
                  "Anything over a limit stays staked. You unstake it again later and pay the request fee again. You are never left with a remainder too small to unstake. Only deposit what you could afford to lose.",
                ]
              : [
                  // the smallest unstake is the answered deployment's own (v3.2's form asks 0.033 TAO, v3-launch's 0.011)
                  `The smallest stake is ${F.minStakeTao} TAO (the stake form shows it in dollars), the smallest unstake ${minUnstakeTao} TAO. One batch carries at most ${F.maxBatchTao} TAO, and ${
                    early
                      ? `while Cascade is early, total deposits are capped at ${F.depositCapTao} TAO.${
                          // v3-launch says its unstake limits only when its entry lists them
                          unstakeLimits
                            ? ` One unstake carries at most ${unstakeLimits.maxEntryTao} TAO, and unstakes through Cascade are limited to ${unstakeLimits.dailyOutflowPct}% of the staked TAO a day, or ${unstakeLimits.dailyFloorTao} TAO if that's more, shared by everyone. Anything over a limit stays staked, and you unstake it again later, paying the request fee again.`
                            : ""
                        } Only deposit what you could afford to lose.`
                      : "while Cascade is new the total it accepts is capped."
                  }`,
                ],
        },
      ],
    },
    {
      id: "safety",
      title: "Risks and control",
      items: [
        {
          id: "audited",
          q: "Has Cascade been audited?",
          a:
            audit === "done"
              ? [`Yes, by an independent firm. Our [security policy](${SITE_LINKS.security}) has the details.`]
              : liveStage
                ? [
                    published
                      ? `Not yet. The contracts have been through repeated reviews and are [public on GitHub](${SITE_LINKS.github}), but no independent audit has been done. One is planned before launch, and its report will be linked here. Until then, only stake what you can afford to lose.`
                      : `Not yet. The contracts have been through repeated reviews, but no independent audit has been done. One is planned before launch, and its report will be linked here. This version's contract code isn't public yet either: ${codeComes}. Until then, only stake what you can afford to lose.`,
                  ]
                : early
                  ? [
                      published
                        ? `Not yet. Cascade has been reviewed many times, and its contracts are [public on GitHub](${SITE_LINKS.github}), but it hasn't had a professional audit yet. Only deposit what you could afford to lose.`
                        : `Not yet. Cascade has been reviewed many times, but it hasn't had a professional audit yet. This version's contract code isn't public yet either: ${codeComes}. Only deposit what you could afford to lose.`,
                    ]
                  : ["Not yet. Cascade is in testing and hasn't been independently audited, so we don't recommend depositing yet."],
        },
        {
          id: "who-controls",
          q: "Who controls Cascade?",
          a:
            v32 && early
              ? [
                  // v3.2 at the launch, the answer first (the founder, one hardware wallet), then a paragraph to each of: who
                  // holds the keys and what the guardian is, what the owner can change and how long each change waits (the
                  // swap fee, the deposit fee and the request fee don't wait: they change at once, up to their caps, as
                  // "Can Cascade take my funds?" says), what a pause holds, and the hard limits no setting can pass
                  "The founder, through one hardware wallet. Cascade's contracts are owned by the founder's hardware wallet (a Ledger) on Base and on Bittensor. There is no multisig yet: one hardware wallet owns the contracts. A second key, the guardian, can pause, veto a new route, and switch off the current one. A route is the bridge and front door that TAO travels through. For now the guardian is a second account on the same hardware wallet, so it is not an independent check yet. The guardian can never move anyone's money.",
                  `The owner key can change settings: fees up to their caps, the limits, the wait before payouts and the validator. The swap fee, the deposit fee and the request fee can change at once, up to their caps. Other changes that loosen a protection can't happen at once. They are announced on-chain first and wait: ${settingWait} for a setting (a higher limit, a higher reward cut, a shorter waiting period, a different validator), ${routeWait} for a new bridge or front door, and ${rolesWait} for a new owner or guardian. Turning a route back on takes the same ${routeWait}' public notice as a new one. Changes that tighten a protection, and a pause, take effect at once.`,
                  "Cascade can also pause in an emergency. A pause can't move anyone's funds. Pausing the front door, Cascade's contract on Base, stops new deposits and the automatic sale to USDC. You can still ask to unstake, cancel, and claim TAO that's already back. Pausing the vault, Cascade's contract on Bittensor, holds everything until it's lifted: deposits on their way wait, payouts wait, and direct withdrawals stop.",
                  `Whatever the owner does, hard limits in the contracts hold. Every fee has a fixed maximum. The wait before a payout stays between ${plural(VH.payoutDelayMinH, "hour")} and ${plural(VH.payoutDelayMaxH, "hour")}. No batch can carry more than ${VH.batchMaxTao.toLocaleString("en-US")} TAO. The daily unstake limit can't be set below ${VH.outflowMinPct}% of the staked TAO (or ${VH.outflowFloorMinTao} TAO) or above ${VH.outflowMaxPct === 50 ? "half" : `${VH.outflowMaxPct}%`} of it (or ${VH.outflowFloorMaxTao} TAO).`,
                ]
              : [
                  v32
                    ? "An owner key can change settings: fees up to their caps, the limits, the wait before payouts and the validator. Cascade can also pause in an emergency. Pausing the front door on Base stops new deposits and the automatic sale to USDC; you can still ask to unstake, cancel, and claim TAO that's already back. Pausing the vault on Bittensor holds everything until it's lifted: deposits on their way wait, payouts wait, and direct withdrawals stop. A pause can't move anyone's funds."
                    : `An owner key can change settings: fees up to their caps, the limits, the wait before payouts and the validator. It can also pause deposits and unstakes in an emergency. A pause can't move anyone's funds, but it holds exits until it's lifted; cancelling a batch that hasn't left and claiming TAO already back${onLive} keep working.`,
                  ...(liveStage
                    ? [
                        v32
                          ? `The owner is a multi-signature wallet. Changes that loosen a protection wait in public: ${settingWait} for a setting, ${routeWait} for a new bridge or front door, ${rolesWait} for a new owner or guardian. Tightenings and pauses are immediate.`
                          : `The owner is a multi-signature wallet, and its changes wait out a ${F.timelockH}-hour public delay.`,
                      ]
                    : early
                      ? [
                          // v3-launch at its launch (v3.2's early wording is the branch above)
                          `Cascade's contracts are owned by the founder's hardware wallet (a Ledger) on Base and on Bittensor. A separate emergency key, the guardian, can pause deposits and unstakes, veto a new route, and switch off the current one; turning a route back on takes the same ${F.registryDelayDays} days' public notice as a new one. The guardian can never move anyone's money.`,
                          `There is no multisig or timelock yet, so a settings change takes effect at once, and the riskiest settings move only within hard limits written into the contracts: every fee has a fixed maximum, the wait before a payout stays between ${plural(H.payoutDelayMinH, "hour")} and ${plural(H.payoutDelayMaxDays, "day")}, no batch can be set to carry more than ${H.batchMaxTao.toLocaleString("en-US")} TAO, and unstakes through Cascade take at most ${H.outflowMaxPct === 50 ? "half" : `${H.outflowMaxPct}% of`} the staked TAO a day (or ${H.outflowFloorMaxTao} TAO, if that's more).`,
                        ]
                      : [
                          // v3.2's contracts hold a change that loosens a protection to its wait at every stage
                          v32
                            ? `Cascade is in testing: one team key holds every role. Changes that loosen a protection still wait in public: ${settingWait} for a setting, ${routeWait} for a new bridge or front door, ${rolesWait} for a new owner or guardian; tightenings and pauses are immediate. The plan for the public launch is a multi-signature owner.`
                            : `Cascade is in testing: one team key holds every role, and its changes take effect at once. The plan for the public launch is a multi-signature owner, with changes behind a ${F.timelockH}-hour public delay.`,
                        ]),
                ],
        },
        // v3.2 only: the timelock's waits, and the stolen-keys residual while one hardware wallet holds both keys (the web
        // copy audit, M5 and M6; M6 only at the early stage, the one it describes)
        ...(v32
          ? [
              {
                id: "change-notice",
                q: "How much notice do changes get?",
                a: [
                  `Changes that loosen a protection are announced on-chain and wait before they can take effect: ${settingWait} for a setting, ${routeWait} for a new bridge or front door or for turning a switched-off one back on, ${rolesWait} for a new owner or guardian. The guardian can cancel most of them during the wait. Changes that tighten a protection, and a pause, apply at once. The [security page](/security/) shows any change that is waiting.`,
                ],
              },
            ]
          : []),
        ...(v32 && early
          ? [
              {
                id: "stolen-keys",
                q: "What if Cascade's keys were stolen?",
                a: [
                  // the answer first (not taken at once, but exits could be frozen), then what both keys allow during the
                  // notice, then the way out that needs neither and what it means for a depositor
                  `A thief could not take the staked TAO at once, but could freeze exits. The owner key and the guardian key sit on one hardware wallet for now, so a thief who copied it would have both. Sending the staked TAO anywhere new needs ${routeWait}' public notice.`,
                  "With both keys the thief could pause, which freezes exits without moving funds. And during the notice, the daily limit means only part of the stake can leave through Base. In the worst case we've modelled, that part is about a third. It could be little or none if the thief fills the queue with their own requests.",
                  "A regular wallet can withdraw on Bittensor directly, with no limit, unless the vault is paused. This is the main reason to deposit only what you could afford to lose until the owner is a multi-signature wallet.",
                ],
              },
            ]
          : []),
        {
          id: "take-funds",
          q: "Can Cascade take my funds?",
          a: [
            // v3.2 names the two ways to unstake in that notice: through Base, within its daily limit, or directly on
            // Bittensor (the site offers that way out only on v3.2)
            `Not instantly, and not quietly. TAO leaves the vault only through the bridge and front door set up at launch, or when a share owner withdraws directly on Bittensor. Adding a new route needs ${F.registryDelayDays} days' public notice, in which the guardian can veto it and you have time to unstake if you disagree${
              v32 ? ", through Base within the daily limit or directly on Bittensor with a regular wallet" : ""
            }.${
              testing
                ? " During testing one key holds every role, so that veto isn't independent yet."
                : early
                  ? " The guardian is a separate key from the owner, but Cascade holds both for now, so that veto isn't independent yet."
                  : ""
            }`,
            liveStage
              ? "Every fee is capped in the code, and you see each one before you confirm. Everything happens on-chain where anyone can check it."
              : v32
                ? `Every fee is capped in the code, and you see each one before you confirm. Raising the reward cut takes ${settingWait}' public notice. The swap fee, the deposit fee and the unstake request fee can change at once, but only up to their caps, and the minimum price you approve still protects each swap. Everything happens on-chain where anyone can check it.`
                : "Every fee is capped in the code, and you see each one before you confirm. With no timelock yet, the reward cut and the fee on selling back to USDC can still rise to their caps after you stake, but the minimum price you approve still protects each swap. Everything happens on-chain where anyone can check it.",
          ],
        },
        {
          id: "risks",
          q: "What are the risks?",
          a: [
            "TAO's price: your balance is TAO, so its dollar value can fall.",
            "Smart contracts: a bug could lose funds, and the contracts aren't independently audited yet.",
            liveStage
              ? v32
                ? `Control: the owner is a multi-signature wallet. Changes that loosen a protection wait in public: ${settingWait} for a setting, ${routeWait} for a new bridge or front door, ${rolesWait} for a new owner or guardian. Tightenings and pauses are immediate. [Who controls Cascade](/faq/#who-controls).`
                : `Control: an owner can change settings within the code's limits after a ${F.timelockH}-hour public delay, and pause in an emergency. [Who controls Cascade](/faq/#who-controls).`
              : early
                ? v32
                  ? `Control: the owner is one hardware wallet, with no multisig yet. Changes that loosen a protection wait ${settingWait} to ${rolesWait} in public; pauses and tightenings are immediate. If that wallet's keys were stolen, exits could be frozen or badly limited. [Who controls Cascade](/faq/#who-controls).`
                  : "Control: the owner is one hardware wallet, with no multisig or timelock yet, so settings change at once, the riskiest only within the contracts' hard limits. [Who controls Cascade](/faq/#who-controls)."
                : v32
                  ? `Control: during testing one team key holds every role. Changes that loosen a protection wait ${settingWait} to ${rolesWait} in public; pauses and tightenings are immediate. [Who controls Cascade](/faq/#who-controls).`
                  : "Control: during testing one team key holds every role, and settings change at once. [Who controls Cascade](/faq/#who-controls).",
            v32
              ? `Bridges: TAO crosses over Chainlink CCIP, and the TAO used${onLive} is issued by [ForeverMoney](${DOCS.foreverMoney}). If either has trouble, deposits and payouts wait. Staked TAO sits on Bittensor and isn't theirs to touch; what depends on ForeverMoney is TAO on Base or on its way, and getting out through Base. If the bridge itself were compromised, forged unstakes are limited to a day's allowance and wait ${waitText(payoutDelayS)} before paying, so they can be cancelled.`
              : `Bridges: TAO crosses over Chainlink CCIP, and the TAO used${onLive} is issued by [ForeverMoney](${DOCS.foreverMoney}). If either has trouble, batches wait, and in a rare migration a batch already on its way could be lost.`,
            v32
              ? "Validator: if the validator moves its stake to a new key, deposits and unstakes wait until that key is listed, which Cascade or, failing that, anyone can do. A direct withdrawal on Bittensor in that window pays the lower price, and only if you agree to it."
              : "Validator: if the validator moves its stake to a new key, balances read low until Cascade adds that key, and unstaking in that window pays less.",
            "Yield: rewards depend on the network and the validator, and can fall.",
            "Delays: if a bridge or Cascade's systems are down, exits take longer. USDC can also be frozen by its issuer for blocked addresses; you'd then claim TAO instead.",
          ],
        },
        {
          id: "if-cascade-is-down",
          q: "What if Cascade's systems go down?",
          a: v32
            ? [
                // the answer first, then each step anyone can take and when (v3.2 opens reward collection only once the
                // rewards already collected have all been added to balances), then what you do yourself
                "Your funds stay where they are, but exits slow down. Most steps that Cascade's systems run can be done by anyone instead.",
                `Anyone can send a batch or a payout once it's due, with a transaction on ${live.length > 0 ? `${list(live)} or Bittensor` : "Bittensor"} that pays its bridge fee or gas. After ${F.keeperFallbackDays} days, anyone can do the staking step. Anyone can collect rewards once the rewards already collected have all been added to balances (up to 30 days).`,
                `Once your TAO is back${onLive} you can claim it yourself from your receipt. Only selling it to USDC for you needs Cascade's systems.`,
              ]
            : [
                `Your funds stay where they are, but exits slow down. Anyone can send a batch or a payout once it's due, with a transaction on ${live.length > 0 ? `${list(live)} or Bittensor` : "Bittensor"} that pays its bridge fee or gas. Staking and reward collection open to anyone after ${F.keeperFallbackDays} days, and once your TAO is back${onLive} you can claim it yourself from your receipt. Only selling it to USDC for you needs Cascade's systems.`,
              ],
        },
        // v3.2 only: ForeverMoney's pause or move (the web copy audit, M3), the way out that needs neither Base nor
        // ForeverMoney (Task 59b; the founder's question, 2026-11-05; the audit's W9), and a validator key change (M7)
        ...(v32
          ? [
              {
                id: "forevermoney-pause",
                q: "What happens if ForeverMoney pauses or moves to new contracts?",
                a: [
                  `The TAO used on Base is issued by ForeverMoney. If they pause, or announce a move to new contracts, Cascade stops processing unstakes through Base from that moment: a request isn't processed, and you keep your stake, so nothing is sent into a route that can't pay. A pause lifts on their side. After a move, unstakes through Base resume once Cascade has a replacement bridge live, which takes at least ${routeWait}' public notice. Meanwhile a regular wallet can [withdraw on Bittensor](/unstake/bittensor/); a contract wallet has to wait. Your staked TAO stays on Bittensor throughout.`,
                ],
              },
              {
                id: "withdraw-on-bittensor",
                q: "Can I withdraw without Base?",
                a: [
                  "Yes, with a regular wallet such as MetaMask, unless the vault is paused. If unstaking through Base ever stops, for example because ForeverMoney's TAO fails, you can [withdraw on Bittensor](/unstake/bittensor/): your stake comes straight from the vault as TAO, to the same address there, with no bridge, no daily limit and no waiting period. You need about 0.02 TAO on Bittensor for the network fee, most of it not spent, and you pay the small cost of unstaking. Contract wallets (smart wallets) can't use it: they have to wait for the Base route.",
                ],
              },
              {
                id: "validator-key-change",
                q: "What if the validator changes its key?",
                a: [
                  "Validators sometimes move to a new key. When that happens the vault sees stake missing and, rather than price anyone's shares low, holds deposits and unstakes until the new key is listed. Cascade lists it; if Cascade is down, anyone can. A direct withdrawal on Bittensor still works in that window if you accept the lower price it would pay.",
                ],
              },
            ]
          : []),
        {
          id: "check-my-stake",
          q: "How can I check my stake?",
          a: [
            `Your balance comes with a live on-chain check, and the vault's stake is public on [Taostats](${stakeUrl}). ${published ? `The code is open source on [GitHub](${SITE_LINKS.github}).` : `This version's code goes on [GitHub](${SITE_LINKS.github}) once its launch checks are done.`}${v32 ? " The [security page](/security/) shows the whole route your money takes, with live numbers." : ""}`,
          ],
        },
        {
          id: "report-a-problem",
          q: "How do I report a problem?",
          a: [
            `Report security issues privately through [GitHub](${DOCS.report}); our [security policy](${SITE_LINKS.security}) says what to include.`,
          ],
        },
      ],
    },
    {
      id: "chains",
      title: "Chains and wallets",
      items: [
        {
          id: "which-chains",
          q: "Which chains and wallets work?",
          a: [
            [
              live.length > 0 ? `${list(live)} today, from MetaMask, Coinbase Wallet, Rabby or any browser wallet.` : "No chain is open for deposits yet.",
              ...(soon ? ["More chains are planned."] : []),
              "On a phone, open Cascade in your wallet app's browser.",
            ].join(" "),
          ],
        },
        {
          id: "tao-on-base",
          q: live.length > 0 ? `What is the TAO on ${list(live)}?` : "What is bridged TAO?",
          a: [
            `If you cancel a deposit or claim by hand, you receive TAO${onLive}. It's a bridged version issued by [ForeverMoney](${DOCS.foreverMoney}) over Chainlink CCIP and backed by TAO it holds on Bittensor${v32 ? ". The [security page](/security/) shows how much backs it right now." : "; it was fully backed when we checked in October 2026."}`,
          ],
        },
        {
          // the founder's words (2026-11-05); v3-launch and v3.2 pay out the same token. The address is the site's config,
          // never typed here (config.ts FM_TAO, through add-to-wallet.ts; add-to-wallet.test.ts)
          id: "see-your-tao",
          q: "See your TAO in your wallet",
          action: "add-fm-tao",
          a: [
            `TAO you claim or cancel back on Base is ForeverMoney's TAO, which many wallets don't show until you add it. Use Add to wallet below, or add it by hand ${FM_TAO_BY_HAND}.`,
          ],
        },
      ],
    },
  ];
}

export const FAQ_SECTIONS: readonly FaqSection[] = faqSections();

/** The short list under the Stake and Unstake forms, in page order. */
export function appFaq(sections: readonly FaqSection[] = FAQ_SECTIONS): FaqItem[] {
  return sections.flatMap((s) => s.items.filter((i) => i.inApp));
}
