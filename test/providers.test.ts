import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { Aggregate, type NamedReader } from "../src/aggregate";
import { PublicError } from "../src/errors";
import { configuredProviders, type ProviderEnv } from "../src/providers/registry";
import type { FinanceReader } from "../src/providers/types";

const KEY_BASE64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const EU = {
  ENABLE_BANKING_APPLICATION_ID: "00000000-0000-4000-8000-000000000000",
  ENABLE_BANKING_PRIVATE_KEY_PEM: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
};
const UK = {
  TRUELAYER_CLIENT_ID: "personalfinance-abc123",
  TRUELAYER_CLIENT_SECRET: "secret",
  TOKEN_ENCRYPTION_KEY: KEY_BASE64,
};

function providerNames(vars: Partial<ProviderEnv>) {
  return configuredProviders({ SESSION_STORE: env.SESSION_STORE, ...vars }).map(({ name }) => name);
}

describe("configuredProviders", () => {
  it.each([
    ["none", {}, []],
    ["EU only", EU, ["enable_banking"]],
    ["UK only", UK, ["truelayer"]],
    ["both", { ...EU, ...UK }, ["enable_banking", "truelayer"]],
    // Empty strings are how an unset secret can appear in local .dev.vars files.
    ["empty values", { ENABLE_BANKING_APPLICATION_ID: "", TRUELAYER_CLIENT_ID: "" }, []],
  ])("enables providers for %s", (_label, vars, expected) => {
    expect(providerNames(vars)).toEqual(expected);
  });

  it.each([
    ["Enable Banking", { ENABLE_BANKING_APPLICATION_ID: EU.ENABLE_BANKING_APPLICATION_ID }],
    ["TrueLayer", { TRUELAYER_CLIENT_ID: "abc" }],
    ["TrueLayer with a short key", { ...UK, TOKEN_ENCRYPTION_KEY: btoa("short") }],
  ])("rejects a partial or invalid %s configuration", (_label, vars) => {
    expect(() => providerNames(vars)).toThrow();
  });

  it("routes account IDs to the provider that issued them", () => {
    const [enableBanking, trueLayer] = configuredProviders({ SESSION_STORE: env.SESSION_STORE, ...EU, ...UK });
    expect(enableBanking!.ownsAccountId("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(enableBanking!.ownsAccountId("tl-a-abc")).toBe(false);
    expect(trueLayer!.ownsAccountId("tl-a-abc")).toBe(true);
    expect(trueLayer!.ownsAccountId("11111111-1111-4111-8111-111111111111")).toBe(false);
  });
});

describe("Aggregate", () => {
  const reader = (overrides: Partial<FinanceReader> = {}): FinanceReader => ({
    listAccounts: vi.fn(async () => []),
    getBalances: vi.fn(async () => ({ balances: [], errors: [] })),
    listTransactions: vi.fn(async () => ({ transactions: [] })),
    listAccountIds: vi.fn(async () => []),
    ...overrides,
  });
  const eu = (overrides?: Partial<FinanceReader>): NamedReader => ({
    name: "enable_banking", ownsAccountId: (id) => !id.startsWith("tl-"), reader: reader(overrides),
  });
  const uk = (overrides?: Partial<FinanceReader>): NamedReader => ({
    name: "truelayer", ownsAccountId: (id) => id.startsWith("tl-"), reader: reader(overrides),
  });
  const setupRequired = () => Promise.reject(new PublicError("setup", "setup_required"));
  const timeout = (label: string) => () => Promise.reject(new PublicError(`${label} timed out.`, "provider_timeout"));

  it("requires setup when no provider is configured", async () => {
    await expect(new Aggregate([]).listAccountIds()).rejects.toMatchObject({ code: "setup_required" });
    expect(() => new Aggregate([]).listTransactions("tl-a-x", {})).toThrow(expect.objectContaining({ code: "unknown_account" }));
  });

  it("skips a provider with no connected banks", async () => {
    const aggregate = new Aggregate([eu({ listAccountIds: setupRequired }), uk({ listAccountIds: async () => ["tl-a-1"] })]);
    await expect(aggregate.listAccountIds()).resolves.toEqual({ value: ["tl-a-1"], providerErrors: [] });
  });

  it("requires setup only when no provider has banks", async () => {
    const aggregate = new Aggregate([eu({ listAccountIds: setupRequired }), uk({ listAccountIds: setupRequired })]);
    await expect(aggregate.listAccountIds()).rejects.toMatchObject({ code: "setup_required" });
  });

  it("keeps one provider's accounts when the other fails", async () => {
    const aggregate = new Aggregate([eu({ listAccountIds: timeout("Enable Banking") }), uk({ listAccountIds: async () => ["tl-a-1"] })]);
    await expect(aggregate.listAccountIds()).resolves.toEqual({
      value: ["tl-a-1"],
      providerErrors: [{ provider: "enable_banking", code: "provider_timeout", message: "Enable Banking timed out." }],
    });
  });

  it("surfaces the real error when every provider fails, rather than setup_required", async () => {
    const aggregate = new Aggregate([eu({ listAccountIds: setupRequired }), uk({ listAccountIds: timeout("TrueLayer") })]);
    await expect(aggregate.listAccountIds()).rejects.toMatchObject({ code: "provider_timeout" });
  });

  it("routes single-account reads to the owning provider", async () => {
    const euProvider = eu();
    const ukProvider = uk();
    const aggregate = new Aggregate([euProvider, ukProvider]);
    await aggregate.listTransactions("tl-a-1", {});
    await aggregate.getBalances("11111111-1111-4111-8111-111111111111");
    expect(ukProvider.reader.listTransactions).toHaveBeenCalledWith("tl-a-1", {});
    expect(euProvider.reader.getBalances).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(euProvider.reader.listTransactions).not.toHaveBeenCalled();
  });

  it("rejects an account ID no configured provider owns", () => {
    const aggregate = new Aggregate([eu()]);
    expect(() => aggregate.listTransactions("tl-a-1", {})).toThrow(expect.objectContaining({ code: "unknown_account" }));
  });
});
