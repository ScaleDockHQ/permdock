# 0077. `oxc-parser`, `pgsql-parser` and `libpg-query` are dependencies of the CLI

- Status: accepted
- Date: 2026-11-24
- Supersedes: [0057](./0057-optional-cli-peers.md) for `oxc-parser`
- Makes an exception to: [0045](./0045-open-peer-ranges-and-better-supabase-0-13-floor.md) for `@supabase/pg-delta` and `@supabase/pg-topo`

## Context

0057 made `oxc-parser` an optional peer so an app that imports `can()` installs no native binary. The CLI now edits user files from the parse trees (codemods, doctor readers, SQL readers). A range of parser versions makes the same codemod write different files, and a missing peer made `doctor` and `codemod` fail on a fresh install.

## Decision

`permdock` depends on `oxc-parser` 0.159.0, `pgsql-parser` 18.4.2 and `libpg-query` 18.2.4, each exact. `libpg-query` is the copy `pgsql-parser` installs; it is listed because the PL/pgSQL entry is imported from it. Runtime entries still depend on `@standard-schema/spec` only, and `tests/bundle` asserts that no runtime entry reaches a parser. `oxc-parser` matches the pin of better-supabase, so an app with both installs one copy. `jiti`, `pg` and `unplugin` stay optional peers.

`@supabase/pg-delta` and `@supabase/pg-topo` are optional peers with the ranges `>=1.0.0-alpha.61 <1.0.0` and `>=1.0.0-alpha.8 <1.0.0`, the only peer ranges with an upper bound. An alpha changes the plan `rls verify --shadow` reports and the load order PD125 reads, so the open floor of 0045 does not fit; the bound lifts at 1.0.0. better-supabase 0.84.0 depends on both at exact versions and its BS709 tells the app to remove its own entries, so `shared/app-peer.ts` resolves each from the app, then from the installed `better-supabase`. `tests/package/peers.test.ts` accepts only this form for the two names.

## Consequences

An app that never runs the CLI still installs the three packages (about 3 MB for `oxc-parser` plus one binding, and 1.8 MB for `libpg-query`) and loads none of them.

## Alternatives considered

- Keep optional peers: the version of the parser decides the output, and the first run fails without it.
- Bundle the parsers: a native binding and a WASM file cannot be inlined.
