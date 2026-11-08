import type { AuthEvent } from "./event-types.ts";
import type {
  MembershipSource,
  VersionContext,
  VersionQuery,
} from "./interfaces.ts";
import type { Policy } from "./policy-types.ts";
import type { Membership, Principal } from "./subject.ts";

import { compact } from "./compact.ts";
import { sourceName } from "./source-name.ts";
import { isThenable } from "./thenable.ts";

type Freshness = "fresh" | "reread" | "unknown";

export function versionQuery(
  principal: Principal,
  issuedAt: number | undefined,
): VersionQuery {
  return compact({
    id: principal.id,
    roles: principal.roles,
    memberships: principal.memberships,
    authzVersion: principal.authzVersion,
    customRolesVersion: principal.customRolesVersion,
    issuedAt,
  });
}

/** `known` when it is a version, otherwise the source's answer. */
function currentVersion(
  source: MembershipSource,
  query: VersionQuery,
  context: VersionContext,
  known: number | undefined,
): number | undefined | Promise<number | undefined> {
  return known !== undefined && Number.isSafeInteger(known) && known >= 0
    ? known
    : source.version?.(query, context);
}

function threw(source: MembershipSource, auth: AuthEvent[]): void {
  auth.push({
    reason: "source-threw",
    source: "memberships",
    ...sourceName(source),
  });
}

/** The custom-role version a token that holds a custom role is checked against. */
export type RolesVersionCheck = {
  readonly claimed: number;
  readonly read: () => number | undefined | Promise<number | undefined>;
};

/**
 * `onStale: 'reread'`: a token behind the source's version has its memberships
 * (and global roles, with `readRoles`) read live; a version that cannot be read
 * keeps the claims and marks the subject stale. With `rolesCheck`, a token
 * whose custom-role version is behind the tenant's is read live too, and one
 * whose tenant version cannot be read is read live as well, since its custom
 * roles may have changed.
 */
export function rereadStale(
  source: MembershipSource,
  principal: Principal,
  issuedAt: number | undefined,
  context: VersionContext,
  read: () => readonly Membership[] | Promise<readonly Membership[]>,
  auth: AuthEvent[],
  readRoles?: () => readonly string[] | Promise<readonly string[]>,
  known?: number,
  force = false,
  rolesCheck?: RolesVersionCheck,
): {
  readonly memberships: readonly Membership[] | Promise<readonly Membership[]>;
  readonly stale: boolean | Promise<boolean>;
  readonly roles?: readonly string[] | Promise<readonly string[] | undefined>;
} {
  const claims = principal.memberships ?? [];
  const claimed = principal.authzVersion;
  const judge = (
    current: number | undefined,
    currentRoles: number | undefined,
  ): Freshness =>
    force ||
    typeof claimed !== "number" ||
    current === undefined ||
    claimed < current ||
    (rolesCheck !== undefined &&
      (currentRoles === undefined || rolesCheck.claimed < currentRoles))
      ? "reread"
      : "fresh";
  const unknown = (): Freshness => {
    threw(source, auth);
    return force || rolesCheck !== undefined ? "reread" : "unknown";
  };
  let freshness: Freshness | Promise<Freshness>;
  try {
    const current = currentVersion(
      source,
      versionQuery(principal, issuedAt),
      context,
      known,
    );
    const currentRoles = rolesCheck?.read();
    freshness =
      isThenable(current) || isThenable(currentRoles)
        ? Promise.all([current, currentRoles]).then(
            ([version, roles]) => judge(version, roles),
            unknown,
          )
        : judge(current, currentRoles);
  } catch {
    freshness = unknown();
  }
  const failed = (): readonly string[] => {
    threw(source, auth);
    return [];
  };
  const rolesOf = (
    found: Freshness,
  ): readonly string[] | Promise<readonly string[] | undefined> | undefined => {
    if (found !== "reread" || readRoles === undefined) {
      return undefined;
    }
    try {
      const roles = readRoles();
      return isThenable(roles) ? Promise.resolve(roles).catch(failed) : roles;
    } catch {
      return failed();
    }
  };
  if (isThenable(freshness)) {
    const settled = freshness.then((found) => ({
      found,
      roles: rolesOf(found),
    }));
    return {
      memberships: settled.then(({ found }) =>
        found === "reread" ? read() : claims,
      ),
      stale: settled.then(({ found }) => found === "unknown"),
      roles: settled.then(({ roles }) => roles),
    };
  }
  return compact({
    memberships: freshness === "reread" ? read() : claims,
    stale: freshness === "unknown",
    roles: rolesOf(freshness),
  });
}

/**
 * Whether the token's memberships are behind the source for `fresh`
 * permissions. Live memberships are never stale; token memberships are stale
 * unless a source reports a version the token's `authzVersion` has reached.
 */
export function staleness(
  policy: Policy,
  principal: Principal | null,
  source: MembershipSource | undefined,
  given: {
    readonly live: boolean;
    readonly stale: boolean | Promise<boolean> | undefined;
    readonly issuedAt: number | undefined;
    readonly context: VersionContext;
    readonly known?: number | undefined;
  },
  auth: AuthEvent[],
): boolean | Promise<boolean> {
  if ((policy.fresh ?? []).length === 0 || principal === null || given.live) {
    return false;
  }
  if (given.stale !== undefined) {
    return given.stale;
  }
  const claimed = principal.authzVersion;
  if (source?.version === undefined || typeof claimed !== "number") {
    return true;
  }
  const compare = (current: number | undefined): boolean =>
    current === undefined || claimed < current;
  try {
    const current = currentVersion(
      source,
      versionQuery(principal, given.issuedAt),
      given.context,
      given.known,
    );
    return isThenable(current)
      ? Promise.resolve(current).then(compare, () => {
          threw(source, auth);
          return true;
        })
      : compare(current);
  } catch {
    threw(source, auth);
    return true;
  }
}
