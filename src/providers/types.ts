import type {
  AccountReadError,
  AccountSummary,
  Balance,
  TransactionPage,
  TransactionStatus,
} from "../finance";

export interface TransactionQuery {
  dateFrom?: string;
  dateTo?: string;
  status?: TransactionStatus;
  continuationKey?: string;
}

export interface BalanceReadResult {
  balances: Balance[];
  errors: AccountReadError[];
}

/** Read operations every account-information provider exposes to the MCP tools. */
export interface FinanceProvider {
  listAccounts(): Promise<AccountSummary[]>;
  getBalances(accountId?: string): Promise<BalanceReadResult>;
  listTransactions(accountId: string, query: TransactionQuery): Promise<TransactionPage>;
  listAccountIds(): Promise<string[]>;
}

/** Request-scoped signals that the account owner is actively using the client. */
export interface PsuContext {
  ipAddress?: string;
  userAgent?: string;
}
