import type Decimal from "decimal.js";
import { z } from "zod";
import { resolveSpendingDate, type AccountSummary, type Transaction } from "../finance";
import { differenceInDays } from "../lib/dates";
import { Money } from "../lib/money";
import { payeeKey, payeeOf, type Payee } from "./payee";
import { CASH_WORDING, FEE_WORDING, matchesAny, OWN_MONEY_WORDING, REFUND_WORDING } from "./wording";

export const transactionKindSchema = z.enum([
  "spending",
  "income",
  "internal_transfer",
  "refund",
  "fee",
  "cash_withdrawal",
]);
export type TransactionKind = z.infer<typeof transactionKindSchema>;

/** Kinds that count as money going out to someone else. */
export const OUTGOING_KINDS: ReadonlySet<TransactionKind> = new Set(["spending", "fee", "cash_withdrawal"]);

/** A transaction with the facts every analysis needs, worked out once. */
export interface AnalyzedTransaction {
  transaction: Transaction;
  payee: Payee;
  kind: TransactionKind;
  /** Short reason for the kind, so an agent can see why and overrule it. */
  kindReason: string;
  /** Date used to place the transaction in a period. */
  date: string;
  /** True when the date is a booking or value date standing in for the transaction date. */
  dateInferred: boolean;
  amount: Decimal;
}

const TRANSFER_MATCH_DAYS = 4;
const REFUND_LOOKBACK_DAYS = 90;

/**
 * Labels transactions across all the user's accounts. Internal transfers are found by
 * matching a debit in one account with a credit of the same amount and currency in
 * another within a few days, by a counterparty that is the holder of one of the
 * accounts, or by the bank's own wording for its savings pots.
 *
 * Transactions with no usable date or a zero amount, and cancelled, rejected,
 * scheduled or unknown-status records, are left out: they are not money that moved.
 */
export function analyzeTransactions(
  transactions: readonly Transaction[],
  accounts: readonly AccountSummary[],
): { analyzed: AnalyzedTransaction[]; skipped: { missingDate: number; unknownStatus: number } } {
  const skipped = { missingDate: 0, unknownStatus: 0 };
  const holderKeys = new Set(
    accounts.map(({ name }) => (name === undefined ? "" : payeeKey(name))).filter((key) => key.length >= 5),
  );

  const analyzed: AnalyzedTransaction[] = [];
  for (const transaction of transactions) {
    if (transaction.status === "other") {
      skipped.unknownStatus += 1;
      continue;
    }
    if (transaction.status !== "booked" && transaction.status !== "pending" && transaction.status !== "held") continue;
    const amount = new Money(transaction.amount);
    if (amount.isZero()) continue;
    const resolved = resolveSpendingDate(transaction);
    if (resolved.effectiveDate === undefined) {
      skipped.missingDate += 1;
      continue;
    }
    const payee = payeeOf(transaction);
    const { kind, reason } = kindFromWording(transaction, payee, holderKeys);
    analyzed.push({
      transaction,
      payee,
      kind,
      kindReason: reason,
      date: resolved.effectiveDate,
      dateInferred: resolved.inferred,
      amount,
    });
  }

  matchTransferPairs(analyzed);
  markRefunds(analyzed);
  analyzed.sort((left, right) => left.date.localeCompare(right.date));
  return { analyzed, skipped };
}

function kindFromWording(
  transaction: Transaction,
  payee: Payee,
  holderKeys: ReadonlySet<string>,
): { kind: TransactionKind; reason: string } {
  const text = [transaction.description, transaction.counterparty, transaction.bankTransactionDescription]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  const description = transaction.description?.trim() ?? "";

  const holder = matchHolder(payee, holderKeys);
  if (holder === "self") {
    return { kind: "internal_transfer", reason: "the other party is the holder of one of your connected accounts" };
  }
  if (holder === "joint") {
    return { kind: "internal_transfer", reason: "the other party is a joint account in your name and someone else's" };
  }
  const own = OWN_MONEY_WORDING.find((rule) =>
    (rule.withoutCounterparty !== true || transaction.counterparty === undefined) && rule.pattern.test(description));
  if (own !== undefined) return { kind: "internal_transfer", reason: `${own.reason} (${own.source} wording)` };

  if (transaction.direction === "debit") {
    const cash = matchesAny(CASH_WORDING, text);
    if (cash !== undefined) return { kind: "cash_withdrawal", reason: `the bank describes a cash withdrawal (${cash.source} wording)` };
    const fee = matchesAny(FEE_WORDING, text);
    if (fee !== undefined) return { kind: "fee", reason: `the bank describes a fee, charge or interest (${fee.source} wording)` };
    return { kind: "spending", reason: "money paid to someone else" };
  }
  const refund = matchesAny(REFUND_WORDING, text);
  if (refund !== undefined) return { kind: "refund", reason: `the bank describes a refund or reversal (${refund.source} wording)` };
  return { kind: "income", reason: "money received from someone else" };
}

// Words that join two holders' names on a joint account: "Jane Example & Sam Other".
const JOINT_ACCOUNT_JOINERS = new Set(["&", "and", "e", "und", "et", "y", "en", "+", "/"]);

/**
 * The account holder themselves ("Jane Example"), or a joint account that names them
 * first and then someone else ("Jane Example & Sam Other"). Holder names come from the
 * banks; only exact names count, never partial or truncated ones.
 */
function matchHolder(payee: Payee, holderKeys: ReadonlySet<string>): "self" | "joint" | undefined {
  if (holderKeys.has(payee.key)) return "self";
  const tokens = payee.name.toLocaleLowerCase().split(/\s+/);
  for (const holder of holderKeys) {
    const holderWords = holder.split(" ");
    const start = payeeKey(tokens.slice(0, holderWords.length).join(" "));
    const joiner = tokens[holderWords.length];
    if (start === holder && joiner !== undefined && JOINT_ACCOUNT_JOINERS.has(joiner) && tokens.length > holderWords.length + 1) {
      return "joint";
    }
  }
  return undefined;
}

/** A debit and a credit of the same amount and currency in two of the user's accounts. */
function matchTransferPairs(analyzed: AnalyzedTransaction[]): void {
  const credits = new Map<string, AnalyzedTransaction[]>();
  for (const item of analyzed) {
    if (item.transaction.direction !== "credit") continue;
    const key = `${item.transaction.currency} ${item.amount.toString()}`;
    credits.set(key, [...(credits.get(key) ?? []), item]);
  }
  const used = new Set<AnalyzedTransaction>();
  for (const debit of analyzed) {
    if (debit.transaction.direction !== "debit") continue;
    const candidates = credits.get(`${debit.transaction.currency} ${debit.amount.toString()}`) ?? [];
    const credit = candidates.find((candidate) =>
      !used.has(candidate) &&
      candidate.transaction.accountId !== debit.transaction.accountId &&
      Math.abs(differenceInDays(debit.date, candidate.date)) <= TRANSFER_MATCH_DAYS);
    if (credit === undefined) continue;
    used.add(credit);
    for (const side of [debit, credit]) {
      side.kind = "internal_transfer";
      side.kindReason = "matches a transfer of the same amount between two of your connected accounts";
    }
  }
}

/** A credit from a payee the user paid the same amount or more shortly before is a refund. */
function markRefunds(analyzed: AnalyzedTransaction[]): void {
  const debitsByPayee = new Map<string, AnalyzedTransaction[]>();
  for (const item of analyzed) {
    if (item.kind !== "spending") continue;
    const key = `${item.payee.key} ${item.transaction.currency}`;
    debitsByPayee.set(key, [...(debitsByPayee.get(key) ?? []), item]);
  }
  for (const credit of analyzed) {
    if (credit.kind !== "income" || credit.payee.key === "unknown") continue;
    const earlier = debitsByPayee.get(`${credit.payee.key} ${credit.transaction.currency}`) ?? [];
    const paid = earlier.some((debit) => {
      const days = differenceInDays(debit.date, credit.date);
      return days >= 0 && days <= REFUND_LOOKBACK_DAYS && debit.amount.greaterThanOrEqualTo(credit.amount);
    });
    if (paid) {
      credit.kind = "refund";
      credit.kindReason = "money back from a payee you paid at least as much shortly before";
    }
  }
}
