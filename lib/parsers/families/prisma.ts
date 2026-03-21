import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const PRISMA_FAMILY: ParserFamilyDefinition = {
  id: "prisma",
  label: "Lowe / Prisma",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/prisma_loader.cpp",
  signaturePatterns: [/(?:^|\/)therapy\.pdat$/i, /(?:^|\/)therapy\//i],
  confidencePatterns: [{ pattern: /(?:^|\/)therapy\.pdat$/i, weight: 4 }],
  priorityPatterns: [/(?:^|\/)(?:therapy\.pdat|therapy\/)/i]
};
