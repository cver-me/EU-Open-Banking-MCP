import type {
  AccountReadError,
  AccountSummary,
  Balance,
  ProviderName,
  TransactionPage,
  TransactionStatus,
} from "../finance";
import type { PsuContext } from "../lib/psu";

export type { PsuContext } from "../lib/psu";

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

/**
 * Read operations behind the MCP tools, for the accounts of one provider.
 * Readers are request-scoped: they may share token work within one request only.
 * Every method throws PublicError("setup_required") when the provider has no usable connection.
 */
export interface FinanceReader {
  listAccounts(): Promise<AccountSummary[]>;
  listAccountIds(): Promise<string[]>;
  getBalances(accountId?: string): Promise<BalanceReadResult>;
  listTransactions(accountId: string, query: TransactionQuery): Promise<TransactionPage>;
}

/** One provider's part of the protected /setup flow. */
export interface ProviderSetup {
  /** Handles this provider's own setup and callback routes; undefined for any other path. */
  handle(request: Request, url: URL): Promise<Response | undefined>;
  /** This provider's section of the /setup page (connections, connect form, callback URL). */
  section(request: Request, url: URL): Promise<string>;
}

/**
 * A configured bank-data provider: everything the Worker needs from it.
 * Adapters: Enable Banking (EU) and TrueLayer (UK).
 */
export interface BankProvider {
  readonly name: ProviderName;
  /** True when an account ID was issued by this provider. IDs of different providers never overlap. */
  ownsAccountId(accountId: string): boolean;
  reader(psu: PsuContext): FinanceReader;
  readonly setup: ProviderSetup;
}
