import type Decimal from "decimal.js";
import { z } from "zod";
import { accountIdSchema, nonNegativeDecimalAmountSchema, type AccountSummary } from "../finance";
import { formatAmount, Money } from "../lib/money";
import { OUTGOING_KINDS, transactionKindSchema, type AnalyzedTransaction } from "./classify";
import { change, changeSchema, inRange, percentOf, type DateRange } from "./periods";

export const breakdownGroupBySchema = z
  .enum(["payee", "account", "kind", "bank_category"])
  .default("payee")
  .describe("payee: who was paid (normalized merchant or person); account: which account; kind: spending, fee, cash withdrawal; bank_category: the bank's own transaction type, such as direct debit or card payment");
export type BreakdownGroupBy = z.infer<typeof breakdownGroupBySchema>;

export const breakdownDirectionSchema = z
  .enum(["out", "in"])
  .default("out")
  .describe("out: spending, fees and cash withdrawals (refunds shown per group); in: income from others. Transfers between your own accounts are never included");

export const MAX_TRANSACTIONS_PER_GROUP = 10;
// Keeps a detailed breakdown well under the size clients pass to the model inline.
export const MAX_BREAKDOWN_TRANSACTIONS = 100;

export const analyzedTransactionSchema = z.object({
  accountId: accountIdSchema,
  date: z.string().describe("Date used for the analysis: transaction date, else the booking or value date"),
  amount: nonNegativeDecimalAmountSchema,
  currency: z.string(),
  direction: z.enum(["credit", "debit"]),
  status: z.string(),
  payee: z.string().describe("Normalized payee name"),
  payeeKey: z.string().describe("Payee key; pass to finance_search_transactions as payeeKey"),
  kind: transactionKindSchema,
  kindReason: z.string().describe("Why the transaction got this kind; overrule it when you know better"),
  description: z.string().optional(),
  reference: z.string().optional(),
});

export function toAnalyzedTransactionOutput(item: AnalyzedTransaction): z.infer<typeof analyzedTransactionSchema> {
  const { transaction } = item;
  return {
    accountId: transaction.accountId,
    date: item.date,
    amount: transaction.amount,
    currency: transaction.currency,
    direction: transaction.direction,
    status: transaction.status,
    payee: item.payee.name,
    payeeKey: item.payee.key,
    kind: item.kind,
    kindReason: item.kindReason,
    ...(transaction.description === undefined ? {} : { description: transaction.description }),
    ...(transaction.reference === undefined ? {} : { reference: transaction.reference }),
  };
}

export const breakdownGroupSchema = z.object({
  key: z.string().describe("Group key; for payee groups, pass it to finance_search_transactions as payeeKey"),
  label: z.string(),
  total: nonNegativeDecimalAmountSchema,
  count: z.number().int(),
  sharePercent: z.string().describe("Share of this currency's total, one decimal"),
  firstDate: z.string(),
  lastDate: z.string(),
  refunded: nonNegativeDecimalAmountSchema.optional().describe("Refunds from this group in the same range; not subtracted from total"),
  comparisonTotal: nonNegativeDecimalAmountSchema.optional(),
  change: changeSchema.optional(),
  transactions: z.array(analyzedTransactionSchema).optional(),
});

export const currencyBreakdownSchema = z.object({
  total: nonNegativeDecimalAmountSchema,
  count: z.number().int(),
  groups: z.array(breakdownGroupSchema).describe("Largest groups first"),
  otherGroups: z.object({
    groups: z.number().int(),
    total: nonNegativeDecimalAmountSchema,
    count: z.number().int(),
  }).optional().describe("Everything past the group limit, combined"),
  comparisonTotal: nonNegativeDecimalAmountSchema.optional(),
  change: changeSchema.optional(),
});

interface Group {
  key: string;
  label: string;
  total: Decimal;
  count: number;
  firstDate: string;
  lastDate: string;
  items: AnalyzedTransaction[];
}

export function breakDown(
  items: readonly AnalyzedTransaction[],
  accounts: readonly AccountSummary[],
  options: {
    range: DateRange;
    comparison: DateRange | undefined;
    groupBy: BreakdownGroupBy;
    direction: "out" | "in";
    limit: number;
    includeTransactions: boolean;
  },
): Record<string, z.infer<typeof currencyBreakdownSchema>> {
  const accountLabels = new Map(accounts.map((account) => [
    account.accountId,
    [account.institution, account.product ?? account.cashAccountType, account.currency].join(" "),
  ]));
  const groupOf = (item: AnalyzedTransaction): { key: string; label: string } => {
    switch (options.groupBy) {
      case "payee":
        return { key: item.payee.key, label: item.payee.name };
      case "account":
        return {
          key: item.transaction.accountId,
          label: accountLabels.get(item.transaction.accountId) ?? item.transaction.accountId,
        };
      case "kind":
        return { key: item.kind, label: item.kind.replaceAll("_", " ") };
      case "bank_category": {
        const category = item.transaction.bankTransactionDescription?.trim().toLocaleLowerCase() || "not given";
        return { key: category, label: category };
      }
    }
  };
  const counts = (item: AnalyzedTransaction) =>
    options.direction === "out" ? OUTGOING_KINDS.has(item.kind) : item.kind === "income";

  const current = collect(items, options.range, counts, groupOf);
  const refunds = options.direction === "out"
    ? collect(items, options.range, (item) => item.kind === "refund", groupOf)
    : new Map<string, Map<string, Group>>();
  const previous = options.comparison === undefined
    ? undefined
    : collect(items, options.comparison, counts, groupOf);

  const result: Record<string, z.infer<typeof currencyBreakdownSchema>> = {};
  const currencies = new Set([...current.keys(), ...(previous?.keys() ?? [])]);
  // Listed groups across every currency share one transaction budget.
  const listedGroups = [...current.values()].reduce((sum, groups) => sum + Math.min(groups.size, options.limit), 0);
  const perGroup = Math.max(1, Math.min(MAX_TRANSACTIONS_PER_GROUP, Math.floor(MAX_BREAKDOWN_TRANSACTIONS / Math.max(listedGroups, 1))));
  for (const currency of currencies) {
    const groups = [...(current.get(currency)?.values() ?? [])]
      .sort((left, right) => right.total.comparedTo(left.total) || left.label.localeCompare(right.label));
    const total = groups.reduce((sum, group) => sum.plus(group.total), new Money(0));
    const count = groups.reduce((sum, group) => sum + group.count, 0);
    const previousGroups = previous?.get(currency);
    const previousTotal = previousGroups === undefined
      ? new Money(0)
      : [...previousGroups.values()].reduce((sum, group) => sum.plus(group.total), new Money(0));
    const shown = groups.slice(0, options.limit);
    const rest = groups.slice(options.limit);

    result[currency] = {
      total: formatAmount(total, currency),
      count,
      groups: shown.map((group) => {
        const refunded = refunds.get(currency)?.get(group.key)?.total;
        const before = previousGroups?.get(group.key)?.total ?? new Money(0);
        return {
          key: group.key,
          label: group.label,
          total: formatAmount(group.total, currency),
          count: group.count,
          sharePercent: percentOf(group.total, total),
          firstDate: group.firstDate,
          lastDate: group.lastDate,
          ...(refunded === undefined ? {} : { refunded: formatAmount(refunded, currency) }),
          ...(previous === undefined ? {} : {
            comparisonTotal: formatAmount(before, currency),
            change: change(group.total, before, currency),
          }),
          ...(options.includeTransactions ? {
            transactions: group.items
              .slice(-perGroup)
              .reverse()
              .map(toAnalyzedTransactionOutput),
          } : {}),
        };
      }),
      ...(rest.length === 0 ? {} : {
        otherGroups: {
          groups: rest.length,
          total: formatAmount(rest.reduce((sum, group) => sum.plus(group.total), new Money(0)), currency),
          count: rest.reduce((sum, group) => sum + group.count, 0),
        },
      }),
      ...(previous === undefined ? {} : {
        comparisonTotal: formatAmount(previousTotal, currency),
        change: change(total, previousTotal, currency),
      }),
    };
  }
  return result;
}

function collect(
  items: readonly AnalyzedTransaction[],
  range: DateRange,
  counts: (item: AnalyzedTransaction) => boolean,
  groupOf: (item: AnalyzedTransaction) => { key: string; label: string },
): Map<string, Map<string, Group>> {
  const byCurrency = new Map<string, Map<string, Group>>();
  for (const item of items) {
    if (!inRange(item.date, range) || !counts(item)) continue;
    const { key, label } = groupOf(item);
    const groups = byCurrency.get(item.transaction.currency) ?? new Map<string, Group>();
    byCurrency.set(item.transaction.currency, groups);
    const group = groups.get(key) ?? {
      key, label, total: new Money(0), count: 0,
      firstDate: item.date, lastDate: item.date, items: [],
    };
    group.total = group.total.plus(item.amount);
    group.count += 1;
    if (item.date < group.firstDate) group.firstDate = item.date;
    if (item.date > group.lastDate) group.lastDate = item.date;
    group.items.push(item);
    groups.set(key, group);
  }
  return byCurrency;
}
