import { z } from "zod";
import { decodeEncryptionKey } from "./token-crypto";

const UUID = z.uuid();

const envSchema = z.object({
  ENABLE_BANKING_APPLICATION_ID: UUID,
  ENABLE_BANKING_PRIVATE_KEY_PEM: z.string().includes("PRIVATE KEY"),
});

const trueLayerEnvSchema = z.object({
  TRUELAYER_CLIENT_ID: z.string().trim().min(1).max(200),
  TRUELAYER_CLIENT_SECRET: z.string().trim().min(1).max(500),
  TOKEN_ENCRYPTION_KEY: z.string().trim().min(1),
});

const TRUELAYER_VARIABLES = [
  "TRUELAYER_CLIENT_ID",
  "TRUELAYER_CLIENT_SECRET",
  "TOKEN_ENCRYPTION_KEY",
] as const;

type OptionalTrueLayerEnv = Partial<Record<(typeof TRUELAYER_VARIABLES)[number], string>>;

export interface TrueLayerConfig {
  clientId: string;
  clientSecret: string;
  tokenEncryptionKey: Uint8Array<ArrayBuffer>;
  sandbox: boolean;
}

export interface AppConfig {
  enableBanking: {
    applicationId: string;
    privateKeyPem: string;
  };
  /** Present only when all TrueLayer secrets are configured. */
  trueLayer?: TrueLayerConfig;
}

export function loadConfig(env: Env): AppConfig {
  const parsed = envSchema.parse(env);
  const trueLayer = loadTrueLayerConfig(env as Env & OptionalTrueLayerEnv);

  return {
    enableBanking: {
      applicationId: parsed.ENABLE_BANKING_APPLICATION_ID,
      privateKeyPem: parsed.ENABLE_BANKING_PRIVATE_KEY_PEM,
    },
    ...(trueLayer === undefined ? {} : { trueLayer }),
  };
}

function loadTrueLayerConfig(env: OptionalTrueLayerEnv): TrueLayerConfig | undefined {
  // TrueLayer is optional, but a partial configuration is a deployment mistake.
  if (TRUELAYER_VARIABLES.every((name) => env[name] === undefined || env[name] === "")) {
    return undefined;
  }
  const parsed = trueLayerEnvSchema.parse(env);
  return {
    clientId: parsed.TRUELAYER_CLIENT_ID,
    clientSecret: parsed.TRUELAYER_CLIENT_SECRET,
    tokenEncryptionKey: decodeEncryptionKey(parsed.TOKEN_ENCRYPTION_KEY),
    // TrueLayer prefixes sandbox client IDs with "sandbox-".
    sandbox: parsed.TRUELAYER_CLIENT_ID.startsWith("sandbox-"),
  };
}
