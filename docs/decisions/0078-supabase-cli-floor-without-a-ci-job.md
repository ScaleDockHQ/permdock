# 0078. Supabase CLI 3.2.0 is the supported floor; CI runs the 3.3.0 pin only

- Status: accepted
- Date: 2026-11-24
- Amends: [0051](./0051-better-supabase-0-29-0-floor-and-release-age.md) (the stack job runs the catalog pin only), for the Supabase CLI

## Context

The catalog pins Supabase CLI 3.3.0, published at 09:54 UTC on 2026-11-23 and past the one-day release age on 2026-11-24 ([0075](./0075-better-supabase-0-84-0-pin-and-release-age.md)). PermDock supports 3.2.0 and later, the floor better-supabase 0.84.0 names in BS710; doctor PD136 warns below it.

The stack job in `database.yml` runs `db schema declarative sync --fail-on-destructive`, so a generated change that drops a table or column fails before a migration file is written. 3.2.0's `declarative sync` has no `--fail-on-destructive`. 3.3.0 also removed `--stack-id` from `supabase stack`, which only the deleted `scripts/supabase-prune.ts` passed. The job starts a local stack and takes up to 20 minutes.

## Decision

- No CI job runs Supabase CLI 3.2.0. `database.yml` runs the catalog pin, as 0051 has it for better-supabase.
- 3.2.0 stays the supported floor and PD136 keeps naming it. Before the pin moved, the example ran on 3.2.0 once: `config validate`, `config convert` both ways, `status --output-format json` against the local stack, and the help of `status` (which lists `--stack`) and `db schema declarative sync` (which has no `--fail-on-destructive`).
- When better-supabase raises BS710, the floor follows and this record is superseded.

## Consequences

A change that works on 3.3.0 and breaks on 3.2.0 is found by an adopter, not by CI. The PermDock commands that call the Supabase CLI run `status --output-format json [--stack <name>]` (`--local`) and `db advisors --type <type> --output-format json` (`rls verify --advisors`). The first was checked on 3.2.0; the second was not.

## Alternatives considered

- A second stack job on 3.2.0 without `--fail-on-destructive`: it doubles the database job for a release whose one difference the repository uses is that flag.
- Raise the floor to 3.3.0: better-supabase's BS710 names 3.2.0, and the two doctors would disagree about the floor.
