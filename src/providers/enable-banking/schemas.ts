import { z } from "zod";
import {
  countryCodeSchema,
  currencySchema,
  exactDecimalAmountSchema,
  isoDateSchema,
} from "../../finance";

export const ENABLE_BANKING_ACCOUNT_USAGES = ["ORGA", "PRIV"] as const;
export const ENABLE_BANKING_CASH_ACCOUNT_TYPES = [
  "CACC",
  "CARD",
  "CASH",
  "LOAN",
  "OTHR",
  "SVGS",
] as const;
export const ENABLE_BANKING_BALANCE_TYPES = [
  "CLAV",
  "CLBD",
  "FWAV",
  "INFO",
  "ITAV",
  "ITBD",
  "OPAV",
  "OPBD",
  "OTHR",
  "PRCD",
  "VALU",
  "XPCD",
] as const;

export const ENABLE_BANKING_TRANSACTION_STATUSES = [
  "BOOK",
  "CNCL",
  "HOLD",
  "OTHR",
  "PDNG",
  "RJCT",
  "SCHD",
] as const;

export const ENABLE_BANKING_ERROR_CODES = [
  "ACCESS_DENIED",
  "ACCOUNT_DOES_NOT_EXIST",
  "ALREADY_AUTHORIZED",
  "ASPSP_ACCOUNT_NOT_ACCESSIBLE",
  "ASPSP_ERROR",
  "ASPSP_PAYMENT_NOT_ACCESSIBLE",
  "ASPSP_PSU_ACTION_REQUIRED",
  "ASPSP_RATE_LIMIT_EXCEEDED",
  "ASPSP_TIMEOUT",
  "AUTHORIZATION_NOT_PROVIDED",
  "CLOSED_SESSION",
  "DATE_FROM_IN_FUTURE",
  "DATE_TO_WITHOUT_DATE_FROM",
  "EXPIRED_AUTHORIZATION_CODE",
  "EXPIRED_SESSION",
  "INVALID_ACCOUNT_ID",
  "INVALID_HOST",
  "INVALID_PAYMENT",
  "NO_ACCOUNTS_ADDED",
  "PAYMENT_LIMIT_EXCEEDED",
  "PAYMENT_NOT_AUTHORIZED",
  "PAYMENT_NOT_FINALIZED",
  "PAYMENT_NOT_FOUND",
  "PAYMENT_SUBMISSION_NOT_DEFERRED",
  "PAYMENT_SUBMISSION_NOT_SUPPORTED",
  "PSU_HEADER_INVALID",
  "PSU_HEADER_NOT_PROVIDED",
  "REDIRECT_URI_NOT_ALLOWED",
  "REVOKED_SESSION",
  "SESSION_DOES_NOT_EXIST",
  "TRANSACTION_DOES_NOT_EXIST",
  "UNAUTHORIZED_ACCESS",
  "UNAUTHORIZED_IP",
  "UNTRUSTED_PAYMENT_PARTY",
  "WEBHOOK_URI_NOT_ALLOWED",
  "WRONG_ASPSP_PROVIDED",
  "WRONG_AUTHORIZATION_CODE",
  "WRONG_CONTINUATION_KEY",
  "WRONG_CREDENTIALS_PROVIDED",
  "WRONG_DATE_INTERVAL",
  "WRONG_REQUEST_PARAMETERS",
  "WRONG_SESSION_STATUS",
  "WRONG_TRANSACTIONS_PERIOD",
] as const;

export const MAX_ENABLE_BANKING_ACCOUNTS = 20;

export type EnableBankingAccountUsage = (typeof ENABLE_BANKING_ACCOUNT_USAGES)[number];
export type EnableBankingCashAccountType = (typeof ENABLE_BANKING_CASH_ACCOUNT_TYPES)[number];
export type EnableBankingBalanceType = (typeof ENABLE_BANKING_BALANCE_TYPES)[number];
export type EnableBankingTransactionStatus = (typeof ENABLE_BANKING_TRANSACTION_STATUSES)[number];

const amountSchema = z.object({
  currency: currencySchema,
  amount: exactDecimalAmountSchema,
});

export const aspspSchema = z.object({
  name: z.string(),
  country: countryCodeSchema,
});

export const aspspsSchema = z.object({
  aspsps: z.array(
    aspspSchema.extend({
      maximum_consent_validity: z.number().int().positive(),
    }),
  ),
});

export const startAuthorizationResponseSchema = z.object({
  url: z.url(),
  authorization_id: z.uuid(),
});

export const authorizeSessionResponseSchema = z.object({
  session_id: z.uuid(),
  aspsp: aspspSchema,
  psu_type: z.enum(["business", "personal"]),
});

export const sessionSchema = z.object({
  status: z.enum([
    "AUTHORIZED",
    "CANCELLED",
    "CLOSED",
    "EXPIRED",
    "INVALID",
    "PENDING_AUTHORIZATION",
    "RETURNED_FROM_BANK",
    "REVOKED",
  ]),
  accounts: z.array(z.uuid()).max(MAX_ENABLE_BANKING_ACCOUNTS),
  aspsp: aspspSchema,
  psu_type: z.enum(["business", "personal"]),
});

export const accountDetailsSchema = z.object({
  name: z.string().nullable().optional(),
  currency: currencySchema,
  product: z.string().nullable().optional(),
  usage: z.enum(ENABLE_BANKING_ACCOUNT_USAGES).nullable().optional(),
  cash_account_type: z.enum(ENABLE_BANKING_CASH_ACCOUNT_TYPES),
});

const balanceSchema = z.object({
  name: z.string(),
  balance_amount: amountSchema,
  balance_type: z.enum(ENABLE_BANKING_BALANCE_TYPES),
  reference_date: isoDateSchema.optional(),
});

export const balancesSchema = z.object({ balances: z.array(balanceSchema) });

// ASPSPs encode absent optional transaction values as either omitted or null.
function optionalProviderField<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => (value === null ? undefined : value),
    schema.optional(),
  );
}

const partyIdentificationSchema = z.object({
  name: optionalProviderField(z.string()),
});

const transactionSchema = z.object({
  transaction_amount: amountSchema,
  credit_debit_indicator: z.enum(["CRDT", "DBIT"]),
  status: z.enum(ENABLE_BANKING_TRANSACTION_STATUSES),
  booking_date: optionalProviderField(isoDateSchema),
  value_date: optionalProviderField(isoDateSchema),
  creditor: optionalProviderField(partyIdentificationSchema),
  debtor: optionalProviderField(partyIdentificationSchema),
  merchant_category_code: optionalProviderField(z.string()),
  remittance_information: optionalProviderField(z.array(z.string())),
  note: optionalProviderField(z.string()),
  entry_reference: optionalProviderField(z.string()),
});

export const transactionsSchema = z.object({
  transactions: z.array(transactionSchema),
  continuation_key: z.string().nullable().optional(),
});

export const errorResponseSchema = z.object({
  error: z.enum(ENABLE_BANKING_ERROR_CODES).optional(),
});

export type EnableBankingTransaction = z.infer<typeof transactionSchema>;
export type EnableBankingSession = z.infer<typeof sessionSchema>;
