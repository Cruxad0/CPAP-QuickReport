import { buildQuickReportMetricsFromPreparedSource } from "@/lib/parser";
import { buildPdfReport } from "@/lib/pdf";
import type {
  GeneratedPdfArtifact,
  ParseProgress,
  PreparedQuickReportSource,
  QuickReportMetrics
} from "@/lib/types";

export const REPORT_RANGE_OPTIONS = [90, 60, 30, 7] as const;

export type ReportRangeDays = (typeof REPORT_RANGE_OPTIONS)[number];

export interface BuildReportArtifactsRequest {
  prepared: PreparedQuickReportSource;
  patientName: string;
  dateOfBirthIso: string;
  physicianName: string;
  headerDataUrl?: string;
  reportRanges?: readonly ReportRangeDays[];
  onProgress?: (progress: ParseProgress) => void;
}

export interface BuildReportArtifactsResult {
  reports: GeneratedPdfArtifact[];
  largestAvailableRange: ReportRangeDays | null;
}

function emit(onProgress: BuildReportArtifactsRequest["onProgress"], progress: ParseProgress) {
  if (onProgress) onProgress(progress);
}

function addIsoDays(isoDay: string, days: number): string {
  const date = new Date(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Prepared therapy history could not determine a valid latest clinical day.");
  }

  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function buildReportArtifactsFromPreparedSource(
  request: BuildReportArtifactsRequest
): Promise<BuildReportArtifactsResult> {
  const {
    prepared,
    patientName,
    dateOfBirthIso,
    physicianName,
    headerDataUrl,
    onProgress,
    reportRanges = REPORT_RANGE_OPTIONS
  } = request;

  const reports: GeneratedPdfArtifact[] = [];
  const totalRanges = reportRanges.length;
  const reportWindowEndClinicalDayIso = addIsoDays(prepared.latestClinicalDayIso, 1);
  const smallestRequestedRange = reportRanges.length > 0 ? Math.min(...reportRanges) : null;

  for (let idx = 0; idx < totalRanges; idx += 1) {
    const days = reportRanges[idx];
    const segmentStart = Math.round((idx / totalRanges) * 96);
    const segmentSpan = Math.max(1, Math.round(96 / totalRanges));

    emit(onProgress, {
      phase: "start",
      detail: `Generating ${days}-day report (${idx + 1}/${totalRanges})...`,
      percent: Math.max(2, segmentStart)
    });

    const metrics: QuickReportMetrics = buildQuickReportMetricsFromPreparedSource(prepared, {
      patientName,
      dateOfBirthIso,
      physicianName,
      lookbackDays: days,
      windowEndClinicalDayIso: reportWindowEndClinicalDayIso,
      onProgress: (progress) =>
        emit(onProgress, {
          phase: progress.phase,
          detail: `${days}-day: ${progress.detail}`,
          percent: Math.min(98, segmentStart + Math.round((Math.max(0, Math.min(100, progress.percent)) / 100) * segmentSpan))
        })
    });

    if (metrics.daysInWindow < days && days !== smallestRequestedRange) {
      emit(onProgress, {
        phase: "start",
        detail: `Skipping ${days}-day tab (only ${metrics.daysInWindow} days available)...`,
        percent: Math.min(98, segmentStart + segmentSpan - 1)
      });
      continue;
    }

    emit(onProgress, {
      phase: "pdf",
      detail: `Rendering ${days}-day PDF...`,
      percent: Math.min(98, segmentStart + segmentSpan - 1)
    });

    const { blob, filename } = await buildPdfReport(metrics, headerDataUrl);
    reports.push({
      days,
      metrics,
      blob,
      filename
    });
  }

  return {
    reports,
    largestAvailableRange: (reports[0]?.days as ReportRangeDays | undefined) ?? null
  };
}
