import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { KvSessionStore } from "../src/session-store";

const KEY = "enable-banking-session-ids-v1";
const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

beforeEach(async () => {
  await env.SESSION_STORE.delete(KEY);
});

describe("KvSessionStore", () => {
  it("stores only unique session IDs and removes them", async () => {
    const store = new KvSessionStore(env.SESSION_STORE);
    await store.add(FIRST);
    await store.add(FIRST);
    await store.add(SECOND);
    expect(await store.list()).toEqual([FIRST, SECOND]);

    await store.remove(FIRST);
    expect(await store.list()).toEqual([SECOND]);
  });

  it("rejects malformed stored configuration", async () => {
    await env.SESSION_STORE.put(KEY, JSON.stringify(["not-a-uuid"]));
    await expect(new KvSessionStore(env.SESSION_STORE).list()).rejects.toThrow();
  });
});
