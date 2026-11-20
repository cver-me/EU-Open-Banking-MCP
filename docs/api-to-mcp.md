# API-to-MCP mapping

The Worker exposes a small finance interface, validates provider responses, and derives bounded summaries. It preserves the distinction between bank facts and Worker estimates. The upstream contract is [Enable Banking's API reference](https://enablebanking.com/docs/api/reference/).

## Tool boundaries

| Tool | Upstream reads | Meaning of the result |
| --- | --- | --- |
| List accounts | Active sessions, then account details; stored connections | Discoverable account metadata, deduplicated by the primary identity hash when available, plus each connection's consent state |
| Get balances | Active sessions, then balance measurements | Alternative measurements with bank labels and dates; never a sum of balance types |
| List transactions | Active sessions, then one provider transaction page | Normalized records with a derived payee; an MCP page can be a slice of a larger provider page |
| Search transactions | Up to five provider pages per account, 30 across all accounts | Text matches across counterparty, description, entry/payment references, and bank classification description, or a payee match |
| Get cash flow | Bounded scans of every account with seven-day date padding | Income, spending, refunds, net and own-account transfers per currency and period |
| Get spending breakdown | The same scans | Largest groups of money out or in, by payee, account, kind or bank transaction type |
| List recurring | Up to 12 months of scans | Payees paid or paying on a weekly to yearly rhythm, with amounts, trend, next date and upcoming occurrences |
| Review activity | The range plus up to 6 months before it | Findings worth checking, each with its supporting transactions |

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

## Derived values

The analysis tools derive three things from each transaction and never change the bank's own fields:

- **Date.** `transactionDate` is preferred. For cards this is the bank-reported purchase date; for other payment types it can represent acquisition or receipt. If absent, the earlier booking/value date is a heuristic. Analysis transactions show the date used as `date`.
- **Payee.** The counterparty, else a name read from known description wording, cleaned of masked card numbers, dates, reference codes and company suffixes. `payeeKey` groups one merchant written in different ways; it is not a verified merchant identity.
- **Kind.** `spending`, `income`, `refund`, `fee`, `cash_withdrawal` or `internal_transfer`, with a `kindReason`. Structure decides first: transfers between the owner's accounts are matched by amount, currency and date across connected accounts, or by the exact name of an account holder (alone, or first on a joint account such as "Jane Example & Sam Other"); truncated or partial names never count. Refunds are credits from a payee paid at least as much in the 90 days before. Wording comes second, from one table in `src/analysis/wording.ts`: fees, cash withdrawals and refunds in English, Italian, German, French, Spanish, Dutch and Portuguese, the own-money wording of specific banks (Revolut pockets and exchanges, Starling Spaces and Saver), and Italian bank descriptions that wrap the payee's name. Every rule names its bank or language and carries a synthetic example that the tests check, together with ordinary merchant names it must not misread. Transfers between currencies, or to accounts that are not connected, are only found by wording. A bank or language not in the table falls back to plain spending and income, and `kindReason` always says which rule applied.

No-date entries cannot be placed inside a requested interval, especially when the provider query was widened. They are excluded with `missing_dates` in `incompleteReasons`. Unknown lifecycle statuses are excluded with `unknown_status`. Booked, pending and held records count; cancelled, rejected and scheduled records do not. A hold or pending record can change or disappear, and the Worker does not consolidate pending and booked versions of one payment.

## Completeness and precision

- `complete` describes the bounded scan and any records left out for missing dates or unknown statuses. It does not certify bank history coverage.
- `incompleteReasons` distinguishes scan limits, repeated continuation keys, refused history, unavailable providers, accounts that could not be read (`account_unavailable` with `accountErrors`; a rate-limited bank costs only its own accounts), left-out records, and `history_starts_late`: no account returned anything in the first month of the range, which usually means the banks shared less history than asked (`dataStartsOn` gives the earliest date seen).
- The spending breakdown returns groups by default; `includeTransactions: true` adds each listed group's latest 10 transactions.
- Provider date filters use the bank's semantics. Seven-day padding is a retrieval heuristic, not a guarantee against long posting delays.
- MCP cursors bind account and filters but do not create snapshots. Continuing a sliced page re-reads live provider data; clients should restart if the underlying data changes.
- Amounts remain strings. Provider inputs allow at most 100 characters; a separate Decimal constructor supplies enough precision for mixed scales and at most 10,000 included records. Currencies are never converted or combined.
- Every amount the tools return (balances, transactions and every analysis total, for every provider) has at least its currency's ISO 4217 minor-unit digits: `"9000.00"` GBP, `"1500"` JPY, `"1.500"` KWD. Extra digits a bank reports are kept, never rounded, and zero is never signed.
- Every account has its own `currency`, and every balance and transaction states the currency of its amount. A bank's country does not imply the currency: a UK bank can hold a EUR account and an EU bank a GBP account.

These rules are exercised with synthetic provider fixtures and Worker-level MCP calls. Live smoke tests must keep account identifiers and financial payloads out of repository fixtures and reports.

## Provider failures

All-account reads (`finance_list_accounts`, `finance_get_balances` without `accountId`, search and the analysis tools without `accountId`) query every configured provider. A provider with no connected banks is skipped. A provider that fails is listed in `providerErrors` (`provider`, `code`, `message`) while the others still answer; the analysis tools then set `complete: false` and add `provider_unavailable`. The call fails only when no provider answers.

## Information budget

Expose a field when it helps an agent select a follow-up tool, identify a record, interpret an amount, or qualify an answer. Do not mirror the upstream schema wholesale. Balance labels, readable transaction types, and date provenance affect interpretation; raw bank-specific codes and provider query bookkeeping generally do not. Arithmetic, grouping and pattern-finding happen in the Worker, so a question about totals, top payees or subscriptions costs one call and a small answer instead of hundreds of records; transactions are opt-in or limited to supporting evidence. Meaning that needs world knowledge, such as which payees are groceries, is left to the agent.

This follows the contextual-relevance and concise/detailed-response recommendations in [Anthropic's tool-design guidance](https://www.anthropic.com/engineering/writing-tools-for-agents). Smaller responses alone are not proof of better reasoning: evaluate task accuracy alongside payload size, tool calls, and error recovery.

## TrueLayer (UK) mapping

TrueLayer Data API v1 responses are converted into the same tool schemas. Differences from Enable Banking:

- **Account IDs**: `tl-a-<account_id>` for bank accounts and `tl-c-<account_id>` for cards. Account numbers, sort codes, IBANs, and partial card numbers are never returned. Country is always `GB`.
- **Account type**: `TRANSACTION` → `current`, `SAVINGS` → `savings`, cards → `card`; `BUSINESS_*` types set `usage: professional`.
- **Balances**: TrueLayer returns JSON numbers, converted to exact decimal strings. Accounts expose `current` (`interim_booked`), `available` (`interim_available`, may include the overdraft), and the arranged overdraft limit (`informational`). Cards expose current balance, available credit, credit limit, and last statement balance (`closing_booked`, with `referenceDate`). TrueLayer's `update_timestamp` is when TrueLayer fetched the data, so it is not mapped to `lastChangedAt`.
- **Transaction direction**: taken from `transaction_type`. Account amounts are signed but card amounts are not, so the sign is ignored.
- **Transaction dates**: settled `timestamp` is the posting date → `bookingDate`, a stand-in for the purchase date. Pending `timestamp` → `transactionDate`. Timestamps are UTC instants and are converted to the Europe/London date; timestamps without an offset keep their written date.
- **Other fields**: `counterparty` is the first of `merchant_name`, `meta.provider_merchant_name`, `meta.counter_party_preferred_name`, and (credits only) `meta.debtor_account_name`; `description` plus the owner's `meta.user_comments` → `description`; normalised provider transaction ID → `reference`; `meta.provider_reference` → `paymentReference`; the bank's `meta.provider_category`, else TrueLayer's `transaction_category` → `bankTransactionDescription`. TrueLayer's inferred `transaction_classification` is not exposed, because tools must not present inferred spending categories as bank data.
- **Pagination**: TrueLayer returns a whole date range at once. The Worker reads 92-day windows from newest to oldest and uses the next window as the continuation key, so a 366-day scan takes four pages per account and three accounts fit inside the 20-page summary limit. Pending transactions are read once, on the first page. TrueLayer responses may be up to 4 MB (other providers: 1 MB).
- **Refused history**: when a window fails with `sca_exceeded`, paging stops with `historyUnavailable: true` instead of failing the tool. Scans report `history_unavailable`. Banks that return empty results instead cannot be detected.
- **Statuses**: only `booked` (settled) and `pending` exist. Filters for other statuses return no records.
- **Not available from TrueLayer** (left empty rather than invented): account holder `name` and `description`, balance `lastChangedAt`, transaction `valueDate` and `merchantCategoryCode`, and the `held`, `cancelled`, `rejected`, `scheduled` and `other` statuses.
- **Number precision**: TrueLayer sends amounts as JSON numbers. They are converted to exact decimal strings and padded to the currency's minor units (`-2.9` → `"2.90"`), which is exact for normal currency amounts; values beyond about 15 significant digits would lose precision before the Worker sees them.
- **Duplicate accounts**: when the same bank is connected twice, all-account reads list each account once, preferring the newest connection. Matching uses the IBAN or sort code and account number (cards: network, last digits, and expiry) in memory only; these identifiers are never returned or stored.
