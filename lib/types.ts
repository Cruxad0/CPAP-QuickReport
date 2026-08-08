export type DataSourceKind = "folder" | "zip";

export interface SourceFile {
  name: string;
  path: string;
  size: number;
  lastModifiedMs?: number;
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
  /**
   * Present only when the source exposes an actual therapy-session boundary.
   * Daily summaries and dates inferred from folder names intentionally leave
   * these unset so they cannot be mistaken for session-level evidence.
   */
  therapySessionStart?: Date;
  therapySessionEnd?: Date;
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
  maxLeakDurationValue?: number;
  maxLeakMinutes?: number;
  sustainedLeakMax?: number;
  sustainedLeakMinutes?: number;
  pressureAvg?: number;
  pressure95th?: number;
  ipapAvg?: number;
  ipap95th?: number;
  epapAvg?: number;
  epap95th?: number;
  tidalVolumeAvg?: number;
  tidalVolumeMin?: number;
  tidalVolumeMedian?: number;
  tidalVolumeMax?: number;
  tidalVolumeSampleCount?: number;
  tidalVolumeBins?: Record<string, number>;
  tidalVolumeSecondsByBin?: Record<string, number>;
  respiratoryRateAvg?: number;
  respiratoryRate95th?: number;
  respiratoryRateSampleCount?: number;
  respiratoryRateBins?: Record<string, number>;
  respiratoryRateMin?: number;
  therapySettingsSignature?: string;
  therapySettingsLabel?: string;
  therapySettingsMachine?: MachineSettings;
}

export interface MachineSettings {
  device?: string;
  mode?: string;
  pressure?: string;
  pressureMin?: string;
  pressureMax?: string;
  pressureAvg?: number | null;
  pressure95th?: number | null;
  ipapAvg?: number | null;
  ipap95th?: number | null;
  epapAvg?: number | null;
  epap95th?: number | null;
  pressureIsAuto?: boolean;
  epap?: string;
  ipap?: string;
  respiratoryRate?: string;
  respiratoryRateAvg?: number | null;
  respiratoryRateMin?: number | null;
  respiratoryRate95th?: number | null;
  tidalVolume?: string;
  tidalVolumeAvg?: number | null;
  tidalVolumeMin?: number | null;
  tidalVolumeMinMinutes?: number | null;
  tidalVolumeMedian?: number | null;
  tidalVolumeMax?: number | null;
  tidalVolumeMaxMinutes?: number | null;
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
  totalTherapyHours?: number | null;
  expectedSleepTherapyHours?: number | null;
  suspectedNapTherapyHours?: number | null;
  unclassifiedTherapyHours?: number | null;
  avgExpectedSleepTherapyHours?: number | null;
  avgSuspectedNapTherapyHours?: number | null;
  sleepTimingAnalysis?: SleepTimingAnalysis | null;
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
  maxLeakMinutes?: number | null;
  maxLeakAtLeastOneMinute?: number | null;
  maxLeakAtLeastOneMinuteMinutes?: number | null;
  sustainedLeakMax?: number | null;
  sustainedLeakMinutes?: number | null;
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
  userTimeZoneOffsetMinutes?: number | null;
  onProgress?: (p: ParseProgress) => void;
}

export interface BuildQuickReportMetricsFromPreparedRequest {
  patientName: string;
  dateOfBirthIso: string;
  physicianName: string;
  lookbackDays?: number;
  windowEndClinicalDayIso?: string;
  therapyPeriodKind?: TherapyPeriodKind;
  onProgress?: (p: ParseProgress) => void;
}

export type TherapyPeriodKind = "current" | "previous";

export interface TherapySettingsPeriod {
  kind: TherapyPeriodKind;
  signature: string;
  label: string;
  startClinicalDayIso: string;
  endClinicalDayIso: string;
  daysWithData: number;
  machine?: MachineSettings;
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
  maxLeakMinutes?: number | null;
  sustainedLeakMax?: number | null;
  sustainedLeakMinutes?: number | null;
  pressureAvgSum: number;
  pressureAvgCount: number;
  pressure95Sum: number;
  pressure95Count: number;
  ipapAvgSum: number;
  ipapAvgCount: number;
  ipap95Sum: number;
  ipap95Count: number;
  epapAvgSum: number;
  epapAvgCount: number;
  epap95Sum: number;
  epap95Count: number;
  tidalVolumeSum: number;
  tidalVolumeCount: number;
  tidalVolumeMin: number | null;
  tidalVolumeMax: number | null;
  tidalVolumeBins: Record<string, number>;
  tidalVolumeSecondsByBin: Record<string, number>;
  respiratoryRateSum: number;
  respiratoryRateCount: number;
  respiratoryRateMin: number | null;
  respiratoryRateBins: Record<string, number>;
  therapySettingsSignature?: string | null;
  therapySettingsLabel?: string | null;
  therapySettingsMachine?: MachineSettings | null;
}

export interface PreparedQuickReportSource {
  selectedLoader: string;
  machine: MachineSettings;
  sourceTimeZoneOffsetMinutes?: number | null;
  warnings: string[];
  historyStartClinicalDayIso?: string | null;
  latestClinicalDayIso: string;
  maxLookbackDays: number;
  therapySettingsPeriods?: TherapySettingsPeriod[];
  therapySessions?: TherapyUsageSession[];
  sleepTimingProfile?: SleepTimingProfile | null;
  dayBuckets: Record<string, PreparedDayBucket>;
}

export interface TherapyUsageSession {
  startIso: string;
  endIso: string;
  sourceClinicalDayIso?: string;
}

export type SleepTimingConfidence = "high" | "moderate" | "low";

export interface SleepTimingProfile {
  anchorMinutes: number;
  typicalDurationMinutes: number;
  sleepWindowStartMinutes: number;
  sleepWindowEndMinutes: number;
  sleepDayBoundaryMinutes: number;
  confidence: SleepTimingConfidence;
  confidenceScore: number;
  supportingDays: number;
  observedDays: number;
  scheduleDriftDetected: boolean;
}

export interface SleepTimingAnalysis extends SleepTimingProfile {
  method: "inferred-session-timing" | "daily-total-fallback";
  timingCoveragePercent: number;
  cmsShortBreakMinutes: number;
}

export interface GeneratedPdfArtifact {
  days: number;
  metrics: QuickReportMetrics;
  blob: Blob;
  filename: string;
}
