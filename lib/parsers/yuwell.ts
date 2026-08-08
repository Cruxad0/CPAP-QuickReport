import type { FamilyParserCandidate, FamilyParserContext, FamilyParserDeps } from "@/lib/parsers/text-family-types";
import type { ParsedRecord, QuickReportMetrics } from "@/lib/types";

type SessionValues = {
  start: Date;
  end: Date;
  mode: number;
  modelSerial?: string;
  rampMinutes?: number;
  fixedPressure?: number;
  minPressure?: number;
  maxPressure?: number;
  epap?: number;
  ipap?: number;
  pressures: number[];
  epaps: number[];
  ipaps: number[];
  leaks: number[];
  tidalVolumes: number[];
  respiratoryRates: number[];
  obstructiveEvents: number;
  centralEvents: number;
  hypopneaEvents: number;
};

function u16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let i = offset; i < Math.min(bytes.length, offset + length); i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte === 0) break;
    if (byte >= 32 && byte <= 126) value += String.fromCharCode(byte);
  }
  return value.trim();
}

function dateFromParts(year: number, month: number, day: number, hour: number, minute: number, second: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }
  return date;
}

function shortDate(bytes: Uint8Array, offset: number): Date | null {
  return dateFromParts(
    2000 + (bytes[offset] ?? 0),
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
    bytes[offset + 4] ?? 0,
    bytes[offset + 5] ?? 0
  );
}

function longDate(bytes: Uint8Array, offset: number): Date | null {
  return dateFromParts(
    u16(bytes, offset),
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
    bytes[offset + 4] ?? 0,
    bytes[offset + 5] ?? 0,
    bytes[offset + 6] ?? 0
  );
}

function average(values: number[]): number | undefined {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] * (1 - (index - low)) + sorted[high] * (index - low);
}

function cm(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0 || value > 80) return undefined;
  return `${Number(value.toFixed(2)).toString()} cmH2O`;
}

function createSessionValues(start: Date, end: Date, mode: number): SessionValues {
  return {
    start,
    end,
    mode,
    pressures: [],
    epaps: [],
    ipaps: [],
    leaks: [],
    tidalVolumes: [],
    respiratoryRates: [],
    obstructiveEvents: 0,
    centralEvents: 0,
    hypopneaEvents: 0
  };
}

function addEventCounts(values: SessionValues, oa: number, ca: number, h: number) {
  if (oa > 0) values.obstructiveEvents += 1;
  if (ca > 0) values.centralEvents += 1;
  if (h > 0) values.hypopneaEvents += 1;
}

function applyYuwellMachine(values: SessionValues, machine: QuickReportMetrics["machine"]) {
  if (values.modelSerial) machine.device = values.modelSerial;
  if (values.rampMinutes !== undefined && !machine.rampTime) {
    machine.rampTime = values.rampMinutes > 0 ? `${values.rampMinutes} minutes` : "Off";
  }

  if (values.mode >= 1 && values.mode <= 5 && (values.epap !== undefined || values.ipap !== undefined)) {
    machine.mode = "BiPAP";
    machine.epap = cm(values.epap);
    machine.ipap = cm(values.ipap);
    return;
  }

  if (values.mode === 0) {
    const pressure = values.fixedPressure ?? average(values.pressures);
    machine.mode = "CPAP";
    if (pressure !== undefined) machine.pressure = `Fixed ${cm(pressure)}`;
    return;
  }

  machine.mode = "APAP";
  machine.pressureIsAuto = true;
  machine.pressureMin = cm(values.minPressure ?? (values.pressures.length > 0 ? Math.min(...values.pressures) : undefined));
  machine.pressureMax = cm(values.maxPressure ?? (values.pressures.length > 0 ? Math.max(...values.pressures) : undefined));
}

function toRecord(values: SessionValues): ParsedRecord | null {
  const elapsedHours = (values.end.getTime() - values.start.getTime()) / 3_600_000;
  if (!Number.isFinite(elapsedHours) || elapsedHours <= 0 || elapsedHours > 24) return null;
  const ahiEvents = values.obstructiveEvents + values.centralEvents + values.hypopneaEvents;
  return {
    date: values.start,
    therapySessionStart: values.start,
    therapySessionEnd: values.end,
    usageHours: elapsedHours,
    ahi: ahiEvents > 0 ? ahiEvents / elapsedHours : 0,
    residualApneas: values.obstructiveEvents > 0 ? values.obstructiveEvents / elapsedHours : 0,
    centralApneas: values.centralEvents > 0 ? values.centralEvents / elapsedHours : 0,
    leak: average(values.leaks),
    leak95th: percentile(values.leaks, 95),
    leakMax: values.leaks.length > 0 ? Math.max(...values.leaks) : undefined,
    pressureAvg: average(values.pressures),
    pressure95th: percentile(values.pressures, 95),
    epapAvg: average(values.epaps),
    epap95th: percentile(values.epaps, 95),
    ipapAvg: average(values.ipaps),
    ipap95th: percentile(values.ipaps, 95),
    tidalVolumeAvg: average(values.tidalVolumes),
    tidalVolumeMin: values.tidalVolumes.length > 0 ? Math.min(...values.tidalVolumes) : undefined,
    tidalVolumeMax: values.tidalVolumes.length > 0 ? Math.max(...values.tidalVolumes) : undefined,
    tidalVolumeSampleCount: values.tidalVolumes.length || undefined,
    respiratoryRateAvg: average(values.respiratoryRates),
    respiratoryRate95th: percentile(values.respiratoryRates, 95),
    respiratoryRateSampleCount: values.respiratoryRates.length || undefined
  };
}

export function parseYuwellFormatA(bytes: Uint8Array): SessionValues | null {
  if (bytes.length < 0x33) return null;
  const start = shortDate(bytes, 0);
  const end = shortDate(bytes, 6);
  const modelSerial = ascii(bytes, 0x1e, 16);
  if (!start || !end || !modelSerial.startsWith("YH")) return null;
  const values = createSessionValues(start, end, bytes[0x0c] ?? 0);
  values.modelSerial = modelSerial;
  values.rampMinutes = bytes[0x0d] ?? 0;
  values.fixedPressure = (bytes[0x0e] ?? 0) / 10;
  values.minPressure = (bytes[0x0f] ?? 0) / 10;
  values.maxPressure = (bytes[0x10] ?? 0) / 10;
  const recordCount = u16(bytes, 0x2e);
  for (let i = 0; i < recordCount; i += 1) {
    const offset = 0x33 + i * 0x0a;
    if (offset + 0x0a > bytes.length) break;
    const pressure = (bytes[offset] ?? 0) / 10;
    const leak = bytes[offset + 9] ?? 0;
    if (pressure > 0 && pressure <= 80) values.pressures.push(pressure);
    if (leak > 0 && leak < 249) values.leaks.push(leak);
    addEventCounts(values, bytes[offset + 3] ?? 0, bytes[offset + 5] ?? 0, bytes[offset + 4] ?? 0);
  }
  return values;
}

export function parseYuwellFormatB(bytes: Uint8Array): SessionValues[] {
  if (bytes.length !== 0x10000 || !ascii(bytes, 0x84, 16).startsWith("YH")) return [];
  const modelSerial = ascii(bytes, 0x84, 16);
  const sessions: SessionValues[] = [];
  const recordCount = u16(bytes, 0x1f);
  for (let i = 0; i < recordCount; i += 1) {
    const offset = 0x0c00 + i * 30;
    if (offset + 30 > bytes.length) break;
    const start = shortDate(bytes, offset);
    const end = shortDate(bytes, offset + 6);
    if (!start || !end) continue;
    const values = createSessionValues(start, end, bytes[offset + 12] ?? 0);
    values.modelSerial = modelSerial;
    values.rampMinutes = bytes[offset + 13] ?? 0;
    values.fixedPressure = (bytes[offset + 14] ?? 0) / 10;
    values.maxPressure = (bytes[offset + 16] ?? 0) / 10;
    values.minPressure = (bytes[offset + 17] ?? 0) / 10;
    const detailOffset = 0x7600 + (((bytes[offset + 26] ?? 0) << 8) | (bytes[offset + 27] ?? 0));
    const sessionMinutes = bytes[offset + 29] ?? 0;
    for (let minute = 0; minute < sessionMinutes; minute += 1) {
      const detail = detailOffset + minute * 7;
      if (detail + 7 > bytes.length) break;
      const leak = bytes[detail] ?? 0;
      const pressure = (bytes[detail + 1] ?? 0) / 10;
      if (pressure > 0 && pressure <= 80) values.pressures.push(pressure);
      if (leak > 0 && leak < 249) values.leaks.push(leak);
      addEventCounts(values, bytes[detail + 3] ?? 0, bytes[detail + 6] ?? 0, bytes[detail + 4] ?? 0);
    }
    sessions.push(values);
  }
  return sessions;
}

export function parseYuwellFormatC(bytes: Uint8Array): SessionValues | null {
  if (bytes.length < 0x3c) return null;
  const start = longDate(bytes, 0);
  const end = longDate(bytes, 7);
  const modelSerial = ascii(bytes, 0x27, 16);
  if (!start || !end || !modelSerial.startsWith("YH")) return null;
  const recordCount = u16(bytes, 0x0e);
  let values: SessionValues | null = null;
  for (let i = 0; i < recordCount; i += 1) {
    const offset = 0x3c + i * 0x28;
    if (offset + 0x28 > bytes.length || bytes[offset] !== 0xf9) break;
    const mode = bytes[offset + 1] ?? 0xff;
    values ??= createSessionValues(start, end, mode);
    values.modelSerial = modelSerial;
    values.rampMinutes ??= bytes[offset + 0x12] ?? 0;
    const ipap = u16(bytes, offset + 0x02) / 10;
    const epap = u16(bytes, offset + 0x04) / 10;
    const pressure = (bytes[offset + 0x0c] ?? 0) / 10;
    const initialPressure = (bytes[offset + 0x0d] ?? 0) / 10;
    if (mode === 0 || mode === 6) {
      if (pressure > 0 && pressure <= 80) values.pressures.push(pressure);
      if (mode === 0 && initialPressure > 0) values.fixedPressure ??= initialPressure;
    } else {
      if (ipap > 0 && ipap <= 80) values.ipaps.push(ipap);
      if (epap > 0 && epap <= 80) values.epaps.push(epap);
      values.ipap ??= ipap;
      values.epap ??= epap;
    }
    const tidalVolume = u16(bytes, offset + 0x15);
    const leak = (bytes[offset + 0x17] ?? 0) / 10;
    const respiratoryRate = bytes[offset + 0x22] ?? 0;
    if (tidalVolume > 0 && tidalVolume < 5000) values.tidalVolumes.push(tidalVolume);
    if (leak > 0 && leak < 500) values.leaks.push(leak);
    if (respiratoryRate > 0 && respiratoryRate <= 120) values.respiratoryRates.push(respiratoryRate);
    addEventCounts(values, bytes[offset + 0x23] ?? 0, bytes[offset + 0x26] ?? 0, bytes[offset + 0x24] ?? 0);
  }
  if (!values) return null;
  if (values.mode === 6 && values.pressures.length > 0) {
    values.minPressure = Math.min(...values.pressures);
    values.maxPressure = Math.max(...values.pressures);
  }
  return values;
}

export function parseYuwellFormatD(summary: Uint8Array, minutes: Uint8Array): SessionValues | null {
  if (summary.length < 0x4d || minutes.length < 8) return null;
  const start = shortDate(summary, 2);
  const end = shortDate(summary, 8);
  const modelSerial = ascii(summary, 0x20, 16);
  if (!start || !end || !modelSerial.startsWith("YH")) return null;
  const values = createSessionValues(start, end, summary[0x38] ?? 0);
  values.modelSerial = modelSerial;
  values.rampMinutes = summary[0x4c] ?? 0;
  const recordCount = u16(minutes, 6);
  for (let i = 0; i < recordCount; i += 1) {
    const offset = 8 + i * 18;
    if (offset + 18 > minutes.length) break;
    const pressure = (minutes[offset] ?? 0) / 10;
    const leak = minutes[offset + 9] ?? 0;
    if (pressure > 0 && pressure <= 80) values.pressures.push(pressure);
    if (leak > 0 && leak < 249) values.leaks.push(leak);
    addEventCounts(values, minutes[offset + 2] ?? 0, minutes[offset + 3] ?? 0, minutes[offset + 4] ?? 0);
  }
  if (values.pressures.length > 0) {
    if (values.mode === 0) values.fixedPressure = values.pressures[0];
    else {
      values.minPressure = values.pressures[0];
      values.maxPressure = Math.max(...values.pressures);
    }
  }
  return values;
}

function directory(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/[^/]+$/, "").toLowerCase();
}

async function readCandidate(candidate: FamilyParserCandidate): Promise<Uint8Array | null> {
  try {
    return await candidate.file.readBytes();
  } catch {
    return null;
  }
}

export async function parseYuwellFamily(context: FamilyParserContext, deps: FamilyParserDeps): Promise<void> {
  const candidates = [...context.candidates].sort((a, b) => a.normalizedPath.localeCompare(b.normalizedPath, undefined, { numeric: true }));
  const minuteByDirectory = new Map<string, FamilyParserCandidate>();
  for (const candidate of candidates) {
    if (/m\.bys$/i.test(candidate.normalizedPath)) minuteByDirectory.set(directory(candidate.normalizedPath), candidate);
  }

  const sessions: SessionValues[] = [];
  let processed = 0;
  for (const candidate of candidates) {
    processed += 1;
    deps.emit(context.onProgress, {
      phase: "parse",
      detail: `Reading ${candidate.normalizedPath}`,
      percent: context.progressStart + Math.round((processed / Math.max(1, candidates.length)) * (context.progressEnd - context.progressStart))
    });
    const lower = candidate.normalizedPath.toLowerCase();
    const bytes = await readCandidate(candidate);
    if (!bytes) continue;

    if (/(?:^|\/)yhsd-new\.bys$/i.test(lower)) {
      sessions.push(...parseYuwellFormatB(bytes));
      continue;
    }
    if (/s\.bys$/i.test(lower)) {
      const minuteCandidate = minuteByDirectory.get(directory(candidate.normalizedPath));
      if (minuteCandidate) {
        const minuteBytes = await readCandidate(minuteCandidate);
        if (minuteBytes) {
          const parsed = parseYuwellFormatD(bytes, minuteBytes);
          if (parsed) sessions.push(parsed);
        }
        continue;
      }
    }
    if (!/\.bys$/i.test(lower) || /(?:runlog|summer|sn|yhsd-old)\.bys$/i.test(lower)) continue;
    const formatC = parseYuwellFormatC(bytes);
    if (formatC) {
      sessions.push(formatC);
      continue;
    }
    const formatA = parseYuwellFormatA(bytes);
    if (formatA) sessions.push(formatA);
  }

  sessions.sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const session of sessions) {
    applyYuwellMachine(session, context.machine);
    const record = toRecord(session);
    if (record) context.records.push(record);
  }
  if (!context.machine.device) context.machine.device = "Yuwell";
  if (sessions.length === 0) context.warnings.push("Yuwell structure was detected, but no supported YH-series sessions were parsed.");
}
