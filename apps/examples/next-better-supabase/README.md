# `@permdock/example-next-better-supabase`

PermDock with [better-supabase](https://www.npmjs.com/package/better-supabase) on Next.js 16.3 with Cache Components, Partial Prefetching and instant navigation, in the CentraKit shape: `/[locale]/[orgSlug]/...` routes, staff roles per organization in `memberships`, and customer-portal contacts through `contacts.user_id`.

Snapshot-only mode: every grant is portable, so the provider has `endpoint={false}` and the app mounts no `/api/permdock` route. The snapshot rides the prefetched App Shell; Postgres RLS decides which rows come back.

```bash
pnpm --filter @permdock/example-next-better-supabase serve
```

`serve` needs Docker. It starts a throwaway Postgres 17 (testcontainers), applies the auth stub, the migrations and the seed, generates an ES256 key, then runs `next build` and `next start` on `http://127.0.0.1:3489/en`.

Sign in as:

- **Olivia**, owner of Acme and member of Globex: Staff and Quotes in Acme, only Staff in Globex.
- **Mason**, member of Acme: Staff only; the quotes page shows its fallback.
- **Carla**, contact of the Initech customer: `/en/portal/acme/quotes` lists only Initech's quote.

Where things live:

- `src/policy.ts` and `src/sources.ts`: the policy and the membership sources the token hook and the SQL helpers share.
- `supabase/migrations`: the app tables, then `permdock rls generate --target sql` (helpers and policies) and `permdock supabase hook generate` (the access-token hook).
- `src/lib/supabase.ts`: `createNext` with direct Postgres, an inline JWKS and explicit issuer and audience.
- `src/lib/access.ts`: the shared slug lookup (`'use cache'`), the snapshot loader and the RLS reads (`'use cache: private'` over `next.cached()`), tagged `snapshotTag(sub)`.
- `src/app/api/test/sign-in/route.ts`: e2e only. Runs the hook as `supabase_auth_admin`, signs the claims and sets the `@supabase/ssr` cookie, as Supabase Auth would.
- `src/lib/supabase/generated.ts`: `pnpm gen` regenerates it from the migrations; `pnpm gen:check` fails on drift.

`tests/e2e/src/next-better-supabase.spec.ts` asserts with `@next/playwright` `instant()` that page and organization switches render gated nav without a request, and that no request reaches `/api/permdock`.
