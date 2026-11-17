import { describe, expect, it } from "vitest";
import { amountOf, appendixB, appendixReaders } from "./v32-sources.ts";

// The Appendix B reader (Task 43's review, M2): each value is read only when it is exactly an amount in its unit,
// with at most "each", a "(…)" note or an "= …" gloss after it, and a combined row only when its parts line up with
// its names. Each shape it refuses has its own test; a refused value fails loudly, never as a misread number.

/** A spec with an Appendix B table of `rows` ([parameter cell, launch value]). */
const specWith = (rows: [string, string][]) =>
  [
    "## Appendix B: v3.2-launch parameters",
    "",
    "| Parameter | Launch value | Bound | Where | How set |",
    "|---|---|---|---|---|",
    ...rows.map(([p, v]) => `| ${p} | ${v} | — | vault | C |`),
    "",
    "## Appendix C",
    "",
  ].join("\n");

const reader = (rows: [string, string][]) => appendixReaders(specWith(rows));

describe("Appendix B's reader", () => {
  it("reads every shape the table uses: a unit, each, a note, a gloss, a dollar amount, a percent, a plain number, a pair", () => {
    const r = reader([
      ["deposit cap / batch value / minimum deposit / batch interval / request fee / batch limits", "40 TAO / 10 TAO / 0.04 TAO / 1 h / 0.0001 ETH / 50 + 50"],
      ["outflow bps / floor / `globalOutflowBps`", "2,000 / 10 TAO / 2,000"],
      ["reward cut / treasury", "10% / `0x34D1f7DC…`"],
      ["`rewardVesting`", "7 days"],
      ["adapter caps", "50 TAO each"],
      ["`minDirectDeposit`", "0.01 TAO (v3-launch's, below the 0.04 TAO minimum deposit; the founder, 2026-11-07)"],
      ["`hotkeyDustRao`", "1,000,000 rao = 0.001 TAO (v3-launch's; the founder, 2026-11-07)"],
      ["swap fee / deposit fee / route", "0.15% / $0.05 / Uniswap USDC-WETH-TAO"],
      ["`unstakeGas`", "400,000"],
      ["`treasury`", "`0x34D1f7DC8Cb62280d0bc617b784Bd2c4668809f6`"],
      ["`msPerBlock`", "vault 7,200, front door 120: calibrated for blocks twice as fast as the chain's today (3.10.17, Revision 28)"],
    ]);
    expect(r.abTao("deposit cap")).toBe(40n * 10n ** 18n);
    expect(r.abTao("minimum deposit")).toBe(4n * 10n ** 16n);
    expect(r.abHours("batch interval")).toBe(3_600n);
    expect(r.abEth("request fee")).toBe(10n ** 14n);
    expect(r.abPair("batch limits")).toEqual([50n, 50n]);
    expect(r.abBps("outflow bps")).toBe(2_000n);
    expect(r.abTao("floor")).toBe(10n * 10n ** 18n);
    expect(r.abBps("reward cut")).toBe(1_000n);
    expect(r.abDays("rewardVesting")).toBe(604_800n);
    expect(r.abTao("adapter caps")).toBe(50n * 10n ** 18n);
    expect(r.abTao("minDirectDeposit")).toBe(10n ** 16n);
    expect(r.abInt("hotkeyDustRao", "rao")).toBe(1_000_000n);
    expect(r.abBps("swap fee")).toBe(15n);
    expect(r.abUsdc("deposit fee")).toBe(50_000n);
    expect(r.appendixB("route")).toBe("Uniswap USDC-WETH-TAO");
    expect(r.abInt("unstakeGas")).toBe(400_000n);
    // its own row wins over the abbreviated address in "reward cut / treasury"
    expect(r.abAddress("treasury")).toBe("0x34D1f7DC8Cb62280d0bc617b784Bd2c4668809f6");
    expect(r.abMsPerBlock()).toEqual({ vault: 7_200n, frontDoor: 120n });
  });

  it("refuses a second amount in a row of one name (it would read the first and drop the rest)", () => {
    const r = reader([
      ["adapter caps", "50 TAO (Base) / 100 TAO (Bittensor)"],
      ["`maxTotalAssets`", "44 TAO, 60 TAO later"],
      ["staking-floor fallbacks", "2,000,000 / 20,000,000 rao"],
    ]);
    expect(() => r.abTao("adapter caps")).toThrow(/is not exactly an amount in TAO/);
    expect(() => r.abTao("maxTotalAssets")).toThrow(/is not exactly an amount in TAO/);
    expect(() => r.abInt("staking-floor fallbacks", "rao")).toThrow(/is not exactly an amount in rao/);
  });

  it("refuses a trailing word after a unit-less value (\"1 TAO\" is not the plain number 1)", () => {
    const r = reader([
      ["`unstakeMarginRao`", "1 TAO"],
      ["`idleBufferBps`", "2,000 bps"],
      ["`unstakeGas`", "400,000 gas"],
      ["`launchChain`", "8453 each"],
    ]);
    expect(() => r.abInt("unstakeMarginRao")).toThrow(/is not exactly an amount in plain numbers/);
    expect(() => r.abBps("idleBufferBps")).toThrow(/is not exactly an amount in plain numbers/);
    expect(() => r.abInt("unstakeGas")).toThrow(/is not exactly an amount in plain numbers/);
    expect(() => r.abInt("launchChain")).toThrow(/is not exactly an amount in plain numbers/);
  });

  it("refuses anything after the unit but each, a note or a gloss", () => {
    for (const value of ["10 TAO maximum", "10 TAO, or 20 TAO", "10 TAO (a note) and more", "10 TAO (a note) (another)", "10 TAOs", "10 TAO (unclosed", "10 TAO =", "10 TAO each each"]) {
      expect(() => amountOf(value, "TAO"), value).toThrow(/is not exactly an amount in TAO/);
    }
    for (const value of ["1 hour", "1 h then 2 h", "24 h each day"]) expect(() => amountOf(value, "h"), value).toThrow(/is not exactly an amount in h/);
    // a unit-less value takes no "each" either
    expect(() => amountOf("10 each", "")).toThrow(/plain numbers/);
  });

  it("refuses an amount that is not one: malformed thousands, a leading sign or word, a dollar sign on a non-dollar amount", () => {
    for (const value of ["1,00 TAO", "40,0000 TAO", ",40 TAO", "-1 TAO", "about 40 TAO", "$40 TAO", ".5 TAO"]) {
      expect(() => amountOf(value, "TAO"), value).toThrow(/is not exactly an amount in TAO/);
    }
    // a dollar amount must carry its sign, and nothing after it
    expect(() => amountOf("0.05", "", { dollar: true })).toThrow(/is not exactly a dollar amount/);
    expect(() => amountOf("$0.05 USDC", "", { dollar: true })).toThrow(/is not exactly a dollar amount/);
    expect(amountOf("$0.05", "", { dollar: true })).toBe("0.05");
  });

  it("refuses a combined row whose parts hold \";\" or a second amount: its parts may not line up with its names", () => {
    const r = reader([
      ["`maxEntryValue` / `maxMessageValue` / `minChunk`", "10 TAO / 15 TAO 20 TAO / 10"],
      ["payout delay / `rewardVesting`", "24 h; 48 h / 7 days"],
    ]);
    // every name of such a row, not only the part that holds two values
    expect(() => r.abTao("maxEntryValue")).toThrow(/row "maxEntryValue \/ maxMessageValue \/ minChunk" may not line up with its names: "15 TAO 20 TAO"/);
    expect(() => r.abInt("minChunk")).toThrow(/may not line up/);
    expect(() => r.abHours("payout delay")).toThrow(/"24 h; 48 h" holds ";" or a second amount/);
    expect(() => r.abDays("rewardVesting")).toThrow(/may not line up/);
  });

  it("refuses the spec's own misaligned row (the scheduler's delays, EXECUTE_WINDOW and STAMP_MAX_TTL), which the plan never reads", () => {
    // "48 h / 7 d / 8 d; 7 d; 1 d": split on " / ", STAMP_MAX_TTL would read "8 d; 7 d; 1 d"
    expect(() => appendixB("STAMP_MAX_TTL")).toThrow(/may not line up with its names: "8 d; 7 d; 1 d"/);
    expect(() => appendixB("EXECUTE_WINDOW")).toThrow(/may not line up/);
    expect(() => appendixB("scheduler delays")).toThrow(/may not line up/);
  });

  it("refuses a cell that is not exactly one address, and a block-time row that is not two whole numbers", () => {
    const r = reader([
      ["`treasury`", "`0x34D1f7DC8Cb62280d0bc617b784Bd2c4668809f6` or `0x0000000000000000000000000000000000000001`"],
      ["`msPerBlock`", "vault 7,200, front door 2.5"],
    ]);
    expect(() => r.abAddress("treasury")).toThrow(/is not exactly one full address/);
    expect(() => r.abMsPerBlock()).toThrow(/does not read 'vault N, front door M'/);
  });

  it("refuses a name it does not find once", () => {
    const r = reader([
      ["`minChunk`", "10"],
      ["`minChunk` / floor", "10 / 10 TAO"],
    ]);
    // its own row wins
    expect(r.abInt("minChunk")).toBe(10n);
    expect(() => r.appendixB("maxChunk")).toThrow(/names "maxChunk" 0 times/);
    expect(() => reader([["a / b", "1 / 2"], ["b / c", "3 / 4"]]).appendixB("b")).toThrow(/names "b" 2 times/);
  });
});
