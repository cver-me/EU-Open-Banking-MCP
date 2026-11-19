import { z } from "zod";

export interface EnableBankingConfig {
  applicationId: string;
  privateKeyPem: string;
}

export type EnableBankingEnv = Partial<Record<"ENABLE_BANKING_APPLICATION_ID" | "ENABLE_BANKING_PRIVATE_KEY_PEM", string>>;

const schema = z.object({
  ENABLE_BANKING_APPLICATION_ID: z.uuid(),
  ENABLE_BANKING_PRIVATE_KEY_PEM: z.string().includes("PRIVATE KEY"),
});

/** Undefined when Enable Banking is not configured; throws on a partial or invalid configuration. */
export function enableBankingConfigFromEnv(env: EnableBankingEnv): EnableBankingConfig | undefined {
  if (!env.ENABLE_BANKING_APPLICATION_ID && !env.ENABLE_BANKING_PRIVATE_KEY_PEM) return undefined;
  const parsed = schema.parse(env);
  return {
    applicationId: parsed.ENABLE_BANKING_APPLICATION_ID,
    privateKeyPem: parsed.ENABLE_BANKING_PRIVATE_KEY_PEM,
  };
}
