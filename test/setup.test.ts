import { exportPKCS8, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EnableBankingClient } from "../src/providers/enable-banking/client";
import type { EnableBankingConfig } from "../src/providers/enable-banking/config";
import { EnableBankingSetup } from "../src/providers/enable-banking/setup";
import { TrueLayerClient } from "../src/providers/truelayer/client";
import type { TrueLayerConfig } from "../src/providers/truelayer/config";
import { TrueLayerSetup } from "../src/providers/truelayer/setup";
import type { BankProvider } from "../src/providers/types";
import type {
  TrueLayerConnectionRecord,
  TrueLayerConnectionStore,
} from "../src/providers/truelayer/connection-store";
import type { SessionStore } from "../src/providers/enable-banking/session-store";
import { handleSetupRequest } from "../src/setup";

const SESSION_ID = "22222222-2222-4222-8222-222222222222";
let config: EnableBankingConfig;
const trueLayerConfig: TrueLayerConfig = {
  clientId: "personalfinance-abc123",
  clientSecret: "test-client-secret",
  sandbox: false,
};

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  config = {
    applicationId: "00000000-0000-4000-8000-000000000000",
    privateKeyPem: await exportPKCS8(privateKey),
  };
});

// Real setup adapters over injected stores; reads are not exercised here.
function enableBanking(sessions: SessionStore): BankProvider {
  const client = new EnableBankingClient(config, sessions);
  return { name: "enable_banking", label: "EU banks (Enable Banking)", ownsAccountId: () => false, reader: () => client, setup: new EnableBankingSetup(client) };
}

function trueLayer(store: TrueLayerConnectionStore): BankProvider {
  const client = new TrueLayerClient(trueLayerConfig, store);
  return { name: "truelayer", label: "UK banks (TrueLayer)", ownsAccountId: () => false, reader: () => client, setup: new TrueLayerSetup(trueLayerConfig, client) };
}

describe("protected setup flow", () => {
  it("lists banks returned for the selected country and account type", async () => {
    const sessions: SessionStore = {
      list: vi.fn(async () => []),
      add: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        aspsps: [
          { name: "Second Bank", country: "IT", maximum_consent_validity: 7_776_000 },
          { name: "First Bank", country: "IT", maximum_consent_validity: 7_776_000 },
        ],
      }),
    );

    const response = await handleSetupRequest(
      new Request("https://finance.example/setup?country=it&psuType=business"),
      [enableBanking(sessions)],
    );

    expect(response?.status).toBe(200);
    const body = await response?.text();
    expect(body).toContain('<option value="First Bank">First Bank</option>');
    expect(body?.indexOf("First Bank")).toBeLessThan(body?.indexOf("Second Bank") ?? 0);
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
      country: "IT",
      psu_type: "business",
      service: "AIS",
    });
  });

  it("starts authorization, validates state, and saves only the returned session ID", async () => {
    const sessions: SessionStore = {
      list: vi.fn(async () => []),
      add: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    let authorizationState = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/aspsps") {
        return Response.json({
          aspsps: [
            { name: "Example Bank", country: "IT", maximum_consent_validity: 7_776_000 },
          ],
        });
      }
      if (url.pathname === "/auth") {
        const body = JSON.parse(String(init?.body)) as { state: string };
        authorizationState = body.state;
        return Response.json({
          url: "https://auth.enablebanking.com/ais/start?sessionid=example",
          authorization_id: "33333333-3333-4333-8333-333333333333",
        });
      }
      expect(url.pathname).toBe("/sessions");
      return Response.json({
        session_id: SESSION_ID,
        aspsp: { name: "Example Bank", country: "IT" },
        psu_type: "personal",
      });
    });

    const connectResponse = await handleSetupRequest(
      new Request("https://finance.example/setup/connect", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://finance.example",
        },
        body: "institution=Example+Bank&country=it&psuType=personal",
      }),
      [enableBanking(sessions)],
    );
    expect(connectResponse?.status).toBe(200);
    expect(await connectResponse?.text()).toContain(
      'href="https://auth.enablebanking.com/ais/start?sessionid=example"',
    );
    expect(connectResponse?.headers.get("Location")).toBeNull();
    const cookie = connectResponse?.headers.get("Set-Cookie")?.split(";", 1)[0];
    expect(cookie).toContain(authorizationState);

    const callbackResponse = await handleSetupRequest(
      new Request(
        `https://finance.example/callback?code=one-time-code&state=${authorizationState}`,
        { headers: { Cookie: cookie ?? "" } },
      ),
      [enableBanking(sessions)],
    );
    expect(callbackResponse?.status).toBe(303);
    expect(callbackResponse?.headers.get("Location")).toBe("/setup?connected=1");
    expect(sessions.add).toHaveBeenCalledWith(SESSION_ID);
  });

  it("rejects setup posts from another origin", async () => {
    const sessions: SessionStore = {
      list: vi.fn(async () => []),
      add: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const response = await handleSetupRequest(
      new Request("https://finance.example/setup/connect", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://attacker.example",
          "Sec-Fetch-Site": "same-origin",
        },
        body: "institution=Example+Bank&country=IT&psuType=personal",
      }),
      [enableBanking(sessions)],
    );
    expect(response?.status).toBe(400);
    expect(await response?.text()).toContain("Invalid setup request origin");
  });

  it("accepts an opaque origin only when Fetch Metadata says same-origin", async () => {
    const sessions: SessionStore = {
      list: vi.fn(async () => []),
      add: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/aspsps") {
        return Response.json({
          aspsps: [
            { name: "Example Bank", country: "IT", maximum_consent_validity: 7_776_000 },
          ],
        });
      }
      expect(url.pathname).toBe("/auth");
      return Response.json({
        url: "https://auth.enablebanking.com/ais/start?sessionid=example",
        authorization_id: "33333333-3333-4333-8333-333333333333",
      });
    });

    const response = await handleSetupRequest(
      new Request("https://finance.example/setup/connect", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "null",
          "Sec-Fetch-Site": "same-origin",
        },
        body: "institution=Example+Bank&country=IT&psuType=personal",
      }),
      [enableBanking(sessions)],
    );

    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain(
      'href="https://auth.enablebanking.com/ais/start?sessionid=example"',
    );
  });

  it.each([
    { label: "cross-site Fetch Metadata", headers: { Origin: "null", "Sec-Fetch-Site": "cross-site" } },
    { label: "missing Fetch Metadata", headers: {} },
  ])("rejects an opaque or missing origin with $label", async ({ headers }) => {
    const sessions: SessionStore = {
      list: vi.fn(async () => []),
      add: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const response = await handleSetupRequest(
      new Request("https://finance.example/setup/connect", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body: "institution=Example+Bank&country=IT&psuType=personal",
      }),
      [enableBanking(sessions)],
    );

    expect(response?.status).toBe(400);
    expect(await response?.text()).toContain("Invalid setup request origin");
  });
});

describe("TrueLayer setup flow", () => {
  const emptySessions = (): SessionStore => ({
    list: vi.fn(async () => []),
    add: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  });
  const memoryStore = (): TrueLayerConnectionStore & { records: Map<string, TrueLayerConnectionRecord> } => {
    const records = new Map<string, TrueLayerConnectionRecord>();
    return {
      records,
      list: async () => [...records].map(([id, record]) => ({ id, record })),
      put: async (id, record) => void records.set(id, record),
      remove: async (id) => void records.delete(id),
    };
  };

  it("starts a PKCE authorization and completes it only with matching state", async () => {
    const store = memoryStore();
    const connect = await handleSetupRequest(
      new Request("https://finance.example/setup/truelayer/connect", {
        method: "POST",
        headers: { Origin: "https://finance.example" },
      }),
      [enableBanking(emptySessions()), trueLayer(store)],
    );
    expect(connect?.status).toBe(200);
    const cookie = connect?.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("Path=/callback/truelayer");
    expect(cookie).toContain("HttpOnly");
    const [state, verifier] = decodeURIComponent(cookie.split(";")[0]!.split("=")[1]!).split(".");
    const body = await connect!.text();
    const authorizationUrl = new URL(body.match(/href="([^"]+)"/)![1]!.replaceAll("&amp;", "&"));
    expect(authorizationUrl.searchParams.get("state")).toBe(state);
    const expectedChallenge = btoa(String.fromCharCode(...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    expect(authorizationUrl.searchParams.get("code_challenge")).toBe(expectedChallenge);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      new URL(String(input)).pathname === "/connect/token"
        ? Response.json({ access_token: "access", expires_in: 3600, refresh_token: "refresh" })
        : Response.json({ results: [{ provider: { display_name: "Monzo" } }] }));

    const mismatched = await handleSetupRequest(
      new Request(`https://finance.example/callback/truelayer?code=abc&state=${crypto.randomUUID()}`, {
        headers: { Cookie: cookie.split(";")[0]! },
      }),
      [enableBanking(emptySessions()), trueLayer(store)],
    );
    expect(mismatched?.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const callback = await handleSetupRequest(
      new Request(`https://finance.example/callback/truelayer?code=abc&state=${state}`, {
        headers: { Cookie: cookie.split(";")[0]! },
      }),
      [enableBanking(emptySessions()), trueLayer(store)],
    );
    expect(callback?.status).toBe(303);
    expect(callback?.headers.get("Location")).toBe("/setup?connected=1");
    expect([...store.records.values()][0]).toMatchObject({ refreshToken: "refresh", providerName: "Monzo" });
  });

  it.each([
    { label: "same bank", newProvider: "ob-starling", oldKept: false, location: "/setup?renewed=1" },
    { label: "different bank", newProvider: "ob-monzo", oldKept: true, location: "/setup?connected=1" },
  ])("reconnecting the $label handles the old connection", async ({ newProvider, oldKept, location }) => {
    const OLD = "99999999-9999-4999-8999-999999999999";
    const store = memoryStore();
    store.records.set(OLD, {
      refreshToken: "old-refresh", accessToken: "old-access", accessTokenExpiresAt: Date.now() + 3_600_000,
      providerId: "ob-starling", providerName: "Starling", createdAt: "2026-08-21T10:00:00.000Z",
    });
    const connect = await handleSetupRequest(
      new Request("https://finance.example/setup/truelayer/connect", {
        method: "POST",
        headers: { Origin: "https://finance.example", "Content-Type": "application/x-www-form-urlencoded" },
        body: `replaceConnectionId=${OLD}`,
      }),
      [enableBanking(emptySessions()), trueLayer(store)],
    );
    const cookie = connect!.headers.get("Set-Cookie")!.split(";")[0]!;
    const [state] = decodeURIComponent(cookie.split("=")[1]!).split(".");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/connect/token") return Response.json({ access_token: "new-access", expires_in: 3600, refresh_token: "new-refresh" });
      if (path === "/data/v1/me") return Response.json({ results: [{ provider: { provider_id: newProvider, display_name: "Bank" } }] });
      if (path === "/api/delete") return new Response(null, { status: 200 });
      throw new Error(`Unexpected ${path}`);
    });

    const callback = await handleSetupRequest(
      new Request(`https://finance.example/callback/truelayer?code=abc&state=${state}`, { headers: { Cookie: cookie } }),
      [enableBanking(emptySessions()), trueLayer(store)],
    );

    expect(callback?.headers.get("Location")).toBe(location);
    expect(store.records.has(OLD)).toBe(oldKept);
    expect(store.records.size).toBe(oldKept ? 2 : 1);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/api/delete"))).toBe(!oldKept);
  });

  it("warns about consent that is about to expire or has expired", async () => {
    const store = memoryStore();
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    store.records.set("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
      refreshToken: "r", providerName: "Starling", createdAt: "2026-08-21T10:00:00.000Z", consentExpiresAt: soon,
    });
    store.records.set("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
      refreshToken: "r", providerName: "Monzo", createdAt: "2026-05-01T10:00:00.000Z", consentExpiresAt: "2026-07-30T10:00:00Z",
    });
    const response = await handleSetupRequest(
      new Request("https://finance.example/setup?country="), [enableBanking(emptySessions()), trueLayer(store)],
    );
    const body = await response!.text();
    expect(body).toMatch(/Starling — connected 2026-08-21 — consent expires in [45] day\(s\): reconnect soon/);
    expect(body).toContain("Monzo — connected 2026-05-01 — consent EXPIRED: reconnect to resume access");
    expect(body.match(/name="replaceConnectionId"/g)).toHaveLength(2);
  });

  it("leaves TrueLayer routes unhandled when TrueLayer is not configured", async () => {
    const response = await handleSetupRequest(
      new Request("https://finance.example/setup/truelayer/connect", {
        method: "POST",
        headers: { Origin: "https://finance.example" },
      }),
      [enableBanking(emptySessions())],
    );
    expect(response).toBeUndefined();
  });
});

describe("setup page resilience", () => {
  it("still renders when the Enable Banking bank list fails", async () => {
    const sessions: SessionStore = {
      list: vi.fn(async () => []),
      add: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "boom" }, { status: 500 }));

    const response = await handleSetupRequest(
      new Request("https://finance.example/setup?country=GB&psuType=personal"),
      [enableBanking(sessions)],
    );

    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain("could not load the bank list");
  });
});
