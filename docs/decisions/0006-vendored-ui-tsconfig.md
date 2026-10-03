# 0006. Relaxed tsconfig for vendored UI code

- Status: accepted
- Date: 2026-09-30

## Context

shadcn/ui, ReUI and AI Elements components are copied in as published. They do not compile under `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` or `isolatedDeclarations`, and editing them makes every registry update a merge.

## Decision

- `packages/ui/tsconfig.json` turns those flags off, plus `noPropertyAccessFromIndexSignature` and `declaration`.
- `apps/marketing/tsconfig.json` turns off the same flags except `noPropertyAccessFromIndexSignature`, and excludes `components/blocks` and `components/examples`, which are checked through their imports.
- Every other workspace uses the presets unchanged.

## Consequences

Type errors inside vendored code surface only where app code calls it. Revisit a flag when the upstream registries compile under it.

## Alternatives considered

- Editing the vendored files until they compile under the strict flags: every registry update becomes a merge.
- Excluding `packages/ui` from type-checking: app code that calls it would lose its types.
