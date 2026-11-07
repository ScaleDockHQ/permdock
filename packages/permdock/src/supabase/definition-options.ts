import type { SupabaseSubjectOptions } from "./types.ts";

/** Where the definition keeps its `subject` options, for the middleware entry. */
export const SUPABASE_OPTIONS: symbol = Symbol.for("permdock.supabase");

/** The `subject` options of a Supabase definition, or `undefined`. */
export function supabaseOptionsOf(
  policy: object,
): SupabaseSubjectOptions | undefined {
  const value: unknown = Reflect.get(policy, SUPABASE_OPTIONS);
  // SAFETY: definePermDock is the only writer of this symbol and stores the options it was given.
  return value === undefined ? undefined : (value as SupabaseSubjectOptions);
}
