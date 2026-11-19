import type { BankProvider } from "../types";
import { EnableBankingClient } from "./client";
import type { EnableBankingConfig } from "./config";
import { EnableBankingSetup } from "./setup";
import { KvSessionStore } from "./session-store";

const ENABLE_BANKING_ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** EU bank accounts through Enable Banking. Stores only session IDs in KV. */
export function enableBankingProvider(config: EnableBankingConfig, kv: KVNamespace): BankProvider {
  const sessions = new KvSessionStore(kv);
  return {
    name: "enable_banking",
    ownsAccountId: (accountId) => ENABLE_BANKING_ACCOUNT_ID.test(accountId),
    reader: (psu) => new EnableBankingClient(config, sessions, psu),
    setup: new EnableBankingSetup(new EnableBankingClient(config, sessions)),
  };
}
