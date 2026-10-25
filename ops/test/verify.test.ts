import { encodeEventTopics, type Hex, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { WALLET } from "../src/config.ts";
import { buildPlan } from "../src/plan.ts";
import {
  codeMismatch,
  compare,
  type Expectation,
  expectations,
  frontDoorActivationFailures,
  keyOf,
  reserveFailures,
} from "../src/verify.ts";

const plan = buildPlan(0, 0, `0x${"33".repeat(32)}`);

describe("verify", () => {
  const exp = expectations(plan);

  it("expects every immutable and setting the spec lists", () => {
    const fields = new Set(exp.map((e) => `${e.contract}.${e.field}`));
    for (const f of [
      "CcipBaseAdapter.remoteAdapter",
      "CcipBaseAdapter.minSendAmount",
      "CcipBittensorAdapter.alphaVault",
      "CcipBittensorAdapter.gasPerEntry",
      "CascadeFrontDoor.vault",
      "CascadeFrontDoor.primaryBridge",
      "CascadeFrontDoor.depositCap",
      "CascadeVault.stakeHotkey",
      "CascadeVault.keeper",
      "CascadeVault.payoutDelay",
    ]) {
      expect(fields).toContain(f);
    }
    expect(exp.find((e) => e.field === "remoteAdapter" && e.contract === "CcipBaseAdapter")!.expected).toBe(plan.addresses.bitAdapter);
  });

  it("all equal gives no failures; one wrong remoteAdapter names it", () => {
    const actual = new Map(exp.map((e) => [keyOf(e), e.expected]));
    expect(compare(exp, actual)).toEqual([]);
    const wrong = exp.find((e) => e.contract === "CcipBaseAdapter" && e.field === "remoteAdapter") as Expectation;
    actual.set(keyOf(wrong), WALLET);
    expect(compare(exp, actual)).toEqual([
      `Base CcipBaseAdapter.remoteAdapter: expected ${plan.addresses.bitAdapter}, found ${WALLET}`,
    ]);
  });

  it("compares addresses without regard to case", () => {
    const e: Expectation[] = [{ chain: "bittensor", contract: "CascadeVault", address: WALLET, field: "keeper", expected: WALLET }];
    expect(compare(e, new Map([[keyOf(e[0]), WALLET.toLowerCase()]]))).toEqual([]);
  });

  it("needs exactly one FrontDoorActivated(8453, frontDoor) in the vault's creation", () => {
    const abi = parseAbi(["event FrontDoorActivated(uint64 indexed chain, address indexed addr)"]);
    const log = { address: plan.addresses.vault, topics: encodeEventTopics({ abi, args: { chain: 8453n, addr: plan.addresses.frontDoor } }) as Hex[], data: "0x" as Hex };
    expect(frontDoorActivationFailures([log], plan)).toEqual([]);
    expect(frontDoorActivationFailures([log, log], plan)).toHaveLength(1);
    expect(frontDoorActivationFailures([], plan)).toHaveLength(1);
  });

  it("ignores differences inside immutable ranges only", () => {
    const artifact = { deployedBytecode: "0x60aa0000bb" as Hex, immutableRanges: [{ start: 2, length: 2 }] };
    expect(codeMismatch("base", "X", "0x60aa1234bb", artifact)).toBeNull();
    expect(codeMismatch("base", "X", "0x60ab1234bb", artifact)).toMatch(/Base X: deployed code differs/);
  });

  it("checks the reserves net of the existential deposit", () => {
    expect(reserveFailures(499_999_999_999n, 10n ** 12n)).toHaveLength(1);
    expect(reserveFailures(5n * 10n ** 11n, 10n ** 12n)).toEqual([]);
    expect(reserveFailures(5n * 10n ** 11n, 10n ** 12n - 1n)).toHaveLength(1);
  });
});
