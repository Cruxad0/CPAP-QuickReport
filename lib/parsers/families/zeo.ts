import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const ZEO_FAMILY: ParserFamilyDefinition = {
  id: "zeo",
  label: "Zeo",
  supportedQuickReport: false,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/zeo_loader.cpp",
  signaturePatterns: [/(?:^|\/)zeo/i, /(?:^|\/)zeosleep/i],
  confidencePatterns: [{ pattern: /(?:^|\/)zeo/i, weight: 4 }],
  priorityPatterns: [/(?:^|\/)(?:zeo|zeosleep)/i]
};
