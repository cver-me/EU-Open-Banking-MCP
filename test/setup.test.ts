import { exportPKCS8, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import type { SessionStore } from "../src/session-store";
import { handleSetupRequest } from "../src/setup";

const SESSION_ID = "22222222-2222-4222-8222-222222222222";
let config: AppConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  config = {
    enableBanking: {
      applicationId: "00000000-0000-4000-8000-000000000000",
      privateKeyPem: await exportPKCS8(privateKey),
    },
  };
});

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
      config,
      sessions,
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
      config,
      sessions,
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
      config,
      sessions,
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
      config,
      sessions,
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
      config,
      sessions,
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
      config,
      sessions,
    );

    expect(response?.status).toBe(400);
    expect(await response?.text()).toContain("Invalid setup request origin");
  });
});
