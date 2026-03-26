import assert from "node:assert/strict";
import test from "node:test";

import { buildQuickReportMetricsFromPreparedSource } from "../lib/parser";
import type { PreparedQuickReportSource, PreparedDayBucket } from "../lib/types";

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
    leakMax: null,
    leakMax30m: null,
    leakMax60m: null,
    pressureAvgSum: 0,
    pressureAvgCount: 0,
    pressure95Sum: 0,
    pressure95Count: 0
  };
}

test("explicit clinical end day is included in noon-to-noon report windows", () => {
  const prepared: PreparedQuickReportSource = {
    selectedLoader: "Fixture Loader",
    machine: {
      mode: "APAP",
      pressureIsAuto: true,
      pressureMin: "8 cmH2O",
      pressureMax: "12 cmH2O"
    },
    warnings: [],
    latestClinicalDayIso: "2026-03-26",
    maxLookbackDays: 90,
    dayBuckets: {
      "2026-03-23": bucket(6),
      "2026-03-24": bucket(7),
      "2026-03-25": bucket(8),
      "2026-03-26": bucket(9)
    }
  };

  const metrics = buildQuickReportMetricsFromPreparedSource(prepared, {
    patientName: "Fixture Patient",
    dateOfBirthIso: "1970-01-01",
    physicianName: "",
    lookbackDays: 3,
    windowEndClinicalDayIso: "2026-03-25"
  });

  assert.equal(metrics.daysInWindow, 3);
  assert.equal(metrics.daysWithData, 3);
  assert.equal(metrics.daysWithUsage, 3);
  assert.equal(metrics.dateRangeStart, "March 23, 2026");
  assert.equal(metrics.dateRangeEnd, "March 25, 2026");
  assert.equal(metrics.avgUsageHours, 7);
});
