---
"permdock": minor
---

`blockMembershipSource({ roles: "many" })` reads every role of a member from better-supabase 0.18's `membership_roles`, and a `tableMembershipSource` or `junctionMembershipSource` role `through` may now join on several columns. `authorizationProvider` names such a role set as the membership's `rolesTable` and fills `tokenHook.activeOrganizationFrom` from the manifest's `hook.activeFrom`, so better-supabase's doctor BS411 and BS409 check them. The Supabase manifest's `through` gains an optional `on`.
