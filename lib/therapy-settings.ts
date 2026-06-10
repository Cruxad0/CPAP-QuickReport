export interface TherapySettingsSnapshotInput {
  mode?: string | null;
  pressure?: string | number | null;
  pressureMin?: string | number | null;
  pressureMax?: string | number | null;
  epap?: string | number | null;
  ipap?: string | number | null;
  // Accepted for loader compatibility, but intentionally ignored by the
  // report-window setting guard. Availability should only track pressure changes.
  respiratoryRate?: string | number | null;
  tidalVolume?: string | number | null;
  pressureRelief?: string | number | null;
}

export interface TherapySettingsSnapshot {
  signature: string;
  label: string;
  machine: MachineSettings;
}

function cleanSettingValue(value: string | number | null | undefined): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Number(value.toFixed(2)).toString();
  }

  const text = value?.trim();
  if (!text) return null;
  return text
    .replace(/\s*\(\s*cmh?2o\s*\)\s*$/i, " cmH2O")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForSignature(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s*\(\s*cmh?2o\s*\)\s*/g, " cmh2o")
    .replace(/\s+/g, " ")
    .trim();
}

function stripFixedPrefix(value: string | null): string | null {
  return value?.replace(/^fixed\s+/i, "").trim() ?? null;
}

function joinRange(min: string | null, max: string | null): string | null {
  if (min && max) return `${min}-${max}`;
  return min ?? max;
}

export function buildTherapySettingsSnapshot(input: TherapySettingsSnapshotInput): TherapySettingsSnapshot | null {
  const mode = cleanSettingValue(input.mode);
  const pressure = stripFixedPrefix(cleanSettingValue(input.pressure));
  const pressureMin = cleanSettingValue(input.pressureMin);
  const pressureMax = cleanSettingValue(input.pressureMax);
  const epap = cleanSettingValue(input.epap);
  const ipap = cleanSettingValue(input.ipap);

  const parts: Array<[string, string]> = [];
  if (mode) parts.push(["mode", mode]);
  if (pressure) parts.push(["pressure", pressure]);
  if (pressureMin) parts.push(["pressureMin", pressureMin]);
  if (pressureMax) parts.push(["pressureMax", pressureMax]);
  if (epap) parts.push(["epap", epap]);
  if (ipap) parts.push(["ipap", ipap]);

  if (parts.length === 0) return null;

  const detailParts: string[] = [];
  const pressureRange = joinRange(pressureMin, pressureMax);
  if (epap) detailParts.push(`EPAP ${epap}`);
  if (ipap) detailParts.push(`IPAP ${ipap}`);
  if (!epap && !ipap && pressureRange) detailParts.push(pressureRange);
  else if (!epap && !ipap && pressure) detailParts.push(pressure);

  const label = [mode ?? "Therapy", detailParts.join(" / ")].filter(Boolean).join(" ").trim();
  const signature = parts
    .map(([key, value]) => `${key}:${normalizeForSignature(value)}`)
    .sort()
    .join("|");

  const machine: MachineSettings = {
    ...(mode ? { mode } : {}),
    ...(pressure ? { pressure: `Fixed ${pressure}` } : {}),
    ...(pressureMin ? { pressureMin } : {}),
    ...(pressureMax ? { pressureMax } : {}),
    ...(pressureMin || pressureMax ? { pressureIsAuto: true } : {}),
    ...(epap ? { epap } : {}),
    ...(ipap ? { ipap } : {})
  };

  return { signature, label, machine };
}
import type { MachineSettings } from "@/lib/types";
