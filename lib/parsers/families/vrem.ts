import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const VREM_FAMILY: ParserFamilyDefinition = {
  id: "vrem",
  label: "VREM",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/vrem_loader.cpp",
  signaturePatterns: [/(?:^|\/)vrem/i],
  confidencePatterns: [{ pattern: /(?:^|\/)vrem/i, weight: 4 }],
  priorityPatterns: [/(?:^|\/)vrem/i]
};
