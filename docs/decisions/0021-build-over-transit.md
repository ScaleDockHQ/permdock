# 0021. Checks depend on `^build`, not `transit`

- Status: accepted
- Date: 2026-10-03

## Context

The standard gives every package a no-op `transit` script and makes `lint`, `typecheck` and `test` depend on `^transit`. A check then reruns when a dependency's source changes, without waiting for that dependency to build. That works when workspaces import each other's source. Every workspace here imports `permdock` through its package `exports`, which point at `dist/` (`"types": "./dist/index.d.ts"`), so a check against unbuilt source finds no types.

## Decision

- `lint`, `typecheck`, `test`, `size`, `gen:check`, `doctor` and `check:publish` depend on `^build`. `permdock`'s own `typecheck` and `test` also depend on its `build`.
- `build` depends on `^build` and the package's `typegen`, so `next typegen` and `next build` never write `.next/types` at the same time.
- `turbo.json` has no `transit` task and no package has a `transit` script.

## Consequences

A change in `packages/permdock/src` rebuilds `permdock` before any downstream check runs. The build is cached, so an unchanged `permdock` costs nothing. Revisit if `permdock` exports its source through a development condition.

## Alternatives considered

- `transit` plus a source condition in `permdock`'s `exports`: consumers would see the condition too, and the published types would no longer be the ones the repository checks.
- `transit` plus `tsconfig` `paths` to `src`: the apps and examples would type-check against source the published package does not ship.
