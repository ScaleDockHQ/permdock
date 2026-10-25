---
name: better-supabase-auth
description: Read and check the caller in better-supabase apps, including sessions, typed claims, user profiles, OAuth clients and agents acting for a user, scopes, ended sessions and authorization providers. Use when code reads auth, session or claims, when adding a custom access token hook, an OAuth or agent integration, sign-out, account deletion or role changes, or when better-supabase.config.ts has an authorization key.
---

# Auth with better-supabase

Every adapter resolves the caller once. It verifies the access token locally
against the project's JWKS, so a valid token costs no network call, and only
the Next.js proxy (`bsb.proxy`) refreshes sessions. Don't call
`supabase.auth.getUser()` per request, and don't read cookies yourself.

## Workflow: read the caller

1. Take `auth` from the handler context (`ctx.auth`, `c.var.auth`,
   `context.auth`), or a token-free `AuthSession` from `await bsb.session()`
   or `toSession(ctx.auth)`.
2. Branch on `kind` with an exhaustive `switch` that ends in a `never` check:

```ts
switch (auth.kind) {
  case "user": // auth.user.id, auth.claims
    break;
  case "service": // a secret key
    break;
  case "anon": // auth.reason: 'none' | 'expired' | 'signed_out' | 'refresh_failed'
    break;
  case "invalid": // auth.reason: 'token' | 'claims' | 'actor', answer 401
    break;
  default: {
    const unreachable: never = auth;
    return unreachable;
  }
}
```

3. Prefer the adapter's `allow` option (`['user']` by default) over checking
   `kind` by hand; it answers 401 or 403 as Problem Details.

Done when every `invalid` reason, `actor` included, ends in a 401 and no code
path treats `invalid` as `anon`.

## Workflow: type the claims

1. Describe the claims your access token hook adds with any Standard Schema
   and pass it to `betterSupabase.claims(schema)`. Use a loose object (`v.looseObject`,
   `z.looseObject`) so claims the schema doesn't list stay on the session.
   Make anything the hook doesn't always set optional or give it a default.
2. For display data users edit themselves (name, avatar), use
   `betterSupabase.userMetadata(schema)` and read `session.profile`.
3. Read roles, memberships, the tenant and entitlements from the verified
   claims only. Never from `user_metadata`, `session.profile`, a URL or a
   request body. A tenant from the URL or input is only safe through the
   `tenant` resolver or the `{ tenant }` option, which check membership.

Done when `session.claims` is typed without casts, and a token whose claims
fail the schema gets a 401 with code `CLAIMS_INVALID`.

## Bearer callers: OAuth clients and agents

A token from the Supabase OAuth server carries `client_id` and `scope`; a
token exchanged for an agent carries an RFC 8693 `act` chain. The session
names who acts for the user:

| Token                                            | `session.actor`                                 | `session.delegation` |
| ------------------------------------------------ | ----------------------------------------------- | -------------------- |
| The user's own                                   | not set                                         | not set              |
| `client_id: "c1"`, `scope: "openid crm.read"`    | `{ id: "c1", kind: "oauth-client" }`            | `{ scopes: [...] }`  |
| `act: { sub: "agent", act: { sub: "mcp-42" } }`  | `{ id: "agent", chain, ... }`                   | `{ scopes, chain }`  |
| `act: { kind: "support", sub, session_id, ... }` | `{ kind: "support", id, sessionId, readOnly }`  | not set              |
| `act: { kind: "impersonation", sub, reason }`    | `{ kind: "impersonation", id, reason }`         | not set              |
| `act: { kind: "agent", sub, tools, read_only }`  | `{ kind: "agent", id, tools, readOnly, chain }` | with a `scope` claim |

- Limit what delegated tokens may do with the `scopes` guard option on
  `bsb.route`, `bsb.action`, `bsb.handler` and `bsb.middleware`. A missing
  scope answers 403 with an `insufficient_scope` challenge. Only an
  `oauth-client` actor, and an `agent` on a token with a `scope`, are
  limited: the user's own token, a support session and an impersonated
  session are not. `delegation.scopes` leaves out OpenID identity scopes
  (`openid`, `email`, `profile`, `phone`, `address`, `offline_access`).
- Switch on `session.actor.kind` with a `never` default: it is
  `oauth-client`, `support`, `impersonation` or `agent`. An invalid `act`
  (another `kind`, a level without `sub`, a malformed agent or support
  level, or a 0.5.0 support token with `session_id` but no `kind`) resolves
  to `invalid` with reason `actor`, never to the user alone.
- An agent's `tools` list is enforced by `createAgentRuntime` and
  `assertToolDelegated` only, not by guards or RLS.
- In MCP servers, refuse calls in `authorize` by reading
  `toSession(ctx.auth).delegation?.scopes` (the `better-supabase-api` skill).
- RLS still decides the rows: `sub` is the user, so a client sees at most
  what the user sees. Record `session.actor` (and `chain`) in audit data when
  a change was made by a client or an agent.

## Workflow: irreversible actions

Tokens stay valid until they expire (an hour by default), even after the user
signs out everywhere or an admin ends the session. Before an action you can't
undo (deleting the account, transferring ownership, rotating keys), check
that the session still exists:

```ts
import { err } from "better-supabase";
import { checkSession } from "better-supabase/server";

const ended = await checkSession(postgres.admin, auth);
if (ended) return err(ended); // unauthorized, code SESSION_REVOKED
```

It needs a connection that can read `auth.sessions` (`createPostgres().admin`).
Nothing calls it by default; keep it to the actions that need it.

When RLS checks the session (so an ended session sees no rows), sign the
browser out on page loads instead of showing an empty app. Next.js:
`bsb.proxy(request, { endedSession: { redirect: "/login" } })` asks Auth on
document loads (and on `paths`), clears the cookies and redirects with
`?reason=session_ended`.
A proxy or middleware with its own Supabase client calls
`sessionStatus(request, { url, publishableKey })` from `better-supabase/ssr`
(`"ended"` on a 401 or 403 from Auth; treat `"unknown"` as active) and
`clearSessionCookies(request, response, { url })` before redirecting.

Done when the irreversible action returns `SESSION_REVOKED` for a signed-out
session in a test.

To lock a user out, call `bsb.suspendAccount(userId, { suspended: true })`.
It bans the user in Auth and keeps the sessions, so Auth answers with
`user_banned`, `sessionStatus` returns `"banned"` and the `session_active()`
policy refuses the user's tokens. `{ suspended: false }` ends every session
and refresh token, then lifts the ban. Without the `sessions` SQL module, pass
`endSessions: true` to delete the sessions on suspension too (the app then
sees `"ended"`). `bsb.endSessions(userId)` signs a user out everywhere without
a ban. To
switch a member off in one organization only, use the organizations block's
`suspendMember`.

## When claims change

A token carries the claims from when Auth issued it, so a revoked role or
membership lasts until the next refresh. When that window matters:

- Write policies that read the source of truth, for example
  `organization_id in (select better_supabase.member_organization_ids())`, instead of
  the claim.
- For signed-out, banned or deleted users, add the `sessions` SQL module and a
  restrictive policy with `using ((select better_supabase.session_active()))`
  on the tables that guard sensitive data.
- After a change the user made themselves (joining an organization), call
  `supabase.auth.refreshSession()` in the browser (in Next.js, through
  `useSessionChange`'s `refreshToken`, below).
- In Next.js, drop the user's cached views with
  `bsb.invalidateSession(userId, { tags })`.

## Next.js caching

- Per-user data goes through `bsb.cached()` inside your own
  `'use cache: private'` function. It tags the entry `bsb:session:<user id>`
  and caps its lifetime at the token's.
- `bsb.cached({ tags, life: { stale } })` adds tags and caps the stale time
  further, for example for a permission snapshot.
- `bsb.cached({ tables: ["customers"] })` tags the entry by table, so an
  action that writes the table drops it without a hand-written tag.
- `bsb.invalidateSession(userId)` reaches the server caches and the caller's
  router only; another user's browser keeps its private entries until they
  go stale.
- After signing in or out: `useSessionChange(sessionChanged)` from
  `better-supabase/next/client`. After switching the active organization:
  `useSessionChange(sessionChanged, router, { refreshToken: supabase })`, so
  the new token reaches the server before it renders.
- For a tenant from the route params, call `bsb.cached({ tenant })` and take
  the tenant as an argument of the `'use cache: private'` function, so it is
  part of the cache key. Outside a cache, use `bsb.context({ tenant })`.
- In the proxy, set `bsb.proxy(request, { protect, expiredPrefetch: "render" })`
  instead of returning early for `{ kind: "anon", reason: "expired" }` in
  `protect`. A prefetch never refreshes, so without it the prefetch caches a
  redirect to sign-in.
- Keep layouts synchronous: pass the `bsb.session()` promise to
  `<SessionProvider>` and read it with `useSession()`.

## Authorization providers

When `better-supabase.config.ts` has an `authorization` key, another package
answers permission checks and may own the access token hook, roles,
memberships and the tenant claim. Read
[references/authorization-providers.md](references/authorization-providers.md)
before touching the hook, claims, tenant or entitlements.

## Don't

- Don't refresh sessions outside the proxy, and don't verify tokens by
  calling the Auth server.
- Don't use `bsb.admin()` or the service role for a user's request.
- Don't downgrade an `invalid` caller to `anon`.
- Don't build 401 or 403 JSON by hand; return the `DbError` or use `allow`
  and `scopes`.
- Don't use `allow: ['anon']` for users from `signInAnonymously()`: `'anon'`
  means no session, and only `'anonymous'` admits anonymous sign-ins.

## Docs

https://bettersupabase.com/docs/auth.md,
https://bettersupabase.com/docs/frameworks/next.md (bearer callers),
https://bettersupabase.com/docs/auth/account-deletion.md,
https://bettersupabase.com/docs/frameworks/next-cache-components.md and
https://bettersupabase.com/docs/extending/authorization-providers.md.
