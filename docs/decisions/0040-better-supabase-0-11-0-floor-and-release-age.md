# 0040. better-supabase 0.11.0 is the peer floor, with no upper bound, and skips the one-day release age

- Status: accepted; the "no upper bound" part is superseded by 0043
- Date: 2026-10-20

## Context

The `better-supabase` peer range was `>=0.9.0 <0.11.0`, bounded below the minor after the latest version CI tests, so every better-supabase minor needed a PermDock release before adopters could install it without a peer warning. better-supabase 0.11.0 reached npm at 19:15 UTC on 2026-10-20 and changes nothing in the entries `permdock/better-supabase` implements or imports; the framework adapters only gain a defaulted type parameter. Its API is stable enough that a new minor should not need a PermDock release.

The standard installs only versions older than `minimumReleaseAge` (1440 minutes in `pnpm-workspace.yaml`) and never bypasses it.

## Decision

The peer range is `>=0.11.0`, with no upper bound. The floor rises to 0.11.0 so CI tests one supported line instead of three, and `better-supabase-floor` aliases 0.11.0. The CI matrices in `ci.yml` and `database.yml` list the floor and the latest release; with both at 0.11.0 they hold one entry. `tests/package/better-supabase-peer-range.test.ts` checks that the floor is the first matrix entry, the catalog pin is the last, and the range has no upper bound.

`minimumReleaseAgeExclude` lists `better-supabase@0.11.0`, that version only, so the catalog pins it the day it shipped. `minimumReleaseAge` stays at 1440, and `trustPolicy: no-downgrade` still checks the release. The 0.10.0 entry of 0039 is gone: no install resolves 0.10.0 any more.

## Consequences

Adopters on better-supabase 0.9 or 0.10 must upgrade to 0.11 before they take the next `permdock` minor. A better-supabase release that breaks `permdock/better-supabase` reaches adopters before CI tests it; the fix is a PermDock patch, or an upper bound added back for that release.

The exclusion is unneeded from 19:15 UTC on 2026-10-21; remove the entry then. Any other better-supabase version still waits one day.

## Alternatives considered

- Keep the bound and raise it to `<0.12.0`: every better-supabase minor keeps needing a PermDock release.
- Keep the 0.9.0 floor with no upper bound: CI keeps testing two lines that adopters have left.
- Wait one day for the release age: adopters on 0.11 would keep a peer warning until then.
