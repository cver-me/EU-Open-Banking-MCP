import { createExecutionContext, env } from "cloudflare:test";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const SESSION_STORE_KEY = "enable-banking-session-ids-v1";
const INTESA_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const REVOLUT_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const INTESA_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const REVOLUT_ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const MCP_PROTOCOL_VERSION = "2026-07-28";

let providerPrivateKeyPem: string;

const productionEnv: Env = {
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

beforeEach(async () => env.SESSION_STORE.delete(SESSION_STORE_KEY));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fetchAuthenticated(request: Request, workerEnv: Env = env): Promise<Response> {
  return worker.fetch(
    request as Parameters<typeof worker.fetch>[0],
    workerEnv,
    createAuthenticatedContext(),
  );
}

function callTool(
  id: number,
  name: string,
  args: Record<string, unknown>,
  workerEnv: Env = env,
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
      productionEnv,
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
      productionEnv,
      context,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "access_required" });
  });

  it("publishes only the six narrow, read-only finance tools", async () => {
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
          version: "0.1.0",
        },
      },
    });
    expect(payload.result.tools.map((tool) => tool.name)).toEqual([
      "finance_list_accounts",
      "finance_get_balances",
      "finance_get_spending",
      "finance_list_transactions",
      "finance_search_transactions",
      "finance_summarize_cash_flow",
    ]);
    for (const tool of payload.result.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }

    const balanceTool = payload.result.tools.find(({ name }) => name === "finance_get_balances");
    expect(balanceTool?.description).toContain("never add them together");
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
      "when the payment or transaction occurred",
    );
    expect(transactionProperties?.bookingDate?.description).toContain(
      "not the date the user made the payment",
    );

    const spendingTool = payload.result.tools.find(({ name }) => name === "finance_get_spending");
    expect(spendingTool?.description).toContain("debit spending for a date range");
    expect(spendingTool?.description).toContain("includes pending transactions");
    expect(spendingTool?.outputSchema?.properties).not.toHaveProperty("dateCoverageComplete");
    expect(spendingTool?.outputSchema?.properties?.complete?.description).toContain(
      "fully determined",
    );

    expect(transactionTool?.description).toContain("for one account");
    expect(transactionTool?.description).toContain("filtered by lifecycle status");

    const cashFlowTool = payload.result.tools.find(
      ({ name }) => name === "finance_summarize_cash_flow",
    );
    expect(cashFlowTool?.description).toContain(
      "booked credit, debit, and net accounting totals",
    );
  });

  it("keeps 2025-era requests as a compatibility fallback", async () => {
    const response = await fetchAuthenticated(createLegacyMcpRequest(2, "tools/list"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const payload = parseLegacySsePayload(await response.text()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(payload.result.tools).toHaveLength(6);
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

  it("answers spending by occurrence date and includes bank-ranged pending activity", async () => {
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
          ],
          continuation_key: null,
        });
      }
      return Response.json({ error: "unexpected_test_request" }, { status: 500 });
    });

    const response = await callTool(
      3,
      "finance_get_spending",
      { dateFrom: "2026-08-24", dateTo: "2026-08-24" },
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
      totalsByCurrency: { EUR: "3.7" },
      transactions: [
        {
          accountId: REVOLUT_ACCOUNT_ID,
          amount: "3.70",
          currency: "EUR",
          direction: "debit",
          status: "pending",
          bookingDate: "2026-08-24",
          counterparty: "Bar Prima Porta",
        },
      ],
      transactionsIncluded: 1,
      transactionDetailsComplete: true,
      complete: false,
      pagesScanned: 2,
    });
    expect(JSON.stringify(payload)).not.toContain("Licari Group");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("includes a booking-dated debit as inferred spending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    await env.SESSION_STORE.put(SESSION_STORE_KEY, JSON.stringify([INTESA_SESSION_ID]));
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
      expect(url.pathname).toBe(`/accounts/${INTESA_ACCOUNT_ID}/transactions`);
      expect(url.searchParams.get("date_from")).toBe("2026-08-17");
      expect(url.searchParams.get("date_to")).toBe("2026-08-30");
      return Response.json({
        transactions: [
          {
            transaction_amount: { amount: "-5.00", currency: "EUR" },
            credit_debit_indicator: "DBIT",
            status: "BOOK",
            booking_date: "2026-08-24",
          },
        ],
        continuation_key: null,
      });
    });

    const response = await callTool(
      4,
      "finance_get_spending",
      { dateFrom: "2026-08-24", dateTo: "2026-08-24" },
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
      totalsByCurrency: { EUR: "5" },
      transactions: [
        {
          accountId: INTESA_ACCOUNT_ID,
          amount: "5.00",
          currency: "EUR",
          direction: "debit",
          status: "booked",
          bookingDate: "2026-08-24",
        },
      ],
      transactionsIncluded: 1,
      transactionDetailsComplete: true,
      complete: false,
      pagesScanned: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the earlier booking or value date when transaction date is absent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    await env.SESSION_STORE.put(SESSION_STORE_KEY, JSON.stringify([INTESA_SESSION_ID]));
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
      expect(url.pathname).toBe(`/accounts/${INTESA_ACCOUNT_ID}/transactions`);
      return Response.json({
        transactions: [
          {
            transaction_amount: { amount: "-5.00", currency: "EUR" },
            credit_debit_indicator: "DBIT",
            status: "BOOK",
            booking_date: "2026-08-25",
            value_date: "2026-08-24",
          },
          {
            transaction_amount: { amount: "-7.00", currency: "EUR" },
            credit_debit_indicator: "DBIT",
            status: "BOOK",
            booking_date: "2026-08-24",
            value_date: "2026-08-25",
          },
          {
            transaction_amount: { amount: "-11.00", currency: "EUR" },
            credit_debit_indicator: "DBIT",
            status: "BOOK",
            booking_date: "2026-08-25",
            value_date: "2026-08-26",
          },
        ],
        continuation_key: null,
      });
    });

    const response = await callTool(
      5,
      "finance_get_spending",
      { dateFrom: "2026-08-24", dateTo: "2026-08-24" },
      {
        ...env,
        ENABLE_BANKING_PRIVATE_KEY_PEM: providerPrivateKeyPem,
      },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      result: { structuredContent: Record<string, unknown> };
    };
    expect(payload.result.structuredContent).toMatchObject({
      totalsByCurrency: { EUR: "12" },
      transactionsIncluded: 2,
      transactionDetailsComplete: true,
      complete: false,
      pagesScanned: 1,
    });
    expect(payload.result.structuredContent.transactions).toEqual([
      expect.objectContaining({ amount: "5.00", bookingDate: "2026-08-25", valueDate: "2026-08-24" }),
      expect.objectContaining({ amount: "7.00", bookingDate: "2026-08-24", valueDate: "2026-08-25" }),
    ]);
  });

  it("summarizes booked cash flow across provider pages", async () => {
    await env.SESSION_STORE.put(SESSION_STORE_KEY, JSON.stringify([INTESA_SESSION_ID]));
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
      expect(url.pathname).toBe(`/accounts/${INTESA_ACCOUNT_ID}/transactions`);
      expect(url.searchParams.get("transaction_status")).toBe("BOOK");
      if (url.searchParams.get("continuation_key") === null) {
        return Response.json({
          transactions: [
            {
              transaction_amount: { amount: "-2.00", currency: "EUR" },
              credit_debit_indicator: "DBIT",
              status: "BOOK",
            },
          ],
          continuation_key: "next-page",
        });
      }
      expect(url.searchParams.get("continuation_key")).toBe("next-page");
      return Response.json({
        transactions: [
          {
            transaction_amount: { amount: "5.00", currency: "EUR" },
            credit_debit_indicator: "CRDT",
            status: "BOOK",
          },
        ],
        continuation_key: null,
      });
    });

    const response = await callTool(
      5,
      "finance_summarize_cash_flow",
      { dateFrom: "2026-08-01", dateTo: "2026-08-24" },
      {
        ...env,
        ENABLE_BANKING_PRIVATE_KEY_PEM: providerPrivateKeyPem,
      },
    );

    const payload = (await response.json()) as {
      result: { structuredContent: Record<string, unknown> };
    };
    expect(payload.result.structuredContent).toEqual({
      totalsByCurrency: { EUR: { credit: "5", debit: "2", net: "3" } },
      transactionsIncluded: 2,
      complete: true,
      pagesScanned: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects a future transaction start date before contacting Enable Banking", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await callTool(2, "finance_list_transactions", {
      accountId: "11111111-1111-4111-8111-111111111111",
      dateFrom: "9999-01-01",
      dateTo: "9999-01-02",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("dateFrom must not be in the future");
    expect(fetchMock).not.toHaveBeenCalled();
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
