"use client";

import JSZip from "jszip";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildQuickReportMetrics } from "@/lib/parser";
import { buildPdfReport } from "@/lib/pdf";
import { DataSourceKind, ParseProgress, QuickReportMetrics, SourceFile } from "@/lib/types";

function bytesToLabel(size: number): string {
  if (size > 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  if (size > 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

function getTodayIso() {
  return new Date().toISOString().slice(0, 10);
}

function defaultDobIso() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 50);
  return d.toISOString().slice(0, 10);
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.readAsDataURL(file);
  });
}

export function QuickReportApp() {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const headerInputRef = useRef<HTMLInputElement>(null);

  const [patientName, setPatientName] = useState("");
  const [dateOfBirthIso, setDateOfBirthIso] = useState(defaultDobIso());
  const [physicianName, setPhysicianName] = useState("Joel Rodriguez Ramos, MD");
  const [sourceKind, setSourceKind] = useState<DataSourceKind>("folder");
  const [sourceFiles, setSourceFiles] = useState<SourceFile[]>([]);
  const [headerDataUrl, setHeaderDataUrl] = useState<string | undefined>(undefined);

  const [status, setStatus] = useState<"idle" | "working" | "ready" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState("Awaiting data source.");
  const [parseProgress, setParseProgress] = useState<ParseProgress>({
    phase: "idle",
    detail: "Idle",
    percent: 0
  });

  const [report, setReport] = useState<QuickReportMetrics | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState("report.pdf");
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute("webkitdirectory", "");
      folderInputRef.current.setAttribute("directory", "");
    }
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const selectedCountLabel = useMemo(() => {
    if (sourceFiles.length === 0) return "No files selected";
    const total = sourceFiles.reduce((sum, f) => sum + f.size, 0);
    return `${sourceFiles.length} files selected (${bytesToLabel(total)})`;
  }, [sourceFiles]);

  const canGenerate =
    patientName.trim().length > 1 &&
    dateOfBirthIso.length > 0 &&
    physicianName.trim().length > 3 &&
    sourceFiles.length > 0 &&
    status !== "working";

  const resetResultState = () => {
    setReport(null);
    setErrors([]);
    setStatus("idle");
    setStatusMessage("Awaiting data source.");
    setParseProgress({ phase: "idle", detail: "Idle", percent: 0 });
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
  };

  const handleFolderSelection: React.ChangeEventHandler<HTMLInputElement> = (event) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;

    const mapped: SourceFile[] = files.map((file) => ({
      name: file.name,
      path: file.webkitRelativePath || file.name,
      size: file.size,
      readText: () => file.text(),
      readBytes: async () => new Uint8Array(await file.arrayBuffer())
    }));

    setSourceKind("folder");
    setSourceFiles(mapped);
    resetResultState();
  };

  const handleZipSelection: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
    const zipFile = event.target.files?.[0];
    if (!zipFile) return;

    setStatus("working");
    setStatusMessage("Reading ZIP archive locally...");
    setParseProgress({ phase: "zip", detail: "Opening ZIP file...", percent: 8 });

    try {
      const archive = await JSZip.loadAsync(zipFile);
      const entries = Object.values(archive.files)
        .filter((entry) => !entry.dir)
        .slice(0, 2500);

      const mapped: SourceFile[] = entries.map((entry) => {
        const sizeMaybe = Number((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
        return {
          name: entry.name.split("/").pop() ?? entry.name,
          path: entry.name,
          size: Number.isFinite(sizeMaybe) ? sizeMaybe : 0,
          readText: async () => await entry.async("string"),
          readBytes: async () => await entry.async("uint8array")
        };
      });

      setSourceKind("zip");
      setSourceFiles(mapped);
      setStatus("idle");
      setStatusMessage(`ZIP loaded: ${mapped.length} files available for parsing.`);
      setParseProgress({ phase: "ready", detail: "ZIP ready", percent: 100 });
      setReport(null);
      setErrors([]);
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        setPreviewUrl(null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not parse ZIP file.";
      setStatus("error");
      setErrors([message]);
      setStatusMessage("ZIP import failed.");
      setParseProgress({ phase: "error", detail: "ZIP import failed", percent: 0 });
    }
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

  const handleGenerate = async () => {
    if (!canGenerate) return;

    setStatus("working");
    setErrors([]);
    setStatusMessage("Processing files locally in this browser...");
    setParseProgress({ phase: "start", detail: "Preparing workflow...", percent: 2 });

    try {
      const metrics = await buildQuickReportMetrics({
        sourceKind,
        files: sourceFiles,
        patientName,
        dateOfBirthIso,
        physicianName,
        onProgress: (p) => setParseProgress(p)
      });

      setParseProgress({ phase: "pdf", detail: "Rendering PDF...", percent: 98 });
      const { blob, filename } = await buildPdfReport(metrics, headerDataUrl);

      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const url = URL.createObjectURL(blob);

      setReport(metrics);
      setDownloadName(filename);
      setPreviewUrl(url);
      setStatus("ready");
      setStatusMessage("Report generated successfully. Review preview and export PDF.");
      setParseProgress({ phase: "done", detail: "Done", percent: 100 });
      if (metrics.warnings.length > 0) setErrors(metrics.warnings);
    } catch (error) {
      const message = error instanceof Error ? error.message : "An unexpected error occurred.";
      setStatus("error");
      setStatusMessage("Report generation failed.");
      setErrors([message]);
      setParseProgress({ phase: "error", detail: "Failed", percent: 0 });
    }
  };

  const triggerDownload = () => {
    if (!previewUrl) return;
    const a = document.createElement("a");
    a.href = previewUrl;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <main>
      <section className="hero">
        <h1>CPAP Clinician QuickReport (Web)</h1>
        <p>
          Local-first workflow for any work computer. Files are processed in-browser to produce a 90-day PDF handout.
        </p>
      </section>

      <section className="grid">
        <article className="card col-4">
          <h3>Patient</h3>
          <label htmlFor="patientName">Patient name</label>
          <input
            id="patientName"
            className="input"
            value={patientName}
            onChange={(e) => setPatientName(e.target.value)}
            placeholder="First Last"
            autoComplete="off"
          />

          <label htmlFor="dob" style={{ marginTop: 10 }}>
            Date of birth
          </label>
          <input
            id="dob"
            className="date-input"
            type="date"
            max={getTodayIso()}
            value={dateOfBirthIso}
            onChange={(e) => setDateOfBirthIso(e.target.value)}
          />

          <label htmlFor="physician" style={{ marginTop: 10 }}>
            Physician name
          </label>
          <input
            id="physician"
            className="input"
            value={physicianName}
            onChange={(e) => setPhysicianName(e.target.value)}
            autoComplete="off"
          />

          <label htmlFor="header-upload" style={{ marginTop: 10 }}>
            Optional PDF header image
          </label>
          <input id="header-upload" ref={headerInputRef} type="file" accept="image/png,image/jpeg" onChange={handleHeaderUpload} />
          <p className="subtle">Use clinic branding image if desired. If omitted, a neutral header is used.</p>
        </article>

        <article className="card col-8">
          <h3>Data Source</h3>
          <p className="subtle">
            Import SD card folder (preferred) or ZIP export. Only the most recent 90 days are included in report metrics.
          </p>

          <div className="actions">
            <button className="btn btn-secondary" onClick={() => folderInputRef.current?.click()}>
              Select SD Folder
            </button>
            <button className="btn btn-secondary" onClick={() => zipInputRef.current?.click()}>
              Select ZIP Export
            </button>
            <button className="btn btn-danger" onClick={() => setSourceFiles([])} disabled={status === "working" || sourceFiles.length === 0}>
              Clear Files
            </button>
          </div>

          <input ref={folderInputRef} type="file" multiple onChange={handleFolderSelection} style={{ display: "none" }} />
          <input ref={zipInputRef} type="file" accept=".zip" onChange={handleZipSelection} style={{ display: "none" }} />

          <p style={{ marginTop: 12 }}>
            <strong>Source:</strong> {sourceKind.toUpperCase()} | <strong>Status:</strong> {selectedCountLabel}
          </p>

          <div className="file-list" aria-live="polite">
            <ul>
              {sourceFiles.slice(0, 25).map((file) => (
                <li key={`${file.path}:${file.size}`}>
                  {file.path} <span className="subtle">({bytesToLabel(file.size)})</span>
                </li>
              ))}
            </ul>
            {sourceFiles.length > 25 ? <p className="subtle">+ {sourceFiles.length - 25} more files</p> : null}
          </div>

          <div className="actions">
            <button className="btn btn-primary" onClick={handleGenerate} disabled={!canGenerate}>
              Generate 90-Day PDF
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                resetResultState();
                setSourceFiles([]);
              }}
              disabled={status === "working"}
            >
              Reset
            </button>
          </div>

          <div className="progress-wrap" role="status" aria-live="polite">
            <div className="progress-track">
              <div className="progress-value" style={{ width: `${parseProgress.percent}%` }} />
            </div>
            <div className="phase">
              {parseProgress.percent}% - {parseProgress.detail}
            </div>
          </div>
        </article>

        <article className="card col-12">
          <div className="actions" style={{ marginTop: 0 }}>
            {status === "ready" ? <span className="badge badge-ok">Ready</span> : null}
            {status === "working" ? <span className="badge badge-warn">Working</span> : null}
            {status === "error" ? <span className="badge badge-error">Error</span> : null}
            <span className="subtle">{statusMessage}</span>
          </div>

          {errors.length > 0 ? (
            <ul className="notes">
              {errors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          ) : null}

          {report ? (
            <ul className="notes">
              <li>Date range: {report.dateRangeStart} to {report.dateRangeEnd}</li>
              <li>Days with data: {report.daysWithData} / {report.daysInWindow}</li>
              <li>Compliance: {report.compliancePercent.toFixed(1)}%</li>
            </ul>
          ) : null}
        </article>

        {previewUrl ? (
          <article className="card col-12 preview-shell">
            <div className="actions" style={{ marginTop: 0 }}>
              <button className="btn btn-primary" onClick={triggerDownload}>
                Export PDF
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  URL.revokeObjectURL(previewUrl);
                  setPreviewUrl(null);
                }}
              >
                Close Preview
              </button>
              <span className="subtle">Default filename: {downloadName}</span>
            </div>
            <iframe className="preview-frame" src={previewUrl} title="PDF preview" />
          </article>
        ) : null}
      </section>
    </main>
  );
}
