import { formatUnits } from "viem";
import { SOURCE_CHAINS, type SourceChainInfo } from "./cascade/chains";
import {
  DELIVERY_TOLERANCE_BPS,
  DELIVERY_VALIDITY_S,
  DEPLOYMENT,
  type Deployment,
  deploymentStage,
  explorer,
  MIN_UNSTAKE_WEI,
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
}

export interface FaqSection {
  id: string;
  title: string;
  items: readonly FaqItem[];
}

/** Shown at the foot of the FAQ page. Change it whenever an answer changes. */
export const FAQ_UPDATED = "October 30, 2026";

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
  /** The fixed costs of a round trip at October 2026 prices (ETH about $2,330): the deposit fee, the
   * request fee (about $0.23) and the measured bridge fee back (about $0.27). */
  requestFeeUsd: 0.23,
  fixedFeesUsd: 0.55,
  minStakeTao: 0.04,
  minUnstakeTao: Number(formatUnits(MIN_UNSTAKE_WEI, 18)),
  /** The most one batch carries (an owner setting). */
  maxBatchTao: 10,
  /** Collect when waiting ≥ multiple × cost, or after everyDays while a claim costs < maxCostUsd and < what's waiting. */
  claim: { costTao: 0.057, multiple: 25, everyDays: 30, maxCostUsd: 20 },
  vestingDays: 7,
  /** The launch cadence pairs a 24-hour payout delay with its 24-hour batch max wait; the test cadence uses 1 hour. */
  payoutDelayH: { launch: 24, test: 1 },
  registryDelayDays: 7,
  keeperFallbackDays: 7,
  timelockH: 48,
} as const;

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
function waitText(s: number, adjective = false): string {
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
}

/** Every question, worded for the deployment the site talks to (its stage, batch wait, payout delay, validator and vault). */
export function faqSections(d: Deployment | null = DEPLOYMENT, o: FaqOptions = {}): FaqSection[] {
  const stage = o.stage ?? deploymentStage(d);
  const testing = stage === "testing";
  const early = stage === "early";
  const H = F.hardLimits;
  const audit = o.audit ?? AUDIT_STATUS;
  const chains = o.chains ?? SOURCE_CHAINS;

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

  // round-figure helpers for the answers
  const ceilingUsd = Math.floor(F.claim.maxCostUsd / F.claim.costTao / 10) * 10;
  const leaveWeeks = Math.round((F.claim.everyDays + F.vestingDays) / 7);
  const fixedShareOf10 = Math.floor((F.fixedFeesUsd / 10) * 100);

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
            "Staking means putting TAO with a validator, an operator that helps run the network, in return for a share of the TAO the network pays out. There's no lock-up. Staked directly, your TAO stays under your own key; through Cascade, its vault stakes the TAO and you hold shares in the vault.",
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
            `No. Everything happens from your wallet${onLive}, such as MetaMask, Coinbase Wallet or Rabby. You only need a little ETH there for network fees and the ${F.requestFeeEth} ETH unstake fee.`,
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
              ? `[${validator.name}](${validatorUrl}), a validator on Bittensor's root network. It keeps ${validator.takePct}% of rewards for itself. Cascade can move the stake to another validator if that ever changes; the move needs no unstaking and costs you nothing.`
              : `Cascade's validator, on Bittensor's root network: [Taostats](${validatorUrl}) shows which one it is and what it keeps. Cascade can move the stake to another validator; the move needs no unstaking and costs you nothing.`,
          ],
        },
        {
          id: "token",
          q: "Do I get a token?",
          a: [
            "Your deposit is recorded as shares in Cascade's vault on Bittensor, shown in the app as your TAO balance. The shares can't be sent or traded; only the wallet that deposited can unstake them.",
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
            `Cascade keeps ${F.rewardCutPct}%. The other ${100 - F.rewardCutPct}% is added to balances gradually over ${F.vestingDays} days, so it goes only to people still staked as it's added. Someone who joins just before a collection still shares in it; someone who leaves before it's added leaves it behind.`,
          ],
        },
        {
          id: "how-often-collected",
          q: "How often are rewards collected?",
          a: [
            `Each collection costs about ${F.claim.costTao} TAO in network fees, paid by Cascade, so Cascade waits until it's worth it: when the rewards waiting are worth at least ${F.claim.multiple} times that, or after ${F.claim.everyDays} days as long as more than that is waiting and a collection costs under $${F.claim.maxCostUsd}.`,
            `While little is staked, or if TAO rises above about $${ceilingUsd} (a collection then costs over $${F.claim.maxCostUsd}), collections can be many months apart.${testing ? " During testing they're run by hand." : ""}`,
            "Until they're collected, rewards are held as subnet tokens, so their value in TAO can rise or fall, and if you unstake first you leave them behind. [Rewards](/rewards/) shows what's waiting for you.",
          ],
        },
        {
          id: "leave-before-collection",
          q: "What if I unstake before rewards are collected?",
          a: [
            `Rewards still waiting, and any still being added over ${F.vestingDays} days, stay with the people who remain. With monthly collections that's up to about ${leaveWeeks} weeks of yield; while collections are rarer, it can be more.`,
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
            `$${F.depositFeeUsd.toFixed(2)} plus ${F.swapFeePct}% when you stake, ${F.swapFeePct}% when your TAO is sold back to USDC, and ${F.rewardCutPct}% of staking rewards when they're collected. To unstake there's also a ${F.requestFeeEth} ETH request fee, which goes toward the bridge fee.`,
            `The contracts cap the first three at ${F.caps.swapFeePct}% per swap, $${F.caps.depositFeeUsd.toFixed(2)} per deposit and ${F.caps.rewardCutPct}% of rewards, and the request fee at ${F.caps.requestFeeEth} ETH. Whatever the settings, a trade never goes below the minimum you approve: the least TAO shown when you stake, and today's price less ${pct(DELIVERY_TOLERANCE_BPS)} when you unstake.`,
          ],
        },
        {
          id: "other-costs",
          q: "What other costs are there?",
          a: [
            `Uniswap's pool fees, ${POOL_FEES_TEXT} each way plus price impact, which grows with the amount, and network fees${onLive}, usually a cent or two. Cascade pays the bridge fee that carries deposits to Bittensor.`,
            `To unstake there's a ${F.requestFeeEth} ETH request fee, and the bridge fee for the trip back, taken from your TAO and shared when several people unstake together. Every amount is shown before you confirm.`,
          ],
        },
        {
          id: "break-even",
          q: "How long until rewards cover the costs?",
          a: [
            `A round trip costs about 1%, plus fixed fees of about $${F.fixedFeesUsd.toFixed(2)} all in: the $${F.depositFeeUsd.toFixed(2)} deposit fee, the ${F.requestFeeEth} ETH request fee (about $${F.requestFeeUsd.toFixed(2)}) and the bridge fee back. That's about ${fixedShareOf10}% of a $10 stake, so a small amount staked briefly can come back as less than you put in, even if TAO's price doesn't move.`,
            "The stake form shows how long your amount takes to cover its fees at today's yield.",
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
          a: [
            launch
              ? `Deposits travel to Bittensor together in batches, which shares the bridge fee. A batch leaves once the fees it carries cover the trip, and after ${waitText(batchWaitS)} at the latest. It then takes about 20 minutes to cross and is staked straight away.`
              : "Deposits travel to Bittensor together in batches that leave every few minutes, then take about 20 minutes to cross and are staked straight away. Most deposits are staked within the hour.",
            "The stake form shows the expected time, and your receipt follows each step.",
          ],
        },
        {
          id: "how-to-unstake",
          q: "How do I unstake, and how long does it take?",
          inApp: true,
          a: [
            `Open [Unstake](/unstake/) and enter how much USDC you want. Your request travels to Bittensor in the next batch${payoutDelayS > 0 ? `, waits out a ${waitText(payoutDelayS, true)} safety delay,` : ""} and comes back${live.length > 0 ? ` to ${list(live)}` : ""}, where it's sold for USDC and sent to your wallet at today's price less ${pct(DELIVERY_TOLERANCE_BPS)} or better. If TAO falls further, it waits for you to claim it instead.`,
            `All in, it can take up to about ${waitText(exitS)}, usually less. The form shows the expected time.`,
          ],
        },
        {
          id: "lock-up",
          q: "Is there a lock-up?",
          inApp: true,
          a: ["No. You can unstake whenever you like; it just takes the time above to come back. Only an emergency pause holds unstakes, for as long as it lasts."],
        },
        {
          id: "usdc-not-arrived",
          q: "What if my USDC doesn't arrive?",
          a: [
            `Your minimum price holds for ${DELIVERY_VALIDITY_S / DAY_S} days. If the USDC hasn't arrived an hour after your TAO is back, or the price has fallen below your minimum, your receipt offers Claim as USDC.`,
            `That sends the TAO to your wallet and sells it on Uniswap at the current price, which may be below your minimum; your wallet also asks you to let Uniswap spend that amount of TAO. You pay the network fees${onLive}, and Cascade's ${F.swapFeePct}% doesn't apply. You can keep it as TAO instead. TAO already back${onLive} can be claimed even while Cascade is paused.`,
          ],
        },
        {
          id: "cancel",
          q: "Can I cancel?",
          a: [
            "Yes, until your batch leaves. A cancelled deposit comes back as TAO, not USDC, and the fees already paid aren't refunded. A cancelled unstake keeps your balance but not the request fee.",
          ],
        },
        {
          id: "limits",
          q: "Is there a minimum or a maximum?",
          a: [
            `The smallest stake is ${F.minStakeTao} TAO (the stake form shows it in dollars), the smallest unstake ${F.minUnstakeTao} TAO. One batch carries at most ${F.maxBatchTao} TAO, and ${
              early
                ? `while Cascade is early, total deposits are capped at ${F.depositCapTao} TAO. Only deposit what you could afford to lose.`
                : "while Cascade is new the total it accepts is capped."
            }`,
          ],
        },
      ],
    },
    {
      id: "safety",
      title: "Safety",
      items: [
        {
          id: "audited",
          q: "Has Cascade been audited?",
          a:
            audit === "done"
              ? [`Yes, by an independent firm. Our [security policy](${SITE_LINKS.security}) has the details.`]
              : testing
                ? ["Not yet. Cascade is in testing and hasn't been independently audited, so we don't recommend depositing yet."]
                : early
                  ? [
                      `Not yet. Cascade has been reviewed many times, and its contracts are [public on GitHub](${SITE_LINKS.github}), but it hasn't had a professional audit yet. Only deposit what you could afford to lose.`,
                    ]
                  : [
                    `Not yet. The contracts have been through repeated reviews and are [public on GitHub](${SITE_LINKS.github}), but no independent audit has been done. One is planned before launch, and its report will be linked here. Until then, only stake what you can afford to lose.`,
                  ],
        },
        {
          id: "who-controls",
          q: "Who controls Cascade?",
          a: [
            `An owner key can change settings: fees up to their caps, the limits, the safety delay and the validator. It can also pause deposits and unstakes in an emergency. A pause can't move anyone's funds, but it holds exits until it's lifted; cancelling a batch that hasn't left and claiming TAO already back${onLive} keep working.`,
            ...(testing
              ? [
                  `Cascade is in testing: one team key holds every role, and its changes take effect at once. The plan for the public launch is a multi-signature owner, with changes behind a ${F.timelockH}-hour public delay.`,
                ]
              : early
                ? [
                    "Cascade's contracts are owned by the founder's hardware wallet (a Ledger) on Base and on Bittensor. A separate emergency key, the guardian, can pause deposits and unstakes and veto a new route; it can never move anyone's money.",
                    `There is no multisig or timelock yet, so a settings change takes effect at once, but only within hard limits written into the contracts: every fee has a fixed maximum, the safety delay stays between ${plural(H.payoutDelayMinH, "hour")} and ${plural(H.payoutDelayMaxDays, "day")}, no batch can be set to carry more than ${H.batchMaxTao.toLocaleString("en-US")} TAO, and unstakes through Cascade take at most ${H.outflowMaxPct === 50 ? "half" : `${H.outflowMaxPct}% of`} the staked TAO a day (or ${H.outflowFloorMaxTao} TAO, if that's more).`,
                  ]
                : [`The owner is a multi-signature wallet, and its changes wait out a ${F.timelockH}-hour public delay.`]),
          ],
        },
        {
          id: "take-funds",
          q: "Can Cascade take my funds?",
          a: [
            `Not instantly, and not quietly. TAO leaves the vault only through the bridge and front door set up at launch, or when a share owner withdraws directly on Bittensor. Adding a new route needs ${F.registryDelayDays} days' public notice, in which the guardian can veto it and you have time to unstake if you disagree.${
              testing
                ? " During testing one key holds every role, so that veto isn't independent yet."
                : early
                  ? " The guardian is a separate key from the owner, but Cascade holds both for now, so that veto isn't independent yet."
                  : ""
            }`,
            "Every fee is capped in the code, and you see each one before you confirm. Everything happens on-chain where anyone can check it.",
          ],
        },
        {
          id: "risks",
          q: "What are the risks?",
          a: [
            "TAO's price: your balance is TAO, so its dollar value can fall.",
            "Smart contracts: a bug could lose funds, and the contracts aren't independently audited yet.",
            testing
              ? "Control: during testing one team key holds every role, and settings change at once. [Who controls Cascade](/faq/#who-controls)."
              : early
                ? "Control: the owner is one hardware wallet, with no multisig or timelock yet, so settings change at once, within the contracts' hard limits. [Who controls Cascade](/faq/#who-controls)."
                : `Control: an owner can change settings within the code's limits after a ${F.timelockH}-hour public delay, and pause in an emergency. [Who controls Cascade](/faq/#who-controls).`,
            `Bridges: TAO crosses over Chainlink CCIP, and the TAO used${onLive} is issued by [ForeverMoney](${DOCS.foreverMoney}). If either has trouble, batches wait, and in a rare migration a batch already on its way could be lost.`,
            "Validator: if the validator moves its stake to a new key, balances read low until Cascade adds that key, and unstaking in that window pays less.",
            "Yield: rewards depend on the network and the validator, and can fall.",
            "Delays: if a bridge or Cascade's systems are down, exits take longer. USDC can also be frozen by its issuer for blocked addresses; you'd then claim TAO instead.",
          ],
        },
        {
          id: "if-cascade-is-down",
          q: "What if Cascade's systems go down?",
          a: [
            `Your funds stay where they are, but exits slow down. Anyone can send a batch or a payout once it's due, with a transaction on ${live.length > 0 ? `${list(live)} or Bittensor` : "Bittensor"} that pays its bridge fee or gas. Staking and reward collection open to anyone after ${F.keeperFallbackDays} days, and once your TAO is back${onLive} you can claim it yourself from your receipt. Only selling it to USDC for you needs Cascade's systems.`,
          ],
        },
        {
          id: "check-my-stake",
          q: "How can I check my stake?",
          a: [
            `Your balance comes with a live on-chain check, and the vault's stake is public on [Taostats](${stakeUrl}). The code is open source on [GitHub](${SITE_LINKS.github}).`,
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
            `If you cancel a deposit or claim by hand, you receive TAO${onLive}. It's a bridged version issued by [ForeverMoney](${DOCS.foreverMoney}) over Chainlink CCIP and backed by TAO it holds on Bittensor; it was fully backed when we checked in October 2026.`,
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
