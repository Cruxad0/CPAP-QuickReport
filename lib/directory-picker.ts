"use client";

import type { DeferredFolderSourceEntry } from "@/lib/source-files";
import type { ParseProgress } from "@/lib/types";

type ProgressCallback = (progress: ParseProgress) => void;

type DirectoryPickerFileHandle = {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
};

type DirectoryPickerDirectoryHandle = {
  kind: "directory";
  name: string;
  values: () => AsyncIterable<DirectoryPickerFileHandle | DirectoryPickerDirectoryHandle>;
};

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read"; id?: string }) => Promise<DirectoryPickerDirectoryHandle>;
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
};

const DIRECTORY_ENUMERATION_BATCH_SIZE = 48;

async function yieldToBrowser(): Promise<void> {
  const pickerWindow = window as DirectoryPickerWindow;
  if (typeof pickerWindow.requestIdleCallback === "function") {
    await new Promise<void>((resolve) => {
      pickerWindow.requestIdleCallback?.(() => resolve(), { timeout: 40 });
    });
    return;
  }
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

function emit(onProgress: ProgressCallback | undefined, progress: ParseProgress) {
  if (onProgress) onProgress(progress);
}

export function supportsDirectoryPicker() {
  const pickerWindow = window as DirectoryPickerWindow;
  return typeof pickerWindow.showDirectoryPicker === "function";
}

export async function pickDeferredFolderEntries(onProgress?: ProgressCallback): Promise<DeferredFolderSourceEntry[]> {
  const pickerWindow = window as DirectoryPickerWindow;
  const showDirectoryPicker = pickerWindow.showDirectoryPicker;
  if (typeof showDirectoryPicker !== "function") {
    throw new Error("Directory picker is not supported in this browser.");
  }

  emit(onProgress, {
    phase: "scan",
    detail: "Opening SD-CARD directory picker...",
    percent: 1
  });

  const rootHandle = await showDirectoryPicker({
    mode: "read",
    id: "nimv-sd-card"
  });

  const deferredEntries: DeferredFolderSourceEntry[] = [];
  const stack: Array<{ handle: DirectoryPickerDirectoryHandle; prefix: string }> = [{ handle: rootHandle, prefix: "" }];
  let discovered = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    for await (const childHandle of current.handle.values()) {
      const childPath = current.prefix ? `${current.prefix}/${childHandle.name}` : childHandle.name;

      if (childHandle.kind === "directory") {
        stack.push({
          handle: childHandle,
          prefix: childPath
        });
      } else {
        deferredEntries.push({
          name: childHandle.name,
          size: 0,
          relativePath: childPath,
          getFile: async () => await childHandle.getFile()
        });
      }

      discovered += 1;
      if (discovered % DIRECTORY_ENUMERATION_BATCH_SIZE === 0) {
        emit(onProgress, {
          phase: "scan",
          detail: `Scanning SD-CARD structure... ${deferredEntries.length} files found`,
          percent: 1
        });
        await yieldToBrowser();
      }
    }

    await yieldToBrowser();
  }

  emit(onProgress, {
    phase: "scan",
    detail: `Scanning SD-CARD structure... ${deferredEntries.length} files found`,
    percent: 1
  });

  return deferredEntries;
}
