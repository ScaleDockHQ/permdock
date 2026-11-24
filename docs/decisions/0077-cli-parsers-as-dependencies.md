# 0077. `oxc-parser`, `pgsql-parser` and `libpg-query` are dependencies of the CLI

- Status: accepted
- Date: 2026-11-24
- Supersedes: [0057](./0057-optional-cli-peers.md) for `oxc-parser`

## Context

0057 made `oxc-parser` an optional peer so an app that imports `can()` installs no native binary. The CLI now edits user files from the parse trees (codemods, doctor readers, SQL readers). A range of parser versions makes the same codemod write different files, and a missing peer made `doctor` and `codemod` fail on a fresh install.

## Decision

`permdock` depends on `oxc-parser` 0.159.0, `pgsql-parser` 18.4.2 and `libpg-query` 18.2.4, each exact. `libpg-query` is the copy `pgsql-parser` installs; it is listed because the PL/pgSQL entry is imported from it. Runtime entries still depend on `@standard-schema/spec` only, and `tests/bundle` asserts that no runtime entry reaches a parser. `oxc-parser` matches the pin of better-supabase, so an app with both installs one copy. `jiti`, `pg` and `unplugin` stay optional peers.

## Consequences

An app that never runs the CLI still installs the three packages (about 3 MB for `oxc-parser` plus one binding, and 1.8 MB for `libpg-query`) and loads none of them.

## Alternatives considered

- Keep optional peers: the version of the parser decides the output, and the first run fails without it.
- Bundle the parsers: a native binding and a WASM file cannot be inlined.
