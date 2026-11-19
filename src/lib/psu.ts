// Request-scoped signals that the account owner is actively using the MCP client.
// Providers forward them so banks treat reads as user-initiated (higher rate limits).
// Values are bounded and never stored or logged.

const MAX_IP_ADDRESS_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 512;

export interface PsuContext {
  ipAddress?: string;
  userAgent?: string;
}

export function psuContextFromRequest(request: Request): PsuContext {
  const ipAddress = validIpAddress(request.headers.get("CF-Connecting-IP"));
  const userAgent = boundedHeader(request.headers.get("User-Agent"), MAX_USER_AGENT_LENGTH);
  return {
    ...(ipAddress === undefined ? {} : { ipAddress }),
    ...(userAgent === undefined ? {} : { userAgent }),
  };
}

function validIpAddress(value: string | null): string | undefined {
  const bounded = boundedHeader(value, MAX_IP_ADDRESS_LENGTH);
  if (bounded === undefined || !/^[0-9A-Fa-f:.]+$/.test(bounded)) return undefined;
  return bounded;
}

function boundedHeader(value: string | null | undefined, maxLength: number): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0 || trimmed.length > maxLength) return undefined;
  return trimmed;
}
