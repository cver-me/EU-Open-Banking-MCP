import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { openFinanceCache, type FinanceCache } from "../src/cache/finance-cache";
import { retryTransient } from "../src/cache/reads";
import { PublicError } from "../src/errors";

const SESSION_STORE_KEY = "enable-banking-session-ids-v1";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "44444444-4444-4444-8444-444444444444";
const MCP_PROTOCOL_VERSION = "2026-07-28";

let privateKeyPem: string;
const cacheStub = () => openFinanceCache(env.FINANCE_CACHE as unknown as DurableObjectNamespace<FinanceCache>);

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  privateKeyPem = await exportPKCS8(privateKey);
});

beforeEach(async () => {
  await env.SESSION_STORE.put(SESSION_STORE_KEY, JSON.stringify([SESSION_ID]));
  await (await cacheStub()).clear();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await env.SESSION_STORE.delete(SESSION_STORE_KEY);
});

function callTool(id: number, name: string, args: Record<string, unknown>): Promise<Response> {
  const context = createExecutionContext();
  Object.defineProperty(context, "access", { value: { aud: "local-test-access" } });
  const request = new Request("https://localhost/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Host: "localhost",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "cache-test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  return worker.fetch(request as Parameters<typeof worker.fetch>[0], { ...env, ENABLE_BANKING_PRIVATE_KEY_PEM: privateKeyPem } as Env, context);
}

async function structured(response: Response): Promise<Record<string, unknown>> {
  const payload = (await response.json()) as { result: { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, unknown> } };
  expect(payload.result.isError, payload.result.content?.[0]?.text).toBeUndefined();
  return payload.result.structuredContent;
}

/** A bank with two accounts; counts every call by path. */
function mockBank(transactionsFor: (accountId: string) => unknown[] = () => [
  {
    transaction_amount: { amount: "-12.00", currency: "EUR" },
    credit_debit_indicator: "DBIT",
    status: "BOOK",
    transaction_date: "2026-11-10",
    creditor: { name: "Example Shop" },
  },
]) {
  const calls = new Map<string, number>();
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    calls.set(url.pathname, (calls.get(url.pathname) ?? 0) + 1);
    if (url.pathname === `/sessions/${SESSION_ID}`) {
      return Response.json({
        status: "AUTHORIZED",
        accounts: [ACCOUNT_A, ACCOUNT_B],
        aspsp: { name: "Example Bank", country: "IT" },
        psu_type: "personal",
      });
    }
    if (url.pathname.endsWith("/details")) return Response.json({ currency: "EUR", cash_account_type: "CACC" });
    const accountId = url.pathname.split("/")[2]!;
    return Response.json({ transactions: transactionsFor(accountId), continuation_key: null });
  });
  const transactionReads = () =>
    [...calls].filter(([path]) => path.endsWith("/transactions")).reduce((sum, [, count]) => sum + count, 0);
  return { calls, fetchMock, transactionReads };
}

describe("shared bank-read cache", () => {
  it("answers a turn of several tools with one bank read per account", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T12:00:00.000Z"));
    const bank = mockBank();

    // The widest range first, as a review would; the narrower ones after it reuse it.
    const review = await structured(await callTool(1, "finance_review_activity", { dateFrom: "2026-11-01", dateTo: "2026-11-19" }));
    expect(review.pagesScanned).toBe(2);
    const cashFlow = await structured(await callTool(2, "finance_get_cash_flow", { dateFrom: "2026-11-01", dateTo: "2026-11-19" }));
    const breakdown = await structured(await callTool(3, "finance_get_spending_breakdown", { dateFrom: "2026-11-05", dateTo: "2026-11-19" }));
    const search = await structured(await callTool(4, "finance_search_transactions", { dateFrom: "2026-11-01", dateTo: "2026-11-19", query: "shop" }));
    const accounts = await structured(await callTool(5, "finance_list_accounts", {}));

    expect(bank.transactionReads()).toBe(2);
    expect(bank.calls.get(`/accounts/${ACCOUNT_A}/details`)).toBe(1);
    expect(bank.calls.get(`/sessions/${SESSION_ID}`)).toBeLessThanOrEqual(2);
    for (const result of [cashFlow, breakdown, search]) {
      expect(result.pagesScanned).toBe(0);
      expect(result.dataAsOf).toBe("2026-11-19T12:00:00.000Z");
    }
    expect(cashFlow.totalsByCurrency).toMatchObject({ EUR: { spending: "24.00" } });
    expect((search.transactions as unknown[]).length).toBe(2);
    expect((accounts.accounts as unknown[]).length).toBe(2);
  });

  it("reads again when a range starts earlier than what was read, or after five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T12:00:00.000Z"));
    const bank = mockBank();

    await structured(await callTool(1, "finance_get_cash_flow", { dateFrom: "2026-11-01", dateTo: "2026-11-19" }));
    expect(bank.transactionReads()).toBe(2);
    await structured(await callTool(2, "finance_get_cash_flow", { dateFrom: "2026-10-01", dateTo: "2026-11-19" }));
    expect(bank.transactionReads()).toBe(4);
    await structured(await callTool(3, "finance_get_cash_flow", { dateFrom: "2026-10-15", dateTo: "2026-11-19" }));
    expect(bank.transactionReads()).toBe(4);

    vi.setSystemTime(new Date("2026-11-19T12:06:00.000Z"));
    const later = await structured(await callTool(4, "finance_get_cash_flow", { dateFrom: "2026-11-01", dateTo: "2026-11-19" }));
    expect(bank.transactionReads()).toBe(6);
    expect(later.dataAsOf).toBe("2026-11-19T12:06:00.000Z");
  });

  it("merges tool calls that ask for the same data at the same time", async () => {
    const bank = mockBank();
    const range = { dateFrom: "2026-11-01", dateTo: "2026-11-15" };
    const results = await Promise.all([
      callTool(1, "finance_get_cash_flow", range),
      callTool(2, "finance_get_spending_breakdown", range),
      callTool(3, "finance_get_cash_flow", { ...range, groupBy: "week" }),
    ].map(async (response) => structured(await response)));
    expect(results).toHaveLength(3);
    // One call read each account; the other two waited for it and reused the result.
    expect(bank.transactionReads()).toBe(2);
    expect(bank.calls.get(`/accounts/${ACCOUNT_A}/details`)).toBe(1);
  });

  it("never keeps a failed read, so the next call asks the bank again", async () => {
    let failing = true;
    const bank = mockBank();
    bank.fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      bank.calls.set(url.pathname, (bank.calls.get(url.pathname) ?? 0) + 1);
      if (url.pathname === `/sessions/${SESSION_ID}`) {
        return Response.json({ status: "AUTHORIZED", accounts: [ACCOUNT_A], aspsp: { name: "Example Bank", country: "IT" }, psu_type: "personal" });
      }
      if (url.pathname.endsWith("/details")) return Response.json({ currency: "EUR", cash_account_type: "CACC" });
      if (failing) return Response.json({ error: "ASPSP_RATE_LIMIT_EXCEEDED" }, { status: 429 });
      return Response.json({ transactions: [], continuation_key: null });
    });

    const first = await callTool(1, "finance_get_cash_flow", { dateFrom: "2026-11-01", dateTo: "2026-11-15" });
    expect(JSON.stringify(await first.json())).toContain("rate");
    failing = false;
    const second = await structured(await callTool(2, "finance_get_cash_flow", { dateFrom: "2026-11-01", dateTo: "2026-11-15" }));
    expect(second.complete).toBe(true);
    expect(bank.transactionReads()).toBe(2);
  });
});

describe("FinanceCache agent", () => {
  it("hands out one lease per key and lets waiters reuse the result", async () => {
    const cache = await cacheStub();
    const first = await cache.claim("k");
    expect(first.hit).toBe(false);
    const waiting = cache.claim("k");
    await cache.fill("k", (first as { lease: string }).lease, { answer: 42 }, 60_000);
    expect(await waiting).toMatchObject({ hit: true, value: { answer: 42 } });
  });

  it("lets a waiter take over when the lease holder gives up", async () => {
    const cache = await cacheStub();
    const first = await cache.claim("k");
    const waiting = cache.claim("k");
    await cache.release("k", (first as { lease: string }).lease);
    expect(await waiting).toMatchObject({ hit: false });
  });

  it("counts an entry only when it covers the requested dates", async () => {
    const cache = await cacheStub();
    const claim = await cache.claim("t");
    await cache.fill("t", (claim as { lease: string }).lease, [], 60_000, { from: "2026-10-01", to: "2026-11-19" });
    expect((await cache.claim("t", { from: "2026-10-15", to: "2026-11-19" })).hit).toBe(true);
    const earlier = await cache.claim("t", { from: "2026-09-01", to: "2026-11-19" });
    expect(earlier.hit).toBe(false);
    await cache.release("t", (earlier as { lease: string }).lease);
  });

  it("leaves no alarm and stores no bank data after a turn, so it can go idle", async () => {
    mockBank();
    await structured(await callTool(1, "finance_get_cash_flow", { dateFrom: "2026-11-01", dateTo: "2026-11-15" }));
    const cache = await cacheStub();
    const state = await runInDurableObject(cache, async (_instance, ctx) => ({
      alarm: await ctx.storage.getAlarm(),
      // Only the Agent's own bookkeeping tables; none written by the cache.
      rows: ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()
        .map(({ name }) => String(name))
        .filter((name) => !name.startsWith("cf_") && !name.startsWith("_cf_") && !name.startsWith("sqlite_"))
        .map((name) => ({ name, count: ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM "${name}"`).one().n })),
    }));
    expect(state.alarm).toBeNull();
    expect(state.rows.filter(({ count }) => Number(count) > 0)).toEqual([]);
  });

  it("forgets everything on clear", async () => {
    const cache = await cacheStub();
    const claim = await cache.claim("k");
    await cache.fill("k", (claim as { lease: string }).lease, 1, 60_000);
    await cache.clear();
    expect((await cache.claim("k")).hit).toBe(false);
  });
});

describe("retryTransient", () => {
  it("retries a timeout once and gives up on rate limits at once", async () => {
    let attempts = 0;
    await expect(retryTransient(async () => {
      attempts += 1;
      if (attempts === 1) throw new PublicError("timed out", "provider_timeout");
      return "ok";
    })).resolves.toBe("ok");
    expect(attempts).toBe(2);

    let limited = 0;
    await expect(retryTransient(async () => {
      limited += 1;
      throw new PublicError("slow down", "provider_rate_limited");
    })).rejects.toThrow("slow down");
    expect(limited).toBe(1);
  });
});
