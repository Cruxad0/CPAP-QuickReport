import assert from "node:assert/strict";
import test from "node:test";

import { daysSinceIsoDate, staleDataAgeClassName, staleDataSeverity } from "../lib/stale-data";

test("Resvent April 8 data shows the more-than-7-days notice on May 1", () => {
  const daysOld = daysSinceIsoDate("2026-04-08", new Date(2026, 4, 1, 12));

  assert.equal(daysOld, 23);
  assert.equal(staleDataSeverity(daysOld), "notice");
  assert.equal(staleDataAgeClassName(staleDataSeverity(daysOld)), "stale-data-age stale-data-age-notice");
});

test("ResMed 3 June 11 2025 data shows the critical stale warning on May 1 2026", () => {
  const daysOld = daysSinceIsoDate("2025-06-11", new Date(2026, 4, 1, 12));

  assert.equal(daysOld, 324);
  assert.equal(staleDataSeverity(daysOld), "critical");
  assert.equal(staleDataAgeClassName(staleDataSeverity(daysOld)), "stale-data-age stale-data-age-critical");
});

test("stale warning thresholds apply by source age only", () => {
  assert.equal(staleDataSeverity(7), null);
  assert.equal(staleDataSeverity(8), "notice");
  assert.equal(staleDataAgeClassName(staleDataSeverity(8)), "stale-data-age stale-data-age-notice");

  assert.equal(staleDataSeverity(30), "notice");
  assert.equal(staleDataSeverity(31), "warning");
  assert.equal(staleDataAgeClassName(staleDataSeverity(31)), "stale-data-age stale-data-age-warning");

  assert.equal(staleDataSeverity(90), "warning");
  assert.equal(staleDataSeverity(91), "critical");
  assert.equal(staleDataAgeClassName(staleDataSeverity(91)), "stale-data-age stale-data-age-critical");
});
