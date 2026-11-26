# 0082. The Supabase sample relaxes the tsconfig for vendored ReUI

- Status: accepted
- Date: 2026-11-26
- Amends: [0006](./0006-vendored-ui-tsconfig.md)

## Context

`apps/examples/next-better-supabase` vendors ReUI and shadcn components under `src/components`. An example cannot depend on `packages/ui`. Those copies do not compile under the flags 0006 turns off, and data-grid also needs `noPropertyAccessFromIndexSignature` off, which `packages/ui` already turns off. The files sit inside `src`, so excluding them would drop the types the pages import.

## Decision

`apps/examples/next-better-supabase/tsconfig.json` turns off the same flags as `packages/ui`. Oxlint ignores `src/components/ui`, `src/components/reui` and `src/hooks/use-mobile.ts`, the same way marketing ignores vendored blocks. App code outside those folders stays on the example lint preset.

## Consequences

A type error inside a vendored component is invisible until a page calls it. A registry update replaces the folder without a merge against the strict flags.

## Alternatives considered

- Editing the vendored files until they compile: every registry update becomes a merge, which 0006 already rejects.
- Importing `packages/ui`: the example boundary forbids it.
