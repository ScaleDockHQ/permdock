# `@permdock/example-next-better-supabase`

PermDock with [better-supabase](https://www.npmjs.com/package/better-supabase) on Next.js 16.3 with Cache Components, Partial Prefetching and instant navigation, in the CentraKit shape: `/[locale]/[orgSlug]/...` routes, staff roles per organization in `memberships`, and customer-portal contacts through `contacts.user_id`.

Snapshot-only mode: every grant is portable, so the provider has `endpoint={false}` and the app mounts no `/api/permdock` route. The snapshot rides the prefetched App Shell; Postgres RLS decides which rows come back.

```bash
pnpm --filter @permdock/example-next-better-supabase serve
```

`serve` needs Docker. It starts a throwaway Postgres 17 (testcontainers), applies the auth stub (the Supabase roles and `auth` readers), the migrations and the seed, generates an ES256 key, then runs `next build` and `next start` on `http://127.0.0.1:3489/en`.

Every cached read in `src/lib/access.ts` waits 3 s first, so a prefetched or cached render stands out from a cold one. The staff and quotes lists end with how long their read took and when it ran. Set `DEMO_LATENCY_MS` to change the delay, or to `0` to turn it off.

Sign in as:

- **Olivia**, owner of Acme and member of Globex: Staff and Quotes in Acme, only Staff in Globex.
- **Mason**, member of Acme: Staff only; the quotes page shows its fallback.
- **Carla**, contact of the Initech customer: `/en/portal/acme/quotes` lists only Initech's quote.

Where things live:

- `src/policy.ts` and `src/sources.ts`: the policy and the membership sources the token hook and the SQL helpers share.
- `supabase/config.toml`: the local stack on ports 54420 to 54429, pg-delta (`[experimental.pgdelta]`) and the token hook in the private `permdock` schema, which `[api] schemas` leaves out.
- `supabase/schemas`: the source of truth, in pg-delta's per-schema layout. `public/tables` holds the app tables with `created_at` and `updated_at`, money as `amount_minor` plus `currency`, and the better-supabase `updated-at` and `audit` triggers. `permdock/` and `public/policies/permdock.sql` come from `permdock rls generate --split`, and `better_supabase/` comes from `better-supabase sql sync`.
- `supabase/migrations`: the baseline from `pnpm supabase:diff baseline` (`supabase db schema declarative sync`), the `role_permissions` seeds from `--seeds-out`, and the `audited_tables` rows. Never edit the schema in Studio or with `psql`: the diff does not see those changes.
- `supabase/tests`: pgTAP over the seeded tenants; `pnpm supabase:start`, then `pnpm supabase:test`.
- `permdock.manifest.json`: what the hook and helpers expect, from `permdock supabase inspect --out`; `pnpm gen` writes it, `pnpm gen:check` and `pnpm run doctor` fail on drift.
- `src/lib/supabase/index.ts`: the `betterSupabase` definition; sessions validated with `supabaseClaims().extend(...)`.
- `src/lib/supabase/server.ts`: `import 'server-only'`, then `bs = createNext(betterSupabase, ...)` with direct Postgres, an inline JWKS and explicit issuer and audience.
- `src/lib/access.ts`: the shared slug lookup (`'use cache'`), the snapshot loader and the RLS reads (`'use cache: private'` over `bs.cached({ tags })`), tagged `snapshotTag(sub)`. After a role or plan change, `bs.invalidateSession(userId, { tags: [snapshotTag(userId)] })` drops them.
- `src/app/api/test/sign-in/route.ts`: `serve` only (`DEMO_SIGN_IN=1`). Runs the hook as `supabase_auth_admin`, signs the claims and sets the `@supabase/ssr` cookie, as Supabase Auth would.
- `src/lib/supabase/generated.ts`, `generated.meta.js` and `generated.meta.d.ts`: `pnpm gen` regenerates them from the migrations; `pnpm gen:check` fails on drift.

## Verify instant navigation

```bash
pnpm --filter @permdock/example-next-better-supabase test:instant
```

Needs Docker. Runs `serve` with `EXPOSE_TESTING_API=1` on `http://127.0.0.1:3589`, then runs `tests/instant/*.instant.ts` with `instant()` from `@next/playwright` at 1280 px and 390 px. The specs cover the initial load of `/en/acme/staff` and `/en/portal/acme/quotes` and the soft navigation from Staff to Quotes. `cold-then-warm.instant.ts` goes back from Quotes to Staff under the lock and expects the staff read time from the first visit. Under the lock each spec expects the shell and the skeleton, and expects the RLS-read list to be absent. Install Chromium once with `pnpm --filter @permdock/example-next-better-supabase exec playwright install chromium`.
