import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function getBmcBundleInfo(path: string): { key: string; extension: string } | null {
  const normalized = normalizePath(path);
  const match = /^(.*\/)?([^/]+)\.([^.\/]+)$/i.exec(normalized);
  if (!match) return null;

  const extension = match[3]?.toLowerCase() ?? "";
  if (!/^(?:usr|idx|\d{3})$/.test(extension)) return null;

  const directory = match[1] ?? "";
  const baseName = match[2] ?? "";
  return {
    key: `${directory}${baseName}`.toLowerCase(),
    extension
  };
}

export function hasBmcUsrStructure(files: Array<{ normalizedPath: string }>): boolean {
  return files.some((file) => /(?:^|\/)[^/]+\.usr$/i.test(normalizePath(file.normalizedPath)));
}

export function isBmcWaveformPath(path: string): boolean {
  return /(?:^|\/)[^/]+\.\d{3}$/i.test(normalizePath(path));
}

export function hasBmcBundleStructure(files: Array<{ normalizedPath: string }>): boolean {
  const bundleMap = new Map<string, { usr: boolean; idx: boolean; zero: boolean }>();

  for (const file of files) {
    const info = getBmcBundleInfo(file.normalizedPath);
    if (!info) continue;

    const current = bundleMap.get(info.key) ?? { usr: false, idx: false, zero: false };
    if (info.extension === "usr") current.usr = true;
    else if (info.extension === "idx") current.idx = true;
    else if (info.extension === "000") current.zero = true;
    bundleMap.set(info.key, current);
  }

  for (const bundle of bundleMap.values()) {
    if (bundle.usr && bundle.idx && bundle.zero) return true;
  }

  return false;
}

export const BMC_FAMILY: ParserFamilyDefinition = {
  id: "bmc",
  label: "Apex / BMC / Luna",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/bmc_loader.cpp",
  signaturePatterns: [/(?:^|\/)[^/]+\.usr$/i],
  confidencePatterns: [{ pattern: /(?:^|\/)[^/]+\.usr$/i, weight: 4 }],
  priorityPatterns: [/(?:^|\/)[^/]+\.(?:usr|idx|\d{3})$/i]
};
