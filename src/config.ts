import { z } from "zod";

const UUID = z.uuid();

const envSchema = z.object({
  ENABLE_BANKING_APPLICATION_ID: UUID,
  ENABLE_BANKING_PRIVATE_KEY_PEM: z.string().includes("PRIVATE KEY"),
});

export interface AppConfig {
  enableBanking: {
    applicationId: string;
    privateKeyPem: string;
  };
}

export function loadConfig(env: Env): AppConfig {
  const parsed = envSchema.parse(env);

  return {
    enableBanking: {
      applicationId: parsed.ENABLE_BANKING_APPLICATION_ID,
      privateKeyPem: parsed.ENABLE_BANKING_PRIVATE_KEY_PEM,
    },
  };
}
