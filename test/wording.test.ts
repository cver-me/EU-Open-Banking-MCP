import { describe, expect, it } from "vitest";
import { analyzeTransactions } from "../src/analysis/classify";
import { payeeOf } from "../src/analysis/payee";
import { CASH_WORDING, FEE_WORDING, OWN_MONEY_WORDING, PAYEE_WORDING, REFUND_WORDING, type WordingRule } from "../src/analysis/wording";
import type { Transaction } from "../src/finance";

const kindOf = (description: string, direction: "debit" | "credit", counterparty?: string) => {
  const transaction: Transaction = {
    accountId: "a1", amount: "10.00", currency: "EUR", direction, status: "booked",
    transactionDate: "2026-11-01", description, ...(counterparty === undefined ? {} : { counterparty }),
  };
  return analyzeTransactions([transaction], [{ accountId: "a1", institution: "Bank", country: "DE", currency: "EUR", cashAccountType: "current" }])
    .analyzed[0]!.kind;
};

const cases = (rules: readonly WordingRule[]) => rules.map((rule) => [rule.source, rule.example] as const);

describe("bank and language wording", () => {
  it.each(cases(FEE_WORDING))("labels a %s fee: %s", (_source, example) => {
    expect(kindOf(example, "debit")).toBe("fee");
  });

  it.each(cases(CASH_WORDING))("labels a %s cash withdrawal: %s", (_source, example) => {
    expect(kindOf(example, "debit")).toBe("cash_withdrawal");
  });

  it.each(cases(REFUND_WORDING))("labels a %s refund: %s", (_source, example) => {
    expect(kindOf(example, "credit")).toBe("refund");
  });

  it.each(cases(OWN_MONEY_WORDING))("labels %s own-money wording: %s", (_source, example) => {
    expect(kindOf(example, "debit")).toBe("internal_transfer");
  });

  it.each(cases(PAYEE_WORDING))("reads the payee out of %s wording: %s", (_source, example) => {
    const { name } = payeeOf({ description: example });
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThan(example.length);
    expect(name).not.toMatch(/\d{4}|XXXX|PAGAM|Bonifico/i);
  });

  it.each([
    // Ordinary purchases whose names contain no fee, cash or refund word on its own.
    ["Supercharger Milano", "debit", "spending"],
    ["Parkeerkosten Centrum", "debit", "spending"],
    ["Bar Interessante", "debit", "spending"],
    ["Retraite Spa Resort", "debit", "spending"],
    ["Cashpoint Café", "credit", "income"],
    ["Rendement Investeringen", "credit", "income"],
  ] as const)("does not over-read %s", (description, direction, kind) => {
    expect(kindOf(description, direction)).toBe(kind);
  });

  it("applies pocket wording only when the bank names no counterparty", () => {
    expect(kindOf("To EUR Personal", "debit")).toBe("internal_transfer");
    expect(kindOf("To EUR Personal", "debit", "Some Shop")).toBe("spending");
  });
});
