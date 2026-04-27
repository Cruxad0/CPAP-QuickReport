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
const LOCAL_RESVENT_BIPAP_ROOT = path.join(process.cwd(), "Card Samples", "Resvent-2");
const RESVENT_THERAPY = path.join(process.cwd(), "Card Samples", "Resvent", "THERAPY");
const LUNA2_ROOT = path.join(process.cwd(), "Card Samples", "Luna2");
const LOCAL_LUNA2_DUPLICATE_ROOT = path.join(process.cwd(), "Card Samples", "Luna2 -2");
const DREAMSTATION_ROOT = path.join(process.cwd(), "Card Samples", "Dreamstation");
const LOCAL_DREAMSTATION_ROOT = path.join(process.cwd(), "Card Samples", "Dreamstation2");
const LOCAL_MIXED_DREAMSTATION_ROOT = path.join(process.cwd(), "Card Samples", "Dreamstation 2 -2");
const RESMED_AIRSENSE11_ROOT = path.join(process.cwd(), "Card Samples", "ResMed", "AirSense", "11", "APAP");
const RESMED_AIRCURVE10_ROOT = path.join(process.cwd(), "Card Samples", "ResMed", "AirCurve", "10", "VAuto");
const RESMED_AIRBREAK_AS10_ROOT = path.join(process.cwd(), "Card Samples", "ResMed", "AirBreak", "AS10", "ASVAuto");
const LOCAL_RESMED_AIRSENSE10_ROOT = path.join(process.cwd(), "Card Samples", "ResMed");
const LOCAL_RESMED_CPAP_ROOT = path.join(process.cwd(), "Card Samples", "ResMed -2");
const LOCAL_RESMED_AIRCURVE10_ROOT = path.join(process.cwd(), "Card Samples", "ResMed -3");

const maybeResventTest = existsSync(RESVENT_ROOT) ? test : test.skip;
const maybeLocalResventBipapTest = existsSync(LOCAL_RESVENT_BIPAP_ROOT) ? test : test.skip;
const maybeResventTherapyTest = existsSync(RESVENT_THERAPY) ? test : test.skip;
const maybeLunaTest = existsSync(LUNA2_ROOT) ? test : test.skip;
const maybeLocalLunaDuplicateTest = existsSync(LOCAL_LUNA2_DUPLICATE_ROOT) ? test : test.skip;
const maybeDreamstationTest = existsSync(DREAMSTATION_ROOT) ? test : test.skip;
const maybeLocalDreamstationTest = existsSync(LOCAL_DREAMSTATION_ROOT) ? test : test.skip;
const maybeLocalMixedDreamstationTest = existsSync(LOCAL_MIXED_DREAMSTATION_ROOT) ? test : test.skip;
const maybeAirSense11Test = existsSync(RESMED_AIRSENSE11_ROOT) ? test : test.skip;
const maybeAirCurve10Test = existsSync(RESMED_AIRCURVE10_ROOT) ? test : test.skip;
const maybeAirBreakTest = existsSync(RESMED_AIRBREAK_AS10_ROOT) ? test : test.skip;
const maybeLocalAirSense10Test = existsSync(LOCAL_RESMED_AIRSENSE10_ROOT) ? test : test.skip;
const maybeLocalResMedCpapTest = existsSync(LOCAL_RESMED_CPAP_ROOT) ? test : test.skip;
const maybeLocalAirCurve10Test = existsSync(LOCAL_RESMED_AIRCURVE10_ROOT) ? test : test.skip;

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
  assertApprox(metrics.avgLeak, 0, 0.02, "median leak");
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
  assertApprox(metrics.avgLeak, 0, 0.02, "median leak");
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

maybeLocalResventBipapTest("local Resvent Auto S30 sample preserves auto-bilevel pressure settings and metrics", async () => {
  const { prepared, metrics } = await loadFixture(LOCAL_RESVENT_BIPAP_ROOT);
  assert.equal(prepared.selectedLoader, "Resvent / Hoffrichter");
  assert.equal(prepared.machine.device, "iBreeze 30STA (GB-2B420607)");
  assert.equal(prepared.machine.mode, "Auto S30");
  assert.equal(prepared.machine.pressureMin, "4 cmH2O");
  assert.equal(prepared.machine.pressureMax, "12 cmH2O");
  assert.equal(prepared.machine.rampTime, "15 minutes");
  assert.equal(prepared.machine.rampPressure, "4 cmH2O");
  assert.equal(prepared.latestClinicalDayIso, "2026-03-23");
  assert.equal(metrics.daysWithData, 75);
  assert.equal(metrics.daysWithUsage, 75);
  assert.equal(metrics.compliantDays, 54);
  assertApprox(metrics.avgUsageHours, 6.5265, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 9.3567, 0.02, "avg AHI");
  assertApprox(metrics.avgResidualApneas, 2.9030, 0.02, "avg residual apneas");
  assertApprox(metrics.avgCentralApneas, 2.7090, 0.02, "avg central apneas");
  assertApprox(metrics.avgReraIndex, 1.0235, 0.02, "avg RERA");
  assertApprox(metrics.machine.pressureAvg ?? null, 5.0760, 0.02, "avg pressure");
  assertApprox(metrics.machine.pressure95th ?? null, 7.92, 0.02, "95th pressure");
  assertApprox(metrics.avgLeak, 18.6467, 0.02, "avg leak");
  assertApprox(metrics.leak95th, 77.62, 0.02, "95th leak");
  assertApprox(metrics.maxLeak30m, 120, 0.02, "30 min leak");
  assertApprox(metrics.maxLeak60m, 120, 0.02, "60 min leak");
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
  assertApprox(metrics.machine.pressureAvg ?? null, 7.3459, 0.02, "avg pressure");
  assertApprox(metrics.machine.pressure95th ?? null, 11.525, 0.02, "95th pressure");
  assertApprox(metrics.avgAhi, 1.8784, 0.02, "avg AHI");
  assertApprox(metrics.avgResidualApneas, 0.2650, 0.02, "avg residual apneas");
  assertApprox(metrics.avgCentralApneas, 1.2048, 0.02, "avg central apneas");
  assert.equal(metrics.avgReraIndex, null);
  assertApprox(metrics.avgLeak, 51.0985, 0.1, "avg leak");
  assertApprox(metrics.leak95th, 79.7591, 0.1, "95th leak");
  assertApprox(metrics.maxLeak30m, 100, 0.1, "30 min leak");
  assertApprox(metrics.maxLeak60m, 100, 0.1, "60 min leak");
});

maybeLocalLunaDuplicateTest("local Luna II duplicate folder matches the primary Luna II sample", async () => {
  const root = await loadFixture(LUNA2_ROOT);
  const duplicate = await loadFixture(LOCAL_LUNA2_DUPLICATE_ROOT);
  assert.equal(duplicate.prepared.selectedLoader, root.prepared.selectedLoader);
  assert.deepEqual(duplicate.metrics.machine, root.metrics.machine);
  assert.equal(duplicate.metrics.daysWithData, root.metrics.daysWithData);
  assert.equal(duplicate.metrics.daysWithUsage, root.metrics.daysWithUsage);
  assert.equal(duplicate.metrics.compliantDays, root.metrics.compliantDays);
  assertApprox(duplicate.metrics.avgUsageHours, root.metrics.avgUsageHours as number, 0.0001, "avg usage");
  assertApprox(duplicate.metrics.avgAhi, root.metrics.avgAhi as number, 0.0001, "avg AHI");
  assertApprox(duplicate.metrics.avgLeak, root.metrics.avgLeak as number, 0.0001, "avg leak");
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

maybeLocalDreamstationTest("local DreamStation sample reports selected-window pressure and leak metrics", async () => {
  const { prepared, metrics } = await loadFixture(LOCAL_DREAMSTATION_ROOT);
  assert.equal(prepared.selectedLoader, "Philips Respironics System One / DreamStation");
  assert.equal(prepared.machine.mode, "APAP");
  assert.equal(prepared.machine.pressureMin, "10 cmH2O");
  assert.equal(prepared.machine.pressureMax, "16 cmH2O");
  assert.equal(prepared.machine.pressureRelief, "Flex: Off");
  assert.equal(prepared.latestClinicalDayIso, "2026-03-25");
  assert.equal(metrics.daysWithData, 90);
  assert.equal(metrics.daysWithUsage, 90);
  assert.equal(metrics.compliantDays, 90);
  assertApprox(metrics.avgUsageHours, 8.6251, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 0.6972, 0.01, "avg AHI");
  assertApprox(metrics.machine.pressureAvg ?? null, 11.3993, 0.02, "avg pressure");
  assertApprox(metrics.machine.pressure95th ?? null, 16, 0.02, "95th pressure");
  assertApprox(metrics.avgLeak, 27.8245, 0.1, "avg leak");
  assertApprox(metrics.leak95th, 33.4024, 0.1, "95th leak");
  assertApprox(metrics.maxLeak30m, 88.2707, 0.1, "30 min leak");
  assertApprox(metrics.maxLeak60m, 88.2707, 0.1, "60 min leak");
});

maybeLocalMixedDreamstationTest("mixed Philips and ResMed folder keeps the importable Philips therapy root", async () => {
  const { prepared, metrics } = await loadFixture(LOCAL_MIXED_DREAMSTATION_ROOT);
  assert.equal(prepared.selectedLoader, "Philips Respironics System One / DreamStation");
  assert.equal(prepared.machine.device, "DreamStation CPAP (J245604722190)");
  assert.equal(prepared.machine.mode, "CPAP");
  assert.equal(prepared.machine.pressure, "15 cmH2O");
  assert.equal(prepared.machine.pressureRelief, "C-Flex: 3");
  assert.equal(prepared.latestClinicalDayIso, "2023-01-04");
  assert.equal(metrics.daysWithData, 90);
  assert.equal(metrics.daysWithUsage, 90);
  assert.equal(metrics.compliantDays, 90);
  assertApprox(metrics.avgUsageHours, 7.0636, 0.02, "avg usage");
  assert.equal(metrics.avgAhi, 0);
  assert.equal(metrics.avgLeak, null);
  assert.ok(metrics.warnings.some((warning) => warning.includes("ResMed (1)")));
});

maybeAirSense11Test("ResMed AirSense 11 public fixture loads with active CPAP profile", async () => {
  const { prepared, metrics } = await loadFixture(RESMED_AIRSENSE11_ROOT);
  assert.equal(prepared.selectedLoader, "ResMed");
  assert.equal(prepared.sourceTimeZoneOffsetMinutes, -480);
  assert.equal(prepared.machine.device, "AirSense 11 AutoSet");
  assert.equal(prepared.machine.mode, "CPAP");
  assert.equal(prepared.machine.pressure, "Fixed 7.2 cmH2O");
  assert.equal(metrics.sourceTimeZoneOffsetMinutes, -480);
  assert.equal(metrics.daysWithData, 76);
  assert.equal(metrics.daysWithUsage, 76);
  assert.equal(metrics.compliantDays, 76);
  assertApprox(metrics.avgUsageHours, 8.9816, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 3.2684, 0.02, "avg AHI");
  assertApprox(metrics.maxLeak30m, 52.8, 0.1, "30 min leak");
  assertApprox(metrics.maxLeak60m, 52.8, 0.1, "60 min leak");
  assert.ok(!metrics.warnings.includes("Leak metrics were not detected from the selected files."));
});

maybeAirCurve10Test("ResMed AirCurve 10 VAuto public fixture loads with bilevel settings", async () => {
  const { prepared, metrics } = await loadFixture(RESMED_AIRCURVE10_ROOT);
  assert.equal(prepared.selectedLoader, "ResMed");
  assert.equal(prepared.machine.device, "AirCurve 10 VAuto");
  assert.equal(prepared.machine.mode, "VAuto");
  assert.equal(prepared.machine.epap, "11.2 cmH2O");
  assert.equal(prepared.machine.ipap, "13.4 cmH2O");
  assert.equal(prepared.machine.pressureMin, "11.2 cmH2O");
  assert.equal(prepared.machine.pressureMax, "13.4 cmH2O");
  assert.equal(prepared.machine.pressureRelief, "PS: 4 cmH2O");
  assert.equal(metrics.daysWithData, 76);
  assert.equal(metrics.daysWithUsage, 76);
  assert.equal(metrics.compliantDays, 76);
  assertApprox(metrics.avgUsageHours, 9.9215, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 2.3, 0.02, "avg AHI");
  assertApprox(metrics.maxLeak30m, 40.8, 0.1, "30 min leak");
  assertApprox(metrics.maxLeak60m, 40.8, 0.1, "60 min leak");
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
  assertApprox(metrics.maxLeak30m, 10.8, 0.1, "30 min leak");
  assertApprox(metrics.maxLeak60m, 10.8, 0.1, "60 min leak");
  assert.ok(!metrics.warnings.includes("Leak metrics were not detected from the selected files."));
});

maybeLocalAirSense10Test("local ResMed AirSense 10 CPAP sample reports selected-window pressure and leak summaries", async () => {
  const { prepared, metrics } = await loadFixture(LOCAL_RESMED_AIRSENSE10_ROOT);
  assert.equal(prepared.selectedLoader, "ResMed");
  assert.equal(prepared.machine.device, "AirSense 10 AutoSet");
  assert.equal(prepared.machine.mode, "CPAP");
  assert.equal(prepared.machine.pressure, "Fixed 6 cmH2O");
  assert.equal(prepared.machine.rampTime, "Off");
  assert.equal(prepared.machine.rampPressure, undefined);
  assert.equal(prepared.latestClinicalDayIso, "2026-04-14");
  assert.equal(metrics.daysWithData, 90);
  assert.equal(metrics.daysWithUsage, 90);
  assert.equal(metrics.compliantDays, 89);
  assertApprox(metrics.avgUsageHours, 7.3459, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 0.75, 0.02, "avg AHI");
  assertApprox(metrics.machine.pressureAvg ?? null, 5.8827, 0.02, "avg pressure");
  assertApprox(metrics.machine.pressure95th ?? null, 6, 0.02, "95th pressure");
  assertApprox(metrics.avgLeak, 1.4933, 0.02, "avg leak");
  assertApprox(metrics.leak95th, 16.8133, 0.02, "95th leak");
  assertApprox(metrics.maxLeak30m, 120, 0.02, "30 min leak");
  assertApprox(metrics.maxLeak60m, 120, 0.02, "60 min leak");
  assert.ok(!metrics.warnings.includes("Leak metrics were not detected from the selected files."));
});

maybeLocalResMedCpapTest("local ResMed CPAP sample treats 95th leak as valid leak evidence", async () => {
  const { prepared, metrics } = await loadFixture(LOCAL_RESMED_CPAP_ROOT);
  assert.equal(prepared.selectedLoader, "ResMed");
  assert.equal(prepared.machine.device, "AirSense 10 CPAP");
  assert.equal(prepared.machine.mode, "CPAP");
  assert.equal(prepared.machine.pressure, "Fixed 9 cmH2O");
  assert.equal(prepared.machine.rampTime, "Off");
  assert.equal(prepared.latestClinicalDayIso, "2026-04-19");
  assert.equal(metrics.daysWithData, 90);
  assert.equal(metrics.daysWithUsage, 90);
  assert.equal(metrics.compliantDays, 87);
  assertApprox(metrics.avgUsageHours, 8.6106, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 1.0778, 0.02, "avg AHI");
  assertApprox(metrics.machine.pressureAvg ?? null, 8.88, 0.02, "avg pressure");
  assertApprox(metrics.machine.pressure95th ?? null, 8.88, 0.02, "95th pressure");
  assert.equal(metrics.avgLeak, null);
  assertApprox(metrics.leak95th, 28.7067, 0.02, "95th leak");
  assert.ok(!metrics.warnings.includes("Leak metrics were not detected from the selected files."));
});

maybeLocalAirCurve10Test("local ResMed AirCurve 10 VAuto sample reports BiPAP settings and L/min leak values", async () => {
  const { prepared, metrics } = await loadFixture(LOCAL_RESMED_AIRCURVE10_ROOT);
  assert.equal(prepared.selectedLoader, "ResMed");
  assert.equal(prepared.machine.device, "AirCurve 10 VAuto");
  assert.equal(prepared.machine.mode, "VAuto");
  assert.equal(prepared.machine.epap, "7 cmH2O");
  assert.equal(prepared.machine.ipap, "11 cmH2O");
  assert.equal(prepared.machine.pressureMin, "7 cmH2O");
  assert.equal(prepared.machine.pressureMax, "11 cmH2O");
  assert.equal(prepared.machine.rampTime, "30 minutes");
  assert.equal(prepared.machine.rampPressure, "7 cmH2O");
  assert.equal(prepared.machine.pressureRelief, "PS: 0 cmH2O");
  assert.equal(metrics.daysWithData, 14);
  assert.equal(metrics.daysWithUsage, 14);
  assert.equal(metrics.compliantDays, 5);
  assertApprox(metrics.avgUsageHours, 3.3774, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 18.0571, 0.02, "avg AHI");
  assertApprox(metrics.machine.pressureAvg ?? null, 8.9914, 0.02, "avg pressure");
  assertApprox(metrics.machine.pressure95th ?? null, 10.92, 0.02, "95th pressure");
  assertApprox(metrics.avgLeak, 6.9429, 0.02, "avg leak");
  assertApprox(metrics.leak95th, 18, 0.02, "95th leak");
  assertApprox(metrics.maxLeak30m, 54, 0.02, "30 min leak");
  assertApprox(metrics.maxLeak60m, 54, 0.02, "60 min leak");
});
