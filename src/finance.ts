import { z } from "zod";

export const accountIdSchema = z
  .uuid()
  .describe("Opaque Enable Banking account ID discovered from an active authorization session");

export const countryCodeSchema = z
  .string()
  .length(2)
  .describe("ISO 3166-1 alpha-2 country code");

export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .describe("ISO 4217 three-letter currency code");

export const exactDecimalAmountSchema = z
  .string()
  .regex(/^-?\d+(?:\.\d+)?$/)
  .describe("Exact decimal amount encoded as a string; use currency for its unit");

export const nonNegativeDecimalAmountSchema = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/)
  .describe("Exact non-negative decimal amount encoded as a string; use currency for its unit");

export const isoDateSchema = z.iso.date();

export const accountUsageSchema = z.enum(["personal", "professional"]);
export const cashAccountTypeSchema = z.enum([
  "current",
  "card",
  "cash",
  "loan",
  "other",
  "savings",
]);
export const balanceTypeSchema = z.enum([
  "closing_available",
  "closing_booked",
  "forward_available",
  "informational",
  "interim_available",
  "interim_booked",
  "opening_available",
  "opening_booked",
  "other",
  "previously_closed_booked",
  "value_date",
  "instant",
]);
export const transactionStatusSchema = z.enum([
  "booked",
  "cancelled",
  "held",
  "other",
  "pending",
  "rejected",
  "scheduled",
]);

export const accountSummarySchema = z.object({
  accountId: accountIdSchema.describe("Opaque account ID accepted by the other finance tools"),
  institution: z.string().describe("Bank or financial institution reported by Enable Banking"),
  country: countryCodeSchema,
  currency: currencySchema,
  name: z.string().optional().describe("Account holder name reported by the bank"),
  product: z.string().optional().describe("Bank's product name for the account"),
  usage: accountUsageSchema
    .optional()
    .describe("Whether the account is personal or professional"),
  cashAccountType: cashAccountTypeSchema.describe("Normalized functional type of the account"),
});

export const balanceSchema = z.object({
  accountId: accountIdSchema,
  institution: z.string().describe("Bank or financial institution for this balance"),
  country: countryCodeSchema,
  currency: currencySchema,
  amount: exactDecimalAmountSchema,
  balanceType: balanceTypeSchema.describe("Normalized meaning of this balance measurement"),
  referenceDate: isoDateSchema.optional().describe("Date to which this balance applies"),
});

export const accountReadErrorSchema = z.object({
  accountId: accountIdSchema,
  institution: z.string().describe("Bank or financial institution that could not be read"),
  country: countryCodeSchema,
  code: z.string().min(1).max(100).describe("Stable machine-readable failure code"),
  message: z.string().min(1).max(500).describe("Safe explanation without provider payloads"),
});

export const transactionSchema = z.object({
  accountId: accountIdSchema,
  amount: nonNegativeDecimalAmountSchema.describe(
    "Absolute transaction amount as an exact decimal string; direction determines credit or debit",
  ),
  currency: currencySchema,
  direction: z
    .enum(["credit", "debit"])
    .describe("credit adds funds to the account; debit removes funds from the account"),
  status: transactionStatusSchema.describe("Normalized lifecycle status of the transaction"),
  transactionDate: isoDateSchema
    .optional()
    .describe(
      "Bank-reported date when the payment or transaction occurred; use this for questions about when the user spent or paid",
    ),
  bookingDate: isoDateSchema
    .optional()
    .describe(
      "Accounting date the transaction was recorded on the account books; not the date the user made the payment",
    ),
  valueDate: isoDateSchema
    .optional()
    .describe("Date the funds became available for a credit or ceased to be available for a debit"),
  counterparty: z.string().optional().describe("Other party's name when supplied by the bank"),
  description: z
    .string()
    .optional()
    .describe("Combined remittance information and bank-provided transaction note"),
  merchantCategoryCode: z.string().optional().describe("Merchant category code reported by the bank"),
  reference: z.string().optional().describe("Bank-provided transaction entry reference"),
});

export type AccountSummary = z.infer<typeof accountSummarySchema>;
export type AccountReadError = z.infer<typeof accountReadErrorSchema>;
export type AccountUsage = z.infer<typeof accountUsageSchema>;
export type Balance = z.infer<typeof balanceSchema>;
export type BalanceType = z.infer<typeof balanceTypeSchema>;
export type CashAccountType = z.infer<typeof cashAccountTypeSchema>;
export type Transaction = z.infer<typeof transactionSchema>;
export type TransactionStatus = z.infer<typeof transactionStatusSchema>;

export interface SpendingDateResolution {
  effectiveDate?: string;
  inferred: boolean;
}

export function resolveSpendingDate(
  transaction: Pick<Transaction, "transactionDate" | "bookingDate" | "valueDate">,
): SpendingDateResolution {
  if (transaction.transactionDate !== undefined) {
    return { effectiveDate: transaction.transactionDate, inferred: false };
  }

  const fallbackDates = [transaction.bookingDate, transaction.valueDate].filter(
    (date): date is string => date !== undefined,
  );
  if (fallbackDates.length === 0) return { inferred: true };

  return {
    effectiveDate: fallbackDates.reduce((earliest, date) =>
      date < earliest ? date : earliest,
    ),
    inferred: true,
  };
}

export interface TransactionPage {
  transactions: Transaction[];
  continuationKey?: string;
}
