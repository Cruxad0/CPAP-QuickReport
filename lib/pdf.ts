import { isAutoBiPapLikeMode, isAutoPapLikeMode, isBiPapLikeMode, isFixedCpapLikeMode } from "@/lib/machine-mode";
import { QuickReportMetrics } from "@/lib/types";

const PAGE_WIDTH_A4 = 595.28;
const PAGE_HEIGHT_A4 = 841.89;
const PAGE_MARGIN = 18; // 0.25 in
const NO_DATA_FALLBACK = "Data point not available";
const BRANDING_HEADER_TARGET_WIDTH_RATIO = 0.95;
const BRANDING_LOGO_TARGET_WIDTH_RATIO = 0.15;
const BRANDING_HEADER_MIN_ASPECT_RATIO = 4;
const BRANDING_HEADER_MAX_HEIGHT = 90;
const BRANDING_LOGO_MAX_HEIGHT = 72;
const FOOTER_BLOCK_HEIGHT = 64;
const THERAPY_MIN_FONT_SIZE = 10;
const THERAPY_MAX_FONT_SIZE = 11;

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

function valueText(value: number | null | undefined, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : NO_DATA_FALLBACK;
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

function buildTherapyFontSizes(): number[] {
  const sizes: number[] = [];
  for (let size = THERAPY_MAX_FONT_SIZE; size >= THERAPY_MIN_FONT_SIZE; size -= 0.5) {
    sizes.push(Number(size.toFixed(1)));
  }
  return sizes;
}
const THERAPY_FONT_SIZES = buildTherapyFontSizes();

async function tryEmbedHeaderImage(pdfDoc: any, headerDataUrl: string | undefined): Promise<any | undefined> {
  if (!headerDataUrl) return undefined;
  const match = headerDataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!match) return undefined;
  const mime = match[1].toLowerCase();
  const bytes = decodeBase64(match[2]);

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

function drawDefaultHeader(state: PdfState, reportDays: number, reportMode: string | undefined, fontBold: any, rgbFn: PdfLibModule["rgb"]) {
  state.page.drawText(`${headerModeText(reportMode)} ${reportDays}-Day Quick Report`, {
    x: PAGE_MARGIN,
    y: state.y - 16,
    size: 11,
    font: fontBold,
    color: rgbFn(0.07, 0.31, 0.49)
  });
  state.y -= 18;
  state.page.drawLine({
    start: { x: PAGE_MARGIN, y: state.y },
    end: { x: state.pageWidth - PAGE_MARGIN, y: state.y },
    color: rgbFn(0.06, 0.46, 0.6),
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
  rgbFn: PdfLibModule["rgb"]
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
  drawDefaultHeader(state, reportDays, reportMode, fontBold, rgbFn);
}

function ensureSpace(
  pdfDoc: any,
  state: PdfState,
  neededHeight: number,
  reportDays: number,
  reportMode: string | undefined,
  headerImage: any | undefined,
  fontBold: any,
  rgbFn: PdfLibModule["rgb"]
) {
  if (state.y - neededHeight >= PAGE_MARGIN) return;
  state.page = pdfDoc.addPage([PAGE_WIDTH_A4, PAGE_HEIGHT_A4]);
  state.pageWidth = state.page.getWidth();
  state.pageHeight = state.page.getHeight();
  state.y = state.pageHeight - PAGE_MARGIN;
  drawHeader(state, reportDays, reportMode, headerImage, fontBold, rgbFn);
}

function startNewPage(
  pdfDoc: any,
  state: PdfState,
  reportDays: number,
  reportMode: string | undefined,
  headerImage: any | undefined,
  fontBold: any,
  rgbFn: PdfLibModule["rgb"]
) {
  state.page = pdfDoc.addPage([PAGE_WIDTH_A4, PAGE_HEIGHT_A4]);
  state.pageWidth = state.page.getWidth();
  state.pageHeight = state.page.getHeight();
  state.y = state.pageHeight - PAGE_MARGIN;
  drawHeader(state, reportDays, reportMode, headerImage, fontBold, rgbFn);
}

function drawSectionTitle(
  pdfDoc: any,
  state: PdfState,
  title: string,
  reportDays: number,
  reportMode: string | undefined,
  headerImage: any | undefined,
  fontBold: any,
  rgbFn: PdfLibModule["rgb"]
) {
  ensureSpace(pdfDoc, state, 30, reportDays, reportMode, headerImage, fontBold, rgbFn);
  state.page.drawText(title, {
    x: PAGE_MARGIN,
    y: state.y - 12,
    size: 11,
    font: fontBold,
    color: rgbFn(0.07, 0.31, 0.49)
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
  rgbFn: PdfLibModule["rgb"]
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
    color: rgbFn(0.12, 0.2, 0.27)
  });

  state.page.drawText("Signature:", {
    x: PAGE_MARGIN,
    y: signatureY,
    size: 10,
    font: fontBold,
    color: rgbFn(0.12, 0.2, 0.27)
  });
  state.page.drawLine({
    start: { x: PAGE_MARGIN + 74, y: signatureY + 1 },
    end: { x: state.pageWidth - PAGE_MARGIN, y: signatureY + 1 },
    color: rgbFn(0.35, 0.43, 0.5),
    thickness: 0.9
  });

  state.page.drawText(`Generated: ${report.generatedAtDisplay}`, {
    x: PAGE_MARGIN,
    y: generatedY,
    size: 10,
    font: fontRegular,
    color: rgbFn(0.12, 0.22, 0.31)
  });
}

type TableRow = [string, string, boolean?];
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

function therapyTableStyle(fontSize: number): CompactTableStyle {
  const clampedFontSize = Math.max(THERAPY_MIN_FONT_SIZE, Math.min(THERAPY_MAX_FONT_SIZE, fontSize));
  return {
    titleSize: 11,
    titleGap: 3.5,
    headerHeight: Math.max(16, clampedFontSize + 6),
    headerFontSize: 10,
    bodyFontSize: clampedFontSize,
    lineHeight: Math.max(10.5, clampedFontSize + 0.8),
    insetX: 5.5,
    insetY: 3.25,
    leftRatio: 0.41,
    afterGap: 5
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

function hasPressureRangeText(raw: string | null | undefined): boolean {
  const text = raw?.trim();
  return typeof text === "string" && /\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?/.test(text);
}

function machineSettingRows(report: QuickReportMetrics): TableRow[] {
  const rows: TableRow[] = [
    ["Device", textValue(report.machine.device)],
    ["Mode", textValue(report.machine.mode)]
  ];

  const mode = report.machine.mode?.trim() ?? "";
  const isBiPap = isBiPapLikeMode(mode);
  const isFixedCpap = isFixedCpapLikeMode(mode);
  const isAutoPap = !isBiPap && !isFixedCpap && (isAutoPapLikeMode(mode) || hasAutoPressureRange(report));

  if (isBiPap) {
    rows.push(["IPAP", normalizePressureDisplay(report.machine.ipap)]);
    rows.push(["EPAP", normalizePressureDisplay(report.machine.epap)]);
    rows.push(["Respiratory rate (RR)", textValue(report.machine.respiratoryRate)]);
  } else if (isAutoPap) {
    rows.push(["Min pressure", normalizePressureDisplay(report.machine.pressureMin)]);
    rows.push(["Max pressure", normalizePressureDisplay(report.machine.pressureMax)]);
  } else {
    rows.push(["Pressure", normalizePressureDisplay(report.machine.pressure)]);
  }

  rows.push(["Pressure relief", textValue(report.machine.pressureRelief)]);
  return rows;
}

function therapyPressureRows(report: QuickReportMetrics): TableRow[] {
  const mode = report.machine.mode?.trim() ?? "";
  const isBiPap = isBiPapLikeMode(mode);
  const isFixedCpap = isFixedCpapLikeMode(mode);
  const isAutoPap = !isBiPap && !isFixedCpap && (isAutoPapLikeMode(mode) || hasAutoPressureRange(report));
  const isAutoBiPap =
    isBiPap &&
    (isAutoBiPapLikeMode(mode) || hasPressureRangeText(report.machine.epap) || hasPressureRangeText(report.machine.ipap));
  if (!isAutoPap && !isAutoBiPap) return [];

  return [
    ["Avg Pressure", pressureMetricText(report.machine.pressureAvg)],
    ["95th Pressure", pressureMetricText(report.machine.pressure95th)]
  ];
}

function leakRow(label: string, value: number | null): TableRow {
  if (value === null || !Number.isFinite(value)) return [label, NO_DATA_FALLBACK];
  return [label, `${valueText(value)} L/min`, value > 30];
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

  for (const [label, value] of rows) {
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
  rgbFn: PdfLibModule["rgb"]
): number {
  const leftW = width * style.leftRatio;
  const rightW = width - leftW;
  let y = yTop;

  state.page.drawText(title, {
    x,
    y: y - style.titleSize,
    size: style.titleSize,
    font: fontBold,
    color: rgbFn(0.07, 0.31, 0.49)
  });
  y -= style.titleSize + style.titleGap;

  state.page.drawRectangle({
    x,
    y: y - style.headerHeight,
    width,
    height: style.headerHeight,
    color: rgbFn(0.05, 0.43, 0.57),
    borderColor: rgbFn(0.05, 0.43, 0.57),
    borderWidth: 0.5
  });
  state.page.drawText("Field", {
    x: x + style.insetX,
    y: y - style.headerHeight + 5,
    size: style.headerFontSize,
    font: fontBold,
    color: rgbFn(1, 1, 1)
  });
  state.page.drawText("Value", {
    x: x + leftW + style.insetX,
    y: y - style.headerHeight + 5,
    size: style.headerFontSize,
    font: fontBold,
    color: rgbFn(1, 1, 1)
  });
  y -= style.headerHeight;

  rows.forEach(([label, value, emphasize], idx) => {
    const labelLines = splitLines(label, fontBold, style.bodyFontSize, leftW - style.insetX * 2);
    const valueLines = splitLines(value, fontRegular, style.bodyFontSize, rightW - style.insetX * 2);
    const lineCount = Math.max(labelLines.length, valueLines.length);
    const rowHeight = style.insetY * 2 + lineCount * style.lineHeight;
    const fill = idx % 2 === 0 ? rgbFn(0.965, 0.98, 0.99) : rgbFn(1, 1, 1);

    state.page.drawRectangle({
      x,
      y: y - rowHeight,
      width,
      height: rowHeight,
      color: fill,
      borderColor: rgbFn(0.82, 0.88, 0.93),
      borderWidth: 0.5
    });

    const labelStartY = y - style.insetY - style.lineHeight + 3;
    labelLines.forEach((line, i) => {
      state.page.drawText(line, {
        x: x + style.insetX,
        y: labelStartY - i * style.lineHeight,
        size: style.bodyFontSize,
        font: fontBold,
        color: rgbFn(0.19, 0.29, 0.37)
      });
    });

    const valueStartY = y - style.insetY - style.lineHeight + 3;
    valueLines.forEach((line, i) => {
      state.page.drawText(line, {
        x: x + leftW + style.insetX,
        y: valueStartY - i * style.lineHeight,
        size: style.bodyFontSize,
        font: fontRegular,
        color: emphasize ? rgbFn(0.73, 0.12, 0.12) : rgbFn(0.1, 0.15, 0.2)
      });
    });

    y -= rowHeight;
  });

  return y - style.afterGap;
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
  rgbFn: PdfLibModule["rgb"]
) {
  const tableWidth = state.pageWidth - PAGE_MARGIN * 2;
  const leftW = tableWidth * 0.42;
  const rightW = tableWidth - leftW;
  const lineHeight = 12;
  const insetX = 8;
  const insetY = 6;

  drawSectionTitle(pdfDoc, state, title, reportDays, reportMode, headerImage, fontBold, rgbFn);

  const headerHeight = 22;
  ensureSpace(pdfDoc, state, headerHeight + 12, reportDays, reportMode, headerImage, fontBold, rgbFn);
  state.page.drawRectangle({
    x: PAGE_MARGIN,
    y: state.y - headerHeight,
    width: tableWidth,
    height: headerHeight,
    color: rgbFn(0.05, 0.43, 0.57),
    borderColor: rgbFn(0.05, 0.43, 0.57),
    borderWidth: 0.5
  });
  state.page.drawText("Field", {
    x: PAGE_MARGIN + insetX,
    y: state.y - headerHeight + 7,
    size: 10,
    font: fontBold,
    color: rgbFn(1, 1, 1)
  });
  state.page.drawText("Value", {
    x: PAGE_MARGIN + leftW + insetX,
    y: state.y - headerHeight + 7,
    size: 10,
    font: fontBold,
    color: rgbFn(1, 1, 1)
  });
  state.y -= headerHeight;

  rows.forEach(([label, value, emphasize], idx) => {
    const labelLines = splitLines(label, fontBold, 10, leftW - insetX * 2);
    const valueLines = splitLines(value, fontRegular, 10, rightW - insetX * 2);
    const lineCount = Math.max(labelLines.length, valueLines.length);
    const rowHeight = insetY * 2 + lineCount * lineHeight;

    ensureSpace(pdfDoc, state, rowHeight + 10, reportDays, reportMode, headerImage, fontBold, rgbFn);
    const fill = idx % 2 === 0 ? rgbFn(0.965, 0.98, 0.99) : rgbFn(1, 1, 1);

    state.page.drawRectangle({
      x: PAGE_MARGIN,
      y: state.y - rowHeight,
      width: tableWidth,
      height: rowHeight,
      color: fill,
      borderColor: rgbFn(0.82, 0.88, 0.93),
      borderWidth: 0.5
    });

    const labelStartY = state.y - insetY - lineHeight + 3;
    labelLines.forEach((line, i) => {
      state.page.drawText(line, {
        x: PAGE_MARGIN + insetX,
        y: labelStartY - i * lineHeight,
        size: 10,
        font: fontBold,
        color: rgbFn(0.19, 0.29, 0.37)
      });
    });

    const valueStartY = state.y - insetY - lineHeight + 3;
    valueLines.forEach((line, i) => {
      state.page.drawText(line, {
        x: PAGE_MARGIN + leftW + insetX,
        y: valueStartY - i * lineHeight,
        size: 10,
        font: fontRegular,
        color: emphasize ? rgbFn(0.73, 0.12, 0.12) : rgbFn(0.1, 0.15, 0.2)
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
  const headerImage = await tryEmbedHeaderImage(pdfDoc, headerDataUrl);

  const state: PdfState = {
    page: pdfDoc.addPage([PAGE_WIDTH_A4, PAGE_HEIGHT_A4]),
    y: PAGE_HEIGHT_A4 - PAGE_MARGIN,
    pageWidth: PAGE_WIDTH_A4,
    pageHeight: PAGE_HEIGHT_A4
  };
  drawHeader(state, report.daysInWindow, report.machine.mode, headerImage, fontBold, rgbFn);

  const patientRows: TableRow[] = [
    ["Patient", textValue(report.patientName)],
    ["Date of birth", textValue(report.dateOfBirth)]
  ];
  const machineRows = machineSettingRows(report);
  const therapyPressureRowsForMode = therapyPressureRows(report);
  const belowMedicareCompliance = isBelowMedicareComplianceThreshold(report);
  const belowMedicareNightlyUse = isBelowMedicareNightlyUseThreshold(report);
  const therapyRows: TableRow[] = [
    ["Date range", `${report.dateRangeStart} to ${report.dateRangeEnd}`],
    ["Days with data", `${report.daysWithData} / ${report.daysInWindow}`],
    ["Usage days (% of range)", `${report.usageDaysPercent.toFixed(1)}%`],
    ["Compliant days (>= 4h)", `${report.compliantDays} / ${report.daysInWindow}`, belowMedicareCompliance],
    ["Compliance (% of range)", `${report.compliancePercent.toFixed(1)}%`, belowMedicareCompliance],
    ["Avg usage per day", report.avgUsageHours === null ? NO_DATA_FALLBACK : `${valueText(report.avgUsageHours)} h`, belowMedicareNightlyUse],
    ...therapyPressureRowsForMode,
    ["Avg AHI", valueText(report.avgAhi)],
    ["95th AHI", valueText(report.ahi95th)],
    ["Avg Residual apneas", valueText(report.avgResidualApneas)],
    ["95th Residual apneas", valueText(report.residualApneas95th)],
    ["Avg Central apneas", valueText(report.avgCentralApneas)],
    ["95th Central apneas", valueText(report.centralApneas95th)],
    ["Avg RERA index", valueText(report.avgReraIndex)],
    leakRow("Avg Leak", report.avgLeak),
    leakRow("95th Leak", report.leak95th),
    leakRow("30 min Leak", report.maxLeak30m),
    leakRow("60 min Leak", report.maxLeak60m)
  ];

  const fullWidth = state.pageWidth - PAGE_MARGIN * 2;
  const columnGap = 10;
  const halfWidth = (fullWidth - columnGap) / 2;
  const availableHeight = state.y - (PAGE_MARGIN + FOOTER_BLOCK_HEIGHT);
  const layoutChoice =
    THERAPY_FONT_SIZES.flatMap((therapyFontSize) =>
      TABLE_STYLE_CANDIDATES.map((topStyle) => ({
        topStyle,
        therapyStyle: therapyTableStyle(therapyFontSize)
      }))
    ).find(({ topStyle, therapyStyle }) => {
      const topHeight = Math.max(
        measureCompactTableHeight("Patient Details", patientRows, halfWidth, topStyle, fontRegular, fontBold),
        measureCompactTableHeight("Machine Settings", machineRows, halfWidth, topStyle, fontRegular, fontBold)
      );
      const therapyHeight = measureCompactTableHeight(
        `Therapy Summary (Last ${report.daysInWindow} Days)`,
        therapyRows,
        fullWidth,
        therapyStyle,
        fontRegular,
        fontBold
      );
      return topHeight + therapyHeight <= availableHeight;
    }) ?? {
      topStyle: TABLE_STYLE_CANDIDATES[TABLE_STYLE_CANDIDATES.length - 1],
      therapyStyle: therapyTableStyle(THERAPY_MIN_FONT_SIZE)
    };

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
    rgbFn
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
    rgbFn
  );

  state.y = Math.min(patientBottom, machineBottom);
  state.y = drawCompactTableAt(
    state,
    PAGE_MARGIN,
    state.y,
    fullWidth,
    `Therapy Summary (Last ${report.daysInWindow} Days)`,
    therapyRows,
    layoutChoice.therapyStyle,
    fontRegular,
    fontBold,
    rgbFn
  );

  drawBottomFooterBlock(pdfDoc, state, report, headerImage, fontRegular, fontBold, rgbFn);

  const bytes = await pdfDoc.save();
  const blob = new Blob([bytes], { type: "application/pdf" });
  const filename = `${initialsFromName(report.patientName)}-${filenameDateStamp(new Date())}.pdf`;
  return { blob, filename };
}
