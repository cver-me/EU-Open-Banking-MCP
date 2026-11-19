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
- Every amount the tools return (balances, transactions, spending and cash-flow totals, for every provider) has at least its currency's ISO 4217 minor-unit digits: `"9000.00"` GBP, `"1500"` JPY, `"1.500"` KWD. Extra digits a bank reports are kept, never rounded, and zero is never signed.
- Every account has its own `currency`, and every balance and transaction states the currency of its amount. A bank's country does not imply the currency: a UK bank can hold a EUR account and an EU bank a GBP account.

These rules are exercised with synthetic provider fixtures and Worker-level MCP calls. Live smoke tests must keep account identifiers and financial payloads out of repository fixtures and reports.

## Provider failures

All-account reads (`finance_list_accounts`, `finance_get_balances` without `accountId`, spending and cash flow without `accountId`) query every configured provider. A provider with no connected banks is skipped. A provider that fails is listed in `providerErrors` (`provider`, `code`, `message`) while the others still answer; spending and cash flow then set `complete: false` and add `provider_unavailable`. The call fails only when no provider answers.

## Information budget

Expose a field when it helps an agent select a follow-up tool, identify a record, interpret an amount, or qualify an answer. Do not mirror the upstream schema wholesale. Balance labels, readable transaction types, and date provenance affect interpretation; raw bank-specific codes and provider query bookkeeping generally do not. Spending details are opt-in so a totals question does not load hundreds of transactions.

This follows the contextual-relevance and concise/detailed-response recommendations in [Anthropic's tool-design guidance](https://www.anthropic.com/engineering/writing-tools-for-agents). Smaller responses alone are not proof of better reasoning: evaluate task accuracy alongside payload size, tool calls, and error recovery. The tests verify that concise and detailed spending return identical totals and completeness warnings.

## TrueLayer (UK) mapping

TrueLayer Data API v1 responses are converted into the same tool schemas. Differences from Enable Banking:

- **Account IDs**: `tl-a-<account_id>` for bank accounts and `tl-c-<account_id>` for cards. Account numbers, sort codes, IBANs, and partial card numbers are never returned. Country is always `GB`.
- **Account type**: `TRANSACTION` → `current`, `SAVINGS` → `savings`, cards → `card`; `BUSINESS_*` types set `usage: professional`.
- **Balances**: TrueLayer returns JSON numbers, converted to exact decimal strings. Accounts expose `current` (`interim_booked`), `available` (`interim_available`, may include the overdraft), and the arranged overdraft limit (`informational`). Cards expose current balance, available credit, credit limit, and last statement balance (`closing_booked`, with `referenceDate`). TrueLayer's `update_timestamp` is when TrueLayer fetched the data, so it is not mapped to `lastChangedAt`.
- **Transaction direction**: taken from `transaction_type`. Account amounts are signed but card amounts are not, so the sign is ignored.
- **Transaction dates**: settled `timestamp` is the posting date → `bookingDate` (spending marks it as inferred). Pending `timestamp` → `transactionDate`. Timestamps are UTC instants and are converted to the Europe/London date; timestamps without an offset keep their written date.
- **Other fields**: `counterparty` is the first of `merchant_name`, `meta.provider_merchant_name`, `meta.counter_party_preferred_name`, and (credits only) `meta.debtor_account_name`; `description` plus the owner's `meta.user_comments` → `description`; normalised provider transaction ID → `reference`; `meta.provider_reference` → `paymentReference`; the bank's `meta.provider_category`, else TrueLayer's `transaction_category` → `bankTransactionDescription`. TrueLayer's inferred `transaction_classification` is not exposed, because tools must not present inferred spending categories as bank data.
- **Pagination**: TrueLayer returns a whole date range at once. The Worker reads 92-day windows from newest to oldest and uses the next window as the continuation key, so a 366-day scan takes four pages per account and three accounts fit inside the 20-page summary limit. Pending transactions are read once, on the first page. TrueLayer responses may be up to 4 MB (other providers: 1 MB).
- **Refused history**: when a window fails with `sca_exceeded`, paging stops with `historyUnavailable: true` instead of failing the tool. Scans report `history_unavailable`. Banks that return empty results instead cannot be detected.
- **Statuses**: only `booked` (settled) and `pending` exist. Filters for other statuses return no records.
- **Not available from TrueLayer** (left empty rather than invented): account holder `name` and `description`, balance `lastChangedAt`, transaction `valueDate` and `merchantCategoryCode`, and the `held`, `cancelled`, `rejected`, `scheduled` and `other` statuses.
- **Number precision**: TrueLayer sends amounts as JSON numbers. They are converted to exact decimal strings and padded to the currency's minor units (`-2.9` → `"2.90"`), which is exact for normal currency amounts; values beyond about 15 significant digits would lose precision before the Worker sees them.
- **Duplicate accounts**: when the same bank is connected twice, all-account reads list each account once, preferring the newest connection. Matching uses the IBAN or sort code and account number (cards: network, last digits, and expiry) in memory only; these identifiers are never returned or stored.
