# Provider parity: Enable Banking vs TrueLayer

Goal: every MCP tool returns the same kind of information for a UK account (TrueLayer) as for an EU account (Enable Banking), or says clearly why it can't.

Sources: Enable Banking schemas in `src/providers/enable-banking/schemas.ts`, TrueLayer Data API v1 reference, and a live Starling connection inspected on 2026-11-19. Only field names, types, and enum values were inspected; no amounts, names, or IDs.

Status key: ✅ same as Enable Banking · 🟡 filled, but differently or partly · ❌ missing · ➖ not applicable

## Accounts (`finance_list_accounts`)

| MCP field | Enable Banking source | TrueLayer source today | Starling live | Status | Action |
| --- | --- | --- | --- | --- | --- |
| `accountId` | session account UID | `tl-a-` / `tl-c-` + `account_id` | present | ✅ | — |
| `institution` | ASPSP name | `/me` provider name | "Starling" | ✅ | — |
| `country` | ASPSP country | hard-coded `GB` | — | 🟡 | Fine while only UK providers (`uk-ob-all`) are requested |
| `currency` | details currency | `currency` | GBP, EUR | ✅ | — |
| `name` (holder name) | details `name` | not requested | `/info` → 403 (no `info` scope) | ➖ | Not needed (decided 2026-11-19) |
| `product` | details `product` | `display_name` | "Personal", "Euro", "Easy Saver" | ✅ | — |
| `description` | details `details` | — | not offered | ➖ | — |
| `usage` | `PRIV`/`ORGA` | from `account_type` (`BUSINESS_*`) | TRANSACTION, SAVINGS | ✅ | — |
| `cashAccountType` | `cash_account_type` | from `account_type`; cards → `card` | current, savings | ✅ | — |
| Duplicate-account removal | primary identification hash | IBAN or sort code + number (cards: network + last digits + expiry), in memory only | — | ✅ | Fixed; newest connection wins, older duplicate still readable by ID |

## Balances (`finance_get_balances`)

| MCP field | Enable Banking source | TrueLayer source today | Starling live | Status | Action |
| --- | --- | --- | --- | --- | --- |
| `amount` | exact decimal string | JSON number → decimal string | present | 🟡 | Exact for normal amounts; limit documented in api-to-mcp.md |
| `balanceType` | ISO 20022 code (12 types) | `current` → `interim_booked`, `available` → `interim_available`, overdraft → `informational` | current, available, overdraft | 🟡 | Mapping is an interpretation; UK OB doesn't say which ISO type TrueLayer flattened |
| `label` | bank's balance name | fixed descriptive labels | "current balance (booked)", "available balance (includes any arranged overdraft)" | ✅ | Fixed: no longer reads like "current account" |
| `referenceDate` | bank reference date | card statement date only | — | 🟡 | — |
| `lastChangedAt` | bank last-change time | not mapped (`update_timestamp` is TrueLayer's fetch time) | present | ➖ | Keep unmapped; document |

## Transactions (`finance_list_transactions`, search, spending, cash flow)

| MCP field | Enable Banking source | TrueLayer source today | Starling live | Status | Action |
| --- | --- | --- | --- | --- | --- |
| `amount` / `direction` | amount + `CRDT`/`DBIT` | abs(amount) + `transaction_type` | present | ✅ | — |
| `status` | 7 statuses | `booked` (settled), `pending` | both | 🟡 | `held`, `cancelled`, `rejected`, `scheduled` don't exist in TrueLayer v1 |
| `transactionDate` | bank transaction date | pending `timestamp`, as a Europe/London date | timestamps carry a time, in UTC | ✅ | Fixed: UTC instants are converted to the London date |
| `bookingDate` | booking date | settled `timestamp`, as a Europe/London date | UTC datetime | 🟡 | Fixed London date. Spending still marks these as inferred dates (posting, not purchase date) |
| `valueDate` | value date | — | not offered | ❌ | Not available in TrueLayer v1 |
| `counterparty` | creditor/debtor name | `merchant_name` → `meta.provider_merchant_name` → `meta.counter_party_preferred_name` → `meta.debtor_account_name` (credits only) | 12 of 13 live transactions now have one | ✅ | Fixed (was 1 of 13) |
| `description` | remittance info + note | `description` + `meta.user_comments` | present 14/14; no notes on this account | ✅ | Fixed: owner note appended like Enable Banking's `note` |
| `merchantCategoryCode` | MCC | — | not offered | ❌ | Not available in TrueLayer v1 |
| `reference` | entry reference | normalised provider transaction ID | present | ✅ | — |
| `paymentReference` | creditor reference | `meta.provider_reference` | absent for Starling | 🟡 | Bank-dependent |
| `bankTransactionDescription` | bank transaction code description | bank's `meta.provider_category`, else TrueLayer `transaction_category` | e.g. "faster payments in", "master card", "direct debit" | ✅ | Fixed |
| Pagination | provider continuation key | 92-day windows, newest first | verified live: 366 days = 4 pages per account, one-year cash flow complete | ✅ | Widened from 31 days, which broke the 20-page scan limit with 3 accounts |
| Pending reads | in main list | separate endpoint, first page only | verified live | ✅ | — |

## Connection lifecycle

| Area | Enable Banking | TrueLayer today | Status | Action |
| --- | --- | --- | --- | --- |
| Consent length | bank maximum (often 180 days) | 90 days; `/setup` warns 14 days ahead and has Reconnect, which replaces the old connection when the same bank is reconnected | 🟡 | `/connections/extend` needs TrueLayer to review our consent screen and requires storing the owner's name and email/phone, so Reconnect is used instead |
| Expired consent | session skipped, setup required | connection skipped, setup required; `/setup` marks it EXPIRED | ✅ | Fixed |
| Revocation on remove | closes session | `DELETE /api/delete` | ✅ | Verified live: revoking the old credential during Reconnect left the new one working |
| Account IDs after renewal | new IDs after reauthorization | Starling kept the same account IDs after Reconnect (verified live) | ✅ | Bank-dependent; clients should still rediscover with `finance_list_accounts` |
| History older than 90 days | bank-dependent | `sca_exceeded` stops paging with `historyUnavailable`; scans report `history_unavailable` | 🟡 | Fixed for banks that refuse. Starling returns empty results instead (verified live), which can't be detected |
| Token refresh races | — (stateless JWT) | per-request dedup only | 🟡 | Not yet observed live (no refresh happened during testing). Check whether Starling's refresh token rotates; keep storing any rotated token |
| Provider failure isolation | — | partial results plus `providerErrors`; scans marked `provider_unavailable` | ✅ | Fixed |

## Gap list, in suggested order

1. ~~**Counterparty bug**~~ — fixed.
2. ~~**London dates**~~ — fixed.
3. ~~**Bank transaction type** and owner note~~ — fixed.
4. ~~**Provider isolation**~~ — fixed.
5. ~~**Older history**~~ — fixed (bank-dependent; see lifecycle table). Also widened windows to 92 days after a live one-year scan hit the page limit.
6. ~~**Duplicate accounts**~~ — fixed.
7. ~~**Holder name**~~ — not needed.
8. ~~**Consent renewal**~~ — Reconnect button and expiry warnings (extend endpoint needs TrueLayer review).
9. ~~**Labels and docs**~~ — fixed.
10. ~~**Local dev**~~ — providers are optional and no secrets are declared as required, so plain `bun run dev` loads whatever `.dev.vars` contains.
