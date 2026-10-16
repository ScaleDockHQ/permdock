# 0026. Commit headers up to 150 characters

- Status: accepted
- Date: 2026-10-16

## Context

The standard's `commitlint.config.ts` sets `header-max-length` to 72. PermDock's commit and PR titles name an entry, an identifier and a behaviour (`fix(better-supabase): read share-link rows through subjectFromShareLink`), and many need more than 72 characters to say what changed. The PR title becomes the squash commit, so the same limit applies to both.

## Decision

`commitlint.config.ts` sets `header-max-length` to 150. `git-workflow.mdc` and `AGENTS.md` state the same limit.

## Consequences

`git log --oneline` wraps on narrow terminals. Revisit if the standard raises its limit.

## Alternatives considered

- 72 characters: titles drop the identifier or the behaviour, which the writing rules ask for.
