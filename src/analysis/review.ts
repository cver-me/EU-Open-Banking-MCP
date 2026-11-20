import type Decimal from "decimal.js";
import { z } from "zod";
import { addDays, differenceInDays, earlierDate } from "../lib/dates";
import { formatAmount, Money } from "../lib/money";
import { analyzedTransactionSchema, toAnalyzedTransactionOutput } from "./breakdown";
import { OUTGOING_KINDS, type AnalyzedTransaction } from "./classify";
import { inRange, type DateRange } from "./periods";
import { findRecurring } from "./recurring";

export const findingTypeSchema = z.enum([
  "possible_duplicate",
  "fee",
  "price_increase",
  "missed_recurring",
  "unusual_amount",
  "large_payment",
  "new_payee",
]);
type FindingType = z.infer<typeof findingTypeSchema>;

export const findingSchema = z.object({
  type: findingTypeSchema,
  detail: z.string().describe("One-line explanation of why this was flagged"),
  payee: z.string().optional(),
  payeeKey: z.string().optional(),
  currency: z.string(),
  amount: z.string().optional().describe("The amount the finding is about, in currency"),
  date: z.string().optional(),
  transactions: z.array(analyzedTransactionSchema).describe("Supporting transactions, at most five"),
});
type Finding = z.infer<typeof findingSchema>;

// Fixed defaults for a personal account, documented in the README; not tuned per user.
const DUPLICATE_WINDOW_DAYS = 1;
// Paid this amount to this payee this many times before: a habit, not a duplicate.
const HABIT_COUNT = 3;
const UNUSUAL_FACTOR = 2;
const MIN_PAYEE_HISTORY = 3;
const LARGE_FACTOR = 10;
const MAX_FINDINGS_PER_TYPE = 10;
const MAX_LARGE_PAYMENTS = 5;
const NEW_PAYEE_FACTOR = 3;
const ACCOUNT_HISTORY_GRACE_DAYS = 31;
const MISSED_GRACE_DAYS = 5;
const ORDER: readonly FindingType[] = findingTypeSchema.options;

/**
 * Flags activity in a range worth a second look, judged against the history before it.
 * Findings are prompts to check, not conclusions: a duplicate may be two real purchases.
 */
export function reviewActivity(
  items: readonly AnalyzedTransaction[],
  range: DateRange,
  today: string,
  /** Start of the history used to judge what is usual; defaults to the earliest transaction. */
  baselineFrom: string = items[0]?.date ?? range.dateFrom,
): { findings: Finding[]; truncated: FindingType[] } {
  const inWindow = items.filter((item) => inRange(item.date, range));
  const baseline = items.filter((item) => item.date < range.dateFrom);
  const outgoing = inWindow.filter((item) => OUTGOING_KINDS.has(item.kind));
  const findings: Finding[] = [
    ...duplicates(outgoing, baseline),
    ...outgoing.filter((item) => item.kind === "fee").map((item) => single("fee", item, "The bank describes this as a fee, charge or interest")),
    ...priceIncreases(items, range, today),
    ...missedRecurring(baseline, inWindow, range, today),
    ...unusualAmounts(outgoing, baseline),
    ...largePayments(outgoing, baseline, items),
    ...newPayees(outgoing, baseline, items, baselineFrom),
  ];

  // Findings are built most specific first; a transaction is reported once, under the first.
  const reported = new Set<string>();
  const distinct = findings.filter((finding) => {
    const keys = finding.transactions.map(transactionIdentity);
    if (keys.length > 0 && keys.every((key) => reported.has(key))) return false;
    for (const key of keys) reported.add(key);
    return true;
  });

  const truncated = new Set<FindingType>();
  const counts = new Map<FindingType, number>();
  const kept = distinct.filter((finding) => {
    const count = (counts.get(finding.type) ?? 0) + 1;
    counts.set(finding.type, count);
    if (count > MAX_FINDINGS_PER_TYPE) truncated.add(finding.type);
    return count <= MAX_FINDINGS_PER_TYPE;
  });
  kept.sort((left, right) => ORDER.indexOf(left.type) - ORDER.indexOf(right.type));
  return { findings: kept, truncated: [...truncated] };
}

function single(type: FindingType, item: AnalyzedTransaction, detail: string): Finding {
  return {
    type,
    detail,
    payee: item.payee.name,
    payeeKey: item.payee.key,
    currency: item.transaction.currency,
    amount: formatAmount(item.amount, item.transaction.currency),
    date: item.date,
    transactions: [toAnalyzedTransactionOutput(item)],
  };
}

function transactionIdentity(transaction: Finding["transactions"][number]): string {
  return [transaction.accountId, transaction.reference ?? "", transaction.date, transaction.amount, transaction.direction].join("\u0000");
}

function duplicates(outgoing: readonly AnalyzedTransaction[], baseline: readonly AnalyzedTransaction[]): Finding[] {
  const habits = new Map<string, number>();
  for (const item of baseline) {
    const key = `${item.payee.key}\u0000${item.transaction.currency}\u0000${item.amount.toString()}`;
    habits.set(key, (habits.get(key) ?? 0) + 1);
  }
  const findings: Finding[] = [];
  const flagged = new Set<AnalyzedTransaction>();
  for (const [index, item] of outgoing.entries()) {
    if (flagged.has(item) || item.payee.key === "unknown") continue;
    const habit = habits.get(`${item.payee.key}\u0000${item.transaction.currency}\u0000${item.amount.toString()}`) ?? 0;
    if (habit >= HABIT_COUNT) continue;
    const twins = outgoing.slice(index + 1).filter((other) =>
      !flagged.has(other) &&
      other.payee.key === item.payee.key &&
      other.transaction.currency === item.transaction.currency &&
      other.transaction.status === item.transaction.status &&
      other.amount.equals(item.amount) &&
      // Different payment references in the description mean two separate payments.
      (other.transaction.description === undefined || item.transaction.description === undefined ||
        other.transaction.description === item.transaction.description) &&
      Math.abs(differenceInDays(item.date, other.date)) <= DUPLICATE_WINDOW_DAYS);
    if (twins.length === 0) continue;
    const group = [item, ...twins];
    for (const member of group) flagged.add(member);
    findings.push({
      ...single("possible_duplicate", item, `${group.length} payments of the same amount to the same payee on the same or the next day`),
      transactions: group.slice(0, 5).map(toAnalyzedTransactionOutput),
    });
  }
  return findings;
}

function priceIncreases(items: readonly AnalyzedTransaction[], range: DateRange, today: string): Finding[] {
  return findRecurring(items, today)
    // Above twice the usual amount it is an unusual payment, not a price change.
    .filter((stream) => stream.direction === "out" && stream.trend === "rising" && inRange(stream.lastDate, range) &&
      new Money(stream.lastAmount).lessThanOrEqualTo(new Money(stream.typicalAmount).times(UNUSUAL_FACTOR)))
    .map((stream) => ({
      type: "price_increase" as const,
      detail: `Recurring ${stream.cadence} payment rose to ${stream.lastAmount} from a typical ${stream.typicalAmount}`,
      payee: stream.payee,
      payeeKey: stream.payeeKey,
      currency: stream.currency,
      amount: stream.lastAmount,
      date: stream.lastDate,
      transactions: items
        .filter((item) => item.payee.key === stream.payeeKey && item.transaction.currency === stream.currency &&
          item.transaction.direction === "debit")
        .slice(-5)
        .reverse()
        .map(toAnalyzedTransactionOutput),
    }));
}

/** Regular payments seen before the range whose next occurrence was due in it and never came. */
function missedRecurring(
  baseline: readonly AnalyzedTransaction[],
  inWindow: readonly AnalyzedTransaction[],
  range: DateRange,
  today: string,
): Finding[] {
  const dueBy = earlierDate(range.dateTo, addDays(today, -MISSED_GRACE_DAYS));
  return findRecurring(baseline, range.dateFrom)
    .filter((stream) =>
      stream.status === "active" &&
      stream.nextExpectedDate >= range.dateFrom &&
      stream.nextExpectedDate <= dueBy &&
      !inWindow.some((item) =>
        item.payee.key === stream.payeeKey &&
        item.transaction.currency === stream.currency &&
        (item.transaction.direction === "debit") === (stream.direction === "out")))
    .map((stream) => ({
      type: "missed_recurring" as const,
      detail: `${stream.direction === "in" ? "Regular income" : "Regular payment"} expected around ${stream.nextExpectedDate} (${stream.cadence}, typically ${stream.typicalAmount}) was not seen in this range`,
      payee: stream.payee,
      payeeKey: stream.payeeKey,
      currency: stream.currency,
      amount: stream.typicalAmount,
      date: stream.nextExpectedDate,
      transactions: [],
    }));
}

function unusualAmounts(outgoing: readonly AnalyzedTransaction[], baseline: readonly AnalyzedTransaction[]): Finding[] {
  const history = new Map<string, Decimal[]>();
  for (const item of baseline) {
    if (!OUTGOING_KINDS.has(item.kind)) continue;
    const key = `${item.payee.key}\u0000${item.transaction.currency}`;
    history.set(key, [...(history.get(key) ?? []), item.amount]);
  }
  return outgoing.flatMap((item) => {
    const previous = history.get(`${item.payee.key}\u0000${item.transaction.currency}`);
    if (previous === undefined || previous.length < MIN_PAYEE_HISTORY) return [];
    const usual = median(previous);
    if (!item.amount.greaterThan(usual.times(UNUSUAL_FACTOR))) return [];
    return [single("unusual_amount", item,
      `${formatAmount(item.amount, item.transaction.currency)} against a usual ${formatAmount(usual, item.transaction.currency)} over ${previous.length} earlier payments to this payee`)];
  });
}

/** The largest payments in the range, far above the typical payment, to payees not paid before. */
function largePayments(
  outgoing: readonly AnalyzedTransaction[],
  baseline: readonly AnalyzedTransaction[],
  all: readonly AnalyzedTransaction[],
): Finding[] {
  const typical = typicalPayments(all);
  const known = new Set(baseline.map(({ payee }) => payee.key));
  return outgoing
    .filter((item) => {
      const usual = typical.get(item.transaction.currency);
      return usual !== undefined && !known.has(item.payee.key) && item.amount.greaterThan(usual.times(LARGE_FACTOR));
    })
    .sort((left, right) => right.amount.comparedTo(left.amount))
    .slice(0, MAX_LARGE_PAYMENTS)
    .map((item) => single("large_payment", item,
      `More than ${LARGE_FACTOR} times your typical payment of ${formatAmount(typical.get(item.transaction.currency)!, item.transaction.currency)}, to a payee not paid before`));
}

function newPayees(
  outgoing: readonly AnalyzedTransaction[],
  baseline: readonly AnalyzedTransaction[],
  all: readonly AnalyzedTransaction[],
  baselineStart: string,
): Finding[] {
  if (baseline.length === 0) return [];
  const typical = typicalPayments(all);
  const known = new Set(baseline.map(({ payee }) => payee.key));
  // An account whose history starts late in the baseline (a new account, or a bank that
  // shares little history) makes every payee look new; judge only accounts that cover it.
  const firstDates = new Map<string, string>();
  for (const { transaction, date } of baseline) {
    if (!firstDates.has(transaction.accountId)) firstDates.set(transaction.accountId, date);
  }
  const accountsWithHistory = new Set([...firstDates]
    .filter(([, first]) => differenceInDays(baselineStart, first) <= ACCOUNT_HISTORY_GRACE_DAYS)
    .map(([accountId]) => accountId));
  const totals = new Map<string, { items: AnalyzedTransaction[]; total: Decimal }>();
  for (const item of outgoing) {
    if (known.has(item.payee.key) || item.payee.key === "unknown") continue;
    if (!accountsWithHistory.has(item.transaction.accountId)) continue;
    const key = `${item.payee.key}\u0000${item.transaction.currency}`;
    const entry = totals.get(key) ?? { items: [], total: new Money(0) };
    entry.items.push(item);
    entry.total = entry.total.plus(item.amount);
    totals.set(key, entry);
  }
  return [...totals.values()]
    .filter(({ items, total }) => {
      const usual = typical.get(items[0]!.transaction.currency);
      return usual === undefined || total.greaterThanOrEqualTo(usual.times(NEW_PAYEE_FACTOR));
    })
    .sort((left, right) => right.total.comparedTo(left.total))
    .map(({ items, total }) => {
      const first = items[0]!;
      const currency = first.transaction.currency;
      return {
        ...single("new_payee", first, `First payments to this payee in the history read: ${items.length} totalling ${formatAmount(total, currency)}`),
        amount: formatAmount(total, currency),
        transactions: items.slice(0, 5).map(toAnalyzedTransactionOutput),
      };
    });
}

/** Median outgoing payment per currency, when there are enough payments to judge. */
function typicalPayments(all: readonly AnalyzedTransaction[]): Map<string, Decimal> {
  const amounts = new Map<string, Decimal[]>();
  for (const item of all) {
    if (!OUTGOING_KINDS.has(item.kind)) continue;
    amounts.set(item.transaction.currency, [...(amounts.get(item.transaction.currency) ?? []), item.amount]);
  }
  return new Map([...amounts].filter(([, values]) => values.length >= 10).map(([currency, values]) => [currency, median(values)]));
}

function median(values: readonly Decimal[]): Decimal {
  const sorted = [...values].sort((left, right) => left.comparedTo(right));
  return sorted[Math.floor(sorted.length / 2)] ?? new Money(0);
}
