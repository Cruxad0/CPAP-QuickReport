import { QuickReportMetrics } from "@/lib/types";

const PAGE_WIDTH_A4 = 595.28;
const PAGE_HEIGHT_A4 = 841.89;
const PAGE_MARGIN = 18; // 0.25 in

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

function valueText(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
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

function drawDefaultHeader(state: PdfState, fontBold: any, rgbFn: PdfLibModule["rgb"]) {
  state.page.drawText("CPAP 90-Day Quick Report", {
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

function drawHeader(state: PdfState, headerImage: any | undefined, fontBold: any, rgbFn: PdfLibModule["rgb"]) {
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
  drawDefaultHeader(state, fontBold, rgbFn);
}

function ensureSpace(
  pdfDoc: any,
  state: PdfState,
  neededHeight: number,
  headerImage: any | undefined,
  fontBold: any,
  rgbFn: PdfLibModule["rgb"]
) {
  if (state.y - neededHeight >= PAGE_MARGIN) return;
  state.page = pdfDoc.addPage([PAGE_WIDTH_A4, PAGE_HEIGHT_A4]);
  state.pageWidth = state.page.getWidth();
  state.pageHeight = state.page.getHeight();
  state.y = state.pageHeight - PAGE_MARGIN;
  drawHeader(state, headerImage, fontBold, rgbFn);
}

function drawSectionTitle(
  pdfDoc: any,
  state: PdfState,
  title: string,
  headerImage: any | undefined,
  fontBold: any,
  rgbFn: PdfLibModule["rgb"]
) {
  ensureSpace(pdfDoc, state, 30, headerImage, fontBold, rgbFn);
  state.page.drawText(title, {
    x: PAGE_MARGIN,
    y: state.y - 12,
    size: 12,
    font: fontBold,
    color: rgbFn(0.07, 0.31, 0.49)
  });
  state.y -= 18;
}

type TableRow = [string, string];

function drawTable(
  pdfDoc: any,
  state: PdfState,
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

  drawSectionTitle(pdfDoc, state, title, headerImage, fontBold, rgbFn);

  const headerHeight = 22;
  ensureSpace(pdfDoc, state, headerHeight + 12, headerImage, fontBold, rgbFn);
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

    ensureSpace(pdfDoc, state, rowHeight + 10, headerImage, fontBold, rgbFn);
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
  drawHeader(state, headerImage, fontBold, rgbFn);

  state.page.drawText(`Generated: ${report.generatedAtDisplay}`, {
    x: PAGE_MARGIN,
    y: state.y - 10,
    size: 10,
    font: fontRegular,
    color: rgbFn(0.12, 0.22, 0.31)
  });
  state.y -= 18;

  drawTable(
    pdfDoc,
    state,
    "Patient Details",
    [
      ["Patient", report.patientName],
      ["Date of birth", report.dateOfBirth]
    ],
    headerImage,
    fontRegular,
    fontBold,
    rgbFn
  );

  drawTable(
    pdfDoc,
    state,
    "Machine Settings",
    [
      ["Device", report.machine.device ?? "n/a"],
      ["Mode", report.machine.mode ?? "n/a"],
      ["Pressure", report.machine.pressure ?? "n/a"],
      ["Pressure relief", report.machine.pressureRelief ?? "n/a"]
    ],
    headerImage,
    fontRegular,
    fontBold,
    rgbFn
  );

  drawTable(
    pdfDoc,
    state,
    "Therapy Summary (Last 90 Days)",
    [
      ["Date range", `${report.dateRangeStart} to ${report.dateRangeEnd}`],
      ["Days with data", `${report.daysWithData} / ${report.daysInWindow}`],
      ["Usage days (% of range)", `${report.usageDaysPercent.toFixed(1)}%`],
      ["Compliant days (>= 4h)", `${report.compliantDays}`],
      ["Compliance (% of range)", `${report.compliancePercent.toFixed(1)}%`],
      ["Average usage", `${valueText(report.avgUsageHours)} h`],
      ["Average AHI", valueText(report.avgAhi)],
      ["95th AHI", valueText(report.ahi95th)],
      ["Average leak", report.avgLeak === null ? "n/a" : `${valueText(report.avgLeak)} L/min`],
      ["Max leak", report.maxLeak === null ? "n/a" : `${valueText(report.maxLeak)} L/min`]
    ],
    headerImage,
    fontRegular,
    fontBold,
    rgbFn
  );

  ensureSpace(pdfDoc, state, 72, headerImage, fontBold, rgbFn);
  state.page.drawText(`Physician: ${report.physicianName}`, {
    x: PAGE_MARGIN,
    y: state.y - 10,
    size: 11,
    font: fontBold,
    color: rgbFn(0.12, 0.2, 0.27)
  });
  state.y -= 18;

  const bytes = await pdfDoc.save();
  const blob = new Blob([bytes], { type: "application/pdf" });
  const filename = `${initialsFromName(report.patientName)}-${filenameDateStamp(new Date())}.pdf`;
  return { blob, filename };
}
