# 0057. `oxc-parser` and `jiti` are optional peers of the CLI

- Status: accepted
- Date: 2026-11-04
- Supersedes: [0042](./0042-two-cli-runtime-dependencies.md)

## Context

0042 kept `oxc-parser` and `jiti` as regular dependencies because neither can be inlined into the CLI build. An app that imports `permdock` for `can()` therefore installed both, about 3 MB with one native binary, and loaded neither. The standard asks for `@standard-schema/spec` as the only regular dependency.

Both are loaded only when the CLI reads source or a project module:

- `jiti` runs after Node's own `import()` cannot load a policy or config module (tsconfig `paths`, extensionless imports, `.tsx`), and in `doctor`'s import resolver.
- `oxc-parser` parses source in `scan`, `collect`, `doctor` and `codemod`, and reads the config values `permdock.config.ts` passes through `traceValues`.

## Decision

`permdock` declares `@standard-schema/spec` as its only dependency. `jiti` and `oxc-parser` are optional peers with the open floors `>=2` and `>=0.154` (decision 0045) and stay in `devDependencies` for the repository's own tests.

`src/cli/core/optional.ts` is the only CLI file that loads them. It loads each on first use with `createRequire`, because the call sites parse and resolve inside synchronous functions, and fails with `dependency_missing` and the install line for the project's package manager when the package is absent. `tests/package/cli-peers.test.ts` fails when another CLI file imports either package.

`tests/bundle/src/dependencies.test.ts` asserts the dependency list and the optional peer entries.

The peer audit found no other peer that only the CLI loads at module level: `pg`, `pgsql-parser` and `@napi-rs/keyring` already load through `requirePeer` in the command that needs them, and `vue` and `solid-js` appear only as text in generated hooks.

## Consequences

An app that never runs the CLI installs neither package. A project that runs `permdock scan`, `collect`, `doctor` or `codemod` installs `oxc-parser`, and one whose modules Node cannot import natively installs `jiti`; the error names the command to run. Node 24 loads TypeScript policy modules natively, so most projects need `jiti` only for `paths` aliases or `.tsx`.

`CLI` gzip size and startup, measured on the same tree before and after the change:

| Measure                              | Before  | After   |
| ------------------------------------ | ------- | ------- |
| `./cli` gzip graph (bytes)           | 803,146 | 806,173 |
| `permdock --version` median of 9     | 49 ms   | 22 ms   |
| `permdock doctor --help` median of 9 | 35 ms   | 29 ms   |

The `./cli` growth is `optional.ts` and the PD092 lockfile check. The startup numbers differ by machine load between the two runs; neither command loads either peer.

PD092 reads `pnpm-lock.yaml` and warns when one `permdock` version resolves with two peer sets, the case where two copies of the package share a process. The client store is the one copy-local key, now `Symbol.for("permdock.store")`.

## Alternatives considered

- Keep both as dependencies (0042): every app installs a native binary it never loads.
- Replace `jiti` with Node's type stripping: it does not resolve tsconfig `paths` or load `.tsx`.
- Convert every parse call to `await import()`: the parse helpers are synchronous and used in tight loops, so the change touches every scan and codemod for no gain over loading once with `createRequire`.
