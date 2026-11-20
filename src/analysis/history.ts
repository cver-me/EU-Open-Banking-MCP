import { z } from "zod";
import type { Aggregate } from "../aggregate";
import type { AccountReadError, AccountSummary, ProviderError, Transaction, TransactionStatus } from "../finance";
import { accountReadError, groupBy } from "../providers/shared";

export const MAX_SUMMARY_TRANSACTIONS = 10_000;

export const scanIncompleteReasonSchema = z.enum([
  "page_limit", "transaction_limit", "repeated_cursor", "history_unavailable", "provider_unavailable",
  "account_unavailable",
]);
export type ScanIncompleteReason = z.infer<typeof scanIncompleteReasonSchema>;

export interface ScanResult {
  complete: boolean;
  pagesScanned: number;
  incompleteReasons: ScanIncompleteReason[];
}

/**
 * Pages and records one request may still read. Scans running at the same time share it,
 * so reading banks in parallel never reads more than reading them one after another.
 */
export interface ScanBudget {
  pagesLeft: number;
  transactionsLeft: number;
}

export function scanBudget(maxPages: number): ScanBudget {
  return { pagesLeft: maxPages, transactionsLeft: MAX_SUMMARY_TRANSACTIONS };
}

/**
 * Pages through the transactions of each account in turn, within the budget. Anything the
 * budget or the bank cuts off is reported, never hidden.
 */
export async function scanTransactions(
  provider: Pick<Aggregate, "listTransactions">,
  accountIds: readonly string[],
  filters: { dateFrom: string; dateTo: string; status?: TransactionStatus },
  budget: ScanBudget,
  visit: (transaction: Transaction) => void,
): Promise<ScanResult> {
  let pagesScanned = 0;
  const incompleteReasons = new Set<ScanIncompleteReason>();

  outer: for (const accountId of accountIds) {
    let continuationKey: string | undefined;
    const visitedCursors = new Set<string>();
    do {
      if (continuationKey !== undefined) {
        if (visitedCursors.has(continuationKey)) {
          incompleteReasons.add("repeated_cursor");
          break;
        }
        visitedCursors.add(continuationKey);
      }
      // A page is still to be read: the first of this account, or a continuation.
      if (budget.pagesLeft <= 0) {
        incompleteReasons.add("page_limit");
        break outer;
      }
      if (budget.transactionsLeft <= 0) {
        incompleteReasons.add("transaction_limit");
        break outer;
      }
      budget.pagesLeft -= 1;
      const page = await provider.listTransactions(accountId, {
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        ...(filters.status === undefined ? {} : { status: filters.status }),
        ...(continuationKey === undefined ? {} : { continuationKey }),
      });
      pagesScanned += 1;
      if (page.historyUnavailable === true) incompleteReasons.add("history_unavailable");
      for (const transaction of page.transactions) {
        if (budget.transactionsLeft <= 0) {
          incompleteReasons.add("transaction_limit");
          break outer;
        }
        budget.transactionsLeft -= 1;
        visit(transaction);
      }
      continuationKey = page.continuationKey;
    } while (continuationKey !== undefined);
  }

  return { complete: incompleteReasons.size === 0, pagesScanned, incompleteReasons: [...incompleteReasons] };
}

export interface History extends ScanResult {
  accounts: AccountSummary[];
  transactions: Transaction[];
  providerErrors: ProviderError[];
  /** Accounts that could not be read (rate limits, bank errors); the others still count. */
  accountErrors: AccountReadError[];
  /** When the oldest bank data in this result was read (ISO 8601); absent when nothing was read. */
  dataAsOf?: string;
}

/** One account's transactions in a range, and how they were read. */
export interface AccountRead {
  transactions: Transaction[];
  /** Bank pages read for this call; zero when the data came from the cache. */
  pagesScanned: number;
  incompleteReasons: ScanIncompleteReason[];
  /** When the data was read from the bank (epoch milliseconds). */
  readAt: number;
}

export type AccountReader = (
  accountId: string,
  range: { dateFrom: string; dateTo: string },
  budget: ScanBudget,
) => Promise<AccountRead>;

/** Reads straight from the bank, page by page. */
export function scanAccount(provider: Pick<Aggregate, "listTransactions">): AccountReader {
  return async (accountId, range, budget) => {
    const transactions: Transaction[] = [];
    const scan = await scanTransactions(provider, [accountId], range, budget, (transaction) => {
      transactions.push(transaction);
    });
    return { transactions, pagesScanned: scan.pagesScanned, incompleteReasons: scan.incompleteReasons, readAt: Date.now() };
  };
}

/**
 * Reads every transaction in a date range, for one account or all. The account list is
 * always read in full: holder names and account types label transfers.
 */
export async function readHistory(
  accountList: { value: AccountSummary[]; providerErrors: ProviderError[] },
  readAccount: AccountReader,
  range: { dateFrom: string; dateTo: string },
  options: { accountId?: string; maxPages: number },
): Promise<History> {
  const { value: accounts, providerErrors } = accountList;
  const accountIds = options.accountId === undefined
    ? accounts.map(({ accountId }) => accountId)
    : [options.accountId];
  const budget = scanBudget(options.maxPages);
  const found = new Map<string, Transaction[]>();
  const accountErrors: AccountReadError[] = [];
  const incompleteReasons = new Set<ScanIncompleteReason>();
  let pagesScanned = 0;
  let oldestRead: number | undefined;

  // Banks are read in parallel; the accounts of one bank in order, as banks rate-limit
  // per login. A failing account (a bank rate limit) costs only its own data. With a
  // single requested account there is nothing else to show, so its failure fails the call.
  const byBank = groupBy(
    accountIds.map((accountId) => accounts.find((account) => account.accountId === accountId) ??
      { accountId, institution: "", country: "" }),
    (account) => `${account.country}\u0000${account.institution}`,
  );
  await Promise.all(byBank.map(async (bankAccounts) => {
    for (const account of bankAccounts) {
      try {
        const read = await readAccount(account.accountId, range, budget);
        pagesScanned += read.pagesScanned;
        for (const reason of read.incompleteReasons) incompleteReasons.add(reason);
        found.set(account.accountId, read.transactions);
        oldestRead = Math.min(oldestRead ?? read.readAt, read.readAt);
      } catch (error) {
        if (options.accountId !== undefined) throw error;
        accountErrors.push(accountReadError(account, error));
        incompleteReasons.add("account_unavailable");
      }
    }
  }));
  // Same order however the banks answered, so results do not depend on timing.
  const transactions = accountIds.flatMap((accountId) => found.get(accountId) ?? []);
  accountErrors.sort((left, right) => accountIds.indexOf(left.accountId) - accountIds.indexOf(right.accountId));
  if (providerErrors.length > 0 && options.accountId === undefined) incompleteReasons.add("provider_unavailable");
  return {
    accounts,
    transactions,
    accountErrors,
    providerErrors: options.accountId === undefined ? providerErrors : [],
    complete: incompleteReasons.size === 0,
    pagesScanned,
    incompleteReasons: [...incompleteReasons],
    ...(oldestRead === undefined ? {} : { dataAsOf: new Date(oldestRead).toISOString() }),
  };
}
