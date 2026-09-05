import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import { EnableBankingClient } from "../src/providers/enable-banking/client";
import type { SessionStore } from "../src/session-store";

const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_SESSION_ID = "55555555-5555-4555-8555-555555555555";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";

let config: AppConfig;
let providerPublicKey: CryptoKey;
let sessions: SessionStore;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  providerPublicKey = publicKey;
  config = {
    enableBanking: {
      applicationId: "00000000-0000-4000-8000-000000000000",
      privateKeyPem: await exportPKCS8(privateKey),
    },
  };
});

beforeEach(() => {
  sessions = {
    list: vi.fn(async () => [SESSION_ID]),
    add: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
});

afterEach(() => vi.restoreAllMocks());

describe("EnableBankingClient", () => {
  it.each(["same", "different", "absent"])(
    "matches accounts across sessions only using primary identity hashes (%s)",
    async (identity) => {
      sessions.list = vi.fn(async () => [SESSION_ID, SECOND_SESSION_ID]);
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.startsWith("/sessions/")) {
          const second = path.endsWith(SECOND_SESSION_ID);
          const accountId = second ? SECOND_ACCOUNT_ID : ACCOUNT_ID;
          return Response.json({
            status: "AUTHORIZED",
            accounts: [accountId],
            accounts_data: [{
              uid: accountId,
              ...(identity === "absent" ? {} : {
                identification_hash: second && identity === "different" ? "second-primary" : "first-primary",
              }),
              identification_hashes: ["shared-secondary-fuzzy-hash"],
            }],
            aspsp: { name: "Example Bank", country: "DE" },
            psu_type: "personal",
          });
        }
        if (path.endsWith("/details")) {
          return Response.json({ name: "Same Holder", currency: "EUR", cash_account_type: "CACC" });
        }
        return Response.json({ balances: [] });
      });
      const client = new EnableBankingClient(config, sessions);
      const accountIds = await client.listAccountIds();
      expect(accountIds).toEqual(identity === "same" ? [ACCOUNT_ID] : [ACCOUNT_ID, SECOND_ACCOUNT_ID]);
      const summaries = await client.listAccounts();
      expect(summaries).toHaveLength(accountIds.length);
      expect(JSON.stringify(summaries)).not.toContain("primary");
      expect(JSON.stringify(summaries)).not.toContain("hash");
      fetchMock.mockClear();
      await client.getBalances();
      expect(fetchMock).toHaveBeenCalledTimes(accountIds.length);
      // An explicitly selected alias is still authorized, even if all-account reads deduplicate it.
      await expect(client.getBalances(SECOND_ACCOUNT_ID)).resolves.toEqual({ balances: [], errors: [] });
    },
  );

  it("preserves account descriptions and omits blank optional names", async () => {
    mockProvider(async () => Response.json({
      name: "  ", product: null, details: " Household account ", currency: "EUR", cash_account_type: "CACC",
    }));
    const [account] = await new EnableBankingClient(config, sessions).listAccounts();
    expect(account).toMatchObject({ description: "Household account" });
    expect(account).not.toHaveProperty("name");
    expect(account).not.toHaveProperty("product");
  });

  it("preserves a balance label and bank timestamp independently of fetch time", async () => {
    mockProvider(async () => Response.json({ balances: [{
      name: "Credit used", balance_type: "OTHR",
      balance_amount: { amount: "-12.34", currency: "EUR" },
      reference_date: "2026-08-01", last_change_date_time: "2026-08-01T13:15:00+02:00",
    }] }));
    const result = await new EnableBankingClient(config, sessions).getBalances(ACCOUNT_ID);
    expect(result.balances[0]).toMatchObject({
      amount: "-12.34", balanceType: "other", label: "Credit used",
      referenceDate: "2026-08-01", lastChangedAt: "2026-08-01T13:15:00+02:00",
    });
  });

  it("preserves transaction classification and payment references without exposing party identifiers", async () => {
    mockProvider(async () => Response.json({ transactions: [{
      transaction_amount: { amount: "-10.50", currency: "EUR" },
      credit_debit_indicator: "CRDT", status: "BOOK",
      debtor: { name: "Sender", postal_address: { address_line: ["private-address"] } },
      creditor: { name: "Account owner" },
      debtor_account: { iban: "private-iban" },
      entry_reference: "entry-1", reference_number: "invoice-2",
      bank_transaction_code: { code: "PMNT", sub_code: "RCDT", description: "Transfer received" },
      transaction_id: "unstable-detail-token",
    }] }));
    const page = await new EnableBankingClient(config, sessions).listTransactions(ACCOUNT_ID, {});
    expect(page.transactions[0]).toEqual({
      accountId: ACCOUNT_ID, amount: "10.50", currency: "EUR", direction: "credit", status: "booked",
      counterparty: "Sender", reference: "entry-1", paymentReference: "invoice-2",
      bankTransactionDescription: "Transfer received",
    });
    expect(JSON.stringify(page)).not.toMatch(/private-|unstable-detail/);
  });

  it("enforces requested status locally while retaining the continuation key", async () => {
    mockProvider(async () => Response.json({
      transactions: ["BOOK", "PDNG", "CNCL"].map((status) => ({
        transaction_amount: { amount: "10", currency: "EUR" }, credit_debit_indicator: "DBIT", status,
      })),
      continuation_key: "next-status-page",
    }));
    const page = await new EnableBankingClient(config, sessions).listTransactions(ACCOUNT_ID, { status: "pending" });
    expect(page.transactions.map(({ status }) => status)).toEqual(["pending"]);
    expect(page.continuationKey).toBe("next-status-page");
  });

  it("signs once across concurrent provider calls, refreshes before expiry, and isolates clients", async () => {
    const signSpy = vi.spyOn(crypto.subtle, "sign");
    mockProvider(async () => Response.json({ balances: [] }));
    const now = Date.now();
    const timeSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const client = new EnableBankingClient(config, sessions);
    await Promise.all([client.getBalances(ACCOUNT_ID), client.getBalances(ACCOUNT_ID)]);
    expect(signSpy).toHaveBeenCalledTimes(1);
    await client.getBalances(ACCOUNT_ID);
    expect(signSpy).toHaveBeenCalledTimes(1);
    timeSpy.mockReturnValue(now + 3_540_000);
    await client.getBalances(ACCOUNT_ID);
    expect(signSpy).toHaveBeenCalledTimes(2);
    await new EnableBankingClient(config, sessions).getBalances(ACCOUNT_ID);
    expect(signSpy).toHaveBeenCalledTimes(3);
  });

  it("treats a null optional balance reference date as absent", async () => {
    mockProvider(async () => Response.json({ balances: [{
      name: "Available balance",
      balance_amount: { amount: "12.34", currency: "EUR" },
      balance_type: "ITAV",
      reference_date: null,
    }] }));
    const result = await new EnableBankingClient(config, sessions).getBalances(ACCOUNT_ID);
    expect(result.errors).toEqual([]);
    expect(result.balances).toEqual([expect.objectContaining({ amount: "12.34" })]);
    expect(result.balances[0]).not.toHaveProperty("referenceDate");
  });

  it("reports invalid balance data with safe schema diagnostics", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockProvider(async () => Response.json({ balances: [{
      name: "sensitive-bank-label",
      balance_amount: { amount: "sensitive-invalid-amount", currency: "EUR" },
      balance_type: "ITAV",
    }] }));
    const result = await new EnableBankingClient(config, sessions).getBalances();
    expect(result.errors).toEqual([expect.objectContaining({
      code: "provider_response_invalid",
      message: "Enable Banking returned unsupported balance data.",
    })]);
    expect(errorSpy).toHaveBeenCalledOnce();
    const log = String(errorSpy.mock.calls[0]?.[0]);
    expect(log).not.toContain("sensitive");
    expect(JSON.parse(log)).toEqual({
      message: "Enable Banking response validation failed",
      operation: "get_account_balances",
      issueCount: 1,
      issues: [{ code: "invalid_format", path: "balances.0.balance_amount.amount" }],
    });
  });

  it("discovers the account through its session and builds the documented JWT", async () => {
    const fetchMock = mockProvider(async (url) => {
      expect(url.pathname).toBe(`/accounts/${ACCOUNT_ID}/transactions`);
      return Response.json({
        transactions: [
          {
            transaction_amount: { amount: "-12.40", currency: "EUR" },
            credit_debit_indicator: "DBIT",
            status: "BOOK",
            transaction_date: "2026-08-18",
            booking_date: "2026-08-20",
            creditor: { name: "Example Market" },
            remittance_information: ["Weekly groceries"],
            transaction_id: "provider-transaction-id-not-exposed",
          },
        ],
      });
    });

    const result = await new EnableBankingClient(config, sessions).listTransactions(ACCOUNT_ID, {
      dateFrom: "2026-08-01",
      dateTo: "2026-08-23",
      status: "booked",
    });

    expect(result.transactions).toEqual([
      {
        accountId: ACCOUNT_ID,
        amount: "12.40",
        currency: "EUR",
        direction: "debit",
        status: "booked",
        transactionDate: "2026-08-18",
        bookingDate: "2026-08-20",
        counterparty: "Example Market",
        description: "Weekly groceries",
      },
    ]);

    const transactionCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/transactions"),
    );
    const requestUrl = new URL(String(transactionCall?.[0]));
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
      date_from: "2026-08-01",
      date_to: "2026-08-23",
      transaction_status: "BOOK",
    });
    const requestHeaders = new Headers(transactionCall?.[1]?.headers);
    const authorization = requestHeaders.get("Authorization");
    expect(authorization).toMatch(/^Bearer ey/);
    const { payload, protectedHeader } = await jwtVerify(
      authorization?.slice("Bearer ".length) ?? "",
      providerPublicKey,
      { algorithms: ["RS256"], issuer: "enablebanking.com", audience: "api.enablebanking.com" },
    );
    expect(protectedHeader).toMatchObject({
      alg: "RS256",
      typ: "JWT",
      kid: config.enableBanking.applicationId,
    });
    expect(payload.exp).toBe((payload.iat ?? 0) + 3_600);
    expect(JSON.stringify(result)).not.toContain("provider-transaction-id-not-exposed");
  });

  it("accepts the documented null continuation key on the final page", async () => {
    mockProvider(async () => Response.json({ transactions: [], continuation_key: null }));
    await expect(
      new EnableBankingClient(config, sessions).listTransactions(ACCOUNT_ID, {}),
    ).resolves.toEqual({ transactions: [] });
  });

  it("treats null optional transaction fields as absent", async () => {
    mockProvider(async () =>
      Response.json({
        transactions: [
          {
            transaction_amount: { amount: "12.99", currency: "EUR" },
            credit_debit_indicator: "DBIT",
            status: "BOOK",
            booking_date: null,
            value_date: null,
            transaction_date: null,
            creditor: null,
            debtor: { name: null },
            merchant_category_code: null,
            remittance_information: null,
            note: null,
            entry_reference: null,
          },
        ],
        continuation_key: null,
      }),
    );

    await expect(
      new EnableBankingClient(config, sessions).listTransactions(ACCOUNT_ID, {}),
    ).resolves.toEqual({
      transactions: [
        {
          accountId: ACCOUNT_ID,
          amount: "12.99",
          currency: "EUR",
          direction: "debit",
          status: "booked",
        },
      ],
    });
  });

  it("logs transaction schema issue metadata without provider values", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sensitiveMarker = "must-not-appear-in-logs";
    mockProvider(async () =>
      Response.json({
        transactions: [
          {
            transaction_amount: { amount: "12.99", currency: "EUR" },
            credit_debit_indicator: "DBIT",
            status: "BOOK",
            merchant_category_code: { raw: sensitiveMarker },
          },
        ],
      }),
    );

    await expect(
      new EnableBankingClient(config, sessions).listTransactions(ACCOUNT_ID, {}),
    ).rejects.toThrow("unsupported transaction data");

    expect(errorSpy).toHaveBeenCalledOnce();
    const log = String(errorSpy.mock.calls[0]?.[0]);
    expect(log).not.toContain(sensitiveMarker);
    expect(JSON.parse(log)).toEqual({
      message: "Enable Banking response validation failed",
      operation: "get_account_transactions",
      issueCount: 1,
      issues: [{ code: "invalid_type", path: "transactions.0.merchant_category_code" }],
    });
  });

  it("normalizes every Enable Banking transaction status", async () => {
    mockProvider(async () =>
      Response.json({
        transactions: ["BOOK", "CNCL", "HOLD", "OTHR", "PDNG", "RJCT", "SCHD"].map(
          (status) => ({
            transaction_amount: { amount: "1.00", currency: "EUR" },
            credit_debit_indicator: "CRDT",
            status,
          }),
        ),
      }),
    );

    const result = await new EnableBankingClient(config, sessions).listTransactions(ACCOUNT_ID, {});
    expect(result.transactions.map(({ status }) => status)).toEqual([
      "booked",
      "cancelled",
      "held",
      "other",
      "pending",
      "rejected",
      "scheduled",
    ]);
  });

  it("returns bank context with documented account details and balances", async () => {
    const fetchMock = mockProvider(async (url) => {
      if (url.pathname.endsWith("/details")) {
        return Response.json({
          name: "Personal account",
          product: "Current account",
          usage: "PRIV",
          cash_account_type: "CACC",
          currency: "EUR",
        });
      }
      return Response.json({
        balances: ["CLAV", "CLBD", "FWAV", "INFO", "ITAV", "ITBD", "OPAV", "OPBD", "OTHR", "PRCD", "VALU", "XPCD"].map(
          (balance_type) => ({
            name: "Balance",
            balance_amount: { amount: "123.45", currency: "EUR" },
            balance_type,
            reference_date: "2026-08-23",
          }),
        ),
      });
    });

    await expect(new EnableBankingClient(config, sessions).listAccounts()).resolves.toEqual([
      {
        accountId: ACCOUNT_ID,
        institution: "Example Bank",
        country: "IT",
        name: "Personal account",
        product: "Current account",
        usage: "personal",
        cashAccountType: "current",
        currency: "EUR",
      },
    ]);
    const result = await new EnableBankingClient(config, sessions).getBalances(ACCOUNT_ID);
    expect(result.errors).toEqual([]);
    expect(result.balances.map(({ balanceType }) => balanceType)).toEqual([
      "closing_available",
      "closing_booked",
      "forward_available",
      "informational",
      "interim_available",
      "interim_booked",
      "opening_available",
      "opening_booked",
      "other",
      "previously_closed_booked",
      "value_date",
      "instant",
    ]);
    expect(result.balances[0]).toEqual({
      accountId: ACCOUNT_ID,
      institution: "Example Bank",
      country: "IT",
      amount: "123.45",
      currency: "EUR",
      balanceType: "closing_available",
      label: "Balance",
      referenceDate: "2026-08-23",
    });
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toContain(
      `/accounts/${ACCOUNT_ID}/balances`,
    );
  });

  it("forwards online PSU context only to account-data requests", async () => {
    const fetchMock = mockProvider(async () => Response.json({ balances: [] }));
    const client = new EnableBankingClient(config, sessions, [
      ["Psu-Ip-Address", "203.0.113.7"],
      ["Psu-User-Agent", "Personal Finance MCP Test"],
    ]);

    await client.getBalances(ACCOUNT_ID);

    const sessionCall = fetchMock.mock.calls.find(([input]) =>
      new URL(String(input)).pathname.startsWith("/sessions/"),
    );
    const balanceCall = fetchMock.mock.calls.find(([input]) =>
      new URL(String(input)).pathname.endsWith("/balances"),
    );
    const sessionHeaders = new Headers(sessionCall?.[1]?.headers);
    const balanceHeaders = new Headers(balanceCall?.[1]?.headers);
    expect(sessionHeaders.get("Psu-Ip-Address")).toBeNull();
    expect(balanceHeaders.get("Psu-Ip-Address")).toBe("203.0.113.7");
    expect(balanceHeaders.get("Psu-User-Agent")).toBe("Personal Finance MCP Test");
    expect(balanceHeaders.get("Psu-Accept")).toBeNull();
  });

  it("uses manual redirect handling and rejects redirects without forwarding signed headers", async () => {
    const fetchMock = mockProvider(async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://untrusted.example/collect" },
      }),
    );

    await expect(
      new EnableBankingClient(config, sessions).getBalances(ACCOUNT_ID),
    ).rejects.toThrow("unexpected redirect");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.redirect).toBe("manual");
    }
  });

  it("logs only metadata for runtime fetch errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sensitiveToken = "abcdefghijklmnopqrstuvwxyz0123456789";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError(
        `Network failure for https://api.enablebanking.com/sessions/${SESSION_ID} ${sensitiveToken}`,
      ),
    );

    await expect(
      new EnableBankingClient(config, sessions).listTransactions(ACCOUNT_ID, {}),
    ).rejects.toThrow(TypeError);

    expect(errorSpy).toHaveBeenCalledOnce();
    const log = String(errorSpy.mock.calls[0]?.[0]);
    expect(log).not.toContain(SESSION_ID);
    expect(log).not.toContain(sensitiveToken);
    expect(JSON.parse(log)).toEqual({
      message: "Enable Banking fetch threw",
      operation: "session",
      errorType: "TypeError",
    });
  });

  it("returns partial all-account balances and continues after one bank error", async () => {
    sessions = {
      list: vi.fn(async () => [SESSION_ID, SECOND_SESSION_ID]),
      add: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/sessions/${SESSION_ID}`) {
        return Response.json({
          status: "AUTHORIZED",
          accounts: [ACCOUNT_ID],
          accounts_data: [],
          aspsp: { name: "Example Bank", country: "IT" },
          psu_type: "personal",
        });
      }
      if (url.pathname === `/sessions/${SECOND_SESSION_ID}`) {
        return Response.json({
          status: "AUTHORIZED",
          accounts: [SECOND_ACCOUNT_ID],
          accounts_data: [],
          aspsp: { name: "Second Bank", country: "IT" },
          psu_type: "personal",
        });
      }
      if (url.pathname === `/accounts/${ACCOUNT_ID}/balances`) {
        return Response.json(
          { error: "ASPSP_RATE_LIMIT_EXCEEDED" },
          { status: 429 },
        );
      }
      expect(url.pathname).toBe(`/accounts/${SECOND_ACCOUNT_ID}/balances`);
      return Response.json({
        balances: [
          {
            name: "Available balance",
            balance_amount: { amount: "50.00", currency: "EUR" },
            balance_type: "ITAV",
            reference_date: "2026-08-23",
          },
        ],
      });
    });

    const result = await new EnableBankingClient(config, sessions).getBalances();

    expect(result.balances).toEqual([
      {
        accountId: SECOND_ACCOUNT_ID,
        institution: "Second Bank",
        country: "IT",
        amount: "50.00",
        currency: "EUR",
        balanceType: "interim_available",
        label: "Available balance",
        referenceDate: "2026-08-23",
      },
    ]);
    expect(result.errors).toEqual([
      {
        accountId: ACCOUNT_ID,
        institution: "Example Bank",
        country: "IT",
        code: "aspsp_rate_limited",
        message: "The bank rate-limited account data access. Do not retry immediately.",
      },
    ]);
    const balancePaths = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)).pathname)
      .filter((path) => path.endsWith("/balances"));
    expect(balancePaths).toHaveLength(2);
    expect(balancePaths).toEqual(
      expect.arrayContaining([
        `/accounts/${ACCOUNT_ID}/balances`,
        `/accounts/${SECOND_ACCOUNT_ID}/balances`,
      ]),
    );
  });

  it("stops requesting more accounts from a rate-limited bank", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/sessions/${SESSION_ID}`) {
        return Response.json({
          status: "AUTHORIZED",
          accounts: [ACCOUNT_ID, SECOND_ACCOUNT_ID],
          accounts_data: [],
          aspsp: { name: "Example Bank", country: "IT" },
          psu_type: "personal",
        });
      }
      expect(url.pathname).toBe(`/accounts/${ACCOUNT_ID}/balances`);
      return Response.json({ error: "ASPSP_RATE_LIMIT_EXCEEDED" }, { status: 429 });
    });

    const result = await new EnableBankingClient(config, sessions).getBalances();

    expect(result.balances).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({ accountId: ACCOUNT_ID, code: "aspsp_rate_limited" }),
      expect.objectContaining({ accountId: SECOND_ACCOUNT_ID, code: "aspsp_rate_limited" }),
    ]);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        new URL(String(input)).pathname.endsWith("/balances"),
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["ORGA", "LOAN", "professional", "loan"],
    ["PRIV", "SVGS", "personal", "savings"],
  ])(
    "normalizes account usage %s and account type %s",
    async (usage, cashAccountType, expectedUsage, expectedAccountType) => {
      mockProvider(async () =>
        Response.json({ usage, cash_account_type: cashAccountType, currency: "EUR" }),
      );
      const [account] = await new EnableBankingClient(config, sessions).listAccounts();
      expect(account).toMatchObject({ usage: expectedUsage, cashAccountType: expectedAccountType });
    },
  );

  it("rejects an account ID that is not present in an active session", async () => {
    const fetchMock = mockProvider(async () => Response.json({ balances: [] }));
    await expect(
      new EnableBankingClient(config, sessions).getBalances(
        "33333333-3333-4333-8333-333333333333",
      ),
    ).rejects.toThrow("Unknown or inactive account ID");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized account list before making account requests", async () => {
    const accountIds = Array.from({ length: 21 }, (_, index) => accountUuid(index));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(`/sessions/${SESSION_ID}`);
      return Response.json({
        status: "AUTHORIZED",
        accounts: accountIds,
        aspsp: { name: "Example Bank", country: "IT" },
        psu_type: "personal",
      });
    });

    await expect(new EnableBankingClient(config, sessions).listAccounts()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized aggregate before making account requests", async () => {
    sessions = {
      list: vi.fn(async () => [SESSION_ID, SECOND_SESSION_ID]),
      add: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const firstSessionAccounts = Array.from({ length: 20 }, (_, index) => accountUuid(index));
    const secondSessionAccount = accountUuid(20);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/sessions/${SESSION_ID}`) {
        return Response.json({
          status: "AUTHORIZED",
          accounts: firstSessionAccounts,
          aspsp: { name: "Example Bank", country: "IT" },
          psu_type: "personal",
        });
      }
      if (url.pathname === `/sessions/${SECOND_SESSION_ID}`) {
        return Response.json({
          status: "AUTHORIZED",
          accounts: [secondSessionAccount],
          aspsp: { name: "Second Bank", country: "IT" },
          psu_type: "personal",
        });
      }
      return Response.json({ currency: "EUR", cash_account_type: "CACC" });
    });

    await expect(new EnableBankingClient(config, sessions).listAccounts()).rejects.toThrow(
      "too many accounts",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [422, "EXPIRED_SESSION", "authorization has expired"],
    [422, "WRONG_CONTINUATION_KEY", "pagination cursor is no longer valid"],
    [408, "ASPSP_TIMEOUT", "timed out"],
    [429, "ASPSP_RATE_LIMIT_EXCEEDED", "rate-limited"],
    [403, "ACCESS_DENIED", "denied access"],
  ])("maps actionable provider error %s/%s", async (status, error, expectedMessage) => {
    mockProvider(async () =>
      Response.json({ message: "provider detail", code: status, error }, { status }),
    );
    await expect(
      new EnableBankingClient(config, sessions).getBalances(ACCOUNT_ID),
    ).rejects.toThrow(expectedMessage);
  });

  it("logs unknown provider error text as a safe normalized code", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sensitiveMarker = "account-identifier-must-not-be-logged";
    mockProvider(async () => Response.json({ error: sensitiveMarker }, { status: 500 }));

    await expect(
      new EnableBankingClient(config, sessions).getBalances(ACCOUNT_ID),
    ).rejects.toThrow("could not complete");

    expect(warnSpy).toHaveBeenCalledOnce();
    const log = String(warnSpy.mock.calls[0]?.[0]);
    expect(log).not.toContain(sensitiveMarker);
    expect(JSON.parse(log)).toMatchObject({
      message: "Enable Banking request failed",
      operation: "get_account_balances",
      status: 500,
      errorCode: "unknown",
    });
  });

  it("starts authorization with the bank maximum consent validity and provider HTTPS URL", async () => {
    const fetchMock = mockAuthorization("https://bank.example/authorize?sessionid=example");

    await expect(
      new EnableBankingClient(config, sessions).startAuthorization(
        { institution: "Example Bank", country: "IT", psuType: "personal" },
        "https://finance.example/callback",
        "55555555-5555-4555-8555-555555555555",
      ),
    ).resolves.toBe("https://bank.example/authorize?sessionid=example");

    const authCall = fetchMock.mock.calls.find(([input]) => new URL(String(input)).pathname === "/auth");
    const body = JSON.parse(String(authCall?.[1]?.body)) as {
      access: { balances: boolean; transactions: boolean; valid_until: string };
      redirect_url: string;
      psu_type: string;
    };
    expect(body).toMatchObject({
      access: { balances: true, transactions: true },
      redirect_url: "https://finance.example/callback",
      psu_type: "personal",
    });
    expect(Date.parse(body.access.valid_until)).toBeGreaterThan(Date.now());
  });

  it("rejects a non-HTTPS provider authorization URL", async () => {
    mockAuthorization("http://bank.example/authorize?sessionid=example");

    await expect(
      new EnableBankingClient(config, sessions).startAuthorization(
        { institution: "Example Bank", country: "IT", psuType: "personal" },
        "https://finance.example/callback",
        "55555555-5555-4555-8555-555555555555",
      ),
    ).rejects.toThrow("invalid authorization URL");
  });

  it("exchanges the callback code and persists only the session ID", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        session_id: SESSION_ID,
        aspsp: { name: "Example Bank", country: "IT" },
        psu_type: "personal",
        accounts: [{ uid: ACCOUNT_ID }],
      }),
    );
    await expect(
      new EnableBankingClient(config, sessions).completeAuthorization("one-time-code"),
    ).resolves.toBe(SESSION_ID);
    expect(sessions.add).toHaveBeenCalledWith(SESSION_ID);
  });

  it("closes a configured session before removing it locally", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ message: "OK" }),
    );
    await new EnableBankingClient(config, sessions).removeConnection(SESSION_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe(
      `/sessions/${SESSION_ID}`,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
    expect(sessions.remove).toHaveBeenCalledWith(SESSION_ID);
  });
});

function mockProvider(
  handler: (url: URL, init: RequestInit | undefined) => Promise<Response>,
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === `/sessions/${SESSION_ID}`) {
      return Response.json({
        status: "AUTHORIZED",
        accounts: [ACCOUNT_ID],
        accounts_data: [],
        aspsp: { name: "Example Bank", country: "IT" },
        psu_type: "personal",
      });
    }
    return handler(url, init);
  });
}

function mockAuthorization(authorizationUrl: string) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/aspsps") {
      return Response.json({
        aspsps: [
          {
            name: "Example Bank",
            country: "IT",
            maximum_consent_validity: 7_776_000,
          },
        ],
      });
    }
    expect(url.pathname).toBe("/auth");
    return Response.json({
      url: authorizationUrl,
      authorization_id: "44444444-4444-4444-8444-444444444444",
    });
  });
}

function accountUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}
