import { errorMessage, PublicError } from "../errors";
import type { AccountSummary, ProviderError, ProviderName, TransactionPage } from "../finance";
import { isTrueLayerAccountId } from "./truelayer/client";
import type { BalanceReadResult, FinanceProvider, TransactionQuery } from "./types";

/** Results from every configured provider, plus the providers that could not be read. */
export interface ProviderResult<T> {
  value: T;
  providerErrors: ProviderError[];
}

/** What the MCP tools need: all-account reads tolerate one provider failing. */
export interface AggregateFinanceProvider {
  listAccounts(): Promise<ProviderResult<AccountSummary[]>>;
  listAccountIds(): Promise<ProviderResult<string[]>>;
  getBalances(accountId?: string): Promise<ProviderResult<BalanceReadResult>>;
  listTransactions(accountId: string, query: TransactionQuery): Promise<TransactionPage>;
}

/**
 * Presents Enable Banking (EU) and TrueLayer (UK) accounts as one account list.
 * TrueLayer account IDs carry a "tl-" prefix; every other ID belongs to Enable Banking.
 */
export class CompositeFinanceProvider implements AggregateFinanceProvider {
  private readonly providers: ReadonlyArray<readonly [ProviderName, FinanceProvider]>;

  constructor(
    private readonly enableBanking: FinanceProvider,
    private readonly trueLayer?: FinanceProvider,
  ) {
    this.providers = trueLayer === undefined
      ? [["enable_banking", enableBanking]]
      : [["enable_banking", enableBanking], ["truelayer", trueLayer]];
  }

  async listAccounts(): Promise<ProviderResult<AccountSummary[]>> {
    const { values, providerErrors } = await this.fromAll((provider) => provider.listAccounts());
    return { value: values.flat(), providerErrors };
  }

  async listAccountIds(): Promise<ProviderResult<string[]>> {
    const { values, providerErrors } = await this.fromAll((provider) => provider.listAccountIds());
    return { value: values.flat(), providerErrors };
  }

  async getBalances(accountId?: string): Promise<ProviderResult<BalanceReadResult>> {
    if (accountId !== undefined) {
      return { value: await this.providerFor(accountId).getBalances(accountId), providerErrors: [] };
    }
    const { values, providerErrors } = await this.fromAll((provider) => provider.getBalances());
    return {
      value: {
        balances: values.flatMap((result) => result.balances),
        errors: values.flatMap((result) => result.errors),
      },
      providerErrors,
    };
  }

  listTransactions(accountId: string, query: TransactionQuery): Promise<TransactionPage> {
    return this.providerFor(accountId).listTransactions(accountId, query);
  }

  private providerFor(accountId: string): FinanceProvider {
    if (!isTrueLayerAccountId(accountId)) return this.enableBanking;
    if (this.trueLayer === undefined) {
      throw new PublicError(
        "Unknown or inactive account ID. Call finance_list_accounts again.",
        "unknown_account",
      );
    }
    return this.trueLayer;
  }

  /**
   * A provider with no connected banks is skipped silently. A provider that fails is
   * reported in providerErrors while the others still answer. Only when no provider
   * answers does the call fail: with setup_required if nothing is connected anywhere.
   */
  private async fromAll<T>(
    read: (provider: FinanceProvider) => Promise<T>,
  ): Promise<{ values: T[]; providerErrors: ProviderError[] }> {
    const settled = await Promise.allSettled(this.providers.map(([, provider]) => read(provider)));
    const values: T[] = [];
    const providerErrors: ProviderError[] = [];
    let firstFailure: unknown;
    let setupRequired: unknown;

    settled.forEach((result, index) => {
      const [name] = this.providers[index]!;
      if (result.status === "fulfilled") {
        values.push(result.value);
      } else if (result.reason instanceof PublicError && result.reason.code === "setup_required") {
        setupRequired = result.reason;
      } else {
        firstFailure ??= result.reason;
        providerErrors.push({
          provider: name,
          code: result.reason instanceof PublicError ? result.reason.code : "provider_error",
          message: errorMessage(result.reason),
        });
      }
    });

    if (values.length === 0) throw firstFailure ?? setupRequired;
    return { values, providerErrors };
  }
}
