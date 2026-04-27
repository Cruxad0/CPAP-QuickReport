import assert from "node:assert/strict";
import test from "node:test";

import { formatReportMetricValue, machineSettingRows, shouldDisplayRespiratoryRate, therapyPressureRows } from "../lib/pdf";
import type { QuickReportMetrics } from "../lib/types";

function reportWithMachine(machine: QuickReportMetrics["machine"]): QuickReportMetrics {
  return {
    generatedAtIso: "2026-04-27T00:00:00.000Z",
    generatedAtDisplay: "April 27, 2026, 12:00 AM",
    selectedLoader: "Fixture Loader",
    sourceTimeZoneOffsetMinutes: null,
    patientName: "Fixture Patient",
    dateOfBirth: "January 1, 1970",
    physicianName: "",
    dateRangeStart: "April 20, 2026",
    dateRangeEnd: "April 27, 2026",
    daysInWindow: 7,
    daysWithData: 7,
    daysWithUsage: 7,
    usageDaysPercent: 100,
    compliantDays: 7,
    compliancePercent: 100,
    avgUsageHours: 7,
    avgAhi: 1,
    avgResidualApneas: null,
    avgCentralApneas: null,
    avgReraIndex: null,
    ahi95th: 1,
    residualApneas95th: null,
    centralApneas95th: null,
    rera95th: null,
    avgLeak: null,
    leak95th: null,
    maxLeak: null,
    maxLeak30m: null,
    maxLeak60m: null,
    machine,
    warnings: []
  };
}

test("report metric formatter rounds summary values to tenths", () => {
  assert.equal(formatReportMetricValue(2.24), "2.2");
  assert.equal(formatReportMetricValue(2.25), "2.3");
  assert.equal(formatReportMetricValue(117.4), "117.4");
  assert.equal(formatReportMetricValue(null), "Data point not available");
});

test("respiratory rate row is only shown when a respiratory-rate value exists", () => {
  assert.equal(
    shouldDisplayRespiratoryRate({
      mode: "BiPAP",
      ipap: "11 cmH2O",
      epap: "7 cmH2O"
    }),
    false
  );

  assert.equal(
    shouldDisplayRespiratoryRate({
      mode: "BiPAP",
      ipap: "14 cmH2O",
      epap: "8 cmH2O",
      respiratoryRate: "12 bpm"
    }),
    true
  );
});

test("machine settings show ramp time but hide ramp pressure when ramp is off", () => {
  assert.deepEqual(
    machineSettingRows(
      reportWithMachine({
        mode: "CPAP",
        pressure: "Fixed 6 cmH2O",
        rampTime: "Off",
        rampPressure: "4 cmH2O"
      })
    ),
    [
      ["Device", "Data point not available"],
      ["Mode", "CPAP"],
      ["Pressure", "6.0 cmH2O"],
      ["Ramp time", "Off"],
      ["Pressure relief", "Data point not available"]
    ]
  );
});

test("machine settings show ramp pressure when ramp time is present", () => {
  assert.deepEqual(
    machineSettingRows(
      reportWithMachine({
        mode: "CPAP",
        pressure: "Fixed 6 cmH2O",
        rampTime: "5 minutes",
        rampPressure: "4 cmH2O"
      })
    ),
    [
      ["Device", "Data point not available"],
      ["Mode", "CPAP"],
      ["Pressure", "6.0 cmH2O"],
      ["Ramp time", "5 minutes"],
      ["Ramp pressure", "4.0 cmH2O"],
      ["Pressure relief", "Data point not available"]
    ]
  );
});

test("therapy summary includes 95th, average, min, and max pressure rows for APAP", () => {
  assert.deepEqual(
    therapyPressureRows(
      reportWithMachine({
        mode: "APAP",
        pressureIsAuto: true,
        pressureMin: "8 cmH2O",
        pressureMax: "12 cmH2O",
        pressureAvg: 9.24,
        pressure95th: 11.76
      })
    ),
    [
      ["95th Pressure", "11.8 cmH2O"],
      ["Avg Pressure", "9.2 cmH2O"],
      ["Min Pressure", "8.0 cmH2O"],
      ["Max Pressure", "12.0 cmH2O"]
    ]
  );
});

test("therapy summary derives min and max pressure rows from a fixed CPAP setting", () => {
  assert.deepEqual(
    therapyPressureRows(
      reportWithMachine({
        mode: "CPAP",
        pressure: "Fixed 7.2 cmH2O",
        pressureAvg: 7.2,
        pressure95th: 7.2
      })
    ),
    [
      ["95th Pressure", "7.2 cmH2O"],
      ["Avg Pressure", "7.2 cmH2O"],
      ["Min Pressure", "7.2 cmH2O"],
      ["Max Pressure", "7.2 cmH2O"]
    ]
  );
});
