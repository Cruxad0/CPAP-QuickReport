import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const DREEM_FAMILY: ParserFamilyDefinition = {
  id: "dreem",
  label: "Dreem",
  supportedQuickReport: false,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/dreem_loader.cpp",
  signaturePatterns: [/(?:^|\/)dreem\//i, /(?:^|\/)dreem.*\.(?:csv|json)$/i],
  confidencePatterns: [{ pattern: /(?:^|\/)dreem\//i, weight: 4 }],
  priorityPatterns: [/(?:^|\/)dreem/i]
};
