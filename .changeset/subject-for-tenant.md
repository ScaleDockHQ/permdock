---
"permdock": minor
---

Add `subject_for(p_user, p_tenant)` to the generated Supabase hook: `subject_for(p_user)` for one tenant, reading that tenant's memberships through the new `memberships_for(p_user, p_tenant text)`. Global roles and the authorization version stay the user's; custom roles are those pinned to the tenant plus shared and platform roles; an unknown tenant, a tenant without a membership and a null tenant return `memberships: []`. `supabase.hook.api` also writes the `<prefix>subject_for` wrapper for the two-argument form, granted to `service_role` only. `permdock generate --only rls` and `permdock supabase hook generate` rewrite the hook file with the two new functions (an additive diff); no data migration is needed, because the change adds functions and no table or column. Docs: custom-role version and compiled roles, the `custom_roles_ver` claim, AuthZEN resource search paging, and `where(permission, { tenant })` on the Drizzle and Kysely pages.
