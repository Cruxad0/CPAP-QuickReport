import { runTextFamilyParser } from "@/lib/parsers/text-family-runner";
import type { FamilyParserCandidate, FamilyParserContext, FamilyParserDeps } from "@/lib/parsers/text-family-types";
import type { QuickReportMetrics } from "@/lib/types";

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

const PRISMA_DEVICE_BY_ID = new Map<string, string>([
  ["0x92", "Prisma Smart"],
  ["0x91", "Prisma Soft"]
]);

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
      pressureText(parameters.get(PRISMA_LINE_EPAP)) ??
      pressureText(parameters.get(PRISMA_LINE_EEPAP_MIN));
    machine.ipap =
      pressureText(parameters.get(PRISMA_LINE_IPAP)) ??
      pressureText(parameters.get(PRISMA_LINE_IPAP_MAX));
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

  if (machine.mode === "APAP" && machine.pressureMin && machine.pressureMax) {
    const apapDynamic = parameters.get(PRISMA_LINE_APAP_DYNAMIC);
    if (!machine.device) {
      machine.device = apapDynamic === 2 ? "Prisma Line (APAP dyn)" : "Prisma Line (APAP std)";
    }
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

export async function parsePrismaFamily(context: FamilyParserContext, deps: FamilyParserDeps): Promise<void> {
  await runTextFamilyParser(context, deps, {
    inferFamilyMachineSettings: (text, candidate, machine, familyDeps) => {
      inferPrismaMachineSettings(text, candidate, machine, familyDeps);
    }
  });
}
