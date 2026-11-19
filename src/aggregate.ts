import type { AccountSummary, ProviderError, ProviderKey, TransactionPage } from "./finance";
import type { PsuContext } from "./lib/psu";
import { isSetupRequired, publicErrorFields, setupRequired, unknownAccount } from "./providers/shared";
import type { BalanceReadResult, BankProvider, FinanceReader, TransactionQuery } from "./providers/types";

/** Results from every configured provider, plus the providers that could not be read. */
export interface ProviderResult<T> {
  value: T;
  providerErrors: ProviderError[];
}

interface ConfiguredReader {
  name: ProviderKey;
  ownsAccountId(accountId: string): boolean;
  reader: FinanceReader;
}

/**
 * Presents every configured provider's accounts as one account list. Works with any
 * number of providers, including none (every read then reports setup_required).
 */
export class Aggregate {
  private readonly providers: readonly ConfiguredReader[];

  /** Request-scoped: readers share token work within one request only. */
  constructor(providers: readonly BankProvider[], psu: PsuContext) {
    this.providers = providers.map((provider) => ({
      name: provider.name,
      ownsAccountId: provider.ownsAccountId,
      reader: provider.reader(psu),
    }));
  }

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
      } else if (!isSetupRequired(result.reason)) {
        firstFailure ??= result.reason;
        providerErrors.push({ provider: this.providers[index]!.name, ...publicErrorFields(result.reason) });
      }
    });

    if (values.length === 0) throw firstFailure ?? setupRequired();
    return { values, providerErrors };
  }
}
