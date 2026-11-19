import type { ProviderModule } from "../types";
import { EnableBankingClient } from "./client";
import { ENABLE_BANKING_SECRETS, enableBankingConfigFromEnv } from "./config";
import { KvSessionStore } from "./session-store";
import { EnableBankingSetup } from "./setup";

// Enable Banking account IDs are bare UUIDs. They predate provider prefixes and are kept
// for existing clients; every other provider must use its own prefix (e.g. "tl-").
const ENABLE_BANKING_ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** EU bank accounts through Enable Banking. Stores only session IDs in KV. */
export const enableBankingModule: ProviderModule = {
  key: "enable_banking",
  label: "EU banks (Enable Banking)",
  secrets: ENABLE_BANKING_SECRETS,
  fromEnv(env, shared) {
    const config = enableBankingConfigFromEnv(env);
    if (config === undefined) return undefined;
    const sessions = new KvSessionStore(shared.kv);
    return {
      name: this.key,
      label: this.label,
      ownsAccountId: (accountId) => ENABLE_BANKING_ACCOUNT_ID.test(accountId),
      reader: (psu) => new EnableBankingClient(config, sessions, psu),
      setup: new EnableBankingSetup(new EnableBankingClient(config, sessions)),
    };
  },
};
