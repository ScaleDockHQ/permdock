/**
 * The server topic the generated version trigger broadcasts on without
 * better-supabase; no user may join it. With better-supabase it is
 * `better_supabase:authz`.
 */
export const AUTHZ_TOPIC = "permdock:authz";

/** The broadcast event of a version bump, as better-supabase names it. */
export const AUTHZ_EVENT = "changed";

/** The private topic one user receives their own version bumps on. */
export function authzUserTopic(userId: string): string {
  return `authz:${userId}`;
}
