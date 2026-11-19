import { enableBankingConfigFromEnv, type EnableBankingEnv } from "./enable-banking/config";
import { enableBankingProvider } from "./enable-banking/provider";
import { trueLayerConfigFromEnv, type TrueLayerEnv } from "./truelayer/config";
import { trueLayerProvider } from "./truelayer/provider";
import type { BankProvider } from "./types";

/** Every provider is optional; secrets are not declared in wrangler.jsonc, so read them as optional. */
export type ProviderEnv = EnableBankingEnv & TrueLayerEnv & { SESSION_STORE: KVNamespace };

/**
 * The providers this deployment has secrets for, in display order (EU, then UK).
 * Empty when none is configured. Throws when a provider is only partly configured,
 * so a typo in a secret name fails loudly instead of silently disabling a provider.
 */
export function configuredProviders(env: ProviderEnv): BankProvider[] {
  const enableBanking = enableBankingConfigFromEnv(env);
  const trueLayer = trueLayerConfigFromEnv(env);
  return [
    ...(enableBanking === undefined ? [] : [enableBankingProvider(enableBanking, env.SESSION_STORE)]),
    ...(trueLayer === undefined ? [] : [trueLayerProvider(trueLayer, env.SESSION_STORE)]),
  ];
}
