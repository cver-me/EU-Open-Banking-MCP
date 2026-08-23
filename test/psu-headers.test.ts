import { describe, expect, it } from "vitest";
import { enableBankingPsuHeadersFromRequest } from "../src/providers/enable-banking/psu-headers";

describe("Enable Banking PSU headers", () => {
  it("derives the documented online-user headers from the MCP request", () => {
    const request = new Request("https://finance.example/mcp", {
      headers: {
        "CF-Connecting-IP": "203.0.113.9",
        "User-Agent": "Codex MCP Client",
        Accept: "application/json, text/event-stream",
        "Accept-Language": "it-IT,it;q=0.9",
        Referer: "https://finance.example/",
      },
    });

    expect(enableBankingPsuHeadersFromRequest(request)).toEqual([
      ["Psu-Ip-Address", "203.0.113.9"],
      ["Psu-User-Agent", "Codex MCP Client"],
    ]);
  });

  it("does not create an online-user signal from content-negotiation headers alone", () => {
    const request = new Request("https://finance.example/mcp", {
      headers: { Accept: "application/json" },
    });

    expect(enableBankingPsuHeadersFromRequest(request)).toBeUndefined();
  });

  it("rejects a caller-controlled value that is not a single IP address", () => {
    const request = new Request("https://finance.example/mcp", {
      headers: {
        "CF-Connecting-IP": "203.0.113.9, 198.51.100.4",
        "User-Agent": "Codex MCP Client",
      },
    });

    expect(enableBankingPsuHeadersFromRequest(request)).toEqual([
      ["Psu-User-Agent", "Codex MCP Client"],
    ]);
  });
});
