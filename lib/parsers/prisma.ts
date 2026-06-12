import JSZip from "jszip";

import type { FamilyParserCandidate, FamilyParserContext, FamilyParserDeps } from "@/lib/parsers/text-family-types";
import type { ParsedRecord, QuickReportMetrics } from "@/lib/types";

const PRISMA_SMART_MODE = 6;
const PRISMA_SMART_PRESSURE = 9;
const PRISMA_SMART_PRESSURE_MAX = 10;
const PRISMA_SMART_SOFTPAP = 13;
const PRISMA_SMART_APAP_DYNAMIC = 15;

const PRISMA_LINE_MODE = 1003;
const PRISMA_LINE_SOFT_PAP_LEVEL = 1123;
const PRISMA_LINE_EEPAP_MIN = 1138;
const PRISMA_LINE_EEPAP_MAX = 1139;
const PRISMA_LINE_PDIFF_NORM = 1140;
const PRISMA_LINE_PDIFF_MAX = 1141;
const PRISMA_LINE_IPAP_MAX = 1199;
const PRISMA_LINE_IPAP = 1200;
const PRISMA_LINE_EPAP = 1201;
const PRISMA_LINE_APAP_DYNAMIC = 1209;
const PRISMA_LINE_EXTRA_OBSTRUCTION_PROTECTION = 1154;
const PRISMA_LINE_AUTO_PDIFF = 1219;

const PRISMA_EVENT_OBSTRUCTIVE_APNEA = 101;
const PRISMA_EVENT_CENTRAL_APNEA = 102;
const PRISMA_EVENT_OBSTRUCTIVE_HYPOPNEA = 111;
const PRISMA_EVENT_CENTRAL_HYPOPNEA = 112;
const PRISMA_EVENT_RERA = 121;

const PRISMA_DEVICE_BY_ID = new Map<string, string>([
  ["0x92", "Prisma Smart"],
  ["0x91", "Prisma Soft"],
  ["22", "prisma25S"],
  ["23", "prisma25ST"]
]);

type PrismaRespEventCounts = {
  obstructiveApneas: number;
  centralApneas: number;
  obstructiveHypopneas: number;
  centralHypopneas: number;
  reras: number;
};

type PrismaSignalSummary = {
  startDate: Date;
  usageHours: number;
  pressureAvg?: number;
  pressure95th?: number;
};

type PrismaSessionBundle = {
  sessionId: string;
  eventText?: string;
  signalBytes?: Uint8Array;
};

type PrismaEdfSignal = {
  normalizedLabel: string;
  physicalMin: number;
  physicalMax: number;
  digitalMin: number;
  digitalMax: number;
  samplesPerRecord: number;
  recordSampleOffset: number;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/[_\s]+/g, " ").trim();
}

function normalizeLabel(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
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

function safeNumber(input: unknown): number | undefined {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input !== "string") return undefined;
  const n = Number.parseFloat(input.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : undefined;
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

function pressureText(raw: number | undefined, divisor = 100): string | undefined {
  if (raw === undefined || !Number.isFinite(raw)) return undefined;
  const cm = raw / divisor;
  if (!Number.isFinite(cm) || cm < 0) return undefined;
  return `${Number(cm.toFixed(2)).toString()} cmH2O`;
}

function extractPrismaParameters(text: string): Map<number, number> {
  const parameters = new Map<number, number>();
  const re =
    /<DeviceEvent\b[^>]*DeviceEventID="(\d+)"[^>]*ParameterID="(\d+)"[^>]*NewValue="(-?\d+)"[^>]*\/?>/gi;

  for (const match of text.matchAll(re)) {
    if (Number(match[1]) !== 0) continue;
    parameters.set(Number(match[2]), Number(match[3]));
  }

  return parameters;
}

function extractAttr(tag: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`, "i").exec(tag);
  return match?.[1];
}

function extractPrismaRespEventCounts(text: string): PrismaRespEventCounts {
  const counts: PrismaRespEventCounts = {
    obstructiveApneas: 0,
    centralApneas: 0,
    obstructiveHypopneas: 0,
    centralHypopneas: 0,
    reras: 0
  };

  for (const match of text.matchAll(/<RespEvent\b[^>]*\/?>/gi)) {
    const eventId = Number(extractAttr(match[0], "RespEventID"));
    switch (eventId) {
      case PRISMA_EVENT_OBSTRUCTIVE_APNEA:
        counts.obstructiveApneas += 1;
        break;
      case PRISMA_EVENT_CENTRAL_APNEA:
        counts.centralApneas += 1;
        break;
      case PRISMA_EVENT_OBSTRUCTIVE_HYPOPNEA:
        counts.obstructiveHypopneas += 1;
        break;
      case PRISMA_EVENT_CENTRAL_HYPOPNEA:
        counts.centralHypopneas += 1;
        break;
      case PRISMA_EVENT_RERA:
        counts.reras += 1;
        break;
      default:
        break;
    }
  }

  return counts;
}

function inferPrismaDeviceFromConfig(text: string, machine: QuickReportMetrics["machine"]) {
  let config: Record<string, unknown> | null = null;
  try {
    config = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }

  const deviceId = typeof config.devid === "string" ? config.devid.trim() : "";
  if (!machine.device) {
    if (deviceId && PRISMA_DEVICE_BY_ID.has(deviceId)) {
      machine.device = PRISMA_DEVICE_BY_ID.get(deviceId);
    } else if (deviceId) {
      machine.device = `Prisma ${deviceId}`;
    } else {
      machine.device = "Prisma Smart";
    }
  }
}

export function inferPrismaLineDeviceFromXml(text: string, machine: QuickReportMetrics["machine"]) {
  const deviceType =
    /<DeviceType\b[^>]*\bvalue="([^"]+)"/i.exec(text)?.[1]?.trim() ??
    /<DeviceType\b[^>]*>([^<]+)<\/DeviceType>/i.exec(text)?.[1]?.trim() ??
    "";
  const serial =
    /<DeviceSerialNumber\b[^>]*\bvalue="([^"]+)"/i.exec(text)?.[1]?.trim() ??
    /<DeviceSerialNumber\b[^>]*>([^<]+)<\/DeviceSerialNumber>/i.exec(text)?.[1]?.trim() ??
    "";
  const model = PRISMA_DEVICE_BY_ID.get(deviceType);
  if (model) machine.device = serial ? `${model} (${serial})` : model;
}

function applyPrismaSmartParameters(parameters: Map<number, number>, machine: QuickReportMetrics["machine"]) {
  const mode = parameters.get(PRISMA_SMART_MODE);
  if (mode === 1) {
    machine.mode = "CPAP";
    const pressure = pressureText(parameters.get(PRISMA_SMART_PRESSURE));
    if (pressure) machine.pressure = `Fixed ${pressure}`;
  } else if (mode === 2) {
    machine.mode = "APAP";
    machine.pressureIsAuto = true;
    machine.pressureMin = pressureText(parameters.get(PRISMA_SMART_PRESSURE));
    machine.pressureMax = pressureText(parameters.get(PRISMA_SMART_PRESSURE_MAX));
  }

  const apapDynamic = parameters.get(PRISMA_SMART_APAP_DYNAMIC);
  if (machine.mode === "APAP" && apapDynamic !== undefined && !machine.device) {
    machine.device = apapDynamic === 2 ? "Prisma Smart (APAP dyn)" : "Prisma Smart (APAP std)";
  }

  const softPap = parameters.get(PRISMA_SMART_SOFTPAP);
  if (!machine.pressureRelief && softPap !== undefined) {
    machine.pressureRelief = softPap > 0 ? `SoftPAP: ${softPap}` : "SoftPAP: Off";
  }
}

function applyPrismaLineParameters(parameters: Map<number, number>, machine: QuickReportMetrics["machine"]) {
  const mode = parameters.get(PRISMA_LINE_MODE);
  if (mode === undefined) return;

  if (!machine.device) machine.device = "Prisma Line";

  if (mode === 2) {
    machine.mode = "APAP";
    machine.pressureIsAuto = true;
    machine.pressureMin = pressureText(parameters.get(PRISMA_LINE_EPAP));
    machine.pressureMax = pressureText(parameters.get(PRISMA_LINE_IPAP));
  } else if (mode === 1) {
    machine.mode = "CPAP";
    const pressure = pressureText(parameters.get(PRISMA_LINE_EPAP));
    if (pressure) machine.pressure = `Fixed ${pressure}`;
  } else if (mode === 3 || mode === 9 || mode === 10) {
    machine.mode = "BiPAP";
    machine.epap =
      pressureText(parameters.get(PRISMA_LINE_EPAP)) ?? pressureText(parameters.get(PRISMA_LINE_EEPAP_MIN));
    machine.ipap =
      pressureText(parameters.get(PRISMA_LINE_IPAP)) ?? pressureText(parameters.get(PRISMA_LINE_IPAP_MAX));
  }

  const softPap = parameters.get(PRISMA_LINE_SOFT_PAP_LEVEL);
  if (!machine.pressureRelief && softPap !== undefined) {
    machine.pressureRelief = softPap > 0 ? `SoftPAP: ${softPap}` : "SoftPAP: Off";
  }

  const biSoft = parameters.get(PRISMA_LINE_EXTRA_OBSTRUCTION_PROTECTION);
  if (!machine.pressureRelief && biSoft !== undefined) {
    machine.pressureRelief = biSoft > 0 ? `BiSoft: ${biSoft}` : "BiSoft: Off";
  }

  if (machine.mode === "BiPAP") {
    if (!machine.epap) machine.epap = pressureText(parameters.get(PRISMA_LINE_EEPAP_MIN));
    if (!machine.ipap) machine.ipap = pressureText(parameters.get(PRISMA_LINE_IPAP_MAX));
  }

  if (machine.mode === "BiPAP" && !machine.pressureRelief) {
    const autoPdiff = parameters.get(PRISMA_LINE_AUTO_PDIFF);
    const psMin = pressureText(parameters.get(PRISMA_LINE_PDIFF_NORM));
    const psMax = pressureText(parameters.get(PRISMA_LINE_PDIFF_MAX));
    if (autoPdiff === 1 && psMin && psMax) {
      machine.pressureRelief = `PS: ${psMin} to ${psMax}`;
    }
  }
}

function inferPrismaMachineSettings(
  text: string,
  candidate: FamilyParserCandidate,
  machine: QuickReportMetrics["machine"],
  deps: FamilyParserDeps
) {
  const lowerPath = candidate.normalizedPath.toLowerCase();

  if (lowerPath.endsWith("config.pscfg")) {
    inferPrismaDeviceFromConfig(text, machine);
    if (!machine.device) machine.device = "Prisma Smart";
  } else if (lowerPath.endsWith("config.pcfg")) {
    if (!machine.device) machine.device = "Prisma Line";
  }

  const kv = deps.parseKeyValueLines(text);
  const modeRaw = readCaseInsensitive(kv, ["mode", "therapy mode", "prismamode"]);
  if (!machine.mode && modeRaw) {
    if (/\b(?:auto s\/t|auto s|acsv|bilevel|bipap)\b/i.test(modeRaw)) machine.mode = "BiPAP";
    else if (/\bapap\b/i.test(modeRaw)) machine.mode = "APAP";
    else if (/\bcpap\b/i.test(modeRaw)) machine.mode = "CPAP";
  }

  const parameters = extractPrismaParameters(text);
  if (parameters.size > 0) {
    if (parameters.has(PRISMA_SMART_MODE)) applyPrismaSmartParameters(parameters, machine);
    if (parameters.has(PRISMA_LINE_MODE)) applyPrismaLineParameters(parameters, machine);
  }
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

function parseEdfStartDate(rawDate: string, rawTime: string): Date | null {
  const dateMatch = rawDate.match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  const timeMatch = rawTime.match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  if (!dateMatch || !timeMatch) return null;
  const day = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const yy = Number(dateMatch[3]);
  const year = yy >= 70 ? 1900 + yy : 2000 + yy;
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3]);
  const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function parsePrismaSignalSummary(bytes: Uint8Array): PrismaSignalSummary | null {
  if (bytes.length < 256) return null;

  const headerBytes = parseAsciiNumber(bytes, 184, 8);
  const numRecords = parseAsciiNumber(bytes, 236, 8);
  const recordDuration = parseAsciiNumber(bytes, 244, 8);
  const numSignals = parseAsciiNumber(bytes, 252, 4);
  const startDate = parseEdfStartDate(parseAsciiField(bytes, 168, 8), parseAsciiField(bytes, 176, 8));
  if (!headerBytes || !numRecords || !recordDuration || !numSignals || !startDate) return null;
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

  const signals: PrismaEdfSignal[] = [];
  let recordSampleOffset = 0;
  for (let i = 0; i < numSignals; i += 1) {
    const label = parseAsciiField(bytes, labelsStart + i * 16, 16);
    const samplesPerRecord = parseAsciiNumber(bytes, samplesStart + i * 8, 8) ?? 0;
    if (!label || samplesPerRecord <= 0) {
      recordSampleOffset += Math.max(0, samplesPerRecord);
      continue;
    }
    signals.push({
      normalizedLabel: normalizeLabel(label),
      physicalMin: parseAsciiNumber(bytes, physMinStart + i * 8, 8) ?? 0,
      physicalMax: parseAsciiNumber(bytes, physMaxStart + i * 8, 8) ?? 0,
      digitalMin: parseAsciiNumber(bytes, digMinStart + i * 8, 8) ?? -32768,
      digitalMax: parseAsciiNumber(bytes, digMaxStart + i * 8, 8) ?? 32767,
      samplesPerRecord,
      recordSampleOffset
    });
    recordSampleOffset += samplesPerRecord;
  }

  const bytesPerRecord = recordSampleOffset * 2;
  if (bytesPerRecord <= 0 || headerBytes + bytesPerRecord * numRecords > bytes.length) return null;

  const pressureSignal = signals.find((signal) =>
    ["pressuremeasured", "pressure measured", "pressure", "mask pressure"].includes(signal.normalizedLabel)
  );

  const pressureValues: number[] = [];
  if (pressureSignal) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const digitalSpan = pressureSignal.digitalMax - pressureSignal.digitalMin;
    const gain = digitalSpan === 0 ? 1 : (pressureSignal.physicalMax - pressureSignal.physicalMin) / digitalSpan;
    const offset = pressureSignal.physicalMin - pressureSignal.digitalMin * gain;

    for (let recordIndex = 0; recordIndex < numRecords; recordIndex += 1) {
      const sampleOffset =
        headerBytes + recordIndex * bytesPerRecord + pressureSignal.recordSampleOffset * 2;
      if (sampleOffset + 2 > bytes.length) break;
      const raw = view.getInt16(sampleOffset, true);
      const value = raw * gain + offset;
      if (Number.isFinite(value) && value >= 0 && value <= 80) {
        pressureValues.push(value);
      }
    }
  }

  const usageHours = (numRecords * recordDuration) / 3600;
  return {
    startDate,
    usageHours,
    pressureAvg:
      pressureValues.length > 0 ? pressureValues.reduce((sum, value) => sum + value, 0) / pressureValues.length : undefined,
    pressure95th: pressureValues.length > 0 ? percentile(pressureValues, 95) : undefined
  };
}

function addDirectCandidateSession(bundles: Map<string, PrismaSessionBundle>, candidate: FamilyParserCandidate, payload: string | Uint8Array) {
  const baseName = candidate.baseName.toLowerCase();
  const eventMatch = /^event_(\d{6})\.xml$/i.exec(baseName);
  const signalMatch = /^signal_(\d{6})\.wmedf$/i.exec(baseName);
  if (!eventMatch && !signalMatch) return;

  const sessionId = (eventMatch ?? signalMatch)?.[1];
  if (!sessionId) return;
  const existing = bundles.get(sessionId) ?? { sessionId };
  if (typeof payload === "string") existing.eventText = payload;
  else existing.signalBytes = payload;
  bundles.set(sessionId, existing);
}

async function readPrismaTherapyArchive(bytes: Uint8Array, bundles: Map<string, PrismaSessionBundle>) {
  const archive = await JSZip.loadAsync(bytes);
  for (const entry of Object.values(archive.files)) {
    if (entry.dir) continue;
    const baseName = entry.name.split("/").pop()?.toLowerCase() ?? "";
    const eventMatch = /^event_(\d{6})\.xml$/i.exec(baseName);
    const signalMatch = /^signal_(\d{6})\.wmedf$/i.exec(baseName);
    const sessionId = (eventMatch ?? signalMatch)?.[1];
    if (!sessionId) continue;

    const existing = bundles.get(sessionId) ?? { sessionId };
    if (eventMatch && !existing.eventText) {
      existing.eventText = await entry.async("string");
    }
    if (signalMatch && !existing.signalBytes) {
      const data = await entry.async("uint8array");
      existing.signalBytes = data;
    }
    bundles.set(sessionId, existing);
  }
}

async function readPrismaLineConfigArchive(bytes: Uint8Array, machine: QuickReportMetrics["machine"]) {
  const archive = await JSZip.loadAsync(bytes);
  const deviceEntry = Object.values(archive.files).find(
    (entry) => !entry.dir && /(?:^|\/)device\.xml$/i.test(entry.name)
  );
  if (!deviceEntry) return;
  inferPrismaLineDeviceFromXml(await deviceEntry.async("string"), machine);
}

function buildPrismaRecord(bundle: PrismaSessionBundle): ParsedRecord | null {
  const signal = bundle.signalBytes ? parsePrismaSignalSummary(bundle.signalBytes) : null;
  const counts = bundle.eventText ? extractPrismaRespEventCounts(bundle.eventText) : null;
  const date = signal?.startDate;
  if (!date) return null;

  const usageHours = signal?.usageHours;
  const totalAhiEvents = counts
    ? counts.obstructiveApneas + counts.centralApneas + counts.obstructiveHypopneas + counts.centralHypopneas
    : 0;

  return {
    date,
    usageHours: usageHours !== undefined && usageHours > 0 && usageHours <= 24 ? usageHours : undefined,
    ahi: usageHours && totalAhiEvents > 0 ? totalAhiEvents / usageHours : undefined,
    residualApneas: usageHours && counts && counts.obstructiveApneas > 0 ? counts.obstructiveApneas / usageHours : undefined,
    centralApneas: usageHours && counts && counts.centralApneas > 0 ? counts.centralApneas / usageHours : undefined,
    reraIndex: usageHours && counts && counts.reras > 0 ? counts.reras / usageHours : undefined,
    pressureAvg: signal?.pressureAvg,
    pressure95th: signal?.pressure95th
  };
}

export async function parsePrismaFamily(context: FamilyParserContext, deps: FamilyParserDeps): Promise<void> {
  const bundles = new Map<string, PrismaSessionBundle>();

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
      const lowerPath = candidate.normalizedPath.toLowerCase();
      const bytes = await candidate.file.readBytes();

      if (lowerPath.endsWith("config.pscfg") || lowerPath.endsWith("config.pcfg") || /(?:^|\/)event_\d{6}\.xml$/i.test(lowerPath)) {
        const variants = deps.decodeLikelyTextVariants(bytes);
        if (variants.length > 0) {
          const text = variants[0];
          inferPrismaMachineSettings(text, candidate, context.machine, deps);
          if (/(?:^|\/)event_\d{6}\.xml$/i.test(lowerPath)) {
            addDirectCandidateSession(bundles, candidate, text);
          }
        }
      }

      if (/(?:^|\/)signal_\d{6}\.wmedf$/i.test(lowerPath)) {
        addDirectCandidateSession(bundles, candidate, bytes);
      }

      if (lowerPath.endsWith("therapy.pdat")) {
        await readPrismaTherapyArchive(bytes, bundles);
      }
      if (lowerPath.endsWith("config.pcfg")) {
        await readPrismaLineConfigArchive(bytes, context.machine);
      }
    } catch {
      continue;
    }

    if (processed % 5 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const sortedBundles = [...bundles.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  for (const bundle of sortedBundles) {
    if (bundle.eventText) {
      const pseudoCandidate: FamilyParserCandidate = {
        file: context.candidates[0]?.file ?? { name: "", path: "", size: 0, readText: async () => "", readBytes: async () => new Uint8Array() },
        normalizedPath: `therapy.pdat/${bundle.sessionId}/event.xml`,
        baseName: `event_${bundle.sessionId}.xml`,
        recordDate: null
      };
      inferPrismaMachineSettings(bundle.eventText, pseudoCandidate, context.machine, deps);
    }

    const record = buildPrismaRecord(bundle);
    if (record) context.records.push(record);
  }

  if (!context.machine.device) {
    context.machine.device = "Prisma";
  }
}
