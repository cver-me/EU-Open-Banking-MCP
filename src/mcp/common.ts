import { z } from "zod";
import { errorMessage } from "../errors";
import { isoDateSchema, providerErrorSchema, type ProviderError } from "../finance";
import { differenceInDays, todayIsoDate } from "../lib/dates";

export const MAX_DATE_RANGE_DAYS = 366;

export const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const providerErrorsSchema = z
  .array(providerErrorSchema)
  .optional()
  .describe("Providers that could not be read; their accounts are missing from this result. Present only when non-empty");

export const dateRangeSchema = z
  .object({
    dateFrom: isoDateSchema.describe("Inclusive start date in YYYY-MM-DD format"),
    dateTo: isoDateSchema.describe("Inclusive end date in YYYY-MM-DD format"),
  })
  .superRefine(({ dateFrom, dateTo }, context) => {
    const days = differenceInDays(dateFrom, dateTo);
    const today = todayIsoDate();
    if (dateFrom > today) {
      context.addIssue({
        code: "custom",
        path: ["dateFrom"],
        // Models often do not know today's date; say it so the next call can be right.
        message: `dateFrom must not be in the future; today is ${today} (UTC)`,
      });
    }
    if (days < 0) context.addIssue({ code: "custom", message: "dateTo must not precede dateFrom" });
    if (days + 1 > MAX_DATE_RANGE_DAYS) {
      context.addIssue({ code: "custom", message: `Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days` });
    }
  });

export function withProviderErrors(providerErrors: ProviderError[]): { providerErrors?: ProviderError[] } {
  return providerErrors.length === 0 ? {} : { providerErrors };
}

export async function safeResult<T extends Record<string, unknown>>(
  operation: () => Promise<T>,
): Promise<
  | { content: [{ type: "text"; text: string }]; structuredContent: T }
  | { content: [{ type: "text"; text: string }]; isError: true }
> {
  try {
    const output = await operation();
    return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
  } catch (error) {
    return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
  }
}
