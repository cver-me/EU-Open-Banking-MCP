import { importPKCS8, SignJWT } from "jose";
import type { AppConfig } from "../../config";
import { errorMessage, PublicError } from "../../errors";
import type {
  AccountReadError,
  AccountSummary,
  AccountUsage,
  Balance,
  BalanceType,
  CashAccountType,
  Transaction,
  TransactionPage,
  TransactionStatus,
} from "../../finance";
import { readBoundedJson } from "../../http";
import type { SessionStore } from "../../session-store";
import {
  accountDetailsSchema,
  aspspsSchema,
  authorizeSessionResponseSchema,
  balancesSchema,
  MAX_ENABLE_BANKING_ACCOUNTS,
  errorResponseSchema,
  sessionSchema,
  startAuthorizationResponseSchema,
  transactionsSchema,
  type EnableBankingAccountUsage,
  type EnableBankingBalanceType,
  type EnableBankingCashAccountType,
  type EnableBankingTransaction,
  type EnableBankingTransactionStatus,
} from "./schemas";
import type { EnableBankingPsuHeaders } from "./psu-headers";

const API_ORIGIN = "https://api.enablebanking.com";
const REQUEST_TIMEOUT_MS = 10_000;

interface TransactionQuery {
  dateFrom?: string;
  dateTo?: string;
  status?: TransactionStatus;
  continuationKey?: string;
}

interface AuthorizedAccount {
  accountId: string;
  institution: string;
  country: string;
}

export interface BalanceReadResult {
  balances: Balance[];
  errors: AccountReadError[];
}

export interface ConnectionSummary {
  sessionId: string;
  institution?: string;
  country?: string;
  psuType?: "business" | "personal";
  status: string;
  accountCount?: number;
}

export interface StartAuthorizationInput {
  institution: string;
  country: string;
  psuType: "business" | "personal";
}

export type InstitutionFilter = Pick<StartAuthorizationInput, "country" | "psuType">;

const ACCOUNT_USAGES = {
  ORGA: "professional",
  PRIV: "personal",
} as const satisfies Record<EnableBankingAccountUsage, AccountUsage>;

const CASH_ACCOUNT_TYPES = {
  CACC: "current",
  CARD: "card",
  CASH: "cash",
  LOAN: "loan",
  OTHR: "other",
  SVGS: "savings",
} as const satisfies Record<EnableBankingCashAccountType, CashAccountType>;

const BALANCE_TYPES = {
  CLAV: "closing_available",
  CLBD: "closing_booked",
  FWAV: "forward_available",
  INFO: "informational",
  ITAV: "interim_available",
  ITBD: "interim_booked",
  OPAV: "opening_available",
  OPBD: "opening_booked",
  OTHR: "other",
  PRCD: "previously_closed_booked",
  VALU: "value_date",
  XPCD: "instant",
} as const satisfies Record<EnableBankingBalanceType, BalanceType>;

const TRANSACTION_STATUSES = {
  BOOK: "booked",
  CNCL: "cancelled",
  HOLD: "held",
  OTHR: "other",
  PDNG: "pending",
  RJCT: "rejected",
  SCHD: "scheduled",
} as const satisfies Record<EnableBankingTransactionStatus, TransactionStatus>;

const TRANSACTION_STATUS_CODES = Object.fromEntries(
  Object.entries(TRANSACTION_STATUSES).map(([providerStatus, status]) => [status, providerStatus]),
) as Record<TransactionStatus, EnableBankingTransactionStatus>;

export class EnableBankingClient {
  private keyPromise: Promise<CryptoKey> | undefined;
  private accountsPromise: Promise<AuthorizedAccount[]> | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionStore,
    private readonly psuHeaders?: EnableBankingPsuHeaders,
  ) {}

  async listAccounts(): Promise<AccountSummary[]> {
    const accounts = await this.authorizedAccounts();
    const groupedResults = await Promise.all(
      groupAccountsByInstitution(accounts).map(async (group) => {
        const summaries: AccountSummary[] = [];
        for (const { accountId, institution, country } of group) {
          const details = accountDetailsSchema.parse(
            await this.request(
              `/accounts/${encodeURIComponent(accountId)}/details`,
              {},
              true,
            ),
          );
          summaries.push({
            accountId,
            institution,
            country,
            currency: details.currency,
            cashAccountType: CASH_ACCOUNT_TYPES[details.cash_account_type],
            ...(details.name == null ? {} : { name: details.name }),
            ...(details.product == null ? {} : { product: details.product }),
            ...(details.usage == null ? {} : { usage: ACCOUNT_USAGES[details.usage] }),
          });
        }
        return summaries;
      }),
    );
    return groupedResults.flat();
  }

  async getBalances(accountId?: string): Promise<BalanceReadResult> {
    const accounts = await this.selectAccounts(accountId);
    if (accountId !== undefined) {
      const account = accounts[0];
      if (account === undefined) throw unknownAccount();
      return { balances: await this.getAccountBalances(account), errors: [] };
    }

    const groupedResults = await Promise.all(
      groupAccountsByInstitution(accounts).map(async (group) => {
        const balances: Balance[] = [];
        const errors: AccountReadError[] = [];
        for (const [index, account] of group.entries()) {
          try {
            balances.push(...(await this.getAccountBalances(account)));
          } catch (error) {
            errors.push(accountReadError(account, error));
            if (
              error instanceof PublicError &&
              (error.code === "aspsp_rate_limited" || error.code === "provider_rate_limited")
            ) {
              for (const skippedAccount of group.slice(index + 1)) {
                errors.push(accountReadError(skippedAccount, error));
              }
              break;
            }
          }
        }
        return { balances, errors };
      }),
    );

    return {
      balances: groupedResults.flatMap((result) => result.balances),
      errors: groupedResults.flatMap((result) => result.errors),
    };
  }

  private async getAccountBalances(account: AuthorizedAccount): Promise<Balance[]> {
    const response = balancesSchema.parse(
      await this.request(
        `/accounts/${encodeURIComponent(account.accountId)}/balances`,
        {},
        true,
      ),
    );
    return response.balances.map((balance) => ({
      accountId: account.accountId,
      institution: account.institution,
      country: account.country,
      currency: balance.balance_amount.currency,
      amount: balance.balance_amount.amount,
      balanceType: BALANCE_TYPES[balance.balance_type],
      ...(balance.reference_date === undefined ? {} : { referenceDate: balance.reference_date }),
    }));
  }

  async listTransactions(accountId: string, query: TransactionQuery): Promise<TransactionPage> {
    const [account] = await this.selectAccounts(accountId);
    if (account === undefined) throw unknownAccount();
    const params = new URLSearchParams();
    if (query.dateFrom !== undefined) params.set("date_from", query.dateFrom);
    if (query.dateTo !== undefined) params.set("date_to", query.dateTo);
    if (query.status !== undefined) {
      params.set("transaction_status", TRANSACTION_STATUS_CODES[query.status]);
    }
    if (query.continuationKey !== undefined) params.set("continuation_key", query.continuationKey);

    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const response = parseTransactionsResponse(
      await this.request(
        `/accounts/${encodeURIComponent(accountId)}/transactions${suffix}`,
        {},
        true,
      ),
    );

    const page: TransactionPage = {
      transactions: response.transactions.map((transaction) =>
        normalizeTransaction(accountId, transaction),
      ),
    };
    if (response.continuation_key) page.continuationKey = response.continuation_key;
    return page;
  }

  async listAccountIds(): Promise<string[]> {
    return (await this.authorizedAccounts()).map(({ accountId }) => accountId);
  }

  async listConnections(): Promise<ConnectionSummary[]> {
    return Promise.all(
      (await this.sessions.list()).map(async (sessionId) => {
        try {
          const session = sessionSchema.parse(
            await this.request(`/sessions/${encodeURIComponent(sessionId)}`),
          );
          return {
            sessionId,
            institution: session.aspsp.name,
            country: session.aspsp.country,
            psuType: session.psu_type,
            status: session.status,
            accountCount: session.accounts.length,
          };
        } catch {
          return { sessionId, status: "UNAVAILABLE" };
        }
      }),
    );
  }

  async listInstitutions(filter: InstitutionFilter): Promise<string[]> {
    return (await this.availableInstitutions(filter))
      .map(({ name }) => name)
      .sort((left, right) => left.localeCompare(right));
  }

  async startAuthorization(
    input: StartAuthorizationInput,
    redirectUrl: string,
    state: string,
  ): Promise<string> {
    const aspsps = await this.availableInstitutions(input);
    const institution = aspsps.find(
      ({ name }) => name.toLocaleLowerCase() === input.institution.toLocaleLowerCase(),
    );
    if (institution === undefined) {
      throw new PublicError(
        "Bank not found. Use the exact name shown by Enable Banking for this country and account type.",
        "institution_not_found",
      );
    }

    const safetyMarginSeconds = Math.min(60, institution.maximum_consent_validity - 1);
    const validUntil = new Date(
      Date.now() + (institution.maximum_consent_validity - safetyMarginSeconds) * 1_000,
    ).toISOString();
    const response = startAuthorizationResponseSchema.parse(
      await this.request("/auth", {
        method: "POST",
        body: JSON.stringify({
          access: { balances: true, transactions: true, valid_until: validUntil },
          aspsp: { name: institution.name, country: institution.country },
          state,
          redirect_url: redirectUrl,
          psu_type: input.psuType,
        }),
      }),
    );
    const authorizationUrl = new URL(response.url);
    if (authorizationUrl.protocol !== "https:") {
      throw new PublicError("Enable Banking returned an invalid authorization URL.", "invalid_redirect");
    }
    return authorizationUrl.toString();
  }

  private async availableInstitutions(filter: InstitutionFilter) {
    const params = new URLSearchParams({
      country: filter.country,
      psu_type: filter.psuType,
      service: "AIS",
    });
    return aspspsSchema.parse(await this.request(`/aspsps?${params.toString()}`)).aspsps;
  }

  async completeAuthorization(code: string): Promise<string> {
    const response = authorizeSessionResponseSchema.parse(
      await this.request("/sessions", {
        method: "POST",
        body: JSON.stringify({ code }),
      }),
    );
    await this.sessions.add(response.session_id);
    return response.session_id;
  }

  async removeConnection(sessionId: string): Promise<void> {
    const configured = await this.sessions.list();
    if (!configured.includes(sessionId)) {
      throw new PublicError("Unknown Enable Banking session.", "unknown_session");
    }
    try {
      await this.request(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    } catch (error) {
      if (
        !(error instanceof PublicError) ||
        (error.code !== "provider_reauthorization_required" && error.code !== "provider_not_found")
      ) {
        throw error;
      }
    }
    await this.sessions.remove(sessionId);
  }

  private async selectAccounts(accountId?: string): Promise<AuthorizedAccount[]> {
    const accounts = await this.authorizedAccounts();
    if (accountId === undefined) return accounts;
    const account = accounts.find((candidate) => candidate.accountId === accountId);
    if (account === undefined) throw unknownAccount();
    return [account];
  }

  private async authorizedAccounts(): Promise<AuthorizedAccount[]> {
    this.accountsPromise ??= this.loadAuthorizedAccounts();
    return this.accountsPromise;
  }

  private async loadAuthorizedAccounts(): Promise<AuthorizedAccount[]> {
    const sessionIds = await this.sessions.list();
    if (sessionIds.length === 0) throw setupRequired();

    const sessions = await Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          return sessionSchema.parse(
            await this.request(`/sessions/${encodeURIComponent(sessionId)}`),
          );
        } catch (error) {
          if (
            error instanceof PublicError &&
            (error.code === "provider_reauthorization_required" || error.code === "provider_not_found")
          ) {
            return undefined;
          }
          throw error;
        }
      }),
    );

    const accounts = new Map<string, AuthorizedAccount>();
    for (const session of sessions) {
      if (session === undefined || session.status !== "AUTHORIZED") continue;
      for (const accountId of session.accounts) {
        accounts.set(accountId, {
          accountId,
          institution: session.aspsp.name,
          country: session.aspsp.country,
        });
        if (accounts.size > MAX_ENABLE_BANKING_ACCOUNTS) {
          throw new PublicError(
            "Enable Banking returned too many accounts for this personal deployment.",
            "provider_account_limit_exceeded",
          );
        }
      }
    }
    if (accounts.size === 0) throw setupRequired();
    return [...accounts.values()];
  }

  private async authorizationToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    this.keyPromise ??= importPKCS8(this.config.enableBanking.privateKeyPem, "RS256");
    return new SignJWT({})
      .setProtectedHeader({
        alg: "RS256",
        typ: "JWT",
        kid: this.config.enableBanking.applicationId,
      })
      .setIssuer("enablebanking.com")
      .setAudience("api.enablebanking.com")
      .setIssuedAt(now)
      .setExpirationTime(now + 3_600)
      .sign(await this.keyPromise);
  }

  private async request(
    path: string,
    init: { method?: "DELETE" | "GET" | "POST"; body?: string } = {},
    includePsuHeaders = false,
  ): Promise<unknown> {
    let response: Response;
    try {
      const headers = new Headers({
        Accept: "application/json",
        Authorization: `Bearer ${await this.authorizationToken()}`,
      });
      if (init.body !== undefined) headers.set("Content-Type", "application/json");
      if (includePsuHeaders) applyPsuHeaders(headers, this.psuHeaders);
      response = await fetch(`${API_ORIGIN}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw providerTimeout();
      }
      throw error;
    }

    if (!response.ok) {
      throw await providerError(response, providerOperation(path));
    }

    return readBoundedJson(response);
  }
}

function parseTransactionsResponse(value: unknown) {
  const parsed = transactionsSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  console.error(
    JSON.stringify({
      message: "Enable Banking response validation failed",
      operation: "get_account_transactions",
      issueCount: parsed.error.issues.length,
      issues: parsed.error.issues.slice(0, 10).map((issue) => ({
        code: issue.code,
        path: issue.path.map(String).join("."),
      })),
    }),
  );

  throw new PublicError(
    "Enable Banking returned unsupported transaction data.",
    "provider_response_invalid",
  );
}

async function providerError(response: Response, operation: string): Promise<PublicError> {
  let errorCode: string | undefined;
  try {
    const parsed = errorResponseSchema.safeParse(await readBoundedJson(response));
    if (parsed.success) errorCode = parsed.data.error;
  } catch {
    // Status-based handling below remains safe when an error body is absent or malformed.
  }

  const retryAfter = response.headers.get("Retry-After");
  console.warn(
    JSON.stringify({
      message: "Enable Banking request failed",
      operation,
      status: response.status,
      errorCode: errorCode ?? "unknown",
      ...(retryAfter === null || retryAfter.length > 100 ? {} : { retryAfter }),
    }),
  );

  if (errorCode === "EXPIRED_SESSION" || errorCode === "REVOKED_SESSION" || errorCode === "CLOSED_SESSION") {
    return new PublicError(
      "Enable Banking authorization has expired or is no longer active. Reauthorize this account.",
      "provider_reauthorization_required",
    );
  }
  if (errorCode === "WRONG_CONTINUATION_KEY") {
    return new PublicError(
      "The Enable Banking pagination cursor is no longer valid. Start the query again.",
      "provider_cursor_invalid",
    );
  }
  if (errorCode === "ASPSP_TIMEOUT" || response.status === 408) return providerTimeout();
  if (errorCode === "ASPSP_RATE_LIMIT_EXCEEDED") {
    return new PublicError(
      "The bank rate-limited account data access. Do not retry immediately.",
      "aspsp_rate_limited",
    );
  }
  if (response.status === 429) {
    return new PublicError(
      "Enable Banking rate-limited this request. Try again shortly.",
      "provider_rate_limited",
    );
  }
  if (response.status === 401) {
    return new PublicError(
      "Enable Banking rejected the configured credentials.",
      "provider_auth_failed",
    );
  }
  if (response.status === 403) {
    return new PublicError(
      "Enable Banking denied access to this account or service.",
      "provider_access_denied",
    );
  }
  if (response.status === 404) {
    return new PublicError(
      "The configured account or session is unavailable.",
      "provider_not_found",
    );
  }
  return new PublicError("Enable Banking could not complete this request.", "provider_error");
}

function applyPsuHeaders(headers: Headers, psuHeaders?: EnableBankingPsuHeaders): void {
  for (const [name, value] of psuHeaders ?? []) headers.set(name, value);
}

function providerOperation(path: string): string {
  if (/^\/accounts\/[^/]+\/details$/.test(path)) return "get_account_details";
  if (/^\/accounts\/[^/]+\/balances$/.test(path)) return "get_account_balances";
  if (/^\/accounts\/[^/]+\/transactions(?:\?|$)/.test(path)) return "get_account_transactions";
  if (/^\/sessions\/[^/]+$/.test(path)) return "session";
  if (path === "/sessions") return "complete_authorization";
  if (path === "/auth") return "start_authorization";
  if (path.startsWith("/aspsps?")) return "list_aspsps";
  return "unknown";
}

function groupAccountsByInstitution(accounts: AuthorizedAccount[]): AuthorizedAccount[][] {
  const groups = new Map<string, AuthorizedAccount[]>();
  for (const account of accounts) {
    const key = `${account.country}\u0000${account.institution}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [account]);
    else group.push(account);
  }
  return [...groups.values()];
}

function accountReadError(account: AuthorizedAccount, error: unknown): AccountReadError {
  return {
    accountId: account.accountId,
    institution: account.institution,
    country: account.country,
    code: error instanceof PublicError ? error.code : "provider_error",
    message: errorMessage(error),
  };
}

function providerTimeout(): PublicError {
  return new PublicError("Enable Banking timed out. Try again shortly.", "provider_timeout");
}

function setupRequired(): PublicError {
  return new PublicError(
    "No active bank authorization is available. Open /setup to connect or renew a bank.",
    "setup_required",
  );
}

function unknownAccount(): PublicError {
  return new PublicError(
    "Unknown or inactive account ID. Call finance_list_accounts again.",
    "unknown_account",
  );
}

function normalizeTransaction(accountId: string, transaction: EnableBankingTransaction): Transaction {
  const credit = transaction.credit_debit_indicator === "CRDT";
  const counterparty = credit ? transaction.debtor?.name : transaction.creditor?.name;
  const description = [transaction.remittance_information?.join(" "), transaction.note]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" — ");

  return {
    accountId,
    amount: transaction.transaction_amount.amount.replace(/^-/, ""),
    currency: transaction.transaction_amount.currency,
    direction: credit ? ("credit" as const) : ("debit" as const),
    status: TRANSACTION_STATUSES[transaction.status],
    ...(transaction.transaction_date === undefined
      ? {}
      : { transactionDate: transaction.transaction_date }),
    ...(transaction.booking_date === undefined ? {} : { bookingDate: transaction.booking_date }),
    ...(transaction.value_date === undefined ? {} : { valueDate: transaction.value_date }),
    ...(counterparty === undefined ? {} : { counterparty }),
    ...(description.length === 0 ? {} : { description }),
    ...(transaction.merchant_category_code === undefined
      ? {}
      : { merchantCategoryCode: transaction.merchant_category_code }),
    ...(transaction.entry_reference === undefined ? {} : { reference: transaction.entry_reference }),
  };
}
