import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";

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

function fetchAuthenticated(request: Request): Promise<Response> {
  return worker.fetch(
    request as Parameters<typeof worker.fetch>[0],
    env,
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

  it("publishes only the five narrow, read-only finance tools", async () => {
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
