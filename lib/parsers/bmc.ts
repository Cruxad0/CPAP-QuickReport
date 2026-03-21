import { runTextFamilyParser } from "@/lib/parsers/text-family-runner";
import type { FamilyParserCandidate, FamilyParserContext, FamilyParserDeps } from "@/lib/parsers/text-family-types";
import type { QuickReportMetrics } from "@/lib/types";

const BMC_MODE_LABELS = new Map<number, string>([
  [0, "CPAP"],
  [1, "AutoCPAP"],
  [2, "S"],
  [3, "S/T"],
  [4, "T"],
  [5, "Titration"],
  [6, "AutoS"]
]);

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

function formatCm(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return `${Number(value.toFixed(2)).toString()} cmH2O`;
}

function inferBmcMachineInfo(bytes: Uint8Array, machine: QuickReportMetrics["machine"]) {
  if (!machine.device) {
    const model = readAscii(bytes, 0x2296, 32);
    if (model) machine.device = model;
  }
}

function inferBmcSettingsFromIdx(bytes: Uint8Array, machine: QuickReportMetrics["machine"]) {
  if (bytes.length < 0x166) return;
  if (bytes[0] !== 0xaa || bytes[1] !== 0xaa) return;

  const epap = bytes[0x141] / 2;
  const maxPressure = bytes[0x14c] / 2;
  const pressureSupport = (bytes[0x148] >> 2) / 2;
  const ipap = epap + pressureSupport;
  const modeCode = bytes[0x14d] >> 4;
  const reslex = bytes[0x148] & 0x03;
  const reslexPatient = (bytes[0x151] & 0x80) !== 0;
  const modeLabel = BMC_MODE_LABELS.get(modeCode);

  if (!machine.mode && modeLabel) {
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
      machine.epap = formatCm(epap);
      machine.ipap = formatCm(maxPressure);
    } else {
      machine.epap = formatCm(epap);
      machine.ipap = formatCm(ipap);
    }
  }

  if (!machine.pressureRelief) {
    if (reslex === 0) machine.pressureRelief = "Reslex: Off";
    else if (reslexPatient) machine.pressureRelief = "Reslex: Patient";
    else machine.pressureRelief = `Reslex: ${reslex}`;
  }
}

function inferBmcMachineSettingsFromText(text: string, machine: QuickReportMetrics["machine"], deps: FamilyParserDeps) {
  const kv = deps.parseKeyValueLines(text);
  const modeRaw = kv.get("Mode") ?? kv.get("BMC_Mode") ?? kv.get("mode");
  if (!machine.mode && modeRaw) {
    if (/\b(?:autocpap|apap)\b/i.test(modeRaw)) machine.mode = "APAP";
    else if (/\b(?:s\/t|autos|bilevel|bipap|titration| s )\b/i.test(` ${modeRaw.toLowerCase()} `)) machine.mode = "BiPAP";
    else if (/\bcpap\b/i.test(modeRaw)) machine.mode = "CPAP";
  }
}

export async function parseBmcFamily(context: FamilyParserContext, deps: FamilyParserDeps): Promise<void> {
  for (const candidate of context.candidates) {
    const lowerPath = candidate.normalizedPath.toLowerCase();
    if (!lowerPath.endsWith(".usr") && !lowerPath.endsWith(".idx")) continue;
    try {
      const bytes = await candidate.file.readBytes();
      if (lowerPath.endsWith(".usr")) inferBmcMachineInfo(bytes, context.machine);
      if (lowerPath.endsWith(".idx")) inferBmcSettingsFromIdx(bytes, context.machine);
    } catch {
      continue;
    }
  }

  await runTextFamilyParser(context, deps, {
    inferFamilyMachineSettings: (text, _candidate, machine, familyDeps) => {
      inferBmcMachineSettingsFromText(text, machine, familyDeps);
    }
  });
}
