// AES-256-GCM sealing for provider credentials stored in KV. The key lives only
// in a Worker secret; the associated data binds each ciphertext to its KV key so
// a sealed value cannot be moved to another record.

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export function decodeEncryptionKey(base64: string): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(base64.trim()), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("TOKEN_ENCRYPTION_KEY must be base64.");
  }
  if (bytes.byteLength !== KEY_BYTES) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  return bytes;
}

export class TokenCipher {
  private keyPromise: Promise<CryptoKey> | undefined;

  constructor(private readonly rawKey: Uint8Array<ArrayBuffer>) {}

  async seal(plaintext: string, associatedData: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encode(associatedData) },
      await this.key(),
      encode(plaintext),
    );
    return `${VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
  }

  async open(sealed: string, associatedData: string): Promise<string> {
    const [version, ivPart, ciphertextPart, ...rest] = sealed.split(".");
    if (version !== VERSION || ivPart === undefined || ciphertextPart === undefined || rest.length > 0) {
      throw new Error("Unsupported sealed value.");
    }
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlDecode(ivPart), additionalData: encode(associatedData) },
      await this.key(),
      base64UrlDecode(ciphertextPart),
    );
    return new TextDecoder().decode(plaintext);
  }

  private key(): Promise<CryptoKey> {
    this.keyPromise ??= crypto.subtle.importKey("raw", this.rawKey, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
    return this.keyPromise;
  }
}

function encode(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(value));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
