import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { Money, MAX_PROVIDER_AMOUNT_LENGTH } from "../src/money";
import { transactionsSchema } from "../src/providers/enable-banking/schemas";

describe("Exact financial arithmetic", () => {
  it("preserves widely different decimal scales and 10,000-entry carries", () => {
    const integer = "9".repeat(MAX_PROVIDER_AMOUNT_LENGTH);
    const fraction = `0.${"0".repeat(MAX_PROVIDER_AMOUNT_LENGTH - 3)}1`;
    const total = new Money(integer).plus(fraction).times(10_000);
    expect(total.minus(new Money(integer).times(10_000)).toFixed()).toBe(
      `0.${"0".repeat(MAX_PROVIDER_AMOUNT_LENGTH - 7)}1`,
    );
    expect(Decimal.precision).toBe(20);
  });

  it("rejects provider amounts beyond the arithmetic input bound", () => {
    const page = (amount: string) => ({ transactions: [{
      transaction_amount: { amount, currency: "EUR" }, credit_debit_indicator: "CRDT", status: "BOOK",
    }] });
    expect(transactionsSchema.safeParse(page("9".repeat(MAX_PROVIDER_AMOUNT_LENGTH))).success).toBe(true);
    expect(transactionsSchema.safeParse(page("9".repeat(MAX_PROVIDER_AMOUNT_LENGTH + 1))).success).toBe(false);
  });
});
