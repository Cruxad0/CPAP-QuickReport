import type { ParserFamilyDefinition } from "@/lib/parsers/families/types";

export const PRISMA_FAMILY: ParserFamilyDefinition = {
  id: "prisma",
  label: "Loewenstein / Prisma",
  supportedQuickReport: true,
  parserStrategy: "generic-text",
  oscarLoader: "OSCAR-code-ref-2/oscar/SleepLib/loader_plugins/prisma_loader.cpp",
  signaturePatterns: [/(?:^|\/)config\.pscfg$/i, /(?:^|\/)config\.pcfg$/i, /(?:^|\/)therapy\.pdat$/i],
  confidencePatterns: [
    { pattern: /(?:^|\/)config\.pscfg$/i, weight: 4 },
    { pattern: /(?:^|\/)config\.pcfg$/i, weight: 4 },
    { pattern: /(?:^|\/)therapy\.pdat$/i, weight: 2 }
  ],
  priorityPatterns: [/(?:^|\/)(?:config\.pscfg|config\.pcfg|therapy\.pdat)$/i, /(?:^|\/)(?:event_|signal_).*\.(?:xml|wmedf)$/i]
};
