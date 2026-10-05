---
"permdock": patch
---

Deleting an `auth.users` row no longer fails when its memberships cascade. The generated `permdock_bump_authz_version_for` and `permdock_bump_authz_version_role_keys` now skip a user that is no longer in `auth.users`, so the version trigger on a membership table cannot insert a `permdock_authz_version` row that violates its foreign key. Regenerate the hook SQL and apply the changed function body in a migration.
