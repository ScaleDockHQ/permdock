# 0005. Extra workspace globs and root scripts

- Status: accepted
- Date: 2026-09-30

## Context

The standard workspace list is `apps/*`, `packages/*` and `tests/*`. PermDock has one example app per adapter, scenario fixture apps, a nested Turborepo fixture, and one workspace per TypeScript version under test.

## Decision

`pnpm-workspace.yaml` also lists `apps/examples/*`, `tests/e2e/fixtures/*`, `tests/e2e/fixtures/turborepo/{apps,packages}/*` and `tests/types/*`. The root keeps the scripts the standard does not have: `authzen:vectors`, `openapi:generate`, `permdock`, `standards:fixtures`, `test:integration` and `test:runtimes`.

## Consequences

`pnpm install` resolves 64 workspaces. Vercel installs only the service and its dependencies (`--filter '{.}...'`), so deploys do not pay for them.
