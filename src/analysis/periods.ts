import { z } from "zod";
import { addDays, differenceInDays } from "../lib/dates";
import type Decimal from "decimal.js";
import { formatAmount } from "../lib/money";

export const compareToSchema = z
  .enum(["none", "previous_period", "previous_year"])
  .default("none")
  .describe("Compare with the period of the same length just before, or the same dates one year earlier");
export type CompareTo = z.infer<typeof compareToSchema>;

export interface DateRange {
  dateFrom: string;
  dateTo: string;
}

export function inRange(date: string, range: DateRange): boolean {
  return date >= range.dateFrom && date <= range.dateTo;
}

/** The range a comparison reads, or undefined for none. */
export function comparisonRange(range: DateRange, compareTo: CompareTo): DateRange | undefined {
  if (compareTo === "none") return undefined;
  if (compareTo === "previous_year") {
    return { dateFrom: shiftYears(range.dateFrom, -1), dateTo: shiftYears(range.dateTo, -1) };
  }
  const days = differenceInDays(range.dateFrom, range.dateTo) + 1;
  return { dateFrom: addDays(range.dateFrom, -days), dateTo: addDays(range.dateFrom, -1) };
}

/** Same calendar date in another year; 29 February becomes 28 February. */
export function shiftYears(date: string, years: number): string {
  const year = Number(date.slice(0, 4)) + years;
  const monthDay = date.slice(5);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return `${String(year).padStart(4, "0")}-${monthDay === "02-29" && !leap ? "02-28" : monthDay}`;
}

/** Same day of the month in another month, clamped to the month's last day. */
export function shiftMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

export type PeriodSize = "month" | "week";

/** The period a date falls in: "2026-10" for months, the Monday ("2026-10-12") for weeks. */
export function periodOf(date: string, size: PeriodSize): string {
  if (size === "month") return date.slice(0, 7);
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

/** Every period that overlaps the range, clipped to it, in order. */
export function periodsIn(range: DateRange, size: PeriodSize): Array<DateRange & { period: string }> {
  const periods: Array<DateRange & { period: string }> = [];
  let start = range.dateFrom;
  while (start <= range.dateTo) {
    const period = periodOf(start, size);
    const nextStart = size === "month" ? shiftMonths(`${period}-01`, 1) : addDays(period, 7);
    const end = addDays(nextStart, -1);
    periods.push({ period, dateFrom: start, dateTo: end < range.dateTo ? end : range.dateTo });
    start = nextStart;
  }
  return periods;
}

/** Signed change from a previous amount, with the percentage when the previous amount is not zero. */
export function change(current: Decimal, previous: Decimal, currency: string): { amount: string; percent?: string } {
  const difference = current.minus(previous);
  return {
    amount: formatAmount(difference, currency),
    ...(previous.isZero() ? {} : { percent: difference.dividedBy(previous).times(100).toFixed(1) }),
  };
}

export function percentOf(part: Decimal, whole: Decimal): string {
  return whole.isZero() ? "0.0" : part.dividedBy(whole).times(100).toFixed(1);
}

export const changeSchema = z.object({
  amount: z.string().describe("Signed difference from the comparison period, in the same currency"),
  percent: z.string().optional().describe("Signed percentage change, one decimal; absent when the comparison amount is zero"),
});
