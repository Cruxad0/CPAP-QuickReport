import type { FamilyParserContext, FamilyParserDeps } from "@/lib/parsers/text-family-types";
import type { ParsedRecord, QuickReportMetrics } from "@/lib/types";

const BMC_MODE_LABELS = new Map<number, string>([
  [0, "CPAP"],
  [1, "AutoCPAP"],
  [2, "S"],
  [3, "S/T"],
  [4, "T"],
  [5, "Titration"],
  [6, "AutoS"]
]);

const BMC_USR_SESSIONS_OFFSET = 0x102340;

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  const end = Math.min(bytes.length, start + length);
  let out = "";
  for (let i = start; i < end; i += 1) {
    const b = bytes[i];
    if (b === 0) break;
    if (b >= 32 && b <= 126) out += String.fromCharCode(b);
  }
  return out.trim();
}

function u16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function decodeBmcDate(encodedDate: number): Date | null {
  const year = 2000 + (encodedDate >> 9);
  const month = (encodedDate >> 5) & 0x0f;
  const day = encodedDate & 0x1f;
  const dt = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function formatCm(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return `${Number(value.toFixed(2)).toString()} cmH2O`;
}

function inferBmcMachineInfo(bytes: Uint8Array, machine: QuickReportMetrics["machine"]) {
  const serial = readAscii(bytes, 0x2d, 32);
  const model = readAscii(bytes, 0x2296, 32);
  if (!machine.device) {
    if (model && serial) machine.device = `${model} (${serial})`;
    else if (model) machine.device = model;
    else if (serial) machine.device = `BMC ${serial}`;
  }
}

function inferBmcSettingsFromIdx(bytes: Uint8Array, machine: QuickReportMetrics["machine"]) {
  if (bytes.length < 0x166) return;
  if (bytes[0] !== 0xaa || bytes[1] !== 0xaa) return;

  const epap = bytes[0x141] / 2;
  const maxPressure = bytes[0x14c] / 2;
  const pressureSupport = (bytes[0x148] >> 2) / 2;
  const ipap = epap + pressureSupport;
  const modeCode = bytes[0x14d] >> 4;
  const reslex = bytes[0x148] & 0x03;
  const reslexPatient = (bytes[0x151] & 0x80) !== 0;
  const backupRR = (bytes[0x145] & 0x80) !== 0;
  const modeLabel = BMC_MODE_LABELS.get(modeCode);

  if (!machine.mode && modeLabel) {
    if (modeCode === 0) machine.mode = "CPAP";
    else if (modeCode === 1) machine.mode = "APAP";
    else if (modeCode >= 2 && modeCode <= 6) machine.mode = "BiPAP";
  }

  if (machine.mode === "CPAP") {
    const pressure = formatCm(epap);
    if (pressure) machine.pressure = `Fixed ${pressure}`;
  } else if (machine.mode === "APAP") {
    machine.pressureIsAuto = true;
    machine.pressureMin = formatCm(epap);
    machine.pressureMax = formatCm(maxPressure);
  } else if (machine.mode === "BiPAP") {
    if (modeCode === 6) {
      const minIpap = formatCm(ipap);
      const maxIpap = formatCm(maxPressure);
      machine.epap = formatCm(epap);
      if (minIpap && maxIpap) machine.ipap = `${minIpap}-${maxIpap}`;
      else machine.ipap = maxIpap ?? minIpap;
    } else {
      machine.epap = formatCm(epap);
      machine.ipap = formatCm(ipap);
    }
    if (backupRR) {
      machine.respiratoryRate = "Backup RR enabled";
    }
  }

  if (!machine.pressureRelief) {
    if (reslex === 0) machine.pressureRelief = "Reslex: Off";
    else if (reslexPatient) machine.pressureRelief = "Reslex: Patient";
    else machine.pressureRelief = `Reslex: ${reslex}`;
  }
}

function parseBmcHistoricSession(sessionBytes: Uint8Array): ParsedRecord | null {
  if (sessionBytes.length < 0x45 || sessionBytes[0] !== 0xe1) return null;

  const startDate = decodeBmcDate(u16(sessionBytes, 0x07));
  if (!startDate) return null;

  const durationMinutes = u16(sessionBytes, 0x0f);
  const usageHours = durationMinutes > 0 ? durationMinutes / 60 : undefined;

  let pos = 0x45;
  while (pos < sessionBytes.length) {
    const type = sessionBytes[pos];
    pos += 1;
    if (type === 0xff) break;
    pos += 4;
  }

  let obstructiveApneas = 0;
  let hypopneas = 0;
  let centralApneas = 0;

  while (pos + 5 <= sessionBytes.length) {
    const msgType = sessionBytes[pos];
    const count = u16(sessionBytes, pos + 1);
    pos += 5;

    if (msgType === 0x83 || msgType === 0x84 || msgType === 0x87) {
      if (pos + count * 3 > sessionBytes.length) break;
      if (msgType === 0x83) obstructiveApneas += count;
      else if (msgType === 0x84) hypopneas += count;
      else if (msgType === 0x87) centralApneas += count;
      pos += count * 3;
      continue;
    }

    if (msgType === 0x82 || msgType === 0x86) {
      if (pos + count * 4 > sessionBytes.length) break;
      pos += count * 4;
      continue;
    }

    if (pos + count * 2 > sessionBytes.length) break;
    pos += count * 2;
  }

  const ahi = usageHours && usageHours > 0 ? (obstructiveApneas + centralApneas + hypopneas) / usageHours : undefined;
  return {
    date: startDate,
    usageHours: usageHours && usageHours > 0 && usageHours <= 24 ? usageHours : undefined,
    ahi,
    residualApneas: usageHours && usageHours > 0 ? obstructiveApneas / usageHours : undefined,
    centralApneas: usageHours && usageHours > 0 ? centralApneas / usageHours : undefined
  };
}

function parseBmcUsrRecords(bytes: Uint8Array): ParsedRecord[] {
  if (bytes.length <= BMC_USR_SESSIONS_OFFSET) return [];

  const records: ParsedRecord[] = [];
  let pos = BMC_USR_SESSIONS_OFFSET;

  while (pos < bytes.length) {
    const next = u32(bytes, pos + 1);
    let sliceEnd = next;
    if (sliceEnd === 0 || sliceEnd === 0xffffffff || sliceEnd <= pos || sliceEnd > bytes.length) {
      sliceEnd = bytes.length;
    }
    if (sliceEnd <= pos) break;

    const session = parseBmcHistoricSession(bytes.subarray(pos, sliceEnd));
    if (session) records.push(session);

    if (sliceEnd === bytes.length) break;
    pos = sliceEnd;
  }

  return records;
}

export async function parseBmcFamily(context: FamilyParserContext, deps: FamilyParserDeps): Promise<void> {
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

      if (lowerPath.endsWith(".usr")) {
        inferBmcMachineInfo(bytes, context.machine);
        context.records.push(...parseBmcUsrRecords(bytes));
      } else if (lowerPath.endsWith(".idx")) {
        inferBmcSettingsFromIdx(bytes, context.machine);
      }
    } catch {
      continue;
    }

    if (processed % 4 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}
