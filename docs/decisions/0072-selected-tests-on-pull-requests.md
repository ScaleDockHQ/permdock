# 0072. Pull requests run selected tests; main runs everything

- Status: accepted
- Date: 2026-11-20

## Context

Over 40 successful pull request runs, the wall time was p50 293 s and p95 1,040 s. Setup took 59 s at p50 in each of about 12 jobs (585 s of 1,686 s of job time). A cold unit run took 221 s with coverage on, against 44 s without it locally. The 98% coverage gate with a rule never to lower it produced `tests/cli/coverage-*.test.ts` and `gap-branches.test.ts`, files named after uncovered branches.

## Decision

- A pull request runs the test files its diff reaches: `scripts/select-tests.ts` asks `vitest list --changed` for the module graph, adds `tests/invariants`, `tests/package` and `tests/standards`, and runs everything when the diff touches a lockfile, a manifest, a config, a workflow or a non-TypeScript test input. The integration list step aliases `permdock` to `src/`; runs still use `dist/` (0021).
- A push to `main`, the nightly run and a pull request labelled `ci:full` run every suite whole, with coverage under one 90% floor and no ratchet. A selection miss turns `main` red, and `release.yml` publishes only after a green run (0065).
- `CI` is the one required check, so adding, renaming or skipping a job never edits branch protection.
- Jobs beside `static` install with `--trust-lockfile`: `static` checks the same lockfile against `minimumReleaseAge` and `trustPolicy` in the same run, and `CI` requires it. The restored `pnpm-lockfile-verified` cache did not shorten the 16 to 19 s check.
- Dependabot runs use a local Turbo cache, because the signature key for the Remote Cache is not available to them.
- Integration shards take files by recorded duration (`tests/integration/shard-weights.json`); the Postgres container runs with `fsync=off` and a tmpfs data directory.

## Rejected

- `isolate: false` for the unit suite: 79 s against 44 s locally, and six files failed on shared state.
- One Postgres per shard with a database per file: 112 setups create cluster-level roles, and the change cannot be verified without Docker here. Not done.
- A merge queue, Redis work-stealing and paid runners.

## Consequences

- A test that reads a file by path instead of importing it is invisible to the selection. `testing.mdc` says where to put it.
- The 90% floor is measured once per merge, not per pull request.
