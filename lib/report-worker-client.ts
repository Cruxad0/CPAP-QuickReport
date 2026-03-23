import type { ReportWorkerRequest, ReportWorkerResponse } from "@/lib/report-worker-types";
import type { GeneratedPdfArtifact, ParseProgress, SourceFileSummary } from "@/lib/types";

type LoadSourceResult = {
  sourceKind: "folder" | "zip";
  files: SourceFileSummary[];
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
    files: File[],
    options: { importLookbackDays: number; parseLookbackDays: number; onProgress?: (progress: ParseProgress) => void }
  ): Promise<LoadSourceResult> {
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
        type: "load-folder",
        files,
        importLookbackDays: options.importLookbackDays,
        parseLookbackDays: options.parseLookbackDays
      };
      this.worker.postMessage(request);
    });
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
