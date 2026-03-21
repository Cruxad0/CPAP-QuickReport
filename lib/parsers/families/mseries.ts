import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const MSERIES_FAMILY: ParserFamilyDefinition = {
  id: "mseries",
  label: "Philips Respironics M-Series",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/mseries_loader.cpp",
  signaturePatterns: [/(?:^|\/)m-series\//i, /(?:^|\/)therapy\.dat$/i],
  confidencePatterns: [{ pattern: /(?:^|\/)m-series\//i, weight: 4 }],
  priorityPatterns: [/(?:^|\/)m-series\//i, /(?:^|\/)therapy\.dat$/i, /(?:^|\/)(?:summary|compliance)\.(?:txt|csv|xml)$/i]
};
