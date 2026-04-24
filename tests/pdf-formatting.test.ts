import assert from "node:assert/strict";
import test from "node:test";

import { formatReportMetricValue, shouldDisplayRespiratoryRate } from "../lib/pdf";

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
