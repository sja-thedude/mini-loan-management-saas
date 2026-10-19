import { describe, expect, it } from "vitest";
import { addMonthsUTC, buildSchedule, divRoundHalfUp, formatCents, parseAmountToCents, parsePercentToBps } from "../src/lib/money";

describe("money parsing", () => {
  it("parses decimal strings to integer cents without floats", () => {
    expect(parseAmountToCents("0.1")).toBe(10n);
    expect(parseAmountToCents("15000")).toBe(1_500_000n);
    expect(parseAmountToCents("1234.56")).toBe(123_456n);
    expect(() => parseAmountToCents("1.234")).toThrow();
    expect(() => parseAmountToCents("-5")).toThrow();
    expect(() => parseAmountToCents("1e5")).toThrow();
  });
  it("parses percentages to basis points", () => {
    expect(parsePercentToBps("12.5")).toBe(1250);
    expect(parsePercentToBps("0")).toBe(0);
    expect(parsePercentToBps("7.25")).toBe(725);
  });
  it("rounds half up", () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(4n, 3n)).toBe(1n);
    expect(formatCents(123_405n)).toBe("1234.05");
  });
});

describe("amortization schedule", () => {
  const start = new Date(Date.UTC(2026, 0, 31));

  it("matches the textbook payment: 10,000.00 at 12% for 12 months = 888.49/month", () => {
    const rows = buildSchedule(1_000_000n, 1200, 12, start);
    expect(rows).toHaveLength(12);
    expect(rows[0].totalCents).toBe(88_849n);
    expect(rows[0].interestCents).toBe(10_000n); // 1% of 10,000.00
  });

  it("principal portions always sum exactly to the principal", () => {
    for (const [p, bps, n] of [[1_000_000n, 1200, 12], [123_457n, 1999, 7], [50_000_000n, 875, 360], [10_001n, 0, 3]] as const) {
      const rows = buildSchedule(p, bps, n, start);
      expect(rows.reduce((s, r) => s + r.principalCents, 0n)).toBe(p);
      expect(rows.at(-1)!.balanceAfterCents).toBe(0n);
      for (const r of rows) expect(r.totalCents).toBe(r.principalCents + r.interestCents);
    }
  });

  it("zero-interest loans split principal evenly with remainder in the last installment", () => {
    const rows = buildSchedule(10_000n, 0, 3, start);
    expect(rows.map((r) => r.principalCents)).toEqual([3_333n, 3_333n, 3_334n]);
    expect(rows.every((r) => r.interestCents === 0n)).toBe(true);
  });

  it("due dates clamp to month end", () => {
    expect(addMonthsUTC(start, 1).toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(addMonthsUTC(start, 2).toISOString().slice(0, 10)).toBe("2026-03-31");
  });
});

describe("shared money module", () => {
  it("web demo mode uses an identical copy of the money math", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const api = readFileSync(resolve(__dirname, "../src/lib/money.ts"), "utf8");
    const web = readFileSync(resolve(__dirname, "../../web/src/lib/money.ts"), "utf8");
    expect(web).toBe(api);
  });
});
