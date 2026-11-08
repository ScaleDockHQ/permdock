# 0062. File-level lint suppressions in `scripts/next-baseline.ts`

- Status: accepted
- Date: 2026-11-08

## Context

The standard allows an `oxlint-disable` only on the line it silences, with a reason. `scripts/next-baseline.ts` drives `agent-browser` for the Next sample measurements and reads its JSON output, which has no published types. It is one function per route and per metric over `unknown` data, and its first line disables four rules for the whole file:

- `max-lines-per-function`: each measurement is one sequence of `agent-browser` calls that reads better in one body than split across helpers that share no logic.
- `no-negated-condition`: the driver tests for a missing field first and returns early.
- `typescript/prefer-readonly-parameter-types`: the parsed JSON objects are passed along unchanged.
- `typescript/no-unsafe-assignment`: the values come out of `JSON.parse` as `any`.

A line-level suppression would repeat the same comment about 40 times.

## Decision

`scripts/next-baseline.ts` keeps one block comment on line 1, `/* oxlint-disable … -- one-off measurement driver over untyped agent-browser JSON */`. No other file in the repository has a file-level suppression of an oxlint rule. Generated files (`routeTree.gen.ts`, the Prisma client) carry their own `eslint-disable` headers.

## Consequences

- A new violation of the four rules in this file passes lint.
- The file is not imported by the package or an app, so the loosened rules never reach published code.
- Replace the suppressions with a typed parser of the `agent-browser` output if the driver becomes a gate; revisit then.

## Alternatives considered

- A line-level suppression per use: about 40 identical comments.
- Typing the `agent-browser` output: the schema belongs to another tool and changes between releases.
- Excluding `scripts/next-baseline.ts` in `oxlint.config.ts`: the other rules would stop applying too.
