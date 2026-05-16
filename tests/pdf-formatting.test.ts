import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";

import {
  ahiMetricRows,
  bipapVentilationRows,
  buildPdfReport,
  formatReportMetricValue,
  leakMetricRows,
  machineSettingRows,
  optionalEventMetricRows,
  shouldDisplayRespiratoryRate,
  therapyPressureRows
} from "../lib/pdf";
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

async function pageCountForReport(report: QuickReportMetrics): Promise<number> {
  const { blob } = await buildPdfReport(report);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPageCount();
}

test("report metric formatter rounds summary values to tenths", () => {
  assert.equal(formatReportMetricValue(2.24), "2.2");
  assert.equal(formatReportMetricValue(2.25), "2.3");
  assert.equal(formatReportMetricValue(117.4), "117.4");
  assert.equal(formatReportMetricValue(null), "Data point not available");
});

test("central apnea rows state when the card does not provide them", () => {
  assert.deepEqual(optionalEventMetricRows(reportWithMachine({ mode: "BiPAP" })), [
    ["Avg Central apneas", "Data is not present"],
    ["95th Central apneas", "Data is not present"]
  ]);
});

test("optional central apnea and RERA rows are shown when metrics are available", () => {
  const report = {
    ...reportWithMachine({ mode: "BiPAP" }),
    avgCentralApneas: 1.24,
    centralApneas95th: 2.25,
    avgReraIndex: 0.36
  };

  assert.deepEqual(optionalEventMetricRows(report), [
    ["Avg Central apneas", "1.2"],
    ["95th Central apneas", "2.3"],
    ["Avg RERA index", "0.4"]
  ]);
});

test("AHI rows are highlighted when values are above 5", () => {
  assert.deepEqual(
    ahiMetricRows({
      ...reportWithMachine({ mode: "BiPAP" }),
      avgAhi: 7.74,
      ahi95th: 12.44
    }),
    [
      ["Avg AHI", "7.7", true],
      ["95th AHI", "12.4", true]
    ]
  );
});

test("leak rows show sustained and max leak durations when available", () => {
  assert.deepEqual(
    leakMetricRows({
      ...reportWithMachine({ mode: "APAP" }),
      selectedLoader: "Resvent / Hoffrichter",
      avgLeak: 18.6,
      leak95th: 77.6,
      maxLeak: 120,
      maxLeakMinutes: 42.25,
      maxLeak60m: 96,
      sustainedLeakMax: 88.4,
      sustainedLeakMinutes: 63.5
    }),
    [
      ["Median Leak", "18.6 L/min"],
      ["95th Leak", "77.6 L/min", true],
      ["Longest Sustained Leak", "88.4 L/min for 63.5 min", true],
      ["Max Leak", "120.0 L/min for 42.3 min", true]
    ]
  );
});

test("BiPAP ventilation rows show Vt and RR metrics when available", () => {
  assert.deepEqual(
    bipapVentilationRows(
      reportWithMachine({
        mode: "VAuto",
        respiratoryRate: "14 bpm",
        tidalVolume: "500 mL",
        tidalVolumeAvg: 0.46,
        tidalVolumeMin: 0.31,
        tidalVolumeMinMinutes: 12.24,
        tidalVolumeMedian: 0.44,
        tidalVolumeMax: 0.89,
        tidalVolumeMaxMinutes: 1.96,
        respiratoryRateMin: 8.24,
        respiratoryRateAvg: 13.25,
        respiratoryRate95th: 22.04
      })
    ),
    [
      ["Min Vt (tidal volume)", "310.0 mL for 12.2 min", true],
      ["Median Vt (tidal volume)", "440.0 mL", true],
      ["Avg Vt (tidal volume)", "460.0 mL", true],
      ["Max Vt (tidal volume)", "890.0 mL for 2.0 min"],
      ["Min RR", "8.2 bpm", true],
      ["Avg RR", "13.3 bpm", true],
      ["95th RR", "22.0 bpm"]
    ]
  );
});

test("BiPAP ventilation rows are hidden for non-BiPAP modes", () => {
  assert.deepEqual(
    bipapVentilationRows(
      reportWithMachine({
        mode: "CPAP",
        tidalVolumeAvg: 0.46,
        tidalVolumeMin: 0.31,
        tidalVolumeMinMinutes: 12.24,
        tidalVolumeMedian: 0.44,
        tidalVolumeMax: 0.89,
        tidalVolumeMaxMinutes: 1.96,
        respiratoryRateMin: 8.24,
        respiratoryRateAvg: 13.25,
        respiratoryRate95th: 22.04
      })
    ),
    []
  );
});

test("machine settings show BiPAP Vt target when present", () => {
  assert.deepEqual(
    machineSettingRows(
      reportWithMachine({
        mode: "BiPAP",
        ipap: "14 cmH2O",
        epap: "8 cmH2O",
        tidalVolume: "0.5 L"
      })
    ),
    [
      ["Device", "Data point not available"],
      ["Mode", "BiPAP"],
      ["IPAP", "14.0 cmH2O"],
      ["EPAP", "8.0 cmH2O"],
      ["Tidal volume (Vt)", "500.0 mL"],
      ["Pressure relief", "Data point not available"]
    ]
  );
});

test("machine settings label auto BiPAP pressure bounds as EPAP and IPAP settings", () => {
  assert.deepEqual(
    machineSettingRows(
      reportWithMachine({
        mode: "VAuto",
        pressureIsAuto: true,
        pressureMin: "7 cmH2O",
        pressureMax: "11 cmH2O"
      })
    ),
    [
      ["Device", "Data point not available"],
      ["Mode", "VAuto"],
      ["Min EPAP", "7.0 cmH2O"],
      ["Max IPAP", "11.0 cmH2O"],
      ["Pressure relief", "Data point not available"]
    ]
  );
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

test("machine settings round backup respiratory rate to tenths", () => {
  assert.deepEqual(
    machineSettingRows(
      reportWithMachine({
        mode: "BiPAP",
        ipap: "14 cmH2O",
        epap: "8 cmH2O",
        respiratoryRate: "15 bpm"
      })
    ),
    [
      ["Device", "Data point not available"],
      ["Mode", "BiPAP"],
      ["IPAP", "14.0 cmH2O"],
      ["EPAP", "8.0 cmH2O"],
      ["Respiratory rate (RR)", "15.0 bpm"],
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

test("therapy summary does not derive min and max pressure rows from fixed BiPAP EPAP and IPAP settings", () => {
  assert.deepEqual(
    therapyPressureRows(
      reportWithMachine({
        mode: "BiPAP",
        epap: "7 cmH2O",
        ipap: "11 cmH2O",
        epapAvg: 7.1,
        epap95th: 7.8,
        ipapAvg: 10.6,
        ipap95th: 11.2,
        pressureAvg: 10.08,
        pressure95th: 11.4
      })
    ),
    [
      ["95th IPAP", "11.2 cmH2O"],
      ["Avg IPAP", "10.6 cmH2O"],
      ["95th EPAP", "7.8 cmH2O"],
      ["Avg EPAP", "7.1 cmH2O"]
    ]
  );
});

test("BiPAP pressure warnings allow ten percent variance below settings", () => {
  assert.deepEqual(
    therapyPressureRows(
      reportWithMachine({
        mode: "BiPAP",
        ipap: "14 cmH2O",
        epap: "8 cmH2O",
        ipapAvg: 13.9,
        ipap95th: 12.5,
        epapAvg: 7.3,
        epap95th: 7.1
      })
    ),
    [
      ["95th IPAP", "12.5 cmH2O", true],
      ["Avg IPAP", "13.9 cmH2O"],
      ["95th EPAP", "7.1 cmH2O", true],
      ["Avg EPAP", "7.3 cmH2O"]
    ]
  );
});

test("therapy summary shows min EPAP and max IPAP rows for auto BiPAP settings without mask pressure rows", () => {
  assert.deepEqual(
    therapyPressureRows(
      reportWithMachine({
        mode: "VAuto",
        pressureIsAuto: true,
        pressureMin: "7 cmH2O",
        pressureMax: "11 cmH2O",
        epapAvg: 7.1,
        epap95th: 7.8,
        ipapAvg: 10.6,
        ipap95th: 11.2,
        pressureAvg: 10.08,
        pressure95th: 11.4
      })
    ),
    [
      ["95th IPAP", "11.2 cmH2O"],
      ["Avg IPAP", "10.6 cmH2O"],
      ["95th EPAP", "7.8 cmH2O"],
      ["Avg EPAP", "7.1 cmH2O"],
      ["Min EPAP", "7.0 cmH2O"],
      ["Max IPAP", "11.0 cmH2O"]
    ]
  );
});

test("therapy summary shows mirrored auto BiPAP IPAP and EPAP metric rows when the card provides them", () => {
  assert.deepEqual(
    therapyPressureRows(
      reportWithMachine({
        mode: "VAuto",
        pressureIsAuto: true,
        pressureMin: "7 cmH2O",
        pressureMax: "11 cmH2O",
        epapAvg: 9.7015,
        epap95th: 10.92,
        ipapAvg: 9.7015,
        ipap95th: 10.92,
        pressureAvg: 9.6831,
        pressure95th: 10.92
      })
    ),
    [
      ["95th IPAP", "10.9 cmH2O"],
      ["Avg IPAP", "9.7 cmH2O"],
      ["95th EPAP", "10.9 cmH2O"],
      ["Avg EPAP", "9.7 cmH2O"],
      ["Min EPAP", "7.0 cmH2O"],
      ["Max IPAP", "11.0 cmH2O"]
    ]
  );
});

test("therapy summary does not show unavailable BiPAP metric rows when only mask pressure exists", () => {
  assert.deepEqual(
    therapyPressureRows(
      reportWithMachine({
        mode: "VAuto",
        pressureIsAuto: true,
        pressureMin: "7 cmH2O",
        pressureMax: "11 cmH2O",
        pressureAvg: 10.08,
        pressure95th: 11.4
      })
    ),
    [
      ["Min EPAP", "7.0 cmH2O"],
      ["Max IPAP", "11.0 cmH2O"]
    ]
  );
});

test("CPAP reports stay on one page", async () => {
  const pages = await pageCountForReport(
    reportWithMachine({
      mode: "APAP",
      pressureIsAuto: true,
      pressureMin: "8 cmH2O",
      pressureMax: "12 cmH2O",
      pressureAvg: 9.24,
      pressure95th: 11.76
    })
  );

  assert.equal(pages, 1);
});

test("Auto S30 reports stay on one page", async () => {
  const pages = await pageCountForReport(
    reportWithMachine({
      mode: "Auto S30",
      pressureIsAuto: true,
      pressureMin: "4 cmH2O",
      pressureMax: "12 cmH2O",
      epapAvg: 5.4,
      epap95th: 7.5,
      ipapAvg: 8.2,
      ipap95th: 11.2,
      pressureAvg: 5.1,
      pressure95th: 8.9
    })
  );

  assert.equal(pages, 1);
});

test("BiPAP reports use two pages", async () => {
  const pages = await pageCountForReport(
    reportWithMachine({
      mode: "VAuto",
      pressureIsAuto: true,
      pressureMin: "7 cmH2O",
      pressureMax: "11 cmH2O",
      epapAvg: 7.1,
      epap95th: 7.8,
      ipapAvg: 10.6,
      ipap95th: 11.2,
      pressureAvg: 10.08,
      pressure95th: 11.4,
      respiratoryRate: "14 bpm",
      tidalVolume: "500 mL",
      tidalVolumeAvg: 0.46,
      tidalVolumeMin: 0.31,
      tidalVolumeMinMinutes: 12.24,
      tidalVolumeMedian: 0.44,
      tidalVolumeMax: 0.89,
      tidalVolumeMaxMinutes: 1.96,
      respiratoryRateMin: 8.24,
      respiratoryRateAvg: 13.25,
      respiratoryRate95th: 22.04
    })
  );

  assert.equal(pages, 2);
});
