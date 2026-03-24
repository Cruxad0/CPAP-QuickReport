import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const SLEEPSTYLE_FAMILY: ParserFamilyDefinition = {
  id: "sleepstyle",
  label: "Fisher & Paykel SleepStyle",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/sleepstyle_loader.cpp",
  signaturePatterns: [/(?:^|\/)(?:fphcare\/)?icon\/[^/]+\/sum.*\.fph$/i, /(?:^|\/)(?:fphcare\/)?icon\/[^/]+\/his.*\.fph$/i],
  confidencePatterns: [
    { pattern: /(?:^|\/)(?:fphcare\/)?icon\/[^/]+\/his.*\.fph$/i, weight: 4 },
    { pattern: /(?:^|\/)(?:fphcare\/)?icon\/[^/]+\/realtime\/hrd.*\.edf$/i, weight: 4 },
    { pattern: /(?:^|\/)(?:fphcare\/)?icon\/[^/]+\/det.*\.fph$/i, weight: 2 }
  ],
  priorityPatterns: [
    /(?:^|\/)(?:fphcare\/)?icon\/[^/]+\/(?:sum|det|his).*\.(?:fph|FPH)$/i,
    /(?:^|\/)(?:fphcare\/)?icon\/[^/]+\/realtime\/hrd.*\.edf$/i
  ]
};
