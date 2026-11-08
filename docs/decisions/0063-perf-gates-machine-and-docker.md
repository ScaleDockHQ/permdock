# 0063. The runtime and `rls-bench` gates: timings on one machine, Docker in the perf job

- Status: accepted
- Date: 2026-11-08

## Context

`pnpm verify` ran three measurement gates: `typecheck:perf`, `generate:perf` and `cli:startup`. `generate:perf` fails on peak RSS and only prints wall time, because a `verify` run shares the machine with other tasks. Two more gates are needed: the runtime and token matrix against `scripts/runtime-perf.json`, and the plan shapes of the generated policies on the scale fixture.

- `scripts/runtime-perf.json` was recorded on one Mac (`darwin-arm64`, Node 24). Its cells run from 0.01 ms to seconds. On that machine, the same cell varied by up to 17% between two runs (`m150-r20-c0 instanceBuild`, 1.652 ms recorded, 1.944 ms measured), above the 10% margin.
- The plan-shape gate needs Postgres, so it needs Docker. `pnpm test:integration` already needs it; `pnpm verify` did not.

## Decision

- `pnpm runtime:perf` (`scripts/runtime-perf.ts --check`) measures the quick matrix cells that the committed record measured and fails a cell 10% above it. A cell the record skipped, or lacks, stays skipped. A per-call limit adds a 0.05 ms noise floor, and a per-item limit of a capped measurement adds 0.001 ms. A cell is measured up to three times and fails only if every attempt is over.
- `snapshotBytes` is deterministic, so it fails on every machine. A timing fails only when the record's `platform` and Node major match the machine; otherwise it prints as a note.
- `pnpm rls-bench` runs `tests/integration/gate/plan-shape.test.ts` on the 1k tier. It is a separate Vitest project, `plan-gate`, so `pnpm test:integration` does not run it twice. Its ceilings are constants in the test: 50 ms per statement, and 25 ms warm and 250 ms cold for the fixed helper cost. The 1k medians in `tests/integration/bench/baselines/scale-1k.json` are under 1 ms.
- Both tasks run in the `perf` job of `.github/workflows/verify.yml`, alone on the machine with `--concurrency=1`. `pnpm verify` runs `rls-bench` with the other tasks and `runtime:perf` in a second `turbo run --concurrency=1` after them: beside the test suite, its per-item timings measured 1.2 to 2.3 times the record.

## Consequences

- `pnpm verify` needs Docker, as `pnpm test:integration` does. README lists Docker for `rls-bench`.
- A baseline recorded on a CI runner would turn the timing notes into failures there; record it with `node scripts/runtime-perf.ts --write` on the runner's platform.
- The plan-shape ceilings catch a change in complexity, such as a scan or a per-row helper call, and not a 2x slowdown; the shape assertions carry the gate.

Revisit when the runtime record exists for the CI platform.

## Alternatives considered

- Print the timings without enforcing them, as `generate:perf` does for wall time: a 10% regression in `where()` would pass.
- Enforce timings on every machine: a Linux runner compared with a Mac record fails on hardware, not code.
- Run `rls-bench` inside `pnpm test:integration`: the gate runs twice in CI and a ceiling that flakes under shared load fails an unrelated shard.
