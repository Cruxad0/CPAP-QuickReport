import type {
  SleepTimingAnalysis,
  SleepTimingConfidence,
  SleepTimingProfile,
  TherapyUsageSession
} from "@/lib/types";

export const CMS_SHORT_BREAK_MINUTES = 30;

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;
const DAY_MS = DAY_MINUTES * MINUTE_MS;
const MIN_INFERENCE_SESSION_MINUTES = 90;
const INLIER_DISTANCE_MINUTES = 4 * 60;

type NormalizedSession = {
  startMs: number;
  endMs: number;
  durationMinutes: number;
};

export interface SleepDayClassification {
  sleepDayIso: string;
  totalTherapyMinutes: number;
  expectedSleepMinutes: number;
  suspectedNapMinutes: number;
  cmsFourHourUse: boolean;
}

export interface SleepWindowClassification {
  days: SleepDayClassification[];
  totalTherapyMinutes: number;
  expectedSleepMinutes: number;
  suspectedNapMinutes: number;
  compliantDays: number;
}

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function circularDistanceMinutes(a: number, b: number): number {
  const direct = Math.abs(modulo(a, DAY_MINUTES) - modulo(b, DAY_MINUTES));
  return Math.min(direct, DAY_MINUTES - direct);
}

function utcMinuteOfDay(timestampMs: number): number {
  const date = new Date(timestampMs);
  return date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
}

function normalizeSessions(sessions: TherapyUsageSession[]): NormalizedSession[] {
  const normalized = sessions
    .map((session) => {
      const startMs = Date.parse(session.startIso);
      const endMs = Date.parse(session.endIso);
      const durationMinutes = (endMs - startMs) / MINUTE_MS;
      return { startMs, endMs, durationMinutes };
    })
    .filter(
      (session) =>
        Number.isFinite(session.startMs) &&
        Number.isFinite(session.endMs) &&
        session.endMs > session.startMs &&
        session.durationMinutes > 0 &&
        session.durationMinutes <= DAY_MINUTES
    )
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const deduped: NormalizedSession[] = [];
  for (const session of normalized) {
    const duplicate = deduped.some(
      (existing) =>
        Math.abs(existing.startMs - session.startMs) <= 2 * MINUTE_MS &&
        Math.abs(existing.endMs - session.endMs) <= 2 * MINUTE_MS
    );
    if (!duplicate) deduped.push(session);
  }
  return deduped;
}

function calendarDayIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function addIsoDays(isoDay: string, days: number): string {
  const date = new Date(`${isoDay}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function circularMeanMinutes(values: Array<{ minute: number; weight: number }>, fallback: number): number {
  let x = 0;
  let y = 0;
  for (const value of values) {
    const radians = (modulo(value.minute, DAY_MINUTES) / DAY_MINUTES) * Math.PI * 2;
    x += Math.cos(radians) * value.weight;
    y += Math.sin(radians) * value.weight;
  }
  if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) return modulo(fallback, DAY_MINUTES);
  return modulo((Math.atan2(y, x) / (Math.PI * 2)) * DAY_MINUTES, DAY_MINUTES);
}

function weightedMedian(entries: Array<{ value: number; weight: number }>): number {
  if (entries.length === 0) return 0;
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  let cumulative = 0;
  for (const entry of sorted) {
    cumulative += entry.weight;
    if (cumulative >= total / 2) return entry.value;
  }
  return sorted[sorted.length - 1].value;
}

function dominantDailySessions(sessions: NormalizedSession[]): NormalizedSession[] {
  const eligible = sessions.filter((session) => session.durationMinutes >= MIN_INFERENCE_SESSION_MINUTES);
  const source = eligible.length >= 3 ? eligible : sessions;
  const byCalendarStartDay = new Map<string, NormalizedSession>();
  for (const session of source) {
    const key = calendarDayIso(session.startMs);
    const current = byCalendarStartDay.get(key);
    if (!current || session.durationMinutes > current.durationMinutes) {
      byCalendarStartDay.set(key, session);
    }
  }
  return [...byCalendarStartDay.values()].sort((a, b) => a.startMs - b.startMs);
}

function findAnchor(principalSessions: NormalizedSession[]): {
  anchorMinutes: number;
  inliers: NormalizedSession[];
  concentration: number;
} | null {
  if (principalSessions.length < 3) return null;

  let bestCandidate = utcMinuteOfDay(principalSessions[0].startMs);
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidateSession of principalSessions) {
    const candidate = utcMinuteOfDay(candidateSession.startMs);
    let score = 0;
    for (const session of principalSessions) {
      const distance = circularDistanceMinutes(candidate, utcMinuteOfDay(session.startMs));
      const kernel = Math.exp(-0.5 * Math.pow(distance / 150, 2));
      const durationWeight = Math.sqrt(Math.min(12 * 60, session.durationMinutes) / 60);
      score += kernel * durationWeight;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  const inliers = principalSessions.filter(
    (session) => circularDistanceMinutes(bestCandidate, utcMinuteOfDay(session.startMs)) <= INLIER_DISTANCE_MINUTES
  );
  if (inliers.length < 2) return null;

  const weightedStarts = inliers.map((session) => ({
    minute: utcMinuteOfDay(session.startMs),
    weight: Math.sqrt(Math.min(12 * 60, session.durationMinutes) / 60)
  }));
  const anchorMinutes = circularMeanMinutes(weightedStarts, bestCandidate);
  const meanDistance =
    inliers.reduce(
      (sum, session) => sum + circularDistanceMinutes(anchorMinutes, utcMinuteOfDay(session.startMs)),
      0
    ) / inliers.length;
  const concentration = Math.max(0, 1 - meanDistance / INLIER_DISTANCE_MINUTES);
  return { anchorMinutes, inliers, concentration };
}

function confidenceLabel(score: number): SleepTimingConfidence {
  if (score >= 0.75) return "high";
  if (score >= 0.5) return "moderate";
  return "low";
}

function subsetAnchor(sessions: NormalizedSession[]): number | null {
  const result = findAnchor(dominantDailySessions(sessions));
  return result?.anchorMinutes ?? null;
}

function detectScheduleDrift(sessions: NormalizedSession[]): boolean {
  if (sessions.length < 14) return false;
  const newestStart = sessions[sessions.length - 1].startMs;
  const recentCutoff = newestStart - 14 * DAY_MS;
  const recent = sessions.filter((session) => session.startMs >= recentCutoff);
  const prior = sessions.filter((session) => session.startMs < recentCutoff);
  if (dominantDailySessions(recent).length < 5 || dominantDailySessions(prior).length < 5) return false;
  const recentAnchor = subsetAnchor(recent);
  const priorAnchor = subsetAnchor(prior);
  return recentAnchor !== null && priorAnchor !== null && circularDistanceMinutes(recentAnchor, priorAnchor) >= 4 * 60;
}

export function inferSleepTimingProfile(sessions: TherapyUsageSession[]): SleepTimingProfile | null {
  const normalized = normalizeSessions(sessions);
  const principalSessions = dominantDailySessions(normalized);
  const anchorResult = findAnchor(principalSessions);
  if (!anchorResult) return null;

  const typicalDurationMinutes = Math.min(
    12 * 60,
    Math.max(
      60,
      weightedMedian(
        anchorResult.inliers.map((session) => ({
          value: session.durationMinutes,
          weight: Math.sqrt(Math.min(12 * 60, session.durationMinutes) / 60)
        }))
      )
    )
  );
  const inlierRatio = anchorResult.inliers.length / Math.max(1, principalSessions.length);
  const sampleStrength = Math.min(1, principalSessions.length / 14);
  const drift = detectScheduleDrift(normalized);
  const rawScore = 0.5 * inlierRatio + 0.3 * anchorResult.concentration + 0.2 * sampleStrength;
  const confidenceScore = Math.max(0, Math.min(1, rawScore - (drift ? 0.2 : 0)));
  const anchorMinutes = Math.round(anchorResult.anchorMinutes);
  const roundedDuration = Math.round(typicalDurationMinutes);

  return {
    anchorMinutes,
    typicalDurationMinutes: roundedDuration,
    sleepWindowStartMinutes: anchorMinutes,
    sleepWindowEndMinutes: modulo(anchorMinutes + roundedDuration, DAY_MINUTES),
    sleepDayBoundaryMinutes: modulo(anchorMinutes - 8 * 60, DAY_MINUTES),
    confidence: confidenceLabel(confidenceScore),
    confidenceScore,
    supportingDays: anchorResult.inliers.length,
    observedDays: principalSessions.length,
    scheduleDriftDetected: drift
  };
}

function mergeEpisodes(sessions: NormalizedSession[], maxGapMinutes: number): NormalizedSession[] {
  const merged: NormalizedSession[] = [];
  for (const session of sessions) {
    const previous = merged[merged.length - 1];
    const gapMinutes = previous ? (session.startMs - previous.endMs) / MINUTE_MS : Number.POSITIVE_INFINITY;
    if (previous && gapMinutes <= maxGapMinutes) {
      const overlapMinutes = Math.max(0, (previous.endMs - session.startMs) / MINUTE_MS);
      previous.durationMinutes += Math.max(0, session.durationMinutes - overlapMinutes);
      previous.endMs = Math.max(previous.endMs, session.endMs);
    } else {
      merged.push({ ...session });
    }
  }
  return merged;
}

function sleepDayForSession(startMs: number, boundaryMinutes: number): string {
  const startMinute = utcMinuteOfDay(startMs);
  const calendarIso = calendarDayIso(startMs);
  return startMinute < boundaryMinutes ? addIsoDays(calendarIso, -1) : calendarIso;
}

export function classifyTherapySessions(
  sessions: TherapyUsageSession[],
  profile: SleepTimingProfile,
  windowStartIso?: string,
  windowEndIsoExclusive?: string
): SleepWindowClassification {
  const normalized = normalizeSessions(sessions);
  const bySleepDay = new Map<string, NormalizedSession[]>();

  for (const session of normalized) {
    const sleepDayIso = sleepDayForSession(session.startMs, profile.sleepDayBoundaryMinutes);
    const daySessions = bySleepDay.get(sleepDayIso) ?? [];
    daySessions.push(session);
    bySleepDay.set(sleepDayIso, daySessions);
  }

  const days: SleepDayClassification[] = [];
  for (const [sleepDayIso, daySessions] of [...bySleepDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const isIsoInsideWindow = (isoDay: string) =>
      (!windowStartIso || isoDay >= windowStartIso) &&
      (!windowEndIsoExclusive || isoDay < windowEndIsoExclusive);
    const touchesWindow =
      isIsoInsideWindow(sleepDayIso) ||
      daySessions.some(
        (session) =>
          isIsoInsideWindow(calendarDayIso(session.startMs)) ||
          isIsoInsideWindow(calendarDayIso(session.startMs - 12 * 60 * MINUTE_MS))
      );
    if (!touchesWindow) continue;
    const episodes = mergeEpisodes(daySessions, CMS_SHORT_BREAK_MINUTES);
    if (episodes.length === 0) continue;
    const principalCandidates = episodes.filter((episode) => {
      const distance = circularDistanceMinutes(profile.anchorMinutes, utcMinuteOfDay(episode.startMs));
      // A continuous four-hour episode is itself relevant to the CMS usage
      // threshold even when a changing work schedule moves it off the dominant
      // clock-time cluster. Shorter episodes need timing support to avoid
      // promoting an isolated nap to the principal sleep episode.
      return distance <= 6 * 60 || episode.durationMinutes >= 4 * 60;
    });
    const principal = principalCandidates.length > 0 ? principalCandidates.reduce((best, episode) => {
      const bestDistance = circularDistanceMinutes(profile.anchorMinutes, utcMinuteOfDay(best.startMs));
      const episodeDistance = circularDistanceMinutes(profile.anchorMinutes, utcMinuteOfDay(episode.startMs));
      const bestScore = best.durationMinutes * (1 + 0.5 * Math.exp(-0.5 * Math.pow(bestDistance / 180, 2)));
      const episodeScore = episode.durationMinutes * (1 + 0.5 * Math.exp(-0.5 * Math.pow(episodeDistance / 180, 2)));
      return episodeScore > bestScore ? episode : best;
    }) : null;
    const totalTherapyMinutes = episodes.reduce((sum, episode) => sum + episode.durationMinutes, 0);
    const expectedSleepMinutes = principal?.durationMinutes ?? 0;
    const suspectedNapMinutes = Math.max(0, totalTherapyMinutes - expectedSleepMinutes);
    days.push({
      sleepDayIso,
      totalTherapyMinutes,
      expectedSleepMinutes,
      suspectedNapMinutes,
      cmsFourHourUse: expectedSleepMinutes >= 4 * 60
    });
  }

  return {
    days,
    totalTherapyMinutes: days.reduce((sum, day) => sum + day.totalTherapyMinutes, 0),
    expectedSleepMinutes: days.reduce((sum, day) => sum + day.expectedSleepMinutes, 0),
    suspectedNapMinutes: days.reduce((sum, day) => sum + day.suspectedNapMinutes, 0),
    compliantDays: days.filter((day) => day.cmsFourHourUse).length
  };
}

export function buildSleepTimingAnalysis(profile: SleepTimingProfile, timingCoveragePercent: number): SleepTimingAnalysis {
  return {
    ...profile,
    method: "inferred-session-timing",
    timingCoveragePercent: Math.max(0, Math.min(100, timingCoveragePercent)),
    cmsShortBreakMinutes: CMS_SHORT_BREAK_MINUTES
  };
}

export function formatClockMinutes(minutes: number): string {
  const normalized = Math.round(modulo(minutes, DAY_MINUTES));
  const hour24 = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

export function formatDurationHoursAsHmm(hours: number): string {
  const totalMinutes = Math.max(0, Math.round(hours * 60));
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${wholeHours}:${String(minutes).padStart(2, "0")}`;
}
