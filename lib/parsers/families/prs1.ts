import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const PRS1_FAMILY: ParserFamilyDefinition = {
  id: "prs1",
  label: "Philips Respironics System One / DreamStation",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/prs1_loader.cpp",
  signaturePatterns: [/(?:^|\/)p-series\//i, /(?:^|\/)p[0-9]{5}\.[0-9]{3}$/i],
  confidencePatterns: [{ pattern: /(?:^|\/)p-series\/p\d{5}\.\d{3}$/i, weight: 4 }],
  priorityPatterns: [/(?:^|\/)p-series\/p\d{5}\.\d{3}$/i, /(?:^|\/)p\d{5}\.\d{3}$/i, /(?:^|\/)(?:summary|compliance)\.(?:txt|csv|xml)$/i]
};
