# TypeScript 7.1 upgrade

The repository builds with TypeScript 7.0.2 and `oxlint-tsgolint` 7.0.2004. Do the 7.1 bump as one commit that touches every place below, once 7.1 is older than `minimumReleaseAge`.

1. Pin `typescript` in the `catalog` of `pnpm-workspace.yaml` with `pnpm view typescript version`. Never lower the release-age gate to get it sooner.
2. Bump `oxlint-tsgolint` in the same commit (AGENTS.md, "When you change X"). Its major and minor follow TypeScript's, so pick the release built for 7.1.
3. Check every override and peer rule that names `typescript`. Today that is `"@sveltejs/kit>typescript": "7"` under `overrides`. A range of `"7"` already admits 7.1; change it only if SvelteKit's peer range moves.
4. Leave `catalogs.ts59` (5.9.3) and `catalogs.ts6` (6.0.3) alone. `tests/types/ts-5.9` and `tests/types/ts-6` prove that consumers on older compilers can still read the declarations, and decision 0002 forbids a global `typescript` override because it would force them to 7. Only `tests/types/ts-7` follows the catalog.
5. Run `pnpm typecheck`, which covers `tests/types/ts-*`, and `pnpm --filter permdock test` for the `*.test-d.ts` files. 7.1 reports a conditional type that is "only assignable to the non-distributed" form. The 49 conditional types in `packages/permdock/src` and `apps` were read for that pattern and none matches. `InferPermissionTree` (`tests/core/permission-types.test-d.ts`) and `MergeActionRecords` (`tests/core/presets.test-d.ts`) are the two closest and carry `expectTypeOf` cases, so a change shows up there first.
6. Re-run the baselines and put the before and after numbers in the commit:
   - `pnpm typecheck:perf` for type instantiations and check time (`scripts/typecheck-perf.json`);
   - `pnpm size` for per-entry gzip (`tests/bundle/src/baseline.json` and `consumers.json`); a compiler bump moves them only if emitted declarations or `tsdown` output change;
   - `pnpm cli:startup` for CLI start time (`scripts/cli-startup.json`).
7. Run `pnpm verify`.

Moving `target` and `lib` in `packages/typescript-config/base.json` from `es2025` to `es2026` is a separate decision with its own pull request. It changes the emitted syntax and the runtimes PermDock supports, and needs the runtime matrix in `tests/runtimes` to pass on it first.
