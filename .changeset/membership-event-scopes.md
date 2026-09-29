---
'permdock': minor
---

`membership` sink events name the scope instance the way memberships do (breaking). `MembershipEvent` drops `tenant` and `team` for `scope`, `id` and `within`, and gains `expiresAt`, so a role change at any depth (a contact on a site inside a customer inside an organization) is recorded. `membershipEvent()` takes the same fields and throws a `TypeError` when `scope` and `id` are not given together, or `within` has no `scope`. SCIM group changes emit `{ scope: 'tenant', id }`, and Better Auth `onRoleChange({ sink })` emits `{ scope: 'team', id, within: { tenant } }` for a team role. The format stays `v1`.
