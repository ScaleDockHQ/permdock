# 0008. `turbo query affected` instead of `turbo-ignore`

- Status: accepted
- Date: 2026-09-30

## Context

The standard skips unaffected Vercel builds with `npx turbo-ignore`. `turbo-ignore` is deprecated in Turborepo 2.11 in favour of `turbo query affected`.

## Decision

Each service's `ignoreCommand` in `vercel.json` runs `turbo query affected --packages <service> --exit-code` against `VERCEL_GIT_PREVIOUS_SHA`. A Turborepo error or a missing base ref builds.

## Consequences

`.git` must stay in the upload, so `.vercelignore` does not list it. `vercel.json` is a build input of both services, so a change to it rebuilds both.

## Alternatives considered

- `npx turbo-ignore`: deprecated in Turborepo 2.11.
- No `ignoreCommand`: every push rebuilds both services.

## Addendum: 2026-11-12

The per-service `ignoreCommand` never ran: no build log showed it, and every push to `main` rebuilt both services on the largest build machine. Because `docs` and `marketing` depend on `permdock`, `turbo query affected` would also select both sites on every library commit.

The project now has one top-level `ignoreCommand` that runs `scripts/vercel-ignore-build.sh`. It builds when `apps/docs`, `apps/marketing`, a private package under `packages/`, `vercel.json`, `.vercelignore` or the script changed since `VERCEL_GIT_PREVIOUS_SHA`, or when a package version changed in a release. Otherwise Vercel skips the deployment. The docs site can lag a library commit on `main` until the next release. A missing base ref still builds.
