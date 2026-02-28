# Security Baseline

## Security model

- Local-first processing: patient data is parsed in the browser session.
- No default backend persistence of PHI.
- Strict response headers (CSP, HSTS, COOP/CORP, no-referrer, nosniff).
- Minimal permissions policy; no browser access to camera/microphone/USB.

## Operational controls to enforce

1. Access control
- Require SSO and MFA on Vercel/GitHub.
- Restrict deploy permissions to approved engineering/admin users.

2. Data handling
- Keep this app in local-first mode unless BAA-approved storage architecture is implemented.
- Do not add analytics/session replay that captures PHI fields.

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
