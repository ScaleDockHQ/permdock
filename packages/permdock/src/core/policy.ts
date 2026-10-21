import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { Condition } from "../conditions/index.ts";
import type { PermissionTree, ResourceNode } from "./permission-types.ts";
import type {
  PolicyOptions,
  Grant,
  MembershipFixture,
  Policy,
  PolicyIndex,
  PolicyLevels,
  PolicyVocabulary,
  RoleBinding,
  SeparationConflict,
  VocabularyFromInput,
} from "./policy-types.ts";
import type { PolicyScopesInput } from "./scopes.ts";
import type { Principal } from "./subject.ts";
import type { RoleTree } from "./vocabulary.ts";

import { normalizeWhere } from "../conditions/index.ts";
import {
  assertApprovalRelations,
  assertApprovalVersions,
} from "./approval-normalize.ts";
import { canonicalJson } from "./canonical-json.ts";
import { compact } from "./compact.ts";
import { byCodePoint } from "./compare.ts";
import { freezeDeep } from "./freeze.ts";
import {
  completeGrant,
  flattenGrants,
  flattenPermissions,
  withGrantSchema,
} from "./grant-builders.ts";
import { getRegistry, isRegistryTree } from "./permission-registry.ts";
import {
  assertInheritGrants,
  assertParentGraph,
  assertRelationGrants,
  assertRequires,
  assertScopeKeys,
  rescopeBinding,
  rescopeGrant,
} from "./policy-assertions.ts";
import {
  normalizeDelegation,
  normalizeOAuthScopes,
} from "./policy-delegation.ts";
import { POLICY_X, canonicalPolicy } from "./policy-fingerprint.ts";
import { defineScopes } from "./scopes.ts";
import { sha256Digest } from "./sha256.ts";
import { listRoles } from "./vocabulary.ts";

export type {
  AnyOfApprover,
  Approver,
  ApproverInput,
  PermissionApprover,
  UserApprover,
} from "./approvers.ts";
export { allOf, anyOf, holder, user } from "./approvers.ts";

export function indexPolicy(
  roles: readonly RoleBinding[],
  grants: readonly Grant[],
  vocabulary: PolicyVocabulary,
): PolicyIndex {
  const declaredRoles = new Set(roles.map((item) => item.name));
  for (const leaf of listRoles(vocabulary.roles)) {
    declaredRoles.add(leaf.key);
  }
  const supports = roles.flatMap((binding) =>
    binding.support === undefined ? [] : [binding.support],
  );
  const listed =
    grants.length > 0 ? grants : roles.flatMap((binding) => binding.grants);
  const byKey = new Map<string, Grant[]>();
  for (const grant of listed) {
    const bucket = byKey.get(grant.permission.key);
    if (bucket === undefined) {
      byKey.set(grant.permission.key, [grant]);
    } else {
      bucket.push(grant);
    }
  }
  for (const bucket of byKey.values()) {
    Object.freeze(bucket);
  }
  return freezeDeep({ declaredRoles, supports, grantsByKey: byKey });
}

export { requiresApproval } from "./approval-required.ts";

function normalizeLevels(
  resources: ReadonlyMap<string, ResourceNode>,
): PolicyLevels | undefined {
  const out: Record<string, Record<string, Condition>> = {};
  for (const node of resources.values()) {
    const entries = Object.entries({ ...node.levels });
    if (entries.length === 0) {
      continue;
    }
    const levels: Record<string, Condition> = {};
    for (const [name, input] of entries) {
      try {
        levels[name] =
          Object.keys(input).length === 0
            ? { op: "and", conditions: [] }
            : normalizeWhere(input);
      } catch (error) {
        throw new Error(
          `PermDock: level '${name}' on '${node.name}' is not a valid condition`,
          { cause: error },
        );
      }
    }
    out[node.name] = levels;
  }
  return Object.keys(out).length === 0 ? undefined : freezeDeep(out);
}

/** Declared levels of `resource` with their conditions, in declaration order. */
export function policyLevels(
  policy: Pick<Policy, "levels">,
  resource: string,
): readonly (readonly [string, Condition])[] {
  const levels = policy.levels;
  return levels !== undefined && Object.hasOwn(levels, resource)
    ? Object.entries({ ...levels[resource] })
    : [];
}

/** The condition of `level` on `resource`, if the policy declares it. */
export function levelCondition(
  policy: Pick<Policy, "levels">,
  resource: string,
  level: string,
): Condition | undefined {
  return policyLevels(policy, resource).find(([name]) => name === level)?.[1];
}

/** Declared level names of `resource`, in declaration order. */
export function levelNames(
  policy: Pick<Policy, "levels">,
  resource: string,
): readonly string[] {
  return policyLevels(policy, resource).map(([name]) => name);
}

/**
 * The levels a holder of `held` on `resource` may hand out, in declaration
 * order: with `orderedLevels`, each held level and every level declared before
 * it; otherwise `held` itself.
 */
export function coveredLevels(
  policy: Pick<Policy, "levels" | "orderedLevels">,
  resource: string,
  held: readonly string[],
): readonly string[] {
  const names = levelNames(policy, resource);
  if (policy.orderedLevels?.includes(resource) !== true) {
    return names.filter((name) => held.includes(name));
  }
  const widest = Math.max(...held.map((name) => names.indexOf(name)));
  return names.slice(0, widest + 1);
}

function isVocabularyInput(value: unknown): value is PolicyVocabulary {
  return (
    value !== null &&
    typeof value === "object" &&
    "permissions" in value &&
    // SAFETY: permissions is checked to be a key; isRegistryTree then tests its registry brand.
    isRegistryTree((value as PolicyVocabulary).permissions)
  );
}

function mergeBindings(items: readonly RoleBinding[]): {
  readonly roles: readonly RoleBinding[];
  readonly rolesByName: Map<string, RoleBinding>;
} {
  const merged = new Map<string, RoleBinding>();
  for (const item of items) {
    const existing = merged.get(item.name);
    if (existing === undefined) {
      merged.set(item.name, item);
      continue;
    }
    merged.set(
      item.name,
      freezeDeep(
        compact<RoleBinding>({
          name: item.name,
          grants: [...existing.grants, ...item.grants],
          on: existing.on,
          assignable: existing.assignable,
          exclusiveWith: existing.exclusiveWith ?? item.exclusiveWith,
          min: existing.min ?? item.min,
          max: existing.max ?? item.max,
          transferOnly: existing.transferOnly ?? item.transferOnly,
          assigns: existing.assigns ?? item.assigns,
          for: existing.for ?? item.for,
          meta: existing.meta ?? item.meta,
          activation: existing.activation ?? item.activation,
          support: existing.support ?? item.support,
        }),
      ),
    );
  }
  return { roles: [...merged.values()], rolesByName: merged };
}

export function definePolicy<
  TUser,
  TPrincipal extends Principal,
  const Input extends PermissionTree | PolicyVocabulary,
  const S extends PolicyScopesInput = PolicyScopesInput,
>(
  permissions: Input,
  options: PolicyOptions<TUser, TPrincipal, S>,
): Policy<TUser, TPrincipal, VocabularyFromInput<Input>, S> {
  // SAFETY: Input is a vocabulary or a tree; each branch builds the VocabularyFromInput shape.
  const vocabulary = (
    isVocabularyInput(permissions)
      ? permissions
      : { permissions: permissions as PermissionTree }
  ) as VocabularyFromInput<Input>;
  const tree = vocabulary.permissions;
  const mapper = options.subject;
  if (typeof mapper !== "function") {
    throw new TypeError("PermDock: definePolicy requires a subject function");
  }
  const resources = getRegistry(tree);
  assertParentGraph(resources);
  const scopes = defineScopes(options.scopes);
  const grantSchema = options.x?.grant;
  const { roles, rolesByName } = mergeBindings(
    (options.roles ?? []).map((binding) => {
      const rescoped = rescopeBinding(binding, scopes);
      const grants = rescoped.grants.map((grant) =>
        withGrantSchema(grant, grantSchema),
      );
      return grants.every((grant, index) => grant === rescoped.grants[index])
        ? rescoped
        : freezeDeep({ ...rescoped, grants });
    }),
  );
  const declared = new Set(roles.map((item) => item.name));
  for (const leaf of listRoles(vocabulary.roles)) {
    declared.add(leaf.key);
  }
  for (const binding of roles) {
    for (const name of binding.assigns ?? []) {
      if (!declared.has(name)) {
        throw new Error(
          `PermDock: role '${binding.name}' names undeclared role '${name}'`,
        );
      }
    }
  }
  const fromBindings = roles.flatMap((item) => item.grants);
  const fromGrants = flattenGrants(options.grants ?? [])
    .map(completeGrant)
    .map((grant) => withGrantSchema(rescopeGrant(grant, scopes), grantSchema));
  const grants = [...fromBindings, ...fromGrants];
  assertScopeKeys(grants, scopes, resources);
  assertApprovalVersions(grants, resources);
  assertApprovalRelations(grants, resources);
  assertRelationGrants(grants, resources);
  assertRequires(grants, tree);
  assertInheritGrants(grants, resources, tree);
  const delegations = (options.delegations ?? []).map((item, index) =>
    normalizeDelegation(item, index, tree),
  );
  const levels = normalizeLevels(resources);
  const orderedLevels = [...resources.values()]
    .filter((node) => node.orderedLevels === true)
    .map((node) => node.name)
    .toSorted(byCodePoint);
  const oauthScopes = normalizeOAuthScopes(options.oauthScopes, tree);
  const fingerprint = sha256Digest(
    oauthScopes.length === 0
      ? canonicalPolicy(grants, delegations, levels, orderedLevels)
      : `${canonicalPolicy(grants, delegations, levels, orderedLevels)}\noauthScopes:${canonicalJson(oauthScopes)}`,
  );
  const hostable = [
    ...new Set(
      (options.hostable ?? []).flatMap((item) =>
        flattenPermissions(item).map((leaf) => leaf.key),
      ),
    ),
  ].toSorted();
  const fresh = [
    ...new Set(
      (options.fresh ?? []).flatMap((item) =>
        flattenPermissions(item).map((leaf) => leaf.key),
      ),
    ),
  ].toSorted();
  // SAFETY: TUser and TPrincipal only type options.subject, the mapper stored here as is; S is a type-only phantom.
  return freezeDeep({
    permissions: tree,
    roles,
    rolesByName,
    grants,
    vocabulary,
    scopes,
    principal: mapper,
    subject: mapper,
    context: options.context,
    validate: options.validate ?? "boundary",
    onDenied: options.onDenied,
    fingerprint,
    resources,
    ...(options.x === undefined ? {} : { [POLICY_X]: options.x }),
    providers: options.providers,
    hostable,
    fresh,
    delegations: delegations.length === 0 ? undefined : delegations,
    levels,
    orderedLevels: orderedLevels.length === 0 ? undefined : orderedLevels,
    oauthScopes: oauthScopes.length === 0 ? undefined : oauthScopes,
    index: indexPolicy(roles, grants, vocabulary),
  }) as Policy<TUser, TPrincipal, VocabularyFromInput<Input>, S>;
}

function exclusivePairs(
  policy: Policy,
): ReadonlyMap<string, readonly string[]> {
  const pairs = new Map<string, readonly string[]>();
  for (const binding of policy.roles) {
    if (binding.exclusiveWith !== undefined) {
      pairs.set(binding.name, binding.exclusiveWith);
    }
  }
  return pairs;
}

export function grantList(policy: Policy): readonly Grant[] {
  if (policy.grants !== undefined && policy.grants.length > 0) {
    return policy.grants;
  }
  return policy.roles.flatMap((binding) => binding.grants);
}

export function declaredRoleNames(policy: Policy): ReadonlySet<string> {
  return policy.index.declaredRoles;
}

/**
 * The role names a policy declares: the keys of its `defineRoles` vocabulary,
 * else `string`.
 */
export type RoleNameOf<P> = P extends { readonly vocabulary: infer V }
  ? V extends { readonly roles: infer R extends RoleTree }
    ? R[keyof R]["key"]
    : string
  : string;

/**
 * Whether `value` names a role the policy declares, for a role read as a string
 * from a database or a token. A name it rejects is an unknown role, which
 * grants nothing (`unknown-role`). A tenant's custom roles are not declared;
 * `CustomRoleSource` resolves them.
 */
export function isRoleName<P extends Policy<never>>(
  policy: P,
  value: unknown,
): value is RoleNameOf<P> {
  return typeof value === "string" && policy.index.declaredRoles.has(value);
}

export function separationConflicts(
  policy: Policy,
  memberships: readonly MembershipFixture[],
): readonly SeparationConflict[] {
  const exclusive = exclusivePairs(policy);
  const seen = new Set<string>();
  const conflicts: SeparationConflict[] = [];
  for (const membership of memberships) {
    const held = new Set(membership.roles);
    for (const name of held) {
      for (const other of exclusive.get(name) ?? []) {
        if (!held.has(other)) {
          continue;
        }
        // SAFETY: sorting a two-element array keeps both elements.
        const pair = [name, other].toSorted() as [string, string];
        const key = `${membership.principal ?? ""}:${membership.tenant ?? ""}:${pair.join("+")}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        conflicts.push(
          compact<SeparationConflict>({
            principal: membership.principal ?? "",
            tenant: membership.tenant,
            roles: pair,
          }),
        );
      }
    }
  }
  return conflicts;
}

export function inferOutput<T>(
  schema: StandardSchemaV1<unknown, T> | undefined,
): T | undefined {
  // SAFETY: a typing helper only; callers read the type T and never use the returned value as data.
  return schema as unknown as T | undefined;
}
