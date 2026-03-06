"use client";

import JSZip from "jszip";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildQuickReportMetrics } from "@/lib/parser";
import { buildPdfReport } from "@/lib/pdf";
import { DataSourceKind, ParseProgress, QuickReportMetrics, SourceFile } from "@/lib/types";

const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
const IMPORT_LOOKBACK_DAYS = 91;
const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE_SELECTION_CANCEL_TIMEOUT_MS = 20000;
const REPORT_RANGE_OPTIONS = [90, 30, 7] as const;

type ReportRangeDays = (typeof REPORT_RANGE_OPTIONS)[number];
type GeneratedReportArtifact = {
  metrics: QuickReportMetrics;
  previewUrl: string;
  previewEmbedUrl: string;
  downloadName: string;
};
type GeneratedReports = Partial<Record<ReportRangeDays, GeneratedReportArtifact>>;

type RecentWindowFilterResult = {
  files: SourceFile[];
  originalCount: number;
  filteredOutCount: number;
  filteredOutBytes: number;
  latestDateIso: string | null;
  hadDatedFiles: boolean;
};

function revokeGeneratedReportUrls(reports: GeneratedReports) {
  for (const days of REPORT_RANGE_OPTIONS) {
    const artifact = reports[days];
    if (artifact?.previewUrl) {
      URL.revokeObjectURL(artifact.previewUrl);
    }
  }
}

function bytesToLabel(size: number): string {
  if (size > 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  if (size > 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

function createUtcDateNoon(year: number, month: number, day: number): Date | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1900 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (Number.isNaN(dt.getTime())) return null;
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() + 1 !== month || dt.getUTCDate() !== day) return null;
  return dt;
}

function extractDateFromPath(path: string): Date | null {
  const normalized = path.replace(/\\/g, "/");

  const resvent = /(?:^|\/)therapy\/record\/(\d{4})(\d{2})\/(\d{2})(?:\/|$)/i.exec(normalized);
  if (resvent) {
    return createUtcDateNoon(Number(resvent[1]), Number(resvent[2]), Number(resvent[3]));
  }

  const yearMonthDay = /(?:^|\/)((?:19|20)\d{2})[\/_-](\d{2})[\/_-](\d{2})(?:\/|$)/.exec(normalized);
  if (yearMonthDay) {
    const dt = createUtcDateNoon(Number(yearMonthDay[1]), Number(yearMonthDay[2]), Number(yearMonthDay[3]));
    if (dt) return dt;
  }

  const compact = /(?:^|[^\d])((?:19|20)\d{2})(\d{2})(\d{2})(?:[^\d]|$)/.exec(normalized);
  if (compact) {
    const dt = createUtcDateNoon(Number(compact[1]), Number(compact[2]), Number(compact[3]));
    if (dt) return dt;
  }

  return null;
}

function shouldKeepUndatedFile(path: string, size: number): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();

  if (
    /(?:^|\/)(?:therapy\/config|config|settings?|profile|profiles|wm_profiles\.xml|summary\.edf|detail\.edf|str\.edf|eve\.edf|pld\.edf|sad\.edf|brp\.edf|crc\.edf)(?:\/|$|[._-])/i.test(
      normalized
    )
  ) {
    return true;
  }

  // Keep known OSCAR loader families that may not include explicit dates in every file path.
  if (
    /(?:^|\/)(?:p-series\/|p\d{5}\.\d{3}$|p\d{4}\.(?:idx|000)$|therapy\.pdat$|therapy\.dat$|sl\.edf$|icon\.edf$|wm_profiles\.xml$)/i.test(
      normalized
    )
  ) {
    return true;
  }

  if (/(?:^|\/)(?:viatom|cms50|zeo|dreem|yuwell|vrem)(?:\/|$)/i.test(normalized)) {
    return true;
  }

  // Keep small/medium clinical data files with therapy/usage/event semantics.
  if (
    size <= 2_000_000 &&
    /\.(?:csv|txt|json|xml|dat|edf)$/i.test(normalized) &&
    /(?:therapy|record|usage|session|event|summary|detail|compliance|result)/i.test(normalized)
  ) {
    return true;
  }

  if (
    size <= 256 * 1024 &&
    /(?:^|\/)(?:readme|info|version|manifest|meta|about|catalog|machine(?:[_-]info)?|device(?:[_-]info)?)(?:[._-]|$)/i.test(
      normalized
    )
  ) {
    return true;
  }

  return false;
}

function filterSourceFilesToRecentWindow(files: SourceFile[], lookbackDays: number): RecentWindowFilterResult {
  const datedEntries = files.map((file) => ({
    file,
    date: extractDateFromPath(file.path)
  }));

  const dated = datedEntries.filter((entry): entry is { file: SourceFile; date: Date } => entry.date !== null);
  if (dated.length === 0) {
    return {
      files,
      originalCount: files.length,
      filteredOutCount: 0,
      filteredOutBytes: 0,
      latestDateIso: null,
      hadDatedFiles: false
    };
  }

  // If date-bearing files are too sparse, avoid risky pruning so all loader families remain compatible.
  const datedCoverage = dated.length / Math.max(1, files.length);
  if (datedCoverage < 0.1) {
    return {
      files,
      originalCount: files.length,
      filteredOutCount: 0,
      filteredOutBytes: 0,
      latestDateIso: null,
      hadDatedFiles: false
    };
  }

  const latestMs = dated.reduce((max, entry) => Math.max(max, entry.date.getTime()), dated[0].date.getTime());
  const windowStartMs = latestMs - (lookbackDays - 1) * DAY_MS;

  let filteredOutCount = 0;
  let filteredOutBytes = 0;
  const kept = datedEntries
    .filter((entry) => {
      if (entry.date) {
        const t = entry.date.getTime();
        const keep = t >= windowStartMs && t <= latestMs;
        if (!keep) {
          filteredOutCount += 1;
          filteredOutBytes += entry.file.size;
        }
        return keep;
      }

      const keepUndated = shouldKeepUndatedFile(entry.file.path, entry.file.size);
      if (!keepUndated) {
        filteredOutCount += 1;
        filteredOutBytes += entry.file.size;
      }
      return keepUndated;
    })
    .map((entry) => entry.file);

  // Safety fallback: never end up with an empty set due to over-filtering.
  const outputFiles = kept.length > 0 ? kept : files;
  const latestDateIso = new Date(latestMs).toISOString().slice(0, 10);

  return {
    files: outputFiles,
    originalCount: files.length,
    filteredOutCount: outputFiles === files ? 0 : filteredOutCount,
    filteredOutBytes: outputFiles === files ? 0 : filteredOutBytes,
    latestDateIso,
    hadDatedFiles: true
  };
}

function formatIsoAsUsDate(iso: string): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  return dt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC"
  });
}

function toIsoDateParts(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1900 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(dt.getTime())) return null;
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() + 1 !== month ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeDobInput(value: string): string | null {
  const input = value.trim();
  if (!input) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(input);
  if (iso) {
    return toIsoDateParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input);
  if (us) {
    return toIsoDateParts(Number(us[3]), Number(us[1]), Number(us[2]));
  }

  const usDashed = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(input);
  if (usDashed) {
    return toIsoDateParts(Number(usDashed[3]), Number(usDashed[1]), Number(usDashed[2]));
  }

  return null;
}

function formatDobTyping(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

function parseIsoDate(isoDate: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  return { year, month, day };
}

function toUsDate(year: number, month: number, day: number): string {
  return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${String(year).padStart(4, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function calendarCells(year: number, month: number): Array<number | null> {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const totalDays = daysInMonth(year, month);
  const cells: Array<number | null> = [];

  for (let i = 0; i < firstWeekday; i += 1) cells.push(null);
  for (let d = 1; d <= totalDays; d += 1) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  while (cells.length < 42) cells.push(null);

  return cells;
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.readAsDataURL(file);
  });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read generated PDF."));
    reader.readAsDataURL(blob);
  });
}

async function yieldToBrowser(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(() => resolve(), 0);
  });
}

function expireSiteCookies() {
  if (typeof document === "undefined") return;
  const cookiePairs = document.cookie ? document.cookie.split(";") : [];
  const host = window.location.hostname;
  const hostParts = host.split(".");
  const candidateDomains = new Set<string>([host]);
  for (let i = 0; i < hostParts.length - 1; i += 1) {
    const domain = hostParts.slice(i).join(".");
    if (domain.includes(".")) candidateDomains.add(domain);
  }

  for (const pair of cookiePairs) {
    const eq = pair.indexOf("=");
    const name = (eq >= 0 ? pair.slice(0, eq) : pair).trim();
    if (!name) continue;
    document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
    for (const domain of candidateDomains) {
      document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=${domain}`;
      document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.${domain}`;
    }
  }
}

async function clearIndexedDbSiteData(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const idbWithDatabases = indexedDB as IDBFactory & {
    databases?: () => Promise<Array<{ name?: string }>>;
  };
  if (typeof idbWithDatabases.databases !== "function") return;
  const dbs = await idbWithDatabases.databases();
  for (const db of dbs) {
    if (!db.name) continue;
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(db.name as string);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  }
}

async function clearSiteData(): Promise<void> {
  try {
    window.localStorage?.clear();
  } catch {
    // Best effort only.
  }
  try {
    window.sessionStorage?.clear();
  } catch {
    // Best effort only.
  }

  expireSiteCookies();

  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {
    // Best effort only.
  }

  try {
    await clearIndexedDbSiteData();
  } catch {
    // Best effort only.
  }

  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
  } catch {
    // Best effort only.
  }
}

function attemptCloseCurrentTab(): boolean {
  try {
    window.close();
    return !!window.closed;
  } catch {
    return false;
  }
}

function clearUnloadSafeSiteData() {
  try {
    window.localStorage?.clear();
  } catch {
    // Best effort only.
  }
  try {
    window.sessionStorage?.clear();
  } catch {
    // Best effort only.
  }
  expireSiteCookies();
}

export function QuickReportApp() {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const headerInputRef = useRef<HTMLInputElement>(null);
  const sourceSelectionAttemptRef = useRef(0);

  const [patientName, setPatientName] = useState("");
  const [dateOfBirthInput, setDateOfBirthInput] = useState("");
  const [physicianName, setPhysicianName] = useState("");
  const [sourceKind, setSourceKind] = useState<DataSourceKind>("folder");
  const [sourceFiles, setSourceFiles] = useState<SourceFile[]>([]);
  const [headerDataUrl, setHeaderDataUrl] = useState<string | undefined>(undefined);
  const [activeReportDays, setActiveReportDays] = useState<ReportRangeDays>(90);

  const [status, setStatus] = useState<"idle" | "working" | "ready" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState("Awaiting data source.");
  const [parseProgress, setParseProgress] = useState<ParseProgress>({
    phase: "idle",
    detail: "Idle",
    percent: 0
  });

  const [generatedReports, setGeneratedReports] = useState<GeneratedReports>({});
  const [isPreviewCollapsed, setIsPreviewCollapsed] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [isSourceLoading, setIsSourceLoading] = useState(false);
  const [pendingSourceSelection, setPendingSourceSelection] = useState<"folder" | "zip" | null>(null);
  const [showCalendarAlt, setShowCalendarAlt] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState<number>(new Date().getMonth() + 1);
  const [calendarYear, setCalendarYear] = useState<number>(new Date().getFullYear());

  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute("webkitdirectory", "");
      folderInputRef.current.setAttribute("directory", "");
    }
  }, []);

  useEffect(() => {
    const handleUnload = () => clearUnloadSafeSiteData();
    window.addEventListener("pagehide", handleUnload);
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      window.removeEventListener("pagehide", handleUnload);
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, []);

  useEffect(() => {
    return () => {
      revokeGeneratedReportUrls(generatedReports);
    };
  }, [generatedReports]);

  const selectedCountLabel = useMemo(() => {
    if (sourceFiles.length === 0) return "No files selected";
    const total = sourceFiles.reduce((sum, f) => sum + f.size, 0);
    return `${sourceFiles.length} files selected (${bytesToLabel(total)})`;
  }, [sourceFiles]);
  const activeReport = generatedReports[activeReportDays] ?? null;
  const activeMetrics = activeReport?.metrics ?? null;
  const hasGeneratedReports = REPORT_RANGE_OPTIONS.some((days) => Boolean(generatedReports[days]));

  const dateOfBirthIso = useMemo(() => normalizeDobInput(dateOfBirthInput), [dateOfBirthInput]);
  const isPatientNameMissing = patientName.trim().length <= 1;
  const isDobMissing = !dateOfBirthIso;
  const selectedDob = useMemo(() => (dateOfBirthIso ? parseIsoDate(dateOfBirthIso) : null), [dateOfBirthIso]);
  const dobCalendarCells = useMemo(() => calendarCells(calendarYear, calendarMonth), [calendarMonth, calendarYear]);
  const yearOptions = useMemo(
    () => Array.from({ length: MAX_YEAR - MIN_YEAR + 1 }, (_, i) => MIN_YEAR + i),
    []
  );

  const canGenerate =
    !isPatientNameMissing &&
    !isDobMissing &&
    sourceFiles.length > 0 &&
    status !== "working";
  const isDataSourceLoading = status === "working" || isSourceLoading || pendingSourceSelection !== null;

  const beginSourceSelection = (kind: "folder" | "zip") => {
    const activeInput = kind === "folder" ? folderInputRef.current : zipInputRef.current;
    if (activeInput) {
      // Clearing value allows selecting the same folder/file again to trigger onChange.
      activeInput.value = "";
    }

    setPendingSourceSelection(kind);
    setIsSourceLoading(true);
    const attemptId = sourceSelectionAttemptRef.current + 1;
    sourceSelectionAttemptRef.current = attemptId;

    const onFocusBack = () => {
      const startedAt = Date.now();
      const waitForSelection = () => {
        if (sourceSelectionAttemptRef.current !== attemptId) return;
        const input = kind === "folder" ? folderInputRef.current : zipInputRef.current;
        const hasChosenFiles = (input?.files?.length ?? 0) > 0;
        if (hasChosenFiles) return;

        // Use a longer timeout so large SD-card selections do not briefly clear
        // the loading overlay before onChange starts.
        if (Date.now() - startedAt >= SOURCE_SELECTION_CANCEL_TIMEOUT_MS) {
          setPendingSourceSelection((current) => (current === kind ? null : current));
          setIsSourceLoading(false);
          return;
        }
        window.setTimeout(waitForSelection, 120);
      };
      window.setTimeout(waitForSelection, 120);
    };
    window.addEventListener("focus", onFocusBack, { once: true });
  };

  const clearSourceInputs = () => {
    if (folderInputRef.current) folderInputRef.current.value = "";
    if (zipInputRef.current) zipInputRef.current.value = "";
  };

  const resetResultState = () => {
    revokeGeneratedReportUrls(generatedReports);
    setGeneratedReports({});
    setActiveReportDays(90);
    setErrors([]);
    setStatus("idle");
    setStatusMessage("Awaiting data source.");
    setParseProgress({ phase: "idle", detail: "Idle", percent: 0 });
    setIsPreviewCollapsed(false);
    setShowCalendarAlt(false);
    setIsSourceLoading(false);
    setPendingSourceSelection(null);
  };

  const handleResetClearAll = async () => {
    if (status === "working") return;
    sourceSelectionAttemptRef.current += 1;

    setStatus("working");
    setStatusMessage("Clearing local data...");
    setParseProgress({ phase: "reset", detail: "Clearing local cache and storage...", percent: 12 });
    setIsSourceLoading(true);
    await yieldToBrowser();

    await clearSiteData();

    resetResultState();
    setSourceFiles([]);
    setSourceKind("folder");
    setPatientName("");
    setDateOfBirthInput("");
    clearSourceInputs();
    setParseProgress({ phase: "idle", detail: "Idle", percent: 0 });
    setStatus("idle");
    setStatusMessage("Local data cleared. Attempting to close this tab...");
    await yieldToBrowser();

    const closed = attemptCloseCurrentTab();
    if (!closed) {
      setStatus("idle");
      setStatusMessage("Local data cleared. Please close this tab/browser manually.");
    }
  };

  const handleFolderSelection: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
    sourceSelectionAttemptRef.current += 1;
    setPendingSourceSelection(null);
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) {
      setIsSourceLoading(false);
      setStatus("idle");
      setStatusMessage("Awaiting data source.");
      setParseProgress({ phase: "idle", detail: "Idle", percent: 0 });
      return;
    }

    setIsSourceLoading(true);
    setStatus("working");
    setStatusMessage("Loading SD folder...");
    setParseProgress({ phase: "scan", detail: "Loading SD folder...", percent: 4 });

    // Yield once so loading overlay paints before indexing a large folder selection.
    await yieldToBrowser();

    try {
      const mapped: SourceFile[] = [];
      const chunkSize = 40;
      let chunkCount = 0;
      for (let start = 0; start < files.length; start += chunkSize) {
        chunkCount += 1;
        const end = Math.min(start + chunkSize, files.length);
        for (let i = start; i < end; i += 1) {
          const file = files[i];
          mapped.push({
            name: file.name,
            path: file.webkitRelativePath || file.name,
            size: file.size,
            readText: () => file.text(),
            readBytes: async () => new Uint8Array(await file.arrayBuffer())
          });
        }

        if (chunkCount % 6 === 0 || end === files.length) {
          const pct = Math.min(45, 5 + Math.round((end / files.length) * 40));
          setParseProgress({
            phase: "scan",
            detail: `Indexing files... ${end}/${files.length}`,
            percent: pct
          });
        }
        await yieldToBrowser();
      }

      setParseProgress({
        phase: "scan",
        detail: `Keeping recent ${IMPORT_LOOKBACK_DAYS}-day window...`,
        percent: 50
      });
      await yieldToBrowser();
      const filtered = filterSourceFilesToRecentWindow(mapped, IMPORT_LOOKBACK_DAYS);

      setSourceKind("folder");
      setSourceFiles(filtered.files);
      revokeGeneratedReportUrls(generatedReports);
      setGeneratedReports({});
      setActiveReportDays(90);
      setErrors([]);
      setIsPreviewCollapsed(false);
      setStatus("idle");
      if (filtered.hadDatedFiles) {
        const endDateText = filtered.latestDateIso ? formatIsoAsUsDate(filtered.latestDateIso) : "latest dated file";
        if (filtered.filteredOutCount > 0) {
          setStatusMessage(
            `Folder loaded: ${filtered.files.length} files ready (last ${IMPORT_LOOKBACK_DAYS} days through ${endDateText}). Filtered out ${filtered.filteredOutCount} older files (${bytesToLabel(filtered.filteredOutBytes)}).`
          );
        } else {
          setStatusMessage(
            `Folder loaded: ${filtered.files.length} files ready (last ${IMPORT_LOOKBACK_DAYS} days through ${endDateText}).`
          );
        }
      } else {
        setStatusMessage(`Folder loaded: ${mapped.length} files ready for parsing.`);
      }
      setParseProgress({ phase: "ready", detail: "Folder ready", percent: 100 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load selected folder.";
      setStatus("error");
      setErrors([message]);
      setStatusMessage("Folder load failed.");
      setParseProgress({ phase: "error", detail: "Folder load failed", percent: 0 });
    } finally {
      setIsSourceLoading(false);
    }
  };

  const handleZipSelection: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
    sourceSelectionAttemptRef.current += 1;
    setPendingSourceSelection(null);
    const zipFile = event.target.files?.[0];
    if (!zipFile) {
      setIsSourceLoading(false);
      setStatus("idle");
      setStatusMessage("Awaiting data source.");
      setParseProgress({ phase: "idle", detail: "Idle", percent: 0 });
      return;
    }

    setIsSourceLoading(true);
    setStatus("working");
    setStatusMessage("Reading ZIP archive locally...");
    setParseProgress({ phase: "zip", detail: "Opening ZIP file...", percent: 8 });

    try {
      const archive = await JSZip.loadAsync(zipFile);
      const entries = Object.values(archive.files)
        .filter((entry) => !entry.dir)
        .slice(0, 2500);
      const mapped: SourceFile[] = [];
      const chunkSize = 40;
      let chunkCount = 0;
      for (let start = 0; start < entries.length; start += chunkSize) {
        chunkCount += 1;
        const end = Math.min(start + chunkSize, entries.length);
        for (let i = start; i < end; i += 1) {
          const entry = entries[i];
          const sizeMaybe = Number((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
          mapped.push({
            name: entry.name.split("/").pop() ?? entry.name,
            path: entry.name,
            size: Number.isFinite(sizeMaybe) ? sizeMaybe : 0,
            readText: async () => await entry.async("string"),
            readBytes: async () => await entry.async("uint8array")
          });
        }
        if (chunkCount % 4 === 0 || end === entries.length) {
          const pct = Math.min(45, 9 + Math.round((end / entries.length) * 36));
          setParseProgress({
            phase: "zip",
            detail: `Indexing ZIP entries... ${end}/${entries.length}`,
            percent: pct
          });
        }
        await yieldToBrowser();
      }

      setParseProgress({
        phase: "zip",
        detail: `Keeping recent ${IMPORT_LOOKBACK_DAYS}-day window...`,
        percent: 50
      });
      await yieldToBrowser();
      const filtered = filterSourceFilesToRecentWindow(mapped, IMPORT_LOOKBACK_DAYS);

      setSourceKind("zip");
      setSourceFiles(filtered.files);
      setStatus("idle");
      if (filtered.hadDatedFiles) {
        const endDateText = filtered.latestDateIso ? formatIsoAsUsDate(filtered.latestDateIso) : "latest dated file";
        if (filtered.filteredOutCount > 0) {
          setStatusMessage(
            `ZIP loaded: ${filtered.files.length} files ready (last ${IMPORT_LOOKBACK_DAYS} days through ${endDateText}). Filtered out ${filtered.filteredOutCount} older files (${bytesToLabel(filtered.filteredOutBytes)}).`
          );
        } else {
          setStatusMessage(
            `ZIP loaded: ${filtered.files.length} files ready (last ${IMPORT_LOOKBACK_DAYS} days through ${endDateText}).`
          );
        }
      } else {
        setStatusMessage(`ZIP loaded: ${mapped.length} files ready for parsing.`);
      }
      setParseProgress({ phase: "ready", detail: "ZIP ready", percent: 100 });
      revokeGeneratedReportUrls(generatedReports);
      setGeneratedReports({});
      setActiveReportDays(90);
      setErrors([]);
      setIsPreviewCollapsed(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not parse ZIP file.";
      setStatus("error");
      setErrors([message]);
      setStatusMessage("ZIP import failed.");
      setParseProgress({ phase: "error", detail: "ZIP import failed", percent: 0 });
    } finally {
      setIsSourceLoading(false);
    }
  };

  const handleHeaderUpload: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
    const imageFile = event.target.files?.[0];
    if (!imageFile) return;
    try {
      const dataUrl = await fileToDataUrl(imageFile);
      setHeaderDataUrl(dataUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load header image.";
      setErrors((prev) => [message, ...prev]);
    }
  };

  const handleGenerate = async () => {
    if (!canGenerate) return;

    setStatus("working");
    setErrors([]);
    setStatusMessage("Processing files locally in this browser...");
    setParseProgress({ phase: "start", detail: "Preparing workflow...", percent: 2 });

    const generated: GeneratedReports = {};
    try {
      const totalRanges = REPORT_RANGE_OPTIONS.length;
      for (let idx = 0; idx < totalRanges; idx += 1) {
        const days = REPORT_RANGE_OPTIONS[idx];
        const segmentStart = Math.round((idx / totalRanges) * 96);
        const segmentSpan = Math.round(96 / totalRanges);

        setParseProgress({
          phase: "start",
          detail: `Generating ${days}-day report (${idx + 1}/${totalRanges})...`,
          percent: Math.max(2, segmentStart)
        });

        const metrics = await buildQuickReportMetrics({
          sourceKind,
          files: sourceFiles,
          patientName,
          dateOfBirthIso: dateOfBirthIso ?? "",
          physicianName,
          lookbackDays: days,
          onProgress: (p) =>
            setParseProgress({
              phase: p.phase,
              detail: `${days}-day: ${p.detail}`,
              percent: Math.min(98, segmentStart + Math.round((Math.max(0, Math.min(100, p.percent)) / 100) * segmentSpan))
            })
        });

        setParseProgress({
          phase: "pdf",
          detail: `Rendering ${days}-day PDF...`,
          percent: Math.min(98, segmentStart + segmentSpan - 1)
        });

        const { blob, filename } = await buildPdfReport(metrics, headerDataUrl);
        const previewUrl = URL.createObjectURL(blob);
        const previewEmbedUrl = await blobToDataUrl(blob);

        generated[days] = {
          metrics,
          previewUrl,
          previewEmbedUrl,
          downloadName: filename
        };
      }

      revokeGeneratedReportUrls(generatedReports);
      setGeneratedReports(generated);
      setActiveReportDays(90);
      setIsPreviewCollapsed(false);
      setStatus("ready");
      setStatusMessage("Report generated successfully. Review preview and export PDF.");
      setParseProgress({ phase: "done", detail: "Done", percent: 100 });
      setErrors([]);
    } catch (error) {
      revokeGeneratedReportUrls(generated);
      const message = error instanceof Error ? error.message : "An unexpected error occurred.";
      setStatus("error");
      setStatusMessage("Report generation failed.");
      setErrors([message]);
      setParseProgress({ phase: "error", detail: "Failed", percent: 0 });
    }
  };

  const triggerDownload = () => {
    if (!activeReport?.previewUrl) return;
    const a = document.createElement("a");
    a.href = activeReport.previewUrl;
    a.download = activeReport.downloadName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const openPreviewInNewTab = () => {
    if (!activeReport?.previewUrl) return;
    window.open(activeReport.previewUrl, "_blank", "noopener,noreferrer");
  };

  const openCalendarPicker = () => {
    setShowCalendarAlt((current) => {
      const next = !current;
      if (next) {
        const seed = selectedDob ?? {
          year: new Date().getFullYear(),
          month: new Date().getMonth() + 1,
          day: 1
        };
        setCalendarYear(seed.year);
        setCalendarMonth(seed.month);
      }
      return next;
    });
  };

  const moveCalendarMonth = (offset: number) => {
    let nextMonth = calendarMonth + offset;
    let nextYear = calendarYear;
    while (nextMonth < 1) {
      nextMonth += 12;
      nextYear -= 1;
    }
    while (nextMonth > 12) {
      nextMonth -= 12;
      nextYear += 1;
    }
    if (nextYear < MIN_YEAR || nextYear > MAX_YEAR) return;
    setCalendarYear(nextYear);
    setCalendarMonth(nextMonth);
  };

  const pickCalendarDate = (day: number) => {
    setDateOfBirthInput(toUsDate(calendarYear, calendarMonth, day));
    setShowCalendarAlt(false);
  };

  return (
    <main>
      <section className="hero">
        <h1>CPAP Clinician QuickReport</h1>
        <p>Create a 90/30/7-day CPAP PDF report in a few steps. Data is processed locally and never stored.</p>
        <p className="subtle">
          Powered by{" "}
          <a href="https://notespecialist.com" target="_blank" rel="noopener noreferrer">
            notespecialist.com
          </a>
          {", "}an AI-powered clinical documentation tool.
        </p>
      </section>

      <section className="grid">
        <article className="card col-12">
          <h3>How-To Use</h3>
          <ol className="usage-steps">
            <li>Enter the patient name and date of birth.</li>
            <li>Click <strong>Select SD-CARD</strong> and choose the SD card folder.</li>
            <li>Click <strong>Generate Reports</strong> to create 90, 30, and 7 day reports.</li>
            <li>Use the report tabs in preview, then click <strong>Export PDF</strong> to save.</li>
          </ol>
        </article>

        <article className="card col-4">
          <h3>Patient</h3>
          <label htmlFor="patientName" className="label-row">
            <span>Patient name</span>
            {isPatientNameMissing ? <span className="required-flag">Required</span> : null}
          </label>
          <input
            id="patientName"
            className="input"
            value={patientName}
            onChange={(e) => setPatientName(e.target.value)}
            placeholder="First Last"
            autoComplete="off"
          />

          <label htmlFor="dob" className="label-row" style={{ marginTop: 10 }}>
            <span>Date of birth</span>
            {isDobMissing ? <span className="required-flag">Required</span> : null}
          </label>
          <input
            id="dob"
            className="date-input"
            type="text"
            inputMode="numeric"
            placeholder="MM/DD/YYYY"
            value={dateOfBirthInput}
            onChange={(e) => setDateOfBirthInput(formatDobTyping(e.target.value))}
          />
          {dateOfBirthInput.trim().length > 0 && !dateOfBirthIso ? (
            <p className="subtle" style={{ marginTop: 6, color: "#a11c1c" }}>
              Enter date as MM/DD/YYYY.
            </p>
          ) : null}
          <button type="button" className="link-button" style={{ marginBottom: 10 }} onClick={openCalendarPicker}>
            {showCalendarAlt ? "Hide calendar picker" : "Use calendar picker instead"}
          </button>
          {showCalendarAlt ? (
            <div className="calendar-panel" role="dialog" aria-label="Date of birth calendar picker">
              <div className="calendar-toolbar">
                <button type="button" className="btn btn-secondary btn-calendar-nav" onClick={() => moveCalendarMonth(-1)}>
                  ◀
                </button>
                <select
                  className="input calendar-select"
                  value={calendarMonth}
                  onChange={(e) => setCalendarMonth(Number(e.target.value))}
                  aria-label="Select month"
                >
                  {MONTH_LABELS.map((monthLabel, idx) => (
                    <option key={monthLabel} value={idx + 1}>
                      {monthLabel}
                    </option>
                  ))}
                </select>
                <select
                  className="input calendar-select"
                  value={calendarYear}
                  onChange={(e) => setCalendarYear(Number(e.target.value))}
                  aria-label="Select year"
                >
                  {yearOptions.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-secondary btn-calendar-nav" onClick={() => moveCalendarMonth(1)}>
                  ▶
                </button>
              </div>
              <div className="calendar-grid calendar-weekdays">
                {WEEKDAY_LABELS.map((weekday) => (
                  <div key={weekday} className="calendar-weekday">
                    {weekday}
                  </div>
                ))}
              </div>
              <div className="calendar-grid">
                {dobCalendarCells.map((day, index) => {
                  const selected =
                    Boolean(day) &&
                    selectedDob &&
                    selectedDob.year === calendarYear &&
                    selectedDob.month === calendarMonth &&
                    selectedDob.day === day;
                  return (
                    <button
                      key={`${calendarYear}-${calendarMonth}-${index}`}
                      type="button"
                      className={`calendar-day ${selected ? "calendar-day-selected" : ""}`}
                      onClick={() => day && pickCalendarDate(day)}
                      disabled={!day}
                    >
                      {day ?? ""}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <h3 style={{ marginTop: 18, marginBottom: 8 }}>Office Branding</h3>
          <label htmlFor="physician" style={{ marginTop: 12 }}>
            Physician name
          </label>
          <input
            id="physician"
            className="input"
            value={physicianName}
            onChange={(e) => setPhysicianName(e.target.value)}
            autoComplete="off"
          />

          <label htmlFor="header-upload" style={{ marginTop: 10 }}>
            Optional PDF header image
          </label>
          <input id="header-upload" ref={headerInputRef} type="file" accept="image/png,image/jpeg" onChange={handleHeaderUpload} />
          <p className="subtle">Use a clinic branding image if desired. If omitted, a neutral header is used.</p>
        </article>

        <article className={`card col-8 ${isDataSourceLoading ? "card-loading" : ""}`} aria-busy={isDataSourceLoading}>
          {isDataSourceLoading ? <div className="loading-overlay">Loading data. Please wait...</div> : null}
          <h3>Data Source</h3>
          <p className="subtle">Choose an SD-card folder. The webapp keeps only the most recent 90 days NIMV data locally in browser.</p>

          <div className="actions">
            <button
              className="btn btn-secondary"
              onClick={() => {
                beginSourceSelection("folder");
                folderInputRef.current?.click();
              }}
              disabled={isDataSourceLoading}
            >
              Select SD-CARD
            </button>
          </div>

          <input ref={folderInputRef} type="file" multiple onChange={handleFolderSelection} style={{ display: "none" }} />
          <input ref={zipInputRef} type="file" accept=".zip" onChange={handleZipSelection} style={{ display: "none" }} />

          <p style={{ marginTop: 12 }}>
            <strong>Status:</strong> {selectedCountLabel}
          </p>

          <div className="file-list" aria-live="polite">
            <ul>
              {sourceFiles.slice(0, 25).map((file) => (
                <li key={`${file.path}:${file.size}`}>
                  {file.path} <span className="subtle">({bytesToLabel(file.size)})</span>
                </li>
              ))}
            </ul>
            {sourceFiles.length > 25 ? <p className="subtle">+ {sourceFiles.length - 25} more files</p> : null}
          </div>

          <div className="actions">
            <button className="btn btn-primary" onClick={handleGenerate} disabled={!canGenerate}>
              Generate Reports
            </button>
            <button
              className="btn btn-danger"
              onClick={handleResetClearAll}
              disabled={status === "working"}
            >
              Reset / Clear All
            </button>
          </div>
          <div className="progress-wrap" role="status" aria-live="polite">
            <div className="progress-track">
              <div className="progress-value" style={{ width: `${parseProgress.percent}%` }} />
            </div>
            <div className="phase">
              {parseProgress.percent}% - {parseProgress.detail}
            </div>
            {pendingSourceSelection ? (
              <div className="subtle" style={{ marginTop: 4 }}>
                {pendingSourceSelection === "folder" ? "Opening SD-CARD folder..." : "Opening ZIP file..."}
              </div>
            ) : null}
          </div>
        </article>

        {status === "ready" || status === "error" ? (
          <article className="card col-12">
            {status === "ready" && activeMetrics ? (
              <ul className="notes">
                <li>Report is ready. Review the preview, then export the PDF.</li>
                <li>
                  Selected loader and Date range ({activeReportDays} days): {activeMetrics.selectedLoader} | {activeMetrics.dateRangeStart} to {activeMetrics.dateRangeEnd}
                </li>
              </ul>
            ) : null}

            {status === "error" ? (
              <>
                <p className="subtle" style={{ marginTop: 0, color: "#a11c1c" }}>
                  Report generation failed.
                </p>
                {errors.length > 0 ? (
                  <ul className="notes">
                    {errors.map((err) => (
                      <li key={err}>{err}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
          </article>
        ) : null}

        {hasGeneratedReports && activeReport ? (
          <article className="card col-12 preview-shell">
            <div className="range-tabs" role="tablist" aria-label="Generated report tabs">
              {REPORT_RANGE_OPTIONS.map((days) => (
                <button
                  key={days}
                  type="button"
                  role="tab"
                  aria-selected={activeReportDays === days}
                  className={`range-tab ${activeReportDays === days ? "range-tab-active" : ""}`}
                  onClick={() => setActiveReportDays(days)}
                  disabled={!generatedReports[days]}
                >
                  {days} Days
                </button>
              ))}
            </div>
            <div className="actions" style={{ marginTop: 0 }}>
              <button className="btn btn-primary" onClick={triggerDownload}>
                Export PDF
              </button>
              <button className="btn btn-secondary" onClick={openPreviewInNewTab}>
                Open PDF
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setIsPreviewCollapsed((current) => !current);
                }}
              >
                {isPreviewCollapsed ? "Open Preview" : "Close Preview"}
              </button>
              <span className="subtle">Default filename: {activeReport.downloadName}</span>
            </div>
            {!isPreviewCollapsed ? (
              <>
                <iframe
                  key={activeReport.previewUrl}
                  className="preview-frame"
                  src={activeReport.previewEmbedUrl ?? activeReport.previewUrl}
                  title="PDF preview"
                />
                <p className="subtle">If preview is blank on this browser, use Open PDF.</p>
              </>
            ) : (
              <p className="subtle">Preview collapsed. Use Open Preview to expand.</p>
            )}
          </article>
        ) : null}

        <article className="card col-12 legal-notice">
          <details className="legal-disclosure">
            <summary>{"\u00A0\u00A0GNU/OSCAR Copyright and Distribution Notice"}</summary>
            <ul className="notes">
              <li>
                This app contains parser behavior derived from OSCAR (Open Source CPAP Analysis Reporter), which is GPLv3-licensed software.
              </li>
              <li>
                Attribution from OSCAR repository materials: SleepyHead copyright (C) 2011-2018 Mark Watkins; portions of OSCAR copyright (C) 2019-2022 The OSCAR Team.
              </li>
              <li>
                Distribution requirement: if you distribute this app, or modified versions that include GPL-covered OSCAR-derived code, provide corresponding source code and preserve GPLv3 terms and attribution notices.
              </li>
              <li>No warranty: this software is provided without warranty, consistent with GNU GPL terms.</li>
              <li>
                References:{" "}
                <a href="https://www.sleepfiles.com/OSCAR/" target="_blank" rel="noopener noreferrer">
                  OSCAR project
                </a>
                {" | "}
                <a href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noopener noreferrer">
                  GNU GPL v3 license text
                </a>
              </li>
            </ul>
          </details>
        </article>
      </section>
    </main>
  );
}
