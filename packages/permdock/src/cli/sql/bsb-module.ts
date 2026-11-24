const MODULE_HEADER =
  /^-- better-supabase module: [^\n]*\n(?:--[^\n]*\n)*?-- @bsb-hash sha256:/u;

/**
 * Whether `text` is a module file `better-supabase add` or `upgrade` writes and
 * manages through its `@bsb-hash` header; doctor checks the app's SQL, not it.
 */
export function isBetterSupabaseModule(text: string): boolean {
  return MODULE_HEADER.test(text);
}
