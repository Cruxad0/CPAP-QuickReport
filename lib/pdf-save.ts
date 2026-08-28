type PdfSavePickerOptions = {
  suggestedName?: string;
  startIn?: "downloads";
  id?: string;
  types?: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
};

type PdfSavePickerWindow = Window & {
  showSaveFilePicker?: (options?: PdfSavePickerOptions) => Promise<FileSystemFileHandle>;
};

export type PdfSaveResult = "saved" | "downloaded" | "cancelled";

type PdfSaveEnvironment = {
  browserWindow?: Window;
  browserDocument?: Document;
};

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function triggerBrowserDownload(previewUrl: string, filename: string, browserDocument: Document) {
  const link = browserDocument.createElement("a");
  link.href = previewUrl;
  link.download = filename;
  browserDocument.body.appendChild(link);
  link.click();
  link.remove();
}

export async function savePdfArtifact(
  blob: Blob,
  filename: string,
  previewUrl: string,
  environment: PdfSaveEnvironment = {}
): Promise<PdfSaveResult> {
  const browserWindow = (environment.browserWindow ?? window) as PdfSavePickerWindow;
  const showSaveFilePicker = browserWindow.showSaveFilePicker;

  if (typeof showSaveFilePicker === "function") {
    let fileHandle: FileSystemFileHandle;
    try {
      fileHandle = await showSaveFilePicker.call(browserWindow, {
        suggestedName: filename,
        startIn: "downloads",
        id: "cpap-quickreport-pdf",
        types: [
          {
            description: "PDF document",
            accept: { "application/pdf": [".pdf"] }
          }
        ]
      });
    } catch (error) {
      if (isAbortError(error)) return "cancelled";
      throw error;
    }

    const writable = await fileHandle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      try {
        await writable.abort(error);
      } catch {
        // Preserve the original write/close failure for the user-facing error.
      }
      throw error;
    }
    return "saved";
  }

  triggerBrowserDownload(previewUrl, filename, environment.browserDocument ?? document);
  return "downloaded";
}
