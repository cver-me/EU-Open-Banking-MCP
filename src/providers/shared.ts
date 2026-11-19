// Behaviour every provider adapter must share so tools see the same errors and shapes.
import type { z } from "zod";
import { errorMessage, PublicError } from "../errors";
import type { AccountReadError, Balance } from "../finance";
import { readBoundedJson } from "../lib/http";
import type { BalanceReadResult } from "./types";

const REQUEST_TIMEOUT_MS = 10_000;

export function setupRequired(): PublicError {
  return new PublicError(
    "No active bank authorization is available. Open /setup to connect or renew a bank.",
    "setup_required",
  );
}

export function unknownAccount(): PublicError {
  return new PublicError(
    "Unknown or inactive account ID. Call finance_list_accounts again.",
    "unknown_account",
  );
}

export function providerTimeout(providerLabel: string): PublicError {
  return new PublicError(`${providerLabel} timed out. Try again shortly.`, "provider_timeout");
}

/** Shared code for "the bank refused more reads right now"; providers map their own codes onto it. */
export function bankRateLimited(): PublicError {
  return new PublicError("The bank rate-limited account data access. Do not retry immediately.", "aspsp_rate_limited");
}

/** Codes after which further reads at the same bank in this request would fail the same way. */
export function isBankRateLimit(error: unknown): boolean {
  return error instanceof PublicError &&
    (error.code === "aspsp_rate_limited" || error.code === "provider_rate_limited");
}

export function isSetupRequired(error: unknown): boolean {
  return error instanceof PublicError && error.code === "setup_required";
}

/** The code and message a tool may show for any error, without provider payloads. */
export function publicErrorFields(error: unknown): { code: string; message: string } {
  return { code: error instanceof PublicError ? error.code : "provider_error", message: errorMessage(error) };
}

export function accountReadError(
  account: { accountId: string; institution: string; country: string },
  error: unknown,
): AccountReadError {
  return { accountId: account.accountId, institution: account.institution, country: account.country, ...publicErrorFields(error) };
}

/**
 * Reads balances group by group (a group is one bank login), groups in parallel and
 * accounts within a group in order. After a bank rate limit, the rest of that group
 * is reported as rate-limited without being called.
 */
export async function readGroupedBalances<A extends { accountId: string; institution: string; country: string }>(
  groups: readonly A[][],
  read: (account: A) => Promise<Balance[]>,
): Promise<BalanceReadResult> {
  const results = await Promise.all(groups.map(async (group) => {
    const balances: Balance[] = [];
    const errors: AccountReadError[] = [];
    for (const [index, account] of group.entries()) {
      try {
        balances.push(...(await read(account)));
      } catch (error) {
        errors.push(accountReadError(account, error));
        if (isBankRateLimit(error)) {
          for (const skipped of group.slice(index + 1)) errors.push(accountReadError(skipped, error));
          break;
        }
      }
    }
    return { balances, errors };
  }));
  return { balances: results.flatMap((r) => r.balances), errors: results.flatMap((r) => r.errors) };
}

export function groupBy<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group === undefined) groups.set(key(item), [item]);
    else group.push(item);
  }
  return [...groups.values()];
}

/** Keeps the first item per key; items without a key are always kept. */
export function uniqueBy<T>(items: readonly T[], key: (item: T) => string | undefined): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (value === undefined) return true;
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

export interface ProviderRequest {
  url: string;
  method: "DELETE" | "GET" | "POST";
  headers?: Headers;
  /** JSON request body. */
  body?: string;
  providerLabel: string;
  /** Normalized operation name for logs; never contains identifiers. */
  operation: string;
  maxBytes?: number;
  /** False when the response has no body to read (for example a DELETE). */
  parseBody?: boolean;
  /** Maps a non-2xx response to a PublicError (see readProviderErrorCode and statusFallbackError). */
  toError(response: Response): Promise<PublicError>;
}

/** The one HTTP path to a provider: bounded time and size, no redirects, logs without identifiers. */
export async function providerFetch(request: ProviderRequest): Promise<unknown> {
  const headers = new Headers(request.headers);
  headers.set("Accept", "application/json");
  if (request.body !== undefined) headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw providerTimeout(request.providerLabel);
    console.error(JSON.stringify({
      message: `${request.providerLabel} fetch threw`,
      operation: request.operation,
      errorType: error instanceof Error ? error.name : typeof error,
    }));
    throw error;
  }

  if (response.status >= 300 && response.status < 400) {
    console.warn(JSON.stringify({
      message: `${request.providerLabel} redirect rejected`,
      operation: request.operation,
      status: response.status,
    }));
    throw new PublicError(`${request.providerLabel} returned an unexpected redirect.`, "provider_redirect_rejected");
  }
  if (!response.ok) throw await request.toError(response);
  if (request.parseBody === false) return null;
  return request.maxBytes === undefined ? readBoundedJson(response) : readBoundedJson(response, request.maxBytes);
}

/** Reads the provider's error code from a failed response and logs it with the status. */
export async function readProviderErrorCode(
  response: Response,
  schema: z.ZodType<{ error?: string | undefined }>,
  context: { providerLabel: string; operation: string },
): Promise<string | undefined> {
  let errorCode: string | undefined;
  try {
    const parsed = schema.safeParse(await readBoundedJson(response));
    if (parsed.success) errorCode = parsed.data.error;
  } catch {
    // Status-based handling remains safe when an error body is absent or malformed.
  }
  const retryAfter = response.headers.get("Retry-After");
  console.warn(JSON.stringify({
    message: `${context.providerLabel} request failed`,
    operation: context.operation,
    status: response.status,
    errorCode: errorCode ?? "unknown",
    ...(retryAfter === null || retryAfter.length > 100 ? {} : { retryAfter }),
  }));
  return errorCode;
}

/** Errors for statuses no provider-specific code explained. */
export function statusFallbackError(providerLabel: string, status: number): PublicError {
  if (status === 429) return new PublicError(`${providerLabel} rate-limited this request. Try again shortly.`, "provider_rate_limited");
  if (status === 403) return new PublicError(`${providerLabel} denied access to this account or service.`, "provider_access_denied");
  if (status === 404) return new PublicError("The configured account or connection is unavailable.", "provider_not_found");
  return new PublicError(`${providerLabel} could not complete this request.`, "provider_error");
}

/** Validates a provider payload; logs only issue codes and paths, never values. */
export function parseProviderResponse<T extends z.ZodType>(
  schema: T,
  value: unknown,
  context: { providerLabel: string; operation: string; dataKind: string },
): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  console.error(JSON.stringify({
    message: `${context.providerLabel} response validation failed`,
    operation: context.operation,
    issueCount: parsed.error.issues.length,
    issues: parsed.error.issues.slice(0, 10).map((issue) => ({
      code: issue.code,
      path: issue.path.map(String).join("."),
    })),
  }));
  throw new PublicError(
    `${context.providerLabel} returned unsupported ${context.dataKind} data.`,
    "provider_response_invalid",
  );
}

export function optionalText(value: string | null | undefined): string | undefined {
  return value?.trim() || undefined;
}
