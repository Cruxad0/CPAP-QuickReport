# Security Baseline

## Security model

- Local-first processing: patient data is parsed in the browser session.
- No default backend persistence of PHI.
- Raw files and parsed therapy data are held only in a dedicated in-memory worker.
- Reset destroys and recreates the worker, revokes generated PDF object URLs, closes app-opened preview tabs, and clears browser storage plus patient/source inputs. Clinician branding stays in volatile memory for reuse.
- Page close/navigation terminates the worker, revokes generated PDF object URLs, closes app-opened preview tabs, clears session storage and script-accessible cookies, and preserves only the non-PHI warning preference in local storage.
- Detected SD-card identity is held only in volatile memory and is removed on reset or when the tab closes.
- Strict response headers (CSP, HSTS, COOP/CORP, no-referrer, nosniff).
- Minimal permissions policy; no browser access to camera/microphone/USB.

## Operational controls to enforce

1. Access control
- Require SSO and MFA on Vercel/GitHub.
- Restrict deploy permissions to approved engineering/admin users.

2. Data handling
- Keep this app in local-first mode unless BAA-approved storage architecture is implemented.
- Do not add analytics/session replay that captures PHI fields.
- Treat downloaded PDF reports as PHI; browser downloads and preview tabs that a browser prevents the app from closing are outside guaranteed reset/close cleanup.
- Browser close cleanup is best effort because browsers and operating systems control crash recovery, memory, and swap. Require encrypted managed endpoints.

3. Logging
- Avoid logging patient-entered values in browser console or server logs.
- If telemetry is introduced, redact PHI before transport/storage.

4. Secure SDLC
- Enable branch protection and required PR review.
- Enable dependency scanning and secret scanning.
- Patch dependencies on a fixed cadence.

5. Endpoint controls
- Use managed, encrypted workstations in clinical environments.
- Clear browser downloads and local temp files per clinic policy.

## Threat model summary

- Primary risk: accidental PHI exfiltration via future backend/analytics changes.
- Control: keep processing client-side and enforce code review policy for any network egress.
- Residual endpoint risk: downloaded reports, screenshots, print queues, browser/OS crash recovery, and memory/swap are controlled operationally rather than by this web app.
