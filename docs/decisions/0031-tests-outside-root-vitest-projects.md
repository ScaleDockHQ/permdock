# 0031. `tests/*` stays outside the root Vitest `projects`

- Status: accepted
- Date: 2026-10-16

## Context

The standard runs every Vitest suite from the root `vitest.config.ts` through `test.projects`. Four of PermDock's `tests/*` workspaces cannot share that run:

- `tests/integration` starts Postgres through testcontainers and needs Docker.
- `tests/runtimes` runs under Bun, Deno and workerd, not Node.js.
- `tests/bundle` measures `packages/permdock/dist`, so it needs a build first.
- `tests/nest-11` aliases every `@nestjs/*` import to Nest 11, which would leak into the Nest 12 run.

## Decision

The root `projects` list holds `apps/docs`, `apps/marketing` and `packages/permdock`. Each `tests/*` workspace has its own `vitest.config.ts` and its own Turbo task: `tests/bundle` runs as `size`, `tests/nest-11` as `test`, both in `pnpm verify` after the build. The suites that need Docker or other runtimes run as `pnpm test:integration` and `pnpm test:runtimes`.

## Consequences

`vitest -p <project>` from the root reaches only the four listed projects; a `tests/*` suite runs through its workspace script. Revisit when Vitest projects can carry their own resolver aliases and build prerequisites.

## Alternatives considered

- Every suite in `projects`: `vitest` at the root would fail without Docker, Bun and Deno, and the Nest 11 aliases would apply to the Nest 12 suite.
