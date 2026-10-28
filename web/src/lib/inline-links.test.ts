import { describe, expect, it } from "vitest";
import { parseInlineLinks } from "./inline-links";

describe("parseInlineLinks", () => {
  it("splits text around [label](url) links", () => {
    expect(parseInlineLinks("See [Taostats](https://taostats.io) for live data.")).toEqual([
      { text: "See " },
      { text: "Taostats", href: "https://taostats.io" },
      { text: " for live data." },
    ]);
  });

  it("keeps site-internal links and several links in one paragraph", () => {
    expect(parseInlineLinks("[Rewards](/rewards/) and [docs](https://docs.learnbittensor.org)")).toEqual([
      { text: "Rewards", href: "/rewards/" },
      { text: " and " },
      { text: "docs", href: "https://docs.learnbittensor.org" },
    ]);
  });

  it("leaves anything that isn't an https or site link as plain text", () => {
    expect(parseInlineLinks("[bad](http://x.io) [js](javascript:alert(1))")).toEqual([
      { text: "[bad](http://x.io) [js](javascript:alert(1))" },
    ]);
    expect(parseInlineLinks("no links")).toEqual([{ text: "no links" }]);
  });

  it("refuses a protocol-relative //host link, which would leave the site", () => {
    expect(parseInlineLinks("[x](//evil.example/path)")).toEqual([{ text: "[x](//evil.example/path)" }]);
    expect(parseInlineLinks("[home](/)")).toEqual([{ text: "home", href: "/" }]);
    expect(parseInlineLinks("[q](/faq/#who-controls)")).toEqual([{ text: "q", href: "/faq/#who-controls" }]);
  });
});
