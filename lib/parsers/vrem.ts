import type { FamilyParserContext, FamilyParserDeps } from "@/lib/parsers/text-family-types";
import type { ParsedRecord, QuickReportMetrics } from "@/lib/types";

type VremProgramSession = {
  id: string;
  startMs: number;
  endMs: number;
  maxPressure?: number;
  minPressure?: number;
  rampPressure?: number;
  rampTime?: number;
  flex?: number;
  flexLevel?: number;
  maskType?: string;
  humidifier?: string;
  humidifierLevel?: string;
  modeCode?: number;
};

type VremAccumulator = {
  session: VremProgramSession;
  apneaCount: number;
  hypopneaCount: number;
  pressureSamples: number[];
  currentPressureRaw: number | null;
};

function decodeAscii(bytes: Uint8Array): string {
  return new TextDecoder("ascii", { fatal: false }).decode(bytes);
}

function le32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
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

function formatPressure(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const rounded = Number(value.toFixed(1));
  return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)} cmH2O`;
}

function parseProgramSessions(text: string): VremProgramSession[] {
  const sessions: VremProgramSession[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 13) continue;

    const startMs = Number(parts[1]);
    const endMs = Number(parts[2]);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs <= 0 || endMs <= startMs) continue;

    sessions.push({
      id: parts[0]?.trim() || String(startMs),
      startMs,
      endMs,
      maxPressure: Number(parts[3]),
      minPressure: Number(parts[4]),
      rampPressure: Number(parts[5]),
      rampTime: Number(parts[6]),
      flex: Number(parts[7]),
      flexLevel: Number(parts[8]),
      maskType: parts[9]?.trim() || undefined,
      humidifier: parts[10]?.trim() || undefined,
      humidifierLevel: parts[11]?.trim() || undefined,
      modeCode: Number(parts[12])
    });
  }
  return sessions.sort((a, b) => a.startMs - b.startMs);
}

function inferModel(text: string): string | undefined {
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return undefined;
  return firstLine.split("-")[0]?.trim() || undefined;
}

function determineMode(session: VremProgramSession): "CPAP" | "APAP" {
  if (session.modeCode === 1) return "CPAP";
  if (session.modeCode === 2 || session.modeCode === 3 || session.modeCode === 4) return "APAP";

  const minPressure = session.minPressure;
  const maxPressure = session.maxPressure;
  if (minPressure !== undefined && maxPressure !== undefined && Math.abs(maxPressure - minPressure) > 0.05) {
    return "APAP";
  }
  return "CPAP";
}

function applyMachineSettings(
  latest: VremProgramSession | undefined,
  machine: QuickReportMetrics["machine"],
  model: string | undefined,
  serial: string | undefined
) {
  if (model && serial) machine.device = `${model} (${serial})`;
  else if (model) machine.device = model;
  else if (serial) machine.device = `vREM (${serial})`;
  else if (!machine.device) machine.device = "vREM";

  if (!latest) return;

  const mode = determineMode(latest);
  machine.mode = mode;
  if (mode === "APAP") {
    machine.pressureIsAuto = true;
    machine.pressureMin = formatPressure(latest.minPressure);
    machine.pressureMax = formatPressure(latest.maxPressure);
  } else {
    machine.pressure = `Fixed ${formatPressure(latest.maxPressure ?? latest.minPressure) ?? ""}`.trim();
  }

  if (latest.rampTime !== undefined && Number.isFinite(latest.rampTime)) {
    machine.rampTime =
      latest.rampTime > 0
        ? `${latest.rampTime} ${latest.rampTime === 1 ? "minute" : "minutes"}`
        : "Off";
  }
  if (latest.rampPressure !== undefined && latest.rampPressure > 0 && !/^off$/i.test(machine.rampTime ?? "")) {
    machine.rampPressure = formatPressure(latest.rampPressure);
  }

  if ((latest.flex ?? 0) > 0 || (latest.flexLevel ?? 0) > 0) {
    const flexLevel = latest.flexLevel && latest.flexLevel > 0 ? `: ${latest.flexLevel}` : ": On";
    machine.pressureRelief = `Flex${flexLevel}`;
  }
}

function readEscapedPacket(bytes: Uint8Array, start: number, decodedLength: number): { packet: Uint8Array; nextIndex: number } | null {
  const out: number[] = [];
  let index = start;
  while (index < bytes.length && out.length < decodedLength) {
    const byte = bytes[index++];
    out.push(byte);
    if (byte === 0x7b && out.length < decodedLength && index < bytes.length && bytes[index] === 0x7b) {
      index += 1;
    }
  }
  if (out.length !== decodedLength) return null;
  return { packet: Uint8Array.from(out), nextIndex: index };
}

function findMatchingSession(startSeconds: number, sessions: VremProgramSession[]): VremProgramSession | undefined {
  const targetStartMs = startSeconds * 1000;
  return sessions.find((session) => session.startMs === targetStartMs && session.endMs > session.startMs);
}

function parseOdData(bytes: Uint8Array, sessions: VremProgramSession[]): Map<number, VremAccumulator> {
  const accumulators = new Map<number, VremAccumulator>();
  let current: VremAccumulator | null = null;

  for (let index = 0; index + 2 <= bytes.length; index += 1) {
    if (bytes[index] !== 0x7b) continue;
    const packetType = bytes[index + 1];

    if (packetType === 0x4f) {
      const decoded = readEscapedPacket(bytes, index, 9);
      if (!decoded) continue;
      const startSeconds = le32(decoded.packet, 2);
      const session = findMatchingSession(startSeconds, sessions);
      if (session) {
        const existing = accumulators.get(session.startMs);
        current =
          existing ?? {
            session,
            apneaCount: 0,
            hypopneaCount: 0,
            pressureSamples: [],
            currentPressureRaw: null
          };
        accumulators.set(session.startMs, current);
      } else {
        current = null;
      }
      index = decoded.nextIndex - 1;
      continue;
    }

    if (!current) continue;

    if (packetType === 0x41) {
      const decoded = readEscapedPacket(bytes, index, 9);
      if (!decoded) continue;
      current = null;
      index = decoded.nextIndex - 1;
      continue;
    }

    if (packetType === 0x46) {
      const decoded = readEscapedPacket(bytes, index, 29);
      if (!decoded) continue;
      if (current.currentPressureRaw !== null) current.pressureSamples.push(current.currentPressureRaw / 10);
      index = decoded.nextIndex - 1;
      continue;
    }

    if (packetType === 0x45 || packetType === 0x50) {
      const decoded = readEscapedPacket(bytes, index, 9);
      if (!decoded) continue;
      const value = decoded.packet[6] ?? 0;
      if (packetType === 0x50) {
        current.currentPressureRaw = value;
      } else if (packetType === 0x45) {
        if (value === 0x01) current.hypopneaCount += 1;
        else if (value === 0x02) current.apneaCount += 1;
      }
      index = decoded.nextIndex - 1;
      continue;
    }
  }

  return accumulators;
}

function toRecord(accumulator: VremAccumulator): ParsedRecord | null {
  const usageHours = (accumulator.session.endMs - accumulator.session.startMs) / 3_600_000;
  if (!Number.isFinite(usageHours) || usageHours <= 0 || usageHours > 24) return null;

  const date = new Date(accumulator.session.startMs);
  const pressureAvg =
    accumulator.pressureSamples.length > 0
      ? accumulator.pressureSamples.reduce((sum, value) => sum + value, 0) / accumulator.pressureSamples.length
      : undefined;
  const pressure95th = accumulator.pressureSamples.length > 0 ? percentile(accumulator.pressureSamples, 95) : undefined;
  const ahi = (accumulator.apneaCount + accumulator.hypopneaCount) / usageHours;

  return {
    date,
    usageHours,
    ahi,
    residualApneas: accumulator.apneaCount / usageHours,
    pressureAvg,
    pressure95th
  };
}

function extractSerialFromPaths(paths: string[]): string | undefined {
  for (const path of paths) {
    const match = /(?:^|\/)od([^/]+)(?:\/|$)/i.exec(path);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export async function parseVremFamily(context: FamilyParserContext, deps: FamilyParserDeps): Promise<void> {
  const fileBytes = new Map<string, Uint8Array>();
  let processed = 0;

  for (const candidate of context.candidates) {
    processed += 1;
    const pct =
      context.progressStart +
      Math.round((processed / Math.max(1, context.candidates.length)) * (context.progressEnd - context.progressStart));

    deps.emit(context.onProgress, {
      phase: "parse",
      detail: `Reading ${candidate.normalizedPath}`,
      percent: Math.min(context.progressEnd, pct)
    });

    try {
      fileBytes.set(candidate.normalizedPath.toLowerCase(), await candidate.file.readBytes());
    } catch {
      continue;
    }

    if (processed % 6 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const piEntry = [...fileBytes.entries()].find(([path]) => /(?:^|\/)pi\.txt$/i.test(path));
  const diEntry = [...fileBytes.entries()].find(([path]) => /(?:^|\/)di\.txt$/i.test(path));
  if (!piEntry) return;

  const sessions = parseProgramSessions(decodeAscii(piEntry[1]));
  const model = diEntry ? inferModel(decodeAscii(diEntry[1])) : undefined;
  const serial = extractSerialFromPaths([...fileBytes.keys()]);
  applyMachineSettings(sessions.at(-1), context.machine, model, serial);

  const accumulators = new Map<number, VremAccumulator>();
  const odFiles = [...fileBytes.entries()].filter(([path]) => /(?:^|\/)od[^/]+\/(?:od[^/]*|[^/]*\.bin)$/i.test(path));
  for (const [, bytes] of odFiles) {
    const parsed = parseOdData(bytes, sessions);
    for (const [key, value] of parsed.entries()) {
      const existing = accumulators.get(key);
      if (!existing) {
        accumulators.set(key, value);
        continue;
      }
      existing.apneaCount += value.apneaCount;
      existing.hypopneaCount += value.hypopneaCount;
      existing.pressureSamples.push(...value.pressureSamples);
      if (value.currentPressureRaw !== null) existing.currentPressureRaw = value.currentPressureRaw;
    }
  }

  for (const session of sessions) {
    const accumulator = accumulators.get(session.startMs) ?? {
      session,
      apneaCount: 0,
      hypopneaCount: 0,
      pressureSamples: [],
      currentPressureRaw: null
    };
    const record = toRecord(accumulator);
    if (record) context.records.push(record);
  }
}
