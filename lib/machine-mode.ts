import type { QuickReportMetrics } from "@/lib/types";

function normalizeMachineMode(mode: string | undefined): string {
  return (mode ?? "")
    .toLowerCase()
    .replace(/[\/_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const AUTO_MODE_PATTERNS: RegExp[] = [
  /\bapap\b/,
  /\bautoset\b/,
  /\bvauto\b/,
  /\bautobilevel\b/,
  /\bauto bilevel\b/,
  /\bautobipap\b/,
  /\bauto bipap\b/,
  /\bauto pap\b/,
  /\bautomatic pap\b/,
  /\bauto cpap\b/,
  /\bautomatic cpap\b/,
  /\bcpap auto\b/,
  /\basv\b/,
  /\bautosv\b/,
  /\bauto s30\b/,
  /\bauto st30\b/,
  /^auto$/,
  /^automatic$/
];

const BIPAP_MODE_PATTERNS: RegExp[] = [
  /\bbipap\b/,
  /\bbi level\b/,
  /\bbilevel\b/,
  /\bvpap\b/,
  /\blumis\b/,
  /\bavaps\b/,
  /\bs t\b/,
  /^st$/,
  /\bst a\b/,
  /^s30$/,
  /^t30$/,
  /^pc$/
];

export function isAutoPapLikeMode(mode: string | undefined): boolean {
  const normalized = normalizeMachineMode(mode);
  if (!normalized) return false;
  return AUTO_MODE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isBiPapLikeMode(mode: string | undefined): boolean {
  const normalized = normalizeMachineMode(mode);
  if (!normalized) return false;
  return BIPAP_MODE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isFixedCpapLikeMode(mode: string | undefined): boolean {
  const normalized = normalizeMachineMode(mode);
  if (!normalized) return false;
  return normalized.includes("cpap") && !isAutoPapLikeMode(normalized);
}

export type CanonicalTherapyMode = "BiPAP" | "APAP" | "CPAP";

export function classifyTherapyMode(machine: QuickReportMetrics["machine"]): CanonicalTherapyMode | null {
  if (isBiPapLikeMode(machine.mode) || machine.epap || machine.ipap || machine.respiratoryRate) {
    return "BiPAP";
  }

  if (isAutoPapLikeMode(machine.mode) || machine.pressureIsAuto || machine.pressureMin || machine.pressureMax) {
    return "APAP";
  }

  if (isFixedCpapLikeMode(machine.mode) || machine.pressure) {
    return "CPAP";
  }

  return null;
}
