import assert from "node:assert/strict";
import test from "node:test";

import {
  extractDatedLeafDirectoryDate,
  filterDatedFolderScanTargets,
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

test("recent-window filters keep the most recent dated data relative to the latest file, not today's date", () => {
  const files = [
    createSourceFile("THERAPY/RECORD/202512/25/STAT", 100),
    createSourceFile("THERAPY/RECORD/202512/26/STAT", 100),
    createSourceFile("THERAPY/RECORD/202512/27/STAT", 100),
    createSourceFile("THERAPY/RECORD/202603/25/STAT", 100)
  ];

  const filtered = filterSourceFilesToRecentWindow(files, 90);

  assert.equal(filtered.files.some((file) => file.path.includes("202512/25")), false);
  assert.equal(filtered.files.some((file) => file.path.includes("202512/26")), true);
  assert.equal(filtered.files.some((file) => file.path.includes("202512/27")), true);
  assert.equal(filtered.files.some((file) => file.path.includes("202603/25")), true);
  assert.equal(filtered.hasOlderDatedData, true);
});

test("early path pruning skips old dated folders before SD-card enumeration continues", () => {
  const now = new Date("2026-03-27T10:00:00-04:00");

  assert.equal(shouldSkipPathOutsideRecentWindow("THERAPY/RECORD/202603/25/STAT", 91, now), false);
  assert.equal(shouldSkipPathOutsideRecentWindow("THERAPY/RECORD/202511/01/STAT", 91, now), true);
  assert.equal(shouldSkipPathOutsideRecentWindow("THERAPY/CONFIG/N_APAP", 91, now), false);
});

test("dated leaf directory detection recognizes manufacturer day folders", () => {
  assert.equal(extractDatedLeafDirectoryDate("THERAPY/RECORD/202603/25")?.toISOString().slice(0, 10), "2026-03-25");
  assert.equal(extractDatedLeafDirectoryDate("RECORD/202603/25")?.toISOString().slice(0, 10), "2026-03-25");
  assert.equal(extractDatedLeafDirectoryDate("DATALOG/20260325")?.toISOString().slice(0, 10), "2026-03-25");
  assert.equal(extractDatedLeafDirectoryDate("DATALOG/2026-03-25")?.toISOString().slice(0, 10), "2026-03-25");
  assert.equal(extractDatedLeafDirectoryDate("THERAPY/RECORD/202603"), null);
  assert.equal(extractDatedLeafDirectoryDate("THERAPY/CONFIG"), null);
});

test("dated folder scan targets are filtered relative to latest data, not today's date", () => {
  const targets = [
    "THERAPY/RECORD/202401/01",
    "THERAPY/RECORD/202404/01",
    "THERAPY/RECORD/202404/02"
  ].map((relativePath) => {
    const date = extractDatedLeafDirectoryDate(relativePath);
    assert.ok(date);
    return { relativePath, date };
  });

  const recentTargets = filterDatedFolderScanTargets(targets, 2);

  assert.deepEqual(
    recentTargets.map((target) => target.relativePath),
    ["THERAPY/RECORD/202404/01", "THERAPY/RECORD/202404/02"]
  );
});
