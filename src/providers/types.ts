import type {
  AccountReadError,
  AccountSummary,
  Balance,
  ConnectionStatus,
  ProviderKey,
  TransactionPage,
  TransactionStatus,
} from "../finance";
import type { TokenCipher } from "../lib/crypto";
import type { PsuContext } from "../lib/psu";

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
  /** Every stored connection with its state, including ones that no longer give access. */
  connectionStatuses(): Promise<Array<Omit<ConnectionStatus, "provider">>>;
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
  /** Stable key, also reported in providerErrors. */
  readonly name: ProviderKey;
  /** Human-readable coverage, for example "UK banks (TrueLayer)". */
  readonly label: string;
  /** True when an account ID was issued by this provider. IDs of different providers never overlap. */
  ownsAccountId(accountId: string): boolean;
  reader(psu: PsuContext): FinanceReader;
  readonly setup: ProviderSetup;
}

/** Deployment-wide settings a provider may use. */
export interface SharedSettings {
  /** KV namespace shared by all providers; each provider uses its own key prefix. */
  kv: KVNamespace;
  /** Present when TOKEN_ENCRYPTION_KEY is set: seals credentials before they reach KV. */
  tokenCipher?: TokenCipher;
}

/**
 * How a provider is discovered from Worker secrets. Adding a provider means writing
 * one of these in its own folder and listing it in providers/registry.ts.
 */
export interface ProviderModule {
  readonly key: ProviderKey;
  readonly label: string;
  /** Secret names that enable this provider; all must be set together. */
  readonly secrets: readonly string[];
  /** Undefined when none of `secrets` is set; throws on a partial or invalid configuration. */
  fromEnv(env: Readonly<Record<string, unknown>>, shared: SharedSettings): BankProvider | undefined;
}
