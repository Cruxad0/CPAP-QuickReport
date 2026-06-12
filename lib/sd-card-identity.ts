export const WARN_ON_DIFFERENT_SD_CARD_KEY = "cpap-quickreport.warn-on-different-sd-card";
export const LAST_SD_CARD_IDENTITY_KEY = "cpap-quickreport.last-sd-card-identity";

export function normalizeSdCardIdentity(identity: string | null | undefined): string | null {
  const normalized = identity?.trim().replace(/\s+/g, " ").replace(/\s*\|\s*/g, "|").toLowerCase();
  return normalized ? normalized : null;
}

export function isDifferentSdCard(
  previousIdentity: string | null | undefined,
  currentIdentity: string | null | undefined
): boolean {
  const previous = normalizeSdCardIdentity(previousIdentity);
  const current = normalizeSdCardIdentity(currentIdentity);
  return Boolean(previous && current && previous !== current);
}

export function sdCardIdentityLabel(identity: string | null | undefined): string {
  const trimmed = identity?.trim();
  if (!trimmed) return "Unknown device";
  const separator = trimmed.indexOf("|");
  return separator >= 0 ? trimmed.slice(separator + 1).trim() || trimmed : trimmed;
}
