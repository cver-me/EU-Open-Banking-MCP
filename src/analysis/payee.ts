import type { Transaction } from "../finance";
import { PAYEE_WORDING } from "./wording";

/** Who a transaction was with, normalized so one merchant or person groups as one payee. */
export interface Payee {
  /** Stable grouping key (lowercase words). Pass it back to filter by payee. */
  key: string;
  /** Readable name, cleaned of card numbers, dates and reference codes. */
  name: string;
}

const MAX_PAYEE_LENGTH = 80;
const UNKNOWN_PAYEE: Payee = { key: "unknown", name: "Unknown" };

// Company-form suffixes that make one merchant look like two ("Marks & Spencer" / "MARKS&SPENCER PLC").
const LEGAL_SUFFIXES = new Set([
  // UK and Ireland, international
  "co", "dac", "inc", "limited", "llc", "llp", "ltd", "plc",
  // Germany, Austria, Switzerland
  "ag", "gmbh", "kg", "ohg", "ug",
  // France, Belgium, Luxembourg
  "sa", "sarl", "sas", "sasu", "sprl",
  // Italy, Spain, Portugal
  "spa", "srl", "srls", "sl", "slu", "lda",
  // Netherlands, Nordics, Central Europe
  "ab", "aps", "as", "bv", "bvba", "nv", "oy", "sro",
]);

/**
 * The payee of a transaction: the bank's counterparty when it sends one, otherwise a
 * name read from known description wording, otherwise the description itself.
 */
export function payeeOf(transaction: Pick<Transaction, "counterparty" | "description">): Payee {
  const source = withoutGluedReference(transaction.counterparty, transaction.description) ??
    fromDescription(transaction.description);
  if (source === undefined) return UNKNOWN_PAYEE;
  const name = cleanName(source);
  const key = payeeKey(name);
  return key === "" ? UNKNOWN_PAYEE : { key, name };
}

/** Normalizes free text (a payee name or a key an agent passes back) to a payee key. */
export function payeeKey(text: string): string {
  const words = text
    .toLocaleLowerCase()
    // Strip accents so "Café" and "CAFE" match; other scripts (Greek, Cyrillic) are kept as they are.
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    // "s.r.l." or "s.p.a" → "srl", "spa" before punctuation turns them into single letters.
    .replace(/(?<![\p{L}\p{N}])\p{L}(?:\.\p{L})+\.?(?![\p{L}\p{N}])/gu, (abbreviation) => abbreviation.replaceAll(".", ""))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word !== "");
  while (words.length > 1 && LEGAL_SUFFIXES.has(words.at(-1)!)) words.pop();
  return words.join(" ");
}

/**
 * Some banks glue a booking reference onto the counterparty ("ExampleairQXZ42K") while the
 * description holds the plain name ("Exampleair"); the description is then the better name.
 */
function withoutGluedReference(counterparty: string | undefined, description: string | undefined): string | undefined {
  if (counterparty === undefined || description === undefined) return counterparty;
  const name = description.trim();
  const rest = counterparty.slice(name.length);
  return name.length >= 3 && counterparty.toLocaleLowerCase().startsWith(name.toLocaleLowerCase()) &&
    /^\w*\d\w*$/.test(rest)
    ? name
    : counterparty;
}

function fromDescription(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  for (const { pattern } of PAYEE_WORDING) {
    const match = pattern.exec(description);
    if (match?.[1] !== undefined && match[1].trim() !== "") return match[1];
  }
  return description;
}

function cleanName(raw: string): string {
  const tokens = raw
    // Masked card numbers and processor separators: "1234 XXXX XXXX XX56", "SQSP*", "AMAZON*"
    .replace(/\b\d{4}\s+X{4}\s+X{4}\s+X{2}\d{2}\b/gi, " ")
    .replace(/[*#]/g, " ")
    .split(/\s+/)
    // Codes, dates and amounts anywhere in the text: four or more digits in one token.
    .filter((token) => token !== "" && !/(?:\d\D?){4}/.test(token));

  // Drop trailing reference codes ("Google Cloud Mnj3ph", "Algolia 2f2610520693",
  // "DOMAIN 256980392"): tokens with a digit, as long as a name is left.
  while (tokens.length > 1 && /\d/.test(tokens.at(-1)!)) tokens.pop();
  // Card processors often repeat the merchant: "Fiscozen* Fiscozen" → "Fiscozen".
  const deduplicated = tokens.filter(
    (token, index) => index === 0 || token.toLocaleLowerCase() !== tokens[index - 1]!.toLocaleLowerCase(),
  );
  const name = deduplicated.join(" ").replace(/[\s\-–,.:;/]+$/, "").trim();
  return name.length > MAX_PAYEE_LENGTH ? name.slice(0, MAX_PAYEE_LENGTH).trimEnd() : name;
}
