# 0038. better-supabase 0.9.0 skips the one-day release age

- Status: accepted
- Date: 2026-10-19

## Context

The standard installs only versions older than `minimumReleaseAge` (1440 minutes in `pnpm-workspace.yaml`) and never bypasses it. better-supabase 0.9.0 reached npm at 17:24 UTC on 2026-10-19 and is the first release with the slots `permdock/better-supabase` fills. Until then the catalog installed a tarball packed from a pinned `main` commit (0035), which needed a checkout script in CI and on Vercel and `peerDependencyRules.allowAny`.

## Decision

`minimumReleaseAgeExclude` lists `better-supabase@0.9.0`, that version only, so the catalog pins `better-supabase: 0.9.0` the day it shipped. `minimumReleaseAge` stays at 1440. better-supabase is a ScaleDockHQ package, and `trustPolicy: no-downgrade` still checks the release.

0035's steps for the published release are applied: `better-supabase-floor: npm:better-supabase@0.9.0` is a `permdock` dev dependency read by `tests/better-supabase/peer-floor.test.ts`; `allowAny`, `scripts/better-supabase-checkout.ts`, its `.github/actions/setup` step and the `vercel.json` install steps are gone.

## Consequences

The exclusion is unneeded from 17:24 UTC on 2026-10-20; remove the entry then. Any other better-supabase version still waits one day.

## Alternatives considered

- Wait one day: keeps the tarball, its checkout script and `allowAny` for another day.
- Exclude `better-supabase` by name: every future release would skip the gate too.
