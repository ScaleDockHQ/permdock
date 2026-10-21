import type { Decision } from "../core/decision.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { DecideOptions, PermDock } from "../core/permdock.ts";
import type { Permission, PermissionTree } from "../core/permission-types.ts";
import type { Policy } from "../core/policy-types.ts";
import type { Actor, Delegation, Principal } from "../core/subject.ts";
import type { AuthzenEntity, AuthzenItem } from "./map.ts";
import type { AuthzenSubjectRecord } from "./types.ts";

import { buildInstance } from "../core/build-instance.ts";
import { compact } from "../core/compact.ts";
import { listPermissions } from "../core/permission-registry.ts";
import { permissionLookup } from "../server/evaluation-items.ts";
import { permissionOf, resourceData, userFromEntity } from "./map.ts";

/** One `search/action` result. */
export type AuthzenAction = { readonly name: string };

/** One `search/subject` result. */
export type AuthzenSubject = { readonly type: "user"; readonly id: string };

/**
 * What `search/subject` asks a lister for: candidates of `type` for one action
 * on one resource.
 */
export type AuthzenSubjectQuery = {
  readonly type: string;
  readonly action: AuthzenEntity;
  readonly resource: AuthzenEntity;
  readonly context?: unknown;
};

/**
 * The principals a policy decision point may answer `search/subject` with, the
 * way `AuthzenResourceAdapter.list` supplies rows. Each record is decided as `{
 * type: "user", id, properties }`; only candidates that are granted are
 * returned, so a lister may answer a superset.
 */
export type AuthzenSubjectLister = {
  readonly name?: string;
  readonly list: (
    query: AuthzenSubjectQuery,
  ) =>
    | readonly AuthzenSubjectRecord[]
    | Promise<readonly AuthzenSubjectRecord[]>;
};

export type AuthzenSearchOptions = InstanceOptions & {
  readonly tenant?: string;
  readonly actor?: Actor;
  readonly delegation?: Delegation;
};

export type SearchActionsOptions = AuthzenSearchOptions & {
  /**
   * The row the server loaded for `resource`, trusted. Without it the
   * resource's `properties` (or `{ id }`) are boundary-validated.
   */
  readonly data?: unknown;
};

/** The one `decide` call every AuthZEN evaluation and search makes. */
export function decideAuthzen(
  permdock: PermDock,
  permission: Permission,
  data: unknown,
  trusted: boolean,
): Decision {
  // SAFETY: decide's instance and collection overloads share one implementation that takes either kind.
  const decide = permdock.decide as (
    next: Permission,
    row?: unknown,
    options?: DecideOptions,
  ) => Decision;
  return decide(
    permission,
    data,
    trusted
      ? { call: "endpoint", adapter: "authzen", trusted: true }
      : {
          call: "endpoint",
          adapter: "authzen",
          trusted: false,
          boundary: "decision-endpoint",
        },
  );
}

/** Every permission of resource type `type`, in catalog order. */
export function permissionsOfType(
  tree: PermissionTree,
  type: string,
): readonly Permission[] {
  return listPermissions(tree).filter((leaf) => leaf.resource === type);
}

/** The distinct actions of the granted `leaves`, in catalog order. */
export async function grantedActions(
  leaves: readonly Permission[],
  decide: (leaf: Permission) => Decision | Promise<Decision>,
): Promise<readonly AuthzenAction[]> {
  const decisions = await Promise.all(
    leaves.map(async (leaf) => ({ leaf, decision: await decide(leaf) })),
  );
  const names: string[] = [];
  for (const { leaf, decision } of decisions) {
    if (decision.outcome === "granted" && !names.includes(leaf.action)) {
      names.push(leaf.action);
    }
  }
  return names.map((name) => ({ name }));
}

/** The granted ids among `records`; any subject type but `user` matches none. */
export async function grantedSubjects(
  type: unknown,
  records: readonly AuthzenSubjectRecord[],
  decide: (subject: AuthzenEntity) => Promise<Decision>,
): Promise<readonly AuthzenSubject[]> {
  if (typeof type === "string" && type !== "user") {
    return [];
  }
  const decisions = await Promise.all(
    records.map(async (record) => {
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (key !== "id") {
          properties[key] = value;
        }
      }
      return {
        id: record.id,
        decision: await decide({ type: "user", id: record.id, properties }),
      };
    }),
  );
  return decisions.flatMap(({ id, decision }) =>
    decision.outcome === "granted" ? [{ type: "user" as const, id }] : [],
  );
}

function scopeOf(options: AuthzenSearchOptions): {
  readonly tenant: string | undefined;
  readonly actor: Actor | undefined;
  readonly delegation: Delegation | undefined;
} {
  return {
    tenant: options.tenant,
    actor: options.actor,
    delegation: options.delegation,
  };
}

/**
 * The AuthZEN `search/action` answer for `user` on `resource`: every permission
 * of `resource.type` in the policy is decided, and the distinct actions of the
 * granted ones are returned in catalog order. Paging is the caller's
 * (`authzenPage`).
 */
export async function searchActions<
  TUser,
  TPrincipal extends Principal = Principal,
>(
  policy: Policy<TUser, TPrincipal>,
  user: TUser,
  resource: AuthzenEntity & { readonly type: string },
  options: SearchActionsOptions = {},
): Promise<readonly AuthzenAction[]> {
  const { permdock } = await buildInstance({
    policy,
    user,
    sources: options,
    scope: scopeOf(options),
  });
  const trusted = "data" in options;
  const data = trusted ? options.data : resourceData({ resource });
  return grantedActions(
    permissionsOfType(policy.permissions, resource.type),
    (leaf) => decideAuthzen(permdock, leaf, data, trusted),
  );
}

/**
 * The AuthZEN `search/subject` answer: the candidates `lister` returns for
 * `request`, each decided as itself, filtered to those granted `action` on
 * `resource`. An unknown action, a subject type other than `user`, or a lister
 * that throws answers none.
 */
export async function searchSubjects<
  TUser,
  TPrincipal extends Principal = Principal,
>(
  policy: Policy<TUser, TPrincipal>,
  lister: AuthzenSubjectLister,
  request: AuthzenItem & {
    readonly subject: { readonly type: string };
    readonly action: AuthzenEntity;
    readonly resource: AuthzenEntity;
  },
  options: AuthzenSearchOptions = {},
): Promise<readonly AuthzenSubject[]> {
  const permission = permissionOf(
    permissionLookup(policy.permissions),
    request,
  );
  if (permission === undefined) {
    return [];
  }
  let records: readonly AuthzenSubjectRecord[];
  try {
    records = await lister.list(
      compact<AuthzenSubjectQuery>({
        type: request.subject.type,
        action: request.action,
        resource: request.resource,
        context: request.context,
      }),
    );
  } catch {
    return [];
  }
  const data = resourceData(request);
  return grantedSubjects(request.subject.type, records, async (subject) => {
    const { permdock } = await buildInstance({
      policy,
      // SAFETY: a lister's record is the user object the policy maps, keyed by `id`.
      user: userFromEntity(subject) as TUser | null,
      sources: options,
      scope: scopeOf(options),
    });
    return decideAuthzen(permdock, permission, data, false);
  });
}
