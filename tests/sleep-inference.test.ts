import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTherapySessions,
  formatClockMinutes,
  formatDurationHoursAsHmm,
  inferSleepTimingProfile
} from "../lib/sleep-inference";
import { buildQuickReportMetricsFromPreparedSource } from "../lib/parser";
import type { PreparedDayBucket, PreparedQuickReportSource, TherapyUsageSession } from "../lib/types";

function session(day: number, startHour: number, durationHours: number): TherapyUsageSession {
  const start = new Date(Date.UTC(2026, 0, day, Math.floor(startHour), Math.round((startHour % 1) * 60)));
  return {
    startIso: start.toISOString(),
    endIso: new Date(start.getTime() + durationHours * 3_600_000).toISOString()
  };
}

test("infers a daytime primary sleep anchor for a night-shift patient", () => {
  const sessions: TherapyUsageSession[] = [];
  for (let day = 1; day <= 30; day += 1) {
    sessions.push(session(day, 8 + ((day % 3) - 1) * 0.25, 7));
    if (day % 2 === 0) sessions.push(session(day, 20, 1));
  }

  const profile = inferSleepTimingProfile(sessions);
  assert.ok(profile);
  assert.ok(profile.anchorMinutes >= 7 * 60 && profile.anchorMinutes <= 9 * 60);
  assert.equal(profile.confidence, "high");
  assert.equal(profile.scheduleDriftDetected, false);
});

test("classifies a separate nap outside the principal episode and excludes it from CMS four-hour use", () => {
  const history: TherapyUsageSession[] = [];
  for (let day = 1; day <= 20; day += 1) history.push(session(day, 22, 7));
  const profile = inferSleepTimingProfile(history);
  assert.ok(profile);

  const target = [session(21, 14, 1.5), session(21, 22, 3)];
  const result = classifyTherapySessions(target, profile);
  assert.equal(result.totalTherapyMinutes, 270);
  assert.equal(result.expectedSleepMinutes, 180);
  assert.equal(result.suspectedNapMinutes, 90);
  assert.equal(result.compliantDays, 0);
});

test("short therapy interruptions remain one principal episode", () => {
  const history = Array.from({ length: 14 }, (_, index) => session(index + 1, 22, 7));
  const profile = inferSleepTimingProfile(history);
  assert.ok(profile);
  const first = session(15, 22, 2);
  const secondStart = new Date(Date.parse(first.endIso) + 20 * 60_000);
  const result = classifyTherapySessions(
    [
      first,
      {
        startIso: secondStart.toISOString(),
        endIso: new Date(secondStart.getTime() + 2.5 * 3_600_000).toISOString()
      }
    ],
    profile
  );
  assert.equal(result.days[0].expectedSleepMinutes, 270);
  assert.equal(result.days[0].cmsFourHourUse, true);
});

test("a one-day outlier does not move the whole-period sleep anchor", () => {
  const sessions = Array.from({ length: 29 }, (_, index) => session(index + 1, 8, 7));
  sessions.push(session(30, 22, 10));
  const profile = inferSleepTimingProfile(sessions);
  assert.ok(profile);
  assert.ok(profile.anchorMinutes >= 7.5 * 60 && profile.anchorMinutes <= 8.5 * 60);
});

test("clock formatter handles circular daytime ranges", () => {
  assert.equal(formatClockMinutes(8 * 60), "8:00 AM");
  assert.equal(formatClockMinutes(22 * 60 + 5), "10:05 PM");
});

test("therapy duration formatter presents decimal hours as H:MM", () => {
  assert.equal(formatDurationHoursAsHmm(0.2), "0:12");
  assert.equal(formatDurationHoursAsHmm(2.033), "2:02");
});

function dayBucket(usageHours: number): PreparedDayBucket {
  return {
    usageSum: usageHours,
    usageCount: 1,
    ahiWeightedSum: 0,
    ahiWeightHours: 0,
    ahiSum: 1,
    ahiCount: 1,
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

test("report compliance excludes naps that make an aggregated day exceed four hours", () => {
  const therapySessions: TherapyUsageSession[] = [];
  const dayBuckets: Record<string, PreparedDayBucket> = {};
  for (let day = 1; day <= 30; day += 1) {
    therapySessions.push(session(day, 14, 1.5), session(day, 22, 3));
    dayBuckets[`2026-01-${String(day).padStart(2, "0")}`] = dayBucket(4.5);
  }
  const sleepTimingProfile = inferSleepTimingProfile(therapySessions);
  assert.ok(sleepTimingProfile);
  const prepared: PreparedQuickReportSource = {
    selectedLoader: "Fixture Loader",
    machine: { mode: "CPAP", pressure: "Fixed 8 cmH2O" },
    warnings: [],
    latestClinicalDayIso: "2026-01-30",
    maxLookbackDays: 30,
    therapySessions,
    sleepTimingProfile,
    dayBuckets
  };

  const report = buildQuickReportMetricsFromPreparedSource(prepared, {
    patientName: "Night Worker",
    dateOfBirthIso: "1970-01-01",
    physicianName: "",
    lookbackDays: 30,
    windowEndClinicalDayIso: "2026-01-31"
  });

  assert.equal(report.compliantDays, 0);
  assert.equal(report.compliancePercent, 0);
  assert.equal(report.expectedSleepTherapyHours, 90);
  assert.equal(report.suspectedNapTherapyHours, 45);
  assert.equal(report.avgExpectedSleepTherapyHours, 3);
  assert.equal(report.sleepTimingAnalysis?.method, "inferred-session-timing");
});

test("report falls back when session intervals materially exceed device-reported usage", () => {
  const therapySessions: TherapyUsageSession[] = [];
  const dayBuckets: Record<string, PreparedDayBucket> = {};
  for (let day = 1; day <= 10; day += 1) {
    therapySessions.push(session(day, 22, 6));
    dayBuckets[`2026-01-${String(day).padStart(2, "0")}`] = dayBucket(4);
  }
  const sleepTimingProfile = inferSleepTimingProfile(therapySessions);
  assert.ok(sleepTimingProfile);
  const prepared: PreparedQuickReportSource = {
    selectedLoader: "Inconsistent Fixture",
    machine: { mode: "CPAP", pressure: "Fixed 8 cmH2O" },
    warnings: [],
    latestClinicalDayIso: "2026-01-10",
    maxLookbackDays: 10,
    therapySessions,
    sleepTimingProfile,
    dayBuckets
  };

  const report = buildQuickReportMetricsFromPreparedSource(prepared, {
    patientName: "Fixture Patient",
    dateOfBirthIso: "1970-01-01",
    physicianName: "",
    lookbackDays: 10,
    windowEndClinicalDayIso: "2026-01-11"
  });

  assert.equal(report.sleepTimingAnalysis, null);
  assert.equal(report.compliantDays, 10);
  assert.equal(report.totalTherapyHours, 40);
  assert.ok(report.warnings.some((warning) => warning.includes("Session intervals exceeded device-reported therapy by 50%")));
});
