# 0032. No `actions.lock` until workflow lockfiles are generally available

- Status: accepted
- Date: 2026-10-16

## Context

The standard allows `.github/workflows/actions.lock`, written by `gh actions-lock`, on top of the commit SHA pins, and asks a repository that holds it back to say why. Workflow lockfiles are a public preview.

## Decision

PermDock pins every third-party action to a commit SHA and has no `actions.lock`. Dependabot updates the pins with its 7-day cooldown (0027).

## Consequences

Transitive actions inside a composite action are not locked: only the SHA of the top-level action is. Adopt `actions.lock`, with a CI step that fails on a stale lockfile, once GitHub marks workflow lockfiles generally available.

## Alternatives considered

- Adopt the preview now: its file format and Dependabot support may still change, and a stale-lockfile step would block pull requests on a preview tool.
