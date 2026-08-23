import { z } from "zod";

const KEY = "enable-banking-session-ids-v1";
const sessionIdsSchema = z.array(z.uuid()).max(20);

export interface SessionStore {
  list(): Promise<string[]>;
  add(sessionId: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
}

export class KvSessionStore implements SessionStore {
  constructor(private readonly kv: KVNamespace) {}

  async list(): Promise<string[]> {
    const value = await this.kv.get(KEY);
    if (value === null) return [];
    return sessionIdsSchema.parse(JSON.parse(value));
  }

  async add(sessionId: string): Promise<void> {
    const parsedSessionId = z.uuid().parse(sessionId);
    const current = await this.list();
    if (current.includes(parsedSessionId)) return;
    await this.kv.put(KEY, JSON.stringify(sessionIdsSchema.parse([...current, parsedSessionId])));
  }

  async remove(sessionId: string): Promise<void> {
    const parsedSessionId = z.uuid().parse(sessionId);
    const current = await this.list();
    await this.kv.put(KEY, JSON.stringify(current.filter((id) => id !== parsedSessionId)));
  }
}
