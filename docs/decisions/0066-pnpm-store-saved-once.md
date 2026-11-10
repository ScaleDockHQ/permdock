# 0066. The pnpm store is saved from one job

- Status: accepted
- Date: 2026-11-10

## Context

The standard's setup action defaults `save-cache` to the default branch, so every job on that branch writes the store and other refs only restore it. Callers do not repeat the expression.

On the push of `a4d6c53b7` (run 42527608931) the store save took 13 to 17 seconds at the end of about 14 jobs, about 3 runner-minutes. Each job had restored the same lockfile entry.

## Decision

`.github/actions/setup` defaults `save-cache` to `false`. The `static` job in `.github/workflows/verify.yml` is the only caller that passes the default-branch expression. The `better-supabase` job sets `save-cache` to `false` because it rewrites the catalog pin before installing.

## Consequences

- A push to `main` saves the store once. Pull requests still only restore it.
- A job that should write the store has to pass the expression. A new workflow that forgets does not poison the cache; it also does not refresh it.

Revisit if the `static` job stops installing the lockfile the other jobs restore.

## Alternatives considered

- Keep a save on every default-branch job: measured at about 3 runner-minutes of identical uploads per push.
- Save from the `changes` job: it does not install, so its store is not the one the other jobs restore.
