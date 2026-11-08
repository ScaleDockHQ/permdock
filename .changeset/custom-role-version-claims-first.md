---
"permdock": minor
---

A token that holds a custom role stays claims-first: `MembershipSource.customRolesVersion` and `Principal.customRolesVersion` (the `custom_roles_ver` claim) are compared with the tenant's version, and only a token behind either version reads the subject. `postgrestSources` reads `custom_roles_version_for` (wrapper `permdock_custom_roles_version_for` with `supabase.hook.api`), `SubjectCache.record` takes the tenant versions and `SubjectRecord.customRolesVersions` carries them, so a custom-role edit no longer serves stale grants. A truncated token reads the versions before the subject, so the subject cache serves it. The instance cache key and the custom-role answers include the tenant version. A token without the claim, or a source without the method, is read live as before.
