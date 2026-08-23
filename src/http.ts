import { PublicError } from "./errors";

const MAX_UPSTREAM_BYTES = 1_000_000;

export async function readBoundedJson(response: Response): Promise<unknown> {
  if (response.body === null) return null;
  const text = await readBoundedText(
    response,
    MAX_UPSTREAM_BYTES,
    new PublicError("The provider response was unexpectedly large.", "upstream_too_large"),
  );

  try {
    return JSON.parse(text);
  } catch {
    throw new PublicError("The provider returned invalid JSON.", "invalid_upstream_response");
  }
}

export async function readBoundedText(
  message: Request | Response,
  maxBytes: number,
  tooLargeError: Error,
): Promise<string> {
  const declaredLength = message.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) throw tooLargeError;
  if (message.body === null) return "";

  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLargeError;
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}
