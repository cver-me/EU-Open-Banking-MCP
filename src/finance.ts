import { z } from "zod";

// Each provider issues its own ID format; the aggregate routes IDs to the provider that owns them.
export const accountIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,140}$/)
  .describe("Opaque account ID discovered by finance_list_accounts from an active bank connection");

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
  .describe("Exact decimal amount as a string, with at least the currency's minor-unit digits (\"9000.00\" GBP, \"1500\" JPY); never rounded. Always read it together with its currency");

export const nonNegativeDecimalAmountSchema = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/)
  .describe("Exact non-negative decimal amount as a string, with at least the currency's minor-unit digits; never rounded. Always read it together with its currency");

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
  institution: z.string().describe("Bank or financial institution reported by the data provider"),
  country: countryCodeSchema.describe("Country of the bank; does not imply the account's currency"),
  currency: currencySchema.describe("The account's own currency. Not implied by country: a UK bank can hold a EUR account and an EU bank a GBP account. Balances and transactions state their own currency"),
  name: z.string().optional().describe("Account holder name reported by the bank"),
  product: z.string().optional().describe("Bank's product name for the account"),
  description: z.string().optional().describe("Account description supplied by the bank or account owner"),
  usage: accountUsageSchema
    .optional()
    .describe("Whether the account is personal or professional"),
  cashAccountType: cashAccountTypeSchema.describe("Normalized functional type of the account"),
});

export const balanceSchema = z.object({
  accountId: accountIdSchema,
  institution: z.string().describe("Bank or financial institution for this balance"),
  country: countryCodeSchema,
  currency: currencySchema.describe("Currency of this balance amount"),
  amount: exactDecimalAmountSchema,
  balanceType: balanceTypeSchema.describe("Normalized meaning of this balance measurement"),
  label: z.string().optional().describe("Bank-provided balance label; use it to interpret other or ambiguous balance types"),
  referenceDate: isoDateSchema.optional().describe("Date to which this balance applies"),
  lastChangedAt: z.iso.datetime({ offset: true }).optional().describe("Bank-reported time this balance last changed; not the time it was fetched"),
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
  currency: currencySchema.describe("Currency of this transaction amount; can differ from the account's currency"),
  direction: z
    .enum(["credit", "debit"])
    .describe("credit adds funds to the account; debit removes funds from the account"),
  status: transactionStatusSchema.describe("Normalized lifecycle status of the transaction"),
  transactionDate: isoDateSchema
    .optional()
    .describe(
      "Bank-reported transaction date: purchase date for cards, acquiring date for transfers, receiving date for direct debits",
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
    .describe("Combined remittance information and account owner's transaction note"),
  merchantCategoryCode: z.string().optional().describe("Merchant category code reported by the bank"),
  reference: z.string().optional().describe("Bank-provided immutable entry reference, unique within the account; not a payment reference"),
  paymentReference: z.string().optional().describe("Structured creditor/payment reference supplied by the bank"),
  bankTransactionDescription: z.string().optional()
    .describe("Bank-provided description of the transaction type; not an inferred spending category"),
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
  source: "transaction_date" | "booking_date" | "value_date" | "unknown";
}

export function resolveSpendingDate(
  transaction: Pick<Transaction, "transactionDate" | "bookingDate" | "valueDate">,
): SpendingDateResolution {
  if (transaction.transactionDate !== undefined) {
    return { effectiveDate: transaction.transactionDate, inferred: false, source: "transaction_date" };
  }

  if (transaction.bookingDate !== undefined &&
      (transaction.valueDate === undefined || transaction.bookingDate <= transaction.valueDate)) {
    return { effectiveDate: transaction.bookingDate, inferred: true, source: "booking_date" };
  }
  if (transaction.valueDate !== undefined) {
    return { effectiveDate: transaction.valueDate, inferred: true, source: "value_date" };
  }
  return { inferred: true, source: "unknown" };
}

export interface TransactionPage {
  transactions: Transaction[];
  continuationKey?: string;
  /** The bank refused to share part of the requested range; no older pages follow. */
  historyUnavailable?: boolean;
}

// Provider keys come from the provider modules; shared schemas don't list them.
export const providerKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
export type ProviderKey = z.infer<typeof providerKeySchema>;

export const providerErrorSchema = z.object({
  provider: providerKeySchema.describe("Key of the data provider that could not be read; its accounts are missing from the result"),
  code: z.string().min(1).max(100).describe("Stable machine-readable failure code"),
  message: z.string().min(1).max(500).describe("Safe explanation without provider payloads"),
});
export type ProviderError = z.infer<typeof providerErrorSchema>;

export const connectionStateSchema = z.enum(["active", "expiring_soon", "expired", "needs_reconnect", "unavailable"]);
export type ConnectionState = z.infer<typeof connectionStateSchema>;

/** One bank connection (consent) and whether it still gives access. */
export const connectionStatusSchema = z.object({
  provider: providerKeySchema.describe("Data provider that holds this connection"),
  institution: z.string().optional().describe("Bank the connection is with"),
  country: countryCodeSchema.optional(),
  state: connectionStateSchema.describe("expiring_soon: consent ends within 14 days; expired and needs_reconnect: no data until the owner reconnects at /setup; unavailable: the provider could not report this connection"),
  consentExpiresAt: z.string().optional().describe("When the bank consent ends, as reported by the provider"),
  accountCount: z.number().int().optional(),
});
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
