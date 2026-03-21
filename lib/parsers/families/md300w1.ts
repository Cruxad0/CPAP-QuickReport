import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const MD300W1_FAMILY: ParserFamilyDefinition = {
  id: "md300w1",
  label: "ChoiceMMed MD300W1",
  supportedQuickReport: false,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/md300w1_loader.cpp",
  signaturePatterns: [/(?:^|\/).*md300.*\.dat$/i, /(?:^|\/).*medview.*\.dat$/i],
  confidencePatterns: [
    { pattern: /(?:^|\/).*md300.*\.dat$/i, weight: 4 },
    { pattern: /(?:^|\/).*medview.*\.dat$/i, weight: 3 }
  ],
  priorityPatterns: [/(?:^|\/).*\.(?:dat)$/i]
};
