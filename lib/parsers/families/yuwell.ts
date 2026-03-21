import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const YUWELL_FAMILY: ParserFamilyDefinition = {
  id: "yuwell",
  label: "Yuwell",
  supportedQuickReport: false,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/yuwell_loader.cpp",
  signaturePatterns: [/(?:^|\/)yuwell/i, /(?:^|\/)wave\//i],
  confidencePatterns: [{ pattern: /(?:^|\/)yuwell/i, weight: 4 }],
  priorityPatterns: [/(?:^|\/)(?:yuwell|wave\/)/i]
};
