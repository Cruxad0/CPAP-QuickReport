# HIPAA Readiness Checklist (Implementation-Oriented)

This checklist is for implementation readiness, not legal advice.

## 1) Scope and governance

- [ ] Define covered entity / business associate roles.
- [ ] Determine whether a BAA is required for each service provider.
- [ ] Maintain a current data-flow diagram and asset inventory.

## 2) Minimum necessary data

- [ ] Collect only data required for report generation.
- [ ] Avoid storing raw SD card data after report export unless policy requires it.
- [ ] Avoid backend PHI transfer in default app path.

## 3) Identity and access

- [ ] SSO + MFA required for all deployment and admin accounts.
- [ ] Role-based access for source code, deployments, and secrets.
- [ ] Immediate offboarding process for staff changes.

## 4) Encryption

- [ ] HTTPS/TLS enforced end-to-end.
- [ ] Disk encryption on all work computers.
- [ ] Encrypt any backup artifacts containing PHI.
- [ ] Verify browser/OS crash recovery and swap behavior on managed clinical endpoints.

## 5) Audit and monitoring

- [ ] Centralized audit logs for repository and deployment changes.
- [ ] Alerting on suspicious access or secret exposure.
- [ ] Documented incident response runbook.

## 6) Application controls

- [x] No PHI in client/server logs in the current default path.
- [ ] Input validation for user-provided metadata.
- [x] Security headers and CSP enabled.
- [x] No persistent browser storage of raw or analyzed therapy data in the current default path.
- [x] Reset destroys the in-memory worker and clears patient/source inputs, generated PDF URLs, app-opened preview tabs, and site storage; clinician branding remains only in volatile memory.
- [x] Page close/navigation performs best-effort worker, object URL, and session cleanup.
- [ ] Dependency vulnerability scanning enabled.

## 7) Business continuity

- [ ] Backup/recovery plan for source code and deployment config.
- [ ] Regular restore testing.

## 8) Validation before go-live

- [ ] Security review completed.
- [ ] Privacy review completed.
- [ ] Legal/compliance signoff completed.
- [ ] Clinical workflow UAT completed.
