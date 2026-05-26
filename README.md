# Trace

Browser-native motorsport sandbox. Hub world + addressable zones + a player passport.

> The binding spec is [`Docs/TRACE_BLUEPRINT.md`](Docs/TRACE_BLUEPRINT.md).
> Architecture in §1–§18, week-by-week plan in §19–§24. Cite section numbers
> and task IDs (e.g. `P1-23`) in commits and PRs.

## Quickstart

Requires Node ≥ 20.11 and pnpm ≥ 9.

```bash
pnpm install
pnpm dev          # http://localhost:5173 — Hello Trace
pnpm build        # production build of apps/web
pnpm typecheck    # tsc across the workspace
pnpm lint         # ESLint across the workspace
pnpm test         # Vitest across the workspace
pnpm test:e2e     # Playwright (apps/web only)
pnpm trace asset ingest path/to.glb --kind zone --id zone_demo  # asset CLI stub
```

## Layout

```
trace/
├─ apps/web/                  # The whole product. Vite + React + Three. Deploys to Vercel.
├─ packages/
│  ├─ trace-core/             # Pure TS: math, types, manifests, scoring.
│  ├─ trace-physics/          # Rapier wrapper + vehicle controller + profiles.
│  ├─ trace-softbody/         # Mass-spring solver + skinning (runs in a worker).
│  ├─ trace-renderer/         # Three.js scene factory, materials, decals, LOD.
│  └─ trace-editor/           # Click-tool engine (sidecar fitter, undo).
└─ tools/asset-cli/           # Local CLI: decimate, KTX2, Draco, collider, proxy.
```

See blueprint §4 for the rationale. **One** deployable app in Phase 1 (`apps/web`); framework-agnostic packages can later run in Web Workers or Node.

## Phase 0 status

This commit is the Phase 0 foundation per blueprint §20:

- ✅ P0-01 pnpm monorepo skeleton
- ✅ P0-02 TS strict, ESLint flat config, Prettier, lint-staged, EditorConfig
- ✅ P0-03 Vite app boots with "Hello Trace"
- ✅ P0-05 `vercel.json` with COOP/COEP + immutable asset caching
- ✅ P0-06 GitHub Actions CI: format / lint / typecheck / unit / build
- ✅ P0-08 Sentry client init (no-op without DSN) + sourcemap step
- ✅ P0-09 Zustand store + TanStack Router skeleton
- ✅ P0-10 `tools/asset-cli` no-op pipeline
- ✅ P0-11 README + CONTRIBUTING + PR template
- ⏳ P0-04, P0-07 Vercel connection & preview deploys — needs Vercel account + GitHub remote (see `Docs/PHASE_0_HANDOFF.md`)

## House rules (blueprint §18)

1. TypeScript strict. No `any`. `unknown` at boundaries.
2. Validate at every external boundary with Zod.
3. No singletons of mutable state — factories, not globals.
4. Hot paths allocate zero — reuse scratch pads, avoid `.map`/`.filter` per frame.
5. Package barrels: `import { Spline } from '@trace/core'`, not deep paths.
6. One reason to exist per file.
7. Comments answer **why**, not **what**.
8. File names `kebab-case.ts`; types `PascalCase`; constants `SCREAMING_SNAKE`.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) and cite blueprint task IDs in PR titles.
