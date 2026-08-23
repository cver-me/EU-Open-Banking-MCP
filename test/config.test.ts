import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const validEnv = {
  ENABLE_BANKING_APPLICATION_ID: "00000000-0000-4000-8000-000000000000",
  ENABLE_BANKING_PRIVATE_KEY_PEM:
    "-----BEGIN PRIVATE KEY-----\nnot-a-real-test-key\n-----END PRIVATE KEY-----",
} as Env;

describe("loadConfig", () => {
  it("loads only Enable Banking credentials", () => {
    expect(loadConfig(validEnv)).toEqual({
      enableBanking: {
        applicationId: "00000000-0000-4000-8000-000000000000",
        privateKeyPem:
          "-----BEGIN PRIVATE KEY-----\nnot-a-real-test-key\n-----END PRIVATE KEY-----",
      },
    });
  });

  it("rejects an invalid application ID", () => {
    expect(() =>
      loadConfig({ ...validEnv, ENABLE_BANKING_APPLICATION_ID: "not-a-uuid" }),
    ).toThrow();
  });
});
