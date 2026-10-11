---
name: better-supabase-testing
description: Test Supabase RLS policies, APIs and SQL against the local stack with better-supabase/testing, typed seeds and pgTAP. Use when writing or fixing tests that touch the database, policies, auth, OAuth or agent scopes, or Temporal time values.
---

# Testing with better-supabase

Test against the local stack (`supabase start`) as real users. Don't mock
supabase-js, and don't use the service role for anything a user does.

## Workflow: test a table or policy

1. Start the stack (`supabase start`) and write `.env.local` with
   `better-supabase env`. In a sandbox without Docker, start it with
   `SUPABASE_EXPERIMENTAL_STACK=1` (the Supabase CLI's native stack).
2. Add the rows the test needs to `supabase/seed.ts`, including one row
   owned by another tenant, then `supabase db reset`.
3. Write the RLS test with `asUser` for each role that matters.
4. Assert both directions: the user sees and changes their own rows, and
   another tenant's rows come back as `not_found` or `forbidden`.
5. Run `supabase test db` if the project has pgTAP tests.

Done when the test fails after you drop or loosen the policy, and passes
again once you restore it.

## Setup

- `better-supabase env` writes the URL and keys to `.env.local`; load it in the test setup.
- `better-supabase keys` creates `supabase/signing_keys.json`. Set `signing_keys_path = "./signing_keys.json"` under `[auth]` in `supabase/config.toml`, gitignore the file and restart the stack. `asUser` signs ES256 tokens with it.
- Typed fixtures live in `supabase/seed.ts`:

```ts
import { defineSeed } from "better-supabase/testing";
import { betterSupabase } from "../src/lib/supabase/index.ts";

export const seed = defineSeed(betterSupabase, {
  organizations: { acme: { id: ACME, name: "Acme" } },
  customers: { first: { id: FIRST, organizationId: ACME, name: "First" } },
});
```

`better-supabase seed` renders them to SQL for `supabase db reset`, and
tests import the same rows (`seed.rows.customers.first.id`).

## RLS tests

```ts
const alice = await asUser(
  betterSupabase,
  { sub: aliceId, tenant_id: ACME },
  { postgres },
);
expect(await alice.db.customers.count().orThrow()).toBe(1);
expect(
  await alice.db.customers.findById(OTHER_ORGANIZATION_CUSTOMER),
).toMatchObject({
  ok: false,
});
```

- Check both directions: the user sees their own rows and never sees another tenant's.
- `alice.sql` runs the same checks over direct Postgres.
- Assert on `result.error.kind` (`not_found`, `forbidden`, `conflict`, `validation`), not on messages.

## API tests

Send `authorization: Bearer ${alice.token}` (or a token from `signLocalJwt`).
The adapter verifies it against the local JWKS; no test-only resolver is needed.

For a route with `scopes`, sign a delegated token the way the Supabase OAuth
server or an agent token exchange would, and assert both sides:

```ts
const client = await signLocalJwt({
  sub: aliceId,
  tenant_id: ACME,
  client_id: "c1",
  scope: "openid", // add "customers:read" to pass
});
const response = await app.request("/api/customers", {
  headers: { authorization: `Bearer ${client}` },
});
expect(response.status).toBe(403);
expect(response.headers.get("www-authenticate")).toContain(
  'error="insufficient_scope"',
);
```

The user's own token (no `client_id`, no `act`) must still pass, and a
malformed `act` claim (`act: { sub: "" }`) must get a 401.

## Time values

With `codecs.timestamptz: 'instant'`, rows hold `Temporal` values. Import
`temporal-polyfill/global` in the test setup on Node 24, and compare with
`.equals()` or an equality tester, because `toEqual` treats any two instants
as equal:

```ts title="tests/setup.ts"
import "temporal-polyfill/global";
import { expect } from "vitest";

expect.addEqualityTesters([
  (a, b) =>
    a instanceof Temporal.Instant && b instanceof Temporal.Instant
      ? a.equals(b)
      : undefined,
]);
```

With the polyfill, `vi.useFakeTimers({ now })` drives `Temporal.Now` too.

## Doctor in CI

Run `pnpm better-supabase doctor` against the reset stack and fail the job on
a nonzero exit. `--json` prints the report with each finding's code,
`--format github` annotates the pull request, and
`--format sarif --out doctor.sarif` feeds code scanning.

## pgTAP

`better-supabase sql add pgtap` installs `tests.create_user`,
`tests.authenticate_as(user, claims)`, `tests.clear_authentication()` and
`tests.rls_enabled('public')` for `supabase test db`. Put
`select tests.rls_enabled('public');` in a test so tables without RLS fail CI.
