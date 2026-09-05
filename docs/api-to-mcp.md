# API-to-MCP mapping

The Worker exposes a small finance interface, validates provider responses, and derives bounded summaries. It preserves the distinction between bank facts and Worker estimates. The upstream contract is [Enable Banking's API reference](https://enablebanking.com/docs/api/reference/).

## Tool boundaries

| Tool | Upstream reads | Meaning of the result |
| --- | --- | --- |
| List accounts | Active sessions, then account details | Discoverable account metadata, deduplicated by the primary identity hash when available |
| Get balances | Active sessions, then balance measurements | Alternative measurements with bank labels and dates; never a sum of balance types |
| List transactions | Active sessions, then one provider transaction page | Normalized records; an MCP page can be a slice of a larger provider page |
| Search transactions | Up to five provider transaction pages | Text matches across counterparty, description, entry/payment references, and bank classification description |
| Get spending | Bounded transaction scans with seven-day date padding | Gross dated debit estimate, separated by booked/pending/held status |
| Summarize cash flow | Bounded scans with booked status | Gross booked credits, debits, and net flow, separately per currency |

Session membership remains the authorization boundary. Primary account identity hashes only deduplicate all-account reads; an explicitly selected session-specific alias remains usable while authorized. Missing primary hashes do not trigger heuristic matching. Secondary hashes, holder names, account labels, and balances are not reliable identity keys.

## Preserved facts

| Provider value | MCP representation | Interpretation |
| --- | --- | --- |
| Account `name`, `product`, `details` | `name`, `product`, `description` | Holder name, product, and account description remain distinct; blank optional labels are omitted |
| Balance `name`, `balance_type` | `label`, `balanceType` | The bank label helps explain broad types such as `other` |
| Balance dates/timestamps | `referenceDate`, `lastChangedAt` | Bank measurement metadata, not fetch time |
| Amount and credit/debit indicator | Decimal-string `amount`, `direction` | Transactions use absolute amounts and the accounting indicator; balances retain their sign |
| Lifecycle status | `status` | Booked, pending, held, cancelled, rejected, scheduled, and other remain distinct |
| Three transaction dates | `transactionDate`, `bookingDate`, `valueDate` | Separate fields; none silently replaces another |
| Creditor/debtor names | `counterparty` | Creditor for a debit; debtor for a credit |
| Remittance lines and owner note | Combined `description` | Searchable display text; the join does not create a verified merchant category |
| Entry reference and creditor reference | `reference`, `paymentReference` | Transaction identity and payment reconciliation are different concepts |
| Bank classification description | `bankTransactionDescription` | Readable bank-provided type; raw bank-specific codes and invented categories are omitted |

Party account numbers, addresses, identity hashes, raw classification codes, and unstable transaction detail tokens are not exposed. Optional nulls normalize to absence for supported optional fields. Invalid required financial values fail validation rather than becoming zero or silently disappearing. Diagnostics identify schema paths without logging values.

## Derived spending

`transactionDate` is preferred. For cards this is the bank-reported purchase date; for other payment types it can represent acquisition or receipt. If absent, the earlier booking/value date is a heuristic. Returned spending entries expose that choice as `effectiveDate` and `dateSource`, without modifying the original dates.

No-date entries cannot be placed inside a requested interval, especially when the provider query was widened. They are excluded with `missing_dates` in `incompleteReasons`. Unknown lifecycle statuses are excluded with `unknown_status`. Cancelled, rejected, and scheduled records do not contribute to spending. Credits are not subtracted.

`totalsByCurrency` combines the included booked, pending, and held debits. `totalsByStatus` lets callers distinguish settled entries from provisional activity. A hold or pending record can change or disappear; these categories must not be presented as settled purchases. The Worker does not infer transfer matches, consolidate pending/booked lifecycle records, or identify household expenses from account flow alone.

## Completeness and precision

- `complete` describes the bounded scan and, for spending, date/status uncertainty. It does not certify bank history coverage.
- `incompleteReasons` distinguishes scan limits, repeated continuation keys, and spending uncertainty.
- Spending returns summary information by default. With `includeTransactions: true`, `transactions` and `transactionDetailsComplete` describe the 200-entry display cap independently of whether the totals covered the scan.
- Provider date filters use the bank's semantics. Seven-day padding is a retrieval heuristic, not a guarantee against long posting delays.
- MCP cursors bind account and filters but do not create snapshots. Continuing a sliced page re-reads live provider data; clients should restart if the underlying data changes.
- Amounts remain strings. Provider inputs allow at most 100 characters; a separate Decimal constructor supplies enough precision for mixed scales and at most 10,000 included records. Currencies are never converted or combined.

These rules are exercised with synthetic provider fixtures and Worker-level MCP calls. Live smoke tests must keep account identifiers and financial payloads out of repository fixtures and reports.

## Information budget

Expose a field when it helps an agent select a follow-up tool, identify a record, interpret an amount, or qualify an answer. Do not mirror the upstream schema wholesale. Balance labels, readable transaction types, and date provenance affect interpretation; raw bank-specific codes and provider query bookkeeping generally do not. Spending details are opt-in so a totals question does not load hundreds of transactions.

This follows the contextual-relevance and concise/detailed-response recommendations in [Anthropic's tool-design guidance](https://www.anthropic.com/engineering/writing-tools-for-agents). Smaller responses alone are not proof of better reasoning: evaluate task accuracy alongside payload size, tool calls, and error recovery. The tests verify that concise and detailed spending return identical totals and completeness warnings.
