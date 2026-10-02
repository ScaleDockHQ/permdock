# 0017. Consumer skills are named `permdock` or `permdock-<topic>`

- Status: accepted
- Date: 2026-10-02

## Context

The scaledock-skills naming rule prefixes opinionated skills with `scaledock-`, because installed skills from every publisher share flat folders such as `.agents/skills/<name>`. An unprefixed name overwrites, or is overwritten by, another publisher's skill. PermDock's consumer skills are opinionated, but they belong to PermDock rather than ScaleDock. The two skills shipped so far were `wire-permdock` and `audit-permissions`, and `audit-permissions` is generic enough to collide.

## Decision

- Every consumer skill in `packages/permdock/skills` is named `permdock` (the general entry skill) or `permdock-<topic>`, and its folder has the same name.
- `wire-permdock` is renamed `permdock-wire` and `audit-permissions` is renamed `permdock-audit`. Nothing has shipped, so no alias is kept.
- The shipped set is listed in `SKILL_NAMES` (`packages/permdock/src/cli/skills.ts`), `.claude-plugin/marketplace.json` and `.agents/rules/skills.mdc`.

## Consequences

`permdock doctor` PD005 looks for `permdock/SKILL.md`. A new consumer skill takes a `permdock-` name and updates the three lists above. Revisit if PermDock skills move into `ScaleDockHQ/scaledock-skills`, where they would take a `scaledock-` name instead.
