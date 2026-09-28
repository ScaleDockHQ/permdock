# @permdock/cli

## 0.1.0-next.0

### Minor Changes

- 93889da: Catalog v1 carries a top-level `fingerprint` and per-permission `approvals`. `catalogFingerprint(catalog)` is exported from `permdock`: base64url SHA-256 over canonical JSON without `generatedAt`, `generator`, `fingerprint` and `usages`, so the CLI version and call sites no longer change it. `permdock collect --check` ignores `generator`.
- 223abdb: First release of PermDock: typed, portable permissions for apps, APIs and agents, with the `permdock` core and adapters, the `@permdock/cli` build tooling and the `@permdock/testing` runners.
