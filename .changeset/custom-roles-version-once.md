---
"permdock": minor
---

`claimsFirst(source, { versions })` serves the custom-role version of a tenant from the version cache, so a page of a member with a custom role reads it at most once per `maxStaleMs`. `permdock supabase hook generate` adds `authz_versions_for(p_user, p_tenant)`, which `postgrestSources` calls when both versions are needed in one tick, and a development warning names a custom-role version read twice within a second.
