import {
  filterFolderEntriesToRecentWindow,
  type DeferredFolderSourceEntry,
  type FolderSourceEntry,
  type FolderSourceMetaEntry
} from "@/lib/source-files";
import type { ReportWorkerRequest, ReportWorkerResponse } from "@/lib/report-worker-types";
import type { GeneratedPdfArtifact, ParseProgress, QuickReportMetrics, SourceFileSummary, TherapySettingsPeriod } from "@/lib/types";

type LoadSourceResult = {
  sourceKind: "folder" | "zip";
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
      type: "review-previous-therapy";
      onProgress?: (progress: ParseProgress) => void;
      resolve: (value: QuickReportMetrics) => void;
      reject: (reason?: unknown) => void;
    }
  | {
      type: "reset";
      resolve: () => void;
      reject: (reason?: unknown) => void;
    };

export class ReportWorkerClient {
  private static readonly FILE_LIST_SCAN_CHUNK_SIZE = 512;
  private static readonly FOLDER_ENTRY_SCAN_CHUNK_SIZE = 32;
  private static readonly FOLDER_TRANSFER_CHUNK_SIZE = 12;
  private static readonly FOLDER_TRANSFER_YIELD_EVERY = 1;
  private static readonly FOLDER_TRANSFER_PROGRESS_EVERY = 6;
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
    const recent = await this.buildRecentFileListEntries(files, options);
    return await this.loadFolderEntriesInternal(recent.entries, { ...options, hasOlderDatedData: recent.hasOlderDatedData }, true);
  }

  async loadFolderEntries(
    entries: readonly DeferredFolderSourceEntry[],
    options: {
      importLookbackDays: number;
      parseLookbackDays: number;
      hasOlderDatedData?: boolean;
      onProgress?: (progress: ParseProgress) => void;
    }
  ): Promise<LoadSourceResult> {
    return await this.loadFolderEntriesInternal(entries, options, false);
  }

  private async loadFolderEntriesInternal(
    entries: readonly DeferredFolderSourceEntry[],
    options: {
      importLookbackDays: number;
      parseLookbackDays: number;
      hasOlderDatedData?: boolean;
      onProgress?: (progress: ParseProgress) => void;
    },
    entriesAlreadyFiltered: boolean
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

    void this.postFolderLoadInChunks(requestId, entries, options, entriesAlreadyFiltered).catch((error) => {
      const pending = this.pending.get(requestId);
      if (!pending || pending.type !== "load-folder") return;
      this.pending.delete(requestId);
      pending.reject(error instanceof Error ? error : new Error("Folder transfer to worker failed."));
    });

    return await promise;
  }

  async loadFolderHandle(
    rootHandle: FileSystemDirectoryHandle,
    options: { importLookbackDays: number; parseLookbackDays: number; onProgress?: (progress: ParseProgress) => void }
  ): Promise<LoadSourceResult> {
    if (!this.canTransferDirectoryHandle(rootHandle)) {
      throw new Error("Directory handle transfer is not supported in this browser.");
    }

    const requestId = this.nextRequestId++;
    return await new Promise<LoadSourceResult>((resolve, reject) => {
      this.pending.set(requestId, {
        type: "load-folder",
        onProgress: options.onProgress,
        resolve,
        reject
      });

      const request: ReportWorkerRequest = {
        requestId,
        type: "load-folder-handle",
        rootHandle,
        importLookbackDays: options.importLookbackDays,
        parseLookbackDays: options.parseLookbackDays
      };

      try {
        this.worker.postMessage(request);
      } catch (error) {
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error("Directory handle transfer to worker failed."));
      }
    });
  }

  private async postFolderLoadInChunks(
    requestId: number,
    entries: readonly DeferredFolderSourceEntry[],
    options: {
      importLookbackDays: number;
      parseLookbackDays: number;
      hasOlderDatedData?: boolean;
      onProgress?: (progress: ParseProgress) => void;
    },
    entriesAlreadyFiltered = false
  ) {
    const recentEntries = entriesAlreadyFiltered ? entries : await this.buildRecentFolderEntries(entries, options);
    const transferableEntries = this.canTransferFolderEntries(recentEntries)
      ? recentEntries
      : await this.materializeFolderEntries(recentEntries, options.onProgress);

    const startRequest: ReportWorkerRequest = {
      requestId,
      type: "load-folder-start",
      importLookbackDays: options.importLookbackDays,
      parseLookbackDays: options.parseLookbackDays,
      hasOlderDatedData: options.hasOlderDatedData
    };
    this.worker.postMessage(startRequest);

    const total = transferableEntries.length;
    let chunkCount = 0;
    for (let start = 0; start < total; start += ReportWorkerClient.FOLDER_TRANSFER_CHUNK_SIZE) {
      const end = Math.min(start + ReportWorkerClient.FOLDER_TRANSFER_CHUNK_SIZE, total);
      const chunk = transferableEntries.slice(start, end);

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
        await this.yieldToBrowser();
      }
    }

    const finishRequest: ReportWorkerRequest = {
      requestId,
      type: "load-folder-finish"
    };
    this.worker.postMessage(finishRequest);
  }

  private async buildRecentFileListEntries(
    files: FileList | readonly File[],
    options: { importLookbackDays: number; onProgress?: (progress: ParseProgress) => void }
  ): Promise<{ entries: DeferredFolderSourceEntry[]; hasOlderDatedData: boolean }> {
    const metadataEntries: FolderSourceMetaEntry[] = [];

    for (let start = 0; start < files.length; start += ReportWorkerClient.FILE_LIST_SCAN_CHUNK_SIZE) {
      const end = Math.min(start + ReportWorkerClient.FILE_LIST_SCAN_CHUNK_SIZE, files.length);
      for (let i = start; i < end; i += 1) {
        const file = files[i];
        if (!file) continue;
        metadataEntries.push({
          index: i,
          name: file.name,
          size: file.size,
          relativePath: file.webkitRelativePath || file.name
        });
      }

      if (options.onProgress) {
        options.onProgress({
          phase: "scan",
          detail: `Inspecting browser file list before recent-day filter... ${end}/${files.length}`,
          percent: Math.min(2, Math.max(1, Math.round((end / Math.max(1, files.length)) * 2)))
        });
      }

      await this.yieldToBrowser();
    }

    const filtered = filterFolderEntriesToRecentWindow(metadataEntries, options.importLookbackDays);
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

    return {
      entries: filtered.entries
        .map<DeferredFolderSourceEntry | null>((entry) => {
        const file = files[entry.index];
        if (!file) return null;
        return {
          kind: "file",
          name: file.name,
          size: file.size,
          relativePath: file.webkitRelativePath || file.name,
          file
        } satisfies DeferredFolderSourceEntry;
      })
        .filter((entry): entry is DeferredFolderSourceEntry => Boolean(entry)),
      hasOlderDatedData: filtered.hasOlderDatedData
    };
  }

  private async buildRecentFolderEntries(
    entries: readonly DeferredFolderSourceEntry[],
    options: { importLookbackDays: number; onProgress?: (progress: ParseProgress) => void }
  ): Promise<DeferredFolderSourceEntry[]> {
    const metadataEntries: FolderSourceMetaEntry[] = [];

    for (let start = 0; start < entries.length; start += ReportWorkerClient.FOLDER_ENTRY_SCAN_CHUNK_SIZE) {
      const end = Math.min(start + ReportWorkerClient.FOLDER_ENTRY_SCAN_CHUNK_SIZE, entries.length);
      for (let i = start; i < end; i += 1) {
        const file = entries[i];
        if (!file) continue;
        metadataEntries.push({
          index: i,
          name: file.name,
          size: file.size,
          relativePath: file.relativePath
        });
      }

      if (
        options.onProgress &&
        (end === entries.length || end % (ReportWorkerClient.FOLDER_ENTRY_SCAN_CHUNK_SIZE * 4) === 0)
      ) {
        options.onProgress({
          phase: "scan",
          detail: `Scanning SD-CARD structure... ${end}/${entries.length}`,
          percent: Math.min(2, Math.max(1, Math.round((end / Math.max(1, entries.length)) * 2)))
        });
      }

      await this.yieldToBrowser();
    }

    const filtered = filterFolderEntriesToRecentWindow(metadataEntries, options.importLookbackDays);

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

    return filtered.entries
      .map((entry) => entries[entry.index])
      .filter((entry): entry is DeferredFolderSourceEntry => Boolean(entry));
  }

  private canTransferFolderEntries(entries: readonly DeferredFolderSourceEntry[]) {
    const firstHandleEntry = entries.find((entry) => entry.kind === "handle");
    if (!firstHandleEntry) return true;
    if (typeof structuredClone !== "function") return false;

    try {
      structuredClone(firstHandleEntry);
      return true;
    } catch {
      return false;
    }
  }

  private canTransferDirectoryHandle(rootHandle: FileSystemDirectoryHandle) {
    if (typeof structuredClone !== "function") return false;
    try {
      structuredClone(rootHandle);
      return true;
    } catch {
      return false;
    }
  }

  private async materializeFolderEntries(
    entries: readonly DeferredFolderSourceEntry[],
    onProgress?: (progress: ParseProgress) => void
  ): Promise<FolderSourceEntry[]> {
    const folderEntries: FolderSourceEntry[] = [];
    for (let start = 0; start < entries.length; start += ReportWorkerClient.FOLDER_TRANSFER_CHUNK_SIZE) {
      const end = Math.min(start + ReportWorkerClient.FOLDER_TRANSFER_CHUNK_SIZE, entries.length);
      for (let i = start; i < end; i += 1) {
        const entry = entries[i];
        if (!entry) continue;
        if (entry.kind === "file") {
          folderEntries.push(entry);
          continue;
        }
        folderEntries.push({
          file: await entry.handle.getFile(),
          relativePath: entry.relativePath
        });
      }
      if (onProgress) {
        onProgress({
          phase: "scan",
          detail: `Preparing recent SD-CARD files... ${end}/${entries.length}`,
          percent: Math.min(3, entries.length === 0 ? 3 : 2 + Math.round(end / entries.length))
        });
      }
      await this.yieldToBrowser();
    }
    return folderEntries;
  }

  private async yieldToBrowser(): Promise<void> {
    if (typeof window.requestIdleCallback === "function") {
      await new Promise<void>((resolve) => {
        window.requestIdleCallback(
          () => resolve(),
          { timeout: 40 }
        );
      });
      return;
    }

    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
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

  async reviewPreviousTherapy(
    params: {
      patientName: string;
      dateOfBirthIso: string;
      physicianName: string;
    },
    onProgress?: (progress: ParseProgress) => void
  ): Promise<QuickReportMetrics> {
    const requestId = this.nextRequestId++;
    return await new Promise<QuickReportMetrics>((resolve, reject) => {
      this.pending.set(requestId, {
        type: "review-previous-therapy",
        onProgress,
        resolve,
        reject
      });
      const request: ReportWorkerRequest = {
        requestId,
        type: "review-previous-therapy",
        patientName: params.patientName,
        dateOfBirthIso: params.dateOfBirthIso,
        physicianName: params.physicianName
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
        selectedLoader: message.selectedLoader,
        sourceDeviceIdentity: message.sourceDeviceIdentity,
        latestClinicalDayIso: message.latestClinicalDayIso,
        warnings: message.warnings,
        hasOlderDatedData: message.hasOlderDatedData,
        therapySettingsPeriods: message.therapySettingsPeriods
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

    if (message.type === "previous-review-ready" && pending.type === "review-previous-therapy") {
      this.pending.delete(message.requestId);
      pending.resolve(message.metrics);
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
