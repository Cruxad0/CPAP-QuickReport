import JSZip from "jszip";

import { rankParserFamilies } from "@/lib/parsers/families";
import type { ParseProgress, SourceFile, SourceFileSummary } from "@/lib/types";

const DAY_MS = 24 * 60 * 60 * 1000;

export const IMPORT_LOOKBACK_DAYS = 91;

export type RecentWindowFilterResult = {
  files: SourceFile[];
  originalCount: number;
  filteredOutCount: number;
  filteredOutBytes: number;
  latestDateIso: string | null;
  hadDatedFiles: boolean;
};

export type FolderSourceEntry = {
  file: File;
  relativePath: string;
};

export type FolderSourceMetaEntry = {
  index: number;
  name: string;
  size: number;
  relativePath: string;
};

export type RecentFolderEntryFilterResult = {
  entries: FolderSourceEntry[];
  originalCount: number;
  filteredOutCount: number;
  filteredOutBytes: number;
  latestDateIso: string | null;
  hadDatedFiles: boolean;
};

type ProgressCallback = (progress: ParseProgress) => void;

function emit(onProgress: ProgressCallback | undefined, progress: ParseProgress) {
  if (onProgress) onProgress(progress);
}

export function bytesToLabel(size: number): string {
  if (size > 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  if (size > 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
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
  const normalized = normalizePath(path);

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

function detectLikelyFamilyId(files: Array<{ path: string }>): string | null {
  const ranking = rankParserFamilies(files.map((file) => ({ normalizedPath: normalizePath(file.path) })));
  return ranking[0]?.id ?? null;
}

function shouldKeepUndatedFile(path: string, size: number, likelyFamilyId: string | null): boolean {
  const normalized = normalizePath(path).toLowerCase();

  if (likelyFamilyId) {
    switch (likelyFamilyId) {
      case "resvent":
        if (/(?:^|\/)therapy\/(?:config|record)\//i.test(normalized)) return true;
        break;
      case "resmed":
        if (/(?:^|\/)datalog\/.*\/(?:str|eve|pld|sad|brp|crc)\.edf$/i.test(normalized)) return true;
        break;
      case "prs1":
        if (/(?:^|\/)(?:p-series\/|p\d{5}\.\d{3}$|summary\.(?:txt|csv|xml)$|compliance\.(?:txt|csv|xml)$)/i.test(normalized)) {
          return true;
        }
        break;
      case "prisma":
        if (/(?:^|\/)(?:config\.pscfg|config\.pcfg|therapy\.pdat)$/i.test(normalized)) return true;
        break;
      case "bmc":
        if (/(?:^|\/)[^/]+\.(?:usr|idx|000)$/i.test(normalized)) return true;
        break;
      case "intellipap":
        if (/(?:^|\/)(?:sl\/(?:set1|u|l)|dv6\/(?:set\.bin|ver\.bin|s\.bin))$/i.test(normalized)) return true;
        break;
      case "sleepstyle":
      case "icon":
        if (/(?:^|\/)fphcare\/icon\/[^/]+\/(?:sum|det|his|flw).*\.(?:fph|FPH)$/i.test(normalized)) return true;
        if (/(?:^|\/)fphcare\/icon\/[^/]+\/realtime\/hrd.*\.edf$/i.test(normalized)) return true;
        break;
      case "weinmann":
        if (/(?:^|\/)wm_data\.tdf$/i.test(normalized)) return true;
        break;
      case "mseries":
        if (/(?:^|\/)(?:m-series\/|therapy\.dat$)/i.test(normalized)) return true;
        break;
      case "vrem":
        if (/(?:^|\/)(?:vrem[^/]*\/)?(?:pi\.txt|di\.txt)$/i.test(normalized)) return true;
        if (/(?:^|\/)(?:vrem[^/]*\/)?od[^/]+\//i.test(normalized)) return true;
        break;
      default:
        break;
    }
  }

  if (
    /(?:^|\/)(?:therapy\/config|config|settings?|profile|profiles|wm_profiles\.xml|summary\.edf|detail\.edf|str\.edf|eve\.edf|pld\.edf|sad\.edf|brp\.edf|crc\.edf)(?:\/|$|[._-])/i.test(
      normalized
    )
  ) {
    return true;
  }

  if (
    /(?:^|\/)(?:p-series\/|p\d{5}\.\d{3}$|p\d{4}\.(?:idx|000)$|therapy\.pdat$|therapy\.dat$|sl\/set1$|sl\/u$|sl\/l$|dv6\/set\.bin$|dv6\/ver\.bin$|dv6\/s\.bin$|wm_data\.tdf$)/i.test(
      normalized
    )
  ) {
    return true;
  }

  if (/(?:^|\/)(?:viatom|cms50|zeo|dreem|yuwell|vrem)(?:\/|$)/i.test(normalized)) {
    return true;
  }

  if (
    size <= 2_000_000 &&
    /\.(?:csv|txt|json|xml|dat|edf|usr|idx|000|bin|pscfg|pcfg|pdat)$/i.test(normalized) &&
    /(?:therapy|record|usage|session|event|summary|detail|compliance|result|config|setting|profile|datalog)/i.test(normalized)
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

export function filterSourceFilesToRecentWindow(files: SourceFile[], lookbackDays: number): RecentWindowFilterResult {
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

  const likelyFamilyId = detectLikelyFamilyId(files);
  const datedCoverage = dated.length / Math.max(1, files.length);
  if (!likelyFamilyId && datedCoverage < 0.1) {
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
  const now = new Date();
  const todayNoon = createUtcDateNoon(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
  const anchoredWindowEndMs = (todayNoon?.getTime() ?? latestMs) - DAY_MS;
  const windowStartMs = anchoredWindowEndMs - (lookbackDays - 1) * DAY_MS;

  let filteredOutCount = 0;
  let filteredOutBytes = 0;
  const kept = datedEntries
    .filter((entry) => {
      if (entry.date) {
        const t = entry.date.getTime();
        const keep = t >= windowStartMs && t <= anchoredWindowEndMs;
        if (!keep) {
          filteredOutCount += 1;
          filteredOutBytes += entry.file.size;
        }
        return keep;
      }

      const keepUndated = shouldKeepUndatedFile(entry.file.path, entry.file.size, likelyFamilyId);
      if (!keepUndated) {
        filteredOutCount += 1;
        filteredOutBytes += entry.file.size;
      }
      return keepUndated;
    })
    .map((entry) => entry.file);

  const outputFiles = kept.length > 0 ? kept : files;
  const latestDateIso = new Date(anchoredWindowEndMs).toISOString().slice(0, 10);

  return {
    files: outputFiles,
    originalCount: files.length,
    filteredOutCount: outputFiles === files ? 0 : filteredOutCount,
    filteredOutBytes: outputFiles === files ? 0 : filteredOutBytes,
    latestDateIso,
    hadDatedFiles: true
  };
}

export function filterFolderEntriesToRecentWindow<T extends { relativePath: string; size: number }>(
  entries: T[],
  lookbackDays: number
): {
  entries: T[];
  originalCount: number;
  filteredOutCount: number;
  filteredOutBytes: number;
  latestDateIso: string | null;
  hadDatedFiles: boolean;
} {
  const datedEntries = entries.map((entry) => ({
    entry,
    path: entry.relativePath,
    size: entry.size,
    date: extractDateFromPath(entry.relativePath)
  }));

  const dated = datedEntries.filter((item): item is typeof item & { date: Date } => item.date !== null);
  if (dated.length === 0) {
    return {
      entries,
      originalCount: entries.length,
      filteredOutCount: 0,
      filteredOutBytes: 0,
      latestDateIso: null,
      hadDatedFiles: false
    };
  }

  const likelyFamilyId = detectLikelyFamilyId(datedEntries.map((item) => ({ path: item.path })));
  const datedCoverage = dated.length / Math.max(1, entries.length);
  if (!likelyFamilyId && datedCoverage < 0.1) {
    return {
      entries,
      originalCount: entries.length,
      filteredOutCount: 0,
      filteredOutBytes: 0,
      latestDateIso: null,
      hadDatedFiles: false
    };
  }

  const latestMs = dated.reduce((max, item) => Math.max(max, item.date.getTime()), dated[0].date.getTime());
  const now = new Date();
  const todayNoon = createUtcDateNoon(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
  const anchoredWindowEndMs = (todayNoon?.getTime() ?? latestMs) - DAY_MS;
  const windowStartMs = anchoredWindowEndMs - (lookbackDays - 1) * DAY_MS;

  let filteredOutCount = 0;
  let filteredOutBytes = 0;
  const kept = datedEntries
    .filter((item) => {
      if (item.date) {
        const t = item.date.getTime();
        const keep = t >= windowStartMs && t <= anchoredWindowEndMs;
        if (!keep) {
          filteredOutCount += 1;
          filteredOutBytes += item.size;
        }
        return keep;
      }

      const keepUndated = shouldKeepUndatedFile(item.path, item.size, likelyFamilyId);
      if (!keepUndated) {
        filteredOutCount += 1;
        filteredOutBytes += item.size;
      }
      return keepUndated;
    })
    .map((item) => item.entry);

  const outputEntries = kept.length > 0 ? kept : entries;
  const latestDateIso = new Date(anchoredWindowEndMs).toISOString().slice(0, 10);

  return {
    entries: outputEntries,
    originalCount: entries.length,
    filteredOutCount: outputEntries === entries ? 0 : filteredOutCount,
    filteredOutBytes: outputEntries === entries ? 0 : filteredOutBytes,
    latestDateIso,
    hadDatedFiles: true
  };
}

function createCachedSourceFile(
  params: {
    name: string;
    path: string;
    size: number;
    loadText: () => Promise<string>;
    loadBytes: () => Promise<Uint8Array>;
  }
): SourceFile {
  let textPromise: Promise<string> | null = null;
  let bytesPromise: Promise<Uint8Array> | null = null;

  return {
    name: params.name,
    path: params.path,
    size: params.size,
    readText: async () => {
      if (!textPromise) textPromise = params.loadText();
      return await textPromise;
    },
    readBytes: async () => {
      if (!bytesPromise) {
        bytesPromise = params.loadBytes().then((bytes) => new Uint8Array(bytes));
      }
      return await bytesPromise;
    }
  };
}

export function createSourceFileSummary(file: Pick<SourceFile, "name" | "path" | "size">): SourceFileSummary {
  return {
    name: file.name,
    path: file.path,
    size: file.size
  };
}

export async function createCachedSourceFilesFromFolder(
  entries: FolderSourceEntry[],
  onProgress?: ProgressCallback
): Promise<SourceFile[]> {
  const mapped: SourceFile[] = [];
  const chunkSize = 40;
  let chunkCount = 0;

  for (let start = 0; start < entries.length; start += chunkSize) {
    chunkCount += 1;
    const end = Math.min(start + chunkSize, entries.length);
    for (let i = start; i < end; i += 1) {
      const entry = entries[i];
      const file = entry.file;
      mapped.push(
        createCachedSourceFile({
          name: file.name,
          path: entry.relativePath || file.name,
          size: file.size,
          loadText: async () => await file.text(),
          loadBytes: async () => new Uint8Array(await file.arrayBuffer())
        })
      );
    }

    if (chunkCount % 6 === 0 || end === entries.length) {
      const pct = Math.min(45, 5 + Math.round((end / entries.length) * 40));
      emit(onProgress, {
        phase: "scan",
        detail: `Indexing files... ${end}/${entries.length}`,
        percent: pct
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return mapped;
}

export async function createCachedSourceFilesFromZip(
  zipFile: File,
  onProgress?: ProgressCallback
): Promise<SourceFile[]> {
  emit(onProgress, { phase: "zip", detail: "Opening ZIP file...", percent: 8 });
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
      mapped.push(
        createCachedSourceFile({
          name: entry.name.split("/").pop() ?? entry.name,
          path: entry.name,
          size: Number.isFinite(sizeMaybe) ? sizeMaybe : 0,
          loadText: async () => await entry.async("string"),
          loadBytes: async () => await entry.async("uint8array")
        })
      );
    }
    if (chunkCount % 4 === 0 || end === entries.length) {
      const pct = Math.min(45, 9 + Math.round((end / entries.length) * 36));
      emit(onProgress, {
        phase: "zip",
        detail: `Indexing ZIP entries... ${end}/${entries.length}`,
        percent: pct
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return mapped;
}
