import type { Subject } from "../core/subject.ts";
import type {
  SupabasePrincipal,
  SupabaseSessionLike,
  SupabaseSubjectOptions,
} from "../supabase/types.ts";

import { subjectFromSupabaseSession } from "../supabase/subject.ts";

/**
 * `subjectFromSupabaseSession` for better-supabase's `AuthSession`, reading
 * `memberships` for the memberships and the entitlements module's `features`
 * claim for `principal.plans`. Options override those defaults.
 */
export function subjectFromBetterSupabase(
  session: SupabaseSessionLike | null | undefined,
  options: SupabaseSubjectOptions = {},
): Subject<SupabasePrincipal> {
  return subjectFromSupabaseSession(session, {
    memberships: "memberships",
    plans: "features",
    ...options,
  });
}
