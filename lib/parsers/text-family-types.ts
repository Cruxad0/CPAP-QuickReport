import type { ParseProgress, ParsedRecord, QuickReportMetrics, SourceFile } from "@/lib/types";

export interface FamilyParserCandidate {
  file: SourceFile;
  normalizedPath: string;
  baseName: string;
  recordDate: Date | null;
}

export interface FamilyParserContext {
  familyLabel: string;
  candidates: FamilyParserCandidate[];
  lookbackDays: number;
  machine: QuickReportMetrics["machine"];
  records: ParsedRecord[];
  warnings: string[];
  onProgress?: (progress: ParseProgress) => void;
  progressStart: number;
  progressEnd: number;
}

export interface FamilyParserDeps {
  emit: (onProgress: FamilyParserContext["onProgress"], progress: ParseProgress) => void;
  decodeLikelyTextVariants: (bytes: Uint8Array) => string[];
  inferMachineSettingsFromText: (text: string, machine: QuickReportMetrics["machine"]) => void;
  parseKeyValueLines: (text: string) => Map<string, string>;
  inferPressureSettingsFromMap: (configMap: Map<string, string>, machine: QuickReportMetrics["machine"]) => void;
  inferBilevelSettingsFromMap: (configMap: Map<string, string>, machine: QuickReportMetrics["machine"]) => void;
  inferPressureReliefFromMap: (configMap: Map<string, string>, machine: QuickReportMetrics["machine"]) => void;
  parseResventStatText: (text: string, fallbackDate: Date) => ParsedRecord | null;
  parseGenericDailyKeyValueRecord: (text: string, fallbackDate: Date) => ParsedRecord | null;
  parseRecords: (text: string) => ParsedRecord[];
  sanitizeRecords: (records: ParsedRecord[]) => ParsedRecord[];
  dedupeParsedRecords: (records: ParsedRecord[]) => ParsedRecord[];
}

export interface FamilyTextHooks {
  inferFamilyMachineSettings?: (
    text: string,
    candidate: FamilyParserCandidate,
    machine: QuickReportMetrics["machine"],
    deps: FamilyParserDeps
  ) => void;
}
