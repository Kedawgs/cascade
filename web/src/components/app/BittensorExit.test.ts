import { createElement } from "react";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { DIRECT_ORIGIN } from "@/lib/cascade/abi";
import {
  CONTRACT_WALLET_REFUSAL,
  DIRECT_EXIT_SUB,
  type DirectExitReads,
  estimateText,
  GAS_NOTE,
  NETWORK_NOTE,
  ORIGIN_STEP_LABEL,
  ORIGIN_STEP_NOTE,
  ORIGIN_STEP_WHY,
  OTHER_WAYS_OUT,
  SWITCH_BACK_LABEL,
  SWITCH_BACK_NOTE,
  switchBackNote,
  withdrawLabel,
} from "@/lib/cascade/direct-exit";
import { cascadeKeys } from "@/lib/cascade/hooks";
import { STAKE_MISSING } from "@/lib/cascade/trail";
import { launchData, plainText, renderWithCache } from "../test-render";
import { BittensorExitScreen, DirectExitCard } from "./BittensorExitScreen";
import { OtherWaysOut } from "./UnstakeScreen";

// Task 59b: the emergency "Withdraw on Bittensor" page, v3.2 only, reached from the FAQ and from Unstake's other
// ways out. Rendered on the server, as the static export does.

const ME = "0x1234567890abcdef1234567890abcdef12345678";
const LENSES = { vaultLens: "0x000000000000000000000000000000000000Ae15" as Address, doorLens: "0x000000000000000000000000000000000000De15" as Address };
const v32 = () => launchData(undefined, LENSES);
const VALUE = 40_799_999_000_000_000n;
const reads = (over: Partial<DirectExitReads> = {}): DirectExitReads => ({
  shares: 4n * 10n ** 22n,
  supply: 10n ** 24n,
  totalAssets: 102n * 10n ** 16n,
  origin: 8453n,
  stakeMissing: false,
  paused: false,
  // 0.1 TAO: above the withdrawal's gas floor (3,344,445 gas at 6 gwei, with Task 65's 2,000,000 reserve: direct-exit.ts exitGasFloor)
  gasWei: 10n ** 17n,
  codeBase: "0x",
  codeBittensor: "0x",
  baseDoors: 1n,
  hotkeyCount: 2n,
  unstakeGas: 400_000n,
  exitGasReserve: 2_000_000n,
  gasPriceWei: 6_000_000_000n,
  priorityFeeWei: 0n,
  ...over,
});
const card = (r: DirectExitReads) => renderWithCache(createElement(DirectExitCard, { account: ME }), [{ key: cascadeKeys.directExit(ME), data: r }], { data: v32() });
/** The buttons a page shows: their text, and whether each is off. */
const buttons = (html: string) => [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map((m) => ({ text: m[2], off: /\sdisabled=""/.test(m[1]) }));

describe("the Withdraw on Bittensor page (Task 59b)", () => {
  it("is v3.2's only: a v3-launch site has nothing at this address", () => {
    expect(plainText(renderWithCache(createElement(BittensorExitScreen), [], { data: launchData() }))).toContain("There's nothing at this address.");
    const t = plainText(renderWithCache(createElement(BittensorExitScreen), [], { data: v32() }));
    expect(t).toContain("Withdraw on Bittensor");
    expect(t).toContain(DIRECT_EXIT_SUB);
    expect(DIRECT_EXIT_SUB).toBe("An emergency way out: your stake as TAO, straight from the vault to this address on Bittensor.");
  });

  it("shows what the user will receive, the gas and network notes, then the origin step and the withdrawal", () => {
    const html = card(reads());
    const t = plainText(html);
    for (const line of [estimateText(VALUE), GAS_NOTE, NETWORK_NOTE, ORIGIN_STEP_NOTE, ORIGIN_STEP_WHY]) expect(t).toContain(line);
    // home on Base: nothing to switch back
    expect(t).not.toContain(SWITCH_BACK_NOTE);
    expect(buttons(html)).toEqual([
      { text: ORIGIN_STEP_LABEL, off: false },
      { text: withdrawLabel(VALUE), off: false },
    ]);
  });

  it("leaves the origin step out for an address already home on Bittensor, and offers Use Base for withdrawals again (Task 59b follow-up)", () => {
    const html = card(reads({ origin: DIRECT_ORIGIN }));
    expect(plainText(html)).not.toContain(ORIGIN_STEP_NOTE);
    expect(plainText(html)).toContain(SWITCH_BACK_NOTE);
    expect(buttons(html)).toEqual([
      { text: withdrawLabel(VALUE), off: false },
      { text: SWITCH_BACK_LABEL, off: false },
    ]);
  });

  it("words the switch back's note for the address's origin: no 'again' where Base never worked for it (Task 59b review, M5)", () => {
    for (const origin of [0n, 42161n]) {
      const t = plainText(card(reads({ origin })));
      expect(t, String(origin)).toContain(switchBackNote(origin));
      expect(t, String(origin)).not.toContain(SWITCH_BACK_NOTE);
    }
  });

  it("doesn't offer Use Base for withdrawals again while Base has no active door (Task 59b follow-up)", () => {
    const html = card(reads({ origin: DIRECT_ORIGIN, baseDoors: 0n }));
    expect(plainText(html)).not.toContain(SWITCH_BACK_NOTE);
    expect(buttons(html)).toEqual([{ text: withdrawLabel(VALUE), off: false }]);
  });

  it("refuses a contract wallet in plain words, with nothing to press", () => {
    const html = card(reads({ codeBase: "0x6080604052" as Hex }));
    expect(plainText(html)).toContain(CONTRACT_WALLET_REFUSAL);
    expect(buttons(html)).toEqual([]);
  });

  it("while stake is missing, says so and holds the withdrawal, offering no way to accept a lower price", () => {
    const html = card(reads({ stakeMissing: true }));
    const t = plainText(html);
    expect(t).toContain(STAKE_MISSING);
    expect(buttons(html)).toEqual([
      { text: ORIGIN_STEP_LABEL, off: false },
      { text: withdrawLabel(VALUE), off: true },
    ]);
    expect(html).not.toMatch(/checkbox|floor price/i);
  });
});

describe("Unstake's other ways out (Task 59b)", () => {
  it("links the emergency page on v3.2, and says nothing of it on v3-launch", () => {
    const html = renderWithCache(createElement(OtherWaysOut), [], { data: v32() });
    // next build adds the trailing slash (next.config.ts trailingSlash), a render outside it doesn't
    expect(html).toMatch(/href="\/unstake\/bittensor\/?"/);
    expect(plainText(html)).toContain("Other ways out");
    expect(plainText(html)).toContain(OTHER_WAYS_OUT);
    expect(renderWithCache(createElement(OtherWaysOut), [], { data: launchData() })).toBe("");
  });
});
