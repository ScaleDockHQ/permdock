# 0081. CI runs the Supabase CLI 3.4.0 pin; the floor stays 3.2.0

- Status: accepted
- Date: 2026-11-26
- Amends: [0078](./0078-supabase-cli-floor-without-a-ci-job.md)

## Context

The catalog pinned Supabase CLI 3.3.0. 3.4.0 was published at 15:55 UTC on 2026-11-24 (`pnpm view supabase time`), past `minimumReleaseAge` on 2026-11-26. 3.4.0's `supabase init` writes `config.jsonc`. The CLI already reads that file. The native runtime fix in 3.4.0 is the stack this repository starts with `supabase start --runtime native`.

## Decision

- The catalog pin and `scripts/centrakit-stack.ts` are `supabase@3.4.0`. No `minimumReleaseAgeExclude` entry: the release is older than 1440 minutes.
- The supported floor stays 3.2.0. PD136 still warns below 3.2.0. No CI job runs 3.2.0 or 3.3.0. `database.yml` runs the catalog pin, as 0078 has it.

## Consequences

A change that works on 3.4.0 and breaks on 3.2.0 or 3.3.0 is found by an adopter, not by CI. The same condition 0078 names still applies: revisit the floor when better-supabase raises BS710.

## Alternatives considered

- Raise the floor to 3.4.0: better-supabase's BS710 names 3.2.0, and the two doctors would disagree about the floor.
