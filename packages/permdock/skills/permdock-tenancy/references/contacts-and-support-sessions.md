# Contact principals and support sessions

Owning pages: [contact principals](https://permdock.com/docs/concepts/subject#contact-principals), [support sessions](https://permdock.com/docs/concepts/support-sessions), [extension interfaces](https://permdock.com/docs/concepts/extension-interfaces#principalsource).

## Two kinds of contact

| Who                                                         | Principal         | Membership                                                              | Reaches                                                             |
| ----------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| A signed-in app user holding a portal role on a scope       | `kind: 'user'`    | `{ scope: 'customer', id, within, roles: ['contact'], via: 'contact' }` | What the `customer`-scope role grants                               |
| An external person the app stores in its own contacts table | `kind: 'contact'` | `{ on: { resource, id }, roles }`                                       | Only the rows those resource memberships name, read-only by default |

A `kind: 'contact'` principal keeps only its `{ on }` memberships, each rewritten to `via: 'contact'`. Its scope memberships, global `roles`, `plans`, membership `entitlements` and `tenant` are dropped, so `permdock.tenants()` is empty and a `customer`-scope role never applies to it. Model a customer contact this way when they are not an account in the app's auth provider, or when they must never see more than the rows they are a party to.

## Contact principal rules

- Only `{ on }` memberships count. Grant portal access with a role on a resource and a membership on one row of it.
- An allow reaches a contact only when the permission is read-only (`meta.readOnly`, or the `read` and `list` actions), or the role's `for` lists `'contact'`. Every other allow denies with `not-delegated`. Top-level grants and relation grants never open a write to a contact.
- A contact never approves, reviews access or accepts an approval delegation: `assertApprover` throws `approver-not-eligible`.
- A contact never creates a key: `decideCredential` denies with `exceeds-creator` and `detail.creator: 'contact'`.
- A contact never publishes a policy, a catalog or a hosted document.
- The narrowing applies to `can()`, `where()`, `snapshot()` and `decideFor()`. Generated RLS does not know the principal kind: when contacts query the database directly, keep their memberships out of the tables the RLS functions read, or gate writes in the application.

```ts
role("payer", [allow(permissions.invoice.pay)], {
  on: permissions.invoice,
  for: ["contact"], // the only way a contact gets a write
});

const contact: Principal = {
  id: "c_42",
  kind: "contact",
  memberships: [{ on: { resource: "invoice", id: "inv_1" }, roles: ["payer"] }],
};
```

## Reaching a contact

A contact is loaded through the `PrincipalSource` passed as `principals`. It is the one identity lookup for `decideFor`, delivery and chat:

```ts
type PrincipalSource = {
  principal(
    id: string,
    options?: { tenant?: string },
  ): Principal | null | Promise<Principal | null>;
  principalByIdentity?(identity: {
    kind: "email" | "chat";
    provider?: string; // the chat platform; absent for email
    value: string; // the address or the platform user id
    workspace?: string;
  }): Principal | null | Promise<Principal | null>;
};
```

- `null`, a throw, a rejection or a missing `principalByIdentity` is no principal. Emails compare trimmed and case-insensitively.
- An identity link is app data: one row per `kind`, `provider`, `value` and `workspace`, written when a signed-in person connects a chat account or verifies an address. Never create a link from an inbound message.
- `permdock.decideFor(principalId, permission, row)` decides for a contact in the caller's tenant even though the contact holds no tenant membership.
- [Delivery](https://permdock.com/docs/concepts/delivery): a `{ principal, channel, address }` recipient is decided with `decideFor`; a `{ channel, address }` recipient resolves through `principalByIdentity`, and an address with no link fails with `unlinked`.
- [Chat](https://permdock.com/docs/concepts/chat): `subjectFromChat(author, { principals })` resolves the author through `principalByIdentity({ kind: 'chat', provider, value, workspace })`. An unlinked author is the anonymous subject, so every check denies with `anonymous`.
- An unlinked address or chat author is never a guest. Do not invent a fallback contact or a default portal role for it.

Sources:

- `memoryPrincipalSource({ principals, identities })` from `permdock` holds principals and links (`{ identity, principal: '<id>' }`) in process, for tests and single-replica apps.
- On better-supabase, `principalSource({ claims, identities?, subject? })` from `permdock/better-supabase` loads users from the claims better-supabase mints. `identities(identity)` returns `{ user: id }` or `{ contact: principal }`; a contact link is accepted only for `kind: 'contact'` ([better-supabase principals](https://permdock.com/docs/adapters/better-supabase#principals)).
- Run `testPrincipalSource(source, { principals, identities })` from `permdock/testing` on a custom source.

## Support sessions

A support session lets a staff member view the app as one person, inside that person's tenant, for a stated reason and a bounded time. The person stays the principal and the staff member is an actor with `kind: 'support'`.

### Start

```ts
const decision = await staff.decideSupportSession(
  {
    id: crypto.randomUUID(),
    principal: "u_customer",
    reason: "Ticket 4411: invoice totals look wrong",
    // tenant?: defaults to the staff member's active tenant
    // permissions?: defaults to every readOnlyHint permission the staff member can use
    // expiresIn?: seconds, default 3600, at most 86400
    // reference?: the app's ticket id
  },
  { settings, approved, approvedBy }, // approval: false only when the app approves elsewhere
);
// { outcome: 'granted', session } | { outcome: 'approval-required', session, token } | { outcome: 'denied', denials }
```

- The staff member must be a `user` acting for themselves (no credential, run ticket or actor), with `exceeds-creator` otherwise. They must be a member of the tenant (`tenant-mismatch`) and able to use every listed permission (`exceeds-creator`).
- An empty reason denies with `reason-required`.
- Approval is on by default. Store the request, let an approver who is not the staff member accept, then decide again with `{ approved: token, approvedBy }`. `approvedBy` equal to the staff member denies.
- The tenant's `supportSessions` setting from a `SettingsSource` only tightens: `disabled` refuses every session, `maxTtl` caps `expiresIn`, `readOnly` refuses a write permission with `not-delegated`.

### Use

- `signSupportSession(session, signer)` from `permdock/server` signs a granted record as a `vnd.permdock.support-session+jwt` (`sub` the viewed principal, `act` the staff member, `jti` the session id) that expires with the session.
- `subjectFromSupportSession(token, { verifier, principals, permissions, sessions? })` resolves it on every request: the viewed principal and the staff member are loaded live through `principals`, the actor is `{ id, kind: 'support' }`, the session's permissions become the `delegation`, and `subject.context.supportSession` carries the id, reason, `approvedBy` and `reference` for audit. Every failure is the anonymous subject, reported through `onAuth` with a cause such as `expired`, `session-ended`, `principal-unavailable` or `actor-unavailable`.
- A `SupportSessionSource` (`session(id)` returning `{ id, ended? }` or `null`) passed as `sessions` lets the app end a session before it expires. An unknown id, `ended: true` or a throw is `session-ended`. Check it with `testSupportSessionSource(source, { sessions })` from `permdock/testing`.
- A support actor never approves: `assertApprover` throws `approver-not-eligible`.
- A policy delegation to `actor('support')` narrows what any session reaches.

### Events

`supportSessionEvent({ operation, session })` builds an `access` event with `via: 'support-session'`, the session id and the permissions. Sinks send it as `com.permdock.support-session.started` or `com.permdock.support-session.ended`; a session ended early (`revoked`) goes out as `.ended` and keeps the difference in `data.operation`.

### better-supabase

`supportPolicy({ policy, subject?, options?, writable?, approval?, approved? })` from `permdock/better-supabase` is the `authorize` option of better-supabase's `supportSessions`. It decides each start with `decideSupportSession` as the admin; a `readOnly: false` start needs `writable`, and an `approval-required` start passes once `approved(input, pending)` returns `{ approvedBy }` for `pending.token` ([better-supabase support sessions](https://permdock.com/docs/adapters/better-supabase#support-sessions)).

### Support sessions and supportAccess

`supportAccess` ([elevated access](https://permdock.com/docs/concepts/elevated-access#support-access-with-tenant-consent)) is the other model: the vendor is the principal and holds a consented, time-bound `{ via: 'support' }` membership that a tenant owner grants through an `ApprovalRequest`. Use it for a vendor team working inside a tenant. Use a support session to see what one person sees.

| Model           | Principal               | Actor                         | Granted by                              |
| --------------- | ----------------------- | ----------------------------- | --------------------------------------- |
| Support session | The viewed person       | Staff, `kind: 'support'`      | `decideSupportSession` plus an approval |
| `supportAccess` | The vendor staff member | Required with `actorRequired` | Tenant owner consent                    |

Both share the `com.permdock.support-session.*` event family. A support-session actor satisfies `actorRequired`, which accepts any actor.
