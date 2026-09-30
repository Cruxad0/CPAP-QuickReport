import assert from "node:assert/strict";
import test from "node:test";

import { parseBmcFamily, parseBmcHistoricSession } from "../lib/parsers/bmc";
import type { FamilyParserCandidate, FamilyParserContext } from "../lib/parsers/text-family-types";
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

function encodeBmcDate(year: number, month: number, day: number): number {
  return ((year - 2000) << 9) | (month << 5) | day;
}

function candidate(path: string, bytes: Uint8Array): FamilyParserCandidate {
  const file: SourceFile = {
    name: path.split("/").pop() ?? path,
    path,
    size: bytes.length,
    readText: async () => new TextDecoder().decode(bytes),
    readBytes: async () => bytes
  };
  return { file, normalizedPath: path, baseName: file.name, recordDate: null };
}

function waveformPacket(hour: number, minute: number, second: number, leak: number, pressure: number, day = 15): Uint8Array {
  const bytes = new Uint8Array(0x100);
  writeU16(bytes, 0, 0xaaaa);
  writeU16(bytes, 0x04, pressure * 2);
  writeU16(bytes, 0x06, pressure * 2);
  writeU16(bytes, 0xc4, leak * 10);
  writeU16(bytes, 0xf8, 2026);
  bytes[0xfa] = 3;
  bytes[0xfb] = day;
  bytes[0xfc] = hour;
  bytes[0xfd] = minute;
  bytes[0xfe] = second;
  return bytes;
}

function packets(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.length * 0x100);
  parts.forEach((part, index) => bytes.set(part, index * 0x100));
  return bytes;
}

function usrFile(day: number): Uint8Array {
  const usr = new Uint8Array(0x102340 + 0x80);
  const session = usr.subarray(0x102340);
  session[0] = 0xe1;
  writeU16(session, 0x07, encodeBmcDate(2026, 3, day));
  writeU16(session, 0x0f, 120);
  session[0x45] = 0xff;
  writeU32(session, 0x46, 0xffffffff);
  return usr;
}

test("BMC historic session consumes the sentinel payload before parsing event blocks", () => {
  const session = new Uint8Array(0x80);
  session[0] = 0xe1;
  writeU16(session, 0x07, encodeBmcDate(2026, 3, 15));
  writeU16(session, 0x0f, 120);

  let pos = 0x45;
  session[pos] = 0x83;
  writeU32(session, pos + 1, 0x60);
  pos += 5;
  session[pos] = 0x87;
  writeU32(session, pos + 1, 0x68);
  pos += 5;
  session[pos] = 0xff;
  writeU32(session, pos + 1, 0x6f);
  pos += 5;

  session[pos] = 0x83;
  writeU16(session, pos + 1, 1);
  writeU16(session, pos + 3, 0);
  pos += 5;
  session[pos] = 1;
  session[pos + 1] = 30;
  session[pos + 2] = 10;
  pos += 3;

  session[pos] = 0x87;
  writeU16(session, pos + 1, 2);
  writeU16(session, pos + 3, 0);
  pos += 5;
  session[pos] = 2;
  session[pos + 1] = 0;
  session[pos + 2] = 12;
  session[pos + 3] = 3;
  session[pos + 4] = 0;
  session[pos + 5] = 8;

  const record = parseBmcHistoricSession(session);
  assert.ok(record);
  assert.equal(record.usageHours, 2);
  assert.equal(record.ahi, 1.5);
  assert.equal(record.residualApneas, 0.5);
  assert.equal(record.centralApneas, 1);
});

test("BMC historic session keeps respiratory metrics absent without event blocks", () => {
  const session = new Uint8Array(0x80);
  session[0] = 0xe1;
  writeU16(session, 0x07, encodeBmcDate(2026, 3, 15));
  writeU16(session, 0x0f, 60);
  session[0x45] = 0xff;
  writeU32(session, 0x46, 0xffffffff);

  const record = parseBmcHistoricSession(session);
  assert.ok(record);
  assert.equal(record.usageHours, 1);
  assert.equal(record.ahi, undefined);
  assert.equal(record.residualApneas, undefined);
  assert.equal(record.centralApneas, undefined);
});

test("BMC historic session rejects invalid encoded calendar dates", () => {
  for (const [month, day] of [[13, 15], [2, 31]]) {
    const session = new Uint8Array(0x80);
    session[0] = 0xe1;
    writeU16(session, 0x07, encodeBmcDate(2026, month, day));
    writeU16(session, 0x0f, 60);
    assert.equal(parseBmcHistoricSession(session), null);
  }
});

test("BMC historic session preserves explicit zero respiratory event counts", () => {
  const session = new Uint8Array(0xa0);
  session[0] = 0xe1;
  writeU16(session, 0x07, encodeBmcDate(2026, 3, 15));
  writeU16(session, 0x0f, 60);

  let pos = 0x45;
  session[pos] = 0xff;
  writeU32(session, pos + 1, 0xffffffff);
  pos += 5;

  for (const type of [0x83, 0x84, 0x87]) {
    session[pos] = type;
    writeU16(session, pos + 1, 0);
    writeU16(session, pos + 3, 0);
    pos += 5;
  }

  const record = parseBmcHistoricSession(session);
  assert.ok(record);
  assert.equal(record.usageHours, 1);
  assert.equal(record.ahi, 0);
  assert.equal(record.residualApneas, 0);
  assert.equal(record.centralApneas, 0);
});

test("BMC historic session does not derive indices from an implausible duration", () => {
  const session = new Uint8Array(0x80);
  session[0] = 0xe1;
  writeU16(session, 0x07, encodeBmcDate(2026, 3, 15));
  writeU16(session, 0x0f, 24 * 60 + 1);
  session[0x45] = 0xff;
  writeU32(session, 0x46, 0xffffffff);
  session[0x4a] = 0x83;
  writeU16(session, 0x4b, 1);
  session[0x4f] = 1;
  session[0x50] = 0;
  session[0x51] = 10;

  const record = parseBmcHistoricSession(session);
  assert.ok(record);
  assert.equal(record.date.toISOString().slice(0, 10), "2026-03-15");
  assert.equal(record.usageHours, undefined);
  assert.equal(record.ahi, undefined);
  assert.equal(record.residualApneas, undefined);
  assert.equal(record.centralApneas, undefined);
});

test("BMC legacy waveform import starts at the IDX packet across the circular file boundary", async () => {
  const usr = usrFile(15);

  const idx = new Uint8Array(0xa00);
  const record = 0x800;
  writeU16(idx, record, 0xaaaa);
  idx[record + 4] = 26;
  idx[record + 5] = 3;
  idx[record + 6] = 15;
  writeU16(idx, record + 0x0d, 1); // Packet 1 in .001 is the current recording start.
  writeU16(idx, record + 0x0f, 1);

  const wave000 = packets(
    waveformPacket(22, 0, 2, 30, 12),
    waveformPacket(16, 0, 0, 200, 25) // Stale ring data after the wrap.
  );
  const wave001 = packets(
    waveformPacket(16, 0, 1, 200, 25), // Stale data before the IDX start.
    waveformPacket(22, 0, 0, 10, 8),
    waveformPacket(22, 0, 1, 20, 10)
  );

  const context: FamilyParserContext = {
    familyLabel: "Apex / BMC / Luna",
    candidates: [
      candidate("card/one.usr", usr),
      candidate("card/one.idx", idx),
      candidate("card/one.000", wave000),
      candidate("card/one.001", wave001)
    ],
    lookbackDays: 90,
    machine: {},
    records: [],
    sourceTimeZoneOffsetMinutes: null,
    warnings: [],
    progressStart: 0,
    progressEnd: 100
  };
  await parseBmcFamily(context, { emit: () => undefined });

  const summary = context.records.find((entry) => entry.usageHours !== undefined);
  const waveform = context.records.find((entry) => entry.leak !== undefined);
  assert.equal(summary?.usageHours, 2, "USR usage survives independently of waveform data");
  assert.equal(waveform?.leak, 20);
  assert.equal(waveform?.pressureAvg, 10);
  assert.equal(waveform?.leakMax, 30);
});

test("BMC legacy waveforms only use USR days from their matching file base", async () => {
  const context: FamilyParserContext = {
    familyLabel: "Apex / BMC / Luna",
    candidates: [
      candidate("card/one.usr", usrFile(15)),
      candidate("card/two.usr", usrFile(16)),
      candidate("card/one.000", packets(waveformPacket(22, 0, 0, 10, 8))),
      candidate("card/two.000", packets(
        waveformPacket(22, 0, 0, 200, 25, 15),
        waveformPacket(22, 0, 0, 20, 10, 16)
      ))
    ],
    lookbackDays: 90,
    machine: {},
    records: [],
    sourceTimeZoneOffsetMinutes: null,
    warnings: [],
    progressStart: 0,
    progressEnd: 100
  };
  await parseBmcFamily(context, { emit: () => undefined });

  const waveforms = context.records.filter((entry) => entry.leak !== undefined);
  assert.deepEqual(
    waveforms.map((entry) => [entry.date.toISOString().slice(0, 10), entry.leak]),
    [["2026-03-15", 10], ["2026-03-16", 20]]
  );
  assert.deepEqual(
    context.records.filter((entry) => entry.usageHours !== undefined).map((entry) => entry.usageHours),
    [2, 2]
  );
});
