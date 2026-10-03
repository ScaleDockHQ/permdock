# 0025. `vercel.json` instead of `vercel.ts`

- Status: accepted
- Date: 2026-10-03

## Context

The standard writes the Vercel project config as `vercel.ts`, typed with `VercelConfig` from `@vercel/config/v1`, with Services under `experimentalServices`, and falls back to `vercel.json` when that does not deploy. `@vercel/config` 0.9.0, the newest release, types a service with `root`, `framework`, `buildCommand` and `installCommand`, but not with `ignoreCommand` (record 0008) or a service's own `rewrites` (the docs `/docs/_next` rewrite), and types every rewrite `destination` as a string, so a rewrite to `{ "service": "docs" }` does not type-check. This project deploys with all three.

## Decision

The project config stays in `vercel.json` with its `$schema`.

## Consequences

The config is checked against the JSON schema in the editor, not by `tsc`. Revisit when `VercelConfig` types `ignoreCommand`, per-service `rewrites` and service destinations.

## Alternatives considered

- `vercel.ts` with `as VercelConfig`: the cast would cover the whole object, so `tsc` would check none of it.
- `vercel.ts` without `ignoreCommand`: every push would rebuild both services.
