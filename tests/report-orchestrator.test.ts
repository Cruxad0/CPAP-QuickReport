import assert from "node:assert/strict";
import test from "node:test";

import { buildReportArtifactsFromPreparedSource } from "../lib/report-orchestrator";
import type { PreparedDayBucket, PreparedQuickReportSource } from "../lib/types";

function bucket(usageHours: number): PreparedDayBucket {
  return {
    usageSum: usageHours,
    usageCount: 1,
    ahiWeightedSum: 0,
    ahiWeightHours: 0,
    ahiSum: 0,
    ahiCount: 0,
    residualApneaSum: 0,
    residualApneaCount: 0,
    centralApneaSum: 0,
    centralApneaCount: 0,
    reraSum: 0,
    reraCount: 0,
    leakSum: 0,
    leakCount: 0,
    leak95Sum: 0,
    leak95Count: 0,
    leakMax: null,
    leakMax30m: null,
    leakMax60m: null,
    pressureAvgSum: 0,
    pressureAvgCount: 0,
    pressure95Sum: 0,
    pressure95Count: 0,
    ipapAvgSum: 0,
    ipapAvgCount: 0,
    ipap95Sum: 0,
    ipap95Count: 0,
    epapAvgSum: 0,
    epapAvgCount: 0,
    epap95Sum: 0,
    epap95Count: 0,
    tidalVolumeSum: 0,
    tidalVolumeCount: 0,
    tidalVolumeMin: null,
    tidalVolumeMax: null,
    tidalVolumeBins: {},
    tidalVolumeSecondsByBin: {},
    respiratoryRateSum: 0,
    respiratoryRateCount: 0,
    respiratoryRateMin: null,
    respiratoryRateBins: {}
  };
}

test("generated report ranges anchor to the card's latest clinical day", async () => {
  const prepared: PreparedQuickReportSource = {
    selectedLoader: "Fixture Loader",
    machine: {
      mode: "APAP",
      pressureIsAuto: true,
      pressureMin: "8 cmH2O",
      pressureMax: "12 cmH2O"
    },
    warnings: [],
    latestClinicalDayIso: "2026-03-25",
    maxLookbackDays: 90,
    dayBuckets: {
      "2026-03-19": bucket(6),
      "2026-03-20": bucket(7),
      "2026-03-21": bucket(8),
      "2026-03-22": bucket(6),
      "2026-03-23": bucket(7),
      "2026-03-24": bucket(8),
      "2026-03-25": bucket(9)
    }
  };

  const result = await buildReportArtifactsFromPreparedSource({
    prepared,
    patientName: "Fixture Patient",
    dateOfBirthIso: "1970-01-01",
    physicianName: "",
    reportRanges: [7]
  });

  assert.equal(result.reports.length, 1);
  assert.equal(result.largestAvailableRange, 7);
  assert.equal(result.reports[0].metrics.dateRangeStart, "March 19, 2026");
  assert.equal(result.reports[0].metrics.dateRangeEnd, "March 25, 2026");
  assert.equal(result.reports[0].metrics.daysInWindow, 7);
  assert.equal(result.reports[0].metrics.daysWithData, 7);
});

test("the smallest requested report is generated for cards with less than seven days of history", async () => {
  const prepared: PreparedQuickReportSource = {
    selectedLoader: "Fixture Loader",
    machine: {
      mode: "APAP",
      pressureIsAuto: true,
      pressureMin: "8 cmH2O",
      pressureMax: "12 cmH2O"
    },
    warnings: [],
    latestClinicalDayIso: "2026-03-24",
    maxLookbackDays: 90,
    dayBuckets: {
      "2026-03-19": bucket(1),
      "2026-03-24": bucket(2)
    }
  };

  const result = await buildReportArtifactsFromPreparedSource({
    prepared,
    patientName: "Fixture Patient",
    dateOfBirthIso: "1970-01-01",
    physicianName: "",
    reportRanges: [90, 60, 30, 7]
  });

  assert.deepEqual(result.reports.map((report) => report.days), [7]);
  assert.equal(result.largestAvailableRange, 7);
  assert.equal(result.reports[0].metrics.daysInWindow, 6);
  assert.equal(result.reports[0].metrics.daysWithData, 2);
});

test("summary history coverage preserves requested report windows with sparse usage", async () => {
  const prepared: PreparedQuickReportSource = {
    selectedLoader: "ResMed",
    machine: {
      mode: "CPAP",
      pressure: "Fixed 8 cmH2O"
    },
    warnings: [],
    historyStartClinicalDayIso: "2025-12-26",
    latestClinicalDayIso: "2026-03-25",
    maxLookbackDays: 90,
    dayBuckets: {
      "2026-03-25": bucket(1)
    }
  };

  const result = await buildReportArtifactsFromPreparedSource({
    prepared,
    patientName: "Fixture Patient",
    dateOfBirthIso: "1970-01-01",
    physicianName: "",
    reportRanges: [90, 7]
  });

  assert.deepEqual(result.reports.map((report) => report.days), [90, 7]);
  assert.equal(result.reports[0].metrics.daysInWindow, 90);
  assert.equal(result.reports[0].metrics.daysWithData, 1);
});
