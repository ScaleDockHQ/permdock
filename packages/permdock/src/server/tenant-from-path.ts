import { isId } from "../core/ids.ts";

/**
 * Looks up the tenant id a URL slug names, from the application's own store.
 * `null`, `undefined`, a value that is not an id, or a throw is no tenant.
 */
export type TenantSlugResolver = (
  slug: string,
) => string | null | undefined | Promise<string | null | undefined>;

export type TenantFromPathOptions = {
  /**
   * The path template, such as `/orgs/:org`. A request path that starts with
   * its segments is a tenant route; any other path leaves the tenant option
   * unset.
   */
  readonly path: string;
  /** The template parameter that holds the tenant slug, `org` above. */
  readonly param: string;
  readonly resolve: TenantSlugResolver;
};

/**
 * The tenant a tenant route asks for when its slug resolves to nothing: an id
 * no membership holds, so the instance has no tenant and never falls back to
 * the token's active tenant. A NUL is not valid in a Postgres `text` or
 * `uuid`.
 */
export const UNRESOLVED_TENANT = "\u0000permdock:unresolved-tenant";

/** The resolved tenant id, or `UNRESOLVED_TENANT`; it never throws. */
export async function resolveTenantSlug(
  resolve: TenantSlugResolver,
  slug: unknown,
): Promise<string> {
  if (!isId(slug)) {
    return UNRESOLVED_TENANT;
  }
  try {
    const id = await resolve(slug);
    return isId(id) ? id : UNRESOLVED_TENANT;
  } catch {
    return UNRESOLVED_TENANT;
  }
}

function segmentsOf(path: string): readonly string[] {
  return path.split("/").slice(1);
}

/**
 * A matcher for `path`: the raw `param` segment of a matching pathname,
 * `undefined` for a pathname outside the template. Throws on a template that
 * names `param` other than exactly once, at setup.
 */
export function pathParam(
  path: string,
  param: string,
): (pathname: string) => string | undefined {
  const template = segmentsOf(path);
  const at = template.indexOf(`:${param}`);
  if (
    !path.startsWith("/") ||
    param === "" ||
    at === -1 ||
    template.lastIndexOf(`:${param}`) !== at
  ) {
    throw new TypeError(
      `PermDock: tenantFromPath needs a path starting with "/" that names :${param} once`,
    );
  }
  const literal = template.map((segment) =>
    segment.startsWith(":") ? undefined : segment,
  );
  return (pathname) => {
    const segments = segmentsOf(pathname);
    if (
      segments.length < template.length ||
      literal.some(
        (segment, index) =>
          segment !== undefined && segments[index] !== segment,
      )
    ) {
      return undefined;
    }
    return segments[at] ?? "";
  };
}

function decoded(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * The `permdock/server` `tenant` option for a tenant in the URL path. The id
 * `resolve` answers becomes the active tenant only when the subject holds a
 * live membership there; otherwise, and for a slug that resolves to nothing,
 * the instance has no tenant and tenant checks deny with `no-membership`.
 * `resolve` runs once per request.
 */
export function tenantFromPath(
  options: TenantFromPathOptions,
): (request: Request) => Promise<string | undefined> {
  const match = pathParam(options.path, options.param);
  const resolved = new WeakMap<Request, Promise<string | undefined>>();
  return (request) => {
    const known = resolved.get(request);
    if (known !== undefined) {
      return known;
    }
    const segment = match(new URL(request.url).pathname);
    const found =
      segment === undefined
        ? Promise.resolve(undefined)
        : resolveTenantSlug(options.resolve, decoded(segment));
    resolved.set(request, found);
    return found;
  };
}
