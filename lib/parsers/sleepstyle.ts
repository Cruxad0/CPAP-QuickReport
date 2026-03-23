import type { FamilyParserContext, FamilyParserDeps } from "@/lib/parsers/text-family-types";
import type { ParsedRecord } from "@/lib/types";

type SleepStyleAggregate = {
  date: Date;
  usageHours?: number;
  pressure95th?: number;
  pressureSum: number;
  pressureCount: number;
  leakSum: number;
  leakCount: number;
  leakMax: number | null;
  obstructiveApneas: number;
  centralApneas: number;
  hypopneas: number;
};

function decodeAscii(bytes: Uint8Array): string {
  return new TextDecoder("ascii", { fatal: false }).decode(bytes);
}

function decodeSleepStyleTimestamp(raw: number): Date | null {
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

function getAggregate(map: Map<number, SleepStyleAggregate>, date: Date): SleepStyleAggregate {
  const key = date.getTime();
  const existing = map.get(key);
  if (existing) return existing;
  const created: SleepStyleAggregate = {
    date,
    pressureSum: 0,
    pressureCount: 0,
    leakSum: 0,
    leakCount: 0,
    leakMax: null,
    obstructiveApneas: 0,
    centralApneas: 0,
    hypopneas: 0
  };
  map.set(key, created);
  return created;
}

function parseHeaderFields(bytes: Uint8Array): string[] {
  return decodeAscii(bytes.subarray(0, 0x200)).split(/\s+/).filter(Boolean);
}

function applySleepStyleHeader(fields: string[], machine: FamilyParserContext["machine"]) {
  const model = fields[4] ?? "SleepStyle";
  const type = fields[5] ?? "";
  const typeLabel = type.length > 3 && type[3] === "C" ? "CPAP" : "Auto";
  if (!machine.device) machine.device = `${model} ${typeLabel}`.trim();
}

function parseSleepStyleSummary(bytes: Uint8Array, aggregates: Map<number, SleepStyleAggregate>, machine: FamilyParserContext["machine"]) {
  if (bytes.length < 0x200) return;
  const fields = parseHeaderFields(bytes);
  applySleepStyleHeader(fields, machine);

  const data = bytes.subarray(0x200);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;

  while (pos + 39 <= data.length) {
    const tsRaw = view.getUint32(pos, true);
    pos += 4;
    if (tsRaw === 0xffffffff || (tsRaw & 0xffff) === 0xfafe) break;

    const date = decodeSleepStyleTimestamp(tsRaw);
    if (!date) break;

    const runTime = data[pos++];
    const useTime = data[pos++];
    const minPressSeen = data[pos++];
    const pct95PressSeen = data[pos++];
    const maxPressSeen = data[pos++];
    pos += 6; // d1..d6
    pos += 8; // c1..c4
    pos += 1; // j1
    const modeByte = data[pos++];
    const ramp = data[pos++];
    pos += 2; // x1 x2
    const cpapPressure = data[pos++];
    const minPressureSet = data[pos++];
    const maxPressureSet = data[pos++];
    const sensAwake = data[pos++];
    const humidity = data[pos++];
    const eprLevel = data[pos++];
    const flags = data[pos++];
    pos += 5;

    const aggregate = getAggregate(aggregates, date);
    const usageHours = useTime / 10;
    if (!aggregate.usageHours || usageHours > aggregate.usageHours) aggregate.usageHours = usageHours;
    if (pct95PressSeen > 0) aggregate.pressure95th = pct95PressSeen / 10;

    if (!machine.mode) {
      if (maxPressSeen === cpapPressure && pct95PressSeen === cpapPressure) {
        machine.mode = "CPAP";
        machine.pressure = `Fixed ${(cpapPressure / 10).toFixed(1).replace(/\.0$/, "")} cmH2O`;
      } else {
        machine.mode = "APAP";
        machine.pressureIsAuto = true;
        machine.pressureMin = `${(minPressureSet / 10).toFixed(1).replace(/\.0$/, "")} cmH2O`;
        machine.pressureMax = `${(maxPressureSet / 10).toFixed(1).replace(/\.0$/, "")} cmH2O`;
      }
    }

    if (!machine.pressureRelief) {
      if (eprLevel > 0) machine.pressureRelief = `EPR: ${eprLevel}`;
      else machine.pressureRelief = "EPR: Off";
    }

    if (!machine.device && sensAwake > 0 && (flags & 0x04) !== 0) {
      machine.device = `SleepStyle ${modeByte === 0 ? "Auto" : "CPAP"}`;
    }

    void runTime;
    void ramp;
    void humidity;
  }
}

function parseSleepStyleDetail(bytes: Uint8Array, aggregates: Map<number, SleepStyleAggregate>) {
  if (bytes.length < 0xa00) return;

  const index = bytes.subarray(0x200, 0xa00);
  const data = bytes.subarray(0xa00);
  const indexView = new DataView(index.buffer, index.byteOffset, index.byteLength);

  let pos = 0;
  while (pos + 9 <= index.length) {
    const tsRaw = indexView.getUint32(pos, true);
    pos += 4;
    if (tsRaw === 0xffffffff || (tsRaw & 0xffff) === 0xfafe) break;

    const date = decodeSleepStyleTimestamp(tsRaw);
    if (!date) break;

    const startBlock = indexView.getUint16(pos, true);
    pos += 2;
    const records = index[pos];
    pos += 1;
    pos += 2; // unknownIndex

    const aggregate = getAggregate(aggregates, date);
    let dataPos = startBlock * 21;

    for (let i = 0; i < records; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        if (dataPos + 7 > data.length) return;
        const pressure = data[dataPos] / 10;
        const leak = data[dataPos + 1];
        const a1 = data[dataPos + 2];
        const a2 = data[dataPos + 3];
        const a3 = data[dataPos + 4];
        const a4 = data[dataPos + 5];

        aggregate.pressureSum += pressure;
        aggregate.pressureCount += 1;
        aggregate.leakSum += leak;
        aggregate.leakCount += 1;
        if (aggregate.leakMax === null || leak > aggregate.leakMax) aggregate.leakMax = leak;

        for (let mask = 1; mask <= 0x20; mask <<= 1) {
          if (a1 & mask) aggregate.obstructiveApneas += 1;
          if (a2 & mask) aggregate.centralApneas += 1;
          if (a3 & mask) aggregate.hypopneas += 1;
          if (a4 & mask) aggregate.hypopneas += 1;
        }

        dataPos += 7;
      }
    }
  }
}

function finalizeRecords(aggregates: Map<number, SleepStyleAggregate>): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  for (const aggregate of aggregates.values()) {
    const usageHours = aggregate.usageHours;
    const pressureAvg = aggregate.pressureCount > 0 ? aggregate.pressureSum / aggregate.pressureCount : undefined;
    const leak = aggregate.leakCount > 0 ? aggregate.leakSum / aggregate.leakCount : undefined;
    const ahi =
      usageHours && usageHours > 0
        ? (aggregate.obstructiveApneas + aggregate.centralApneas + aggregate.hypopneas) / usageHours
        : undefined;

    records.push({
      date: aggregate.date,
      usageHours,
      ahi,
      residualApneas: usageHours && usageHours > 0 ? aggregate.obstructiveApneas / usageHours : undefined,
      centralApneas: usageHours && usageHours > 0 ? aggregate.centralApneas / usageHours : undefined,
      leak,
      leakMax: aggregate.leakMax ?? undefined,
      leakMax30s: aggregate.leakMax ?? undefined,
      leakMax2m: aggregate.leakMax ?? undefined,
      pressureAvg,
      pressure95th: aggregate.pressure95th
    });
  }
  return records;
}

export async function parseSleepStyleFamily(context: FamilyParserContext, deps: FamilyParserDeps): Promise<void> {
  const aggregates = new Map<number, SleepStyleAggregate>();
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
      if (/sum.*\.fph$/i.test(lowerPath)) parseSleepStyleSummary(bytes, aggregates, context.machine);
      else if (/det.*\.fph$/i.test(lowerPath)) parseSleepStyleDetail(bytes, aggregates);
    } catch {
      continue;
    }

    if (processed % 3 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  context.records.push(...finalizeRecords(aggregates));
  if (!context.machine.device) context.machine.device = "SleepStyle";
}
