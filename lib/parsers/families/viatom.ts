import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const VIATOM_FAMILY: ParserFamilyDefinition = {
  id: "viatom",
  label: "Viatom",
  supportedQuickReport: false,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/viatom_loader.cpp",
  signaturePatterns: [/(?:^|\/)viatom/i, /(?:^|\/)oximeter/i],
  confidencePatterns: [{ pattern: /(?:^|\/)viatom/i, weight: 4 }],
  priorityPatterns: [/(?:^|\/)(?:viatom|oximeter)/i]
};
