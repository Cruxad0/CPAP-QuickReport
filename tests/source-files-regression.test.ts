import assert from "node:assert/strict";
import test from "node:test";

import {
  filterFolderEntriesToRecentWindow,
  filterSourceFilesToRecentWindow,
  shouldSkipPathOutsideRecentWindow
} from "../lib/source-files";
import type { SourceFile } from "../lib/types";

function createSourceFile(path: string, size = 1): SourceFile {
  return {
    name: path.split("/").pop() ?? path,
    path,
    size,
    readText: async () => "",
    readBytes: async () => new Uint8Array()
  };
}

test("source-file recent-window filter reports the actual latest dated file, not the anchored window end", () => {
  const files = [
    createSourceFile("DATALOG/20240115/STR.edf", 100),
    createSourceFile("DATALOG/20240203/EVE.edf", 100)
  ];

  const filtered = filterSourceFilesToRecentWindow(files, 91);

  assert.equal(filtered.hadDatedFiles, true);
  assert.equal(filtered.latestDateIso, "2024-02-03");
});

test("folder-entry recent-window filter reports the actual latest dated file, not the anchored window end", () => {
  const entries = [
    { relativePath: "THERAPY/RECORD/202402/01/STAT", size: 100 },
    { relativePath: "THERAPY/RECORD/202402/07/STAT", size: 100 }
  ];

  const filtered = filterFolderEntriesToRecentWindow(entries, 91);

  assert.equal(filtered.hadDatedFiles, true);
  assert.equal(filtered.latestDateIso, "2024-02-07");
});

test("early path pruning skips old dated folders before SD-card enumeration continues", () => {
  const now = new Date("2026-03-27T10:00:00-04:00");

  assert.equal(shouldSkipPathOutsideRecentWindow("THERAPY/RECORD/202603/25/STAT", 91, now), false);
  assert.equal(shouldSkipPathOutsideRecentWindow("THERAPY/RECORD/202511/01/STAT", 91, now), true);
  assert.equal(shouldSkipPathOutsideRecentWindow("THERAPY/CONFIG/N_APAP", 91, now), false);
});
