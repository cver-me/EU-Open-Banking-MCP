// HTML, form, cookie, and CSRF helpers for the protected /setup pages.
import { PublicError } from "../errors";
import { readBoundedText } from "./http";

const MAX_FORM_BYTES = 4_096;

export function html(body: string, status = 200, cookie?: string): Response {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  if (cookie !== undefined) headers.set("Set-Cookie", cookie);
  return new Response(body, { status, headers });
}

export function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location });
  if (cookie !== undefined) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export function methodNotAllowed(): Response {
  return new Response("Method not allowed", { status: 405 });
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Setup error</title></head><body><main><h1>Setup could not continue</h1><p>${escapeHtml(message)}</p><p><a href="/setup">Return to setup</a></p></main></body></html>`;
}

/** Interstitial with a plain link: form-action 'self' forbids redirecting a form post to the bank. */
export function authorizationPage(authorizationUrl: string, providerLabel: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Continue to bank</title></head><body><main><h1>Continue to your bank</h1><p>${escapeHtml(providerLabel)} is ready to connect your account.</p><p><a href="${escapeHtml(authorizationUrl)}" rel="noreferrer">Open bank</a></p><p><a href="/setup">Cancel</a></p></main></body></html>`;
}

/** Reads a small urlencoded form; an empty object when the request has no form body. */
export async function readForm(request: Request, { optional = false } = {}): Promise<Record<string, string>> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    if (optional && request.body === null) return {};
    throw new PublicError("Unsupported form content type.", "invalid_form");
  }
  const text = await readBoundedText(
    request,
    MAX_FORM_BYTES,
    new PublicError("The setup form was unexpectedly large.", "invalid_form"),
  );
  return Object.fromEntries(new URLSearchParams(text));
}

/** Rejects cross-site form posts to setup routes. */
export function requireSameOrigin(request: Request): void {
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

/** A short-lived, HttpOnly cookie scoped to one callback path. */
export function callbackCookie(name: string, path: string, value: string | undefined): string {
  return value === undefined
    ? `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
    : `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
}

export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [cookieName, ...valueParts] = part.trim().split("=");
    if (cookieName === name) return decodeURIComponent(valueParts.join("="));
  }
  return undefined;
}

/** Constant-time comparison for OAuth state values. */
export async function tokensMatch(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}
