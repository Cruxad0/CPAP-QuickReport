import { runTextFamilyParser } from "@/lib/parsers/text-family-runner";
import type { FamilyParserCandidate, FamilyParserContext, FamilyParserDeps } from "@/lib/parsers/text-family-types";
import type { ParsedRecord, QuickReportMetrics } from "@/lib/types";

type WeinmannEntry = {
  date: Date;
  therapySessionStart?: Date;
  therapySessionEnd?: Date;
  usageHours?: number;
  pressureAvg?: number;
  pressure95th?: number;
  residualApneas?: number;
  ahi?: number;
};

const DAY_ENTRY_SIZE = 0xd6;

function decodeAscii(bytes: Uint8Array): string {
  return new TextDecoder("ascii", { fatal: false }).decode(bytes);
}

function le32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const blend = idx - lo;
  return sorted[lo] * (1 - blend) + sorted[hi] * blend;
}

function parseWeinmannDate(bytes: Uint8Array, offset: number): Date | null {
  const year = (bytes[offset] ?? 0) * 100 + (bytes[offset + 1] ?? 0);
  const month = bytes[offset + 2] ?? 0;
  const day = bytes[offset + 3] ?? 0;
  const hour = bytes[offset + 5] ?? 0;
  const minute = bytes[offset + 6] ?? 0;
  const second = bytes[offset + 7] ?? 0;
  const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function extractIndexMap(bytes: Uint8Array): Map<string, number> {
  const prefix = decodeAscii(bytes.subarray(0, Math.min(bytes.length, 131072)));
  const out = new Map<string, number>();
  const pattern = /name="([^"]+)"[^>]*val="(\d+)"/gi;
  for (const match of prefix.matchAll(pattern)) {
    out.set(match[1], Number(match[2]));
  }
  return out;
}

function inferWeinmannMachineSettingsFromText(text: string, machine: QuickReportMetrics["machine"], deps: FamilyParserDeps) {
  if (!machine.device) {
    if (/somnobalance/i.test(text)) machine.device = "Somnobalance";
    else if (/somnosoft2/i.test(text)) machine.device = "SOMNOsoft2";
    else if (/prisma/i.test(text)) machine.device = "Loewenstein";
    else if (/weinmann/i.test(text)) machine.device = "Weinmann";
  }

  const kv = deps.parseKeyValueLines(text);
  const modeRaw = kv.get("mode") ?? kv.get("Mode") ?? kv.get("therapy mode");
  if (!machine.mode && modeRaw) {
    if (/\b(?:auto|apap|balance)\b/i.test(modeRaw)) machine.mode = "APAP";
    else if (/\b(?:bilevel|bipap|st)\b/i.test(modeRaw)) machine.mode = "BiPAP";
    else if (/\bcpap\b/i.test(modeRaw)) machine.mode = "CPAP";
  }

  if (!machine.mode) {
    if (/somnobalance/i.test(text)) machine.mode = "APAP";
    else if (/somnosoft/i.test(text)) machine.mode = "CPAP";
  }
}

function countEvents(bytes: Uint8Array, start: number, records: number): { oa: number; apnea: number; hyp: number } {
  let oa = 0;
  let apnea = 0;
  let hyp = 0;
  let pos = start;

  for (let i = 0; i < records && pos + 6 <= bytes.length; i += 1) {
    const evcode = bytes[pos];
    if (evcode === 0x40) oa += 1; // '@'
    else if (evcode === 0x41) apnea += 1; // 'A'
    else if (evcode === 0x2a) hyp += 1; // '*'
    pos += 6;
  }

  return { oa, apnea, hyp };
}

function buildEntry(bytes: Uint8Array, offset: number): WeinmannEntry | null {
  const date = parseWeinmannDate(bytes, offset);
  if (!date) return null;

  const flowStart = le32(bytes, offset + 8);
  const pressureStart = le32(bytes, offset + 16);
  const eventStart = le32(bytes, offset + 24);
  const flowSize = le32(bytes, offset + 0x44);
  const pressureSize = le32(bytes, offset + 0x4c);
  const eventRecords = le32(bytes, offset + 0x54);

  if (flowStart >= bytes.length || pressureStart >= bytes.length || eventStart >= bytes.length) return null;

  const usageHours = flowSize > 0 ? flowSize / 5 / 3600 : undefined;

  const pressureEnd = Math.min(bytes.length, pressureStart + pressureSize);
  const pressureValues = [...bytes.subarray(pressureStart, pressureEnd)]
    .map((value) => value / 10)
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 40);

  const pressureAvg = pressureValues.length > 0 ? pressureValues.reduce((sum, value) => sum + value, 0) / pressureValues.length : undefined;
  const pressure95th = pressureValues.length > 0 ? percentile(pressureValues, 95) : undefined;

  const { oa, apnea, hyp } = countEvents(bytes, eventStart, eventRecords);
  const residualApneaCount = oa + apnea;
  const ahi = usageHours && usageHours > 0 ? (residualApneaCount + hyp) / usageHours : undefined;

  return {
    date,
    therapySessionStart: usageHours && usageHours > 0 ? date : undefined,
    therapySessionEnd: usageHours && usageHours > 0 ? new Date(date.getTime() + usageHours * 3_600_000) : undefined,
    usageHours,
    pressureAvg,
    pressure95th,
    residualApneas: usageHours && usageHours > 0 ? residualApneaCount / usageHours : undefined,
    ahi
  };
}

function parseWeinmannBinary(bytes: Uint8Array, machine: QuickReportMetrics["machine"], deps: FamilyParserDeps): ParsedRecord[] {
  const index = extractIndexMap(bytes);
  if (index.size === 0) return [];

  inferWeinmannMachineSettingsFromText(decodeAscii(bytes.subarray(0, Math.min(bytes.length, 131072))), machine, deps);

  const compStart = index.get("DayComplianceOffset");
  const flowOffset = index.get("TID_Flow_Offset");
  if (compStart === undefined || flowOffset === undefined || flowOffset <= compStart) return [];

  const records: ParsedRecord[] = [];
  for (let offset = compStart; offset + DAY_ENTRY_SIZE <= flowOffset; offset += DAY_ENTRY_SIZE) {
    const entry = buildEntry(bytes, offset);
    if (!entry) continue;
    if (entry.usageHours !== undefined && (entry.usageHours <= 0 || entry.usageHours > 24)) continue;
    records.push(entry);
  }

  return records;
}

export async function parseWeinmannFamily(context: FamilyParserContext, deps: FamilyParserDeps): Promise<void> {
  const binaryCandidates = context.candidates.filter((candidate) => /(?:^|\/)wm_data\.tdf$/i.test(candidate.normalizedPath));

  for (const candidate of binaryCandidates) {
    deps.emit(context.onProgress, {
      phase: "parse",
      detail: `Reading ${candidate.normalizedPath}`,
      percent: Math.min(context.progressEnd, context.progressStart + 4)
    });

    try {
      const bytes = await candidate.file.readBytes();
      const binaryRecords = parseWeinmannBinary(bytes, context.machine, deps);
      if (binaryRecords.length > 0) {
        context.records.push(...binaryRecords);
        return;
      }
    } catch {
      // Fall through to family-scoped text parsing.
    }
  }

  const textCandidates = context.candidates.filter((candidate) =>
    /\.(?:txt|csv|json|xml|log)$/i.test(candidate.baseName)
  );
  if (textCandidates.length === 0) return;

  await runTextFamilyParser(
    {
      ...context,
      candidates: textCandidates
    },
    deps,
    {
      inferFamilyMachineSettings: (text, _candidate, machine, familyDeps) => {
        inferWeinmannMachineSettingsFromText(text, machine, familyDeps);
      }
    }
  );
}
