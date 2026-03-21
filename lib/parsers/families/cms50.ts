import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const CMS50_FAMILY: ParserFamilyDefinition = {
  id: "cms50",
  label: "CMS50",
  supportedQuickReport: false,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/cms50_loader.cpp",
  signaturePatterns: [/(?:^|\/)spo2\.(?:dat|csv)$/i, /(?:^|\/)cms50/i],
  confidencePatterns: [{ pattern: /(?:^|\/)cms50/i, weight: 4 }],
  priorityPatterns: [/(?:^|\/)(?:spo2\.(?:dat|csv)|cms50)/i]
};
