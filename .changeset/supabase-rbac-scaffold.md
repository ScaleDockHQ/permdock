---
'permdock': minor
'@permdock/cli': minor
---

`permdock rls generate --rbac supabase` emits the full Supabase RBAC scaffold: re-runnable enums, a multi-role `user_roles` table, `authorize()` executable by `authenticated` only, and a `custom_access_token_hook` with `set search_path = ''` that writes `user_role` only when the user has a role. It also emits the `supabase_auth_admin` grants and read policy the hook needs, and prints the `config.toml` stanza. New flags: `--rbac-schema` and `--authorize database|jwt` (also `rls.rbac` in `permdock.config.ts`). Policies call the schema-qualified `authorize()`, tenant-scoped grants pass the row's tenant, and `insert` policies no longer carry an invalid `using` clause. `permdock doctor` adds PD019 for JWT-mode `authorize()` with `jwt_expiry` above an hour.

Security: `authorizeSql` in `permdock/supabase` used to ignore `requested_tenant`, so a role held in one tenant passed checks for another. It now takes `{ schema, authorize, tenant }`, checks the tenant against the membership table (database mode) or the `memberships` claim (JWT mode), denies tenant requests when neither is configured, and reads every role a user holds.
