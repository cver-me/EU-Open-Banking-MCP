import { z } from "zod";

export interface EnableBankingConfig {
  applicationId: string;
  privateKeyPem: string;
}

export const ENABLE_BANKING_SECRETS = ["ENABLE_BANKING_APPLICATION_ID", "ENABLE_BANKING_PRIVATE_KEY_PEM"] as const;

const schema = z.object({
  ENABLE_BANKING_APPLICATION_ID: z.uuid(),
  ENABLE_BANKING_PRIVATE_KEY_PEM: z.string().includes("PRIVATE KEY"),
});

/** Undefined when Enable Banking is not configured; throws on a partial or invalid configuration. */
export function enableBankingConfigFromEnv(env: Readonly<Record<string, unknown>>): EnableBankingConfig | undefined {
  if (ENABLE_BANKING_SECRETS.every((name) => !env[name])) return undefined;
  const parsed = schema.parse(env);
  return {
    applicationId: parsed.ENABLE_BANKING_APPLICATION_ID,
    privateKeyPem: parsed.ENABLE_BANKING_PRIVATE_KEY_PEM,
  };
}
