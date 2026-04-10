const MIN_UTC_OFFSET_MINUTES = -14 * 60;
const MAX_UTC_OFFSET_MINUTES = 14 * 60;

function createUtcDateNoon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

export function normalizeUtcOffsetMinutes(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  if (rounded < MIN_UTC_OFFSET_MINUTES || rounded > MAX_UTC_OFFSET_MINUTES) return null;
  return rounded;
}

export function parseUtcOffsetMinutes(value: unknown): number | null {
  if (typeof value === "number") {
    return normalizeUtcOffsetMinutes(value);
  }

  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(?:z|utc|gmt)$/i.test(trimmed)) return 0;

  const compact = trimmed.replace(/\s+/g, "");
  const prefixed = /^(?:utc|gmt)([+-].+)$/i.exec(compact);
  if (prefixed) {
    return parseUtcOffsetMinutes(prefixed[1]);
  }

  const signedHours = /^([+-])(\d{1,2})$/.exec(compact);
  if (signedHours) {
    const sign = signedHours[1] === "-" ? -1 : 1;
    const hours = Number(signedHours[2]);
    return normalizeUtcOffsetMinutes(sign * hours * 60);
  }

  const signedHoursMinutes = /^([+-])(\d{1,2}):?(\d{2})$/.exec(compact);
  if (signedHoursMinutes) {
    const sign = signedHoursMinutes[1] === "-" ? -1 : 1;
    const hours = Number(signedHoursMinutes[2]);
    const minutes = Number(signedHoursMinutes[3]);
    if (minutes >= 60) return null;
    return normalizeUtcOffsetMinutes(sign * (hours * 60 + minutes));
  }

  return null;
}

export function extractExplicitUtcOffsetMinutes(configMap: Map<string, string>): number | null {
  for (const [key, rawValue] of configMap.entries()) {
    const normalizedKey = key.replace(/[^a-z]/gi, "").toLowerCase();
    if (
      normalizedKey === "timezoneoffset" ||
      normalizedKey === "utcoffset" ||
      normalizedKey === "gmtoffset" ||
      normalizedKey === "timezone"
    ) {
      const parsed = parseUtcOffsetMinutes(rawValue);
      if (parsed !== null) return parsed;
    }
  }

  return null;
}

export function createCalendarDateNoonAtUtcOffset(date: Date, utcOffsetMinutes: number | null): Date | null {
  if (utcOffsetMinutes === null) return null;
  const normalized = normalizeUtcOffsetMinutes(utcOffsetMinutes);
  if (normalized === null) return null;
  const shifted = new Date(date.getTime() + normalized * 60 * 1000);
  return createUtcDateNoon(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}
