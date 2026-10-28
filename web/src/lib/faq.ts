import { SOURCE_CHAINS } from "./cascade/chains";
import { DELIVERY_TOLERANCE_BPS, DELIVERY_VALIDITY_S, DEPLOYMENT, type Deployment, explorer } from "./cascade/config";
import { AUDIT_STATUS, SITE_LINKS } from "./site";

/** One question. Answers are paragraphs; `[label](https://…)` or `[label](/page/)` makes a link. */
export interface FaqItem {
  id: string;
  q: string;
  a: readonly string[];
  /** Also shown on the landing page. */
  featured?: boolean;
  /** Also shown under the Stake and Unstake forms. */
  inApp?: boolean;
}

export interface FaqSection {
  id: string;
  title: string;
  items: readonly FaqItem[];
}

/** Shown at the foot of the FAQ page. Change it whenever an answer changes. */
export const FAQ_UPDATED = "October 28, 2026";

/**
 * The numbers the answers quote. When a fee, the claim policy or the stage changes, change it here.
 * Sources: the staker's and vault's settings (contracts/src), the keeper's claim policy
 * (ops/src/config.ts `CLAIM_POLICY`) and the launch cadence (ops/src/config.ts `SETTINGS_V3_LAUNCH`).
 */
export const FAQ_FACTS = {
  /** "testing" until the owner moves behind a multisig and a timelock for the public launch. */
  stage: "testing" as "testing" | "live",
  depositFeeUsd: 0.05,
  swapFeePct: 0.15,
  rewardCutPct: 10,
  /** Hard caps written into the contracts. */
  caps: { swapFeePct: 0.5, depositFeeUsd: 0.25, rewardCutPct: 20 },
  /** Uniswap's 0.05% USDC/WETH and 0.3% WETH/TAO pools. */
  poolFeePct: 0.35,
  requestFeeEth: 0.0001,
  minStakeTao: 0.04,
  minStakeUsd: 10,
  minUnstakeTao: 0.005,
  /** Collect when waiting ≥ multiple × cost, or after everyDays while a claim costs < maxCostUsd and < what's waiting. */
  claim: { costTao: 0.057, multiple: 25, everyDays: 30, maxCostUsd: 20 },
  vestingDays: 7,
  validator: { name: "tao.bot", takePct: 0 },
  /** The launch cadence pairs a 24-hour payout delay with its 24-hour batch max wait; the test cadence uses 1 hour. */
  payoutDelayH: { launch: 24, test: 1 },
  registryDelayDays: 7,
  keeperFallbackDays: 7,
  timelockH: 48,
} as const;

const F = FAQ_FACTS;
const pct = (bps: number) => `${bps / 100}%`;
const list = (xs: readonly string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : (xs[0] ?? ""));

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

/** Every question, worded for the deployment the site talks to (its batch wait, validator and vault). */
export function faqSections(d: Deployment | null = DEPLOYMENT): FaqSection[] {
  const launch = Boolean(d?.batchMaxWaitS);
  const delayH = launch ? F.payoutDelayH.launch : F.payoutDelayH.test;
  const validatorUrl = d ? `https://taostats.io/validators/${d.hotkeySs58}` : "https://taostats.io/validators";
  const stakeUrl = d ? explorer.account(d.vaultSs58) : DOCS.taostats;
  const live = SOURCE_CHAINS.filter((c) => c.status === "live").map((c) => c.label);
  const soon = SOURCE_CHAINS.filter((c) => c.status === "soon").map((c) => c.label);

  return [
    {
      id: "tao",
      title: "TAO and staking",
      items: [
        {
          id: "what-is-tao",
          q: "What is TAO?",
          a: [
            `TAO is the token of [Bittensor](${DOCS.bittensor}), an open network that pays TAO to the people running useful AI work on it. Like other proof-of-stake networks, you can stake TAO to help secure it and earn more TAO in return.`,
          ],
        },
        {
          id: "what-is-root-staking",
          q: "What is root staking?",
          a: [
            "Staking means putting TAO with a validator, an operator that helps run the network, in return for a share of the TAO the network pays out. Your TAO stays yours; there's no lock-up.",
            `Cascade stakes on Bittensor's root network, which earns from every subnet at once instead of betting on one. [How root staking works](${DOCS.root}).`,
          ],
        },
        {
          id: "what-is-cascade",
          q: "What does Cascade do?",
          featured: true,
          inApp: true,
          a: [
            `Cascade gets you TAO staking from the wallet you already use. You deposit USDC on ${list(live)}; Cascade swaps it to TAO, carries it to Bittensor over [Chainlink CCIP](${DOCS.ccip}) and stakes it for you. Unstaking does the reverse and sends USDC back to your wallet.`,
          ],
        },
        {
          id: "bittensor-wallet",
          q: "Do I need a Bittensor wallet?",
          inApp: true,
          a: [
            `No. Everything happens from your wallet on ${list(live)}, such as MetaMask, Coinbase Wallet or Rabby. You only need a little ETH there for network fees.`,
          ],
        },
        {
          id: "tao-or-dollars",
          q: "Is my balance in TAO or dollars?",
          featured: true,
          a: [
            "TAO. Your USDC becomes TAO, so your balance grows with staking rewards and its dollar value rises and falls with TAO's price. If TAO falls, you can get back less USDC than you put in.",
          ],
        },
        {
          id: "validator",
          q: "Which validator stakes my TAO?",
          a: [
            `[${F.validator.name}](${validatorUrl}), the largest validator on Bittensor's root network. It keeps ${F.validator.takePct}% of rewards for itself. Cascade can move the stake to another validator if that ever changes; the move needs no unstaking and costs nothing.`,
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
            `[Bittensor's docs](${DOCS.docs}) explain the network, and [how staking works](${DOCS.staking}). [Taostats](${DOCS.taostats}) shows live network data and validators. [Chainlink CCIP](${DOCS.ccip}) is the bridge that carries TAO between ${list(live)} and Bittensor.`,
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
          featured: true,
          a: [
            `It's what root staking with ${F.validator.name} earned over the last 30 days, read straight from the validator's on-chain record on Bittensor, after its own fee and Cascade's ${F.rewardCutPct}% cut, compounded monthly as Cascade restakes rewards.`,
            "It's a yield in TAO, before deposit and withdrawal costs, and it changes with the network. Past yield isn't a promise.",
          ],
        },
        {
          id: "how-rewards-arrive",
          q: "How do rewards reach my balance?",
          a: [
            "Rewards build up at the validator as small amounts of each subnet's token. When Cascade collects them, they're turned into TAO and staked again.",
            `Cascade keeps ${F.rewardCutPct}%. The other ${100 - F.rewardCutPct}% is added to everyone's balance gradually over ${F.vestingDays} days, so nobody can join just before a collection and take rewards they didn't earn.`,
          ],
        },
        {
          id: "how-often-collected",
          q: "How often are rewards collected?",
          a: [
            `Each collection costs about ${F.claim.costTao} TAO in network fees, paid by Cascade, so Cascade waits until it's worth it: when the rewards waiting are worth at least ${F.claim.multiple} times that, or after ${F.claim.everyDays} days as long as more than that is waiting (and a collection costs under $${F.claim.maxCostUsd}).`,
            "While Cascade is small, that can mean every few months. Nothing is lost while rewards wait, and [Rewards](/rewards/) shows what's waiting for you.",
          ],
        },
        {
          id: "leave-before-collection",
          q: "What if I unstake before rewards are collected?",
          a: [
            `Rewards still waiting, and any still being added over ${F.vestingDays} days, stay with the people who remain. With monthly collections that's up to about a month of yield; while collections are rarer, it can be more.`,
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
          featured: true,
          inApp: true,
          a: [
            `$${F.depositFeeUsd.toFixed(2)} plus ${F.swapFeePct}% when you stake, ${F.swapFeePct}% when your TAO is sold back to USDC, and ${F.rewardCutPct}% of staking rewards when they're collected. Nothing else.`,
            `The contracts cap these for good: at most ${F.caps.swapFeePct}% per swap, $${F.caps.depositFeeUsd.toFixed(2)} per deposit and ${F.caps.rewardCutPct}% of rewards.`,
          ],
        },
        {
          id: "other-costs",
          q: "What other costs are there?",
          a: [
            `Uniswap's pool fees, about ${F.poolFeePct}% each way, and network fees on ${list(live)}, usually a cent or two. Cascade pays the bridge fee that carries deposits to Bittensor.`,
            `To unstake there's a ${F.requestFeeEth} ETH request fee, and the bridge fee for the trip back, taken from your TAO and shared when several people unstake together. Every amount is shown before you confirm.`,
          ],
        },
        {
          id: "break-even",
          q: "How long until rewards cover the costs?",
          a: [
            "A round trip costs about 1% plus a few small fixed fees, so a small amount staked briefly can come back as less than you put in, even if TAO's price doesn't move. The stake form shows how long your amount takes to cover its fees at today's yield.",
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
          featured: true,
          inApp: true,
          a: [
            launch
              ? "Deposits travel to Bittensor together in batches, which shares the bridge fee. A batch leaves once the fees it carries cover the trip, and after 24 hours at the latest. It then takes about 20 minutes to cross and is staked straight away."
              : "Deposits travel to Bittensor together in batches that leave every few minutes, then take about 20 minutes to cross and are staked straight away. Most deposits are staked within the hour.",
            "The stake form shows the expected time, and your receipt follows each step.",
          ],
        },
        {
          id: "how-to-unstake",
          q: "How do I unstake, and how long does it take?",
          inApp: true,
          a: [
            `Open [Unstake](/unstake/) and enter how much USDC you want. Your request travels to Bittensor in the next batch, waits out a ${delayH}-hour safety delay, and comes back to ${list(live)}, where it's sold for USDC and sent to your wallet, at no less than today's price less ${pct(DELIVERY_TOLERANCE_BPS)}.`,
            launch
              ? "All in, it can take up to about two days, usually less. The form shows the expected time."
              : "All in, it usually takes about an hour and a half. The form shows the expected time.",
          ],
        },
        {
          id: "lock-up",
          q: "Is there a lock-up?",
          inApp: true,
          a: ["No. You can unstake whenever you like; it just takes the time above to come back."],
        },
        {
          id: "usdc-not-arrived",
          q: "What if my USDC doesn't arrive?",
          a: [
            `Your minimum price holds for ${DELIVERY_VALIDITY_S / 86_400} days. If the USDC hasn't arrived an hour after your TAO is back, or the price has fallen below your minimum, your receipt offers Claim as USDC: one step that sends the TAO to your wallet and swaps it on Uniswap. Claiming always works, even if Cascade is paused.`,
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
            `The smallest stake is ${F.minStakeTao} TAO, about $${F.minStakeUsd}, and the smallest unstake ${F.minUnstakeTao} TAO. While Cascade is new, the total it accepts is capped; the stake form shows how much room is left.`,
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
          featured: true,
          a:
            AUDIT_STATUS === "done"
              ? [`Yes, by an independent firm. The report is on [GitHub](${SITE_LINKS.github}).`]
              : [
                  `Not yet. The contracts have been through repeated reviews and are [public on GitHub](${SITE_LINKS.github}), but no independent audit has been done. One is planned before launch, and its report will be linked here. Until then, only stake what you can afford to lose.`,
                ],
        },
        {
          id: "who-controls",
          q: "Who controls Cascade?",
          a: [
            "An owner key can change settings within the limits written into the code (fees up to their caps, the validator, batch sizes) and pause deposits and unstakes in an emergency. A pause can't take funds: cancelling and claiming keep working.",
            F.stage === "testing"
              ? `Cascade is in testing, and today one team key holds every role. For the public launch, the owner moves to a multi-signature wallet, with changes behind a ${F.timelockH}-hour public delay.`
              : `The owner is a multi-signature wallet, and its changes wait out a ${F.timelockH}-hour public delay.`,
          ],
        },
        {
          id: "take-funds",
          q: "Can Cascade take my funds?",
          a: [
            `Not instantly, and not quietly. Value leaves the vault only as payouts to the wallet that owns the shares, through the bridge set up at launch. Adding any new route needs ${F.registryDelayDays} days' public notice, and Cascade's fees are capped in the code. Everything happens on-chain where anyone can check it.`,
          ],
        },
        {
          id: "risks",
          q: "What are the risks?",
          featured: true,
          a: [
            "TAO's price: your balance is TAO, so its dollar value can fall.",
            "Smart contracts: a bug could lose funds, and the contracts aren't independently audited yet.",
            `Bridges: TAO crosses over Chainlink CCIP, and the TAO used on ${list(live)} is issued by [ForeverMoney](${DOCS.foreverMoney}). If either has trouble, batches wait, and in a rare migration a batch already on its way could be lost.`,
            "Yield: rewards depend on the network and the validator, and can fall.",
            "Delays: if a bridge or Cascade's systems are down, exits take longer. USDC can also be frozen by its issuer for blocked addresses; you'd then claim TAO instead.",
          ],
        },
        {
          id: "if-cascade-is-down",
          q: "What if Cascade's systems go down?",
          a: [
            `Your funds don't depend on them. Anyone can send a batch or a payout once it's due, staking and reward collection open to anyone after ${F.keeperFallbackDays} days, and you can always claim your TAO yourself from your receipt.`,
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
            `${list(live)} today, from MetaMask, Coinbase Wallet, Rabby or any browser wallet. ${list(soon)} are coming; until then, bridge USDC to ${list(live)} first. On a phone, open Cascade in your wallet app's browser.`,
          ],
        },
        {
          id: "tao-on-base",
          q: `What is the TAO on ${list(live)}?`,
          a: [
            `If you cancel a deposit or claim by hand, you receive TAO on ${list(live)}. It's a bridged version issued by [ForeverMoney](${DOCS.foreverMoney}) over Chainlink CCIP and backed one to one by TAO it holds on Bittensor.`,
          ],
        },
      ],
    },
  ];
}

export const FAQ_SECTIONS: readonly FaqSection[] = faqSections();

/** The landing page's short list, in page order. */
export function featuredFaq(sections: readonly FaqSection[] = FAQ_SECTIONS): FaqItem[] {
  return sections.flatMap((s) => s.items.filter((i) => i.featured));
}

/** The short list under the Stake and Unstake forms, in page order. */
export function appFaq(sections: readonly FaqSection[] = FAQ_SECTIONS): FaqItem[] {
  return sections.flatMap((s) => s.items.filter((i) => i.inApp));
}
