import type { Subject } from "../core/subject.ts";
import type { SupabasePrincipal, SupabaseSubjectOptions } from "./types.ts";

import { anonymousSubject } from "../core/subject.ts";
import { subjectFromSupabase } from "./subject.ts";

/**
 * The part of a supabase-js (or `@supabase/ssr`) client the subject reads:
 * `auth.getClaims()`, which verifies the token against the project's JWKS or
 * the Auth server.
 */
export type SupabaseClaimsClient = {
  readonly auth: {
    readonly getClaims: () => PromiseLike<{
      readonly data: { readonly claims: unknown } | null;
      readonly error: unknown;
    }>;
  };
};

/**
 * The subject of the session a Supabase client holds, for the `subject`
 * callback of any adapter behind `@supabase/ssr`. It calls `getClaims()` and
 * never `getSession()`, whose token is unverified. A missing session, an error
 * or a throwing client is the anonymous subject.
 */
export async function subjectFromSupabaseClient(
  client: SupabaseClaimsClient,
  options: SupabaseSubjectOptions = {},
): Promise<Subject<SupabasePrincipal>> {
  try {
    const { data, error } = await client.auth.getClaims();
    return subjectFromSupabase(
      error === null || error === undefined ? (data?.claims ?? null) : null,
      options,
    );
  } catch {
    return anonymousSubject();
  }
}
