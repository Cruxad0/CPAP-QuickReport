import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildQuickReportMetricsFromPreparedSource, prepareQuickReportSource } from "../lib/parser";
import { createSourceFilesFromDirectory } from "./helpers/fs-source-files";

const DREAMSTATION_SAMPLE_PATH = path.join(process.cwd(), "Card Samples", "Dreamstation");

const maybeTest = existsSync(DREAMSTATION_SAMPLE_PATH) ? test : test.skip;

maybeTest("DreamStation real-card sample parses from LAST.TXT-selected active root", async () => {
  const files = await createSourceFilesFromDirectory(DREAMSTATION_SAMPLE_PATH);
  const prepared = await prepareQuickReportSource({
    sourceKind: "folder",
    files
  });

  assert.equal(prepared.selectedLoader, "Philips Respironics System One / DreamStation");
  assert.equal(prepared.machine.mode, "APAP");
  assert.equal(prepared.machine.pressureMin, "10 cmH2O");
  assert.equal(prepared.machine.pressureMax, "16 cmH2O");
  assert.equal(prepared.machine.pressureRelief, "Flex: Off");
  assert.equal(prepared.latestClinicalDayIso, "2026-03-25");

  const nextClinicalDayIso = new Date(new Date(`${prepared.latestClinicalDayIso}T00:00:00Z`).getTime() + 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);

  const metrics = buildQuickReportMetricsFromPreparedSource(prepared, {
    patientName: "Test",
    dateOfBirthIso: "1970-01-01",
    physicianName: "",
    lookbackDays: 7,
    windowEndClinicalDayIso: nextClinicalDayIso
  });

  assert.equal(metrics.machine.mode, "APAP");
  assert.equal(metrics.daysWithData, 7);
  assert.equal(metrics.daysWithUsage, 7);
  assert.equal(metrics.compliantDays, 7);
  assert.ok((metrics.avgUsageHours ?? 0) > 8);
  assert.ok((metrics.avgAhi ?? 0) > 0);
  assert.ok((metrics.avgLeak ?? 0) > 0);
  assert.ok((metrics.avgLeak ?? 999) < 40);
});
