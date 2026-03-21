import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const VREM_FAMILY: ParserFamilyDefinition = {
  id: "vrem",
  label: "VREM",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/vrem_loader.cpp",
  signaturePatterns: [/(?:^|\/)(?:vrem[^/]*\/)?pi\.txt$/i, /(?:^|\/)(?:vrem[^/]*\/)?di\.txt$/i],
  confidencePatterns: [
    { pattern: /(?:^|\/)(?:vrem[^/]*\/)?pi\.txt$/i, weight: 4 },
    { pattern: /(?:^|\/)(?:vrem[^/]*\/)?di\.txt$/i, weight: 3 },
    { pattern: /(?:^|\/)(?:vrem[^/]*\/)?od[^/]+\//i, weight: 2 }
  ],
  priorityPatterns: [/(?:^|\/)(?:vrem[^/]*\/)?(?:pi\.txt|di\.txt)$/i, /(?:^|\/)(?:vrem[^/]*\/)?od[^/]+\//i]
};
