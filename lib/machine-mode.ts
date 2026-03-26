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
  /\bauto pap\b/,
  /\bautomatic pap\b/,
  /\bauto cpap\b/,
  /\bautomatic cpap\b/,
  /\bcpap auto\b/,
  /^auto$/,
  /^automatic$/
];

const BIPAP_MODE_PATTERNS: RegExp[] = [
  /\bbipap\b/,
  /\bbi level\b/,
  /\bbilevel\b/,
  /\bautobilevel\b/,
  /\bauto bilevel\b/,
  /\bautobipap\b/,
  /\bauto bipap\b/,
  /\bvpap\b/,
  /\bvauto\b/,
  /\blumis\b/,
  /\basv\b/,
  /\bautosv\b/,
  /\bavaps\b/,
  /\bs t\b/,
  /^st$/,
  /\bst a\b/,
  /^s30$/,
  /\bauto s30\b/,
  /\bauto st30\b/,
  /^t30$/,
  /^pc$/
];

const AUTO_BIPAP_MODE_PATTERNS: RegExp[] = [
  /\bautobilevel\b/,
  /\bauto bilevel\b/,
  /\bautobipap\b/,
  /\bauto bipap\b/,
  /\bvauto\b/,
  /\basv\b/,
  /\bautosv\b/,
  /\bavaps\b/,
  /\bauto s\b/,
  /\bauto st\b/,
  /\bauto s30\b/,
  /\bauto st30\b/
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

export function isAutoBiPapLikeMode(mode: string | undefined): boolean {
  const normalized = normalizeMachineMode(mode);
  if (!normalized) return false;
  return AUTO_BIPAP_MODE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isFixedCpapLikeMode(mode: string | undefined): boolean {
  const normalized = normalizeMachineMode(mode);
  if (!normalized) return false;
  return normalized.includes("cpap") && !isAutoPapLikeMode(normalized);
}

export type CanonicalTherapyMode = "BiPAP" | "APAP" | "CPAP";

export function resolveExplicitTherapyMode(mode: string | undefined): CanonicalTherapyMode | null {
  if (isBiPapLikeMode(mode)) return "BiPAP";
  if (isAutoPapLikeMode(mode)) return "APAP";
  if (isFixedCpapLikeMode(mode)) return "CPAP";
  return null;
}

export function classifyTherapyMode(machine: QuickReportMetrics["machine"]): CanonicalTherapyMode | null {
  const explicitMode = resolveExplicitTherapyMode(machine.mode);
  if (explicitMode) return explicitMode;

  if (machine.respiratoryRate || (machine.epap && machine.ipap)) {
    return "BiPAP";
  }

  if (machine.pressureIsAuto || machine.pressureMin || machine.pressureMax) {
    return "APAP";
  }

  if (machine.pressure) {
    return "CPAP";
  }

  return null;
}
