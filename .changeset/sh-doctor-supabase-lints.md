---
"permdock": minor
---

`permdock doctor` adds two Supabase checks. PD040 warns on `auth.role()` in a migration, which Supabase deprecated; name the policy's roles with `to authenticated` instead. PD041 warns when `exchangeCapability` signs with `alg: 'HS256'`, the project's shared JWT secret; sign with `ES256` and an asymmetric signing key.
