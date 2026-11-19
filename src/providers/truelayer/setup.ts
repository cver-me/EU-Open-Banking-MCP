import { z } from "zod";
import { errorMessage, PublicError } from "../../errors";
import { base64UrlEncode } from "../../lib/crypto";
import {
  authorizationPage,
  callbackCookie,
  errorPage,
  escapeHtml,
  html,
  methodNotAllowed,
  readCookie,
  readForm,
  redirect,
  requireSameOrigin,
  tokensMatch,
} from "../../lib/web";
import type { ProviderSetup } from "../types";
import { trueLayerAuthorizationUrl, type TrueLayerClient, type TrueLayerConnectionSummary } from "./client";
import type { TrueLayerConfig } from "./config";

const CONNECT_PATH = "/setup/truelayer/connect";
const REMOVE_PATH = "/setup/truelayer/remove";
const CALLBACK_PATH = "/callback/truelayer";
const STATE_COOKIE = "truelayer_setup_state";
const RENEWAL_WARNING_DAYS = 14;

export class TrueLayerSetup implements ProviderSetup {
  constructor(
    private readonly config: TrueLayerConfig,
    private readonly client: TrueLayerClient,
  ) {}

  async handle(request: Request, url: URL): Promise<Response | undefined> {
    if (![CONNECT_PATH, REMOVE_PATH, CALLBACK_PATH].includes(url.pathname)) return undefined;
    const clearCookie = callbackCookie(STATE_COOKIE, CALLBACK_PATH, undefined);
    try {
      const redirectUri = `${url.origin}${CALLBACK_PATH}`;
      if (url.pathname === CONNECT_PATH) {
        if (request.method !== "POST") return methodNotAllowed();
        requireSameOrigin(request);
        // Reconnecting replaces an existing connection once the new one succeeds.
        const form = await readForm(request, { optional: true });
        const replaces = form.replaceConnectionId ? z.uuid().parse(form.replaceConnectionId) : undefined;
        const state = crypto.randomUUID();
        const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(48)));
        const codeChallenge = base64UrlEncode(
          new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))),
        );
        const authorizationUrl = trueLayerAuthorizationUrl(this.config, redirectUri, state, codeChallenge);
        const cookieValue = [state, codeVerifier, ...(replaces === undefined ? [] : [replaces])].join(".");
        return html(authorizationPage(authorizationUrl, "TrueLayer"), 200, callbackCookie(STATE_COOKIE, CALLBACK_PATH, cookieValue));
      }
      if (url.pathname === REMOVE_PATH) {
        if (request.method !== "POST") return methodNotAllowed();
        requireSameOrigin(request);
        const form = await readForm(request);
        await this.client.removeConnection(z.uuid().parse(form.connectionId));
        return redirect("/setup?removed=1");
      }
      // Callback
      if (request.method !== "GET") return methodNotAllowed();
      if (url.searchParams.has("error")) {
        throw new PublicError("Bank authorization was cancelled or denied.", "authorization_denied");
      }
      const code = z.string().min(1).max(4_096).parse(url.searchParams.get("code"));
      const state = z.uuid().parse(url.searchParams.get("state"));
      const [cookieState, codeVerifier, replaces, ...extra] = (readCookie(request, STATE_COOKIE) ?? "").split(".");
      if (extra.length > 0) throw new PublicError("The authorization state did not match. Start again.", "invalid_state");
      const parsedCookieState = z.uuid().parse(cookieState);
      const parsedVerifier = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/).parse(codeVerifier);
      const parsedReplaces = replaces === undefined ? undefined : z.uuid().parse(replaces);
      if (!(await tokensMatch(state, parsedCookieState))) {
        throw new PublicError("The authorization state did not match. Start again.", "invalid_state");
      }
      const newId = await this.client.completeAuthorization(code, redirectUri, parsedVerifier);
      if (parsedReplaces !== undefined && await this.replaceIfSameBank(parsedReplaces, newId)) {
        return redirect("/setup?renewed=1", clearCookie);
      }
      return redirect("/setup?connected=1", clearCookie);
    } catch (error) {
      return html(errorPage(errorMessage(error)), 400, clearCookie);
    }
  }

  async section(_request: Request, url: URL): Promise<string> {
    return trueLayerSection(url, await this.client.listConnections());
  }

  /** Removes the previous connection only when the user reconnected the same bank. */
  private async replaceIfSameBank(previousId: string, newId: string): Promise<boolean> {
    const connections = await this.client.listConnections();
    const previous = connections.find(({ connectionId }) => connectionId === previousId);
    const current = connections.find(({ connectionId }) => connectionId === newId);
    if (previous?.providerId === undefined || previous.providerId !== current?.providerId) return false;
    // The new consent works, so the old one can go; its accounts would only be duplicates.
    await this.client.removeConnection(previousId).catch(() => undefined);
    return true;
  }
}

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
      return `<li>${escapeHtml(label)}<form method="post" action="${CONNECT_PATH}"><input type="hidden" name="replaceConnectionId" value="${id}"><button type="submit">Reconnect</button></form><form method="post" action="${REMOVE_PATH}"><input type="hidden" name="connectionId" value="${id}"><button type="submit">Remove</button></form></li>`;
    })
    .join("");
  return `<h2>UK banks (TrueLayer)</h2>
<p>Register this exact redirect URI in your TrueLayer Console app:</p>
<p><code>${escapeHtml(`${url.origin}${CALLBACK_PATH}`)}</code></p>
<h3>Connected banks</h3>
${connections.length === 0 ? "<p>No UK banks connected.</p>" : `<ul>${items}</ul>`}
<p>UK consent lasts 90 days. Use Reconnect before it expires: the old connection is removed once the new one works.</p>
<form method="post" action="${CONNECT_PATH}"><button type="submit">Connect a UK bank</button></form>`;
}
