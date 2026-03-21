import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const CMS50F37_FAMILY: ParserFamilyDefinition = {
  id: "cms50f37",
  label: "Contec CMS50F3.7",
  supportedQuickReport: false,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/cms50f37_loader.cpp",
  signaturePatterns: [/(?:^|\/)[^/]+\.(?:spo2|spo|spor)$/i, /(?:^|\/)cms50f(?:3\.7|37|d\+|i|h)?/i],
  confidencePatterns: [
    { pattern: /(?:^|\/)[^/]+\.(?:spo2|spo|spor)$/i, weight: 4 },
    { pattern: /(?:^|\/)cms50f(?:3\.7|37|d\+|i|h)?/i, weight: 3 }
  ],
  priorityPatterns: [/(?:^|\/)(?:cms50f.*|[^/]+\.(?:spo2|spo|spor))$/i]
};
