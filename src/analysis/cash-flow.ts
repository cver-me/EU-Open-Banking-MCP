import type Decimal from "decimal.js";
import { z } from "zod";
import { exactDecimalAmountSchema, nonNegativeDecimalAmountSchema } from "../finance";
import { formatAmount, Money } from "../lib/money";
import type { AnalyzedTransaction } from "./classify";
import { change, changeSchema, inRange, periodsIn, type DateRange, type PeriodSize } from "./periods";

export const flowTotalsSchema = z.object({
  income: nonNegativeDecimalAmountSchema.describe("Money received from others, excluding refunds and your own transfers"),
  spending: nonNegativeDecimalAmountSchema.describe("Money paid to others: purchases, bills, fees and cash withdrawals"),
  refunds: nonNegativeDecimalAmountSchema.describe("Money returned by payees you paid; offsets spending"),
  net: exactDecimalAmountSchema.describe("income + refunds - spending; negative when more went out than came in"),
  transfersBetweenOwnAccounts: z.object({
    in: nonNegativeDecimalAmountSchema,
    out: nonNegativeDecimalAmountSchema,
  }).describe("Moves between your own accounts and savings; excluded from income, spending and net. Can differ in and out when only one side is connected or currencies differ"),
  transactions: z.number().int().describe("Number of transactions counted, including transfers"),
});

interface Flow {
  income: Decimal;
  spending: Decimal;
  refunds: Decimal;
  transferIn: Decimal;
  transferOut: Decimal;
  transactions: number;
}

const emptyFlow = (): Flow => ({
  income: new Money(0),
  spending: new Money(0),
  refunds: new Money(0),
  transferIn: new Money(0),
  transferOut: new Money(0),
  transactions: 0,
});

function addTo(flow: Flow, item: AnalyzedTransaction): void {
  flow.transactions += 1;
  switch (item.kind) {
    case "income":
      flow.income = flow.income.plus(item.amount);
      return;
    case "refund":
      flow.refunds = flow.refunds.plus(item.amount);
      return;
    case "internal_transfer":
      if (item.transaction.direction === "credit") flow.transferIn = flow.transferIn.plus(item.amount);
      else flow.transferOut = flow.transferOut.plus(item.amount);
      return;
    default:
      flow.spending = flow.spending.plus(item.amount);
  }
}

function sumByCurrency(items: readonly AnalyzedTransaction[], range: DateRange): Map<string, Flow> {
  const byCurrency = new Map<string, Flow>();
  for (const item of items) {
    if (!inRange(item.date, range)) continue;
    const flow = byCurrency.get(item.transaction.currency) ?? emptyFlow();
    addTo(flow, item);
    byCurrency.set(item.transaction.currency, flow);
  }
  return byCurrency;
}

const net = (flow: Flow) => flow.income.plus(flow.refunds).minus(flow.spending);

function format(flow: Flow, currency: string) {
  return {
    income: formatAmount(flow.income, currency),
    spending: formatAmount(flow.spending, currency),
    refunds: formatAmount(flow.refunds, currency),
    net: formatAmount(net(flow), currency),
    transfersBetweenOwnAccounts: {
      in: formatAmount(flow.transferIn, currency),
      out: formatAmount(flow.transferOut, currency),
    },
    transactions: flow.transactions,
  };
}

export const cashFlowComparisonSchema = z.object({
  dateFrom: z.string(),
  dateTo: z.string(),
  totalsByCurrency: z.record(z.string(), flowTotalsSchema),
  changeByCurrency: z.record(z.string(), z.object({
    income: changeSchema,
    spending: changeSchema,
    net: changeSchema,
  })).describe("Current period minus comparison period, per currency"),
});

export function summarizeCashFlow(
  items: readonly AnalyzedTransaction[],
  range: DateRange,
  periodSize: PeriodSize | "none",
  comparison: DateRange | undefined,
) {
  const totals = sumByCurrency(items, range);
  const formatAll = (flows: Map<string, Flow>) =>
    Object.fromEntries([...flows].map(([currency, flow]) => [currency, format(flow, currency)]));

  const periods = periodSize === "none"
    ? undefined
    : periodsIn(range, periodSize).map((period) => ({
      ...period,
      totalsByCurrency: formatAll(sumByCurrency(items, period)),
    }));

  let comparisonResult: z.infer<typeof cashFlowComparisonSchema> | undefined;
  if (comparison !== undefined) {
    const previous = sumByCurrency(items, comparison);
    const currencies = new Set([...totals.keys(), ...previous.keys()]);
    comparisonResult = {
      ...comparison,
      totalsByCurrency: formatAll(previous),
      changeByCurrency: Object.fromEntries([...currencies].map((currency) => {
        const now = totals.get(currency) ?? emptyFlow();
        const before = previous.get(currency) ?? emptyFlow();
        return [currency, {
          income: change(now.income, before.income, currency),
          spending: change(now.spending, before.spending, currency),
          net: change(net(now), net(before), currency),
        }];
      })),
    };
  }

  return {
    totalsByCurrency: formatAll(totals),
    ...(periods === undefined ? {} : { periods }),
    ...(comparisonResult === undefined ? {} : { comparison: comparisonResult }),
  };
}
