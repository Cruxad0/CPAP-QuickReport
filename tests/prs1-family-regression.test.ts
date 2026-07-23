import assert from "node:assert/strict";
import test from "node:test";

import { buildQuickReportMetricsFromPreparedSource, prepareQuickReportSource } from "../lib/parser";
import { rankParserFamilies, selectLoaderMatchByDatedRecency } from "../lib/parsers/families";
import { selectPrs1MachineRootId } from "../lib/parsers/prs1";
import { shouldIgnorePathEarly } from "../lib/source-files";
import type { SourceFile } from "../lib/types";

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

test("legacy BMC bundles do not rank as BMC G3X", () => {
  const files = [
    { normalizedPath: "22A35472.USR" },
    { normalizedPath: "22A35472.idx" },
    { normalizedPath: "22A35472.000" },
    { normalizedPath: "22A35472.evt" }
  ];

  const ranked = rankParserFamilies(files);
  assert.equal(ranked[0]?.id, "bmc");
  assert.equal(ranked.some((match) => match.id === "bmcg3x"), false);
});

test("BMC G3X IDX and waveform bundles rank as BMC G3X", () => {
  const files = [
    { normalizedPath: "A3125636308.idx" },
    { normalizedPath: "A3125636308.000" },
    { normalizedPath: "A3125636308.evt" }
  ];

  const ranked = rankParserFamilies(files);
  assert.equal(ranked[0]?.id, "bmcg3x");
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

function createSourceFile(path: string, bytes: Uint8Array, text?: string): SourceFile {
  return {
    name: path.split("/").pop() ?? path,
    path,
    size: bytes.byteLength,
    readText: async () => text ?? new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    readBytes: async () => bytes
  };
}

function writeLe16(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >> 8) & 0xff;
}

function writeLe32(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >> 8) & 0xff;
  target[offset + 2] = (value >> 16) & 0xff;
  target[offset + 3] = (value >> 24) & 0xff;
}

function prs1SummaryPayloadWithLeaks(leaks: number[], sampleSeconds: number): Uint8Array {
  const recordBytes: number[] = [];
  for (const leak of leaks) {
    recordBytes.push(2, 0, 0, 0, 0, 0, 0, 0);

    const offRecord = new Uint8Array(37);
    offRecord[0] = 3;
    writeLe16(offRecord, 1, sampleSeconds);
    offRecord[1 + 0x22] = leak;
    recordBytes.push(...offRecord);
  }
  return new Uint8Array(recordBytes);
}

function prs1Chunk(data: Uint8Array, timestamp: number): Uint8Array {
  const blockSize = data.byteLength + 18;
  const bytes = new Uint8Array(blockSize);
  bytes[0] = 2;
  writeLe16(bytes, 1, blockSize);
  bytes[3] = 0;
  bytes[4] = 0;
  bytes[5] = 4;
  bytes[6] = 0;
  writeLe32(bytes, 7, 0x12345678);
  writeLe32(bytes, 11, timestamp);
  bytes.set(data, 16);
  return bytes;
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

test("PRS1 leak samples populate leak duration fields for CPAP, APAP, and BiPAP modes", async () => {
  const sessionDate = Date.UTC(2026, 3, 15, 12, 0, 0) / 1000;
  const modeCases: Array<{ mode: "CPAP" | "APAP" | "BiPAP"; model: string }> = [
    { mode: "CPAP", model: "450P" },
    { mode: "APAP", model: "550P" },
    { mode: "BiPAP", model: "750P" }
  ];

  for (const { mode, model } of modeCases) {
    const propertiesText = [`ModelNumber=${model}`, `Mode=${mode}`].join("\n");
    const files: SourceFile[] = [
      createSourceFile(
        "P-SERIES/PRSROOT/P0/12345678.000",
        prs1Chunk(prs1SummaryPayloadWithLeaks([40, 45], 600), sessionDate)
      ),
      createSourceFile("P-SERIES/PRSROOT/properties.txt", new TextEncoder().encode(propertiesText), propertiesText)
    ];

    const prepared = await prepareQuickReportSource({
      sourceKind: "folder",
      files,
      lookbackDays: 90
    });
    const metrics = buildQuickReportMetricsFromPreparedSource(prepared, {
      patientName: "Fixture Patient",
      dateOfBirthIso: "1970-01-01",
      physicianName: "",
      lookbackDays: 7,
      windowEndClinicalDayIso: "2026-04-16"
    });

    assert.equal(prepared.selectedLoader, "Philips Respironics System One / DreamStation");
    assert.equal(prepared.machine.mode, mode);
    assert.equal(metrics.avgAhi, null);
    assert.equal(metrics.avgResidualApneas, null);
    assert.equal(metrics.avgCentralApneas, null);
    assert.equal(metrics.avgReraIndex, null);
    assert.equal(metrics.avgLeak, 42.5);
    assert.equal(metrics.maxLeak, 45);
    assert.ok(Math.abs((metrics.maxLeakMinutes ?? 0) - 20) < 0.0001);
    assert.equal(metrics.sustainedLeakMax, 45);
    assert.ok(Math.abs((metrics.sustainedLeakMinutes ?? 0) - 20) < 0.0001);
  }
});
