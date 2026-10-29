import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { filesUnder, pkg } from "./files.ts";

/** The Worker holds no key and never sends or signs anything: none of these may appear in its source or
 * its scripts (viem's account and wallet helpers, and the JSON-RPC methods that send or sign). */
const FORBIDDEN = [
  "eth_sendRawTransaction",
  "eth_sendTransaction",
  "eth_sign",
  "personal_sign",
  "sendRawTransaction",
  "sendTransaction",
  "writeContract",
  "createWalletClient",
  "signTransaction",
  "signMessage",
  "signTypedData",
  "privateKeyToAccount",
  "mnemonicToAccount",
  "hdKeyToAccount",
];

const offences = (dir: string) =>
  filesUnder(pkg(dir)).flatMap((f) => {
    const text = readFileSync(f, "utf8");
    return FORBIDDEN.filter((word) => text.includes(word)).map((word) => `${f}: ${word}`);
  });

describe("the Worker can't sign or send", () => {
  it("has no sending or signing method anywhere under src/", () => {
    expect(filesUnder(pkg("src")).length).toBeGreaterThan(0);
    expect(offences("src")).toEqual([]);
  });

  it("has none under scripts/ either", () => {
    expect(filesUnder(pkg("scripts")).length).toBeGreaterThan(0);
    expect(offences("scripts")).toEqual([]);
  });
});
