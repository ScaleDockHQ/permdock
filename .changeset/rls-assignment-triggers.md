---
"permdock": minor
---

`rls.assignments` adds assignment triggers in `database` mode: each scope's `rls.memberships` table, and each table in `rls.assignments.tables` such as invitations, gets a `before insert or update or delete` trigger that refuses a client role's write of a role the caller may not assign at that instance (SQLSTATE `42501`, hint `not-assignable-by`). Declared roles follow the `assigns` graph through `permdock_can_assign`; custom roles go through the new `permdock_can_assign_custom_role`, which runs the custom-role write checks on the stored definition. Writes that do not run as a client role (the owner, a `security definer` function, a backend role) are trusted, which covers bootstrap paths without a bypass setting.
