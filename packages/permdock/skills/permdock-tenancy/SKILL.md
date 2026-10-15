---
name: permdock-tenancy
description: Models tenants, memberships, contacts and support sessions in PermDock. Use when declaring named scopes (organizations, workspaces, customers inside an organization), loading memberships through a MembershipSource, putting a role on one scope, keeping an owner per organization with min, max or transferOnly, controlling who hands out which role with assigns and for, checking a membership change with decideRoleChange, letting tenant admins define custom roles with customRoles and validateCustomRole, giving external customer contacts portal access as kind contact principals found through a PrincipalSource and principalByIdentity, letting support staff view the app as a customer with decideSupportSession, signSupportSession and subjectFromSupportSession, or fixing doctor PD023, PD025 or PD026 and denials such as tenant-mismatch, last-holder, not-assignable-by or reason-required.
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
- Whether external people (customer contacts, portal users) are accounts in the auth provider or rows in the app's own contacts table, and whether email delivery or a chat bot must reach them.
- Whether support staff view the app as a customer, who approves that, and where the app records a session ending early.

## Invariants

1. Memberships and custom roles come only from a `subjectFrom*` provider, the policy's `subject` or `context` function, a `MembershipSource` or a `CustomRoleSource`. Never from a request body, an unsigned header, a model argument or a CLI flag.
2. A requested tenant with no matching membership is no tenant, never a default one. Team and tenant ids are identifiers, never display names.
3. No cascade. An organization owner sees no customer portal unless they also hold a contact membership, and a global role never reaches scoped rows. An instance check without a row answers from first-scope memberships only; a nested membership needs the row or `permdock.team(id)`. A collection check (`create`, `list`) still answers from any membership in the tenant; for a staff-only guard pass `{ scope: '<first scope>' }` as the decide option.
4. Role rules live on the role (`min`, `assigns`, `for`), not in handlers. `decideRoleChange` takes the actor from the instance and never writes.
5. A custom role never exceeds the ceiling of declared `assignable` roles in its scope. Its grants carry no condition, approval or limit of their own; a `level` picks a condition the resource declares in code.
6. A `kind: 'contact'` principal keeps only its `{ on }` resource memberships and is read-only unless a role's `for` lists `'contact'`; a scope role such as the `customer`-scope `contact` role below never reaches it. It never approves or creates keys. An email address or chat author with no identity link the app wrote is no principal, never a guest.
7. A support session keeps the customer as principal and the staff member as a `support` actor, needs a reason and, by default, an approval by someone else, and is checked live on every request. A support actor never approves.

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

   An organisation role that reaches only the principal's teams is an organisation role with `where: { team_id: { in: principal.claims.team_ids } }`, not a team role. On Supabase, write the claim with `supabase.hook.claims` ([team reach](https://permdock.com/docs/concepts/tenancy#organisation-roles-with-team-reach)).

4. **Put ownership on the roles.** Set `min: 1` on the role that manages each scope, `assigns` for who hands out what, `for: ['staff']` on admin-like roles, and `meta.audience` for the surface. Every server action that changes a membership calls `decideRoleChange(permdock, ...)` with the target's current membership and the holder count before it writes. -> [references/ownership-and-custom-roles.md](references/ownership-and-custom-roles.md)
   ✓ PD026 is clean, and removing the last owner is denied with `last-holder`.
5. **Custom roles, when tenant admins define roles.** Keep declared roles small and mark them in `defineRoles` (`editor: { on: 'organization', assignable: true }`). Pass a `CustomRoleSource` as `customRoles`, build the editor from `useAssignablePermissions()`, and save through a server action that runs `validateCustomRole`. -> [references/ownership-and-custom-roles.md](references/ownership-and-custom-roles.md#custom-roles)
   ✓ PD023 is clean, and saving a role with a permission outside the ceiling is refused.
6. **Contact principals, when external people sign in or receive messages.** Pick the model: a signed-in user with a `via: 'contact'` membership on the `customer` scope, or a `kind: 'contact'` principal with `{ on: { resource, id }, roles }` memberships on the rows it is a party to. Give a contact a write only through a resource role with `for: ['contact']`. Pass a `PrincipalSource` as `principals` (`memoryPrincipalSource({ principals, identities })` in tests, `principalSource` from `permdock/better-supabase` there) and implement `principalByIdentity` over identity links the app writes after a signed-in link flow or a verified address, so [delivery](https://permdock.com/docs/concepts/delivery) and [chat](https://permdock.com/docs/concepts/chat) reach the contact ([contact principals](https://permdock.com/docs/concepts/subject#contact-principals)). -> [references/contacts-and-support-sessions.md](references/contacts-and-support-sessions.md)
   ✓ A contact's write without a `for: ['contact']` role denies with `not-delegated`, and an unlinked address resolves to `null`.
7. **Support sessions, when staff view the app as a customer.** Start each session with `decideSupportSession(staff, { id, principal, reason })`, record an approval by someone else and decide again with `{ approved: token, approvedBy }`. Sign the granted record with `signSupportSession(session, signer)` and resolve each request with `subjectFromSupportSession(token, { verifier, principals, permissions, sessions })` from `permdock/server`, where `sessions` is a `SupportSessionSource` that ends a session early. Send `supportSessionEvent` to the sink on start and end. On better-supabase, pass `supportPolicy` as the `authorize` option of `supportSessions` ([support sessions](https://permdock.com/docs/concepts/support-sessions)). -> [references/contacts-and-support-sessions.md](references/contacts-and-support-sessions.md#support-sessions)
   ✓ An empty reason denies with `reason-required`, and a token for a session the source reports `ended` resolves to the anonymous subject.
8. **Test.** Add `describePolicy` rows for a member of another tenant, a contact reaching an organization row, a contact principal writing without an opt-in role, and a role change that breaks `min` ([scenario testing](https://permdock.com/docs/guides/scenario-testing)). Run `testMembershipSource`, `testCustomRoleSource`, `testPrincipalSource` and `testSupportSessionSource` from `permdock/testing` on custom sources. For list queries and RLS over scoped tables, follow the `permdock-data` skill.
   ✓ The tests pass.

## Verify before done

- [ ] No membership, tenant or role is read from a request body, tool argument, unsigned header or `user_metadata`.
- [ ] Each scope's managing role sets `min: 1` (PD026), and admin-like roles set `for` so contact, guest or partner memberships cannot hold them.
- [ ] No `assigns` list lets a role appoint a role ranked above it.
- [ ] Every server action that writes a membership role calls `decideRoleChange` with a `holders` count from the store, never a guess.
- [ ] Every custom-role save runs `validateCustomRole` and checks `assignablePermissions()`. No single assignable `admin` role makes the ceiling the whole product.
- [ ] Custom `MembershipSource`, `CustomRoleSource`, `PrincipalSource` and `SupportSessionSource` implementations pass `testMembershipSource` / `testCustomRoleSource` / `testPrincipalSource` / `testSupportSessionSource`.
- [ ] A `kind: 'contact'` principal gets portal access only through `{ on }` memberships, and every write it may make comes from a role whose `for` lists `'contact'`. When contacts query the database directly, their memberships are kept out of the tables the RLS functions read, or writes are gated in the application.
- [ ] `principalByIdentity` reads only identity links the app wrote after a signed-in link flow or a verified address. No code creates a principal, a guest or a default role for an unlinked address or chat author.
- [ ] Every support session goes through `decideSupportSession` with a reason, and approval stays on unless the app approves elsewhere; `approvedBy` is never the staff member.
- [ ] Session requests resolve with `subjectFromSupportSession` and a `SupportSessionSource`, never by signing in as the customer, and `supportSessionEvent` is sent on start and end.

## Reference index

- [references/ownership-and-custom-roles.md](references/ownership-and-custom-roles.md): role options, `decideRoleChange` input and denial reasons, the SQL objects RLS uses, and the custom-role shape, ceiling and editor.
- [references/contacts-and-support-sessions.md](references/contacts-and-support-sessions.md): the two contact models, contact principal rules, `PrincipalSource` and identity links for delivery and chat, the support-session start, token, live check and events, `supportPolicy`, and how support sessions differ from `supportAccess`.
- Docs: [named scopes](https://permdock.com/docs/concepts/scopes), [tenancy](https://permdock.com/docs/concepts/tenancy), [ownership](https://permdock.com/docs/concepts/ownership), [custom roles](https://permdock.com/docs/concepts/custom-roles), [contact principals](https://permdock.com/docs/concepts/subject#contact-principals), [support sessions](https://permdock.com/docs/concepts/support-sessions), [elevated access](https://permdock.com/docs/concepts/elevated-access), [extension interfaces](https://permdock.com/docs/concepts/extension-interfaces).
