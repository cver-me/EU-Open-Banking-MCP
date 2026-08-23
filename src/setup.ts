import { z } from "zod";
import type { AppConfig } from "./config";
import { errorMessage, PublicError } from "./errors";
import { readBoundedText } from "./http";
import { EnableBankingClient } from "./providers/enable-banking/client";
import type { SessionStore } from "./session-store";

const STATE_COOKIE = "enable_banking_setup_state";
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
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const provider = new EnableBankingClient(config, sessions);

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
      return html(await setupPage(url, provider, filter.success ? filter.data : undefined));
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
      return html(authorizationPage(authorizationUrl), 200, stateCookie(state));
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
  filter?: z.infer<typeof institutionFilterSchema>,
): Promise<string> {
  const [connections, institutions] = await Promise.all([
    provider.listConnections(),
    filter === undefined ? Promise.resolve([]) : provider.listInstitutions(filter),
  ]);
  const message = url.searchParams.has("connected")
    ? "Bank connected."
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
  const institutionOptions = institutions
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
<p>Register this exact callback URL in your Enable Banking application:</p>
<p><code>${escapeHtml(`${url.origin}/callback`)}</code></p>
<h2>Connected banks</h2>
${connections.length === 0 ? "<p>No banks connected.</p>" : `<ul>${connectionItems}</ul>`}
<h2>Connect a bank</h2>
<form method="get" action="/setup">
<p><label>Country <input name="country" required minlength="2" maxlength="2" value="${escapeHtml(country)}" placeholder="IT"></label></p>
<p><label>Account type <select name="psuType"><option value="personal"${psuType === "personal" ? " selected" : ""}>Personal</option><option value="business"${psuType === "business" ? " selected" : ""}>Business</option></select></label></p>
<button type="submit">Show banks</button>
</form>
${
  filter === undefined
    ? "<p>Choose a country and account type to load supported banks.</p>"
    : institutions.length === 0
      ? "<p>No supported banks found for this selection.</p>"
      : `<form method="post" action="/setup/connect"><input type="hidden" name="country" value="${escapeHtml(country)}"><input type="hidden" name="psuType" value="${escapeHtml(psuType)}"><p><label>Bank <select name="institution" required>${institutionOptions}</select></label></p><button type="submit">Continue to bank</button></form>`
}
</main>
</body>
</html>`;
}

function detectedCountry(request: Request): string {
  const country = request.cf?.country;
  return typeof country === "string" && country !== "T1" ? country : "";
}

function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Setup error</title></head><body><main><h1>Setup could not continue</h1><p>${escapeHtml(message)}</p><p><a href="/setup">Return to setup</a></p></main></body></html>`;
}

function authorizationPage(authorizationUrl: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Continue to bank</title></head><body><main><h1>Continue to your bank</h1><p>Enable Banking is ready to connect your account.</p><p><a href="${escapeHtml(authorizationUrl)}" rel="noreferrer">Open bank</a></p><p><a href="/setup">Cancel</a></p></main></body></html>`;
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
