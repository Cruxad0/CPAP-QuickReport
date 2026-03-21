import { runTextFamilyParser } from "@/lib/parsers/text-family-runner";
import type { FamilyParserContext, FamilyParserDeps } from "@/lib/parsers/text-family-types";
import type { QuickReportMetrics } from "@/lib/types";

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

function readCaseInsensitive(map: Map<string, string>, keys: string[]): string | undefined {
  const lower = new Map<string, string>();
  for (const [key, value] of map.entries()) lower.set(key.toLowerCase(), value);
  for (const key of keys) {
    const hit = map.get(key) ?? lower.get(key.toLowerCase());
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function inferResMedMachineSettings(text: string, machine: QuickReportMetrics["machine"], deps: FamilyParserDeps) {
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
    const deviceLine = readCaseInsensitive(kv, ["device", "machine", "model", "product"]);
    if (deviceLine && /(?:airsense|aircurve|sleepmate|s9)/i.test(deviceLine)) {
      machine.device = deviceLine.trim();
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
  await runTextFamilyParser(context, deps, {
    inferFamilyMachineSettings: (text, _candidate, machine, familyDeps) => {
      inferResMedMachineSettings(text, machine, familyDeps);
    }
  });
}
