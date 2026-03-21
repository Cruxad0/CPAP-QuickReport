import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const SLEEPSTYLE_FAMILY: ParserFamilyDefinition = {
  id: "sleepstyle",
  label: "Fisher & Paykel SleepStyle",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/sleepstyle_loader.cpp",
  signaturePatterns: [/(?:^|\/)summary\.edf$/i, /(?:^|\/)detail\.edf$/i],
  confidencePatterns: [{ pattern: /(?:^|\/)(?:summary|detail)\.edf$/i, weight: 3 }],
  priorityPatterns: [/(?:^|\/)(?:summary|detail)\.edf$/i]
};
