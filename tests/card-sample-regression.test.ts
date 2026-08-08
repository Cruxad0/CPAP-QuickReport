import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildQuickReportMetricsFromPreparedSource, prepareQuickReportSource } from "../lib/parser";
import { leakMetricRows } from "../lib/pdf";
import { buildReportArtifactsFromPreparedSource } from "../lib/report-orchestrator";
import {
  filterSourceFilesToRecentWindow,
  IMPORT_LOOKBACK_DAYS,
  OLDER_HISTORY_IMPORT_LOOKBACK_DAYS
} from "../lib/source-files";
import type { PreparedQuickReportSource } from "../lib/types";
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

async function loadFilteredFixture(root: string, lookbackDays = 90) {
  const files = await createSourceFilesFromDirectory(root);
  const filtered = filterSourceFilesToRecentWindow(files, IMPORT_LOOKBACK_DAYS);
  const prepared = await prepareQuickReportSource({
    sourceKind: "folder",
    files: filtered.files,
    lookbackDays
  });
  const metrics = buildQuickReportMetricsFromPreparedSource(prepared, {
    patientName: "Fixture Patient",
    dateOfBirthIso: "1970-01-01",
    physicianName: "",
    lookbackDays,
    windowEndClinicalDayIso: nextClinicalDayIso(prepared.latestClinicalDayIso)
  });
  return { filtered, prepared, metrics };
}

async function loadBoundedTherapyHistoryFixture(root: string) {
  const files = await createSourceFilesFromDirectory(root);
  const filtered = filterSourceFilesToRecentWindow(files, OLDER_HISTORY_IMPORT_LOOKBACK_DAYS);
  const prepared = await prepareQuickReportSource({
    sourceKind: "folder",
    files: filtered.files,
    lookbackDays: OLDER_HISTORY_IMPORT_LOOKBACK_DAYS
  });
  return { filtered, prepared };
}

async function assertGeneratesSevenDayReport(prepared: PreparedQuickReportSource) {
  const result = await buildReportArtifactsFromPreparedSource({
    prepared,
    patientName: "Fixture Patient",
    dateOfBirthIso: "1970-01-01",
    physicianName: "",
    reportRanges: [7]
  });

  assert.equal(result.reports.length, 1, "expected the card data to generate a 7-day report");
  assert.equal(result.largestAvailableRange, 7);
  assert.ok(result.reports[0].blob.size > 0, "generated PDF should not be empty");
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
const LOCAL_LUNA2_REAL_ROOT = path.join(process.cwd(), "Card Samples", "Luna2 -1");
const LOCAL_LUNA2_SHORT_ROOT = path.join(process.cwd(), "Card Samples", "Luna 2 -3");
const LOCAL_LUNA2_FOUR_ROOT = path.join(process.cwd(), "Card Samples", "Luna 2 - 4");
const DREAMSTATION_ROOT = path.join(process.cwd(), "Card Samples", "Dreamstation");
const LOCAL_DREAMSTATION_ROOT = path.join(process.cwd(), "Card Samples", "Dreamstation2");
const LOCAL_MIXED_DREAMSTATION_ROOT = path.join(process.cwd(), "Card Samples", "Dreamstation 2 -2");
const LOCAL_REMSTAR_SE_ROOT = path.join(process.cwd(), "Card Samples", "REMstar SE");
const RESMED_AIRSENSE11_ROOT = path.join(process.cwd(), "Card Samples", "ResMed", "AirSense", "11", "APAP");
const RESMED_AIRCURVE10_ROOT = path.join(process.cwd(), "Card Samples", "ResMed", "AirCurve", "10", "VAuto");
const RESMED_AIRBREAK_AS10_ROOT = path.join(process.cwd(), "Card Samples", "ResMed", "AirBreak", "AS10", "ASVAuto");
const LOCAL_RESMED_AIRSENSE10_ROOT = path.join(process.cwd(), "Card Samples", "ResMed");
const LOCAL_RESMED_CPAP_ROOT = path.join(process.cwd(), "Card Samples", "ResMed -2");
const LOCAL_RESMED_AIRCURVE10_ROOT = path.join(process.cwd(), "Card Samples", "ResMed -3");
const LOCAL_RESMED_AIRCURVE10_ST_ROOT = path.join(process.cwd(), "Card Samples", "ResMed -4");
const LOCAL_RESMED_AIRSENSE10_SHORT_ROOT = path.join(process.cwd(), "Card Samples", "Airsense 10");
const LOCAL_RESMED_AIRSENSE10_THIRD_ROOT = path.join(process.cwd(), "Card Samples", "Airsense 10 - 3");
const LOCAL_RESMED_AIRSENSE11_CPAP_ROOT = path.join(process.cwd(), "Card Samples", "Airsense 11 CPAP2");

const maybeResventTest = existsSync(RESVENT_ROOT) ? test : test.skip;
const maybeLocalResventBipapTest = existsSync(LOCAL_RESVENT_BIPAP_ROOT) ? test : test.skip;
const maybeResventTherapyTest = existsSync(RESVENT_THERAPY) ? test : test.skip;
const maybeLunaTest = existsSync(LUNA2_ROOT) ? test : test.skip;
const maybeLocalLunaDuplicateTest = existsSync(LUNA2_ROOT) && existsSync(LOCAL_LUNA2_DUPLICATE_ROOT) ? test : test.skip;
const maybeLocalLunaRealTest = existsSync(LOCAL_LUNA2_REAL_ROOT) ? test : test.skip;
const maybeLocalLunaShortTest = existsSync(LOCAL_LUNA2_SHORT_ROOT) ? test : test.skip;
const maybeLocalLunaFourTest = existsSync(LOCAL_LUNA2_FOUR_ROOT) ? test : test.skip;
const maybeDreamstationTest = existsSync(DREAMSTATION_ROOT) ? test : test.skip;
const maybeLocalDreamstationTest = existsSync(LOCAL_DREAMSTATION_ROOT) ? test : test.skip;
const maybeLocalMixedDreamstationTest = existsSync(LOCAL_MIXED_DREAMSTATION_ROOT) ? test : test.skip;
const maybeLocalRemstarSeTest = existsSync(LOCAL_REMSTAR_SE_ROOT) ? test : test.skip;
const maybeAirSense11Test = existsSync(RESMED_AIRSENSE11_ROOT) ? test : test.skip;
const maybeAirCurve10Test = existsSync(RESMED_AIRCURVE10_ROOT) ? test : test.skip;
const maybeAirBreakTest = existsSync(RESMED_AIRBREAK_AS10_ROOT) ? test : test.skip;
const maybeLocalAirSense10Test = existsSync(LOCAL_RESMED_AIRSENSE10_ROOT) ? test : test.skip;
const maybeLocalResMedCpapTest = existsSync(LOCAL_RESMED_CPAP_ROOT) ? test : test.skip;
const maybeLocalAirCurve10Test = existsSync(LOCAL_RESMED_AIRCURVE10_ROOT) ? test : test.skip;
const maybeLocalAirCurve10StTest = existsSync(LOCAL_RESMED_AIRCURVE10_ST_ROOT) ? test : test.skip;
const maybeLocalAirSense10ShortTest = existsSync(LOCAL_RESMED_AIRSENSE10_SHORT_ROOT) ? test : test.skip;
const maybeLocalAirSense10ThirdTest = existsSync(LOCAL_RESMED_AIRSENSE10_THIRD_ROOT) ? test : test.skip;
const maybeLocalAirSense11CpapTest = existsSync(LOCAL_RESMED_AIRSENSE11_CPAP_ROOT) ? test : test.skip;

maybeResventTest("Resvent sample card preserves APAP config and metrics", async () => {
  const { prepared, metrics } = await loadFixture(RESVENT_ROOT);
  assert.equal(prepared.selectedLoader, "Resvent / Hoffrichter");
  assert.equal(prepared.machine.device, "iBreeze 20A (GB-2B496636)");
  assert.equal(prepared.machine.mode, "APAP");
  assert.equal(prepared.machine.pressureMin, "8.5 cmH2O");
  assert.equal(prepared.machine.pressureMax, "11 cmH2O");
  assert.equal(prepared.machine.pressureRelief, "IPR: On 1");
  assert.equal(prepared.latestClinicalDayIso, "2026-04-08");
  assert.equal(metrics.dateRangeStart, "March 22, 2026");
  assert.equal(metrics.daysWithData, 18);
  assert.equal(metrics.daysWithUsage, 18);
  assert.equal(metrics.compliantDays, 17);
  assert.equal(metrics.sleepTimingAnalysis?.method, "inferred-session-timing");
  assert.equal(metrics.sleepTimingAnalysis?.anchorMinutes, 901);
  assertApprox(metrics.totalTherapyHours ?? null, 156.662, 0.02, "total therapy");
  assertApprox(metrics.expectedSleepTherapyHours ?? null, 137.737, 0.02, "expected sleep therapy");
  assertApprox(metrics.suspectedNapTherapyHours ?? null, 18.925, 0.02, "suspected nap therapy");
  assertApprox(metrics.avgUsageHours, 8.7034, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 2.0682, 0.02, "avg AHI");
  assertApprox(metrics.avgLeak, 0, 0.02, "median leak");
  assertApprox(metrics.maxLeak30m, 7.3977, 0.05, "30 min leak");
  assertApprox(metrics.maxLeak60m, 117.4, 0.05, "60 min leak");
  assert.ok(metrics.warnings.some((warning) => warning.includes("Therapy settings changed within the 90-day report window")));
});

maybeResventTest("Resvent 60-day report tracks the machine summary conventions", async () => {
  const { metrics } = await loadFixture(RESVENT_ROOT, 60);
  assert.equal(metrics.dateRangeStart, "March 22, 2026");
  assert.equal(metrics.daysWithData, 18);
  assert.equal(metrics.daysWithUsage, 18);
  assert.equal(metrics.compliantDays, 17);
  assertApprox(metrics.avgUsageHours, 8.7034, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 2.0682, 0.02, "avg AHI");
  assertApprox(metrics.avgResidualApneas, 1.6979, 0.02, "avg residual apneas");
  assertApprox(metrics.avgCentralApneas, 0, 0.001, "avg central apneas");
  assertApprox(metrics.avgReraIndex, 0.4532, 0.02, "avg RERA");
  assertApprox(metrics.avgLeak, 0, 0.02, "median leak");
  assertApprox(metrics.machine.pressureAvg ?? null, 8.0111, 0.02, "avg pressure");
  assertApprox(metrics.machine.pressure95th ?? null, 9.6778, 0.02, "95th pressure");
  assertApprox(metrics.maxLeak30m, 7.3977, 0.05, "30 min leak");
  assertApprox(metrics.maxLeak60m, 117.4, 0.05, "60 min leak");
  assert.ok(metrics.warnings.some((warning) => warning.includes("Therapy settings changed within the 60-day report window")));
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
  assert.equal(metrics.compliantDays, 53);
  assert.equal(metrics.sleepTimingAnalysis?.method, "inferred-session-timing");
  assert.equal(metrics.sleepTimingAnalysis?.anchorMinutes, 807);
  assertApprox(metrics.expectedSleepTherapyHours ?? null, 461.219, 0.02, "expected sleep therapy");
  assertApprox(metrics.suspectedNapTherapyHours ?? null, 28.268, 0.02, "suspected nap therapy");
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
  assertApprox(metrics.machine.pressureAvg ?? null, 7.4401, 0.02, "avg pressure");
  assertApprox(metrics.machine.pressure95th ?? null, 11.3, 0.02, "95th pressure");
  assertApprox(metrics.avgAhi, 1.8784, 0.02, "avg AHI");
  assertApprox(metrics.avgResidualApneas, 0.2650, 0.02, "avg residual apneas");
  assertApprox(metrics.avgCentralApneas, 1.2048, 0.02, "avg central apneas");
  assert.equal(metrics.avgReraIndex, null);
  assertApprox(metrics.avgLeak, 50.1807, 0.1, "avg leak");
  assertApprox(metrics.leak95th, 79.0145, 0.1, "95th leak");
  assertApprox(metrics.maxLeak30m, 100, 0.1, "30 min leak");
  assertApprox(metrics.maxLeak60m, 100, 0.1, "60 min leak");
  await assertGeneratesSevenDayReport(prepared);
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

maybeLocalLunaRealTest("legacy Luna II uses the safe daily-total fallback when exact mask-on intervals are unavailable", async () => {
  const { prepared, metrics } = await loadFixture(LOCAL_LUNA2_REAL_ROOT);
  assert.equal(prepared.selectedLoader, "Apex / BMC / Luna");
  assert.equal(prepared.therapySessions?.length ?? 0, 0);
  assert.equal(prepared.sleepTimingProfile, null);
  assert.equal(metrics.compliantDays, 32);
  assert.equal(metrics.sleepTimingAnalysis, null);
  assert.equal(metrics.expectedSleepTherapyHours, null);
  assert.equal(metrics.suspectedNapTherapyHours, null);
  assert.ok(metrics.warnings.some((warning) => warning.includes("4+ usage uses device-reported daily totals")));
});

maybeLocalLunaShortTest("short Luna II card still generates an adjusted 7-day report", async () => {
  const { prepared, metrics } = await loadFilteredFixture(LOCAL_LUNA2_SHORT_ROOT);
  assert.equal(prepared.selectedLoader, "Apex / BMC / Luna");
  assert.equal(prepared.machine.device, "G2S A20 (ES422A33105)");
  assert.equal(prepared.machine.mode, "APAP");
  assert.equal(prepared.machine.pressureMin, "7 cmH2O");
  assert.equal(prepared.machine.pressureMax, "20 cmH2O");
  assert.equal(prepared.latestClinicalDayIso, "2026-03-24");
  assert.equal(metrics.daysInWindow, 6);
  assert.equal(metrics.daysWithData, 2);
  assert.equal(metrics.daysWithUsage, 2);
  assert.equal(metrics.compliantDays, 0);
  assertApprox(metrics.avgUsageHours, 0.025, 0.001, "avg usage");

  const result = await buildReportArtifactsFromPreparedSource({
    prepared,
    patientName: "Fixture Patient",
    dateOfBirthIso: "1970-01-01",
    physicianName: ""
  });
  assert.deepEqual(result.reports.map((report) => report.days), [7]);
  assert.equal(result.reports[0].metrics.daysInWindow, 6);
  assert.ok(result.reports[0].blob.size > 0);
});

maybeLocalLunaFourTest("Luna 2 - 4 short card loads all available BMC bundle data", async () => {
  const { prepared, metrics } = await loadFixture(LOCAL_LUNA2_FOUR_ROOT);
  assert.equal(prepared.selectedLoader, "Apex / BMC / Luna");
  assert.deepEqual(Object.keys(prepared.dayBuckets).sort(), ["2026-03-19", "2026-03-24"]);
  assert.equal(prepared.machine.device, "G2S A20 (ES422A33105)");
  assert.equal(prepared.machine.mode, "APAP");
  assert.equal(prepared.machine.pressureMin, "7 cmH2O");
  assert.equal(prepared.machine.pressureMax, "20 cmH2O");
  assert.equal(prepared.machine.rampTime, "10 minutes");
  assert.equal(prepared.machine.rampPressure, "4 cmH2O");
  assert.equal(prepared.latestClinicalDayIso, "2026-03-24");
  assert.equal(metrics.daysInWindow, 6);
  assert.equal(metrics.daysWithData, 2);
  assert.equal(metrics.daysWithUsage, 2);
  assert.equal(metrics.compliantDays, 0);
  assertApprox(metrics.avgUsageHours, 0.025, 0.001, "avg usage");
  assert.equal(metrics.avgAhi, 0);
  assert.equal(metrics.ahi95th, 0);
  assert.equal(metrics.avgResidualApneas, 0);
  assert.equal(metrics.residualApneas95th, 0);
  assert.equal(metrics.avgCentralApneas, 0);
  assert.equal(metrics.centralApneas95th, 0);
  assert.equal(metrics.avgReraIndex, null);
  assert.equal(metrics.rera95th, null);
  assertApprox(metrics.avgLeak, 70.2671, 0.1, "avg leak");
  assertApprox(metrics.leak95th, 84.8896, 0.1, "95th leak");
  assertApprox(metrics.maxLeak30m, 100, 0.1, "30 min leak");
  assertApprox(metrics.maxLeak60m, 100, 0.1, "60 min leak");
  assertApprox(metrics.machine.pressureAvg ?? null, 4.4539, 0.02, "avg pressure");
  assertApprox(metrics.machine.pressure95th ?? null, 5.9, 0.02, "95th pressure");
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
  assert.equal(metrics.sleepTimingAnalysis?.method, "inferred-session-timing");
  assert.equal(metrics.sleepTimingAnalysis?.anchorMinutes, 264);
  assert.ok((metrics.sleepTimingAnalysis?.timingCoveragePercent ?? 0) > 99.9);
  assertApprox(metrics.expectedSleepTherapyHours ?? null, 771.02, 0.02, "expected sleep therapy");
  assertApprox(metrics.suspectedNapTherapyHours ?? null, 5.235, 0.02, "suspected nap therapy");
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
  assert.equal(metrics.sleepTimingAnalysis?.method, "inferred-session-timing");
  assert.equal(metrics.sleepTimingAnalysis?.anchorMinutes, 264);
  assert.ok((metrics.sleepTimingAnalysis?.timingCoveragePercent ?? 0) > 99.9);
  assertApprox(metrics.expectedSleepTherapyHours ?? null, 771.02, 0.02, "expected sleep therapy");
  assertApprox(metrics.suspectedNapTherapyHours ?? null, 5.235, 0.02, "suspected nap therapy");
  assertApprox(metrics.avgUsageHours, 8.6251, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 3.1734, 0.02, "avg AHI");
  assertApprox(metrics.machine.pressureAvg ?? null, 11.4159, 0.02, "avg pressure");
  assertApprox(metrics.machine.pressure95th ?? null, 16, 0.02, "95th pressure");
  assertApprox(metrics.avgLeak, 28.4081, 0.1, "avg leak");
  assertApprox(metrics.leak95th, 36.2002, 0.1, "95th leak");
  assertApprox(metrics.maxLeak30m, 88.2707, 0.1, "30 min leak");
  assertApprox(metrics.maxLeak60m, 88.2707, 0.1, "60 min leak");
  assertApprox(metrics.maxLeakMinutes ?? null, 1.9810, 0.01, "max leak minutes");
  assertApprox(metrics.sustainedLeakMax ?? null, 71.2707, 0.1, "sustained leak max");
  assertApprox(metrics.sustainedLeakMinutes ?? null, 240.7715, 0.1, "sustained leak minutes");
  assert.deepEqual(leakMetricRows(metrics), [
    ["Avg Leak", "28.4 L/min"],
    ["95th Leak", "36.2 L/min", true],
    ["Longest Sustained Leak", "71.3 L/min for 240.8 min", true],
    ["Max Leak", "88.3 L/min for 2.0 min", true]
  ]);

  const sevenDayMetrics = buildQuickReportMetricsFromPreparedSource(prepared, {
    patientName: "Fixture Patient",
    dateOfBirthIso: "1970-01-01",
    physicianName: "",
    lookbackDays: 7,
    windowEndClinicalDayIso: nextClinicalDayIso(prepared.latestClinicalDayIso)
  });
  assert.equal(sevenDayMetrics.sleepTimingAnalysis?.method, "inferred-session-timing");
  assert.equal(sevenDayMetrics.sleepTimingAnalysis?.timingCoveragePercent, 100);
  assert.equal(sevenDayMetrics.compliantDays, 7);
  assertApprox(sevenDayMetrics.totalTherapyHours ?? null, 64.874, 0.02, "7-day total usage");
  assertApprox(sevenDayMetrics.expectedSleepTherapyHours ?? null, 64.874, 0.02, "7-day expected sleep therapy");
  assert.ok(!sevenDayMetrics.warnings.some((warning) => warning.includes("Session intervals exceeded")));
});

maybeLocalMixedDreamstationTest("DreamStation folder follows LAST.TXT to the active Philips therapy root", async () => {
  const { prepared, metrics } = await loadFixture(LOCAL_MIXED_DREAMSTATION_ROOT);
  assert.equal(prepared.selectedLoader, "Philips Respironics System One / DreamStation");
  assert.equal(prepared.machine.device, "Philips Respironics (74FAE00C)");
  assert.equal(prepared.machine.mode, "CPAP");
  assert.equal(prepared.machine.pressure, "15 cmH2O");
  assert.equal(prepared.machine.pressureRelief, "C-Flex+: 2");
  assert.equal(prepared.latestClinicalDayIso, "2026-04-19");
  assert.equal(metrics.daysWithData, 90);
  assert.equal(metrics.daysWithUsage, 90);
  assert.equal(metrics.compliantDays, 62);
  assert.equal(metrics.sleepTimingAnalysis?.method, "inferred-session-timing");
  assert.ok((metrics.suspectedNapTherapyHours ?? 0) > 3);
  assertApprox(metrics.avgUsageHours, 4.6313, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 0.2292, 0.02, "avg AHI");
  assertApprox(metrics.avgLeak, 29.2406, 0.1, "avg leak");
  assertApprox(metrics.leak95th, 52.5013, 0.1, "95th leak");
  assertApprox(metrics.maxLeak30m, 128.4689, 0.1, "30 min leak");
  assertApprox(metrics.maxLeak60m, 128.4689, 0.1, "60 min leak");

  const sevenDayMetrics = buildQuickReportMetricsFromPreparedSource(prepared, {
    patientName: "Fixture Patient",
    dateOfBirthIso: "1970-01-01",
    physicianName: "",
    lookbackDays: 7,
    windowEndClinicalDayIso: nextClinicalDayIso(prepared.latestClinicalDayIso)
  });
  assert.equal(sevenDayMetrics.sleepTimingAnalysis?.method, "inferred-session-timing");
  assert.equal(sevenDayMetrics.sleepTimingAnalysis?.timingCoveragePercent, 100);
  assert.equal(sevenDayMetrics.compliantDays, 6);
  assertApprox(sevenDayMetrics.totalTherapyHours ?? null, 40.094, 0.02, "7-day total usage");
  assertApprox(sevenDayMetrics.expectedSleepTherapyHours ?? null, 40.085, 0.02, "7-day expected sleep therapy");
  assertApprox(sevenDayMetrics.suspectedNapTherapyHours ?? null, 0.009, 0.02, "7-day suspected nap therapy");
  assert.ok(!sevenDayMetrics.warnings.some((warning) => warning.includes("Session intervals exceeded")));
});

maybeLocalRemstarSeTest("REMstar SE P-Series sample parses as PRS1 CPAP history", async () => {
  const { prepared, metrics } = await loadFixture(LOCAL_REMSTAR_SE_ROOT);
  assert.equal(prepared.selectedLoader, "Philips Respironics System One / DreamStation");
  assert.equal(prepared.machine.device, "REMstar SE (P15163264B067)");
  assert.equal(prepared.machine.mode, "CPAP");
  assert.equal(prepared.machine.pressure, "11 cmH2O");
  assert.equal(prepared.machine.pressureRelief, "Flex: 3");
  assert.equal(prepared.latestClinicalDayIso, "2020-03-18");
  assert.equal(metrics.daysWithData, 25);
  assert.equal(metrics.daysWithUsage, 25);
  assert.equal(metrics.compliantDays, 0);
  assertApprox(metrics.avgUsageHours, 0.2885, 0.001, "avg usage");
  assert.equal(metrics.avgAhi, null);
  assert.equal(metrics.ahi95th, null);
  assert.equal(metrics.avgResidualApneas, null);
  assert.equal(metrics.residualApneas95th, null);
  assert.equal(metrics.avgCentralApneas, null);
  assert.equal(metrics.centralApneas95th, null);
  assert.equal(metrics.avgReraIndex, null);
  assert.equal(metrics.rera95th, null);
  assert.equal(metrics.avgLeak, null);
  assert.equal(metrics.leak95th, null);
  assert.equal(metrics.maxLeak, null);
  assert.equal(metrics.maxLeak30m, null);
  assert.equal(metrics.maxLeak60m, null);
  assert.deepEqual(leakMetricRows(metrics), [
    ["Avg Leak", "Data point not available"],
    ["95th Leak", "Data point not available"],
    ["Longest Sustained Leak", "Data point not available"],
    ["Max Leak", "Data point not available"]
  ]);
  assert.ok(metrics.warnings.includes("AHI metrics were not detected from the selected files."));
  assert.ok(metrics.warnings.includes("Leak metrics were not detected from the selected files."));
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
  await assertGeneratesSevenDayReport(prepared);
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
  assert.equal(metrics.sleepTimingAnalysis?.method, "inferred-session-timing");
  assert.equal(metrics.sleepTimingAnalysis?.anchorMinutes, 1344);
  assert.ok((metrics.sleepTimingAnalysis?.timingCoveragePercent ?? 0) > 99);
  assertApprox(metrics.totalTherapyHours ?? null, 661.133, 0.02, "total therapy");
  assertApprox(metrics.unclassifiedTherapyHours ?? null, 2.033, 0.02, "unclassified therapy timing");
  assertApprox(metrics.avgUsageHours, 7.3459, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 0.75, 0.02, "avg AHI");
  assertApprox(metrics.avgReraIndex, 0.8074, 0.02, "avg RERA index");
  assertApprox(metrics.rera95th, 1.9356, 0.02, "95th RERA index");
  assertApprox(metrics.machine.pressureAvg ?? null, 5.8827, 0.02, "avg pressure");
  assertApprox(metrics.machine.pressure95th ?? null, 6, 0.02, "95th pressure");
  assertApprox(metrics.avgLeak, 1.4933, 0.02, "avg leak");
  assertApprox(metrics.leak95th, 16.8133, 0.02, "95th leak");
  assertApprox(metrics.maxLeak30m, 120, 0.02, "30 min leak");
  assertApprox(metrics.maxLeak60m, 120, 0.02, "60 min leak");
  assert.ok(!metrics.warnings.includes("Leak metrics were not detected from the selected files."));
});

maybeLocalAirSense10ShortTest("filtered AirSense 10 summary coverage generates all compliance report ranges", async () => {
  const { prepared, metrics } = await loadFilteredFixture(LOCAL_RESMED_AIRSENSE10_SHORT_ROOT);
  assert.equal(prepared.selectedLoader, "ResMed");
  assert.equal(prepared.machine.device, "AirSense 10 AutoSet");
  assert.equal(prepared.machine.mode, "CPAP");
  assert.equal(prepared.machine.pressure, "Fixed 8 cmH2O");
  assert.equal(prepared.historyStartClinicalDayIso, "2025-06-01");
  assert.equal(prepared.latestClinicalDayIso, "2026-06-01");
  assert.equal(metrics.daysInWindow, 90);
  assert.equal(metrics.daysWithData, 2);
  assert.equal(metrics.daysWithUsage, 2);
  assert.equal(metrics.compliantDays, 0);

  const result = await buildReportArtifactsFromPreparedSource({
    prepared,
    patientName: "Fixture Patient",
    dateOfBirthIso: "1970-01-01",
    physicianName: ""
  });
  assert.deepEqual(result.reports.map((report) => report.days), [90, 60, 30, 7]);
  assert.ok(result.reports.every((report) => report.blob.size > 0));
});

maybeLocalAirSense10ThirdTest("Airsense 10 - 3 filtered import keeps recent ResMed data and settings", async () => {
  const { filtered, prepared, metrics } = await loadFilteredFixture(LOCAL_RESMED_AIRSENSE10_THIRD_ROOT);
  assert.equal(filtered.originalCount, 681);
  assert.equal(filtered.files.length, 298);
  assert.equal(filtered.latestDateIso, "2026-06-01");
  assert.equal(filtered.hasOlderDatedData, true);
  assert.equal(prepared.selectedLoader, "ResMed");
  assert.deepEqual(Object.keys(prepared.dayBuckets).sort(), ["2026-05-31", "2026-06-01"]);
  assert.equal(prepared.machine.device, "AirSense 10 AutoSet");
  assert.equal(prepared.machine.mode, "CPAP");
  assert.equal(prepared.machine.pressure, "Fixed 8 cmH2O");
  assert.equal(prepared.machine.rampTime, "Off");
  assert.equal(prepared.machine.pressureRelief, "EPR: On 3");
  assert.equal(prepared.historyStartClinicalDayIso, "2025-06-01");
  assert.equal(prepared.latestClinicalDayIso, "2026-06-01");
  assert.equal(metrics.daysInWindow, 90);
  assert.equal(metrics.daysWithData, 2);
  assert.equal(metrics.daysWithUsage, 2);
  assert.equal(metrics.compliantDays, 0);
  assertApprox(metrics.avgUsageHours, 0.2583, 0.001, "avg usage");
  assertApprox(metrics.avgAhi, 1.4, 0.01, "avg AHI");
  assertApprox(metrics.avgLeak, 23.4, 0.1, "avg leak");
  assertApprox(metrics.leak95th, 54.6, 0.1, "95th leak");
  assertApprox(metrics.maxLeak30m, 80.4, 0.1, "30 min leak");
  assertApprox(metrics.maxLeak60m, 80.4, 0.1, "60 min leak");
  assertApprox(metrics.machine.pressureAvg ?? null, 4.68, 0.02, "avg pressure");
  assertApprox(metrics.machine.pressure95th ?? null, 5.712, 0.02, "95th pressure");
});

maybeLocalAirSense10ShortTest("older dated files without a settings change do not offer previous therapy", async () => {
  const { filtered, prepared } = await loadBoundedTherapyHistoryFixture(LOCAL_RESMED_AIRSENSE10_SHORT_ROOT);

  assert.equal(filtered.hasOlderDatedData, true);
  assert.equal(prepared.therapySettingsPeriods?.some((period) => period.kind === "previous" && period.machine), false);
});

maybeLocalAirSense11CpapTest("filtered AirSense 11 CPAP card preserves its recent pressure change and report", async () => {
  const { prepared, metrics } = await loadFilteredFixture(LOCAL_RESMED_AIRSENSE11_CPAP_ROOT);
  assert.equal(prepared.selectedLoader, "ResMed");
  assert.equal(prepared.machine.device, "AirSense 11 CPAP");
  assert.equal(prepared.machine.mode, "CPAP");
  assert.equal(prepared.machine.pressure, "Fixed 11 cmH2O");
  assert.equal(prepared.sourceTimeZoneOffsetMinutes, -300);
  assert.equal(prepared.historyStartClinicalDayIso, "2025-04-05");
  assert.equal(prepared.latestClinicalDayIso, "2026-06-07");
  assert.equal(metrics.daysInWindow, 7);
  assert.equal(metrics.daysWithData, 7);
  assert.equal(metrics.daysWithUsage, 7);
  assertApprox(metrics.avgResidualApneas, 0.0458, 0.001, "avg residual apneas");
  assertApprox(metrics.residualApneas95th, 0.1621, 0.001, "95th residual apneas");
  assert.equal(metrics.avgCentralApneas, null);
  assert.equal(metrics.centralApneas95th, null);
  assert.ok(
    prepared.warnings.some(
      (warning) =>
        warning ===
        "Therapy settings changed during the imported 90-day history. Reports use the latest settings period: CPAP 11 cmH2O since June 1, 2026."
    )
  );
  assert.ok(metrics.warnings.some((warning) => warning.includes("CPAP 11 cmH2O from June 1, 2026 forward")));

  const result = await buildReportArtifactsFromPreparedSource({
    prepared,
    patientName: "Fixture Patient",
    dateOfBirthIso: "1970-01-01",
    physicianName: ""
  });
  assert.deepEqual(result.reports.map((report) => report.days), [7]);
  assert.ok(result.reports[0].blob.size > 0);
});

maybeLocalAirSense11CpapTest("bounded history offers only a detected previous settings generation", async () => {
  const { prepared } = await loadBoundedTherapyHistoryFixture(LOCAL_RESMED_AIRSENSE11_CPAP_ROOT);
  const previous = prepared.therapySettingsPeriods?.find((period) => period.kind === "previous" && period.machine);

  assert.equal(previous?.label, "CPAP 10 cmH2O");
  assert.ok(previous && previous.daysWithData > 0 && previous.daysWithData <= 90);
  assert.equal(prepared.therapySettingsPeriods?.find((period) => period.kind === "current")?.label, "CPAP 11 cmH2O");
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
  assertApprox(metrics.avgUsageHours, 3.3071, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 18.0571, 0.02, "avg AHI");
  assertApprox(metrics.machine.pressureAvg ?? null, 9.6831, 0.02, "avg pressure");
  assertApprox(metrics.machine.pressure95th ?? null, 10.92, 0.02, "95th pressure");
  assertApprox(metrics.machine.ipapAvg ?? null, 9.7015, 0.02, "avg IPAP");
  assertApprox(metrics.machine.ipap95th ?? null, 10.92, 0.02, "95th IPAP");
  assertApprox(metrics.machine.epapAvg ?? null, 9.7015, 0.02, "avg EPAP");
  assertApprox(metrics.machine.epap95th ?? null, 10.92, 0.02, "95th EPAP");
  assertApprox(metrics.machine.tidalVolumeMin ?? null, 0.02, 0.02, "min tidal volume");
  assertApprox(metrics.machine.tidalVolumeMinMinutes ?? null, 1.6667, 0.02, "min tidal volume minutes");
  assertApprox(metrics.machine.tidalVolumeMedian ?? null, 0.44, 0.02, "median tidal volume");
  assertApprox(metrics.machine.tidalVolumeAvg ?? null, 0.5370, 0.02, "avg tidal volume");
  assertApprox(metrics.machine.tidalVolumeMax ?? null, 1.96, 0.02, "max tidal volume");
  assertApprox(metrics.machine.tidalVolumeMaxMinutes ?? null, 0.1, 0.02, "max tidal volume minutes");
  assertApprox(metrics.machine.respiratoryRateMin ?? null, 2, 0.02, "min RR");
  assertApprox(metrics.machine.respiratoryRateAvg ?? null, 15.8647, 0.02, "avg RR");
  assertApprox(metrics.machine.respiratoryRate95th ?? null, 28.6, 0.02, "95th RR");
  assertApprox(metrics.avgLeak, 6.9429, 0.02, "avg leak");
  assertApprox(metrics.leak95th, 18, 0.02, "95th leak");
  assertApprox(metrics.maxLeak30m, 54, 0.02, "30 min leak");
  assertApprox(metrics.maxLeak60m, 54, 0.02, "60 min leak");
});

maybeLocalAirCurve10Test("local ResMed AirCurve 10 VAuto sample does not report zero IPAP/EPAP summaries", async () => {
  const { metrics } = await loadFixture(LOCAL_RESMED_AIRCURVE10_ROOT, 7);
  assert.equal(metrics.machine.ipapAvg, undefined);
  assert.equal(metrics.machine.ipap95th, undefined);
  assert.equal(metrics.machine.epapAvg, undefined);
  assert.equal(metrics.machine.epap95th, undefined);
  assertApprox(metrics.machine.pressureAvg ?? null, 10.08, 0.02, "avg mask pressure");
  assertApprox(metrics.machine.pressure95th ?? null, 11.4, 0.02, "95th mask pressure");
});

maybeLocalAirCurve10StTest("local ResMed AirCurve 10 ST sample reports fixed bilevel settings and L/min leak values", async () => {
  const { prepared, metrics } = await loadFixture(LOCAL_RESMED_AIRCURVE10_ST_ROOT);
  assert.equal(prepared.selectedLoader, "ResMed");
  assert.equal(prepared.machine.device, "AirCurve 10 ST");
  assert.equal(prepared.machine.mode, "BiPAP");
  assert.equal(prepared.machine.epap, "4 cmH2O");
  assert.equal(prepared.machine.ipap, "14 cmH2O");
  assert.equal(prepared.machine.respiratoryRate, "15 bpm");
  assert.equal(prepared.machine.rampTime, "10 minutes");
  assert.equal(prepared.machine.rampPressure, "4 cmH2O");
  assert.equal(prepared.machine.pressureIsAuto, false);
  assert.equal(prepared.latestClinicalDayIso, "2026-04-27");
  assert.equal(metrics.daysWithData, 90);
  assert.equal(metrics.daysWithUsage, 90);
  assert.equal(metrics.compliantDays, 90);
  assertApprox(metrics.avgUsageHours, 11.9670, 0.02, "avg usage");
  assertApprox(metrics.avgAhi, 7.7067, 0.02, "avg AHI");
  assertApprox(metrics.avgResidualApneas, 2.5078, 0.02, "avg residual apneas");
  assert.equal(metrics.avgCentralApneas, null);
  assertApprox(metrics.machine.pressureAvg ?? null, 6.9947, 0.02, "avg pressure");
  assertApprox(metrics.machine.pressure95th ?? null, 8.76, 0.02, "95th pressure");
  assertApprox(metrics.machine.ipapAvg ?? null, 13.92, 0.02, "avg IPAP");
  assertApprox(metrics.machine.ipap95th ?? null, 13.92, 0.02, "95th IPAP");
  assertApprox(metrics.machine.epapAvg ?? null, 3.96, 0.02, "avg EPAP");
  assertApprox(metrics.machine.epap95th ?? null, 3.96, 0.02, "95th EPAP");
  assertApprox(metrics.machine.tidalVolumeMin ?? null, 0.02, 0.02, "min tidal volume");
  assertApprox(metrics.machine.tidalVolumeMinMinutes ?? null, 114, 0.02, "min tidal volume minutes");
  assertApprox(metrics.machine.tidalVolumeMedian ?? null, 0.6, 0.02, "median tidal volume");
  assertApprox(metrics.machine.tidalVolumeAvg ?? null, 0.7970, 0.02, "avg tidal volume");
  assertApprox(metrics.machine.tidalVolumeMax ?? null, 2.7, 0.02, "max tidal volume");
  assertApprox(metrics.machine.tidalVolumeMaxMinutes ?? null, 0.0667, 0.02, "max tidal volume minutes");
  assertApprox(metrics.machine.respiratoryRateMin ?? null, 15, 0.02, "min RR");
  assertApprox(metrics.machine.respiratoryRateAvg ?? null, 17.2713, 0.02, "avg RR");
  assertApprox(metrics.machine.respiratoryRate95th ?? null, 24.2, 0.02, "95th RR");
  assertApprox(metrics.avgLeak, 0.72, 0.02, "avg leak");
  assertApprox(metrics.leak95th, 49.12, 0.02, "95th leak");
  assertApprox(metrics.maxLeak30m, 120, 0.02, "30 min leak");
  assertApprox(metrics.maxLeak60m, 120, 0.02, "60 min leak");
  assertApprox(metrics.maxLeakMinutes ?? null, 34.3667, 0.02, "max leak minutes");
  assertApprox(metrics.sustainedLeakMax ?? null, 70.8, 0.02, "sustained leak max");
  assertApprox(metrics.sustainedLeakMinutes ?? null, 68.7, 0.02, "sustained leak minutes");
  assert.deepEqual(leakMetricRows(metrics), [
    ["Avg Leak", "0.7 L/min"],
    ["95th Leak", "49.1 L/min", true],
    ["Longest Sustained Leak", "70.8 L/min for 68.7 min", true],
    ["Max Leak", "120.0 L/min for 34.4 min", true]
  ]);
});
