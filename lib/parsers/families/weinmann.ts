import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const WEINMANN_FAMILY: ParserFamilyDefinition = {
  id: "weinmann",
  label: "Weinmann / Loewenstein",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/weinmann_loader.cpp",
  signaturePatterns: [/(?:^|\/)wm_data\.tdf$/i],
  confidencePatterns: [{ pattern: /(?:^|\/)wm_data\.tdf$/i, weight: 4 }],
  priorityPatterns: [/(?:^|\/)wm_data\.tdf$/i]
};
