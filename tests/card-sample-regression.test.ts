import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildQuickReportMetricsFromPreparedSource, prepareQuickReportSource } from "../lib/parser";
import { createSourceFilesFromDirectory } from "./helpers/fs-source-files";

function nextClinicalDayIso(isoDay: string): string {
  return new Date(new Date(`${isoDay}T00:00:00Z`).getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
}

async function loadFixture(root: string, lookbackDays = 90) {
  const files = await createSourceFilesFromDirectory(root);
  const prepared = await prepareQuickReportSource({
    sourceKind: "folder",
    files,
    lookbackDays
  });
  const metrics = buildQuickReportMetricsFromPreparedSource(prepared, {
    patientName: "Fixture Patient",
    dateOfBirthIso: "1970-01-01",
    physicianName: "",
    lookbackDays,
    windowEndClinicalDayIso: nextClinicalDayIso(prepared.latestClinicalDayIso)
  });
  return { prepared, metrics };
}

function assertApprox(actual: number | null, expected: number, tolerance: number, label: string) {
  assert.notEqual(actual, null, `${label} should be present`);
  assert.ok(Math.abs((actual as number) - expected) <= tolerance, `${label} expected ${expected} +/- ${tolerance}, got ${actual}`);
}

const RESVENT_ROOT = path.join(process.cwd(), "Card Samples", "Resvent");
const RESVENT_THERAPY = path.join(process.cwd(), "Card Samples", "Resvent", "THERAPY");
const LUNA2_ROOT = path.join(process.cwd(), "Card Samples", "Luna2");
const DREAMSTATION_ROOT = path.join(process.cwd(), "Card Samples", "Dreamstation");
const RESMED_AIRSENSE11_ROOT = path.join(process.cwd(), "Card Samples", "ResMed", "AirSense", "11", "APAP");
const RESMED_AIRCURVE10_ROOT = path.join(process.cwd(), "Card Samples", "ResMed", "AirCurve", "10", "VAuto");
const RESMED_AIRBREAK_AS10_ROOT = path.join(process.cwd(), "Card Samples", "ResMed", "AirBreak", "AS10", "ASVAuto");

const maybeResventTest = existsSync(RESVENT_ROOT) ? test : test.skip;
const maybeResventTherapyTest = existsSync(RESVENT_THERAPY) ? test : test.skip;
const maybeLunaTest = existsSync(LUNA2_ROOT) ? test : test.skip;
const maybeDreamstationTest = existsSync(DREAMSTATION_ROOT) ? test : test.skip;
const maybeAirSense11Test = existsSync(RESMED_AIRSENSE11_ROOT) ? test : test.skip;
const maybeAirCurve10Test = existsSync(RESMED_AIRCURVE10_ROOT) ? test : test.skip;
const maybeAirBreakTest = existsSync(RESMED_AIRBREAK_AS10_ROOT) ? test : test.skip;

maybeResventTest("Resvent sample card preserves APAP config and metrics", async () => {
  const { prepared, metrics } = await loadFixture(RESVENT_ROOT);
  assert.equal(prepared.selectedLoader, "Resvent / Hoffrichter");
  assert.equal(prepared.machine.device, "iBreeze 20A (GB-2B496636)");
  assert.equal(prepared.machine.mode, "APAP");
  assert.equal(prepared.machine.pressureMin, "8.5 cmH2O");
  assert.equal(prepared.machine.pressureMax, "11 cmH2O");
  assert.equal(prepared.machine.pressureRelief, "IPR: On 1");
  assert.equal(prepared.latestClinicalDayIso, "2026-04-08");
  assert.equal(metrics.daysWithData, 90);
  assert.equal(metrics.daysWithUsage, 90);
  assert.equal(metrics.compliantDays, 90);
  assertApprox(metrics.avgUsageHours, 8.3844, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 2.2263, 0.02, "avg AHI");
  assertApprox(metrics.avgLeak, 1.6278, 0.02, "avg leak");
  assertApprox(metrics.maxLeak30m, 7.3977, 0.05, "30 min leak");
  assertApprox(metrics.maxLeak60m, 117.4, 0.05, "60 min leak");
});

maybeResventTest("Resvent 60-day report tracks the machine summary conventions", async () => {
  const { metrics } = await loadFixture(RESVENT_ROOT, 60);
  assert.equal(metrics.daysWithData, 60);
  assert.equal(metrics.daysWithUsage, 60);
  assert.equal(metrics.compliantDays, 60);
  assertApprox(metrics.avgUsageHours, 8.5070, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 2.2217, 0.02, "avg AHI");
  assertApprox(metrics.avgResidualApneas, 1.8671, 0.02, "avg residual apneas");
  assertApprox(metrics.avgCentralApneas, 0, 0.001, "avg central apneas");
  assertApprox(metrics.avgReraIndex, 0.3977, 0.02, "avg RERA");
  assertApprox(metrics.avgLeak, 1.2667, 0.02, "avg leak");
  assertApprox(metrics.machine.pressureAvg ?? null, 7.7233, 0.02, "avg pressure");
  assertApprox(metrics.machine.pressure95th ?? null, 8.9933, 0.02, "95th pressure");
  assertApprox(metrics.maxLeak30m, 7.3977, 0.05, "30 min leak");
  assertApprox(metrics.maxLeak60m, 117.4, 0.05, "60 min leak");
});

maybeResventTherapyTest("Resvent THERAPY subfolder import matches root-folder import", async () => {
  const root = await loadFixture(RESVENT_ROOT);
  const therapy = await loadFixture(RESVENT_THERAPY);
  assert.equal(therapy.prepared.selectedLoader, root.prepared.selectedLoader);
  assert.deepEqual(therapy.metrics.machine, root.metrics.machine);
  assert.equal(therapy.metrics.daysWithData, root.metrics.daysWithData);
  assert.equal(therapy.metrics.daysWithUsage, root.metrics.daysWithUsage);
  assertApprox(therapy.metrics.avgAhi, root.metrics.avgAhi as number, 0.0001, "avg AHI");
  assertApprox(therapy.metrics.avgLeak, root.metrics.avgLeak as number, 0.0001, "avg leak");
});

maybeLunaTest("Luna II sample card preserves APAP settings and efficacy metrics", async () => {
  const { prepared, metrics } = await loadFixture(LUNA2_ROOT);
  assert.equal(prepared.selectedLoader, "Apex / BMC / Luna");
  assert.equal(prepared.machine.device, "G2S A20 (ES422A35472)");
  assert.equal(prepared.machine.mode, "APAP");
  assert.equal(prepared.machine.pressureMin, "4 cmH2O");
  assert.equal(prepared.machine.pressureMax, "15 cmH2O");
  assert.equal(prepared.machine.pressureRelief, "Reslex: Off");
  assert.equal(prepared.latestClinicalDayIso, "2026-03-21");
  assert.equal(metrics.daysWithData, 45);
  assert.equal(metrics.daysWithUsage, 43);
  assert.equal(metrics.compliantDays, 32);
  assertApprox(metrics.avgUsageHours, 4.7729, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 1.8784, 0.02, "avg AHI");
  assertApprox(metrics.avgResidualApneas, 0.2650, 0.02, "avg residual apneas");
  assertApprox(metrics.avgCentralApneas, 1.2048, 0.02, "avg central apneas");
  assert.equal(metrics.avgReraIndex, null);
  assertApprox(metrics.avgLeak, 51.0985, 0.1, "avg leak");
  assertApprox(metrics.maxLeak30m, 100, 0.1, "30 min leak");
  assertApprox(metrics.maxLeak60m, 100, 0.1, "60 min leak");
});

maybeDreamstationTest("DreamStation sample card preserves active-root APAP settings and leak metrics", async () => {
  const { prepared, metrics } = await loadFixture(DREAMSTATION_ROOT);
  assert.equal(prepared.selectedLoader, "Philips Respironics System One / DreamStation");
  assert.equal(prepared.machine.mode, "APAP");
  assert.equal(prepared.machine.pressureMin, "10 cmH2O");
  assert.equal(prepared.machine.pressureMax, "16 cmH2O");
  assert.equal(prepared.machine.pressureRelief, "Flex: Off");
  assert.equal(prepared.latestClinicalDayIso, "2026-03-25");
  assert.equal(metrics.daysWithData, 90);
  assert.equal(metrics.daysWithUsage, 90);
  assert.equal(metrics.compliantDays, 90);
  assertApprox(metrics.avgAhi, 0.6972, 0.01, "avg AHI");
  assertApprox(metrics.avgLeak, 27.8245, 0.1, "avg leak");
  assertApprox(metrics.maxLeak30m, 88.2707, 0.1, "30 min leak");
  assertApprox(metrics.maxLeak60m, 88.2707, 0.1, "60 min leak");
});

maybeAirSense11Test("ResMed AirSense 11 public fixture loads with active CPAP profile", async () => {
  const { prepared, metrics } = await loadFixture(RESMED_AIRSENSE11_ROOT);
  assert.equal(prepared.selectedLoader, "ResMed");
  assert.equal(prepared.machine.device, "AirSense 11 AutoSet");
  assert.equal(prepared.machine.mode, "CPAP");
  assert.equal(prepared.machine.pressure, "Fixed 7.2 cmH2O");
  assert.equal(metrics.daysWithData, 76);
  assert.equal(metrics.daysWithUsage, 76);
  assert.equal(metrics.compliantDays, 76);
  assertApprox(metrics.avgUsageHours, 8.9816, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 3.2684, 0.02, "avg AHI");
  assertApprox(metrics.maxLeak30m, 0.88, 0.01, "30 min leak");
  assertApprox(metrics.maxLeak60m, 0.88, 0.01, "60 min leak");
  assert.ok(!metrics.warnings.includes("Leak metrics were not detected from the selected files."));
});

maybeAirCurve10Test("ResMed AirCurve 10 VAuto public fixture loads with bilevel settings", async () => {
  const { prepared, metrics } = await loadFixture(RESMED_AIRCURVE10_ROOT);
  assert.equal(prepared.selectedLoader, "ResMed");
  assert.equal(prepared.machine.device, "AirCurve 10 VAuto");
  assert.equal(prepared.machine.mode, "BiPAP");
  assert.equal(prepared.machine.epap, "11.2 cmH2O");
  assert.equal(prepared.machine.ipap, "13.4 cmH2O");
  assert.equal(prepared.machine.pressureRelief, "PS: 4 cmH2O");
  assert.equal(metrics.daysWithData, 76);
  assert.equal(metrics.daysWithUsage, 76);
  assert.equal(metrics.compliantDays, 76);
  assertApprox(metrics.avgUsageHours, 9.9215, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 2.3, 0.02, "avg AHI");
  assertApprox(metrics.maxLeak30m, 0.68, 0.01, "30 min leak");
  assertApprox(metrics.maxLeak60m, 0.68, 0.01, "60 min leak");
  assert.ok(!metrics.warnings.includes("Leak metrics were not detected from the selected files."));
});

maybeAirBreakTest("ResMed AirBreak AS10 public fixture still resolves a bilevel therapy mode", async () => {
  const { prepared, metrics } = await loadFixture(RESMED_AIRBREAK_AS10_ROOT);
  assert.equal(prepared.selectedLoader, "ResMed");
  assert.equal(prepared.machine.mode, "BiPAP");
  assert.equal(prepared.machine.device, "AirSense 10 AutoSet");
  assert.equal(metrics.daysWithData, 8);
  assert.equal(metrics.daysWithUsage, 8);
  assert.equal(metrics.compliantDays, 8);
  assertApprox(metrics.avgUsageHours, 9.7604, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 0.0125, 0.01, "avg AHI");
  assertApprox(metrics.maxLeak30m, 0.18, 0.01, "30 min leak");
  assertApprox(metrics.maxLeak60m, 0.18, 0.01, "60 min leak");
  assert.ok(!metrics.warnings.includes("Leak metrics were not detected from the selected files."));
});
