import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
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

function runLocalAnchorFixture(
  nowIso: string,
  tz: string,
  latestClinicalDayIso: string,
  dayKeys: string[]
): { dateRangeEnd: string; daysWithData: number; daysInWindow: number } {
  const parserPath = path.resolve(process.cwd(), "lib/parser.ts");
  const dayBucketsEntries = dayKeys
    .map((dayKey, idx) => `        ${JSON.stringify(dayKey)}: bucket(${6 + (idx % 4)})`)
    .join(",\n");
  const script = `
    import parser from ${JSON.stringify(parserPath)};
    const { buildQuickReportMetricsFromPreparedSource } = parser;
    const bucket = (usageHours) => ({
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
    });
    const RealDate = Date;
    class MockDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(${JSON.stringify(nowIso)});
        else super(...args);
      }
      static now() { return new RealDate(${JSON.stringify(nowIso)}).getTime(); }
    }
    globalThis.Date = MockDate;
    const prepared = {
      selectedLoader: "Fixture Loader",
      machine: { mode: "APAP", pressureIsAuto: true, pressureMin: "8 cmH2O", pressureMax: "12 cmH2O" },
      sourceTimeZoneOffsetMinutes: null,
      warnings: [],
      latestClinicalDayIso: ${JSON.stringify(latestClinicalDayIso)},
      maxLookbackDays: 90,
      dayBuckets: {
${dayBucketsEntries}
      }
    };
    const metrics = buildQuickReportMetricsFromPreparedSource(prepared, {
      patientName: "Fixture Patient",
      dateOfBirthIso: "1970-01-01",
      physicianName: "",
      lookbackDays: 7
    });
    console.log(JSON.stringify({
      dateRangeEnd: metrics.dateRangeEnd,
      daysWithData: metrics.daysWithData,
      daysInWindow: metrics.daysInWindow
    }));
  `;
  const output = execFileSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, TZ: tz },
    encoding: "utf8"
  }).trim();
  return JSON.parse(output) as { dateRangeEnd: string; daysWithData: number; daysInWindow: number };
}

test("explicit clinical end day label is included in noon-to-noon report windows", () => {
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
      "2026-03-23": bucket(6),
      "2026-03-24": bucket(7),
      "2026-03-25": bucket(8)
    }
  };

  const metrics = buildQuickReportMetricsFromPreparedSource(prepared, {
    patientName: "Fixture Patient",
    dateOfBirthIso: "1970-01-01",
    physicianName: "",
    lookbackDays: 3,
    windowEndClinicalDayIso: "2026-03-26"
  });

  assert.equal(metrics.daysInWindow, 3);
  assert.equal(metrics.daysWithData, 3);
  assert.equal(metrics.daysWithUsage, 3);
  assert.equal(metrics.dateRangeStart, "March 24, 2026");
  assert.equal(metrics.dateRangeEnd, "March 26, 2026");
  assert.equal(metrics.avgUsageHours, 7);
});

test("latest completed noon-to-noon day does not look skipped in displayed range", () => {
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

  const metrics = buildQuickReportMetricsFromPreparedSource(prepared, {
    patientName: "Fixture Patient",
    dateOfBirthIso: "1970-01-01",
    physicianName: "",
    lookbackDays: 7,
    windowEndClinicalDayIso: "2026-03-26"
  });

  assert.equal(metrics.dateRangeStart, "March 20, 2026");
  assert.equal(metrics.dateRangeEnd, "March 26, 2026");
  assert.equal(metrics.daysInWindow, 7);
  assert.equal(metrics.daysWithData, 7);
  assert.equal(metrics.daysWithUsage, 7);
});

test("displayed range contracts instead of implying a skipped current day when only fewer start-day buckets exist", () => {
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
      "2026-03-20": bucket(7),
      "2026-03-21": bucket(8),
      "2026-03-22": bucket(6),
      "2026-03-23": bucket(7),
      "2026-03-24": bucket(8),
      "2026-03-25": bucket(9)
    }
  };

  const metrics = buildQuickReportMetricsFromPreparedSource(prepared, {
    patientName: "Fixture Patient",
    dateOfBirthIso: "1970-01-01",
    physicianName: "",
    lookbackDays: 7,
    windowEndClinicalDayIso: "2026-03-26"
  });

  assert.equal(metrics.dateRangeStart, "March 21, 2026");
  assert.equal(metrics.dateRangeEnd, "March 26, 2026");
  assert.equal(metrics.daysInWindow, 6);
  assert.equal(metrics.daysWithData, 6);
  assert.equal(metrics.daysWithUsage, 6);
});

test("default report window stays on the user's local calendar day across spring DST transition", () => {
  const metrics = runLocalAnchorFixture(
    "2026-03-08T07:30:00Z",
    "America/Los_Angeles",
    "2026-03-06",
    ["2026-02-28", "2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"]
  );
  assert.equal(metrics.dateRangeEnd, "March 7, 2026");
  assert.equal(metrics.daysWithData, 7);
  assert.equal(metrics.daysInWindow, 7);
});

test("default report window stays on the user's local calendar day across fall DST transition", () => {
  const metrics = runLocalAnchorFixture(
    "2026-11-01T06:30:00Z",
    "America/Los_Angeles",
    "2026-10-30",
    ["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]
  );
  assert.equal(metrics.dateRangeEnd, "October 31, 2026");
  assert.equal(metrics.daysWithData, 7);
  assert.equal(metrics.daysInWindow, 7);
});

test("default report window falls back to the latest available clinical day when today's window is empty", () => {
  const metrics = runLocalAnchorFixture(
    "2026-04-16T12:00:00Z",
    "America/Puerto_Rico",
    "2026-03-23",
    ["2026-03-17", "2026-03-18", "2026-03-19", "2026-03-20", "2026-03-21", "2026-03-22", "2026-03-23"]
  );
  assert.equal(metrics.dateRangeEnd, "March 24, 2026");
  assert.equal(metrics.daysWithData, 7);
  assert.equal(metrics.daysInWindow, 7);
});

test("default report window prefers the card UTC offset over the host timezone when available", () => {
  const prepared: PreparedQuickReportSource = {
    selectedLoader: "ResMed",
    machine: {
      mode: "CPAP",
      pressure: "Fixed 7.2 cmH2O"
    },
    sourceTimeZoneOffsetMinutes: -480,
    warnings: [],
    latestClinicalDayIso: "2026-03-06",
    maxLookbackDays: 90,
    dayBuckets: {
      "2026-02-28": bucket(6),
      "2026-03-01": bucket(7),
      "2026-03-02": bucket(8),
      "2026-03-03": bucket(6),
      "2026-03-04": bucket(7),
      "2026-03-05": bucket(8),
      "2026-03-06": bucket(9)
    }
  };

  const RealDate = Date;
  class MockDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super("2026-03-08T07:30:00Z");
      else if (args.length === 1) super(args[0]);
      else if (args.length === 2) super(args[0], args[1]);
      else if (args.length === 3) super(args[0], args[1], args[2]);
      else if (args.length === 4) super(args[0], args[1], args[2], args[3]);
      else if (args.length === 5) super(args[0], args[1], args[2], args[3], args[4]);
      else if (args.length === 6) super(args[0], args[1], args[2], args[3], args[4], args[5]);
      else super(args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
    }

    static now() {
      return new RealDate("2026-03-08T07:30:00Z").getTime();
    }
  }

  const originalDate = globalThis.Date;
  globalThis.Date = MockDate as unknown as DateConstructor;
  try {
    const metrics = buildQuickReportMetricsFromPreparedSource(prepared, {
      patientName: "Fixture Patient",
      dateOfBirthIso: "1970-01-01",
      physicianName: "",
      lookbackDays: 7
    });

    assert.equal(metrics.sourceTimeZoneOffsetMinutes, -480);
    assert.equal(metrics.dateRangeEnd, "March 7, 2026");
    assert.equal(metrics.daysWithData, 7);
    assert.equal(metrics.daysInWindow, 7);
  } finally {
    globalThis.Date = originalDate;
  }
});
