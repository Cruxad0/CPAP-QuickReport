# NIMV Clinician QuickReport Web (Vercel + Node 24)

Local-first NIMV / PAP quick-report web app for clinician workflows.

The app is designed to run on any work computer, process device data locally in the browser, and generate a compact PDF report without sending patient data to a backend service.

## What the app does

- Imports PAP / NIMV data from an SD-card root folder.
- Detects the device family from card structure and uses a family-specific parser.
- Builds `90 / 60 / 30 / 7` day reports from one prepared dataset.
- Uses a noon-to-noon clinical day.
- Anchors the latest included day to `yesterday 12:00 PM -> today 12:00 PM`, using the card's explicit UTC offset when the device exposes one.
- Generates an A4 PDF preview and export.
- Keeps processing local to the browser in the default architecture.

## Supported device families

Loadable quick-report families currently include:

- Resvent / Hoffrichter
- ResMed
- Philips Respironics System One / DreamStation
- Philips Respironics M-Series
- Loewenstein / Prisma
- Weinmann / Loewenstein
- Apex / BMC / Luna
- ReactHealth / BMC G3 / G3X
- Yuwell YH-series
- DeVilbiss IntelliPAP
- Fisher & Paykel SleepStyle
- Fisher & Paykel ICON
- vREM

For the full engineering support matrix, including parser depth and recognized-but-rejected loaders, see:

- [docs/loader-support-matrix.md](/Users/joelrodz/Sites/oscar-clinician-work/docs/loader-support-matrix.md)

## Verified validation sources

The current parser stack has been exercised against:

- public ResMed fixtures from [CascadePass/CPAP-Exporter](https://github.com/CascadePass/CPAP-Exporter)
- real Resvent sample card
- real Luna II sample card
- real Philips DreamStation sample card

Real-card smoke-test workflow is documented in:

- [docs/real-card-smoke-tests.md](/Users/joelrodz/Sites/oscar-clinician-work/docs/real-card-smoke-tests.md)

## Quick start

```bash
nvm use 24
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Browser usage

1. Enter patient name and date of birth.
2. Click `Select SD-CARD`.
3. Choose the `SD-card root folder`.
4. Do not choose a deep subfolder unless you know the family-specific layout.
5. Click `Generate Reports`.
6. Review the `90 / 60 / 30 / 7` day tabs in preview.
7. Export the PDF when ready.

Root-folder selection is the recommended workflow even for families that can sometimes be detected from a vendor subfolder.

## Development commands

```bash
npm run dev
npm run typecheck
npm run test
npm run build
```

## Real-card regression testing

Copy the example manifest:

```bash
cp /Users/joelrodz/Sites/oscar-clinician-work/tests/fixtures/real-cards.manifest.example.json \
   /Users/joelrodz/Sites/oscar-clinician-work/tests/fixtures/real-cards.manifest.local.json
```

Then point each entry to a real card root or local snapshot and run:

```bash
npm run test
```

## Architecture notes

- Parsing and PDF generation are client-side.
- Heavy import and report work runs in a worker where supported.
- No server API routes are used for PHI processing in the default design.
- Security headers are configured in [next.config.ts](/Users/joelrodz/Sites/oscar-clinician-work/next.config.ts).
- Support status and parity depth are tracked in [docs/loader-support-matrix.md](/Users/joelrodz/Sites/oscar-clinician-work/docs/loader-support-matrix.md).

## Important compliance note

This repository provides a privacy-forward technical baseline, not legal certification.

You are responsible for:

- HIPAA legal review
- internal policy and operational controls
- access controls and auditing
- vendor review and BAA decisions

See:

- [HIPAA_CHECKLIST.md](/Users/joelrodz/Sites/oscar-clinician-work/HIPAA_CHECKLIST.md)
- [SECURITY.md](/Users/joelrodz/Sites/oscar-clinician-work/SECURITY.md)

## Copyright and distribution

Parser behavior derived from OSCAR and OSCAR-SQL remains subject to GNU GPLv3
distribution requirements and attribution. See [NOTICE.md](NOTICE.md).
