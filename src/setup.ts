// The protected /setup page: a shell that delegates to each configured provider.
import { escapeHtml, html, methodNotAllowed, redirect } from "./lib/web";
import { PROVIDER_MODULES } from "./providers/registry";
import type { BankProvider } from "./providers/types";

const MESSAGES: Record<string, string> = {
  connected: "Bank connected.",
  renewed: "Bank reconnected. The previous connection was removed.",
  removed: "Connection removed.",
};

/** Handles /, /setup, and every provider's setup and callback routes; undefined for other paths. */
export async function handleSetupRequest(
  request: Request,
  providers: readonly BankProvider[],
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname === "/") {
    if (request.method !== "GET") return methodNotAllowed();
    return redirect("/setup");
  }
  if (url.pathname === "/setup") {
    if (request.method !== "GET") return methodNotAllowed();
    return html(await setupPage(request, url, providers));
  }
  for (const provider of providers) {
    const response = await provider.setup.handle(request, url);
    if (response !== undefined) return response;
  }
  return undefined;
}

async function setupPage(request: Request, url: URL, providers: readonly BankProvider[]): Promise<string> {
  const message = Object.entries(MESSAGES).find(([key]) => url.searchParams.has(key))?.[1];
  // One provider failing to render must not hide the others.
  const sections = await Promise.all(providers.map((provider) =>
    provider.setup.section(request, url).catch(() =>
      `<h2>${escapeHtml(provider.label)}</h2><p>This provider could not load its connections. Try again shortly.</p>`)));

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Personal Finance MCP setup</title></head>
<body>
<main>
<h1>Personal Finance MCP</h1>
${message === undefined ? "" : `<p><strong>${escapeHtml(message)}</strong></p>`}
${sections.length === 0 ? NO_PROVIDERS : sections.join("\n")}
</main>
</body>
</html>`;
}

const NO_PROVIDERS = `<p>No bank-data provider is configured. Set the Worker secrets for at least one:</p>
<ul>
${PROVIDER_MODULES.map((module) =>
  `<li>${escapeHtml(module.label)}: ${module.secrets.map((name) => `<code>${escapeHtml(name)}</code>`).join(", ")}</li>`).join("\n")}
</ul>
<p>Providers that store credentials, such as TrueLayer, also need <code>TOKEN_ENCRYPTION_KEY</code> (<code>openssl rand -base64 32</code>).</p>`;
