import type { McpServer } from "@modelcontextprotocol/server";
import type Decimal from "decimal.js";
import { z } from "zod";
import type { FinanceReads } from "../cache/reads";
import { breakDown, breakdownDirectionSchema, MAX_BREAKDOWN_TRANSACTIONS, MAX_TRANSACTIONS_PER_GROUP, breakdownGroupBySchema, currencyBreakdownSchema } from "../analysis/breakdown";
import { cashFlowComparisonSchema, flowTotalsSchema, summarizeCashFlow } from "../analysis/cash-flow";
import { analyzeTransactions, type AnalyzedTransaction } from "../analysis/classify";
import { scanIncompleteReasonSchema, type History } from "../analysis/history";
import { comparisonRange, compareToSchema, shiftMonths, type DateRange } from "../analysis/periods";
import { findRecurring, projectUpcoming, recurringSchema, upcomingSchema } from "../analysis/recurring";
import { findingSchema, findingTypeSchema, reviewActivity } from "../analysis/review";
import { PublicError } from "../errors";
import { accountIdSchema, accountReadErrorSchema, isoDateSchema, nonNegativeDecimalAmountSchema } from "../finance";
import { addDays, differenceInDays, earlierDate, todayIsoDate } from "../lib/dates";
import { formatAmount, Money } from "../lib/money";
import { annotations, dateRangeSchema, providerErrorsSchema, safeResult, withProviderErrors } from "./common";

// Provider pages one analysis may read: about a year of every account of a personal setup.
const MAX_ANALYSIS_PAGES = 40;
// Banks filter by booking date; purchases made a few days earlier or later still count.
const DATE_PADDING_DAYS = 7;
const MAX_RECURRING_RESULTS = 50;
const HISTORY_GAP_DAYS = 31;
const UPCOMING_MAX_DAYS = 92;

const analysisIncompleteReasonSchema = z.enum([
  ...scanIncompleteReasonSchema.options,
  "missing_dates",
  "unknown_status",
  "history_starts_late",
]);

const coverageSchema = {
  complete: z.boolean().describe("True when every account and page in the range was read and nothing was skipped; otherwise totals are a lower bound"),
  incompleteReasons: z.array(analysisIncompleteReasonSchema),
  pagesScanned: z.number().int().describe("Bank pages read for this call; zero when everything came from recently read data"),
  dataAsOf: z.string().optional().describe("When the oldest bank data in this result was read (ISO 8601). Recent reads are reused for up to five minutes, so a payment made in the last few minutes may not show yet"),
  accountErrors: z.array(accountReadErrorSchema).optional().describe("Accounts that could not be read, for example because the bank rate-limited the request; their transactions are missing"),
  dataStartsOn: z.string().optional().describe("Present with history_starts_late: the earliest transaction any account returned. Banks often share only about 90 days of history for a new connection, so periods before this date are unknown, not zero"),
  providerErrors: providerErrorsSchema,
};

const KIND_NOTE =
  "Transactions are labelled spending, income, refund, fee, cash_withdrawal or internal_transfer (moves between the owner's own accounts, savings and currencies, found by matching amounts across accounts, the holder's name or the bank's wording); internal transfers never count as income or spending.";

interface Analysis {
  history: History;
  items: AnalyzedTransaction[];
  coverage: {
    complete: boolean;
    incompleteReasons: Array<z.infer<typeof analysisIncompleteReasonSchema>>;
    pagesScanned: number;
    dataAsOf?: string;
    accountErrors?: History["accountErrors"];
    dataStartsOn?: string;
    providerErrors?: History["providerErrors"];
  };
}

async function analyze(provider: FinanceReads, range: DateRange, accountId: string | undefined): Promise<Analysis> {
  const today = todayIsoDate();
  const history = await provider.readHistory(
    { dateFrom: addDays(range.dateFrom, -DATE_PADDING_DAYS), dateTo: earlierDate(addDays(range.dateTo, DATE_PADDING_DAYS), today) },
    { ...(accountId === undefined ? {} : { accountId }), maxPages: MAX_ANALYSIS_PAGES },
  );
  const { analyzed, skipped } = analyzeTransactions(history.transactions, history.accounts);
  const incompleteReasons: Analysis["coverage"]["incompleteReasons"] = [...history.incompleteReasons];
  if (skipped.missingDate > 0) incompleteReasons.push("missing_dates");
  if (skipped.unknownStatus > 0) incompleteReasons.push("unknown_status");
  // No account has anything in the first month of the range: most likely the banks did not
  // share that far back, rather than a month with no activity at all.
  const earliest = history.transactions
    .map((transaction) => transaction.transactionDate ?? transaction.bookingDate ?? transaction.valueDate)
    .filter((date): date is string => date !== undefined)
    .sort()[0];
  const lateStart = earliest !== undefined && differenceInDays(range.dateFrom, earliest) > HISTORY_GAP_DAYS;
  if (lateStart) incompleteReasons.push("history_starts_late");
  return {
    history,
    items: analyzed,
    coverage: {
      complete: incompleteReasons.length === 0,
      incompleteReasons,
      pagesScanned: history.pagesScanned,
      ...(history.dataAsOf === undefined ? {} : { dataAsOf: history.dataAsOf }),
      ...(history.accountErrors.length === 0 ? {} : { accountErrors: history.accountErrors }),
      ...(lateStart ? { dataStartsOn: earliest } : {}),
      ...withProviderErrors(history.providerErrors),
    },
  };
}

/** The range covering both the requested period and its comparison. */
function readRange(range: DateRange, comparison: DateRange | undefined): DateRange {
  return comparison === undefined ? range : { dateFrom: comparison.dateFrom, dateTo: range.dateTo };
}

export function registerAnalysisTools(server: McpServer, provider: FinanceReads): void {
  server.registerTool(
    "finance_get_cash_flow",
    {
      title: "Get cash flow",
      description:
        `Money in, money out and net per currency for a date range, across all accounts or one, split by month or week, optionally compared with the previous period or the same period last year. Answers questions like "am I spending more than I earn?" and "how did this month compare?". ${KIND_NOTE} Includes pending card payments; amounts are never converted between currencies. Dates are transaction dates where the bank gives them, otherwise booking or value dates.`,
      inputSchema: dateRangeSchema.extend({
        accountId: accountIdSchema.optional().describe("One account; omit for all accounts, which also finds transfers between them"),
        groupBy: z.enum(["month", "week", "none"]).default("month").describe("Split the range into calendar months or Monday-to-Sunday weeks"),
        compareTo: compareToSchema,
      }),
      outputSchema: z.object({
        totalsByCurrency: z.record(z.string(), flowTotalsSchema),
        periods: z.array(z.object({
          period: z.string().describe("YYYY-MM for months, the Monday's date for weeks"),
          dateFrom: z.string(),
          dateTo: z.string(),
          totalsByCurrency: z.record(z.string(), flowTotalsSchema),
        })).optional().describe("Partial first and last periods are clipped to the range"),
        comparison: cashFlowComparisonSchema.optional(),
        ...coverageSchema,
      }),
      annotations,
    },
    async ({ dateFrom, dateTo, accountId, groupBy, compareTo }) =>
      safeResult(async () => {
        const range = { dateFrom, dateTo };
        const comparison = comparisonRange(range, compareTo);
        const { items, coverage } = await analyze(provider, readRange(range, comparison), accountId);
        return { ...summarizeCashFlow(items, range, groupBy, comparison), ...coverage };
      }),
  );

  server.registerTool(
    "finance_get_spending_breakdown",
    {
      title: "Get spending breakdown",
      description:
        `Where money went (or came from) in a date range, grouped by payee, account, kind or the bank's transaction type, largest first, per currency, with each group's share and optionally its change against the previous period or the same period last year. Answers "where did my money go?", "what did I spend most on?" and "is that more than usual?". Payees are normalized (card numbers, dates and reference codes removed), so one merchant is one group. There are no spending categories. ${KIND_NOTE} Refunds are shown per group, not subtracted. Use a group's key as payeeKey in finance_search_transactions to see its transactions.`,
      inputSchema: dateRangeSchema.extend({
        accountId: accountIdSchema.optional().describe("One account; omit for all accounts, which also finds transfers between them"),
        groupBy: breakdownGroupBySchema,
        direction: breakdownDirectionSchema,
        compareTo: compareToSchema,
        limit: z.number().int().min(1).max(50).default(15).describe("Groups to list per currency; the rest are combined in otherGroups"),
        includeTransactions: z.boolean().default(false).describe(`Add each listed group's latest transactions: up to ${MAX_TRANSACTIONS_PER_GROUP} per group and ${MAX_BREAKDOWN_TRANSACTIONS} in all`),
      }),
      outputSchema: z.object({
        byCurrency: z.record(z.string(), currencyBreakdownSchema).describe("One breakdown per currency; amounts of different currencies are never combined"),
        ...coverageSchema,
      }),
      annotations,
    },
    async ({ dateFrom, dateTo, accountId, groupBy, direction, compareTo, limit, includeTransactions }) =>
      safeResult(async () => {
        const range = { dateFrom, dateTo };
        const comparison = comparisonRange(range, compareTo);
        const { history, items, coverage } = await analyze(provider, readRange(range, comparison), accountId);
        return {
          byCurrency: breakDown(items, history.accounts, { range, comparison, groupBy, direction, limit, includeTransactions }),
          ...coverage,
        };
      }),
  );

  server.registerTool(
    "finance_list_recurring",
    {
      title: "List recurring payments",
      description:
        `Payments and income that repeat on a schedule (weekly to yearly), found in up to 12 months of history: subscriptions, bills, rent, salary and regular transfers to savings. Each has its cadence, typical and latest amount, whether the amount is rising, the next expected date, and whether it is still active. Set upcomingUntil to list what is expected to leave or arrive before a date, for questions like "what's left before payday?" (combine with finance_get_balances). Detection needs at least three payments (two for yearly), so new subscriptions may not appear yet. ${KIND_NOTE}`,
      inputSchema: z.object({
        accountId: accountIdSchema.optional().describe("One account; omit for all accounts"),
        lookbackMonths: z.number().int().min(3).max(12).default(12).describe("Months of history to read; more finds quarterly and yearly payments"),
        upcomingUntil: isoDateSchema.optional().describe(`List expected occurrences from today until this date (at most ${UPCOMING_MAX_DAYS} days ahead)`),
        includeStopped: z.boolean().default(false).describe("Also list recurring payments that seem to have stopped"),
      }),
      outputSchema: z.object({
        recurring: z.array(recurringSchema).describe("Active first, then by monthly cost"),
        monthlyByCurrency: z.record(z.string(), z.object({
          out: nonNegativeDecimalAmountSchema.describe("Monthly equivalent of active recurring payments to others"),
          in: nonNegativeDecimalAmountSchema.describe("Monthly equivalent of active recurring income from others"),
        })).describe("Excludes regular transfers between your own accounts"),
        upcoming: z.array(upcomingSchema).optional(),
        ...coverageSchema,
      }),
      annotations,
    },
    async ({ accountId, lookbackMonths, upcomingUntil, includeStopped }) =>
      safeResult(async () => {
        const today = todayIsoDate();
        if (upcomingUntil !== undefined && (upcomingUntil < today || differenceInDays(today, upcomingUntil) > UPCOMING_MAX_DAYS)) {
          throw new PublicError(
            `upcomingUntil must be between today (${today}, UTC) and ${addDays(today, UPCOMING_MAX_DAYS)}.`,
            "invalid_date_range",
          );
        }
        const range = { dateFrom: addDays(shiftMonths(today, -lookbackMonths), 1), dateTo: today };
        const { items, coverage } = await analyze(provider, range, accountId);
        const recurring = findRecurring(items, today);
        const monthly = new Map<string, { out: Decimal; in: Decimal }>();
        for (const item of recurring) {
          if (item.status !== "active" || item.kind === "internal_transfer") continue;
          const totals = monthly.get(item.currency) ?? { out: new Money(0), in: new Money(0) };
          totals[item.direction] = totals[item.direction].plus(item.monthlyEquivalent);
          monthly.set(item.currency, totals);
        }
        return {
          recurring: recurring.filter((item) => includeStopped || item.status === "active").slice(0, MAX_RECURRING_RESULTS),
          monthlyByCurrency: Object.fromEntries([...monthly].map(([currency, totals]) => [currency, {
            out: formatAmount(totals.out, currency),
            in: formatAmount(totals.in, currency),
          }])),
          ...(upcomingUntil === undefined ? {} : { upcoming: projectUpcoming(recurring, today, upcomingUntil) }),
          ...coverage,
        };
      }),
  );

  server.registerTool(
    "finance_review_activity",
    {
      title: "Review activity",
      description:
        `Flag activity in a date range worth a second look, judged against the months before it: possible duplicate charges, fees and interest, recurring payments whose price rose, regular payments or income that did not arrive, payments much larger than usual for that payee, unusually large payments, and first payments to new payees. Answers "anything I should look at?" and "anything odd this month?". Findings are prompts to check, not conclusions: two equal payments can both be real. Each finding has its supporting transactions. ${KIND_NOTE}`,
      inputSchema: dateRangeSchema.extend({
        accountId: accountIdSchema.optional().describe("One account; omit for all accounts"),
        baselineMonths: z.number().int().min(1).max(6).default(3).describe("Months before dateFrom used to judge what is usual"),
      }),
      outputSchema: z.object({
        findings: z.array(findingSchema).describe("Grouped by type, at most 10 per type"),
        truncatedTypes: z.array(findingTypeSchema).optional().describe("Finding types that had more than 10 results"),
        baseline: z.object({ dateFrom: z.string(), dateTo: z.string() }),
        ...coverageSchema,
      }),
      annotations,
    },
    async ({ dateFrom, dateTo, accountId, baselineMonths }) =>
      safeResult(async () => {
        const range = { dateFrom, dateTo };
        const baseline = { dateFrom: shiftMonths(dateFrom, -baselineMonths), dateTo: addDays(dateFrom, -1) };
        const { items, coverage } = await analyze(provider, { dateFrom: baseline.dateFrom, dateTo }, accountId);
        const usable = items.filter((item) => item.date >= baseline.dateFrom && item.date <= dateTo);
        const { findings, truncated } = reviewActivity(usable, range, todayIsoDate(), baseline.dateFrom);
        return {
          findings,
          ...(truncated.length === 0 ? {} : { truncatedTypes: truncated }),
          baseline,
          ...coverage,
        };
      }),
  );
}
