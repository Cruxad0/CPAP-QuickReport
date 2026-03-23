import { filterFolderEntriesToRecentWindow, type FolderSourceEntry } from "@/lib/source-files";
import type { ReportWorkerRequest, ReportWorkerResponse } from "@/lib/report-worker-types";
import type { GeneratedPdfArtifact, ParseProgress, SourceFileSummary } from "@/lib/types";

type LoadSourceResult = {
  sourceKind: "folder" | "zip";
  files: SourceFileSummary[];
  totalFileCount: number;
  totalBytes: number;
  statusMessage: string;
  selectedLoader: string;
};

type GenerateReportsResult = {
  reports: GeneratedPdfArtifact[];
  statusMessage: string;
};

type PendingRequest =
  | {
      type: "load-folder" | "load-zip";
      onProgress?: (progress: ParseProgress) => void;
      resolve: (value: LoadSourceResult) => void;
      reject: (reason?: unknown) => void;
    }
  | {
      type: "generate-reports";
      onProgress?: (progress: ParseProgress) => void;
      resolve: (value: GenerateReportsResult) => void;
      reject: (reason?: unknown) => void;
    }
  | {
      type: "reset";
      resolve: () => void;
      reject: (reason?: unknown) => void;
    };

export class ReportWorkerClient {
  private static readonly FOLDER_ENTRY_SCAN_CHUNK_SIZE = 256;
  private static readonly FOLDER_TRANSFER_CHUNK_SIZE = 24;
  private static readonly FOLDER_TRANSFER_YIELD_EVERY = 1;
  private static readonly FOLDER_TRANSFER_PROGRESS_EVERY = 4;
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;

  constructor() {
    this.worker = new Worker(new URL("../workers/report.worker.ts", import.meta.url), {
      type: "module"
    });
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleError);
  }

  dispose() {
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleError);
    this.worker.terminate();
    this.pending.clear();
  }

  async loadFolder(
    files: FileList | readonly File[],
    options: { importLookbackDays: number; parseLookbackDays: number; onProgress?: (progress: ParseProgress) => void }
  ): Promise<LoadSourceResult> {
    const requestId = this.nextRequestId++;
    const promise = new Promise<LoadSourceResult>((resolve, reject) => {
      this.pending.set(requestId, {
        type: "load-folder",
        onProgress: options.onProgress,
        resolve,
        reject
      });
    });

    void this.postFolderLoadInChunks(requestId, files, options).catch((error) => {
      const pending = this.pending.get(requestId);
      if (!pending || pending.type !== "load-folder") return;
      this.pending.delete(requestId);
      pending.reject(error instanceof Error ? error : new Error("Folder transfer to worker failed."));
    });

    return await promise;
  }

  private async postFolderLoadInChunks(
    requestId: number,
    files: FileList | readonly File[],
    options: { importLookbackDays: number; parseLookbackDays: number; onProgress?: (progress: ParseProgress) => void }
  ) {
    const recentEntries = await this.buildRecentFolderEntries(files, options);

    const startRequest: ReportWorkerRequest = {
      requestId,
      type: "load-folder-start",
      importLookbackDays: options.importLookbackDays,
      parseLookbackDays: options.parseLookbackDays
    };
    this.worker.postMessage(startRequest);

    const total = recentEntries.length;
    let chunkCount = 0;
    for (let start = 0; start < total; start += ReportWorkerClient.FOLDER_TRANSFER_CHUNK_SIZE) {
      const end = Math.min(start + ReportWorkerClient.FOLDER_TRANSFER_CHUNK_SIZE, total);
      const chunk = recentEntries.slice(start, end);

      const chunkRequest: ReportWorkerRequest = {
        requestId,
        type: "load-folder-chunk",
        files: chunk
      };
      this.worker.postMessage(chunkRequest);
      chunkCount += 1;

      if (options.onProgress && (chunkCount % ReportWorkerClient.FOLDER_TRANSFER_PROGRESS_EVERY === 0 || end === total)) {
        options.onProgress({
          phase: "scan",
          detail: `Sending SD-CARD files... ${end}/${total}`,
          percent: Math.min(4, Math.max(2, Math.round((end / Math.max(1, total)) * 4)))
        });
      }

      if (chunkCount % ReportWorkerClient.FOLDER_TRANSFER_YIELD_EVERY === 0) {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
    }

    const finishRequest: ReportWorkerRequest = {
      requestId,
      type: "load-folder-finish"
    };
    this.worker.postMessage(finishRequest);
  }

  private async buildRecentFolderEntries(
    files: FileList | readonly File[],
    options: { importLookbackDays: number; onProgress?: (progress: ParseProgress) => void }
  ): Promise<FolderSourceEntry[]> {
    const total = files.length ?? 0;
    const entries: FolderSourceEntry[] = [];

    for (let start = 0; start < total; start += ReportWorkerClient.FOLDER_ENTRY_SCAN_CHUNK_SIZE) {
      const end = Math.min(start + ReportWorkerClient.FOLDER_ENTRY_SCAN_CHUNK_SIZE, total);
      for (let i = start; i < end; i += 1) {
        const file = files[i];
        if (!file) continue;
        entries.push({
          file,
          relativePath: file.webkitRelativePath || file.name
        });
      }

      if (options.onProgress && (end === total || end % (ReportWorkerClient.FOLDER_ENTRY_SCAN_CHUNK_SIZE * 4) === 0)) {
        options.onProgress({
          phase: "scan",
          detail: `Scanning SD-CARD structure... ${end}/${total}`,
          percent: Math.min(2, Math.max(1, Math.round((end / Math.max(1, total)) * 2)))
        });
      }

      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    }

    const filtered = filterFolderEntriesToRecentWindow(entries, options.importLookbackDays);

    if (options.onProgress) {
      options.onProgress({
        phase: "scan",
        detail:
          filtered.filteredOutCount > 0
            ? `Keeping recent ${options.importLookbackDays}-day files... ${filtered.entries.length}/${filtered.originalCount}`
            : `Preparing recent SD-CARD files... ${filtered.entries.length}`,
        percent: 2
      });
    }

    return filtered.entries;
  }

  async loadZip(
    zipFile: File,
    options: { importLookbackDays: number; parseLookbackDays: number; onProgress?: (progress: ParseProgress) => void }
  ): Promise<LoadSourceResult> {
    const requestId = this.nextRequestId++;
    return await new Promise<LoadSourceResult>((resolve, reject) => {
      this.pending.set(requestId, {
        type: "load-zip",
        onProgress: options.onProgress,
        resolve,
        reject
      });
      const request: ReportWorkerRequest = {
        requestId,
        type: "load-zip",
        zipFile,
        importLookbackDays: options.importLookbackDays,
        parseLookbackDays: options.parseLookbackDays
      };
      this.worker.postMessage(request);
    });
  }

  async generateReports(
    params: {
      patientName: string;
      dateOfBirthIso: string;
      physicianName: string;
      headerDataUrl?: string;
    },
    onProgress?: (progress: ParseProgress) => void
  ): Promise<GenerateReportsResult> {
    const requestId = this.nextRequestId++;
    return await new Promise<GenerateReportsResult>((resolve, reject) => {
      this.pending.set(requestId, {
        type: "generate-reports",
        onProgress,
        resolve,
        reject
      });
      const request: ReportWorkerRequest = {
        requestId,
        type: "generate-reports",
        patientName: params.patientName,
        dateOfBirthIso: params.dateOfBirthIso,
        physicianName: params.physicianName,
        headerDataUrl: params.headerDataUrl
      };
      this.worker.postMessage(request);
    });
  }

  async reset(): Promise<void> {
    const requestId = this.nextRequestId++;
    return await new Promise<void>((resolve, reject) => {
      this.pending.set(requestId, {
        type: "reset",
        resolve,
        reject
      });
      const request: ReportWorkerRequest = {
        requestId,
        type: "reset"
      };
      this.worker.postMessage(request);
    });
  }

  private readonly handleMessage = (event: MessageEvent<ReportWorkerResponse>) => {
    const message = event.data;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;

    if (message.type === "progress") {
      if ("onProgress" in pending && pending.onProgress) pending.onProgress(message.progress);
      return;
    }

    if (message.type === "source-ready" && (pending.type === "load-folder" || pending.type === "load-zip")) {
      this.pending.delete(message.requestId);
      pending.resolve({
        sourceKind: message.sourceKind,
        files: message.files,
        totalFileCount: message.totalFileCount,
        totalBytes: message.totalBytes,
        statusMessage: message.statusMessage,
        selectedLoader: message.selectedLoader
      });
      return;
    }

    if (message.type === "reports-ready" && pending.type === "generate-reports") {
      this.pending.delete(message.requestId);
      pending.resolve({
        reports: message.reports,
        statusMessage: message.statusMessage
      });
      return;
    }

    if (message.type === "reset-done" && pending.type === "reset") {
      this.pending.delete(message.requestId);
      pending.resolve();
      return;
    }

    if (message.type === "error") {
      this.pending.delete(message.requestId);
      pending.reject(new Error(message.message));
    }
  };

  private readonly handleError = (event: ErrorEvent) => {
    const error = new Error(event.message || "Worker execution failed.");
    for (const [requestId, pending] of this.pending.entries()) {
      this.pending.delete(requestId);
      pending.reject(error);
    }
  };
}
