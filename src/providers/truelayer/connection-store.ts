import { z } from "zod";
import type { TokenCipher } from "../../lib/crypto";

// Each connection is its own KV entry so concurrent token refreshes for one bank
// never overwrite another connection's record.
const KEY_PREFIX = "truelayer-connection-v1:";
export const MAX_TRUELAYER_CONNECTIONS = 10;

const connectionRecordSchema = z.object({
  refreshToken: z.string().min(1).max(8_192),
  accessToken: z.string().min(1).max(16_384).optional(),
  /** Epoch milliseconds after which accessToken must not be used. */
  accessTokenExpiresAt: z.number().int().positive().optional(),
  providerId: z.string().max(200).optional(),
  providerName: z.string().max(200).optional(),
  consentExpiresAt: z.string().max(100).optional(),
  createdAt: z.iso.datetime({ offset: true }),
});

export type TrueLayerConnectionRecord = z.infer<typeof connectionRecordSchema>;

export interface TrueLayerConnection {
  id: string;
  record: TrueLayerConnectionRecord;
}

export interface TrueLayerConnectionStore {
  list(): Promise<TrueLayerConnection[]>;
  put(id: string, record: TrueLayerConnectionRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

export class KvTrueLayerConnectionStore implements TrueLayerConnectionStore {
  constructor(
    private readonly kv: KVNamespace,
    private readonly cipher: TokenCipher,
  ) {}

  async list(): Promise<TrueLayerConnection[]> {
    const listed = await this.kv.list({ prefix: KEY_PREFIX, limit: MAX_TRUELAYER_CONNECTIONS + 1 });
    if (listed.keys.length > MAX_TRUELAYER_CONNECTIONS) {
      throw new Error("Too many stored TrueLayer connections.");
    }
    const connections = await Promise.all(
      listed.keys.map(async ({ name }) => {
        const id = z.uuid().parse(name.slice(KEY_PREFIX.length));
        const sealed = await this.kv.get(name);
        if (sealed === null) return undefined;
        const record = connectionRecordSchema.parse(
          JSON.parse(await this.cipher.open(sealed, name)),
        );
        return { id, record };
      }),
    );
    return connections
      .filter((connection): connection is TrueLayerConnection => connection !== undefined)
      .sort((left, right) => left.record.createdAt.localeCompare(right.record.createdAt));
  }

  async put(id: string, record: TrueLayerConnectionRecord): Promise<void> {
    const key = `${KEY_PREFIX}${z.uuid().parse(id)}`;
    const plaintext = JSON.stringify(connectionRecordSchema.parse(record));
    await this.kv.put(key, await this.cipher.seal(plaintext, key));
  }

  async remove(id: string): Promise<void> {
    await this.kv.delete(`${KEY_PREFIX}${z.uuid().parse(id)}`);
  }
}
