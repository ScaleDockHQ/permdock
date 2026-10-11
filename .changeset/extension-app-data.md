---
"permdock": minor
---

`definePermissions`, `defineRoles`, `definePlans` and `definePolicy` take an `x` option with one Standard Schema per kind of app data, which checks and types `meta.x` on permissions, resources, roles, plans and grants and `Membership.x` on memberships. `resource({ meta })`, `allow(p, { meta })`, `Membership.x` and custom-role `meta.x` are carried to decisions, events, snapshots and `catalog-v1` (optional `meta` on resources and grants), and PermDock never reads them; the Supabase sources read `Membership.x` from a `jsonb` column set with `x`.
