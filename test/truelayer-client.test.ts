import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrueLayerConfig } from "../src/providers/truelayer/config";
import { TrueLayerClient, trueLayerAuthorizationUrl, ukLocalDate } from "../src/providers/truelayer/client";
import {
  KvTrueLayerConnectionStore,
  type TrueLayerConnection,
  type TrueLayerConnectionRecord,
  type TrueLayerConnectionStore,
} from "../src/providers/truelayer/connection-store";
import { decodeEncryptionKey, TokenCipher } from "../src/lib/crypto";

const KEY_BASE64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const CONNECTION_ID = "66666666-6666-4666-8666-666666666666";

const config: TrueLayerConfig = {
  clientId: "personalfinance-abc123",
  clientSecret: "test-client-secret",
  sandbox: false,
};

class MemoryStore implements TrueLayerConnectionStore {
  readonly records = new Map<string, TrueLayerConnectionRecord>();
  async list(): Promise<TrueLayerConnection[]> {
    return [...this.records].map(([id, record]) => ({ id, record: { ...record } }));
  }
  async put(id: string, record: TrueLayerConnectionRecord): Promise<void> {
    this.records.set(id, record);
  }
  async remove(id: string): Promise<void> {
    this.records.delete(id);
  }
}

function freshRecord(overrides: Partial<TrueLayerConnectionRecord> = {}): TrueLayerConnectionRecord {
  return {
    refreshToken: "refresh-1",
    accessToken: "access-1",
    accessTokenExpiresAt: Date.now() + 3_600_000,
    providerName: "Monzo",
    createdAt: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Route = (url: URL, init: RequestInit | undefined) => Response | undefined;

function mockFetch(...routes: Route[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    for (const route of routes) {
      const response = route(url, init);
      if (response !== undefined) return response;
    }
    throw new Error(`Unexpected fetch ${url.pathname}`);
  });
}

const accountsRoute: Route = (url) =>
  url.pathname === "/data/v1/accounts"
    ? Response.json({
        results: [{
          account_id: "acc123",
          account_type: "TRANSACTION",
          display_name: "Current Account",
          currency: "GBP",
          account_number: { number: "12345678", sort_code: "04-00-04" },
          provider: { provider_id: "ob-monzo" },
          update_timestamp: "2026-11-19T10:00:00Z",
        }],
      })
    : undefined;

const noCardsRoute: Route = (url) =>
  url.pathname === "/data/v1/cards"
    ? Response.json({ error: "endpoint_not_supported" }, { status: 501 })
    : undefined;

describe("token encryption", () => {
  it("round-trips and binds ciphertext to its associated data", async () => {
    const cipher = new TokenCipher(decodeEncryptionKey(KEY_BASE64));
    const sealed = await cipher.seal("secret-refresh-token", "key-a");
    expect(sealed).not.toContain("secret-refresh-token");
    await expect(cipher.open(sealed, "key-a")).resolves.toBe("secret-refresh-token");
    await expect(cipher.open(sealed, "key-b")).rejects.toThrow();
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => decodeEncryptionKey(btoa("short"))).toThrow(/32 bytes/);
  });
});


describe("KvTrueLayerConnectionStore", () => {
  it("stores only encrypted records", async () => {
    const kvStore = new KvTrueLayerConnectionStore(
      env.SESSION_STORE,
      new TokenCipher(decodeEncryptionKey(KEY_BASE64)),
    );
    await kvStore.put(CONNECTION_ID, freshRecord({ refreshToken: "very-secret-refresh" }));
    const raw = await env.SESSION_STORE.get(`truelayer-connection-v1:${CONNECTION_ID}`);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain("very-secret-refresh");
    expect(raw).not.toContain("Monzo");
    const [connection] = await kvStore.list();
    expect(connection?.record.refreshToken).toBe("very-secret-refresh");
    await kvStore.remove(CONNECTION_ID);
    await expect(kvStore.list()).resolves.toEqual([]);
  });
});

describe("TrueLayerClient", () => {
  it("builds a PKCE auth link for UK banks with offline access", () => {
    const url = new URL(trueLayerAuthorizationUrl(config, "https://finance.example/callback/truelayer", "state-1", "challenge"));
    expect(url.origin).toBe("https://auth.truelayer.com");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: "https://finance.example/callback/truelayer",
      scope: "accounts balance cards transactions offline_access",
      providers: "uk-ob-all uk-oauth-all",
      state: "state-1",
      code_challenge: "challenge",
      code_challenge_method: "S256",
    });
  });

  it("exchanges the code with the PKCE verifier and stores the connection", async () => {
    const fetchMock = mockFetch(
      (url, init) => url.pathname === "/connect/token"
        ? (expect(JSON.parse(String(init?.body))).toEqual({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            grant_type: "authorization_code",
            code: "one-time-code",
            redirect_uri: "https://finance.example/callback/truelayer",
            code_verifier: "verifier",
          }), Response.json({ access_token: "access-new", expires_in: 3600, refresh_token: "refresh-new" }))
        : undefined,
      (url) => url.pathname === "/data/v1/me"
        ? Response.json({ results: [{ provider: { display_name: "Monzo", provider_id: "ob-monzo" }, consent_expires_at: "2027-02-17T10:00:00Z" }] })
        : undefined,
    );

    const id = await new TrueLayerClient(config, store).completeAuthorization(
      "one-time-code", "https://finance.example/callback/truelayer", "verifier",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.records.get(id)).toMatchObject({
      refreshToken: "refresh-new",
      accessToken: "access-new",
      providerName: "Monzo",
      providerId: "ob-monzo",
      consentExpiresAt: "2027-02-17T10:00:00Z",
    });
  });

  it("lists accounts without account numbers and skips banks without card support", async () => {
    store.records.set(CONNECTION_ID, freshRecord());
    const fetchMock = mockFetch(accountsRoute, noCardsRoute);

    const accounts = await new TrueLayerClient(config, store, { ipAddress: "203.0.113.9" }).listAccounts();

    expect(accounts).toEqual([{
      accountId: "tl-a-acc123",
      institution: "Monzo",
      country: "GB",
      currency: "GBP",
      cashAccountType: "current",
      product: "Current Account",
      usage: "personal",
    }]);
    expect(JSON.stringify(accounts)).not.toContain("12345678");
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer access-1");
    expect(headers.get("X-PSU-IP")).toBe("203.0.113.9");
  });

  it("refreshes an expired access token and keeps a rotated refresh token", async () => {
    store.records.set(CONNECTION_ID, freshRecord({ accessTokenExpiresAt: Date.now() - 1 }));
    mockFetch(
      (url, init) => url.pathname === "/connect/token"
        ? (expect(JSON.parse(String(init?.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-1" }),
          Response.json({ access_token: "access-2", expires_in: 3600, refresh_token: "refresh-2" }))
        : undefined,
      accountsRoute,
      noCardsRoute,
    );

    await new TrueLayerClient(config, store).listAccountIds();

    expect(store.records.get(CONNECTION_ID)).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
  });

  it("retries once with a refreshed token when the cached token is rejected", async () => {
    store.records.set(CONNECTION_ID, freshRecord());
    let accountCalls = 0;
    mockFetch(
      (url) => url.pathname === "/connect/token"
        ? Response.json({ access_token: "access-2", expires_in: 3600 })
        : undefined,
      (url, init) => {
        if (url.pathname !== "/data/v1/accounts") return undefined;
        accountCalls += 1;
        return new Headers(init?.headers).get("Authorization") === "Bearer access-1"
          ? Response.json({ error: "invalid_token" }, { status: 401 })
          : accountsRoute(url, init);
      },
      noCardsRoute,
    );

    await expect(new TrueLayerClient(config, store).listAccountIds()).resolves.toEqual(["tl-a-acc123"]);
    expect(accountCalls).toBe(2);
    expect(store.records.get(CONNECTION_ID)?.refreshToken).toBe("refresh-1");
  });

  it("reports setup required when the only consent has expired", async () => {
    store.records.set(CONNECTION_ID, freshRecord({ accessTokenExpiresAt: Date.now() - 1 }));
    mockFetch((url) => url.pathname === "/connect/token"
      ? Response.json({ error: "invalid_grant" }, { status: 400 })
      : undefined);

    await expect(new TrueLayerClient(config, store).listAccounts()).rejects.toMatchObject({ code: "setup_required" });
  });

  it("maps account and card balances without adding them together", async () => {
    store.records.set(CONNECTION_ID, freshRecord());
    mockFetch(
      accountsRoute,
      (url) => url.pathname === "/data/v1/cards"
        ? Response.json({ results: [{ account_id: "card9", card_network: "VISA", card_type: "CREDIT", currency: "GBP", display_name: "Credit Card", partial_card_number: "1234", provider: { provider_id: "ob-monzo" } }] })
        : undefined,
      (url) => url.pathname === "/data/v1/accounts/acc123/balance"
        ? Response.json({ results: [{ currency: "GBP", current: 1234.56, available: 1500.1, overdraft: 250 }] })
        : undefined,
      (url) => url.pathname === "/data/v1/cards/card9/balance"
        ? Response.json({ results: [{ currency: "GBP", current: 89.9, available: 910.1, credit_limit: 1000, last_statement_balance: 45.5, last_statement_date: "2026-11-01T00:00:00Z" }] })
        : undefined,
    );

    const result = await new TrueLayerClient(config, store).getBalances();

    expect(result.errors).toEqual([]);
    expect(result.balances.map(({ accountId, amount, balanceType, label, referenceDate }) =>
      ({ accountId, amount, balanceType, label, referenceDate }))).toEqual([
      { accountId: "tl-a-acc123", amount: "1234.56", balanceType: "interim_booked", label: "current balance (booked)", referenceDate: undefined },
      { accountId: "tl-a-acc123", amount: "1500.1", balanceType: "interim_available", label: "available balance (includes any arranged overdraft)", referenceDate: undefined },
      { accountId: "tl-a-acc123", amount: "250", balanceType: "informational", label: "arranged overdraft limit", referenceDate: undefined },
      { accountId: "tl-c-card9", amount: "89.9", balanceType: "interim_booked", label: "card current balance (as reported by the card issuer)", referenceDate: undefined },
      { accountId: "tl-c-card9", amount: "910.1", balanceType: "interim_available", label: "available credit", referenceDate: undefined },
      { accountId: "tl-c-card9", amount: "1000", balanceType: "informational", label: "credit limit", referenceDate: undefined },
      { accountId: "tl-c-card9", amount: "45.5", balanceType: "closing_booked", label: "last statement balance", referenceDate: "2026-11-01" },
    ]);
  });

  it("pages transactions in date windows and reads pending entries once", async () => {
    store.records.set(CONNECTION_ID, freshRecord());
    const settledWindows: string[] = [];
    let pendingCalls = 0;
    mockFetch(
      accountsRoute,
      noCardsRoute,
      (url) => {
        if (url.pathname === "/data/v1/accounts/acc123/transactions/pending") {
          pendingCalls += 1;
          return Response.json({ results: [{
            transaction_id: "p1", timestamp: "2026-11-18T12:00:00Z", amount: -4.5, currency: "GBP",
            transaction_type: "DEBIT", transaction_category: "PURCHASE", transaction_classification: [],
            merchant_name: "Pret",
          }] });
        }
        if (url.pathname === "/data/v1/accounts/acc123/transactions") {
          settledWindows.push(`${url.searchParams.get("from")}..${url.searchParams.get("to")}`);
          return Response.json({ results: [{
            transaction_id: "t1", timestamp: "2026-11-10T00:00:00", description: "TESCO STORES",
            amount: -12.34, currency: "GBP", transaction_type: "DEBIT", transaction_category: "PURCHASE",
            transaction_classification: ["Shopping", "Groceries"], provider_transaction_id: "bank-t1",
            meta: { provider_reference: "REF1" },
          }] });
        }
        return undefined;
      },
    );
    const client = new TrueLayerClient(config, store);
    const query = { dateFrom: "2025-12-01", dateTo: "2026-11-19" };

    const first = await client.listTransactions("tl-a-acc123", query);
    expect(first.transactions).toEqual([
      { accountId: "tl-a-acc123", amount: "4.5", currency: "GBP", direction: "debit", status: "pending",
        transactionDate: "2026-11-18", counterparty: "Pret", bankTransactionDescription: "purchase" },
      { accountId: "tl-a-acc123", amount: "12.34", currency: "GBP", direction: "debit", status: "booked",
        bookingDate: "2026-11-10", description: "TESCO STORES", reference: "bank-t1", paymentReference: "REF1",
        bankTransactionDescription: "purchase" },
    ]);
    const second = await client.listTransactions("tl-a-acc123", { ...query, continuationKey: first.continuationKey! });
    const third = await client.listTransactions("tl-a-acc123", { ...query, continuationKey: second.continuationKey! });
    const fourth = await client.listTransactions("tl-a-acc123", { ...query, continuationKey: third.continuationKey! });

    expect(settledWindows).toEqual(["2026-08-20..2026-11-19", "2026-05-20..2026-08-19", "2026-02-17..2026-05-19", "2025-12-01..2026-02-16"]);
    expect(fourth.continuationKey).toBeUndefined();
    expect(pendingCalls).toBe(1);
  });

  it("uses the transaction type for card amounts, which are unsigned", async () => {
    store.records.set(CONNECTION_ID, freshRecord());
    mockFetch(
      accountsRoute,
      (url) => url.pathname === "/data/v1/cards"
        ? Response.json({ results: [{ account_id: "card9", currency: "GBP" }] })
        : undefined,
      (url) => url.pathname === "/data/v1/cards/card9/transactions"
        ? Response.json({ results: [
            { transaction_id: "c1", timestamp: "2026-11-10T00:00:00+00:00", amount: 24.25, currency: "GBP", transaction_type: "DEBIT", transaction_category: "PURCHASE", transaction_classification: [] },
            { transaction_id: "c2", timestamp: "2026-11-11T00:00:00+00:00", amount: -10, currency: "GBP", transaction_type: "CREDIT", transaction_category: "CREDIT", transaction_classification: [] },
          ] })
        : undefined,
    );

    const page = await new TrueLayerClient(config, store).listTransactions("tl-c-card9", {
      dateFrom: "2026-11-01", dateTo: "2026-11-19", status: "booked",
    });

    expect(page.transactions.map(({ amount, direction }) => ({ amount, direction }))).toEqual([
      { amount: "24.25", direction: "debit" },
      { amount: "10", direction: "credit" },
    ]);
  });

  it("reads the fields Starling actually sends", async () => {
    store.records.set(CONNECTION_ID, freshRecord());
    mockFetch(
      accountsRoute,
      noCardsRoute,
      (url) => url.pathname === "/data/v1/accounts/acc123/transactions"
        ? Response.json({ results: [
            // Shape observed live: no merchant_name, merchant and bank type only in meta.
            { transaction_id: "s1", timestamp: "2026-07-14T23:30:00.123Z", description: "CARD PAYMENT", amount: -3.2,
              currency: "GBP", transaction_type: "DEBIT", transaction_category: "PURCHASE", transaction_classification: [],
              meta: { provider_merchant_name: "Pret A Manger", provider_category: "MASTER_CARD", transaction_type: "Debit", user_comments: "team coffee" } },
            { transaction_id: "s2", timestamp: "2026-01-14T23:30:00Z", description: "Salary", amount: 2500,
              currency: "GBP", transaction_type: "CREDIT", transaction_category: "OTHER", transaction_classification: [],
              meta: { debtor_account_name: "ACME LTD", provider_category: "FASTER_PAYMENTS_IN" } },
            { transaction_id: "s3", timestamp: "2026-01-15T10:00:00Z", description: "Rent", amount: -900,
              currency: "GBP", transaction_type: "DEBIT", transaction_category: "TRANSFER", transaction_classification: [],
              meta: { debtor_account_name: "Account owner", provider_category: "FASTER_PAYMENTS_OUT" } },
          ] })
        : undefined,
    );

    const page = await new TrueLayerClient(config, store).listTransactions("tl-a-acc123", {
      dateFrom: "2026-07-01", dateTo: "2026-07-20", status: "booked",
    });

    expect(page.transactions.map(({ bookingDate, counterparty, description, bankTransactionDescription }) =>
      ({ bookingDate, counterparty, description, bankTransactionDescription }))).toEqual([
      { bookingDate: "2026-07-15", counterparty: "Pret A Manger", description: "CARD PAYMENT — team coffee", bankTransactionDescription: "master card" },
      { bookingDate: "2026-01-14", counterparty: "ACME LTD", description: "Salary", bankTransactionDescription: "faster payments in" },
      // The debtor of an outgoing payment is the account owner, never the counterparty.
      { bookingDate: "2026-01-15", counterparty: undefined, description: "Rent", bankTransactionDescription: "faster payments out" },
    ]);
  });

  it.each([
    ["2026-07-14T23:30:00Z", "2026-07-15"], // BST: 00:30 London
    ["2026-01-14T23:30:00Z", "2026-01-14"], // GMT: same day
    ["2026-07-14T23:30:00+00:00", "2026-07-15"],
    ["2026-03-06T00:00:00", "2026-03-06"], // no offset: already local
  ])("dates %s in London as %s", (timestamp, expected) => {
    expect(ukLocalDate(timestamp)).toBe(expected);
  });

  it("stops paging when the bank no longer shares older history", async () => {
    store.records.set(CONNECTION_ID, freshRecord());
    mockFetch(
      accountsRoute,
      noCardsRoute,
      (url) => {
        if (url.pathname !== "/data/v1/accounts/acc123/transactions") return undefined;
        // Recent window works; anything before August is refused.
        return url.searchParams.get("from")! >= "2026-08-01"
          ? Response.json({ results: [] })
          : Response.json({ error: "sca_exceeded" }, { status: 403 });
      },
    );
    const client = new TrueLayerClient(config, store);
    const query = { dateFrom: "2026-01-01", dateTo: "2026-11-19", status: "booked" as const };

    const first = await client.listTransactions("tl-a-acc123", query);
    expect(first.historyUnavailable).toBeUndefined();
    const second = await client.listTransactions("tl-a-acc123", { ...query, continuationKey: first.continuationKey! });

    expect(second).toEqual({ transactions: [], historyUnavailable: true });
  });

  it("still fails other transaction errors", async () => {
    store.records.set(CONNECTION_ID, freshRecord());
    mockFetch(
      accountsRoute,
      noCardsRoute,
      (url) => url.pathname === "/data/v1/accounts/acc123/transactions"
        ? Response.json({ error: "provider_error" }, { status: 503 })
        : undefined,
    );
    await expect(new TrueLayerClient(config, store).listTransactions("tl-a-acc123", {
      dateFrom: "2026-11-01", dateTo: "2026-11-19", status: "booked",
    })).rejects.toMatchObject({ code: "provider_error" });
  });

  it("lists an account once when the same bank is connected twice, preferring the newer connection", async () => {
    const OLD = "88888888-8888-4888-8888-888888888888";
    store.records.set(OLD, freshRecord({ accessToken: "access-old", createdAt: "2026-08-01T10:00:00.000Z" }));
    store.records.set(CONNECTION_ID, freshRecord({ accessToken: "access-new", createdAt: "2026-11-01T10:00:00.000Z" }));
    mockFetch(
      (url, init) => {
        if (url.pathname !== "/data/v1/accounts") return undefined;
        const old = new Headers(init?.headers).get("Authorization") === "Bearer access-old";
        return Response.json({ results: [
          { account_id: old ? "oldId" : "newId", account_type: "TRANSACTION", currency: "GBP",
            account_number: { sort_code: "60-83-71", number: "12345678" } },
          // No identifiers: never merged.
          { account_id: old ? "oldBare" : "newBare", account_type: "SAVINGS", currency: "GBP" },
        ] });
      },
      noCardsRoute,
      (url) => url.pathname.endsWith("/balance") ? Response.json({ results: [{ currency: "GBP", current: 1 }] }) : undefined,
    );
    const client = new TrueLayerClient(config, store);

    expect(await client.listAccountIds()).toEqual(["tl-a-newId", "tl-a-newBare", "tl-a-oldBare"]);
    expect(JSON.stringify(await client.listAccounts())).not.toContain("12345678");
    // The hidden duplicate is still readable when asked for by ID.
    await expect(client.getBalances("tl-a-oldId")).resolves.toMatchObject({ errors: [] });
  });

  it("revokes the credential at TrueLayer before forgetting it", async () => {
    store.records.set(CONNECTION_ID, freshRecord());
    const fetchMock = mockFetch((url, init) =>
      url.pathname === "/api/delete" && init?.method === "DELETE" ? new Response(null, { status: 200 }) : undefined);

    await new TrueLayerClient(config, store).removeConnection(CONNECTION_ID);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.records.size).toBe(0);
  });
});

