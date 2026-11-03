# 0055. `turbo.json` keeps the `global` block, narrows `global.inputs` and hashes type declarations for lint and typecheck

- Status: accepted
- Date: 2026-11-03

## Context

The repo standard keeps `globalEnv` and the other global keys at the top level of `turbo.json`, because `eslint-plugin-turbo` reads only those keys. PermDock enables the `globalConfiguration` future flag and uses the `global` block. `oxlint.config.ts` reads `turbo.global` and feeds the lists to `turbo/no-undeclared-env-vars`.

With `globalConfiguration`, `global.inputs` is prepended to the inputs of every task. `oxlint.config.ts` and `pnpm-workspace.yaml` in that list made every `build`, `test`, `doctor` and `size` task miss cache on a lint config edit or a catalog bump. Every Dependabot PR touches the catalog, and `pnpm-lock.yaml` already carries the per-package dependency hashes.

`lint` and `typecheck` depend on `^build`, which is always `permdock#build`. Any change under `packages/permdock/src` changed their hashes in every example, test and app, even when the emitted declarations were identical.

## Decision

- Keep the `global` block. Its per-task `global.inputs` semantics make the narrowing possible, and the `oxlint.config.ts` workaround stays.
- `global.inputs` lists only `packages/typescript-config/*.json`, which every task reads and no task hashes otherwise.
- `lint` and `typecheck` add `$TURBO_ROOT$/oxlint.config.ts` and `$TURBO_ROOT$/packages/permdock/package.json`, and a `dependencyOutputs` input of `dist/**/*.d.ts` from `^build`. They hash the declarations they read instead of the upstream task hash.
- `test`, `doctor`, `size`, `gen:check` and `check:publish` keep the upstream hash. They run the `.js` output and read `schemas/`, `rulesets/` and `skills/`.
- CI sets `TURBO_CACHE=local:,remote:rw`. Runners are ephemeral, so local cache writes are discarded.

## Consequences

A `permdock` change that leaves `dist/**/*.d.ts` and `package.json` unchanged leaves the `lint` and `typecheck` tasks of every consumer cached. `--dry=json` reports `hash: null` for these tasks, and no script reads that field. Revisit the `global` block when `eslint-plugin-turbo` reads it.

## Alternatives considered

- Move to top-level `globalDependencies`: those files then enter the global hash and cannot be excluded per task.
- Depend on `transit`: consumers read `dist/`, not source (0021).
