---
name: wire-permdock
description: Add PermDock authorization to a TypeScript app. Use when installing permdock, adding permissions, roles, RBAC, or access control, or when guarding a route, Server Action, tool, MCP handler, or React component. Use whenever the user asks for definePermissions, definePolicy, or createPermDock.
---

# Wire PermDock

Three files and one guard. Import paths and identifiers follow the [naming convention](https://permdock.dev/docs/getting-started/naming). Adapter factory shapes live in [adapters.md](adapters.md).

Permissions are **references** (`permissions.post.update`). Roles and plans are typed leaves too (`roles.owner`, `plans.pro`). Outcomes are `granted`, `denied`, or `approval-required`. The subject comes from a trusted resolver (`subjectFrom*` or your session). Client entries load snapshots and hooks only.

## 1. Detect

Find the framework (Next.js, Vite + React, Hono, Nuxt, Astro, React Router, TanStack Start, MCP, AuthZEN PDP, AI SDK, Claude Agent SDK, Eve, OpenAI Agents SDK, Effect) and the Standard Schema validator already in the repo (Zod, Valibot, ArkType, Effect Schema). Nuxt, Astro, React Router, TanStack Start and Effect use `permdock/unplugin` for collect only; do not add a per-vendor package.

Done when the adapter import path (`permdock/<framework>`) and the validator import are named.

## 2. Define

Create `src/permissions.ts`. Importable everywhere. No rules, no secrets.

```ts
import {
  definePermissions,
  defineRoles,
  definePlans,
  resource,
  crud,
} from 'permdock';
import { Post } from './schemas';

export const permissions = definePermissions({
  post: resource(
    Post,
    crud({
      relations: { author: 'authorId' },
    }),
  ),
});
export const roles = defineRoles({
  member: {},
  admin: {},
});
export const plans = definePlans({ pro: {} });
```

Done when every resource the first guard needs has a leaf, and instance actions sit in `actions` while list/create sit in `collection`.

## 3. Policy

Create `src/policy.ts`. Server-only. Prefer `grants` with `to:` selectors (`anyone()`, `authenticated()`, `relation()`, a `Role` or `Plan` leaf, `actor()`, `assurance()`). `role(roles.member, …)` sugar still works. Portable `where` first; closures only when a portable operator cannot express the rule. Destructive agent-reachable actions take `approval: { by }` (or `'human'`). The requester can never approve their own request; add `distinct: false` only when the user confirming their own agent's call is the intent (PD024 warns). A `limit: { count, per }` grant needs `limits: memoryLimitStore()` (or your store) on `createPermDock`; `can` never consumes.

```ts
import { definePolicy, role, allow, principal, relation } from 'permdock';
import { permissions, roles } from './permissions';

const member = role(roles.member, [
  allow(permissions.post.read),
  allow(permissions.post.list),
  allow(permissions.post.create),
  allow(permissions.post.update, { to: relation(permissions.post, 'author') }),
  allow(permissions.post.delete, {
    where: { authorId: principal.id },
    approval: 'human',
  }),
]);

export const policy = definePolicy(
  { permissions, roles },
  {
    roles: [member],
    principal: (user) => user && { id: user.id, roles: user.roles },
  },
);
```

Workflow verbs on money or filing resources (`prepare`, `approve`, `pay`, `settle`, `submit`) are separate leaves. Put `approval: { by }` on `approve` / `pay` (PD017 warns when those actions have neither approval nor a matching deny). Use `exclusiveWith` on `role()` so a preparer cannot also be the approver (PD018). Hardware-key step-up is `assurance({ amr: ['hwk'], maxAge: 300 })` and renders `/step-up-required`.

When the product nests tenants (organizations and their customers, workspaces inside an organization), declare them in order: `definePolicy({ scopes: { organization: { key: 'organization_id' }, customer: { key: 'customer_id', within: 'organization' } } })`, put each role on one scope (`role(roles.contact, [...], { on: 'customer' })`), and give every resource a scoped grant touches a `memberOf` relation per scope key it carries. Memberships are `{ scope, id, within: { organization: id }, roles }`; a role never cascades between scopes, so a staff owner sees no customer portal unless they are also a contact ([named scopes](https://permdock.dev/docs/concepts/scopes)).

Put the ownership rules on the roles instead of in handlers: `min: 1` on the role that manages a scope (PD026 warns when no role sets `min`), `assigns: ['member', 'viewer']` for who hands out what, `for: ['staff']` so a contact or guest membership never holds an admin role (memberships then need `via`), and `meta: { audience: 'portal' }` for `permdock.audiences()`. A server action that changes a membership calls `permdock.decideRoleChange({ kind, role, scope, id, target, holders })` with the target's current membership and the holder count from the app's store before writing; map `rls.memberships.scopes.<scope>.via` so generated RLS applies `for`, and use `permdock_can_assign(role, organization_id::text)` in the membership table's own insert policy ([ownership](https://permdock.dev/docs/concepts/ownership)).

When tenant admins define their own roles, keep declared roles small and `assignable`: they are the ceiling a custom role can never exceed. Pass a `RoleSource` as `customRoles`; a `CustomRole` lists `includes` (declared roles) and `grants` (`{ permission, effect? }`, no conditions). Build the editor from `useAssignablePermissions()` and save through a server action that runs `validateCustomRole(policy, role)` and compares it with `permdock.assignablePermissions()` ([custom roles](https://permdock.dev/docs/concepts/custom-roles)).

When the product has share links (guest quote pages, file or thread links, pre-boarding forms), declare the link's roles on the resource (`role('guest', [allow(permissions.quote.read, { where: { status: 'sent' } })], { on: permissions.quote })`), mint links with `signCapability({ id, on: { resource: permissions.quote, id }, roles: ['guest'], expiresAt }, signer, { audience })` behind a guard of its own (`quote.share`), and resolve them with `subjectFromCapability(token, { jwks, issuer, audience, revoked, replay, viewer, linkPolicy })` from `permdock/jwt`; `linkPolicy` returns the tenant's `LinkPolicy` (`maxLifetime`, `redeemers`, `once`). Never an unguessable id without expiry, and never a security-definer RPC for the guest page: with Supabase, `exchangeCapability(subject, { key, alg, kid })` from `permdock/supabase` plus `permdock rls generate --capabilities` lets RLS serve the link ([link capabilities](https://permdock.dev/docs/concepts/capabilities)).

Done when at least one role grants the first guard's permission, and `policy.ts` is not imported from a client entry.

## 4. Factory

Create `src/permdock/server.ts` (or the adapter's documented factory file). Export `createPermDock` from `permdock/<framework>`. Copy the exact return names from [adapters.md](adapters.md). For Nuxt, Astro, React Router, TanStack Start or Effect there is no `permdock/<framework>`: add `createPermDockUnplugin.vite()` (or the matching bundler adapter) from `permdock/unplugin`, then `permdock/server` (or the HTTP adapter that matches the listener) plus `permdock/vue` / `permdock/react` / `permdock/svelte` on the client.

When the app already verifies OAuth or OIDC access tokens, resolve the subject with `subjectFromJwt` from `permdock/jwt`: `discovery: '<issuer>'`, `audience` set to the resource identifier, algorithms written as `Ed25519` / `ES256` / `PS256`. A claimed `act` that does not nest is anonymous with cause `invalid-chain`. When the app already called RFC 7662 or RFC 9767 introspection, pass the JSON to `subjectFromIntrospection`; `active` other than `true` is anonymous and the HTTP call stays yours. HTTP adapters accept `webBotAuth: { verify: true, keys: discoverViaSignatureAgent({ allow: ['agents.example.com'] }) }` to fill `actor` from RFC 9421; a failed signature is `InvalidSignatureError`, never an anonymous actor.

Done when the factory file compiles and exports the adapter's public members.

## 5. Guard

Add one check on the path the user asked for:

- HTTP / Next: `assert` or `protect` / `getPermission` with a permission reference
- React: `<Protected permission={permissions.post.update}>` inside `PermDockProvider`
- Agent: map the tool name in `tools` and pass `toolApproval` / `canUseTool` / `needsApproval` / `approval`

Done when that path cannot run without a `granted` decision, and a deny or approval-required outcome is handled by the adapter (Problem Details, fallback UI, or the runtime's approval hook).

## 6. Check

Run `permdock collect`, `permdock catalog`, `permdock usage`, `permdock doctor` and `permdock skills install` (the binary ships in the `permdock` package). Add `permdock collect --check` to CI. For a Vite SPA, an Expo app or another framework without `'use client'`, set `doctor.clientEntries` to the client source globs so PD001 checks them. When the app already has an OpenAPI document and no definitions yet, start from `permdock openapi import --doc <doc> --out src/permissions.generated.ts --schema zod` and review each action's `meta.inferredFrom`. When the repo has Arazzo workflows, also run `permdock arazzo check --doc <arazzo> --openapi <doc>`. When the app uses PermDock Cloud, add `permdock cloud push` to the deploy step after the deploy, with `PERMDOCK_CLOUD_URL` and `PERMDOCK_CLOUD_KEY` from CI secrets. Read current adapter pages through the public docs MCP (`https://permdock.dev/mcp`, tools `search_docs` and `get_page`) instead of guessing identifiers.

If the CLI is not installed, typecheck the three files and add a policy-matrix test with `permdock/testing`.

With `permdock/testing`, add `describePolicy` over the policy. When the app lists rows through an ORM or RLS, add `ormParity` or `rlsParity` so the query returns what `filter()` keeps. Run the matching `test<Interface>` runner (`testApprovalStore`, `testMembershipSource`, `testLimitStore`, …) on every custom store or source ([scenario testing](https://permdock.dev/docs/guides/scenario-testing)).

Done when collect/doctor findings are fixed, or the typecheck and one matrix test pass.
