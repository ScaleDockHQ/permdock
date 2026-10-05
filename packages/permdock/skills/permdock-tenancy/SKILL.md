---
name: permdock-tenancy
description: Models tenants, memberships and role rules in PermDock. Use when declaring named scopes (organizations, workspaces, customers inside an organization), loading memberships through a MembershipSource, putting a role on one scope, keeping an owner per organization with min, max or transferOnly, controlling who hands out which role with assigns and for, checking a membership change with decideRoleChange, letting tenant admins define custom roles with customRoles and validateCustomRole, or fixing doctor PD023, PD025 or PD026 and denials such as tenant-mismatch, last-holder or not-assignable-by.
license: MIT
metadata:
  author: ScaleDockHQ
  homepage: https://permdock.com/docs/concepts/scopes
  repository: https://github.com/ScaleDockHQ/permdock
---

# PermDock tenancy

A policy declares its scopes in order (an organization, the customers inside it). A role is held at one scope, a membership names one instance of that scope, and a grant reaches a row only through that scope's key. Roles never cascade between scopes ([named scopes](https://permdock.com/docs/concepts/scopes), [tenancy](https://permdock.com/docs/concepts/tenancy)). Set up the policy and factory first with the `permdock-wire` skill (`npx skills add ScaleDockHQ/PermDock --skill permdock-wire`).

## Inputs (find out, or ask before starting)

- The tenant levels, outermost first, and the row column that holds each id (`organization_id`, `customer_id`).
- Where memberships are stored and how the app loads them: token claims from a `subjectFrom*` provider, or the app's tables.
- The membership kinds (`via`): staff, contact, guest, partner, support.
- Which role manages each scope, who may hand out which role, and which roles a contact or guest may never hold.
- Whether tenant admins define their own roles.

## Invariants

1. Memberships and custom roles come only from a `subjectFrom*` provider, the policy's `subject` or `context` function, a `MembershipSource` or a `RoleSource`. Never from a request body, an unsigned header, a model argument or a CLI flag.
2. A requested tenant with no matching membership is no tenant, never a default one. Team and tenant ids are identifiers, never display names.
3. No cascade. An organization owner sees no customer portal unless they also hold a contact membership, and a global role never reaches scoped rows.
4. Role rules live on the role (`min`, `assigns`, `for`), not in handlers. `decideRoleChange` takes the actor from the instance and never writes.
5. A custom role never exceeds the ceiling of declared `assignable` roles in its scope. Its grants carry no condition, approval or limit of their own.

## Workflow

1. **Declare the scopes.** Add them to `definePolicy` in order, each with its row `key` and, after the first, `within`:

   ```ts
   definePolicy(
     { permissions, roles },
     {
       scopes: {
         organization: { key: "organization_id" },
         customer: { key: "customer_id", within: "organization" },
       },
       roles: [
         role(roles.admin, adminGrants, { on: "organization" }),
         role(roles.contact, contactGrants, { on: "customer" }),
       ],
       subject,
     },
   );
   ```

   ✓ `definePolicy` accepts the scopes, and each role names one scope with `on`.

2. **Give resources their scope keys.** Every resource a scoped grant touches declares a `memberOf` relation per scope key it carries, for example `relations: { organization: { field: 'organization_id', memberOf: 'organization' } }`.
   ✓ `definePolicy` does not throw for a missing `memberOf` relation.
3. **Load memberships.** Return memberships as `{ scope, id, within, roles, via, expiresAt }` from the subject resolver, or pass a `MembershipSource` (one, or an array) as `memberships` on `createPermDock`. A person's access ending is the membership's `expiresAt`.
   ✓ `permdock doctor` reports no PD025 for the `doctor.memberships` fixture.
4. **Put ownership on the roles.** Set `min: 1` on the role that manages each scope, `assigns` for who hands out what, `for: ['staff']` on admin-like roles, and `meta.audience` for the surface. Every server action that changes a membership calls `permdock.decideRoleChange(...)` with the target's current membership and the holder count before it writes. -> [references/ownership-and-custom-roles.md](references/ownership-and-custom-roles.md)
   ✓ PD026 is clean, and removing the last owner is denied with `last-holder`.
5. **Custom roles, when tenant admins define roles.** Keep declared roles small and mark them in `defineRoles` (`editor: { on: 'organization', assignable: true }`). Pass a `RoleSource` as `customRoles`, build the editor from `useAssignablePermissions()`, and save through a server action that runs `validateCustomRole`. -> [references/ownership-and-custom-roles.md](references/ownership-and-custom-roles.md#custom-roles)
   ✓ PD023 is clean, and saving a role with a permission outside the ceiling is refused.
6. **Test.** Add `describePolicy` rows for a member of another tenant, a contact reaching an organization row, and a role change that breaks `min` ([scenario testing](https://permdock.com/docs/guides/scenario-testing)). Run `testMembershipSource` and `testRoleSource` from `permdock/testing` on custom sources. For list queries and RLS over scoped tables, follow the `permdock-data` skill.
   ✓ The tests pass.

## Verify before done

- [ ] No membership, tenant or role is read from a request body, tool argument, unsigned header or `user_metadata`.
- [ ] Each scope's managing role sets `min: 1` (PD026), and admin-like roles set `for` so contact, guest or partner memberships cannot hold them.
- [ ] No `assigns` list lets a role appoint a role ranked above it.
- [ ] Every server action that writes a membership role calls `decideRoleChange` with a `holders` count from the store, never a guess.
- [ ] Every custom-role save runs `validateCustomRole` and checks `assignablePermissions()`. No single assignable `admin` role makes the ceiling the whole product.
- [ ] Custom `MembershipSource` and `RoleSource` implementations pass `testMembershipSource` / `testRoleSource`.

## Reference index

- [references/ownership-and-custom-roles.md](references/ownership-and-custom-roles.md): role options, `decideRoleChange` input and denial reasons, the SQL objects RLS uses, and the custom-role shape, ceiling and editor.
- Docs: [named scopes](https://permdock.com/docs/concepts/scopes), [tenancy](https://permdock.com/docs/concepts/tenancy), [ownership](https://permdock.com/docs/concepts/ownership), [custom roles](https://permdock.com/docs/concepts/custom-roles), [extension interfaces](https://permdock.com/docs/concepts/extension-interfaces).
