import assert from "node:assert/strict";
import test from "node:test";

import { prepareQuickReportSource } from "../lib/parser";
import { detectBmcLegacyWaveformDataOffset } from "../lib/parsers/bmc";
import { inferPrismaLineDeviceFromXml } from "../lib/parsers/prisma";
import {
  parseYuwellFormatB,
  parseYuwellFormatC,
  parseYuwellFormatD
} from "../lib/parsers/yuwell";
import { isDifferentSdCard, sdCardIdentityLabel } from "../lib/sd-card-identity";
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

function writeShortDate(bytes: Uint8Array, offset: number, parts: [number, number, number, number, number, number]) {
  bytes[offset] = parts[0] - 2000;
  bytes[offset + 1] = parts[1];
  bytes[offset + 2] = parts[2];
  bytes[offset + 3] = parts[3];
  bytes[offset + 4] = parts[4];
  bytes[offset + 5] = parts[5];
}

function writeLongDate(bytes: Uint8Array, offset: number, parts: [number, number, number, number, number, number]) {
  writeU16(bytes, offset, parts[0]);
  bytes[offset + 2] = parts[1];
  bytes[offset + 3] = parts[2];
  bytes[offset + 4] = parts[3];
  bytes[offset + 5] = parts[4];
  bytes[offset + 6] = parts[5];
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

test("legacy BMC G3 B20A waveform alignment detects the 255-byte tail packet", () => {
  const standard = new Uint8Array(0x200);
  standard[0] = 0xaa;
  standard[1] = 0xaa;
  assert.equal(detectBmcLegacyWaveformDataOffset(standard), 0);

  const shifted = new Uint8Array(0x300);
  shifted[0xff] = 0xaa;
  shifted[0x100] = 0xaa;
  assert.equal(detectBmcLegacyWaveformDataOffset(shifted), 0xff);
});

test("BMC G3X loader reads IDX summaries and reports mask-on usage instead of total run time", async () => {
  const packetCount = 601;
  const idx = new Uint8Array(0x1000);
  writeAscii(idx, 0, "BMC G/E/P INDEX");
  writeAscii(idx, 0x30, "A3125636308");
  writeAscii(idx, 0x100, "G3 A20");
  const record = 0x800;
  writeU16(idx, record, 0xaaaa);
  idx[record + 0x08] = 126;
  idx[record + 0x09] = 6;
  idx[record + 0x0a] = 10;
  writeU32(idx, record + 0x10, 0);
  writeU32(idx, record + 0x14, packetCount * 0x800);
  writeU32(idx, record + 0x18, packetCount * 0x800);
  const it = record + 0x80;
  idx[it] = 0x49;
  idx[it + 1] = 0x54;
  writeU32(idx, it + 0x14, 600);
  writeU16(idx, it + 0x2c, 900);
  writeU16(idx, it + 0xbc, 250);
  writeU16(idx, it + 0xc2, 100);
  writeU16(idx, it + 0xc4, 50);
  const ts = record + 0x280;
  idx[ts] = 0x54;
  idx[ts + 1] = 0x53;
  writeU16(idx, ts + 0x0e, 500);
  writeU16(idx, ts + 0x10, 1500);

  const wave = new Uint8Array(packetCount * 0x800);
  for (let i = 0; i < packetCount; i += 1) {
    const offset = i * 0x800;
    wave[offset] = 0xad;
    wave[offset + 1] = 0xaa;
    wave[offset + 0x04] = 126;
    wave[offset + 0x05] = 6;
    wave[offset + 0x06] = 10;
    wave[offset + 0x07] = 22;
    wave[offset + 0x08] = Math.floor(i / 60);
    wave[offset + 0x09] = i % 60;
    if (i < 300) writeU16(wave, offset + 0x56e, 100);
    writeU16(wave, offset + 0x52a, 100);
    writeU16(wave, offset + 0x76c, 800);
    writeU16(wave, offset + 0x76e, 800);
  }

  const prepared = await prepareQuickReportSource({
    sourceKind: "folder",
    files: [sourceFile("A3125636308.idx", idx), sourceFile("A3125636308.000", wave)],
    lookbackDays: 90
  });

  assert.equal(prepared.selectedLoader, "ReactHealth / BMC G3 / G3X");
  assert.equal(prepared.machine.device, "G3 A20 (A3125636308)");
  assert.equal(prepared.machine.mode, "APAP");
  assert.equal(prepared.machine.pressureMin, "5 cmH2O");
  assert.equal(prepared.machine.pressureMax, "15 cmH2O");
  assert.ok(prepared.dayBuckets["2026-06-10"].usageSum < 0.1);
  assert.ok(prepared.dayBuckets["2026-06-10"].usageSum > 0.08);
});

test("Yuwell Format B parses YH-580 ring-buffer sessions", () => {
  const bytes = new Uint8Array(0x10000);
  writeAscii(bytes, 0x84, "YH580C-23689005");
  writeU16(bytes, 0x1f, 1);
  const summary = 0x0c00;
  writeShortDate(bytes, summary, [2026, 6, 1, 1, 0, 0]);
  writeShortDate(bytes, summary + 6, [2026, 6, 1, 2, 0, 0]);
  bytes[summary + 12] = 1;
  bytes[summary + 16] = 120;
  bytes[summary + 17] = 50;
  bytes[summary + 29] = 1;
  bytes[0x7600] = 20;
  bytes[0x7601] = 80;
  bytes[0x7603] = 1;

  const sessions = parseYuwellFormatB(bytes);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].modelSerial, "YH580C-23689005");
  assert.equal(sessions[0].mode, 1);
  assert.deepEqual(sessions[0].pressures, [8]);
});

test("Yuwell Format C decodes YH-825 BiPAP IPAP and EPAP", () => {
  const bytes = new Uint8Array(0x3c + 0x28);
  writeLongDate(bytes, 0, [2026, 3, 24, 19, 57, 15]);
  writeLongDate(bytes, 7, [2026, 3, 24, 20, 22, 17]);
  writeU16(bytes, 0x0e, 1);
  writeAscii(bytes, 0x27, "YH825A-V25738024");
  const record = 0x3c;
  bytes[record] = 0xf9;
  bytes[record + 1] = 3;
  writeU16(bytes, record + 2, 160);
  writeU16(bytes, record + 4, 120);
  writeU16(bytes, record + 0x15, 450);
  bytes[record + 0x17] = 100;
  bytes[record + 0x22] = 16;

  const session = parseYuwellFormatC(bytes);
  assert.ok(session);
  assert.equal(session.mode, 3);
  assert.equal(session.ipap, 16);
  assert.equal(session.epap, 12);
  assert.deepEqual(session.ipaps, [16]);
  assert.deepEqual(session.epaps, [12]);
});

test("Yuwell Format D parses YH-690 minute summaries", () => {
  const summary = new Uint8Array(0x4d);
  writeShortDate(summary, 2, [2026, 5, 17, 3, 34, 21]);
  writeShortDate(summary, 8, [2026, 5, 17, 4, 34, 21]);
  writeAscii(summary, 0x20, "YH690F-246350193");
  summary[0x38] = 1;
  const minutes = new Uint8Array(8 + 18);
  writeU16(minutes, 6, 1);
  minutes[8] = 90;
  minutes[10] = 1;
  minutes[17] = 25;

  const session = parseYuwellFormatD(summary, minutes);
  assert.ok(session);
  assert.equal(session.modelSerial, "YH690F-246350193");
  assert.deepEqual(session.pressures, [9]);
  assert.deepEqual(session.leaks, [25]);
});

test("Prisma Line config identifies prisma25S and prisma25ST models", () => {
  const machine25s = {};
  inferPrismaLineDeviceFromXml(
    '<Device><DeviceType value="22"/><DeviceSerialNumber value="S25-001"/></Device>',
    machine25s
  );
  assert.deepEqual(machine25s, { device: "prisma25S (S25-001)" });

  const machine25st = {};
  inferPrismaLineDeviceFromXml(
    '<Device><DeviceType value="23"/><DeviceSerialNumber value="ST25-001"/></Device>',
    machine25st
  );
  assert.deepEqual(machine25st, { device: "prisma25ST (ST25-001)" });
});

test("SD-card identity check compares normalized device identities", () => {
  assert.equal(isDifferentSdCard("resmed|AirSense 11 (123)", "resmed| airsense 11 (123) "), false);
  assert.equal(isDifferentSdCard("resmed|AirSense 11 (123)", "resmed|AirSense 11 (456)"), true);
  assert.equal(sdCardIdentityLabel("bmcg3x|G3 A20 (ABC123)"), "G3 A20 (ABC123)");
});
