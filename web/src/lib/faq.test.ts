import { readFileSync } from "node:fs";
import { formatUnits } from "viem";
import { describe, expect, it } from "vitest";
import type { SourceChainInfo } from "./cascade/chains";
import { type Deployment, EXPECTED_DEPLOYMENTS, MIN_UNSTAKE_WEI_V3, PATH_USDC_TO_TAO, readDeployment, TOKENS } from "./cascade/config";
import { appFaq, FAQ_FACTS, type FaqOptions, faqSections, requestFeeEth, type Stage, VALIDATORS } from "./faq";
import { parseInlineLinks } from "./inline-links";
import { POOL_FEE_PCT, POOL_FEES_TEXT } from "./stake-form";
import { APY_FOOTNOTE } from "./stats";
import { SITE_LINKS } from "./site";

const TAO_BOT = "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";
const ENV = {
  NEXT_PUBLIC_CASCADE_FRONT_DOOR: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  NEXT_PUBLIC_CASCADE_BASE_ADAPTER: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  NEXT_PUBLIC_CASCADE_VAULT: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  NEXT_PUBLIC_CASCADE_BIT_ADAPTER: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  NEXT_PUBLIC_CASCADE_BIT_BLOCK: "9357492",
  NEXT_PUBLIC_CASCADE_VAULT_SS58: "5FNEuRkKZvg2jFjhY3DWpC3TBSH51AC3FKQpLyC1xesTBwLu",
  NEXT_PUBLIC_CASCADE_HOTKEY_SS58: "5E4z3h9yVhmQyCFWNbY9BPpwhx4xFiPwq3eeqmBgVF6KULde",
  // a v3 deployment, as web-config writes one (a payout delay comes only with a staker and an oracle)
  NEXT_PUBLIC_CASCADE_STAKER: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  NEXT_PUBLIC_CASCADE_ORACLE: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
};
const TEST = readDeployment(ENV) as Deployment;
const LAUNCH = readDeployment({ ...ENV, NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S: "86400" }) as Deployment;
/** What ops web-config writes today: tao.bot, and the vault's payout delay. */
const LIVE_TEST = readDeployment({ ...ENV, NEXT_PUBLIC_CASCADE_HOTKEY_SS58: TAO_BOT, NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S: "3600" }) as Deployment;
const LIVE_LAUNCH = readDeployment({
  ...ENV,
  NEXT_PUBLIC_CASCADE_HOTKEY_SS58: TAO_BOT,
  NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S: "86400",
  NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S: "86400",
}) as Deployment;
/** The launch as the site is built for it (deployments.json "v3-launch", as pnpm ops web-config writes it). */
const LAUNCH_SITE = readDeployment({
  NEXT_PUBLIC_CASCADE_FRONT_DOOR: "0xbAe5417A40613141790624bCeF6BaFc3b24ff9AA",
  NEXT_PUBLIC_CASCADE_BASE_ADAPTER: "0xF2B3A36185e74ddCf8Ea9A174c06b75520F47F92",
  NEXT_PUBLIC_CASCADE_STAKER: "0xe33012f8ae80E17a7D7B8d9249043dB01D27e59E",
  NEXT_PUBLIC_CASCADE_ORACLE: "0xcAa85F00b6e470Dd28a31FBa982267B820736eBc",
  NEXT_PUBLIC_CASCADE_VAULT: "0x450cD94401B45c72C09734071fe683F6b74Aea72",
  NEXT_PUBLIC_CASCADE_BIT_ADAPTER: "0x002d7C6b2A6062d4E066FB41671DbB3Fd4f388E1",
  NEXT_PUBLIC_CASCADE_BIT_BLOCK: "9398120",
  NEXT_PUBLIC_CASCADE_VAULT_SS58: "5ELMyza1QBFKY1K6bbJXoPSENaiJVVTSQZBgdkQujxKpsfQn",
  NEXT_PUBLIC_CASCADE_HOTKEY_SS58: TAO_BOT,
  NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S: "86400",
  NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S: "86400",
}) as Deployment;
const ALL = [TEST, LAUNCH, LIVE_TEST, LIVE_LAUNCH, LAUNCH_SITE, null];
/** The live site: deployments.json "v3.2-launch", as pnpm ops web-config writes it (v3.2, early, 24-hour timing). */
const v32Launch = (): Deployment => {
  const e = EXPECTED_DEPLOYMENTS["v3.2-launch"];
  return readDeployment({
    NEXT_PUBLIC_CASCADE_FRONT_DOOR: e.frontDoor,
    NEXT_PUBLIC_CASCADE_BASE_ADAPTER: e.baseAdapter,
    NEXT_PUBLIC_CASCADE_STAKER: e.staker,
    NEXT_PUBLIC_CASCADE_ORACLE: e.oracle,
    NEXT_PUBLIC_CASCADE_VAULT: e.vault,
    NEXT_PUBLIC_CASCADE_BIT_ADAPTER: e.bitAdapter,
    NEXT_PUBLIC_CASCADE_BIT_BLOCK: e.bitBlock,
    NEXT_PUBLIC_CASCADE_VAULT_SS58: e.vaultSs58,
    NEXT_PUBLIC_CASCADE_HOTKEY_SS58: e.hotkeySs58,
    NEXT_PUBLIC_CASCADE_VAULT_LENS: e.vaultLens,
    NEXT_PUBLIC_CASCADE_DOOR_LENS: e.doorLens,
    NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S: "86400",
    NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S: "86400",
    NEXT_PUBLIC_CASCADE_INDEXER_URL: "https://cascade-indexer-production.dev-truthpoll.workers.dev",
  }) as Deployment;
};

const items = (d: Deployment | null, o?: FaqOptions) => faqSections(d, o).flatMap((s) => s.items);
const answer = (d: Deployment | null, id: string, o?: FaqOptions) => {
  const item = items(d, o).find((i) => i.id === id);
  if (!item) throw new Error(`no question ${id}`);
  return item.a.join(" ");
};
/** The only places the answers send people. */
const HOSTS = ["www.bittensor.com", "taostats.io", "docs.chain.link", "github.com", "forevermoney.ai"];

describe("the FAQ", () => {
  it("gives every topic and question its own id, for links like /faq/#fees", () => {
    const sections = faqSections(TEST);
    const ids = [...sections.map((s) => s.id), ...items(TEST).map((i) => i.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z][a-z0-9-]*$/.test(id))).toBe(true);
  });

  it("links only to this site or to the sources it names, and its own links land on a question", () => {
    const ids = new Set(items(TEST).map((i) => i.id));
    for (const d of ALL) {
      for (const item of items(d)) {
        for (const part of item.a.flatMap((p) => parseInlineLinks(p))) {
          if (!part.href) continue;
          if (part.href.startsWith("/")) {
            const hash = part.href.split("#")[1];
            if (hash !== undefined) expect(ids, `${item.id}: ${part.href}`).toContain(hash);
            continue;
          }
          expect(HOSTS, `${item.id}: ${part.href}`).toContain(new URL(part.href).host);
        }
      }
    }
  });

  it("shows a short list in the app", () => {
    expect(appFaq(faqSections(TEST)).length).toBeGreaterThanOrEqual(4);
    expect(appFaq(faqSections(TEST)).length).toBeLessThanOrEqual(7);
  });

  it("quotes the delivery floor the app sets, and says what happens below it", () => {
    const a = answer(TEST, "how-to-unstake");
    expect(a).toContain("today's price less 2% or better");
    expect(a).toContain("If TAO falls further, it waits for you to claim it instead.");
  });

  it("says plainly that there is no audit yet, and doesn't recommend depositing while testing", () => {
    const testing = answer(TEST, "audited", { stage: "testing", audit: "scheduled" });
    expect(testing).toBe("Not yet. Cascade is in testing and hasn't been independently audited, so we don't recommend depositing yet.");
    const scheduled = answer(TEST, "audited", { stage: "live", audit: "scheduled" });
    expect(scheduled).toMatch(/^Not yet\./);
    expect(scheduled).toContain("only stake what you can afford to lose");
    const done = answer(TEST, "audited", { stage: "live", audit: "done" });
    expect(done).toMatch(/^Yes, by an independent firm\./);
    expect(done).toContain(`(${SITE_LINKS.security})`);
    expect(done).not.toContain(`(${SITE_LINKS.github})`);
    // the stage follows the deployment: one not listed (TEST) reads as testing
    expect(answer(TEST, "audited")).toBe(testing);
  });

  it("links the deployment's own validator and stake", () => {
    expect(answer(TEST, "validator")).toContain(TEST.hotkeySs58);
    expect(answer(TEST, "check-my-stake")).toContain(TEST.vaultSs58);
    expect(answer(null, "validator")).toContain("https://taostats.io/validators");
  });

  it("names the validator and its take only for a hotkey it knows", () => {
    expect(VALIDATORS[TAO_BOT]).toEqual({ name: "tao.bot", takePct: 0 });
    const known = answer(LIVE_TEST, "validator");
    expect(known).toContain(`[tao.bot](https://taostats.io/validators/${TAO_BOT})`);
    expect(known).toContain("It keeps 0% of rewards");
    expect(answer(LIVE_TEST, "apy")).toContain("root staking with tao.bot");
    for (const d of [TEST, null]) {
      const generic = answer(d, "validator");
      expect(generic).toContain("Cascade's validator");
      expect(generic).not.toContain("tao.bot");
      expect(generic).not.toMatch(/keeps \d/);
      expect(answer(d, "apy")).toContain("root staking with Cascade's validator");
      expect(answer(d, "apy")).not.toContain("tao.bot");
    }
    for (const d of ALL) expect(answer(d, "validator")).not.toContain("largest");
  });
});

describe("the FAQ's answers say what the code does", () => {
  it("lists every Cascade fee and its cap, the request fee's included", () => {
    const a = answer(TEST, "cascade-fees");
    expect(a).toContain(
      "Staking: $0.05 plus 0.15%. Unstaking: a 0.0001 ETH request fee, which goes toward the bridge fee that carries your request to Bittensor, plus 0.15% when your TAO is sold back to USDC. Rewards: 10% of staking rewards when they're collected.",
    );
    expect(a).toContain("Each fee has a cap in the contracts: 0.5% per swap, $0.25 per deposit, 20% of rewards, and 0.001 ETH for the request fee.");
    expect(a).not.toMatch(/no cap/);
    expect(a).toContain(
      "Whatever the settings, a trade Cascade makes for you never goes below the minimum you approve. When you stake, that is the least TAO shown. When you unstake, it is today's price less 2%.",
    );
    expect(a).not.toMatch(/Nothing else|for good/);
  });

  it("says what the owner can change, what a pause holds, and that the launch setup is a plan", () => {
    const a = answer(TEST, "who-controls");
    expect(a).toContain("An owner key can change settings: fees up to their caps, the limits");
    expect(a).not.toMatch(/no cap/);
    expect(a).toMatch(/the limits, the wait before payouts and the validator/);
    expect(a).toContain("it holds exits until it's lifted");
    expect(a).toContain("cancelling a batch that hasn't left and claiming TAO already back on Base keep working");
    const testing = answer(TEST, "who-controls", { stage: "testing" });
    expect(testing).toContain("one team key holds every role, and its changes take effect at once");
    expect(testing).toContain("The plan for the public launch is a multi-signature owner");
    expect(testing).not.toContain("moves to");
  });

  it("says exits slow down without Cascade's systems, and what still works", () => {
    const a = answer(TEST, "if-cascade-is-down");
    expect(a).toMatch(/^Your funds stay where they are, but exits slow down\./);
    expect(a).toContain("on Base or Bittensor");
    expect(a).toContain("after 7 days");
    expect(a).toContain("once your TAO is back on Base you can claim it yourself from your receipt");
    expect(a).toContain("Only selling it to USDC for you needs Cascade's systems.");
    expect(a).not.toContain("don't depend");
  });

  it("says rewards vest to whoever is staked as they're added", () => {
    const a = answer(TEST, "how-rewards-arrive");
    expect(a).toContain("so it goes only to people still staked as it's added");
    expect(a).toContain("Someone who joins just before a collection still shares in it");
    expect(a).toContain("someone who leaves before it's added leaves it behind");
    expect(a).not.toContain("nobody can join just before");
  });

  it("says collections can be months apart, are run by hand while testing, and what waiting rewards risk", () => {
    const a = answer(TEST, "how-often-collected", { stage: "testing" });
    expect(a).toContain(`${FAQ_FACTS.claim.multiple} times`);
    expect(a).toContain(`${FAQ_FACTS.claim.everyDays} days`);
    expect(a).toContain(`${FAQ_FACTS.claim.costTao} TAO`);
    expect(a).toContain("if TAO rises above about $350 (a collection then costs over $20), collections can be many months apart");
    expect(a).toContain("During testing they're run by hand.");
    expect(a).toContain("held as subnet tokens, so their value in TAO can rise or fall");
    expect(a).toContain("if you unstake first you leave them behind");
    expect(a).not.toContain("Nothing is lost");
    expect(answer(TEST, "how-often-collected", { stage: "live" })).not.toContain("by hand");
  });

  it("says the APY assumes monthly collection, not that it compounds monthly", () => {
    const monthly = "assuming rewards are collected and restaked monthly (they may be collected less often)";
    expect(answer(TEST, "apy")).toContain(monthly);
    expect(APY_FOOTNOTE).toContain(monthly);
    expect(answer(TEST, "apy")).not.toContain("compounded");
    expect(APY_FOOTNOTE).not.toContain("compounded");
  });

  it("says the daily unstake limit, a pause and the guardian switching off the route can hold unstakes", () => {
    for (const d of [TEST, LAUNCH_SITE]) {
      expect(answer(d, "lock-up")).toBe(
        "No. You can unstake whenever you like; it just takes the time above to come back. Only three things hold an unstake back: the daily unstake limit, which leaves anything over it staked for you to unstake again later; an emergency pause, for as long as it lasts; and the guardian switching off Cascade's route, which takes at least 7 days' public notice to undo.",
      );
    }
  });

  it("says what Claim as USDC does and costs", () => {
    const a = answer(TEST, "usdc-not-arrived");
    expect(a).toMatch(/^You can claim it yourself from your receipt\./);
    expect(a).toContain("Your minimum price, the one you approved when you unstaked, holds for 7 days.");
    expect(a).toContain("Claim as USDC sends the TAO to your wallet and sells it on Uniswap at the current price. That price may be below your minimum.");
    expect(a).toContain("let Uniswap spend that amount of TAO");
    expect(a).toContain("You pay the network fees on Base, and Cascade's 0.15% doesn't apply.");
    expect(a).toContain("You can keep it as TAO instead.");
    expect(a).toContain("TAO already back on Base can be claimed even while Cascade is paused.");
  });

  it("names the control and validator risks", () => {
    const a = faqSections(TEST, { stage: "testing" })
      .flatMap((s) => s.items)
      .find((i) => i.id === "risks")!.a;
    expect(a.find((p) => p.startsWith("Control:"))).toBe(
      "Control: during testing one team key holds every role, and settings change at once. [Who controls Cascade](/faq/#who-controls).",
    );
    expect(a.find((p) => p.startsWith("Validator:"))).toContain("balances read low until Cascade adds that key, and unstaking in that window pays less");
  });

  it("states the limits without a dollar figure that moves with TAO's price", () => {
    const a = answer(TEST, "limits");
    expect(a).toBe(
      "The smallest stake is 0.04 TAO (the stake form shows it in dollars), the smallest unstake 0.011 TAO. One batch carries at most 10 TAO, and while Cascade is new the total it accepts is capped.",
    );
  });

  it("describes TAO and root staking without calling Bittensor proof-of-stake", () => {
    const tao = answer(TEST, "what-is-tao");
    expect(tao).not.toMatch(/proof-of-stake|secure/);
    expect(tao).toContain("You can stake TAO with a validator, whose stake decides how the network's rewards are shared, and earn more TAO in return.");
    const root = answer(TEST, "what-is-root-staking");
    expect(root).toContain("Staked directly, your TAO stays under your own key; through Cascade, its vault stakes the TAO and you hold shares in the vault.");
    expect(root).toContain("earns from across the subnets");
    expect(root).not.toContain("every subnet");
  });

  it("says who can move TAO out of the vault and what notice a new route needs", () => {
    const a = answer(TEST, "take-funds", { stage: "testing" });
    expect(a).toContain("TAO leaves the vault only through the bridge and front door set up at launch, or when a share owner withdraws directly on Bittensor.");
    expect(a).toContain("7 days' public notice");
    expect(a).toContain("time to unstake if you disagree");
    expect(a).toContain("During testing one key holds every role, so that veto isn't independent yet.");
    expect(a).toContain(
      "Every fee is capped in the code, and you see each one before you confirm. With no timelock yet, the reward cut and the fee on selling back to USDC can still rise to their caps after you stake, but the minimum price you approve still protects each swap.",
    );
    expect(a).not.toMatch(/no cap|except the unstake request fee/);
    const live = answer(TEST, "take-funds", { stage: "live" });
    expect(live).not.toContain("During testing");
    expect(live).toContain("Every fee is capped in the code, and you see each one before you confirm.");
    expect(live).not.toContain("With no timelock yet");
  });

  it("fails closed: a stage that isn't exactly early or live gets the testing answers, never the live ones", () => {
    for (const stage of ["Live", "launch", ""] as unknown as Stage[]) {
      const text = items(TEST, { stage })
        .flatMap((i) => i.a)
        .join("\n");
      expect(text).toContain("one team key holds every role");
      expect(text).not.toMatch(/multi-signature wallet, and its changes wait|after a 48-hour public delay/);
      expect(answer(TEST, "audited", { stage, audit: "scheduled" })).toBe(answer(TEST, "audited", { stage: "testing", audit: "scheduled" }));
    }
  });

  it("names price impact, the unstake fee in ETH, planned chains and the backing as checked", () => {
    expect(answer(TEST, "other-costs")).toContain(`Uniswap's pool fees, ${POOL_FEES_TEXT} each way plus price impact, which grows with the amount`);
    expect(answer(TEST, "bittensor-wallet")).toContain("a little ETH there for network fees and the 0.0001 ETH unstake fee");
    const chains = answer(TEST, "which-chains");
    expect(chains).toContain("More chains are planned.");
    expect(chains).not.toMatch(/coming|bridge USDC/);
    const tao = answer(TEST, "tao-on-base");
    expect(tao).toContain("fully backed when we checked in October 2026");
    expect(tao).not.toContain("one to one");
  });

  it("names the fixed fees that make a small round trip costly", () => {
    const a = answer(TEST, "break-even");
    expect(a).toContain("fixed fees of about $0.50 all in. The fixed fees are the $0.05 deposit fee, the 0.0001 ETH request fee (about $0.18) and the bridge fee back.");
    expect(a).toContain("Those fixed fees are about 5% of a $10 stake. So a small amount staked briefly can come back as less than you put in");
  });

  it("bounds what leaving before a collection costs by a month plus the vesting week", () => {
    expect(answer(TEST, "leave-before-collection")).toContain("up to about 5 weeks of yield");
  });
});

describe("the FAQ at the launch (early: real money, a Ledger owner, no multisig or timelock yet)", () => {
  it("takes the early stage from the deployment the site is built for", () => {
    expect(answer(LAUNCH_SITE, "audited")).toBe(answer(LAUNCH_SITE, "audited", { stage: "early" }));
    expect(answer(LAUNCH_SITE, "audited")).not.toBe(answer(LAUNCH_SITE, "audited", { stage: "testing" }));
  });

  it("says who controls it as it is: the founder's Ledger, a separate guardian, no multisig or timelock, the code's hard limits", () => {
    const a = answer(LAUNCH_SITE, "who-controls");
    expect(a).toContain("Cascade's contracts are owned by the founder's hardware wallet (a Ledger) on Base and on Bittensor.");
    expect(a).toContain(
      "A separate emergency key, the guardian, can pause deposits and unstakes, veto a new route, and switch off the current one; turning a route back on takes the same 7 days' public notice as a new one. The guardian can never move anyone's money.",
    );
    expect(a).toContain(
      "There is no multisig or timelock yet, so a settings change takes effect at once, and the riskiest settings move only within hard limits written into the contracts: every fee has a fixed maximum, the wait before a payout stays between 1 hour and 7 days, no batch can be set to carry more than 5,000 TAO, and unstakes through Cascade take at most half the staked TAO a day (or 100 TAO, if that's more).",
    );
  });

  it("v3.2-launch's code is published (Task 70), so its answers say public and open source with no option given; until a deployment's code is published (the option), no answer says so: the audit answer and the check answer say when the code comes", () => {
    const e = EXPECTED_DEPLOYMENTS["v3.2-launch"];
    const live = v32Launch();
    // the entry no longer says its source isn't published, and the answers follow it with no option given
    expect(e).not.toHaveProperty("sourcePublished");
    expect(answer(live, "audited")).toBe(
      `Not yet. Cascade has been reviewed many times, and its contracts are [public on GitHub](${SITE_LINKS.github}), but it hasn't had a professional audit yet. Only deposit what you could afford to lose.`,
    );
    expect(answer(live, "check-my-stake")).toContain(`The code is open source on [GitHub](${SITE_LINKS.github}).`);
    const all = faqSections(live).flatMap((s) => s.items.flatMap((i) => [i.q, ...i.a])).join(" ");
    expect(all).not.toMatch(/code isn't public yet|once its launch checks are done/);
    // told its code isn't published, the same deployment says when the code comes, and never public or open source
    expect(answer(live, "audited", { sourcePublished: false })).toBe(
      `Not yet. Cascade has been reviewed many times, but it hasn't had a professional audit yet. This version's contract code isn't public yet either: it goes on [GitHub](${SITE_LINKS.github}) once its launch checks are done. Only deposit what you could afford to lose.`,
    );
    expect(answer(live, "check-my-stake", { sourcePublished: false })).toContain(`This version's code goes on [GitHub](${SITE_LINKS.github}) once its launch checks are done.`);
    const told = faqSections(live, { sourcePublished: false }).flatMap((s) => s.items.flatMap((i) => [i.q, ...i.a])).join(" ");
    expect(told).not.toMatch(/open[ -]source|public on GitHub|contracts are public/i);
    // the same words for any deployment told so, at every stage that names the code; and the published ones once it is
    for (const stage of ["early", "live"] as const) {
      const unpublished = faqSections(LAUNCH_SITE, { stage, sourcePublished: false }).flatMap((s) => s.items.flatMap((i) => i.a)).join(" ");
      expect(unpublished, stage).not.toMatch(/open[ -]source|public on GitHub/i);
      expect(unpublished, stage).toMatch(/code isn't public yet/);
    }
    expect(answer(live, "audited", { sourcePublished: true })).toContain(`its contracts are [public on GitHub](${SITE_LINKS.github})`);
    expect(answer(live, "check-my-stake", { sourcePublished: true })).toContain(`The code is open source on [GitHub](${SITE_LINKS.github}).`);
  });

  it("says there is no professional audit yet, and to deposit only what you could afford to lose", () => {
    expect(answer(LAUNCH_SITE, "audited")).toBe(
      `Not yet. Cascade has been reviewed many times, and its contracts are [public on GitHub](${SITE_LINKS.github}), but it hasn't had a professional audit yet. Only deposit what you could afford to lose.`,
    );
  });

  it("names the deposit cap and the unstake limits, from the deployment's settings", () => {
    expect(answer(LAUNCH_SITE, "limits")).toBe(
      "The smallest stake is 0.04 TAO (the stake form shows it in dollars), the smallest unstake 0.011 TAO. One batch carries at most 10 TAO, and while Cascade is early, total deposits are capped at 40 TAO. One unstake carries at most 10 TAO, and unstakes through Cascade are limited to 20% of the staked TAO a day, or 10 TAO if that's more, shared by everyone. Anything over a limit stays staked, and you unstake it again later, paying the request fee again. Only deposit what you could afford to lose.",
    );
    // a deployment whose limits aren't listed says nothing it doesn't know
    expect(answer(TEST, "limits", { stage: "early" })).toBe(
      "The smallest stake is 0.04 TAO (the stake form shows it in dollars), the smallest unstake 0.011 TAO. One batch carries at most 10 TAO, and while Cascade is early, total deposits are capped at 40 TAO. Only deposit what you could afford to lose.",
    );
  });

  it("names the control risk, and says the guardian's veto isn't independent yet", () => {
    const risks = faqSections(LAUNCH_SITE)
      .flatMap((s) => s.items)
      .find((i) => i.id === "risks")!.a;
    expect(risks.find((p) => p.startsWith("Control:"))).toBe(
      "Control: the owner is one hardware wallet, with no multisig or timelock yet, so settings change at once, the riskiest only within the contracts' hard limits. [Who controls Cascade](/faq/#who-controls).",
    );
    expect(answer(LAUNCH_SITE, "take-funds")).toContain("The guardian is a separate key from the owner, but Cascade holds both for now, so that veto isn't independent yet.");
  });

  it("keeps the lines about the bridges, ForeverMoney and the validator", () => {
    const risks = answer(LAUNCH_SITE, "risks");
    expect(risks).toContain("Bridges: TAO crosses over Chainlink CCIP");
    expect(risks).toContain("is issued by [ForeverMoney](https://forevermoney.ai/)");
    expect(risks).toContain("Validator: if the validator moves its stake to a new key");
    expect(answer(LAUNCH_SITE, "validator")).toContain("[tao.bot](");
  });

  it("says nothing of testing, of one key holding every role, or of a multi-signature owner or public delay it doesn't have", () => {
    const text = items(LAUNCH_SITE)
      .flatMap((i) => [i.q, ...i.a])
      .join("\n");
    expect(text).not.toMatch(/testing|one team key|every role|multi-signature|public delay|48-hour|we don't recommend depositing/i);
  });
});

describe("the FAQ's timing follows the deployment", () => {
  it("says how long a batch can wait, from the deployment's max wait", () => {
    expect(answer(LAUNCH, "how-long-to-stake")).toContain("after 24 hours at the latest");
    const wait = (s: string) => readDeployment({ ...ENV, NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S: s }) as Deployment;
    expect(answer(wait("43200"), "how-long-to-stake")).toContain("after 12 hours at the latest");
    expect(answer(wait("172800"), "how-long-to-stake")).toContain("after 2 days at the latest");
    expect(answer(wait("259200"), "how-long-to-stake")).toContain("after 3 days at the latest");
    expect(answer(TEST, "how-long-to-stake")).not.toMatch(/hours|at the latest/);
    expect(answer(null, "how-long-to-stake")).toBeTruthy();
  });

  it("says the waiting period the vault has, else the cadence's", () => {
    expect(answer(LIVE_TEST, "how-to-unstake")).toContain("waits out a 1-hour waiting period");
    expect(answer(LIVE_LAUNCH, "how-to-unstake")).toContain("waits out a 24-hour waiting period");
    const delay = (s: string) => readDeployment({ ...ENV, NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S: s }) as Deployment;
    expect(answer(delay("43200"), "how-to-unstake")).toContain("waits out a 12-hour waiting period");
    expect(answer(delay("1800"), "how-to-unstake")).toContain("waits out a 30-minute waiting period");
    expect(answer(delay("0"), "how-to-unstake")).not.toContain("waiting period");
    expect(answer(delay("0"), "how-to-unstake")).toContain("in the next batch and comes back to Base");
    // without the vault's own figure, the cadence's default
    expect(answer(TEST, "how-to-unstake")).toContain("waits out a 1-hour waiting period");
    expect(answer(LAUNCH, "how-to-unstake")).toContain("waits out a 24-hour waiting period");
  });

  it("says a deposit can leave sooner, at the launch, by paying its batch's bridge fee a few minutes after the batch is an hour old", () => {
    expect(items(LAUNCH_SITE).find((i) => i.id === "send-sooner")?.q).toBe("Can I make my deposit leave sooner?");
    expect(answer(LAUNCH_SITE, "send-sooner")).toBe(
      "Yes, a few minutes after its batch is 1 hour old. A batch is the group of deposits that travels to Bittensor together. From then, you can choose Send it now, on the Stake page or on the deposit's receipt, to send the batch at once. You pay the whole batch's bridge fee in ETH, usually a dollar or two. Anything extra is refunded. If you don't, the batch leaves on its own within 24 hours, or sooner once its fees cover the bridge fee.",
    );
    expect(answer(LAUNCH, "send-sooner")).toBe(answer(LAUNCH_SITE, "send-sooner"));
    // without a max wait the keeper sends each batch as soon as it can: there is nothing to speed up
    expect(answer(TEST, "send-sooner")).toBe("There's no need: batches leave on their own every few minutes, as soon as they can.");
    expect(answer(null, "send-sooner")).toBeTruthy();
  });

  it("adds up the batch wait, the payout delay and about an hour for the whole exit", () => {
    expect(answer(LIVE_LAUNCH, "how-to-unstake")).toContain("All in, it can take up to about 2 days, usually less.");
    expect(answer(LIVE_TEST, "how-to-unstake")).toContain("All in, it can take up to about 2 hours, usually less.");
    const short = readDeployment({ ...ENV, NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S: "3600", NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S: "3600" }) as Deployment;
    expect(answer(short, "how-to-unstake")).toContain("up to about 3 hours");
  });
});

describe("the FAQ's chain names", () => {
  const chain = (label: string, status: "live" | "soon"): SourceChainInfo => ({
    id: "base",
    label,
    color: "#000",
    chainId: 1,
    status,
  });
  const text = (chains: readonly SourceChainInfo[]) =>
    faqSections(TEST, { chains })
      .flatMap((s) => s.items)
      .flatMap((i) => [i.q, ...i.a])
      .join("\n");

  it("names one live chain on its own and promises no more chains when none are planned", () => {
    const t = text([chain("Base", "live")]);
    expect(t).toContain("Base today, from MetaMask");
    expect(t).toContain("between Base and Bittensor");
    expect(t).toContain("What is the TAO on Base?");
    expect(t).not.toContain("More chains");
  });

  it("lists several live chains and mentions the planned ones once", () => {
    const t = text([chain("Base", "live"), chain("Ethereum", "live"), chain("Arbitrum", "soon")]);
    expect(t).toContain("Base and Ethereum today");
    expect(t.match(/More chains are planned\./g)).toHaveLength(1);
    expect(t).not.toContain("Arbitrum");
  });

  it("leaves no dangling chain name when none is live", () => {
    for (const chains of [[], [chain("Base", "soon")]]) {
      const t = text(chains);
      expect(t).not.toMatch(/\b(on|to|between|and) ?[,.;?]|\bon\s+and\b|  /);
      expect(t).not.toMatch(/^ | $/m);
      expect(t).toContain("No chain is open for deposits yet.");
    }
  });
});

// ---- staleness guards: the FAQ's numbers against the code that sets them ----

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
// v3-launch's sources, frozen in ops/builds/preaudit (contracts/ now holds v3.2)
const STAKER_SOL = read("../../../ops/builds/preaudit/src/CascadeStaker.sol");
const VAULT_SOL = read("../../../ops/builds/preaudit/src/CascadeVault.sol");
const BASE_SOL = read("../../../ops/builds/preaudit/src/CascadeBase.sol");
const FRONT_DOOR_SOL = read("../../../ops/builds/preaudit/src/CascadeFrontDoor.sol");
const OPS_CONFIG = read("../../../ops/src/config.ts");
const OPS_REWARDS = read("../../../ops/src/keeper/core/rewards.ts");

const UNITS: Record<string, bigint> = { seconds: 1n, minutes: 60n, hours: 3_600n, days: 86_400n };

/** A whole-number expression as the sources write it: `86_400`, `57n * 10n ** 15n`, `7 days`. */
function whole(expr: string): bigint {
  const unit = expr.trim().match(/^(.*?)\s+(seconds|minutes|hours|days)$/);
  if (unit) return whole(unit[1]) * UNITS[unit[2]];
  const e = expr.replace(/_/g, "").replace(/(\d)n\b/g, "$1").trim();
  const sci = e.match(/^(\d+)e(\d+)$/);
  if (sci) return BigInt(sci[1]) * 10n ** BigInt(sci[2]);
  if (!/^[\d\s*]+$/.test(e)) throw new Error(`not a whole-number expression: ${expr}`);
  return e
    .split(/(?<!\*)\*(?!\*)/)
    .map((f) => f.split("**").map((x) => BigInt(x.trim())).reduceRight((acc, x) => x ** acc))
    .reduce((a, b) => a * b, 1n);
}

/** A Solidity `constant NAME = …;`. */
function solConstant(source: string, name: string): bigint {
  const m = source.match(new RegExp(`constant\\s+${name}\\s*=\\s*([^;]+);`));
  if (!m) throw new Error(`no constant ${name}`);
  return whole(m[1]);
}

/** The body of `export const NAME = { … }`, braces matched. */
function objectBody(source: string, name: string): string {
  const start = source.indexOf(`export const ${name} = {`);
  if (start < 0) throw new Error(`no object ${name}`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(source.indexOf("{", start) + 1, i);
  }
  throw new Error(`unclosed object ${name}`);
}

/** `key: value` in an object body, as a whole number. */
function field(body: string, key: string): bigint {
  const m = body.match(new RegExp(`(?<![\\w.])${key}:\\s*([^,}\\n]+)`));
  if (!m) throw new Error(`no field ${key}`);
  return whole(m[1].replace(/\s+as\s+\w+$/, ""));
}

const DAY = 86_400n;
const decimals = (v: bigint, places: number) => Number(formatUnits(v, places));

describe("the FAQ's numbers match the code", () => {
  const v3 = objectBody(OPS_CONFIG, "SETTINGS_V3");
  const launch = objectBody(OPS_CONFIG, "SETTINGS_V3_LAUNCH");
  const claim = objectBody(OPS_CONFIG, "CLAIM_POLICY");

  it("the fee caps written into the contracts", () => {
    expect(decimals(solConstant(STAKER_SOL, "MAX_SWAP_FEE_BPS"), 2)).toBe(FAQ_FACTS.caps.swapFeePct);
    expect(decimals(solConstant(STAKER_SOL, "MAX_DEPOSIT_FEE_USDC"), 6)).toBe(FAQ_FACTS.caps.depositFeeUsd);
    expect(decimals(solConstant(VAULT_SOL, "MAX_REWARD_CUT_BPS"), 2)).toBe(FAQ_FACTS.caps.rewardCutPct);
  });

  it("the fixed delays written into the contracts", () => {
    expect(solConstant(BASE_SOL, "REGISTRY_DELAY")).toBe(BigInt(FAQ_FACTS.registryDelayDays) * DAY);
    expect(solConstant(VAULT_SOL, "KEEPER_FALLBACK")).toBe(BigInt(FAQ_FACTS.keeperFallbackDays) * DAY);
    expect(solConstant(VAULT_SOL, "REWARD_VESTING")).toBe(BigInt(FAQ_FACTS.vestingDays) * DAY);
  });

  it("the keeper's claim policy", () => {
    expect(decimals(field(claim, "claimCostTao"), 18)).toBe(FAQ_FACTS.claim.costTao);
    expect(Number(field(claim, "claimMultiple"))).toBe(FAQ_FACTS.claim.multiple);
    expect(Number(field(claim, "monthlyClaimMaxUsd"))).toBe(FAQ_FACTS.claim.maxCostUsd);
    const month = OPS_REWARDS.match(/const MONTH = (\d+) \* DAY;/);
    expect(Number(month?.[1])).toBe(FAQ_FACTS.claim.everyDays);
  });

  it("the payout delays the cadences deploy with", () => {
    expect(Number(field(launch, "payoutDelay"))).toBe(FAQ_FACTS.payoutDelayH.launch * 3_600);
    expect(Number(field(v3, "payoutDelay"))).toBe(FAQ_FACTS.payoutDelayH.test * 3_600);
  });

  it("the batch intervals the cadences deploy with: when anyone may send a batch", () => {
    expect(Number(field(launch, "batchInterval"))).toBe(FAQ_FACTS.batchIntervalS.launch);
    expect(Number(field(v3, "batchInterval"))).toBe(FAQ_FACTS.batchIntervalS.test);
  });

  it("the fees and limits the v3 deployment is set up with", () => {
    expect(decimals(field(v3, "depositFeeUsdc"), 6)).toBe(FAQ_FACTS.depositFeeUsd);
    expect(decimals(field(v3, "swapFeeBps"), 2)).toBe(FAQ_FACTS.swapFeePct);
    expect(decimals(field(v3, "rewardCutBps"), 2)).toBe(FAQ_FACTS.rewardCutPct);
    expect(decimals(field(v3, "redeemRequestFee"), 18)).toBe(FAQ_FACTS.requestFeeEth);
    expect(decimals(field(v3, "minDeposit"), 18)).toBe(FAQ_FACTS.minStakeTao);
    expect(decimals(field(v3, "maxBatchValue"), 18)).toBe(FAQ_FACTS.maxBatchTao);
  });

  it("the launch's unstake limits (deployments.json) as ops sets up its vault", () => {
    const limits = objectBody(OPS_CONFIG, "LAUNCH_VAULT_LIMITS").replace(/\bTAO\b/g, "10n ** 18n");
    const u = EXPECTED_DEPLOYMENTS["v3-launch"].unstakeLimits!;
    expect(decimals(field(limits, "maxEntryValue"), 18)).toBe(u.maxEntryTao);
    expect(decimals(field(limits, "maxDailyOutflowBps"), 2)).toBe(u.dailyOutflowPct);
    expect(decimals(field(limits, "minDailyOutflow"), 18)).toBe(u.dailyFloorTao);
  });

  it("the request fee's cap, the deposit cap and the hard limits the early answers name", () => {
    expect(decimals(solConstant(FRONT_DOOR_SOL, "MAX_REDEEM_REQUEST_FEE"), 18)).toBe(FAQ_FACTS.caps.requestFeeEth);
    expect(decimals(field(v3, "depositCap"), 18)).toBe(FAQ_FACTS.depositCapTao);
    const h = FAQ_FACTS.hardLimits;
    expect(solConstant(VAULT_SOL, "MIN_PAYOUT_DELAY")).toBe(BigInt(h.payoutDelayMinH) * 3_600n);
    expect(VAULT_SOL).toContain(`if (delay < MIN_PAYOUT_DELAY || delay > ${h.payoutDelayMaxDays} days) revert InvalidParameter();`);
    expect(decimals(solConstant(VAULT_SOL, "MAX_OUTFLOW_BPS"), 2)).toBe(h.outflowMaxPct);
    expect(decimals(solConstant(VAULT_SOL, "MAX_MIN_DAILY_OUTFLOW"), 18)).toBe(h.outflowFloorMaxTao);
    expect(decimals(solConstant(FRONT_DOOR_SOL, "MAX_BATCH_VALUE"), 18)).toBe(h.batchMaxTao);
  });

  it("the site's own minimum unstake and the pools' fees", () => {
    expect(FAQ_FACTS.minUnstakeTao).toBe(decimals(MIN_UNSTAKE_WEI_V3, 18));
    expect(FAQ_FACTS.poolFeePct).toBe(POOL_FEE_PCT);
    expect(POOL_FEES_TEXT).toBe(`about ${POOL_FEE_PCT}%`);
    // USDC –fee→ WETH –fee→ TAO: the two fee tiers in the route the stake swaps through
    const tiers = [PATH_USDC_TO_TAO.slice(42, 48), PATH_USDC_TO_TAO.slice(88, 94)].map((h) => parseInt(h, 16));
    expect(tiers).toEqual([500, 3_000]);
    const kept = tiers.reduce((k, t) => k * (1 - t / 1e6), 1);
    expect(Number(((1 - kept) * 100).toFixed(2))).toBe(POOL_FEE_PCT);
  });
});

// ---- Task 59b: "See your TAO in your wallet" (both deployments) and the way out on Bittensor (v3.2 only) ----

describe("the FAQ's wallet and emergency answers (Task 59b)", () => {
  /** v3-launch as the site is built for it, with the two lenses that make a v3.2 deployment (config.isV32). */
  const V32_SITE = {
    ...LAUNCH_SITE,
    vaultLens: "0x000000000000000000000000000000000000Ae15",
    doorLens: "0x000000000000000000000000000000000000De15",
  } as Deployment;

  it("tells every deployment how to see its TAO in the wallet: ForeverMoney's TAO on Base, from the site's config", () => {
    for (const d of [...ALL, V32_SITE]) {
      const item = items(d).find((i) => i.id === "see-your-tao")!;
      expect(item.q).toBe("See your TAO in your wallet");
      expect(item.action).toBe("add-fm-tao");
      expect(faqSections(d).find((s) => s.items.some((i) => i.id === "see-your-tao"))?.id).toBe("chains");
      expect(item.a.join(" ")).toContain(`address ${TOKENS.tao}, symbol TAO, 18 decimals`);
    }
    expect(answer(LAUNCH_SITE, "see-your-tao")).toBe(
      `TAO you claim or cancel back on Base is ForeverMoney's TAO, which many wallets don't show until you add it. Use Add to wallet below, or add it by hand on Base: address ${TOKENS.tao}, symbol TAO, 18 decimals.`,
    );
    // the only answer with a button
    expect(items(V32_SITE).filter((i) => i.action !== undefined).map((i) => i.id)).toEqual(["see-your-tao"]);
  });

  it("points a v3.2 holder to the way out on Bittensor, and v3-launch's never", () => {
    expect(answer(V32_SITE, "withdraw-on-bittensor")).toBe(
      "Yes, with a regular wallet such as MetaMask, unless the vault is paused. If unstaking through Base ever stops, for example because ForeverMoney's TAO fails, you can [withdraw on Bittensor](/unstake/bittensor/): your stake comes straight from the vault as TAO, to the same address there, with no bridge, no daily limit and no waiting period. You need about 0.02 TAO on Bittensor for the network fee, most of it not spent, and you pay the small cost of unstaking. Contract wallets (smart wallets) can't use it: they have to wait for the Base route.",
    );
    expect(items(V32_SITE).find((i) => i.id === "withdraw-on-bittensor")?.q).toBe("Can I withdraw without Base?");
    for (const d of ALL) {
      expect(items(d).some((i) => i.id === "withdraw-on-bittensor")).toBe(false);
      expect(items(d).some((i) => i.a.some((p) => p.includes("/unstake/bittensor/")))).toBe(false);
    }
  });
});

// ---- Task 60: the FAQ follows the deployment (Task 58, concern 5), and a retired one ----

describe("the FAQ on v3.2 and on a retired deployment (Task 60)", () => {
  const V32_SITE = { ...LAUNCH_SITE, vaultLens: "0x000000000000000000000000000000000000Ae15", doorLens: "0x000000000000000000000000000000000000De15" } as Deployment;
  const DAY_S = 86_400;
  const vesting = (d: Deployment, o?: FaqOptions) => ["how-rewards-arrive", "leave-before-collection"].map((id) => answer(d, id, o)).join(" ");

  it("on v3.2 says the vesting period the lens reads, never v3-launch's 7 days", () => {
    const three = { vestingS: 3 * DAY_S };
    expect(answer(V32_SITE, "how-rewards-arrive", three)).toContain("The other 90% is added to balances gradually over 3 days, so it goes only to people still staked as it's added.");
    expect(answer(V32_SITE, "leave-before-collection", three)).toBe(
      "You leave them behind. Rewards still waiting to be collected stay with the people who remain staked. So do collected rewards that are still being added to balances over 3 days. With monthly collections that's up to about 5 weeks of yield. While collections are rarer, it can be more.",
    );
    // the owner's longest, 30 days: about 9 weeks
    expect(answer(V32_SITE, "leave-before-collection", { vestingS: 30 * DAY_S })).toContain("over 30 days");
    expect(answer(V32_SITE, "leave-before-collection", { vestingS: 30 * DAY_S })).toContain("up to about 9 weeks of yield");
    // not read yet (the static page, before the lens answers): no figure, and never v3-launch's
    const unread = vesting(V32_SITE);
    expect(unread).not.toMatch(/7 days|5 weeks/);
    expect(answer(V32_SITE, "how-rewards-arrive")).toContain("The other 90% is added to balances gradually over a period Cascade sets, from 1 to 30 days, so it goes only to people still staked as it's added.");
    expect(answer(V32_SITE, "leave-before-collection")).toBe(
      "You leave them behind. Rewards still waiting to be collected stay with the people who remain staked. So do collected rewards that are still being added to balances over a period Cascade sets (1 to 30 days). With monthly collections that's up to about a month of yield plus that period. While collections are rarer, it can be more.",
    );
  });

  it("R6b (U1, U2): on v3.2 every validator's rewards are collected together at least every 28 days, whatever it costs; only Cascade collects while rewards are still being added", () => {
    const a = answer(V32_SITE, "how-often-collected", { stage: "testing" });
    expect(a).toContain(`Each collection costs about ${FAQ_FACTS.claim.costTao} TAO in network fees, paid by Cascade. Cascade collects every validator's rewards together at least every 28 days, and sooner once the rewards waiting are worth at least 25 times that.`);
    expect(a).toContain("During testing they're run by hand.");
    expect(a).not.toMatch(/many months apart|\$20/);
    expect(items(V32_SITE).find((i) => i.id === "if-cascade-is-down")!.a).toEqual([
      "Your funds stay where they are, but exits slow down. Most steps that Cascade's systems run can be done by anyone instead.",
      "Anyone can send a batch or a payout once it's due, with a transaction on Base or Bittensor that pays its bridge fee or gas. After 7 days, anyone can do the staking step. Anyone can collect rewards once the rewards already collected have all been added to balances (up to 30 days).",
      "Once your TAO is back on Base you can claim it yourself from your receipt. Only selling it to USDC for you needs Cascade's systems.",
    ]);
    // v3-launch's answers are as they were
    expect(answer(LAUNCH_SITE, "how-often-collected")).toContain("collections can be many months apart");
    expect(answer(LAUNCH_SITE, "if-cascade-is-down")).toContain("Staking and reward collection open to anyone after 7 days");
    // the keeper's round, from ops' source: CLAIM_GAP_MAX_S (30 days) less CLAIM_LEAD_S
    const lead = OPS_REWARDS.match(/export const CLAIM_LEAD_S = (\d+) \* DAY;/);
    expect(FAQ_FACTS.claim.everyDays - Number(lead?.[1])).toBe(FAQ_FACTS.v32.claimRoundDays);
  });

  it("on v3.2 the leaving answer says the running schedule's period while it is the longer one, after a lowering (review, Minor 4)", () => {
    // the owner lowered it to 3 days while a 10-day schedule still runs: what is still being added takes up to 10
    const lowered = { vestingS: 3 * DAY_S, vestingPeriodS: 10 * DAY_S };
    expect(answer(V32_SITE, "leave-before-collection", lowered)).toBe(
      "You leave them behind. Rewards still waiting to be collected stay with the people who remain staked. So do collected rewards that are still being added to balances over 10 days. With monthly collections that's up to about 6 weeks of yield. While collections are rarer, it can be more.",
    );
    // how rewards arrive is the owner's setting, what the next schedule takes
    expect(answer(V32_SITE, "how-rewards-arrive", lowered)).toContain("gradually over 3 days");
    // the running one shorter, or none before the first claim (0): the owner's, as before
    for (const vestingPeriodS of [DAY_S, 0, undefined]) {
      expect(answer(V32_SITE, "leave-before-collection", { vestingS: 3 * DAY_S, vestingPeriodS }), String(vestingPeriodS)).toContain("still being added to balances over 3 days");
    }
    // nothing read: no figure, whatever the running one says alone
    expect(answer(V32_SITE, "leave-before-collection", { vestingPeriodS: 10 * DAY_S })).toContain("over a period Cascade sets (1 to 30 days)");
    // v3-launch: its 7 days, whatever is passed
    expect(answer(LAUNCH_SITE, "leave-before-collection", lowered)).toBe(answer(LAUNCH_SITE, "leave-before-collection"));
  });

  it("on v3.2 the leaving answer says an adopted gift's own drip while it runs and is the longest (Revision 27)", () => {
    // a gift adopted onto a 10-day drip before the owner lowered the period to 3 days: still being added for up to 10
    const gift = { vestingS: 3 * DAY_S, vestingPeriodS: 3 * DAY_S, adoptVestingPeriodS: 10 * DAY_S };
    expect(answer(V32_SITE, "leave-before-collection", gift)).toBe(
      "You leave them behind. Rewards still waiting to be collected stay with the people who remain staked. So do collected rewards that are still being added to balances over 10 days. With monthly collections that's up to about 6 weeks of yield. While collections are rarer, it can be more.",
    );
    // how rewards arrive is still the owner's setting: an adoption never moves the claimed rewards' schedule
    expect(answer(V32_SITE, "how-rewards-arrive", gift)).toContain("gradually over 3 days");
    // the longest of the three: the claim schedule's when it is longer; the owner's when the drip is shorter, ended (0)
    // or unread
    expect(answer(V32_SITE, "leave-before-collection", { ...gift, vestingPeriodS: 12 * DAY_S })).toContain("still being added to balances over 12 days");
    for (const adoptVestingPeriodS of [DAY_S, 0, undefined]) {
      expect(answer(V32_SITE, "leave-before-collection", { vestingS: 3 * DAY_S, adoptVestingPeriodS }), String(adoptVestingPeriodS)).toContain("still being added to balances over 3 days");
    }
    // the owner's period not read: no figure, whatever the drip says alone
    expect(answer(V32_SITE, "leave-before-collection", { adoptVestingPeriodS: 10 * DAY_S })).toContain("over a period Cascade sets (1 to 30 days)");
    // v3-launch has no adoption drip: its 7 days, whatever is passed
    expect(answer(LAUNCH_SITE, "leave-before-collection", gift)).toBe(answer(LAUNCH_SITE, "leave-before-collection"));
  });

  it("keeps v3-launch's 7 days, the constant in its vault, whatever a read says", () => {
    for (const d of ALL) expect(vesting(d as Deployment, { vestingS: 3 * DAY_S })).toBe(vesting(d as Deployment));
    expect(answer(LAUNCH_SITE, "how-rewards-arrive")).toContain("gradually over 7 days");
    expect(answer(LAUNCH_SITE, "leave-before-collection")).toContain("up to about 5 weeks of yield");
  });

  it("words a retired deployment as the stage it was retired from: early (v3-launch) or live, never assumed (follow-up)", () => {
    const ids = ["audited", "who-controls", "take-funds", "risks", "how-often-collected", "limits"];
    for (const was of ["early", "live", "testing"] as const) {
      for (const id of ids) expect(answer(LAUNCH_SITE, id, { stage: "retired", retiredFrom: was }), `${was} ${id}`).toBe(answer(LAUNCH_SITE, id, { stage: was }));
    }
    // retired from live: the multisig and its delay, never the founder's Ledger
    const live = items(LAUNCH_SITE, { stage: "retired", retiredFrom: "live" }).flatMap((i) => i.a).join("\n");
    expect(live).toContain("The owner is a multi-signature wallet");
    expect(live).not.toContain("hardware wallet (a Ledger)");
    // a retired entry that doesn't say what it was retired from: fails closed to the testing wording
    for (const was of [undefined, "Live", "retired"] as unknown as ("early" | "live")[]) {
      expect(answer(LAUNCH_SITE, "who-controls", { stage: "retired", retiredFrom: was })).toBe(answer(LAUNCH_SITE, "who-controls", { stage: "testing" }));
    }
  });
});

// ---- the web copy audit (2026-11-11): the FAQ brought to v3.2 ----

describe("the FAQ on v3.2: the timelock, the one-day hold, ForeverMoney's pause, the keys, the daily limit, parks (the web copy audit)", () => {
  const V32_SITE = { ...LAUNCH_SITE, vaultLens: "0x000000000000000000000000000000000000Ae15", doorLens: "0x000000000000000000000000000000000000De15" } as Deployment;
  const EARLY = { stage: "early" } as const;
  const STAGES = ["testing", "early", "live"] as const;
  const NEW = ["deposit-not-delivered", "unstake-after-deposit", "daily-limit", "unstake-not-processed", "change-notice", "stolen-keys", "forevermoney-pause", "validator-key-change"];
  const paragraphs = (id: string, o: FaqOptions = EARLY) => items(V32_SITE, o).find((i) => i.id === id)!.a;
  const line = (id: string, start: string, o: FaqOptions = EARLY) => paragraphs(id, o).find((p) => p.startsWith(start));

  it("adds v3.2's questions where they belong, two of them under the forms, and none on any other deployment", () => {
    const sections = faqSections(V32_SITE, EARLY);
    const ids = (id: string) => sections.find((s) => s.id === id)!.items.map((i) => i.id);
    expect(ids("timing")).toEqual(["how-long-to-stake", "send-sooner", "deposit-not-delivered", "how-to-unstake", "unstake-after-deposit", "daily-limit", "unstake-not-processed", "lock-up", "usdc-not-arrived", "cancel", "limits"]);
    expect(ids("safety")).toEqual(["audited", "who-controls", "change-notice", "stolen-keys", "take-funds", "risks", "if-cascade-is-down", "forevermoney-pause", "withdraw-on-bittensor", "validator-key-change", "check-my-stake", "report-a-problem"]);
    expect(appFaq(sections).map((i) => i.id)).toEqual(["what-is-cascade", "bittensor-wallet", "cascade-fees", "how-long-to-stake", "how-to-unstake", "unstake-after-deposit", "unstake-not-processed", "lock-up"]);
    for (const d of ALL) for (const stage of STAGES) expect(items(d, { stage }).filter((i) => NEW.includes(i.id)), stage).toEqual([]);
    // the keys answer describes the early stage's one hardware wallet, not a multisig owner or testing's one team key
    for (const stage of ["testing", "live"] as const) expect(items(V32_SITE, { stage }).some((i) => i.id === "stolen-keys"), stage).toBe(false);
  });

  it("R11: Can I cancel? says a deposit can be cancelled 5 minutes after it is made, that more deposited for the address starts the 5 minutes again, that a batch leaving within them ends the chance, and at once while deposits are paused (build B); v3-launch's answer stays as it was", () => {
    expect(paragraphs("cancel")).toEqual([
      "Yes, until your batch leaves. Deposits and unstake requests travel to Bittensor in groups, called batches.",
      "A deposit can be cancelled from 5 minutes after you make it. If more is deposited for your address before the batch leaves, by you or as a gift from someone else, the 5 minutes start again. If the batch leaves within those 5 minutes, the deposit can no longer be cancelled. While deposits are paused, it can be cancelled at once. A cancelled deposit comes back as TAO, not USDC, and the fees already paid aren't refunded.",
      "If you cancel an unstake, you keep your balance but not the request fee.",
    ]);
    for (const d of ALL) {
      expect(items(d, EARLY).find((i) => i.id === "cancel")!.a).toEqual([
        "Yes, until your batch leaves. A cancelled deposit comes back as TAO, not USDC, and the fees already paid aren't refunded. A cancelled unstake keeps your balance but not the request fee.",
      ]);
    }
  });

  it("titles the section Risks and control, on every deployment, and never says safety", () => {
    for (const d of [...ALL, V32_SITE]) {
      expect(faqSections(d).find((s) => s.id === "safety")?.title).toBe("Risks and control");
      for (const stage of STAGES) expect(items(d, { stage }).flatMap((i) => [i.q, ...i.a]).join("\n")).not.toMatch(/safe|safety/i);
    }
  });

  it("links only to this site or the sources it names, its own links landing on a question", () => {
    const ids = new Set(items(V32_SITE, EARLY).map((i) => i.id));
    for (const stage of STAGES) {
      for (const item of items(V32_SITE, { stage })) {
        for (const part of item.a.flatMap((p) => parseInlineLinks(p))) {
          if (!part.href) continue;
          if (!part.href.startsWith("/")) {
            expect(HOSTS, `${item.id}: ${part.href}`).toContain(new URL(part.href).host);
            continue;
          }
          const [page, hash] = part.href.split("#");
          expect(["/unstake/", "/unstake/bittensor/", "/security/", "/rewards/", "/faq/"], `${item.id}: ${part.href}`).toContain(page);
          if (hash !== undefined) expect(ids, `${item.id}: ${part.href}`).toContain(hash);
        }
      }
    }
  });

  it("never says there is no timelock, and says each kind of change's wait", () => {
    for (const stage of STAGES) {
      const text = items(V32_SITE, { stage }).flatMap((i) => i.a).join("\n");
      expect(text, stage).not.toMatch(/timelock yet|no timelock|pays less|balances read low|in a rare migration|fully backed when we checked/i);
    }
    expect(paragraphs("who-controls")).toEqual([
      "The founder, through one hardware wallet. Cascade's contracts are owned by the founder's hardware wallet (a Ledger) on Base and on Bittensor. There is no multisig yet: one hardware wallet owns the contracts. A second key, the guardian, can pause, veto a new route, and switch off the current one. A route is the bridge and front door that TAO travels through. For now the guardian is a second account on the same hardware wallet, so it is not an independent check yet. The guardian can never move anyone's money.",
      "The owner key can change settings: fees up to their caps, the limits, the wait before payouts and the validator. The swap fee, the deposit fee and the request fee can change at once, up to their caps. Other changes that loosen a protection can't happen at once. They are announced on-chain first and wait: 48 hours for a setting (a higher limit, a higher reward cut, a shorter waiting period, a different validator), 7 days for a new bridge or front door, and 8 days for a new owner or guardian. Turning a route back on takes the same 7 days' public notice as a new one. Changes that tighten a protection, and a pause, take effect at once.",
      "Cascade can also pause in an emergency. A pause can't move anyone's funds. Pausing the front door, Cascade's contract on Base, stops new deposits and the automatic sale to USDC. You can still ask to unstake, cancel, and claim TAO that's already back. Pausing the vault, Cascade's contract on Bittensor, holds everything until it's lifted: deposits on their way wait, payouts wait, and direct withdrawals stop.",
      "Whatever the owner does, hard limits in the contracts hold. Every fee has a fixed maximum. The wait before a payout stays between 1 hour and 48 hours. No batch can carry more than 5,000 TAO. The daily unstake limit can't be set below 20% of the staked TAO (or 10 TAO) or above half of it (or 100 TAO).",
    ]);
    // the other stages keep their own first paragraph (what the owner can change, what a pause holds) and their own second
    for (const stage of ["testing", "live"] as const) {
      expect(paragraphs("who-controls", { stage })[0], stage).toBe(
        "An owner key can change settings: fees up to their caps, the limits, the wait before payouts and the validator. Cascade can also pause in an emergency. Pausing the front door on Base stops new deposits and the automatic sale to USDC; you can still ask to unstake, cancel, and claim TAO that's already back. Pausing the vault on Bittensor holds everything until it's lifted: deposits on their way wait, payouts wait, and direct withdrawals stop. A pause can't move anyone's funds.",
      );
    }
    expect(paragraphs("who-controls", { stage: "live" })[1]).toBe(
      "The owner is a multi-signature wallet. Changes that loosen a protection wait in public: 48 hours for a setting, 7 days for a new bridge or front door, 8 days for a new owner or guardian. Tightenings and pauses are immediate.",
    );
    expect(answer(V32_SITE, "change-notice", EARLY)).toBe(
      "Changes that loosen a protection are announced on-chain and wait before they can take effect: 48 hours for a setting, 7 days for a new bridge or front door or for turning a switched-off one back on, 8 days for a new owner or guardian. The guardian can cancel most of them during the wait. Changes that tighten a protection, and a pause, apply at once. The [security page](/security/) shows any change that is waiting.",
    );
    // the two ways to unstake in a new route's notice, named on v3.2 only
    expect(paragraphs("take-funds")[0]).toBe(
      "Not instantly, and not quietly. TAO leaves the vault only through the bridge and front door set up at launch, or when a share owner withdraws directly on Bittensor. Adding a new route needs 7 days' public notice, in which the guardian can veto it and you have time to unstake if you disagree, through Base within the daily limit or directly on Bittensor with a regular wallet. The guardian is a separate key from the owner, but Cascade holds both for now, so that veto isn't independent yet.",
    );
    expect(paragraphs("take-funds")[1]).toBe(
      "Every fee is capped in the code, and you see each one before you confirm. Raising the reward cut takes 48 hours' public notice. The swap fee, the deposit fee and the unstake request fee can change at once, but only up to their caps, and the minimum price you approve still protects each swap. Everything happens on-chain where anyone can check it.",
    );
    expect(answer(V32_SITE, "validator", EARLY)).toContain("Cascade can move the stake to another validator, with 48 hours' public notice; the move needs no unstaking and costs you nothing.");
  });

  it("names the risks as they are on v3.2: the timelock, the stolen keys, the bridges, the validator", () => {
    expect(line("risks", "Control:")).toBe(
      "Control: the owner is one hardware wallet, with no multisig yet. Changes that loosen a protection wait 48 hours to 8 days in public; pauses and tightenings are immediate. If that wallet's keys were stolen, exits could be frozen or badly limited. [Who controls Cascade](/faq/#who-controls).",
    );
    expect(line("risks", "Control:", { stage: "live" })).toBe(
      "Control: the owner is a multi-signature wallet. Changes that loosen a protection wait in public: 48 hours for a setting, 7 days for a new bridge or front door, 8 days for a new owner or guardian. Tightenings and pauses are immediate. [Who controls Cascade](/faq/#who-controls).",
    );
    expect(line("risks", "Bridges:")).toBe(
      "Bridges: TAO crosses over Chainlink CCIP, and the TAO used on Base is issued by [ForeverMoney](https://forevermoney.ai/). If either has trouble, deposits and payouts wait. Staked TAO sits on Bittensor and isn't theirs to touch; what depends on ForeverMoney is TAO on Base or on its way, and getting out through Base. If the bridge itself were compromised, forged unstakes are limited to a day's allowance and wait 24 hours before paying, so they can be cancelled.",
    );
    expect(line("risks", "Validator:")).toBe(
      "Validator: if the validator moves its stake to a new key, deposits and unstakes wait until that key is listed, which Cascade or, failing that, anyone can do. A direct withdrawal on Bittensor in that window pays the lower price, and only if you agree to it.",
    );
    expect(paragraphs("stolen-keys")).toEqual([
      "A thief could not take the staked TAO at once, but could freeze exits. The owner key and the guardian key sit on one hardware wallet for now, so a thief who copied it would have both. Sending the staked TAO anywhere new needs 7 days' public notice.",
      "With both keys the thief could pause, which freezes exits without moving funds. And during the notice, the daily limit means only part of the stake can leave through Base. In the worst case we've modelled, that part is about a third. It could be little or none if the thief fills the queue with their own requests.",
      "A regular wallet can withdraw on Bittensor directly, with no limit, unless the vault is paused. This is the main reason to deposit only what you could afford to lose until the owner is a multi-signature wallet.",
    ]);
    expect(answer(V32_SITE, "validator-key-change", EARLY)).toBe(
      "Validators sometimes move to a new key. When that happens the vault sees stake missing and, rather than price anyone's shares low, holds deposits and unstakes until the new key is listed. Cascade lists it; if Cascade is down, anyone can. A direct withdrawal on Bittensor still works in that window if you accept the lower price it would pay.",
    );
    expect(answer(V32_SITE, "forevermoney-pause", EARLY)).toBe(
      "The TAO used on Base is issued by ForeverMoney. If they pause, or announce a move to new contracts, Cascade stops processing unstakes through Base from that moment: a request isn't processed, and you keep your stake, so nothing is sent into a route that can't pay. A pause lifts on their side. After a move, unstakes through Base resume once Cascade has a replacement bridge live, which takes at least 7 days' public notice. Meanwhile a regular wallet can [withdraw on Bittensor](/unstake/bittensor/); a contract wallet has to wait. Your staked TAO stays on Bittensor throughout.",
    );
  });

  it("says the one-day hold, the shared daily limit, and what a deferred or trimmed unstake means", () => {
    expect(paragraphs("lock-up")).toEqual([
      "No fixed lock-up. But a new deposit can't be unstaked through Base for about a day after it's staked. After that you can unstake whenever you like; it takes the time given in [How do I unstake](/faq/#how-to-unstake) to come back.",
      "A few things can make an unstake wait. The daily unstake limit: anything over it stays staked, for you to unstake again later. An emergency pause: it holds unstakes for as long as it lasts. Cascade's route being switched off: turning it back on takes at least 7 days' public notice. The route is the bridge and front door your TAO travels through.",
      "Two things outside Cascade can also make it wait. If ForeverMoney, which issues the TAO used on Base, pauses or announces a move to new contracts, unstakes through Base stop until that is resolved, and you keep your stake. If the validator changes its key, unstakes wait until the new key is listed, which Cascade or, failing that, anyone can do.",
      "In most of these cases a regular wallet can still [withdraw on Bittensor](/unstake/bittensor/).",
    ]);
    // "no lock-up" is said of Bittensor only, with Cascade's own waits a link away
    expect(paragraphs("what-is-root-staking")[0]).toBe(
      "Staking means putting TAO with a validator, an operator that helps run the network, in return for a share of the TAO the network pays out. Bittensor itself has no lock-up; Cascade's own waits are in [Is there a lock-up?](/faq/#lock-up). Staked directly, your TAO stays under your own key; through Cascade, its vault stakes the TAO and you hold shares in the vault.",
    );
    // and only the wallet the shares belong to unstakes them: a gift's are not the depositor's
    expect(paragraphs("token")).toEqual([
      "Not one you can send or trade. Your deposit is recorded as shares in Cascade's vault on Bittensor, shown in the app as your TAO balance. Only the wallet the shares belong to can unstake them.",
    ]);
    expect(paragraphs("unstake-after-deposit")).toEqual([
      "Not through Base for about a day. Shares from a new deposit are held for a day before they can be unstaked through Base. Shares already past their day aren't affected.",
      "If you deposit again while an earlier deposit is still inside its day, the day is counted from a blend of the two, weighted by size. A small top-up barely moves it, and a large one nearly restarts it.",
      "A request made too early isn't processed: you keep your stake and ask again, and the request fee is paid again. With a regular wallet you can [withdraw on Bittensor](/unstake/bittensor/) without the wait.",
    ]);
    // V32_SITE isn't listed in deployments.json, so these are the launch's limits (ops/src/v32/settings.ts)
    expect(answer(V32_SITE, "daily-limit", EARLY)).toBe(
      "Unstakes through Base are limited to 20% of the staked TAO a day, or 10 TAO if that's more, shared by everyone, first come first served. One request can take at most 10 TAO. If the day's allowance is used up before your request arrives, the rest stays staked and you ask again, paying the request fee again. The Unstake form shows roughly how much is left today; it's a guide, not a reservation, because others may get there first. Withdrawing directly on Bittensor has no limit.",
    );
    // the least the vault unstakes through Base (0.03 TAO), under the least the form asks for (0.033 TAO); a request
    // that is dropped (ask again) apart from one that waits (don't)
    expect(paragraphs("unstake-not-processed")).toEqual([
      "Usually for one of three reasons. Your deposit was less than a day old. The day's limit, or the 10 TAO limit per request, was reached, so only part went through. Or the amount was worth less than 0.03 TAO when it arrived, the least the vault unstakes through Base (the form asks for at least 0.033 TAO to leave room for that).",
      "It also happens when a request reaches Bittensor while the bridge can't send payouts. That is the case while ForeverMoney is paused or moving to new contracts.",
      "In each case what wasn't unstaked is still yours and still staked; ask again later. The request fee isn't refunded.",
      "An emergency pause, a validator key change or Cascade's route being switched off is different. Your request waits. Don't ask again unless your receipt says it was dropped.",
    ]);
    expect(paragraphs("how-to-unstake")).toEqual([
      "Open [Unstake](/unstake/) and enter how much USDC you want. All in, it can take up to about 2 days, usually less. The form shows the expected time.",
      "Your request travels to Bittensor in the next batch, a group sent together. It then waits out a 24-hour waiting period. After that your TAO comes back to Base, where it's sold for USDC and the USDC is sent to your wallet.",
      "The sale is made at today's price less 2% or better. If TAO falls further than that, your TAO waits for you to claim it instead.",
      "If your request can't be processed when it arrives, nothing is taken from your stake. That happens when your deposit is less than a day old, the day's limit is used up, or the bridge can't send payouts. You ask again later, and the request fee is paid again.",
    ]);
  });

  it("W14 in the limits answer: the daily limit shared first come and no remainder too small, from the deployment's limits or, while it lists none, the launch's", () => {
    // V32_SITE isn't listed in deployments.json (v3.2's entry comes at Task 69): the launch's limits (ops/src/v32/settings.ts)
    expect(paragraphs("limits")).toEqual([
      "Yes, both. The smallest stake is 0.04 TAO (the stake form shows it in dollars). The smallest unstake is 0.033 TAO.",
      "Deposits: one batch, the group of deposits that travels to Bittensor together, carries at most 10 TAO. While Cascade is early, total deposits are capped at 40 TAO.",
      "Unstakes: one unstake carries at most 10 TAO. Unstakes through Base are also limited to 20% of the staked TAO a day, or 10 TAO if that's more. That daily limit is shared, first come first served.",
      "Anything over a limit stays staked. You unstake it again later and pay the request fee again. You are never left with a remainder too small to unstake. Only deposit what you could afford to lose.",
    ]);
    // at the other stages v3.2 says its smallest amounts and the batch's most, and names no cap or limit it doesn't quote
    for (const stage of ["testing", "live"] as const) {
      expect(answer(V32_SITE, "limits", { stage }), stage).toBe(
        "The smallest stake is 0.04 TAO (the stake form shows it in dollars), the smallest unstake 0.033 TAO. One batch carries at most 10 TAO, and while Cascade is new the total it accepts is capped.",
      );
    }
    // (an entry that lists its own limits is read by the same `lim` the daily-limit answer reads; v3-launch's is pinned above)
  });

  it("v3.2's testing-stage lines say the contracts' waits too: a change that loosens a protection never takes effect at once there either", () => {
    const testing = { stage: "testing" as const };
    const controls = answer(V32_SITE, "who-controls", testing);
    expect(controls).toContain(
      "Cascade is in testing: one team key holds every role. Changes that loosen a protection still wait in public: 48 hours for a setting, 7 days for a new bridge or front door, 8 days for a new owner or guardian; tightenings and pauses are immediate. The plan for the public launch is a multi-signature owner.",
    );
    const risks = faqSections(V32_SITE, testing).flatMap((s) => s.items).find((i) => i.id === "risks")!.a;
    expect(risks).toContain("Control: during testing one team key holds every role. Changes that loosen a protection wait 48 hours to 8 days in public; pauses and tightenings are immediate. [Who controls Cascade](/faq/#who-controls).");
    const text = items(V32_SITE, testing).flatMap((i) => i.a).join("\n");
    expect(text).not.toMatch(/its changes take effect at once|settings change at once/);
    // v3-launch's testing lines are its own (its contracts have no timelock)
    expect(answer(TEST, "who-controls", testing)).toContain("one team key holds every role, and its changes take effect at once");
  });

  it("says what a parked deposit, the bridge fee back and the backing are on v3.2", () => {
    expect(answer(V32_SITE, "deposit-not-delivered", EARLY)).toBe(
      "If your deposit reaches Bittensor but the vault can't take it (for example during a pause), it waits there, set aside for you, and is delivered as soon as it can be. If it still can't be delivered after 14 days, it is sent back to Base as TAO for you to claim, and Cascade pays that bridge fee. Until your batch leaves Base you can also just cancel. One rare case: if Bittensor raised its minimum stake above the size of a small deposit, a refund that small could wait until the minimum comes back down.",
    );
    expect(paragraphs("other-costs")).toEqual([
      `Swap fees, network fees and, when you unstake, a request fee and a bridge fee. Uniswap, the exchange that does the swap, charges pool fees of ${POOL_FEES_TEXT} each way. On top of that comes price impact, which grows with the amount: a larger swap gets a worse price. Network fees on Base are usually a cent or two.`,
      "Cascade pays the bridge fee that carries deposits to Bittensor. To unstake, you pay the 0.0002 ETH request fee and the bridge fee that carries your TAO back to Base. That bridge fee is taken from your TAO and shared when several people unstake together. Your share of it is capped at 1% of the payout or 0.015 TAO, whichever is larger. If the fee is ever higher than that, you pay no more. The payout waits until the fee falls or Cascade pays the difference.",
      "If the vault, Cascade's contract on Bittensor, has to unstake to pay you, the small amount the network keeps comes out of your payout too. The form shows an estimate before you confirm.",
    ]);
    expect(paragraphs("how-long-to-stake")).toEqual([
      "Normally up to 24 hours, plus about 20 minutes to cross. The stake form shows the expected time, and your receipt follows each step.",
      "Deposits travel to Bittensor together in groups called batches, so each batch shares one bridge fee. A batch leaves once the fees it carries cover the trip, and after 24 hours at the latest. It then takes about 20 minutes to cross. Your balance is credited as soon as it arrives.",
    ]);
    expect(answer(V32_SITE, "tao-on-base", EARLY)).toContain("backed by TAO it holds on Bittensor. The [security page](/security/) shows how much backs it right now.");
    expect(answer(V32_SITE, "check-my-stake", EARLY)).toContain("The [security page](/security/) shows the whole route your money takes, with live numbers.");
  });

  it("names v3.2's own request fee (the founder's 0.0002 ETH, 2026-11-16) wherever an answer names the fee, and the fixed costs with it", () => {
    expect(answer(V32_SITE, "bittensor-wallet", EARLY)).toContain("a little ETH there for network fees and the 0.0002 ETH unstake fee");
    expect(answer(V32_SITE, "cascade-fees", EARLY)).toContain("Unstaking: a 0.0002 ETH request fee, which goes toward the bridge fee that carries your request to Bittensor, plus 0.15% when your TAO is sold back to USDC.");
    expect(paragraphs("break-even")).toEqual([
      "It depends on the amount. The stake form shows how long your amount takes to cover its fees at today's yield.",
      "A round trip, staking and later unstaking, costs about 1%, plus fixed fees of about $0.68 all in. The fixed fees are the $0.05 deposit fee, the 0.0002 ETH request fee (about $0.36) and the bridge fee back.",
      // 6.8%, to the nearest percent: never floored to "about 6%"
      "Those fixed fees are about 7% of a $10 stake. So a small amount staked briefly can come back as less than you put in, even if TAO's price doesn't move.",
    ]);
    const text = items(V32_SITE, EARLY).flatMap((i) => i.a).join("\n");
    expect(text).not.toContain("0.0001 ETH");
    // the cap is the contracts' (MAX_REDEEM_REQUEST_FEE), the same on both
    expect(answer(V32_SITE, "cascade-fees", EARLY)).toContain("and 0.001 ETH for the request fee.");
  });

  it("keeps v3-launch's own words where its contracts differ", () => {
    // its own request fee, 0.0001 ETH, and the fixed costs with it
    expect(answer(LAUNCH_SITE, "bittensor-wallet")).toContain("the 0.0001 ETH unstake fee");
    expect(answer(LAUNCH_SITE, "break-even")).toContain(
      "fixed fees of about $0.50 all in. The fixed fees are the $0.05 deposit fee, the 0.0001 ETH request fee (about $0.18) and the bridge fee back. Those fixed fees are about 5% of a $10 stake.",
    );
    expect(answer(LAUNCH_SITE, "how-long-to-stake")).toContain("It then takes about 20 minutes to cross and is staked straight away.");
    expect(answer(LAUNCH_SITE, "tao-on-base")).toContain("fully backed when we checked in October 2026");
    expect(answer(LAUNCH_SITE, "other-costs")).toContain("Every amount is shown before you confirm.");
    expect(answer(LAUNCH_SITE, "validator")).toContain("Cascade can move the stake to another validator if that ever changes;");
    expect(answer(LAUNCH_SITE, "check-my-stake")).not.toContain("/security/");
    expect(items(LAUNCH_SITE).find((i) => i.id === "how-to-unstake")!.a).toHaveLength(2);
    // the answers the clarity pass (2026-11-16) restructured for v3.2 only are word for word what they were
    expect(items(LAUNCH_SITE).find((i) => i.id === "how-long-to-stake")!.a).toEqual([
      "Deposits travel to Bittensor together in batches, which shares the bridge fee. A batch leaves once the fees it carries cover the trip, and after 24 hours at the latest. It then takes about 20 minutes to cross and is staked straight away.",
      "The stake form shows the expected time, and your receipt follows each step.",
    ]);
    expect(answer(LAUNCH_SITE, "how-to-unstake")).toBe(
      "Open [Unstake](/unstake/) and enter how much USDC you want. Your request travels to Bittensor in the next batch, waits out a 24-hour waiting period, and comes back to Base, where it's sold for USDC and sent to your wallet at today's price less 2% or better. If TAO falls further, it waits for you to claim it instead. All in, it can take up to about 2 days, usually less. The form shows the expected time.",
    );
    expect(answer(LAUNCH_SITE, "what-is-root-staking")).toContain("in return for a share of the TAO the network pays out. There's no lock-up. Staked directly, your TAO stays under your own key;");
    expect(answer(LAUNCH_SITE, "token")).toBe(
      "Your deposit is recorded as shares in Cascade's vault on Bittensor, shown in the app as your TAO balance. The shares can't be sent or traded; only the wallet that deposited can unstake them.",
    );
    expect(answer(LAUNCH_SITE, "take-funds")).toContain("you have time to unstake if you disagree. The guardian is a separate key from the owner");
    expect(answer(LAUNCH_SITE, "if-cascade-is-down")).toBe(
      "Your funds stay where they are, but exits slow down. Anyone can send a batch or a payout once it's due, with a transaction on Base or Bittensor that pays its bridge fee or gas. Staking and reward collection open to anyone after 7 days, and once your TAO is back on Base you can claim it yourself from your receipt. Only selling it to USDC for you needs Cascade's systems.",
    );
    expect(items(LAUNCH_SITE).find((i) => i.id === "other-costs")!.a).toEqual([
      `Uniswap's pool fees, ${POOL_FEES_TEXT} each way plus price impact, which grows with the amount, and network fees on Base, usually a cent or two. Cascade pays the bridge fee that carries deposits to Bittensor.`,
      "To unstake there's a 0.0001 ETH request fee, and the bridge fee for the trip back, taken from your TAO and shared when several people unstake together. Every amount is shown before you confirm.",
    ]);
  });

  it("the clarity pass (2026-11-16): on the live site (v3.2-launch) an answer's first words are the answer, and the unclear phrases are gone", () => {
    // the site as it is built: the stage is its entry's (early), and nothing is passed
    const live = items(v32Launch());
    const first = (id: string) => live.find((i) => i.id === id)!.a[0];
    const OPENS: Record<string, string> = {
      "how-long-to-stake": "Normally up to 24 hours, plus about 20 minutes to cross.",
      "break-even": "It depends on the amount.",
      limits: "Yes, both.",
      "lock-up": "No fixed lock-up.",
      "who-controls": "The founder, through one hardware wallet.",
      "leave-before-collection": "You leave them behind.",
      "usdc-not-arrived": "You can claim it yourself from your receipt.",
      "stolen-keys": "A thief could not take the staked TAO at once, but could freeze exits.",
    };
    for (const [id, opening] of Object.entries(OPENS)) expect(first(id).startsWith(opening), `${id}: ${first(id)}`).toBe(true);
    // a request made during ForeverMoney's pause isn't processed: nothing is "set aside" to be done later
    expect(live.find((i) => i.id === "forevermoney-pause")!.a.join(" ")).not.toContain("set aside");
    // and what drops a request is named (the bridge can't send payouts), never as a route or unstaking "on hold": a
    // pause is a hold too, and under a pause the request waits
    const whole = live.flatMap((i) => [i.q, ...i.a]).join("\n");
    expect(whole).not.toContain("the Base route is on hold");
    expect(whole).not.toContain("unstaking through Base is on hold");
  });

  it("the fact check's corrections (2026-11-16): an unstake that was dropped is told apart from one that waits, and no answer promises that Cascade pays a bridge fee over the cap", () => {
    // the live site as it is built, and v3.2 at every stage
    for (const all of [items(v32Launch()), ...STAGES.map((stage) => items(V32_SITE, { stage }))]) {
      const text = (id: string) => all.find((i) => i.id === id)!.a.join(" ");
      // the lock-up answer lists every hold, those that drop a request beside those under which it waits: this answer
      // says which is which itself, and never sends the reader to that list
      expect(text("unstake-not-processed")).not.toContain("/faq/#lock-up");
      expect(text("unstake-not-processed")).toContain("Don't ask again unless your receipt says it was dropped.");
      // over the cap the leaver pays no more and the payout waits, for a lower fee or for Cascade to pay the difference:
      // that Cascade pays is not promised
      expect(text("other-costs")).not.toContain("Cascade pays anything above that");
    }
  });
});

describe("v3.2's numbers match its code (contracts/src, ops/src/v32/settings.ts)", () => {
  const CONSTANTS_V32 = read("../../../contracts/src/CascadeConstants.sol");
  const VAULT_V32 = read("../../../contracts/src/CascadeVault.sol");
  const FRONT_DOOR_V32 = read("../../../contracts/src/CascadeFrontDoor.sol");
  const BIT_ADAPTER_V32 = read("../../../contracts/src/adapters/CcipBittensorAdapter.sol");
  const SETTINGS_V32 = objectBody(read("../../../ops/src/v32/settings.ts"), "SETTINGS_V32_LAUNCH").replace(/\bTAO\b/g, "10n ** 18n");
  const V = FAQ_FACTS.v32;

  it("the owner scheduler's waits", () => {
    expect(solConstant(CONSTANTS_V32, "PARAM_DELAY")).toBe(BigInt(V.delay.settingH) * 3_600n);
    expect(solConstant(CONSTANTS_V32, "REGISTRY_DELAY")).toBe(BigInt(V.delay.routeDays) * DAY);
    expect(solConstant(CONSTANTS_V32, "GUARDIAN_DELAY")).toBe(BigInt(V.delay.rolesDays) * DAY);
  });

  it("the hard limits no owner setting can pass", () => {
    const h = V.hardLimits;
    expect(solConstant(VAULT_V32, "MIN_PAYOUT_DELAY")).toBe(BigInt(h.payoutDelayMinH) * 3_600n);
    expect(solConstant(VAULT_V32, "MAX_PAYOUT_DELAY")).toBe(BigInt(h.payoutDelayMaxH) * 3_600n);
    expect(decimals(solConstant(VAULT_V32, "MIN_OUTFLOW_BPS"), 2)).toBe(h.outflowMinPct);
    expect(decimals(solConstant(VAULT_V32, "MAX_OUTFLOW_BPS"), 2)).toBe(h.outflowMaxPct);
    expect(decimals(solConstant(VAULT_V32, "MIN_MIN_DAILY_OUTFLOW"), 18)).toBe(h.outflowFloorMinTao);
    expect(decimals(solConstant(VAULT_V32, "MAX_MIN_DAILY_OUTFLOW"), 18)).toBe(h.outflowFloorMaxTao);
    expect(decimals(solConstant(FRONT_DOOR_V32, "MAX_BATCH_VALUE"), 18)).toBe(h.batchMaxTao);
  });

  it("a park's wait, the smallest unstake the vault takes, and the cap on a leaver's share of the bridge fee back", () => {
    expect(solConstant(BIT_ADAPTER_V32, "PARK_TIMEOUT")).toBe(BigInt(V.parkDays) * DAY);
    expect(CONSTANTS_V32).toContain(`uint256 constant MIN_REDEEM_VALUE = ${V.minRedeemTao}e18;`);
    expect(decimals(field(SETTINGS_V32, "maxFeeBps"), 2)).toBe(V.payoutFeeCap.pct);
    const abs = SETTINGS_V32.match(/maxFeeAbs: \((\d+)n \* 10n \*\* 18n\) \/ ([\d_]+)n,/);
    expect(Number(abs?.[1]) / Number(abs?.[2].replace(/_/g, ""))).toBe(V.payoutFeeCap.tao);
  });

  it("the launch's unstake limits", () => {
    expect(decimals(field(SETTINGS_V32, "maxEntryValue"), 18)).toBe(V.unstakeLimits.maxEntryTao);
    expect(decimals(field(SETTINGS_V32, "maxDailyOutflowBps"), 2)).toBe(V.unstakeLimits.dailyOutflowPct);
    expect(decimals(field(SETTINGS_V32, "minDailyOutflow"), 18)).toBe(V.unstakeLimits.dailyFloorTao);
  });

  it("the launch's request fee, its price at the facts' ETH price, and the round trip's fixed costs with it", () => {
    expect(decimals(field(SETTINGS_V32, "redeemRequestFee"), 18)).toBe(V.requestFeeEth);
    expect(requestFeeEth(true)).toBe(V.requestFeeEth);
    expect(requestFeeEth(false)).toBe(FAQ_FACTS.requestFeeEth);
    // both at one ETH price, the facts' (about $1,816 an ETH, November 2026), to the cent, and the same deposit fee and
    // bridge fee back
    for (const [eth, usd] of [
      [FAQ_FACTS.requestFeeEth, FAQ_FACTS.requestFeeUsd],
      [V.requestFeeEth, V.requestFeeUsd],
    ]) {
      expect(Math.abs(usd - eth * 1_816), `${eth} ETH`).toBeLessThanOrEqual(0.005);
    }
    expect(Number((V.fixedFeesUsd - V.requestFeeUsd).toFixed(2))).toBe(Number((FAQ_FACTS.fixedFeesUsd - FAQ_FACTS.requestFeeUsd).toFixed(2)));
    // within the contracts' cap
    expect(decimals(solConstant(FRONT_DOOR_V32, "MAX_REDEEM_REQUEST_FEE"), 18)).toBe(FAQ_FACTS.caps.requestFeeEth);
    expect(V.requestFeeEth <= FAQ_FACTS.caps.requestFeeEth).toBe(true);
  });
});
