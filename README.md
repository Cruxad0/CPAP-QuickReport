# CPAP QuickReport Web (Vercel + Node 24)

Local-first CPAP report app for use on any work computer.

## What this project does

- Runs as a web app hosted on Vercel.
- Processes CPAP data locally in the browser (folder or ZIP input).
- Limits report calculations to the latest 90 days.
- Generates A4 PDF output with 0.25in margins and clinician signature area.
- Does not require PHI upload to backend services in default architecture.

## Quick start

```bash
nvm use 24
npm install
npm run dev
```

Open `http://localhost:3000`.

## Production deployment (Vercel)

1. Push to GitHub.
2. Import repo in Vercel.
3. Set Node runtime to `24.x` (project settings), or rely on `engines.node`.
4. Deploy.

## Browser usage

1. Enter patient name + date of birth.
2. Select SD card folder (Chromium browsers) or ZIP export.
3. Click **Generate 90-Day PDF**.
4. Review preview, then **Export PDF**.

## Architecture notes

- Parsing and PDF generation are client-side.
- No server API routes are used for PHI processing in the default design.
- Security headers are enforced in `next.config.ts`.

## Important compliance note

This repository provides a privacy-forward technical baseline, not legal certification.
You are responsible for HIPAA legal review, policy implementation, BAA needs, and operational controls.
See:

- `HIPAA_CHECKLIST.md`
- `SECURITY.md`
