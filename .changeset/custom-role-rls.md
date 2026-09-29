---
'permdock': minor
'@permdock/cli': minor
---

Custom roles in generated RLS. `permdock rls generate --custom-roles` (or `rls.customRoles: true`) makes `permitted_tenant_ids` and `permitted_team_ids` resolve tenant-defined custom roles as well: from the new `custom_role_permissions` and `custom_role_includes` tables in `database` mode, or from a compact `memberships[].grants` claim in `jwt` mode (off unless the flag is set). Both go through `permdock_custom_keys` and a generated `permdock_ceiling` view of the assignable declared roles, so a row or claim entry outside the ceiling never widens access, and the database agrees with `resolveCustomRole`. `authorizeSql({ customRoles: { declared } })` answers tenant requests from custom roles, and `--rbac supabase --custom-roles` passes it through.

`customRoleClaim(roles)` builds the claim map for a token hook. `rls verify` fixture files accept `customRoles` (resolved in-process, sent in the claim, and seeded into the tables in `database` mode), and `rlsParity` accepts `customRoles`. An included role's denies now apply to a custom role only in the custom role's own scope, matching what RLS can evaluate. Output without `--custom-roles` is unchanged.
