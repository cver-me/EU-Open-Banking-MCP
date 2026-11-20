/**
 * Bank wording the analysis relies on, in one place. Every rule is a convention of a bank
 * or a language that applies to every customer, never a pattern from one person's data.
 * Each names its source and a synthetic example; tests check every example.
 *
 * Wording is a fallback: structure decides first (matching transfers between connected
 * accounts, the account holder's name), and every label carries its reason so an agent
 * can overrule it.
 */

/** Matches any of the words or phrases as whole words, accents and non-Latin letters included. */
function words(...terms: string[]): RegExp {
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`, "iu");
}

export interface WordingRule {
  /** Which bank or language the convention comes from. */
  source: string;
  pattern: RegExp;
  /** A synthetic description the rule must match. */
  example: string;
}

/** Fees, charges and interest the bank takes (debits). */
export const FEE_WORDING: readonly WordingRule[] = [
  { source: "English", pattern: words("fee", "fees", "charge", "charges", "commission", "interest", "overdraft interest"), example: "Monthly account fee" },
  { source: "Italian", pattern: words("commissione", "commissioni", "canone", "spese", "imposta di bollo", "interessi"), example: "Commissione bonifico" },
  // German builds compounds ("Kontoführungsentgelt", "Sollzinsen"), so these match inside words.
  { source: "German", pattern: /gebühr|gebuehr|entgelt|zinsen/i, example: "Kontoführungsentgelt" },
  { source: "French", pattern: words("frais", "commission", "cotisation", "agios", "intérêts", "interets"), example: "Frais de tenue de compte" },
  { source: "Spanish", pattern: words("comisión", "comision", "comisiones", "intereses", "cuota de mantenimiento"), example: "Comisión mantenimiento" },
  { source: "Dutch", pattern: words("kosten", "provisie", "rente", "debetrente"), example: "Kosten betaalpakket" },
  { source: "Portuguese", pattern: words("comissão", "comissao", "comissões", "juros", "encargos"), example: "Comissão de manutenção" },
];

/** Cash taken out at a machine or counter (debits). */
export const CASH_WORDING: readonly WordingRule[] = [
  { source: "English", pattern: words("atm", "cash withdrawal", "cashpoint"), example: "ATM withdrawal High Street" },
  { source: "Revolut", pattern: /^cash at\s/i, example: "Cash at Example Street 12" },
  { source: "Italian", pattern: words("prelievo", "prelevamento", "bancomat"), example: "Prelievo bancomat" },
  { source: "German", pattern: /geldautomat|bargeldauszahlung|barabhebung|bargeldabhebung|(?<![\p{L}\p{N}])GAA(?![\p{L}\p{N}])/iu, example: "GAA Hauptstr" },
  { source: "French", pattern: words("retrait", "retrait dab", "dab"), example: "Retrait DAB Paris" },
  { source: "Spanish", pattern: words("reintegro", "retirada de efectivo", "cajero"), example: "Reintegro cajero" },
  { source: "Dutch", pattern: words("geldopname", "geldautomaat"), example: "Geldopname Amsterdam" },
  { source: "Portuguese", pattern: words("levantamento"), example: "Levantamento Lisboa" },
];

/** Money given back for an earlier payment (credits). */
export const REFUND_WORDING: readonly WordingRule[] = [
  { source: "English", pattern: words("refund", "refunded", "reversal", "chargeback"), example: "Refund order 1234" },
  { source: "Italian", pattern: words("rimborso", "storno"), example: "Storno pagamento" },
  { source: "German", pattern: words("Erstattung", "Rückerstattung", "Rueckerstattung", "Rückbuchung", "Rueckbuchung"), example: "Rückerstattung Bestellung" },
  { source: "French", pattern: words("remboursement"), example: "Remboursement commande" },
  { source: "Spanish", pattern: words("reembolso", "devolución", "devolucion"), example: "Devolución compra" },
  { source: "Dutch", pattern: words("terugbetaling", "restitutie", "terugboeking"), example: "Terugbetaling bestelling" },
  { source: "Portuguese", pattern: words("reembolso", "estorno", "devolução", "devolucao"), example: "Estorno compra" },
];

/**
 * Moves between the owner's own balances that a bank describes in its own words. These
 * name products of specific banks, so each rule says which bank writes it.
 */
export const OWN_MONEY_WORDING: readonly (WordingRule & { reason: string; withoutCounterparty?: true })[] = [
  {
    source: "Revolut",
    // "To EUR Personal", "From GBP Personal", "To Savings Vault": a pocket of the same account.
    pattern: /^(?:to|from)\s+(?:\S+\s+)?(?:personal|savings?|vault|pocket)$/i,
    example: "To EUR Personal",
    withoutCounterparty: true,
    reason: "the bank describes a move between your own accounts or savings",
  },
  {
    source: "Revolut",
    pattern: /^exchanged\s+(?:to|from)\s+[A-Z]{3}$/i,
    example: "Exchanged to GBP",
    reason: "a currency exchange between your own balances",
  },
  {
    source: "Starling",
    // "Transfer into Easy Saver", "Transfer from Holiday Space"
    pattern: /^transfer (?:into|from|to)\s+.*(?<![\p{L}\p{N}])(?:saver|savings?|space|isa)$/iu,
    example: "Transfer into Easy Saver",
    reason: "the bank describes a move between your own accounts or savings",
  },
];

/**
 * Descriptions that wrap the other party's name. Each pattern captures the name; the first
 * match wins. Banks that send a counterparty field never reach these.
 */
export const PAYEE_WORDING: readonly WordingRule[] = [
  // Card payments: "PAGAMENTO POS EFFETTUATO IL … MEDIANTE LA CARTA … PRESSO <name>"
  { source: "Italian banks", pattern: /\bPRESSO\s+(.+)$/i, example: "PAGAMENTO POS EFFETTUATO IL 01/02/2026 MEDIANTE LA CARTA 1234 XXXX XXXX XX56 PRESSO EXAMPLE SHOP ROMA" },
  // Card payments: "PAGAM. TRAMITE POS <name>01/02-09:30 - Carta …"
  { source: "Italian banks", pattern: /\bTRAMITE POS\s+(?:Pagamento su POS\s+)?(.+?)\s*\d{2}\/\d{2}-\d{2}:\d{2}/i, example: "PAGAM. TRAMITE POS EXAMPLE BAR01/02-09:30 - Carta n.1234" },
  // Transfers out: "… Bonifico da Voi disposto a favore di: <name>"
  { source: "Italian banks", pattern: /\ba favore di:\s*(.+)$/i, example: "Bonifico da Voi disposto a favore di: Mario Rossi" },
  // Transfers in: "… Bonifico a Vostro favore disposto da: MITT.: <name>"
  { source: "Italian banks", pattern: /\bMITT\.?:\s*(.+)$/i, example: "Bonifico a Vostro favore disposto da: MITT.: Example Srl" },
];

export function matchesAny(rules: readonly WordingRule[], text: string): WordingRule | undefined {
  return rules.find(({ pattern }) => pattern.test(text));
}
