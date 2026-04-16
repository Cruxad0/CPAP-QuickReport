import assert from "node:assert/strict";
import test from "node:test";

import { prepareQuickReportSource } from "../lib/parser";
import type { SourceFile } from "../lib/types";

function createSourceFile(path: string, bytes: Uint8Array): SourceFile {
  return {
    name: path.split("/").pop() ?? path,
    path,
    size: bytes.byteLength,
    readText: async () => new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    readBytes: async () => bytes
  };
}

function writeAsciiField(target: Uint8Array, offset: number, length: number, value: string) {
  const encoded = new TextEncoder().encode(value.padEnd(length, " ").slice(0, length));
  target.set(encoded, offset);
}

function createSyntheticResMedStrEdf(): Uint8Array {
  const signals = [
    { label: "Date", min: 0, max: 40000, dmin: 0, dmax: 40000, samples: 1, value: 20260415 },
    { label: "Duration", min: 0, max: 24, dmin: 0, dmax: 2400, samples: 1, value: 600 },
    { label: "Mode", min: 0, max: 20, dmin: 0, dmax: 20, samples: 1, value: 0 },
    { label: "S.C.Press", min: 0, max: 20, dmin: 0, dmax: 200, samples: 1, value: 60 },
    { label: "AHI", min: 0, max: 50, dmin: 0, dmax: 500, samples: 1, value: 15 },
    { label: "AI", min: 0, max: 50, dmin: 0, dmax: 500, samples: 1, value: 10 },
    { label: "CAI", min: 0, max: 50, dmin: 0, dmax: 500, samples: 1, value: 2 },
    { label: "Leak Max", min: 0, max: 100, dmin: 0, dmax: 1000, samples: 1, value: 12 },
    { label: "MaskPress.50", min: 0, max: 20, dmin: 0, dmax: 200, samples: 1, value: 58 },
    { label: "MaskPress.95", min: 0, max: 20, dmin: 0, dmax: 200, samples: 1, value: 60 }
  ];

  const numSignals = signals.length;
  const headerBytes = 256 + numSignals * 256;
  const samplesPerRecord = signals.reduce((sum, signal) => sum + signal.samples, 0);
  const bytesPerRecord = samplesPerRecord * 2;
  const totalBytes = headerBytes + bytesPerRecord;
  const bytes = new Uint8Array(totalBytes);
  const view = new DataView(bytes.buffer);

  writeAsciiField(bytes, 0, 8, "0");
  writeAsciiField(bytes, 8, 80, "QuickReport Fixture");
  writeAsciiField(bytes, 88, 80, "Fixture Patient");
  writeAsciiField(bytes, 168, 8, "15.04.26");
  writeAsciiField(bytes, 176, 8, "00.00.00");
  writeAsciiField(bytes, 184, 8, String(headerBytes));
  writeAsciiField(bytes, 192, 44, "Synthetic ResMed STR");
  writeAsciiField(bytes, 236, 8, "1");
  writeAsciiField(bytes, 244, 8, "1");
  writeAsciiField(bytes, 252, 4, String(numSignals));

  const labelsStart = 256;
  const transducerStart = labelsStart + numSignals * 16;
  const physDimStart = transducerStart + numSignals * 80;
  const physMinStart = physDimStart + numSignals * 8;
  const physMaxStart = physMinStart + numSignals * 8;
  const digMinStart = physMaxStart + numSignals * 8;
  const digMaxStart = digMinStart + numSignals * 8;
  const prefilterStart = digMaxStart + numSignals * 8;
  const samplesStart = prefilterStart + numSignals * 80;

  let sampleOffset = 0;
  for (let i = 0; i < signals.length; i += 1) {
    const signal = signals[i];
    writeAsciiField(bytes, labelsStart + i * 16, 16, signal.label);
    writeAsciiField(bytes, transducerStart + i * 80, 80, "");
    writeAsciiField(bytes, physDimStart + i * 8, 8, "cmH2O");
    writeAsciiField(bytes, physMinStart + i * 8, 8, String(signal.min));
    writeAsciiField(bytes, physMaxStart + i * 8, 8, String(signal.max));
    writeAsciiField(bytes, digMinStart + i * 8, 8, String(signal.dmin));
    writeAsciiField(bytes, digMaxStart + i * 8, 8, String(signal.dmax));
    writeAsciiField(bytes, prefilterStart + i * 80, 80, "");
    writeAsciiField(bytes, samplesStart + i * 8, 8, String(signal.samples));

    view.setInt16(headerBytes + sampleOffset * 2, signal.value, true);
    sampleOffset += signal.samples;
  }

  return bytes;
}

test("ResMed preparation retains root STR/settings metadata when DATALOG EDF volume is high", async () => {
  const files: SourceFile[] = [];

  for (let i = 0; i < 3000; i += 1) {
    const day = String((i % 28) + 1).padStart(2, "0");
    const hhmmss = String(200000 + i).padStart(6, "0");
    const path = `DATALOG/202604${day}/202604${day}_${hhmmss}_SAD.edf`;
    files.push(createSourceFile(path, new Uint8Array([0x01])));
  }

  files.push(createSourceFile("Identification.tgt", new TextEncoder().encode("#PNA AirSense_10_AutoSet\n")));
  files.push(createSourceFile("SETTINGS/BGL.tgt", new TextEncoder().encode("#PNA AirSense_10_AutoSet\n")));
  files.push(createSourceFile("STR.edf", createSyntheticResMedStrEdf()));

  const prepared = await prepareQuickReportSource({
    sourceKind: "folder",
    files,
    lookbackDays: 365
  });

  assert.equal(prepared.selectedLoader, "ResMed");
  assert.equal(prepared.machine.device, "AirSense 10 AutoSet");
  assert.equal(prepared.machine.mode, "CPAP");
  assert.equal(prepared.machine.pressure, "Fixed 6 cmH2O");
  assert.equal(prepared.latestClinicalDayIso, "2026-04-15");
});
