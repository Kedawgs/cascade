import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { filesUnder, pkg } from "./files.ts";

/** The Worker holds no key and never sends a transaction: none of these may appear in its source. */
const FORBIDDEN = ["eth_sendRawTransaction", "eth_sendTransaction", "privateKeyToAccount", "mnemonicToAccount", "signTransaction"];

describe("the Worker can't sign or send", () => {
  it("has no transaction-sending method anywhere under src/", () => {
    const files = filesUnder(pkg("src"));
    expect(files.length).toBeGreaterThan(0);
    const found = files.flatMap((f) => {
      const text = readFileSync(f, "utf8");
      return FORBIDDEN.filter((word) => text.includes(word)).map((word) => `${f}: ${word}`);
    });
    expect(found).toEqual([]);
  });
});
