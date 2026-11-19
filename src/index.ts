import { createMcpHandler } from "agents/mcp/server";
import { loadConfig } from "./config";
import { createFinanceServer } from "./mcp/server";
import { CompositeFinanceProvider } from "./providers/composite";
import { EnableBankingClient } from "./providers/enable-banking/client";
import {
  connectingIpAddress,
  enableBankingPsuHeadersFromRequest,
} from "./providers/enable-banking/psu-headers";
import { TrueLayerClient } from "./providers/truelayer/client";
import { KvTrueLayerConnectionStore } from "./providers/truelayer/connection-store";
import { KvSessionStore } from "./session-store";
import { handleSetupRequest } from "./setup";
import { TokenCipher } from "./token-crypto";

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

    let config;
    try {
      config = loadConfig(env);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "Invalid Worker configuration",
          errorType: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      return withSecurityHeaders(Response.json({ error: "service_unavailable" }, { status: 503 }));
    }

    const url = new URL(request.url);
    const sessions = new KvSessionStore(env.SESSION_STORE);
    const trueLayerStore = config.trueLayer === undefined
      ? undefined
      : new KvTrueLayerConnectionStore(env.SESSION_STORE, new TokenCipher(config.trueLayer.tokenEncryptionKey));
    const setupResponse = await handleSetupRequest(request, config, sessions, trueLayerStore);
    if (setupResponse !== undefined) return withSecurityHeaders(setupResponse);

    if (url.pathname !== "/mcp") {
      return withSecurityHeaders(Response.json({ error: "not_found" }, { status: 404 }));
    }

    const psuHeaders = enableBankingPsuHeadersFromRequest(request);
    const ipAddress = connectingIpAddress(request);
    const handler = createMcpHandler(() => {
      // Clients are request-scoped: they share token work within one request only.
      const enableBanking = new EnableBankingClient(config, sessions, psuHeaders);
      const trueLayer = config.trueLayer === undefined || trueLayerStore === undefined
        ? undefined
        : new TrueLayerClient(config.trueLayer, trueLayerStore, ipAddress === undefined ? {} : { ipAddress });
      return createFinanceServer(new CompositeFinanceProvider(enableBanking, trueLayer));
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

function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) secured.headers.set(name, value);
  return secured;
}
