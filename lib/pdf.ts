import { QuickReportMetrics } from "@/lib/types";

const PAGE_WIDTH_A4 = 595.28;
const PAGE_HEIGHT_A4 = 841.89;
const PAGE_MARGIN = 18; // 0.25 in
const NO_DATA_FALLBACK = "Data point not available";

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

function headerModeText(mode: string | undefined): string {
  const normalized = mode?.trim();
  return normalized && normalized.length > 0 ? normalized : "CPAP";
}

function drawDefaultHeader(state: PdfState, reportDays: number, reportMode: string | undefined, fontBold: any, rgbFn: PdfLibModule["rgb"]) {
  state.page.drawText(`${headerModeText(reportMode)} ${reportDays}-Day Quick Report`, {
    x: PAGE_MARGIN,
    y: state.y - 16,
    size: 18,
    font: fontBold,
    color: rgbFn(0.07, 0.31, 0.49)
  });
  state.y -= 26;
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
    const maxWidth = state.pageWidth - PAGE_MARGIN * 2;
    const ratio = headerImage.height / headerImage.width;
    const height = Math.min(92, maxWidth * ratio);
    state.page.drawImage(headerImage, {
      x: PAGE_MARGIN,
      y: state.y - height,
      width: maxWidth,
      height
    });
    state.y -= height + 6;
    return;
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
    size: 12,
    font: fontBold,
    color: rgbFn(0.07, 0.31, 0.49)
  });
  state.y -= 18;
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
  const requiredHeight = 82;
  if (state.y - requiredHeight < PAGE_MARGIN) {
    startNewPage(pdfDoc, state, report.daysInWindow, report.machine.mode, headerImage, fontBold, rgbFn);
  }

  const baseY = PAGE_MARGIN + 6;
  const physicianY = baseY + 52;
  const signatureY = baseY + 30;
  const generatedY = baseY + 8;

  const physicianNameText = report.physicianName?.trim() ?? "";
  state.page.drawText(`Physician:${physicianNameText ? ` ${physicianNameText}` : ""}`, {
    x: PAGE_MARGIN,
    y: physicianY,
    size: 11,
    font: fontBold,
    color: rgbFn(0.12, 0.2, 0.27)
  });

  state.page.drawText("Signature:", {
    x: PAGE_MARGIN,
    y: signatureY,
    size: 11,
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

type TableRow = [string, string];

function isAutoPapMode(mode: string | undefined): boolean {
  if (!mode) return false;
  return /\b(auto\s*pap|auto\s*cpap|apap|autoset|vauto|auto[-\s]*bipap|autobilevel)\b/i.test(mode);
}

function isBiPapMode(mode: string | undefined): boolean {
  if (!mode) return false;
  return /\b(bipap|bi[-\s]*level|bilevel|vpap|lumis|avaps|s\/t|st)\b/i.test(mode);
}

function machineSettingRows(report: QuickReportMetrics): TableRow[] {
  const rows: TableRow[] = [
    ["Device", textValue(report.machine.device)],
    ["Mode", textValue(report.machine.mode)]
  ];

  const mode = report.machine.mode?.trim() ?? "";
  const hasAutoPressure =
    report.machine.pressureIsAuto === true ||
    Boolean(report.machine.pressureMin) ||
    Boolean(report.machine.pressureMax) ||
    typeof report.machine.pressureAvg === "number" ||
    typeof report.machine.pressure95th === "number";
  const isBiPap = isBiPapMode(mode);
  const isAutoPap = !isBiPap && (isAutoPapMode(mode) || (!mode && hasAutoPressure));

  if (isBiPap) {
    rows.push(["IPAP", textValue(report.machine.ipap)]);
    rows.push(["EPAP", textValue(report.machine.epap)]);
    rows.push(["Respiratory rate (RR)", textValue(report.machine.respiratoryRate)]);
  } else if (isAutoPap) {
    rows.push(["Min pressure", textValue(report.machine.pressureMin)]);
    rows.push(["Max pressure", textValue(report.machine.pressureMax)]);
    rows.push([
      "Avg Pressure",
      report.machine.pressureAvg === null || report.machine.pressureAvg === undefined
        ? NO_DATA_FALLBACK
        : `${valueText(report.machine.pressureAvg)} cmH2O`
    ]);
    rows.push([
      "95th Pressure",
      report.machine.pressure95th === null || report.machine.pressure95th === undefined
        ? NO_DATA_FALLBACK
        : `${valueText(report.machine.pressure95th)} cmH2O`
    ]);
  } else {
    rows.push(["Pressure", textValue(report.machine.pressure)]);
  }

  rows.push(["Pressure relief", textValue(report.machine.pressureRelief)]);
  return rows;
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

  rows.forEach(([label, value], idx) => {
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
        color: rgbFn(0.1, 0.15, 0.2)
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

  drawTable(
    pdfDoc,
    state,
    report.daysInWindow,
    report.machine.mode,
    "Patient Details",
    [
      ["Patient", textValue(report.patientName)],
      ["Date of birth", textValue(report.dateOfBirth)]
    ],
    headerImage,
    fontRegular,
    fontBold,
    rgbFn
  );

  drawTable(
    pdfDoc,
    state,
    report.daysInWindow,
    report.machine.mode,
    "Machine Settings",
    machineSettingRows(report),
    headerImage,
    fontRegular,
    fontBold,
    rgbFn
  );

  drawTable(
    pdfDoc,
    state,
    report.daysInWindow,
    report.machine.mode,
    `Therapy Summary (Last ${report.daysInWindow} Days)`,
    [
      ["Date range", `${report.dateRangeStart} to ${report.dateRangeEnd}`],
      ["Days with data", `${report.daysWithData} / ${report.daysInWindow}`],
      ["Usage days (% of range)", `${report.usageDaysPercent.toFixed(1)}%`],
      ["Compliant days (>= 4h)", `${report.compliantDays} / ${report.daysWithUsage}`],
      ["Compliance (% of usage days)", `${report.compliancePercent.toFixed(1)}%`],
      ["Avg usage per day", report.avgUsageHours === null ? NO_DATA_FALLBACK : `${valueText(report.avgUsageHours)} h`],
      ["Avg AHI", valueText(report.avgAhi)],
      ["95th AHI", valueText(report.ahi95th)],
      ["Avg Residual apneas", valueText(report.avgResidualApneas)],
      ["95th Residual apneas", valueText(report.residualApneas95th)],
      ["Avg Central apneas", valueText(report.avgCentralApneas)],
      ["95th Central apneas", valueText(report.centralApneas95th)],
      ["Avg RERA index", valueText(report.avgReraIndex)],
      ["Avg Leak", report.avgLeak === null ? NO_DATA_FALLBACK : `${valueText(report.avgLeak)} L/min`],
      ["Max leak", report.maxLeak === null ? NO_DATA_FALLBACK : `${valueText(report.maxLeak)} L/min`]
    ],
    headerImage,
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
