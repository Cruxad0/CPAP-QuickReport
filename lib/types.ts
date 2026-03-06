export type DataSourceKind = "folder" | "zip";

export interface SourceFile {
  name: string;
  path: string;
  size: number;
  readText: () => Promise<string>;
  readBytes: () => Promise<Uint8Array>;
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
  residualApneas?: number;
  centralApneas?: number;
  reraIndex?: number;
  leak?: number;
  pressureAvg?: number;
  pressure95th?: number;
}

export interface MachineSettings {
  device?: string;
  mode?: string;
  pressure?: string;
  pressureMin?: string;
  pressureMax?: string;
  pressureAvg?: number | null;
  pressure95th?: number | null;
  pressureIsAuto?: boolean;
  pressureRelief?: string;
}

export interface QuickReportMetrics {
  generatedAtIso: string;
  generatedAtDisplay: string;
  selectedLoader: string;
  patientName: string;
  dateOfBirth: string;
  physicianName: string;
  dateRangeStart: string;
  dateRangeEnd: string;
  daysInWindow: number;
  daysWithData: number;
  daysWithUsage: number;
  usageDaysPercent: number;
  compliantDays: number;
  compliancePercent: number;
  avgUsageHours: number | null;
  avgAhi: number | null;
  avgResidualApneas: number | null;
  avgCentralApneas: number | null;
  avgReraIndex: number | null;
  ahi95th: number | null;
  residualApneas95th: number | null;
  centralApneas95th: number | null;
  rera95th: number | null;
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
  lookbackDays?: number;
  onProgress?: (p: ParseProgress) => void;
}
