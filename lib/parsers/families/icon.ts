import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const ICON_FAMILY: ParserFamilyDefinition = {
  id: "icon",
  label: "Fisher & Paykel ICON",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/icon_loader.cpp",
  signaturePatterns: [/(?:^|\/)fphcare\/icon\/[^/]+\/sum.*\.fph$/i, /(?:^|\/)fphcare\/icon\/[^/]+\/flw.*\.fph$/i],
  confidencePatterns: [
    { pattern: /(?:^|\/)fphcare\/icon\/[^/]+\/flw.*\.fph$/i, weight: 4 },
    { pattern: /(?:^|\/)fphcare\/icon\/[^/]+\/det.*\.fph$/i, weight: 2 }
  ],
  priorityPatterns: [/(?:^|\/)fphcare\/icon\/[^/]+\/(?:sum|det|flw).*\.(?:fph|FPH)$/i]
};
