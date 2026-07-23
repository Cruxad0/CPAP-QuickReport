import assert from "node:assert/strict";
import test from "node:test";

import { parseBmcHistoricSession } from "../lib/parsers/bmc";

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
