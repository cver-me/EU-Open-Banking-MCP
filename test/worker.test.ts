import { createExecutionContext, env } from "cloudflare:test";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json";
import { openFinanceCache, type FinanceCache } from "../src/cache/finance-cache";
import worker from "../src/index";
import { KvTrueLayerConnectionStore } from "../src/providers/truelayer/connection-store";
import { decodeEncryptionKey, TokenCipher } from "../src/lib/crypto";

const SESSION_STORE_KEY = "enable-banking-session-ids-v1";
const INTESA_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const REVOLUT_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const INTESA_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const REVOLUT_ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const MCP_PROTOCOL_VERSION = "2026-07-28";

let providerPrivateKeyPem: string;

// Provider secrets are optional and undeclared, so they are not part of Env.
// The cache binding is optional: without it the Worker reads the banks directly.
type WorkerEnv = Omit<Env, "FINANCE_CACHE"> & Partial<Pick<Env, "FINANCE_CACHE">> & Record<string, unknown>;

const productionEnv: WorkerEnv = {
  ENABLE_BANKING_APPLICATION_ID: "00000000-0000-4000-8000-000000000000",
  ENABLE_BANKING_PRIVATE_KEY_PEM:
    "-----BEGIN PRIVATE KEY-----\nnot-used-before-authentication\n-----END PRIVATE KEY-----",
  SESSION_STORE: env.SESSION_STORE,
};

function createAuthenticatedContext(): ExecutionContext {
  const context = createExecutionContext();
  Object.defineProperty(context, "access", {
    value: { aud: "local-test-access" },
  });
  return context;
}

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  providerPrivateKeyPem = await exportPKCS8(privateKey);
});

beforeEach(async () => {
  await env.SESSION_STORE.delete(SESSION_STORE_KEY);
  // The bank-read cache outlives a request by design; each test starts with it empty.
  const cache = await openFinanceCache(env.FINANCE_CACHE as unknown as DurableObjectNamespace<FinanceCache>);
  await cache.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fetchAuthenticated(request: Request, workerEnv: WorkerEnv = env): Promise<Response> {
  return worker.fetch(
    request as Parameters<typeof worker.fetch>[0],
    workerEnv as Env,
    createAuthenticatedContext(),
  );
}

function callTool(
  id: number,
  name: string,
  args: Record<string, unknown>,
  workerEnv: WorkerEnv = env,
): Promise<Response> {
  return fetchAuthenticated(
    createModernMcpRequest(id, "tools/call", { name, arguments: args }, name),
    workerEnv,
  );
}

function createModernMcpRequest(
  id: number,
  method: string,
  params: Record<string, unknown>,
  name?: string,
): Request {
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
    Host: "localhost",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    "Mcp-Method": method,
  });
  if (name !== undefined) headers.set("Mcp-Name", name);

  return new Request("https://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": {
            name: "personal-finance-eu-mcp-test",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

function createLegacyMcpRequest(id: number, method: string): Request {
  return new Request("https://localhost/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Host: "localhost",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }),
  });
}

describe("Worker boundary", () => {
  it("serves the minimal setup page only after Access authentication", async () => {
    const response = await fetchAuthenticated(new Request("https://localhost/setup"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Connect a bank");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("does not expose arbitrary routes", async () => {
    const response = await fetchAuthenticated(new Request("https://localhost/not-a-route"));
    expect(response.status).toBe(404);
  });

  it("fails closed when Worker-level Access did not authenticate the invocation", async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://mcp.example.com/setup"),
      productionEnv as Env,
      context,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "access_required" });
  });

  it("does not trust a caller-supplied Access assertion without platform Access context", async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://mcp.example.com/setup", {
        headers: { "Cf-Access-Jwt-Assertion": "caller-controlled" },
      }),
      productionEnv as Env,
      context,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "access_required" });
  });

  it("publishes only the eight narrow, read-only finance tools", async () => {
    const response = await fetchAuthenticated(createModernMcpRequest(1, "tools/list", {}));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Mcp-Session-Id")).toBeNull();
    const payload = (await response.json()) as {
      result: {
        resultType: string;
        ttlMs: number;
        cacheScope: string;
        _meta: Record<string, unknown>;
        tools: Array<{
          name: string;
          description?: string;
          inputSchema?: {
            properties?: Record<
              string,
              { enum?: string[]; description?: string; format?: string }
            >;
          };
          outputSchema?: {
            properties?: Record<
              string,
              {
                description?: string;
                items?: {
                  properties?: Record<string, { enum?: string[]; description?: string }>;
                };
              }
            >;
          };
          annotations?: Record<string, boolean>;
        }>;
      };
    };
    expect(payload.result).toMatchObject({
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "private",
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "personal-finance-eu-mcp",
          version: packageJson.version,
        },
      },
    });
    expect(payload.result.tools.map((tool) => tool.name)).toEqual([
      "finance_list_accounts",
      "finance_get_balances",
      "finance_list_transactions",
      "finance_search_transactions",
      "finance_get_cash_flow",
      "finance_get_spending_breakdown",
      "finance_list_recurring",
      "finance_review_activity",
    ]);
    for (const tool of payload.result.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }

    const balanceTool = payload.result.tools.find(({ name }) => name === "finance_get_balances");
    expect(balanceTool?.description).toContain("alternative measurements of the same money");
    expect(balanceTool?.description).toContain("partial results");
    const balanceProperties = balanceTool?.outputSchema?.properties?.balances?.items?.properties;
    expect(balanceProperties?.balanceType).toMatchObject({
      enum: expect.arrayContaining(["closing_booked", "interim_available", "instant"]),
      description: "Normalized meaning of this balance measurement",
    });
    expect(balanceProperties).not.toHaveProperty("type");
    expect(balanceProperties?.accountId).toMatchObject({ description: expect.any(String) });
    expect(balanceProperties?.institution).toMatchObject({ description: expect.any(String) });
    expect(balanceTool?.outputSchema?.properties?.errors).toBeDefined();

    const transactionTool = payload.result.tools.find(
      ({ name }) => name === "finance_list_transactions",
    );
    expect(transactionTool?.inputSchema?.properties?.status?.enum).toEqual([
      "booked",
      "cancelled",
      "held",
      "other",
      "pending",
      "rejected",
      "scheduled",
    ]);
    expect(transactionTool?.inputSchema?.properties?.dateFrom?.format).toBe("date");
    expect(transactionTool?.inputSchema?.properties?.dateTo?.format).toBe("date");
    const transactionProperties = transactionTool?.outputSchema?.properties?.transactions?.items?.properties;
    expect(transactionProperties?.transactionDate?.description).toContain(
      "purchase date for cards",
    );
    expect(transactionProperties?.bookingDate?.description).toContain(
      "not the date the user made the payment",
    );

    for (const name of ["finance_get_cash_flow", "finance_get_spending_breakdown", "finance_list_recurring", "finance_review_activity"]) {
      const tool = payload.result.tools.find((candidate) => candidate.name === name);
      expect(tool?.description).toContain("internal_transfer");
      expect(tool?.outputSchema?.properties?.complete?.description).toContain("lower bound");
    }
    const accountsTool = payload.result.tools.find(({ name }) => name === "finance_list_accounts");
    expect(accountsTool?.outputSchema?.properties?.connections).toBeDefined();
    expect(accountsTool?.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    for (const tool of payload.result.tools) {
      expect(tool.description!.length).toBeLessThan(1_500);
      // Behavioural guidance lives in the server instructions, not in tool descriptions.
      expect(tool.description).not.toMatch(/\b(?:tell the owner|do not retry|never add them)\b/i);
    }

    expect(transactionTool?.description).toContain("for one account");
    expect(transactionTool?.description).toContain("filtered by lifecycle status");

  });

  it("tells clients how to use the tools together", async () => {
    const response = await fetchAuthenticated(createModernMcpRequest(11, "server/discover", {}));
    const payload = (await response.json()) as { result: { instructions?: string; _meta?: Record<string, unknown> } };
    expect(payload.result.instructions).toContain("Start with the analysis tools");
    expect(payload.result.instructions).toContain("Never add, net or compare amounts in different currencies");
    expect(payload.result.instructions!.length).toBeLessThan(4_096);
    expect(payload.result._meta?.["io.modelcontextprotocol/serverInfo"]).toMatchObject({
      title: "Personal finance (EU and UK banks)",
      websiteUrl: "https://github.com/cver-me/EU-Open-Banking-MCP",
    });
  });

  it("refuses MCP requests from another site's page", async () => {
    const request = createModernMcpRequest(12, "tools/list", {});
    request.headers.set("Origin", "https://attacker.example");
    const response = await fetchAuthenticated(request);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "origin_not_allowed" });
  });

  it("keeps 2025-era requests as a compatibility fallback", async () => {
    const response = await fetchAuthenticated(createLegacyMcpRequest(2, "tools/list"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const payload = parseLegacySsePayload(await response.text()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(payload.result.tools).toHaveLength(8);
  });

  it("enforces the required 2026 request headers", async () => {
    const request = createModernMcpRequest(9, "tools/list", {});
    request.headers.delete("Mcp-Method");

    const response = await fetchAuthenticated(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: -32020,
        data: { mismatch: { header: "(missing)" } },
      },
      id: 9,
    });
  });

  it("answers cash flow by transaction date and keeps transfers between own accounts out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    await env.SESSION_STORE.put(
      SESSION_STORE_KEY,
      JSON.stringify([INTESA_SESSION_ID, REVOLUT_SESSION_ID]),
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/sessions/${INTESA_SESSION_ID}`) {
        return Response.json({
          status: "AUTHORIZED",
          accounts: [INTESA_ACCOUNT_ID],
          aspsp: { name: "Intesa Sanpaolo", country: "IT" },
          psu_type: "personal",
        });
      }
      if (url.pathname === `/sessions/${REVOLUT_SESSION_ID}`) {
        return Response.json({
          status: "AUTHORIZED",
          accounts: [REVOLUT_ACCOUNT_ID],
          aspsp: { name: "Revolut", country: "LT" },
          psu_type: "personal",
        });
      }
      if (url.pathname.endsWith("/details")) {
        return Response.json({ currency: "EUR", cash_account_type: "CACC", name: "Jane Example" });
      }
      // Banks filter by booking date, so the range is padded by a week on each side.
      expect(url.searchParams.get("date_from")).toBe("2026-08-17");
      expect(url.searchParams.get("date_to")).toBe("2026-08-30");
      expect(url.searchParams.has("transaction_status")).toBe(false);
      if (url.pathname === `/accounts/${INTESA_ACCOUNT_ID}/transactions`) {
        return Response.json({
          transactions: [
            {
              transaction_amount: { amount: "-5.00", currency: "EUR" },
              credit_debit_indicator: "DBIT",
              status: "BOOK",
              transaction_date: "2026-08-22",
              booking_date: "2026-08-24",
              creditor: { name: "Licari Group S.r.l." },
            },
            {
              transaction_amount: { amount: "-50.00", currency: "EUR" },
              credit_debit_indicator: "DBIT",
              status: "BOOK",
              booking_date: "2026-08-24",
              remittance_information: ["Bonifico da Voi disposto a favore di: Somebody"],
            },
            {
              transaction_amount: { amount: "1000.00", currency: "EUR" },
              credit_debit_indicator: "CRDT",
              status: "BOOK",
              booking_date: "2026-08-24",
              debtor: { name: "Example Employer" },
            },
          ],
          continuation_key: null,
        });
      }
      if (url.pathname === `/accounts/${REVOLUT_ACCOUNT_ID}/transactions`) {
        return Response.json({
          transactions: [
            {
              transaction_amount: { amount: "0.00", currency: "EUR" },
              credit_debit_indicator: "DBIT",
              status: "BOOK",
              booking_date: "2026-08-24",
            },
            {
              transaction_amount: { amount: "-3.70", currency: "EUR" },
              credit_debit_indicator: "DBIT",
              status: "PDNG",
              booking_date: "2026-08-24",
              creditor: { name: "Bar Prima Porta" },
            },
            {
              transaction_amount: { amount: "50.00", currency: "EUR" },
              credit_debit_indicator: "CRDT",
              status: "BOOK",
              booking_date: "2026-08-25",
            },
          ],
          continuation_key: null,
        });
      }
      return Response.json({ error: "unexpected_test_request" }, { status: 500 });
    });

    const response = await callTool(
      3,
      "finance_get_cash_flow",
      { dateFrom: "2026-08-24", dateTo: "2026-08-25", groupBy: "none" },
      {
        ...env,
        ENABLE_BANKING_PRIVATE_KEY_PEM: providerPrivateKeyPem,
      },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      result: { structuredContent: Record<string, unknown> };
    };
    expect(payload.result.structuredContent).toEqual({
      totalsByCurrency: {
        EUR: {
          income: "1000.00",
          spending: "3.70",
          refunds: "0.00",
          net: "996.30",
          transfersBetweenOwnAccounts: { in: "50.00", out: "50.00" },
          transactions: 4,
        },
      },
      complete: true,
      incompleteReasons: [],
      pagesScanned: 2,
      dataAsOf: "2026-08-30T12:00:00.000Z",
    });
    // The purchase dated 22 August is outside the range even though it was booked on the 24th.
    expect(JSON.stringify(payload)).not.toContain("Licari Group");
    // Two sessions, two account details, two transaction pages.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("reads each Enable Banking session once when listing accounts and connections", async () => {
    await env.SESSION_STORE.put(SESSION_STORE_KEY, JSON.stringify([INTESA_SESSION_ID]));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/sessions/${INTESA_SESSION_ID}`) {
        return Response.json({
          status: "AUTHORIZED",
          accounts: [INTESA_ACCOUNT_ID],
          aspsp: { name: "Intesa Sanpaolo", country: "IT" },
          psu_type: "personal",
          access: { valid_until: "2099-01-01T00:00:00Z" },
        });
      }
      return Response.json({ currency: "EUR", cash_account_type: "CACC" });
    });
    const response = await callTool(9, "finance_list_accounts", {}, { ...env, ENABLE_BANKING_PRIVATE_KEY_PEM: providerPrivateKeyPem });
    const { result } = (await response.json()) as { result: { structuredContent: Record<string, unknown> } };
    expect(result.structuredContent).toMatchObject({
      accounts: [{ accountId: INTESA_ACCOUNT_ID }],
      connections: [{ provider: "enable_banking", institution: "Intesa Sanpaolo", state: "active", accountCount: 1 }],
    });
    const sessionReads = fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname === `/sessions/${INTESA_SESSION_ID}`);
    expect(sessionReads).toHaveLength(1);
  });

  it("keeps the readable accounts when one account's bank fails", async () => {
    // Only the clock: the bank retry waits on a real timer.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    await env.SESSION_STORE.put(SESSION_STORE_KEY, JSON.stringify([INTESA_SESSION_ID, REVOLUT_SESSION_ID]));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      for (const [sessionId, accountId, name] of [
        [INTESA_SESSION_ID, INTESA_ACCOUNT_ID, "Intesa Sanpaolo"],
        [REVOLUT_SESSION_ID, REVOLUT_ACCOUNT_ID, "Revolut"],
      ] as const) {
        if (url.pathname === `/sessions/${sessionId}`) {
          return Response.json({ status: "AUTHORIZED", accounts: [accountId], aspsp: { name, country: "IT" }, psu_type: "personal" });
        }
      }
      if (url.pathname.endsWith("/details")) return Response.json({ currency: "EUR", cash_account_type: "CACC" });
      if (url.pathname === `/accounts/${INTESA_ACCOUNT_ID}/transactions`) {
        return Response.json({ error: "ASPSP_ERROR" }, { status: 500 });
      }
      return Response.json({
        transactions: [{
          transaction_amount: { amount: "-8.00", currency: "EUR" },
          credit_debit_indicator: "DBIT",
          status: "BOOK",
          transaction_date: "2026-08-20",
          creditor: { name: "Cinema" },
        }],
        continuation_key: null,
      });
    });

    const response = await callTool(
      8,
      "finance_get_cash_flow",
      { dateFrom: "2026-08-01", dateTo: "2026-08-30", groupBy: "none" },
      { ...env, ENABLE_BANKING_PRIVATE_KEY_PEM: providerPrivateKeyPem },
    );
    const { result } = (await response.json()) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      totalsByCurrency: { EUR: { spending: "8.00", transactions: 1 } },
      complete: false,
      incompleteReasons: ["account_unavailable"],
      accountErrors: [{ accountId: INTESA_ACCOUNT_ID, institution: "Intesa Sanpaolo" }],
    });
  });

  it("groups spending by normalized payee with refunds and drill-down keys", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    await env.SESSION_STORE.put(SESSION_STORE_KEY, JSON.stringify([INTESA_SESSION_ID]));
    const card = (amount: string, date: string, merchant: string) => ({
      transaction_amount: { amount, currency: "EUR" },
      credit_debit_indicator: amount.startsWith("-") ? "DBIT" : "CRDT",
      status: "BOOK",
      booking_date: date,
      remittance_information: [`PAGAMENTO POS EFFETTUATO IL 20/08/2026 ALLE ORE 09:42 MEDIANTE LA CARTA 1234 XXXX XXXX XX56 PRESSO ${merchant}`],
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/sessions/${INTESA_SESSION_ID}`) {
        return Response.json({
          status: "AUTHORIZED",
          accounts: [INTESA_ACCOUNT_ID],
          aspsp: { name: "Intesa Sanpaolo", country: "IT" },
          psu_type: "personal",
        });
      }
      if (url.pathname.endsWith("/details")) return Response.json({ currency: "EUR", cash_account_type: "CACC" });
      return Response.json({
        transactions: [
          card("-20.00", "2026-08-20", "SUPERMERCATO ESEMPIO"),
          card("-15.50", "2026-08-21", "SUPERMERCATO ESEMPIO"),
          card("-60.00", "2026-08-22", "SQSP* DOMAIN#256980392 NEW YORK"),
          {
            transaction_amount: { amount: "5.50", currency: "EUR" },
            credit_debit_indicator: "CRDT",
            status: "BOOK",
            booking_date: "2026-08-23",
            remittance_information: ["Rimborso SUPERMERCATO ESEMPIO"],
          },
        ],
        continuation_key: null,
      });
    });

    const response = await callTool(
      4,
      "finance_get_spending_breakdown",
      { dateFrom: "2026-08-01", dateTo: "2026-08-30", limit: 1 },
      { ...env, ENABLE_BANKING_PRIVATE_KEY_PEM: providerPrivateKeyPem },
    );
    const payload = (await response.json()) as { result: { structuredContent: Record<string, unknown> } };
    expect(payload.result.structuredContent).toMatchObject({
      byCurrency: {
        EUR: {
          total: "95.50",
          count: 3,
          groups: [{ key: "sqsp domain new york", label: "SQSP DOMAIN NEW YORK", total: "60.00", count: 1, sharePercent: "62.8" }],
          otherGroups: { groups: 1, total: "35.50", count: 2 },
        },
      },
      complete: true,
    });

    const byPayee = await callTool(
      5,
      "finance_get_spending_breakdown",
      { dateFrom: "2026-08-01", dateTo: "2026-08-30", groupBy: "payee" },
      { ...env, ENABLE_BANKING_PRIVATE_KEY_PEM: providerPrivateKeyPem },
    );
    const groups = ((await byPayee.json()) as {
      result: { structuredContent: { byCurrency: { EUR: { groups: Array<Record<string, unknown>> } } } };
    }).result.structuredContent.byCurrency.EUR.groups;
    expect(groups[1]).toMatchObject({ key: "supermercato esempio", total: "35.50", count: 2 });

    const search = await callTool(
      6,
      "finance_search_transactions",
      { dateFrom: "2026-08-01", dateTo: "2026-08-30", payeeKey: "Supermercato Esempio" },
      { ...env, ENABLE_BANKING_PRIVATE_KEY_PEM: providerPrivateKeyPem },
    );
    const found = ((await search.json()) as {
      result: { structuredContent: { transactions: Array<Record<string, unknown>>; complete: boolean } };
    }).result.structuredContent;
    expect(found.transactions.map(({ amount, payeeKey }) => ({ amount, payeeKey }))).toEqual([
      { amount: "15.50", payeeKey: "supermercato esempio" },
      { amount: "20.00", payeeKey: "supermercato esempio" },
    ]);
    expect(found.complete).toBe(true);
  });

  it("lists active recurring payments and what is due before a date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    await env.SESSION_STORE.put(SESSION_STORE_KEY, JSON.stringify([INTESA_SESSION_ID]));
    const monthly = ["2026-05-05", "2026-06-05", "2026-07-05", "2026-08-05"];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/sessions/${INTESA_SESSION_ID}`) {
        return Response.json({
          status: "AUTHORIZED",
          accounts: [INTESA_ACCOUNT_ID],
          aspsp: { name: "Revolut", country: "IT" },
          psu_type: "personal",
        });
      }
      if (url.pathname.endsWith("/details")) return Response.json({ currency: "EUR", cash_account_type: "CACC" });
      expect(url.searchParams.get("date_from")).toBe("2026-02-22");
      return Response.json({
        transactions: monthly.map((date, index) => ({
          transaction_amount: { amount: index === 3 ? "-12.99" : "-9.99", currency: "EUR" },
          credit_debit_indicator: "DBIT",
          status: "BOOK",
          booking_date: date,
          creditor: { name: `Streamly*${index}A7F2` },
        })),
        continuation_key: null,
      });
    });

    const response = await callTool(
      7,
      "finance_list_recurring",
      { lookbackMonths: 6, upcomingUntil: "2026-10-10" },
      { ...env, ENABLE_BANKING_PRIVATE_KEY_PEM: providerPrivateKeyPem },
    );
    const payload = (await response.json()) as { result: { structuredContent: Record<string, unknown> } };
    expect(payload.result.structuredContent).toMatchObject({
      recurring: [{
        payee: "Streamly",
        cadence: "monthly",
        typicalAmount: "9.99",
        lastAmount: "12.99",
        trend: "rising",
        nextExpectedDate: "2026-09-05",
        status: "active",
        occurrences: 4,
      }],
      monthlyByCurrency: { EUR: { out: "9.99", in: "0.00" } },
      upcoming: [
        { date: "2026-09-05", payee: "Streamly", amount: "12.99" },
        { date: "2026-10-05", payee: "Streamly", amount: "12.99" },
      ],
      // Six months were asked for, but the bank's history starts in May.
      complete: false,
      incompleteReasons: ["history_starts_late"],
      dataStartsOn: "2026-05-05",
    });
  });

  it("rejects a future transaction start date before contacting Enable Banking", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await callTool(2, "finance_list_transactions", {
      accountId: "11111111-1111-4111-8111-111111111111",
      dateFrom: "9999-01-01",
      dateTo: "9999-01-02",
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("dateFrom must not be in the future");
    // The model learns today's date from the error, so its next call can be right.
    expect(text).toMatch(/today is \d{4}-\d{2}-\d{2} \(UTC\)/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects oversized tool arguments before validation or provider access", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await callTool(3, "finance_list_accounts", {
      padding: Array.from({ length: 100 }, (_, index) => index),
    });

    expect(response.status).toBe(200);
    const { result } = await response.json() as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("more than the maximum of 32 elements");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects oversized MCP request bodies before parsing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await callTool(4, "finance_search_transactions", {
      accountId: INTESA_ACCOUNT_ID,
      dateFrom: "2026-08-01",
      dateTo: "2026-08-24",
      query: "x".repeat(70 * 1024),
    });

    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Finance scan regressions", () => {
  const dateRange = { dateFrom: "2026-08-01", dateTo: "2026-08-24" };
  const transaction = {
    transaction_amount: { amount: "0.01", currency: "EUR" },
    credit_debit_indicator: "DBIT",
    status: "BOOK",
    transaction_date: "2026-08-10",
    note: "Example purchase",
  };

  async function mockPages(page: (url: URL) => Record<string, unknown>) {
    await env.SESSION_STORE.put(SESSION_STORE_KEY, JSON.stringify([INTESA_SESSION_ID]));
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/sessions/${INTESA_SESSION_ID}`) {
        return Response.json({
          status: "AUTHORIZED",
          accounts: [INTESA_ACCOUNT_ID],
          aspsp: { name: "Example Bank", country: "DE" },
          psu_type: "personal",
        });
      }
      if (url.pathname === `/accounts/${INTESA_ACCOUNT_ID}/details`) {
        return Response.json({ currency: "EUR", cash_account_type: "CACC" });
      }
      expect(url.pathname).toBe(`/accounts/${INTESA_ACCOUNT_ID}/transactions`);
      return Response.json(page(url));
    });
  }

  async function invoke(name: string, args: Record<string, unknown> = {}) {
    const response = await callTool(10, name, { ...dateRange, ...args }, {
      ...env,
      ENABLE_BANKING_PRIVATE_KEY_PEM: providerPrivateKeyPem,
    });
    return await response.json() as {
      result: {
        isError?: boolean;
        content: { type: string; text: string }[];
        structuredContent: {
          complete: boolean;
          pagesScanned: number;
          transactionsIncluded: number;
          transactions: Record<string, unknown>[];
          totalsByCurrency: Record<string, unknown>;
          nextCursor?: string;
        };
      };
    };
  }

  it("explains malformed cursors without calling the provider", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { result } = await invoke("finance_list_transactions", {
      accountId: INTESA_ACCOUNT_ID,
      cursor: "invalid-cursor",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Invalid transaction cursor");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a cursor reused with different filters before provider access", async () => {
    const fetchMock = await mockPages(() => ({ transactions: [transaction, transaction] }));
    const first = await invoke("finance_list_transactions", {
      accountId: INTESA_ACCOUNT_ID, limit: 1,
    });
    expect(first.result.structuredContent.nextCursor).toBeDefined();
    fetchMock.mockClear();
    const { result } = await invoke("finance_list_transactions", {
      accountId: INTESA_ACCOUNT_ID,
      cursor: first.result.structuredContent.nextCursor,
      status: "booked",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("does not match the current filters");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, true])("reports search completeness at the result boundary (more=%s)", async (more) => {
    await mockPages(() => ({ transactions: more ? [transaction, transaction] : [transaction] }));
    const { result } = await invoke("finance_search_transactions", {
      accountId: INTESA_ACCOUNT_ID, query: "example", limit: 1,
    });
    expect(result.structuredContent.transactions).toHaveLength(1);
    expect(result.structuredContent.complete).toBe(!more);
  });

  it.each(["finance_search_transactions", "finance_get_cash_flow"])(
    "%s stops before fetching a repeated continuation key",
    async (name) => {
      const fetchMock = await mockPages(() => ({
        transactions: [transaction], continuation_key: "repeated-page",
      }));
      const { result } = await invoke(name, { accountId: INTESA_ACCOUNT_ID, query: "example", groupBy: "none" });
      expect(result.structuredContent).toMatchObject({ complete: false, pagesScanned: 2 });
      if (name === "finance_get_cash_flow") {
        expect(result.structuredContent).toMatchObject({
          incompleteReasons: ["repeated_cursor"],
          totalsByCurrency: { EUR: { income: "0.00", spending: "0.02", net: "-0.02" } },
        });
        // Sessions, account details and two distinct provider pages, rather than 40 pages.
        expect(fetchMock).toHaveBeenCalledTimes(4);
      } else {
        expect(result.structuredContent.transactions).toHaveLength(2);
        // Search reads the account list too (session and details), then two distinct pages.
        expect(fetchMock).toHaveBeenCalledTimes(4);
      }
    },
  );

  it.each([false, true])("reports analysis completeness at 10,000 transactions (more=%s)", async (more) => {
    const fetchMock = await mockPages((url) => ({
      transactions: Array.from({ length: 5_000 }, () => transaction),
      continuation_key: url.searchParams.has("continuation_key")
        ? (more ? "third-page" : null) : "second-page",
    }));
    const { result } = await invoke("finance_get_cash_flow", { groupBy: "none" });
    expect(result.structuredContent).toMatchObject({
      complete: !more,
      incompleteReasons: more ? ["transaction_limit"] : [],
      pagesScanned: 2,
      totalsByCurrency: { EUR: { spending: "100.00", transactions: 10_000 } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("counts booked, pending and held money and reports what it had to leave out", async () => {
    const entry = (amount: string, status: string, dates: Record<string, string> = { transaction_date: "2026-08-22" }) => ({
      ...transaction, transaction_amount: { amount, currency: "EUR" }, status, transaction_date: undefined, ...dates,
    });
    await mockPages(() => ({ transactions: [
      entry("10", "BOOK", { transaction_date: "2026-08-22", booking_date: "2026-08-25" }),
      entry("2", "BOOK", { booking_date: "2026-08-22", value_date: "2026-08-20" }),
      entry("3", "HOLD"),
      entry("4", "PDNG"),
      entry("500", "OTHR"),
      entry("600", "BOOK", {}),
      ...["CNCL", "RJCT", "SCHD"].map((status) => entry("700", status)),
      { ...entry("12345678901234567890.12", "BOOK"), credit_debit_indicator: "CRDT" },
    ] }));
    const { result } = await invoke("finance_get_cash_flow", { groupBy: "none" });
    expect(result.structuredContent).toMatchObject({
      complete: false,
      incompleteReasons: ["missing_dates", "unknown_status"],
      totalsByCurrency: { EUR: {
        income: "12345678901234567890.12",
        spending: "19.00",
        net: "12345678901234567871.12",
        transactions: 5,
      } },
    });
  });

  it.each(["invoice-2", "transfer received"])("searches preserved provider metadata: %s", async (query) => {
    await mockPages(() => ({ transactions: [{
      ...transaction, reference_number: "invoice-2",
      bank_transaction_code: { description: "Transfer received" },
    }] }));
    const { result } = await invoke("finance_search_transactions", { accountId: INTESA_ACCOUNT_ID, query });
    expect(result.structuredContent.transactions).toHaveLength(1);
    expect(result.structuredContent.complete).toBe(true);
  });

  it.each([
    { dateTo: "2024-12-31", accepted: true },
    { dateTo: "2025-01-01", accepted: false },
  ])("bounds inclusive date ranges: $dateTo", async ({ dateTo, accepted }) => {
    const fetchMock = await mockPages(() => ({ transactions: [] }));
    const { result } = await invoke("finance_list_transactions", {
      accountId: INTESA_ACCOUNT_ID, dateFrom: "2024-01-01", dateTo,
    });
    if (accepted) {
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.transactions).toEqual([]);
    } else {
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("cannot exceed 366 days");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });
});

function parseLegacySsePayload(responseText: string): unknown {
  const dataLine = responseText
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  expect(dataLine).toBeDefined();
  return JSON.parse(dataLine ?? "null");
}

describe("Provider isolation", () => {
  const KEY_BASE64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
  const CONNECTION_ID = "77777777-7777-4777-8777-777777777777";

  async function invokeWithBothProviders(name: string, args: Record<string, unknown>) {
    const workerEnv = {
      ...env,
      ENABLE_BANKING_PRIVATE_KEY_PEM: providerPrivateKeyPem,
      TRUELAYER_CLIENT_ID: "personalfinance-abc123",
      TRUELAYER_CLIENT_SECRET: "test-client-secret",
      TOKEN_ENCRYPTION_KEY: KEY_BASE64,
    } as Env;
    const response = await callTool(20, name, args, workerEnv);
    return (await response.json() as { result: { isError?: boolean; structuredContent: Record<string, unknown> } }).result;
  }

  beforeEach(async () => {
    await env.SESSION_STORE.put(SESSION_STORE_KEY, JSON.stringify([INTESA_SESSION_ID]));
    await new KvTrueLayerConnectionStore(env.SESSION_STORE, new TokenCipher(decodeEncryptionKey(KEY_BASE64)))
      .put(CONNECTION_ID, {
        refreshToken: "refresh",
        accessToken: "access",
        accessTokenExpiresAt: Date.now() + 3_600_000,
        providerName: "Starling",
        createdAt: "2026-11-19T10:00:00.000Z",
      });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      // Enable Banking is down; TrueLayer works.
      if (url.hostname === "api.enablebanking.com") return Response.json({}, { status: 500 });
      if (url.pathname === "/data/v1/accounts") {
        return Response.json({ results: [{ account_id: "acc1", account_type: "TRANSACTION", display_name: "Personal", currency: "GBP" }] });
      }
      if (url.pathname === "/data/v1/cards") return Response.json({ results: [] });
      if (url.pathname === "/data/v1/accounts/acc1/transactions/pending") return Response.json({ results: [] });
      if (url.pathname === "/data/v1/accounts/acc1/transactions") {
        return Response.json({ results: [{
          transaction_id: "t1", timestamp: "2026-11-10T12:00:00Z", amount: -12.5, currency: "GBP",
          transaction_type: "DEBIT", transaction_category: "PURCHASE", transaction_classification: [],
        }] });
      }
      throw new Error(`Unexpected fetch ${url.href}`);
    });
  });
  afterEach(async () => env.SESSION_STORE.delete(`truelayer-connection-v1:${CONNECTION_ID}`));

  it("lists UK accounts and reports the failing EU provider", async () => {
    const result = await invokeWithBothProviders("finance_list_accounts", {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      accounts: [{ accountId: "tl-a-acc1", institution: "Starling", country: "GB" }],
      providerErrors: [{ provider: "enable_banking", code: "provider_error" }],
    });
  });

  it("marks cash flow incomplete when a provider is unavailable", async () => {
    const result = await invokeWithBothProviders("finance_get_cash_flow", {
      dateFrom: "2026-11-01", dateTo: "2026-11-19", groupBy: "none",
    });
    expect(result.structuredContent).toMatchObject({
      totalsByCurrency: { GBP: { income: "0.00", spending: "12.50", net: "-12.50" } },
      complete: false,
      incompleteReasons: ["provider_unavailable"],
      providerErrors: [{ provider: "enable_banking" }],
    });
  });
});

describe("Provider configurations", () => {
  const KEY_BASE64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
  const CONNECTION_ID = "12121212-1212-4121-8121-121212121212";
  const EU = () => ({
    ENABLE_BANKING_APPLICATION_ID: "00000000-0000-4000-8000-000000000000",
    ENABLE_BANKING_PRIVATE_KEY_PEM: providerPrivateKeyPem,
  });
  const UK = {
    TRUELAYER_CLIENT_ID: "personalfinance-abc123",
    TRUELAYER_CLIENT_SECRET: "test-client-secret",
    TOKEN_ENCRYPTION_KEY: KEY_BASE64,
  };
  // Only SESSION_STORE is always present; provider secrets are optional.
  const workerEnv = (vars: Record<string, string>) => ({ SESSION_STORE: env.SESSION_STORE, ...vars }) as unknown as Env;

  beforeEach(async () => {
    await env.SESSION_STORE.put(SESSION_STORE_KEY, JSON.stringify([INTESA_SESSION_ID]));
    await new KvTrueLayerConnectionStore(env.SESSION_STORE, new TokenCipher(decodeEncryptionKey(KEY_BASE64)))
      .put(CONNECTION_ID, {
        refreshToken: "refresh",
        accessToken: "access",
        accessTokenExpiresAt: Date.now() + 3_600_000,
        providerName: "Starling",
        createdAt: "2026-11-19T10:00:00.000Z",
      });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/sessions/${INTESA_SESSION_ID}`) {
        return Response.json({
          status: "AUTHORIZED",
          accounts: [INTESA_ACCOUNT_ID],
          aspsp: { name: "Intesa Sanpaolo", country: "IT" },
          psu_type: "personal",
        });
      }
      if (url.pathname === `/accounts/${INTESA_ACCOUNT_ID}/details`) {
        return Response.json({ currency: "EUR", cash_account_type: "CACC", product: "Conto" });
      }
      if (url.pathname === "/data/v1/accounts") {
        return Response.json({ results: [{ account_id: "acc1", account_type: "TRANSACTION", display_name: "Personal", currency: "GBP" }] });
      }
      if (url.pathname === "/data/v1/cards") return Response.json({ results: [] });
      throw new Error(`Unexpected fetch ${url.href}`);
    });
  });
  afterEach(async () => env.SESSION_STORE.delete(`truelayer-connection-v1:${CONNECTION_ID}`));

  it.each([
    { label: "EU only", vars: () => EU(), accounts: [INTESA_ACCOUNT_ID], sections: ["EU banks (Enable Banking)"] },
    { label: "UK only", vars: () => UK, accounts: ["tl-a-acc1"], sections: ["UK banks (TrueLayer)"] },
    { label: "both", vars: () => ({ ...EU(), ...UK }), accounts: [INTESA_ACCOUNT_ID, "tl-a-acc1"], sections: ["EU banks (Enable Banking)", "UK banks (TrueLayer)"] },
  ])("works with $label", async ({ vars, accounts, sections }) => {
    const toolResponse = await callTool(30, "finance_list_accounts", {}, workerEnv(vars()));
    const { result } = await toolResponse.json() as { result: { isError?: boolean; structuredContent: { accounts: { accountId: string }[]; providerErrors?: unknown } } };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.accounts.map(({ accountId }) => accountId)).toEqual(accounts);
    expect(result.structuredContent.providerErrors).toBeUndefined();

    const page = await (await fetchAuthenticated(new Request("https://localhost/setup?country="), workerEnv(vars()))).text();
    for (const section of ["EU banks (Enable Banking)", "UK banks (TrueLayer)"]) {
      expect(page.includes(section)).toBe(sections.includes(section));
    }
  });

  it("keeps each account's own currency and formats amounts by that currency", async () => {
    // An EU bank with a GBP account and a UK bank with a EUR account.
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/sessions/${INTESA_SESSION_ID}`) {
        return Response.json({ status: "AUTHORIZED", accounts: [INTESA_ACCOUNT_ID], aspsp: { name: "Revolut", country: "IT" }, psu_type: "personal" });
      }
      if (url.pathname === `/accounts/${INTESA_ACCOUNT_ID}/details`) return Response.json({ currency: "GBP", cash_account_type: "CACC" });
      if (url.pathname === `/accounts/${INTESA_ACCOUNT_ID}/balances`) {
        return Response.json({ balances: [{ name: "Available", balance_amount: { amount: "250", currency: "GBP" }, balance_type: "ITAV" }] });
      }
      if (url.pathname === "/data/v1/accounts") return Response.json({ results: [{ account_id: "eur1", account_type: "TRANSACTION", display_name: "Euro", currency: "EUR" }] });
      if (url.pathname === "/data/v1/cards") return Response.json({ results: [] });
      if (url.pathname === "/data/v1/accounts/eur1/balance") return Response.json({ results: [{ currency: "EUR", current: 12.5 }] });
      throw new Error(`Unexpected fetch ${url.href}`);
    });
    const vars = workerEnv({ ...EU(), ...UK });

    const accounts = await (await callTool(33, "finance_list_accounts", {}, vars)).json() as { result: { structuredContent: { accounts: { accountId: string; country: string; currency: string }[] } } };
    expect(accounts.result.structuredContent.accounts.map(({ country, currency }) => ({ country, currency }))).toEqual([
      { country: "IT", currency: "GBP" },
      { country: "GB", currency: "EUR" },
    ]);

    const balances = await (await callTool(34, "finance_get_balances", {}, vars)).json() as { result: { structuredContent: { balances: { currency: string; amount: string }[] } } };
    expect(balances.result.structuredContent.balances.map(({ currency, amount }) => ({ currency, amount }))).toEqual([
      { currency: "GBP", amount: "250.00" },
      { currency: "EUR", amount: "12.50" },
    ]);
  });

  it("explains setup when no provider is configured", async () => {
    const toolResponse = await callTool(31, "finance_list_accounts", {}, workerEnv({}));
    const { result } = await toolResponse.json() as { result: { isError?: boolean; content: { text: string }[] } };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Open /setup");

    const page = await fetchAuthenticated(new Request("https://localhost/setup"), workerEnv({}));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("No bank-data provider is configured");
  });

  it("refuses to start with a partly configured provider", async () => {
    const response = await callTool(32, "finance_list_accounts", {}, workerEnv({ ...EU(), TRUELAYER_CLIENT_ID: "abc" }));
    expect(response.status).toBe(503);
  });
});
