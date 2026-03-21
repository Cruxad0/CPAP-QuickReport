export type ParserStrategy = "resvent-structured" | "generic-text";

export interface FamilyConfidencePattern {
  pattern: RegExp;
  weight: number;
}

export interface ParserFamilyDefinition {
  id: string;
  label: string;
  supportedQuickReport: boolean;
  parserStrategy: ParserStrategy;
  oscarLoader: string;
  signaturePatterns: RegExp[];
  confidencePatterns: FamilyConfidencePattern[];
  priorityPatterns: RegExp[];
}

export interface SourceMetaLike {
  normalizedPath: string;
}

export interface LoaderMatch {
  id: string;
  label: string;
  score: number;
  family: ParserFamilyDefinition;
}
