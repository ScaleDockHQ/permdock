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
