import {
  classifyTherapyMode,
  isAutoBiPapLikeMode,
  isAutoPapLikeMode,
  isBiPapLikeMode,
  resolveExplicitTherapyMode,
  type CanonicalTherapyMode
} from "@/lib/machine-mode";
import {
  buildFamilyPriorityPatterns,
  getParserFamily,
  hasFamilySignature,
  isCandidateForFamily,
  rankParserFamilies,
  selectLoaderMatchByDatedRecency,
  type LoaderMatch,
  type ParserFamilyDefinition,
  type RecencyLoaderSelection
} from "@/lib/parsers/families";
import { hasBmcBundleStructure } from "@/lib/parsers/families/bmc";
import { hasBmcG3xCandidateStructure } from "@/lib/parsers/families/bmcg3x";
import { parseBmcFamily } from "@/lib/parsers/bmc";
import { isBmcG3xIdx, parseBmcG3xFamily } from "@/lib/parsers/bmcg3x";
import { parseIconFamily } from "@/lib/parsers/icon";
import { parseIntelliPapFamily } from "@/lib/parsers/intellipap";
import { parseMSeriesFamily } from "@/lib/parsers/mseries";
import { parsePrismaFamily } from "@/lib/parsers/prisma";
import { parsePrs1Family } from "@/lib/parsers/prs1";
import { applyResMedCurrentSettingsJson, parseResMedFamily } from "@/lib/parsers/resmed";
import { parseSleepStyleFamily } from "@/lib/parsers/sleepstyle";
import { runTextFamilyParser } from "@/lib/parsers/text-family-runner";
import type { FamilyParserDeps } from "@/lib/parsers/text-family-types";
import {
  createCalendarDateNoonAtUtcOffset,
  extractExplicitUtcOffsetMinutes,
  normalizeUtcOffsetMinutes
} from "@/lib/timezone";
import {
  buildSleepTimingAnalysis,
  classifyTherapySessions,
  inferSleepTimingProfile
} from "@/lib/sleep-inference";
import { parseVremFamily } from "@/lib/parsers/vrem";
import { parseWeinmannFamily } from "@/lib/parsers/weinmann";
import { parseYuwellFamily } from "@/lib/parsers/yuwell";
import { buildTherapySettingsSnapshot } from "@/lib/therapy-settings";
import {
  BuildQuickReportMetricsFromPreparedRequest,
  ParseRequest,
  ParsedRecord,
  ParseProgress,
  PrepareQuickReportSourceRequest,
  PreparedDayBucket,
  PreparedQuickReportSource,
  QuickReportMetrics,
  SourceFile,
  TherapyUsageSession,
  TherapySettingsPeriod
} from "@/lib/types";

const MAX_GENERIC_FILES_TO_SCAN = 2500;
const MAX_GENERIC_TOTAL_BYTES = 220_000_000;
const MAX_FILE_SIZE_BYTES = 8_000_000;
const MAX_RESVENT_P_TOTAL_BYTES = 96_000_000;
const TEXT_EXTENSIONS = new Set(["csv", "txt", "tsv", "json", "xml", "edf", "log"]);
const GENERIC_BINARY_EXTENSIONS = new Set(["dat", "pdat", "cfg", "ini", "edf", "000", "idx"]);
const MAX_GENERIC_BINARY_FILE_BYTES = 1_500_000;
const GENERIC_NAME_HINT = /(?:^|[_\-.])(stat\d{0,2}|ev\d{0,2}|summary|session|record|therapy|usage|result|detail|event|config|setting)(?:[_\-.]|$)/i;

type DateWindow = {
  start: Date;
  end: Date;
};

const DATE_PATTERNS = [
  /(\d{4})-(\d{2})-(\d{2})/, // yyyy-mm-dd
  /(\d{2})\/(\d{2})\/(\d{4})/ // mm/dd/yyyy
];
const CLINICAL_DAY_CUTOFF_HOUR = 12;

type SourceMeta = {
  file: SourceFile;
  normalizedPath: string;
  baseName: string;
  ext: string;
  recordDate: Date | null;
};

type DayBucket = PreparedDayBucket;

type LeakStats = {
  sum: number;
  count: number;
  max: number;
  sustainedMax30m: number | null;
  sustainedMax60m: number | null;
  maxLeakMinutes: number | null;
  sustainedLeakMax: number | null;
  sustainedLeakMinutes: number | null;
};

type RollingAverageState = {
  values: Float64Array;
  capacity: number;
  nextIndex: number;
  length: number;
  sum: number;
};

type ReportSummaryAggregationPolicy = {
  averageRateMetricsByUsage: boolean;
  pressure95Aggregation: "daily-value-percentile" | "daily-summary-mean";
};

const LARGE_LEAK_THRESHOLD_LPM = 30;
const MIN_REPORTABLE_MAX_LEAK_MINUTES = 1;
const MIN_SESSION_TIMING_COVERAGE_PERCENT = 70;
const MAX_SESSION_TIMING_COVERAGE_PERCENT = 105;
const RESVENT_DEVICE_EPOCH_OFFSET_MINUTES = 8 * 60;

type ResventTimedRecord = {
  record: ParsedRecord;
  sourceFile: SourceFile;
};

function localWallClockTimestamp(timestampMs: number): number {
  const date = new Date(timestampMs);
  const utcOffsetMinutes = -date.getTimezoneOffset();
  return timestampMs + utcOffsetMinutes * 60 * 1000;
}

function resolveResventSessionClockOffset(entries: ResventTimedRecord[]): {
  offsetMinutes: number;
  verifiedFileCount: number;
} {
  const candidates: number[] = [];
  for (const entry of entries) {
    const end = entry.record.therapySessionEnd;
    const lastModifiedMs = entry.sourceFile.lastModifiedMs;
    if (!end || typeof lastModifiedMs !== "number" || !Number.isFinite(lastModifiedMs)) continue;

    const rawOffsetMinutes = (localWallClockTimestamp(lastModifiedMs) - end.getTime()) / 60_000;
    const roundedOffsetMinutes = Math.round(rawOffsetMinutes / 15) * 15;
    if (
      Math.abs(rawOffsetMinutes - roundedOffsetMinutes) <= 2 &&
      Math.abs(roundedOffsetMinutes) <= 14 * 60
    ) {
      candidates.push(roundedOffsetMinutes);
    }
  }

  const counts = new Map<number, number>();
  for (const candidate of candidates) {
    counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
  }
  const strongest = [...counts.entries()].sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]))[0];
  const requiredSupport = Math.max(2, Math.ceil(candidates.length * 0.6));
  if (strongest && strongest[1] >= requiredSupport) {
    return { offsetMinutes: strongest[0], verifiedFileCount: strongest[1] };
  }

  return {
    offsetMinutes: RESVENT_DEVICE_EPOCH_OFFSET_MINUTES,
    verifiedFileCount: 0
  };
}

function applySessionClockOffset(record: ParsedRecord, offsetMinutes: number) {
  if (offsetMinutes === 0) return;
  const offsetMs = offsetMinutes * 60_000;
  if (record.therapySessionStart) {
    record.therapySessionStart = new Date(record.therapySessionStart.getTime() + offsetMs);
  }
  if (record.therapySessionEnd) {
    record.therapySessionEnd = new Date(record.therapySessionEnd.getTime() + offsetMs);
  }
}

const RESVENT_MODE_FROM_FILE = new Map<string, string>([
  ["N_CPAP", "CPAP"],
  ["N_APAP", "APAP"],
  ["N_S30", "S30"],
  ["N_AS30", "Auto S30"],
  ["N_ST30", "ST30"],
  ["N_AST30", "Auto ST30"],
  ["N_T30", "T30"],
  ["N_PC", "PC"]
]);

const RESVENT_MODE_FROM_VENT_MODE = new Map<string, string>([
  ["1", "CPAP"],
  ["3", "APAP"],
  ["10", "S30"],
  ["11", "Auto S30"],
  ["12", "ST30"],
  ["13", "Auto ST30"],
  ["14", "T30"],
  ["15", "PC"]
]);

const RESVENT_SHARED_CONFIG_FILES = ["ALARM", "COMFORT", "CHECK.TXT", "SETTING", "VERSION", "SYSCFG", "TCTRL"] as const;

const RESVENT_ACTIVE_CONFIG_BY_VENT_MODE = new Map<string, string>([
  ["1", "N_CPAP"],
  ["3", "N_APAP"],
  ["10", "N_S30"],
  ["11", "N_AS30"],
  ["12", "N_ST30"],
  ["13", "N_AST30"],
  ["14", "N_T30"],
  ["15", "N_PC"]
]);

function getReportSummaryAggregationPolicy(selectedLoader: string): ReportSummaryAggregationPolicy {
  if (/^resvent\s*\/\s*hoffrichter$/i.test(selectedLoader.trim())) {
    return {
      averageRateMetricsByUsage: true,
      pressure95Aggregation: "daily-summary-mean"
    };
  }

  return {
    averageRateMetricsByUsage: false,
    pressure95Aggregation: "daily-value-percentile"
  };
}

function formatCmH2O(raw: unknown): string | null {
  const n = safeNumber(raw);
  if (n === undefined) return null;
  const cm = n / 100;
  if (!Number.isFinite(cm)) return null;
  return `${Number(cm.toFixed(2)).toString()}`;
}

function safeNumber(input: unknown): number | undefined {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input !== "string") return undefined;
  const n = Number.parseFloat(input.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : undefined;
}

function normalizePressureNumber(raw: number | undefined): number | undefined {
  if (raw === undefined || !Number.isFinite(raw)) return undefined;
  if (raw < 0) return undefined;
  if (raw <= 80) return raw;
  if (raw <= 8000) return raw / 100;
  return undefined;
}

function isReportPressureMetric(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 80;
}

function isReportRespiratoryRateMetric(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 120;
}

function isReportTidalVolumeMetric(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 5;
}

function sameLeakMetricValue(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.001;
}

function normalizeTidalVolumeMl(raw: number | undefined, unitHint = ""): number | undefined {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return undefined;
  const text = unitHint.toLowerCase();
  const hasMlUnit = /\b(?:ml|milliliter|millilitre|milliliters|millilitres)\b/.test(text);
  const hasLiterUnit = !hasMlUnit && /\b(?:l|liter|litre|liters|litres)\b/.test(text);
  const ml = hasLiterUnit || (!hasMlUnit && raw <= 5) ? raw * 1000 : raw;
  if (!Number.isFinite(ml) || ml < 20 || ml > 5000) return undefined;
  return ml;
}

function tidalVolumeText(value: number | undefined, unitHint = ""): string | undefined {
  const ml = normalizeTidalVolumeMl(value, unitHint);
  if (ml === undefined) return undefined;
  return `${Number(ml.toFixed(1)).toString()} mL`;
}

function pressureText(value: number | undefined): string | undefined {
  const n = normalizePressureNumber(value);
  if (n === undefined) return undefined;
  return `${Number(n.toFixed(2)).toString()} cmH2O`;
}

function rampTimeText(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  if (value === 0) return "Off";
  const minutes = Number(value.toFixed(2));
  return `${minutes.toString()} ${minutes === 1 ? "minute" : "minutes"}`;
}

function isOffSettingText(value: string | undefined): boolean {
  return typeof value === "string" && /^(?:off|disabled|false|no|0)$/i.test(value.trim());
}

const isLikelyAutoMode = isAutoPapLikeMode;
const isLikelyBiPapMode = isBiPapLikeMode;

function createUtcDateNoon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function createLocalCalendarDateNoon(date: Date): Date {
  return createUtcDateNoon(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function parseDateFromString(value: string): Date | null {
  const isoDateTime = /(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/;
  const usDateTime = /(\d{2})\/(\d{2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/;
  const isoDateTimeMatch = isoDateTime.exec(value);
  if (isoDateTimeMatch) {
    const y = Number(isoDateTimeMatch[1]);
    const mon = Number(isoDateTimeMatch[2]);
    const d = Number(isoDateTimeMatch[3]);
    const h = Number(isoDateTimeMatch[4]);
    const min = Number(isoDateTimeMatch[5]);
    const sec = Number(isoDateTimeMatch[6] ?? "0");
    const dt = new Date(Date.UTC(y, mon - 1, d, h, min, sec));
    if (!Number.isNaN(dt.getTime())) return dt;
  }

  const usDateTimeMatch = usDateTime.exec(value);
  if (usDateTimeMatch) {
    const mon = Number(usDateTimeMatch[1]);
    const d = Number(usDateTimeMatch[2]);
    const y = Number(usDateTimeMatch[3]);
    const h = Number(usDateTimeMatch[4]);
    const min = Number(usDateTimeMatch[5]);
    const sec = Number(usDateTimeMatch[6] ?? "0");
    const dt = new Date(Date.UTC(y, mon - 1, d, h, min, sec));
    if (!Number.isNaN(dt.getTime())) return dt;
  }

  for (const pattern of DATE_PATTERNS) {
    const m = pattern.exec(value);
    if (!m) continue;
    if (pattern === DATE_PATTERNS[0]) {
      const y = Number(m[1]);
      const mon = Number(m[2]);
      const d = Number(m[3]);
      const dt = createUtcDateNoon(y, mon, d);
      if (!Number.isNaN(dt.getTime())) return dt;
    } else {
      const mon = Number(m[1]);
      const d = Number(m[2]);
      const y = Number(m[3]);
      const dt = createUtcDateNoon(y, mon, d);
      if (!Number.isNaN(dt.getTime())) return dt;
    }
  }
  return null;
}

function extractUsageSuffix(baseName: string, prefix: "stat" | "ev"): string | null {
  const re = new RegExp(`^${prefix}(\\d{2})(?:\\..*)?$`, "i");
  const m = re.exec(baseName);
  return m?.[1] ?? null;
}

function extractResventPUsageSuffix(baseName: string): string | null {
  const m = /^p(\d{2})_\d+(?:\..*)?$/i.exec(baseName);
  return m?.[1] ?? null;
}

function toIsoDate(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

function toClinicalDay(date: Date): Date {
  const shifted = new Date(date.getTime() - CLINICAL_DAY_CUTOFF_HOUR * 60 * 60 * 1000);
  return createUtcDateNoon(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

function toClinicalIsoDate(date: Date): string {
  return toIsoDate(toClinicalDay(date));
}

function extractTherapyUsageSessions(records: ParsedRecord[]): TherapyUsageSession[] {
  const sessions = records
    .map((record) => {
      const start = record.therapySessionStart;
      const end = record.therapySessionEnd;
      if (!start || !end) return null;
      const startMs = start.getTime();
      const endMs = end.getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || endMs - startMs > 24 * 3600 * 1000) {
        return null;
      }
      return {
        startIso: start.toISOString(),
        endIso: end.toISOString(),
        sourceClinicalDayIso: toClinicalIsoDate(record.date)
      };
    })
    .filter(
      (session): session is { startIso: string; endIso: string; sourceClinicalDayIso: string } => session !== null
    )
    .sort((a, b) => a.startIso.localeCompare(b.startIso) || a.endIso.localeCompare(b.endIso));

  return sessions.filter(
    (session, index) =>
      index === 0 ||
      session.startIso !== sessions[index - 1].startIso ||
      session.endIso !== sessions[index - 1].endIso
  );
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const blend = idx - lo;
  return sorted[lo] * (1 - blend) + sorted[hi] * blend;
}

function mergeHistogram(target: Record<string, number>, source: Record<string, number> | undefined) {
  if (!source) return;
  for (const [key, count] of Object.entries(source)) {
    const parsedKey = Number.parseFloat(key);
    if (!Number.isFinite(parsedKey) || !Number.isFinite(count) || count <= 0) continue;
    target[key] = (target[key] ?? 0) + count;
  }
}

function histogramValueAt(entries: Array<[number, number]>, index: number): number {
  let offset = 0;
  for (const [value, count] of entries) {
    if (index < offset + count) return value;
    offset += count;
  }
  return entries.at(-1)?.[0] ?? 0;
}

function histogramPercentile(bins: Record<string, number>, p: number): number | null {
  const entries = Object.entries(bins)
    .map(([key, count]) => [Number.parseFloat(key), count] as [number, number])
    .filter(([value, count]) => Number.isFinite(value) && Number.isFinite(count) && count > 0)
    .sort(([a], [b]) => a - b);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total <= 0) return null;

  const idx = (p / 100) * (total - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const blend = idx - lo;
  if (lo === hi) return histogramValueAt(entries, lo);
  return histogramValueAt(entries, lo) * (1 - blend) + histogramValueAt(entries, hi) * blend;
}

function mergeDayHistograms(
  dayBuckets: DayBucket[],
  key: "tidalVolumeBins" | "tidalVolumeSecondsByBin" | "respiratoryRateBins"
): Record<string, number> {
  const bins: Record<string, number> = {};
  for (const bucket of dayBuckets) mergeHistogram(bins, bucket[key]);
  return bins;
}

function histogramDurationMinutesForValue(secondsByBin: Record<string, number>, value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const seconds = secondsByBin[value.toFixed(3)];
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds / 60 : null;
}

function formatDateHuman(isoDate: string): string {
  const dt = new Date(`${isoDate}T00:00:00Z`);
  return dt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC"
  });
}

type TherapySettingsRun = {
  signature: string;
  label: string;
  startIso: string;
  endIso: string;
  machine?: QuickReportMetrics["machine"];
};

function applyRecordTherapySettings(bucket: DayBucket, record: ParsedRecord) {
  const signature = record.therapySettingsSignature?.trim();
  if (!signature) return;
  const label = record.therapySettingsLabel?.trim() || "Therapy settings";

  if (!bucket.therapySettingsSignature) {
    bucket.therapySettingsSignature = signature;
    bucket.therapySettingsLabel = label;
    bucket.therapySettingsMachine = record.therapySettingsMachine ? cloneMachineSettings(record.therapySettingsMachine) : null;
    return;
  }

  if (bucket.therapySettingsSignature === signature) {
    if (!bucket.therapySettingsMachine && record.therapySettingsMachine) {
      bucket.therapySettingsMachine = cloneMachineSettings(record.therapySettingsMachine);
    }
    return;
  }

  const existingLabels = (bucket.therapySettingsLabel ?? "Therapy settings").split(" + ");
  if (!existingLabels.includes(label)) existingLabels.push(label);
  bucket.therapySettingsSignature = `mixed:${[bucket.therapySettingsSignature, signature].sort().join("|")}`;
  bucket.therapySettingsLabel = existingLabels.join(" + ");
  bucket.therapySettingsMachine = null;
}

function therapySettingsEntries(
  dayMap: Map<string, DayBucket>
): Array<{ day: string; signature: string; label: string; machine?: QuickReportMetrics["machine"] }> {
  const entries: Array<{ day: string; signature: string; label: string; machine?: QuickReportMetrics["machine"] }> = [];
  for (const [day, bucket] of dayMap.entries()) {
    const signature = bucket.therapySettingsSignature?.trim();
    if (!signature) continue;
    entries.push({
      day,
      signature,
      label: bucket.therapySettingsLabel?.trim() || "Therapy settings",
      machine: bucket.therapySettingsMachine ? cloneMachineSettings(bucket.therapySettingsMachine) : undefined
    });
  }
  return entries.sort((a, b) => a.day.localeCompare(b.day));
}

function buildTherapySettingsRuns(
  entries: Array<{ day: string; signature: string; label: string; machine?: QuickReportMetrics["machine"] }>
): TherapySettingsRun[] {
  const runs: TherapySettingsRun[] = [];
  for (const entry of entries) {
    const last = runs.at(-1);
    if (last && last.signature === entry.signature) {
      last.endIso = entry.day;
      if (!last.machine && entry.machine) last.machine = cloneMachineSettings(entry.machine);
      continue;
    }
    runs.push({
      signature: entry.signature,
      label: entry.label,
      startIso: entry.day,
      endIso: entry.day,
      machine: entry.machine ? cloneMachineSettings(entry.machine) : undefined
    });
  }
  return runs;
}

function addIsoCalendarDays(isoDay: string, days: number): string {
  const date = new Date(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDay;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildTherapySettingsPeriods(dayMap: Map<string, DayBucket>, maxPeriodDays = 90): TherapySettingsPeriod[] {
  const runs = buildTherapySettingsRuns(therapySettingsEntries(dayMap)).slice(-2);
  return runs.map((run, idx) => {
    const cappedStartIso = addIsoCalendarDays(run.endIso, -(maxPeriodDays - 1));
    const startClinicalDayIso = run.startIso > cappedStartIso ? run.startIso : cappedStartIso;
    const daysWithData = [...dayMap.keys()].filter((day) => day >= startClinicalDayIso && day <= run.endIso).length;
    return {
      kind: idx === runs.length - 1 ? "current" : "previous",
      signature: run.signature,
      label: run.label,
      startClinicalDayIso,
      endClinicalDayIso: run.endIso,
      daysWithData,
      machine: run.machine ? cloneMachineSettings(run.machine) : undefined
    };
  });
}

function summarizeTherapySettingsRuns(runs: TherapySettingsRun[], maxRuns = 4): string {
  const visibleRuns = runs.slice(-maxRuns);
  const prefix = runs.length > visibleRuns.length ? `... ${runs.length - visibleRuns.length} earlier setting period(s); ` : "";
  return (
    prefix +
    visibleRuns
      .map((run) => {
        const start = formatDateHuman(run.startIso);
        const end = formatDateHuman(run.endIso);
        return run.startIso === run.endIso ? `${run.label} on ${start}` : `${run.label} from ${start} to ${end}`;
      })
      .join("; ")
  );
}

function buildImportedTherapyChangeWarning(dayMap: Map<string, DayBucket>, lookbackDays: number): string | null {
  const entries = therapySettingsEntries(dayMap);
  const distinctSignatures = new Set(entries.map((entry) => entry.signature));
  if (distinctSignatures.size <= 1) return null;

  const latestRun = buildTherapySettingsRuns(entries).at(-1);
  if (!latestRun) return null;

  return `Therapy settings changed during the imported ${lookbackDays}-day history. Reports use the latest settings period: ${latestRun.label} since ${formatDateHuman(latestRun.startIso)}.`;
}

function applyTherapySettingsWindowGuard(
  dayMap: Map<string, DayBucket>,
  warnings: string[],
  lookbackDays: number
): { dayMap: Map<string, DayBucket>; effectiveWindowStartIso: string | null } {
  const entries = therapySettingsEntries(dayMap);
  const distinctSignatures = new Set(entries.map((entry) => entry.signature));
  if (entries.length === 0 || distinctSignatures.size <= 1) {
    return { dayMap, effectiveWindowStartIso: null };
  }

  const runs = buildTherapySettingsRuns(entries);
  const latestRun = runs.at(-1);
  if (!latestRun) return { dayMap, effectiveWindowStartIso: null };

  const filteredDayMap = new Map([...dayMap.entries()].filter(([day]) => day >= latestRun.startIso));
  if (filteredDayMap.size === dayMap.size || filteredDayMap.size === 0) {
    return { dayMap, effectiveWindowStartIso: null };
  }

  const summary = summarizeTherapySettingsRuns(runs);
  warnings.push(
    `Therapy settings changed within the ${lookbackDays}-day report window (${summary}). Calculations were limited to ${latestRun.label} from ${formatDateHuman(latestRun.startIso)} forward to avoid mixing therapy settings.`
  );

  return {
    dayMap: filteredDayMap,
    effectiveWindowStartIso: latestRun.startIso
  };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function extractResventRecordDate(path: string): Date | null {
  const m = /(?:^|\/)(?:therapy\/)?record\/(\d{4})(\d{2})\/(\d{2})(?:\/|$)/i.exec(path);
  if (!m) return null;

  const y = Number(m[1]);
  const mon = Number(m[2]);
  const day = Number(m[3]);
  const dt = createUtcDateNoon(y, mon, day);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function extractGenericPathDate(path: string): Date | null {
  const normalized = normalizePath(path);

  const ymd = /(?:^|[^\d])((?:19|20)\d{2})(\d{2})(\d{2})(?:[^\d]|$)/.exec(normalized);
  if (ymd) {
    const y = Number(ymd[1]);
    const m = Number(ymd[2]);
    const d = Number(ymd[3]);
    const dt = createUtcDateNoon(y, m, d);
    if (!Number.isNaN(dt.getTime())) return dt;
  }

  const y_md = /(?:^|\/)((?:19|20)\d{2})[\/_-](\d{2})[\/_-](\d{2})(?:\/|$)/.exec(normalized);
  if (y_md) {
    const y = Number(y_md[1]);
    const m = Number(y_md[2]);
    const d = Number(y_md[3]);
    const dt = createUtcDateNoon(y, m, d);
    if (!Number.isNaN(dt.getTime())) return dt;
  }

  const parsed = parseDateFromString(normalized.replace(/_/g, "/"));
  if (parsed) return parsed;

  return null;
}

function toSourceMeta(file: SourceFile): SourceMeta {
  const normalizedPath = normalizePath(file.path);
  const baseName = normalizedPath.split("/").pop() ?? normalizedPath;
  const ext = baseName.includes(".") ? baseName.toLowerCase().split(".").pop() ?? "" : "";
  const resventDate = extractResventRecordDate(normalizedPath);
  const genericDate = extractGenericPathDate(normalizedPath);

  return {
    file,
    normalizedPath,
    baseName,
    ext,
    recordDate: resventDate ?? genericDate
  };
}

function isResventConfigFile(meta: SourceMeta): boolean {
  return /(?:^|\/)(?:therapy\/)?config\/[^/]+$/i.test(meta.normalizedPath);
}

function isResventStatUsageFile(meta: SourceMeta): boolean {
  // OSCAR usage sessions are STATxx.
  return meta.recordDate !== null && extractUsageSuffix(meta.baseName, "stat") !== null;
}

function isResventStatSummaryFile(meta: SourceMeta): boolean {
  // Some cards also include plain STAT daily summary.
  return meta.recordDate !== null && /^stat(?:\..*)?$/i.test(meta.baseName);
}

function isResventPFile(meta: SourceMeta): boolean {
  return meta.recordDate !== null && /^p\d{2}_\d+(?:\..*)?$/i.test(meta.baseName);
}

function isResventEvFile(meta: SourceMeta): boolean {
  return meta.recordDate !== null && /^ev\d{2}(?:\..*)?$/i.test(meta.baseName);
}

function inferMachineSettingsFromText(text: string, machine: QuickReportMetrics["machine"]) {
  if (!machine.device) {
    const m = text.match(/^\s*(?:device|machine|model)\s*[:=]\s*([^\n\r]+)/im);
    if (m) machine.device = m[1].trim();
  }
  if (!resolveExplicitTherapyMode(machine.mode)) {
    const m = text.match(/^\s*(?:mode|therapy mode)\s*[:=]\s*([^\n\r]+)/im);
    if (m) {
      machine.mode = m[1].trim();
      if (isLikelyAutoMode(machine.mode)) machine.pressureIsAuto = true;
    }
  }
  if (!machine.pressureRelief) {
    const m = text.match(/^\s*(epr|pressure\s*relief|flex|ipr)\s*[:=]\s*([^\n\r]+)/im);
    if (m) {
      const rawKey = m[1].trim();
      const rawValue = m[2].trim();
      const normalizedKey = rawKey.replace(/\s+/g, " ").toLowerCase();
      const numericValue = safeNumber(rawValue);
      if (numericValue !== undefined) {
        const label =
          normalizedKey === "pressure relief"
            ? "Pressure relief"
            : normalizedKey.toUpperCase();
        machine.pressureRelief =
          numericValue > 0
            ? `${label}: On ${Number(numericValue.toFixed(2)).toString()}`
            : `${label}: Off`;
      } else if (/^(?:off|disabled|false|no)$/i.test(rawValue)) {
        const label =
          normalizedKey === "pressure relief"
            ? "Pressure relief"
            : normalizedKey.toUpperCase();
        machine.pressureRelief = `${label}: Off`;
      } else if (/^(?:on|enabled|true|yes)$/i.test(rawValue)) {
        const label =
          normalizedKey === "pressure relief"
            ? "Pressure relief"
            : normalizedKey.toUpperCase();
        machine.pressureRelief = `${label}: On`;
      } else {
        machine.pressureRelief = rawValue;
      }
    }
  }

  const minMatch = text.match(/^\s*(?:min(?:imum)?\s*pressure|pmin|minpressure|pressuremin|min_pressure)\s*[:=]?\s*(-?\d+(?:\.\d+)?)/im);
  const maxMatch = text.match(/^\s*(?:max(?:imum)?\s*pressure|pmax|maxpressure|pressuremax|max_pressure)\s*[:=]?\s*(-?\d+(?:\.\d+)?)/im);
  const avgPressureMatch = text.match(/^\s*(?:avg|average|mean)\s*(?:mask\s*)?pressure\s*[:=]?\s*(-?\d+(?:\.\d+)?)/im);
  const p95PressureMatch = text.match(/^\s*(?:95(?:th|%)|p95)\s*(?:mask\s*)?pressure\s*[:=]?\s*(-?\d+(?:\.\d+)?)/im);

  const minPressure = normalizePressureNumber(minMatch ? safeNumber(minMatch[1]) : undefined);
  const maxPressure = normalizePressureNumber(maxMatch ? safeNumber(maxMatch[1]) : undefined);
  const avgPressure = normalizePressureNumber(avgPressureMatch ? safeNumber(avgPressureMatch[1]) : undefined);
  const pressure95th = normalizePressureNumber(p95PressureMatch ? safeNumber(p95PressureMatch[1]) : undefined);

  if (!machine.pressureMin && minPressure !== undefined) machine.pressureMin = pressureText(minPressure);
  if (!machine.pressureMax && maxPressure !== undefined) machine.pressureMax = pressureText(maxPressure);
  if (avgPressure !== undefined && machine.pressureAvg === undefined) machine.pressureAvg = avgPressure;
  if (pressure95th !== undefined && machine.pressure95th === undefined) machine.pressure95th = pressure95th;

  if (minPressure !== undefined || maxPressure !== undefined) {
    machine.pressureIsAuto = true;
    if (!machine.pressure && minPressure !== undefined && maxPressure !== undefined) {
      machine.pressure = `${Number(minPressure.toFixed(2)).toString()}-${Number(maxPressure.toFixed(2)).toString()} (cmH2O)`;
    }
  } else if (!machine.pressure) {
    const fixedPressureMatch = text.match(/^\s*(?:set\s*pressure|fixed\s*pressure|cpap\s*pressure|pressure)\s*[:=]\s*(-?\d+(?:\.\d+)?)/im);
    const fixedPressure = normalizePressureNumber(fixedPressureMatch ? safeNumber(fixedPressureMatch[1]) : undefined);
    if (fixedPressure !== undefined) machine.pressure = `Fixed ${Number(fixedPressure.toFixed(2)).toString()} (cmH2O)`;
  }

  const kv = parseKeyValueLines(text);
  inferPressureSettingsFromMap(kv, machine);
  inferBilevelSettingsFromMap(kv, machine);
  inferRampSettingsFromMap(kv, machine);
}

function inferPressureSettingsFromMap(configMap: Map<string, string>, machine: QuickReportMetrics["machine"]) {
  const kvLower = new Map<string, string>();
  for (const [k, v] of configMap.entries()) kvLower.set(k.toLowerCase(), v);

  const isBilevelKey = (key: string): boolean => /\b(?:epap|ipap|ps|pressuresupport|rr|respiratoryrate|backup_rate)\b/i.test(key);

  const readByExactKey = (keys: string[]): number | undefined => {
    for (const key of keys) {
      const raw = kvLower.get(key.toLowerCase());
      const normalized = normalizePressureNumber(safeNumber(raw));
      if (normalized !== undefined) return normalized;
    }
    return undefined;
  };

  const readByPattern = (patterns: RegExp[]): number | undefined => {
    for (const [key, value] of kvLower.entries()) {
      if (isBilevelKey(key)) continue;
      if (!patterns.some((pattern) => pattern.test(key))) continue;
      const normalized = normalizePressureNumber(safeNumber(value));
      if (normalized !== undefined) return normalized;
    }
    return undefined;
  };

  const minPressure =
    readByExactKey(["pmin", "minpressure", "pressuremin", "min_pressure"]) ??
    readByPattern([/(?:^|_)(?:min|minimum).*(?:press)/i, /(?:press).*(?:min|minimum)(?:$|_)/i]);

  const maxPressure =
    readByExactKey(["pmax", "maxpressure", "pressuremax", "max_pressure"]) ??
    readByPattern([/(?:^|_)(?:max|maximum).*(?:press)/i, /(?:press).*(?:max|maximum)(?:$|_)/i]);

  const avgPressure =
    readByExactKey(["avgpressure", "averagepressure", "meanpressure", "pressureavg", "pressure_mean", "avg_press", "avgpressurecmh2o"]) ??
    readByPattern([/(?:avg|average|mean).*(?:press)/i, /(?:press).*(?:avg|average|mean)/i]);

  const pressure95th =
    readByExactKey(["pressure95", "pressure_95", "p95", "p95pressure"]) ??
    readByPattern([/(?:95|p95).*(?:press)/i, /(?:press).*(?:95|p95)/i]);

  if (!machine.pressureMin && minPressure !== undefined) machine.pressureMin = pressureText(minPressure);
  if (!machine.pressureMax && maxPressure !== undefined) machine.pressureMax = pressureText(maxPressure);
  if (machine.pressureAvg === undefined && avgPressure !== undefined) machine.pressureAvg = avgPressure;
  if (machine.pressure95th === undefined && pressure95th !== undefined) machine.pressure95th = pressure95th;

  if (minPressure !== undefined || maxPressure !== undefined) {
    machine.pressureIsAuto = true;
  }

  if (!machine.pressure && minPressure === undefined && maxPressure === undefined) {
    const fixed =
      readByExactKey(["press", "pressure", "setpressure", "cpappressure"]) ??
      readByPattern([/(?:^|_)(?:set|fixed).*(?:press)/i]);
    if (fixed !== undefined) {
      machine.pressure = `Fixed ${Number(fixed.toFixed(2)).toString()} (cmH2O)`;
    }
  }
}

function inferBilevelSettingsFromMap(configMap: Map<string, string>, machine: QuickReportMetrics["machine"]) {
  const kvLower = new Map<string, string>();
  for (const [k, v] of configMap.entries()) kvLower.set(k.toLowerCase(), v);

  const readPressure = (keys: string[], patterns: RegExp[] = []): number | undefined => {
    for (const key of keys) {
      const raw = kvLower.get(key.toLowerCase());
      const normalized = normalizePressureNumber(safeNumber(raw));
      if (normalized !== undefined) return normalized;
    }
    for (const [key, value] of kvLower.entries()) {
      if (!patterns.some((pattern) => pattern.test(key))) continue;
      const normalized = normalizePressureNumber(safeNumber(value));
      if (normalized !== undefined) return normalized;
    }
    return undefined;
  };

  const readRate = (): number | undefined => {
    const directKeys = [
      "rr",
      "rrset",
      "setrr",
      "respiratoryrate",
      "respiratory_rate",
      "respfreq",
      "backuprate",
      "backup_rate",
      "targetrate",
      "timedrate"
    ];
    for (const key of directKeys) {
      const raw = kvLower.get(key);
      const n = safeNumber(raw);
      if (n !== undefined && n >= 0 && n <= 80) return n;
    }
    for (const [key, value] of kvLower.entries()) {
      if (!/(?:\brr\b|respiratory.*rate|backup.*rate|timed.*rate|target.*rate)/i.test(key)) continue;
      const n = safeNumber(value);
      if (n !== undefined && n >= 0 && n <= 80) return n;
    }
    return undefined;
  };

  const readTidalVolume = (): string | undefined => {
    const directKeys = [
      "vt",
      "vtset",
      "setvt",
      "targetvt",
      "target_vt",
      "vttarget",
      "vt_target",
      "tidalvolume",
      "tidal_volume",
      "settidalvolume",
      "set_tidal_volume",
      "targettidalvolume",
      "target_tidal_volume",
      "tidalvolumetarget",
      "tidal_volume_target",
      "avapsvt",
      "avaps_vt",
      "avapstargetvt",
      "avaps_target_vt"
    ];
    for (const key of directKeys) {
      const raw = kvLower.get(key);
      const parsed = tidalVolumeText(safeNumber(raw), `${key} ${raw ?? ""}`);
      if (parsed) return parsed;
    }
    for (const [key, value] of kvLower.entries()) {
      if (!/(?:\bvt\b|tidal.*vol|vol.*tidal|avaps.*vol|avaps.*vt|target.*vol|set.*vol)/i.test(key)) continue;
      const parsed = tidalVolumeText(safeNumber(value), `${key} ${value}`);
      if (parsed) return parsed;
    }
    return undefined;
  };

  const epapFixed = readPressure(["epap", "epapset", "set_epap", "epap_set"], [/\bepap\b/i]);
  const ipapFixed = readPressure(["ipap", "ipapset", "set_ipap", "ipap_set"], [/\bipap\b/i]);
  const epapMin = readPressure(["epapmin", "epap_min", "minepap", "min_epap"], [/\bepap.*(?:min|minimum)\b/i, /\b(?:min|minimum).*epap\b/i]);
  const epapMax = readPressure(["epapmax", "epap_max", "maxepap", "max_epap"], [/\bepap.*(?:max|maximum)\b/i, /\b(?:max|maximum).*epap\b/i]);
  const ipapMin = readPressure(["ipapmin", "ipap_min", "minipap", "min_ipap"], [/\bipap.*(?:min|minimum)\b/i, /\b(?:min|minimum).*ipap\b/i]);
  const ipapMax = readPressure(["ipapmax", "ipap_max", "maxipap", "max_ipap"], [/\bipap.*(?:max|maximum)\b/i, /\b(?:max|maximum).*ipap\b/i]);
  const rr = readRate();
  const tidalVolume = readTidalVolume();
  const explicitMode = resolveExplicitTherapyMode(machine.mode);
  const hasBilevelPressureEvidence =
    (epapFixed !== undefined && ipapFixed !== undefined) ||
    ((epapMin !== undefined || epapMax !== undefined) && (ipapMin !== undefined || ipapMax !== undefined)) ||
    rr !== undefined ||
    tidalVolume !== undefined;

  if (explicitMode === "CPAP" || explicitMode === "APAP") return;
  if (explicitMode !== "BiPAP" && !hasBilevelPressureEvidence) return;

  if (!machine.epap) {
    if (epapFixed !== undefined) {
      machine.epap = pressureText(epapFixed);
    } else if (epapMin !== undefined || epapMax !== undefined) {
      if (epapMin !== undefined && epapMax !== undefined) {
        machine.epap = `${Number(epapMin.toFixed(2)).toString()}-${Number(epapMax.toFixed(2)).toString()} cmH2O`;
      } else if (epapMin !== undefined) {
        machine.epap = `${Number(epapMin.toFixed(2)).toString()} cmH2O (min)`;
      } else if (epapMax !== undefined) {
        machine.epap = `${Number(epapMax.toFixed(2)).toString()} cmH2O (max)`;
      }
    }
  }

  if (!machine.ipap) {
    if (ipapFixed !== undefined) {
      machine.ipap = pressureText(ipapFixed);
    } else if (ipapMin !== undefined || ipapMax !== undefined) {
      if (ipapMin !== undefined && ipapMax !== undefined) {
        machine.ipap = `${Number(ipapMin.toFixed(2)).toString()}-${Number(ipapMax.toFixed(2)).toString()} cmH2O`;
      } else if (ipapMin !== undefined) {
        machine.ipap = `${Number(ipapMin.toFixed(2)).toString()} cmH2O (min)`;
      } else if (ipapMax !== undefined) {
        machine.ipap = `${Number(ipapMax.toFixed(2)).toString()} cmH2O (max)`;
      }
    }
  }

  if (!machine.respiratoryRate && rr !== undefined) {
    machine.respiratoryRate = `${Number(rr.toFixed(2)).toString()} bpm`;
  }
  if (!machine.tidalVolume && tidalVolume !== undefined) {
    machine.tidalVolume = tidalVolume;
  }
}

function inferRampSettingsFromMap(configMap: Map<string, string>, machine: QuickReportMetrics["machine"]) {
  const kvNormalized = new Map<string, string>();
  for (const [key, value] of configMap.entries()) {
    kvNormalized.set(key.toLowerCase().replace(/[\s_-]+/g, ""), value);
  }

  const readRawByKey = (keys: string[]): string | undefined => {
    for (const key of keys) {
      const raw = kvNormalized.get(key.toLowerCase().replace(/[\s_-]+/g, ""));
      if (raw !== undefined) return raw;
    }
    return undefined;
  };

  const readRawByPattern = (patterns: RegExp[]): string | undefined => {
    for (const [key, value] of kvNormalized.entries()) {
      if (!patterns.some((pattern) => pattern.test(key))) continue;
      return value;
    }
    return undefined;
  };

  const rawRampTime =
    readRawByKey(["rampTime", "rampMinutes", "rampTimeMinutes", "rampDuration"]) ??
    readRawByPattern([/^ramp(?:time|minutes|duration)$/i, /^.*ramp.*(?:time|minutes|duration).*$/i]);
  const rawRampPressure =
    readRawByKey(["rampPress", "rampPressure", "pRamp", "rampStartPressure", "rampStartPress"]) ??
    readRawByPattern([/^.*ramp.*(?:press|pressure).*$/i, /^(?:press|pressure).*ramp.*$/i]);

  if (!machine.rampTime && rawRampTime !== undefined) {
    const numericRampTime = safeNumber(rawRampTime);
    if (numericRampTime !== undefined) {
      machine.rampTime = rampTimeText(numericRampTime);
    } else if (isOffSettingText(rawRampTime)) {
      machine.rampTime = "Off";
    } else if (/^(?:on|enabled|true|yes|auto)$/i.test(rawRampTime.trim())) {
      machine.rampTime = rawRampTime.trim();
    }
  }

  if (!machine.rampPressure && rawRampPressure !== undefined && !isOffSettingText(machine.rampTime)) {
    const rampPressure = pressureText(safeNumber(rawRampPressure));
    if (rampPressure) machine.rampPressure = rampPressure;
  }
}

function inferPressureReliefFromMap(configMap: Map<string, string>, machine: QuickReportMetrics["machine"]) {
  if (machine.pressureRelief) return;

  const kvLower = new Map<string, string>();
  for (const [k, v] of configMap.entries()) kvLower.set(k.toLowerCase(), v);
  const get = (key: string): string | undefined => configMap.get(key) ?? kvLower.get(key.toLowerCase());

  const ipr = safeNumber(get("iPR"));
  if (ipr !== undefined) {
    machine.pressureRelief = ipr > 0 ? `IPR: On ${Number(ipr.toFixed(2)).toString()} cmH2O` : "IPR: Off";
    return;
  }

  const eprLevel = safeNumber(get("EPRLevel") ?? get("epr_level") ?? get("EPR"));
  if (eprLevel !== undefined) {
    machine.pressureRelief = eprLevel > 0 ? `EPR: On ${Number(eprLevel.toFixed(2)).toString()}` : "EPR: Off";
    return;
  }

  const flexLevel = safeNumber(get("Flex") ?? get("A-Flex") ?? get("C-Flex"));
  if (flexLevel !== undefined) {
    machine.pressureRelief = flexLevel > 0 ? `Flex: On ${Number(flexLevel.toFixed(2)).toString()}` : "Flex: Off";
    return;
  }

  for (const [key, value] of kvLower.entries()) {
    if (!/(?:\bepr\b|\bipr\b|\bflex\b|\bexhale\b)/i.test(key)) continue;
    const n = safeNumber(value);
    if (n !== undefined) {
      machine.pressureRelief = n > 0 ? `${key.toUpperCase()}: On ${Number(n.toFixed(2)).toString()}` : `${key.toUpperCase()}: Off`;
      return;
    }
    if (value.trim().length > 0) {
      machine.pressureRelief = value.trim();
      return;
    }
  }
}

function parseKeyValueLines(text: string): Map<string, string> {
  const cleaned = text
    .replace(/\0/g, "\n")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
  const out = new Map<string, string>();
  const lines = cleaned.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    const eqIdx = trimmed.indexOf("=");
    const colonIdx = trimmed.indexOf(":");
    const hasEq = eqIdx >= 0;
    const hasColon = colonIdx >= 0;
    if (!hasEq && !hasColon) continue;
    const idx = hasEq && hasColon ? Math.min(eqIdx, colonIdx) : hasEq ? eqIdx : colonIdx;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key.length === 0) continue;
    out.set(key, value);
  }

  // Some SD files contain key/value blobs without line breaks; capture those too.
  const re = /([A-Za-z][A-Za-z0-9_]{1,40})\s*[:=]\s*([^\r\n,;]+)/g;
  for (const m of cleaned.matchAll(re)) {
    const key = (m[1] ?? "").trim();
    const value = (m[2] ?? "").trim();
    if (key && value) out.set(key, value);
  }

  return out;
}

function normalizeLookbackDays(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 90;
  const rounded = Math.trunc(value);
  if (rounded <= 0) return 90;
  return rounded;
}

function resolveRecentWindow(_latestDate: Date, lookbackDays: number, sourceTimeZoneOffsetMinutes: number | null): DateWindow {
  const normalizedLookbackDays = normalizeLookbackDays(lookbackDays);

  // Always anchor report windows to the noon boundary that ends today so the
  // included clinical day is yesterday noon -> today noon, regardless of the
  // current clock time. When the card exposes an explicit UTC offset, anchor
  // to that calendar day instead of the host timezone.
  const now = new Date();
  const windowEnd = createCalendarDateNoonAtUtcOffset(now, sourceTimeZoneOffsetMinutes) ?? createLocalCalendarDateNoon(now);
  const windowStart = addUtcDays(windowEnd, -normalizedLookbackDays);
  return { start: windowStart, end: windowEnd };
}

function resolveLatestDataWindow(latestDate: Date, lookbackDays: number): DateWindow {
  const normalizedLookbackDays = normalizeLookbackDays(lookbackDays);
  const latestClinicalDay = createUtcDateNoon(latestDate.getUTCFullYear(), latestDate.getUTCMonth() + 1, latestDate.getUTCDate())!;
  const windowEnd = addUtcDays(latestClinicalDay, 1);
  const windowStart = addUtcDays(windowEnd, -normalizedLookbackDays);
  return { start: windowStart, end: windowEnd };
}

function resolveWindowFromClinicalEndIso(windowEndClinicalDayIso: string, lookbackDays: number): DateWindow {
  const normalizedLookbackDays = normalizeLookbackDays(lookbackDays);
  const includedClinicalEnd = new Date(`${windowEndClinicalDayIso}T12:00:00Z`);
  if (Number.isNaN(includedClinicalEnd.getTime())) {
    throw new Error(`Invalid window end clinical day: ${windowEndClinicalDayIso}`);
  }

  // Internal day buckets are keyed by the start date of each noon-to-noon
  // clinical day. A user-facing end day like "March 26" means the clinical day
  // ending at noon on March 26, so the exclusive upper bound for start-date
  // buckets is exactly the March 26 noon boundary.
  const windowEnd = includedClinicalEnd;
  const windowStart = addUtcDays(windowEnd, -normalizedLookbackDays);
  return { start: windowStart, end: windowEnd };
}

function scoreGenericCandidate(meta: SourceMeta, window: DateWindow | null, priorityPatterns: RegExp[]): number {
  let score = 0;
  const path = meta.normalizedPath;
  const name = meta.baseName;

  if (meta.recordDate && window) {
    if (meta.recordDate >= window.start && meta.recordDate < window.end) {
      score += 120;
    } else {
      const dayDistance = Math.abs(meta.recordDate.getTime() - window.end.getTime()) / (24 * 3600 * 1000);
      if (dayDistance <= 365) score += Math.max(0, 45 - Math.floor(dayDistance / 10));
    }
  }

  if (/^stat\d{0,4}(?:\..*)?$/i.test(name)) score += 95;
  if (/^ev\d{0,4}(?:\..*)?$/i.test(name)) score += 70;
  if (/^p\d{2}_\d+(?:\..*)?$/i.test(name)) score += 55;
  if (/(?:summary|detail|session|usage|compliance|result)/i.test(name)) score += 35;
  if (/(?:record|therapy|datalog|p-series)/i.test(path)) score += 25;

  for (const pattern of priorityPatterns) {
    if (pattern.test(path)) score += 35;
  }

  if (TEXT_EXTENSIONS.has(meta.ext)) score += 20;
  else if (GENERIC_BINARY_EXTENSIONS.has(meta.ext)) score += 14;
  else if (meta.ext === "") score += 6;

  if (meta.file.size > 0 && meta.file.size <= 512_000) score += 18;
  else if (meta.file.size <= 2_000_000) score += 12;
  else if (meta.file.size <= MAX_FILE_SIZE_BYTES) score += 6;

  return score;
}

function getPinnedResMedCandidates(allCandidates: SourceMeta[]): SourceMeta[] {
  const pinnedPatterns = [
    /(?:^|\/)str\.edf(?:\.gz)?$/i,
    /(?:^|\/)identification\.(?:tgt|json)$/i,
    /(?:^|\/)settings\/[^/]+\.(?:tgt|json|txt|xml|log)$/i
  ];

  const pinned: SourceMeta[] = [];
  for (const candidate of allCandidates) {
    if (!pinnedPatterns.some((pattern) => pattern.test(candidate.normalizedPath))) continue;
    pinned.push(candidate);
  }

  pinned.sort((a, b) => a.normalizedPath.localeCompare(b.normalizedPath));
  return pinned;
}

function selectGenericCandidates(
  allCandidates: SourceMeta[],
  selectedFamily: ParserFamilyDefinition | null,
  lookbackDays: number
): SourceMeta[] {
  const latestDated = allCandidates
    .filter((m): m is SourceMeta & { recordDate: Date } => m.recordDate !== null)
    .reduce<Date | null>((acc, m) => (acc === null || m.recordDate > acc ? m.recordDate : acc), null);

  const window = latestDated ? resolveLatestDataWindow(latestDated, lookbackDays) : null;
  const priorityPatterns = selectedFamily ? buildFamilyPriorityPatterns(selectedFamily) : [];

  const ranked = allCandidates
    .map((m) => ({ meta: m, score: scoreGenericCandidate(m, window, priorityPatterns) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aDate = a.meta.recordDate?.getTime() ?? 0;
      const bDate = b.meta.recordDate?.getTime() ?? 0;
      if (bDate !== aDate) return bDate - aDate;
      return a.meta.file.size - b.meta.file.size;
    });

  const pinnedCandidates =
    selectedFamily?.id === "resmed"
      ? getPinnedResMedCandidates(allCandidates)
      : [];

  let totalBytes = 0;
  const out: SourceMeta[] = [];
  const seen = new Set<string>();

  for (const candidate of pinnedCandidates) {
    if (seen.has(candidate.normalizedPath)) continue;
    if (out.length >= MAX_GENERIC_FILES_TO_SCAN) break;
    if (totalBytes + candidate.file.size > MAX_GENERIC_TOTAL_BYTES) break;
    out.push(candidate);
    seen.add(candidate.normalizedPath);
    totalBytes += candidate.file.size;
  }

  for (const item of ranked) {
    if (seen.has(item.meta.normalizedPath)) continue;
    if (out.length >= MAX_GENERIC_FILES_TO_SCAN) break;
    if (totalBytes + item.meta.file.size > MAX_GENERIC_TOTAL_BYTES) break;
    out.push(item.meta);
    seen.add(item.meta.normalizedPath);
    totalBytes += item.meta.file.size;
  }
  return out;
}

async function extractSourceTimeZoneOffsetMinutes(
  selectedFamily: ParserFamilyDefinition,
  meta: SourceMeta[]
): Promise<number | null> {
  if (selectedFamily.id === "resmed") {
    const settingsCandidates = meta.filter((candidate) => /(?:^|\/)settings\/currentsettings\.json$/i.test(candidate.normalizedPath));
    for (const candidate of settingsCandidates) {
      try {
        const metadata = { sourceTimeZoneOffsetMinutes: null };
        const machine: QuickReportMetrics["machine"] = {};
        const text = await candidate.file.readText();
        applyResMedCurrentSettingsJson(text, machine, metadata);
        if (metadata.sourceTimeZoneOffsetMinutes !== null) {
          return metadata.sourceTimeZoneOffsetMinutes;
        }
      } catch {
        // Keep scanning.
      }
    }
  }

  const genericCandidates = meta.filter(
    (candidate) =>
      candidate.file.size > 0 &&
      candidate.file.size <= MAX_GENERIC_BINARY_FILE_BYTES &&
      /\.(?:txt|csv|json|xml|log|cfg|ini|tgt)$/i.test(candidate.baseName) &&
      /(?:^|\/)(?:settings?|config|profile|profiles|identification)(?:\/|$|[._-])/i.test(candidate.normalizedPath)
  );

  for (const candidate of genericCandidates) {
    try {
      const explicitUtcOffsetMinutes = extractExplicitUtcOffsetMinutes(parseKeyValueLines(await candidate.file.readText()));
      if (explicitUtcOffsetMinutes !== null) {
        return explicitUtcOffsetMinutes;
      }
    } catch {
      // Keep scanning.
    }
  }

  return null;
}

function decodeLikelyTextVariants(bytes: Uint8Array): string[] {
  if (bytes.length === 0) return [];
  const seen = new Set<string>();
  const variants: string[] = [];

  const decoderUtf8 = new TextDecoder("utf-8", { fatal: false });
  const decoderLatin1 = new TextDecoder("iso-8859-1", { fatal: false });
  const decoderUtf16Le = new TextDecoder("utf-16le", { fatal: false });
  const decoderUtf16Be = new TextDecoder("utf-16be", { fatal: false });

  const asciiSanitize = (start: number): string => {
    let out = "";
    for (let i = Math.min(start, bytes.length); i < bytes.length; i += 1) {
      const b = bytes[i];
      if ((b >= 32 && b <= 126) || b === 9 || b === 10 || b === 13) out += String.fromCharCode(b);
      else out += "\n";
    }
    return out;
  };

  const candidates = [
    decodeResventText(bytes, false),
    decodeResventText(bytes, true),
    decoderUtf8.decode(bytes),
    decoderLatin1.decode(bytes),
    decoderUtf16Le.decode(bytes),
    decoderUtf16Be.decode(bytes),
    asciiSanitize(0),
    asciiSanitize(4)
  ];
  for (const raw of candidates) {
    const text = raw.replace(/\0/g, "\n");
    const trimmed = text.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    variants.push(trimmed);
  }

  return variants;
}

function decodeResventText(bytes: Uint8Array, skipHeader = true): string {
  if (bytes.length === 0) return "";
  // OSCAR Resvent loader always seeks 4 bytes before reading config/stat/event text files.
  const start = skipHeader ? Math.min(4, bytes.length) : 0;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(start));
}

function inferMachineSettingsFromConfigFilename(path: string, machine: QuickReportMetrics["machine"]) {
  const base = path.split("/").pop()?.toUpperCase() ?? "";
  if (!machine.mode && RESVENT_MODE_FROM_FILE.has(base)) {
    machine.mode = RESVENT_MODE_FROM_FILE.get(base);
  }
  if (!machine.device) {
    machine.device = "Resvent / Hoffrichter";
  }
}

function inferMachineSettingsFromConfigMap(configMap: Map<string, string>, machine: QuickReportMetrics["machine"]) {
  if (isLikelyAutoMode(machine.mode)) machine.pressureIsAuto = true;

  const model = configMap.get("models") ?? configMap.get("model");
  const sn = configMap.get("sn") ?? configMap.get("serial");
  const hasGenericResventLabel = typeof machine.device === "string" && /^Resvent\s*\/\s*Hoffrichter$/i.test(machine.device.trim());
  if ((!machine.device || hasGenericResventLabel) && model && sn) machine.device = `${model} (${sn})`;
  else if ((!machine.device || hasGenericResventLabel) && model) machine.device = model;
  else if ((!machine.device || hasGenericResventLabel) && sn) machine.device = `Serial ${sn}`;

  if (!resolveExplicitTherapyMode(machine.mode)) {
    const modeRaw = configMap.get("VentMode") ?? configMap.get("mode");
    if (modeRaw) {
      machine.mode = RESVENT_MODE_FROM_VENT_MODE.get(modeRaw) ?? modeRaw;
      if (isLikelyAutoMode(machine.mode)) machine.pressureIsAuto = true;
    }
  }

  const explicitMode = resolveExplicitTherapyMode(machine.mode);
  const fixedResventPressure = formatCmH2O(configMap.get("Press"));

  if (explicitMode === "CPAP" && fixedResventPressure) {
    machine.pressure = `Fixed ${fixedResventPressure} (cmH2O)`;
    machine.pressureIsAuto = false;
    machine.pressureMin = undefined;
    machine.pressureMax = undefined;
  }

  if (!machine.pressure) {
    const press = configMap.get("Press");
    const pMin = configMap.get("PMin");
    const pMax = configMap.get("PMax");
    const epap = configMap.get("EPAP");
    const ipap = configMap.get("IPAP");
    const epapMin = configMap.get("EPAPMin");
    const ipapMax = configMap.get("IPAPMax");

    const pressText = formatCmH2O(press);
    const pMinText = formatCmH2O(pMin);
    const pMaxText = formatCmH2O(pMax);
    const epapText = formatCmH2O(epap);
    const ipapText = formatCmH2O(ipap);
    const epapMinText = formatCmH2O(epapMin);
    const ipapMaxText = formatCmH2O(ipapMax);

    if (explicitMode === "CPAP") {
      if (pressText) {
        machine.pressure = `Fixed ${pressText} (cmH2O)`;
      }
      machine.pressureIsAuto = false;
      machine.pressureMin = undefined;
      machine.pressureMax = undefined;
    } else if (pressText) {
      machine.pressure = `Fixed ${pressText} (cmH2O)`;
    } else if (pMinText && pMaxText) {
      machine.pressure = `${pMinText}-${pMaxText} (cmH2O)`;
      machine.pressureMin = `${pMinText} cmH2O`;
      machine.pressureMax = `${pMaxText} cmH2O`;
      machine.pressureIsAuto = true;
    } else if (explicitMode === "BiPAP" && epapText && ipapText) {
      machine.pressure = `EPAP ${epapText} / IPAP ${ipapText} (cmH2O)`;
    } else if (explicitMode === "BiPAP" && epapMinText && ipapMaxText) {
      machine.pressure = `EPAP ${epapMinText} - IPAP ${ipapMaxText} (cmH2O)`;
      machine.pressureMin = `EPAP ${epapMinText} cmH2O`;
      machine.pressureMax = `IPAP ${ipapMaxText} cmH2O`;
      machine.pressureIsAuto = true;
    }

    if (explicitMode === "BiPAP" && !machine.epap) {
      if (epapText) machine.epap = `${epapText} cmH2O`;
      else if (epapMinText) machine.epap = `${epapMinText} cmH2O (min)`;
    }
    if (explicitMode === "BiPAP" && !machine.ipap) {
      if (ipapText) machine.ipap = `${ipapText} cmH2O`;
      else if (ipapMaxText) machine.ipap = `${ipapMaxText} cmH2O (max)`;
    }
  }

  inferPressureSettingsFromMap(configMap, machine);
  inferBilevelSettingsFromMap(configMap, machine);
  inferRampSettingsFromMap(configMap, machine);

  if (explicitMode === "CPAP" && fixedResventPressure) {
    machine.pressure = `Fixed ${fixedResventPressure} (cmH2O)`;
    machine.pressureIsAuto = false;
    machine.pressureMin = undefined;
    machine.pressureMax = undefined;
  }

  if (!machine.pressureRelief) {
    inferPressureReliefFromMap(configMap, machine);
  }
}

function parseResventStatText(text: string, fallbackDate: Date): ParsedRecord | null {
  const kv = parseKeyValueLines(text);
  if (kv.size === 0) return null;

  const kvLower = new Map<string, string>();
  for (const [k, v] of kv.entries()) kvLower.set(k.toLowerCase(), v);
  const num = (key: string): number | undefined => safeNumber(kv.get(key) ?? kvLower.get(key.toLowerCase()));

  const secUsed = num("secUsed");
  const secStart = num("secStart");
  const cntAHI = num("cntAHI");
  const cntOAI = num("cntOAI");
  const cntCAI = num("cntCAI");
  const cntAI = num("cntAI");
  const cntHI = num("cntHI");
  const cntRERA = num("cntRERA");

  // Keep daily grouping anchored to THERAPY/RECORD/YYYYMM/DD (same basis OSCAR uses to load sessions).
  const recordDate = createUtcDateNoon(fallbackDate.getUTCFullYear(), fallbackDate.getUTCMonth() + 1, fallbackDate.getUTCDate());
  if (Number.isNaN(recordDate.getTime())) return null;

  const usageHours = secUsed !== undefined ? secUsed / 3600 : undefined;
  const therapySessionStart =
    secStart !== undefined && secStart > 0 ? new Date(secStart * 1000) : undefined;
  const hasValidTherapySessionStart =
    therapySessionStart !== undefined && !Number.isNaN(therapySessionStart.getTime());

  let ahi: number | undefined;
  let residualApneas: number | undefined;
  let centralApneas: number | undefined;
  let reraIndex: number | undefined;
  let pressureAvg: number | undefined;
  let pressure95th: number | undefined;
  let ipapAvg: number | undefined;
  let ipap95th: number | undefined;
  let epapAvg: number | undefined;
  let epap95th: number | undefined;
  let eventCount: number | undefined;
  if (cntAI !== undefined && cntHI !== undefined) {
    eventCount = cntAI + cntHI;
  } else if (cntOAI !== undefined || cntCAI !== undefined || cntHI !== undefined) {
    eventCount = (cntOAI ?? 0) + (cntCAI ?? 0) + (cntHI ?? 0);
  } else if (cntAHI !== undefined) {
    eventCount = cntAHI;
  }

  if (usageHours !== undefined && usageHours > 0 && eventCount !== undefined) {
    ahi = eventCount / usageHours;
  } else if (cntAHI !== undefined) {
    // Fallback if only a scalar was supplied.
    ahi = cntAHI;
  }

  if (cntAI !== undefined) {
    residualApneas = usageHours !== undefined && usageHours > 0 ? cntAI / usageHours : cntAI;
  }
  if (cntCAI !== undefined) {
    centralApneas = usageHours !== undefined && usageHours > 0 ? cntCAI / usageHours : cntCAI;
  }
  if (cntRERA !== undefined) {
    reraIndex = usageHours !== undefined && usageHours > 0 ? cntRERA / usageHours : cntRERA;
  }

  for (const [key, value] of kvLower.entries()) {
    const normalized = normalizePressureNumber(safeNumber(value));
    if (normalized === undefined) continue;
    if (ipapAvg === undefined && /(?:med|median|avg|average|mean).*ipap|ipap.*(?:med|median|avg|average|mean)/i.test(key)) {
      ipapAvg = normalized;
      continue;
    }
    if (ipap95th === undefined && /(?:95|p95).*ipap|ipap.*(?:95|p95)/i.test(key)) {
      ipap95th = normalized;
      continue;
    }
    if (epapAvg === undefined && /(?:med|median|avg|average|mean).*epap|epap.*(?:med|median|avg|average|mean)/i.test(key)) {
      epapAvg = normalized;
      continue;
    }
    if (epap95th === undefined && /(?:95|p95).*epap|epap.*(?:95|p95)/i.test(key)) {
      epap95th = normalized;
      continue;
    }
    if (
      pressureAvg === undefined &&
      /(?:med|median|avg|average|mean).*press|press.*(?:med|median|avg|average|mean)/i.test(key)
    ) {
      pressureAvg = normalized;
    }
    if (pressure95th === undefined && /(?:95|p95).*press|press.*(?:95|p95)/i.test(key)) {
      pressure95th = normalized;
    }
  }

  let leak: number | undefined;
  let leak95th: number | undefined;
  let leakMax: number | undefined;
  for (const preferredKey of ["medleak", "medianleak", "avgleak", "averageleak", "meanleak"]) {
    const candidate = safeNumber(kvLower.get(preferredKey));
    if (candidate !== undefined && candidate >= 0 && candidate <= 500) {
      leak = candidate;
      break;
    }
  }

  const preferred95Leak = safeNumber(kvLower.get("p95leak") ?? kvLower.get("leak95") ?? kvLower.get("leak95th"));
  if (preferred95Leak !== undefined && preferred95Leak >= 0 && preferred95Leak <= 500) {
    leak95th = preferred95Leak;
  }

  const preferredMaxLeak = safeNumber(kvLower.get("maxleak"));
  if (preferredMaxLeak !== undefined && preferredMaxLeak >= 0 && preferredMaxLeak <= 500) {
    leakMax = preferredMaxLeak;
  }

  for (const [key, value] of kv.entries()) {
    if (!/leak/i.test(key)) continue;
    const n = safeNumber(value);
    if (n === undefined) continue;
    if (/(?:95|p95)/i.test(key)) {
      if (leak95th === undefined && n >= 0 && n <= 500) leak95th = n;
      continue;
    }
    if (/max/i.test(key)) {
      if (leakMax === undefined && n >= 0 && n <= 500) leakMax = n;
      continue;
    }
    if (n >= 0 && n <= 500 && leak === undefined) {
      leak = n;
    }
  }

  const therapySettings = buildTherapySettingsSnapshotFromKeyValueMap(kv);

  const hasSignal =
    (usageHours !== undefined && usageHours >= 0 && usageHours <= 24) ||
    (ahi !== undefined && ahi >= 0 && ahi < 200) ||
    (residualApneas !== undefined && residualApneas >= 0 && residualApneas < 200) ||
    (centralApneas !== undefined && centralApneas >= 0 && centralApneas < 200) ||
    (reraIndex !== undefined && reraIndex >= 0 && reraIndex < 200) ||
    (leak !== undefined && leak >= 0 && leak < 500) ||
    (leak95th !== undefined && leak95th >= 0 && leak95th < 500) ||
    (leakMax !== undefined && leakMax >= 0 && leakMax < 500) ||
    isReportPressureMetric(pressureAvg) ||
    isReportPressureMetric(pressure95th) ||
    isReportPressureMetric(ipapAvg) ||
    isReportPressureMetric(ipap95th) ||
    isReportPressureMetric(epapAvg) ||
    isReportPressureMetric(epap95th);
  if (!hasSignal) return null;

  return {
    date: recordDate,
    therapySessionStart: hasValidTherapySessionStart ? therapySessionStart : undefined,
    therapySessionEnd:
      hasValidTherapySessionStart && therapySessionStart && secUsed !== undefined && secUsed > 0
        ? new Date(therapySessionStart.getTime() + secUsed * 1000)
        : undefined,
    usageHours: usageHours !== undefined && usageHours >= 0 && usageHours <= 24 ? usageHours : undefined,
    ahi: ahi !== undefined && ahi >= 0 && ahi < 200 ? ahi : undefined,
    residualApneas: residualApneas !== undefined && residualApneas >= 0 && residualApneas < 200 ? residualApneas : undefined,
    centralApneas: centralApneas !== undefined && centralApneas >= 0 && centralApneas < 200 ? centralApneas : undefined,
    reraIndex: reraIndex !== undefined && reraIndex >= 0 && reraIndex < 200 ? reraIndex : undefined,
    leak: leak !== undefined && leak >= 0 && leak < 500 ? leak : undefined,
    leak95th: leak95th !== undefined && leak95th >= 0 && leak95th < 500 ? leak95th : undefined,
    leakMax: leakMax !== undefined && leakMax >= 0 && leakMax < 500 ? leakMax : undefined,
    pressureAvg: isReportPressureMetric(pressureAvg) ? pressureAvg : undefined,
    pressure95th: isReportPressureMetric(pressure95th) ? pressure95th : undefined,
    ipapAvg: isReportPressureMetric(ipapAvg) ? ipapAvg : undefined,
    ipap95th: isReportPressureMetric(ipap95th) ? ipap95th : undefined,
    epapAvg: isReportPressureMetric(epapAvg) ? epapAvg : undefined,
    epap95th: isReportPressureMetric(epap95th) ? epap95th : undefined,
    therapySettingsSignature: therapySettings?.signature,
    therapySettingsLabel: therapySettings?.label,
    therapySettingsMachine: therapySettings?.machine
  };
}

function parseResventStatFromBytes(bytes: Uint8Array, fallbackDate: Date): ParsedRecord | null {
  const variants = decodeLikelyTextVariants(bytes);
  for (const text of variants) {
    const parsed = parseResventStatText(text, fallbackDate);
    if (parsed) return parsed;
  }
  return null;
}

function extractResventVentModeRawFromKeyValueMap(kv: Map<string, string>): string | null {
  const ventMode = kv.get("VentMode") ?? kv.get("mode") ?? kv.get("ventmode");
  if (!ventMode) return null;
  const normalized = String(ventMode).trim();
  return normalized.length > 0 ? normalized : null;
}

function extractResventVentModeFromText(text: string): string | null {
  const kv = parseKeyValueLines(text);
  if (kv.size === 0) return null;
  return extractResventVentModeRawFromKeyValueMap(kv);
}

function extractResventVentModeFromBytes(bytes: Uint8Array): string | null {
  const variants = decodeLikelyTextVariants(bytes);
  for (const text of variants) {
    const ventMode = extractResventVentModeFromText(text);
    if (ventMode) return ventMode;
  }
  return null;
}

function firstNumberFromSetting(input: unknown): number | undefined {
  const direct = safeNumber(input);
  if (direct !== undefined) return direct;
  if (typeof input !== "string") return undefined;
  const match = input.match(/-?\d+(?:\.\d+)?/);
  return match ? safeNumber(match[0]) : undefined;
}

function pressureSettingTextFromRaw(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (/\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?/.test(trimmed)) return trimmed;
  return pressureText(firstNumberFromSetting(trimmed)) ?? trimmed;
}

function buildTherapySettingsSnapshotFromKeyValueMap(kv: Map<string, string>) {
  const normalized = new Map<string, string>();
  for (const [key, value] of kv.entries()) {
    normalized.set(key.toLowerCase().replace(/[\s_-]+/g, ""), value);
  }

  const readRaw = (keys: string[]): string | undefined => {
    for (const key of keys) {
      const direct = kv.get(key);
      if (direct !== undefined) return direct;
      const compact = normalized.get(key.toLowerCase().replace(/[\s_-]+/g, ""));
      if (compact !== undefined) return compact;
    }
    return undefined;
  };

  const readPressure = (keys: string[]): string | undefined => pressureSettingTextFromRaw(readRaw(keys));
  const readNumericText = (keys: string[], unit: string): string | undefined => {
    const n = firstNumberFromSetting(readRaw(keys));
    if (n === undefined || !Number.isFinite(n)) return undefined;
    return `${Number(n.toFixed(2)).toString()} ${unit}`;
  };
  const readTidalVolume = (keys: string[]): string | undefined => {
    const raw = readRaw(keys);
    return tidalVolumeText(firstNumberFromSetting(raw), raw);
  };

  const ventModeRaw = readRaw(["VentMode", "vent mode", "ventMode"]);
  const modeRaw = readRaw(["therapyMode", "therapy mode", "mode", "papMode", "pap mode"]);
  const mode = ventModeRaw ? RESVENT_MODE_FROM_VENT_MODE.get(ventModeRaw) ?? modeRaw ?? `VentMode ${ventModeRaw}` : modeRaw;

  const epapFixed = readPressure(["EPAP", "epapSet", "setEPAP", "set_epap"]);
  const epapMin = readPressure(["EPAPMin", "EPAP minimum", "EPAPMinPressure"]);
  const epapMax = readPressure(["EPAPMax", "EPAP maximum", "EPAPMaxPressure"]);
  const ipapFixed = readPressure(["IPAP", "ipapSet", "setIPAP", "set_ipap"]);
  const ipapMin = readPressure(["IPAPMin", "IPAP minimum", "IPAPMinPressure"]);
  const ipapMax = readPressure(["IPAPMax", "IPAP maximum", "IPAPMaxPressure"]);

  const join = (min: string | undefined, max: string | undefined): string | undefined => {
    if (min && max) return `${min}-${max}`;
    return min ?? max;
  };
  const pressureSupport = readPressure(["PS", "pressureSupport", "pressure support"]);
  const pressureRelief = readRaw(["EPR", "Flex", "pressureRelief", "pressure relief", "IPR"]);

  return buildTherapySettingsSnapshot({
    mode,
    pressure: readPressure(["Press", "pressure", "setPressure", "set pressure", "CPAPPressure", "CPAP pressure"]),
    pressureMin: readPressure(["PMin", "pressureMin", "minPressure", "minimumPressure", "setMinPressure", "autoMin"]),
    pressureMax: readPressure(["PMax", "pressureMax", "maxPressure", "maximumPressure", "setMaxPressure", "autoMax"]),
    epap: epapFixed ?? join(epapMin, epapMax),
    ipap: ipapFixed ?? join(ipapMin, ipapMax),
    respiratoryRate: readNumericText(["RR", "rrSet", "respiratoryRate", "backupRate", "backup rate"], "bpm"),
    tidalVolume: readTidalVolume(["VT", "vtSet", "targetVT", "targetVt", "tidalVolume", "targetTidalVolume"]),
    pressureRelief: pressureSupport ? `PS ${pressureSupport}` : pressureRelief
  });
}

function parseGenericDailyKeyValueRecord(text: string, fallbackDate: Date): ParsedRecord | null {
  const kv = parseKeyValueLines(text);
  if (kv.size === 0) return null;

  const kvLower = new Map<string, string>();
  for (const [k, v] of kv.entries()) kvLower.set(k.toLowerCase(), v);
  const get = (key: string): string | undefined => kv.get(key) ?? kvLower.get(key.toLowerCase());

  const usageKeyOrder = [
    "usagehours",
    "therapyhours",
    "hours",
    "hour",
    "timeused",
    "runtime",
    "secUsed",
    "secondsused",
    "minutesused"
  ];

  let usageHours: number | undefined;
  for (const key of usageKeyOrder) {
    const raw = get(key);
    const n = safeNumber(raw);
    if (n === undefined) continue;
    if (/sec/i.test(key)) usageHours = n / 3600;
    else if (/min/i.test(key)) usageHours = n / 60;
    else usageHours = n;
    break;
  }

  const readRateMetric = (keys: string[]): number | undefined => {
    for (const key of keys) {
      const raw = get(key);
      const n = safeNumber(raw);
      if (n === undefined) continue;
      if (/^cnt/i.test(key) && usageHours !== undefined && usageHours > 0) {
        return n / usageHours;
      }
      return n;
    }
    return undefined;
  };

  const ahiCandidates = [
    safeNumber(get("ahi")),
    safeNumber(get("avgahi")),
    safeNumber(get("residualahi")),
    safeNumber(get("ahi95"))
  ].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  let ahi: number | undefined = ahiCandidates.length > 0 ? ahiCandidates[0] : undefined;

  if (ahi === undefined && usageHours && usageHours > 0) {
    const cntOAI = safeNumber(get("cntOAI"));
    const cntCAI = safeNumber(get("cntCAI"));
    const cntHI = safeNumber(get("cntHI"));
    const cntAI = safeNumber(get("cntAI"));
    const eventCount =
      cntAI !== undefined && cntHI !== undefined
        ? cntAI + cntHI
        : cntOAI !== undefined || cntCAI !== undefined || cntHI !== undefined
          ? (cntOAI ?? 0) + (cntCAI ?? 0) + (cntHI ?? 0)
          : undefined;
    if (eventCount !== undefined) ahi = eventCount / usageHours;
  }

  const residualApneas = readRateMetric([
    "residualApneas",
    "residual_apneas",
    "residualAI",
    "residual_ahi",
    "apneaIndex",
    "AI",
    "cntAI"
  ]);
  const centralApneas = readRateMetric([
    "centralApneas",
    "central_apneas",
    "centralAI",
    "CAI",
    "cntCAI"
  ]);
  const reraIndex = readRateMetric([
    "rera",
    "reraindex",
    "rera_index",
    "rerai",
    "cntRERA",
    "cnt_rera"
  ]);

  const readPressureByPattern = (pattern: RegExp): number | undefined => {
    for (const [key, value] of kvLower.entries()) {
      if (!pattern.test(key)) continue;
      const n = normalizePressureNumber(safeNumber(value));
      if (n !== undefined) return n;
    }
    return undefined;
  };

  const pressureAvg = readPressureByPattern(/(?:avg|average|mean).*press|press.*(?:avg|average|mean)/i);
  const pressure95th = readPressureByPattern(/(?:95|p95).*press|press.*(?:95|p95)/i);
  const ipapAvg = readPressureByPattern(/(?:med|median|avg|average|mean).*ipap|ipap.*(?:med|median|avg|average|mean)/i);
  const ipap95th = readPressureByPattern(/(?:95|p95).*ipap|ipap.*(?:95|p95)/i);
  const epapAvg = readPressureByPattern(/(?:med|median|avg|average|mean).*epap|epap.*(?:med|median|avg|average|mean)/i);
  const epap95th = readPressureByPattern(/(?:95|p95).*epap|epap.*(?:95|p95)/i);

  let leak: number | undefined;
  let leakMax: number | undefined;
  for (const [key, value] of kvLower.entries()) {
    if (!/leak/.test(key)) continue;
    const n = safeNumber(value);
    if (n === undefined) continue;
    if (/max/.test(key)) {
      leakMax = n;
      continue;
    }
    if (leak === undefined) leak = n;
  }

  const therapySettings = buildTherapySettingsSnapshotFromKeyValueMap(kv);
  const day = createUtcDateNoon(fallbackDate.getUTCFullYear(), fallbackDate.getUTCMonth() + 1, fallbackDate.getUTCDate());
  const hasSignal =
    (usageHours !== undefined && usageHours >= 0 && usageHours <= 24) ||
    (ahi !== undefined && ahi >= 0 && ahi < 200) ||
    (residualApneas !== undefined && residualApneas >= 0 && residualApneas < 200) ||
    (centralApneas !== undefined && centralApneas >= 0 && centralApneas < 200) ||
    (reraIndex !== undefined && reraIndex >= 0 && reraIndex < 200) ||
    (leak !== undefined && leak >= 0 && leak < 500) ||
    (leakMax !== undefined && leakMax >= 0 && leakMax < 500) ||
    isReportPressureMetric(pressureAvg) ||
    isReportPressureMetric(pressure95th) ||
    isReportPressureMetric(ipapAvg) ||
    isReportPressureMetric(ipap95th) ||
    isReportPressureMetric(epapAvg) ||
    isReportPressureMetric(epap95th);

  if (!hasSignal) return null;
  return {
    date: day,
    usageHours: usageHours !== undefined && usageHours >= 0 && usageHours <= 24 ? usageHours : undefined,
    ahi: ahi !== undefined && ahi >= 0 && ahi < 200 ? ahi : undefined,
    residualApneas:
      residualApneas !== undefined && residualApneas >= 0 && residualApneas < 200 ? residualApneas : undefined,
    centralApneas:
      centralApneas !== undefined && centralApneas >= 0 && centralApneas < 200 ? centralApneas : undefined,
    reraIndex: reraIndex !== undefined && reraIndex >= 0 && reraIndex < 200 ? reraIndex : undefined,
    leak: leak !== undefined && leak >= 0 && leak < 500 ? leak : undefined,
    leakMax: leakMax !== undefined && leakMax >= 0 && leakMax < 500 ? leakMax : undefined,
    pressureAvg: isReportPressureMetric(pressureAvg) ? pressureAvg : undefined,
    pressure95th: isReportPressureMetric(pressure95th) ? pressure95th : undefined,
    ipapAvg: isReportPressureMetric(ipapAvg) ? ipapAvg : undefined,
    ipap95th: isReportPressureMetric(ipap95th) ? ipap95th : undefined,
    epapAvg: isReportPressureMetric(epapAvg) ? epapAvg : undefined,
    epap95th: isReportPressureMetric(epap95th) ? epap95th : undefined,
    therapySettingsSignature: therapySettings?.signature,
    therapySettingsLabel: therapySettings?.label,
    therapySettingsMachine: therapySettings?.machine
  };
}

function countAhiEventsFromEvText(text: string): number | null {
  if (!text.trim()) return null;
  let count = 0;
  for (const m of text.matchAll(/ID\s*=\s*(\d+)/gi)) {
    const id = Number(m[1]);
    if (id === 17 || id === 18 || id === 19) count += 1;
  }
  return count > 0 ? count : null;
}

function tryParseDelimited(text: string): ParsedRecord[] {
  const lines = text.split(/\r?\n/).filter((x) => x.trim().length > 0);
  if (lines.length < 2) return [];

  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const headers = lines[0].split(delimiter).map((h) => h.trim().toLowerCase());
  const compactHeader = (header: string) => header.toLowerCase().replace(/[\s_\-/%().]+/g, "");
  const isTherapySettingHeader = (header: string): boolean => {
    const compact = compactHeader(header);
    return (
      /^(?:therapy|pap|vent)?mode$/.test(compact) ||
      compact === "ventmode" ||
      /^(?:press|pressure|setpressure|cpappressure)$/.test(compact) ||
      /^(?:pmin|pmax|pressuremin|pressuremax|minpressure|maxpressure|minimumpressure|maximumpressure|setminpressure|setmaxpressure|automin|automax)$/.test(compact) ||
      /^(?:epap|ipap|epapset|ipapset|setepap|setipap|ipapmin|ipapmax|epapmin|epapmax|ipapminpressure|ipapmaxpressure|epapminpressure|epapmaxpressure)$/.test(compact) ||
      /^(?:rr|rrset|respiratoryrate|backuprate|vt|vtset|targetvt|tidalvolume|targettidalvolume|epr|flex|pressurerelief|ipr|ps|pressuresupport)$/.test(compact)
    );
  };

  const dateIdx = headers.findIndex((h) => /date|day/.test(h));
  const usageIdx = headers.findIndex((h) => /usage|hours|therapy/.test(h));
  const ahiIdx = headers.findIndex((h) => /ahi/.test(h));
  const residualIdx = headers.findIndex((h) => /(residual|apnea\s*index|(?:^|[^a-z])ai(?:[^a-z]|$))/i.test(h) && !/cai|oai|uai|ahi/i.test(h));
  const centralIdx = headers.findIndex((h) => /(central|(?:^|[^a-z])cai(?:[^a-z]|$))/i.test(h));
  const reraIdx = headers.findIndex((h) => /(?:^|[^a-z])rera(?:[^a-z]|$)|rera\s*index/.test(h));
  const leakIdx = headers.findIndex((h) => /leak/.test(h));
  const leakMaxIdx = headers.findIndex((h) => /(?:max).*(?:leak)|(?:leak).*(?:max)/.test(h));
  const pressureAvgIdx = headers.findIndex((h) => /(?:avg|average|mean).*press|press.*(?:avg|average|mean)/.test(h));
  const pressure95Idx = headers.findIndex((h) => /(?:95|p95).*press|press.*(?:95|p95)/.test(h));
  const ipapAvgIdx = headers.findIndex((h) => /(?:med|median|avg|average|mean).*ipap|ipap.*(?:med|median|avg|average|mean)/.test(h));
  const ipap95Idx = headers.findIndex((h) => /(?:95|p95).*ipap|ipap.*(?:95|p95)/.test(h));
  const epapAvgIdx = headers.findIndex((h) => /(?:med|median|avg|average|mean).*epap|epap.*(?:med|median|avg|average|mean)/.test(h));
  const epap95Idx = headers.findIndex((h) => /(?:95|p95).*epap|epap.*(?:95|p95)/.test(h));

  if (dateIdx < 0) return [];

  const out: ParsedRecord[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const row = lines[i].split(delimiter);
    const date = parseDateFromString(row[dateIdx] ?? "");
    if (!date) continue;
    const therapyKv = new Map<string, string>();
    for (let col = 0; col < headers.length; col += 1) {
      const header = headers[col];
      const value = row[col]?.trim();
      if (!header || !value || !isTherapySettingHeader(header)) continue;
      therapyKv.set(header, value);
    }
    const therapySettings = therapyKv.size > 0 ? buildTherapySettingsSnapshotFromKeyValueMap(therapyKv) : null;

    out.push({
      date,
      usageHours: usageIdx >= 0 ? safeNumber(row[usageIdx]) : undefined,
      ahi: ahiIdx >= 0 ? safeNumber(row[ahiIdx]) : undefined,
      residualApneas: residualIdx >= 0 ? safeNumber(row[residualIdx]) : undefined,
      centralApneas: centralIdx >= 0 ? safeNumber(row[centralIdx]) : undefined,
      reraIndex: reraIdx >= 0 ? safeNumber(row[reraIdx]) : undefined,
      leak: leakIdx >= 0 ? safeNumber(row[leakIdx]) : undefined,
      leakMax: leakMaxIdx >= 0 ? safeNumber(row[leakMaxIdx]) : undefined,
      pressureAvg: pressureAvgIdx >= 0 ? normalizePressureNumber(safeNumber(row[pressureAvgIdx])) : undefined,
      pressure95th: pressure95Idx >= 0 ? normalizePressureNumber(safeNumber(row[pressure95Idx])) : undefined,
      ipapAvg: ipapAvgIdx >= 0 ? normalizePressureNumber(safeNumber(row[ipapAvgIdx])) : undefined,
      ipap95th: ipap95Idx >= 0 ? normalizePressureNumber(safeNumber(row[ipap95Idx])) : undefined,
      epapAvg: epapAvgIdx >= 0 ? normalizePressureNumber(safeNumber(row[epapAvgIdx])) : undefined,
      epap95th: epap95Idx >= 0 ? normalizePressureNumber(safeNumber(row[epap95Idx])) : undefined,
      therapySettingsSignature: therapySettings?.signature,
      therapySettingsLabel: therapySettings?.label,
      therapySettingsMachine: therapySettings?.machine
    });
  }

  return out;
}

function tryParseFreeText(text: string): ParsedRecord[] {
  const lines = text.split(/\r?\n/).filter((x) => x.trim().length > 0);
  const out: ParsedRecord[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const date = parseDateFromString(line);
    if (!date) continue;

    const usageMatch = line.match(/(?:usage|therapy\s*hours|hours)\D*(-?\d+(?:\.\d+)?)/i);
    const ahiMatch = line.match(/ahi\D*(-?\d+(?:\.\d+)?)/i);
    const residualMatch = line.match(/(?:residual\s*apnea(?:s)?|residual\s*ahi|apnea\s*index|(?:^|[^a-z])ai(?:[^a-z]|$))\D*(-?\d+(?:\.\d+)?)/i);
    const centralMatch = line.match(/(?:central\s*apnea(?:s)?|central\s*index|(?:^|[^a-z])cai(?:[^a-z]|$))\D*(-?\d+(?:\.\d+)?)/i);
    const reraMatch = line.match(/(?:rera(?:\s*index)?)(?:\s*[:=]|\D)*(-?\d+(?:\.\d+)?)/i);
    const leakMatch = line.match(/leak(?:age)?\D*(-?\d+(?:\.\d+)?)/i);
    const leakMaxMatch = line.match(/(?:max(?:imum)?\s*leak(?:age)?|leak(?:age)?\s*max)\D*(-?\d+(?:\.\d+)?)/i);
    const pressureAvgMatch = line.match(/(?:avg|average|mean)\s*(?:mask\s*)?pressure\D*(-?\d+(?:\.\d+)?)/i);
    const pressure95Match = line.match(/(?:95(?:th|%)|p95)\s*(?:mask\s*)?pressure\D*(-?\d+(?:\.\d+)?)/i);
    const ipapAvgMatch = line.match(/(?:avg|average|mean|median|med)\s*ipap\D*(-?\d+(?:\.\d+)?)/i);
    const ipap95Match = line.match(/(?:95(?:th|%)|p95)\s*ipap\D*(-?\d+(?:\.\d+)?)/i);
    const epapAvgMatch = line.match(/(?:avg|average|mean|median|med)\s*epap\D*(-?\d+(?:\.\d+)?)/i);
    const epap95Match = line.match(/(?:95(?:th|%)|p95)\s*epap\D*(-?\d+(?:\.\d+)?)/i);

    out.push({
      date,
      usageHours: usageMatch ? safeNumber(usageMatch[1]) : undefined,
      ahi: ahiMatch ? safeNumber(ahiMatch[1]) : undefined,
      residualApneas: residualMatch ? safeNumber(residualMatch[1]) : undefined,
      centralApneas: centralMatch ? safeNumber(centralMatch[1]) : undefined,
      reraIndex: reraMatch ? safeNumber(reraMatch[1]) : undefined,
      leak: leakMatch ? safeNumber(leakMatch[1]) : undefined,
      leakMax: leakMaxMatch ? safeNumber(leakMaxMatch[1]) : undefined,
      pressureAvg: pressureAvgMatch ? normalizePressureNumber(safeNumber(pressureAvgMatch[1])) : undefined,
      pressure95th: pressure95Match ? normalizePressureNumber(safeNumber(pressure95Match[1])) : undefined,
      ipapAvg: ipapAvgMatch ? normalizePressureNumber(safeNumber(ipapAvgMatch[1])) : undefined,
      ipap95th: ipap95Match ? normalizePressureNumber(safeNumber(ipap95Match[1])) : undefined,
      epapAvg: epapAvgMatch ? normalizePressureNumber(safeNumber(epapAvgMatch[1])) : undefined,
      epap95th: epap95Match ? normalizePressureNumber(safeNumber(epap95Match[1])) : undefined
    });
  }

  return out;
}

function parseRecords(text: string): ParsedRecord[] {
  const fromDelimited = tryParseDelimited(text);
  if (fromDelimited.length > 0) return fromDelimited;
  return tryParseFreeText(text);
}

function sanitizeRecords(records: ParsedRecord[]): ParsedRecord[] {
  return records.filter((r) => {
    const hasSignal =
      (typeof r.usageHours === "number" && r.usageHours >= 0 && r.usageHours <= 24) ||
      (typeof r.ahi === "number" && r.ahi >= 0 && r.ahi < 200) ||
      (typeof r.residualApneas === "number" && r.residualApneas >= 0 && r.residualApneas < 200) ||
      (typeof r.centralApneas === "number" && r.centralApneas >= 0 && r.centralApneas < 200) ||
      (typeof r.reraIndex === "number" && r.reraIndex >= 0 && r.reraIndex < 200) ||
      (typeof r.leak === "number" && r.leak >= 0 && r.leak < 500) ||
      (typeof r.leak95th === "number" && r.leak95th >= 0 && r.leak95th < 500) ||
      (typeof r.leakMax === "number" && r.leakMax >= 0 && r.leakMax < 500) ||
      (typeof r.leakMax30m === "number" && r.leakMax30m >= 0 && r.leakMax30m < 500) ||
      (typeof r.leakMax60m === "number" && r.leakMax60m >= 0 && r.leakMax60m < 500) ||
      (typeof r.maxLeakMinutes === "number" && r.maxLeakMinutes >= 0) ||
      (typeof r.sustainedLeakMax === "number" && r.sustainedLeakMax >= 0 && r.sustainedLeakMax < 500) ||
      (typeof r.sustainedLeakMinutes === "number" && r.sustainedLeakMinutes >= 0) ||
      isReportPressureMetric(r.pressureAvg) ||
      isReportPressureMetric(r.pressure95th) ||
      isReportPressureMetric(r.ipapAvg) ||
      isReportPressureMetric(r.ipap95th) ||
      isReportPressureMetric(r.epapAvg) ||
      isReportPressureMetric(r.epap95th) ||
      isReportTidalVolumeMetric(r.tidalVolumeAvg) ||
      isReportTidalVolumeMetric(r.tidalVolumeMin) ||
      isReportTidalVolumeMetric(r.tidalVolumeMedian) ||
      isReportTidalVolumeMetric(r.tidalVolumeMax) ||
      isReportRespiratoryRateMetric(r.respiratoryRateAvg) ||
      isReportRespiratoryRateMetric(r.respiratoryRateMin) ||
      isReportRespiratoryRateMetric(r.respiratoryRate95th);
    return hasSignal;
  });
}

function recordSignature(record: ParsedRecord): string {
  const u = typeof record.usageHours === "number" ? record.usageHours.toFixed(3) : "";
  const a = typeof record.ahi === "number" ? record.ahi.toFixed(3) : "";
  const r = typeof record.residualApneas === "number" ? record.residualApneas.toFixed(3) : "";
  const c = typeof record.centralApneas === "number" ? record.centralApneas.toFixed(3) : "";
  const re = typeof record.reraIndex === "number" ? record.reraIndex.toFixed(3) : "";
  const l = typeof record.leak === "number" ? record.leak.toFixed(3) : "";
  const l95 = typeof record.leak95th === "number" ? record.leak95th.toFixed(3) : "";
  const lmax = typeof record.leakMax === "number" ? record.leakMax.toFixed(3) : "";
  const lmax30m = typeof record.leakMax30m === "number" ? record.leakMax30m.toFixed(3) : "";
  const lmax60m = typeof record.leakMax60m === "number" ? record.leakMax60m.toFixed(3) : "";
  const lmaxDurationValue = typeof record.maxLeakDurationValue === "number" ? record.maxLeakDurationValue.toFixed(3) : "";
  const lmaxMin = typeof record.maxLeakMinutes === "number" ? record.maxLeakMinutes.toFixed(3) : "";
  const sustainedLeakMax = typeof record.sustainedLeakMax === "number" ? record.sustainedLeakMax.toFixed(3) : "";
  const sustainedLeakMinutes = typeof record.sustainedLeakMinutes === "number" ? record.sustainedLeakMinutes.toFixed(3) : "";
  const pa = typeof record.pressureAvg === "number" ? record.pressureAvg.toFixed(3) : "";
  const p95 = typeof record.pressure95th === "number" ? record.pressure95th.toFixed(3) : "";
  const ia = typeof record.ipapAvg === "number" ? record.ipapAvg.toFixed(3) : "";
  const i95 = typeof record.ipap95th === "number" ? record.ipap95th.toFixed(3) : "";
  const ea = typeof record.epapAvg === "number" ? record.epapAvg.toFixed(3) : "";
  const e95 = typeof record.epap95th === "number" ? record.epap95th.toFixed(3) : "";
  const vt = typeof record.tidalVolumeAvg === "number" ? record.tidalVolumeAvg.toFixed(3) : "";
  const vtMin = typeof record.tidalVolumeMin === "number" ? record.tidalVolumeMin.toFixed(3) : "";
  const vtMedian = typeof record.tidalVolumeMedian === "number" ? record.tidalVolumeMedian.toFixed(3) : "";
  const vtMax = typeof record.tidalVolumeMax === "number" ? record.tidalVolumeMax.toFixed(3) : "";
  const vtCount = typeof record.tidalVolumeSampleCount === "number" ? record.tidalVolumeSampleCount.toString() : "";
  const rr = typeof record.respiratoryRateAvg === "number" ? record.respiratoryRateAvg.toFixed(3) : "";
  const rr95 = typeof record.respiratoryRate95th === "number" ? record.respiratoryRate95th.toFixed(3) : "";
  const rrCount = typeof record.respiratoryRateSampleCount === "number" ? record.respiratoryRateSampleCount.toString() : "";
  const rrMin = typeof record.respiratoryRateMin === "number" ? record.respiratoryRateMin.toFixed(3) : "";
  const therapySettings = record.therapySettingsSignature ?? "";
  return `${toIsoDate(record.date)}|${u}|${a}|${r}|${c}|${re}|${l}|${l95}|${lmax}|${lmax30m}|${lmax60m}|${lmaxDurationValue}|${lmaxMin}|${sustainedLeakMax}|${sustainedLeakMinutes}|${pa}|${p95}|${ia}|${i95}|${ea}|${e95}|${vt}|${vtMin}|${vtMedian}|${vtMax}|${vtCount}|${rr}|${rr95}|${rrCount}|${rrMin}|${therapySettings}`;
}

function dedupeParsedRecords(records: ParsedRecord[]): ParsedRecord[] {
  const seen = new Set<string>();
  const out: ParsedRecord[] = [];
  for (const record of records) {
    const key = recordSignature(record);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

function emit(onProgress: ParseRequest["onProgress"], progress: ParseProgress) {
  if (onProgress) onProgress(progress);
}

function readAsciiName(bytes: Uint8Array, start: number, length: number): string {
  const end = Math.min(bytes.length, start + length);
  let out = "";
  for (let i = start; i < end; i += 1) {
    const b = bytes[i];
    if (b === 0) break;
    if (b >= 32 && b <= 126) out += String.fromCharCode(b);
  }
  return out.trim();
}

function parseResventLeakFromBytes(bytes: Uint8Array): LeakStats | null {
  if (bytes.length < 0x24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const chunkDurationInSec = view.getUint16(0x10, true);
  if (chunkDurationInSec <= 0 || chunkDurationInSec > 3600) return null;

  const descriptionCount = view.getUint16(0x12, true);
  if (descriptionCount < 1 || descriptionCount > 64) return null;

  const descriptors: Array<{ name: string; samples: number }> = [];
  let maxSamples = 0;

  for (let i = 0; i < descriptionCount; i += 1) {
    const offset = 0x24 + i * 0x20;
    if (offset + 0x20 > bytes.length) return null;

    const name = readAsciiName(bytes, offset, 8);
    const samples = view.getUint16(offset + 0x1e, true);
    if (samples <= 0 || samples > 2048) return null;

    descriptors.push({ name, samples });
    if (samples > maxSamples) maxSamples = samples;
  }

  const leakIndex = descriptors.findIndex((d) => /^leak/i.test(d.name));
  if (leakIndex < 0 || maxSamples <= 0) return null;

  const dataOffset = 0x24 + descriptionCount * 0x20;
  if (dataOffset >= bytes.length) return null;

  const parseByLayout = (fixedStride: boolean): LeakStats | null => {
    let pos = dataOffset;
    let sum = 0;
    let count = 0;
    let max = -Infinity;
    let sustainedMax30m = -Infinity;
    let sustainedMax60m = -Infinity;
    let required30mSamples = 0;
    let required60mSamples = 0;
    let sampleIntervalSec = 0;
    let currentLargeLeakSeconds = 0;
    let currentLargeLeakMax = -Infinity;
    let longestLargeLeakSeconds = 0;
    let longestLargeLeakMax = -Infinity;
    let maxLeakEpisodeValue = -Infinity;
    let maxLeakEpisodeSeconds = 0;
    let rolling30m: RollingAverageState | null = null;
    let rolling60m: RollingAverageState | null = null;

    const finishLargeLeakEpisode = () => {
      if (currentLargeLeakSeconds <= 0 || !Number.isFinite(currentLargeLeakMax)) return;
      if (
        currentLargeLeakSeconds > longestLargeLeakSeconds ||
        (currentLargeLeakSeconds === longestLargeLeakSeconds && currentLargeLeakMax > longestLargeLeakMax)
      ) {
        longestLargeLeakSeconds = currentLargeLeakSeconds;
        longestLargeLeakMax = currentLargeLeakMax;
      }
      if (
        currentLargeLeakMax > maxLeakEpisodeValue ||
        (currentLargeLeakMax === maxLeakEpisodeValue && currentLargeLeakSeconds > maxLeakEpisodeSeconds)
      ) {
        maxLeakEpisodeValue = currentLargeLeakMax;
        maxLeakEpisodeSeconds = currentLargeLeakSeconds;
      }
      currentLargeLeakSeconds = 0;
      currentLargeLeakMax = -Infinity;
    };

    while (pos < bytes.length) {
      let leakStart = -1;
      let nextPos = pos;

      if (fixedStride) {
        const blockBytes = descriptionCount * maxSamples * 2;
        if (blockBytes <= 0 || pos + blockBytes > bytes.length) break;
        leakStart = pos + leakIndex * maxSamples * 2;
        nextPos = pos + blockBytes;
      } else {
        let cursor = pos;
        let valid = true;
        for (let i = 0; i < descriptionCount; i += 1) {
          const bytesForDesc = descriptors[i].samples * 2;
          if (cursor + bytesForDesc > bytes.length) {
            valid = false;
            break;
          }
          if (i === leakIndex) leakStart = cursor;
          cursor += bytesForDesc;
        }
        if (!valid || leakStart < 0) break;
        nextPos = cursor;
      }

      const leakSamples = fixedStride ? maxSamples : descriptors[leakIndex].samples;
      if (required30mSamples === 0 || required60mSamples === 0) {
        sampleIntervalSec = leakSamples > 0 ? chunkDurationInSec / leakSamples : 0;
        if (sampleIntervalSec > 0 && Number.isFinite(sampleIntervalSec)) {
          required30mSamples = Math.max(1, Math.ceil(1800 / sampleIntervalSec));
          required60mSamples = Math.max(1, Math.ceil(3600 / sampleIntervalSec));
          rolling30m = createRollingAverageState(required30mSamples);
          rolling60m = createRollingAverageState(required60mSamples);
        }
      }
      for (let i = 0; i < leakSamples; i += 1) {
        const sampleOffset = leakStart + i * 2;
        if (sampleOffset + 2 > bytes.length) break;

        const raw = view.getInt16(sampleOffset, true);
        const value = raw * 0.1;
        if (!Number.isFinite(value) || value < 0 || value > 500) {
          finishLargeLeakEpisode();
          resetRollingAverageState(rolling30m);
          resetRollingAverageState(rolling60m);
          continue;
        }

        sum += value;
        count += 1;
        if (value > max) max = value;
        if (sampleIntervalSec > 0 && value > LARGE_LEAK_THRESHOLD_LPM) {
          currentLargeLeakSeconds += sampleIntervalSec;
          currentLargeLeakMax = Number.isFinite(currentLargeLeakMax) ? Math.max(currentLargeLeakMax, value) : value;
        } else {
          finishLargeLeakEpisode();
        }
        const sustainedAverage30m = pushRollingAverage(rolling30m, value);
        if (sustainedAverage30m !== null && sustainedAverage30m > sustainedMax30m) sustainedMax30m = sustainedAverage30m;

        const sustainedAverage60m = pushRollingAverage(rolling60m, value);
        if (sustainedAverage60m !== null && sustainedAverage60m > sustainedMax60m) sustainedMax60m = sustainedAverage60m;
      }

      if (nextPos <= pos) break;
      pos = nextPos;
    }

    finishLargeLeakEpisode();
    if (count === 0 || !Number.isFinite(max)) return null;
    return {
      sum,
      count,
      max,
      sustainedMax30m: Number.isFinite(sustainedMax30m) ? sustainedMax30m : null,
      sustainedMax60m: Number.isFinite(sustainedMax60m) ? sustainedMax60m : null,
      maxLeakMinutes: maxLeakEpisodeSeconds > 0 ? maxLeakEpisodeSeconds / 60 : null,
      sustainedLeakMax: Number.isFinite(longestLargeLeakMax) ? longestLargeLeakMax : null,
      sustainedLeakMinutes: longestLargeLeakSeconds > 0 ? longestLargeLeakSeconds / 60 : null
    };
  };

  // OSCAR's Resvent loader behavior is closest to fixed-stride P-file parsing.
  return parseByLayout(true) ?? parseByLayout(false);
}

function pickResventCandidates(files: SourceMeta[], warnings: string[], lookbackDays: number): {
  configFiles: SourceMeta[];
  statFiles: SourceMeta[];
  sessionStatFiles: SourceMeta[];
  summaryStatFiles: SourceMeta[];
  evByDayUsage: Map<string, SourceMeta>;
  pFiles: SourceMeta[];
  windowDateSet: Set<string>;
  latestDate: Date;
} | null {
  const dated: Array<SourceMeta & { recordDate: Date }> = [];
  for (const m of files) {
    const rd = extractResventRecordDate(m.normalizedPath);
    if (!rd) continue;
    dated.push({ ...m, recordDate: rd });
  }
  if (dated.length === 0) return null;

  const latestDate = dated.reduce((acc, m) => (m.recordDate > acc ? m.recordDate : acc), dated[0].recordDate);
  const { start: windowStart, end: windowEnd } = resolveLatestDataWindow(latestDate, lookbackDays);

  const inWindow = dated.filter((m) => m.recordDate >= windowStart && m.recordDate < windowEnd);
  const windowDateSet = new Set(inWindow.map((m) => toClinicalIsoDate(m.recordDate)));

  const configFiles = files.filter(isResventConfigFile).filter((m) => m.file.size <= MAX_FILE_SIZE_BYTES);
  const usageStatFiles = inWindow.filter(isResventStatUsageFile).filter((m) => m.file.size <= MAX_FILE_SIZE_BYTES);
  const summaryStatFiles = inWindow.filter(isResventStatSummaryFile).filter((m) => m.file.size <= MAX_FILE_SIZE_BYTES);
  const statFiles = summaryStatFiles.length > 0 ? summaryStatFiles : usageStatFiles;
  // Plain STAT is the authoritative daily summary, but it collapses separate
  // mask-on intervals. When both forms exist, keep STATxx exclusively as
  // session-timing evidence so naps and long interruptions remain visible.
  const sessionStatFiles = summaryStatFiles.length > 0 ? usageStatFiles : [];
  if (summaryStatFiles.length === 0 && usageStatFiles.length > 0) {
    warnings.push("STAT daily summary files were not found; using STATxx session files for daily usage parsing.");
  }
  const evByDayUsage = new Map<string, SourceMeta>();
  for (const ev of inWindow.filter(isResventEvFile).filter((m) => m.file.size <= MAX_FILE_SIZE_BYTES)) {
    const usage = extractUsageSuffix(ev.baseName, "ev");
    if (!usage || !ev.recordDate) continue;
    evByDayUsage.set(`${toClinicalIsoDate(ev.recordDate)}:${usage}`, ev);
  }

  const statUsageSet = new Set(
    statFiles
      .map((m) => extractUsageSuffix(m.baseName, "stat"))
      .filter((v): v is string => v !== null)
  );

  const allP = inWindow
    .filter(isResventPFile)
    .filter((m) => {
      if (statUsageSet.size === 0) return true;
      const usage = extractResventPUsageSuffix(m.baseName);
      return usage !== null && statUsageSet.has(usage);
    })
    .filter((m) => m.file.size > 0 && m.file.size <= MAX_FILE_SIZE_BYTES)
    // Keep newest P-files first if caps are reached.
    .sort((a, b) => (a.normalizedPath > b.normalizedPath ? -1 : 1));

  const totalPBytes = allP.reduce((sum, m) => sum + m.file.size, 0);
  let pFiles: SourceMeta[] = allP;

  if (totalPBytes > MAX_RESVENT_P_TOTAL_BYTES) {
    const pByClinicalDay = new Map<string, SourceMeta[]>();
    for (const pFile of allP) {
      if (!pFile.recordDate) continue;
      const clinicalDay = toClinicalIsoDate(pFile.recordDate);
      const existing = pByClinicalDay.get(clinicalDay);
      if (existing) {
        existing.push(pFile);
      } else {
        pByClinicalDay.set(clinicalDay, [pFile]);
      }
    }

    let retainedBytes = 0;
    const retained: SourceMeta[] = [];
    const retainedDays: string[] = [];
    for (const clinicalDay of [...pByClinicalDay.keys()].sort((a, b) => b.localeCompare(a))) {
      const dayFiles = pByClinicalDay.get(clinicalDay) ?? [];
      const dayBytes = dayFiles.reduce((sum, m) => sum + m.file.size, 0);
      if (retainedBytes > 0 && retainedBytes + dayBytes > MAX_RESVENT_P_TOTAL_BYTES) {
        continue;
      }
      retained.push(...dayFiles);
      retainedBytes += dayBytes;
      retainedDays.push(clinicalDay);
    }

    pFiles = retained.sort((a, b) => (a.normalizedPath > b.normalizedPath ? -1 : 1));
    if (allP.length > pFiles.length) {
      warnings.push(
        `Leak channels were parsed from ${pFiles.length} of ${allP.length} P-files across ${retainedDays.length} recent therapy days to keep parsing responsive.`
      );
    }
  }

  return {
    configFiles,
    statFiles,
    sessionStatFiles,
    summaryStatFiles,
    evByDayUsage,
    pFiles,
    windowDateSet,
    latestDate
  };
}

function createEmptyDayBucket(): DayBucket {
  return {
    usageSum: 0,
    usageCount: 0,
    ahiWeightedSum: 0,
    ahiWeightHours: 0,
    ahiSum: 0,
    ahiCount: 0,
    residualApneaSum: 0,
    residualApneaCount: 0,
    centralApneaSum: 0,
    centralApneaCount: 0,
    reraSum: 0,
    reraCount: 0,
    leakSum: 0,
    leakCount: 0,
    leak95Sum: 0,
    leak95Count: 0,
    leakMax: null,
    leakMax30m: null,
    leakMax60m: null,
    maxLeakMinutes: null,
    sustainedLeakMax: null,
    sustainedLeakMinutes: null,
    pressureAvgSum: 0,
    pressureAvgCount: 0,
    pressure95Sum: 0,
    pressure95Count: 0,
    ipapAvgSum: 0,
    ipapAvgCount: 0,
    ipap95Sum: 0,
    ipap95Count: 0,
    epapAvgSum: 0,
    epapAvgCount: 0,
    epap95Sum: 0,
    epap95Count: 0,
    tidalVolumeSum: 0,
    tidalVolumeCount: 0,
    tidalVolumeMin: null,
    tidalVolumeMax: null,
    tidalVolumeBins: {},
    tidalVolumeSecondsByBin: {},
    respiratoryRateSum: 0,
    respiratoryRateCount: 0,
    respiratoryRateMin: null,
    respiratoryRateBins: {},
    therapySettingsSignature: null,
    therapySettingsLabel: null,
    therapySettingsMachine: null
  };
}

function createRollingAverageState(capacity: number): RollingAverageState | null {
  if (!Number.isFinite(capacity) || capacity <= 0) return null;
  return {
    values: new Float64Array(capacity),
    capacity,
    nextIndex: 0,
    length: 0,
    sum: 0
  };
}

function resetRollingAverageState(state: RollingAverageState | null) {
  if (!state) return;
  state.nextIndex = 0;
  state.length = 0;
  state.sum = 0;
}

function pushRollingAverage(state: RollingAverageState | null, value: number): number | null {
  if (!state) return null;

  if (state.length < state.capacity) {
    state.values[state.nextIndex] = value;
    state.sum += value;
    state.length += 1;
    state.nextIndex = (state.nextIndex + 1) % state.capacity;
  } else {
    state.sum -= state.values[state.nextIndex];
    state.values[state.nextIndex] = value;
    state.sum += value;
    state.nextIndex = (state.nextIndex + 1) % state.capacity;
  }

  if (state.length < state.capacity) return null;
  return state.sum / state.capacity;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function cloneMachineSettings(machine: QuickReportMetrics["machine"]): QuickReportMetrics["machine"] {
  return { ...machine };
}

function isAutoBiPapReportMachine(machine: QuickReportMetrics["machine"]): boolean {
  return (
    classifyTherapyMode(machine) === "BiPAP" &&
    (machine.pressureIsAuto === true || isAutoBiPapLikeMode(machine.mode) || Boolean(machine.pressureMin || machine.pressureMax))
  );
}

function buildDayBucketsFromRecordsAndLeaks(
  dedupedRecords: ParsedRecord[],
  leakStatsByDay: Map<string, LeakStats>,
  hasResventStructure: boolean
): Map<string, DayBucket> {
  const dayMap = new Map<string, DayBucket>();
  const maxLeakDurationsByDay = new Map<string, Array<{ leak: number; minutes: number }>>();

  for (const record of dedupedRecords) {
    const key = toClinicalIsoDate(record.date);
    const bucket = dayMap.get(key) ?? createEmptyDayBucket();
    let usageForAhiWeight: number | undefined;

    applyRecordTherapySettings(bucket, record);

    if (typeof record.usageHours === "number" && record.usageHours >= 0 && record.usageHours <= 24) {
      bucket.usageSum += record.usageHours;
      bucket.usageCount += 1;
      usageForAhiWeight = record.usageHours;
    }

    if (typeof record.ahi === "number" && record.ahi >= 0 && record.ahi < 200) {
      if (usageForAhiWeight && usageForAhiWeight > 0) {
        bucket.ahiWeightedSum += record.ahi * usageForAhiWeight;
        bucket.ahiWeightHours += usageForAhiWeight;
      } else {
        bucket.ahiSum += record.ahi;
        bucket.ahiCount += 1;
      }
    }

    if (typeof record.residualApneas === "number" && record.residualApneas >= 0 && record.residualApneas < 200) {
      bucket.residualApneaSum += record.residualApneas;
      bucket.residualApneaCount += 1;
    }

    if (typeof record.centralApneas === "number" && record.centralApneas >= 0 && record.centralApneas < 200) {
      bucket.centralApneaSum += record.centralApneas;
      bucket.centralApneaCount += 1;
    }

    if (typeof record.reraIndex === "number" && record.reraIndex >= 0 && record.reraIndex < 200) {
      bucket.reraSum += record.reraIndex;
      bucket.reraCount += 1;
    }

    if (isReportPressureMetric(record.pressureAvg)) {
      bucket.pressureAvgSum += record.pressureAvg;
      bucket.pressureAvgCount += 1;
    }

    if (isReportPressureMetric(record.pressure95th)) {
      bucket.pressure95Sum += record.pressure95th;
      bucket.pressure95Count += 1;
    }

    if (isReportPressureMetric(record.ipapAvg)) {
      bucket.ipapAvgSum += record.ipapAvg;
      bucket.ipapAvgCount += 1;
    }

    if (isReportPressureMetric(record.ipap95th)) {
      bucket.ipap95Sum += record.ipap95th;
      bucket.ipap95Count += 1;
    }

    if (isReportPressureMetric(record.epapAvg)) {
      bucket.epapAvgSum += record.epapAvg;
      bucket.epapAvgCount += 1;
    }

    if (isReportPressureMetric(record.epap95th)) {
      bucket.epap95Sum += record.epap95th;
      bucket.epap95Count += 1;
    }

    if (isReportTidalVolumeMetric(record.tidalVolumeAvg)) {
      const count =
        typeof record.tidalVolumeSampleCount === "number" &&
        Number.isFinite(record.tidalVolumeSampleCount) &&
        record.tidalVolumeSampleCount > 0
          ? record.tidalVolumeSampleCount
          : 1;
      bucket.tidalVolumeSum += record.tidalVolumeAvg * count;
      bucket.tidalVolumeCount += count;
    }

    if (isReportTidalVolumeMetric(record.tidalVolumeMin)) {
      bucket.tidalVolumeMin =
        bucket.tidalVolumeMin === null ? record.tidalVolumeMin : Math.min(bucket.tidalVolumeMin, record.tidalVolumeMin);
    }

    if (isReportTidalVolumeMetric(record.tidalVolumeMax)) {
      bucket.tidalVolumeMax =
        bucket.tidalVolumeMax === null ? record.tidalVolumeMax : Math.max(bucket.tidalVolumeMax, record.tidalVolumeMax);
    }

    mergeHistogram(bucket.tidalVolumeBins, record.tidalVolumeBins);
    mergeHistogram(bucket.tidalVolumeSecondsByBin, record.tidalVolumeSecondsByBin);

    if (isReportRespiratoryRateMetric(record.respiratoryRateAvg)) {
      const count =
        typeof record.respiratoryRateSampleCount === "number" &&
        Number.isFinite(record.respiratoryRateSampleCount) &&
        record.respiratoryRateSampleCount > 0
          ? record.respiratoryRateSampleCount
          : 1;
      bucket.respiratoryRateSum += record.respiratoryRateAvg * count;
      bucket.respiratoryRateCount += count;
    }

    if (isReportRespiratoryRateMetric(record.respiratoryRateMin)) {
      bucket.respiratoryRateMin =
        bucket.respiratoryRateMin === null ? record.respiratoryRateMin : Math.min(bucket.respiratoryRateMin, record.respiratoryRateMin);
    }

    mergeHistogram(bucket.respiratoryRateBins, record.respiratoryRateBins);

    if (typeof record.leak === "number" && record.leak >= 0 && record.leak < 500) {
      bucket.leakSum += record.leak;
      bucket.leakCount += 1;
      if (bucket.leakMax === null || record.leak > bucket.leakMax) {
        bucket.leakMax = record.leak;
        bucket.maxLeakMinutes = null;
      }
    }

    if (typeof record.leak95th === "number" && record.leak95th >= 0 && record.leak95th < 500) {
      bucket.leak95Sum += record.leak95th;
      bucket.leak95Count += 1;
    }

    if (typeof record.leakMax === "number" && record.leakMax >= 0 && record.leakMax < 500) {
      const maxLeakMinutes =
        typeof record.maxLeakMinutes === "number" && Number.isFinite(record.maxLeakMinutes) && record.maxLeakMinutes >= 0
          ? record.maxLeakMinutes
          : null;
      const bucketMaxLeakMinutes = bucket.maxLeakMinutes ?? null;
      if (
        bucket.leakMax === null ||
        record.leakMax > bucket.leakMax ||
        (record.leakMax === bucket.leakMax &&
          maxLeakMinutes !== null &&
          (bucketMaxLeakMinutes === null || maxLeakMinutes > bucketMaxLeakMinutes))
      ) {
        bucket.leakMax = record.leakMax;
        bucket.maxLeakMinutes = maxLeakMinutes;
      }
    }

    if (typeof record.leakMax30m === "number" && record.leakMax30m >= 0 && record.leakMax30m < 500) {
      bucket.leakMax30m =
        bucket.leakMax30m === null ? record.leakMax30m : Math.max(bucket.leakMax30m, record.leakMax30m);
    }

    if (typeof record.leakMax60m === "number" && record.leakMax60m >= 0 && record.leakMax60m < 500) {
      bucket.leakMax60m =
        bucket.leakMax60m === null ? record.leakMax60m : Math.max(bucket.leakMax60m, record.leakMax60m);
    }

    if (
      typeof record.sustainedLeakMax === "number" &&
      typeof record.sustainedLeakMinutes === "number" &&
      Number.isFinite(record.sustainedLeakMax) &&
      Number.isFinite(record.sustainedLeakMinutes) &&
      record.sustainedLeakMax >= 0 &&
      record.sustainedLeakMax < 500 &&
      record.sustainedLeakMinutes >= 0 &&
      (bucket.sustainedLeakMinutes == null ||
        record.sustainedLeakMinutes > bucket.sustainedLeakMinutes ||
        (record.sustainedLeakMinutes === bucket.sustainedLeakMinutes &&
          (bucket.sustainedLeakMax == null || record.sustainedLeakMax > bucket.sustainedLeakMax)))
    ) {
      bucket.sustainedLeakMax = record.sustainedLeakMax;
      bucket.sustainedLeakMinutes = record.sustainedLeakMinutes;
    }

    if (
      typeof record.maxLeakDurationValue === "number" &&
      typeof record.maxLeakMinutes === "number" &&
      Number.isFinite(record.maxLeakDurationValue) &&
      Number.isFinite(record.maxLeakMinutes) &&
      record.maxLeakDurationValue >= 0 &&
      record.maxLeakDurationValue < 500 &&
      record.maxLeakMinutes >= 0
    ) {
      const durations = maxLeakDurationsByDay.get(key) ?? [];
      durations.push({ leak: record.maxLeakDurationValue, minutes: record.maxLeakMinutes });
      maxLeakDurationsByDay.set(key, durations);
    }

    dayMap.set(key, bucket);
  }

  for (const [day, stats] of leakStatsByDay.entries()) {
    const bucket = dayMap.get(day) ?? createEmptyDayBucket();
    if (!(hasResventStructure && bucket.leakCount > 0)) {
      bucket.leakSum += stats.sum / stats.count;
      bucket.leakCount += 1;
    }
    if (
      bucket.leakMax === null ||
      stats.max > bucket.leakMax ||
      (stats.max === bucket.leakMax &&
        typeof stats.maxLeakMinutes === "number" &&
        (bucket.maxLeakMinutes == null || stats.maxLeakMinutes > bucket.maxLeakMinutes))
    ) {
      bucket.leakMax = stats.max;
      bucket.maxLeakMinutes = stats.maxLeakMinutes;
    }
    if (typeof stats.sustainedMax30m === "number" && Number.isFinite(stats.sustainedMax30m)) {
      bucket.leakMax30m = bucket.leakMax30m === null ? stats.sustainedMax30m : Math.max(bucket.leakMax30m, stats.sustainedMax30m);
    }
    if (typeof stats.sustainedMax60m === "number" && Number.isFinite(stats.sustainedMax60m)) {
      bucket.leakMax60m = bucket.leakMax60m === null ? stats.sustainedMax60m : Math.max(bucket.leakMax60m, stats.sustainedMax60m);
    }
    if (
      typeof stats.sustainedLeakMax === "number" &&
      typeof stats.sustainedLeakMinutes === "number" &&
      Number.isFinite(stats.sustainedLeakMax) &&
      Number.isFinite(stats.sustainedLeakMinutes) &&
      (bucket.sustainedLeakMinutes == null ||
        stats.sustainedLeakMinutes > bucket.sustainedLeakMinutes ||
        (stats.sustainedLeakMinutes === bucket.sustainedLeakMinutes &&
          (bucket.sustainedLeakMax == null || stats.sustainedLeakMax > bucket.sustainedLeakMax)))
    ) {
      bucket.sustainedLeakMax = stats.sustainedLeakMax;
      bucket.sustainedLeakMinutes = stats.sustainedLeakMinutes;
    }
    dayMap.set(day, bucket);
  }

  for (const [day, durations] of maxLeakDurationsByDay.entries()) {
    const bucket = dayMap.get(day);
    if (!bucket || bucket.leakMax === null) continue;
    const matchingDuration = durations
      .filter((entry) => sameLeakMetricValue(entry.leak, bucket.leakMax as number))
      .sort((a, b) => b.minutes - a.minutes)[0];
    if (matchingDuration && (bucket.maxLeakMinutes == null || matchingDuration.minutes > bucket.maxLeakMinutes)) {
      bucket.maxLeakMinutes = matchingDuration.minutes;
    }
  }

  return dayMap;
}

function sanitizeMachineSettingsForResolvedMode(
  machine: QuickReportMetrics["machine"],
  canonicalMode: "BiPAP" | "APAP" | "CPAP"
) {
  if (canonicalMode === "CPAP") {
    machine.pressureIsAuto = false;
    machine.pressureMin = undefined;
    machine.pressureMax = undefined;
    machine.epap = undefined;
    machine.ipap = undefined;
    machine.epapAvg = undefined;
    machine.epap95th = undefined;
    machine.ipapAvg = undefined;
    machine.ipap95th = undefined;
    machine.respiratoryRate = undefined;
    machine.tidalVolume = undefined;
    return;
  }

  if (canonicalMode === "APAP") {
    machine.pressureIsAuto = true;
    machine.epap = undefined;
    machine.ipap = undefined;
    machine.epapAvg = undefined;
    machine.epap95th = undefined;
    machine.ipapAvg = undefined;
    machine.ipap95th = undefined;
    machine.respiratoryRate = undefined;
    machine.tidalVolume = undefined;
    return;
  }

  const isAutoBiPap = isAutoBiPapLikeMode(machine.mode) || Boolean(machine.pressureMin || machine.pressureMax);
  machine.pressureIsAuto = isAutoBiPap;
  if (!isAutoBiPap) {
    machine.pressureMin = undefined;
    machine.pressureMax = undefined;
  }
}

function normalizeMachineSettingsForModeResolution(machine: QuickReportMetrics["machine"]) {
  const explicitMode = resolveExplicitTherapyMode(machine.mode);

  if (explicitMode === "APAP" || explicitMode === "CPAP") {
    machine.epap = undefined;
    machine.ipap = undefined;
    machine.epapAvg = undefined;
    machine.epap95th = undefined;
    machine.ipapAvg = undefined;
    machine.ipap95th = undefined;
    machine.respiratoryRate = undefined;
    machine.tidalVolume = undefined;
  } else if (explicitMode === "BiPAP") {
    const isAutoBiPap = isAutoBiPapLikeMode(machine.mode) || Boolean(machine.pressureMin || machine.pressureMax);
    machine.pressureIsAuto = isAutoBiPap;
    if (!isAutoBiPap) {
      machine.pressureMin = undefined;
      machine.pressureMax = undefined;
    }
  }

  if (!machine.pressureIsAuto && (isLikelyAutoMode(machine.mode) || !!machine.pressureMin || !!machine.pressureMax)) {
    machine.pressureIsAuto = true;
  }

  if ((!machine.pressureMin || !machine.pressureMax) && machine.pressure && !/\b(?:epap|ipap)\b/i.test(machine.pressure)) {
    const rangeMatch = machine.pressure.match(/(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/);
    if (rangeMatch) {
      const min = normalizePressureNumber(safeNumber(rangeMatch[1]));
      const max = normalizePressureNumber(safeNumber(rangeMatch[2]));
      if (!machine.pressureMin && min !== undefined) machine.pressureMin = pressureText(min);
      if (!machine.pressureMax && max !== undefined) machine.pressureMax = pressureText(max);
      if (min !== undefined || max !== undefined) machine.pressureIsAuto = true;
    }
  }

  if ((!machine.epap || !machine.ipap) && machine.pressure && /\b(?:epap|ipap)\b/i.test(machine.pressure)) {
    const epapMatch = machine.pressure.match(/epap\s*(-?\d+(?:\.\d+)?)(?:\s*-\s*(-?\d+(?:\.\d+)?))?/i);
    const ipapMatch = machine.pressure.match(/ipap\s*(-?\d+(?:\.\d+)?)(?:\s*-\s*(-?\d+(?:\.\d+)?))?/i);
    const epapLow = normalizePressureNumber(epapMatch ? safeNumber(epapMatch[1]) : undefined);
    const epapHigh = normalizePressureNumber(epapMatch ? safeNumber(epapMatch[2]) : undefined);
    const ipapLow = normalizePressureNumber(ipapMatch ? safeNumber(ipapMatch[1]) : undefined);
    const ipapHigh = normalizePressureNumber(ipapMatch ? safeNumber(ipapMatch[2]) : undefined);

    if (!machine.epap) {
      if (epapLow !== undefined && epapHigh !== undefined) {
        machine.epap = `${Number(epapLow.toFixed(2)).toString()}-${Number(epapHigh.toFixed(2)).toString()} cmH2O`;
      } else if (epapLow !== undefined) {
        machine.epap = pressureText(epapLow);
      }
    }

    if (!machine.ipap) {
      if (ipapLow !== undefined && ipapHigh !== undefined) {
        machine.ipap = `${Number(ipapLow.toFixed(2)).toString()}-${Number(ipapHigh.toFixed(2)).toString()} cmH2O`;
      } else if (ipapLow !== undefined) {
        machine.ipap = pressureText(ipapLow);
      }
    }
  }
}

function evidenceOnlyTherapyMode(machine: QuickReportMetrics["machine"]): CanonicalTherapyMode | null {
  return classifyTherapyMode({ ...machine, mode: undefined });
}

function resolveTherapyModeOrThrow(
  machine: QuickReportMetrics["machine"],
  familyLabel: string
): CanonicalTherapyMode {
  normalizeMachineSettingsForModeResolution(machine);
  const canonicalTherapyMode = classifyTherapyMode(machine);
  if (!canonicalTherapyMode) {
    throw new Error(
      `The ${familyLabel} layout was detected, but the therapy mode could not be verified as BiPAP, APAP, or CPAP. The device is loadable only when one of those modes can be confirmed.`
    );
  }
  if (!resolveExplicitTherapyMode(machine.mode)) {
    machine.mode = canonicalTherapyMode;
  }
  sanitizeMachineSettingsForResolvedMode(machine, canonicalTherapyMode);
  return canonicalTherapyMode;
}

function verifyResolvedTherapyModeOrThrow(
  machine: QuickReportMetrics["machine"],
  familyLabel: string
): CanonicalTherapyMode {
  const canonicalTherapyMode = resolveExplicitTherapyMode(machine.mode);
  if (!canonicalTherapyMode) {
    throw new Error(
      `The ${familyLabel} layout was detected, but the resolved therapy mode was lost before report finalization.`
    );
  }

  const evidenceMode = evidenceOnlyTherapyMode(machine);
  if (evidenceMode && evidenceMode !== canonicalTherapyMode) {
    throw new Error(
      `The ${familyLabel} layout was detected, but the resolved therapy mode became inconsistent during report finalization.`
    );
  }

  sanitizeMachineSettingsForResolvedMode(machine, canonicalTherapyMode);
  return canonicalTherapyMode;
}

function createFamilyParserDeps(): FamilyParserDeps {
  return {
    emit,
    decodeLikelyTextVariants,
    inferMachineSettingsFromText,
    parseKeyValueLines,
    inferPressureSettingsFromMap,
    inferBilevelSettingsFromMap,
    inferPressureReliefFromMap,
    parseResventStatText,
    parseGenericDailyKeyValueRecord,
    parseRecords,
    sanitizeRecords,
    dedupeParsedRecords
  };
}

function isGenericTextCandidate(meta: SourceMeta): boolean {
  if (TEXT_EXTENSIONS.has(meta.ext) && meta.file.size <= MAX_FILE_SIZE_BYTES) return true;
  if (GENERIC_BINARY_EXTENSIONS.has(meta.ext) && meta.file.size <= MAX_GENERIC_BINARY_FILE_BYTES) return true;
  if ((meta.ext.length === 0 || meta.ext === "dat") && GENERIC_NAME_HINT.test(meta.baseName) && meta.file.size <= MAX_FILE_SIZE_BYTES) {
    return true;
  }
  return false;
}

function usesDedicatedFamilyParser(familyId: string): boolean {
  return (
    familyId === "resmed" ||
    familyId === "prs1" ||
    familyId === "prisma" ||
    familyId === "weinmann" ||
    familyId === "bmc" ||
    familyId === "bmcg3x" ||
    familyId === "sleepstyle" ||
    familyId === "icon" ||
    familyId === "intellipap" ||
    familyId === "mseries" ||
    familyId === "vrem" ||
    familyId === "yuwell"
  );
}

function formatLoaderRecencyDate(date: Date | null): string {
  return date ? toIsoDate(date) : "no dated folder evidence";
}

function buildMixedLoaderWarning(selection: RecencyLoaderSelection, selectedFamily: ParserFamilyDefinition): string | null {
  if (selection.summaries.length < 2) return null;
  const detectedIds = new Set(selection.summaries.map((summary) => summary.match.id));
  const isOnlyFisherPaykelAmbiguity = [...detectedIds].every((id) => id === "sleepstyle" || id === "icon");
  if (isOnlyFisherPaykelAmbiguity) return null;

  const summaries = [...selection.summaries].sort((a, b) => {
    const dateDelta = (b.latestDate?.getTime() ?? Number.NEGATIVE_INFINITY) - (a.latestDate?.getTime() ?? Number.NEGATIVE_INFINITY);
    if (dateDelta !== 0) return dateDelta;
    return b.match.score - a.match.score || a.match.label.localeCompare(b.match.label);
  });
  const recencyText = summaries
    .slice(0, 4)
    .map((summary) => `${summary.match.label}: ${formatLoaderRecencyDate(summary.latestDate)}`)
    .join("; ");

  if (selection.selectedByLatestDatedData) {
    const selectedSummary = summaries.find((summary) => summary.match.id === selection.selected?.id) ?? null;
    return `Mixed device data detected. Selected ${selectedFamily.label} because it has the newest dated folder data (${formatLoaderRecencyDate(selectedSummary?.latestDate ?? null)}). Detected layouts: ${recencyText}.`;
  }

  return `Multiple device layouts detected. Selected ${selectedFamily.label}. Dated folder comparison: ${recencyText}.`;
}

async function refineSelectedFamily(
  selectedFamily: ParserFamilyDefinition | null,
  loaderRanking: LoaderMatch[],
  meta: SourceMeta[]
): Promise<ParserFamilyDefinition | null> {
  if (hasBmcBundleStructure(meta) && (!selectedFamily || selectedFamily.id === "bmc")) {
    return getParserFamily("bmc") ?? selectedFamily;
  }

  if (hasBmcG3xCandidateStructure(meta)) {
    for (const candidate of meta.filter((entry) => entry.ext === "idx")) {
      try {
        if (isBmcG3xIdx((await candidate.file.readBytes()).subarray(0, 32))) {
          return getParserFamily("bmcg3x") ?? selectedFamily;
        }
      } catch {
        // Keep scanning other IDX candidates.
      }
    }
    if (selectedFamily?.id === "bmcg3x") {
      return loaderRanking.find((match) => match.id !== "bmcg3x")?.family ?? null;
    }
  }

  if (!selectedFamily) {
    for (const candidate of meta.slice(0, 20)) {
      const lowerPath = candidate.normalizedPath.toLowerCase();

      if (candidate.ext === "dat" && candidate.file.size >= 14 && candidate.file.size <= MAX_FILE_SIZE_BYTES) {
        try {
          const bytes = (await candidate.file.readBytes()).subarray(0, Math.min(candidate.file.size, 256));
          if (bytes.length >= 14) {
            const recordCount = ((bytes[2] ?? 0) << 8) | (bytes[1] ?? 0);
            const expectedMinSize = 3 + recordCount * 11;
            const month = bytes[7] ?? 0;
            const day = bytes[8] ?? 0;
            const hour = bytes[9] ?? 0;
            const minute = bytes[10] ?? 0;
            const second = bytes[11] ?? 0;
            if (
              recordCount > 0 &&
              expectedMinSize <= candidate.file.size &&
              month >= 1 &&
              month <= 12 &&
              day >= 1 &&
              day <= 31 &&
              hour <= 23 &&
              minute <= 59 &&
              second <= 59
            ) {
              return getParserFamily("md300w1");
            }
          }
        } catch {
          // keep scanning
        }
      }

      if (candidate.ext === "csv" && candidate.file.size <= MAX_FILE_SIZE_BYTES) {
        try {
          const header = new TextDecoder("utf-8", { fatal: false })
            .decode((await candidate.file.readBytes()).subarray(0, 4096))
            .split(/\r?\n/, 1)[0]
            .toLowerCase();
          if (
            header.includes("timestamp") &&
            (header.includes("inclination") || header.includes("orientation") || header.includes("movement"))
          ) {
            return getParserFamily("somnopose");
          }
        } catch {
          // keep scanning
        }
      }
    }
    return null;
  }

  const topIds = new Set(loaderRanking.slice(0, 4).map((loader) => loader.id));
  if (!(topIds.has("sleepstyle") && topIds.has("icon"))) {
    return selectedFamily;
  }

  const summaryCandidate = meta.find((candidate) =>
    /(?:^|\/)(?:fphcare\/)?icon\/[^/]+\/sum.*\.fph$/i.test(candidate.normalizedPath)
  );
  if (!summaryCandidate) return selectedFamily;

  try {
    const header = new TextDecoder("ascii", { fatal: false })
      .decode((await summaryCandidate.file.readBytes()).subarray(0, 0x200))
      .toUpperCase();
    if (header.includes("SLEEPSTYLE")) return getParserFamily("sleepstyle") ?? selectedFamily;
    if (/\bICON\b/.test(header)) return getParserFamily("icon") ?? selectedFamily;
  } catch {
    return selectedFamily;
  }

  return selectedFamily;
}

async function prepareQuickReportSourceInternal(request: PrepareQuickReportSourceRequest): Promise<PreparedQuickReportSource> {
  const { files, lookbackDays, onProgress } = request;
  const normalizedLookbackDays = normalizeLookbackDays(lookbackDays);

  const warnings: string[] = [];
  const machine: QuickReportMetrics["machine"] = {};
  const records: ParsedRecord[] = [];
  let sourceTimeZoneOffsetMinutes: number | null = null;

  const meta = files.map(toSourceMeta);
  const loaderRanking = rankParserFamilies(meta);
  const loaderSelection = selectLoaderMatchByDatedRecency(meta, loaderRanking);
  const likelyLoaders = loaderRanking.map((m) => m.label);
  const selectedLoader = loaderSelection.selected;
  const selectedFamily = await refineSelectedFamily(selectedLoader?.family ?? null, loaderRanking, meta);
  if (!selectedFamily) {
    throw new Error("Device structure was not recognized. This webapp only loads supported CPAP/NIV SD-card layouts.");
  }
  if (!selectedFamily.supportedQuickReport) {
    throw new Error(`${selectedFamily.label} data is not loadable in this webapp. Only supported CPAP/NIV device layouts are accepted.`);
  }
  sourceTimeZoneOffsetMinutes = await extractSourceTimeZoneOffsetMinutes(selectedFamily, meta);
  if (sourceTimeZoneOffsetMinutes === null) {
    sourceTimeZoneOffsetMinutes =
      normalizeUtcOffsetMinutes(request.userTimeZoneOffsetMinutes ?? -new Date().getTimezoneOffset()) ?? null;
  }

  const hasResventStructure =
    selectedFamily.id === "resvent" &&
    (hasFamilySignature(meta, "resvent") || meta.some((m) => /(?:^|\/)(?:therapy\/)?(?:record|config)\//i.test(m.normalizedPath)));
  const leakStatsByDay = new Map<string, LeakStats>();
  let fallbackWindowDateSet = new Set<string>();
  let latestPathDate: Date | null = null;

  emit(onProgress, { phase: "scan", detail: "Scanning files...", percent: 8 });

  if (hasResventStructure) {
    const selected = pickResventCandidates(meta, warnings, normalizedLookbackDays);
    if (selected) {
      fallbackWindowDateSet = selected.windowDateSet;
      latestPathDate = selected.latestDate;

      const totalResventWork =
        selected.configFiles.length + selected.statFiles.length + selected.sessionStatFiles.length + selected.pFiles.length;
      let processed = 0;

      const resventConfigByBase = new Map<string, SourceMeta>();
      for (const configFile of selected.configFiles) {
        resventConfigByBase.set(configFile.baseName.toUpperCase(), configFile);
      }

      const mergedResventConfig = new Map<string, string>();
      let activeResventConfigBase: string | null = null;
      let tctrlVentMode: string | null = null;
      let latestStatVentMode: { raw: string; clinicalDayIso: string; normalizedPath: string } | null = null;
      const appliedResventConfigBases = new Set<string>();
      const resventTimedRecords: ResventTimedRecord[] = [];

      const readResventConfigIntoMergedState = async (configFile: SourceMeta) => {
        const baseName = configFile.baseName.toUpperCase();
        if (appliedResventConfigBases.has(baseName)) return;
        appliedResventConfigBases.add(baseName);

        processed += 1;
        const pct = 8 + Math.round((processed / Math.max(1, totalResventWork)) * 62);
        emit(onProgress, {
          phase: "parse",
          detail: `Reading ${configFile.normalizedPath}`,
          percent: Math.min(70, pct)
        });

        try {
          const bytes = await configFile.file.readBytes();
          const text = decodeResventText(bytes, true);
          if (text.trim().length === 0) return;
          const kv = parseKeyValueLines(text);
          inferMachineSettingsFromText(text, machine);
          for (const [key, value] of kv.entries()) {
            mergedResventConfig.set(key, value);
          }

          if (baseName === "TCTRL") {
            const ventMode = extractResventVentModeRawFromKeyValueMap(kv);
            if (ventMode) {
              tctrlVentMode = ventMode;
              activeResventConfigBase = RESVENT_ACTIVE_CONFIG_BY_VENT_MODE.get(ventMode) ?? null;
            }
          }
        } catch {
          warnings.push(`Could not read ${configFile.normalizedPath}`);
        }
      };

      for (const baseName of RESVENT_SHARED_CONFIG_FILES) {
        const configFile = resventConfigByBase.get(baseName);
        if (!configFile) continue;
        await readResventConfigIntoMergedState(configFile);
      }

      if (!activeResventConfigBase) {
        const inferredFromMode = [...RESVENT_MODE_FROM_FILE.entries()].find(([, mode]) => mode === machine.mode)?.[0];
        activeResventConfigBase = inferredFromMode ?? null;
      }

      if (activeResventConfigBase) {
        const activeConfigFile = resventConfigByBase.get(activeResventConfigBase);
        if (activeConfigFile) {
          await readResventConfigIntoMergedState(activeConfigFile);
          inferMachineSettingsFromConfigFilename(activeConfigFile.normalizedPath, machine);
        }
      }

      for (const statFile of selected.statFiles) {
        processed += 1;
        const pct = 8 + Math.round((processed / Math.max(1, totalResventWork)) * 62);
        emit(onProgress, {
          phase: "parse",
          detail: `Parsing ${statFile.normalizedPath}`,
          percent: Math.min(70, pct)
        });

        try {
          const bytes = await statFile.file.readBytes();
          if (statFile.recordDate === null) continue;
          const statVentMode = extractResventVentModeFromBytes(bytes);
          if (statVentMode) {
            const clinicalDayIso = toClinicalIsoDate(statFile.recordDate);
            if (
              latestStatVentMode === null ||
              clinicalDayIso > latestStatVentMode.clinicalDayIso ||
              (clinicalDayIso === latestStatVentMode.clinicalDayIso &&
                statFile.normalizedPath > latestStatVentMode.normalizedPath)
            ) {
              latestStatVentMode = {
                raw: statVentMode,
                clinicalDayIso,
                normalizedPath: statFile.normalizedPath
              };
            }
          }
          const parsed = parseResventStatFromBytes(bytes, statFile.recordDate);
          if (parsed) {
            const usage = extractUsageSuffix(statFile.baseName, "stat");
            if (usage && parsed.usageHours && parsed.usageHours > 0) {
              const key = `${toClinicalIsoDate(statFile.recordDate)}:${usage}`;
              const evFile = selected.evByDayUsage.get(key);
              if (evFile) {
                try {
                  const evText = decodeResventText(await evFile.file.readBytes(), true);
                  const evCount = countAhiEventsFromEvText(evText);
                  if (evCount !== null) {
                    parsed.ahi = evCount / parsed.usageHours;
                  }
                } catch {
                  // Keep stat-derived AHI if EV parsing fails.
                }
              }
            }
            if (selected.sessionStatFiles.length > 0 && isResventStatSummaryFile(statFile)) {
              parsed.therapySessionStart = undefined;
              parsed.therapySessionEnd = undefined;
            }
            if (parsed.therapySessionStart && parsed.therapySessionEnd) {
              resventTimedRecords.push({ record: parsed, sourceFile: statFile.file });
            }
            records.push(parsed);
          }
        } catch {
          warnings.push(`Could not read ${statFile.normalizedPath}`);
        }

        if (processed % 20 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      for (const statFile of selected.sessionStatFiles) {
        processed += 1;
        const pct = 8 + Math.round((processed / Math.max(1, totalResventWork)) * 62);
        emit(onProgress, {
          phase: "parse",
          detail: `Reading session timing from ${statFile.normalizedPath}`,
          percent: Math.min(70, pct)
        });

        try {
          const bytes = await statFile.file.readBytes();
          if (statFile.recordDate === null) continue;
          const parsed = parseResventStatFromBytes(bytes, statFile.recordDate);
          if (!parsed?.therapySessionStart || !parsed.therapySessionEnd) continue;
          const timingRecord: ParsedRecord = {
            date: parsed.date,
            therapySessionStart: parsed.therapySessionStart,
            therapySessionEnd: parsed.therapySessionEnd
          };
          resventTimedRecords.push({ record: timingRecord, sourceFile: statFile.file });
          records.push(timingRecord);
        } catch {
          warnings.push(`Could not read session timing from ${statFile.normalizedPath}`);
        }

        if (processed % 20 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      if (resventTimedRecords.length > 0) {
        const clock = resolveResventSessionClockOffset(resventTimedRecords);
        for (const entry of resventTimedRecords) {
          applySessionClockOffset(entry.record, clock.offsetMinutes);
        }
        const direction = clock.offsetMinutes >= 0 ? "+" : "-";
        const absoluteMinutes = Math.abs(clock.offsetMinutes);
        const adjustment = `${direction}${Math.floor(absoluteMinutes / 60)}:${String(absoluteMinutes % 60).padStart(2, "0")}`;
        warnings.push(
          clock.verifiedFileCount > 0
            ? `Resvent session clock normalized by ${adjustment} from the device epoch to machine/computer local wall time (verified against ${clock.verifiedFileCount} STAT file timestamps).`
            : `Resvent session clock normalized by ${adjustment} using the device format's local-wall-clock convention; STAT file timestamps were unavailable for independent verification.`
        );
      }

      const verifiedResventVentMode = latestStatVentMode?.raw ?? tctrlVentMode;
      if (tctrlVentMode && latestStatVentMode && latestStatVentMode.raw !== tctrlVentMode) {
        warnings.push(
          `Resvent VentMode disagreed between TCTRL (${tctrlVentMode}) and latest STAT (${latestStatVentMode.raw}); using latest STAT from ${latestStatVentMode.clinicalDayIso}.`
        );
      }
      if (verifiedResventVentMode) {
        const verifiedModeLabel = RESVENT_MODE_FROM_VENT_MODE.get(verifiedResventVentMode);
        const verifiedConfigBase = RESVENT_ACTIVE_CONFIG_BY_VENT_MODE.get(verifiedResventVentMode) ?? null;
        if (verifiedModeLabel) {
          machine.mode = verifiedModeLabel;
        }
        if (verifiedConfigBase && verifiedConfigBase !== activeResventConfigBase) {
          const verifiedConfigFile = resventConfigByBase.get(verifiedConfigBase);
          if (verifiedConfigFile) {
            await readResventConfigIntoMergedState(verifiedConfigFile);
            inferMachineSettingsFromConfigFilename(verifiedConfigFile.normalizedPath, machine);
            activeResventConfigBase = verifiedConfigBase;
          }
        }
      }

      inferMachineSettingsFromConfigMap(mergedResventConfig, machine);

      if (selected.summaryStatFiles.length > 0 && selected.summaryStatFiles !== selected.statFiles) {
        for (const statFile of selected.summaryStatFiles) {
          processed += 1;
          const pct = 8 + Math.round((processed / Math.max(1, totalResventWork)) * 62);
          emit(onProgress, {
            phase: "parse",
            detail: `Reading pressure summary from ${statFile.normalizedPath}`,
            percent: Math.min(70, pct)
          });

          try {
            const bytes = await statFile.file.readBytes();
            if (statFile.recordDate === null) continue;
            const parsed = parseResventStatFromBytes(bytes, statFile.recordDate);
            if (!parsed) continue;
            if (
              typeof parsed.pressureAvg !== "number" &&
              typeof parsed.pressure95th !== "number" &&
              typeof parsed.leak !== "number" &&
              typeof parsed.leakMax !== "number"
            ) {
              continue;
            }
            records.push({
              date: parsed.date,
              pressureAvg: parsed.pressureAvg,
              pressure95th: parsed.pressure95th,
              leak: parsed.leak,
              leakMax: parsed.leakMax
            });
          } catch {
            warnings.push(`Could not read ${statFile.normalizedPath}`);
          }

          if (processed % 20 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      }

      for (const pFile of selected.pFiles) {
        processed += 1;
        const pct = 8 + Math.round((processed / Math.max(1, totalResventWork)) * 62);
        emit(onProgress, {
          phase: "parse",
          detail: `Sampling leak from ${pFile.normalizedPath}`,
          percent: Math.min(70, pct)
        });

        if (pFile.recordDate === null) continue;

        try {
          const bytes = await pFile.file.readBytes();
          const leak = parseResventLeakFromBytes(bytes);
          if (!leak) continue;

          const key = toClinicalIsoDate(pFile.recordDate);
          const existing = leakStatsByDay.get(key);
          if (existing) {
            const replacesMaxLeak = leak.max > existing.max;
            existing.sum += leak.sum;
            existing.count += leak.count;
            if (replacesMaxLeak) {
              existing.max = leak.max;
              existing.maxLeakMinutes = leak.maxLeakMinutes;
            } else if (
              typeof leak.maxLeakMinutes === "number" &&
              Number.isFinite(leak.maxLeakMinutes) &&
              leak.max === existing.max &&
              (existing.maxLeakMinutes === null || leak.maxLeakMinutes > existing.maxLeakMinutes)
            ) {
              existing.maxLeakMinutes = leak.maxLeakMinutes;
            }
            if (
              typeof leak.sustainedLeakMax === "number" &&
              typeof leak.sustainedLeakMinutes === "number" &&
              Number.isFinite(leak.sustainedLeakMax) &&
              Number.isFinite(leak.sustainedLeakMinutes) &&
              (existing.sustainedLeakMinutes === null ||
                leak.sustainedLeakMinutes > existing.sustainedLeakMinutes ||
                (leak.sustainedLeakMinutes === existing.sustainedLeakMinutes &&
                  (existing.sustainedLeakMax === null || leak.sustainedLeakMax > existing.sustainedLeakMax)))
            ) {
              existing.sustainedLeakMax = leak.sustainedLeakMax;
              existing.sustainedLeakMinutes = leak.sustainedLeakMinutes;
            }
            if (
              typeof leak.sustainedMax30m === "number" &&
              Number.isFinite(leak.sustainedMax30m) &&
              (existing.sustainedMax30m === null || leak.sustainedMax30m > existing.sustainedMax30m)
            ) {
              existing.sustainedMax30m = leak.sustainedMax30m;
            }
            if (
              typeof leak.sustainedMax60m === "number" &&
              Number.isFinite(leak.sustainedMax60m) &&
              (existing.sustainedMax60m === null || leak.sustainedMax60m > existing.sustainedMax60m)
            ) {
              existing.sustainedMax60m = leak.sustainedMax60m;
            }
          } else {
            leakStatsByDay.set(key, { ...leak });
          }
        } catch {
          warnings.push(`Could not read ${pFile.normalizedPath}`);
        }

        if (processed % 20 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }
  }

  const runGenericPass = true;
  const genericTextCandidates = meta.filter(isGenericTextCandidate);
  const familyScopedGenericCandidates = selectedFamily
    ? genericTextCandidates.filter((candidate) => isCandidateForFamily(candidate, selectedFamily))
    : genericTextCandidates;
  const familyScopedAllCandidates = selectedFamily
    ? meta.filter((candidate) => isCandidateForFamily(candidate, selectedFamily))
    : meta;
  const genericCandidatesRaw = runGenericPass
    ? selectGenericCandidates(familyScopedGenericCandidates, selectedFamily, normalizedLookbackDays)
    : [];
  const genericCandidates =
    hasResventStructure
      ? genericCandidatesRaw.filter(
          (m) =>
            !(
              isResventConfigFile(m) ||
              isResventStatUsageFile(m) ||
              isResventStatSummaryFile(m) ||
              isResventPFile(m) ||
              isResventEvFile(m)
            )
        )
      : genericCandidatesRaw;
  const familyParserCandidates =
    selectedFamily && usesDedicatedFamilyParser(selectedFamily.id)
      ? familyScopedAllCandidates
      : genericCandidates;

  if (runGenericPass && genericTextCandidates.length > MAX_GENERIC_FILES_TO_SCAN) {
    warnings.push(
      `Input contained many candidate files; generic parsing prioritized ${genericCandidates.length} files (cap ${MAX_GENERIC_FILES_TO_SCAN}).`
    );
  }

  const familyParserContext = {
    familyLabel: selectedFamily.label,
    candidates: familyParserCandidates,
    lookbackDays: normalizedLookbackDays,
    machine,
    records,
    sourceTimeZoneOffsetMinutes,
    historyStartClinicalDayIso: null as string | null,
    warnings,
    onProgress,
    progressStart: 70,
    progressEnd: 80
  };
  const familyParserDeps = createFamilyParserDeps();

  if (selectedFamily.id === "resmed") {
    await parseResMedFamily(familyParserContext, familyParserDeps);
  } else if (selectedFamily.id === "prs1") {
    await parsePrs1Family(familyParserContext, familyParserDeps);
  } else if (selectedFamily.id === "prisma") {
    await parsePrismaFamily(familyParserContext, familyParserDeps);
  } else if (selectedFamily.id === "sleepstyle") {
    await parseSleepStyleFamily(familyParserContext, familyParserDeps);
  } else if (selectedFamily.id === "icon") {
    await parseIconFamily(familyParserContext, familyParserDeps);
  } else if (selectedFamily.id === "weinmann") {
    await parseWeinmannFamily(familyParserContext, familyParserDeps);
  } else if (selectedFamily.id === "bmc") {
    await parseBmcFamily(familyParserContext, familyParserDeps);
  } else if (selectedFamily.id === "bmcg3x") {
    await parseBmcG3xFamily(familyParserContext, familyParserDeps);
  } else if (selectedFamily.id === "intellipap") {
    await parseIntelliPapFamily(familyParserContext, familyParserDeps);
  } else if (selectedFamily.id === "mseries") {
    await parseMSeriesFamily(familyParserContext, familyParserDeps);
  } else if (selectedFamily.id === "vrem") {
    await parseVremFamily(familyParserContext, familyParserDeps);
  } else if (selectedFamily.id === "yuwell") {
    await parseYuwellFamily(familyParserContext, familyParserDeps);
  } else {
    await runTextFamilyParser(familyParserContext, familyParserDeps);
  }

  sourceTimeZoneOffsetMinutes = familyParserContext.sourceTimeZoneOffsetMinutes;

  emit(onProgress, { phase: "verify", detail: "Verifying therapy mode...", percent: 81 });
  resolveTherapyModeOrThrow(machine, selectedFamily.label);

  const therapySessions = extractTherapyUsageSessions(records);
  const dedupedRecords = dedupeParsedRecords(records);
  if (dedupedRecords.length < records.length) {
    warnings.push(`Deduplicated ${records.length - dedupedRecords.length} overlapping daily records.`);
  }

  let latest: Date | null =
    dedupedRecords.length > 0
      ? dedupedRecords.reduce(
          (acc, r) => {
            const clinicalDay = toClinicalDay(r.date);
            return clinicalDay > acc ? clinicalDay : acc;
          },
          toClinicalDay(dedupedRecords[0].date)
        )
      : null;
  if (latestPathDate) {
    const latestPathClinical = toClinicalDay(latestPathDate);
    if (!latest || latestPathClinical > latest) {
      latest = latestPathClinical;
    }
  }

  if (!latest) {
    const detectedText = selectedLoader
      ? ` Selected loader: ${selectedFamily.label}.`
      : likelyLoaders.length > 0
        ? ` Detected layouts: ${likelyLoaders.join(", ")}.`
        : "";
    throw new Error(
      `No date-stamped CPAP data was detected. Verify the selected folder is the SD card root and contains importable records.${detectedText}`
    );
  }

  const dayMap = buildDayBucketsFromRecordsAndLeaks(dedupedRecords, leakStatsByDay, hasResventStructure);

  if (dayMap.size === 0) {
    if (fallbackWindowDateSet.size > 0 && hasResventStructure) {
      throw new Error(
        "Data import succeeded but no daily metrics were parsed from THERAPY/RECORD. Verify this export includes STAT/STATxx and EVxx files."
      );
    }
    throw new Error(`Data import succeeded but no records were found in the most recent ${normalizedLookbackDays}-day date range.`);
  }

  const importedTherapyChangeWarning = buildImportedTherapyChangeWarning(dayMap, normalizedLookbackDays);
  if (importedTherapyChangeWarning) warnings.push(importedTherapyChangeWarning);

  if (selectedLoader) {
    const top = loaderRanking.slice(0, 4).map((m) => `${m.label} (${m.score})`).join(", ");
    warnings.unshift(`Selected loader: ${selectedFamily.label}. Candidate scores: ${top}.`);
    const mixedLoaderWarning = buildMixedLoaderWarning(loaderSelection, selectedFamily);
    if (mixedLoaderWarning) warnings.unshift(mixedLoaderWarning);
  } else if (likelyLoaders.length > 0) {
    warnings.unshift(`Detected OSCAR-compatible loader signatures: ${likelyLoaders.join(", ")}.`);
  }

  const therapySettingsPeriods = buildTherapySettingsPeriods(dayMap);
  const currentTherapyPeriod = therapySettingsPeriods.find((period) => period.kind === "current");
  const currentTherapySessions = currentTherapyPeriod
    ? therapySessions.filter((session) => {
        if (session.sourceClinicalDayIso) {
          return (
            session.sourceClinicalDayIso >= currentTherapyPeriod.startClinicalDayIso &&
            session.sourceClinicalDayIso <= currentTherapyPeriod.endClinicalDayIso
          );
        }
        const start = new Date(session.startIso);
        const clinicalDay = toClinicalIsoDate(start);
        const calendarDay = toIsoDate(start);
        return (
          (clinicalDay >= currentTherapyPeriod.startClinicalDayIso && clinicalDay <= currentTherapyPeriod.endClinicalDayIso) ||
          (calendarDay >= currentTherapyPeriod.startClinicalDayIso && calendarDay <= currentTherapyPeriod.endClinicalDayIso)
        );
      })
    : therapySessions;

  return {
    selectedLoader: selectedFamily.label,
    machine: cloneMachineSettings(machine),
    sourceTimeZoneOffsetMinutes,
    warnings,
    historyStartClinicalDayIso: familyParserContext.historyStartClinicalDayIso,
    latestClinicalDayIso: toIsoDate(latest),
    maxLookbackDays: normalizedLookbackDays,
    therapySettingsPeriods,
    therapySessions,
    sleepTimingProfile: inferSleepTimingProfile(currentTherapySessions),
    dayBuckets: Object.fromEntries(dayMap.entries())
  };
}

export async function prepareQuickReportSource(request: PrepareQuickReportSourceRequest): Promise<PreparedQuickReportSource> {
  return await prepareQuickReportSourceInternal(request);
}

export function buildQuickReportMetricsFromPreparedSource(
  prepared: PreparedQuickReportSource,
  request: BuildQuickReportMetricsFromPreparedRequest
): QuickReportMetrics {
  const { patientName, dateOfBirthIso, physicianName, lookbackDays, windowEndClinicalDayIso, therapyPeriodKind = "current", onProgress } = request;
  const normalizedLookbackDays = Math.min(normalizeLookbackDays(lookbackDays), prepared.maxLookbackDays);
  const therapySettingsPeriods =
    prepared.therapySettingsPeriods ??
    buildTherapySettingsPeriods(new Map(Object.entries(prepared.dayBuckets).map(([day, bucket]) => [day, { ...bucket }])));
  const selectedTherapyPeriod = therapySettingsPeriods.find((period) => period.kind === therapyPeriodKind);
  if (therapyPeriodKind === "previous" && (!selectedTherapyPeriod || !selectedTherapyPeriod.machine)) {
    throw new Error("Previous settings unavailable from this device/card.");
  }
  const warnings =
    therapyPeriodKind === "previous"
      ? prepared.warnings.filter((warning) => !/^Therapy settings changed during\b/.test(warning))
      : [...prepared.warnings];
  const now = new Date();
  const machine =
    therapyPeriodKind === "previous" && selectedTherapyPeriod?.machine
      ? {
          ...(prepared.machine.device ? { device: prepared.machine.device } : {}),
          ...cloneMachineSettings(selectedTherapyPeriod.machine)
        }
      : cloneMachineSettings(prepared.machine);
  const sourceTimeZoneOffsetMinutes = prepared.sourceTimeZoneOffsetMinutes ?? null;

  emit(onProgress, { phase: "compute", detail: `Computing ${normalizedLookbackDays}-day metrics...`, percent: 82 });

  const latest = new Date(`${prepared.latestClinicalDayIso}T12:00:00Z`);
  if (Number.isNaN(latest.getTime())) {
    throw new Error("Prepared therapy history could not determine a valid latest clinical day.");
  }

  const allDayEntries = Object.entries(prepared.dayBuckets);
  const buildWindowSelection = (window: DateWindow) => {
    const windowStartIso = toIsoDate(window.start);
    const windowEndIso = toIsoDate(window.end);
    let effectiveWindowStartIso = windowStartIso;

    const availableDayKeys = new Set(allDayEntries.map(([day]) => day).filter((day) => day < windowEndIso));
    const historyStartClinicalDayIso = prepared.historyStartClinicalDayIso?.trim();
    if (historyStartClinicalDayIso && historyStartClinicalDayIso < windowEndIso) {
      availableDayKeys.add(historyStartClinicalDayIso);
    }
    if (availableDayKeys.size > 0) {
      const earliestAvailableIso = [...availableDayKeys].sort((a, b) => a.localeCompare(b))[0];
      if (earliestAvailableIso > effectiveWindowStartIso) {
        effectiveWindowStartIso = earliestAvailableIso;
      }
    }

    const dayMap = new Map<string, DayBucket>(
      allDayEntries
        .filter(([day]) => day >= effectiveWindowStartIso && day < windowEndIso)
        .map(([day, bucket]) => [day, { ...bucket }])
    );

    return {
      windowStartIso,
      windowEndIso,
      effectiveWindowStartIso,
      dayMap
    };
  };

  const resolvedWindowEndClinicalDayIso =
    therapyPeriodKind === "previous" && selectedTherapyPeriod
      ? addIsoCalendarDays(selectedTherapyPeriod.endClinicalDayIso, 1)
      : windowEndClinicalDayIso;
  const defaultWindow = resolvedWindowEndClinicalDayIso
    ? resolveWindowFromClinicalEndIso(resolvedWindowEndClinicalDayIso, normalizedLookbackDays)
    : resolveRecentWindow(latest, normalizedLookbackDays, sourceTimeZoneOffsetMinutes);
  let { windowStartIso, windowEndIso, effectiveWindowStartIso, dayMap } = buildWindowSelection(defaultWindow);

  if (!windowEndClinicalDayIso && dayMap.size === 0) {
    const latestDataWindow = resolveLatestDataWindow(latest, normalizedLookbackDays);
    const fallbackSelection = buildWindowSelection(latestDataWindow);
    if (fallbackSelection.dayMap.size > 0) {
      ({ windowStartIso, windowEndIso, effectiveWindowStartIso, dayMap } = fallbackSelection);
      warnings.push(
        `Latest available therapy data ended on ${formatDateHuman(prepared.latestClinicalDayIso)}; calculations were anchored to the latest available clinical day instead of today.`
      );
    }
  }

  const therapySettingsWindowGuard = applyTherapySettingsWindowGuard(dayMap, warnings, normalizedLookbackDays);
  if (therapySettingsWindowGuard.effectiveWindowStartIso) {
    dayMap = therapySettingsWindowGuard.dayMap;
    effectiveWindowStartIso = therapySettingsWindowGuard.effectiveWindowStartIso;
  }

  if (therapyPeriodKind === "previous") {
    warnings.push("Historical therapy period for review only. Export is unavailable.");
  }

  const summaryAggregationPolicy = getReportSummaryAggregationPolicy(prepared.selectedLoader);

  if (dayMap.size === 0) {
    throw new Error(`Data import succeeded but no records were found in the most recent ${normalizedLookbackDays}-day date range.`);
  }

  const dayBuckets = [...dayMap.values()];
  const usageValues = dayBuckets
    .filter((d) => d.usageCount > 0)
    .map((d) => Math.min(24, d.usageSum))
    .filter((v) => Number.isFinite(v) && v >= 0 && v <= 24);

  const ahiValues = dayBuckets
    .map((d) => {
      if (d.ahiWeightHours > 0) return d.ahiWeightedSum / d.ahiWeightHours;
      if (d.ahiCount > 0) return d.ahiSum / d.ahiCount;
      return undefined;
    })
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const residualApneaValues = dayBuckets
    .filter((d) => d.residualApneaCount > 0)
    .map((d) => d.residualApneaSum / d.residualApneaCount);

  const centralApneaValues = dayBuckets
    .filter((d) => d.centralApneaCount > 0)
    .map((d) => d.centralApneaSum / d.centralApneaCount);

  const reraValues = dayBuckets
    .filter((d) => d.reraCount > 0)
    .map((d) => d.reraSum / d.reraCount);

  const leakValues = dayBuckets
    .filter((d) => d.leakCount > 0)
    .map((d) => d.leakSum / d.leakCount);

  const leak95Values = dayBuckets
    .filter((d) => d.leak95Count > 0)
    .map((d) => d.leak95Sum / d.leak95Count);

  const leakMaxValues = dayBuckets
    .map((d) => d.leakMax)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const leakMax30mValues = dayBuckets
    .map((d) => d.leakMax30m)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const leakMax60mValues = dayBuckets
    .map((d) => d.leakMax60m)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const maxLeakMinuteCandidates = dayBuckets
    .map((d) => ({ leak: d.leakMax, minutes: d.maxLeakMinutes }))
    .filter(
      (entry): entry is { leak: number; minutes: number } =>
        typeof entry.leak === "number" &&
        Number.isFinite(entry.leak) &&
        typeof entry.minutes === "number" &&
        Number.isFinite(entry.minutes) &&
        entry.minutes >= 0
    );

  const sustainedLeakCandidates = dayBuckets
    .map((d) => ({ leak: d.sustainedLeakMax, minutes: d.sustainedLeakMinutes }))
    .filter(
      (entry): entry is { leak: number; minutes: number } =>
        typeof entry.leak === "number" &&
        Number.isFinite(entry.leak) &&
        typeof entry.minutes === "number" &&
        Number.isFinite(entry.minutes) &&
        entry.minutes >= 0
    );

  const pressureAvgValues = dayBuckets
    .filter((d) => d.pressureAvgCount > 0)
    .map((d) => d.pressureAvgSum / d.pressureAvgCount);

  const pressure95Values = dayBuckets
    .filter((d) => d.pressure95Count > 0)
    .map((d) => d.pressure95Sum / d.pressure95Count);

  const ipapAvgValues = dayBuckets
    .filter((d) => d.ipapAvgCount > 0)
    .map((d) => d.ipapAvgSum / d.ipapAvgCount);

  const ipap95Values = dayBuckets
    .filter((d) => d.ipap95Count > 0)
    .map((d) => d.ipap95Sum / d.ipap95Count);

  const epapAvgValues = dayBuckets
    .filter((d) => d.epapAvgCount > 0)
    .map((d) => d.epapAvgSum / d.epapAvgCount);

  const epap95Values = dayBuckets
    .filter((d) => d.epap95Count > 0)
    .map((d) => d.epap95Sum / d.epap95Count);

  const tidalVolumeValues = dayBuckets
    .filter((d) => d.tidalVolumeCount > 0)
    .map((d) => d.tidalVolumeSum / d.tidalVolumeCount);

  const tidalVolumeMinValues = dayBuckets
    .map((d) => d.tidalVolumeMin)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const tidalVolumeMaxValues = dayBuckets
    .map((d) => d.tidalVolumeMax)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const tidalVolumeBins = mergeDayHistograms(dayBuckets, "tidalVolumeBins");
  const tidalVolumeSecondsByBin = mergeDayHistograms(dayBuckets, "tidalVolumeSecondsByBin");

  const respiratoryRateAvgValues = dayBuckets
    .filter((d) => d.respiratoryRateCount > 0)
    .map((d) => d.respiratoryRateSum / d.respiratoryRateCount);

  const respiratoryRateMinValues = dayBuckets
    .map((d) => d.respiratoryRateMin)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const respiratoryRateBins = mergeDayHistograms(dayBuckets, "respiratoryRateBins");

  const weightedUsageRate = (
    values: number[],
    dayValue: (bucket: DayBucket) => number | null
  ): number | null => {
    let weightedSum = 0;
    let totalHours = 0;

    for (const bucket of dayBuckets) {
      const usageHours = bucket.usageCount > 0 ? Math.min(24, bucket.usageSum) : 0;
      const value = dayValue(bucket);
      if (usageHours > 0 && value !== null) {
        weightedSum += value * usageHours;
        totalHours += usageHours;
      }
    }

    if (totalHours > 0) return weightedSum / totalHours;
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };

  const effectiveWindowStart = new Date(`${effectiveWindowStartIso}T12:00:00Z`);
  const effectiveWindowEnd = new Date(`${windowEndIso}T12:00:00Z`);
  const effectiveDaySpan = Math.max(0, Math.round((effectiveWindowEnd.getTime() - effectiveWindowStart.getTime()) / (24 * 3600 * 1000)));
  const effectiveWindowDays = Math.max(1, Math.min(normalizedLookbackDays, effectiveDaySpan));
  const displayedWindowStartIso = effectiveWindowStartIso;
  const displayedWindowEndIso = toIsoDate(addUtcDays(effectiveWindowEnd, -1));
  if (effectiveWindowDays < normalizedLookbackDays) {
    warnings.push(
      `Only ${effectiveWindowDays} days of therapy history are available; calculations were adjusted from ${normalizedLookbackDays} days to avoid false deficits.`
    );
  }

  const daysWithDataRaw = dayMap.size;
  const daysWithData = Math.min(daysWithDataRaw, effectiveWindowDays);
  const daysWithUsage = usageValues.length;
  let compliantDays = usageValues.filter((u) => u >= 4).length;
  const complianceBaseDays = Math.max(1, effectiveWindowDays);
  const avgUsageHours = usageValues.length > 0 ? usageValues.reduce((a, b) => a + b, 0) / usageValues.length : null;
  const dailyTotalTherapyHours = usageValues.reduce((sum, hours) => sum + hours, 0);
  const sessionPeriod = selectedTherapyPeriod
    ? prepared.therapySessions?.filter((session) => {
        if (session.sourceClinicalDayIso) {
          return (
            session.sourceClinicalDayIso >= selectedTherapyPeriod.startClinicalDayIso &&
            session.sourceClinicalDayIso <= selectedTherapyPeriod.endClinicalDayIso
          );
        }
        const start = new Date(session.startIso);
        const clinicalDay = toClinicalIsoDate(start);
        const calendarDay = toIsoDate(start);
        return (
          (clinicalDay >= selectedTherapyPeriod.startClinicalDayIso && clinicalDay <= selectedTherapyPeriod.endClinicalDayIso) ||
          (calendarDay >= selectedTherapyPeriod.startClinicalDayIso && calendarDay <= selectedTherapyPeriod.endClinicalDayIso)
        );
      }) ?? []
    : prepared.therapySessions ?? [];
  const reportSessions = sessionPeriod.filter((session) => {
    if (session.sourceClinicalDayIso) {
      return session.sourceClinicalDayIso >= effectiveWindowStartIso && session.sourceClinicalDayIso < windowEndIso;
    }
    const clinicalDay = toClinicalIsoDate(new Date(session.startIso));
    return clinicalDay >= effectiveWindowStartIso && clinicalDay < windowEndIso;
  });
  const sleepTimingProfile =
    therapyPeriodKind === "current" && prepared.sleepTimingProfile
      ? prepared.sleepTimingProfile
      : inferSleepTimingProfile(sessionPeriod);
  const sleepClassification = sleepTimingProfile
    ? classifyTherapySessions(reportSessions, sleepTimingProfile)
    : null;
  const sessionTherapyHours = sleepClassification ? sleepClassification.totalTherapyMinutes / 60 : 0;
  const rawTimingCoveragePercent =
    dailyTotalTherapyHours > 0 ? (sessionTherapyHours / dailyTotalTherapyHours) * 100 : 0;
  const timingCoveragePercent = Math.min(100, rawTimingCoveragePercent);
  const hasUsableSessionTiming =
    sleepTimingProfile !== null &&
    sleepClassification !== null &&
    sleepClassification.days.length >= 1 &&
    rawTimingCoveragePercent >= MIN_SESSION_TIMING_COVERAGE_PERCENT &&
    rawTimingCoveragePercent <= MAX_SESSION_TIMING_COVERAGE_PERCENT;
  const sleepTimingAnalysis =
    hasUsableSessionTiming && sleepTimingProfile
      ? buildSleepTimingAnalysis(sleepTimingProfile, timingCoveragePercent)
      : null;
  const totalTherapyHours = hasUsableSessionTiming
    ? Math.max(dailyTotalTherapyHours, sessionTherapyHours)
    : dailyTotalTherapyHours;
  const expectedSleepTherapyHours = hasUsableSessionTiming && sleepClassification
    ? sleepClassification.expectedSleepMinutes / 60
    : null;
  const suspectedNapTherapyHours = hasUsableSessionTiming && sleepClassification
    ? sleepClassification.suspectedNapMinutes / 60
    : null;
  const unclassifiedTherapyHours = hasUsableSessionTiming
    ? Math.max(0, totalTherapyHours - sessionTherapyHours)
    : null;
  const timedUsageDays = sleepClassification?.days.filter((day) => day.totalTherapyMinutes > 0).length ?? 0;
  const avgExpectedSleepTherapyHours =
    expectedSleepTherapyHours !== null && timedUsageDays > 0 ? expectedSleepTherapyHours / timedUsageDays : null;
  const avgSuspectedNapTherapyHours =
    suspectedNapTherapyHours !== null && timedUsageDays > 0 ? suspectedNapTherapyHours / timedUsageDays : null;

  if (hasUsableSessionTiming && sleepClassification && sleepTimingProfile) {
    compliantDays = Math.min(complianceBaseDays, sleepClassification.compliantDays);
    warnings.push(
      `CMS 4+ correlation uses the inferred principal therapy episode for each patient-specific sleep day; separate suspected naps are excluded and therapy interruptions of up to 30 minutes are grouped.`
    );
    if (sleepTimingProfile.scheduleDriftDetected) {
      warnings.push(
        "The patient's recent therapy timing differs from the earlier imported pattern; the inferred sleep window is low-confidence and should be clinically reviewed."
      );
    } else if (sleepTimingProfile.confidence === "low") {
      warnings.push("The inferred sleep window has low confidence because therapy start times were inconsistent.");
    }
  } else if (dailyTotalTherapyHours > 0) {
    if (rawTimingCoveragePercent > MAX_SESSION_TIMING_COVERAGE_PERCENT) {
      warnings.push(
        `Session intervals exceeded device-reported therapy by ${Math.round(rawTimingCoveragePercent - 100)}%; sleep timing was not inferred from inconsistent source data.`
      );
    }
    warnings.push(
      "Session-level timing was unavailable or incomplete for this report; 4+ usage uses device-reported daily totals, which may include naps."
    );
  }
  let ahiWeightedAcrossWindow = 0;
  let ahiWeightHoursAcrossWindow = 0;
  const ahiFallbackValues: number[] = [];
  for (const bucket of dayBuckets) {
    if (bucket.ahiWeightHours > 0) {
      ahiWeightedAcrossWindow += bucket.ahiWeightedSum;
      ahiWeightHoursAcrossWindow += bucket.ahiWeightHours;
    } else if (bucket.ahiCount > 0) {
      ahiFallbackValues.push(bucket.ahiSum / bucket.ahiCount);
    }
  }
  const avgAhi = summaryAggregationPolicy.averageRateMetricsByUsage
    ? ahiWeightHoursAcrossWindow > 0
      ? ahiWeightedAcrossWindow / ahiWeightHoursAcrossWindow
      : ahiFallbackValues.length > 0
        ? ahiFallbackValues.reduce((a, b) => a + b, 0) / ahiFallbackValues.length
        : null
    : ahiValues.length > 0
      ? ahiValues.reduce((a, b) => a + b, 0) / ahiValues.length
      : null;
  const avgResidualApneas = summaryAggregationPolicy.averageRateMetricsByUsage
    ? weightedUsageRate(residualApneaValues, (bucket) =>
        bucket.residualApneaCount > 0 ? bucket.residualApneaSum / bucket.residualApneaCount : null
      )
    : residualApneaValues.length > 0
      ? residualApneaValues.reduce((a, b) => a + b, 0) / residualApneaValues.length
      : null;
  const avgCentralApneas = summaryAggregationPolicy.averageRateMetricsByUsage
    ? weightedUsageRate(centralApneaValues, (bucket) =>
        bucket.centralApneaCount > 0 ? bucket.centralApneaSum / bucket.centralApneaCount : null
      )
    : centralApneaValues.length > 0
      ? centralApneaValues.reduce((a, b) => a + b, 0) / centralApneaValues.length
      : null;
  const avgReraIndex = summaryAggregationPolicy.averageRateMetricsByUsage
    ? weightedUsageRate(reraValues, (bucket) => (bucket.reraCount > 0 ? bucket.reraSum / bucket.reraCount : null))
    : reraValues.length > 0
      ? reraValues.reduce((a, b) => a + b, 0) / reraValues.length
      : null;
  const ahi95th = ahiValues.length > 0 ? percentile(ahiValues, 95) : null;
  const residualApneas95th = residualApneaValues.length > 0 ? percentile(residualApneaValues, 95) : null;
  const centralApneas95th = centralApneaValues.length > 0 ? percentile(centralApneaValues, 95) : null;
  const rera95th = reraValues.length > 0 ? percentile(reraValues, 95) : null;
  const avgLeak = leakValues.length > 0 ? leakValues.reduce((a, b) => a + b, 0) / leakValues.length : null;
  const leak95th =
    leak95Values.length > 0
      ? leak95Values.reduce((a, b) => a + b, 0) / leak95Values.length
      : leakValues.length > 0
        ? percentile(leakValues, 95)
        : null;
  const rawMaxLeak = leakMaxValues.length > 0 ? Math.max(...leakMaxValues) : leakValues.length > 0 ? Math.max(...leakValues) : null;
  const maxLeak30m = leakMax30mValues.length > 0 ? Math.max(...leakMax30mValues) : rawMaxLeak;
  const maxLeak60m = leakMax60mValues.length > 0 ? Math.max(...leakMax60mValues) : rawMaxLeak;
  const maxLeak = rawMaxLeak;
  const isAutoBiPapReport = isAutoBiPapReportMachine(machine);
  const observedMaxLeakMinutes =
    maxLeak === null
      ? null
      : (maxLeakMinuteCandidates
          .filter((entry) => sameLeakMetricValue(entry.leak, maxLeak))
          .sort((a, b) => b.minutes - a.minutes)[0]?.minutes ?? null);
  const maxLeakWindowMinutes =
    maxLeak !== null && maxLeak60m !== null && leakMax60mValues.length > 0 && sameLeakMetricValue(maxLeak, maxLeak60m)
      ? 60
      : maxLeak !== null && maxLeak30m !== null && leakMax30mValues.length > 0 && sameLeakMetricValue(maxLeak, maxLeak30m)
        ? 30
        : isAutoBiPapReport && maxLeak !== null && maxLeak60m !== null && sameLeakMetricValue(maxLeak, maxLeak60m)
          ? 60
          : isAutoBiPapReport && maxLeak !== null && maxLeak30m !== null && sameLeakMetricValue(maxLeak, maxLeak30m)
            ? 30
            : null;
  const maxLeakMinutes = observedMaxLeakMinutes ?? maxLeakWindowMinutes;
  const maxLeakAtLeastOneMinuteCandidate = [...maxLeakMinuteCandidates, ...sustainedLeakCandidates]
    .filter((entry) => entry.minutes >= MIN_REPORTABLE_MAX_LEAK_MINUTES)
    .sort((a, b) => b.leak - a.leak || b.minutes - a.minutes)[0] ?? null;
  const observedSustainedLeakCandidate =
    sustainedLeakCandidates.sort((a, b) => b.minutes - a.minutes || b.leak - a.leak)[0] ?? null;
  const sustainedLeakWindowCandidate =
    maxLeak60m !== null && leakMax60mValues.length > 0
      ? { leak: maxLeak60m, minutes: 60 }
      : maxLeak30m !== null && leakMax30mValues.length > 0
        ? { leak: maxLeak30m, minutes: 30 }
        : null;
  const sustainedLeakCandidate =
    [observedSustainedLeakCandidate, sustainedLeakWindowCandidate]
      .filter((entry): entry is { leak: number; minutes: number } => entry !== null)
      .sort((a, b) => b.minutes - a.minutes || b.leak - a.leak)[0] ?? null;
  const sustainedLeakMax = sustainedLeakCandidate?.leak ?? null;
  const sustainedLeakMinutes = sustainedLeakCandidate?.minutes ?? null;
  const avgPressure =
    pressureAvgValues.length > 0 ? pressureAvgValues.reduce((a, b) => a + b, 0) / pressureAvgValues.length : null;
  const pressure95th =
    pressure95Values.length > 0
      ? summaryAggregationPolicy.pressure95Aggregation === "daily-summary-mean"
        ? pressure95Values.reduce((a, b) => a + b, 0) / pressure95Values.length
        : percentile(pressure95Values, 95)
      : pressureAvgValues.length > 0
        ? percentile(pressureAvgValues, 95)
        : null;
  const avgIpap = ipapAvgValues.length > 0 ? ipapAvgValues.reduce((a, b) => a + b, 0) / ipapAvgValues.length : null;
  const ipap95th =
    ipap95Values.length > 0
      ? summaryAggregationPolicy.pressure95Aggregation === "daily-summary-mean"
        ? ipap95Values.reduce((a, b) => a + b, 0) / ipap95Values.length
        : percentile(ipap95Values, 95)
      : ipapAvgValues.length > 0
        ? percentile(ipapAvgValues, 95)
        : null;
  const avgEpap = epapAvgValues.length > 0 ? epapAvgValues.reduce((a, b) => a + b, 0) / epapAvgValues.length : null;
  const epap95th =
    epap95Values.length > 0
      ? summaryAggregationPolicy.pressure95Aggregation === "daily-summary-mean"
        ? epap95Values.reduce((a, b) => a + b, 0) / epap95Values.length
        : percentile(epap95Values, 95)
      : epapAvgValues.length > 0
        ? percentile(epapAvgValues, 95)
        : null;
  const avgTidalVolume =
    tidalVolumeValues.length > 0 ? tidalVolumeValues.reduce((a, b) => a + b, 0) / tidalVolumeValues.length : null;
  const minTidalVolume = tidalVolumeMinValues.length > 0 ? Math.min(...tidalVolumeMinValues) : null;
  const medianTidalVolume = histogramPercentile(tidalVolumeBins, 50);
  const maxTidalVolume = tidalVolumeMaxValues.length > 0 ? Math.max(...tidalVolumeMaxValues) : null;
  const minTidalVolumeMinutes = histogramDurationMinutesForValue(tidalVolumeSecondsByBin, minTidalVolume);
  const maxTidalVolumeMinutes = histogramDurationMinutesForValue(tidalVolumeSecondsByBin, maxTidalVolume);
  const avgRespiratoryRate =
    respiratoryRateAvgValues.length > 0 ? respiratoryRateAvgValues.reduce((a, b) => a + b, 0) / respiratoryRateAvgValues.length : null;
  const minRespiratoryRate = respiratoryRateMinValues.length > 0 ? Math.min(...respiratoryRateMinValues) : null;
  const respiratoryRate95th = histogramPercentile(respiratoryRateBins, 95);

  if (usageValues.length === 0) {
    warnings.push("Usage-hour fields were not found in the selected data. Compliance metrics are shown as 0.");
  }
  if (ahiValues.length === 0) {
    warnings.push("AHI metrics were not detected from the selected files.");
  }
  const hasAnyLeakMetric =
    leakValues.length > 0 ||
    leak95Values.length > 0 ||
    leakMaxValues.length > 0 ||
    leakMax30mValues.length > 0 ||
    leakMax60mValues.length > 0 ||
    maxLeakMinuteCandidates.length > 0 ||
    sustainedLeakCandidates.length > 0;

  if (!hasAnyLeakMetric) {
    warnings.push("Leak metrics were not detected from the selected files.");
  }

  if (avgPressure !== null) {
    machine.pressureAvg = finite(avgPressure);
  }
  if (pressure95th !== null) {
    machine.pressure95th = finite(pressure95th);
  }
  if (avgIpap !== null) {
    machine.ipapAvg = finite(avgIpap);
  }
  if (ipap95th !== null) {
    machine.ipap95th = finite(ipap95th);
  }
  if (avgEpap !== null) {
    machine.epapAvg = finite(avgEpap);
  }
  if (epap95th !== null) {
    machine.epap95th = finite(epap95th);
  }
  if (avgTidalVolume !== null) {
    machine.tidalVolumeAvg = finite(avgTidalVolume);
  }
  if (minTidalVolume !== null) {
    machine.tidalVolumeMin = finite(minTidalVolume);
  }
  if (minTidalVolumeMinutes !== null) {
    machine.tidalVolumeMinMinutes = finite(minTidalVolumeMinutes);
  }
  if (medianTidalVolume !== null) {
    machine.tidalVolumeMedian = finite(medianTidalVolume);
  }
  if (maxTidalVolume !== null) {
    machine.tidalVolumeMax = finite(maxTidalVolume);
  }
  if (maxTidalVolumeMinutes !== null) {
    machine.tidalVolumeMaxMinutes = finite(maxTidalVolumeMinutes);
  }
  if (avgRespiratoryRate !== null) {
    machine.respiratoryRateAvg = finite(avgRespiratoryRate);
  }
  if (minRespiratoryRate !== null) {
    machine.respiratoryRateMin = finite(minRespiratoryRate);
  }
  if (respiratoryRate95th !== null) {
    machine.respiratoryRate95th = finite(respiratoryRate95th);
  }
  verifyResolvedTherapyModeOrThrow(machine, prepared.selectedLoader);

  if (machine.device) {
    machine.device = machine.device.replace(/\s*\(\s*sd\s*card\s*\)\s*$/i, "").trim();
  }

  const report: QuickReportMetrics = {
    generatedAtIso: now.toISOString(),
    generatedAtDisplay: now.toLocaleString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }),
    selectedLoader: prepared.selectedLoader,
    sourceTimeZoneOffsetMinutes,
    patientName: patientName.trim(),
    dateOfBirth: formatDateHuman(dateOfBirthIso),
    physicianName: physicianName.trim(),
    dateRangeStart: formatDateHuman(displayedWindowStartIso),
    dateRangeEnd: formatDateHuman(displayedWindowEndIso),
    daysInWindow: effectiveWindowDays,
    daysWithData,
    daysWithUsage,
    usageDaysPercent: finite((daysWithUsage / Math.max(1, effectiveWindowDays)) * 100),
    compliantDays,
    compliancePercent: finite((compliantDays / complianceBaseDays) * 100),
    avgUsageHours: avgUsageHours === null ? null : finite(avgUsageHours),
    totalTherapyHours: finite(totalTherapyHours),
    expectedSleepTherapyHours:
      expectedSleepTherapyHours === null ? null : finite(expectedSleepTherapyHours),
    suspectedNapTherapyHours:
      suspectedNapTherapyHours === null ? null : finite(suspectedNapTherapyHours),
    unclassifiedTherapyHours:
      unclassifiedTherapyHours === null ? null : finite(unclassifiedTherapyHours),
    avgExpectedSleepTherapyHours:
      avgExpectedSleepTherapyHours === null ? null : finite(avgExpectedSleepTherapyHours),
    avgSuspectedNapTherapyHours:
      avgSuspectedNapTherapyHours === null ? null : finite(avgSuspectedNapTherapyHours),
    sleepTimingAnalysis,
    avgAhi: avgAhi === null ? null : finite(avgAhi),
    avgResidualApneas: avgResidualApneas === null ? null : finite(avgResidualApneas),
    avgCentralApneas: avgCentralApneas === null ? null : finite(avgCentralApneas),
    avgReraIndex: avgReraIndex === null ? null : finite(avgReraIndex),
    ahi95th: ahi95th === null ? null : finite(ahi95th),
    residualApneas95th: residualApneas95th === null ? null : finite(residualApneas95th),
    centralApneas95th: centralApneas95th === null ? null : finite(centralApneas95th),
    rera95th: rera95th === null ? null : finite(rera95th),
    avgLeak: avgLeak === null ? null : finite(avgLeak),
    leak95th: leak95th === null ? null : finite(leak95th),
    maxLeak: maxLeak === null ? null : finite(maxLeak),
    maxLeak30m: maxLeak30m === null ? null : finite(maxLeak30m),
    maxLeak60m: maxLeak60m === null ? null : finite(maxLeak60m),
    maxLeakMinutes: maxLeakMinutes === null ? null : finite(maxLeakMinutes),
    maxLeakAtLeastOneMinute:
      maxLeakAtLeastOneMinuteCandidate === null ? null : finite(maxLeakAtLeastOneMinuteCandidate.leak),
    maxLeakAtLeastOneMinuteMinutes:
      maxLeakAtLeastOneMinuteCandidate === null ? null : finite(maxLeakAtLeastOneMinuteCandidate.minutes),
    sustainedLeakMax: sustainedLeakMax === null ? null : finite(sustainedLeakMax),
    sustainedLeakMinutes: sustainedLeakMinutes === null ? null : finite(sustainedLeakMinutes),
    machine,
    warnings
  };

  if (!report.machine.device) {
    report.machine.device = "Not detected from input files";
    warnings.push("Machine device/model could not be confidently detected from uploaded files.");
  }

  emit(onProgress, { phase: "finalize", detail: "Finalizing report...", percent: 96 });
  emit(onProgress, { phase: "done", detail: "Report ready.", percent: 100 });

  return report;
}

export async function buildQuickReportMetrics(request: ParseRequest): Promise<QuickReportMetrics> {
  const prepared = await prepareQuickReportSourceInternal({
    sourceKind: request.sourceKind,
    files: request.files,
    lookbackDays: request.lookbackDays,
    onProgress: request.onProgress
  });

  return buildQuickReportMetricsFromPreparedSource(prepared, {
    patientName: request.patientName,
    dateOfBirthIso: request.dateOfBirthIso,
    physicianName: request.physicianName,
    lookbackDays: request.lookbackDays,
    onProgress: request.onProgress
  });
}
