import { z } from "zod";
import { decodeEncryptionKey } from "../../lib/crypto";

export interface TrueLayerConfig {
  clientId: string;
  clientSecret: string;
  tokenEncryptionKey: Uint8Array<ArrayBuffer>;
  sandbox: boolean;
}

const VARIABLES = ["TRUELAYER_CLIENT_ID", "TRUELAYER_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"] as const;
export type TrueLayerEnv = Partial<Record<(typeof VARIABLES)[number], string>>;

const schema = z.object({
  TRUELAYER_CLIENT_ID: z.string().trim().min(1).max(200),
  TRUELAYER_CLIENT_SECRET: z.string().trim().min(1).max(500),
  TOKEN_ENCRYPTION_KEY: z.string().trim().min(1),
});

/** Undefined when TrueLayer is not configured; throws on a partial or invalid configuration. */
export function trueLayerConfigFromEnv(env: TrueLayerEnv): TrueLayerConfig | undefined {
  if (VARIABLES.every((name) => !env[name])) return undefined;
  const parsed = schema.parse(env);
  return {
    clientId: parsed.TRUELAYER_CLIENT_ID,
    clientSecret: parsed.TRUELAYER_CLIENT_SECRET,
    tokenEncryptionKey: decodeEncryptionKey(parsed.TOKEN_ENCRYPTION_KEY),
    // TrueLayer prefixes sandbox client IDs with "sandbox-".
    sandbox: parsed.TRUELAYER_CLIENT_ID.startsWith("sandbox-"),
  };
}
