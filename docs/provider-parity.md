# Provider parity: Enable Banking and TrueLayer

Every MCP tool returns the same kind of information for a UK account (TrueLayer) as for an EU account (Enable Banking), or the difference is stated here.

Sources: Enable Banking schemas in `src/providers/enable-banking/schemas.ts`, the TrueLayer Data API v1 reference, and live UK and EU connections. Live checks looked only at field names, types, and enum values, never amounts, names, or IDs.

Status key: ✅ equivalent · 🟡 filled, but differently or partly · ❌ not available from the provider · ➖ intentionally not mapped

## Accounts (`finance_list_accounts`)

| MCP field | Enable Banking source | TrueLayer source | Status | Notes |
| --- | --- | --- | --- | --- |
| `accountId` | session account UID (bare UUID) | `tl-a-` (accounts) / `tl-c-` (cards) + `account_id` | ✅ | Opaque either way; the prefix routes IDs to their provider |
| `institution` | ASPSP name | provider name from `/me` | ✅ | |
| `country` | ASPSP country | `GB` | 🟡 | Only UK providers (`uk-ob-all`, `uk-oauth-all`) are requested |
| `currency` | account details | account or card `currency` | ✅ | The account's own currency; a bank's country does not imply it |
| `name` (holder) | account details | — | ➖ | Would need TrueLayer's `info` scope; not requested |
| `product` | account details | `display_name` (cards: network and type) | ✅ | |
| `description` | account details | — | ❌ | |
| `usage` | `PRIV` / `ORGA` | `BUSINESS_*` account types → `professional` | ✅ | |
| `cashAccountType` | `cash_account_type` | `TRANSACTION` → `current`, `SAVINGS` → `savings`, cards → `card` | ✅ | |
| Duplicate removal | primary identification hash plus currency | IBAN, or sort code and number (cards: network, last digits, expiry), plus currency | ✅ | In memory only; currency accounts sharing one IBAN stay separate |

## Balances (`finance_get_balances`)

| MCP field | Enable Banking source | TrueLayer source | Status | Notes |
| --- | --- | --- | --- | --- |
| `amount` | decimal string | JSON number → exact decimal string | ✅ | Both formatted to the currency's minor-unit digits |
| `balanceType` | ISO 20022 code | `current` → `interim_booked`, `available` → `interim_available`, overdraft and credit limit → `informational`, last statement → `closing_booked` | 🟡 | TrueLayer flattens each bank's balances into a few fields; the mapping is an interpretation |
| `label` | bank's balance name | fixed descriptive labels | 🟡 | e.g. "current balance (booked)", "available balance (includes any arranged overdraft)" |
| `referenceDate` | bank reference date | card last-statement date only | 🟡 | |
| `lastChangedAt` | bank last-change time | — | ➖ | TrueLayer's `update_timestamp` is its own fetch time, not a bank change time |

## Transactions (list, search and analysis tools)

| MCP field | Enable Banking source | TrueLayer source | Status | Notes |
| --- | --- | --- | --- | --- |
| `amount` / `direction` | amount + `CRDT` / `DBIT` | absolute amount + `transaction_type` | ✅ | Card amounts are unsigned, so the type decides direction |
| `status` | seven statuses | `booked` (settled) and `pending` | 🟡 | `held`, `cancelled`, `rejected`, `scheduled` do not exist in TrueLayer v1 |
| `transactionDate` | bank transaction date | pending `timestamp`, as a Europe/London date | 🟡 | Timestamps are UTC instants |
| `bookingDate` | booking date | settled `timestamp`, as a Europe/London date | 🟡 | A posting date, used as a stand-in for the purchase date |
| `valueDate` | value date | — | ❌ | |
| `counterparty` | creditor or debtor name | `merchant_name`, then `meta.provider_merchant_name`, `meta.counter_party_preferred_name`, and (credits only) `meta.debtor_account_name` | ✅ | Banks fill different fields; some send the merchant only in `meta` |
| `description` | remittance information + note | `description` + `meta.user_comments` | ✅ | |
| `merchantCategoryCode` | MCC | — | ❌ | |
| `reference` | entry reference | normalised provider transaction ID | ✅ | |
| `paymentReference` | creditor reference | `meta.provider_reference` | 🟡 | Bank-dependent |
| `bankTransactionDescription` | bank transaction code | bank's `meta.provider_category`, else TrueLayer's `transaction_category` | ✅ | e.g. "faster payments in", "direct debit" |
| Pagination | provider continuation key | 92-day windows, newest first | ✅ | A 366-day scan takes four pages per account |
| Pending | in the main list | separate endpoint, read on the first page | ✅ | |

## Connection lifecycle

| Area | Enable Banking | TrueLayer | Status | Notes |
| --- | --- | --- | --- | --- |
| Consent length | bank maximum | 90 days | 🟡 | `/setup` warns 14 days ahead; **Reconnect** replaces the old connection when the same bank is reconnected. TrueLayer's `/connections/extend` needs a reviewed consent screen and the owner's contact details, so it is not used |
| Expired consent | session skipped | connection skipped and marked EXPIRED on `/setup` | ✅ | |
| Removal | closes the session | revokes the credential (`DELETE /api/delete`) | ✅ | |
| Account IDs after renewal | new IDs | bank-dependent; some banks keep them | ✅ | Clients should rediscover with `finance_list_accounts` |
| History older than 90 days | bank-dependent | `sca_exceeded` stops paging with `historyUnavailable`; scans report `history_unavailable` | 🟡 | Some banks return empty results instead, which cannot be told apart from no activity |
| Token refresh | — (stateless JWT) | refreshed per request when expired; any rotated refresh token is stored | 🟡 | Concurrent refreshes from separate requests are not serialized |
| Provider failure | — | the other provider's accounts are still returned, with `providerErrors` | ✅ | The analysis tools add `provider_unavailable` |

## Not available from TrueLayer

Left empty rather than invented: account holder `name` and `description`, balance `lastChangedAt`, transaction `valueDate` and `merchantCategoryCode`, and the `held`, `cancelled`, `rejected`, `scheduled`, and `other` statuses.
