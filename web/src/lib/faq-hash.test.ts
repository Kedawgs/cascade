import { describe, expect, it } from "vitest";
import { faqHashTarget } from "./faq-hash";

const IDS = ["fees", "how-to-unstake", "risks"];

describe("faqHashTarget", () => {
  it("names the question a link like /faq/#how-to-unstake points at", () => {
    expect(faqHashTarget("#how-to-unstake", IDS)).toBe("how-to-unstake");
    expect(faqHashTarget("#fees", IDS)).toBe("fees");
  });

  it("is null for no hash, an empty one, or one that names no question here", () => {
    expect(faqHashTarget("", IDS)).toBeNull();
    expect(faqHashTarget("#", IDS)).toBeNull();
    expect(faqHashTarget("#Fees", IDS)).toBeNull();
    expect(faqHashTarget("#cancel", IDS)).toBeNull();
  });

  it("never throws on a hash that isn't valid percent-encoding", () => {
    for (const bad of ["#%", "#%E2%80", "#%zz", "#fees%"]) {
      expect(() => faqHashTarget(bad, IDS), bad).not.toThrow();
      expect(faqHashTarget(bad, IDS), bad).toBeNull();
    }
  });
});
