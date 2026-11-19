import type { z } from "zod";
import { importPKCS8, SignJWT } from "jose";
import { PublicError } from "../../errors";
import { formatAmount, Money } from "../../lib/money";
import type {
  AccountSummary,
  AccountUsage,
  Balance,
  BalanceType,
  CashAccountType,
  Transaction,
  TransactionPage,
  TransactionStatus,
} from "../../finance";
import type { PsuContext } from "../../lib/psu";
import {
  bankRateLimited,
  groupBy,
  optionalText,
  parseProviderResponse,
  providerFetch,
  providerTimeout,
  readGroupedBalances,
  readProviderErrorCode,
  setupRequired,
  statusFallbackError,
  uniqueBy,
  unknownAccount,
} from "../shared";
import type { BalanceReadResult, FinanceReader, TransactionQuery } from "../types";
import type { EnableBankingConfig } from "./config";
import type { SessionStore } from "./session-store";
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
import { enableBankingPsuHeaders, type EnableBankingPsuHeaders } from "./psu-headers";

const API_ORIGIN = "https://api.enablebanking.com";
const PROVIDER_LABEL = "Enable Banking";

interface AuthorizedAccount {
  accountId: string;
  institution: string;
  country: string;
  identificationHash?: string;
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

export class EnableBankingClient implements FinanceReader {
  private keyPromise: Promise<CryptoKey> | undefined;
  private token: { promise: Promise<string>; refreshAt: number } | undefined;
  private accountsPromise: Promise<AuthorizedAccount[]> | undefined;
  private readonly detailsPromises = new Map<string, Promise<z.output<typeof accountDetailsSchema>>>();

  private readonly psuHeaders: EnableBankingPsuHeaders | undefined;

  constructor(
    private readonly config: EnableBankingConfig,
    private readonly sessions: SessionStore,
    psu?: PsuContext,
  ) {
    this.psuHeaders = enableBankingPsuHeaders(psu);
  }

  async listAccounts(): Promise<AccountSummary[]> {
    const accounts = await this.selectAccounts();
    const groupedResults = await Promise.all(
      groupBy(accounts, (account) => `${account.country}\u0000${account.institution}`).map(async (group) => {
        const summaries: AccountSummary[] = [];
        for (const { accountId, institution, country } of group) {
          const details = await this.accountDetails(accountId);
          const name = optionalText(details.name);
          const product = optionalText(details.product);
          const description = optionalText(details.details);
          summaries.push({
            accountId,
            institution,
            country,
            currency: details.currency,
            cashAccountType: CASH_ACCOUNT_TYPES[details.cash_account_type],
            ...(name === undefined ? {} : { name }),
            ...(product === undefined ? {} : { product }),
            ...(description === undefined ? {} : { description }),
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

    return readGroupedBalances(
      groupBy(accounts, (account) => `${account.country}\u0000${account.institution}`),
      (account) => this.getAccountBalances(account),
    );
  }

  private async getAccountBalances(account: AuthorizedAccount): Promise<Balance[]> {
    const response = parseProviderResponse(
      balancesSchema,
      await this.request(
        `/accounts/${encodeURIComponent(account.accountId)}/balances`,
        {},
        true,
      ),
      { providerLabel: PROVIDER_LABEL, operation: "get_account_balances", dataKind: "balance" },
    );
    return response.balances.map((balance) => {
      const label = optionalText(balance.name);
      return {
        accountId: account.accountId,
        institution: account.institution,
        country: account.country,
        currency: balance.balance_amount.currency,
        amount: formatAmount(balance.balance_amount.amount, balance.balance_amount.currency),
        balanceType: BALANCE_TYPES[balance.balance_type],
        ...(label === undefined ? {} : { label }),
        ...(balance.reference_date === undefined ? {} : { referenceDate: balance.reference_date }),
        ...(balance.last_change_date_time === undefined
          ? {} : { lastChangedAt: balance.last_change_date_time }),
      };
    });
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
      transactions: response.transactions
        .map((transaction) => normalizeTransaction(accountId, transaction))
        .filter((transaction) => query.status === undefined || transaction.status === query.status),
    };
    if (response.continuation_key) page.continuationKey = response.continuation_key;
    return page;
  }

  async listAccountIds(): Promise<string[]> {
    return (await this.selectAccounts()).map(({ accountId }) => accountId);
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
    if (accountId === undefined) return this.uniqueAccounts(accounts);
    const account = accounts.find((candidate) => candidate.accountId === accountId);
    if (account === undefined) throw unknownAccount();
    return [account];
  }

  /** Account details, read at most once per request. */
  private accountDetails(accountId: string): Promise<z.output<typeof accountDetailsSchema>> {
    let promise = this.detailsPromises.get(accountId);
    if (promise === undefined) {
      promise = this.request(`/accounts/${encodeURIComponent(accountId)}/details`, {}, true)
        .then((value) => accountDetailsSchema.parse(value));
      this.detailsPromises.set(accountId, promise);
    }
    return promise;
  }

  /**
   * Drops an account only when another session already returned the same account.
   * The primary identification hash is based on the account number, so currency
   * accounts sharing one IBAN (e.g. Revolut EUR and GBP) share a hash: when hashes
   * collide, the currency must match too. Holder names and balances are never used.
   */
  private async uniqueAccounts(accounts: AuthorizedAccount[]): Promise<AuthorizedAccount[]> {
    const hashCounts = new Map<string, number>();
    for (const { identificationHash } of accounts) {
      if (identificationHash !== undefined) hashCounts.set(identificationHash, (hashCounts.get(identificationHash) ?? 0) + 1);
    }
    const keys = await Promise.all(accounts.map(async (account) => {
      const hash = account.identificationHash;
      if (hash === undefined) return undefined;
      if (hashCounts.get(hash) === 1) return hash;
      // Only colliding accounts pay for a details read. If it fails, keep the account visible.
      try {
        return `${hash}\u0000${(await this.accountDetails(account.accountId)).currency}`;
      } catch {
        return undefined;
      }
    }));
    return uniqueBy(accounts.map((account, index) => ({ account, key: keys[index] })), ({ key }) => key)
      .map(({ account }) => account);
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
        const identificationHash = session.accounts_data?.find(({ uid }) => uid === accountId)?.identification_hash;
        accounts.set(accountId, {
          accountId,
          institution: session.aspsp.name,
          country: session.aspsp.country,
          ...(identificationHash === undefined ? {} : { identificationHash }),
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
    if (this.token !== undefined && now < this.token.refreshAt) return this.token.promise;
    // The client belongs to one request. Share signing work across its provider calls,
    // including concurrent session discovery, without caching any financial data.
    const promise = this.signAuthorizationToken(now);
    this.token = { promise, refreshAt: now + 3_540 };
    try {
      return await promise;
    } catch (error) {
      if (this.token?.promise === promise) this.token = undefined;
      throw error;
    }
  }

  private async signAuthorizationToken(now: number): Promise<string> {
    this.keyPromise ??= importPKCS8(this.config.privateKeyPem, "RS256");
    return new SignJWT({})
      .setProtectedHeader({
        alg: "RS256",
        typ: "JWT",
        kid: this.config.applicationId,
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
    const headers = new Headers({ Authorization: `Bearer ${await this.authorizationToken()}` });
    if (includePsuHeaders) for (const [name, value] of this.psuHeaders ?? []) headers.set(name, value);
    const operation = providerOperation(path);
    return providerFetch({
      url: `${API_ORIGIN}${path}`,
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      providerLabel: PROVIDER_LABEL,
      operation,
      toError: (response) => providerError(response, operation),
    });
  }
}

function parseTransactionsResponse(value: unknown) {
  return parseProviderResponse(transactionsSchema, value, {
    providerLabel: PROVIDER_LABEL, operation: "get_account_transactions", dataKind: "transaction",
  });
}

async function providerError(response: Response, operation: string): Promise<PublicError> {
  const errorCode = await readProviderErrorCode(response, errorResponseSchema, { providerLabel: PROVIDER_LABEL, operation });
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
  if (errorCode === "ASPSP_TIMEOUT" || response.status === 408) return providerTimeout(PROVIDER_LABEL);
  if (errorCode === "ASPSP_RATE_LIMIT_EXCEEDED") return bankRateLimited();
  if (response.status === 401) {
    return new PublicError("Enable Banking rejected the configured credentials.", "provider_auth_failed");
  }
  return statusFallbackError(PROVIDER_LABEL, response.status);
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


function normalizeTransaction(accountId: string, transaction: EnableBankingTransaction): Transaction {
  const credit = transaction.credit_debit_indicator === "CRDT";
  const counterparty = optionalText(credit ? transaction.debtor?.name : transaction.creditor?.name);
  const bankTransactionDescription = optionalText(transaction.bank_transaction_code?.description);
  const description = [transaction.remittance_information?.join(" "), transaction.note]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" — ");

  return {
    accountId,
    amount: formatAmount(new Money(transaction.transaction_amount.amount).abs(), transaction.transaction_amount.currency),
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
    ...(transaction.reference_number === undefined ? {} : { paymentReference: transaction.reference_number }),
    ...(bankTransactionDescription === undefined ? {} : { bankTransactionDescription }),
  };
}

