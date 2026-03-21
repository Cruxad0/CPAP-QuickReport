import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const SOMNOPOSE_FAMILY: ParserFamilyDefinition = {
  id: "somnopose",
  label: "Somnopose",
  supportedQuickReport: false,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/somnopose_loader.cpp",
  signaturePatterns: [/(?:^|\/).*somnopose.*\.csv$/i],
  confidencePatterns: [{ pattern: /(?:^|\/).*somnopose.*\.csv$/i, weight: 4 }],
  priorityPatterns: [/(?:^|\/).*\.(?:csv)$/i]
};
