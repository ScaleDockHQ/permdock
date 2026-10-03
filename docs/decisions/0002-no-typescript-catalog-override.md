# 0002. No global `typescript` override

- Status: accepted
- Date: 2026-09-30

## Context

The standard pins `typescript` once through a pnpm `overrides` entry. `tests/types` installs TypeScript 5.9, 6 and 7 side by side to check the public types consumers see, so a global override would collapse the matrix onto one version.

## Decision

`typescript` is a default catalog entry (7.x). `tests/types/ts-6` and `tests/types/ts-5.9` use the named catalogs `ts6` and `ts59`. There is no `overrides.typescript`.

## Consequences

A workspace can move to another TypeScript only through a named catalog, which review catches. Revisit when TypeScript 5.9 and 6 leave the support matrix.

## Alternatives considered

- A global `overrides.typescript`: pnpm overrides have no per-workspace exception, so the 5.9 and 6 type tests would run on 7.
- Dropping 5.9 and 6 from the matrix: consumers still compile against them.
