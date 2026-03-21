import type { FamilyParserContext, FamilyParserDeps } from "@/lib/parsers/text-family-types";
import type { ParsedRecord } from "@/lib/types";

type IntelliPapAggregate = {
  date: Date;
  usageHours?: number;
  ahi?: number;
  residualApneas?: number;
  centralApneas?: number;
  reraIndex?: number;
  leak?: number;
  leakMax?: number;
  pressureAvg?: number;
  pressure95th?: number;
};

type Dv5Session = {
  start: number;
  end: number;
};

type Dv5Aggregate = {
  start: number;
  end: number;
  pressureSum: number;
  pressureCount: number;
  leakSum: number;
  leakCount: number;
  leakMax: number | null;
  obstructiveApneas: number;
  hypopneas: number;
  nriEvents: number;
};

const DV5_EPOCH_SECONDS = Date.UTC(2002, 0, 1, 0, 0, 0, 0) / 1000;
const DV6_MODEL_NAMES = new Map<string, string>([
  ["DV64D", "Blue StandardPlus"],
  ["DV64E", "Blue AutoPlus"],
  ["DV63E", "Blue (IntelliPAP 2) AutoPlus"]
]);

function be32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

function le32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function convertDv6Timestamp(bytes: Uint8Array, offset: number): Date | null {
  const seconds = le32(bytes, offset) + DV5_EPOCH_SECONDS;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatPressure(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  const rounded = Number(value.toFixed(1));
  return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)} cmH2O`;
}

function parseDv5Set1(text: string, machine: FamilyParserContext["machine"]) {
  const mapped = new Map<string, string>();
  const keyMap = new Map<string, string>([
    ["Sn", "serial"],
    ["Mn", "model"],
    ["Mo", "mode"],
    ["Pu", "maxPressure"],
    ["Pl", "minPressure"],
    ["Pi", "ipap"],
    ["Pe", "epap"],
    ["Ps", "ps"],
    ["Sf", "smartFlex"],
    ["Sm", "smartFlexMode"]
  ]);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [rawKey, rawValue] = line.split(/\t+/, 2);
    if (!rawKey || rawValue === undefined) continue;
    mapped.set(keyMap.get(rawKey.trim()) ?? rawKey.trim(), rawValue.trim());
  }

  const serial = mapped.get("serial");
  const model = mapped.get("model");
  if (!machine.device) {
    if (model && serial) machine.device = `${model} (${serial})`;
    else if (model) machine.device = model;
    else if (serial) machine.device = `IntelliPAP ${serial}`;
  }

  const papMode = Number(mapped.get("mode") ?? "");
  const epap = Number(mapped.get("epap") ?? "") / 10;
  const ipap = Number(mapped.get("ipap") ?? "") / 10;
  const ps = Number(mapped.get("ps") ?? "") / 10;
  const minPressure = Number(mapped.get("minPressure") ?? "") / 10;
  const maxPressure = Number(mapped.get("maxPressure") ?? "") / 10;
  const smartFlex = Number(mapped.get("smartFlex") ?? "");
  const smartFlexMode = Number(mapped.get("smartFlexMode") ?? "");

  if (!machine.mode) {
    if (papMode === 0) machine.mode = "CPAP";
    else if (papMode === 1 && epap > 0) machine.mode = "BiPAP";
    else if (papMode === 1) machine.mode = "APAP";
  }

  if (machine.mode === "CPAP") {
    machine.pressure = `Fixed ${formatPressure(maxPressure ?? minPressure) ?? ""}`.trim();
  } else if (machine.mode === "APAP") {
    machine.pressureIsAuto = true;
    machine.pressureMin = formatPressure(minPressure);
    machine.pressureMax = formatPressure(maxPressure);
  } else if (machine.mode === "BiPAP") {
    machine.epap = formatPressure(epap);
    machine.ipap = formatPressure(ipap || (epap > 0 && ps > 0 ? epap + ps : undefined));
  }

  if (!machine.pressureRelief && Number.isFinite(smartFlex) && smartFlex > 0) {
    const modeLabel = smartFlexMode === 0 ? "Full Time" : "Ramp Only";
    machine.pressureRelief = `SmartFlex: ${smartFlex} (${modeLabel})`;
  }
}

function parseDv5Sessions(bytes: Uint8Array): Dv5Session[] {
  const sessions: Dv5Session[] = [];
  for (let pos = 0; pos + 8 < bytes.length; pos += 9) {
    const start = be32(bytes, pos) + DV5_EPOCH_SECONDS;
    const end = be32(bytes, pos + 4) + DV5_EPOCH_SECONDS;
    if (start <= DV5_EPOCH_SECONDS || end <= start) continue;
    sessions.push({ start, end });
  }
  return sessions.sort((a, b) => a.start - b.start);
}

function parseDv5Records(bytes: Uint8Array, sessions: Dv5Session[]): IntelliPapAggregate[] {
  if (sessions.length === 0) return [];

  const aggregates: Dv5Aggregate[] = sessions.map((session) => ({
    start: session.start,
    end: session.end,
    pressureSum: 0,
    pressureCount: 0,
    leakSum: 0,
    leakCount: 0,
    leakMax: null,
    obstructiveApneas: 0,
    hypopneas: 0,
    nriEvents: 0
  }));

  let sessionIndex = 0;
  for (let pos = 0; pos + 26 <= bytes.length && sessionIndex < aggregates.length; pos += 26) {
    const timestamp = be32(bytes, pos) + DV5_EPOCH_SECONDS;
    while (sessionIndex < aggregates.length && timestamp > aggregates[sessionIndex].end) {
      sessionIndex += 1;
    }
    if (sessionIndex >= aggregates.length) break;
    const session = aggregates[sessionIndex];
    if (timestamp < session.start || timestamp > session.end) continue;

    const pressure = bytes[pos + 0x0d] / 10;
    const averageLeak = bytes[pos + 0x07];
    const maxLeak = bytes[pos + 0x06];

    session.pressureSum += pressure;
    session.pressureCount += 1;
    session.leakSum += averageLeak;
    session.leakCount += 1;
    if (session.leakMax === null || maxLeak > session.leakMax) session.leakMax = maxLeak;
    session.obstructiveApneas += bytes[pos + 0x10];
    session.hypopneas += bytes[pos + 0x11];
    session.nriEvents += bytes[pos + 0x12];
  }

  return aggregates.map((aggregate) => {
    const usageHours = (aggregate.end - aggregate.start) / 3600;
    const date = new Date(aggregate.start * 1000);
    const ahi = usageHours > 0 ? (aggregate.obstructiveApneas + aggregate.hypopneas) / usageHours : undefined;
    return {
      date,
      usageHours,
      ahi,
      residualApneas: usageHours > 0 ? aggregate.obstructiveApneas / usageHours : undefined,
      reraIndex: usageHours > 0 ? aggregate.nriEvents / usageHours : undefined,
      leak: aggregate.leakCount > 0 ? aggregate.leakSum / aggregate.leakCount : undefined,
      leakMax: aggregate.leakMax ?? undefined,
      pressureAvg: aggregate.pressureCount > 0 ? aggregate.pressureSum / aggregate.pressureCount : undefined
    };
  });
}

function parseDv6Version(bytes: Uint8Array, machine: FamilyParserContext["machine"]) {
  const parts = decodeString(bytes).split("\0").map((part) => part.trim()).filter(Boolean);
  const serial = parts[1];
  const modelNumber = parts[2];
  const model = modelNumber ? DV6_MODEL_NAMES.get(modelNumber) ?? modelNumber : "IntelliPAP DV6";
  if (!machine.device) {
    if (model && serial) machine.device = `${model} (${serial})`;
    else if (model) machine.device = model;
    else if (serial) machine.device = `IntelliPAP ${serial}`;
  }
}

function parseDv6Settings(bytes: Uint8Array, machine: FamilyParserContext["machine"]) {
  if (bytes.length < 30) return;
  const cpapPressure = bytes[15] / 10;
  const maxPressure = bytes[17] / 10;
  const minPressure = bytes[19] / 10;
  const smartFlex = bytes[25];
  const smartFlexWhen = bytes[26];

  if (!machine.mode) {
    if (Math.abs(maxPressure - minPressure) > 0.01) machine.mode = "APAP";
    else machine.mode = "CPAP";
  }

  if (machine.mode === "APAP") {
    machine.pressureIsAuto = true;
    machine.pressureMin = formatPressure(minPressure);
    machine.pressureMax = formatPressure(maxPressure);
  } else if (machine.mode === "CPAP") {
    machine.pressure = `Fixed ${formatPressure(cpapPressure ?? minPressure) ?? ""}`.trim();
  }

  if (!machine.pressureRelief && smartFlex > 0) {
    const modeLabel = smartFlexWhen === 0 ? "Full Time" : "Ramp Only";
    machine.pressureRelief = `SmartFlex: ${smartFlex} (${modeLabel})`;
  }
}

function parseDv6Summaries(bytes: Uint8Array, machine: FamilyParserContext["machine"]): IntelliPapAggregate[] {
  const records: IntelliPapAggregate[] = [];
  const recordSize = 55;

  for (let pos = 0; pos + recordSize <= bytes.length; pos += recordSize) {
    const start = convertDv6Timestamp(bytes, pos);
    if (!start) continue;
    const end = convertDv6Timestamp(bytes, pos + 4);
    const usageHours = bytes[pos + 12] / 10;
    if (usageHours <= 0 || usageHours > 24) continue;

    const pressureSetMin = bytes[pos + 48] / 10;
    const pressureSetMax = bytes[pos + 49] / 10;
    if (!machine.mode) {
      if (Math.abs(pressureSetMax - pressureSetMin) > 0.01) {
        machine.mode = "APAP";
        machine.pressureIsAuto = true;
        machine.pressureMin = formatPressure(pressureSetMin);
        machine.pressureMax = formatPressure(pressureSetMax);
      } else {
        machine.mode = "CPAP";
        machine.pressure = `Fixed ${formatPressure(pressureSetMin) ?? ""}`.trim();
      }
    }

    const oa = bytes[pos + 36] / 4;
    const ca = bytes[pos + 37] / 4;
    const hyp = bytes[pos + 38] / 4;
    records.push({
      date: start,
      usageHours,
      ahi: oa + ca + hyp,
      residualApneas: oa,
      centralApneas: ca,
      leak: bytes[pos + 21] / 10,
      leakMax: bytes[pos + 22] / 10,
      pressureAvg: bytes[pos + 14] / 10,
      pressure95th: bytes[pos + 18] / 10
    });

    void end;
  }

  return records;
}

function decodeString(bytes: Uint8Array): string {
  return new TextDecoder("ascii", { fatal: false }).decode(bytes);
}

export async function parseIntelliPapFamily(context: FamilyParserContext, deps: FamilyParserDeps): Promise<void> {
  const files = new Map<string, Uint8Array>();
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
      files.set(candidate.normalizedPath.toLowerCase(), await candidate.file.readBytes());
    } catch {
      continue;
    }

    if (processed % 4 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const dv5Set = [...files.entries()].find(([path]) => path.endsWith("/sl/set1"));
  const dv6Set = [...files.entries()].find(([path]) => path.endsWith("/dv6/set.bin"));

  if (dv5Set) {
    parseDv5Set1(decodeString(dv5Set[1]), context.machine);
    const uFile = [...files.entries()].find(([path]) => path.endsWith("/sl/u"));
    const lFile = [...files.entries()].find(([path]) => path.endsWith("/sl/l"));
    if (uFile && lFile) {
      const sessions = parseDv5Sessions(uFile[1]);
      context.records.push(...parseDv5Records(lFile[1], sessions));
    }
    return;
  }

  if (dv6Set) {
    parseDv6Settings(dv6Set[1], context.machine);
    const verFile = [...files.entries()].find(([path]) => path.endsWith("/dv6/ver.bin"));
    const summaryFile = [...files.entries()].find(([path]) => path.endsWith("/dv6/s.bin"));
    if (verFile) parseDv6Version(verFile[1], context.machine);
    if (summaryFile) context.records.push(...parseDv6Summaries(summaryFile[1], context.machine));
  }
}
