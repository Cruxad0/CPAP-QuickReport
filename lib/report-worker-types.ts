import type { FolderSourceEntry } from "@/lib/source-files";
import type { DataSourceKind, GeneratedPdfArtifact, ParseProgress, SourceFileSummary } from "@/lib/types";

export type SourceSelectionKind = "folder" | "zip";

export type ReportWorkerRequest =
  | {
      requestId: number;
      type: "load-folder-start";
      importLookbackDays: number;
      parseLookbackDays: number;
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
      latestClinicalDayIso: string;
    }
  | {
      requestId: number;
      type: "reports-ready";
      reports: GeneratedPdfArtifact[];
      statusMessage: string;
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
