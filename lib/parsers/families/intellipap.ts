import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const INTELLIPAP_FAMILY: ParserFamilyDefinition = {
  id: "intellipap",
  label: "DeVilbiss IntelliPAP",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/intellipap_loader.cpp",
  signaturePatterns: [/(?:^|\/)smartcode\//i, /(?:^|\/)sl\.edf$/i],
  confidencePatterns: [{ pattern: /(?:^|\/)smartcode\//i, weight: 4 }],
  priorityPatterns: [/(?:^|\/)(?:smartcode\/|sl\.edf$)/i]
};
