import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyReportTherapyLayout,
  classifyTherapyMode,
  resolveExplicitTherapyMode,
  type CanonicalTherapyMode,
  type ReportTherapyLayout
} from "../lib/machine-mode";
import {
  applyResMedCurrentSettingsJson,
  inferResMedModeFromSignals,
  inferResMedModeFromSettingsProfile,
  mapResMedModeCode
} from "../lib/parsers/resmed";
import type { QuickReportMetrics } from "../lib/types";

function machine(overrides: Partial<QuickReportMetrics["machine"]>): QuickReportMetrics["machine"] {
  return { ...overrides };
}

test("shared mode resolver preserves explicit mode precedence", () => {
  const cases: Array<{
    label: string;
    machine: QuickReportMetrics["machine"];
    expected: CanonicalTherapyMode | null;
  }> = [
    {
      label: "explicit CPAP beats stray auto fields",
      machine: machine({
        mode: "CPAP",
        pressureMin: "4 cmH2O",
        pressureMax: "12 cmH2O",
        pressureIsAuto: true
      }),
      expected: "CPAP"
    },
    {
      label: "explicit APAP beats stray bilevel fields",
      machine: machine({
        mode: "APAP",
        epap: "6 cmH2O",
        ipap: "10 cmH2O"
      }),
      expected: "APAP"
    },
    {
      label: "explicit BiPAP beats stray APAP fields",
      machine: machine({
        mode: "BiPAP",
        pressureMin: "8 cmH2O",
        pressureMax: "12 cmH2O"
      }),
      expected: "BiPAP"
    }
  ];

  for (const entry of cases) {
    assert.equal(classifyTherapyMode(entry.machine), entry.expected, entry.label);
  }
});

test("shared mode resolver handles representative family output shapes", () => {
  const cases: Array<{
    family: string;
    machine: QuickReportMetrics["machine"];
    expected: CanonicalTherapyMode | null;
  }> = [
    {
      family: "PRS1 fixed CPAP",
      machine: machine({ pressure: "Fixed 9 cmH2O" }),
      expected: "CPAP"
    },
    {
      family: "BMC/Luna APAP range",
      machine: machine({
        pressureIsAuto: true,
        pressureMin: "8.5 cmH2O",
        pressureMax: "11 cmH2O"
      }),
      expected: "APAP"
    },
    {
      family: "Prisma BiPAP range",
      machine: machine({
        epap: "6 cmH2O",
        ipap: "10 cmH2O"
      }),
      expected: "BiPAP"
    },
    {
      family: "AVAPS target volume",
      machine: machine({
        tidalVolume: "500 mL"
      }),
      expected: "BiPAP"
    },
    {
      family: "IntelliPAP APAP",
      machine: machine({
        mode: "APAP",
        pressureMin: "6 cmH2O",
        pressureMax: "14 cmH2O",
        pressureIsAuto: true
      }),
      expected: "APAP"
    },
    {
      family: "SleepStyle CPAP",
      machine: machine({
        mode: "CPAP",
        pressure: "Fixed 8 cmH2O"
      }),
      expected: "CPAP"
    },
    {
      family: "VREM APAP",
      machine: machine({
        pressureMin: "4 cmH2O",
        pressureMax: "12 cmH2O",
        pressureIsAuto: true
      }),
      expected: "APAP"
    }
  ];

  for (const entry of cases) {
    assert.equal(classifyTherapyMode(entry.machine), entry.expected, entry.family);
  }
});

test("explicit mode parsing recognizes canonical variants", () => {
  const cases: Array<{ rawMode: string; expected: CanonicalTherapyMode | null }> = [
    { rawMode: "CPAP", expected: "CPAP" },
    { rawMode: "AutoSet", expected: "APAP" },
    { rawMode: "Auto CPAP", expected: "APAP" },
    { rawMode: "VAuto", expected: "BiPAP" },
    { rawMode: "BiLevel", expected: "BiPAP" },
    { rawMode: "Lumis 150 VPAP ST-A", expected: "BiPAP" }
  ];

  for (const entry of cases) {
    assert.equal(resolveExplicitTherapyMode(entry.rawMode), entry.expected, entry.rawMode);
  }
});

test("report layout classifier separates CPAP-style and BiPAP-style reports up front", () => {
  const cases: Array<{
    label: string;
    machine: QuickReportMetrics["machine"];
    expected: ReportTherapyLayout;
  }> = [
    {
      label: "fixed CPAP",
      machine: machine({ mode: "CPAP", pressure: "Fixed 9 cmH2O" }),
      expected: "one-page-cpap"
    },
    {
      label: "APAP pressure range",
      machine: machine({ mode: "APAP", pressureIsAuto: true, pressureMin: "8 cmH2O", pressureMax: "12 cmH2O" }),
      expected: "one-page-cpap"
    },
    {
      label: "Resvent Auto S30 CPAP-layout report",
      machine: machine({
        mode: "Auto S30",
        pressureIsAuto: true,
        pressureMin: "4 cmH2O",
        pressureMax: "12 cmH2O",
        epap: "6 cmH2O",
        ipap: "10 cmH2O"
      }),
      expected: "one-page-cpap"
    },
    {
      label: "ResMed VAuto",
      machine: machine({ mode: "VAuto", epap: "7 cmH2O", ipap: "11 cmH2O" }),
      expected: "two-page-bipap"
    },
    {
      label: "evidence-only BiPAP",
      machine: machine({ epap: "7 cmH2O", ipap: "11 cmH2O" }),
      expected: "two-page-bipap"
    }
  ];

  for (const entry of cases) {
    assert.equal(classifyReportTherapyLayout(entry.machine), entry.expected, entry.label);
  }
});

test("ResMed mode codes are mapped with series-aware logic", () => {
  const cases: Array<{ modeCode: number; device: string; expected: CanonicalTherapyMode | null }> = [
    { modeCode: 0, device: "AirSense 10 Elite", expected: "CPAP" },
    { modeCode: 1, device: "AirSense 10 AutoSet", expected: "APAP" },
    { modeCode: 3, device: "AirSense 11 AutoSet", expected: "CPAP" },
    { modeCode: 8, device: "AirCurve 11 VAuto", expected: "BiPAP" }
  ];

  for (const entry of cases) {
    assert.equal(mapResMedModeCode(entry.modeCode, entry.device), entry.expected, `${entry.device} mode ${entry.modeCode}`);
  }
});

test("ResMed falls back to pressure-setting signals when explicit mode is missing", () => {
  const cases: Array<{
    label: string;
    values: Parameters<typeof inferResMedModeFromSignals>[0];
    expected: CanonicalTherapyMode | null;
  }> = [
    {
      label: "fixed set pressure => CPAP",
      values: { setPressure: 9.5 },
      expected: "CPAP"
    },
    {
      label: "min/max pressure => APAP",
      values: { minPressure: 8.5, maxPressure: 11 },
      expected: "APAP"
    },
    {
      label: "epap/ipap => BiPAP",
      values: { epap: 6, ipap: 10 },
      expected: "BiPAP"
    },
    {
      label: "ps over min/max epap/ipap => BiPAP",
      values: { minEpap: 6, maxIpap: 15, ps: 4 },
      expected: "BiPAP"
    }
  ];

  for (const entry of cases) {
    assert.equal(inferResMedModeFromSignals(entry.values), entry.expected, entry.label);
  }
});

test("ResMed settings-profile mode resolution covers AirSense 10 and 11 variants", () => {
  const cases: Array<{
    label: string;
    profileName?: string;
    therapyMode?: string;
    device?: string;
    expected: CanonicalTherapyMode | null;
  }> = [
    {
      label: "AirSense 11 AutoSet profile => APAP",
      profileName: "AutoSetProfile",
      therapyMode: "AutoSet",
      device: "AirSense 11 AutoSet",
      expected: "APAP"
    },
    {
      label: "AirSense 11 Cpap profile => CPAP",
      profileName: "CpapProfile",
      therapyMode: "CPAP",
      device: "AirSense 11 AutoSet",
      expected: "CPAP"
    },
    {
      label: "AirSense 10 AutoSet for Her => APAP",
      profileName: "AutoSetForHerProfile",
      therapyMode: "HerAuto",
      device: "AirSense 10 AutoSet for Her",
      expected: "APAP"
    },
    {
      label: "AirCurve 10 VAuto => BiPAP",
      profileName: "VAutoProfile",
      therapyMode: "VAuto",
      device: "AirCurve 10 VAuto",
      expected: "BiPAP"
    }
  ];

  for (const entry of cases) {
    assert.equal(
      inferResMedModeFromSettingsProfile(entry.profileName, entry.therapyMode, entry.device),
      entry.expected,
      entry.label
    );
  }
});

test("ResMed CurrentSettings.json is treated as authoritative for active therapy profile", () => {
  const cases: Array<{
    label: string;
    json: string;
    expected: QuickReportMetrics["machine"];
  }> = [
    {
      label: "AirSense 11 active CPAP profile",
      json: JSON.stringify({
        FlowGenerator: {
          SettingProfiles: {
            ActiveProfiles: { TherapyProfile: "CpapProfile" },
            TherapyProfiles: {
              AutoSetProfile: { TherapyMode: "AutoSet", MinPressure: 7.4, MaxPressure: 9.4 },
              CpapProfile: { TherapyMode: "CPAP", SetPressure: 7.2 }
            }
          }
        }
      }),
      expected: { mode: "CPAP", pressure: "Fixed 7.2 cmH2O" }
    },
    {
      label: "AirSense 10 AutoSet for Her profile",
      json: JSON.stringify({
        FlowGenerator: {
          SettingProfiles: {
            ActiveProfiles: { TherapyProfile: "AutoSetForHerProfile" },
            TherapyProfiles: {
              AutoSetForHerProfile: { TherapyMode: "HerAuto", MinPressure: 8.5, MaxPressure: 11 }
            }
          }
        }
      }),
      expected: { mode: "APAP", pressureMin: "8.5 cmH2O", pressureMax: "11 cmH2O", pressureIsAuto: true }
    },
    {
      label: "AirCurve 10 VAuto profile",
      json: JSON.stringify({
        FlowGenerator: {
          SettingProfiles: {
            ActiveProfiles: { TherapyProfile: "VAutoProfile" },
            TherapyProfiles: {
              VAutoProfile: {
                TherapyMode: "VAuto",
                MinEPAP: 6,
                MaxIPAP: 14,
                PressureSupport: 4,
                TargetVt: 0.56
              }
            }
          }
        }
      }),
      expected: {
        mode: "VAuto",
        epap: "6 cmH2O",
        ipap: "14 cmH2O",
        pressureMin: "6 cmH2O",
        pressureMax: "14 cmH2O",
        pressureRelief: "PS: 4 cmH2O",
        tidalVolume: "560 mL",
        pressureIsAuto: true
      }
    }
  ];

  for (const entry of cases) {
    const target = machine({});
    const metadata = { sourceTimeZoneOffsetMinutes: null };
    assert.equal(applyResMedCurrentSettingsJson(entry.json, target, metadata), true, entry.label);
    for (const [key, value] of Object.entries(entry.expected)) {
      assert.equal((target as Record<string, unknown>)[key], value, `${entry.label} -> ${key}`);
    }
  }
});

test("ResMed CurrentSettings.json exposes an explicit UTC offset when present", () => {
  const target = machine({});
  const metadata = { sourceTimeZoneOffsetMinutes: null };
  const json = JSON.stringify({
    FlowGenerator: {
      SettingProfiles: {
        ActiveProfiles: { TherapyProfile: "CpapProfile" },
        TherapyProfiles: {
          CpapProfile: { TherapyMode: "CPAP", SetPressure: 7.2 }
        },
        FeatureProfiles: {
          TimeZoneFeature: {
            TimeZoneOffset: "-08:00"
          }
        }
      }
    }
  });

  assert.equal(applyResMedCurrentSettingsJson(json, target, metadata), true);
  assert.equal(metadata.sourceTimeZoneOffsetMinutes, -480);
});
