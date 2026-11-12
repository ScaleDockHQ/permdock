# 0069. Staged lint on commit, affected gate on push

- Status: accepted
- Date: 2026-11-12
- Supersedes: the pre-commit part of 0049

## Context

0049 ran the affected lint and typecheck gate on every commit. Measured over 30 days of agent transcripts in this repository:

- 1,690 `git commit` calls, a median of 8.5 per session.
- 350 commits skipped the hooks (`LEFTHOOK_EXCLUDE`, `LEFTHOOK=0`, `--no-verify`) in 53 sessions. Stated reasons: lint and typecheck failures in files another agent was editing.
- The gate takes 16 to 24 s cold. One changed file in `packages/permdock/src` selects 114 tasks.
- `oxlint` on five files takes 0.3 s.

## Decision

- Pre-commit formats the staged files with Oxfmt, then runs `scripts/lint-staged.ts`. It runs the `oxlint` call of the workspace that owns each staged file, on those files only.
- Typecheck leaves pre-commit.
- Pre-push keeps the affected gate of `pnpm check:affected`. Tests run in CI only, as in 0049.
- The Turbo calls in hooks and root scripts unset `TURBO_CACHE_DIR`, so a sandboxed agent shell uses the repository cache.

## Consequences

- A commit takes about 1.5 s. A type error reaches the author on push, or earlier through `pnpm check:affected`.
- `scripts/lint-staged.ts` does not run `next typegen` for `apps/examples/next`; the pre-push gate does.

## Alternatives considered

- Keep the whole gate on commit: costs 16 to 24 s cold and invites skipped hooks.
- Drop the hooks: leaves formatting and lint to CI.
