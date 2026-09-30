import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function hasBmcG3xCandidateStructure(files: Array<{ normalizedPath: string }>): boolean {
  const normalized = files.map((file) => normalizePath(file.normalizedPath));
  if (normalized.some((path) => /(?:^|\/)[^/]+\.usr$/i.test(path))) return false;
  // Recent G3X cards can retain IDX statistics and EVT events after waveform
  // files have been removed. The IDX header is checked before this family runs.
  return normalized.some((path) => /(?:^|\/)[^/]+\.idx$/i.test(path));
}

export const BMC_G3X_FAMILY: ParserFamilyDefinition = {
  id: "bmcg3x",
  label: "ReactHealth / BMC G3 / G3X",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-SQL/oscar/SleepLib/loader_plugins/bmcg3x_loader.cpp",
  signaturePatterns: [/(?:^|\/)[^/]+\.idx$/i, /(?:^|\/)[^/]+\.000$/i],
  confidencePatterns: [
    { pattern: /(?:^|\/)[^/]+\.idx$/i, weight: 3 },
    { pattern: /(?:^|\/)[^/]+\.evt$/i, weight: 2 },
    { pattern: /(?:^|\/)[^/]+\.000$/i, weight: 3 }
  ],
  priorityPatterns: [/(?:^|\/)[^/]+\.(?:idx|evt|log|\d{3})$/i]
};
