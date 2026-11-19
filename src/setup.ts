import { z } from "zod";
import type { AppConfig } from "./config";
import { errorMessage, PublicError } from "./errors";
import { readBoundedText } from "./http";
import { EnableBankingClient } from "./providers/enable-banking/client";
import {
  TrueLayerClient,
  trueLayerAuthorizationUrl,
  type TrueLayerConnectionSummary,
} from "./providers/truelayer/client";
import type { TrueLayerConnectionStore } from "./providers/truelayer/connection-store";
import type { SessionStore } from "./session-store";
import { base64UrlEncode } from "./token-crypto";

const STATE_COOKIE = "enable_banking_setup_state";
const TRUELAYER_STATE_COOKIE = "truelayer_setup_state";
const TRUELAYER_CALLBACK_PATH = "/callback/truelayer";
const MAX_FORM_BYTES = 4_096;

const connectSchema = z.object({
  institution: z.string().trim().min(1).max(100),
  country: z.string().trim().length(2).transform((value) => value.toUpperCase()),
  psuType: z.enum(["personal", "business"]),
});

const institutionFilterSchema = connectSchema.omit({ institution: true });

export async function handleSetupRequest(
  request: Request,
  config: AppConfig,
  sessions: SessionStore,
  trueLayerStore?: TrueLayerConnectionStore,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const provider = new EnableBankingClient(config, sessions);
  const trueLayer = config.trueLayer === undefined || trueLayerStore === undefined
    ? undefined
    : { config: config.trueLayer, client: new TrueLayerClient(config.trueLayer, trueLayerStore) };

  if (url.pathname.startsWith("/setup/truelayer/") || url.pathname === TRUELAYER_CALLBACK_PATH) {
    try {
      if (trueLayer === undefined) {
        throw new PublicError("TrueLayer is not configured for this deployment.", "truelayer_not_configured");
      }
      const redirectUri = `${url.origin}${TRUELAYER_CALLBACK_PATH}`;
      if (url.pathname === "/setup/truelayer/connect") {
        if (request.method !== "POST") return methodNotAllowed();
        requireSameOrigin(request);
        // Reconnecting replaces an existing connection once the new one succeeds.
        const isForm = (request.headers.get("Content-Type") ?? "").startsWith("application/x-www-form-urlencoded");
        const form = isForm ? await readForm(request) : {};
        const replaces = form.replaceConnectionId === undefined || form.replaceConnectionId === ""
          ? undefined
          : z.uuid().parse(form.replaceConnectionId);
        const state = crypto.randomUUID();
        const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(48)));
        const codeChallenge = base64UrlEncode(
          new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))),
        );
        const authorizationUrl = trueLayerAuthorizationUrl(trueLayer.config, redirectUri, state, codeChallenge);
        return html(
          authorizationPage(authorizationUrl, "TrueLayer"),
          200,
          trueLayerStateCookie([state, codeVerifier, ...(replaces === undefined ? [] : [replaces])].join(".")),
        );
      }
      if (url.pathname === "/setup/truelayer/remove") {
        if (request.method !== "POST") return methodNotAllowed();
        requireSameOrigin(request);
        const form = await readForm(request);
        await trueLayer.client.removeConnection(z.uuid().parse(form.connectionId));
        return redirect("/setup?removed=1");
      }
      if (url.pathname === TRUELAYER_CALLBACK_PATH) {
        if (request.method !== "GET") return methodNotAllowed();
        if (url.searchParams.has("error")) {
          throw new PublicError("Bank authorization was cancelled or denied.", "authorization_denied");
        }
        const code = z.string().min(1).max(4_096).parse(url.searchParams.get("code"));
        const state = z.uuid().parse(url.searchParams.get("state"));
        const [cookieState, codeVerifier, replaces, ...extra] =
          (readCookie(request, TRUELAYER_STATE_COOKIE) ?? "").split(".");
        if (extra.length > 0) throw new PublicError("The authorization state did not match. Start again.", "invalid_state");
        const parsedCookieState = z.uuid().parse(cookieState);
        const parsedVerifier = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/).parse(codeVerifier);
        const parsedReplaces = replaces === undefined ? undefined : z.uuid().parse(replaces);
        if (!(await tokensMatch(state, parsedCookieState))) {
          throw new PublicError("The authorization state did not match. Start again.", "invalid_state");
        }
        const newId = await trueLayer.client.completeAuthorization(code, redirectUri, parsedVerifier);
        if (parsedReplaces !== undefined) {
          const connections = await trueLayer.client.listConnections();
          const previous = connections.find(({ connectionId }) => connectionId === parsedReplaces);
          const current = connections.find(({ connectionId }) => connectionId === newId);
          // Only replace when the user reconnected the same bank; a different bank is kept as a new connection.
          if (previous !== undefined && previous.providerId !== undefined && previous.providerId === current?.providerId) {
            await trueLayer.client.removeConnection(parsedReplaces).catch(() => undefined);
            return redirect("/setup?renewed=1", clearTrueLayerStateCookie());
          }
        }
        return redirect("/setup?connected=1", clearTrueLayerStateCookie());
      }
      return undefined;
    } catch (error) {
      return html(errorPage(errorMessage(error)), 400, clearTrueLayerStateCookie());
    }
  }

  try {
    if (url.pathname === "/") {
      if (request.method !== "GET") return methodNotAllowed();
      return redirect("/setup");
    }
    if (url.pathname === "/setup") {
      if (request.method !== "GET") return methodNotAllowed();
      const filter = institutionFilterSchema.safeParse({
        country: url.searchParams.get("country") ?? detectedCountry(request),
        psuType: url.searchParams.get("psuType") ?? "personal",
      });
      return html(await setupPage(url, provider, trueLayer?.client, filter.success ? filter.data : undefined));
    }
    if (url.pathname === "/setup/connect") {
      if (request.method !== "POST") return methodNotAllowed();
      requireSameOrigin(request);
      const input = connectSchema.parse(await readForm(request));
      const state = crypto.randomUUID();
      const authorizationUrl = await provider.startAuthorization(
        input,
        `${url.origin}/callback`,
        state,
      );
      return html(authorizationPage(authorizationUrl, "Enable Banking"), 200, stateCookie(state));
    }
    if (url.pathname === "/setup/remove") {
      if (request.method !== "POST") return methodNotAllowed();
      requireSameOrigin(request);
      const form = await readForm(request);
      await provider.removeConnection(z.uuid().parse(form.sessionId));
      return redirect("/setup?removed=1");
    }
    if (url.pathname === "/callback") {
      if (request.method !== "GET") return methodNotAllowed();
      if (url.searchParams.has("error")) {
        throw new PublicError("Bank authorization was cancelled or denied.", "authorization_denied");
      }
      const code = z.string().min(1).max(4_096).parse(url.searchParams.get("code"));
      const state = z.uuid().parse(url.searchParams.get("state"));
      const cookieState = z.uuid().parse(readCookie(request, STATE_COOKIE));
      if (!(await tokensMatch(state, cookieState))) {
        throw new PublicError("The authorization state did not match. Start again.", "invalid_state");
      }
      await provider.completeAuthorization(code);
      return redirect("/setup?connected=1", clearStateCookie());
    }
  } catch (error) {
    return html(errorPage(errorMessage(error)), 400, clearStateCookie());
  }

  return undefined;
}

async function setupPage(
  url: URL,
  provider: EnableBankingClient,
  trueLayer: TrueLayerClient | undefined,
  filter?: z.infer<typeof institutionFilterSchema>,
): Promise<string> {
  const [connections, institutions, trueLayerConnections] = await Promise.all([
    provider.listConnections(),
    // A failing Enable Banking bank list must not hide the rest of the setup page.
    filter === undefined
      ? Promise.resolve([])
      : provider.listInstitutions(filter).catch(() => undefined),
    trueLayer === undefined ? Promise.resolve(undefined) : trueLayer.listConnections(),
  ]);
  const message = url.searchParams.has("connected")
    ? "Bank connected."
    : url.searchParams.has("renewed")
      ? "Bank reconnected. The previous connection was removed."
      : url.searchParams.has("removed")
      ? "Connection removed."
      : undefined;
  const connectionItems = connections
    .map((connection) => {
      const label = connection.institution
        ? `${connection.institution} (${connection.country}) — ${connection.psuType} — ${connection.status} — ${connection.accountCount ?? 0} account(s)`
        : `Session ${connection.sessionId.slice(0, 8)}… — ${connection.status}`;
      return `<li>${escapeHtml(label)}<form method="post" action="/setup/remove"><input type="hidden" name="sessionId" value="${escapeHtml(connection.sessionId)}"><button type="submit">Remove</button></form></li>`;
    })
    .join("");
  const institutionOptions = (institutions ?? [])
    .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
    .join("");
  const country = filter?.country ?? "";
  const psuType = filter?.psuType ?? "personal";

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Personal Finance MCP setup</title></head>
<body>
<main>
<h1>Personal Finance MCP</h1>
${message === undefined ? "" : `<p><strong>${escapeHtml(message)}</strong></p>`}
<h2>EU banks (Enable Banking)</h2>
<p>Register this exact callback URL in your Enable Banking application:</p>
<p><code>${escapeHtml(`${url.origin}/callback`)}</code></p>
<h3>Connected banks</h3>
${connections.length === 0 ? "<p>No banks connected.</p>" : `<ul>${connectionItems}</ul>`}
<h3>Connect a bank</h3>
<form method="get" action="/setup">
<p><label>Country <input name="country" required minlength="2" maxlength="2" value="${escapeHtml(country)}" placeholder="IT"></label></p>
<p><label>Account type <select name="psuType"><option value="personal"${psuType === "personal" ? " selected" : ""}>Personal</option><option value="business"${psuType === "business" ? " selected" : ""}>Business</option></select></label></p>
<button type="submit">Show banks</button>
</form>
${
  filter === undefined
    ? "<p>Choose a country and account type to load supported banks.</p>"
    : institutions === undefined
      ? "<p>Enable Banking could not load the bank list. Try again shortly.</p>"
      : institutions.length === 0
      ? "<p>No supported banks found for this selection.</p>"
      : `<form method="post" action="/setup/connect"><input type="hidden" name="country" value="${escapeHtml(country)}"><input type="hidden" name="psuType" value="${escapeHtml(psuType)}"><p><label>Bank <select name="institution" required>${institutionOptions}</select></label></p><button type="submit">Continue to bank</button></form>`
}
${trueLayerConnections === undefined ? "" : trueLayerSection(url, trueLayerConnections)}
</main>
</body>
</html>`;
}

const RENEWAL_WARNING_DAYS = 14;

function trueLayerSection(url: URL, connections: TrueLayerConnectionSummary[], now = Date.now()): string {
  const items = connections
    .map((connection) => {
      const expiresAt = connection.consentExpiresAt === undefined ? Number.NaN : Date.parse(connection.consentExpiresAt);
      const daysLeft = Math.floor((expiresAt - now) / 86_400_000);
      const expiry = Number.isNaN(expiresAt)
        ? ""
        : expiresAt <= now
          ? " — consent EXPIRED: reconnect to resume access"
          : daysLeft < RENEWAL_WARNING_DAYS
            ? ` — consent expires in ${daysLeft} day(s): reconnect soon`
            : ` — consent expires ${connection.consentExpiresAt!.slice(0, 10)}`;
      const label = `${connection.institution ?? "UK bank"} — connected ${connection.createdAt.slice(0, 10)}${expiry}`;
      const id = escapeHtml(connection.connectionId);
      return `<li>${escapeHtml(label)}<form method="post" action="/setup/truelayer/connect"><input type="hidden" name="replaceConnectionId" value="${id}"><button type="submit">Reconnect</button></form><form method="post" action="/setup/truelayer/remove"><input type="hidden" name="connectionId" value="${id}"><button type="submit">Remove</button></form></li>`;
    })
    .join("");
  return `<h2>UK banks (TrueLayer)</h2>
<p>Register this exact redirect URI in your TrueLayer Console app:</p>
<p><code>${escapeHtml(`${url.origin}${TRUELAYER_CALLBACK_PATH}`)}</code></p>
<h3>Connected banks</h3>
${connections.length === 0 ? "<p>No UK banks connected.</p>" : `<ul>${items}</ul>`}
<p>UK consent lasts 90 days. Use Reconnect before it expires: the old connection is removed once the new one works.</p>
<form method="post" action="/setup/truelayer/connect"><button type="submit">Connect a UK bank</button></form>`;
}

function detectedCountry(request: Request): string {
  const country = request.cf?.country;
  return typeof country === "string" && country !== "T1" ? country : "";
}

function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Setup error</title></head><body><main><h1>Setup could not continue</h1><p>${escapeHtml(message)}</p><p><a href="/setup">Return to setup</a></p></main></body></html>`;
}

function authorizationPage(authorizationUrl: string, providerName: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Continue to bank</title></head><body><main><h1>Continue to your bank</h1><p>${escapeHtml(providerName)} is ready to connect your account.</p><p><a href="${escapeHtml(authorizationUrl)}" rel="noreferrer">Open bank</a></p><p><a href="/setup">Cancel</a></p></main></body></html>`;
}

async function readForm(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    throw new PublicError("Unsupported form content type.", "invalid_form");
  }
  const text = await readBoundedText(
    request,
    MAX_FORM_BYTES,
    new PublicError("The setup form was unexpectedly large.", "invalid_form"),
  );
  return Object.fromEntries(new URLSearchParams(text));
}

function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  const expectedOrigin = new URL(request.url).origin;
  const opaqueOrMissingOrigin = origin === null || origin === "null";
  if (
    origin === expectedOrigin ||
    (opaqueOrMissingOrigin && request.headers.get("Sec-Fetch-Site") === "same-origin")
  ) {
    return;
  }
  throw new PublicError("Invalid setup request origin.", "invalid_origin");
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [cookieName, ...valueParts] = part.trim().split("=");
    if (cookieName === name) return decodeURIComponent(valueParts.join("="));
  }
  return undefined;
}

async function tokensMatch(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

function stateCookie(state: string): string {
  return `${STATE_COOKIE}=${encodeURIComponent(state)}; Path=/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
}

function clearStateCookie(): string {
  return `${STATE_COOKIE}=; Path=/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function trueLayerStateCookie(value: string): string {
  return `${TRUELAYER_STATE_COOKIE}=${encodeURIComponent(value)}; Path=${TRUELAYER_CALLBACK_PATH}; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
}

function clearTrueLayerStateCookie(): string {
  return `${TRUELAYER_STATE_COOKIE}=; Path=${TRUELAYER_CALLBACK_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location });
  if (cookie !== undefined) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function html(body: string, status = 200, cookie?: string): Response {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  if (cookie !== undefined) headers.set("Set-Cookie", cookie);
  return new Response(body, { status, headers });
}

function methodNotAllowed(): Response {
  return new Response("Method not allowed", { status: 405 });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
