// Behaviour every provider adapter must share so tools see the same errors and shapes.
import type { z } from "zod";
import { errorMessage, PublicError } from "../errors";
import type { AccountReadError } from "../finance";

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

/** Codes after which further reads at the same bank in this request would fail the same way. */
export function isBankRateLimit(error: unknown): boolean {
  return error instanceof PublicError &&
    (error.code === "aspsp_rate_limited" || error.code === "provider_rate_limited");
}

export function accountReadError(
  account: { accountId: string; institution: string; country: string },
  error: unknown,
): AccountReadError {
  return {
    accountId: account.accountId,
    institution: account.institution,
    country: account.country,
    code: error instanceof PublicError ? error.code : "provider_error",
    message: errorMessage(error),
  };
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
