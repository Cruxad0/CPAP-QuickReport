import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const INTELLIPAP_FAMILY: ParserFamilyDefinition = {
  id: "intellipap",
  label: "DeVilbiss IntelliPAP",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/intellipap_loader.cpp",
  signaturePatterns: [/(?:^|\/)sl\/set1$/i, /(?:^|\/)dv6\/set\.bin$/i],
  confidencePatterns: [
    { pattern: /(?:^|\/)sl\/set1$/i, weight: 4 },
    { pattern: /(?:^|\/)dv6\/set\.bin$/i, weight: 4 },
    { pattern: /(?:^|\/)dv6\/s\.bin$/i, weight: 3 }
  ],
  priorityPatterns: [/(?:^|\/)(?:sl\/(?:set1|u|l)|dv6\/(?:set\.bin|ver\.bin|s\.bin))$/i]
};
