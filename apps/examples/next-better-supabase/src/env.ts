import { z } from "zod";

const Jwks = z.object({ keys: z.array(z.looseObject({ kty: z.string() })) });

const read = (name: string): string | undefined => process.env[name];

const jwks = read("SUPABASE_JWKS");

const LatencyMs = z.coerce.number().int().nonnegative();

function latencyMs(raw = ""): number {
  const parsed = LatencyMs.safeParse(raw);
  return raw.trim() !== "" && parsed.success ? parsed.data : 3000;
}

/**
 * Server settings. The defaults let `next build` run without a database; the
 * serve script sets every value for `next start`. Nothing here is public.
 */
export const env = {
  supabaseUrl: read("SUPABASE_URL") ?? "http://127.0.0.1:54321",
  publishableKey: read("SUPABASE_PUBLISHABLE_KEY") ?? "sb_publishable_example",
  /**
   * The public JWKS the session token is verified against, inline: no fetch to
   * Auth. Unset stays `undefined` so better-supabase fetches `jwksUrl`; `null`
   * would verify against no keys.
   */
  verificationKeys:
    jwks === undefined ? undefined : Jwks.parse(JSON.parse(jwks)),
  /**
   * The pool connects on the first query, so the placeholder never reaches a
   * socket during `next build`.
   */
  databaseUrl:
    read("DATABASE_URL") ?? "postgres://postgres@127.0.0.1:5432/postgres",
  /**
   * Private key for share-link capability tokens. Session tokens are signed by
   * Supabase Auth and verified with `verificationKeys`.
   */
  signingKey: read("DEMO_SIGNING_JWK"),
  /** Milliseconds every cached read waits; `0` turns the delay off. */
  latencyMs: latencyMs(read("DEMO_LATENCY_MS")),
  /**
   * Set only by `scripts/measure.ts`. Turns on per-request database counts and
   * the measurement routes. A normal build leaves both off.
   */
  measure: read("MEASURE") === "1",
  /**
   * Set by a measurement build that turns one feature off: `proxy`,
   * `may-access`, `shared-cache` or `warm`. A normal build leaves it empty.
   */
  without: read("MEASURE_WITHOUT") ?? "",
};
