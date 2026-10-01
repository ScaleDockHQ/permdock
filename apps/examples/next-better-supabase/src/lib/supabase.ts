import { defineSupabase } from 'better-supabase';
import { createNext } from 'better-supabase/next';
import { createPostgres } from 'better-supabase/postgres';

import { env } from '../env.ts';
import { schema } from './supabase/generated.ts';

export const sb = defineSupabase(schema);

/** Direct Postgres: `next.cached()` hands out `sql`, typed repositories that run as the caller, so RLS applies. */
export const postgres = createPostgres({ connectionString: env.databaseUrl });

export const issuer = `${env.supabaseUrl}/auth/v1`;
export const audience = 'authenticated';
export const cookieName = 'sb-example-auth-token';

export const next = createNext(sb, {
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
