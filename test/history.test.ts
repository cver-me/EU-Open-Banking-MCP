import { describe, expect, it } from "vitest";
import { readHistory, scanAccount } from "../src/analysis/history";
import type { AccountSummary, Transaction, TransactionPage } from "../src/finance";

const account = (accountId: string, institution: string): AccountSummary => ({
  accountId, institution, country: "IT", currency: "EUR", cashAccountType: "current",
});

const debit = (accountId: string, reference: string): Transaction => ({
  accountId, amount: "1.00", currency: "EUR", direction: "debit", status: "booked", transactionDate: "2026-11-01", reference,
});

/** A provider whose pages answer only when the test releases them, recording the order of requests. */
function deferredProvider(accounts: AccountSummary[], pages: Record<string, TransactionPage[]>) {
  const requested: string[] = [];
  const waiting: Array<() => void> = [];
  return {
    requested,
    releaseAll: () => waiting.splice(0).forEach((release) => release()),
    provider: {
      listAccounts: async () => ({ value: accounts, providerErrors: [] }),
      listTransactions: (accountId: string, query: { continuationKey?: string }) => {
        requested.push(`${accountId}:${query.continuationKey ?? "first"}`);
        const page = pages[accountId]![query.continuationKey === undefined ? 0 : Number(query.continuationKey)]!;
        if (page instanceof Error) return Promise.reject(page);
        return new Promise<TransactionPage>((resolve) => waiting.push(() => resolve(page)));
      },
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("readHistory", () => {
  it("reads different banks at the same time and one bank's accounts in turn", async () => {
    const { provider, requested, releaseAll } = deferredProvider(
      [account("a1", "Bank A"), account("a2", "Bank A"), account("b1", "Bank B")],
      {
        a1: [{ transactions: [debit("a1", "x1")] }],
        a2: [{ transactions: [debit("a2", "x2")] }],
        b1: [{ transactions: [debit("b1", "y1")] }],
      },
    );
    const reading = readHistory(await provider.listAccounts(), scanAccount(provider), { dateFrom: "2026-11-01", dateTo: "2026-11-19" }, { maxPages: 10 });
    await flush();
    // Both banks asked at once; Bank A's second account waits for its first.
    expect(requested).toEqual(["a1:first", "b1:first"]);
    releaseAll();
    await flush();
    expect(requested).toEqual(["a1:first", "b1:first", "a2:first"]);
    releaseAll();
    const history = await reading;
    // The result keeps account order whichever bank answered first.
    expect(history.transactions.map(({ reference }) => reference)).toEqual(["x1", "x2", "y1"]);
    expect(history).toMatchObject({ complete: true, pagesScanned: 3 });
  });

  it("shares one page budget across banks read in parallel", async () => {
    const pagesOf = (accountId: string) => Array.from({ length: 5 }, (_, index) => ({
      transactions: [debit(accountId, `${accountId}-${index}`)],
      ...(index < 4 ? { continuationKey: String(index + 1) } : {}),
    }));
    const { provider, releaseAll } = deferredProvider(
      [account("a1", "Bank A"), account("b1", "Bank B")],
      { a1: pagesOf("a1"), b1: pagesOf("b1") },
    );
    const reading = readHistory(await provider.listAccounts(), scanAccount(provider), { dateFrom: "2026-11-01", dateTo: "2026-11-19" }, { maxPages: 6 });
    for (let round = 0; round < 10; round += 1) {
      await flush();
      releaseAll();
    }
    const history = await reading;
    expect(history.pagesScanned).toBe(6);
    expect(history.transactions).toHaveLength(6);
    expect(history).toMatchObject({ complete: false, incompleteReasons: ["page_limit"] });
  });
});
