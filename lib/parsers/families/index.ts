import { BMC_FAMILY, hasBmcBundleStructure, hasBmcUsrStructure } from "@/lib/parsers/families/bmc";
import { CMS50_FAMILY } from "@/lib/parsers/families/cms50";
import { CMS50F37_FAMILY } from "@/lib/parsers/families/cms50f37";
import { DREEM_FAMILY } from "@/lib/parsers/families/dreem";
import { ICON_FAMILY } from "@/lib/parsers/families/icon";
import { INTELLIPAP_FAMILY } from "@/lib/parsers/families/intellipap";
import { MSERIES_FAMILY } from "@/lib/parsers/families/mseries";
import { MD300W1_FAMILY } from "@/lib/parsers/families/md300w1";
import { PRISMA_FAMILY } from "@/lib/parsers/families/prisma";
import { PRS1_FAMILY } from "@/lib/parsers/families/prs1";
import { RESMED_FAMILY } from "@/lib/parsers/families/resmed";
import { RESVENT_FAMILY } from "@/lib/parsers/families/resvent";
import { SLEEPSTYLE_FAMILY } from "@/lib/parsers/families/sleepstyle";
import { SOMNOPOSE_FAMILY } from "@/lib/parsers/families/somnopose";
import type { LoaderMatch, ParserFamilyDefinition, SourceMetaLike } from "@/lib/parsers/families/types";
import { VIATOM_FAMILY } from "@/lib/parsers/families/viatom";
import { VREM_FAMILY } from "@/lib/parsers/families/vrem";
import { WEINMANN_FAMILY } from "@/lib/parsers/families/weinmann";
import { YUWELL_FAMILY } from "@/lib/parsers/families/yuwell";
import { ZEO_FAMILY } from "@/lib/parsers/families/zeo";

const BASE_PRIORITY_PATTERNS: RegExp[] = [
  /(?:^|\/)(?:therapy|record|datalog|summary|detail|session|usage|result|events?)\//i,
  /(?:^|\/)(?:stat\d{0,4}|ev\d{0,4}|summary|detail|session|usage|result|report|compliance)(?:\..*)?$/i,
  /(?:^|\/)(?:str|eve|pld|sad|brp|crc)\.edf(?:\.gz)?$/i
];

export const PARSER_FAMILIES: ParserFamilyDefinition[] = [
  RESVENT_FAMILY,
  RESMED_FAMILY,
  SLEEPSTYLE_FAMILY,
  PRISMA_FAMILY,
  WEINMANN_FAMILY,
  PRS1_FAMILY,
  MSERIES_FAMILY,
  BMC_FAMILY,
  INTELLIPAP_FAMILY,
  ICON_FAMILY,
  YUWELL_FAMILY,
  DREEM_FAMILY,
  VIATOM_FAMILY,
  VREM_FAMILY,
  CMS50_FAMILY,
  CMS50F37_FAMILY,
  MD300W1_FAMILY,
  SOMNOPOSE_FAMILY,
  ZEO_FAMILY
];

const PARSER_FAMILY_BY_ID = new Map(PARSER_FAMILIES.map((family) => [family.id, family]));

function familyHit(files: SourceMetaLike[], pattern: RegExp): boolean {
  return files.some((file) => pattern.test(file.normalizedPath));
}

function scoreFamily(files: SourceMetaLike[], family: ParserFamilyDefinition): number {
  let score = 0;

  for (const pattern of family.signaturePatterns) {
    if (familyHit(files, pattern)) score += 1;
  }

  for (const entry of family.confidencePatterns) {
    if (familyHit(files, entry.pattern)) score += entry.weight;
  }

  if (family.id === "bmc" && hasBmcBundleStructure(files)) {
    score += 10;
  }
  if (family.id === "bmc" && !hasBmcBundleStructure(files) && hasBmcUsrStructure(files)) {
    score += 4;
  }

  return score;
}

export function getParserFamily(familyId: string): ParserFamilyDefinition | null {
  return PARSER_FAMILY_BY_ID.get(familyId) ?? null;
}

export function hasFamilySignature(files: SourceMetaLike[], familyId: string): boolean {
  const family = getParserFamily(familyId);
  if (!family) return false;
  if (family.id === "bmc") {
    return hasBmcBundleStructure(files) || hasBmcUsrStructure(files);
  }
  return family.signaturePatterns.some((pattern) => familyHit(files, pattern));
}

export function rankParserFamilies(files: SourceMetaLike[]): LoaderMatch[] {
  return PARSER_FAMILIES
    .map((family) => ({ id: family.id, label: family.label, score: scoreFamily(files, family), family }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

export interface DatedSourceMetaLike extends SourceMetaLike {
  recordDate?: Date | null;
}

export interface LoaderRecencySummary {
  match: LoaderMatch;
  candidateCount: number;
  datedCandidateCount: number;
  latestDate: Date | null;
  latestPath: string | null;
}

export interface RecencyLoaderSelection {
  selected: LoaderMatch | null;
  selectedByLatestDatedData: boolean;
  summaries: LoaderRecencySummary[];
}

function summarizeFamilyRecency(files: DatedSourceMetaLike[], match: LoaderMatch): LoaderRecencySummary {
  const candidates = files.filter((file) => isCandidateForFamily(file, match.family));
  let latestDate: Date | null = null;
  let latestPath: string | null = null;
  let datedCandidateCount = 0;

  for (const candidate of candidates) {
    const recordDate = candidate.recordDate ?? null;
    if (!recordDate || Number.isNaN(recordDate.getTime())) continue;
    datedCandidateCount += 1;
    if (!latestDate || recordDate > latestDate) {
      latestDate = recordDate;
      latestPath = candidate.normalizedPath;
    }
  }

  return {
    match,
    candidateCount: candidates.length,
    datedCandidateCount,
    latestDate,
    latestPath
  };
}

function compareRecencySummary(a: LoaderRecencySummary, b: LoaderRecencySummary): number {
  const dateDelta = (b.latestDate?.getTime() ?? Number.NEGATIVE_INFINITY) - (a.latestDate?.getTime() ?? Number.NEGATIVE_INFINITY);
  if (dateDelta !== 0) return dateDelta;
  return b.match.score - a.match.score || a.match.label.localeCompare(b.match.label);
}

export function selectLoaderMatchByDatedRecency(
  files: DatedSourceMetaLike[],
  loaderRanking = rankParserFamilies(files)
): RecencyLoaderSelection {
  const defaultSelected = loaderRanking[0] ?? null;
  const supportedSummaries = loaderRanking
    .filter((match) => match.family.supportedQuickReport)
    .map((match) => summarizeFamilyRecency(files, match));

  if (!defaultSelected || supportedSummaries.length < 2) {
    return {
      selected: defaultSelected,
      selectedByLatestDatedData: false,
      summaries: supportedSummaries
    };
  }

  const defaultSummary = supportedSummaries.find((summary) => summary.match.id === defaultSelected.id) ?? null;
  const datedSummaries = supportedSummaries.filter((summary) => summary.latestDate !== null).sort(compareRecencySummary);
  const newestSummary = datedSummaries[0] ?? null;
  const defaultDate = defaultSummary?.latestDate ?? null;

  if (
    defaultDate &&
    newestSummary?.latestDate &&
    newestSummary.match.id !== defaultSelected.id &&
    newestSummary.latestDate > defaultDate
  ) {
    return {
      selected: newestSummary.match,
      selectedByLatestDatedData: true,
      summaries: supportedSummaries
    };
  }

  return {
    selected: defaultSelected,
    selectedByLatestDatedData: false,
    summaries: supportedSummaries
  };
}

export function detectLikelyLoaderLabels(files: SourceMetaLike[]): string[] {
  return PARSER_FAMILIES.filter((family) => family.signaturePatterns.some((pattern) => familyHit(files, pattern))).map((family) => family.label);
}

export function buildFamilyPriorityPatterns(family: ParserFamilyDefinition): RegExp[] {
  return [...BASE_PRIORITY_PATTERNS, ...family.priorityPatterns];
}

export function isCandidateForFamily(file: SourceMetaLike, family: ParserFamilyDefinition): boolean {
  const allPatterns = [...family.signaturePatterns, ...family.priorityPatterns];
  return allPatterns.some((pattern) => pattern.test(file.normalizedPath));
}

export type { LoaderMatch, ParserFamilyDefinition };
