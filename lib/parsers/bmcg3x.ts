import type { FamilyParserContext, FamilyParserDeps } from "@/lib/parsers/text-family-types";
import type { ParsedRecord, QuickReportMetrics } from "@/lib/types";

const G3X_IDX_MAGIC = "BMC G/E/P INDEX";
const G3X_IDX_RECORD_OFFSET = 0x800;
const G3X_IDX_RECORD_SIZE = 0x800;
const G3X_EVT_RECORD_SIZE = 0x20;
const G3X_WAVEFORM_PACKET_SIZE = 0x800;
const G3X_WAVEFORM_FILE_SPAN = 64 * 1024 * 1024;
const G3X_MASK_OFF_FLOW_NOISE = 25;
const G3X_MASK_OFF_SUSTAIN_SECONDS = 300;
const LARGE_LEAK_THRESHOLD_LPM = 30;

type G3xDay = {
  date: Date;
  dateIso: string;
  waveStart: number;
  waveEnd: number;
  waveLength: number;
  eventStart: number;
  eventEnd: number;
  eventLength: number;
  usageHours?: number;
  ahi?: number;
  residualApneas?: number;
  centralApneas?: number;
  reraIndex?: number;
  pressure95th?: number;
  pressureMin?: number;
  pressureMax?: number;
  epap?: number;
};

type G3xWaveSample = {
  timestampMs: number;
  activeFlow: boolean;
  leak?: number;
  pressure?: number;
  epap?: number;
  ipap?: number;
  tidalVolume?: number;
  respiratoryRate?: number;
};

type G3xWaveSummary = {
  usageHours?: number;
  leak?: number;
  leak95th?: number;
  leakMax?: number;
  pressureAvg?: number;
  pressure95th?: number;
  epapAvg?: number;
  epap95th?: number;
  ipapAvg?: number;
  ipap95th?: number;
  tidalVolumeAvg?: number;
  tidalVolumeMin?: number;
  tidalVolumeMax?: number;
  tidalVolumeSampleCount?: number;
  respiratoryRateAvg?: number;
  respiratoryRate95th?: number;
  respiratoryRateSampleCount?: number;
};

function u16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function i16(bytes: Uint8Array, offset: number): number {
  const value = u16(bytes, offset);
  return value >= 0x8000 ? value - 0x10000 : value;
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
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

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] * (1 - (index - low)) + sorted[high] * (index - low);
}

function average(values: number[]): number | undefined {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function decodeTimestamp(bytes: Uint8Array, offset: number): Date | null {
  const year = 1900 + (bytes[offset] ?? 0);
  const month = bytes[offset + 1] ?? 0;
  const day = bytes[offset + 2] ?? 0;
  const hour = bytes[offset + 3] ?? 0;
  const minute = bytes[offset + 4] ?? 0;
  const second = bytes[offset + 5] ?? 0;
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

function cm(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0 || value > 80) return undefined;
  return `${Number(value.toFixed(2)).toString()} cmH2O`;
}

export function isBmcG3xIdx(bytes: Uint8Array): boolean {
  return ascii(bytes, 0, 32).startsWith(G3X_IDX_MAGIC);
}

function inferMachine(bytes: Uint8Array, machine: QuickReportMetrics["machine"]) {
  const serial = ascii(bytes, 0x30, 16);
  const model = ascii(bytes, 0x100, 16) || ascii(bytes, 0x48, 16) || "Luna G3X";
  machine.device = serial ? `${model} (${serial})` : model;
}

export function parseBmcG3xIdxDays(bytes: Uint8Array): G3xDay[] {
  if (!isBmcG3xIdx(bytes)) return [];
  const days: G3xDay[] = [];
  // OSCAR's E5 card analysis found that IT 0xBC–0xD2 carries different fields
  // from G3X, while duration and pressure settings remain usable.
  const isE5Platform = /^E5\b/i.test(ascii(bytes, 0x100, 16)) || /^E5\b/i.test(ascii(bytes, 0x345, 20));

  for (let offset = G3X_IDX_RECORD_OFFSET; offset + G3X_IDX_RECORD_SIZE <= bytes.length; offset += G3X_IDX_RECORD_SIZE) {
    if (u16(bytes, offset) !== 0xaaaa) continue;
    const year = 1900 + (bytes[offset + 0x08] ?? 0);
    const month = bytes[offset + 0x09] ?? 0;
    const day = bytes[offset + 0x0a] ?? 0;
    const date = new Date(Date.UTC(year, month - 1, day, 12));
    if (
      Number.isNaN(date.getTime()) ||
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() + 1 !== month ||
      date.getUTCDate() !== day
    ) {
      continue;
    }

    const it = offset + 0x80;
    const ts = offset + 0x280;
    const hasIt = bytes[it] === 0x49 && bytes[it + 1] === 0x54;
    const hasTs = bytes[ts] === 0x54 && bytes[ts + 1] === 0x53;
    const optionalIndex = (fieldOffset: number): number | undefined => {
      if (!hasIt) return undefined;
      const raw = u16(bytes, it + fieldOffset);
      return raw === 0xffff ? undefined : raw / 100;
    };
    const optionalPressure = (fieldOffset: number): number | undefined => {
      if (!hasIt) return undefined;
      const raw = u16(bytes, it + fieldOffset);
      return raw === 0xffff || raw === 0 ? undefined : raw / 100;
    };
    const tsPressure = (fieldOffset: number): number | undefined => {
      if (!hasTs) return undefined;
      const raw = u16(bytes, ts + fieldOffset);
      return raw === 0xffff || raw === 0 ? undefined : raw / 100;
    };
    const durationSeconds = hasIt ? u32(bytes, it + 0x14) : 0;
    const validDurationSeconds = durationSeconds > 0 && durationSeconds <= 24 * 60 * 60;
    const waveStart = u32(bytes, offset + 0x10);
    const waveEnd = u32(bytes, offset + 0x14);
    const waveLength = u32(bytes, offset + 0x18);
    const eventStart = u32(bytes, offset + 0x1c);
    const eventEnd = u32(bytes, offset + 0x20);
    const eventLength = u32(bytes, offset + 0x24);
    if (!validDurationSeconds && (waveLength === 0 || waveEnd <= waveStart) && (eventLength === 0 || eventEnd <= eventStart)) continue;

    days.push({
      date,
      dateIso: date.toISOString().slice(0, 10),
      waveStart,
      waveEnd,
      waveLength,
      eventStart,
      eventEnd,
      eventLength,
      usageHours: validDurationSeconds ? durationSeconds / 3600 : undefined,
      ahi: isE5Platform ? undefined : optionalIndex(0xbc),
      residualApneas: isE5Platform ? undefined : optionalIndex(0xc2),
      centralApneas: isE5Platform ? undefined : optionalIndex(0xc4),
      reraIndex: isE5Platform ? undefined : optionalIndex(0xc6),
      pressure95th: optionalPressure(0x2c),
      pressureMin: tsPressure(0x0e) ?? optionalPressure(0x28),
      pressureMax: tsPressure(0x10) ?? optionalPressure(0x2a),
      epap: optionalPressure(0x30)
    });
  }

  return days;
}

function applyLatestSettings(days: G3xDay[], machine: QuickReportMetrics["machine"]) {
  const latest = [...days].sort((a, b) => b.date.getTime() - a.date.getTime())[0];
  if (!latest) return;
  if (latest.pressureMin && latest.pressureMax && latest.pressureMax > latest.pressureMin) {
    machine.mode = "APAP";
    machine.pressureIsAuto = true;
    machine.pressureMin = cm(latest.pressureMin);
    machine.pressureMax = cm(latest.pressureMax);
  } else {
    const pressure = latest.epap ?? latest.pressureMin ?? latest.pressureMax;
    if (pressure) {
      machine.mode = "CPAP";
      machine.pressure = `Fixed ${cm(pressure)}`;
    }
  }
}

function splitMaskOnSessions(samples: G3xWaveSample[]): Array<{ startMs: number; endMs: number }> {
  if (samples.length === 0) return [];
  const sorted = [...samples].sort((a, b) => a.timestampMs - b.timestampMs);
  const sessions: Array<{ startMs: number; endMs: number }> = [];
  let sessionStart = 0;

  const finishSession = (startIndex: number, endIndex: number) => {
    if (endIndex < startIndex) return;
    let lastActive = -1;
    for (let i = endIndex; i >= startIndex; i -= 1) {
      if (sorted[i].activeFlow) {
        lastActive = i;
        break;
      }
    }
    const startMs = sorted[startIndex].timestampMs;
    const lastMs = sorted[endIndex].timestampMs + 1000;
    if (lastActive < 0) {
      if (lastMs > startMs) sessions.push({ startMs, endMs: lastMs });
      return;
    }
    const inactiveSeconds = (sorted[endIndex].timestampMs - sorted[lastActive].timestampMs) / 1000;
    const endMs = inactiveSeconds >= G3X_MASK_OFF_SUSTAIN_SECONDS ? sorted[lastActive].timestampMs : lastMs;
    if (endMs > startMs) sessions.push({ startMs, endMs });
  };

  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].timestampMs - sorted[i - 1].timestampMs >= 5000) {
      finishSession(sessionStart, i - 1);
      sessionStart = i;
    }
  }
  finishSession(sessionStart, sorted.length - 1);
  return sessions;
}

function summarizeMaskOnUsage(samples: G3xWaveSample[]): number | undefined {
  const totalMs = splitMaskOnSessions(samples).reduce((sum, session) => sum + session.endMs - session.startMs, 0);
  return totalMs > 0 ? totalMs / 3_600_000 : undefined;
}

function summarizeWaveSamples(samples: G3xWaveSample[]): G3xWaveSummary {
  const leaks = samples.flatMap((sample) => (sample.leak === undefined ? [] : [sample.leak]));
  const pressures = samples.flatMap((sample) => (sample.pressure === undefined ? [] : [sample.pressure]));
  const epaps = samples.flatMap((sample) => (sample.epap === undefined ? [] : [sample.epap]));
  const ipaps = samples.flatMap((sample) => (sample.ipap === undefined ? [] : [sample.ipap]));
  const tidalVolumes = samples.flatMap((sample) => (sample.tidalVolume === undefined ? [] : [sample.tidalVolume]));
  const respiratoryRates = samples.flatMap((sample) => (sample.respiratoryRate === undefined ? [] : [sample.respiratoryRate]));
  return {
    usageHours: summarizeMaskOnUsage(samples),
    leak: average(leaks),
    leak95th: percentile(leaks, 95),
    leakMax: leaks.length > 0 ? Math.max(...leaks) : undefined,
    pressureAvg: average(pressures),
    pressure95th: percentile(pressures, 95),
    epapAvg: average(epaps),
    epap95th: percentile(epaps, 95),
    ipapAvg: average(ipaps),
    ipap95th: percentile(ipaps, 95),
    tidalVolumeAvg: average(tidalVolumes),
    tidalVolumeMin: tidalVolumes.length > 0 ? Math.min(...tidalVolumes) : undefined,
    tidalVolumeMax: tidalVolumes.length > 0 ? Math.max(...tidalVolumes) : undefined,
    tidalVolumeSampleCount: tidalVolumes.length || undefined,
    respiratoryRateAvg: average(respiratoryRates),
    respiratoryRate95th: percentile(respiratoryRates, 95),
    respiratoryRateSampleCount: respiratoryRates.length || undefined
  };
}

function parseWaveformSamples(bytes: Uint8Array, virtualFileStart: number, days: G3xDay[]): Map<string, G3xWaveSample[]> {
  const samplesByDay = new Map<string, G3xWaveSample[]>();
  let useAlternateLeak = false;
  let probeCount = 0;
  let primaryLeakNonZero = 0;
  for (let offset = 0; offset + G3X_WAVEFORM_PACKET_SIZE <= bytes.length && probeCount < 120; offset += G3X_WAVEFORM_PACKET_SIZE) {
    if (bytes[offset] !== 0xad || bytes[offset + 1] !== 0xaa) continue;
    probeCount += 1;
    if (u16(bytes, offset + 0x52a) > 0) primaryLeakNonZero += 1;
  }
  if (probeCount > 0 && primaryLeakNonZero < Math.max(1, Math.floor(probeCount / 100))) useAlternateLeak = true;

  for (let offset = 0; offset + G3X_WAVEFORM_PACKET_SIZE <= bytes.length; offset += G3X_WAVEFORM_PACKET_SIZE) {
    if (bytes[offset] !== 0xad || bytes[offset + 1] !== 0xaa) continue;
    const virtualOffset = virtualFileStart + offset;
    const day = days.find((entry) => virtualOffset >= entry.waveStart && virtualOffset < entry.waveEnd);
    if (!day) continue;
    const timestamp = decodeTimestamp(bytes, offset + 0x04);
    if (!timestamp) continue;

    let activeFlow = false;
    for (let sampleOffset = 0; sampleOffset < 100; sampleOffset += 1) {
      if (Math.abs(i16(bytes, offset + 0x56e + sampleOffset * 2)) > G3X_MASK_OFF_FLOW_NOISE) {
        activeFlow = true;
        break;
      }
    }

    const rawLeak = u16(bytes, offset + (useAlternateLeak ? 0x568 : 0x52a));
    const epap = u16(bytes, offset + 0x76c) / 100;
    const ipap = u16(bytes, offset + 0x76e) / 100;
    const pressure = Math.max(epap, ipap);
    const tidalVolume = u16(bytes, offset + 0x52c);
    const respiratoryRate = u16(bytes, offset + 0x530);
    const sample: G3xWaveSample = {
      timestampMs: timestamp.getTime(),
      activeFlow,
      leak: rawLeak > 0 ? rawLeak * 0.16 : undefined,
      pressure: pressure > 0 && pressure <= 80 ? pressure : undefined,
      epap: epap > 0 && epap <= 80 ? epap : undefined,
      ipap: ipap > 0 && ipap <= 80 ? ipap : undefined,
      tidalVolume: tidalVolume > 0 && tidalVolume < 5000 ? tidalVolume : undefined,
      respiratoryRate: respiratoryRate > 0 && respiratoryRate <= 120 ? respiratoryRate : undefined
    };
    const list = samplesByDay.get(day.dateIso) ?? [];
    list.push(sample);
    samplesByDay.set(day.dateIso, list);
  }

  return samplesByDay;
}

type G3xSessionWindow = { startMs: number; endMs: number };
type G3xPressureSnapshots = { epaps: number[]; ipaps: number[] };
type G3xPressureUpdate = { timestampMs: number; epap: number; ipap: number };

function constantPressure(values: number[]): number | undefined {
  const first = values[0];
  return first !== undefined && values.every((value) => value === first) ? first : undefined;
}

function g3xFileBase(path: string): string {
  return path.replace(/\.(?:idx|evt|\d{3})$/i, "").toLowerCase();
}

function applyEvtFallback(
  bytes: Uint8Array,
  days: G3xDay[],
  records: Map<string, ParsedRecord>
): { sessionsByDay: Map<string, G3xSessionWindow[]>; pressureByDay: Map<string, G3xPressureSnapshots> } {
  const counts = new Map<string, { ua: number; oa: number; ca: number; h: number; rera: number }>();
  const sessionStarts = new Map<string, number[]>();
  const sessionEnds = new Map<string, number[]>();
  const pressureByDay = new Map<string, G3xPressureSnapshots>();
  const unindexedPressureUpdates: G3xPressureUpdate[] = [];
  for (let offset = 0; offset + G3X_EVT_RECORD_SIZE <= bytes.length; offset += G3X_EVT_RECORD_SIZE) {
    if (bytes[offset] !== 0xae || bytes[offset + 1] !== 0xaa) continue;
    const timestamp = decodeTimestamp(bytes, offset + 0x14);
    if (!timestamp) continue;
    const milliseconds = u16(bytes, offset + 0x1a);
    if (milliseconds <= 999) timestamp.setUTCMilliseconds(milliseconds);
    const type = bytes[offset + 0x10] ?? 0;
    let pressureUpdate: G3xPressureUpdate | null = null;
    if (type === 0x42) {
      const epapRaw = u16(bytes, offset + 0x1c);
      const ipapRaw = u16(bytes, offset + 0x1e);
      if (epapRaw >= 400 && epapRaw <= 3500) {
        pressureUpdate = {
          timestampMs: timestamp.getTime(),
          epap: epapRaw / 100,
          ipap: (ipapRaw >= 400 && ipapRaw <= 3500 ? ipapRaw : epapRaw) / 100
        };
      }
    }
    const day = days.find((entry) =>
      entry.eventLength > 0 &&
      offset >= Math.floor(entry.eventStart / G3X_EVT_RECORD_SIZE) * G3X_EVT_RECORD_SIZE &&
      offset < entry.eventEnd
    );
    if (!day) {
      if (pressureUpdate) unindexedPressureUpdates.push(pressureUpdate);
      continue;
    }
    if (type === 0x42) {
      // OSCAR decodes value2 as EPAP and unk1e as IPAP, in hundredths of cmH2O.
      if (pressureUpdate) {
        const values = pressureByDay.get(day.dateIso) ?? { epaps: [], ipaps: [] };
        values.epaps.push(pressureUpdate.epap);
        values.ipaps.push(pressureUpdate.ipap);
        pressureByDay.set(day.dateIso, values);
      }
      continue;
    }
    if (type === 0x40 || type === 0x41) {
      const markers = type === 0x40 ? sessionStarts : sessionEnds;
      const values = markers.get(day.dateIso) ?? [];
      values.push(timestamp.getTime());
      markers.set(day.dateIso, values);
      continue;
    }
    const current = counts.get(day.dateIso) ?? { ua: 0, oa: 0, ca: 0, h: 0, rera: 0 };
    if (type === 0x02) current.ua += 1;
    else if (type === 0x03) current.oa += 1;
    else if (type === 0x04) current.ca += 1;
    else if (type === 0x01 || type === 0x07 || type === 0x08) current.h += 1;
    else if (type === 0x0a) current.rera += 1;
    counts.set(day.dateIso, current);
  }

  // Some G3X/E5 cards have pressure 0x42 records near the IDX day but outside
  // its EVT byte slice. OSCAR searches those records when the slice has no
  // pressure; keep this fallback pressure-only so stale events cannot affect AHI.
  const fallbackDays = days.filter((day) => !pressureByDay.has(day.dateIso));
  for (const update of unindexedPressureUpdates) {
    let closestDay: G3xDay | null = null;
    let closestDistanceMs = Number.POSITIVE_INFINITY;
    const updateMidnightMs = Math.floor(update.timestampMs / 86_400_000) * 86_400_000;
    for (const day of fallbackDays) {
      const dateMidnightMs = day.date.getTime() - 12 * 3_600_000;
      const endWindowMs = day.date.getTime() + (day.usageHours ?? 1) * 3_600_000 + 12 * 3_600_000;
      if (
        (update.timestampMs < dateMidnightMs || update.timestampMs > endWindowMs) &&
        Math.abs(updateMidnightMs - dateMidnightMs) > 86_400_000
      ) continue;
      // Adjacent IDX days have overlapping fallback windows. Assign each
      // pressure update to the nearest clinical noon-to-noon day only once.
      const clinicalStartMs = day.date.getTime();
      const clinicalEndMs = clinicalStartMs + 86_400_000;
      const distanceMs = Math.max(clinicalStartMs - update.timestampMs, update.timestampMs - clinicalEndMs, 0);
      if (distanceMs < closestDistanceMs) {
        closestDay = day;
        closestDistanceMs = distanceMs;
      }
    }
    if (!closestDay) continue;
    const values = pressureByDay.get(closestDay.dateIso) ?? { epaps: [], ipaps: [] };
    values.epaps.push(update.epap);
    values.ipaps.push(update.ipap);
    pressureByDay.set(closestDay.dateIso, values);
  }

  const sessionsByDay = new Map<string, G3xSessionWindow[]>();
  for (const day of days) {
    const starts = sessionStarts.get(day.dateIso) ?? [];
    const ends = sessionEnds.get(day.dateIso) ?? [];
    const sessions: G3xSessionWindow[] = [];
    for (let index = 0; index < Math.min(starts.length, ends.length); index += 1) {
      const startMs = starts[index];
      const endMs = ends[index];
      if (endMs > startMs && endMs - startMs <= 24 * 60 * 60 * 1000) sessions.push({ startMs, endMs });
    }
    const totalSessionMs = sessions.reduce((sum, session) => sum + (session.endMs - session.startMs), 0);
    if (totalSessionMs <= 0 || totalSessionMs > 24 * 60 * 60 * 1000) continue;
    sessionsByDay.set(day.dateIso, sessions);
    const record = records.get(day.dateIso);
    if (record && record.usageHours === undefined) {
      record.usageHours = totalSessionMs / 3_600_000;
    }
  }

  for (const [dayIso, dayCounts] of counts) {
    const record = records.get(dayIso);
    if (!record?.usageHours) continue;
    const total = dayCounts.ua + dayCounts.oa + dayCounts.ca + dayCounts.h;
    if (record.ahi === undefined && total > 0) record.ahi = total / record.usageHours;
    if (record.residualApneas === undefined && dayCounts.ua + dayCounts.oa > 0) {
      record.residualApneas = (dayCounts.ua + dayCounts.oa) / record.usageHours;
    }
    if (record.centralApneas === undefined && dayCounts.ca > 0) record.centralApneas = dayCounts.ca / record.usageHours;
    if (record.reraIndex === undefined && dayCounts.rera > 0) record.reraIndex = dayCounts.rera / record.usageHours;
  }

  return { sessionsByDay, pressureByDay };
}

export async function parseBmcG3xFamily(context: FamilyParserContext, deps: FamilyParserDeps): Promise<void> {
  const idxCandidates = context.candidates.filter((candidate) => candidate.normalizedPath.toLowerCase().endsWith(".idx"));
  const evtCandidates = context.candidates.filter((candidate) => candidate.normalizedPath.toLowerCase().endsWith(".evt"));
  const waveformCandidates = context.candidates.filter((candidate) => /\.\d{3}$/i.test(candidate.normalizedPath));
  const records = new Map<string, ParsedRecord>();
  const days: G3xDay[] = [];
  const daysByBase = new Map<string, G3xDay[]>();
  let processed = 0;
  const total = idxCandidates.length + evtCandidates.length + waveformCandidates.length;

  for (const candidate of idxCandidates) {
    processed += 1;
    deps.emit(context.onProgress, {
      phase: "parse",
      detail: `Reading ${candidate.normalizedPath}`,
      percent: context.progressStart + Math.round((processed / Math.max(1, total)) * (context.progressEnd - context.progressStart))
    });
    const bytes = await candidate.file.readBytes();
    if (!isBmcG3xIdx(bytes)) continue;
    inferMachine(bytes, context.machine);
    const parsedDays = parseBmcG3xIdxDays(bytes);
    days.push(...parsedDays);
    daysByBase.set(g3xFileBase(candidate.normalizedPath), parsedDays);
    applyLatestSettings(parsedDays, context.machine);
    for (const day of parsedDays) {
      records.set(day.dateIso, {
        date: day.date,
        usageHours: day.usageHours,
        ahi: day.ahi,
        residualApneas: day.residualApneas,
        centralApneas: day.centralApneas,
        reraIndex: day.reraIndex,
        pressure95th: day.pressure95th
      });
    }
  }

  const evtSessionsByDay = new Map<string, G3xSessionWindow[]>();
  const evtPressureByDay = new Map<string, G3xPressureSnapshots>();
  for (const candidate of evtCandidates) {
    processed += 1;
    try {
      const matchingDays = daysByBase.get(g3xFileBase(candidate.normalizedPath));
      if (!matchingDays) continue;
      const evt = applyEvtFallback(await candidate.file.readBytes(), matchingDays, records);
      for (const [dayIso, windows] of evt.sessionsByDay) {
        evtSessionsByDay.set(dayIso, [...(evtSessionsByDay.get(dayIso) ?? []), ...windows]);
      }
      for (const [dayIso, values] of evt.pressureByDay) {
        const existing = evtPressureByDay.get(dayIso) ?? { epaps: [], ipaps: [] };
        existing.epaps.push(...values.epaps);
        existing.ipaps.push(...values.ipaps);
        evtPressureByDay.set(dayIso, existing);
      }
    } catch {
      context.warnings.push(`Could not read ${candidate.normalizedPath}`);
    }
  }

  const samplesByDay = new Map<string, G3xWaveSample[]>();
  for (const candidate of waveformCandidates) {
    processed += 1;
    deps.emit(context.onProgress, {
      phase: "parse",
      detail: `Reading ${candidate.normalizedPath}`,
      percent: context.progressStart + Math.round((processed / Math.max(1, total)) * (context.progressEnd - context.progressStart))
    });
    try {
      const matchingDays = daysByBase.get(g3xFileBase(candidate.normalizedPath));
      if (!matchingDays) continue;
      const extension = Number(candidate.normalizedPath.match(/\.(\d{3})$/)?.[1] ?? "0");
      const parsed = parseWaveformSamples(await candidate.file.readBytes(), extension * G3X_WAVEFORM_FILE_SPAN, matchingDays);
      for (const [dayIso, values] of parsed) {
        const existing = samplesByDay.get(dayIso) ?? [];
        existing.push(...values);
        samplesByDay.set(dayIso, existing);
      }
    } catch {
      context.warnings.push(`Could not read ${candidate.normalizedPath}`);
    }
  }

  const timingRecords: ParsedRecord[] = [];
  for (const [dayIso, values] of evtPressureByDay) {
    if (samplesByDay.has(dayIso)) continue;
    const record = records.get(dayIso);
    if (!record) continue;
    // EVT 0x42 records are pressure changes, not evenly spaced samples. A
    // constant value is safe to summarize without waveform/session weighting.
    const epap = constantPressure(values.epaps);
    const ipap = constantPressure(values.ipaps);
    record.pressureAvg ??= ipap;
    record.pressure95th ??= ipap;
    record.epapAvg ??= epap;
    record.epap95th ??= epap;
    record.ipapAvg ??= ipap;
    record.ipap95th ??= ipap;
  }
  for (const [dayIso, sessions] of evtSessionsByDay) {
    if (samplesByDay.has(dayIso)) continue;
    const day = days.find((entry) => entry.dateIso === dayIso);
    if (!day) continue;
    for (const session of sessions) {
      timingRecords.push({
        date: day.date,
        therapySessionStart: new Date(session.startMs),
        therapySessionEnd: new Date(session.endMs)
      });
    }
  }
  for (const [dayIso, samples] of samplesByDay) {
    const record = records.get(dayIso);
    if (!record) continue;
    Object.assign(record, summarizeWaveSamples(samples));
    for (const session of splitMaskOnSessions(samples)) {
      const start = new Date(session.startMs);
      timingRecords.push({
        date: start,
        therapySessionStart: start,
        therapySessionEnd: new Date(session.endMs)
      });
    }
  }

  context.records.push(
    ...[...records.values(), ...timingRecords].sort((a, b) => a.date.getTime() - b.date.getTime())
  );
  if (!context.machine.device) context.machine.device = "ReactHealth / BMC G3X";
  if (context.records.length === 0) {
    context.warnings.push("BMC G3X structure was detected, but no valid IDX daily records were found.");
  }
}

export const BMC_G3X_LARGE_LEAK_THRESHOLD_LPM = LARGE_LEAK_THRESHOLD_LPM;
