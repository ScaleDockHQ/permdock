import type { TenantSlugResolver } from "../server/tenant-from-path.ts";

import { resolveTenantSlug } from "../server/tenant-from-path.ts";

export type NextTenantFromPathOptions = {
  /** The dynamic segment that holds the tenant slug: `org` for `app/orgs/[org]`. */
  readonly param: string;
  readonly resolve: TenantSlugResolver;
};

/** The `params` a Next.js page, layout or route handler receives. */
export type NextRouteParams = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

/**
 * Reads the tenant slug from a route's `params` and resolves it, for
 * `getPermDock({ tenant })`. The id becomes the active tenant only when the
 * subject holds a live membership there. A missing or catch-all segment, or a
 * slug that resolves to nothing, asks for a tenant no membership holds, so the
 * instance has no tenant instead of the factory's default.
 */
export function tenantFromPath(
  options: NextTenantFromPathOptions,
): (params: NextRouteParams | Promise<NextRouteParams>) => Promise<string> {
  return async (params) => {
    const slug = (await params)[options.param];
    return resolveTenantSlug(options.resolve, slug);
  };
}
