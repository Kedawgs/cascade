import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { plainText, renderWithCache } from "../test-render";
import { SecureByDesign } from "./SecureByDesign";

const card = (stage: "testing" | "early") => plainText(renderWithCache(createElement(SecureByDesign, { stage })));

describe("SecureByDesign", () => {
  it("says we can't move your TAO without the registry's 7 days' public notice, for every stage", () => {
    for (const stage of ["testing", "early"] as const) {
      expect(card(stage)).toContain("Your TAO sits in an open, auditable contract. We can't move your TAO without 7 days' public notice.");
      expect(card(stage)).not.toMatch(/Not in our hands|move your TAO\./);
    }
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
