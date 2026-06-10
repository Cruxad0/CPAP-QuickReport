"use client";

import {
  extractDatedLeafDirectoryDate,
  filterDatedFolderScanTargets,
  shouldIgnorePathEarly,
  type DeferredFolderSourceEntry
} from "@/lib/source-files";
import type { ParseProgress } from "@/lib/types";

type ProgressCallback = (progress: ParseProgress) => void;

type DirectoryPickerDirectoryHandle = FileSystemDirectoryHandle & {
  values: () => AsyncIterable<FileSystemHandle>;
};

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read"; id?: string }) => Promise<DirectoryPickerDirectoryHandle>;
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
};

const DIRECTORY_ENUMERATION_BATCH_SIZE = 48;

export type DeferredFolderEnumerationResult = {
  entries: DeferredFolderSourceEntry[];
  hasOlderDatedData: boolean;
};

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

export async function pickDirectoryHandle(onPicked?: () => void): Promise<DirectoryPickerDirectoryHandle> {
  const pickerWindow = window as DirectoryPickerWindow;
  const showDirectoryPicker = pickerWindow.showDirectoryPicker;
  if (typeof showDirectoryPicker !== "function") {
    throw new Error("Directory picker is not supported in this browser.");
  }

  const rootHandle = await showDirectoryPicker({
    mode: "read",
    id: "nimv-sd-card"
  });
  onPicked?.();
  return rootHandle;
}

export async function enumerateDeferredFolderEntries(
  rootHandle: DirectoryPickerDirectoryHandle,
  lookbackDays: number,
  onProgress?: ProgressCallback
): Promise<DeferredFolderEnumerationResult> {
  const deferredEntries: DeferredFolderSourceEntry[] = [];
  const datedDirectories: Array<{ handle: DirectoryPickerDirectoryHandle; prefix: string; date: Date }> = [];
  let discovered = 0;

  async function scanStack(
    initialStack: Array<{ handle: DirectoryPickerDirectoryHandle; prefix: string }>,
    deferDatedDirectories: boolean
  ) {
    const stack = [...initialStack];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;

      for await (const childHandle of current.handle.values()) {
        const childPath = current.prefix ? `${current.prefix}/${childHandle.name}` : childHandle.name;
        if (shouldIgnorePathEarly(childPath)) continue;

        if (childHandle.kind === "directory") {
          const datedFolderDate = deferDatedDirectories ? extractDatedLeafDirectoryDate(childPath) : null;
          if (datedFolderDate) {
            datedDirectories.push({
              handle: childHandle as DirectoryPickerDirectoryHandle,
              prefix: childPath,
              date: datedFolderDate
            });
          } else {
            stack.push({
              handle: childHandle as DirectoryPickerDirectoryHandle,
              prefix: childPath
            });
          }
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
  }

  await scanStack([{ handle: rootHandle, prefix: "" }], true);

  const recentDatedDirectories = filterDatedFolderScanTargets(datedDirectories, lookbackDays);
  const skippedDatedDirectories = datedDirectories.length - recentDatedDirectories.length;
  if (skippedDatedDirectories > 0) {
    emit(onProgress, {
      phase: "scan",
      detail: `Skipping ${skippedDatedDirectories} older dated folders before file indexing`,
      percent: 1
    });
    await yieldToBrowser();
  }

  await scanStack(
    recentDatedDirectories.map((directory) => ({ handle: directory.handle, prefix: directory.prefix })),
    false
  );

  emit(onProgress, {
    phase: "scan",
    detail: `Scanning SD-CARD structure... ${deferredEntries.length} files found`,
    percent: 1
  });

  return {
    entries: deferredEntries,
    hasOlderDatedData: skippedDatedDirectories > 0
  };
}

export async function pickDeferredFolderEntries(
  lookbackDays: number,
  onProgress?: ProgressCallback,
  onPicked?: () => void
): Promise<DeferredFolderEnumerationResult> {
  const rootHandle = await pickDirectoryHandle(onPicked);
  return await enumerateDeferredFolderEntries(rootHandle, lookbackDays, onProgress);
}
