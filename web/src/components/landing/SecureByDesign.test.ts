import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { plainText, renderWithCache } from "../test-render";
import { SecureByDesign } from "./SecureByDesign";

const card = (stage: "testing" | "early") => plainText(renderWithCache(createElement(SecureByDesign, { stage })));

describe("SecureByDesign", () => {
  it("says how long a sensitive change waits in public (48 hours for settings, the registry's 7 days for a new bridge or front door), for every stage", () => {
    for (const stage of ["testing", "early"] as const) {
      expect(card(stage)).toContain("Your TAO sits in an open-source contract anyone can read. Sensitive changes are timelocked: 48 hours for settings, 7 days for a new bridge or front door.");
      expect(card(stage)).not.toMatch(/Not in our hands|move your TAO\.|auditable|any contract change/);
    }
  });

  it("until the deployment's code is published, says nothing is open source: the lede names the hard limits, and the card says when the code comes", () => {
    const text = plainText(renderWithCache(createElement(SecureByDesign, { stage: "early", published: false })));
    expect(text).toContain("Your TAO sits in a contract with hard limits written into its code. Sensitive changes are timelocked: 48 hours for settings, 7 days for a new bridge or front door.");
    expect(text).toContain("Code published soon");
    expect(text).toContain("This version's contract code goes on GitHub once its launch checks are done. Earlier versions and the security policy are there now. See the repository");
    expect(text).not.toMatch(/open[ -]source|anyone can read|are public|See the code/i);
    // published (every listed deployment, v3.2-launch too since Task 70): the card as it was
    const published = plainText(renderWithCache(createElement(SecureByDesign, { stage: "early", published: true })));
    expect(published).toContain("Open source");
    expect(published).toContain("The contracts and this app are public, with a security policy for reporting issues. See the code");
    expect(published).not.toContain("Code published soon");
  });

  it("points to the security page for the bridge's limits, with no claim it can't back", () => {
    const h = renderWithCache(createElement(SecureByDesign, { stage: "early" }));
    expect(plainText(h)).toContain("Your TAO crosses chains over Chainlink's CCIP bridge. Its limits and anything in transit are shown on the security page.");
    expect(h).toMatch(/href="\/security\/?"/);
    expect(plainText(h)).not.toContain("largest DeFi");
  });

  it("at the launch, says there is no independent audit yet and promises none before launch", () => {
    const text = card("early");
    expect(text).toContain("Independent auditNot yet");
    expect(text).toContain("No independent audit yet. Only deposit what you could afford to lose.");
    expect(text).not.toMatch(/Scheduled|before launch/);
  });

  it("while testing, keeps the audit planned before launch", () => {
    expect(card("testing")).toContain("Independent auditScheduled");
    expect(card("testing")).toContain("A third-party review before launch. The report will be linked here.");
  });
});
