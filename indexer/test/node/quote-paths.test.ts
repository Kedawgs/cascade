import { readFileSync } from "node:fs";
import { encodePacked, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { PATH_TAO_TO_USDC, PATH_USDC_TO_TAO, UNISWAP_QUOTER } from "../../src/config.ts";
import { pkg } from "./files.ts";

const site = readFileSync(pkg("../web/src/lib/cascade/config.ts"), "utf8");
const tokens = Object.fromEntries([...site.match(/export const TOKENS = \{([^}]*)\}/)![1].matchAll(/(\w+):\s*"(0x[0-9a-fA-F]{40})"/g)].map(([, k, a]) => [k, a]));
const quoter = site.match(/export const UNISWAP = \{[^}]*quoter:\s*"(0x[0-9a-fA-F]{40})"/)![1];

/** The site's path: its encodePacked(["address","uint24",...], [TOKENS.a, fee, TOKENS.b, fee, TOKENS.c]) */
function sitePath(name: string): `0x${string}` {
  const args = site.match(new RegExp(String.raw`export const ${name} = encodePacked\(\s*\[[^\]]*\],\s*\[([^\]]*)\]`))![1];
  const parts = args.split(",").map((x) => x.trim());
  return encodePacked(["address", "uint24", "address", "uint24", "address"], parts.map((p, i) => (i % 2 === 0 ? tokens[p.replace("TOKENS.", "")] : Number(p))) as never);
}

describe("the monitor quotes the swaps the site makes", () => {
  it("uses the site's QuoterV2 address", () => {
    expect(getAddress(UNISWAP_QUOTER)).toBe(getAddress(quoter));
  });
  it("uses the site's USDC to TAO path", () => {
    expect(PATH_USDC_TO_TAO.toLowerCase()).toBe(sitePath("PATH_USDC_TO_TAO").toLowerCase());
  });
  it("uses the site's TAO to USDC path", () => {
    expect(PATH_TAO_TO_USDC.toLowerCase()).toBe(sitePath("PATH_TAO_TO_USDC").toLowerCase());
  });
});
