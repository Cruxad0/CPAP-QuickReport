import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const BMC_FAMILY: ParserFamilyDefinition = {
  id: "bmc",
  label: "Apex / BMC / Luna",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/bmc_loader.cpp",
  signaturePatterns: [/(?:^|\/)p[0-9]{4}\.idx$/i, /(?:^|\/)p[0-9]{4}\.000$/i, /(?:^|\/)(?:luna|apex|bmc)/i],
  confidencePatterns: [{ pattern: /(?:^|\/)p\d{4}\.(?:idx|000)$/i, weight: 4 }],
  priorityPatterns: [/(?:^|\/)p\d{4}\.(?:idx|000)$/i, /(?:^|\/)record\//i]
};
