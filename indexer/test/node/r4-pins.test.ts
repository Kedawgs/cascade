import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// R4's monitor rules hold a contract constant: MIN_REDEEM_VALUE, the smallest front-door redeem burned (0.03 TAO), which
// stake.min_near_floor and stake.min_at_floor measure Bittensor's minimum stake against. Read as text on both sides (the
// rule's module reaches D1's types, which this project's node typecheck doesn't have).

const src = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("R4's monitor pins", () => {
  it("MIN_REDEEM_VALUE: the contracts' 0.03e18 wei, the rule's 30,000,000 rao", () => {
    expect(src("../../../contracts/src/CascadeConstants.sol")).toMatch(/uint256 constant MIN_REDEEM_VALUE = 0\.03e18;/);
    expect(src("../../src/rules/r4.ts")).toMatch(/export const MIN_REDEEM_VALUE_RAO = 30_000_000n;/);
  });
});
