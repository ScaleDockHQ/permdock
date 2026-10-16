# 0029. No Turbopack build cache on GitHub runners

- Status: accepted
- Date: 2026-10-16

## Context

The standard leaves Next.js defaults alone and restores `.next/cache` in every job that runs `next build`. Next.js 16 turns on `turbopackFileSystemCacheForBuild` by default. On GitHub-hosted runners, parallel `next build`s with the persistent cache hung until the job timed out.

## Decision

`createNextConfig()` in `packages/next-config` sets `turbopackFileSystemCacheForBuild` to `false` when `GITHUB_ACTIONS` is `true`, and CI does not cache `.next/cache`. Turborepo's Remote Cache restores whole build outputs instead.

## Consequences

A Next.js build that misses the Remote Cache compiles from scratch in CI. Revisit when a Next.js release fixes the hang: remove the override and restore `.next/cache` in the `build` job.

## Alternatives considered

- Keep the cache and restore `.next/cache`: untested since the hang. CI now builds the Next.js apps once, in the `build` job, so this is the first thing to try when revisiting.
