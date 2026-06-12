import type { FolderSourceEntry } from "@/lib/source-files";
import type {
  DataSourceKind,
  GeneratedPdfArtifact,
  ParseProgress,
  QuickReportMetrics,
  SourceFileSummary,
  TherapySettingsPeriod
} from "@/lib/types";

export type SourceSelectionKind = "folder" | "zip";

export type ReportWorkerRequest =
  | {
      requestId: number;
      type: "load-folder-start";
      importLookbackDays: number;
      parseLookbackDays: number;
      hasOlderDatedData?: boolean;
    }
  | {
      requestId: number;
      type: "load-folder-handle";
      rootHandle: FileSystemDirectoryHandle;
      importLookbackDays: number;
      parseLookbackDays: number;
    }
  | {
      requestId: number;
      type: "load-folder-chunk";
      files: FolderSourceEntry[];
    }
  | {
      requestId: number;
      type: "load-folder-finish";
    }
  | {
      requestId: number;
      type: "load-zip";
      zipFile: File;
      importLookbackDays: number;
      parseLookbackDays: number;
    }
  | {
      requestId: number;
      type: "generate-reports";
      patientName: string;
      dateOfBirthIso: string;
      physicianName: string;
      headerDataUrl?: string;
    }
  | {
      requestId: number;
      type: "review-previous-therapy";
      patientName: string;
      dateOfBirthIso: string;
      physicianName: string;
    }
  | {
      requestId: number;
      type: "reset";
    };

export type ReportWorkerResponse =
  | {
      requestId: number;
      type: "progress";
      progress: ParseProgress;
    }
  | {
      requestId: number;
      type: "source-ready";
      sourceKind: DataSourceKind;
      files: SourceFileSummary[];
      totalFileCount: number;
      totalBytes: number;
      statusMessage: string;
      selectedLoader: string;
      sourceDeviceIdentity?: string;
      latestClinicalDayIso: string;
      warnings: string[];
      hasOlderDatedData: boolean;
      therapySettingsPeriods: TherapySettingsPeriod[];
    }
  | {
      requestId: number;
      type: "reports-ready";
      reports: GeneratedPdfArtifact[];
      statusMessage: string;
    }
  | {
      requestId: number;
      type: "previous-review-ready";
      metrics: QuickReportMetrics;
    }
  | {
      requestId: number;
      type: "reset-done";
    }
  | {
      requestId: number;
      type: "error";
      message: string;
    };
