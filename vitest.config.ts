import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const TEST_APPLICATION_ID = "00000000-0000-4000-8000-000000000000";
const TEST_PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\nnot-used-before-provider-tests\n-----END PRIVATE KEY-----";

process.env.ENABLE_BANKING_APPLICATION_ID = TEST_APPLICATION_ID;
process.env.ENABLE_BANKING_PRIVATE_KEY_PEM = TEST_PRIVATE_KEY;

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Reads the Worker settings from cloudflare.config.ts.
      config: true,
      miniflare: {
        bindings: {
          ENABLE_BANKING_APPLICATION_ID: TEST_APPLICATION_ID,
          ENABLE_BANKING_PRIVATE_KEY_PEM: TEST_PRIVATE_KEY,
        },
      },
    }),
  ],
  test: {
    restoreMocks: true,
  },
});
