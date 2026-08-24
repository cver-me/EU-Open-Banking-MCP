import { McpServer } from "@modelcontextprotocol/server";
import Decimal from "decimal.js";
import { z } from "zod";
import type { AppConfig } from "../config";
import { errorMessage } from "../errors";
import {
  accountIdSchema,
  accountReadErrorSchema,
  accountSummarySchema,
  balanceSchema,
  currencySchema,
  exactDecimalAmountSchema,
  isoDateSchema,
  nonNegativeDecimalAmountSchema,
  transactionSchema,
  transactionStatusSchema,
  type Transaction,
  type TransactionStatus,
} from "../finance";
import { EnableBankingClient } from "../providers/enable-banking/client";
import type { EnableBankingPsuHeaders } from "../providers/enable-banking/psu-headers";
import type { SessionStore } from "../session-store";

const MAX_DATE_RANGE_DAYS = 366;
const MAX_TRANSACTIONS_PER_RESULT = 200;
const MAX_SEARCH_PAGES = 5;
const MAX_SUMMARY_PAGES = 20;
const MAX_SUMMARY_TRANSACTIONS = 10_000;
const SPENDING_STATUSES = new Set<TransactionStatus>(["booked", "held", "other", "pending"]);

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const dateRangeSchema = z
  .object({
    dateFrom: isoDateSchema.describe("Inclusive start date in YYYY-MM-DD format"),
    dateTo: isoDateSchema.describe("Inclusive end date in YYYY-MM-DD format"),
  })
  .superRefine(({ dateFrom, dateTo }, context) => {
    const days = differenceInDays(dateFrom, dateTo);
    const today = new Date().toISOString().slice(0, 10);
    if (dateFrom > today) {
      context.addIssue({
        code: "custom",
        path: ["dateFrom"],
        message: "dateFrom must not be in the future",
      });
    }
    if (days < 0) context.addIssue({ code: "custom", message: "dateTo must not precede dateFrom" });
    if (days > MAX_DATE_RANGE_DAYS) {
      context.addIssue({ code: "custom", message: `Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days` });
    }
  });

const transactionFiltersSchema = dateRangeSchema.extend({
  status: transactionStatusSchema
    .optional()
    .describe("Optional normalized transaction status filter"),
});

interface PageCursor {
  v: 1;
  accountId: string;
  dateFrom: string;
  dateTo: string;
  status?: TransactionStatus;
  providerCursor?: string;
  offset: number;
}

interface CursorFilters {
  accountId: string;
  dateFrom: string;
  dateTo: string;
  status: TransactionStatus | undefined;
}

const pageCursorSchema = z.object({
  v: z.literal(1),
  accountId: accountIdSchema,
  dateFrom: isoDateSchema,
  dateTo: isoDateSchema,
  status: transactionStatusSchema.optional(),
  providerCursor: z.string().min(1).max(4_096).optional(),
  offset: z.number().int().min(0).max(5_000),
});

export function createFinanceServer(
  config: AppConfig,
  sessions: SessionStore,
  psuHeaders?: EnableBankingPsuHeaders,
): McpServer {
  const provider = new EnableBankingClient(config, sessions, psuHeaders);
  const server = new McpServer({ name: "personal-finance-eu-mcp", version: "0.1.0" });

  server.registerTool(
    "finance_list_accounts",
    {
      title: "List financial accounts",
      description:
        "Discover accounts from active Enable Banking sessions and return opaque account IDs with bank-provided metadata. Never returns IBANs.",
      inputSchema: z.object({}),
      outputSchema: z.object({ accounts: z.array(accountSummarySchema) }),
      annotations,
    },
    async () => safeResult(async () => ({ accounts: await provider.listAccounts() })),
  );

  server.registerTool(
    "finance_get_balances",
    {
      title: "Get account balances",
      description:
        "Get current balance measurements for one discovered account ID, or all active accounts in one call. All-account reads may return partial results in errors; do not immediately retry rate-limited accounts. Multiple balances for one account are alternative measurements, not components: never add them together, and state the balance type when answering.",
      inputSchema: z.object({ accountId: accountIdSchema.optional() }),
      outputSchema: z.object({
        balances: z.array(balanceSchema),
        errors: z.array(accountReadErrorSchema),
      }),
      annotations,
    },
    async ({ accountId }) =>
      safeResult(async () => {
        const result = await provider.getBalances(accountId);
        return { balances: result.balances, errors: result.errors };
      }),
  );

  server.registerTool(
    "finance_get_spending",
    {
      title: "Get spending",
      description:
        "Return debit spending for a date range across all accounts by default. Uses the bank-reported transaction date when available and includes pending transactions.",
      inputSchema: dateRangeSchema.extend({ accountId: accountIdSchema.optional() }),
      outputSchema: z.object({
        totalsByCurrency: z.record(
          currencySchema,
          nonNegativeDecimalAmountSchema.describe(
            "Exact total of matching debit activity in this currency",
          ),
        ),
        transactions: z
          .array(transactionSchema)
          .describe("Matching debit transactions, capped at 200 records"),
        transactionsIncluded: z
          .number()
          .int()
          .describe("Number of matching transactions included in the totals"),
        transactionDetailsComplete: z
          .boolean()
          .describe("True when every transaction included in the totals is returned in transactions"),
        dateCoverageComplete: z
          .boolean()
          .describe("True when every potentially relevant debit returned by the bank had a transactionDate"),
        complete: z
          .boolean()
          .describe("True only when all selected accounts and provider pages were scanned"),
        pagesScanned: z.number().int().describe("Total provider pages scanned"),
      }),
      annotations,
    },
    async ({ accountId, dateFrom, dateTo }) =>
      safeResult(async () => {
        const accountIds = accountId === undefined ? await provider.listAccountIds() : [accountId];
        const totals = new Map<string, Decimal>();
        const transactions: Transaction[] = [];
        let transactionsIncluded = 0;
        let dateCoverageComplete = true;

        const scan = await scanSummaryTransactions(
          provider,
          accountIds,
          { dateFrom, dateTo },
          (transaction) => {
            if (
              transaction.direction !== "debit" ||
              !SPENDING_STATUSES.has(transaction.status)
            ) {
              return;
            }
            if (transaction.transactionDate === undefined) {
              dateCoverageComplete = false;
            }
            const matchesRequestedDate =
              transaction.transactionDate === undefined
                ? transaction.status === "pending" || transaction.status === "held"
                : transaction.transactionDate >= dateFrom &&
                  transaction.transactionDate <= dateTo;
            if (!matchesRequestedDate) return;

            totals.set(
              transaction.currency,
              (totals.get(transaction.currency) ?? new Decimal(0)).plus(transaction.amount),
            );
            transactionsIncluded += 1;
            if (transactions.length < MAX_TRANSACTIONS_PER_RESULT) {
              transactions.push(transaction);
            }
          },
        );

        return {
          totalsByCurrency: Object.fromEntries(
            [...totals.entries()].map(([currency, total]) => [currency, total.toFixed()]),
          ),
          transactions,
          transactionsIncluded,
          transactionDetailsComplete: transactions.length === transactionsIncluded,
          dateCoverageComplete,
          complete: scan.complete,
          pagesScanned: scan.pagesScanned,
        };
      }),
  );

  server.registerTool(
    "finance_list_transactions",
    {
      title: "List transactions",
      description:
        "Return a paginated page of bank-reported transaction records for one account, optionally filtered by lifecycle status.",
      inputSchema: transactionFiltersSchema.extend({
        accountId: accountIdSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_TRANSACTIONS_PER_RESULT)
          .default(100)
          .describe("Maximum number of transactions to return in this page"),
        cursor: z
          .string()
          .min(1)
          .max(8_192)
          .optional()
          .describe("Opaque nextCursor from the preceding call with the same filters"),
      }),
      outputSchema: z.object({
        transactions: z.array(transactionSchema),
        nextCursor: z
          .string()
          .optional()
          .describe("Opaque cursor to continue the same query; absent when no further page is available"),
      }),
      annotations,
    },
    async ({ accountId, dateFrom, dateTo, status, limit, cursor }) =>
      safeResult(async () => {
        const decoded = cursor === undefined ? undefined : decodeCursor(cursor);
        validateCursor(decoded, { accountId, dateFrom, dateTo, status });
        const providerCursor = decoded?.providerCursor;
        const offset = decoded?.offset ?? 0;
        const page = await provider.listTransactions(accountId, {
          dateFrom,
          dateTo,
          ...(status === undefined ? {} : { status }),
          ...(providerCursor === undefined ? {} : { continuationKey: providerCursor }),
        });
        const transactions = page.transactions.slice(offset, offset + limit);
        const nextOffset = offset + transactions.length;

        let nextCursor: string | undefined;
        if (nextOffset < page.transactions.length) {
          nextCursor = encodeCursor({
            v: 1,
            accountId,
            dateFrom,
            dateTo,
            ...(status === undefined ? {} : { status }),
            ...(providerCursor === undefined ? {} : { providerCursor }),
            offset: nextOffset,
          });
        } else if (page.continuationKey !== undefined) {
          nextCursor = encodeCursor({
            v: 1,
            accountId,
            dateFrom,
            dateTo,
            ...(status === undefined ? {} : { status }),
            providerCursor: page.continuationKey,
            offset: 0,
          });
        }

        return nextCursor === undefined ? { transactions } : { transactions, nextCursor };
      }),
  );

  server.registerTool(
    "finance_search_transactions",
    {
      title: "Search transactions",
      description:
        "Search normalized transaction descriptions and counterparties over a bounded date range and provider pages.",
      inputSchema: transactionFiltersSchema.extend({
        accountId: accountIdSchema,
        query: z
          .string()
          .trim()
          .min(2)
          .max(100)
          .describe("Case-insensitive text to match against description, counterparty, or reference"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(50)
          .describe("Maximum number of matching transactions to return"),
      }),
      outputSchema: z.object({
        transactions: z.array(transactionSchema),
        complete: z
          .boolean()
          .describe("True only when every provider page in the requested range was searched"),
        pagesScanned: z.number().int().describe("Number of provider pages searched"),
      }),
      annotations,
    },
    async ({ accountId, query, dateFrom, dateTo, status, limit }) =>
      safeResult(async () => {
        const needle = query.toLocaleLowerCase();
        const matches: Transaction[] = [];
        let continuationKey: string | undefined;
        let pagesScanned = 0;
        let stoppedAtLimit = false;

        do {
          const page = await provider.listTransactions(accountId, {
            dateFrom,
            dateTo,
            ...(status === undefined ? {} : { status }),
            ...(continuationKey === undefined ? {} : { continuationKey }),
          });
          pagesScanned += 1;
          for (const transaction of page.transactions) {
            const haystack = [transaction.counterparty, transaction.description, transaction.reference]
              .filter((part): part is string => part !== undefined)
              .join(" ")
              .toLocaleLowerCase();
            if (haystack.includes(needle)) matches.push(transaction);
            if (matches.length >= limit) {
              stoppedAtLimit = true;
              break;
            }
          }
          continuationKey = page.continuationKey;
        } while (
          matches.length < limit &&
          continuationKey !== undefined &&
          pagesScanned < MAX_SEARCH_PAGES
        );

        return {
          transactions: matches,
          complete: continuationKey === undefined && !stoppedAtLimit,
          pagesScanned,
        };
      }),
  );

  server.registerTool(
    "finance_summarize_cash_flow",
    {
      title: "Summarize cash flow",
      description:
        "Return booked credit, debit, and net accounting totals by currency for a date range.",
      inputSchema: dateRangeSchema.extend({ accountId: accountIdSchema.optional() }),
      outputSchema: z.object({
        totalsByCurrency: z.record(
          currencySchema,
          z.object({
            credit: nonNegativeDecimalAmountSchema.describe("Sum of booked credits in this currency"),
            debit: nonNegativeDecimalAmountSchema.describe("Sum of booked debits in this currency"),
            net: exactDecimalAmountSchema.describe("Exact credit minus debit total; may be negative"),
          }),
        ),
        transactionsIncluded: z.number().int().describe("Number of booked transactions included"),
        complete: z
          .boolean()
          .describe("True only when all active accounts and provider pages were included"),
        pagesScanned: z.number().int().describe("Total provider pages included in the summary"),
      }),
      annotations,
    },
    async ({ accountId, dateFrom, dateTo }) =>
      safeResult(async () => {
        const accountIds = accountId === undefined ? await provider.listAccountIds() : [accountId];
        const totals = new Map<string, { credit: Decimal; debit: Decimal }>();
        let transactionsIncluded = 0;
        const scan = await scanSummaryTransactions(
          provider,
          accountIds,
          { dateFrom, dateTo, status: "booked" },
          (transaction) => {
            const current = totals.get(transaction.currency) ?? {
              credit: new Decimal(0),
              debit: new Decimal(0),
            };
            current[transaction.direction] = current[transaction.direction].plus(transaction.amount);
            totals.set(transaction.currency, current);
            transactionsIncluded += 1;
          },
        );

        const totalsByCurrency = Object.fromEntries(
          [...totals.entries()].map(([currency, value]) => [
            currency,
            {
              credit: value.credit.toFixed(),
              debit: value.debit.toFixed(),
              net: value.credit.minus(value.debit).toFixed(),
            },
          ]),
        );
        return {
          totalsByCurrency,
          transactionsIncluded,
          complete: scan.complete,
          pagesScanned: scan.pagesScanned,
        };
      }),
  );

  return server;
}

async function scanSummaryTransactions(
  provider: EnableBankingClient,
  accountIds: string[],
  filters: { dateFrom: string; dateTo: string; status?: TransactionStatus },
  visit: (transaction: Transaction) => void,
): Promise<{ complete: boolean; pagesScanned: number }> {
  let transactionsScanned = 0;
  let pagesScanned = 0;
  let complete = true;

  outer: for (const accountId of accountIds) {
    if (pagesScanned >= MAX_SUMMARY_PAGES) {
      complete = false;
      break;
    }
    let continuationKey: string | undefined;
    do {
      const page = await provider.listTransactions(accountId, {
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        ...(filters.status === undefined ? {} : { status: filters.status }),
        ...(continuationKey === undefined ? {} : { continuationKey }),
      });
      pagesScanned += 1;
      for (const transaction of page.transactions) {
        transactionsScanned += 1;
        visit(transaction);
        if (transactionsScanned >= MAX_SUMMARY_TRANSACTIONS) {
          complete = false;
          break outer;
        }
      }
      continuationKey = page.continuationKey;
      if (pagesScanned >= MAX_SUMMARY_PAGES && continuationKey !== undefined) {
        complete = false;
        break outer;
      }
    } while (continuationKey !== undefined);
  }

  return { complete, pagesScanned };
}

async function safeResult<T extends Record<string, unknown>>(
  operation: () => Promise<T>,
): Promise<
  | { content: [{ type: "text"; text: string }]; structuredContent: T }
  | { content: [{ type: "text"; text: string }]; isError: true }
> {
  try {
    const output = await operation();
    return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
  } catch (error) {
    return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
  }
}

function encodeCursor(cursor: PageCursor): string {
  return base64UrlEncode(JSON.stringify(cursor));
}

function decodeCursor(cursor: string): PageCursor {
  try {
    const parsed = pageCursorSchema.parse(JSON.parse(base64UrlDecode(cursor)));
    return {
      v: parsed.v,
      accountId: parsed.accountId,
      dateFrom: parsed.dateFrom,
      dateTo: parsed.dateTo,
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(parsed.providerCursor === undefined ? {} : { providerCursor: parsed.providerCursor }),
      offset: parsed.offset,
    };
  } catch {
    throw new Error("Invalid transaction cursor");
  }
}

function validateCursor(
  cursor: PageCursor | undefined,
  filters: CursorFilters,
): void {
  if (cursor === undefined) return;
  if (
    cursor.accountId !== filters.accountId ||
    cursor.dateFrom !== filters.dateFrom ||
    cursor.dateTo !== filters.dateTo ||
    cursor.status !== filters.status
  ) {
    throw new Error("The transaction cursor does not match the current filters");
  }
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function differenceInDays(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000;
}
