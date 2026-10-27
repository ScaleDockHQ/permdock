# 0028. `packages/ox-config` instead of Ultracite

- Status: withdrawn
- Date: 2026-10-16

## Context

The standard runs lint and format through Ultracite 8: a root `oxlint.config.ts` on its presets, `oxfmt.config.ts` spreading `ultracite/oxfmt`, `pnpm check` and `pnpm fix` as `ultracite check` and `ultracite fix`, and no `packages/ox-config`. PermDock's `packages/ox-config` holds about 670 lines of house rules, the adapter kit boundary (`kitBoundary`), the `library` preset with `max-lines`, and an anti-slop plugin, each disabled rule with a reason and a finding count.

## Decision

Lint and format stay on `packages/ox-config`, which the root `oxlint.config.ts` and `oxfmt.config.ts` import. `pnpm check` and `pnpm fix` run Oxfmt and Oxlint directly, and the pre-commit hook runs `oxfmt` on staged files.

## Withdrawn

Lint and format run on Ultracite 8.1: `packages/ox-config` is deleted, the root `oxlint.config.ts` holds the house rules and the shared presets, and `oxfmt.config.ts` spreads `ultracite/oxfmt`. The deviations that remain are in [0052](./0052-ultracite-presets-and-kept-off-rules.md).

## Consequences

Rule updates that Ultracite ships arrive only when copied by hand. [0044](./0044-lint-rules-kept-off.md) lists the rules that stay off and the backlogs still open. Revisit as one migration: move the house rules after the Ultracite presets in the root config, keep the reasons and counts, then delete the workspace and its boundary tag.

## Alternatives considered

- Migrate in the same change as the CI work: it touches every workspace's lint config and would hide CI regressions behind lint noise.
