import { defineSupabase } from 'better-supabase';
import { createNext } from 'better-supabase/next';
import { createPostgres } from 'better-supabase/postgres';
import { supabaseClaims } from 'permdock/supabase';
import { z } from 'zod';

import { env } from '../env.ts';
import { schema } from './supabase/generated.ts';

/** The app's own claim (`supabase.hook.claims`); `supabaseClaims()` covers PermDock's. */
const appClaims = z.object({
  datetime_preferences: z
    .object({ time_zone: z.string(), hour_cycle: z.enum(['h12', 'h23']) })
    .optional(),
});

export const sb = defineSupabase(schema).claims(
  supabaseClaims().extend(appClaims),
);

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
