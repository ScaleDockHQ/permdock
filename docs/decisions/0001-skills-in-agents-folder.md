# 0001. Vendored skills stay in `.agents/skills`

- Status: accepted
- Date: 2026-09-30

## Context

The standard installs skills per tool. This repository already vendors them once in `.agents/skills`, pinned in `skills-lock.json`, and exposes them through the `.cursor/skills` and `.claude/skills` symlinks. `packages/permdock/skills` holds the consumer skills, which ship in the npm package.

## Decision

Maintainer skills stay in `.agents/skills`, installed with `npx skills add` and pinned in `skills-lock.json`. Consumer skills stay in `packages/permdock/skills`. `.agents/rules/skills.mdc` owns the details.

## Consequences

One copy serves every agent. A tool that reads neither symlink needs a pointer to `.agents/skills`.
