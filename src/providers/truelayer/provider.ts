import { TokenCipher } from "../../lib/crypto";
import type { BankProvider } from "../types";
import { TrueLayerClient } from "./client";
import type { TrueLayerConfig } from "./config";
import { KvTrueLayerConnectionStore } from "./connection-store";
import { TrueLayerSetup } from "./setup";

/** UK bank accounts through TrueLayer. Stores encrypted token records in KV. Account IDs: tl-a-* / tl-c-*. */
export function trueLayerProvider(config: TrueLayerConfig, kv: KVNamespace): BankProvider {
  const store = new KvTrueLayerConnectionStore(kv, new TokenCipher(config.tokenEncryptionKey));
  return {
    name: "truelayer",
    ownsAccountId: (accountId) => accountId.startsWith("tl-"),
    // TrueLayer forwards only the IP address (X-PSU-IP).
    reader: (psu) => new TrueLayerClient(config, store, psu.ipAddress === undefined ? {} : { ipAddress: psu.ipAddress }),
    setup: new TrueLayerSetup(config, new TrueLayerClient(config, store)),
  };
}
