import assert from "node:assert/strict";
import test from "node:test";

import { rankParserFamilies, selectLoaderMatchByDatedRecency } from "../lib/parsers/families";
import { selectPrs1MachineRootId } from "../lib/parsers/prs1";
import { shouldIgnorePathEarly } from "../lib/source-files";

test("DreamStation-style P-SERIES structure ranks Philips PRS1 ahead of BMC/Luna", () => {
  const files = [
    { normalizedPath: "P-SERIES/LAST.TXT" },
    { normalizedPath: "P-SERIES/74FAE00C/PROP.BIN" },
    { normalizedPath: "P-SERIES/74FAE00C/LOG.SEQ" },
    { normalizedPath: "P-SERIES/74FAE00C/D/000.003" },
    { normalizedPath: "P-SERIES/74FAE00C/E/000.004" }
  ];

  const ranked = rankParserFamilies(files);
  assert.ok(ranked.length > 0);
  assert.equal(ranked[0]?.id, "prs1");
});

function datedCandidate(path: string, isoDay: string | null) {
  return {
    normalizedPath: path,
    recordDate: isoDay ? new Date(`${isoDay}T12:00:00Z`) : null
  };
}

test("mixed card loader selection prefers the detected layout with newest dated folder data", () => {
  const files = [
    datedCandidate("DATALOG/20240101/STR.edf", "2024-01-01"),
    datedCandidate("DATALOG/20240101/EVE.edf", "2024-01-01"),
    datedCandidate("DATALOG/20240101/PLD.edf", "2024-01-01"),
    datedCandidate("IDENTIFICATION.TGT", null),
    datedCandidate("THERAPY/CONFIG/N_APAP", null),
    datedCandidate("THERAPY/RECORD/202404/30/STAT", "2024-04-30"),
    datedCandidate("THERAPY/RECORD/202404/30/EV00", "2024-04-30")
  ];

  const ranked = rankParserFamilies(files);
  assert.equal(ranked[0]?.id, "resmed");

  const selected = selectLoaderMatchByDatedRecency(files, ranked);
  assert.equal(selected.selected?.id, "resvent");
  assert.equal(selected.selectedByLatestDatedData, true);
});

test("mixed card loader selection does not displace an unknown-date score winner with stale dated evidence", () => {
  const files = [
    datedCandidate("P-SERIES/LAST.TXT", null),
    datedCandidate("P-SERIES/74FAE00C/PROP.BIN", null),
    datedCandidate("P-SERIES/74FAE00C/LOG.SEQ", null),
    datedCandidate("P-SERIES/74FAE00C/P0/000.001", null),
    datedCandidate("P-SERIES/P12345.001", null),
    datedCandidate("DATALOG/20240101/STR.edf", "2024-01-01"),
    datedCandidate("DATALOG/20240101/EVE.edf", "2024-01-01")
  ];

  const ranked = rankParserFamilies(files);
  assert.equal(ranked[0]?.id, "prs1");

  const selected = selectLoaderMatchByDatedRecency(files, ranked);
  assert.equal(selected.selected?.id, "prs1");
  assert.equal(selected.selectedByLatestDatedData, false);
});

test("known OS metadata paths are ignored before SD-card parsing", () => {
  assert.equal(shouldIgnorePathEarly(".Spotlight-V100/Store-V2/file"), true);
  assert.equal(shouldIgnorePathEarly(".fseventsd/0000000004261b45"), true);
  assert.equal(shouldIgnorePathEarly("System Volume Information/WPSettings.dat"), true);
  assert.equal(shouldIgnorePathEarly("THERAPY/CONFIG/N_APAP"), false);
  assert.equal(shouldIgnorePathEarly("THERAPY/CONFIG/N_CPAP"), false);
  assert.equal(shouldIgnorePathEarly("P-SERIES/74FAE00C/PROP.BIN"), false);
});

function createCandidate(path: string, text = "") {
  return {
    normalizedPath: path,
    baseName: path.split("/").pop() ?? path,
    recordDate: null,
    file: {
      name: path.split("/").pop() ?? path,
      path,
      size: text.length,
      readText: async () => text,
      readBytes: async () => new Uint8Array()
    }
  };
}

test("PRS1 root selection falls back when LAST.TXT points to an incomplete root", async () => {
  const candidates = [
    createCandidate("P-SERIES/LAST.TXT", "OLDROOT"),
    createCandidate("P-SERIES/OLDROOT/PROP.BIN"),
    createCandidate("P-SERIES/NEWROOT/PROP.BIN"),
    createCandidate("P-SERIES/NEWROOT/LOG.SEQ"),
    createCandidate("P-SERIES/NEWROOT/P0/000.001"),
    createCandidate("P-SERIES/NEWROOT/P1/000.002")
  ];

  const selected = await selectPrs1MachineRootId(candidates);
  assert.equal(selected, "NEWROOT");
});

test("PRS1 root selection still respects LAST.TXT when it points to a valid smaller root", async () => {
  const candidates = [
    createCandidate("P-SERIES/LAST.TXT", "ACTIVEROOT"),
    createCandidate("P-SERIES/ACTIVEROOT/PROP.BIN"),
    createCandidate("P-SERIES/ACTIVEROOT/LOG.SEQ"),
    createCandidate("P-SERIES/ACTIVEROOT/P0/000.001"),
    createCandidate("P-SERIES/ARCHIVE/PROP.BIN"),
    createCandidate("P-SERIES/ARCHIVE/LOG.SEQ"),
    createCandidate("P-SERIES/ARCHIVE/P0/000.001"),
    createCandidate("P-SERIES/ARCHIVE/P1/000.001"),
    createCandidate("P-SERIES/ARCHIVE/P2/000.001")
  ];

  const selected = await selectPrs1MachineRootId(candidates);
  assert.equal(selected, "ACTIVEROOT");
});
