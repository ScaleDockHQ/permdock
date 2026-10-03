# 0001. Vendored skills stay in `.agents/skills`

- Status: withdrawn
- Date: 2026-09-30
- Withdrawn: 2026-10-03

## Context

The standard installs skills per tool. This repository already vendors them once in `.agents/skills`, pinned in `skills-lock.json`, and exposes them through the `.cursor/skills` and `.claude/skills` symlinks. `packages/permdock/skills` holds the consumer skills, which ship in the npm package.

## Decision

Maintainer skills stay in `.agents/skills`, installed with `npx skills add` and pinned in `skills-lock.json`. Consumer skills stay in `packages/permdock/skills`. `.agents/rules/skills.mdc` owns the details.

## Consequences

One copy serves every agent. A tool that reads neither symlink needs a pointer to `.agents/skills`.

## Withdrawn

Repo standard 1.7.1 matches this setup: a repo that publishes skills commits its vendored skills when `skills-lock.json` tracks them, because `npx skills add <repo>` skips lock-tracked skills. The skills CLI treats Cursor as a universal agent that reads `.agents/skills` directly, so `.cursor/skills` is gone and only `.claude/skills` holds symlinks.
