export type DataSourceKind = "folder" | "zip";

export interface SourceFile {
  name: string;
  path: string;
  size: number;
  readText: () => Promise<string>;
}

export interface ParseProgress {
  phase: string;
  detail: string;
  percent: number;
}

export interface ParsedRecord {
  date: Date;
  usageHours?: number;
  ahi?: number;
  leak?: number;
}

export interface MachineSettings {
  device?: string;
  mode?: string;
  pressure?: string;
  pressureRelief?: string;
}

export interface QuickReportMetrics {
  generatedAtIso: string;
  generatedAtDisplay: string;
  patientName: string;
  dateOfBirth: string;
  physicianName: string;
  dateRangeStart: string;
  dateRangeEnd: string;
  daysInWindow: number;
  daysWithData: number;
  usageDaysPercent: number;
  compliantDays: number;
  compliancePercent: number;
  avgUsageHours: number;
  avgAhi: number;
  ahi95th: number;
  avgLeak: number | null;
  maxLeak: number | null;
  machine: MachineSettings;
  warnings: string[];
}

export interface ParseRequest {
  sourceKind: DataSourceKind;
  files: SourceFile[];
  patientName: string;
  dateOfBirthIso: string;
  physicianName: string;
  onProgress?: (p: ParseProgress) => void;
}
