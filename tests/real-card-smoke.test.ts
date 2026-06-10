import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildQuickReportMetricsFromPreparedSource, prepareQuickReportSource } from "../lib/parser";
import { buildReportArtifactsFromPreparedSource } from "../lib/report-orchestrator";
import type { DataSourceKind } from "../lib/types";
import { createSourceFilesFromDirectory } from "./helpers/fs-source-files";

type FixtureExpectation = {
  selectedLoaderIncludes?: string;
  mode?: "CPAP" | "APAP" | "BiPAP";
  deviceIncludes?: string;
  pressure?: string;
  pressureMin?: string;
  pressureMax?: string;
  epap?: string;
  ipap?: string;
  minDaysWithData?: number;
  minDaysWithUsage?: number;
};

type FixtureManifestEntry = {
  name: string;
  path: string;
  sourceKind?: DataSourceKind;
  lookbackDays?: number;
  windowEndClinicalDayIso?: string;
  anchorToLatestData?: boolean;
  expect?: FixtureExpectation;
};

type FixtureManifest = {
  fixtures: FixtureManifestEntry[];
};

const DEFAULT_MANIFEST_PATH = path.resolve(
  process.cwd(),
  "tests/fixtures/real-cards.manifest.local.json"
);

async function loadManifest(): Promise<FixtureManifest | null> {
  const configuredPath = process.env.REAL_CARD_MANIFEST
    ? path.resolve(process.env.REAL_CARD_MANIFEST)
    : DEFAULT_MANIFEST_PATH;

  try {
    const raw = await fs.readFile(configuredPath, "utf-8");
    const parsed = JSON.parse(raw) as FixtureManifest;
    if (!parsed || !Array.isArray(parsed.fixtures)) {
      throw new Error(`Invalid manifest format in ${configuredPath}`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function assertIncludes(actual: string | undefined, expected: string | undefined, label: string) {
  if (!expected) return;
  assert.ok(actual, `${label} should be present`);
  assert.match(actual, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), label);
}

function assertExact(actual: string | undefined, expected: string | undefined, label: string) {
  if (!expected) return;
  assert.equal(actual, expected, label);
}

function addIsoDays(isoDate: string, days: number): string {
  const dt = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`Invalid ISO clinical day: ${isoDate}`);
  }
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

test("real card smoke fixtures import end-to-end", async (t) => {
  const manifest = await loadManifest();
  if (!manifest || manifest.fixtures.length === 0) {
    t.skip(
      `No local real-card manifest found. Create ${DEFAULT_MANIFEST_PATH} or set REAL_CARD_MANIFEST to enable this smoke suite.`
    );
    return;
  }

  for (const fixture of manifest.fixtures) {
    await t.test(fixture.name, async () => {
      const fixtureRoot = path.resolve(fixture.path);
      const files = await createSourceFilesFromDirectory(fixtureRoot);
      assert.ok(files.length > 0, `Fixture directory is empty: ${fixtureRoot}`);

      const prepared = await prepareQuickReportSource({
        sourceKind: fixture.sourceKind ?? "folder",
        files,
        lookbackDays: fixture.lookbackDays ?? 90
      });

      assert.ok(prepared.selectedLoader, "selected loader should be set");
      assert.ok(Object.keys(prepared.dayBuckets).length > 0, "prepared day buckets should not be empty");

      const metrics = buildQuickReportMetricsFromPreparedSource(prepared, {
        patientName: "Fixture Patient",
        dateOfBirthIso: "1970-01-01",
        physicianName: "",
        lookbackDays: fixture.lookbackDays ?? 90,
        windowEndClinicalDayIso: fixture.anchorToLatestData
          ? addIsoDays(prepared.latestClinicalDayIso, 1)
          : fixture.windowEndClinicalDayIso
      });

      const expectation = fixture.expect ?? {};
      assertIncludes(prepared.selectedLoader, expectation.selectedLoaderIncludes, "selected loader");
      assertExact(metrics.machine.mode, expectation.mode, "therapy mode");
      assertIncludes(metrics.machine.device, expectation.deviceIncludes, "device");
      assertExact(metrics.machine.pressure, expectation.pressure, "pressure");
      assertExact(metrics.machine.pressureMin, expectation.pressureMin, "pressure min");
      assertExact(metrics.machine.pressureMax, expectation.pressureMax, "pressure max");
      assertExact(metrics.machine.epap, expectation.epap, "epap");
      assertExact(metrics.machine.ipap, expectation.ipap, "ipap");

      if (typeof expectation.minDaysWithData === "number") {
        assert.ok(
          metrics.daysWithData >= expectation.minDaysWithData,
          `expected at least ${expectation.minDaysWithData} days with data, got ${metrics.daysWithData}`
        );
      }

      if (typeof expectation.minDaysWithUsage === "number") {
        assert.ok(
          metrics.daysWithUsage >= expectation.minDaysWithUsage,
          `expected at least ${expectation.minDaysWithUsage} days with usage, got ${metrics.daysWithUsage}`
        );
      }

      const reportResult = await buildReportArtifactsFromPreparedSource({
        prepared,
        patientName: "Fixture Patient",
        dateOfBirthIso: "1970-01-01",
        physicianName: "",
        reportRanges: [7]
      });
      assert.equal(reportResult.reports.length, 1, "expected the card data to generate a 7-day report");
      assert.equal(reportResult.largestAvailableRange, 7);
      assert.ok(reportResult.reports[0].blob.size > 0, "generated PDF should not be empty");
    });
  }
});
