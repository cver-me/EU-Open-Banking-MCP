import Decimal from "decimal.js";

// Bound provider inputs, then allow enough precision for mixed integer/fractional
// scales plus the carry from at most 10,000 entries. Do not change global defaults.
export const MAX_PROVIDER_AMOUNT_LENGTH = 100;
export const Money = Decimal.clone({ precision: MAX_PROVIDER_AMOUNT_LENGTH * 2 + 5 });

const minorUnits = new Map<string, number>();

/** ISO 4217 minor-unit digits (EUR, GBP: 2; JPY: 0; KWD: 3). Unknown codes default to 2. */
export function currencyMinorUnits(currency: string): number {
  let digits = minorUnits.get(currency);
  if (digits === undefined) {
    try {
      digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      digits = 2;
    }
    minorUnits.set(currency, digits);
  }
  return digits;
}

/**
 * The one way amounts leave the Worker: an exact decimal string with at least the
 * currency's minor-unit digits ("9000" GBP → "9000.00"). Never rounds: extra digits
 * a bank reports are kept. Zero is never signed.
 */
export function formatAmount(value: Decimal.Value, currency: string): string {
  const amount = new Money(value);
  const normalized = amount.isZero() ? amount.abs() : amount;
  return normalized.toFixed(Math.max(normalized.decimalPlaces(), currencyMinorUnits(currency)));
}
