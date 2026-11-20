import type { Aggregate, ProviderResult } from "../aggregate";
import { PublicError } from "../errors";
import type { AccountSummary, ConnectionStatus, Transaction, TransactionPage } from "../finance";
import { readHistory, scanAccount, type AccountReader, type History, type ScanIncompleteReason } from "../analysis/history";
import { todayIsoDate } from "../lib/dates";
import type { BalanceReadResult, TransactionQuery } from "../providers/types";
import type { ClaimResult, Coverage, CoverageRequirement } from "./finance-cache";

/** Everything the MCP tools read from the banks. */
export interface FinanceReads {
  listAccounts(): Promise<ProviderResult<AccountSummary[]>>;
  listAccountIds(): Promise<ProviderResult<string[]>>;
  listConnections(): Promise<ProviderResult<ConnectionStatus[]>>;
  getBalances(accountId?: string): Promise<ProviderResult<BalanceReadResult>>;
  /** One provider page, for cursor paging; never cached. */
  listTransactions(accountId: string, query: TransactionQuery): Promise<TransactionPage>;
  readHistory(range: { dateFrom: string; dateTo: string }, options: { accountId?: string; maxPages: number }): Promise<History>;
}

/** The parts of the FinanceCache Agent the Worker calls. */
export interface CacheStore {
  claim(key: string, requirement?: CoverageRequirement): Promise<ClaimResult>;
  fill(key: string, lease: string, value: unknown, ttlMs: number, coverage?: Coverage): Promise<void>;
  release(key: string, lease: string): Promise<void>;
}

// How long each kind of bank data is reused. Accounts and transactions change when a
// payment posts; balances are what people check for "right now", so they stay short.
export const ACCOUNTS_TTL_MS = 5 * 60_000;
export const TRANSACTIONS_TTL_MS = 5 * 60_000;
export const CONNECTIONS_TTL_MS = 60_000;
export const BALANCES_TTL_MS = 60_000;

/** Reads straight from the banks on every call. */
export function directReads(aggregate: Aggregate): FinanceReads {
  const provider = withTransientRetry(aggregate);
  return {
    listAccounts: () => provider.listAccounts(),
    listAccountIds: () => provider.listAccountIds(),
    listConnections: () => provider.listConnections(),
    getBalances: (accountId) => provider.getBalances(accountId),
    listTransactions: (accountId, query) => provider.listTransactions(accountId, query),
    readHistory: async (range, options) =>
      readHistory(await provider.listAccounts(), filteredReader(scanAccount(provider)), range, options),
  };
}

/**
 * Reads through the shared cache. A miss loads from the bank and fills the cache; a
 * result with any provider or account error is never cached, so the next call retries.
 * If the cache itself is unreachable, reads go straight to the banks.
 */
export function cachedReads(aggregate: Aggregate, cache: CacheStore): FinanceReads {
  const provider = withTransientRetry(aggregate);

  async function cached<T>(
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
    cacheable: (value: T) => boolean,
    requirement?: CoverageRequirement,
    coverage?: Coverage,
  ): Promise<{ value: T; hit: boolean }> {
    let claim: ClaimResult;
    try {
      claim = await cache.claim(key, requirement);
    } catch {
      return { value: await load(), hit: false };
    }
    if (claim.hit) return { value: claim.value as T, hit: true };
    const { lease } = claim;
    let value: T;
    try {
      value = await load();
    } catch (error) {
      await cache.release(key, lease).catch(() => undefined);
      throw error;
    }
    if (cacheable(value)) await cache.fill(key, lease, value, ttlMs, coverage).catch(() => undefined);
    else await cache.release(key, lease).catch(() => undefined);
    return { value, hit: false };
  }

  const noProviderErrors = <T>(result: ProviderResult<T>) => result.providerErrors.length === 0;
  const listAccounts = async () =>
    (await cached("accounts", ACCOUNTS_TTL_MS, () => provider.listAccounts(), noProviderErrors)).value;

  /**
   * One account's transactions, read from the bank up to today and kept per account, so
   * any later range inside what was read (cash flow for a month, then a review since
   * August) is answered from memory.
   */
  const readAccount: AccountReader = async (accountId, range, budget) => {
    const today = todayIsoDate();
    const readTo = range.dateTo > today ? range.dateTo : today;
    const result = await cached<CachedAccount>(
      `transactions:${accountId}`,
      TRANSACTIONS_TTL_MS,
      async () => {
        const read = await scanAccount(provider)(accountId, { dateFrom: range.dateFrom, dateTo: readTo }, budget);
        return { ...read, from: range.dateFrom, to: readTo };
      },
      // Only a full read is reusable; a read cut short by the page budget is not.
      (read) => read.incompleteReasons.every((reason) => reason === "history_unavailable"),
      { from: range.dateFrom, to: range.dateTo },
      { from: range.dateFrom, to: readTo },
    );
    return {
      transactions: result.value.transactions.filter((transaction) => touchesRange(transaction, range)),
      pagesScanned: result.hit ? 0 : result.value.pagesScanned,
      incompleteReasons: result.value.incompleteReasons,
      readAt: result.value.readAt,
    };
  };

  return {
    listAccounts,
    listAccountIds: async () => {
      const accounts = await listAccounts();
      return { value: accounts.value.map(({ accountId }) => accountId), providerErrors: accounts.providerErrors };
    },
    listConnections: async () =>
      (await cached("connections", CONNECTIONS_TTL_MS, () => provider.listConnections(), noProviderErrors)).value,
    getBalances: async (accountId) =>
      (await cached(
        `balances:${accountId ?? "*"}`,
        BALANCES_TTL_MS,
        () => provider.getBalances(accountId),
        (result) => noProviderErrors(result) && result.value.errors.length === 0,
      )).value,
    listTransactions: (accountId, query) => provider.listTransactions(accountId, query),
    readHistory: async (range, options) => readHistory(await listAccounts(), readAccount, range, options),
  };
}

interface CachedAccount {
  transactions: Transaction[];
  pagesScanned: number;
  incompleteReasons: ScanIncompleteReason[];
  readAt: number;
  from: string;
  to: string;
}

/**
 * Banks filter by their own date (booking, value or transaction date). A transaction is
 * in a range when any of its dates is; one with no date at all is always included, so
 * the analysis can report it.
 */
function touchesRange(transaction: Transaction, range: { dateFrom: string; dateTo: string }): boolean {
  const dates = [transaction.transactionDate, transaction.bookingDate, transaction.valueDate]
    .filter((date): date is string => date !== undefined);
  return dates.length === 0 || dates.some((date) => date >= range.dateFrom && date <= range.dateTo);
}

/** The direct reader filters the same way, so cached and fresh results match exactly. */
function filteredReader(reader: AccountReader): AccountReader {
  return async (accountId, range, budget) => {
    const read = await reader(accountId, range, budget);
    return { ...read, transactions: read.transactions.filter((transaction) => touchesRange(transaction, range)) };
  };
}

// Timeouts and 5xx answers are often momentary; rate limits and refusals are not retried.
const TRANSIENT_CODES = new Set(["provider_timeout", "provider_error"]);
const RETRY_DELAY_MS = 300;

/** Retries a bank call once after a short pause when the failure looks momentary. */
export async function retryTransient<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (!(error instanceof PublicError) || !TRANSIENT_CODES.has(error.code)) throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (0.5 + Math.random())));
    return load();
  }
}

function withTransientRetry(aggregate: Aggregate): Pick<Aggregate, "listAccounts" | "listAccountIds" | "listConnections" | "getBalances" | "listTransactions"> {
  return {
    listAccounts: () => retryTransient(() => aggregate.listAccounts()),
    listAccountIds: () => retryTransient(() => aggregate.listAccountIds()),
    listConnections: () => retryTransient(() => aggregate.listConnections()),
    getBalances: (accountId) => retryTransient(() => aggregate.getBalances(accountId)),
    listTransactions: (accountId, query) => retryTransient(() => aggregate.listTransactions(accountId, query)),
  };
}
