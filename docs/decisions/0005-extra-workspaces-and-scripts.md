# 0005. Extra workspace globs and root scripts

- Status: accepted
- Date: 2026-10-16

## Context

The standard workspace list is `apps/*`, `packages/*` and `tests/*`. PermDock has one example app per adapter and one workspace per TypeScript version under test, and `tests/nest-11` runs the Nest adapter against its lowest peer version.

## Decision

`pnpm-workspace.yaml` also lists `apps/examples/*` and `tests/types/*`. The root keeps the scripts the standard does not have: `authzen:vectors`, `bench`, `openapi:generate`, `permdock`, `standards:fixtures`, `test:e2e`, `test:integration` and `test:runtimes`. `test:e2e` runs the `instant()` navigation specs, which need a production build and Docker; `bench` runs Vitest benchmarks, which are not a gate.

## Consequences

`pnpm install` resolves 56 workspaces besides the root. Vercel installs only the service and its dependencies (`--filter '{.}...'`), so deploys do not pay for them.

## Alternatives considered

- Examples under `apps/*`: 30 example apps would sit next to the two deployed apps and match every `apps/*` filter.
- One workspace for all examples: each example needs its own dependencies and peer versions.
