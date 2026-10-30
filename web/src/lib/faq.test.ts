import { readFileSync } from "node:fs";
import { formatUnits } from "viem";
import { describe, expect, it } from "vitest";
import type { SourceChainInfo } from "./cascade/chains";
import { type Deployment, EXPECTED_DEPLOYMENTS, MIN_UNSTAKE_WEI, PATH_USDC_TO_TAO, readDeployment } from "./cascade/config";
import { appFaq, FAQ_FACTS, type FaqOptions, faqSections, type Stage, VALIDATORS } from "./faq";
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
    expect(a).toContain("$0.05 plus 0.15% when you stake, 0.15% when your TAO is sold back to USDC, and 10% of staking rewards");
    expect(a).toContain("0.0001 ETH request fee");
    expect(a).toContain("at 0.5% per swap, $0.25 per deposit and 20% of rewards, and the request fee at 0.001 ETH");
    expect(a).not.toMatch(/no cap/);
    expect(a).toContain("the least TAO shown when you stake, and today's price less 2% when you unstake");
    expect(a).not.toMatch(/Nothing else|for good/);
  });

  it("says what the owner can change, what a pause holds, and that the launch setup is a plan", () => {
    const a = answer(TEST, "who-controls");
    expect(a).toContain("An owner key can change settings: fees up to their caps, the limits");
    expect(a).not.toMatch(/no cap/);
    expect(a).toMatch(/the limits, the safety delay and the validator/);
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
    expect(a).toContain("sells it on Uniswap at the current price, which may be below your minimum");
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
    expect(a).toContain("fixed fees of about $0.55 all in: the $0.05 deposit fee, the 0.0001 ETH request fee (about $0.23) and the bridge fee back");
    expect(a).toContain("That's about 5% of a $10 stake");
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
      "There is no multisig or timelock yet, so a settings change takes effect at once, and the riskiest settings move only within hard limits written into the contracts: every fee has a fixed maximum, the safety delay stays between 1 hour and 7 days, no batch can be set to carry more than 5,000 TAO, and unstakes through Cascade take at most half the staked TAO a day (or 100 TAO, if that's more).",
    );
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

  it("says the safety delay the vault has, else the cadence's", () => {
    expect(answer(LIVE_TEST, "how-to-unstake")).toContain("waits out a 1-hour safety delay");
    expect(answer(LIVE_LAUNCH, "how-to-unstake")).toContain("waits out a 24-hour safety delay");
    const delay = (s: string) => readDeployment({ ...ENV, NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S: s }) as Deployment;
    expect(answer(delay("43200"), "how-to-unstake")).toContain("waits out a 12-hour safety delay");
    expect(answer(delay("1800"), "how-to-unstake")).toContain("waits out a 30-minute safety delay");
    expect(answer(delay("0"), "how-to-unstake")).not.toContain("safety delay");
    expect(answer(delay("0"), "how-to-unstake")).toContain("in the next batch and comes back to Base");
    // without the vault's own figure, the cadence's default
    expect(answer(TEST, "how-to-unstake")).toContain("waits out a 1-hour safety delay");
    expect(answer(LAUNCH, "how-to-unstake")).toContain("waits out a 24-hour safety delay");
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
const STAKER_SOL = read("../../../contracts/src/CascadeStaker.sol");
const VAULT_SOL = read("../../../contracts/src/CascadeVault.sol");
const BASE_SOL = read("../../../contracts/src/CascadeBase.sol");
const FRONT_DOOR_SOL = read("../../../contracts/src/CascadeFrontDoor.sol");
const OPS_CONFIG = read("../../../ops/src/config.ts");
const OPS_REWARDS = read("../../../ops/src/keeper/rewards.ts");

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
    expect(FAQ_FACTS.minUnstakeTao).toBe(decimals(MIN_UNSTAKE_WEI, 18));
    expect(FAQ_FACTS.poolFeePct).toBe(POOL_FEE_PCT);
    expect(POOL_FEES_TEXT).toBe(`about ${POOL_FEE_PCT}%`);
    // USDC –fee→ WETH –fee→ TAO: the two fee tiers in the route the stake swaps through
    const tiers = [PATH_USDC_TO_TAO.slice(42, 48), PATH_USDC_TO_TAO.slice(88, 94)].map((h) => parseInt(h, 16));
    expect(tiers).toEqual([500, 3_000]);
    const kept = tiers.reduce((k, t) => k * (1 - t / 1e6), 1);
    expect(Number(((1 - kept) * 100).toFixed(2))).toBe(POOL_FEE_PCT);
  });
});
