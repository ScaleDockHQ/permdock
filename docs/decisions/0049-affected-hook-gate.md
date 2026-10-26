# 0049. Affected lint and typecheck on commit, no tests in hooks, `CI` not hashed

- Status: accepted
- Date: 2026-10-26

## Context

The standard's `lefthook.yml` formats staged files on pre-commit and runs `turbo run lint lint:root typecheck test --affected` on pre-push, each through `pnpm exec`. Its `turbo.json` lists `CI` and `NODE_ENV` in `globalEnv`.

Measured in this repository on an 18-core Mac:

- `pnpm exec` adds 70 to 260 ms per hook command.
- With everything cached, the affected lint and typecheck gate takes 1.4 s. Tests added minutes to every push: the `permdock` suite alone takes 18 to 47 s with coverage, and a cold affected run took 3m20s.
- `CI` in `globalEnv` gave every task a different hash locally and in GitHub Actions, so a developer never hit a cache entry that CI wrote, and the other way round.

## Decision

- `lefthook.yml` calls `node_modules/.bin/<tool>` directly.
- Pre-commit formats the staged files with Oxfmt, then runs `turbo run lint:root lint typecheck --affected --cache=local:rw,remote:r --output-logs=errors-only --continue=dependencies-successful`. It skips merges and rebases. `pnpm check:affected` is the same command.
- Pre-push runs the same gate. Tests run in CI only.
- Hooks print a job's output only when the job fails (`output: [meta, summary, failure]`).
- `CI` is in `global.passThroughEnv`. Tasks whose output depends on it list it in their own `env`: `permdock#test`, `//#typecheck:perf` and `//#cli:startup`. `NODE_ENV` is in the `build` task's `env`.

## Consequences

- A warm commit takes about 3 s. A commit that changes the root `package.json` or `pnpm-lock.yaml` re-runs the whole graph: 50 to 70 s.
- A failing test reaches the author in CI, not on push.
- A task that starts reading `CI` must add it to its `env`, or its cache entry may replay the wrong output.
- Lefthook 2.2.1 is the floor. Earlier versions fail a commit with partially staged files on Git 2.54 (evilmartians/lefthook#1581).

Revisit if CI test failures that a push-time run would have caught become common.

## Alternatives considered

- Keep tests on pre-push: costs minutes on every push for failures CI reports anyway.
- Run the gate on pre-push only: the commit hook then catches nothing but formatting, and a broken commit lands in history before the push.
- Keep `CI` in `globalEnv`: keeps local runs and CI on separate cache entries.
