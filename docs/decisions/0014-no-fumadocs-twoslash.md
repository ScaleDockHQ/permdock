# 0014. No `fumadocs-twoslash`

- Status: accepted
- Date: 2026-09-30

## Context

The standard adds type hovers to code samples with `fumadocs-twoslash`. Version 4.0.1, the latest, crashes under the TypeScript 7 native API with "Offset is outside the bounds of the DataView" in `describeSymbol` when it hovers `resource(Post, …)`. It has no option to skip a failing sample.

## Decision

Code samples render without Twoslash. Public types are documented with `<auto-type-table>` from `fumadocs-typescript`.

## Consequences

Samples show no inferred types. Follow-up: file the crash upstream, then revisit when a release supports TypeScript 7.
