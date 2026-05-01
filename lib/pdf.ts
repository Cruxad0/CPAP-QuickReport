import {
  classifyReportTherapyLayout,
  classifyTherapyMode,
  isAutoBiPapLikeMode,
  isAutoPapLikeMode,
  isFixedCpapLikeMode
} from "@/lib/machine-mode";
import { QuickReportMetrics } from "@/lib/types";

const PAGE_WIDTH_A4 = 595.28;
const PAGE_HEIGHT_A4 = 841.89;
const PAGE_MARGIN = 18; // 0.25 in
const NO_DATA_FALLBACK = "Data point not available";
const EVENT_DATA_NOT_PRESENT = "Data is not present";
const BRANDING_HEADER_TARGET_WIDTH_RATIO = 0.95;
const BRANDING_LOGO_TARGET_WIDTH_RATIO = 0.15;
const BRANDING_HEADER_MIN_ASPECT_RATIO = 4;
const BRANDING_HEADER_MAX_HEIGHT = 90;
const BRANDING_LOGO_MAX_HEIGHT = 72;
const FOOTER_BLOCK_HEIGHT = 64;
const CPAP_THERAPY_MIN_FONT_SIZE = 8;
const THERAPY_MIN_FONT_SIZE = 10;
const THERAPY_MAX_FONT_SIZE = 12;
const REPORT_METRIC_DECIMALS = 1;
const PRESSURE_SETTING_WARNING_TOLERANCE = 0.1;

type PdfLibModule = {
  PDFDocument: {
    create: () => Promise<any>;
  };
  StandardFonts: {
    Helvetica: string;
    HelveticaBold: string;
  };
  rgb: (r: number, g: number, b: number) => any;
};

type ThemeColor = {
  r: number;
  g: number;
  b: number;
};

type PdfTheme = {
  primary: ThemeColor;
  primaryAccent: ThemeColor;
  heading: ThemeColor;
  body: ThemeColor;
  muted: ThemeColor;
  border: ThemeColor;
  rowAlt: ThemeColor;
  rowBase: ThemeColor;
  danger: ThemeColor;
  onPrimary: ThemeColor;
};

function themeColor(r: number, g: number, b: number): ThemeColor {
  return { r, g, b };
}

const DEFAULT_PDF_THEME: PdfTheme = {
  primary: themeColor(0.05, 0.43, 0.57),
  primaryAccent: themeColor(0.06, 0.46, 0.6),
  heading: themeColor(0.07, 0.31, 0.49),
  body: themeColor(0.1, 0.15, 0.2),
  muted: themeColor(0.12, 0.22, 0.31),
  border: themeColor(0.82, 0.88, 0.93),
  rowAlt: themeColor(0.965, 0.98, 0.99),
  rowBase: themeColor(1, 1, 1),
  danger: themeColor(0.73, 0.12, 0.12),
  onPrimary: themeColor(1, 1, 1)
};

function pdfColor(rgbFn: PdfLibModule["rgb"], color: ThemeColor) {
  return rgbFn(color.r, color.g, color.b);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function mixThemeColor(a: ThemeColor, b: ThemeColor, ratio: number): ThemeColor {
  const t = clamp01(ratio);
  return themeColor(a.r * (1 - t) + b.r * t, a.g * (1 - t) + b.g * t, a.b * (1 - t) + b.b * t);
}

function rgbToHsl(color: ThemeColor): { h: number; s: number; l: number } {
  const { r, g, b } = color;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  switch (max) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0);
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    default:
      h = (r - g) / d + 4;
      break;
  }
  h /= 6;
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): ThemeColor {
  if (s === 0) return themeColor(l, l, l);

  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return themeColor(hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3));
}

function quantizeChannel(value: number): number {
  const bucket = 24;
  return Math.min(255, Math.round(value / bucket) * bucket);
}

async function extractDominantThemeColor(headerDataUrl: string | undefined): Promise<ThemeColor | null> {
  const parsed = parseImageDataUrl(headerDataUrl);
  if (!parsed) return null;

  const pickFromPixelData = (data: Uint8ClampedArray | Uint8Array): ThemeColor | null => {
    const colorCounts = new Map<string, { count: number; color: ThemeColor }>();
    let fallbackSum = themeColor(0, 0, 0);
    let fallbackCount = 0;

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3] / 255;
      if (alpha < 0.6) continue;

      const color = themeColor(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
      const { s, l } = rgbToHsl(color);
      if ((l > 0.96 && s < 0.08) || (l < 0.04 && s < 0.08)) continue;

      const qr = quantizeChannel(data[i]);
      const qg = quantizeChannel(data[i + 1]);
      const qb = quantizeChannel(data[i + 2]);
      const key = `${qr},${qg},${qb}`;
      const existing = colorCounts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        colorCounts.set(key, {
          count: 1,
          color: themeColor(qr / 255, qg / 255, qb / 255)
        });
      }

      fallbackSum = themeColor(fallbackSum.r + color.r, fallbackSum.g + color.g, fallbackSum.b + color.b);
      fallbackCount += 1;
    }

    if (colorCounts.size > 0) {
      let best: { count: number; color: ThemeColor } | null = null;
      for (const value of colorCounts.values()) {
        if (!best || value.count > best.count) best = value;
      }
      return best?.color ?? null;
    }

    if (fallbackCount > 0) {
      return themeColor(fallbackSum.r / fallbackCount, fallbackSum.g / fallbackCount, fallbackSum.b / fallbackCount);
    }

    return null;
  };

  if (typeof createImageBitmap === "function" && typeof OffscreenCanvas !== "undefined") {
    try {
      const bitmapBuffer = parsed.bytes.buffer.slice(
        parsed.bytes.byteOffset,
        parsed.bytes.byteOffset + parsed.bytes.byteLength
      ) as ArrayBuffer;
      const bitmap = await createImageBitmap(new Blob([bitmapBuffer], { type: parsed.mime }));
      const maxDimension = 64;
      const scale = Math.min(1, maxDimension / Math.max(bitmap.width || 1, bitmap.height || 1));
      const width = Math.max(1, Math.round((bitmap.width || 1) * scale));
      const height = Math.max(1, Math.round((bitmap.height || 1) * scale));
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true } as any);
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, width, height);
        const color = pickFromPixelData(ctx.getImageData(0, 0, width, height).data);
        bitmap.close?.();
        return color;
      }
      bitmap.close?.();
    } catch {
      // Fall through to DOM path.
    }
  }

  if (typeof Image === "undefined" || typeof document === "undefined") return null;

  return await new Promise<ThemeColor | null>((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const maxDimension = 64;
        const scale = Math.min(1, maxDimension / Math.max(image.width || 1, image.height || 1));
        const width = Math.max(1, Math.round((image.width || 1) * scale));
        const height = Math.max(1, Math.round((image.height || 1) * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          resolve(null);
          return;
        }

        ctx.drawImage(image, 0, 0, width, height);
        resolve(pickFromPixelData(ctx.getImageData(0, 0, width, height).data));
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = headerDataUrl!;
  });
}

function buildPdfThemeFromColor(baseColor: ThemeColor | null): PdfTheme {
  if (!baseColor) return DEFAULT_PDF_THEME;

  const hsl = rgbToHsl(baseColor);
  const isNeutral = hsl.s < 0.08;

  const primary = isNeutral
    ? themeColor(clamp01(hsl.l * 0.55), clamp01(hsl.l * 0.55), clamp01(hsl.l * 0.58))
    : hslToRgb(hsl.h, clamp01(Math.max(0.25, Math.min(0.72, hsl.s))), clamp01(Math.max(0.28, Math.min(0.42, hsl.l))));

  const primaryAccent = isNeutral
    ? mixThemeColor(primary, themeColor(1, 1, 1), 0.12)
    : hslToRgb(hsl.h, clamp01(Math.max(0.22, Math.min(0.68, hsl.s * 0.95))), clamp01(Math.max(0.38, Math.min(0.54, hsl.l + 0.08))));

  const heading = mixThemeColor(primary, themeColor(0.04, 0.06, 0.1), 0.28);
  const body = mixThemeColor(primary, themeColor(0.07, 0.1, 0.14), 0.8);
  const muted = mixThemeColor(primary, themeColor(0.16, 0.2, 0.26), 0.72);
  const border = mixThemeColor(primary, themeColor(1, 1, 1), 0.78);
  const rowAlt = mixThemeColor(primary, themeColor(1, 1, 1), 0.93);
  const onPrimary = rgbToHsl(primary).l > 0.6 ? themeColor(0.1, 0.15, 0.2) : themeColor(1, 1, 1);

  return {
    primary,
    primaryAccent,
    heading,
    body,
    muted,
    border,
    rowAlt,
    rowBase: themeColor(1, 1, 1),
    danger: DEFAULT_PDF_THEME.danger,
    onPrimary
  };
}

async function resolvePdfTheme(headerDataUrl: string | undefined): Promise<PdfTheme> {
  const dominantColor = await extractDominantThemeColor(headerDataUrl);
  return buildPdfThemeFromColor(dominantColor);
}

function initialsFromName(name: string): string {
  const tokens = name.split(/\s+/).map((x) => x.trim()).filter(Boolean);
  const initials = tokens.map((x) => x[0]?.toUpperCase() ?? "").join("");
  return initials || "PT";
}

function filenameDateStamp(date = new Date()): string {
  const mm = `${date.getMonth() + 1}`.padStart(2, "0");
  const dd = `${date.getDate()}`.padStart(2, "0");
  const yyyy = `${date.getFullYear()}`;
  return `${mm}${dd}${yyyy}`;
}

export function formatReportMetricValue(value: number | null | undefined, digits = REPORT_METRIC_DECIMALS): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : NO_DATA_FALLBACK;
}

export function shouldDisplayRespiratoryRate(machine: QuickReportMetrics["machine"]): boolean {
  return typeof machine.respiratoryRate === "string" && machine.respiratoryRate.trim().length > 0;
}

function isAhiAboveThreshold(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 5;
}

function isBelowMedicareComplianceThreshold(report: QuickReportMetrics): boolean {
  return Number.isFinite(report.compliancePercent) && report.compliancePercent < 70;
}

function isBelowMedicareNightlyUseThreshold(report: QuickReportMetrics): boolean {
  return typeof report.avgUsageHours === "number" && Number.isFinite(report.avgUsageHours) && report.avgUsageHours < 4;
}

function textValue(value: string | null | undefined): string {
  const text = value?.trim();
  if (!text) return NO_DATA_FALLBACK;
  if (/^not detected from input files$/i.test(text)) return NO_DATA_FALLBACK;
  return text;
}

function splitLines(text: string, font: any, fontSize: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = words[0];

  for (let i = 1; i < words.length; i += 1) {
    const candidate = `${current} ${words[i]}`;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function parseImageDataUrl(headerDataUrl: string | undefined): { mime: string; bytes: Uint8Array } | null {
  if (!headerDataUrl) return null;
  const match = headerDataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mime: match[1].toLowerCase(),
    bytes: decodeBase64(match[2])
  };
}

function buildFontSizes(maxFontSize: number, minFontSize: number): number[] {
  const sizes: number[] = [];
  for (let size = maxFontSize; size >= minFontSize; size -= 0.5) {
    sizes.push(Number(size.toFixed(1)));
  }
  return sizes;
}
const CPAP_THERAPY_FONT_SIZES = buildFontSizes(THERAPY_MAX_FONT_SIZE, CPAP_THERAPY_MIN_FONT_SIZE);

async function tryEmbedHeaderImage(pdfDoc: any, headerDataUrl: string | undefined): Promise<any | undefined> {
  const parsed = parseImageDataUrl(headerDataUrl);
  if (!parsed) return undefined;
  const { mime, bytes } = parsed;

  if (mime === "image/png") return await pdfDoc.embedPng(bytes);
  if (mime === "image/jpeg" || mime === "image/jpg") return await pdfDoc.embedJpg(bytes);
  return undefined;
}

type PdfState = {
  page: any;
  y: number;
  pageWidth: number;
  pageHeight: number;
};

type BrandingImagePlacement = {
  kind: "header" | "logo";
  x: number;
  width: number;
  height: number;
  afterGap: number;
};

function headerModeText(mode: string | undefined): string {
  const normalized = mode?.trim();
  return normalized && normalized.length > 0 ? normalized : "CPAP";
}

function measureBrandingImagePlacement(state: PdfState, headerImage: any): BrandingImagePlacement {
  const contentWidth = state.pageWidth - PAGE_MARGIN * 2;
  const imageWidth = typeof headerImage?.width === "number" ? headerImage.width : 0;
  const imageHeight = typeof headerImage?.height === "number" ? headerImage.height : 0;
  const aspectRatio = imageWidth > 0 && imageHeight > 0 ? imageWidth / imageHeight : BRANDING_HEADER_MIN_ASPECT_RATIO;
  const isHeader = aspectRatio >= BRANDING_HEADER_MIN_ASPECT_RATIO;

  let width = contentWidth * (isHeader ? BRANDING_HEADER_TARGET_WIDTH_RATIO : BRANDING_LOGO_TARGET_WIDTH_RATIO);
  let height = width / Math.max(0.0001, aspectRatio);
  const maxHeight = isHeader ? BRANDING_HEADER_MAX_HEIGHT : BRANDING_LOGO_MAX_HEIGHT;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspectRatio;
  }

  const x = isHeader ? PAGE_MARGIN + (contentWidth - width) / 2 : PAGE_MARGIN;
  return {
    kind: isHeader ? "header" : "logo",
    x,
    width,
    height,
    afterGap: isHeader ? 8 : 6
  };
}

function drawDefaultHeader(
  state: PdfState,
  reportDays: number,
  reportMode: string | undefined,
  fontBold: any,
  rgbFn: PdfLibModule["rgb"],
  theme: PdfTheme
) {
  state.page.drawText(`${headerModeText(reportMode)} ${reportDays}-Day Quick Report`, {
    x: PAGE_MARGIN,
    y: state.y - 16,
    size: 11,
    font: fontBold,
    color: pdfColor(rgbFn, theme.heading)
  });
  state.y -= 18;
  state.page.drawLine({
    start: { x: PAGE_MARGIN, y: state.y },
    end: { x: state.pageWidth - PAGE_MARGIN, y: state.y },
    color: pdfColor(rgbFn, theme.primaryAccent),
    thickness: 1.1
  });
  state.y -= 10;
}

function drawHeader(
  state: PdfState,
  reportDays: number,
  reportMode: string | undefined,
  headerImage: any | undefined,
  fontBold: any,
  rgbFn: PdfLibModule["rgb"],
  theme: PdfTheme
) {
  if (headerImage) {
    const placement = measureBrandingImagePlacement(state, headerImage);
    state.page.drawImage(headerImage, {
      x: placement.x,
      y: state.y - placement.height,
      width: placement.width,
      height: placement.height
    });
    state.y -= placement.height + placement.afterGap;
  }
  drawDefaultHeader(state, reportDays, reportMode, fontBold, rgbFn, theme);
}

function ensureSpace(
  pdfDoc: any,
  state: PdfState,
  neededHeight: number,
  reportDays: number,
  reportMode: string | undefined,
  headerImage: any | undefined,
  fontBold: any,
  rgbFn: PdfLibModule["rgb"],
  theme: PdfTheme
) {
  if (state.y - neededHeight >= PAGE_MARGIN) return;
  state.page = pdfDoc.addPage([PAGE_WIDTH_A4, PAGE_HEIGHT_A4]);
  state.pageWidth = state.page.getWidth();
  state.pageHeight = state.page.getHeight();
  state.y = state.pageHeight - PAGE_MARGIN;
  drawHeader(state, reportDays, reportMode, headerImage, fontBold, rgbFn, theme);
}

function startNewPage(
  pdfDoc: any,
  state: PdfState,
  reportDays: number,
  reportMode: string | undefined,
  headerImage: any | undefined,
  fontBold: any,
  rgbFn: PdfLibModule["rgb"],
  theme: PdfTheme
) {
  state.page = pdfDoc.addPage([PAGE_WIDTH_A4, PAGE_HEIGHT_A4]);
  state.pageWidth = state.page.getWidth();
  state.pageHeight = state.page.getHeight();
  state.y = state.pageHeight - PAGE_MARGIN;
  drawHeader(state, reportDays, reportMode, headerImage, fontBold, rgbFn, theme);
}

function drawSectionTitle(
  pdfDoc: any,
  state: PdfState,
  title: string,
  reportDays: number,
  reportMode: string | undefined,
  headerImage: any | undefined,
  fontBold: any,
  rgbFn: PdfLibModule["rgb"],
  theme: PdfTheme
) {
  ensureSpace(pdfDoc, state, 30, reportDays, reportMode, headerImage, fontBold, rgbFn, theme);
  state.page.drawText(title, {
    x: PAGE_MARGIN,
    y: state.y - 12,
    size: 11,
    font: fontBold,
    color: pdfColor(rgbFn, theme.heading)
  });
  state.y -= 16;
}

function drawBottomFooterBlock(
  pdfDoc: any,
  state: PdfState,
  report: QuickReportMetrics,
  headerImage: any | undefined,
  fontRegular: any,
  fontBold: any,
  rgbFn: PdfLibModule["rgb"],
  theme: PdfTheme
) {
  const baseY = PAGE_MARGIN + 4;
  const physicianY = baseY + 42;
  const signatureY = baseY + 22;
  const generatedY = baseY + 4;

  const physicianNameText = report.physicianName?.trim() ?? "";
  state.page.drawText(`Physician:${physicianNameText ? ` ${physicianNameText}` : ""}`, {
    x: PAGE_MARGIN,
    y: physicianY,
    size: 10,
    font: fontBold,
    color: pdfColor(rgbFn, theme.muted)
  });

  state.page.drawText("Signature:", {
    x: PAGE_MARGIN,
    y: signatureY,
    size: 10,
    font: fontBold,
    color: pdfColor(rgbFn, theme.muted)
  });
  state.page.drawLine({
    start: { x: PAGE_MARGIN + 74, y: signatureY + 1 },
    end: { x: state.pageWidth - PAGE_MARGIN, y: signatureY + 1 },
    color: pdfColor(rgbFn, mixThemeColor(theme.muted, theme.rowBase, 0.45)),
    thickness: 0.9
  });

  state.page.drawText(`Generated: ${report.generatedAtDisplay}`, {
    x: PAGE_MARGIN,
    y: generatedY,
    size: 10,
    font: fontRegular,
    color: pdfColor(rgbFn, theme.muted)
  });
}

type TableDataRow = [string, string, boolean?];
type TableGroupRow = { kind: "group"; label: string };
type TableRow = TableDataRow | TableGroupRow;
type CompactTableStyle = {
  titleSize: number;
  titleGap: number;
  headerHeight: number;
  headerFontSize: number;
  bodyFontSize: number;
  lineHeight: number;
  insetX: number;
  insetY: number;
  leftRatio: number;
  afterGap: number;
};

const TABLE_STYLE_CANDIDATES: CompactTableStyle[] = [
  {
    titleSize: 11,
    titleGap: 4,
    headerHeight: 17,
    headerFontSize: 10,
    bodyFontSize: 10,
    lineHeight: 11,
    insetX: 6,
    insetY: 3.5,
    leftRatio: 0.41,
    afterGap: 6
  },
  {
    titleSize: 11,
    titleGap: 3.5,
    headerHeight: 16.5,
    headerFontSize: 10,
    bodyFontSize: 10,
    lineHeight: 10.8,
    insetX: 5.5,
    insetY: 3.25,
    leftRatio: 0.4,
    afterGap: 5.5
  },
  {
    titleSize: 11,
    titleGap: 3,
    headerHeight: 16,
    headerFontSize: 10,
    bodyFontSize: 10,
    lineHeight: 10.5,
    insetX: 5,
    insetY: 3,
    leftRatio: 0.4,
    afterGap: 5
  }
];

function therapyTableStyle(fontSize: number, minFontSize = THERAPY_MIN_FONT_SIZE): CompactTableStyle {
  const clampedFontSize = Math.max(minFontSize, Math.min(THERAPY_MAX_FONT_SIZE, fontSize));
  const compact = clampedFontSize < THERAPY_MIN_FONT_SIZE;
  return {
    titleSize: compact ? 10.5 : 11,
    titleGap: compact ? 2.5 : 3.5,
    headerHeight: Math.max(compact ? 14.5 : 17.5, clampedFontSize + (compact ? 5 : 7)),
    headerFontSize: compact ? 9 : 10,
    bodyFontSize: clampedFontSize,
    lineHeight: Math.max(compact ? 9.4 : 12.4, clampedFontSize + (compact ? 1.2 : 2)),
    insetX: compact ? 4.5 : 6,
    insetY: compact ? 2 : clampedFontSize >= 11.5 ? 5.2 : 4.5,
    leftRatio: 0.41,
    afterGap: compact ? 3 : 5
  };
}

function hasAutoPressureRange(report: QuickReportMetrics): boolean {
  return (
    report.machine.pressureIsAuto === true ||
    Boolean(report.machine.pressureMin) ||
    Boolean(report.machine.pressureMax) ||
    (typeof report.machine.pressure === "string" && /\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?/.test(report.machine.pressure))
  );
}

function normalizePressureDisplay(raw: string | null | undefined): string {
  const text = raw?.trim();
  if (!text) return NO_DATA_FALLBACK;
  if (/^not detected from input files$/i.test(text)) return NO_DATA_FALLBACK;

  const values = [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number.parseFloat(match[0])).filter(Number.isFinite);
  if (values.length === 0) return text;
  if (values.length >= 2 && /\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?/.test(text)) {
    return `${values[0].toFixed(1)}-${values[1].toFixed(1)} cmH2O`;
  }
  return `${values[0].toFixed(1)} cmH2O`;
}

function pressureMetricText(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)} cmH2O` : NO_DATA_FALLBACK;
}

function pressureSettingText(value: string | null | undefined): string {
  return normalizePressureDisplay(value);
}

function numericSettingValue(raw: string | null | undefined): number | null {
  const text = raw?.trim();
  if (!text) return null;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number.parseFloat(match[0]);
  return Number.isFinite(value) ? value : null;
}

function numericTidalVolumeSettingLiters(raw: string | null | undefined): number | null {
  const text = raw?.trim();
  if (!text) return null;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number.parseFloat(match[0]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const lower = text.toLowerCase();
  if (/\b(?:ml|milliliter|millilitre|milliliters|millilitres)\b/.test(lower)) return value / 1000;
  if (/\b(?:l|liter|litre|liters|litres)\b/.test(lower)) return value;
  return value > 10 ? value / 1000 : value;
}

function isMetricBelowSetting(value: number | null | undefined, setting: number | null): boolean {
  if (typeof value !== "number" || !Number.isFinite(value) || typeof setting !== "number" || !Number.isFinite(setting)) {
    return false;
  }
  return Number(value.toFixed(REPORT_METRIC_DECIMALS)) < Number(setting.toFixed(REPORT_METRIC_DECIMALS));
}

function isPressureMetricBelowSetting(value: number | null | undefined, setting: number | null): boolean {
  if (typeof value !== "number" || !Number.isFinite(value) || typeof setting !== "number" || !Number.isFinite(setting)) {
    return false;
  }
  if (setting <= 0) return false;
  const warningThreshold = setting * (1 - PRESSURE_SETTING_WARNING_TOLERANCE);
  return Number(value.toFixed(REPORT_METRIC_DECIMALS)) < Number(warningThreshold.toFixed(REPORT_METRIC_DECIMALS));
}

function isTidalVolumeMetricBelowSetting(value: number | null | undefined, settingLiters: number | null): boolean {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    typeof settingLiters !== "number" ||
    !Number.isFinite(settingLiters)
  ) {
    return false;
  }
  return Number((value * 1000).toFixed(REPORT_METRIC_DECIMALS)) < Number((settingLiters * 1000).toFixed(REPORT_METRIC_DECIMALS));
}

function metricRow(label: string, value: string, emphasize: boolean): TableRow {
  return emphasize ? [label, value, true] : [label, value];
}

function groupRow(label: string): TableGroupRow {
  return { kind: "group", label };
}

function isGroupRow(row: TableRow): row is TableGroupRow {
  return !Array.isArray(row);
}

function normalizeRespiratoryRateDisplay(raw: string | null | undefined): string {
  const text = raw?.trim();
  if (!text) return NO_DATA_FALLBACK;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return text;
  const value = Number.parseFloat(match[0]);
  return Number.isFinite(value) ? `${value.toFixed(1)} bpm` : text;
}

function respiratoryRateMetricText(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${formatReportMetricValue(value)} bpm` : NO_DATA_FALLBACK;
}

function tidalVolumeMetricText(value: number | null | undefined, sustainedMinutes?: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return NO_DATA_FALLBACK;
  const text = `${formatReportMetricValue(value * 1000)} mL`;
  return typeof sustainedMinutes === "number" && Number.isFinite(sustainedMinutes)
    ? `${text} for ${formatReportMetricValue(sustainedMinutes)} min`
    : text;
}

function normalizeTidalVolumeDisplay(raw: string | null | undefined): string {
  const liters = numericTidalVolumeSettingLiters(raw);
  if (liters === null) return textValue(raw);
  return `${formatReportMetricValue(liters * 1000)} mL`;
}

function extractPressureRangeValues(raw: string | null | undefined): { min: string; max: string } | null {
  const text = raw?.trim();
  if (!text) return null;
  const match = text.match(/(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const min = Number.parseFloat(match[1]);
  const max = Number.parseFloat(match[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return {
    min: `${min.toFixed(1)} cmH2O`,
    max: `${max.toFixed(1)} cmH2O`
  };
}

function isRampOff(machine: QuickReportMetrics["machine"]): boolean {
  return /^off$/i.test(machine.rampTime?.trim() ?? "");
}

function shouldDisplayRampPressure(machine: QuickReportMetrics["machine"]): boolean {
  return Boolean(machine.rampPressure?.trim()) && !isRampOff(machine);
}

export function machineSettingRows(report: QuickReportMetrics): TableRow[] {
  const rows: TableRow[] = [
    ["Device", textValue(report.machine.device)],
    ["Mode", textValue(report.machine.mode)]
  ];

  const mode = report.machine.mode?.trim() ?? "";
  const therapyMode = classifyTherapyMode(report.machine);
  const isBiPap = therapyMode === "BiPAP";
  const isAutoBiPap = isBiPap && (isAutoBiPapLikeMode(mode) || Boolean(report.machine.pressureMin || report.machine.pressureMax));
  const isFixedCpap = therapyMode === "CPAP" || isFixedCpapLikeMode(mode);
  const isAutoPap = therapyMode === "APAP" || (!isBiPap && !isFixedCpap && (isAutoPapLikeMode(mode) || hasAutoPressureRange(report)));
  const derivedRange = extractPressureRangeValues(report.machine.pressure);

  if (isBiPap && isAutoBiPap) {
    rows.push(["Min pressure", normalizePressureDisplay(report.machine.pressureMin ?? derivedRange?.min)]);
    rows.push(["Max pressure", normalizePressureDisplay(report.machine.pressureMax ?? derivedRange?.max)]);
    if (shouldDisplayRespiratoryRate(report.machine)) {
      rows.push(["Respiratory rate (RR)", normalizeRespiratoryRateDisplay(report.machine.respiratoryRate)]);
    }
    if (report.machine.tidalVolume?.trim()) {
      rows.push(["Tidal volume (Vt)", normalizeTidalVolumeDisplay(report.machine.tidalVolume)]);
    }
  } else if (isBiPap) {
    rows.push(["IPAP", normalizePressureDisplay(report.machine.ipap)]);
    rows.push(["EPAP", normalizePressureDisplay(report.machine.epap)]);
    if (shouldDisplayRespiratoryRate(report.machine)) {
      rows.push(["Respiratory rate (RR)", normalizeRespiratoryRateDisplay(report.machine.respiratoryRate)]);
    }
    if (report.machine.tidalVolume?.trim()) {
      rows.push(["Tidal volume (Vt)", normalizeTidalVolumeDisplay(report.machine.tidalVolume)]);
    }
  } else if (isAutoPap) {
    rows.push(["Min pressure", normalizePressureDisplay(report.machine.pressureMin ?? derivedRange?.min)]);
    rows.push(["Max pressure", normalizePressureDisplay(report.machine.pressureMax ?? derivedRange?.max)]);
  } else {
    rows.push(["Pressure", normalizePressureDisplay(report.machine.pressure)]);
  }

  if (report.machine.rampTime?.trim()) {
    rows.push(["Ramp time", textValue(report.machine.rampTime)]);
  }
  if (shouldDisplayRampPressure(report.machine)) {
    rows.push(["Ramp pressure", normalizePressureDisplay(report.machine.rampPressure)]);
  }

  rows.push(["Pressure relief", textValue(report.machine.pressureRelief)]);
  return rows;
}

function hasAnyPressureSummaryValue(report: QuickReportMetrics, derivedRange: { min: string; max: string } | null): boolean {
  return (
    typeof report.machine.pressureAvg === "number" ||
    typeof report.machine.pressure95th === "number" ||
    typeof report.machine.ipapAvg === "number" ||
    typeof report.machine.ipap95th === "number" ||
    typeof report.machine.epapAvg === "number" ||
    typeof report.machine.epap95th === "number" ||
    Boolean(report.machine.pressureMin) ||
    Boolean(report.machine.pressureMax) ||
    Boolean(derivedRange) ||
    Boolean(report.machine.pressure)
  );
}

export function therapyPressureRows(report: QuickReportMetrics): TableRow[] {
  const mode = report.machine.mode?.trim() ?? "";
  const therapyMode = classifyTherapyMode(report.machine);
  const isBiPap = therapyMode === "BiPAP";
  const isAutoBiPap = isBiPap && (isAutoBiPapLikeMode(mode) || Boolean(report.machine.pressureMin || report.machine.pressureMax));
  const isFixedCpap = therapyMode === "CPAP" || isFixedCpapLikeMode(mode);
  const derivedRange = extractPressureRangeValues(report.machine.pressure);

  if (!hasAnyPressureSummaryValue(report, derivedRange)) return [];

  const minPressure = report.machine.pressureMin ?? derivedRange?.min ?? (isFixedCpap ? report.machine.pressure : undefined);
  const maxPressure = report.machine.pressureMax ?? derivedRange?.max ?? (isFixedCpap ? report.machine.pressure : undefined);
  const minimumPressureSetting = numericSettingValue(minPressure);
  const rows: TableRow[] = [];
  if (isBiPap) {
    const autoBilevelMinimumSetting = numericSettingValue(report.machine.pressureMin ?? report.machine.epap ?? derivedRange?.min);
    const ipapMinimumSetting = isAutoBiPap ? autoBilevelMinimumSetting : numericSettingValue(report.machine.ipap);
    const epapMinimumSetting = isAutoBiPap ? autoBilevelMinimumSetting : numericSettingValue(report.machine.epap);
    rows.push(metricRow("95th IPAP", pressureMetricText(report.machine.ipap95th), isPressureMetricBelowSetting(report.machine.ipap95th, ipapMinimumSetting)));
    rows.push(metricRow("Avg IPAP", pressureMetricText(report.machine.ipapAvg), isPressureMetricBelowSetting(report.machine.ipapAvg, ipapMinimumSetting)));
    rows.push(metricRow("95th EPAP", pressureMetricText(report.machine.epap95th), isPressureMetricBelowSetting(report.machine.epap95th, epapMinimumSetting)));
    rows.push(metricRow("Avg EPAP", pressureMetricText(report.machine.epapAvg), isPressureMetricBelowSetting(report.machine.epapAvg, epapMinimumSetting)));
    if (isAutoBiPap && (typeof report.machine.pressure95th === "number" || typeof report.machine.pressureAvg === "number")) {
      rows.push(
        metricRow(
          "95th Mask Pressure",
          pressureMetricText(report.machine.pressure95th),
          isPressureMetricBelowSetting(report.machine.pressure95th, minimumPressureSetting)
        )
      );
      rows.push(
        metricRow(
          "Avg Mask Pressure",
          pressureMetricText(report.machine.pressureAvg),
          isPressureMetricBelowSetting(report.machine.pressureAvg, minimumPressureSetting)
        )
      );
    }
  } else {
    rows.push(metricRow("95th Pressure", pressureMetricText(report.machine.pressure95th), isPressureMetricBelowSetting(report.machine.pressure95th, minimumPressureSetting)));
    rows.push(metricRow("Avg Pressure", pressureMetricText(report.machine.pressureAvg), isPressureMetricBelowSetting(report.machine.pressureAvg, minimumPressureSetting)));
  }
  if (!isBiPap || isAutoBiPap) {
    rows.push(["Min Pressure", pressureSettingText(minPressure)]);
    rows.push(["Max Pressure", pressureSettingText(maxPressure)]);
  }
  return rows;
}

export function bipapVentilationRows(report: QuickReportMetrics): TableRow[] {
  if (classifyTherapyMode(report.machine) !== "BiPAP") return [];

  const rows: TableRow[] = [];
  const respiratoryRateSetting = numericSettingValue(report.machine.respiratoryRate);
  const tidalVolumeSetting = numericTidalVolumeSettingLiters(report.machine.tidalVolume);
  if (typeof report.machine.tidalVolumeMin === "number") {
    rows.push(
      metricRow(
        "Min Vt (tidal volume)",
        tidalVolumeMetricText(report.machine.tidalVolumeMin, report.machine.tidalVolumeMinMinutes),
        isTidalVolumeMetricBelowSetting(report.machine.tidalVolumeMin, tidalVolumeSetting)
      )
    );
  }
  if (typeof report.machine.tidalVolumeMedian === "number") {
    rows.push(
      metricRow(
        "Median Vt (tidal volume)",
        tidalVolumeMetricText(report.machine.tidalVolumeMedian),
        isTidalVolumeMetricBelowSetting(report.machine.tidalVolumeMedian, tidalVolumeSetting)
      )
    );
  }
  if (typeof report.machine.tidalVolumeAvg === "number") {
    rows.push(
      metricRow(
        "Avg Vt (tidal volume)",
        tidalVolumeMetricText(report.machine.tidalVolumeAvg),
        isTidalVolumeMetricBelowSetting(report.machine.tidalVolumeAvg, tidalVolumeSetting)
      )
    );
  }
  if (typeof report.machine.tidalVolumeMax === "number") {
    rows.push(
      metricRow(
        "Max Vt (tidal volume)",
        tidalVolumeMetricText(report.machine.tidalVolumeMax, report.machine.tidalVolumeMaxMinutes),
        isTidalVolumeMetricBelowSetting(report.machine.tidalVolumeMax, tidalVolumeSetting)
      )
    );
  }
  if (typeof report.machine.respiratoryRateMin === "number") {
    rows.push(metricRow("Min RR", respiratoryRateMetricText(report.machine.respiratoryRateMin), isMetricBelowSetting(report.machine.respiratoryRateMin, respiratoryRateSetting)));
  }
  if (typeof report.machine.respiratoryRateAvg === "number") {
    rows.push(metricRow("Avg RR", respiratoryRateMetricText(report.machine.respiratoryRateAvg), isMetricBelowSetting(report.machine.respiratoryRateAvg, respiratoryRateSetting)));
  }
  if (typeof report.machine.respiratoryRate95th === "number") {
    rows.push(metricRow("95th RR", respiratoryRateMetricText(report.machine.respiratoryRate95th), isMetricBelowSetting(report.machine.respiratoryRate95th, respiratoryRateSetting)));
  }
  return rows;
}

export function ahiMetricRows(report: QuickReportMetrics): TableRow[] {
  return [
    ["Avg AHI", formatReportMetricValue(report.avgAhi), isAhiAboveThreshold(report.avgAhi)],
    ["95th AHI", formatReportMetricValue(report.ahi95th), isAhiAboveThreshold(report.ahi95th)]
  ];
}

function reraValueText(report: QuickReportMetrics): string {
  if (/apex\s*\/\s*bmc\s*\/\s*luna/i.test(report.selectedLoader)) {
    return "Not supported by this device";
  }
  return formatReportMetricValue(report.avgReraIndex);
}

function eventMetricValueText(value: number | null): string {
  return value === null ? EVENT_DATA_NOT_PRESENT : formatReportMetricValue(value);
}

export function optionalEventMetricRows(report: QuickReportMetrics): TableRow[] {
  const rows: TableRow[] = [
    ["Avg Central apneas", eventMetricValueText(report.avgCentralApneas)],
    ["95th Central apneas", eventMetricValueText(report.centralApneas95th)]
  ];

  if (report.avgReraIndex !== null || report.rera95th !== null || /apex\s*\/\s*bmc\s*\/\s*luna/i.test(report.selectedLoader)) {
    rows.push(["Avg RERA index", reraValueText(report)]);
  }

  return rows;
}

function leakRow(label: string, value: number | null): TableRow {
  if (value === null || !Number.isFinite(value)) return [label, NO_DATA_FALLBACK];
  return [label, `${formatReportMetricValue(value)} L/min`, value > 30];
}

function primaryLeakLabel(report: QuickReportMetrics): string {
  if (/^resvent\s*\/\s*hoffrichter$/i.test(report.selectedLoader.trim())) return "Median Leak";
  return "Avg Leak";
}

function sectionRows(label: string, rows: TableRow[]): TableRow[] {
  return rows.length > 0 ? [groupRow(label), ...rows] : [];
}

function buildTherapySummaryRows(report: QuickReportMetrics): TableRow[] {
  const belowMedicareCompliance = isBelowMedicareComplianceThreshold(report);
  const belowMedicareNightlyUse = isBelowMedicareNightlyUseThreshold(report);
  const usageRows: TableRow[] = [
    ["Date range", `${report.dateRangeStart} to ${report.dateRangeEnd}`],
    ["Days with data", `${report.daysWithData} / ${report.daysInWindow}`],
    ["Usage days (% of range)", `${report.usageDaysPercent.toFixed(1)}%`],
    ["Compliant days (>= 4h)", `${report.compliantDays} / ${report.daysInWindow}`, belowMedicareCompliance],
    ["Compliance (% of range)", `${report.compliancePercent.toFixed(1)}%`, belowMedicareCompliance],
    ["Avg usage per day", report.avgUsageHours === null ? NO_DATA_FALLBACK : `${formatReportMetricValue(report.avgUsageHours)} h`, belowMedicareNightlyUse]
  ];
  const ventilationRows = bipapVentilationRows(report);
  const eventRows: TableRow[] = [
    ...ahiMetricRows(report),
    ["Avg Residual apneas", formatReportMetricValue(report.avgResidualApneas)],
    ["95th Residual apneas", formatReportMetricValue(report.residualApneas95th)],
    ...optionalEventMetricRows(report)
  ];
  const leakRows: TableRow[] = [
    leakRow(primaryLeakLabel(report), report.avgLeak),
    leakRow("95th Leak", report.leak95th),
    leakRow("30 min Sustained Leak", report.maxLeak30m),
    leakRow("60 min Sustained Leak", report.maxLeak60m)
  ];

  return [
    ...sectionRows("Usage Summary", usageRows),
    ...sectionRows("BiPAP Report Information", ventilationRows),
    ...sectionRows("Therapy Pressures", therapyPressureRows(report)),
    ...sectionRows("Respiratory Events", eventRows),
    ...sectionRows("Leaks", leakRows)
  ];
}

function measureCompactTableHeight(
  title: string,
  rows: TableRow[],
  width: number,
  style: CompactTableStyle,
  fontRegular: any,
  fontBold: any
): number {
  const leftW = width * style.leftRatio;
  const rightW = width - leftW;
  let total = style.titleSize + style.titleGap + style.headerHeight;

  for (const row of rows) {
    if (isGroupRow(row)) {
      total += style.headerHeight;
      continue;
    }
    const [label, value] = row;
    const labelLines = splitLines(label, fontBold, style.bodyFontSize, leftW - style.insetX * 2);
    const valueLines = splitLines(value, fontRegular, style.bodyFontSize, rightW - style.insetX * 2);
    const lineCount = Math.max(labelLines.length, valueLines.length);
    total += style.insetY * 2 + lineCount * style.lineHeight;
  }

  return total + style.afterGap;
}

function drawCompactTableAt(
  state: PdfState,
  x: number,
  yTop: number,
  width: number,
  title: string,
  rows: TableRow[],
  style: CompactTableStyle,
  fontRegular: any,
  fontBold: any,
  rgbFn: PdfLibModule["rgb"],
  theme: PdfTheme
): number {
  const leftW = width * style.leftRatio;
  const rightW = width - leftW;
  let y = yTop;

  state.page.drawText(title, {
    x,
    y: y - style.titleSize,
    size: style.titleSize,
    font: fontBold,
    color: pdfColor(rgbFn, theme.heading)
  });
  y -= style.titleSize + style.titleGap;

  state.page.drawRectangle({
    x,
    y: y - style.headerHeight,
    width,
    height: style.headerHeight,
    color: pdfColor(rgbFn, theme.primary),
    borderColor: pdfColor(rgbFn, theme.primary),
    borderWidth: 0.5
  });
  state.page.drawText("Field", {
    x: x + style.insetX,
    y: y - style.headerHeight + 5,
    size: style.headerFontSize,
    font: fontBold,
    color: pdfColor(rgbFn, theme.onPrimary)
  });
  state.page.drawText("Value", {
    x: x + leftW + style.insetX,
    y: y - style.headerHeight + 5,
    size: style.headerFontSize,
    font: fontBold,
    color: pdfColor(rgbFn, theme.onPrimary)
  });
  y -= style.headerHeight;

  let dataRowIndex = 0;
  rows.forEach((row) => {
    if (isGroupRow(row)) {
      const rowHeight = style.headerHeight;
      state.page.drawRectangle({
        x,
        y: y - rowHeight,
        width,
        height: rowHeight,
        color: pdfColor(rgbFn, mixThemeColor(theme.primary, theme.rowBase, 0.2)),
        borderColor: pdfColor(rgbFn, theme.primary),
        borderWidth: 1.2
      });
      state.page.drawText(row.label, {
        x: x + style.insetX,
        y: y - rowHeight + 5,
        size: style.headerFontSize,
        font: fontBold,
        color: pdfColor(rgbFn, theme.onPrimary)
      });
      y -= rowHeight;
      dataRowIndex = 0;
      return;
    }

    const [label, value, emphasize] = row;
    const labelLines = splitLines(label, fontBold, style.bodyFontSize, leftW - style.insetX * 2);
    const valueLines = splitLines(value, fontRegular, style.bodyFontSize, rightW - style.insetX * 2);
    const lineCount = Math.max(labelLines.length, valueLines.length);
    const rowHeight = style.insetY * 2 + lineCount * style.lineHeight;
    const fill = dataRowIndex % 2 === 0 ? pdfColor(rgbFn, theme.rowAlt) : pdfColor(rgbFn, theme.rowBase);

    state.page.drawRectangle({
      x,
      y: y - rowHeight,
      width,
      height: rowHeight,
      color: fill,
      borderColor: pdfColor(rgbFn, theme.border),
      borderWidth: 0.5
    });

    const labelStartY = y - style.insetY - style.lineHeight + 3;
    labelLines.forEach((line, i) => {
      state.page.drawText(line, {
        x: x + style.insetX,
        y: labelStartY - i * style.lineHeight,
        size: style.bodyFontSize,
        font: fontBold,
        color: pdfColor(rgbFn, theme.muted)
      });
    });

    const valueStartY = y - style.insetY - style.lineHeight + 3;
    valueLines.forEach((line, i) => {
      state.page.drawText(line, {
        x: x + leftW + style.insetX,
        y: valueStartY - i * style.lineHeight,
        size: style.bodyFontSize,
        font: fontRegular,
        color: emphasize ? pdfColor(rgbFn, theme.danger) : pdfColor(rgbFn, theme.body)
      });
    });

    y -= rowHeight;
    dataRowIndex += 1;
  });

  return y - style.afterGap;
}

function drawCompactTableHeaderAt(
  state: PdfState,
  x: number,
  yTop: number,
  width: number,
  style: CompactTableStyle,
  fontBold: any,
  rgbFn: PdfLibModule["rgb"],
  theme: PdfTheme
): number {
  const leftW = width * style.leftRatio;
  state.page.drawRectangle({
    x,
    y: yTop - style.headerHeight,
    width,
    height: style.headerHeight,
    color: pdfColor(rgbFn, theme.primary),
    borderColor: pdfColor(rgbFn, theme.primary),
    borderWidth: 0.5
  });
  state.page.drawText("Field", {
    x: x + style.insetX,
    y: yTop - style.headerHeight + 5,
    size: style.headerFontSize,
    font: fontBold,
    color: pdfColor(rgbFn, theme.onPrimary)
  });
  state.page.drawText("Value", {
    x: x + leftW + style.insetX,
    y: yTop - style.headerHeight + 5,
    size: style.headerFontSize,
    font: fontBold,
    color: pdfColor(rgbFn, theme.onPrimary)
  });
  return yTop - style.headerHeight;
}

function drawCompactTableFlow(
  pdfDoc: any,
  state: PdfState,
  reportDays: number,
  reportMode: string | undefined,
  x: number,
  width: number,
  title: string,
  rows: TableRow[],
  style: CompactTableStyle,
  footerReserveHeight: number,
  headerImage: any | undefined,
  fontRegular: any,
  fontBold: any,
  rgbFn: PdfLibModule["rgb"],
  theme: PdfTheme
): number {
  const leftW = width * style.leftRatio;
  const rightW = width - leftW;

  const drawTitleAndHeader = (continued: boolean) => {
    ensureSpace(
      pdfDoc,
      state,
      style.titleSize + style.titleGap + style.headerHeight + footerReserveHeight,
      reportDays,
      reportMode,
      headerImage,
      fontBold,
      rgbFn,
      theme
    );
    const titleText = continued ? `${title} (continued)` : title;
    state.page.drawText(titleText, {
      x,
      y: state.y - style.titleSize,
      size: style.titleSize,
      font: fontBold,
      color: pdfColor(rgbFn, theme.heading)
    });
    state.y -= style.titleSize + style.titleGap;
    state.y = drawCompactTableHeaderAt(state, x, state.y, width, style, fontBold, rgbFn, theme);
  };

  drawTitleAndHeader(false);

  const rowHeightFor = (row: TableRow): number => {
    if (isGroupRow(row)) return style.headerHeight;
    return (
      style.insetY * 2 +
      Math.max(
        splitLines(row[0], fontBold, style.bodyFontSize, leftW - style.insetX * 2).length,
        splitLines(row[1], fontRegular, style.bodyFontSize, rightW - style.insetX * 2).length
      ) *
        style.lineHeight
    );
  };

  const sectionHeightFrom = (startIndex: number): number => {
    let height = 0;
    for (let idx = startIndex; idx < rows.length; idx += 1) {
      if (idx > startIndex && isGroupRow(rows[idx])) break;
      height += rowHeightFor(rows[idx]);
    }
    return height;
  };

  let dataRowIndex = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const rowHeight = rowHeightFor(row);

    if (isGroupRow(row) && state.y - sectionHeightFrom(rowIndex) < PAGE_MARGIN + footerReserveHeight) {
      startNewPage(pdfDoc, state, reportDays, reportMode, headerImage, fontBold, rgbFn, theme);
      drawTitleAndHeader(true);
      dataRowIndex = 0;
    }

    if (state.y - rowHeight < PAGE_MARGIN + footerReserveHeight) {
      startNewPage(pdfDoc, state, reportDays, reportMode, headerImage, fontBold, rgbFn, theme);
      drawTitleAndHeader(true);
      dataRowIndex = 0;
    }

    if (isGroupRow(row)) {
      state.page.drawRectangle({
        x,
        y: state.y - rowHeight,
        width,
        height: rowHeight,
        color: pdfColor(rgbFn, mixThemeColor(theme.primary, theme.rowBase, 0.2)),
        borderColor: pdfColor(rgbFn, theme.primary),
        borderWidth: 1.2
      });
      state.page.drawText(row.label, {
        x: x + style.insetX,
        y: state.y - rowHeight + 5,
        size: style.headerFontSize,
        font: fontBold,
        color: pdfColor(rgbFn, theme.onPrimary)
      });
      state.y -= rowHeight;
      dataRowIndex = 0;
      continue;
    }

    const [label, value, emphasize] = row;
    const labelLines = splitLines(label, fontBold, style.bodyFontSize, leftW - style.insetX * 2);
    const valueLines = splitLines(value, fontRegular, style.bodyFontSize, rightW - style.insetX * 2);
    const fill = dataRowIndex % 2 === 0 ? pdfColor(rgbFn, theme.rowAlt) : pdfColor(rgbFn, theme.rowBase);

    state.page.drawRectangle({
      x,
      y: state.y - rowHeight,
      width,
      height: rowHeight,
      color: fill,
      borderColor: pdfColor(rgbFn, theme.border),
      borderWidth: 0.5
    });

    const labelStartY = state.y - style.insetY - style.lineHeight + 3;
    labelLines.forEach((line, i) => {
      state.page.drawText(line, {
        x: x + style.insetX,
        y: labelStartY - i * style.lineHeight,
        size: style.bodyFontSize,
        font: fontBold,
        color: pdfColor(rgbFn, theme.muted)
      });
    });

    const valueStartY = state.y - style.insetY - style.lineHeight + 3;
    valueLines.forEach((line, i) => {
      state.page.drawText(line, {
        x: x + leftW + style.insetX,
        y: valueStartY - i * style.lineHeight,
        size: style.bodyFontSize,
        font: fontRegular,
        color: emphasize ? pdfColor(rgbFn, theme.danger) : pdfColor(rgbFn, theme.body)
      });
    });

    state.y -= rowHeight;
    dataRowIndex += 1;
  }

  state.y -= style.afterGap;
  return state.y;
}

function drawTable(
  pdfDoc: any,
  state: PdfState,
  reportDays: number,
  reportMode: string | undefined,
  title: string,
  rows: TableRow[],
  headerImage: any | undefined,
  fontRegular: any,
  fontBold: any,
  rgbFn: PdfLibModule["rgb"],
  theme: PdfTheme
) {
  const tableWidth = state.pageWidth - PAGE_MARGIN * 2;
  const leftW = tableWidth * 0.42;
  const rightW = tableWidth - leftW;
  const lineHeight = 12;
  const insetX = 8;
  const insetY = 6;

  drawSectionTitle(pdfDoc, state, title, reportDays, reportMode, headerImage, fontBold, rgbFn, theme);

  const headerHeight = 22;
  ensureSpace(pdfDoc, state, headerHeight + 12, reportDays, reportMode, headerImage, fontBold, rgbFn, theme);
  state.page.drawRectangle({
    x: PAGE_MARGIN,
    y: state.y - headerHeight,
    width: tableWidth,
    height: headerHeight,
    color: pdfColor(rgbFn, theme.primary),
    borderColor: pdfColor(rgbFn, theme.primary),
    borderWidth: 0.5
  });
  state.page.drawText("Field", {
    x: PAGE_MARGIN + insetX,
    y: state.y - headerHeight + 7,
    size: 10,
    font: fontBold,
    color: pdfColor(rgbFn, theme.onPrimary)
  });
  state.page.drawText("Value", {
    x: PAGE_MARGIN + leftW + insetX,
    y: state.y - headerHeight + 7,
    size: 10,
    font: fontBold,
    color: pdfColor(rgbFn, theme.onPrimary)
  });
  state.y -= headerHeight;

  rows.forEach((row, idx) => {
    if (isGroupRow(row)) {
      const rowHeight = headerHeight;
      ensureSpace(pdfDoc, state, rowHeight + 10, reportDays, reportMode, headerImage, fontBold, rgbFn, theme);
      state.page.drawRectangle({
        x: PAGE_MARGIN,
        y: state.y - rowHeight,
        width: tableWidth,
        height: rowHeight,
        color: pdfColor(rgbFn, mixThemeColor(theme.primary, theme.rowBase, 0.2)),
        borderColor: pdfColor(rgbFn, theme.primary),
        borderWidth: 1.2
      });
      state.page.drawText(row.label, {
        x: PAGE_MARGIN + insetX,
        y: state.y - rowHeight + 7,
        size: 10,
        font: fontBold,
        color: pdfColor(rgbFn, theme.onPrimary)
      });
      state.y -= rowHeight;
      return;
    }

    const [label, value, emphasize] = row;
    const labelLines = splitLines(label, fontBold, 10, leftW - insetX * 2);
    const valueLines = splitLines(value, fontRegular, 10, rightW - insetX * 2);
    const lineCount = Math.max(labelLines.length, valueLines.length);
    const rowHeight = insetY * 2 + lineCount * lineHeight;

    ensureSpace(pdfDoc, state, rowHeight + 10, reportDays, reportMode, headerImage, fontBold, rgbFn, theme);
    const fill = idx % 2 === 0 ? pdfColor(rgbFn, theme.rowAlt) : pdfColor(rgbFn, theme.rowBase);

    state.page.drawRectangle({
      x: PAGE_MARGIN,
      y: state.y - rowHeight,
      width: tableWidth,
      height: rowHeight,
      color: fill,
      borderColor: pdfColor(rgbFn, theme.border),
      borderWidth: 0.5
    });

    const labelStartY = state.y - insetY - lineHeight + 3;
    labelLines.forEach((line, i) => {
      state.page.drawText(line, {
        x: PAGE_MARGIN + insetX,
        y: labelStartY - i * lineHeight,
        size: 10,
        font: fontBold,
        color: pdfColor(rgbFn, theme.muted)
      });
    });

    const valueStartY = state.y - insetY - lineHeight + 3;
    valueLines.forEach((line, i) => {
      state.page.drawText(line, {
        x: PAGE_MARGIN + leftW + insetX,
        y: valueStartY - i * lineHeight,
        size: 10,
        font: fontRegular,
        color: emphasize ? pdfColor(rgbFn, theme.danger) : pdfColor(rgbFn, theme.body)
      });
    });

    state.y -= rowHeight;
  });

  state.y -= 10;
}

export async function buildPdfReport(report: QuickReportMetrics, headerDataUrl?: string) {
  // Dynamic import avoids SSR/CJS bundling issues and ensures client-side-only PDF rendering.
  const pdfLib = (await import("pdf-lib/dist/pdf-lib.esm.js")) as unknown as PdfLibModule;
  const { PDFDocument, StandardFonts, rgb: rgbFn } = pdfLib;

  const pdfDoc = await PDFDocument.create();
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const theme = await resolvePdfTheme(headerDataUrl);
  const headerImage = await tryEmbedHeaderImage(pdfDoc, headerDataUrl);

  const state: PdfState = {
    page: pdfDoc.addPage([PAGE_WIDTH_A4, PAGE_HEIGHT_A4]),
    y: PAGE_HEIGHT_A4 - PAGE_MARGIN,
    pageWidth: PAGE_WIDTH_A4,
    pageHeight: PAGE_HEIGHT_A4
  };
  drawHeader(state, report.daysInWindow, report.machine.mode, headerImage, fontBold, rgbFn, theme);

  const patientRows: TableRow[] = [
    ["Patient", textValue(report.patientName)],
    ["Date of birth", textValue(report.dateOfBirth)]
  ];
  const machineRows = machineSettingRows(report);
  const therapyRows = buildTherapySummaryRows(report);
  const isTwoPageTherapyReport = classifyReportTherapyLayout(report.machine) === "two-page-bipap";
  const therapyTitle = `Therapy Summary (Last ${report.daysInWindow} Days)`;

  const fullWidth = state.pageWidth - PAGE_MARGIN * 2;
  const columnGap = 10;
  const halfWidth = (fullWidth - columnGap) / 2;
  const availableHeight = state.y - (PAGE_MARGIN + FOOTER_BLOCK_HEIGHT);
  const onePageLayoutChoice = CPAP_THERAPY_FONT_SIZES.flatMap((therapyFontSize) =>
    TABLE_STYLE_CANDIDATES.map((topStyle) => ({
      topStyle,
      therapyStyle: therapyTableStyle(therapyFontSize, CPAP_THERAPY_MIN_FONT_SIZE)
    }))
  ).find(({ topStyle, therapyStyle }) => {
    const topHeight = Math.max(
      measureCompactTableHeight("Patient Details", patientRows, halfWidth, topStyle, fontRegular, fontBold),
      measureCompactTableHeight("Machine Settings", machineRows, halfWidth, topStyle, fontRegular, fontBold)
    );
    const therapyHeight = measureCompactTableHeight(
      therapyTitle,
      therapyRows,
      fullWidth,
      therapyStyle,
      fontRegular,
      fontBold
    );
    return topHeight + therapyHeight <= availableHeight;
  }) ?? {
    topStyle: TABLE_STYLE_CANDIDATES[TABLE_STYLE_CANDIDATES.length - 1],
    therapyStyle: therapyTableStyle(CPAP_THERAPY_MIN_FONT_SIZE, CPAP_THERAPY_MIN_FONT_SIZE)
  };
  const layoutChoice = isTwoPageTherapyReport
    ? {
        topStyle: TABLE_STYLE_CANDIDATES[0],
        therapyStyle: therapyTableStyle(THERAPY_MAX_FONT_SIZE)
      }
    : onePageLayoutChoice;

  const topY = state.y;
  const patientBottom = drawCompactTableAt(
    state,
    PAGE_MARGIN,
    topY,
    halfWidth,
    "Patient Details",
    patientRows,
    layoutChoice.topStyle,
    fontRegular,
    fontBold,
    rgbFn,
    theme
  );
  const machineBottom = drawCompactTableAt(
    state,
    PAGE_MARGIN + halfWidth + columnGap,
    topY,
    halfWidth,
    "Machine Settings",
    machineRows,
    layoutChoice.topStyle,
    fontRegular,
    fontBold,
    rgbFn,
    theme
  );

  state.y = Math.min(patientBottom, machineBottom);
  if (isTwoPageTherapyReport) {
    const secondPageStart = therapyRows.findIndex((row) => isGroupRow(row) && row.label === "Therapy Pressures");
    const firstPageRows = secondPageStart > 0 ? therapyRows.slice(0, secondPageStart) : therapyRows;
    const secondPageRows = secondPageStart > 0 ? therapyRows.slice(secondPageStart) : [];

    state.y = drawCompactTableAt(
      state,
      PAGE_MARGIN,
      state.y,
      fullWidth,
      therapyTitle,
      firstPageRows,
      layoutChoice.therapyStyle,
      fontRegular,
      fontBold,
      rgbFn,
      theme
    );

    startNewPage(pdfDoc, state, report.daysInWindow, report.machine.mode, headerImage, fontBold, rgbFn, theme);
    state.y = drawCompactTableAt(
      state,
      PAGE_MARGIN,
      state.y,
      fullWidth,
      `${therapyTitle} (continued)`,
      secondPageRows,
      layoutChoice.therapyStyle,
      fontRegular,
      fontBold,
      rgbFn,
      theme
    );
  } else {
    state.y = drawCompactTableAt(
      state,
      PAGE_MARGIN,
      state.y,
      fullWidth,
      therapyTitle,
      therapyRows,
      layoutChoice.therapyStyle,
      fontRegular,
      fontBold,
      rgbFn,
      theme
    );
  }

  drawBottomFooterBlock(pdfDoc, state, report, headerImage, fontRegular, fontBold, rgbFn, theme);

  const bytes = await pdfDoc.save();
  const blob = new Blob([bytes], { type: "application/pdf" });
  const filename = `${initialsFromName(report.patientName)}-${filenameDateStamp(new Date())}.pdf`;
  return { blob, filename };
}
