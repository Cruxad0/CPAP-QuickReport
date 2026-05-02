import type { FamilyParserContext, FamilyParserDeps } from "@/lib/parsers/text-family-types";
import type { ParsedRecord, QuickReportMetrics } from "@/lib/types";

const BMC_MODE_LABELS = new Map<number, string>([
  [0, "CPAP"],
  [1, "AutoCPAP"],
  [2, "S"],
  [3, "S/T"],
  [4, "T"],
  [5, "Titration"],
  [6, "AutoS"]
]);

const BMC_USR_SESSIONS_OFFSET = 0x102340;
const BMC_IDX_PACKET_SIZE = 0x200;
const BMC_IDX_PACKETS_OFFSET = 0x800;
const BMC_WAVEFORM_PACKET_SIZE = 0x100;
const BMC_WAVEFORM_30M_SECONDS = 30 * 60;
const BMC_WAVEFORM_60M_SECONDS = 60 * 60;
const BMC_WAVEFORM_RESET_GAP_MS = 2000;
const LARGE_LEAK_THRESHOLD_LPM = 30;

type BmcWaveformDayState = {
  date: Date;
  leakSum: number;
  leakCount: number;
  leakMax: number | null;
  leakMax30m: number | null;
  leakMax60m: number | null;
  currentLargeLeakSeconds: number;
  currentLargeLeakMax: number | null;
  longestLargeLeakSeconds: number;
  longestLargeLeakMax: number | null;
  maxLeakEpisodeValue: number | null;
  maxLeakEpisodeSeconds: number;
  pressureSum: number;
  pressureCount: number;
  pressureSeries: number[];
  lastTimestampMs: number | null;
  window30m: RollingAverageState;
  window60m: RollingAverageState;
};

type RollingAverageState = {
  values: Float64Array;
  capacity: number;
  nextIndex: number;
  length: number;
  sum: number;
};

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  const end = Math.min(bytes.length, start + length);
  let out = "";
  for (let i = start; i < end; i += 1) {
    const b = bytes[i];
    if (b === 0) break;
    if (b >= 32 && b <= 126) out += String.fromCharCode(b);
  }
  return out.trim();
}

function u16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function createUtcDateNoon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

function toIsoDate(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function contextLookbackDays(lookbackDays: number): number {
  return Number.isFinite(lookbackDays) && lookbackDays > 0 ? Math.trunc(lookbackDays) : 90;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const blend = idx - lo;
  return sorted[lo] * (1 - blend) + sorted[hi] * blend;
}

function createRollingAverageState(capacity: number): RollingAverageState {
  return {
    values: new Float64Array(capacity),
    capacity,
    nextIndex: 0,
    length: 0,
    sum: 0
  };
}

function resetRollingAverageState(state: RollingAverageState) {
  state.nextIndex = 0;
  state.length = 0;
  state.sum = 0;
}

function pushRollingAverage(state: RollingAverageState, value: number): number | null {
  if (state.length < state.capacity) {
    state.values[state.nextIndex] = value;
    state.sum += value;
    state.length += 1;
    state.nextIndex = (state.nextIndex + 1) % state.capacity;
  } else {
    state.sum -= state.values[state.nextIndex];
    state.values[state.nextIndex] = value;
    state.sum += value;
    state.nextIndex = (state.nextIndex + 1) % state.capacity;
  }

  if (state.length < state.capacity) return null;
  return state.sum / state.capacity;
}

function decodeBmcDate(encodedDate: number): Date | null {
  const year = 2000 + (encodedDate >> 9);
  const month = (encodedDate >> 5) & 0x0f;
  const day = encodedDate & 0x1f;
  const dt = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function toBmcClinicalDayIso(year: number, month: number, day: number, hour: number): string | null {
  const dt = createUtcDateNoon(year, month, day);
  if (Number.isNaN(dt.getTime())) return null;
  if (hour < 12) dt.setUTCDate(dt.getUTCDate() - 1);
  return toIsoDate(dt);
}

function formatCm(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return `${Number(value.toFixed(2)).toString()} cmH2O`;
}

type BmcIdxSettingsPacket = {
  timestamp: Date;
  modeCode: number;
  rampPressure: number;
  rampTimeMinutes: number;
  epap: number;
  maxPressure: number;
  ipap: number;
  reslex: number;
  reslexPatient: boolean;
  backupRR: boolean;
};

function inferBmcMachineInfo(bytes: Uint8Array, machine: QuickReportMetrics["machine"]) {
  const serial = readAscii(bytes, 0x2d, 32);
  const model = readAscii(bytes, 0x2296, 32);
  if (!machine.device) {
    if (model && serial) machine.device = `${model} (${serial})`;
    else if (model) machine.device = model;
    else if (serial) machine.device = `BMC ${serial}`;
  }
}

function parseBmcIdxSettingsPacket(bytes: Uint8Array): BmcIdxSettingsPacket | null {
  if (bytes.length < 0x166) return null;
  if (bytes[0] !== 0xaa || bytes[1] !== 0xaa) return null;

  const year = 2000 + (bytes[0x04] ?? 0);
  const month = bytes[0x05] ?? 0;
  const day = bytes[0x06] ?? 0;
  const timestamp = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  if (
    Number.isNaN(timestamp.getTime()) ||
    timestamp.getUTCFullYear() !== year ||
    timestamp.getUTCMonth() + 1 !== month ||
    timestamp.getUTCDate() !== day
  ) {
    return null;
  }

  const rampPressure = (bytes[0x140] ?? 0) / 2;
  const epap = (bytes[0x141] ?? 0) / 2;
  const rampTimeMinutes = bytes[0x142] ?? 0;
  const maxPressure = (bytes[0x14c] ?? 0) / 2;
  const pressureSupport = ((bytes[0x148] ?? 0) >> 2) / 2;
  const ipap = epap + pressureSupport;
  const modeCode = (bytes[0x14d] ?? 0) >> 4;
  const reslex = (bytes[0x148] ?? 0) & 0x03;
  const reslexPatient = ((bytes[0x151] ?? 0) & 0x80) !== 0;
  const backupRR = ((bytes[0x145] ?? 0) & 0x80) !== 0;

  return {
    timestamp,
    modeCode,
    rampPressure,
    rampTimeMinutes,
    epap,
    maxPressure,
    ipap,
    reslex,
    reslexPatient,
    backupRR
  };
}

function applyBmcSettingsPacket(packet: BmcIdxSettingsPacket, machine: QuickReportMetrics["machine"]) {
  const { modeCode, rampPressure, rampTimeMinutes, epap, maxPressure, ipap, reslex, reslexPatient, backupRR } = packet;
  const modeLabel = BMC_MODE_LABELS.get(modeCode);

  if (modeLabel) {
    if (modeCode === 0) machine.mode = "CPAP";
    else if (modeCode === 1) machine.mode = "APAP";
    else if (modeCode >= 2 && modeCode <= 6) machine.mode = "BiPAP";
  }

  if (machine.mode === "CPAP") {
    const pressure = formatCm(epap);
    if (pressure) machine.pressure = `Fixed ${pressure}`;
  } else if (machine.mode === "APAP") {
    machine.pressureIsAuto = true;
    machine.pressureMin = formatCm(epap);
    machine.pressureMax = formatCm(maxPressure);
  } else if (machine.mode === "BiPAP") {
    if (modeCode === 6) {
      const minIpap = formatCm(ipap);
      const maxIpap = formatCm(maxPressure);
      machine.epap = formatCm(epap);
      if (minIpap && maxIpap) machine.ipap = `${minIpap}-${maxIpap}`;
      else machine.ipap = maxIpap ?? minIpap;
    } else {
      machine.epap = formatCm(epap);
      machine.ipap = formatCm(ipap);
    }
    if (backupRR) {
      machine.respiratoryRate = "Backup RR enabled";
    }
  }

  if (!machine.pressureRelief) {
    if (reslex === 0) machine.pressureRelief = "Reslex: Off";
    else if (reslexPatient) machine.pressureRelief = "Reslex: Patient";
    else machine.pressureRelief = `Reslex: ${reslex}`;
  }

  if (!machine.rampTime) {
    if (rampTimeMinutes === 0) machine.rampTime = "Off";
    else if (rampTimeMinutes === 0xff) machine.rampTime = "Auto";
    else machine.rampTime = `${rampTimeMinutes} ${rampTimeMinutes === 1 ? "minute" : "minutes"}`;
  }
  if (!machine.rampPressure && !/^off$/i.test(machine.rampTime ?? "")) {
    const rampPressureText = formatCm(rampPressure);
    if (rampPressureText) machine.rampPressure = rampPressureText;
  }
}

function inferBmcSettingsFromIdx(bytes: Uint8Array, machine: QuickReportMetrics["machine"]) {
  let latestPacket: BmcIdxSettingsPacket | null = null;

  for (let offset = BMC_IDX_PACKETS_OFFSET; offset + BMC_IDX_PACKET_SIZE <= bytes.length; offset += BMC_IDX_PACKET_SIZE) {
    const packet = parseBmcIdxSettingsPacket(bytes.subarray(offset, offset + BMC_IDX_PACKET_SIZE));
    if (!packet) continue;
    if (!latestPacket || packet.timestamp > latestPacket.timestamp) {
      latestPacket = packet;
    }
  }

  if (!latestPacket && bytes.length >= BMC_IDX_PACKET_SIZE) {
    latestPacket = parseBmcIdxSettingsPacket(bytes.subarray(0, BMC_IDX_PACKET_SIZE));
  }

  if (latestPacket) {
    applyBmcSettingsPacket(latestPacket, machine);
  }
}

function createBmcWaveformDayState(dayIso: string): BmcWaveformDayState {
  return {
    date: new Date(`${dayIso}T12:00:00Z`),
    leakSum: 0,
    leakCount: 0,
    leakMax: null,
    leakMax30m: null,
    leakMax60m: null,
    currentLargeLeakSeconds: 0,
    currentLargeLeakMax: null,
    longestLargeLeakSeconds: 0,
    longestLargeLeakMax: null,
    maxLeakEpisodeValue: null,
    maxLeakEpisodeSeconds: 0,
    pressureSum: 0,
    pressureCount: 0,
    pressureSeries: [],
    lastTimestampMs: null,
    window30m: createRollingAverageState(BMC_WAVEFORM_30M_SECONDS),
    window60m: createRollingAverageState(BMC_WAVEFORM_60M_SECONDS)
  };
}

function resetBmcLeakWindows(state: BmcWaveformDayState) {
  finishBmcLargeLeakEpisode(state);
  resetRollingAverageState(state.window30m);
  resetRollingAverageState(state.window60m);
}

function finishBmcLargeLeakEpisode(state: BmcWaveformDayState) {
  if (state.currentLargeLeakSeconds <= 0 || state.currentLargeLeakMax === null) return;
  if (
    state.currentLargeLeakSeconds > state.longestLargeLeakSeconds ||
    (state.currentLargeLeakSeconds === state.longestLargeLeakSeconds &&
      (state.longestLargeLeakMax === null || state.currentLargeLeakMax > state.longestLargeLeakMax))
  ) {
    state.longestLargeLeakSeconds = state.currentLargeLeakSeconds;
    state.longestLargeLeakMax = state.currentLargeLeakMax;
  }
  if (
    state.maxLeakEpisodeValue === null ||
    state.currentLargeLeakMax > state.maxLeakEpisodeValue ||
    (state.currentLargeLeakMax === state.maxLeakEpisodeValue &&
      state.currentLargeLeakSeconds > state.maxLeakEpisodeSeconds)
  ) {
    state.maxLeakEpisodeValue = state.currentLargeLeakMax;
    state.maxLeakEpisodeSeconds = state.currentLargeLeakSeconds;
  }
  state.currentLargeLeakSeconds = 0;
  state.currentLargeLeakMax = null;
}

function pushBmcLeakWindow(state: BmcWaveformDayState, leak: number) {
  const average30m = pushRollingAverage(state.window30m, leak);
  if (average30m !== null) {
    state.leakMax30m = state.leakMax30m === null ? average30m : Math.max(state.leakMax30m, average30m);
  }

  const average60m = pushRollingAverage(state.window60m, leak);
  if (average60m !== null) {
    state.leakMax60m = state.leakMax60m === null ? average60m : Math.max(state.leakMax60m, average60m);
  }
}

function parseBmcWaveformRecords(
  waveformFiles: Array<{ path: string; bytes: Uint8Array }>,
  validDayIsoSet: Set<string>
): ParsedRecord[] {
  if (waveformFiles.length === 0 || validDayIsoSet.size === 0) return [];

  const states = new Map<string, BmcWaveformDayState>();

  for (const waveformFile of waveformFiles) {
    const bytes = waveformFile.bytes;

    for (let offset = 0; offset + BMC_WAVEFORM_PACKET_SIZE <= bytes.length; offset += BMC_WAVEFORM_PACKET_SIZE) {
      if (u16(bytes, offset) !== 0xaaaa) continue;

      const year = u16(bytes, offset + 0xf8);
      const month = bytes[offset + 0xfa] ?? 0;
      const day = bytes[offset + 0xfb] ?? 0;
      const hour = bytes[offset + 0xfc] ?? 0;
      const minute = bytes[offset + 0xfd] ?? 0;
      const second = bytes[offset + 0xfe] ?? 0;

      if (
        year < 2000 ||
        year > 2100 ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 31 ||
        hour > 23 ||
        minute > 59 ||
        second > 59
      ) {
        continue;
      }

      const clinicalDayIso = toBmcClinicalDayIso(year, month, day, hour);
      if (!clinicalDayIso || !validDayIsoSet.has(clinicalDayIso)) continue;

      const timestamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));
      const timestampMs = timestamp.getTime();
      if (!Number.isFinite(timestampMs)) continue;

      const state = states.get(clinicalDayIso) ?? createBmcWaveformDayState(clinicalDayIso);
      if (!states.has(clinicalDayIso)) states.set(clinicalDayIso, state);

      if (state.lastTimestampMs !== null) {
        const deltaMs = timestampMs - state.lastTimestampMs;
        if (deltaMs === 0) {
          continue;
        }
        if (deltaMs < 0 || deltaMs > BMC_WAVEFORM_RESET_GAP_MS) {
          resetBmcLeakWindows(state);
        }
      }
      state.lastTimestampMs = timestampMs;

      const leak = u16(bytes, offset + 0xc4) / 10;
      if (Number.isFinite(leak) && leak >= 0 && leak < 500) {
        state.leakSum += leak;
        state.leakCount += 1;
        state.leakMax = state.leakMax === null ? leak : Math.max(state.leakMax, leak);
        if (leak > LARGE_LEAK_THRESHOLD_LPM) {
          state.currentLargeLeakSeconds += 1;
          state.currentLargeLeakMax = state.currentLargeLeakMax === null ? leak : Math.max(state.currentLargeLeakMax, leak);
        } else {
          finishBmcLargeLeakEpisode(state);
        }
        pushBmcLeakWindow(state, leak);
      } else {
        resetBmcLeakWindows(state);
      }

      const rawIpap = u16(bytes, offset + 0x04);
      const rawEpap = u16(bytes, offset + 0x06);
      const pressure = Math.max(rawIpap, rawEpap) / 2;
      if (Number.isFinite(pressure) && pressure >= 0 && pressure <= 80) {
        state.pressureSum += pressure;
        state.pressureCount += 1;
        state.pressureSeries.push(pressure);
      }
    }
  }

  const records: ParsedRecord[] = [];
  for (const state of states.values()) {
    finishBmcLargeLeakEpisode(state);
    records.push({
      date: state.date,
      leak: state.leakCount > 0 ? state.leakSum / state.leakCount : undefined,
      leakMax: state.leakMax ?? undefined,
      leakMax30m: state.leakMax30m ?? undefined,
      leakMax60m: state.leakMax60m ?? undefined,
      maxLeakMinutes: state.maxLeakEpisodeSeconds > 0 ? state.maxLeakEpisodeSeconds / 60 : undefined,
      sustainedLeakMax: state.longestLargeLeakMax ?? undefined,
      sustainedLeakMinutes: state.longestLargeLeakSeconds > 0 ? state.longestLargeLeakSeconds / 60 : undefined,
      pressureAvg: state.pressureCount > 0 ? state.pressureSum / state.pressureCount : undefined,
      pressure95th: state.pressureSeries.length > 0 ? percentile(state.pressureSeries, 95) : undefined
    });
  }

  return records;
}

export function parseBmcHistoricSession(sessionBytes: Uint8Array): ParsedRecord | null {
  if (sessionBytes.length < 0x45 || sessionBytes[0] !== 0xe1) return null;

  const startDate = decodeBmcDate(u16(sessionBytes, 0x07));
  if (!startDate) return null;

  const durationMinutes = u16(sessionBytes, 0x0f);
  const usageHours = durationMinutes > 0 ? durationMinutes / 60 : undefined;

  let pos = 0x45;
  while (pos + 5 <= sessionBytes.length) {
    const type = sessionBytes[pos];
    pos += 5;
    if (type === 0xff) break;
  }

  let obstructiveApneas = 0;
  let hypopneas = 0;
  let centralApneas = 0;

  while (pos + 5 <= sessionBytes.length) {
    const msgType = sessionBytes[pos];
    const count = u16(sessionBytes, pos + 1);
    pos += 5;

    if (msgType === 0x83 || msgType === 0x84 || msgType === 0x87) {
      if (pos + count * 3 > sessionBytes.length) break;
      if (msgType === 0x83) obstructiveApneas += count;
      else if (msgType === 0x84) hypopneas += count;
      else if (msgType === 0x87) centralApneas += count;
      pos += count * 3;
      continue;
    }

    if (msgType === 0x82 || msgType === 0x86) {
      if (pos + count * 4 > sessionBytes.length) break;
      pos += count * 4;
      continue;
    }

    if (pos + count * 2 > sessionBytes.length) break;
    pos += count * 2;
  }

  const ahi = usageHours && usageHours > 0 ? (obstructiveApneas + centralApneas + hypopneas) / usageHours : undefined;
  return {
    date: startDate,
    usageHours: usageHours && usageHours > 0 && usageHours <= 24 ? usageHours : undefined,
    ahi,
    residualApneas: usageHours && usageHours > 0 ? obstructiveApneas / usageHours : undefined,
    centralApneas: usageHours && usageHours > 0 ? centralApneas / usageHours : undefined
  };
}

function parseBmcUsrRecords(bytes: Uint8Array): ParsedRecord[] {
  if (bytes.length <= BMC_USR_SESSIONS_OFFSET) return [];

  const records: ParsedRecord[] = [];
  let pos = BMC_USR_SESSIONS_OFFSET;

  while (pos < bytes.length) {
    const next = u32(bytes, pos + 1);
    let sliceEnd = next;
    if (sliceEnd === 0 || sliceEnd === 0xffffffff || sliceEnd <= pos || sliceEnd > bytes.length) {
      sliceEnd = bytes.length;
    }
    if (sliceEnd <= pos) break;

    const session = parseBmcHistoricSession(bytes.subarray(pos, sliceEnd));
    if (session) records.push(session);

    if (sliceEnd === bytes.length) break;
    pos = sliceEnd;
  }

  return records;
}

function collectRecentBmcDayIsoSet(records: ParsedRecord[], lookbackDays: number): Set<string> {
  if (records.length === 0) return new Set();

  const latest = records.reduce((acc, record) => {
    const clinicalDay = createUtcDateNoon(record.date.getUTCFullYear(), record.date.getUTCMonth() + 1, record.date.getUTCDate());
    return clinicalDay > acc ? clinicalDay : acc;
  }, createUtcDateNoon(records[0].date.getUTCFullYear(), records[0].date.getUTCMonth() + 1, records[0].date.getUTCDate()));
  const windowEnd = addUtcDays(latest, 1);
  const windowStart = addUtcDays(windowEnd, -contextLookbackDays(lookbackDays));

  const recentDays = new Set<string>();
  for (const record of records) {
    const clinicalDay = createUtcDateNoon(record.date.getUTCFullYear(), record.date.getUTCMonth() + 1, record.date.getUTCDate());
    if (clinicalDay >= windowStart && clinicalDay < windowEnd) {
      recentDays.add(toIsoDate(clinicalDay));
    }
  }
  return recentDays;
}

export async function parseBmcFamily(context: FamilyParserContext, deps: FamilyParserDeps): Promise<void> {
  const validDayIsoSet = new Set<string>();
  const usrCandidates = context.candidates.filter((candidate) => candidate.normalizedPath.toLowerCase().endsWith(".usr"));
  const idxCandidates = context.candidates.filter((candidate) => candidate.normalizedPath.toLowerCase().endsWith(".idx"));
  const waveformCandidates = context.candidates.filter((candidate) => /\.\d{3}$/i.test(candidate.normalizedPath));
  const primaryCandidates = [...usrCandidates, ...idxCandidates];
  let processed = 0;
  const totalWork = primaryCandidates.length + waveformCandidates.length;

  for (const candidate of primaryCandidates) {
    processed += 1;
    const pct =
      context.progressStart +
      Math.round((processed / Math.max(1, totalWork)) * (context.progressEnd - context.progressStart));

    deps.emit(context.onProgress, {
      phase: "parse",
      detail: `Reading ${candidate.normalizedPath}`,
      percent: Math.min(context.progressEnd, pct)
    });

    try {
      const lowerPath = candidate.normalizedPath.toLowerCase();
      const bytes = await candidate.file.readBytes();

      if (lowerPath.endsWith(".usr")) {
        inferBmcMachineInfo(bytes, context.machine);
        const parsedRecords = parseBmcUsrRecords(bytes);
        for (const record of parsedRecords) {
          validDayIsoSet.add(toIsoDate(record.date));
        }
        context.records.push(...parsedRecords);
      } else if (lowerPath.endsWith(".idx")) {
        inferBmcSettingsFromIdx(bytes, context.machine);
      }
    } catch {
      continue;
    }

    if (processed % 4 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const recentDayIsoSet = collectRecentBmcDayIsoSet(context.records, context.lookbackDays);
  if (recentDayIsoSet.size > 0) {
    validDayIsoSet.clear();
    for (const dayIso of recentDayIsoSet) validDayIsoSet.add(dayIso);
  }

  if (waveformCandidates.length > 0 && validDayIsoSet.size > 0) {
    const waveformFiles: Array<{ path: string; bytes: Uint8Array }> = [];
    for (const candidate of waveformCandidates) {
      processed += 1;
      const pct =
        context.progressStart +
        Math.round((processed / Math.max(1, totalWork)) * (context.progressEnd - context.progressStart));

      deps.emit(context.onProgress, {
        phase: "parse",
        detail: `Reading ${candidate.normalizedPath}`,
        percent: Math.min(context.progressEnd, pct)
      });

      try {
        waveformFiles.push({
          path: candidate.normalizedPath.toLowerCase(),
          bytes: await candidate.file.readBytes()
        });
      } catch {
        continue;
      }

      if (processed % 4 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    waveformFiles.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    deps.emit(context.onProgress, {
      phase: "parse",
      detail: "Reading Luna II waveform and leak data...",
      percent: Math.min(context.progressEnd, context.progressStart + Math.round((context.progressEnd - context.progressStart) * 0.95))
    });
    context.records.push(...parseBmcWaveformRecords(waveformFiles, validDayIsoSet));
  }
}
