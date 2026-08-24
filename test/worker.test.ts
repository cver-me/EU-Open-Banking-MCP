import { createExecutionContext, env } from "cloudflare:test";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const SESSION_STORE_KEY = "enable-banking-session-ids-v1";
const INTESA_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const REVOLUT_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const INTESA_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const REVOLUT_ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";

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
afterEach(() => vi.restoreAllMocks());

function fetchAuthenticated(request: Request, workerEnv: Env = env): Promise<Response> {
  return worker.fetch(
    request as Parameters<typeof worker.fetch>[0],
    workerEnv,
    createAuthenticatedContext(),
  );
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
    const response = await fetchAuthenticated(
      new Request("https://localhost/mcp", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          Host: "localhost",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      }),
    );

    expect(response.status).toBe(200);
    const responseText = await response.text();
    const dataLine = responseText
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    expect(dataLine).toBeDefined();
    const payload = JSON.parse(dataLine ?? "null") as {
      result: {
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
    expect(spendingTool?.description).toContain("debit spending by transaction date");
    expect(spendingTool?.description).toContain("Includes pending transactions");

    expect(transactionTool?.description).toContain("for one account");
    expect(transactionTool?.description).toContain("filtered by lifecycle status");

    const cashFlowTool = payload.result.tools.find(
      ({ name }) => name === "finance_summarize_cash_flow",
    );
    expect(cashFlowTool?.description).toContain(
      "booked credit, debit, and net accounting totals",
    );
  });

  it("answers spending by transaction date across accounts and includes pending activity", async () => {
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
      expect(url.searchParams.get("date_from")).toBe("2026-08-24");
      expect(url.searchParams.get("date_to")).toBe("2026-08-24");
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
              transaction_amount: { amount: "-3.70", currency: "EUR" },
              credit_debit_indicator: "DBIT",
              status: "PDNG",
              transaction_date: "2026-08-24",
              creditor: { name: "Bar Prima Porta" },
            },
          ],
          continuation_key: null,
        });
      }
      return Response.json({ error: "unexpected_test_request" }, { status: 500 });
    });

    const response = await fetchAuthenticated(
      new Request("https://localhost/mcp", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          Host: "localhost",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "finance_get_spending",
            arguments: { dateFrom: "2026-08-24", dateTo: "2026-08-24" },
          },
        }),
      }),
      {
        ...env,
        ENABLE_BANKING_PRIVATE_KEY_PEM: providerPrivateKeyPem,
      },
    );

    expect(response.status).toBe(200);
    const payload = parseSsePayload(await response.text()) as {
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
          transactionDate: "2026-08-24",
          counterparty: "Bar Prima Porta",
        },
      ],
      transactionsIncluded: 1,
      transactionDetailsComplete: true,
      dateCoverageComplete: true,
      complete: true,
      pagesScanned: 2,
    });
    expect(JSON.stringify(payload)).not.toContain("Licari Group");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("rejects a future transaction start date before contacting Enable Banking", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await fetchAuthenticated(
      new Request("https://localhost/mcp", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          Host: "localhost",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "finance_list_transactions",
            arguments: {
              accountId: "11111111-1111-4111-8111-111111111111",
              dateFrom: "9999-01-01",
              dateTo: "9999-01-02",
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("dateFrom must not be in the future");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function parseSsePayload(responseText: string): unknown {
  const dataLine = responseText
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  expect(dataLine).toBeDefined();
  return JSON.parse(dataLine ?? "null");
}
