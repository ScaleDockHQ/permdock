---
"permdock": minor
---

`supabase.hook.api` now writes the `permdock_subject_for`, `permdock_members_of` and `permdock_authz_version_for` wrappers as `security invoker` functions, so the Data API schema holds no `security definer` function. `service_role` gets `usage` on the hook schema and `execute` on the three readers there. Re-run `permdock supabase hook generate` and apply the migration.
