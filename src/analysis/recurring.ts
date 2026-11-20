import type Decimal from "decimal.js";
import { z } from "zod";
import { accountIdSchema, nonNegativeDecimalAmountSchema } from "../finance";
import { addDays, differenceInDays } from "../lib/dates";
import { formatAmount, Money } from "../lib/money";
import { transactionKindSchema, type AnalyzedTransaction, type TransactionKind } from "./classify";
import { shiftMonths } from "./periods";

export const cadenceSchema = z.enum(["weekly", "fortnightly", "monthly", "quarterly", "yearly"]);
type Cadence = z.infer<typeof cadenceSchema>;

interface CadenceRule {
  cadence: Cadence;
  minDays: number;
  maxDays: number;
  days: number;
  months?: number;
  perMonth: number;
}

const CADENCES: readonly CadenceRule[] = [
  { cadence: "weekly", minDays: 5, maxDays: 9, days: 7, perMonth: 52 / 12 },
  { cadence: "fortnightly", minDays: 12, maxDays: 17, days: 14, perMonth: 26 / 12 },
  { cadence: "monthly", minDays: 26, maxDays: 35, days: 30, months: 1, perMonth: 1 },
  { cadence: "quarterly", minDays: 80, maxDays: 100, days: 91, months: 3, perMonth: 1 / 3 },
  { cadence: "yearly", minDays: 350, maxDays: 380, days: 365, months: 12, perMonth: 1 / 12 },
];

// Fixed defaults for a personal account, documented in the README; not tuned per user.
const MIN_REGULAR_SHARE = 0.6;
const FIXED_AMOUNT_TOLERANCE = 0.02;
const TREND_THRESHOLD = 0.05;
// Frequent purchases at one shop are not a schedule unless the amount repeats.
const MAX_SHORT_CADENCE_SPREAD = 1.2;

export const recurringSchema = z.object({
  payee: z.string(),
  payeeKey: z.string().describe("Pass to finance_search_transactions as payeeKey to see every payment"),
  direction: z.enum(["out", "in"]),
  kind: transactionKindSchema.describe("internal_transfer means a regular move to your own account or savings"),
  currency: z.string(),
  cadence: cadenceSchema,
  typicalAmount: nonNegativeDecimalAmountSchema.describe("Median amount per occurrence"),
  lastAmount: nonNegativeDecimalAmountSchema,
  amountPattern: z.enum(["fixed", "variable"]).describe("fixed: every occurrence within 2% of the typical amount"),
  trend: z.enum(["rising", "falling", "stable"]).describe("Latest amount against the typical amount before it, 5% threshold"),
  monthlyEquivalent: nonNegativeDecimalAmountSchema.describe("Typical amount converted to a monthly rate, rounded to minor units"),
  occurrences: z.number().int(),
  firstDate: z.string(),
  lastDate: z.string(),
  nextExpectedDate: z.string().describe("Estimated from the cadence; banks and merchants can move dates by a few days"),
  status: z.enum(["active", "stopped"]).describe("stopped: no occurrence for more than one and a half cycles"),
  accountIds: z.array(accountIdSchema),
  bankCategory: z.string().optional().describe("The bank's transaction type, such as direct debit or card payment"),
});
export type Recurring = z.infer<typeof recurringSchema>;

interface Occurrence {
  date: string;
  amount: Decimal;
}

/**
 * Finds payments to or from one payee that repeat on a schedule. Same-day payments to one
 * payee are one occurrence. Refunds and cash withdrawals are never recurring.
 */
export function findRecurring(items: readonly AnalyzedTransaction[], today: string): Recurring[] {
  const streams = new Map<string, AnalyzedTransaction[]>();
  for (const item of items) {
    if (item.payee.key === "unknown" || item.kind === "refund" || item.kind === "cash_withdrawal") continue;
    const key = `${item.payee.key}\u0000${item.transaction.currency}\u0000${item.transaction.direction}`;
    streams.set(key, [...(streams.get(key) ?? []), item]);
  }

  const found: Recurring[] = [];
  for (const stream of streams.values()) {
    const recurring = detect(stream, today);
    if (recurring !== undefined) found.push(recurring);
  }
  return found.sort((left, right) =>
    (left.status === right.status ? 0 : left.status === "active" ? -1 : 1) ||
    new Money(right.monthlyEquivalent).comparedTo(left.monthlyEquivalent) ||
    left.payee.localeCompare(right.payee));
}

function detect(stream: readonly AnalyzedTransaction[], today: string): Recurring | undefined {
  const byDate = new Map<string, Decimal>();
  for (const item of stream) byDate.set(item.date, (byDate.get(item.date) ?? new Money(0)).plus(item.amount));
  const occurrences: Occurrence[] = [...byDate]
    .map(([date, amount]) => ({ date, amount }))
    .sort((left, right) => left.date.localeCompare(right.date));
  if (occurrences.length < 2) return undefined;

  const intervals = occurrences.slice(1).map((occurrence, index) => differenceInDays(occurrences[index]!.date, occurrence.date));
  const rule = CADENCES.find(({ minDays, maxDays }) => {
    const middle = median(intervals);
    return middle >= minDays && middle <= maxDays;
  });
  if (rule === undefined) return undefined;
  if (occurrences.length < (rule.cadence === "yearly" ? 2 : 3)) return undefined;
  const regular = intervals.filter((days) => days >= rule.minDays && days <= rule.maxDays).length;
  if (regular / intervals.length < MIN_REGULAR_SHARE) return undefined;

  const amounts = occurrences.map(({ amount }) => amount);
  const smallest = Money.min(...amounts);
  const largest = Money.max(...amounts);
  if ((rule.cadence === "weekly" || rule.cadence === "fortnightly") &&
      largest.greaterThan(smallest.times(MAX_SHORT_CADENCE_SPREAD))) return undefined;

  const first = stream[0]!;
  const currency = first.transaction.currency;
  const typical = medianAmount(amounts);
  const last = occurrences.at(-1)!;
  const before = occurrences.length >= 3 ? medianAmount(amounts.slice(0, -1)) : amounts[0]!;
  const fixed = amounts.every((amount) => amount.minus(typical).abs().lessThanOrEqualTo(typical.times(FIXED_AMOUNT_TOLERANCE)));
  const trend = last.amount.greaterThan(before.times(1 + TREND_THRESHOLD))
    ? "rising"
    : last.amount.lessThan(before.times(1 - TREND_THRESHOLD)) ? "falling" : "stable";
  const nextExpectedDate = rule.months === undefined ? addDays(last.date, rule.days) : shiftMonths(last.date, rule.months);
  const stoppedAfter = Math.round(rule.days * 1.5) + 3;
  const kind = mostCommon(stream.map(({ kind }) => kind)) as TransactionKind;
  const bankCategory = mostCommon(stream.map(({ transaction }) => transaction.bankTransactionDescription));

  return {
    payee: first.payee.name,
    payeeKey: first.payee.key,
    direction: first.transaction.direction === "debit" ? "out" : "in",
    kind,
    currency,
    cadence: rule.cadence,
    typicalAmount: formatAmount(typical, currency),
    lastAmount: formatAmount(last.amount, currency),
    amountPattern: fixed ? "fixed" : "variable",
    trend,
    monthlyEquivalent: formatAmount(typical.times(rule.perMonth).toDecimalPlaces(2), currency),
    occurrences: occurrences.length,
    firstDate: occurrences[0]!.date,
    lastDate: last.date,
    nextExpectedDate,
    status: differenceInDays(last.date, today) > stoppedAfter ? "stopped" : "active",
    accountIds: [...new Set(stream.map(({ transaction }) => transaction.accountId))],
    ...(bankCategory === undefined ? {} : { bankCategory }),
  };
}

export const upcomingSchema = z.object({
  date: z.string(),
  payee: z.string(),
  payeeKey: z.string(),
  direction: z.enum(["out", "in"]),
  kind: transactionKindSchema,
  amount: nonNegativeDecimalAmountSchema.describe("Typical amount; the last amount when it is rising"),
  currency: z.string(),
  accountIds: z.array(accountIdSchema),
  late: z.literal(true).optional().describe("Expected before today but not seen yet; may still arrive or may have stopped"),
});

const LATE_GRACE_DAYS = 5;

/** Expected occurrences of active recurring payments from a few days ago until a date. */
export function projectUpcoming(recurring: readonly Recurring[], today: string, until: string) {
  const upcoming: Array<z.infer<typeof upcomingSchema>> = [];
  for (const item of recurring) {
    if (item.status !== "active") continue;
    const rule = CADENCES.find(({ cadence }) => cadence === item.cadence)!;
    for (let cycle = 1; cycle <= 60; cycle += 1) {
      const date = rule.months === undefined
        ? addDays(item.lastDate, rule.days * cycle)
        : shiftMonths(item.lastDate, rule.months * cycle);
      if (date > until) break;
      if (differenceInDays(date, today) > LATE_GRACE_DAYS) continue;
      upcoming.push({
        date,
        payee: item.payee,
        payeeKey: item.payeeKey,
        direction: item.direction,
        kind: item.kind,
        amount: item.trend === "rising" ? item.lastAmount : item.typicalAmount,
        currency: item.currency,
        accountIds: item.accountIds,
        ...(date < today ? { late: true as const } : {}),
      });
    }
  }
  return upcoming.sort((left, right) => left.date.localeCompare(right.date) || left.payee.localeCompare(right.payee));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function medianAmount(values: readonly Decimal[]): Decimal {
  const sorted = [...values].sort((left, right) => left.comparedTo(right));
  // The upper middle value, so the typical amount is one that was actually paid.
  return sorted[Math.floor(sorted.length / 2)]!;
}

function mostCommon<T>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const value of values) if (value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: T | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}
