import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const WEINMANN_FAMILY: ParserFamilyDefinition = {
  id: "weinmann",
  label: "Weinmann / Loewenstein",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/weinmann_loader.cpp",
  signaturePatterns: [/(?:^|\/)wm_profiles\.xml$/i, /(?:^|\/)somnobalance/i],
  confidencePatterns: [{ pattern: /(?:^|\/)wm_profiles\.xml$/i, weight: 4 }],
  priorityPatterns: [/(?:^|\/)(?:wm_profiles\.xml|somnobalance)/i]
};
