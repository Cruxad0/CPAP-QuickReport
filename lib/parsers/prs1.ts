import { runTextFamilyParser } from "@/lib/parsers/text-family-runner";
import type { FamilyParserCandidate, FamilyParserContext, FamilyParserDeps } from "@/lib/parsers/text-family-types";
import type { ParsedRecord, QuickReportMetrics } from "@/lib/types";

type CanonicalMode = "CPAP" | "APAP" | "BiPAP";

type Prs1Chunk = {
  normalizedPath: string;
  fileVersion: number;
  htype: number;
  family: number;
  familyVersion: number;
  ext: number;
  sessionId: number;
  timestamp: number;
  hblock: Map<number, number>;
  data: Uint8Array;
};

type Prs1SessionAccumulator = {
  sessionId: number;
  timestamp: number;
  mode?: CanonicalMode;
  pressure?: number;
  pressureMin?: number;
  pressureMax?: number;
  epap?: number;
  ipap?: number;
  epapMin?: number;
  epapMax?: number;
  ipapMin?: number;
  ipapMax?: number;
  pressure95th?: number;
  pressureAvgSum: number;
  pressureAvgCount: number;
  pressureReliefMode?: string;
  pressureReliefLevel?: number;
  usageSeconds: number;
  obstructiveApneaCount: number;
  centralApneaCount: number;
  hypopneaCount: number;
  reraCount: number;
  leakSum: number;
  leakCount: number;
  leakMax: number | null;
  seenSummaryKeys: Set<string>;
  seenEventKeys: Set<string>;
};

const PRS1_EXACT_MODELS = new Map<string, { label: string; mode: CanonicalMode }>([
  ["251P", { label: "REMstar Plus (System One)", mode: "CPAP" }],
  ["450P", { label: "REMstar Pro (System One)", mode: "CPAP" }],
  ["451P", { label: "REMstar Pro (System One)", mode: "CPAP" }],
  ["452P", { label: "REMstar Pro (System One)", mode: "CPAP" }],
  ["550P", { label: "REMstar Auto (System One)", mode: "APAP" }],
  ["551P", { label: "REMstar Auto (System One)", mode: "APAP" }],
  ["552P", { label: "REMstar Auto (System One 60 Series)", mode: "APAP" }],
  ["650P", { label: "BiPAP Pro (System One)", mode: "BiPAP" }],
  ["750P", { label: "BiPAP Auto (System One)", mode: "BiPAP" }],
  ["261CA", { label: "REMstar Plus (System One 60 Series)", mode: "CPAP" }],
  ["261P", { label: "REMstar Plus (System One 60 Series)", mode: "CPAP" }],
  ["460P", { label: "REMstar Pro (System One 60 Series)", mode: "CPAP" }],
  ["460PBT", { label: "REMstar Pro (System One 60 Series)", mode: "CPAP" }],
  ["461P", { label: "REMstar Pro (System One 60 Series)", mode: "CPAP" }],
  ["462P", { label: "REMstar Pro (System One 60 Series)", mode: "CPAP" }],
  ["461CA", { label: "REMstar Pro (System One 60 Series)", mode: "CPAP" }],
  ["560P", { label: "REMstar Auto (System One 60 Series)", mode: "APAP" }],
  ["560PBT", { label: "REMstar Auto (System One 60 Series)", mode: "APAP" }],
  ["561P", { label: "REMstar Auto (System One 60 Series)", mode: "APAP" }],
  ["562P", { label: "REMstar Auto (System One 60 Series)", mode: "APAP" }],
  ["660P", { label: "BiPAP Pro (System One 60 Series)", mode: "BiPAP" }],
  ["760P", { label: "BiPAP Auto (System One 60 Series)", mode: "BiPAP" }],
  ["761P", { label: "BiPAP Auto (System One 60 Series)", mode: "BiPAP" }],
  ["501V", { label: "Dorma 500 Auto (System One 60 Series)", mode: "APAP" }],
  ["200X110", { label: "DreamStation CPAP", mode: "CPAP" }],
  ["400G110", { label: "DreamStation Go", mode: "CPAP" }],
  ["400X110", { label: "DreamStation CPAP Pro", mode: "CPAP" }],
  ["400X120", { label: "DreamStation CPAP Pro", mode: "CPAP" }],
  ["400X130", { label: "DreamStation CPAP Pro", mode: "CPAP" }],
  ["400X150", { label: "DreamStation CPAP Pro", mode: "CPAP" }],
  ["401X150", { label: "DreamStation CPAP Pro with Auto-Trial", mode: "APAP" }],
  ["500X110", { label: "DreamStation Auto CPAP", mode: "APAP" }],
  ["500X120", { label: "DreamStation Auto CPAP", mode: "APAP" }],
  ["500X130", { label: "DreamStation Auto CPAP", mode: "APAP" }],
  ["500X140", { label: "DreamStation Auto CPAP with A-Flex", mode: "APAP" }],
  ["500X150", { label: "DreamStation Auto CPAP", mode: "APAP" }],
  ["500X180", { label: "DreamStation Auto CPAP", mode: "APAP" }],
  ["501X120", { label: "DreamStation Auto CPAP with P-Flex", mode: "APAP" }],
  ["500G110", { label: "DreamStation Go Auto", mode: "APAP" }],
  ["500G120", { label: "DreamStation Go Auto", mode: "APAP" }],
  ["500G150", { label: "DreamStation Go Auto", mode: "APAP" }],
  ["502G150", { label: "DreamStation Go Auto", mode: "APAP" }],
  ["600X110", { label: "DreamStation BiPAP Pro", mode: "BiPAP" }],
  ["600X150", { label: "DreamStation BiPAP Pro", mode: "BiPAP" }],
  ["700X110", { label: "DreamStation Auto BiPAP", mode: "BiPAP" }],
  ["700X120", { label: "DreamStation Auto BiPAP", mode: "BiPAP" }],
  ["700X130", { label: "DreamStation Auto BiPAP", mode: "BiPAP" }],
  ["700X150", { label: "DreamStation Auto BiPAP", mode: "BiPAP" }],
  ["410X150C", { label: "DreamStation 2 CPAP", mode: "CPAP" }],
  ["410H11C", { label: "DreamStation 2 CPAP", mode: "CPAP" }],
  ["410T11C", { label: "DreamStation 2 CPAP", mode: "CPAP" }],
  ["420X150C", { label: "DreamStation 2 Advanced CPAP", mode: "CPAP" }],
  ["420H11C", { label: "DreamStation 2 Advanced CPAP", mode: "CPAP" }],
  ["420T11C", { label: "DreamStation 2 Advanced CPAP", mode: "CPAP" }],
  ["510H11C", { label: "DreamStation 2 Auto CPAP", mode: "APAP" }],
  ["510T11C", { label: "DreamStation 2 Auto CPAP", mode: "APAP" }],
  ["520X110C", { label: "DreamStation 2 Auto CPAP Advanced", mode: "APAP" }],
  ["520X130C", { label: "DreamStation 2 Auto CPAP Advanced", mode: "APAP" }],
  ["520X150C", { label: "DreamStation 2 Auto CPAP Advanced", mode: "APAP" }],
  ["520H11C", { label: "DreamStation 2 Auto CPAP Advanced", mode: "APAP" }],
  ["520T11C", { label: "DreamStation 2 Auto CPAP Advanced", mode: "APAP" }],
  ["521X120C", { label: "DreamStation 2 Auto CPAP Advanced with P-Flex", mode: "APAP" }],
  ["521X140C", { label: "DreamStation 2 Auto CPAP Advanced with P-Flex", mode: "APAP" }],
  ["950P", { label: "BiPAP AutoSV Advanced System One", mode: "BiPAP" }],
  ["951P", { label: "BiPAP AutoSV Advanced System One", mode: "BiPAP" }],
  ["960P", { label: "BiPAP autoSV Advanced (System One 60 Series)", mode: "BiPAP" }],
  ["961P", { label: "BiPAP autoSV Advanced (System One 60 Series)", mode: "BiPAP" }],
  ["960T", { label: "BiPAP autoSV Advanced 30 (System One 60 Series)", mode: "BiPAP" }],
  ["961TCA", { label: "BiPAP autoSV Advanced 30 (System One 60 Series)", mode: "BiPAP" }],
  ["900X110", { label: "DreamStation BiPAP autoSV", mode: "BiPAP" }],
  ["900X120", { label: "DreamStation BiPAP autoSV", mode: "BiPAP" }],
  ["900X150", { label: "DreamStation BiPAP autoSV", mode: "BiPAP" }],
  ["1061401", { label: "BiPAP S/T (C Series)", mode: "BiPAP" }],
  ["1061T", { label: "BiPAP S/T 30 (System One 60 Series)", mode: "BiPAP" }],
  ["1160P", { label: "BiPAP AVAPS 30 (System One 60 Series)", mode: "BiPAP" }],
  ["1030X110", { label: "DreamStation BiPAP S/T 30", mode: "BiPAP" }],
  ["1030X150", { label: "DreamStation BiPAP S/T 30 with AAM", mode: "BiPAP" }],
  ["1130X110", { label: "DreamStation BiPAP AVAPS 30", mode: "BiPAP" }],
  ["1131X150", { label: "DreamStation BiPAP AVAPS 30 AE", mode: "BiPAP" }],
  ["1130X200", { label: "DreamStation BiPAP AVAPS 30", mode: "BiPAP" }]
]);

const PRS1_BINARY_EXTENSIONS = new Set(["000", "001", "002", "b01", "b02"]);
const PRS1_TEXT_FILE_PATTERN = /(?:^|\/)(?:prop(?:erties)?(?:\.[^/]+)?\.txt)$/i;
const PRS1_LAST_FILE_PATTERN = /(?:^|\/)p-series\/last\.txt$/i;
const PRS1_DREAMSTATION_COMMON_KEY = Uint8Array.from([
  0x71, 0x84, 0x96, 0x44, 0xa7, 0x28, 0x11, 0x2b, 0x01, 0x5b, 0x62, 0x03, 0xcf, 0xb5, 0xc5, 0x69,
  0x51, 0xdb, 0x5f, 0x18, 0xe3, 0xf4, 0x94, 0x36, 0xfa, 0x4a, 0x0b, 0xeb, 0x75, 0x65, 0x87, 0x42
]);

type Prs1WrappedHeader = {
  iv: Uint8Array;
  salt: Uint8Array;
  exportKey: Uint8Array;
  exportKeyTag: Uint8Array;
  payloadTag: Uint8Array;
  ciphertextOffset: number;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/[_\s]+/g, " ").trim();
}

function readCaseInsensitive(map: Map<string, string>, keys: string[]): string | undefined {
  const lower = new Map<string, string>();
  for (const [key, value] of map.entries()) lower.set(key.toLowerCase(), value);
  for (const key of keys) {
    const hit = map.get(key) ?? lower.get(key.toLowerCase());
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function inferModeFromModel(model: string): CanonicalMode | null {
  if (/^(?:2\d{2}[A-Z]*|4\d{2}[A-Z]*|410X150C|420X150C)$/i.test(model)) return "CPAP";
  if (/^(?:5\d{2}[A-Z]*|501V|520X110C|520X130C|520X150C|521X120C|521X140C)$/i.test(model)) return "APAP";
  if (/^(?:6\d{2}[A-Z]*|7\d{2}[A-Z]*|9\d{2}[A-Z]*|10\d{2}.*|11\d{2}.*|1030X110|1030X150|1061401|1061T|1130X110|1130X200|1131X150|1160P)$/i.test(model)) {
    return "BiPAP";
  }
  return null;
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

function formatPressureNumber(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0 || value > 300) return undefined;
  const cm = value / 10;
  const rounded = Number(cm.toFixed(1));
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatPressure(value: number | undefined): string | undefined {
  const raw = formatPressureNumber(value);
  return raw ? `${raw} cmH2O` : undefined;
}

function formatPressureRange(minValue: number | undefined, maxValue: number | undefined): string | undefined {
  const min = formatPressureNumber(minValue);
  const max = formatPressureNumber(maxValue);
  if (min && max) return `${min}-${max} cmH2O`;
  return formatPressure(minValue ?? maxValue);
}

function asDateFromUnix(timestamp: number): Date | null {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizePrs1BinaryExtension(normalizedPath: string): string {
  return normalizedPath.split(".").pop()?.toLowerCase() ?? "";
}

function isPrs1BinaryCandidate(candidate: FamilyParserCandidate): boolean {
  const ext = normalizePrs1BinaryExtension(candidate.normalizedPath);
  if (!PRS1_BINARY_EXTENSIONS.has(ext)) return false;
  if (ext.startsWith("b")) {
    return /(?:^|\/)p-series\/[^/]+\/p\d+\//i.test(candidate.normalizedPath) || /(?:^|\/)p\d+\//i.test(candidate.normalizedPath);
  }
  return true;
}

function isPrs1TextCandidate(candidate: FamilyParserCandidate): boolean {
  return PRS1_TEXT_FILE_PATTERN.test(candidate.normalizedPath);
}

function isPrs1LastCandidate(candidate: FamilyParserCandidate): boolean {
  return PRS1_LAST_FILE_PATTERN.test(candidate.normalizedPath);
}

function getPrs1MachineRootId(normalizedPath: string): string | null {
  const match = normalizedPath.match(/(?:^|\/)p-series\/([^/]+)\//i);
  return match?.[1]?.trim().toUpperCase() ?? null;
}

function isWithinPrs1MachineRoot(normalizedPath: string, machineRootId: string): boolean {
  const escaped = machineRootId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scopedPattern = new RegExp(`(?:^|/)p-series/${escaped}/`, "i");
  return scopedPattern.test(normalizedPath);
}

async function selectPrs1MachineRootId(candidates: FamilyParserCandidate[]): Promise<string | null> {
  const counts = new Map<string, { files: number; binary: number }>();
  for (const candidate of candidates) {
    const machineRootId = getPrs1MachineRootId(candidate.normalizedPath);
    if (!machineRootId) continue;
    const bucket = counts.get(machineRootId) ?? { files: 0, binary: 0 };
    bucket.files += 1;
    if (isPrs1BinaryCandidate(candidate)) bucket.binary += 1;
    counts.set(machineRootId, bucket);
  }

  if (counts.size === 0) return null;
  if (counts.size === 1) return counts.keys().next().value ?? null;

  for (const candidate of candidates) {
    if (!isPrs1LastCandidate(candidate)) continue;
    try {
      const activeId = (await candidate.file.readText()).trim().split(/\s+/)[0]?.toUpperCase();
      if (activeId && counts.has(activeId)) return activeId;
    } catch {
      continue;
    }
  }

  return [...counts.entries()]
    .sort((a, b) => {
      const scoreA = a[1].binary * 10000 + a[1].files;
      const scoreB = b[1].binary * 10000 + b[1].files;
      return scoreB - scoreA;
    })
    .at(0)?.[0] ?? null;
}

function readLittle16(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null;
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readLengthPrefixedBytes(bytes: Uint8Array, offset: number): { value: Uint8Array; nextOffset: number } | null {
  const length = readLittle16(bytes, offset);
  if (length === null) return null;
  const start = offset + 2;
  const end = start + length;
  if (end > bytes.length) return null;
  return { value: bytes.subarray(start, end), nextOffset: end };
}

function parsePrs1WrappedHeader(bytes: Uint8Array): Prs1WrappedHeader | null {
  let offset = 0;
  const a = readLittle16(bytes, offset);
  offset += 2;
  const b = readLittle16(bytes, offset);
  offset += 2;
  const c = readLittle16(bytes, offset);
  offset += 2;
  if (a !== 0x0d || b !== 1 || c !== 1) return null;

  const guid = readLengthPrefixedBytes(bytes, offset);
  if (!guid || guid.value.length !== 36) return null;
  offset = guid.nextOffset;

  const iv = readLengthPrefixedBytes(bytes, offset);
  if (!iv || iv.value.length !== 12) return null;
  offset = iv.nextOffset;

  const salt = readLengthPrefixedBytes(bytes, offset);
  if (!salt || salt.value.length !== 16) return null;
  offset = salt.nextOffset;

  const f = readLittle16(bytes, offset);
  offset += 2;
  const g = readLittle16(bytes, offset);
  offset += 2;
  if (f !== 0 || g !== 1) return null;

  const importKey = readLengthPrefixedBytes(bytes, offset);
  if (!importKey || importKey.value.length !== 32) return null;
  offset = importKey.nextOffset;

  const importKeyTag = readLengthPrefixedBytes(bytes, offset);
  if (!importKeyTag || importKeyTag.value.length !== 16) return null;
  offset = importKeyTag.nextOffset;

  const exportKey = readLengthPrefixedBytes(bytes, offset);
  if (!exportKey || exportKey.value.length !== 32) return null;
  offset = exportKey.nextOffset;

  const exportKeyTag = readLengthPrefixedBytes(bytes, offset);
  if (!exportKeyTag || exportKeyTag.value.length !== 16) return null;
  offset = exportKeyTag.nextOffset;

  const payloadTag = readLengthPrefixedBytes(bytes, offset);
  if (!payloadTag || payloadTag.value.length !== 16) return null;
  offset = payloadTag.nextOffset;

  return {
    iv: iv.value,
    salt: salt.value,
    exportKey: exportKey.value,
    exportKeyTag: exportKeyTag.value,
    payloadTag: payloadTag.value,
    ciphertextOffset: offset
  };
}

function getSubtleCrypto(): SubtleCrypto | null {
  return globalThis.crypto?.subtle ?? null;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

function toCryptoBuffer(bytes: Uint8Array): ArrayBuffer {
  const sliced = bytes.slice();
  return sliced.buffer.slice(sliced.byteOffset, sliced.byteOffset + sliced.byteLength);
}

async function decryptPrs1WrappedBytes(
  bytes: Uint8Array,
  keyCache: Map<string, Uint8Array | null>
): Promise<Uint8Array | null> {
  const header = parsePrs1WrappedHeader(bytes);
  if (!header) return null;

  const subtle = getSubtleCrypto();
  if (!subtle) return null;

  const cacheKey = [
    ...header.iv,
    0xff,
    ...header.salt,
    0xff,
    ...header.exportKey,
    0xff,
    ...header.exportKeyTag
  ]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

  let payloadKey = keyCache.get(cacheKey) ?? null;
  if (!payloadKey) {
    try {
      const baseKey = await subtle.importKey("raw", toCryptoBuffer(PRS1_DREAMSTATION_COMMON_KEY), "PBKDF2", false, ["deriveBits"]);
      const saltedKeyBits = await subtle.deriveBits(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: toCryptoBuffer(header.salt),
          iterations: 10000
        },
        baseKey,
        256
      );
      const saltedKey = await subtle.importKey("raw", saltedKeyBits, { name: "AES-GCM" }, false, ["decrypt"]);
      const decryptedPayloadKey = await subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toCryptoBuffer(header.iv),
          tagLength: 128
        },
        saltedKey,
        toCryptoBuffer(concatBytes(header.exportKey, header.exportKeyTag))
      );
      payloadKey = new Uint8Array(decryptedPayloadKey);
      keyCache.set(cacheKey, payloadKey);
    } catch {
      keyCache.set(cacheKey, null);
      return null;
    }
  }

  if (!payloadKey) return null;

  try {
    const payloadCryptoKey = await subtle.importKey("raw", toCryptoBuffer(payloadKey), { name: "AES-GCM" }, false, ["decrypt"]);
    const decryptedPayload = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toCryptoBuffer(header.iv),
        tagLength: 128
      },
      payloadCryptoKey,
      toCryptoBuffer(concatBytes(bytes.subarray(header.ciphertextOffset), header.payloadTag))
    );
    return new Uint8Array(decryptedPayload);
  } catch {
    return null;
  }
}

function getOrCreateSession(
  sessions: Map<number, Prs1SessionAccumulator>,
  sessionId: number,
  timestamp: number
): Prs1SessionAccumulator {
  const existing = sessions.get(sessionId);
  if (existing) {
    if (timestamp > existing.timestamp) existing.timestamp = timestamp;
    return existing;
  }

  const created: Prs1SessionAccumulator = {
    sessionId,
    timestamp,
    pressureAvgSum: 0,
    pressureAvgCount: 0,
    usageSeconds: 0,
    obstructiveApneaCount: 0,
    centralApneaCount: 0,
    hypopneaCount: 0,
    reraCount: 0,
    leakSum: 0,
    leakCount: 0,
    leakMax: null,
    seenSummaryKeys: new Set<string>(),
    seenEventKeys: new Set<string>()
  };
  sessions.set(sessionId, created);
  return created;
}

function setMode(session: Prs1SessionAccumulator, mode: CanonicalMode) {
  session.mode = mode;
}

function parseFlexModeF0V2345(flex: number, mode: CanonicalMode): { mode?: string; level?: number } {
  const enabled = (flex & 0x80) !== 0;
  const plainFlex = (flex & 0x20) !== 0;
  const riseTime = (flex & 0x10) !== 0;
  const plusMode = (flex & 0x08) !== 0;
  const level = flex & 0x03;
  if (!enabled || level <= 0) return {};

  if (riseTime) return { mode: "Rise Time", level };
  if (plusMode) {
    if (mode === "APAP") return { mode: "A-Flex", level };
    return { mode: "C-Flex+", level };
  }
  if (plainFlex) return { mode: "Flex", level };
  if (mode === "BiPAP") return { mode: "Bi-Flex", level };
  return { mode: "C-Flex", level };
}

function parseFlexModeF0V6(modeByte: number, therapyMode: CanonicalMode | undefined): string | undefined {
  switch (modeByte) {
    case 0x80:
      return therapyMode === "BiPAP" ? "Bi-Flex" : "C-Flex";
    case 0x90:
      return therapyMode === "APAP" ? "A-Flex" : "C-Flex+";
    case 0xa0:
      return "Rise Time";
    case 0xb0:
      return "P-Flex";
    default:
      return undefined;
  }
}

function updatePressureRelief(session: Prs1SessionAccumulator, mode: string | undefined, level: number | undefined) {
  if (!mode) return;
  session.pressureReliefMode = mode;
  if (typeof level === "number" && level > 0) {
    session.pressureReliefLevel = level;
  }
}

function parseSettingsF0V23(slice: Uint8Array, session: Prs1SessionAccumulator) {
  const modeByte = slice[2];
  const minPressure = slice[3];
  const maxPressure = slice[4];
  const maxPs = slice[5];

  switch (modeByte) {
    case 0x00:
      setMode(session, "CPAP");
      session.pressure = minPressure;
      break;
    case 0x01:
      setMode(session, "BiPAP");
      session.epap = minPressure;
      session.ipap = maxPressure;
      break;
    case 0x02:
      setMode(session, "APAP");
      session.pressureMin = minPressure;
      session.pressureMax = maxPressure;
      break;
    case 0x03:
      setMode(session, "BiPAP");
      session.epapMin = minPressure;
      session.epapMax = Math.max(minPressure, maxPressure - 20);
      session.ipapMin = minPressure + 20;
      session.ipapMax = maxPressure;
      break;
    default:
      break;
  }

  if (session.mode === "BiPAP" && maxPs > 0 && session.ipapMax === undefined) {
    session.ipapMax = maxPressure;
  }

  const flex = parseFlexModeF0V2345(slice[8], session.mode ?? "CPAP");
  updatePressureRelief(session, flex.mode, flex.level);
}

function parseSettingsF0V45(slice: Uint8Array, session: Prs1SessionAccumulator) {
  const modeByte = slice[2];
  const minPressure = slice[3];
  const maxPressure = slice[4];
  const minPs = slice[5];
  const maxPs = slice[6];

  switch (modeByte) {
    case 0x00:
      setMode(session, "CPAP");
      session.pressure = minPressure;
      break;
    case 0x20:
      setMode(session, "BiPAP");
      session.epap = minPressure;
      session.ipap = maxPressure;
      break;
    case 0x40:
    case 0x80:
      setMode(session, "APAP");
      session.pressureMin = minPressure;
      session.pressureMax = maxPressure;
      break;
    case 0x60:
      setMode(session, "BiPAP");
      session.epapMin = minPressure;
      session.epapMax = maxPressure - minPs;
      session.ipapMin = minPressure + minPs;
      session.ipapMax = maxPressure;
      break;
    case 0xa0:
      setMode(session, "CPAP");
      session.pressure = minPs || maxPs;
      break;
    default:
      break;
  }

  const flex = parseFlexModeF0V2345(slice[0x0a], session.mode ?? "CPAP");
  updatePressureRelief(session, flex.mode, flex.level);
}

function parseSettingsF0V6(data: Uint8Array, size: number, session: Prs1SessionAccumulator) {
  let pos = 0;
  while (pos + 1 < size) {
    const code = data[pos++];
    const len = data[pos++];
    if (pos + len > size) break;

    switch (code) {
      case 0x00: {
        switch (data[pos]) {
          case 0:
          case 4:
            setMode(session, "CPAP");
            break;
          case 1:
          case 3:
            setMode(session, "BiPAP");
            break;
          case 2:
            setMode(session, "APAP");
            break;
          default:
            break;
        }
        break;
      }
      case 0x0a:
        session.pressure = data[pos];
        break;
      case 0x0c:
        setMode(session, "CPAP");
        session.pressure = data[pos + 2];
        session.pressureMin = data[pos];
        session.pressureMax = data[pos + 1];
        break;
      case 0x0d:
        setMode(session, "APAP");
        session.pressureMin = data[pos];
        session.pressureMax = data[pos + 1];
        break;
      case 0x0e:
        setMode(session, "BiPAP");
        session.epap = data[pos];
        session.ipap = data[pos + 1];
        break;
      case 0x0f:
        setMode(session, "BiPAP");
        session.epapMin = data[pos];
        session.ipapMax = data[pos + 1];
        session.ipapMin = data[pos] + data[pos + 2];
        session.epapMax = data[pos + 1] - data[pos + 2];
        break;
      case 0x10:
        setMode(session, "APAP");
        session.pressureMin = data[pos + 1];
        session.pressureMax = data[pos + 2];
        break;
      case 0x2e: {
        const mode = parseFlexModeF0V6(data[pos], session.mode);
        updatePressureRelief(session, mode, session.pressureReliefLevel);
        break;
      }
      case 0x30:
        if (data[pos] > 0) session.pressureReliefLevel = data[pos];
        break;
      default:
        break;
    }

    pos += len;
  }
}

function addUsageSlice(session: Prs1SessionAccumulator, currentTime: number, maskOnStartedAt: number | null): null {
  if (maskOnStartedAt === null) return null;
  if (currentTime > maskOnStartedAt) {
    session.usageSeconds += currentTime - maskOnStartedAt;
  }
  return null;
}

function parseSummaryF0V23(chunk: Prs1Chunk, session: Prs1SessionAccumulator) {
  const data = chunk.data;
  const minimumSizes = [0xf, 5, 2, 0x21, 0, 4];
  let pos = 0;
  let totalTime = 0;
  let maskOnStartedAt: number | null = null;

  while (pos < data.length) {
    const code = data[pos++];
    const size = code < minimumSizes.length ? minimumSizes[code] : 0;
    if (pos + size > data.length) break;

    switch (code) {
      case 0:
        if (pos === 1) parseSettingsF0V23(data, session);
        break;
      case 2: {
        const delta = u16(data, pos);
        totalTime += delta;
        maskOnStartedAt = totalTime;
        break;
      }
      case 3: {
        totalTime += u16(data, pos);
        maskOnStartedAt = addUsageSlice(session, totalTime, maskOnStartedAt);
        break;
      }
      case 1:
        totalTime += u16(data, pos);
        maskOnStartedAt = addUsageSlice(session, totalTime, maskOnStartedAt);
        break;
      case 5:
        break;
      default:
        break;
    }

    pos += size;
  }
}

function parseSummaryF0V4(chunk: Prs1Chunk, session: Prs1SessionAccumulator) {
  const data = chunk.data;
  const minimumSizes = [0x18, 7, 7, 0x24, 2, 4, 0, 4, 0xb];
  let pos = 0;
  let totalTime = 0;
  let maskOnStartedAt: number | null = null;

  while (pos < data.length) {
    const code = data[pos++];
    const size = code < minimumSizes.length ? minimumSizes[code] : 0;
    if (pos + size > data.length) break;

    switch (code) {
      case 0:
        if (pos === 1) parseSettingsF0V45(data, session);
        break;
      case 2:
        totalTime += u16(data, pos);
        maskOnStartedAt = totalTime;
        break;
      case 3:
        totalTime += u16(data, pos);
        maskOnStartedAt = addUsageSlice(session, totalTime, maskOnStartedAt);
        if (session.mode === "APAP") {
          if (data[pos + 7] > 0) session.pressure95th = data[pos + 7];
          if (data[pos + 8] > 0) {
            session.pressureAvgSum += data[pos + 8] / 10;
            session.pressureAvgCount += 1;
          }
        }
        if (data[pos + 0x22] > 0) {
          session.leakSum += data[pos + 0x22];
          session.leakCount += 1;
        }
        break;
      case 1:
        totalTime += u16(data, pos);
        maskOnStartedAt = addUsageSlice(session, totalTime, maskOnStartedAt);
        break;
      case 4:
      case 7:
      case 8:
        totalTime += u16(data, pos);
        break;
      default:
        break;
    }

    pos += size;
  }
}

function parseSummaryF0V5(chunk: Prs1Chunk, session: Prs1SessionAccumulator) {
  const data = chunk.data;
  const minimumSizes = [0xf, 7, 4, 0xf, 0, 4, 0, 4];
  let pos = 0;
  let totalTime = 0;
  let maskOnStartedAt: number | null = null;

  while (pos < data.length) {
    const code = data[pos++];
    const size = code < minimumSizes.length ? minimumSizes[code] : 0;
    if (pos + size > data.length) break;

    switch (code) {
      case 0:
        if (pos === 1) parseSettingsF0V45(data, session);
        break;
      case 2:
        totalTime += u16(data, pos);
        maskOnStartedAt = totalTime;
        break;
      case 3:
        totalTime += u16(data, pos);
        maskOnStartedAt = addUsageSlice(session, totalTime, maskOnStartedAt);
        if (session.mode === "APAP") {
          if (data[pos + 4] > 0) session.pressure95th = data[pos + 4];
          if (data[pos + 5] > 0) {
            session.pressureAvgSum += data[pos + 5] / 10;
            session.pressureAvgCount += 1;
          }
        }
        if (data[pos + 13] > 0) {
          session.leakSum += data[pos + 13];
          session.leakCount += 1;
        }
        if (data[pos + 14] > 0) {
          session.leakMax = session.leakMax === null ? data[pos + 14] : Math.max(session.leakMax, data[pos + 14]);
        }
        break;
      case 1:
        totalTime += u16(data, pos);
        maskOnStartedAt = addUsageSlice(session, totalTime, maskOnStartedAt);
        break;
      case 7:
        totalTime += u16(data, pos);
        break;
      default:
        break;
    }

    pos += size;
  }
}

function parseSummaryF0V6(chunk: Prs1Chunk, session: Prs1SessionAccumulator) {
  const data = chunk.data;
  let pos = 0;
  let totalTime = 0;
  let maskOnStartedAt: number | null = null;

  while (pos < data.length) {
    const code = data[pos++];
    const size = chunk.hblock.get(code);
    if (!size || pos + size > data.length) break;

    switch (code) {
      case 1:
        parseSettingsF0V6(data.subarray(pos, pos + size), size, session);
        break;
      case 3:
        totalTime += u16(data, pos);
        maskOnStartedAt = totalTime;
        break;
      case 4:
        totalTime += u16(data, pos);
        maskOnStartedAt = addUsageSlice(session, totalTime, maskOnStartedAt);
        break;
      case 2:
        totalTime += u16(data, pos);
        maskOnStartedAt = addUsageSlice(session, totalTime, maskOnStartedAt);
        break;
      case 5:
        if (session.mode === "APAP" && size >= 4) {
          if (data[pos + 2] > 0) session.pressure95th = data[pos + 2];
          if (data[pos + 3] > 0) {
            session.pressureAvgSum += data[pos + 3] / 10;
            session.pressureAvgCount += 1;
          }
        }
        break;
      case 9:
      case 10:
        totalTime += u16(data, pos);
        break;
      default:
        break;
    }

    pos += size;
  }
}

function addLeakSample(session: Prs1SessionAccumulator, leak: number | undefined) {
  if (leak === undefined || !Number.isFinite(leak) || leak < 0 || leak >= 500) return;
  session.leakSum += leak;
  session.leakCount += 1;
  session.leakMax = session.leakMax === null ? leak : Math.max(session.leakMax, leak);
}

function parseEventsF0V23(chunk: Prs1Chunk, session: Prs1SessionAccumulator) {
  const data = chunk.data;
  const eventSizes = new Map<number, number>([
    [1, 2],
    [3, 4],
    [0x0b, 4],
    [0x0d, 2],
    [0x0e, 5],
    [0x0f, 5],
    [0x10, 5],
    [0x11, 4],
    [0x12, 4]
  ]);

  let pos = 0;
  let elapsedTotal = 0;
  while (pos < data.length) {
    const code = data[pos++];
    const size = eventSizes.get(code) ?? 3;
    if (pos + size > data.length) break;
    const start = pos;
    if (code !== 0x12 && code !== 0x01) {
      elapsedTotal += u16(data, pos);
      pos += 2;
    }

    switch (code) {
      case 0x05:
        session.reraCount += 1;
        break;
      case 0x06:
        session.obstructiveApneaCount += 1;
        break;
      case 0x07:
        session.centralApneaCount += 1;
        break;
      case 0x0a:
      case 0x0b:
        session.hypopneaCount += 1;
        break;
      case 0x11:
        addLeakSample(session, data[pos]);
        if (data[pos + 2] > 0) {
          session.pressureAvgSum += data[pos + 2] / 10;
          session.pressureAvgCount += 1;
        }
        break;
      default:
        break;
    }

    pos = start + size;
  }
}

function parseEventsF0V4(chunk: Prs1Chunk, session: Prs1SessionAccumulator) {
  const data = chunk.data;
  const eventSizes = new Map<number, number>([
    [0, 4],
    [2, 4],
    [3, 3],
    [0x0b, 4],
    [0x0d, 2],
    [0x0e, 5],
    [0x0f, 5],
    [0x10, 5],
    [0x11, 5],
    [0x12, 4]
  ]);

  let pos = 0;
  while (pos < data.length) {
    const code = data[pos++];
    const size = eventSizes.get(code) ?? 3;
    if (pos + size > data.length) break;
    const start = pos;
    if (code !== 0x12) {
      pos += 2;
    }

    switch (code) {
      case 0x05:
        session.reraCount += 1;
        break;
      case 0x06:
        session.obstructiveApneaCount += 1;
        break;
      case 0x07:
        session.centralApneaCount += 1;
        break;
      case 0x0a:
      case 0x0b:
        session.hypopneaCount += 1;
        break;
      case 0x11:
        addLeakSample(session, data[pos]);
        if (data[pos + 2] > 0) {
          session.pressureAvgSum += data[pos + 2] / 10;
          session.pressureAvgCount += 1;
        }
        break;
      default:
        break;
    }

    pos = start + size;
  }
}

function parseEventsF0V6(chunk: Prs1Chunk, session: Prs1SessionAccumulator) {
  const data = chunk.data;
  let pos = 0;
  while (pos < data.length) {
    const code = data[pos++];
    const size = chunk.hblock.get(code);
    if (!size || pos + size > data.length) break;
    const start = pos;
    if (code !== 0x12) {
      pos += 2;
    }

    switch (code) {
      case 0x05:
        session.reraCount += 1;
        break;
      case 0x06:
        session.obstructiveApneaCount += 1;
        break;
      case 0x07:
        session.centralApneaCount += 1;
        break;
      case 0x0b:
        session.hypopneaCount += 1;
        break;
      case 0x11:
        addLeakSample(session, data[pos]);
        if (data[pos + 2] > 0) {
          session.pressureAvgSum += data[pos + 2] / 10;
          session.pressureAvgCount += 1;
        }
        break;
      default:
        break;
    }

    pos = start + size;
  }
}

function parseSummaryOrComplianceChunk(chunk: Prs1Chunk, session: Prs1SessionAccumulator) {
  if (chunk.family !== 0 || chunk.htype !== 0) return;
  const dedupeKey = `${chunk.ext}:${chunk.timestamp}:${chunk.data.length}`;
  if (session.seenSummaryKeys.has(dedupeKey)) return;
  session.seenSummaryKeys.add(dedupeKey);

  switch (chunk.familyVersion) {
    case 2:
    case 3:
      parseSummaryF0V23(chunk, session);
      break;
    case 4:
      parseSummaryF0V4(chunk, session);
      break;
    case 5:
      parseSummaryF0V5(chunk, session);
      break;
    case 6:
      parseSummaryF0V6(chunk, session);
      break;
    default:
      break;
  }
}

function parseEventChunk(chunk: Prs1Chunk, session: Prs1SessionAccumulator) {
  if (chunk.family !== 0 || chunk.ext !== 2) return;
  const dedupeKey = `${chunk.ext}:${chunk.timestamp}:${chunk.data.length}`;
  if (session.seenEventKeys.has(dedupeKey)) return;
  session.seenEventKeys.add(dedupeKey);

  switch (chunk.familyVersion) {
    case 2:
    case 3:
      parseEventsF0V23(chunk, session);
      break;
    case 4:
      parseEventsF0V4(chunk, session);
      break;
    case 6:
      parseEventsF0V6(chunk, session);
      break;
    default:
      break;
  }
}

function parsePrs1Chunks(bytes: Uint8Array, normalizedPath: string): Prs1Chunk[] {
  const chunks: Prs1Chunk[] = [];
  let offset = 0;

  while (offset + 16 <= bytes.length) {
    const fileVersion = bytes[offset];
    if (fileVersion < 2 || fileVersion > 3) break;

    const blockSize = u16(bytes, offset + 1);
    const htype = bytes[offset + 3];
    if (blockSize <= 0 || htype > 1 || offset + blockSize > bytes.length) break;

    const family = bytes[offset + 4];
    const familyVersion = bytes[offset + 5];
    const ext = bytes[offset + 6];
    const sessionId = u32(bytes, offset + 7);
    const timestamp = u32(bytes, offset + 11);

    let headerLength = 15;
    const hblock = new Map<number, number>();

    if (htype !== 1) {
      if (fileVersion === 3) {
        if (offset + headerLength + 1 > bytes.length) break;
        const hdbLen = bytes[offset + headerLength];
        headerLength += 1;
        const hblockBytes = hdbLen * 2;
        if (offset + headerLength + hblockBytes > bytes.length) break;
        for (let pos = 0; pos < hblockBytes; pos += 2) {
          hblock.set(bytes[offset + headerLength + pos], bytes[offset + headerLength + pos + 1]);
        }
        headerLength += hblockBytes;
      }
    } else {
      break;
    }

    headerLength += 1;
    const crcLength = fileVersion === 3 ? 4 : 2;
    const payloadLength = blockSize - headerLength;
    if (payloadLength <= crcLength) break;

    const dataStart = offset + headerLength;
    const dataEnd = offset + blockSize - crcLength;
    if (dataEnd > bytes.length || dataStart >= dataEnd) break;

    chunks.push({
      normalizedPath,
      fileVersion,
      htype,
      family,
      familyVersion,
      ext,
      sessionId,
      timestamp,
      hblock,
      data: bytes.subarray(dataStart, dataEnd)
    });

    offset += blockSize;
  }

  return chunks;
}

function inferPrs1MachineSettings(text: string, machine: QuickReportMetrics["machine"], deps: FamilyParserDeps) {
  const kv = deps.parseKeyValueLines(text);
  const modelRaw = readCaseInsensitive(kv, ["ModelNumber", "Model", "modelnumber", "model", "MN"]);
  const serialRaw = readCaseInsensitive(kv, ["SerialNumber", "serialnumber", "serial", "SN"]);
  const modeRaw = readCaseInsensitive(kv, ["Mode", "therapy mode", "CPAPMode", "PM"]);
  const flexModeRaw = readCaseInsensitive(kv, ["FlexMode", "Flex", "flexmode", "flex", "A-Flex", "C-Flex", "P-Flex", "Bi-Flex", "Rise Time", "FM"]);
  const flexLevelRaw = readCaseInsensitive(kv, ["FlexLevel", "FlexSet", "flexlevel", "flexset", "Flex Level", "RiseTime", "FL"]);

  if (!machine.mode && modeRaw) {
    const normalized = modeRaw.trim();
    if (/\b(?:auto cpap|apap|auto)\b/i.test(normalized)) machine.mode = "APAP";
    else if (/\b(?:bipap|bilevel|asv|avaps|st)\b/i.test(normalized)) machine.mode = "BiPAP";
    else if (/\bcpap\b/i.test(normalized)) machine.mode = "CPAP";
  }

  const model = modelRaw?.trim().toUpperCase();
  if (model && model !== "100X100") {
    const exact = PRS1_EXACT_MODELS.get(model);
    if (!machine.device) {
      if (exact?.label && serialRaw?.trim()) machine.device = `${exact.label} (${serialRaw.trim()})`;
      else machine.device = exact?.label ?? `Philips Respironics ${model}`;
    }
    if (!machine.mode) {
      const inferredMode = exact?.mode ?? inferModeFromModel(model);
      if (inferredMode) machine.mode = inferredMode;
    }
  } else if (!machine.device && serialRaw?.trim()) {
    machine.device = `Philips Respironics (${serialRaw.trim()})`;
  }

  if (!machine.pressureRelief) {
    const namedFlex = text.match(/\b((?:A|C|P|Bi)-Flex\+?|Rise Time|Flex)\b/i)?.[1];
    const flexMode = normalizeWhitespace(flexModeRaw ?? namedFlex ?? "");
    const flexLevel = flexLevelRaw?.trim();
    if (flexMode && flexLevel && /^\d+$/.test(flexLevel)) {
      machine.pressureRelief = `${flexMode}: ${flexLevel}`;
    } else if (flexMode) {
      machine.pressureRelief = flexMode;
    }
  }
}

function applySessionSettingsToMachine(session: Prs1SessionAccumulator, machine: QuickReportMetrics["machine"]) {
  if (session.mode) machine.mode = session.mode;

  if (session.mode === "CPAP") {
    machine.pressureIsAuto = false;
    machine.pressure = formatPressure(session.pressure);
    machine.pressureMin = undefined;
    machine.pressureMax = undefined;
    machine.epap = undefined;
    machine.ipap = undefined;
    machine.respiratoryRate = undefined;
  } else if (session.mode === "APAP") {
    machine.pressureIsAuto = true;
    machine.pressure = undefined;
    machine.pressureMin = formatPressure(session.pressureMin);
    machine.pressureMax = formatPressure(session.pressureMax);
    machine.epap = undefined;
    machine.ipap = undefined;
    machine.respiratoryRate = undefined;
  } else if (session.mode === "BiPAP") {
    machine.pressureIsAuto = false;
    machine.pressure = undefined;
    machine.pressureMin = undefined;
    machine.pressureMax = undefined;
    machine.epap = formatPressure(session.epap) ?? formatPressureRange(session.epapMin, session.epapMax);
    machine.ipap = formatPressure(session.ipap) ?? formatPressureRange(session.ipapMin, session.ipapMax);
  }

  if (session.pressureAvgCount > 0) {
    machine.pressureAvg = session.pressureAvgSum / session.pressureAvgCount;
  }
  if (session.pressure95th !== undefined) {
    machine.pressure95th = session.pressure95th / 10;
  }
  if (session.pressureReliefMode) {
    machine.pressureRelief =
      typeof session.pressureReliefLevel === "number"
        ? `${session.pressureReliefMode}: ${session.pressureReliefLevel}`
        : session.pressureReliefMode;
  } else if (!machine.pressureRelief) {
    machine.pressureRelief = "Flex: Off";
  }
}

function toParsedRecord(session: Prs1SessionAccumulator): ParsedRecord | null {
  const date = asDateFromUnix(session.timestamp);
  if (!date) return null;

  const usageHours = session.usageSeconds > 0 ? session.usageSeconds / 3600 : undefined;
  const obstructiveLikeCount = session.obstructiveApneaCount + session.hypopneaCount;
  const totalAhiCount = obstructiveLikeCount + session.centralApneaCount;

  const ahi = usageHours && usageHours > 0 ? totalAhiCount / usageHours : undefined;
  const residualApneas = usageHours && usageHours > 0 ? obstructiveLikeCount / usageHours : undefined;
  const centralApneas = usageHours && usageHours > 0 ? session.centralApneaCount / usageHours : undefined;
  const reraIndex = usageHours && usageHours > 0 ? session.reraCount / usageHours : undefined;
  const leak = session.leakCount > 0 ? session.leakSum / session.leakCount : undefined;
  const pressureAvg = session.pressureAvgCount > 0 ? session.pressureAvgSum / session.pressureAvgCount : undefined;
  const pressure95th = session.pressure95th !== undefined ? session.pressure95th / 10 : undefined;

  const hasSignal =
    usageHours !== undefined ||
    ahi !== undefined ||
    residualApneas !== undefined ||
    centralApneas !== undefined ||
    reraIndex !== undefined ||
    leak !== undefined ||
    session.leakMax !== null ||
    pressureAvg !== undefined ||
    pressure95th !== undefined;
  if (!hasSignal) return null;

  return {
    date,
    usageHours,
    ahi,
    residualApneas,
    centralApneas,
    reraIndex,
    leak,
    leakMax: session.leakMax ?? undefined,
    pressureAvg,
    pressure95th
  };
}

async function parsePrs1BinaryCandidates(context: FamilyParserContext, deps: FamilyParserDeps) {
  const binaryCandidates = context.candidates.filter(isPrs1BinaryCandidate);
  const sessions = new Map<number, Prs1SessionAccumulator>();
  const wrappedKeyCache = new Map<string, Uint8Array | null>();

  let processed = 0;
  for (const candidate of binaryCandidates) {
    processed += 1;
    const pct =
      context.progressStart +
      Math.round((processed / Math.max(1, binaryCandidates.length)) * (context.progressEnd - context.progressStart));

    deps.emit(context.onProgress, {
      phase: "parse",
      detail: `Reading ${candidate.normalizedPath}`,
      percent: Math.min(context.progressEnd, pct)
    });

    try {
      let bytes = await candidate.file.readBytes();
      const ext = normalizePrs1BinaryExtension(candidate.normalizedPath);
      if (ext.startsWith("b")) {
        const decrypted = await decryptPrs1WrappedBytes(bytes, wrappedKeyCache);
        if (!decrypted) continue;
        bytes = decrypted;
      }
      const chunks = parsePrs1Chunks(bytes, candidate.normalizedPath);
      for (const chunk of chunks) {
        const session = getOrCreateSession(sessions, chunk.sessionId, chunk.timestamp);
        if (chunk.ext === 0 || chunk.ext === 1) {
          parseSummaryOrComplianceChunk(chunk, session);
        } else if (chunk.ext === 2) {
          parseEventChunk(chunk, session);
        }
      }
    } catch {
      continue;
    }

    if (processed % 10 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const orderedSessions = [...sessions.values()].sort((a, b) => a.timestamp - b.timestamp);
  const latestSettingsSession = orderedSessions.filter((session) => session.mode || session.pressure || session.pressureMin || session.epap || session.ipap).at(-1);
  if (latestSettingsSession) {
    applySessionSettingsToMachine(latestSettingsSession, context.machine);
  }

  for (const session of orderedSessions) {
    const record = toParsedRecord(session);
    if (record) context.records.push(record);
  }
}

export async function parsePrs1Family(context: FamilyParserContext, deps: FamilyParserDeps): Promise<void> {
  const selectedMachineRootId = await selectPrs1MachineRootId(context.candidates);
  const scopedCandidates =
    selectedMachineRootId === null
      ? context.candidates
      : context.candidates.filter(
          (candidate) => isWithinPrs1MachineRoot(candidate.normalizedPath, selectedMachineRootId) || isPrs1LastCandidate(candidate)
        );

  const scopedContext: FamilyParserContext = {
    ...context,
    candidates: scopedCandidates
  };

  await parsePrs1BinaryCandidates(scopedContext, deps);

  const textCandidates = scopedCandidates.filter(isPrs1TextCandidate);
  if (textCandidates.length > 0) {
    await runTextFamilyParser(
      {
        ...scopedContext,
        candidates: textCandidates
      },
      deps,
      {
        inferFamilyMachineSettings: (text, _candidate, machine, familyDeps) => {
          inferPrs1MachineSettings(text, machine, familyDeps);
        }
      }
    );
  }

  if (!context.machine.device && selectedMachineRootId) {
    context.machine.device = `Philips Respironics (${selectedMachineRootId})`;
  }
}
