import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const RESMED_FAMILY: ParserFamilyDefinition = {
  id: "resmed",
  label: "ResMed",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/resmed_loader.cpp",
  signaturePatterns: [/(?:^|\/)datalog\//i, /(?:^|\/)str\.edf$/i, /(?:^|\/)eve\.edf$/i],
  confidencePatterns: [
    { pattern: /(?:^|\/)datalog\/.*\/str\.edf$/i, weight: 4 },
    { pattern: /(?:^|\/)datalog\/.*\/(?:eve|pld|brp|sad)\.edf$/i, weight: 2 }
  ],
  priorityPatterns: [/(?:^|\/)datalog\/.*\/(?:str|eve|pld|sad|brp|crc)\.edf$/i, /(?:^|\/)(?:settings|summary)\.edf$/i]
};
