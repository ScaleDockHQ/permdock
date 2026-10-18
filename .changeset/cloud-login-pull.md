---
"permdock": minor
---

The CLI signs in to PermDock Cloud and reads what was published. `permdock login` runs the RFC 8628 device flow against `https://permdock.com/api` (`--loopback` for the RFC 8252 browser redirect with PKCE, `--write` to add `catalog:write`, `--url` for another issuer) and stores the credential outside the repository through `permdock/terminal`; `permdock logout` revokes and deletes it. `permdock cloud pull --project <id>` writes `permdock.manifest.json` and `permissions.catalog.json` as `supabase inspect --out` and `collect` write them, checks the fingerprint, and restores the previous files on a mismatch. `permdock rls generate --project <id>` builds its policy from the project with `policyFromCatalog`. `PERMDOCK_CLOUD_TOKEN`, a read-only key pinned to one environment, authenticates `pull` and `rls generate --project` in CI. `permdock cloud push` also sends `manifest` (`--manifest`) and `permdockVersion`, and accepts a login with `catalog:write` when `PERMDOCK_CLOUD_KEY` is unset. `@napi-rs/keyring` is an optional peer for the OS keychain.

The docs MCP server moved from `https://permdock.com/mcp` to `https://permdock.com/docs/mcp`; the `permdock` skill names the new URL. `https://permdock.com/mcp` is now the PermDock Cloud MCP server.
