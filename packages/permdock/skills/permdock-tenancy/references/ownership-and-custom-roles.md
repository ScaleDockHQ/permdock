# Ownership and custom roles

Owning pages: [ownership](https://permdock.com/docs/concepts/ownership) and [custom roles](https://permdock.com/docs/concepts/custom-roles).

## Role options

```ts
const staff = { for: ["staff"], meta: { audience: "staff" } } as const;

roles: [
  role(roles.owner, ownerGrants, {
    on: "organization",
    ...staff,
    min: 1,
    assigns: ["owner", "admin", "member", "viewer", "contact"],
  }),
  role(roles.admin, adminGrants, {
    on: "organization",
    ...staff,
    assigns: ["member", "viewer", "contact"],
  }),
  role(roles.contact, contactGrants, {
    on: "customer",
    for: ["contact"],
    meta: { audience: "portal" },
  }),
];
```

| Option          | Meaning                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `min`           | Fewest holders each scope instance keeps (default `0`). Removing the last owner is refused.                                              |
| `max`           | Most holders an instance may have.                                                                                                       |
| `transferOnly`  | Once an instance has holders, the role only moves from one holder to another.                                                            |
| `assigns`       | Roles a holder may assign and revoke. Once any role declares `assigns`, this graph replaces the held-grant rule for `assignableRoles()`. |
| `for`           | Membership kinds (`Membership.via`) that may hold the role. A membership with another `via`, or none, grants nothing through it.         |
| `exclusiveWith` | Roles nobody may hold together with this one in the same instance (PD018).                                                               |
| `meta.audience` | The surface the role's holders use; `permdock.audiences()` and `snapshot.audiences` report it and never grant.                           |

`min`, `max` and `transferOnly` need a named-scope `on`.

## Checking a role change

```ts
const result = permdock.decideRoleChange({
  kind: "assign", // 'assign' | 'revoke' | 'transfer'
  role: roles.admin,
  scope: "organization",
  id: "o_acme",
  target: { id: "u_bob", via: "staff", roles: ["member"] }, // their membership there now
  holders: await countHolders(memberships, {
    scope: "organization",
    id,
    role: "owner",
  }), // from MembershipSource.list
});
// { outcome: 'granted', change, role } or { outcome: 'denied', change, denials }
```

The actor is the instance's own subject; nothing in the change stands in for it. `decideRoleChange` never writes. Without a valid `holders` count, a role with `min`, `max` or `transferOnly` is denied. Denial reasons: `last-holder`, `max-holders`, `transfer-only`, `not-assignable-by`, `self-demotion`, `not-allowed-for-membership`, `conflicting-role`.

For a role on a nested scope that the subject holds nothing at, pass `within` and `{ trusted: true }` only after loading the ancestors from the app's own store.

Generated RLS applies the same rules at commit, with triggers on the scope's `rls.memberships` table or on the tables of its `fromTable` / `fromJunction` sources (base tables, not views). Map `rls.memberships.scopes.<scope>.via` so the helpers apply `for`, and use `permdock_can_assign(role, organization_id::text)` in the membership table's own insert policy, or `permdock_can_assign_any(role, organization_id, 'organization', organization_id::text)` when the role may be a custom one. The SQL is owned by the `permdock-data` skill.

## Custom roles

```ts
type CustomRole = {
  tenant: string; // absent when scope is 'global'
  scope?: string; // default: the first scope; 'global' for a platform role
  id?: string; // pins it to one instance
  name: string;
  includes?: string[]; // declared roles to start from
  grants?: { permission: string; effect?: "allow" | "deny"; level?: string }[];
};
```

- The ceiling of a scope is the code allows of the declared roles marked `assignable` in that scope. A custom role never exceeds it, and hosted grants never widen it.
- An own allow inherits the conditions of the ceiling grants for that permission. To keep a narrower condition ("own posts only"), include the declared role that has it.
- A resource may declare `levels: { own: { ownerId: principal.id }, team: { teamId: { in: principal.teamIds } }, all: {} }`. A grant `{ permission: 'job.read', level: 'team' }` ANDs that condition into the ceiling grant. An undeclared level, or a level on a collection action, is dropped as `unknown-level` and removes the permission; a level on a deny is `condition-not-allowed`. `permdock.assignableLevels(leaf)` lists the levels the subject may hand out.
- An own deny removes the permission from this custom role only. Deny it in code when it must win across roles.
- Pass a `RoleSource` (`memoryRoleSource(roles)` in tests), or a `RoleSourceFactory` `(subject) => RoleSource` when the source reads one principal's roles, as `customRoles` on `createPermDock` or any adapter. To add every role of a tenant on a role-management request, `await permdock.derive({ customRoles })` instead of building a second instance. Build it with `customRoleSource({ rolesOf })`, where `rolesOf(tenant)` reads every custom role of the tenant, not only the held ones: `assignableRoles` and `decideRoleChange` see only what the source returns. `{ read: 'held', policy }` skips the read on requests that never manage roles. Check it with `testRoleSource(source, { every })`.
- `permdock.assignableRoles({ tenant })` lists declared roles, then the tenant's custom roles whose every permission and level the subject may hand out at the custom role's scope. `decideRoleChange` assigns and revokes a custom role like a declared one, with no holder count; it inherits `for` and `exclusiveWith` from its included roles.
- `permdock.assignablePermissions({ tenant })` is the ceiling intersected with what the subject holds. `useAssignablePermissions()` in `permdock/react` builds the editor from it.
- The save action runs `validateCustomRole(policy, role)` and refuses the role when `ok` is false or `permissions` contains a key outside `assignablePermissions()`. `dropped` names each entry left out (`unknown-permission`, `outside-ceiling`, `condition-not-allowed`, `unknown-level`, `unknown-role`).
- A platform custom role (`scope: 'global'`, no `tenant`, `team` or `id`) is held through `principal.roles` and capped by the allows of declared global roles marked `assignable`. `RoleSource.globalRoles({ held })` returns them; `customRoleSource(reader, { read: 'held', policy })` skips that read while every held global role is declared.
- A stored grant under a key renamed with `definePermissions(..., { renamed })` still resolves; `validateCustomRole` lists it in `renamed` as `{ from, to }`, and `permdock doctor` PD055 prints the `update` that rewrites it.
- For generated RLS, add `--custom-roles` (or `rls.customRoles: true`) to `permdock rls generate`. Platform roles are rows with `scope = 'global'` and a null `tenant_id`, or the top-level `role_grants` claim in `jwt` mode. With levels, `custom_role_permissions` gains a `level` column and the claim writes `key@level`.
