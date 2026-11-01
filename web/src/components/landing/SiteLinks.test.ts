import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { SITE_LINKS } from "@/lib/site";
import { renderWithCache } from "../test-render";
import { SiteFooter } from "./SiteFooter";
import { SiteNav } from "./SiteNav";

/** The anchors of a render as [href, text]. */
const anchors = (html: string): [string, string][] =>
  [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [m[1]!, m[2]!.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&")]);

describe("SiteNav", () => {
  const links = anchors(renderWithCache(createElement(SiteNav)));

  it("links Security to /security (the static export adds the slash) in both link lists", () => {
    expect(links.filter(([h, t]) => t === "Security" && h === "/security")).toHaveLength(2);
  });

  it("no longer links to the landing's #secure section", () => {
    expect(links.some(([h]) => h === "/#secure")).toBe(false);
  });

  it("reaches staking through the Stake & Earn button alone, not a second plain Stake link", () => {
    expect(links.filter(([, t]) => t === "Stake")).toHaveLength(0);
    expect(links.filter(([h, t]) => h === "/stake" && t === "Stake & Earn")).toHaveLength(1);
  });
});

describe("SiteFooter", () => {
  const links = anchors(renderWithCache(createElement(SiteFooter)));

  it("links Security to /security (the static export adds the slash)", () => {
    expect(links).toContainEqual(["/security", "Security"]);
  });

  it("keeps the SECURITY.md link as Report a vulnerability", () => {
    expect(links).toContainEqual([SITE_LINKS.security, "Report a vulnerability"]);
    expect(links).not.toContainEqual([SITE_LINKS.security, "Security"]);
  });
});
