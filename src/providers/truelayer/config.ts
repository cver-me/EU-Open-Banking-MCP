import { z } from "zod";

export interface TrueLayerConfig {
  clientId: string;
  clientSecret: string;
  sandbox: boolean;
}

export const TRUELAYER_SECRETS = ["TRUELAYER_CLIENT_ID", "TRUELAYER_CLIENT_SECRET"] as const;

const schema = z.object({
  TRUELAYER_CLIENT_ID: z.string().trim().min(1).max(200),
  TRUELAYER_CLIENT_SECRET: z.string().trim().min(1).max(500),
});

/** Undefined when TrueLayer is not configured; throws on a partial or invalid configuration. */
export function trueLayerConfigFromEnv(env: Readonly<Record<string, unknown>>): TrueLayerConfig | undefined {
  if (TRUELAYER_SECRETS.every((name) => !env[name])) return undefined;
  const parsed = schema.parse(env);
  return {
    clientId: parsed.TRUELAYER_CLIENT_ID,
    clientSecret: parsed.TRUELAYER_CLIENT_SECRET,
    // TrueLayer prefixes sandbox client IDs with "sandbox-".
    sandbox: parsed.TRUELAYER_CLIENT_ID.startsWith("sandbox-"),
  };
}
