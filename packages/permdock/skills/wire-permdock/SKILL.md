---
name: wire-permdock
description: Add PermDock authorization to a TypeScript app. Use when installing permdock, adding permissions, roles, RBAC, or access control, or when guarding a route, Server Action, tool, MCP handler, or React component. Use whenever the user asks for definePermissions, definePolicy, or createPermDock.
---

# Wire PermDock

Three files and one guard. Import paths and identifiers follow the [naming convention](https://permdock.dev/docs/getting-started/naming). Adapter factory shapes live in [adapters.md](adapters.md).

Permissions are **references** (`permissions.post.update`). Outcomes are `granted`, `denied`, or `approval-required`. The subject comes from a trusted resolver (`subjectFrom*` or your session). Client entries load snapshots and hooks only.

## 1. Detect

Find the framework (Next.js, Vite + React, Hono, Nuxt, Astro, React Router, TanStack Start, MCP, AuthZEN PDP, AI SDK, Claude Agent SDK, Eve, OpenAI Agents SDK, Effect) and the Standard Schema validator already in the repo (Zod, Valibot, ArkType, Effect Schema). Nuxt, Astro, React Router, TanStack Start and Effect use `@permdock/cli/unplugin` for collect only; do not add a per-vendor package.

Done when the adapter import path (`permdock/<framework>`) and the validator import are named.

## 2. Define

Create `src/permissions.ts`. Importable everywhere. No rules, no secrets.

```ts
import { definePermissions, resource } from 'permdock';
import { Post } from './schemas';

export const permissions = definePermissions({
  post: resource(Post, {
    id: 'id',
    actions: ['read', 'update', 'delete', 'publish'],
    collection: ['create', 'list'],
  }),
});
```

Done when every resource the first guard needs has a leaf, and instance actions sit in `actions` while list/create sit in `collection`.

## 3. Policy

Create `src/policy.ts`. Server-only. Roles as `allow` / `deny` arrays. Portable `where` first; closures only when a portable operator cannot express the rule. Destructive agent-reachable actions take `approval: 'human'`. A `limit: { count, per }` grant needs `limits: memoryLimitStore()` (or your store) on `createPermDock`; `can` never consumes.

```ts
import { definePolicy, role, allow, subject } from 'permdock';
import { permissions } from './permissions';

const member = role('member', [
  allow(permissions.post.read),
  allow(permissions.post.list),
  allow(permissions.post.create),
  allow(permissions.post.update, { where: { authorId: subject.id } }),
  allow(permissions.post.delete, {
    where: { authorId: subject.id },
    approval: 'human',
  }),
]);

export const policy = definePolicy(permissions, {
  roles: [member],
  subject: (user) => user && { id: user.id, roles: user.roles },
});
```

Done when at least one role grants the first guard's permission, and `policy.ts` is not imported from a client entry.

## 4. Factory

Create `src/permdock/server.ts` (or the adapter's documented factory file). Export `createPermDock` from `permdock/<framework>`. Copy the exact return names from [adapters.md](adapters.md). For Nuxt, Astro, React Router, TanStack Start or Effect there is no `permdock/<framework>`: add `createPermDockUnplugin.vite()` (or the matching bundler adapter) from `@permdock/cli/unplugin`, then `permdock/server` (or the HTTP adapter that matches the listener) plus `permdock/vue` / `permdock/react` / `permdock/svelte` on the client.

When the app already verifies OAuth or OIDC access tokens, resolve the subject with `subjectFromJwt` from `permdock/jwt`: `discovery: '<issuer>'`, `audience` set to the resource identifier, algorithms written as `Ed25519` / `ES256` / `PS256`. A claimed `act` that does not nest is anonymous with cause `invalid-chain`. When the app already called RFC 7662 or RFC 9767 introspection, pass the JSON to `subjectFromIntrospection`; `active` other than `true` is anonymous and the HTTP call stays yours. HTTP adapters accept `webBotAuth: { verify: true, keys: discoverViaSignatureAgent({ allow: ['agents.example.com'] }) }` to fill `actor` from RFC 9421; a failed signature is `InvalidSignatureError`, never an anonymous actor.

Done when the factory file compiles and exports the adapter's public members.

## 5. Guard

Add one check on the path the user asked for:

- HTTP / Next: `assert` or `protect` / `getPermission` with a permission reference
- React: `<Protected permission={permissions.post.update}>` inside `PermDockProvider`
- Agent: map the tool name in `tools` and pass `toolApproval` / `canUseTool` / `needsApproval` / `approval`

Done when that path cannot run without a `granted` decision, and a deny or approval-required outcome is handled by the adapter (Problem Details, fallback UI, or the runtime's approval hook).

## 6. Check

Run `permdock collect`, `permdock usage`, and `permdock doctor` when `@permdock/cli` is installed. Add `permdock collect --check` to CI. When the repo has Arazzo workflows, also run `permdock arazzo check --doc <arazzo> --openapi <doc>`.

If the CLI is not installed, typecheck the three files and add a policy-matrix test with `@permdock/testing`.

Done when collect/doctor findings are fixed, or the typecheck and one matrix test pass.
