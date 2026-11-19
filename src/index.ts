import { createMcpHandler } from "agents/mcp/server";
import { Aggregate } from "./aggregate";
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

    const setupResponse = await handleSetupRequest(request, providers);
    if (setupResponse !== undefined) return withSecurityHeaders(setupResponse);

    if (new URL(request.url).pathname !== "/mcp") {
      return withSecurityHeaders(Response.json({ error: "not_found" }, { status: 404 }));
    }

    const psu = psuContextFromRequest(request);
    const handler = createMcpHandler(() =>
      // Readers are request-scoped: they share token work within one request only.
      createFinanceServer(new Aggregate(providers.map((provider) => ({
        name: provider.name,
        ownsAccountId: provider.ownsAccountId,
        reader: provider.reader(psu),
      })))), {
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

function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) secured.headers.set(name, value);
  return secured;
}
