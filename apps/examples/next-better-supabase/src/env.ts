import { z } from 'zod';

const Jwks = z.object({
  keys: z.array(z.looseObject({ kty: z.string() })),
});

const read = (name: string): string | undefined => process.env[name];

/**
 * Server settings. The defaults let `next build` run without a database; the
 * serve script sets every value for `next start`. Nothing here is public.
 */
export const env = {
  supabaseUrl: read('SUPABASE_URL') ?? 'http://127.0.0.1:54321',
  publishableKey: read('SUPABASE_PUBLISHABLE_KEY') ?? 'sb_publishable_example',
  /** The public JWKS the session token is verified against, inline: no fetch to Auth. */
  verificationKeys: Jwks.nullable().parse(
    JSON.parse(read('SUPABASE_JWKS') ?? 'null'),
  ),
  /** The pool connects on the first query, so the placeholder never reaches a socket during `next build`. */
  databaseUrl:
    read('DATABASE_URL') ?? 'postgres://postgres@127.0.0.1:5432/postgres',
  /** Only the e2e build mints sessions, with the private half of the JWKS key. */
  e2e: read('NEXT_E2E') === '1',
  signingKey: read('E2E_SIGNING_JWK'),
};
