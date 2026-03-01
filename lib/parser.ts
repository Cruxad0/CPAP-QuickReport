import { ParseRequest, ParsedRecord, ParseProgress, QuickReportMetrics, SourceFile } from "@/lib/types";

const MAX_GENERIC_FILES_TO_SCAN = 500;
const MAX_FILE_SIZE_BYTES = 8_000_000;
const MAX_RESVENT_P_TOTAL_BYTES = 24_000_000;
const MAX_RESVENT_P_FILES = 120;
const TEXT_EXTENSIONS = new Set(["csv", "txt", "tsv", "json", "xml", "edf", "log"]);

const DATE_PATTERNS = [
  /(\d{4})-(\d{2})-(\d{2})/, // yyyy-mm-dd
  /(\d{2})\/(\d{2})\/(\d{4})/ // mm/dd/yyyy
];

type SourceMeta = {
  file: SourceFile;
  normalizedPath: string;
  baseName: string;
  ext: string;
  recordDate: Date | null;
};

type DayBucket = {
  usageSum: number;
  usageCount: number;
  ahiWeightedSum: number;
  ahiWeightHours: number;
  ahiSum: number;
  ahiCount: number;
  leakSum: number;
  leakCount: number;
  leakMax: number | null;
};

type LeakStats = {
  sum: number;
  count: number;
  max: number;
};

const RESVENT_MODE_FROM_FILE = new Map<string, string>([
  ["N_CPAP", "CPAP"],
  ["N_APAP", "APAP"],
  ["N_S30", "S30"],
  ["N_AS30", "Auto S30"],
  ["N_ST30", "ST30"],
  ["N_AST30", "Auto ST30"],
  ["N_T30", "T30"],
  ["N_PC", "PC"]
]);

function formatCmH2O(raw: unknown): string | null {
  const n = safeNumber(raw);
  if (n === undefined) return null;
  const cm = n / 100;
  if (!Number.isFinite(cm)) return null;
  return `${Number(cm.toFixed(2)).toString()}`;
}

function safeNumber(input: unknown): number | undefined {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input !== "string") return undefined;
  const n = Number.parseFloat(input.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : undefined;
}

function parseDateFromString(value: string): Date | null {
  for (const pattern of DATE_PATTERNS) {
    const m = pattern.exec(value);
    if (!m) continue;
    if (pattern === DATE_PATTERNS[0]) {
      const y = Number(m[1]);
      const mon = Number(m[2]);
      const d = Number(m[3]);
      const dt = new Date(Date.UTC(y, mon - 1, d));
      if (!Number.isNaN(dt.getTime())) return dt;
    } else {
      const mon = Number(m[1]);
      const d = Number(m[2]);
      const y = Number(m[3]);
      const dt = new Date(Date.UTC(y, mon - 1, d));
      if (!Number.isNaN(dt.getTime())) return dt;
    }
  }
  return null;
}

function toIsoDate(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

function dateFromIso(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00Z`);
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

function formatDateHuman(isoDate: string): string {
  const dt = new Date(`${isoDate}T00:00:00Z`);
  return dt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC"
  });
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function extractResventRecordDate(path: string): Date | null {
  const m = /(?:^|\/)therapy\/record\/(\d{4})(\d{2})\/(\d{2})(?:\/|$)/i.exec(path);
  if (!m) return null;

  const y = Number(m[1]);
  const mon = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(y, mon - 1, day));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function toSourceMeta(file: SourceFile): SourceMeta {
  const normalizedPath = normalizePath(file.path);
  const baseName = normalizedPath.split("/").pop() ?? normalizedPath;
  const ext = baseName.includes(".") ? baseName.toLowerCase().split(".").pop() ?? "" : "";

  return {
    file,
    normalizedPath,
    baseName,
    ext,
    recordDate: extractResventRecordDate(normalizedPath)
  };
}

function isResventConfigFile(meta: SourceMeta): boolean {
  return /(?:^|\/)therapy\/config\/[^/]+$/i.test(meta.normalizedPath);
}

function isResventStatFile(meta: SourceMeta): boolean {
  // OSCAR loader imports only STATxx session files.
  return meta.recordDate !== null && /^stat\d{2}$/i.test(meta.baseName);
}

function isResventPFile(meta: SourceMeta): boolean {
  return meta.recordDate !== null && /^p\d{2}_\d+$/i.test(meta.baseName);
}

function isResventEvFile(meta: SourceMeta): boolean {
  return meta.recordDate !== null && /^ev\d{2}$/i.test(meta.baseName);
}

function inferMachineSettingsFromText(text: string, machine: QuickReportMetrics["machine"]) {
  if (!machine.device) {
    const m = text.match(/(?:device|machine|model)\s*[:=]\s*([^\n\r]+)/i);
    if (m) machine.device = m[1].trim();
  }
  if (!machine.mode) {
    const m = text.match(/(?:mode|therapy mode)\s*[:=]\s*([^\n\r]+)/i);
    if (m) machine.mode = m[1].trim();
  }
  if (!machine.pressure) {
    const m = text.match(/(?:pressure|min\s*pressure|max\s*pressure|ipap|epap)\s*[:=]\s*([^\n\r]+)/i);
    if (m) machine.pressure = m[1].trim();
  }
  if (!machine.pressureRelief) {
    const m = text.match(/(?:epr|pressure\s*relief|flex|ipr|ps)\s*[:=]\s*([^\n\r]+)/i);
    if (m) machine.pressureRelief = m[1].trim();
  }
}

function parseKeyValueLines(text: string): Map<string, string> {
  const cleaned = text
    .replace(/\0/g, "\n")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
  const out = new Map<string, string>();
  const lines = cleaned.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key.length === 0) continue;
    out.set(key, value);
  }

  // Some SD files contain key/value blobs without line breaks; capture those too.
  const re = /([A-Za-z][A-Za-z0-9_]{1,40})\s*=\s*([^\r\n,;]+)/g;
  for (const m of cleaned.matchAll(re)) {
    const key = (m[1] ?? "").trim();
    const value = (m[2] ?? "").trim();
    if (key && value) out.set(key, value);
  }

  return out;
}

function decodeResventText(bytes: Uint8Array, skipHeader = true): string {
  if (bytes.length === 0) return "";
  // OSCAR Resvent loader always seeks 4 bytes before reading config/stat/event text files.
  const start = skipHeader ? Math.min(4, bytes.length) : 0;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(start));
}

function inferMachineSettingsFromConfigFilename(path: string, machine: QuickReportMetrics["machine"]) {
  const base = path.split("/").pop()?.toUpperCase() ?? "";
  if (!machine.mode && RESVENT_MODE_FROM_FILE.has(base)) {
    machine.mode = RESVENT_MODE_FROM_FILE.get(base);
  }
  if (!machine.device) {
    machine.device = "Resvent / Hoffrichter (SD Card)";
  }
}

function inferMachineSettingsFromConfigMap(configMap: Map<string, string>, machine: QuickReportMetrics["machine"]) {
  const ventModeMap = new Map<string, string>([
    ["1", "CPAP"],
    ["3", "APAP"],
    ["10", "S30"],
    ["11", "Auto S30"],
    ["12", "ST30"],
    ["13", "Auto ST30"],
    ["14", "T30"],
    ["15", "PC"]
  ]);

  const model = configMap.get("models") ?? configMap.get("model");
  const sn = configMap.get("sn") ?? configMap.get("serial");
  if (!machine.device && model && sn) machine.device = `${model} (${sn})`;
  else if (!machine.device && model) machine.device = model;
  else if (!machine.device && sn) machine.device = `Serial ${sn}`;

  if (!machine.mode) {
    const modeRaw = configMap.get("VentMode") ?? configMap.get("mode");
    if (modeRaw) machine.mode = ventModeMap.get(modeRaw) ?? modeRaw;
  }

  if (!machine.pressure) {
    const press = configMap.get("Press");
    const pMin = configMap.get("PMin");
    const pMax = configMap.get("PMax");
    const epap = configMap.get("EPAP");
    const ipap = configMap.get("IPAP");
    const epapMin = configMap.get("EPAPMin");
    const ipapMax = configMap.get("IPAPMax");

    const pressText = formatCmH2O(press);
    const pMinText = formatCmH2O(pMin);
    const pMaxText = formatCmH2O(pMax);
    const epapText = formatCmH2O(epap);
    const ipapText = formatCmH2O(ipap);
    const epapMinText = formatCmH2O(epapMin);
    const ipapMaxText = formatCmH2O(ipapMax);

    if (pressText) machine.pressure = `Fixed ${pressText} (cmH2O)`;
    else if (pMinText && pMaxText) machine.pressure = `${pMinText}-${pMaxText} (cmH2O)`;
    else if (epapText && ipapText) machine.pressure = `EPAP ${epapText} / IPAP ${ipapText} (cmH2O)`;
    else if (epapMinText && ipapMaxText) {
      machine.pressure = `EPAP ${epapMinText} - IPAP ${ipapMaxText} (cmH2O)`;
    }
  }

  if (!machine.pressureRelief) {
    const ipr = safeNumber(configMap.get("iPR") ?? configMap.get("epr") ?? configMap.get("EPR"));
    if (ipr !== undefined) {
      machine.pressureRelief = ipr > 0 ? `IPR: On ${Number(ipr.toFixed(2)).toString()} cmH2O` : "IPR: Off";
    }
  }
}

function parseResventStatText(text: string, fallbackDate: Date): ParsedRecord | null {
  const kv = parseKeyValueLines(text);
  if (kv.size === 0) return null;

  const kvLower = new Map<string, string>();
  for (const [k, v] of kv.entries()) kvLower.set(k.toLowerCase(), v);
  const num = (key: string): number | undefined => safeNumber(kv.get(key) ?? kvLower.get(key.toLowerCase()));

  const secUsed = num("secUsed");
  const cntAHI = num("cntAHI");
  const cntOAI = num("cntOAI");
  const cntCAI = num("cntCAI");
  const cntAI = num("cntAI");
  const cntHI = num("cntHI");

  // Keep daily grouping anchored to THERAPY/RECORD/YYYYMM/DD (same basis OSCAR uses to load sessions).
  const recordDate = new Date(Date.UTC(fallbackDate.getUTCFullYear(), fallbackDate.getUTCMonth(), fallbackDate.getUTCDate()));
  if (Number.isNaN(recordDate.getTime())) return null;

  const usageHours = secUsed !== undefined ? secUsed / 3600 : undefined;

  let ahi: number | undefined;
  let eventCount: number | undefined;
  if (cntAI !== undefined && cntHI !== undefined) {
    eventCount = cntAI + cntHI;
  } else if (cntOAI !== undefined || cntCAI !== undefined || cntHI !== undefined) {
    eventCount = (cntOAI ?? 0) + (cntCAI ?? 0) + (cntHI ?? 0);
  } else if (cntAHI !== undefined) {
    eventCount = cntAHI;
  }

  if (usageHours !== undefined && usageHours > 0 && eventCount !== undefined) {
    ahi = eventCount / usageHours;
  } else if (cntAHI !== undefined) {
    // Fallback if only a scalar was supplied.
    ahi = cntAHI;
  }

  let leak: number | undefined;
  for (const [key, value] of kv.entries()) {
    if (!/leak/i.test(key)) continue;
    const n = safeNumber(value);
    if (n === undefined) continue;
    if (n >= 0 && n <= 500) {
      leak = n;
      break;
    }
  }

  return {
    date: recordDate,
    usageHours: usageHours !== undefined && usageHours >= 0 && usageHours <= 24 ? usageHours : undefined,
    ahi: ahi !== undefined && ahi >= 0 && ahi < 200 ? ahi : undefined,
    leak: leak !== undefined && leak >= 0 && leak < 500 ? leak : undefined
  };
}

function countAhiEventsFromEvText(text: string): number | null {
  if (!text.trim()) return null;
  let count = 0;
  for (const m of text.matchAll(/ID\s*=\s*(\d+)/gi)) {
    const id = Number(m[1]);
    if (id === 17 || id === 18 || id === 19) count += 1;
  }
  return count > 0 ? count : null;
}

function tryParseDelimited(text: string): ParsedRecord[] {
  const lines = text.split(/\r?\n/).filter((x) => x.trim().length > 0);
  if (lines.length < 2) return [];

  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const headers = lines[0].split(delimiter).map((h) => h.trim().toLowerCase());

  const dateIdx = headers.findIndex((h) => /date|day/.test(h));
  const usageIdx = headers.findIndex((h) => /usage|hours|therapy/.test(h));
  const ahiIdx = headers.findIndex((h) => /ahi/.test(h));
  const leakIdx = headers.findIndex((h) => /leak/.test(h));

  if (dateIdx < 0) return [];

  const out: ParsedRecord[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const row = lines[i].split(delimiter);
    const date = parseDateFromString(row[dateIdx] ?? "");
    if (!date) continue;

    out.push({
      date,
      usageHours: usageIdx >= 0 ? safeNumber(row[usageIdx]) : undefined,
      ahi: ahiIdx >= 0 ? safeNumber(row[ahiIdx]) : undefined,
      leak: leakIdx >= 0 ? safeNumber(row[leakIdx]) : undefined
    });
  }

  return out;
}

function tryParseFreeText(text: string): ParsedRecord[] {
  const lines = text.split(/\r?\n/).filter((x) => x.trim().length > 0);
  const out: ParsedRecord[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const date = parseDateFromString(line);
    if (!date) continue;

    const usageMatch = line.match(/(?:usage|therapy\s*hours|hours)\D*(-?\d+(?:\.\d+)?)/i);
    const ahiMatch = line.match(/ahi\D*(-?\d+(?:\.\d+)?)/i);
    const leakMatch = line.match(/leak(?:age)?\D*(-?\d+(?:\.\d+)?)/i);

    out.push({
      date,
      usageHours: usageMatch ? safeNumber(usageMatch[1]) : undefined,
      ahi: ahiMatch ? safeNumber(ahiMatch[1]) : undefined,
      leak: leakMatch ? safeNumber(leakMatch[1]) : undefined
    });
  }

  return out;
}

function parseRecords(text: string): ParsedRecord[] {
  const fromDelimited = tryParseDelimited(text);
  if (fromDelimited.length > 0) return fromDelimited;
  return tryParseFreeText(text);
}

function sanitizeRecords(records: ParsedRecord[]): ParsedRecord[] {
  return records.filter((r) => {
    const hasSignal =
      (typeof r.usageHours === "number" && r.usageHours >= 0 && r.usageHours <= 24) ||
      (typeof r.ahi === "number" && r.ahi >= 0 && r.ahi < 200) ||
      (typeof r.leak === "number" && r.leak >= 0 && r.leak < 500);
    return hasSignal;
  });
}

function emit(onProgress: ParseRequest["onProgress"], progress: ParseProgress) {
  if (onProgress) onProgress(progress);
}

function readAsciiName(bytes: Uint8Array, start: number, length: number): string {
  const end = Math.min(bytes.length, start + length);
  let out = "";
  for (let i = start; i < end; i += 1) {
    const b = bytes[i];
    if (b === 0) break;
    if (b >= 32 && b <= 126) out += String.fromCharCode(b);
  }
  return out.trim();
}

function parseResventLeakFromBytes(bytes: Uint8Array): LeakStats | null {
  if (bytes.length < 0x24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const descriptionCount = view.getUint16(0x12, true);
  if (descriptionCount < 1 || descriptionCount > 64) return null;

  const descriptors: Array<{ name: string; samples: number }> = [];
  let maxSamples = 0;

  for (let i = 0; i < descriptionCount; i += 1) {
    const offset = 0x24 + i * 0x20;
    if (offset + 0x20 > bytes.length) return null;

    const name = readAsciiName(bytes, offset, 8);
    const samples = view.getUint16(offset + 0x1e, true);
    if (samples <= 0 || samples > 2048) return null;

    descriptors.push({ name, samples });
    if (samples > maxSamples) maxSamples = samples;
  }

  const leakIndex = descriptors.findIndex((d) => /^leak/i.test(d.name));
  if (leakIndex < 0 || maxSamples <= 0) return null;

  const dataOffset = 0x24 + descriptionCount * 0x20;
  if (dataOffset >= bytes.length) return null;

  const parseByLayout = (fixedStride: boolean): LeakStats | null => {
    let pos = dataOffset;
    let sum = 0;
    let count = 0;
    let max = -Infinity;

    while (pos < bytes.length) {
      let leakStart = -1;
      let nextPos = pos;

      if (fixedStride) {
        const blockBytes = descriptionCount * maxSamples * 2;
        if (blockBytes <= 0 || pos + blockBytes > bytes.length) break;
        leakStart = pos + leakIndex * maxSamples * 2;
        nextPos = pos + blockBytes;
      } else {
        let cursor = pos;
        let valid = true;
        for (let i = 0; i < descriptionCount; i += 1) {
          const bytesForDesc = descriptors[i].samples * 2;
          if (cursor + bytesForDesc > bytes.length) {
            valid = false;
            break;
          }
          if (i === leakIndex) leakStart = cursor;
          cursor += bytesForDesc;
        }
        if (!valid || leakStart < 0) break;
        nextPos = cursor;
      }

      const leakSamples = descriptors[leakIndex].samples;
      for (let i = 0; i < leakSamples; i += 1) {
        const sampleOffset = leakStart + i * 2;
        if (sampleOffset + 2 > bytes.length) break;

        const raw = view.getInt16(sampleOffset, true);
        const value = raw * 0.1;
        if (!Number.isFinite(value) || value < 0 || value > 500) continue;

        sum += value;
        count += 1;
        if (value > max) max = value;
      }

      if (nextPos <= pos) break;
      pos = nextPos;
    }

    if (count === 0 || !Number.isFinite(max)) return null;
    return { sum, count, max };
  };

  return parseByLayout(true) ?? parseByLayout(false);
}

function pickResventCandidates(files: SourceMeta[], warnings: string[]): {
  configFiles: SourceMeta[];
  statFiles: SourceMeta[];
  evByDayUsage: Map<string, SourceMeta>;
  pFiles: SourceMeta[];
  windowDateSet: Set<string>;
  latestDate: Date;
} | null {
  const dated = files.filter((m) => m.recordDate !== null) as Array<SourceMeta & { recordDate: Date }>;
  if (dated.length === 0) return null;

  const latestDate = dated.reduce((acc, m) => (m.recordDate > acc ? m.recordDate : acc), dated[0].recordDate);
  const windowEnd = new Date(Date.UTC(latestDate.getUTCFullYear(), latestDate.getUTCMonth(), latestDate.getUTCDate()));
  const windowStart = new Date(windowEnd);
  windowStart.setUTCDate(windowStart.getUTCDate() - 89);

  const inWindow = dated.filter((m) => m.recordDate >= windowStart && m.recordDate <= windowEnd);
  const windowDateSet = new Set(inWindow.map((m) => toIsoDate(m.recordDate)));

  const configFiles = files.filter(isResventConfigFile).filter((m) => m.file.size <= MAX_FILE_SIZE_BYTES);
  const statFiles = inWindow.filter(isResventStatFile).filter((m) => m.file.size <= MAX_FILE_SIZE_BYTES);
  const evByDayUsage = new Map<string, SourceMeta>();
  for (const ev of inWindow.filter(isResventEvFile).filter((m) => m.file.size <= MAX_FILE_SIZE_BYTES)) {
    const usage = /^ev(\d{2})$/i.exec(ev.baseName)?.[1];
    if (!usage || !ev.recordDate) continue;
    evByDayUsage.set(`${toIsoDate(ev.recordDate)}:${usage}`, ev);
  }

  const allP = inWindow
    .filter(isResventPFile)
    .filter((m) => m.file.size > 0 && m.file.size <= MAX_FILE_SIZE_BYTES)
    .sort((a, b) => (a.normalizedPath < b.normalizedPath ? -1 : 1));

  // Prioritize one P-file per day first (coverage), then include additional per-day files (fidelity).
  const pByDay = new Map<string, SourceMeta[]>();
  for (const p of allP) {
    if (!p.recordDate) continue;
    const day = toIsoDate(p.recordDate);
    const list = pByDay.get(day) ?? [];
    list.push(p);
    pByDay.set(day, list);
  }
  const sortedDays = [...pByDay.keys()].sort();
  const sampledP: SourceMeta[] = [];
  for (const day of sortedDays) {
    const list = pByDay.get(day);
    if (!list || list.length === 0) continue;
    sampledP.push(list[0]);
  }
  for (const day of sortedDays) {
    const list = pByDay.get(day);
    if (!list || list.length <= 1) continue;
    for (let i = 1; i < list.length; i += 1) sampledP.push(list[i]);
  }

  let pBytes = 0;
  const pFiles: SourceMeta[] = [];
  for (const m of sampledP) {
    if (pFiles.length >= MAX_RESVENT_P_FILES) break;
    if (pBytes + m.file.size > MAX_RESVENT_P_TOTAL_BYTES) break;
    pFiles.push(m);
    pBytes += m.file.size;
  }

  if (sampledP.length > pFiles.length) {
    warnings.push(
      `Leak channels were sampled from ${pFiles.length} of ${sampledP.length} P-files to keep parsing responsive.`
    );
  }

  return {
    configFiles,
    statFiles,
    evByDayUsage,
    pFiles,
    windowDateSet,
    latestDate
  };
}

function createEmptyDayBucket(): DayBucket {
  return {
    usageSum: 0,
    usageCount: 0,
    ahiWeightedSum: 0,
    ahiWeightHours: 0,
    ahiSum: 0,
    ahiCount: 0,
    leakSum: 0,
    leakCount: 0,
    leakMax: null
  };
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function isGenericTextCandidate(meta: SourceMeta): boolean {
  return TEXT_EXTENSIONS.has(meta.ext) && meta.file.size <= MAX_FILE_SIZE_BYTES;
}

export async function buildQuickReportMetrics(request: ParseRequest): Promise<QuickReportMetrics> {
  const { files, patientName, dateOfBirthIso, physicianName, onProgress } = request;

  const warnings: string[] = [];
  const now = new Date();
  const machine: QuickReportMetrics["machine"] = {};
  const records: ParsedRecord[] = [];

  const meta = files.map(toSourceMeta);
  const maybeResvent = meta.some((m) => /(?:^|\/)therapy\/(?:record|config)\//i.test(m.normalizedPath));
  const leakStatsByDay = new Map<string, LeakStats>();
  let fallbackWindowDateSet = new Set<string>();
  let latestPathDate: Date | null = null;

  emit(onProgress, { phase: "scan", detail: "Scanning files...", percent: 8 });

  if (maybeResvent) {
    const selected = pickResventCandidates(meta, warnings);
    if (selected) {
      fallbackWindowDateSet = selected.windowDateSet;
      latestPathDate = selected.latestDate;

      const totalResventWork = selected.configFiles.length + selected.statFiles.length + selected.pFiles.length;
      let processed = 0;

      for (const configFile of selected.configFiles) {
        processed += 1;
        const pct = 8 + Math.round((processed / Math.max(1, totalResventWork)) * 62);
        emit(onProgress, {
          phase: "parse",
          detail: `Reading ${configFile.normalizedPath}`,
          percent: Math.min(70, pct)
        });

        try {
          const bytes = await configFile.file.readBytes();
          const text = decodeResventText(bytes, true);
          if (text.trim().length === 0) continue;
          const kv = parseKeyValueLines(text);
          inferMachineSettingsFromConfigFilename(configFile.normalizedPath, machine);
          inferMachineSettingsFromConfigMap(kv, machine);
          inferMachineSettingsFromText(text, machine);
        } catch {
          warnings.push(`Could not read ${configFile.normalizedPath}`);
        }
      }

      for (const statFile of selected.statFiles) {
        processed += 1;
        const pct = 8 + Math.round((processed / Math.max(1, totalResventWork)) * 62);
        emit(onProgress, {
          phase: "parse",
          detail: `Parsing ${statFile.normalizedPath}`,
          percent: Math.min(70, pct)
        });

        try {
          const bytes = await statFile.file.readBytes();
          const text = decodeResventText(bytes, true);
          if (!text || text.trim().length === 0 || statFile.recordDate === null) continue;
          const parsed = parseResventStatText(text, statFile.recordDate);
          if (parsed) {
            const usage = /^stat(\d{2})$/i.exec(statFile.baseName)?.[1];
            if (usage && parsed.usageHours && parsed.usageHours > 0) {
              const key = `${toIsoDate(statFile.recordDate)}:${usage}`;
              const evFile = selected.evByDayUsage.get(key);
              if (evFile) {
                try {
                  const evText = decodeResventText(await evFile.file.readBytes(), true);
                  const evCount = countAhiEventsFromEvText(evText);
                  if (evCount !== null) {
                    parsed.ahi = evCount / parsed.usageHours;
                  }
                } catch {
                  // Keep stat-derived AHI if EV parsing fails.
                }
              }
            }
            records.push(parsed);
          }
        } catch {
          warnings.push(`Could not read ${statFile.normalizedPath}`);
        }

        if (processed % 20 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      for (const pFile of selected.pFiles) {
        processed += 1;
        const pct = 8 + Math.round((processed / Math.max(1, totalResventWork)) * 62);
        emit(onProgress, {
          phase: "parse",
          detail: `Sampling leak from ${pFile.normalizedPath}`,
          percent: Math.min(70, pct)
        });

        if (pFile.recordDate === null) continue;

        try {
          const bytes = await pFile.file.readBytes();
          const leak = parseResventLeakFromBytes(bytes);
          if (!leak) continue;

          const key = toIsoDate(pFile.recordDate);
          const existing = leakStatsByDay.get(key);
          if (existing) {
            existing.sum += leak.sum;
            existing.count += leak.count;
            if (leak.max > existing.max) existing.max = leak.max;
          } else {
            leakStatsByDay.set(key, { ...leak });
          }
        } catch {
          warnings.push(`Could not read ${pFile.normalizedPath}`);
        }

        if (processed % 20 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }
  }

  // Generic text parsing fallback for non-Resvent formats.
  const runGenericPass = !(maybeResvent && (fallbackWindowDateSet.size > 0 || records.length > 0));
  const genericTextCandidates = meta.filter(isGenericTextCandidate);
  const genericCandidates = runGenericPass ? genericTextCandidates.slice(0, MAX_GENERIC_FILES_TO_SCAN) : [];
  if (runGenericPass && genericTextCandidates.length > MAX_GENERIC_FILES_TO_SCAN) {
    warnings.push(`Input contained many text files; generic parsing was limited to ${MAX_GENERIC_FILES_TO_SCAN} files.`);
  }

  let genericProcessed = 0;
  for (const candidate of genericCandidates) {
    genericProcessed += 1;
    const pct = 70 + Math.round((genericProcessed / Math.max(1, genericCandidates.length)) * 10);
    emit(onProgress, {
      phase: "parse",
      detail: `Reading ${candidate.normalizedPath}`,
      percent: Math.min(80, pct)
    });

    let text = "";
    try {
      text = await candidate.file.readText();
    } catch {
      continue;
    }

    if (!text || text.trim().length === 0) continue;
    inferMachineSettingsFromText(text, machine);
    const parsed = sanitizeRecords(parseRecords(text));
    records.push(...parsed);

    if (genericProcessed % 25 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  emit(onProgress, { phase: "compute", detail: "Computing 90-day metrics...", percent: 82 });

  let latest: Date | null = records.length > 0 ? records.reduce((acc, r) => (r.date > acc ? r.date : acc), records[0].date) : null;
  if (latestPathDate && (!latest || latestPathDate > latest)) {
    latest = latestPathDate;
  }

  if (!latest) {
    throw new Error(
      "No date-stamped CPAP data was detected. Verify the selected folder is the SD card root (contains THERAPY/RECORD) or use a compatible export."
    );
  }

  const windowEnd = new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth(), latest.getUTCDate()));
  const windowStart = new Date(windowEnd);
  windowStart.setUTCDate(windowStart.getUTCDate() - 89);

  const dayMap = new Map<string, DayBucket>();

  for (const record of records) {
    if (record.date < windowStart || record.date > windowEnd) continue;
    const key = toIsoDate(record.date);
    const bucket = dayMap.get(key) ?? createEmptyDayBucket();
    let usageForAhiWeight: number | undefined;

    if (typeof record.usageHours === "number" && record.usageHours >= 0 && record.usageHours <= 24) {
      bucket.usageSum += record.usageHours;
      bucket.usageCount += 1;
      usageForAhiWeight = record.usageHours;
    }

    if (typeof record.ahi === "number" && record.ahi >= 0 && record.ahi < 200) {
      if (usageForAhiWeight && usageForAhiWeight > 0) {
        bucket.ahiWeightedSum += record.ahi * usageForAhiWeight;
        bucket.ahiWeightHours += usageForAhiWeight;
      } else {
        bucket.ahiSum += record.ahi;
        bucket.ahiCount += 1;
      }
    }

    if (typeof record.leak === "number" && record.leak >= 0 && record.leak < 500) {
      bucket.leakSum += record.leak;
      bucket.leakCount += 1;
      bucket.leakMax = bucket.leakMax === null ? record.leak : Math.max(bucket.leakMax, record.leak);
    }

    dayMap.set(key, bucket);
  }

  for (const [day, stats] of leakStatsByDay.entries()) {
    const dayDate = dateFromIso(day);
    if (dayDate < windowStart || dayDate > windowEnd) continue;
    const bucket = dayMap.get(day) ?? createEmptyDayBucket();
    bucket.leakSum += stats.sum / stats.count;
    bucket.leakCount += 1;
    bucket.leakMax = bucket.leakMax === null ? stats.max : Math.max(bucket.leakMax, stats.max);
    dayMap.set(day, bucket);
  }

  if (dayMap.size === 0) {
    if (fallbackWindowDateSet.size > 0) {
      throw new Error(
        "Data import succeeded but no daily metrics were parsed from THERAPY/RECORD. Verify this export includes STATxx/EVxx files."
      );
    }
    throw new Error("Data import succeeded but no records were found in the most recent 90-day date range.");
  }

  const usageValues = [...dayMap.values()]
    .filter((d) => d.usageCount > 0)
    .map((d) => d.usageSum);

  const ahiValues = [...dayMap.values()]
    .map((d) => {
      if (d.ahiWeightHours > 0) return d.ahiWeightedSum / d.ahiWeightHours;
      if (d.ahiCount > 0) return d.ahiSum / d.ahiCount;
      return undefined;
    })
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const leakValues = [...dayMap.values()]
    .filter((d) => d.leakCount > 0)
    .map((d) => d.leakSum / d.leakCount);

  const leakMaxValues = [...dayMap.values()]
    .map((d) => d.leakMax)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const daysWithData = dayMap.size;
  const compliantDays = usageValues.filter((u) => u >= 4).length;
  const avgUsageHours = usageValues.length > 0 ? usageValues.reduce((a, b) => a + b, 0) / usageValues.length : 0;
  const avgAhi = ahiValues.length > 0 ? ahiValues.reduce((a, b) => a + b, 0) / ahiValues.length : 0;
  const ahi95th = ahiValues.length > 0 ? percentile(ahiValues, 95) : 0;
  const avgLeak = leakValues.length > 0 ? leakValues.reduce((a, b) => a + b, 0) / leakValues.length : null;
  const maxLeak = leakMaxValues.length > 0 ? Math.max(...leakMaxValues) : leakValues.length > 0 ? Math.max(...leakValues) : null;

  if (usageValues.length === 0) {
    warnings.push("Usage-hour fields were not found in the selected data. Compliance metrics are shown as 0.");
  }
  if (ahiValues.length === 0) {
    warnings.push("AHI metrics were not detected from the selected files.");
  }
  if (leakValues.length === 0) {
    warnings.push("Leak metrics were not detected from the selected files.");
  }

  const report: QuickReportMetrics = {
    generatedAtIso: now.toISOString(),
    generatedAtDisplay: now.toLocaleString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }),
    patientName: patientName.trim(),
    dateOfBirth: formatDateHuman(dateOfBirthIso),
    physicianName: physicianName.trim(),
    dateRangeStart: formatDateHuman(toIsoDate(windowStart)),
    dateRangeEnd: formatDateHuman(toIsoDate(windowEnd)),
    daysInWindow: 90,
    daysWithData,
    usageDaysPercent: finite((daysWithData / 90) * 100),
    compliantDays,
    compliancePercent: finite((compliantDays / 90) * 100),
    avgUsageHours: finite(avgUsageHours),
    avgAhi: finite(avgAhi),
    ahi95th: finite(ahi95th),
    avgLeak: avgLeak === null ? null : finite(avgLeak),
    maxLeak: maxLeak === null ? null : finite(maxLeak),
    machine,
    warnings
  };

  if (!report.machine.device) {
    report.machine.device = "Not detected from input files";
    warnings.push("Machine device/model could not be confidently detected from uploaded files.");
  }

  emit(onProgress, { phase: "finalize", detail: "Finalizing report...", percent: 96 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  emit(onProgress, { phase: "done", detail: "Report ready.", percent: 100 });

  return report;
}
