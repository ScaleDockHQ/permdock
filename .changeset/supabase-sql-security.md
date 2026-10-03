---
'permdock': patch
---

Supabase SQL security and performance:

- **Helpers.** `rls generate` and `supabase hook generate` put the `security definer` helpers, `role_permissions`, the closure, break-glass and `authz_version` tables and the hook in a private `permdock` schema the Data API does not expose. `authz_version.user_id` is a `uuid` that references `auth.users` and cascades on delete.
- **Casts.** The helpers, the hook, the ownership triggers, graph SQL and `rls verify --tree` compare a membership's user and scope columns uncast and cast the parameter instead, so the column's index applies.
- **`authorize()`.** It honours `effect = 'deny'` and membership expiry, and is executable by `authenticated` only.
- **Break-glass.** The break-glass read keeps the tenant boundary: a grant on a role reads only the rows of the scope instances where the subject holds it, through a `<permission>#break-glass` grant key.
- **Generated SQL.** It enables row level security before the grants and schema-qualifies every table. The hook reads `app_metadata` from the event instead of `auth.users`.
- **New `rls generate --split` parts.** `seeds` writes the `role_permissions` rows as a versioned migration (`--seeds-out`). `indexes` writes the indexes the policies and helpers filter through. `rls verify --introspect` warns about a column no index starts with.
- **New doctor checks.** PD046 to PD053 cover `user_metadata` in SQL, definer functions executable by `anon` or `public`, functions without `search_path`, `public` tables without RLS, unwrapped `auth.uid()`, `update` policies without `with check`, and unindexed foreign keys. PD054 flags stale `role_permissions` seeds. PD028 accounts for Supabase's default privileges and tracks `insert` and `update` apart.
- **`rls.anonymousSignIns: 'deny'`** keeps a Supabase anonymous sign-in out of every grant but `anyone()`'s.
- **`exchangeCapability`** signs `ES256` by default.
- **Contracts.** Every catalog permission carries `rowConditions`, which is `true` when the catalog was built without the policy. The claims schema and `supabaseClaims()` require a non-empty `sub` at each `act` level and accept `member: { group }`, which `subjectFromSupabase` keeps.
