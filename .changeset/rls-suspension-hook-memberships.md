---
'permdock': minor
---

Suspension in generated RLS, and a token hook that writes memberships. `rls.suspension` (also a `supabaseRls` and `authorizeSql` option) names a users table and a table per scope, each `{ table, id, disabledAt?, status?, active? }`. `permdock_has`, every `permitted_<scope>_ids` and `authorize()` then drop a suspended user's roles and every membership whose instance or ancestor instance is suspended. The check runs live in `database` and `jwt` mode, and a missing status row counts as suspended. `generate` fails on a suspension entry with an undeclared scope, no `disabledAt` or `status`, a `status` without `active`, or a nested membership table without the ancestor column it needs.

In `jwt` mode, `permdock rls generate --rbac supabase` now emits a `custom_access_token_hook` that also writes the canonical `memberships` claim (`{ scope, id, within?, roles, via?, expiresAt? }`) from every `rls.memberships.scopes` table. It leaves out expired and suspended entries, gives a suspended user `user_role: []` and `memberships: []`, and grants `supabase_auth_admin` read access to the tables it reads. `supabaseRls({ memberships })` accepts `scopes`, and `SupabaseMembershipTable` accepts `columns`, like `RlsMembershipTable`.
