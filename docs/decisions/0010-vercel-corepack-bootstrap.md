# 0010. `vercel.json` bootstraps pnpm through Corepack

- Status: accepted
- Date: 2026-09-30

## Context

The standard `installCommand` is `pnpm install --frozen-lockfile --filter '{.}...'`. Vercel's bundled pnpm fails the root `devEngines` check for pnpm 12.8.1, and Turborepo spawns `pnpm` for every task during the build.

## Decision

`installCommand` activates pnpm 12.8.1 with Corepack before the filtered install, and adds `--include-workspace-root`. `buildCommand` puts a Corepack `pnpm` shim first on `PATH`, then runs `turbo run build --filter=<service>`.

## Consequences

Both commands are longer than the standard. Revisit when Vercel ships pnpm 12.8 or reads `devEngines`.
