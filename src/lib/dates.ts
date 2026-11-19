// ISO calendar-date arithmetic (YYYY-MM-DD), in UTC so results never depend on the runtime's zone.

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function differenceInDays(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000;
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function earlierDate(first: string, second: string): string {
  return first < second ? first : second;
}

export function laterDate(first: string, second: string): string {
  return first > second ? first : second;
}
