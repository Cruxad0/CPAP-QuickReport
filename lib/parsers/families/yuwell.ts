import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const YUWELL_FAMILY: ParserFamilyDefinition = {
  id: "yuwell",
  label: "Yuwell",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-SQL/oscar/SleepLib/loader_plugins/yuwell_loader.cpp",
  signaturePatterns: [
    /(?:^|\/)yhsd-new\.bys$/i,
    /(?:^|\/)runlog\.bys$/i,
    /(?:^|\/)sn\.bys$/i,
    /(?:^|\/)yh[^/]+\/.*\.bys$/i
  ],
  confidencePatterns: [
    { pattern: /(?:^|\/)yhsd-new\.bys$/i, weight: 8 },
    { pattern: /(?:^|\/)runlog\.bys$/i, weight: 4 },
    { pattern: /(?:^|\/)sn\.bys$/i, weight: 4 },
    { pattern: /(?:^|\/)yh[^/]+\/.*\.bys$/i, weight: 4 }
  ],
  priorityPatterns: [/(?:^|\/).*\.bys$/i]
};
