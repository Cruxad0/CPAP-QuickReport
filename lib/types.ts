export type DataSourceKind = "folder" | "zip";

export interface SourceFile {
  name: string;
  path: string;
  size: number;
  readText: () => Promise<string>;
  readBytes: () => Promise<Uint8Array>;
}

export interface SourceFileSummary {
  name: string;
  path: string;
  size: number;
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
  leak95th?: number;
  leakMax?: number;
  leakMax30m?: number;
  leakMax60m?: number;
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
  epap?: string;
  ipap?: string;
  respiratoryRate?: string;
  pressureRelief?: string;
  rampTime?: string;
  rampPressure?: string;
}

export interface QuickReportMetrics {
  generatedAtIso: string;
  generatedAtDisplay: string;
  selectedLoader: string;
  sourceTimeZoneOffsetMinutes?: number | null;
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
  leak95th: number | null;
  maxLeak: number | null;
  maxLeak30m: number | null;
  maxLeak60m: number | null;
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

export interface PrepareQuickReportSourceRequest {
  sourceKind: DataSourceKind;
  files: SourceFile[];
  lookbackDays?: number;
  onProgress?: (p: ParseProgress) => void;
}

export interface BuildQuickReportMetricsFromPreparedRequest {
  patientName: string;
  dateOfBirthIso: string;
  physicianName: string;
  lookbackDays?: number;
  windowEndClinicalDayIso?: string;
  onProgress?: (p: ParseProgress) => void;
}

export interface PreparedDayBucket {
  usageSum: number;
  usageCount: number;
  ahiWeightedSum: number;
  ahiWeightHours: number;
  ahiSum: number;
  ahiCount: number;
  residualApneaSum: number;
  residualApneaCount: number;
  centralApneaSum: number;
  centralApneaCount: number;
  reraSum: number;
  reraCount: number;
  leakSum: number;
  leakCount: number;
  leak95Sum: number;
  leak95Count: number;
  leakMax: number | null;
  leakMax30m: number | null;
  leakMax60m: number | null;
  pressureAvgSum: number;
  pressureAvgCount: number;
  pressure95Sum: number;
  pressure95Count: number;
}

export interface PreparedQuickReportSource {
  selectedLoader: string;
  machine: MachineSettings;
  sourceTimeZoneOffsetMinutes?: number | null;
  warnings: string[];
  latestClinicalDayIso: string;
  maxLookbackDays: number;
  dayBuckets: Record<string, PreparedDayBucket>;
}

export interface GeneratedPdfArtifact {
  days: number;
  metrics: QuickReportMetrics;
  blob: Blob;
  filename: string;
}
