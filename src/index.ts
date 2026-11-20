import { createMcpHandler } from "agents/mcp/server";
import { Aggregate } from "./aggregate";
import { FinanceCache, openFinanceCache } from "./cache/finance-cache";
import { cachedReads, directReads, type CacheStore } from "./cache/reads";
import { psuContextFromRequest } from "./lib/psu";
import { createFinanceServer } from "./mcp/server";
import { configuredProviders, type ProviderEnv } from "./providers/registry";
import type { BankProvider } from "./providers/types";
import { handleSetupRequest } from "./setup";

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

// MCP requests here are small JSON-RPC calls (largest field: an 8 KiB cursor).
const MAX_MCP_REQUEST_BODY_BYTES = 64 * 1024;

export default {
  async fetch(request, env, context): Promise<Response> {
    // Worker-level Cloudflare Access validates the request before invocation.
    // Keep this check so a missing or bypassed Access policy fails closed.
    if (context.access === undefined) {
      return withSecurityHeaders(Response.json({ error: "access_required" }, { status: 403 }));
    }

    let providers: BankProvider[];
    try {
      providers = configuredProviders(env as unknown as ProviderEnv);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "Invalid Worker configuration",
          errorType: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      return withSecurityHeaders(Response.json({ error: "service_unavailable" }, { status: 503 }));
    }

    const { pathname } = new URL(request.url);
    if (pathname !== "/mcp") {
      const setupResponse = await handleSetupRequest(request, providers);
      // Connecting, reconnecting or removing a bank changes which accounts exist.
      if (setupResponse !== undefined && (request.method !== "GET" || pathname.startsWith("/callback/"))) {
        await (await financeCache(env))?.clear().catch(() => undefined);
      }
      return withSecurityHeaders(setupResponse ?? Response.json({ error: "not_found" }, { status: 404 }));
    }

    // MCP clients (Claude, ChatGPT, Claude Code) call from servers and send no Origin. A
    // browser page from another site does; refuse it (the MCP spec requires Origin checks).
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== new URL(request.url).origin) {
      return withSecurityHeaders(Response.json({ error: "origin_not_allowed" }, { status: 403 }));
    }

    const psu = psuContextFromRequest(request);
    const cache = await financeCache(env);
    const handler = createMcpHandler(() => {
      const aggregate = new Aggregate(providers, psu);
      return createFinanceServer(cache === undefined ? directReads(aggregate) : cachedReads(aggregate, cache));
    }, {
      route: "/mcp",
      corsOptions: false,
      legacy: "stateless",
      responseMode: "auto",
      maxRequestBodySize: MAX_MCP_REQUEST_BODY_BYTES,
      onerror(error) {
        console.error(JSON.stringify({ message: "MCP request failed", errorType: error.name }));
      },
    });

    return withSecurityHeaders(await handler(request, env, context));
  },
} satisfies ExportedHandler<Env>;

export { FinanceCache };

/** The one cache instance for this deployment; absent when the binding is not configured. */
async function financeCache(env: Env): Promise<(CacheStore & { clear(): Promise<void> }) | undefined> {
  const namespace = (env as Partial<Env>).FINANCE_CACHE;
  if (namespace === undefined) return undefined;
  try {
    // Generated types cannot name the class (the config must not import Worker code).
    const stub = await openFinanceCache(namespace as unknown as DurableObjectNamespace<FinanceCache>);
    return stub as unknown as CacheStore & { clear(): Promise<void> };
  } catch (error) {
    console.error(JSON.stringify({ message: "Finance cache unavailable", errorType: error instanceof Error ? error.name : "UnknownError" }));
    return undefined;
  }
}

function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) secured.headers.set(name, value);
  return secured;
}
