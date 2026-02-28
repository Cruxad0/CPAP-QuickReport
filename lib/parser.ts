import { ParseRequest, ParsedRecord, ParseProgress, QuickReportMetrics } from "@/lib/types";

const MAX_FILES_TO_SCAN = 350;
const MAX_FILE_SIZE_BYTES = 6_000_000;
const TEXT_EXTENSIONS = new Set(["csv", "txt", "tsv", "json", "xml", "edf", "log"]);

const DATE_PATTERNS = [
  /(\d{4})-(\d{2})-(\d{2})/, // yyyy-mm-dd
  /(\d{2})\/(\d{2})\/(\d{4})/ // mm/dd/yyyy
];

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

function inferMachineSettings(text: string, machine: QuickReportMetrics["machine"]) {
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
    const m = text.match(/(?:epr|pressure\s*relief|flex|ps)\s*[:=]\s*([^\n\r]+)/i);
    if (m) machine.pressureRelief = m[1].trim();
  }
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

export async function buildQuickReportMetrics(request: ParseRequest): Promise<QuickReportMetrics> {
  const { files, patientName, dateOfBirthIso, physicianName, onProgress } = request;

  const warnings: string[] = [];
  const now = new Date();
  const machine: QuickReportMetrics["machine"] = {};
  const records: ParsedRecord[] = [];

  const candidates = files
    .filter((f) => {
      const ext = f.name.includes(".") ? f.name.toLowerCase().split(".").pop() ?? "" : "";
      return TEXT_EXTENSIONS.has(ext) && f.size <= MAX_FILE_SIZE_BYTES;
    })
    .slice(0, MAX_FILES_TO_SCAN);

  if (files.length > MAX_FILES_TO_SCAN) {
    warnings.push(`Input contained ${files.length} files; only the first ${MAX_FILES_TO_SCAN} candidate files were scanned.`);
  }

  if (candidates.length === 0) {
    throw new Error(
      "No parseable files were detected. Use the CPAP SD card root folder or provide a zip export containing CSV/TXT/XML data files."
    );
  }

  emit(onProgress, { phase: "scan", detail: "Scanning files...", percent: 8 });

  let processed = 0;
  for (const f of candidates) {
    processed += 1;
    const pct = 8 + Math.round((processed / candidates.length) * 62);
    emit(onProgress, {
      phase: "parse",
      detail: `Reading ${f.path}`,
      percent: Math.min(70, pct)
    });

    let text = "";
    try {
      text = await f.readText();
    } catch {
      warnings.push(`Could not read ${f.path}`);
      continue;
    }

    if (!text || text.trim().length === 0) continue;

    inferMachineSettings(text, machine);
    const parsed = sanitizeRecords(parseRecords(text));
    records.push(...parsed);

    if (processed % 10 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  emit(onProgress, { phase: "compute", detail: "Computing 90-day metrics...", percent: 82 });

  if (records.length === 0) {
    throw new Error(
      "Data import succeeded but no daily metrics were extracted. Use a data export that includes date-stamped usage/AHI/leak records."
    );
  }

  const latest = records.reduce((acc, r) => (r.date > acc ? r.date : acc), records[0].date);
  const windowEnd = new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth(), latest.getUTCDate()));
  const windowStart = new Date(windowEnd);
  windowStart.setUTCDate(windowStart.getUTCDate() - 89);

  const inWindow = records.filter((r) => r.date >= windowStart && r.date <= windowEnd);
  if (inWindow.length === 0) {
    throw new Error("No records were found in the last 90 days of the imported data.");
  }

  const dayMap = new Map<string, { usage?: number; ahi?: number; leak?: number }>();
  for (const r of inWindow) {
    const key = toIsoDate(r.date);
    const bucket = dayMap.get(key) ?? {};
    if (typeof r.usageHours === "number") bucket.usage = r.usageHours;
    if (typeof r.ahi === "number") bucket.ahi = r.ahi;
    if (typeof r.leak === "number") bucket.leak = r.leak;
    dayMap.set(key, bucket);
  }

  const usageValues = [...dayMap.values()].map((d) => d.usage).filter((v): v is number => typeof v === "number");
  const ahiValues = [...dayMap.values()].map((d) => d.ahi).filter((v): v is number => typeof v === "number");
  const leakValues = [...dayMap.values()].map((d) => d.leak).filter((v): v is number => typeof v === "number");

  const daysWithData = dayMap.size;
  const compliantDays = usageValues.filter((u) => u >= 4).length;
  const avgUsageHours = usageValues.length > 0 ? usageValues.reduce((a, b) => a + b, 0) / usageValues.length : 0;
  const avgAhi = ahiValues.length > 0 ? ahiValues.reduce((a, b) => a + b, 0) / ahiValues.length : 0;
  const ahi95th = ahiValues.length > 0 ? percentile(ahiValues, 95) : 0;
  const avgLeak = leakValues.length > 0 ? leakValues.reduce((a, b) => a + b, 0) / leakValues.length : null;
  const maxLeak = leakValues.length > 0 ? Math.max(...leakValues) : null;

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
    usageDaysPercent: (daysWithData / 90) * 100,
    compliantDays,
    compliancePercent: (compliantDays / 90) * 100,
    avgUsageHours,
    avgAhi,
    ahi95th,
    avgLeak,
    maxLeak,
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
