# 0042. The CLI inlines its dependencies except `oxc-parser` and `jiti`

- Status: accepted
- Date: 2026-10-21

## Context

Invariant 12 keeps runtime entries free of CLI code, but every regular dependency of `permdock` is still installed by every app that imports `permdock` for `can()`. In 0.6.0 the CLI's seven libraries were regular dependencies, so an app that never runs the CLI installed `@clack/prompts`, `diff`, `jiti`, `oxc-parser` (with its native binaries), `smol-toml`, `package-manager-detector` and `fastest-levenshtein`. The standard asks for `@standard-schema/spec` as the only runtime dependency.

Two of them cannot be inlined into the CLI build:

- `oxc-parser` loads a platform binary from its `@oxc-parser/binding-*` optional dependencies at run time.
- `jiti` loads its Babel transform with `createRequire(import.meta.url)("../dist/babel.cjs")`, a path relative to its own file that does not exist once its code moves into `permdock`'s `dist`.

## Decision

`tsdown` inlines the five pure-JS CLI libraries and their own dependencies into the CLI chunks through `deps.onlyBundle`, next to `ajv` and `yaml`. They move to `devDependencies`. `permdock` declares three dependencies: `@standard-schema/spec`, `oxc-parser` and `jiti`.

`tests/bundle/src/dependencies.test.ts` asserts that list. `packages/permdock/tests/package/runtime-imports.test.ts` walks the source graph of every runtime entry and fails when one reaches `src/cli` or a CLI library, because an inlined library no longer appears as an import in `dist`.

## Consequences

An app that imports `permdock` installs `oxc-parser` and `jiti`, about 3 MB with one native binary, which it never loads. The CLI grows by the inlined code: `./cli` from 690,568 to 715,477 bytes gzip (`tests/bundle/src/baseline.json`). A security fix in an inlined library needs a `permdock` release.

## Alternatives considered

- Make `oxc-parser` and `jiti` optional peers: `permdock scan`, `doctor`, `codemod` and every command that loads a policy would first ask the user to install a package.
- Replace `jiti` with Node's type stripping: it does not resolve tsconfig `paths` or load `.tsx`, which projects use for their policy modules.
- Move the CLI to its own package: decision 0020 keeps it in `permdock`, so the CLI and the app resolve one `permdock`.
