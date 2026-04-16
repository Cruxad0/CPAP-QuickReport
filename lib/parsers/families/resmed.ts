import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const RESMED_FAMILY: ParserFamilyDefinition = {
  id: "resmed",
  label: "ResMed",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/resmed_loader.cpp",
  signaturePatterns: [
    /(?:^|\/)datalog\//i,
    /(?:^|\/)str\.edf(?:\.gz)?$/i,
    /(?:^|\/)eve\.edf(?:\.gz)?$/i,
    /(?:^|\/)identification\.(?:tgt|json)$/i
  ],
  confidencePatterns: [
    { pattern: /(?:^|\/)datalog\/.*\/str\.edf(?:\.gz)?$/i, weight: 4 },
    { pattern: /(?:^|\/)datalog\/.*\/(?:eve|pld|brp|sad|crc)\.edf(?:\.gz)?$/i, weight: 2 },
    { pattern: /(?:^|\/)identification\.(?:tgt|json)$/i, weight: 2 }
  ],
  priorityPatterns: [
    /(?:^|\/)datalog\/.*\/(?:str|eve|pld|sad|brp|crc)\.edf(?:\.gz)?$/i,
    /(?:^|\/)(?:str|eve|pld|sad|brp|crc)\.edf(?:\.gz)?$/i,
    /(?:^|\/)identification\.(?:tgt|json)$/i,
    /(?:^|\/)settings\/[^/]+\.(?:tgt|json|txt|xml|log)$/i,
    /(?:^|\/)(?:settings|summary)\.edf(?:\.gz)?$/i
  ]
};
