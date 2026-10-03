# 0009. Boundary rules Turborepo cannot express

- Status: accepted
- Date: 2026-09-30

## Context

The standard asks that `tooling` packages depend only on `tooling`, that `next-config` depends only on `tooling`, and that `ui` depends only on `tooling` with only apps depending on it. Turborepo applies boundary rules to transitive dependencies, and every workspace depends on the repository root, which depends on `permdock` for the `permdock` script. With Turborepo 2.11.6 an `allow` list without `library` therefore reports `permdock`: `"tooling": { "dependencies": { "allow": ["tooling"] } }` flags both tooling packages, and `"ui": { "dependencies": { "allow": ["tooling"] } }` flags `@permdock/ui`, although none of them depends on `permdock`.

## Decision

- `turbo.json` has rules for the `library`, `app`, `example`, `test` and `ui` tags.
- The `ui` rule denies `app`, `example`, `test` and `next-config` dependencies instead of allowing only `tooling`, and allows `app` and `test` dependents (the e2e suite runs the apps).
- `packages/typescript-config` and `packages/ox-config` are tagged `tooling`, and `packages/next-config` is tagged `next-config`, but neither tag has a rule of its own. Review covers them, and all three packages are private.

## Consequences

A tooling package could gain a dependency unnoticed, and `ui` could import `permdock` without a boundary error (pnpm's strict resolution and Knip still catch an undeclared one). Revisit when Turborepo can exclude the root from boundary checks: switch to `allow` lists and run `pnpm boundaries`.

## Alternatives considered

- `allow` lists for `tooling` and `ui` dependencies: Turborepo counts the dependencies of the repository root, which depends on `permdock`, so every allow list that omits `library` fails.
- Tagging `next-config` as `tooling`: it depends on Next.js and Sentry, which a tooling package does not.
