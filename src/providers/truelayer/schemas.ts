import { z } from "zod";
import { MAX_PROVIDER_AMOUNT_LENGTH } from "../../lib/money";

export const MAX_TRUELAYER_ACCOUNTS = 20;
const MAX_TRANSACTIONS_PER_RESPONSE = 5_000;

const text = (max: number) => z.string().max(max);
const currency = z.string().regex(/^[A-Z]{3}$/);
const finiteNumber = z
  .number()
  .finite()
  .refine((value) => String(value).length <= MAX_PROVIDER_AMOUNT_LENGTH);
const nullableOptional = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((value) => value ?? undefined);

export const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(16_384),
  expires_in: z.number().int().positive().max(86_400),
  refresh_token: z.string().min(1).max(8_192).optional(),
});

export const errorResponseSchema = z.object({
  error: z.string().max(200),
});

const providerSchema = z
  .object({
    provider_id: nullableOptional(text(200)),
    display_name: nullableOptional(text(200)),
  })
  .nullish();

export const meSchema = z.object({
  results: z
    .array(
      z.object({
        provider: providerSchema,
        consent_expires_at: nullableOptional(text(100)),
      }),
    )
    .max(10),
});

export const accountsSchema = z.object({
  results: z
    .array(
      z.object({
        account_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        account_type: nullableOptional(text(100)),
        display_name: nullableOptional(text(500)),
        currency,
        provider: providerSchema,
        // Read only to recognise the same account across connections; never returned.
        account_number: z
          .object({
            iban: nullableOptional(text(64)),
            sort_code: nullableOptional(text(16)),
            number: nullableOptional(text(32)),
          })
          .nullish(),
      }),
    )
    .max(MAX_TRUELAYER_ACCOUNTS),
});

export const cardsSchema = z.object({
  results: z
    .array(
      z.object({
        account_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        card_network: nullableOptional(text(100)),
        card_type: nullableOptional(text(100)),
        display_name: nullableOptional(text(500)),
        // Read only to recognise the same card across connections; never returned.
        partial_card_number: nullableOptional(text(32)),
        valid_to: nullableOptional(text(32)),
        currency,
        provider: providerSchema,
      }),
    )
    .max(MAX_TRUELAYER_ACCOUNTS),
});

export const accountBalanceSchema = z.object({
  results: z
    .array(
      z.object({
        currency,
        current: finiteNumber,
        available: nullableOptional(finiteNumber),
        overdraft: nullableOptional(finiteNumber),
      }),
    )
    .max(10),
});

export const cardBalanceSchema = z.object({
  results: z
    .array(
      z.object({
        currency,
        current: finiteNumber,
        available: nullableOptional(finiteNumber),
        credit_limit: nullableOptional(finiteNumber),
        last_statement_balance: nullableOptional(finiteNumber),
        last_statement_date: nullableOptional(text(100)),
      }),
    )
    .max(10),
});

export const transactionsSchema = z.object({
  results: z
    .array(
      z.object({
        timestamp: z.string().regex(/^\d{4}-\d{2}-\d{2}/).max(100),
        description: nullableOptional(text(1_000)),
        amount: finiteNumber,
        currency,
        transaction_type: z.enum(["DEBIT", "CREDIT"]),
        transaction_category: nullableOptional(text(100)),
        merchant_name: nullableOptional(text(500)),
        provider_transaction_id: nullableOptional(text(200)),
        normalised_provider_transaction_id: nullableOptional(text(200)),
        meta: z
          .object({
            provider_reference: nullableOptional(text(500)),
            counter_party_preferred_name: nullableOptional(text(500)),
            provider_merchant_name: nullableOptional(text(500)),
            debtor_account_name: nullableOptional(text(500)),
            provider_category: nullableOptional(text(100)),
            user_comments: nullableOptional(text(1_000)),
          })
          .nullish(),
      }),
    )
    .max(MAX_TRANSACTIONS_PER_RESPONSE),
});

export type TrueLayerTransaction = z.infer<typeof transactionsSchema>["results"][number];
