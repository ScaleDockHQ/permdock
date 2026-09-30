# 0009. Boundary rules Turborepo cannot express

- Status: accepted
- Date: 2026-09-30

## Context

The standard asks that `config` packages depend only on `config`, and that `next-config` depends only on `config`. With Turborepo 2.11.5, adding `"config": { "dependencies": { "allow": ["config"] } }` makes `turbo boundaries` report `permdock` for depending on `@permdock/typescript-config` and `@permdock/ox-config`. That is the reverse direction: neither config package depends on `permdock`.

## Decision

`turbo.json` has rules for the `library`, `app`, `example` and `test` tags. `packages/typescript-config` and `packages/ox-config` are tagged `config`, and `packages/next-config` is tagged `next-config`, but neither tag has a rule of its own. Review covers them, and all three packages are private.

## Consequences

A config package could gain a dependency unnoticed. Revisit on the next Turborepo minor: add the two rules and run `pnpm boundaries`.
