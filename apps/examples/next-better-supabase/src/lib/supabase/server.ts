import "server-only";
import { createNext } from "better-supabase/next";
import { createPostgres } from "better-supabase/postgres";

import { env } from "../../env.ts";
import { audience, betterSupabase, cookieName } from "./index.ts";

/** Direct Postgres: `bs.cached()` hands out `sql`, typed repositories that run as the caller, so RLS applies. */
export const postgres = createPostgres({ connectionString: env.databaseUrl });

export const issuer = `${env.supabaseUrl}/auth/v1`;

export const bs = createNext(betterSupabase, {
  env: {
    url: env.supabaseUrl,
    publishableKey: env.publishableKey,
    jwksUrl: new URL(`${issuer}/.well-known/jwks.json`),
  },
  postgres,
  auth: {
    jwks: env.verificationKeys,
    issuer,
    audience,
    cookie: { name: cookieName },
  },
});
