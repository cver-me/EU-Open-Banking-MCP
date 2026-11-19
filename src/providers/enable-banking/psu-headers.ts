import type { PsuContext } from "../../lib/psu";

export type EnableBankingPsuHeaders = ReadonlyArray<
  readonly [name: "Psu-Ip-Address" | "Psu-User-Agent", value: string]
>;

/** Enable Banking treats any PSU header as an online-user signal, so send none without context. */
export function enableBankingPsuHeaders(psu: PsuContext | undefined): EnableBankingPsuHeaders | undefined {
  if (psu?.ipAddress === undefined && psu?.userAgent === undefined) return undefined;
  return [
    ...(psu.ipAddress === undefined ? [] : [["Psu-Ip-Address", psu.ipAddress] as const]),
    ...(psu.userAgent === undefined ? [] : [["Psu-User-Agent", psu.userAgent] as const]),
  ];
}
