import { runTextFamilyParser } from "@/lib/parsers/text-family-runner";
import type { FamilyParserCandidate, FamilyParserContext, FamilyParserDeps } from "@/lib/parsers/text-family-types";
import type { ParsedRecord, QuickReportMetrics } from "@/lib/types";

const RESMED_MODE_BY_CODE = new Map<string, string>([
  ["0", "CPAP"],
  ["1", "APAP"],
  ["2", "BiPAP"],
  ["3", "BiPAP"],
  ["4", "BiPAP"],
  ["5", "BiPAP"],
  ["6", "BiPAP"],
  ["7", "BiPAP"],
  ["8", "BiPAP"],
  ["9", "BiPAP"],
  ["10", "BiPAP"],
  ["11", "APAP"]
]);

const RESMED_DEVICE_HINTS: Array<[RegExp, string]> = [
  [/\bairsense\s*11\b/i, "AirSense 11"],
  [/\baircurve\s*11\b/i, "AirCurve 11"],
  [/\bairsense\s*10\b/i, "AirSense 10"],
  [/\baircurve\s*10\b/i, "AirCurve 10"],
  [/\bsleepmate\s*10\b/i, "Sleepmate 10"],
  [/\bs9\b/i, "S9"]
];

type EdfSignal = {
  label: string;
  normalizedLabel: string;
  physicalMin: number;
  physicalMax: number;
  digitalMin: number;
  digitalMax: number;
  samplesPerRecord: number;
  recordSampleOffset: number;
};

type EdfInfo = {
  headerBytes: number;
  numRecords: number;
  startDate: Date;
  signals: EdfSignal[];
  bytesPerRecord: number;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/[_\s]+/g, " ").trim();
}

function readCaseInsensitive(map: Map<string, string>, keys: string[]): string | undefined {
  const lower = new Map<string, string>();
  for (const [key, value] of map.entries()) lower.set(key.toLowerCase(), value);
  for (const key of keys) {
    const hit = map.get(key) ?? lower.get(key.toLowerCase());
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function inferModeFromResMedName(name: string): "CPAP" | "APAP" | "BiPAP" | null {
  if (/\b(?:autoset|auto for her)\b/i.test(name)) return "APAP";
  if (/\b(?:aircurve|vpap|vauto|asv|autosv|ivaps|lumis|bilevel|bi[- ]?level|st-a|st)\b/i.test(name)) return "BiPAP";
  if (/\b(?:cpap|elite)\b/i.test(name)) return "CPAP";
  return null;
}

function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim().toLowerCase();
}

function parseAsciiField(bytes: Uint8Array, start: number, length: number): string {
  return new TextDecoder("ascii", { fatal: false }).decode(bytes.subarray(start, start + length)).trim();
}

function parseAsciiNumber(bytes: Uint8Array, start: number, length: number): number | null {
  const raw = parseAsciiField(bytes, start, length).replace(/\0/g, "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseEdfStartDate(raw: string): Date | null {
  const match = raw.match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const yy = Number(match[3]);
  const year = yy >= 70 ? 1900 + yy : 2000 + yy;
  const dt = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function parseResMedEdf(bytes: Uint8Array): EdfInfo | null {
  if (bytes.length < 256) return null;

  const headerBytes = parseAsciiNumber(bytes, 184, 8);
  const numRecords = parseAsciiNumber(bytes, 236, 8);
  const numSignals = parseAsciiNumber(bytes, 252, 4);
  const startDate = parseEdfStartDate(parseAsciiField(bytes, 168, 8));
  if (!headerBytes || !numRecords || !numSignals || !startDate) return null;
  if (headerBytes <= 0 || numRecords <= 0 || numSignals <= 0 || headerBytes > bytes.length) return null;

  const labelsStart = 256;
  const transducerStart = labelsStart + numSignals * 16;
  const physDimStart = transducerStart + numSignals * 80;
  const physMinStart = physDimStart + numSignals * 8;
  const physMaxStart = physMinStart + numSignals * 8;
  const digMinStart = physMaxStart + numSignals * 8;
  const digMaxStart = digMinStart + numSignals * 8;
  const prefilterStart = digMaxStart + numSignals * 8;
  const samplesStart = prefilterStart + numSignals * 80;
  const reservedStart = samplesStart + numSignals * 8;
  if (reservedStart + numSignals * 32 > headerBytes) return null;

  const signals: EdfSignal[] = [];
  let recordSampleOffset = 0;
  for (let i = 0; i < numSignals; i += 1) {
    const label = parseAsciiField(bytes, labelsStart + i * 16, 16);
    const physicalMin = parseAsciiNumber(bytes, physMinStart + i * 8, 8) ?? 0;
    const physicalMax = parseAsciiNumber(bytes, physMaxStart + i * 8, 8) ?? 0;
    const digitalMin = parseAsciiNumber(bytes, digMinStart + i * 8, 8) ?? -32768;
    const digitalMax = parseAsciiNumber(bytes, digMaxStart + i * 8, 8) ?? 32767;
    const samplesPerRecord = parseAsciiNumber(bytes, samplesStart + i * 8, 8) ?? 0;
    if (!label || samplesPerRecord <= 0) {
      recordSampleOffset += Math.max(0, samplesPerRecord);
      continue;
    }

    signals.push({
      label,
      normalizedLabel: normalizeLabel(label),
      physicalMin,
      physicalMax,
      digitalMin,
      digitalMax,
      samplesPerRecord,
      recordSampleOffset
    });
    recordSampleOffset += samplesPerRecord;
  }

  const bytesPerRecord = recordSampleOffset * 2;
  if (bytesPerRecord <= 0) return null;
  if (headerBytes + bytesPerRecord * numRecords > bytes.length) return null;

  return { headerBytes, numRecords, startDate, signals, bytesPerRecord };
}

function findSignal(edf: EdfInfo, aliases: string[]): EdfSignal | null {
  const normalizedAliases = aliases.map((alias) => normalizeLabel(alias));
  for (const alias of normalizedAliases) {
    const match = edf.signals.find((signal) => signal.normalizedLabel === alias);
    if (match) return match;
  }
  return null;
}

function readSignalValue(bytes: Uint8Array, edf: EdfInfo, signal: EdfSignal | null, recordIndex: number, sampleIndex = 0): number | undefined {
  if (!signal) return undefined;
  if (recordIndex < 0 || recordIndex >= edf.numRecords) return undefined;
  if (sampleIndex < 0 || sampleIndex >= signal.samplesPerRecord) return undefined;

  const sampleOffset =
    edf.headerBytes +
    recordIndex * edf.bytesPerRecord +
    (signal.recordSampleOffset + sampleIndex) * 2;
  if (sampleOffset + 2 > bytes.length) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const raw = view.getInt16(sampleOffset, true);
  const digitalSpan = signal.digitalMax - signal.digitalMin;
  if (digitalSpan === 0) return raw;

  const gain = (signal.physicalMax - signal.physicalMin) / digitalSpan;
  const offset = signal.physicalMin - signal.digitalMin * gain;
  const value = raw * gain + offset;
  return Number.isFinite(value) ? value : undefined;
}

function readResMedValue(bytes: Uint8Array, edf: EdfInfo, aliases: string[], recordIndex: number): number | undefined {
  return readSignalValue(bytes, edf, findSignal(edf, aliases), recordIndex);
}

function normalizeUsageHours(raw: number | undefined): number | undefined {
  if (raw === undefined || !Number.isFinite(raw) || raw < 0) return undefined;
  if (raw <= 24) return raw;
  if (raw <= 24 * 60) return raw / 60;
  return undefined;
}

function mapResMedModeCode(modeCode: number | undefined, device: string | undefined): "CPAP" | "APAP" | "BiPAP" | null {
  if (modeCode === undefined || !Number.isFinite(modeCode)) return null;
  const isSeries11 = /\b(?:airsense|aircurve)\s*11\b/i.test(device ?? "");
  if (isSeries11) {
    switch (modeCode) {
      case 1:
      case 2:
        return "APAP";
      case 3:
        return "CPAP";
      case 4:
      case 6:
      case 7:
      case 8:
        return "BiPAP";
      default:
        return null;
    }
  }

  switch (modeCode) {
    case 0:
      return "CPAP";
    case 1:
    case 11:
      return "APAP";
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
    case 7:
    case 8:
    case 9:
    case 12:
      return "BiPAP";
    default:
      return null;
  }
}

function formatPressureValue(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0 || value > 80) return undefined;
  return `${Number(value.toFixed(2)).toString()} cmH2O`;
}

function parseResMedStrEdf(
  candidate: FamilyParserCandidate,
  bytes: Uint8Array,
  machine: QuickReportMetrics["machine"]
): ParsedRecord[] {
  if (!/str\.edf$/i.test(candidate.baseName)) return [];

  const edf = parseResMedEdf(bytes);
  if (!edf) return [];

  const modeSignal = findSignal(edf, ["Mode"]);
  const usageAliases = ["Mask Dur", "Duration"];
  const ahiAliases = ["AHI"];
  const residualAliases = ["AI"];
  const centralAliases = ["CAI"];
  const reraAliases = ["RERA"];
  const leakMaxAliases = ["Leak Max", "Leak.Max"];
  const pressure95Aliases = ["MaskPress.95", "Mask Pres 95"];
  const setPressureAliases = ["Set Pressure", "S.C.Press"];
  const minPressureAliases = ["Min Pressure", "S.AS.MinPress", "S.A.MinPress", "S.AFH.MinPress"];
  const maxPressureAliases = ["Max Pressure", "S.AS.MaxPress", "S.A.MaxPress", "S.AFH.MaxPress"];
  const epapAliases = ["EPAP", "Exp Pres Med"];
  const minEpapAliases = ["Min EPAP", "S.VA.MinEPAP"];
  const maxEpapAliases = ["Max EPAP"];
  const ipapAliases = ["IPAP", "Insp Pres Med"];
  const minIpapAliases = ["Min IPAP"];
  const maxIpapAliases = ["Max IPAP", "S.VA.MaxIPAP"];
  const psAliases = ["PS", "S.VA.PS"];

  const records: ParsedRecord[] = [];
  let latestRecordDate: Date | null = null;

  for (let recordIndex = 0; recordIndex < edf.numRecords; recordIndex += 1) {
    const date = new Date(edf.startDate);
    date.setUTCDate(date.getUTCDate() + recordIndex);

    const usageHours = normalizeUsageHours(readResMedValue(bytes, edf, usageAliases, recordIndex));
    const ahi = readResMedValue(bytes, edf, ahiAliases, recordIndex);
    const residualApneas = readResMedValue(bytes, edf, residualAliases, recordIndex);
    const centralApneas = readResMedValue(bytes, edf, centralAliases, recordIndex);
    const reraIndex = readResMedValue(bytes, edf, reraAliases, recordIndex);
    const leakMax = readResMedValue(bytes, edf, leakMaxAliases, recordIndex);
    const pressure95th = readResMedValue(bytes, edf, pressure95Aliases, recordIndex);

    const hasSignal =
      (usageHours !== undefined && usageHours >= 0 && usageHours <= 24) ||
      (ahi !== undefined && ahi >= 0 && ahi < 200) ||
      (residualApneas !== undefined && residualApneas >= 0 && residualApneas < 200) ||
      (centralApneas !== undefined && centralApneas >= 0 && centralApneas < 200) ||
      (reraIndex !== undefined && reraIndex >= 0 && reraIndex < 200) ||
      (leakMax !== undefined && leakMax >= 0 && leakMax < 500) ||
      (pressure95th !== undefined && pressure95th >= 0 && pressure95th <= 80);
    if (!hasSignal) continue;

    records.push({
      date,
      usageHours,
      ahi: ahi !== undefined && ahi >= 0 && ahi < 200 ? ahi : undefined,
      residualApneas: residualApneas !== undefined && residualApneas >= 0 && residualApneas < 200 ? residualApneas : undefined,
      centralApneas: centralApneas !== undefined && centralApneas >= 0 && centralApneas < 200 ? centralApneas : undefined,
      reraIndex: reraIndex !== undefined && reraIndex >= 0 && reraIndex < 200 ? reraIndex : undefined,
      leakMax: leakMax !== undefined && leakMax >= 0 && leakMax < 500 ? leakMax : undefined,
      pressure95th: pressure95th !== undefined && pressure95th >= 0 && pressure95th <= 80 ? pressure95th : undefined
    });

    if (!latestRecordDate || date > latestRecordDate) {
      latestRecordDate = date;
      const modeCode = readSignalValue(bytes, edf, modeSignal, recordIndex);
      const mappedMode = mapResMedModeCode(modeCode, machine.device);
      if (mappedMode) machine.mode = mappedMode;

      const setPressure = readResMedValue(bytes, edf, setPressureAliases, recordIndex);
      const minPressure = readResMedValue(bytes, edf, minPressureAliases, recordIndex);
      const maxPressure = readResMedValue(bytes, edf, maxPressureAliases, recordIndex);
      const epap = readResMedValue(bytes, edf, epapAliases, recordIndex);
      const minEpap = readResMedValue(bytes, edf, minEpapAliases, recordIndex);
      const maxEpap = readResMedValue(bytes, edf, maxEpapAliases, recordIndex);
      const ipap = readResMedValue(bytes, edf, ipapAliases, recordIndex);
      const minIpap = readResMedValue(bytes, edf, minIpapAliases, recordIndex);
      const maxIpap = readResMedValue(bytes, edf, maxIpapAliases, recordIndex);
      const ps = readResMedValue(bytes, edf, psAliases, recordIndex);

      if (machine.mode === "CPAP" && setPressure !== undefined) {
        const fixed = formatPressureValue(setPressure);
        if (fixed) machine.pressure = `Fixed ${fixed}`;
      } else if (machine.mode === "APAP") {
        machine.pressureIsAuto = true;
        if (minPressure !== undefined) machine.pressureMin = formatPressureValue(minPressure);
        if (maxPressure !== undefined) machine.pressureMax = formatPressureValue(maxPressure);
      } else if (machine.mode === "BiPAP") {
        const epapText = formatPressureValue(epap);
        const minEpapText = formatPressureValue(minEpap);
        const maxEpapText = formatPressureValue(maxEpap);
        const ipapText = formatPressureValue(ipap);
        const minIpapText = formatPressureValue(minIpap);
        const maxIpapText = formatPressureValue(maxIpap);

        if (epapText) machine.epap = epapText;
        else if (minEpapText && maxEpapText) machine.epap = `${minEpapText}-${maxEpapText}`;
        else machine.epap = minEpapText ?? maxEpapText;

        if (ipapText) machine.ipap = ipapText;
        else if (minIpapText && maxIpapText) machine.ipap = `${minIpapText}-${maxIpapText}`;
        else machine.ipap = minIpapText ?? maxIpapText;

        if (!machine.pressureRelief && ps !== undefined) {
          const psText = formatPressureValue(ps);
          if (psText) machine.pressureRelief = `PS: ${psText}`;
        }
      }
    }
  }

  return records;
}

function scanProductObject(text: string, machine: QuickReportMetrics["machine"]) {
  let product: Record<string, unknown> | null = null;
  try {
    product = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }

  const productName = typeof product.ProductName === "string" ? normalizeWhitespace(product.ProductName) : "";
  if (productName) {
    if (!machine.device) machine.device = productName;
    if (!machine.mode) {
      const inferred = inferModeFromResMedName(productName);
      if (inferred) machine.mode = inferred;
    }
  }
}

function scanIdentLines(text: string, machine: QuickReportMetrics["machine"]) {
  let productName = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("#PNA ")) {
      productName = normalizeWhitespace(line.slice(5));
      break;
    }
  }

  if (productName) {
    if (!machine.device) machine.device = productName;
    if (!machine.mode) {
      const inferred = inferModeFromResMedName(productName);
      if (inferred) machine.mode = inferred;
    }
  }
}

function inferResMedMachineSettings(
  text: string,
  _candidate: FamilyParserCandidate,
  machine: QuickReportMetrics["machine"],
  deps: FamilyParserDeps
) {
  scanProductObject(text, machine);
  scanIdentLines(text, machine);

  const kv = deps.parseKeyValueLines(text);
  const modeRaw = readCaseInsensitive(kv, ["RMS9_Mode", "Mode", "therapy mode", "CPAPModeChannel"]);

  if (!machine.mode && modeRaw) {
    const normalized = modeRaw.trim();
    machine.mode = RESMED_MODE_BY_CODE.get(normalized) ?? normalized;
  }

  if (!machine.mode) {
    if (/\b(?:autoset|auto for her)\b/i.test(text)) machine.mode = "APAP";
    else if (/\b(?:aircurve|vpap|vauto|asv|autosv|ivaps|lumis|bilevel|bi[- ]?level|st-a|st)\b/i.test(text)) machine.mode = "BiPAP";
    else if (/\b(?:cpap|elite)\b/i.test(text)) machine.mode = "CPAP";
  }

  if (!machine.device) {
    const deviceLine = readCaseInsensitive(kv, ["device", "machine", "model", "product", "ProductName"]);
    if (deviceLine && /(?:airsense|aircurve|sleepmate|s9)/i.test(deviceLine)) {
      machine.device = normalizeWhitespace(deviceLine);
      return;
    }

    for (const [pattern, label] of RESMED_DEVICE_HINTS) {
      if (pattern.test(text)) {
        machine.device = label;
        return;
      }
    }
  }
}

export async function parseResMedFamily(context: FamilyParserContext, deps: FamilyParserDeps): Promise<void> {
  let processed = 0;
  for (const candidate of context.candidates) {
    if (!/str\.edf$/i.test(candidate.baseName)) continue;
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
      const bytes = await candidate.file.readBytes();
      const records = parseResMedStrEdf(candidate, bytes, context.machine);
      if (records.length > 0) {
        context.records.push(...records);
      }
    } catch {
      continue;
    }
  }

  const textCandidates = context.candidates.filter((candidate) =>
    /\.(?:txt|csv|json|xml|log)$/i.test(candidate.baseName)
  );
  if (textCandidates.length === 0) return;

  await runTextFamilyParser(
    {
      ...context,
      candidates: textCandidates
    },
    deps,
    {
      inferFamilyMachineSettings: (text, candidate, machine, familyDeps) => {
        inferResMedMachineSettings(text, candidate, machine, familyDeps);
      }
    }
  );
}
