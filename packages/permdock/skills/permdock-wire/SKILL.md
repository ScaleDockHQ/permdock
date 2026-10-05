---
name: permdock-wire
description: Adds PermDock authorization to a TypeScript app, from definitions to the first guard. Use when installing permdock, adding permissions, roles, plans, RBAC or access control, writing definePermissions, definePolicy or createPermDock, guarding a route, Server Action, procedure or React component, adding usage limits, plan gates or time-limited grants, or running permdock collect and doctor for the first time.
license: MIT
metadata:
  author: ScaleDockHQ
  homepage: https://permdock.com/docs/getting-started/quick-start
  repository: https://github.com/ScaleDockHQ/permdock
---

# Wire PermDock

Three files and one guard: `src/permissions.ts` (definitions), `src/policy.ts` (rules) and the factory file, then one check on the path the user asked for ([quick start](https://permdock.com/docs/getting-started/quick-start)). Import paths and identifiers follow the [naming convention](https://permdock.com/docs/getting-started/naming).

## Inputs (find out, or ask before starting)

- The framework: Next.js, Hono, Express, Fastify, Elysia, Nest, Node, tRPC, oRPC, an AuthZEN PDP, Vite with React, Vue, Svelte or Solid, React Native, or a collect-only framework (Nuxt, Astro, React Router, TanStack Start, Effect).
- The Standard Schema validator already in the repo: Zod, Valibot, ArkType, Effect Schema.
- Where the signed-in user comes from (the session or a verified token) and which roles and plans exist.
- The first path to guard.

## Invariants

1. Permissions are references (`permissions.post.update`), never strings. Roles and plans are typed leaves (`roles.owner`, `plans.pro`).
2. Outcomes are `granted`, `denied` or `approval-required`. Anything unknown, invalid or thrown denies, and a matching `deny` wins over every `allow`.
3. `policy.ts` is server-only. Client entries import `permissions.ts`, snapshots and hooks only.
4. The subject comes from a trusted resolver (`subjectFrom*` or the server session), never from a request body, header the client sets, or model output.
5. Portable `where` conditions first; a closure only when no portable operator expresses the rule.

## Workflow

1. **Detect.** Find the framework and the validator. Collect-only frameworks use `permdock/unplugin` for collect and `permdock/server` (or the matching HTTP adapter) at runtime; never add a per-vendor package.
   ✓ The adapter import path (`permdock/<framework>`) and the validator import are named.
2. **Define.** Create `src/permissions.ts`. Importable everywhere; no rules, no secrets.

   ```ts
   import {
     definePermissions,
     defineRoles,
     definePlans,
     resource,
     crud,
   } from "permdock";
   import { Post } from "./schemas";

   export const permissions = definePermissions({
     post: resource(Post, crud({ relations: { author: "authorId" } })),
   });
   export const roles = defineRoles({ member: {}, admin: {} });
   export const plans = definePlans({ pro: {} });
   ```

   ✓ Every resource the first guard needs has a leaf; instance actions sit in `actions`, list and create in `collection`.

3. **Policy.** Create `src/policy.ts`. Prefer `grants` with `to:` selectors (`anyone()`, `authenticated()`, `relation()`, a role or plan leaf, `actor()`, `assurance()`); `role(roles.member, …)` sugar also works.

   ```ts
   import { definePolicy, role, allow, principal, relation } from "permdock";
   import { permissions, roles } from "./permissions";

   const member = role(roles.member, [
     allow(permissions.post.read),
     allow(permissions.post.list),
     allow(permissions.post.create),
     allow(permissions.post.update, {
       to: relation(permissions.post, "author"),
     }),
     allow(permissions.post.delete, {
       where: { authorId: principal.id },
       approval: "human",
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

   Short policy features that need no other skill -> [references/policy-options.md](references/policy-options.md): usage limits, `disclosure: 'hide'`, plan gates, `validFrom` / `validUntil`, step-up with `assurance()`.
   ✓ At least one role grants the first guard's permission, and no client entry imports `policy.ts`.

4. **Factory.** Create `src/permdock/server.ts` (or the adapter's documented factory file) with `createPermDock` from `permdock/<framework>`. Copy the exact return names. -> [references/adapters.md](references/adapters.md)
   ✓ The factory file compiles and exports the adapter's public members.
5. **Guard.** Add one check on the path the user asked for: `assert` or `protect` / `getPermission` with a permission reference on the server, `<Protected permission={permissions.post.update}>` inside `PermDockProvider` in React.
   ✓ That path cannot run without a `granted` decision, and the adapter handles a denial (Problem Details or fallback UI).
6. **Check.** Run `permdock collect`, `permdock catalog`, `permdock usage` and `permdock doctor`, and add `permdock collect --check` to CI. For a Vite SPA, Expo or another framework without `'use client'`, set `doctor.clientEntries` to the client source globs so PD001 checks them. When client code lives outside `collect.srcPath`, list every source folder in `doctor.srcPath` instead of widening the catalog. Add a `describePolicy` suite from `permdock/testing` ([scenario testing](https://permdock.com/docs/guides/scenario-testing)). -> [references/policy-options.md](references/policy-options.md#cli-starting-points)
   ✓ Collect and doctor findings are fixed, or the three files typecheck and one matrix test passes.

## Next skills

Install each with `npx skills add ScaleDockHQ/PermDock --skill <name>` when the app needs it:

- `permdock-agents`: AI SDK, Claude Agent SDK, Eve, OpenAI Agents SDK, MCP, A2A and WebMCP tool maps, actors and `delegation`.
- `permdock-approvals`: `approval: { by }`, quorum, escalation, `staleOn`, approval stores and the resume flow.
- `permdock-tenancy`: named scopes, memberships, ownership rules (`min`, `assigns`, `for`) and custom roles.
- `permdock-data`: `where()` and `filter()` in ORM queries, generated RLS, relationship graphs, parity tests.
- `permdock-credentials`: `subjectFromJwt`, API keys and service accounts, share links.
- `permdock-audit`: review the result or a pull request.

## Verify before done

- [ ] No string permission keys in app code; every check passes a reference.
- [ ] `policy.ts` is imported only from server code, and PD001 is clean.
- [ ] The subject resolver reads only the server session or a verified token.
- [ ] `permdock collect --check` runs in CI, and a `describePolicy` suite covers the new grants.

## Reference index

- [references/adapters.md](references/adapters.md): factory shapes for Next.js, HTTP frameworks, RPC frameworks, UI frameworks, AuthZEN, OpenAPI, OpenTelemetry, SCIM, Cloud, Better Auth, Clerk, Supabase, the remote PDP and collect-only frameworks.
- [references/policy-options.md](references/policy-options.md): limits, disclosure, plans, validity windows, step-up, and CLI starting points (OpenAPI import, Arazzo, Cloud push).
- The `permdock` skill: the mental model, `explain` for an unexpected denial, and the docs MCP.
- Docs: [policies](https://permdock.com/docs/concepts/policies), [conditions](https://permdock.com/docs/concepts/conditions), [decisions](https://permdock.com/docs/concepts/decisions), [adapters](https://permdock.com/docs/adapters).
