# Vercel Deployment (Node 24)

## 1) Repository setup

1. Create a GitHub repo and push this project.
2. In Vercel, click **Add New Project** and import the repo.

## 2) Runtime settings

- Framework: Next.js
- Node: 24.x (from `package.json` engines or project settings)
- Build command: `npm run build`
- Install command: `npm ci`

## 3) Environment variables

No runtime secrets are required for the current local-first architecture.

## 4) Recommended Vercel project settings

- Enable deployment protection and team access controls.
- Restrict production deploy permissions.
- Keep logs retention minimal and avoid PHI in logs.

## 5) Smoke test after deploy

1. Open deployed URL.
2. Import a sample SD-card folder.
3. Generate PDF.
4. Confirm no network egress of PHI fields in browser DevTools.
