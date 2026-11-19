import type { z } from "zod";
import type { TrueLayerConfig } from "../../config";
import { errorMessage, PublicError } from "../../errors";
import type {
  AccountReadError,
  AccountSummary,
  Balance,
  CashAccountType,
  Transaction,
  TransactionPage,
} from "../../finance";
import { readBoundedJson } from "../../http";
import { Money } from "../../money";
import type { BalanceReadResult, FinanceProvider, PsuContext, TransactionQuery } from "../types";
import {
  MAX_TRUELAYER_CONNECTIONS,
  type TrueLayerConnection,
  type TrueLayerConnectionRecord,
  type TrueLayerConnectionStore,
} from "./connection-store";
import {
  accountBalanceSchema,
  accountsSchema,
  cardBalanceSchema,
  cardsSchema,
  errorResponseSchema,
  MAX_TRUELAYER_ACCOUNTS,
  meSchema,
  tokenResponseSchema,
  transactionsSchema,
  type TrueLayerTransaction,
} from "./schemas";

const REQUEST_TIMEOUT_MS = 10_000;
const ACCESS_TOKEN_SAFETY_MARGIN_MS = 60_000;
const DEFAULT_HISTORY_DAYS = 90;
// TrueLayer returns a whole date range in one response. Quarter-year windows keep
// each response bounded and become this provider's pagination: a 366-day scan of one
// account takes 4 pages, so several accounts fit within the tools' 20-page scan limit.
const TRANSACTION_WINDOW_DAYS = 92;
// A busy account can post a few thousand entries in a quarter (~600 bytes each).
const MAX_TRUELAYER_RESPONSE_BYTES = 4_000_000;
const CONTINUATION_PREFIX = "tl1:";

export const TRUELAYER_SCOPES = "accounts balance cards transactions offline_access";
const TRUELAYER_PROVIDERS = "uk-ob-all uk-oauth-all";

type AccountKind = "accounts" | "cards";

interface AuthorizedAccount {
  accountId: string;
  providerAccountId: string;
  kind: AccountKind;
  connectionId: string;
  institution: string;
  currency: string;
  accountType?: string;
  displayName?: string;
  /** In-memory only: identifies the same real account across connections. Never returned or stored. */
  identity?: string;
}

export interface TrueLayerConnectionSummary {
  connectionId: string;
  providerId?: string;
  institution?: string;
  consentExpiresAt?: string;
  createdAt: string;
}

export function isTrueLayerAccountId(accountId: string): boolean {
  return accountId.startsWith("tl-");
}

export function trueLayerAuthorizationUrl(
  config: TrueLayerConfig,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL(origins(config).auth);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: TRUELAYER_SCOPES,
    providers: config.sandbox ? `${TRUELAYER_PROVIDERS} uk-cs-mock` : TRUELAYER_PROVIDERS,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export class TrueLayerClient implements FinanceProvider {
  private connectionsPromise: Promise<TrueLayerConnection[]> | undefined;
  private accountsPromise: Promise<AuthorizedAccount[]> | undefined;
  private readonly accessTokens = new Map<string, Promise<string>>();

  constructor(
    private readonly config: TrueLayerConfig,
    private readonly store: TrueLayerConnectionStore,
    private readonly psu?: PsuContext,
  ) {}

  async listAccounts(): Promise<AccountSummary[]> {
    return (await this.listedAccounts()).map((account) => ({
      accountId: account.accountId,
      institution: account.institution,
      country: "GB",
      currency: account.currency,
      cashAccountType: cashAccountType(account),
      ...(account.displayName === undefined ? {} : { product: account.displayName }),
      ...(account.accountType === undefined
        ? {}
        : { usage: account.accountType.startsWith("BUSINESS_") ? "professional" as const : "personal" as const }),
    }));
  }

  async listAccountIds(): Promise<string[]> {
    return (await this.listedAccounts()).map(({ accountId }) => accountId);
  }

  async getBalances(accountId?: string): Promise<BalanceReadResult> {
    if (accountId !== undefined) {
      return { balances: await this.accountBalances(await this.selectAccount(accountId)), errors: [] };
    }

    const byConnection = new Map<string, AuthorizedAccount[]>();
    for (const account of await this.listedAccounts()) {
      byConnection.set(account.connectionId, [...(byConnection.get(account.connectionId) ?? []), account]);
    }
    const results = await Promise.all(
      [...byConnection.values()].map(async (group) => {
        const balances: Balance[] = [];
        const errors: AccountReadError[] = [];
        for (const [index, account] of group.entries()) {
          try {
            balances.push(...(await this.accountBalances(account)));
          } catch (error) {
            errors.push(accountReadError(account, error));
            if (error instanceof PublicError && error.code === "aspsp_rate_limited") {
              // Further reads at the same bank would hit the same limit.
              for (const skipped of group.slice(index + 1)) errors.push(accountReadError(skipped, error));
              break;
            }
          }
        }
        return { balances, errors };
      }),
    );
    return {
      balances: results.flatMap((result) => result.balances),
      errors: results.flatMap((result) => result.errors),
    };
  }

  async listTransactions(accountId: string, query: TransactionQuery): Promise<TransactionPage> {
    const account = await this.selectAccount(accountId);
    const includeSettled = query.status === undefined || query.status === "booked";
    const includePending = query.status === undefined || query.status === "pending";
    if (!includeSettled && !includePending) return { transactions: [] };

    const dateTo = query.dateTo ?? todayIsoDate();
    const dateFrom = query.dateFrom ?? addDays(dateTo, -(DEFAULT_HISTORY_DAYS - 1));
    const windowTo = query.continuationKey === undefined
      ? dateTo
      : parseContinuationKey(query.continuationKey, dateFrom, dateTo);
    const windowFrom = laterDate(dateFrom, addDays(windowTo, -(TRANSACTION_WINDOW_DAYS - 1)));
    const firstPage = query.continuationKey === undefined;

    let historyUnavailable = false;
    const [settled, pending] = await Promise.all([
      includeSettled
        ? this.readTransactions(account, "", windowFrom, windowTo).catch((error: unknown) => {
            // UK banks stop sharing older history shortly after consent. Older windows
            // then fail; report that and stop paging instead of failing the whole read.
            if (error instanceof PublicError && error.code === "history_unavailable") {
              historyUnavailable = true;
              return [];
            }
            throw error;
          })
        : Promise.resolve([]),
      // Pending entries are recent; read them once, on the first page, over the whole range.
      includePending && firstPage
        ? this.readTransactions(account, "/pending", dateFrom, dateTo).catch((error: unknown) => {
            if (error instanceof PublicError && error.code === "provider_unsupported") return [];
            throw error;
          })
        : Promise.resolve([]),
    ]);

    const transactions = [
      ...pending.map((transaction) => normalizeTransaction(account.accountId, transaction, "pending")),
      ...settled.map((transaction) => normalizeTransaction(account.accountId, transaction, "booked")),
    ];
    const page: TransactionPage = { transactions };
    if (historyUnavailable) {
      page.historyUnavailable = true;
    } else if (includeSettled && windowFrom > dateFrom) {
      page.continuationKey = `${CONTINUATION_PREFIX}${addDays(windowFrom, -1)}`;
    }
    return page;
  }

  async listConnections(): Promise<TrueLayerConnectionSummary[]> {
    return (await this.store.list()).map(({ id, record }) => ({
      connectionId: id,
      createdAt: record.createdAt,
      ...(record.providerId === undefined ? {} : { providerId: record.providerId }),
      ...(record.providerName === undefined ? {} : { institution: record.providerName }),
      ...(record.consentExpiresAt === undefined ? {} : { consentExpiresAt: record.consentExpiresAt }),
    }));
  }

  async completeAuthorization(code: string, redirectUri: string, codeVerifier: string): Promise<string> {
    if ((await this.store.list()).length >= MAX_TRUELAYER_CONNECTIONS) {
      throw new PublicError(
        `At most ${MAX_TRUELAYER_CONNECTIONS} TrueLayer connections are supported. Remove one first.`,
        "connection_limit_reached",
      );
    }
    const token = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    if (token.refresh_token === undefined) {
      throw new PublicError(
        "TrueLayer did not grant offline access. Enable the offline_access scope for this app.",
        "offline_access_missing",
      );
    }

    let metadata: z.infer<typeof meSchema>["results"][number] | undefined;
    try {
      metadata = meSchema.parse(await this.dataRequest(token.access_token, "/me")).results[0];
    } catch {
      // Labels are optional; the connection is usable without them.
    }
    const providerName = metadata?.provider?.display_name ?? metadata?.provider?.provider_id;
    const record: TrueLayerConnectionRecord = {
      refreshToken: token.refresh_token,
      accessToken: token.access_token,
      accessTokenExpiresAt: Date.now() + token.expires_in * 1_000,
      createdAt: new Date().toISOString(),
      ...(metadata?.provider?.provider_id == null ? {} : { providerId: metadata.provider.provider_id }),
      ...(providerName == null ? {} : { providerName }),
      ...(metadata?.consent_expires_at == null ? {} : { consentExpiresAt: metadata.consent_expires_at }),
    };
    const connectionId = crypto.randomUUID();
    await this.store.put(connectionId, record);
    return connectionId;
  }

  async removeConnection(connectionId: string): Promise<void> {
    const connection = (await this.store.list()).find(({ id }) => id === connectionId);
    if (connection === undefined) {
      throw new PublicError("Unknown TrueLayer connection.", "unknown_session");
    }
    try {
      const accessToken = await this.accessToken(connection);
      await this.fetchJson(`${origins(this.config).auth}/api/delete`, {
        method: "DELETE",
        accessToken,
        operation: "delete_credential",
      });
    } catch (error) {
      // Revocation is best effort: an expired or revoked consent cannot be revoked again.
      console.warn(JSON.stringify({
        message: "TrueLayer credential deletion failed",
        errorCode: error instanceof PublicError ? error.code : "unknown",
      }));
    }
    await this.store.remove(connectionId);
  }

  private async selectAccount(accountId: string): Promise<AuthorizedAccount> {
    const account = (await this.authorizedAccounts()).find((candidate) => candidate.accountId === accountId);
    if (account === undefined) throw unknownAccount();
    return account;
  }

  private connections(): Promise<TrueLayerConnection[]> {
    this.connectionsPromise ??= this.store.list();
    return this.connectionsPromise;
  }

  /**
   * Accounts for all-account reads, without duplicates when the same bank is connected
   * twice (for example while renewing consent). The newest connection wins. An older
   * duplicate's ID still works when requested explicitly.
   */
  private async listedAccounts(): Promise<AuthorizedAccount[]> {
    const seen = new Set<string>();
    return (await this.authorizedAccounts()).filter((account) => {
      if (account.identity === undefined) return true;
      if (seen.has(account.identity)) return false;
      seen.add(account.identity);
      return true;
    });
  }

  private authorizedAccounts(): Promise<AuthorizedAccount[]> {
    this.accountsPromise ??= this.loadAuthorizedAccounts();
    return this.accountsPromise;
  }

  private async loadAuthorizedAccounts(): Promise<AuthorizedAccount[]> {
    const connections = await this.connections();
    if (connections.length === 0) throw setupRequired();

    // Newest connection first, so its accounts win de-duplication.
    const newestFirst = [...connections].sort((left, right) =>
      right.record.createdAt.localeCompare(left.record.createdAt));
    const perConnection = await Promise.all(
      newestFirst.map(async (connection) => {
        try {
          return await this.discoverAccounts(connection);
        } catch (error) {
          if (error instanceof PublicError && error.code === "provider_reauthorization_required") {
            console.warn(JSON.stringify({ message: "TrueLayer connection needs reauthorization" }));
            return [];
          }
          throw error;
        }
      }),
    );
    const accounts = perConnection.flat();
    if (accounts.length > MAX_TRUELAYER_ACCOUNTS) {
      throw new PublicError(
        "TrueLayer returned too many accounts for this personal deployment.",
        "provider_account_limit_exceeded",
      );
    }
    if (accounts.length === 0) throw setupRequired();
    return accounts;
  }

  private async discoverAccounts(connection: TrueLayerConnection): Promise<AuthorizedAccount[]> {
    const [accounts, cards] = await Promise.all([
      this.connectionRequest(connection, "/accounts").then((value) =>
        parseProviderResponse(accountsSchema, value, "get_accounts").results),
      this.connectionRequest(connection, "/cards")
        .then((value) => parseProviderResponse(cardsSchema, value, "get_cards").results)
        .catch((error: unknown) => {
          // Many banks expose no card endpoint, and the scope may not be granted.
          if (error instanceof PublicError && error.code !== "provider_reauthorization_required") return [];
          throw error;
        }),
    ]);
    const fallbackName = (provider: { display_name?: string | undefined; provider_id?: string | undefined } | null | undefined) =>
      connection.record.providerName ?? provider?.display_name ?? provider?.provider_id ?? "TrueLayer bank";

    return [
      ...accounts.map((account) => ({
        accountId: `tl-a-${account.account_id}`,
        providerAccountId: account.account_id,
        kind: "accounts" as const,
        connectionId: connection.id,
        institution: fallbackName(account.provider),
        currency: account.currency,
        ...(account.account_type === undefined ? {} : { accountType: account.account_type }),
        ...(accountIdentity(account) === undefined ? {} : { identity: accountIdentity(account)! }),
        ...(optionalText(account.display_name) === undefined ? {} : { displayName: optionalText(account.display_name)! }),
      })),
      ...cards.map((card) => {
        const displayName = optionalText(card.display_name) ??
          optionalText([card.card_network, card.card_type].filter(Boolean).join(" "));
        return {
          accountId: `tl-c-${card.account_id}`,
          providerAccountId: card.account_id,
          kind: "cards" as const,
          connectionId: connection.id,
          institution: fallbackName(card.provider),
          currency: card.currency,
          ...(displayName === undefined ? {} : { displayName }),
          ...(cardIdentity(card) === undefined ? {} : { identity: cardIdentity(card)! }),
        };
      }),
    ];
  }

  private async accountBalances(account: AuthorizedAccount): Promise<Balance[]> {
    const connection = await this.connectionFor(account);
    const path = `/${account.kind}/${encodeURIComponent(account.providerAccountId)}/balance`;
    const base = { accountId: account.accountId, institution: account.institution, country: "GB" };

    if (account.kind === "cards") {
      const results = parseProviderResponse(
        cardBalanceSchema, await this.connectionRequest(connection, path), "get_card_balance",
      ).results;
      return results.flatMap((balance) => [
        { ...base, currency: balance.currency, amount: decimal(balance.current), balanceType: "interim_booked" as const, label: "card current balance (as reported by the card issuer)" },
        ...(balance.available === undefined ? [] : [
          { ...base, currency: balance.currency, amount: decimal(balance.available), balanceType: "interim_available" as const, label: "available credit" },
        ]),
        ...(balance.credit_limit === undefined ? [] : [
          { ...base, currency: balance.currency, amount: decimal(balance.credit_limit), balanceType: "informational" as const, label: "credit limit" },
        ]),
        ...(balance.last_statement_balance === undefined ? [] : [{
          ...base,
          currency: balance.currency,
          amount: decimal(balance.last_statement_balance),
          balanceType: "closing_booked" as const,
          label: "last statement balance",
          ...(isoDatePrefix(balance.last_statement_date) === undefined
            ? {} : { referenceDate: isoDatePrefix(balance.last_statement_date)! }),
        }]),
      ]);
    }

    const results = parseProviderResponse(
      accountBalanceSchema, await this.connectionRequest(connection, path), "get_account_balance",
    ).results;
    return results.flatMap((balance) => [
      { ...base, currency: balance.currency, amount: decimal(balance.current), balanceType: "interim_booked" as const, label: "current balance (booked)" },
      ...(balance.available === undefined ? [] : [
        { ...base, currency: balance.currency, amount: decimal(balance.available), balanceType: "interim_available" as const, label: "available balance (includes any arranged overdraft)" },
      ]),
      ...(balance.overdraft === undefined ? [] : [
        { ...base, currency: balance.currency, amount: decimal(balance.overdraft), balanceType: "informational" as const, label: "arranged overdraft limit" },
      ]),
    ]);
  }

  private async readTransactions(
    account: AuthorizedAccount,
    suffix: "" | "/pending",
    from: string,
    to: string,
  ): Promise<TrueLayerTransaction[]> {
    const connection = await this.connectionFor(account);
    const params = new URLSearchParams({ from, to });
    const value = await this.connectionRequest(
      connection,
      `/${account.kind}/${encodeURIComponent(account.providerAccountId)}/transactions${suffix}?${params.toString()}`,
    );
    return parseProviderResponse(
      transactionsSchema,
      value,
      suffix === "" ? "get_transactions" : "get_pending_transactions",
    ).results;
  }

  private async connectionFor(account: AuthorizedAccount): Promise<TrueLayerConnection> {
    const connection = (await this.connections()).find(({ id }) => id === account.connectionId);
    if (connection === undefined) throw unknownAccount();
    return connection;
  }

  /** Data API request with one forced token refresh if the cached access token was rejected. */
  private async connectionRequest(connection: TrueLayerConnection, path: string): Promise<unknown> {
    try {
      return await this.dataRequest(await this.accessToken(connection), path);
    } catch (error) {
      if (!(error instanceof PublicError) || error.code !== "provider_token_rejected") throw error;
      this.accessTokens.delete(connection.id);
      return this.dataRequest(await this.accessToken(connection, true), path);
    }
  }

  private accessToken(connection: TrueLayerConnection, forceRefresh = false): Promise<string> {
    const cached = this.accessTokens.get(connection.id);
    if (cached !== undefined && !forceRefresh) return cached;

    const { record } = connection;
    if (
      !forceRefresh &&
      record.accessToken !== undefined &&
      record.accessTokenExpiresAt !== undefined &&
      record.accessTokenExpiresAt - ACCESS_TOKEN_SAFETY_MARGIN_MS > Date.now()
    ) {
      const promise = Promise.resolve(record.accessToken);
      this.accessTokens.set(connection.id, promise);
      return promise;
    }

    const promise = this.refresh(connection);
    this.accessTokens.set(connection.id, promise);
    promise.catch(() => {
      if (this.accessTokens.get(connection.id) === promise) this.accessTokens.delete(connection.id);
    });
    return promise;
  }

  private async refresh(connection: TrueLayerConnection): Promise<string> {
    const token = await this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: connection.record.refreshToken,
    });
    const record: TrueLayerConnectionRecord = {
      ...connection.record,
      // TrueLayer may rotate the refresh token; always keep the newest one.
      refreshToken: token.refresh_token ?? connection.record.refreshToken,
      accessToken: token.access_token,
      accessTokenExpiresAt: Date.now() + token.expires_in * 1_000,
    };
    await this.store.put(connection.id, record);
    connection.record = record;
    return token.access_token;
  }

  private async tokenRequest(body: Record<string, string>): Promise<z.infer<typeof tokenResponseSchema>> {
    const value = await this.fetchJson(`${origins(this.config).auth}/connect/token`, {
      method: "POST",
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        ...body,
      }),
      operation: body.grant_type === "refresh_token" ? "refresh_token" : "exchange_code",
    });
    const parsed = tokenResponseSchema.safeParse(value);
    if (!parsed.success) {
      throw new PublicError("TrueLayer returned an invalid token response.", "provider_response_invalid");
    }
    return parsed.data;
  }

  private dataRequest(accessToken: string, path: string): Promise<unknown> {
    return this.fetchJson(`${origins(this.config).api}${path}`, {
      method: "GET",
      accessToken,
      includePsu: true,
      operation: dataOperation(path),
    });
  }

  private async fetchJson(
    url: string,
    init: {
      method: "DELETE" | "GET" | "POST";
      operation: string;
      accessToken?: string;
      body?: string;
      includePsu?: boolean;
    },
  ): Promise<unknown> {
    const headers = new Headers({ Accept: "application/json" });
    if (init.accessToken !== undefined) headers.set("Authorization", `Bearer ${init.accessToken}`);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (init.includePsu && this.psu?.ipAddress !== undefined) headers.set("X-PSU-IP", this.psu.ipAddress);

    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") throw providerTimeout();
      console.error(JSON.stringify({
        message: "TrueLayer fetch threw",
        operation: init.operation,
        errorType: error instanceof Error ? error.name : typeof error,
      }));
      throw error;
    }

    if (response.status >= 300 && response.status < 400) {
      throw new PublicError("TrueLayer returned an unexpected redirect.", "provider_redirect_rejected");
    }
    if (!response.ok) throw await providerError(response, init.operation);
    if (init.method === "DELETE") return null;
    return readBoundedJson(response, MAX_TRUELAYER_RESPONSE_BYTES);
  }
}

function origins(config: TrueLayerConfig): { auth: string; api: string } {
  return config.sandbox
    ? { auth: "https://auth.truelayer-sandbox.com", api: "https://api.truelayer-sandbox.com/data/v1" }
    : { auth: "https://auth.truelayer.com", api: "https://api.truelayer.com/data/v1" };
}

function dataOperation(path: string): string {
  if (path === "/me") return "get_connection_metadata";
  if (path === "/accounts") return "get_accounts";
  if (path === "/cards") return "get_cards";
  if (/\/balance$/.test(path)) return "get_balance";
  if (/\/transactions\/pending\?/.test(path)) return "get_pending_transactions";
  if (/\/transactions\?/.test(path)) return "get_transactions";
  return "unknown";
}

function parseProviderResponse<T extends z.ZodType>(schema: T, value: unknown, operation: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  console.error(JSON.stringify({
    message: "TrueLayer response validation failed",
    operation,
    issueCount: parsed.error.issues.length,
    issues: parsed.error.issues.slice(0, 10).map((issue) => ({
      code: issue.code,
      path: issue.path.map(String).join("."),
    })),
  }));
  throw new PublicError("TrueLayer returned unsupported account data.", "provider_response_invalid");
}

async function providerError(response: Response, operation: string): Promise<PublicError> {
  let errorCode: string | undefined;
  try {
    const parsed = errorResponseSchema.safeParse(await readBoundedJson(response));
    if (parsed.success) errorCode = parsed.data.error;
  } catch {
    // Fall back to status-based handling.
  }
  console.warn(JSON.stringify({
    message: "TrueLayer request failed",
    operation,
    status: response.status,
    errorCode: errorCode ?? "unknown",
  }));

  if (errorCode === "sca_exceeded") {
    return new PublicError(
      "The bank only shares older transaction history shortly after connecting (usually up to 90 days afterwards). Use a more recent date range, or reconnect the bank at /setup.",
      "history_unavailable",
    );
  }
  if (errorCode === "invalid_grant" || errorCode === "access_denied") {
    return new PublicError(
      "TrueLayer consent has expired or was revoked. Reconnect this bank at /setup.",
      "provider_reauthorization_required",
    );
  }
  if (errorCode === "invalid_client" || errorCode === "unauthorized_client") {
    return new PublicError("TrueLayer rejected the configured client credentials.", "provider_auth_failed");
  }
  if (response.status === 401) {
    return new PublicError("TrueLayer rejected the access token.", "provider_token_rejected");
  }
  if (errorCode === "invalid_authorization_code") {
    return new PublicError("The bank authorization code expired. Start again.", "authorization_code_invalid");
  }
  if (errorCode === "provider_too_many_requests" || errorCode === "provider_request_limit_exceeded") {
    return new PublicError(
      "The bank rate-limited account data access. Do not retry immediately.",
      "aspsp_rate_limited",
    );
  }
  if (response.status === 429) {
    return new PublicError("TrueLayer rate-limited this request. Try again shortly.", "provider_rate_limited");
  }
  if (response.status === 501 || errorCode === "endpoint_not_supported") {
    return new PublicError("This bank does not support the requested data through TrueLayer.", "provider_unsupported");
  }
  if (response.status === 504 || errorCode === "provider_timeout" || errorCode === "connector_timeout") {
    return providerTimeout();
  }
  if (response.status === 404 || errorCode === "account_not_found") {
    return new PublicError("The configured account or connection is unavailable.", "provider_not_found");
  }
  if (response.status === 403) {
    return new PublicError("TrueLayer denied access to this account or service.", "provider_access_denied");
  }
  return new PublicError("TrueLayer could not complete this request.", "provider_error");
}

function normalizeTransaction(
  accountId: string,
  transaction: TrueLayerTransaction,
  status: "booked" | "pending",
): Transaction {
  const date = ukLocalDate(transaction.timestamp);
  const credit = transaction.transaction_type === "CREDIT";
  // Banks fill different fields: Starling, for example, sends the merchant only in meta.
  const counterparty = optionalText(transaction.merchant_name) ??
    optionalText(transaction.meta?.provider_merchant_name) ??
    optionalText(transaction.meta?.counter_party_preferred_name) ??
    // The debtor is the other party only when money comes in.
    (credit ? optionalText(transaction.meta?.debtor_account_name) : undefined);
  const description = [optionalText(transaction.description), optionalText(transaction.meta?.user_comments)]
    .filter((value): value is string => value !== undefined)
    .join(" — ") || undefined;
  const reference = optionalText(transaction.normalised_provider_transaction_id) ??
    optionalText(transaction.provider_transaction_id);
  const paymentReference = optionalText(transaction.meta?.provider_reference);
  // Prefer the bank's own transaction type (e.g. FASTER_PAYMENTS_IN) over TrueLayer's generic category.
  const category = optionalText(transaction.meta?.provider_category) ??
    optionalText(transaction.transaction_category);

  return {
    accountId,
    // Account amounts are signed but card amounts are not; transaction_type is authoritative.
    amount: new Money(transaction.amount).abs().toFixed(),
    currency: transaction.currency,
    direction: credit ? "credit" : "debit",
    status,
    // Settled timestamps are the posting date; pending timestamps are when the payment was made.
    ...(status === "booked" ? { bookingDate: date } : { transactionDate: date }),
    ...(counterparty === undefined ? {} : { counterparty }),
    ...(description === undefined ? {} : { description }),
    ...(reference === undefined ? {} : { reference }),
    ...(paymentReference === undefined ? {} : { paymentReference }),
    ...(category === undefined ? {} : { bankTransactionDescription: category.toLowerCase().replaceAll("_", " ") }),
  };
}

const UK_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * TrueLayer timestamps are usually UTC instants ("…Z"). UK users think in London time,
 * so a 00:30 BST payment belongs to that London day, not the previous UTC day.
 * Timestamps without an offset are already local and keep their date as written.
 */
export function ukLocalDate(timestamp: string): string {
  const written = timestamp.slice(0, 10);
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(timestamp)) return written;
  const instant = Date.parse(timestamp);
  return Number.isNaN(instant) ? written : UK_DATE.format(instant);
}

function accountIdentity(account: {
  currency: string;
  account_number?: { iban?: string | undefined; sort_code?: string | undefined; number?: string | undefined } | null | undefined;
}): string | undefined {
  const compact = (value: string | undefined) => value?.replace(/[\s-]/g, "").toUpperCase() || undefined;
  const iban = compact(account.account_number?.iban);
  if (iban !== undefined) return `iban:${iban}:${account.currency}`;
  const sortCode = compact(account.account_number?.sort_code);
  const number = compact(account.account_number?.number);
  return sortCode !== undefined && number !== undefined ? `uk:${sortCode}:${number}:${account.currency}` : undefined;
}

function cardIdentity(card: {
  card_network?: string | undefined;
  partial_card_number?: string | undefined;
  valid_to?: string | undefined;
  currency: string;
}): string | undefined {
  // Last digits alone can collide; require network and expiry too.
  if (card.card_network === undefined || card.partial_card_number === undefined || card.valid_to === undefined) {
    return undefined;
  }
  return `card:${card.card_network}:${card.partial_card_number}:${card.valid_to}:${card.currency}`;
}

function cashAccountType(account: AuthorizedAccount): CashAccountType {
  if (account.kind === "cards") return "card";
  if (account.accountType === "TRANSACTION" || account.accountType === "BUSINESS_TRANSACTION") return "current";
  if (account.accountType === "SAVINGS" || account.accountType === "BUSINESS_SAVINGS") return "savings";
  return "other";
}

function parseContinuationKey(key: string, dateFrom: string, dateTo: string): string {
  const date = key.startsWith(CONTINUATION_PREFIX) ? key.slice(CONTINUATION_PREFIX.length) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < dateFrom || date > dateTo) {
    throw new PublicError(
      "The TrueLayer pagination cursor is no longer valid. Start the query again.",
      "provider_cursor_invalid",
    );
  }
  return date;
}

function accountReadError(account: AuthorizedAccount, error: unknown): AccountReadError {
  return {
    accountId: account.accountId,
    institution: account.institution,
    country: "GB",
    code: error instanceof PublicError ? error.code : "provider_error",
    message: errorMessage(error),
  };
}

function decimal(value: number): string {
  return new Money(value).toFixed();
}

function isoDatePrefix(value: string | undefined): string | undefined {
  const date = value?.slice(0, 10);
  return date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

function optionalText(value: string | null | undefined): string | undefined {
  return value?.trim() || undefined;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function laterDate(first: string, second: string): string {
  return first > second ? first : second;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function providerTimeout(): PublicError {
  return new PublicError("TrueLayer timed out. Try again shortly.", "provider_timeout");
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
