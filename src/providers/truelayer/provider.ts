import type { ProviderModule } from "../types";
import { TrueLayerClient } from "./client";
import { TRUELAYER_SECRETS, trueLayerConfigFromEnv } from "./config";
import { KvTrueLayerConnectionStore } from "./connection-store";
import { TrueLayerSetup } from "./setup";

/** UK bank accounts through TrueLayer. Stores encrypted token records in KV. Account IDs: tl-a-* / tl-c-*. */
export const trueLayerModule: ProviderModule = {
  key: "truelayer",
  label: "UK banks (TrueLayer)",
  secrets: TRUELAYER_SECRETS,
  fromEnv(env, shared) {
    const config = trueLayerConfigFromEnv(env);
    if (config === undefined) return undefined;
    // Refresh tokens are long-lived credentials; never store them unencrypted.
    if (shared.tokenCipher === undefined) {
      throw new Error("TrueLayer needs TOKEN_ENCRYPTION_KEY to store refresh tokens.");
    }
    const store = new KvTrueLayerConnectionStore(shared.kv, shared.tokenCipher);
    return {
      name: this.key,
      label: this.label,
      ownsAccountId: (accountId) => accountId.startsWith("tl-"),
      reader: (psu) => new TrueLayerClient(config, store, psu),
      setup: new TrueLayerSetup(config, new TrueLayerClient(config, store)),
    };
  },
};
