# 0050. better-supabase 0.25.0 is the catalog pin with an exact release-age exception

- Status: superseded by 0051
- Date: 2026-10-26
- Supersedes: the catalog pin of 0048

## Context

`pnpm view better-supabase@0.25.0 version` confirmed 0.25.0 at implementation time. The registry's `time` reports publication at 2026-10-26T04:25:05.906Z, within the one-day release-age gate.

The [upstream changelog](https://github.com/ScaleDockHQ/better-supabase/blob/main/CHANGELOG.md) was reviewed for 0.19 through 0.25:

- 0.19 adds tenant-column mappings, hyphenated record types and `$apiResult`; 0.20 passes the caller's Storage to block clients.
- 0.21 changes block calls to Results and date strings to Temporal values, replaces `DbBlockSource.call` with `api` and makes `$api` return an `AsyncResult`, and changes default block SQL, including line-table position indexes. Upgrade and regenerate SQL and types rather than editing generated output.
- 0.22 changes Create's `DesignIssue` to `Issue` and adds actor-write checks to app-table policies. PermDock does not import Create's issue types.
- 0.23 adds opt-in value/column mappings and record-level comment and field checks. Existing configurations without those options retain their checks.
- 0.24 adds opt-in calendar, employee and hiring mappings and has `rls-guard` undo `alter table ... disable row level security`. 0.25 includes `rls-guard` in newly initialized projects; upgrading does not add the block to an existing config.

The example's configured blocks need an audit SQL refresh. Its generated types are checked against a fresh database. Provider tests and integration tests cover the adapter contract rather than claiming that new SQL loads on the peer floor.

## Decision

Pin the catalog to 0.25.0 and add only `better-supabase@0.25.0` to `minimumReleaseAgeExclude`. Keep `minimumReleaseAge: 1440` and `trustPolicy: no-downgrade` unchanged. CI adds the exact 0.18.0 exception before matrix installs while that version remains under one day old. The workspace prunes that exception when its lockfile no longer resolves 0.18.0. pnpm verifies the old lockfile before replacing its resolution, so the matrix keeps the 0.25.0 exception too.

The peer floor remains `>=0.13.0`. CI runs the provider unit and integration suites on 0.13.0, 0.18.0 and 0.25.0. The database workflow runs the full example on the catalog pin only.

## Consequences

Remove the 0.25.0 exception after 2026-10-27T04:26Z and the 0.18.0 exception after 2026-10-26T15:47Z. No other dependency bypasses the release-age gate. Existing adopters must follow upstream's 0.20-to-0.21 migration for their own direct block calls; PermDock's public API and peer floor do not change.

## Alternatives considered

Waiting one day would leave CI behind the requested target. Raising the peer floor would unnecessarily drop provider consumers whose existing configuration still works on 0.13.
