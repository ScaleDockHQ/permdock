# 0020. The CLI ships inside `permdock`

- Status: accepted
- Date: 2026-10-03

## Context

The repo standard's CLI reference (`references/cli.md`) puts a library's CLI in `packages/cli`, published as `@<scope>/cli` in a Changesets `fixed` group with the library. PermDock ships its CLI as the `permdock` bin and the `permdock/cli` entry of the one published package.

## Decision

- The CLI stays in `packages/permdock/src/cli`. Its commands import the user's policy and permissions modules and compile them with the same core that runs in the app (`rls generate`, `usage`, `doctor`, `diff`). In a separate package, a project could install a `@scaledockhq/cli` that resolves a different `permdock` than the app, and the SQL it generates would then follow other evaluation rules than the app. One package makes that mismatch impossible, and `npx permdock` works without a second install.
- The cost the standard guards against, CLI dependencies reaching apps, is covered differently: runtime entries depend on `@standard-schema/spec` only (invariant 12), `tests/bundle` fails if a runtime entry reaches a CLI package, heavy CLI dependencies are optional peers, and every command loads lazily.
- `CliError` carries a `kind` (`usage` or `unavailable`) rather than `code` and `exitCode`; `run()` maps the kind to the exit code and the Problem Details `type`. Commands that report their own usage errors return them as results, and a `CliError` propagates to `run()`.
- Ctrl-C ends a `--db` command's client or pool through a `SIGINT` listener that the connection registers and removes. The connection is opened deep inside a command, so threading an `AbortController` from `bin.ts` would cross every command's input.

## Consequences

- `permdock` versions the CLI and the library together without a `fixed` group.
- `knip`, `tests/bundle` and invariant 12 have to keep CLI code away from runtime entries. A separate package would enforce that by construction.

## Alternatives considered

- `packages/cli` published as `@scaledockhq/cli` in a `fixed` group: allows the version mismatch above, and `npx permdock` would need a second package.
- A CLI package with `permdock` as a peer: the peer range still allows a mismatch inside it.
