/**
 * Money is stored as integer minor units (cents) in BigInt. Rates are basis points.
 * No JavaScript `number` arithmetic is used for amounts.
 *
 * Interest math uses fixed-point BigInt with 18 decimal places of scale, and rounds
 * half-up to whole cents only when producing an amount.
 */
const SCALE = 10n ** 18n;

/** Divide two non-negative bigints, rounding half up. */
export function divRoundHalfUp(a: bigint, b: bigint): bigint {
  if (a < 0n || b <= 0n) throw new Error("divRoundHalfUp expects a >= 0 and b > 0");
  return (a * 2n + b) / (b * 2n);
}

/** Parse "1234.5" / "1234.56" / "1234" into cents. Rejects anything else. */
export function parseAmountToCents(input: string): bigint {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) throw new Error("Invalid amount");
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
}

/** Parse a percentage like "12.5" into basis points (1250). */
export function parsePercentToBps(input: string): number {
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) throw new Error("Invalid percentage");
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export function formatCents(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/** Add calendar months in UTC, clamping to the last day of the month (Jan 31 + 1 = Feb 28/29). */
export function addMonthsUTC(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(date.getUTCDate(), lastDay)));
}

export interface ScheduleRow {
  number: number;
  dueDate: Date;
  principalCents: bigint;
  interestCents: bigint;
  totalCents: bigint;
  balanceAfterCents: bigint;
}

/**
 * Standard amortizing (annuity) schedule: equal monthly payments
 *   payment = P * r * (1+r)^n / ((1+r)^n - 1),  r = annual rate / 12
 * Each month interest = round(balance * r); principal = payment - interest.
 * The final installment pays off whatever balance remains, absorbing rounding
 * drift, so the sum of principal portions ALWAYS equals the loan principal exactly.
 */
export function buildSchedule(principalCents: bigint, annualRateBps: number, termMonths: number, startDate: Date): ScheduleRow[] {
  if (principalCents <= 0n) throw new Error("principal must be positive");
  if (!Number.isInteger(termMonths) || termMonths < 1) throw new Error("term must be >= 1");
  if (!Number.isInteger(annualRateBps) || annualRateBps < 0) throw new Error("rate must be >= 0");

  const n = BigInt(termMonths);
  // r scaled by SCALE: bps / 10_000 / 12
  const rScaled = (BigInt(annualRateBps) * SCALE) / (10_000n * 12n);

  let payment: bigint;
  if (rScaled === 0n) {
    payment = divRoundHalfUp(principalCents, n);
  } else {
    let powScaled = SCALE; // (1+r)^n, scaled
    for (let i = 0; i < termMonths; i++) powScaled = (powScaled * (SCALE + rScaled)) / SCALE;
    payment = divRoundHalfUp(principalCents * rScaled * powScaled, SCALE * (powScaled - SCALE));
  }

  const rows: ScheduleRow[] = [];
  let balance = principalCents;
  for (let k = 1; k <= termMonths; k++) {
    const interest = divRoundHalfUp(balance * rScaled, SCALE);
    let principalPart = payment - interest;
    if (k === termMonths || principalPart > balance) principalPart = balance;
    if (principalPart < 0n) principalPart = 0n;
    balance -= principalPart;
    rows.push({
      number: k,
      dueDate: addMonthsUTC(startDate, k),
      principalCents: principalPart,
      interestCents: interest,
      totalCents: principalPart + interest,
      balanceAfterCents: balance,
    });
  }
  return rows;
}
