import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { formatAmount, Money, MAX_PROVIDER_AMOUNT_LENGTH } from "../src/lib/money";
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

describe("formatAmount", () => {
  it.each([
    ["9000", "GBP", "9000.00"],
    [9000, "EUR", "9000.00"],
    ["-12.5", "EUR", "-12.50"],
    ["1600.00", "EUR", "1600.00"],
    // Extra digits a bank reports are kept, never rounded away.
    ["1.234", "EUR", "1.234"],
    ["1500", "JPY", "1500"],
    ["1.5", "KWD", "1.500"],
    ["-0", "GBP", "0.00"],
    ["7", "XXQ", "7.00"],
  ])("formats %s %s as %s", (value, currency, expected) => {
    expect(formatAmount(value, currency)).toBe(expected);
  });
});
