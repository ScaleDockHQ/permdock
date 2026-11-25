import type { Permission } from "./permission-types.ts";
import type { Grant, PolicyVocabulary } from "./policy-types.ts";
import type { SnapshotGrantItem } from "./snapshot-grants.ts";
import type { KeyHolding } from "./snapshot-requires.ts";
import type {
  ExpandedSnapshot,
  Snapshot,
  SnapshotAssignable,
  SnapshotGrant,
  SnapshotNotEntitled,
  SnapshotRequires,
  SnapshotTenants,
} from "./snapshot-types.ts";
import type { Delegation, Membership, Subject } from "./subject.ts";
import type { Plan, Role } from "./vocabulary.ts";

import { bindConditionRefs } from "../conditions/bind.ts";
import { compact } from "./compact.ts";
import { freezeDeep } from "./freeze.ts";
import { isForbiddenKey } from "./paths.ts";
import { scopeList, tenantOf } from "./scopes.ts";
import { checkHeader, expandGrants } from "./snapshot-compact.ts";
import { requiresTable } from "./snapshot-requires.ts";
import { tenantsOf } from "./tenancy.ts";
import { isRfc3339, nowSeconds, rfc3339 } from "./time.ts";
import { wireValidity } from "./validity.ts";
import { listPlans, listRoles } from "./vocabulary.ts";
import { toWireDelegation } from "./wire-delegation.ts";

export function plainPermission(leaf: Permission): Permission {
  return {
    key: leaf.key,
    scope: leaf.scope,
    resource: leaf.resource,
    action: leaf.action,
    meta: leaf.meta,
    kind: leaf.kind,
  };
}

function plainRole(leaf: Role): Role {
  return compact<Role>({
    key: leaf.key,
    on: leaf.on,
    assignable: leaf.assignable,
    meta: leaf.meta,
    kind: leaf.kind,
  });
}

function plainPlan(leaf: Plan): Plan {
  return { key: leaf.key, meta: leaf.meta, kind: leaf.kind };
}

export function snapshotGrant(
  grant: Grant,
  membership: Membership | undefined,
  requires?: SnapshotRequires,
): SnapshotGrant {
  const scope =
    grant.scope === "global"
      ? undefined
      : typeof grant.scope === "string"
        ? grant.scope
        : { resource: grant.scope.resource };
  const entry = compact<SnapshotGrant>({
    permission: grant.permission.key,
    effect: grant.effect,
    role: grant.role,
    to: grant.to,
    where: grant.portable ? grant.where : undefined,
    check: grant.portable ? grant.check : undefined,
    approval: grant.approval,
    scope,
    membership,
    requires: grant.portable ? requires : undefined,
    portable: grant.portable ? undefined : false,
    fields: grant.fields,
    validity: wireValidity(grant.validity),
    name: grant.name,
    meta: grant.meta,
    obligations: grant.obligations,
  });
  return freezeDeep(entry);
}

const CARRIED: ReadonlySet<string> = new Set([
  "id",
  "roles",
  "plans",
  "tenant",
  "memberships",
]);

/**
 * Principal refs the snapshot principal does not carry (`claims`, `teamIds`, …)
 * are bound to the subject's values.
 */
function isClaimRef(ref: string): boolean {
  const [root, head] = ref.split(".", 2);
  return root === "principal" && !CARRIED.has(String(head));
}

function bindClaims(grant: SnapshotGrant, subject: Subject): SnapshotGrant {
  if (grant.where === undefined && grant.check === undefined) {
    return grant;
  }
  return freezeDeep(
    compact<SnapshotGrant>({
      ...grant,
      where:
        grant.where === undefined
          ? undefined
          : bindConditionRefs(grant.where, subject, isClaimRef),
      check:
        grant.check === undefined
          ? undefined
          : bindConditionRefs(grant.check, subject, isClaimRef),
    }),
  );
}

function notEntitledOf(
  items: readonly { readonly grant: Grant }[],
): readonly SnapshotNotEntitled[] | undefined {
  const seen = new Map<string, SnapshotNotEntitled>();
  for (const { grant } of items) {
    const key = `${grant.permission.key}\u0000${grant.role ?? ""}`;
    if (!seen.has(key)) {
      seen.set(key, {
        permission: grant.permission.key,
        role: grant.role,
        to: grant.to,
      });
    }
  }
  return seen.size === 0 ? undefined : [...seen.values()];
}

/** Tenants holding more than `limit` grants through their memberships. */
function overLimit(
  items: readonly { readonly membership?: Membership }[],
  scopes: ReturnType<typeof scopeList>,
  limit: number | undefined,
): ReadonlySet<string> {
  if (limit === undefined) {
    return new Set();
  }
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError(
      `PermDock: maxGrantsPerTenant must be a non-negative integer, got ${String(limit)}`,
    );
  }
  const counts = new Map<string, number>();
  for (const { membership } of items) {
    const tenant =
      membership === undefined ? undefined : tenantOf(membership, scopes);
    if (tenant !== undefined) {
      counts.set(tenant, (counts.get(tenant) ?? 0) + 1);
    }
  }
  return new Set(
    [...counts].filter(([, count]) => count > limit).map(([tenant]) => tenant),
  );
}

/** The roles and plans of a vocabulary as plain JSON; absent when it has none. */
export function snapshotVocabulary(
  vocabulary: PolicyVocabulary | undefined,
): ExpandedSnapshot["vocabulary"] {
  if (vocabulary === undefined) {
    return undefined;
  }
  const roles = listRoles(vocabulary.roles);
  const plans = listPlans(vocabulary.plans);
  return compact<NonNullable<ExpandedSnapshot["vocabulary"]>>({
    roles:
      roles.length === 0
        ? undefined
        : Object.fromEntries(roles.map((leaf) => [leaf.key, plainRole(leaf)])),
    plans:
      plans.length === 0
        ? undefined
        : Object.fromEntries(plans.map((leaf) => [leaf.key, plainPlan(leaf)])),
  });
}

export function buildSnapshot(input: {
  readonly subject: Subject;
  readonly roles: readonly string[];
  readonly audiences?: readonly string[];
  readonly grants: readonly SnapshotGrantItem[];
  /** Where the subject holds a key a grant `requires`. */
  readonly holding?: (key: string) => KeyHolding;
  readonly include?: readonly string[];
  readonly tenants?: SnapshotTenants | undefined;
  readonly maxGrantsPerTenant?: number | undefined;
  readonly simulated?: boolean;
  readonly now?: number;
  readonly vocabulary?: PolicyVocabulary;
  readonly scopes?: ExpandedSnapshot["scopes"];
  readonly assignable?: (tenant: string) => SnapshotAssignable;
  readonly notEntitled?: readonly { readonly grant: Grant }[];
  readonly delegated?: ReadonlySet<string>;
  /** The id field of a resource, when its `id` option names one. */
  readonly idOf?: (resource: string) => string | undefined;
}): ExpandedSnapshot {
  const now = input.now ?? nowSeconds();
  const principal = input.subject.principal;
  const allTenants = tenantsOf(principal, scopeList(input.scopes));
  const wanted = input.tenants;
  const tenants =
    wanted === "all"
      ? allTenants
      : wanted === undefined
        ? principal?.tenant === undefined
          ? []
          : [principal.tenant]
        : allTenants.filter((tenant) => wanted.includes(tenant));
  const include = input.include;
  const included = (permission: Grant["permission"]): boolean =>
    include === undefined ||
    include.length === 0 ||
    include.some(
      (prefix) =>
        permission.key === prefix ||
        permission.key.startsWith(`${prefix}.`) ||
        permission.resource === prefix,
    );
  const shown = new Set(tenants);
  const scopes = scopeList(input.scopes);
  // A membership in a tenant the snapshot does not list carries no grants: the client cannot switch to it.
  const narrowed =
    (wanted !== undefined && wanted !== "all") ||
    (wanted === undefined && principal?.tenant !== undefined);
  const listed = (membership: Membership | undefined): boolean => {
    if (!narrowed || membership === undefined) {
      return true;
    }
    const tenant = tenantOf(membership, scopes);
    return tenant === undefined || shown.has(tenant);
  };
  const kept = input.grants
    .filter((item) => listed(item.membership))
    .filter((item) => included(item.grant.permission));
  const truncated = overLimit(kept, scopes, input.maxGrantsPerTenant);
  const grants = kept
    .filter((item) => {
      const tenant =
        item.membership === undefined
          ? undefined
          : tenantOf(item.membership, scopes);
      return tenant === undefined || !truncated.has(tenant);
    })
    .map((item) =>
      bindClaims(
        snapshotGrant(item.grant, item.membership, item.requires),
        input.subject,
      ),
    );
  const requires = requiresTable(
    grants,
    principal?.memberships ?? [],
    input.holding,
  );
  const ids: Record<string, string> = {};
  for (const item of input.grants) {
    const name = item.grant.permission.resource;
    const field = input.idOf?.(name);
    if (
      field !== undefined &&
      field !== "id" &&
      included(item.grant.permission)
    ) {
      ids[name] = field;
    }
  }
  const assignableFor = input.assignable;
  const assignable =
    assignableFor === undefined
      ? []
      : tenants.map((tenant) => {
          const entry = assignableFor(tenant);
          const permissions = entry.permissions
            .filter(included)
            .map(plainPermission);
          if (entry.levels === undefined) {
            return { ...entry, permissions };
          }
          const keys = new Set(permissions.map((leaf) => leaf.key));
          const levels = Object.fromEntries(
            Object.entries(entry.levels).filter(([key]) => keys.has(key)),
          );
          return compact<SnapshotAssignable>({
            ...entry,
            permissions,
            levels: Object.keys(levels).length === 0 ? undefined : levels,
          });
        });
  const snapshot = freezeDeep(
    compact<ExpandedSnapshot>({
      v: 2 as const,
      issuedAt: rfc3339(now),
      subject: compact<ExpandedSnapshot["subject"]>({
        principal:
          principal === null
            ? null
            : compact<NonNullable<ExpandedSnapshot["subject"]["principal"]>>({
                id: principal.id,
                roles: principal.roles ?? [],
                plans: principal.plans,
                tenant: principal.tenant,
                memberships: principal.memberships,
              }),
        delegation: toWireDelegation(
          snapshotDelegation(input.subject, input.delegated !== undefined),
        ),
        context: input.subject.context,
      }),
      roles: input.roles,
      audiences: input.audiences,
      grants,
      tenants,
      include,
      truncated: truncated.size === 0 ? undefined : [...truncated].toSorted(),
      requires,
      simulated: input.simulated === true ? true : undefined,
      expiresAt:
        input.subject.expiresAt === undefined
          ? undefined
          : rfc3339(input.subject.expiresAt),
      authzVersion: principal?.authzVersion,
      sessionId: input.subject.session,
      scopes: input.scopes,
      ids: Object.keys(ids).length === 0 ? undefined : ids,
      assignable: assignable.length > 0 ? assignable : undefined,
      delegated:
        input.delegated === undefined
          ? undefined
          : [...input.delegated].toSorted(),
      notEntitled: notEntitledOf(
        (input.notEntitled ?? []).filter((item) =>
          included(item.grant.permission),
        ),
      ),
      vocabulary: snapshotVocabulary(input.vocabulary),
    }),
  );
  return snapshot;
}

/**
 * The token delegation as the client sees it. An actor with no token delegation
 * gets an empty `scopes` list so the client ceiling agrees with
 * `no-delegation`, unless a policy delegation applies (`delegated`), which then
 * is the ceiling.
 */
function snapshotDelegation(
  subject: Subject,
  delegated: boolean,
): Delegation | undefined {
  const delegation = subject.delegation;
  if (subject.actor === undefined || delegated) {
    return delegation;
  }
  if (
    delegation?.scopes === undefined &&
    delegation?.authorizationDetails === undefined &&
    delegation?.access === undefined
  ) {
    return { ...delegation, scopes: [] };
  }
  return delegation;
}

function rejectUnsafe(value: unknown, path: string): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      rejectUnsafe(item, `${path}[${index}]`);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (isForbiddenKey(key)) {
      throw new Error(`PermDock: unsafe snapshot key '${key}' at ${path}`);
    }
    // SAFETY: arrays and primitives returned above; key is an own key of this object.
    rejectUnsafe((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

function isKeyList(value: unknown): boolean {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function validTypeLevel(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  // SAFETY: a non-array object checked above; each field is checked next.
  const record = value as Record<string, unknown>;
  const valid =
    record["bits"] === true
      ? (item: unknown): boolean =>
          typeof item === "string" && /^[\w-]*$/u.test(item)
      : isKeyList;
  return (
    (record["bits"] === undefined || record["bits"] === true) &&
    valid(record["granted"]) &&
    (record["approval"] === undefined || valid(record["approval"])) &&
    (record["endpoint"] === undefined || valid(record["endpoint"]))
  );
}

function isDigest(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("sha-256:");
}

function validStatic(value: unknown, memberships: number): boolean {
  if (value === undefined) {
    return true;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  // SAFETY: a non-array object checked above; each field is checked next.
  const record = value as Record<string, unknown>;
  const held = record["held"];
  const digests = record["digests"];
  if (
    !Array.isArray(held) ||
    digests === null ||
    typeof digests !== "object" ||
    Array.isArray(digests)
  ) {
    return false;
  }
  return (
    held.every(
      (item: unknown) =>
        Array.isArray(item) &&
        item.length === 2 &&
        typeof item[0] === "string" &&
        (item[1] === null ||
          (Number.isInteger(item[1]) && item[1] >= 0 && item[1] < memberships)),
    ) &&
    Object.values(digests).every(isDigest) &&
    (record["shared"] === undefined || isDigest(record["shared"]))
  );
}

function validCustom(value: unknown, memberships: number): boolean {
  if (value === undefined) {
    return true;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const held: unknown = Reflect.get(value, "held");
  return (
    Array.isArray(held) &&
    held.every(
      (item: unknown) =>
        Array.isArray(item) &&
        item.length === 3 &&
        typeof item[0] === "string" &&
        (item[1] === null ||
          (Number.isInteger(item[1]) &&
            item[1] >= 0 &&
            item[1] < memberships)) &&
        isDigest(item[2]),
    )
  );
}

/**
 * Validates a snapshot document, from JSON text or a value, and returns it
 * frozen. Throws on an unsupported `v`, a malformed time, `typeLevel` or grant
 * index, and on a key that would reach a prototype.
 */
export function parseSnapshot(json: unknown): Snapshot {
  const input: unknown = typeof json === "string" ? JSON.parse(json) : json;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("PermDock: snapshot must be an object");
  }
  // Freezing the caller's object in place would break a framework proxy
  // around it (Vue `reactive`, Nuxt `useState`); freeze a plain copy instead.
  // SAFETY: a JSON round trip of the non-array object checked above is again an object.
  const value =
    typeof json === "string" || Object.isFrozen(input)
      ? input
      : (JSON.parse(JSON.stringify(input)) as object);
  rejectUnsafe(value, "$");
  // SAFETY: value is a non-array object; its fields stay unknown until checked.
  const record = value as Record<string, unknown>;
  const version = record["v"];
  if (version !== 2) {
    throw new Error(
      `PermDock: unsupported snapshot version '${String(version)}'`,
    );
  }
  if (
    !isRfc3339(record["issuedAt"]) ||
    (record["expiresAt"] !== undefined && !isRfc3339(record["expiresAt"]))
  ) {
    throw new Error("PermDock: snapshot times must be RFC 3339");
  }
  const authzVersion = record["authzVersion"];
  if (
    (authzVersion !== undefined &&
      (typeof authzVersion !== "number" ||
        !Number.isSafeInteger(authzVersion) ||
        authzVersion < 0)) ||
    (record["sessionId"] !== undefined &&
      typeof record["sessionId"] !== "string")
  ) {
    throw new Error(
      "PermDock: snapshot authzVersion must be a non-negative integer and sessionId a string",
    );
  }
  if (record["bundle"] !== undefined && !isDigest(record["bundle"])) {
    throw new Error("PermDock: snapshot bundle must be a sha-256 digest");
  }
  if (!validTypeLevel(record["typeLevel"])) {
    throw new Error(
      "PermDock: snapshot typeLevel must list permission keys under granted, approval and endpoint",
    );
  }
  const subject = record["subject"];
  const principal: unknown =
    subject !== null && typeof subject === "object"
      ? Reflect.get(subject, "principal")
      : undefined;
  const memberships: unknown =
    principal !== null && typeof principal === "object"
      ? Reflect.get(principal, "memberships")
      : undefined;
  if (
    !validStatic(
      record["static"],
      Array.isArray(memberships) ? memberships.length : 0,
    )
  ) {
    throw new Error(
      "PermDock: snapshot static must list [role, membership index] pairs and sha-256 digests",
    );
  }
  if (
    !validCustom(
      record["custom"],
      Array.isArray(memberships) ? memberships.length : 0,
    )
  ) {
    throw new Error(
      "PermDock: snapshot custom must list [role, membership index, digest] triples with sha-256 digests",
    );
  }
  // Reading the grants and assignable checks every index now, so a malformed document never parses.
  expandGrants(record);
  // SAFETY: the grants above parsed; checkHeader reads the memberships, requires and assignable and throws on a bad index.
  checkHeader(record as Snapshot);
  // SAFETY: the version, times, typeLevel, unsafe keys and grant indexes are checked; the other fields are not validated here.
  return freezeDeep(value) as Snapshot;
}
