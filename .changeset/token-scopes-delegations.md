---
"permdock": minor
---

`rls.tokenScopes: { delegations: true }` compiles policy delegations to `actor('oauth-client')` from `authenticated()` into the SQL helpers, so an OAuth client token whose scopes are identity-only (as Supabase Auth issues them) is capped at the delegation on the Data API too, instead of holding nothing. `tokenScopes: true` is unchanged.

Doctor fixes: PD058 compares `sync-config.yaml` with the publication statement in the schema files, as `permdock generate --only powersync` writes it, so a current file is no longer reported stale, and its fix names `permdock generate --only powersync`. PD053 counts `unique nulls not distinct (...)` and `unique nulls distinct (...)` constraints as indexes.
