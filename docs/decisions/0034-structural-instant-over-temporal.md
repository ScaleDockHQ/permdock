# 0034. The runtime takes a structural `Instant`, not `Temporal`

- Status: accepted
- Date: 2026-10-16

## Context

The standard says dates are `Temporal`. Node.js 24, the lowest version `engines` allows, ships no global `Temporal`, and invariant 12 limits runtime entries to `@standard-schema/spec`, so `temporal-polyfill` cannot be a runtime dependency. TypeScript 5.9, the oldest version `tests/types` checks, has no `Temporal` lib.

## Decision

- Public options take `Instant` from `packages/permdock/src/core/time.ts`, `{ readonly epochMilliseconds: number }`, which every `Temporal.Instant` satisfies.
- A clock option is `now?: () => Instant`.
- Every clock read and ISO conversion in `src` goes through `core/time.ts` (`nowMillis`, `nowSeconds`, `epochSeconds`, `dateAt`, `isoAt`, `isoNow`, `rfc3339`). A `Date` is built elsewhere only where a third-party API takes one: ORM parameters, ORM row comparisons and the Workflow SDK `sleep`.
- `packages/permdock/tests/package/time-reads.test.ts` fails on any other `new Date(` or `Date.now(` in `src`.
- Tests and examples import `Temporal` from `temporal-polyfill`, a dev dependency, and pass `Temporal.Instant` values.

## Consequences

Callers on a runtime with `Temporal` pass `Temporal.Now.instant()` unchanged; callers without it pass `{ epochMilliseconds }`. `core/time.ts` keeps `Date` as its one implementation detail. Revisit when the lowest supported Node.js ships `Temporal` and the oldest checked TypeScript has its lib.

## Alternatives considered

- `temporal-polyfill` as a runtime dependency: breaks invariant 12 and adds weight to every entry.
- `Temporal.Instant` in public types: declarations stop compiling under TypeScript 5.9.
