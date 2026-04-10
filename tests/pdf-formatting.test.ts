import assert from "node:assert/strict";
import test from "node:test";

import { formatReportMetricValue } from "../lib/pdf";

test("report metric formatter rounds summary values to tenths", () => {
  assert.equal(formatReportMetricValue(2.24), "2.2");
  assert.equal(formatReportMetricValue(2.25), "2.3");
  assert.equal(formatReportMetricValue(117.4), "117.4");
  assert.equal(formatReportMetricValue(null), "Data point not available");
});
