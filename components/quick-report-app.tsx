"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { enumerateDeferredFolderEntries, pickDirectoryHandle, supportsDirectoryPicker } from "@/lib/directory-picker";
import { ReportWorkerClient } from "@/lib/report-worker-client";
import { REPORT_RANGE_OPTIONS, type ReportRangeDays } from "@/lib/report-orchestrator";
import { bytesToLabel, IMPORT_LOOKBACK_DAYS } from "@/lib/source-files";
import { daysSinceIsoDate, staleDataAgeClassName, staleDataSeverity } from "@/lib/stale-data";
import { ParseProgress, QuickReportMetrics, SourceFileSummary } from "@/lib/types";

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
const SOURCE_SELECTION_CANCEL_TIMEOUT_MS = 20000;
const CARD_READER_PRODUCTS = [
  {
    title: "Acer Dual USB-C and USB-A Card Reader",
    description: "Pocket-sized reader for offices that switch between USB-C and USB-A devices.",
    href: "https://amzn.to/4teCHDp",
    imageSrc: "/card-readers/first-item.jpg",
    imageAlt: "Acer dual USB-C and USB-A SD card reader"
  },
  {
    title: "Acer USB-A 3.0 Card Reader",
    description: "Reliable option for desktops, older laptops, and standard USB-A ports.",
    href: "https://amzn.to/3QFf1dL",
    imageSrc: "/card-readers/second-item.jpg",
    imageAlt: "Acer USB-A 3.0 SD card reader"
  },
  {
    title: "Acer USB-C Card Reader",
    description: "Best fit for newer laptops, tablets, phones, and other USB-C devices.",
    href: "https://amzn.to/4tP1IWP",
    imageSrc: "/card-readers/third-item.jpg",
    imageAlt: "Acer USB-C SD and microSD card reader"
  }
] as const;
const LONG_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC"
});
type GeneratedReportArtifact = {
  metrics: QuickReportMetrics;
  previewUrl: string;
  downloadName: string;
};
type GeneratedReports = Partial<Record<ReportRangeDays, GeneratedReportArtifact>>;

function revokeGeneratedReportUrls(reports: GeneratedReports) {
  for (const days of REPORT_RANGE_OPTIONS) {
    const artifact = reports[days];
    if (artifact?.previewUrl) {
      URL.revokeObjectURL(artifact.previewUrl);
    }
  }
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

function formatIsoDateLong(isoDate: string): string {
  const parsed = parseIsoDate(isoDate);
  if (!parsed) return isoDate;
  return LONG_DATE_FORMATTER.format(Date.UTC(parsed.year, parsed.month - 1, parsed.day, 12));
}

function isMixedDataWarning(warning: string): boolean {
  return /^(?:Mixed device data detected|Multiple device layouts detected)\./.test(warning);
}

function isTherapyChangeWarning(warning: string): boolean {
  return /^Therapy settings changed within\b/.test(warning);
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

function isPickerAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export function QuickReportApp() {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const headerInputRef = useRef<HTMLInputElement>(null);
  const workerClientRef = useRef<ReportWorkerClient | null>(null);
  const sourceSelectionAttemptRef = useRef(0);
  const parseProgressRafRef = useRef<number | null>(null);
  const queuedParseProgressRef = useRef<ParseProgress | null>(null);

  const [patientName, setPatientName] = useState("");
  const [dateOfBirthInput, setDateOfBirthInput] = useState("");
  const [physicianName, setPhysicianName] = useState("");
  const [sourceFiles, setSourceFiles] = useState<SourceFileSummary[]>([]);
  const [sourceFileCount, setSourceFileCount] = useState(0);
  const [sourceFileBytes, setSourceFileBytes] = useState(0);
  const [loadedSourceLoader, setLoadedSourceLoader] = useState<string | null>(null);
  const [loadedSourceLatestClinicalDayIso, setLoadedSourceLatestClinicalDayIso] = useState<string | null>(null);
  const [loadedSourceWarnings, setLoadedSourceWarnings] = useState<string[]>([]);
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
    const client = new ReportWorkerClient();
    workerClientRef.current = client;
    return () => {
      if (parseProgressRafRef.current !== null) {
        window.cancelAnimationFrame(parseProgressRafRef.current);
        parseProgressRafRef.current = null;
      }
      workerClientRef.current = null;
      client.dispose();
    };
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
    if (sourceFileCount === 0) return "No files selected";
    return `${sourceFileCount} files selected (${bytesToLabel(sourceFileBytes)})`;
  }, [sourceFileBytes, sourceFileCount]);
  const loadedSourceLatestClinicalDayLabel = useMemo(
    () => (loadedSourceLatestClinicalDayIso ? formatIsoDateLong(loadedSourceLatestClinicalDayIso) : null),
    [loadedSourceLatestClinicalDayIso]
  );
  const loadedSourceLatestClinicalDayAge = useMemo(
    () => (loadedSourceLatestClinicalDayIso ? daysSinceIsoDate(loadedSourceLatestClinicalDayIso) : null),
    [loadedSourceLatestClinicalDayIso]
  );
  const loadedSourceStaleSeverity = staleDataSeverity(loadedSourceLatestClinicalDayAge);
  const staleDataAgeText = loadedSourceStaleSeverity ? `Data is ${loadedSourceLatestClinicalDayAge} days old.` : null;
  const staleDataAgeClass = staleDataAgeClassName(loadedSourceStaleSeverity);
  const loadedMixedDataWarning = useMemo(
    () => loadedSourceWarnings.find(isMixedDataWarning) ?? null,
    [loadedSourceWarnings]
  );
  const loadedTherapyChangeWarning = useMemo(
    () => loadedSourceWarnings.find(isTherapyChangeWarning) ?? null,
    [loadedSourceWarnings]
  );
  const generatedReportDays = useMemo(
    () => REPORT_RANGE_OPTIONS.filter((days) => Boolean(generatedReports[days])),
    [generatedReports]
  );
  const resolvedActiveReportDays = generatedReports[activeReportDays] ? activeReportDays : (generatedReportDays[0] ?? null);
  const activeReport = resolvedActiveReportDays ? generatedReports[resolvedActiveReportDays] ?? null : null;
  const activeMetrics = activeReport?.metrics ?? null;
  const activeTherapyChangeWarning = activeMetrics?.warnings.find(isTherapyChangeWarning) ?? null;
  const displayedTherapyChangeWarning = activeTherapyChangeWarning ?? loadedTherapyChangeWarning;
  const hasGeneratedReports = generatedReportDays.length > 0;

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
    sourceFileCount > 0 &&
    status !== "working";
  const isDataSourceLoading = status === "working" || isSourceLoading || pendingSourceSelection !== null;
  const dataSourceOverlayText = isSourceLoading
    ? "Loading data. Please wait..."
    : pendingSourceSelection
      ? pendingSourceSelection === "folder"
        ? "Opening folder picker..."
        : "Opening file picker..."
      : "Generating report. Please wait...";

  const beginSourceSelection = (kind: "folder" | "zip") => {
    const activeInput = kind === "folder" ? folderInputRef.current : zipInputRef.current;
    if (activeInput) {
      // Clearing value allows selecting the same folder/file again to trigger onChange.
      activeInput.value = "";
    }

    const openingMessage = kind === "folder" ? "Opening SD-CARD folder..." : "Opening ZIP file...";
    const previousStatusMessage = statusMessage;
    const clearPendingSelection = () => {
      setPendingSourceSelection((current) => (current === kind ? null : current));
      setIsSourceLoading(false);
      setStatusMessage((current) => (current === openingMessage ? previousStatusMessage : current));
    };

    flushSync(() => {
      setPendingSourceSelection(kind);
      setIsSourceLoading(true);
      setStatusMessage(openingMessage);
    });

    const attemptId = sourceSelectionAttemptRef.current + 1;
    sourceSelectionAttemptRef.current = attemptId;
    const onInputCancel = () => {
      if (sourceSelectionAttemptRef.current !== attemptId) return;
      sourceSelectionAttemptRef.current += 1;
      clearPendingSelection();
    };
    activeInput?.addEventListener("cancel", onInputCancel, { once: true });

    const onFocusBack = () => {
      const startedAt = Date.now();
      const waitForSelection = () => {
        if (sourceSelectionAttemptRef.current !== attemptId) {
          activeInput?.removeEventListener("cancel", onInputCancel);
          return;
        }
        const input = kind === "folder" ? folderInputRef.current : zipInputRef.current;
        const hasChosenFiles = (input?.files?.length ?? 0) > 0;
        if (hasChosenFiles) {
          activeInput?.removeEventListener("cancel", onInputCancel);
          return;
        }

        // Use a longer timeout so large SD-card selections do not briefly clear
        // the pending selection state before onChange starts.
        if (Date.now() - startedAt >= SOURCE_SELECTION_CANCEL_TIMEOUT_MS) {
          activeInput?.removeEventListener("cancel", onInputCancel);
          clearPendingSelection();
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

  const setParseProgressImmediate = useCallback((progress: ParseProgress) => {
    if (parseProgressRafRef.current !== null) {
      window.cancelAnimationFrame(parseProgressRafRef.current);
      parseProgressRafRef.current = null;
    }
    queuedParseProgressRef.current = null;
    setParseProgress(progress);
  }, []);

  const queueParseProgress = useCallback((progress: ParseProgress) => {
    queuedParseProgressRef.current = progress;
    if (parseProgressRafRef.current !== null) return;
    parseProgressRafRef.current = window.requestAnimationFrame(() => {
      parseProgressRafRef.current = null;
      const next = queuedParseProgressRef.current;
      queuedParseProgressRef.current = null;
      if (next) setParseProgress(next);
    });
  }, []);

  const resetResultState = () => {
    revokeGeneratedReportUrls(generatedReports);
    setGeneratedReports({});
    setActiveReportDays(90);
    setErrors([]);
    setStatus("idle");
    setStatusMessage("Awaiting data source.");
    setParseProgressImmediate({ phase: "idle", detail: "Idle", percent: 0 });
    setIsPreviewCollapsed(false);
    setShowCalendarAlt(false);
    setIsSourceLoading(false);
    setPendingSourceSelection(null);
    setSourceFileCount(0);
    setSourceFileBytes(0);
    setLoadedSourceLoader(null);
    setLoadedSourceLatestClinicalDayIso(null);
    setLoadedSourceWarnings([]);
  };

  const handleResetClearAll = async () => {
    if (status === "working") return;
    sourceSelectionAttemptRef.current += 1;

    setStatus("working");
    setErrors([]);
    setStatusMessage("Clearing local data...");
    setParseProgressImmediate({ phase: "reset", detail: "Clearing local cache and storage...", percent: 12 });
    setIsSourceLoading(true);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    try {
      await clearSiteData();
      await workerClientRef.current?.reset();

      resetResultState();
      setSourceFiles([]);
      setSourceFileCount(0);
      setSourceFileBytes(0);
      setPatientName("");
      setDateOfBirthInput("");
      clearSourceInputs();
      setParseProgressImmediate({ phase: "idle", detail: "Idle", percent: 0 });
      setStatus("idle");
      setStatusMessage("Local data cleared.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not clear local data.";
      setStatus("error");
      setErrors([message]);
      setStatusMessage("Reset / Clear All failed.");
      setParseProgressImmediate({ phase: "error", detail: "Reset failed", percent: 0 });
    } finally {
      setIsSourceLoading(false);
    }
  };

  const handleFolderSelection: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
    sourceSelectionAttemptRef.current += 1;
    setPendingSourceSelection(null);
    const files = event.target.files;
    if (!files || files.length === 0) {
      setIsSourceLoading(false);
      setStatus("idle");
      setStatusMessage("Awaiting data source.");
      setParseProgressImmediate({ phase: "idle", detail: "Idle", percent: 0 });
      return;
    }

    setIsSourceLoading(true);
    setStatus("working");
    setStatusMessage("Loading SD folder...");
    setParseProgressImmediate({ phase: "scan", detail: "Loading SD folder...", percent: 4 });
    setLoadedSourceLoader(null);
    setLoadedSourceLatestClinicalDayIso(null);
    setLoadedSourceWarnings([]);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    try {
      const client = workerClientRef.current;
      if (!client) throw new Error("Background worker is not available.");
      const loaded = await client.loadFolder(files, {
        importLookbackDays: IMPORT_LOOKBACK_DAYS,
        parseLookbackDays: REPORT_RANGE_OPTIONS[0],
        onProgress: (progress) => queueParseProgress(progress)
      });

      setSourceFiles(loaded.files);
      setSourceFileCount(loaded.totalFileCount);
      setSourceFileBytes(loaded.totalBytes);
      setLoadedSourceLoader(loaded.selectedLoader);
      setLoadedSourceLatestClinicalDayIso(loaded.latestClinicalDayIso);
      setLoadedSourceWarnings(loaded.warnings);
      revokeGeneratedReportUrls(generatedReports);
      setGeneratedReports({});
      setActiveReportDays(90);
      setErrors([]);
      setIsPreviewCollapsed(false);
      setStatus("idle");
      setStatusMessage(loaded.statusMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load selected folder.";
      setLoadedSourceLoader(null);
      setLoadedSourceLatestClinicalDayIso(null);
      setLoadedSourceWarnings([]);
      setStatus("error");
      setErrors([message]);
      setStatusMessage("Folder load failed.");
      setParseProgressImmediate({ phase: "error", detail: "Folder load failed", percent: 0 });
    } finally {
      setIsSourceLoading(false);
    }
  };

  const handleDirectoryPickerSelection = async () => {
    sourceSelectionAttemptRef.current += 1;
    setPendingSourceSelection("folder");

    try {
      const rootHandle = await pickDirectoryHandle(() => {
        setIsSourceLoading(true);
        setStatus("working");
        setStatusMessage("Loading SD-CARD...");
        setParseProgressImmediate({ phase: "scan", detail: "Loading SD-CARD...", percent: 1 });
        setLoadedSourceLoader(null);
        setLoadedSourceLatestClinicalDayIso(null);
        setLoadedSourceWarnings([]);
      });
      const client = workerClientRef.current;
      if (!client) throw new Error("Background worker is not available.");

      let loaded;
      try {
        loaded = await client.loadFolderHandle(rootHandle, {
          importLookbackDays: IMPORT_LOOKBACK_DAYS,
          parseLookbackDays: REPORT_RANGE_OPTIONS[0],
          onProgress: (progress) => queueParseProgress(progress)
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Directory handle transfer to worker failed.";
        if (!/directory handle transfer/i.test(message)) {
          throw error;
        }
        const deferredEntries = await enumerateDeferredFolderEntries(rootHandle, IMPORT_LOOKBACK_DAYS, (progress) =>
          queueParseProgress(progress)
        );
        if (deferredEntries.length === 0) {
          setPendingSourceSelection(null);
          setIsSourceLoading(false);
          setStatus("idle");
          setStatusMessage("Directory picker returned no files. Falling back to browser folder selection...");
          setParseProgressImmediate({ phase: "idle", detail: "Idle", percent: 0 });
          beginSourceSelection("folder");
          folderInputRef.current?.click();
          return;
        }

        loaded = await client.loadFolderEntries(deferredEntries, {
          importLookbackDays: IMPORT_LOOKBACK_DAYS,
          parseLookbackDays: REPORT_RANGE_OPTIONS[0],
          onProgress: (progress) => queueParseProgress(progress)
        });
      }

      setSourceFiles(loaded.files);
      setSourceFileCount(loaded.totalFileCount);
      setSourceFileBytes(loaded.totalBytes);
      setLoadedSourceLoader(loaded.selectedLoader);
      setLoadedSourceLatestClinicalDayIso(loaded.latestClinicalDayIso);
      setLoadedSourceWarnings(loaded.warnings);
      revokeGeneratedReportUrls(generatedReports);
      setGeneratedReports({});
      setActiveReportDays(90);
      setErrors([]);
      setIsPreviewCollapsed(false);
      setStatus("idle");
      setStatusMessage(loaded.statusMessage);
    } catch (error) {
      if (isPickerAbort(error)) {
        setStatus("idle");
        setStatusMessage("Awaiting data source.");
        setParseProgressImmediate({ phase: "idle", detail: "Idle", percent: 0 });
        return;
      }

      const message = error instanceof Error ? error.message : "Could not load selected folder.";
      setLoadedSourceLoader(null);
      setLoadedSourceLatestClinicalDayIso(null);
      setLoadedSourceWarnings([]);
      setStatus("error");
      setErrors([message]);
      setStatusMessage("Folder load failed.");
      setParseProgressImmediate({ phase: "error", detail: "Folder load failed", percent: 0 });
    } finally {
      setPendingSourceSelection(null);
      setIsSourceLoading(false);
    }
  };

  const handleFolderButtonClick = async () => {
    if (supportsDirectoryPicker()) {
      await handleDirectoryPickerSelection();
      return;
    }

    beginSourceSelection("folder");
    folderInputRef.current?.click();
  };

  const handleZipSelection: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
    sourceSelectionAttemptRef.current += 1;
    setPendingSourceSelection(null);
    const zipFile = event.target.files?.[0];
    if (!zipFile) {
      setIsSourceLoading(false);
      setStatus("idle");
      setStatusMessage("Awaiting data source.");
      setParseProgressImmediate({ phase: "idle", detail: "Idle", percent: 0 });
      return;
    }

    setIsSourceLoading(true);
    setStatus("working");
    setStatusMessage("Reading ZIP archive locally...");
    setParseProgressImmediate({ phase: "zip", detail: "Opening ZIP file...", percent: 8 });
    setLoadedSourceLoader(null);
    setLoadedSourceLatestClinicalDayIso(null);
    setLoadedSourceWarnings([]);

    try {
      const client = workerClientRef.current;
      if (!client) throw new Error("Background worker is not available.");
      const loaded = await client.loadZip(zipFile, {
        importLookbackDays: IMPORT_LOOKBACK_DAYS,
        parseLookbackDays: REPORT_RANGE_OPTIONS[0],
        onProgress: (progress) => queueParseProgress(progress)
      });

      setSourceFiles(loaded.files);
      setSourceFileCount(loaded.totalFileCount);
      setSourceFileBytes(loaded.totalBytes);
      setLoadedSourceLoader(loaded.selectedLoader);
      setLoadedSourceLatestClinicalDayIso(loaded.latestClinicalDayIso);
      setLoadedSourceWarnings(loaded.warnings);
      setStatus("idle");
      setStatusMessage(loaded.statusMessage);
      revokeGeneratedReportUrls(generatedReports);
      setGeneratedReports({});
      setActiveReportDays(90);
      setErrors([]);
      setIsPreviewCollapsed(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not parse ZIP file.";
      setLoadedSourceLoader(null);
      setLoadedSourceLatestClinicalDayIso(null);
      setLoadedSourceWarnings([]);
      setStatus("error");
      setErrors([message]);
      setStatusMessage("ZIP import failed.");
      setParseProgressImmediate({ phase: "error", detail: "ZIP import failed", percent: 0 });
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

  const clearBrandingImage = () => {
    setHeaderDataUrl(undefined);
    if (headerInputRef.current) headerInputRef.current.value = "";
  };

  const handleGenerate = async () => {
    if (!canGenerate) return;

    setStatus("working");
    setErrors([]);
    setStatusMessage("Generating report...");
    setParseProgressImmediate({ phase: "start", detail: "Generating report...", percent: 2 });

    try {
      const client = workerClientRef.current;
      if (!client) throw new Error("Background worker is not available.");
      const result = await client.generateReports(
        {
          patientName,
          dateOfBirthIso: dateOfBirthIso ?? "",
          physicianName,
          headerDataUrl
        },
        (progress) => queueParseProgress(progress)
      );

      const generated: GeneratedReports = {};
      for (const artifact of result.reports) {
        const days = artifact.days as ReportRangeDays;
        generated[days] = {
          metrics: artifact.metrics,
          previewUrl: URL.createObjectURL(artifact.blob),
          downloadName: artifact.filename
        };
      }

      revokeGeneratedReportUrls(generatedReports);
      setGeneratedReports(generated);
      const largestAvailableTab = REPORT_RANGE_OPTIONS.find((days) => Boolean(generated[days])) ?? 7;
      setActiveReportDays(largestAvailableTab);
      setIsPreviewCollapsed(false);
      setStatus("ready");
      setStatusMessage(result.statusMessage);
      setParseProgressImmediate({ phase: "done", detail: "Done", percent: 100 });
      setErrors([]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "An unexpected error occurred.";
      setStatus("error");
      setStatusMessage("Report generation failed.");
      setErrors([message]);
      setParseProgressImmediate({ phase: "error", detail: "Failed", percent: 0 });
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
        <h1>NIMV Clinician QuickReport</h1>
        <p>Create a 90/60/30/7-day NIMV PDF report in a few steps. Data is processed locally and never stored.</p>
        <p className="subtle">
          Powered by{" "}
          <a href="https://notespecialist.com" target="_blank" rel="noopener noreferrer">
            NoteSpecialist.com
          </a>
          {", "}an AI-powered clinical documentation tool.
        </p>
      </section>

      <section className="grid">
        <article className="card col-12">
          <h3>How-To Use</h3>
          <ol className="usage-steps">
            <li>Enter the patient name and date of birth.</li>
            <li>Click <strong>Select SD-CARD</strong> and choose the SD-card root folder.</li>
            <li>Click <strong>Generate Reports</strong> to create 90, 60, 30, and 7 day reports.</li>
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
          {headerDataUrl ? (
            <button type="button" className="link-button subtle-link-button" onClick={clearBrandingImage}>
              Clear branding image
            </button>
          ) : null}
          <p className="subtle">Use a clinic branding image if desired. The Quick Report header remains visible.</p>
        </article>

        <article className={`card col-8 ${isDataSourceLoading ? "card-loading" : ""}`} aria-busy={isDataSourceLoading}>
          {isDataSourceLoading ? <div className="loading-overlay">{dataSourceOverlayText}</div> : null}
          <h3>Data Source</h3>
          <p className="subtle">Choose the SD-card root folder. Do not select a subfolder. The webapp keeps only the most recent 90 days NIMV data locally in browser.</p>

          <div className="actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                void handleFolderButtonClick();
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
          {loadedSourceLoader || loadedSourceLatestClinicalDayLabel || loadedMixedDataWarning ? (
            <ul className="notes" style={{ marginTop: 8 }}>
              {loadedSourceLoader ? <li>Detected loader: {loadedSourceLoader}</li> : null}
              {loadedMixedDataWarning ? <li className="mixed-data-warning">{loadedMixedDataWarning}</li> : null}
              {loadedSourceLatestClinicalDayLabel ? (
                <li>
                  Last date with data on card: {loadedSourceLatestClinicalDayLabel}
                  {staleDataAgeText ? (
                    <span className="stale-data-detail">
                      {" - "}
                      <span className={staleDataAgeClass}>{staleDataAgeText}</span>
                      <br />
                      <span className="stale-data-context">This may indicate the device is not being used or the card is not current.</span>
                    </span>
                  ) : null}
                </li>
              ) : null}
            </ul>
          ) : null}

          <div className="file-list" aria-live="polite">
            <ul>
              {sourceFiles.map((file) => (
                <li key={`${file.path}:${file.size}`}>
                  {file.path} <span className="subtle">({bytesToLabel(file.size)})</span>
                </li>
              ))}
            </ul>
            {sourceFileCount > sourceFiles.length ? <p className="subtle">+ {sourceFileCount - sourceFiles.length} more files</p> : null}
          </div>

          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={handleGenerate} disabled={!canGenerate}>
              Generate Reports
            </button>
            <button
              type="button"
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
            <h3>Status</h3>
            {status === "ready" && activeMetrics ? (
              <ul className="notes">
                <li>Report is ready. Review the preview, then export the PDF.</li>
                <li>
                  Selected loader and Date range ({resolvedActiveReportDays ?? activeReportDays} days): {activeMetrics.selectedLoader} | {activeMetrics.dateRangeStart} to {activeMetrics.dateRangeEnd}
                </li>
                {displayedTherapyChangeWarning ? <li className="therapy-change-warning">{displayedTherapyChangeWarning}</li> : null}
                {loadedSourceLatestClinicalDayLabel ? (
                  <li>
                    Last date with data on card: {loadedSourceLatestClinicalDayLabel}
                    {staleDataAgeText ? (
                      <span className="stale-data-detail">
                        {" - "}
                        <span className={staleDataAgeClass}>{staleDataAgeText}</span>
                        <br />
                        <span className="stale-data-context">This may indicate the device is not being used or the card is not current.</span>
                      </span>
                    ) : null}
                  </li>
                ) : null}
                {loadedMixedDataWarning ? <li className="mixed-data-warning">{loadedMixedDataWarning}</li> : null}
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
              {generatedReportDays.map((days) => (
                <button
                  key={days}
                  type="button"
                  role="tab"
                  aria-selected={resolvedActiveReportDays === days}
                  className={`range-tab ${resolvedActiveReportDays === days ? "range-tab-active" : ""}`}
                  onClick={() => setActiveReportDays(days)}
                >
                  {days} Days
                </button>
              ))}
            </div>
            <div className="actions" style={{ marginTop: 0 }}>
              <button type="button" className="btn btn-primary" onClick={triggerDownload}>
                Export PDF
              </button>
              <button type="button" className="btn btn-secondary" onClick={openPreviewInNewTab}>
                Open PDF
              </button>
              <button
                type="button"
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
                  src={activeReport.previewUrl}
                  title="PDF preview"
                />
                <p className="subtle">If preview is blank on this browser, use Open PDF.</p>
              </>
            ) : (
              <p className="subtle">Preview collapsed. Use Open Preview to expand.</p>
            )}
          </article>
        ) : null}

        <article className="card col-12 affiliate-card">
          <details className="affiliate-disclosure">
            <summary>
              <span className="affiliate-summary-copy">
                <span className="affiliate-summary-title">Buy your Card reader here</span>
              </span>
              <span className="affiliate-summary-pill">3 options</span>
            </summary>
            <div className="card-reader-list">
              {CARD_READER_PRODUCTS.map((product) => (
                <a
                  key={product.href}
                  className="card-reader-item"
                  href={product.href}
                  target="_blank"
                  rel="noopener noreferrer sponsored"
                  aria-label={`Buy ${product.title} on Amazon`}
                >
                  <span className="card-reader-copy">
                    <strong>{product.title}</strong>
                    <span className="card-reader-description">{product.description}</span>
                    <span className="card-reader-cta">View on Amazon</span>
                  </span>
                  <span className="card-reader-media" aria-hidden="true">
                    <img
                      className="card-reader-image"
                      src={product.imageSrc}
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                  </span>
                </a>
              ))}
            </div>
            <p className="affiliate-note">
              Each product link is an affiliate link. Purchases do not change your price; a small portion supports our team and helps keep this website up and running.
            </p>
          </details>
        </article>

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
