import { decodeEncryptionKey, TokenCipher } from "../lib/crypto";
import { enableBankingModule } from "./enable-banking/provider";
import { trueLayerModule } from "./truelayer/provider";
import type { BankProvider, ProviderModule, SharedSettings } from "./types";

/** Every provider this Worker can use, in display order. The only list of providers. */
export const PROVIDER_MODULES: readonly ProviderModule[] = [enableBankingModule, trueLayerModule];

/** Secrets are optional and not declared in wrangler.jsonc, so they are read untyped. */
export type ProviderEnv = Readonly<Record<string, unknown>> & { SESSION_STORE: KVNamespace };

/**
 * The providers this deployment has secrets for. Empty when none is configured.
 * Throws when a provider is only partly configured, so a typo in a secret name
 * fails loudly instead of silently disabling a provider.
 */
export function configuredProviders(env: ProviderEnv): BankProvider[] {
  const shared = sharedSettings(env);
  return PROVIDER_MODULES.flatMap((module) => module.fromEnv(env, shared) ?? []);
}

function sharedSettings(env: ProviderEnv): SharedSettings {
  const key = env.TOKEN_ENCRYPTION_KEY;
  return {
    kv: env.SESSION_STORE,
    ...(typeof key === "string" && key !== "" ? { tokenCipher: new TokenCipher(decodeEncryptionKey(key)) } : {}),
  };
}
