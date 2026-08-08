import assert from "node:assert/strict";
import test from "node:test";

import { buildQuickReportMetricsFromPreparedSource, prepareQuickReportSource } from "../lib/parser";
import type { PreparedDayBucket, PreparedQuickReportSource, SourceFile } from "../lib/types";

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

function nextClinicalDayIso(isoDay: string): string {
  return new Date(new Date(`${isoDay}T00:00:00Z`).getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
}

function createSourceFile(path: string, bytes: Uint8Array, lastModifiedMs?: number): SourceFile {
  return {
    name: path.split("/").pop() ?? path,
    path,
    size: bytes.byteLength,
    lastModifiedMs,
    readText: async () => new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    readBytes: async () => bytes
  };
}

function createResventTextFile(path: string, text: string, lastModifiedMs?: number): SourceFile {
  const payload = new TextEncoder().encode(text);
  const bytes = new Uint8Array(payload.length + 4);
  bytes.set(payload, 4);
  return createSourceFile(path, bytes, lastModifiedMs);
}

async function loadSyntheticResventFixture(files: SourceFile[]) {
  const prepared = await prepareQuickReportSource({
    sourceKind: "folder",
    files,
    lookbackDays: 30
  });
  const metrics = buildQuickReportMetricsFromPreparedSource(prepared, {
    patientName: "Fixture Patient",
    dateOfBirthIso: "1970-01-01",
    physicianName: "",
    lookbackDays: 30,
    windowEndClinicalDayIso: nextClinicalDayIso(prepared.latestClinicalDayIso)
  });
  return { prepared, metrics };
}

test("report finalization preserves explicit parser-reported mode labels", () => {
  const prepared: PreparedQuickReportSource = {
    selectedLoader: "Fixture Loader",
    machine: {
      mode: "Auto S30",
      epap: "6 cmH2O",
      ipap: "10 cmH2O",
      pressure: "EPAP 6 / IPAP 10 (cmH2O)"
    },
    warnings: [],
    latestClinicalDayIso: "2026-03-23",
    maxLookbackDays: 90,
    dayBuckets: {
      "2026-03-23": bucket(8)
    }
  };

  const metrics = buildQuickReportMetricsFromPreparedSource(prepared, {
    patientName: "Fixture Patient",
    dateOfBirthIso: "1970-01-01",
    physicianName: "",
    lookbackDays: 7,
    windowEndClinicalDayIso: "2026-03-24"
  });

  assert.equal(metrics.machine.mode, "Auto S30");
  assert.equal(metrics.daysWithData, 1);
  assert.equal(metrics.daysWithUsage, 1);
});

test("Resvent UTC+8 device epochs are normalized to the computer-local machine clock", async () => {
  const files: SourceFile[] = [
    createResventTextFile("THERAPY/CONFIG/SYSCFG", ["models=iBreeze 20A", "sn=GB-2B500568"].join("\n")),
    createResventTextFile("THERAPY/CONFIG/TCTRL", "VentMode=3\n"),
    createResventTextFile("THERAPY/CONFIG/N_APAP", ["PMin=800", "PMax=1000"].join("\n"))
  ];

  for (let day = 1; day <= 4; day += 1) {
    const rawDeviceEpochSeconds = Date.UTC(2026, 7, day, 15, 0, 0) / 1000;
    const machineLocalEnd = new Date(2026, 7, day + 1, 6, 0, 0).getTime();
    files.push(
      createResventTextFile(
        `THERAPY/RECORD/202608/${String(day).padStart(2, "0")}/STAT01`,
        ["VentMode=3", `secStart=${rawDeviceEpochSeconds}`, "secUsed=25200", "cntAI=1", "cntHI=1"].join("\n"),
        machineLocalEnd
      )
    );
  }

  const prepared = await prepareQuickReportSource({
    sourceKind: "folder",
    files,
    lookbackDays: 30,
    userTimeZoneOffsetMinutes: -240
  });

  assert.equal(prepared.sourceTimeZoneOffsetMinutes, -240);
  assert.equal(prepared.sleepTimingProfile?.sleepWindowStartMinutes, 23 * 60);
  assert.equal(prepared.sleepTimingProfile?.sleepWindowEndMinutes, 6 * 60);
  assert.equal(prepared.therapySessions?.[0]?.startIso, "2026-08-01T23:00:00.000Z");
  assert.ok(
    prepared.warnings.some((warning) =>
      warning.includes("normalized by +8:00 from the device epoch to machine/computer local wall time")
    )
  );
});

test("Resvent latest STAT VentMode confirms active Auto S30 bilevel mode", async () => {
  const files: SourceFile[] = [
    createResventTextFile("THERAPY/CONFIG/SYSCFG", ["models=iBreeze 30STA", "sn=GB-2B420607"].join("\n")),
    createResventTextFile("THERAPY/CONFIG/TCTRL", "VentMode=11\n"),
    createResventTextFile(
      "THERAPY/CONFIG/N_AS30",
      ["PMin=400", "PMax=1200", "EPAP=600", "IPAP=1000", "PS=200"].join("\n")
    ),
    createResventTextFile(
      "THERAPY/RECORD/202603/23/STAT",
      [
        "VentMode=11",
        "secUsed=28800",
        "cntAI=8",
        "cntHI=4",
        "cntCAI=2",
        "cntRERA=2",
        "medIPAP=440",
        "medEPAP=380",
        "p95IPAP=570",
        "p95EPAP=400"
      ].join("\n")
    )
  ];

  const { prepared, metrics } = await loadSyntheticResventFixture(files);

  assert.equal(prepared.selectedLoader, "Resvent / Hoffrichter");
  assert.equal(prepared.machine.device, "iBreeze 30STA (GB-2B420607)");
  assert.equal(prepared.machine.mode, "Auto S30");
  assert.equal(prepared.machine.epap, "6 cmH2O");
  assert.equal(prepared.machine.ipap, "10 cmH2O");
  assert.equal(prepared.latestClinicalDayIso, "2026-03-23");
  assert.equal(metrics.machine.mode, "Auto S30");
  assert.equal(metrics.daysWithData, 1);
  assert.equal(metrics.daysWithUsage, 1);
  assert.equal(metrics.machine.pressureAvg, undefined);
  assert.equal(metrics.machine.pressure95th, undefined);
  assert.equal(metrics.machine.ipapAvg, 4.4);
  assert.equal(metrics.machine.ipap95th, 5.7);
  assert.equal(metrics.machine.epapAvg, 3.8);
  assert.equal(metrics.machine.epap95th, 4);
});

test("Resvent CPAP config reports fixed Press instead of APAP min/max range", async () => {
  const files: SourceFile[] = [
    createResventTextFile("THERAPY/CONFIG/SYSCFG", ["models=iBreeze 20A", "sn=GB-2B500568"].join("\n")),
    createResventTextFile("THERAPY/CONFIG/TCTRL", "VentMode=1\n"),
    createResventTextFile("THERAPY/CONFIG/N_CPAP", ["Press=600", "PMin=400", "PMax=1200", "iPR=1"].join("\n")),
    createResventTextFile("THERAPY/CONFIG/COMFORT", ["RampTime=5", "RampPress=400"].join("\n")),
    createResventTextFile(
      "THERAPY/RECORD/202604/26/STAT",
      ["VentMode=1", "secUsed=28800", "cntAI=8", "cntHI=4", "medLeak=1.4", "p95Leak=16.1"].join("\n")
    )
  ];

  const { prepared, metrics } = await loadSyntheticResventFixture(files);

  assert.equal(prepared.machine.mode, "CPAP");
  assert.equal(prepared.machine.pressure, "Fixed 6 (cmH2O)");
  assert.equal(prepared.machine.pressureMin, undefined);
  assert.equal(prepared.machine.pressureMax, undefined);
  assert.equal(prepared.machine.rampTime, "5 minutes");
  assert.equal(prepared.machine.rampPressure, "4 cmH2O");
  assert.equal(metrics.machine.pressure, "Fixed 6 (cmH2O)");
});

test("Resvent ramp pressure is omitted when ramp time is off", async () => {
  const files: SourceFile[] = [
    createResventTextFile("THERAPY/CONFIG/SYSCFG", ["models=iBreeze 20A", "sn=GB-2B500568"].join("\n")),
    createResventTextFile("THERAPY/CONFIG/TCTRL", "VentMode=1\n"),
    createResventTextFile("THERAPY/CONFIG/N_CPAP", ["Press=600", "iPR=1"].join("\n")),
    createResventTextFile("THERAPY/CONFIG/COMFORT", ["RampTime=0", "RampPress=400"].join("\n")),
    createResventTextFile(
      "THERAPY/RECORD/202604/26/STAT",
      ["VentMode=1", "secUsed=28800", "cntAI=8", "cntHI=4"].join("\n")
    )
  ];

  const { prepared } = await loadSyntheticResventFixture(files);

  assert.equal(prepared.machine.rampTime, "Off");
  assert.equal(prepared.machine.rampPressure, undefined);
});

test("Resvent STAT leak median and p95 are kept as separate report metrics", async () => {
  const files: SourceFile[] = [
    createResventTextFile("THERAPY/CONFIG/SYSCFG", ["models=iBreeze 20A", "sn=GB-2B500568"].join("\n")),
    createResventTextFile("THERAPY/CONFIG/TCTRL", "VentMode=1\n"),
    createResventTextFile("THERAPY/CONFIG/N_CPAP", ["Press=600", "iPR=1"].join("\n")),
    createResventTextFile(
      "THERAPY/RECORD/202604/26/STAT",
      ["VentMode=1", "secUsed=28800", "cntAI=8", "cntHI=4", "medLeak=1.4", "p95Leak=16.1"].join("\n")
    )
  ];

  const { metrics } = await loadSyntheticResventFixture(files);

  assert.equal(metrics.avgLeak, 1.4);
  assert.equal(metrics.leak95th, 16.1);
});

test("Resvent latest STAT VentMode overrides stale TCTRL mode selection", async () => {
  const files: SourceFile[] = [
    createResventTextFile("THERAPY/CONFIG/SYSCFG", ["models=iBreeze 30STA", "sn=GB-2B420607"].join("\n")),
    createResventTextFile("THERAPY/CONFIG/TCTRL", "VentMode=3\n"),
    createResventTextFile("THERAPY/CONFIG/N_APAP", ["PMin=500", "PMax=1000"].join("\n")),
    createResventTextFile(
      "THERAPY/CONFIG/N_AS30",
      ["PMin=400", "PMax=1200", "EPAP=600", "IPAP=1000", "PS=200"].join("\n")
    ),
    createResventTextFile(
      "THERAPY/RECORD/202603/23/STAT",
      [
        "VentMode=11",
        "secUsed=28800",
        "cntAI=8",
        "cntHI=4",
        "cntCAI=2",
        "medIPAP=440",
        "medEPAP=380",
        "p95IPAP=570",
        "p95EPAP=400"
      ].join("\n")
    )
  ];

  const { prepared, metrics } = await loadSyntheticResventFixture(files);

  assert.equal(prepared.machine.mode, "Auto S30");
  assert.equal(prepared.machine.epap, "6 cmH2O");
  assert.equal(prepared.machine.ipap, "10 cmH2O");
  assert.equal(metrics.machine.mode, "Auto S30");
  assert.ok(
    prepared.warnings.some((warning) =>
      warning.includes("Resvent VentMode disagreed between TCTRL (3) and latest STAT (11)")
    )
  );
});

test("Resvent recent STAT VentMode changes warn and keep reports on the latest therapy period", async () => {
  const files: SourceFile[] = [
    createResventTextFile("THERAPY/CONFIG/SYSCFG", ["models=iBreeze 20A", "sn=GB-2B500568"].join("\n")),
    createResventTextFile("THERAPY/CONFIG/TCTRL", "VentMode=3\n"),
    createResventTextFile("THERAPY/CONFIG/N_CPAP", ["Press=600"].join("\n")),
    createResventTextFile("THERAPY/CONFIG/N_APAP", ["PMin=600", "PMax=1500"].join("\n")),
    createResventTextFile(
      "THERAPY/RECORD/202603/22/STAT",
      ["VentMode=1", "secUsed=28800", "cntAI=2", "cntHI=1"].join("\n")
    ),
    createResventTextFile(
      "THERAPY/RECORD/202603/23/STAT",
      ["VentMode=3", "secUsed=28800", "cntAI=1", "cntHI=1"].join("\n")
    )
  ];

  const prepared = await prepareQuickReportSource({
    sourceKind: "folder",
    files,
    lookbackDays: 90
  });
  const metrics = buildQuickReportMetricsFromPreparedSource(prepared, {
    patientName: "Fixture Patient",
    dateOfBirthIso: "1970-01-01",
    physicianName: "",
    lookbackDays: 90,
    windowEndClinicalDayIso: nextClinicalDayIso(prepared.latestClinicalDayIso)
  });

  assert.equal(prepared.machine.mode, "APAP");
  assert.ok(prepared.warnings.some((warning) => warning.includes("Therapy settings changed during the imported 90-day history")));
  assert.equal(metrics.dateRangeStart, "March 23, 2026");
  assert.equal(metrics.dateRangeEnd, "March 23, 2026");
  assert.equal(metrics.daysInWindow, 1);
  assert.equal(metrics.daysWithData, 1);
  assert.ok(metrics.warnings.some((warning) => warning.includes("Therapy settings changed within the 90-day report window")));
});
