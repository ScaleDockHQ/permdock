# 0044. Lint rules kept off by design, and the remaining backlogs

- Status: accepted
- Date: 2026-10-21

## Context

Lint runs on the Ultracite `core` and `anti-slop` presets plus the house rules in the root `oxlint.config.ts` ([0052](./0052-ultracite-presets-and-kept-off-rules.md)). The house config enables the `correctness`, `suspicious`, `perf`, `restriction` and `pedantic` categories and turns `style` and `nursery` rules on one by one. Every `off` line carries a reason and a finding count. Before the TypeScript 7.1 preparation, every explicit `off` was flipped to `error` and the candidate style rules were added, then the findings were counted per rule across every workspace with oxlint 1.89. Most rules were cleared and switched on. A rule that could not be cleared completely stays `off`; the repository never lands a rule that is half on.

## Decision

These rules stay off because the code does on purpose what they forbid. The counts are across the repository.

- `oxc/no-async-await` (6619), `oxc/no-optional-chaining` (4082) and `oxc/no-rest-spread-properties` (3119): the targets are Node 24 and ES2025, so the syntax ships as written and is never down-levelled.
- `typescript/prefer-readonly-parameter-types` (6494): `Request`, `Response`, framework contexts and test doubles are never deeply readonly.
- `typescript/promise-function-async` (979): sources and sinks hand a promise on without an extra microtask, and test doubles return promises without `async`.
- `anti-slop/no-conditional-empty-object-spread` (649): `exactOptionalPropertyTypes` forbids `key: undefined`, so `...(x === undefined ? {} : { x })` is how a key is omitted.
- `eslint/no-await-in-loop` (479) in tests and the CLI: ordered requests, pages and file writes run in sequence on purpose. The `library` preset keeps it on.
- `unicorn/consistent-function-scoping` (286) in tests: a helper used by one case stays next to its assertions.
- `typescript/consistent-return` (1) in `apps/marketing`: an effect returns a cleanup only when it starts a timer. `noImplicitReturns` covers every other function.
- `vitest/prefer-to-be-truthy` and `vitest/prefer-to-be-falsy`: `toBe(true)` and `toBe(false)` assert the boolean a fail-closed check returns, which `toBeTruthy()` would weaken.
- `vitest/prefer-expect-resolves` (1883): extension methods return `T | Promise<T>`. `.resolves` throws on a plain value, while `expect(await x)` accepts both.
- `eslint/sort-keys` (19130): key order is the wire and docs order, such as the permission leaf `{ key, resource, action, scope, meta }`. `src` is the serialiser, so no override can carve one out.
- `promise/prefer-await-to-then` (93): a Next.js layout passes `snapshotPromise` to the client unresolved so the page streams, and synchronous Node handlers end with a fire-and-forget `.catch`.
- `promise/prefer-await-to-callbacks` (22): it flags every parameter named `callback`, `error`, `next` or `done`, such as `it.each` rows and MCP handler wrappers.

These rules stay off as backlogs that need a larger change than a lint pass:

- `vitest/max-expects` (858 at a threshold of 6, the p95 of expects per test): matrix and conformance cases assert every field of one decision. Clearing it means splitting about 420 tests.
- `unicorn/no-await-expression-member` (718, down from 950): a codemod hoisted the plain reads. The rest are lazy `import()` loaders in expression-bodied arrows, optional reads, called members and repeated names in one test.
- `anti-slop/no-known-value-widening` (567): explicit return and wire types are the contract, and `isolatedDeclarations` requires them on exports.
- `anti-slop/no-unknown-returns` (427): condition paths, claims and adapter hooks hand back `unknown` for the caller to validate under invariant 9.
- `shadcn/no-restyle` (162): clearing it restyles the marketing site and the Next.js example and adds variants to `packages/ui`. That is a design pass with visual review under the ReUI rules.
- `anti-slop/no-object-parameters` (46): `object` is the non-primitive bound for prototype-safe reads, `WeakMap` keys and foreign tables.

## Consequences

The reason and count beside each `off` line in the root `oxlint.config.ts` and the workspace configs stay the source of truth. When a backlog is cleared, the rule turns on in the same pull request and its entry here is deleted. An oxlint upgrade that changes a count updates the comment, not this record.

## Alternatives considered

- Turn the backlogs on with inline disables at each site: a disable is for a deliberate site, and hundreds of them would hide the next real finding.
- Turn a rule on for some folders only: a reader of one file could not tell which rules apply to it.
