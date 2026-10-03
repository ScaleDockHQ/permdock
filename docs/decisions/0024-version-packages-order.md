# 0024. The root changelog runs before `changeset version`

- Status: accepted
- Date: 2026-10-03

## Context

The standard's `version-packages` runs `changeset version`, then `scripts/root-changelog.ts`, then `oxfmt`. `root-changelog.ts` reads the pending changesets with `@changesets/read` and plans the release with `@changesets/assemble-release-plan`. `changeset version` deletes those changeset files, so in the standard order the script finds nothing to write.

## Decision

`version-packages` is `node scripts/root-changelog.ts && changeset version && oxfmt .`.

## Consequences

The root `CHANGELOG.md` section is written from the same release plan `changeset version` applies. If `changeset version` fails, the root changelog already has the new section; the release pull request is regenerated from scratch, so nothing partial is committed.

## Alternatives considered

- The standard order, reading `packages/permdock/CHANGELOG.md` after `changeset version`: parses Markdown that `@changesets/changelog-github` formats, instead of reading the changesets.
- The standard order, reading the deleted changesets from git: depends on the working tree's git state inside `changesets/action`.
