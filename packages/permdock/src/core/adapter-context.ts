import type { Actor } from "./subject.ts";

import { isActor } from "./subject.ts";

/**
 * The active tenant an adapter resolved from its own framework context.
 * Present means "use this tenant", even when `tenant` is `undefined`.
 */
export type TenantScope = { readonly tenant: string | undefined };

export type TenantOption<TContext> =
  | string
  | ((context: TContext) => string | undefined | Promise<string | undefined>);

/** Resolves an adapter `tenant` option against its framework context; a throw is no tenant. */
export async function tenantScope<TContext>(
  option: TenantOption<TContext> | undefined,
  context: TContext,
): Promise<TenantScope> {
  if (option === undefined || typeof option === "string") {
    return { tenant: option };
  }
  try {
    return { tenant: await option(context) };
  } catch {
    return { tenant: undefined };
  }
}

/** Resolves an adapter `actor` option; anything but an `Actor`, or a throw, is no actor. */
export async function actorFrom<TContext>(
  option: ((context: TContext) => unknown) | undefined,
  context: TContext,
): Promise<Actor | undefined> {
  if (option === undefined) {
    return undefined;
  }
  try {
    const resolved = await option(context);
    return isActor(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}
