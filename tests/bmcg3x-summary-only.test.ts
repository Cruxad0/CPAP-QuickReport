import assert from "node:assert/strict";
import test from "node:test";

import { prepareQuickReportSource } from "../lib/parser";
import { rankParserFamilies } from "../lib/parsers/families";
import { parseBmcG3xIdxDays } from "../lib/parsers/bmcg3x";
import type { SourceFile } from "../lib/types";

function writeU16(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >> 24) & 0xff;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string) {
  for (let i = 0; i < value.length; i += 1) bytes[offset + i] = value.charCodeAt(i);
}

function sourceFile(path: string, bytes: Uint8Array): SourceFile {
  return {
    name: path.split("/").pop() ?? path,
    path,
    size: bytes.length,
    readText: async () => new TextDecoder().decode(bytes),
    readBytes: async () => bytes
  };
}

function makeIdx(durationSeconds: number, eventLength = 0, eventStart = 0): Uint8Array {
  const bytes = new Uint8Array(0x1000);
  writeAscii(bytes, 0, "BMC G/E/P INDEX");
  writeAscii(bytes, 0x30, "A3125636308");
  writeAscii(bytes, 0x100, "G3 A20");
  const day = 0x800;
  writeU16(bytes, day, 0xaaaa);
  bytes[day + 0x08] = 126;
  bytes[day + 0x09] = 9;
  bytes[day + 0x0a] = 1;
  writeU32(bytes, day + 0x1c, eventStart);
  writeU32(bytes, day + 0x20, eventStart + eventLength);
  writeU32(bytes, day + 0x24, eventLength);
  const it = day + 0x80;
  writeAscii(bytes, it, "IT");
  writeU32(bytes, it + 0x14, durationSeconds);
  writeU16(bytes, it + 0xbc, durationSeconds > 0 ? 250 : 0xffff);
  writeU16(bytes, it + 0xc2, durationSeconds > 0 ? 100 : 0xffff);
  writeU16(bytes, it + 0xc4, durationSeconds > 0 ? 50 : 0xffff);
  writeU16(bytes, it + 0xc6, 0xffff);
  const ts = day + 0x280;
  writeAscii(bytes, ts, "TS");
  writeU16(bytes, ts + 0x0e, 500);
  writeU16(bytes, ts + 0x10, 1500);
  return bytes;
}

function writeEvt(bytes: Uint8Array, recordIndex: number, type: number, hour: number, minute: number) {
  const offset = recordIndex * 0x20;
  bytes[offset] = 0xae;
  bytes[offset + 1] = 0xaa;
  bytes[offset + 0x10] = type;
  bytes[offset + 0x14] = 126;
  bytes[offset + 0x15] = 9;
  bytes[offset + 0x16] = 1;
  bytes[offset + 0x17] = hour;
  bytes[offset + 0x18] = minute;
}

test("G3X IDX-only nightly statistics load without a waveform or EVT file", async () => {
  const idx = makeIdx(7200);
  assert.equal(rankParserFamilies([{ normalizedPath: "A3125636308.idx" }])[0]?.id, "bmcg3x");
  assert.equal(parseBmcG3xIdxDays(idx).length, 1);
  assert.equal(parseBmcG3xIdxDays(makeIdx(0xffffffff)).length, 0);

  const prepared = await prepareQuickReportSource({
    sourceKind: "folder",
    files: [sourceFile("A3125636308.idx", idx)],
    lookbackDays: 90
  });

  assert.equal(prepared.selectedLoader, "ReactHealth / BMC G3 / G3X");
  assert.equal(prepared.machine.mode, "APAP");
  assert.equal(prepared.dayBuckets["2026-09-01"].usageSum, 2);
  assert.equal(prepared.therapySessions?.length, 0);
});

test("G3X EVT-only card recovers session timing and events without waveform data", async () => {
  const evt = new Uint8Array(5 * 0x20);
  writeEvt(evt, 0, 0x40, 22, 0);
  writeEvt(evt, 1, 0x42, 22, 5);
  writeU16(evt, 0x20 + 0x1c, 700);
  writeU16(evt, 0x20 + 0x1e, 900);
  writeEvt(evt, 2, 0x03, 22, 15);
  writeEvt(evt, 3, 0x04, 22, 30);
  writeEvt(evt, 4, 0x41, 23, 0);

  const prepared = await prepareQuickReportSource({
    sourceKind: "folder",
    files: [sourceFile("A3125636308.idx", makeIdx(0, evt.length, 16)), sourceFile("A3125636308.evt", evt)],
    lookbackDays: 90
  });

  assert.equal(prepared.selectedLoader, "ReactHealth / BMC G3 / G3X");
  assert.equal(prepared.dayBuckets["2026-09-01"].usageSum, 1);
  assert.equal(prepared.therapySessions?.length, 1);
  assert.equal(prepared.therapySessions?.[0].startIso, "2026-09-01T22:00:00.000Z");
  assert.equal(prepared.therapySessions?.[0].endIso, "2026-09-01T23:00:00.000Z");
  assert.equal(prepared.dayBuckets["2026-09-01"].ahiWeightedSum, 2);
  assert.equal(prepared.dayBuckets["2026-09-01"].pressureAvgSum, 9);
  assert.equal(prepared.dayBuckets["2026-09-01"].epapAvgSum, 7);
  assert.equal(prepared.dayBuckets["2026-09-01"].ipapAvgSum, 9);
});

test("E5 IDX event indices are ignored and available EVT events supply the rates", async () => {
  const modelIdx = makeIdx(3600);
  writeAscii(modelIdx, 0x100, "E5 B25A Plus");
  assert.equal(parseBmcG3xIdxDays(modelIdx)[0].ahi, undefined);

  const evt = new Uint8Array(2 * 0x20);
  writeEvt(evt, 0, 0x03, 22, 15);
  writeEvt(evt, 1, 0x04, 22, 30);
  const firmwareIdx = makeIdx(3600, evt.length);
  writeAscii(firmwareIdx, 0x345, "E5-1.SC.00.22.22");
  assert.equal(parseBmcG3xIdxDays(firmwareIdx)[0].ahi, undefined);

  const prepared = await prepareQuickReportSource({
    sourceKind: "folder",
    files: [sourceFile("A3125636308.idx", firmwareIdx), sourceFile("A3125636308.evt", evt)],
    lookbackDays: 90
  });

  assert.equal(prepared.dayBuckets["2026-09-01"].ahiWeightedSum, 2);
  assert.equal(prepared.dayBuckets["2026-09-01"].centralApneaSum, 1);
});

test("changing EVT pressure snapshots do not become an unweighted pressure average", async () => {
  const evt = new Uint8Array(2 * 0x20);
  writeEvt(evt, 0, 0x42, 22, 0);
  writeU16(evt, 0x1c, 700);
  writeU16(evt, 0x1e, 700);
  writeEvt(evt, 1, 0x42, 22, 59);
  writeU16(evt, 0x20 + 0x1c, 900);
  writeU16(evt, 0x20 + 0x1e, 900);

  const prepared = await prepareQuickReportSource({
    sourceKind: "folder",
    files: [sourceFile("A3125636308.idx", makeIdx(3600, evt.length)), sourceFile("A3125636308.evt", evt)],
    lookbackDays: 90
  });

  assert.equal(prepared.dayBuckets["2026-09-01"].pressureAvgCount, 0);
  assert.equal(prepared.dayBuckets["2026-09-01"].pressure95Count, 0);
});

test("EVT records outside the indexed byte slice cannot inflate event rates", async () => {
  const evt = new Uint8Array(3 * 0x20);
  writeEvt(evt, 0, 0x40, 22, 0);
  writeEvt(evt, 1, 0x41, 23, 0);
  writeEvt(evt, 2, 0x03, 22, 30);

  const prepared = await prepareQuickReportSource({
    sourceKind: "folder",
    files: [sourceFile("A3125636308.idx", makeIdx(0, 2 * 0x20)), sourceFile("A3125636308.evt", evt)],
    lookbackDays: 90
  });

  assert.equal(prepared.dayBuckets["2026-09-01"].usageSum, 1);
  assert.equal(prepared.dayBuckets["2026-09-01"].ahiCount, 0);
  assert.equal(prepared.dayBuckets["2026-09-01"].ahiWeightHours, 0);
});

test("G3X recovers nearby pressure snapshots outside the indexed EVT slice without importing stale events", async () => {
  const evt = new Uint8Array(4 * 0x20);
  writeEvt(evt, 0, 0x40, 22, 0);
  writeEvt(evt, 1, 0x41, 23, 0);
  writeEvt(evt, 2, 0x42, 22, 15);
  writeU16(evt, 2 * 0x20 + 0x1c, 700);
  writeU16(evt, 2 * 0x20 + 0x1e, 900);
  writeEvt(evt, 3, 0x03, 22, 30);

  const prepared = await prepareQuickReportSource({
    sourceKind: "folder",
    files: [sourceFile("A3125636308.idx", makeIdx(0, 2 * 0x20)), sourceFile("A3125636308.evt", evt)],
    lookbackDays: 90
  });

  const bucket = prepared.dayBuckets["2026-09-01"];
  assert.equal(bucket.usageSum, 1);
  assert.equal(bucket.pressureAvgSum, 9);
  assert.equal(bucket.epapAvgSum, 7);
  assert.equal(bucket.ipapAvgSum, 9);
  assert.equal(bucket.ahiCount, 0);
});

test("G3X pressure fallback keeps adjacent IDX days separate", async () => {
  const idx = new Uint8Array(0x1800);
  idx.set(makeIdx(3600));
  const secondDay = makeIdx(3600);
  secondDay[0x800 + 0x0a] = 2;
  idx.set(secondDay.subarray(0x800), 0x1000);

  const evt = new Uint8Array(2 * 0x20);
  writeEvt(evt, 0, 0x42, 22, 0);
  writeU16(evt, 0x1c, 700);
  writeU16(evt, 0x1e, 900);
  writeEvt(evt, 1, 0x42, 22, 0);
  evt[0x20 + 0x16] = 2;
  writeU16(evt, 0x20 + 0x1c, 800);
  writeU16(evt, 0x20 + 0x1e, 1100);

  const prepared = await prepareQuickReportSource({
    sourceKind: "folder",
    files: [sourceFile("A3125636308.idx", idx), sourceFile("A3125636308.evt", evt)],
    lookbackDays: 90
  });

  assert.equal(prepared.dayBuckets["2026-09-01"].pressureAvgSum, 9);
  assert.equal(prepared.dayBuckets["2026-09-02"].pressureAvgSum, 11);
  assert.equal(prepared.dayBuckets["2026-09-01"].pressureAvgCount, 1);
  assert.equal(prepared.dayBuckets["2026-09-02"].pressureAvgCount, 1);
});

test("invalid EVT clock fields do not create therapy sessions", async () => {
  const evt = new Uint8Array(2 * 0x20);
  writeEvt(evt, 0, 0x40, 22, 0);
  evt[0x18] = 60;
  writeEvt(evt, 1, 0x41, 23, 0);

  const prepared = await prepareQuickReportSource({
    sourceKind: "folder",
    files: [sourceFile("A3125636308.idx", makeIdx(0, evt.length)), sourceFile("A3125636308.evt", evt)],
    lookbackDays: 90
  });

  assert.equal(prepared.therapySessions?.length, 0);
  assert.equal(prepared.dayBuckets["2026-09-01"].usageCount, 0);
});

test("unrelated IDX file is rejected after its header is inspected", async () => {
  await assert.rejects(
    prepareQuickReportSource({
      sourceKind: "folder",
      files: [sourceFile("other.idx", new Uint8Array(0x1000))],
      lookbackDays: 90
    }),
    /Device structure was not recognized/
  );
});
