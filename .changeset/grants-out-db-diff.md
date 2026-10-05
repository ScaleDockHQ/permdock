---
"permdock": minor
---

`rls generate --grants-out` and `supabase hook generate --grants-out` now move only what `supabase db diff` drops: schema privileges, function privileges (including the revokes on the hook's version and protection trigger functions, which no file carried before), the revoke on the `permdock_ceiling` view and its `security_invoker` option. Table grants, such as the `select` grants to `supabase_auth_admin`, and the `permdock_auth_admin_read_*` policies stay in the hook and helpers parts, because `db diff` diffs them and dropped them on the next diff when they lived only in a migration. Regenerate the parts and the grants file; a project that applied an earlier grants file keeps its privileges, and the next `db diff` then finds nothing to change.
