import Decimal from "decimal.js";

// Bound provider inputs, then allow enough precision for mixed integer/fractional
// scales plus the carry from at most 10,000 entries. Do not change global defaults.
export const MAX_PROVIDER_AMOUNT_LENGTH = 100;
export const Money = Decimal.clone({ precision: MAX_PROVIDER_AMOUNT_LENGTH * 2 + 5 });
