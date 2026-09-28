# permdock

## 0.1.0-next.0

### Minor Changes

- 93889da: Catalog v1 carries a top-level `fingerprint` and per-permission `approvals`. `catalogFingerprint(catalog)` is exported from `permdock`: base64url SHA-256 over canonical JSON without `generatedAt`, `generator`, `fingerprint` and `usages`, so the CLI version and call sites no longer change it. `permdock collect --check` ignores `generator`.
- 8b0c917: `cloud().approvals` implements `cancel(filter, meta)` over `POST /v1/environments/:env/approvals/cancel`, so session revocation rejects pending Cloud approvals in one call.
- 8bfa791: `cloud().policies.refresh()` verifies the `permdock-policy+jwt` against the Cloud environment URL (`iss` and `aud` are `<PERMDOCK_CLOUD_URL>/v1/environments/<env>`; `exp` is 24 hours after issue). The `audience` option is removed. `cloud()` exposes the environment URL as `issuer`, `jwks` is the environment's JWK Set URL, and `cloudEndpoints()` resolves both without a key. The policy JWS fixture in `@permdock/testing` follows the new claims.
- 80db0c7: `cloud().snapshots.get()` requests `application/jwt` and returns only a compact `permdock-snapshot+jwt`; an unsigned snapshot body now throws instead of being parsed.
- e9a80d6: Add `toCsvRow(event)` and `CSV_COLUMNS`: the pinned CSV export row for decision and approval events, shared by the Cloud export and self-hosted sinks.
- 223abdb: First release of PermDock: typed, portable permissions for apps, APIs and agents, with the `permdock` core and adapters, the `@permdock/cli` build tooling and the `@permdock/testing` runners.
- f6179a9: `dev.permdock.catalog` drift findings are typed `CatalogFinding` objects `{ code, permission, grant? }` with `code` one of `permission-removed`, `not-hostable`, `grantee-removed` or `approval-tightened`; `parseCloudEvent` and `verifyWebhook` reject the earlier free-text strings.

### Patch Changes

- e600592: Document the PermDock Cloud contract v1: `client`, `admin` and `export` key kinds, the authoring routes (`/hosted-grants`, `/directory/*`, `/connectors`, `/export`), the environment's JWKS and OIDC Discovery, RFC 8693 token exchange at `<env URL>/oauth/token` minting RFC 9068 access tokens, the raw sink body the Cloud envelopes as CloudEvents, and `membership` events with `source: 'cloud'`.
- c8c5c77: The `cloud()` sink bounds its re-queue while the Cloud is unreachable (`capacity`, default 10 000, oldest dropped first), matching `memorySink`.
