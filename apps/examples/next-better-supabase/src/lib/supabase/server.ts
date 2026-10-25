import "server-only";
import { createNext } from "better-supabase/next";
import { createPostgres } from "better-supabase/postgres";
import { authorizer } from "permdock/better-supabase";

import { env } from "../../env.ts";
import { policy } from "../../policy.ts";
import { audience, betterSupabase, cookieName } from "./index.ts";

/**
 * Direct Postgres: `bsb.cached()` hands out `sql`, typed repositories that run
 * as the caller, so RLS applies.
 */
export const postgres = createPostgres({ connectionString: env.databaseUrl });

export const issuer = `${env.supabaseUrl}/auth/v1`;

export const bsb = createNext(betterSupabase, {
  env: {
    url: env.supabaseUrl,
    publishableKey: env.publishableKey,
    jwksUrl: new URL(`${issuer}/.well-known/jwks.json`),
  },
  postgres,
  authorizer: authorizer({ policy }),
  auth: {
    ...(env.verificationKeys && { jwks: env.verificationKeys }),
    issuer,
    audience,
    cookie: { name: cookieName },
  },
});
