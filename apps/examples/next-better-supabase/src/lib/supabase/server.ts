import "server-only";
import { createNext } from "better-supabase/next";
import { createPostgres } from "better-supabase/postgres";
import { claimsFirst, memoryVersionCache } from "permdock";
import { authorizer } from "permdock/better-supabase";
import { authzVersion, supabasePostgresQuery } from "permdock/supabase";

import { env } from "../../env.ts";
import { policy } from "../../policy.ts";
import { sources } from "../../sources.ts";
import { audience, betterSupabase, cookieName } from "./index.ts";

/**
 * Direct Postgres: `bsb.cached()` hands out `sql`, typed repositories that run
 * as the caller, so RLS applies.
 */
export const postgres = createPostgres({ connectionString: env.databaseUrl });

export const issuer = `${env.supabaseUrl}/auth/v1`;

/**
 * Created once per process: the membership sources a stale token is re-read
 * from, and the version cache `bsb.invalidateSession` evicts. A read check
 * answers from the cache within `maxStaleMs`; a write check reads live.
 */
const query = supabasePostgresQuery(postgres.admin);
export const memberships = sources({ query });
export const versions = memoryVersionCache({ maxStaleMs: 5_000 });
const version = authzVersion({ query });

/** The same sources and cache for server code outside the authorizer. */
export const freshMemberships = claimsFirst(memberships, {
  onStale: "reread",
  version,
  versions,
});

export const bsb = createNext(betterSupabase, {
  env: {
    url: env.supabaseUrl,
    publishableKey: env.publishableKey,
    jwksUrl: new URL(`${issuer}/.well-known/jwks.json`),
  },
  postgres,
  versions,
  authorizer: authorizer({ policy, memberships, version }),
  auth: {
    ...(env.verificationKeys && { jwks: env.verificationKeys }),
    issuer,
    audience,
    cookie: { name: cookieName },
  },
});
