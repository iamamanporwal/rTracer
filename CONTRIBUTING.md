# Contributing to Trace

The [blueprint](Docs/TRACE_BLUEPRINT.md) is the contract. The PRD is the spec. The week plan is the order. If they disagree, fix the doc, not the code.

## Workflow

1. Pick a task from the current week's table in §21 (or the Phase 0 table in §20).
2. Branch: `git checkout -b p1-23-softbody-solver`.
3. Implement. Write tests at the same time, not after.
4. Run `pnpm lint && pnpm typecheck && pnpm test` locally before pushing.
5. Open a PR. Title is `[P1-23] Soft-body solver`. The template covers the rest.

## PR title format

```
[P{phase}-{NN}] short summary
```

Examples:

- `[P0-03] Vite app boots with Hello Trace`
- `[P1-23] Soft-body solver — analytical spring test`
- `[P1-46] LapTimer reads sidecar start/finish`

## Definition of Done (blueprint §24)

Every task:

- [ ] Title cites the task ID.
- [ ] CI green: lint, typecheck, unit, integration, e2e.
- [ ] Perf regression gate green (p99 frame time within 10% of baseline).
- [ ] If it touches a `packages/*` public API: TSDoc + example updated.
- [ ] If it touches a manifest schema: Zod schema diff included in the PR.
- [ ] If it changes a budget: blueprint §16 updated in the same PR.
- [ ] Manually verified on desktop **and** mobile preview.
- [ ] Reviewed by ≥ 1 other engineer in the area.

## Coding standards (blueprint §18)

| Rule                                         | Notes                                             |
| -------------------------------------------- | ------------------------------------------------- |
| TypeScript strict                            | No `any`. `unknown` at boundaries, narrow inside  |
| Validate at every external boundary          | Zod for manifests, postMessage, IDB, fetch        |
| No singletons of mutable state               | `createX()` factories; tests own their instance   |
| Hot paths allocate zero                      | Reuse `THREE.Vector3` scratch pads                |
| Package barrels                              | `import { x } from '@trace/core'`, not deep paths |
| One reason per file                          | Two unrelated things → split                      |
| TSDoc + example on every `packages/*` export |                                                   |
| No `console.log` in commits                  | Use the typed `logger` (`debug/info/warn/error`)  |
| Comments answer "why", not "what"            |                                                   |
| Files `kebab-case.ts`                        | Types `PascalCase`, constants `SCREAMING_SNAKE`   |

## Branch hygiene

- Feature branches are short-lived. Rebase onto `main` daily; don't merge from `main`.
- One task per PR. If you find a separate issue, file it or open a separate PR.
- Don't bundle refactors with feature work.

## Performance gates

Every PR's CI runs a 60-second canned drive (see §17.1). A p99 frame-time regression > 10% blocks merge. The fix is to descope or revert — never to widen the budget.

## Local environment

- Node ≥ 20.11 (see `.nvmrc`). Vite 5 expects ≥ 18; we pin to 20 for CI parity.
- pnpm ≥ 9. `npm i -g pnpm@9.12.3` is the simplest install path.
- Windows + PowerShell users: `pnpm` works from both PowerShell and bash. Watch out for `&&` in PS 5.1 — use `;` or update to PowerShell 7.

## Asset CLI

```bash
pnpm trace asset ingest path/to.glb --kind zone --id zone_demo
```

Phase 0: this is a no-op that prints the planned stages. Phase 1 Week 4 implements decimate/KTX2/Draco/collider.

## Hooks

`pnpm install` runs `husky` (via the `prepare` script) which installs a git pre-commit hook to run `lint-staged`. If you're seeing slow commits, that's why.
