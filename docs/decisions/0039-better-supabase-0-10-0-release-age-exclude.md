# 0039. better-supabase 0.10.0 skips the one-day release age

- Status: accepted
- Date: 2026-10-20

## Context

The standard installs only versions older than `minimumReleaseAge` (1440 minutes in `pnpm-workspace.yaml`) and never bypasses it. better-supabase 0.10.0 reached npm at 13:50 UTC on 2026-10-20, and an adopter (CentraKit) runs it with `permdock` already. The peer range now ends below the minor after the latest version CI tests (`>=0.9.0 <0.11.0`), so CI must install 0.10.0 to accept it.

## Decision

`minimumReleaseAgeExclude` lists `better-supabase@0.10.0`, that version only, so the catalog pins `better-supabase: 0.10.0` the day it shipped. `minimumReleaseAge` stays at 1440. better-supabase is a ScaleDockHQ package, and `trustPolicy: no-downgrade` still checks the release. The 0.9.0 entry of 0038 is gone: that version is older than a day.

## Consequences

The exclusion is unneeded from 13:50 UTC on 2026-10-21; remove the entry then. Any other better-supabase version still waits one day.

## Alternatives considered

- Wait one day: the peer range could not reach 0.10 until then, and adopters on 0.10 would keep a peer warning.
- Exclude `better-supabase` by name: every future release would skip the gate too.
