import type { MemberEntry, MembershipSource } from "./interfaces.ts";
import type { Membership } from "./subject.ts";

import { byCodePoint } from "./compare.ts";
import { isThenable } from "./thenable.ts";

/** Two memberships are the same row when everything but `roles` matches. */
function identity(membership: Membership): string {
  const within = Object.entries(membership.within ?? {}).toSorted(([a], [b]) =>
    byCodePoint(a, b),
  );
  return JSON.stringify([
    membership.scope ?? null,
    membership.id ?? null,
    within,
    membership.on ?? null,
    membership.tenant ?? null,
    membership.team ?? null,
    membership.via ?? null,
    membership.expiresAt ?? null,
    membership.grantedBy ?? null,
    membership.reason ?? null,
    membership.member?.group ?? null,
    [...(membership.eligible ?? [])].toSorted(),
    membership.managedBy ?? null,
    [...(membership.entitlements ?? [])].toSorted(),
  ]);
}

/**
 * Merges memberships from several sources: entries naming the same instance
 * with the same `via`, expiry, owner and seats become one entry with the union
 * of their roles. Entries that differ in any of those stay separate, so a
 * staff role and a contact role in one instance keep their own `via`.
 */
export function mergeMemberships(
  lists: readonly (readonly Membership[])[],
): Membership[] {
  const merged = new Map<string, Membership>();
  for (const list of lists) {
    for (const membership of list) {
      const key = identity(membership);
      const found = merged.get(key);
      merged.set(
        key,
        found === undefined
          ? membership
          : {
              ...found,
              roles: [...new Set([...found.roles, ...membership.roles])],
            },
      );
    }
  }
  return [...merged.values()];
}

function all<T>(
  values: readonly (T | Promise<T>)[],
): readonly T[] | Promise<readonly T[]> {
  // SAFETY: the second branch runs only when no value is a thenable, so each one is a T.
  return values.some((value) => isThenable(value))
    ? Promise.all(values)
    : (values as readonly T[]);
}

function then<T, R>(
  value: T | Promise<T>,
  next: (resolved: T) => R,
): R | Promise<R> {
  return isThenable(value) ? Promise.resolve(value).then(next) : next(value);
}

/**
 * One `MembershipSource` over several: memberships are merged and
 * de-duplicated, `list` concatenates the sources that can list, and `version`
 * is the highest version any source reports. A source that throws makes the
 * whole lookup throw, which the subject resolver turns into no memberships.
 */
export function composeMemberships(
  sources: readonly MembershipSource[],
): MembershipSource {
  const listing = sources.filter((source) => source.list !== undefined);
  const versioned = sources.filter((source) => source.version !== undefined);
  return {
    membershipsFor(principal, options) {
      return then(
        all(sources.map((source) => source.membershipsFor(principal, options))),
        (lists) => mergeMemberships(lists),
      );
    },
    ...(listing.length === 0
      ? {}
      : {
          list(query) {
            return then(
              all(listing.map((source) => source.list?.(query) ?? [])),
              (lists) => {
                const seen = new Map<string, MemberEntry>();
                for (const entry of lists.flat()) {
                  const key = `${entry.principal.id}\u0000${identity(entry.membership)}`;
                  const found = seen.get(key);
                  seen.set(
                    key,
                    found === undefined
                      ? entry
                      : {
                          principal: entry.principal,
                          membership: {
                            ...found.membership,
                            roles: [
                              ...new Set([
                                ...found.membership.roles,
                                ...entry.membership.roles,
                              ]),
                            ],
                          },
                        },
                  );
                }
                return [...seen.values()];
              },
            );
          },
        }),
    ...(versioned.length === 0
      ? {}
      : {
          version(principal) {
            return then(
              all(versioned.map((source) => source.version?.(principal))),
              (versions) => {
                const known = versions.filter(
                  (value): value is number =>
                    typeof value === "number" && Number.isFinite(value),
                );
                return known.length === 0 ? undefined : Math.max(...known);
              },
            );
          },
        }),
  };
}

/** A single source, or several composed. */
export function asMembershipSource(
  input: MembershipSource | readonly MembershipSource[],
): MembershipSource {
  // SAFETY: Array.isArray does not narrow a readonly array out of the union; not an array here.
  return Array.isArray(input)
    ? composeMemberships(input)
    : (input as MembershipSource);
}

/**
 * Trust the memberships the verified token carries, and read `source` only
 * when the token marks them truncated. With `version`, a token minted before
 * the latest membership change is stale for the policy's `fresh` permissions.
 */
export function claimsFirst(
  source: MembershipSource | readonly MembershipSource[],
  options: {
    readonly version?: MembershipSource["version"];
  } = {},
): MembershipSource {
  const inner = asMembershipSource(source);
  const version =
    options.version ??
    (inner.version === undefined
      ? undefined
      : (principal: {
          readonly id: string;
        }): ReturnType<NonNullable<MembershipSource["version"]>> | undefined =>
          inner.version?.(principal));
  return {
    membershipsFor: (principal, query) =>
      inner.membershipsFor(principal, query),
    ...(inner.list === undefined
      ? {}
      : { list: (query) => inner.list?.(query) ?? [] }),
    ...(version === undefined ? {} : { version }),
    claimsFirst: true,
  };
}

/** Whether the identity provider owns `membership`: the application must not add, change or remove it. */
export function isExternallyManaged(membership: Membership): boolean {
  return membership.managedBy === "idp";
}

/**
 * How many principals hold `role` in one scope instance now, from the
 * source's member list (`MembershipSource.list`): live memberships of exactly
 * that scope and instance, each principal counted once. The `holders` a
 * `decideRoleChange` with `min`, `max` or `transferOnly` needs. `undefined`
 * when the source cannot list or the read fails, which that check denies.
 */
export async function countHolders(
  source: MembershipSource | readonly MembershipSource[],
  query: {
    readonly scope: string;
    readonly id: string;
    readonly role: string | { readonly key: string };
  },
): Promise<number | undefined> {
  const composed = asMembershipSource(source);
  if (composed.list === undefined) {
    return undefined;
  }
  const role = typeof query.role === "string" ? query.role : query.role.key;
  try {
    const entries = await composed.list({ scope: query.scope, id: query.id });
    const now = Math.floor(Date.now() / 1000);
    const holders = new Set<string>();
    for (const entry of entries) {
      const membership = entry.membership;
      if (
        membership.scope === query.scope &&
        membership.id === query.id &&
        membership.roles.includes(role) &&
        (membership.expiresAt === undefined || membership.expiresAt > now)
      ) {
        holders.add(entry.principal.id);
      }
    }
    return holders.size;
  } catch {
    return undefined;
  }
}
