import { describe, expect, it } from "vitest";
import { type Deployment, readDeployment } from "./cascade/config";
import { appFaq, FAQ_FACTS, faqSections, featuredFaq } from "./faq";
import { parseInlineLinks } from "./inline-links";

const ENV = {
  NEXT_PUBLIC_CASCADE_FRONT_DOOR: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  NEXT_PUBLIC_CASCADE_BASE_ADAPTER: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  NEXT_PUBLIC_CASCADE_VAULT: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  NEXT_PUBLIC_CASCADE_BIT_ADAPTER: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  NEXT_PUBLIC_CASCADE_BIT_BLOCK: "9357492",
  NEXT_PUBLIC_CASCADE_VAULT_SS58: "5FNEuRkKZvg2jFjhY3DWpC3TBSH51AC3FKQpLyC1xesTBwLu",
  NEXT_PUBLIC_CASCADE_HOTKEY_SS58: "5E4z3h9yVhmQyCFWNbY9BPpwhx4xFiPwq3eeqmBgVF6KULde",
};
const TEST = readDeployment(ENV) as Deployment;
const LAUNCH = readDeployment({ ...ENV, NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S: "86400" }) as Deployment;

const items = (d: Deployment | null) => faqSections(d).flatMap((s) => s.items);
const answer = (d: Deployment | null, id: string) => {
  const item = items(d).find((i) => i.id === id);
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

  it("links only to this site or to the sources it names", () => {
    for (const d of [TEST, LAUNCH, null]) {
      for (const item of items(d)) {
        for (const part of item.a.flatMap((p) => parseInlineLinks(p))) {
          if (!part.href || part.href.startsWith("/")) continue;
          expect(HOSTS, `${item.id}: ${part.href}`).toContain(new URL(part.href).host);
        }
      }
    }
  });

  it("shows a short list on the landing page and in the app", () => {
    expect(featuredFaq(faqSections(TEST)).length).toBeGreaterThanOrEqual(4);
    expect(featuredFaq(faqSections(TEST)).length).toBeLessThanOrEqual(7);
    expect(appFaq(faqSections(TEST)).length).toBeGreaterThanOrEqual(4);
    expect(appFaq(faqSections(TEST)).length).toBeLessThanOrEqual(7);
  });

  it("says how long staking and unstaking take for the deployment the site talks to", () => {
    expect(answer(LAUNCH, "how-long-to-stake")).toMatch(/24 hours/);
    expect(answer(TEST, "how-long-to-stake")).not.toMatch(/24 hours/);
    expect(answer(LAUNCH, "how-to-unstake")).toMatch(/24-hour safety delay/);
    expect(answer(TEST, "how-to-unstake")).toMatch(/1-hour safety delay/);
    expect(answer(null, "how-long-to-stake")).toBeTruthy();
  });

  it("quotes the delivery floor the app sets", () => {
    expect(answer(TEST, "how-to-unstake")).toContain("today's price less 2%");
  });

  it("states the claim policy from one place", () => {
    const a = answer(TEST, "how-often-collected");
    expect(a).toContain(`${FAQ_FACTS.claim.multiple} times`);
    expect(a).toContain(`${FAQ_FACTS.claim.everyDays} days`);
    expect(a).toContain(`${FAQ_FACTS.claim.costTao} TAO`);
  });

  it("says plainly that there is no audit yet", () => {
    expect(answer(TEST, "audited")).toMatch(/^Not yet\./);
  });

  it("links the deployment's own validator and stake", () => {
    expect(answer(TEST, "validator")).toContain(TEST.hotkeySs58);
    expect(answer(TEST, "check-my-stake")).toContain(TEST.vaultSs58);
    expect(answer(null, "validator")).toContain("https://taostats.io/validators");
  });
});
