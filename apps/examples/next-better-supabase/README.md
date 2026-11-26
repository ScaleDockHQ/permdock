# `@permdock/example-next-better-supabase`

PermDock with [better-supabase](https://www.npmjs.com/package/better-supabase) on Next.js 16.4 with Cache Components, Partial Prefetching and instant navigation, in the CentraKit shape: `/[locale]/[orgSlug]/...` routes, staff roles per organization in `organization_memberships`, and customer-portal contacts through `contacts.user_id`.

The example runs on better-supabase 0.87.0. Its `memberships` block runs over the app's `public.organization_memberships` table, which PermDock reads with `blockMembershipSource`.

The portal layout keeps `endpoint={false}`. Staff routes use the factory in `src/permdock/server.ts`. Postgres RLS decides which rows come back. The app also mounts MCP, AuthZEN, SCIM, SSF, approvals, access reviews, an agent route and `/api/v1/quotes`.

```bash
pnpm --filter @permdock/example-next-better-supabase serve
```

`serve` starts the native Supabase stack (`supabase start --runtime native`), resets the database, generates an ES256 signing key, then runs `next build` and `next start` on `http://127.0.0.1:3489/en`. It does not use Docker. `pnpm test:integration` still does.

Cached reads wait `DEMO_LATENCY_MS` (default 3 s) so a prefetched render stands out from a cold one. Set it to `0` to turn the delay off. Measurements do.

Sign in as:

- **Olivia**, owner of Acme and member of Globex: Staff and Quotes in Acme, only Staff in Globex.
- **Mason**, member of Acme: Staff only; the quotes page shows its fallback.
- **Carla**, contact of the Initech customer: `/en/portal/acme/quotes` lists only Initech's quote.

Where things live:

- `src/policy.ts` and `src/sources.ts`: the policy and the membership sources the token hook and the SQL helpers share.
- `supabase/config.toml`: the local stack (`[experimental] stack = true`), pg-delta (`[experimental.pgdelta]`) and the token hook in the private `permdock` schema, which `[api] schemas` leaves out. The file sets no ports. Each worktree gets its own project on ports the CLI picks, and `pnpm supabase:start` runs it on the native runtime without Docker (macOS 14 or later on Apple silicon, Linux with glibc 2.35 or later). Read its URLs and keys from `supabase status --output-format json`.
- `supabase/schemas`: the source of truth, in pg-delta's per-schema layout. `public/tables` holds the app tables with `created_at` and `updated_at`, money as `amount_minor` plus `currency`, and the better-supabase `updated-at` and `audit` triggers. `permdock/` and `public/policies/permdock.sql` come from `permdock rls generate --split`, and the `900_better_supabase_*.sql` files come from `better-supabase upgrade`.
- `supabase/migrations`: the baseline from `pnpm supabase:diff baseline` (`supabase db schema declarative sync`), the `role_permissions` seeds that `--seeds-out supabase/migrations/` writes as a new migration when they change, and the `audited_tables` rows. Never edit the schema in Studio or with `psql`: the diff does not see those changes. For a change `permdock generate` does not own, run `supabase migration new <name>` and write the SQL there, or `supabase db pull --local` to record a change made in a local database; never name a migration file by hand.
- `supabase/tests`: pgTAP over the seeded tenants; `pnpm supabase:start`, then `pnpm supabase:test`. `pnpm supabase:check` runs `supabase db lint`, the advisors, `permdock doctor` and `better-supabase doctor --fail-on warning` against the same stack; `permdock rls verify --local` reads the stack's database URL from `supabase status`, and `scripts/stack-db-url.ts` hands it to `better-supabase doctor`, which has no `--local`.
- `permdock.manifest.json`: what the hook and helpers expect, from `permdock supabase inspect --out`; `pnpm gen` writes it, `pnpm gen:check` and `pnpm run doctor` fail on drift.
- `src/lib/supabase/index.ts`: the `betterSupabase` definition; sessions validated with `supabaseClaims().extend(...)`.
- `src/lib/supabase/server.ts`: `import 'server-only'`, then `bsb = createNext(betterSupabase, ...)` with direct Postgres, an inline JWKS and explicit issuer and audience.
- `src/lib/share.ts` and `src/app/[locale]/share/[token]/page.tsx`: the guest quote page over a better-supabase share link (`subjectFromShareLink`, `exchangeCapability`); the seeded link is `/en/share/acme-initech-rollout`.
- `src/permdock/server.ts`: `createPermDock` from `permdock/next` with `endpoint: false`; its `subject` reads `bsb.cached()`, and the layouts render its `PermDockProvider` with `snapshot`.
- `src/features/quote/quote-queries.ts`: the RLS read (`'use cache: private'` over `bsb.cached({ tags })`), tagged `snapshotTag(sub)`. `src/features/quote/quote-overview.ts` fills `public.quotes_overview_payload` with `share: "tenant"`. `src/proxy.ts` refreshes the session and sets `x-permdock-org`.
- `src/app/api/sign-in/route.ts` and the home page form call `bsb.signInWithPassword`. Supabase Auth runs the access-token hook, signs the session and sets the cookie. The password is `local-demo`, set in `supabase/seed.sql`.
- `src/lib/supabase/generated-schema.ts` (the server's schema), `generated.ts` (`clientSchema`), the `tables/` and `blocks/` modules and the `generated.*` metadata: `pnpm gen` regenerates them from the migrations; `pnpm gen:check` fails on drift.

## Verify instant navigation

```bash
pnpm --filter @permdock/example-next-better-supabase test:e2e
```

Needs Docker. Runs `serve` with `EXPOSE_TESTING_API=1` on `http://127.0.0.1:3589`, then runs `tests/instant/*.instant.ts` with `instant()` from `@next/playwright` at 1280 px and 390 px. The specs cover the initial load of `/en/acme/staff` and `/en/portal/acme/quotes` and the soft navigation from Staff to Quotes. `cold-then-warm.instant.ts` goes back from Quotes to Staff under the lock and expects the staff read time from the first visit. Under the lock each spec expects the shell and the skeleton, and expects the RLS-read list to be absent. Install Chromium once with `pnpm --filter @permdock/example-next-better-supabase exec playwright install chromium`.
