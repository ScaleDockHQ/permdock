import type { Condition } from "../conditions/ast.ts";
import type { Grantee } from "../core/grantee.ts";
import type { SnapshotSource } from "../core/interfaces.ts";
import type {
  LocalCustomRoleTable,
  LocalSnapshotManifest,
  Snapshot,
  SnapshotGrant,
} from "../core/snapshot-types.ts";
import type { CustomRole, Membership, Subject } from "../core/subject.ts";
import type { Instant } from "../core/time.ts";
import type {
  CustomAllow,
  HeldGrant,
  LocalCustomRole,
} from "./local-assignable.ts";

import { bindConditionRefs } from "../conditions/bind.ts";
import { compact } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";
import { flattenGrantee } from "../core/grantee.ts";
import { LOCAL_CUSTOM_ROLE } from "../core/local-role.ts";
import {
  normalizeMemberships,
  resolveScope,
  scopeList,
  tenantOf,
} from "../core/scopes.ts";
import { heldRoleNames } from "../core/snapshot-subject.ts";
import { isMembershipExpired, resolveActiveTenant } from "../core/tenancy.ts";
import { rfc3339, secondsAt } from "../core/time.ts";
import {
  entryReach,
  includeReach,
  localAssignableFor,
} from "./local-assignable.ts";

/** What the device holds for the signed-in user, read from its local database. */
export type LocalSnapshotData = {
  readonly principal: {
    readonly id: string;
    /** Global roles, declared or platform custom roles. */
    readonly roles?: readonly string[];
    readonly plans?: readonly string[];
    /** The active tenant: the first scope's instance the UI shows. */
    readonly tenant?: string;
    readonly memberships?: readonly Membership[];
    /**
     * Attributes conditions read, such as `claims` for
     * `principal.claims.team_ids`.
     */
    readonly attributes?: Readonly<Record<string, unknown>>;
  } | null;
  /** The tenant's custom roles, in the shape a `CustomRoleSource` returns. */
  readonly customRoles?: readonly CustomRole[];
};

export type LocalSnapshotOptions = {
  /** `localSnapshotManifest(policy)`, written at build time. */
  readonly manifest: LocalSnapshotManifest;
  readonly read: () => LocalSnapshotData | Promise<LocalSnapshotData>;
  /**
   * Calls the listener when the rows `read` reads change; returns the
   * unsubscribe.
   */
  readonly subscribe?: (listener: () => void) => () => void;
};

const CARRIED: ReadonlySet<string> = new Set([
  "id",
  "roles",
  "plans",
  "tenant",
  "memberships",
]);

function isClaimRef(ref: string): boolean {
  const [root, head] = ref.split(".", 2);
  return root === "principal" && !CARRIED.has(String(head));
}

function bindGrant(grant: SnapshotGrant, subject: Subject): SnapshotGrant {
  const bind = (condition: Condition | undefined): Condition | undefined =>
    condition === undefined
      ? undefined
      : bindConditionRefs(condition, subject, isClaimRef);
  return grant.where === undefined && grant.check === undefined
    ? grant
    : compact<SnapshotGrant>({
        ...grant,
        where: bind(grant.where),
        check: bind(grant.check),
      });
}

function renamed(grant: SnapshotGrant, name: string): SnapshotGrant {
  const to: Grantee[] = [];
  for (const item of flattenGrantee(grant.to)) {
    to.push(
      item.kind === "role" && item.role === LOCAL_CUSTOM_ROLE
        ? { kind: "role", role: name, scope: item.scope }
        : item,
    );
  }
  return { ...grant, role: name, to };
}

/**
 * The grants a custom role holds, from the entries the server resolved one by
 * one: an entry the table does not know grants nothing.
 */
function customGrants(
  table: LocalCustomRoleTable,
  role: CustomRole,
): {
  readonly grants: readonly SnapshotGrant[];
  readonly allows: readonly CustomAllow[];
} {
  const entries: readonly unknown[] = Array.isArray(role.grants)
    ? role.grants
    : [];
  const removed = new Set<string>();
  const allows: { readonly key: string; readonly level?: unknown }[] = [];
  for (const item of entries) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const entry: ReadonlyMap<string, unknown> = new Map(Object.entries(item));
    const key = entry.get("permission");
    if (typeof key !== "string") {
      continue;
    }
    const effect = entry.get("effect") ?? "allow";
    const level = entry.get("level");
    const known = [...entry.keys()].every(
      (name) => name === "permission" || name === "effect" || name === "level",
    );
    const row = Object.hasOwn(table.permissions, key)
      ? table.permissions[key]
      : undefined;
    const unknownLevel =
      level !== undefined &&
      (typeof level !== "string" ||
        row?.levels === undefined ||
        !Object.hasOwn(row.levels, level));
    if (!known || effect !== "allow" || (unknownLevel && row !== undefined)) {
      removed.add(key);
      continue;
    }
    allows.push({ key, level });
  }
  const out: SnapshotGrant[] = [];
  const reached: CustomAllow[] = [];
  const included = new Set<string>();
  const names: readonly unknown[] = Array.isArray(role.includes)
    ? role.includes
    : [];
  for (const name of names) {
    const list =
      typeof name === "string" && Object.hasOwn(table.includes, name)
        ? table.includes[name]
        : undefined;
    for (const grant of list ?? []) {
      if (grant.effect === "deny" || !removed.has(grant.permission)) {
        out.push(grant);
      }
      if (grant.effect === "allow") {
        included.add(grant.permission);
        if (!removed.has(grant.permission) && typeof name === "string") {
          reached.push({
            key: grant.permission,
            reach: includeReach(table, name, grant.permission),
          });
        }
      }
    }
  }
  for (const { key, level } of allows) {
    if (removed.has(key) || included.has(key)) {
      continue;
    }
    const row = Object.hasOwn(table.permissions, key)
      ? table.permissions[key]
      : undefined;
    const grants = typeof level === "string" ? row?.levels?.[level] : row?.all;
    if (grants !== undefined && grants.length > 0) {
      out.push(...grants);
      reached.push({
        key,
        reach: entryReach(
          table,
          key,
          typeof level === "string" ? level : undefined,
        ),
      });
    }
  }
  return {
    grants: out.map((grant) => renamed(grant, role.name)),
    allows: reached,
  };
}

function isList(value: unknown): boolean {
  return Array.isArray(value);
}

function customScope(
  role: CustomRole,
  scopes: ReturnType<typeof scopeList>,
): string | undefined {
  if (role.scope === "global") {
    return role.shared === true ? undefined : "global";
  }
  if (role.scope !== undefined) {
    return resolveScope(scopes, role.scope);
  }
  return role.team === undefined ? scopes[0]?.name : scopes[1]?.name;
}

/**
 * The snapshot a server would send for `data`, built from the manifest. It
 * drives UI guards only: the server still decides every request.
 */
export function buildLocalSnapshot(
  manifest: LocalSnapshotManifest,
  data: LocalSnapshotData,
  at?: Instant,
): Snapshot {
  const now = secondsAt(at);
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    manifest.v !== 1 ||
    !isList(manifest.grants)
  ) {
    throw new Error("PermDock: unsupported local snapshot manifest");
  }
  const scopes = scopeList(manifest.scopes);
  const input = data.principal;
  const memberships =
    input === null ? [] : normalizeMemberships(input.memberships, scopes);
  const tenant =
    input === null
      ? undefined
      : resolveActiveTenant(
          { id: input.id, memberships },
          input.tenant,
          scopes,
          now,
        );
  const principal =
    input === null
      ? null
      : compact<NonNullable<Snapshot["subject"]["principal"]>>({
          id: input.id,
          roles: input.roles ?? [],
          plans: input.plans,
          tenant,
          memberships,
        });
  const subject: Subject = {
    principal:
      principal === null ? null : { ...input?.attributes, ...principal },
    context: {},
  };
  const declared = new Set(manifest.roles);
  const globalRoles = new Set(input?.roles ?? []);
  const grants: SnapshotGrant[] = [];
  const held: HeldGrant[] = [];
  const attach = (
    grant: SnapshotGrant,
    membership?: Membership,
    reach?: readonly string[],
  ): void => {
    const bound = bindGrant(
      membership === undefined ? grant : { ...grant, membership },
      subject,
    );
    grants.push(bound);
    if (
      membership === undefined ||
      (tenantOf(membership, scopes) === tenant &&
        !isMembershipExpired(membership, now))
    ) {
      held.push({ grant: bound, reach });
    }
  };
  const grantReach = manifest.assignable?.grants;
  for (const [index, grant] of manifest.grants.entries()) {
    const reach =
      grantReach !== undefined && Object.hasOwn(grantReach, String(index))
        ? grantReach[String(index)]
        : undefined;
    const roleItems = flattenGrantee(grant.to).filter(
      (item) => item.kind === "role",
    );
    if (roleItems.length > 0 && principal === null) {
      continue;
    }
    if (
      !roleItems.every(
        (item) =>
          item.scope !== "global" ||
          (declared.has(item.role) && globalRoles.has(item.role)),
      )
    ) {
      continue;
    }
    const scoped = roleItems.filter((item) => item.scope !== "global");
    if (scoped.length === 0) {
      attach(grant, undefined, reach);
      continue;
    }
    for (const membership of memberships) {
      if (
        scoped.every(
          (item) =>
            declared.has(item.role) &&
            membership.roles.includes(item.role) &&
            (typeof item.scope === "string"
              ? membership.scope === item.scope
              : membership.on !== undefined),
        )
      ) {
        attach(grant, membership, reach);
      }
    }
  }
  const formed = (data.customRoles ?? []).filter(
    (role) =>
      role !== null &&
      typeof role === "object" &&
      typeof role.name === "string" &&
      !declared.has(role.name),
  );
  const sharedNames = new Set(
    formed.filter((role) => role.shared === true).map((role) => role.name),
  );
  const custom = formed.filter(
    (role) =>
      role.shared === true ||
      role.scope === "global" ||
      !sharedNames.has(role.name),
  );
  const tenantCustom: LocalCustomRole[] = [];
  const tenantRoles = new Set<string>();
  for (const role of custom) {
    const scope = customScope(role, scopes);
    const table =
      scope !== undefined && Object.hasOwn(manifest.custom, scope)
        ? manifest.custom[scope]
        : undefined;
    if (scope === undefined || table === undefined) {
      continue;
    }
    const { grants: resolved, allows } = customGrants(table, role);
    const reachOf = (permission: string): readonly string[] | undefined => [
      ...new Set(
        allows
          .filter((allow) => allow.key === permission)
          .flatMap((allow) => allow.reach ?? []),
      ),
    ];
    if (scope === "global") {
      if (role.tenant === undefined && globalRoles.has(role.name)) {
        for (const grant of resolved) {
          attach(grant, undefined, reachOf(grant.permission));
        }
      }
      continue;
    }
    if (
      tenant !== undefined &&
      (role.shared === true
        ? role.tenant === undefined
        : role.tenant === tenant) &&
      !tenantRoles.has(role.name)
    ) {
      tenantRoles.add(role.name);
      tenantCustom.push({
        name: role.name,
        scope,
        shared: role.shared === true,
        allows,
      });
    }
    const id = role.team ?? role.id;
    for (const membership of memberships) {
      if (
        membership.scope === scope &&
        (role.shared === true
          ? role.tenant === undefined &&
            id === undefined &&
            tenantOf(membership, scopes) !== undefined
          : typeof role.tenant === "string" &&
            tenantOf(membership, scopes) === role.tenant) &&
        (id === undefined || membership.id === id) &&
        membership.roles.includes(role.name)
      ) {
        for (const grant of resolved) {
          attach(grant, membership, reachOf(grant.permission));
        }
      }
    }
  }
  const roles =
    subject.principal === null
      ? []
      : heldRoleNames(
          subject,
          tenant,
          scopes,
          { rank: manifest.rank ?? [] },
          now,
        );
  const rules = manifest.assignable;
  return freezeDeep(
    compact<Snapshot>({
      v: 1 as const,
      issuedAt: rfc3339(now),
      subject: { principal, context: {} },
      roles,
      grants,
      tenants: tenant === undefined ? [] : [tenant],
      assignable:
        tenant === undefined || rules === undefined
          ? undefined
          : [
              localAssignableFor({
                rules,
                custom: manifest.custom,
                tenant,
                heldNames: roles,
                held,
                customRoles: tenantCustom,
              }),
            ],
      scopes: manifest.scopes,
      vocabulary: manifest.vocabulary,
    }),
  );
}

/**
 * A snapshot source over the device's own membership rows (SQLite, a PowerSync
 * or Electric replica): offline, the UI guards answer from them.
 */
export function localSnapshot(options: LocalSnapshotOptions): SnapshotSource {
  return compact<SnapshotSource>({
    get: async () => buildLocalSnapshot(options.manifest, await options.read()),
    subscribe: options.subscribe,
  });
}
