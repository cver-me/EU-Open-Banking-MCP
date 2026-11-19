import { z } from "zod";
import {
  authorizationPage,
  callbackCookie,
  escapeHtml,
  html,
  methodNotAllowed,
  readAuthorizationCallback,
  readForm,
  redirect,
  requireSameOrigin,
  setupErrorResponse,
} from "../../lib/web";
import type { ProviderSetup } from "../types";
import type { EnableBankingClient } from "./client";

// Paths predate multi-provider support and are registered in users' Enable Banking apps: keep them.
const CONNECT_PATH = "/setup/connect";
const REMOVE_PATH = "/setup/remove";
const CALLBACK_PATH = "/callback";
const STATE_COOKIE = "enable_banking_setup_state";

const connectSchema = z.object({
  institution: z.string().trim().min(1).max(100),
  country: z.string().trim().length(2).transform((value) => value.toUpperCase()),
  psuType: z.enum(["personal", "business"]),
});
const institutionFilterSchema = connectSchema.omit({ institution: true });

export class EnableBankingSetup implements ProviderSetup {
  constructor(private readonly client: EnableBankingClient) {}

  async handle(request: Request, url: URL): Promise<Response | undefined> {
    if (![CONNECT_PATH, REMOVE_PATH, CALLBACK_PATH].includes(url.pathname)) return undefined;
    const clearCookie = callbackCookie(STATE_COOKIE, CALLBACK_PATH, undefined);
    try {
      if (url.pathname === CONNECT_PATH) {
        if (request.method !== "POST") return methodNotAllowed();
        requireSameOrigin(request);
        const input = connectSchema.parse(await readForm(request));
        const state = crypto.randomUUID();
        const authorizationUrl = await this.client.startAuthorization(input, `${url.origin}${CALLBACK_PATH}`, state);
        return html(authorizationPage(authorizationUrl, "Enable Banking"), 200, callbackCookie(STATE_COOKIE, CALLBACK_PATH, state));
      }
      if (url.pathname === REMOVE_PATH) {
        if (request.method !== "POST") return methodNotAllowed();
        requireSameOrigin(request);
        const form = await readForm(request);
        await this.client.removeConnection(z.uuid().parse(form.sessionId));
        return redirect("/setup?removed=1");
      }
      // Callback
      if (request.method !== "GET") return methodNotAllowed();
      const { code } = await readAuthorizationCallback(request, url, STATE_COOKIE);
      await this.client.completeAuthorization(code);
      return redirect("/setup?connected=1", clearCookie);
    } catch (error) {
      return setupErrorResponse(error, clearCookie);
    }
  }

  async section(request: Request, url: URL): Promise<string> {
    const filter = institutionFilterSchema.safeParse({
      country: url.searchParams.get("country") ?? detectedCountry(request),
      psuType: url.searchParams.get("psuType") ?? "personal",
    });
    const selected = filter.success ? filter.data : undefined;
    const [connections, institutions] = await Promise.all([
      this.client.listConnections(),
      // A failing bank list must not hide the rest of the setup page.
      selected === undefined ? Promise.resolve([]) : this.client.listInstitutions(selected).catch(() => undefined),
    ]);
    const connectionItems = connections
      .map((connection) => {
        const label = connection.institution
          ? `${connection.institution} (${connection.country}) — ${connection.psuType} — ${connection.status} — ${connection.accountCount ?? 0} account(s)`
          : `Session ${connection.sessionId.slice(0, 8)}… — ${connection.status}`;
        return `<li>${escapeHtml(label)}<form method="post" action="${REMOVE_PATH}"><input type="hidden" name="sessionId" value="${escapeHtml(connection.sessionId)}"><button type="submit">Remove</button></form></li>`;
      })
      .join("");
    const institutionOptions = (institutions ?? [])
      .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
      .join("");
    const country = selected?.country ?? "";
    const psuType = selected?.psuType ?? "personal";
    const bankPicker = selected === undefined
      ? "<p>Choose a country and account type to load supported banks.</p>"
      : institutions === undefined
        ? "<p>Enable Banking could not load the bank list. Try again shortly.</p>"
        : institutions.length === 0
          ? "<p>No supported banks found for this selection.</p>"
          : `<form method="post" action="${CONNECT_PATH}"><input type="hidden" name="country" value="${escapeHtml(country)}"><input type="hidden" name="psuType" value="${escapeHtml(psuType)}"><p><label>Bank <select name="institution" required>${institutionOptions}</select></label></p><button type="submit">Continue to bank</button></form>`;

    return `<h2>EU banks (Enable Banking)</h2>
<p>Register this exact callback URL in your Enable Banking application:</p>
<p><code>${escapeHtml(`${url.origin}${CALLBACK_PATH}`)}</code></p>
<h3>Connected banks</h3>
${connections.length === 0 ? "<p>No banks connected.</p>" : `<ul>${connectionItems}</ul>`}
<h3>Connect a bank</h3>
<form method="get" action="/setup">
<p><label>Country <input name="country" required minlength="2" maxlength="2" value="${escapeHtml(country)}" placeholder="IT"></label></p>
<p><label>Account type <select name="psuType"><option value="personal"${psuType === "personal" ? " selected" : ""}>Personal</option><option value="business"${psuType === "business" ? " selected" : ""}>Business</option></select></label></p>
<button type="submit">Show banks</button>
</form>
${bankPicker}`;
  }
}

function detectedCountry(request: Request): string {
  const country = request.cf?.country;
  return typeof country === "string" && country !== "T1" ? country : "";
}
