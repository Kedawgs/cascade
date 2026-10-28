import { describe, expect, it } from "vitest";
import {
  formatDateTime,
  formatDay,
  formatDuration,
  formatPercent,
  formatRelative,
  formatSignedTao,
  formatTao,
  formatUsd,
  formatUsdc,
  formatUsdCompact,
  formatUsdShort,
  parseAmount,
  round,
  sanitizeAmountInput,
  shortAddress,
} from "./format";

describe("money", () => {
  it("formats USD with cents", () => {
    expect(formatUsd(1046.76)).toBe("$1,046.76");
    expect(formatUsd(3)).toBe("$3.00");
  });

  it("drops .00 in short USD and USDC amounts", () => {
    expect(formatUsdShort(1000)).toBe("$1,000");
    expect(formatUsdShort(500.5)).toBe("$500.50");
    expect(formatUsdc(1000)).toBe("1,000");
    expect(formatUsdc(285.14)).toBe("285.14");
  });

  it("shortens large USD amounts to a few characters", () => {
    expect(formatUsdCompact(1)).toBe("$1");
    expect(formatUsdCompact(999.4)).toBe("$999");
    expect(formatUsdCompact(999.6)).toBe("$1K");
    expect(formatUsdCompact(2549.9)).toBe("$2.5K");
    expect(formatUsdCompact(10_149)).toBe("$10.1K");
    expect(formatUsdCompact(1_234_567)).toBe("$1.2M");
  });

  it("shows TAO with 4 decimals", () => {
    expect(formatTao(3.66)).toBe("3.6600");
    expect(formatTao(1234.5)).toBe("1,234.5000");
    expect(formatSignedTao(0.0213)).toBe("+0.0213");
    expect(formatSignedTao(-1)).toBe("-1.0000");
  });

  it("rounds without float drift", () => {
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(3.63868, 4)).toBe(3.6387);
    expect(round(-2.5, 0)).toBe(-3);
  });

  it("formats percentages", () => {
    expect(formatPercent(12 / 274)).toBe("4.4%");
  });
});

describe("time", () => {
  const oct1 = new Date(2026, 9, 1, 9, 14);

  it("formats days and times like the mockup", () => {
    expect(formatDay(oct1)).toBe("Oct 1");
    expect(formatDateTime(oct1)).toBe("Oct 1, 9:14 AM");
  });

  it("formats durations", () => {
    expect(formatDuration(4 * 60_000)).toBe("4 minutes");
    expect(formatDuration(60_000)).toBe("1 minute");
    expect(formatDuration(4_000)).toBe("4 seconds");
    expect(formatDuration(3 * 3_600_000)).toBe("3 hours");
  });

  it("formats relative times", () => {
    const now = oct1.getTime();
    expect(formatRelative(new Date(now - 10_000), now)).toBe("just now");
    expect(formatRelative(new Date(now - 60_000), now)).toBe("1 minute ago");
    expect(formatRelative(new Date(now - 2 * 60_000), now)).toBe("2 minutes ago");
    expect(formatRelative(new Date(now - 3 * 3_600_000), now)).toBe("3 hours ago");
    expect(formatRelative(new Date(now - 3 * 86_400_000), now)).toBe("on Sep 28");
  });
});

describe("addresses", () => {
  it("shortens SS58 and EVM addresses", () => {
    expect(shortAddress("5HEo565WAy4Dbq3Sv271SAi7syBSofyfhhwRNjFNSM2g7tQb")).toBe("5HEo…7tQb");
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
    expect(shortAddress("demo")).toBe("demo");
  });
});

describe("amount input", () => {
  it("keeps digits and one decimal point", () => {
    expect(sanitizeAmountInput("1,000", 2)).toBe("1000");
    expect(sanitizeAmountInput("$12.345", 2)).toBe("12.34");
    expect(sanitizeAmountInput("1.2.3", 4)).toBe("1.23");
    expect(sanitizeAmountInput(".5", 4)).toBe("0.5");
    expect(sanitizeAmountInput("007", 2)).toBe("7");
    expect(sanitizeAmountInput("abc", 2)).toBe("");
  });

  it("parses complete amounts only", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount(".")).toBeNull();
    expect(parseAmount("0.")).toBe(0);
    expect(parseAmount("12.5")).toBe(12.5);
  });
});

describe("comma decimals", () => {
  it("treats a lone comma as the decimal point unless it is a thousands separator", () => {
    expect(sanitizeAmountInput("1,5", 4)).toBe("1.5");
    expect(sanitizeAmountInput("100,50", 2)).toBe("100.50");
    expect(sanitizeAmountInput("3,6600", 4)).toBe("3.6600");
    expect(sanitizeAmountInput("$1,000", 2)).toBe("1000");
    expect(sanitizeAmountInput("1,000.50", 2)).toBe("1000.50");
    expect(sanitizeAmountInput("1,000,000", 2)).toBe("1000000");
  });
});
