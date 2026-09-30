# 0007. `packages/permdock/tests` is not type-checked yet

- Status: accepted
- Date: 2026-09-30

## Context

Moving the 145 colocated tests into `packages/permdock/tests` took them out of `tsconfig.json`, which includes only `src`. Adding them back reports about 290 errors, mostly deliberate bad inputs to fail-closed paths and fixtures typed looser than the stricter base config.

## Decision

`packages/permdock/tsconfig.json` includes `src` only. Vitest still runs every test, and `tests/types` checks the public types.

## Consequences

A type error in a test surfaces only as a runtime failure. Follow-up: add a `tests/tsconfig.json`, fix the errors or mark the deliberate ones with `@ts-expect-error`, and add it to `typecheck`.
