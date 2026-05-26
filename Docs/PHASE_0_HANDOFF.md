# Phase 0 Hand-off — external accounts

A few tasks in §20 require accounts I (Claude) cannot create. Run these once and the rest of Phase 0 closes.

## P0-04 / P0-07 — Vercel + preview deploys

1. Create a Vercel account (or use existing) and a new project named `trace`.
2. Connect it to the GitHub repo (create the repo first — see below).
3. Project settings:
   - **Framework preset:** Vite
   - **Root directory:** `apps/web`
   - **Build command:** `pnpm turbo run build --filter=@trace/web`
   - **Install command:** `pnpm install --frozen-lockfile`
   - **Output directory:** `dist`
   - **Node version:** 20.x
4. Add environment variables (Production + Preview):
   - `VITE_SENTRY_DSN` (after Sentry is set up — optional)
   - `VITE_RELEASE` is set per-build by CI; nothing to add here.
5. Push to `main` → first prod deploy. Open a PR → preview URL appears as a check.

The `vercel.json` already lives at `apps/web/vercel.json` and sets COOP/COEP + asset caching per blueprint §11.

## P0-08 — Sentry

1. Create a Sentry org + a project of type "React".
2. Copy the DSN.
3. Generate an internal integration auth token with `project:releases` + `project:write`.
4. Add these as **repo secrets** in GitHub (Settings → Secrets and variables → Actions):
   - `VITE_SENTRY_DSN` — used at runtime
   - `SENTRY_AUTH_TOKEN` — used by `@sentry/vite-plugin` to upload sourcemaps
   - `SENTRY_ORG`
   - `SENTRY_PROJECT`
5. Add the same envs in Vercel for Production + Preview.

`apps/web/src/sentry.ts` is a no-op when `VITE_SENTRY_DSN` is unset, so steps 1–5 are not blocking for local dev.

## GitHub remote (prerequisite to the above)

1. Create a new GitHub repo named `trace` (private is fine).
2. From this working tree:

   ```bash
   git remote add origin git@github.com:<org>/trace.git
   git branch -M main
   git push -u origin main
   ```

3. In GitHub repo settings:
   - Branch protection on `main`: require status checks `ci / build`, require linear history, require PR review (≥ 1).
   - Disable merge commits in favor of squash-merge for cleaner history (optional).

## Exit gate for Phase 0

Per blueprint §20:

- `pnpm dev` brings up the app — ✅ done locally.
- A PR opens a preview URL — needs Vercel (above).
- CI green and < 8 minutes — workflow is at `.github/workflows/ci.yml`, timeout 8m; will run on first push.

Once Vercel is connected and the first PR opens a preview URL, Phase 0 is closed and Phase 1 W1 starts (P1-01 hub UI shell, P1-02 manifest schemas).
