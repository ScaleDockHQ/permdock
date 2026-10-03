# 0014. No `fumadocs-twoslash`

- Status: withdrawn
- Date: 2026-09-30
- Withdrawn: 2026-10-03

## Context

The standard adds type hovers to code samples with `fumadocs-twoslash`. Version 4.0.1, the latest, crashes under the TypeScript 7 native API with "Offset is outside the bounds of the DataView" in `describeSymbol` when it hovers `resource(Post, …)`. It has no option to skip a failing sample.

## Decision

Code samples render without Twoslash. Public types are documented with `<auto-type-table>` from `fumadocs-typescript`.

## Consequences

Samples show no inferred types. Follow-up: file the crash upstream, then revisit when a release supports TypeScript 7.

## Alternatives considered

- Running Twoslash under the TypeScript 6 JS API: the docs app would need a second TypeScript next to 7.

## Withdrawn

Repo standard 1.7.1 adds `fumadocs-twoslash` only when a page contains a twoslash block, and reports an installed `fumadocs-twoslash` with no such block as a gap. No page has one, so the docs app matches the standard without this record.
