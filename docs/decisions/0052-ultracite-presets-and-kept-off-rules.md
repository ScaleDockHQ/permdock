# 0052. Ultracite presets and kept-off rules

- Status: accepted
- Date: 2026-10-27

## Context

The standard runs lint and format on Ultracite 8: a root `oxlint.config.ts` that extends `core`, `vitest`, `react`, `next`, `shadcn` and `anti-slop`, an `oxfmt.config.ts` that spreads `ultracite/oxfmt`, and workspace configs that extend the root. PermDock had `packages/ox-config` with about 700 lines of house presets ([0028](./0028-ox-config-over-ultracite.md), withdrawn).

Ultracite 8.1 ships `playwright`, `react-native` and `drizzle` presets. The Oxlint versions of `playwright` and `react-native` add no rules: the first only lets `test.beforeEach(async ({}, testInfo) => ...)` through `no-empty-pattern`, the second is empty.

## Decision

- The root `oxlint.config.ts` extends `ultracite/oxlint/core` and `ultracite/oxlint/anti-slop`, then states the house rules. It also exports the shared presets (`core`, `library`, `node`, `test`, `react`, `example`) that workspace configs extend, and `packages/ox-config` is deleted.
- Ultracite's `core` turns off 63 rules that the repository's Oxlint categories had on. The `keptOn` block restates the 37 of them that have no findings; the other 26 were not on before and stay off.
- Rules Ultracite turns on that the repository has not cleared stay `off`, each with its measured count in the root config. They need a per-site review, and the oxlint autofixes were not applied: one rewrites `{ cause }` to `{ error }` when it renames a catch parameter.
- `typescript/consistent-type-definitions` stays off (1593): public `interface` declarations stay augmentable.
- `anti-slop/require-readable-spacing` (32435), `anti-slop/no-array-filter-map` (67) and `anti-slop/no-module-mocking` (17, third-party specifiers only) stay off. The local plugin this replaces skipped third-party mocks.
- `oxfmt.config.ts` sets `proseWrap: "preserve"`. Ultracite's `never` would rewrite every hand-wrapped Markdown and MDX file.
- `ultracite/oxlint/playwright` is extended in `apps/examples/next` and `apps/examples/next-better-supabase`, and `ultracite/oxlint/react-native` in `apps/examples/expo`.
- The `vitest`, `react`, `next` and `shadcn` presets are not extended. The house `test` and `react` presets list the same plugins' rules with their reasons.

## Consequences

Workspace configs import the root config by relative path with `// @boundaries-ignore <reason>`, and `packages/permdock/tests/tsconfig.json` sets `rootDir` to the repository root for that import. Revisit when the `vitest`, `react`, `next` and `shadcn` presets replace the house lists, and when a kept-off rule has a clean per-site review.

## Alternatives considered

- Apply `oxlint --fix` for every new rule: 758 files changed, one fixer broke `{ cause }`, and two others changed types in tests.
- Leave `packages/ox-config` in place: it misses the rules Ultracite adds on each release.
