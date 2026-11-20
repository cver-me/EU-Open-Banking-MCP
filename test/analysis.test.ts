import { describe, expect, it } from "vitest";
import { breakDown } from "../src/analysis/breakdown";
import { summarizeCashFlow } from "../src/analysis/cash-flow";
import { analyzeTransactions } from "../src/analysis/classify";
import { payeeKey, payeeOf } from "../src/analysis/payee";
import { comparisonRange, periodsIn, shiftMonths } from "../src/analysis/periods";
import { findRecurring, projectUpcoming } from "../src/analysis/recurring";
import { reviewActivity } from "../src/analysis/review";
import type { AccountSummary, Transaction } from "../src/finance";

const account = (accountId: string, overrides: Partial<AccountSummary> = {}): AccountSummary => ({
  accountId, institution: "Example Bank", country: "IT", currency: "EUR", cashAccountType: "current", ...overrides,
});

let sequence = 0;
const tx = (
  amount: string,
  date: string,
  overrides: Partial<Transaction> = {},
): Transaction => ({
  accountId: "a1",
  amount: amount.replace("-", ""),
  currency: "EUR",
  direction: amount.startsWith("-") ? "debit" : "credit",
  status: "booked",
  transactionDate: date,
  reference: `ref-${(sequence += 1)}`,
  ...overrides,
});

const analyze = (transactions: Transaction[], accounts = [account("a1"), account("a2")]) =>
  analyzeTransactions(transactions, accounts).analyzed;

describe("payeeOf", () => {
  it.each([
    [{ description: "PAGAMENTO POS EFFETTUATO IL 15/11/2026 ALLE ORE 09:17 MEDIANTE LA CARTA 1234 XXXX XXXX XX56 PRESSO SUPERMERCATO ESEMPIO" }, "SUPERMERCATO ESEMPIO"],
    [{ description: "PAGAM. TRAMITE POS BAR ESEMPIO VIA ROMA26/10-09:27 - Carta n.1234 XXXX XXXX XX56ABI : 01234" }, "BAR ESEMPIO VIA ROMA"],
    [{ description: "PAGAM. TRAMITE POS Pagamento su POS PANE & PANE 1 15/11-16:03 - Carta n.1234 XXXX XXXX XX56" }, "PANE & PANE"],
    [{ description: "ADDEBITO BON IST 0126110665373522 Bonifico da Voi disposto a favore di: Mario Rossi" }, "Mario Rossi"],
    [{ description: "ACCR. BEU COD.DISP.: 0126092544937168 Bonifico a Vostro favore disposto da: MITT.: PayPal Euro" }, "PayPal Euro"],
    [{ counterparty: "Google Cloud Mnj3ph" }, "Google Cloud"],
    [{ counterparty: "Algolia 2f2610520693" }, "Algolia"],
    [{ counterparty: "AMAZON* 620YJ5NY5" }, "AMAZON"],
    [{ counterparty: "Fiscozen* Fiscozen" }, "Fiscozen"],
    [{ counterparty: "1pMobile" }, "1pMobile"],
    [{ description: "SQSP* DOMAIN#256980392 NEW YORK" }, "SQSP DOMAIN NEW YORK"],
    [{ counterparty: "ExampleairQXZ42K", description: "Exampleair" }, "Exampleair"],
    [{ counterparty: "Casello Milano Sud -", description: "Casellomilano Sud" }, "Casello Milano Sud"],
  ])("reads %o as %s", (transaction, name) => {
    expect(payeeOf(transaction).name).toBe(name);
  });

  it("gives one key to one merchant however the bank writes it", () => {
    expect(payeeOf({ counterparty: "Marks & Spencer" }).key).toBe(payeeOf({ counterparty: "MARKS&SPENCER PLC" }).key);
    expect(payeeOf({ counterparty: "Google Cloud Wf7jwn" }).key).toBe(payeeOf({ counterparty: "Google Cloud T2vxw8" }).key);
    expect(payeeOf({ counterparty: "LAGENCY S.R.L." }).key).toBe("lagency");
    expect(payeeKey("Supermercato Esempio")).toBe(payeeOf({ description: "… PRESSO SUPERMERCATO ESEMPIO" }).key);
    expect(payeeOf({ counterparty: "Café de Flore" }).key).toBe(payeeOf({ counterparty: "CAFE DE FLORE" }).key);
    expect(payeeOf({ counterparty: "Beispiel Handel GmbH" }).key).toBe("beispiel handel");
    expect(payeeOf({ counterparty: "Ejemplo Comercio S.L." }).key).toBe("ejemplo comercio");
  });

  it("keeps names in other scripts instead of dropping them", () => {
    expect(payeeOf({ counterparty: "ΚΑΦΕ ΠΑΡΑΔΕΙΓΜΑ" })).toEqual({ key: "καφε παραδειγμα", name: "ΚΑΦΕ ΠΑΡΑΔΕΙΓΜΑ" });
    expect(payeeOf({ counterparty: "Пример ООД" }).key).toBe("пример оод");
  });

  it("reports an unknown payee rather than an empty one", () => {
    expect(payeeOf({})).toEqual({ key: "unknown", name: "Unknown" });
    expect(payeeOf({ description: "***" })).toEqual({ key: "unknown", name: "Unknown" });
  });
});

describe("analyzeTransactions", () => {
  it("matches a transfer between two connected accounts", () => {
    const items = analyze([
      tx("-500.00", "2026-11-15", { counterparty: "Instant savings", description: "Transfer into Easy Saver" }),
      tx("500.00", "2026-11-16", { accountId: "a2" }),
      tx("500.00", "2026-11-16", { counterparty: "Someone Else" }),
    ]);
    expect(items.map(({ kind }) => kind)).toEqual(["internal_transfer", "internal_transfer", "income"]);
  });

  it("does not match a transfer within one account or far apart", () => {
    const items = analyze([
      tx("-40.00", "2026-11-01", { counterparty: "Shop" }),
      tx("40.00", "2026-11-02", { counterparty: "Friend" }),
      tx("40.00", "2026-11-20", { accountId: "a2", counterparty: "Other friend" }),
    ]);
    expect(items.map(({ kind }) => kind)).toEqual(["spending", "income", "income"]);
  });

  it("recognizes the account holder and the bank's own pocket wording", () => {
    const items = analyze([
      tx("2000.00", "2026-10-29", { counterparty: "Jane Example", description: "Sent from Revolut" }),
      tx("-1200.00", "2026-11-03", { description: "To GBP Personal" }),
      tx("-700.00", "2026-11-04", { description: "To Pro Savings" }),
      tx("-30.00", "2026-11-05", { description: "To Mario", counterparty: "Mario" }),
    ], [account("a1", { name: "Jane Example" })]);
    expect(items.map(({ kind }) => kind)).toEqual(["internal_transfer", "internal_transfer", "internal_transfer", "spending"]);
  });

  it("recognizes the holder and joint accounts by exact name only", () => {
    const items = analyze([
      tx("320.00", "2026-10-14", { description: "Bonifico a Vostro favore disposto da: MITT.: EXAMPL" }),
      tx("-100.00", "2026-11-14", { counterparty: "Jane Example & Sam Other", currency: "GBP" }),
      tx("-40.00", "2026-11-15", { counterparty: "Jane Example Consulting" }),
      tx("-15.00", "2026-11-16", { counterparty: "Sam Other" }),
    ], [account("a1", { name: "Jane Example" })]);
    expect(items.map(({ kind, kindReason }) => [kind, kindReason])).toEqual([
      // A truncated name is not proof that the money came from the holder.
      ["income", "money received from someone else"],
      ["internal_transfer", "the other party is a joint account in your name and someone else's"],
      ["spending", "money paid to someone else"],
      ["spending", "money paid to someone else"],
    ]);
  });

  it.each([
    ["Exchanged to GBP", "-7343.00", "internal_transfer"],
    ["To EUR Personal", "-20.00", "internal_transfer"],
    ["Transfer into Easy Saver", "-500.00", "internal_transfer"],
    ["To Mario", "-30.00", "spending"],
    ["Transfer to Mario Rossi", "-30.00", "spending"],
  ])("reads the bank's own-money wording %s as %s", (description, amount, kind) => {
    expect(analyze([tx(amount, "2026-11-01", { description })])[0]!.kind).toBe(kind);
  });

  it("labels fees, cash, refunds and bank rewards", () => {
    const items = analyze([
      tx("-25.00", "2026-11-01", { counterparty: "Shop" }),
      tx("-2.00", "2026-11-02", { description: "Commissioni bonifico" }),
      tx("-50.00", "2026-11-03", { description: "Prelievo ATM" }),
      tx("-10.00", "2026-11-03", { counterparty: "Cash at Rambla Del Poblenou" }),
      tx("10.00", "2026-11-04", { counterparty: "Shop" }),
      tx("0.98", "2026-11-05", { description: "Pro Cashback from plan" }),
    ]);
    expect(items.map(({ kind }) => kind)).toEqual(["spending", "fee", "cash_withdrawal", "cash_withdrawal", "refund", "income"]);
  });

  it("leaves out zero amounts, closed statuses and undated records, counting what it skipped", () => {
    const { analyzed, skipped } = analyzeTransactions([
      tx("-0.00", "2026-11-01"),
      tx("-5.00", "2026-11-01", { status: "cancelled" }),
      tx("-5.00", "2026-11-01", { status: "other" }),
      tx("-5.00", "2026-11-01", { transactionDate: undefined }),
      tx("-5.00", "2026-11-01", { status: "held" }),
    ], [account("a1")]);
    expect(analyzed).toHaveLength(1);
    expect(skipped).toEqual({ missingDate: 1, unknownStatus: 1 });
  });
});

describe("periods", () => {
  it("clips months and weeks to the range", () => {
    expect(periodsIn({ dateFrom: "2026-10-15", dateTo: "2026-12-02" }, "month").map(({ period, dateFrom, dateTo }) => [period, dateFrom, dateTo]))
      .toEqual([["2026-10", "2026-10-15", "2026-10-31"], ["2026-11", "2026-11-01", "2026-11-30"], ["2026-12", "2026-12-01", "2026-12-02"]]);
    expect(periodsIn({ dateFrom: "2026-11-18", dateTo: "2026-11-24" }, "week").map(({ period }) => period))
      .toEqual(["2026-11-16", "2026-11-23"]);
  });

  it("compares with the previous period or year", () => {
    expect(comparisonRange({ dateFrom: "2026-11-01", dateTo: "2026-11-30" }, "previous_period"))
      .toEqual({ dateFrom: "2026-10-02", dateTo: "2026-10-31" });
    expect(comparisonRange({ dateFrom: "2028-02-29", dateTo: "2028-03-31" }, "previous_year"))
      .toEqual({ dateFrom: "2027-02-28", dateTo: "2027-03-31" });
    expect(shiftMonths("2026-01-31", 1)).toBe("2026-02-28");
  });
});

describe("summarizeCashFlow", () => {
  it("splits income, spending, refunds and own transfers per currency and period", () => {
    const items = analyze([
      tx("3000.00", "2026-10-01", { counterparty: "Employer" }),
      tx("-100.00", "2026-10-05", { counterparty: "Shop" }),
      tx("40.00", "2026-10-06", { counterparty: "Shop" }),
      tx("-300.00", "2026-10-10", { description: "To Pro Savings" }),
      tx("3000.00", "2026-11-01", { counterparty: "Employer" }),
      tx("-250.00", "2026-11-05", { counterparty: "Shop" }),
      tx("-9.00", "2026-11-06", { counterparty: "Cafe", currency: "GBP" }),
    ]);
    const result = summarizeCashFlow(items, { dateFrom: "2026-11-01", dateTo: "2026-11-30" }, "month",
      { dateFrom: "2026-10-01", dateTo: "2026-10-31" });
    expect(result.totalsByCurrency).toEqual({
      EUR: { income: "3000.00", spending: "250.00", refunds: "0.00", net: "2750.00", transfersBetweenOwnAccounts: { in: "0.00", out: "0.00" }, transactions: 2 },
      GBP: { income: "0.00", spending: "9.00", refunds: "0.00", net: "-9.00", transfersBetweenOwnAccounts: { in: "0.00", out: "0.00" }, transactions: 1 },
    });
    expect(result.comparison?.totalsByCurrency.EUR).toMatchObject({
      income: "3000.00", spending: "100.00", refunds: "40.00", net: "2940.00", transfersBetweenOwnAccounts: { out: "300.00" },
    });
    expect(result.comparison?.changeByCurrency.EUR).toEqual({
      income: { amount: "0.00", percent: "0.0" },
      spending: { amount: "150.00", percent: "150.0" },
      net: { amount: "-190.00", percent: "-6.5" },
    });
    expect(result.comparison?.changeByCurrency.GBP?.spending).toEqual({ amount: "9.00" });
    expect(result.periods).toHaveLength(1);
  });
});

describe("breakDown", () => {
  const items = () => analyze([
    tx("-20.00", "2026-11-01", { counterparty: "Examplemart" }),
    tx("-30.00", "2026-11-08", { counterparty: "EXAMPLEMART S.P.A." }),
    tx("-12.00", "2026-11-02", { counterparty: "Cinema" }),
    tx("-5.00", "2026-11-03", { counterparty: "Bakery" }),
    tx("10.00", "2026-11-09", { counterparty: "Examplemart" }),
    tx("-15.00", "2026-10-02", { counterparty: "Examplemart" }),
  ]);

  it("ranks payees, combines the rest, and shows refunds and change", () => {
    const result = breakDown(items(), [account("a1")], {
      range: { dateFrom: "2026-11-01", dateTo: "2026-11-30" },
      comparison: { dateFrom: "2026-10-01", dateTo: "2026-10-31" },
      groupBy: "payee", direction: "out", limit: 2, includeTransactions: true,
    });
    expect(result.EUR).toMatchObject({
      total: "67.00",
      count: 4,
      groups: [
        { key: "examplemart", total: "50.00", count: 2, sharePercent: "74.6", refunded: "10.00", comparisonTotal: "15.00", change: { amount: "35.00", percent: "233.3" } },
        { key: "cinema", total: "12.00", comparisonTotal: "0.00", change: { amount: "12.00" } },
      ],
      otherGroups: { groups: 1, total: "5.00", count: 1 },
      comparisonTotal: "15.00",
    });
    expect(result.EUR!.groups[0]!.transactions!.map(({ amount }) => amount)).toEqual(["30.00", "20.00"]);
  });

  it("keeps detailed breakdowns within one transaction budget across currencies", () => {
    const many = Array.from({ length: 40 }, (_, payee) => Array.from({ length: 6 }, (_, index) =>
      tx("-1.00", `2026-11-${String(index + 1).padStart(2, "0")}`, {
        counterparty: `Shop ${String.fromCharCode(65 + (payee % 26))}${String.fromCharCode(65 + Math.floor(payee / 26))}`,
        currency: payee % 2 === 0 ? "EUR" : "GBP",
      }))).flat();
    const result = breakDown(analyze(many), [account("a1")], {
      range: { dateFrom: "2026-11-01", dateTo: "2026-11-30" }, comparison: undefined,
      groupBy: "payee", direction: "out", limit: 50, includeTransactions: true,
    });
    const listed = Object.values(result).flatMap(({ groups }) => groups.flatMap(({ transactions }) => transactions ?? []));
    expect(listed.length).toBeLessThanOrEqual(100);
    expect(Object.values(result).every(({ groups }) => groups.every(({ transactions }) => transactions!.length >= 1))).toBe(true);
  });

  it("groups by account and lists income separately", () => {
    const result = breakDown(analyze([
      tx("-20.00", "2026-11-01", { counterparty: "Shop" }),
      tx("1000.00", "2026-11-01", { counterparty: "Employer" }),
    ]), [account("a1", { product: "Conto" })], {
      range: { dateFrom: "2026-11-01", dateTo: "2026-11-30" }, comparison: undefined,
      groupBy: "account", direction: "in", limit: 10, includeTransactions: false,
    });
    expect(result.EUR!.groups).toEqual([expect.objectContaining({ key: "a1", label: "Example Bank Conto EUR", total: "1000.00" })]);
  });
});

describe("findRecurring", () => {
  const monthly = (payee: string, amounts: string[], start = "2026-06-05", extra: Partial<Transaction> = {}) =>
    amounts.map((amount, index) => tx(amount, shiftMonths(start, index), { counterparty: payee, ...extra }));

  it("finds a monthly subscription, its trend and next date", () => {
    const [stream] = findRecurring(analyze(monthly("Streamly", ["-9.99", "-9.99", "-9.99", "-12.99"])), "2026-09-20");
    expect(stream).toMatchObject({
      payee: "Streamly", cadence: "monthly", typicalAmount: "9.99", lastAmount: "12.99",
      amountPattern: "variable", trend: "rising", nextExpectedDate: "2026-10-05", status: "active", monthlyEquivalent: "9.99",
    });
  });

  it("marks a schedule stopped after one and a half cycles without a payment", () => {
    const [stream] = findRecurring(analyze(monthly("Gym", ["-30.00", "-30.00", "-30.00"])), "2026-10-20");
    expect(stream).toMatchObject({ status: "stopped", amountPattern: "fixed", trend: "stable" });
  });

  it("merges same-day payments to one payee and finds regular income", () => {
    const items = analyze([
      ...monthly("Google Cloud Ab1", ["-2.00", "-2.00", "-2.00"]),
      ...monthly("Google Cloud Cd2", ["-1.00", "-1.50", "-1.00"]),
      ...monthly("Employer", ["3000.00", "3000.00", "3100.00"], "2026-06-27"),
    ]);
    const found = findRecurring(items, "2026-08-28");
    expect(found.map(({ payee, direction, typicalAmount, occurrences }) => ({ payee, direction, typicalAmount, occurrences }))).toEqual([
      { payee: "Employer", direction: "in", typicalAmount: "3000.00", occurrences: 3 },
      { payee: "Google Cloud", direction: "out", typicalAmount: "3.00", occurrences: 3 },
    ]);
  });

  it("ignores frequent purchases of varying amounts at one shop", () => {
    const items = analyze(["01", "08", "15", "22", "29"].map((day, index) =>
      tx(index % 2 === 0 ? "-12.00" : "-48.00", `2026-10-${day}`, { counterparty: "Supermarket" })));
    expect(findRecurring(items, "2026-11-01")).toEqual([]);
  });

  it("projects upcoming occurrences and flags a late one", () => {
    const found = findRecurring(analyze([
      ...monthly("Rent", ["-900.00", "-900.00", "-900.00"], "2026-08-01"),
      ...monthly("Phone", ["-10.00", "-10.00", "-10.00"], "2026-07-25"),
    ]), "2026-10-29");
    expect(projectUpcoming(found, "2026-10-29", "2026-11-30").map(({ date, payee, late }) => ({ date, payee, late }))).toEqual([
      { date: "2026-10-25", payee: "Phone", late: true },
      { date: "2026-11-01", payee: "Rent", late: undefined },
      { date: "2026-11-25", payee: "Phone", late: undefined },
    ]);
  });
});

describe("reviewActivity", () => {
  it("flags duplicates, fees, price rises, missed income, unusual and new payees", () => {
    const history = [
      ...["2026-07-05", "2026-08-05", "2026-09-05"].map((date) => tx("-9.99", date, { counterparty: "Streamly" })),
      tx("-10.99", "2026-10-05", { counterparty: "Streamly" }),
      ...["2026-07-27", "2026-08-27", "2026-09-27"].map((date) => tx("3000.00", date, { counterparty: "Employer" })),
      ...["2026-07-10", "2026-08-10", "2026-09-10"].map((date) => tx("-20.00", date, { counterparty: "Cafe" })),
      ...Array.from({ length: 8 }, (_, index) => tx("-15.00", `2026-09-${String(index + 11)}`, { counterparty: `Shop ${"ABCDEFGH"[index]}` })),
      tx("-90.00", "2026-10-12", { counterparty: "Cafe" }),
      tx("-17.08", "2026-10-14", { counterparty: "Domains" }),
      tx("-17.08", "2026-10-15", { counterparty: "Domains" }),
      tx("-3.00", "2026-10-16", { description: "Commissione bonifico" }),
      tx("-950.00", "2026-10-18", { counterparty: "Airline" }),
    ];
    const { findings } = reviewActivity(analyze(history), { dateFrom: "2026-10-01", dateTo: "2026-10-31" }, "2026-11-10");
    expect(findings.map(({ type, payee }) => [type, payee])).toEqual([
      ["possible_duplicate", "Domains"],
      ["fee", "Commissione bonifico"],
      ["price_increase", "Streamly"],
      ["missed_recurring", "Employer"],
      ["unusual_amount", "Cafe"],
      ["large_payment", "Airline"],
    ]);
    expect(findings[0]!.transactions).toHaveLength(2);
  });

  it("treats repeat purchases of a usual amount as a habit, not a duplicate", () => {
    const coffee = (date: string) => tx("-3.70", date, { counterparty: "Bar Prima Porta" });
    const items = analyze([
      ...["2026-10-02", "2026-10-09", "2026-10-16"].map(coffee),
      coffee("2026-11-10"),
      coffee("2026-11-11"),
      tx("-4.20", "2026-11-12", { counterparty: "Example Cafe" }),
      tx("-4.20", "2026-11-12", { counterparty: "Example Cafe" }),
    ]);
    const { findings } = reviewActivity(items, { dateFrom: "2026-11-01", dateTo: "2026-11-19" }, "2026-11-19");
    expect(findings.filter(({ type }) => type === "possible_duplicate").map(({ payee }) => payee)).toEqual(["Example Cafe"]);
  });

  it("keeps payments with different references apart and judges new payees only on accounts with history", () => {
    const items = analyze([
      tx("-20.00", "2026-10-01", { counterparty: "Cafe" }),
      // a2 opened at the end of the baseline: its payees are not judged.
      tx("-30.00", "2026-10-29", { counterparty: "Airline", accountId: "a2" }),
      tx("-10.00", "2026-11-04", { counterparty: "Tax Office", description: "40844160693 Tax Office" }),
      tx("-10.00", "2026-11-04", { counterparty: "Tax Office", description: "40843842291 Tax Office" }),
      tx("-25.00", "2026-11-05", { counterparty: "Bookshop" }),
      tx("-25.00", "2026-11-05", { counterparty: "Grocer", accountId: "a2" }),
    ]);
    const { findings } = reviewActivity(items, { dateFrom: "2026-11-01", dateTo: "2026-11-19" }, "2026-11-19", "2026-09-15");
    expect(findings.map(({ type, payee }) => [type, payee])).toEqual([
      ["new_payee", "Bookshop"],
      ["new_payee", "Tax Office"],
    ]);
  });

  it("does not report a regular payment as missed before it is due", () => {
    const history = ["2026-08-27", "2026-09-27", "2026-10-27"].map((date) => tx("3000.00", date, { counterparty: "Employer" }));
    const { findings } = reviewActivity(analyze(history), { dateFrom: "2026-11-01", dateTo: "2026-11-30" }, "2026-11-20");
    expect(findings).toEqual([]);
  });
});
