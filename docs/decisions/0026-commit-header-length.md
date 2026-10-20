# 0026. Commit headers without a length limit

- Status: accepted
- Date: 2026-10-16, amended 2026-10-20

## Context

The standard's `commitlint.config.ts` sets `header-max-length` to 72. PermDock's commit and PR titles name an entry, an identifier and a behaviour (`fix(better-supabase): read share-link rows through subjectFromShareLink`), and many need more than 72 characters to say what changed. The PR title becomes the squash commit, so the same limit applies to both.

## Decision

`commitlint.config.ts` turns `header-max-length` off, so commit headers and PR titles have no length limit. The first version of this decision set 150. `git-workflow.mdc`, `writing.mdc`, `CONTRIBUTING.md` and `AGENTS.md` state the same.

## Consequences

`git log --oneline` wraps on narrow terminals for long titles. Authors keep titles short by judgment instead of by a check.

## Alternatives considered

- 72 characters: titles drop the identifier or the behaviour, which the writing rules ask for.
