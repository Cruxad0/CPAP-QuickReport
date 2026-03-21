import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const BMC_FAMILY: ParserFamilyDefinition = {
  id: "bmc",
  label: "Apex / BMC / Luna",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/bmc_loader.cpp",
  signaturePatterns: [/(?:^|\/)[^/]+\.usr$/i, /(?:^|\/)[^/]+\.idx$/i, /(?:^|\/)[^/]+\.000$/i],
  confidencePatterns: [
    { pattern: /(?:^|\/)[^/]+\.usr$/i, weight: 4 },
    { pattern: /(?:^|\/)[^/]+\.idx$/i, weight: 3 },
    { pattern: /(?:^|\/)[^/]+\.000$/i, weight: 2 }
  ],
  priorityPatterns: [/(?:^|\/)[^/]+\.(?:usr|idx|000)$/i]
};
