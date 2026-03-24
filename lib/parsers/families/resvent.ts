import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const RESVENT_FAMILY: ParserFamilyDefinition = {
  id: "resvent",
  label: "Resvent / Hoffrichter",
  supportedQuickReport: true,
  parserStrategy: "resvent-structured",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/resvent_loader.cpp",
  signaturePatterns: [/(?:^|\/)(?:therapy\/)?record\//i, /(?:^|\/)(?:therapy\/)?config\//i],
  confidencePatterns: [
    { pattern: /(?:^|\/)(?:therapy\/)?record\/\d{6}\/\d{2}\/stat(?:\d{1,4})?(?:\..*)?$/i, weight: 4 },
    { pattern: /(?:^|\/)(?:therapy\/)?record\/\d{6}\/\d{2}\/(?:ev\d{2}|p\d{2}_\d+|w\d{2}_\d+)(?:\..*)?$/i, weight: 3 },
    { pattern: /(?:^|\/)(?:therapy\/)?config\//i, weight: 2 }
  ],
  priorityPatterns: [
    /(?:^|\/)(?:therapy\/)?record\/\d{6}\/\d{2}\/(?:stat\d{0,4}|ev\d{2}|p\d{2}_\d+|w\d{2}_\d+)(?:\..*)?$/i,
    /(?:^|\/)(?:therapy\/)?config\//i
  ]
};
