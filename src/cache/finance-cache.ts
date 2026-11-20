import { Agent, getAgentByName } from "agents";

/**
 * Bank reads shared across MCP requests, in memory only.
 *
 * One instance ("owner") serves every request, so the tool calls of one agent turn read
 * each account from the bank once. Concurrent requests for the same key wait for the
 * first one instead of calling the bank again. Nothing here is written to storage: the
 * data is gone when the object leaves memory (Cloudflare may do so about 10 seconds after the last call)
 * or when an entry expires, whichever comes first.
 *
 * The Worker still makes every bank call, with its own provider settings: this object
 * only holds results. It has no public route; only the Worker's binding reaches it.
 */
export class FinanceCache extends Agent<Env> {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly loading = new Map<string, Loading>();

  /**
   * A fresh entry, or a lease to load it. With `from`, an entry only counts when it
   * covers that date or earlier. While another request holds the lease, this waits for
   * it (at most LEASE_TIMEOUT_MS) and then looks again.
   */
  async claim(key: string, requirement: CoverageRequirement = {}): Promise<ClaimResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const entry = this.fresh(key, requirement);
      if (entry !== undefined) return { hit: true, value: entry.value, storedAt: entry.storedAt };
      const current = this.loading.get(key);
      if (current === undefined || Date.now() - current.since > LEASE_TIMEOUT_MS) break;
      await waitAtMost(current.done, LEASE_TIMEOUT_MS);
    }
    const lease = crypto.randomUUID();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    this.loading.set(key, { lease, since: Date.now(), done, finish });
    return { hit: false, lease };
  }

  /** Stores what the lease holder loaded and wakes requests waiting for it. */
  async fill(key: string, lease: string, value: unknown, ttlMs: number, coverage: Coverage = {}): Promise<void> {
    const now = Date.now();
    this.entries.set(key, { value, storedAt: now, expiresAt: now + Math.min(ttlMs, MAX_TTL_MS), ...coverage });
    this.evictOverflow();
    this.endLease(key, lease);
  }

  /** Gives up a lease after a failed load; a waiting request then loads it itself. */
  async release(key: string, lease: string): Promise<void> {
    this.endLease(key, lease);
  }

  /** Forgets everything, for example after a bank connection was added or removed. */
  async clear(): Promise<void> {
    this.entries.clear();
    for (const loading of this.loading.values()) loading.finish();
    this.loading.clear();
  }

  private fresh(key: string, requirement: CoverageRequirement): CacheEntry | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    if (requirement.from !== undefined && (entry.from === undefined || entry.from > requirement.from)) return undefined;
    if (requirement.to !== undefined && (entry.to === undefined || entry.to < requirement.to)) return undefined;
    return entry;
  }

  private endLease(key: string, lease: string): void {
    const current = this.loading.get(key);
    if (current?.lease !== lease) return;
    this.loading.delete(key);
    current.finish();
  }

  /** Bounds memory: the oldest entries go first. */
  private evictOverflow(): void {
    while (this.entries.size > MAX_ENTRIES) {
      let oldestKey: string | undefined;
      let oldest = Infinity;
      for (const [key, entry] of this.entries) {
        if (entry.storedAt < oldest) {
          oldest = entry.storedAt;
          oldestKey = key;
        }
      }
      this.entries.delete(oldestKey!);
    }
  }
}

/** Dates an entry covers, for transaction ranges. */
export interface Coverage {
  from?: string;
  to?: string;
}

export interface CoverageRequirement {
  from?: string;
  to?: string;
}

export type ClaimResult =
  | { hit: true; value: unknown; storedAt: number }
  | { hit: false; lease: string };

interface CacheEntry extends Coverage {
  value: unknown;
  storedAt: number;
  expiresAt: number;
}

interface Loading {
  lease: string;
  since: number;
  done: Promise<void>;
  finish: () => void;
}

// A bank read longer than this is treated as abandoned, and a waiting request loads itself.
const LEASE_TIMEOUT_MS = 30_000;
const MAX_TTL_MS = 10 * 60_000;
// Accounts, balances and a transaction range per account: well under this for a personal setup.
const MAX_ENTRIES = 200;

/** Waits for a promise or a timeout, whichever comes first, and leaves no timer behind. */
async function waitAtMost(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The deployment's one cache. Its unit of coordination is the owner's set of bank
 * connections: every request reads the same connections, so one object is the right
 * size, not a global bottleneck. EU jurisdiction keeps it, and the financial data it
 * holds in memory, in EU data centres.
 */
export const FINANCE_CACHE_NAME = "owner";

export async function openFinanceCache(namespace: DurableObjectNamespace<FinanceCache>): Promise<DurableObjectStub<FinanceCache>> {
  try {
    return await getAgentByName(namespace, FINANCE_CACHE_NAME, { jurisdiction: "eu" });
  } catch (error) {
    // Only the local runtime (cf dev, tests) lacks jurisdictions; anything else must fail.
    if (!(error instanceof Error) || !error.message.includes(LOCAL_RUNTIME_WITHOUT_JURISDICTIONS)) throw error;
    return getAgentByName(namespace, FINANCE_CACHE_NAME);
  }
}

const LOCAL_RUNTIME_WITHOUT_JURISDICTIONS = "Jurisdiction restrictions are not implemented in workerd";
