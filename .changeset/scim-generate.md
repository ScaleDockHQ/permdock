---
"permdock": minor
---

`permdock scim generate` writes the tenant-keyed Postgres tables for a SCIM directory (`scim_users`, `scim_groups`, `scim_group_members`), revoked from the data API's client roles, and `permdock/scim` exports `postgresDirectoryStore(query, { schema })`, the `DirectoryStore` over them, so one `scimHandler` behind the Cloud relay serves every tenant. `SqlQuery` moves to core and is exported from `permdock/scim` as well as `permdock/supabase`.
