---
"permdock": minor
---

`permdock/jwt` caps the JWKS cache at 600 seconds for a Supabase issuer, and `joseTokenVerifier` returns a `JoseTokenVerifier` with `purgeKeys()`. `supabase.hook.claims` cannot name `jti`, `nbf`, `acr`, `act`, `client_id`, `scope` or `custom_roles_ver`. Doctor adds PD113, a warning for source that reads the legacy HS256 secret, and PD110 and `permdock claims size` measure a token with OAuth-sized `user_metadata`, a long email and a `client_id`. No generated SQL changes: `permdock generate --only rls` rewrites nothing and no data migration is needed.
