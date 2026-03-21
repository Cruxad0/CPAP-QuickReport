import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const ICON_FAMILY: ParserFamilyDefinition = {
  id: "icon",
  label: "Fisher & Paykel ICON",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/icon_loader.cpp",
  signaturePatterns: [/(?:^|\/)fpicon\//i, /(?:^|\/)icon\.edf$/i],
  confidencePatterns: [{ pattern: /(?:^|\/)(?:fpicon\/|icon\.edf$)/i, weight: 4 }],
  priorityPatterns: [/(?:^|\/)(?:fpicon\/|icon\.edf$)/i]
};
