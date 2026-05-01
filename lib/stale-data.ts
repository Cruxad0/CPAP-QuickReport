export const STALE_DATA_NOTICE_DAYS = 7;
export const STALE_DATA_WARNING_DAYS = 30;
export const STALE_DATA_CRITICAL_DAYS = 90;

export type StaleDataSeverity = "notice" | "warning" | "critical";

function parseIsoDateParts(isoDate: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  return { year, month, day };
}

export function daysSinceIsoDate(isoDate: string, now = new Date()): number | null {
  const parsed = parseIsoDateParts(isoDate);
  if (!parsed) return null;

  const latestDateMs = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  const todayMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.floor((todayMs - latestDateMs) / 86_400_000);
  return Number.isFinite(days) ? days : null;
}

export function staleDataSeverity(daysOld: number | null): StaleDataSeverity | null {
  if (daysOld === null) return null;
  if (daysOld > STALE_DATA_CRITICAL_DAYS) return "critical";
  if (daysOld > STALE_DATA_WARNING_DAYS) return "warning";
  if (daysOld > STALE_DATA_NOTICE_DAYS) return "notice";
  return null;
}

export function staleDataAgeClassName(severity: StaleDataSeverity | null): string | undefined {
  return severity ? `stale-data-age stale-data-age-${severity}` : undefined;
}
