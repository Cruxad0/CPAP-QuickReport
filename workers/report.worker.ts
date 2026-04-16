/// <reference lib="webworker" />

import { prepareQuickReportSource } from "@/lib/parser";
import { buildReportArtifactsFromPreparedSource } from "@/lib/report-orchestrator";
import {
  bytesToLabel,
  createCachedSourceFilesFromFolder,
  createCachedSourceFilesFromZip,
  createSourceFileSummary,
  filterFolderEntriesToRecentWindow,
  filterSourceFilesToRecentWindow,
  shouldIgnorePathEarly
} from "@/lib/source-files";
import type { ReportWorkerRequest, ReportWorkerResponse } from "@/lib/report-worker-types";
import type { DataSourceKind, PreparedQuickReportSource } from "@/lib/types";
import type { DeferredFolderSourceEntry, FolderSourceEntry } from "@/lib/source-files";

declare const self: DedicatedWorkerGlobalScope;

type WorkerDirectoryHandle = FileSystemDirectoryHandle & {
  values: () => AsyncIterable<FileSystemHandle>;
};

let preparedSource: PreparedQuickReportSource | null = null;
let loadedSourceKind: DataSourceKind | null = null;
let loadedSourceSummaries: Array<ReturnType<typeof createSourceFileSummary>> = [];
const folderLoadState = new Map<number, { files: FolderSourceEntry[]; importLookbackDays: number; parseLookbackDays: number }>();
const WORKER_DIRECTORY_ENUMERATION_BATCH_SIZE = 64;

function postMessageSafe(message: ReportWorkerResponse) {
  self.postMessage(message);
}

function emitProgress(requestId: number, phase: string, detail: string, percent: number) {
  postMessageSafe({
    requestId,
    type: "progress",
    progress: {
      phase,
      detail,
      percent
    }
  });
}

function formatIsoAsUsDate(iso: string): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  return dt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC"
  });
}

async function yieldInWorker(): Promise<void> {
  await new Promise<void>((resolve) => self.setTimeout(resolve, 0));
}

async function enumerateFolderHandle(
  requestId: number,
  rootHandle: WorkerDirectoryHandle,
  _lookbackDays: number
): Promise<DeferredFolderSourceEntry[]> {
  const deferredEntries: DeferredFolderSourceEntry[] = [];
  const stack: Array<{ handle: WorkerDirectoryHandle; prefix: string }> = [{ handle: rootHandle, prefix: "" }];
  let discovered = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    for await (const childHandle of current.handle.values()) {
      const childPath = current.prefix ? `${current.prefix}/${childHandle.name}` : childHandle.name;
      if (shouldIgnorePathEarly(childPath)) continue;

      if (childHandle.kind === "directory") {
        stack.push({
          handle: childHandle as WorkerDirectoryHandle,
          prefix: childPath
        });
      } else {
        deferredEntries.push({
          kind: "handle",
          name: childHandle.name,
          size: 0,
          relativePath: childPath,
          handle: childHandle as FileSystemFileHandle
        });
      }

      discovered += 1;
      if (discovered % WORKER_DIRECTORY_ENUMERATION_BATCH_SIZE === 0) {
        emitProgress(requestId, "scan", `Scanning SD-CARD structure... ${deferredEntries.length} files found`, 1);
        await yieldInWorker();
      }
    }

    await yieldInWorker();
  }

  emitProgress(requestId, "scan", `Scanning SD-CARD structure... ${deferredEntries.length} files found`, 1);
  return deferredEntries;
}

async function loadFolderFromDirectoryHandle(
  requestId: number,
  rootHandle: WorkerDirectoryHandle,
  importLookbackDays: number,
  parseLookbackDays: number
) {
  emitProgress(requestId, "scan", "Loading SD-CARD...", 1);
  const deferredEntries = await enumerateFolderHandle(requestId, rootHandle, importLookbackDays);

  if (deferredEntries.length === 0) {
    throw new Error("Directory picker returned no files. Try selecting the SD-card root folder.");
  }

  emitProgress(requestId, "scan", `Keeping recent ${importLookbackDays}-day files...`, 2);
  const filteredEntries = filterFolderEntriesToRecentWindow(deferredEntries, importLookbackDays);

  await loadSource(
    requestId,
    "folder",
    async () =>
      await createCachedSourceFilesFromFolder(filteredEntries.entries, (progress) => emitProgress(requestId, progress.phase, progress.detail, progress.percent)),
    importLookbackDays,
    parseLookbackDays
  );
}

async function loadSource(
  requestId: number,
  sourceKind: DataSourceKind,
  loader: () => Promise<import("@/lib/types").SourceFile[]>,
  importLookbackDays: number,
  parseLookbackDays: number
) {
  emitProgress(requestId, sourceKind === "folder" ? "scan" : "zip", sourceKind === "folder" ? "Loading SD folder..." : "Opening ZIP file...", 4);
  const mapped = await loader();

  emitProgress(requestId, sourceKind === "folder" ? "scan" : "zip", `Keeping recent ${importLookbackDays}-day window...`, 50);
  const filtered = filterSourceFilesToRecentWindow(mapped, importLookbackDays);

  emitProgress(requestId, "parse", "Preparing parsed therapy dataset...", 54);
  const prepared = await prepareQuickReportSource({
    sourceKind,
    files: filtered.files,
    lookbackDays: parseLookbackDays,
    onProgress: (progress) => {
      const mappedPercent = Math.min(96, 54 + Math.round((Math.max(0, Math.min(100, progress.percent)) / 100) * 42));
      emitProgress(requestId, progress.phase, progress.detail, mappedPercent);
    }
  });

  preparedSource = prepared;
  loadedSourceKind = sourceKind;
  const totalFileCount = filtered.files.length;
  const totalBytes = filtered.files.reduce((sum, file) => sum + file.size, 0);
  loadedSourceSummaries = filtered.files.slice(0, 25).map(createSourceFileSummary);

  let statusMessage = "";
  if (filtered.hadDatedFiles) {
    const latestDateText = filtered.latestDateIso ? formatIsoAsUsDate(filtered.latestDateIso) : "unknown";
    if (filtered.filteredOutCount > 0) {
      statusMessage = `${sourceKind === "folder" ? "Folder" : "ZIP"} loaded: ${filtered.files.length} files ready (recent ${importLookbackDays}-day import window; latest dated file ${latestDateText}). Filtered out ${filtered.filteredOutCount} older files (${bytesToLabel(filtered.filteredOutBytes)}).`;
    } else {
      statusMessage = `${sourceKind === "folder" ? "Folder" : "ZIP"} loaded: ${filtered.files.length} files ready (latest dated file ${latestDateText}).`;
    }
  } else {
    statusMessage = `${sourceKind === "folder" ? "Folder" : "ZIP"} loaded: ${mapped.length} files ready for parsing.`;
  }

  emitProgress(requestId, "ready", sourceKind === "folder" ? "Folder ready" : "ZIP ready", 100);
  postMessageSafe({
    requestId,
    type: "source-ready",
    sourceKind,
    files: loadedSourceSummaries,
    totalFileCount,
    totalBytes,
    statusMessage,
    selectedLoader: prepared.selectedLoader,
    latestClinicalDayIso: prepared.latestClinicalDayIso
  });
}

self.onmessage = async (event: MessageEvent<ReportWorkerRequest>) => {
  const request = event.data;

  try {
    if (request.type === "load-folder-start") {
      preparedSource = null;
      loadedSourceKind = "folder";
      loadedSourceSummaries = [];
      folderLoadState.set(request.requestId, {
        files: [],
        importLookbackDays: request.importLookbackDays,
        parseLookbackDays: request.parseLookbackDays
      });
      emitProgress(request.requestId, "scan", "Receiving SD-CARD selection...", 1);
      return;
    }

    if (request.type === "load-folder-handle") {
      preparedSource = null;
      loadedSourceKind = "folder";
      loadedSourceSummaries = [];
      await loadFolderFromDirectoryHandle(
        request.requestId,
        request.rootHandle as WorkerDirectoryHandle,
        request.importLookbackDays,
        request.parseLookbackDays
      );
      return;
    }

    if (request.type === "load-folder-chunk") {
      const state = folderLoadState.get(request.requestId);
      if (!state) throw new Error("Folder upload session was not initialized.");
      state.files.push(...request.files);
      return;
    }

    if (request.type === "load-folder-finish") {
      const state = folderLoadState.get(request.requestId);
      if (!state) throw new Error("Folder upload session was not initialized.");
      folderLoadState.delete(request.requestId);
      await loadSource(
        request.requestId,
        "folder",
        async () =>
          await createCachedSourceFilesFromFolder(state.files, (progress) =>
            emitProgress(request.requestId, progress.phase, progress.detail, progress.percent)
          ),
        state.importLookbackDays,
        state.parseLookbackDays
      );
      return;
    }

    if (request.type === "load-zip") {
      preparedSource = null;
      loadedSourceKind = "zip";
      loadedSourceSummaries = [];
      await loadSource(
        request.requestId,
        "zip",
        async () =>
          await createCachedSourceFilesFromZip(request.zipFile, (progress) =>
            emitProgress(request.requestId, progress.phase, progress.detail, progress.percent)
          ),
        request.importLookbackDays,
        request.parseLookbackDays
      );
      return;
    }

    if (request.type === "generate-reports") {
      if (!preparedSource) {
        throw new Error("No prepared source is loaded. Select an SD-CARD first.");
      }

      const result = await buildReportArtifactsFromPreparedSource({
        prepared: preparedSource,
        patientName: request.patientName,
        dateOfBirthIso: request.dateOfBirthIso,
        physicianName: request.physicianName,
        headerDataUrl: request.headerDataUrl,
        onProgress: (progress) => emitProgress(request.requestId, progress.phase, progress.detail, progress.percent)
      });

      postMessageSafe({
        requestId: request.requestId,
        type: "reports-ready",
        reports: result.reports,
        statusMessage: "Report generated successfully. Review preview and export PDF."
      });
      return;
    }

    if (request.type === "reset") {
      preparedSource = null;
      loadedSourceKind = null;
      loadedSourceSummaries = [];
      folderLoadState.clear();
      postMessageSafe({
        requestId: request.requestId,
        type: "reset-done"
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "An unexpected worker error occurred.";
    postMessageSafe({
      requestId: request.requestId,
      type: "error",
      message
    });
  }
};
