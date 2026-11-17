import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DepositRecord, WithdrawalRecord } from "@/lib/cascade/types";
import { formatTime } from "@/lib/format";
import { DepositList, when, WithdrawalList } from "./ActivityList";

const sheet = readFileSync(fileURLToPath(new URL("./ActivityList.module.css", import.meta.url)), "utf8");
/** The phone's rules: the one media block (at most 560px wide). */
const phone = sheet.slice(sheet.indexOf("@media (max-width: 560px)"), sheet.indexOf(".warn {"));
const rule = (css: string, selector: string) => {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(at + selector.length + 2, css.indexOf("}", at)).replace(/\s+/g, " ").trim();
};

const step = (key: DepositRecord["steps"][number]["key"], status: DepositRecord["steps"][number]["status"]) => ({ key, status, title: key });
const deposit = (over: Partial<DepositRecord> = {}): DepositRecord => ({
  id: "d1",
  createdAt: new Date(2026, 10, 14, 20, 23),
  sourceChain: "base",
  status: "in_progress",
  steps: [step("swap", "done"), step("deposit", "done"), step("bridge", "active"), step("stake", "pending")],
  taoWei: 1049500000000000000n,
  taoAmount: 1.0495,
  amountUsd: 201,
  taoPriceUsd: 191.52,
  ...over,
});
const unstake = (over: Partial<WithdrawalRecord> = {}): WithdrawalRecord =>
  ({ id: "w1", createdAt: new Date(2026, 10, 14, 20, 23), status: "in_progress", steps: [], shares: 1n, taoAmount: 0.03, usdcAmount: 5.7, claimable: 0n, ...over }) as WithdrawalRecord;

describe("the time of a row made today", () => {
  const at = new Date(2026, 10, 16, 20, 23);

  it("is said whole, 'Today, 8:23 PM': the time is formatted by itself, never cut out of a date-and-time text", () => {
    // an iPhone joined the date and the time with ' at ', and the row read 'Today,' with no time (2026-11-16)
    expect(when(at, at.getTime() + 60_000)).toBe("Today, 8:23 PM");
    expect(formatTime(at)).toBe("8:23 PM");
    expect(formatTime(new Date(2026, 9, 1, 9, 14))).toBe("9:14 AM");
  });

  it("an earlier day shows the day; a date that isn't one shows a dash and never throws", () => {
    expect(when(new Date(2026, 9, 1, 9, 14), at.getTime())).toBe("Oct 1");
    expect(formatTime(new Date(Number.NaN))).toBe("–");
  });
});

describe("a row of the activity list", () => {
  it("a deposit on its way: what and when, how much, its state, then how far it is (the bars and the step's words)", () => {
    const html = renderToStaticMarkup(createElement(DepositList, { deposits: [deposit()] }));
    expect(html).toMatch(/<a class="_row_[^"]*"[^>]*><span class="_m_[^"]*"><span class="_t_[^"]*">\$201 from Base<\/span><span class="_d_[^"]*">Nov 14<\/span><\/span>/);
    // the price it was bought at: the small line under the amount (a phone's row leaves that line out)
    expect(html).toMatch(/<span class="_c_[^"]*">1\.0495 TAO<small>at \$191\.52<\/small><\/span>/);
    expect(html).toMatch(/<span class="_s_[^"]*"><span class="_chip_[^"]*">On its way<\/span><span class="_prog_[^"]*"><span class="_bars_[^"]*" aria-hidden="true">.*?<\/span><span class="_sub_[^"]*">crossing to Bittensor<\/span><\/span><\/span>/);
  });

  it("a staked or cancelled deposit, and a paid unstake, have no progress line: their row is two lines on a phone", () => {
    for (const status of ["staked", "cancelled"] as const) {
      const html = renderToStaticMarkup(createElement(DepositList, { deposits: [deposit({ status })] }));
      expect(html).not.toContain("_prog_");
      expect(html).toMatch(/<span class="_s_[^"]*"><span class="_chip_[^"]*">(Staked|Cancelled)<\/span><\/span>/);
    }
    expect(renderToStaticMarkup(createElement(WithdrawalList, { withdrawals: [unstake({ status: "paid" })] }))).not.toContain("_prog_");
  });

  it("an unstake on its way keeps its bars, with 'on Base' as the small line under its amount", () => {
    const html = renderToStaticMarkup(createElement(WithdrawalList, { withdrawals: [unstake()] }));
    expect(html).toMatch(/<span class="_s_[^"]*"><span class="_chip_[^"]*">On its way<\/span><span class="_prog_[^"]*"><span class="_bars_[^"]*"/);
    expect(html).toContain("<small>on Base</small>");
  });
});

describe("the row's layout", () => {
  it("wide: the progress is laid out as part of the state's cell, as before", () => {
    expect(rule(sheet, ".prog")).toBe("display: contents;");
    expect(rule(sheet, ".row")).toContain("grid-template-columns: 1.2fr 1fr 1.2fr auto;");
  });

  it("a phone: the amount beside the title, the state beside the date, the small line under the amount left out, the progress on a line of its own", () => {
    expect(rule(phone, ".row")).toContain("grid-template-columns: minmax(0, 1fr) auto auto;");
    expect(rule(phone, ".m")).toBe("grid-column: 1; grid-row: 1 / span 2; min-width: 0;");
    expect(rule(phone, ".c")).toBe("grid-column: 2; grid-row: 1; justify-self: end; text-align: right;");
    expect(rule(phone, ".c small")).toBe("display: none;");
    // wide, that line shows
    expect(rule(sheet, ".c small")).toContain("display: block;");
    expect(rule(phone, ".s")).toBe("display: contents;");
    expect(rule(phone, ".s > .chip")).toBe("grid-column: 2; grid-row: 2; justify-self: end;");
    expect(rule(phone, ".prog")).toContain("grid-column: 1 / -1; grid-row: 3; display: flex;");
    expect(rule(phone, ".chev")).toBe("grid-column: 3; grid-row: 1 / span 2; align-self: center;");
  });
});
