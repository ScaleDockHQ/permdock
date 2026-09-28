# PermDock — Product brief

This is the short product brief: what PermDock is, who it is for, the principles it holds to and how the business works. Everything else lives in the documentation tree under [`apps/docs/content/docs`](./apps/docs/content/docs). When the two disagree, the docs tree wins and this file gets fixed.

- Adapters and example apps: [adapters](./apps/docs/content/docs/adapters/index.mdx)
- Standards PermDock implements or follows: [standards](./apps/docs/content/docs/standards/index.mdx)
- What is planned and the open questions: [roadmap](./apps/docs/content/docs/roadmap.mdx)
- How PermDock compares to other libraries and products: [comparison](./apps/docs/content/docs/comparison.mdx)

## Positioning

**Tagline.** Typed permissions for TypeScript apps, APIs, databases, and AI agents.

**One-liner.** Define permissions once as typed references over the Zod, Valibot or ArkType schemas you already have; grant them to roles with portable conditions; check them in React, React Native, Next.js, Hono, tRPC and MCP servers; compile the same conditions to SQL `where` clauses and Postgres RLS policies; drive tool approvals in agent runtimes from the same decision.

**Why it exists.** Permission logic in a typical TypeScript app lives in three places that drift apart: checks in the UI, string keys in the API, and RLS policies nobody can diff against the app. AI agents now call tools on a user's behalf and need "ask the user first" as a real outcome, not a boolean. Template-literal permission keys are expensive for the TypeScript 7 compiler, and blocking permission checks break instant navigation in modern React frameworks. PermDock is one definition and one decision object for all of it, built clean-room: it copies no other library's naming or API surface ([landscape](./apps/docs/content/docs/research/landscape.mdx)).

## Who it is for

1. **TypeScript product teams** shipping Next.js, React or React Native apps on Postgres (often Supabase) who maintain permission logic in the UI, the API and RLS and want one source.
2. **API and MCP server authors** who need per-route and per-tool authorization, step-up scopes, OpenAPI security output and machine-readable denials.
3. **Teams building agents** on the Vercel AI SDK, Claude Agent SDK, Eve or the OpenAI Agents SDK who need human approval as a first-class outcome, per-tool least privilege and an audit trail.
4. **Coding agents** working in those repositories. Every docs page, skill and error message is written so an agent can wire PermDock end to end without reading source ([for AI agents](./apps/docs/content/docs/for-ai-agents.mdx)).

## Design principles

- **Typed references.** Permissions are frozen objects (`permissions.post.update`), never strings, in the public API. Go-to-definition works, renames are safe, and the runtime definition is the catalog ([permissions](./apps/docs/content/docs/concepts/permissions.mdx)).
- **Policy as data.** Roles are arrays of `allow` and `deny` grants with a JSON condition tree. One condition evaluates in memory, in the browser, in Drizzle, Prisma or Kysely `where` clauses and in RLS; closures are a branded, server-only escape hatch ([policies](./apps/docs/content/docs/concepts/policies.mdx), [conditions](./apps/docs/content/docs/concepts/conditions.mdx)).
- **Immutable and request-scoped.** `createPermDock` returns a frozen instance, safe in React Server Components, edge runtimes and concurrent requests.
- **Explainable.** `decide()` returns `granted`, `denied` or `approval-required` with the matched grant, denial reasons, permitted alternatives and a replay-safe token ([decisions](./apps/docs/content/docs/concepts/decisions.mdx)).
- **Fail-closed.** A missing grant, an unknown role, invalid input or an unrecognised remote decision all deny, and any matching deny wins ([threat model](./apps/docs/content/docs/security/threat-model.mdx)).
- **Authentication upstream.** PermDock consumes verified material only. `permdock/jwt` and the provider `subjectFrom*` helpers verify tokens; core never does ([authentication](./apps/docs/content/docs/concepts/authentication.mdx)).
- **Delegation-aware.** A subject is a principal, an actor and a delegation; an agent never exceeds the user it acts for ([subject](./apps/docs/content/docs/concepts/subject.mdx)).
- **Standards-first.** Wire formats follow AuthZEN, OpenAPI, Standard Schema, RFC 9457 Problem Details, JOSE, SCIM, SSF and CAEP, and MCP, so any language can read what PermDock produces ([standards](./apps/docs/content/docs/standards/index.mdx)).
- **Agent-readable.** Shipped skills, `AGENTS.md`, `llms.txt`, a JSON Schema catalog and denials written for models.
- **Small.** ESM-only, zero runtime dependencies in core other than `@standard-schema/spec`, and per-entry bundle size measured in CI.

## Non-goals

- Requiring a network call to decide. PermDock is a decision point you embed; every hosted capability has an in-process default behind the same interface.
- A policy language, an authentication product, token issuance, or Zanzibar-scale relationship graphs. PermDock bridges to OpenFGA or SpiceDB through a provider, and resource roles follow declared, finite `parent` chains only.
- Storing or managing tenants, teams, invitations, memberships or custom roles. PermDock reads them through `MembershipSource` and `RoleSource`; the auth provider or the application owns the tables ([tenancy](./apps/docs/content/docs/concepts/tenancy.mdx)).
- UI components beyond `<Protected>`. Hooks return data and the application's design system renders it.

## Business model

The library is and stays MIT. PermDock Cloud is an optional hosted service built on the same public interfaces, in the separate `PermDock-Cloud` repository: dashboard [app.permdock.com](https://app.permdock.com), API [api.permdock.com](https://api.permdock.com), read-only MCP [mcp.permdock.com](https://mcp.permdock.com). It is never on the decision path: every decision runs in the application's process, and a Cloud outage never changes an outcome.

What the Cloud sells:

- **Decision log and evidence.** Access-review queries per principal, actor, tenant and time window; agent activity views; the approval chain joined on `token`; signed exports (`permdock-decisions+jwt`), OCSF forwarding and CSV for compliance platforms; retention tiers. This is the lead product.
- **Approvals inbox.** Pending approvals with delivery to Slack and Teams and approver management, behind the `ApprovalStore` interface.
- **Snapshot distribution.** Signed snapshots with CAEP invalidation, behind the `SnapshotSource` interface.
- **SCIM relay.** An identity-provider wizard, group-to-role mapping and a sync log that replays provisioning into a `DirectoryStore` the application owns (`permdock/scim`). In this bring-your-own mode the Cloud holds no authoritative directory copy. In Cloud-native directory mode the Cloud holds the directory of record, and it reaches a decision only as claims on a token the application verifies locally.
- **Hosted AuthZEN endpoint** for gateways and services not written in TypeScript.
- **Hosted grants.** A signed policy document that only adds grants to permissions the code marks `hostable`, and never overrides a code deny or a code approval.

Every hosted capability is an interface with an in-process default in the open-source package (`ApprovalStore`, `DecisionSink`, `SnapshotSource`, `PolicySource`, `DirectoryStore`), so a team can self-host over its own database. The Cloud is the managed implementation. Every connector speaks a standard wire format or an existing PermDock interface, never a per-vendor package ([PermDock Cloud](./apps/docs/content/docs/adapters/cloud.mdx)).

**Meters.** Monthly active principals (a human and each agent actor counted once), connected tenants, resolved approvals above a free allowance, decision retention tier, and hosted AuthZEN evaluations. Decisions made by the embedded engine are never metered.

**Posture.** The realistic outcome for an independent authorization company is acquisition by an identity or platform vendor, so PermDock builds for portability: standard wire formats, Vercel-native distribution (a Marketplace integration with `eve-agent` as the template), no authentication product and no gateway, so every identity provider stays a possible partner, and a Cloud repository that stays thin and bound to this repository's interfaces.
