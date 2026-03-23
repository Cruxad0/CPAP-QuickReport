import type { FamilyParserContext, FamilyParserDeps } from "@/lib/parsers/text-family-types";
import type { ParsedRecord } from "@/lib/types";

type IconAggregate = {
  date: Date;
  usageHours?: number;
  pressureSum: number;
  pressureCount: number;
  leakSum: number;
  leakCount: number;
  leakMax: number | null;
  leakSeries: number[];
  obstructiveApneas: number;
  hypopneas: number;
};

function maxRollingAverage(values: number[], samples: number): number | undefined {
  if (samples <= 0 || values.length < samples) return undefined;
  let windowSum = 0;
  let maxAverage = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    windowSum += values[i];
    if (i >= samples) windowSum -= values[i - samples];
    if (i >= samples - 1) {
      const average = windowSum / samples;
      if (average > maxAverage) maxAverage = average;
    }
  }
  return Number.isFinite(maxAverage) ? maxAverage : undefined;
}

function decodeAscii(bytes: Uint8Array): string {
  return new TextDecoder("ascii", { fatal: false }).decode(bytes);
}

function decodeIconTimestamp(raw: number): Date | null {
  const day = raw & 0x1f;
  const month = (raw >> 5) & 0x0f;
  const year = 2000 + ((raw >> 9) & 0x3f);
  const shifted = raw >> 15;
  const second = shifted & 0x3f;
  const minute = (shifted >> 6) & 0x3f;
  const hour = shifted >> 12;
  const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (Number.isNaN(dt.getTime())) return null;
  dt.setUTCSeconds(dt.getUTCSeconds() - 54);
  return dt;
}

function parseHeaderFields(bytes: Uint8Array): string[] {
  return decodeAscii(bytes.subarray(0, 0x200)).split(/\s+/).filter(Boolean);
}

function getAggregate(map: Map<number, IconAggregate>, date: Date): IconAggregate {
  const key = date.getTime();
  const existing = map.get(key);
  if (existing) return existing;
  const created: IconAggregate = {
    date,
    pressureSum: 0,
    pressureCount: 0,
    leakSum: 0,
    leakCount: 0,
    leakMax: null,
    leakSeries: [],
    obstructiveApneas: 0,
    hypopneas: 0
  };
  map.set(key, created);
  return created;
}

function parseIconSummary(bytes: Uint8Array, aggregates: Map<number, IconAggregate>, machine: FamilyParserContext["machine"]) {
  if (bytes.length < 0x200) return;
  const fields = parseHeaderFields(bytes);
  const model = fields[4] ?? "ICON";
  const type = fields[5] ?? "";
  if (!machine.device) machine.device = `${model} ${type}`.trim();

  const data = bytes.subarray(0x200);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;

  while (pos + 29 <= data.length) {
    const tsRaw = view.getUint32(pos, true);
    pos += 4;
    if (tsRaw === 0xffffffff || (tsRaw & 0xfafe) === 0xfafe) break;

    const date = decodeIconTimestamp(tsRaw);
    if (!date) break;

    const runTime = data[pos++];
    const useTime = data[pos++];
    pos += 3; // a3 a4 a5
    pos += 6; // d1 d2 d3
    const p1 = data[pos++];
    const p2 = data[pos++];
    pos += 1; // j1
    const obstructive = data[pos++];
    const hypopnea = data[pos++];
    pos += 4; // j4..j7
    const p3 = data[pos++];
    const p4 = data[pos++];
    pos += 1; // p5
    pos += 1; // x1
    const humidifier = data[pos++];

    const aggregate = getAggregate(aggregates, date);
    const usageHours = useTime / 10;
    if (!aggregate.usageHours || usageHours > aggregate.usageHours) aggregate.usageHours = usageHours;
    aggregate.obstructiveApneas += obstructive;
    aggregate.hypopneas += hypopnea;

    if (!machine.mode) {
      if (p1 !== p2) {
        machine.mode = "APAP";
        machine.pressureIsAuto = true;
        machine.pressureMin = `${(p3 / 10).toFixed(1).replace(/\.0$/, "")} cmH2O`;
        machine.pressureMax = `${(p4 / 10).toFixed(1).replace(/\.0$/, "")} cmH2O`;
      } else {
        machine.mode = "CPAP";
        machine.pressure = `Fixed ${(p1 / 10).toFixed(1).replace(/\.0$/, "")} cmH2O`;
      }
    }

    void runTime;
    void humidifier;
  }
}

function parseIconDetail(bytes: Uint8Array, aggregates: Map<number, IconAggregate>) {
  if (bytes.length < 0xa00) return;

  const index = bytes.subarray(0x200, 0xa00);
  const data = bytes.subarray(0xa00);
  const indexView = new DataView(index.buffer, index.byteOffset, index.byteLength);

  let pos = 0;
  while (pos + 7 <= index.length) {
    const tsRaw = indexView.getUint32(pos, true);
    pos += 4;
    if (tsRaw === 0xffffffff || (tsRaw & 0xfafe) === 0xfafe) break;

    const date = decodeIconTimestamp(tsRaw);
    if (!date) break;

    const startBlock = indexView.getUint16(pos, true);
    pos += 2;
    const records = index[pos];
    pos += 1;

    const aggregate = getAggregate(aggregates, date);
    let dataPos = startBlock * 15;

    for (let i = 0; i < records; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        if (dataPos + 5 > data.length) return;
        const pressure = data[dataPos] / 10;
        const leak = data[dataPos + 1];
        const a1 = data[dataPos + 2];
        const a2 = data[dataPos + 3];

        aggregate.pressureSum += pressure;
        aggregate.pressureCount += 1;
        aggregate.leakSum += leak;
        aggregate.leakCount += 1;
        aggregate.leakSeries.push(leak);
        if (aggregate.leakMax === null || leak > aggregate.leakMax) aggregate.leakMax = leak;

        for (let mask = 1; mask <= 0x20; mask <<= 1) {
          if (a1 & mask) aggregate.obstructiveApneas += 1;
          if (a2 & mask) aggregate.hypopneas += 1;
        }

        dataPos += 5;
      }
    }
  }
}

function finalizeRecords(aggregates: Map<number, IconAggregate>): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  for (const aggregate of aggregates.values()) {
    const usageHours = aggregate.usageHours;
    const pressureAvg = aggregate.pressureCount > 0 ? aggregate.pressureSum / aggregate.pressureCount : undefined;
    const leak = aggregate.leakCount > 0 ? aggregate.leakSum / aggregate.leakCount : undefined;
    const leakMax30m = maxRollingAverage(aggregate.leakSeries, 15);
    const leakMax60m = maxRollingAverage(aggregate.leakSeries, 30);
    const ahi = usageHours && usageHours > 0 ? (aggregate.obstructiveApneas + aggregate.hypopneas) / usageHours : undefined;

    records.push({
      date: aggregate.date,
      usageHours,
      ahi,
      residualApneas: usageHours && usageHours > 0 ? aggregate.obstructiveApneas / usageHours : undefined,
      leak,
      leakMax: aggregate.leakMax ?? undefined,
      leakMax30m,
      leakMax60m,
      pressureAvg
    });
  }
  return records;
}

export async function parseIconFamily(context: FamilyParserContext, deps: FamilyParserDeps): Promise<void> {
  const aggregates = new Map<number, IconAggregate>();
  let processed = 0;

  for (const candidate of context.candidates) {
    processed += 1;
    const pct =
      context.progressStart +
      Math.round((processed / Math.max(1, context.candidates.length)) * (context.progressEnd - context.progressStart));

    deps.emit(context.onProgress, {
      phase: "parse",
      detail: `Reading ${candidate.normalizedPath}`,
      percent: Math.min(context.progressEnd, pct)
    });

    try {
      const lowerPath = candidate.normalizedPath.toLowerCase();
      const bytes = await candidate.file.readBytes();
      if (/sum.*\.fph$/i.test(lowerPath)) parseIconSummary(bytes, aggregates, context.machine);
      else if (/det.*\.fph$/i.test(lowerPath)) parseIconDetail(bytes, aggregates);
    } catch {
      continue;
    }

    if (processed % 3 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  context.records.push(...finalizeRecords(aggregates));
  if (!context.machine.device) context.machine.device = "ICON";
}
