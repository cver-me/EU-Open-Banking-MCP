export type EnableBankingPsuHeaders = ReadonlyArray<
  readonly [name: "Psu-Ip-Address" | "Psu-User-Agent", value: string]
>;

const MAX_IP_ADDRESS_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 512;

export function enableBankingPsuHeadersFromRequest(
  request: Request,
): EnableBankingPsuHeaders | undefined {
  const ipAddress = validIpAddress(request.headers.get("CF-Connecting-IP"));
  const userAgent = boundedHeader(request.headers.get("User-Agent"), MAX_USER_AGENT_LENGTH);

  // Enable Banking treats any PSU header as an online-user signal.
  if (ipAddress === undefined && userAgent === undefined) return undefined;

  return [
    ...(ipAddress === undefined ? [] : [["Psu-Ip-Address", ipAddress] as const]),
    ...(userAgent === undefined ? [] : [["Psu-User-Agent", userAgent] as const]),
  ];
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
