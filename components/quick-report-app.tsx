"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { enumerateDeferredFolderEntries, pickDirectoryHandle, supportsDirectoryPicker } from "@/lib/directory-picker";
import { savePdfArtifact } from "@/lib/pdf-save";
import { ReportWorkerClient } from "@/lib/report-worker-client";
import { REPORT_RANGE_OPTIONS, type ReportRangeDays } from "@/lib/report-orchestrator";
import { formatClockMinutes } from "@/lib/sleep-inference";
import { OLDER_HISTORY_IMPORT_LOOKBACK_DAYS } from "@/lib/source-files";
import { daysSinceIsoDate, staleDataAgeClassName, staleDataSeverity } from "@/lib/stale-data";
import { ParseProgress, QuickReportMetrics, TherapySettingsPeriod } from "@/lib/types";
import { shouldClearPatientDetailsForSourceImport } from "@/lib/ui-workflow";

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
  blob: Blob;
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

function closeOpenedPreviewWindows(previewWindows: Window[]) {
  for (const previewWindow of previewWindows) {
    try {
      if (!previewWindow.closed) previewWindow.close();
    } catch {
      // Best effort only.
    }
  }
  previewWindows.length = 0;
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

function formatMetric(value: number | null | undefined, suffix = ""): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Number(value.toFixed(1))}${suffix}` : "Not available";
}

function formatTherapyShare(
  value: number | null | undefined,
  totalTherapyHours: number | null | undefined
): string {
  const valueText = formatMetric(value, " hrs");
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    typeof totalTherapyHours !== "number" ||
    !Number.isFinite(totalTherapyHours) ||
    totalTherapyHours <= 0
  ) {
    return valueText;
  }

  return `${valueText} (${(value / totalTherapyHours * 100).toFixed(1)}%)`;
}

type UiIconName =
  | "activity"
  | "calendar"
  | "check"
  | "clock"
  | "database"
  | "device"
  | "document"
  | "download"
  | "drop"
  | "eye"
  | "gear"
  | "history"
  | "info"
  | "report"
  | "sd-card"
  | "warning";

function UiIcon({ name, size = 24 }: { name: UiIconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  };

  switch (name) {
    case "clock":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
    case "history":
      return <svg {...common}><path d="M4 11a8 8 0 1 0 2.3-5.7L4 7.5" /><path d="M4 3v4.5h4.5M12 7v5l3 2" /></svg>;
    case "check":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="m8 12 2.6 2.6L16.5 9" /></svg>;
    case "device":
      return <svg {...common}><rect x="3" y="5" width="15" height="12" rx="2" /><path d="M7 9h7v4H7zM7 15h.01M11 15h.01M18 12h2a2 2 0 0 1 2 2v3" /></svg>;
    case "sd-card":
      return <svg {...common}><path d="M6 3h8l5 5v13H5V4a1 1 0 0 1 1-1Z" /><path d="M8 4v5M11 4v5M14 4v3M8 15h8v3H8z" /></svg>;
    case "calendar":
      return <svg {...common}><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 9h16M8 13h.01M12 13h.01M16 13h.01M8 17h.01M12 17h.01" /></svg>;
    case "database":
      return <svg {...common}><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></svg>;
    case "report":
      return <svg {...common}><path d="M4 19V5M4 19h16M8 16v-5M12 16V8M16 16V4" /></svg>;
    case "document":
      return <svg {...common}><path d="M7 3h7l4 4v14H7zM14 3v5h4M10 12h5M10 16h5" /></svg>;
    case "download":
      return <svg {...common}><path d="M12 3v12m0 0-4-4m4 4 4-4M5 16v4h14v-4" /></svg>;
    case "eye":
      return <svg {...common}><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></svg>;
    case "warning":
      return <svg {...common}><path d="m12 3 9 17H3L12 3Z" /><path d="M12 9v5M12 17h.01" /></svg>;
    case "info":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></svg>;
    case "activity":
      return <svg {...common}><path d="M3 12h4l2-6 4 12 2-6h6" /></svg>;
    case "drop":
      return <svg {...common}><path d="M12 3s6 6.2 6 11a6 6 0 0 1-12 0c0-4.8 6-11 6-11Z" /></svg>;
    case "gear":
      return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19 14.5 21 16l-2 3.5-2.4-1a8 8 0 0 1-2.6 1.5L13.7 23h-4l-.3-3a8 8 0 0 1-2.6-1.5l-2.4 1L2.5 16l2-1.5a8 8 0 0 1 0-3L2.5 10l2-3.5 2.4 1A8 8 0 0 1 9.4 6l.3-3h4l.3 3a8 8 0 0 1 2.6 1.5l2.4-1 2 3.5-2 1.5a8 8 0 0 1 0 3Z" /></svg>;
  }
}

function isMixedDataWarning(warning: string): boolean {
  return /^(?:Mixed device data detected|Multiple device layouts detected)\./.test(warning);
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

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export function QuickReportApp() {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const headerInputRef = useRef<HTMLInputElement>(null);
  const workerClientRef = useRef<ReportWorkerClient | null>(null);
  const sourceSelectionAttemptRef = useRef(0);
  const parseProgressRafRef = useRef<number | null>(null);
  const queuedParseProgressRef = useRef<ParseProgress | null>(null);
  const generatedReportsRef = useRef<GeneratedReports>({});
  const previewWindowsRef = useRef<Window[]>([]);

  const [patientName, setPatientName] = useState("");
  const [dateOfBirthInput, setDateOfBirthInput] = useState("");
  const [physicianName, setPhysicianName] = useState("");
  const [sourceFileCount, setSourceFileCount] = useState(0);
  const [loadedSourceLoader, setLoadedSourceLoader] = useState<string | null>(null);
  const [loadedSourceLatestClinicalDayIso, setLoadedSourceLatestClinicalDayIso] = useState<string | null>(null);
  const [loadedSourceWarnings, setLoadedSourceWarnings] = useState<string[]>([]);
  const [olderHistoryLoaded, setOlderHistoryLoaded] = useState(false);
  const [therapySettingsPeriods, setTherapySettingsPeriods] = useState<TherapySettingsPeriod[]>([]);
  const [previousTherapyReview, setPreviousTherapyReview] = useState<QuickReportMetrics | null>(null);
  const [showPreviousTherapyReview, setShowPreviousTherapyReview] = useState(false);
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
  const [pendingSourceSelection, setPendingSourceSelection] = useState<"folder" | null>(null);

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
      const activeClient = workerClientRef.current;
      workerClientRef.current = null;
      if (activeClient && activeClient !== client) activeClient.dispose();
      client.dispose();
    };
  }, []);

  useEffect(() => {
    const handleUnload = () => {
      sourceSelectionAttemptRef.current += 1;
      if (parseProgressRafRef.current !== null) {
        window.cancelAnimationFrame(parseProgressRafRef.current);
        parseProgressRafRef.current = null;
      }
      queuedParseProgressRef.current = null;

      const client = workerClientRef.current;
      workerClientRef.current = null;
      client?.dispose();

      revokeGeneratedReportUrls(generatedReportsRef.current);
      generatedReportsRef.current = {};
      closeOpenedPreviewWindows(previewWindowsRef.current);
      if (folderInputRef.current) folderInputRef.current.value = "";
      if (headerInputRef.current) headerInputRef.current.value = "";
      clearUnloadSafeSiteData();
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        window.location.reload();
      }
    };

    window.addEventListener("pagehide", handleUnload);
    window.addEventListener("beforeunload", handleUnload);
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      window.removeEventListener("pagehide", handleUnload);
      window.removeEventListener("beforeunload", handleUnload);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, []);

  useEffect(() => {
    generatedReportsRef.current = generatedReports;
    return () => {
      revokeGeneratedReportUrls(generatedReports);
    };
  }, [generatedReports]);

  const loadedSourceLatestClinicalDayLabel = useMemo(
    () => (loadedSourceLatestClinicalDayIso ? formatIsoDateLong(loadedSourceLatestClinicalDayIso) : null),
    [loadedSourceLatestClinicalDayIso]
  );
  const loadedMixedDataWarning = useMemo(
    () => loadedSourceWarnings.find(isMixedDataWarning) ?? null,
    [loadedSourceWarnings]
  );
  const generatedReportDays = useMemo(
    () => REPORT_RANGE_OPTIONS.filter((days) => Boolean(generatedReports[days])),
    [generatedReports]
  );
  const resolvedActiveReportDays = generatedReports[activeReportDays] ? activeReportDays : (generatedReportDays[0] ?? null);
  const activeReport = resolvedActiveReportDays ? generatedReports[resolvedActiveReportDays] ?? null : null;
  const activeMetrics = activeReport?.metrics ?? null;
  const hasGeneratedReports = generatedReportDays.length > 0;
  const currentTherapyPeriod = useMemo(
    () => therapySettingsPeriods.find((period) => period.kind === "current") ?? null,
    [therapySettingsPeriods]
  );
  const previousTherapyPeriod = useMemo(
    () => therapySettingsPeriods.find((period) => period.kind === "previous" && period.machine) ?? null,
    [therapySettingsPeriods]
  );
  const hasLoadedPreviousTherapy = olderHistoryLoaded && previousTherapyPeriod !== null;
  const dashboardMetrics = showPreviousTherapyReview ? previousTherapyReview : activeMetrics;
  const dashboardPeriod = showPreviousTherapyReview ? previousTherapyPeriod : currentTherapyPeriod;
  const dashboardSourceLatestDayLabel = showPreviousTherapyReview
    ? previousTherapyPeriod
      ? formatIsoDateLong(previousTherapyPeriod.endClinicalDayIso)
      : null
    : loadedSourceLatestClinicalDayLabel;
  const dashboardLatestClinicalDayIso =
    dashboardPeriod?.endClinicalDayIso ?? (!showPreviousTherapyReview ? loadedSourceLatestClinicalDayIso : null);
  const dashboardDataAge = dashboardLatestClinicalDayIso ? daysSinceIsoDate(dashboardLatestClinicalDayIso) : null;
  const dashboardStaleSeverity = staleDataSeverity(dashboardDataAge);
  const dashboardStaleAgeClassName = staleDataAgeClassName(dashboardStaleSeverity);
  const dashboardStaleAgeText =
    dashboardStaleSeverity && dashboardDataAge !== null
      ? `Warning: this data is ${dashboardDataAge} day${dashboardDataAge === 1 ? "" : "s"} old.`
      : null;

  const dateOfBirthIso = useMemo(() => normalizeDobInput(dateOfBirthInput), [dateOfBirthInput]);
  const isPatientNameMissing = patientName.trim().length <= 1;
  const isDobMissing = !dateOfBirthIso;
  const canGenerate =
    !isPatientNameMissing &&
    !isDobMissing &&
    sourceFileCount > 0 &&
    status !== "working";
  const isDataSourceLoading = status === "working" || isSourceLoading || pendingSourceSelection !== null;
  const isSetupLocked = status === "working" && !isSourceLoading;

  const beginSourceSelection = () => {
    const activeInput = folderInputRef.current;
    if (activeInput) {
      // Clearing value allows selecting the same folder/file again to trigger onChange.
      activeInput.value = "";
    }

    const openingMessage = "Opening SD-CARD folder...";
    const previousStatusMessage = statusMessage;
    const clearPendingSelection = () => {
      setPendingSourceSelection(null);
      setIsSourceLoading(false);
      setStatusMessage((current) => (current === openingMessage ? previousStatusMessage : current));
    };

    flushSync(() => {
      setPendingSourceSelection("folder");
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
        const input = folderInputRef.current;
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

  const clearLoadedSourceState = (clearPatientDetails = false) => {
    revokeGeneratedReportUrls(generatedReports);
    generatedReportsRef.current = {};
    closeOpenedPreviewWindows(previewWindowsRef.current);
    setGeneratedReports({});
    setActiveReportDays(90);
    setIsPreviewCollapsed(false);
    setSourceFileCount(0);
    setLoadedSourceLoader(null);
    setLoadedSourceLatestClinicalDayIso(null);
    setLoadedSourceWarnings([]);
    setOlderHistoryLoaded(false);
    setTherapySettingsPeriods([]);
    setPreviousTherapyReview(null);
    setShowPreviousTherapyReview(false);
    if (clearPatientDetails) {
      setPatientName("");
      setDateOfBirthInput("");
    }
  };

  const prepareForSourceImport = () => {
    const isReplacingLoadedSource = shouldClearPatientDetailsForSourceImport({
      sourceFileCount,
      loadedSourceLoader,
      hasGeneratedReports
    });
    clearLoadedSourceState(isReplacingLoadedSource);
    setErrors([]);
  };

  const resetResultState = () => {
    clearLoadedSourceState();
    setErrors([]);
    setStatus("idle");
    setStatusMessage("Awaiting data source.");
    setParseProgressImmediate({ phase: "idle", detail: "Idle", percent: 0 });
    setIsSourceLoading(false);
    setPendingSourceSelection(null);
  };

  const replaceWorkerClient = () => {
    const previousClient = workerClientRef.current;
    workerClientRef.current = null;
    previousClient?.dispose();
    workerClientRef.current = new ReportWorkerClient();
  };

  const handleResetClearAll = async () => {
    if (status === "working") return;
    sourceSelectionAttemptRef.current += 1;

    let workerReplacementError: unknown = null;
    try {
      replaceWorkerClient();
    } catch (error) {
      workerReplacementError = error;
    }

    flushSync(() => {
      resetResultState();
      setSourceFileCount(0);
      setPatientName("");
      setDateOfBirthInput("");
      setStatus("working");
      setStatusMessage("Clearing local data...");
      setParseProgressImmediate({ phase: "reset", detail: "Clearing local cache and storage...", percent: 12 });
    });
    clearSourceInputs();

    let resetError = workerReplacementError;
    try {
      await clearSiteData();
    } catch (error) {
      resetError ??= error;
    }

    if (resetError) {
      const message = resetError instanceof Error ? resetError.message : "Could not clear local data.";
      setStatus("error");
      setErrors([message]);
      setStatusMessage("Reset / Clear All failed.");
      setParseProgressImmediate({ phase: "error", detail: "Reset failed", percent: 0 });
    } else {
      setParseProgressImmediate({ phase: "idle", detail: "Idle", percent: 0 });
      setStatus("idle");
      setStatusMessage("Local data cleared.");
    }
    setIsSourceLoading(false);
  };

  const handleCancelSourceImport = () => {
    if (!isSourceLoading || status !== "working") return;

    sourceSelectionAttemptRef.current += 1;
    try {
      replaceWorkerClient();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not cancel the SD-CARD import.";
      setStatus("error");
      setErrors([message]);
      setStatusMessage("SD-CARD import cancellation failed.");
      setParseProgressImmediate({ phase: "error", detail: "Cancellation failed", percent: 0 });
      setIsSourceLoading(false);
      return;
    }
    clearSourceInputs();
    setPendingSourceSelection(null);
    setIsSourceLoading(false);
    setStatus("idle");
    setErrors([]);
    setStatusMessage("SD-CARD import canceled.");
    setParseProgressImmediate({ phase: "idle", detail: "Import canceled", percent: 0 });
  };

  const handleFolderSelection: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
    const attemptId = sourceSelectionAttemptRef.current + 1;
    sourceSelectionAttemptRef.current = attemptId;
    setPendingSourceSelection(null);
    const files = event.target.files;
    if (!files || files.length === 0) {
      setIsSourceLoading(false);
      return;
    }

    prepareForSourceImport();
    setIsSourceLoading(true);
    setStatus("working");
    setStatusMessage("Loading SD folder...");
    setParseProgressImmediate({ phase: "scan", detail: "Loading SD folder...", percent: 4 });
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    try {
      const client = workerClientRef.current;
      if (!client) throw new Error("Background worker is not available.");
      const loaded = await client.loadFolder(files, {
        importLookbackDays: OLDER_HISTORY_IMPORT_LOOKBACK_DAYS,
        parseLookbackDays: OLDER_HISTORY_IMPORT_LOOKBACK_DAYS,
        onProgress: (progress) => queueParseProgress(progress)
      });
      if (sourceSelectionAttemptRef.current !== attemptId) return;

      setSourceFileCount(loaded.totalFileCount);
      setLoadedSourceLoader(loaded.selectedLoader);
      setLoadedSourceLatestClinicalDayIso(loaded.latestClinicalDayIso);
      setLoadedSourceWarnings(loaded.warnings);
      setOlderHistoryLoaded(false);
      setTherapySettingsPeriods(loaded.therapySettingsPeriods);
      setPreviousTherapyReview(null);
      setShowPreviousTherapyReview(false);
      setErrors([]);
      setStatus("idle");
      setStatusMessage(loaded.statusMessage);
    } catch (error) {
      if (sourceSelectionAttemptRef.current !== attemptId || isAbortError(error)) return;
      const message = error instanceof Error ? error.message : "Could not load selected folder.";
      setStatus("error");
      setErrors([message]);
      setStatusMessage("Folder load failed.");
      setParseProgressImmediate({ phase: "error", detail: "Folder load failed", percent: 0 });
    } finally {
      if (sourceSelectionAttemptRef.current === attemptId) setIsSourceLoading(false);
    }
  };

  const handleDirectoryPickerSelection = async () => {
    const attemptId = sourceSelectionAttemptRef.current + 1;
    sourceSelectionAttemptRef.current = attemptId;
    setPendingSourceSelection("folder");

    try {
      const rootHandle = await pickDirectoryHandle(() => {
        prepareForSourceImport();
        setIsSourceLoading(true);
        setStatus("working");
        setStatusMessage("Loading SD-CARD...");
        setParseProgressImmediate({ phase: "scan", detail: "Loading SD-CARD...", percent: 1 });
      });
      if (sourceSelectionAttemptRef.current !== attemptId) return;

      const client = workerClientRef.current;
      if (!client) throw new Error("Background worker is not available.");

      let loaded;
      try {
        loaded = await client.loadFolderHandle(rootHandle, {
          importLookbackDays: OLDER_HISTORY_IMPORT_LOOKBACK_DAYS,
          parseLookbackDays: OLDER_HISTORY_IMPORT_LOOKBACK_DAYS,
          onProgress: (progress) => queueParseProgress(progress)
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Directory handle transfer to worker failed.";
        if (!/directory handle transfer/i.test(message)) {
          throw error;
        }
        const enumeration = await enumerateDeferredFolderEntries(rootHandle, OLDER_HISTORY_IMPORT_LOOKBACK_DAYS, (progress) =>
          queueParseProgress(progress)
        );
        if (sourceSelectionAttemptRef.current !== attemptId) return;

        if (enumeration.entries.length === 0) {
          setPendingSourceSelection(null);
          setIsSourceLoading(false);
          setStatus("idle");
          setStatusMessage("Directory picker returned no files. Falling back to browser folder selection...");
          setParseProgressImmediate({ phase: "idle", detail: "Idle", percent: 0 });
          beginSourceSelection();
          folderInputRef.current?.click();
          return;
        }

        loaded = await client.loadFolderEntries(enumeration.entries, {
          importLookbackDays: OLDER_HISTORY_IMPORT_LOOKBACK_DAYS,
          parseLookbackDays: OLDER_HISTORY_IMPORT_LOOKBACK_DAYS,
          hasOlderDatedData: enumeration.hasOlderDatedData,
          onProgress: (progress) => queueParseProgress(progress)
        });
      }
      if (sourceSelectionAttemptRef.current !== attemptId) return;

      setSourceFileCount(loaded.totalFileCount);
      setLoadedSourceLoader(loaded.selectedLoader);
      setLoadedSourceLatestClinicalDayIso(loaded.latestClinicalDayIso);
      setLoadedSourceWarnings(loaded.warnings);
      setOlderHistoryLoaded(false);
      setTherapySettingsPeriods(loaded.therapySettingsPeriods);
      setPreviousTherapyReview(null);
      setShowPreviousTherapyReview(false);
      setErrors([]);
      setStatus("idle");
      setStatusMessage(loaded.statusMessage);
    } catch (error) {
      if (sourceSelectionAttemptRef.current !== attemptId || isPickerAbort(error) || isAbortError(error)) return;

      const message = error instanceof Error ? error.message : "Could not load selected folder.";
      setStatus("error");
      setErrors([message]);
      setStatusMessage("Folder load failed.");
      setParseProgressImmediate({ phase: "error", detail: "Folder load failed", percent: 0 });
    } finally {
      if (sourceSelectionAttemptRef.current === attemptId) {
        setPendingSourceSelection(null);
        setIsSourceLoading(false);
      }
    }
  };

  const handleFolderButtonClick = async () => {
    if (supportsDirectoryPicker()) {
      await handleDirectoryPickerSelection();
      return;
    }

    beginSourceSelection();
    folderInputRef.current?.click();
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

  const handleLoadOlderHistory = () => {
    if (isSourceLoading || olderHistoryLoaded || !previousTherapyPeriod) return;

    setOlderHistoryLoaded(true);
    setPreviousTherapyReview(null);
    setShowPreviousTherapyReview(false);
    setStatus(hasGeneratedReports ? "ready" : "idle");
    setStatusMessage("Older therapy data with different settings is ready for review.");
    setParseProgressImmediate({ phase: "ready", detail: "Older therapy history ready", percent: 100 });
  };

  const handleReviewPreviousTherapy = async () => {
    if (!previousTherapyPeriod?.machine || isSourceLoading || status === "working") return;

    setShowPreviousTherapyReview(true);
    setStatus("working");
    setErrors([]);
    setStatusMessage("Preparing previous therapy period review...");
    setParseProgressImmediate({ phase: "compute", detail: "Preparing previous therapy review...", percent: 2 });
    try {
      const client = workerClientRef.current;
      if (!client) throw new Error("Background worker is not available.");
      const metrics = await client.reviewPreviousTherapy(
        {
          patientName,
          dateOfBirthIso: dateOfBirthIso ?? "",
          physicianName
        },
        (progress) => queueParseProgress(progress)
      );
      setPreviousTherapyReview(metrics);
      setShowPreviousTherapyReview(true);
      setStatus(hasGeneratedReports ? "ready" : "idle");
      setStatusMessage("Previous therapy period ready for review. Export is unavailable.");
      setParseProgressImmediate({ phase: "done", detail: "Previous therapy review ready", percent: 100 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not prepare previous therapy review.";
      setStatus("error");
      setErrors([message]);
      setStatusMessage("Previous therapy review failed.");
      setParseProgressImmediate({ phase: "error", detail: "Previous therapy review failed", percent: 0 });
    }
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
          blob: artifact.blob,
          previewUrl: URL.createObjectURL(artifact.blob),
          downloadName: artifact.filename
        };
      }

      revokeGeneratedReportUrls(generatedReports);
      closeOpenedPreviewWindows(previewWindowsRef.current);
      generatedReportsRef.current = generated;
      setGeneratedReports(generated);
      const largestAvailableTab = REPORT_RANGE_OPTIONS.find((days) => Boolean(generated[days])) ?? 7;
      setActiveReportDays(largestAvailableTab);
      setIsPreviewCollapsed(false);
      setShowPreviousTherapyReview(false);
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

  const handleSavePdf = async () => {
    if (!activeReport?.previewUrl) return;

    try {
      const result = await savePdfArtifact(
        activeReport.blob,
        activeReport.downloadName,
        activeReport.previewUrl
      );
      if (result === "saved") {
        setStatusMessage("PDF saved to the selected folder.");
      } else if (result === "downloaded") {
        setStatusMessage("PDF sent to browser downloads. If prompted, choose Save or Save as—not Open.");
      } else {
        setStatusMessage("PDF save cancelled.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save the PDF.";
      setErrors((previous) => [message, ...previous]);
      setStatusMessage("Could not save the PDF.");
    }
  };

  const openPreviewInNewTab = () => {
    if (!activeReport?.previewUrl) return;
    const previewWindow = window.open(activeReport.previewUrl, "_blank");
    if (!previewWindow) return;
    try {
      previewWindow.opener = null;
    } catch {
      // The parent still retains the window reference needed for privacy cleanup.
    }
    previewWindowsRef.current = previewWindowsRef.current.filter((candidate) => !candidate.closed);
    previewWindowsRef.current.push(previewWindow);
  };

  return (
    <>
      <header className="app-bar">
        <strong>CPAP Clinician QuickReport</strong>
      </header>
      <main>
        <section className="dashboard-stack">
          <article className="card therapy-history-card">
            <div className="therapy-history-heading">
              <span className="section-heading-icon"><UiIcon name="report" size={27} /></span>
              <div>
                <h2>Data Review</h2>
              </div>
            </div>

        <section id="setup-panel" className={`dashboard-setup ${isSetupLocked ? "card-loading" : ""}`} aria-busy={isSetupLocked}>
          {isSetupLocked ? <div className="loading-overlay">{statusMessage}</div> : null}
          <div className="setup-heading">
            <div><strong>Patient &amp; Device Details</strong><span>Complete these fields to generate the therapy report.</span></div>
          </div>
          <div className="setup-fields">
            <label htmlFor="patientName"><span>Patient name {isPatientNameMissing ? "*" : ""}</span><input id="patientName" className="input" value={patientName} onChange={(e) => setPatientName(e.target.value)} placeholder="First Last" autoComplete="off" disabled={isSetupLocked} /></label>
            <label htmlFor="dob"><span>Date of birth {isDobMissing ? "*" : ""}</span><input id="dob" className="date-input" type="text" inputMode="numeric" placeholder="MM/DD/YYYY" value={dateOfBirthInput} onChange={(e) => setDateOfBirthInput(formatDobTyping(e.target.value))} autoComplete="off" disabled={isSetupLocked} /></label>
          </div>
          <div className="setup-actions">
            <button
              type="button"
              className="btn btn-outline-current"
              onClick={() => {
                void handleFolderButtonClick();
              }}
              disabled={isDataSourceLoading}
            >
              <UiIcon name="database" size={20} /> Select SD-CARD
            </button>
            {isSourceLoading && status === "working" ? (
              <button type="button" className="btn btn-secondary" onClick={handleCancelSourceImport}>Cancel Import</button>
            ) : null}
            <button type="button" className="btn btn-danger" onClick={handleResetClearAll} disabled={status === "working"}>Reset / Clear All</button>
          </div>
          <input ref={folderInputRef} type="file" multiple onChange={handleFolderSelection} style={{ display: "none" }} />
          <details className="setup-more">
            <summary>Branding</summary>
            <div className="setup-more-grid">
              <label htmlFor="physician"><span>Physician name</span><input id="physician" className="input" value={physicianName} onChange={(e) => setPhysicianName(e.target.value)} autoComplete="off" disabled={isSetupLocked} /></label>
              <label htmlFor="header-upload"><span>Optional PDF header image</span><input id="header-upload" ref={headerInputRef} type="file" accept="image/png,image/jpeg" onChange={handleHeaderUpload} disabled={isSetupLocked} /></label>
            </div>
            {headerDataUrl ? <button type="button" className="link-button subtle-link-button" onClick={clearBrandingImage} disabled={isSetupLocked}>Clear branding image</button> : null}
          </details>
          <div className="progress-wrap" role="status" aria-live="polite">
            <div className="progress-track">
              <div className="progress-value" style={{ width: `${parseProgress.percent}%` }} />
            </div>
            <div className="phase">{statusMessage} · {parseProgress.percent}% - {parseProgress.detail}</div>
          </div>
          {errors.length > 0 ? <p className="setup-error">{errors[0]}</p> : null}
        </section>

            {previousTherapyPeriod ? (
            <div className="therapy-period-list">
              {!olderHistoryLoaded ? (
                <div className="older-history-banner">
                  <span className="banner-icon"><UiIcon name="info" size={22} /></span>
                  <div>
                    <strong>Older therapy data with different settings is available.</strong>
                    <span>This data uses therapy settings older than the current settings. Loads only the immediately previous settings period, up to 90 days.</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleLoadOlderHistory}
                    disabled={isSourceLoading}
                  >
                    <UiIcon name="download" size={21} /> Load Older History
                  </button>
                </div>
              ) : null}

              {hasLoadedPreviousTherapy && previousTherapyPeriod ? (
              <section className="therapy-period therapy-period-previous">
                <div className="therapy-period-identity">
                  <span className="therapy-period-badge"><UiIcon name="history" size={17} /> Previous Therapy</span>
                  <span className="therapy-device-icon"><UiIcon name="device" size={45} /><i><UiIcon name="history" size={15} /></i></span>
                </div>
                    <div className="therapy-period-details">
                      <h4>{previousTherapyPeriod.label}</h4>
                      <p><UiIcon name="calendar" size={20} /> {formatIsoDateLong(previousTherapyPeriod.startClinicalDayIso)} – {formatIsoDateLong(previousTherapyPeriod.endClinicalDayIso)}</p>
                      <p><UiIcon name="database" size={20} /> {previousTherapyPeriod.daysWithData} days with data available</p>
                    </div>
                    <div className="therapy-period-actions previous-period-actions">
                      <button
                        type="button"
                        className="btn btn-outline-previous"
                        onClick={() => {
                          void handleReviewPreviousTherapy();
                        }}
                        disabled={isDataSourceLoading}
                      >
                        <UiIcon name="eye" size={21} />
                        Review Previous Period
                      </button>
                      <p className="review-only-notice"><UiIcon name="warning" size={20} /><span>Historical therapy period for review only.<br />Export is unavailable.</span></p>
                    </div>
              </section>
              ) : null}
            </div>
            ) : null}
          </article>

          <article className="card previous-review-card">
            <div className="review-tabs">
              <button type="button" className={!showPreviousTherapyReview ? "review-tab-active" : ""} onClick={() => setShowPreviousTherapyReview(false)}><UiIcon name="report" size={20} /> Therapy Overview</button>
              {hasLoadedPreviousTherapy ? (
              <button
                type="button"
                className={showPreviousTherapyReview ? "review-tab-active" : ""}
                onClick={() => {
                  if (previousTherapyReview) setShowPreviousTherapyReview(true);
                  else void handleReviewPreviousTherapy();
                }}
              ><UiIcon name="history" size={20} /> Previous Data Overview</button>
              ) : null}
            </div>
            <div className="therapy-overview-toolbar">
              <div className="therapy-overview-source">
                <UiIcon name="device" size={27} />
                <span>
                  <small>Device/card</small>
                  <strong>{loadedSourceLoader ?? "No device/card selected"}</strong>
                  <em>{dashboardSourceLatestDayLabel ? `Last data: ${dashboardSourceLatestDayLabel}` : "Select an SD-card to load therapy data"}</em>
                </span>
              </div>
              {!showPreviousTherapyReview && loadedSourceLoader ? (
                  <button
                    type="button"
                    className={`btn btn-primary therapy-overview-generate ${canGenerate && !hasGeneratedReports ? "therapy-overview-generate-ready" : ""}`}
                    onClick={handleGenerate}
                    disabled={!canGenerate}
                  >
                    <UiIcon name="report" size={20} /> Analyze Data and Generate Report
                  </button>
              ) : null}
            </div>
            <div className="previous-review-metrics">
              <div className="review-metric review-metric-usage">
                <span className="review-metric-icon"><UiIcon name="clock" size={33} /></span>
                <span>
                  <small>Total Time</small>
                  <strong>{formatMetric(dashboardMetrics?.totalTherapyHours, " hrs")}</strong>
                  <em>{dashboardMetrics ? `${dashboardMetrics.daysInWindow}-day report range` : "selected report range"}</em>
                  {dashboardMetrics?.sleepTimingAnalysis ? (
                    <span className="review-metric-breakdown">
                      <em>Total sleep / therapy time: {formatTherapyShare(dashboardMetrics.expectedSleepTherapyHours, dashboardMetrics.totalTherapyHours)}</em>
                      <em>Total nap time: {formatTherapyShare(dashboardMetrics.suspectedNapTherapyHours, dashboardMetrics.totalTherapyHours)}</em>
                      {(dashboardMetrics.unclassifiedTherapyHours ?? 0) >= 0.05 ? (
                        <em>Unclassified timing: {formatMetric(dashboardMetrics.unclassifiedTherapyHours, " hrs")}</em>
                      ) : null}
                    </span>
                  ) : (
                    <em>Session timing split unavailable</em>
                  )}
                </span>
              </div>
              <div className="review-metric review-metric-compliance">
                <span className="review-metric-icon"><UiIcon name="check" size={33} /></span>
                <span>
                  <small>Compliance</small>
                  <strong>{formatMetric(dashboardMetrics?.compliancePercent, "%")}</strong>
                  <em>{dashboardMetrics?.sleepTimingAnalysis ? "principal sleep episode ≥ 4 hrs" : "daily total ≥ 4 hrs (fallback)"}</em>
                  {dashboardMetrics?.sleepTimingAnalysis ? (
                    <em>
                      Window: {formatClockMinutes(dashboardMetrics.sleepTimingAnalysis.sleepWindowStartMinutes)}–{formatClockMinutes(dashboardMetrics.sleepTimingAnalysis.sleepWindowEndMinutes)} ·{" "}
                      <span className={`sleep-confidence sleep-confidence-${dashboardMetrics.sleepTimingAnalysis.confidence}`}>
                        {dashboardMetrics.sleepTimingAnalysis.confidence} confidence
                      </span>
                    </em>
                  ) : null}
                </span>
              </div>
              <div className="review-metric review-metric-ahi">
                <span className="review-metric-icon"><UiIcon name="activity" size={33} /></span>
                <span><small>AHI</small><strong>{formatMetric(dashboardMetrics?.avgAhi)}</strong><em>events/hr</em></span>
              </div>
              <div className="review-metric review-metric-leak">
                <span className="review-metric-icon"><UiIcon name="drop" size={33} /></span>
                <span><small>Leak</small><strong>{formatMetric(dashboardMetrics?.avgLeak, " L/min")}</strong><em>reported average</em></span>
              </div>
            </div>
            <div className={`review-detail-row ${showPreviousTherapyReview ? "" : "review-detail-row-overview"}`}>
              <div className="review-date-range">
                <UiIcon name="calendar" size={27} />
                <span>
                  <small>Date Range</small>
                  <strong>{dashboardMetrics ? `${dashboardMetrics.dateRangeStart} – ${dashboardMetrics.dateRangeEnd}` : "No report selected"}</strong>
                  <em>{dashboardMetrics ? `${dashboardMetrics.daysWithData} days with data available` : "Generate or review a report"}</em>
                  {dashboardStaleAgeText ? (
                    <em className={`date-range-age-warning ${dashboardStaleAgeClassName ?? ""}`}>
                      <UiIcon name="warning" size={16} /> {dashboardStaleAgeText}
                    </em>
                  ) : null}
                </span>
              </div>
              <div><UiIcon name="gear" size={27} /><span><small>Therapy Settings</small><strong>{dashboardPeriod?.label ?? "Not available"}</strong><em>{dashboardMetrics?.machine.pressure ? `Fixed pressure ${dashboardMetrics.machine.pressure}` : "Therapy settings summary"}</em></span></div>
              {showPreviousTherapyReview ? (
                <p className="review-only-notice">
                  <UiIcon name="info" size={20} />
                  <span>
                    <strong>Review only.</strong>
                    <br />Historical therapy period for review only.<br />Export is unavailable.
                  </span>
                </p>
              ) : null}
            </div>
          </article>

        {hasGeneratedReports && activeReport ? (
          <article className="card preview-shell">
            <div>
              <span className="therapy-period-badge">Therapy Overview Reports</span>
              <p className="subtle">Saved PDFs are permanent. Browser previews are temporary and available only for the current therapy settings period.</p>
            </div>
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
              <button type="button" className="btn btn-primary" onClick={handleSavePdf}>
                Save PDF
              </button>
              <button type="button" className="btn btn-secondary" onClick={openPreviewInNewTab}>
                Open Temporary Preview
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
            <p className="subtle">Choose Save or Save as if your browser asks. Choosing Open uses temporary browser storage.</p>
            {!isPreviewCollapsed ? (
              <>
                <iframe
                  key={activeReport.previewUrl}
                  className="preview-frame"
                  src={activeReport.previewUrl}
                  title="PDF preview"
                />
                <p className="subtle">If this preview is blank, use Open Temporary Preview. Preview tabs are cleared when this app session ends.</p>
              </>
            ) : (
              <p className="subtle">Preview collapsed. Use Open Preview to expand.</p>
            )}
          </article>
        ) : null}

        <article className="card affiliate-card">
          <details className="affiliate-disclosure">
            <summary>
              <span className="affiliate-summary-icon"><UiIcon name="sd-card" size={25} /></span>
              <span className="affiliate-summary-copy">
                <span className="affiliate-summary-title">SD Card Readers</span>
                <span className="affiliate-summary-description">Compatible options for importing therapy data</span>
              </span>
              <span className="affiliate-summary-action">View 3 options</span>
            </summary>
            <div className="card-reader-list">
              {CARD_READER_PRODUCTS.map((product, index) => (
                <a
                  key={product.href}
                  className="card-reader-item"
                  href={product.href}
                  target="_blank"
                  rel="noopener noreferrer sponsored"
                  aria-label={`Buy ${product.title} on Amazon`}
                >
                  <span className="card-reader-number">{String(index + 1).padStart(2, "0")}</span>
                  <span className="card-reader-media" aria-hidden="true">
                    <img
                      className="card-reader-image"
                      src={product.imageSrc}
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                  </span>
                  <span className="card-reader-copy">
                    <span className="card-reader-label">Recommended accessory</span>
                    <strong>{product.title}</strong>
                    <span className="card-reader-description">{product.description}</span>
                    <span className="card-reader-cta"><UiIcon name="eye" size={17} /> View on Amazon</span>
                  </span>
                </a>
              ))}
            </div>
            <p className="affiliate-note">
              Affiliate disclosure: purchases do not change your price. A small portion supports this local-first reporting tool.
            </p>
          </details>
        </article>

        <article className="card legal-notice">
          <details className="legal-disclosure">
            <summary>{"\u00A0\u00A0GNU/OSCAR Copyright and Distribution Notice"}</summary>
            <ul className="notes">
              <li>
                This app contains parser behavior derived from OSCAR (Open Source CPAP Analysis Reporter), which is GPLv3-licensed software.
              </li>
              <li>
                Attribution from OSCAR repository materials: SleepyHead copyright (C) 2011-2018 Mark Watkins; portions of OSCAR copyright (C) 2019-2026 The OSCAR Team.
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
                <a href="https://gitlab.com/CrimsonNape/OSCAR-SQL" target="_blank" rel="noopener noreferrer">
                  OSCAR-SQL source
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
    </>
  );
}
