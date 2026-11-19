import { errorMessage, PublicError } from "./errors";
import type { AccountSummary, ProviderError, ProviderName, TransactionPage } from "./finance";
import { setupRequired, unknownAccount } from "./providers/shared";
import type { BalanceReadResult, FinanceReader, TransactionQuery } from "./providers/types";

/** Results from every configured provider, plus the providers that could not be read. */
export interface ProviderResult<T> {
  value: T;
  providerErrors: ProviderError[];
}

/** The reads the MCP tools use. All-account reads tolerate one provider failing. */
export interface AggregateFinanceProvider {
  listAccounts(): Promise<ProviderResult<AccountSummary[]>>;
  listAccountIds(): Promise<ProviderResult<string[]>>;
  getBalances(accountId?: string): Promise<ProviderResult<BalanceReadResult>>;
  listTransactions(accountId: string, query: TransactionQuery): Promise<TransactionPage>;
}

export interface NamedReader {
  name: ProviderName;
  ownsAccountId(accountId: string): boolean;
  reader: FinanceReader;
}

/**
 * Presents every configured provider's accounts as one account list. Works with any
 * number of providers, including none (every read then reports setup_required).
 */
export class Aggregate implements AggregateFinanceProvider {
  constructor(private readonly providers: readonly NamedReader[]) {}

  async listAccounts(): Promise<ProviderResult<AccountSummary[]>> {
    const { values, providerErrors } = await this.fromAll((reader) => reader.listAccounts());
    return { value: values.flat(), providerErrors };
  }

  async listAccountIds(): Promise<ProviderResult<string[]>> {
    const { values, providerErrors } = await this.fromAll((reader) => reader.listAccountIds());
    return { value: values.flat(), providerErrors };
  }

  async getBalances(accountId?: string): Promise<ProviderResult<BalanceReadResult>> {
    if (accountId !== undefined) {
      return { value: await this.readerFor(accountId).getBalances(accountId), providerErrors: [] };
    }
    const { values, providerErrors } = await this.fromAll((reader) => reader.getBalances());
    return {
      value: {
        balances: values.flatMap((result) => result.balances),
        errors: values.flatMap((result) => result.errors),
      },
      providerErrors,
    };
  }

  listTransactions(accountId: string, query: TransactionQuery): Promise<TransactionPage> {
    return this.readerFor(accountId).listTransactions(accountId, query);
  }

  private readerFor(accountId: string): FinanceReader {
    const owner = this.providers.find((provider) => provider.ownsAccountId(accountId));
    if (owner === undefined) throw unknownAccount();
    return owner.reader;
  }

  /**
   * A provider with no connected banks is skipped silently. A provider that fails is
   * reported in providerErrors while the others still answer. Only when no provider
   * answers does the call fail: with setup_required if nothing is connected anywhere.
   */
  private async fromAll<T>(
    read: (reader: FinanceReader) => Promise<T>,
  ): Promise<{ values: T[]; providerErrors: ProviderError[] }> {
    const settled = await Promise.allSettled(this.providers.map(({ reader }) => read(reader)));
    const values: T[] = [];
    const providerErrors: ProviderError[] = [];
    let firstFailure: unknown;

    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        values.push(result.value);
      } else if (!(result.reason instanceof PublicError && result.reason.code === "setup_required")) {
        firstFailure ??= result.reason;
        providerErrors.push({
          provider: this.providers[index]!.name,
          code: result.reason instanceof PublicError ? result.reason.code : "provider_error",
          message: errorMessage(result.reason),
        });
      }
    });

    if (values.length === 0) throw firstFailure ?? setupRequired();
    return { values, providerErrors };
  }
}
